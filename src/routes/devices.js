/**
 * API Routes для управления устройствами (CRUD)
 * @module routes/devices
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getDevicesPath, getDataRoot } from '../config/settings-manager.js';
import { sanitizeDeviceId, isReservedObjectKey } from '../utils/sanitize.js';
import { deleteDevice as deleteDeviceFromDB, deleteDeviceFileNames, getDatabase, updateDeviceMacAddress } from '../database/database.js';
import { createLimiter, deleteLimiter } from '../middleware/rate-limit.js';
import { auditLog, AuditAction } from '../utils/audit-logger.js';
import { createModuleLogger, logDevice } from '../utils/logger.js';
const logger = createModuleLogger('device');
import { deleteDeviceFilesMetadata, getDeviceFilesMetadata } from '../database/files-metadata.js';
import { removeStreamJob } from '../streams/stream-manager.js';
import { requireAuth } from '../middleware/auth.js';
import { getUserDevices, hasDeviceAccess } from '../middleware/device-access.js';
import { launchAndroidApp, getPowerState, getDeviceMac } from '../utils/adb.js';
import { POWER_ACTIONS, planPowerTargets, runPowerAction, getStoredPowerAwake, setStoredPowerState } from '../utils/power-control.js';
import { ANDROID_PACKAGE_NAME, ANDROID_MAIN_ACTIVITY, DEFAULT_ADB_PORT } from '../config/android.js';
import { validatePath } from '../utils/path-validator.js';

const router = express.Router();

function getTrimmedDeviceId(rawId) {
  if (typeof rawId !== 'string') {
    return '';
  }
  return rawId.trim();
}

function toStorageKey(absPath) {
  const root = getDataRoot();
  const rel = path.relative(root, path.resolve(String(absPath)));
  if (rel.startsWith('..')) throw new Error('Path outside data root');
  return rel;
}

function normalizeRequestedDeviceId(rawId) {
  const trimmed = getTrimmedDeviceId(rawId);
  if (!trimmed) {
    return null;
  }

  const sanitized = sanitizeDeviceId(trimmed);
  if (!sanitized || isReservedObjectKey(sanitized)) {
    return null;
  }

  return sanitized;
}

function resolveDeviceEntry(rawId, devicesMap) {
  const trimmed = getTrimmedDeviceId(rawId);
  if (!trimmed || isReservedObjectKey(trimmed)) {
    return null;
  }

  for (const [deviceId, device] of Object.entries(devicesMap || {})) {
    if (deviceId === trimmed && !isReservedObjectKey(deviceId)) {
      return { deviceId, device };
    }
  }

  return null;
}

/**
 * ADB-порт устройства для удалённых операций.
 *
 * Порт задаётся при установке APK и живёт в БД (devices.adb_port), но в
 * памяти его может не быть: устройство могло зарегистрироваться до того, как
 * порт записали, либо строка создавалась с дефолтом. Поэтому память — только
 * кэш, а при её промахе смотрим в базу, и лишь потом берём дефолт.
 */
async function resolveDeviceAdbPort(deviceId, device) {
  if (device && device.adbPort) {
    return String(device.adbPort);
  }

  try {
    const row = await getDatabase().get(
      'SELECT adb_port FROM devices WHERE device_id = ?',
      [deviceId]
    );
    const stored = row && row.adb_port;
    if (stored) {
      if (device) device.adbPort = String(stored);
      return String(stored);
    }
  } catch (e) {
    logger.warn('[ADB] Не удалось прочитать adb_port из БД', { deviceId, error: e.message });
  }

  return String(DEFAULT_ADB_PORT);
}

/**
 * Настройка роутера для устройств
 * @param {Object} deps - Зависимости {devices, io, saveDevicesJson, fileNamesMap, saveFileNamesMap, onDeviceCreated, onDeviceDeleted}
 * @returns {express.Router} Настроенный роутер
 */
