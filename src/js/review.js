// The review page: loads everyone's hours files, checks them against the
// official lists, and produces the hand-off. The rules live in
// review-model.js; this file connects them to the DOM. Like the app, it makes
// no network requests: files come in through the file picker, and everything
// stays in this browser's storage.

import { CATEGORIES, CO_CATEGORY, dayKey, fmtHours, shiftDay } from "./model.js";
import {
  addHoursFile, addOfficialClient, addOfficialCustomer, addOfficialTask, addOrder, clientTSV, compile, detailCSV, encodeLists, handoffText, normaliseLists, normaliseReview,
  optimizationCustomers, optimizationTSV, parseHoursFile, parseList, phaseLabel, removeOrder, removePerson, reviewGrid, reviewedFor, setAlias, setBilling, setOrderAlias,
  setOrderRetired, setReviewed, setTaskAlias, totalsCSV, weekStart,
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

// What the reviewer is looking at. Not saved: a reload starts at the top.
const ui = { view: { level: "clients" }, search: "", unreviewedOnly: false, hidden: new Set(), sel: null };

// Everything, for the files list and Checks; and what is billed, for the
// review grid, the totals and the hand-off.
const compiledAll = () => compile(review, review.period.from, review.period.to);
const compiled = () => compile(review, review.period.from, review.period.to, { billableOnly: review.prefs.billableOnly });

function render() {
  const { from, to } = review.period;
  $("period-from").value = from;
  $("period-to").value = to;
  const all = compiledAll();
  const c = compiled();
  $("period-label").textContent = `${fmtDay(from)} to ${fmtDay(to)}${review.prefs.billableOnly ? ", billable" : ""}`;
  $("period-total").textContent = fmtHours(c.hours);
  renderPeople(all);
  renderChecks(all);
  renderReview(c);
  renderBilling(all);
  renderGlance(c);
  if (document.activeElement !== $("ar-email")) $("ar-email").value = review.arEmail;
  const { clients, customers, orders } = review.lists;
  $("lists-badge").textContent = clients.length || customers.length || orders.length
    ? `${plural(clients.length, "client", "clients")}, ${plural(customers.length, "customer", "customers")}, ${plural(orders.filter((o) => !o.retired).length, "CO", "COs")}`
    : "None yet";
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

// A check that can be fixed: map it to an official name, or add it to the list.
function mapSelect(label, prompt, names, onPick) {
  return el("select", { "aria-label": label, onchange: (e) => { if (e.target.value) onPick(e.target.value); } },
    el("option", { value: "", text: prompt }), ...names.map((n) => el("option", { value: n, text: n })));
}
const addButton = (label, onclick) => el("button", { type: "button", class: "btn btn-small", text: "Add to list", "aria-label": label, onclick });

// Changes the lists from a check. Edits waiting in the lists editor are kept
// and saved along with it.
function changeLists(fn) {
  review = { ...review, lists: readListsEditor() };
  commit(fn(review));
  renderListsEditor();
}

function renderChecks(c) {
  const { checks } = c;
  const items = [];
  for (const u of checks.unknownClients) {
    items.push(el("li", {},
      el("span", { text: `"${u.name}" isn't an official client (${fmtHours(u.hours)} h from ${u.people.join(", ")}).` }),
      review.lists.clients.length
        ? mapSelect(`Official name for ${u.name}`, "Map to an official client...", review.lists.clients, (v) => commit(setAlias(review, u.name, v)))
        : null,
      addButton(`Add ${u.name} to the official clients`, () => changeLists((r) => addOfficialClient(r, u.name, Date.now())))));
  }
  for (const u of checks.unknownCustomers) {
    const known = optimizationCustomers(review.lists);
    items.push(el("li", {},
      el("span", { text: `"${u.name}" isn't on the customer lists, for change orders (${fmtHours(u.hours)} h from ${u.people.join(", ")}).` }),
      known.length ? mapSelect(`Official name for ${u.name}`, "Map to a customer...", known, (v) => commit(setAlias(review, u.name, v))) : null,
      addButton(`Add ${u.name} to the existing customers`, () => changeLists((r) => addOfficialCustomer(r, u.name, Date.now())))));
  }
  for (const o of checks.otherOrders) {
    items.push(el("li", {},
      el("span", { text: `${o.customer}: "${o.number}" isn't on their change orders (${fmtHours(o.hours)} h from ${o.people.join(", ")}).` }),
      o.orders.length ? mapSelect(`Listed change order for ${o.number}`, "Map to a change order...", o.orders, (v) => commit(setOrderAlias(review, o.customer, o.number, v))) : null,
      addButton(`Add ${o.number} to ${o.customer}'s change orders`, () => changeLists((r) => addOrder(r, o.customer, o.number, Date.now())))));
  }
  for (const n of checks.noOrder) {
    items.push(el("li", {}, el("span", { text: `${n.employee} has ${fmtHours(n.hours)} h on ${n.client} with no change order number.` })));
  }
  for (const t of checks.otherTasks) {
    items.push(el("li", {},
      el("span", { text: `${t.label}: "${t.note || "no task"}" isn't on the task list (${fmtHours(t.hours)} h from ${t.people.join(", ")}).` }),
      t.note ? mapSelect(`Official task for ${t.note}`, "Map to an official task...", t.tasks, (v) => commit(setTaskAlias(review, t.category, t.note, v))) : null,
      t.note ? addButton(`Add ${t.note} to the ${t.label} tasks`, () => changeLists((r) => addOfficialTask(r, t.category, t.note, Date.now()))) : null));
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
  // Mappings already set, so a wrong one can be undone.
  for (const [typed, official] of Object.entries(review.aliases)) {
    items.push(el("li", { class: "muted" },
      el("span", { text: `Counting "${typed}" as ${official}.` }),
      el("button", { type: "button", class: "btn btn-small", text: "Undo", onclick: () => commit(setAlias(review, typed, "")) })));
  }
  for (const [key, official] of Object.entries(review.taskAliases)) {
    const [category, typed] = key.split("\u0000");
    items.push(el("li", { class: "muted" },
      el("span", { text: `Counting "${typed}" under ${phaseLabel(review.lists, category)} as ${official}.` }),
      el("button", { type: "button", class: "btn btn-small", text: "Undo", onclick: () => commit(setTaskAlias(review, category, typed, "")) })));
  }
  for (const [key, official] of Object.entries(review.orderAliases)) {
    const [customer, typed] = key.split("\u0000");
    items.push(el("li", { class: "muted" },
      el("span", { text: `Counting "${typed}" for ${customer} as ${official}.` }),
      el("button", { type: "button", class: "btn btn-small", text: "Undo", onclick: () => commit(setOrderAlias(review, customer, typed, "")) })));
  }
  const problems = items.filter((li) => !li.classList.contains("muted")).length;
  $("checks-badge").textContent = problems ? plural(problems, "thing to check", "things to check") : "All clear";
  $("checks-badge").className = `fold-status ${problems ? "bad" : "good"}`;
  if (!items.length) items.push(el("li", { class: "muted" }, el("span", { text: Object.keys(review.people).length ? "Nothing to check for this period." : "Checks appear once hours files are added." })));
  $("checks").replaceChildren(...items);
}

/* ---------- the review grid ---------- */

const up = (v) => (v.level === "clients" ? null : v.level === "client" ? { level: "clients" } : { level: "client", client: v.client });
const shortDay = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
};
const isWeekend = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return [0, 6].includes(new Date(y, m - 1, d).getDay());
};
const lineLabel = (key) => {
  const [category, note] = key.split("\u0000");
  return `${category ? phaseLabel(review.lists, category) : "No category"}${note ? ` · ${note}` : ""}`;
};

function go(view) {
  ui.view = view;
  ui.sel = null;
  render();
  $("grid-wrap").scrollLeft = 0;
}

// The filters that only change what is shown: people, client search, reviewed.
function visible(c) {
  const ticks = reviewedFor(review, review.period.from, review.period.to);
  const q = ui.search.trim().toLowerCase();
  const rows = c.rows.filter((r) => !ui.hidden.has(r.employee)
    && (ui.view.level !== "clients" || !q || r.client.toLowerCase().includes(q))
    && (ui.view.level !== "clients" || !ui.unreviewedOnly || !ticks[r.client]));
  return { ...c, rows };
}

function renderReview(c) {
  const { from, to } = review.period;
  const ticks = reviewedFor(review, from, to);
  const done = c.clients.filter((x) => ticks[x.name]).length;
  $("reviewed-badge").textContent = c.clients.length ? `${done} of ${c.clients.length} reviewed` : "";
  $("reviewed-badge").className = `fold-status${c.clients.length && done === c.clients.length ? " good" : ""}`;
  $("billable-only").checked = review.prefs.billableOnly;
  $("value-mode").value = review.prefs.tracked ? "tracked" : "hours";
  $("unreviewed-only").checked = ui.unreviewedOnly;
  if (document.activeElement !== $("client-search")) $("client-search").value = ui.search;
  $("client-search").hidden = ui.view.level !== "clients";
  $("unreviewed-only").closest("label").hidden = ui.view.level !== "clients";
  renderPeopleFilter(c);

  // A view whose client or person has no hours any more (a new period, say) falls back to the top.
  const v = ui.view;
  if ((v.client && !c.rows.some((r) => r.client === v.client))
    || (v.employee && !c.rows.some((r) => r.client === v.client && r.employee === v.employee))) ui.view = { level: "clients" };

  renderCrumbs();
  const shown = visible(c);
  const g = reviewGrid(shown, ui.view, { tracked: review.prefs.tracked });
  $("grid-empty").hidden = g.rowKeys.length > 0;
  $("grid-wrap").hidden = !g.rowKeys.length;
  $("grid-hint").textContent = {
    clients: "Click a client, or double-click a row, to see who worked on it. Drag across cells to add them up; Ctrl+C copies them for Excel.",
    client: "Click a person to see their tasks by day, or a heading to see that category's tasks by person. Esc goes back up.",
    person: "Each task by day, as this person tracked it. Esc goes back up.",
    category: "Each task in this category, by person. Esc goes back up.",
  }[ui.view.level];
  renderGrid(g, ticks, shown);
}

function renderCrumbs() {
  const v = ui.view;
  const crumb = (text, view) => (view ? el("button", { type: "button", class: "crumb", text, onclick: () => go(view) }) : el("span", { class: "crumb here", text, "aria-current": "page" }));
  const parts = [crumb("All clients", v.level === "clients" ? null : { level: "clients" })];
  if (v.client) parts.push(crumb(v.client, v.level === "client" ? null : { level: "client", client: v.client }));
  if (v.level === "person") parts.push(crumb(v.employee, null));
  if (v.level === "category") parts.push(crumb(phaseLabel(review.lists, v.category), null));
  $("crumbs").replaceChildren(...parts.flatMap((p, i) => (i ? [el("span", { class: "crumb-sep", text: "›", "aria-hidden": "true" }), p] : [p])));
}

function renderPeopleFilter(c) {
  const names = [...new Set(c.rows.map((r) => r.employee))].sort((a, b) => a.localeCompare(b));
  const shown = names.filter((n) => !ui.hidden.has(n)).length;
  $("people-summary").textContent = shown === names.length ? "Everyone" : `${shown} of ${names.length} people`;
  if ($("people-filter").contains(document.activeElement)) return;
  $("people-options").replaceChildren(...names.map((n) => el("label", { class: "check" },
    el("input", { type: "checkbox", checked: !ui.hidden.has(n), onchange: (e) => { if (e.target.checked) ui.hidden.delete(n); else ui.hidden.add(n); render(); } }),
    el("span", { text: n }))));
}

// The grid as a matrix of values, so a selection can be added up or copied.
let matrix = [];

function renderGrid(g, ticks, c) {
  const v = ui.view;
  const fmt = (n) => (n ? fmtHours(n) : "");
  const colLabel = (k) => (v.level === "person" ? shortDay(k) : v.level === "category" ? k : k ? phaseLabel(review.lists, k) : "No category");
  const rowLabel = (k) => (v.level === "person" ? lineLabel(k) : v.level === "category" ? k || "No task" : k);
  const drill = (rk) => (v.level === "clients" ? { level: "client", client: rk } : v.level === "client" ? { level: "person", client: v.client, employee: rk } : null);
  const corner = { clients: "Reviewed · Client", client: "Person", person: "Task", category: "Task" }[v.level];
  const level1 = v.level === "clients";

  const head = el("tr", {}, el("th", { class: "corner", scope: "col", text: corner }),
    ...g.colKeys.map((k) => {
      const label = colLabel(k).replace(/\//g, "/\u200b"); // a heading may wrap after a slash
      const cls = `num${v.level === "person" && isWeekend(k) ? " weekend" : ""}`;
      if (v.level === "client") {
        return el("th", { class: cls, scope: "col" }, el("button", { type: "button", class: "link", text: label, title: `${label}: tasks by person`, onclick: () => go({ level: "category", client: v.client, category: k }) }));
      }
      return el("th", { class: cls, scope: "col", text: label, title: v.level === "person" ? k : label });
    }),
    el("th", { class: "num total", scope: "col", text: "Total" }));

  matrix = [];
  const body = g.rowKeys.map((rk, r) => {
    const values = [...g.colKeys.map((ck) => g.cell(rk, ck)?.value || 0), g.rowTotal(rk)];
    matrix.push(values);
    const target = drill(rk);
    const name = target
      ? el("button", { type: "button", class: "link", text: rowLabel(rk), onclick: () => go(target) })
      : el("span", { text: rowLabel(rk) });
    const unofficial = level1 && c.rows.some((x) => x.client === rk && !x.officialClient);
    // On the top level the row heading also holds the Reviewed tick and the
    // copy button, so they stay in view however far the grid scrolls.
    const header = level1
      ? el("th", { scope: "row", class: unofficial ? "unofficial" : "" }, el("div", { class: "row-tools" },
        el("label", { class: "check", title: "Reviewed" },
          el("input", { type: "checkbox", checked: !!ticks[rk], onchange: (e) => commit(setReviewed(review, review.period.from, review.period.to, rk, e.target.checked)) }),
          el("span", { class: "visually-hidden", text: `${rk} reviewed` })),
        name,
        // Change orders copy together under Hand off, so a customer with only those has nothing here.
        c.rows.some((x) => x.client === rk && x.category !== CO_CATEGORY) ? el("button", {
          type: "button", class: "btn btn-small copy-mini", text: "Copy", "aria-label": `Copy ${rk}'s rows for the timesheet`,
          onclick: () => copyText(clientTSV(c, rk), `${rk}'s rows`),
        }) : null))
      : el("th", { scope: "row" }, name);
    return el("tr", {},
      header,
      ...g.colKeys.map((ck, i) => {
        const cell = g.cell(rk, ck);
        return el("td", {
          class: `num cell${cell?.flagged ? " flag" : ""}${v.level === "person" && isWeekend(ck) ? " weekend" : ""}`,
          "data-r": r, "data-c": i, title: cell?.flagged ? "Includes something listed under Checks" : null, text: fmt(cell?.value),
        });
      }),
      el("td", { class: "num cell total", "data-r": r, "data-c": g.colKeys.length, text: fmt(g.rowTotal(rk)) }));
  });

  const totals = [...g.colKeys.map((ck) => g.colTotal(ck)), g.total];
  matrix.push(totals);
  const r = g.rowKeys.length;
  const foot = el("tr", {}, el("th", { scope: "row", text: "Total" }),
    ...totals.map((t, i) => el("td", { class: "num cell total", "data-r": r, "data-c": i, text: fmt(t) })));

  $("grid").replaceChildren(el("thead", {}, head), el("tbody", {}, ...body), el("tfoot", {}, foot));
  paintSelection();
}

/* ---------- selecting cells, as in a spreadsheet ---------- */

let dragging = false;
const cellAt = (t) => t?.closest?.("td.cell");
const pos = (td) => ({ r: Number(td.dataset.r), c: Number(td.dataset.c) });

function selected() {
  if (!ui.sel) return [];
  const { a, b } = ui.sel;
  const out = [];
  for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
    const row = [];
    for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) row.push(matrix[r]?.[c] ?? 0);
    out.push(row);
  }
  return out;
}

