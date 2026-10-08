#!/usr/bin/env bash
set -e
# pipefail обязателен: без него `curl ... | bash` при обрыве сети отдаёт
# bash пустой ввод, тот завершается с кодом 0, и установка «проходит успешно»,
# хотя ничего не установилось. Остальные скрипты репозитория pipefail уже ставят.
set -o pipefail

# MMRC CLI - One-command deployment and management
# Usage: mmrc <command> [options]

# ========================
# Configuration
# ========================
APP_NAME="mmrc"
INSTALL_DIR="/opt"
APP_DIR="$INSTALL_DIR/$APP_NAME"
DATA_DIR="/var/lib/$APP_NAME"
COMPOSE_FILE="$APP_DIR/docker-compose.yml"
ENV_FILE="$APP_DIR/.env"
MMRC_REPO="https://github.com/ya-k0v/MMRC"
MMRC_SCRIPTS_REPO="https://github.com/ya-k0v/MMRC"

# Загружаем версию из version.json на GitHub
__MMRC_VER=$(curl -fsSL "https://raw.githubusercontent.com/ya-k0v/MMRC/v340/version.json" 2>/dev/null || echo '{"branch":"v340","dockerTag":"v340","dockerImages":{"server":"pingwin1900/mmrc","converter":"pingwin1900/mmrc-converter","ffmpeg":"pingwin1900/mmrc-ffmpeg","streamer":"pingwin1900/mmrc-streamer"}}')
# Если GitHub отдал не JSON (страница rate-limit, пустой ответ, HTML-заглушка
# прокси), grep ничего не находит и переменная становится пустой. Дальше это
# давало битые URL вида .../MMRC//install.sh и теги образов pingwin1900/mmrc:.
# Поэтому пустое значение заменяем безопасным дефолтом.
MMRC_BRANCH=$(echo "$__MMRC_VER" | grep -o '"branch":"[^"]*"' | cut -d'"' -f4 || true)
[ -n "$MMRC_BRANCH" ] || MMRC_BRANCH="v340"
DOCKER_IMAGE_TAG=$(echo "$__MMRC_VER" | grep -o '"dockerTag":"[^"]*"' | cut -d'"' -f4 || true)
[ -n "$DOCKER_IMAGE_TAG" ] || DOCKER_IMAGE_TAG="v340"
DOCKER_ORG="pingwin1900"
DOCKER_IMAGE="${DOCKER_ORG}/mmrc"
CONVERTER_IMAGE="${DOCKER_ORG}/mmrc-converter"
FFMPEG_IMAGE="${DOCKER_ORG}/mmrc-ffmpeg"
STREAMER_IMAGE="${DOCKER_ORG}/mmrc-streamer"
export DOCKER_IMAGE DOCKER_IMAGE_TAG CONVERTER_IMAGE FFMPEG_IMAGE STREAMER_IMAGE

# ========================
# Colors
# ========================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ========================
# Helper Functions
# ========================
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
    local clean
    clean=$(printf '%s' "$content" | tr -d '\357\270\217') || return 1
    local char_count=${#clean}
    local byte_count
    byte_count=$(printf '%s' "$clean" | wc -c) || return 1
    local four_byte=$(( (byte_count - char_count) / 3 ))
    local display_width=$(( char_count + four_byte ))
    local pad=$((box_width - display_width))
    [ "$pad" -lt 0 ] && pad=0
    printf "${CYAN}║ %s%${pad}s║${NC}\n" "$content" ""
}

info() { colorized_echo blue "  $1"; }
success() { colorized_echo green "✔ $1"; }
warn() { colorized_echo yellow "⚠ $1" >&2; }
error() { colorized_echo red "✖ $1" >&2; }

check_root() {
    if [ "$(id -u)" != "0" ]; then
        error "This command must be run as root."
        exit 1
    fi
}

detect_compose() {
    if docker compose version >/dev/null 2>&1; then
        COMPOSE='docker compose'
    elif docker-compose version >/dev/null 2>&1; then
        COMPOSE='docker-compose'
    else
        error "Docker Compose not found. Install Docker first."
        exit 1
    fi
}

is_mmrc_installed() {
    [ -f "$COMPOSE_FILE" ] && [ -f "$ENV_FILE" ]
}

require_installed() {
    if ! is_mmrc_installed; then
        error "MMRC is not installed. Run 'mmrc install' first."
        exit 1
    fi
}

replace_or_append_env() {
    local key="$1"
    local value="$2"
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
        sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    else
        echo "${key}=${value}" >> "$ENV_FILE"
    fi
}

# Читает переменную из .env.
#
# Раньше это писалось как `grep "^KEY=" file | cut -d= -f2 || echo default`.
# Fallback там не срабатывал никогда: код возврата пайпа берётся от последней
# команды, а cut завершается успехом даже на пустом вводе. Переменная
# оставалась пустой, и в cmd_reset `rm -rf "$CONTENT_DIR"/*` превращался в
# `rm -rf /*` — стирание всей файловой системы.
get_env_value() {
    local key="$1"
    local default="${2:-}"
    local value
    value=$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- \
        | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/") || true
    [ -n "$value" ] && printf '%s' "$value" || printf '%s' "$default"
}

# Приводит путь к каноническому виду без обращения к симлинкам: убирает
# повторные и хвостовые слэши, а также сегменты «./». Нужна, чтобы проверки
# безопасности не обходились через «/etc/», «//etc» или «/etc/.».
normalize_path() {
    local IFS='/'
    local -a parts
    local part=""
    local out=""
    # read -ra не раскрывает glob-паттерны (в отличие от присваивания $p),
    # поэтому «*» в пути не превратится в список файлов.
    read -r -a parts <<< "$1"
    for part in ${parts[@]+"${parts[@]}"}; do
        case "$part" in
            ''|'.') continue ;;
            '..') out="$out/.." ;;
            *) out="$out/$part" ;;
        esac
    done
    printf '%s' "$out"
}

