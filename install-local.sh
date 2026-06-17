#!/usr/bin/env bash
set -e

# MMRC Local Installer
# Usage: sudo bash install-local.sh
# Uses local files from the repo directory instead of downloading from GitHub.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MMRC_VERSION="3.4.0"
MMRC_BRANCH="v340"
MMRC_DOCKER_TAG="v340"
MMRC_DOCKER_IMAGE="pingwin1900/mmrc"
MMRC_CONVERTER_IMAGE="pingwin1900/mmrc-converter"
MMRC_FFMPEG_IMAGE="pingwin1900/mmrc-ffmpeg"
MMRC_STREAMER_IMAGE="pingwin1900/mmrc-streamer"

INSTALL_DIR="/opt/mmrc"
DATA_DIR="/var/lib/mmrc"
BIN_DIR="/usr/local/bin"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
ENV_FILE="$INSTALL_DIR/.env"

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

box_line() {
    local content="$1"
    local box_width=100
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

retry() {
    local attempts=$1
    local delay=$2
    local cmd="${*:3}"
    local i
    for i in $(seq 1 "$attempts"); do
        if eval "$cmd"; then
            return 0
        fi
        if [ "$i" -lt "$attempts" ]; then
            warn "Command failed (attempt $i/$attempts). Retrying in ${delay}s..."
            sleep "$delay"
        fi
    done
    return 1
}

check_root() {
    if [ "$(id -u)" != "0" ]; then
        error "This script must be run as root."
        exit 1
    fi
}

check_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        colorized_echo yellow "  Docker not found. Installing..."
        echo ""
        colorized_echo blue "  Downloading Docker installer..."
        local TMP_SCRIPT=$(mktemp /tmp/get-docker.XXXXXX.sh)
        if ! curl -fsSL --connect-timeout 10 --max-time 120 https://get.docker.com -o "$TMP_SCRIPT" 2>&1; then
            error "Failed to download Docker installer. Check your internet connection."
            rm -f "$TMP_SCRIPT"
            exit 1
        fi
        success "Installer downloaded"
        echo ""
        echo "  [Docker Installation]"
        echo "  ---------------------"
        local install_output
        if ! install_output=$(sh "$TMP_SCRIPT" 2>&1); then
            error "Docker installation failed!"
            echo "$install_output"
            rm -f "$TMP_SCRIPT"
            exit 1
        fi
        rm -f "$TMP_SCRIPT"
        if ! command -v docker >/dev/null 2>&1; then
            error "Docker command not found after installation."
            exit 1
        fi
        success "Docker installed: $(docker --version)"
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

select_database() {
    DB_TYPE="${DB_TYPE:-}"
    if [ -z "$DB_TYPE" ]; then
        echo ""
        colorized_echo yellow "Select database type:"
        echo "  [1] SQLite (built-in, no setup required)"
        echo "  [2] PostgreSQL (via Docker, separate container)"
        read -p "  Choose [1-2]: " db_choice < /dev/tty
        echo ""
        case "$db_choice" in
            2) DB_TYPE="postgres" ;;
            *) DB_TYPE="sqlite" ;;
        esac
    fi

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
            read -p "  Choose [1-2]: " pg_choice < /dev/tty
            echo ""
            case "$pg_choice" in
                2) POSTGRES_SOURCE="existing" ;;
                *) POSTGRES_SOURCE="docker" ;;
            esac
        fi

        if [ "$POSTGRES_SOURCE" = "existing" ]; then
            echo "  Using existing PostgreSQL database..."
            read -p "  PostgreSQL host [$DB_POSTGRES_HOST]: " pg_host_input < /dev/tty
            DB_POSTGRES_HOST="${pg_host_input:-$DB_POSTGRES_HOST}"
            read -p "  PostgreSQL port [$DB_POSTGRES_PORT]: " pg_port_input < /dev/tty
            DB_POSTGRES_PORT="${pg_port_input:-$DB_POSTGRES_PORT}"
            read -p "  PostgreSQL database name [$DB_POSTGRES_DB]: " pg_db_input < /dev/tty
            DB_POSTGRES_DB="${pg_db_input:-$DB_POSTGRES_DB}"
            read -p "  PostgreSQL user [$DB_POSTGRES_USER]: " pg_user_input < /dev/tty
            DB_POSTGRES_USER="${pg_user_input:-$DB_POSTGRES_USER}"
            while [ -z "$DB_POSTGRES_PASSWORD" ]; do
                read -s -p "  PostgreSQL password (required): " pg_pass_input < /dev/tty
                echo ""
                DB_POSTGRES_PASSWORD="${pg_pass_input:-}"
                if [ -z "$DB_POSTGRES_PASSWORD" ]; then
                    echo "  Password cannot be empty!"
                fi
            done
            success "Using existing PostgreSQL at ${DB_POSTGRES_HOST}:${DB_POSTGRES_PORT}/${DB_POSTGRES_DB}"
        else
            echo "  Setting up PostgreSQL via Docker..."
            if [ -z "$DB_POSTGRES_PASSWORD" ]; then
                DB_POSTGRES_PASSWORD="mmrc"
                warn "Using default password: mmrc"
            fi
            success "PostgreSQL will be started as Docker container mmrc-postgres"
        fi
    fi
}

