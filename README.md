# MMRC 3.4.0 — Digital Signage & Media Management Platform

**Управление медиаконтентом для цифровых дисплеев, TV-панелей и киосков.**

![Version](https://img.shields.io/badge/version-3.4.0-blue)
![Node](https://img.shields.io/badge/node-22.x-green)
![License](https://img.shields.io/badge/license-Personal_Use_Only-red)

MMRC — централизованная платформа для управления медиаконтентом на удалённых устройствах (Android TV, Linux, браузеры). Загружайте видео, изображения, PDF, PPTX — стройте плейлисты, стримите в реальном времени, управляйте с любого устройства через веб-панели.

---

## Ключевые возможности

- **Единый контейнер** — один `docker compose up` поднимает всё: API, Nginx, FFmpeg, воркеры
- **Content Hub** — спикер-панель для управления воспроизведением в реальном времени через Socket.IO
- **Умное превью** — превью в спикер-панели показывает то же, что и на экране устройства, без трейлеров
- **HLS / DASH streaming** — live-стриминг с автотранскодингом, circuit breaker, дедупликация потоков
- **Плейлисты** — серверные плейлисты для папок с автолупингом, без участия клиента
- **PDF / PPTX → изображения** — Ghostscript + Sharp, высокое качество, кэширование
- **Ночная оптимизация** — фоновый транскодинг видео с управлением ресурсами CPU/RAM
- **PostgreSQL / SQLite** — выбор БД при установке
- **High Availability** — nginx LB, N реплик, S3-совместимое хранилище (MinIO), PostgreSQL
- **S3 Storage** — MinIO как backend для медиафайлов (опционально, для HA)
- **LDAP / AD** — корпоративная аутентификация
- **Многопользовательский режим** — каждый пользователь видит только свои устройства и контент
- **PWA** — мобильные панели как прогрессивные веб-приложения
- **Тёмная / светлая тема** — переключение во всех интерфейсах
- **Analytics dashboard** — интерактивная flow map, per-container метрики, мониторинг системы
- **CLI** — `mmrc status|logs|update|backup|ssl|ha setup|scale|remove`

---

## Быстрая установка

```bash
curl -fsSL https://raw.githubusercontent.com/ya-k0v/MMRC/v340/install.sh | sudo bash
```

Скрипт автоматически установит Docker, скачает compose-файлы, сгенерирует `.env`, запустит контейнер и установит CLI.

### Управление

```bash
mmrc status       # Статус сервисов
mmrc logs         # Просмотр логов
mmrc update       # Обновление
mmrc backup       # Бэкап БД
mmrc ssl          # SSL сертификат
mmrc ha setup     # Развернуть HA кластер
```

---

## Разработка

```bash
make init          # Создать .env
make up            # Запустить (SQLite)
make up-pg         # Запустить + PostgreSQL
make build         # Собрать образ
make down          # Остановить
make logs          # Логи всех контейнеров
make migrate       # Применить миграции
make health        # curl http://localhost/health
make shell-server  # sh в контейнере
```

---

## Архитектура

```
┌──────────────────────────────────────────────────────────┐
│                      Docker Host                           │
│                                                             │
│  ┌─────────────────────────────────────┐                    │
│  │           mmrc container            │                    │
│  │  ┌──────────┐  ┌──────────────────┐ │  :80/443          │
│  │  │  Nginx    │→│  Node.js (Express)│ │                    │
│  │  │  proxy    │  │  • API + Socket  │ │                    │
│  │  └──────────┘  │  • FFmpeg         │ │                    │
│  │                │  • Bull queues    │ │                    │
│  │                │  • yt-dlp         │ │                    │
│  │                │  • Ghostscript    │ │                    │
│  │                │  • Sharp          │ │                    │
│  │                │  • Night optimizer│ │                    │
│  │                └──────────────────┘ │                    │
│  └─────────────────────────────────────┘                    │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  mmrc-stream │  │  PostgreSQL  │  │  Redis 7     │      │
│  │  FFmpeg:3001 │  │  (profile)   │  │  (profile)   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                             │
│  ┌──────────────────────────────────────────────────┐       │
│  │  Volumes: mmrc-data, mmrc-config, mmrc-temp       │       │
│  │  mmrc-pgdata (profile), mmrc-redis (profile)      │       │
│  └──────────────────────────────────────────────────┘       │
│                                                             │
│  ┌──────────────────────────────────────────────────┐       │
│  │  Optional HA: MinIO (S3) + nginx LB + N replicas │       │
│  └──────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────┘
```

### Компоненты

| Профиль | Сервис | Описание | Порты |
|---------|--------|----------|-------|
| default | `mmrc` | API + Nginx + FFmpeg + воркеры | 80, 443 |
| streamer | `streamer` | Выносной FFmpeg | 3001 |
| postgres | `postgres` | PostgreSQL 16 | 5432 |
| redis | `redis` | Redis 7 | 6379 |
| ha | `minio` | S3-совместимое хранилище | 9000, 9001 |
| ha | `nginx-ha` | Load balancer | 80, 443 |

---

## Интерфейсы

| Панель | URL | Назначение |
|--------|-----|------------|
| Admin | `/admin.html` | Управление устройствами, файлами, пользователями, стримами |
| Speaker | `/speaker.html` | Управление воспроизведением в реальном времени |
| Hero | `/hero/` | Картотека героев с отдельной БД |
| Analytics | `/analytics/` | Flow map, метрики, мониторинг |
| Health | `/health` | Health check API |

---

## Клиенты

- **Android TV** — ExoPlayer, автозапуск, watchdog, wake lock
- **MPV Player (Linux)** — нативный плеер с аппаратным ускорением
- **Browser** — веб-плеер через Video.js (HLS, DASH, MP4)
- **ADB автоустановка** — удалённая установка APK через WiFi

---

## Безопасность

- JWT аутентификация с refresh tokens
- LDAP / Active Directory интеграция
- Rate limiting (локальные IP не лимитируются)
- CSRF защита
- Audit log с retry-логикой
- Circuit Breaker для БД, ФС, внешних API
- MIME-валидация загружаемых файлов

---

## Требования

- **Docker** (рекомендуется)
- **Node.js** 20.x+ (для разработки без Docker)
- **FFmpeg** + **FFprobe** (для разработки без Docker)

---

## Лицензия

Кастомная: только личное использование физическими лицами.
Юридические лица, ИП, госорганизации — запрещено без письменного разрешения.

---

**Автор:** [ya-k0v](https://github.com/ya-k0v/) · Версия 3.4.0
