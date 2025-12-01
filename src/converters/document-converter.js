/**
 * Конвертация PDF и PPTX документов в изображения
 * @module converters/document-converter
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { fromPath } from 'pdf2pic';
import { PDFDocument } from 'pdf-lib';
import { DEVICES } from '../config/constants.js';
import logger from '../utils/logger.js';

const execAsync = util.promisify(exec);

/**
 * Получить количество страниц в PDF
 * @param {string} pdfPath - Путь к PDF файлу
 * @returns {Promise<number>} Количество страниц
 */
export async function getPdfPageCount(pdfPath) {
  const pdfBytes = await fs.promises.readFile(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  return pdfDoc.getPageCount();
}

/**
 * Конвертировать PDF в изображения (PNG)
 * @param {string} pdfPath - Путь к PDF файлу
 * @param {string} outputDir - Папка для сохранения изображений
 * @returns {Promise<number>} Количество конвертированных страниц
 */
export async function convertPdfToImages(pdfPath, outputDir) {
  const options = {
    density: 150,
    saveFilename: "page",
    savePath: outputDir,
    format: "png",
    width: 1920,
    height: 1080,
  };
  
  const convert = fromPath(pdfPath, options);
  const pageCount = await getPdfPageCount(pdfPath);
  
  for (let i = 1; i <= pageCount; i++) {
    await convert(i);
  }
  
  return pageCount;
}

/**
 * Конвертировать PPTX в изображения (через PDF)
 * @param {string} pptxPath - Путь к PPTX файлу
 * @param {string} outputDir - Папка для сохранения изображений
 * @returns {Promise<number>} Количество конвертированных слайдов
 */
export async function convertPptxToImages(pptxPath, outputDir) {
  const fileNameWithoutExt = path.basename(pptxPath, path.extname(pptxPath));
  const pdfPath = path.join(outputDir, `${fileNameWithoutExt}.pdf`);
  
  try {
    // Конвертируем PPTX в PDF через LibreOffice
    await execAsync(`soffice --headless --convert-to pdf --outdir "${outputDir}" "${pptxPath}"`);
    
    // Проверяем что PDF создан
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`PDF не создан: ${pdfPath}`);
    }
    
    // Конвертируем PDF в изображения
    const numPages = await convertPdfToImages(pdfPath, outputDir);
    
    // Удаляем временный PDF
    fs.unlinkSync(pdfPath);
    
    return numPages;
  } catch (error) {
    logger.error(`[Converter] ❌ PPTX конвертация failed`, { error: error.message, stack: error.stack, pptxPath });
    throw error;
  }
}

/**
 * Найти папку с конвертированными файлами
 * @param {string} deviceId - ID устройства
 * @param {string} fileName - Имя файла (PDF/PPTX)
 * @returns {string|null} Путь к папке или null
 */
export function findFileFolder(deviceId, fileName) {
  const deviceFolder = path.join(DEVICES, deviceId);
  if (!fs.existsSync(deviceFolder)) return null;
  
  const folderName = fileName.replace(/\.(pdf|pptx)$/i, '');
  const possibleFolder = path.join(deviceFolder, folderName);
  
  if (fs.existsSync(possibleFolder) && fs.statSync(possibleFolder).isDirectory()) {
    const folderContents = fs.readdirSync(possibleFolder);
    if (folderContents.includes(fileName)) {
      return possibleFolder;
    }
  }
  
  const filePath = path.join(deviceFolder, fileName);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return null;
  
  return null;
}

/**
 * Получить количество конвертированных слайдов/страниц
 * @param {string} deviceId - ID устройства
 * @param {string} fileName - Имя файла (PDF/PPTX)
 * @returns {Promise<number>} Количество слайдов
 */
export async function getPageSlideCount(deviceId, fileName) {
  try {
    const convertedDir = findFileFolder(deviceId, fileName);
    if (!convertedDir) return 0;
    
    const pngFiles = fs.readdirSync(convertedDir)
      .filter(f => f.toLowerCase().endsWith('.png'))
      .sort();
    
    return pngFiles.length;
  } catch {
    return 0;
  }
}

/**
 * Автоматическая конвертация PDF/PPTX файла в изображения
 * @param {string} deviceId - ID устройства
 * @param {string} fileName - Имя файла
 * @param {Object} devices - Объект devices
 * @param {Object} fileNamesMap - Маппинг имен файлов
 * @param {Function} saveFileNamesMapFn - Функция сохранения маппинга
 * @returns {Promise<number>} Количество конвертированных страниц/слайдов
 */
