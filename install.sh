#!/usr/bin/env bash
set -e

# MMRC One-Command Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/ya-k0v/MMRC/v330/install.sh | bash

# ========================
# Configuration
# ========================
MMRC_REPO="https://github.com/ya-k0v/MMRC"
MMRC_RAW="https://raw.githubusercontent.com/ya-k0v/MMRC/v330"
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
        read -p "  Choose [1-2]: " db_choice < /dev/tty
        echo ""
        case "$db_choice" in
            2) DB_TYPE="postgres" ;;
            *) DB_TYPE="sqlite" ;;
        esac
    fi

    # PostgreSQL connection defaults
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

# ========================
# Installation
# ========================

install_mmrc() {
    check_root
    check_docker

    # Ensure consistent working directory (fixes 'getcwd' errors with curl|sudo bash)
    cd /

    colorized_echo cyan "
╔══════════════════════════════════════════╗
║          📺 MMRC Installer               ║
║     Media Management & Remote Control    ║
║           Version 3.3.0                  ║
╚══════════════════════════════════════════╝
"

    # Select database type first
    select_database

    # Create directories
    mkdir -p "$INSTALL_DIR" "$DATA_DIR"
    success "Directories created"

    # Download docker-compose.yml with progress
    info "Downloading docker-compose.yml..."
    curl -# -L -o "$COMPOSE_FILE" "$MMRC_RAW/docker-compose.deploy.yml"
    success "docker-compose.yml downloaded"

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
# JWT_SECRET is written separately below to ensure it works with curl|bash
JWT_ACCESS_EXPIRES_IN=12h
JWT_REFRESH_EXPIRES_IN=30d

# Database type: sqlite | postgres
DB_TYPE=$DB_TYPE
ENVEOF
    # Write JWT_SECRET separately to ensure it's set (fix for curl|bash pipe)
    echo "JWT_SECRET=$JWT_SECRET" >> "$ENV_FILE"

    # Continue writing the rest of .env
    cat >> "$ENV_FILE" << 'ENVEOF2'
# Server
SERVER_PORT=3000
SERVER_URL=http://mmrc:3000
ADMIN_INTERNAL_API_URL=http://mmrc:3000

# Database
WAL_CHECKPOINT_INTERVAL_MS=300000

# Night Optimization
NIGHT_OPT_START_HOUR=1
NIGHT_OPT_END_HOUR=5

# Resource Limits
JOB_RESERVE_CPU_PERCENT=30
JOB_RESERVE_MEMORY_MB=2048
JOB_MAX_SINGLE_JOB_PERCENT=70


STREAM_MAX_JOBS=100
STREAM_IDLE_TIMEOUT_MS=180000

# Content Storage (project dir by default)
CONTENT_DIR=/opt/mmrc/data

# Host data dir (for converter container volume mount)
HOST_DATA_DIR=/opt/mmrc/data

# Docker sibling containers
MMRC_DOCKER=1
CONVERTER_IMAGE=pingwin1900/mmrc-converter
FFMPEG_IMAGE=pingwin1900/mmrc-ffmpeg

# LDAP (optional)
LDAP_URL=
LDAP_BIND_DN=
LDAP_SEARCH_BASE=
ENVEOF2

    # Append PostgreSQL config if needed
    if [ "$DB_TYPE" = "postgres" ]; then
        cat >> "$ENV_FILE" << ENVEOF3

# PostgreSQL connection
DB_HOST=$DB_POSTGRES_HOST
DB_PORT=$DB_POSTGRES_PORT
DB_NAME=$DB_POSTGRES_DB
DB_USER=$DB_POSTGRES_USER
DB_PASSWORD=$DB_POSTGRES_PASSWORD
ENVEOF3
    fi
    success "Configuration generated"

    # Ask for content directory (reads from terminal, not stdin pipe)
    echo ""
    colorized_echo yellow "📁 Where do you want to store media content?"
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
    chown -R 1001:1001 "$content_dir" 2>/dev/null || true
    success "Content directory: $content_dir"

    # Pull images with progress
    echo ""
    info "Pulling Docker images..."
    cd "$INSTALL_DIR"
    $COMPOSE pull
    docker pull "pingwin1900/mmrc-converter:v330" 2>/dev/null || warn "Converter image not available (non-critical)"
    docker pull "pingwin1900/mmrc-ffmpeg:v330" 2>/dev/null || warn "FFmpeg image not available (non-critical)"
    success "Images pulled"

    # Start services with progress
    info "Starting MMRC services..."
    PROFILES=""
    if [ "$DB_TYPE" = "postgres" ] && [ "$POSTGRES_SOURCE" = "docker" ]; then
        PROFILES="--profile postgres"
    fi
    $COMPOSE $PROFILES up -d
    success "Services started"

    # Wait for health with progress
    info "Waiting for server to be ready..."
    local check_port=80
    for i in $(seq 1 15); do
        printf "\r  Waiting... %ds" "$i"
        sleep 1
        if curl -fsS http://localhost:${check_port}/health >/dev/null 2>&1; then
            echo ""
            success "Server is ready"
            break
        fi
        if [ $i -eq 15 ]; then
            echo ""
            warn "Server may still be starting. Check logs: mmrc logs"
        fi
    done

    # Get server IP
    info "Detecting server IP..."
    SERVER_IP=$(curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
    success "Server IP: ${SERVER_IP}"

    # Install CLI with progress
    info "Installing MMRC CLI..."
    curl -# -L -o "$BIN_DIR/mmrc" "$MMRC_RAW/mmrc.sh"
    chmod +x "$BIN_DIR/mmrc"
    success "CLI installed: mmrc"

    echo ""
    colorized_echo cyan "╔════════════════════════════════════════════════════════════════════════════════════════════════════╗"
    box_line "                                                  🎉 MMRC Installed Successfully!                                                  "
    colorized_echo cyan "╠════════════════════════════════════════════════════════════════════════════════════════════════════╣"
    box_line ""
    box_line "  📺 Admin Panel:                         http://localhost:80/admin.html"
    box_line "  🎤 Speaker Panel:                       http://localhost:80/speaker.html"
    box_line "  🎖️  Hero Module:                         http://localhost:80/hero/"
    box_line "  ❤️  Health Check:                        http://localhost:80/health"
    box_line ""
    box_line "  🌐 From network:                        http://${SERVER_IP}:80/"
    box_line ""
    box_line "  👤 Default login:                       admin / admin123"
    box_line "  ⚠️  CHANGE PASSWORD after first login!"
    box_line ""
    box_line "  📁 Config:                              $INSTALL_DIR/.env"
    box_line "  💾 Data:                                $DATA_DIR"
    box_line "  📦 Media:                               $content_dir"
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
