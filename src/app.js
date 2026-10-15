// Billable: per-job start/stop timers kept entirely in localStorage.
//
// State is one JSON blob. A session is {id, jobId, start, end} in epoch ms,
// with end = null while its timer runs. A day's time for a job is the overlap
// of its sessions with that local calendar day, so a shift that crosses
// midnight is split between the two days rather than credited to one.
"use strict";

const KEY = "billable.v1";
const HOUR = 3600e3;

const $ = (id) => document.getElementById(id);

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function blank() {
  return { jobs: [], sessions: [], settings: { email: "", allowOverlap: false } };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    return normalise(JSON.parse(raw));
  } catch {
    return blank();
  }
}

// Accepts anything shaped roughly right (stored state or an imported backup)
// and drops what is not, so one bad record cannot break the page.
function normalise(d) {
  const out = blank();
  if (!d || typeof d !== "object") return out;
  if (Array.isArray(d.jobs)) {
    out.jobs = d.jobs
      .filter((j) => j && typeof j.id === "string" && typeof j.name === "string")
      .map((j) => ({ id: j.id, name: j.name.slice(0, 80), code: String(j.code || "").slice(0, 40), archived: !!j.archived }));
  }
  const ids = new Set(out.jobs.map((j) => j.id));
  if (Array.isArray(d.sessions)) {
    out.sessions = d.sessions
      .filter((s) => s && ids.has(s.jobId) && Number.isFinite(s.start) && (s.end === null || Number.isFinite(s.end)))
      .map((s) => ({ id: String(s.id || uid()), jobId: s.jobId, start: s.start, end: s.end }))
      .filter((s) => s.end === null || s.end >= s.start);
  }
  if (d.settings && typeof d.settings === "object") {
    out.settings.email = String(d.settings.email || "");
    out.settings.allowOverlap = !!d.settings.allowOverlap;
  }
  return out;
}

let state = load();
let viewDay = dayKey(Date.now());

function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
}

