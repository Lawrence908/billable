// Reviewing everyone's hours without a server: pure functions shared by the
// staff app and the review page (review.html). No DOM, no storage, no network.
//
// Hours travel as files. A person saves an "hours file" for a date range and
// sends it to the reviewer, who loads everyone's files into the review page.
// Official lists (client names, phase names, tasks) travel the other way, as a
// link whose data sits after the "#", which browsers never send to a server.
// Client names are confidential, so they are never published on the site.

import { compress, decompress, fromB64u, toB64u } from "./bytes.js";
import { CATEGORIES, HOUR, categoryLabel, dayBounds, dayKey, existingSessions, fmtHours, roundQuarter, shiftDay, summaryRows } from "./model.js";

export const HOURS_KIND = "billable-hours";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));
const MAX_LINES = 20000; // a year of a busy person's lines is a few thousand
const MAX_NAME = 80;
const text = (v, max = MAX_NAME) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const fold = (s) => text(s).toLowerCase();

/* ---------- dates ---------- */

export const isDay = (v) => typeof v === "string" && DAY_RE.test(v) && dayKey(dayBounds(v)[0]) === v;

// Every day from `from` to `to`, inclusive.
export function daysBetween(from, to) {
  const out = [];
  for (let k = from; k <= to && out.length < 400; k = shiftDay(k, 1)) out.push(k);
  return out;
}

// Monday of the week holding `key`.
export function weekStart(key) {
  const dow = (new Date(dayBounds(key)[0]).getDay() + 6) % 7;
  return shiftDay(key, -dow);
}

export const isWeekday = (key) => {
  const d = new Date(dayBounds(key)[0]).getDay();
  return d > 0 && d < 6;
};

/* ---------- hours files (made by staff) ---------- */

// One line per day, client, category and note, exactly as that day's summary
// shows it: the line's time added up for the day, then rounded once.
export function hoursFile(st, from, to, now) {
  if (!isDay(from) || !isDay(to) || from > to) throw new Error("Pick a start date on or before the end date.");
  const lines = [];
  for (const date of daysBetween(from, to)) {
    for (const row of summaryRows(st, date, now)) {
      for (const l of row.lines) lines.push({ date, client: row.client.name, category: l.category, note: l.note, ms: Math.round(l.ms), hours: l.hours });
    }
  }
  const [start] = dayBounds(from);
  const [, end] = dayBounds(to);
  const running = existingSessions(st).some((s) => s.end === null && s.start < end && now > start);
  return { kind: HOURS_KIND, v: 1, employee: st.settings.employee, from, to, exported: now, running, lines };
}

export const hoursFileName = (f) =>
  `billable-hours-${f.employee.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "unnamed"}-${f.from}-to-${f.to}.json`;

// Hours files come from other people, so everything is checked and trimmed.
// Throws with a message meant for the reviewer.
export function parseHoursFile(raw) {
  let f;
  try {
    f = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("not a Billable hours file");
  }
  if (!f || f.kind !== HOURS_KIND || f.v !== 1) throw new Error("not a Billable hours file");
  const employee = text(f.employee);
  if (!employee) throw new Error("the file has no name in it");
  if (!isDay(f.from) || !isDay(f.to) || f.from > f.to) throw new Error("the file's dates are not valid");
  if (!Array.isArray(f.lines) || f.lines.length > MAX_LINES) throw new Error("the file's hours are not valid");
  const lines = [];
  for (const l of f.lines) {
    if (!l || !isDay(l.date) || l.date < f.from || l.date > f.to) continue;
    const ms = Number(l.ms);
    if (!Number.isFinite(ms) || ms < 0 || ms > 24 * HOUR) continue;
    const client = text(l.client);
    if (!client) continue;
    const category = CATEGORY_KEYS.has(l.category) ? l.category : "";
    // Hours are recomputed from the time, so a hand-edited file cannot claim more than it tracked.
    lines.push({ date: l.date, client, category, note: category ? text(l.note) : "", ms, hours: roundQuarter(ms) });
  }
  return { employee, from: f.from, to: f.to, exported: Number.isFinite(f.exported) ? f.exported : 0, running: !!f.running, lines };
}

