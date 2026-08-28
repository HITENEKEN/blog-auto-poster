#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${BLOG_POSTER_WEB_PORT:-4173}"
# Sweep stale workspaces from previous SIGKILL'd runs — the bash EXIT trap cannot
# fire on SIGKILL, so Playwright teardown leaves orphans behind. A workspace is
# stale when its pidfile's owner process is gone, or when it has no pidfile and
# is older than 1 day (pre-pidfile leftovers). Runs before our own workspace is
# created, so we can never sweep ourselves. Single-worker usage keeps this race-free.
for dir in /tmp/blog-poster-e2e.*; do
  [ -d "$dir" ] || continue
  pid="$(cat "$dir/pid" 2>/dev/null || true)"
  pstat="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  if [ -n "$pid" ] && [ -n "$pstat" ] && [ "${pstat#Z}" = "$pstat" ]; then
    continue # owner process still alive (a zombie "Z" state counts as dead)
  fi
  if [ -z "$pid" ] && ! find "$dir" -maxdepth 0 -mtime +1 2>/dev/null | grep -q .; then
    continue # no pidfile and fresh — leave it alone
  fi
  rm -rf "$dir"
done
WS="$(mktemp -d /tmp/blog-poster-e2e.XXXXXX)"
echo $$ > "$WS/pid"
mkdir -p "$WS/data" "$WS/src/web/client" "$WS/output" "$WS/.cache"
ln -s "$ROOT/src/web/client/dist" "$WS/src/web/client/dist"
cp -r "$ROOT/templates" "$WS/templates"
cp -r "$ROOT/config/e2e" "$WS/config"
export BLOG_POSTER_CONFIG_DIR="$WS/config"
export NODE_ENV=e2e
export BLOG_POSTER_WEB_PORT="$PORT"
export BLOG_POSTER_WEB_HOST=127.0.0.1
export BLOG_POSTER_WEB_ADMIN_USERNAME='e2e-admin'
export BLOG_POSTER_WEB_ADMIN_PASSWORD='e2e-pass-1234'
cd "$WS"
node -r "$ROOT/scripts/path-alias.js" "$ROOT/scripts/start-web.js" &
NODE_PID=$!
trap 'kill "$NODE_PID" 2>/dev/null || true; rm -rf "$WS"' EXIT INT TERM
wait "$NODE_PID"
