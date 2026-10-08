#!/usr/bin/env bash
set -e
# pipefail обязателен: без него `curl ... | bash` при обрыве сети отдаёт bash
# обрезанный скрипт, тот может отработать с кодом 0, и установка «пройдёт
# успешно», хотя ничего не установилось (см. mmrc.sh, тот же комментарий).
set -o pipefail

# MMRC One-Command Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/ya-k0v/MMRC/v340/install.sh | bash

# ========================
# Configuration
# ========================
MMRC_VERSION_INFO=$(curl -fsSL "https://raw.githubusercontent.com/ya-k0v/MMRC/v340/version.json" 2>/dev/null || echo '{"version":"3.4.0","branch":"v340","dockerTag":"v340","dockerImages":{"server":"pingwin1900/mmrc","converter":"pingwin1900/mmrc-converter","ffmpeg":"pingwin1900/mmrc-ffmpeg","streamer":"pingwin1900/mmrc-streamer"}}')
# version.json приходит pretty-printed ("version": "3.4.0" с пробелом после
# двоеточия) — грепаем с " *", терпимо к обоим форматам. При любом сбое парсинга
# (set -e + pipefail) откатываемся на дефолт, а не молча завершаем установку.
MMRC_VERSION=$(printf '%s' "$MMRC_VERSION_INFO" | grep -o '"version": *"[^"]*"' | head -n1 | cut -d'"' -f4) || MMRC_VERSION="3.4.0"
MMRC_BRANCH=$(printf '%s' "$MMRC_VERSION_INFO" | grep -o '"branch": *"[^"]*"' | head -n1 | cut -d'"' -f4) || MMRC_BRANCH="v340"
: "${MMRC_BRANCH:=v340}"
MMRC_DOCKER_TAG=$(printf '%s' "$MMRC_VERSION_INFO" | grep -o '"dockerTag": *"[^"]*"' | head -n1 | cut -d'"' -f4) || MMRC_DOCKER_TAG="v340"
: "${MMRC_DOCKER_TAG:=v340}"
MMRC_STREAMER_IMAGE=$(printf '%s' "$MMRC_VERSION_INFO" | grep -o '"streamer": *"[^"]*"' | head -n1 | cut -d'"' -f4) || MMRC_STREAMER_IMAGE="pingwin1900/mmrc-streamer"
MMRC_REPO="https://github.com/ya-k0v/MMRC"
MMRC_RAW="https://raw.githubusercontent.com/ya-k0v/MMRC/${MMRC_BRANCH}"
INSTALL_DIR="/opt/mmrc"
DATA_DIR="/var/lib/mmrc"
BIN_DIR="/usr/local/bin"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
ENV_FILE="$INSTALL_DIR/.env"

# ========================
# Colors
# ========================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

colorized_echo() {
    local color=$1
    local text=$2
    case $color in
        "red") printf "${RED}%s${NC}\n" "$text" ;;
        "green") printf "${GREEN}%s${NC}\n" "$text" ;;
        "yellow") printf "${YELLOW}%s${NC}\n" "$text" ;;
        "blue") printf "${BLUE}%s${NC}\n" "$text" ;;
        "cyan") printf "${CYAN}%s${NC}\n" "$text" ;;
        *) echo "$text" ;;
    esac
}

