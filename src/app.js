// Billable: per-client start/stop timers, kept in localStorage, with optional
// end-to-end encrypted sync between devices.
//
// State is one JSON blob. A session is {id, clientId, start, end} in epoch ms,
// with end = null while its timer runs. A day's time for a client is the
// overlap of its sessions with that local calendar day, so a stretch that
// crosses midnight is split between the two days rather than credited to one.
//
// Every client, session and the settings carry `updated` (ms). Deleting leaves
// a tombstone {id, deleted, updated}. That is what lets two devices merge:
// for each id, the newest record wins, and a deletion is just a newer record.
"use strict";

const KEY = "billable.v1";
const SYNC_KEY = "billable.sync";
const TIP_KEY = "billable.tip-dismissed";
const HOUR = 3600e3;
const BUILD = document.querySelector('meta[name="build"]').content;

const $ = (id) => document.getElementById(id);

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function blank() {
  return { clients: [], sessions: [], settings: { email: "", allowOverlap: false, updated: 0 } };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? normalise(JSON.parse(raw)) : blank();
  } catch {
    return blank();
  }
}

// Rebuilds state from anything shaped roughly right (stored state, a decrypted
// sync blob, an imported backup), drops what is not, and fixes key and array
// order. The fixed shape matters: two devices compare states by their JSON, so
// equal data must serialise identically. Data saved by the first version
// (jobs/jobId, no `updated`) is read the same way.
function normalise(d) {
  const out = blank();
  if (!d || typeof d !== "object") return out;
  const when = (v) => (Number.isFinite(v) ? v : 0);
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
    if (s.end !== null && !(Number.isFinite(s.end) && s.end >= s.start)) continue;
    out.sessions.push({ id: s.id, clientId, start: s.start, end: s.end, updated: when(s.updated) });
  }
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
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

let state = load();
let viewDay = dayKey(Date.now());

function saveLocal() {
  localStorage.setItem(KEY, JSON.stringify(state));
}

// Every user edit ends here: store, redraw, and push to other devices.
function commit() {
  state = normalise(state);
  saveLocal();
  render();
  scheduleSync();
}

// Another tab changed the data: adopt it rather than overwrite it later.
window.addEventListener("storage", (e) => {
  if (e.key === KEY) {
    state = load();
    render();
  } else if (e.key === SYNC_KEY) {
    sync = loadSync();
    aesKey = null;
    render();
  }
});

/* ---------- time helpers ---------- */

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayBounds(key) {
  const [y, m, d] = key.split("-").map(Number);
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

function shiftDay(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + n).getTime());
}

function overlap(s, from, to, now) {
  const end = s.end === null ? now : s.end;
  return Math.max(0, Math.min(end, to) - Math.max(s.start, from));
}

