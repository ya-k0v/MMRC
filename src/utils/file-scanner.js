/**
 * Утилиты для сканирования файлов устройств
 * @module utils/file-scanner
 */

import fs from 'fs';
import path from 'path';
import { DEVICES } from '../config/constants.js';
import { isSystemFile } from './sanitize.js';

/**
 * Сканирует папку устройства и возвращает список файлов и папок
 * @param {string} deviceId - ID устройства
 * @param {string} deviceFolder - Путь к папке устройства
 * @param {Object} fileNamesMap - Маппинг оригинальных имен файлов
 * @returns {{files: string[], fileNames: string[]}}
 */
export function scanDeviceFiles(deviceId, deviceFolder, fileNamesMap = {}) {
  const result = [];
  const fileNames = [];
  
  if (!fs.existsSync(deviceFolder)) {
    return { files: result, fileNames };
  }
  
  const entries = fs.readdirSync(deviceFolder);
  
  for (const entry of entries) {
    const entryPath = path.join(deviceFolder, entry);
    const stat = fs.statSync(entryPath);
    
    if (stat.isFile()) {
      // Пропускаем системные файлы (default.*, .optimizing_*, .tmp_*, etc.)
      if (!isSystemFile(entry)) {
        result.push(entry);
        // Используем оригинальное имя если есть маппинг
        const originalName = fileNamesMap[deviceId]?.[entry] || entry;
        fileNames.push(originalName);
      }
    } else if (stat.isDirectory()) {
      // Обрабатываем папки
      const folderContents = fs.readdirSync(entryPath);
      
      // Проверяем папки PDF/PPTX
      const pdfPptx = folderContents.find(f => /\.(pdf|pptx)$/i.test(f));
      
      if (pdfPptx) {
        // Папка с PDF/PPTX - добавляем файл с расширением
        result.push(pdfPptx);
        // Маппинг может быть по имени папки или файла
        const originalName = fileNamesMap[deviceId]?.[entry] || fileNamesMap[deviceId]?.[pdfPptx] || pdfPptx;
        fileNames.push(originalName);
      } else {
        // Проверяем папки с изображениями
        const hasImages = folderContents.some(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f));
        if (hasImages) {
          // Это папка с изображениями - добавляем имя папки
          result.push(entry);
          // Используем оригинальное имя если есть маппинг
          const originalName = fileNamesMap[deviceId]?.[entry] || entry;
          fileNames.push(originalName);
        }
      }
    }
  }
  
  return { files: result, fileNames };
}

/**
 * Обновляет список файлов устройства
 * @param {Object} devices - Объект devices
 * @param {string} deviceId - ID устройства
 * @param {Object} fileNamesMap - Маппинг оригинальных имен
 */
export function updateDeviceFiles(devices, deviceId, fileNamesMap = {}) {
  const device = devices[deviceId];
  if (!device) return;
  
  const deviceFolder = path.join(DEVICES, device.folder);
  const { files, fileNames } = scanDeviceFiles(deviceId, deviceFolder, fileNamesMap);
  
  device.files = files;
  device.fileNames = fileNames;
}

