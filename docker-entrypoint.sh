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

# SSL: create HTTPS server block if certs exist
SSL_CERT="/var/lib/mmrc/certs/ssl/fullchain.pem"
SSL_KEY="/var/lib/mmrc/certs/ssl/privkey.pem"
HTTPS_CONF="/etc/nginx/conf.d/https.conf"

if [ -f "$SSL_CERT" ] && [ -f "$SSL_KEY" ]; then
    echo "🔐 SSL certificates found, enabling HTTPS..."
    cat > "$HTTPS_CONF" << 'EOF'
server {
    listen 443 ssl http2;
    server_name _;

    ssl_certificate /var/lib/mmrc/certs/ssl/fullchain.pem;
    ssl_certificate_key /var/lib/mmrc/certs/ssl/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    location / {
        proxy_pass http://mmrc_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /health {
        proxy_pass http://mmrc_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /api/ {
        proxy_pass http://mmrc_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }

    location ~ ^/api/devices/[^/]+/upload {
        client_max_body_size 5120M;
        proxy_pass http://mmrc_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location ^~ /socket.io/ {
        proxy_pass http://mmrc_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 86400s;
    }

    location /streams/ {
        alias /app/data/streams/;
        add_header Cache-Control no-cache;
        add_header X-Accel-Buffering no;
        add_header Access-Control-Allow-Origin *;
        types {
            application/vnd.apple.mpegurl m3u8;
            video/mp2t ts;
        }
    }

    location /content/ {
        alias /app/data/content/;
        expires 30d;
        add_header Cache-Control "public";
    }

    location ~ /\. {
        deny all;
    }
}
EOF
else
    echo "ℹ️ No SSL certificates, HTTP only"
    rm -f "$HTTPS_CONF"
fi

# Start Nginx
echo "🌐 Starting Nginx..."
nginx -c /etc/nginx/nginx.conf
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
