#!/bin/bash
#
# Скрипт проверки окружения для VideoControl
# Проверяет наличие всех необходимых зависимостей и инструментов
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Цвета для вывода
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Счетчики
ERRORS=0
WARNINGS=0

# Функция проверки команды
check_command() {
    local cmd="$1"
    local name="$2"
    local required="${3:-true}"
    
    if command -v "$cmd" > /dev/null 2>&1; then
        local version=$(eval "$cmd --version 2>&1 | head -1" || echo "unknown")
        echo -e "${GREEN}✅${NC} $name: $version"
        return 0
    else
        if [ "$required" = "true" ]; then
            echo -e "${RED}❌${NC} $name: не установлен (обязательно)"
            ((ERRORS++))
            return 1
        else
            echo -e "${YELLOW}⚠️${NC}  $name: не установлен (опционально)"
            ((WARNINGS++))
            return 0
        fi
    fi
}

# Функция проверки версии Node.js
check_node_version() {
    if command -v node > /dev/null 2>&1; then
        local version=$(node --version | sed 's/v//')
        local major=$(echo "$version" | cut -d. -f1)
        if [ "$major" -ge 20 ]; then
            echo -e "${GREEN}✅${NC} Node.js: v$version (требуется >= 20.x)"
        else
            echo -e "${RED}❌${NC} Node.js: v$version (требуется >= 20.x)"
            ((ERRORS++))
        fi
    else
        echo -e "${RED}❌${NC} Node.js: не установлен"
        ((ERRORS++))
    fi
}

# Функция проверки npm пакетов
check_npm_packages() {
    echo ""
    echo -e "${BLUE}📦 Проверка npm зависимостей...${NC}"
    
    if [ ! -f "package.json" ]; then
        echo -e "${RED}❌${NC} package.json не найден"
        ((ERRORS++))
        return
    fi
    
    if [ ! -d "node_modules" ]; then
        echo -e "${YELLOW}⚠️${NC}  node_modules не найден, запустите: npm install"
        ((WARNINGS++))
        return
    fi
    
    # Проверяем основные зависимости
    local deps=("express" "better-sqlite3" "socket.io" "bcrypt" "jsonwebtoken")
    for dep in "${deps[@]}"; do
        if [ -d "node_modules/$dep" ]; then
            local version=$(node -p "require('$dep/package.json').version" 2>/dev/null || echo "unknown")
            echo -e "${GREEN}✅${NC} $dep: v$version"
        else
            echo -e "${RED}❌${NC} $dep: не установлен"
            ((ERRORS++))
        fi
    done
}

# Функция проверки директорий
check_directories() {
    echo ""
    echo -e "${BLUE}📁 Проверка структуры директорий...${NC}"
    
    local dirs=("src" "public" "config" "scripts")
    for dir in "${dirs[@]}"; do
        if [ -d "$dir" ]; then
            echo -e "${GREEN}✅${NC} $dir/"
        else
            echo -e "${RED}❌${NC} $dir/: не найдена"
            ((ERRORS++))
        fi
    done
    
    # Проверяем важные файлы
    local files=("server.js" "package.json" "src/database/init.sql")
    for file in "${files[@]}"; do
        if [ -f "$file" ]; then
            echo -e "${GREEN}✅${NC} $file"
        else
            echo -e "${RED}❌${NC} $file: не найден"
            ((ERRORS++))
        fi
    done
}

# Функция проверки прав доступа
check_permissions() {
    echo ""
    echo -e "${BLUE}🔐 Проверка прав доступа...${NC}"
    
    # Проверяем, можем ли мы создать директории данных
    local test_dirs=("data" "config" "logs")
    for dir in "${test_dirs[@]}"; do
        if [ ! -d "$dir" ]; then
            if mkdir -p "$dir" 2>/dev/null; then
                echo -e "${GREEN}✅${NC} Можем создать $dir/"
                rmdir "$dir" 2>/dev/null || true
            else
                echo -e "${RED}❌${NC} Нет прав на создание $dir/"
                ((ERRORS++))
            fi
        else
            if [ -w "$dir" ]; then
                echo -e "${GREEN}✅${NC} $dir/ доступен для записи"
            else
                echo -e "${RED}❌${NC} $dir/ недоступен для записи"
                ((ERRORS++))
            fi
        fi
    done
}