# Проверяет, что путь годится для массового удаления содержимого.
# Отказываем на пустом значении, на "/", на относительном пути и на
# системных каталогах верхнего уровня.
assert_safe_clean_target() {
    local target="$1"
    local label="$2"

    if [ -z "$target" ]; then
        error "$label is empty. Refusing to delete anything."
        return 1
    fi
    case "$target" in
        /*) : ;;
        *)
            error "$label must be an absolute path, got: $target"
            return 1
            ;;
    esac

    # Нормализуем ДО проверки. Иначе "/etc/", "//etc" и "/etc/." не совпадали
    # со списком запрещённых каталогов, и очистка проходила по системной
    # директории.
    local normalized
    normalized=$(normalize_path "$target")

    if [ -z "$normalized" ] || [ "$normalized" = "/" ]; then
        error "$label resolves to '$target' (filesystem root). Refusing to delete."
        return 1
    fi
    case "$normalized" in
        */../*|*/..)
            error "$label contains '..': $target. Refusing to delete."
            return 1
            ;;
    esac
    # Защита от каталогов, которые не могут быть хранилищем контента
    case "$normalized" in
        /bin|/boot|/cdrom|/dev|/etc|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/usr|/var)
            error "$label points at a system directory: $normalized. Refusing to delete."
            return 1
            ;;
    esac
    return 0
}

# Качает файл во временный путь и только потом переносит на место.
#
# `curl -o file` создаёт файл сразу и при обрыве по таймауту оставляет
# обрезанный файл. Раньше `mmrc pull`/`mmrc update` писали прямо в
# docker-compose.yml: при --max-time истёкшем файл оставался огрызком, а
# скрипт рапортовал «Could not update compose file, using existing version».
download_atomic() {
    local url="$1"
    local dest="$2"
    local tmp="${dest}.part.$$"
    if curl -fSL --connect-timeout 10 --max-time 60 -o "$tmp" "$url" 2>/dev/null && [ -s "$tmp" ]; then
        mv -f "$tmp" "$dest"
        return 0
    fi
    rm -f "$tmp"
    return 1
}

# Читает ответ пользователя. В CI/cron/`docker exec` без -t терминала нет,
# и `read < /dev/tty` падал с «No such device or address».
# Базовый URL для health-check. Порт брали из .env: там бывает 3000 или 8080,
# а проверка ходила только на :80 и рапортовала «Server is not responding»
# на полностью рабочей установке.
health_base_url() {
    local port
    port=$(get_env_value "PORT" "")
    if [ -z "$port" ]; then
        port=$(get_env_value "HEALTH_PORT" "")
    fi
    [ -n "$port" ] || port=80
    printf 'http://localhost:%s' "$port"
}

# Читает строку с TTY. Если терминала нет (cron, CI, пайп) — не падает с
# «No such device or address», а честно отказывается выполнять интерактивный шаг.
read_from_tty() {
    local prompt="$1"
    local default="${2-}"
    local reply=""
    if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
        read -r -p "$prompt" reply < /dev/tty || reply=""
    else
        printf '✖ %s\n' "Interactive input required (no TTY available). Re-run from a terminal." >&2
        return 1
    fi
    printf '%s' "${reply:-$default}"
}

confirm() {
    local prompt="$1"
    local reply
    if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
        read -r -p "$prompt" reply < /dev/tty || reply=""
    else
        read -r -p "$prompt" reply || reply=""
    fi
    printf '%s' "$reply"
}

# ========================
# Commands
# ========================

cmd_install() {
    check_root

    if is_mmrc_installed; then
        warn "MMRC is already installed at $APP_DIR"
        info "Run 'mmrc update' to update, or 'mmrc reinstall' for a fresh install."
        exit 0
    fi

    colorized_echo cyan "
══════════════════════════════════════════
          📺 MMRC Installer               
     Media Management & Remote Control    
══════════════════════════════════════════
"

    if ! curl -fsSL --connect-timeout 15 --max-time 120 "https://raw.githubusercontent.com/ya-k0v/MMRC/${MMRC_BRANCH}/install.sh" | bash; then
        error "Installer download or execution failed (branch '$MMRC_BRANCH'). Nothing was installed."
        exit 1
    fi
}

cmd_reinstall() {
    check_root
    require_installed

    colorized_echo yellow "⚠️  This will reinstall MMRC."
    colorized_echo yellow "    Existing configuration ($APP_DIR/.env) will be PRESERVED and backed up (.env.bak.*)."
    confirm_reply=$(confirm "  Continue? [y/N]: ")
    if [[ ! "$confirm_reply" =~ ^[Yy]$ ]]; then
        info "Aborted"
        exit 0
    fi

    if ! curl -fsSL --connect-timeout 15 --max-time 120 "https://raw.githubusercontent.com/ya-k0v/MMRC/${MMRC_BRANCH}/install.sh" | bash; then
        error "Installer download or execution failed (branch '$MMRC_BRANCH')."
        exit 1
    fi
}

cmd_pull() {
    require_installed
    detect_compose
    cd "$APP_DIR"

    # Update compose file from repo
    info "Updating compose configuration..."
    MMRC_RAW="https://raw.githubusercontent.com/ya-k0v/MMRC/${MMRC_BRANCH}"
    if download_atomic "$MMRC_RAW/docker-compose.deploy.yml" "$COMPOSE_FILE"; then
        success "Compose file updated"
    else
        warn "Could not update compose file, keeping the existing one"
    fi

    info "Pulling latest Docker images..."
    COMPOSE_HA=$(get_compose_ha)
    PROFILES=$(get_compose_profiles)
    $COMPOSE $COMPOSE_HA $PROFILES pull
    docker pull "${CONVERTER_IMAGE}:${DOCKER_IMAGE_TAG}" 2>/dev/null || warn "Converter image not available (non-critical)"
    docker pull "${FFMPEG_IMAGE}:${DOCKER_IMAGE_TAG}" 2>/dev/null || warn "FFmpeg image not available (non-critical)"
    docker pull "${STREAMER_IMAGE}:${DOCKER_IMAGE_TAG}" 2>/dev/null || warn "Streamer image not available (non-critical)"
    success "Images pulled"
}

cmd_down() {
    require_installed
    detect_compose
    cd "$APP_DIR"
    info "Stopping and removing containers..."
    COMPOSE_HA=$(get_compose_ha)
    PROFILES=$(get_compose_profiles)
    $COMPOSE $COMPOSE_HA $PROFILES down
    success "Containers removed"
}

cmd_ps() {
    require_installed
    detect_compose
    cd "$APP_DIR"
    COMPOSE_HA=$(get_compose_ha)
    PROFILES=$(get_compose_profiles)
    $COMPOSE $COMPOSE_HA $PROFILES ps
}

