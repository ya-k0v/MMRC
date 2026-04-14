#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SERVICE_NAME="${SERVICE_NAME:-videocontrol.service}"
SKIP_NPM_INSTALL="${SKIP_NPM_INSTALL:-0}"
SKIP_MIGRATION="${SKIP_MIGRATION:-0}"
SKIP_SERVICE_RESTART="${SKIP_SERVICE_RESTART:-0}"

log() {
  echo "[post-pull] $*"
}

cd "$REPO_ROOT"

if [[ ! -f package.json ]]; then
  log "package.json not found, nothing to sync"
  exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
  log "npm not found, cannot continue"
  exit 0
fi

install_deps() {
  if [[ ! -f package-lock.json ]]; then
    log "package-lock.json not found, running npm install"
    npm install
    return
  fi

  # Production-oriented default for server machines, with safe fallback.
  if [[ "${NODE_ENV:-production}" == "production" ]]; then
    log "Installing dependencies (npm ci --omit=dev)"
    npm ci --omit=dev || npm ci || npm install
  else
    log "Installing dependencies (npm ci)"
    npm ci || npm install
  fi
}

restart_service_linux() {
  if [[ "$SKIP_SERVICE_RESTART" == "1" ]]; then
    log "SKIP_SERVICE_RESTART=1, skipping service restart"
    return
  fi

  if [[ "$(uname -s)" != "Linux" ]]; then
    log "Non-Linux OS detected, skipping systemd restart"
    return
  fi

  if ! command -v systemctl >/dev/null 2>&1; then
    log "systemctl not found, skipping service restart"
    return
  fi

  local can_sudo=0
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    can_sudo=1
  fi

  local unit_target="/etc/systemd/system/$SERVICE_NAME"
  local unit_source="$REPO_ROOT/videocontrol.service"
  local daemon_reload_required=0

  if [[ -f "$unit_source" ]]; then
    if [[ "$EUID" -eq 0 ]]; then
      if [[ ! -f "$unit_target" ]] || ! cmp -s "$unit_source" "$unit_target"; then
        cp "$unit_source" "$unit_target"
        chmod 644 "$unit_target"
        daemon_reload_required=1
        log "Updated systemd unit: $SERVICE_NAME"
      fi
    elif [[ "$can_sudo" -eq 1 ]]; then
      if ! sudo -n test -f "$unit_target" || ! sudo -n cmp -s "$unit_source" "$unit_target"; then
        sudo -n cp "$unit_source" "$unit_target"
        sudo -n chmod 644 "$unit_target"
        daemon_reload_required=1
        log "Updated systemd unit via sudo: $SERVICE_NAME"
      fi
    fi
  fi

  if [[ "$daemon_reload_required" -eq 1 ]]; then
    if [[ "$EUID" -eq 0 ]]; then
      systemctl daemon-reload
    elif [[ "$can_sudo" -eq 1 ]]; then
      sudo -n systemctl daemon-reload
    fi
  fi

  if [[ "$EUID" -eq 0 ]]; then
    if ! systemctl status "$SERVICE_NAME" >/dev/null 2>&1; then
      log "Service $SERVICE_NAME is not installed, skipping restart"
      return
    fi
    systemctl restart "$SERVICE_NAME"
    local state="unknown"
    state="$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo unknown)"
    log "Service restarted: $SERVICE_NAME (state: $state)"
    return
  fi

  if [[ "$can_sudo" -eq 1 ]]; then
    if ! sudo -n systemctl status "$SERVICE_NAME" >/dev/null 2>&1; then
      log "Service $SERVICE_NAME is not installed, skipping restart"
      return
    fi
    sudo -n systemctl restart "$SERVICE_NAME"
    local state="unknown"
    state="$(sudo -n systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo unknown)"
    log "Service restarted via sudo: $SERVICE_NAME (state: $state)"
    return
  fi

  log "No root/sudo rights to restart $SERVICE_NAME"
  log "Run manually: sudo systemctl restart $SERVICE_NAME"
}

if [[ "$SKIP_NPM_INSTALL" != "1" ]]; then
  install_deps
else
  log "SKIP_NPM_INSTALL=1, skipping dependency install"
fi

npm run setup-hooks --silent || true

if [[ "$SKIP_MIGRATION" != "1" ]]; then
  log "Running database migrations"
  npm run migrate-db --silent
else
  log "SKIP_MIGRATION=1, skipping database migration"
fi

restart_service_linux

log "Sync completed"