// Another tab changed the data: adopt it rather than overwrite it later.
window.addEventListener("storage", (e) => {
  if (e.key === KEY) {
    state = load();
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

function fmtWords(ms) {
  const m = Math.round(ms / 60e3);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
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

const jobById = (id) => state.jobs.find((j) => j.id === id);
const running = (jobId) => state.sessions.find((s) => s.jobId === jobId && s.end === null);

function jobLabel(j) {
  return j.code ? `${j.name} (${j.code})` : j.name;
}

function totalsFor(key, now) {
  const [from, to] = dayBounds(key);
  const per = new Map();
  for (const s of state.sessions) {
    const ms = overlap(s, from, to, now);
    if (ms > 0 || (s.end === null && s.start < to && s.start >= from)) {
      per.set(s.jobId, (per.get(s.jobId) || 0) + ms);
    }
  }
  return per;
}

function summaryRows(key, now) {
  const per = totalsFor(key, now);
  // Job list order, then any job only present in history.
  const order = state.jobs.map((j) => j.id).filter((id) => per.has(id));
  return order.map((id) => {
    const ms = per.get(id);
    return { job: jobById(id), ms, hours: roundHalf(ms) };
  });
}

/* ---------- actions ---------- */

function addJob(name, code) {
  name = name.trim();
  if (!name) return;
  state.jobs.push({ id: uid(), name: name.slice(0, 80), code: code.trim().slice(0, 40), archived: false });
  save();
  render();
}

function toggle(jobId) {
  const now = Date.now();
  const live = running(jobId);
  if (live) {
    live.end = now;
  } else {
    if (!state.settings.allowOverlap) {
      for (const s of state.sessions) if (s.end === null) s.end = now;
    }
    state.sessions.push({ id: uid(), jobId, start: now, end: null });
  }
  save();
  render();
}

function renameJob(jobId) {
  const j = jobById(jobId);
  const name = prompt("Job name", j.name);
  if (name === null || !name.trim()) return;
  const code = prompt("Job number (optional)", j.code);
  j.name = name.trim().slice(0, 80);
  if (code !== null) j.code = code.trim().slice(0, 40);
  save();
  render();
}

function archiveJob(jobId) {
  const j = jobById(jobId);
  const live = running(jobId);
  if (live) live.end = Date.now();
  j.archived = true;
  save();
  render();
  toast(`Removed ${j.name}. Its past hours are kept; restore it under Settings.`);
}

function restoreJob(jobId) {
  jobById(jobId).archived = false;
  save();
  render();
}

function deleteJobForever(jobId) {
  const j = jobById(jobId);
  if (!confirm(`Delete "${j.name}" and all of its recorded time? This cannot be undone.`)) return;
  state.jobs = state.jobs.filter((x) => x.id !== jobId);
  state.sessions = state.sessions.filter((s) => s.jobId !== jobId);
  save();
  render();
}

function moveJob(jobId, dir) {
  const active = state.jobs.filter((j) => !j.archived);
  const i = active.findIndex((j) => j.id === jobId);
  const k = i + dir;
  if (k < 0 || k >= active.length) return;
  const a = state.jobs.indexOf(active[i]);
  const b = state.jobs.indexOf(active[k]);
  [state.jobs[a], state.jobs[b]] = [state.jobs[b], state.jobs[a]];
  save();
  render();
}

// Times are edited as wall-clock HH:MM on the session's start day. An end
// earlier than the start is read as the next morning.
function editSession(id, field, value) {
  const s = state.sessions.find((x) => x.id === id);
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
  save();
  render();
}

function deleteSession(id) {
  state.sessions = state.sessions.filter((s) => s.id !== id);
  save();
  render();
}

function addEntry(jobId, startHM, endHM) {
  const start = atTime(viewDay, startHM);
  let end = atTime(viewDay, endHM);
  if (end <= start) end += 24 * HOUR;
  state.sessions.push({ id: uid(), jobId, start, end });
  save();
  render();
}

/* ---------- output ---------- */

function summaryText(key) {
  const rows = summaryRows(key, Date.now());
  const lines = [`Billable hours for ${prettyDay(key)}`, ""];
  if (!rows.length) lines.push("No time recorded.");
  for (const r of rows) lines.push(`${jobLabel(r.job)}: ${fmtHours(r.hours)} h`);
  const total = rows.reduce((a, r) => a + r.hours, 0);
  const exact = rows.reduce((a, r) => a + r.ms, 0);
  lines.push("", `Total: ${fmtHours(total)} h`, `(Each job rounded to the nearest 0.5 h; tracked ${fmtWords(exact)}.)`);
  if (state.sessions.some((s) => s.end === null)) lines.push("Note: a timer was still running when this was generated.");
  return lines.join("\n");
}

function csvFor(key) {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = summaryRows(key, Date.now());
  const out = [["date", "job", "job_number", "tracked_hours", "billable_hours"].join(",")];
  for (const r of rows) {
    out.push([key, q(r.job.name), q(r.job.code), (r.ms / HOUR).toFixed(2), fmtHours(r.hours)].join(","));
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

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
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

function renderJobs(now) {
  const list = $("jobs");
  const today = dayKey(now);
  const per = totalsFor(today, now);
  const active = state.jobs.filter((j) => !j.archived);
  list.replaceChildren();
  $("jobs-empty").hidden = active.length > 0;

  active.forEach((j, i) => {
    const live = running(j.id);
    const ms = per.get(j.id) || 0;
    const meta = live
      ? el("div", { class: "job-meta" }, el("span", { class: "pulse", "aria-hidden": "true" }), `Running since ${clock(live.start)}`)
      : el("div", { class: "job-meta", text: ms ? `${fmtHours(roundHalf(ms))} h billable today` : "Not started today" });

    list.append(
      el("li", { class: "job" + (live ? " running" : ""), "data-job": j.id },
        el("div", {},
          el("div", { class: "job-name", text: j.name }, j.code ? el("span", { class: "job-code", text: `  #${j.code}` }) : null),
          meta),
        el("div", { class: "job-time digits", "data-live": j.id, text: live ? fmtHMS(ms) : fmtHM(ms) }),
        el("button", {
          type: "button",
          class: "btn toggle " + (live ? "stop" : "start"),
          "aria-label": `${live ? "Stop" : "Start"} ${j.name}`,
          onclick: () => toggle(j.id),
          text: live ? "Stop" : "Start",
        }),
        el("div", { class: "job-tools" },
          i > 0 ? el("button", { type: "button", class: "btn", "aria-label": `Move ${j.name} up`, onclick: () => moveJob(j.id, -1), text: "↑" }) : null,
          i < active.length - 1 ? el("button", { type: "button", class: "btn", "aria-label": `Move ${j.name} down`, onclick: () => moveJob(j.id, 1), text: "↓" }) : null,
          el("button", { type: "button", class: "btn", onclick: () => renameJob(j.id), text: "Rename" }),
          el("button", { type: "button", class: "btn", onclick: () => archiveJob(j.id), text: "Remove" })))
    );
  });
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
        el("td", {}, r.job.name, r.job.code ? el("span", { class: "code", text: `#${r.job.code}` }) : null,
          running(r.job.id) ? el("span", { class: "pulse", style: "margin-left:.5em", title: "Timer running" }) : null),
        el("td", { class: "num", text: fmtHM(r.ms) }),
        el("td", { class: "num billable", text: fmtHours(r.hours) }))
    );
  }
  $("sum-exact").textContent = fmtHM(rows.reduce((a, r) => a + r.ms, 0));
  $("sum-rounded").textContent = fmtHours(rows.reduce((a, r) => a + r.hours, 0));
}

function renderLog(now) {
  const [from, to] = dayBounds(viewDay);
  const entries = state.sessions
    .filter((s) => s.start < to && (s.end === null ? now : s.end) > from)
    .sort((a, b) => a.start - b.start);
  const log = $("log");
  log.replaceChildren();
  $("log-empty").hidden = entries.length > 0;

  for (const s of entries) {
    const j = jobById(s.jobId);
    const ms = (s.end === null ? now : s.end) - s.start;
    log.append(
      el("li", { class: "entry" },
        el("span", { class: "entry-job", title: jobLabel(j) }, j.name + (j.archived ? " (removed)" : ""),
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

  const sel = $("entry-job");
  const keep = sel.value;
  sel.replaceChildren(el("option", { value: "", text: "Job…", disabled: true, selected: true }));
  for (const j of state.jobs.filter((x) => !x.archived)) sel.append(el("option", { value: j.id, text: jobLabel(j) }));
  if (keep && jobById(keep) && !jobById(keep).archived) sel.value = keep;
}

function renderSettings() {
  $("allow-overlap").checked = state.settings.allowOverlap;
  if (document.activeElement !== $("email-to")) $("email-to").value = state.settings.email;
  const gone = state.jobs.filter((j) => j.archived);
  $("archived-count").textContent = gone.length;
  $("archived-wrap").hidden = gone.length === 0;
  const ul = $("archived");
  ul.replaceChildren();
  for (const j of gone) {
    ul.append(
      el("li", {},
        el("span", { text: jobLabel(j) }),
        el("button", { type: "button", class: "btn btn-small", onclick: () => restoreJob(j.id), text: "Restore" }),
        el("button", { type: "button", class: "btn btn-small btn-danger", onclick: () => deleteJobForever(j.id), text: "Delete" }))
    );
  }
}

function renderHeader(now) {
  const today = dayKey(now);
  $("today-label").textContent = prettyDay(today);
  const total = [...totalsFor(today, now).values()].reduce((a, b) => a + b, 0);
  $("today-total").textContent = fmtHM(total);
  $("day-pick").value = viewDay;
  $("day-pick").max = today;
  $("day-next").disabled = viewDay >= today;
  const anyLive = state.sessions.some((s) => s.end === null);
  document.title = anyLive ? `● ${fmtHM(total)} · Billable` : "Billable · hours per job";
}

function render() {
  const now = Date.now();
  renderHeader(now);
  renderJobs(now);
  renderSummary(now);
  renderLog(now);
  renderSettings();
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
  if (!state.sessions.some((s) => s.end === null)) return;
  const per = totalsFor(today, now);
  for (const node of document.querySelectorAll("[data-live]")) {
    const id = node.dataset.live;
    if (running(id)) node.textContent = fmtHMS(per.get(id) || 0);
  }
  for (const node of document.querySelectorAll("[data-entry]")) {
    const s = state.sessions.find((x) => x.id === node.dataset.entry);
    if (s && s.end === null) node.textContent = fmtHM(now - s.start);
  }
  $("today-total").textContent = fmtHM([...per.values()].reduce((a, b) => a + b, 0));
}

/* ---------- wiring ---------- */

$("add-job").addEventListener("submit", (e) => {
  e.preventDefault();
  addJob($("job-name").value, $("job-code").value);
  $("job-name").value = "";
  $("job-code").value = "";
  $("job-name").focus();
});

$("day-prev").addEventListener("click", () => { viewDay = shiftDay(viewDay, -1); render(); });
$("day-next").addEventListener("click", () => { viewDay = shiftDay(viewDay, 1); render(); });
$("day-today").addEventListener("click", () => { viewDay = dayKey(Date.now()); render(); });
$("day-pick").addEventListener("change", (e) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { viewDay = e.target.value; render(); }
});

$("email-to").addEventListener("change", (e) => {
  state.settings.email = e.target.value.trim();
  save();
});

$("email-btn").addEventListener("click", () => {
  state.settings.email = $("email-to").value.trim();
  save();
  const subject = `Billable hours ${viewDay}`;
  const to = state.settings.email.split(/[,;\s]+/).filter(Boolean).map(encodeURIComponent).join(",");
  location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(summaryText(viewDay))}`;
});

$("copy-btn").addEventListener("click", async () => {
  const text = summaryText(viewDay);
  try {
    await navigator.clipboard.writeText(text);
    toast("Summary copied.");
  } catch {
    // Clipboard API needs a secure context and permission; fall back to a selection copy.
    const ta = el("textarea", { style: "position:fixed;opacity:0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    toast(ok ? "Summary copied." : "Copy failed; your browser blocked it.");
  }
});

$("csv-btn").addEventListener("click", () => download(`billable-${viewDay}.csv`, csvFor(viewDay), "text/csv"));

$("add-entry").addEventListener("submit", (e) => {
  e.preventDefault();
  const job = $("entry-job").value;
  const a = $("entry-start").value;
  const b = $("entry-end").value;
  if (!job || !a || !b) return toast("Pick a job and both times.");
  addEntry(job, a, b);
  $("entry-start").value = "";
  $("entry-end").value = "";
});

$("allow-overlap").addEventListener("change", (e) => {
  state.settings.allowOverlap = e.target.checked;
  save();
});

$("export-btn").addEventListener("click", () =>
  download(`billable-backup-${dayKey(Date.now())}.json`, JSON.stringify(state, null, 2), "application/json"));

$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const incoming = normalise(JSON.parse(await file.text()));
    if (!incoming.jobs.length) return toast("That file has no jobs in it.");
    if (!confirm(`Replace what is in this browser with ${incoming.jobs.length} job(s) and ${incoming.sessions.length} time entries from the backup?`)) return;
    state = incoming;
    save();
    render();
    toast("Backup restored.");
  } catch {
    toast("Could not read that file as a Billable backup.");
  }
});

$("wipe-btn").addEventListener("click", () => {
  if (!confirm("Erase every job and time entry stored in this browser?")) return;
  state = blank();
  save();
  render();
});

render();
setInterval(tick, 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });
