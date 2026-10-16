// The page: storage, rendering and event wiring. The rules live in model.js,
// crypto.js, transfer.js and sync.js, which are pure enough to unit test;
// this file is the thin layer that connects them to the DOM.

import {
  activeClients, atTime, clientById, clientByName, clock, csvFor, dayBounds, dayKey, endAfter,
  existingClients, existingSessions, fmtHM, fmtHMS, fmtHours, merge, newId, normalise, prettyDay, roundHalf,
  runningFor, shiftDay, summaryRows, summaryText, totalsFor,
} from "./model.js";
import { KDF_VERSION, deriveKeys, generatePhrase, normalisePhrase, phraseProblem } from "./crypto.js";
import { createSyncer, mailboxClient } from "./sync.js";
import { applyTransfer, buildTransfer, decodeTransfer, encodeTransfer } from "./transfer.js";

const STATE_KEY = "billable.v1";
const SYNC_KEY = "billable.sync";
const TIP_KEY = "billable.tip-dismissed";
const BUILD = document.querySelector('meta[name="build"]').content;
const TRANSFER_MAX = 1400; // link characters; beyond this a QR code is hard to scan off a screen

const $ = (id) => document.getElementById(id);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* ---------- storage ---------- */

// localStorage can throw: quota exceeded, storage disabled, some private modes.
const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch { /* nothing to do */ }
  },
};

function loadState() {
  const raw = storage.get(STATE_KEY);
  if (!raw) return normalise({});
  try {
    return normalise(JSON.parse(raw));
  } catch {
    // Never overwrite data we could not read: park it where it can be recovered.
    storage.set(`${STATE_KEY}.unreadable-${Date.now()}`, raw);
    return normalise({});
  }
}

let state = loadState();
let viewDay = dayKey(Date.now());
let saveWarned = false;

function saveState() {
  if (storage.set(STATE_KEY, JSON.stringify(state))) {
    saveWarned = false;
  } else if (!saveWarned) {
    saveWarned = true;
    toast("Couldn't save on this device: browser storage is full or blocked.");
  }
}

// Every user edit ends here: store, redraw, and push to other devices.
function commit() {
  state = normalise(state);
  saveState();
  render();
  scheduleSync();
}

// Ask the browser not to evict our storage under disk pressure. Chrome decides
// silently from engagement; Firefox may ask once. Called at moments of intent.
function requestPersist() {
  navigator.storage?.persist?.().then(renderStorageNote).catch(() => {});
}

/* ---------- actions ---------- */

function addClient(name) {
  name = name.trim().slice(0, 80);
  if (!name) return;
  const same = clientByName(state, name);
  if (same && !same.archived) return toast(`${same.name} is already in the list.`);
  if (same) {
    // Re-adding a removed client brings it, and its history, back.
    same.archived = false;
    same.updated = Date.now();
    toast(`${same.name} is back.`);
  } else {
    state.clients.push({ id: newId(), name, archived: false, updated: Date.now() });
  }
  commit();
  requestPersist();
}

// Stopping uses max(now, start): the timer may have been started on a device
// whose clock runs ahead of this one.
function stop(session, now) {
  session.end = Math.max(now, session.start);
  session.updated = now;
}

function toggle(clientId) {
  const now = Date.now();
  const running = runningFor(state, clientId);
  if (running) {
    stop(running, now);
  } else {
    if (!state.settings.allowOverlap) {
      for (const s of existingSessions(state)) if (s.end === null) stop(s, now);
    }
    state.sessions.push({ id: newId(now), clientId, start: now, end: null, updated: now });
  }
  commit();
}

function renameClient(clientId) {
  const c = clientById(state, clientId);
  const name = prompt("Client name", c.name)?.trim();
  if (!name) return;
  const clash = clientByName(state, name);
  if (clash && clash.id !== clientId) return toast(`There is already a client called ${clash.name}.`);
  c.name = name.slice(0, 80);
  c.updated = Date.now();
  commit();
}

function archiveClient(clientId) {
  const now = Date.now();
  const c = clientById(state, clientId);
  const running = runningFor(state, clientId);
  if (running) stop(running, now);
  c.archived = true;
  c.updated = now;
  commit();
  toast(`Removed ${c.name}. Past hours are kept; add the name again to bring it back.`);
}

function restoreClient(clientId) {
  const c = clientById(state, clientId);
  c.archived = false;
  c.updated = Date.now();
  commit();
}

