#!/usr/bin/env bash
set -e

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
MMRC_BRANCH=$(echo "$__MMRC_VER" | grep -o '"branch":"[^"]*"' | cut -d'"' -f4)
DOCKER_IMAGE_TAG=$(echo "$__MMRC_VER" | grep -o '"dockerTag":"[^"]*"' | cut -d'"' -f4)
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
╔══════════════════════════════════════════╗
║          📺 MMRC Installer               ║
║     Media Management & Remote Control    ║
╚══════════════════════════════════════════╝
"

    curl -fsSL "https://raw.githubusercontent.com/ya-k0v/MMRC/${MMRC_BRANCH}/install.sh" | bash
}

cmd_reinstall() {
    check_root
    require_installed

    colorized_echo yellow "⚠️  This will reinstall MMRC. Configuration will be preserved."
    read -p "  Continue? [y/N]: " confirm < /dev/tty
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        info "Aborted"
        exit 0
    fi

    curl -fsSL "https://raw.githubusercontent.com/ya-k0v/MMRC/${MMRC_BRANCH}/install.sh" | bash
}

cmd_pull() {
    require_installed
    detect_compose
    cd "$APP_DIR"
    info "Pulling latest Docker images..."
    PROFILES=$(get_compose_profiles)
    $COMPOSE $PROFILES pull
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
    PROFILES=$(get_compose_profiles)
    $COMPOSE $PROFILES down
    success "Containers removed"
}

cmd_ps() {
    require_installed
    detect_compose
    cd "$APP_DIR"
    $COMPOSE ps
}

