// End-to-end check of change orders through the real UI: the reviewer lists
// existing customers and change orders, staff open the link, track time on both
// sides of a card, copy for the Optimization sheet and send a file, and the
// reviewer fixes a typed number and copies the result.
//
//   node tests/e2e/change-orders.mjs http://localhost:8175 [screenshot-dir]

import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = (process.argv[2] || "http://localhost:8175").replace(/\/$/, "");
const SHOTS = process.argv[3];
const results = [];
let failed = 0;
function check(name, ok, detail = "") {
  results.push(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}

const browser = await chromium.launch();
const errors = [];
const dialogs = [];

async function context(name, viewport = { width: 1200, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true, timezoneId: "America/Vancouver" });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  // The shared footer is served by the reverse proxy, so it is missing on a local run.
  p.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("/shared-footer/")) errors.push(`${name}: ${r.status()} ${r.url()}`); });
  p.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
  return { ctx, p };
}
const clipboard = (p) => p.evaluate(() => navigator.clipboard.readText());
const card = (p, name) => p.locator(".clients .client", { has: p.locator(".client-name", { hasText: name }) });
const side = (p, name, text) => card(p, name).locator(".slider button", { hasText: text });
const saved = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("billable.v1")));

/* ---------- the reviewer lists customers and change orders ---------- */

const rev = await context("reviewer");
await rev.p.goto(`${BASE}/review.html`, { waitUntil: "load" });
await rev.p.click("#lists-wrap > summary");
await rev.p.fill("#lists-by", "Chris");
await rev.p.fill("#lists-clients", "Incoming Co\n");
await rev.p.fill("#lists-customers", "Live Co\nOlder Co\n");
for (const [customer, number] of [["Live Co", "co-0002"], ["Live Co", "CO-0001"], ["Older Co", "CO-0001"], ["Incoming Co", "CO-0001"], ["Older Co", "CO-0002"]]) {
  await rev.p.selectOption("#order-customer", customer);
  await rev.p.fill("#order-number", number);
  await rev.p.click("#order-add button");
}
const orderRows = () => rev.p.locator("#lists-orders li").allInnerTexts();
check("five change orders are listed, numbers in capitals", (await orderRows()).filter((t) => t.includes("Live Co · CO-0002")).length === 1 && (await orderRows()).length === 5);
await rev.p.getByRole("button", { name: "Retire CO-0002 for Older Co" }).click();
check("a retired change order is marked, not gone", (await orderRows()).some((t) => t.includes("Older Co · CO-0002 (retired)")));
if (SHOTS) await rev.p.locator("#lists-wrap").screenshot({ path: `${SHOTS}/co-lists-editor.png` });
await rev.p.click("#lists-link");
await rev.p.waitForTimeout(200);
const link = await clipboard(rev.p);
check("the link keeps the names out of the address", link.includes("#lists=") && !link.includes("Live"));

/* ---------- staff open the link and add cards ---------- */

const staff = await context("staff");
await staff.p.goto(`${BASE}/`, { waitUntil: "load" });
await staff.p.goto(link);
await staff.p.waitForFunction(() => localStorage.getItem("billable.lists"));
await staff.p.reload({ waitUntil: "load" });
await staff.p.click("#settings-wrap > summary").catch(() => {});
await staff.p.evaluate(() => {
  const st = JSON.parse(localStorage.getItem("billable.v1") || "{}");
  localStorage.setItem("billable.v1", JSON.stringify({ ...st, clients: [], sessions: [], settings: { employee: "Sam Patel", sheetLayout: "all", lunchStop: false, lunchRestart: false, updated: 1 } }));
});
await staff.p.reload({ waitUntil: "load" });
const options = (id) => staff.p.locator(`#${id} option`).evaluateAll((o) => o.map((x) => x.value));
check("Implementation offers only implementation clients", (await options("official-clients")).join() === "Incoming Co");
check("Optimization offers existing customers and incoming clients", (await options("official-customers")).join() === "Incoming Co,Live Co,Older Co");
check("the add box starts on Implementation", (await staff.p.getAttribute("#client-name", "list")) === "official-clients");

