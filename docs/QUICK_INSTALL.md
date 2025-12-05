# ⚡ Быстрая установка на новый сервер

## 🚀 Вариант 1: Автоматическая установка (рекомендуется)

### Одна команда для полной установки:

```bash
# На новом сервере (Ubuntu/Debian)
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ya-k0v/VideoControl/main/scripts/quick-install.sh)" /vid/videocontrol
```

Или если уже клонировали репозиторий:

```bash
git clone https://github.com/ya-k0v/VideoControl.git /vid/videocontrol
cd /vid/videocontrol
sudo bash scripts/quick-install.sh /vid/videocontrol
```

**Скрипт автоматически:**
- ✅ Установит Node.js 20.x, FFmpeg, LibreOffice, Nginx
- ✅ Установит npm зависимости
- ✅ Создаст структуру папок
- ✅ Настроит базу данных (admin/admin123)
- ✅ Настроит Nginx как reverse proxy
- ✅ Создаст systemd сервис
- ✅ Применит сетевые оптимизации

---

## 📋 Вариант 2: Ручная установка (пошагово)

### Шаг 1: Клонирование проекта

```bash
# Клонируем репозиторий
git clone https://github.com/ya-k0v/VideoControl.git /vid/videocontrol
cd /vid/videocontrol
```

### Шаг 2: Установка системных зависимостей

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y curl

# Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# FFmpeg, LibreOffice, SQLite
sudo apt-get install -y ffmpeg libreoffice imagemagick sqlite3

# Nginx (опционально, для reverse proxy)
sudo apt-get install -y nginx
```

### Шаг 3: Установка Node.js зависимостей

```bash
cd /vid/videocontrol
npm install --production
```

### Шаг 4: Настройка окружения

```bash
# Создаем .env из примера
cp .env.example .env

# Генерируем JWT_SECRET
JWT_SECRET=$(openssl rand -hex 64)

# Редактируем .env
nano .env
```

**Минимальная конфигурация `.env`:**
```env
NODE_ENV=production
PORT=3000
JWT_SECRET=<вставьте сгенерированный ключ>
DATA_ROOT=/mnt/videocontrol-data
LOG_LEVEL=info
```

### Шаг 5: Создание структуры директорий

```bash
mkdir -p config config/hero
mkdir -p data/{content,streams,converted,logs,temp}
```

### Шаг 6: Настройка systemd

```bash
# Редактируем unit файл
sudo nano /etc/systemd/system/videocontrol.service
```

**Содержимое `/etc/systemd/system/videocontrol.service`:**
```ini
[Unit]
Description=VCServer
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
Group=vcgroup
WorkingDirectory=/vid/videocontrol
ExecStart=/usr/bin/node /vid/videocontrol/server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

# Environment
Environment=NODE_ENV=production
Environment=JWT_SECRET=<ваш_секрет_из_.env>

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/mnt/videocontrol-data /vid/videocontrol/data /vid/videocontrol/config

[Install]
WantedBy=multi-user.target
```

**Важно:** Замените `YOUR_USERNAME` на ваше имя пользователя и добавьте `JWT_SECRET` из `.env` файла!

```bash
# Перезагружаем systemd
sudo systemctl daemon-reload

# Включаем автозапуск
sudo systemctl enable videocontrol

# Запускаем
sudo systemctl start videocontrol

# Проверяем статус
sudo systemctl status videocontrol
```

### Шаг 7: Настройка Nginx (опционально)

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

### Шаг 8: Проверка работы

```bash
# Health check
curl http://localhost:3000/health

# Или через Nginx
curl http://your-server-ip/health

# Логи
sudo journalctl -u videocontrol -f
```

---

## ✅ Чеклист после установки

- [ ] Проект склонирован в `/vid/videocontrol`
- [ ] Системные зависимости установлены (Node.js, FFmpeg, LibreOffice)
- [ ] `npm install` выполнен
- [ ] `.env` создан из `.env.example` и настроен
- [ ] `JWT_SECRET` установлен в `.env` и systemd unit
- [ ] Структура директорий создана
- [ ] Systemd сервис настроен и запущен
- [ ] Nginx настроен (если используется)
- [ ] Health check отвечает
- [ ] Пароль администратора изменен (по умолчанию: admin/admin123)

---

## 🔐 Безопасность

**Обязательно после установки:**

1. **Смените пароль администратора:**
   - Войдите: `http://your-server-ip/`
   - Логин: `admin` / Пароль: `admin123`
   - Настройки → Сменить пароль

2. **Проверьте JWT_SECRET:**
   ```bash
   grep JWT_SECRET .env
   # Должен быть установлен (не "your-secret-key-here")
   ```

3. **Настройте файрвол:**
   ```bash
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   ```

---

## 📚 Дополнительная документация

- [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) — подробное руководство по развертыванию
- [`docs/INSTALL.md`](INSTALL.md) — детальная установка на новую ОС
- [`docs/QUICK-START.md`](QUICK-START.md) — быстрый старт

---

**Версия:** 3.0.0

