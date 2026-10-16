// End-to-end check against a running deployment, driving only the real UI.
// Each "device" is a separate browser context with its own storage.
//
//   npm install --no-save playwright && npx playwright install chromium
//   node tests/e2e/two-devices.mjs https://billable.example
//
// It creates one sync mailbox on the target server; the last step deletes it.

import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = (process.argv[2] || "http://localhost:8175").replace(/\/$/, "") + "/";
const results = [];
let failed = 0;

function check(name, ok, detail = "") {
  results.push(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}

const browser = await chromium.launch();
const errors = [];

async function device(name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  p.on("dialog", (d) => d.accept());
  await p.goto(BASE);
  return { ctx, p };
}

const clients = (p) => p.$$eval(".client", (lis) =>
  lis.map((li) => li.querySelector(".client-name").textContent + (li.classList.contains("running") ? "*" : "")));
const stored = (p) => p.evaluate(() => localStorage.getItem("billable.v1"));
const entryCount = (p) => p.evaluate(() => {
  const s = JSON.parse(localStorage.getItem("billable.v1"));
  const ids = new Set(s.clients.filter((c) => !c.deleted).map((c) => c.id));
  return s.sessions.filter((x) => !x.deleted && ids.has(x.clientId)).length;
});
const synced = (p) => p.waitForFunction(() =>
  /^Synced at/.test(document.getElementById("sync-status").textContent)
  && document.getElementById("sync-badge").textContent === "On", null, { timeout: 20000 });
const add = async (p, name) => { await p.fill("#client-name", name); await p.click("#add-client button"); };
const syncNow = async (p) => { await p.click("#sync-now"); await p.waitForTimeout(150); await synced(p); };
const toast = (p) => p.textContent("#toast");

try {
  const A = await device("A");
  const B = await device("B");

  await add(A.p, "Acme Corp");
  await add(A.p, "Northwind");
  await A.p.click('button[aria-label="Start Acme Corp"]');
  await A.p.click("#sync-wrap > summary");
  await A.p.click("#sync-create");
  await A.p.waitForFunction(() => document.getElementById("sync-new-phrase").textContent.split(" ").length === 6);
  const phrase = await A.p.textContent("#sync-new-phrase");
  await A.p.check("#sync-new-saved");
  await A.p.click("#sync-new-start");
  await synced(A.p);
  check("create a passphrase and sync", true);

  // B already has its own "ACME CORP", plus a client A does not know.
  await add(B.p, "ACME CORP");
  await add(B.p, "Local Only");
  await B.p.click("#sync-wrap > summary");
  await B.p.fill("#sync-join-phrase", phrase.toUpperCase().replace(/ /g, "-"));
  await B.p.click("#sync-join button");
  await synced(B.p);
  await syncNow(A.p);
  const joined = await clients(B.p);
  check("join with the passphrase typed differently; same-named clients collapse",
    JSON.stringify(joined) === JSON.stringify(["Acme Corp*", "Northwind", "Local Only"]), JSON.stringify(joined));

  await B.p.click('button[aria-label="Stop Acme Corp"]');
  await B.p.waitForTimeout(1200);
  await syncNow(A.p);
  check("a stop on one device reaches the other", !(await clients(A.p)).includes("Acme Corp*"));

  await A.ctx.setOffline(true);
  await B.ctx.setOffline(true);
  await A.p.click('button[aria-label="Start Northwind"]');
  await A.p.waitForTimeout(1100);
  await B.p.click('button[aria-label="Start Local Only"]');
  await B.p.waitForTimeout(1100);
  check("offline is reported, not hidden", /offline/.test(await A.p.textContent("#sync-status")));
  await A.ctx.setOffline(false);
  await B.ctx.setOffline(false);
  await syncNow(A.p);
  await syncNow(B.p);
  await syncNow(A.p);
  const a = await clients(A.p);
  check("timers started on both devices while apart settle to the later one",
    a.filter((c) => c.endsWith("*")).join() === "Local Only*" && (await stored(A.p)) === (await stored(B.p)), JSON.stringify(a));

  const before = await entryCount(B.p);
  await A.p.click("#log-wrap > summary");
  await A.p.locator('#log .entry button[aria-label="Delete entry"]').first().click();
  await A.p.waitForTimeout(1200);
  await syncNow(B.p);
  check("a deletion reaches the other device", (await entryCount(B.p)) === before - 1);

  await A.p.click("#sync-show");
  const shown = await A.p.textContent("#sync-phrase");
  await A.p.click("#sync-qr-btn");
  await A.p.waitForSelector("#sync-qr-code svg");
  const C = await device("C");
  await C.p.goto(`${BASE}#sync=${shown.split(" ").join("-")}`);
  await synced(C.p);
  check("a QR sync link connects a device and leaves the address bar clean",
    C.p.url() === BASE && (await clients(C.p)).length === 3);

  await A.p.click("#move-wrap > summary");
  await A.p.click("#move-make");
  await A.p.waitForSelector("#move-qr svg");
  const link = await A.p.$eval("#move-box", (el) => el.dataset.url);
  const D = await device("D");
  await D.p.goto(link);
  await D.p.waitForTimeout(800);
  check("a transfer link copies data with no sync",
    (await clients(D.p)).length === 3 && !(await D.p.evaluate(() => localStorage.getItem("billable.sync"))));
  await D.p.click("#move-wrap > summary");
  await D.p.fill("#move-link", link);
  await D.p.click("#move-paste button");
  await D.p.waitForTimeout(300);
  check("importing the same link twice adds nothing", /Added 0 new clients and 0 entries/.test(await toast(D.p)));

  const E = await device("E");
  await E.p.click("#sync-wrap > summary");
  await E.p.fill("#sync-join-phrase", "not the right words at all");
  await E.p.click("#sync-join button");
  await E.p.waitForFunction(() => document.getElementById("toast").textContent.length > 0, null, { timeout: 15000 });
  check("a wrong passphrase is refused", /No synced data found/.test(await toast(E.p)));

  await add(E.p, '=HYPERLINK("x")');
  await E.p.click("#log-wrap > summary");
  await E.p.selectOption("#entry-client", { label: '=HYPERLINK("x")' });
  await E.p.fill("#entry-start", "00:05");
  await E.p.fill("#entry-end", "00:05");
  await E.p.click("#add-entry button");
  check("a zero-length manual entry is refused", /same time/.test(await toast(E.p)));
  await E.p.fill("#entry-end", "00:35");
  await E.p.click("#add-entry button");
  await E.p.click(".settings > summary");
  const [download] = await Promise.all([E.p.waitForEvent("download"), E.p.click("#csv-btn")]);
  const row = readFileSync(await download.path(), "utf8").split("\r\n")[1] || "";
  check("CSV neutralises a formula-like client name", row.includes(`"'=HYPERLINK(""x"")"`), row);

  // Categories and notes on a fresh device.
  const F = await device("F");
  await add(F.p, "Acme Corp");
  await add(F.p, "Northwind");
  check("the detail panel starts closed", !(await F.p.$(".client-more")));
  await F.p.click('.client:has-text("Acme Corp") .more-toggle');
  check("the note box is disabled until a category is chosen", await F.p.isDisabled('.client:has-text("Acme Corp") .tag-note'));
  await F.p.selectOption('.client:has-text("Acme Corp") .tag-category', "p3");
  await F.p.fill('.client:has-text("Acme Corp") .tag-note', "Framing review");
  await F.p.press('.client:has-text("Acme Corp") .tag-note', "Enter");
  await F.p.waitForTimeout(200);
  check("the card shows what its time goes to", (await F.p.textContent('.client:has-text("Acme Corp") .client-tag')) === "P3 · Framing review");
  await F.p.click('button[aria-label="Start Acme Corp"]');
  // Pretend the timer has run for 40 minutes, then switch category mid-timer.
  await F.p.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("billable.v1"));
    for (const x of s.sessions) if (x.end === null) x.start -= 40 * 60e3;
    localStorage.setItem("billable.v1", JSON.stringify(s));
  });
  await F.p.reload();
  await F.p.selectOption('.client:has-text("Acme Corp") .tag-category', "gaps");
  await F.p.waitForTimeout(200);
  const parts = await F.p.evaluate(() => JSON.parse(localStorage.getItem("billable.v1")).sessions
    .filter((s) => !s.deleted).sort((a, b) => a.start - b.start).map((s) => `${s.category}:${s.note}:${s.end === null ? "running" : "stopped"}`));
  check("changing category mid-timer splits the time", JSON.stringify(parts) === JSON.stringify(["p3:Framing review:stopped", "gaps::running"]), JSON.stringify(parts));
  check("the summary breaks the client down by line",
    JSON.stringify(await F.p.$$eval("#summary .line-row td:first-child", (tds) => tds.map((t) => t.textContent))) === JSON.stringify(["P3 · Framing review", "Gaps"]));
  await F.p.click('.client:has-text("Northwind") .more-toggle');
  await F.p.selectOption('.client:has-text("Northwind") .tag-category', "p3");
  const suggested = await F.p.$$eval("#notes-p3 option", (os) => os.map((o) => o.value));
  check("notes typed under a category are suggested for other clients", suggested.includes("Framing review"), JSON.stringify(suggested));
  await F.p.click("#log-wrap > summary");
  const entryTags = await F.p.$$eval("#log .entry .tag-category", (ss) => ss.map((s) => s.value));
  check("fix times shows each entry's category", JSON.stringify(entryTags) === JSON.stringify(["p3", "gaps"]), JSON.stringify(entryTags));
  await F.p.selectOption("#log .entry >> nth=0 >> .tag-category", "tech");
  await F.p.waitForTimeout(200);
  check("a past entry can be retagged",
    (await F.p.$$eval("#summary .line-row td:first-child", (tds) => tds.map((t) => t.textContent))).includes("Tech"));
  await F.p.click(".settings > summary");
  const [csvDl] = await Promise.all([F.p.waitForEvent("download"), F.p.click("#csv-btn")]);
  const csvRows = readFileSync(await csvDl.path(), "utf8").trim().split("\r\n");
  check("CSV has one row per line with category and note columns",
    csvRows[0] === "date,client,category,note,tracked_hours,hours" && csvRows.some((r) => r.includes('"Acme Corp","Tech"')), csvRows.slice(0, 3).join(" | "));
  await F.p.screenshot({ path: new URL("../../screenshots/categories-390.png", import.meta.url).pathname, fullPage: true });

  await A.p.click("#sync-delete");
  await A.p.waitForTimeout(500);
  check("the synced copy can be deleted", /Server copy deleted/.test(await toast(A.p)));
} catch (e) {
  check("run completed", false, e.message.split("\n")[0]);
} finally {
  await browser.close();
}

check("no uncaught page errors", errors.length === 0, errors.join("; "));
console.log(results.join("\n"));
process.exit(failed ? 1 : 0);
