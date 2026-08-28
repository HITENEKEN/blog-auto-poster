#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${BLOG_POSTER_WEB_PORT:-4173}"
WS="$(mktemp -d /tmp/blog-poster-e2e.XXXXXX)"
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
