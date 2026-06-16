# v340 Sprint: Architecture Stability & Horizontal Scaling

## Goal
Превратить MMRC из монолита в архитектуру, готовую к нагрузке, отказам и горизонтальному масштабированию.

## Этапы

### Phase 0 — Centralised version.json
Все версии и теги — в одном файле.

| № | Задача | Файлы | Сложность |
|---|--------|-------|-----------|
| 0.1 | Создать `version.json` | `version.json` (root) | низкая |
| 0.2 | `package.json` → читает `version` из `version.json` | `package.json` | низкая |
| 0.3 | Dockerfile → `LABEL version=$(cat version.json | jq .version)` + build ARG | `Dockerfile`, `Dockerfile.ffmpeg`, `Dockerfile.converter` | низкая |
| 0.4 | `src/utils/docker-update-manager.js` → импорт `version.json` | `src/utils/docker-update-manager.js` | низкая |
| 0.5 | `src/utils/update-manager.js` → импорт `version.json` | `src/utils/update-manager.js` | низкая |
| 0.6 | `src/utils/docker-ffmpeg.js` → `DOCKER_IMAGE_TAG` из `version.json` | `src/utils/docker-ffmpeg.js` | низкая |
| 0.7 | `src/converters/document-converter.js` → `DOCKER_IMAGE_TAG` из `version.json` | `src/converters/document-converter.js` | низкая |
| 0.8 | `public/js/player-videojs.js` → сервер отдаёт версию через API/env | `public/js/player-videojs.js` + `server.js` | низкая |
| 0.9 | `install.sh` → `MMRC_BRANCH` и `MMRC_RAW` из `version.json` через `curl` | `install.sh` | низкая |
| 0.10 | `mmrc.sh` → `MMRC_BRANCH` и `DOCKER_IMAGE_TAG` из `version.json` | `mmrc.sh` | низкая |

**Итог Phase 0**: чтобы сменить версию — правишь один файл.

---

### Phase 1 — Graceful shutdown + Healthcheck + Timeout
Базовая устойчивость без инфраструктурных изменений.

| № | Задача | Описание | Сложность |
|---|--------|----------|-----------|
| 1.1 | Graceful shutdown | `SIGTERM` → server.close → queue.close → db.close → exit(0) | низкая |
| 1.2 | Deep healthcheck | `/health` проверяет БД (SELECT 1), диск, uptime | низкая |
| 1.3 | Timeout на внешние вызовы | `Promise.race` с таймаутом для converter/ffmpeg on-demand (30s) | низкая |
| 1.4 | Retry с exponential backoff | При ошибке converter/ffmpeg — повтор через 1s, 2s, 4s, 8s (макс 3) | низкая |
| 1.5 | Circuit breaker wrapper | 5 ошибок подряд → стоп на 60s, потом probe | низкая |

---

### Phase 2 — Redis + Bull (очередь задач)
Разгружаем event loop — ffmpeg-оптимизация уходит в фоновые воркеры.

| № | Задача | Описание | Сложность |
|---|--------|----------|-----------|
| 2.1 | Redis контейнер | Добавить `redis:7-alpine` в `docker-compose.yml` | низкая |
| 2.2 | Bull queue setup | Инициализация `video-optimize`, `stream`, `converter` queues | средняя |
| 2.3 | Вынести `autoOptimizeVideo` в очередь | HTTP → `queue.add()` + respond 202. Worker забирает, оптимизирует, сохраняет | средняя |
| 2.4 | Status via Redis pub/sub | Worker шлёт статус → Redis → socket.io → клиент | средняя |
| 2.5 | Bull Board (UI) | `bull-board` для мониторинга очередей (сколько в очереди, ошибки, retry) | низкая |
| 2.6 | Redis adapter для socket.io | Чтобы события доходили до клиента независимо от реплики | средняя |

---

### Phase 3 — Отдельный стриминг
Выносим ffmpeg-стримы из основного процесса в изолированные контейнеры.

| № | Задача | Описание | Сложность |
|---|--------|----------|-----------|
| 3.1 | `mmrc-streamer` образ | Минимальный контейнер: ffmpeg + Node.js health endpoint | средняя |
| 3.2 | Stream manager в mmrc | Пул стримеров, аллокация по запросу, cleanup по таймауту | высокая |
| 3.3 | Graceful stream shutdown | При падении стримера — клиент переподключается к новому | средняя |

---

### Phase 4 — S3/MinIO вместо локальных томов
Единое хранилище для всех реплик.

| № | Задача | Описание | Сложность |
|---|--------|----------|-----------|
| 4.1 | MinIO контейнер | Добавить в `docker-compose.yml` | низкая |
| 4.2 | Storage abstraction | Слой `StorageProvider` с имплементациями: `LocalStorage` (сейчас) → `S3Storage` | средняя |
| 4.3 | Миграция на S3 | upload, read, delete, stream — через MinIO SDK | высокая |

---

### Phase 5 — HA: Nginx LB + N реплик mmrc
Отказоустойчивость на уровне HTTP.

| № | Задача | Описание | Сложность |
|---|--------|----------|-----------|
| 5.1 | Nginx upstream | `upstream mmrc_web { server mmrc-web-1:3000; server mmrc-web-2:3000; }` | низкая |
| 5.2 | Health-aware LB | Nginx исключает упавшие реплики из upstream | низкая |
| 5.3 | Rate limiting | express-rate-limit + socket.io rate limiter | низкая |
| 5.4 | Docker Compose replicas | `deploy: replicas: 3` для mmrc-web | низкая |

---

### Phase 6 — Sharp migration
Замена gm/ImageMagick/pdf2pic на modern alternativ

| № | Задача | Описание | Сложность |
|---|--------|----------|-----------|
| 6.1 | Установить `sharp` | `npm install sharp` | низкая |
| 6.2 | PDF → PNG через sharp | `sharp(pdfBuffer).png().toFile()` | средняя |
| 6.3 | Определение размеров через sharp | `sharp(image).metadata()` | низкая |
| 6.4 | Resize через sharp | `sharp(image).resize(w, h).toFile()` | низкая |
| 6.5 | Убрать pdf2pic | `npm uninstall pdf2pic` | низкая |
| 6.6 | Обновить Dockerfile | Убрать `graphicsmagick`, `imagemagick`, `ghostscript` (если не нужны) | низкая |

---

## Приоритеты

```
Срочность:
  Phase 0 (version.json)      — сейчас, блокирует всё
  Phase 1 (graceful+timeout)  — сейчас, базовый харденинг
  Phase 2 (Redis+Bull)        — этот спринт
  Phase 6 (sharp)             — этот спринт
  Phase 3 (streamer)          — следующий спринт
  Phase 4 (MinIO)             — следующий спринт
  Phase 5 (HA)                — следующий спринт
```

## Что НЕ входит в plan
- Миграция БД (шардирование, репликация PostgreSQL) — избыточно на данном этапе
- Kubernetes — Docker Compose + systemd достаточно для целевой нагрузки
- CDN для медиа — отдельная история, если пользователи из разных регионов