# Функция проверки портов
check_ports() {
    echo ""
    echo -e "${BLUE}🔌 Проверка портов...${NC}"
    
    local port="${PORT:-3000}"
    if command -v netstat > /dev/null 2>&1; then
        if netstat -tuln 2>/dev/null | grep -q ":$port "; then
            echo -e "${YELLOW}⚠️${NC}  Порт $port уже занят"
            ((WARNINGS++))
        else
            echo -e "${GREEN}✅${NC} Порт $port свободен"
        fi
    elif command -v ss > /dev/null 2>&1; then
        if ss -tuln 2>/dev/null | grep -q ":$port "; then
            echo -e "${YELLOW}⚠️${NC}  Порт $port уже занят"
            ((WARNINGS++))
        else
            echo -e "${GREEN}✅${NC} Порт $port свободен"
        fi
    else
        echo -e "${YELLOW}⚠️${NC}  Не удалось проверить порт (netstat/ss не установлены)"
        ((WARNINGS++))
    fi
}

# Основная функция
main() {
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${BLUE}🔍 Проверка окружения VideoControl${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    
    echo -e "${BLUE}🛠️  Проверка системных инструментов...${NC}"
    check_node_version
    check_command "npm" "npm" true
    check_command "ffmpeg" "FFmpeg" true
    check_command "ffprobe" "FFprobe" true
    
    # LibreOffice обязателен для PPTX конвертации
    if command -v soffice > /dev/null 2>&1; then
        local version=$(soffice --version 2>&1 | head -1 || echo "unknown")
        echo -e "${GREEN}✅${NC} LibreOffice (soffice): $version"
    elif command -v libreoffice > /dev/null 2>&1; then
        local version=$(libreoffice --version 2>&1 | head -1 || echo "unknown")
        echo -e "${YELLOW}⚠️${NC}  LibreOffice найден, но soffice недоступен. Создайте симлинк: ln -s $(which libreoffice) /usr/bin/soffice"
        ((WARNINGS++))
    else
        echo -e "${RED}❌${NC} LibreOffice (soffice): не установлен (обязателен для PPTX конвертации)"
        ((ERRORS++))
    fi
    
    # GraphicsMagick или ImageMagick обязательны для PDF конвертации (pdf2pic)
    if command -v gm > /dev/null 2>&1; then
        local version=$(gm version 2>&1 | head -1 || echo "unknown")
        echo -e "${GREEN}✅${NC} GraphicsMagick: $version"
    elif command -v convert > /dev/null 2>&1; then
        local version=$(convert -version 2>&1 | head -1 || echo "unknown")
        echo -e "${GREEN}✅${NC} ImageMagick: $version (будет использован для pdf2pic)"
    else
        echo -e "${RED}❌${NC} GraphicsMagick или ImageMagick: не установлены (обязательны для PDF конвертации)"
        ((ERRORS++))
    fi
    
    check_command "sqlite3" "SQLite3 CLI" false
    
    check_npm_packages
    check_directories
    check_permissions
    check_ports
    
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
        echo -e "${GREEN}✅ Все проверки пройдены успешно!${NC}"
        exit 0
    elif [ $ERRORS -eq 0 ]; then
        echo -e "${YELLOW}⚠️  Проверки завершены с предупреждениями ($WARNINGS)${NC}"
        exit 0
    else
        echo -e "${RED}❌ Найдено ошибок: $ERRORS, предупреждений: $WARNINGS${NC}"
        echo ""
        echo "Для установки недостающих компонентов:"
        echo "  - Node.js 20+: https://nodejs.org/"
        echo "  - FFmpeg: sudo apt-get install ffmpeg (Ubuntu/Debian)"
        echo "  - npm install: npm install"
        exit 1
    fi
}

main "$@"