function fmtHM(ms) {
  const m = Math.floor(ms / 60e3);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

function fmtHMS(ms) {
  const s = Math.floor(ms / 1e3);
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// Nearest half hour. 15 minutes rounds up to 0.5, 14 down to 0.
function roundHalf(ms) {
  return Math.round((ms / HOUR) * 2) / 2;
}

function fmtHours(h) {
  return h.toFixed(1);
}

function clock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// "HH:MM" on the given day -> epoch ms.
function atTime(key, hhmm) {
  const [y, m, d] = key.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
}

function prettyDay(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

/* ---------- derived data ---------- */

const liveClients = () => state.clients.filter((c) => !c.deleted);
const activeClients = () => liveClients().filter((c) => !c.archived);
const clientById = (id) => liveClients().find((c) => c.id === id);

// Sessions whose client still exists. A session can outlive its client after a
// merge (deleted on one device, edited on another); it is hidden, not shown orphaned.
function liveSessions() {
  const ids = new Set(liveClients().map((c) => c.id));
  return state.sessions.filter((s) => !s.deleted && ids.has(s.clientId));
}

const running = (clientId) => liveSessions().find((s) => s.clientId === clientId && s.end === null);

function totalsFor(key, now) {
  const [from, to] = dayBounds(key);
  const per = new Map();
  for (const s of liveSessions()) {
    const ms = overlap(s, from, to, now);
    if (ms > 0 || (s.end === null && s.start < to && s.start >= from)) {
      per.set(s.clientId, (per.get(s.clientId) || 0) + ms);
    }
  }
  return per;
}

function summaryRows(key, now) {
  const per = totalsFor(key, now);
  return liveClients()
    .filter((c) => per.has(c.id))
    .map((c) => ({ client: c, ms: per.get(c.id), hours: roundHalf(per.get(c.id)) }));
}

/* ---------- actions ---------- */

function addClient(name) {
  name = name.trim().slice(0, 80);
  if (!name) return;
  const same = liveClients().find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (same) {
    // Re-adding a removed client brings it (and its history) back.
    if (same.archived) {
      same.archived = false;
      same.updated = Date.now();
      commit();
      toast(`${same.name} is back.`);
    } else {
      toast(`${same.name} is already in the list.`);
    }
    return;
  }
  state.clients.push({ id: uid(), name, archived: false, updated: Date.now() });
  commit();
  requestPersist();
}

function toggle(clientId) {
  const now = Date.now();
  const live = running(clientId);
  if (live) {
    live.end = now;
    live.updated = now;
  } else {
    if (!state.settings.allowOverlap) {
      for (const s of liveSessions()) {
        if (s.end === null) {
          s.end = now;
          s.updated = now;
        }
      }
    }
    state.sessions.push({ id: uid(), clientId, start: now, end: null, updated: now });
  }
  commit();
}

function renameClient(clientId) {
  const c = clientById(clientId);
  const name = prompt("Client name", c.name);
  if (name === null || !name.trim()) return;
  c.name = name.trim().slice(0, 80);
  c.updated = Date.now();
  commit();
}

function archiveClient(clientId) {
  const c = clientById(clientId);
  const now = Date.now();
  const live = running(clientId);
  if (live) {
    live.end = now;
    live.updated = now;
  }
  c.archived = true;
  c.updated = now;
  commit();
  toast(`Removed ${c.name}. Past hours are kept; add the name again to bring it back.`);
}

function restoreClient(clientId) {
  const c = clientById(clientId);
  c.archived = false;
  c.updated = Date.now();
  commit();
}

function tombstone(list, id, now) {
  const i = list.findIndex((r) => r.id === id);
  if (i >= 0) list[i] = { id, deleted: true, updated: now };
}

function deleteClientForever(clientId) {
  const c = clientById(clientId);
  if (!confirm(`Delete "${c.name}" and all of its recorded time? This cannot be undone.`)) return;
  const now = Date.now();
  for (const s of liveSessions().filter((x) => x.clientId === clientId)) tombstone(state.sessions, s.id, now);
  tombstone(state.clients, clientId, now);
  commit();
}

// Times are edited as wall-clock HH:MM on the session's start day. An end
// earlier than the start is read as the next morning.
function editSession(id, field, value) {
  const s = liveSessions().find((x) => x.id === id);
  if (!s || !value) return;
  const key = dayKey(s.start);
  if (field === "start") {
    const t = atTime(key, value);
    const problem = s.end !== null && t > s.end ? "Start must be before the end."
      : t > Date.now() ? "Start cannot be in the future." : null;
    if (problem) {
      toast(problem);
      render();
      return;
    }
    s.start = t;
  } else {
    let t = atTime(key, value);
    if (t < s.start) t += 24 * HOUR;
    s.end = t;
  }
  s.updated = Date.now();
  commit();
}

function deleteSession(id) {
  tombstone(state.sessions, id, Date.now());
  commit();
}

function addEntry(clientId, startHM, endHM) {
  const start = atTime(viewDay, startHM);
  let end = atTime(viewDay, endHM);
  if (end <= start) end += 24 * HOUR;
  state.sessions.push({ id: uid(), clientId, start, end, updated: Date.now() });
  commit();
}

function setSetting(field, value) {
  if (state.settings[field] === value) return;
  state.settings[field] = value;
  state.settings.updated = Date.now();
  saveLocal();
  scheduleSync();
}

// Ask the browser not to evict our storage under disk pressure. Chrome decides
// silently from engagement; Firefox may ask once. Called at moments of intent.
function requestPersist() {
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().then(renderStorageNote).catch(() => {});
  }
}

/* ---------- merge ---------- */

// Newest record per id wins. Exact ties (same ms on two devices) fall back to
// comparing the records' JSON so both devices pick the same one and settle.
function newer(a, b) {
  if (a.updated !== b.updated) return a.updated > b.updated ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

function mergeLists(x, y) {
  const m = new Map(x.map((r) => [r.id, r]));
  for (const r of y) m.set(r.id, m.has(r.id) ? newer(m.get(r.id), r) : r);
  return [...m.values()];
}

function merge(a, b) {
  return settleRunning(normalise({
    clients: mergeLists(a.clients, b.clients),
    sessions: mergeLists(a.sessions, b.sessions),
    settings: newer(a.settings, b.settings),
  }));
}

// Two devices can each start a different timer before they sync. With overlap
// off, the earlier one stops where the later one began. Deterministic, so both
// devices reach the same answer without another round trip.
function settleRunning(st) {
  if (st.settings.allowOverlap) return st;
  const ids = new Set(st.clients.filter((c) => !c.deleted).map((c) => c.id));
  const live = st.sessions
    .filter((s) => !s.deleted && s.end === null && ids.has(s.clientId))
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < live.length - 1; i++) {
    live[i].end = Math.max(live[i].start, live[i + 1].start);
    live[i].updated = Math.max(live[i].updated, live[i + 1].updated);
  }
  return st;
}

const sameData = (a, b) => JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));

/* ---------- bytes ---------- */

const te = new TextEncoder();
const td = new TextDecoder();

function toB64u(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64u(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function squeeze(bytes, format) {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unsqueeze(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const loaded = new Map();
function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `${src}?v=${BUILD}`;
      s.onload = resolve;
      s.onerror = () => {
        loaded.delete(src);
        reject(new Error(`could not load ${src}`));
      };
      document.head.append(s);
    }));
  }
  return loaded.get(src);
}

