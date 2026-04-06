# 📦 Установка MMRC

Полное руководство по установке MMRC на новую систему.

## 📋 Требования

### Системные требования
- **ОС**: Linux (Ubuntu 20.04+, Debian 11+, или аналогичные)
- **Node.js**: 20.x или выше
- **npm**: 9.x или выше (обычно устанавливается вместе с Node.js)

### Внешние зависимости
- **FFmpeg** + **FFprobe** (для обработки видео)
- **LibreOffice** (опционально, для конвертации PDF/PPTX)
- **SQLite3** (обычно предустановлен)

---

## 🚀 Быстрая установка (рекомендуется)

### Автоматическая установка одной командой

```bash
# На новом сервере (Ubuntu/Debian)
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ya-k0v/MMRC/main/dev/scripts/quick-install.sh)" /vid/videocontrol
```

Или если уже клонировали репозиторий:

```bash
git clone https://github.com/ya-k0v/MMRC.git /vid/videocontrol
cd /vid/videocontrol
sudo bash dev/scripts/quick-install.sh /vid/videocontrol
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
sudo bash dev/scripts/quick-install.sh /vid/videocontrol
```

**Параметры:**
- `STORAGE_MODE`: `local` | `external` | `external_fstab`
- `CONTENT_DIR`: каталог с медиа (обязателен для external режимов)
- `CONTENT_SOURCE`: устройство/UUID для записи в `/etc/fstab` (только `external_fstab`)
- `CONTENT_FSTAB_OPTS`: параметры монтирования (по умолчанию `ext4 defaults,noatime 0 2`)
- `AUTO_CONFIRM=1`: отключает все вопросы "y/n"

### Упрощённая серверная установка без Nginx

```bash
AUTO_CONFIRM=1 sudo bash dev/scripts/install-server.sh
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
git clone https://github.com/ya-k0v/MMRC.git /vid/videocontrol
cd /vid/videocontrol

# Устанавливаем зависимости
npm install

# Проверяем окружение
bash dev/scripts/check-environment.sh
```

### Шаг 5: Создание директорий данных

```bash
# Создаем необходимые директории
mkdir -p config config/hero
mkdir -p data/{content,streams,converted,logs,temp}

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

### Шаг 7: Инициализация базы данных

База данных создастся автоматически при первом запуске, но можно инициализировать вручную:

```bash
# Создаем основную БД
sqlite3 config/main.db < src/database/init.sql

# Создаем Hero БД (если используется Hero модуль)
sqlite3 config/hero/heroes.db < src/hero/database/schema.sql
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
git clone https://github.com/ya-k0v/MMRC.git /vid/videocontrol
cd /vid/videocontrol
npm install
cp .env.example .env
# Отредактируйте .env с вашими настройками
nano .env
```

### Перенос через архив (без Git)

```bash
# На старом сервере - создайте архив
cd /vid/videocontrol
tar --exclude='node_modules' \
    --exclude='data' \
    --exclude='config/*.db' \
    --exclude='config/*.db-*' \
    --exclude='.env' \
    --exclude='logs' \
    --exclude='temp' \
    -czf videocontrol-production.tar.gz .

# Перенесите на новый сервер
scp videocontrol-production.tar.gz user@new-server:/tmp/

# На новом сервере
cd /vid
tar -xzf /tmp/videocontrol-production.tar.gz
cd videocontrol
npm install
cp .env.example .env
nano .env
```

### Перенос данных

```bash
# На старом сервере - создайте бэкап
tar -czf videocontrol-data-backup.tar.gz \
    config/main.db \
    config/hero/heroes.db \
    data/content/

# Перенесите на новый сервер
scp videocontrol-data-backup.tar.gz user@new-server:/tmp/

# На новом сервере - восстановите
cd /vid/videocontrol
tar -xzf /tmp/videocontrol-data-backup.tar.gz

# Установите правильные права
sudo chown -R $USER:$USER config/ data/
```

---

## 🔄 Обновление

```bash
cd /vid/videocontrol
sudo systemctl stop videocontrol

# Бэкап
cp config/main.db config/main.db.backup

# Pull + deps
git pull origin main
npm install

# Проверяем, что .env файл существует и содержит все необходимые переменные
if [ ! -f .env ]; then
    cp .env.example .env
    # Генерируем JWT_SECRET если его нет
    if ! grep -q "^JWT_SECRET=" .env; then
        JWT_SECRET=$(openssl rand -hex 64)
        echo "JWT_SECRET=$JWT_SECRET" >> .env
    fi
fi

# Применить схему (идемпотентно)
sqlite3 config/main.db < src/database/init.sql
sqlite3 config/hero/heroes.db < src/hero/database/schema.sql

sudo systemctl start videocontrol
```

---

## ✅ Проверка установки

### Автоматическая проверка

```bash
# Запускаем скрипт проверки окружения
bash dev/scripts/check-environment.sh
```

Скрипт проверит:
- ✅ Версию Node.js и npm
- ✅ Наличие FFmpeg и FFprobe
- ✅ Установленные npm пакеты
- ✅ Структуру директорий
- ✅ Права доступа
- ✅ Доступность портов

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

---

## 🔐 Безопасность

После установки:

1. **Измените пароль администратора** (по умолчанию: `admin / admin123`)
2. **Настройте JWT_SECRET** в `.env` файле (генерируется автоматически при установке)
3. **Настройте файрвол** (используйте только Nginx)
4. **Настройте SSL/TLS** (через Nginx)
5. **Проверьте права доступа** на `.env` файл (должен быть `600`)

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
sudo netstat -tuln | grep 3000
# или
sudo ss -tuln | grep 3000

# Меняем порт через переменную окружения
export PORT=3001
npm start
```

### Проблема: Сервер не запускается

```bash
sudo journalctl -u videocontrol -n 100
node --version  # должно быть 20.x
sudo netstat -tuln | grep 3000
ls -la /vid/videocontrol/config/main.db
```

### Проблема: Nginx ошибка

```bash
sudo nginx -t
sudo netstat -tuln | grep :80
sudo tail -50 /var/log/nginx/videocontrol_error.log
```

---

## 📚 Дополнительная документация

- [`dev/README.md`](README.md) — общее описание проекта
- [`dev/COMMANDS.md`](COMMANDS.md) — шпаргалка по командам
- [`dev/CLIENTS.md`](CLIENTS.md) — установка и настройка клиентов
- [`dev/ADMIN_PANEL_README.md`](ADMIN_PANEL_README.md) — документация админ-панели
- [`dev/SPEAKER_PANEL_README.md`](SPEAKER_PANEL_README.md) — документация спикер-панели
- [`dev/HERO_README.md`](HERO_README.md) — документация Hero-модуля

---

**Версия:** 3.1.1