const asked = dialogs.length;
await staff.p.fill("#client-name", "incoming co");
await staff.p.click("#add-client button");
check("Implementation: the official spelling is used, and no prompt", await card(staff.p, "Incoming Co").count() === 1 && dialogs.length === asked);
check("a new implementation card is on Phases", (await side(staff.p, "Incoming Co", "Phases").getAttribute("aria-pressed")) === "true");
const phaseOptions = await card(staff.p, "Incoming Co").locator(".client-tools .more-toggle").click().then(() => card(staff.p, "Incoming Co").locator(".tag-category option").allInnerTexts());
check("Optimization/Change Order has left the phase dropdown", !phaseOptions.some((t) => t.includes("Optimization")));

await staff.p.getByRole("button", { name: "Optimization", exact: true }).click();
check("the add box switches list", (await staff.p.getAttribute("#client-name", "list")) === "official-customers" && (await staff.p.getAttribute("#client-name", "placeholder")) === "Customer name");
await staff.p.fill("#client-name", "Live Co");
await staff.p.click("#add-client button");
const live = card(staff.p, "Live Co");
check("an Optimization card starts on COs, blue, and open", (await live.getAttribute("class")).includes("co") && await live.locator("select.tag-order").count() === 1);
const liveOrders = await live.locator("select.tag-order option").allInnerTexts();
check("only that customer's change orders are offered", liveOrders.join() === "Pick a change order,CO-0001,CO-0002,Other (type it)", liveOrders.join());
await staff.p.fill("#client-name", "Older Co");
await staff.p.click("#add-client button");
const olderOrders = await card(staff.p, "Older Co").locator("select.tag-order option").allInnerTexts();
check("a retired change order is not offered", olderOrders.join() === "Pick a change order,CO-0001,Other (type it)", olderOrders.join());
await staff.p.fill("#client-name", "Stranger Co");
await staff.p.click("#add-client button");
check("a name on neither list asks first", dialogs.some((d) => d.includes('"Stranger Co" isn\'t on the official customer list')));

// Adding a card from the other side switches the one it already has.
await staff.p.fill("#client-name", "Incoming Co");
await staff.p.click("#add-client button");
check("one card per client: adding from the other side switches it", await card(staff.p, "Incoming Co").count() === 1 && (await side(staff.p, "Incoming Co", "COs").getAttribute("aria-pressed")) === "true");
await side(staff.p, "Incoming Co", "Phases").click();
check("and the card's slider switches it back", !(await card(staff.p, "Incoming Co").getAttribute("class")).includes(" co"));

/* ---------- tracking ---------- */

const startColour = (name) => card(staff.p, name).locator(".toggle").evaluate((n) => getComputedStyle(n).backgroundColor);
check("the Start button is a different colour on COs", (await startColour("Live Co")) !== (await startColour("Incoming Co")), `${await startColour("Live Co")} vs ${await startColour("Incoming Co")}`);
check("no change order picked says so on the card", (await live.locator(".client-tag").innerText()).includes("pick a change order"));

// Times are written directly, so the day has real rows without waiting.
await live.locator("select.tag-order").selectOption("CO-0001");
await live.locator(".tag-note").fill("Manual AR Replication");
await live.locator(".tag-note").press("Enter");
check("the tag shows the number and the note", (await live.locator(".client-tag").innerText()) === "CO-0001 · Manual AR Replication", await live.locator(".client-tag").innerText());
await live.locator(".toggle").click();
check("a running card stays blue", (await live.getAttribute("class")).includes("running") && (await live.getAttribute("class")).includes("co"));
let st = await saved(staff.p);
check("the timer carries the change order", st.sessions.at(-1).category === "change" && st.sessions.at(-1).co === "CO-0001" && st.sessions.at(-1).note === "Manual AR Replication");
if (SHOTS) await staff.p.screenshot({ path: `${SHOTS}/co-cards-1200.png`, fullPage: true });
await live.locator(".toggle").click();

