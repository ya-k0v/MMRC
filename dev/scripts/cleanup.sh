#!/bin/bash
#
# Скрипт очистки временных файлов и резервных копий
# Использование: bash dev/scripts/cleanup.sh [--aggressive]
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "🧹 Очистка временных файлов VideoControl..."

# Цвета для вывода
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Счетчики
DELETED=0
SKIPPED=0

# Функция безопасного удаления
safe_delete() {
    local file="$1"
    if [ -f "$file" ]; then
        rm -f "$file"
        echo -e "${GREEN}✅ Удален:${NC} $file"
        ((DELETED++))
    else
        ((SKIPPED++))
    fi
}

# 1. Удаление резервных копий БД
echo ""
echo "📦 Очистка резервных копий БД..."
for backup in config/main.db.backup.* config/heroes.db.backup.* config/hero/heroes.db.backup.*; do
    if [ -f "$backup" ]; then
        safe_delete "$backup"
    fi
done

# 2. Удаление временных файлов SQLite (только если БД не используется)
echo ""
echo "🗄️  Очистка временных файлов SQLite..."
# Проверяем, запущен ли сервер (процесс использует БД)
if pgrep -f "node.*server.js" > /dev/null; then
    echo -e "${YELLOW}⚠️  Сервер запущен, пропускаем .db-shm и .db-wal файлы${NC}"
    echo "   (они будут автоматически пересозданы при необходимости)"
else
    # Удаляем только если сервер не запущен
    for shm in config/*.db-shm config/hero/*.db-shm; do
        safe_delete "$shm"
    done
    for wal in config/*.db-wal config/hero/*.db-wal; do
        safe_delete "$wal"
    done
fi

# 3. Очистка старых логов (старше 30 дней)
if [ "$1" == "--aggressive" ]; then
    echo ""
    echo "📋 Очистка старых логов (старше 30 дней)..."
    if [ -d "logs" ]; then
        while IFS= read -r file; do
            if [ -n "$file" ]; then
                rm -f "$file"
                echo -e "${GREEN}✅ Удален:${NC} $file"
                ((DELETED++))
            fi
        done < <(find logs/ -name "*.log" -type f -mtime +30 2>/dev/null)
    fi
    if [ -d "data/logs" ]; then
        while IFS= read -r file; do
            if [ -n "$file" ]; then
                rm -f "$file"
                echo -e "${GREEN}✅ Удален:${NC} $file"
                ((DELETED++))
            fi
        done < <(find data/logs/ -name "*.log" -type f -mtime +30 2>/dev/null)
    fi
else
    echo ""
    echo -e "${YELLOW}ℹ️  Логи не очищены (используйте --aggressive для удаления логов старше 30 дней)${NC}"
fi

# 4. Очистка пустой директории temp
echo ""
echo "📁 Проверка директории temp..."
if [ -d "temp" ] && [ -z "$(ls -A temp 2>/dev/null)" ]; then
    rmdir temp 2>/dev/null && echo -e "${GREEN}✅ Удалена пустая директория: temp/${NC}" || true
fi

# 5. Очистка старых файлов в data/temp (старше 7 дней)
if [ -d "data/temp" ]; then
    echo ""
    echo "🗑️  Очистка старых временных файлов в data/temp (старше 7 дней)..."
    while IFS= read -r file; do
        if [ -n "$file" ]; then
            rm -f "$file"
            echo -e "${GREEN}✅ Удален:${NC} $file"
            ((DELETED++))
        fi
    done < <(find data/temp/ -type f -mtime +7 2>/dev/null)
fi

# Итоги
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✅ Очистка завершена!${NC}"
echo "   Удалено файлов: $DELETED"
echo "   Пропущено: $SKIPPED"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

