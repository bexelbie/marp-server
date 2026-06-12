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

THEMES_ARG=""
if [ "$(ls /themes/*.css 2>/dev/null | wc -l)" -gt 0 ]; then
  THEMES_ARG="--theme-set /themes"
fi

# shellcheck disable=SC2086
PORT=8081 marp -s -I /data/ --allow-local-files $THEMES_ARG
MARP_EXIT=$?

cleanup
exit "$MARP_EXIT"
