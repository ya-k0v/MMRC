/**
 * Конвертация PDF и PPTX документов в изображения
 * @module converters/document-converter
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { getDataRoot, getDevicesPath } from '../config/settings-manager.js';
import { DOCKER_TAG, DOCKER_IMAGES } from '../config/constants.js';
import { execWithGuard } from '../utils/exec-with-guard.js';
import { setFileStatus } from '../video/file-status.js';
import { createModuleLogger } from '../utils/logger.js';
const logger = createModuleLogger('convert');
import { validatePath } from '../utils/path-validator.js';

const execFileAsync = promisify(execFile);

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
 * Получить размеры страницы PDF
 * @param {string} pdfPath - Путь к PDF файлу
 * @param {number} pageIndex - Индекс страницы (0-based, по умолчанию 0)
 * @returns {Promise<{width: number, height: number, aspectRatio: number}>}
 */
export async function getPdfPageSize(pdfPath, pageIndex = 0) {
  try {
    const pdfBytes = await fs.promises.readFile(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const page = pdfDoc.getPage(pageIndex);
    const { width, height } = page.getSize();
    const aspectRatio = width / height;
    
    return { width, height, aspectRatio };
  } catch (error) {
    logger.warn(`[Converter] Не удалось получить размеры страницы, используем значения по умолчанию`, { 
      error: error.message, 
      pdfPath 
    });
    // Возвращаем стандартный A4 (595x842 points при 72 DPI)
    return { width: 595, height: 842, aspectRatio: 595 / 842 };
  }
}

/**
 * Конвертировать PDF в изображения (PNG) с сохранением пропорций
 * @param {string} pdfPath - Путь к PDF файлу
 * @param {string} outputDir - Папка для сохранения изображений
 * @returns {Promise<number>} Количество конвертированных страниц
 */
export async function convertPdfToImages(pdfPath, outputDir, onProgress = null) {
  const dataRoot = getDataRoot();
  const safeOutputDir = validatePath(path.resolve(outputDir), dataRoot);
  const safePdfPath = validatePath(path.resolve(pdfPath), dataRoot);

  const pageSize = await getPdfPageSize(safePdfPath, 0);
  const { aspectRatio } = pageSize;

  const MAX_WIDTH = 1920;
  const MAX_HEIGHT = 1080;
  const MAX_ASPECT_RATIO = MAX_WIDTH / MAX_HEIGHT;

  let targetWidth, targetHeight;

  if (aspectRatio > 1) {
    if (aspectRatio >= 1.6 && aspectRatio <= 1.9) {
      targetWidth = MAX_WIDTH;
      targetHeight = MAX_HEIGHT;
      logger.info(`[Converter] Ландшафтный формат ${aspectRatio.toFixed(2)}:1, используем ${targetWidth}x${targetHeight}`);
    } else if (aspectRatio > MAX_ASPECT_RATIO) {
      targetWidth = MAX_WIDTH;
      targetHeight = Math.round(MAX_WIDTH / aspectRatio);
      logger.info(`[Converter] Широкий формат ${aspectRatio.toFixed(2)}:1, используем ${targetWidth}x${targetHeight}`);
    } else {
      targetHeight = MAX_HEIGHT;
      targetWidth = Math.round(MAX_HEIGHT * aspectRatio);
      logger.info(`[Converter] Ландшафтный формат ${aspectRatio.toFixed(2)}:1, используем ${targetWidth}x${targetHeight}`);
    }
  } else {
    targetHeight = MAX_HEIGHT;
    targetWidth = Math.round(MAX_HEIGHT * aspectRatio);
    logger.info(`[Converter] Портретный формат ${(1/aspectRatio).toFixed(2)}:1, используем ${targetWidth}x${targetHeight}`);
  }

  const pageCount = await getPdfPageCount(safePdfPath);
  logger.info(`[Converter] Начало конвертации PDF: ${pageCount} страниц, целевой размер: ${targetWidth}x${targetHeight}`);

  const density = 150;
  const convertedPages = [];
  for (let i = 1; i <= pageCount; i++) {
    let tempFile = null;
    try {
      const imagePath = path.join(safeOutputDir, `page.${i}.png`);

      tempFile = path.join(os.tmpdir(), `mmrc-pdf-${crypto.randomUUID()}-p${i}.png`);

      await execFileAsync('gs', [
        '-dNOPAUSE', '-dBATCH', '-dSAFER',
        '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
        '-sDEVICE=png16m',
        `-r${density}`,
        `-dFirstPage=${i}`, `-dLastPage=${i}`,
        `-sOutputFile=${tempFile}`,
        safePdfPath
      ]);

      await sharp(tempFile)
        .resize(targetWidth, targetHeight, {
          fit: 'inside',
          withoutEnlargement: true,
          kernel: 'lanczos3'
        })
        .png()
        .toFile(imagePath);

      const stats = fs.statSync(imagePath);
      if (stats.size > 100) {
        convertedPages.push({ page: i, path: imagePath });
        logger.info(`[Converter] ✅ Страница ${i} конвертирована: ${imagePath} (${(stats.size / 1024).toFixed(2)} KB)`);
        if (onProgress) {
          const pct = Math.max(0, Math.min(99, Math.round((i / pageCount) * 99)));
          onProgress(pct);
        }
      } else {
        logger.warn(`[Converter] ⚠️ Страница ${i}: файл слишком мал: ${imagePath}`);
      }
    } catch (error) {
      logger.error(`[Converter] ❌ Ошибка конвертации страницы ${i}`, {
        error: error.message,
        stack: error.stack,
        page: i
      });
    } finally {
      if (tempFile) {
        try { fs.unlinkSync(tempFile); } catch {}
      }
    }
  }

  if (convertedPages.length === 0) {
    throw new Error(`Не удалось конвертировать ни одной страницы из ${pageCount}`);
  }

  logger.info(`[Converter] Успешно конвертировано ${convertedPages.length} из ${pageCount} страниц`);

  for (const { page, path: imagePath } of convertedPages) {
    if (fs.existsSync(imagePath)) {
      try {
        const meta = await sharp(imagePath).metadata();
        logger.info(`[Converter] ✅ Изображение ${page} готово: ${meta.width}x${meta.height} (целевой: ${targetWidth}x${targetHeight})`);
      } catch (e) {
      }
    }
  }

  return pageCount;
}

/**
 * Конвертировать PPTX в изображения (через PDF)
 * @param {string} pptxPath - Путь к PPTX файлу
 * @param {string} outputDir - Папка для сохранения изображений
 * @returns {Promise<number>} Количество конвертированных слайдов
 */
export async function convertPptxToImages(pptxPath, outputDir, onProgress = null) {
  const dataRoot = getDataRoot();
  const safeOutputDir = validatePath(path.resolve(outputDir), dataRoot);
  const safePptxPath = validatePath(path.resolve(pptxPath), dataRoot);
  const fileNameWithoutExt = path.basename(safePptxPath, path.extname(safePptxPath));
  const pdfPath = path.join(safeOutputDir, `${fileNameWithoutExt}.pdf`);
  
  try {
    if (process.env.MMRC_DOCKER === '1') {
      await convertPptxToPdfViaDocker(safePptxPath, safeOutputDir);
    } else {
      await execWithGuard('converter', 'soffice', ['--headless', '--convert-to', 'pdf', '--outdir', safeOutputDir, safePptxPath]);
    }
    if (onProgress) onProgress(5);
    
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`PDF не создан: ${pdfPath}`);
    }
    
    const numPages = await convertPdfToImages(pdfPath, safeOutputDir, onProgress);
    
    fs.unlinkSync(pdfPath);
    
    return numPages;
  } catch (error) {
    logger.error(`[Converter] ❌ PPTX конвертация failed`, { error: error.message, stack: error.stack, pptxPath });
    throw error;
  }
}

