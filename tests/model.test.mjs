// Run with: TZ=America/Vancouver node --test tests/
// The time zone is pinned so the DST cases below mean the same thing everywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  atTime, csvFor, dayBounds, dayKey, endAfter, existingSessions, fmtHM, merge, normalise,
  noteSuggestions, pruneTombstones, retagClient, retagSession, roundHalf, sameData, settleRunning, shiftDay,
  summaryRows, summaryText, toggleTimer, totalsFor,
} from "../src/js/model.js";

const MIN = 60e3;
const HOUR = 60 * MIN;
const at = (key, hhmm) => atTime(key, hhmm);

function day(clients, sessions, settings = {}) {
  return normalise({
    clients: clients.map(([id, name, extra = {}]) => ({ id, name, archived: false, updated: 1, ...extra })),
    sessions: sessions.map(([id, clientId, start, end, updated = 1]) => ({ id, clientId, start, end, updated })),
    settings: { email: "", allowOverlap: false, updated: 1, ...settings },
  });
}

test("roundHalf rounds to the nearest half hour, 15 minutes rounding up", () => {
  assert.equal(roundHalf(14 * MIN), 0);
  assert.equal(roundHalf(15 * MIN), 0.5);
  assert.equal(roundHalf(44 * MIN), 0.5);
  assert.equal(roundHalf(45 * MIN), 1);
  assert.equal(roundHalf(4 * HOUR + 44 * MIN), 4.5);
  assert.equal(roundHalf(0), 0);
});

test("fmtHM truncates to whole minutes", () => {
  assert.equal(fmtHM(59 * 1e3), "0:00");
  assert.equal(fmtHM(61 * MIN + 59e3), "1:01");
});

test("a session across midnight is split between the two days", () => {
  const st = day([["a", "Acme"]], [["s", "a", at("2026-10-14", "22:00"), at("2026-10-15", "01:30")]]);
  assert.equal(totalsFor(st, "2026-10-14", 0).get("a"), 2 * HOUR);
  assert.equal(totalsFor(st, "2026-10-15", 0).get("a"), 1.5 * HOUR);
});

test("day bounds follow DST: the fall-back day is 25 hours, the spring-forward day 23", () => {
  const [a, b] = dayBounds("2026-11-01");
  assert.equal(b - a, 25 * HOUR);
  const [c, d] = dayBounds("2026-03-08");
  assert.equal(d - c, 23 * HOUR);
  assert.equal(shiftDay("2026-11-01", 1), "2026-11-02");
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
});

test("a shift spanning the DST fall-back counts real elapsed time", () => {
  // 00:30 to 03:30 on fall-back night is four real hours.
  const st = day([["a", "Acme"]], [["s", "a", at("2026-11-01", "00:30"), at("2026-11-01", "03:30")]]);
  assert.equal(totalsFor(st, "2026-11-01", 0).get("a"), 4 * HOUR);
});

test("a running session counts up to now", () => {
  const start = at("2026-10-15", "09:00");
  const st = day([["a", "Acme"]], [["s", "a", start, null]]);
  assert.equal(totalsFor(st, "2026-10-15", start + 20 * MIN).get("a"), 20 * MIN);
});

test("summary rounds per client and totals the rounded figures", () => {
  const k = "2026-10-15";
  const st = day(
    [["a", "Acme"], ["b", "Northwind"]],
    [["1", "a", at(k, "08:00"), at(k, "10:10")], ["2", "b", at(k, "10:15"), at(k, "10:35")]],
  );
  const rows = summaryRows(st, k, 0);
  assert.deepEqual(rows.map((r) => [r.client.name, r.hours]), [["Acme", 2], ["Northwind", 0.5]]);
  const text = summaryText(st, k, 0);
  assert.match(text, /Acme: 2\.0 h/);
  assert.match(text, /Northwind: 0\.5 h/);
  assert.match(text, /Total: 2\.5 h/);
  assert.equal(csvFor(st, k, 0).split("\r\n")[1], `${k},"Acme","","",2.17,2.0`);
});