function tombstone(list, id, now) {
  const i = list.findIndex((r) => r.id === id);
  if (i >= 0) list[i] = { id, deleted: true, updated: now };
}

function deleteClientForever(clientId) {
  const c = clientById(state, clientId);
  if (!confirm(`Delete "${c.name}" and all of its recorded time? This cannot be undone.`)) return;
  const now = Date.now();
  for (const s of existingSessions(state).filter((x) => x.clientId === clientId)) tombstone(state.sessions, s.id, now);
  tombstone(state.clients, clientId, now);
  commit();
}

function editSession(id, field, hhmm) {
  const s = existingSessions(state).find((x) => x.id === id);
  if (!s || !hhmm) return;
  if (field === "start") {
    const start = atTime(dayKey(s.start), hhmm);
    const problem = s.end !== null && start > s.end ? "Start must be before the end."
      : start > Date.now() ? "Start cannot be in the future." : null;
    if (problem) {
      toast(problem);
      render();
      return;
    }
    s.start = start;
  } else {
    s.end = endAfter(s.start, hhmm);
  }
  s.updated = Date.now();
  commit();
}

function deleteSession(id) {
  tombstone(state.sessions, id, Date.now());
  commit();
}

function addEntry(clientId, startHM, endHM) {
  if (startHM === endHM) return toast("Start and end are the same time.");
  const start = atTime(viewDay, startHM);
  if (start > Date.now()) return toast("Start cannot be in the future.");
  state.sessions.push({ id: newId(), clientId, start, end: endAfter(start, endHM), updated: Date.now() });
  commit();
  $("entry-start").value = "";
  $("entry-end").value = "";
}

function setSetting(field, value) {
  if (state.settings[field] === value) return;
  state.settings[field] = value;
  state.settings.updated = Date.now();
  saveState();
  scheduleSync();
}

/* ---------- sync wiring ---------- */

let sync = null;      // { v, phrase, access, key } from storage, or null
let syncer = null;    // the engine for that config
let syncTimer = null;
let syncWorking = ""; // "Unlocking…" while deriving keys
let phraseShown = false;

function loadSyncConfig() {
  try {
    const c = JSON.parse(storage.get(SYNC_KEY) || "null");
    return c && typeof c.phrase === "string" ? c : null;
  } catch {
    return null;
  }
}

function useSync(config) {
  sync = config;
  syncer = config && createSyncer({
    config,
    getState: () => state,
    setState: (next) => {
      state = next;
      saveState();
      render();
    },
    onStatus: renderSync,
  });
  if (config) storage.set(SYNC_KEY, JSON.stringify(config));
  else storage.remove(SYNC_KEY);
}

async function keysFor(phrase) {
  const keys = await deriveKeys(phrase);
  return { v: KDF_VERSION, phrase: normalisePhrase(phrase), ...keys };
}

function scheduleSync(delay = 800) {
  if (!syncer) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, delay);
}

function syncNow() {
  clearTimeout(syncTimer);
  syncTimer = null;
  return syncer ? syncer.sync() : Promise.resolve();
}

// mode "join" requires synced data to exist already; "create" will start it.
async function connect(phrase, mode) {
  if (!crypto.subtle) {
    toast("Sync needs a secure (https) address.");
    return false;
  }
  setSyncWorking("Unlocking…");
  try {
    const config = await keysFor(phrase);
    const existing = await mailboxClient(config.access).get();
    if (mode === "join" && !existing) {
      toast("No synced data found for that passphrase. Check the words and try again.");
      return false;
    }
    phraseShown = false;
    useSync(config);
    requestPersist();
    await syncNow();
    render();
    if (syncer.status.error) toast(`Connected, but the first sync failed: ${syncer.status.error}.`);
    else toast(existing ? "Connected. This device now has your synced data." : "Sync is on. Use the same passphrase on your other devices.");
    return true;
  } catch (e) {
    toast(`Could not connect: ${e.message || e}`);
    return false;
  } finally {
    setSyncWorking("");
  }
}

const syncLink = (phrase) => `${location.origin}/#sync=${phrase.split(" ").join("-")}`;

/* ---------- QR codes ---------- */

const loaded = new Map();
function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `${src}?v=${BUILD}`;
      s.onload = resolve;
      s.onerror = () => {
        loaded.delete(src);
        reject(new Error("could not load part of the page; check your connection"));
      };
      document.head.append(s);
    }));
  }
  return loaded.get(src);
}

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

/* ---------- transfer ---------- */

