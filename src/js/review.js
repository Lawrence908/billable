// The review page: loads everyone's hours files, checks them against the
// official lists, and produces the hand-off. The rules live in
// review-model.js; this file connects them to the DOM. Like the app, it makes
// no network requests: files come in through the file picker, and everything
// stays in this browser's storage.

import { CATEGORIES, dayKey, fmtHours, shiftDay } from "./model.js";
import {
  addHoursFile, clientTSV, compile, detailCSV, encodeLists, handoffText, normaliseLists, normaliseReview, parseHoursFile, parseList,
  phaseLabel, removePerson, reviewedFor, setAlias, setReviewed, totalsCSV, weekStart,
} from "./review-model.js";
import { copyText, download, el, guarded, renderQR, storage, toast } from "./ui.js";

const REVIEW_KEY = "billable.review.v1";
const QR_MAX = 1400; // link characters; beyond this a QR code is hard to scan off a screen
const $ = (id) => document.getElementById(id);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const fmtDay = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};
const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : "");

function load() {
  try {
    return normaliseReview(JSON.parse(storage.get(REVIEW_KEY) || "null"));
  } catch {
    return normaliseReview(null);
  }
}

let review = load();
if (!review.period) {
  const today = dayKey(Date.now());
  review.period = { from: weekStart(today), to: today };
}

function save() {
  if (!storage.set(REVIEW_KEY, JSON.stringify(review))) toast("Couldn't save: browser storage is full or blocked. Export the review data.");
}

function commit(next) {
  review = next;
  save();
  render();
}

/* ---------- period ---------- */

function presetPeriod(name) {
  const today = dayKey(Date.now());
  const [y, m] = today.split("-").map(Number);
  const monthKey = (yy, mm, dd) => dayKey(new Date(yy, mm - 1, dd).getTime());
  switch (name) {
    case "this-week": return { from: weekStart(today), to: shiftDay(weekStart(today), 6) };
    case "last-week": return { from: shiftDay(weekStart(today), -7), to: shiftDay(weekStart(today), -1) };
    case "this-month": return { from: monthKey(y, m, 1), to: monthKey(y, m + 1, 0) };
    case "last-month": return { from: monthKey(y, m - 1, 1), to: monthKey(y, m, 0) };
    default: return review.period;
  }
}

/* ---------- files ---------- */

async function addFiles(files) {
  let added = 0;
  const problems = [];
  let next = review;
  for (const file of files) {
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("the file is too large");
      const parsed = parseHoursFile(await file.text());
      next = addHoursFile(next, parsed, Date.now());
      added++;
    } catch (e) {
      problems.push(`${file.name}: ${e.message}`);
    }
  }
  commit(next);
  if (problems.length) toast(`Added ${plural(added, "file", "files")}. Skipped ${problems.join("; ")}.`);
  else toast(`Added ${plural(added, "file", "files")}.`);
}

/* ---------- rendering ---------- */

function render() {
  const { from, to } = review.period;
  $("period-from").value = from;
  $("period-to").value = to;
  const c = compile(review, from, to);
  $("period-label").textContent = `${fmtDay(from)} to ${fmtDay(to)}`;
  $("period-total").textContent = fmtHours(c.hours);
  renderPeople(c);
  renderChecks(c);
  renderClients(c);
  renderGlance(c);
  if (document.activeElement !== $("ar-email")) $("ar-email").value = review.arEmail;
  $("lists-badge").textContent = review.lists.clients.length ? plural(review.lists.clients.length, "client", "clients") : "None yet";
}

function renderPeople(c) {
  const people = Object.values(review.people);
  $("people-badge").textContent = people.length ? plural(people.length, "person", "people") : "No files yet";
  $("people-table").hidden = !people.length;
  $("files-empty").hidden = people.length > 0;
  const byName = new Map(c.people.map((p) => [p.employee, p]));
  $("people").replaceChildren(...people
    .sort((a, b) => a.employee.localeCompare(b.employee))
    .map((p) => {
      const info = byName.get(p.employee);
      const covers = p.files.map((f) => `${fmtDay(f.from)} to ${fmtDay(f.to)}`).join(", ");
      const missing = info.missing.length ? info.missing.map(fmtDay).join(", ") : "None";
      return el("tr", {},
        el("td", { text: p.employee }),
        el("td", { class: "muted", text: covers }),
        el("td", { class: info.missing.length ? "warn" : "muted", text: missing }),
        el("td", { class: "num billable", text: fmtHours(info.hours) }),
        el("td", { class: "copy" }, el("button", {
          type: "button", class: "btn btn-small btn-danger", text: "Remove",
          onclick: () => { if (confirm(`Remove all of ${p.employee}'s hours from this review?`)) commit(removePerson(review, p.employee)); },
        })));
    }));
}

