# 🚀 Быстрая настройка Android устройства

> Автоматическая установка и настройка Android TV/планшета за 2 минуты!

---

## ⚡ Установка одной командой

```bash
cd /vid/videocontrol
./scripts/quick-setup-android.sh <device_ip:port> <server_url> <device_id>
```

### Примеры:

```bash
# Локальная сеть
./scripts/quick-setup-android.sh 192.168.11.57:5555 http://192.168.11.1 ATV001

# С портом Node.js (если без Nginx)
./scripts/quick-setup-android.sh 10.0.0.100:5555 http://10.0.0.1:3000 Living_Room

# Несколько устройств
./scripts/quick-setup-android.sh 192.168.11.57:5555 http://192.168.11.1 ATV_Kitchen
./scripts/quick-setup-android.sh 192.168.11.58:5555 http://192.168.11.1 ATV_LivingRoom
./scripts/quick-setup-android.sh 192.168.11.59:5555 http://192.168.11.1 ATV_Bedroom
```

---

## 🎯 Что делает скрипт?

### 1️⃣ Подключение к устройству
- Подключается через ADB
- Проверяет доступность

### 2️⃣ Информация об устройстве
- Определяет производителя (Xiaomi, Samsung, Huawei и др.)
- Показывает версию Android и SDK

### 3️⃣ Удаление старой версии
- Проверяет установленную версию
- Удаляет старую версию (если есть)

### 4️⃣ Установка APK
- Находит последнюю версию APK (`VCMplayer-v*.apk`)
- Устанавливает на устройство

### 5️⃣ Настройка приложения
- ✅ Устанавливает Server URL
- ✅ Устанавливает Device ID
- ✅ Сохраняет в SharedPreferences

### 6️⃣ Оптимизация батареи
- ✅ Добавляет в Doze whitelist
- ✅ Разрешает работу в фоне
- ✅ Отключает ограничения батареи

### 7️⃣ Настройка экрана для 24/7
- ✅ Отключает таймаут выключения экрана
- ✅ Включает Stay Awake (при подключении к питанию)
- ✅ Устанавливает яркость 100%

### 8️⃣ Автозапуск при загрузке
- ✅ Проверяет разрешения (BOOT_COMPLETED, WAKE_LOCK)
- ✅ Настраивает автозапуск

### 9️⃣ Производитель-специфичные настройки
- Показывает дополнительные инструкции для:
  - Xiaomi (MIUI)
  - Samsung (One UI)
  - Huawei/Honor (EMUI)

### 🔟 Запуск приложения
- ✅ Запускает приложение
- ✅ Проверяет что оно работает

---

## 📋 Требования

### Перед запуском скрипта:

1. **ADB установлен**
   ```bash
   sudo apt-get install adb
   ```

2. **Устройство подключено к сети**
   - Устройство в той же сети что и компьютер
   - Известен IP адрес устройства

3. **ADB debugging включен на устройстве**
   ```
   Settings → About → Build number (тапнуть 7 раз)
   Settings → Developer options → USB debugging: ON
   Settings → Developer options → Network debugging: ON (для Wi-Fi ADB)
   ```

4. **APK собран или скачан**
   ```bash
   # Сборка APK (если еще не собран)
   cd clients/android-mediaplayer
   ./gradlew assembleDebug
   
   # APK будет в: app/build/outputs/apk/debug/app-debug.apk
   # Скопируйте его в корень проекта как VCMplayer-v2.7.0.apk
   ```

---

## 🛠️ Параметры

### 1. **device_ip:port**
- IP адрес Android устройства + порт ADB (обычно 5555)
- Найти IP: Settings → About → Status → IP address
- Пример: `192.168.11.57:5555`

### 2. **server_url**
- URL сервера VideoControl
- Формат: `http://IP_АДРЕС` или `http://IP_АДРЕС:PORT`
- С Nginx: `http://192.168.11.1`
- Без Nginx: `http://192.168.11.1:3000`

### 3. **device_id**
- Уникальный ID устройства (только буквы, цифры, `_`, `-`)
- Примеры: `ATV001`, `Living_Room`, `TV-Kitchen`
- Этот ID будет отображаться в админ-панели

---

## 🔍 Проверка после установки

### 1. Проверка процесса
```bash
adb -s 192.168.11.57:5555 shell "ps -A | grep videocontrol"
```

