# 📱 Клиенты MMRC 3.2.1

Руководство по установке и настройке клиентских приложений для MMRC.

---

## 🤖 Android MediaPlayer

Нативное Android приложение для стабильного воспроизведения медиа-контента 24/7.

### Возможности

- ✅ **ExoPlayer** - стабильная работа с файлами любого размера
- ✅ **Glide** - загрузка изображений с кэшем
- ✅ **PDF/PPTX** - через конвертированные изображения
- ✅ **Автозапуск** - при включении устройства (BootReceiver)
- ✅ **Watchdog** - автоперезапуск при потере связи > 3 минут
- ✅ **Wake Lock** - экран не гаснет
- ✅ **Retry** - автовосстановление при ошибках (3 попытки)
- ✅ **24/7** - стабильная работа без перезапусков
- ✅ **Оверлей** - отображение ID устройства и версии (`ID: ATV001 | v3.2.1`)
- ✅ **Настройки через shared_prefs** - Server URL и Device ID

### Требования

- **Android:** 5.0+ (API 21+)
- **Gradle:** 8.1+, JDK 17
- **Сеть:** Wi-Fi подключение к серверу

---

## ⚡ Быстрая установка Android (рекомендуется)

**Автоматическая установка и настройка одной командой:**

```bash
cd /var/lib/mmrc
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

---

## 🔨 Сборка Android APK

### Вариант 1: Android Studio (рекомендуется)

1. **Установите Android Studio:**
   ```bash
   sudo snap install android-studio --classic
   ```

2. **Откройте проект:**
   - Запустите Android Studio
   - File → Open → выберите `/var/lib/mmrc/clients/android-mediaplayer`
   - Дождитесь синхронизации Gradle

3. **Соберите APK:**
   - Build → Build Bundle(s) / APK(s) → Build APK(s)
   - APK будет в `app/build/outputs/apk/debug/`

### Вариант 2: Командная строка

```bash
cd clients/android-mediaplayer
./gradlew assembleDebug
```

**Важно:** В `app/build.gradle` должно быть `buildFeatures { buildConfig true }` для корректной генерации BuildConfig.

---

## 📲 Ручная установка Android

### 1. Установка APK

```bash
adb connect <device_ip>:5555
adb install -r clients/android-mediaplayer/app/build/outputs/apk/debug/app-debug.apk
```

### 2. Настройка приложения

1. Откройте приложение на устройстве
2. Введите **Server URL** и **Device ID**
3. Сохраните

### 3. Автозапуск на Xiaomi/Huawei (вручную)

**Для Xiaomi Mi TV:**
```
Settings → Apps → MMRC Player → Autostart: ON → Battery: No restrictions
```

**Для Huawei:**
```
Settings → Battery → App launch → MMRC → Manual: ON → Auto-launch: ON
```

### 4. Перезагрузка

```bash
adb reboot
# Приложение запустится автоматически через 1-2 секунды
```

---

## 🔄 Управление Android устройством

### Подключение и проверка

```bash
adb connect 192.168.1.50:5555
adb devices -l
adb shell "ps -A | grep videocontrol"
adb logcat -d | grep -E "BootReceiver|MMRCPlayer"
```

### Установка и перезапуск

```bash
adb -s SERIAL install -r app-debug.apk
adb -s SERIAL shell am force-stop com.videocontrol.mediaplayer
adb -s SERIAL shell monkey -p com.videocontrol.mediaplayer -c android.intent.category.LAUNCHER 1
adb -s SERIAL shell pm clear com.videocontrol.mediaplayer
```

---

## 🖥️ MPV Client (Linux)

Нативный медиаплеер для Linux/Unix устройств.

### Преимущества MPV vs Video.js

| Характеристика | MPV (нативный) | Video.js (браузер) |
|---|---|---|
| **Память** | ~50-70 MB | ~300-500 MB |
| **CPU нагрузка** | ~10-15% | ~40-60% |
| **Аппаратное ускорение** | ✅ Полное (VAAPI/VDPAU/NVDEC) | ⚠️ Частичное |
| **Файлы >4GB** | ✅ Без проблем | ❌ Проблемы/крэши |
| **Стабильность 24/7** | ✅ Отлично | ❌ Плохо (memory leaks) |

### Возможности

- ✅ Сохранение позиции видео при pause/resume
- ✅ Кэширование заглушки
- ✅ Предзагрузка соседних слайдов
- ✅ Умный reconnect
- ✅ ConnectionWatchdog
- ✅ Error retry механизм

---

## 📦 Установка MPV Client

### Вариант 1: Одна команда

```bash
curl -fsSL https://raw.githubusercontent.com/ya-k0v/MMRC/main/clients/mpv/quick-install.sh | bash -s -- --server http://YOUR_SERVER --device mpv-001
```

### Вариант 2: Из локального репозитория

```bash
cd clients/mpv
./install.sh --server http://YOUR_SERVER --device mpv-001
```

### Ручная установка

```bash
sudo apt install mpv python3 python3-pip
cd clients/mpv
pip3 install -r requirements.txt
python3 mpv_client.py --server http://YOUR_SERVER --device mpv-001
```

### Управление через systemd

```bash
sudo systemctl status videocontrol-mpv@mpv-001
sudo journalctl -u videocontrol-mpv@mpv-001 -f
sudo systemctl restart videocontrol-mpv@mpv-001
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
- Трейлеры и превью
- PWA поддержка (manifest.json, sw.js)

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
vainfo          # Intel/AMD
vdpauinfo       # NVIDIA
```

---

## 📚 Дополнительная документация

- [`dev/INSTALL.md`](INSTALL.md) — установка сервера
- [`dev/COMMANDS.md`](COMMANDS.md) — команды для управления
- [`dev/ADMIN_PANEL_README.md`](ADMIN_PANEL_README.md) — админ-панель
- [`dev/SPEAKER_PANEL_README.md`](SPEAKER_PANEL_README.md) — спикер-панель

---

**Версия:** 3.2.1
