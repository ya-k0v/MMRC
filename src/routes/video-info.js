/**
 * API Routes для информации о видео и оптимизации
 * @module routes/video-info
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { getDevicesPath } from '../config/settings-manager.js';
import { sanitizeDeviceId } from '../utils/sanitize.js';
import logger from '../utils/logger.js';
import { notificationsManager } from '../utils/notifications.js';
import { setFileStatus, deleteFileStatus } from '../video/file-status.js';
import { cancelOptimizationJob, hasActiveOptimizationJob } from '../video/optimizer.js';

const router = express.Router();
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.ogg', '.mkv', '.mov', '.avi']);

function normalizeStatus(statusValue) {
  return String(statusValue || '').toLowerCase();
}

function parseHour(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.min(23, parsed));
}

/**
 * Настройка роутера для видео информации
 * @param {Object} deps - Зависимости
 * @returns {express.Router} Настроенный роутер
 */
export function createVideoInfoRouter(deps) {
  const {
    devices,
    getFileStatus,
    checkVideoParameters,
    autoOptimizeVideoWrapper,
    io = null,
    requireAdmin = (_req, _res, next) => next()
  } = deps;

  const NIGHT_OPT_STATUS = 'scheduled_night';
  const NIGHT_QUEUE_NOTIFICATION_KEY = 'night_optimize_queue';
  const nightQueue = new Map();
  const nightQueueResults = [];
  const nightStartHour = parseHour(process.env.NIGHT_OPT_START_HOUR, 1);
  const nightEndHour = parseHour(process.env.NIGHT_OPT_END_HOUR, 6);
  const schedulerIntervalMs = Math.max(
    15000,
    Number.parseInt(process.env.NIGHT_OPT_SCHEDULER_INTERVAL_MS || '60000', 10) || 60000
  );
  let isNightQueueRunning = false;
  let currentNightQueueJob = null;

  const makeNightQueueKey = (deviceId, fileName) => `${deviceId}::${fileName}`;

  const getDeviceLabel = (deviceId) => {
    const name = devices[deviceId]?.name;
    return name ? `${name} (${deviceId})` : String(deviceId || 'unknown-device');
  };

  const formatQueueJobLabel = (job) => `${getDeviceLabel(job.deviceId)}: ${job.fileName}`;

  const pushNightQueueResult = (job, status, message = '') => {
    if (!job?.deviceId || !job?.fileName) {
      return;
    }

    nightQueueResults.push({
      deviceId: job.deviceId,
      fileName: job.fileName,
      status: String(status || 'done'),
      message: String(message || '').slice(0, 240),
      timestamp: new Date().toISOString()
    });

    if (nightQueueResults.length > 40) {
      nightQueueResults.splice(0, nightQueueResults.length - 40);
    }
  };

  const buildNightQueueNotificationPayload = () => {
    const queueItems = Array.from(nightQueue.values())
      .sort((a, b) => Number(a.queuedAt || 0) - Number(b.queuedAt || 0));
    const recentResults = nightQueueResults.slice(-8).reverse();

    const queuePreview = queueItems.slice(0, 8).map(formatQueueJobLabel);
    const queueOverflowCount = Math.max(0, queueItems.length - queuePreview.length);

    const resultPreview = recentResults.map((entry) => {
      const statusMap = {
        done: 'готово',
        skipped: 'уже оптимизирован',
        cancelled: 'отменено',
        failed: 'ошибка'
      };
      const label = formatQueueJobLabel(entry);
      const statusLabel = statusMap[entry.status] || entry.status;
      const extra = entry.message ? ` (${entry.message})` : '';
      return `${label} — ${statusLabel}${extra}`;
    });

    const hasFailures = recentResults.some((entry) => entry.status === 'failed');
    const severity = hasFailures ? 'warning' : 'info';

    let title = '🌙 Ночная обработка';
    if (currentNightQueueJob) {
      title = '🌙 Ночная обработка: выполняется';
    } else if (queueItems.length > 0) {
      title = `🌙 Ночная обработка: в очереди ${queueItems.length}`;
    } else if (recentResults.length > 0) {
      title = '🌙 Ночная обработка: результаты';
    }

    const messageParts = [];
    if (currentNightQueueJob) {
      messageParts.push(`Сейчас: ${formatQueueJobLabel(currentNightQueueJob)}`);
    }
    if (queuePreview.length > 0) {
      const queuePart = queueOverflowCount > 0
        ? `${queuePreview.join(', ')} (+${queueOverflowCount})`
        : queuePreview.join(', ');
      messageParts.push(`Очередь: ${queuePart}`);
    }
    if (resultPreview.length > 0) {
      messageParts.push(`Результаты: ${resultPreview.join(', ')}`);
    }
    if (messageParts.length === 0) {
      messageParts.push('Очередь ночной обработки пуста.');
    }

    return {
      type: 'night_optimize_queue',
      severity,
      title,
      message: messageParts.join(' | ').slice(0, 980),
      key: NIGHT_QUEUE_NOTIFICATION_KEY,
      source: 'video-info',
      details: {
        window: `${String(nightStartHour).padStart(2, '0')}:00-${String(nightEndHour).padStart(2, '0')}:00`,
        queueCount: queueItems.length,
        queue: queueItems.slice(0, 20).map((job) => ({
          deviceId: job.deviceId,
          deviceName: devices[job.deviceId]?.name || null,
          fileName: job.fileName,
          queuedAt: job.queuedAt || null
        })),
        current: currentNightQueueJob
          ? {
              deviceId: currentNightQueueJob.deviceId,
              fileName: currentNightQueueJob.fileName,
              startedAt: currentNightQueueJob.startedAt || null
            }
          : null,
        recentResults: recentResults.map((entry) => ({
          deviceId: entry.deviceId,
          deviceName: devices[entry.deviceId]?.name || null,
          fileName: entry.fileName,
          status: entry.status,
          message: entry.message,
          timestamp: entry.timestamp
        }))
      }
    };
  };

  const syncNightQueueNotification = () => {
    notificationsManager.upsert(buildNightQueueNotificationPayload());
  };

  const emitDevicesUpdated = () => {
    if (io && typeof io.emit === 'function') {
      io.emit('devices/updated');
    }
  };

  const isNightWindow = (date = new Date()) => {
    const hour = date.getHours();
    if (nightStartHour === nightEndHour) {
      return true;
    }
    if (nightStartHour < nightEndHour) {
      return hour >= nightStartHour && hour < nightEndHour;
    }
    return hour >= nightStartHour || hour < nightEndHour;
  };

  const removeNightSchedule = (deviceId, fileName) => {
    const key = makeNightQueueKey(deviceId, fileName);
    const removed = nightQueue.delete(key);
    const status = getFileStatus(deviceId, fileName);
    if (normalizeStatus(status?.status) === NIGHT_OPT_STATUS) {
      deleteFileStatus(deviceId, fileName);
    }
    if (removed) {
      syncNightQueueNotification();
    }
    return removed;
  };

  const runNightQueue = async () => {
    if (isNightQueueRunning) {
      return;
    }

    if (nightQueue.size === 0 || !isNightWindow()) {
      return;
    }

    isNightQueueRunning = true;
    try {
      for (const [key, job] of Array.from(nightQueue.entries())) {
        if (!isNightWindow()) {
          break;
        }

        const device = devices[job.deviceId];
        if (!device) {
          nightQueue.delete(key);
          deleteFileStatus(job.deviceId, job.fileName);
          pushNightQueueResult(job, 'failed', 'Устройство не найдено');
          syncNightQueueNotification();
          continue;
        }

        const status = getFileStatus(job.deviceId, job.fileName);
        const state = normalizeStatus(status?.status);
        if (state === 'processing' || state === 'checking') {
          continue;
        }

        nightQueue.delete(key);
        if (state === NIGHT_OPT_STATUS) {
          deleteFileStatus(job.deviceId, job.fileName);
        }

        currentNightQueueJob = {
          deviceId: job.deviceId,
          fileName: job.fileName,
          startedAt: new Date().toISOString()
        };
        syncNightQueueNotification();

        try {
          logger.info('[video-info] 🌙 Запуск ночной обработки', {
            deviceId: job.deviceId,
            fileName: job.fileName
          });

          const result = await autoOptimizeVideoWrapper(job.deviceId, job.fileName);
          if (result?.cancelled) {
            pushNightQueueResult(job, 'cancelled', result?.message || 'Отменено пользователем');
          } else if (result?.success === false) {
            pushNightQueueResult(job, 'failed', result?.message || 'Ошибка обработки');
          } else if (result?.optimized === false) {
            pushNightQueueResult(job, 'skipped', result?.message || 'Уже оптимизировано');
          } else {
            pushNightQueueResult(job, 'done', result?.message || 'Успешно обработано');
          }
        } catch (error) {
          logger.error('[video-info] ❌ Ночная обработка завершилась ошибкой', {
            deviceId: job.deviceId,
            fileName: job.fileName,
            error: error.message,
            stack: error.stack
          });
          pushNightQueueResult(job, 'failed', error?.message || 'Ошибка обработки');
        } finally {
          currentNightQueueJob = null;
          syncNightQueueNotification();
        }
      }
    } finally {
      currentNightQueueJob = null;
      isNightQueueRunning = false;
    }
  };

  const schedulerTimer = setInterval(() => {
    runNightQueue().catch((error) => {
      logger.error('[video-info] Night scheduler tick failed', {
        error: error.message,
        stack: error.stack
      });
    });
  }, schedulerIntervalMs);

  if (typeof schedulerTimer.unref === 'function') {
    schedulerTimer.unref();
  }

  const ensureVideoFileExists = (deviceId, fileName) => {
    const d = devices[deviceId];
    if (!d) {
      return { ok: false, status: 404, error: 'Устройство не найдено' };
    }

    const normalizedFileName = String(fileName || '');
    if (!normalizedFileName || normalizedFileName.includes('\0') || path.basename(normalizedFileName) !== normalizedFileName) {
      return { ok: false, status: 400, error: 'Некорректное имя файла' };
    }

    const ext = path.extname(normalizedFileName).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) {
      return { ok: false, status: 400, error: 'Обработка поддерживается только для видеофайлов' };
    }

    const devicesPath = getDevicesPath();
    const devicesRoot = path.resolve(devicesPath);
    const deviceRoot = path.resolve(devicesRoot, String(d.folder || ''));
    const isInsideDevicesRoot = deviceRoot === devicesRoot || deviceRoot.startsWith(`${devicesRoot}${path.sep}`);
    if (!isInsideDevicesRoot) {
      return { ok: false, status: 400, error: 'Некорректный путь устройства' };
    }

    const filePath = path.resolve(deviceRoot, normalizedFileName);
    const isInsideDeviceRoot = filePath.startsWith(`${deviceRoot}${path.sep}`);
    if (!isInsideDeviceRoot) {
      return { ok: false, status: 400, error: 'Некорректный путь к файлу' };
    }

    const inList = Array.isArray(d.files) ? d.files.includes(normalizedFileName) : false;
    const existsOnDisk = fs.existsSync(filePath);

    if (!inList && !existsOnDisk) {
      return { ok: false, status: 404, error: 'Файл не найден' };
    }

    return { ok: true, device: d };
  };
  
  // GET /api/devices/:id/files/:name/status - Получить статус обработки файла
  router.get('/:id/files/:name/status', (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'Неверный ID устройства' });
    }
    
    if (!devices[id]) {
      return res.status(404).json({ error: 'Устройство не найдено' });
    }
    
    const fileName = decodeURIComponent(req.params.name);
    const status = getFileStatus(id, fileName);
    
    if (!status) {
      // Если статуса нет, значит файл готов к воспроизведению
      return res.json({ 
        status: 'ready', 
        progress: 100, 
        canPlay: true 
      });
    }
    
    res.json(status);
  });
  
  // GET /api/devices/:id/files/:name/video-info - Получить информацию о видео
  router.get('/:id/files/:name/video-info', async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'Неверный ID устройства' });
    }
    
    const d = devices[id];
    
    if (!d) {
      return res.status(404).json({ error: 'Устройство не найдено' });
    }
    
    // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
    const devicesPath = getDevicesPath();
    const fileName = decodeURIComponent(req.params.name);
    const filePath = path.join(devicesPath, d.folder, fileName);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Файл не найден' });
    }
    
    try {
      const params = await checkVideoParameters(filePath);
      
      if (!params) {
        return res.status(500).json({ error: 'Не удалось прочитать параметры видео' });
      }
      
      res.json({
        success: true,
        parameters: params
      });
      
    } catch (error) {
      logger.error(`[video-info] ❌ Ошибка`, { error: error.message, stack: error.stack, deviceId: id, fileName });
      res.status(500).json({ 
        error: 'Не удалось получить информацию о видео', 
        detail: error.message 
      });
    }
  });
  
  // POST /api/devices/:id/files/:name/optimize - Запустить оптимизацию видео
  router.post('/:id/files/:name/optimize', requireAdmin, async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'Неверный ID устройства' });
    }
    
    const fileName = decodeURIComponent(req.params.name);
    const validation = ensureVideoFileExists(id, fileName);
    if (!validation.ok) {
      return res.status(validation.status).json({ success: false, message: validation.error });
    }

    const currentStatus = getFileStatus(id, fileName);
    const currentState = normalizeStatus(currentStatus?.status);
    if (currentState === 'processing' || currentState === 'checking' || hasActiveOptimizationJob(id, fileName)) {
      return res.status(409).json({
        success: false,
        message: 'Файл уже обрабатывается'
      });
    }

    removeNightSchedule(id, fileName);
    
    logger.info(`[API] 🎬 Ручная оптимизация: ${fileName}`, { deviceId: id, fileName });

    res.status(202).json({
      success: true,
      status: 'queued',
      message: 'Обработка запущена'
    });

    Promise.resolve()
      .then(async () => {
        await autoOptimizeVideoWrapper(id, fileName);
      })
      .catch((error) => {
        logger.error('[optimize] ❌ Фоновая обработка завершилась ошибкой', {
          error: error.message,
          stack: error.stack,
          deviceId: id,
          fileName
        });
      });
  });

  // POST /api/devices/:id/files/:name/cancel-optimize - Отменить текущую обработку
  router.post('/:id/files/:name/cancel-optimize', requireAdmin, (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Неверный ID устройства' });
    }

    const fileName = decodeURIComponent(req.params.name);
    const validation = ensureVideoFileExists(id, fileName);
    if (!validation.ok) {
      return res.status(validation.status).json({ ok: false, error: validation.error });
    }

    const scheduledRemoved = removeNightSchedule(id, fileName);
    if (scheduledRemoved) {
      pushNightQueueResult({ deviceId: id, fileName }, 'cancelled', 'Планирование отменено пользователем');
      syncNightQueueNotification();
    }

    const status = getFileStatus(id, fileName);
    const state = normalizeStatus(status?.status);
    const isActive = state === 'processing' || state === 'checking' || hasActiveOptimizationJob(id, fileName);

    if (!isActive && !scheduledRemoved) {
      return res.status(409).json({ ok: false, error: 'Файл сейчас не обрабатывается' });
    }

    if (isActive) {
      const cancelResult = cancelOptimizationJob(id, fileName, 'Обработка отменена пользователем');

      if (!cancelResult.active) {
        setFileStatus(id, fileName, { status: 'ready', progress: 100, canPlay: true });
        emitDevicesUpdated();
      }

      return res.json({
        ok: true,
        status: cancelResult.active ? 'cancelling' : 'cancelled',
        cancelledSchedule: scheduledRemoved
      });
    }

    setFileStatus(id, fileName, { status: 'ready', progress: 100, canPlay: true });
    emitDevicesUpdated();

    return res.json({
      ok: true,
      status: 'cancelled',
      cancelledSchedule: true
    });
  });

  // POST /api/devices/:id/files/:name/schedule-optimize-night - Запланировать обработку на ночь
  router.post('/:id/files/:name/schedule-optimize-night', requireAdmin, (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Неверный ID устройства' });
    }

    const fileName = decodeURIComponent(req.params.name);
    const validation = ensureVideoFileExists(id, fileName);
    if (!validation.ok) {
      return res.status(validation.status).json({ ok: false, error: validation.error });
    }

    const currentStatus = getFileStatus(id, fileName);
    const currentState = normalizeStatus(currentStatus?.status);
    if (currentState === 'processing' || currentState === 'checking' || hasActiveOptimizationJob(id, fileName)) {
      return res.status(409).json({ ok: false, error: 'Файл уже обрабатывается' });
    }

    const queueKey = makeNightQueueKey(id, fileName);
    const alreadyScheduled = nightQueue.has(queueKey);
    nightQueue.set(queueKey, {
      deviceId: id,
      fileName,
      queuedAt: Date.now(),
      queuedBy: req.user?.username || null
    });
    syncNightQueueNotification();

    setFileStatus(id, fileName, {
      status: NIGHT_OPT_STATUS,
      progress: 0,
      canPlay: true
    });
    emitDevicesUpdated();

    if (isNightWindow()) {
      runNightQueue().catch((error) => {
        logger.error('[video-info] Failed to run night queue immediately', {
          error: error.message,
          stack: error.stack
        });
      });
    }

    return res.status(alreadyScheduled ? 200 : 202).json({
      ok: true,
      status: NIGHT_OPT_STATUS,
      scheduledWindow: `${String(nightStartHour).padStart(2, '0')}:00-${String(nightEndHour).padStart(2, '0')}:00`
    });
  });
  
  return router;
}

