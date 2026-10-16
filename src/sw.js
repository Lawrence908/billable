// Offline support: keeps a copy of the app so Billable opens with no signal.
//
// Your data never passes through here. It lives in localStorage, and /api/
// (sync) requests are left to the network untouched. Each deploy stamps a new
// version below, which installs a fresh copy and deletes the previous one.

const VERSION = "__BUILD_ID__";
const SHELL = [
  "/",
  "/app.css?v=__BUILD_ID__",
  "/js/app.js?v=__BUILD_ID__",
  "/js/model.js?v=__BUILD_ID__",
  "/js/crypto.js?v=__BUILD_ID__",
  "/js/sync.js?v=__BUILD_ID__",
  "/js/transfer.js?v=__BUILD_ID__",
  "/js/words.js?v=__BUILD_ID__",
  "/vendor/qrcode-2.0.4.js?v=__BUILD_ID__",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/favicon.ico",
  "/apple-touch-icon.png",
];
// On a weak signal, wait this long for a fresh page before using the saved one.
const NETWORK_TIMEOUT = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(req.mode === "navigate" ? page(req) : asset(req));
});

// The page: network first, so a deploy shows up straight away, falling back to
// the saved copy when offline or slow.
async function page(req) {
  const cache = await caches.open(VERSION);
  try {
    const fresh = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), NETWORK_TIMEOUT)),
    ]);
    if (fresh.ok) cache.put("/", fresh.clone());
    return fresh;
  } catch {
    return (await cache.match("/")) || Response.error();
  }
}

// Everything else is versioned by URL, so a saved copy is never stale.
async function asset(req) {
  const cache = await caches.open(VERSION);
  const saved = await cache.match(req);
  if (saved) return saved;
  const fresh = await fetch(req);
  if (fresh.ok) cache.put(req, fresh.clone());
  return fresh;
}
