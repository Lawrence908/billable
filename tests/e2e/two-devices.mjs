// End-to-end check against a running deployment, driving only the real UI.
// Each "device" is a separate browser context with its own storage. Sync
// scenarios run only when the deployment was built with ENABLE_SYNC=true; the
// network-silence check runs on every build and must find zero requests after
// load (it allows the sync endpoint only when sync is built in).
//
//   npm install --no-save playwright && npx playwright install chromium
//   node tests/e2e/two-devices.mjs https://billable.example
//
// With sync built in, it creates one sync mailbox; the last step deletes it.

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

// Loads the app in a fresh browser, waits for it to settle (including the
// service worker installing), then uses every feature while recording every
// request the browser makes and every Content Security Policy violation.
async function silence(hasSync) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const p = await ctx.newPage();
  p.on("dialog", (d) => (d.type() === "prompt" ? d.accept("Acme Corporation") : d.accept()));
  const violations = [];
  p.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  let recording = false;
  const requests = [];
  ctx.on("request", (r) => { if (recording) requests.push(`${r.method()} ${r.url()}`); });

  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.evaluate(() => navigator.serviceWorker?.ready);
  await p.waitForTimeout(1500);
  recording = true;

  const at = (s) => p.locator(s);
  await add(p, "Acme Corp");
  await add(p, "Northwind");
  await p.click('button[aria-label="Start Acme Corp"]');
  await p.click('.client:has-text("Acme Corp") .more-toggle');
  await p.selectOption('.client:has-text("Acme Corp") .tag-category', "p2");
  await p.fill('.client:has-text("Acme Corp") .tag-note', "AR Replication");
  await p.press('.client:has-text("Acme Corp") .tag-note', "Enter");
  await p.click('button[aria-label="Start Northwind"]');
  await p.click('button[aria-label="Stop Northwind"]');
  await p.click("#log-wrap > summary");
  await p.selectOption("#entry-client", { label: "Northwind" });
  await p.fill("#entry-start", "00:10");
  await p.fill("#entry-end", "00:40");
  await p.click("#add-entry button");
  await at("#log .entry input[type=time]").first().fill("00:05");
  await at("#log .entry input[type=time]").first().dispatchEvent("change");
  if (await at("#timeline .gap").count()) await at("#timeline .gap").first().click();
  if (await at("#timeline .block").count()) await at("#timeline .block").first().click();
  await p.click("#summary-wrap > summary");
  await p.click("#day-prev");
  await p.click("#day-today");
  await p.click('button[aria-label="Copy Northwind for Sheets"]');
  await p.click("#copy-btn");
  await p.fill("#email-to", "me@example.com");
  await p.click("#email-btn").catch(() => {});
  await p.waitForTimeout(300);
  await p.click("#move-wrap > summary");
  await p.click("#move-make");
  await p.click("#move-copy");
  await p.click(".settings > summary");
  await p.check('input[name="sheet-layout"][value="all"]');
  await p.fill("#employee", "Test Person");
  await p.press("#employee", "Tab");
  const [csv] = await Promise.all([p.waitForEvent("download"), p.click("#csv-btn")]);
  const [backup] = await Promise.all([p.waitForEvent("download"), p.click("#export-btn")]);
  await p.setInputFiles("#import-file", await backup.path());
  await p.waitForTimeout(300);
  const importToast = await toast(p);
  await p.click('.client:has-text("Acme Corp") button:has-text("Rename")');
  await p.click('.client:has-text("Northwind") button:has-text("Remove")');
  await p.click('#archived button:has-text("Restore")');
  await p.click('.client:has-text("Acme Corporation") .toggle');
  await p.waitForTimeout(1500);
  recording = false;

  const csvOk = readFileSync(await csv.path(), "utf8").startsWith("date,client");
  const backupOk = JSON.parse(readFileSync(await backup.path(), "utf8")).clients.length === 2;
  // blob: and data: URLs are files the browser made in memory (the CSV and
  // backup downloads). mailto: hands the summary to the mail app; nothing goes
  // over the network. Anything else, http or https, would be a real request.
  const offNetwork = (r) => / (blob|data|mailto):/.test(r);
  const network = requests.filter((r) => !offNetwork(r) && !(hasSync && r.includes("/api/sync")));
  const handoffs = requests.filter(offNetwork).map((r) => r.split(" ")[1].split(":")[0]);
  check("CSV and backup export work, and import reads the backup back", csvOk && backupOk && /merged/i.test(importToast), importToast);
  check("zero network requests after load while every feature is used", network.length === 0,
    network.slice(0, 5).join(" | ") || `off-network only: ${[...new Set(handoffs)].join(", ") || "none"}`);
  check("no Content Security Policy violations", violations.length === 0, violations.slice(0, 2).join(" | "));
  await ctx.close();
}

