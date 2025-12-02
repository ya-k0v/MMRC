#!/bin/bash
# ========================================
# VideoControl v3.0.0 - Quick Installation Script
# ========================================
# Полная установка системы на чистый Ubuntu/Debian сервер
#
# НАЗНАЧЕНИЕ:
#   Автоматическая установка VideoControl с нуля:
#   - Установка системных зависимостей (Node.js, FFmpeg, LibreOffice, Nginx)
#   - Клонирование репозитория
#   - Настройка хранилища данных (local/external/external_fstab)
#   - Настройка Nginx (reverse proxy с geo-блокировкой)
#   - Создание systemd сервиса
#   - Оптимизация сети (TCP буферы 16MB)
#
# ИСПОЛЬЗОВАНИЕ:
#   # Интерактивная установка
#   sudo bash scripts/quick-install.sh /vid/videocontrol
#
#   # Non-interactive (production)
#   AUTO_CONFIRM=1 STORAGE_MODE=external DATA_ROOT=/mnt/videocontrol-data \
#     sudo bash scripts/quick-install.sh /vid/videocontrol
#
# ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ:
#   AUTO_CONFIRM=1          - Отключает все вопросы "y/n" (для автоматической установки)
#   STORAGE_MODE            - Режим хранения: local | external | external_fstab
#   DATA_ROOT               - Корневая папка данных (по умолчанию: /mnt/videocontrol-data)
#   CONTENT_DIR             - Legacy: путь к контенту (используйте DATA_ROOT)
#   CONTENT_SOURCE          - Устройство/UUID для /etc/fstab (только external_fstab)
#   CONTENT_FSTAB_OPTS      - Параметры монтирования (по умолчанию: "ext4 defaults,noatime 0 2")
#
# РЕЖИМЫ ХРАНЕНИЯ:
#   local          - Все данные в $INSTALL_DIR/data/* (content, streams, converted, logs, temp)
#   external       - Все данные в $DATA_ROOT/* (требует существующую папку)
#   external_fstab - Внешний диск монтируется в $DATA_ROOT через /etc/fstab
#
# ЧТО УСТАНАВЛИВАЕТСЯ:
#   - Node.js 20.x LTS (Nodesource)
#   - FFmpeg + FFprobe (обработка видео)
#   - LibreOffice (конвертация PDF/PPTX)
#   - ImageMagick (рендер изображений)
#   - SQLite3 (база данных)
#   - Nginx (reverse proxy)
#   - build-essential, curl, wget, git, unzip
#
# ЧТО СОЗДАЁТСЯ:
#   - Структура папок: $INSTALL_DIR/{config, data/*, public, src, ...}
#   - База данных: $INSTALL_DIR/config/main.db (admin/admin123)
#   - Hero БД: $INSTALL_DIR/config/hero/heroes.db
#   - Настройки: $INSTALL_DIR/config/app-settings.json (динамические пути данных)
#   - Nginx конфиг: /etc/nginx/sites-available/videocontrol
#   - Systemd сервис: /etc/systemd/system/videocontrol.service
#   - Сетевые настройки: /etc/sysctl.d/99-videocontrol.conf
#
# ПОСЛЕ УСТАНОВКИ:
#   - Admin Panel: http://YOUR_SERVER_IP/
#   - Speaker Panel: http://YOUR_SERVER_IP/speaker.html
#   - Hero Panel: http://YOUR_SERVER_IP/hero/index.html
#   - По умолчанию: admin / admin123 (ОБЯЗАТЕЛЬНО СМЕНИТЬ!)
#
# НОВОЕ В v3.0.0:
#   - Динамические пути данных через config/app-settings.json
#   - Автоматические миграции heroes.db
#   - Дедупликация стримов (один FFmpeg на URL)
#   - Скрипты проверки: scripts/check-environment.sh
#   - Скрипты очистки: scripts/cleanup.sh
#
# ========================================

set -e  # Выход при ошибке

