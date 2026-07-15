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
SSL_CERTS_DIR="/etc/nginx/ssl-certs"
HTTPS_CONF="/etc/nginx/conf.d/https.conf"
CERTS_FOUND=false

# Check multiple cert locations
for CHECK_DIR in "/var/lib/mmrc/certs/ssl" "/var/lib/mmrc/certs"; do
    if [ -f "$CHECK_DIR/fullchain.pem" ] && [ -f "$CHECK_DIR/privkey.pem" ]; then
        echo "🔐 SSL certificates found in $CHECK_DIR"
        mkdir -p "$SSL_CERTS_DIR"
        cp "$CHECK_DIR/fullchain.pem" "$SSL_CERTS_DIR/"
        cp "$CHECK_DIR/privkey.pem" "$SSL_CERTS_DIR/"
        chmod 644 "$SSL_CERTS_DIR/fullchain.pem"
        chmod 600 "$SSL_CERTS_DIR/privkey.pem"
        CERTS_FOUND=true
        break
    fi
done

if [ "$CERTS_FOUND" = false ]; then
    echo "🔐 No SSL certificates found, generating self-signed..."
    mkdir -p "$SSL_CERTS_DIR"
    
    # Use MMRC_SERVER_IP if set, otherwise try to detect external IP
    SERVER_IP="${MMRC_SERVER_IP:-}"
    if [ -z "$SERVER_IP" ]; then
        SERVER_IP=$(curl -s --connect-timeout 3 https://ifconfig.me 2>/dev/null || echo "127.0.0.1")
    fi
    
    openssl req -x509 -nodes -days 3650 \
        -newkey rsa:2048 \
        -keyout "$SSL_CERTS_DIR/privkey.pem" \
        -out "$SSL_CERTS_DIR/fullchain.pem" \
        -subj "/CN=$SERVER_IP" \
        -addext "subjectAltName=IP:$SERVER_IP,IP:127.0.0.1,DNS:localhost" 2>/dev/null
    
    if [ -f "$SSL_CERTS_DIR/fullchain.pem" ]; then
        echo "✅ Self-signed certificate generated for $SERVER_IP"
    else
        echo "⚠️ Failed to generate certificate"
    fi
fi

# Create HTTPS config
cp /etc/nginx/https.conf "$HTTPS_CONF"

# Start Nginx
echo "🌐 Starting Nginx..."
nginx
sleep 1
echo "✅ Nginx started"

export PORT=${PORT:-3000}

# Create data directories
DATA_DIR="${MMRC_DATA_DIR:-${CONTENT_ROOT:-/app/data}}"
mkdir -p "${DATA_DIR}/db" "${DATA_DIR}/content" "${DATA_DIR}/streams"
mkdir -p "${DATA_DIR}/converted/trailers" "${DATA_DIR}/logs" "${DATA_DIR}/temp" "${DATA_DIR}/hero"
mkdir -p /app/.tmp

# Migrate legacy DB files
if [ -f "/app/config/main.db" ] && [ ! -f "${DATA_DIR}/db/main.db" ]; then
    echo "🔄 Migrating main.db..."
    cp /app/config/main.db "${DATA_DIR}/db/main.db" 2>/dev/null || true
    cp /app/config/main.db-shm "${DATA_DIR}/db/main.db-shm" 2>/dev/null || true
    cp /app/config/main.db-wal "${DATA_DIR}/db/main.db-wal" 2>/dev/null || true
fi

if [ -f "/app/config/hero/heroes.db" ] && [ ! -f "${DATA_DIR}/db/heroes.db" ]; then
    echo "🔄 Migrating heroes.db..."
    mkdir -p "${DATA_DIR}/db"
    cp /app/config/hero/heroes.db "${DATA_DIR}/db/heroes.db" 2>/dev/null || true
    cp /app/config/hero/heroes.db-shm "${DATA_DIR}/db/heroes.db-shm" 2>/dev/null || true
    cp /app/config/hero/heroes.db-wal "${DATA_DIR}/db/heroes.db-wal" 2>/dev/null || true
fi

echo "📁 Content Root: ${DATA_DIR}"
echo "📡 Port: ${PORT}"
echo "✅ Starting MMRC Node server..."

exec "$@"
