#!/usr/bin/env python3
"""Summarise the play-stats log written by nginx (deploy/nginx.conf, /api/play).

Reads JSON lines ({"t": iso time, "q": query string from app.js, "vc": visitor country, "ip": visitor IP})
on stdin. City, region and ISP come from DB-IP's free Lite databases (CC BY 4.0, https://db-ip.com),
which ./stats.sh downloads monthly to ~/.cache/jamalradio-geo; lookups are offline.
Normally run through ./stats.sh, which streams the log from the server:
    ./stats.sh              # last 7 days
    ./stats.sh --days 1     # last 24 hours
    ./stats.sh --days 0     # everything
"""
import argparse
import glob
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from statistics import median
from urllib.parse import parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mmdb  # noqa: E402


class Geo:
    """IP -> (city, region, country code, ISP) from the newest DB-IP Lite files in a directory."""

    def __init__(self, folder):
        def newest(kind):
            files = sorted(glob.glob(os.path.join(folder, f"dbip-{kind}-lite-*.mmdb")))
            return mmdb.Reader(files[-1]) if files else None
        self.city, self.asn, self.cache = newest("city"), newest("asn"), {}

    def __call__(self, ip):
        if ip not in self.cache:
            c = (self.city.get(ip) if self.city and ip else None) or {}
            a = (self.asn.get(ip) if self.asn and ip else None) or {}
            name = lambda d: (d or {}).get("names", {}).get("en", "")
            self.cache[ip] = (name(c.get("city")), name((c.get("subdivisions") or [None])[0]),
                              (c.get("country") or {}).get("iso_code", ""), a.get("autonomous_system_organization", ""))
        return self.cache[ip]


def hms(sec):
    sec = int(sec)
    if sec < 60:
        return f"{sec}s"
    if sec < 3600:
        return f"{sec // 60}m {sec % 60:02d}s"
    return f"{sec // 3600}h {sec % 3600 // 60:02d}m"


NUMERIC = re.compile(r"^\d+(\.\d+)?(s|m \d\ds|h \d\dm)?$")


