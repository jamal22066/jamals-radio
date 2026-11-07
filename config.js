// Site-level settings. Edit these to rebrand / tune the app — nothing else needs to change.
window.SITE_CONFIG = {
  name: "Jamal's Radio",
  tagline: "world radio on a globe, from jamalsblog.com",

  // How many stations to load (most popular first). 10000 is a good balance of coverage vs. load time.
  stationLimit: 10000,

  // Only show HTTPS streams when the site is served over HTTPS (browsers block http audio on https pages).
  httpsOnly: location.protocol === "https:",

  // Cache the station list in the browser for this many hours.
  cacheHours: 12,

  // Slowly rotate the globe until the visitor interacts.
  autoRotate: true,

  // Optional support link shown in the favorites panel footer. Leave "" to hide.
  supportUrl: "",

  // Play stats: the page reports play start / listen time / failure to this same-origin
  // endpoint, which nginx writes to a log with the visitor's IP (see deploy/nginx.conf, read it with
  // ./stats.sh, which adds city and ISP). No cookies. Leave "" to turn it off.
  playStatsUrl: "/api/play",
};