/* ---------- encrypted sync ---------- */
//
// The passphrase never leaves the browser. PBKDF2 stretches it into 512 bits:
// the first half is the access key the server files the mailbox under (it
// stores only a hash of it), the second half is the AES-GCM key that encrypts
// the data. The server can neither read the blob nor work back to either key.

const KDF_SALT = te.encode("billable.chrislawrence.ca/sync/v1");
const KDF_ROUNDS = 600000;
const AAD = te.encode("billable-sync-v1");
const PHRASE_WORDS = 6;

let sync = loadSync();
let aesKey = null;
let syncBusy = null;
let syncQueued = false;
let syncTimer = null;
let syncError = "";
let phraseShown = false;

function loadSync() {
  try {
    const s = JSON.parse(localStorage.getItem(SYNC_KEY) || "null");
    return s && typeof s.access === "string" && typeof s.key === "string" ? s : null;
  } catch {
    return null;
  }
}

function saveSync() {
  if (sync) localStorage.setItem(SYNC_KEY, JSON.stringify(sync));
  else localStorage.removeItem(SYNC_KEY);
}

// Case, spacing and punctuation do not matter, so "Maple-River copper" and
// "maple river copper" are the same passphrase.
function normalisePhrase(p) {
  return p.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function phraseProblem(p) {
  const n = normalisePhrase(p);
  if (n.split(" ").length < 4 || n.length < 20) return "Use at least 4 words and 20 characters.";
  return null;
}

async function generatePhrase() {
  await loadScript("/words.js");
  const words = window.BILLABLE_WORDS;
  // Rejection sampling keeps every word equally likely.
  const limit = Math.floor(2 ** 32 / words.length) * words.length;
  const out = [];
  while (out.length < PHRASE_WORDS) {
    const [r] = crypto.getRandomValues(new Uint32Array(1));
    if (r < limit) out.push(words[r % words.length]);
  }
  return out.join(" ");
}

async function deriveSync(phrase) {
  const base = await crypto.subtle.importKey("raw", te.encode(normalisePhrase(phrase)), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: KDF_SALT, iterations: KDF_ROUNDS }, base, 512));
  const access = [...bits.subarray(0, 32)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { access, key: toB64u(bits.subarray(32)) };
}

async function getAesKey() {
  if (!aesKey) aesKey = await crypto.subtle.importKey("raw", fromB64u(sync.key), "AES-GCM", false, ["encrypt", "decrypt"]);
  return aesKey;
}

// Blob format "1.<z|n>.<iv>.<ciphertext>": version, gzip or not, base64url parts.
async function encryptState(st) {
  let bytes = te.encode(JSON.stringify(normalise(st)));
  const z = await squeeze(bytes, "gzip");
  if (z) bytes = z;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, await getAesKey(), bytes));
  return `1.${z ? "z" : "n"}.${toB64u(iv)}.${toB64u(ct)}`;
}

async function decryptState(blob) {
  const [v, flag, iv, ct] = blob.split(".");
  if (v !== "1") throw new Error("synced data is from a newer version; reload the page");
  let bytes = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64u(iv), additionalData: AAD }, await getAesKey(), fromB64u(ct)));
  if (flag === "z") bytes = await unsqueeze(bytes, "gzip");
  return normalise(JSON.parse(td.decode(bytes)));
}

function api(method, access, body) {
  const headers = { Authorization: `Bearer ${access}` };
  if (body) headers["Content-Type"] = "application/json";
  return fetch("/api/sync", { method, headers, body: body && JSON.stringify(body), cache: "no-store" });
}

async function failure(res) {
  try {
    const j = await res.json();
    if (j.error) return j.error;
  } catch { /* not JSON */ }
  return `server said ${res.status}`;
}

function scheduleSync(delay = 800) {
  if (!sync) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, delay);
}

// Pull, merge, and push only if the merge changed anything. The server refuses
// a push whose revision is stale (409), which means another device got there
// first: go round again and merge their change in too.
function syncNow() {
  clearTimeout(syncTimer);
  syncTimer = null;
  if (!sync) return Promise.resolve();
  if (syncBusy) {
    syncQueued = true;
    return syncBusy;
  }
  syncBusy = (async () => {
    renderSync();
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const got = await api("GET", sync.access);
        let rev = 0;
        let remote = null;
        if (got.status === 200) {
          const j = await got.json();
          rev = j.rev;
          remote = await decryptState(j.blob);
        } else if (got.status !== 404) {
          throw new Error(await failure(got));
        }
        const merged = remote ? merge(state, remote) : normalise(state);
        if (!sameData(merged, state)) {
          state = merged;
          saveLocal();
          render();
        }
        if (remote && sameData(merged, remote)) {
          done(rev);
          return;
        }
        const put = await api("PUT", sync.access, { rev, blob: await encryptState(merged) });
        if (put.status === 409) continue;
        if (!put.ok) throw new Error(await failure(put));
        done((await put.json()).rev);
        return;
      }
      throw new Error("another device kept saving at the same moment; will retry");
    } catch (e) {
      syncError = e instanceof TypeError ? "offline, will retry" : e.message || String(e);
    } finally {
      syncBusy = null;
      renderSync();
      if (syncQueued) {
        syncQueued = false;
        scheduleSync(200);
      }
    }
  })();
  return syncBusy;

  function done(rev) {
    if (!sync) return;
    sync.rev = rev;
    sync.last = Date.now();
    syncError = "";
    saveSync();
  }
}

