/**
 * Конвертация PDF и PPTX документов в изображения
 * @module converters/document-converter
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';
import { fromPath } from 'pdf2pic';
import { PDFDocument } from 'pdf-lib';
import { getDataRoot, getDevicesPath } from '../config/settings-manager.js';
import { setFileStatus } from '../video/file-status.js';
import logger from '../utils/logger.js';
import { validatePath } from '../utils/path-validator.js';

const execFileAsync = util.promisify(execFile);

async function commandExists(command) {
  try {
    await execFileAsync('which', [command]);
    return true;
  } catch {
    return false;
  }
}

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

  // Получаем размеры первой страницы для определения пропорций
  const pageSize = await getPdfPageSize(safePdfPath, 0);
  const { width: pdfWidth, height: pdfHeight, aspectRatio } = pageSize;
  
  // Максимальные размеры для экрана (16:9)
  const MAX_WIDTH = 1920;
  const MAX_HEIGHT = 1080;
  const MAX_ASPECT_RATIO = MAX_WIDTH / MAX_HEIGHT; // 1.777...
  
  // Вычисляем целевые размеры с сохранением пропорций
  let targetWidth, targetHeight;
  
  if (aspectRatio > 1) {
    // Ландшафтная ориентация (ширина > высоты)
    if (aspectRatio >= 1.6 && aspectRatio <= 1.9) {
      // Близко к 16:9 или 16:10 - используем полный размер экрана
      targetWidth = MAX_WIDTH;
      targetHeight = MAX_HEIGHT;
      logger.info(`[Converter] Ландшафтный формат ${aspectRatio.toFixed(2)}:1, используем ${targetWidth}x${targetHeight}`);
    } else if (aspectRatio > MAX_ASPECT_RATIO) {
      // Широкий формат (например, 21:9) - ограничиваем по ширине
      targetWidth = MAX_WIDTH;
      targetHeight = Math.round(MAX_WIDTH / aspectRatio);
      logger.info(`[Converter] Широкий формат ${aspectRatio.toFixed(2)}:1, используем ${targetWidth}x${targetHeight}`);
    } else {
      // Обычный ландшафт (4:3, 3:2 и т.д.) - ограничиваем по высоте
      targetHeight = MAX_HEIGHT;
      targetWidth = Math.round(MAX_HEIGHT * aspectRatio);
      logger.info(`[Converter] Ландшафтный формат ${aspectRatio.toFixed(2)}:1, используем ${targetWidth}x${targetHeight}`);
    }
  } else {
    // Портретная ориентация (высота > ширины) - A4, Letter и т.д.
    targetHeight = MAX_HEIGHT;
    targetWidth = Math.round(MAX_HEIGHT * aspectRatio);
    logger.info(`[Converter] Портретный формат ${(1/aspectRatio).toFixed(2)}:1, используем ${targetWidth}x${targetHeight}`);
  }
  
  // Используем GraphicsMagick/ImageMagick напрямую для конвертации PDF в PNG
  // Это гарантирует сохранение правильных пропорций
  const pageCount = await getPdfPageCount(safePdfPath);
  
  logger.info(`[Converter] Начало конвертации PDF: ${pageCount} страниц, целевой размер: ${targetWidth}x${targetHeight}`);
  
  // Проверяем доступность GraphicsMagick или ImageMagick для конвертации
  let convertTool = null;
  let convertCommand = null;
  
  if (await commandExists('gm')) {
    convertTool = 'gm';
    // GraphicsMagick: конвертируем PDF в PNG с сохранением пропорций
    // Используем density для качества, затем масштабируем
    convertCommand = (pdfPath, pageNum, outputPath) => {
      return {
        command: 'gm',
        args: [
          'convert',
          '-density', '200',
          `${pdfPath}[${pageNum - 1}]`,
          '-resize', `${targetWidth}x${targetHeight}>`,
          outputPath
        ]
      };
    };
    logger.info(`[Converter] Используем GraphicsMagick для конвертации PDF`);
  } else if (await commandExists('convert')) {
    convertTool = 'convert';
    // ImageMagick: конвертируем PDF в PNG с сохранением пропорций
    convertCommand = (pdfPath, pageNum, outputPath) => {
      return {
        command: 'convert',
        args: [
          '-density', '200',
          `${pdfPath}[${pageNum - 1}]`,
          '-resize', `${targetWidth}x${targetHeight}>`,
          outputPath
        ]
      };
    };
    logger.info(`[Converter] Используем ImageMagick для конвертации PDF`);
  } else {
    // Fallback на pdf2pic если GraphicsMagick/ImageMagick недоступны
    logger.warn(`[Converter] GraphicsMagick и ImageMagick не найдены, используем pdf2pic`);
    convertTool = 'pdf2pic';
  }

  let pdf2picResizeCommand = null;
  if (convertTool === 'pdf2pic') {
    if (await commandExists('gm')) {
      pdf2picResizeCommand = (imagePath, tempPath) => ({
        command: 'gm',
        args: ['convert', imagePath, '-resize', `${targetWidth}x${targetHeight}>`, tempPath]
      });
    } else if (await commandExists('convert')) {
      pdf2picResizeCommand = (imagePath, tempPath) => ({
        command: 'convert',
        args: [imagePath, '-resize', `${targetWidth}x${targetHeight}>`, tempPath]
      });
    } else {
      logger.warn(`[Converter] GraphicsMagick и ImageMagick не найдены, пропускаем масштабирование`);
    }
  }
  
  // Конвертируем все страницы
  const convertedPages = [];
  for (let i = 1; i <= pageCount; i++) {
    try {
      const imagePath = path.join(outputDir, `page.${i}.png`);
      
      if (convertCommand) {
        // Используем GraphicsMagick/ImageMagick напрямую
        const { command, args } = convertCommand(safePdfPath, i, imagePath);
        await execFileAsync(command, args);
        
        // Проверяем что файл создан
        if (fs.existsSync(imagePath)) {
          const stats = fs.statSync(imagePath);
          if (stats.size > 100) {
            convertedPages.push({ page: i, path: imagePath });
            logger.info(`[Converter] ✅ Страница ${i} конвертирована: ${imagePath} (${(stats.size / 1024).toFixed(2)} KB)`);
            if (onProgress) {
              // Прогресс 0-99% в зависимости от номера страницы
              const pct = Math.max(0, Math.min(99, Math.round((i / pageCount) * 99)));
              onProgress(pct);
            }
          } else {
            logger.warn(`[Converter] ⚠️ Страница ${i}: файл слишком мал: ${imagePath}`);
          }
        } else {
          logger.warn(`[Converter] ⚠️ Страница ${i}: файл не создан: ${imagePath}`);
        }
      } else {
        // Fallback на pdf2pic (если GraphicsMagick/ImageMagick недоступны)
        logger.warn(`[Converter] ⚠️ Используем pdf2pic как fallback для страницы ${i}`);
        const density = 200;
        const options = {
          density: density,
          saveFilename: "page",
          savePath: outputDir,
          format: "png",
        };
        const convert = fromPath(safePdfPath, options);
        const result = await convert(i);
        
        // pdf2pic возвращает объект с полями: { name, path, size, fileSize, page }
        let imagePath = null;
        if (result) {
          if (typeof result === 'string') {
            imagePath = result;
          } else if (result.path && fs.existsSync(result.path)) {
            imagePath = result.path;
          } else if (result.name) {
            imagePath = path.join(outputDir, result.name);
          }
        }
        
        // Если путь не найден, пробуем найти файл по стандартному имени
        if (!imagePath || !fs.existsSync(imagePath)) {
          const possibleNames = [`page.${i}.png`, `page-${i}.png`, `page_${i}.png`, `page${i}.png`];
          for (const name of possibleNames) {
            const possiblePath = path.join(outputDir, name);
            if (fs.existsSync(possiblePath)) {
              imagePath = possiblePath;
              break;
            }
          }
        }
        
        if (imagePath && fs.existsSync(imagePath)) {
          await new Promise(resolve => setTimeout(resolve, 500));
          const stats = fs.statSync(imagePath);
          if (stats.size > 100) {
            // Проверяем PNG заголовок
            try {
              const fd = fs.openSync(imagePath, 'r');
              const buffer = Buffer.alloc(8);
              fs.readSync(fd, buffer, 0, 8, 0);
              fs.closeSync(fd);
              
              const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
              if (buffer.equals(pngSignature)) {
                // Масштабируем через GraphicsMagick/ImageMagick для сохранения пропорций
                if (pdf2picResizeCommand) {
                  const tempPath = `${imagePath}.tmp`;
                  try {
                    const safeImagePath = validatePath(path.resolve(imagePath), safeOutputDir);
                    const safeTempPath = validatePath(path.resolve(tempPath), safeOutputDir);
                    const { command, args } = pdf2picResizeCommand(imagePath, tempPath);
                    await execFileAsync(command, args);
                      if (fs.existsSync(safeTempPath) && fs.statSync(safeTempPath).size > 0) {
                        fs.renameSync(safeTempPath, safeImagePath);
                      convertedPages.push({ page: i, path: imagePath });
                      logger.info(`[Converter] ✅ Страница ${i} конвертирована (pdf2pic + resize): ${imagePath}`);
                    }
                  } catch (e) {
                    logger.warn(`[Converter] ⚠️ Не удалось масштабировать страницу ${i}`, { error: e.message });
                  }
                } else {
                  convertedPages.push({ page: i, path: imagePath });
                  logger.info(`[Converter] ✅ Страница ${i} конвертирована (pdf2pic): ${imagePath}`);
                }
              }
            } catch (e) {
              logger.warn(`[Converter] ⚠️ Ошибка проверки страницы ${i}`, { error: e.message });
            }
          }
        }
      }
    } catch (error) {
      logger.error(`[Converter] ❌ Ошибка конвертации страницы ${i}`, { 
        error: error.message, 
        stack: error.stack,
        page: i 
      });
    }
  }
  
  if (convertedPages.length === 0) {
    throw new Error(`Не удалось конвертировать ни одной страницы из ${pageCount}`);
  }
  
  logger.info(`[Converter] Успешно конвертировано ${convertedPages.length} из ${pageCount} страниц`);
  
  // Если использовали GraphicsMagick/ImageMagick напрямую, масштабирование уже выполнено
  // Если использовали pdf2pic, нужно дополнительно масштабировать
  if (convertTool === 'pdf2pic') {
    if (pdf2picResizeCommand) {
      for (const { page, path: imagePath } of convertedPages) {
        if (!fs.existsSync(imagePath)) continue;
        
        const tempPath = `${imagePath}.tmp`;
        try {
            const safeImagePath = validatePath(path.resolve(imagePath), safeOutputDir);
            const safeTempPath = validatePath(path.resolve(tempPath), safeOutputDir);
          // Получаем реальные размеры перед масштабированием
          let originalWidth, originalHeight;
          try {
            const identifyResult = await execFileAsync('identify', ['-format', '%wx%h', imagePath]);
            const dimensions = identifyResult.stdout.trim().split('x');
            originalWidth = parseInt(dimensions[0]);
            originalHeight = parseInt(dimensions[1]);
          } catch (e) {
            try {
              const gmResult = await execFileAsync('gm', ['identify', '-format', '%wx%h', imagePath]);
              const dimensions = gmResult.stdout.trim().split('x');
              originalWidth = parseInt(dimensions[0]);
              originalHeight = parseInt(dimensions[1]);
            } catch (e2) {
              // Игнорируем
            }
          }
          
          const { command, args } = pdf2picResizeCommand(imagePath, tempPath);
          await execFileAsync(command, args);
          
          if (fs.existsSync(safeTempPath) && fs.statSync(safeTempPath).size > 0) {
              fs.renameSync(safeTempPath, safeImagePath);
            try {
              const finalResult = await execFileAsync('identify', ['-format', '%wx%h', imagePath]);
              const finalDimensions = finalResult.stdout.trim().split('x');
              const finalWidth = parseInt(finalDimensions[0]);
              const finalHeight = parseInt(finalDimensions[1]);
              logger.info(`[Converter] ✅ Изображение ${page} масштабировано: ${originalWidth || '?'}x${originalHeight || '?'} → ${finalWidth}x${finalHeight} (целевой: ${targetWidth}x${targetHeight})`);
            } catch (e) {
              logger.debug(`[Converter] Изображение ${page} масштабировано до ${targetWidth}x${targetHeight}`);
            }
          }
        } catch (error) {
          logger.warn(`[Converter] Не удалось изменить размер изображения ${page}`, { error: error.message });
          if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch (e) {}
          }
        }
      }
    }
  } else {
    // При использовании GraphicsMagick/ImageMagick напрямую масштабирование уже выполнено
    // Проверяем размеры для логирования
    for (const { page, path: imagePath } of convertedPages) {
      if (fs.existsSync(imagePath)) {
        try {
          const identifyResult = await execFileAsync('identify', ['-format', '%wx%h', imagePath]);
          const dimensions = identifyResult.stdout.trim().split('x');
          const finalWidth = parseInt(dimensions[0]);
          const finalHeight = parseInt(dimensions[1]);
          logger.info(`[Converter] ✅ Изображение ${page} готово: ${finalWidth}x${finalHeight} (целевой: ${targetWidth}x${targetHeight})`);
        } catch (e) {
          // Игнорируем
        }
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
  const fileNameWithoutExt = path.basename(pptxPath, path.extname(pptxPath));
  const pdfPath = path.join(outputDir, `${fileNameWithoutExt}.pdf`);
  
  try {
    // Конвертируем PPTX в PDF через LibreOffice
    await execFileAsync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', outputDir, pptxPath]);
    if (onProgress) onProgress(5); // Начальная стадия конвертации PPTX -> PDF
    
    // Проверяем что PDF создан
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`PDF не создан: ${pdfPath}`);
    }
    
    // Конвертируем PDF в изображения
    const numPages = await convertPdfToImages(pdfPath, outputDir, onProgress);
    
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

