#!/bin/sh
set -e

# MMRC Docker Entrypoint Script
ROLE="${MMRC_ROLE:-${ROLE:-server}}"
export ROLE

echo "🚀 Starting MMRC ${ROLE}..."
echo "📦 Version: 3.2.1"
echo "🔧 Node: $(node --version)"
echo "🎬 FFmpeg: $(ffmpeg -version 2>/dev/null | head -1 || echo 'not found')"

# Apply database migrations
echo "🔄 Checking for database migrations..."
if [ -f "/app/scripts/post-pull-sync.sh" ]; then
    SKIP_SERVICE_RESTART=1 SKIP_MIGRATION=0 bash /app/scripts/post-pull-sync.sh 2>/dev/null || true
fi

# Start Nginx as reverse proxy
echo "🌐 Starting Nginx reverse proxy..."
if [ -f "/etc/nginx/nginx.conf" ]; then
    nginx -c /etc/nginx/nginx.conf
else
    nginx
fi
sleep 1
echo "✅ Nginx started"

export PORT=${PORT:-3000}

# Create directories if they don't exist
DATA_DIR="${MMRC_DATA_DIR:-${CONTENT_ROOT:-/app/data}}"

mkdir -p "${DATA_DIR}/db"
mkdir -p "${DATA_DIR}/content"
mkdir -p "${DATA_DIR}/streams"
mkdir -p "${DATA_DIR}/converted/trailers"
mkdir -p "${DATA_DIR}/logs"
mkdir -p "${DATA_DIR}/temp"
mkdir -p "${DATA_DIR}/hero"
mkdir -p /app/.tmp

# Migrate legacy DB files if they exist in /app/config
if [ -f "/app/config/main.db" ] && [ ! -f "${DATA_DIR}/db/main.db" ]; then
    echo "🔄 Migrating main.db to ${DATA_DIR}/db/"
    cp /app/config/main.db "${DATA_DIR}/db/main.db" 2>/dev/null || true
    cp /app/config/main.db-shm "${DATA_DIR}/db/main.db-shm" 2>/dev/null || true
    cp /app/config/main.db-wal "${DATA_DIR}/db/main.db-wal" 2>/dev/null || true
fi

if [ -f "/app/config/hero/heroes.db" ] && [ ! -f "${DATA_DIR}/db/heroes.db" ]; then
    echo "🔄 Migrating heroes.db to ${DATA_DIR}/db/"
    mkdir -p "${DATA_DIR}/db"
    cp /app/config/hero/heroes.db "${DATA_DIR}/db/heroes.db" 2>/dev/null || true
    cp /app/config/hero/heroes.db-shm "${DATA_DIR}/db/heroes.db-shm" 2>/dev/null || true
    cp /app/config/hero/heroes.db-wal "${DATA_DIR}/db/heroes.db-wal" 2>/dev/null || true
fi

echo "📁 Content Root: ${DATA_DIR}"
echo "📡 Port: ${PORT}"
echo "✅ Starting MMRC Node server..."

exec "$@"