// mode: "new" (generated here), "own" (user-chosen, may create), "join" (must exist).
async function connect(phrase, mode) {
  if (!window.crypto || !crypto.subtle) {
    toast("Sync needs the secure address: https://billable.chrislawrence.ca");
    return false;
  }
  setSyncWorking("Unlocking…");
  try {
    const keys = await deriveSync(phrase);
    const probe = await api("GET", keys.access);
    if (probe.status !== 200 && probe.status !== 404) throw new Error(await failure(probe));
    if (mode === "join" && probe.status === 404) {
      toast("No synced data found for that passphrase. Check the words and try again.");
      return false;
    }
    sync = { phrase: normalisePhrase(phrase), access: keys.access, key: keys.key, rev: 0, last: 0 };
    aesKey = null;
    syncError = "";
    phraseShown = false;
    saveSync();
    requestPersist();
    await syncNow();
    render();
    if (syncError) toast(`Connected, but the first sync failed: ${syncError}`);
    else toast(probe.status === 200 ? "Connected. This device now has your synced data." : "Sync is on. Use the same passphrase on your other devices.");
    return true;
  } catch (e) {
    toast(`Could not connect: ${e.message || e}`);
    return false;
  } finally {
    setSyncWorking("");
  }
}

function disconnect() {
  sync = null;
  aesKey = null;
  syncError = "";
  saveSync();
  $("sync-qr").hidden = true;
  render();
}

function linkFor(phrase) {
  return `${location.origin}/#sync=${phrase.split(" ").join("-")}`;
}

/* ---------- QR codes ---------- */

const SVG_NS = "http://www.w3.org/2000/svg";

// Built from the module grid as one SVG path, rather than the library's own
// SVG/GIF helpers, so nothing is injected as HTML and the strict CSP holds.
async function renderQR(container, text, label) {
  await loadScript("/vendor/qrcode-2.0.4.js");
  const qr = window.qrcode(0, "L");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const pad = 4;
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + pad} ${r + pad}h1v1h-1z`;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${n + pad * 2} ${n + pad * 2}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("width", "100%");
  bg.setAttribute("height", "100%");
  bg.setAttribute("fill", "#fff");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000");
  svg.append(bg, path);
  container.replaceChildren(svg);
}

/* ---------- transfer without sync ---------- */
//
// The data itself rides in the link after "#", which browsers never send to a
// server. Compact form: client names, plus sessions as [client index, start
// minute offset, duration minutes or -1 while running], deflated, base64url.

const TRANSFER_MAX = 1400; // characters; beyond this a QR code gets hard to scan off a screen

async function transferLink(days) {
  const now = Date.now();
  const since = dayBounds(shiftDay(dayKey(now), -(days - 1)))[0];
  const sessions = liveSessions().filter((s) => (s.end === null ? now : s.end) > since);
  const wanted = new Set(activeClients().map((c) => c.id));
  for (const s of sessions) wanted.add(s.clientId);
  const clients = liveClients().filter((c) => wanted.has(c.id));
  const index = new Map(clients.map((c, i) => [c.id, i]));
  const base = sessions.length ? Math.floor(Math.min(...sessions.map((s) => s.start)) / 60e3) : 0;
  const payload = {
    v: 1,
    b: base,
    c: clients.map((c) => c.name),
    s: sessions.map((s) => [
      index.get(s.clientId),
      Math.floor(s.start / 60e3) - base,
      s.end === null ? -1 : Math.round((s.end - s.start) / 60e3),
    ]),
  };
  const raw = te.encode(JSON.stringify(payload));
  const z = await squeeze(raw, "deflate-raw");
  return { url: `${location.origin}/#import=${z ? "z" : "j"}${toB64u(z || raw)}`, clients: clients.length, sessions: sessions.length };
}

