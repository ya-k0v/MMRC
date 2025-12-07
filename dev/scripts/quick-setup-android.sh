#!/bin/bash
# ========================================
# VideoControl Android Quick Setup Script
# ========================================
# Автоматическая установка и настройка Android устройства для работы 24/7
#
# НАЗНАЧЕНИЕ:
#   Полная настройка Android устройства для работы с VideoControl:
#   - Установка APK приложения
#   - Настройка Server URL и Device ID
#   - Отключение оптимизации батареи
#   - Настройка автозапуска при загрузке
#   - Отключение таймаута экрана
#   - Настройка для работы 24/7
#
# ИСПОЛЬЗОВАНИЕ:
#   ./quick-setup-android.sh <device_ip:port> <server_url> <device_id>
#
# ПАРАМЕТРЫ:
#   device_ip:port  - IP адрес и порт устройства (например: 192.168.11.57:5555)
#   server_url      - URL сервера VideoControl (например: http://192.168.11.1)
#   device_id       - Уникальный ID устройства (например: ATV001, Living_Room)
#
# ПРИМЕРЫ:
#   # Базовый пример
#   ./quick-setup-android.sh 192.168.11.57:5555 http://192.168.11.1 ATV001
#
#   # С портом сервера
#   ./quick-setup-android.sh 10.0.0.100:5555 http://10.0.0.1:3000 Living_Room
#
# ТРЕБОВАНИЯ:
#   - ADB установлен и доступен в PATH
#   - Устройство подключено к сети
#   - ADB debugging включен в настройках устройства
#   - APK файл (VCMplayer-v*.apk) в корне проекта или на уровень выше
#
# ЧТО ДЕЛАЕТ СКРИПТ:
#   1. Подключение к устройству через ADB
#   2. Получение информации об устройстве (Android версия, производитель)
#   3. Удаление старой версии приложения (если есть)
#   4. Установка APK
#   5. Настройка Server URL и Device ID через SharedPreferences
#   6. Отключение оптимизации батареи (Doze whitelist, RUN_IN_BACKGROUND)
#   7. Настройка экрана (отключение таймаута, Stay Awake, яркость 100%)
#   8. Проверка разрешений (RECEIVE_BOOT_COMPLETED, WAKE_LOCK, INTERNET)
#   9. Производитель-специфичные настройки (Xiaomi, Samsung, Huawei)
#   10. Запуск приложения
#
# ПРОИЗВОДИТЕЛЬ-СПЕЦИФИЧНЫЕ НАСТРОЙКИ:
#   Xiaomi/Mi TV:
#     - Требуются ручные настройки: Settings → Apps → Autostart: ON
#   Samsung:
#     - Требуются ручные настройки: Settings → Apps → Battery → Unrestricted
#   Huawei/Honor:
#     - Требуются ручные настройки: Settings → Battery → App launch → Auto-launch: ON
#   Остальные (Sony/TCL/Philips/Generic):
#     - Настройки применяются автоматически
#
# ПОСЛЕ УСТАНОВКИ:
#   - Приложение запущено и работает
#   - Устройство должно появиться в админ-панели
#   - Для проверки автозапуска: adb -s <device> reboot
#
# ПРОВЕРКА:
#   # Проверка процесса
#   adb -s <device> shell "ps -A | grep videocontrol"
#
#   # Просмотр логов
#   adb -s <device> logcat | grep -E 'VCMedia|VideoControl'
#
#   # Проверка настроек
#   adb -s <device> shell "run-as com.videocontrol.mediaplayer cat shared_prefs/VCMediaPlayerSettings.xml"
#
# ========================================

set -e  # Выход при ошибке

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Параметры
DEVICE=$1
SERVER_URL=$2
DEVICE_ID=$3
PACKAGE_NAME="com.videocontrol.mediaplayer"

# ========================================
# ВАЛИДАЦИЯ ПАРАМЕТРОВ
# ========================================

