/**
 * API Routes для управления устройствами (CRUD)
 * @module routes/devices
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { getDevicesPath } from '../config/settings-manager.js';
import { sanitizeDeviceId } from '../utils/sanitize.js';
import { deleteDevice as deleteDeviceFromDB, deleteDeviceFileNames } from '../database/database.js';
import { createLimiter, deleteLimiter } from '../middleware/rate-limit.js';
import { auditLog, AuditAction } from '../utils/audit-logger.js';
import logger, { logDevice } from '../utils/logger.js';
import { deleteDeviceFilesMetadata, getDeviceFilesMetadata } from '../database/files-metadata.js';
import { removeStreamJob } from '../streams/stream-manager.js';
import { requireAuth } from '../middleware/auth.js';
import { getUserDevices, hasDeviceAccess } from '../middleware/device-access.js';
import { launchAndroidApp } from '../utils/adb-launcher.js';
import { validatePath } from '../utils/path-validator.js';

const router = express.Router();
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isReservedObjectKey(value) {
  return RESERVED_OBJECT_KEYS.has(String(value || ''));
}

function getTrimmedDeviceId(rawId) {
  if (typeof rawId !== 'string') {
    return '';
  }
  return rawId.trim();
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
    onDeviceDeleted
  } = deps;
  
  // GET /api/devices - Получить список всех устройств
  // Фильтрует устройства по доступу пользователя:
  // - admin: видит все устройства
  // - speaker: только назначенные устройства
  // - hero_admin: не имеет доступа к устройствам (своя панель)
  router.get('/', requireAuth, (req, res) => {
    // HERO ADMIN не имеет доступа к устройствам
    if (req.user.role === 'hero_admin') {
      return res.json([]);
    }

    let devicesList = Object.entries(devices).map(([id, d]) => ({
      device_id: id, 
      name: d.name, 
      folder: d.folder, 
      files: d.files, 
      fileNames: d.fileNames || d.files,
      fileMetadata: d.fileMetadata || [],
      current: d.current,
      deviceType: d.deviceType || 'browser',
      capabilities: d.capabilities || { 
        video: true, 
        audio: true, 
        images: true, 
        pdf: true, 
        pptx: true, 
        streaming: true 
      },
      platform: d.platform || 'Unknown',
      lastSeen: d.lastSeen || null,
      ipAddress: d.ipAddress || null
    }));

    // Если пользователь не admin, фильтруем по назначенным устройствам
    if (req.user.role !== 'admin') {
      const allowedDevices = getUserDevices(req.user.userId);
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
    fs.mkdirSync(devicePath, { recursive: true });
    
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
      const deviceMeta = getDeviceFilesMetadata(id);
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
    const deletedMetadata = deleteDeviceFilesMetadata(id);
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
        if (fs.existsSync(safeDevicePath)) {
          fs.rmSync(safeDevicePath, { recursive: true, force: true });
          logDevice('info', `Device folder deleted`, { deviceId: id, path: safeDevicePath });
        } else {
          logDevice('warn', `Device folder does not exist, skipping`, { deviceId: id, path: safeDevicePath });
        }
      } catch (err) {
        logDevice('error', `Failed to delete device folder`, { deviceId: id, path: safeDevicePath, error: err.message });
        // Продолжаем удаление, даже если папка не удалилась
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
    // Для вашего приложения:
    const packageName = 'com.videocontrol.mediaplayer'; // замените на актуальный packageName
    const activity = 'com.videocontrol.mediaplayer.MainActivity'; // замените на актуальный activity
    try {
      const result = await launchAndroidApp(device.ipAddress, packageName, activity);
      if (result.ok) {
        return res.json({ ok: true });
      } else {
        return res.status(500).json({ ok: false, error: result.error });
      }
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
  
  return router;
}

