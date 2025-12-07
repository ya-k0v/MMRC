#!/bin/bash
# ========================================
# VideoControl Server Installation Script
# ========================================
# Упрощённая установка сервера без Nginx (для dev окружений)
#
# НАЗНАЧЕНИЕ:
#   Установка только серверной части VideoControl без Nginx:
#   - Установка системных зависимостей (Node.js, FFmpeg, LibreOffice)
#   - Установка npm пакетов
#   - Создание структуры папок
#   - Инициализация базы данных
#   - Создание systemd сервиса
#
# ОТЛИЧИЕ ОТ quick-install.sh:
#   - НЕ устанавливает Nginx
#   - НЕ настраивает reverse proxy
#   - НЕ применяет сетевые оптимизации
#   - Подходит для dev окружений или когда Nginx уже настроен отдельно
#
# ИСПОЛЬЗОВАНИЕ:
#   # Интерактивная установка
#   sudo bash dev/scripts/install-server.sh
#
#   # Non-interactive
#   AUTO_CONFIRM=1 sudo bash scripts/install-server.sh
#
# ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ:
#   AUTO_CONFIRM=1  - Отключает все вопросы "y/n"
#
# ПОДДЕРЖИВАЕМЫЕ ОС:
#   - Ubuntu/Debian (apt-get)
#   - CentOS/RHEL (yum)
#
# ЧТО УСТАНАВЛИВАЕТСЯ:
#   - Node.js 20.x LTS (если не установлен)
#   - FFmpeg + FFprobe
#   - LibreOffice
#   - ImageMagick
#   - SQLite3
#   - npm пакеты из package.json
#
# ЧТО СОЗДАЁТСЯ:
#   - Структура папок: config/, data/*, public/, src/
#   - База данных: config/main.db (admin/admin123)
#   - Systemd сервис: /etc/systemd/system/videocontrol.service
#
# ПОСЛЕ УСТАНОВКИ:
#   - Сервер доступен на http://localhost:3000
#   - Для production используйте Nginx как reverse proxy
#   - По умолчанию: admin / admin123 (ОБЯЗАТЕЛЬНО СМЕНИТЬ!)
#
# ========================================

set -e  # Выход при ошибке

AUTO_CONFIRM="${AUTO_CONFIRM:-0}"

echo "==================================="
echo "Video Control Server - Installation"
echo "==================================="
echo ""

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    echo "Cannot detect OS"
    exit 1
fi

echo "Detected OS: $OS"
echo ""

# Install Node.js if not installed
if ! command -v node &> /dev/null; then
    echo "Installing Node.js 20 LTS..."
    if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    elif [ "$OS" = "centos" ] || [ "$OS" = "rhel" ]; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
        sudo yum install -y nodejs
    fi
else
    echo "Node.js already installed: $(node --version)"
fi

# Install system dependencies
echo ""
echo "Installing system dependencies..."
if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
    sudo apt-get update
    sudo apt-get install -y ffmpeg libreoffice imagemagick graphicsmagick unzip sqlite3
elif [ "$OS" = "centos" ] || [ "$OS" = "rhel" ]; then
    sudo yum install -y ffmpeg libreoffice ImageMagick GraphicsMagick unzip sqlite
fi

# Install npm packages
echo ""
echo "Installing npm packages..."
npm install

# Create .env file with JWT secret
echo ""
echo "Setting up authentication..."
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

# Logging level
LOG_LEVEL=info
EOF
    echo "✅ Created .env with secure JWT secret"
    echo "   Access Token: 12 hours"
    echo "   Refresh Token: 30 days"
fi

# Create necessary directories
echo ""
echo "Creating directories..."
mkdir -p data/content
mkdir -p data/streams
mkdir -p data/converted
mkdir -p data/logs
mkdir -p data/temp
mkdir -p config
mkdir -p config/hero

# Initialize database
echo ""
echo "Initializing database..."
if [ ! -f config/main.db ]; then
    sqlite3 config/main.db < src/database/init.sql
    echo "✅ Database initialized with default schema"
    echo "   Default admin user: admin / admin123"
    echo "   ⚠️  CHANGE PASSWORD AFTER FIRST LOGIN!"
else
    echo "ℹ️  Database already exists, skipping initialization"
