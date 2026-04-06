/**
 * MP4 Faststart Processor - перемещение moov атома в начало файла для корректной перемотки
 * @module video/mp4-faststart
 * 
 * Для корректной перемотки в ExoPlayer необходимо, чтобы структура MP4 была:
 * [ftyp] [moov] [mdat]
 * 
 * moov атом содержит ВСЕ необходимые данные для перемотки:
 * - mvhd (movie header) - общая информация о файле (длительность, временная шкала)
 * - trak (tracks) - треки видео/аудио с метаданными
 *   - tkhd (track header) - информация о треке
 *   - mdia (media) - медиа информация
 *     - mdhd (media header) - заголовок медиа
 *     - hdlr (handler) - тип трека
 *     - minf (media information) - информация о медиа
 *       - stbl (sample table) - ТАБЛИЦЫ ДЛЯ ПЕРЕМОТКИ:
 *         - stco (chunk offset) - смещения чанков
 *         - stsc (sample-to-chunk) - маппинг сэмплов к чанкам
 *         - stsz (sample size) - размеры сэмплов
 *         - stts (time-to-sample) - временные метки сэмплов
 *         - stss (sync sample) - ключевые кадры (I-frames)
 *         - ctts (composition time) - время композиции
 * 
 * Без moov в начале ExoPlayer не может:
 * - Определить длительность файла без полной загрузки
 * - Перематывать к произвольной позиции
 * - Найти ключевые кадры для перемотки
 * 
 * FFmpeg с -movflags +faststart перемещает ВЕСЬ moov атом (со всеми таблицами) в начало,
 * что позволяет ExoPlayer сразу получить всю необходимую информацию для перемотки.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

/**
 * Проверяет, нужна ли обработка faststart для файла
 * Проверяет позицию moov атома в файле
 * 
 * Для корректной перемотки структура должна быть: [ftyp] [moov] [mdat]
 * Если moov не в начале - нужна обработка
 * 
 * @param {string} filePath - Путь к MP4 файлу
 * @returns {Promise<boolean>} true если нужна обработка
 */