cmd_reset() {
    check_root
    require_installed

    colorized_echo red "
╔══════════════════════════════════════════╗
║      ⚠️  MMRC Reset                      ║
║   THIS WILL DELETE ALL DATA!             ║
╚══════════════════════════════════════════╝
"

    read -p "Are you sure? Type 'reset' to confirm: " confirm < /dev/tty
    if [ "$confirm" != "reset" ]; then
        info "Aborted"
        exit 0
    fi

    detect_compose
    cd "$APP_DIR"

    info "Stopping services and removing volumes..."
    PROFILES=$(get_compose_profiles)
    $COMPOSE $PROFILES down -v
    success "Services stopped, volumes removed"

    info "Cleaning content data..."
    CONTENT_DIR=$(grep "^CONTENT_DIR=" "$ENV_FILE" | cut -d= -f2 || echo "$APP_DIR/data")
    rm -rf "$CONTENT_DIR"/*
    success "Content data cleaned"

    echo ""
    success "MMRC has been reset to clean state."
    info "Configuration preserved in $APP_DIR/.env"
    info "Run 'mmrc pull && mmrc start' to start fresh."
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
    echo "$profiles"
}

cmd_start() {
    require_installed
    detect_compose
    cd "$APP_DIR"
    info "Starting MMRC services..."
    PROFILES=$(get_compose_profiles)
    $COMPOSE $PROFILES up -d
    success "Services started"
}

cmd_stop() {
    require_installed
    detect_compose
    cd "$APP_DIR"
    info "Stopping MMRC services..."
    PROFILES=$(get_compose_profiles)
    $COMPOSE $PROFILES down
    success "Services stopped"
}

cmd_restart() {
    require_installed
    detect_compose
    cd "$APP_DIR"
    info "Restarting MMRC services..."
    PROFILES=$(get_compose_profiles)
    $COMPOSE $PROFILES restart
    success "Services restarted"
}

cmd_status() {
    require_installed
    detect_compose
    cd "$APP_DIR"
    echo ""
    colorized_echo cyan "╔══════════════════════════════════════╗"
    colorized_echo cyan "║         📊 MMRC Status               ║"
    colorized_echo cyan "╚══════════════════════════════════════╝"
    echo ""
    $COMPOSE ps
    echo ""

    # Health check
    if curl -fsS http://localhost:80/health >/dev/null 2>&1; then
        success "Server is healthy"
    else
        warn "Server is not responding on port 80"
    fi

    # Database info
    DB_TYPE_VAL=$(grep "^DB_TYPE=" "$ENV_FILE" | cut -d= -f2)
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
    CONTENT_DIR=$(grep "^CONTENT_DIR=" "$ENV_FILE" | cut -d= -f2)
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

    if [ -n "$1" ]; then
        PROFILES=$(get_compose_profiles)
        case $1 in
            server|mmrc) $COMPOSE $PROFILES logs -f mmrc ;;
            postgres|db) $COMPOSE $PROFILES logs -f postgres ;;
            redis) $COMPOSE logs -f redis ;;
            minio|s3) $COMPOSE $PROFILES logs -f minio ;;
            streamer) $COMPOSE $PROFILES logs -f streamer ;;
            converter) $COMPOSE logs -f converter 2>/dev/null || warn "Converter service not running" ;;
            *) $COMPOSE $PROFILES logs -f "$1" ;;
        esac
    else
        PROFILES=$(get_compose_profiles)
        $COMPOSE $PROFILES logs -f
    fi
}

cmd_update() {
    require_installed
    detect_compose

    colorized_echo cyan "
╔══════════════════════════════════════════╗
║         🔄 MMRC Updater                  ║
╚══════════════════════════════════════════╝
"

    cd "$APP_DIR"
    PROFILES=$(get_compose_profiles)

    # Backup
    info "Creating backup..."
    DB_TYPE_VAL=$(grep "^DB_TYPE=" "$ENV_FILE" | cut -d= -f2)
    if [ "$DB_TYPE_VAL" = "postgres" ]; then
        info "PostgreSQL backup requires pg_dump - skipping automatic backup"
        warn "Use pg_dump manually to backup the database"
    elif [ -f "$APP_DIR/config/main.db" ]; then
        cp "$APP_DIR/config/main.db" "$APP_DIR/config/main.db.backup.$(date +%F)"
        success "Database backed up"
    fi

    # Pull new images
    info "Pulling latest Docker images..."
    $COMPOSE $PROFILES pull
    docker pull "${CONVERTER_IMAGE}:${DOCKER_IMAGE_TAG}" 2>/dev/null || warn "Converter image not available (non-critical)"
    docker pull "${FFMPEG_IMAGE}:${DOCKER_IMAGE_TAG}" 2>/dev/null || warn "FFmpeg image not available (non-critical)"
    docker pull "${STREAMER_IMAGE}:${DOCKER_IMAGE_TAG}" 2>/dev/null || warn "Streamer image not available (non-critical)"
    success "Images updated"

    # Restart services
    info "Restarting services..."
    $COMPOSE $PROFILES up -d
    success "Services restarted"

    # Wait for health
    info "Waiting for server to be ready..."
    sleep 10

    if curl -fsS http://localhost:80/health >/dev/null 2>&1; then
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
╔══════════════════════════════════════════╗
║         💾 MMRC Backup                   ║
╚══════════════════════════════════════════╝
"

    # Backup databases
    info "Backing up databases..."
    cd "$APP_DIR"

    DB_TYPE_VAL=$(grep "^DB_TYPE=" "$ENV_FILE" | cut -d= -f2)
    if [ "$DB_TYPE_VAL" = "postgres" ]; then
        # PostgreSQL backup via pg_dump
        DB_HOST=$(grep "^DB_HOST=" "$ENV_FILE" | cut -d= -f2)
        DB_PORT=$(grep "^DB_PORT=" "$ENV_FILE" | cut -d= -f2)
        DB_NAME=$(grep "^DB_NAME=" "$ENV_FILE" | cut -d= -f2)
        DB_USER=$(grep "^DB_USER=" "$ENV_FILE" | cut -d= -f2)
        DB_PASSWORD=$(grep "^DB_PASSWORD=" "$ENV_FILE" | cut -d= -f2)

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
        $COMPOSE $PROFILES exec -T mmrc sqlite3 /app/config/main.db \
            ".backup '/tmp/main-${TIMESTAMP}.db'" 2>/dev/null && \
        $COMPOSE $PROFILES cp "mmrc:/tmp/main-${TIMESTAMP}.db" "$BACKUP_DIR/main-${TIMESTAMP}.db" && \
        $COMPOSE $PROFILES exec -T mmrc rm "/tmp/main-${TIMESTAMP}.db" 2>/dev/null && \
        success "Main database backed up" || \
        warn "Main database backup failed"

        $COMPOSE $PROFILES exec -T mmrc sqlite3 /app/config/hero/heroes.db \
            ".backup '/tmp/heroes-${TIMESTAMP}.db'" 2>/dev/null && \
        $COMPOSE $PROFILES cp "mmrc:/tmp/heroes-${TIMESTAMP}.db" "$BACKUP_DIR/heroes-${TIMESTAMP}.db" && \
        $COMPOSE $PROFILES exec -T mmrc rm "/tmp/heroes-${TIMESTAMP}.db" 2>/dev/null && \
        success "Heroes database backed up" || \
        warn "Heroes database backup failed"
    fi

    # Backup config
    tar -czf "$BACKUP_DIR/config-${TIMESTAMP}.tar.gz" -C "$APP_DIR" .env docker-compose.yml 2>/dev/null || true
    success "Configuration backed up"

    echo ""
    info "Backups saved to: $BACKUP_DIR"
    ls -lh "$BACKUP_DIR" | tail -5
}

cmd_ssl() {
    check_root
    require_installed
    detect_compose

    colorized_echo cyan "
╔══════════════════════════════════════════╗
║         🔐 MMRC SSL Setup                ║
╚══════════════════════════════════════════╝
"

    cd "$APP_DIR"

    read -p "Enter your domain: " domain < /dev/tty
    if [ -z "$domain" ]; then
        error "Domain is required"
        exit 1
    fi

    # In Docker mode, stop MMRC to free port 80 for acme.sh standalone
    info "Stopping MMRC to free port 80..."
    $COMPOSE down

    # Install acme.sh as root
    if ! command -v acme.sh >/dev/null 2>&1; then
        info "Installing acme.sh..."
        cd /root
        curl -s https://get.acme.sh | sh
        export PATH="/root/.acme.sh:$PATH"
    fi

    if ! command -v acme.sh >/dev/null 2>&1; then
        error "acme.sh installation failed. Install manually: curl -s https://get.acme.sh | sh"
        exit 1
    fi

    # Issue certificate
    info "Issuing SSL certificate for $domain..."
    acme.sh --issue -d "$domain" --standalone --force

    if [ $? -eq 0 ]; then
        # Create SSL directory
        mkdir -p "$DATA_DIR/certs/$domain"

        # Install certificate
        acme.sh --install-cert -d "$domain" \
            --key-file "$DATA_DIR/certs/$domain/privkey.pem" \
            --fullchain-file "$DATA_DIR/certs/$domain/fullchain.pem" \
            --reloadcmd "cp \$CERT_KEY \$CERT_FULLCHAIN $DATA_DIR/certs/$domain/"

        success "SSL certificate installed!"
        info "Certificate: $DATA_DIR/certs/$domain/fullchain.pem"
        info "Key: $DATA_DIR/certs/$domain/privkey.pem"

        # Write SSL config to .env
        replace_or_append_env "SSL_DOMAIN" "$domain"
        replace_or_append_env "SSL_CERT" "$DATA_DIR/certs/$domain/fullchain.pem"
        replace_or_append_env "SSL_KEY" "$DATA_DIR/certs/$domain/privkey.pem"

        info "Starting MMRC back..."
        $COMPOSE up -d

        info "SSL certificate will be used after you configure nginx for HTTPS."
        info "See: https://github.com/ya-k0v/MMRC/wiki/SSL"
    else
        error "Failed to issue certificate"
        info "Starting MMRC back..."
        $COMPOSE up -d
        exit 1
    fi
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
╔══════════════════════════════════════════╗
║      ⚠️  MMRC Uninstall                  ║
║   THIS WILL DELETE ALL DATA!             ║
╚══════════════════════════════════════════╝
"

    read -p "Are you sure? Type 'yes' to confirm: " confirm < /dev/tty
    if [ "$confirm" != "yes" ]; then
        info "Aborted"
        exit 0
    fi

    detect_compose
    cd "$APP_DIR"

    info "Stopping services..."
    $COMPOSE down -v
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
            EDITOR=nano
        elif command -v vi >/dev/null 2>&1; then
            EDITOR=vi
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

cmd_help() {
    colorized_echo cyan "
╔══════════════════════════════════════════════════════╗
║              📺 MMRC CLI                             ║
║         Media Management & Remote Control            ║
╚══════════════════════════════════════════════════════╝

Usage: mmrc <command> [options]

Commands:
  install          Install MMRC with Docker
  reinstall        Reinstall MMRC (preserves config)
  start            Start MMRC services
  stop             Stop MMRC services
  restart          Restart MMRC services
  status           Check services status
  ps               List containers (docker compose ps)
  logs [service]   View logs (server|postgres|redis|minio|streamer)
  pull             Pull latest Docker images
  update           Update to latest version
  down             Stop and remove containers
  reset            Reset to clean state (removes all data, keeps config)
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
    backup) cmd_backup ;;
    ssl) cmd_ssl ;;
    shell) cmd_shell "${@:2}" ;;
    edit-env) cmd_edit_env ;;
    uninstall) cmd_uninstall ;;
    help|--help|-h) cmd_help ;;
    *)
        error "Unknown command: $1"
        cmd_help
        exit 1
        ;;
esac
