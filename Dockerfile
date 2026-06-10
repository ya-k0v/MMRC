# syntax=docker/dockerfile:1

# ========================
# Build stage
# ========================
FROM node:20-slim AS builder

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
FROM node:20-slim

ARG MMRC_ROLE=server
ENV ROLE=${MMRC_ROLE}

LABEL maintainer="ya-k0v"
LABEL description="MMRC - Media Management and Remote Control"
LABEL version="3.2.1"

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    sqlite3 \
    curl \
    bash \
    wget \
    ca-certificates \
    fonts-noto-cjk \
    nginx \
    imagemagick \
    libreoffice-impress \
    libreoffice-impress \
    tini \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* \
    && mkdir -p /var/log/nginx /run/nginx /etc/nginx/ssl /etc/nginx/ssl-certs

# yt-dlp
RUN wget -q -O /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application files
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY config /app/config
COPY clients/android-mediaplayer/app-release.apk /app/clients/android-mediaplayer/app-release.apk

COPY docker-entrypoint.sh /usr/local/bin/
COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/data/{db,content,streams,converted/trailers,logs,temp,hero} /app/.tmp

ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 LOG_LEVEL=info \
    MMRC_DATA_DIR=/app/data CONTENT_ROOT=/app/data \
    STREAMS_OUTPUT_DIR=/app/data/streams LOGS_DIR=/app/data/logs

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://127.0.0.1:80/health || exit 1

EXPOSE 80 443 3000

ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]