### 2. Просмотр логов
```bash
adb -s 192.168.11.57:5555 logcat | grep -E 'VCMedia|VideoControl'
```

### 3. Проверка настроек
```bash
adb -s 192.168.11.57:5555 shell "run-as com.videocontrol.mediaplayer cat shared_prefs/VCMediaPlayerSettings.xml"
```

### 4. Перезапуск приложения
```bash
adb -s 192.168.11.57:5555 shell "am force-stop com.videocontrol.mediaplayer"
adb -s 192.168.11.57:5555 shell "am start -n com.videocontrol.mediaplayer/.MainActivity"
```

---

## 🔄 Тест автозапуска

После настройки **обязательно** проверьте автозапуск:

```bash
# Перезагрузка устройства
adb -s 192.168.11.57:5555 reboot

# Подождите 30-60 секунд

# Переподключитесь
adb connect 192.168.11.57:5555

# Проверьте что приложение запустилось
adb -s 192.168.11.57:5555 shell "ps -A | grep videocontrol"
```

Если приложение **НЕ запустилось** автоматически:
- Проверьте производитель-специфичные настройки (Xiaomi, Samsung, Huawei)
- Откройте приложение вручную один раз
- Повторите перезагрузку

---

## 🚨 Troubleshooting

### Приложение не подключается к серверу

1. **Проверьте Server URL:**
   ```bash
   adb -s 192.168.11.57:5555 shell "run-as com.videocontrol.mediaplayer cat shared_prefs/VCMediaPlayerSettings.xml | grep server_url"
   ```

2. **Проверьте доступность сервера с устройства:**
   ```bash
   adb -s 192.168.11.57:5555 shell "ping -c 3 192.168.11.1"
   ```

3. **Проверьте логи приложения:**
   ```bash
   adb -s 192.168.11.57:5555 logcat -d | grep -E 'VCMedia|Socket.IO|error'
   ```

### Автозапуск не работает

1. **Xiaomi (MIUI):**
   - Settings → Apps → Manage apps → VideoControl → Autostart: ON
   - Security → Permissions → Autostart: разрешить

2. **Samsung:**
   - Settings → Apps → VideoControl → Battery → Unrestricted

3. **Huawei/Honor:**
   - Settings → Battery → App launch → VideoControl → Manual: ON
   - Включить все опции (Auto-launch, Secondary launch, Run in background)

4. **Общее решение:**
   - Запустите приложение вручную один раз после установки
   - Заблокируйте в списке недавних приложений (не смахивайте)

---

## 📝 Массовая настройка устройств

Для настройки нескольких устройств создайте конфигурационный файл:

```bash
# devices.conf
192.168.11.57:5555,http://192.168.11.1,ATV_Kitchen
192.168.11.58:5555,http://192.168.11.1,ATV_LivingRoom
192.168.11.59:5555,http://192.168.11.1,ATV_Bedroom
```

Скрипт массовой установки:

```bash
#!/bin/bash
while IFS=',' read -r device server id; do
    echo "🔧 Настройка $id..."
    ./scripts/quick-setup-android.sh "$device" "$server" "$id"
    echo "✅ $id готов!"
    echo ""
done < devices.conf
```

---

## 🎬 Demo

```bash
$ ./scripts/quick-setup-android.sh 192.168.11.57:5555 http://192.168.11.1 ATV001

========================================
🚀 VideoControl Android Quick Setup
========================================

Параметры:
   📱 Устройство: 192.168.11.57:5555
   🌐 Сервер: http://192.168.11.1
   🆔 Device ID: ATV001
   📦 APK: VCMplayer-v2.7.0.apk

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1️⃣ Подключение к устройству
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Подключено к 192.168.11.57:5555

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2️⃣ Информация об устройстве
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Android: 9 (SDK 28)
   Производитель: Rockchip
   Модель: rockchip

... (установка и настройка) ...

========================================
✅ НАСТРОЙКА ЗАВЕРШЕНА!
========================================

🎉 Готово к использованию 24/7!
```

---

## 📚 См. также:

- [BUILD.md](BUILD.md) - Сборка APK из исходников
- [AUTOSTART.md](AUTOSTART.md) - Детальная настройка автозапуска
- [README.md](README.md) - Документация Android приложения
- [../../docs/ANDROID.md](../../docs/ANDROID.md) - Общая информация

---

**© 2025 VideoControl** | Быстрая настройка Android устройств для 24/7