def table(title, header, rows, limit):
    print(f"\n{title}")
    if not rows:
        print("  (none)")
        return
    rows = rows[:limit]
    cols = [header] + [[str(c) for c in r] for r in rows]
    widths = [max(len(r[i]) for r in cols) for i in range(len(header))]
    # numbers and durations right-aligned, text left-aligned
    num = [all(NUMERIC.match(r[i]) for r in cols[1:]) for i in range(len(header))]
    for n, r in enumerate(cols):
        print("  " + "  ".join(c.rjust(w) if num[i] else c.ljust(w) for i, (c, w) in enumerate(zip(r, widths))).rstrip())
        if n == 0:
            print("  " + "  ".join("-" * w for w in widths))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=float, default=7, help="only the last N days (0 = all; default 7)")
    ap.add_argument("--top", type=int, default=15, help="rows per table (default 15)")
    ap.add_argument("--geo-dir", default=os.path.expanduser("~/.cache/jamalradio-geo"), help="folder with dbip-*-lite-*.mmdb")
    ap.add_argument("--no-ip", action="store_true", help="hide IP addresses in the output")
    a = ap.parse_args()
    geo = Geo(a.geo_dir)
    since = datetime.now(timezone.utc) - timedelta(days=a.days) if a.days > 0 else None

    plays = {}                    # play id -> info, for plays that produced sound
    secs = defaultdict(int)       # play id -> seconds listened (max of beat/stop reports)
    fails = []
    bad = 0
    for line in sys.stdin:
        try:
            rec = json.loads(line)
            t = datetime.fromisoformat(rec["t"])
            q = {k: v[0] for k, v in parse_qs(rec["q"]).items()}
        except (ValueError, KeyError):
            bad += 1
            continue
        if since and t < since:
            continue
        e, p = q.get("e"), q.get("p", "")
        info = {"t": t, "id": q.get("id", ""), "n": q.get("n") or q.get("id", "?"), "cc": q.get("cc", ""),
                "vc": rec.get("vc") or "??", "v": q.get("v", ""), "ip": rec.get("ip", "")}
        info["city"], info["region"], info["gcc"], info["isp"] = geo(info["ip"])
        if e == "start":
            info["ms"] = int(q["ms"]) if q.get("ms", "").isdigit() else None
            plays[p] = info
        elif e in ("beat", "stop") and q.get("sec", "").isdigit():
            secs[p] = max(secs[p], int(q["sec"]))
        elif e == "fail":
            info["why"] = q.get("why", "?")
            fails.append(info)

    span = f"last {a.days:g} day(s)" if since else "all time"
    print(f"Jamal's Radio play stats ({span})")
    if not plays and not fails:
        print("\nNo plays recorded yet.")
        return

    listened = [secs[p] for p in plays]
    starts = [x["ms"] for x in plays.values() if x.get("ms") is not None]
    attempts = len(plays) + len(fails)
    print(f"\n  Plays (sound actually started)  {len(plays)}")
    print(f"  Failed attempts (no sound)      {len(fails)}  ({len(plays) / attempts:.0%} of attempts succeeded)")
    print(f"  Visits with a play              {len({x['v'] for x in plays.values()})}  (page loads)")
    ips = {x["ip"] for x in plays.values() if x["ip"]}
    print(f"  Listeners (unique IPs)          {len(ips)}" + ("" if ips else "  (IPs are logged from 2026-11-07 on)"))
    print(f"  Total listening time            {hms(sum(listened))}")
    if listened:
        print(f"  Median listen per play          {hms(median(listened))}")
    if starts:
        print(f"  Median time to first sound      {median(starts) / 1000:.1f}s")

    by_station = defaultdict(lambda: {"plays": 0, "secs": 0, "visits": set()})
    for p, x in plays.items():
        b = by_station[(x["n"], x["cc"])]
        b["plays"] += 1
        b["secs"] += secs[p]
        b["visits"].add(x["v"])
    rows = sorted(by_station.items(), key=lambda kv: (-kv[1]["plays"], -kv[1]["secs"]))
    table("Top stations", ["Station", "Country", "Plays", "Visits", "Listened"],
          [[n[:48], cc, b["plays"], len(b["visits"]), hms(b["secs"])] for (n, cc), b in rows], a.top)

    by_long = sorted(by_station.items(), key=lambda kv: -kv[1]["secs"])
    table("Most listened (by time)", ["Station", "Country", "Listened", "Plays"],
          [[n[:48], cc, hms(b["secs"]), b["plays"]] for (n, cc), b in by_long if b["secs"]], a.top)

    def by(key):
        c, s = Counter(), Counter()
        for p, x in plays.items():
            c[x[key]] += 1
            s[x[key]] += secs[p]
        return [[k or "??", n, hms(s[k])] for k, n in c.most_common()]

    table("Listeners by their country (from Cloudflare)", ["Country", "Plays", "Listened"], by("vc"), a.top)

    def place(x):
        if not x["ip"]:
            return "(no IP logged)"
        region = x["region"] if x["region"] != x["city"] else ""
        return ", ".join(p for p in (x["city"], region, x["gcc"] or x["vc"]) if p) or "?"
    group = lambda key: _group(plays, secs, key)
    table("Listeners by city", ["City", "IPs", "Plays", "Listened"],
          [[k[:48], len(g["ips"]), g["plays"], hms(g["secs"])] for k, g in group(place)], a.top)
    table("Listeners by network (ISP)", ["Network", "IPs", "Plays", "Listened"],
          [[k[:48], len(g["ips"]), g["plays"], hms(g["secs"])] for k, g in group(lambda x: x["isp"] or "?") if k != "?" or g["ips"]], a.top)
    if not a.no_ip:
        table("Listeners by IP", ["IP", "Where", "Network", "Plays", "Listened", "Last play (UTC)"],
              [[k, place(g["last"])[:36], (g["last"]["isp"] or "?")[:28], g["plays"], hms(g["secs"]), g["last"]["t"].strftime("%b %d %H:%M")]
               for k, g in group(lambda x: x["ip"]) if k], a.top)
    table("Plays by station country", ["Country", "Plays", "Listened"], by("cc"), a.top)

    fc = Counter((x["n"], x["cc"], x["why"]) for x in fails)
    table("Stations that failed to play", ["Station", "Country", "Why", "Times"],
          [[n[:48], cc, why, k] for (n, cc, why), k in fc.most_common()], a.top)

    recent = sorted(plays.items(), key=lambda kv: kv[1]["t"], reverse=True)
    table("Recent plays (UTC)", ["Station", "Started", "Listener", "Listened"],
          [[x["n"][:40], x["t"].strftime("%b %d %H:%M"), ((x["ip"] + " ") if x["ip"] and not a.no_ip else "") + (place(x) if x["ip"] else x["vc"]), hms(secs[p])]
           for p, x in recent], 10)
    if bad:
        print(f"\n({bad} unreadable log lines skipped)")
    if geo.city:
        print("\nIP geolocation by DB-IP (https://db-ip.com, CC BY 4.0). City is approximate; mobile and VPN users often show the ISP's location.")
    else:
        print(f"\n(no DB-IP databases in {a.geo_dir}; run ./stats.sh to download them)")


def _group(plays, secs, keyfn):
    g = defaultdict(lambda: {"plays": 0, "secs": 0, "ips": set(), "last": None})
    for p, x in plays.items():
        b = g[keyfn(x)]
        b["plays"] += 1
        b["secs"] += secs[p]
        if x["ip"]:
            b["ips"].add(x["ip"])
        if b["last"] is None or x["t"] > b["last"]["t"]:
            b["last"] = x
    return sorted(g.items(), key=lambda kv: (-kv[1]["plays"], -kv[1]["secs"]))


if __name__ == "__main__":
    main()
