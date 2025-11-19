/**
 * Сохранение и восстановление состояния устройств
 */
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

const STATE_FILE = './config/device-state.json';

/**
 * Сохранить состояние устройств в файл
 */
export function saveDeviceState(devices) {
  try {
    const state = {};
    for (const [deviceId, device] of Object.entries(devices)) {
      if (device.current) {
        state[deviceId] = device.current;
      }
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    logger.error('Error saving device state', { error: error.message, stack: error.stack });
  }
}

/**
 * Загрузить состояние устройств из файла
 */
export function loadDeviceState(devices) {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      for (const [deviceId, current] of Object.entries(state)) {
        if (devices[deviceId]) {
          devices[deviceId].current = current;
        }
      }
      logger.info('✅ Device state restored from file', { devicesCount: Object.keys(state).length });
    }
  } catch (error) {
    logger.error('Error loading device state', { error: error.message, stack: error.stack });
  }
}

/**
 * Периодически сохранять состояние (каждые 30 секунд)
 */
export function startAutoSave(devices, interval = 30000) {
  return setInterval(() => {
    saveDeviceState(devices);
  }, interval);
}

