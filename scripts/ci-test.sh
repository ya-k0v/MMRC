#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

TMP_DIR="$ROOT_DIR/.tmp"
SERVER_LOG="$TMP_DIR/ci-server.log"
HEALTH_JSON="$TMP_DIR/ci-health.json"

mkdir -p "$TMP_DIR"
rm -f "$SERVER_LOG" "$HEALTH_JSON"

# Ensure CONTENT_ROOT is writable for CI/local runs. Prefer explicit env, else use repo .tmp/data
if [[ -z "${CONTENT_ROOT:-}" ]]; then
  export CONTENT_ROOT="$TMP_DIR/data"
  mkdir -p "$CONTENT_ROOT"
fi

# Keep CI behavior deterministic (avoid production-only exits in middleware)
export NODE_ENV="${NODE_ENV:-test}"

echo "[ci] Syntax check (server scripts)"
find server.js src scripts dev/scripts -type f -name '*.js' -print0 | xargs -0 -n1 node --check

echo "[ci] DB migration check"
npm run migrate-db --silent

echo "[ci] Startup smoke test"
node server.js >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

READY=0
for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:3000/health" >"$HEALTH_JSON" 2>/dev/null; then
    READY=1
    break
  fi

  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    echo "[ci] Server exited before health endpoint became ready"
    cat "$SERVER_LOG" || true
    exit 1
  fi

  sleep 1
done

if [[ "$READY" != "1" ]]; then
  echo "[ci] Health endpoint did not become ready in time"
  cat "$SERVER_LOG" || true
  exit 1
fi

echo "[ci] Health response"
cat "$HEALTH_JSON"

echo "[ci] PASS"
