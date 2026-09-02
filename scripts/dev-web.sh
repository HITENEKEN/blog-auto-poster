#!/usr/bin/env bash
# 서버(tsc -w + node --watch, :3002)와 클라이언트(vite dev, :5173)를 함께 띄운다.
# concurrently 가 devDependencies 에 없으므로 trap 으로 모든 자식을 정리해
# 인터럽트(Ctrl+C/TERM) 시 좀비 프로세스를 남기지 않는다.
set -uo pipefail
cd "$(dirname "$0")/.."

SERVER_PID=""
VITE_PID=""
# dev-server.sh 와 동일한 dev 포트 기본값 — vite(형제 프로세스)의 프록시가 이 값을 읽는다.
export BLOG_POSTER_WEB_PORT="${BLOG_POSTER_WEB_PORT:-3005}"
export BLOG_POSTER_WEB_HOST="${BLOG_POSTER_WEB_HOST:-127.0.0.1}"
cleanup() {
  trap - EXIT INT TERM
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  wait 2>/dev/null
  return 0
}
trap cleanup EXIT INT TERM

bash scripts/dev-server.sh &
SERVER_PID=$!

(cd src/web/client && exec npx vite) &
VITE_PID=$!

wait