test("CSV neutralises names a spreadsheet would run as a formula", () => {
  const k = "2026-10-15";
  const st = day([["a", "=HYPERLINK(1)"], ["b", "+1"], ["c", "-x"], ["d", "@SUM"]],
    ["a", "b", "c", "d"].map((c, i) => [String(i), c, at(k, "08:00"), at(k, "09:00")]));
  const names = csvFor(st, k, 0).trim().split("\r\n").slice(1).map((l) => l.split(",")[1]);
  assert.equal(names.length, 4);
  assert.deepEqual(names, [`"'=HYPERLINK(1)"`, `"'+1"`, `"'-x"`, `"'@SUM"`]);
});

test("an end time at or before the start is the next calendar day, DST included", () => {
  assert.equal(endAfter(at("2026-10-15", "22:00"), "01:30"), at("2026-10-16", "01:30"));
  assert.equal(endAfter(at("2026-10-15", "09:00"), "17:00"), at("2026-10-15", "17:00"));
  // 23:00 on spring-forward eve to 05:00 is six wall-clock hours but five real ones.
  assert.equal(endAfter(at("2026-03-07", "23:00"), "05:00") - at("2026-03-07", "23:00"), 5 * HOUR);
  assert.equal(endAfter(at("2026-10-31", "23:00"), "05:00") - at("2026-10-31", "23:00"), 7 * HOUR);
});

test("old tombstones are pruned, recent ones and live records kept", () => {
  const now = Date.UTC(2026, 9, 15);
  const st = normalise({
    clients: [{ id: "a", name: "A", archived: false, updated: 1 }],
    sessions: [{ id: "old", deleted: true, updated: now - 200 * 24 * HOUR }, { id: "new", deleted: true, updated: now - HOUR },
      { id: "s", clientId: "a", start: 0, end: 1, updated: 1 }],
  });
  assert.deepEqual(pruneTombstones(st, now).sessions.map((s) => s.id), ["new", "s"]);
});

test("merge collapses same-named clients into the oldest one", () => {
  const a = day([["a1", "Acme"]], [["1", "a1", 0, 10]]);
  const b = day([["b1", "acme"]], [["2", "b1", 20, 30]]);
  const m = merge(a, b);
  assert.deepEqual(m.clients.filter((c) => !c.deleted).map((c) => c.id), ["a1"]);
  assert.deepEqual(existingSessions(m).map((s) => s.clientId), ["a1", "a1"]);
  assert.ok(sameData(m, merge(b, a)));
  assert.ok(sameData(merge(m, a), m), "merging again is stable");
});

test("CSV quotes client names that contain quotes and commas", () => {
  const k = "2026-10-15";
  const st = day([["a", 'Smith, "Jr" & Co']], [["1", "a", at(k, "08:00"), at(k, "09:00")]]);
  assert.equal(csvFor(st, k, 0).split("\r\n")[1], `${k},"Smith, ""Jr"" & Co","","",1.00,1.0`);
});

test("normalise reads the first version's jobs/jobId shape and drops junk", () => {
  const st = normalise({
    jobs: [{ id: "j1", name: "Old job", code: "24-118" }, { id: 7, name: "bad id" }, null],
    sessions: [
      { id: "s1", jobId: "j1", start: 1000, end: 2000 },
      { id: "s2", jobId: "j1", start: 3000, end: 1000 }, // stopped on a device with a slow clock
      { id: "s3", jobId: "j1", start: "noon", end: null },
    ],
  });
  assert.deepEqual(st.clients, [{ id: "j1", name: "Old job", archived: false, category: "", note: "", updated: 0 }]);
  assert.deepEqual(st.sessions, [
    { id: "s1", clientId: "j1", start: 1000, end: 2000, category: "", note: "", updated: 0 },
    { id: "s2", clientId: "j1", start: 3000, end: 3000, category: "", note: "", updated: 0 }, // kept, clamped to zero length
  ]);
});

test("normalise is canonical: equal data serialises identically", () => {
  const a = { clients: [{ updated: 1, archived: false, name: "B", id: "b" }, { id: "a", name: "A", archived: false, updated: 1 }] };
  const b = { clients: [{ id: "a", name: "A", archived: false, updated: 1 }, { id: "b", name: "B", archived: false, updated: 1 }] };
  assert.equal(JSON.stringify(normalise(a)), JSON.stringify(normalise(b)));
});

