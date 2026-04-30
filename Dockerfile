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
    wget \
    ca-certificates \
    fontconfig \
    fonts-liberation \
    nginx \
    graphicsmagick \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* \
    && mkdir -p /var/log/nginx /run/nginx /etc/nginx/ssl /etc/nginx/ssl-certs

# Install LibreOffice (only impress for PPTX conversion, minimal)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    libreoffice-impress \
    && apt-get clean && \
    rm -rf /var/lib/apt/lists/* /usr/share/man/* /usr/share/doc/* /usr/share/icons/* \
    /usr/share/help/* /usr/share/bug/* /usr/share/lintian/*

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

# Copy entrypoint and nginx config
COPY docker-entrypoint.sh /usr/local/bin/
COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create required directories
RUN mkdir -p /app/data/{content,streams,cache/converted,cache/trailers,logs} \
    /app/config/hero \
    /app/.tmp

# Default environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    CONTENT_ROOT=/data \
    STREAMS_OUTPUT_DIR=/data/streams \
    LOGS_DIR=/data/logs

# Health check (via nginx)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:80/health || exit 1

# Expose ports (80 for Nginx, 3000 for Node.js)
EXPOSE 80 443 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