try {
  const A = await device("A");
  const hasSync = !!(await A.p.$("#sync-wrap"));
  results.push(`info sync is ${hasSync ? "built in" : "not in this build"}`);

  await add(A.p, "Acme Corp");
  await add(A.p, "Northwind");
  await A.p.click('button[aria-label="Start Acme Corp"]');
  check("the sync panel is present exactly when sync is built in", hasSync === !!(await A.p.$("#sync-wrap")));
  check("no sync passphrase is stored", !(await A.p.evaluate(() => localStorage.getItem("billable.sync"))) || hasSync);

  if (hasSync) {
  const B = await device("B");
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
  } else {
    // A #sync= link on a build without sync must not linger in the address bar.
    const S = await device("S");
    await S.p.goto(`${BASE}#sync=maple-river-copper-tiger-lunar-hinge`);
    await S.p.waitForTimeout(300);
    check("a sync link on a build without sync is stripped and ignored",
      S.p.url() === BASE && !(await S.p.evaluate(() => localStorage.getItem("billable.sync"))));
    // Leftover sync state from an earlier build is cleaned up on load.
    await S.p.evaluate(() => localStorage.setItem("billable.sync", JSON.stringify({ v: 2, phrase: "x y z", access: "a", key: "k" })));
    await S.p.reload();
    check("leftover sync keys are deleted on load", !(await S.p.evaluate(() => localStorage.getItem("billable.sync"))));
  }

  await A.p.click("#move-wrap > summary");
  await A.p.click("#move-make");
  await A.p.waitForSelector("#move-qr svg");
  const link = await A.p.$eval("#move-box", (el) => el.dataset.url);
  const D = await device("D");
  await D.p.goto(link);
  await D.p.waitForTimeout(800);
  check("a transfer link copies data with no sync",
    (await clients(D.p)).length === (await clients(A.p)).length && !(await D.p.evaluate(() => localStorage.getItem("billable.sync"))));
  await D.p.click("#move-wrap > summary");
  await D.p.fill("#move-link", link);
  await D.p.click("#move-paste button");
  await D.p.waitForTimeout(300);
  check("importing the same link twice adds nothing", /Added 0 new clients and 0 entries/.test(await toast(D.p)));

  const E = await device("E");
  if (hasSync) {
    await E.p.click("#sync-wrap > summary");
    await E.p.fill("#sync-join-phrase", "not the right words at all");
    await E.p.click("#sync-join button");
    await E.p.waitForFunction(() => document.getElementById("toast").textContent.length > 0, null, { timeout: 15000 });
    check("a wrong passphrase is refused", /No synced data found/.test(await toast(E.p)));
  }

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

  // Forgotten timers, the timeline, Copy for Sheets and offline loading.
  const G = await device("G");
  await G.ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const seed = (fn) => G.p.evaluate(fn).then(() => G.p.reload());
  await seed(() => {
    const at = (daysAgo, h, m) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d.getTime(); };
    localStorage.setItem("billable.v1", JSON.stringify({
      clients: [{ id: "a", name: "Acme Corp", updated: 1 }, { id: "b", name: "Northwind", updated: 1 }],
      sessions: [{ id: "y", clientId: "a", start: at(1, 17, 0), end: null, updated: 1 }],
    }));
  });
  check("a timer left running overnight raises a prompt", /running since/.test(await G.p.textContent("#nudges")));
  await G.p.fill("#nudges input[type=time]", "17:30");
  await G.p.click('#nudges button:has-text("Stop at that time")');
  await G.p.waitForTimeout(200);
  const stoppedAt = await G.p.evaluate(() => new Date(JSON.parse(localStorage.getItem("billable.v1")).sessions[0].end).getHours() * 60
    + new Date(JSON.parse(localStorage.getItem("billable.v1")).sessions[0].end).getMinutes());
  check("the prompt stops it at the time given, and goes away", stoppedAt === 17 * 60 + 30 && !(await G.p.textContent("#nudges")));

  await seed(() => {
    const s = JSON.parse(localStorage.getItem("billable.v1"));
    s.sessions.push({ id: "long", clientId: "b", start: Date.now() - 5 * 3600e3, end: null, updated: 2 });
    localStorage.setItem("billable.v1", JSON.stringify(s));
  });
  check("a five-hour timer asks if you are still on it", /Still on it\?/.test(await G.p.textContent("#nudges")));
  await G.p.click('#nudges button:has-text("Still working")');
  await G.p.reload();
  check("'Still working' quiets the prompt, across a reload", !(await G.p.textContent("#nudges")));

  await seed(() => {
    const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
    localStorage.setItem("billable.v1", JSON.stringify({
      clients: [{ id: "a", name: "Acme Corp", updated: 1 }, { id: "b", name: "Northwind", updated: 1 }],
      sessions: [
        { id: "1", clientId: "a", start: at(8, 0), end: at(9, 50), category: "p3", note: "Framing review", updated: 1 },
        { id: "2", clientId: "b", start: at(10, 0), end: at(10, 45), updated: 1 },
        { id: "3", clientId: "a", start: at(12, 0), end: at(12, 24), category: "gaps", updated: 1 },
      ],
      settings: { sheetLayout: "all", employee: "Chris Lawrence", updated: 1 },
    }));
  });
  const counts = await G.p.evaluate(() => [document.querySelectorAll("#timeline .block").length, document.querySelectorAll("#timeline .gap").length]);
  check("the timeline draws each entry and each untracked gap", JSON.stringify(counts) === "[3,2]", JSON.stringify(counts));
  await G.p.locator("#timeline .gap").last().click();
  check("tapping a gap pre-fills a new entry for it",
    (await G.p.inputValue("#entry-start")) === "10:45" && (await G.p.inputValue("#entry-end")) === "12:00" && (await G.p.$eval("#log-wrap", (d) => d.open)));
  await G.p.locator("#timeline .block").first().click();
  await G.p.waitForTimeout(100);
  check("tapping a block highlights its entry", await G.p.$eval('#log [data-id="1"]', (li) => li.classList.contains("flash")));
  await G.p.screenshot({ path: new URL("../../screenshots/timeline-390.png", import.meta.url).pathname });

  await G.p.click("#summary-wrap > summary");
  await G.p.click('button[aria-label="Copy Acme Corp for Sheets"]');
  await G.p.waitForTimeout(200);
  const tsv = await G.p.evaluate(() => navigator.clipboard.readText());
  const today = await G.p.evaluate(() => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`; });
  check("a client's copy button copies just that client, in the sheet's column order",
    tsv === `${today}\tChris Lawrence\tP3\tFraming review\t1.75\n${today}\tChris Lawrence\tGaps\t\t0.50`, JSON.stringify(tsv));
  check("a copied client is ticked off", await G.p.$eval('#summary .client-row:has-text("Acme Corp") .copy-btn', (b) => b.classList.contains("done")));
  await seed(() => {
    const s = JSON.parse(localStorage.getItem("billable.v1"));
    s.sessions.find((x) => x.id === "3").end += 30 * 60e3;
    localStorage.setItem("billable.v1", JSON.stringify(s));
  });
  check("changing that client's time clears the tick", !(await G.p.$eval('#summary .client-row:has-text("Acme Corp") .copy-btn', (b) => b.classList.contains("done"))));

  await G.p.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 }).catch(() => {});
  if (!(await G.p.evaluate(() => !!navigator.serviceWorker.controller))) await G.p.reload();
  await G.ctx.setOffline(true);
  await G.p.reload();
  check("the app opens with no connection, data intact", (await clients(G.p)).length === 2);
  await G.ctx.setOffline(false);

  await silence(hasSync);

  if (hasSync) {
    await A.p.click("#sync-delete");
    await A.p.waitForTimeout(500);
    check("the synced copy can be deleted", /Server copy deleted/.test(await toast(A.p)));
  }
} catch (e) {
  check("run completed", false, e.message.split("\n").slice(0, 4).join(" / "));
} finally {
  await browser.close();
}

check("no uncaught page errors", errors.length === 0, errors.join("; "));
console.log(results.join("\n"));
process.exit(failed ? 1 : 0);
