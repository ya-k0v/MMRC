# v340 Sprint: Architecture Stability & Horizontal Scaling

## Goal
Превратить MMRC из монолита в архитектуру, готовую к нагрузке, отказам и горизонтальному масштабированию.

## Результат: ✅ Phases 0-3 готовы

---

### Phase 0 — Centralised version.json ✅
Все версии и теги — в одном файле `version.json`.

### Phase 1 — Graceful shutdown + Healthcheck + Timeout ✅
SIGTERM → server.close → queue.close → db.close. `/health` проверяет БД, диск, uptime. Retry, circuit breaker, таймауты на внешние вызовы.

### Phase 2 — Redis + Bull (очередь задач) ✅
Bull queues: video-optimize, stream, converter. Redis container, Bull Board UI, Redis adapter для socket.io.

### Phase 3 — Отдельный стриминг ✅
`mmrc-streamer` образ, stream manager, graceful stream shutdown.

---

## Исправлено в v340
- Server hang on startup — bullBoardRouter TDZ
- bullAdapter import — `@bull-board/api@8.0.0` экспортирует `./bullAdapter`
- Health endpoint crash — `DEFAULT_DATA_DIR → getDataRoot()`
- Streamer healthcheck YAML — curly braces → block scalar
- install.sh: `MMRC_BRANCH` fallback + size validation
- Redis не стартовал: `profiles: [redis]` убран

---

## Phase 4 — S3/MinIO (следующий спринт)

**Цель**: Перейти с локальной файловой системы на S3-совместимое хранилище (MinIO).  
**Зачем**: Единое хранилище для всех реплик — необходимо для HA (Phase 5).  
**Сложность**: Высокая — ~20+ файлов с прямыми `fs` операциями.

### Зависимости
- `@aws-sdk/client-s3` для S3 API
- MinIO контейнер в docker-compose

### План

#### 4.1 Storage абстракция
Создать `src/storage/` с классами:

| Файл | Описание |
|------|----------|
| `src/storage/provider.js` | Abstract class `StorageProvider` — контракт: `read(key)`, `write(key, buffer)`, `delete(key)`, `exists(key)`, `list(prefix)`, `copy(src, dest)`, `move(src, dest)`, `stream(key)`, `stat(key)` |
| `src/storage/local.js` | `LocalStorage` — реализация через `node:fs/promises`. Путь: `{dataRoot}/storage/{key}` |
| `src/storage/s3.js` | `S3Storage` — реализация через `@aws-sdk/client-s3`. Поддержка MinIO endpoint. Bucket: конфигурируется |
| `src/storage/factory.js` | Фабрика — по `STORAGE_BACKEND=local|s3` возвращает нужный провайдер |