function renderChecks(c) {
  const { checks } = c;
  const items = [];
  const officialOptions = () => [el("option", { value: "", text: "Map to an official client..." }), ...review.lists.clients.map((n) => el("option", { value: n, text: n }))];
  for (const u of checks.unknownClients) {
    const select = el("select", {
      "aria-label": `Official name for ${u.name}`,
      onchange: (e) => { if (e.target.value) commit(setAlias(review, u.name, e.target.value)); },
    }, ...officialOptions());
    items.push(el("li", {},
      el("span", { text: `"${u.name}" isn't an official client (${fmtHours(u.hours)} h from ${u.people.join(", ")}).` }),
      review.lists.clients.length ? select : null));
  }
  for (const t of checks.otherTasks) {
    items.push(el("li", {}, el("span", { text: `${t.label}: "${t.note || "no task"}" isn't on the task list (${fmtHours(t.hours)} h from ${t.people.join(", ")}).` })));
  }
  for (const n of checks.noCategory) {
    items.push(el("li", {}, el("span", { text: `${n.employee} has ${fmtHours(n.hours)} h on ${n.client} with no category.` })));
  }
  for (const m of checks.missingDays) {
    items.push(el("li", {}, el("span", { text: `${m.employee}'s files don't cover ${m.days.map(fmtDay).join(", ")}.` })));
  }
  for (const r of checks.running) {
    items.push(el("li", {}, el("span", { text: `${r} had a timer running when they saved their file, so its time was counted up to that moment.` })));
  }
  // Aliases already set, so a wrong one can be undone.
  for (const [typed, official] of Object.entries(review.aliases)) {
    items.push(el("li", { class: "muted" },
      el("span", { text: `Counting "${typed}" as ${official}.` }),
      el("button", { type: "button", class: "btn btn-small", text: "Undo", onclick: () => commit(setAlias(review, typed, "")) })));
  }
  const problems = items.filter((li) => !li.classList.contains("muted")).length;
  $("checks-badge").textContent = problems ? plural(problems, "thing to check", "things to check") : "All clear";
  $("checks-badge").className = `fold-status ${problems ? "bad" : "good"}`;
  if (!items.length) items.push(el("li", { class: "muted" }, el("span", { text: Object.keys(review.people).length ? "Nothing to check for this period." : "Checks appear once hours files are added." })));
  $("checks").replaceChildren(...items);
}

function renderClients(c) {
  const { from, to } = review.period;
  const ticks = reviewedFor(review, from, to);
  $("clients-table").hidden = !c.clients.length;
  $("clients-empty").hidden = c.clients.length > 0;
  const done = c.clients.filter((x) => ticks[x.name]).length;
  $("reviewed-badge").textContent = c.clients.length ? `${done} of ${c.clients.length} reviewed` : "";
  $("reviewed-badge").className = `fold-status${c.clients.length && done === c.clients.length ? " good" : ""}`;
  $("clients-total").textContent = fmtHours(c.hours);
  const rows = [];
  for (const client of c.clients) {
    rows.push(el("tr", { class: `client-row detailed${client.official ? "" : " unofficial"}` },
      el("td", { text: client.name }),
      el("td", { class: "muted", text: client.people.join(", ") }),
      el("td", { class: "num billable", text: fmtHours(client.hours) }),
      el("td", {}, el("label", { class: "check" },
        el("input", { type: "checkbox", checked: !!ticks[client.name], onchange: (e) => commit(setReviewed(review, from, to, client.name, e.target.checked)) }),
        el("span", { class: "visually-hidden", text: `${client.name} reviewed` }))),
      el("td", { class: "copy" }, el("button", {
        type: "button", class: "btn btn-small", text: "Copy",
        "aria-label": `Copy ${client.name}'s rows for the timesheet`,
        onclick: () => copyText(clientTSV(c, client.name), `${client.name}'s rows`),
      }))));
    for (const l of client.lines) {
      rows.push(el("tr", { class: "line-row" },
        el("td", { class: l.otherTask || !l.category ? "warn" : "", text: l.label }),
        el("td", { text: l.people.map((p) => `${p.employee} ${fmtHours(p.hours)}`).join(", ") }),
        el("td", { class: "num", text: fmtHours(l.hours) }),
        el("td", { colspan: "2" })));
    }
  }
  $("clients").replaceChildren(...rows);
}

function renderGlance(c) {
  const share = (rows, label) => rows.map((r) => el("tr", {},
    el("td", { text: label(r) }), el("td", { class: "num", text: fmtHours(r.hours) }), el("td", { class: "num muted", text: pct(r.hours, c.hours) })));
  $("by-person").replaceChildren(...share(c.people.filter((p) => p.hours), (p) => p.employee));
  $("by-category").replaceChildren(...share(c.categories, (x) => x.label));
}

/* ---------- official lists editor ---------- */

