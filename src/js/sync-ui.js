// Encrypted sync: the UI and wiring for it. Loaded only by builds made with
// ENABLE_SYNC=true (see config.js and the Dockerfile). Builds without sync do
// not ship this file, sync.js, crypto.js or words.js at all, so none of this
// code exists in the page and no request to the sync server can be made.
//
// The page hands this module a small interface (`app`) and a set of hooks to
// fill in; it never reaches into the page's internals otherwise.

import { KDF_VERSION, deriveKeys, generatePhrase, normalisePhrase, phraseProblem } from "./crypto.js";
import { createSyncer, mailboxClient } from "./sync.js";

const SYNC_KEY = "billable.sync";

export function installSync(app, hooks) {
  const { $, storage, toast, copyText, guarded, renderQR, requestPersist, clock, build } = app;

  let sync = null;      // { v, phrase, access, key } from storage, or null
  let syncer = null;    // the engine for that config
  let syncTimer = null;
  let working = "";     // "Unlocking…" while deriving keys
  let phraseShown = false;

  function loadConfig() {
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
      getState: app.getState,
      setState: app.replaceState,
      onStatus: renderSync,
    });
    if (config) storage.set(SYNC_KEY, JSON.stringify(config));
    else storage.remove(SYNC_KEY);
  }

  async function keysFor(phrase) {
    return { v: KDF_VERSION, phrase: normalisePhrase(phrase), ...(await deriveKeys(phrase)) };
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
    setWorking("Unlocking…");
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
      app.render();
      if (syncer.status.error) toast(`Connected, but the first sync failed: ${syncer.status.error}.`);
      else toast(existing ? "Connected. This device now has your synced data." : "Sync is on. Use the same passphrase on your other devices.");
      return true;
    } catch (e) {
      toast(`Could not connect: ${e.message || e}`);
      return false;
    } finally {
      setWorking("");
    }
  }

  const syncLink = (phrase) => `${location.origin}/#sync=${phrase.split(" ").join("-")}`;

  function setWorking(msg) {
    working = msg;
    for (const b of document.querySelectorAll("#sync-off button")) b.disabled = !!msg;
    renderSync();
  }

  function renderSync() {
    const on = !!syncer;
    const status = syncer?.status;
    $("sync-off").hidden = on;
    $("sync-on").hidden = !on;
    $("sync-working").textContent = working;
    $("sync-working").hidden = !working;
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

  // A #sync= link from a QR code or a message.
  async function handleLink() {
    const h = location.hash;
    if (!h.startsWith("#sync=")) return;
    // Drop the secret from the address bar and history before anything else.
    history.replaceState(null, "", location.pathname + location.search);
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
  }

  async function showNewPhrase() {
    const { default: words } = await import(`./words.js?v=${build}`);
    $("sync-new-phrase").textContent = generatePhrase(words);
  }

  /* wiring */

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

  $("sync-join").addEventListener("submit", async (e) => {
    e.preventDefault();
    const phrase = $("sync-join-phrase").value;
    if (normalisePhrase(phrase) && (await connect(phrase, "join"))) $("sync-join-phrase").value = "";
  });

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
    app.render();
  });
  $("sync-delete").addEventListener("click", guarded(async () => {
    if (!confirm("Delete the encrypted copy from the server and stop syncing on this device? Data on your devices stays. A device still syncing with this passphrase will upload its copy again; turn sync off there too.")) return;
    await syncer.mailbox.remove();
    useSync(null);
    $("sync-qr").hidden = true;
    app.render();
    toast("Server copy deleted. Sync is off on this device.");
  }));

  window.addEventListener("storage", (e) => {
    if (e.key !== SYNC_KEY) return;
    useFromStorage();
    app.render();
  });
  window.addEventListener("hashchange", handleLink);
  // Poll while visible so a timer started on the phone shows up on the laptop.
  setInterval(() => { if (!document.hidden) syncNow(); }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && syncTimer) syncNow(); // push a pending change before the tab is backgrounded
    else if (!document.hidden) syncNow();
  });
  window.addEventListener("online", () => syncNow());

  function useFromStorage() {
    const config = loadConfig();
    if (!config) return useSync(null);
    if (config.v === KDF_VERSION) return useSync(config);
    // Saved by an older key scheme: derive current keys from the stored passphrase.
    keysFor(config.phrase).then((fresh) => {
      useSync(fresh);
      syncNow();
    }).catch(() => {});
  }

  // Plug into the page.
  hooks.changed = () => scheduleSync();
  hooks.active = () => !!syncer;
  hooks.render = renderSync;

  useFromStorage();
  app.render();
  handleLink();
  syncNow();
}
