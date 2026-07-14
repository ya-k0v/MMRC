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
══════════════════════════════════════════
          📺 MMRC Installer               
     Media Management & Remote Control    
══════════════════════════════════════════
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

    read -p "Are you sure? Type 'reset' to confirm: " confirm < /dev/tty
    if [ "$confirm" != "reset" ]; then
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
    CONTENT_DIR=$(grep "^CONTENT_DIR=" "$ENV_FILE" | cut -d= -f2 || echo "$APP_DIR/data")
    rm -rf "$CONTENT_DIR"/*
    success "Content data cleaned"

    echo ""
    success "MMRC has been reset to clean state."
    info "Configuration preserved in $APP_DIR/.env"
    info "Run 'mmrc pull && mmrc start' to start fresh."
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
        [ "$HA_REPLICAS" -le 0 ] 2>/dev/null && HA_REPLICAS=1
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
    COMPOSE_HA=$(get_compose_ha)
    PROFILES=$(get_compose_profiles)

    if [ -n "$1" ]; then
        case $1 in
            server|mmrc) $COMPOSE $COMPOSE_HA $PROFILES logs -f mmrc ;;
            postgres|db) $COMPOSE $COMPOSE_HA $PROFILES logs -f postgres ;;
            redis) $COMPOSE $COMPOSE_HA $PROFILES logs -f redis ;;
            minio|s3) $COMPOSE $COMPOSE_HA $PROFILES logs -f minio ;;
            streamer) $COMPOSE $COMPOSE_HA $PROFILES logs -f streamer ;;
            converter) $COMPOSE $COMPOSE_HA $PROFILES logs -f converter 2>/dev/null || warn "Converter service not running" ;;
            replica) $COMPOSE $COMPOSE_HA $PROFILES logs -f mmrc-replica ;;
            ha-lb|nginx) $COMPOSE $COMPOSE_HA $PROFILES logs -f nginx-ha ;;
            *) $COMPOSE $COMPOSE_HA $PROFILES logs -f "$1" ;;
        esac
    else
        $COMPOSE $COMPOSE_HA $PROFILES logs -f
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
    [ "$HA_REPLICAS" -gt 0 ] 2>/dev/null && HA_SCALE="--scale mmrc-replica=$HA_REPLICAS"
    $COMPOSE $COMPOSE_HA $PROFILES up -d $HA_SCALE
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
══════════════════════════════════════════
            💾 MMRC Backup                   
══════════════════════════════════════════
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
══════════════════════════════════════════
         🔐 MMRC SSL Setup                
══════════════════════════════════════════
"

    cd "$APP_DIR"

    read -p "Enter your domain: " domain < /dev/tty
    if [ -z "$domain" ]; then
        error "Domain is required"
        exit 1
    fi

    # In Docker mode, stop MMRC to free port 80 for acme.sh standalone
    info "Stopping MMRC to free port 80..."
    COMPOSE_HA=$(get_compose_ha)
    PROFILES=$(get_compose_profiles)
    $COMPOSE $COMPOSE_HA $PROFILES down
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
        $COMPOSE $COMPOSE_HA $PROFILES up -d

        info "SSL certificate will be used after you configure nginx for HTTPS."
        info "See: https://github.com/ya-k0v/MMRC/wiki/SSL"
    else
        error "Failed to issue certificate"
        info "Starting MMRC back..."
        $COMPOSE $COMPOSE_HA $PROFILES up -d
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
══════════════════════════════════════════
            ⚠️  MMRC Uninstall                  
        THIS WILL DELETE ALL DATA!            
══════════════════════════════════════════
"

    read -p "Are you sure? Type 'yes' to confirm: " confirm < /dev/tty
    if [ "$confirm" != "yes" ]; then
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

warn_ha_sqlite() {
    local db_type
    db_type=$(grep "^DB_TYPE=" "$ENV_FILE" 2>/dev/null | cut -d= -f2)
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
            warn_ha_sqlite
            cd "$APP_DIR"

            if [ -f "docker-compose.ha.yml" ]; then
                warn "HA is already configured."
                read -p "  Re-download and reconfigure? [y/N]: " confirm < /dev/tty
                if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
                    info "Aborted"
                    exit 0
                fi
            fi

            HA_REPLICAS="${2:-2}"
            if [ "$HA_REPLICAS" -lt 1 ] 2>/dev/null; then
                error "Invalid replica count: $HA_REPLICAS"
                exit 1
            fi

            info "Downloading HA configuration..."
            local ha_yml_ok=false ha_lb_ok=false

            # Use existing file if it exists and is not the 70-byte 400 error page
            if [ -f "docker-compose.ha.yml" ] && [ "$(stat -c%s "docker-compose.ha.yml" 2>/dev/null || echo 0)" -gt 100 ]; then
                warn "GitHub download unavailable; using existing docker-compose.ha.yml"
                ha_yml_ok=true
            else
                if curl -fSL --connect-timeout 10 --max-time 30 -o "docker-compose.ha.yml" \
                    "https://raw.githubusercontent.com/ya-k0v/MMRC/${MMRC_BRANCH}/docker-compose.ha.yml" 2>/dev/null; then
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
                if curl -fSL --connect-timeout 10 --max-time 30 -o "docker/nginx/ha-lb.conf" \
                    "https://raw.githubusercontent.com/ya-k0v/MMRC/${MMRC_BRANCH}/docker/nginx/ha-lb.conf" 2>/dev/null; then
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
            if [ -z "$HA_REPLICAS" ] || [ "$HA_REPLICAS" -lt 1 ] 2>/dev/null; then
                error "Usage: mmrc ha scale <N> (N >= 1)"
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

            read -p "Remove HA and return to single-node mode? [y/N]: " confirm < /dev/tty
            if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
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
                if [ "$HA_REPLICAS" -gt 0 ] 2>/dev/null; then
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
  logs [service]   View logs (server|postgres|redis|minio|streamer|replica)
  pull             Pull latest Docker images
  update           Update to latest version
  down             Stop and remove containers
  reset            Reset to clean state (removes all data, keeps config)
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
    backup) cmd_backup ;;
    ssl) cmd_ssl ;;
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
