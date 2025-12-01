/**
 * API Routes для управления устройствами (CRUD)
 * @module routes/devices
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { DEVICES } from '../config/constants.js';
import { sanitizeDeviceId } from '../utils/sanitize.js';
import { deleteDevice as deleteDeviceFromDB, deleteDeviceFileNames } from '../database/database.js';
import { createLimiter, deleteLimiter } from '../middleware/rate-limit.js';
import { auditLog, AuditAction } from '../utils/audit-logger.js';
import logger, { logDevice } from '../utils/logger.js';
import { deleteDeviceFilesMetadata, getDeviceFilesMetadata } from '../database/files-metadata.js';
import { removeStreamJob } from '../streams/stream-manager.js';

const router = express.Router();

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
    onDeviceCreated,
    onDeviceDeleted
  } = deps;
  
  // GET /api/devices - Получить список всех устройств (доступно speaker)
  router.get('/', (req, res) => {
    res.json(Object.entries(devices).map(([id, d]) => ({
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
    })));
  });
  
  // POST /api/devices - Создать новое устройство (только admin)
  router.post('/', requireAdmin, createLimiter, async (req, res) => {
    const { device_id, name } = req.body;
    
    if (!device_id) {
      return res.status(400).json({ error: 'device_id required' });
    }
    
    if (devices[device_id]) {
      return res.status(409).json({ error: 'exists' });
    }
    
    const devicePath = path.join(DEVICES, device_id);
    fs.mkdirSync(devicePath, { recursive: true });
    
    // КРИТИЧНО: Устанавливаем права 755 на папку устройства
    // Чтобы Nginx (www-data) мог читать файлы
    try {
      fs.chmodSync(devicePath, 0o755);
      logDevice('info', `Device folder created with permissions 755`, { deviceId: device_id, path: devicePath });
    } catch (e) {
      logDevice('warn', `Failed to set permissions on device folder`, { deviceId: device_id, path: devicePath, error: e.message });
    }
    
    devices[device_id] = { 
      name: name || device_id, 
      folder: device_id, 
      files: [], 
      current: { type: 'idle', file: null, state: 'idle' } 
    };
    
    if (typeof onDeviceCreated === 'function') {
      try {
        onDeviceCreated(device_id);
      } catch (err) {
        logger.warn('[Devices] onDeviceCreated hook failed', { deviceId: device_id, error: err.message });
      }
    }
    
    io.emit('devices/updated');
    saveDevicesJson(devices);
    
    // Audit log
    await auditLog({
      userId: req.user.id,
      action: AuditAction.DEVICE_CREATE,
      resource: `device:${device_id}`,
      details: { deviceId: device_id, name: name || device_id, createdBy: req.user.username },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      status: 'success'
    });
    logDevice('info', 'Device created', { deviceId: device_id, name: name || device_id, createdBy: req.user.username });
    
    res.json({ ok: true });
  });
  
  // POST /api/devices/:id/rename - Переименовать устройство (только admin)
  router.post('/:id/rename', requireAdmin, (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'invalid device id' });
    }
    
    if (!devices[id]) {
      return res.status(404).json({ error: 'not found' });
    }
    
    devices[id].name = req.body.name || id;
    io.emit('devices/updated');
    saveDevicesJson(devices);
    res.json({ ok: true });
  });
  
  // DELETE /api/devices/:id - Удалить устройство (только admin)
  router.delete('/:id', requireAdmin, deleteLimiter, async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'invalid device id' });
    }
    
    const d = devices[id];
    if (!d) {
      return res.status(404).json({ error: 'not found' });
    }
    
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
    const devicePath = path.join(DEVICES, d.folder);
    logDevice('info', `Deleting device folder`, { deviceId: id, path: devicePath });
    fs.rmSync(devicePath, { recursive: true, force: true });
    logDevice('info', `Device folder deleted`, { deviceId: id, path: devicePath });
    
    // 3. Удаляем из devices (память)
    delete devices[id];
    logDevice('info', `Device removed from memory`, { deviceId: id });
    if (typeof onDeviceDeleted === 'function') {
      try {
        onDeviceDeleted(id);
      } catch (err) {
        logger.warn('[Devices] onDeviceDeleted hook failed', { deviceId: id, error: err.message });
      }
    }
    
    // 4. Удаляем из fileNamesMap
    if (fileNamesMap[id]) {
      const fileCount = Object.keys(fileNamesMap[id]).length;
      logDevice('info', `Deleting file names from map`, { deviceId: id, fileCount });
      delete fileNamesMap[id];
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
  
  return router;
}