/* ---------- the reviewer's store ---------- */

export function blankReview() {
  return { lists: blankLists(), people: {}, aliases: {}, taskAliases: {}, reviewed: {}, period: null, arEmail: "" };
}

// Adds one person's file. Their lines inside the file's dates are replaced, so
// sending a corrected file for the same week simply supersedes the old one.
export function addHoursFile(review, file, now) {
  const key = fold(file.employee);
  const prev = review.people[key] || { employee: file.employee, lines: [], files: [] };
  const kept = prev.lines.filter((l) => l.date < file.from || l.date > file.to);
  const files = prev.files.filter((x) => x.from < file.from || x.to > file.to);
  files.push({ from: file.from, to: file.to, exported: file.exported, imported: now, running: file.running });
  files.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return {
    ...review,
    people: { ...review.people, [key]: { employee: file.employee, lines: [...kept, ...file.lines], files } },
  };
}

export function removePerson(review, employee) {
  const people = { ...review.people };
  delete people[fold(employee)];
  return { ...review, people };
}

// The review store as saved by an older page, or imported from a backup.
export function normaliseReview(r) {
  const out = blankReview();
  if (!r || typeof r !== "object") return out;
  out.lists = normaliseLists(r.lists);
  for (const p of Object.values(r.people && typeof r.people === "object" ? r.people : {})) {
    try {
      const f = parseHoursFile({ kind: HOURS_KIND, v: 1, employee: p.employee, from: "1970-01-01", to: "2999-12-31", lines: p.lines });
      out.people[fold(f.employee)] = {
        employee: f.employee,
        lines: f.lines,
        files: (Array.isArray(p.files) ? p.files : []).filter((x) => x && isDay(x.from) && isDay(x.to))
          .map((x) => ({ from: x.from, to: x.to, exported: Number(x.exported) || 0, imported: Number(x.imported) || 0, running: !!x.running })),
      };
    } catch { /* skip a damaged person rather than lose the rest */ }
  }
  for (const [k, v] of Object.entries(r.aliases && typeof r.aliases === "object" ? r.aliases : {})) {
    if (text(v)) out.aliases[fold(k)] = text(v);
  }
  for (const [k, v] of Object.entries(r.taskAliases && typeof r.taskAliases === "object" ? r.taskAliases : {})) {
    const [category, note] = k.split("\u0000");
    if (CATEGORY_KEYS.has(category) && note && text(v)) out.taskAliases[taskKey(category, note)] = text(v);
  }
  for (const [period, clients] of Object.entries(r.reviewed && typeof r.reviewed === "object" ? r.reviewed : {})) {
    if (clients && typeof clients === "object") out.reviewed[period] = Object.fromEntries(Object.entries(clients).filter(([, v]) => v === true));
  }
  if (r.period && isDay(r.period.from) && isDay(r.period.to)) out.period = { from: r.period.from, to: r.period.to };
  out.arEmail = text(r.arEmail, 200);
  return out;
}

/* ---------- official lists ---------- */

// { clients: [names], phases: { p2: "PHASE 2: CONTRACT/BILLINGS", ... }, tasks: { p2: [...], "*": [...] }, by, updated }
// `phases` names any category as the timesheet's Costing section writes it.
// "*" holds tasks that belong under every category (meetings, admin).
export function blankLists() {
  return { clients: [], phases: {}, tasks: {}, by: "", updated: 0 };
}