test("merge keeps the newest version of each record", () => {
  const a = day([["a", "Acme", { updated: 5 }]], [["s", "a", 0, 100, 5]]);
  const b = day([["a", "Acme Corp", { updated: 9 }]], [["s", "a", 0, 50, 2]]);
  const m = merge(a, b);
  assert.equal(m.clients[0].name, "Acme Corp");
  assert.equal(m.sessions[0].end, 100);
});

test("merge applies a newer deletion and ignores an older one", () => {
  const a = day([["a", "Acme"]], [["s", "a", 0, 100, 5]]);
  const b = normalise({ ...a, sessions: [{ id: "s", deleted: true, updated: 9 }] });
  assert.equal(existingSessions(merge(a, b)).length, 0);
  const stale = normalise({ ...a, sessions: [{ id: "s", deleted: true, updated: 1 }] });
  assert.equal(existingSessions(merge(a, stale)).length, 1);
});

test("merge is commutative, so two devices converge on the same state", () => {
  const a = day([["a", "Acme", { updated: 3 }], ["b", "Beta"]], [["1", "a", 0, 10, 4], ["2", "b", 20, 30, 7]]);
  const b = day([["a", "Acme Ltd", { updated: 3 }], ["c", "Gamma"]], [["1", "a", 0, 15, 4], ["3", "c", 40, null, 8]]);
  assert.ok(sameData(merge(a, b), merge(b, a)));
  assert.ok(sameData(merge(merge(a, b), b), merge(a, b)), "merging again changes nothing");
});

test("timers started on two devices while apart settle to the later one", () => {
  const a = day([["a", "Acme"], ["b", "Beta"]], [["1", "a", 1000, null, 1000]]);
  const b = day([["a", "Acme"], ["b", "Beta"]], [["2", "b", 5000, null, 5000]]);
  const m = merge(a, b);
  const running = existingSessions(m).filter((s) => s.end === null);
  assert.deepEqual(running.map((s) => s.id), ["2"]);
  assert.equal(existingSessions(m).find((s) => s.id === "1").end, 5000);
  assert.ok(sameData(m, merge(b, a)));
});

test("settleRunning leaves overlapping timers alone when overlap is allowed", () => {
  const st = day([["a", "A"], ["b", "B"]], [["1", "a", 1000, null], ["2", "b", 5000, null]], { allowOverlap: true });
  assert.equal(existingSessions(settleRunning(st)).filter((s) => s.end === null).length, 2);
});

test("sessions of a deleted client are hidden", () => {
  const st = normalise({
    clients: [{ id: "a", deleted: true, updated: 2 }],
    sessions: [{ id: "s", clientId: "a", start: 0, end: 10, updated: 1 }],
  });
  assert.equal(existingSessions(st).length, 0);
});

test("dayKey uses the local calendar day", () => {
  assert.equal(dayKey(at("2026-10-15", "23:59")), "2026-10-15");
  assert.equal(dayKey(at("2026-10-16", "00:00")), "2026-10-16");
});

/* ---------- categories and notes ---------- */

const ids = () => { let n = 0; return () => `id${n++}`; };

test("a note without a category, or an unknown category, is dropped", () => {
  const st = normalise({
    clients: [{ id: "a", name: "A", category: "", note: "orphan" }, { id: "b", name: "B", category: "p9", note: "x" }],
    sessions: [{ id: "s", clientId: "a", start: 0, end: 1, category: "gaps", note: "  Site walk  " }],
  });
  assert.deepEqual(st.clients.map((c) => [c.category, c.note]), [["", ""], ["", ""]]);
  assert.deepEqual([st.sessions[0].category, st.sessions[0].note], ["gaps", "Site walk"]);
});

test("starting a timer tags it with the card's current category and note", () => {
  let st = day([["a", "Acme", { category: "p3", note: "Framing review" }]], []);
  st = toggleTimer(st, "a", 1000, ids());
  assert.deepEqual(existingSessions(st).map((s) => [s.category, s.note, s.end]), [["p3", "Framing review", null]]);
  st = toggleTimer(st, "a", 5000, ids());
  assert.equal(existingSessions(st)[0].end, 5000);
});

test("changing the tag on a running timer splits it at that moment", () => {
  const make = ids();
  let st = toggleTimer(day([["a", "Acme", { category: "p3" }]], []), "a", 0, make);
  st = retagClient(st, "a", "gaps", "", 30 * MIN, make);
  const parts = existingSessions(st).sort((x, y) => x.start - y.start);
  assert.deepEqual(parts.map((s) => [s.category, s.start, s.end]), [["p3", 0, 30 * MIN], ["gaps", 30 * MIN, null]]);
  assert.equal(st.clients[0].category, "gaps");
});