cmd_reset() {
    check_root
    require_installed

    colorized_echo red "
══════════════════════════════════════════
            ⚠️  MMRC Reset                      
        THIS WILL DELETE ALL DATA!            
══════════════════════════════════════════
"

    confirm_reply=$(confirm "Are you sure? Type 'reset' to confirm: ")
    if [ "$confirm_reply" != "reset" ]; then
        info "Aborted"
        exit 0
    fi

    detect_compose
    cd "$APP_DIR"

    info "Stopping services and removing volumes..."
    COMPOSE_HA=$(get_compose_ha)
    PROFILES=$(get_compose_profiles)
    $COMPOSE $COMPOSE_HA $PROFILES down -v
    success "Services stopped, volumes removed"

    info "Cleaning content data..."
    # CONTENT_DIR помечен как legacy: dev/scripts/quick-install.sh его в .env
    # не пишет (там DATA_ROOT), поэтому переменная часто отсутствует. Пустое
    # значение в `rm -rf "$CONTENT_DIR"/*` давало `rm -rf /*` — удаление всей
    # файловой системы вместо очистки контента.
    DATA_ROOT_DIR=$(get_env_value "DATA_ROOT")
    CONTENT_DIR=$(get_env_value "CONTENT_DIR" "")
    if [ -z "$CONTENT_DIR" ] && [ -n "$DATA_ROOT_DIR" ]; then
        CONTENT_DIR="$DATA_ROOT_DIR/content"
    fi

    assert_safe_clean_target "$CONTENT_DIR" "CONTENT_DIR" || exit 1
    CONTENT_DIR=$(normalize_path "$CONTENT_DIR")

    if [ -d "$CONTENT_DIR" ]; then
        # find -mindepth 1, а не "$DIR"/*: удаляет и скрытые файлы вроде .thumbnails
        find "$CONTENT_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
        success "Content data cleaned"
    else
        warn "Content directory does not exist, nothing to clean: $CONTENT_DIR"
    fi

    echo ""
    success "MMRC has been reset to clean state."
    info "Configuration preserved in $APP_DIR/.env"
    info "Run 'mmrc pull && mmrc start' to start fresh."
}

cmd_reset_password() {
    require_installed
    detect_compose

    colorized_echo yellow "
══════════════════════════════════════════
         🔑 Reset Admin Password
══════════════════════════════════════════
"

    confirm_reply=$(confirm "Generate a new random admin password? [y/N]: ")
    if [[ ! "$confirm_reply" =~ ^[Yy]$ ]]; then
        info "Aborted"
        exit 0
    fi

    cd "$APP_DIR"
    COMPOSE_HA=$(get_compose_ha)
    PROFILES=$(get_compose_profiles)

    info "Resetting admin password..."
    EXEC_SVC="mmrc"
    if [ -n "$COMPOSE_HA" ]; then
        # В HA-режиме сервис mmrc отключён (профиль ha-disabled) — используем реплику
        EXEC_SVC="mmrc-replica"
    fi
    EXEC_STATUS=0
    RESULT=$($COMPOSE $COMPOSE_HA $PROFILES exec -T "$EXEC_SVC" node --input-type=module -e "
import path from 'node:path';
import { initDatabase, getDatabase, getDriverType, closeDatabase } from './src/database/database.js';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';

const requestedPg = (process.env.DB_TYPE || 'sqlite').trim().toLowerCase() === 'postgres';
try {
    await initDatabase(requestedPg ? undefined : path.join(process.env.MMRC_DATA_DIR || '/app/data', 'db', 'main.db'));
    const databaseType = getDriverType();
    console.log('DB:' + (databaseType === 'postgres' ? 'PostgreSQL' : 'SQLite'));
    const db = getDatabase();
    const user = await db.get(
        'SELECT id, username FROM users WHERE role = ? AND auth_source = ? ORDER BY id LIMIT 1',
        ['admin', 'local']
    );

    if (!user) {
        console.log('ERROR:Local admin account not found');
        process.exitCode = 1;
    } else {
        const newPassword = crypto.randomBytes(24).toString('base64url');
        const hash = await bcrypt.hash(newPassword, 12);
        const result = await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id]);
        if (result.changes !== 1) {
            console.log('ERROR:Admin password was not updated');
            process.exitCode = 1;
        } else {
            console.log('USER:' + user.username);
            console.log('PASSWORD:' + newPassword);
        }
    }
} finally {
    await closeDatabase();
}
" 2>&1) || EXEC_STATUS=$?

    DB_TYPE_RESULT=$(echo "$RESULT" | sed -n 's/^DB://p' | sed -n '1p' || true)
    [ -n "$DB_TYPE_RESULT" ] && info "База данных: $DB_TYPE_RESULT"

    if [ "$EXEC_STATUS" -eq 0 ] && echo "$RESULT" | grep -q "^USER:" && echo "$RESULT" | grep -q "^PASSWORD:"; then
        USERNAME=$(echo "$RESULT" | grep "^USER:" | sed 's/USER://' || true)
        NEW_PASSWORD=$(echo "$RESULT" | sed -n 's/^PASSWORD://p' | sed -n '1p' || true)
        success "Логин: $USERNAME"
        success "Новый пароль: $NEW_PASSWORD"
    elif echo "$RESULT" | grep -q "^ERROR:"; then
        ERROR=$(echo "$RESULT" | grep "^ERROR:" | sed 's/ERROR://' || true)
        error "$ERROR"
    else
        error "Could not reset password (exit code: $EXEC_STATUS)"
        [ -n "$RESULT" ] && printf '%s\n' "$RESULT" | tail -n 5
    fi
}

get_compose_ha() {
    if [ -f "$APP_DIR/docker-compose.ha.yml" ]; then
        echo "-f docker-compose.yml -f docker-compose.ha.yml"
    else
        echo ""
    fi
}

get_ha_replicas() {
    docker ps --filter "name=mmrc-replica" --format "{{.Names}}" 2>/dev/null | wc -l
}

get_compose_profiles() {
    local profiles=""
    if grep -q "^DB_TYPE=postgres" "$ENV_FILE" 2>/dev/null; then
        profiles="--profile postgres"
    fi
    if grep -q "^STORAGE_BACKEND=s3" "$ENV_FILE" 2>/dev/null; then
        profiles="$profiles --profile s3"
    fi
    if grep -q "^MMRC_STREAMER_ENABLED=true" "$ENV_FILE" 2>/dev/null; then
        profiles="$profiles --profile streamer"
    fi
    if [ -f "$APP_DIR/docker-compose.ha.yml" ]; then
        profiles="$profiles --profile ha"
        # HA requires PostgreSQL — SQLite не поддерживает multi-process
        if ! echo "$profiles" | grep -q -- "--profile postgres"; then
            profiles="$profiles --profile postgres"
        fi
    fi
    echo "$profiles"
}

