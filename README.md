# billable

https://billable.chrislawrence.ca: a start/stop timer per job, with a day summary
that rounds each job to the nearest 0.5 h for entry into a billable-hours system.

Public, no accounts, **no server-side data**. Jobs, time entries and settings are one
JSON blob in the visitor's `localStorage` (`billable.v1`). The server is a static nginx.

## Behaviour

- Starting a job stops any other running timer unless "let more than one timer run"
  is ticked in Settings.
- Day totals are the overlap of each entry with the local calendar day, so a shift
  past midnight is split between the two days.
- Billable = `round(hours * 2) / 2` per job (15 min rounds up to 0.5, 14 down to 0);
  the day total is the sum of the rounded figures.
- Entries can be edited (an end before the start means past midnight), added by hand,
  or deleted. Removing a job archives it so its past hours still appear.
- Email opens the visitor's own mail client via `mailto:`; nothing is sent from the
  server, so there is no relay to abuse and no SMTP secret. Copy and CSV are alongside.
- Export/import a JSON backup; data does not sync between devices.

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