test("a tag change within the first minute relabels instead of splitting", () => {
  const make = ids();
  let st = toggleTimer(day([["a", "Acme"]], []), "a", 0, make);
  st = retagClient(st, "a", "p1", "Kickoff", 20e3, make);
  assert.deepEqual(existingSessions(st).map((s) => [s.category, s.note, s.end]), [["p1", "Kickoff", null]]);
});

test("changing the tag with no timer running only changes the card", () => {
  const st = retagClient(day([["a", "Acme"]], [["1", "a", 0, 10]]), "a", "tech", "Server move", 99, ids());
  assert.deepEqual([st.clients[0].category, st.clients[0].note], ["tech", "Server move"]);
  assert.equal(existingSessions(st)[0].category, "");
});

test("a past entry can be retagged", () => {
  const st = retagSession(day([["a", "Acme"]], [["1", "a", 0, 10]]), "1", "pm", "Weekly call", 50);
  assert.deepEqual([st.sessions[0].category, st.sessions[0].note, st.sessions[0].updated], ["pm", "Weekly call", 50]);
});

test("summary rounds each category + note line, and the client total sums the lines", () => {
  const k = "2026-10-15";
  const st = normalise({
    clients: [{ id: "a", name: "Acme", updated: 1 }, { id: "b", name: "Beta", updated: 1 }],
    sessions: [
      { id: "1", clientId: "a", start: at(k, "08:00"), end: at(k, "09:00"), category: "p3", note: "Framing review", updated: 1 },
      { id: "2", clientId: "a", start: at(k, "13:00"), end: at(k, "13:50"), category: "p3", note: "framing REVIEW", updated: 1 },
      { id: "3", clientId: "a", start: at(k, "10:00"), end: at(k, "11:20"), category: "gaps", note: "", updated: 1 },
      { id: "4", clientId: "a", start: at(k, "11:30"), end: at(k, "11:40"), updated: 1 },
      { id: "5", clientId: "b", start: at(k, "14:00"), end: at(k, "15:00"), updated: 1 },
    ],
  });
  const [acme, beta] = summaryRows(st, k, 0);
  assert.deepEqual(acme.lines.map((l) => [l.label, fmtHM(l.ms), l.hours]),
    [["P3 · Framing review", "1:50", 2], ["Gaps", "1:20", 1.5], ["No category", "0:10", 0]]);
  assert.equal(acme.hours, 3.5);
  assert.equal(acme.detailed, true);
  assert.equal(beta.detailed, false);

  const text = summaryText(st, k, 0);
  assert.match(text, /Acme: 3\.5 h\n  P3 · Framing review: 2\.0 h\n  Gaps: 1\.5 h\n  No category: 0\.0 h\nBeta: 1\.0 h\n/);
  assert.match(text, /Total: 4\.5 h/);

  const csv = csvFor(st, k, 0).trim().split("\r\n");
  assert.equal(csv[0], "date,client,category,note,tracked_hours,hours");
  assert.equal(csv[1], `${k},"Acme","P3","Framing review",1.83,2.0`);
  assert.equal(csv.length, 5);
});

test("note suggestions are per category, shared across clients, most recent first", () => {
  const st = normalise({
    clients: [{ id: "a", name: "Acme", category: "p3", note: "Punch list", updated: 50 }, { id: "b", name: "Beta", updated: 1 }],
    sessions: [
      { id: "1", clientId: "a", start: 10, end: 11, category: "p3", note: "Framing review", updated: 1 },
      { id: "2", clientId: "b", start: 30, end: 31, category: "p3", note: "Drywall", updated: 1 },
      { id: "3", clientId: "b", start: 40, end: 41, category: "p3", note: "framing review", updated: 1 },
      { id: "4", clientId: "a", start: 60, end: 61, category: "gaps", note: "Not P3", updated: 1 },
    ],
  });
  assert.deepEqual(noteSuggestions(st, "p3"), ["Punch list", "framing review", "Drywall"]);
  assert.deepEqual(noteSuggestions(st, "tech"), []);
  assert.deepEqual(noteSuggestions(st, ""), []);
});
