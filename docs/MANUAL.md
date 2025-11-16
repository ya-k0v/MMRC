# MANUAL — Операционные команды и рецепты

Версия проекта: 2.6.3

## Сервис (systemd)

```bash
# Статус/логи
sudo systemctl status videocontrol
sudo journalctl -u videocontrol -n 200 --no-pager
sudo journalctl -u videocontrol -f

# Управление
sudo systemctl restart videocontrol
sudo systemctl stop videocontrol
sudo systemctl start videocontrol
sudo systemctl daemon-reload  # после изменения unit
```

## Логи приложения

```bash
tail -f logs/combined-*.log
tail -f logs/error-*.log
```

## Nginx

```bash
sudo nginx -t
sudo systemctl restart nginx
sudo journalctl -u nginx -n 100 --no-pager
```

## Хранилище контента

По умолчанию: `public/content`. При установке можно выбрать режим хранения:
- local — внутри проекта (`public/content`)
- external — внешний каталог через symlink (`public/content -> $CONTENT_DIR`)
- external_fstab — внешний диск монтируется в `$CONTENT_DIR` через `/etc/fstab`, далее symlink

Полезные команды:
```bash
# Проверить место и права
df -h public/content
ls -al public/content

# Перенести данные вручную (пример)
rsync -aH --delete public/content/ /mnt/vc-content/

# Пример записи в /etc/fstab (ext4)
echo '/dev/sdb1 /mnt/vc-content ext4 defaults,noatime 0 2' | sudo tee -a /etc/fstab
sudo mkdir -p /mnt/vc-content
sudo mount -a
```

## SQLite (консоль)

```bash
# Открыть БД
sqlite3 config/main.db

# Важные pragma/инфо
PRAGMA journal_mode;       -- ожидается WAL
PRAGMA integrity_check;
.tables
.schema users

# Быстрый экспорт (dump)
.output backup.sql
.dump
.output stdout

# VACUUM и статистика
VACUUM;
ANALYZE;
```

## Частые запросы

```sql
-- Последние действия (аудит)
SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 50;

-- Все устройства
SELECT device_id, name, folder, last_seen FROM devices ORDER BY updated_at DESC;

-- Файлы на устройстве
SELECT safe_name, file_size, created_at
FROM files_metadata
WHERE device_id = 'DEVICE001'
ORDER BY created_at DESC
LIMIT 50;
```

## Сброс пароля admin (через SQL с готовым bcrypt-хешем "admin123")

Хэш из init.sql:
```
$2b$10$jgHKNtHUKUhkftKlOfDqOulY9LFBVi/AirOu0YSKfzDlvFD60QI/W
```

```sql
UPDATE users
SET password_hash='$2b$10$jgHKNtHUKUhkftKlOfDqOulY9LFBVi/AirOu0YSKfzDlvFD60QI/W',
    updated_at=CURRENT_TIMESTAMP
WHERE username='admin';
```

Или задать новый пароль через Node.js (bcryptjs):
```bash
node -e "import('bcryptjs').then(b=>b.hash('NEW_STRONG_PASSWORD',10).then(h=>console.log(h)))"
```
Подставьте сгенерированный хэш в UPDATE.

## Бэкап/восстановление

```bash
# Бэкап SQLite (консистентный)
sqlite3 config/main.db '.backup config/main-$(date +%F_%H%M).db'

# Бэкап через dump
sqlite3 config/main.db '.timeout 5000' '.once backup-$(date +%F_%H%M).sql' '.dump'

# Восстановление из dump
sqlite3 config/main-restored.db < backup-YYYY-MM-DD_HHMM.sql
mv config/main.db config/main.db.bak
mv config/main-restored.db config/main.db
```

Контент:
```bash
rsync -aH --delete public/content/ /backup/vc-content/
rsync -aH --delete /backup/vc-content/ public/content/
```

## Диагностика загрузок/FFmpeg

```bash
# Проверить TCP/сеть
ss -tulpn | grep -E '3000|80|443'

# FFmpeg версия
ffmpeg -version

# Ошибки оптимизации
sqlite3 config/main.db "SELECT * FROM file_statuses WHERE status='error' ORDER BY updated_at DESC LIMIT 20;"
```

## Android: сбор логов и диагностика