cmd_start() {
    require_installed
    detect_compose
    cd "$APP_DIR"
    info "Starting MMRC services..."
    COMPOSE_HA=$(get_compose_ha)
    PROFILES=$(get_compose_profiles)
    if [ -n "$COMPOSE_HA" ]; then
        warn_ha_sqlite
        # Stop single-node mmrc container if still running (profile prevents restart)
        docker stop mmrc 2>/dev/null || true
        docker rm mmrc 2>/dev/null || true
        HA_REPLICAS=$(get_ha_replicas)
        if ! [[ "$HA_REPLICAS" =~ ^[0-9]+$ ]] || [ "$HA_REPLICAS" -lt 1 ]; then
            HA_REPLICAS=1
        fi
        HA_SCALE="--scale mmrc-replica=$HA_REPLICAS"
    else
        HA_SCALE=""
    fi
    $COMPOSE $COMPOSE_HA $PROFILES up -d $HA_SCALE
    success "Services started"
}

cmd_stop() {
    require_installed
    detect_compose
    cd "$APP_DIR"
    info "Stopping MMRC services..."
    COMPOSE_HA=$(get_compose_ha)
    PROFILES=$(get_compose_profiles)
    $COMPOSE $COMPOSE_HA $PROFILES down
    success "Services stopped"
}

cmd_restart() {
    require_installed
    detect_compose
    cd "$APP_DIR"
    info "Restarting MMRC services..."
    COMPOSE_HA=$(get_compose_ha)
    PROFILES=$(get_compose_profiles)
    $COMPOSE $COMPOSE_HA $PROFILES restart
    success "Services restarted"
}

cmd_status() {
    require_installed
    detect_compose
    cd "$APP_DIR"
    echo ""
    colorized_echo cyan "══════════════════════════════════════"
    colorized_echo cyan "         📊 MMRC Status              "
    colorized_echo cyan "══════════════════════════════════════"
    echo ""
    COMPOSE_HA=$(get_compose_ha)
    $COMPOSE $COMPOSE_HA ps
    echo ""

    # HA info
    HA_REPLICAS=$(get_ha_replicas)
    if [ -f "$APP_DIR/docker-compose.ha.yml" ] && [ "$HA_REPLICAS" -gt 0 ] 2>/dev/null; then
        info "HA mode: $HA_REPLICAS replica(s) running"
    elif [ -f "$APP_DIR/docker-compose.ha.yml" ]; then
        info "HA configured but no replicas running"
    fi

    # Health check
    HEALTH_URL="$(health_base_url)/health"
    if curl -fsS --connect-timeout 5 --max-time 10 "$HEALTH_URL" >/dev/null 2>&1; then
        success "Server is healthy ($HEALTH_URL)"
    else
        warn "Server is not responding on $HEALTH_URL"
    fi

    # Database info
    DB_TYPE_VAL=$(get_env_value "DB_TYPE")
    if [ "$DB_TYPE_VAL" = "postgres" ]; then
        info "Database: PostgreSQL"
        if docker ps --format '{{.Names}}' | grep -q '^mmrc-postgres$'; then
            if docker exec mmrc-postgres pg_isready -U mmrc >/dev/null 2>&1; then
                success "PostgreSQL is healthy"
            else
                warn "PostgreSQL container exists but not ready"
            fi
        else
            warn "PostgreSQL container not running"
        fi
    else
        info "Database: SQLite"
    fi

    # Disk usage
    CONTENT_DIR=$(get_env_value "CONTENT_DIR")
    if [ -n "$CONTENT_DIR" ] && [ -d "$CONTENT_DIR" ]; then
        echo ""
        info "Content storage usage:"
        du -sh "$CONTENT_DIR" 2>/dev/null || true
        df -h "$CONTENT_DIR" | tail -1
    fi
}

cmd_logs() {
    require_installed
    detect_compose
    cd "$APP_DIR"
    COMPOSE_HA=$(get_compose_ha)
    PROFILES=$(get_compose_profiles)

    # Parse flags
    TAIL=""
    MODULE=""
    LEVEL=""
    SERVICE=""

    while [ $# -gt 0 ]; do
        case "$1" in
            --tail|-n)
                TAIL="$2"
                shift 2
                ;;
            --module|-m)
                MODULE="$2"
                shift 2
                ;;
            --level|-l)
                LEVEL="$2"
                shift 2
                ;;
            server|mmrc|postgres|db|redis|minio|s3|streamer|converter|replica|ha-lb|nginx)
                SERVICE="$1"
                shift
                ;;
            *)
                SERVICE="$1"
                shift
                ;;
        esac
    done

    # Build docker compose logs command
    LOG_ARGS=""
    if [ -n "$TAIL" ]; then
        LOG_ARGS="$LOG_ARGS --tail $TAIL"
    fi

    # Determine service name
    case "$SERVICE" in
        server|mmrc) SVC="mmrc" ;;
        postgres|db) SVC="postgres" ;;
        redis) SVC="redis" ;;
        minio|s3) SVC="minio" ;;
        streamer) SVC="streamer" ;;
        converter) SVC="converter" ;;
        replica) SVC="mmrc-replica" ;;
        ha-lb|nginx) SVC="nginx-ha" ;;
        "") SVC="" ;;
        *) SVC="$SERVICE" ;;
    esac

    # Build grep filter for module/level
    GREP_ARGS=""
    if [ -n "$MODULE" ] || [ -n "$LEVEL" ]; then
        # Build JSON filter pattern
        FILTER=""
        if [ -n "$MODULE" ] && [ -n "$LEVEL" ]; then
            FILTER="\"module\":\"$MODULE\".*\"level\":\"$LEVEL\""
        elif [ -n "$MODULE" ]; then
            FILTER="\"module\":\"$MODULE\""
        elif [ -n "$LEVEL" ]; then
            FILTER="\"level\":\"$LEVEL\""
        fi

        if [ -n "$SVC" ]; then
            $COMPOSE $COMPOSE_HA $PROFILES logs -f $LOG_ARGS "$SVC" 2>/dev/null | grep --line-buffered "$FILTER"
        else
            $COMPOSE $COMPOSE_HA $PROFILES logs -f $LOG_ARGS 2>/dev/null | grep --line-buffered "$FILTER"
        fi
    else
        if [ -n "$SVC" ]; then
            $COMPOSE $COMPOSE_HA $PROFILES logs -f $LOG_ARGS "$SVC"
        else
            $COMPOSE $COMPOSE_HA $PROFILES logs -f $LOG_ARGS
        fi
    fi
}

