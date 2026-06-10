# 📋 Шпаргалка по командам MMRC 3.2.1

Быстрая справка по командам для управления и обслуживания MMRC.

---

## 🖥️ Сервер (systemd/Node.js)

### Сервис и логи
```bash
# Статус и логи
sudo systemctl status videocontrol
sudo journalctl -u videocontrol -n 200 --no-pager
sudo journalctl -u videocontrol -f

# Управление
sudo systemctl restart videocontrol
sudo systemctl stop videocontrol
sudo systemctl start videocontrol
sudo systemctl daemon-reload   # после изменения unit

# Логи приложения
tail -f data/logs/combined-*.log
tail -f data/logs/error-*.log
```

### Обновление и диагностика
```bash
# Обновление через git
sudo systemctl stop videocontrol
git pull --rebase
npm ci || npm install
npm run setup-hooks --silent || true
npm run migrate-db --silent
sudo systemctl start videocontrol
sudo journalctl -u videocontrol -n 100 --no-pager

# Обновление через self-update (из админ-панели)
# Кнопка обновления в настройках админ-панели

# Диагностика FFmpeg и статусов файлов
ffmpeg -version
sqlite3 config/main.db "SELECT * FROM file_statuses WHERE status='error' ORDER BY updated_at DESC LIMIT 20;"

# Проверка видео-эндпоинтов
curl -I "http://HOST/api/files/trailer/DEVICE/FILE.mp4"
curl -I -H "Range: bytes=0-524287" "http://HOST/api/files/preview/DEVICE/FILE.mp4"
curl -I "http://HOST/api/files/resolve/DEVICE/FILE.mp4"

# Socket.IO sanity-check
curl -s "http://HOST/socket.io/?EIO=4&transport=polling" | head -n 1

# Health Check
curl http://HOST/health

# Metrics (требует авторизации admin)
curl -H "Authorization: Bearer TOKEN" http://HOST/api/metrics
```

---

## 🎬 Ночная оптимизация

```bash
# Проверить статус оптимизации
sqlite3 config/main.db "SELECT * FROM night_opt_jobs WHERE status IN ('pending','running') ORDER BY created_at DESC LIMIT 20;"

# Отменить задачу оптимизации
sqlite3 config/main.db "UPDATE night_opt_jobs SET status='cancelled' WHERE id=JOB_ID;"

# Проверить ресурсы
sqlite3 config/main.db "SELECT * FROM job_resources WHERE status='active';"
```

---

## 🌐 Стримы

```bash
# Просмотр активных стримов
sqlite3 config/main.db "SELECT * FROM streams WHERE status='running';"

# Логи stream-manager
journalctl -u videocontrol -n 200 --no-pager | grep "stream"

# Очистить зависшие стримы
sqlite3 config/main.db "UPDATE streams SET status='stopped' WHERE status='running' AND updated_at < datetime('now', '-1 hour');"
```

---

## 🌐 Nginx

```bash
sudo nginx -t
sudo systemctl restart nginx
sudo journalctl -u nginx -n 100 --no-pager

# Логи виртуального хоста
sudo tail -n 200 /var/log/nginx/videocontrol-access.log
sudo tail -n 200 /var/log/nginx/videocontrol-error.log
```

---

## 💾 SQL / SQLite

### Консоль и настройки
```bash
# Запуск
sqlite3 config/main.db

# Полезные pragma
PRAGMA journal_mode;       -- ожидается WAL
PRAGMA integrity_check;
.tables
.schema users

# Экспорт / обслуживание
.output backup.sql
.dump
.output stdout
VACUUM;
ANALYZE;
```

### Частые запросы
```sql
-- Последние действия (аудит)
SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 50;

-- Все устройства
SELECT device_id, name, folder, last_seen
FROM devices
ORDER BY updated_at DESC;

-- Файлы конкретного устройства
SELECT safe_name, file_size, created_at, md5
FROM files_metadata
WHERE device_id = 'DEVICE001'
ORDER BY created_at DESC
LIMIT 50;

-- Дедупликация: файлы с одинаковым MD5
SELECT md5, COUNT(*) as cnt, GROUP_CONCAT(device_id) as devices
FROM files_metadata
WHERE md5 IS NOT NULL
GROUP BY md5
HAVING cnt > 1;

-- Стримы
SELECT * FROM streams ORDER BY created_at DESC LIMIT 20;

-- Миграции
SELECT * FROM schema_migrations ORDER BY applied_at DESC;
```

### Сброс пароля admin
```sql
UPDATE users
SET password_hash='$2b$10$jgHKNtHUKUhkftKlFD60QI/W',
    updated_at=CURRENT_TIMESTAMP
WHERE username='admin';
```

Генерация нового bcrypt-хэша:
```bash
node -e "import('bcrypt').then(b=>b.hash('NEW_STRONG_PASSWORD',10).then(console.log))"
```

---

## 📁 Хранилище данных

По умолчанию: `data/*` (локально) или `/mnt/videocontrol-data/*` (если DATA_ROOT задан).

```bash
# Проверка места и прав
df -h data/content
ls -al data/content

# Перенос данных (если мигрируете со старой структуры)
rsync -aH --delete public/content/ data/content/ 2>/dev/null || true
rsync -aH --delete .converted/ data/cache/converted/ 2>/dev/null || true
rsync -aH logs/ data/logs/ 2>/dev/null || true

# Внешний диск через /etc/fstab
echo '/dev/sdb1 /mnt/videocontrol-data ext4 defaults,noatime 0 2' | sudo tee -a /etc/fstab
sudo mkdir -p /mnt/videocontrol-data
sudo mount -a

# Кэш трейлеров
ls -lh data/cache/trailers/
find data/cache/trailers -type f -mtime +7 -print -delete

# Кэш стримов
ls -lh data/streams/
# Очистка при заполнении диска (оставляет m3u8 + последние 3 .ts)
```

