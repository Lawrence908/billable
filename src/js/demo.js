// Made-up hours for the public demo site. Only demo builds include this file
// and demo-ui.js, which loads it; the Dockerfile deletes both from the real
// build. Pure, so it runs under `node --test`.
//
// The business is invented: Juniper Labs, a small software company, sets up
// its product for client companies in phases (P0 Kickoff to P8 Support).
// Alex Demo is the visitor; four colleagues send the reviewer their hours too.
//
// Everything is generated relative to `now`, so the demo always shows the last
// few weeks, from a seed per person and day, so a day always gets the same
// made-up hours however often the demo is reset.

import { dayBounds, dayKey, newId, normalise, shiftDay } from "./model.js";
import { addHoursFile, blankReview, compile, hoursFile, normaliseLists, normaliseReview, parseHoursFile, setReviewed, weekStart } from "./review-model.js";

export const DEMO_EMPLOYEE = "Alex Demo";
export const COMPANY = "Juniper Labs";
export const WEEKS = 3; // full weeks of history before this one

// Each client's phase by week: three weeks ago, two, last week, this week.
// null means no work that week; Bluefin went live and was removed from the list.
const PHASES = {
  "Northwind Logistics": ["p3", "p4", "p5", "p5"],
  "Copperleaf Bakery Co.": ["p1", "p2", "p2", "p3"],
  "Orbit Fitness Studios": ["p0", "p1", "p1", "p2"],
  "Tidewater Brewing": ["p5", "p6", "p7", "p8"],
  "Bluefin Dental Group": ["p7", "p8", null, null],
  "Maple Street Realty": ["p2", "p3", "p4", "p4"],
};

// Live customers, who only come back for change orders. Numbers restart per
// customer, and Tidewater, still being implemented, has one too.
const HARBOR = "Harbor Point Hotels";
const REDWOOD = "Redwood Pharmacy";
const SUNRISE = "Sunrise Vet Clinic";
const TIDEWATER = "Tidewater Brewing";

export const DEMO_LISTS = normaliseLists({
  by: "Demo reviewer",
  clients: [COMPANY, ...Object.keys(PHASES)],
  customers: [HARBOR, REDWOOD, SUNRISE],
  orders: [
    { customer: HARBOR, number: "CO-0001" },
    { customer: HARBOR, number: "CO-0002" },
    { customer: REDWOOD, number: "CO-0001" },
    { customer: SUNRISE, number: "CO-0001", retired: true },
    { customer: SUNRISE, number: "CO-0002" },
    { customer: TIDEWATER, number: "CO-0001" },
  ],
  phases: {
    p0: "Kickoff", p1: "Discovery", p2: "Data migration", p3: "Configuration", p4: "Integrations",
    p5: "Training", p6: "Testing", p7: "Go-live", p8: "Support",
  },
  tasks: {
    p0: ["Kickoff meeting", "Project plan"],
    p1: ["Requirements workshop", "Process review"],
    p2: ["Data mapping", "Import cleanup", "Test import"],
    p3: ["Workflow setup", "User roles", "Report setup"],
    p4: ["Accounting sync", "API setup"],
    p5: ["Admin training", "End-user training", "Training notes"],
    p6: ["Test scripts", "Issue triage"],
    p7: ["Cutover", "Go-live support"],
    p8: ["Support tickets", "Health check"],
    pm: ["Status meeting", "Scheduling", "Status report"],
    tech: ["Bug investigation", "Environment setup"],
    change: ["Custom report", "Data fix", "Extra training"],
    internal: ["Team meeting", "Admin", "Product training"],
    "*": ["Email"],
  },
});

// Who works on what. `as` is how a person types a client's name, and `notes`
// swaps a category's official tasks for their own wording: both are planted
// mistakes for the review page's Checks to find. `orders` are the change orders
// they work on, as [customer, number].
const PEOPLE = [
  {
    employee: DEMO_EMPLOYEE,
    clients: { "Northwind Logistics": 3, "Copperleaf Bakery Co.": 3, "Orbit Fitness Studios": 2, "Tidewater Brewing": 2, "Bluefin Dental Group": 2 },
    orders: [[HARBOR, "CO-0001"], [TIDEWATER, "CO-0001"]],
  },
  {
    employee: "Sam Patel",
    clients: { "Northwind Logistics": 3, "Maple Street Realty": 2, "Tidewater Brewing": 1 },
    notes: { p5: ["Onsite training"] },
    orders: [[HARBOR, "CO-0002"], [REDWOOD, "CO-0001"]],
    running: true, // saved last week's file with a timer still going
  },
  {
    employee: "Jordan Lee",
    clients: { "Northwind Logistics": 2, "Orbit Fitness Studios": 3, "Copperleaf Bakery Co.": 1 },
    as: { "Northwind Logistics": "Northwind Logistic" },
    orders: [[REDWOOD, "CO-0001"]],
    typedOrder: true, // typed a change order number that isn't on the list, last Wednesday
  },
  {
    employee: "Priya Shah",
    clients: { "Maple Street Realty": 3, "Copperleaf Bakery Co.": 2, "Bluefin Dental Group": 1 },
    orders: [[SUNRISE, "CO-0002"]],
    untagged: true, // forgot to pick a category one afternoon last week
  },
  {
    employee: "Morgan Chen",
    clients: { "Tidewater Brewing": 3, "Orbit Fitness Studios": 2, "Maple Street Realty": 1 },
    orders: [[SUNRISE, "CO-0002"], [TIDEWATER, "CO-0001"]],
    dayOff: true, // off last Friday, so last week's file stops on Thursday
  },
];

