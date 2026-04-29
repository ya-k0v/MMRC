# 📦 Установка MMRC 3.2.1

Полное руководство по установке MMRC на новую систему.

## 📋 Требования

### Системные требования
- **ОС**: Linux (Ubuntu 20.04+, Debian 11+, или аналогичные)
- **Node.js**: 20.x или выше
- **npm**: 9.x или выше (обычно устанавливается вместе с Node.js)

### Внешние зависимости
- **FFmpeg** + **FFprobe** (для обработки видео и стриминга)
- **LibreOffice** (опционально, для конвертации PDF/PPTX)
- **SQLite3** (обычно предустановлен)
- **yt-dlp** (опционально, загружается автоматически при необходимости)

---

## 🚀 Быстрая установка (рекомендуется)

### Автоматическая установка одной командой

```bash
# На новом сервере (Ubuntu/Debian)
sudo bash dev/scripts/quick-install.sh
```

Или если уже клонировали репозиторий:

```bash
git clone https://github.com/ya-k0v/MMRC.git /var/lib/mmrc
cd /var/lib/mmrc
sudo bash dev/scripts/quick-install.sh
```

**Скрипт автоматически:**
- ✅ Установит Node.js 20.x, FFmpeg, LibreOffice, Nginx
- ✅ Установит npm зависимости
- ✅ Создаст структуру папок
- ✅ Настроит базу данных (admin/admin123)
- ✅ Настроит Nginx как reverse proxy
- ✅ Создаст systemd сервис
- ✅ Применит сетевые оптимизации

### Нон-интерактивный запуск

```bash
AUTO_CONFIRM=1 \
STORAGE_MODE=external \
CONTENT_DIR=/mnt/vc-content \
CONTENT_SOURCE="UUID=xxxx-xxxx" \
sudo bash dev/scripts/quick-install.sh
```

**Параметры:**
- `STORAGE_MODE`: `local` | `external` | `external_fstab`
- `CONTENT_DIR`: каталог с медиа (обязателен для external режимов)
- `CONTENT_SOURCE`: устройство/UUID для записи в `/etc/fstab` (только `external_fstab`)
- `CONTENT_FSTAB_OPTS`: параметры монтирования (по умолчанию `ext4 defaults,noatime 0 2`)
- `AUTO_CONFIRM=1`: отключает все вопросы "y/n"

### Упрощённая серверная установка без Nginx

```bash
AUTO_CONFIRM=1 sudo bash scripts/install-server.sh
```

---

## 📋 Ручная установка (пошагово)

### Шаг 1: Установка Node.js

```bash
# Для Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Проверка версии
node --version  # Должно быть v20.x.x или выше
npm --version   # Должно быть 9.x.x или выше
```

### Шаг 2: Установка FFmpeg

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y ffmpeg

# Проверка
ffmpeg -version
ffprobe -version
```

### Шаг 3: Установка LibreOffice (опционально)

```bash
# Ubuntu/Debian
sudo apt-get install -y libreoffice

# Проверка
libreoffice --version
```

### Шаг 4: Клонирование и установка проекта

```bash
# Клонируем репозиторий
git clone https://github.com/ya-k0v/MMRC.git /var/lib/mmrc
cd /var/lib/mmrc

# Устанавливаем зависимости
npm install

# Включаем git-hooks
npm run setup-hooks
```

### Шаг 5: Создание директорий данных

```bash
# Создаем необходимые директории
mkdir -p config config/hero
mkdir -p data/{content,streams,cache,logs}

# Устанавливаем права доступа
chmod -R 755 data config
```

### Шаг 6: Настройка переменных окружения

```bash
# Создаем .env файл из примера
cp .env.example .env

# Генерируем JWT_SECRET
JWT_SECRET=$(openssl rand -hex 64)
echo "JWT_SECRET=$JWT_SECRET" >> .env

