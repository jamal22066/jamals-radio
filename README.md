# Jamal's Radio

Live at https://radio.jamalsblog.com. Deploy with `./deploy.sh` (see CLAUDE.md → Deployment).

World radio on a 3D globe. Spin the globe, tap a glowing dot and listen. It's a static site with no backend, no build step and no ads.

- **Stations:** the [Radio Browser](https://www.radio-browser.info) community directory (free public API)
- **Globe:** [MapLibre GL JS](https://maplibre.org) v5 in globe projection, vendored in `vendor/`
- **Imagery:** NASA GIBS Blue Marble (public domain). Borders come from Natural Earth via `world-atlas`.

## Run locally

```bash
node scripts/build-stations.mjs   # refresh data/stations.json (~3 MB raw, ~1 MB gzipped)
python3 -m http.server 8080       # then open http://localhost:8080
```

On `http://localhost`, http-only streams are allowed. When the site is served over HTTPS, only HTTPS streams are shown, because browsers block mixed-content audio.

## Rebrand / configure

Edit `config.js` to set the name, tagline, station limit, cache hours, auto-rotate and an optional support link. Also change the name in `index.html` (`<title>`), `manifest.webmanifest` and `icons/icon.svg`.

## Deploy to your own domain

Upload the whole directory to any static host, such as nginx, Cloudflare Pages, Netlify, GitHub/GitLab Pages or S3+CloudFront.

- Serve over **HTTPS**.
- Enable gzip/brotli for `.json` and `.js` files.
- Refresh the station snapshot regularly, for example daily:
  ```cron
  15 4 * * * cd /var/www/skywave && /usr/bin/node scripts/build-stations.mjs >/dev/null 2>&1
  ```
  If `data/stations.json` is missing, the app falls back to the live API. That still works, but the first load downloads about 13 MB uncompressed.

Minimal nginx server block:

```nginx
server {
  listen 443 ssl http2;
  server_name radio.example.com;
  root /var/www/skywave;
  gzip on; gzip_types application/json application/javascript text/css image/svg+xml;
  location /data/ { add_header Cache-Control "public, max-age=3600"; }
  location /vendor/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
}
```

## Third-party code and data

- `vendor/maplibre-gl.*`: [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) 5.6.0, BSD-3-Clause
- `vendor/topojson-client.min.js`: [topojson-client](https://github.com/topojson/topojson-client) 3.1.0, ISC
- `vendor/countries-110m.json`: [world-atlas](https://github.com/topojson/world-atlas) 2.0.2 (Natural Earth, public domain), ISC
- Station data comes from [Radio Browser](https://www.radio-browser.info) and imagery from [NASA GIBS](https://earthdata.nasa.gov/gibs). Neither is stored in this repo.