// Drawn once and after a save or import, not on every render, so nothing
// half-typed is ever replaced.
function renderListsEditor() {
  const { lists } = review;
  $("lists-by").value = lists.by;
  $("lists-clients").value = lists.clients.join("\n");
  $("lists-phases").replaceChildren(...CATEGORIES.filter((c) => /^p\d$/.test(c.key)).map((c) => el("label", { class: "field" },
    el("span", { class: "label", text: c.label }),
    el("input", { type: "text", maxlength: "40", "data-phase": c.key, value: lists.phases[c.key] || "", placeholder: "Name (optional)" }))));
  const groups = [{ key: "*", label: "All categories" }, ...CATEGORIES.map((c) => ({ key: c.key, label: phaseLabel(lists, c.key) }))];
  $("lists-tasks").replaceChildren(...groups.map((g) => {
    const area = el("textarea", { rows: "4", "data-tasks": g.key });
    area.value = (lists.tasks[g.key] || []).join("\n");
    return el("label", { class: "field" }, el("span", { class: "label", text: g.label }), area);
  }));
}

function readListsEditor() {
  const phases = {};
  for (const input of document.querySelectorAll("[data-phase]")) phases[input.dataset.phase] = input.value;
  const tasks = {};
  for (const area of document.querySelectorAll("[data-tasks]")) tasks[area.dataset.tasks] = parseList(area.value);
  return normaliseLists({ clients: parseList($("lists-clients").value), phases, tasks, by: $("lists-by").value, updated: Date.now() });
}

function saveLists() {
  review = { ...review, lists: readListsEditor() };
  save();
  renderListsEditor();
  render();
}

async function listsLink() {
  saveLists();
  return encodeLists(review.lists, location.origin);
}

/* ---------- wiring ---------- */

for (const id of ["period-from", "period-to"]) {
  $(id).addEventListener("change", () => {
    const from = $("period-from").value;
    const to = $("period-to").value;
    if (from && to && from <= to) commit({ ...review, period: { from, to } });
    else toast("Pick a first day on or before the last day.");
  });
}
for (const b of document.querySelectorAll("[data-preset]")) {
  b.addEventListener("click", () => commit({ ...review, period: presetPeriod(b.dataset.preset) }));
}

$("hours-files").addEventListener("change", guarded(async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (files.length) await addFiles(files);
}));
const drop = $("files-panel");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", guarded(async (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) await addFiles(files);
}));

$("ar-email").addEventListener("change", (e) => commit({ ...review, arEmail: e.target.value.trim().slice(0, 200) }));
const summary = () => handoffText(compile(review, review.period.from, review.period.to), review.lists);
$("email-btn").addEventListener("click", () => {
  const to = review.arEmail.split(/[,;\s]+/).filter(Boolean).map(encodeURIComponent).join(",");
  const subject = encodeURIComponent(`Billable hours ${review.period.from} to ${review.period.to}`);
  location.href = `mailto:${to}?subject=${subject}&body=${encodeURIComponent(summary())}`;
});
$("copy-summary").addEventListener("click", () => copyText(summary(), "Summary"));
const period = () => `${review.period.from}-to-${review.period.to}`;
$("detail-csv").addEventListener("click", () =>
  download(`billable-lines-${period()}.csv`, detailCSV(compile(review, review.period.from, review.period.to)), "text/csv"));
$("totals-csv").addEventListener("click", () =>
  download(`billable-totals-${period()}.csv`, totalsCSV(compile(review, review.period.from, review.period.to)), "text/csv"));

$("lists-save").addEventListener("click", () => {
  saveLists();
  toast("Lists saved. Send staff the link so they get them.");
});
$("lists-link").addEventListener("click", guarded(async () => copyText(await listsLink(), "Link for staff")));
$("lists-qr-btn").addEventListener("click", guarded(async () => {
  const url = await listsLink();
  if (url.length > QR_MAX) return toast("The lists are too long for a QR code. Use Copy link for staff instead.");
  renderQR($("lists-qr"), url, "QR code that gives staff the official lists");
  $("lists-qr").hidden = false;
}));

$("review-export").addEventListener("click", () =>
  download(`billable-review-${dayKey(Date.now())}.json`, JSON.stringify(review, null, 1), "application/json"));
$("review-import").addEventListener("change", guarded(async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let incoming;
  try {
    incoming = JSON.parse(await file.text());
  } catch {
    return toast("Could not read that file as review data.");
  }
  if (!incoming || typeof incoming.people !== "object") return toast("That isn't Billable review data. Hours files go under Add hours files.");
  if (!confirm("Replace everything on this page with the imported review data?")) return;
  commit(normaliseReview(incoming));
  renderListsEditor();
  toast("Review data imported.");
}));
$("review-wipe").addEventListener("click", () => {
  if (!confirm("Erase everyone's hours from this review? The official lists are kept.")) return;
  commit({ ...review, people: {}, reviewed: {} });
});

// Another tab changed the review: adopt it rather than overwrite it later.
window.addEventListener("storage", (e) => {
  if (e.key !== REVIEW_KEY) return;
  review = load();
  renderListsEditor();
  render();
});

save();
renderListsEditor();
render();
