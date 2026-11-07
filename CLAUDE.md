# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Jamal's Radio (served at https://jamalsblog.com; www. and radio. 301 there via deploy/nginx.conf) is a static web app that plays live radio stations picked from a 3D globe. It has no framework, no bundler and no backend: plain `index.html` + `style.css` + `app.js`, with libraries vendored in `vendor/`. It is an original implementation of the same idea as orberadio.com. Do not copy that site's code or branding.

## Commands

```bash
node scripts/build-stations.mjs [--limit N] [--allow-http]  # regenerate data/stations.json from Radio Browser
python3 -m http.server 8080                                  # serve locally
node --check app.js                                          # quick syntax check
```

There is no test suite. To verify UI changes, load the page in a browser (Playwright/headless Chromium works with `--use-gl=swiftshader`) and watch the console for MapLibre style errors.

## Deployment

`./deploy.sh` publishes the site to the production server. The server specifics (host, systemd units, Cloudflare Tunnel routing) are in `CLAUDE.local.md`, which is gitignored; read it before deploying. Units and nginx config live in `deploy/`. `index.html` references local CSS and JS with `?v=__V__`, and `deploy.sh` replaces that with a content hash to bust Cloudflare's edge cache. Keep the placeholder on any new local asset link.

## Architecture

- **`config.js`** sets `window.SITE_CONFIG` (name, station limit, `httpsOnly`, cache hours, auto-rotate, support URL). Put all branding and tuning here.
- **Station loading** in `app.js` tries three sources in order:
  1. the localStorage cache (`jamalradio:stations:v1`, TTL from `cacheHours`)
  2. the pre-built `data/stations.json`
  3. the live Radio Browser API (`/json/stations/search`)

  Each source passes through the same `usable()` filter. Stations use a compact shape: `{id, n, u, f, h, t, c, cc, st, lat, lon, k, b}`. `scripts/build-stations.mjs` and `compact()` in `app.js` must produce the same shape, so keep them in sync.
- **Radio Browser servers** are discovered via `all.api.radio-browser.info/json/servers`, with a hardcoded fallback list. Playing a station calls `/json/url/{uuid}` to count the click, as the API's etiquette asks.
- **Map:** MapLibre v5, with `projection: {type: "globe"}` in the inline style. Layers are the NASA GIBS raster, TopoJSON coast and borders, then the `stations-glow` and `stations` circle layers. The feature id equals the station's index in `stations` (`s._i`). The playing station is highlighted through `feature-state`. A `["zoom"]` expression must be the input of a top-level `interpolate`; the `byZoom()` helper handles this.
- **Clicks** use `queryRenderedFeatures` over a small bbox. One hit plays immediately. Several hits (many stations share city coordinates) open the side panel list.
- **Player:** a single `<audio>` element. Its state lives in `#player[data-state]` (`idle|loading|playing|paused|error`), and CSS reads that attribute. A 15 s stall timer marks dead streams. HLS stations are skipped because hls.js is not included.
- **Persistence:** favorites and volume are kept in localStorage. Share links use `#station=<uuid>`, and on load the station is selected but not autoplayed.
- Station data is user-contributed. Render it only with `textContent`, and pass URLs through `safeUrl()`.
