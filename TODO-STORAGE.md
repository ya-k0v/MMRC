# TODO: надёжность файлового хранилища (local + S3)

Рабочий план по итогам аудита жизненного цикла файлов. Ветка: `v340`.
Правило: после каждого этапа — полный прогон тестов, без `git push`.

## Как проверяем

```bash
npm run test:unit
npm test                 # unit + ci smoke
```

Для точечных прогонов:

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/<file>.test.js --forceExit
```

---

## Этап 0 — P0: не терять файлы и не врать «не найдено»

> **Статус этапа 0:** реализован. Автотесты: `48` suites / `449` tests,
> `npm test` (unit + CI smoke) — PASS. Изменения не запушены.

### 0.1. Три состояния `exists()` и корректный abort в S3

- [x] `StorageProvider.checkExists(key)` → `{ state: 'present'|'missing'|'unknown', error?, stat? }`.
- [x] `S3Storage.checkExists()`:
  - `NotFound` / `NoSuchKey` / HTTP 404 → `missing`;
  - `AccessDenied` / HTTP 403, таймаут, abort, сетевые ошибки, 5xx → `unknown`;
  - `abortSignal` передаётся **вторым аргументом** `client.send(cmd, { abortSignal })`,
    а не полем `abortController` внутри `HeadObjectCommand`.
- [x] `S3Storage.exists()` — fail-safe: `true` для `present` и `unknown`,
  `false` только для доказанного `missing`. Предупреждение в лог для `unknown`.
- [x] `S3Storage.stat()` использует тот же HEAD с таймаутом; `missing` → исключение
  `NotFound`, `unknown` → исходная ошибка.
- [x] `LocalStorage.checkExists()`: `ENOENT` → `missing`, `EACCES`/прочее → `unknown`.
- [x] Проверка после загрузки в `syncFileToStorage()` требует строго `present`;
  `unknown` — ошибка, локальная копия остаётся.
- [x] `materializeToLocal()` качает только при `present`; `unknown` → `null` + лог.
- [x] Дедупликация (`file-metadata-processor.js`, `routes/deduplication.js`) считает
  дубликат подтверждённым только при `present`; `unknown` → не дедуплицировать.
- [x] `updateDeviceFilesFromDB().filePathExists()` — fail-open при `unknown`.
- [x] Тесты: `storage-s3-exists.test.js`, `storage-local-check-exists.test.js`,
  `storage-sync-confirm.test.js`.

### 0.2. Защита очистки от ложных удалений

- [x] `cleanupMissingFiles()` удаляет метаданные только при `missing`;
  `unknown` → счётчик `unknown`, запись остаётся.
- [x] `deleteFileMetadata()` возвращает `true/false`, ошибка БД не выдаётся за успех.
- [x] `countFileReferences()` при ошибке БД возвращает `null`, а не `0`.
- [x] Удаление одного файла: физический объект удаляется только при `refCount === 0`;
  `null` → объект остаётся, в лог пишется предупреждение.
- [x] Тесты: `cleanup-missing-files.test.js` (unknown, ошибка БД, missing).

### 0.3. Скачивание дедуплицированного файла

- [x] В `GET /api/devices/:id/files/:name/download` доверять `metadata.file_path`,
  полученному по `(deviceId, name)`, без требования совпадения `basename`.
  Путь по-прежнему проверяется через `validatePath` под `devicesPath`.
- [x] `validatePath()` сохраняет промежуточные каталоги для ещё не существующего
  пути (раньше `content/<device>/file` схлопывался в `content/file`).
- [x] Тесты: `download-dedup-route.test.js`, `path-validator.test.js`.

### 0.4. ZIP папки, которая есть только в S3

- [x] Вынести архивацию/выгрузку папки в `src/storage/folder-archive.js`.
- [x] `createZipArchiveFromFolder(source, zip, { sourceRoot })` — валидировать
  источник относительно явно переданного корня; для staging в `os.tmpdir()`
  передавать `sourceRoot = tempDir`, а не `getDataRoot()`.
- [x] `downloadFolderFromStorage()` использует `stream.pipeline`, удаляет частичный
  файл при ошибке и возвращает число **файлов**, а не ключей.
- [x] Тест: `folder-archive.test.js` (staging вне `dataRoot`, вложенность,
  защита от `..`).

### 0.5. Коммит видео в S3 на всех путях оптимизатора

- [x] Добавить `.m4v` во все списки видео: auto-optimize после upload,
  метаданные/трейлер, `ALLOWED_EXT`, `VIDEO_EXTENSIONS` в `file-types.js`.
- [x] Оптимизатор коммитит оригинал в S3, если:
  - оптимизация отключена;
  - не удалось прочитать параметры;
  - ffmpeg завершился ошибкой;
  - обработка отменена.
  При успешном коммите локальная копия удаляется; при ошибке — остаётся.
- [x] Тесты: `video-optimizer-commit.test.js` (helper на всех исходах),
  `video-optimizer-disabled.test.js` (disabled-ветка целиком).

### 0.6. Отдача файла: 404/503 и `pipeline`

- [x] Общий классификатор ошибок хранилища: 404 (NoSuchKey/NotFound),
  403 (AccessDenied), 503 (таймаут/сеть/5xx), иначе 500.
- [x] `GET .../download`: сначала `stat`, затем `createReadStream`, затем
  `pipeline(stream, res)`; до заголовков — JSON 404/503; после — destroy.
- [x] `file-resolver.sendFileFromStorage()`: то же самое, не отправлять заголовки
  до успешного `createReadStream`; ошибки после начала отдачи — destroy.
- [x] Не отдавать 500 «Error streaming file» там, где объект просто отсутствует.
- [x] Тесты: `storage-errors.test.js`, 404-регрессия в `download-dedup-route.test.js`,
  существующие `file-resolver.test.js`.

### 0.7. Проверка этапа 0

- [x] `npm test` зелёный: 48 suites / 451 tests + CI smoke PASS.
- [ ] Ручной сценарий local: upload → download → rename → delete.
  (автоматизирован частично: route-тест скачивания + CI startup smoke)
- [ ] Ручной сценарий S3 (MinIO): upload → download → dedup download → folder ZIP.
  (нужен запущенный MinIO; в текущем окружении не выполнялся)
- [x] Локальный коммит этапа 0 (без push).

### 0.8. Рефакторинг после проверки этапа 0

- [x] Общий tri-state helper `src/storage/probe.js` (`probeStorageKey`) вместо
  шести копий `typeof checkExists` + `catch`: `sync.js`, `deduplication.js`,
  `files-metadata.js`, `file-metadata-processor.js`, `optimizer.js`, `files.js`.
- [x] Один классификатор обрыва клиента: `file-resolver.js` использует
  `isClientDisconnectError` из `storage/errors.js`, локальная копия удалена.
- [x] Preview-роут не дублирует Range/pipeline: S3-ветка отдаётся через
  `sendFileFromStorage()`, получая 404/503 вместо 500 после заголовков.
- [x] Для локального backend `sendFileFromStorage()` всегда сверяет размер
  через `stat` — устаревший `file_size` в БД больше не ломает Range.
- [x] Единый список видео-расширений: `VIDEO_EXTENSIONS_DOTTED` в
  `config/file-types.js`; убраны копии в `files.js`, `optimizer.js`,
  `video-info.js`, `file-metadata-processor.js`.
- [x] `LocalStorage.exists()` тоже fail-safe (`false` только при доказанном
  `missing`), как `S3Storage.exists()`.
- [x] Тест `storage-probe.test.js` + регрессия `exists()` при `ENOTDIR`.
- [x] `npm test` после рефакторинга — PASS.

---

## Этап 1 — консистентность путей и метаданных

- [ ] `LocalStorage._resolve()`: проверять `resolved === root || resolved.startsWith(root + path.sep)`
  (сейчас `/tmp/data2` проходит проверку для root `/tmp/data`).
- [ ] `S3Storage.copy()`: кодировать каждый сегмент `CopySource` через
  `encodeURIComponent`, а не `encodeURI` (символы `#`, `?` ломают копирование).