export async function autoConvertFile(deviceId, fileName, devices, fileNamesMap, saveFileNamesMapFn, io = null) {
  const d = devices[deviceId];
  if (!d) return 0;
  
  const deviceFolder = path.join(DEVICES, d.folder);
  const filePath = path.join(deviceFolder, fileName);
  
  if (!fs.existsSync(filePath)) return 0;
  
  const ext = path.extname(fileName).toLowerCase();
  if (ext !== '.pdf' && ext !== '.pptx') return 0;
  
  // Отправляем событие начала обработки
  if (io) {
    io.emit('file/processing', { device_id: deviceId, file: fileName, type: ext.substring(1) });
    logger.info(`[Converter] 📄 Начало конвертации: ${fileName}`, { deviceId, fileName });
  }
  
  const folderName = fileName.replace(/\.(pdf|pptx)$/i, '');
  const convertedDir = path.join(deviceFolder, folderName);
  const originalName = fileNamesMap[deviceId]?.[fileName] || fileName;
  
  // Проверяем есть ли уже конвертированные файлы
  const existing = fs.existsSync(convertedDir) && fs.statSync(convertedDir).isDirectory()
    ? fs.readdirSync(convertedDir).filter(f => f.toLowerCase().endsWith('.png')).length
    : 0;
  
  if (existing > 0) {
    // Файлы уже конвертированы, сохраняем маппинг если нужно
    if (!fileNamesMap[deviceId]) fileNamesMap[deviceId] = {};
    if (!fileNamesMap[deviceId][folderName]) {
      fileNamesMap[deviceId][folderName] = originalName;
      saveFileNamesMapFn(fileNamesMap);
    }
    
    // Отправляем событие готовности (файл уже был конвертирован)
    if (io) {
      io.emit('file/ready', { device_id: deviceId, file: fileName, pages: existing });
      logger.info(`[Converter] ✅ Уже конвертирован: ${fileName} (${existing} страниц)`, { deviceId, fileName, pages: existing });
    }
    
    return existing;
  }
  
  try {
    // Создаем папку для конвертированных файлов
    if (!fs.existsSync(convertedDir)) {
      fs.mkdirSync(convertedDir, { recursive: true });
    }
    
    // Перемещаем оригинальный файл в папку
    const movedFilePath = path.join(convertedDir, fileName);
    if (!fs.existsSync(movedFilePath)) {
      fs.renameSync(filePath, movedFilePath);
    }
    
    // Сохраняем маппинг имен
    if (!fileNamesMap[deviceId]) fileNamesMap[deviceId] = {};
    fileNamesMap[deviceId][folderName] = originalName;
    fileNamesMap[deviceId][fileName] = originalName;
    saveFileNamesMapFn(fileNamesMap);
    
    // Конвертируем в изображения
    let count = 0;
    if (ext === '.pptx') {
      count = await convertPptxToImages(movedFilePath, convertedDir);
    } else if (ext === '.pdf') {
      count = await convertPdfToImages(movedFilePath, convertedDir);
    }
    
    // Отправляем событие успешной конвертации
    if (io && count > 0) {
      io.emit('file/ready', { device_id: deviceId, file: fileName, pages: count });
      logger.info(`[Converter] ✅ Конвертировано: ${fileName} (${count} страниц)`, { deviceId, fileName, pages: count });
      
      // КРИТИЧНО: Обновляем список файлов (PPTX превратился в папку)
      io.emit('devices/updated');
    }
    
    return count;
    
  } catch (error) {
    logger.error(`[Converter] ❌ Ошибка конвертации ${fileName}`, { error: error.message, stack: error.stack, deviceId, fileName });
    
    // Отправляем событие ошибки
    if (io) {
      io.emit('file/error', { 
        device_id: deviceId, 
        file: fileName, 
        error: error.message || String(error) 
      });
    }
    
    // Откатываем изменения при ошибке
    const movedFilePath = path.join(convertedDir, fileName);
    if (fs.existsSync(movedFilePath) && !fs.existsSync(filePath)) {
      try {
        fs.renameSync(movedFilePath, filePath);
      } catch (rollbackError) {
        logger.error(`[Converter] ⚠️ Ошибка отката`, { error: rollbackError.message, stack: rollbackError.stack, deviceId, fileName });
      }
    }
    
    return 0;
  }
}

