// Run with: npm test (which sets TZ=America/Los_Angeles).
import { test } from "node:test";
import assert from "node:assert/strict";
import { HOUR, MINUTE, atTime, dayKey, existingClients, existingSessions, normalise, shiftDay, summaryRows } from "../src/js/model.js";
import { compile, hoursFile, isWeekday, parseHoursFile, tasksFor } from "../src/js/review-model.js";
import { COMPANY, DEMO_EMPLOYEE, DEMO_LISTS, demoReview, demoState, historyStart, lastWeek } from "../src/js/demo.js";

// Moments the demo might be opened: a Wednesday afternoon, a Monday before
// work, Saturday, Sunday morning on the day DST ends, and over lunch.
const NOWS = [
  atTime("2026-10-28", "15:20"),
  atTime("2026-10-26", "07:10"),
  atTime("2026-10-31", "11:45"),
  atTime("2026-11-01", "10:05"),
  atTime("2026-11-04", "12:30"),
];

// Sessions as plain tagged times, without the random ids.
const shape = (st) => existingSessions(st).map((s) => [existingClients(st).find((c) => c.id === s.clientId).name, s.start, s.end, s.category, s.note]);

test("demo state: valid, with nothing running and no overlaps", () => {
  for (const now of NOWS) {
    const st = demoState(now);
    assert.deepEqual(normalise(JSON.parse(JSON.stringify(st))), st);
    assert.equal(st.settings.employee, DEMO_EMPLOYEE);
    const sessions = existingSessions(st).sort((a, b) => a.start - b.start);
    assert.ok(sessions.length > 50, `${sessions.length} sessions`);
    assert.ok(sessions.every((s) => s.end !== null && s.end > s.start && s.end <= now));
    for (let i = 1; i < sessions.length; i++) assert.ok(sessions[i].start >= sessions[i - 1].end, "entries overlap");
    assert.ok(sessions[0].start >= atTime(historyStart(dayKey(now)), "00:00"));
  }
});

test("demo state: workdays of about 7 hours with a lunch break, weekends off", () => {
  const now = NOWS[0];
  const today = dayKey(now);
  for (let key = historyStart(today); key < today; key = shiftDay(key, 1)) {
    const ms = summaryRows(normalise(demoState(now)), key, now).reduce((a, r) => a + r.ms, 0);
    if (!isWeekday(key)) {
      assert.equal(ms, 0, key);
      continue;
    }
    assert.ok(ms > 5.5 * HOUR && ms < 8.5 * HOUR, `${key}: ${ms / HOUR} h`);
    const lunch = existingSessions(demoState(now)).filter((s) => s.start < atTime(key, "13:00") && s.end > atTime(key, "12:00"));
    assert.equal(lunch.length, 0, `${key} has time over lunch`);
  }
});

test("demo state: today's morning is filled up to a few minutes ago, on any day", () => {
  for (const now of NOWS) {
    const today = existingSessions(demoState(now)).filter((s) => dayKey(s.start) === dayKey(now));
    if (now - atTime(dayKey(now), "08:00") < HOUR) {
      assert.equal(today.length, 0, "nothing before work starts");
      continue;
    }
    assert.ok(today.length >= 1, new Date(now).toString());
    assert.ok(Math.max(...today.map((s) => s.end)) <= now - 3 * MINUTE);
  }
});

test("demo state: the same day gets the same hours, and the official names", () => {
  const now = NOWS[0];
  assert.deepEqual(shape(demoState(now)), shape(demoState(now + 2 * MINUTE)).filter(([, start]) => start < now - 3 * MINUTE));
  const st = demoState(now);
  for (const s of existingSessions(st)) {
    const client = existingClients(st).find((c) => c.id === s.clientId).name;
    assert.ok(DEMO_LISTS.clients.includes(client), client);
    assert.ok(tasksFor(DEMO_LISTS, s.category).includes(s.note), `${s.category} ${s.note}`);
  }
  // A client finished before this week is removed from the list, with its hours kept.
  assert.deepEqual(existingClients(st).filter((c) => c.archived).map((c) => c.name), ["Bluefin Dental Group"]);
});

test("demo review: last week shows each planted mistake under Checks", () => {
  for (const now of NOWS) {
    const today = dayKey(now);
    const review = demoReview(now);
    const lw = lastWeek(today);
    assert.deepEqual(review.period, lw);
    assert.equal(Object.keys(review.people).length, 5);
    const c = compile(review, lw.from, lw.to, { billableOnly: true });
    assert.deepEqual(c.checks.unknownClients.map((x) => x.name), ["Northwind Logistic"]);
    assert.deepEqual([...new Set(c.checks.otherTasks.map((x) => x.note))], ["Onsite training"]);
    assert.deepEqual(c.checks.noCategory.map((x) => x.employee), ["Priya Shah"]);
    assert.deepEqual(c.checks.missingDays, [{ employee: "Morgan Chen", days: [shiftDay(lw.from, 4)] }]);
    assert.deepEqual(c.checks.running, ["Sam Patel"]);
    assert.ok(c.hours > 5 * 30 && c.hours < 5 * 40, `${c.hours} h`);
    // Internal time is in the store, kept out of the billable view.
    assert.ok(compile(review, lw.from, lw.to).rows.some((r) => r.client === COMPANY));
    assert.ok(!c.rows.some((r) => r.client === COMPANY));
  }
});

test("demo review: Alex's lines are the app's own, as an hours file would carry them", () => {
  const now = NOWS[0];
  const st = demoState(now);
  const review = demoReview(now, st);
  const lw = lastWeek(dayKey(now));
  const sent = parseHoursFile(hoursFile(st, lw.from, shiftDay(lw.from, 4), now)).lines;
  const held = review.people[DEMO_EMPLOYEE.toLowerCase()].lines.filter((l) => l.date >= lw.from && l.date <= lw.to);
  const key = (l) => `${l.date}|${l.client}|${l.category}|${l.note}|${l.hours}`;
  assert.deepEqual(held.map(key).sort(), sent.map(key).sort());
});

test("demo review: the week before last is already reviewed, last week is not", () => {
  const now = NOWS[0];
  const review = demoReview(now);
  const lw = lastWeek(dayKey(now));
  const before = `${shiftDay(lw.from, -7)}_${shiftDay(lw.to, -7)}`;
  assert.ok(Object.keys(review.reviewed[before] || {}).length >= 4);
  assert.equal(review.reviewed[`${lw.from}_${lw.to}`], undefined);
});
