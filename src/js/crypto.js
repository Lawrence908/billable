// End-to-end encryption for sync, using only the Web Crypto API.
//
// The passphrase never leaves the browser. PBKDF2 stretches it into one
// 256-bit secret, and HKDF expands that into two independent keys: an access
// key the server files the mailbox under (it stores only a hash of it), and
// the AES-GCM key that encrypts the data. The server can neither read the blob
// nor work back to either key.
//
// Why not take 512 bits straight from PBKDF2 and split them: PBKDF2 computes
// each 256-bit block separately, so anyone holding the access-key half could
// test passphrase guesses at the cost of one block. Deriving one block and
// expanding it means every guess pays the full stretching cost.
//
// The salt is fixed because two devices must derive the same keys from the
// passphrase alone. That is acceptable here because generated passphrases
// carry about 77 bits, and the server will not hand a blob to anyone who
// cannot present the access key, so there is nothing to attack offline
// without first breaking into the server.

import { normalise } from "./model.js";

const te = new TextEncoder();
const td = new TextDecoder();

const KDF_SALT = te.encode("billable/sync/v2");
const KDF_ROUNDS = 600000; // OWASP 2023 guidance for PBKDF2-HMAC-SHA256
const AAD = te.encode("billable-sync-v1");
export const KDF_VERSION = 2;
const PHRASE_WORDS = 6;

/* ---------- bytes ---------- */

export function toB64u(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(str.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// Returns null where CompressionStream is missing, so callers can fall back.
export async function compress(bytes, format) {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Stops at `limit` output bytes, so a small crafted input cannot inflate into
// something that exhausts memory (a decompression bomb).
export async function decompress(bytes, format, limit = 4 * 1024 * 1024) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error("decompressed data is too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/* ---------- passphrases ---------- */

// Case, spacing and punctuation do not matter, so "Maple-River copper" and
// "maple river copper" are the same passphrase.
export function normalisePhrase(p) {
  return p.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function phraseProblem(p) {
  const n = normalisePhrase(p);
  return n.split(" ").length < 4 || n.length < 20 ? "Use at least 4 words and 20 characters." : null;
}

// Rejection sampling keeps every word equally likely.
export function generatePhrase(words) {
  const limit = Math.floor(2 ** 32 / words.length) * words.length;
  const out = [];
  const buf = new Uint32Array(1);
  while (out.length < PHRASE_WORDS) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) out.push(words[buf[0] % words.length]);
  }
  return out.join(" ");
}

/* ---------- keys ---------- */

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export async function deriveKeys(phrase) {
  const pass = await crypto.subtle.importKey("raw", te.encode(normalisePhrase(phrase)), "PBKDF2", false, ["deriveBits"]);
  const stretched = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: KDF_SALT, iterations: KDF_ROUNDS }, pass, 256);
  const root = await crypto.subtle.importKey("raw", stretched, "HKDF", false, ["deriveBits"]);
  const expand = async (label) => new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode(label) }, root, 256));
  return { access: hex(await expand("billable access")), key: toB64u(await expand("billable encrypt")) };
}

export const importKey = (b64) =>
  crypto.subtle.importKey("raw", fromB64u(b64), "AES-GCM", false, ["encrypt", "decrypt"]);

/* ---------- blobs ---------- */

// Format "1.<z|n>.<iv>.<ciphertext>": version, gzip or not, base64url parts.
// api/server.py checks this exact shape before storing anything.
export async function encryptState(st, key) {
  const plain = te.encode(JSON.stringify(normalise(st)));
  const zipped = await compress(plain, "gzip");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, zipped || plain));
  return `1.${zipped ? "z" : "n"}.${toB64u(iv)}.${toB64u(ct)}`;
}

export async function decryptState(blob, key) {
  const [version, flag, iv, ct] = blob.split(".");
  if (version !== "1") throw new Error("synced data is from a newer version; reload the page");
  let bytes = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64u(iv), additionalData: AAD }, key, fromB64u(ct)));
  if (flag === "z") bytes = await decompress(bytes, "gzip");
  return normalise(JSON.parse(td.decode(bytes)));
}
