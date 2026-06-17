#!/bin/sh

set -eu

SUPERVISOR_PID=""

cleanup() {
  if [ -n "$SUPERVISOR_PID" ] && kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
    kill -TERM "$SUPERVISOR_PID" 2>/dev/null || true
    wait "$SUPERVISOR_PID" 2>/dev/null || true
  fi
}

trap 'cleanup; exit 0' INT TERM EXIT

( while true; do
    node /app/sync.js
    echo "[$(date -u +%FT%TZ)] sync.js exited, restarting in 1s..."
    sleep 1
  done
) &
SUPERVISOR_PID=$!

mkdir -p "${THEME_NOTES_DIR:-/theme-notes}"

THEMES_ARG="--theme-set ${THEME_NOTES_DIR:-/theme-notes}"
THEME_FILES="$(ls /themes/*.css 2>/dev/null || true)"
if [ -n "$THEME_FILES" ]; then
  THEMES_ARG="$THEMES_ARG /themes"
  echo "[$(date -u +%FT%TZ)] theme-set enabled, found CSS:"
  echo "$THEME_FILES" | sed 's/^/  /'
else
  echo "[$(date -u +%FT%TZ)] theme-set enabled with theme notes dir only"
fi

# shellcheck disable=SC2086
PORT=8081 marp -s -I /data/ --html --allow-local-files $THEMES_ARG
MARP_EXIT=$?

cleanup
exit "$MARP_EXIT"
