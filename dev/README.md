# 📺 MMRC 3.2.1

**Система управления медиаконтентом для цифровых дисплеев**

![Version](https://img.shields.io/badge/version-3.2.1-blue)
![Node](https://img.shields.io/badge/node-20.x-green)
![License](https://img.shields.io/badge/license-Personal_Use_Only-red)

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

# 1.1 Включите git-hooks (post-merge миграции)
npm run setup-hooks

# 2. Создайте конфигурацию .env
cp .env.example .env
nano .env  # Настройте переменные окружения

# 3. Создайте структуру директорий
mkdir -p config config/hero data/{content,streams,converted,logs,temp}

# 3.1 Инициализируйте/обновите схему БД
npm run migrate-db

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

### CI/CD и DevOps
- [`GITHUB_ACTIONS_CICD.md`](GITHUB_ACTIONS_CICD.md) — полный CI/CD для GitHub Actions

---

## 🎯 Основные возможности

### Управление контентом
- ✅ **SQLite** — быстрая БД с WAL mode и автоматическими checkpoint
- ✅ **JWT Auth** — безопасная аутентификация с refresh tokens
- ✅ **LDAP/Active Directory** — корпоративная аутентификация
- ✅ **MD5 Deduplication** — экономия места на диске (частичный MD5 для файлов >100MB)
- ✅ **FFmpeg** — автооптимизация видео, ночной оптимизатор и HLS/DASH стриминг
- ✅ **PDF/PPTX → изображения** — автоконвертация презентаций
- ✅ **Трейлеры** — автогенерация ~10-сек превью для видеофайлов
- ✅ **Drag & Drop загрузка** — поддержка файлов до 5GB
- ✅ **MIME-валидация** — проверка типов файлов через `file-type`
- ✅ **Кириллица** — транслитерация имён файлов при загрузке

### Стриминг
- ✅ **HLS live streaming** — стриминг через ffmpeg → .m3u8 + .ts сегменты
- ✅ **DASH поддержка** — .mpd потоки
- ✅ **Автотранскодинг** — для несовместимых кодеков
- ✅ **Дедупликация стримов** — один стрим для нескольких устройств
- ✅ **Circuit Breaker** — защита от падений источников
- ✅ **Мониторинг стримов** — health check каждые 10s

### Ночная оптимизация
- ✅ **Автооптимизация видео** — транскодинг, ремукс, faststart
- ✅ **Профили кодирования** — 720p/1080p/2160p с настраиваемыми параметрами
- ✅ **Управление ресурсами** — CPU/memory бюджетирование
- ✅ **Отменяемые задачи** — пользователь может отменить обработку

### Безопасность и мониторинг
- ✅ **Rate Limiting** — защита от brute-force (пропуск для локальных IP)
- ✅ **CSRF защита**
- ✅ **Audit Log** — полный журнал действий с retry-логикой
- ✅ **Circuit Breaker** — защита БД, файловой системы и внешних API
- ✅ **Система уведомлений** — критические/предупреждения/инфо
- ✅ **Мониторинг системы** — диск, БД, память, ffmpeg процессы

### Реальное время
- ✅ **Socket.IO** — управление устройствами в реальном времени
- ✅ **Server-side плейлисты** — автолупинг папок без участия клиента
- ✅ **Тёмная/светлая тема** — переключение во всех панелях
- ✅ **PWA** — прогрессивные веб-приложения для мобильных панелей
- ✅ **Адаптивный дизайн** — поддержка планшетов

### Клиенты
- ✅ **Android TV** — ExoPlayer, автозапуск, watchdog, wake lock
- ✅ **MPV Player (Linux)** — нативный плеер с аппаратным ускорением
- ✅ **Browser** — веб-плеер через Video.js
- ✅ **ADB автоустановка** — удалённая установка APK через WiFi

### Прочее
- ✅ **Graceful Shutdown** — корректное завершение с очисткой ресурсов
- ✅ **Winston Logging** — структурированные логи с ротацией
- ✅ **Health Check** — мониторинг состояния
- ✅ **Metrics** — метрики запросов, БД, Socket.IO, перцентили
- ✅ **yt-dlp** — автозагрузка бинарника для работы с видео
- ✅ **Self-update** — обновление из git с проверкой fast-forward
- ✅ **Error Pages** — кастомные 403, 404, maintenance страницы

---

## 📦 Структура проекта

```
mmrc/
├── server.js                    # Точка входа
├── package.json                 # Зависимости
├── .env.example                 # Пример конфигурации
├── dev/                         # Документация
├── src/                         # Backend код
│   ├── auth/                    # Аутентификация (JWT + LDAP)
│   │   ├── auth-router.js       # Роуты авторизации
│   │   ├── auth-middleware.js   # Middleware авторизации
│   │   ├── ldap-auth.js         # LDAP интеграция
│   │   └── rate-limiter.js      # Rate limiting
│   ├── config/                  # Управление настройками
│   │   ├── settings-manager.js  # Менеджер настроек
│   │   └── app-settings.json    # Runtime настройки
│   ├── converters/              # Конвертация файлов
│   │   ├── pdf-converter.js     # PDF → изображения
│   │   └── pptx-converter.js    # PPTX → изображения
│   ├── database/                # База данных
│   │   ├── db.js                # Подключение к SQLite
│   │   ├── init.sql             # Схема БД
│   │   ├── migrations/          # Файловые миграции
│   │   └── queries/             # SQL запросы
│   ├── hero/                    # Модуль героев (изолированный)
│   │   ├── routes/              # API роуты
│   │   └── database/            # Отдельная БД героев
│   ├── middleware/               # Express middleware
│   │   ├── auth-middleware.js   # Проверка JWT
│   │   ├── audit-middleware.js  # Аудит запросов
│   │   ├── csrf.js              # CSRF защита
│   │   └── timeout.js           # Request timeout
│   ├── routes/                  # API эндпоинты
│   │   ├── auth-router.js       # Авторизация
│   │   ├── devices-router.js    # Управление устройствами
│   │   ├── files-router.js      # Управление файлами
│   │   ├── streams-router.js    # Стримы
│   │   ├── users-router.js      # Пользователи
│   │   ├── hero-router.js       # Hero модуль
│   │   ├── settings-router.js   # Настройки
│   │   ├── metrics-router.js    # Метрики
│   │   └── file-resolver.js     # Разрешение файлов
│   ├── socket/                  # Socket.IO
│   │   ├── connection-manager.js# Управление соединениями
│   │   ├── device-handlers.js   # Обработчики устройств
│   │   ├── control-handlers.js  # Управление воспроизведением
│   │   └── notifications.js     # Уведомления
│   ├── storage/                 # Хранилище
│   │   └── storage-manager.js   # Управление контентом
│   ├── streams/                 # Стриминг
│   │   └── stream-manager.js    # HLS/DASH стримы
│   ├── utils/                   # Утилиты
│   │   ├── file-metadata-processor.js  # Обработка метаданных
│   │   ├── mp4-faststart.js     # Faststart для MP4
│   │   ├── trailer-generator.js # Генерация трейлеров
│   │   ├── resolution-cache.js  # Кэш разрешений
│   │   ├── transliterate.js     # Транслитерация кириллицы
│   │   ├── path-validator.js    # Валидация путей
│   │   ├── encoding.js          # Исправление кодировки
│   │   ├── retry.js             # Retry утилита
│   │   └── circuit-breaker.js   # Circuit breaker
│   └── video/                   # Видео обработка
│       ├── optimizer.js         # Ночная оптимизация
│       └── job-resource-manager.js  # Управление ресурсами
├── public/                      # Frontend
│   ├── admin.html               # Админ-панель
│   ├── speaker.html             # Спикер-панель
│   ├── index.html               # Страница входа
│   ├── player-videojs.html      # Video.js плеер
│   ├── hero/                    # Hero модуль frontend
│   ├── js/                      # JavaScript модули
│   ├── css/                     # Стили
│   └── vendor/                  # Сторонние библиотеки
├── config/                      # Конфигурация
│   ├── main.db                  # Основная БД
│   ├── hero/heroes.db           # БД героев
│   ├── app-settings.json        # Настройки приложения
│   └── video-optimization.json  # Профили оптимизации
├── scripts/                     # Системные скрипты
├── clients/                     # Клиентские приложения
│   ├── android-mediaplayer/     # Android клиент
│   └── mpv/                     # MPV клиент (Python)
└── nginx/                       # Nginx конфигурация
```

---

## 🔧 Требования

- **Node.js** 20.x+
- **FFmpeg** + **FFprobe**
- **LibreOffice** (для PDF/PPTX)
- **SQLite3**
- **yt-dlp** (опционально, загружается автоматически)

---

## 🔐 Безопасность

После установки:
1. **Измените пароль администратора** (по умолчанию: `admin / admin123`)
2. **Настройте JWT_SECRET** в `.env` файле (генерируется автоматически при установке)
3. **Настройте LDAP** (опционально, для корпоративной аутентификации)
4. **Настройте файрвол** (используйте только Nginx)
5. **Настройте SSL/TLS** (через Nginx)
6. **Проверьте права доступа** на `.env` файл (должен быть `600`)

**Переменные окружения в `.env`:**
- `JWT_SECRET` — секретный ключ для JWT токенов (обязательно)
- `LDAP_URL`, `LDAP_BIND_DN`, `LDAP_SEARCH_BASE` — LDAP настройки
- `PORT` — порт сервера (по умолчанию: 3000)
- `HOST` — хост сервера (по умолчанию: 127.0.0.1)
- `LOG_LEVEL` — уровень логирования (info, warn, error, debug)
- `SILENT_CONSOLE` — отключить вывод в консоль (false/true)
- `NIGHT_OPT_START_HOUR`, `NIGHT_OPT_END_HOUR` — часы ночной оптимизации
- `CONTENT_ROOT` — путь к корню контента
- `STREAM_*` — настройки стриминга
- `VIDEO_OPT_*` — настройки оптимизации видео
- `JOB_RESERVE_CPU_PERCENT`, `JOB_RESERVE_MEMORY_MB` — бюджет ресурсов
- `WAL_CHECKPOINT_INTERVAL_MS` — интервал checkpoint для SQLite WAL
- И другие настройки (см. `.env.example`)

---

## 📱 Клиенты

- **Android TV / Media Player** — APK в `clients/android-mediaplayer/`
- **MPV Player (Linux)** — нативный медиаплеер (`clients/mpv/`)
- **Browser** — веб-плеер через Video.js

---

## 🔄 Обновление

```bash
cd /var/lib/mmrc
sudo systemctl stop videocontrol
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

**Важно:** После обновления проверьте, что `.env` файл содержит все необходимые переменные. Новые переменные могут быть добавлены в `.env.example`.

---

## 📄 Лицензия

Используется кастомная лицензия: только личное (персональное) использование физическими лицами.

- Использование юридическими лицами, ИП, госорганизациями и любыми организациями запрещено без письменного разрешения правообладателя.
- Полный текст: [LICENSE](../LICENSE)

---

## 👤 Автор

**ya-k0v** - [GitHub](https://github.com/ya-k0v/MMRC)

**Версия:** 3.2.1

---

## 📞 Поддержка

- GitHub: https://github.com/ya-k0v/MMRC
- Issues: https://github.com/ya-k0v/MMRC/issues
