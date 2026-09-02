#!/usr/bin/env bash
# 서버 watch 모드 (devDependencies 추가 없이 bash 로 구현한 mini-nodemon):
#   1) npx tsc -w 가 dist/ 를 갱신하고, 컴파일 완료("Watching for file changes.") 시점마다
#   2) 기존 node 프로세스를 kill + wait 로 종료 보장한 뒤 새로 기동한다.
# node --watch 를 쓰지 않는 이유: 재시작 시 이전 프로세스의 graceful shutdown 이 끝나기 전에
# 새 프로세스가 떠서 EADDRINUSE 로 죽고, 이후 변경 전까지 서버가 죽은 채 멈춘다.
# macOS 기본 bash 3.2 호환을 위해 coproc 대신 FIFO 로 tsc 출력을 읽는다.
# 별칭(@core/* 등)은 tsconfig paths 를 dist 기준으로 재매핑하는 scripts/path-alias.js 로
# 해석하므로 컴파일된 dist 기반 실행이 가장 안전하다(기존 start-web.js 방식과 동일).
set -uo pipefail
cd "$(dirname "$0")/.."

# PM2 로 상시 구동되는 운영 웹 서버가 기본 포트 3002 를 점유하므로, dev 서버는 3005 로 띄운다.
# vite.config.ts 의 프록시도 같은 환경변수(BLOG_POSTER_WEB_PORT)를 읽어 이 포트로 전달한다.
# (dev-web.sh 도 동일한 기본값을 export 하므로 양쪽을 함께 바꿀 것)
export BLOG_POSTER_WEB_PORT="${BLOG_POSTER_WEB_PORT:-3005}"
export BLOG_POSTER_WEB_HOST="${BLOG_POSTER_WEB_HOST:-127.0.0.1}"

TSC_PID=""
NODE_PID=""
cleanup() {
  trap - EXIT INT TERM
  [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null
  [ -n "$TSC_PID" ] && kill "$TSC_PID" 2>/dev/null
  wait 2>/dev/null
  return 0
}
trap cleanup EXIT INT TERM

start_node() {
  node -r ./scripts/path-alias.js scripts/start-web.js &
  NODE_PID=$!
}

start_node

# tsc -w 출력을 FIFO 로 받아 그대로 전달하면서, 컴파일 1회 완료마다 서버를 재기동한다.
# (서버 프로세스 자체가 죽으면 다음 컴파일 시점에 재기동된다)
TSC_FIFO="$(mktemp -d)/tsc-out"
mkfifo "$TSC_FIFO"
npx tsc -w --preserveWatchOutput > "$TSC_FIFO" 2>&1 &
TSC_PID=$!
while IFS= read -r line <"$TSC_FIFO"; do
  printf '%s\n' "$line"
  case "$line" in
    *"Watching for file changes."*)
      kill "$NODE_PID" 2>/dev/null
      wait "$NODE_PID" 2>/dev/null
      start_node
      ;;
  esac
done
