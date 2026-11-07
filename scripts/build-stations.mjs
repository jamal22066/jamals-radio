#!/usr/bin/env node
// Pre-builds data/stations.json from the Radio Browser API so visitors download a small,
// compact file (served gzip/brotli by your host) instead of ~13 MB of raw API JSON.
// Usage: node scripts/build-stations.mjs [--limit 10000] [--allow-http]
// Re-run periodically (cron / CI) — e.g. daily — to keep the list fresh.
import { writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const limit = Number(args[args.indexOf("--limit") + 1]) || 10000;
const httpsOnly = !args.includes("--allow-http");
const UA = "JamalsRadio/1.0 (+https://radio.jamalsblog.com)";
const FALLBACK = ["de1.api.radio-browser.info", "de2.api.radio-browser.info", "fi1.api.radio-browser.info", "nl1.api.radio-browser.info"];

async function servers() {
  try {
    const r = await fetch("https://all.api.radio-browser.info/json/servers", { headers: { "User-Agent": UA } });
    const list = [...new Set((await r.json()).map((s) => s.name))];
    if (list.length) return list;
  } catch {}
  return FALLBACK;
}

const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : "");

async function main() {
  const params = new URLSearchParams({
    has_geo_info: "true", hidebroken: "true", order: "clickcount", reverse: "true", limit: String(limit),
  });
  if (httpsOnly) params.set("is_https", "true");

  let raw, lastErr;
  for (const host of await servers()) {
    try {
      const r = await fetch(`https://${host}/json/stations/search?${params}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error(`${host}: HTTP ${r.status}`);
      raw = await r.json();
      console.log(`fetched ${raw.length} stations from ${host}`);
      break;
    } catch (e) { lastErr = e; console.warn(String(e)); }
  }
  if (!raw) throw lastErr;

  const seen = new Set();
  const list = [];
  for (const s of raw) {
    if (s.hls === 1) continue;
    const u = s.url_resolved || s.url;
    const n = (s.name || "").trim();
    const lat = +s.geo_lat, lon = +s.geo_long;
    if (!n || !u || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) continue;
    if (httpsOnly && !/^https:\/\//i.test(u)) continue;
    const key = n.toLowerCase() + "|" + u;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({
      id: s.stationuuid, n, u,
      f: safeUrl(s.favicon), h: safeUrl(s.homepage),
      t: (s.tags || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 4).join(", "),
      c: s.country || "", cc: s.countrycode || "", st: s.state || "",
      lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4,
      k: s.codec || "", b: s.bitrate || 0,
    });
  }

  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "stations.json");
  await mkdir(dirname(out), { recursive: true });
  const body = JSON.stringify({ generated: new Date().toISOString(), httpsOnly, list });
  await writeFile(out + ".tmp", body);
  await rename(out + ".tmp", out); // atomic swap so the web server never serves a half-written file
  console.log(`wrote ${list.length} stations → ${out} (${(body.length / 1e6).toFixed(2)} MB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
