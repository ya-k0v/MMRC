# MMRC 3.4.0

Digital Signage & Media Management Platform

![Version](https://img.shields.io/badge/version-3.4.0-blue)
![Node](https://img.shields.io/badge/node-22.x-green)

## Описание

Централизованная платформа для управления медиаконтентом на удалённых устройствах (Android TV, Linux, браузеры). Видео, изображения, PDF, PPTX — плейлисты, стриминг, управление через веб-панели.

## Возможности

- **Docker** — один `docker compose up` поднимает всё
- **Streaming** — HLS/DASH live-стриминг с автотранскодингом
- **Плейлисты** — серверные, автолупинг
- **Конвертация** — PDF/PPTX → изображения (Ghostscript + Sharp)
- **Ночная оптимизация** — фоновый транскодинг видео
- **БД** — PostgreSQL или SQLite
- **HA** — nginx LB, N реплик, S3 (MinIO)
- **LDAP/AD** — корпоративная аутентификация
- **PWA** — мобильные панели

## Установка

```bash
curl -fsSL https://raw.githubusercontent.com/ya-k0v/MMRC/v340/install.sh | sudo bash
```

## Управление

```bash
mmrc status       # Статус сервисов
mmrc logs         # Логи
mmrc update       # Обновление
mmrc backup       # Бэкап БД
mmrc ssl          # SSL сертификат
```

## Разработка

```bash
make init          # Создать .env
make up            # Запустить (SQLite)
make up-pg         # Запустить + PostgreSQL
make build         # Собрать образ
make down          # Остановить
make logs          # Логи
```

## Архитектура

```
┌─────────────────────────────────────────┐
│              Docker Host                 │
│                                          │
│  ┌──────────────────────────────────┐   │
│  │         mmrc container           │   │
│  │  Nginx → Node.js (Express)       │   │
│  │  • API + Socket.IO               │   │
│  │  • FFmpeg + yt-dlp               │   │
│  │  • Bull queues                   │   │
│  └──────────────────────────────────┘   │
│                                          │
│  ┌────────────┐ ┌────────────┐          │
│  │ streamer   │ │ PostgreSQL │          │
│  │ FFmpeg:3001│ │ (profile)  │          │
│  └────────────┘ └────────────┘          │
└─────────────────────────────────────────┘
```

## Сервисы

| Сервис | Описание | Порт |
|--------|----------|------|
| `mmrc` | API + Nginx + FFmpeg | 80, 443 |
| `streamer` | Выносной FFmpeg | 3001 |
| `postgres` | PostgreSQL 16 | 5432 |
| `redis` | Redis 7 | 6379 |

## Панели

| Панель | URL | Назначение |
|--------|-----|------------|
| Admin | `/admin.html` | Устройства, файлы, пользователи |
| Speaker | `/speaker.html` | Управление воспроизведением |
| Analytics | `/analytics.html` | Метрики, мониторинг |

## Клиенты

- **Android TV** — ExoPlayer, автозапуск, watchdog
- **MPV Player** — Linux, аппаратное ускорение
- **Browser** — Video.js (HLS, DASH, MP4)

## Требования

- Docker
- Node.js 22+ (для разработки)

## Лицензия

Только личное использование. Юридические лица — запрещено без разрешения.

---

**Автор:** [ya-k0v](https://github.com/ya-k0v/)
