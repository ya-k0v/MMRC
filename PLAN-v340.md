# v340 Sprint: Architecture Stability & Horizontal Scaling

## Goal
Превратить MMRC из монолита в архитектуру, готовую к нагрузке, отказам и горизонтальному масштабированию.

## Status: DONE ✅ (кроме Phase 4-6 — перенесены в следующий спринт)

---

### Phase 0 — Centralised version.json
Все версии и теги — в одном файле.

| № | Задача | Статус |
|---|--------|--------|
| 0.1 | Создать `version.json` | ✅ |
| 0.2 | `package.json` → читает `version` из `version.json` | ✅ |
| 0.3 | Dockerfile → `LABEL version=...` + build ARG | ✅ |
| 0.4 | `src/utils/docker-update-manager.js` → импорт `version.json` | ✅ |
| 0.5 | `src/utils/update-manager.js` → импорт `version.json` | ✅ |
| 0.6 | `src/utils/docker-ffmpeg.js` → `DOCKER_IMAGE_TAG` из `version.json` | ✅ |
| 0.7 | `src/converters/document-converter.js` → `DOCKER_IMAGE_TAG` из `version.json` | ✅ |
| 0.8 | `public/js/player-videojs.js` → сервер отдаёт версию через API/env | ✅ |
| 0.9 | `install.sh` → `MMRC_BRANCH` и `MMRC_RAW` из `version.json` через `curl` | ✅ |
| 0.10 | `mmrc.sh` → `MMRC_BRANCH` и `DOCKER_IMAGE_TAG` из `version.json` | ✅ |

---

### Phase 1 — Graceful shutdown + Healthcheck + Timeout
Базовая устойчивость без инфраструктурных изменений.

| № | Задача | Статус |
|---|--------|--------|
| 1.1 | Graceful shutdown | ✅ Done |
| 1.2 | Deep healthcheck (`/health` проверяет БД, диск, uptime) | ✅ Done |
| 1.3 | Timeout на внешние вызовы (30s) | ✅ Done |
| 1.4 | Retry с exponential backoff | ✅ Done |
| 1.5 | Circuit breaker wrapper | ✅ Done |

---

### Phase 2 — Redis + Bull (очередь задач)
Разгружаем event loop — ffmpeg-оптимизация уходит в фоновые воркеры.

| № | Задача | Статус |
|---|--------|--------|
| 2.1 | Redis контейнер в `docker-compose.yml` | ✅ |
| 2.2 | Bull queue setup (video-optimize, stream, converter) | ✅ |
| 2.3 | Вынести `autoOptimizeVideo` в очередь | ✅ |
| 2.4 | Status via Redis pub/sub | ✅ |
| 2.5 | Bull Board (UI) | ✅ (bull-board v8.0.0) |
| 2.6 | Redis adapter для socket.io | ✅ |

---

### Phase 3 — Отдельный стриминг
Выносим ffmpeg-стримы из основного процесса в изолированные контейнеры.

| № | Задача | Статус |
|---|--------|--------|
| 3.1 | `mmrc-streamer` образ | ✅ |
| 3.2 | Stream manager в mmrc | ✅ |
| 3.3 | Graceful stream shutdown | ✅ |

---

## Исправлено в процессе v340

- **Server hang on startup** — bullBoardRouter TDZ (let объявлен позже места использования)
- **bullAdapter import** — `@bull-board/api@8.0.0` экспортирует `./bullAdapter` (без `.js`)
- **Health endpoint crash** — `DEFAULT_DATA_DIR` undeclared → `getDataRoot()`
- **Streamer healthcheck YAML** — `{` `}` `?` в curly-скобках не парсились в flow sequence → block scalar
- **install.sh URL bug** — `MMRC_BRANCH` был пустым → URL `.../MMRC//docker-compose.deploy.yml` → GitHub возвращает `400: Invalid request` (20 байт) → YAML парсер читает `400:` как числовой ключ
- **Redis not starting** — `profiles: [redis]` никогда не активировался в install.sh → Bull очереди не могли подключиться (ETIMEDOUT)

## Что НЕ вошло в v340 (перенесено)

- Phase 4 — S3/MinIO (следующий спринт)
- Phase 5 — HA: Nginx LB + реплики (следующий спринт)
- Phase 6 — Sharp migration (следующий спринт)
