// Draws src/og-image.png, the demo's 1200x630 link preview, from the running
// demo's own client cards. Needs playwright, as the end-to-end tests do.
//
//   node tools/build-og-image.mjs http://localhost:8187

import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const BASE = (process.argv[2] || "http://localhost:8187").replace(/\/$/, "");
const OUT = fileURLToPath(new URL("../src/og-image.png", import.meta.url));

const browser = await chromium.launch();
const app = await browser.newPage({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 2, timezoneId: "America/Vancouver" });
// A fixed mid-morning, so the card reads like a working day whenever this is run.
await app.clock.install({ time: new Date("2026-11-03T10:14:00-08:00") });
await app.goto(`${BASE}/`);
await app.waitForSelector(".client");
await app.click(".clients .client:first-child .toggle"); // a running timer is the card worth showing
await app.clock.fastForward("01:02:33");
await app.waitForSelector(".toggle.stop");
const box = await app.locator(".clients").boundingBox();
const cards = (await app.screenshot({ clip: { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: 560 } })).toString("base64");

const card = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await card.setContent(`<body style="margin:0;width:1200px;height:630px;overflow:hidden;position:relative;background:linear-gradient(120deg,#1c1f24,#16181c 60%);font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
  <div style="position:absolute;left:70px;top:140px;width:560px">
    <div style="font-size:88px;font-weight:700;color:#e8e4da;letter-spacing:-1px">Billable<span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:#f0b23e;margin-left:14px;vertical-align:middle"></span></div>
    <div style="font-size:35px;color:#9198a1;margin-top:18px;line-height:1.3">Start and stop a timer per client. Hours rounded to the quarter, ready to paste.</div>
    <div style="font-size:24px;color:#f0b23e;margin-top:30px;font-family:ui-monospace,Menlo,monospace">Try the demo. Made-up hours,<br>nothing to sign up for.</div>
  </div>
  <img src="data:image/png;base64,${cards}" style="position:absolute;right:44px;top:72px;width:500px;border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.55);transform:rotate(-3deg)">
</body>`);
await card.screenshot({ path: OUT });
await browser.close();
