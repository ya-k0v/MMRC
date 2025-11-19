/**
 * Управление устройствами через SQLite
 * @module storage/devices-storage-sqlite
 */

import fs from 'fs';
import path from 'path';
import { 
  getAllDevices, 
  saveDevice, 
  deleteDevice,
  getAllFileNames,
  saveFileName,
  deleteDeviceFileNames
} from '../database/database.js';
import { DEVICES } from '../config/constants.js';
import { scanDeviceFiles } from '../utils/file-scanner.js';
import logger from '../utils/logger.js';

/**
 * Загрузить устройства из БД
 * @returns {Object} devices
 */
export function loadDevicesFromDB() {
  logger.info('[DB] 📂 Loading devices from SQLite...');
  const devices = getAllDevices();
  logger.info(`[DB] ✅ Loaded ${Object.keys(devices).length} devices`, { count: Object.keys(devices).length });
  return devices;
}

/**
 * Сохранить устройства в БД
 * @param {Object} devices 
 */
export function saveDevicesToDB(devices) {
  for (const [deviceId, data] of Object.entries(devices)) {
    saveDevice(deviceId, data);
  }
  logger.info(`[DB] ✅ Saved ${Object.keys(devices).length} devices`, { count: Object.keys(devices).length });
}

/**
 * Загрузить маппинг имен файлов из БД
 * @returns {Object} fileNamesMap
 */
export function loadFileNamesFromDB() {
  logger.info('[DB] 📂 Loading file names from SQLite...');
  const fileNamesMap = getAllFileNames();
  const totalFiles = Object.values(fileNamesMap).reduce((sum, dev) => sum + Object.keys(dev).length, 0);
  logger.info(`[DB] ✅ Loaded ${totalFiles} file name mappings`, { totalFiles });
  return fileNamesMap;
}

/**
 * Сохранить маппинг имен файлов в БД
 * @param {Object} fileNamesMap 
 */
export function saveFileNamesToDB(fileNamesMap) {
  let total = 0;
  for (const [deviceId, mappings] of Object.entries(fileNamesMap)) {
    for (const [safeName, originalName] of Object.entries(mappings)) {
      saveFileName(deviceId, safeName, originalName);
      total++;
    }
  }
  logger.info(`[DB] ✅ Saved ${total} file name mappings`, { total });
}

/**
 * Сканировать все устройства
 * ПРИМЕЧАНИЕ: Функция scanDeviceFiles импортируется из ../utils/file-scanner.js
 * @param {Object} devices 
 * @param {Object} fileNamesMap 
 */
export function scanAllDevices(devices, fileNamesMap) {
  logger.info('[Scan] 🔍 Scanning all device folders...');
  
  for (const [deviceId, device] of Object.entries(devices)) {
    const deviceFolder = path.join(DEVICES, device.folder);
    const result = scanDeviceFiles(deviceId, deviceFolder, fileNamesMap);
    
    device.files = result.files;
    device.fileNames = result.fileNames;
    
    logger.info(`[Scan] ✅ ${deviceId}: ${result.files.length} files`, { deviceId, filesCount: result.files.length });
  }
  
  logger.info('[Scan] ✅ All devices scanned', { devicesCount: Object.keys(devices).length });
}