cmd_update() {
    require_installed
    detect_compose

    colorized_echo cyan "
══════════════════════════════════════════
            🔄 MMRC Updater                  
══════════════════════════════════════════
"

    cd "$APP_DIR"
    COMPOSE_HA=$(get_compose_ha)
    PROFILES=$(get_compose_profiles)

    # Update compose file from repo
    info "Updating compose configuration..."
    MMRC_RAW="https://raw.githubusercontent.com/ya-k0v/MMRC/${MMRC_BRANCH}"
    if download_atomic "$MMRC_RAW/docker-compose.deploy.yml" "$COMPOSE_FILE"; then
        success "Compose file updated"
    else
        warn "Could not update compose file, keeping the existing one"
    fi

    # Pull new images
    info "Pulling latest Docker images..."
    $COMPOSE $COMPOSE_HA $PROFILES pull
    docker pull "${CONVERTER_IMAGE}:${DOCKER_IMAGE_TAG}" 2>/dev/null || warn "Converter image not available (non-critical)"
    docker pull "${FFMPEG_IMAGE}:${DOCKER_IMAGE_TAG}" 2>/dev/null || warn "FFmpeg image not available (non-critical)"
    docker pull "${STREAMER_IMAGE}:${DOCKER_IMAGE_TAG}" 2>/dev/null || warn "Streamer image not available (non-critical)"
    success "Images updated"

    # Restart services
    info "Restarting services..."
    HA_REPLICAS=$(get_ha_replicas)
    HA_SCALE=""
    if [[ "$HA_REPLICAS" =~ ^[0-9]+$ ]] && [ "$HA_REPLICAS" -gt 0 ]; then
        HA_SCALE="--scale mmrc-replica=$HA_REPLICAS"
    fi
    $COMPOSE $COMPOSE_HA $PROFILES up -d $HA_SCALE
    success "Services restarted"

    # Wait for health
    info "Waiting for server to be ready..."
    sleep 10

    if curl -fsS --connect-timeout 5 --max-time 10 "$(health_base_url)/health" >/dev/null 2>&1; then
        success "Update completed successfully!"
    else
        warn "Server may still be starting. Check logs: mmrc logs"
    fi

    # Cleanup old images
    info "Cleaning up old Docker images..."
    docker image prune -f >/dev/null 2>&1 || true
    success "Cleanup complete"
}

cmd_backup() {
    require_installed
    detect_compose

    BACKUP_DIR="$APP_DIR/backups"
    mkdir -p "$BACKUP_DIR"

    TIMESTAMP=$(date +%F_%H%M)

    colorized_echo cyan "
══════════════════════════════════════════
            💾 MMRC Backup                   
══════════════════════════════════════════
"

    # Backup databases
    info "Backing up databases..."
    cd "$APP_DIR"

    DB_TYPE_VAL=$(get_env_value "DB_TYPE")
    if [ "$DB_TYPE_VAL" = "postgres" ]; then
        # PostgreSQL backup via pg_dump
        DB_HOST=$(get_env_value "DB_HOST")
        DB_PORT=$(get_env_value "DB_PORT")
        DB_NAME=$(get_env_value "DB_NAME")
        DB_USER=$(get_env_value "DB_USER")
        DB_PASSWORD=$(get_env_value "DB_PASSWORD")

        if command -v pg_dump >/dev/null 2>&1; then
            PGPASSWORD="$DB_PASSWORD" pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
                -F c -f "$BACKUP_DIR/mmrc-${TIMESTAMP}.dump"
            success "PostgreSQL database backed up: mmrc-${TIMESTAMP}.dump"
        else
            warn "pg_dump not found. Install postgresql-client to enable backup."
            info "Creating Docker-based backup..."
            docker exec mmrc-postgres pg_dump -U "$DB_USER" -d "$DB_NAME" \
                -F c -f /tmp/mmrc-backup.dump 2>/dev/null && \
            docker cp mmrc-postgres:/tmp/mmrc-backup.dump "$BACKUP_DIR/mmrc-${TIMESTAMP}.dump" && \
            docker exec mmrc-postgres rm /tmp/mmrc-backup.dump && \
            success "PostgreSQL database backed up via Docker: mmrc-${TIMESTAMP}.dump"
        fi
    else
        PROFILES=$(get_compose_profiles)
        # Удаление временного файла вынесено из цепочки &&: раньше его сбой
        # печатал «Main database backup failed», хотя дамп уже был скопирован.
        if $COMPOSE $PROFILES exec -T mmrc sqlite3 /app/data/db/main.db \
            ".backup '/tmp/main-${TIMESTAMP}.db'" 2>/dev/null && \
           $COMPOSE $PROFILES cp "mmrc:/tmp/main-${TIMESTAMP}.db" "$BACKUP_DIR/main-${TIMESTAMP}.db"; then
            success "Main database backed up"
            $COMPOSE $PROFILES exec -T mmrc rm "/tmp/main-${TIMESTAMP}.db" 2>/dev/null || true
        else
            warn "Main database backup failed"
        fi

        if $COMPOSE $PROFILES exec -T mmrc sqlite3 /app/data/db/heroes.db \
            ".backup '/tmp/heroes-${TIMESTAMP}.db'" 2>/dev/null && \
           $COMPOSE $PROFILES cp "mmrc:/tmp/heroes-${TIMESTAMP}.db" "$BACKUP_DIR/heroes-${TIMESTAMP}.db"; then
            success "Heroes database backed up"
            $COMPOSE $PROFILES exec -T mmrc rm "/tmp/heroes-${TIMESTAMP}.db" 2>/dev/null || true
        else
            warn "Heroes database backup failed"
        fi
    fi

    # Backup config
    tar -czf "$BACKUP_DIR/config-${TIMESTAMP}.tar.gz" -C "$APP_DIR" .env docker-compose.yml 2>/dev/null || true
    success "Configuration backed up"

    echo ""
    info "Backups saved to: $BACKUP_DIR"
    ls -lh "$BACKUP_DIR" | tail -5
}