async function readTransfer(text) {
  const m = String(text).match(/#import=([zj])([A-Za-z0-9_-]+)/);
  if (!m) throw new Error("not a transfer link");
  let bytes = fromB64u(m[2]);
  if (m[1] === "z") bytes = await unsqueeze(bytes, "deflate-raw");
  const p = JSON.parse(td.decode(bytes));
  const int = (v) => Number.isInteger(v);
  if (p.v !== 1 || !int(p.b) || !Array.isArray(p.c) || !Array.isArray(p.s)) throw new Error("bad transfer data");
  p.c = p.c.map((n) => String(n).trim().slice(0, 80)).filter(Boolean);
  p.s = p.s.filter((x) => Array.isArray(x) && int(x[0]) && x[0] >= 0 && x[0] < p.c.length && int(x[1]) && int(x[2]) && x[2] >= -1);
  return p;
}

// Merges into what is here: clients match by name, and an entry for the same
// client starting in the same minute is treated as already present.
function applyTransfer(p) {
  const now = Date.now();
  let addedClients = 0;
  let addedSessions = 0;
  const ids = p.c.map((name) => {
    let c = liveClients().find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!c) {
      c = { id: uid(), name, archived: false, updated: now };
      state.clients.push(c);
      addedClients++;
    } else if (c.archived) {
      c.archived = false;
      c.updated = now;
    }
    return c.id;
  });
  for (const [ci, offset, dur] of p.s) {
    const clientId = ids[ci];
    const start = (p.b + offset) * 60e3;
    if (liveSessions().some((s) => s.clientId === clientId && Math.floor(s.start / 60e3) === p.b + offset)) continue;
    state.sessions.push({ id: uid(), clientId, start, end: dur < 0 ? null : start + dur * 60e3, updated: now });
    addedSessions++;
  }
  state = settleRunning(normalise(state));
  commit();
  return { addedClients, addedSessions };
}

/* ---------- output ---------- */

function summaryText(key) {
  const rows = summaryRows(key, Date.now());
  const lines = [`Hours for ${prettyDay(key)}`, ""];
  if (!rows.length) lines.push("No time recorded.");
  for (const r of rows) lines.push(`${r.client.name}: ${fmtHours(r.hours)} h`);
  const total = rows.reduce((a, r) => a + r.hours, 0);
  lines.push("", `Total: ${fmtHours(total)} h`, "(Rounded to the nearest 0.5 h per client.)");
  if (liveSessions().some((s) => s.end === null)) lines.push("Note: a timer was still running when this was generated.");
  return lines.join("\n");
}

