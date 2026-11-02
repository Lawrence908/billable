// The public demo's made-up data and its banner. Only demo builds load this
// file, from a script tag placed before app.js and review.js, so the data is
// in storage before either page reads it. The demo has its own site, so its
// storage never meets anyone's real hours.
//
// A visitor keeps their copy, changes included, for a week after it was made,
// so a review started one day can be finished the next. After that the data is
// made fresh, so the history ends today again. Reset demo does so on demand.

import { dayKey, shiftDay } from "./model.js";
import { demoReview, demoState, DEMO_LISTS } from "./demo.js";
import { storage } from "./ui.js";

const SEED_KEY = "billable.demo"; // { v, day }: which made-up data this browser holds
const VERSION = 1; // raise when the made-up data changes, to replace what visitors have
const KEEP_DAYS = 7;

// The keys app.js and review.js read.
const STATE_KEY = "billable.v1";
const LISTS_KEY = "billable.lists";
const REVIEW_KEY = "billable.review.v1";
const TIP_KEY = "billable.tip-dismissed";
const SUMMARY_OPEN_KEY = "billable.summary-open";

function seed(now) {
  let keys = [];
  try {
    keys = Object.keys(localStorage);
  } catch { /* storage blocked: the pages start empty */ }
  for (const k of keys) if (k.startsWith("billable.")) storage.remove(k);
  const st = demoState(now);
  storage.set(STATE_KEY, JSON.stringify(st));
  storage.set(LISTS_KEY, JSON.stringify(DEMO_LISTS));
  storage.set(REVIEW_KEY, JSON.stringify(demoReview(now, st)));
  storage.set(TIP_KEY, "1");
  storage.set(SUMMARY_OPEN_KEY, "1");
  storage.set(SEED_KEY, JSON.stringify({ v: VERSION, day: dayKey(now) }));
}

const seeded = (() => {
  try {
    return JSON.parse(storage.get(SEED_KEY) || "null");
  } catch {
    return null;
  }
})();
if (seeded?.v !== VERSION || !seeded?.day || seeded.day < shiftDay(dayKey(Date.now()), -KEEP_DAYS)) seed(Date.now());

// The feedback link's address is set when the image is built; without one, no link.
const feedback = document.getElementById("demo-feedback");
if (feedback && !/^https:\/\//.test(feedback.getAttribute("href"))) feedback.remove();

document.getElementById("demo-reset")?.addEventListener("click", () => {
  if (!confirm("Start the demo again with fresh made-up hours? Anything you changed is erased.")) return;
  storage.remove(SEED_KEY);
  location.reload();
});

// Counted by the demo's analytics, by name only: whether people try the timers.
// Capture, because pressing the button redraws it.
document.addEventListener("click", (e) => {
  const button = e.target.closest?.(".toggle");
  if (button) window.umami?.track(button.classList.contains("stop") ? "timer-stop" : "timer-start");
}, true);