function paintSelection() {
  const s = ui.sel;
  for (const td of $("grid").querySelectorAll("td.cell")) {
    const { r, c } = pos(td);
    td.classList.toggle("sel", !!s && r >= Math.min(s.a.r, s.b.r) && r <= Math.max(s.a.r, s.b.r) && c >= Math.min(s.a.c, s.b.c) && c <= Math.max(s.a.c, s.b.c));
  }
  const values = selected().flat().filter((n) => n);
  $("grid-sum").textContent = values.length
    ? `Sum ${fmtHours(values.reduce((x, y) => x + y, 0))}   Count ${values.length}   Average ${fmtHours(values.reduce((x, y) => x + y, 0) / values.length)}`
    : "";
}

const grid = $("grid");
grid.addEventListener("mousedown", (e) => {
  const td = cellAt(e.target);
  if (!td || e.button !== 0) return;
  e.preventDefault(); // no text selection while dragging
  const p = pos(td);
  ui.sel = e.shiftKey && ui.sel ? { a: ui.sel.a, b: p } : { a: p, b: p };
  dragging = true;
  paintSelection();
});
grid.addEventListener("mouseover", (e) => {
  const td = cellAt(e.target);
  if (!dragging || !td) return;
  ui.sel = { a: ui.sel.a, b: pos(td) };
  paintSelection();
});
document.addEventListener("mouseup", () => { dragging = false; });
grid.addEventListener("dblclick", (e) => {
  const td = cellAt(e.target);
  if (!td || td.closest("tfoot")) return;
  const row = td.closest("tr").querySelector("th button.link");
  row?.click();
});

