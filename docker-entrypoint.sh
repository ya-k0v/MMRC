#!/bin/sh
set -e

# MMRC Docker Entrypoint Script
# Determines the role and starts the appropriate service

ROLE="${MMRC_ROLE:-${ROLE:-server}}"
export ROLE

echo "🚀 Starting MMRC ${ROLE}..."
echo "📦 Version: 3.2.1"
echo "🔧 Node: $(node --version)"
echo "🎬 FFmpeg: $(ffmpeg -version 2>/dev/null | head -1 || echo 'not found')"

# Apply database migrations if server role
if [ "$ROLE" = "server" ]; then
    echo "🔄 Checking for database migrations..."
    if [ -f "/app/scripts/post-pull-sync.sh" ]; then
        SKIP_SERVICE_RESTART=1 SKIP_MIGRATION=0 bash /app/scripts/post-pull-sync.sh 2>/dev/null || true
    fi

    # Start Nginx as reverse proxy (use project config)
    echo "🌐 Starting Nginx reverse proxy..."
    if [ -f "/etc/nginx/nginx.conf" ]; then
        nginx -c /etc/nginx/nginx.conf
    else
        nginx
    fi
    sleep 1
    echo "✅ Nginx started"
fi

# Set worker-specific defaults
case "$ROLE" in
    optimizer)
        echo "⚙️  Mode: Night Optimization Worker"
        export WORKER_MODE=optimizer
        export PORT=${PORT:-3001}
        ;;
    streamer)
        echo "⚙️  Mode: Stream Worker (HLS/DASH)"
        export WORKER_MODE=streamer
        export PORT=${PORT:-3002}
        ;;
    server|*)
        echo "⚙️  Mode: Main Server (API + UI + Socket.IO + Nginx)"
        export PORT=${PORT:-3000}
        ;;
esac

# If running as a worker, wait for mmrc-server health endpoint before starting
if [ "${ROLE}" != "server" ]; then
    WAIT_TIMEOUT=${WAIT_FOR_SERVER_TIMEOUT:-60}
    echo "⏳ Waiting for mmrc-server health (timeout ${WAIT_TIMEOUT}s)..."
    COUNT=0
    # determine health endpoint: prefer internal API URLs if provided
    if [ -n "${ADMIN_INTERNAL_API_URL:-}" ]; then
        HEALTH_BASE=${ADMIN_INTERNAL_API_URL}
    elif [ -n "${SERVER_URL:-}" ]; then
        HEALTH_BASE=${SERVER_URL}
    else
        HEALTH_BASE="http://mmrc-server:3000"
    fi
    # strip trailing slash and append /health
    HEALTH_URL="${HEALTH_BASE%/}/health"
    echo "Checking ${HEALTH_URL} ..."
    until curl -fsS "$HEALTH_URL" >/dev/null 2>&1; do
        COUNT=$((COUNT+1))
        if [ "$COUNT" -ge "$WAIT_TIMEOUT" ]; then
            echo "⚠️  Timeout waiting for mmrc-server; proceeding anyway"
            break
        fi
        sleep 1
    done
    echo "✅ mmrc-server reachable (or timeout reached)"
fi

# Create directories if they don't exist
# Use MMRC_DATA_DIR for system-wide data or fallback to /app/data
DATA_DIR="${MMRC_DATA_DIR:-${CONTENT_ROOT:-/app/data}}"

mkdir -p "${DATA_DIR}/db"
mkdir -p "${DATA_DIR}/content"
mkdir -p "${DATA_DIR}/streams"
mkdir -p "${DATA_DIR}/cache/trailers"
mkdir -p "${DATA_DIR}/cache/converted"
mkdir -p "${DATA_DIR}/logs"
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
echo "✅ Starting service..."

exec "$@"
