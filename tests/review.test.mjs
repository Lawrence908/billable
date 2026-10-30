// Run with: npm test (which sets TZ=America/Los_Angeles).
import { test } from "node:test";
import assert from "node:assert/strict";
import { atTime, normalise } from "../src/js/model.js";
import {
  addHoursFile, addOfficialClient, addOfficialTask, blankReview, costingLabel, setTaskAlias, clientName, clientTSV, compile, daysBetween, decodeLists, detailCSV, encodeLists, handoffText,
  hoursFile, hoursFileName, normaliseLists, normaliseReview, parseHoursFile, parseList, phaseLabel, removePerson, setAlias,
  setReviewed, reviewedFor, tasksFor, totalsCSV, weekStart,
} from "../src/js/review-model.js";

const MIN = 60e3;
const at = (key, hhmm) => atTime(key, hhmm);

// A person's state: clients by name, and entries as [client, day, start, end, category, note].
function person(employee, entries) {
  const names = [...new Set(entries.map((e) => e[0]))];
  return normalise({
    clients: names.map((name, i) => ({ id: `c${i}`, name, archived: false, updated: 1 })),
    sessions: entries.map(([name, key, s, e, category = "", note = ""], i) => ({
      id: `s${i}`, clientId: `c${names.indexOf(name)}`, start: at(key, s), end: e === null ? null : at(key, e), category, note, updated: 1,
    })),
    settings: { employee, updated: 1 },
  });
}

const file = (st, from, to, now = at("2026-10-31", "12:00")) => parseHoursFile(JSON.stringify(hoursFile(st, from, to, now)));

