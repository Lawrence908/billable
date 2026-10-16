// The page: storage, rendering and event wiring. The rules live in model.js,
// crypto.js, transfer.js and sync.js, which are pure enough to unit test;
// this file is the thin layer that connects them to the DOM.

import {
  CATEGORIES, activeClients, atTime, clientById, clientByName, clock, csvFor, dayBounds, dayKey, endAfter,
  existingClients, existingSessions, fmtHM, fmtHMS, fmtHours, merge, newId, normalise, noteSuggestions,
  prettyDay, retagClient, retagSession, runningFor, sheetRows, shiftDay, stopAt, summaryRows, summaryText, tagLabel,
  timelineFor, timerNudges, toTSV, toggleTimer, totalsFor,
} from "./model.js";
import { KDF_VERSION, deriveKeys, generatePhrase, normalisePhrase, phraseProblem } from "./crypto.js";
import { createSyncer, mailboxClient } from "./sync.js";
import { applyTransfer, buildTransfer, decodeTransfer, encodeTransfer } from "./transfer.js";

const STATE_KEY = "billable.v1";
const SYNC_KEY = "billable.sync";
const TIP_KEY = "billable.tip-dismissed";
const EXPANDED_KEY = "billable.expanded"; // which cards show their detail panel; this device only
const SUMMARY_OPEN_KEY = "billable.summary-open"; // the summary starts minimized until opened
const TIMELINE_OPEN_KEY = "billable.timeline-open"; // the timeline starts open
const SNOOZE_KEY = "billable.nudge-snooze"; // session id -> time until which its nudge stays quiet
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

function toggle(clientId) {
  state = toggleTimer(state, clientId, Date.now(), newId);
  commit();
}

// Picking a new category clears the note, which belonged to the old one.
function setClientTag(clientId, category, note) {
  state = retagClient(state, clientId, category, note, Date.now(), newId);
  commit();
}

function setSessionTag(sessionId, category, note) {
  state = retagSession(state, sessionId, category, note, Date.now());
  commit();
}

const expanded = new Set((() => {
  try {
    return JSON.parse(storage.get(EXPANDED_KEY) || "[]");
  } catch {
    return [];
  }
})());

