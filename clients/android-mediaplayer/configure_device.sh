#!/bin/bash
# ============================================================================
# Скрипт для удаленной настройки Android приложения VideoControl MediaPlayer
# ============================================================================
# Использование: ./configure_device.sh <device> <server_ip> <device_id> [show_status]
#
# Параметры:
#   device      - Адрес устройства через adb (например: 10.172.1.80:5555)
#   server_ip   - IP адрес сервера (например: 10.172.1.74)
#   device_id   - Уникальный ID устройства (например: ATV001)
#   show_status - Показывать ли статус на экране (true/false, по умолчанию: false)
#
# Примеры:
#   ./configure_device.sh 10.172.1.80:5555 10.172.1.74 ATV001
#   ./configure_device.sh 10.172.1.80:5555 10.172.1.74 ATV001 true
# ============================================================================

set -e  # Прерывать выполнение при ошибках

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Функция для вывода информации
info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

# Функция для вывода успеха
success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

# Функция для вывода предупреждения
warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

# Функция для вывода ошибки
error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Функция для проверки подключения устройства
check_device() {
    local device=$1
    if ! adb -s "$device" shell echo > /dev/null 2>&1; then
        error "Не удалось подключиться к устройству: $device"
        echo "Проверьте: adb devices, adb connect $device"
        exit 1
    fi
}

# Функция для проверки установки приложения
check_app_installed() {
    local device=$1
    if ! adb -s "$device" shell pm list packages | grep -q "com.videocontrol.mediaplayer"; then
        error "Приложение не установлено: com.videocontrol.mediaplayer"
        exit 1
    fi
}

# Функция для валидации параметров
validate_params() {
    local server_ip=$1
    local device_id=$2
    
    if ! [[ $server_ip =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
        error "Неверный формат IP адреса: $server_ip"
        exit 1
    fi
    
    if [ -z "$device_id" ] || [ ${#device_id} -lt 1 ]; then
        error "ID устройства не может быть пустым"
        exit 1
    fi
}

# Парсинг аргументов
DEVICE=${1:-"10.172.1.80:5555"}
SERVER_IP=$2
DEVICE_ID=$3
SHOW_STATUS=${4:-"false"}

# Проверка обязательных параметров
if [ -z "$SERVER_IP" ] || [ -z "$DEVICE_ID" ]; then
    echo ""
    error "Не указаны обязательные параметры"
    echo ""
    echo "Использование: $0 <device> <server_ip> <device_id> [show_status]"
    echo ""
    echo "Параметры:"
    echo "  device      - Адрес устройства через adb (по умолчанию: 10.172.1.80:5555)"
    echo "  server_ip   - IP адрес сервера (обязательно)"
    echo "  device_id   - Уникальный ID устройства (обязательно)"
    echo "  show_status - Показывать статус на экране: true/false (по умолчанию: false)"
    echo ""
    echo "Примеры:"
    echo "  $0 10.172.1.80:5555 10.172.1.74 ATV001"
    echo "  $0 10.172.1.80:5555 10.172.1.74 ATV001 true"
    echo "  $0 10.172.1.80:5555 10.172.1.74 ATV002 false"
    echo ""
    echo "Альтернативный способ (напрямую через adb):"
    echo "  adb -s $DEVICE shell am broadcast -a com.videocontrol.mediaplayer.CONFIGURE \\"
    echo "    --es server_url \"$SERVER_IP\" \\"
    echo "    --es device_id \"$DEVICE_ID\" \\"
    echo "    --ez show_status $SHOW_STATUS"
    echo ""
    exit 1
fi

# Валидация show_status
if [ "$SHOW_STATUS" != "true" ] && [ "$SHOW_STATUS" != "false" ]; then
    SHOW_STATUS="false"
fi

# Проверки
check_device "$DEVICE"
check_app_installed "$DEVICE"
validate_params "$SERVER_IP" "$DEVICE_ID"

# Применение настроек через BroadcastReceiver
if adb -s "$DEVICE" shell am broadcast -a com.videocontrol.mediaplayer.CONFIGURE \
  --es server_url "$SERVER_IP" \
  --es device_id "$DEVICE_ID" \
  --ez show_status "$SHOW_STATUS" > /dev/null 2>&1; then
    
    # Перезапуск приложения
    adb -s "$DEVICE" shell am force-stop com.videocontrol.mediaplayer > /dev/null 2>&1
    sleep 1
    adb -s "$DEVICE" shell am start -n com.videocontrol.mediaplayer/.MainActivity > /dev/null 2>&1
    
    success "Настройки применены: Server=$SERVER_IP, DeviceID=$DEVICE_ID, ShowStatus=$SHOW_STATUS"
    exit 0
else
    # Метод 2: Прямая запись в SharedPreferences (fallback)
    XML_CONTENT="<?xml version=\"1.0\" encoding=\"utf-8\" standalone=\"yes\" ?>
<map>
    <string name=\"server_url\">$SERVER_IP</string>
    <string name=\"device_id\">$DEVICE_ID</string>
    <boolean name=\"show_status\" value=\"$SHOW_STATUS\" />
</map>
"
    
    if adb -s "$DEVICE" shell "run-as com.videocontrol.mediaplayer sh -c 'mkdir -p shared_prefs && cat > shared_prefs/VCMediaPlayerSettings.xml'" <<< "$XML_CONTENT" > /dev/null 2>&1; then
        adb -s "$DEVICE" shell "am force-stop com.videocontrol.mediaplayer" > /dev/null 2>&1
        sleep 1
        adb -s "$DEVICE" shell "am start -n com.videocontrol.mediaplayer/.MainActivity" > /dev/null 2>&1
        success "Настройки применены (fallback): Server=$SERVER_IP, DeviceID=$DEVICE_ID, ShowStatus=$SHOW_STATUS"
        exit 0
    else
        error "Не удалось применить настройки"
        exit 1
    fi
fi

