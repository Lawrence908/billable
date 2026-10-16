// "Move without sync": the data itself rides in a link, after the "#", which
// browsers never send to a server.
//
// Compact payload: { v, b, c, a, s }
//   c  client names
//   a  indexes into c of clients the sender had removed from their list
//   b  base minute (epoch minutes) that session offsets count from
//   s  sessions as [client index, start offset in minutes, duration in
//      minutes or -1 while running, and when tagged: category index into
//      CATEGORIES, note index into n or -1]
//   n  distinct notes, so a note used many times is carried once
// deflated (deflate-raw) and base64url-encoded.

import { compress, decompress, fromB64u, toB64u } from "./bytes.js";
import { CATEGORIES, MINUTE, clientByName, dayBounds, dayKey, existingClients, existingSessions, normalise, settleRunning, shiftDay } from "./model.js";

const MAX_LINK = 8000; // characters; a real link is a few hundred
const MAX_JSON = 512 * 1024; // bytes after inflating

export function buildTransfer(st, now, days) {
  const since = dayBounds(shiftDay(dayKey(now), -(days - 1)))[0];
  const sessions = existingSessions(st).filter((s) => (s.end === null ? now : s.end) > since);
  const used = new Set(sessions.map((s) => s.clientId));
  const clients = existingClients(st).filter((c) => !c.archived || used.has(c.id));
  const index = new Map(clients.map((c, i) => [c.id, i]));
  const base = sessions.length ? Math.floor(Math.min(...sessions.map((s) => s.start)) / MINUTE) : 0;
  const notes = [...new Set(sessions.map((s) => s.note).filter(Boolean))];
  const payload = {
    v: 1,
    b: base,
    c: clients.map((c) => c.name),
    a: clients.flatMap((c, i) => (c.archived ? [i] : [])),
    n: notes,
    s: sessions.map((s) => {
      const row = [index.get(s.clientId), Math.floor(s.start / MINUTE) - base, s.end === null ? -1 : Math.round((s.end - s.start) / MINUTE)];
      if (s.category) row.push(CATEGORIES.findIndex((c) => c.key === s.category), s.note ? notes.indexOf(s.note) : -1);
      return row;
    }),
  };
  return { payload, clients: clients.length, sessions: sessions.length };
}

export async function encodeTransfer(payload, origin) {
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const zipped = await compress(raw, "deflate-raw");
  return `${origin}/#import=${zipped ? "z" : "j"}${toB64u(zipped || raw)}`;
}

export async function decodeTransfer(text) {
  const m = String(text).match(/#import=([zj])([A-Za-z0-9_-]+)/);
  if (!m) throw new Error("not a transfer link");
  if (m[2].length > MAX_LINK) throw new Error("transfer link is too long");
  let bytes = fromB64u(m[2]);
  if (m[1] === "z") bytes = await decompress(bytes, "deflate-raw", MAX_JSON);
  const p = JSON.parse(new TextDecoder().decode(bytes));
  const int = Number.isInteger;
  if (p.v !== 1 || !int(p.b) || !Array.isArray(p.c) || !Array.isArray(p.s)) throw new Error("bad transfer data");
  const names = p.c.map((n) => String(n).trim().slice(0, 80));
  const archived = new Set(Array.isArray(p.a) ? p.a.filter(int) : []);
  const notes = Array.isArray(p.n) ? p.n.map((n) => String(n)) : [];
  return {
    base: p.b,
    clients: names.map((name, i) => ({ name, archived: archived.has(i) })).filter((c) => c.name),
    // Indexes refer to the original list, so validate against it before filtering names.
    sessions: p.s
      .filter((x) => Array.isArray(x) && int(x[0]) && names[x[0]] && int(x[1]) && int(x[2]) && x[2] >= -1)
      .map(([ci, offset, minutes, cat, note]) => ({
        name: names[ci],
        offset,
        minutes,
        category: CATEGORIES[cat]?.key || "",
        note: notes[note] || "",
      })),
  };
}

// Merges into an existing state: clients match by name (case-insensitively),
// and an entry for the same client starting in the same minute is treated as
// already present, so importing a link twice adds nothing.
export function applyTransfer(st, transfer, now, makeId) {
  const out = normalise(st);
  let addedClients = 0;
  let addedSessions = 0;
  for (const { name, archived } of transfer.clients) {
    const c = clientByName(out, name);
    if (!c) {
      out.clients.push({ id: makeId(), name, archived, updated: now });
      addedClients++;
    } else if (c.archived && !archived) {
      c.archived = false;
      c.updated = now;
    }
  }
  for (const { name, offset, minutes, category, note } of transfer.sessions) {
    const clientId = clientByName(out, name).id;
    const minute = transfer.base + offset;
    if (existingSessions(out).some((s) => s.clientId === clientId && Math.floor(s.start / MINUTE) === minute)) continue;
    const start = minute * MINUTE;
    out.sessions.push({ id: makeId(), clientId, start, end: minutes < 0 ? null : start + minutes * MINUTE, category, note, updated: now });
    addedSessions++;
  }
  return { state: settleRunning(out), addedClients, addedSessions };
}
