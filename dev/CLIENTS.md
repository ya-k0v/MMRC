# 📱 Клиенты MMRC

Руководство по установке и настройке клиентских приложений для MMRC.

---

## 🤖 Android MediaPlayer

Нативное Android приложение для стабильного воспроизведения медиа-контента 24/7.

### Возможности

- ✅ **ExoPlayer** - стабильная работа с файлами любого размера
- ✅ **Glide** - загрузка изображений с кэшем
- ✅ **PDF/PPTX** - через конвертированные изображения
- ✅ **Автозапуск** - при включении устройства
- ✅ **Watchdog** - автоперезапуск при потере связи > 3 минут
- ✅ **Wake Lock** - экран не гаснет
- ✅ **Retry** - автовосстановление при ошибках (3 попытки)
- ✅ **24/7** - стабильная работа без перезапусков

### Требования

- **Android:** 5.0+ (API 21+)
- **Gradle:** 8.1+, JDK 17
- **Сеть:** Wi-Fi подключение к серверу

---

## ⚡ Быстрая установка Android (рекомендуется)

**Автоматическая установка и настройка одной командой:**

```bash
cd /vid/videocontrol
./dev/scripts/quick-setup-android.sh <device_ip:port> <server_url> <device_id>

# Пример:
./dev/scripts/quick-setup-android.sh 192.168.11.57:5555 http://192.168.11.1 ATV001
```

**✨ Скрипт автоматически:**
- Установит APK
- Настроит Server URL и Device ID
- Отключит оптимизацию батареи
- Настроит автозапуск
- Отключит таймаут экрана
- Запустит приложение

### Требования перед запуском скрипта:

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
   - APK должен быть в корне проекта: `MMRCplayer-v*.apk`

---

## 🔨 Сборка Android APK

### Вариант 1: Android Studio (рекомендуется)

1. **Установите Android Studio:**
   ```bash
   sudo snap install android-studio --classic
   ```

2. **Откройте проект:**
   - Запустите Android Studio
   - File → Open → выберите `/vid/videocontrol/clients/android-mediaplayer`
   - Дождитесь синхронизации Gradle

3. **Настройте:**
   - Откройте `MainActivity.kt`
   - Измените `SERVER_URL` и `DEVICE_ID` (опционально, можно настроить через UI)

4. **Соберите APK:**
   - Build → Build Bundle(s) / APK(s) → Build APK(s)
   - APK будет в `app/build/outputs/apk/debug/`

5. **Установите:**
   ```bash
   adb install app/build/outputs/apk/debug/app-debug.apk
   ```

### Вариант 2: Командная строка

```bash
cd clients/android-mediaplayer
./gradlew assembleDebug

# APK в app/build/outputs/apk/debug/app-debug.apk
```

---

## 📲 Ручная установка Android

### 1. Установка APK

```bash
# Подключение к устройству
adb connect <device_ip>:5555

# Установка
adb install -r MMRCplayer-v3.1.1.apk
```

### 2. Настройка устройства для 24/7

```bash
./dev/scripts/quick-setup-android.sh <device_ip>:5555
```

Скрипт автоматически:
- Отключит таймаут экрана
- Добавит в whitelist оптимизации батареи
- Включит Stay Awake при питании
- Проверит все разрешения

### 3. Настройка приложения

1. Откройте приложение на устройстве
2. Введите **Server URL** и **Device ID**
3. Сохраните

### 4. Автозапуск на Xiaomi/Huawei (вручную)

**Для Xiaomi Mi TV:**
```
Settings → Apps → MMRC Player
→ Autostart: ON ✅
→ Battery: No restrictions
```

**Для Huawei:**
```
Settings → Battery → App launch → MMRC
→ Manual: ON → Auto-launch: ON ✅
```

**Для остальных (Sony/TCL/Philips/Generic):**
- Настройки применяются автоматически через скрипт

### 5. Перезагрузка

```bash
adb reboot
# Приложение запустится автоматически через 1-2 секунды
```

---

## 🔄 Управление Android устройством

### Подключение и проверка