/* ---------- seeded randomness ---------- */

// mulberry32, seeded by an FNV-1a hash of the text.
function rng(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, list) => list[Math.floor(r() * list.length)];

function weighted(r, entries) {
  let roll = r() * entries.reduce((a, [, w]) => a + w, 0);
  for (const [item, w] of entries) if ((roll -= w) < 0) return item;
  return entries[entries.length - 1][0];
}

/* ---------- days ---------- */

const weekday = (key) => new Date(dayBounds(key)[0]).getDay(); // 0 Sunday to 6 Saturday
const isWorkday = (key) => weekday(key) > 0 && weekday(key) < 6;

// Minutes after local midnight -> epoch ms; Date does the DST arithmetic.
function atMinute(key, minutes) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d, 0, minutes).getTime();
}

// 0 for the first week of history, WEEKS for this one.
const weekIndex = (key, today) => WEEKS - Math.round((dayBounds(weekStart(today))[0] - dayBounds(weekStart(key))[0]) / (7 * 864e5));

export const historyStart = (today) => shiftDay(weekStart(today), -7 * WEEKS);
export const lastWeek = (today) => ({ from: shiftDay(weekStart(today), -7), to: shiftDay(weekStart(today), -1) });

// What one block of time was spent on.
function task(r, person, week) {
  const roll = r();
  if (roll < 0.08) return { client: COMPANY, category: "internal", note: pick(r, DEMO_LISTS.tasks.internal) };
  const active = Object.entries(person.clients).filter(([name]) => PHASES[name][week]);
  const client = weighted(r, active);
  const typed = person.as?.[client] || client;
  if (roll < 0.22) return { client: typed, category: "pm", note: pick(r, DEMO_LISTS.tasks.pm) };
  if (roll < 0.3) return { client: typed, category: "tech", note: pick(r, DEMO_LISTS.tasks.tech) };
  if (roll < 0.38) {
    const [customer, co] = pick(r, person.orders);
    return { client: customer, category: "change", co, note: pick(r, DEMO_LISTS.tasks.change) };
  }
  const phase = PHASES[client][week];
  return { client: typed, category: phase, note: pick(r, person.notes?.[phase] || DEMO_LISTS.tasks[phase]) };
}

// One person's day as blocks { client, category, note, start, end }: a start
// around 8:30, lunch from noon to 1, and an earlier finish on Fridays.
function workday(person, key, today) {
  const r = rng(`${person.employee}|${key}`);
  const week = weekIndex(key, today);
  const dow = weekday(key);
  const blocks = [];
  let t = 8 * 60 + 20 + 5 * Math.floor(r() * 5);
  const finish = dow === 5 ? 15 * 60 + 30 + 5 * Math.floor(r() * 6) : 16 * 60 + 35 + 5 * Math.floor(r() * 8);

  if (dow === 1) {
    blocks.push({ client: COMPANY, category: "internal", note: "Team meeting", from: t, to: t + 30 });
    t += 30;
  }
  const fill = (until) => {
    while (until - t >= 15) {
      let end = Math.min(t + pick(r, [30, 45, 60, 60, 75, 90, 120]) + Math.floor(r() * 9) - 3, until);
      if (until - end < 20) end = until;
      blocks.push({ ...task(r, person, week), from: t, to: end });
      t = end + (r() < 0.2 ? 5 + 5 * Math.floor(r() * 3) : 0);
    }
  };
  fill(12 * 60 - Math.floor(r() * 2) * 5);
  t = 13 * 60 + Math.floor(r() * 2) * 5;
  fill(finish);

  if (person.untagged && key === shiftDay(lastWeek(today).from, 1)) {
    const b = blocks.find((x) => x.from >= 13 * 60);
    if (b) Object.assign(b, { category: "", note: "" });
  }
  if (person.typedOrder && key === shiftDay(lastWeek(today).from, 2)) {
    const b = blocks.find((x) => x.from >= 13 * 60);
    if (b) Object.assign(b, { client: REDWOOD, category: "change", co: "CO-0099", note: "Data fix" });
  }
  return blocks.map(({ from, to, ...b }) => ({ ...b, start: atMinute(key, from), end: atMinute(key, to) }));
}