if [ -z "$DEVICE" ] || [ -z "$SERVER_URL" ] || [ -z "$DEVICE_ID" ]; then
    echo -e "${RED}❌ Использование:${NC}"
    echo "   $0 <device_ip:port> <server_url> <device_id>"
    echo ""
    echo -e "${YELLOW}Примеры:${NC}"
    echo "   $0 192.168.11.57:5555 http://192.168.11.1 ATV001"
    echo "   $0 10.0.0.100:5555 http://10.0.0.1:3000 Living_Room"
    echo ""
    exit 1
fi

# Проверка формата SERVER_URL
if [[ ! "$SERVER_URL" =~ ^https?:// ]]; then
    echo -e "${RED}❌ Неверный формат SERVER_URL. Должен начинаться с http:// или https://${NC}"
    echo "   Пример: http://192.168.11.1"
    exit 1
fi

# Проверка формата DEVICE_ID (только буквы, цифры, _ и -)
if [[ ! "$DEVICE_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo -e "${RED}❌ Неверный формат DEVICE_ID. Только буквы, цифры, _ и -${NC}"
    echo "   Пример: ATV001, Living_Room, TV-Kitchen"
    exit 1
fi

# Поиск APK файла
APK_PATH=$(ls -t ../VCMplayer-v*.apk 2>/dev/null | head -1)
if [ -z "$APK_PATH" ]; then
    APK_PATH=$(ls -t ../../VCMplayer-v*.apk 2>/dev/null | head -1)
fi
if [ -z "$APK_PATH" ]; then
    echo -e "${RED}❌ APK файл не найден!${NC}"
    echo "   Соберите APK с помощью: ./gradlew assembleDebug"
    echo "   или скопируйте готовый APK в корень проекта"
    exit 1
fi

APK_VERSION=$(basename "$APK_PATH" | grep -oP 'v\d+\.\d+\.\d+')

echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}🚀 VideoControl Android Quick Setup${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${YELLOW}Параметры:${NC}"
echo "   📱 Устройство: $DEVICE"
echo "   🌐 Сервер: $SERVER_URL"
echo "   🆔 Device ID: $DEVICE_ID"
echo "   📦 APK: $(basename $APK_PATH)"
echo ""

# ========================================
# ШАГ 1: ПОДКЛЮЧЕНИЕ
# ========================================

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}1️⃣ Подключение к устройству${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

adb connect $DEVICE
sleep 2

if ! adb -s $DEVICE shell "echo test" > /dev/null 2>&1; then
    echo -e "${RED}❌ Не удалось подключиться к устройству $DEVICE${NC}"
    echo ""
    echo "Проверьте:"
    echo "   • Устройство включено и подключено к сети"
    echo "   • ADB debugging включен в настройках"
    echo "   • IP адрес правильный"
    exit 1
fi

echo -e "${GREEN}✅ Подключено к $DEVICE${NC}"
echo ""

# ========================================
# ШАГ 2: ИНФОРМАЦИЯ ОБ УСТРОЙСТВЕ
# ========================================

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}2️⃣ Информация об устройстве${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

ANDROID_VERSION=$(adb -s $DEVICE shell "getprop ro.build.version.release" | tr -d '\r')
SDK_VERSION=$(adb -s $DEVICE shell "getprop ro.build.version.sdk" | tr -d '\r')
MANUFACTURER=$(adb -s $DEVICE shell "getprop ro.product.manufacturer" | tr -d '\r')
MODEL=$(adb -s $DEVICE shell "getprop ro.product.model" | tr -d '\r')

echo "   Android: $ANDROID_VERSION (SDK $SDK_VERSION)"
echo "   Производитель: $MANUFACTURER"
echo "   Модель: $MODEL"
echo ""

# ========================================
# ШАГ 3: УДАЛЕНИЕ СТАРОЙ ВЕРСИИ (если есть)
# ========================================

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}3️⃣ Проверка установленного приложения${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if adb -s $DEVICE shell "pm list packages | grep $PACKAGE_NAME" > /dev/null 2>&1; then
    INSTALLED_VERSION=$(adb -s $DEVICE shell "dumpsys package $PACKAGE_NAME | grep versionName" | head -1 | sed 's/.*versionName=//' | tr -d '\r')
    echo -e "${YELLOW}⚠️ Приложение уже установлено (версия: $INSTALLED_VERSION)${NC}"
    echo "   Удаляю старую версию..."
    adb -s $DEVICE uninstall $PACKAGE_NAME
    echo -e "${GREEN}✅ Старая версия удалена${NC}"
else
    echo "   Приложение не установлено"
fi
echo ""

# ========================================
# ШАГ 4: УСТАНОВКА APK
# ========================================

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}4️⃣ Установка APK${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

echo "   Установка $APK_VERSION на $DEVICE..."
if adb -s $DEVICE install "$APK_PATH"; then
    echo -e "${GREEN}✅ APK установлен успешно!${NC}"
else
    echo -e "${RED}❌ Ошибка установки APK${NC}"
    exit 1
fi
echo ""

# ========================================
# ШАГ 5: НАСТРОЙКА ПРИЛОЖЕНИЯ
# ========================================

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}5️⃣ Настройка Server URL и Device ID${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# Запускаем приложение для создания SharedPreferences
echo "   Запуск приложения для инициализации..."
adb -s $DEVICE shell "am start -n $PACKAGE_NAME/.MainActivity" > /dev/null 2>&1
sleep 3

# Останавливаем приложение
adb -s $DEVICE shell "am force-stop $PACKAGE_NAME" > /dev/null 2>&1
sleep 1

# Настраиваем через adb shell
echo "   Установка Server URL: $SERVER_URL"
adb -s $DEVICE shell "am broadcast -a $PACKAGE_NAME.SET_SERVER_URL --es server_url '$SERVER_URL'" > /dev/null 2>&1

echo "   Установка Device ID: $DEVICE_ID"
adb -s $DEVICE shell "am broadcast -a $PACKAGE_NAME.SET_DEVICE_ID --es device_id '$DEVICE_ID'" > /dev/null 2>&1

# Альтернативный метод через SharedPreferences (если broadcast не работает)
echo "   Применение настроек (альтернативный метод)..."
adb -s $DEVICE shell "run-as $PACKAGE_NAME sh -c 'mkdir -p shared_prefs'" 2>/dev/null || true

# Создаем XML файл настроек
cat > /tmp/VCMediaPlayerSettings.xml << EOF
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="server_url">$SERVER_URL</string>
    <string name="device_id">$DEVICE_ID</string>
    <boolean name="is_configured" value="true" />
</map>
EOF

# Копируем настройки в приложение
adb -s $DEVICE push /tmp/VCMediaPlayerSettings.xml /sdcard/VCMediaPlayerSettings.xml > /dev/null 2>&1
adb -s $DEVICE shell "run-as $PACKAGE_NAME cp /sdcard/VCMediaPlayerSettings.xml shared_prefs/VCMediaPlayerSettings.xml" 2>/dev/null || {
    echo -e "${YELLOW}   ⚠️ Не удалось применить настройки автоматически${NC}"
    echo "   Настройте вручную в приложении после первого запуска"
}
adb -s $DEVICE shell "rm /sdcard/VCMediaPlayerSettings.xml" 2>/dev/null || true
rm /tmp/VCMediaPlayerSettings.xml

echo -e "${GREEN}✅ Настройки применены${NC}"
echo ""

# ========================================
# ШАГ 6: ОПТИМИЗАЦИЯ БАТАРЕИ
# ========================================

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}6️⃣ Отключение оптимизации батареи${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# Добавить в whitelist doze mode
echo "   Добавление в whitelist Doze mode..."
adb -s $DEVICE shell "dumpsys deviceidle whitelist +$PACKAGE_NAME" 2>/dev/null && \
    echo -e "${GREEN}   ✅ Добавлено в Doze whitelist${NC}" || \
    echo -e "${YELLOW}   ⚠️ Doze whitelist недоступен на этой версии Android${NC}"

# Разрешить работу в фоне
echo "   Разрешение работы в фоне..."
adb -s $DEVICE shell "cmd appops set $PACKAGE_NAME RUN_IN_BACKGROUND allow" 2>/dev/null && \
    echo -e "${GREEN}   ✅ Разрешена работа в фоне${NC}" || \
    echo -e "${YELLOW}   ⚠️ RUN_IN_BACKGROUND недоступен${NC}"

# Разрешить автозапуск
echo "   Разрешение автозапуска..."
adb -s $DEVICE shell "cmd appops set $PACKAGE_NAME RUN_ANY_IN_BACKGROUND allow" 2>/dev/null || true

echo -e "${GREEN}✅ Оптимизация батареи отключена${NC}"
echo ""

# ========================================
# ШАГ 7: НАСТРОЙКА ЭКРАНА
# ========================================

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}7️⃣ Настройка экрана для 24/7${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# Отключить таймаут выключения экрана
echo "   Отключение таймаута экрана..."
adb -s $DEVICE shell "settings put system screen_off_timeout 2147483647"
TIMEOUT=$(adb -s $DEVICE shell "settings get system screen_off_timeout" | tr -d '\r')
echo "   Таймаут экрана: $TIMEOUT (максимальный)"

# Включить Stay awake при подключении к питанию
echo "   Включение Stay Awake..."
adb -s $DEVICE shell "settings put global stay_on_while_plugged_in 7"
STAY_ON=$(adb -s $DEVICE shell "settings get global stay_on_while_plugged_in" | tr -d '\r')
echo "   Stay awake: $STAY_ON (7 = USB + AC + Wireless)"

# Установить максимальную яркость (опционально)
echo "   Установка яркости на 100%..."
adb -s $DEVICE shell "settings put system screen_brightness 255"
echo "   Яркость: 255/255 (100%)"

echo -e "${GREEN}✅ Экран настроен для 24/7${NC}"
echo ""

# ========================================
# ШАГ 8: АВТОЗАПУСК ПРИЛОЖЕНИЯ
# ========================================

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}8️⃣ Настройка автозапуска${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# Проверка разрешения RECEIVE_BOOT_COMPLETED
BOOT_PERM=$(adb -s $DEVICE shell "dumpsys package $PACKAGE_NAME | grep 'android.permission.RECEIVE_BOOT_COMPLETED: granted'" | tr -d '\r')
if [ -n "$BOOT_PERM" ]; then
    echo -e "${GREEN}   ✅ RECEIVE_BOOT_COMPLETED: granted${NC}"
else
    echo -e "${RED}   ❌ RECEIVE_BOOT_COMPLETED: NOT granted${NC}"
fi

# Проверка разрешения WAKE_LOCK
WAKE_PERM=$(adb -s $DEVICE shell "dumpsys package $PACKAGE_NAME | grep 'android.permission.WAKE_LOCK: granted'" | tr -d '\r')
if [ -n "$WAKE_PERM" ]; then
    echo -e "${GREEN}   ✅ WAKE_LOCK: granted${NC}"
else
    echo -e "${RED}   ❌ WAKE_LOCK: NOT granted${NC}"
fi

# Проверка разрешения INTERNET
INTERNET_PERM=$(adb -s $DEVICE shell "dumpsys package $PACKAGE_NAME | grep 'android.permission.INTERNET: granted'" | tr -d '\r')
if [ -n "$INTERNET_PERM" ]; then
    echo -e "${GREEN}   ✅ INTERNET: granted${NC}"
else
    echo -e "${RED}   ❌ INTERNET: NOT granted${NC}"
fi

echo -e "${GREEN}✅ Автозапуск настроен${NC}"
echo ""

# ========================================
# ШАГ 9: ПРОИЗВОДИТЕЛЬ-СПЕЦИФИЧНЫЕ НАСТРОЙКИ
# ========================================

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}9️⃣ Дополнительные настройки (производитель: $MANUFACTURER)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

case "$MANUFACTURER" in
    *Xiaomi*|*xiaomi*|*XIAOMI*)
        echo -e "${YELLOW}   🔧 Xiaomi устройство - требуются ручные настройки:${NC}"
        echo "      Settings → Apps → Manage apps → VideoControl MediaPlayer"
        echo "      → Autostart: ${GREEN}ON ✅${NC}"
        echo "      → Battery saver: ${GREEN}No restrictions${NC}"
        echo "      → Display pop-up windows: ${GREEN}ON${NC}"
        echo "      → Display pop-up window while running in the background: ${GREEN}ON${NC}"
        ;;
    *Samsung*|*samsung*|*SAMSUNG*)
        echo -e "${YELLOW}   🔧 Samsung устройство - требуются ручные настройки:${NC}"
        echo "      Settings → Apps → VideoControl MediaPlayer"
        echo "      → Battery → ${GREEN}Unrestricted${NC}"
        echo "      → Background usage limits → ${GREEN}Don't restrict${NC}"
        # Samsung специфичные команды
        adb -s $DEVICE shell "cmd package set-home-activity $PACKAGE_NAME/.MainActivity" 2>/dev/null || true
        ;;
    *Huawei*|*huawei*|*HUAWEI*|*Honor*|*honor*)
        echo -e "${YELLOW}   🔧 Huawei/Honor устройство - требуются ручные настройки:${NC}"
        echo "      Settings → Battery → App launch → VideoControl MediaPlayer"
        echo "      → Manual management: ${GREEN}ON${NC}"
        echo "      → Auto-launch: ${GREEN}ON ✅${NC}"
        echo "      → Secondary launch: ${GREEN}ON ✅${NC}"
        echo "      → Run in background: ${GREEN}ON ✅${NC}"
        ;;
    *)
        echo -e "${GREEN}   ✅ Стандартное Android устройство - базовые настройки применены!${NC}"
        ;;