# AUTO_CONFIRM=1 отключает все интерактивные вопросы
AUTO_CONFIRM="${AUTO_CONFIRM:-0}"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}  VideoControl v3.0.0 - Quick Install${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""

# Проверка OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_NAME=$ID
else
    echo -e "${RED}❌ Cannot detect OS${NC}"
    exit 1
fi

if [ "$OS_NAME" != "ubuntu" ] && [ "$OS_NAME" != "debian" ]; then
    echo -e "${YELLOW}⚠️  This script is designed for Ubuntu/Debian${NC}"
    echo -e "${YELLOW}   For other OS, use manual installation${NC}"
    exit 1
fi

echo -e "${GREEN}✅ OS: $PRETTY_NAME${NC}"
echo ""

# Определяем установочную директорию
INSTALL_DIR="${1:-/vid/videocontrol}"
CURRENT_USER="${SUDO_USER:-$(whoami)}"

echo "Installation settings:"
echo "  Directory: $INSTALL_DIR"
echo "  User: $CURRENT_USER"
echo ""
if [ "$AUTO_CONFIRM" = "1" ]; then
    echo "AUTO_CONFIRM=1 → продолжение без подтверждения"
else
    read -p "Continue? (y/n): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
fi

# Настройки хранения данных (можно переопределить переменными окружения)
# DATA_ROOT - корневая папка для всех данных (по умолчанию: /mnt/videocontrol-data)
#   Если DATA_ROOT существует - все данные там (data/content, data/streams, data/converted, data/logs, data/temp)
#   Если нет - все данные в $INSTALL_DIR/data/*
# STORAGE_MODE: local | external | external_fstab (для обратной совместимости, используйте DATA_ROOT)
STORAGE_MODE="${STORAGE_MODE:-}"
DATA_ROOT="${DATA_ROOT:-/mnt/videocontrol-data}"
CONTENT_DIR="${CONTENT_DIR:-/mnt/vc-content}"  # Legacy, используйте DATA_ROOT
CONTENT_SOURCE="${CONTENT_SOURCE:-}"        # Например: /dev/sdb1 или UUID=xxxx-xxxx
CONTENT_FSTAB_OPTS="${CONTENT_FSTAB_OPTS:-ext4 defaults,noatime 0 2}"

# Интерактивный выбор, если не задано через переменные
if [ -z "$STORAGE_MODE" ]; then
    if [ "$AUTO_CONFIRM" = "1" ]; then
        STORAGE_MODE="local"
        echo "AUTO_CONFIRM=1 → STORAGE_MODE не задан, используем local"
    else
        echo ""
        echo "Select data storage mode:"
        echo "  [1] Local (inside project at data/*)"
        echo "  [2] External directory (DATA_ROOT=$DATA_ROOT)"
        echo "  [3] External device via /etc/fstab -> $DATA_ROOT"
        read -p "Choose [1-3]: " -n 1 -r
        echo ""
        case "$REPLY" in
            1) STORAGE_MODE="local" ;;
            2) STORAGE_MODE="external" ;;
            3) STORAGE_MODE="external_fstab" ;;
            *) echo "Invalid choice, defaulting to local"; STORAGE_MODE="local" ;;
        esac
    fi
fi

# Для режима external_fstab запросим источник, если не задан
if [ "$STORAGE_MODE" = "external_fstab" ] && [ -z "$CONTENT_SOURCE" ]; then
    if [ "$AUTO_CONFIRM" = "1" ]; then
        echo "❌ CONTENT_SOURCE must be set when STORAGE_MODE=external_fstab in AUTO_CONFIRM mode"
        exit 1
    fi
    read -p "Enter content device/UUID for /etc/fstab (e.g., /dev/sdb1 or UUID=xxxx): " CONTENT_SOURCE
fi

# ==========================================
# PHASE 1: SYSTEM DEPENDENCIES
# ==========================================
echo ""
echo -e "${BLUE}[1/7] Installing system dependencies...${NC}"

# Обновляем список пакетов
apt-get update -qq

# Устанавливаем базовые инструменты
apt-get install -y curl wget git build-essential sqlite3

# Node.js (если еще не установлен)
if ! command -v node &> /dev/null; then
    echo "  Installing Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    echo -e "  ${GREEN}✅ Node.js $(node --version)${NC}"
else
    echo -e "  ${GREEN}✅ Node.js already installed: $(node --version)${NC}"
fi

# FFmpeg, LibreOffice, ImageMagick, unzip
echo "  Installing media processing tools..."
apt-get install -y ffmpeg libreoffice imagemagick unzip sqlite3

echo -e "${GREEN}✅ System dependencies installed${NC}"

# ==========================================
# PHASE 2: DOWNLOAD/CLONE PROJECT
# ==========================================
echo ""
echo -e "${BLUE}[2/7] Setting up project...${NC}"