select_storage() {
    STORAGE_BACKEND="${STORAGE_BACKEND:-local}"
    if [ "$DB_TYPE" != "postgres" ]; then
        return
    fi

    if [ "$STORAGE_BACKEND" = "local" ]; then
        echo ""
        colorized_echo yellow "Select storage backend:"
        echo "  [1] Local filesystem (built-in, no setup required)"
        echo "  [2] S3/MinIO (via Docker, separate container)"
        read -p "  Choose [1-2]: " s3_choice < /dev/tty
        echo ""
        case "$s3_choice" in
            2) STORAGE_BACKEND="s3" ;;
            *) STORAGE_BACKEND="local" ;;
        esac
    fi

    S3_ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"
    S3_SECRET_KEY="${S3_SECRET_KEY:-minioadmin}"
}

install_mmrc() {
    check_root
    check_docker

    unset COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_PATH_SEPARATOR 2>/dev/null || true
    cd /

    colorized_echo cyan "
╔══════════════════════════════════════════╗
║          MMRC Installer (local)          ║
║     Media Management & Remote Control    ║
║           Version ${MMRC_VERSION}                ║
╚══════════════════════════════════════════╝
"

    select_database
    select_storage

    mkdir -p "$INSTALL_DIR" "$DATA_DIR"
    success "Directories created"

    # Copy docker-compose.deploy.yml from local repo
    info "Copying docker-compose.yml..."
    if [ -f "$SCRIPT_DIR/docker-compose.deploy.yml" ]; then
        cp "$SCRIPT_DIR/docker-compose.deploy.yml" "$COMPOSE_FILE"
    elif [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
        cp "$SCRIPT_DIR/docker-compose.yml" "$COMPOSE_FILE"
    else
        error "docker-compose.yml not found in $SCRIPT_DIR"
        exit 1
    fi

    local compose_size
    compose_size=$(stat -c%s "$COMPOSE_FILE" 2>/dev/null || stat -f%z "$COMPOSE_FILE" 2>/dev/null || wc -c < "$COMPOSE_FILE")
    if [ "$compose_size" -lt 100 ]; then
        error "Compose file is only $compose_size bytes"
        exit 1
    fi
    success "docker-compose.yml copied ($compose_size bytes)"

    # Generate .env
    info "Generating configuration..."
    JWT_SECRET=$(openssl rand -hex 64)
    cat > "$ENV_FILE" << ENVEOF
# MMRC Configuration
# Generated on $(date)

NODE_ENV=production
LOG_LEVEL=info
SILENT_CONSOLE=false

# JWT Authentication
JWT_ACCESS_EXPIRES_IN=12h
JWT_REFRESH_EXPIRES_IN=30d

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
DB_PASSWORD=mmrc

WAL_CHECKPOINT_INTERVAL_MS=300000

# Night Optimization
NIGHT_OPT_START_HOUR=1
NIGHT_OPT_END_HOUR=5

# Resource Limits
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
DOCKER_IMAGE=$MMRC_DOCKER_IMAGE
DOCKER_IMAGE_TAG=$MMRC_DOCKER_TAG
CONVERTER_IMAGE=$MMRC_CONVERTER_IMAGE
FFMPEG_IMAGE=$MMRC_FFMPEG_IMAGE
STREAMER_IMAGE=$MMRC_STREAMER_IMAGE
MMRC_STREAMER_ENABLED=false

# Redis
REDIS_URL=redis://mmrc-redis:6379

# Storage Backend: local | s3
STORAGE_BACKEND=$STORAGE_BACKEND
S3_ENDPOINT=http://mmrc-minio:9000
S3_REGION=us-east-1
S3_BUCKET=mmrc
S3_ACCESS_KEY=${S3_ACCESS_KEY:-minioadmin}
S3_SECRET_KEY=${S3_SECRET_KEY:-minioadmin}
S3_FORCE_PATH_STYLE=true

# MinIO root credentials
MINIO_ROOT_USER=${S3_ACCESS_KEY:-minioadmin}
MINIO_ROOT_PASSWORD=${S3_SECRET_KEY:-minioadmin}

# LDAP (optional)
LDAP_URL=
LDAP_BIND_DN=
LDAP_SEARCH_BASE=
ENVEOF2

    if [ "$DB_TYPE" = "postgres" ]; then
        cat >> "$ENV_FILE" << ENVEOF3

# PostgreSQL connection (overrides above)
DB_HOST=$DB_POSTGRES_HOST
DB_PORT=$DB_POSTGRES_PORT
DB_NAME=$DB_POSTGRES_DB
DB_USER=$DB_POSTGRES_USER
DB_PASSWORD=$DB_POSTGRES_PASSWORD
ENVEOF3
    fi
    success "Configuration generated"

    # Ask for content directory
    echo ""
    colorized_echo yellow "Where do you want to store media content?"
    echo ""
    echo "  Default: project directory ($INSTALL_DIR/data)"
    echo "  External disk: /mnt/mmrc-content"
    echo "  Custom path: /your/path"
    echo ""
    content_dir=""
    while [ -z "$content_dir" ]; do
        read -p "  Enter path [default: project dir]: " content_dir < /dev/tty
        if [ -z "$content_dir" ]; then
            content_dir="$INSTALL_DIR/data"
        fi
    done

    sed -i "s|^CONTENT_DIR=.*|CONTENT_DIR=${content_dir}|" "$ENV_FILE"
    sed -i "s|^HOST_DATA_DIR=.*|HOST_DATA_DIR=${content_dir}|" "$ENV_FILE"
    mkdir -p "$content_dir"/{db,content,streams,converted/trailers,logs,temp,hero}
    if [ "$STORAGE_BACKEND" = "s3" ]; then
        mkdir -p "$content_dir/minio"
    fi
    chown -R 1001:1001 "$content_dir" 2>/dev/null || true
    success "Content directory: $content_dir"

    # Init HA vars
    COMPOSE_HA=""
    HA_SCALE=""

    # Ask about HA
    if [ "$DB_TYPE" = "postgres" ] && [ "$STORAGE_BACKEND" = "s3" ]; then
        echo ""
        colorized_echo yellow "Enable High-Availability (multiple server replicas)?"
        echo "  Runs 2+ server instances behind an nginx load balancer."
        echo "  Requires PostgreSQL + S3 (already selected)."
        read -p "  Enable HA? [y/N]: " ha_choice < /dev/tty
        if [[ "$ha_choice" =~ ^[Yy]$ ]]; then
            HA_ENABLED=true
            HA_REPLICAS=""
            while [ -z "$HA_REPLICAS" ] || [ "$HA_REPLICAS" -lt 1 ] 2>/dev/null; do
                read -p "  Number of replicas [2]: " ha_replicas_input < /dev/tty
                ha_replicas_input="${ha_replicas_input:-2}"
                if [ "$ha_replicas_input" -ge 1 ] 2>/dev/null; then
                    HA_REPLICAS=$ha_replicas_input
                fi
            done

            info "Copying HA configuration..."
            if [ -f "$SCRIPT_DIR/docker-compose.ha.yml" ]; then
                cp "$SCRIPT_DIR/docker-compose.ha.yml" "$INSTALL_DIR/docker-compose.ha.yml"
            else
                error "docker-compose.ha.yml not found in $SCRIPT_DIR"
                exit 1
            fi
            mkdir -p "$INSTALL_DIR/docker/nginx"
            if [ -f "$SCRIPT_DIR/docker/nginx/ha-lb.conf" ]; then
                cp "$SCRIPT_DIR/docker/nginx/ha-lb.conf" "$INSTALL_DIR/docker/nginx/ha-lb.conf"
            else
                error "docker/nginx/ha-lb.conf not found in $SCRIPT_DIR"
                exit 1
            fi
            success "HA configuration copied"

            COMPOSE_HA="-f docker-compose.yml -f docker-compose.ha.yml"
            HA_SCALE="--scale mmrc-replica=$HA_REPLICAS"
            success "HA enabled with $HA_REPLICAS replicas"
        fi
    fi

    # Ask about Streamer
    echo ""
    colorized_echo yellow "Enable Streamer (remote FFmpeg for HLS streaming)?"
    echo "  This runs FFmpeg in a separate container for better isolation."
    echo "  Default: disabled"
    read -p "  Enable Streamer? [y/N]: " streamer_choice < /dev/tty
    if [[ "$streamer_choice" =~ ^[Yy]$ ]]; then
        STREAMER_ENABLED=true
        sed -i "s|^MMRC_STREAMER_ENABLED=.*|MMRC_STREAMER_ENABLED=true|" "$ENV_FILE"
        success "Streamer enabled"
    else
        STREAMER_ENABLED=false
    fi

    # Validate compose config
    echo ""
    info "Validating Docker Compose configuration..."
    cd "$INSTALL_DIR"
    if ! $COMPOSE $COMPOSE_HA config > /dev/null 2>&1; then
        echo ""
        warn "Compose validation failed."
        $COMPOSE $COMPOSE_HA config 2>&1 || true
        echo ""
        error "Docker Compose configuration is invalid."
        exit 1
    fi
    success "Compose configuration valid"

    # Pull images
    echo ""
    info "Pulling Docker images..."
    retry 3 10 "$COMPOSE $COMPOSE_HA pull" || warn "Some compose images failed to pull"
    retry 3 10 "docker pull ${MMRC_CONVERTER_IMAGE}:${MMRC_DOCKER_TAG}" || warn "Converter image not available (non-critical)"
    retry 3 10 "docker pull ${MMRC_FFMPEG_IMAGE}:${MMRC_DOCKER_TAG}" || warn "FFmpeg image not available (non-critical)"
    if [ "$STREAMER_ENABLED" = "true" ]; then
        retry 3 10 "docker pull ${MMRC_STREAMER_IMAGE}:${MMRC_DOCKER_TAG}" || warn "Streamer image not available (non-critical)"
    fi
    success "Images pulled"

    # Install CLI from local file
    info "Installing MMRC CLI..."
    if [ -f "$SCRIPT_DIR/mmrc.sh" ]; then
        cp "$SCRIPT_DIR/mmrc.sh" "$BIN_DIR/mmrc"
        chmod +x "$BIN_DIR/mmrc"
        success "CLI installed: mmrc"
    else
        warn "mmrc.sh not found in $SCRIPT_DIR"
    fi

    # Start services
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

    if retry 3 10 "$COMPOSE $COMPOSE_HA $PROFILES up -d $HA_SCALE"; then
        success "Services started"
    else
        warn "Some services failed to start (check port conflicts with: mmrc logs)"
    fi

    # Wait for health
    info "Waiting for server to be ready..."
    local check_port=80
    local server_ready=false
    for i in $(seq 1 30); do
        printf "\r  Waiting... %ds" "$i"
        if curl -fsS http://localhost:${check_port}/health >/dev/null 2>&1; then
            echo ""
            success "Server is ready"
            server_ready=true
            break
        fi
        sleep 1
    done
    if [ "$server_ready" = false ]; then
        echo ""
        warn "Server health check timed out. Use 'mmrc logs' to investigate."
    fi

    # Get server IP
    info "Detecting server IP..."
    SERVER_IP=$(curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

    echo ""
    colorized_echo cyan "╔════════════════════════════════════════════════════════════════════════════════════════════════════╗"
    box_line "                                                  MMRC Installed Successfully!                                                  "
    colorized_echo cyan "╠════════════════════════════════════════════════════════════════════════════════════════════════════╣"
    box_line ""
    box_line "  Admin Panel:                         http://localhost:80/admin.html"
    box_line "  Speaker Panel:                       http://localhost:80/speaker.html"
    box_line "  Hero Module:                         http://localhost:80/hero/"
    box_line "  Health Check:                        http://localhost:80/health"
    box_line ""
    box_line "  From network:                        http://${SERVER_IP}:80/"
    box_line ""
    box_line "  Default login:                       admin / admin123"
    box_line "  CHANGE PASSWORD after first login!"
    box_line ""
    box_line "  Config:                              $INSTALL_DIR/.env"
    box_line "  Data:                                $DATA_DIR"
    box_line "  Media:                               $content_dir"
    box_line ""
    colorized_echo cyan "╚════════════════════════════════════════════════════════════════════════════════════════════════════╝"
    echo ""
    info "Useful commands:"
    echo "   mmrc status    - Check services status"
    echo "   mmrc logs      - View logs"
    echo "   mmrc stop      - Stop services"
    echo "   mmrc update    - Update to latest version"
    echo "   mmrc backup    - Create backup"
    echo ""
}

install_mmrc
