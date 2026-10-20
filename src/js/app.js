// The page: storage, rendering and event wiring. The rules live in model.js,
// transfer.js and bytes.js, which are pure enough to unit test; this file is
// the thin layer that connects them to the DOM.
//
// Encrypted sync is optional and off by default (config.js). When a build
// turns it on, sync-ui.js is loaded and plugs into `hooks` below. When it is
// off, that module is not even in the build, and nothing here makes a network
// request after the page has loaded.

import {
  CATEGORIES, LUNCH_END, LUNCH_START, activeClients, atTime, clientById, clientByName, clock, csvFor, dayBounds, dayKey, endAfter,
  existingClients, existingSessions, fmtHM, fmtHMS, fmtHours, lunchBreak, lunchRestarts, merge, newId, normalise, noteSuggestions,
  prettyDay, retagClient, retagSession, runningFor, sheetRows, shiftDay, stopAt, summaryRows, summaryText, tagLabel,
  timelineFor, timerNudges, toTSV, toggleTimer, totalsFor,
} from "./model.js";
import { SYNC_ENABLED } from "./config.js";
import { applyTransfer, buildTransfer, decodeTransfer, encodeTransfer } from "./transfer.js";

const STATE_KEY = "billable.v1";
const SYNC_KEY = "billable.sync"; // only read to delete it when sync is off
const TIP_KEY = "billable.tip-dismissed";
const EXPANDED_KEY = "billable.expanded"; // which cards show their detail panel; this device only
const SUMMARY_OPEN_KEY = "billable.summary-open"; // the summary starts minimized until opened
const TIMELINE_OPEN_KEY = "billable.timeline-open"; // the timeline starts open
const SNOOZE_KEY = "billable.nudge-snooze"; // session id -> time until which its nudge stays quiet
const COPIED_KEY = "billable.sheet-copied"; // day -> { client id: what was copied }, for the ticks
const BUILD = document.querySelector('meta[name="build"]').content;
const TRANSFER_MAX = 1400; // link characters; beyond this a QR code is hard to scan off a screen

const $ = (id) => document.getElementById(id);

// Filled in by sync-ui.js when sync is enabled; harmless no-ops otherwise.
const hooks = { changed() {}, active: () => false, render() {} };
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
  hooks.changed();
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
  hooks.changed();
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

/* ---------- lunch ---------- */

// Restarted timers whose banner is asking when the user got back; this device only.
const lunchAsking = new Set();

// Stops and restarts timers for lunch when due. True when it changed anything.
function applyLunch() {
  const now = Date.now();
  const { state: next, stopped } = lunchBreak(state, now);
  if (next === state) return false;
  state = next;
  commit();
  const waiting = stopped.filter((s) => s.lunch === "stopped").map((s) => clientById(state, s.clientId).name);
  if (waiting.length) {
    toast(`Stopped ${waiting.join(", ")} for lunch${state.settings.lunchRestart ? `, back on at ${clock(atTime(dayKey(now), LUNCH_END))}` : ""}.`);
  }
  return true;
}

// Answers a lunch restart's banner. `change` edits the session, or returns a
// message to show without saving.
function answerLunch(sessionId, change) {
  const s = existingSessions(state).find((x) => x.id === sessionId);
  if (!s) return;
  const problem = change(s);
  if (problem) return toast(problem);
  lunchAsking.delete(sessionId);
  delete s.lunch;
  s.updated = Date.now();
  commit();
}

const lunchAt = (s, hhmm) => atTime(dayKey(s.start), hhmm);

function lunchBackAt(sessionId, hhmm) {
  answerLunch(sessionId, (s) => {
    const start = lunchAt(s, hhmm);
    if (start < lunchAt(s, LUNCH_START)) return "Pick a time after lunch started.";
    if (start > Date.now()) return "That time hasn't happened yet.";
    if (s.end !== null && start > s.end) return "That's after this timer stopped.";
    s.start = start;
  });
}

function lunchNotBack(sessionId) {
  lunchAsking.delete(sessionId);
  tombstone(state.sessions, sessionId, Date.now());
  commit();
  toast("Removed. Press Start when you're back.");
}

/* ---------- copy for sheets ---------- */

// Remembers what was copied for each client, so the summary can tick off the
// tabs already done. A tick only shows while the client's rows still match
// what was copied, so editing time afterwards brings the copy button back.
const copied = (() => {
  try {
    return JSON.parse(storage.get(COPIED_KEY) || "{}");
  } catch {
    return {};
  }
})();

