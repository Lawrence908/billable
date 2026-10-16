# Billable

A per-client hours tracker for a phone or a browser. Type a client name, press
Start and Stop through the day, and get a summary with each client rounded to the
nearest quarter hour, ready to email or paste into a work timesheet.

Live at [billable.chrislawrence.ca](https://billable.chrislawrence.ca). No account,
no build step, and no runtime dependencies.

<img src="screenshots/mobile-390.png" alt="Billable on a phone: three clients, one timer running, and the day summary" width="300">

## Categories and notes (optional)

Each client card has a **More** button that opens a category dropdown (P0 to P8,
Project Management, Gaps, Internal, Tech) and a note box. The running timer, and the
next one started on that card, are labelled with them.

- Changing the category or note mid-timer splits the time at that moment, so the time
  so far keeps the old label. Within the first minute it relabels the entry instead,
  so a quick correction leaves no near-empty fragment.
- The note box suggests every note used before under that category, across all
  clients, most recent first. Suggestions are derived from history rather than stored
  separately, so they build up and sync on their own.
- The summary, email and CSV list each client with one line per category and note.
  **Each line's time for the day is added up, then rounded once to the nearest 0.25 h**
  (7.5 minutes rounds up), because each line is entered separately at work. The client
  total is the sum of its lines. Rounding the total rather than each start/stop means
  three 8-minute stretches count as 24 minutes, so 0.5 h, rather than 0.75 h. A client tracked without
  categories reads exactly as before.
- Under Fix times, entries can be retagged when a switch was forgotten.

## Day-to-day helpers

- **Copy for Sheets**: each client in the summary has a copy button, because each
  client's hours go on its own tab of the work Google Sheet. It copies that client's
  lines as tab-separated rows, so one paste fills a row per line with each value in its
  own column. Notes gets only the note, never the category. A setting chooses Notes
  and Hours, or all five timesheet columns (Date, Employee, Costing
  section, Notes, Hours). A tick marks clients already copied, and clears if their time
  changes afterwards. Zero-hour lines are left out, and formula-like cells stay text.
- **Forgotten timers**: a timer still running from a previous day, or for four hours or
  more, raises a prompt to stop it at the time you actually finished, stop now, or keep
  going (which quiets it for two hours).
- **Timeline**: the day drawn as a bar of client-coloured blocks with untracked gaps
  hatched. Tapping a gap pre-fills a new entry for exactly that time; tapping a block
  jumps to that entry under Fix times.
- **Offline**: a service worker (`src/sw.js`) keeps the app itself on the device, so it
  opens with no signal. It never handles data or `/api/` requests, and each deploy
  installs a fresh copy.

## Privacy model

Billable is built so the server never holds anything readable about you.

- **Without sync**, data lives only in the browser's `localStorage`. Nothing you type
  is sent anywhere.
- **With sync**, data is encrypted in the browser before upload. The server stores
  an opaque blob it has no key for. The passphrase and the decryption key never
  leave the device.
- **Transfer links and QR codes** carry their payload after the `#`, which browsers
  never send to a server.
- **Email** is a `mailto:` link that opens the user's own mail client.
- **No IP addresses are recorded.** The sync server keeps them in memory, for at most
  an hour, for rate limiting only. nginx access logging is off, and the reverse proxy
  strips client addresses from its log.
- **No third-party code runs.** A strict Content Security Policy allows only same-origin
  scripts. That also blocks the analytics beacon Cloudflare injects.

### What it does not protect against

- **A server that serves altered JavaScript.** This is true of every web app that
  encrypts in the browser: you trust the code the server sends. This repository is
  public so that the code can be read.
- **Someone with the unlocked device.** Local data and the sync passphrase sit in
  `localStorage` unencrypted, like any web app's saved state.
- **Metadata.** The server sees when an encrypted copy is saved and how large it is.
  Cloudflare sees what any CDN sees: IP addresses, user agents and request times.
- **A lost passphrase.** It cannot be recovered or reset. Each device keeps its own
  full copy regardless.

## How sync works

```mermaid
flowchart LR
  P[six-word passphrase] -->|PBKDF2-SHA256, 600k rounds| R[256-bit root]
  R -->|HKDF 'billable access'| A[access key]
  R -->|HKDF 'billable encrypt'| K[AES-256-GCM key]
  A -->|Authorization: Bearer| S[(server: file named sha256 of access key)]
  K -->|encrypts state in the browser| B[ciphertext blob] --> S
```

- **Passphrases.** Generated from the [EFF large wordlist](https://www.eff.org/dice):
  six words from 7,772, about 77 bits. A user may choose their own: at least 4 words
  and 20 characters. Case, spacing and punctuation are ignored.
- **Keys.** PBKDF2 produces a single 256-bit block, and HKDF expands it into two
  independent keys. Taking 512 bits straight from PBKDF2 would let someone holding the
  access key test guesses at half the cost, because PBKDF2 computes each output block
  separately.
- **Storage.** The server files each mailbox under `sha256(access key)`, so even a
  listing of its data directory does not reveal the keys needed to fetch from it.
  Writes carry the revision they were based on. A stale write gets `409`, and the
  client pulls, merges and retries.
- **Merging.** Every client, entry and the settings carry an `updated` timestamp, and
  deletions leave tombstones, so for each id the newest record wins. Two further rules
  depend only on the data, so every device reaches the same result:
  - If two devices each started a timer while apart, the earlier one stops where the
    later one began.
  - If both devices created a client with the same name, the clients merge into one.

## Layout

```
src/index.html, app.css     the page
src/js/model.js             state, time maths, rounding, merging      (pure)
src/js/crypto.js            key derivation, encryption, encoding      (pure, Web Crypto)
src/js/transfer.js          transfer-link encode, decode and import   (pure)
src/js/sync.js              pull, merge, push; timeouts; retry on 409 (fetch is injected)
src/js/app.js               storage, rendering and event wiring
src/js/words.js             generated wordlist (tools/build-words.py checks its hash)
src/vendor/qrcode-2.0.4.js  qrcode-generator 2.0.4 (MIT), npm integrity verified
api/server.py               the sync mailbox: standard library only
tests/                      Node and Python unit tests, plus a browser end-to-end test
```

Everything except `app.js` runs under Node with no browser, which is what makes the
logic testable. Each module states its job in its opening comment.

## Running it

```sh
./deploy.sh                 # docker compose: nginx front plus the sync API
```

The compose file expects an external Docker network called `homelab-web` for the
reverse proxy in front. Change that for your own setup. The API sits on a private
network that only the front container joins. If you are not behind Cloudflare, set
`CLIENT_IP_HEADER=` (empty), so clients cannot choose their own rate-limit bucket.

## Tests

```sh
npm test                                            # unit tests, about two seconds
node tests/e2e/two-devices.mjs http://localhost:8175   # needs: npm i --no-save playwright
```

- **Unit tests** cover:
  - rounding, and time across midnight and both DST changes
  - merge convergence and commutativity
  - same-name collapse and concurrent timers
  - key derivation, tamper detection and fresh IVs
  - transfer-link round trips and decompression-bomb limits
  - CSV formula neutralising
  - the sync engine against an in-memory server, including a rival write mid-sync and
    a hung connection
  - the real HTTP server: revisions, size and mailbox caps, rate limits, and
    concurrent writers
- **The end-to-end test** drives five isolated browser contexts through the live UI:
  creating, joining, offline edits, deletion, QR linking and transfer links.

## Limits

| What | Limit |
|---|---|
| Synced blob | about 256 KB of ciphertext, which is years of entries |
| Mailboxes | 5,000 per server |
| New mailboxes | 10 per IP address per hour |
| Requests | 240 per IP address per 10 minutes |
| Idle mailboxes | deleted after 400 days |
| Tombstones | pruned after 180 days |
