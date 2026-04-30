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
DOCKER_ORG="ya-k0v"
DOCKER_IMAGE="${DOCKER_ORG}/mmrc"

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
        info "Run 'mmrc update' to update."
        exit 0
    fi

    colorized_echo cyan "
╔══════════════════════════════════════════╗
║          📺 MMRC Installer               ║
║     Media Management & Remote Control    ║
╚══════════════════════════════════════════╝
"

    # Detect OS
    if [ -f /etc/os-release ]; then
        OS=$(awk -F= '/^NAME/{print $2}' /etc/os-release | tr -d '"')
    else
        error "Unsupported OS"
        exit 1
    fi
    info "Detected OS: $OS"

    # Check Docker
    if ! command -v docker >/dev/null 2>&1; then
        info "Docker not found. Installing..."
        curl -fsSL https://get.docker.com | sh
        success "Docker installed"
    else
        success "Docker found: $(docker --version)"
    fi

    detect_compose
    success "Docker Compose found"

    # Create directories
    mkdir -p "$APP_DIR" "$DATA_DIR"
    success "Directories created"

    # Download docker-compose.yml
    info "Downloading docker-compose.yml..."
    curl -fsSL -o "$COMPOSE_FILE" \
        "${MMRC_SCRIPTS_REPO}/raw/feature/v3.2.1/docker-compose.deploy.yml" || {
        error "Failed to download docker-compose.yml"
        exit 1
    }
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

# Nginx
NGINX_HTTP_PORT=80
NGINX_HTTPS_PORT=443

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
    colorized_echo yellow "📁 Where do you want to store media content?"
    colorized_echo yellow "Default: $APP_DIR/data/content"
    content_dir=""
    while [ -z "$content_dir" ]; do
        read -p "  Enter path [default: $APP_DIR/data/content]: " content_dir < /dev/tty
        if [ -z "$content_dir" ]; then
            content_dir="$APP_DIR/data/content"
        fi
    done
    replace_or_append_env "CONTENT_DIR" "$content_dir"

    # Create content directory
    mkdir -p "$content_dir"
    success "Content directory created: $content_dir"

    # SSL Setup
    echo ""
    colorized_echo yellow "Enable SSL (Let's Encrypt)?"
    read -p "  Enable SSL? [y/N]: " ssl_choice < /dev/tty
    if [[ "$ssl_choice" =~ ^[Yy]$ ]]; then
        read -p "  Enter domain: " ssl_domain < /dev/tty
        if [ -n "$ssl_domain" ]; then
            replace_or_append_env "SSL_DOMAIN" "$ssl_domain"
            info "SSL will be configured after first start"
        fi
    fi

    # Pull images
    echo ""
    info "Pulling Docker images..."
    cd "$APP_DIR"
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
    colorized_echo cyan "║  📁 Config: $APP_DIR/.env                ║"
    colorized_echo cyan "║  💾 Data:   $DATA_DIR                  ║"
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

cmd_start() {
    require_installed
    detect_compose
    cd "$APP_DIR"
    info "Starting MMRC services..."
    $COMPOSE up -d
    success "Services started"
}

cmd_stop() {
    require_installed
    detect_compose
    cd "$APP_DIR"
    info "Stopping MMRC services..."
    $COMPOSE down
    success "Services stopped"
}

