#!/bin/sh
# Daily: move the play-stats log aside as plays.log.YYYY-MM-DD, tell nginx in the radio-web container
# to reopen its logs, and delete rotated files older than RETAIN_DAYS (the privacy page promises 90).
# Run by radio-plays-rotate.timer. ./stats.sh reads plays.log* so rotated days are still counted.
set -eu
RETAIN_DAYS="${RETAIN_DAYS:-90}"
cd "$HOME/radio-logs"
if [ -s plays.log ]; then
  dest="plays.log.$(date -u -d yesterday +%Y-%m-%d)"  # runs just after midnight UTC, so it holds yesterday
  [ -e "$dest" ] && dest="$dest-$(date -u +%H%M%S)"
  mv plays.log "$dest"
  /usr/bin/podman exec radio-web nginx -s reopen || echo "warning: could not tell nginx to reopen its log" >&2
fi
find . -maxdepth 1 -name 'plays.log.*' -type f -mtime +"$RETAIN_DAYS" -print -delete