const uniqueNames = (list) => {
  const seen = new Set();
  const out = [];
  for (const n of Array.isArray(list) ? list : []) {
    const t = text(n);
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
};

// One name per line, blanks and repeats dropped.
export const parseList = (s) => uniqueNames(String(s ?? "").split(/\r?\n/));

export function normaliseLists(l) {
  const out = blankLists();
  if (!l || typeof l !== "object") return out;
  out.clients = uniqueNames(l.clients).slice(0, 2000);
  for (const c of CATEGORIES) {
    if (text(l.phases?.[c.key])) out.phases[c.key] = text(l.phases[c.key]);
  }
  for (const key of [...CATEGORIES.map((c) => c.key), "*"]) {
    const t = uniqueNames(l.tasks?.[key]).slice(0, 200);
    if (t.length) out.tasks[key] = t;
  }
  out.by = text(l.by);
  out.updated = Number.isFinite(l.updated) ? l.updated : 0;
  return out;
}

export const hasLists = (l) => !!l && (l.clients.length > 0 || Object.keys(l.tasks).length > 0 || Object.keys(l.phases).length > 0);

// How a category reads on screen: "P2 · Contract/Billings" when the phase has
// a name, just the name when it already says which phase it is ("PHASE 2:
// CONTRACT/BILLINGS"), and the plain label otherwise.
export function phaseLabel(lists, key) {
  const name = lists?.phases?.[key];
  if (!name) return categoryLabel(key);
  const n = key.match(/^p(\d)$/)?.[1];
  if (!n || new RegExp(`^(phase\\s*0*${n}|p${n})\\b`, "i").test(name)) return name;
  return `${categoryLabel(key)} · ${name}`;
}

// What goes in the timesheet's Costing section column: the official name
// exactly as entered, else the plain label.
export const costingLabel = (lists, key) => lists?.phases?.[key] || categoryLabel(key);

// The official tasks for a category: its own, then the shared ones.
export const tasksFor = (lists, category) =>
  !category || !lists ? [] : uniqueNames([...(lists.tasks[category] || []), ...(lists.tasks["*"] || [])]);

export const officialClient = (lists, name) => lists.clients.find((c) => c.toLowerCase() === fold(name)) || null;

export async function encodeLists(lists, origin) {
  const raw = new TextEncoder().encode(JSON.stringify({ v: 1, ...normaliseLists(lists) }));
  const zipped = await compress(raw, "deflate-raw");
  return `${origin}/#lists=${zipped ? "z" : "j"}${toB64u(zipped || raw)}`;
}

export async function decodeLists(link) {
  const m = String(link).match(/#lists=([zj])([A-Za-z0-9_-]+)/);
  if (!m) throw new Error("not a lists link");
  if (m[2].length > 60000) throw new Error("lists link is too long");
  let bytes = fromB64u(m[2]);
  if (m[1] === "z") bytes = await decompress(bytes, "deflate-raw", 1024 * 1024);
  const p = JSON.parse(new TextDecoder().decode(bytes));
  if (!p || p.v !== 1) throw new Error("bad lists data");
  return normaliseLists(p);
}

/* ---------- compiling a period ---------- */

const periodKey = (from, to) => `${from}_${to}`;
export const reviewedFor = (review, from, to) => review.reviewed[periodKey(from, to)] || {};

export function setReviewed(review, from, to, client, yes) {
  const k = periodKey(from, to);
  const cur = { ...(review.reviewed[k] || {}) };
  if (yes) cur[client] = true;
  else delete cur[client];
  return { ...review, reviewed: { ...review.reviewed, [k]: cur } };
}

const taskKey = (category, note) => `${category}\u0000${fold(note)}`;

// Counts a task typed under a category as one of the official ones.
export function setTaskAlias(review, category, note, official) {
  const taskAliases = { ...review.taskAliases };
  if (official) taskAliases[taskKey(category, note)] = official;
  else delete taskAliases[taskKey(category, note)];
  return { ...review, taskAliases };
}

// Adds a name to the official lists, from a check: a client, or a task under a category.
export function addOfficialClient(review, name, now) {
  return { ...review, lists: normaliseLists({ ...review.lists, clients: [...review.lists.clients, name], updated: now }) };
}

export function addOfficialTask(review, category, task, now) {
  const tasks = { ...review.lists.tasks, [category]: [...(review.lists.tasks[category] || []), task] };
  return { ...review, lists: normaliseLists({ ...review.lists, tasks, updated: now }) };
}

export function setAlias(review, name, official) {
  const aliases = { ...review.aliases };
  if (official) aliases[fold(name)] = official;
  else delete aliases[fold(name)];
  return { ...review, aliases };
}

// The name a line is reported under: an alias the reviewer set, else the
// official spelling, else the name as typed.
export function clientName(review, name) {
  const alias = review.aliases[fold(name)];
  if (alias) return alias;
  return officialClient(review.lists, name) || name;
}

const categorySort = (key) => {
  const i = CATEGORIES.findIndex((c) => c.key === key);
  return i < 0 ? CATEGORIES.length : i;
};

// Everything the review screen and the hand-off need for one period.
// Hours are each person's rounded daily lines, added up: the same numbers
// each of them would have pasted into the Sheet themselves.
export function compile(review, from, to) {
  const { lists } = review;
  const officialSet = new Set(lists.clients.map((c) => c.toLowerCase()));
  const checkClients = lists.clients.length > 0;
  const rows = [];
  for (const person of Object.values(review.people)) {
    for (const l of person.lines) {
      if (l.date < from || l.date > to) continue;
      const client = clientName(review, l.client);
      const official = tasksFor(lists, l.category);
      const mapped = l.category && l.note ? review.taskAliases[taskKey(l.category, l.note)] : null;
      const wanted = (mapped || l.note).toLowerCase();
      const task = official.find((t) => t.toLowerCase() === wanted) || (mapped && official.length ? null : mapped);
      rows.push({
        ...l,
        typedClient: l.client,
        typedNote: l.note,
        client,
        employee: person.employee,
        note: task || l.note,
        officialClient: !checkClients || officialSet.has(client.toLowerCase()),
        // Only judged where the category has tasks of its own: the shared
        // tasks alone don't make every other note in it "other".
        otherTask: !!l.category && (lists.tasks[l.category] || []).length > 0 && !task,
      });
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || a.employee.localeCompare(b.employee) || a.client.localeCompare(b.client));

  // By client, then by category and task.
  const byClient = new Map();
  for (const r of rows) {
    if (!byClient.has(r.client)) byClient.set(r.client, { name: r.client, official: r.officialClient, hours: 0, ms: 0, lines: new Map(), people: new Set() });
    const c = byClient.get(r.client);
    c.hours += r.hours;
    c.ms += r.ms;
    c.people.add(r.employee);
    const k = `${r.category}\u0000${r.note.toLowerCase()}`;
    if (!c.lines.has(k)) c.lines.set(k, { category: r.category, note: r.note, otherTask: r.otherTask, hours: 0, ms: 0, people: new Map() });
    const line = c.lines.get(k);
    line.hours += r.hours;
    line.ms += r.ms;
    line.people.set(r.employee, (line.people.get(r.employee) || 0) + r.hours);
  }
  const clients = [...byClient.values()]
    .map((c) => ({
      ...c,
      people: [...c.people].sort(),
      lines: [...c.lines.values()]
        .map((l) => ({ ...l, label: l.category ? `${phaseLabel(lists, l.category)}${l.note ? ` · ${l.note}` : ""}` : "No category", people: [...l.people].map(([employee, hours]) => ({ employee, hours })) }))
        .sort((a, b) => categorySort(a.category) - categorySort(b.category) || a.note.localeCompare(b.note)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // By person, with the weekdays their files do not cover.
  const weekdays = daysBetween(from, to).filter(isWeekday);
  const people = Object.values(review.people)
    .map((p) => {
      const covered = new Set(p.files.flatMap((f) => daysBetween(f.from, f.to)));
      return {
        employee: p.employee,
        hours: rows.filter((r) => r.employee === p.employee).reduce((a, r) => a + r.hours, 0),
        missing: weekdays.filter((d) => !covered.has(d)),
        running: p.files.some((f) => f.running && f.to >= from && f.from <= to),
      };
    })
    .sort((a, b) => a.employee.localeCompare(b.employee));

  const byCategory = new Map();
  for (const r of rows) byCategory.set(r.category, (byCategory.get(r.category) || 0) + r.hours);
  const categories = [...byCategory].map(([category, hours]) => ({ category, label: category ? phaseLabel(lists, category) : "No category", hours }))
    .sort((a, b) => categorySort(a.category) - categorySort(b.category));

  const group = (list, keyOf) => {
    const m = new Map();
    for (const r of list) {
      const k = keyOf(r);
      if (!m.has(k)) m.set(k, { ...r, hours: 0, people: new Set() });
      m.get(k).hours += r.hours;
      m.get(k).people.add(r.employee);
    }
    return [...m.values()].map((x) => ({ ...x, people: [...x.people].sort() }));
  };
  const checks = {
    unknownClients: group(rows.filter((r) => !r.officialClient), (r) => r.typedClient.toLowerCase())
      .map((x) => ({ name: x.typedClient, hours: x.hours, people: x.people })),
    otherTasks: group(rows.filter((r) => r.otherTask), (r) => `${r.category}\u0000${r.note.toLowerCase()}`)
      .map((x) => ({ category: x.category, label: phaseLabel(lists, x.category), note: x.note, tasks: tasksFor(lists, x.category), hours: x.hours, people: x.people })),
    noCategory: group(rows.filter((r) => !r.category), (r) => `${r.employee}\u0000${r.client}`)
      .map((x) => ({ employee: x.employee, client: x.client, hours: x.hours })),
    missingDays: people.filter((p) => p.missing.length).map((p) => ({ employee: p.employee, days: p.missing })),
    running: people.filter((p) => p.running).map((p) => p.employee),
  };

  return { from, to, lists, rows, clients, people, categories, checks, hours: rows.reduce((a, r) => a + r.hours, 0) };
}

/* ---------- hand-off ---------- */

// Spreadsheets run a cell starting with = + - @ as a formula; names come from
// other people's files, so neutralise them.
const csvCell = (v) => `"${String(v).replace(/^[=+\-@\t\r]/, "'$&").replace(/"/g, '""')}"`;
const tsvCell = (v) => String(v).replace(/[\t\r\n]+/g, " ").replace(/^[=+\-@]/, "'$&");
const sheetDate = (key) => {
  const [y, m, d] = key.split("-");
  return `${m}/${d}/${y}`;
};

// Every person's line for every day, one row each.
export function detailCSV(compiled) {
  const out = ["date,employee,client,costing_section,notes,hours,tracked_hours,client_as_typed,official_task,notes_as_typed"];
  for (const r of compiled.rows) {
    if (!r.hours) continue;
    out.push([r.date, csvCell(r.employee), csvCell(r.client), csvCell(costingLabel(compiled.lists, r.category)), csvCell(r.note), fmtHours(r.hours),
      (r.ms / HOUR).toFixed(2), csvCell(r.typedClient), r.category ? (r.otherTask ? "no" : "yes") : "", csvCell(r.typedNote)].join(","));
  }
  return out.join("\r\n") + "\r\n";
}

// Totals per client, category and task for the period.
export function totalsCSV(compiled) {
  const out = ["client,costing_section,notes,hours"];
  for (const c of compiled.clients) {
    for (const l of c.lines) if (l.hours) out.push([csvCell(c.name), csvCell(costingLabel(compiled.lists, l.category)), csvCell(l.note), fmtHours(l.hours)].join(","));
  }
  return out.join("\r\n") + "\r\n";
}

// One client's rows in the timesheet's five columns (Date, Employee, Costing
// section, Notes, Hours), tab-separated for pasting into that client's tab.
export function clientTSV(compiled, client) {
  return compiled.rows
    .filter((r) => r.client === client && r.hours)
    .map((r) => [sheetDate(r.date), r.employee, costingLabel(compiled.lists, r.category), r.note, fmtHours(r.hours)].map(tsvCell).join("\t"))
    .join("\n");
}

export function handoffText(compiled, lists) {
  const lines = [`Billable hours, ${compiled.from} to ${compiled.to}`, ""];
  if (!compiled.clients.length) lines.push("No hours in this period.");
  for (const c of compiled.clients) {
    lines.push(`${c.name}: ${fmtHours(c.hours)} h`);
    for (const l of c.lines) if (l.hours) lines.push(`  ${l.category ? phaseLabel(lists, l.category) : "No category"}${l.note ? ` · ${l.note}` : ""}: ${fmtHours(l.hours)} h`);
  }
  lines.push("", `Total: ${fmtHours(compiled.hours)} h from ${compiled.people.filter((p) => p.hours).length} people.`,
    "Each person's line for each day is rounded to the nearest 0.25 h, then added up.");
  return lines.join("\n");
}
