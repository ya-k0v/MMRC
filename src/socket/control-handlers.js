/**
 * Обработчики управления плеером (control/*)
 * @module socket/control-handlers
 */

import { getFolderImagesCount } from '../converters/folder-converter.js';

const DEFAULT_FOLDER_PLAYLIST_INTERVAL_SECONDS = 10;
const serverPlaylistLoops = new Map();

function stopServerPlaylistLoop(deviceId, reason = 'stopped') {
  const loop = serverPlaylistLoops.get(deviceId);
  if (loop?.timer) {
    clearTimeout(loop.timer);
  }
  if (loop) {
    serverPlaylistLoops.delete(deviceId);
    console.log(`[Playlist] Loop stopped for ${deviceId} (${reason})`);
  }
}

async function startServerPlaylistLoop(deviceId, file, intervalSeconds, devices, io) {
  stopServerPlaylistLoop(deviceId);

  const deviceState = devices[deviceId];
  if (!deviceState) return;

  // запоминаем оригинальное имя папки чтобы находить файлы независимо от safeName
  if (deviceState.current) {
    deviceState.current.originalFolderName = file;
  }

  const folderName = file.replace(/\.zip$/i, '');
  let totalImages = 0;
  try {
    totalImages = await getFolderImagesCount(deviceId, folderName);
  } catch (error) {
    console.error(`[Playlist] Failed to get images count for ${deviceId}/${file}:`, error);
    return;
  }

  if (!totalImages || totalImages < 1) {
    console.warn(`[Playlist] Folder ${file} for ${deviceId} has no images, playlist loop skipped`);
    return;
  }

  const loopState = {
    deviceId,
    file,
    totalPages: totalImages,
    intervalMs: Math.max(1, intervalSeconds || DEFAULT_FOLDER_PLAYLIST_INTERVAL_SECONDS) * 1000,
    currentPage: Number(deviceState.current?.page) || 1,
    timer: null,
    hasAdvanced: false
  };

  serverPlaylistLoops.set(deviceId, loopState);
  console.log(`[Playlist] Loop started for ${deviceId} (${file}) total=${totalImages} interval=${loopState.intervalMs}ms`);
  scheduleNextFolderSlide(loopState, devices, io);
}

function scheduleNextFolderSlide(loopState, devices, io) {
  loopState.timer = setTimeout(() => {
    const stateFromMap = serverPlaylistLoops.get(loopState.deviceId);
    if (!stateFromMap) {
      return;
    }

    const deviceState = devices[loopState.deviceId];
    const playlistNameMatches =
      deviceState?.current &&
      deviceState.current.playlistActive &&
      (
        deviceState.current.playlistFile === loopState.file ||
        deviceState.current.file === loopState.file ||
        (deviceState.current.originalFolderName && deviceState.current.originalFolderName === loopState.file)
      );

    if (!playlistNameMatches) {
      console.warn('[Playlist] State changed, stopping loop', {
        deviceId: loopState.deviceId,
        hasDevice: !!deviceState,
        hasCurrent: !!deviceState?.current,
        playlistActive: deviceState?.current?.playlistActive,
        currentFile: deviceState?.current?.file,
        playlistFile: deviceState?.current?.playlistFile,
        loopFile: loopState.file
      });
      stopServerPlaylistLoop(loopState.deviceId, 'state changed');
      return;
    }

    const totalPages = loopState.totalPages || 1;
    const currentPage = Number(deviceState.current.page) || loopState.currentPage || 1;
    const nextPage = totalPages === 1 ? 1 : (currentPage % totalPages) + 1;

    loopState.currentPage = nextPage;
    deviceState.current.page = nextPage;

    console.log(`[Playlist] ${loopState.deviceId} -> slide ${nextPage}/${totalPages}`);
    if (loopState.hasAdvanced || nextPage !== 1) {
      io.to(`device:${loopState.deviceId}`).emit('player/folderPage', nextPage);
      io.emit('preview/refresh', { device_id: loopState.deviceId });
    } else {
      console.log(`[Playlist] ${loopState.deviceId} first slide already playing, skipping duplicate page 1`);
    }

    loopState.hasAdvanced = true;

    scheduleNextFolderSlide(loopState, devices, io);
  }, loopState.intervalMs);
}