# Print a line within a 100-char-wide box with proper right-border alignment
box_line() {
    local content="$1"
    local box_width=100
    # Remove zero-width variation selectors (U+FE0F) for accurate counting
    local clean=$(printf '%s' "$content" | tr -d '\357\270\217')
    local char_count=${#clean}
    local byte_count=$(printf '%s' "$clean" | wc -c)
    local four_byte=$(( (byte_count - char_count) / 3 ))
    local display_width=$(( char_count + four_byte ))
    local pad=$((box_width - display_width))
    [ "$pad" -lt 0 ] && pad=0
    printf "${CYAN}║ %s%${pad}s║${NC}\n" "$content" ""
}

info() { colorized_echo blue "  $1"; }
success() { colorized_echo green "✔ $1"; }
warn() { colorized_echo yellow "⚠ $1"; }
error() { colorized_echo red "✖ $1"; }

# ========================
# TTY-чтение и сохранение конфигурации
# ========================

# Читает строку с TTY. Без терминала (cron/CI/ssh без -t) не падает с
# «No such device or address», а честно отказывается выполнять шаг.
# Для обязательных вводов (выбор БД, путь, пароль) это заставляет задать
# переменные окружения; для необязательных y/N-промптов используйте ask_yes_no.
read_from_tty() {
    local prompt="$1"
    local reply=""
    if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
        read -r -p "$prompt" reply < /dev/tty || reply=""
        echo ""
    else
        error "Interactive input required (no TTY available)."
        printf '  Set the corresponding environment variables (DB_TYPE, STORAGE_BACKEND, NGINX_HTTP_PORT, NGINX_HTTPS_PORT, CONTENT_DIR) and re-run.\n' >&2
        return 1
    fi
    printf '%s' "${reply:-}"
}

# Скрытый ввод пароля с TTY.
read_secret_from_tty() {
    local prompt="$1"
    local reply=""
    if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
        read -r -s -p "$prompt" reply < /dev/tty || reply=""
        echo ""
    else
        error "Interactive input required (no TTY available)."
        return 1
    fi
    printf '%s' "${reply:-}"
}

# y/N-промпт: без TTY отвечает «нет» (подходит для CI/скриптов —
# необязательные шаги не блокируют установку).
ask_yes_no() {
    local prompt="$1"
    local reply="n"
    if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
        read -r -p "$prompt" reply < /dev/tty || reply="n"
        echo ""
    fi
    printf '%s' "$reply"
}

# Читает переменную из существующего .env (режим повторной установки).
read_existing_env() {
    local key="$1"
    local default="${2:-}"
    local value
    value=$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- \
        | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/") || true
    [ -n "$value" ] && printf '%s' "$value" || printf '%s' "$default"
}

# Обновляет значение ключа в .env или дописывает его в конец. Замена через awk,
# а не sed: значение (пароль с #, &, |, /) подставляется как переменная, без
# интерпретации спецсимволов в pattern/replacement.
replace_or_append_env() {
    local key="$1"
    local value="$2"
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
        awk -v k="$key" -v v="$value" '
            BEGIN { done = 0 }
            {
                if (!done && $0 ~ "^" k "=") { print k "=" v; done = 1; next }
                print
            }
            END { if (!done) print k "=" v }
        ' "$ENV_FILE" > "${ENV_FILE}.mmrc-tmp" && mv "${ENV_FILE}.mmrc-tmp" "$ENV_FILE"
    else
        echo "${key}=${value}" >> "$ENV_FILE"
    fi
}

# ========================
# Pre-flight checks
# ========================

check_root() {
    if [ "$(id -u)" != "0" ]; then
        error "This script must be run as root."
        echo "Run: sudo curl -fsSL $MMRC_RAW/install.sh | bash"
        exit 1
    fi
}

check_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        colorized_echo yellow "  Docker not found. Installing..."
        echo ""

        # Try to download installer
        colorized_echo blue "  Downloading Docker installer..."
        local TMP_SCRIPT=$(mktemp /tmp/get-docker.XXXXXX.sh)
        if ! curl -fsSL --connect-timeout 10 --max-time 120 https://get.docker.com -o "$TMP_SCRIPT" 2>&1; then
            error "Failed to download Docker installer. Check your internet connection."
            rm -f "$TMP_SCRIPT"
            exit 1
        fi
        success "Installer downloaded"

        # Run installation
        echo ""
        echo "  [🐳 Docker Installation]"
        echo "  ─────────────────────────"

        local install_output
        if ! install_output=$(sh "$TMP_SCRIPT" 2>&1); then
            error "Docker installation failed!"
            echo "$install_output"
            rm -f "$TMP_SCRIPT"
            exit 1
        fi
        rm -f "$TMP_SCRIPT"

        # Verify Docker was installed
        if ! command -v docker >/dev/null 2>&1; then
            error "Docker command not found after installation. Try installing manually: https://docs.docker.com/engine/install/"
            exit 1
        fi
        success "Docker installed: $(docker --version)"

        # Start Docker service
        if ! docker info >/dev/null 2>&1; then
            info "Starting Docker service..."
            systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true
            sleep 2
        fi
    else
        success "Docker found: $(docker --version)"
    fi

    if docker compose version >/dev/null 2>&1; then
        COMPOSE='docker compose'
    elif docker-compose version >/dev/null 2>&1; then
        COMPOSE='docker-compose'
    else
        error "Docker Compose not found."
        exit 1
    fi
    success "Docker Compose available"
}

# ========================
# Database Selection
# ========================

select_database() {
    DB_TYPE="${DB_TYPE:-}"

    if [ -z "$DB_TYPE" ]; then
        echo ""
        colorized_echo yellow "🗄️ Select database type:"
        echo "  [1] SQLite (built-in, no setup required)"
        echo "  [2] PostgreSQL (via Docker, separate container)"
        db_choice=$(read_from_tty "  Choose [1-2]: ") || exit 1
        case "$db_choice" in
            2) DB_TYPE="postgres" ;;
            *) DB_TYPE="sqlite" ;;
        esac
    fi

    # PostgreSQL connection defaults. Пароль НЕ префолтим на «mmrc»:
    # для существующей внешней БД он обязателен и запрашивается ниже,
    # а дефолт появляется только в сценарии «создать контейнер Docker».
    DB_POSTGRES_HOST="${DB_POSTGRES_HOST:-mmrc-postgres}"
    DB_POSTGRES_PORT="${DB_POSTGRES_PORT:-5432}"
    DB_POSTGRES_USER="${DB_POSTGRES_USER:-mmrc}"
    DB_POSTGRES_PASSWORD="${DB_POSTGRES_PASSWORD:-}"
    DB_POSTGRES_DB="${DB_POSTGRES_DB:-mmrc}"

    if [ "$DB_TYPE" = "postgres" ]; then
        echo ""
        colorized_echo blue "PostgreSQL setup..."

        POSTGRES_SOURCE="${POSTGRES_SOURCE:-}"

        if [ -z "$POSTGRES_SOURCE" ]; then
            echo ""
            echo "  Select PostgreSQL setup method:"
            echo "    [1] Create new Docker container (recommended)"
            echo "    [2] Use existing PostgreSQL database"
            pg_choice=$(read_from_tty "  Choose [1-2]: ") || exit 1
            case "$pg_choice" in
                2) POSTGRES_SOURCE="existing" ;;
                *) POSTGRES_SOURCE="docker" ;;
            esac
        fi

        if [ "$POSTGRES_SOURCE" = "existing" ]; then
            echo "  Using existing PostgreSQL database..."
            pg_host_input=$(read_from_tty "  PostgreSQL host [$DB_POSTGRES_HOST]: ") || exit 1
            DB_POSTGRES_HOST="${pg_host_input:-$DB_POSTGRES_HOST}"
            pg_port_input=$(read_from_tty "  PostgreSQL port [$DB_POSTGRES_PORT]: ") || exit 1
            DB_POSTGRES_PORT="${pg_port_input:-$DB_POSTGRES_PORT}"
            pg_db_input=$(read_from_tty "  PostgreSQL database name [$DB_POSTGRES_DB]: ") || exit 1
            DB_POSTGRES_DB="${pg_db_input:-$DB_POSTGRES_DB}"
            pg_user_input=$(read_from_tty "  PostgreSQL user [$DB_POSTGRES_USER]: ") || exit 1
            DB_POSTGRES_USER="${pg_user_input:-$DB_POSTGRES_USER}"
            while [ -z "$DB_POSTGRES_PASSWORD" ]; do
                pg_pass_input=$(read_secret_from_tty "  PostgreSQL password (required): ") || exit 1
                DB_POSTGRES_PASSWORD="${pg_pass_input:-}"
                if [ -z "$DB_POSTGRES_PASSWORD" ]; then
                    echo "  Password cannot be empty!"
                fi
            done
            success "Using existing PostgreSQL at ${DB_POSTGRES_HOST}:${DB_POSTGRES_PORT}/${DB_POSTGRES_DB}"
        else
            echo "  Setting up PostgreSQL via Docker..."
            DB_POSTGRES_PASSWORD="${DB_POSTGRES_PASSWORD:-mmrc}"
            warn "PostgreSQL password set to default 'mmrc' — change it via DB_POSTGRES_PASSWORD in $ENV_FILE after install."
            if [ -z "$DB_POSTGRES_PASSWORD" ]; then
                DB_POSTGRES_PASSWORD="mmrc"
                warn "Using default password: mmrc"
            fi
            success "PostgreSQL will be started as Docker container mmrc-postgres"
        fi
    fi
}

