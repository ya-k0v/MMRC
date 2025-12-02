
---

## 🚀 ТОЧКА ВХОДА

**Файл:** `server.js` (647 строк)

**Основные этапы инициализации:**
1. Импорт зависимостей и модулей
2. Создание Express app и HTTP server
3. Инициализация Socket.IO
4. Создание директорий (data/*)
5. Инициализация БД (`initDatabase`)
6. Загрузка устройств из БД (`loadDevicesFromDB`)
7. Загрузка файлов из БД (`loadFileNamesFromDB`)
8. Инициализация Stream Manager
9. Загрузка состояния громкости устройств
10. Настройка Express middleware
11. Подключение роутеров
12. Настройка Socket.IO handlers
13. Запуск сервера на `127.0.0.1:3000`
14. Периодическая очистка кэша (каждые 30 мин)
15. Graceful shutdown обработчики

---

## 📦 ЭКСПОРТИРУЕМЫЕ ФУНКЦИИ И МОДУЛИ

### 🔧 src/config/

**constants.js:**
- `ROOT` - корневая директория проекта
- `PUBLIC` - путь к public/
- `DATA_DIR` - директория данных (локальная или внешняя)
- `useExternalDataDiskFlag` - флаг использования внешнего диска
- `DEFAULT_DEVICES_PATH` - путь к контенту устройств
- `DEVICES` - текущий путь к устройствам
- `setDevicesPath(newPath)` - установка пути к устройствам
- `STREAMS_OUTPUT_DIR` - директория для HLS стримов
- `CONVERTED_CACHE` - кэш конвертированных файлов
- `LOGS_DIR` - директория логов
- `TEMP_DIR` - временная директория
- `VIDEO_OPTIMIZATION_CONFIG_PATH` - путь к конфигу оптимизации
- `MAX_FILE_SIZE` - максимальный размер файла (5GB)
- `ALLOWED_EXT` - разрешенные расширения файлов
- `PORT` - порт сервера (3000)
- `HOST` - хост (127.0.0.1)

**settings-manager.js:**
- `getSettings()` - получение настроек
- `updateContentRootPath(newPath)` - обновление пути к контенту (async, миграция БД)
- `initializeSettings()` - инициализация настроек

**socket-config.js:**
- `createSocketServer(httpServer)` - создание Socket.IO сервера

---

### 🗄️ src/database/

**database.js:**
- `initDatabase(initialDbPath)` - инициализация БД
- `getDatabase()` - получение экземпляра БД
- `closeDatabase()` - закрытие БД
- `getAllDevices()` - получение всех устройств
- `saveDevice(deviceId, data)` - сохранение устройства
- `deleteDevice(deviceId)` - удаление устройства
- `getAllFileNames()` - получение всех имен файлов
- `saveFileName(deviceId, safeName, originalName)` - сохранение имени файла
- `deleteFileName(deviceId, safeName)` - удаление имени файла
- `deleteDeviceFileNames(deviceId)` - удаление всех имен файлов устройства
- `getFileStatus(deviceId, fileName)` - получение статуса файла
- `saveFileStatus(deviceId, fileName, statusData)` - сохранение статуса
- `deleteFileStatus(deviceId, fileName)` - удаление статуса
- `getDeviceFileStatuses(deviceId)` - получение всех статусов устройства
- `getPlaceholder(deviceId)` - получение заглушки
- `savePlaceholder(deviceId, placeholderFile, placeholderType)` - сохранение заглушки
- `deletePlaceholder(deviceId)` - удаление заглушки
- `getAllDeviceVolumeStates()` - получение всех состояний громкости
- `getDeviceVolumeState(deviceId)` - получение состояния громкости
- `saveDeviceVolumeState(deviceId, {volumeLevel, isMuted})` - сохранение состояния громкости
- `transaction(fn)` - выполнение транзакции
- `getDatabaseStats()` - статистика БД
- `exportToJSON()` - экспорт БД в JSON

**files-metadata.js:**
- `saveFileMetadata({deviceId, safeName, ...})` - сохранение метаданных
- `getFileMetadata(deviceId, safeName)` - получение метаданных
- `getDeviceFilesMetadata(deviceId)` - получение всех метаданных устройства
- `getAllStreamingMetadata()` - получение всех стримов
- `findDuplicateFile(md5Hash, fileSize, excludeDeviceId, isPartial)` - поиск дубликата
- `deleteFileMetadata(deviceId, safeName)` - удаление метаданных
- `deleteDeviceFilesMetadata(deviceId)` - удаление всех метаданных устройства
- `getStorageStats()` - статистика хранилища
- `getDuplicateFiles()` - получение дубликатов
- `needsMetadataUpdate(deviceId, safeName, currentMtime)` - проверка необходимости обновления
- `countFileReferences(filePath)` - подсчет ссылок на файл
- `updateFileOriginalName(deviceId, safeName, newOriginalName)` - обновление оригинального имени
- `migrateFilePaths(oldRoot, newRoot)` - миграция путей файлов
- `createStreamingEntry({deviceId, safeName, ...})` - создание записи стрима
- `deleteStreamingEntry(deviceId, safeName)` - удаление записи стрима
- `getAllFilePaths()` - получение всех путей файлов

---

### 🛣️ src/routes/

**auth.js:**
- `createAuthRouter()` - создание роутера аутентификации
  - `POST /api/auth/login` - вход
  - `POST /api/auth/refresh` - обновление токена
  - `POST /api/auth/logout` - выход
  - `GET /api/auth/me` - текущий пользователь

**devices.js:**
- `createDevicesRouter(deps)` - создание роутера устройств
  - `GET /api/devices` - список устройств
  - `POST /api/devices` - создание устройства (requireAdmin)
  - `DELETE /api/devices/:id` - удаление устройства (requireAdmin)

**files.js:**
- `createFilesRouter(deps)` - создание роутера файлов
- `updateDeviceFilesFromDB(deviceId, devices, fileNamesMap)` - обновление файлов из БД
  - `POST /api/devices/:id/upload` - загрузка файла
  - `GET /api/devices/:id/files-with-status` - список файлов со статусом
  - `POST /api/devices/:id/files/:name/rename` - переименование (requireAdmin)
  - `DELETE /api/devices/:id/files/:name` - удаление (requireAdmin)
  - `POST /api/devices/:id/files/:name/copy` - копирование (requireAdmin)

**placeholder.js:**
- `createPlaceholderRouter(deps)` - создание роутера заглушек
  - `GET /api/devices/:id/placeholder` - получение заглушки
  - `POST /api/devices/:id/placeholder` - установка заглушки (requireAdmin)

**video-info.js:**
- `createVideoInfoRouter(deps)` - создание роутера информации о видео
  - `GET /api/devices/:id/files/:name/status` - статус видео
  - `GET /api/devices/:id/files/:name/info` - информация о видео
  - `POST /api/devices/:id/files/:name/optimize` - оптимизация (requireAuth)

**conversion.js:**
- `createConversionRouter(deps)` - создание роутера конвертации
  - `POST /api/devices/:id/files/:name/convert` - конвертация PDF/PPTX (requireAuth)

**folders.js:**
- `createFoldersRouter(deps)` - создание роутера папок
  - `GET /api/devices/:id/folders/:name` - получение папки (requireAuth)
  - `POST /api/devices/:id/folders/:name/playlist` - плейлист папки (requireAuth)

**deduplication.js:**
- `createDeduplicationRouter(deps)` - создание роутера дедупликации
  - `POST /api/devices/:id/files/:name/check-duplicate` - проверка дубликата
  - `POST /api/devices/:id/files/:name/copy-from-duplicate` - копирование из дубликата

**volume.js:**
- `createVolumeRouter(deps)` - создание роутера громкости
  - `GET /api/devices/:id/volume` - получение громкости (requireSpeaker)
  - `POST /api/devices/:id/volume` - установка громкости (requireSpeaker)

**system-info.js:**
- `createSystemInfoRouter()` - создание роутера системной информации
  - `GET /api/system/info` - системная информация (requireAuth)
  - `GET /api/system/storage` - информация о хранилище (requireAuth)

**file-resolver.js:**
- `default export` - роутер резолвинга файлов
  - `GET /api/files/resolve/:deviceId/:fileName` - резолвинг файла (без авторизации)

**hero/index.js:**
- `createHeroRouter({requireHeroAdmin})` - создание Hero роутера
  - `GET /api/hero/heroes` - список heroes
  - `POST /api/hero/heroes` - создание hero (requireHeroAdmin)
  - `GET /api/hero/export-database` - экспорт БД (requireHeroAdmin)

---

### 🔌 src/socket/

**index.js:**
- `setupSocketHandlers(io, deps)` - настройка всех Socket.IO обработчиков

**device-handlers.js:**
- `setupDeviceHandlers(socket, deps)` - обработчики устройств
- `handleDisconnect(socket, deps)` - обработка отключения

**control-handlers.js:**
- `setupControlHandlers(socket, deps)` - обработчики управления

**connection-manager.js:**
- `getOnlineDevices()` - получение онлайн устройств

**device-state.js:**
- `saveDeviceState(devices)` - сохранение состояния устройств
- `loadDeviceState(devices)` - загрузка состояния устройств
- `startAutoSave(devices, interval)` - автосохранение

---

### 🎬 src/video/

**ffmpeg-wrapper.js:**
- `checkVideoParameters(deviceId, fileName)` - проверка параметров видео

**file-status.js:**
- `getFileStatus(deviceId, fileName)` - получение статуса файла

**optimizer.js:**
- `getVideoOptConfig()` - получение конфига оптимизации
- `needsOptimization(params)` - проверка необходимости оптимизации
- `autoOptimizeVideo(deviceId, fileName, devices, io, fileNamesMap, saveFileNamesMap)` - автооптимизация

**resolution-cache.js:**
- `clearResolutionCache(filePath)` - очистка кэша разрешения
- `clearAllResolutionCache()` - очистка всего кэша
- `getResolutionCacheSize()` - размер кэша
- `cleanupResolutionCache()` - очистка несуществующих записей

**trailer-generator.js:**
- `getTrailerPath(md5Hash)` - получение пути к трейлеру

---

### 📄 src/converters/

**document-converter.js:**
- `findFileFolder(deviceId, fileName)` - поиск папки файла
- `getPageSlideCount(deviceId, fileName)` - количество страниц/слайдов
- `autoConvertFile(deviceId, fileName, devices, fileNamesMap, saveFileNamesMap, io)` - автоконвертация

**folder-converter.js:**
- `findImageFolder(deviceId, fileName)` - поиск папки изображений

---

### 📡 src/streams/

**stream-manager.js:**
- `initStreamManager(options)` - инициализация менеджера стримов
- `getStreamManager()` - получение менеджера
- `syncStreamJobs(entries)` - синхронизация задач стримов
- `upsertStreamJob(entry)` - создание/обновление задачи стрима
- `removeStreamJob(deviceId, safeName, reason)` - удаление задачи стрима
- `getStreamPlaybackUrl(deviceId, safeName)` - URL для воспроизведения стрима
- `getStreamRestreamStatus(deviceId, safeName)` - статус рестрима

---

### 💾 src/storage/

**devices-storage-sqlite.js:**
- `loadDevicesFromDB()` - загрузка устройств из БД
- `saveDevicesToDB(devices)` - сохранение устройств в БД
- `loadFileNamesFromDB()` - загрузка имен файлов из БД
- `saveFileNamesToDB(fileNamesMap)` - сохранение имен файлов в БД
- `scanAllDevices(devices, fileNamesMap)` - сканирование всех устройств

---

### 🛡️ src/middleware/

**auth.js:**
- `generateAccessToken(userId, username, role)` - генерация access token (12h)
- `generateRefreshToken(userId)` - генерация refresh token (30d)
- `requireAuth(req, res, next)` - middleware аутентификации
- `requireRole(...roles)` - middleware проверки роли
- `requireAdmin` - middleware для админа
- `requireHeroAdmin` - middleware для hero админа
- `requireSpeaker` - middleware для спикера

**rate-limit.js:**
- `globalLimiter` - глобальный rate limiter
- `uploadLimiter` - rate limiter для загрузки
- `authLimiter` - rate limiter для аутентификации
- `apiSpeedLimiter` - speed limiter для API
- `deleteLimiter` - rate limiter для удаления
- `createLimiter` - rate limiter для создания

**express-config.js:**
- `setupExpressMiddleware(app)` - настройка Express middleware
- `setupStaticFiles(app)` - настройка статических файлов

**multer-config.js:**
- `createUploadMiddleware(devices)` - создание middleware загрузки

**file-validation.js:**
- `validateUploadedFiles(req, res, next)` - валидация загружаемых файлов

**timeout.js:**
- `requestTimeout(timeoutMs)` - таймаут запроса (30s)
- `longOperationTimeout(timeoutMs)` - таймаут длинных операций (5min)

---

### 🛠️ src/utils/

**logger.js:**
- `default export` - Winston logger
- `logAuth(level, message, meta)` - логирование аутентификации
- `logDevice(level, message, meta)` - логирование устройств
- `logFile(level, message, meta)` - логирование файлов
- `logSocket(level, message, meta)` - логирование Socket.IO
- `logSecurity(level, message, meta)` - логирование безопасности
- `logAPI(level, message, meta)` - логирование API
- `httpLoggerMiddleware` - middleware логирования HTTP

**metrics.js:**
- `recordRequest(method, route, duration, isError)` - запись метрики запроса
- `recordDatabaseQuery(duration, isError, isSlow)` - запись метрики БД
- `recordSocketEvent(event)` - запись метрики Socket
- `getMetrics()` - получение всех метрик
- `resetMetrics()` - сброс метрик

**circuit-breaker.js:**
- `CircuitBreaker` - класс circuit breaker
- `circuitBreakers` - объект с circuit breakers

**retry.js:**
- `withRetrySync(fn, options)` - синхронный retry
- `isRetryableDatabaseError(error)` - проверка retryable ошибки БД

**transliterate.js:**
- `transliterate(text)` - транслитерация текста
- `makeSafeFilename(filename)` - безопасное имя файла
- `makeSafeFolderName(folderName)` - безопасное имя папки

**path-validator.js:**
- `validatePath(userPath, baseDir)` - валидация пути
- `safeExists(userPath, baseDir)` - безопасная проверка существования

**sanitize.js:**
- `sanitizeDeviceId(id)` - санитизация device ID
- `isSystemFile(fileName)` - проверка системного файла

**file-scanner.js:**
- `scanDeviceFiles(deviceId, deviceFolder, fileNamesMap)` - сканирование файлов устройства
- `updateDeviceFiles(devices, deviceId, fileNamesMap)` - обновление файлов устройства

---

## 🔌 SOCKET.IO СОБЫТИЯ

### События от клиента (устройства/админка):

**Устройства:**
- `device/register` - регистрация устройства
- `device/heartbeat` - heartbeat устройства
- `device/state` - отправка состояния устройства
- `device/files/request` - запрос списка файлов

**Управление:**
- `control/play` - воспроизведение файла
- `control/pause` - пауза
- `control/stop` - остановка
- `control/seek` - перемотка
- `control/volume` - управление громкостью
- `control/slide` - переключение слайда (PDF/PPTX)
- `control/folder` - управление папкой изображений

### События от сервера:

**Устройства:**
- `players/onlineSnapshot` - снимок онлайн устройств
- `devices/updated` - обновление устройств
- `device/files/updated` - обновление файлов устройства

**Воспроизведение:**
- `player/play` - команда воспроизведения
- `player/pause` - команда паузы
- `player/stop` - команда остановки
- `player/seek` - команда перемотки
- `player/slide` - команда переключения слайда
- `player/folder` - команда управления папкой
- `player/volume` - команда громкости

**Громкость:**
- `devices/volume/state` - состояние громкости устройства
- `devices/volume/stateBatch` - пакет состояний громкости

---

## 🗄️ СХЕМА БАЗЫ ДАННЫХ

**Таблицы (из init.sql):**

1. **devices** - устройства
   - device_id (TEXT PRIMARY KEY)
   - name (TEXT)
   - type (TEXT)
   - data (TEXT JSON)

2. **file_names** - имена файлов
   - device_id (TEXT)
   - safe_name (TEXT)
   - original_name (TEXT)
   - PRIMARY KEY (device_id, safe_name)

3. **file_statuses** - статусы файлов
   - device_id (TEXT)
   - file_name (TEXT)
   - status (TEXT JSON)
   - PRIMARY KEY (device_id, file_name)

4. **placeholders** - заглушки
   - device_id (TEXT PRIMARY KEY)
   - placeholder_file (TEXT)
   - placeholder_type (TEXT)

5. **volume_states** - состояния громкости
   - device_id (TEXT PRIMARY KEY)
   - volume_level (INTEGER)
   - is_muted (INTEGER)
   - updated_at (TEXT)

6. **files_metadata** - метаданные файлов
   - device_id (TEXT)
   - safe_name (TEXT)
   - original_name (TEXT)
   - file_path (TEXT)
   - file_size (INTEGER)
   - md5_hash (TEXT)
   - mtime (INTEGER)
   - is_placeholder (INTEGER)
   - PRIMARY KEY (device_id, safe_name)

7. **streaming_metadata** - метаданные стримов
   - device_id (TEXT)
   - safe_name (TEXT)
   - stream_url (TEXT)
   - protocol (TEXT)
   - PRIMARY KEY (device_id, safe_name)

8. **settings** - настройки
   - key (TEXT PRIMARY KEY)
   - value (TEXT)

---

## 📦 ЗАВИСИМОСТИ (package.json)

**Production:**
- `bcrypt` ^5.1.1 - хеширование паролей
- `better-sqlite3` ^11.10.0 - SQLite драйвер
- `express` ^4.19.2 - веб-фреймворк
- `express-rate-limit` ^8.2.1 - rate limiting
- `express-slow-down` ^3.0.1 - slow down
- `express-validator` ^7.3.0 - валидация
- `file-type` ^21.1.0 - определение типа файла
- `jsonwebtoken` ^9.0.2 - JWT токены
- `mime` ^4.0.4 - MIME типы
- `multer` ^2.0.2 - загрузка файлов
- `pdf-lib` ^1.17.1 - работа с PDF
- `pdf2pic` ^3.2.0 - PDF → изображения
- `socket.io` ^4.7.5 - WebSocket
- `winston` ^3.18.3 - логирование
- `winston-daily-rotate-file` ^5.0.0 - ротация логов

**Development:**
- `puppeteer` ^24.31.0 - браузерная автоматизация

---

## 🔐 БЕЗОПАСНОСТЬ

**Аутентификация:**
- JWT токены (access: 12h, refresh: 30d)
- Роли: `admin`, `hero_admin`, `speaker`
- Хеширование паролей: bcrypt

**Защита API:**
- Rate limiting (глобальный, для загрузки, для auth)
- Speed limiting (замедление при частых запросах)
- SQL Prepared Statements (защита от injection)
- Санитизация device ID и путей
- Валидация файлов (размер, расширение, тип)

**Открытые эндпоинты (без JWT):**
- `GET /api/devices` - список устройств
- `GET /api/devices/:id/placeholder` - заглушка
- `GET /api/devices/:id/files-with-status` - файлы
- `GET /api/files/resolve/:deviceId/:fileName` - резолвинг файла
- `POST /api/auth/login` - вход

**Защищенные эндпоинты:**
- Все POST/DELETE операции требуют `requireAdmin`
- `/api/system/*` требует `requireAuth`
- `/api/admin/*` требует `requireAuth + requireAdmin`
- `/api/hero/*` требует `requireHeroAdmin` (для записи)

---

## ⚙️ КОНФИГУРАЦИЯ

**Переменные окружения:**
- `PORT` - порт сервера (по умолчанию: 3000)
- `DATA_ROOT` - корневая папка данных (по умолчанию: `/mnt/videocontrol-data`)
- `CONTENT_ROOT` - путь к контенту устройств (переопределяет DEFAULT_DEVICES_PATH)
- `NODE_ENV` - окружение (development/production)

**Конфигурационные файлы:**
- `config/main.db` - основная БД
- `config/hero/heroes.db` - Hero БД
- `config/video-optimization.json` - настройки оптимизации видео

**Лимиты:**
- Максимальный размер файла: 5 GB
- Разрешенные расширения: mp4, webm, ogg, mkv, mov, avi, mp3, wav, m4a, png, jpg, jpeg, gif, webp, pdf, pptx, zip
- FFmpeg timeout: 30 минут
- ExoPlayer cache: 500 MB
- TCP buffers: 16 MB

---

## 📊 МЕТРИКИ И МОНИТОРИНГ

**Эндпоинты:**
- `GET /health` - health check (без авторизации)
  - Статус сервера
  - Uptime
  - Memory usage
  - Database status
  - Circuit breakers status

- `GET /api/metrics` - метрики (requireAuth + requireAdmin)
  - HTTP запросы (количество, среднее время, ошибки)
  - Database запросы (количество, медленные запросы)
  - Socket события
  - Время работы

**Логирование:**
- Winston с ротацией файлов
- Логи в `data/logs/`
- Категории: auth, device, file, socket, security, API
- HTTP логирование через middleware

---

## 🎯 ВАЖНЫЕ ОСОБЕННОСТИ

1. **Lazy Loading стримов:** FFmpeg запускается только при использовании стрима
2. **Дедупликация:** MD5 хеши для экономии места (33% в среднем)
3. **Автооптимизация видео:** FFmpeg оптимизация для Android TV (720p/1080p)
4. **Автоконвертация:** PDF/PPTX → изображения автоматически
5. **Graceful Shutdown:** Корректное завершение с закрытием соединений
6. **Circuit Breaker:** Защита от каскадных сбоев
7. **Retry Logic:** Автоматические повторы при ошибках БД
8. **Миграция путей:** Автоматическая миграция при изменении CONTENT_ROOT
9. **Hero модуль:** Отдельный фронтенд и БД для Hero функциональности
10. **Внешнее хранилище:** Поддержка отдельного диска через DATA_ROOT

---

## 🔄 ПЕРИОДИЧЕСКИЕ ЗАДАЧИ

1. **Очистка кэша разрешений** - каждые 30 минут
   - Удаление записей для несуществующих файлов
   - Функция: `cleanupResolutionCache()`

2. **Автосохранение состояния устройств** - каждые 30 секунд
   - Сохранение в БД через `saveDeviceState()`

---

## 📝 ЗАМЕТКИ ДЛЯ РАЗРАБОТКИ

1. **Тип модуля:** ES Modules (`"type": "module"`)
2. **Node.js версия:** 20.x+
3. **Сервер слушает:** только `127.0.0.1:3000` (доступ через Nginx)
4. **БД режим:** WAL (Write-Ahead Logging) для лучшей производительности
5. **Socket.IO transport:** автоматическое обновление до WebSocket
6. **Файлы устройств:** загружаются из БД + сканирование папок при старте
7. **Громкость:** нормализация с шагом 5, диапазон 0-100
8. **Заглушки:** автоматическое воспроизведение при отсутствии контента
9. **PWA:** Service Worker для офлайн работы
10. **Android клиент:** отдельное приложение в `clients/android-mediaplayer/`

---

## 🚨 КРИТИЧЕСКИЕ МОМЕНТЫ

1. **Инициализация настроек:** выполняется асинхронно после инициализации БД
2. **Обновление файлов устройств:** используется `updateDeviceFilesFromDB` для правильной обработки стримов
3. **Стримы не запускаются при старте:** lazy loading для экономии ресурсов
4. **Защита API:** GET запросы открыты для устройств, POST/DELETE требуют админ прав
5. **Миграция путей:** `updateContentRootPath` мигрирует пути в БД асинхронно
6. **Graceful shutdown:** обработка SIGTERM/SIGINT с закрытием соединений

---

**Версия документа:** 1.0  
**Дата создания:** 2024  
**Версия проекта:** 3.0.0