function csvFor(key) {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const out = ["date,client,tracked_hours,hours"];
  for (const r of summaryRows(key, Date.now())) {
    out.push([key, q(r.client.name), (r.ms / HOUR).toFixed(2), fmtHours(r.hours)].join(","));
  }
  return out.join("\r\n") + "\r\n";
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied.`);
  } catch {
    // Clipboard API needs a secure context and permission; fall back to a selection copy.
    const ta = el("textarea", { class: "offscreen" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    toast(ok ? `${what} copied.` : "Copy failed; your browser blocked it.");
  }
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 4000);
}

/* ---------- rendering ---------- */

// Small element builder; text always goes through textContent, never HTML.
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "text") n.textContent = v;
    else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids) if (c != null) n.append(c);
  return n;
}

function renderClients(now) {
  const list = $("clients");
  const per = totalsFor(dayKey(now), now);
  const active = activeClients();
  list.replaceChildren();
  $("clients-empty").hidden = active.length > 0;

  for (const c of active) {
    const live = running(c.id);
    const ms = per.get(c.id) || 0;
    const meta = live
      ? el("div", { class: "client-meta" }, el("span", { class: "pulse", "aria-hidden": "true" }), `Running since ${clock(live.start)}`)
      : el("div", { class: "client-meta", text: ms ? `${fmtHours(roundHalf(ms))} h today` : "Not started today" });

    list.append(
      el("li", { class: "client" + (live ? " running" : "") },
        el("div", {}, el("div", { class: "client-name", text: c.name }), meta),
        el("div", { class: "client-time digits", "data-live": c.id, text: live ? fmtHMS(ms) : fmtHM(ms) }),
        el("button", {
          type: "button",
          class: "btn toggle " + (live ? "stop" : "start"),
          "aria-label": `${live ? "Stop" : "Start"} ${c.name}`,
          onclick: () => toggle(c.id),
          text: live ? "Stop" : "Start",
        }),
        el("div", { class: "client-tools" },
          el("button", { type: "button", class: "btn", onclick: () => renameClient(c.id), text: "Rename" }),
          el("button", { type: "button", class: "btn", onclick: () => archiveClient(c.id), text: "Remove" })))
    );
  }
}

function renderSummary(now) {
  const rows = summaryRows(viewDay, now);
  const body = $("summary").tBodies[0];
  body.replaceChildren();
  if (!rows.length) {
    body.append(el("tr", { class: "none" }, el("td", { colspan: "3", text: "No time recorded on this day." })));
  }
  for (const r of rows) {
    body.append(
      el("tr", {},
        el("td", {}, r.client.name,
          running(r.client.id) ? el("span", { class: "pulse trailing", title: "Timer running" }) : null),
        el("td", { class: "num", text: fmtHM(r.ms) }),
        el("td", { class: "num billable", text: fmtHours(r.hours) }))
    );
  }
  $("sum-exact").textContent = fmtHM(rows.reduce((a, r) => a + r.ms, 0));
  $("sum-rounded").textContent = fmtHours(rows.reduce((a, r) => a + r.hours, 0));
}

function renderLog(now) {
  const [from, to] = dayBounds(viewDay);
  const entries = liveSessions()
    .filter((s) => s.start < to && (s.end === null ? now : s.end) > from)
    .sort((a, b) => a.start - b.start);
  const log = $("log");
  log.replaceChildren();
  $("log-empty").hidden = entries.length > 0;

  for (const s of entries) {
    const c = clientById(s.clientId);
    const ms = (s.end === null ? now : s.end) - s.start;
    log.append(
      el("li", { class: "entry" },
        el("span", { class: "entry-client", title: c.name }, c.name + (c.archived ? " (removed)" : ""),
          s.start < from ? el("small", { text: " · from previous day" }) : null,
          s.end !== null && s.end > to ? el("small", { text: " · into next day" }) : null),
        el("input", { type: "time", value: clock(s.start), "aria-label": "Start time", onchange: (e) => editSession(s.id, "start", e.target.value) }),
        el("span", { class: "dash", text: "to" }),
        s.end === null
          ? el("span", { class: "live", text: "running" })
          : el("input", { type: "time", value: clock(s.end), "aria-label": "End time", onchange: (e) => editSession(s.id, "end", e.target.value) }),
        el("span", { class: "dur digits", "data-entry": s.id, text: fmtHM(ms) }),
        el("button", { type: "button", class: "btn btn-small btn-danger", "aria-label": "Delete entry", onclick: () => deleteSession(s.id), text: "✕" }))
    );
  }

  const sel = $("entry-client");
  const keep = sel.value;
  sel.replaceChildren(el("option", { value: "", text: "Client…", disabled: true, selected: true }));
  for (const c of activeClients()) sel.append(el("option", { value: c.id, text: c.name }));
  if (keep && activeClients().some((c) => c.id === keep)) sel.value = keep;
}

function renderSettings() {
  $("allow-overlap").checked = state.settings.allowOverlap;
  if (document.activeElement !== $("email-to")) $("email-to").value = state.settings.email;
  const gone = liveClients().filter((c) => c.archived);
  $("archived-wrap").hidden = gone.length === 0;
  const ul = $("archived");
  ul.replaceChildren();
  for (const c of gone) {
    ul.append(
      el("li", {},
        el("span", { text: c.name }),
        el("button", { type: "button", class: "btn btn-small", onclick: () => restoreClient(c.id), text: "Restore" }),
        el("button", { type: "button", class: "btn btn-small btn-danger", onclick: () => deleteClientForever(c.id), text: "Delete" }))
    );
  }
}

function renderStorageNote() {
  const note = $("storage-note");
  if (!navigator.storage || !navigator.storage.persisted) {
    note.textContent = "";
    return;
  }
  navigator.storage.persisted().then((yes) => {
    note.textContent = yes
      ? "This browser has agreed not to clear Billable's storage when space runs low."
      : "This browser may clear Billable's storage if the device runs low on space. Sync protects against that.";
  }).catch(() => {});
}

let syncWorking = "";
function setSyncWorking(msg) {
  syncWorking = msg;
  for (const b of document.querySelectorAll("#sync-off button")) b.disabled = !!msg;
  renderSync();
}

function renderSync() {
  const on = !!sync;
  $("sync-off").hidden = on;
  $("sync-on").hidden = !on;
  $("sync-working").textContent = syncWorking;
  $("sync-working").hidden = !syncWorking;
  const badge = $("sync-badge");
  badge.className = "fold-status" + (on ? (syncError ? " bad" : " good") : "");
  badge.textContent = !on ? "Off" : syncError ? "Problem" : syncBusy ? "Syncing…" : "On";
  if (!on) return;
  $("sync-status").textContent = syncError
    ? `Last sync failed: ${syncError}.`
    : syncBusy ? "Syncing…" : sync.last ? `Synced at ${clock(sync.last)}.` : "Not synced yet.";
  $("sync-status").className = "sync-status" + (syncError ? " bad" : "");
  $("sync-phrase").textContent = phraseShown ? sync.phrase : "•••••• ".repeat(6).trim();
  $("sync-show").textContent = phraseShown ? "Hide" : "Show";
}

// Safari (and every iOS browser built on it) deletes a site's storage after
// seven days without a visit, unless it runs as a Home Screen / Dock app.
function renderTip() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const macSafari = !ios && /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(ua);
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const show = (ios || macSafari) && !standalone && !sync && !localStorage.getItem(TIP_KEY);
  $("safari-tip").hidden = !show;
  if (!show) return;
  $("safari-tip-text").textContent = ios
    ? "Safari erases this site's data after 7 days without a visit. Add Billable to your Home Screen (Share, then Add to Home Screen) and open it from there, or turn on sync below. The Home Screen app starts with its own empty copy, so bring your data across with sync."
    : "Safari erases this site's data after 7 days without a visit. Turn on sync below, or use File, then Add to Dock, and open Billable from the Dock.";
}

function renderHeader(now) {
  const today = dayKey(now);
  $("today-label").textContent = prettyDay(today);
  const total = [...totalsFor(today, now).values()].reduce((a, b) => a + b, 0);
  $("today-total").textContent = fmtHM(total);
  $("day-pick").value = viewDay;
  $("day-pick").max = today;
  $("day-next").disabled = viewDay >= today;
  const anyLive = liveSessions().some((s) => s.end === null);
  document.title = anyLive ? `● ${fmtHM(total)} · Billable` : "Billable · hours per client";
}

function render() {
  const now = Date.now();
  renderHeader(now);
  renderClients(now);
  renderSummary(now);
  renderLog(now);
  renderSettings();
  renderSync();
  renderTip();
}

// Once a second, update only the numbers that move, so typing in a field is
// never interrupted by a re-render. A full render happens on the minute so
// the summary and the day rollover stay current.
let lastMinute = -1;
let lastDay = dayKey(Date.now());
function tick() {
  const now = Date.now();
  const today = dayKey(now);
  if (today !== lastDay) {
    if (viewDay === lastDay) viewDay = today;
    lastDay = today;
  }
  const minute = Math.floor(now / 60e3);
  const editing = document.activeElement && document.activeElement.matches("input, select");
  if (minute !== lastMinute && !editing) {
    lastMinute = minute;
    render();
    return;
  }
  const sessions = liveSessions();
  if (!sessions.some((s) => s.end === null)) return;
  const per = totalsFor(today, now);
  for (const node of document.querySelectorAll("[data-live]")) {
    const id = node.dataset.live;
    if (sessions.some((s) => s.clientId === id && s.end === null)) node.textContent = fmtHMS(per.get(id) || 0);
  }
  for (const node of document.querySelectorAll("[data-entry]")) {
    const s = sessions.find((x) => x.id === node.dataset.entry);
    if (s && s.end === null) node.textContent = fmtHM(now - s.start);
  }
  $("today-total").textContent = fmtHM([...per.values()].reduce((a, b) => a + b, 0));
}

/* ---------- links opened from a QR code or message ---------- */

async function handleHash() {
  const h = location.hash;
  if (!h.startsWith("#sync=") && !h.startsWith("#import=")) return;
  // Drop the secret from the address bar and history before anything else.
  history.replaceState(null, "", location.pathname + location.search);

  if (h.startsWith("#sync=")) {
    const phrase = normalisePhrase(decodeURIComponent(h.slice(6)));
    if (sync && sync.phrase === phrase) {
      toast("This device is already syncing with that passphrase.");
      return;
    }
    const ask = sync
      ? "Switch this device to the passphrase from the link? What is on this device is merged in."
      : "Turn on sync with the passphrase from the link? What is on this device is merged in.";
    if (!confirm(ask)) return;
    $("sync-wrap").open = true;
    await connect(phrase, "join");
    return;
  }

  try {
    const p = await readTransfer(h);
    if (!confirm(`Add ${p.c.length} client(s) and ${p.s.length} time entr${p.s.length === 1 ? "y" : "ies"} from the transfer link to this device?`)) return;
    const r = applyTransfer(p);
    toast(`Added ${r.addedClients} new client(s) and ${r.addedSessions} entr${r.addedSessions === 1 ? "y" : "ies"}.`);
  } catch {
    toast("That transfer link is damaged or incomplete.");
  }
}

/* ---------- wiring ---------- */

$("add-client").addEventListener("submit", (e) => {
  e.preventDefault();
  addClient($("client-name").value);
  $("client-name").value = "";
  $("client-name").focus();
});

$("day-prev").addEventListener("click", () => { viewDay = shiftDay(viewDay, -1); render(); });
$("day-next").addEventListener("click", () => { viewDay = shiftDay(viewDay, 1); render(); });
$("day-today").addEventListener("click", () => { viewDay = dayKey(Date.now()); render(); });
$("day-pick").addEventListener("change", (e) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { viewDay = e.target.value; render(); }
});

$("email-to").addEventListener("change", (e) => setSetting("email", e.target.value.trim()));

$("email-btn").addEventListener("click", () => {
  setSetting("email", $("email-to").value.trim());
  const subject = `Hours ${viewDay}`;
  const to = state.settings.email.split(/[,;\s]+/).filter(Boolean).map(encodeURIComponent).join(",");
  location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(summaryText(viewDay))}`;
});