async function makeTransferLink() {
  for (const days of [30, 14, 7, 1]) {
    const t = buildTransfer(state, Date.now(), days);
    const url = await encodeTransfer(t.payload, location.origin);
    if (url.length <= TRANSFER_MAX) return { ...t, url, days };
  }
  return null;
}

function importTransfer(transfer) {
  const result = applyTransfer(state, transfer, Date.now(), () => newId());
  state = result.state;
  commit();
  toast(`Added ${plural(result.addedClients, "new client", "new clients")} and ${plural(result.addedSessions, "entry", "entries")}.`);
}

/* ---------- small helpers ---------- */

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied.`);
  } catch {
    // The Clipboard API needs permission; fall back to a selection copy.
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

// Wraps an async event handler so a failure is shown rather than swallowed.
const guarded = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (e) {
    toast(e.message || String(e));
  }
};

// Small element builder; text always goes through textContent, never HTML.
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "text") n.textContent = v;
    else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
  }
  n.append(...kids.filter((c) => c != null));
  return n;
}

/* ---------- rendering ---------- */

function renderHeader(now) {
  const today = dayKey(now);
  const total = [...totalsFor(state, today, now).values()].reduce((a, b) => a + b, 0);
  $("today-label").textContent = prettyDay(today);
  $("today-total").textContent = fmtHM(total);
  $("day-pick").value = viewDay;
  $("day-pick").max = today;
  $("day-next").disabled = viewDay >= today;
  const anyRunning = existingSessions(state).some((s) => s.end === null);
  document.title = anyRunning ? `● ${fmtHM(total)} · Billable` : "Billable · hours per client";
}

function renderClients(now) {
  const per = totalsFor(state, dayKey(now), now);
  const active = activeClients(state);
  $("clients-empty").hidden = active.length > 0;
  $("clients").replaceChildren(...active.map((c) => {
    const running = runningFor(state, c.id);
    const ms = per.get(c.id) || 0;
    const meta = running
      ? el("div", { class: "client-meta" }, el("span", { class: "pulse", "aria-hidden": "true" }), `Running since ${clock(running.start)}`)
      : el("div", { class: "client-meta", text: ms ? `${fmtHours(roundHalf(ms))} h today` : "Not started today" });
    return el("li", { class: `client${running ? " running" : ""}` },
      el("div", {}, el("div", { class: "client-name", text: c.name }), meta),
      el("div", { class: "client-time digits", "data-live": c.id, text: running ? fmtHMS(ms) : fmtHM(ms) }),
      el("button", {
        type: "button",
        class: `btn toggle ${running ? "stop" : "start"}`,
        "aria-label": `${running ? "Stop" : "Start"} ${c.name}`,
        onclick: () => toggle(c.id),
        text: running ? "Stop" : "Start",
      }),
      el("div", { class: "client-tools" },
        el("button", { type: "button", class: "btn", onclick: () => renameClient(c.id), text: "Rename" }),
        el("button", { type: "button", class: "btn", onclick: () => archiveClient(c.id), text: "Remove" })));
  }));
}

function renderSummary(now) {
  const rows = summaryRows(state, viewDay, now);
  const body = $("summary").tBodies[0];
  if (!rows.length) {
    body.replaceChildren(el("tr", { class: "none" }, el("td", { colspan: "3", text: "No time recorded on this day." })));
  } else {
    body.replaceChildren(...rows.map((r) => el("tr", {},
      el("td", {}, r.client.name,
        runningFor(state, r.client.id) ? el("span", { class: "pulse trailing", title: "Timer running" }) : null),
      el("td", { class: "num", text: fmtHM(r.ms) }),
      el("td", { class: "num billable", text: fmtHours(r.hours) }))));
  }
  $("sum-exact").textContent = fmtHM(rows.reduce((a, r) => a + r.ms, 0));
  $("sum-rounded").textContent = fmtHours(rows.reduce((a, r) => a + r.hours, 0));
}

function renderLog(now) {
  const [from, to] = dayBounds(viewDay);
  const entries = existingSessions(state)
    .filter((s) => s.start < to && (s.end === null ? now : s.end) > from)
    .sort((a, b) => a.start - b.start);
  $("log-empty").hidden = entries.length > 0;
  $("log").replaceChildren(...entries.map((s) => {
    const c = clientById(state, s.clientId);
    return el("li", { class: "entry" },
      el("span", { class: "entry-client", title: c.name }, c.name + (c.archived ? " (removed)" : ""),
        s.start < from ? el("small", { text: " · from previous day" }) : null,
        s.end !== null && s.end > to ? el("small", { text: " · into next day" }) : null),
      el("input", { type: "time", value: clock(s.start), "aria-label": "Start time", onchange: (e) => editSession(s.id, "start", e.target.value) }),
      el("span", { class: "dash", text: "to" }),
      s.end === null
        ? el("span", { class: "live", text: "running" })
        : el("input", { type: "time", value: clock(s.end), "aria-label": "End time", onchange: (e) => editSession(s.id, "end", e.target.value) }),
      el("span", { class: "dur digits", "data-entry": s.id, text: fmtHM((s.end === null ? now : s.end) - s.start) }),
      el("button", { type: "button", class: "btn btn-small btn-danger", "aria-label": "Delete entry", onclick: () => deleteSession(s.id), text: "✕" }));
  }));

  const select = $("entry-client");
  const keep = select.value;
  select.replaceChildren(
    el("option", { value: "", text: "Client…", disabled: true, selected: true }),
    ...activeClients(state).map((c) => el("option", { value: c.id, text: c.name })));
  if (activeClients(state).some((c) => c.id === keep)) select.value = keep;
}

function renderSettings() {
  $("allow-overlap").checked = state.settings.allowOverlap;
  if (document.activeElement !== $("email-to")) $("email-to").value = state.settings.email;
  const removed = existingClients(state).filter((c) => c.archived);
  $("archived-wrap").hidden = removed.length === 0;
  $("archived").replaceChildren(...removed.map((c) => el("li", {},
    el("span", { text: c.name }),
    el("button", { type: "button", class: "btn btn-small", onclick: () => restoreClient(c.id), text: "Restore" }),
    el("button", { type: "button", class: "btn btn-small btn-danger", onclick: () => deleteClientForever(c.id), text: "Delete" }))));
}

function renderStorageNote() {
  if (!navigator.storage?.persisted) return;
  navigator.storage.persisted().then((yes) => {
    $("storage-note").textContent = yes
      ? "This browser has agreed not to clear Billable's storage when space runs low."
      : "This browser may clear Billable's storage if the device runs low on space. Sync protects against that.";
  }).catch(() => {});
}

function setSyncWorking(msg) {
  syncWorking = msg;
  for (const b of document.querySelectorAll("#sync-off button")) b.disabled = !!msg;
  renderSync();
}

function renderSync() {
  const on = !!syncer;
  const status = syncer?.status;
  $("sync-off").hidden = on;
  $("sync-on").hidden = !on;
  $("sync-working").textContent = syncWorking;
  $("sync-working").hidden = !syncWorking;
  const badge = $("sync-badge");
  badge.className = `fold-status${on ? (status.error ? " bad" : " good") : ""}`;
  badge.textContent = !on ? "Off" : status.error ? "Problem" : status.busy ? "Syncing…" : "On";
  if (!on) return;
  const line = $("sync-status");
  line.textContent = status.error ? `Last sync failed: ${status.error}.`
    : status.busy ? "Syncing…" : status.last ? `Synced at ${clock(status.last)}.` : "Not synced yet.";
  line.className = `sync-status${status.error ? " bad" : ""}`;
  // A fixed mask, so the hidden passphrase does not give away its word lengths.
  $("sync-phrase").textContent = phraseShown ? sync.phrase : "•••••• ".repeat(6).trim();
  $("sync-show").textContent = phraseShown ? "Hide" : "Show";
}

// Safari, and every iOS browser built on it, deletes a site's storage after
// seven days without a visit, unless it runs as a Home Screen or Dock app.
function renderTip() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const macSafari = !ios && /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(ua);
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const show = (ios || macSafari) && !standalone && !syncer && !storage.get(TIP_KEY);
  $("safari-tip").hidden = !show;
  if (!show) return;
  $("safari-tip-text").textContent = ios
    ? "Safari erases this site's data after 7 days without a visit. Add Billable to your Home Screen (Share, then Add to Home Screen) and open it from there, or turn on sync below. The Home Screen app starts with its own empty copy, so bring your data across with sync."
    : "Safari erases this site's data after 7 days without a visit. Turn on sync below, or use File, then Add to Dock, and open Billable from the Dock.";
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
// never interrupted by a re-render. A full render happens each minute, which
// keeps the summary and the day rollover current.
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
  const editing = document.activeElement?.matches("input, select");
  if (minute !== lastMinute && !editing) {
    lastMinute = minute;
    render();
    return;
  }
  const running = existingSessions(state).filter((s) => s.end === null);
  if (!running.length) return;
  const per = totalsFor(state, today, now);
  for (const node of document.querySelectorAll("[data-live]")) {
    if (running.some((s) => s.clientId === node.dataset.live)) node.textContent = fmtHMS(per.get(node.dataset.live) || 0);
  }
  for (const node of document.querySelectorAll("[data-entry]")) {
    const s = running.find((x) => x.id === node.dataset.entry);
    if (s) node.textContent = fmtHM(now - s.start);
  }
  $("today-total").textContent = fmtHM([...per.values()].reduce((a, b) => a + b, 0));
}

/* ---------- links opened from a QR code or a message ---------- */

async function handleHash() {
  const h = location.hash;
  if (!h.startsWith("#sync=") && !h.startsWith("#import=")) return;
  // Drop the secret from the address bar and history before anything else.
  history.replaceState(null, "", location.pathname + location.search);

  if (h.startsWith("#sync=")) {
    const phrase = normalisePhrase(decodeURIComponent(h.slice(6)));
    if (sync?.phrase === phrase) return toast("This device is already syncing with that passphrase.");
    // A link like this can come from anyone, and joining shares this device's
    // data with whoever holds the passphrase. Say so before going ahead.
    const ok = confirm(
      "This link turns on sync with a passphrase.\n\n" +
      "Only continue if you made this link yourself, on your own device. Anyone who knows the passphrase can read everything this device then syncs." +
      (sync ? "\n\nThis replaces the passphrase this device uses now." : ""));
    if (!ok) return;
    $("sync-wrap").open = true;
    await connect(phrase, "join");
    return;
  }

  try {
    const t = await decodeTransfer(h);
    if (confirm(`Add ${plural(t.clients.length, "client", "clients")} and ${plural(t.sessions.length, "time entry", "time entries")} from the transfer link to this device?`)) {
      importTransfer(t);
    }
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
  const to = state.settings.email.split(/[,;\s]+/).filter(Boolean).map(encodeURIComponent).join(",");
  const subject = encodeURIComponent(`Hours ${viewDay}`);
  location.href = `mailto:${to}?subject=${subject}&body=${encodeURIComponent(summaryText(state, viewDay, Date.now()))}`;
});
$("copy-btn").addEventListener("click", () => copyText(summaryText(state, viewDay, Date.now()), "Summary"));
$("csv-btn").addEventListener("click", () => download(`billable-${viewDay}.csv`, csvFor(state, viewDay, Date.now()), "text/csv"));

$("add-entry").addEventListener("submit", (e) => {
  e.preventDefault();
  const client = $("entry-client").value;
  const start = $("entry-start").value;
  const end = $("entry-end").value;
  if (!client || !start || !end) return toast("Pick a client and both times.");
  addEntry(client, start, end);
});

$("allow-overlap").addEventListener("change", (e) => setSetting("allowOverlap", e.target.checked));

$("export-btn").addEventListener("click", () =>
  download(`billable-backup-${dayKey(Date.now())}.json`, JSON.stringify(state, null, 2), "application/json"));

$("import-file").addEventListener("change", guarded(async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let incoming;
  try {
    incoming = normalise(JSON.parse(await file.text()));
  } catch {
    return toast("Could not read that file as a Billable backup.");
  }
  if (!existingClients(incoming).length) return toast("That file has no clients in it.");
  if (!confirm("Merge the backup into what is on this device? Entries in both are kept once.")) return;
  state = merge(state, incoming);
  commit();
  toast("Backup merged.");
}));

$("wipe-btn").addEventListener("click", () => {
  const ask = syncer
    ? "Erase every client and time entry? Sync is on, so this also erases them on your other devices."
    : "Erase every client and time entry stored in this browser?";
  if (!confirm(ask)) return;
  const now = Date.now();
  state.clients = state.clients.map((c) => ({ id: c.id, deleted: true, updated: now }));
  state.sessions = state.sessions.map((s) => ({ id: s.id, deleted: true, updated: now }));
  commit();
});

// Sync: create a passphrase
async function showNewPhrase() {
  const { default: words } = await import(`./words.js?v=${BUILD}`);
  $("sync-new-phrase").textContent = generatePhrase(words);
}
$("sync-create").addEventListener("click", guarded(async () => {
  await showNewPhrase();
  $("sync-new-saved").checked = false;
  $("sync-new-start").disabled = true;
  $("sync-new").hidden = false;
}));
$("sync-new-again").addEventListener("click", guarded(showNewPhrase));
$("sync-new-copy").addEventListener("click", () => copyText($("sync-new-phrase").textContent, "Passphrase"));
$("sync-new-saved").addEventListener("change", (e) => { $("sync-new-start").disabled = !e.target.checked; });
$("sync-new-start").addEventListener("click", async () => {
  if (await connect($("sync-new-phrase").textContent, "create")) $("sync-new").hidden = true;
});

// Sync: join with a passphrase from another device
$("sync-join").addEventListener("submit", async (e) => {
  e.preventDefault();
  const phrase = $("sync-join-phrase").value;
  if (normalisePhrase(phrase) && (await connect(phrase, "join"))) $("sync-join-phrase").value = "";
});

// Sync: choose your own passphrase
$("sync-own").addEventListener("submit", async (e) => {
  e.preventDefault();
  const phrase = $("sync-own-phrase").value;
  const problem = phraseProblem(phrase);
  if (problem) return toast(problem);
  if (await connect(phrase, "create")) $("sync-own-phrase").value = "";
});

$("sync-show").addEventListener("click", () => { phraseShown = !phraseShown; renderSync(); });
$("sync-now").addEventListener("click", () => syncNow());
$("sync-qr-btn").addEventListener("click", guarded(async () => {
  const box = $("sync-qr");
  if (box.hidden) await renderQR($("sync-qr-code"), syncLink(sync.phrase), "QR code that connects another device to sync");
  box.hidden = !box.hidden;
}));
$("sync-off-btn").addEventListener("click", () => {
  if (!confirm("Stop syncing on this device? Your data stays here, and other devices keep syncing.")) return;
  useSync(null);
  $("sync-qr").hidden = true;
  render();
});
$("sync-delete").addEventListener("click", guarded(async () => {
  if (!confirm("Delete the encrypted copy from the server and stop syncing on this device? Data on your devices stays. A device still syncing with this passphrase will upload its copy again; turn sync off there too.")) return;
  await syncer.mailbox.remove();
  useSync(null);
  $("sync-qr").hidden = true;
  render();
  toast("Server copy deleted. Sync is off on this device.");
}));

// Transfer without sync
$("move-make").addEventListener("click", guarded(async () => {
  const t = await makeTransferLink();
  if (!t) return toast("Too much data for a QR code. Use sync, or Export backup under Settings.");
  await renderQR($("move-qr"), t.url, "QR code that copies your data to another device");
  $("move-box").hidden = false;
  $("move-box").dataset.url = t.url;
  $("move-note").textContent =
    `Carries ${plural(t.clients, "client", "clients")} and ${plural(t.sessions, "entry", "entries")} from the last ${t.days === 1 ? "day" : `${t.days} days`}. ` +
    "Scan it with the other device's camera. Sending the link by message or email puts its contents on that service.";
}));
$("move-copy").addEventListener("click", () => copyText($("move-box").dataset.url, "Transfer link"));
$("move-paste").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    importTransfer(await decodeTransfer($("move-link").value));
    $("move-link").value = "";
  } catch {
    toast("That doesn't look like a complete transfer link.");
  }
});

$("safari-tip-close").addEventListener("click", () => {
  storage.set(TIP_KEY, "1");
  renderTip();
});

// Another tab changed the data: adopt it rather than overwrite it later.
window.addEventListener("storage", (e) => {
  if (e.key === STATE_KEY) state = loadState();
  if (e.key === SYNC_KEY) useSyncFromStorage();
  if (e.key === STATE_KEY || e.key === SYNC_KEY) render();
});

/* ---------- start ---------- */

function useSyncFromStorage() {
  const config = loadSyncConfig();
  if (!config) return useSync(null);
  if (config.v === KDF_VERSION) return useSync(config);
  // Saved by an older key scheme: derive current keys from the stored passphrase.
  keysFor(config.phrase).then((fresh) => {
    useSync(fresh);
    syncNow();
  }).catch(() => {});
}

useSyncFromStorage();
render();
renderStorageNote();
handleHash();
window.addEventListener("hashchange", handleHash);
setInterval(tick, 1000);
// Poll while visible so a timer started on the phone shows up on the laptop.
setInterval(() => { if (!document.hidden) syncNow(); }, 30000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (syncTimer) syncNow(); // push a pending change before the tab is backgrounded
  } else {
    render();
    syncNow();
  }
});
window.addEventListener("online", () => syncNow());
syncNow();
