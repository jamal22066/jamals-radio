# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Jamal's Radio (served at https://jamalsblog.com; www. and radio. 301 there via deploy/nginx.conf) is a static web app that plays live radio stations picked from a 3D globe. It has no framework, no bundler and no backend: plain `index.html` + `style.css` + `app.js`, with libraries vendored in `vendor/`. It is an original implementation of the same idea as orberadio.com. Do not copy that site's code or branding.

## Commands

```bash
node scripts/build-stations.mjs [--limit N] [--allow-http]  # regenerate data/stations.json from Radio Browser
python3 -m http.server 8080                                  # serve locally
./stats.sh [--days 7] [--top 15]                            # who played what (reads the server's play log)
node --check app.js                                          # quick syntax check
```

There is no test suite. To verify UI changes, load the page in a browser (Playwright/headless Chromium works with `--use-gl=swiftshader`) and watch the console for MapLibre style errors.

## Deployment

`./deploy.sh` publishes the site to the production server. The server specifics (host, systemd units, Cloudflare Tunnel routing) are in `CLAUDE.local.md`, which is gitignored; read it before deploying. Units and nginx config live in `deploy/`. `index.html` references local CSS and JS with `?v=__V__`, and `deploy.sh` replaces that with a content hash to bust Cloudflare's edge cache. Keep the placeholder on any new local asset link.

## Architecture

- **`config.js`** sets `window.SITE_CONFIG` (name, station limit, `httpsOnly`, cache hours, auto-rotate, support URL). Put all branding and tuning here.
- **Station loading** in `app.js` tries three sources in order:
  1. the localStorage cache (`jamalradio:stations:v2`, TTL from `cacheHours`). Bump the key to make returning visitors drop their cached list.
  2. the pre-built `data/stations.json`
  3. the live Radio Browser API (`/json/stations/search`)

  The build script takes the top `--limit` geo-tagged stations, then tops up every country with fewer than `--fill` (default 100) stations using Radio Browser entries that have no coordinates. It places them by a city in the name or state, then the region capital, both from `scripts/places.json` (currently only Pakistan), then a geo-tagged station near the middle of that state or country. The live API fallback in `app.js` doesn't do this.

  Between those two steps, the build adds hand-picked stations from `scripts/extra-stations.json` (currently 52 Radio Pakistan streams from radio.gov.pk/live-streaming). Each is placed by `city` via `places.json`, or by its own `lat`/`lon`, and skipped if its stream doesn't answer with audio at build time. The daily refresh retries it. Duplicates are detected by stream URL with the query string ignored. An extra that matches a Radio Browser entry reuses that entry's uuid, so favorites and share links keep working; otherwise its id is `x-<sha1 of url>`. `app.js` skips the Radio Browser click report for `x-` ids.

  Each source passes through the same `usable()` filter. Stations use a compact shape: `{id, n, u, f, h, t, c, cc, st, lat, lon, k, b}`. `scripts/build-stations.mjs` and `compact()` in `app.js` must produce the same shape, so keep them in sync.
- **Radio Browser servers** are discovered via `all.api.radio-browser.info/json/servers`, with a hardcoded fallback list. Playing a station calls `/json/url/{uuid}` to count the click, as the API's etiquette asks.
- **Map:** MapLibre v5, with `projection: {type: "globe"}` in the inline style. Layers are the NASA GIBS raster, TopoJSON coast and borders, then the `stations-glow` and `stations` circle layers. The feature id equals the station's index in `stations` (`s._i`). The playing station is highlighted through `feature-state`. A `["zoom"]` expression must be the input of a top-level `interpolate`; the `byZoom()` helper handles this.
- **Clicks** use `queryRenderedFeatures` over a small bbox. One hit plays immediately. Several hits (many stations share city coordinates) open the side panel list.
- **Player:** a single `<audio>` element. Its state lives in `#player[data-state]` (`idle|loading|playing|paused|error`), and CSS reads that attribute. A 15 s stall timer marks dead streams. HLS stations are skipped because hls.js is not included.
- **Play stats:** `app.js` sends anonymous beacons (`start` when audio actually plays, a `beat` every 60 s, `stop`, and `fail`) to `CFG.playStatsUrl` (`/api/play`). nginx answers 204 and writes one JSON line per event to `/var/log/radio/plays.log`, including the visitor's IP from `CF-Connecting-IP` (`$remote_addr` is only the tunnel). That path is `~/radio-logs` on the server. `./stats.sh [--days N] [--no-ip]` streams the log over SSH and summarises it with `scripts/play-stats.py`. It adds city, region and ISP from DB-IP Lite databases, which it downloads monthly to `~/.cache/jamalradio-geo` and reads with the dependency-free `scripts/mmdb.py`. Lookups are offline. DB-IP's CC BY 4.0 license requires the attribution line the script prints. `radio-plays-rotate.timer` runs `deploy/rotate-plays.sh` every day at 00:05 UTC. It moves the log to `plays.log.YYYY-MM-DD`, runs `nginx -s reopen` in `radio-web`, and deletes rotated files older than 90 days. `privacy.html`, a short notice linked from the map attribution, states the 90-day retention, so keep the two in sync. The `/api/play` location uses `try_files` to reach a named location, because a bare `return` would run before `limit_req`.
- **Persistence:** favorites and volume are kept in localStorage. Share links use `#station=<uuid>`, and on load the station is selected but not autoplayed.
- Station data is user-contributed. Render it only with `textContent`, and pass URLs through `safeUrl()`.
