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
FROM node:20-bookworm

ARG MMRC_ROLE=server
ENV ROLE=${MMRC_ROLE}

LABEL maintainer="ya-k0v"
LABEL description="MMRC - Media Management and Remote Control System"
LABEL version="3.2.1"

# Add contrib repositories for LibreOffice
RUN echo "deb http://deb.debian.org/debian bookworm main contrib" > /etc/apt/sources.list.d/bookworm.list && \
    apt-get update

# Install runtime dependencies and LibreOffice in one step
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ffmpeg \
    sqlite3 \
    curl \
    wget \
    ca-certificates \
    fontconfig \
    fonts-liberation \
    libreoffice-common \
    libreoffice-core \
    libreoffice-impress \
    libreoffice-calc \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

RUN wget -q -O /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

# Create non-root user
RUN groupadd -g 1001 mmrc && \
    useradd -u 1001 -g mmrc -s /bin/bash -m mmrc

WORKDIR /app

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application files from build context
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Copy entrypoint
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create required directories
RUN mkdir -p /app/data/{content,streams,cache,logs} \
    /app/config/hero \
    /app/.tmp && \
    chown -R mmrc:mmrc /app

# Switch to non-root user
USER mmrc

# Default environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    CONTENT_ROOT=/data \
    STREAMS_OUTPUT_DIR=/data/streams \
    LOGS_DIR=/data/logs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

# Expose port
EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
