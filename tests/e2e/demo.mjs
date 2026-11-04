// End-to-end check of the public demo build, through the real UI: the made-up
// hours are there on the first visit, Start and Stop work straight away, the
// review page opens on last week with its planted mistakes under Checks, Reset
// brings the data back, and nothing makes a network request. With a second
// address, also checks that the real build carries none of the demo.
//
//   node tests/e2e/demo.mjs http://localhost:8187 [http://localhost:8175]

import { chromium } from "playwright";

const BASE = (process.argv[2] || "http://localhost:8187").replace(/\/$/, "");
const REAL = process.argv[3]?.replace(/\/$/, "");
const SHOTS = process.env.SHOTS; // a directory for screenshots, if set
const results = [];
let failed = 0;
function check(name, ok, detail = "") {
  results.push(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}

const browser = await chromium.launch();
const counted = []; // what the page sent to the analytics endpoint
const errors = [];
const dialogs = [];
const requests = [];
let recording = false;

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "America/Vancouver" });
ctx.on("request", (r) => {
  if (recording) requests.push(`${r.method()} ${r.url()}`);
  if (r.method() === "POST") counted.push(`${new URL(r.url()).pathname} ${r.postData() || ""}`);
});
const p = await ctx.newPage();
p.on("pageerror", (e) => errors.push(e.message));
p.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) errors.push(m.text()); });
p.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });

/* ---------- the app, on a first visit ---------- */

await p.goto(`${BASE}/`, { waitUntil: "networkidle" });
recording = true;
check("the demo banner shows", await p.isVisible(".demo-bar"));
// The app retitles the tab as timers run; link previews read the served page.
check("the page title says demo, for link previews", /<title>Billable demo/.test(await (await p.request.get(`${BASE}/`)).text()));
const clients = await p.$$eval(".clients .client-name", (n) => n.map((x) => x.textContent));
check("the made-up clients are on the list", clients.includes("Northwind Logistics") && clients.includes("Juniper Labs") && !clients.includes("Bluefin Dental Group"), clients.join(", "));
check("no timer is running on arrival", (await p.$$(".toggle.stop")).length === 0);
const history = await p.evaluate(() => JSON.parse(localStorage.getItem("billable.v1")).sessions.length);
check("weeks of history are stored", history > 50, `${history} entries`);
check("the employee name is set for Copy for Sheets", await p.evaluate(() => JSON.parse(localStorage.getItem("billable.v1")).settings.employee === "Alex Demo"));
check("official lists are in place", await p.evaluate(() => JSON.parse(localStorage.getItem("billable.lists")).clients.length === 7));
if (SHOTS) await p.screenshot({ path: `${SHOTS}/demo-app-390.png`, fullPage: true });

await p.click(".clients .client:first-child .toggle");
await p.waitForSelector(".toggle.stop");
check("Start works straight away", (await p.$$(".toggle.stop")).length === 1);
await p.waitForTimeout(1500);
await p.click(".toggle.stop");
check("Stop works", (await p.$$(".toggle.stop")).length === 0);

// Yesterday's summary has hours in it.
await p.click("#day-prev");
const yesterday = await p.textContent("#sum-rounded");
const weekend = await p.evaluate(() => [0, 6].includes(new Date(Date.now() - 864e5).getDay()));
check("the summary has past days", weekend ? yesterday === "0.00" : Number(yesterday) > 5, `${yesterday} h`);

/* ---------- moving the cards ---------- */

await p.click("#day-today");
const names = (page = p) => page.$$eval(".clients .client-name", (n) => n.map((x) => x.textContent));
const swap = (list, a, b) => { const out = [...list]; [out[a], out[b]] = [out[b], out[a]]; return out; };
const nameList = await names();
check("the first card can't go up, and the last can't go down",
  await p.isDisabled(".client:first-child [data-move=up]") && await p.isDisabled(".client:last-child [data-move=down]") && await p.isEnabled(".client:first-child [data-move=down]"));
await p.click(".client:nth-child(2) [data-move=up]");
const afterArrow = await names();
check("the up arrow moves a card up", JSON.stringify(afterArrow) === JSON.stringify(swap(nameList, 0, 1)), afterArrow.join(", "));
check("the arrow keeps the keyboard, at the end of the list too", await p.evaluate(() => document.activeElement?.dataset?.move === "down"));
await p.keyboard.press("Enter");
check("a key press moves it back down", JSON.stringify(await names()) === JSON.stringify(nameList));
check("the move is announced to screen readers", /moved to position 2 of/.test(await p.textContent("#move-status")));

