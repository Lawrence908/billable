import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveKeys, importKey } from "../src/js/crypto.js";
import { existingSessions, normalise, sameData } from "../src/js/model.js";
import { createSyncer, mailboxClient, syncOnce } from "../src/js/sync.js";

// Same contract as api/server.py, in memory: revisions, 404, 409.
function fakeServer() {
  const boxes = new Map();
  const server = {
    boxes,
    puts: 0,
    // Called before each PUT is applied; lets a test sneak in a rival write.
    beforePut: null,
    async fetch(url, { method, headers, body }) {
      const key = headers.Authorization.slice(7);
      const json = (status, obj) => new Response(obj === undefined ? null : JSON.stringify(obj), { status });
      const box = boxes.get(key);
      if (method === "GET") return box ? json(200, box) : json(404, { error: "no mailbox" });
      if (method === "DELETE") return boxes.delete(key) ? json(204) : json(404, { error: "no mailbox" });
      if (method === "PUT") {
        if (server.beforePut) {
          const hook = server.beforePut;
          server.beforePut = null;
          await hook();
        }
        const { rev, blob } = JSON.parse(body);
        const current = boxes.get(key)?.rev ?? 0;
        if (rev !== current) return json(409, { rev: current });
        server.puts++;
        boxes.set(key, { rev: current + 1, blob });
        return json(200, { rev: current + 1 });
      }
      return json(405, {});
    },
  };
  return server;
}

let keysCache;
async function keys() {
  keysCache ||= await deriveKeys("maple river copper tiger lunar hinge");
  return keysCache;
}

async function device(server, initial) {
  const k = await keys();
  let state = normalise(initial);
  const syncer = createSyncer({
    config: k,
    getState: () => state,
    setState: (s) => { state = s; },
    fetchImpl: server.fetch,
  });
  return {
    get state() { return state; },
    set state(s) { state = normalise(s); },
    sync: () => syncer.sync(),
    status: syncer.status,
  };
}

const client = (id, name, updated = 1) => ({ id, name, archived: false, updated });
const session = (id, clientId, start, end, updated = 1) => ({ id, clientId, start, end, updated });

test("two devices converge on the union of their data", async () => {
  const server = fakeServer();
  const phone = await device(server, { clients: [client("a", "Acme")], sessions: [session("1", "a", 0, 100)] });
  const laptop = await device(server, { clients: [client("b", "Beta")], sessions: [session("2", "b", 200, 300)] });
  await phone.sync();
  await laptop.sync();
  await phone.sync();
  assert.ok(sameData(phone.state, laptop.state));
  assert.equal(existingSessions(phone.state).length, 2);
  assert.equal(phone.status.error, "");
});

test("a pass with nothing new does not write", async () => {
  const server = fakeServer();
  const phone = await device(server, { clients: [client("a", "Acme")] });
  await phone.sync();
  const writes = server.puts;
  await phone.sync();
  assert.equal(server.puts, writes);
});

test("same-named clients from two devices become one, with both devices' hours", async () => {
  const server = fakeServer();
  const phone = await device(server, { clients: [client("a1", "Acme")], sessions: [session("1", "a1", 0, 60e3)] });
  const laptop = await device(server, { clients: [client("b1", "ACME")], sessions: [session("2", "b1", 120e3, 180e3)] });
  await phone.sync();
  await laptop.sync();
  await phone.sync();
  for (const d of [phone, laptop]) {
    const live = d.state.clients.filter((c) => !c.deleted);
    assert.deepEqual(live.map((c) => c.id), ["a1"], "the older client is kept");
    assert.ok(existingSessions(d.state).every((s) => s.clientId === "a1"));
    assert.equal(existingSessions(d.state).length, 2);
  }
  assert.ok(sameData(phone.state, laptop.state));
});

test("a rival write between pull and push is merged, not lost", async () => {
  const server = fakeServer();
  const phone = await device(server, { clients: [client("a", "Acme")] });
  const laptop = await device(server, {});
  await phone.sync();
  await laptop.sync();
  // While the phone is mid-pass, the laptop adds a client and saves first.
  phone.state = { ...phone.state, clients: [...phone.state.clients, client("p", "Phone only", 5)] };
  server.beforePut = async () => {
    laptop.state = { ...laptop.state, clients: [...laptop.state.clients, client("l", "Laptop only", 6)] };
    await laptop.sync();
  };
  await phone.sync();
  await laptop.sync();
  const names = (d) => d.state.clients.filter((c) => !c.deleted).map((c) => c.name).sort();
  assert.deepEqual(names(phone), ["Acme", "Laptop only", "Phone only"]);
  assert.deepEqual(names(laptop), names(phone));
});

test("a deletion on one device removes the entry on the other", async () => {
  const server = fakeServer();
  const phone = await device(server, { clients: [client("a", "Acme")], sessions: [session("1", "a", 0, 100)] });
  const laptop = await device(server, {});
  await phone.sync();
  await laptop.sync();
  laptop.state = { ...laptop.state, sessions: [{ id: "1", deleted: true, updated: Date.now() }] };
  await laptop.sync();
  await phone.sync();
  assert.equal(existingSessions(phone.state).length, 0);
});

test("a hung connection times out instead of leaving sync stuck", async () => {
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const k = await keys();
  const mailbox = mailboxClient(k.access, { fetchImpl: hang, timeoutMs: 50 });
  await assert.rejects(
    syncOnce({ mailbox, key: await importKey(k.key), getState: () => normalise({}), setState: () => {} }),
    /took too long/,
  );
});

test("concurrent sync calls are serialised into one extra pass", async () => {
  const server = fakeServer();
  let gets = 0;
  const counting = { fetch: (url, opts) => { if (opts.method === "GET") gets++; return server.fetch(url, opts); } };
  const phone = await device(counting, { clients: [client("a", "Acme")] });
  await Promise.all([phone.sync(), phone.sync(), phone.sync()]);
  assert.equal(gets, 2, "one pass, plus one queued pass covering both later calls");
});