cmd_ssl() {
    local subcommand="${1:-}"

    # Статус сертификатов не должен запускать мастер и перезапускать сервисы
    if [ "$subcommand" = "status" ]; then
        check_root
        require_installed
        show_ssl_status
        return 0
    fi

    check_root
    require_installed
    detect_compose

    colorized_echo cyan "
══════════════════════════════════════════
         🔐 MMRC SSL Setup
══════════════════════════════════════════
"

    cd "$APP_DIR"

    COMPOSE_HA=$(get_compose_ha)
    PROFILES=$(get_compose_profiles)

    # Check if SSL certs already exist
    CERTS_DIR=$(find "$DATA_DIR/certs" -name "fullchain.pem" -exec dirname {} \; 2>/dev/null | head -1)

    if [ -n "$CERTS_DIR" ] && [ -f "$CERTS_DIR/fullchain.pem" ] && [ -f "$CERTS_DIR/privkey.pem" ]; then
        EXISTING_DOMAIN=$(basename "$CERTS_DIR")
        info "SSL certificates found: $EXISTING_DOMAIN"
        echo ""
        echo "1) Use existing certificate"
        echo "2) Issue new certificate"
        choice=$(read_from_tty "Choose [1]: " "1") || exit 1

        if [ "$choice" = "2" ]; then
            issue_new_cert
        else
            info "Using existing certificate for $EXISTING_DOMAIN"
            replace_or_append_env "SSL_DOMAIN" "$EXISTING_DOMAIN"
            replace_or_append_env "SSL_CERT" "$CERTS_DIR/fullchain.pem"
            replace_or_append_env "SSL_KEY" "$CERTS_DIR/privkey.pem"
        fi
    else
        info "No SSL certificates found."
        issue_new_cert
    fi

    info "Restarting MMRC with SSL..."
    $COMPOSE $COMPOSE_HA $PROFILES down 2>/dev/null || true
    $COMPOSE $COMPOSE_HA $PROFILES up -d
    success "MMRC started with SSL on port 443"
}

show_ssl_status() {
    local cert_dir env_domain
    cert_dir=$(find "$DATA_DIR/certs" -name "fullchain.pem" -exec dirname {} \; 2>/dev/null | head -1 || true)

    if [ -n "$cert_dir" ] && [ -f "$cert_dir/fullchain.pem" ] && [ -f "$cert_dir/privkey.pem" ]; then
        success "SSL certificate present"
        info "  Domain:   $(basename "$cert_dir")"
        info "  Cert:     $cert_dir/fullchain.pem"
        info "  Key:      $cert_dir/privkey.pem"
        if command -v openssl >/dev/null 2>&1; then
            info "  Expires:  $(openssl x509 -enddate -noout -in "$cert_dir/fullchain.pem" 2>/dev/null | sed 's/notAfter=//' || echo unknown)"
        fi
    else
        info "No SSL certificate installed"
        info "  Run 'mmrc ssl' to set one up"
    fi

    env_domain=$(get_env_value "SSL_DOMAIN" "")
    if [ -n "$env_domain" ]; then
        info "  .env SSL_DOMAIN: $env_domain"
    else
        warn "  .env has no SSL_DOMAIN - MMRC still serves plain HTTP on port 80"
    fi
}

issue_new_cert() {
    echo ""
    echo "How to get SSL certificate?"
    echo "1) Self-signed (for IP addresses)"
    echo "2) Let's Encrypt (for public domains)"
    echo "3) I have certificate files"
    cert_type=$(read_from_tty "Choose [1]: " "1") || return 1
    cert_type=${cert_type:-1}

    case $cert_type in
        1)
            domain=$(read_from_tty "Enter IP address: ") || return 1
            if [ -z "$domain" ] || ! echo "$domain" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
                error "Valid IP address is required"
                return 1
            fi

            info "Generating self-signed certificate for $domain..."
            mkdir -p "$DATA_DIR/certs/$domain"

            # Раньше стоял `if [ $? -eq 0 ]` сразу после openssl. Под set -e
            # неудачный openssl прерывал скрипт, а stderr был заглушен через
            # 2>/dev/null, так что ветка else не выполнялась никогда, а
            # пользователь видел только молчаливое завершение.
            if openssl req -x509 -nodes -days 3650 \
                -newkey rsa:2048 \
                -keyout "$DATA_DIR/certs/$domain/privkey.pem" \
                -out "$DATA_DIR/certs/$domain/fullchain.pem" \
                -subj "/CN=$domain" \
                -addext "subjectAltName=IP:$domain"; then
                success "Self-signed certificate generated!"
                # Copy to fixed path for nginx
                mkdir -p "$DATA_DIR/certs/ssl"
                cp "$DATA_DIR/certs/$domain/fullchain.pem" "$DATA_DIR/certs/ssl/"
                cp "$DATA_DIR/certs/$domain/privkey.pem" "$DATA_DIR/certs/ssl/"
                replace_or_append_env "SSL_DOMAIN" "$domain"
            else
                error "Failed to generate certificate"
                return 1
            fi
            ;;
        2)
            domain=$(read_from_tty "Enter domain name: ") || return 1
            if [ -z "$domain" ]; then
                error "Domain name is required"
                return 1
            fi

            info "Stopping MMRC to free port 80..."
            $COMPOSE $COMPOSE_HA $PROFILES down 2>/dev/null || true

            if ! command -v acme.sh >/dev/null 2>&1; then
                info "Installing acme.sh..."
                cd /root
                # Download and install acme.sh manually
                curl -fsSL https://github.com/acmesh-official/acme.sh/archive/master.tar.gz -o /tmp/acme.tar.gz
                tar xzf /tmp/acme.tar.gz -C /tmp
                cd /tmp/acme.sh-master
                # Install with email for certificate notifications
                ssl_email=$(read_from_tty "Enter email for SSL certificate [admin@$domain]: " "admin@$domain") || return 1
                ./acme.sh --install -m "$ssl_email"
                cd /root
                rm -rf /tmp/acme.tar.gz /tmp/acme.sh-master
                export PATH="/root/.acme.sh:$PATH"
            fi

            info "Issuing Let's Encrypt certificate for $domain..."
            if acme.sh --issue -d "$domain" --standalone --server letsencrypt; then
                mkdir -p "$DATA_DIR/certs/$domain"
                acme.sh --install-cert -d "$domain" \
                    --key-file "$DATA_DIR/certs/$domain/privkey.pem" \
                    --fullchain-file "$DATA_DIR/certs/$domain/fullchain.pem"

                success "Let's Encrypt certificate issued!"
                # Copy to fixed path for nginx
                mkdir -p "$DATA_DIR/certs/ssl"
                cp "$DATA_DIR/certs/$domain/fullchain.pem" "$DATA_DIR/certs/ssl/"
                cp "$DATA_DIR/certs/$domain/privkey.pem" "$DATA_DIR/certs/ssl/"
                replace_or_append_env "SSL_DOMAIN" "$domain"
            else
                error "Failed to issue certificate"
                return 1
            fi
            ;;
        3)
            cert_path=$(read_from_tty "Enter full path to certificate: ") || return 1
            key_path=$(read_from_tty "Enter full path to private key: ") || return 1

            if [ ! -f "$cert_path" ] || [ ! -f "$key_path" ]; then
                error "Certificate or key file not found"
                return 1
            fi

            domain=$(read_from_tty "Enter domain/IP for this certificate: ") || return 1
            if [ -z "$domain" ]; then
                error "Domain/IP is required"
                return 1
            fi

            mkdir -p "$DATA_DIR/certs/$domain"
            cp "$cert_path" "$DATA_DIR/certs/$domain/fullchain.pem"
            cp "$key_path" "$DATA_DIR/certs/$domain/privkey.pem"
            chmod 644 "$DATA_DIR/certs/$domain/fullchain.pem"
            chmod 600 "$DATA_DIR/certs/$domain/privkey.pem"

            success "Certificate installed!"
            # Copy to fixed path for nginx
            mkdir -p "$DATA_DIR/certs/ssl"
            cp "$DATA_DIR/certs/$domain/fullchain.pem" "$DATA_DIR/certs/ssl/"
            cp "$DATA_DIR/certs/$domain/privkey.pem" "$DATA_DIR/certs/ssl/"
            replace_or_append_env "SSL_DOMAIN" "$domain"
            replace_or_append_env "SSL_CERT" "$DATA_DIR/certs/$domain/fullchain.pem"
            replace_or_append_env "SSL_KEY" "$DATA_DIR/certs/$domain/privkey.pem"
            ;;
        *)
            error "Invalid choice"
            return 1
            ;;
    esac
}

