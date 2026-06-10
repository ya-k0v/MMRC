#!/bin/bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Этот скрипт нужно запускать с правами root (sudo)!"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

INSTALL_DIR="${INSTALL_DIR:-/var/lib/mmrc}"
SERVICE_NAME="${SERVICE_NAME:-videocontrol.service}"
SERVICE_USER="${SERVICE_USER:-vcuser}"
SERVICE_GROUP="${SERVICE_GROUP:-vcgroup}"

echo "[install] Source directory: $SOURCE_DIR"
echo "[install] Target directory: $INSTALL_DIR"

escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[\\/&]/\\\\&/g'
}

DB_TYPE="${DB_TYPE:-}"

install_dependencies() {
  apt-get update -qq
  apt-get install -y curl wget git build-essential ffmpeg libreoffice imagemagick graphicsmagick unzip sqlite3 nginx rsync adb netcat-openbsd

  local need_node=1
  if command -v node >/dev/null 2>&1; then
    local current_major
    current_major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ "$current_major" =~ ^[0-9]+$ ]] && [[ "$current_major" -ge 20 ]]; then
      need_node=0
    fi
  fi

  if [[ "$need_node" -eq 1 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi

  if ! command -v npm >/dev/null 2>&1; then
    apt-get install -y npm
  fi
}

ensure_service_account() {
  if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
    groupadd "$SERVICE_GROUP"
  fi

  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd -r -m -g "$SERVICE_GROUP" -d /home/$SERVICE_USER -s /usr/sbin/nologin "$SERVICE_USER"
  fi

  local service_home
  service_home="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
  if [[ -z "$service_home" ]] || [[ "$service_home" == "/" ]]; then
    service_home="/home/$SERVICE_USER"
  fi

  mkdir -p "$service_home/.android"
  touch "$service_home/.android/adb_usb.ini"
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$service_home"
  chmod 700 "$service_home" "$service_home/.android"
  chmod 600 "$service_home/.android/adb_usb.ini"
}

setup_database() {
  if [ -z "$DB_TYPE" ]; then
    echo ""
    echo "Select database type:"
    echo "  [1] SQLite (built-in, no setup required)"
    echo "  [2] PostgreSQL (via Docker)"
    read -p "Choose [1-2]: " -n 1 -r
    echo ""
    case "$REPLY" in
      1) DB_TYPE="sqlite" ;;
      2) DB_TYPE="postgres" ;;
      *) echo "Invalid choice, defaulting to SQLite"; DB_TYPE="sqlite" ;;
    esac
  fi

  export DB_TYPE

  if [ "$DB_TYPE" = "postgres" ]; then
    local DB_POSTGRES_PORT="${DB_POSTGRES_PORT:-5432}"
    local DB_POSTGRES_USER="${DB_POSTGRES_USER:-mmrc}"
    local DB_POSTGRES_PASSWORD="${DB_POSTGRES_PASSWORD:-}"
    local DB_POSTGRES_DB="${DB_POSTGRES_DB:-mmrc}"

    echo ""
    echo "[install] PostgreSQL setup via Docker..."

    # Install Docker if not present
    if ! command -v docker &> /dev/null; then
      echo "[install] Installing Docker..."
      curl -fsSL https://get.docker.com | bash
      systemctl enable docker
      systemctl start docker
      echo "[install] Docker installed"
    else
      echo "[install] Docker already installed"
    fi

    # Ask for credentials if not set
    if [ -z "$DB_POSTGRES_PASSWORD" ]; then
      read -p "PostgreSQL password [default: mmrc]: " DB_POSTGRES_PASSWORD_INPUT
      DB_POSTGRES_PASSWORD="${DB_POSTGRES_PASSWORD_INPUT:-mmrc}"
    fi

    # Store for .env generation
    export DB_POSTGRES_PORT DB_POSTGRES_USER DB_POSTGRES_PASSWORD DB_POSTGRES_DB

    # Pull and start PostgreSQL
    echo "[install] Pulling postgres:16-alpine..."
    docker pull postgres:16-alpine

    if docker ps -a --format '{{.Names}}' | grep -q '^mmrc-postgres$'; then
      echo "[install] Container mmrc-postgres exists, starting..."
      docker start mmrc-postgres || true
    else
      echo "[install] Starting PostgreSQL container..."
      docker run -d \
        --name mmrc-postgres \
        --restart unless-stopped \
        -p 127.0.0.1:${DB_POSTGRES_PORT}:5432 \
        -e POSTGRES_DB=${DB_POSTGRES_DB} \
        -e POSTGRES_USER=${DB_POSTGRES_USER} \
        -e POSTGRES_PASSWORD=${DB_POSTGRES_PASSWORD} \
        -v mmrc-pgdata:/var/lib/postgresql/data \
        postgres:16-alpine
    fi

    # Wait for PostgreSQL
    echo "[install] Waiting for PostgreSQL to be ready..."
    for i in {1..30}; do
      if docker exec mmrc-postgres pg_isready -U ${DB_POSTGRES_USER} >/dev/null 2>&1; then
        echo "[install] PostgreSQL is ready"
        break
      fi
      if [ "$i" -eq 30 ]; then
        echo "[install] ERROR: PostgreSQL failed to start"
        docker logs mmrc-postgres --tail 20
        exit 1
      fi
      sleep 2
    done

    echo "[install] PostgreSQL container running on 127.0.0.1:${DB_POSTGRES_PORT}"
  fi
}

