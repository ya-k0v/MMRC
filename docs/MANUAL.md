# MANUAL — Командные блоки VideoControl

Версия проекта: 3.0.0

Справочник разделён по областям: Videocontrol (systemd/Node.js), Nginx, SQL/SQLite, хранилище контента, бэкапы, Android/ADB, быстрые установки и дополнительные проверки.

---

## 📚 Дополнительная документация

### Панели управления

- **Админ-панель:** `public/ADMIN_PANEL_README.md` — подробное описание админ-панели
- **Спикер-панель:** `public/SPEAKER_PANEL_README.md` — подробное описание спикер-панели
- **Hero-модуль:** `public/hero/README.md` — подробное описание картотеки героев

### Быстрый старт

- **QUICK-START.md** — пошаговая установка и подготовка окружения
- **README.md** — обзор системы, архитектура и возможности

---

### Новые возможности (v3.0.0)
- **Дедупликация стримов** — один FFmpeg процесс обслуживает все устройства, использующие один и тот же исходный URL стрима. Стрим работает, пока хотя бы одно устройство его использует.
- **Динамические пути данных** — все пути данных (content, streams, converted, logs, temp) определяются динамически на основе единой настройки `contentRoot` в админ-панели. Автоматическое создание поддиректорий.
- **Очистка несуществующих файлов** — автоматическая проверка файлов в БД и удаление записей для файлов, которых нет на диске. API endpoint для ручной очистки.
- **Улучшенная логика idle timeout** — стримы останавливаются только если все устройства закрыли стрим и прошло 3 минуты без активности.
- **Hero Module** — отдельный модуль (`public/hero/`, `src/hero/`) с базой `config/hero/heroes.db` и REST API для биографий.
- **Авто-миграции heroes.db** — база создаётся и синхронизируется при старте сервера, доступен экспорт `/api/hero/export-database`.
- **Quick-install 2.0** — улучшенный скрипт с выбором режима хранилища, sysctl оптимизациями и готовым systemd unit.
- **Android APK v3.0.0** — новая сборка плеера + ADB-скрипт `scripts/quick-setup-android.sh` для быстрой настройки устройств.

---

## Блок A — Videocontrol (systemd/Node.js)

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
# Обновление Node.js-приложения
sudo systemctl stop videocontrol
git pull --rebase
npm ci || npm install
sudo systemctl start videocontrol
sudo journalctl -u videocontrol -n 100 --no-pager

# Диагностика FFmpeg и статусов файлов
ffmpeg -version
sqlite3 config/main.db "SELECT * FROM file_statuses WHERE status='error' ORDER BY updated_at DESC LIMIT 20;"

# Проверка видео-эндпоинтов
curl -I "http://HOST/api/files/trailer/DEVICE/FILE.mp4"
curl -I -H "Range: bytes=0-524287" "http://HOST/api/files/resolve/DEVICE/FILE.mp4"

# Socket.IO sanity-check
curl -s "http://HOST/socket.io/?EIO=4&transport=polling" | head -n 1

# Health Check (мониторинг состояния сервера)
curl http://HOST/health
# Возвращает: status, uptime, memory, database, circuitBreakers

# Metrics (требует авторизации admin)
curl -H "Authorization: Bearer TOKEN" http://HOST/api/metrics
# Возвращает: метрики запросов, БД, Socket.IO, перцентили времени ответа
```

---

## Блок B — Nginx
```bash
sudo nginx -t
sudo systemctl restart nginx
sudo journalctl -u nginx -n 100 --no-pager

# Логи виртуального хоста
sudo tail -n 200 /var/log/nginx/videocontrol-access.log
sudo tail -n 200 /var/log/nginx/videocontrol-error.log
```

---

## Блок C — SQL / SQLite

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
SELECT safe_name, file_size, created_at
FROM files_metadata
WHERE device_id = 'DEVICE001'
ORDER BY created_at DESC
LIMIT 50;
```

### Сброс пароля admin
```sql
UPDATE users
SET password_hash='$2b$10$jgHKNtHUKUhkftKlOfDqOulY9LFBVi/AirOu0YSKfzDlvFD60QI/W',
    updated_at=CURRENT_TIMESTAMP
WHERE username='admin';
```
Генерация нового bcrypt-хэша:
```bash
node -e "import('bcrypt').then(b=>b.hash('NEW_STRONG_PASSWORD',10).then(console.log))"
```

---

## Блок D — Хранилище данных
По умолчанию: `data/*` (локально) или `/mnt/videocontrol-data/*` (если DATA_ROOT задан). Режимы: `local`, `external`, `external_fstab`.
```bash
# Проверка места и прав
df -h data/content
ls -al data/content

# Перенос данных (если мигрируете со старой структуры)
rsync -aH --delete public/content/ data/content/ 2>/dev/null || true
rsync -aH --delete .converted/ data/converted/ 2>/dev/null || true
rsync -aH logs/ data/logs/ 2>/dev/null || true

# Внешний диск через /etc/fstab
echo '/dev/sdb1 /mnt/videocontrol-data ext4 defaults,noatime 0 2' | sudo tee -a /etc/fstab
sudo mkdir -p /mnt/videocontrol-data
sudo mount -a

# Кэш трейлеров (по умолчанию: data/converted/trailers/)
ls -lh data/converted/trailers/
find data/converted/trailers -type f -mtime +7 -print -delete
```

