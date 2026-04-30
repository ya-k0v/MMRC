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
        echo "⚙️  Mode: Main Server (API + UI + Socket.IO)"
        export PORT=${PORT:-3000}
        ;;
esac

# Create directories if they don't exist (ignore errors from read-only mounts)
mkdir -p "${CONTENT_ROOT:-/data}/content" 2>/dev/null || true
mkdir -p "${CONTENT_ROOT:-/data}/streams" 2>/dev/null || true
mkdir -p "${CONTENT_ROOT:-/data}/cache/trailers" 2>/dev/null || true
mkdir -p "${CONTENT_ROOT:-/data}/cache/converted" 2>/dev/null || true
mkdir -p "${CONTENT_ROOT:-/data}/logs" 2>/dev/null || true
mkdir -p /app/config/hero 2>/dev/null || true
mkdir -p /app/.tmp 2>/dev/null || true

echo "📁 Content Root: ${CONTENT_ROOT:-/data}"
echo "📡 Port: ${PORT}"
echo "✅ Starting service..."

exec "$@"