// Holds a drag from the grip of one card to the middle of another.
async function grab(index) {
  const box = await p.locator(`.client:nth-child(${index}) .client-grip`).boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
}
async function dragOver(index) {
  const box = await p.locator(`.client:nth-child(${index})`).boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height * 0.8, { steps: 8 });
}
await p.evaluate(() => scrollTo(0, 0));
await grab(1);
await dragOver(3);
// The app redraws every minute, and a drag must survive it.
await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
check("a redraw leaves a card being dragged alone", await p.locator(".client.dragging").count() === 1);
await p.keyboard.press("Escape");
await p.mouse.up();
check("Esc cancels a drag", JSON.stringify(await names()) === JSON.stringify(nameList) && await p.locator(".client.dragging").count() === 0);

await grab(1);
await dragOver(3);
await p.mouse.up();
const afterDrag = await names();
check("dragging the grip moves a card", afterDrag[2] === nameList[0] && afterDrag[0] === nameList[1] && afterDrag[1] === nameList[2], afterDrag.join(", "));
check("dragging starts no timer", (await p.$$(".toggle.stop")).length === 0);
await p.click(".client:first-child .client-grip");
check("a click on the grip does nothing", JSON.stringify(await names()) === JSON.stringify(afterDrag) && (await p.$$(".toggle.stop")).length === 0);
await p.reload();
await p.waitForSelector(".client");
check("the order survives a reload", JSON.stringify(await names()) === JSON.stringify(afterDrag));
const rowsInOrder = await p.$$eval("#summary tbody .client-row td:first-child", (n) => n.map((x) => x.textContent.trim()));
check("the summary follows the cards", JSON.stringify(rowsInOrder) === JSON.stringify(afterDrag.filter((n) => rowsInOrder.includes(n))), rowsInOrder.join(", "));
if (SHOTS) await p.screenshot({ path: `${SHOTS}/demo-move-390.png` });

// On a phone, through real touch events, with a list longer than the screen.
const phone = await browser.newContext({ viewport: { width: 390, height: 560 }, hasTouch: true, isMobile: true, timezoneId: "America/Vancouver" });
const t = await phone.newPage();
t.on("pageerror", (e) => errors.push(`phone: ${e.message}`));
t.on("dialog", (d) => d.accept());
await t.goto(`${BASE}/`, { waitUntil: "networkidle" });
const cdp = await phone.newCDPSession(t);
const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
const phoneNames = await names(t);
await t.locator(".client:first-child .client-grip").scrollIntoViewIfNeeded();
const grip = await t.locator(".client:first-child .client-grip").boundingBox();
const x = grip.x + grip.width / 2;
await touch("touchStart", x, grip.y + grip.height / 2);
for (let y = grip.y; y < 520; y += 30) {
  await touch("touchMove", x, y);
  await t.waitForTimeout(16);
}
await touch("touchMove", x, 540);
const scrollBefore = await t.evaluate(() => scrollY);
await t.waitForTimeout(900);
check("holding a drag near the edge scrolls the page", await t.evaluate(() => scrollY) > scrollBefore, `${scrollBefore} -> ${await t.evaluate(() => scrollY)}`);
await touch("touchEnd");
const phoneAfter = await names(t);
check("a touch drag moves a card past the screen's edge", phoneAfter.indexOf(phoneNames[0]) >= 2 && phoneAfter.length === phoneNames.length, phoneAfter.join(", "));
check("a touch drag starts no timer", (await t.$$(".toggle.stop")).length === 0);
await phone.close();

/* ---------- the review page ---------- */

await p.click(".demo-bar a[href='/review.html']");
await p.waitForSelector("#checks li");
check("the review page has five people", (await p.$$("#people tr")).length === 5);
const checks = await p.textContent("#checks");
for (const [what, text] of [["the misspelt client", "Northwind Logistic"], ["the unofficial task", "Onsite training"], ["the untagged time", "Priya Shah"], ["the missing Friday", "Morgan Chen"], ["the running timer", "Sam Patel"]]) {
  check(`Checks shows ${what}`, checks.includes(text));
}
check("the period is last week", Number(await p.textContent("#period-total")) > 100, await p.textContent("#period-total"));
if (SHOTS) {
  await p.setViewportSize({ width: 1280, height: 900 });
  await p.screenshot({ path: `${SHOTS}/demo-review-1280.png`, fullPage: true });
  await p.setViewportSize({ width: 390, height: 844 });
}

