# 📺 VideoControl 3.0.0

**Система управления медиаконтентом для цифровых дисплеев**

![Version](https://img.shields.io/badge/version-3.0.0-blue)
![Node](https://img.shields.io/badge/node-20.x-green)
![License](https://img.shields.io/badge/license-MIT-orange)

---

## 🚀 Быстрый старт

### Установка одной командой

```bash
# Production установка с Nginx и systemd
sudo bash dev/scripts/quick-install.sh
```

### Ручная установка

```bash
# 1. Установите зависимости
npm install

# 2. Создайте конфигурацию .env
cp .env.example .env
nano .env  # Настройте переменные окружения

# 3. Создайте структуру директорий
mkdir -p config config/hero data/{content,streams,converted,logs,temp}

# 4. Запустите сервер
node server.js
```

**Важно:** Проект использует `dotenv` для загрузки переменных окружения из `.env` файла. Все настройки (JWT_SECRET, PORT, LOG_LEVEL и т.д.) должны быть указаны в `.env`.

**По умолчанию:**
- Сервер: `http://localhost:3000`
- Админ: `admin / admin123` (⚠️ **ОБЯЗАТЕЛЬНО СМЕНИТЬ** после первого входа!)

---

## 📚 Документация

### Основная документация
- [`INSTALL.md`](INSTALL.md) — полная инструкция по установке и развертыванию
- [`COMMANDS.md`](COMMANDS.md) — шпаргалка по командам для управления и обслуживания
- [`CLIENTS.md`](CLIENTS.md) — установка и настройка клиентов (Android, MPV, браузер)

### Панели управления
- [`ADMIN_PANEL_README.md`](ADMIN_PANEL_README.md) — описание работы админ-панели
- [`SPEAKER_PANEL_README.md`](SPEAKER_PANEL_README.md) — описание работы спикер-панели
- [`HERO_README.md`](HERO_README.md) — описание работы панели героев

---

## 🎯 Основные возможности

- ✅ **SQLite** — быстрая БД с WAL mode и автоматическими checkpoint
- ✅ **JWT Auth** — безопасная аутентификация с refresh tokens
- ✅ **MD5 Deduplication** — экономия места на диске
- ✅ **FFmpeg** — автооптимизация видео и HLS стриминг
- ✅ **PDF/PPTX → изображения** — автоконвертация
- ✅ **Graceful Shutdown** — корректное завершение с очисткой ресурсов
- ✅ **Winston Logging** — структурированные логи с ротацией
- ✅ **Rate Limiting** — защита от brute-force
- ✅ **Health Check** — мониторинг состояния
- ✅ **Metrics** — отслеживание производительности
- ✅ **Environment Variables** — конфигурация через `.env` файл
- ✅ **Error Handling** — обработка критических ошибок с уведомлениями
- ✅ **Resource Management** — автоматическая очистка таймеров, потоков и процессов
- ✅ **Theme Support** — поддержка темной и светлой темы в админ-панели

---

## 📦 Структура проекта

```
videocontrol/
├── server.js              # Точка входа
├── package.json           # Зависимости
├── .env.example           # Пример конфигурации
├── dev/                   # Документация и скрипты для администраторов
├── src/                   # Backend код
├── public/                # Frontend (HTML, JS, CSS)
├── config/                # Конфигурация (БД, настройки)
├── scripts/               # Скрипты разработки (generate-favicons.js)
├── clients/               # Клиентские приложения
│   ├── android-mediaplayer/
│   └── mpv/
└── nginx/                 # Конфигурация Nginx
```

---

## 🔧 Требования

- **Node.js** 20.x+
- **FFmpeg** + **FFprobe**
- **LibreOffice** (для PDF/PPTX)
- **SQLite3**

---

## 🔐 Безопасность

После установки:
1. **Измените пароль администратора** (по умолчанию: `admin / admin123`)
2. **Настройте JWT_SECRET** в `.env` файле (генерируется автоматически при установке)
3. **Настройте файрвол** (используйте только Nginx)
4. **Настройте SSL/TLS** (через Nginx)
5. **Проверьте права доступа** на `.env` файл (должен быть `600`)

**Переменные окружения в `.env`:**
- `JWT_SECRET` — секретный ключ для JWT токенов (обязательно)
- `PORT` — порт сервера (по умолчанию: 3000)
- `HOST` — хост сервера (по умолчанию: 127.0.0.1)
- `LOG_LEVEL` — уровень логирования (info, warn, error, debug)
- `SILENT_CONSOLE` — отключить вывод в консоль (false/true)
- `WAL_CHECKPOINT_INTERVAL_MS` — интервал checkpoint для SQLite WAL
- И другие настройки (см. `.env.example`)

---

## 📱 Клиенты

- **Android TV / Media Player** — APK в корне проекта (`VCMplayer-v3.0.0.apk`)
- **MPV Player (Linux)** — нативный медиаплеер
- **Browser** — веб-плеер через Video.js

---

## 🔄 Обновление

```bash
cd /vid/videocontrol
sudo systemctl stop videocontrol
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

sudo systemctl start videocontrol
```

**Важно:** После обновления проверьте, что `.env` файл содержит все необходимые переменные. Новые переменные могут быть добавлены в `.env.example`.

---

## 📄 Лицензия

MIT License — свободное использование

---

## 👤 Автор

**ya-k0v** - [GitHub](https://github.com/ya-k0v/VideoControl)

**Версия:** 3.0.0

---

## 📞 Поддержка

- GitHub: https://github.com/ya-k0v/VideoControl
- Issues: https://github.com/ya-k0v/VideoControl/issues
- Документация: [`docs/`](docs/)