# Редактируем .env для настройки других параметров
nano .env
```

**Минимальная конфигурация `.env`:**
```env
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
JWT_SECRET=<сгенерированный_ключ>
JWT_ACCESS_EXPIRES_IN=12h
JWT_REFRESH_EXPIRES_IN=30d
LOG_LEVEL=info
SILENT_CONSOLE=false
```

**Расширенная конфигурация:**
```env
# Ночная оптимизация
NIGHT_OPT_START_HOUR=1
NIGHT_OPT_END_HOUR=5

# Ресурсы
JOB_RESERVE_CPU_PERCENT=30
JOB_RESERVE_MEMORY_MB=2048
JOB_MAX_SINGLE_JOB_PERCENT=70

# Стриминг
STREAM_MAX_JOBS=100
STREAM_IDLE_TIMEOUT_MS=180000

# LDAP (опционально)
LDAP_URL=ldap://your-ad-server:389
LDAP_BIND_DN=CN=svc-mmrc,OU=Services,DC=example,DC=com
LDAP_SEARCH_BASE=OU=Users,DC=example,DC=com
```

### Шаг 7: Инициализация базы данных

База данных создастся автоматически при первом запуске. Миграции применяются автоматически.

```bash
# Или инициализировать вручную (если нужно)
npm run migrate-db
```

**По умолчанию:**
- Логин: `admin`
- Пароль: `admin123`
- ⚠️ **ОБЯЗАТЕЛЬНО СМЕНИТЕ ПАРОЛЬ** после первого входа!

### Шаг 8: Настройка systemd

```bash
# Копируем unit файл
sudo cp videocontrol.service /etc/systemd/system/

# Редактируем пути (если нужно)
sudo nano /etc/systemd/system/videocontrol.service

# Перезагружаем systemd
sudo systemctl daemon-reload

# Включаем автозапуск
sudo systemctl enable videocontrol

# Запускаем сервис
sudo systemctl start videocontrol

# Проверяем статус
sudo systemctl status videocontrol
```

### Шаг 9: Настройка Nginx (опционально)

```bash
# Копируем конфигурацию
sudo cp nginx/videocontrol-secure.conf /etc/nginx/sites-available/videocontrol

# Создаем симлинк
sudo ln -s /etc/nginx/sites-available/videocontrol /etc/nginx/sites-enabled/

# Проверяем конфигурацию
sudo nginx -t

# Перезагружаем Nginx
sudo systemctl reload nginx
```

### Шаг 10: Проверка работы

```bash
# Health check
curl http://localhost:3000/health

# Или через Nginx
curl http://your-server-ip/health

# Логи
sudo journalctl -u videocontrol -f
tail -f data/logs/combined-*.log
```

---

## 🔄 Развертывание на новый сервер

### Перенос через Git (рекомендуется)

```bash
# На новом сервере
git clone https://github.com/ya-k0v/MMRC.git /var/lib/mmrc
cd /var/lib/mmrc
npm install
cp .env.example .env
# Отредактируйте .env с вашими настройками
nano .env
```

### Перенос через архив (без Git)

```bash
# На старом сервере - создайте архив
cd /var/lib/mmrc
tar --exclude='node_modules' \
    --exclude='data' \
    --exclude='config/*.db' \
    --exclude='config/*.db-*' \
    --exclude='.env' \
    --exclude='logs' \
    --exclude='temp' \
    -czf mmrc-production.tar.gz .

# Перенесите на новый сервер
scp mmrc-production.tar.gz user@new-server:/tmp/

# На новом сервере
mkdir -p /var/lib/mmrc
cd /var/lib/mmrc
tar -xzf /tmp/mmrc-production.tar.gz
npm install
cp .env.example .env
nano .env
```

### Перенос данных

```bash
# На старом сервере - создайте бэкап
tar -czf mmrc-data-backup.tar.gz \
    config/main.db \
    config/hero/heroes.db \
    data/content/

# Перенесите на новый сервер
scp mmrc-data-backup.tar.gz user@new-server:/tmp/

# На новом сервере - восстановите
cd /var/lib/mmrc
tar -xzf /tmp/mmrc-data-backup.tar.gz

# Установите правильные права
sudo chown -R $USER:$USER config/ data/
```

---

## 🔄 Обновление

```bash
cd /var/lib/mmrc
sudo systemctl stop videocontrol