```bash
# Список устройств
adb devices -l

# Снять логи с девайса (замените SERIAL на ip:port)
adb -s SERIAL logcat -d | grep -iE "VCMediaPlayer|ExoPlayer|Playback|VideoControl|player error|MediaCodec|okhttp" | tail -n 200

# Онлайн просмотр логов
adb -s SERIAL logcat | grep -iE "VCMediaPlayer|ExoPlayer|Playback|VideoControl|player error|MediaCodec|okhttp"

# Перезапуск приложения
adb -s SERIAL shell am force-stop com.videocontrol.mediaplayer
adb -s SERIAL shell monkey -p com.videocontrol.mediaplayer -c android.intent.category.LAUNCHER 1

# Проверить, что процесс запущен
adb -s SERIAL shell ps -A | grep videocontrol

# Проверить доступность сервера с устройства
adb -s SERIAL shell ping -c 3 192.168.1.1

# Проверить свободное место/кэш
adb -s SERIAL shell df -h /sdcard /data

# Полный системный отчёт (долго)
adb -s SERIAL bugreport bugreport-$(date +%F_%H%M).zip
```

Заметки:
- Если в браузере видите MEDIA_ERR_SRC_NOT_SUPPORTED — проверьте HEAD/GET трейлера/видео и заголовки Range на сервере.
- На Android следите за MediaCodec/ExoPlayer ошибками и таймаутами HTTP (60s).
- Убедитесь, что URL воспроизведения идёт через `/api/files/resolve/<device>/<file>`.

## Проверка видео-эндпоинтов (сервер)

```bash
# HEAD трейлера (должен быть 200 когда готов, иначе 404)
curl -I "http://HOST/api/files/trailer/DEVICE/FILE.mp4"

# Проверка Range (частичный контент 206, корректный Content-Range/Length)
curl -I -H "Range: bytes=0-524287" "http://HOST/api/files/resolve/DEVICE/FILE.mp4"
```

## Логи сервера и Nginx

```bash
# Node.js ошибки приложения
tail -n 200 logs/error-*.log

# Последние записи systemd
journalctl -u videocontrol -n 200 --no-pager

# Фильтр по конкретному файлу/резолверу
journalctl -u videocontrol -n 500 --no-pager | grep -i "resolve.*FILE.mp4"

# Логи Nginx
sudo tail -n 200 /var/log/nginx/videocontrol-error.log
sudo tail -n 200 /var/log/nginx/videocontrol-access.log
```

## ffprobe диагностика (сервер)

```bash
ffprobe -v error \
  -select_streams v:0 \
  -show_entries stream=codec_name,width,height,r_frame_rate,bit_rate,profile,level \
  -show_entries format=duration \
  -of json "/path/to/file.mp4"
```

## Android: дополнительные команды

```bash
# Сброс данных приложения
adb -s SERIAL shell pm clear com.videocontrol.mediaplayer

# Логи только нашего пакета
adb -s SERIAL logcat -d | grep -i "com.videocontrol.mediaplayer" | tail -n 200

# Сетевые сокеты/подключения
adb -s SERIAL shell netstat -an | grep -E "3000|80|443"

# DNS на устройстве
adb -s SERIAL shell getprop net.dns1; adb -s SERIAL shell getprop net.dns2

# Проверка выданных разрешений
adb -s SERIAL shell dumpsys package com.videocontrol.mediaplayer | grep -i granted
```

## Socket.IO быстрый тест

```bash
# Ожидаем ответ вида: 0{"sid":...} или аналогичный (EIO=4)
curl -s "http://HOST/socket.io/?EIO=4&transport=polling" | head -n1
```

## Кэш трейлеров (сервер)

```bash
# Список трейлеров (5s MP4 по md5)
ls -lh CONVERTED_CACHE/trailers/

# Очистка старше 7 дней
find CONVERTED_CACHE/trailers -type f -mtime +7 -print -delete
```

## Обновление приложения

```bash
sudo systemctl stop videocontrol
git pull --rebase
npm ci || npm install
sudo systemctl start videocontrol
sudo journalctl -u videocontrol -n 100 --no-pager
```

## Полезные переменные для quick-install.sh

```bash
# Режим хранения контента
export STORAGE_MODE=external            # local | external | external_fstab
export CONTENT_DIR=/mnt/vc-content
export CONTENT_SOURCE=/dev/sdb1         # или UUID=xxxx-xxxx (для external_fstab)
export CONTENT_FSTAB_OPTS="ext4 defaults,noatime 0 2"
```


