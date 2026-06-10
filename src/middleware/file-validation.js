/**
 * File MIME Type Validation
 * @module middleware/file-validation
 */

import { fileTypeFromFile } from 'file-type';
import fs from 'node:fs';
import logger from '../utils/logger.js';

/**
 * Разрешенные MIME types по категориям
 */
const ALLOWED_MIME_TYPES = {
  video: [
    'video/mp4',
    'video/webm',
    'video/ogg',
    'video/x-matroska', // MKV
    'video/quicktime',  // MOV
    'video/x-msvideo'   // AVI
  ],
  image: [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp'
  ],
  audio: [
    'audio/mpeg',       // MP3
    'audio/wav',
    'audio/mp4',        // M4A
    'audio/ogg'
  ],
  document: [
    'application/pdf',
    'application/vnd.ms-powerpoint', // PPT
    'application/vnd.openxmlformats-officedocument.presentationml.presentation' // PPTX
  ],
  archive: [
    'application/zip',
    'application/x-zip-compressed'
  ]
};

/**
 * Все разрешенные MIME types (плоский список)
 */
const ALL_ALLOWED_MIMES = [
  ...ALLOWED_MIME_TYPES.video,
  ...ALLOWED_MIME_TYPES.image,
  ...ALLOWED_MIME_TYPES.audio,
  ...ALLOWED_MIME_TYPES.document,
  ...ALLOWED_MIME_TYPES.archive
];

/**
 * Проверить MIME type файла
 * @param {string} filePath - Путь к файлу
 * @param {string} expectedCategory - Ожидаемая категория ('video', 'image', etc.) или null
 * @returns {Promise<Object>} { mime, ext, valid }
 */
export async function validateFileMimeType(filePath, expectedCategory = null) {
  if (!fs.existsSync(filePath)) {
    throw new Error('File not found');
  }
  
  try {
    const fileType = await fileTypeFromFile(filePath);
    
    if (!fileType) {
      // Некоторые файлы (txt, json) могут не определяться
      // Разрешаем их только если нет ожидаемой категории
      if (expectedCategory) {
        throw new Error('Unable to detect file type');
      }
      return { mime: null, ext: null, valid: false };
    }
    
    let valid = false;
    
    if (expectedCategory && ALLOWED_MIME_TYPES[expectedCategory]) {
      // Проверяем конкретную категорию
      valid = ALLOWED_MIME_TYPES[expectedCategory].includes(fileType.mime);
    } else {
      // Проверяем что вообще разрешенный тип
      valid = ALL_ALLOWED_MIMES.includes(fileType.mime);
    }
    
    return {
      mime: fileType.mime,
      ext: fileType.ext,
      valid
    };
  } catch (err) {
    logger.error('[File Validation] Error', { error: err.message, stack: err.stack, filePath });
    throw new Error(`File validation failed: ${err.message}`);
  }
}

/**
 * Async функция для валидации файлов (для использования внутри async функций)
 * @param {Array} files - Массив файлов из multer (req.files)
 * @returns {Promise<{valid: boolean, invalid?: Array, results?: Array}>}
 */
export async function validateFilesAsync(files) {
  if (!files || files.length === 0) {
    return { valid: true, results: [] };
  }
  
  logger.debug('[File Validation] Starting MIME type validation', {
    filesCount: files.length,
    filenames: files.map(f => f.originalname)
  });
  
  const validationPromises = files.map(async (file) => {
    try {
      const result = await validateFileMimeType(file.path);
      
      if (!result.valid) {
        logger.warn('[File Validation] Invalid file type detected', {
          filename: file.originalname,
          detectedMime: result.mime,
          detectedExt: result.ext,
          filePath: file.path
        });
        
        // Удаляем невалидный файл
        fs.unlinkSync(file.path);
        return {
          filename: file.originalname,
          valid: false,
          reason: `Invalid file type: ${result.mime || 'unknown'}`
        };
      }
      
      logger.debug('[File Validation] File validated', {
        filename: file.originalname,
        mime: result.mime,
        ext: result.ext
      });
      
      return {
        filename: file.originalname,
        valid: true,
        mime: result.mime
      };
    } catch (err) {
      logger.error('[File Validation] Validation error for file', {
        filename: file.originalname,
        error: err.message,
        stack: err.stack,
        filePath: file.path
      });
      
      // Удаляем файл при ошибке
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      return {
        filename: file.originalname,
        valid: false,
        reason: err.message
      };
    }
  });
  
  const results = await Promise.all(validationPromises);
  const invalid = results.filter(r => !r.valid);
  
  if (invalid.length > 0) {
    // Удаляем все валидные файлы тоже (транзакция отменяется)
    files.forEach(file => {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    });
    
    return {
      valid: false,
      invalid: invalid.map(i => ({ file: i.filename, reason: i.reason })),
      results
    };
  }
  
  return {
    valid: true,
    results
  };
}

/**
 * Middleware для проверки загруженных файлов
 * Использовать ПОСЛЕ multer upload
 */
export function validateUploadedFiles(req, res, next) {
  if (!req.files || req.files.length === 0) {
    return next();
  }
  
  // Проверяем каждый файл асинхронно
  const validationPromises = req.files.map(async (file) => {
    try {
      const result = await validateFileMimeType(file.path);
      
      if (!result.valid) {
        // Удаляем невалидный файл
        fs.unlinkSync(file.path);
        return {
          filename: file.originalname,
          valid: false,
          reason: `Invalid file type: ${result.mime || 'unknown'}`
        };
      }
      
      return {
        filename: file.originalname,
        valid: true,
        mime: result.mime
      };
    } catch (err) {
      // Удаляем файл при ошибке
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      return {
        filename: file.originalname,
        valid: false,
        reason: err.message
      };
    }
  });
  
  Promise.all(validationPromises)
    .then((results) => {
      const invalid = results.filter(r => !r.valid);
      
      if (invalid.length > 0) {
        // Удаляем все валидные файлы тоже (транзакция отменяется)
        req.files.forEach(file => {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        });
        
        return res.status(400).json({
          error: 'Invalid file types detected',
          invalid: invalid.map(i => ({ file: i.filename, reason: i.reason }))
        });
      }
      
      // Все файлы валидные - продолжаем
      req.validatedFiles = results;
      next();
    })
    .catch((err) => {
      logger.error('[File Validation] Middleware error', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Ошибка валидации файла' });
    });
}