if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}⚠️  Directory $INSTALL_DIR already exists${NC}"
    if [ "$AUTO_CONFIRM" = "1" ]; then
        echo "AUTO_CONFIRM=1 → removing existing directory"
        rm -rf "$INSTALL_DIR"
    else
        read -p "Remove and reinstall? (y/n): " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            rm -rf "$INSTALL_DIR"
        else
            echo "Installation cancelled."
            exit 0
        fi
    fi
fi

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Клонируем из GitHub
echo "  Cloning from GitHub..."
git clone https://github.com/ya-k0v/VideoControl.git .

echo -e "${GREEN}✅ Project downloaded${NC}"

# ==========================================
# PHASE 3: NPM DEPENDENCIES
# ==========================================
echo ""
echo -e "${BLUE}[3/7] Installing Node.js packages...${NC}"

npm install

echo -e "${GREEN}✅ NPM packages installed${NC}"

# Проверяем окружение после установки зависимостей
if [ -f scripts/check-environment.sh ]; then
    echo ""
    echo "  Running environment check..."
    bash scripts/check-environment.sh || {
        echo -e "  ${YELLOW}⚠️  Environment check completed with warnings${NC}"
    }
fi

# ==========================================
# PHASE 4: PROJECT STRUCTURE
# ==========================================
echo ""
echo -e "${BLUE}[4/7] Creating project structure...${NC}"

mkdir -p config
mkdir -p config/hero
mkdir -p "$INSTALL_DIR/public"

# Настройка хранения данных согласно выбранному режиму
case "$STORAGE_MODE" in
    local)
        # Локальное хранение в $INSTALL_DIR/data/*
        mkdir -p "$INSTALL_DIR/data/content"
        mkdir -p "$INSTALL_DIR/data/streams"
        mkdir -p "$INSTALL_DIR/data/converted"
        mkdir -p "$INSTALL_DIR/data/logs"
        mkdir -p "$INSTALL_DIR/data/temp"
        ;;
    external)
        # Внешний каталог для всех данных
        mkdir -p "$DATA_ROOT/content"
        mkdir -p "$DATA_ROOT/streams"
        mkdir -p "$DATA_ROOT/converted"
        mkdir -p "$DATA_ROOT/logs"
        mkdir -p "$DATA_ROOT/temp"
        # Миграция существующих данных, если есть
        if [ -d "$INSTALL_DIR/public/content" ] && [ ! -L "$INSTALL_DIR/public/content" ]; then
            echo "  Migrating content from $INSTALL_DIR/public/content to $DATA_ROOT/content..."
            rsync -aH --delete "$INSTALL_DIR/public/content/" "$DATA_ROOT/content/" 2>/dev/null || true
        fi
        if [ -d "$INSTALL_DIR/.converted" ] && [ ! -L "$INSTALL_DIR/.converted" ]; then
            echo "  Migrating converted cache from $INSTALL_DIR/.converted to $DATA_ROOT/converted..."
            rsync -aH --delete "$INSTALL_DIR/.converted/" "$DATA_ROOT/converted/" 2>/dev/null || true
        fi
        if [ -d "$INSTALL_DIR/logs" ] && [ ! -L "$INSTALL_DIR/logs" ]; then
            echo "  Migrating logs from $INSTALL_DIR/logs to $DATA_ROOT/logs..."
            rsync -aH "$INSTALL_DIR/logs/" "$DATA_ROOT/logs/" 2>/dev/null || true
        fi
        ;;
    external_fstab)
        # Внешний диск через /etc/fstab
        mkdir -p "$DATA_ROOT"
        if [ -n "$CONTENT_SOURCE" ]; then
            # Добавим запись в /etc/fstab, если её ещё нет
            if ! grep -qE "^[^#]*[[:space:]]+$DATA_ROOT[[:space:]]" /etc/fstab; then
                echo "$CONTENT_SOURCE $DATA_ROOT $CONTENT_FSTAB_OPTS" >> /etc/fstab
                echo "  Added to /etc/fstab: $CONTENT_SOURCE -> $DATA_ROOT ($CONTENT_FSTAB_OPTS)"
            fi
            mount -a || true
        fi
        mkdir -p "$DATA_ROOT/content"
        mkdir -p "$DATA_ROOT/streams"
        mkdir -p "$DATA_ROOT/converted"
        mkdir -p "$DATA_ROOT/logs"
        mkdir -p "$DATA_ROOT/temp"
        # Миграция существующих данных, если есть
        if [ -d "$INSTALL_DIR/public/content" ] && [ ! -L "$INSTALL_DIR/public/content" ]; then
            echo "  Migrating content from $INSTALL_DIR/public/content to $DATA_ROOT/content..."
            rsync -aH --delete "$INSTALL_DIR/public/content/" "$DATA_ROOT/content/" 2>/dev/null || true
        fi
        if [ -d "$INSTALL_DIR/.converted" ] && [ ! -L "$INSTALL_DIR/.converted" ]; then
            echo "  Migrating converted cache from $INSTALL_DIR/.converted to $DATA_ROOT/converted..."
            rsync -aH --delete "$INSTALL_DIR/.converted/" "$DATA_ROOT/converted/" 2>/dev/null || true
        fi
        if [ -d "$INSTALL_DIR/logs" ] && [ ! -L "$INSTALL_DIR/logs" ]; then
            echo "  Migrating logs from $INSTALL_DIR/logs to $DATA_ROOT/logs..."
            rsync -aH "$INSTALL_DIR/logs/" "$DATA_ROOT/logs/" 2>/dev/null || true
        fi
        ;;
    *)
        # Защита по умолчанию - локальное хранение
        mkdir -p "$INSTALL_DIR/data/content"
        mkdir -p "$INSTALL_DIR/data/streams"
        mkdir -p "$INSTALL_DIR/data/converted"
        mkdir -p "$INSTALL_DIR/data/logs"
        mkdir -p "$INSTALL_DIR/data/temp"
        ;;