sync_project() {
  mkdir -p "$INSTALL_DIR"

  if [[ "$SOURCE_DIR" != "$INSTALL_DIR" ]]; then
    if command -v rsync >/dev/null 2>&1; then
      rsync -a \
        --delete \
        --exclude='node_modules/' \
        --exclude='data/' \
        --exclude='config/main.db' \
        --exclude='config/main.db-*' \
        --exclude='config/hero/heroes.db' \
        --exclude='config/hero/heroes.db-*' \
        --exclude='.env' \
        "$SOURCE_DIR"/ "$INSTALL_DIR"/
    else
      cp -a "$SOURCE_DIR"/. "$INSTALL_DIR"/
    fi
  fi
}

prepare_runtime_files() {
  cd "$INSTALL_DIR"

  if [[ ! -f .env ]]; then
    cp .env.example .env
    local secret
    secret="$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")"
    sed -i "s|^JWT_SECRET=.*$|JWT_SECRET=$secret|" .env

    # Set database type
    sed -i "s|^# DB_TYPE=.*$|DB_TYPE=$DB_TYPE|" .env

    if [ "$DB_TYPE" = "postgres" ]; then
      sed -i "s|^# DB_HOST=.*$|DB_HOST=127.0.0.1|" .env
      sed -i "s|^# DB_PORT=.*$|DB_PORT=$DB_POSTGRES_PORT|" .env
      sed -i "s|^# DB_NAME=.*$|DB_NAME=$DB_POSTGRES_DB|" .env
      sed -i "s|^# DB_USER=.*$|DB_USER=$DB_POSTGRES_USER|" .env
      sed -i "s|^# DB_PASSWORD=.*$|DB_PASSWORD=$DB_POSTGRES_PASSWORD|" .env
    fi
  fi

  mkdir -p config config/hero data/content data/streams data/converted data/logs data/temp .tmp .tmp/db-import

  # Импорт БД пишет временные файлы в .tmp/db-import, поэтому директория
  # должна быть гарантированно доступна сервисному пользователю.
  chown -R "$SERVICE_USER:$SERVICE_GROUP" .tmp
  chmod 770 .tmp .tmp/db-import

  if [[ ! -f config/app-settings.json ]]; then
    cat > config/app-settings.json <<'EOF'
{
  "contentRoot": "data"
}
EOF
  else
    node --input-type=module <<'EOF'
import fs from 'fs';

const filePath = 'config/app-settings.json';
try {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw || '{}');
  const contentRoot = String(data?.contentRoot || '').trim();
  const localAbsoluteRoot = `${process.cwd()}/data`;
  if (!contentRoot || contentRoot.startsWith('/vid/videocontrol') || contentRoot === localAbsoluteRoot) {
    data.contentRoot = 'data';
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    console.log('[install] normalized contentRoot to "data"');
  }
} catch (error) {
  console.error('[install] failed to normalize app-settings.json', error?.message || String(error));
  process.exit(1);
}
EOF
  fi

  if [[ -f package-lock.json ]]; then
    npm ci --omit=dev || npm install
  else
    npm install
  fi
  npm run setup-hooks --silent || true
  # Если PostgreSQL — даем контейнеру время на инициализацию
  if [ "$DB_TYPE" = "postgres" ]; then
    sleep 3
  fi
  npm run migrate-db --silent

  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR"
  chmod 640 "$INSTALL_DIR/.env" || true
}

install_nginx_config() {
  local target_conf="/etc/nginx/sites-available/videocontrol"
  local escaped_install_dir
  escaped_install_dir="$(escape_sed_replacement "$INSTALL_DIR")"

  cp "$INSTALL_DIR/nginx/videocontrol-secure.conf" "$target_conf"
  if [[ "$INSTALL_DIR" != "/var/lib/mmrc" ]]; then
    sed -i "s#/var/lib/mmrc#${escaped_install_dir}#g" "$target_conf"
  fi

  rm -f /etc/nginx/sites-enabled/default
  ln -sf "$target_conf" /etc/nginx/sites-enabled/videocontrol
  nginx -t
  systemctl enable nginx
  systemctl restart nginx
}

install_service_unit() {
  local target_unit="/etc/systemd/system/$SERVICE_NAME"
  local tmp_unit
  local escaped_install_dir

  tmp_unit="$(mktemp)"
  escaped_install_dir="$(escape_sed_replacement "$INSTALL_DIR")"

  cp "$INSTALL_DIR/videocontrol.service" "$tmp_unit"
  if [[ "$INSTALL_DIR" != "/var/lib/mmrc" ]]; then
    sed -i "s#/var/lib/mmrc#${escaped_install_dir}#g" "$tmp_unit"
  fi

  if [ "$DB_TYPE" = "postgres" ]; then
    sed -i "s|^After=.*$|After=network-online.target local-fs.target docker.target|" "$tmp_unit"
    sed -i "/^After=/a Wants=docker.target" "$tmp_unit"
  fi

  install -m 644 "$tmp_unit" "$target_unit"
  rm -f "$tmp_unit"

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
}

install_dependencies
ensure_service_account
setup_database
sync_project
prepare_runtime_files
install_nginx_config
install_service_unit

systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,60p'
echo "[install] Complete"