```bash
# Подключение
adb connect 192.168.1.50:5555
adb devices -l

# Проверка что приложение работает
adb shell "ps -A | grep videocontrol"

# Проверка логов
adb logcat -d | grep -E "BootReceiver|MMRCPlayer"
```

### Установка и перезапуск

```bash
# Установка/обновление
adb -s SERIAL install -r MMRCplayer-v3.1.1.apk

# Остановка приложения
adb -s SERIAL shell am force-stop com.videocontrol.mediaplayer

# Запуск приложения
adb -s SERIAL shell monkey -p com.videocontrol.mediaplayer -c android.intent.category.LAUNCHER 1

# Полный сброс
adb -s SERIAL shell pm clear com.videocontrol.mediaplayer
```

### Диагностика

```bash
# Логи приложения
adb logcat -d | grep -iE "MMRCPlayer|MMRC|ExoPlayer|MediaCodec" | tail -n 200

# Проверка сети
adb -s SERIAL shell ping -c 3 192.168.1.1
adb -s SERIAL shell netstat -an | grep -E "3000|80|443"

# Проверка памяти
adb -s SERIAL shell df -h /sdcard /data
```

---

## 🖥️ MPV Client (Linux)

Нативный медиаплеер для Linux/Unix устройств с производительностью и стабильностью как у ExoPlayer на Android.

### Преимущества MPV vs Video.js (браузер):

| Характеристика | MPV (нативный) | Video.js (браузер) |
|---|---|---|
| **Память** | ~50-70 MB | ~300-500 MB |
| **CPU нагрузка** | ~10-15% | ~40-60% |
| **Аппаратное ускорение** | ✅ Полное (VAAPI/VDPAU/NVDEC) | ⚠️ Частичное |
| **Файлы >4GB** | ✅ Без проблем | ❌ Проблемы/крэши |
| **Стабильность 24/7** | ✅ Отлично | ❌ Плохо (memory leaks) |
| **Буфер** | ✅ До 200MB настраиваемый | ⚠️ ~50-150MB ограничен |
| **Codec support** | ✅ Все (hw decode) | ⚠️ Ограничен браузером |
| **Запуск** | ~2-5 сек | ~10-20 сек |

### Возможности

- ✅ Сохранение позиции видео при pause/resume
- ✅ Кэширование заглушки (не запрашивает сервер каждый раз)
- ✅ Предзагрузка соседних слайдов (мгновенное переключение)
- ✅ Умный reconnect (не сбрасывает контент при потере связи)
- ✅ ConnectionWatchdog (автоперезапуск при длительной потере связи)
- ✅ Error retry механизм
- ✅ Полное отслеживание состояния всех типов контента

---

## 📦 Установка MPV Client

### Вариант 1: Одна команда (рекомендуется)

```bash
# Установка через curl
curl -fsSL https://raw.githubusercontent.com/ya-k0v/MMRC/main/clients/mpv/quick-install.sh | bash -s -- --server http://YOUR_SERVER --device mpv-001

# Или через wget
wget -qO- https://raw.githubusercontent.com/ya-k0v/MMRC/main/clients/mpv/quick-install.sh | bash -s -- --server http://YOUR_SERVER --device mpv-001
```

Скрипт автоматически:
- ✅ Скачает клиент с GitHub (~40 KB)
- ✅ Установит MPV и зависимости
- ✅ Установит драйверы аппаратного ускорения (VAAPI/VDPAU)
- ✅ Создаст systemd service
- ✅ Настроит автозапуск

**Установка в:** `~/videocontrol-mpv`

### Вариант 2: Из локального репозитория

```bash
cd clients/mpv
./install.sh --server http://YOUR_SERVER --device mpv-001
```

**Установка в:** `/opt/videocontrol-mpv`

### Ручная установка

```bash
# 1. Установка MPV
sudo apt install mpv python3 python3-pip

# 2. Драйверы для аппаратного ускорения
# Intel/AMD:
sudo apt install vainfo libva-drm2 mesa-va-drivers

# NVIDIA:
sudo apt install vdpauinfo libvdpau-va-gl1

# 3. Python зависимости
cd clients/mpv
pip3 install -r requirements.txt

# 4. Запуск
python3 mpv_client.py --server http://YOUR_SERVER --device mpv-001
```

