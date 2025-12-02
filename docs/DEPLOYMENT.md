# 🚀 Развертывание VideoControl в продакшене

## Подготовка к переносу на новый сервер

### 1. Структура проекта

Проект готов к переносу. Все файлы организованы следующим образом:

```
videocontrol/
├── server.js                 # Точка входа сервера
├── package.json              # Зависимости Node.js
├── .env.example              # Пример конфигурации (скопируйте в .env)
├── .gitignore                # Игнорируемые файлы
├── videocontrol.service      # Systemd unit файл
├── docs/                     # Вся документация
│   ├── README.md
│   ├── INSTALL.md
│   ├── QUICK-START.md
│   └── ...
├── src/                      # Исходный код сервера
├── public/                   # Статические файлы (HTML, JS, CSS)
├── config/                   # Конфигурация (БД, настройки)
├── scripts/                  # Скрипты установки и обслуживания
├── clients/                  # Клиентские приложения
│   ├── android-mediaplayer/
│   └── mpv/
└── nginx/                    # Конфигурация Nginx
```

### 2. Что нужно для переноса

#### Обязательные файлы:
- ✅ Весь код проекта (`src/`, `public/`, `server.js`)
- ✅ `package.json` и `package-lock.json`
- ✅ `videocontrol.service` (systemd unit)
- ✅ `nginx/videocontrol-secure.conf` (конфигурация Nginx)
- ✅ `scripts/` (скрипты установки)
- ✅ `docs/` (документация)

#### Файлы, которые НЕ нужно переносить:
- ❌ `node_modules/` (устанавливается через `npm install`)
- ❌ `data/` (данные создаются на новом сервере)
- ❌ `config/main.db` и другие БД (создаются автоматически)
- ❌ `.env` (создается из `.env.example`)
- ❌ `logs/` (создаются автоматически)
- ❌ `temp/` (временные файлы)

### 3. Процесс переноса

#### Вариант 1: Через Git (рекомендуется)

```bash
# На новом сервере
git clone https://github.com/ya-k0v/VideoControl.git /vid/videocontrol
cd /vid/videocontrol
npm install
cp .env.example .env
# Отредактируйте .env с вашими настройками
nano .env
```

#### Вариант 2: Через архив (без Git)

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
# Отредактируйте .env
nano .env
```

### 4. Настройка окружения

#### Создайте `.env` файл:

```bash
cp .env.example .env
nano .env
```

**Минимальная конфигурация для продакшена:**

```env
NODE_ENV=production
PORT=3000
JWT_SECRET=<сгенерируйте через: openssl rand -hex 64>
DATA_ROOT=/mnt/videocontrol-data
LOG_LEVEL=info
```

#### Создайте структуру директорий:

```bash
mkdir -p config config/hero
mkdir -p data/content data/streams data/converted data/logs data/temp
```

### 5. Установка зависимостей

#### Системные зависимости:

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y nodejs npm ffmpeg libreoffice imagemagick sqlite3

# Или используйте скрипт установки
sudo bash scripts/install-server.sh
```

#### Node.js зависимости:

```bash
npm install --production
```

### 6. Настройка базы данных

База данных создается автоматически при первом запуске, но можно инициализировать вручную:

```bash
# Создание основной БД
sqlite3 config/main.db < src/database/init.sql

# Создание Hero БД
sqlite3 config/hero/heroes.db < src/hero/database/schema.sql
```

**По умолчанию:**
- Логин: `admin`
- Пароль: `admin123`
- ⚠️ **ОБЯЗАТЕЛЬНО СМЕНИТЕ ПАРОЛЬ** после первого входа!

### 7. Настройка systemd

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

### 8. Настройка Nginx

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

### 9. Настройка файрвола

```bash
# Разрешаем HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Закрываем прямой доступ к Node.js (порт 3000)
# Сервер слушает только на 127.0.0.1, поэтому это не обязательно
```

### 10. Перенос данных (если нужно)

Если нужно перенести существующие данные:

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

### 11. Проверка работы

```bash
# Проверка сервера
curl http://localhost:3000/health

# Проверка через Nginx
curl http://your-server-ip/health

# Проверка логов
sudo journalctl -u videocontrol -f
tail -f data/logs/combined-*.log
```

### 12. Обновление паролей и безопасности

1. **Смените пароль администратора:**
   - Войдите в админ-панель: `http://your-server-ip/`
   - Перейдите в Настройки → Сменить пароль

2. **Проверьте JWT_SECRET:**
   ```bash
   grep JWT_SECRET .env
   # Должен быть установлен (не "your-secret-key-here")
   ```

3. **Проверьте права доступа:**
   ```bash
   ls -la config/
   ls -la data/
   # Должны принадлежать пользователю, под которым запущен сервис
   ```

## Чеклист готовности к продакшену

- [ ] Все .md файлы перемещены в `docs/`
- [ ] `.env.example` создан и настроен
- [ ] `.env` создан из `.env.example` с реальными значениями
- [ ] `JWT_SECRET` установлен (не дефолтный)
- [ ] Пароль администратора изменен
- [ ] Systemd сервис настроен и запущен
- [ ] Nginx настроен и работает
- [ ] Файрвол настроен
- [ ] Логи работают
- [ ] Health check отвечает
- [ ] База данных инициализирована
- [ ] Структура директорий создана
- [ ] Права доступа установлены правильно

## Дополнительные рекомендации

### Мониторинг

```bash
# Установите мониторинг (опционально)
# Например, через systemd или внешний мониторинг
```

### Бэкапы

```bash
# Настройте автоматические бэкапы БД
# Добавьте в crontab:
0 2 * * * /vid/videocontrol/scripts/backup-db.sh
```

### Обновление

```bash
# Процесс обновления:
sudo systemctl stop videocontrol
git pull origin main  # или обновите файлы вручную
npm install
sudo systemctl start videocontrol
```

## Поддержка

- Документация: `docs/README.md`
- Установка: `docs/INSTALL.md`
- Быстрый старт: `docs/QUICK-START.md`

---

**Версия:** 3.0.0  
**Последнее обновление:** 2025-01-XX

