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
sudo bash scripts/quick-install.sh
```

### Ручная установка

```bash
# 1. Установите зависимости
npm install

# 2. Создайте конфигурацию
cp .env.example .env
nano .env  # Настройте переменные окружения

# 3. Создайте структуру директорий
mkdir -p config config/hero data/{content,streams,converted,logs,temp}

# 4. Запустите сервер
node server.js
```

**По умолчанию:**
- Сервер: `http://localhost:3000`
- Админ: `admin / admin123` (⚠️ **ОБЯЗАТЕЛЬНО СМЕНИТЬ** после первого входа!)

---

## 📚 Документация

Вся документация находится в папке [`docs/`](docs/):

### Основная документация
- [`docs/README.md`](docs/README.md) — полное описание проекта, архитектура и возможности
- [`docs/INSTALL.md`](docs/INSTALL.md) — подробная инструкция по установке на новую ОС
- [`docs/QUICK-START.md`](docs/QUICK-START.md) — быстрый старт и настройка
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — развертывание в продакшене и перенос на новый сервер
- [`docs/MANUAL.md`](docs/MANUAL.md) — эксплуатация, мониторинг, бэкапы

### Панели управления
- [`docs/ADMIN_PANEL_README.md`](docs/ADMIN_PANEL_README.md) — админ-панель
- [`docs/SPEAKER_PANEL_README.md`](docs/SPEAKER_PANEL_README.md) — спикер-панель
- [`docs/HERO_README.md`](docs/HERO_README.md) — Hero-модуль (картотека героев)

### Клиенты
- [`docs/ANDROID_README.md`](docs/ANDROID_README.md) — Android клиент
- [`docs/ANDROID_QUICK_SETUP.md`](docs/ANDROID_QUICK_SETUP.md) — быстрая настройка Android
- [`docs/ANDROID_BUILD.md`](docs/ANDROID_BUILD.md) — сборка Android APK
- [`docs/ANDROID_AUTOSTART.md`](docs/ANDROID_AUTOSTART.md) — настройка автозапуска
- [`docs/MPV_README.md`](docs/MPV_README.md) — MPV клиент для Linux

### Техническая документация
- [`docs/AUDIT.md`](docs/AUDIT.md) — технический аудит проекта
- [`docs/HERO_PANELS_OPTIMIZATION.md`](docs/HERO_PANELS_OPTIMIZATION.md) — оптимизация панелей героев
- [`docs/MP4_FASTSTART.md`](docs/MP4_FASTSTART.md) — оптимизация MP4
- [`docs/UPLOAD_PROCESS_ANALYSIS.md`](docs/UPLOAD_PROCESS_ANALYSIS.md) — анализ процесса загрузки

---

## 🎯 Основные возможности

- ✅ **SQLite** — быстрая БД с WAL mode
- ✅ **JWT Auth** — безопасная аутентификация
- ✅ **MD5 Deduplication** — экономия места на диске
- ✅ **FFmpeg** — автооптимизация видео
- ✅ **PDF/PPTX → изображения** — автоконвертация
- ✅ **Graceful Shutdown** — корректное завершение
- ✅ **Winston Logging** — структурированные логи
- ✅ **Rate Limiting** — защита от brute-force
- ✅ **Health Check** — мониторинг состояния
- ✅ **Metrics** — отслеживание производительности

---

## 📦 Структура проекта

```
videocontrol/
├── server.js              # Точка входа
├── package.json           # Зависимости
├── .env.example           # Пример конфигурации
├── docs/                  # Вся документация
├── src/                   # Backend код
├── public/                # Frontend (HTML, JS, CSS)
├── config/                # Конфигурация (БД, настройки)
├── scripts/               # Скрипты установки
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
2. **Настройте JWT_SECRET** в `.env` файле
3. **Настройте файрвол** (используйте только Nginx)
4. **Настройте SSL/TLS** (через Nginx)

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
sudo systemctl start videocontrol
```

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