async function convertPptxToPdfViaDocker(pptxPath, outputDir) {
  const hostDataDir = process.env.HOST_DATA_DIR || '/opt/mmrc/data';
  const converterImage = process.env.CONVERTER_IMAGE || DOCKER_IMAGES.converter;
  const imageTag = process.env.DOCKER_IMAGE_TAG || DOCKER_TAG;

  const dataRoot = getDataRoot();
  const converterPptxPath = pptxPath.replace(dataRoot, '/data');
  const converterOutputDir = outputDir.replace(dataRoot, '/data');

  await execWithGuard('converter', 'docker', [
    'run', '--rm',
    '-v', `${hostDataDir}:/data:rw`,
    `${converterImage}:${imageTag}`,
    '--convert-to', 'pdf',
    '--outdir', converterOutputDir,
    converterPptxPath,
  ]);
}

/**
 * Найти папку с конвертированными файлами
 * @param {string} deviceFolderOrId - Имя папки устройства или ID устройства (обычно совпадают)
 * @param {string} fileName - Имя файла (PDF/PPTX)
 * @returns {string|null} Путь к папке или null
 */
export function findFileFolder(deviceFolderOrId, fileName) {
  // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
  // Это важно, так как contentRoot может измениться через настройки
  const devicesPath = getDevicesPath();
  const deviceFolder = path.join(devicesPath, deviceFolderOrId);
  if (!fs.existsSync(deviceFolder)) return null;
  
  const ext = path.extname(fileName).toLowerCase();
  const folderName = fileName.replace(/\.(pdf|pptx)$/i, '');
  const possibleFolder = path.join(deviceFolder, folderName);
  
  // КРИТИЧНО: После конвертации исходный файл удаляется, поэтому проверяем только существование папки
  // и наличие PNG файлов внутри (признак успешной конвертации)
  if (fs.existsSync(possibleFolder) && fs.statSync(possibleFolder).isDirectory()) {
    const folderContents = fs.readdirSync(possibleFolder);
    // Проверяем наличие PNG файлов (признак успешной конвертации)
    const hasPngFiles = folderContents.some(f => f.toLowerCase().endsWith('.png'));
    if (hasPngFiles) {
      return possibleFolder;
    }
    // Если это PDF/PPTX и папка существует, но нет PNG - возможно конвертация еще идет
    // Возвращаем папку в любом случае, чтобы не блокировать запросы
    if (ext === '.pdf' || ext === '.pptx') {
      return possibleFolder;
    }
  }
  
  // Если передали имя папки напрямую (без расширения), проверяем его
  if (!ext || ext === '') {
    const directFolder = path.join(deviceFolder, fileName);
    if (fs.existsSync(directFolder) && fs.statSync(directFolder).isDirectory()) {
      return directFolder;
    }
  }
  
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
  
  // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
  // Это важно, так как contentRoot может измениться через настройки
  const devicesPath = getDevicesPath();
  const deviceFolder = path.join(devicesPath, d.folder);
  const filePath = path.join(deviceFolder, fileName);
  
  if (!fs.existsSync(filePath)) {
    logger.warn(`[Converter] ⚠️ Файл не найден: ${filePath}`, { deviceId, fileName, deviceFolder, devicesPath });
    return 0;
  }
  
  const ext = path.extname(fileName).toLowerCase();
  if (ext !== '.pdf' && ext !== '.pptx') return 0;
  const folderName = fileName.replace(/\.(pdf|pptx)$/i, '');
  
  // Отправляем событие начала обработки
  if (io) {
    io.emit('file/processing', { device_id: deviceId, file: fileName, type: ext.substring(1) });
    io.emit('file/progress', { device_id: deviceId, file: fileName, progress: 0 });
    logger.info(`[Converter] 📄 Начало конвертации: ${fileName}`, { deviceId, fileName });
  }
  setFileStatus(deviceId, fileName, { status: 'processing', progress: 0, canPlay: false }); // Используем fileName, а не folderName
  
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
    
    // КРИТИЧНО: Обновляем статус с fileName (не folderName), чтобы фронтенд мог найти файл
    setFileStatus(deviceId, fileName, { status: 'ready', progress: 100, canPlay: true });
    
    // Отправляем событие готовности (файл уже был конвертирован)
    if (io) {
      io.emit('file/progress', { device_id: deviceId, file: fileName, progress: 100 });
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
    
    // КРИТИЧНО: Конвертируем напрямую из исходного файла, затем удаляем его
    // Конвертация создаст изображения в convertedDir
    let count = 0;
    if (ext === '.pptx') {
      count = await convertPptxToImages(filePath, convertedDir, (progress) => {
        // КРИТИЧНО: Используем fileName для статуса (не folderName), чтобы фронтенд мог найти файл
        setFileStatus(deviceId, fileName, { status: 'processing', progress, canPlay: false });
        // Отправляем прогресс на каждое обновление (не только каждые 5%)
        if (io) {
          io.emit('file/progress', { device_id: deviceId, file: fileName, progress });
        }
      });
    } else if (ext === '.pdf') {
      count = await convertPdfToImages(filePath, convertedDir, (progress) => {
        // КРИТИЧНО: Используем fileName для статуса (не folderName), чтобы фронтенд мог найти файл
        setFileStatus(deviceId, fileName, { status: 'processing', progress, canPlay: false });
        // Отправляем прогресс на каждое обновление (не только каждые 5%)
        if (io) {
          io.emit('file/progress', { device_id: deviceId, file: fileName, progress });
        }
      });
    }
    
    // Удаляем исходный файл после успешной конвертации
    if (count > 0 && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        logger.info(`[Converter] 🗑️ Исходный файл удален: ${fileName}`, { deviceId, fileName });
      } catch (delErr) {
        logger.warn(`[Converter] ⚠️ Не удалось удалить исходный файл: ${fileName}`, { 
          error: delErr.message, 
          deviceId, 
          fileName 
        });
      }
    }
    
    // Сохраняем маппинг имен
    if (!fileNamesMap[deviceId]) fileNamesMap[deviceId] = {};
    fileNamesMap[deviceId][folderName] = originalName;
    // Удаляем маппинг для исходного файла, так как он удален
    if (fileNamesMap[deviceId][fileName]) {
      delete fileNamesMap[deviceId][fileName];
    }
    saveFileNamesMapFn(fileNamesMap);
    
    // Отправляем событие успешной конвертации
    if (io && count > 0) {
      // Отправляем финальный прогресс 100%
      io.emit('file/progress', { device_id: deviceId, file: fileName, progress: 100 });
      io.emit('file/ready', { device_id: deviceId, file: fileName, pages: count });
      logger.info(`[Converter] ✅ Конвертировано: ${fileName} (${count} страниц)`, { deviceId, fileName, pages: count });
      
      // КРИТИЧНО: Обновляем список файлов (PPTX превратился в папку)
      io.emit('devices/updated');
    }
    
    // КРИТИЧНО: Обновляем статус с fileName (не folderName), чтобы фронтенд мог найти файл
    setFileStatus(deviceId, fileName, { status: 'ready', progress: 100, canPlay: true });
    
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
      io.emit('file/progress', { device_id: deviceId, file: fileName, progress: 0 });
    }
    
    // КРИТИЧНО: Обновляем статус с fileName (не folderName), чтобы фронтенд мог найти файл
    setFileStatus(deviceId, fileName, { status: 'error', progress: 0, canPlay: false, error: error.message });
    
    // При ошибке исходный файл остается на месте (не удаляем его)
    
    return 0;
  }
}

