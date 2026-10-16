// The sync engine: pull, merge, push. It knows nothing about the page; the UI
// gives it a way to read and replace state, and a fetch to talk to the server.
// Tests give it a fake fetch backed by an in-memory mailbox.

import { decryptState, encryptState, importKey } from "./crypto.js";
import { merge, normalise, pruneTombstones, sameData } from "./model.js";

const ENDPOINT = "/api/sync";

export class SyncError extends Error {}

// Every request gives up after `timeoutMs`, so a half-open mobile connection
// cannot leave sync stuck in "Syncing…" until the page is reloaded.
export function mailboxClient(access, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  async function call(method, body) {
    const headers = { Authorization: `Bearer ${access}` };
    if (body) headers["Content-Type"] = "application/json";
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      return await fetchImpl(ENDPOINT, {
        method,
        headers,
        body: body && JSON.stringify(body),
        cache: "no-store",
        signal: abort.signal,
      });
    } catch {
      throw new SyncError(abort.signal.aborted ? "the server took too long; will retry" : "offline; will retry");
    } finally {
      clearTimeout(timer);
    }
  }

  async function reason(res) {
    try {
      const j = await res.json();
      if (j.error) return j.error;
    } catch { /* not JSON */ }
    return `server said ${res.status}`;
  }

  return {
    // -> { rev, blob } or null when the mailbox does not exist
    async get() {
      const res = await call("GET");
      if (res.status === 404) return null;
      if (!res.ok) throw new SyncError(await reason(res));
      return res.json();
    },
    // -> new rev, or null when another device saved first (409)
    async put(rev, blob) {
      const res = await call("PUT", { rev, blob });
      if (res.status === 409) return null;
      if (res.status === 413) throw new SyncError("your data has grown too large to sync; export a backup and delete old entries");
      if (!res.ok) throw new SyncError(await reason(res));
      return (await res.json()).rev;
    },
    async remove() {
      const res = await call("DELETE");
      if (!res.ok && res.status !== 404) throw new SyncError(await reason(res));
    },
  };
}

// One sync pass. Pulls the mailbox, merges it into local state, and pushes
// only if the merge changed anything. A 409 means another device saved in
// between: go round again and merge their change too.
export async function syncOnce({ mailbox, key, getState, setState, now = Date.now() }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const remote = await mailbox.get();
    const theirs = remote ? await decryptState(remote.blob, key) : null;
    const merged = pruneTombstones(theirs ? merge(getState(), theirs) : normalise(getState()), now);
    if (!sameData(merged, getState())) setState(merged);
    if (theirs && sameData(merged, theirs)) return;
    const rev = await mailbox.put(remote ? remote.rev : 0, await encryptState(merged, key));
    if (rev !== null) return;
  }
  throw new SyncError("another device kept saving at the same moment; will retry");
}

// Serialises passes: a sync requested while one runs is queued, not doubled.
export function createSyncer({ config, getState, setState, onStatus = () => {}, fetchImpl, timeoutMs }) {
  const mailbox = mailboxClient(config.access, { fetchImpl, timeoutMs });
  let keyPromise = null;
  let running = null;
  let again = false;
  const status = { busy: false, error: "", last: 0 };

  async function pass() {
    status.busy = true;
    onStatus(status);
    try {
      keyPromise ||= importKey(config.key);
      await syncOnce({ mailbox, key: await keyPromise, getState, setState });
      status.error = "";
      status.last = Date.now();
    } catch (e) {
      status.error = e instanceof SyncError ? e.message : `unexpected error: ${e.message || e}`;
    } finally {
      status.busy = false;
      onStatus(status);
    }
  }

  return {
    status,
    mailbox,
    sync() {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        do {
          again = false;
          await pass();
        } while (again);
        running = null;
      })();
      return running;
    },
  };
}
