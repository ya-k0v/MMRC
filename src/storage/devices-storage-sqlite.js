/**
 * Управление устройствами через SQLite
 * @module storage/devices-storage-sqlite
 */

import fs from 'node:fs';
import path from 'node:path';
import { 
  getAllDevices, 
  saveDevice, 
  deleteDevice,
  getAllFileNames,
  saveFileName,
  deleteDeviceFileNames
} from '../database/database.js';
import { getDevicesPath } from '../config/settings-manager.js';
import { scanDeviceFiles } from '../utils/file-scanner.js';
import logger from '../utils/logger.js';

export async function loadDevicesFromDB() {
  logger.info('[DB] Loading devices from database...');
  const devices = await getAllDevices();
  logger.info(`[DB] Loaded ${Object.keys(devices).length} devices`, { count: Object.keys(devices).length });
  return devices;
}

export async function saveDevicesToDB(devices) {
  for (const [deviceId, data] of Object.entries(devices)) {
    await saveDevice(deviceId, data);
  }
  logger.info(`[DB] Saved ${Object.keys(devices).length} devices`, { count: Object.keys(devices).length });
}

export async function loadFileNamesFromDB() {
  logger.info('[DB] Loading file names from database...');
  const fileNamesMap = await getAllFileNames();
  const totalFiles = Object.values(fileNamesMap).reduce((sum, dev) => sum + Object.keys(dev).length, 0);
  logger.info(`[DB] Loaded ${totalFiles} file name mappings`, { totalFiles });
  return fileNamesMap;
}

export async function saveFileNamesToDB(fileNamesMap) {
  let total = 0;
  for (const [deviceId, mappings] of Object.entries(fileNamesMap)) {
    for (const [safeName, originalName] of Object.entries(mappings)) {
      await saveFileName(deviceId, safeName, originalName);
      total++;
    }
  }
  logger.info(`[DB] Saved ${total} file name mappings`, { total });
}

export function scanAllDevices(devices, fileNamesMap) {
  logger.info('[Scan] Scanning all device folders...');
  const devicesPath = getDevicesPath();
  for (const [deviceId, device] of Object.entries(devices)) {
    const deviceFolder = path.join(devicesPath, device.folder);
    const result = scanDeviceFiles(deviceId, deviceFolder, fileNamesMap);
    device.files = result.files;
    device.fileNames = result.fileNames;
    logger.info(`[Scan] ${deviceId}: ${result.files.length} files`, { deviceId, filesCount: result.files.length });
  }
  logger.info('[Scan] All devices scanned', { devicesCount: Object.keys(devices).length });
}
