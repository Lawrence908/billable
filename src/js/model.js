// The data model: pure functions over a plain state object. No DOM, no
// storage, no network, so all of it runs under `node --test`.
//
// State is { clients, sessions, settings }. A session is
// { id, clientId, start, end } in epoch ms, with end = null while it runs.
// Every client, session and the settings carry `updated` (ms), and deleting
// leaves a tombstone { id, deleted, updated }. That is what lets two devices
// merge: for each id the newest record wins, and a deletion is just a newer
// record.

export const MINUTE = 60e3;
export const HOUR = 60 * MINUTE;

// Time-prefixed, so sorting by id lists clients in the order they were added.
export function newId(now = Date.now()) {
  const tail = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(36).padStart(2, "0")).join("");
  return now.toString(36) + tail;
}

export function blank() {
  return { clients: [], sessions: [], settings: { email: "", allowOverlap: false, updated: 0 } };
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const when = (v) => (Number.isFinite(v) ? v : 0);

// Rebuilds state from anything shaped roughly right (stored state, a decrypted
// sync blob, an imported backup), drops what is not, and fixes key and array
// order. The fixed shape matters: devices compare states by their JSON, so
// equal data must serialise identically. Data saved by the first version
// (jobs/jobId, no `updated`) is read the same way.
export function normalise(d) {
  const out = blank();
  if (!d || typeof d !== "object") return out;
  const clients = Array.isArray(d.clients) ? d.clients : Array.isArray(d.jobs) ? d.jobs : [];
  for (const c of clients) {
    if (!c || typeof c.id !== "string") continue;
    if (c.deleted) out.clients.push({ id: c.id, deleted: true, updated: when(c.updated) });
    else if (typeof c.name === "string") {
      out.clients.push({ id: c.id, name: c.name.slice(0, 80), archived: !!c.archived, updated: when(c.updated) });
    }
  }
  for (const s of Array.isArray(d.sessions) ? d.sessions : []) {
    if (!s || typeof s.id !== "string") continue;
    if (s.deleted) {
      out.sessions.push({ id: s.id, deleted: true, updated: when(s.updated) });
      continue;
    }
    const clientId = s.clientId || s.jobId;
    if (typeof clientId !== "string" || !Number.isFinite(s.start)) continue;
    if (s.end !== null && !Number.isFinite(s.end)) continue;
    // An end before the start happens when a timer is stopped on a device
    // whose clock is behind the one that started it. Keep the entry, at zero.
    const end = s.end === null ? null : Math.max(s.end, s.start);
    out.sessions.push({ id: s.id, clientId, start: s.start, end, updated: when(s.updated) });
  }
  out.clients.sort(byId);
  out.sessions.sort(byId);
  if (d.settings && typeof d.settings === "object") {
    out.settings = {
      email: String(d.settings.email || "").slice(0, 200),
      allowOverlap: !!d.settings.allowOverlap,
      updated: when(d.settings.updated),
    };
  }
  return out;
}

export const sameData = (a, b) => JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));

/* ---------- queries ---------- */

// "Existing" means not deleted; it includes clients the user removed from the
// list (archived), whose past hours still count. "Active" is what the list shows.
export const existingClients = (st) => st.clients.filter((c) => !c.deleted);
export const activeClients = (st) => existingClients(st).filter((c) => !c.archived);
export const clientById = (st, id) => existingClients(st).find((c) => c.id === id);
export const clientByName = (st, name) => {
  const folded = name.toLowerCase();
  return existingClients(st).find((c) => c.name.toLowerCase() === folded);
};

// Sessions whose client still exists. A session can outlive its client after
// a merge (deleted on one device, edited on another); it is hidden, not shown
// orphaned.
export function existingSessions(st) {
  const ids = new Set(existingClients(st).map((c) => c.id));
  return st.sessions.filter((s) => !s.deleted && ids.has(s.clientId));
}

export const runningFor = (st, clientId) => existingSessions(st).find((s) => s.clientId === clientId && s.end === null);

/* ---------- time ---------- */

const pad = (n) => String(n).padStart(2, "0");

export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Local midnight to local midnight, so a DST day is 23 or 25 hours long.
export function dayBounds(key) {
  const [y, m, d] = key.split("-").map(Number);
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

export function shiftDay(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + n).getTime());
}

// "HH:MM" on the given local day -> epoch ms.
export function atTime(key, hhmm) {
  const [y, m, d] = key.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
}

// The end of an entry typed as HH:MM. An end at or before the start means the
// next morning, on the next calendar day (not +24 h, which is wrong across DST).
export function endAfter(start, hhmm) {
  const key = dayKey(start);
  const end = atTime(key, hhmm);
  return end > start ? end : atTime(shiftDay(key, 1), hhmm);
}

export function clock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtHM(ms) {
  const m = Math.floor(ms / MINUTE);
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
}