const isCopied = (clientId, tsv) => copied[viewDay]?.[clientId] === tsv;

async function copyClient(clientId) {
  const rows = sheetRows(state, viewDay, Date.now(), clientId);
  const name = clientById(state, clientId).name;
  if (!rows.length) return toast(`Nothing over 0.00 h to copy for ${name}.`);
  const tsv = toTSV(rows);
  if (!(await copyText(tsv))) return;
  if (state.settings.sheetLayout === "all" && !state.settings.employee) toast(`${name} copied. Add your name in Settings to fill the Employee column.`);
  else toast(`${name}: ${plural(rows.length, "row", "rows")} copied. Paste into its sheet.`);
  // Keep a week of days; older ticks are of no use.
  const cutoff = shiftDay(dayKey(Date.now()), -7);
  for (const day of Object.keys(copied)) if (day < cutoff) delete copied[day];
  copied[viewDay] = { ...copied[viewDay], [clientId]: tsv };
  storage.set(COPIED_KEY, JSON.stringify(copied));
  renderSummary(Date.now());
}

const COPY_ICON = "M9 9h10v10H9zM5 15V5h10";
const DONE_ICON = "M5 12.5l4.5 4.5L19 7.5";
function icon(d) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("stroke-linecap", "round");
  svg.append(path);
  return svg;
}

/* ---------- QR codes ---------- */

const SVG_NS = "http://www.w3.org/2000/svg";

