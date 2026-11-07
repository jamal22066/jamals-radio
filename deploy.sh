#!/usr/bin/env bash
# Deploy Jamal's Radio over SSH. Set DEPLOY_HOST to your ssh host alias.
# The site lives in ~/radio on the server and is served by the rootless "radio" systemd user service (see deploy/).
set -euo pipefail
cd "$(dirname "$0")"
HOST="${DEPLOY_HOST:-relayvps}"

node --check app.js

# Code and assets. data/ is excluded so the server's daily-refreshed station list isn't clobbered.
# index.html is sent separately with __V__ replaced by a content hash, so Cloudflare's edge cache
# (which holds css/js for hours) picks up new versions immediately after each deploy.
rsync -az --delete --exclude '.git' --exclude 'data/' --exclude 'CLAUDE*.md' --exclude '.gitignore' --exclude 'LICENSE' --exclude 'index.html' ./ "$HOST:radio/"
V=$(cat app.js style.css config.js | sha1sum | cut -c1-10)
sed "s/__V__/$V/g" index.html | ssh "$HOST" 'cat > radio/index.html.tmp && mv radio/index.html.tmp radio/index.html'
echo "deployed asset version $V"
# Seed the station list only if the server doesn't have one yet.
[ -f data/stations.json ] || node scripts/build-stations.mjs
rsync -az --ignore-existing data/ "$HOST:radio/data/"

ssh "$HOST" 'set -e
  mkdir -p ~/.config/systemd/user
  cp ~/radio/deploy/radio.service ~/radio/deploy/radio-stations.service ~/radio/deploy/radio-stations.timer ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable --now radio-stations.timer >/dev/null
  systemctl --user enable radio.service >/dev/null
  systemctl --user restart radio.service
  for i in $(seq 1 30); do curl -fs -o /dev/null http://127.0.0.1:9180/ && break; sleep 1; done
  curl -fsS -o /dev/null -w "radio on 127.0.0.1:9180 -> HTTP %{http_code}\n" http://127.0.0.1:9180/'