# ========================
# Storage Selection
# ========================

select_storage() {
    STORAGE_BACKEND="${STORAGE_BACKEND:-local}"
    S3_ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"
    S3_SECRET_KEY="${S3_SECRET_KEY:-minioadmin}"

    if [ "$DB_TYPE" != "postgres" ]; then
        return
    fi

    if [ "$STORAGE_BACKEND" = "local" ]; then
        if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
            echo ""
            colorized_echo yellow "💾 Select storage backend:"
            echo "  [1] Local filesystem (built-in, no setup required)"
            echo "  [2] S3/MinIO (via Docker, separate container)"
            read -r -p "  Choose [1-2]: " s3_choice < /dev/tty || s3_choice=""
            echo ""
        fi
        case "$s3_choice" in
            2) STORAGE_BACKEND="s3" ;;
            *) STORAGE_BACKEND="local" ;;
        esac
    fi

    S3_ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"
    S3_SECRET_KEY="${S3_SECRET_KEY:-minioadmin}"
}

# ========================
# Service Credentials
# ========================

setup_credentials() {
    echo ""
    colorized_echo cyan "🔐 Service Credentials"
    echo ""
    echo "Set login/password for services (MinIO, Database)"
    echo "Press Enter to use defaults"
    echo ""

    # MinIO/S3 credentials
    if [ "$STORAGE_BACKEND" = "s3" ]; then
        s3_key=$(read_from_tty "  MinIO access key [minioadmin]: ") || exit 1
        S3_ACCESS_KEY="${s3_key:-minioadmin}"
        s3_secret=$(read_from_tty "  MinIO secret key [minioadmin]: ") || exit 1
        S3_SECRET_KEY="${s3_secret:-minioadmin}"
    fi

    # Пароль PostgreSQL уже выставлен в select_database: для существующей БД —
    # запрошен как обязательный, для нового Docker-контейнера — дефолт «mmrc»
    # с предупреждением (переопределяется через DB_POSTGRES_PASSWORD).
}

check_port_available() {
    local port=$1
    if ss -tlnp 2>/dev/null | grep -q ":${port} " || \
       netstat -tlnp 2>/dev/null | grep -q ":${port} "; then
        return 1
    fi
    return 0
}

show_port_usage() {
    local port=$1
    local using
    using=$(ss -tlnp 2>/dev/null | grep ":${port} " || \
            netstat -tlnp 2>/dev/null | grep ":${port} " || true)
    if [ -n "$using" ]; then
        echo "$using" | sed 's/^/    /'
    fi
}