function toggleExpanded(clientId) {
  if (expanded.has(clientId)) expanded.delete(clientId);
  else expanded.add(clientId);
  storage.set(EXPANDED_KEY, JSON.stringify([...expanded]));
  render();
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
  if (running) stopAt(running, now);
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
  const { category, note } = clientById(state, clientId); // the card's current tag
  state.sessions.push({ id: newId(), clientId, start, end: endAfter(start, endHM), category, note, updated: Date.now() });
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

/* ---------- forgotten timers ---------- */

const snoozed = (() => {
  try {
    return JSON.parse(storage.get(SNOOZE_KEY) || "{}");
  } catch {
    return {};
  }
})();

function snooze(sessionId, ms) {
  snoozed[sessionId] = Date.now() + ms;
  // Forget snoozes for timers that have since stopped.
  for (const id of Object.keys(snoozed)) if (!existingSessions(state).some((s) => s.id === id && s.end === null)) delete snoozed[id];
  storage.set(SNOOZE_KEY, JSON.stringify(snoozed));
  render();
}

function stopForgotten(sessionId, end) {
  const s = existingSessions(state).find((x) => x.id === sessionId);
  if (!s) return;
  if (end > Date.now()) return toast("That time hasn't happened yet.");
  stopAt(s, end);
  commit();
  toast(`Stopped at ${clock(s.end)}.`);
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
      renderSoon();
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

// Redraws replace the DOM, which would throw away a half-typed note. Changes
// that arrive on their own (a sync, the minute tick) wait until the field loses focus.
let renderPending = false;
const typing = () => document.activeElement?.matches("input, select") ?? false;
function renderSoon() {
  if (typing()) renderPending = true;
  else render();
}
document.addEventListener("focusout", () => {
  setTimeout(() => {
    if (renderPending && !typing()) {
      renderPending = false;
      render();
    }
  });
});

// One shared <datalist> of past notes per category, for every note box.
function renderNoteLists() {
  $("note-lists").replaceChildren(...CATEGORIES.map((cat) =>
    el("datalist", { id: `notes-${cat.key}` }, ...noteSuggestions(state, cat.key).map((n) => el("option", { value: n })))));
}

// A category dropdown and a note box. The note only opens once a category is
// chosen, and suggests what has been typed under that category before.
function tagControls({ category, note, onCategory, onNote, label }) {
  const select = el("select", { class: "tag-category", "aria-label": `${label}: category`, onchange: (e) => onCategory(e.target.value) },
    el("option", { value: "", text: "No category" }),
    ...CATEGORIES.map((c) => el("option", { value: c.key, text: c.label })));
  select.value = category;
  const input = el("input", {
    type: "text",
    class: "tag-note",
    maxlength: "80",
    placeholder: category ? "Note (optional)" : "Pick a category first",
    disabled: !category,
    list: category ? `notes-${category}` : null,
    autocomplete: "off",
    "aria-label": `${label}: note`,
    onchange: (e) => onNote(e.target.value),
    onkeydown: (e) => { if (e.key === "Enter") e.target.blur(); },
  });
  input.value = note;
  return el("div", { class: "tag-controls" }, select, input);
}

function renderNudges(now) {
  const nudges = timerNudges(state, now).filter((n) => !(snoozed[n.session.id] > now));
  $("nudges").replaceChildren(...nudges.map(({ session, client, kind }) => {
    const since = new Date(session.start).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
    const time = el("input", { type: "time", "aria-label": `When you stopped working on ${client.name}` });
    return el("div", { class: "nudge", role: "alert" },
      el("p", {},
        el("strong", { text: client.name }),
        kind === "overnight"
          ? ` has been running since ${since}. Did you forget to stop it? When did you finish?`
          : ` has been running for ${fmtHM(now - session.start)}, since ${clock(session.start)}. Still on it?`),
      el("div", { class: "send-row" },
        time,
        el("button", {
          type: "button",
          class: "btn btn-primary",
          onclick: () => (time.value ? stopForgotten(session.id, endAfter(session.start, time.value)) : toast("Pick the time you stopped.")),
          text: "Stop at that time",
        }),
        kind === "long" ? el("button", { type: "button", class: "btn", onclick: () => stopForgotten(session.id, Date.now()), text: "Stop now" }) : null,
        el("button", { type: "button", class: "btn btn-ghost", onclick: () => snooze(session.id, 2 * 3600e3), text: "Still working" })));
  }));
}

// Client colours for the timeline, stable for as long as the client exists.
const PALETTE = ["#4fd39a", "#6aa7ff", "#f0b23e", "#b48cff", "#39c5cf", "#ff8fc7", "#e86a5f", "#c7d36a"];
const colourOf = (clientId) => PALETTE[Math.max(0, existingClients(state).findIndex((c) => c.id === clientId)) % PALETTE.length];

function renderTimeline(now) {
  const today = viewDay === dayKey(now);
  $("timeline-day").textContent = today ? "Today" : new Date(dayBounds(viewDay)[0]).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const t = timelineFor(state, viewDay, now);
  $("timeline-empty").hidden = !!t;
  $("timeline-body").hidden = !t;
  if (!t) return;
  const span = t.to - t.from;
  const pct = (ms) => `${((ms - t.from) / span) * 100}%`;
  const width = (a, b) => `${((b - a) / span) * 100}%`;
  const place = (node, start, end) => {
    node.style.left = pct(start);
    node.style.width = width(start, end);
    return node;
  };
  const hourStep = span > 10 * 3600e3 ? 2 : 1;
  const ticks = [];
  for (let h = t.from; h < t.to; h += hourStep * 3600e3) {
    const tick = el("div", { class: "tick" }, el("span", { text: new Date(h).toLocaleTimeString(undefined, { hour: "numeric" }) }));
    tick.style.left = pct(h);
    ticks.push(tick);
  }
  const blocks = t.blocks.map((b) => {
    const c = clientById(state, b.session.clientId);
    const tag = tagLabel(b.session.category, b.session.note);
    const running = b.session.end === null;
    const label = `${c.name}${tag ? `, ${tag}` : ""}: ${clock(b.start)} to ${running ? "now" : clock(b.end)} (${fmtHM(b.end - b.start)})`;
    const node = el("button", { type: "button", class: `block${running ? " running" : ""}`, title: label, "aria-label": label, onclick: () => showEntry(b.session.id) });
    node.style.setProperty("--c", colourOf(c.id));
    return place(node, b.start, b.end);
  });
  const gaps = t.gaps.map((g) => {
    const label = `Untracked ${clock(g.start)} to ${clock(g.end)} (${fmtHM(g.end - g.start)}). Add an entry`;
    return place(el("button", { type: "button", class: "gap", title: label, "aria-label": label, onclick: () => fillGap(g) }), g.start, g.end);
  });
  $("timeline").replaceChildren(...ticks, ...gaps, ...blocks);
  const shown = [...new Set(t.blocks.map((b) => b.session.clientId))];
  $("timeline-legend").replaceChildren(...shown.map((id) => {
    const li = el("li", { text: clientById(state, id).name });
    li.style.setProperty("--c", colourOf(id));
    return li;
  }));
}

function showEntry(sessionId) {
  $("log-wrap").open = true;
  const row = document.querySelector(`#log [data-id="${CSS.escape(sessionId)}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.remove("flash");
  void row.offsetWidth; // restart the animation
  row.classList.add("flash");
}

function fillGap(gap) {
  $("log-wrap").open = true;
  $("entry-start").value = clock(gap.start);
  $("entry-end").value = clock(gap.end);
  $("add-entry").scrollIntoView({ behavior: "smooth", block: "center" });
  $("entry-client").focus();
  toast("Pick the client for that time, then press Add entry.");
}

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
  const today = dayKey(now);
  const per = totalsFor(state, today, now);
  const hours = new Map(summaryRows(state, today, now).map((r) => [r.client.id, r.hours]));
  const active = activeClients(state);
  $("clients-empty").hidden = active.length > 0;
  $("clients").replaceChildren(...active.map((c) => {
    const running = runningFor(state, c.id);
    const ms = per.get(c.id) || 0;
    const open = expanded.has(c.id);
    const tag = tagLabel(c.category, c.note);
    const meta = running
      ? el("div", { class: "client-meta" }, el("span", { class: "pulse", "aria-hidden": "true" }), `Running since ${clock(running.start)}`)
      : el("div", { class: "client-meta", text: ms ? `${fmtHours(hours.get(c.id) || 0)} h today` : "Not started today" });
    const panelId = `more-${c.id}`;
    return el("li", { class: `client${running ? " running" : ""}${open ? " open" : ""}` },
      el("div", {},
        el("div", { class: "client-name", text: c.name }),
        tag ? el("div", { class: "client-tag", title: "Time on this card goes to", text: tag }) : null,
        meta),
      el("div", { class: "client-time digits", "data-live": c.id, text: running ? fmtHMS(ms) : fmtHM(ms) }),
      el("button", {
        type: "button",
        class: `btn toggle ${running ? "stop" : "start"}`,
        "aria-label": `${running ? "Stop" : "Start"} ${c.name}`,
        onclick: () => toggle(c.id),
        text: running ? "Stop" : "Start",
      }),
      el("div", { class: "client-tools" },
        el("button", {
          type: "button",
          class: "btn more-toggle",
          "aria-expanded": String(open),
          "aria-controls": panelId,
          onclick: () => toggleExpanded(c.id),
          text: open ? "Less" : "More",
        }),
        el("button", { type: "button", class: "btn", onclick: () => renameClient(c.id), text: "Rename" }),
        el("button", { type: "button", class: "btn", onclick: () => archiveClient(c.id), text: "Remove" })),
      open ? el("div", { class: "client-more", id: panelId },
        tagControls({
          category: c.category,
          note: c.note,
          label: c.name,
          onCategory: (cat) => setClientTag(c.id, cat, ""),
          onNote: (note) => setClientTag(c.id, c.category, note),
        }),
        el("p", { class: "note", text: running
          ? "Changing these splits the running timer here: time so far keeps the old label."
          : "The next timer you start on this card is labelled with these." })) : null);
  }));
}

function renderSummary(now) {
  const rows = summaryRows(state, viewDay, now);
  const body = $("summary").tBodies[0];
  if (!rows.length) {
    body.replaceChildren(el("tr", { class: "none" }, el("td", { colspan: "3", text: "No time recorded on this day." })));
  } else {
    body.replaceChildren(...rows.flatMap((r) => [
      el("tr", { class: r.detailed ? "client-row detailed" : "client-row" },
        el("td", {}, r.client.name,
          runningFor(state, r.client.id) ? el("span", { class: "pulse trailing", title: "Timer running" }) : null),
        el("td", { class: "num", text: fmtHM(r.ms) }),
        el("td", { class: "num billable", text: fmtHours(r.hours) })),
      ...(r.detailed ? r.lines.map((l) => el("tr", { class: "line-row" },
        el("td", { text: l.label }),
        el("td", { class: "num", text: fmtHM(l.ms) }),
        el("td", { class: "num", text: fmtHours(l.hours) }))) : []),
    ]));
  }
  const total = fmtHours(rows.reduce((a, r) => a + r.hours, 0));
  $("sum-exact").textContent = fmtHM(rows.reduce((a, r) => a + r.ms, 0));
  $("sum-rounded").textContent = total;
  // Visible while the panel is minimized; names the day when it is not today.
  const day = viewDay === dayKey(now) ? "" : `${new Date(dayBounds(viewDay)[0]).toLocaleDateString(undefined, { month: "short", day: "numeric" })}: `;
  $("summary-badge").textContent = `${day}${total} h`;
}

function renderLog(now) {
  const [from, to] = dayBounds(viewDay);
  const entries = existingSessions(state)
    .filter((s) => s.start < to && (s.end === null ? now : s.end) > from)
    .sort((a, b) => a.start - b.start);
  $("log-empty").hidden = entries.length > 0;
  // Tag controls appear on entries only once someone uses categories, so the
  // simple version of the page stays simple.
  const tagging = existingClients(state).some((c) => c.category) || existingSessions(state).some((s) => s.category);
  $("log").replaceChildren(...entries.map((s) => {
    const c = clientById(state, s.clientId);
    return el("li", { class: "entry", "data-id": s.id },
      el("span", { class: "entry-client", title: c.name }, c.name + (c.archived ? " (removed)" : ""),
        s.start < from ? el("small", { text: " · from previous day" }) : null,
        s.end !== null && s.end > to ? el("small", { text: " · into next day" }) : null),
      el("input", { type: "time", value: clock(s.start), "aria-label": "Start time", onchange: (e) => editSession(s.id, "start", e.target.value) }),
      el("span", { class: "dash", text: "to" }),
      s.end === null
        ? el("span", { class: "live", text: "running" })
        : el("input", { type: "time", value: clock(s.end), "aria-label": "End time", onchange: (e) => editSession(s.id, "end", e.target.value) }),
      el("span", { class: "dur digits", "data-entry": s.id, text: fmtHM((s.end === null ? now : s.end) - s.start) }),
      el("button", { type: "button", class: "btn btn-small btn-danger", "aria-label": "Delete entry", onclick: () => deleteSession(s.id), text: "✕" }),
      tagging ? tagControls({
        category: s.category,
        note: s.note,
        label: `${c.name} entry at ${clock(s.start)}`,
        onCategory: (cat) => setSessionTag(s.id, cat, ""),
        onNote: (note) => setSessionTag(s.id, s.category, note),
      }) : null);
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
  for (const r of document.querySelectorAll('input[name="sheet-layout"]')) r.checked = r.value === state.settings.sheetLayout;
  if (document.activeElement !== $("employee")) $("employee").value = state.settings.employee;
  $("employee").hidden = state.settings.sheetLayout !== "all";
  $("sheet-note").textContent = state.settings.sheetLayout === "all"
    ? "Pastes Date, Employee, Costing section, Notes and Hours. Click the first Date cell in your sheet, then paste."
    : "Pastes Notes and Hours. Click the first Notes cell in your sheet, then paste.";
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
  renderNoteLists();
  renderNudges(now);
  renderHeader(now);
  renderTimeline(now);
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
$("sheet-btn").addEventListener("click", () => {
  const rows = sheetRows(state, viewDay, Date.now());
  if (!rows.length) return toast("Nothing to copy for this day.");
  if (state.settings.sheetLayout === "all" && !state.settings.employee) toast("Tip: add your name under Settings to fill the Employee column.");
  copyText(toTSV(rows), `${plural(rows.length, "row", "rows")}`);
});
for (const r of document.querySelectorAll('input[name="sheet-layout"]')) {
  r.addEventListener("change", (e) => {
    setSetting("sheetLayout", e.target.value);
    renderSettings();
  });
}
$("employee").addEventListener("change", (e) => setSetting("employee", e.target.value.trim()));
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

$("summary-wrap").open = storage.get(SUMMARY_OPEN_KEY) === "1";
$("summary-wrap").addEventListener("toggle", (e) => storage.set(SUMMARY_OPEN_KEY, e.target.open ? "1" : "0"));
$("timeline-wrap").open = storage.get(TIMELINE_OPEN_KEY) !== "0";
$("timeline-wrap").addEventListener("toggle", (e) => storage.set(TIMELINE_OPEN_KEY, e.target.open ? "1" : "0"));

// Offline: a service worker keeps the app itself on the device. The URL
// carries the build, so each deploy installs a fresh copy and drops the old one.
if ("serviceWorker" in navigator) navigator.serviceWorker.register(`/sw.js?v=${BUILD}`).catch(() => {});

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