export function fmtHMS(ms) {
  const s = Math.floor(ms / 1e3);
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

export const fmtHours = (h) => h.toFixed(1);

export function prettyDay(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

// Nearest half hour. 15 minutes rounds up to 0.5, 14 down to 0.
export const roundHalf = (ms) => Math.round((ms / HOUR) * 2) / 2;

/* ---------- totals ---------- */

// A client's time on a day is the overlap of its sessions with that local day,
// so a stretch across midnight is split between the two days.
export function totalsFor(st, key, now) {
  const [from, to] = dayBounds(key);
  const per = new Map();
  for (const s of existingSessions(st)) {
    const end = s.end === null ? now : s.end;
    const ms = Math.max(0, Math.min(end, to) - Math.max(s.start, from));
    const startedToday = s.start >= from && s.start < to;
    if (ms > 0 || (s.end === null && startedToday)) per.set(s.clientId, (per.get(s.clientId) || 0) + ms);
  }
  return per;
}

export function summaryRows(st, key, now) {
  const per = totalsFor(st, key, now);
  return existingClients(st)
    .filter((c) => per.has(c.id))
    .map((c) => ({ client: c, ms: per.get(c.id), hours: roundHalf(per.get(c.id)) }));
}

export function summaryText(st, key, now) {
  const rows = summaryRows(st, key, now);
  const lines = [`Hours for ${prettyDay(key)}`, ""];
  if (!rows.length) lines.push("No time recorded.");
  for (const r of rows) lines.push(`${r.client.name}: ${fmtHours(r.hours)} h`);
  lines.push("", `Total: ${fmtHours(rows.reduce((a, r) => a + r.hours, 0))} h`, "(Rounded to the nearest 0.5 h per client.)");
  if (existingSessions(st).some((s) => s.end === null)) lines.push("Note: a timer was still running when this was generated.");
  return lines.join("\n");
}

export function csvFor(st, key, now) {
  // A leading = + - @ makes spreadsheets run the cell as a formula, and names
  // can arrive from an imported link or backup, so neutralise them.
  const quote = (v) => `"${String(v).replace(/^[=+\-@\t\r]/, "'$&").replace(/"/g, '""')}"`;
  const lines = ["date,client,tracked_hours,hours"];
  for (const r of summaryRows(st, key, now)) {
    lines.push([key, quote(r.client.name), (r.ms / HOUR).toFixed(2), fmtHours(r.hours)].join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/* ---------- merge ---------- */

// Newest record per id wins. Exact ties (the same ms on two devices) fall back
// to comparing the records' JSON, so both devices pick the same one.
function newer(a, b) {
  if (a.updated !== b.updated) return a.updated > b.updated ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

function mergeLists(x, y) {
  const m = new Map(x.map((r) => [r.id, r]));
  for (const r of y) m.set(r.id, m.has(r.id) ? newer(m.get(r.id), r) : r);
  return [...m.values()];
}

export function merge(a, b) {
  return settleRunning(collapseSameName(normalise({
    clients: mergeLists(a.clients, b.clients),
    sessions: mergeLists(a.sessions, b.sessions),
    settings: newer(a.settings, b.settings),
  })));
}

// Two devices that each had an "Acme" before syncing end up with two clients
// of that name, and the summary would round each separately. Keep the oldest
// (lowest id), move the other's sessions onto it, and delete the other. All of
// it is derived from the data alone, so every device makes the same choice.
function collapseSameName(st) {
  const keeper = new Map();
  const moved = new Map();
  for (const c of existingClients(st)) {
    const folded = c.name.toLowerCase();
    const k = keeper.get(folded);
    if (!k) keeper.set(folded, c);
    else moved.set(c.id, k);
  }
  if (!moved.size) return st;
  st.clients = st.clients.map((c) => {
    const k = moved.get(c.id);
    if (!k) return c;
    if (!c.archived && k.archived) {
      k.archived = false;
      k.updated = Math.max(k.updated, c.updated);
    }
    return { id: c.id, deleted: true, updated: Math.max(c.updated, k.updated) + 1 };
  });
  for (const s of st.sessions) if (!s.deleted && moved.has(s.clientId)) s.clientId = moved.get(s.clientId).id;
  return normalise(st);
}

// Tombstones only need to outlive the chance of an old copy coming back. A
// device offline for longer than this could resurrect a deleted entry.
export function pruneTombstones(st, now, days = 180) {
  const cutoff = now - days * 24 * HOUR;
  const keep = (r) => !r.deleted || r.updated > cutoff;
  return normalise({ ...st, clients: st.clients.filter(keep), sessions: st.sessions.filter(keep) });
}

// Two devices can each start a different timer before they sync. With overlap
// off, the earlier one stops where the later one began. The result depends
// only on the data, so both devices reach it without another round trip.
// Returns a new state; the input is not modified.
export function settleRunning(st) {
  const out = normalise(st);
  if (out.settings.allowOverlap) return out;
  const ids = new Set(existingClients(out).map((c) => c.id));
  const running = out.sessions
    .filter((s) => !s.deleted && s.end === null && ids.has(s.clientId))
    .sort((a, b) => a.start - b.start || byId(a, b));
  for (let i = 0; i < running.length - 1; i++) {
    running[i].end = Math.max(running[i].start, running[i + 1].start);
    running[i].updated = Math.max(running[i].updated, running[i + 1].updated);
  }
  return out;
}