select_port() {
    NGINX_HTTP_PORT="${NGINX_HTTP_PORT:-80}"
    NGINX_HTTPS_PORT="${NGINX_HTTPS_PORT:-443}"

    # Порт задан окружением (CI/скрипт/автоустановка) — не переспрашиваем,
    # только проверяем доступность и не даём стартовать с занятым портом.
    if [ -n "${PORTS_FROM_ENV:-}" ]; then
        if ! check_port_available "$NGINX_HTTP_PORT"; then
            error "Port $NGINX_HTTP_PORT (NGINX_HTTP_PORT) is already in use:"
            show_port_usage "$NGINX_HTTP_PORT"
            exit 1
        fi
        if ! check_port_available "$NGINX_HTTPS_PORT"; then
            error "Port $NGINX_HTTPS_PORT (NGINX_HTTPS_PORT) is already in use:"
            show_port_usage "$NGINX_HTTPS_PORT"
            exit 1
        fi
        success "Using HTTP port: $NGINX_HTTP_PORT"
        success "Using HTTPS port: $NGINX_HTTPS_PORT"
        return
    fi

    # Check HTTP port
    if ! check_port_available "$NGINX_HTTP_PORT"; then
        warn "Port $NGINX_HTTP_PORT is already in use!"
        echo ""
        echo "  Services using port $NGINX_HTTP_PORT:"
        show_port_usage "$NGINX_HTTP_PORT"
        echo ""
    fi

    while true; do
        port_input=$(read_from_tty "  HTTP port [$NGINX_HTTP_PORT]: ") || exit 1
        NGINX_HTTP_PORT="${port_input:-$NGINX_HTTP_PORT}"

        if check_port_available "$NGINX_HTTP_PORT"; then
            break
        else
            warn "Port $NGINX_HTTP_PORT is still in use. Try another port."
        fi
    done
    success "Using HTTP port: $NGINX_HTTP_PORT"

    # Check HTTPS port
    if ! check_port_available "$NGINX_HTTPS_PORT"; then
        warn "Port $NGINX_HTTPS_PORT is already in use!"
        echo ""
        echo "  Services using port $NGINX_HTTPS_PORT:"
        show_port_usage "$NGINX_HTTPS_PORT"
        echo ""
    fi

    while true; do
        port_input=$(read_from_tty "  HTTPS port [$NGINX_HTTPS_PORT]: ") || exit 1
        NGINX_HTTPS_PORT="${port_input:-$NGINX_HTTPS_PORT}"

        if check_port_available "$NGINX_HTTPS_PORT"; then
            break
        else
            warn "Port $NGINX_HTTPS_PORT is still in use. Try another port."
        fi
    done
    success "Using HTTPS port: $NGINX_HTTPS_PORT"
}

# ========================
# Installation
# ========================

