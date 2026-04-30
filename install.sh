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
        info "Docker not found. Installing..."
        curl -fsSL https://get.docker.com | sh
        success "Docker installed"
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

    # Download docker-compose.yml
    info "Downloading docker-compose.yml..."
    curl -fsSL -o "$COMPOSE_FILE" "$MMRC_RAW/docker-compose.deploy.yml"
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

    # Ask about content directory
    echo ""
    colorized_echo yellow "Where do you want to store media content?"
    colorized_echo yellow "Default: /mnt/mmrc-content"
    read -p "Enter path (or press Enter for default): " content_dir
    content_dir="${content_dir:-/mnt/mmrc-content}"
    
    # Update content dir in .env
    sed -i "s|^CONTENT_DIR=.*|CONTENT_DIR=${content_dir}|" "$ENV_FILE"
    mkdir -p "$content_dir"
    success "Content directory created: $content_dir"

    # Pull images
    echo ""
    info "Pulling Docker images..."
    cd "$INSTALL_DIR"
    $COMPOSE pull
    success "Images pulled"

    # Start services
    info "Starting MMRC services..."
    $COMPOSE up -d
    success "Services started"

    # Wait for health
    info "Waiting for server to be ready..."
    sleep 10

    # Get server IP
    SERVER_IP=$(curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

    # Install CLI
    info "Installing MMRC CLI..."
    curl -fsSL -o "$BIN_DIR/mmrc" "$MMRC_RAW/mmrc.sh"
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