export async function needsFaststart(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return false;
    }

    const stats = fs.statSync(filePath);
    if (stats.size < 100) {
      return false; // Файл слишком маленький
    }

    // Читаем первые 1MB для проверки структуры (moov может быть большим)
    // Для fragmented MP4 проверяем больше (до 10MB) чтобы найти moof атомы
    const checkSize = Math.min(10 * 1024 * 1024, stats.size);
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(checkSize);
    fs.readSync(fd, buffer, 0, checkSize, 0);
    fs.closeSync(fd);

    // Проверяем что это MP4 (ftyp атом должен быть в начале)
    if (buffer.length < 8) {
      return false; // Файл слишком маленький
    }
    
    const ftyp = buffer.toString('ascii', 4, 8);
    if (ftyp !== 'ftyp') {
      return false; // Не MP4 файл
    }

    // Парсим структуру атомов MP4
    // Ищем 'moov' атом в первых 100KB
    // moov должен быть сразу после ftyp для оптимизированных файлов
    // Также проверяем наличие 'moof' атомов (fragmented MP4)
    let offset = 0;
    let foundMoov = false;
    let foundMdat = false;
    let foundMoof = false;
    let moovOffset = -1;
    const maxCheckOffset = Math.min(100 * 1024, checkSize); // Проверяем первые 100KB для поиска moov
    
    while (offset < maxCheckOffset - 8) {
      // Проверяем что у нас достаточно данных для чтения размера и типа атома
      if (offset + 8 > buffer.length) {
        break;
      }
      
      // Читаем размер атома (4 байта, big-endian)
      const atomSize = buffer.readUInt32BE(offset);
      
      // Проверка на валидность размера атома
      if (atomSize === 0) {
        // Размер 0 означает что атом идет до конца файла (не должно быть в начале)
        break;
      }
      
      if (atomSize === 1) {
        // Размер 1 означает extended size (64-bit), пропускаем такие атомы в простой проверке
        // Это редко встречается в начале файла
        break;
      }
      
      if (atomSize < 8) {
        // Минимальный размер атома - 8 байт (размер + тип)
        break;
      }

      // Читаем тип атома (4 байта)
      const atomType = buffer.toString('ascii', offset + 4, offset + 8);
      
      if (atomType === 'moov') {
        foundMoov = true;
        moovOffset = offset;
        const moovSize = atomSize;
        
        // moov найден - проверяем его позицию и размер
        // Если moov в первых 100KB - проверяем размер
        if (offset < 100 * 1024) {
          // КРИТИЧНО: Маленький moov (<10KB) может указывать на fragmented MP4
          // В fragmented MP4 moov содержит только initialization, индексы в moof
          // Для корректной перемотки нужна перекодировка в non-fragmented
          if (moovSize < 10 * 1024) {
            logger.debug('[Faststart] moov найден в начале, но маленький - возможен fragmented MP4, нужна обработка', {
              filePath,
              moovOffset: offset,
              moovSize: moovSize,
              fileSize: stats.size
            });
            return true; // Обрабатываем для перекодировки в non-fragmented
          }
          
          logger.debug('[Faststart] moov найден в начале файла, обработка не нужна', {
            filePath,
            moovOffset: offset,
            moovSize: moovSize,
            fileSize: stats.size
          });
          return false;
        }
        // moov найден, но не в начале - нужна обработка
        break;
      }

      if (atomType === 'moof') {
        foundMoof = true;
        // moof найден - это fragmented MP4
        // Для fragmented MP4 faststart не поможет, нужна перекодировка
        logger.debug('[Faststart] moof найден - fragmented MP4, нужна обработка', {
          filePath,
          moofOffset: offset
        });
        return true;
      }

      if (atomType === 'mdat') {
        foundMdat = true;
        // Если mdat найден до moov - файл НЕ оптимизирован
        if (!foundMoov) {
          logger.debug('[Faststart] mdat найден до moov, нужна обработка', {
            filePath,
            mdatOffset: offset
          });
          return true;
        }
        // mdat после moov - это нормально для оптимизированных файлов
        // Но продолжаем проверку на moof
      }

      // Переходим к следующему атому
      // Проверяем что не выходим за пределы буфера
      if (offset + atomSize > buffer.length) {
        // Атом выходит за пределы буфера - это нормально для больших атомов
        // Но если мы уже проверили первые 100KB и не нашли moov - вероятно его нет в начале
        break;
      }
      
      offset += atomSize;
      
      // Для fragmented MP4 продолжаем поиск moof даже после moov
      // Проверяем до 10MB для поиска moof атомов
      if (foundMoov && offset > 10 * 1024 * 1024) {
        break;
      }
    }
    
    // Дополнительная проверка: ищем moof дальше в файле (до 10MB)
    // moof атомы указывают на fragmented MP4
    if (!foundMoof && checkSize > 100 * 1024) {
      let searchOffset = 100 * 1024; // Начинаем поиск после первых 100KB
      while (searchOffset < Math.min(checkSize - 8, 10 * 1024 * 1024)) {
        if (searchOffset + 8 > buffer.length) break;
        
        const atomSize = buffer.readUInt32BE(searchOffset);
        const atomType = buffer.toString('ascii', searchOffset + 4, searchOffset + 8);
        
        if (atomType === 'moof') {
          foundMoof = true;
          logger.debug('[Faststart] moof найден дальше в файле - fragmented MP4, нужна обработка', {
            filePath,
            moofOffset: searchOffset
          });
          return true;
        }
        
        if (atomSize === 0 || atomSize < 8 || atomSize > checkSize) break;
        searchOffset += Math.min(atomSize, 10000); // Пропускаем большие атомы
      }
    }
    
    // Если нашли moof - это fragmented MP4, нужна обработка
    if (foundMoof) {
      logger.debug('[Faststart] fragmented MP4 обнаружен, нужна обработка', {
        filePath
      });
      return true;
    }

    // Если moov найден, но не в начале - все равно считаем что нужна обработка
    // (для гарантии что он точно в начале)
    if (foundMoov && moovOffset > 100 * 1024) {
      logger.debug('[Faststart] moov найден, но не в начале файла, нужна обработка', {
        filePath,
        moovOffset,
        fileSize: stats.size
      });
      return true;
    }

    // moov не найден в первых 1MB - вероятно файл не оптимизирован
    // КРИТИЧНО: Для коротких файлов (<50MB) это критично - нужна обработка
    // Для больших файлов (>100MB) ExoPlayer может работать, но лучше обработать для гарантии
    const isSmallFile = stats.size < 50 * 1024 * 1024; // < 50MB
    
    if (isSmallFile) {
      logger.debug('[Faststart] moov не найден в начале файла (короткий файл), нужна обработка', {
        filePath,
        fileSize: stats.size
      });
      return true;
    } else {
      // Для больших файлов можем быть менее строгими, но все равно лучше обработать
      logger.debug('[Faststart] moov не найден в начале файла (большой файл), предполагаем что нужна обработка', {
        filePath,
        fileSize: stats.size
      });
      return true;
    }
  } catch (error) {
    logger.warn('[Faststart] Ошибка проверки файла, предполагаем что нужна обработка', {
      filePath,
      error: error.message
    });
    // При ошибке проверки - предполагаем что нужна обработка (безопаснее)
    return true;
  }
}

/**
 * Применяет faststart к MP4 файлу
 * Перемещает moov атом и все необходимые таблицы в начало файла
 * 
 * Использует: ffmpeg -c copy -movflags +faststart
 * Это перемещает:
 * - moov атом (все метаданные, треки, индексы)
 * - все связанные таблицы (stbl, stco, stsc, stsz, stts и т.д.)
 * 
 * БЕЗ перекодирования (codec copy) - только реорганизация структуры
 * 
 * @param {string} filePath - Путь к MP4 файлу
 * @param {Object} options - Опции обработки
 * @param {boolean} options.checkFirst - Проверить нужна ли обработка перед выполнением (default: true)
 * @returns {Promise<boolean>} true если обработка выполнена успешно
 */
