#!/usr/bin/env bash
# Show who played what on Jamal's Radio. Streams the play log from the server (~/radio-logs)
# and summarises it locally, adding city/region/ISP for each visitor IP from DB-IP's free Lite
# databases (downloaded once a month to ~/.cache/jamalradio-geo; lookups never leave this machine).
# Options pass through: --days N (default 7, 0 = all), --top N, --no-ip.
set -euo pipefail
cd "$(dirname "$0")"
HOST="${DEPLOY_HOST:-relayvps}"
GEO="${GEO_DIR:-$HOME/.cache/jamalradio-geo}"

mkdir -p "$GEO"
for kind in city asn; do
  ls "$GEO"/dbip-$kind-lite-$(date -u +%Y-%m).mmdb >/dev/null 2>&1 && continue
  # This month's file appears early in the month; fall back to last month's if it isn't out yet.
  for m in $(date -u +%Y-%m) $(date -u -d "$(date -u +%Y-%m-01) -1 day" +%Y-%m); do
    [ -f "$GEO/dbip-$kind-lite-$m.mmdb" ] && break
    echo "downloading DB-IP $kind database ($m)..." >&2
    if curl -4 -fsS "https://download.db-ip.com/free/dbip-$kind-lite-$m.mmdb.gz" | gunzip > "$GEO/.dl.tmp"; then
      mv "$GEO/.dl.tmp" "$GEO/dbip-$kind-lite-$m.mmdb"
      # keep only the newest file of each kind
      ls -1 "$GEO"/dbip-$kind-lite-*.mmdb | sort | head -n -1 | xargs -r rm -f
      break
    fi
    rm -f "$GEO/.dl.tmp"
  done
done

ssh "$HOST" 'cat ~/radio-logs/plays.log* 2>/dev/null || true' | python3 scripts/play-stats.py --geo-dir "$GEO" "$@"
