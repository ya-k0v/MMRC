#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

if [[ ! -d .git ]]; then
  echo "[hooks] .git directory not found, skipping hooks setup"
  exit 0
fi

if [[ ! -d .githooks ]]; then
  echo "[hooks] .githooks directory not found, skipping hooks setup"
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  echo "[hooks] git command not found, skipping hooks setup"
  exit 0
fi

chmod +x .githooks/* 2>/dev/null || true
git config core.hooksPath .githooks

echo "[hooks] core.hooksPath configured to .githooks"