#### 4.2 Миграция точек входа (server.js)
| № | Что | Файл |
|---|-----|------|
| 4.2.1 | Инициализация storage в `server.js` | `server.js` — вместо прямых `fs.mkdirSync` для data/streams/converted/logs |
| 4.2.2 | Инициализация `StorageProvider` по env | `server.js` — `STORAGE_BACKEND`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` |
| 4.2.3 | Передать провайдер в `app` context | `server.js` — через `req.storage` или import |

#### 4.3 Миграция загрузки файлов
Самый частый паттерн: upload → `fs.writeFileSync` / `fs.renameSync` → сохранение пути в БД.

| № | Файл | Кол-во fs операций |
|---|------|--------------------|
| 4.3.1 | `src/routes/files.js` | ~50 операций (write, unlink, rename, mkdir, chmod) |
| 4.3.2 | `src/routes/files.js` — upload handler | multer → multer-s3 или write через `storage.write()` |
| 4.3.3 | `src/routes/files.js` — delete | `fs.unlinkSync` → `storage.delete()` |

#### 4.4 Миграция стримов (HLS)
| № | Файл | Что менять |
|---|------|------------|
| 4.4.1 | `src/streams/stream-manager.js` | HLS плейлисты и сегменты читаются/пишутся через `storage` |
| 4.4.2 | Stream files | ffmpeg output → HLS segments. Через `storage.stream()` или локальный temp + upload |

#### 4.5 Миграция конвертеров
| № | Файл | Что менять |
|---|------|------------|
| 4.5.1 | `src/converters/document-converter.js` | Временные файлы и результат через `storage` |
| 4.5.2 | `src/converters/folder-converter.js` | Распаковка ZIP → read/write через `storage` |

#### 4.6 Миграция конфигов и БД
| № | Файл | Что менять |
|---|------|------------|
| 4.6.1 | `src/config/settings-manager.js` | `fs.readFileSync/writeFileSync` → `storage.read/write` |
| 4.6.2 | `src/config/constants.js` | `fs.mkdirSync` → storage init |
| 4.6.3 | `src/database/driver/SqliteDriver.js` | SQLite на S3? Лучше PostgreSQL только |
| 4.6.4 | `src/hero/database/hero-db.js` | SQLite для hero — на S3 или migrate to pg |

#### 4.7 Nginx прокси для S3
MinIO обычно на отдельном порту. Nginx может проксировать `/content/` → MinIO bucket.

#### 4.8 .env переменные
Добавить в `.env`:
```
STORAGE_BACKEND=local        # local | s3
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_BUCKET=mmrc
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_FORCE_PATH_STYLE=true
```

#### 4.9 Миграция данных
Скрипт для копирования существующих файлов из локальной FS в S3:
```
mmrc storage:migrate
```

---

## Phase 5 — HA: Nginx LB + N реплик (следующий спринт)

**Цель**: Несколько реплик mmrc за Nginx, отказоустойчивость, горизонтальное масштабирование.  
**Зависимость**: Phase 4 (S3) — без общего хранилища реплики не имеют смысла.  
**Сложность**: Средняя.

### План

#### 5.1 Nginx upstream → несколько реплик
| № | Что | Файл |
|---|-----|------|
| 5.1.1 | upstream с несколькими серверами | `docker/nginx/nginx.conf` |
| 5.1.2 | Health-aware LB | nginx `max_fails=3 fail_timeout=30s` |
| 5.1.3 | Docker Compose `deploy: replicas: 3` | `docker-compose.deploy.yml` mmrc service |

#### 5.2 Session affinity
Socket.IO требует, чтобы клиент подключался к той же реплике, или Redis adapter.

| № | Что | Статус |
|---|-----|--------|
| 5.2.1 | Redis adapter для socket.io | ✅ Уже есть (Phase 2.6) |
| 5.2.2 | Sticky sessions (ip_hash) | `nginx.conf`: `ip_hash;` в upstream |
| 5.2.3 | Express session → Redis | `connect-redis` или аналогично |

#### 5.3 Docker Compose scalable
| № | Что | Файл |
|---|-----|------|
| 5.3.1 | Убрать `container_name` для mmrc (конфликт с репликами) | `docker-compose.deploy.yml` |
| 5.3.2 | `deploy:` секция с replicas | `docker-compose.deploy.yml` |
| 5.3.3 | `ports:` не `80:80`, а `loadbalancer:80:80` | Через nginx service |
| 5.3.4 | healthcheck для nginx | `docker-compose.deploy.yml` |

#### 5.4 Nginx rate limiting (уже есть)
- api: 10r/s, upload: 2r/s, login: 5r/m — **уже настроено** в `docker/nginx/nginx.conf`

#### 5.5 Graceful shutdown для реплик (уже есть ✅)
- SIGTERM → server.close → queue.close → db.close — **уже реализовано** (Phase 1.1)

#### 5.6 Настроить Docker Compose profiles
| Профиль | Что включает |
|---------|-------------|
| `ha` | replicas: 3 + nginx |
| (default) | single instance (текущее поведение) |

#### 5.7 Обновить install.sh
| № | Что |
|---|-----|
| 5.7.1 | HA опция: "Enable HA mode? [y/N]" |
| 5.7.2 | При HA: `--profile ha` |

---

## Phase 6 — Sharp migration ✅

**Фактически已完成**: `sharp` используется вместо ImageMagick/GM ещё до v340.  
Осталось только почистить Dockerfile от мёртвого груза.

### TODO (cleanup, не срочно)
- Убрать `imagemagick` из `apt-get install` в Dockerfile
- Убрать `sed` правку ImageMagick policy (строка 58 Dockerfile)
- Убрать `pdf2pic` — проверить нет ли в `package.json` (скорее всего только в lock)
- Провалидировать, что `convert`, `identify`, `mogrify` нигде не вызываются