---

## 🎬 Поддерживаемые типы контента (MPV)

- ✅ **Видео** - все форматы (mp4, webm, mkv, avi, mov, ogg, flv, m4v)
- ✅ **Изображения** - png, jpg, jpeg, gif, webp
- ✅ **PDF презентации** - постраничная навигация
- ✅ **PPTX презентации** - слайд-шоу
- ✅ **Папки с изображениями** - навигация как в презентациях
- ✅ **Заглушка** - бесконечный loop default.mp4

---

## 🔧 Параметры запуска MPV

```bash
python3 mpv_client.py [OPTIONS]

Обязательные параметры:
  --server URL      Server URL (http://192.168.1.100)
  --device ID       Device ID (mpv-001)

Опциональные параметры:
  --display :0      X Display (default: :0)
  --no-fullscreen   Оконный режим (для тестирования)
```

### Примеры:

```bash
# Стандартный запуск
python3 mpv_client.py --server http://192.168.1.100 --device mpv-001

# С указанием display
python3 mpv_client.py --server http://192.168.1.100 --device mpv-002 --display :1

# Оконный режим для отладки
python3 mpv_client.py --server http://192.168.1.100 --device mpv-test --no-fullscreen
```

---

## 🔄 Управление MPV через systemd

После установки через `install.sh`:

```bash
# Статус
sudo systemctl status videocontrol-mpv@mpv-001

# Логи в реальном времени
sudo journalctl -u videocontrol-mpv@mpv-001 -f

# Перезапуск
sudo systemctl restart videocontrol-mpv@mpv-001

# Остановка
sudo systemctl stop videocontrol-mpv@mpv-001

# Запуск
sudo systemctl start videocontrol-mpv@mpv-001
```

---

## 🌐 Браузерный клиент

Веб-плеер через Video.js доступен по адресу:

```
http://YOUR_SERVER_IP/player-videojs.html?device_id=YOUR_DEVICE_ID
```

**Особенности:**
- Работает в любом современном браузере
- Поддержка всех типов контента
- Управление через админ-панель или спикер-панель

---

## 🐛 Решение проблем

### Android: Приложение не запускается автоматически

1. **Проверьте настройки:**
   ```bash
   adb logcat | grep BootReceiver
   ```
   Если видите `⚠️ Configuration not found`, настройте приложение.

2. **Проверьте разрешения:**
   ```bash
   adb shell dumpsys package com.videocontrol.mediaplayer | grep permission
   ```
   Должно быть: `android.permission.RECEIVE_BOOT_COMPLETED: granted=true`

3. **Отключите оптимизацию батареи:**
   ```bash
   adb shell dumpsys deviceidle whitelist +com.videocontrol.mediaplayer
   ```

### MPV: Нет аппаратного ускорения

```bash
# Проверка VAAPI (Intel/AMD)
vainfo

# Проверка VDPAU (NVIDIA)
vdpauinfo

# Если не работает, установите драйверы
sudo apt install vainfo libva-drm2 mesa-va-drivers  # Intel/AMD
sudo apt install vdpauinfo libvdpau-va-gl1            # NVIDIA
```

### Общие проблемы подключения

1. **Проверьте доступность сервера:**
   ```bash
   ping YOUR_SERVER_IP
   curl http://YOUR_SERVER_IP/health
   ```

2. **Проверьте настройки устройства:**
   - Server URL должен быть правильным
   - Device ID должен совпадать с ID в админ-панели

3. **Проверьте логи:**
   ```bash
   # Android
   adb logcat | grep MMRC
   
   # MPV
   sudo journalctl -u videocontrol-mpv@DEVICE_ID -f
   ```

---

## 📚 Дополнительная документация

- [`dev/INSTALL.md`](INSTALL.md) — установка сервера
- [`dev/COMMANDS.md`](COMMANDS.md) — команды для управления
- [`dev/ADMIN_PANEL_README.md`](ADMIN_PANEL_README.md) — админ-панель
- [`dev/SPEAKER_PANEL_README.md`](SPEAKER_PANEL_README.md) — спикер-панель

---

**Версия:** 3.1.1

