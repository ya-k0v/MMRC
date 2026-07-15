#!/bin/sh
set -e

ROLE="${MMRC_ROLE:-${ROLE:-server}}"
export ROLE

echo "🚀 Starting MMRC ${ROLE}..."
echo "📦 Version: 3.4.0"
echo "🔧 Node: $(node --version)"
echo "🎬 FFmpeg: $(ffmpeg -version 2>/dev/null | head -1 || echo 'not found')"

DB_TYPE="${DB_TYPE:-sqlite}"
export DB_TYPE
echo "🗄️ Database type: ${DB_TYPE}"

# Wait for PostgreSQL if needed
if [ "$DB_TYPE" = "postgres" ]; then
    DB_HOST="${DB_HOST:-mmrc-postgres}"
    DB_PORT="${DB_PORT:-5432}"
    echo "⏳ Waiting for PostgreSQL at ${DB_HOST}:${DB_PORT}..."
    i=0
    while [ "$i" -lt 30 ]; do
        i=$((i + 1))
        if nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null; then
            echo "✅ PostgreSQL is ready"
            break
        fi
        if [ "$i" -ge 30 ]; then
            echo "⚠️ PostgreSQL not reachable, continuing anyway..."
        fi
        sleep 2
    done
fi

# Apply database migrations
echo "🔄 Checking for database migrations..."
if [ -f "/app/scripts/post-pull-sync.sh" ]; then
    SKIP_NPM_INSTALL=1 SKIP_SERVICE_RESTART=1 SKIP_MIGRATION=0 bash /app/scripts/post-pull-sync.sh 2>/dev/null || true
fi

# SSL: check for certificates or generate self-signed
SSL_CERT="/var/lib/mmrc/certs/ssl/fullchain.pem"
SSL_KEY="/var/lib/mmrc/certs/ssl/privkey.pem"
HTTPS_CADDYFILE="/etc/caddy/https.Caddyfile"
HTTPS_CONF="/etc/caddy/https.conf"

# Check multiple cert locations
CERTS_FOUND=false
for CHECK_DIR in "/var/lib/mmrc/certs/ssl" "/var/lib/mmrc/certs"; do
    if [ -f "$CHECK_DIR/fullchain.pem" ] && [ -f "$CHECK_DIR/privkey.pem" ]; then
        SSL_CERT="$CHECK_DIR/fullchain.pem"
        SSL_KEY="$CHECK_DIR/privkey.pem"
        CERTS_FOUND=true
        break
    fi
done

if [ "$CERTS_FOUND" = true ]; then
    echo "🔐 SSL certificates found at $SSL_CERT"
    # Create HTTPS Caddyfile with actual cert paths
    sed "s|/var/lib/mmrc/certs/ssl/fullchain.pem|$SSL_CERT|g; s|/var/lib/mmrc/certs/ssl/privkey.pem|$SSL_KEY|g" \
        "$HTTPS_CADDYFILE" > "$HTTPS_CONF"
else
    echo "🔐 No SSL certificates found, generating self-signed..."
    mkdir -p /var/lib/mmrc/certs/ssl
    
    # Get server IP or use localhost
    SERVER_IP=$(hostname -i 2>/dev/null || echo "127.0.0.1")
    
    # Generate self-signed certificate
    openssl req -x509 -nodes -days 3650 \
        -newkey rsa:2048 \
        -keyout "$SSL_KEY" \
        -out "$SSL_CERT" \
        -subj "/CN=$SERVER_IP" \
        -addext "subjectAltName=IP:$SERVER_IP,IP:127.0.0.1,DNS:localhost" 2>/dev/null
    
    if [ -f "$SSL_CERT" ] && [ -f "$SSL_KEY" ]; then
        echo "✅ Self-signed certificate generated for $SERVER_IP"
        # Create HTTPS config
        sed "s|/var/lib/mmrc/certs/ssl/fullchain.pem|$SSL_CERT|g; s|/var/lib/mmrc/certs/ssl/privkey.pem|$SSL_KEY|g" \
            "$HTTPS_CADDYFILE" > "$HTTPS_CONF"
    else
        echo "⚠️ Failed to generate certificate, HTTP only"
        rm -f "$HTTPS_CONF"
    fi
fi

# Create log directory
mkdir -p /var/log/caddy

# Start Caddy
echo "🌐 Starting Caddy..."
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
