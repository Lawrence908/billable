// End-to-end check of the review flow against a running deployment, through
// the real UI: the reviewer publishes official lists as a link, two people open
// it and save hours files, and the reviewer loads the files, fixes a client
// name, and hands off. Also checks that the review page makes no network
// requests, and that visiting it never replaces the app's offline copy.
//
//   node tests/e2e/review.mjs http://localhost:8175

import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = (process.argv[2] || "http://localhost:8175").replace(/\/$/, "");
const results = [];
let failed = 0;
function check(name, ok, detail = "") {
  results.push(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}

const browser = await chromium.launch();
const errors = [];
const dialogs = [];

async function context(name) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true, timezoneId: "America/Vancouver" });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  p.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
  return { ctx, p };
}
const clipboard = (p) => p.evaluate(() => navigator.clipboard.readText());
const toast = (p) => p.textContent("#toast");

// A Monday-to-Friday week in the past, so nothing is running.
const day = (n) => `2026-10-${String(19 + n).padStart(2, "0")}`; // 19 Oct 2026 is a Monday
const at = (key, hhmm) => new Date(`${key}T${hhmm}:00-07:00`).getTime();

/* ---------- the reviewer publishes the lists ---------- */

const rev = await context("reviewer");
const requests = [];
let recording = false;
rev.ctx.on("request", (r) => { if (recording) requests.push(`${r.method()} ${r.url()}`); });
await rev.p.goto(`${BASE}/review.html`, { waitUntil: "networkidle" });
recording = true;
await rev.p.click("#lists-wrap > summary");
await rev.p.fill("#lists-by", "Chris");
await rev.p.fill("#lists-clients", "Coastal Interiors Ltd.\nSummit Drywall\n");
await rev.p.fill('[data-phase="p2"]', "Data conversion");
await rev.p.fill('[data-tasks="p2"]', "Data import\nGL mapping");
await rev.p.fill('[data-tasks="*"]', "Meeting");
await rev.p.click("#lists-save");
await rev.p.click("#lists-link");
await rev.p.waitForTimeout(200);
const link = await clipboard(rev.p);
check("the lists link carries the names after the #", /\/#lists=z[A-Za-z0-9_-]+$/.test(link) && !link.includes("Coastal"), link.slice(0, 60));
await rev.p.click("#lists-qr-btn");
check("the lists link fits a QR code", await rev.p.isVisible("#lists-qr svg"));

/* ---------- two people take the lists and save hours files ---------- */

async function staff(name, sessions) {
  const { ctx, p } = await context(name);
  await p.goto(`${BASE}/`);
  await p.goto(link);
  await p.waitForFunction(() => /Official lists saved/.test(document.getElementById("toast").textContent));
  // Clients are added through the UI, so the official-list rules apply.
  for (const c of [...new Set(sessions.map((s) => s[0]))]) {
    await p.fill("#client-name", c);
    await p.click("#add-client button");
  }
  // Entries are written straight to storage: driving real timers would take real time.
  await p.evaluate((list) => {
    const st = JSON.parse(localStorage.getItem("billable.v1"));
    const byName = new Map(st.clients.map((c) => [c.name.toLowerCase(), c.id]));
    st.sessions = list.map(([client, start, end, category, note], i) => ({ id: `e2e${i}`, clientId: byName.get(client.toLowerCase()), start, end, category, note, updated: 1 }));
    localStorage.setItem("billable.v1", JSON.stringify(st));
  }, sessions.map(([c, d, s, e, cat, note]) => [c, at(d, s), at(d, e), cat, note]));
  await p.reload();
  await p.click(".settings > summary");
  await p.fill("#employee", name);
  await p.press("#employee", "Tab");
  await p.fill("#hours-from", day(0));
  await p.fill("#hours-to", day(4));
  const [dl] = await Promise.all([p.waitForEvent("download"), p.click("#hours-btn")]);
  const path = await dl.path();
  return { ctx, p, path, name: dl.suggestedFilename() };
}

dialogs.length = 0;
const alex = await staff("Alex Doe", [
  ["coastal interiors ltd.", day(0), "09:00", "10:30", "p2", "Data import"],
  ["Coastal Interiors", day(1), "09:00", "10:00", "p2", "Brand new task"],
  ["Summit Drywall", day(2), "13:00", "13:20", "pm", "Meeting"],
]);
check("opening the link asks before using the lists", dialogs.some((d) => /Use the official lists from Chris: 2 clients and 3 tasks/.test(d)), dialogs[0]);
check("a client typed in other casing takes the official name",
  (await alex.p.$$eval(".client-name", (n) => n.map((x) => x.textContent))).includes("Coastal Interiors Ltd."));
check("a client not on the list asks first", dialogs.some((d) => /"Coastal Interiors" isn't on the official client list/.test(d)));
await alex.p.click('.client:has-text("Summit Drywall") button:has-text("More")');
check("phase names show in the category dropdown",
  (await alex.p.$$eval(".tag-category option", (o) => o.map((x) => x.textContent))).includes("P2 · Data conversion"));
check("official tasks are suggested first", (await alex.p.$$eval("#notes-p2 option", (o) => o.map((x) => x.value))).slice(0, 3).join("|") === "Data import|GL mapping|Meeting");
check("the settings show where the lists came from", /2 clients and 3 tasks from Chris/.test(await alex.p.textContent("#lists-note")));
const alexFile = JSON.parse(readFileSync(alex.path, "utf8"));
check("the hours file is named after the person and dates", alex.name === `billable-hours-Alex-Doe-${day(0)}-to-${day(4)}.json`, alex.name);
check("the hours file holds rounded daily lines", alexFile.lines.map((l) => `${l.date} ${l.client} ${l.hours}`).join(", ") ===
  `${day(0)} Coastal Interiors Ltd. 1.5, ${day(1)} Coastal Interiors 1, ${day(2)} Summit Drywall 0.25`);

const sam = await staff("Sam Lee", [["Summit Drywall", day(0), "10:00", "12:00", "p2", "GL mapping"]]);

/* ---------- the reviewer loads the files ---------- */

await rev.p.setInputFiles("#hours-files", [alex.path, sam.path]);
await rev.p.fill("#period-from", day(0));
await rev.p.dispatchEvent("#period-from", "change");
await rev.p.fill("#period-to", day(4));
await rev.p.dispatchEvent("#period-to", "change");
const people = await rev.p.$$eval("#people tr", (rows) => rows.map((r) => [...r.cells].slice(0, 4).map((c) => c.textContent).join(" | ")));
check("both people are listed with their hours", people.length === 2 && /Alex Doe .*\| None \| 2\.75/.test(people[0]) && /Sam Lee .*\| 2\.00/.test(people[1]), people.join(" / "));
check("the period total adds everyone up", (await rev.p.textContent("#period-total")) === "4.75");
const checks = await rev.p.$$eval("#checks li", (l) => l.map((x) => x.textContent));
check("an unofficial client is flagged", checks.some((c) => /"Coastal Interiors" isn't an official client \(1\.00 h from Alex Doe\)/.test(c)), checks.join(" / "));
check("a task outside the list is flagged", checks.some((c) => /P2 · Data conversion: "Brand new task" isn't on the task list/.test(c)));

await rev.p.selectOption("#checks select", "Coastal Interiors Ltd.");
const clients = await rev.p.$$eval("#clients tr.client-row", (rows) => rows.map((r) => `${r.cells[0].textContent}=${r.cells[2].textContent}`));
check("mapping the name folds its hours into the official client", clients.join(",") === "Coastal Interiors Ltd.=2.50,Summit Drywall=2.25", clients.join(","));
check("the mapping can be undone from Checks", (await rev.p.$$eval("#checks li", (l) => l.map((x) => x.textContent))).some((c) => /Counting "coastal interiors" as Coastal Interiors Ltd\./.test(c)));

await rev.p.click('#clients tr.client-row:has-text("Summit Drywall") button');
await rev.p.waitForTimeout(150);
check("a client's rows copy in the timesheet's five columns", (await clipboard(rev.p)) ===
  `10/19/2026\tSam Lee\tP2\tGL mapping\t2.00\n10/21/2026\tAlex Doe\tProject Management\tMeeting\t0.25`, JSON.stringify(await clipboard(rev.p)));

await rev.p.check('#clients tr.client-row:has-text("Summit Drywall") input[type="checkbox"]');
check("reviewed ticks are counted", (await rev.p.textContent("#reviewed-badge")) === "1 of 2 reviewed");

const [csv] = await Promise.all([rev.p.waitForEvent("download"), rev.p.click("#detail-csv")]);
const lines = readFileSync(await csv.path(), "utf8").trim().split("\r\n");
check("the detail CSV has every person's line", lines.length === 5 && lines[0].startsWith("date,employee,client"), `${lines.length} lines`);

await rev.p.click("#copy-summary");
await rev.p.waitForTimeout(150);
check("the summary reads as a hand-off", /^Billable hours, 2026-10-19 to 2026-10-23\n\nCoastal Interiors Ltd\.: 2\.50 h\n {2}P2 · Data conversion · Brand new task: 1\.00 h/.test(await clipboard(rev.p)));

recording = false; // a reload is an ordinary page load
await rev.p.reload({ waitUntil: "networkidle" });
recording = true;
check("the review survives a reload", (await rev.p.textContent("#period-total")) === "4.75" && (await rev.p.textContent("#reviewed-badge")) === "1 of 2 reviewed");

// A corrected file for the same week replaces the old one.
await alex.p.evaluate(() => {
  const st = JSON.parse(localStorage.getItem("billable.v1"));
  st.sessions = st.sessions.filter((s) => s.id !== "e2e2");
  localStorage.setItem("billable.v1", JSON.stringify(st));
});
await alex.p.reload();
await alex.p.click(".settings > summary");
await alex.p.fill("#hours-from", day(0));
await alex.p.fill("#hours-to", day(4));
const [again] = await Promise.all([alex.p.waitForEvent("download"), alex.p.click("#hours-btn")]);
await rev.p.setInputFiles("#hours-files", [await again.path()]);
check("a newer file for the same days replaces the old one", (await rev.p.textContent("#period-total")) === "4.50");

recording = false;
check("the review page made no network requests", requests.length === 0, requests.slice(0, 3).join(", "));

/* ---------- offline: the review page never replaces the app's saved copy ---------- */

const off = await context("offline");
await off.p.goto(`${BASE}/`, { waitUntil: "networkidle" });
await off.p.evaluate(() => navigator.serviceWorker.ready);
await off.p.reload({ waitUntil: "networkidle" }); // now controlled by the worker
await off.p.goto(`${BASE}/review.html`, { waitUntil: "networkidle" });
await off.ctx.setOffline(true);
await off.p.goto(`${BASE}/`);
check("offline, the app still opens as the app after visiting the review page", await off.p.isVisible("#client-name"));
await off.ctx.setOffline(false);

check("no uncaught page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(results.join("\n"));
process.exit(failed ? 1 : 0);
