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

marp --server /data/ --port 8081 --allow-local-files --theme-set /themes
MARP_EXIT=$?

cleanup
exit "$MARP_EXIT"
