# billable

https://billable.chrislawrence.ca: type a client name, start and stop its timer through
the day, and get a summary that rounds each client to the nearest 0.5 h.

Public, no accounts. Data lives in the visitor's `localStorage` (`billable.v1`). The
server never holds readable client data: the only thing it stores is an optional
end-to-end encrypted sync blob.

## Behaviour

- Clients persist across days, so each name is typed once. Re-adding a removed name
  restores it with its history.
- Starting a client stops any other running timer unless "let more than one timer run"
  is ticked in Settings.
- Day totals are the overlap of each entry with the local calendar day, so a stretch
  past midnight is split between the two days.
- Hours = `round(hours * 2) / 2` per client (15 min rounds up to 0.5, 14 down to 0);
  the day total is the sum of the rounded figures.
- "Fix times" edits, adds or deletes entries; an end before the start means past
  midnight. Removing a client archives it so past hours still appear.
- Email opens the visitor's own mail client via `mailto:`; nothing is sent from the
  server, so there is no relay to abuse and no SMTP secret.

## Sync between devices (end-to-end encrypted)

- The browser generates a six-word passphrase from the EFF large wordlist (7,772 words
  after dropping hyphenated ones, about 77 bits). "Choose your own" accepts at least
  4 words and 20 characters. Case, spacing and punctuation are ignored.
- PBKDF2-SHA256, 600,000 rounds, fixed app salt, stretches the passphrase to 512 bits.
  The first half is the **access key**, sent as `Authorization: Bearer` (Caddy logs it
  as `REDACTED`). The second half is the **AES-GCM key** and never leaves the browser.
- `api/server.py` (stdlib, no host port, reachable only via nginx `/api/`) stores one
  blob per mailbox at `data/mailboxes/sha256(access key).json`. It cannot decrypt the
  blob, and the file name does not reveal the access key. Writes use optimistic
  revisions (409 on a stale write). Limits: ~256 KB per blob, 5,000 mailboxes,
  10 new mailboxes per IP per hour, 240 requests per IP per 10 minutes. Mailboxes
  idle for 400 days are deleted.
- Merge: every client, session and the settings carry `updated`, and deletions are
  tombstones, so for each id the newest record wins. If two devices each started a
  timer while apart, the earlier one is stopped where the later one began
  (deterministically, so both devices agree). Devices sync on load, on focus, 0.8 s
  after a change, and every 30 s while visible.
- "Link a device" shows a QR code of `/#sync=word-word-...`. The fragment is never sent
  to a server, and the page strips it from the address bar on arrival.
- A lost passphrase cannot be recovered. Each device keeps its local copy regardless.

## Move without sync

"Show transfer QR" packs client names and the last 30 days (falling back to 14, 7, 1 to
stay scannable) into `/#import=...`: deflate-raw plus base64url, carried entirely in the
link. On import, clients match by name and an entry for the same client and start
minute is skipped, so importing twice adds nothing. A paste box exists for iPhone
Home Screen apps, which cannot receive links from the camera.

## Storage hardening

- `navigator.storage.persist()` is requested when the first client is added and when
  sync turns on. Settings shows whether the browser granted it.
- Safari (and every iOS browser built on WebKit) deletes a site's storage after 7 days
  without a visit. A dismissible tip on iOS and macOS Safari, shown while sync is off,
  says to add Billable to the Home Screen or Dock, or turn on sync. A web manifest makes
  the Home Screen version a proper standalone app. Note that a Home Screen app keeps
  its own storage, separate from Safari's.

## Security headers

`nginx.conf` sets a strict CSP (`script-src 'self'` plus one hash for the shared
footer's `onerror`). That deliberately blocks the Cloudflare Web Analytics beacon the
zone injects. Any third-party script on this page could read the passphrase out of
`localStorage`, so do not loosen the CSP to let it in. The console warnings about it
are expected.

## Layout

```
src/index.html  src/app.css  src/app.js     the app
src/words.js                                 built by tools/build-words.py (hash-checked)
src/vendor/qrcode-2.0.4.js                   qrcode-generator 2.0.4, MIT, npm integrity verified
src/manifest.webmanifest, favicon.*, icon-*  icons built by tools/build-favicons.py
api/server.py                                sync mailbox sidecar
nginx.conf                                   /health, /api/ proxy, CSP, no-cache HTML
```

## Deploy

Always `./deploy.sh`, never a bare `docker compose up --build`: it creates
`data/mailboxes` as the host user (the sidecar runs as uid 1000), bakes `BUILD_TIME` into
the footer, and bakes `BUILD_ID` into the asset URLs. Cloudflare rewrites `.css`/`.js`
responses to a 4 h browser TTL, so without the version a redeploy would not reach
phones that already have the page.

Host port 8175, container port 80, Caddy `proxy/sites/billable.caddy`, Cloudflare Access
bypass (public), catalog entry `billable` in services.yml. Kuma watches
`http://billable:80/api/health`, which covers both containers.
