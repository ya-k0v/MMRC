# MMRC

Централизованная платформа управления медиаконтентом и цифровыми вывесками (digital signage). Серверное развёртывание через Docker, клиенты — Android TV, Linux (MPV), браузеры.

## Возможности

- **Streaming** — HLS live-стриминг с автотранскодингом (FFmpeg)
- **Плейлисты** — серверные, с автолупингом
- **Конвертация** — PDF/PPTX → изображения (Ghostscript + Sharp)
- **Загрузка видео по URL** — yt-dlp (MP4) + умная оптимизация FFmpeg для совместимости/пережатия
- **Ночная оптимизация** — фоновый транскодинг видео в нерабочие часы
- **Управление устройствами** — удалённая установка APK, запуск/остановка, статус через ADB
- **Многопользовательский доступ** — JWT-аутентификация (access + refresh), роли
- **LDAP/AD** — корпоративная аутентификация
- **Высокая доступность** — Nginx LB, N реплик, PostgreSQL + S3 (MinIO)
- **Хранилище** — локальная ФС или S3 (совместимо с MinIO)
- **Интеграция** — WebSocket (Socket.IO) для реального времени, Bull-очереди задач (при включенном Redis)

## Архитектура

```
┌──────────── Docker Host ────────────┐
│                                     │
│  ┌───── mmrc (API + Nginx) ──────┐  │
│  │  Express API     :3000        │  │
│  │  Nginx           :80/:443     │  │
│  │  Socket.IO       real-time    │  │
│  │  FFmpeg workers  (Bull-ready) │  │
│  └────────────────────────────────┘  │
│                                     │
│  ┌─────────┬─────────┬──────────┐  │
│  │streamer │postgres │  redis   │  │
│  │ :3001   │  :5432  │  :6379   │  │
│  └─────────┴─────────┴──────────┘  │
└─────────────────────────────────────┘
```

Основные модули (`src/`):

| Директория | Назначение |
|-----------|------------|
| `routes/` | REST API: devices, files, folders, admin, auth |
| `streams/` | HLS stream-manager |
| `converters/` | PDF/PPTX → изображения, конвертация папок |
| `queue/` | Bull очереди фоновых задач |
| `socket/` | Socket.IO обработчики (device, player) |
| `storage/` | Абстракция хранилища: локальная ФС / S3 |
| `database/` | SQLite (better-sqlite3) / PostgreSQL (pg) |
| `auth/` | JWT, роли, LDAP |

## Требования

- Docker 24+ (Docker Compose v2)
- Node.js 22+ (для разработки)
- Android TV устройства с ADB (порт 5555)

## Установка

```bash
curl -fsSL https://raw.githubusercontent.com/ya-k0v/MMRC/v340/install.sh | sudo bash
```

Установщик последовательно: проверяет/ставит Docker, ставит CLI `mmrc`, выбирает БД (SQLite/PostgreSQL), хранилище (local/S3), порты 80/443, запускает сервисы и настраивает SSL.

## CLI

```bash
mmrc status          # Статус сервисов
mmrc logs            # Логи
mmrc update          # Обновление до последней версии
mmrc backup          # Бэкап БД
mmrc ssl             # SSL-сертификат (self-signed / Let's Encrypt / свой)
mmrc stop            # Остановить сервисы
mmrc start           # Запустить сервисы
```

## Разработка

```bash
make init            # Создать .env из .env.example
make up              # Запуск (SQLite, local storage)
make up-pg           # Запуск + PostgreSQL
make build           # Сборка Docker-образа
make down            # Остановка
make logs            # Логи
```

Конфигурация — `.env` (см. `.env.example`). Ключевые переменные: `DB_TYPE`, `STORAGE_BACKEND`, `PORT`, `JWT_SECRET`.

## Сервисы

| Сервис | Описание | Порт |
|--------|----------|------|
| `mmrc` | API + Nginx + FFmpeg | 80, 443 |
| `streamer` | Выносной FFmpeg | 3001 |
| `postgres` | PostgreSQL 16 (profile) | 5432 |
| `redis` | Redis 7 | 6379 |
| `minio` | S3 (profile) | 9000, 9001 |

## Панели

| Панель | URL |
|--------|-----|
| Admin | `/admin.html` |
| Speaker | `/speaker.html` |
| Analytics | `/analytics.html` |

## Клиенты

| Клиент | Платформа | Стек |
|--------|-----------|------|
| Android TV | Android | ExoPlayer, автозапуск, watchdog |
| MPV Player | Linux | аппаратное ускорение |
| Browser | Web | Video.js (HLS, DASH, MP4), PWA |

## Диагностика

- [ADB.md](ADB.md) — Android TV
- [DOCKER.md](DOCKER.md) — Docker/Compose
- [DEBUG.md](DEBUG.md) — логи, ошибки

## Безопасность

### docker.sock: известный и принятый риск

В `docker-compose.yml` и `docker-compose.deploy.yml` в контейнер монтируется
`/var/run/docker.sock`. Процесс при этом работает от root, поэтому компрометация
приложения даёт **root-доступ к Docker-демону на хосте**, а через него — к любой
службе хоста.

Сокет оставлен намеренно. Без него перестают работать ровно две функции:

- **self-update из админки** — `docker pull` / `docker rm` / `docker compose`
  (`src/utils/docker-update-manager.js`);
- **конвертация PPTX → PDF** — стоит `MMRC_DOCKER=1`, а `soffice` в образ не
  входит, поэтому единственный рабочий путь идёт через docker-контейнер
  (`src/converters/document-converter.js:319`).

Чтобы сокет убрать: удалите строку `- /var/run/docker.sock:/var/run/docker.sock`
из обоих compose-файлов и уберите `INCLUDE_DOCKER_CLI` из `build.args` — тогда
CLI в образе тоже не будет установлен. Аналитика (`docker stats`, логи HA-nginx)
завёрнута в `try/catch` и без сокета просто станет пустой, а не упадёт.
Обновления после этого придётся делать на хосте через `install.sh`.

Внутри контейнера включён `security_opt: [no-new-privileges:true]` — он запрещает
повышать привилегии через setuid/setcap-бинарники; nginx, tini и docker CLI этого
не требуют.

### JWT_SECRET

`JWT_SECRET` обязателен: значение по умолчанию `change-me-in-production` убрано,
compose-файл откажется ставить сервис без него. Сгенерируйте и положите в `.env`:

```bash
openssl rand -hex 64
```

Также задайте секрет при деплое через `docker-compose.deploy.yml` — он читается
из окружения без значения по умолчанию.

## Лицензия

[Solo use. Commercial use prohibited.](LICENSE)