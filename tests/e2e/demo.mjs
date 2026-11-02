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
}

await browser.close();
console.log(results.join("\n"));
process.exit(failed ? 1 : 0);