test("dates: week start is Monday, and daysBetween is inclusive", () => {
  assert.equal(weekStart("2026-10-29"), "2026-10-26"); // a Thursday
  assert.equal(weekStart("2026-10-26"), "2026-10-26");
  assert.equal(weekStart("2026-11-01"), "2026-10-26"); // a Sunday
  assert.deepEqual(daysBetween("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
});

test("an hours file carries each day's rounded lines, as that day's summary shows them", () => {
  const st = person("Alex Doe", [
    ["Acme", "2026-10-26", "09:00", "09:08", "p2", "AR replication"],
    ["Acme", "2026-10-26", "10:00", "10:08", "p2", "AR replication"],
    ["Acme", "2026-10-26", "11:00", "11:08", "p2", "AR replication"],
    ["Acme", "2026-10-27", "09:00", "10:00", "pm", ""],
    ["Acme", "2026-10-20", "09:00", "10:00"], // outside the range
  ]);
  const f = hoursFile(st, "2026-10-26", "2026-10-30", at("2026-10-31", "12:00"));
  assert.equal(f.employee, "Alex Doe");
  assert.equal(f.running, false);
  assert.deepEqual(f.lines.map((l) => [l.date, l.client, l.category, l.note, l.hours]), [
    ["2026-10-26", "Acme", "p2", "AR replication", 0.5], // 24 minutes, rounded once
    ["2026-10-27", "Acme", "pm", "", 1],
  ]);
  assert.equal(hoursFileName(f), "billable-hours-Alex-Doe-2026-10-26-to-2026-10-30.json");
  assert.throws(() => hoursFile(st, "2026-10-30", "2026-10-26", 0), /start date/);
});

test("an hours file notes a timer still running in its range", () => {
  const st = person("Alex", [["Acme", "2026-10-29", "09:00", null]]);
  assert.equal(hoursFile(st, "2026-10-26", "2026-10-30", at("2026-10-29", "11:00")).running, true);
  assert.equal(hoursFile(st, "2026-10-19", "2026-10-23", at("2026-10-29", "11:00")).running, false);
});

test("parsing an hours file rejects junk and recomputes hours from the time", () => {
  assert.throws(() => parseHoursFile("{"), /not a Billable hours file/);
  assert.throws(() => parseHoursFile({ kind: "something-else" }), /not a Billable hours file/);
  assert.throws(() => parseHoursFile({ kind: "billable-hours", v: 1, employee: " ", from: "2026-10-26", to: "2026-10-30", lines: [] }), /no name/);
  assert.throws(() => parseHoursFile({ kind: "billable-hours", v: 1, employee: "A", from: "2026-10-30", to: "2026-10-26", lines: [] }), /dates/);
  const f = parseHoursFile({
    kind: "billable-hours", v: 1, employee: "A", from: "2026-10-26", to: "2026-10-30",
    lines: [
      { date: "2026-10-26", client: "Acme", category: "p2", note: "x", ms: 60 * MIN, hours: 99 }, // claims 99 h
      { date: "2026-10-26", client: "Acme", category: "bogus", note: "dropped note", ms: 30 * MIN },
      { date: "2026-11-05", client: "Acme", category: "", ms: 30 * MIN }, // outside the file's dates
      { date: "2026-10-27", client: "", ms: 30 * MIN }, // no client
      { date: "2026-10-27", client: "Acme", ms: -5 }, // negative
    ],
  });
  assert.deepEqual(f.lines.map((l) => [l.client, l.category, l.note, l.hours]), [["Acme", "p2", "x", 1], ["Acme", "", "", 0.5]]);
});

test("a newer file for the same dates replaces that person's lines; other dates are kept", () => {
  const week1 = person("Alex", [["Acme", "2026-10-20", "09:00", "10:00"]]);
  const week2 = person("Alex", [["Acme", "2026-10-27", "09:00", "10:00"]]);
  const fixed = person("Alex", [["Acme", "2026-10-27", "09:00", "11:00"]]);
  let r = blankReview();
  r = addHoursFile(r, file(week1, "2026-10-19", "2026-10-23"), 1);
  r = addHoursFile(r, file(week2, "2026-10-26", "2026-10-30"), 2);
  r = addHoursFile(r, file(fixed, "2026-10-26", "2026-10-30"), 3);
  const alex = r.people.alex;
  assert.deepEqual(alex.lines.map((l) => [l.date, l.hours]).sort(), [["2026-10-20", 1], ["2026-10-27", 2]]);
  assert.deepEqual(alex.files.map((f) => f.from), ["2026-10-19", "2026-10-26"]);
  assert.deepEqual(Object.keys(removePerson(r, "ALEX").people), []);
});

test("compile adds up each person's rounded lines, by client and by task", () => {
  const alex = person("Alex", [
    ["Acme", "2026-10-26", "09:00", "09:08", "p2", "AR replication"],
    ["Acme", "2026-10-27", "09:00", "09:08", "p2", "ar replication"], // same task, other casing
    ["Beta", "2026-10-27", "10:00", "11:00", "pm", "Weekly call"],
  ]);
  const sam = person("Sam", [["Acme", "2026-10-26", "13:00", "14:30", "p2", "AR replication"]]);
  let r = blankReview();
  r = addHoursFile(r, file(alex, "2026-10-26", "2026-10-30"), 1);
  r = addHoursFile(r, file(sam, "2026-10-26", "2026-10-30"), 1);
  const c = compile(r, "2026-10-26", "2026-10-30");
  assert.equal(c.hours, 0.25 + 0.25 + 1 + 1.5);
  assert.deepEqual(c.clients.map((x) => [x.name, x.hours, x.people]), [["Acme", 2, ["Alex", "Sam"]], ["Beta", 1, ["Alex"]]]);
  assert.deepEqual(c.clients[0].lines.map((l) => [l.label, l.hours, l.people.map((p) => `${p.employee}=${p.hours}`)]), [
    ["P2 · AR replication", 2, ["Alex=0.5", "Sam=1.5"]],
  ]);
  assert.deepEqual(c.people.map((p) => [p.employee, p.hours]), [["Alex", 1.5], ["Sam", 1.5]]);
  assert.deepEqual(c.categories.map((x) => [x.label, x.hours]), [["P2", 2], ["Project Management", 1]]);
  // A period that excludes Tuesday.
  assert.equal(compile(r, "2026-10-26", "2026-10-26").hours, 1.75);
});

test("official lists: names are checked, aliases fix spellings, tasks outside the list are flagged", () => {
  const alex = person("Alex", [
    ["Coastal Interiors", "2026-10-26", "09:00", "10:00", "p2", "Data import"],
    ["coastal interiors ltd.", "2026-10-26", "10:00", "11:00", "p2", "Something new"],
    ["Unknown Co", "2026-10-26", "11:00", "11:30"],
  ]);
  let r = blankReview();
  r.lists = normaliseLists({ clients: ["Coastal Interiors Ltd."], phases: { p2: "Data conversion" }, tasks: { p2: ["Data import"], "*": ["Meeting"] } });
  r = addHoursFile(r, file(alex, "2026-10-26", "2026-10-30"), 1);

  let c = compile(r, "2026-10-26", "2026-10-30");
  assert.deepEqual(c.checks.unknownClients.map((x) => [x.name, x.hours]), [["Coastal Interiors", 1], ["Unknown Co", 0.5]]);
  assert.deepEqual(c.checks.otherTasks.map((x) => [x.label, x.note]), [["P2 · Data conversion", "Something new"]]);
  assert.deepEqual(c.checks.noCategory.map((x) => [x.employee, x.client, x.hours]), [["Alex", "Unknown Co", 0.5]]);
  // The differently-cased official name is matched without an alias.
  assert.ok(c.clients.some((x) => x.name === "Coastal Interiors Ltd." && x.official));

  r = setAlias(r, "COASTAL INTERIORS", "Coastal Interiors Ltd.");
  assert.equal(clientName(r, "coastal interiors"), "Coastal Interiors Ltd.");
  c = compile(r, "2026-10-26", "2026-10-30");
  assert.deepEqual(c.checks.unknownClients.map((x) => x.name), ["Unknown Co"]);
  assert.equal(c.clients.find((x) => x.name === "Coastal Interiors Ltd.").hours, 2);
  assert.deepEqual(tasksFor(r.lists, "p2"), ["Data import", "Meeting"]);
  assert.deepEqual(tasksFor(r.lists, "pm"), ["Meeting"]);
  // Shared tasks alone don't flag the notes of a category with no list of its own.
  const pm = addHoursFile(r, file(person("Sam", [["Coastal Interiors Ltd.", "2026-10-27", "09:00", "10:00", "pm", "Kickoff call"]]), "2026-10-26", "2026-10-30"), 1);
  assert.equal(compile(pm, "2026-10-26", "2026-10-30").checks.otherTasks.length, 1); // still only Alex's p2 one
  assert.equal(phaseLabel(r.lists, "p3"), "P3");
});

test("missing weekdays and running timers are reported per person", () => {
  const alex = person("Alex", [["Acme", "2026-10-27", "09:00", null]]);
  let r = blankReview();
  r = addHoursFile(r, parseHoursFile(hoursFile(alex, "2026-10-26", "2026-10-28", at("2026-10-27", "10:00"))), 1);
  const c = compile(r, "2026-10-26", "2026-11-01");
  assert.deepEqual(c.checks.missingDays, [{ employee: "Alex", days: ["2026-10-29", "2026-10-30"] }]); // weekend ignored
  assert.deepEqual(c.checks.running, ["Alex"]);
});

test("hand-off files: five-column rows per client, CSVs with formulas neutralised", () => {
  const alex = person("Alex", [
    ["=HYPERLINK(1)", "2026-10-26", "09:00", "10:00", "p2", "+evil"],
    ["Acme", "2026-10-27", "09:00", "09:05"], // rounds to 0, left out
  ]);
  let r = addHoursFile(blankReview(), file(alex, "2026-10-26", "2026-10-30"), 1);
  const c = compile(r, "2026-10-26", "2026-10-30");
  assert.equal(clientTSV(c, "=HYPERLINK(1)"), "10/26/2026\tAlex\tP2\t'+evil\t1.00");
  assert.equal(clientTSV(c, "Acme"), "");
  const detail = detailCSV(c).split("\r\n");
  assert.equal(detail.length, 3); // header, one row, trailing empty
  assert.match(detail[1], /^2026-10-26,"Alex","'=HYPERLINK\(1\)","P2","'\+evil",1\.00,1\.00,/);
  assert.equal(totalsCSV(c).split("\r\n")[1], `"'=HYPERLINK(1)","P2","'+evil",1.00`);
  assert.match(handoffText(c, r.lists), /=HYPERLINK\(1\): 1\.00 h\n {2}P2 · \+evil: 1\.00 h/);
});

test("reviewed ticks are kept per period", () => {
  let r = setReviewed(blankReview(), "2026-10-26", "2026-10-30", "Acme", true);
  assert.deepEqual(reviewedFor(r, "2026-10-26", "2026-10-30"), { Acme: true });
  assert.deepEqual(reviewedFor(r, "2026-10-19", "2026-10-23"), {});
  r = setReviewed(r, "2026-10-26", "2026-10-30", "Acme", false);
  assert.deepEqual(reviewedFor(r, "2026-10-26", "2026-10-30"), {});
});

test("lists: one name per line, round trip through a link, junk dropped", async () => {
  assert.deepEqual(parseList(" Acme \n\nacme\nBeta\r\n"), ["Acme", "Beta"]);
  const lists = normaliseLists({
    clients: ["Acme", "Beta"], phases: { p2: "Data conversion", pm: "PROJECT MANAGEMENT", bogus: "x" }, tasks: { p2: ["Import"], bogus: ["x"], "*": ["Meeting"] }, by: "Chris", updated: 5,
  });
  assert.deepEqual(lists, { clients: ["Acme", "Beta"], phases: { p2: "Data conversion", pm: "PROJECT MANAGEMENT" }, tasks: { p2: ["Import"], "*": ["Meeting"] }, by: "Chris", updated: 5 });
  const link = await encodeLists(lists, "https://billable.example");
  assert.match(link, /^https:\/\/billable\.example\/#lists=z/);
  assert.deepEqual(await decodeLists(link), lists);
  await assert.rejects(decodeLists("https://billable.example/#import=zAAA"), /not a lists link/);
});

test("a saved review store survives a round trip and drops damage", () => {
  const alex = person("Alex", [["Acme", "2026-10-26", "09:00", "10:00"]]);
  let r = addHoursFile(blankReview(), file(alex, "2026-10-26", "2026-10-30"), 1);
  r = setAlias(r, "acme inc", "Acme");
  r.period = { from: "2026-10-26", to: "2026-10-30" };
  const back = normaliseReview(JSON.parse(JSON.stringify(r)));
  assert.deepEqual(back, normaliseReview(r));
  assert.equal(back.people.alex.lines.length, 1);
  assert.deepEqual(normaliseReview({ people: { x: { employee: "", lines: [] } }, aliases: { a: "" } }).people, {});
  assert.deepEqual(normaliseReview(null), blankReview());
});

test("category names: no doubled phase code on screen, and the exact text for the Costing section", () => {
  const lists = normaliseLists({ phases: {
    p1: "PHASE 1: DATA LISTINGS/FORM CUSTOMIZATION (a name longer than forty characters)", p2: "Contract/Billings", p3: "P3 - Setup", pm: "PROJECT MANAGEMENT",
  } });
  assert.equal(phaseLabel(lists, "p1"), "PHASE 1: DATA LISTINGS/FORM CUSTOMIZATION (a name longer than forty characters)");
  assert.equal(phaseLabel(lists, "p2"), "P2 · Contract/Billings");
  assert.equal(phaseLabel(lists, "p3"), "P3 - Setup");
  assert.equal(phaseLabel(lists, "pm"), "PROJECT MANAGEMENT");
  assert.equal(phaseLabel(lists, "p4"), "P4");
  assert.equal(costingLabel(lists, "p2"), "Contract/Billings");
  assert.equal(costingLabel(lists, "p4"), "P4");
});

test("tasks: mapping counts a typed task as an official one; the hand-off keeps both", () => {
  const alex = person("Alex", [
    ["Acme", "2026-10-26", "09:00", "10:00", "p2", "AR Replication and Verification"],
    ["Acme", "2026-10-27", "09:00", "10:00", "p2", "AR Replication"],
  ]);
  let r = blankReview();
  r.lists = normaliseLists({ phases: { p2: "PHASE 2: CONTRACT/BILLINGS" }, tasks: { p2: ["AR replication"] } });
  r = addHoursFile(r, file(alex, "2026-10-26", "2026-10-30"), 1);
  let c = compile(r, "2026-10-26", "2026-10-30");
  assert.deepEqual(c.checks.otherTasks.map((t) => [t.label, t.note, t.tasks]), [["PHASE 2: CONTRACT/BILLINGS", "AR Replication and Verification", ["AR replication"]]]);

  r = setTaskAlias(r, "p2", "ar replication AND verification", "AR replication");
  c = compile(r, "2026-10-26", "2026-10-30");
  assert.deepEqual(c.checks.otherTasks, []);
  assert.deepEqual(c.clients[0].lines.map((l) => [l.label, l.hours]), [["PHASE 2: CONTRACT/BILLINGS · AR replication", 2]]);
  assert.equal(clientTSV(c, "Acme"), "10/26/2026\tAlex\tPHASE 2: CONTRACT/BILLINGS\tAR replication\t1.00\n10/27/2026\tAlex\tPHASE 2: CONTRACT/BILLINGS\tAR replication\t1.00");
  assert.match(detailCSV(c).split("\r\n")[1], /,"PHASE 2: CONTRACT\/BILLINGS","AR replication",1\.00,1\.00,"Acme",yes,"AR Replication and Verification"$/);
  assert.equal(totalsCSV(c).split("\r\n")[1], `"Acme","PHASE 2: CONTRACT/BILLINGS","AR replication",2.00`);

  // Undone, the check comes back; the mapping survives a save and load.
  assert.equal(compile(setTaskAlias(r, "p2", "AR Replication and Verification", ""), "2026-10-26", "2026-10-30").checks.otherTasks.length, 1);
  assert.deepEqual(normaliseReview(JSON.parse(JSON.stringify(r))).taskAliases, r.taskAliases);
});

test("adding to the lists from a check clears it", () => {
  const alex = person("Alex", [["PLEXXIS", "2026-10-26", "09:00", "10:00", "internal", "Manuals Update"]]);
  let r = blankReview();
  r.lists = normaliseLists({ clients: ["Tradition Homes"], tasks: { internal: ["Training"] } });
  r = addHoursFile(r, file(alex, "2026-10-26", "2026-10-30"), 1);
  let c = compile(r, "2026-10-26", "2026-10-30");
  assert.equal(c.checks.unknownClients.length, 1);
  assert.equal(c.checks.otherTasks.length, 1);
  r = addOfficialTask(addOfficialClient(r, "PLEXXIS", 7), "internal", "Manuals Update", 7);
  c = compile(r, "2026-10-26", "2026-10-30");
  assert.deepEqual([c.checks.unknownClients, c.checks.otherTasks], [[], []]);
  assert.deepEqual(r.lists.clients, ["Tradition Homes", "PLEXXIS"]);
  assert.deepEqual(r.lists.tasks.internal, ["Training", "Manuals Update"]);
  assert.equal(r.lists.updated, 7);
});
