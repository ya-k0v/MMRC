/**
 * Обработчики управления плеером (control/*)
 * @module socket/control-handlers
 */

import { getFolderImagesCount } from '../converters/folder-converter.js';
import logger from '../utils/logger.js';
import { getFileMetadata } from '../database/files-metadata.js';
import { removeStreamJob } from '../streams/stream-manager.js';

const STREAM_PROTOCOLS = new Set(['hls', 'dash', 'mpegts']);

function sanitizeStreamProtocol(value, fallback = null) {
  if (!value) return fallback;
  const normalized = value.toString().trim().toLowerCase();
  if (STREAM_PROTOCOLS.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function detectStreamProtocolFromUrl(url = '') {
  const lower = (url || '').toString().trim().toLowerCase();
  if (!lower) return null;
  if (lower.includes('.m3u8') || lower.includes('format=m3u8')) {
    return 'hls';
  }
  if (lower.includes('.mpd') || lower.includes('format=mpd') || lower.includes('dash-live') || lower.includes('dash/')) {
    return 'dash';
  }
  if (lower.includes('.ts') || lower.includes('mpegts') || lower.startsWith('udp://') || lower.startsWith('rtp://')) {
    return 'mpegts';
  }
  return null;
}

function resolveStreamProtocol(primaryProtocol, fallbackProtocol, url = '') {
  return sanitizeStreamProtocol(primaryProtocol,
    sanitizeStreamProtocol(fallbackProtocol,
      detectStreamProtocolFromUrl(url) || 'mpegts'));
}

function shouldProxyStreamProtocol(protocol) {
  return protocol === 'mpegts';
}

const DEFAULT_FOLDER_PLAYLIST_INTERVAL_SECONDS = 10;
const serverPlaylistLoops = new Map();

function stopServerPlaylistLoop(deviceId, reason = 'stopped') {
  const loop = serverPlaylistLoops.get(deviceId);
  if (loop?.timer) {
    clearTimeout(loop.timer);
  }
  if (loop) {
    serverPlaylistLoops.delete(deviceId);
    logger.info(`[Playlist] Loop stopped for ${deviceId}`, { deviceId, reason });
  }
}

async function startServerPlaylistLoop(deviceId, file, intervalSeconds, startPage, devices, io) {
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
    logger.error(`[Playlist] Failed to get images count for ${deviceId}/${file}`, { error: error.message, stack: error.stack, deviceId, file });
    return;
  }

  if (!totalImages || totalImages < 1) {
    logger.warn(`[Playlist] Folder ${file} for ${deviceId} has no images, playlist loop skipped`, { deviceId, file });
    return;
  }

  // Определяем начальную страницу: используем startPage если указан, иначе из состояния устройства
  const initialPage = Math.max(1, Math.min(totalImages, Number(startPage) || Number(deviceState.current?.page) || 1));
  deviceState.current.page = initialPage;

  const loopState = {
    deviceId,
    file,
    totalPages: totalImages,
    intervalMs: Math.max(1, intervalSeconds || DEFAULT_FOLDER_PLAYLIST_INTERVAL_SECONDS) * 1000,
    currentPage: initialPage,
    timer: null,
    hasAdvanced: false
  };

  serverPlaylistLoops.set(deviceId, loopState);
  logger.info(`[Playlist] Loop started for ${deviceId} (${file}) total=${totalImages} startPage=${initialPage} interval=${loopState.intervalMs}ms`, { deviceId, file, totalImages, startPage: initialPage, intervalMs: loopState.intervalMs });
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
      logger.warn('[Playlist] State changed, stopping loop', {
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
    
    // Вычисляем следующую страницу с зацикливанием (как было раньше)
    // После последней страницы возвращаемся к первой
    const nextPage = totalPages === 1 ? 1 : (currentPage % totalPages) + 1;

    loopState.currentPage = nextPage;
    deviceState.current.page = nextPage;

    logger.info(`[Playlist] ${loopState.deviceId} -> slide ${nextPage}/${totalPages}`, { deviceId: loopState.deviceId, page: nextPage, totalPages });
    
    // Показываем следующую страницу
    const folderFile = deviceState.current?.playlistFile || deviceState.current?.file || loopState.file;
    io.to(`device:${loopState.deviceId}`).emit('player/folderPage', nextPage);
    io.emit('preview/refresh', { device_id: loopState.deviceId });

    loopState.hasAdvanced = true;

    // Планируем следующую итерацию (зацикливание бесконечно)
    scheduleNextFolderSlide(loopState, devices, io);
  }, loopState.intervalMs);
}

/**
 * Настраивает обработчики управления плеером
 * @param {Socket} socket - Socket.IO сокет
 * @param {Object} deps - Зависимости {devices, io, getPageSlideCount}
 */
export function setupControlHandlers(socket, deps) {
  const { devices, io, getPageSlideCount, applyVolumeCommand, getVolumeState } = deps;

  const emitDeviceVolumeState = (deviceId, reason = 'control_play') => {
    if (typeof getVolumeState !== 'function') {
      return;
    }
    try {
      const state = getVolumeState(deviceId);
      if (!state) return;
      io.to(`device:${deviceId}`).emit('player/volume', {
        level: state.level,
        muted: state.muted,
        reason
      });
    } catch (err) {
      logger.warn('[Control] Failed to emit volume state', { deviceId, error: err.message });
    }
  };
  
  const handleControlPlay = async ({ device_id, file, page, type: requestedType, streamProtocol, originDeviceId, startAt, startDelayMs }) => {
    const d = devices[device_id];
    if (!d) return;
    const normalizedStartAt = Number.isFinite(Number(startAt)) ? Math.floor(Number(startAt)) : null;
    const normalizedStartDelayMs = Number.isFinite(Number(startDelayMs)) ? Math.floor(Number(startDelayMs)) : null;

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
      // КРИТИЧНО: Объявляем hasExtension один раз в начале блока, чтобы она была доступна везде
      const hasExtension = file.includes('.');
      
      // КРИТИЧНО: Если текущий контент - стрим, останавливаем FFmpeg перед запуском нового контента
      // Это нужно делать всегда при переключении, даже если новый контент тоже стрим
      if (d.current && d.current.type === 'streaming' && d.current.file) {
        const currentSafeName = d.current.file;
        // КРИТИЧНО: Останавливаем только если это другой файл или другой тип контента
        if (currentSafeName !== file || requestedType !== 'streaming') {
          removeStreamJob(device_id, currentSafeName, 'switch_content');
          logger.info('[Control] 🛑 Stopped FFmpeg stream on content switch', { 
            deviceId: device_id, 
            currentFile: currentSafeName,
            newFile: file,
            reason: currentSafeName !== file ? 'different_file' : 'different_type'
          });
        }
      }
      
      // КРИТИЧНО: Если текущий контент - видео, и запускается другой тип контента,
      // нужно сначала остановить видео, чтобы звук не продолжал играть
      const wasVideo = d.current && (d.current.type === 'video' || d.current.type === 'streaming') && d.current.state === 'playing';
      const willBeNonVideo = (() => {
        const ext = hasExtension ? file.split('.').pop().toLowerCase() : '';
        const isStreaming = requestedType === 'streaming' || (d.streams && d.streams[file]);
        if (isStreaming) return false;
        return !hasExtension || ext === 'pdf' || ext === 'pptx' || 
               ['png','jpg','jpeg','gif','webp'].includes(ext) || ext === 'zip';
      })();
      
      if (wasVideo && willBeNonVideo) {
        logger.info(`[Control] Останавливаем видео перед запуском другого контента`, { 
          deviceId: device_id, 
          currentFile: d.current?.file,
          newFile: file 
        });
        
        io.to(`device:${device_id}`).emit('player/stop', { reason: 'switch_content' });
        // Даем время на остановку видео перед запуском нового контента
        setTimeout(async () => {
          // Проверяем, что устройство все еще существует и команда актуальна
          const deviceStillExists = devices[device_id];
          if (!deviceStillExists) return;
          
          // КРИТИЧНО: Пересчитываем playbackStreamUrl и effectiveStreamProtocol внутри setTimeout
          // так как они могут быть не определены в этой области видимости
          const ext = hasExtension ? file.split('.').pop().toLowerCase() : '';
          
          // КРИТИЧНО: Ищем стрим сначала в целевом устройстве, затем в устройстве-источнике (если указан)
          let streamEntry = deviceStillExists.streams ? deviceStillExists.streams[file] : undefined;
          if (!streamEntry && originDeviceId && originDeviceId !== device_id) {
            const sourceDevice = devices[originDeviceId];
            if (sourceDevice && sourceDevice.streams) {
              streamEntry = sourceDevice.streams[file];
            }
          }
          
          const requestedStreamProtocol = sanitizeStreamProtocol(streamProtocol);
          const resolvedStreamProtocol = resolveStreamProtocol(streamEntry?.protocol, requestedStreamProtocol, streamEntry?.url);
          let localPlaybackStreamUrl = streamEntry
            ? (shouldProxyStreamProtocol(resolvedStreamProtocol)
              ? (streamEntry.proxyUrl || streamEntry.url)
              : (streamEntry.url || streamEntry.proxyUrl))
            : null;
          let localEffectiveStreamProtocol = null;
          
          // Если это стрим - проверяем протокол и запускаем FFmpeg только если нужно
          if (streamEntry && shouldProxyStreamProtocol(resolvedStreamProtocol)) {
            const { getStreamManager } = await import('../streams/stream-manager.js');
            const streamManager = getStreamManager();
            if (streamManager) {
              const existingUrl = streamManager.getPlaybackUrl(device_id, file);
              if (!existingUrl) {
                // КРИТИЧНО: Если стрим найден в устройстве-источнике, берем метаданные оттуда
                const metadataDeviceId = (originDeviceId && originDeviceId !== device_id && streamEntry && !deviceStillExists.streams?.[file]) ? originDeviceId : device_id;
                const metadata = getFileMetadata(metadataDeviceId, file);
                if (metadata && metadata.content_type === 'streaming') {
                  try {
                    localPlaybackStreamUrl = await streamManager.ensureStreamRunning(device_id, file, metadata);
                  } catch (err) {
                    logger.error('[Control] ❌ Failed to start stream in setTimeout', { deviceId: device_id, file, error: err.message });
                    localPlaybackStreamUrl = streamEntry.proxyUrl || streamEntry.url;
                  }
                }
              } else {
                localPlaybackStreamUrl = existingUrl;
              }
            }
          } else if (streamEntry) {
            // HLS/DASH отдаем напрямую без FFmpeg proxy
            localPlaybackStreamUrl = streamEntry.url || streamEntry.proxyUrl;
          }

          if (streamEntry) {
            localEffectiveStreamProtocol = detectStreamProtocolFromUrl(localPlaybackStreamUrl) || resolvedStreamProtocol;
            logger.info('[Control] 🔍 localEffectiveStreamProtocol determined (setTimeout)', {
              deviceId: device_id,
              file,
              streamEntryProxyUrl: streamEntry?.proxyUrl,
              streamEntryProtocol: streamEntry?.protocol,
              requestedStreamProtocol,
              resolvedStreamProtocol,
              localEffectiveStreamProtocol
            });
          }
          
          // Определяем тип нового контента
          // КРИТИЧНО: Приоритет у requestedType (переданного с фронта), затем streamEntry, затем fallback по расширению
          let type = requestedType || null;
          if (!type) {
            if (!hasExtension) {
              type = 'folder';
            } else if (ext === 'pdf') {
              type = 'pdf';
            } else if (ext === 'pptx') {
              type = 'pptx';
            } else if (['png','jpg','jpeg','gif','webp'].includes(ext)) {
              type = 'image';
            } else if (ext === 'zip') {
              type = 'folder';
            } else if (streamEntry) {
              type = 'streaming';
            } else {
              type = 'video';
            }
          } else if (streamEntry && type !== 'streaming') {
            // Если streamEntry найден, но тип не streaming - принудительно streaming
            type = 'streaming';
          }
          
          const pageNum = page || 1;
          deviceStillExists.current = { 
            type, 
            file, 
            state: 'playing', 
            page: (type === 'pdf' || type === 'pptx' || type === 'folder') ? pageNum : undefined
          };
          if (type === 'streaming') {
            deviceStillExists.current.streamUrl = localPlaybackStreamUrl;
            deviceStillExists.current.streamProtocol = localEffectiveStreamProtocol || 'hls'; // По умолчанию HLS для рестрима
            logger.info('[Control] ✅ Set streamProtocol in device.current (setTimeout)', {
              deviceId: device_id,
              file,
              streamProtocol: deviceStillExists.current.streamProtocol,
              streamUrl: localPlaybackStreamUrl
            });
          }
          
          // Логируем перед отправкой (для первого случая - переключение типа контента)
          if (type === 'streaming') {
            logger.info('[Control] 📡 [1] Sending player/play for stream (type switch)', {
              deviceId: device_id,
              file,
              stream_url: localPlaybackStreamUrl,
              stream_protocol: localEffectiveStreamProtocol,
              hasStreamUrl: !!localPlaybackStreamUrl
            });
          }
          
          io.to(`device:${device_id}`).emit('player/play', {
            ...deviceStillExists.current,
            stream_url: type === 'streaming' ? localPlaybackStreamUrl : undefined,
            stream_protocol: type === 'streaming' ? localEffectiveStreamProtocol : undefined,
            startAt: normalizedStartAt || undefined,
            startDelayMs: normalizedStartDelayMs || undefined
          });
          emitDeviceVolumeState(device_id, 'control_play');
          io.emit('preview/refresh', { device_id });
        }, 150);
        return; // Выходим, запуск нового контента произойдет в setTimeout
      }
      
      // Проверяем есть ли расширение у файла (hasExtension уже объявлена выше)
      const ext = hasExtension ? file.split('.').pop().toLowerCase() : '';
      
      // КРИТИЧНО: Ищем стрим сначала в целевом устройстве, затем в устройстве-источнике (если указан)
      let streamEntry = d.streams ? d.streams[file] : undefined;
      if (!streamEntry && originDeviceId && originDeviceId !== device_id) {
        const sourceDevice = devices[originDeviceId];
        if (sourceDevice && sourceDevice.streams) {
          streamEntry = sourceDevice.streams[file];
          logger.info('[Control] 🔍 Stream found in source device', {
            deviceId: device_id,
            sourceDeviceId: originDeviceId,
            file,
            streamEntryFound: !!streamEntry,
            streamEntryUrl: streamEntry?.url,
            streamEntryProtocol: streamEntry?.protocol
          });
        }
      }
      
      const requestedStreamProtocol = sanitizeStreamProtocol(streamProtocol);
      const resolvedStreamProtocol = resolveStreamProtocol(streamEntry?.protocol, requestedStreamProtocol, streamEntry?.url);
      
      logger.info('[Control] 🔍 Stream entry lookup', {
        deviceId: device_id,
        originDeviceId,
        file,
        hasStreams: !!d.streams,
        streamKeys: d.streams ? Object.keys(d.streams) : [],
        streamEntryFound: !!streamEntry,
        streamEntryUrl: streamEntry?.url,
        streamEntryProtocol: streamEntry?.protocol
      });
      
      // КРИТИЧНО: Lazy loading - запускаем FFmpeg только когда стрим действительно воспроизводится
      let playbackStreamUrl = streamEntry
        ? (shouldProxyStreamProtocol(resolvedStreamProtocol)
          ? (streamEntry.proxyUrl || streamEntry.url)
          : (streamEntry.url || streamEntry.proxyUrl))
        : null;
      
      // Если стрим найден - проверяем протокол и запускаем FFmpeg только если нужно
      if (streamEntry) {
        const streamProtocol = resolvedStreamProtocol;

        if (shouldProxyStreamProtocol(streamProtocol)) {
          const { getStreamManager } = await import('../streams/stream-manager.js');
          const streamManager = getStreamManager();
          if (streamManager) {
            // Проверяем, есть ли уже запущенный процесс или существующие файлы
            const existingUrl = streamManager.getPlaybackUrl(device_id, file);
            logger.info('[Control] 🔍 Checking stream status', {
              deviceId: device_id,
              file,
              protocol: streamProtocol,
              hasExistingUrl: !!existingUrl,
              existingUrl,
              streamEntryProxyUrl: streamEntry.proxyUrl
            });
            
            if (!existingUrl) {
              // FFmpeg не запущен - запускаем его (lazy loading)
              // КРИТИЧНО: Если стрим найден в устройстве-источнике, берем метаданные оттуда
              const metadataDeviceId = (originDeviceId && originDeviceId !== device_id && !d.streams?.[file]) ? originDeviceId : device_id;
              const metadata = getFileMetadata(metadataDeviceId, file);
              logger.info('[Control] 🔍 Checking metadata for stream', {
                deviceId: device_id,
                metadataDeviceId,
                originDeviceId,
                file,
                hasMetadata: !!metadata,
                contentType: metadata?.content_type,
                streamUrl: metadata?.stream_url,
                streamProtocol: metadata?.stream_protocol
              });
              
              if (metadata && metadata.content_type === 'streaming') {
                try {
                  logger.info('[Control] 🚀 Calling ensureStreamRunning', {
                    deviceId: device_id,
                    file,
                    streamUrl: metadata.stream_url,
                    streamProtocol: metadata.stream_protocol
                  });
                  playbackStreamUrl = await streamManager.ensureStreamRunning(device_id, file, metadata);
                  
                  // КРИТИЧНО: Если ensureStreamRunning вернул null, используем fallback
                  if (!playbackStreamUrl) {
                    logger.warn('[Control] ⚠️ ensureStreamRunning returned null, using fallback', {
                      deviceId: device_id,
                      file,
                      streamEntryProxyUrl: streamEntry.proxyUrl,
                      streamEntryUrl: streamEntry.url
                    });
                    playbackStreamUrl = streamEntry.proxyUrl || streamEntry.url;
                  } else {
                    logger.info('[Control] ✅ Lazy started stream for playback', { 
                      deviceId: device_id, 
                      file,
                      protocol: streamProtocol,
                      playbackUrl: playbackStreamUrl 
                    });
                    
                    // КРИТИЧНО: Обновляем streamEntry.proxyUrl после запуска FFmpeg
                    streamEntry.proxyUrl = playbackStreamUrl;
                  }
                } catch (err) {
                  logger.error('[Control] ❌ Failed to start stream', { 
                    deviceId: device_id, 
                    file,
                    error: err.message,
                    stack: err.stack
                  });
                  // Fallback: используем предварительно сформированный URL
                  playbackStreamUrl = streamEntry.proxyUrl || streamEntry.url;
                }
              } else {
                logger.warn('[Control] ⚠️ Stream metadata not found or wrong type', {
                  deviceId: device_id,
                  file,
                  hasMetadata: !!metadata,
                  contentType: metadata?.content_type
                });
                // Используем предварительно сформированный URL
                playbackStreamUrl = streamEntry.proxyUrl || streamEntry.url;
              }
            } else {
              // FFmpeg уже запущен - используем существующий URL
              playbackStreamUrl = existingUrl;
              logger.debug('[Control] Stream already running', { deviceId: device_id, file, playbackUrl: existingUrl });
            }
          } else {
            logger.warn('[Control] ⚠️ StreamManager not available', { deviceId: device_id, file });
            // Fallback: используем предварительно сформированный URL
            playbackStreamUrl = streamEntry.proxyUrl || streamEntry.url;
          }
        } else {
          // HLS/DASH отдаем напрямую без FFmpeg proxy
          playbackStreamUrl = streamEntry.url || streamEntry.proxyUrl;
          logger.info('[Control] ✅ Using direct stream URL (no proxy)', {
            deviceId: device_id,
            file,
            protocol: streamProtocol,
            playbackUrl: playbackStreamUrl
          });
        }
      }
      
      // Логируем для отладки стримов
      if (streamEntry) {
        logger.info('[Control] Stream entry found', {
          deviceId: device_id,
          file,
          hasProxyUrl: !!streamEntry.proxyUrl,
          proxyUrl: streamEntry.proxyUrl,
          originalUrl: streamEntry.url,
          playbackStreamUrl
        });
      }
      
      // Определяем тип контента
      // КРИТИЧНО: Приоритет у requestedType (переданного с фронта), затем БД, затем fallback по расширению
      let type = requestedType || null;
      
      // Если тип не передан - проверяем БД
      if (!type) {
        // КРИТИЧНО: Если указан originDeviceId, проверяем метаданные в устройстве-источнике
        const metadataDeviceId = (originDeviceId && originDeviceId !== device_id) ? originDeviceId : device_id;
        const metadata = getFileMetadata(metadataDeviceId, file);
        if (metadata && metadata.content_type) {
          type = metadata.content_type;
          logger.info('[Control] 🔍 Type from DB', {
            deviceId: device_id,
            metadataDeviceId,
            originDeviceId,
            file,
            contentType: metadata.content_type
          });
        }
      }
      
      // Если streamEntry найден - принудительно streaming
      if (streamEntry) {
        type = 'streaming';
      } else if (!type || type === 'video') {
        // Fallback по расширению только если тип не определён или это video (старые записи)
        if (!hasExtension) {
          type = 'folder';
        } else if (ext === 'pdf') {
          type = 'pdf';
        } else if (ext === 'pptx') {
          type = 'pptx';
        } else if (['png','jpg','jpeg','gif','webp'].includes(ext)) {
          type = 'image';
        } else if (ext === 'zip') {
          type = 'folder';
        } else {
          type = type || 'video'; // По умолчанию video только если ничего не подошло
        }
      }
      
      logger.info('[Control] 📋 Content type determined', {
        deviceId: device_id,
        file,
        type,
        hasStreamEntry: !!streamEntry,
        requestedType
      });
      
      // КРИТИЧНО: Если тип streaming, но streamEntry не найден - проверяем БД
      // Это может произойти после перезапуска сервера, когда d.streams еще не обновлен
      if (type === 'streaming' && !streamEntry) {
        logger.warn('[Control] ⚠️ Streaming entry not found in d.streams, checking DB', { 
          deviceId: device_id, 
          file,
          hasStreams: !!d.streams,
          streamKeys: d.streams ? Object.keys(d.streams) : []
        });
        
        // Проверяем БД - может быть стрим есть, но d.streams не обновлен
        const metadata = getFileMetadata(device_id, file);
        logger.info('[Control] 🔍 DB metadata check', {
          deviceId: device_id,
          file,
          hasMetadata: !!metadata,
          contentType: metadata?.content_type,
          streamUrl: metadata?.stream_url,
          streamProtocol: metadata?.stream_protocol
        });
        
        if (metadata && metadata.content_type === 'streaming') {
          const metadataProtocol = resolveStreamProtocol(metadata.stream_protocol, requestedStreamProtocol, metadata.stream_url);

          logger.info('[Control] ✅ Stream found in DB, preparing playback strategy', { 
            deviceId: device_id, 
            file,
            streamUrl: metadata.stream_url,
            streamProtocol: metadata.stream_protocol,
            resolvedProtocol: metadataProtocol
          });
          // Создаем временный streamEntry из метаданных БД
          const tempStreamEntry = {
            name: metadata.original_name || file,
            url: metadata.stream_url,
            proxyUrl: null, // Будет установлен после запуска FFmpeg
            protocol: metadataProtocol
          };
          
          if (shouldProxyStreamProtocol(metadataProtocol)) {
            const { getStreamManager } = await import('../streams/stream-manager.js');
            const streamManager = getStreamManager();
            if (streamManager) {
              try {
                playbackStreamUrl = await streamManager.ensureStreamRunning(device_id, file, metadata);
                
                // КРИТИЧНО: Если ensureStreamRunning вернул null, используем fallback
                if (!playbackStreamUrl) {
                  logger.warn('[Control] ⚠️ ensureStreamRunning returned null from DB, using fallback', {
                    deviceId: device_id,
                    file,
                    streamUrl: metadata.stream_url
                  });
                  playbackStreamUrl = metadata.stream_url;
                  tempStreamEntry.proxyUrl = null;
                } else {
                  tempStreamEntry.proxyUrl = playbackStreamUrl;
                  logger.info('[Control] ✅ FFmpeg started from DB metadata', { 
                    deviceId: device_id, 
                    file,
                    protocol: tempStreamEntry.protocol,
                    playbackUrl: playbackStreamUrl 
                  });
                }
              } catch (err) {
                logger.error('[Control] ❌ Failed to start stream from DB', { 
                  deviceId: device_id, 
                  file,
                  error: err.message 
                });
                // Fallback: используем оригинальный URL
                playbackStreamUrl = metadata.stream_url;
                tempStreamEntry.proxyUrl = null;
              }
            } else {
              logger.error('[Control] ❌ StreamManager not available', { deviceId: device_id, file });
              // Fallback: используем оригинальный URL
              playbackStreamUrl = metadata.stream_url;
              tempStreamEntry.proxyUrl = null;
            }
          } else {
            // HLS/DASH из БД отдаем напрямую
            // Fallback: используем оригинальный URL
            playbackStreamUrl = metadata.stream_url;
            tempStreamEntry.proxyUrl = null;
            logger.info('[Control] ✅ Using direct stream URL from DB (no proxy)', {
              deviceId: device_id,
              file,
              protocol: tempStreamEntry.protocol,
              playbackUrl: playbackStreamUrl
            });
          }
          
          // Используем временный streamEntry
          streamEntry = tempStreamEntry;
          playbackStreamUrl = streamEntry.proxyUrl || streamEntry.url;
        } else {
          logger.error('[Control] ❌ Stream not found in DB either', { deviceId: device_id, file });
          return; // Стрим не найден ни в d.streams, ни в БД
        }
      }
      
      // КРИТИЧНО: Определяем эффективный протокол для воспроизведения
      // Если используется proxyUrl (HLS рестрим через FFmpeg), протокол всегда 'hls'
      // Если proxyUrl НЕТ, определяем по protocol / requestedStreamProtocol / URL
      const baseProtocol = resolveStreamProtocol(streamEntry?.protocol, requestedStreamProtocol, streamEntry?.url || playbackStreamUrl);
      const playbackProtocol = detectStreamProtocolFromUrl(playbackStreamUrl);
      const effectiveStreamProtocol = type === 'streaming'
        ? (playbackProtocol || baseProtocol)
        : null;
      
      // Логируем для отладки DASH стримов
      if (type === 'streaming' && streamEntry) {
        logger.info('[Control] 🔍 Protocol determination', {
          deviceId: device_id,
          file,
          streamEntryProtocol: streamEntry.protocol,
          streamEntryProxyUrl: streamEntry.proxyUrl,
          requestedStreamProtocol,
          effectiveStreamProtocol,
          playbackStreamUrl
        });
      }
      
      // КРИТИЧНО: Если переключаемся между разными типами контента, останавливаем предыдущий
      const currentType = d.current?.type;
      const isTypeChange = currentType && currentType !== type;
      
      if (isTypeChange) {
        logger.info(`[Control] Останавливаем предыдущий контент перед переключением типа`, { 
          deviceId: device_id, 
          fromType: currentType,
          toType: type,
          currentFile: d.current?.file,
          newFile: file 
        });
        
        // КРИТИЧНО: Останавливаем FFmpeg для стримов при переключении типа
        if (currentType === 'streaming' && d.current?.file) {
          const safeName = d.current.file;
          removeStreamJob(device_id, safeName, 'type_switch');
          logger.info('[Control] 🛑 Stopped FFmpeg stream on type switch', { deviceId: device_id, file: safeName });
        }
        
        io.to(`device:${device_id}`).emit('player/stop', { reason: 'switch_content' });
        // Даем время на остановку предыдущего контента
        setTimeout(() => {
          // Проверяем, что устройство все еще существует
          const deviceStillExists = devices[device_id];
          if (!deviceStillExists) return;
          
          const pageNum = page || 1;
          
          // КРИТИЧНО: Сохраняем флаги плейлиста, если плейлист был активен для этого файла
          const wasPlaylistActive = deviceStillExists.current?.playlistActive && deviceStillExists.current?.playlistFile === file;
          const savedPlaylistInterval = deviceStillExists.current?.playlistInterval;
          
          d.current = { 
            type, 
            file, 
            state: 'playing', 
            page: (type === 'pdf' || type === 'pptx' || type === 'folder') ? pageNum : undefined 
          };
          if (type === 'streaming') {
            d.current.streamUrl = playbackStreamUrl;
            d.current.streamProtocol = effectiveStreamProtocol || 'hls'; // По умолчанию HLS для рестрима
            logger.info('[Control] ✅ Set streamProtocol in device.current (setTimeout type switch)', {
              deviceId: device_id,
              file,
              streamProtocol: d.current.streamProtocol,
              streamUrl: playbackStreamUrl
            });
          }
          
          // Восстанавливаем флаги плейлиста, если плейлист был активен
          if (wasPlaylistActive && type === 'folder') {
            d.current.playlistActive = true;
            d.current.playlistFile = file;
            d.current.playlistInterval = savedPlaylistInterval;
          }
          
          // Логируем перед отправкой (для второго случая - переключение типа контента в setTimeout)
          if (type === 'streaming') {
            logger.info('[Control] 📡 [2] Sending player/play for stream (type switch setTimeout)', {
              deviceId: device_id,
              file,
              stream_url: playbackStreamUrl,
              stream_protocol: effectiveStreamProtocol,
              hasStreamUrl: !!playbackStreamUrl
            });
          }
          
          io.to(`device:${device_id}`).emit('player/play', {
            ...d.current,
            stream_url: type === 'streaming' ? playbackStreamUrl : undefined,
            stream_protocol: type === 'streaming' ? effectiveStreamProtocol : undefined,
            startAt: normalizedStartAt || undefined,
            startDelayMs: normalizedStartDelayMs || undefined
          });
          emitDeviceVolumeState(device_id, 'control_play');
          io.emit('preview/refresh', { device_id });
        }, 100);
        return; // Выходим, запуск нового контента произойдет в setTimeout
      }
      
      // Используем переданный номер страницы или 1 по умолчанию
      const pageNum = page || 1;
      
      // КРИТИЧНО: Сохраняем флаги плейлиста, если плейлист был активен для этого файла
      // НЕ останавливаем плейлист, если запускается тот же файл
      const wasPlaylistActive = d.current?.playlistActive && d.current?.playlistFile === file;
      const savedPlaylistInterval = d.current?.playlistInterval;
      const savedPlaylistFile = d.current?.playlistFile;
      
      d.current = { 
        type, 
        file, 
        state: 'playing', 
        page: (type === 'pdf' || type === 'pptx' || type === 'folder') ? pageNum : undefined,
        originDeviceId: originDeviceId || device_id
      };
      if (type === 'streaming') {
        d.current.streamUrl = playbackStreamUrl;
        d.current.streamProtocol = effectiveStreamProtocol || 'hls'; // По умолчанию HLS для рестрима
        logger.info('[Control] ✅ Set streamProtocol in device.current', {
          deviceId: device_id,
          file,
          streamProtocol: d.current.streamProtocol,
          streamUrl: playbackStreamUrl
        });
      }
      
      // Восстанавливаем флаги плейлиста, если плейлист был активен для того же файла
      if (wasPlaylistActive && type === 'folder' && file === savedPlaylistFile) {
        d.current.playlistActive = true;
        d.current.playlistFile = file;
        d.current.playlistInterval = savedPlaylistInterval;
        logger.info(`[Control] Плейлист сохранен при control/play для того же файла`, { deviceId: device_id, file });
      }
      
      // КРИТИЧНО: Логируем что отправляется в плеер
      if (type === 'streaming') {
        logger.info('[Control] 📡 Sending player/play for stream', {
          deviceId: device_id,
          file,
          type,
          stream_url: playbackStreamUrl,
          stream_protocol: effectiveStreamProtocol,
          hasStreamUrl: !!playbackStreamUrl,
          playbackStreamUrlIsNull: playbackStreamUrl === null
        });
        
        // Проверяем, что playbackStreamUrl установлен
        if (!playbackStreamUrl) {
          logger.error('[Control] ❌ playbackStreamUrl is null for streaming! Using fallback URL.', {
            deviceId: device_id,
            file,
            streamEntry: !!streamEntry,
            streamEntryProxyUrl: streamEntry?.proxyUrl,
            streamEntryUrl: streamEntry?.url
          });
          // Используем fallback URL из streamEntry
          playbackStreamUrl = streamEntry?.proxyUrl || streamEntry?.url;
          if (!playbackStreamUrl) {
            logger.error('[Control] ❌ No fallback URL available! Cannot play stream.', {
              deviceId: device_id,
              file
            });
            return; // Не отправляем событие если нет URL вообще
          }
        }
      }
      
          io.to(`device:${device_id}`).emit('player/play', {
            ...d.current,
            stream_url: type === 'streaming' ? playbackStreamUrl : undefined,
            stream_protocol: type === 'streaming' ? effectiveStreamProtocol : undefined,
            startAt: normalizedStartAt || undefined,
            startDelayMs: normalizedStartDelayMs || undefined
          });
      emitDeviceVolumeState(device_id, 'control_play');
    } else {
      // КРИТИЧНО: Если файл не указан - это RESUME после паузы
      // Отправляем команду player/resume чтобы плеер продолжил с места паузы
      // НЕ отправляем player/play - это перезагрузит файл с начала!
      if (d.current) {
        d.current.state = 'playing';
      }
      io.to(`device:${device_id}`).emit('player/resume');
      emitDeviceVolumeState(device_id, 'control_resume');
      logger.info(`[Control] ▶️ Resume: ${device_id} (продолжение с места паузы)`, { deviceId: device_id });
    }
    
    io.emit('preview/refresh', { device_id });
  };

  socket.on('control/play', handleControlPlay);

  socket.on('control/play-batch', async ({ device_ids, file, page, type, streamProtocol, originDeviceId, startDelayMs }) => {
    try {
      const rawDeviceIds = Array.isArray(device_ids) ? device_ids : [];
      const targetDeviceIds = Array.from(new Set(rawDeviceIds.filter((deviceId) => typeof deviceId === 'string' && deviceId.trim())));

      if (!targetDeviceIds.length) {
        return;
      }

      const availableDeviceIds = targetDeviceIds.filter((deviceId) => Boolean(devices[deviceId]));
      if (!availableDeviceIds.length) {
        return;
      }

      const parsedDelayMs = Number(startDelayMs);
      const safeDelayMs = Number.isFinite(parsedDelayMs)
        ? Math.min(10000, Math.max(700, Math.floor(parsedDelayMs)))
        : 1800;
      const synchronizedStartAt = Date.now() + safeDelayMs;

      logger.info('[Control] play-batch scheduled', {
        targets: availableDeviceIds,
        file,
        type,
        startDelayMs: safeDelayMs,
        startAt: synchronizedStartAt
      });

      await Promise.all(availableDeviceIds.map((targetDeviceId) =>
        handleControlPlay({
          device_id: targetDeviceId,
          file,
          page,
          type,
          streamProtocol,
          originDeviceId,
          startAt: synchronizedStartAt,
          startDelayMs: safeDelayMs
        })
      ));
    } catch (err) {
      logger.error('[Control] play-batch failed', { error: err.message, file, type });
    }
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

  // control/seek - Перемотка медиа (видео/аудио)
  socket.on('control/seek', ({ device_id, position, file }) => {
    const d = devices[device_id];
    if (!d) return;
    
    // Проверяем, что текущий контент - видео или аудио
    if (d.current && (d.current.type === 'video' || d.current.type === 'audio')) {
      // Проверяем, что файл совпадает (если указан)
      if (!file || d.current.file === file) {
        const targetPosition = typeof position === 'number' && position >= 0 ? position : 0;
        io.to(`device:${device_id}`).emit('player/seek', { position: targetPosition });
        logger.info(`[Control] 🎯 Seek: ${device_id} -> ${targetPosition}s`, { deviceId: device_id, position: targetPosition });
      }
    }
  });

  // control/stop - Остановка
  socket.on('control/stop', ({ device_id }) => {
    const d = devices[device_id];
    if (!d) return;
    
    // КРИТИЧНО: Останавливаем FFmpeg для стримов
    if (d.current && d.current.type === 'streaming' && d.current.file) {
      const safeName = d.current.file;
      removeStreamJob(device_id, safeName, 'manual_stop');
      logger.info('[Control] 🛑 Stopped FFmpeg stream on manual stop', { deviceId: device_id, file: safeName });
    }
    
    // Останавливаем плейлист если был активен
    if (d.current && d.current.playlistActive) {
      d.current.playlistActive = false;
      d.current.playlistInterval = undefined;
      d.current.playlistFile = undefined;
      io.emit('playlist/state', { device_id, active: false });
    }
    
    d.current = { type: 'idle', file: null, state: 'idle' };
    io.to(`device:${device_id}`).emit('player/stop', { reason: 'manual_stop' });
    io.emit('preview/refresh', { device_id });
    stopServerPlaylistLoop(device_id, 'control stop');
  });
  
  socket.on('control/volume', ({ device_id, level, delta, muted }) => {
    if (!device_id || typeof applyVolumeCommand !== 'function') {
      return;
    }
    try {
      applyVolumeCommand(
        device_id,
        {
          level: typeof level === 'number' ? level : undefined,
          delta: typeof delta === 'number' ? delta : undefined,
          muted: typeof muted === 'boolean' ? muted : undefined
        },
        { source: 'control' }
      );
    } catch (err) {
      logger.warn('[Control] Volume command failed', { deviceId: device_id, error: err.message });
    }
  });

  // control/playlistStart - Запуск плейлиста папки
  socket.on('control/playlistStart', async ({ device_id, file, intervalSeconds, startPage }) => {
    const d = devices[device_id];
    if (!d) return;
    
    // Останавливаем текущее видео, если оно воспроизводится
    if (d.current && d.current.type === 'video' && d.current.state === 'playing') {
      logger.info(`[Playlist] Останавливаем текущее видео перед запуском плейлиста`, { deviceId: device_id, currentFile: d.current.file });
      io.to(`device:${device_id}`).emit('player/stop', { reason: 'switch_content' });
      // Даем время на остановку видео
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Останавливаем активный плейлист, если был запущен другой файл
    if (d.current && d.current.playlistActive && d.current.playlistFile !== file) {
      stopServerPlaylistLoop(device_id, 'switching playlist');
    }
    
    // Определяем начальную страницу: если указана startPage - используем её, иначе начинаем с первой
    const initialPage = Math.max(1, Number(startPage) || 1);
    
    // Проверяем, какая страница уже показывается на устройстве
    const currentShowingPage = d.current?.page || 1;
    
    // Обновляем состояние устройства с информацией о плейлисте
    if (!d.current) {
      d.current = { type: 'folder', file, state: 'playing', page: initialPage };
    }
    d.current.playlistActive = true;
    d.current.playlistInterval = intervalSeconds || 10;
    d.current.playlistFile = file;
    d.current.type = 'folder';
    d.current.file = file;
    d.current.state = 'playing';
    d.current.page = initialPage;
    
    // Показываем начальную страницу только если она отличается от текущей
    // Если страница уже показывается - не моргаем, просто начинаем отсчет таймера
    if (initialPage !== currentShowingPage || !d.current.page) {
      io.to(`device:${device_id}`).emit('player/folderPage', initialPage);
      io.emit('preview/refresh', { device_id });
    }
    
    // Рассылаем состояние плейлиста всем панелям для синхронизации
    io.emit('playlist/state', {
      device_id,
      active: true,
      file,
      intervalSeconds: d.current.playlistInterval
    });
    io.emit('devices/updated', { device_id });

    try {
      await startServerPlaylistLoop(device_id, file, d.current.playlistInterval, initialPage, devices, io);
    } catch (error) {
      logger.error('[Playlist] Failed to start server loop', { error: error.message, stack: error.stack, deviceId: device_id, file });
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
  socket.on('control/pdfPrev', async ({ device_id }) => {
    const d = devices[device_id];
    if (!d || !d.current) {
      logger.warn(`[Control] pdfPrev: device or current state not found`, { deviceId: device_id, hasDevice: !!d, hasCurrent: !!d?.current });
      return;
    }
    
    logger.info(`[Control] pdfPrev received`, { deviceId: device_id, type: d.current.type, file: d.current.file, page: d.current.page });
    
    // КРИТИЧНО: Кнопки работают ТОЛЬКО для статических типов контента (PDF/PPTX/FOLDER)
    // НЕ должны переключать на другие типы контента (видео, изображения, заглушка)
    if (!d.current.type || (d.current.type !== 'pdf' && d.current.type !== 'pptx' && d.current.type !== 'folder')) {
      logger.warn(`[Control] pdfPrev: unsupported content type for navigation`, { deviceId: device_id, type: d.current.type, file: d.current.file });
      return; // Просто игнорируем, не делаем ничего
    }
    
    if (d.current.type === 'pdf') {
      d.current.page = Math.max(1, (d.current.page || 1) - 1);
      io.to(`device:${device_id}`).emit('player/pdfPage', d.current.page);
      io.emit('player/pdfPage', d.current.page); // Для спикера
    } else if (d.current.type === 'pptx') {
      d.current.page = Math.max(1, (d.current.page || 1) - 1);
      io.to(`device:${device_id}`).emit('player/pptxPage', d.current.page);
      io.emit('player/pptxPage', d.current.page); // Для спикера
    } else if (d.current.type === 'folder' && d.current.file) {
      // Получаем количество изображений в папке для проверки границ
      // КРИТИЧНО: Используем originDeviceId если есть (для файлов из "Все файлы"), иначе device_id
      const contentDeviceId = d.current.originDeviceId || device_id;
      const folderName = d.current.file.replace(/\.zip$/i, ''); // Убираем .zip если есть
      try {
        const maxImages = await getFolderImagesCount(contentDeviceId, folderName);
        logger.info(`[Control] pdfPrev folder: maxImages=${maxImages}, currentPage=${d.current.page}`, { deviceId: device_id, folderName, maxImages, currentPage: d.current.page });
        if (maxImages > 0) {
          const prevImage = Math.max(1, (d.current.page || 1) - 1);
          logger.info(`[Control] pdfPrev folder: prevImage=${prevImage}, currentPage=${d.current.page}`, { deviceId: device_id, prevImage, currentPage: d.current.page });
          d.current.page = prevImage;
          logger.info(`[Control] 📁 Folder prev: ${device_id} -> page ${prevImage}/${maxImages}`, { deviceId: device_id, page: prevImage, maxImages, file: d.current.file });
          io.to(`device:${device_id}`).emit('player/folderPage', d.current.page);
          // КРИТИЧНО: НЕ отправляем всем - только конкретному устройству!
          // Спикер обновится через preview/refresh
          io.emit('preview/refresh', { device_id });
        } else {
          logger.warn(`[Control] pdfPrev folder: maxImages is 0`, { deviceId: device_id, folderName });
        }
      } catch (error) {
        logger.error(`[Control] ❌ Error getting folder images count for ${device_id}/${folderName}`, { error: error.message, deviceId: device_id, folderName, stack: error.stack });
      }
    }
    // else больше не нужен - все несовместимые типы обработаны выше
  });

  // control/pdfNext - Следующая страница/слайд/изображение
  socket.on('control/pdfNext', async ({ device_id }) => {
    const d = devices[device_id];
    if (!d || !d.current) {
      logger.warn(`[Control] pdfNext: device or current state not found`, { deviceId: device_id, hasDevice: !!d, hasCurrent: !!d?.current });
      return;
    }
    
    logger.info(`[Control] pdfNext received`, { deviceId: device_id, type: d.current.type, file: d.current.file, page: d.current.page });
    
    // КРИТИЧНО: Кнопки работают ТОЛЬКО для статических типов контента (PDF/PPTX/FOLDER)
    // НЕ должны переключать на другие типы контента (видео, изображения, заглушка)
    if (!d.current.type || (d.current.type !== 'pdf' && d.current.type !== 'pptx' && d.current.type !== 'folder')) {
      logger.warn(`[Control] pdfNext: unsupported content type for navigation`, { deviceId: device_id, type: d.current.type, file: d.current.file });
      return; // Просто игнорируем, не делаем ничего
    }
    
    // КРИТИЧНО: Используем originDeviceId если есть (для файлов из "Все файлы"), иначе device_id
    const contentDeviceId = d.current.originDeviceId || device_id;
    
    if (d.current.type === 'pdf' && d.current.file) {
      const maxPages = await getPageSlideCount(contentDeviceId, d.current.file, 'page');
      if (maxPages > 0) {
        const nextPage = Math.min((d.current.page || 1) + 1, maxPages);
        if (nextPage !== d.current.page) {
          d.current.page = nextPage;
          io.to(`device:${device_id}`).emit('player/pdfPage', d.current.page);
          io.emit('player/pdfPage', d.current.page); // Для спикера
        }
      }
    } else if (d.current.type === 'pptx' && d.current.file) {
      const maxSlides = await getPageSlideCount(contentDeviceId, d.current.file, 'slide');
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
      try {
        const maxImages = await getFolderImagesCount(contentDeviceId, folderName);
        logger.info(`[Control] pdfNext folder: maxImages=${maxImages}, currentPage=${d.current.page}`, { deviceId: device_id, folderName, maxImages, currentPage: d.current.page });
        if (maxImages > 0) {
          const nextImage = Math.min((d.current.page || 1) + 1, maxImages);
          logger.info(`[Control] pdfNext folder: nextImage=${nextImage}, currentPage=${d.current.page}`, { deviceId: device_id, nextImage, currentPage: d.current.page });
          d.current.page = nextImage;
          logger.info(`[Control] 📁 Folder next: ${device_id} -> page ${nextImage}/${maxImages}`, { deviceId: device_id, page: nextImage, maxImages, file: d.current.file });
          io.to(`device:${device_id}`).emit('player/folderPage', d.current.page);
          // КРИТИЧНО: НЕ отправляем всем - только конкретному устройству!
          // Спикер обновится через preview/refresh
          io.emit('preview/refresh', { device_id });
        } else {
          logger.warn(`[Control] pdfNext folder: maxImages is 0`, { deviceId: device_id, folderName });
        }
      } catch (error) {
        logger.error(`[Control] ❌ Error getting folder images count for ${device_id}/${folderName}`, { error: error.message, deviceId: device_id, folderName, stack: error.stack });
      }
    }
    // else больше не нужен - все несовместимые типы обработаны выше
  });
}

