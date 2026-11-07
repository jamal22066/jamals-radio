/* Jamal's Radio — world radio on a globe.
 * Static, no build step. Station data: Radio Browser (https://www.radio-browser.info, public API).
 * Basemap: NASA GIBS Blue Marble. Borders: Natural Earth via world-atlas (TopoJSON).
 */
(() => {
  "use strict";

  const CFG = window.SITE_CONFIG || {};
  const FALLBACK_SERVERS = [
    "de1.api.radio-browser.info",
    "de2.api.radio-browser.info",
    "fi1.api.radio-browser.info",
    "nl1.api.radio-browser.info",
    "at1.api.radio-browser.info",
  ];
  const CACHE_KEY = "jamalradio:stations:v1";
  const FAVS_KEY = "jamalradio:favs:v1";
  const VOL_KEY = "jamalradio:volume";
  const STALL_MS = 15000;

  // ---------- tiny helpers ----------
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota / private mode */ } },
  };
  const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : "");
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ---------- state ----------
  let apiBase = null;
  let stations = [];          // compact station objects, index == feature id
  const byUuid = new Map();
  let current = null;         // currently selected station
  let favs = store.get(FAVS_KEY, []);
  let stallTimer = null;

  const els = {
    audio: $("audio"), player: $("player"), name: $("np-name"), sub: $("np-sub"),
    logo: $("np-logo"), logoFallback: $("np-logo-fallback"),
    play: $("btn-play"), fav: $("btn-fav"), vol: $("volume"),
    panel: $("panel"), panelTitle: $("panel-title"), panelList: $("panel-list"),
    search: $("search"), hint: $("hint"), hintText: $("hint-text"),
  };

  if (matchMedia("(max-width: 640px)").matches) els.search.placeholder = "Search stations, genres, countries…";
  document.querySelectorAll("[data-site-name]").forEach((e) => (e.textContent = CFG.name || "Jamal's Radio"));
  document.title = `${CFG.name || "Jamal's Radio"} — ${CFG.tagline || "world radio on a globe"}`;

  // ---------- Radio Browser API ----------
  async function pickServer() {
    let hosts = [];
    try {
      const r = await fetch("https://all.api.radio-browser.info/json/servers");
      if (r.ok) hosts = [...new Set((await r.json()).map((s) => s.name))];
    } catch { /* fall through */ }
    if (!hosts.length) hosts = FALLBACK_SERVERS.slice();
    for (const h of shuffle(hosts)) {
      try {
        const r = await fetch(`https://${h}/json/stats`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) return `https://${h}`;
      } catch { /* try next */ }
    }
    throw new Error("No Radio Browser server reachable");
  }

  function compact(s) {
    return {
      id: s.stationuuid,
      n: (s.name || "").trim(),
      u: s.url_resolved || s.url,
      f: safeUrl(s.favicon),
      h: safeUrl(s.homepage),
      t: (s.tags || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 4).join(", "),
      c: s.country || "",
      cc: s.countrycode || "",
      st: s.state || "",
      lat: +s.geo_lat, lon: +s.geo_long,
      k: s.codec || "", b: s.bitrate || 0,
    };
  }

  function usable(s) {
    if (!s.n || !s.u || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return false;
    if (Math.abs(s.lat) > 90 || Math.abs(s.lon) > 180 || (s.lat === 0 && s.lon === 0)) return false;
    if (CFG.httpsOnly && !/^https:\/\//i.test(s.u)) return false;
    return true;
  }

  async function loadStations() {
    const cached = store.get(CACHE_KEY, null);
    const maxAge = (CFG.cacheHours ?? 12) * 3600e3;
    if (cached && Date.now() - cached.at < maxAge && cached.list?.length) return cached.list;

    // 1) Pre-built snapshot shipped with the site (scripts/build-stations.mjs) — small and fast.
    try {
      const r = await fetch("data/stations.json", { cache: "no-cache" });
      if (r.ok) {
        const snap = await r.json();
        const list = (snap.list || []).filter(usable);
        if (list.length) { store.set(CACHE_KEY, { at: Date.now(), list }); return list; }
      }
    } catch { /* fall back to live API */ }

    // 2) Live API fallback.
    if (!apiBase) apiBase = await pickServer();
    const params = new URLSearchParams({
      has_geo_info: "true", hidebroken: "true", is_https: CFG.httpsOnly ? "true" : "",
      order: "clickcount", reverse: "true", limit: String(CFG.stationLimit || 10000),
    });
    if (!CFG.httpsOnly) params.delete("is_https");
    const r = await fetch(`${apiBase}/json/stations/search?${params}`);
    if (!r.ok) throw new Error(`Station list HTTP ${r.status}`);
    const raw = await r.json();

    const seen = new Set();
    const list = [];
    for (const s of raw) {
      if (s.hls === 1) continue; // HLS needs hls.js; keep the app dependency-light
      const c = compact(s);
      const key = c.n.toLowerCase() + "|" + c.u;
      if (!usable(c) || seen.has(key)) continue;
      seen.add(key);
      list.push(c);
    }
    store.set(CACHE_KEY, { at: Date.now(), list });
    return list;
  }

  function reportClick(s) {
    // Radio Browser etiquette: count a click when a station is played.
    if (apiBase) fetch(`${apiBase}/json/url/${encodeURIComponent(s.id)}`).catch(() => {});
  }

  // ---------- map ----------
  const map = new maplibregl.Map({
    container: "map",
    center: [10, 25],
    zoom: window.innerWidth < 640 ? 0.6 : 1.8,
    minZoom: 0.4,
    maxZoom: 11,
    attributionControl: false,
    style: {
      version: 8,
      projection: { type: "globe" },
      sky: { "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0] },
      sources: {
        earth: {
          type: "raster", tileSize: 256, maxzoom: 8,
          tiles: ["https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg"],
          attribution: 'Imagery <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA GIBS</a>',
        },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#0a1424" } },
        { id: "earth", type: "raster", source: "earth", paint: { "raster-brightness-max": 0.62, "raster-saturation": -0.25, "raster-contrast": 0.1 } },
      ],
    },
  });
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: '<a href="https://jamalsblog.com" target="_blank" rel="noopener">by Jamal · jamalsblog.com</a> · Stations <a href="https://www.radio-browser.info" target="_blank" rel="noopener">Radio Browser</a>',
  }), "bottom-right");

  async function addBorders() {
    try {
      const topo = await (await fetch("vendor/countries-110m.json")).json();
      const borders = topojson.mesh(topo, topo.objects.countries, (a, b) => a !== b);
      const coast = topojson.mesh(topo, topo.objects.countries, (a, b) => a === b);
      map.addSource("borders", { type: "geojson", data: borders });
      map.addSource("coast", { type: "geojson", data: coast });
      map.addLayer({ id: "coast", type: "line", source: "coast", paint: { "line-color": "rgba(170,200,255,0.28)", "line-width": 0.7 } });
      map.addLayer({ id: "borders", type: "line", source: "borders", paint: { "line-color": "rgba(170,200,255,0.22)", "line-width": 0.6, "line-dasharray": [2, 1.5] } });
    } catch (e) { console.warn("borders failed", e); }
  }

  function addStationLayers() {
    map.addSource("stations", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: stations.map((s, i) => ({ type: "Feature", id: i, properties: { r: i }, geometry: { type: "Point", coordinates: [s.lon, s.lat] } })),
      },
    });
    const playing = ["boolean", ["feature-state", "playing"], false];
    // popularity rank -> slightly larger dots for popular stations
    const rankScale = ["interpolate", ["linear"], ["get", "r"], 0, 1.5, 500, 1.15, 3000, 0.9];
    // MapLibre requires ["zoom"] to be the input of a top-level interpolate, so scale each stop.
    const byZoom = (factor, stops) => ["interpolate", ["linear"], ["zoom"], ...stops.flatMap(([z, r]) => [z, ["*", rankScale, factor, r]])];
    map.addLayer({
      id: "stations-glow", type: "circle", source: "stations",
      paint: {
        "circle-radius": byZoom(1, [[0, 4], [4, 7], [9, 12]]),
        "circle-color": ["case", playing, "#ff6b3d", "#ffb547"],
        "circle-opacity": ["case", playing, 0.55, 0.16],
        "circle-blur": 1,
      },
    });
    map.addLayer({
      id: "stations", type: "circle", source: "stations",
      paint: {
        "circle-radius": byZoom(["case", playing, 2, 1], [[0, 1.2], [4, 2.2], [9, 4.5]]),
        "circle-color": ["case", playing, "#fff3e0", "#ffd28a"],
        "circle-opacity": 0.95,
      },
    });

    map.on("mouseenter", "stations", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "stations", () => (map.getCanvas().style.cursor = ""));
    map.on("click", (e) => {
      const pad = e.originalEvent.pointerType === "touch" || "ontouchstart" in window ? 14 : 8;
      const { x, y } = e.point;
      const feats = map.queryRenderedFeatures([[x - pad, y - pad], [x + pad, y + pad]], { layers: ["stations"] });
      if (!feats.length) return;
      const ids = [...new Set(feats.map((f) => f.id))].sort((a, b) => a - b);
      const list = ids.map((i) => stations[i]).filter(Boolean);
      if (list.length === 1) { select(list[0], { play: true, fly: false }); hidePanel(); return; }
      const top = list[0];
      showPanel(placeLabel(top) + ` · ${list.length} stations`, list);
    });
  }

  let playingFeature = null;
  function markPlaying(s) {
    if (!map.getSource("stations")) return;
    if (playingFeature != null) map.setFeatureState({ source: "stations", id: playingFeature }, { playing: false });
    playingFeature = s ? s._i : null;
    if (playingFeature != null) map.setFeatureState({ source: "stations", id: playingFeature }, { playing: true });
  }

  // gentle auto-rotation until the user touches the globe
  let rotating = !!CFG.autoRotate && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const stopRotate = () => (rotating = false);
  ["mousedown", "touchstart", "wheel"].forEach((ev) => map.getCanvasContainer().addEventListener(ev, stopRotate, { passive: true }));
  function spin() {
    if (!rotating) return;
    if (!map.isMoving()) { const c = map.getCenter(); c.lng -= 0.04; map.setCenter(c); }
    requestAnimationFrame(spin);
  }

  // ---------- panel / lists ----------
  const placeLabel = (s) => [s.st, s.c].filter(Boolean).join(", ") || "Unknown location";

  function stationRow(s) {
    const li = document.createElement("li");
    li.tabIndex = 0;
    if (current && current.id === s.id) li.classList.add("playing");
    const logo = document.createElement("div");
    logo.className = "logo";
    if (s.f) {
      const img = new Image();
      img.loading = "lazy"; img.referrerPolicy = "no-referrer";
      img.onload = () => (logo.style.backgroundImage = `url("${img.src.replace(/["\\\n]/g, encodeURIComponent)}")`);
      img.src = s.f;
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    const n = document.createElement("div"); n.className = "name"; n.textContent = s.n;
    const sub = document.createElement("div"); sub.className = "sub"; sub.textContent = [placeLabel(s), s.t].filter(Boolean).join(" · ");
    meta.append(n, sub);
    li.append(logo, meta);
    const go = () => { select(s, { play: true, fly: true }); markRows(); };
    li.addEventListener("click", go);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    li.dataset.id = s.id;
    return li;
  }

  function markRows() {
    els.panelList.querySelectorAll("li[data-id]").forEach((li) => li.classList.toggle("playing", !!current && li.dataset.id === current.id));
  }

  function showPanel(title, list, emptyText = "No stations found", footer = null) {
    els.panelTitle.textContent = title;
    els.panelList.replaceChildren(...(list.length ? list.map(stationRow) : [Object.assign(document.createElement("li"), { className: "empty", textContent: emptyText })]));
    els.panel.querySelector(".panel-foot")?.remove();
    if (footer) els.panel.append(footer);
    els.panel.hidden = false;
  }
  function hidePanel() { els.panel.hidden = true; }
  $("panel-close").addEventListener("click", hidePanel);

  // ---------- search ----------
  function search(q) {
    q = q.trim().toLowerCase();
    if (!q) { hidePanel(); return; }
    const terms = q.split(/\s+/);
    const out = [];
    for (const s of stations) {
      const hay = `${s.n} ${s.t} ${s.c} ${s.cc} ${s.st}`.toLowerCase();
      if (terms.every((t) => hay.includes(t))) { out.push(s); if (out.length >= 80) break; }
    }
    showPanel(`Search · ${out.length >= 80 ? "80+" : out.length} results`, out, "No stations match that search");
  }
  els.search.addEventListener("input", debounce((e) => search(e.target.value), 180));
  els.search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { els.search.value = ""; hidePanel(); els.search.blur(); }
    if (e.key === "Enter") els.panelList.querySelector("li[data-id]")?.click();
  });

  // ---------- favorites ----------
  const isFav = (s) => favs.some((f) => f.id === s.id);
  function toggleFav() {
    if (!current) return;
    favs = isFav(current) ? favs.filter((f) => f.id !== current.id) : [{ ...current, _i: undefined }, ...favs];
    store.set(FAVS_KEY, favs);
    updateFavBtn();
    if (!els.panel.hidden && els.panelTitle.textContent === "Favorites") openFavs();
  }
  function updateFavBtn() {
    const on = !!current && isFav(current);
    els.fav.disabled = !current;
    els.fav.classList.toggle("active", on);
    els.fav.setAttribute("aria-label", on ? "Remove from favorites" : "Add to favorites");
  }
  function openFavs() {
    // re-link favorites to live station objects (so map highlight works) when available
    const list = favs.map((f) => byUuid.get(f.id) || f);
    let foot = null;
    const support = safeUrl(CFG.supportUrl);
    if (support) {
      foot = document.createElement("div"); foot.className = "panel-foot";
      const a = Object.assign(document.createElement("a"), { href: support, target: "_blank", rel: "noopener", textContent: `Support ${CFG.name || "this site"}` });
      foot.append("No ads, ever. ", a);
    }
    showPanel("Favorites", list, "Tap ♥ while a station plays to save it here", foot);
  }
  els.fav.addEventListener("click", toggleFav);
  $("btn-favs").addEventListener("click", () => (els.panel.hidden || els.panelTitle.textContent !== "Favorites" ? openFavs() : hidePanel()));

  // ---------- player ----------
  function setState(state, sub) {
    els.player.dataset.state = state;
    if (sub != null) els.sub.textContent = sub;
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = state === "playing" ? "playing" : "paused";
  }

  function stationSub(s) {
    const q = [s.k, s.b ? `${s.b} kbps` : ""].filter(Boolean).join(" ");
    return [placeLabel(s), s.t, q].filter(Boolean).join(" · ");
  }

  function select(s, { play = true, fly = true } = {}) {
    current = s;
    rotating = false;
    els.name.textContent = s.n;
    els.sub.textContent = stationSub(s);
    els.play.disabled = false;
    if (s.f) { els.logo.hidden = false; els.logoFallback.hidden = true; els.logo.src = s.f; }
    else { els.logo.hidden = true; els.logoFallback.hidden = false; }
    updateFavBtn();
    markPlaying(s);
    history.replaceState(null, "", `#station=${encodeURIComponent(s.id)}`);
    els.hint.classList.add("gone");
    if (fly && Number.isFinite(s.lat)) map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 3), speed: 1.2, essential: true });
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: s.n, artist: placeLabel(s), album: CFG.name || "Jamal's Radio",
        artwork: s.f ? [{ src: s.f, sizes: "512x512" }] : [{ src: "icons/icon.svg", sizes: "any", type: "image/svg+xml" }],
      });
    }
    if (play) startPlayback(); else setState("paused", stationSub(s));
  }

  function startPlayback() {
    if (!current) return;
    const s = current;
    clearTimeout(stallTimer);
    setState("loading", "Connecting…");
    els.audio.src = s.u;
    els.audio.play().catch((err) => {
      if (current !== s) return;
      if (err && err.name === "NotAllowedError") setState("paused", stationSub(s));
      // other errors are surfaced by the 'error' event
    });
    stallTimer = setTimeout(() => { if (current === s && els.player.dataset.state === "loading") fail(s); }, STALL_MS);
    reportClick(s);
  }

  function fail(s) {
    if (current !== s) return;
    clearTimeout(stallTimer);
    els.audio.removeAttribute("src"); els.audio.load();
    setState("error", "This station isn't responding — try another one");
  }

  function togglePlay() {
    if (!current) return;
    const st = els.player.dataset.state;
    if (st === "playing" || st === "loading") { els.audio.pause(); els.audio.removeAttribute("src"); els.audio.load(); clearTimeout(stallTimer); setState("paused", stationSub(current)); }
    else startPlayback();
  }

  els.audio.addEventListener("playing", () => { clearTimeout(stallTimer); if (current) setState("playing", stationSub(current)); });
  els.audio.addEventListener("waiting", () => { if (current && els.player.dataset.state === "playing") setState("loading", "Buffering…"); });
  els.audio.addEventListener("error", () => { if (current && els.audio.getAttribute("src")) fail(current); });
  els.logo.addEventListener("error", () => { els.logo.hidden = true; els.logoFallback.hidden = false; });
  els.play.addEventListener("click", togglePlay);

  els.vol.value = store.get(VOL_KEY, 0.8);
  els.audio.volume = +els.vol.value;
  els.vol.addEventListener("input", () => { els.audio.volume = +els.vol.value; store.set(VOL_KEY, +els.vol.value); });

  function randomStation() {
    if (!stations.length) return;
    // bias toward popular-ish stations but keep it surprising
    const s = stations[(Math.random() ** 1.6 * stations.length) | 0];
    hidePanel();
    select(s, { play: true, fly: true });
  }
  $("btn-random").addEventListener("click", randomStation);

  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => startPlayback());
    navigator.mediaSession.setActionHandler("pause", () => togglePlay());
    navigator.mediaSession.setActionHandler("nexttrack", randomStation);
  }

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea")) return;
    if (e.key === "/") { e.preventDefault(); els.search.focus(); }
    else if (e.key === " ") { e.preventDefault(); togglePlay(); }
    else if (e.key.toLowerCase() === "r") randomStation();
    else if (e.key === "Escape") hidePanel();
  });

  // ---------- boot ----------
  async function boot() {
    await new Promise((res) => (map.loaded() ? res() : map.once("load", res)));
    await addBorders();
    if (rotating) requestAnimationFrame(spin);
    // API server is only needed for click reporting / shared links when the snapshot exists,
    // so resolve it in the background rather than blocking the first render.
    const serverReady = pickServer().then((b) => (apiBase = apiBase || b)).catch(() => null);
    try {
      stations = await loadStations();
    } catch (e) {
      console.error(e);
      els.hintText.textContent = "Couldn't reach the station directory — please reload";
      return;
    }
    stations.forEach((s, i) => { s._i = i; byUuid.set(s.id, s); });
    addStationLayers();
    els.hintText.textContent = `${stations.length.toLocaleString()} stations · tap a glowing dot`;
    setTimeout(() => els.hint.classList.add("gone"), 6000);

    const m = location.hash.match(/station=([\w-]+)/);
    if (m) {
      let s = byUuid.get(m[1]);
      if (!s) {
        await serverReady;
        try {
          const r = await fetch(`${apiBase}/json/stations/byuuid/${encodeURIComponent(m[1])}`);
          const raw = (await r.json())[0];
          if (raw) s = compact(raw);
        } catch { /* ignore */ }
      }
      if (s) select(s, { play: false, fly: true }); // browsers block autoplay; user presses play
    }
  }
  boot();
})();