// Other: a number that isn't on the list yet.
await live.locator("select.tag-order").selectOption("other");
check("Other opens the number box, focused", await staff.p.evaluate(() => document.activeElement?.dataset.order !== undefined));
await live.locator("input.tag-order").fill("co-0099");
await live.locator("input.tag-order").press("Enter");
st = await saved(staff.p);
check("a typed number is saved on the card, in capitals", st.clients.find((c) => c.name === "Live Co").co === "CO-0099");
check("the dropdown then reads Other, with the number kept", (await live.locator("select.tag-order").inputValue()) === "other" && (await live.locator("input.tag-order").inputValue()) === "CO-0099");

// Switching away and back returns to what the card last tracked.
await side(staff.p, "Live Co", "Phases").click();
await side(staff.p, "Live Co", "COs").click();
st = await saved(staff.p);
check("switching back returns to the last change order tracked", st.clients.find((c) => c.name === "Live Co").co === "CO-0001", st.clients.find((c) => c.name === "Live Co").co);

// A morning's worth of finished entries on both sides of a card.
await staff.p.evaluate(() => {
  const st = JSON.parse(localStorage.getItem("billable.v1"));
  const id = (name) => st.clients.find((c) => c.name === name).id;
  const today = new Date();
  const at = (h, m = 0) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m).getTime();
  st.sessions = [
    { id: "e1", clientId: id("Incoming Co"), start: at(0, 0), end: at(1, 0), category: "p2", note: "Import", updated: 2 },
    { id: "e2", clientId: id("Incoming Co"), start: at(1, 0), end: at(2, 0), category: "change", co: "CO-0001", note: "Extra report", updated: 2 },
    { id: "e3", clientId: id("Live Co"), start: at(2, 0), end: at(3, 30), category: "change", co: "CO-0001", note: "Manual AR Replication", updated: 2 },
    { id: "e4", clientId: id("Live Co"), start: at(3, 30), end: at(4, 0), category: "change", co: "CO-0099", note: "Fix Retainage Error", updated: 2 },
  ];
  localStorage.setItem("billable.v1", JSON.stringify(st));
});
await staff.p.reload({ waitUntil: "load" });

/* ---------- copying ---------- */

await staff.p.click("#summary-wrap > summary");
await staff.p.click("#day-prev");
check("Copy all Optimization is hidden on a day without change orders", !(await staff.p.isVisible("#co-copy")));
await staff.p.click("#day-next");
check("Copy all Optimization counts the rows", (await staff.p.innerText("#co-copy")).includes("3 rows"), await staff.p.innerText("#co-copy"));
await staff.p.click("#co-copy");
await staff.p.waitForTimeout(150);
const pasted = (await clipboard(staff.p)).split("\n").map((l) => l.split("\t"));
check("the Optimization copy has the sheet's six columns", pasted.every((r) => r.length === 6) && pasted.length === 3);
check("Customer and Costing section hold the customer and the CO", pasted[0][1] === "Sam Patel" && pasted[0][2] === "Incoming Co" && pasted[0][3] === "CO-0001" && pasted[0][4] === "Extra report" && pasted[0][5] === "1.00", pasted[0].join("|"));
check("the button shows it was copied", (await staff.p.innerText("#co-copy")).includes("copied"));
await staff.p.getByRole("button", { name: "Copy Incoming Co for Sheets" }).click();
await staff.p.waitForTimeout(150);
check("a client's own copy leaves change orders out", (await clipboard(staff.p)).split("\t").length === 5 && (await clipboard(staff.p)).includes("Import") && !(await clipboard(staff.p)).includes("CO-"), await clipboard(staff.p));
check("a customer with only change orders has no copy of its own", await staff.p.getByRole("button", { name: "Copy Live Co for Sheets" }).count() === 0);

/* ---------- fixing an entry ---------- */