cmd_restart() {
    require_installed
    detect_compose
    cd "$APP_DIR"
    info "Restarting MMRC services..."
    $COMPOSE restart
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
    SERVER_PORT=$(grep "^SERVER_PORT=" "$ENV_FILE" | cut -d= -f2 || echo "3000")
    if curl -fsS http://localhost:${SERVER_PORT}/health >/dev/null 2>&1; then
        success "Server is healthy"
    else
        warn "Server is not responding (port ${SERVER_PORT})"
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
        case $1 in
            server) $COMPOSE logs -f mmrc-server ;;
            optimizer) $COMPOSE logs -f mmrc-optimizer ;;
            streamer) $COMPOSE logs -f mmrc-streamer ;;
            nginx) $COMPOSE logs -f mmrc-nginx ;;
            *) $COMPOSE logs -f "$1" ;;
        esac
    else
        $COMPOSE logs -f
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

    # Backup
    info "Creating backup..."
    if [ -f "$APP_DIR/config/main.db" ]; then
        cp "$APP_DIR/config/main.db" "$APP_DIR/config/main.db.backup.$(date +%F)"
        success "Database backed up"
    fi

    # Pull new images
    info "Pulling latest Docker images..."
    $COMPOSE pull
    success "Images updated"

    # Restart services
    info "Restarting services..."
    $COMPOSE up -d
    success "Services restarted"

    # Wait for health
    info "Waiting for server to be ready..."
    sleep 10

    SERVER_PORT=$(grep "^SERVER_PORT=" "$ENV_FILE" | cut -d= -f2 || echo "3000")
    if curl -fsS http://localhost:${SERVER_PORT}/health >/dev/null 2>&1; then
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

    if [ -f "config/main.db" ]; then
        docker compose exec -T mmrc-server sqlite3 /app/config/main.db ".backup /app/config/main.db.backup"
        cp "config/main.db.backup" "$BACKUP_DIR/main-${TIMESTAMP}.db"
        success "Main database backed up"
    fi

    if [ -f "config/hero/heroes.db" ]; then
        docker compose exec -T mmrc-server sqlite3 /app/config/hero/heroes.db ".backup /app/config/hero/heroes.db.backup"
        cp "config/hero/heroes.db.backup" "$BACKUP_DIR/heroes-${TIMESTAMP}.db"
        success "Heroes database backed up"
    fi

    # Backup config
    tar -czf "$BACKUP_DIR/config-${TIMESTAMP}.tar.gz" -C "$APP_DIR" .env docker-compose.yml 2>/dev/null || true
    success "Configuration backed up"

    echo ""
    info "Backups saved to: $BACKUP_DIR"
    ls -lh "$BACKUP_DIR" | tail -5
}

cmd_ssl() {
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

    # Check if port 80 is available
    if ss -ltn | grep -q ':80 '; then
        warn "Port 80 is in use. Stopping nginx temporarily..."
        $COMPOSE stop mmrc-nginx 2>/dev/null || true
    fi

    # Install acme.sh
    if ! command -v acme.sh >/dev/null 2>&1; then
        info "Installing acme.sh..."
        curl -s https://get.acme.sh | sh
        export PATH="$HOME/.acme.sh:$PATH"
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
            --reloadcmd "$COMPOSE -f $COMPOSE_FILE restart mmrc-nginx"

        success "SSL certificate installed!"
        info "Certificate: $DATA_DIR/certs/$domain/fullchain.pem"
        info "Key: $DATA_DIR/certs/$domain/privkey.pem"

        # Update compose for SSL
        warn "Manual step: Update nginx.conf to enable SSL"
        warn "Then run: mmrc restart"
    else
        error "Failed to issue certificate"
        exit 1
    fi
}

cmd_shell() {
    require_installed
    detect_compose
    cd "$APP_DIR"

    SERVICE="${1:-mmrc-server}"
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

cmd_help() {
    colorized_echo cyan "
╔══════════════════════════════════════════════════════╗
║              📺 MMRC CLI                             ║
║         Media Management & Remote Control            ║
╚══════════════════════════════════════════════════════╝

Usage: mmrc <command> [options]

Commands:
  install          Install MMRC with Docker
  start            Start MMRC services
  stop             Stop MMRC services
  restart          Restart MMRC services
  status           Check services status
  logs [service]   View logs (server|optimizer|streamer|nginx)
  update           Update to latest version
  backup           Create database backup
  ssl              Setup SSL certificate
  shell [service]  Open shell in container
  uninstall        Remove MMRC

Examples:
  mmrc install                  # Install MMRC
  mmrc status                   # Check status
  mmrc logs server              # View server logs
  mmrc update                   # Update to latest version
  mmrc backup                   # Create backup
  mmrc ssl                      # Setup SSL
"
}

# ========================
# Main
# ========================

case "${1:-help}" in
    install) cmd_install "${@:2}" ;;
    start) cmd_start ;;
    stop) cmd_stop ;;
    restart) cmd_restart ;;
    status) cmd_status ;;
    logs) cmd_logs "${@:2}" ;;
    update) cmd_update ;;
    backup) cmd_backup ;;
    ssl) cmd_ssl ;;
    shell) cmd_shell "${@:2}" ;;
    uninstall) cmd_uninstall ;;
    help|--help|-h) cmd_help ;;
    *)
        error "Unknown command: $1"
        cmd_help
        exit 1
        ;;
esac