fi

# Initialize hero module database
echo ""
if [ ! -f config/hero/heroes.db ]; then
    sqlite3 config/hero/heroes.db < src/hero/database/schema.sql
    echo "✅ Hero database initialized (config/hero/heroes.db)"
else
    echo "ℹ️  Hero database already exists (config/hero/heroes.db)"
fi

# Create default config files if not exist
if [ ! -f config/video-optimization.json ]; then
    echo '{"enabled": true, "targetResolution": "1080p"}' > config/video-optimization.json
    echo "Created config/video-optimization.json"
fi

# Setup systemd service
echo ""
if [ "$AUTO_CONFIRM" = "1" ]; then
    REPLY="y"
else
    read -p "Install as systemd service? (y/n): " -n 1 -r
    echo ""
fi
if [[ $REPLY =~ ^[Yy]$ ]]; then
    CURRENT_USER=$(whoami)
    CURRENT_DIR=$(pwd)
    
    cat > /tmp/videocontrol.service << EOF
[Unit]
Description=Video Control Server
After=network.target

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$CURRENT_DIR
ExecStart=/usr/bin/node $CURRENT_DIR/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
    
    sudo mv /tmp/videocontrol.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable videocontrol
    
    echo ""
    echo "Systemd service installed!"
    echo "Start: sudo systemctl start videocontrol"
    echo "Status: sudo systemctl status videocontrol"
    echo "Logs: sudo journalctl -u videocontrol -f"
fi

# Setup Nginx
echo ""
if [ "$AUTO_CONFIRM" = "1" ]; then
    REPLY="y"
else
    read -p "Install and configure Nginx? (y/n): " -n 1 -r
    echo ""
fi
if [[ $REPLY =~ ^[Yy]$ ]]; then
    if [ -f nginx/install-nginx.sh ]; then
        cd nginx
        sudo bash install-nginx.sh
        cd ..
    else
        echo "ℹ️  Nginx configuration file not found (nginx/install-nginx.sh)"
        echo "   Use quick-install.sh for automatic Nginx setup"
    fi
fi

echo ""
echo "==================================="
echo "✅ Installation Complete!"
echo "==================================="
echo ""
echo "🔐 Default Admin Credentials:"
echo "  Username: admin"
echo "  Password: admin123"
echo "  🚨 ОБЯЗАТЕЛЬНО смените после первого входа!"
echo ""
echo "📁 Project structure created:"
echo "  ✅ config/ - configuration files + main.db"
echo "  ✅ data/content/ - device content (up to 5GB per file)"
echo "  ✅ data/streams/ - HLS restream output"
echo "  ✅ data/converted/ - converted PDF/PPTX cache"
echo "  ✅ data/logs/ - Winston structured logs"
echo "  ✅ data/temp/ - temporary files"
echo ""
echo "🚀 Start server:"
echo "  Development: npm start"
echo "  Production:  sudo systemctl start videocontrol"
echo ""
echo "🌐 Access URLs:"
echo "  Login:        http://localhost/"
echo "  Admin Panel:  http://localhost/ (admin/admin123)"
echo "  Speaker Panel: http://localhost/speaker.html"
echo "  Player:       http://localhost/player-videojs.html?device_id=YOUR_ID"
echo ""
echo "🔒 Security Features:"
echo "  ✅ JWT Authentication (12h access, 30d refresh)"
echo "  ✅ Rate limiting (disabled for local network)"
echo "  ✅ Path traversal protection"
echo "  ✅ Audit logging to database"
echo ""
echo "📊 Monitoring:"
echo "  Status:  sudo systemctl status videocontrol"
echo "  Logs:    tail -f data/logs/combined-*.log"
echo "  Errors:  tail -f data/logs/error-*.log"
echo "  Audit:   sqlite3 config/main.db 'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 10;'"
echo "  Journal: sudo journalctl -u videocontrol -f"
echo ""
echo "📖 Documentation:"
echo "  📘 Overview:      README.md"
echo "  🚀 Quick start:   QUICK-START.md"
echo "  🧰 Operations:    dev/MANUAL.md"
echo "  📱 Android:       clients/android-mediaplayer/README.md"
echo "  🎧 MPV client:    clients/mpv/README.md"
echo ""