await staff.p.click("#log-wrap > summary");
const entry = staff.p.locator('#log [data-id="e1"]');
await entry.locator(".slider button", { hasText: "COs" }).click();
st = await saved(staff.p);
check("an entry can be moved to a change order", st.sessions.find((s) => s.id === "e1").category === "change");
await staff.p.locator('#log [data-id="e1"] .slider button', { hasText: "Phases" }).click();
await staff.p.locator('#log [data-id="e1"] select.tag-category').selectOption("p2");
await staff.p.locator('#log [data-id="e1"] input.tag-note').fill("Import");
await staff.p.locator('#log [data-id="e1"] input.tag-note').press("Enter");

/* ---------- the hours file reaches the reviewer ---------- */

const today = await staff.p.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
await staff.p.evaluate((d) => { document.getElementById("hours-from").value = d; document.getElementById("hours-to").value = d; }, today);
await staff.p.evaluate(() => document.getElementById("hours-btn").closest("details")?.setAttribute("open", ""));
const [dl] = await Promise.all([staff.p.waitForEvent("download"), staff.p.evaluate(() => document.getElementById("hours-btn").click())]);
const hoursPath = await dl.path();
check("the hours file carries change order numbers", readFileSync(hoursPath, "utf8").includes('"co": "CO-0099"'));

await rev.p.setInputFiles("#hours-files", { name: "sam.json", mimeType: "application/json", buffer: readFileSync(hoursPath) });
await rev.p.waitForSelector("#people tr");
await rev.p.fill("#period-from", today);
await rev.p.fill("#period-to", today);
await rev.p.dispatchEvent("#period-to", "change");
let checks = await rev.p.innerText("#checks");
check("Checks flags the typed number against its customer", checks.includes('Live Co: "CO-0099" isn\'t on their change orders'), checks);
check("free-text change order notes aren't flagged", !checks.includes("Fix Retainage Error"));
const row = rev.p.locator("#grid tbody tr", { hasText: "Live Co" });
check("the customer gets a Reviewed row, without a client-tab copy", await row.count() === 1 && await row.getByRole("button", { name: "Copy", exact: true }).count() === 0);
check("the grid has an Optimization/Change Order column", (await rev.p.innerText("#grid thead")).includes("Optimization"));
if (SHOTS) await rev.p.screenshot({ path: `${SHOTS}/co-review-1200.png`, fullPage: true });

await rev.p.getByRole("combobox", { name: "Listed change order for CO-0099" }).selectOption("CO-0002");
checks = await rev.p.innerText("#checks");
check("mapping clears the check and can be undone", !checks.includes("isn't on their change orders") && checks.includes('Counting "co-0099" for live co as CO-0002'), checks);
await rev.p.click("#co-tsv");
await rev.p.waitForTimeout(150);
const handed = (await clipboard(rev.p)).split("\n").map((l) => l.split("\t"));
check("the reviewer's copy has six columns, with the mapped number", handed.every((r) => r.length === 6) && handed.some((r) => r[2] === "Live Co" && r[3] === "CO-0002" && r[4] === "Fix Retainage Error"), handed.map((r) => r.join("|")).join(" / "));

/* ---------- a phone ---------- */

const phone = await context("phone", { width: 390, height: 844 });
await phone.p.goto(`${BASE}/`, { waitUntil: "load" });
await phone.p.evaluate((st) => localStorage.setItem("billable.v1", st), JSON.stringify(await saved(staff.p)));
await phone.p.evaluate((l) => localStorage.setItem("billable.lists", l), await staff.p.evaluate(() => localStorage.getItem("billable.lists")));
await phone.p.reload({ waitUntil: "load" });
check("nothing overflows sideways on a phone", await phone.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
const tools = phone.p.locator(".client-tools").first();
check("a card's tools stay on one row on a phone", (await tools.boundingBox()).height < 45, `${(await tools.boundingBox()).height}px`);
const inside = await phone.p.locator(".client").first().evaluate((n) => {
  const box = n.getBoundingClientRect();
  const row = n.querySelector(".client-tools").firstElementChild.getBoundingClientRect();
  return row.left >= box.left + 8;
});
check("a card's tools stay inside the card on a phone", inside);
if (SHOTS) await phone.p.screenshot({ path: `${SHOTS}/co-cards-390.png`, fullPage: true });

check("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();
console.log(results.join("\n"));
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
