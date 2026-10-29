// Small DOM and browser helpers shared by the app (app.js) and the review page
// (review.js). Nothing here touches the network.

// localStorage can throw: quota exceeded, storage disabled, some private modes.
export const storage = {
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

export function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Returns whether the copy worked. Toasts itself only when given a label.
export async function copyText(text, what) {
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
export function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 4000);
}

// Wraps an async event handler so a failure is shown rather than swallowed.
export const guarded = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (e) {
    toast(e.message || String(e));
  }
};

// Small element builder; text always goes through textContent, never HTML.
export function el(tag, props = {}, ...kids) {
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

const SVG_NS = "http://www.w3.org/2000/svg";

// Built from the module grid as one SVG path, rather than the library's own
// SVG/GIF helpers, so nothing is injected as HTML and the strict CSP holds.
// The library (qrcode-generator, vendored) loads with the page, so drawing a
// code later fetches nothing.
export function renderQR(container, text, label) {
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