esac

# Устанавливаем права
chown -R $CURRENT_USER:$CURRENT_USER "$INSTALL_DIR"
if [ "$STORAGE_MODE" != "local" ]; then
    chown -R $CURRENT_USER:$CURRENT_USER "$DATA_ROOT" 2>/dev/null || true
    if [ -n "$CONTENT_DIR" ] && [ "$CONTENT_DIR" != "$DATA_ROOT" ]; then
        chown -R $CURRENT_USER:$CURRENT_USER "$CONTENT_DIR" 2>/dev/null || true
    fi
fi
# Создаем nginx_upload если нужно (для старых конфигов)
if [ -d "temp" ] && [ ! -d "temp/nginx_upload" ]; then
    mkdir -p temp/nginx_upload
    chmod 755 temp/nginx_upload
fi

# Создаем .env с JWT secret
echo "  Creating .env configuration..."
if [ ! -f .env ]; then
    JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
    cat > .env << EOF
NODE_ENV=production
PORT=3000
HOST=127.0.0.1

# JWT Authentication (12h access, 30d refresh)
JWT_SECRET=$JWT_SECRET
JWT_ACCESS_EXPIRES_IN=12h
JWT_REFRESH_EXPIRES_IN=30d

# Logging level (info, warn, error, debug)
LOG_LEVEL=info
EOF
    chown $CURRENT_USER:$CURRENT_USER .env
    echo -e "  ${GREEN}✅ .env created with secure JWT secret${NC}"
fi

# Инициализируем БД и применяем миграции
echo "  Initializing SQLite database..."
if [ ! -f config/main.db ]; then
    sqlite3 config/main.db < src/database/init.sql
    chown $CURRENT_USER:$CURRENT_USER config/main.db
    echo -e "  ${GREEN}✅ Database initialized with default schema and admin user${NC}"
    echo -e "  ${YELLOW}📝 Default admin: admin / admin123${NC}"
    echo -e "  ${RED}⚠️  CHANGE PASSWORD AFTER FIRST LOGIN!${NC}"
else
    echo -e "  ${YELLOW}⚠️  Database already exists${NC}"
fi

echo "  Initializing hero module database..."
if [ ! -f config/hero/heroes.db ]; then
    sqlite3 config/hero/heroes.db < src/hero/database/schema.sql
    chown $CURRENT_USER:$CURRENT_USER config/hero/heroes.db
    echo -e "  ${GREEN}✅ Hero database initialized (config/hero/heroes.db)${NC}"
else
    echo -e "  ${YELLOW}⚠️  Hero database already exists${NC}"
fi

# Создаем конфигурацию видео-оптимизации если нет
if [ ! -f config/video-optimization.json ]; then
    cp config/video-optimization.json.example config/video-optimization.json 2>/dev/null || \
    cat > config/video-optimization.json << 'EOF'
{
  "enabled": true,
  "autoOptimize": true,
  "deleteOriginal": true,
  "defaultProfile": "1080p"
}
EOF
fi