/* ---------- reset ---------- */

await p.goto(`${BASE}/`);
await p.fill("#client-name", "Visitor's own client");
await p.click("#add-client button");
check("a visitor can add a client", (await p.$$eval(".clients .client-name", (n) => n.map((x) => x.textContent))).includes("Visitor's own client"));
await p.click("#demo-reset");
await p.waitForLoadState("load");
await p.waitForSelector(".clients .client");
const after = await p.$$eval(".clients .client-name", (n) => n.map((x) => x.textContent));
check("Reset demo brings the made-up data back", !after.includes("Visitor's own client") && after.includes("Northwind Logistics"));
check("Reset asks first", dialogs.some((d) => /Start the demo again/.test(d)));

// Moving between the two pages loads them, so check that only this site's own files were asked for.
const elsewhere = requests.filter((r) => !r.split(" ")[1].startsWith(`${BASE}/`));
check("the demo asked nothing of any other site", elsewhere.length === 0, elsewhere.slice(0, 3).join(", "));
check("no errors or CSP violations", errors.length === 0, errors.slice(0, 3).join(" | "));

// Only served through the reverse proxy, so a local run has no tracker to check.
const tracker = (await p.request.get(`${BASE}/a/s.js`)).ok();
const home = await p.request.get(`${BASE}/`);
check("the demo's policy allows connecting to this site only", /connect-src 'self'/.test(home.headers()["content-security-policy"]));
check("the link preview image is served", (await p.request.get(`${BASE}/og-image.png`)).ok() && /og:image" content="https:\/\/[^"]+\/og-image\.png"/.test(await home.text()));
check("POSTs go only to the analytics endpoint", counted.every((c) => c.startsWith("/a/api/send ")), counted.slice(0, 2).join(" | ").slice(0, 200));
if (tracker) check("visits and timer clicks are counted", counted.some((c) => /"url"/.test(c)) && counted.some((c) => /"name":"timer-start"/.test(c)) && counted.some((c) => /"name":"timer-stop"/.test(c)), `${counted.length} sent`);
check("analytics never carry what a visitor entered", !counted.some((c) => /Visitor|Northwind|Alex/.test(c)));

/* ---------- the real build carries none of it ---------- */

if (REAL) {
  const real = await browser.newPage({ timezoneId: "America/Vancouver" });
  await real.goto(`${REAL}/`, { waitUntil: "networkidle" });
  check("the real build has no demo banner", !(await real.$(".demo-bar")));
  check("the real build starts empty", (await real.$$(".clients .client")).length === 0);
  const res = await real.request.get(`${REAL}/js/demo.js`);
  check("the real build has no demo code", res.status() === 404, String(res.status()));
  check("the real build has no preview image", (await real.request.get(`${REAL}/og-image.png`)).status() === 404);
  const realHome = await real.request.get(`${REAL}/`);
  check("the real build still may connect nowhere", /connect-src 'none'/.test(realHome.headers()["content-security-policy"]));
  const realHtml = await realHome.text();
  check("the real build has no tracker and keeps its privacy text", !/a\/s\.js|nodemo/.test(realHtml) && /No account, no ads, no analytics/.test(realHtml));
  await real.goto(`${REAL}/review.html`);
  check("the real review page has no demo banner", !(await real.$(".demo-bar")));
  await real.goto(`${REAL}/`);
  const add = async (name) => {
    await real.fill("#client-name", name);
    await real.click("#add-client button");
  };
  await add("First");
  check("the real build has nothing to move with one client", await real.locator(".client-move").count() === 0);
  await add("Second");
  await real.click(".client:first-child [data-move=down]");
  check("the real build moves cards too", (await names(real)).join() === "Second,First");
  await real.reload();
  await real.waitForSelector(".client");
  check("and keeps the order", (await names(real)).join() === "Second,First");
}

await browser.close();
console.log(results.join("\n"));
process.exit(failed ? 1 : 0);