export function createDevicesRouter(deps) {
  const { 
    devices, 
    io, 
    saveDevicesJson, 
    fileNamesMap, 
    saveFileNamesMap, 
    requireAdmin,
    requireSpeaker,
    onDeviceCreated,
    onDeviceDeleted,
    storage
  } = deps;
  
  // GET /api/devices - Получить список всех устройств
  // Фильтрует устройства по доступу пользователя:
  // - admin: видит все устройства
  // - speaker: только назначенные устройства
  // - hero_admin: не имеет доступа к устройствам (своя панель)
  router.get('/', requireAuth, async (req, res) => {
    // HERO ADMIN не имеет доступа к устройствам
    if (req.user.role === 'hero_admin') {
      return res.json([]);
    }

    // fileNames дублирует files, а fileMetadata весит не меньше самого списка.
    // Эти поля нужны только панели спикера (оригинальные имена файлов),
    // поэтому по умолчанию они не отдаются: админка, loadNodeNames и плеер
    // берут /api/devices часто и им они не нужны.
    const includeFileMeta = req.query.includeFileMeta === '1';

    let devicesList = Object.entries(devices).map(([id, d]) => {
      const powerAwake = getStoredPowerAwake(id);
      const item = {
        device_id: id,
        name: d.name,
        folder: d.folder,
        files: d.files,
        current: d.current,
        deviceType: d.deviceType || 'browser',
        platform: d.platform || 'Unknown',
        appVersion: d.appVersion || null,
        lastSeen: d.lastSeen || null,
        ipAddress: d.ipAddress || null,
        adbPort: d.adbPort || '5555',
        // Последний известный режим питания: «спит» показывается на плитках
        // вместо «не готов»/«готов», хранится на сервере, ADB не опрашивается.
        powerState: powerAwake === null ? null : (powerAwake ? 'awake' : 'sleep')
      };

      if (includeFileMeta) {
        item.fileNames = d.fileNames || d.files;
        item.fileMetadata = d.fileMetadata || [];
        item.capabilities = d.capabilities || {
          video: true,
          audio: true,
          images: true,
          pdf: true,
          pptx: true,
          streaming: true
        };
      }

      return item;
    });

    // Если пользователь не admin, фильтруем по назначенным устройствам
    if (req.user.role !== 'admin') {
      const allowedDevices = await getUserDevices(req.user.userId);
      const allowedDevicesSet = new Set(allowedDevices);
      devicesList = devicesList.filter(d => allowedDevicesSet.has(d.device_id));
    }

    res.json(devicesList);
  });
  
  // POST /api/devices - Создать новое устройство (только admin)
  router.post('/', requireAdmin, createLimiter, async (req, res) => {
    const { device_id, name } = req.body;
    const rawDeviceId = getTrimmedDeviceId(device_id);
    const normalizedDeviceId = normalizeRequestedDeviceId(device_id);
    
    if (!rawDeviceId) {
      return res.status(400).json({ error: 'Требуется device_id' });
    }

    if (!normalizedDeviceId || rawDeviceId !== normalizedDeviceId) {
      return res.status(400).json({
        error: 'Некорректный device_id. Разрешены только буквы, цифры, _ и - (без пробелов).'
      });
    }
    
    if (Object.prototype.hasOwnProperty.call(devices, normalizedDeviceId)) {
      return res.status(409).json({ error: 'Устройство уже существует' });
    }
    
    // Проверяем уникальность имени устройства
    const deviceName = typeof name === 'string' && name.trim() ? name.trim() : normalizedDeviceId;
    const existingDeviceWithSameName = Object.values(devices).find(d => d.name === deviceName);
    if (existingDeviceWithSameName) {
      return res.status(409).json({ error: 'Устройство с таким именем уже существует' });
    }
    
    // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
    const devicesPath = getDevicesPath();
    const devicePath = validatePath(path.resolve(devicesPath, normalizedDeviceId), devicesPath);
    try { await storage.ensureDir(toStorageKey(devicePath)); } catch { fs.mkdirSync(devicePath, { recursive: true }); }
    
    // КРИТИЧНО: Устанавливаем права 755 на папку устройства
    // Чтобы Nginx (www-data) мог читать файлы
    try {
      fs.chmodSync(devicePath, 0o755);
      logDevice('info', `Device folder created with permissions 755`, { deviceId: normalizedDeviceId, path: devicePath });
    } catch (e) {
      logDevice('warn', `Failed to set permissions on device folder`, { deviceId: normalizedDeviceId, path: devicePath, error: e.message });
    }
    
    devices[normalizedDeviceId] = { 
      name: deviceName,
      folder: normalizedDeviceId,
      files: [], 
      current: { type: 'idle', file: null, state: 'idle' } 
    };
    
    if (typeof onDeviceCreated === 'function') {
      try {
        onDeviceCreated(normalizedDeviceId);
      } catch (err) {
        logger.warn('[Devices] onDeviceCreated hook failed', { deviceId: normalizedDeviceId, error: err.message });
      }
    }
    
    io.emit('devices/updated');
    saveDevicesJson(devices);
    
    // Audit log
    await auditLog({
      userId: req.user.id,
      action: AuditAction.DEVICE_CREATE,
      resource: `device:${normalizedDeviceId}`,
      details: { deviceId: normalizedDeviceId, name: deviceName, createdBy: req.user.username },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      status: 'success'
    });
    logDevice('info', 'Device created', { deviceId: normalizedDeviceId, name: deviceName, createdBy: req.user.username });
    
    res.json({ ok: true });
  });
  
  // POST /api/devices/:id/rename - Переименовать устройство (только admin)
  router.post('/:id/rename', requireAdmin, (req, res) => {
    const rawId = getTrimmedDeviceId(req.params.id);
    const entry = resolveDeviceEntry(req.params.id, devices);
    
    if (!rawId || isReservedObjectKey(rawId)) {
      return res.status(400).json({ error: 'Неверный ID устройства' });
    }

    if (!entry) {
      return res.status(404).json({ error: 'Не найдено' });
    }

    const { deviceId: id, device: targetDevice } = entry;
    
    const newName = req.body.name || id;
    
    // Проверяем уникальность нового имени (исключая текущее устройство)
    const existingDeviceWithSameName = Object.entries(devices).find(
      ([deviceId, d]) => deviceId !== id && d.name === newName
    );
    if (existingDeviceWithSameName) {
      return res.status(409).json({ error: 'Устройство с таким именем уже существует' });
    }
    
    targetDevice.name = newName;
    io.emit('devices/updated');
    saveDevicesJson(devices);
    res.json({ ok: true });
  });
  
  // DELETE /api/devices/:id - Удалить устройство (только admin)
  router.delete('/:id', requireAdmin, deleteLimiter, async (req, res) => {
    const rawId = getTrimmedDeviceId(req.params.id);
    const entry = resolveDeviceEntry(req.params.id, devices);
    
    if (!rawId || isReservedObjectKey(rawId)) {
      return res.status(400).json({ error: 'Неверный ID устройства' });
    }

    if (!entry) {
      return res.status(404).json({ error: 'Не найдено' });
    }

    const { deviceId: id, device: d } = entry;
    
    logDevice('info', `Deleting device`, { deviceId: id, folder: d.folder });
    
    // Останавливаем рестримы устройства
    try {
      const deviceMeta = await getDeviceFilesMetadata(id);
      deviceMeta
        .filter(meta => meta.content_type === 'streaming')
        .forEach(meta => removeStreamJob(id, meta.safe_name, 'device_deleted'));
    } catch (err) {
      logger.warn('[Devices] Failed to stop streams before delete', { deviceId: id, error: err.message });
    }

    // 1. Удаляем из БД
    deleteDeviceFromDB(id);
    logDevice('info', `Device deleted from DB`, { deviceId: id });
    
    // 1.5. Удаляем метаданные файлов устройства
    const deletedMetadata = await deleteDeviceFilesMetadata(id);
    logDevice('info', `Device files metadata deleted`, { deviceId: id, filesCount: deletedMetadata });
    
    // 2. Удаляем папку устройства
    // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
    const devicesPath = getDevicesPath();
    const folderName = typeof d.folder === 'string' && d.folder.trim() ? d.folder : id;
    let safeDevicePath = null;

    try {
      safeDevicePath = validatePath(path.resolve(devicesPath, folderName), devicesPath);
    } catch (err) {
      logDevice('warn', `Skipping unsafe device folder path during delete`, {
        deviceId: id,
        folder: folderName,
        error: err.message
      });
    }

    if (safeDevicePath) {
      logDevice('info', `Deleting device folder`, { deviceId: id, path: safeDevicePath });
      try {
        await storage.rm(toStorageKey(safeDevicePath));
        logDevice('info', `Device folder deleted from storage`, { deviceId: id, path: safeDevicePath });
      } catch { /* fallback to fs */ }
      try {
        if (fs.existsSync(safeDevicePath)) {
          fs.rmSync(safeDevicePath, { recursive: true, force: true });
          logDevice('info', `Device folder deleted from filesystem`, { deviceId: id, path: safeDevicePath });
        }
      } catch (err) {
        logDevice('error', `Failed to delete device folder`, { deviceId: id, path: safeDevicePath, error: err.message });
      }
    } else {
      logDevice('warn', `Device folder path unresolved, skipping`, { deviceId: id, folder: folderName });
    }
    
    // 3. Удаляем из devices (память)
    for (const key of Object.keys(devices)) {
      if (key === id) {
        delete devices[key];
        break;
      }
    }
    logDevice('info', `Device removed from memory`, { deviceId: id });
    if (typeof onDeviceDeleted === 'function') {
      try {
        onDeviceDeleted(id);
      } catch (err) {
        logger.warn('[Devices] onDeviceDeleted hook failed', { deviceId: id, error: err.message });
      }
    }
    
    // 4. Удаляем из fileNamesMap
    let removedFileNames = false;
    for (const key of Object.keys(fileNamesMap)) {
      if (key === id) {
        const fileCount = Object.keys(fileNamesMap[key] || {}).length;
        logDevice('info', `Deleting file names from map`, { deviceId: id, fileCount });
        delete fileNamesMap[key];
        removedFileNames = true;
        break;
      }
    }
    if (removedFileNames) {
      saveFileNamesMap(fileNamesMap);
    }
    
    // 5. Уведомляем клиентов
    io.emit('devices/updated');
    
    // Audit log
    await auditLog({
      userId: req.user.id,
      action: AuditAction.DEVICE_DELETE,
      resource: `device:${id}`,
      details: { 
        deviceId: id, 
        deviceName: d.name, 
        folder: d.folder,
        deletedBy: req.user.username 
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      status: 'success'
    });
    logDevice('warn', 'Device deleted completely', { deviceId: id, deletedBy: req.user.username });
    
    res.json({ ok: true });
  });
  
  // POST /api/devices/:id/launch-app - Запустить Android-приложение на устройстве
  router.post('/:id/launch-app', requireSpeaker, async (req, res) => {
    const entry = resolveDeviceEntry(req.params.id, devices);
    if (!entry) {
      return res.status(404).json({ ok: false, error: 'Устройство не найдено' });
    }

    const { deviceId: id, device } = entry;

    // Speaker может запускать только на назначенных ему устройствах.
    if (!hasDeviceAccess(req.user.userId, id, req.user.role)) {
      return res.status(403).json({ ok: false, error: 'Доступ к устройству запрещен' });
    }

    if (!device.ipAddress) {
      return res.status(400).json({ ok: false, error: 'IP адрес устройства не задан' });
    }
    try {
      const adbPort = await resolveDeviceAdbPort(id, device);
      const result = await launchAndroidApp(
        device.ipAddress,
        ANDROID_PACKAGE_NAME,
        ANDROID_MAIN_ACTIVITY,
        adbPort
      );
      if (result.ok) {
        return res.json({ ok: true });
      } else {
        return res.status(500).json({ ok: false, error: result.error });
      }
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /**
   * Список id из запроса: null означает «все Android-устройства».
   * Пустой массив приравниваем к null, чтобы не получить пустую операцию.
   */
  function readRequestedDeviceIds(rawIds) {
    if (rawIds === undefined || rawIds === null) {
      return { ok: true, ids: null };
    }
    if (!Array.isArray(rawIds)) {
      return { ok: false, error: 'Поле deviceIds должно быть массивом' };
    }
    if (rawIds.some(id => typeof id !== 'string' || id.length > 64)) {
      return { ok: false, error: 'Некорректный список устройств' };
    }
    return { ok: true, ids: rawIds.length > 0 ? rawIds : null };
  }

  // POST /api/devices/power — усыпить, разбудить или перезапустить плеер.
  //
  // Устройства стоят в стене, их нельзя обесточить, поэтому здесь только сон,
  // пробуждение и перезапуск плеера (см. utils/adb и utils/power-control).
  // «Запустить плеер» на живом плеере дублировал окно, поэтому сначала старый
  // процесс убивается (am force-stop) и только потом поднимается новый.
  // Одна кнопка на весь зал: если часть приставок не отвечает по ADB,
  // остальные всё равно выполняют команду, а тост покажет, кто не сработал.
  router.post('/power', requireAdmin, async (req, res) => {
    const action = String(req.body?.action || '').trim();
    if (!POWER_ACTIONS.includes(action)) {
      return res.status(400).json({ ok: false, error: 'Укажите action: sleep или wake' });
    }

    const requested = readRequestedDeviceIds(req.body?.deviceIds);
    if (!requested.ok) {
      return res.status(400).json({ ok: false, error: requested.error });
    }

    const plan = planPowerTargets(devices, requested.ids);
    for (const target of plan.targets) {
      target.port = await resolveDeviceAdbPort(target.deviceId, devices[target.deviceId]);
    }

    let outcome;
    try {
      outcome = await runPowerAction(plan.targets, action, {
        relaunch: req.body?.relaunch !== false,
        storeMac: (deviceId, mac) => updateDeviceMacAddress(deviceId, mac)
      });
    } catch (e) {
      logger.error('[Power] Ошибка команды питания:', e);
      return res.status(500).json({ ok: false, error: e.message });
    }

    const results = [...outcome.results, ...plan.rejected];

    // Другие вкладки узнают о смене состояния сразу, без опроса. Заодно
    // пишем его в хранилище, чтобы «спит/активен» был виден и тем, кто
    // откроет панель позже. Перезапуск плеера (launch) режим питания не
    // меняет — хранимое состояние и рассылку не трогаем.
    for (const result of outcome.results) {
      if (!result.ok) continue;
      if (action === 'sleep' || action === 'wake') {
        setStoredPowerState(result.deviceId, action === 'wake');
        io.emit('devices/power', { deviceId: result.deviceId, awake: action === 'wake' });
      }
    }

    res.json({
      ok: true,
      action,
      results,
      summary: {
        total: results.length,
        succeeded: outcome.succeeded,
        failed: results.length - outcome.succeeded
      }
    });
  });

  // POST /api/devices/power-state — состояние питания для бейджа «спит».
  //
  // Опрос по ADB стоит дорого (connect на каждое устройство), поэтому клиент
  // вызывает его точечно, а не на каждый рендер списка.
  router.post('/power-state', requireAuth, async (req, res) => {
    const requested = readRequestedDeviceIds(req.body?.deviceIds);
    if (!requested.ok) {
      return res.status(400).json({ ok: false, error: requested.error });
    }

    const plan = planPowerTargets(devices, requested.ids);

    // Спикер видит только назначенные ему устройства, как и в GET /.
    if (req.user.role !== 'admin') {
      const allowed = new Set(await getUserDevices(req.user.userId));
      plan.targets = plan.targets.filter(target => allowed.has(target.deviceId));
      plan.rejected = plan.rejected.filter(item => allowed.has(item.deviceId));
    }

    for (const target of plan.targets) {
      target.port = await resolveDeviceAdbPort(target.deviceId, devices[target.deviceId]);
    }

    const states = await Promise.all(plan.targets.map(async (target) => {
      // MAC узнаём заодно: он нужен для Wake-on-LAN, когда устройство уже
      // уснёт и ADB-будильник больше не сработает.
      const learnMac = target.mac
        ? Promise.resolve(null)
        : getDeviceMac(target.ip, target.port, 8000)
            .then(async (result) => {
              if (result.ok && result.mac) {
                await updateDeviceMacAddress(target.deviceId, result.mac);
              }
              return result;
            })
            .catch(() => null);

      const state = await getPowerState(target.ip, target.port, 8000);
      await learnMac;

      if (!state.ok) {
        logger.warn('[Power] Не удалось получить состояние питания', {
          deviceId: target.deviceId,
          error: state.error
        });
        return { deviceId: target.deviceId, ok: false, awake: null, screenOn: null, error: state.error };
      }
      return { deviceId: target.deviceId, ok: true, awake: state.awake, screenOn: state.screenOn };
    }));

    // Опрос обновляет хранимое состояние и рассылает его остальным панелям,
    // только если оно реально изменилось — команды «спит/активен» от других
    // вкладок доходят через devices/power и без этого.
    for (const state of states) {
      if (!state.ok) continue;
      const prev = getStoredPowerAwake(state.deviceId);
      setStoredPowerState(state.deviceId, state.awake);
      if (prev !== state.awake) {
        io.emit('devices/power', { deviceId: state.deviceId, awake: state.awake });
      }
    }

    res.json({ ok: true, states });
  });

  return router;
}