$("copy-btn").addEventListener("click", () => copyText(summaryText(viewDay), "Summary"));

$("csv-btn").addEventListener("click", () => download(`billable-${viewDay}.csv`, csvFor(viewDay), "text/csv"));

$("add-entry").addEventListener("submit", (e) => {
  e.preventDefault();
  const client = $("entry-client").value;
  const a = $("entry-start").value;
  const b = $("entry-end").value;
  if (!client || !a || !b) return toast("Pick a client and both times.");
  addEntry(client, a, b);
  $("entry-start").value = "";
  $("entry-end").value = "";
});

$("allow-overlap").addEventListener("change", (e) => setSetting("allowOverlap", e.target.checked));

$("export-btn").addEventListener("click", () =>
  download(`billable-backup-${dayKey(Date.now())}.json`, JSON.stringify(state, null, 2), "application/json"));

$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const incoming = normalise(JSON.parse(await file.text()));
    if (!incoming.clients.some((c) => !c.deleted)) return toast("That file has no clients in it.");
    if (!confirm("Merge the backup into what is on this device? Entries in both are kept once.")) return;
    state = merge(state, incoming);
    commit();
    toast("Backup merged.");
  } catch {
    toast("Could not read that file as a Billable backup.");
  }
});

$("wipe-btn").addEventListener("click", () => {
  const ask = sync
    ? "Erase every client and time entry? Sync is on, so this also erases them on your other devices."
    : "Erase every client and time entry stored in this browser?";
  if (!confirm(ask)) return;
  const now = Date.now();
  state.clients = state.clients.map((c) => ({ id: c.id, deleted: true, updated: now }));
  state.sessions = state.sessions.map((s) => ({ id: s.id, deleted: true, updated: now }));
  commit();
});