---

## Блок E — Бэкапы и восстановление

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

### Данные
```bash
# Бэкап всех данных
rsync -aH --delete data/ /backup/videocontrol-data/

# Восстановление
rsync -aH --delete /backup/videocontrol-data/ data/
```

---

## Блок F — Android / ADB

### Подготовка и подключение
```bash
sudo apt-get install -y android-sdk-platform-tools
adb kill-server && adb start-server
adb connect 192.168.1.50:5555
adb devices -l
```
Используйте `adb -s SERIAL ...` для конкретного устройства (SERIAL = USB ID или `ip:port`).

### Установка и перезапуск плеера
```bash
adb -s SERIAL install -r app-release.apk
adb -s SERIAL shell am force-stop com.videocontrol.mediaplayer
adb -s SERIAL shell monkey -p com.videocontrol.mediaplayer -c android.intent.category.LAUNCHER 1
adb -s SERIAL shell pm clear com.videocontrol.mediaplayer   # полный сброс
adb -s SERIAL shell pidof com.videocontrol.mediaplayer
```

### Сети, память, файлы
```bash
adb -s SERIAL shell getprop net.dns1
adb -s SERIAL shell ping -c 3 192.168.1.1
adb -s SERIAL shell netstat -an | grep -E "3000|80|443"
adb -s SERIAL shell df -h /sdcard /data
adb -s SERIAL shell ls -lh /sdcard/VideoControl/files
```

### Логи и диагностика
```bash
adb -s SERIAL logcat -d | grep -iE "VCMediaPlayer|VideoControl|ExoPlayer|MediaCodec" | tail -n 200
adb -s SERIAL logcat | grep -iE "player error"
adb -s SERIAL bugreport bugreport-$(date +%F_%H%M).zip
adb -s SERIAL shell dumpsys package com.videocontrol.mediaplayer | grep granted
```

### Типовые сценарии
```bash
# Быстрая переустановка
adb -s SERIAL uninstall com.videocontrol.mediaplayer || true
adb -s SERIAL install app-release.apk
adb -s SERIAL shell monkey -p com.videocontrol.mediaplayer -c android.intent.category.LAUNCHER 1

# Чистка зависшего плеера
adb -s SERIAL shell am force-stop com.videocontrol.mediaplayer
adb -s SERIAL shell pm clear com.videocontrol.mediaplayer
adb -s SERIAL shell settings put global stay_on_while_plugged_in 3
adb -s SERIAL shell svc power stayon true
adb -s SERIAL shell monkey -p com.videocontrol.mediaplayer -c android.intent.category.LAUNCHER 1
```

---

## Блок G — Быстрая установка и переменные
```bash
# Переменные для quick-install.sh
export AUTO_CONFIRM=1                  # отключает все вопросы
export STORAGE_MODE=external           # local | external | external_fstab
export CONTENT_DIR=/mnt/vc-content
export CONTENT_SOURCE=/dev/sdb1         # или UUID=xxxx-xxxx
export CONTENT_FSTAB_OPTS="ext4 defaults,noatime 0 2"

# Неблокирующий запуск
sudo AUTO_CONFIRM=1 STORAGE_MODE=external CONTENT_DIR=/mnt/vc-content \
     bash scripts/quick-install.sh /vid/videocontrol

# Быстрая установка server-only (без Nginx) с автоответами
sudo AUTO_CONFIRM=1 bash scripts/install-server.sh
```

### Чистый сервер за 5 шагов
```bash
sudo mkfs.ext4 /dev/sdb1
sudo mkdir -p /mnt/vc-content
echo '/dev/sdb1 /mnt/vc-content ext4 defaults,noatime 0 2' | sudo tee -a /etc/fstab
sudo mount -a

sudo mkdir -p /vid/videocontrol && cd /vid/videocontrol
sudo apt-get update -y && sudo apt-get install -y git
sudo git clone https://github.com/ya-k0v/VideoControl.git .

export STORAGE_MODE=external_fstab
export CONTENT_DIR=/mnt/vc-content
export CONTENT_SOURCE=/dev/sdb1
export CONTENT_FSTAB_OPTS="ext4 defaults,noatime 0 2"

printf 'y\ny\n' | sudo bash scripts/quick-install.sh /vid/videocontrol

sudo systemctl status videocontrol
sudo nginx -t && sudo systemctl restart nginx
echo "URL: http://$(hostname -I | awk '{print $1}')"
```

---

## Блок H — Дополнительные проверки
```bash
# Проверка синхронизации панели спикера
journalctl -u videocontrol -n 200 --no-pager | grep "player/folderPage"
curl -s http://HOST/api/devices | jq '.[] | {device_id, current}'

# Проверка доступности сервера с Android-устройства
adb -s SERIAL shell ping -c 3 <SERVER_IP>
```

- Убедитесь, что ссылки на воспроизведение идут через `/api/files/resolve/<device>/<file>` с ответом `206 Partial Content`.
- MEDIA_ERR_SRC_NOT_SUPPORTED чаще всего связано с отсутствием трейлера/видео или неправильными Range-заголовками на сервере.

---

Документ обновлен: 2025-11-17.
