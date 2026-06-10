# MMRC 3.3.0 — Media Management and Remote Control

**Система управления медиаконтентом для цифровых дисплеев**

![Version](https://img.shields.io/badge/version-3.3.0-blue)
![Node](https://img.shields.io/badge/node-20.x-green)
![License](https://img.shields.io/badge/license-Personal_Use_Only-red)

Единый Docker-контейнер (API + Nginx + FFmpeg + все воркеры), запускается одной командой. Опционально PostgreSQL вместо SQLite.

---

## Быстрая установка (Production)

Для production-серверов используйте one-command установку:

```bash
sudo curl -fsSL https://raw.githubusercontent.com/ya-k0v/MMRC/v330/install.sh | bash
```

Скрипт автоматически:
- Установит Docker (если не установлен)
- Скачает `docker-compose.deploy.yml` и `.env.example`
- Сгенерирует `.env` с безопасным JWT_SECRET
- Спросит тип БД (SQLite / PostgreSQL), путь к контенту
- Запустит контейнер (с PostgreSQL если выбрано)
- Установит CLI утилиту `mmrc`

### Управление через CLI

```bash
mmrc status       # Статус сервисов
mmrc logs         # Просмотр логов
mmrc update       # Обновление до последней версии
mmrc backup       # Создание бэкапа (pg_dump для PostgreSQL)
mmrc ssl          # Настройка SSL сертификата
```

---

## Разработка (через Makefile)

`make` в корне репозитория:

```bash
make init          # Создать .env из docker/.env.example
make up            # Запустить mmrc (SQLite)
make up-pg         # Запустить mmrc + PostgreSQL (--profile postgres)
make down          # Остановить
make build         # Собрать образ
make logs          # Логи всех контейнеров
make logs-server   # Логи только mmrc
make shell-server  # sh в контейнере
make health        # Проверка health http://localhost:3000/health
make ps            # Список запущенных контейнеров
make migrate       # Применить миграции БД
make clean         # Удалить всё (контейнеры, volumes, образы)
make clean-data    # Удалить только volumes (ВНИМАНИЕ: удалит все данные!)
```

---

## Архитектура

```
┌──────────────────────────────────────────────────────────┐
│                     Docker Host                            │
│                                                            │
│  ┌─────────────────────────────┐                           │
│  │         mmrc container      │                           │
│  │  ┌───────────────────────┐  │                           │
│  │  │  Nginx (reverse proxy)│  │   :80 (:443 HTTPS)       │
│  │  │  :80 → 127.0.0.1:3000 │  │                           │
│  │  └───────────┬───────────┘  │                           │
│  │              │              │                           │
│  │  ┌───────────▼───────────┐  │                           │
│  │  │  Node.js (Express)    │  │   :3000                   │
│  │  │  • API + Socket.IO    │  │                           │
│  │  │  • FFmpeg обработка   │  │                           │
│  │  │  • yt-dlp загрузка    │  │                           │
│  │  │  • Ночной оптимизатор │  │                           │
│  │  └───────────────────────┘  │                           │
│  └─────────────────────────────┘                           │
│                                                            │
│  ┌──────────────────────┐   ┌──────────────────────┐      │
│  │   Shared Volumes     │   │  PostgreSQL (profile) │      │
│  │   mmrc-data          │   │  postgres:16-alpine   │      │
│  │   mmrc-config        │   │  mmrc-pgdata          │      │
│  │   mmrc-temp          │   └──────────────────────┘      │
│  └──────────────────────┘                                  │
│                                                            │
│  ┌──────────────────────┐                                  │
│  │   mmrc-network       │  bridge                          │
│  └──────────────────────┘                                  │
└──────────────────────────────────────────────────────────┘
```

### Компоненты

| Сервис | Описание | Порты |
|--------|----------|-------|
| `mmrc` | Единый контейнер (API + Nginx + FFmpeg + воркеры) | 80, 443 |
| `postgres` | PostgreSQL 16 (опционально, profile) | 5432 |

---

## Быстрый старт

### 1. Клонирование

```bash
git clone https://github.com/ya-k0v/MMRC.git
cd MMRC
```

### 2. Инициализация

```bash
make init
# или вручную:
cp docker/.env.example .env
# Отредактируйте .env, особенно JWT_SECRET
```

### 3. Запуск

```bash
# С SQLite (по умолчанию)
make up

# С PostgreSQL
make up-pg

# Проверить статус
make ps

# Проверить health
make health
```

### 4. Доступ

- Админ-панель: `http://localhost/admin.html`
- Спикер-панель: `http://localhost/speaker.html`
- Hero модуль: `http://localhost/hero/`
- Health check: `http://localhost/health`

---

## Docker Compose Profiles

| Profile | Описание | Команда |
|---------|----------|---------|
| (default) | Только mmrc | `make up` |
| `postgres` | mmrc + PostgreSQL | `make up-pg` |

---

## Настройка

### Переменные окружения

**Основные:**
```env
NODE_ENV=production
JWT_SECRET=<обязательно_измените>
LOG_LEVEL=info
```

**База данных (SQLite по умолчанию):**
```env
DB_TYPE=sqlite          # sqlite | postgres
DB_HOST=mmrc-postgres   # хост PostgreSQL (используется при DB_TYPE=postgres)
DB_PORT=5432
DB_NAME=mmrc
DB_USER=mmrc
DB_PASSWORD=mmrc
```

**Ресурсы:**
```env
JOB_RESERVE_CPU_PERCENT=30
JOB_RESERVE_MEMORY_MB=2048
```

**LDAP (опционально):**
```env
LDAP_URL=ldap://ad-server:389
LDAP_BIND_DN=CN=svc-mmrc,OU=Services,DC=example,DC=com
LDAP_SEARCH_BASE=OU=Users,DC=example,DC=com
```

---

## Мониторинг

### Логи

```bash
# Все логи
make logs

# Только сервер
make logs-server
```

### Health Check

```bash
make health
# или
curl http://localhost/health
```

### Shell доступ

```bash
make shell-server
```

---

## Бэкапы

### SQLite

```bash
# Бэкап через sqlite3 внутри контейнера
docker compose exec mmrc sqlite3 /app/config/main.db ".backup /app/data/main-backup.db"

# Копирование на хост
docker cp mmrc-config:/app/config/main.db ./main.db.backup
```

### PostgreSQL

```bash
docker compose --profile postgres exec postgres pg_dump -U mmrc mmrc > mmrc-backup.sql
```

### Через mmrc CLI

```bash
mmrc backup
```

---

## Обновление

```bash
# Остановить сервисы
make down

# Обновить код (если из git)
git pull origin main

# Пересобрать образ
make build

# Запустить
make up

# Применить миграции
make migrate
```

---

## SSL/TLS

### 1. Получить сертификаты

```bash
sudo certbot certonly --standalone -d your-domain.com
sudo cp /etc/letsencrypt/live/your-domain.com/fullchain.pem docker/nginx/ssl/
sudo cp /etc/letsencrypt/live/your-domain.com/privkey.pem docker/nginx/ssl/
```

### 2. Включить HTTPS в nginx.conf

Раскомментируйте HTTPS server block в `docker/nginx/nginx.conf`.

### 3. Перезапустить

```bash
make restart
```

---

## Очистка

```bash
# Остановить сервисы
make down

# Удалить всё (контейнеры, volumes, images)
make clean

# Только удалить volumes (ВНИМАНИЕ: удалит все данные!)
make clean-data
```

---

## Решение проблем

### Сервер не запускается

```bash
# Проверить логи
make logs-server

# Проверить права на volumes
docker volume inspect mmrc_mmrc-data
```

### Проблемы с FFmpeg

```bash
docker compose exec mmrc ffmpeg -version
```

### Проблемы с производительностью

```bash
# Проверить ресурсы контейнера
docker stats

# Увеличить лимиты в .env
JOB_RESERVE_CPU_PERCENT=50
JOB_RESERVE_MEMORY_MB=4096
```

### Нет места на диске

```bash
# Очистить неиспользуемые Docker объекты
docker system prune -a --volumes

# Очистить кэш трейлеров
docker compose exec mmrc find /app/data/cache/trailers -type f -mtime +7 -delete
```

---

## Структура volumes

```
mmrc-data:/app/data
├── db/                # База данных SQLite
│   ├── main.db
│   └── heroes.db
├── content/           # Медиафайлы устройств
│   ├── DEVICE001/
│   └── DEVICE002/
├── streams/           # HLS/DASH стримы
├── cache/
│   ├── trailers/      # Кэш трейлеров
│   └── converted/     # PDF/PPTX → изображения
└── logs/              # Логи приложения

mmrc-config:/app/config
├── app-settings.json  # Настройки
├── video-optimization.json
└── hero/
    └── heroes.db      # БД героев

mmrc-pgdata:/var/lib/postgresql/data  # (только с profile postgres)
```

---

## Основные возможности

### Управление контентом
- **SQLite / PostgreSQL** — выбор БД при установке
- **MD5 Deduplication** — экономия места на диске (частичный MD5 для файлов >100MB)
- **FFmpeg** — автооптимизация видео, ночной оптимизатор и HLS/DASH стриминг
- **PDF/PPTX → изображения** — автоконвертация презентаций
- **Трейлеры** — автогенерация ~10-сек превью для видеофайлов
- **Drag & Drop загрузка** — поддержка файлов до 5GB
- **MIME-валидация** — проверка типов файлов через `file-type`
- **Кириллица** — транслитерация имён файлов при загрузке

### Стриминг
- **HLS live streaming** — стриминг через ffmpeg → .m3u8 + .ts сегменты
- **DASH поддержка** — .mpd потоки
- **Автотранскодинг** — для несовместимых кодеков
- **Дедупликация стримов** — один стрим для нескольких устройств
- **Circuit Breaker** — защита от падений источников
- **Мониторинг стримов** — health check каждые 10s

### Ночная оптимизация
- **Автооптимизация видео** — транскодинг, ремукс, faststart
- **Профили кодирования** — 720p/1080p/2160p с настраиваемыми параметрами
- **Управление ресурсами** — CPU/memory бюджетирование
- **Отменяемые задачи** — пользователь может отменить обработку

### Аутентификация и безопасность
- **JWT Auth** — безопасная аутентификация с refresh tokens
- **LDAP/Active Directory** — корпоративная аутентификация
- **Rate Limiting** — защита от brute-force (пропуск для локальных IP)
- **CSRF защита**
- **Audit Log** — полный журнал действий с retry-логикой
- **Circuit Breaker** — защита БД, файловой системы и внешних API

### Реальное время
- **Socket.IO** — управление устройствами в реальном времени
- **Server-side плейлисты** — автолупинг папок без участия клиента
- **Система уведомлений** — критические/предупреждения/инфо
- **Мониторинг системы** — диск, БД, память, ffmpeg процессы

### Интерфейсы
- **Админ-панель** — полное управление (устройства, файлы, пользователи, стримы)
- **Спикер-панель** — управление воспроизведением в реальном времени
- **Hero Module** — картотека героев с отдельной БД
- **Тёмная/светлая тема** — переключение во всех панелях
- **PWA** — прогрессивные веб-приложения для мобильных панелей
- **Адаптивный дизайн** — поддержка планшетов

### Клиенты
- **Android TV** — ExoPlayer, автозапуск, watchdog, wake lock
- **MPV Player (Linux)** — нативный плеер с аппаратным ускорением
- **Browser** — веб-плеер через Video.js
- **ADB автоустановка** — удалённая установка APK через WiFi

---

## Интеграция с CI/CD

### GitHub Actions

При пуше в ветку `v330` или `main` автоматически запускается workflow `.github/workflows/docker-build.yml`:

1. Собирается Docker-образ
2. Пушится в Docker Hub как `pingwin1900/mmrc:latest` (main) или `pingwin1900/mmrc:<branch>`
3. Отправляется уведомление в Discord (если настроен webhook)

### Ручной запуск

```bash
gh workflow run docker-build.yml
```

### Обновление на сервере

После получения уведомления об обновлении:

```bash
mmrc update
```

Или вручную:

```bash
cd /opt/mmrc
docker compose -f docker-compose.deploy.yml pull
docker compose -f docker-compose.deploy.yml up -d
```

---

## Документация

- [`docker/README.md`](docker/README.md) — Docker deployment (полная версия)
- [`dev/README.md`](dev/README.md) — полное описание проекта, архитектура и возможности
- [`dev/INSTALL.md`](dev/INSTALL.md) — подробная инструкция по установке на новую ОС
- [`dev/COMMANDS.md`](dev/COMMANDS.md) — шпаргалка по командам для управления и обслуживания
- [`dev/CLIENTS.md`](dev/CLIENTS.md) — установка и настройка клиентов (Android, MPV, браузер)
- [`dev/GITHUB_ACTIONS_CICD.md`](dev/GITHUB_ACTIONS_CICD.md) — полный CI/CD для GitHub Actions
- [`dev/ADMIN_PANEL_README.md`](dev/ADMIN_PANEL_README.md) — описание работы админ-панели
- [`dev/SPEAKER_PANEL_README.md`](dev/SPEAKER_PANEL_README.md) — описание работы спикер-панели
- [`dev/HERO_README.md`](dev/HERO_README.md) — описание работы панели героев

---

## Требования

- **Docker** (для контейнерного запуска)
- **Node.js** 20.x+ (для разработки без Docker)
- **FFmpeg** + **FFprobe** (для разработки без Docker)

---

## Безопасность

После установки:
1. **Измените пароль администратора** (по умолчанию: `admin / admin123`)
2. **Настройте JWT_SECRET** в `.env` файле
3. **Настройте LDAP** (опционально, для корпоративной аутентификации)
4. **Настройте SSL/TLS** (через Nginx)

---

## Клиенты

- **Android TV / Media Player** — APK в `clients/android-mediaplayer/`
- **MPV Player (Linux)** — нативный медиаплеер (`clients/mpv/`)
- **Browser** — веб-плеер через Video.js

---

## Лицензия

Используется кастомная лицензия: только личное (персональное) использование физическими лицами.

- Использование юридическими лицами, ИП, госорганизациями и любыми организациями запрещено без письменного разрешения правообладателя.
- Полный текст: [LICENSE](LICENSE)

---

## Автор

**ya-k0v** — [GitHub](https://github.com/ya-k0v/)

**Версия:** 3.3.0