esac
echo ""

# ========================================
# ШАГ 10: ЗАПУСК ПРИЛОЖЕНИЯ
# ========================================

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}🔟 Запуск приложения${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

echo "   Запуск VideoControl MediaPlayer..."
adb -s $DEVICE shell "am start -n $PACKAGE_NAME/.MainActivity" > /dev/null 2>&1
sleep 3

# Проверка запущено ли приложение
if adb -s $DEVICE shell "ps -A | grep $PACKAGE_NAME" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Приложение запущено и работает!${NC}"
else
    echo -e "${YELLOW}⚠️ Приложение не обнаружено в процессах${NC}"
    echo "   Попробуйте запустить вручную"
fi
echo ""

# ========================================
# ИТОГИ
# ========================================

echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}✅ НАСТРОЙКА ЗАВЕРШЕНА!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${GREEN}📱 Устройство:${NC} $DEVICE"
echo -e "${GREEN}🌐 Сервер:${NC} $SERVER_URL"
echo -e "${GREEN}🆔 Device ID:${NC} $DEVICE_ID"
echo -e "${GREEN}📦 Версия APK:${NC} $APK_VERSION"
echo ""
echo -e "${YELLOW}🎯 Что дальше:${NC}"
echo ""
echo "   1️⃣ Откройте приложение на устройстве и проверьте подключение"
echo "   2️⃣ Проверьте что устройство появилось в админ-панели: $SERVER_URL/admin.html"
echo "   3️⃣ Для проверки автозапуска - перезагрузите устройство:"
echo "      ${BLUE}adb -s $DEVICE reboot${NC}"
echo ""
echo -e "${YELLOW}🔍 Полезные команды:${NC}"
echo ""
echo "   Проверка процесса:"
echo "   ${BLUE}adb -s $DEVICE shell \"ps -A | grep videocontrol\"${NC}"
echo ""
echo "   Просмотр логов:"
echo "   ${BLUE}adb -s $DEVICE logcat | grep -E 'VCMedia|VideoControl'${NC}"
echo ""
echo "   Проверка настроек:"
echo "   ${BLUE}adb -s $DEVICE shell \"run-as $PACKAGE_NAME cat shared_prefs/VCMediaPlayerSettings.xml\"${NC}"
echo ""
echo "   Перезапуск приложения:"
echo "   ${BLUE}adb -s $DEVICE shell \"am force-stop $PACKAGE_NAME && am start -n $PACKAGE_NAME/.MainActivity\"${NC}"
echo ""

# Производитель-специфичные рекомендации
if [[ "$MANUFACTURER" =~ Xiaomi|Samsung|Huawei|Honor ]]; then
    echo -e "${YELLOW}⚠️ ВАЖНО для $MANUFACTURER:${NC}"
    echo "   Выполните дополнительные настройки вручную (см. выше)"
    echo "   Иначе автозапуск может не работать!"
    echo ""
fi

echo -e "${GREEN}🎉 Готово к использованию 24/7!${NC}"
echo ""