// Sync: create
$("sync-create").addEventListener("click", async () => {
  $("sync-new-phrase").textContent = await generatePhrase();
  $("sync-new-saved").checked = false;
  $("sync-new-start").disabled = true;
  $("sync-new").hidden = false;
});
$("sync-new-again").addEventListener("click", async () => {
  $("sync-new-phrase").textContent = await generatePhrase();
});
$("sync-new-copy").addEventListener("click", () => copyText($("sync-new-phrase").textContent, "Passphrase"));
$("sync-new-saved").addEventListener("change", (e) => { $("sync-new-start").disabled = !e.target.checked; });
$("sync-new-start").addEventListener("click", async () => {
  if (await connect($("sync-new-phrase").textContent, "new")) $("sync-new").hidden = true;
});

// Sync: join with an existing passphrase
$("sync-join").addEventListener("submit", async (e) => {
  e.preventDefault();
  const phrase = $("sync-join-phrase").value;
  if (!normalisePhrase(phrase)) return;
  if (await connect(phrase, "join")) $("sync-join-phrase").value = "";
});

// Sync: choose your own
$("sync-own").addEventListener("submit", async (e) => {
  e.preventDefault();
  const phrase = $("sync-own-phrase").value;
  const problem = phraseProblem(phrase);
  if (problem) return toast(problem);
  if (await connect(phrase, "own")) $("sync-own-phrase").value = "";
});

$("sync-show").addEventListener("click", () => { phraseShown = !phraseShown; renderSync(); });
$("sync-now").addEventListener("click", () => syncNow());
$("sync-qr-btn").addEventListener("click", async () => {
  const box = $("sync-qr");
  if (!box.hidden) {
    box.hidden = true;
    return;
  }
  await renderQR($("sync-qr-code"), linkFor(sync.phrase), "QR code that connects another device to sync");
  box.hidden = false;
});
$("sync-off-btn").addEventListener("click", () => {
  if (!confirm("Stop syncing on this device? Your data stays here, and other devices keep syncing.")) return;
  disconnect();
});
$("sync-delete").addEventListener("click", async () => {
  if (!confirm("Delete the encrypted copy from the server and stop syncing on this device? Data on your devices stays. A device still syncing with this passphrase will upload its copy again; turn sync off there too.")) return;
  try {
    const res = await api("DELETE", sync.access);
    if (!res.ok && res.status !== 404) throw new Error(await failure(res));
    disconnect();
    toast("Server copy deleted. Sync is off on this device.");
  } catch (e) {
    toast(`Could not delete: ${e.message || e}`);
  }
});

// Transfer without sync
$("move-make").addEventListener("click", async () => {
  let t = null;
  let days = 0;
  for (days of [30, 14, 7, 1]) {
    t = await transferLink(days);
    if (t.url.length <= TRANSFER_MAX) break;
  }
  if (t.url.length > TRANSFER_MAX) {
    toast("Too much data for a QR code. Use sync, or Export backup under Settings.");
    return;
  }
  await renderQR($("move-qr"), t.url, "QR code that copies your data to another device");
  $("move-box").hidden = false;
  $("move-box").dataset.url = t.url;
  $("move-note").textContent =
    `Carries ${t.clients} client(s) and ${t.sessions} entr${t.sessions === 1 ? "y" : "ies"} from the last ${days === 1 ? "day" : `${days} days`}. ` +
    "Scan it with the other device's camera. Sending the link by message or email puts its contents on that service.";
});
$("move-copy").addEventListener("click", () => copyText($("move-box").dataset.url, "Transfer link"));
$("move-paste").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const p = await readTransfer($("move-link").value);
    const r = applyTransfer(p);
    $("move-link").value = "";
    toast(`Added ${r.addedClients} new client(s) and ${r.addedSessions} entr${r.addedSessions === 1 ? "y" : "ies"}.`);
  } catch {
    toast("That doesn't look like a complete transfer link.");
  }
});

$("safari-tip-close").addEventListener("click", () => {
  localStorage.setItem(TIP_KEY, "1");
  renderTip();
});

render();
renderStorageNote();
handleHash();
window.addEventListener("hashchange", handleHash);
setInterval(tick, 1000);
// Poll while visible so a timer started on the phone shows up on the laptop.
setInterval(() => { if (sync && !document.hidden) syncNow(); }, 30000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (syncTimer) syncNow(); // push a pending change before the tab is backgrounded
  } else {
    render();
    if (sync) syncNow();
  }
});
window.addEventListener("online", () => { if (sync) syncNow(); });
if (sync) syncNow();