// The days a person worked, oldest first, through `last`.
function workdays(person, today, last) {
  const days = [];
  for (let key = historyStart(today); key <= last; key = shiftDay(key, 1)) {
    if (!isWorkday(key)) continue;
    if (person.dayOff && key === shiftDay(lastWeek(today).from, 4)) continue;
    days.push(key);
  }
  return days;
}

// A person's state from their blocks: clients in a fixed order, each card
// tagged with what it was last used for, and nothing running.
function stateFrom(person, blocks, now) {
  const names = [...new Set([...Object.keys(person.clients).map((n) => person.as?.[n] || n), COMPANY, ...person.orders.map(([customer]) => customer)])];
  const base = blocks.length ? blocks[0].start : now;
  const clients = names.map((name, i) => ({ id: newId(base + i), name, archived: false, updated: now }));
  const idOf = new Map(clients.map((c) => [c.name, c.id]));
  const sessions = blocks.map((b) => ({ id: newId(b.start), clientId: idOf.get(b.client), start: b.start, end: b.end, category: b.category, co: b.co, note: b.note, updated: now }));
  for (const c of clients) {
    const last = blocks.filter((b) => b.client === c.name).pop();
    if (last) Object.assign(c, { category: last.category, note: last.note, co: last.co });
    // A client with no work this week has finished: removed from the list, its hours kept.
    if (person.clients[c.name] && !PHASES[c.name][WEEKS]) c.archived = true;
  }
  return normalise({ clients, sessions, settings: { employee: person.employee, updated: now } });
}

/* ---------- the visitor's app ---------- */

// Alex's state: past workdays in full, and today (any day of the week, so the
// demo always has a morning to look at) up to a few minutes ago, with no timer
// running, so pressing Start is the first thing to try.
export function demoState(now) {
  const today = dayKey(now);
  const alex = PEOPLE[0];
  const blocks = workdays(alex, today, shiftDay(today, -1)).flatMap((key) => workday(alex, key, today));
  const cutoff = now - 3 * 60e3;
  for (const b of workday(alex, today, today)) {
    if (b.start >= cutoff) break;
    const end = Math.min(b.end, cutoff);
    if (end - b.start >= 5 * 60e3) blocks.push({ ...b, end });
  }
  return stateFrom(alex, blocks, now);
}

/* ---------- the reviewer's page ---------- */

// The hours files a person sent: one per past week (Monday to Friday), and
// this week's so far, each saved at 17:05 on its last day.
function filesFor(person, st, today) {
  const files = [];
  const lw = lastWeek(today);
  for (let w = WEEKS; w >= 1; w--) {
    const from = shiftDay(weekStart(today), -7 * w);
    const to = person.dayOff && from === lw.from ? shiftDay(from, 3) : shiftDay(from, 4);
    files.push({ from, to, running: !!person.running && from === lw.from });
  }
  const yesterday = shiftDay(today, -1);
  const friday = shiftDay(weekStart(today), 4);
  if (today !== weekStart(today)) files.push({ from: weekStart(today), to: yesterday < friday ? yesterday : friday, running: false });
  return files.map(({ from, to, running }) => {
    const exported = atMinute(to, 17 * 60 + 5);
    return { ...parseHoursFile(hoursFile(st, from, to, exported)), running };
  });
}

// The reviewer's store: everyone's files, the official lists, last week as
// the period, and the week before already ticked as reviewed.
export function demoReview(now, alexState = demoState(now)) {
  const today = dayKey(now);
  let review = { ...blankReview(), lists: DEMO_LISTS, arEmail: "ar@example.com", billing: { categories: ["internal"], clients: [COMPANY] } };
  for (const person of PEOPLE) {
    const st = person === PEOPLE[0] ? alexState
      : stateFrom(person, workdays(person, today, shiftDay(today, -1)).flatMap((key) => workday(person, key, today)), now);
    for (const f of filesFor(person, st, today)) review = addHoursFile(review, f, f.exported + 60 * 60e3);
  }
  const before = { from: shiftDay(weekStart(today), -14), to: shiftDay(weekStart(today), -8) };
  for (const c of compile(review, before.from, before.to, { billableOnly: true }).clients) {
    if (c.official) review = setReviewed(review, before.from, before.to, c.name, true);
  }
  review.period = lastWeek(today);
  return normaliseReview(review);
}
