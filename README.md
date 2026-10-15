# billable

https://billable.chrislawrence.ca: type a client name, start and stop its timer through
the day, and get a summary that rounds each client to the nearest 0.5 h.

Public, no accounts, **no server-side data**. Clients, time entries and settings are one
JSON blob in the visitor's `localStorage` (`billable.v1`). The server is a static nginx.

## Behaviour

- Clients persist across days, so each name is typed once. Re-adding a removed name
  restores it with its history.
- Starting a client stops any other running timer unless "let more than one timer run"
  is ticked in Settings.
- Day totals are the overlap of each entry with the local calendar day, so a shift
  past midnight is split between the two days.
- Hours = `round(hours * 2) / 2` per client (15 min rounds up to 0.5, 14 down to 0);
  the day total is the sum of the rounded figures.
- "Fix times" (folded by default) edits, adds or deletes entries; an end before the
  start means past midnight. Removing a client archives it so past hours still appear.
- Email opens the visitor's own mail client via `mailto:`; nothing is sent from the
  server, so there is no relay to abuse and no SMTP secret. Copy sits alongside; a CSV
  of the day is under Settings.
- Export/import a JSON backup; data does not sync between devices. Data from the first
  version (`jobs`/`jobId`, plus a job number) is read and rewritten as `clients`/`clientId`.

## Layout

```
src/index.html  src/app.css  src/app.js   the whole app
src/favicon.*   src/apple-touch-icon.png  built by tools/build-favicons.py
nginx.conf      /health + no-cache on the HTML
```

## Deploy

Always `./deploy.sh`, never a bare `docker compose up --build`: it bakes `BUILD_TIME`
into the footer and `BUILD_ID` into the asset URLs (`app.js?v=...`). Cloudflare
rewrites `.css`/`.js` responses to a 4 h browser TTL, so without the version a
redeploy would not reach phones that already have the page.

Host port 8175, container port 80, Caddy `proxy/sites/billable.caddy`, Cloudflare
Access bypass (public), catalog entry `billable` in services.yml.