- [ ] Смена `contentRoot`:
  - [ ] не менять пути в БД, пока файлы не перемещены/не подтверждены в новом корне;
  - [ ] пересоздавать storage provider после смены бэкенда/корня;
  - [ ] отдельная миграция файлов, а не только `UPDATE files_metadata`;
  - [ ] при неудаче — откат настроек и понятная ошибка.
- [ ] Стартовая миграция путей: не использовать `dirname(firstPath)` как старый корень
  (теряется `content/`); брать сохранённый старый `contentRoot`.
- [ ] Медиа лежат в `content/<safeName>`, а очистка устройства удаляет только
  `content/<device>` → удалять/пересчитывать объекты по `file_path` из БД.
- [ ] `routes/video-info.js`: убрать жёсткий `content/<device>/<name>`, использовать
  `metadata.file_path` / storage key.
- [ ] `folder-converter.js`: `list(prefix)` с завершающим `/`, убрать/использовать `listSync`.
- [ ] `document-converter.js`: корректный префикс для `getPageSlideCount`.
- [ ] Коллизии имён PDF/ZIP в общем `content/`: суффикс должен учитывать файлы,
  папки и объекты S3, а не только текущую локальную папку.
- [ ] `file-resolver.isFileLocallyAvailable()`: не считать наличие storage
  доказательством доступности; убрать мёртвый fallback.
