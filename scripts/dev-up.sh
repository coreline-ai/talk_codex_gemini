#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$ROOT_DIR/.pids"
LOG_DIR="$ROOT_DIR/.logs"
mkdir -p "$PID_DIR" "$LOG_DIR"

SERVER_PID_FILE="$PID_DIR/server.pid"
WEB_PID_FILE="$PID_DIR/web.pid"
TSX_BIN="$ROOT_DIR/node_modules/.bin/tsx"
VITE_BIN="$ROOT_DIR/node_modules/.bin/vite"

kill_if_running() {
  local pid_file="$1"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if [[ -n "$pid" ]] && ps -p "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
      sleep 0.2
    fi
    rm -f "$pid_file"
  fi
}

kill_if_running "$SERVER_PID_FILE"
kill_if_running "$WEB_PID_FILE"

cd "$ROOT_DIR"
nohup "$TSX_BIN" watch server/index.ts > "$LOG_DIR/server.log" 2>&1 < /dev/null &
SERVER_PID=$!
echo "$SERVER_PID" > "$SERVER_PID_FILE"

nohup "$VITE_BIN" --config web/vite.config.ts > "$LOG_DIR/web.log" 2>&1 < /dev/null &
WEB_PID=$!
echo "$WEB_PID" > "$WEB_PID_FILE"

sleep 2

echo "server pid: $SERVER_PID"
echo "web pid: $WEB_PID"
echo "web url: http://localhost:5173"
echo "api url: http://localhost:8787"
