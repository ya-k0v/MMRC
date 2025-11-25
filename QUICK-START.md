# 🚀 VideoControl 2.8.0 — Быстрая установка

## ⚡ Установка одной командой

### Ubuntu/Debian (чистая ОС)

```bash
wget -O - https://raw.githubusercontent.com/ya-k0v/VideoControl/main/scripts/quick-install.sh | sudo bash
```

> `scripts/quick-install.sh` — production‑установщик, который проверяет ОС, ставит Node.js 20 LTS, все системные утилиты, клонирует репозиторий в `/vid/videocontrol`, настраивает хранилище контента, применяет сетевые оптимизации, разворачивает Nginx и создаёт systemd‑сервис `videocontrol`.

### Нон-интерактивный запуск

```bash
STORAGE_MODE=external \
CONTENT_DIR=/mnt/vc-content \
CONTENT_SOURCE="UUID=xxxx-xxxx" \
sudo bash scripts/quick-install.sh /vid/videocontrol
```

- `STORAGE_MODE`: `local` | `external` | `external_fstab`
- `CONTENT_DIR`: каталог с медиа (обязателен для external режимов)
- `CONTENT_SOURCE`: устройство/UUID для записи в `/etc/fstab` (только `external_fstab`)
- `CONTENT_FSTAB_OPTS`: параметры монтирования (по умолчанию `ext4 defaults,noatime 0 2`)

### Ручная установка (dev / кастомные окружения)

```bash
git clone https://github.com/ya-k0v/VideoControl.git
cd VideoControl
npm install
cp config/video-optimization.json.example config/video-optimization.json  # при необходимости
node server.js
```

---

## 📦 Что делает quick-install

### Системные зависимости
- ✅ Node.js 20.x LTS (Nodesource)
- ✅ FFmpeg + FFprobe
- ✅ LibreOffice (конвертация PDF/PPTX)
- ✅ ImageMagick (рендер изображений)
- ✅ SQLite3 + sqlite CLI
- ✅ build-essential, curl, wget, git, unzip
- ✅ Nginx (reverse proxy)

### Node.js пакеты
- ✅ express, socket.io
- ✅ bcrypt, jsonwebtoken, cookie-parser
- ✅ better-sqlite3, multer, uuid
- ✅ pdf-lib, pdf2pic
- ✅ winston, rotating-file-stream
- ✅ см. `package.json` для полного списка

### Настройка системы
- ✅ Создаёт структуру `/vid/videocontrol` (config, logs, .converted, temp)
- ✅ Генерирует `.env` c JWT secret (access 12h, refresh 30d)
- ✅ Инициализирует `config/main.db` (admin/admin123) и `config/video-optimization.json`
- ✅ Добавляет пользователя в `vcgroup`, готовит `~/.cache` для LibreOffice
- ✅ Запускает `scripts/optimize-network.sh` (TCP буферы 16 MB)
- ✅ Разворачивает `nginx/videocontrol-secure.conf` и включает Nginx
- ✅ Создаёт и активирует `videocontrol.service` (systemd)
- ✅ Настраивает права и симлинки для контента

### Режимы хранения контента
- `local` — файлы живут в `public/content`
- `external` — контент лежит в `CONTENT_DIR`, а `public/content` = symlink
- `external_fstab` — внешний диск монтируется в `CONTENT_DIR` через `/etc/fstab`, далее symlink

> Параметры можно менять после установки через админ‑панель → "Настройки → Хранилище контента".

---

## 🎯 После установки

- 🌐 Admin Panel: `http://YOUR_SERVER_IP/`
- 🎤 Speaker Panel: `http://YOUR_SERVER_IP/speaker.html`
- 🎮 Player: `http://YOUR_SERVER_IP/player-videojs.html?device_id=DEVICE_ID`
- 👤 По умолчанию: `admin / admin123` (обязательно сменить)
- 📂 Контент: `/vid/videocontrol/public/content` или ваш `CONTENT_DIR`
- 📋 Логи: `/vid/videocontrol/logs/combined-*.log`, `/vid/videocontrol/logs/error-*.log`