# Создаем app-settings.json с правильным contentRoot (v3.0.0)
echo "  Creating app-settings.json..."
if [ ! -f config/app-settings.json ]; then
    # Определяем contentRoot в зависимости от режима хранения
    if [ "$STORAGE_MODE" = "local" ]; then
        CONTENT_ROOT="$INSTALL_DIR/data"
    else
        CONTENT_ROOT="$DATA_ROOT"
    fi
    
    cat > config/app-settings.json << EOF
{
  "contentRoot": "$CONTENT_ROOT",
  "version": "3.0.0"
}
EOF
    chown $CURRENT_USER:$CURRENT_USER config/app-settings.json
    echo -e "  ${GREEN}✅ app-settings.json created with contentRoot: $CONTENT_ROOT${NC}"
else
    echo -e "  ${YELLOW}⚠️  app-settings.json already exists${NC}"
fi

echo -e "${GREEN}✅ Project structure created${NC}"

# ==========================================
# PHASE 5: NETWORK OPTIMIZATION
# ==========================================
echo ""
echo -e "${BLUE}[5/7] Optimizing network for large file uploads...${NC}"

if [ -f scripts/optimize-network.sh ]; then
    bash scripts/optimize-network.sh
    echo -e "${GREEN}✅ TCP buffers optimized (16MB for fast uploads)${NC}"
fi

# ==========================================
# PHASE 6: NGINX INSTALLATION
# ==========================================
echo ""
echo -e "${BLUE}[6/7] Installing and configuring Nginx...${NC}"

# Устанавливаем Nginx
if ! command -v nginx &> /dev/null; then
    apt-get install -y nginx
fi

# Копируем secure конфигурацию (с защитой)
cp nginx/videocontrol-secure.conf /etc/nginx/sites-available/videocontrol

# Обновляем IP адреса в конфиге
SERVER_IP=$(hostname -I | awk '{print $1}')
SUBNET=$(echo $SERVER_IP | cut -d'.' -f1-3).0/24

echo "  Detected server IP: $SERVER_IP"
echo "  Using subnet: $SUBNET"

# Автоматически настраиваем geo правила
sed -i "s|10.172.0.0/24|$SUBNET|g" /etc/nginx/sites-available/videocontrol

# Удаляем старые конфиги
rm -f /etc/nginx/sites-enabled/default
rm -f /etc/nginx/sites-enabled/videocontrol.conf 2>/dev/null
rm -f /etc/nginx/sites-available/videocontrol.conf 2>/dev/null

# Создаем симлинк
ln -sf /etc/nginx/sites-available/videocontrol /etc/nginx/sites-enabled/videocontrol

# Проверяем конфигурацию
if nginx -t; then
    systemctl enable nginx
    systemctl restart nginx
    echo -e "${GREEN}✅ Nginx configured and running${NC}"
else
    echo -e "${RED}❌ Nginx configuration error${NC}"
    exit 1
fi

# ==========================================
# PHASE 7: SYSTEMD SERVICE
# ==========================================
echo ""
echo -e "${BLUE}[7/7] Creating systemd service...${NC}"

# Создаем группу vcgroup для управления правами
if ! getent group vcgroup > /dev/null 2>&1; then
    groupadd vcgroup
    echo -e "  ${GREEN}✅ Group vcgroup created${NC}"
else
    echo -e "  ${GREEN}✅ Group vcgroup already exists${NC}"
fi

# Добавляем текущего пользователя в vcgroup
usermod -a -G vcgroup $CURRENT_USER
echo -e "  ${GREEN}✅ User $CURRENT_USER added to vcgroup${NC}"

# Создаем домашнюю директорию с .cache для LibreOffice
mkdir -p /home/$CURRENT_USER/.cache /home/$CURRENT_USER/.config
chown -R $CURRENT_USER:vcgroup /home/$CURRENT_USER/.cache /home/$CURRENT_USER/.config
chmod 755 /home/$CURRENT_USER/.cache /home/$CURRENT_USER/.config
echo -e "  ${GREEN}✅ LibreOffice cache directories created${NC}"

# Определяем ReadWritePaths для systemd (v3.0.0 - динамические пути)
if [ "$STORAGE_MODE" = "local" ]; then
    READ_WRITE_PATHS="$INSTALL_DIR/data $INSTALL_DIR/config"
