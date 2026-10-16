import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decryptState, deriveKeys, encryptState, fromB64u, generatePhrase, importKey,
  normalisePhrase, phraseProblem, toB64u,
} from "../src/js/crypto.js";
import { normalise } from "../src/js/model.js";
import { applyTransfer, buildTransfer, decodeTransfer, encodeTransfer } from "../src/js/transfer.js";

const sample = normalise({
  clients: [{ id: "a", name: "Acme Corp", archived: false, updated: 1 }, { id: "b", name: "Café Øst", archived: false, updated: 1 }],
  sessions: [{ id: "s", clientId: "a", start: Date.UTC(2026, 9, 15, 16), end: Date.UTC(2026, 9, 15, 18, 10), updated: 1 }],
  settings: { email: "me@work.com", allowOverlap: false, updated: 1 },
});

test("base64url round-trips arbitrary bytes, including large buffers", () => {
  const bytes = new Uint8Array(200000).map((_, i) => (i * 7919) % 256);
  const s = toB64u(bytes);
  assert.match(s, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(fromB64u(s), bytes);
});

test("passphrases ignore case, spacing and punctuation", () => {
  assert.equal(normalisePhrase("  Maple-River   COPPER, tiger! "), "maple river copper tiger");
  assert.equal(normalisePhrase("café ÉTÉ"), "café été");
});

test("own passphrases need 4 words and 20 characters", () => {
  assert.ok(phraseProblem("too short"));
  assert.ok(phraseProblem("averyveryverylongsingleword"));
  assert.equal(phraseProblem("purple monkey dishwasher lantern"), null);
});

test("generated passphrases are six words from the list, uniformly drawn", () => {
  const words = ["alpha", "bravo", "charlie"];
  const phrase = generatePhrase(words);
  assert.equal(phrase.split(" ").length, 6);
  assert.ok(phrase.split(" ").every((w) => words.includes(w)));
});

test("key derivation is deterministic and splits into two unrelated keys", async () => {
  const one = await deriveKeys("maple river copper tiger lunar hinge");
  const two = await deriveKeys("Maple-River copper tiger lunar HINGE");
  assert.deepEqual(one, two);
  assert.match(one.access, /^[0-9a-f]{64}$/);
  assert.equal(fromB64u(one.key).length, 32);
  const other = await deriveKeys("maple river copper tiger lunar hinges");
  assert.notEqual(other.access, one.access);
});

test("encrypt then decrypt returns the same state, and the blob reveals nothing", async () => {
  const key = await importKey((await deriveKeys("maple river copper tiger lunar hinge")).key);
  const blob = await encryptState(sample, key);
  assert.match(blob, /^1\.[zn]\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/, "matches the server's envelope check");
  const ciphertext = new TextDecoder("latin1").decode(fromB64u(blob.split(".")[3]));
  assert.ok(!blob.includes("Acme") && !ciphertext.includes("Acme"));
  assert.deepEqual(await decryptState(blob, key), sample);
});

test("every encryption uses a fresh IV", async () => {
  const key = await importKey((await deriveKeys("maple river copper tiger lunar hinge")).key);
  const a = await encryptState(sample, key);
  const b = await encryptState(sample, key);
  assert.notEqual(a.split(".")[2], b.split(".")[2]);
});

test("a tampered blob or the wrong key is rejected", async () => {
  const key = await importKey((await deriveKeys("maple river copper tiger lunar hinge")).key);
  const wrong = await importKey((await deriveKeys("some other passphrase entirely here")).key);
  const blob = await encryptState(sample, key);
  const parts = blob.split(".");
  const ct = fromB64u(parts[3]);
  ct[5] ^= 1;
  await assert.rejects(decryptState([...parts.slice(0, 3), toB64u(ct)].join("."), key));
  await assert.rejects(decryptState(blob, wrong));
});

test("a transfer link round-trips clients and entries", async () => {
  const now = Date.UTC(2026, 9, 15, 20);
  const t = buildTransfer(sample, now, 30);
  assert.equal(t.clients, 2);
  assert.equal(t.sessions, 1);
  const url = await encodeTransfer(t.payload, "https://billable.example");
  assert.match(url, /^https:\/\/billable\.example\/#import=[zj][A-Za-z0-9_-]+$/);
  const p = await decodeTransfer(url);
  let n = 0;
  const uid = () => `new${n++}`;
  const r = applyTransfer(normalise({}), p, now, uid);
  assert.equal(r.addedClients, 2);
  assert.equal(r.addedSessions, 1);
  assert.deepEqual(r.state.clients.map((c) => c.name).sort(), ["Acme Corp", "Café Øst"]);
  assert.equal(r.state.sessions[0].end - r.state.sessions[0].start, 130 * 60e3);
  const again = applyTransfer(r.state, p, now, uid);
  assert.equal(again.addedClients + again.addedSessions, 0, "importing twice adds nothing");
});

test("transfer import matches existing clients by name, case-insensitively", async () => {
  const now = Date.UTC(2026, 9, 15, 20);
  const p = await decodeTransfer(await encodeTransfer(buildTransfer(sample, now, 30).payload, "https://x"));
  const here = normalise({ clients: [{ id: "mine", name: "ACME CORP", archived: true, updated: 1 }] });
  const r = applyTransfer(here, p, now, () => "n");
  assert.equal(r.addedClients, 1, "only Café Øst is new");
  assert.equal(r.state.clients.find((c) => c.id === "mine").archived, false, "an archived match is restored");
});

test("a transfer link that inflates into something huge is refused", async () => {
  const { compress } = await import("../src/js/crypto.js");
  const bomb = await compress(new Uint8Array(5 * 1024 * 1024).fill(32), "deflate-raw");
  await assert.rejects(decodeTransfer(`https://x/#import=z${toB64u(bomb)}`), /too large/);
});

test("archived clients arrive archived", async () => {
  const now = Date.UTC(2026, 9, 15, 20);
  const st = normalise({ ...sample, clients: sample.clients.map((c) => (c.id === "a" ? { ...c, archived: true } : c)) });
  const p = await decodeTransfer(await encodeTransfer(buildTransfer(st, now, 30).payload, "https://x"));
  const r = applyTransfer(normalise({}), p, now, (() => { let n = 0; return () => `n${n++}`; })());
  assert.equal(r.state.clients.find((c) => c.name === "Acme Corp").archived, true);
});

test("a damaged transfer link is refused", async () => {
  await assert.rejects(decodeTransfer("https://x/#import=zAAAA"));
  await assert.rejects(decodeTransfer("https://x/#nothing"));
  const bogus = toB64u(new TextEncoder().encode(JSON.stringify({ v: 1, b: 0, c: ["A"], s: [[5, 0, 1]] })));
  const p = await decodeTransfer(`https://x/#import=j${bogus}`);
  assert.equal(p.sessions.length, 0, "entries pointing at a missing client are dropped");
});