---

## 🔧 Управление сервисом

```bash
# Проверить статус
sudo systemctl status videocontrol

# Перезапустить
sudo systemctl restart videocontrol

# Остановить / Запустить
sudo systemctl stop videocontrol
sudo systemctl start videocontrol

# Логи приложения
sudo journalctl -u videocontrol -f

tail -f /vid/videocontrol/logs/combined-*.log
tail -f /vid/videocontrol/logs/error-*.log

# Nginx
sudo tail -f /var/log/nginx/videocontrol_error.log
sudo tail -f /var/log/nginx/videocontrol_access.log
```

> Quick-install автоматически включает `videocontrol.service` и `nginx`. При ручной установке скопируйте `videocontrol.service` в `/etc/systemd/system/` и выполните `systemctl enable videocontrol`.

---

## 📊 Структура проекта

```
/vid/videocontrol/
├── config/
│   ├── main.db                          # SQLite база (users, devices, files)
│   └── video-optimization.json          # Настройки оптимизации видео
├── public/
│   ├── content/                         # Контент устройств (до 5GB на файл)
│   ├── admin.html, speaker.html         # Интерфейсы
│   ├── hero.html, hero-admin.html       # Hero-модуль
│   └── player-videojs.html              # Плеер
├── logs/
│   ├── combined-YYYY-MM-DD.log          # Все логи
│   └── error-YYYY-MM-DD.log             # Ошибки
├── .converted/                          # Кэш конвертированных PDF/PPTX
├── temp/
│   └── nginx_upload/                    # Временные файлы загрузки
├── server.js                            # Главный файл сервера
├── src/                                 # Backend/Socket/Modules
└── .env                                 # JWT secret (автоген)
```

---

## 🔒 Безопасность

- ✅ **Nginx geo ACL** — доступ разрешён только из автоопределённой подсети (правки в `/etc/nginx/sites-available/videocontrol`)
- ✅ **JWT аутентификация** — access 12h, refresh 30d, refresh endpoint защищён
- ✅ **Audit log** — все действия пишутся в таблицу `audit_log`
- ✅ **Rate limiting** — включён для внешних IP, отключен для LAN
- ✅ **Winston** — структурированные логи с ротацией
- ✅ **Path traversal / MIME guard** — защита загрузок и отдачи файлов

### Смена пароля

```bash
curl -X POST http://YOUR_IP/api/auth/change-password \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "oldPassword": "admin123",
    "newPassword": "your_strong_password_123!"
  }'
```

Или через админ панель: **Настройки → Сменить пароль**.

---

## ⚙️ Дополнительная настройка

### Видео оптимизация

Редактируйте `config/video-optimization.json`:

```json
{
  "enabled": true,
  "autoOptimize": true,
  "deleteOriginal": true,
  "defaultProfile": "1080p",
  "thresholds": {
    "maxWidth": 1920,
    "maxHeight": 1080,
    "maxFps": 30,
    "maxBitrate": 6000000
  }
}
```

### Nginx
- Конфиг: `/etc/nginx/sites-available/videocontrol`
- `client_max_body_size`: 5GB (увеличивается при необходимости)
- Таймауты: 300–900 секунд
- `sendfile on;` для оптимальной отдачи видео

### Сети
- Скрипт `scripts/optimize-network.sh` выставляет:
  - `net.core.rmem_max = net.core.wmem_max = 16777216`
  - `net.ipv4.tcp_rmem = 4096 87380 16777216`
  - `net.ipv4.tcp_wmem = 4096 65536 16777216`
- Повторный запуск: `sudo bash scripts/optimize-network.sh`

### Hero-модуль
- База `config/heroes.db` создаётся автоматически при старте (`src/modules/hero/database/hero-db.js`)
- Ручной ресинк схемы: `sqlite3 config/heroes.db < src/modules/hero/database/schema.sql`

---

## 🐛 Решение проблем