export async function applyFaststart(filePath, options = {}) {
  const { checkFirst = true } = options;

  try {
    if (!fs.existsSync(filePath)) {
      logger.warn('[Faststart] Файл не найден', { filePath });
      return false;
    }

    // Проверяем расширение
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.mp4' && ext !== '.m4v' && ext !== '.m4a') {
      logger.debug('[Faststart] Пропуск не-MP4 файла', { filePath, ext });
      return false;
    }

    // Проверяем нужна ли обработка
    if (checkFirst) {
      const needs = await needsFaststart(filePath);
      if (!needs) {
        logger.debug('[Faststart] Файл уже оптимизирован, пропуск', { filePath });
        return false;
      }
    }

    logger.info('[Faststart] Начало обработки', { filePath });

    // Создаем временный файл в той же директории
    const fileDir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const tempPath = path.join(fileDir, `.faststart_${Date.now()}_${fileName}`);

    // FFmpeg команда для перемещения moov в начало БЕЗ перекодирования
    // -c copy - копируем все потоки без перекодирования (быстро)
    // -movflags +faststart - перемещает moov атом в начало
    // Это перемещает ВСЕ необходимые таблицы и индексы
    const args = [
      '-i', filePath,
      '-c', 'copy',           // Копируем все потоки без перекодирования
      '-movflags', '+faststart', // Перемещаем moov в начало
      '-y',                   // Перезаписываем выходной файл
      tempPath
    ];

    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'pipe'] // stderr для логирования
      });

      let stderr = '';
      let hasError = false;

      ffmpeg.stderr.on('data', (data) => {
        const output = data.toString();
        stderr += output;
        
        // Логируем прогресс если есть
        if (output.includes('time=')) {
          const timeMatch = output.match(/time=(\d+):(\d+):(\d+\.\d+)/);
          if (timeMatch) {
            logger.debug('[Faststart] Обработка...', { 
              filePath, 
              time: timeMatch[0] 
            });
          }
        }
      });

      ffmpeg.on('error', (error) => {
        hasError = true;
        logger.error('[Faststart] Ошибка запуска FFmpeg', {
          filePath,
          error: error.message
        });
        reject(error);
      });

      ffmpeg.on('close', (code) => {
        if (hasError) return;

        if (code !== 0) {
          logger.error('[Faststart] FFmpeg завершился с ошибкой', {
            filePath,
            code,
            stderr: stderr.substring(stderr.length - 500) // Последние 500 символов
          });
          reject(new Error(`FFmpeg exited with code ${code}`));
          return;
        }

        // Проверяем что временный файл создан и не пустой
        if (!fs.existsSync(tempPath)) {
          reject(new Error('Временный файл не создан'));
          return;
        }

        const tempStats = fs.statSync(tempPath);
        const originalStats = fs.statSync(filePath);

        if (tempStats.size === 0) {
          reject(new Error('Временный файл пустой'));
          return;
        }

        // Размер должен быть примерно таким же (может немного отличаться из-за реорганизации)
        const sizeDiff = Math.abs(tempStats.size - originalStats.size);
        const sizeDiffPercent = (sizeDiff / originalStats.size) * 100;

        if (sizeDiffPercent > 5) {
          logger.warn('[Faststart] Размер файла изменился более чем на 5%', {
            filePath,
            originalSize: originalStats.size,
            newSize: tempStats.size,
            diffPercent: sizeDiffPercent.toFixed(2)
          });
          // Не считаем это критической ошибкой, продолжаем
        }

        resolve();
      });
    });

    // Заменяем оригинальный файл временным
    // КРИТИЧНО: Сохраняем права доступа оригинального файла
    const originalStats = fs.statSync(filePath);
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, originalStats.mode);

    logger.info('[Faststart] ✅ Обработка завершена успешно', {
      filePath,
      size: fs.statSync(filePath).size
    });

    return true;
  } catch (error) {
    logger.error('[Faststart] ❌ Ошибка обработки', {
      filePath,
      error: error.message,
      stack: error.stack
    });

    // Удаляем временный файл если он остался
    const fileDir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const tempPattern = path.join(fileDir, `.faststart_*_${fileName}`);
    
    try {
      const files = fs.readdirSync(fileDir);
      for (const file of files) {
        if (file.startsWith('.faststart_') && file.endsWith(`_${fileName}`)) {
          const tempPath = path.join(fileDir, file);
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
        }
      }
    } catch (cleanupError) {
      logger.warn('[Faststart] Не удалось очистить временные файлы', {
        error: cleanupError.message
      });
    }

    return false;
  }
}

/**
 * Обрабатывает файл асинхронно в фоне (не блокирует)
 * @param {string} filePath - Путь к MP4 файлу
 * @returns {Promise<void>}
 */
export async function applyFaststartAsync(filePath) {
  // Запускаем в фоне, не ждем результата
  applyFaststart(filePath, { checkFirst: true }).catch((error) => {
    logger.error('[Faststart] Фоновая обработка завершилась с ошибкой', {
      filePath,
      error: error.message
    });
  });
}