// Built from the module grid as one SVG path, rather than the library's own
// SVG/GIF helpers, so nothing is injected as HTML and the strict CSP holds.
// The library (qrcode-generator, vendored) loads with the page, so drawing a
// code later fetches nothing.
function renderQR(container, text, label) {
  if (typeof window.qrcode !== "function") throw new Error("The QR code part of the page didn't load. Reload and try again.");
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

// Returns whether the copy worked. Toasts itself only when given a label.
async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    if (what) toast(`${what} copied.`);
    return true;
  } catch {
    // The Clipboard API needs permission; fall back to a selection copy.
    const ta = el("textarea", { class: "offscreen" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) toast("Copy failed; your browser blocked it.");
    else if (what) toast(`${what} copied.`);
    return ok;
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

// A time box whose edits are saved when you leave it, press Enter, or pause for
// two seconds. Saving redraws the list, so saving on every change would replace
// the box between the 3 and the 0 of a typed "30". A save made during a pause
// puts the focus back in the redrawn box.
const TIME_GRACE_MS = 2000;
function timeField(id, field, value, label, save) {
  let timer = null;
  const flush = (refocus) => {
    clearTimeout(timer);
    timer = null;
    if (!input.value || input.value === value) return;
    save(input.value);
    if (refocus) document.querySelector(`#log [data-id="${id}"] input[data-field="${field}"]`)?.focus();
  };
  const input = el("input", {
    type: "time", value, "aria-label": label, "data-field": field,
    onchange: () => { clearTimeout(timer); timer = setTimeout(() => flush(document.activeElement === input), TIME_GRACE_MS); },
    onblur: () => { if (timer) flush(false); },
    onkeydown: (e) => { if (e.key === "Enter") e.target.blur(); },
  });
  return input;
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

function renderLunchNudge(session) {
  const { name } = clientById(state, session.clientId);
  const id = session.id;
  if (lunchAsking.has(id)) {
    const time = el("input", { type: "time", "aria-label": `When you got back to ${name}` });
    return el("div", { class: "nudge", role: "alert" },
      el("p", {}, "When did you get back to ", el("strong", { text: name }), "?"),
      el("div", { class: "send-row" },
        time,
        el("button", {
          type: "button",
          class: "btn btn-primary",
          onclick: () => (time.value ? lunchBackAt(id, time.value) : toast("Pick the time you got back.")),
          text: "Back at that time",
        }),
        el("button", { type: "button", class: "btn", onclick: () => lunchNotBack(id), text: "Not back yet" }),
        el("button", { type: "button", class: "btn btn-ghost", onclick: () => { lunchAsking.delete(id); render(); }, text: "Cancel" })));
  }
  return el("div", { class: "nudge", role: "alert" },
    el("p", {}, el("strong", { text: name }), ` started again automatically at ${clock(session.start)}, after lunch.`),
    el("div", { class: "send-row" },
      el("button", { type: "button", class: "btn btn-primary", onclick: () => answerLunch(id, () => {}), text: "OK" }),
      el("button", {
        type: "button",
        class: "btn",
        onclick: () => answerLunch(id, (s) => { s.start = lunchAt(s, LUNCH_START); }),
        text: "I worked through lunch",
      }),
      el("button", { type: "button", class: "btn btn-ghost", onclick: () => { lunchAsking.add(id); render(); }, text: "I wasn't working" })));
}

function renderNudges(now) {
  const nudges = timerNudges(state, now).filter((n) => !(snoozed[n.session.id] > now));
  $("nudges").replaceChildren(...lunchRestarts(state, now).map(renderLunchNudge), ...nudges.map(({ session, client, kind }) => {
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

// The entry a timeline tap pointed at stays highlighted briefly, even if the
// list is redrawn in the meantime (the minute tick rebuilds it).
let flashed = { id: null, until: 0 };

function showEntry(sessionId) {
  $("log-wrap").open = true;
  const row = document.querySelector(`#log [data-id="${CSS.escape(sessionId)}"]`);
  if (!row) return;
  flashed = { id: sessionId, until: Date.now() + 1500 };
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
    body.replaceChildren(el("tr", { class: "none" }, el("td", { colspan: "4", text: "No time recorded on this day." })));
  } else {
    body.replaceChildren(...rows.flatMap((r) => {
      const sheet = sheetRows(state, viewDay, now, r.client.id);
      const done = sheet.length > 0 && isCopied(r.client.id, toTSV(sheet));
      const copyLabel = done ? `${r.client.name} copied for Sheets. Copy again` : `Copy ${r.client.name} for Sheets`;
      return [
        el("tr", { class: r.detailed ? "client-row detailed" : "client-row" },
          el("td", {}, r.client.name,
            runningFor(state, r.client.id) ? el("span", { class: "pulse trailing", title: "Timer running" }) : null),
          el("td", { class: "num", text: fmtHM(r.ms) }),
          el("td", { class: "num billable", text: fmtHours(r.hours) }),
          el("td", { class: "copy" }, sheet.length
            ? el("button", { type: "button", class: `copy-btn${done ? " done" : ""}`, title: copyLabel, "aria-label": copyLabel, onclick: () => copyClient(r.client.id) }, icon(done ? DONE_ICON : COPY_ICON))
            : null)),
        ...(r.detailed ? r.lines.map((l) => el("tr", { class: "line-row" },
          el("td", { text: l.label }),
          el("td", { class: "num", text: fmtHM(l.ms) }),
          el("td", { class: "num", text: fmtHours(l.hours) }),
          el("td"))) : []),
      ];
    }));
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
    const flash = flashed.id === s.id && Date.now() < flashed.until;
    return el("li", { class: flash ? "entry flash" : "entry", "data-id": s.id },
      el("span", { class: "entry-client", title: c.name }, c.name + (c.archived ? " (removed)" : ""),
        s.start < from ? el("small", { text: " · from previous day" }) : null,
        s.end !== null && s.end > to ? el("small", { text: " · into next day" }) : null),
      timeField(s.id, "start", clock(s.start), "Start time", (v) => editSession(s.id, "start", v)),
      el("span", { class: "dash", text: "to" }),
      s.end === null
        ? el("span", { class: "live", text: "running" })
        : timeField(s.id, "end", clock(s.end), "End time", (v) => editSession(s.id, "end", v)),
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
  $("lunch-stop").checked = state.settings.lunchStop;
  $("lunch-restart").checked = state.settings.lunchRestart;
  $("lunch-restart").disabled = !state.settings.lunchStop;
  for (const r of document.querySelectorAll('input[name="sheet-layout"]')) r.checked = r.value === state.settings.sheetLayout;
  if (document.activeElement !== $("employee")) $("employee").value = state.settings.employee;
  $("employee").hidden = state.settings.sheetLayout !== "all";
  $("sheet-note").textContent = state.settings.sheetLayout === "all"
    ? "Copy a client with its button, open that client's sheet, click the first empty Date cell and paste."
    : "Copy a client with its button, open that client's sheet, click the first empty Notes cell and paste.";
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
      : "This browser may clear Billable's storage if the device runs low on space. Export a backup now and then.";
  }).catch(() => {});
}

// Safari, and every iOS browser built on it, deletes a site's storage after
// seven days without a visit, unless it runs as a Home Screen or Dock app.
function renderTip() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const macSafari = !ios && /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(ua);
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const show = (ios || macSafari) && !standalone && !hooks.active() && !storage.get(TIP_KEY);
  $("safari-tip").hidden = !show;
  if (!show) return;
  const carry = SYNC_ENABLED ? "with sync or a transfer link" : "with a transfer link (Move to another device)";
  $("safari-tip-text").textContent = ios
    ? `Safari erases this site's data after 7 days without a visit. Add Billable to your Home Screen (Share, then Add to Home Screen) and open it from there. The Home Screen app starts with its own empty copy, so bring your data across ${carry}.`
    : `Safari erases this site's data after 7 days without a visit. Use File, then Add to Dock, and open Billable from the Dock${SYNC_ENABLED ? ", or turn on sync below" : ", and export a backup now and then"}.`;
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
  hooks.render();
  renderTip();
}

// Once a second, update only the numbers that move, so typing in a field is
// never interrupted by a re-render. A full render happens each minute, which
// keeps the summary and the day rollover current.
let lastMinute = -1;
let lastDay = dayKey(Date.now());
function tick() {
  if (applyLunch()) return;
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

  if (h.startsWith("#sync=")) {
    // With sync built in, sync-ui.js handles these links. Without it, there is
    // nothing to join: just make sure the passphrase does not stay in the address bar.
    if (SYNC_ENABLED) return;
    history.replaceState(null, "", location.pathname + location.search);
    toast("This version of Billable has no sync. Nothing was changed.");
    return;
  }

  history.replaceState(null, "", location.pathname + location.search);
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
$("lunch-stop").addEventListener("change", (e) => {
  setSetting("lunchStop", e.target.checked);
  renderSettings();
});
$("lunch-restart").addEventListener("change", (e) => setSetting("lunchRestart", e.target.checked));

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
  const ask = hooks.active()
    ? "Erase every client and time entry? Sync is on, so this also erases them on your other devices."
    : "Erase every client and time entry stored in this browser?";
  if (!confirm(ask)) return;
  const now = Date.now();
  state.clients = state.clients.map((c) => ({ id: c.id, deleted: true, updated: now }));
  state.sessions = state.sessions.map((s) => ({ id: s.id, deleted: true, updated: now }));
  commit();
});

// Move to another device
$("move-make").addEventListener("click", guarded(async () => {
  const t = await makeTransferLink();
  if (!t) return toast("Too much data for a QR code. Use Export backup under Settings instead.");
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
  if (e.key !== STATE_KEY) return;
  state = loadState();
  render();
});

/* ---------- start ---------- */

$("summary-wrap").open = storage.get(SUMMARY_OPEN_KEY) === "1";
$("summary-wrap").addEventListener("toggle", (e) => storage.set(SUMMARY_OPEN_KEY, e.target.open ? "1" : "0"));
$("timeline-wrap").open = storage.get(TIMELINE_OPEN_KEY) !== "0";
$("timeline-wrap").addEventListener("toggle", (e) => storage.set(TIMELINE_OPEN_KEY, e.target.open ? "1" : "0"));

// Offline: a service worker keeps the app itself on the device. The URL
// carries the build, so each deploy installs a fresh copy and drops the old one.
if ("serviceWorker" in navigator) navigator.serviceWorker.register(`/sw.js?v=${BUILD}`).catch(() => {});

// The shared footer's logo is served by the reverse proxy in production. If it
// is missing (a local run), drop the broken image. Done here rather than with
// an inline onerror, which the Content Security Policy does not allow.
const logo = document.querySelector(".footer-logo");
if (logo && logo.complete && !logo.naturalWidth) logo.remove();
else logo?.addEventListener("error", () => logo.remove());

if (!applyLunch()) render();
renderStorageNote();
handleHash();
window.addEventListener("hashchange", handleHash);
setInterval(tick, 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && !applyLunch()) render(); });

if (SYNC_ENABLED) {
  const app = {
    $, storage, toast, copyText, guarded, renderQR, requestPersist, clock, render, build: BUILD,
    getState: () => state,
    replaceState: (next) => { state = next; saveState(); renderSoon(); },
  };
  import(`./sync-ui.js?v=${BUILD}`).then((m) => m.installSync(app, hooks)).catch(() => toast("Sync could not start. Reload to try again."));
} else {
  // Sync is not in this build. Remove anything an earlier, sync-enabled
  // version left behind: the stored passphrase and the keys derived from it.
  storage.remove(SYNC_KEY);
}
