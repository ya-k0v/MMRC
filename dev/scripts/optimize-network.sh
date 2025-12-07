#!/bin/bash
# ========================================
# VideoControl Network Optimization Script
# ========================================
# Оптимизация TCP буферов для быстрой загрузки больших файлов (1.5GB+)
#
# НАЗНАЧЕНИЕ:
#   Увеличение TCP буферов с ~200KB до 16MB для достижения полной скорости
#   Gigabit сети при загрузке больших файлов (видео, архивы).
#
# ПРОБЛЕМА:
#   По умолчанию Linux использует маленькие TCP буферы (~200KB), что ограничивает
#   скорость загрузки до 10-20 MB/s даже на Gigabit сети.
#
# РЕШЕНИЕ:
#   Увеличение TCP буферов до 16MB позволяет достичь скорости 80-120 MB/s.
#
# ИСПОЛЬЗОВАНИЕ:
#   sudo bash dev/scripts/optimize-network.sh
#
# ЧТО ДЕЛАЕТ СКРИПТ:
#   1. Увеличивает TCP буферы (rmem_max, wmem_max) до 16MB
#   2. Настраивает TCP оптимизации (window scaling, SACK, timestamps)
#   3. Увеличивает backlog для высоких нагрузок
#   4. Включает TCP Fast Open
#   5. Сохраняет настройки в /etc/sysctl.d/99-videocontrol.conf
#
# РЕЗУЛЬТАТ:
#   До оптимизации:  ~10-20 MB/s (1.5GB файл загружается 2-5 минут)
#   После оптимизации: ~80-120 MB/s (1.5GB файл загружается 15-30 секунд)
#
# ПРИМЕНЕНИЕ:
#   - Настройки применяются сразу (sysctl -w)
#   - Сохраняются в /etc/sysctl.d/99-videocontrol.conf
#   - Автоматически применяются при загрузке системы
#
# ТРЕБОВАНИЯ:
#   - Запуск от root (sudo)
#   - Ubuntu/Debian Linux
#
# ========================================

echo "=== VideoControl Network Optimization ==="
echo ""

# Проверка прав
if [ "$EUID" -ne 0 ]; then 
    echo "❌ Please run as root (sudo)"
    exit 1
fi

echo "Current TCP buffer sizes:"
echo "  net.core.rmem_max = $(sysctl -n net.core.rmem_max)"
echo "  net.core.wmem_max = $(sysctl -n net.core.wmem_max)"
echo "  net.ipv4.tcp_rmem = $(sysctl -n net.ipv4.tcp_rmem)"
echo "  net.ipv4.tcp_wmem = $(sysctl -n net.ipv4.tcp_wmem)"
echo ""

echo "Applying optimizations for Gigabit network and large file uploads..."

# Увеличиваем TCP буферы для Gigabit сети
sysctl -w net.core.rmem_max=16777216     # 16 MB (было ~200 KB)
sysctl -w net.core.wmem_max=16777216     # 16 MB (было ~200 KB)
sysctl -w net.core.rmem_default=262144   # 256 KB
sysctl -w net.core.wmem_default=262144   # 256 KB

# TCP буферы (min, default, max)
sysctl -w net.ipv4.tcp_rmem="4096 87380 16777216"  # макс 16 MB для чтения
sysctl -w net.ipv4.tcp_wmem="4096 87380 16777216"  # макс 16 MB для записи

# TCP оптимизации
sysctl -w net.ipv4.tcp_window_scaling=1           # Включить масштабирование окна
sysctl -w net.ipv4.tcp_timestamps=1               # TCP timestamps для лучшего RTT
sysctl -w net.ipv4.tcp_sack=1                     # Selective ACK
sysctl -w net.ipv4.tcp_no_metrics_save=1          # Не сохранять метрики между соединениями
sysctl -w net.ipv4.tcp_moderate_rcvbuf=1          # Автонастройка receive buffer

# Увеличиваем backlog для высоких нагрузок
sysctl -w net.core.netdev_max_backlog=5000
sysctl -w net.core.somaxconn=1024

# Оптимизация для локальной сети (низкий latency)
sysctl -w net.ipv4.tcp_fastopen=3                 # TCP Fast Open

echo ""
echo "✅ Network optimizations applied!"
echo ""
echo "New TCP buffer sizes:"
echo "  net.core.rmem_max = $(sysctl -n net.core.rmem_max)"
echo "  net.core.wmem_max = $(sysctl -n net.core.wmem_max)"
echo "  net.ipv4.tcp_rmem = $(sysctl -n net.ipv4.tcp_rmem)"
echo "  net.ipv4.tcp_wmem = $(sysctl -n net.ipv4.tcp_wmem)"
echo ""

# Сохраняем настройки для применения при загрузке
SYSCTL_CONF="/etc/sysctl.d/99-videocontrol.conf"
cat > "$SYSCTL_CONF" << 'EOF'
# VideoControl Network Optimization
# Оптимизация для быстрой загрузки больших файлов (1.5GB+)

# TCP буферы (16 MB max для Gigabit сети)
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 262144
net.core.wmem_default = 262144
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 87380 16777216

# TCP оптимизации
net.ipv4.tcp_window_scaling = 1
net.ipv4.tcp_timestamps = 1
net.ipv4.tcp_sack = 1
net.ipv4.tcp_no_metrics_save = 1
net.ipv4.tcp_moderate_rcvbuf = 1

# Network backlog
net.core.netdev_max_backlog = 5000
net.core.somaxconn = 1024

# TCP Fast Open
net.ipv4.tcp_fastopen = 3
EOF

echo "✅ Settings saved to $SYSCTL_CONF"
echo "   Will be applied automatically on next boot"
echo ""
echo "⚡ Expected upload speed improvement:"
echo "   Before: ~10-20 MB/s (limited by 200KB buffers)"
echo "   After:  ~80-120 MB/s (full Gigabit speed)"
echo ""
echo "   For 1.5GB file:"
echo "   Before: ~2-5 minutes"
echo "   After:  ~15-30 seconds"