cmd_shell() {
    require_installed
    detect_compose
    cd "$APP_DIR"

    SERVICE="${1:-mmrc}"
    info "Opening shell in $SERVICE..."
    $COMPOSE exec "$SERVICE" /bin/sh
}

cmd_uninstall() {
    check_root
    require_installed

    colorized_echo red "
══════════════════════════════════════════
            ⚠️  MMRC Uninstall                  
        THIS WILL DELETE ALL DATA!            
══════════════════════════════════════════
"

    confirm_reply=$(read_from_tty "Are you sure? Type 'yes' to confirm: ") || return 1
    if [ "$confirm_reply" != "yes" ]; then
        info "Aborted"
        exit 0
    fi

    detect_compose
    cd "$APP_DIR"

    info "Stopping services..."
    COMPOSE_HA=$(get_compose_ha)
    PROFILES=$(get_compose_profiles)
    $COMPOSE $COMPOSE_HA $PROFILES down -v
    success "Services stopped"

    info "Removing installation..."
    rm -rf "$APP_DIR"
    success "Installation removed"

    info "Data directory preserved at: $DATA_DIR"
    warn "To remove data as well: rm -rf $DATA_DIR"
}

cmd_edit_env() {
    require_installed

    # Detect editor
    EDITOR="${EDITOR:-}"
    if [ -z "$EDITOR" ]; then
        if command -v nano >/dev/null 2>&1; then
            EDITOR="nano"
        elif command -v vi >/dev/null 2>&1; then
            EDITOR="vi"
        else
            error "No text editor found. Install nano or vi, or set \$EDITOR."
            exit 1
        fi
    fi

    info "Opening $ENV_FILE with $EDITOR..."
    $EDITOR "$ENV_FILE"

    if [ $? -eq 0 ]; then
        success "Configuration saved. Run 'mmrc restart' to apply changes."
    fi
}

warn_ha_sqlite() {
    local db_type
    db_type=$(get_env_value "DB_TYPE")
    if [ -z "$db_type" ] || [ "$db_type" = "sqlite" ]; then
        warn "HA mode requires PostgreSQL! SQLite не поддерживает multi-process запись."
        warn "Установите DB_TYPE=postgres в $ENV_FILE"
    fi
}

