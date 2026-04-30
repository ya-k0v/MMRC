#!/usr/bin/env bash
set -e

# MMRC One-Command Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/ya-k0v/MMRC/main/install.sh | bash

# ========================
# Configuration
# ========================
MMRC_REPO="https://github.com/ya-k0v/MMRC"
MMRC_RAW="https://raw.githubusercontent.com/ya-k0v/MMRC/main"
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
# Installation
# ========================

install_mmrc() {
    check_root
    check_docker

    colorized_echo cyan "
╔══════════════════════════════════════════╗
║          📺 MMRC Installer               ║
║     Media Management & Remote Control    ║
║           Version 3.2.1                  ║
╚══════════════════════════════════════════╝
"

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
JWT_SECRET=${JWT_SECRET}
JWT_ACCESS_EXPIRES_IN=12h
JWT_REFRESH_EXPIRES_IN=30d

# Server
SERVER_PORT=3000

# Database
WAL_CHECKPOINT_INTERVAL_MS=300000

# Night Optimization
NIGHT_OPT_START_HOUR=1
NIGHT_OPT_END_HOUR=5

# Resource Limits
JOB_RESERVE_CPU_PERCENT=30
JOB_RESERVE_MEMORY_MB=2048
JOB_MAX_SINGLE_JOB_PERCENT=70

# Optimizer Worker
OPTIMIZER_CPU_LIMIT=4.0
OPTIMIZER_MEMORY_LIMIT=8G

# Stream Worker
STREAMER_CPU_LIMIT=2.0
STREAMER_MEMORY_LIMIT=4G
STREAM_MAX_JOBS=100
STREAM_IDLE_TIMEOUT_MS=180000

# Content Storage (external disk)
CONTENT_DIR=/mnt/mmrc-content

# LDAP (optional)
LDAP_URL=
LDAP_BIND_DN=
LDAP_SEARCH_BASE=
ENVEOF
    success "Configuration generated"

    # Determine content directory
    # Use CONTENT_DIR env var if set, otherwise try interactive prompt, then default
    if [ -n "$CONTENT_DIR" ]; then
        content_dir="$CONTENT_DIR"
        info "Using content directory from environment: $content_dir"
    elif [ -t 0 ]; then
        echo ""
        colorized_echo yellow "📁 Where do you want to store media content?"
        read -p "   Enter path [default: /mnt/mmrc-content]: " content_dir < /dev/tty
        content_dir="${content_dir:-/mnt/mmrc-content}"
    else
        content_dir="/mnt/mmrc-content"
        warn "Non-interactive mode. Using default: $content_dir"
        info "Override: export CONTENT_DIR=/your/path before running install"
    fi
    
    sed -i "s|^CONTENT_DIR=.*|CONTENT_DIR=${content_dir}|" "$ENV_FILE"
    mkdir -p "$content_dir"
    success "Content directory created: $content_dir"

    # Pull images with progress
    echo ""
    info "Pulling Docker images..."
    cd "$INSTALL_DIR"
    $COMPOSE pull --quiet 2>/dev/null || $COMPOSE pull
    success "Images pulled"

    # Start services with progress
    info "Starting MMRC services..."
    $COMPOSE up -d
    success "Services started"

    # Wait for health with progress
    info "Waiting for server to be ready..."
    for i in $(seq 1 10); do
        printf "\r  Waiting... %ds" "$i"
        sleep 1
        if curl -fsS http://localhost:${SERVER_PORT:-3000}/health >/dev/null 2>&1; then
            echo ""
            success "Server is ready"
            break
        fi
        if [ $i -eq 10 ]; then
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
    colorized_echo cyan "╔══════════════════════════════════════════════════╗"
    colorized_echo cyan "║           🎉 MMRC Installed Successfully!        ║"
    colorized_echo cyan "╠══════════════════════════════════════════════════╣"
    colorized_echo cyan "║                                                  ║"
    colorized_echo cyan "║  📺 Admin Panel: http://${SERVER_IP}:3000/admin.html      ║"
    colorized_echo cyan "║  🎤 Speaker Panel: http://${SERVER_IP}:3000/speaker.html  ║"
    colorized_echo cyan "║  🎖️  Hero Module:   http://${SERVER_IP}:3000/hero/         ║"
    colorized_echo cyan "║  ❤️  Health Check:  http://${SERVER_IP}:3000/health        ║"
    colorized_echo cyan "║                                                  ║"
    colorized_echo cyan "║  👤 Default login: admin / admin123              ║"
    colorized_echo cyan "║  ⚠️  CHANGE PASSWORD after first login!          ║"
    colorized_echo cyan "║                                                  ║"
    colorized_echo cyan "║  📁 Config: $INSTALL_DIR/.env             ║"
    colorized_echo cyan "║  💾 Data:   $DATA_DIR                   ║"
    colorized_echo cyan "║  📦 Media:  $content_dir               ║"
    colorized_echo cyan "║                                                  ║"
    colorized_echo cyan "╚══════════════════════════════════════════════════╝"
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