const typingHere = () => document.activeElement?.matches("input, textarea, select");
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || typingHere()) return;
  if (ui.sel) {
    ui.sel = null;
    paintSelection();
  } else if (up(ui.view)) go(up(ui.view));
});
// Ctrl+C with cells selected copies them, tab-separated, for Excel or Sheets.
document.addEventListener("copy", (e) => {
  if (!ui.sel || typingHere() || String(document.getSelection())) return;
  e.preventDefault();
  e.clipboardData.setData("text/plain", selected().map((row) => row.map((n) => (n ? fmtHours(n) : "")).join("\t")).join("\n"));
  toast("Cells copied.");
});

/* ---------- not billed ---------- */

function renderBilling(all) {
  const { billing } = review;
  const box = (label, kind, name) => el("label", { class: "check" },
    el("input", { type: "checkbox", checked: kind === "categories" ? billing.categories.includes(name) : billing.clients.some((x) => x.toLowerCase() === name.toLowerCase()),
      onchange: (e) => commit(setBilling(review, kind, name, !e.target.checked)) }),
    el("span", { text: label }));
  $("billing-categories").replaceChildren(
    ...CATEGORIES.map((c) => box(phaseLabel(review.lists, c.key), "categories", c.key)),
    box("No category", "categories", ""));
  const seen = new Map();
  for (const n of [...review.lists.clients, ...review.lists.customers, ...all.clients.map((x) => x.name), ...billing.clients]) if (!seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  $("billing-clients").replaceChildren(...[...seen.values()].sort((a, b) => a.localeCompare(b)).map((n) => box(n, "clients", n)));
  const count = billing.categories.length + billing.clients.length;
  $("billing-badge").textContent = count ? `${count} not billed` : "Everything billed";
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
  $("lists-customers").value = lists.customers.join("\n");
  renderOrders();
  $("lists-phases").replaceChildren(...CATEGORIES.map((c) => el("label", { class: "field" },
    el("span", { class: "label", text: c.label }),
    el("input", { type: "text", maxlength: "80", "data-phase": c.key, value: lists.phases[c.key] || "", placeholder: "As in the Sheet (optional)" }))));
  const groups = [{ key: "*", label: "All categories" }, ...CATEGORIES.map((c) => ({ key: c.key, label: phaseLabel(lists, c.key) }))];
  $("lists-tasks").replaceChildren(...groups.map((g) => {
    const area = el("textarea", { rows: "4", "data-tasks": g.key });
    area.value = (lists.tasks[g.key] || []).join("\n");
    return el("label", { class: "field" }, el("span", { class: "label", text: g.label }), area);
  }));
}

// Change orders save as soon as they change: nobody should approve one and
// lose it to an unsaved page. The customer dropdown follows the two lists above
// it as they are being typed.
function renderOrders() {
  const select = $("order-customer");
  const keep = select.value;
  const names = optimizationCustomers({ clients: parseList($("lists-clients").value), customers: parseList($("lists-customers").value) });
  select.replaceChildren(el("option", { value: "", text: "Customer..." }), ...names.map((n) => el("option", { value: n, text: n })));
  if (names.includes(keep)) select.value = keep;
  const sorted = [...review.lists.orders].sort((a, b) => a.customer.localeCompare(b.customer) || a.number.localeCompare(b.number, undefined, { numeric: true }));
  const tools = (o) => [
    el("button", {
      type: "button", class: "btn btn-small", text: o.retired ? "Bring back" : "Retire",
      "aria-label": `${o.retired ? "Bring back" : "Retire"} ${o.number} for ${o.customer}`,
      onclick: () => changeLists((r) => setOrderRetired(r, o.customer, o.number, !o.retired, Date.now())),
    }),
    el("button", {
      type: "button", class: "btn btn-small btn-danger", text: "✕",
      "aria-label": `Delete ${o.number} for ${o.customer}`,
      onclick: () => { if (confirm(`Delete ${o.number} for ${o.customer}? To stop people picking a finished one, use Retire: this is for mistakes.`)) changeLists((r) => removeOrder(r, o.customer, o.number, Date.now())); },
    }),
  ];
  $("lists-orders").replaceChildren(...sorted.map((o) => el("li", { class: o.retired ? "muted" : "" },
    el("span", { text: `${o.customer} · ${o.number}${o.retired ? " (retired)" : ""}` }), ...tools(o))));
}

function readListsEditor() {
  const phases = {};
  for (const input of document.querySelectorAll("[data-phase]")) phases[input.dataset.phase] = input.value;
  const tasks = {};
  for (const area of document.querySelectorAll("[data-tasks]")) tasks[area.dataset.tasks] = parseList(area.value);
  return normaliseLists({ clients: parseList($("lists-clients").value), customers: parseList($("lists-customers").value), orders: review.lists.orders, phases, tasks, by: $("lists-by").value, updated: Date.now() });
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

$("billable-only").addEventListener("change", (e) => { ui.sel = null; commit({ ...review, prefs: { ...review.prefs, billableOnly: e.target.checked } }); });
$("value-mode").addEventListener("change", (e) => { ui.sel = null; commit({ ...review, prefs: { ...review.prefs, tracked: e.target.value === "tracked" } }); });
$("unreviewed-only").addEventListener("change", (e) => { ui.unreviewedOnly = e.target.checked; ui.sel = null; render(); });
$("client-search").addEventListener("input", (e) => { ui.search = e.target.value; ui.sel = null; render(); });

$("ar-email").addEventListener("change", (e) => commit({ ...review, arEmail: e.target.value.trim().slice(0, 200) }));
const summary = () => handoffText(compiled());
$("email-btn").addEventListener("click", () => {
  const to = review.arEmail.split(/[,;\s]+/).filter(Boolean).map(encodeURIComponent).join(",");
  const subject = encodeURIComponent(`Billable hours ${review.period.from} to ${review.period.to}`);
  location.href = `mailto:${to}?subject=${subject}&body=${encodeURIComponent(summary())}`;
});
$("copy-summary").addEventListener("click", () => copyText(summary(), "Summary"));
const period = () => `${review.period.from}-to-${review.period.to}`;
$("detail-csv").addEventListener("click", () =>
  download(`billable-lines-${period()}.csv`, detailCSV(compiled()), "text/csv"));
$("totals-csv").addEventListener("click", () =>
  download(`billable-totals-${period()}.csv`, totalsCSV(compiled()), "text/csv"));

$("co-tsv").addEventListener("click", () => {
  const tsv = optimizationTSV(compiled());
  if (tsv) copyText(tsv, "Optimization rows");
  else toast("No change order hours in this period.");
});

for (const id of ["lists-clients", "lists-customers"]) $(id).addEventListener("input", renderOrders);
$("order-add").addEventListener("submit", (e) => {
  e.preventDefault();
  const customer = $("order-customer").value;
  const number = $("order-number").value.trim().toUpperCase();
  if (!customer || !number) return toast("Pick a customer and type the change order number.");
  changeLists((r) => addOrder(r, customer, number, Date.now()));
  $("order-number").value = "";
  $("order-customer").value = customer;
  $("order-number").focus();
  toast(`${number} added for ${customer}. Send staff the link so they get it.`);
});

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