install_mmrc() {
    check_root
    check_docker

    # Install CLI first (so it's available even if later steps fail)
    info "Installing MMRC CLI..."
    curl -fSL -o "$BIN_DIR/mmrc" "$MMRC_RAW/mmrc.sh"
    chmod +x "$BIN_DIR/mmrc"
    success "CLI installed: mmrc"

    # Unset Docker Compose env vars that could interfere
    # (COMPOSE_FILE is a script-local variable, not just an env var, so skip it)
    unset COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_PATH_SEPARATOR 2>/dev/null || true

    # Ensure consistent working directory (fixes 'getcwd' errors with curl|sudo bash)
    cd /

    colorized_echo cyan "
══════════════════════════════════════════
          📺 MMRC Installer               
     Media Management & Remote Control    
           Version ${MMRC_VERSION:-3.4.0}                
══════════════════════════════════════════
"

    # ===== Переустановка: сохраняем существующую конфигурацию =====
    # mmrc reinstall повторно запускает этот скрипт. Начисто переписывать
    # .env нельзя: пропадут кастомные порты, креды внешней PostgreSQL, путь к
    # медиа, секреты. Поэтому: бэкапим .env, дальше в REINSTALL-режиме
    # значения берутся из старого файла, а промпты пропускаются.
    REINSTALL=0
    if [ -f "$ENV_FILE" ]; then
        REINSTALL=1
        local backup_ts
        backup_ts=$(date +%Y%m%d-%H%M%S)
        cp -a "$ENV_FILE" "${ENV_FILE}.bak.${backup_ts}"
        success "Existing configuration found — backup: ${ENV_FILE}.bak.${backup_ts}"
    fi

    # Порт, заданный окружением (CI/скрипт) — не переспрашиваем в select_port.
    PORTS_FROM_ENV=""
    if [ -n "${NGINX_HTTP_PORT:-}" ] || [ -n "${NGINX_HTTPS_PORT:-}" ]; then
        PORTS_FROM_ENV="1"
    fi

    if [ "$REINSTALL" = "1" ]; then
        info "Reinstall: preserving existing $ENV_FILE"
    else
        # Select database type first
        select_database

        # Select storage backend
        select_storage

        # Ask for service credentials
        setup_credentials

        # Select HTTP port
        select_port
    fi

    # Create directories
    mkdir -p "$INSTALL_DIR" "$DATA_DIR"
    success "Directories created"

    # Download docker-compose.yml with progress
    info "Downloading docker-compose.yml..."
    info "  URL: $MMRC_RAW/docker-compose.deploy.yml"
    curl -fSL -o "$COMPOSE_FILE" "$MMRC_RAW/docker-compose.deploy.yml"

    # Validate the downloaded file
    local compose_size
    compose_size=$(stat -c%s "$COMPOSE_FILE" 2>/dev/null || stat -f%z "$COMPOSE_FILE" 2>/dev/null || wc -c < "$COMPOSE_FILE")
    if [ "$compose_size" -lt 100 ]; then
        echo ""
        warn "Downloaded file is only $compose_size bytes (expected ~3KB)"
        warn "Content: $(head -c 100 "$COMPOSE_FILE")"
        warn "MMRC_BRANCH='${MMRC_BRANCH:-<empty>}' MMRC_RAW='$MMRC_RAW'"
        warn "Check version.json at: https://raw.githubusercontent.com/ya-k0v/MMRC/v340/version.json"
        warn "Expected compose URL: https://raw.githubusercontent.com/ya-k0v/MMRC/v340/docker-compose.deploy.yml"
        error "Download failed. Check internet connection and try again."
        exit 1
    fi
    success "docker-compose.yml downloaded ($compose_size bytes)"

    # Generate .env
    info "Generating configuration..."

    # Автоподбор CPU-лимита для mmrc: ядра хоста минус запас 2 (минимум 1),
    # чтобы ffmpeg при конвертации не «заморозил» остальные контейнеры и сам хост.
    if [ -z "${MMRC_CPU_LIMIT:-}" ]; then
      MMRC_CPU_LIMIT=1
      if command -v nproc >/dev/null 2>&1; then
        DETECTED_CORES=$(nproc)
        [ -n "$DETECTED_CORES" ] && [ "$DETECTED_CORES" -gt 3 ] 2>/dev/null && MMRC_CPU_LIMIT=$((DETECTED_CORES - 2))
      fi
    fi
    MMRC_MEMORY_LIMIT="${MMRC_MEMORY_LIMIT:-4G}"
    MMRC_PIDS_LIMIT="${MMRC_PIDS_LIMIT:-512}"

    if [ "$REINSTALL" = "1" ]; then
        # ===== Переустановка: .env не трогаем целиком, только обновляем
        # нужные ключи, остальное (LDAP, CORS, кастомные настройки) сохраняется.
        DB_TYPE="$(read_existing_env "DB_TYPE" "")"
        STORAGE_BACKEND="$(read_existing_env "STORAGE_BACKEND" "local")"
        DB_POSTGRES_HOST="$(read_existing_env "DB_HOST" "mmrc-postgres")"
        DB_POSTGRES_PORT="$(read_existing_env "DB_PORT" "5432")"
        DB_POSTGRES_DB="$(read_existing_env "DB_NAME" "mmrc")"
        DB_POSTGRES_USER="$(read_existing_env "DB_USER" "mmrc")"
        DB_POSTGRES_PASSWORD="$(read_existing_env "DB_PASSWORD" "")"
        S3_ACCESS_KEY="$(read_existing_env "S3_ACCESS_KEY" "minioadmin")"
        S3_SECRET_KEY="$(read_existing_env "S3_SECRET_KEY" "minioadmin")"
        MMRC_STREAMER_ENABLED="$(read_existing_env "MMRC_STREAMER_ENABLED" "false")"
        content_dir="$(read_existing_env "CONTENT_DIR" "$INSTALL_DIR/data")"
        MMRC_CPU_LIMIT="$(read_existing_env "MMRC_CPU_LIMIT" "$MMRC_CPU_LIMIT")"
        MMRC_MEMORY_LIMIT="$(read_existing_env "MMRC_MEMORY_LIMIT" "$MMRC_MEMORY_LIMIT")"
        MMRC_PIDS_LIMIT="$(read_existing_env "MMRC_PIDS_LIMIT" "$MMRC_PIDS_LIMIT")"

        JWT_SECRET="$(read_existing_env "JWT_SECRET" "")"
        REDIS_PASSWORD_GEN="$(read_existing_env "REDIS_PASSWORD" "")"
        if [ -z "$JWT_SECRET" ]; then
            JWT_SECRET=$(openssl rand -hex 64)
        fi
        if [ -z "$REDIS_PASSWORD_GEN" ]; then
            REDIS_PASSWORD_GEN=$(openssl rand -hex 32)
        fi
        if [ "$DB_TYPE" = "postgres" ]; then
            POSTGRES_SOURCE="$(read_existing_env "POSTGRES_SOURCE" "")"
            if [ -z "$POSTGRES_SOURCE" ]; then
                if [ "$DB_POSTGRES_HOST" = "mmrc-postgres" ]; then
                    POSTGRES_SOURCE="docker"
                else
                    POSTGRES_SOURCE="existing"
                fi
            fi
            replace_or_append_env "POSTGRES_SOURCE" "$POSTGRES_SOURCE"
        fi

        NGINX_HTTP_PORT="$(read_existing_env "NGINX_HTTP_PORT" "80")"
        NGINX_HTTPS_PORT="$(read_existing_env "NGINX_HTTPS_PORT" "443")"
        replace_or_append_env "NGINX_HTTP_PORT" "$NGINX_HTTP_PORT"
        replace_or_append_env "NGINX_HTTPS_PORT" "$NGINX_HTTPS_PORT"
        replace_or_append_env "DB_TYPE" "$DB_TYPE"
        replace_or_append_env "STORAGE_BACKEND" "$STORAGE_BACKEND"
        replace_or_append_env "JWT_SECRET" "$JWT_SECRET"
        replace_or_append_env "REDIS_PASSWORD" "$REDIS_PASSWORD_GEN"
        replace_or_append_env "REDIS_URL" "redis://:${REDIS_PASSWORD_GEN}@mmrc-redis:6379"
        replace_or_append_env "MMRC_CPU_LIMIT" "$MMRC_CPU_LIMIT"
        replace_or_append_env "MMRC_MEMORY_LIMIT" "$MMRC_MEMORY_LIMIT"
        replace_or_append_env "MMRC_PIDS_LIMIT" "$MMRC_PIDS_LIMIT"
        replace_or_append_env "MMRC_STREAMER_ENABLED" "$MMRC_STREAMER_ENABLED"
        replace_or_append_env "CONTENT_DIR" "$content_dir"
        replace_or_append_env "HOST_DATA_DIR" "$content_dir"
        success "Configuration preserved (backup in $ENV_FILE.bak.*)"
    else
        # ===== Новая установка: генерируем .env с нуля =====
        JWT_SECRET=$(openssl rand -hex 64)
        REDIS_PASSWORD_GEN=$(openssl rand -hex 32)
        cat > "$ENV_FILE" << ENVEOF
# MMRC Configuration
# Generated on $(date)

NODE_ENV=production
LOG_LEVEL=info
SILENT_CONSOLE=false

# JWT Authentication
JWT_ACCESS_EXPIRES_IN=12h
JWT_REFRESH_EXPIRES_IN=30d

# HTTP Port
NGINX_HTTP_PORT=$NGINX_HTTP_PORT
NGINX_HTTPS_PORT=$NGINX_HTTPS_PORT

# Database type: sqlite | postgres
DB_TYPE=$DB_TYPE
ENVEOF
        echo "JWT_SECRET=$JWT_SECRET" >> "$ENV_FILE"

        cat >> "$ENV_FILE" << ENVEOF2
# Database connection (SQLite ignores host/port/user/password)
DB_HOST=mmrc-postgres
DB_PORT=5432
DB_NAME=mmrc
DB_USER=mmrc
DB_PASSWORD=${DB_POSTGRES_PASSWORD:-mmrc}

WAL_CHECKPOINT_INTERVAL_MS=300000

# Night Optimization
NIGHT_OPT_START_HOUR=1
NIGHT_OPT_END_HOUR=5

# Resource Limits
# MMRC_CPU_LIMIT — максимально число ядер, которое может занять контейнер mmrc
# при обработке видео (ffmpeg). Подбирается автоматически: ядра хоста минус 2
# (минимум 1). Для переопределения укажите MMRC_CPU_LIMIT перед запуском скрипта.
MMRC_CPU_LIMIT=$MMRC_CPU_LIMIT
MMRC_MEMORY_LIMIT=$MMRC_MEMORY_LIMIT
MMRC_PIDS_LIMIT=$MMRC_PIDS_LIMIT
JOB_RESERVE_CPU_PERCENT=30
JOB_RESERVE_MEMORY_MB=2048

STREAM_MAX_JOBS=100
STREAM_IDLE_TIMEOUT_MS=180000

# Content Storage (project dir by default)
CONTENT_DIR=/opt/mmrc/data
HOST_DATA_DIR=/opt/mmrc/data

# Docker sibling containers
MMRC_DOCKER=1
MMRC_COMPOSE_DIR=/host
DOCKER_IMAGE=pingwin1900/mmrc
DOCKER_IMAGE_TAG=${MMRC_DOCKER_TAG:-v340}
CONVERTER_IMAGE=pingwin1900/mmrc-converter
FFMPEG_IMAGE=pingwin1900/mmrc-ffmpeg
STREAMER_IMAGE=pingwin1900/mmrc-streamer
MMRC_STREAMER_ENABLED=false

# Redis
REDIS_PASSWORD=$REDIS_PASSWORD_GEN
REDIS_URL=redis://:${REDIS_PASSWORD_GEN}@mmrc-redis:6379

# Storage Backend: local | s3
STORAGE_BACKEND=$STORAGE_BACKEND
S3_ENDPOINT=http://mmrc-minio:9000
S3_REGION=us-east-1
S3_BUCKET=mmrc
S3_ACCESS_KEY=$S3_ACCESS_KEY
S3_SECRET_KEY=$S3_SECRET_KEY
S3_FORCE_PATH_STYLE=true

# MinIO root credentials (must match S3_ACCESS_KEY/S3_SECRET_KEY)
MINIO_ROOT_USER=$S3_ACCESS_KEY
MINIO_ROOT_PASSWORD=$S3_SECRET_KEY
MINIO_IMAGE=${MINIO_IMAGE:-pingwin1900/mmrc:minio-$MMRC_DOCKER_TAG}
MINIO_MC_IMAGE=${MINIO_MC_IMAGE:-pingwin1900/mmrc:minio-$MMRC_DOCKER_TAG}

# LDAP (optional)
LDAP_URL=
LDAP_BIND_DN=
LDAP_BASE_DN=

# Socket.IO CORS (optional, пусто = разрешены все origins)
MMRC_CORS_ORIGINS=

# Android (ADB) (optional)
MMRC_ANDROID_PACKAGE=com.videocontrol.mediaplayer
MMRC_ANDROID_ACTIVITY=com.videocontrol.mediaplayer.MainActivity
MMRC_ADB_PORT=5555
MMRC_APK_UPLOAD_DIR=/tmp/mmrc-apk-upload
ENVEOF2

        if [ "$DB_TYPE" = "postgres" ]; then
            cat >> "$ENV_FILE" << ENVEOF3

# PostgreSQL connection (overrides above)
DB_HOST=$DB_POSTGRES_HOST
DB_PORT=$DB_POSTGRES_PORT
DB_NAME=$DB_POSTGRES_DB
DB_USER=$DB_POSTGRES_USER
DB_PASSWORD=${DB_POSTGRES_PASSWORD:-mmrc}
POSTGRES_SOURCE=$POSTGRES_SOURCE
ENVEOF3
        fi
        success "Configuration generated"
    fi

    # Ask for content directory (reads from terminal, not stdin pipe).
    # CONTENT_DIR из окружения = неинтерактивный режим.
    content_dir="${CONTENT_DIR:-}"
    if [ -z "$content_dir" ]; then
        echo ""
        colorized_echo yellow "📁 Where do you want to store media content?"
        echo ""
        echo "  Default: project directory ($INSTALL_DIR/data)"
        echo "  External disk: /mnt/mmrc-content"
        echo "  Custom path: /your/path"
        echo ""
        while [ -z "$content_dir" ]; do
            content_dir=$(read_from_tty "  Enter path [default: project dir]: ") || exit 1
            if [ -z "$content_dir" ]; then
                content_dir="$INSTALL_DIR/data"
            fi
        done
    else
        success "Content directory: $content_dir"
    fi

    sed -i "s|^CONTENT_DIR=.*|CONTENT_DIR=${content_dir}|" "$ENV_FILE"
    sed -i "s|^HOST_DATA_DIR=.*|HOST_DATA_DIR=${content_dir}|" "$ENV_FILE"
    mkdir -p "$content_dir"/{db,content,streams,converted/trailers,logs,temp,hero}
    if [ "$STORAGE_BACKEND" = "s3" ]; then
        mkdir -p "$content_dir/minio"
    fi
    chown -R 1001:1001 "$content_dir" 2>/dev/null || true

    # Init HA vars
    COMPOSE_HA=""
    HA_SCALE=""

    # HA + Streamer: при переустановке восстанавливаем из прежней конфигурации
    if [ "$REINSTALL" = "1" ]; then
        if [ -f "$INSTALL_DIR/docker-compose.ha.yml" ] && [ "$DB_TYPE" = "postgres" ]; then
            COMPOSE_HA="-f docker-compose.yml -f docker-compose.ha.yml"
            HA_REPLICAS=$(docker ps --filter "name=mmrc-replica" --format "{{.Names}}" 2>/dev/null | wc -l)
            if ! [[ "$HA_REPLICAS" =~ ^[0-9]+$ ]] || [ "$HA_REPLICAS" -lt 1 ]; then
                HA_REPLICAS=1
            fi
            HA_SCALE="--scale mmrc-replica=$HA_REPLICAS"
            success "HA restored with $HA_REPLICAS replica(s)"
        fi
        # Streamer: значение уже загружено в STREAMER_ENABLED ниже из .env
    elif [ "$DB_TYPE" = "postgres" ] && [ "$STORAGE_BACKEND" = "s3" ]; then
        echo ""
        colorized_echo yellow "🏗️ Enable High-Availability (multiple server replicas)?"
        echo "  Runs 2+ server instances behind an nginx load balancer."
        echo "  Requires PostgreSQL + S3 (already selected)."
        ha_choice=$(ask_yes_no "  Enable HA? [y/N]: ")
        if [[ "$ha_choice" =~ ^[Yy]$ ]]; then
            HA_ENABLED=true
            HA_REPLICAS=""
            while [ -z "$HA_REPLICAS" ] || [ "$HA_REPLICAS" -lt 1 ] 2>/dev/null; do
                ha_replicas_input=$(read_from_tty "  Number of replicas [2]: ") || exit 1
                ha_replicas_input="${ha_replicas_input:-2}"
                if [ "$ha_replicas_input" -ge 1 ] 2>/dev/null; then
                    HA_REPLICAS=$ha_replicas_input
                fi
            done

            info "Downloading HA configuration..."
            local ha_retry=0
            while [ $ha_retry -lt 3 ]; do
                if curl -fSL --connect-timeout 10 --max-time 30 -o "$INSTALL_DIR/docker-compose.ha.yml" \
                    "$MMRC_RAW/docker-compose.ha.yml" 2>/dev/null; then
                    break
                fi
                ha_retry=$((ha_retry + 1))
                if [ $ha_retry -lt 3 ]; then
                    warn "Download failed (attempt ${ha_retry}/3), retrying..."
                    sleep 3
                else
                    error "Failed to download docker-compose.ha.yml after 3 attempts"
                    exit 1
                fi
            done
            mkdir -p "$INSTALL_DIR/docker/nginx"
            ha_retry=0
            while [ $ha_retry -lt 3 ]; do
                if curl -fSL --connect-timeout 10 --max-time 30 -o "$INSTALL_DIR/docker/nginx/ha-lb.conf" \
                    "$MMRC_RAW/docker/nginx/ha-lb.conf" 2>/dev/null; then
                    break
                fi
                ha_retry=$((ha_retry + 1))
                if [ $ha_retry -lt 3 ]; then
                    warn "Download failed (attempt ${ha_retry}/3), retrying..."
                    sleep 3
                else
                    error "Failed to download ha-lb.conf after 3 attempts"
                    exit 1
                fi
            done
            success "HA configuration downloaded"

            COMPOSE_HA="-f docker-compose.yml -f docker-compose.ha.yml"
            HA_SCALE="--scale mmrc-replica=$HA_REPLICAS"
            success "HA enabled with $HA_REPLICAS replicas"
        fi
    fi

    # Ask about Streamer (remote FFmpeg)
    STREAMER_ENABLED=false
    if [ "$REINSTALL" = "1" ]; then
        # Значение восстановлено ранее из .env (MMRC_STREAMER_ENABLED)
        [ "$MMRC_STREAMER_ENABLED" = "true" ] && STREAMER_ENABLED=true
        if [ "$STREAMER_ENABLED" = "true" ]; then
            success "Streamer kept enabled"
        fi
    else
        echo ""
        colorized_echo yellow "🎥 Enable Streamer (remote FFmpeg for HLS streaming)?"
        echo "  This runs FFmpeg in a separate container for better isolation."
        echo "  Default: disabled"
        streamer_choice=$(ask_yes_no "  Enable Streamer? [y/N]: ")
        if [[ "$streamer_choice" =~ ^[Yy]$ ]]; then
            STREAMER_ENABLED=true
            sed -i "s|^MMRC_STREAMER_ENABLED=.*|MMRC_STREAMER_ENABLED=true|" "$ENV_FILE"
            success "Streamer enabled"
        fi
    fi

    # Validate compose config before pulling
    echo ""
    info "Validating Docker Compose configuration..."
    cd "$INSTALL_DIR"
    if ! $COMPOSE $COMPOSE_HA config > /dev/null 2>&1; then
        echo ""
        warn "Compose validation failed. Checking configuration..."
        warn "Files in $INSTALL_DIR:"
        ls -la "$INSTALL_DIR" 2>&1 | sed 's/^/  /'
        echo ""
        warn "Docker Compose env vars:"
        env | grep -i compose 2>/dev/null | sed 's/^/  /' || echo "  (none)"
        echo ""
        # Try to get detailed error
        $COMPOSE $COMPOSE_HA config 2>&1 || true
        echo ""
        error "Docker Compose configuration is invalid. Please check the files above."
        error "If you have a docker-compose.override.yml file, remove it and try again."
        exit 1
    fi
    success "Compose configuration valid"

    # Pull images with progress
    echo ""
    info "Pulling Docker images..."
    $COMPOSE $COMPOSE_HA pull
    docker pull "pingwin1900/mmrc-converter:${MMRC_DOCKER_TAG}" 2>/dev/null || warn "Converter image not available (non-critical)"
    docker pull "pingwin1900/mmrc-ffmpeg:${MMRC_DOCKER_TAG}" 2>/dev/null || warn "FFmpeg image not available (non-critical)"
    if [ "$STREAMER_ENABLED" = "true" ]; then
        docker pull "${MMRC_STREAMER_IMAGE}:${MMRC_DOCKER_TAG}" 2>/dev/null || warn "Streamer image not available (non-critical)"
    fi
    success "Images pulled"

    # Start services with progress
    info "Starting MMRC services..."
    PROFILES=""
    if [ "$DB_TYPE" = "postgres" ] && [ "$POSTGRES_SOURCE" = "docker" ]; then
        PROFILES="--profile postgres"
    fi
    if [ "$STORAGE_BACKEND" = "s3" ]; then
        PROFILES="$PROFILES --profile s3"
    fi
    if [ "$STREAMER_ENABLED" = "true" ]; then
        PROFILES="$PROFILES --profile streamer"
    fi
    if [ -n "$COMPOSE_HA" ]; then
        PROFILES="$PROFILES --profile ha"
    fi

    if $COMPOSE $COMPOSE_HA $PROFILES up -d $HA_SCALE; then
        success "Services started"
    else
        warn "Some services failed to start (check port conflicts with: mmrc logs)"
    fi

    # SSL setup
    if [ "$REINSTALL" = "1" ]; then
        info "SSL setup skipped (reinstall — сертификаты уже на месте: mmrc ssl)"
    else
        echo ""
        setup_ssl=$(ask_yes_no "  Setup SSL certificate now? [y/N]: ")
        if [[ "$setup_ssl" =~ ^[Yy]$ ]]; then
            "$BIN_DIR/mmrc" ssl
        fi
    fi

    # Wait for health with progress
    info "Waiting for server to be ready..."
    local check_port=$NGINX_HTTP_PORT
    local server_ready=false
    for i in $(seq 1 15); do
        printf "\r  Waiting... %ds" "$i"
        sleep 1
        if curl -fsS http://localhost:${check_port}/health >/dev/null 2>&1; then
            echo ""
            success "Server is ready"
            server_ready=true
            break
        fi
    done
    if [ "$server_ready" = false ]; then
        echo ""
        warn "Server health check timed out. Use 'mmrc logs' to investigate."
    fi

    # Get server IP
    info "Detecting server IP..."
    SERVER_IP=$(curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

    echo ""
    colorized_echo cyan "════════════════════════════════════════════════════════════════════════════════════════════════════"
    box_line "                                                  🎉 MMRC Installed Successfully!                                                  "
    colorized_echo cyan "════════════════════════════════════════════════════════════════════════════════════════════════════"
    box_line ""
    box_line "  📺 Admin Panel:                         http://localhost:${NGINX_HTTP_PORT}/admin.html"
    box_line "  🎤 Speaker Panel:                       http://localhost:${NGINX_HTTP_PORT}/speaker.html"
    box_line "  🎖️  Hero Module:                         http://localhost:${NGINX_HTTP_PORT}/hero/"
    box_line "  ❤️  Health Check:                        http://localhost:${NGINX_HTTP_PORT}/health"
    box_line ""
    box_line "  🌐 From network:                        http://${SERVER_IP}:${NGINX_HTTP_PORT}/"
    box_line ""
    box_line "  👤 Admin:                               created on first page open"
    box_line "                                        (email + password ask on visit)"
    box_line ""
    box_line "  📁 Config:                              $INSTALL_DIR/.env"
    box_line "  💾 Data:                                $DATA_DIR"
    box_line "  📦 Media:                               $content_dir"
    box_line ""
    colorized_echo cyan "════════════════════════════════════════════════════════════════════════════════════════════════════"
    echo ""
    info "Useful commands:"
    echo "   mmrc status    - Check services status"
    echo "   mmrc logs      - View logs"
    echo "   mmrc ssl       - Setup SSL certificate"
    echo "   mmrc stop      - Stop services"
    echo "   mmrc update    - Update to latest version"
    echo "   mmrc backup    - Create backup"
    echo ""
}

install_mmrc
