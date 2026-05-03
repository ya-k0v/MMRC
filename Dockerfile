# syntax=docker/dockerfile:1

# ========================
# Build stage
# ========================
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json ./

# Install production dependencies
RUN npm ci --omit=dev

# ========================
# Production stage
# ========================
FROM node:20-bookworm-slim

ARG MMRC_ROLE=server
ENV ROLE=${MMRC_ROLE}

LABEL maintainer="ya-k0v"
LABEL description="MMRC - Media Management and Remote Control System"
LABEL version="3.2.1"

# Install runtime dependencies (essential)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    sqlite3 \
    curl \
    bash \
    wget \
    ca-certificates \
    fontconfig \
    fonts-liberation \
    nginx \
    graphicsmagick \
    tini \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* \
    && mkdir -p /var/log/nginx /run/nginx /etc/nginx/ssl /etc/nginx/ssl-certs

# LibreOffice removed from main image; use separate converter sidecar image to reduce image size

# Install yt-dlp (critical for video URL downloads)
RUN wget -q -O /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application files from build context
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY config /app/config

# Copy entrypoint and nginx config
COPY docker-entrypoint.sh /usr/local/bin/
COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create required directories (new structure)
RUN mkdir -p /app/data/{db,content,streams,cache/converted,cache/trailers,logs,hero} \
    /app/.tmp

# Prepare optional folder for external binaries (converter will populate /opt/mmrc-bin/soffice)
RUN mkdir -p /opt/mmrc-bin \
    && ln -sf /opt/mmrc-bin/soffice /usr/local/bin/soffice || true

# Default environment variables (use system-wide data directory)
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    MMRC_DATA_DIR=/app/data \
    CONTENT_ROOT=/app/data/content \
    STREAMS_OUTPUT_DIR=/app/data/streams \
    LOGS_DIR=/app/data/logs

# Health check (via nginx on port 80)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://127.0.0.1:80/health || exit 1

# Expose ports (80 for Nginx, 3000 for Node.js internal)
EXPOSE 80 443 3000

ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
