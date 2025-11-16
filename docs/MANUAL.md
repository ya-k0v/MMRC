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