---

## 💿 Бэкапы и восстановление

### SQLite
```bash
# Консистентный бэкап
sqlite3 config/main.db '.backup config/main-$(date +%F_%H%M).db'

# Dump
sqlite3 config/main.db '.timeout 5000' '.once backup-$(date +%F_%H%M).sql' '.dump'

# Восстановление
sqlite3 config/main-restored.db < backup-YYYY-MM-DD_HHMM.sql
mv config/main.db config/main.db.bak
mv config/main-restored.db config/main.db
```

### Hero БД
```bash
# Бэкап
sqlite3 config/hero/heroes.db '.backup config/hero/heroes-$(date +%F_%H%M).db'

# Или через API админ-панели героев: GET /api/hero/export-database
```

### Данные
```bash
# Бэкап всех данных
rsync -aH --delete data/ /backup/mmrc-data/

# Восстановление
rsync -aH --delete /backup/mmrc-data/ data/
```

---

## 📱 Android / ADB

### Подготовка и подключение
```bash
sudo apt-get install -y android-sdk-platform-tools
adb kill-server && adb start-server
adb connect 192.168.1.50:5555
adb devices -l
```
Используйте `adb -s SERIAL ...` для конкретного устройства.

### Автоустановка APK (через скрипт)
```bash
cd /var/lib/mmrc
./dev/scripts/quick-setup-android.sh <device_ip:port> <server_url> <device_id>

# Пример:
./dev/scripts/quick-setup-android.sh 192.168.11.57:5555 http://192.168.11.1 ATV001
```

### Установка и перезапуск плеера
```bash
adb -s SERIAL install -r app-release.apk
adb -s SERIAL shell am force-stop com.videocontrol.mediaplayer
adb -s SERIAL shell monkey -p com.videocontrol.mediaplayer -c android.intent.category.LAUNCHER 1
adb -s SERIAL shell pm clear com.videocontrol.mediaplayer   # полный сброс
adb -s SERIAL shell pidof com.videocontrol.mediaplayer
```

### Настройка shared_prefs
```bash
# Ручная настройка Server URL и Device ID через ADB
adb -s SERIAL shell "mkdir -p /data/data/com.videocontrol.mediaplayer/shared_prefs"
adb -s SERIAL shell "echo '<?xml version=\"1.0\" encoding=\"utf-8\"?><map><string name=\"server_url\">http://SERVER_IP</string><string name=\"device_id\">DEVICE_ID</string></map>' > /data/data/com.videocontrol.mediaplayer/shared_prefs/com.videocontrol.mediaplayer_preferences.xml"
```

### Сети, память, файлы
```bash
adb -s SERIAL shell getprop net.dns1
adb -s SERIAL shell ping -c 3 192.168.1.1
adb -s SERIAL shell netstat -an | grep -E "3000|80|443"
adb -s SERIAL shell df -h /sdcard /data
adb -s SERIAL shell ls -lh /sdcard/MMRC/files
```

### Логи и диагностика
```bash
adb -s SERIAL logcat -d | grep -iE "MMRCPlayer|MMRC|ExoPlayer|MediaCodec" | tail -n 200
adb -s SERIAL logcat | grep -iE "player error"
adb -s SERIAL bugreport bugreport-$(date +%F_%H%M).zip
adb -s SERIAL shell dumpsys package com.videocontrol.mediaplayer | grep granted
```

---

## 🎖️ Hero Module

```bash
# Проверить БД героев
sqlite3 config/hero/heroes.db ".tables"
sqlite3 config/hero/heroes.db "SELECT id, full_name, created_at FROM heroes ORDER BY created_at DESC LIMIT 20;"

# Экспорт через CLI
sqlite3 config/hero/heroes.db ".backup config/hero/heroes-backup.db"

# Проверить права
ls -la config/hero/
```

---

## 🚀 Быстрая установка и переменные

```bash
# Переменные для quick-install.sh
export AUTO_CONFIRM=1
export STORAGE_MODE=external
export CONTENT_DIR=/mnt/vc-content
export CONTENT_SOURCE=/dev/sdb1
export CONTENT_FSTAB_OPTS="ext4 defaults,noatime 0 2"

# Неблокирующий запуск
sudo AUTO_CONFIRM=1 STORAGE_MODE=external CONTENT_DIR=/mnt/vc-content \
     bash dev/scripts/quick-install.sh

# Быстрая установка server-only (без Nginx) с автоответами
sudo AUTO_CONFIRM=1 bash scripts/install-server.sh
```

---

## 🔍 Дополнительные проверки

```bash
# Проверка синхронизации панели спикера
journalctl -u videocontrol -n 200 --no-pager | grep "player/folderPage"
curl -s http://HOST/api/devices | jq '.[] | {device_id, current}'

# Проверка доступности сервера с Android-устройства
adb -s SERIAL shell ping -c 3 <SERVER_IP>

# Проверка уведомлений
curl -H "Authorization: Bearer TOKEN" http://HOST/api/notifications

# Проверка circuit breaker статусов
curl -H "Authorization: Bearer TOKEN" http://HOST/api/metrics

# Проверка self-update статуса
cat /var/lib/mmrc/.tmp/update-checker-state.json
```

---

**Версия:** 3.2.1