### Сервер не запускается
```bash
sudo journalctl -u videocontrol -n 100
node --version  # должно быть 20.x
sudo netstat -tulpn | grep 3000
ls -la /vid/videocontrol/config/main.db
```

### Nginx ошибка
```bash
sudo nginx -t
sudo netstat -tulpn | grep :80
sudo tail -50 /var/log/nginx/videocontrol_error.log
```

### LibreOffice не работает
```bash
libreoffice --version
ls -la ~/.cache
mkdir -p ~/.cache ~/.config
chmod 755 ~/.cache ~/.config
```

### Загрузка файлов не работает
```bash
ls -la /vid/videocontrol/public/content/
ls -la /vid/videocontrol/temp/nginx_upload/
sudo chown -R $USER:vcgroup /vid/videocontrol/
sudo chmod 755 /vid/videocontrol/temp/nginx_upload/
```

---

## 📱 Клиенты

- **Android TV / Media Player**
  - APK: `VCMplayer-v2.8.0.apk` (и предыдущие версии в корне репозитория)
  - Автонастройка через `scripts/quick-setup-android.sh` (ADB, установка APK, device ID, отключение энергосбережения)
  - Вручную: `adb install -r VCMplayer-v2.8.0.apk`, затем прописать `Server URL` и `Device ID`
- **MPV Player (Linux):** `cd clients/mpv && sudo bash quick-install.sh`
- **Hero дисплеи:** `public/hero.html`, `public/hero-admin.html`
- **Браузер:** `http://SERVER_IP/player-videojs.html?device_id=YOUR_ID`

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

# Применить схему (идемпотентно)
sqlite3 config/main.db < src/database/init.sql
sqlite3 config/heroes.db < src/modules/hero/database/schema.sql

sudo systemctl start videocontrol
```

---

## 📚 Документация

- `README.md` — обзор и архитектура
- `docs/MANUAL.md` — SQLite, systemd, Nginx, бэкапы, health check, metrics
- `plan/ROADMAP.md`, `plan/SECURITY_LEVELS.md` — планы и уровни безопасности
- `clients/android-mediaplayer/` и `clients/mpv/` — документация клиентов

---

## 🔍 Мониторинг и диагностика

### Health Check
```bash
curl http://YOUR_SERVER_IP/health
# → status, uptime, memory, database, circuitBreakers
```

### Metrics (admin auth)
```bash
TOKEN=$(curl -s -X POST http://YOUR_SERVER_IP/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | jq -r '.accessToken')

curl -H "Authorization: Bearer $TOKEN" http://YOUR_SERVER_IP/api/metrics
# → запросы, БД, Socket.IO, перцентили времени ответа
```

---

## 🧰 Скрипты автоматизации

- `scripts/quick-install.sh` — полный production install (Ubuntu/Debian)
- `scripts/install-server.sh` — упрощённый серверный install (Ubuntu/Debian/CentOS/RHEL)
- `scripts/optimize-network.sh` — sysctl тюнинг для больших загрузок
- `scripts/setup-kiosk.sh` — настройка Linux медиаплеера в kiosk‑режим
- `scripts/quick-setup-android.sh` — конфигурация Android клиентов через ADB
- `scripts/generate-favicons.js` — генерация фавиконок для UI

---

## 💬 Поддержка

- GitHub: https://github.com/ya-k0v/VideoControl
- Issues: https://github.com/ya-k0v/VideoControl/issues

---

## ✅ Checklist после установки

- [ ] `systemctl status videocontrol`
- [ ] `systemctl status nginx`
- [ ] Админ панель доступна (`http://YOUR_IP/`)
- [ ] Вход `admin / admin123` работает, пароль сменён
- [ ] Созданы пользователи/устройства
- [ ] Загружен тестовый контент и отображается в плеере
- [ ] Speaker панель получает события в реальном времени
- [ ] Android/MPV/браузер клиенты подключаются

---

**Готово! 🎉 VideoControl установлен и готов к работе!**