- [ ] `file-resolver` для локального отсутствующего файла: всегда завершать ответ
  (404/503), не оставлять запрос висеть.
- [ ] `deleteDeviceFilesMetadata()`: не глотать ошибку и не рапортовать успех.
- [ ] `clear-device`: сначала подтвердить удаление объектов, потом метаданные;
  при ошибке storage не очищать БД.
- [ ] `storage.rm()` при ошибке листинга не должен приводить к «успешной» очистке.
- [ ] Тесты: path traversal `../data2`, copy с `#`/`?`, смена root, clear-device
  с медиа в корне, video-info путь, конвертеры.

---

## Этап 2 — долговечность и UX

- [ ] Стартовая сверка S3-primary: локальные файлы, которых нет в S3, ставятся
  в очередь на коммит (с ограничением параллелизма и логом).
- [ ] Периодическая сверка «БД ↔ storage» с отчётом, без автоматического удаления.
- [ ] `S3Storage.createReadStream()`: таймауты/abort для GET, чтобы зависший MinIO
  не держал HTTP-запрос.
- [ ] `S3Storage.writeStream()`: `AbortMultipartUpload` при ошибке/обрыве.
- [ ] Проверка целостности после загрузки: размер + ETag/checksum, где доступно.
- [ ] `cleanupMissingFiles`: батчи/параллелизм с лимитом, прогресс, `dryRun` по умолчанию.
- [ ] Админское скачивание: заменить `response.blob()` (до 5 ГБ в памяти браузера)
  на навигацию/потоковое скачивание.
- [ ] HLS/трейлеры/конвертеры: единая политика «источник в S3, работа во временной
  папке, результат обратно в S3, локальное удаление только после подтверждения».
- [ ] Метрики/алерты: `unknown` от storage, ошибки коммита, осиротевшие объекты.
- [ ] Тесты: рестарт в середине оптимизации, обрыв S3, повторный коммит, HLS.

---

## Известные риски (для отчёта)

| # | Риск | Этап |
|---|------|------|
| 1 | `exists()` = false при таймауте/403 → ложное «нет файла», удаление метаданных | 0 |
| 2 | Очистка удаляет метаданные по любому `false` | 0 |
| 3 | `countFileReferences()` = 0 при ошибке БД → удаление используемого файла | 0 |
| 4 | Дедуплицированный файл не скачивается (basename mismatch) | 0 |
| 5 | ZIP папки, живущей только в S3, всегда 500 | 0 |
| 6 | Видео коммитит только оптимизатор; disabled/error/cancel/restart → только локально | 0 |
| 7 | `.m4v` не попадает в auto-optimize/метаданные/upload | 0 |
| 8 | Скачивание отдаёт 500 вместо 404/503, `pipe` без обработки abort | 0 |
| 9 | `LocalStorage._resolve()` пускает в соседний каталог `data2` | 1 |
| 10 | `S3Storage.copy()` ломается на `#`/`?` в имени | 1 |
| 11 | Смена `contentRoot` мигрирует только БД, файлы и storage остаются старыми | 1 |
| 12 | Стартовая миграция теряет `content/` | 1 |
| 13 | Clear-device оставляет медиа в `content/<safeName>` | 1 |
| 14 | `video-info` строит неверный путь `content/<device>/<name>` | 1 |
| 15 | Конвертеры используют префикс без `/` | 1 |
| 16 | Коллизии имён PDF/ZIP в общем корне | 1 |
| 17 | Админ скачивает до 5 ГБ в память браузера | 2 |
| 18 | Нет стартовой сверки локальных файлов с S3 | 2 |
| 19 | Нет тестов на content-download и локальную ветку resolver | 0/2 |