cmd_ha() {
    require_installed
    detect_compose

    case "${1:-status}" in
        setup|init)
            check_root
            HA_REPLICAS="${2:-2}"
            # Валидируем аргумент ДО любых проверок окружения: иначе `ha setup abc`
            # отвечал «нужен PostgreSQL» и вышел с кодом 0, не показав, что
            # сам аргумент бессмысленен.
            if ! [[ "$HA_REPLICAS" =~ ^[0-9]+$ ]] || [ "$HA_REPLICAS" -lt 1 ]; then
                error "Invalid replica count: '$HA_REPLICAS' (expected a positive integer, e.g. 'mmrc ha setup 2')"
                exit 1
            fi
            warn_ha_sqlite
            cd "$APP_DIR"

            if [ -f "docker-compose.ha.yml" ]; then
                warn "HA is already configured."
                confirm_reply=$(confirm "  Re-download and reconfigure? [y/N]: ")
                if [[ ! "$confirm_reply" =~ ^[Yy]$ ]]; then
                    info "Aborted"
                    exit 0
                fi
            fi

            info "Downloading HA configuration..."
            local ha_yml_ok=false ha_lb_ok=false

            # Use existing file if it exists and is not the 70-byte 400 error page
            if [ -f "docker-compose.ha.yml" ] && [ "$(stat -c%s "docker-compose.ha.yml" 2>/dev/null || echo 0)" -gt 100 ]; then
                warn "GitHub download unavailable; using existing docker-compose.ha.yml"
                ha_yml_ok=true
            else
                if download_atomic "https://raw.githubusercontent.com/ya-k0v/MMRC/${MMRC_BRANCH}/docker-compose.ha.yml" "docker-compose.ha.yml"; then
                    ha_yml_ok=true
                else
                    error "Failed to download docker-compose.ha.yml (check network)"
                    ha_yml_ok=false
                fi
            fi

            mkdir -p "docker/nginx"
            if [ -f "docker/nginx/ha-lb.conf" ] && [ "$(stat -c%s "docker/nginx/ha-lb.conf" 2>/dev/null || echo 0)" -gt 100 ]; then
                warn "GitHub download unavailable; using existing ha-lb.conf"
                ha_lb_ok=true
            else
                if download_atomic "https://raw.githubusercontent.com/ya-k0v/MMRC/${MMRC_BRANCH}/docker/nginx/ha-lb.conf" "docker/nginx/ha-lb.conf"; then
                    ha_lb_ok=true
                else
                    error "Failed to download ha-lb.conf (check network)"
                    ha_lb_ok=false
                fi
            fi

            if ! $ha_yml_ok || ! $ha_lb_ok; then
                exit 1
            fi
            success "HA configuration ready"

            COMPOSE_HA="-f docker-compose.yml -f docker-compose.ha.yml"
            PROFILES=$(get_compose_profiles)

            info "Starting with $HA_REPLICAS replicas..."
            # Stop single-node mmrc container if still running (profile prevents restart)
            docker stop mmrc 2>/dev/null || true
            docker rm mmrc 2>/dev/null || true
            $COMPOSE $COMPOSE_HA $PROFILES up -d --scale "mmrc-replica=$HA_REPLICAS"
            success "HA enabled with $HA_REPLICAS replica(s)"
            ;;

        scale)
            check_root
            if [ ! -f "$APP_DIR/docker-compose.ha.yml" ]; then
                error "HA is not configured. Run 'mmrc ha setup' first."
                exit 1
            fi
            cd "$APP_DIR"

            HA_REPLICAS="${2:-}"
            if ! [[ "$HA_REPLICAS" =~ ^[0-9]+$ ]] || [ "$HA_REPLICAS" -lt 1 ]; then
                error "Invalid replica count: '$HA_REPLICAS' (expected a positive integer, e.g. 'mmrc ha scale 2')"
                exit 1
            fi

            COMPOSE_HA="-f docker-compose.yml -f docker-compose.ha.yml"
            PROFILES=$(get_compose_profiles)

            info "Scaling to $HA_REPLICAS replica(s)..."
            # Stop single-node mmrc container if still running (profile prevents restart)
            docker stop mmrc 2>/dev/null || true
            docker rm mmrc 2>/dev/null || true
            $COMPOSE $COMPOSE_HA $PROFILES up -d --scale "mmrc-replica=$HA_REPLICAS"
            success "Scaled to $HA_REPLICAS replica(s)"
            ;;

        remove|teardown)
            check_root
            if [ ! -f "$APP_DIR/docker-compose.ha.yml" ]; then
                warn "HA is not configured."
                exit 0
            fi

            confirm_reply=$(confirm "Remove HA and return to single-node mode? [y/N]: ")
            if [[ ! "$confirm_reply" =~ ^[Yy]$ ]]; then
                info "Aborted"
                exit 0
            fi

            cd "$APP_DIR"

            info "Stopping HA services..."
            PROFILES=$(get_compose_profiles)
            $COMPOSE -f docker-compose.yml -f docker-compose.ha.yml $PROFILES stop mmrc-replica nginx-ha
            $COMPOSE -f docker-compose.yml -f docker-compose.ha.yml $PROFILES rm -f mmrc-replica nginx-ha
            success "HA services stopped"

            info "Removing HA configuration files..."
            rm -f docker-compose.ha.yml docker/nginx/ha-lb.conf
            success "HA configuration removed"

            info "Starting single-node mode..."
            $COMPOSE $PROFILES up -d
            success "Single-node mode restored"
            ;;

        status)
            cd "$APP_DIR"
            if [ ! -f "docker-compose.ha.yml" ]; then
                info "HA is not configured."
            else
                info "HA is configured."
                COMPOSE_HA="-f docker-compose.yml -f docker-compose.ha.yml"
                PROFILES=$(get_compose_profiles)
                HA_REPLICAS=$(get_ha_replicas)
                if [[ "$HA_REPLICAS" =~ ^[0-9]+$ ]] && [ "$HA_REPLICAS" -gt 0 ]; then
                    success "$HA_REPLICAS replica(s) running"
                else
                    warn "No replicas running (run 'mmrc ha scale <N>')"
                fi
                $COMPOSE $COMPOSE_HA $PROFILES ps 2>/dev/null | grep -E "mmrc|nginx-ha|replica" || true
            fi
            ;;

        help|--help)
            colorized_echo cyan "
Usage: mmrc ha <command> [options]

Commands:
  setup [N]    Configure HA with N replicas (default: 2)
  scale <N>    Scale replicas to N
  remove       Remove HA, return to single-node mode
  status       Show HA status

Note: HA requires PostgreSQL + S3/MinIO (not SQLite).
      Set DB_TYPE=postgres and STORAGE_BACKEND=s3 in .env
"
            ;;
        *)
            error "Unknown HA command: $1"
            cmd_ha help
            exit 1
            ;;
    esac
}

cmd_help() {
    colorized_echo cyan "
══════════════════════════════════════════════════════
                   📺 MMRC CLI                             
            Media Management & Remote Control            
══════════════════════════════════════════════════════

Usage: mmrc <command> [options]

Commands:
  install          Install MMRC with Docker
  reinstall        Reinstall MMRC (preserves config)
  start            Start MMRC services
  stop             Stop MMRC services
  restart          Restart MMRC services
  status           Check services status
  ps               List containers (docker compose ps)
  logs [service]   View logs with options:
                   --tail N     Last N lines
                   --module M   Filter by module (auth|device|file|socket|api|stream|system)
                   --level L    Filter by level (info|warn|error|debug)
  pull             Pull latest Docker images
  update           Update to latest version
  down             Stop and remove containers
  reset            Reset to clean state (removes all data, keeps config)
  reset-password   Reset admin password to default
  ha <command>     Manage HA replicas (setup|scale|remove|status)
  backup           Create database backup
  ssl              Setup SSL certificate
  shell [service]  Open shell in container
  edit-env         Edit .env configuration file
  uninstall        Remove MMRC

Examples:
  mmrc install                  # Install MMRC interactively
  mmrc status                   # Check services status
  mmrc logs server              # View server logs
  mmrc pull                     # Pull latest images
  mmrc ha setup 3               # Configure HA with 3 replicas
  mmrc ha scale 5               # Scale to 5 replicas
  mmrc ha remove                # Remove HA, back to single-node
  mmrc update                   # Update to latest version
  mmrc down                     # Stop and remove containers
  mmrc reset                    # Reset to clean state
  mmrc backup                   # Create database backup
  mmrc ssl                      # Setup SSL certificate
  mmrc edit-env                 # Edit configuration
"
}

# ========================
# Main
# ========================

case "${1:-help}" in
    install) cmd_install "${@:2}" ;;
    reinstall) cmd_reinstall ;;
    start) cmd_start ;;
    stop) cmd_stop ;;
    restart) cmd_restart ;;
    status) cmd_status ;;
    ps) cmd_ps ;;
    logs) cmd_logs "${@:2}" ;;
    pull) cmd_pull ;;
    update) cmd_update ;;
    down) cmd_down ;;
    reset) cmd_reset ;;
    reset-password) cmd_reset_password ;;
    backup) cmd_backup ;;
    ssl) cmd_ssl "${@:2}" ;;
    shell) cmd_shell "${@:2}" ;;
    ha) cmd_ha "${@:2}" ;;
    edit-env) cmd_edit_env ;;
    uninstall) cmd_uninstall ;;
    help|--help|-h) cmd_help ;;
    *)
        error "Unknown command: $1"
        cmd_help
        exit 1
        ;;
esac
