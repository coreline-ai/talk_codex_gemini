#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$ROOT_DIR/.pids"
SERVER_PID_FILE="$PID_DIR/server.pid"
WEB_PID_FILE="$PID_DIR/web.pid"

show_status() {
  local name="$1"
  local pid_file="$2"
  if [[ ! -f "$pid_file" ]]; then
    echo "$name: not running (no pid file)"
    return
  fi
  local pid
  pid="$(cat "$pid_file")"
  if [[ -n "$pid" ]] && ps -p "$pid" >/dev/null 2>&1; then
    echo "$name: running (pid=$pid)"
  else
    echo "$name: not running (stale pid file: $pid)"
  fi
}

show_status "server" "$SERVER_PID_FILE"
show_status "web" "$WEB_PID_FILE"

echo
echo "port 8787:"
lsof -nP -iTCP:8787 -sTCP:LISTEN || true
echo
echo "port 5173:"
lsof -nP -iTCP:5173 -sTCP:LISTEN || true

echo
echo "process scan:"
ps -ef | grep -E "tsx watch server/index.ts|vite --config web/vite.config.ts" | grep -v grep || true