else
    READ_WRITE_PATHS="$DATA_ROOT $INSTALL_DIR/config"
fi

cat > /etc/systemd/system/videocontrol.service << EOF
[Unit]
Description=VideoControl Server v3.0.0
After=network.target

[Service]
Type=simple
User=$CURRENT_USER
Group=vcgroup
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node $INSTALL_DIR/server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$READ_WRITE_PATHS

# Environment
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable videocontrol
systemctl start videocontrol

# Проверяем запуск
sleep 3
if systemctl is-active --quiet videocontrol; then
    echo -e "${GREEN}✅ VideoControl service running${NC}"
else
    echo -e "${RED}❌ Service failed to start. Check logs:${NC}"
    echo "   journalctl -u videocontrol -n 50"
    exit 1
fi

# ==========================================
# INSTALLATION COMPLETE
# ==========================================
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  ✅ Installation Complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "🎉 VideoControl v3.0.0 successfully installed!"
echo ""
echo "📂 Installation directory: $INSTALL_DIR"
echo "📊 Database: config/main.db (SQLite)"
echo "🌐 Server: http://$(hostname -I | awk '{print $1}')"
echo ""
echo "📦 Data storage:"
echo "  Mode: $STORAGE_MODE"
if [ "$STORAGE_MODE" = "local" ]; then
echo "  Path: $INSTALL_DIR/data/*"
echo "    - content/ - device files"
echo "    - streams/ - HLS restream output"
echo "    - converted/ - PDF/PPTX cache"
echo "    - logs/ - application logs"
echo "    - temp/ - temporary files"
else
echo "  Target: $DATA_ROOT/*"
echo "    - content/ - device files"
echo "    - streams/ - HLS restream output"
echo "    - converted/ - PDF/PPTX cache"
echo "    - logs/ - application logs"
echo "    - temp/ - temporary files"
fi
echo ""
echo "🔐 Default Admin Credentials:"
echo "  Username: admin"
echo "  Password: admin123"
echo "  🚨 ОБЯЗАТЕЛЬНО смените пароль после первого входа!"
echo ""
echo "🚀 Access URLs:"
echo "  📱 Admin:   http://$(hostname -I | awk '{print $1}')/"
echo "  🎤 Speaker: http://$(hostname -I | awk '{print $1}')/speaker.html"
echo "  🎮 Player:  http://$(hostname -I | awk '{print $1}')/player-videojs.html?device_id=DEVICE_ID"
echo ""
echo "🔒 Security Features:"
echo "  ✅ JWT Authentication (12h access, 30d refresh)"
echo "  ✅ Two-level security (Network + JWT)"
echo "  ✅ Rate limiting (disabled for local network)"
echo "  ✅ Path traversal protection"
echo "  ✅ Audit logging to database"
echo "  ✅ Winston structured logs (data/logs/)"
echo ""
echo "📋 Quick Start:"
echo "  1. Login: http://$(hostname -I | awk '{print $1}')/ (admin/admin123)"
echo "  2. Create users in Admin panel"
echo "  3. Add devices in Admin panel"
echo "  4. Upload content (max 5GB per file)"
echo "  5. Control via Speaker panel"
echo ""
echo "🔧 Useful commands:"
echo "  Status:  sudo systemctl status videocontrol"
echo "  Restart: sudo systemctl restart videocontrol"
if [ "$STORAGE_MODE" = "local" ]; then
    LOGS_DIR="$INSTALL_DIR/data/logs"
else
    LOGS_DIR="$DATA_ROOT/logs"
fi
echo "  Logs:    tail -f $LOGS_DIR/combined-*.log"
echo "  Errors:  tail -f $LOGS_DIR/error-*.log"
echo "  Audit:   sqlite3 $INSTALL_DIR/config/main.db 'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 10;'"
echo "  Stop:    sudo systemctl stop videocontrol"
echo ""
echo "📚 Documentation:"
echo "  Main:     $INSTALL_DIR/README.md"
echo "  Install:  $INSTALL_DIR/INSTALL.md (new OS setup)"
echo "  Quick:    $INSTALL_DIR/QUICK-START.md"
echo "  Manual:   $INSTALL_DIR/docs/MANUAL.md"
echo ""
echo "🛠️  Utility scripts:"
echo "  Check env:  bash $INSTALL_DIR/scripts/check-environment.sh"
echo "  Cleanup:    bash $INSTALL_DIR/scripts/cleanup.sh"
echo ""

