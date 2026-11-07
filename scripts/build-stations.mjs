#!/usr/bin/env node
// Pre-builds data/stations.json from the Radio Browser API so visitors download a small,
// compact file (served gzip/brotli by your host) instead of ~13 MB of raw API JSON.
// Usage: node scripts/build-stations.mjs [--limit 10000] [--fill 100] [--allow-http]
//   --fill N: countries with fewer than N geo-tagged stations are topped up with stations that have
//   no coordinates, placed via scripts/places.json (city / region / capital) or near the country's
//   other stations. 0 disables.
// Re-run periodically (cron / CI) — e.g. daily — to keep the list fresh.
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const limit = Number(args[args.indexOf("--limit") + 1]) || 10000;
const httpsOnly = !args.includes("--allow-http");
const fillAt = args.indexOf("--fill");
const fill = fillAt >= 0 ? Number(args[fillAt + 1]) || 0 : 100;
const UA = "JamalsRadio/1.0 (+https://jamalsblog.com)";
const FALLBACK = ["de1.api.radio-browser.info", "de2.api.radio-browser.info", "fi1.api.radio-browser.info", "nl1.api.radio-browser.info"];
const here = dirname(fileURLToPath(import.meta.url));

async function servers() {
  try {
    const r = await fetch("https://all.api.radio-browser.info/json/servers", { headers: { "User-Agent": UA } });
    const list = [...new Set((await r.json()).map((s) => s.name))];
    if (list.length) return list;
  } catch {}
  return FALLBACK;
}

const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : "");
const norm = (x) => (x || "").trim().toLowerCase();
const escapeRx = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function search(extra) {
  const params = new URLSearchParams({ hidebroken: "true", order: "clickcount", reverse: "true", ...extra });
  if (httpsOnly) params.set("is_https", "true");
  let lastErr;
  for (const host of await servers()) {
    try {
      const r = await fetch(`https://${host}/json/stations/search?${params}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw new Error(`${host}: HTTP ${r.status}`);
      const raw = await r.json();
      console.log(`fetched ${raw.length} stations (has_geo_info=${extra.has_geo_info}) from ${host}`);
      return raw;
    } catch (e) { lastErr = e; console.warn(String(e)); }
  }
  throw lastErr;
}

// Same shape as compact() in app.js — keep them in sync.
function compact(s, lat, lon) {
  return {
    id: s.stationuuid, n: (s.name || "").trim(), u: s.url_resolved || s.url,
    f: safeUrl(s.favicon), h: safeUrl(s.homepage),
    t: (s.tags || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 4).join(", "),
    c: s.country || "", cc: s.countrycode || "", st: s.state || "",
    lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4,
    k: s.codec || "", b: s.bitrate || 0,
  };
}

// The geo-tagged station nearest the coordinate-wise median of a group. Always a real station
// location, so a fallback never lands in the sea the way a plain centroid can.
function anchor(points) {
  const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  const mLat = med(points.map((p) => p[0])), mLon = med(points.map((p) => p[1]));
  let best = points[0], bestD = Infinity;
  for (const p of points) {
    const d = (p[0] - mLat) ** 2 + (p[1] - mLon) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

async function main() {
  const seen = new Set();
  const list = [];
  const add = (s, lat, lon) => {
    if (s.hls === 1) return false;
    const u = s.url_resolved || s.url;
    const n = (s.name || "").trim();
    if (!n || !u || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return false;
    if (httpsOnly && !/^https:\/\//i.test(u)) return false;
    const key = n.toLowerCase() + "|" + u;
    if (seen.has(key)) return false;
    seen.add(key);
    list.push(compact(s, lat, lon));
    return true;
  };

  // 1) Stations with real coordinates, most popular first.
  for (const s of await search({ has_geo_info: "true", limit: String(limit) })) add(s, +s.geo_lat, +s.geo_long);
  const geoCount = list.length;

  // 2) Stations without coordinates, at an approximate location, only for countries with fewer than
  //    `fill` stations on the map. Thin countries get filled in without bloating the file.
  if (fill > 0) {
    const places = JSON.parse(await readFile(join(here, "places.json"), "utf8"));
    const cityRx = {}; // cc -> [[regex, [lat, lon]]], longest name first so "Dera Ismail Khan" beats "Khan"
    for (const [cc, p] of Object.entries(places)) {
      if (cc.startsWith("_")) continue;
      cityRx[cc] = Object.keys(p.cities || {}).sort((a, b) => b.length - a.length)
        .map((name) => [new RegExp(`(^|[^\\p{L}])${escapeRx(name)}($|[^\\p{L}])`, "iu"), p.cities[name]]);
    }

    const perCountry = new Map(), byCountry = new Map(), byState = new Map();
    const push = (m, k, v) => (m.get(k) || m.set(k, []).get(k)).push(v);
    for (const s of list) {
      perCountry.set(s.cc, (perCountry.get(s.cc) || 0) + 1);
      if (!s.cc) continue;
      push(byCountry, s.cc, [s.lat, s.lon]);
      if (s.st.trim()) push(byState, s.cc + "|" + norm(s.st), [s.lat, s.lon]);
    }

    const locate = (s) => {
      const cc = s.countrycode, st = (s.state || "").trim(), p = places[cc];
      if (p) {
        const text = `${s.name} ${st}`;
        for (const [rx, ll] of cityRx[cc]) if (rx.test(text)) return ll;
        const region = Object.keys(p.regions || {}).find((r) => norm(r) === norm(st));
        if (region && p.cities[p.regions[region]]) return p.cities[p.regions[region]];
      }
      if (st && byState.has(cc + "|" + norm(st))) return anchor(byState.get(cc + "|" + norm(st)));
      if (p?.capital && p.cities[p.capital]) return p.cities[p.capital];
      if (byCountry.has(cc)) return anchor(byCountry.get(cc));
      return null;
    };

    const added = new Map();
    for (const s of await search({ has_geo_info: "false", limit: "100000" })) {
      const cc = s.countrycode;
      if (!cc || (perCountry.get(cc) || 0) >= fill) continue;
      const ll = locate(s);
      if (ll && add(s, ll[0], ll[1])) {
        perCountry.set(cc, (perCountry.get(cc) || 0) + 1);
        added.set(cc, (added.get(cc) || 0) + 1);
      }
    }
    const top = [...added].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([c, n]) => `${c} +${n}`).join(", ");
    console.log(`placed ${list.length - geoCount} stations without coordinates in ${added.size} countries (${top})`);
  }

  const out = join(here, "..", "data", "stations.json");
  await mkdir(dirname(out), { recursive: true });
  const body = JSON.stringify({ generated: new Date().toISOString(), httpsOnly, list });
  await writeFile(out + ".tmp", body);
  await rename(out + ".tmp", out); // atomic swap so the web server never serves a half-written file
  console.log(`wrote ${list.length} stations → ${out} (${(body.length / 1e6).toFixed(2)} MB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