# Бэкап
cp config/main.db config/main.db.backup

# Pull + deps + миграции
git pull origin main
npm install
npm run setup-hooks --silent || true
npm run migrate-db --silent

# Проверяем, что .env файл существует и содержит все необходимые переменные
if [ ! -f .env ]; then
    cp .env.example .env
    # Генерируем JWT_SECRET если его нет
    if ! grep -q "^JWT_SECRET=" .env; then
        JWT_SECRET=$(openssl rand -hex 64)
        echo "JWT_SECRET=$JWT_SECRET" >> .env
    fi
fi

sudo systemctl start videocontrol
```

**Или используйте встроенный self-update** через админ-панель (кнопка обновления в настройках).

---

## ✅ Проверка установки

### Ручная проверка

```bash
# Проверяем, что сервер запускается
node server.js

# В другом терминале проверяем health endpoint
curl http://localhost:3000/health
```

Ожидаемый ответ:
```json
{
  "status": "ok",
  "timestamp": 1234567890,
  "uptime": 5,
  "memory": {...},
  "database": "connected"
}
```

### Проверка доступных эндпоинтов

```bash
# Health check
curl http://localhost:3000/health

# Метрики (требует авторизации)
curl -H "Authorization: Bearer TOKEN" http://localhost:3000/api/metrics

# Socket.IO sanity-check
curl -s "http://localhost:3000/socket.io/?EIO=4&transport=polling"
```

---

## 🔐 Безопасность

После установки:

1. **Измените пароль администратора** (по умолчанию: `admin / admin123`)
2. **Настройте JWT_SECRET** в `.env` файле (генерируется автоматически при установке)
3. **Настройте LDAP** (опционально, для корпоративной аутентификации)
4. **Настройте файрвол** (используйте только Nginx)
5. **Настройте SSL/TLS** (через Nginx)
6. **Проверьте права доступа** на `.env` файл (должен быть `600`)

---

## 🐛 Решение проблем

### Проблема: Node.js не найден

```bash
# Проверяем установку
which node
node --version

# Если не установлен, устанавливаем заново
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Проблема: FFmpeg не найден

```bash
# Устанавливаем FFmpeg
sudo apt-get update
sudo apt-get install -y ffmpeg

# Проверяем
ffmpeg -version
```

### Проблема: npm install завершается с ошибкой

```bash
# Очищаем кэш npm
npm cache clean --force

# Удаляем node_modules и package-lock.json
rm -rf node_modules package-lock.json

# Устанавливаем заново
npm install
```

### Проблема: Порт 3000 занят

```bash
# Проверяем, что использует порт
sudo ss -tuln | grep 3000

# Меняем порт через переменную окружения
export PORT=3001
npm start
```

### Проблема: Сервер не запускается

```bash
sudo journalctl -u videocontrol -n 100
node --version  # должно быть 20.x
sudo ss -tuln | grep 3000
ls -la /var/lib/mmrc/config/main.db
```

### Проблема: Nginx ошибка

```bash
sudo nginx -t
sudo ss -tuln | grep :80
sudo tail -50 /var/log/nginx/videocontrol_error.log
```

### Проблема: Ошибка миграции БД

```bash
# Проверить целостность БД
sqlite3 config/main.db "PRAGMA integrity_check;"

# Применить миграции вручную
npm run migrate-db
```

---

## 📚 Дополнительная документация

- [`dev/README.md`](README.md) — общее описание проекта
- [`dev/COMMANDS.md`](COMMANDS.md) — шпаргалка по командам
- [`dev/CLIENTS.md`](CLIENTS.md) — установка и настройка клиентов
- [`dev/ADMIN_PANEL_README.md`](ADMIN_PANEL_README.md) — документация админ-панели
- [`dev/SPEAKER_PANEL_README.md`](SPEAKER_PANEL_README.md) — документация спикер-панели
- [`dev/HERO_README.md`](HERO_README.md) — документация Hero-модуля
- [`dev/GITHUB_ACTIONS_CICD.md`](GITHUB_ACTIONS_CICD.md) — CI/CD pipeline

---

**Версия:** 3.2.1