/**
 * Настраивает обработчики управления плеером
 * @param {Socket} socket - Socket.IO сокет
 * @param {Object} deps - Зависимости {devices, io, getPageSlideCount}
 */
export function setupControlHandlers(socket, deps) {
  const { devices, io, getPageSlideCount } = deps;
  
  // control/play - Запустить воспроизведение
  socket.on('control/play', ({ device_id, file, page }) => {
    const d = devices[device_id];
    if (!d) return;

    // Если был активный плейлист и запускается другой файл — останавливаем серверный цикл
    if (
      d.current &&
      d.current.playlistActive &&
      file &&
      d.current.playlistFile &&
      file !== d.current.playlistFile
    ) {
      d.current.playlistActive = false;
      d.current.playlistInterval = undefined;
      d.current.playlistFile = undefined;
      stopServerPlaylistLoop(device_id, 'play override');
      io.emit('playlist/state', { device_id, active: false });
    }
    
    if (file) {
      // Проверяем есть ли расширение у файла
      const hasExtension = file.includes('.');
      const ext = hasExtension ? file.split('.').pop().toLowerCase() : '';
      
      // Определяем тип контента
      let type = 'video'; // По умолчанию
      
      if (!hasExtension) {
        // Нет расширения = это папка с изображениями
        type = 'folder';
      } else if (ext === 'pdf') {
        type = 'pdf';
      } else if (ext === 'pptx') {
        type = 'pptx';
      } else if (['png','jpg','jpeg','gif','webp'].includes(ext)) {
        type = 'image';
      } else if (ext === 'zip') {
        type = 'folder'; // ZIP = папка с изображениями
      }
      
      // Используем переданный номер страницы или 1 по умолчанию
      const pageNum = page || 1;
      
      d.current = { 
        type, 
        file, 
        state: 'playing', 
        page: (type === 'pdf' || type === 'pptx' || type === 'folder') ? pageNum : undefined 
      };
      
      io.to(`device:${device_id}`).emit('player/play', d.current);
    } else {
      // КРИТИЧНО: Если файл не указан - это RESUME после паузы
      // Отправляем команду player/resume чтобы плеер продолжил с места паузы
      // НЕ отправляем player/play - это перезагрузит файл с начала!
      if (d.current) {
        d.current.state = 'playing';
      }
      io.to(`device:${device_id}`).emit('player/resume');
      console.log(`[Control] ▶️ Resume: ${device_id} (продолжение с места паузы)`);
    }
    
    io.emit('preview/refresh', { device_id });
  });

  // control/pause - Пауза
  socket.on('control/pause', ({ device_id }) => {
    const d = devices[device_id];
    if (!d) return;
    
    d.current.state = 'paused';
    io.to(`device:${device_id}`).emit('player/pause');
    io.emit('preview/refresh', { device_id });
  });

  // control/restart - Перезапуск
  socket.on('control/restart', ({ device_id }) => {
    const d = devices[device_id];
    if (!d) return;
    
    d.current.state = 'playing';
    io.to(`device:${device_id}`).emit('player/restart');
    io.emit('preview/refresh', { device_id });
  });

  // control/stop - Остановка
  socket.on('control/stop', ({ device_id }) => {
    const d = devices[device_id];
    if (!d) return;
    
    // Останавливаем плейлист если был активен
    if (d.current && d.current.playlistActive) {
      d.current.playlistActive = false;
      d.current.playlistInterval = undefined;
      d.current.playlistFile = undefined;
      io.emit('playlist/state', { device_id, active: false });
    }
    
    d.current = { type: 'idle', file: null, state: 'idle' };
    io.to(`device:${device_id}`).emit('player/stop');
    io.emit('preview/refresh', { device_id });
    stopServerPlaylistLoop(device_id, 'control stop');
  });

  // control/playlistStart - Запуск плейлиста папки
  socket.on('control/playlistStart', async ({ device_id, file, intervalSeconds }) => {
    const d = devices[device_id];
    if (!d) return;
    
    // Обновляем состояние устройства с информацией о плейлисте
    if (!d.current) {
      d.current = { type: 'folder', file, state: 'playing', page: 1 };
    }
    d.current.playlistActive = true;
    d.current.playlistInterval = intervalSeconds || 10;
    d.current.playlistFile = file;
    d.current.type = 'folder';
    d.current.file = file;
    d.current.state = 'playing';
    d.current.page = 1;
    
    // Немедленно запускаем воспроизведение первой картинки
    io.to(`device:${device_id}`).emit('player/play', d.current);
    io.emit('preview/refresh', { device_id });
    
    // Рассылаем состояние плейлиста всем панелям для синхронизации
    io.emit('playlist/state', {
      device_id,
      active: true,
      file,
      intervalSeconds: d.current.playlistInterval
    });
    io.emit('devices/updated', { device_id });

    try {
      await startServerPlaylistLoop(device_id, file, d.current.playlistInterval, devices, io);
    } catch (error) {
      console.error('[Playlist] Failed to start server loop:', error);
    }
  });

  // control/playlistStop - Остановка плейлиста папки
  socket.on('control/playlistStop', ({ device_id }) => {
    const d = devices[device_id];
    if (!d) return;
    
    // Убираем информацию о плейлисте из состояния
    if (d.current) {
      d.current.playlistActive = false;
      d.current.playlistInterval = undefined;
      d.current.playlistFile = undefined;
    }
    
    // Рассылаем остановку плейлиста всем панелям для синхронизации
    io.emit('playlist/state', {
      device_id,
      active: false
    });
    io.emit('devices/updated', { device_id });
    stopServerPlaylistLoop(device_id, 'manual stop');
  });

  // control/pdfPrev - Предыдущая страница/слайд/изображение
  socket.on('control/pdfPrev', ({ device_id }) => {
    const d = devices[device_id];
    if (!d) return;
    
    if (d.current.type === 'pdf') {
      d.current.page = Math.max(1, (d.current.page || 1) - 1);
      io.to(`device:${device_id}`).emit('player/pdfPage', d.current.page);
      io.emit('player/pdfPage', d.current.page); // Для спикера
    } else if (d.current.type === 'pptx') {
      d.current.page = Math.max(1, (d.current.page || 1) - 1);
      io.to(`device:${device_id}`).emit('player/pptxPage', d.current.page);
      io.emit('player/pptxPage', d.current.page); // Для спикера
    } else if (d.current.type === 'folder') {
      d.current.page = Math.max(1, (d.current.page || 1) - 1);
      io.to(`device:${device_id}`).emit('player/folderPage', d.current.page);
      // КРИТИЧНО: НЕ отправляем всем - только конкретному устройству!
      // Спикер обновится через preview/refresh
      io.emit('preview/refresh', { device_id });
    }
  });

  // control/pdfNext - Следующая страница/слайд/изображение
  socket.on('control/pdfNext', async ({ device_id }) => {
    const d = devices[device_id];
    if (!d) return;
    
    if (d.current.type === 'pdf' && d.current.file) {
      const maxPages = await getPageSlideCount(device_id, d.current.file, 'page');
      if (maxPages > 0) {
        const nextPage = Math.min((d.current.page || 1) + 1, maxPages);
        if (nextPage !== d.current.page) {
          d.current.page = nextPage;
          io.to(`device:${device_id}`).emit('player/pdfPage', d.current.page);
          io.emit('player/pdfPage', d.current.page); // Для спикера
        }
      }
    } else if (d.current.type === 'pptx' && d.current.file) {
      const maxSlides = await getPageSlideCount(device_id, d.current.file, 'slide');
      if (maxSlides > 0) {
        const nextSlide = Math.min((d.current.page || 1) + 1, maxSlides);
        if (nextSlide !== d.current.page) {
          d.current.page = nextSlide;
          io.to(`device:${device_id}`).emit('player/pptxPage', d.current.page);
          io.emit('player/pptxPage', d.current.page); // Для спикера
        }
      }
    } else if (d.current.type === 'folder' && d.current.file) {
      // Получаем количество изображений в папке
      const folderName = d.current.file.replace(/\.zip$/i, ''); // Убираем .zip если есть
      const maxImages = await getFolderImagesCount(device_id, folderName);
      if (maxImages > 0) {
        const nextImage = Math.min((d.current.page || 1) + 1, maxImages);
        if (nextImage !== d.current.page) {
          d.current.page = nextImage;
          io.to(`device:${device_id}`).emit('player/folderPage', d.current.page);
          // КРИТИЧНО: НЕ отправляем всем - только конкретному устройству!
          // Спикер обновится через preview/refresh
          io.emit('preview/refresh', { device_id });
        }
      }
    }
  });
}

