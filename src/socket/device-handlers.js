/**
 * Обработчики устройств (player/register, player/ping)
 * @module socket/device-handlers
 */

import { getActiveConnections, getDeviceSockets } from './connection-manager.js';
import { getFileMetadata } from '../database/files-metadata.js';
import { saveDevice } from '../database/database.js';
import logger, { logSocket } from '../utils/logger.js';
import { recordSocketEvent } from '../utils/metrics.js';

/**
 * Настраивает обработчики регистрации и пингов устройств
 * @param {Socket} socket - Socket.IO сокет
 * @param {Object} deps - Зависимости {devices, io}
 */
export function setupDeviceHandlers(socket, deps) {
  const { devices, io } = deps;
  const activeConnections = getActiveConnections();
  const deviceSockets = getDeviceSockets();
  const ensureCurrentState = (deviceId) => {
    if (!devices[deviceId].current) {
      devices[deviceId].current = { type: 'idle', file: null, state: 'idle' };
    }
  };
  
  // player/register - Регистрация устройства
  socket.on('player/register', ({ device_id, device_type, capabilities, platform }) => {
    try {
      recordSocketEvent('message');
      
      if (!device_id || !devices[device_id]) {
        logSocket('warn', `Device registration rejected: unknown device ${device_id}`, { socketId: socket.id });
        socket.emit('player/reject', { reason: 'unknown_device' });
        return;
      }
    
      const defaultCapabilities = {
        video: true,
        audio: true,
        images: true,
        pdf: true,
        pptx: true,
        streaming: true
      };
      
      // Получаем IP адрес клиента
      // КРИТИЧНО: Читаем реальный IP из заголовков nginx (X-Real-IP или X-Forwarded-For)
      let clientIP = null;
      try {
        // Приоритет 1: Заголовок X-Real-IP от nginx (самый надежный)
        if (socket.request?.headers?.['x-real-ip']) {
          clientIP = socket.request.headers['x-real-ip'];
        }
        
        // Приоритет 2: Заголовок X-Forwarded-For от nginx
        // X-Forwarded-For может содержать цепочку IP: "client, proxy1, proxy2"
        // Берем первый IP (клиент)
        if (!clientIP && socket.request?.headers?.['x-forwarded-for']) {
          const forwardedFor = socket.request.headers['x-forwarded-for'];
          if (typeof forwardedFor === 'string') {
            // Берем первый IP из цепочки
            clientIP = forwardedFor.split(',')[0].trim();
          }
        }
        
        // Приоритет 3: Socket.IO native адрес (для прямых подключений без nginx)
        if (!clientIP && socket.handshake?.address) {
          clientIP = typeof socket.handshake.address === 'string' 
            ? socket.handshake.address 
            : socket.handshake.address?.address;
        }
        
        // Приоритет 4: Socket.IO 3.x и fallback
        if (!clientIP && socket.request?.socket?.remoteAddress) {
          clientIP = socket.request.socket.remoteAddress;
        }
        
        // Приоритет 5: Старые версии
        if (!clientIP && socket.request?.connection?.remoteAddress) {
          clientIP = socket.request.connection.remoteAddress;
        }
        
        // Обрабатываем IPv6 маппинг (::ffff:127.0.0.1 -> 127.0.0.1)
        if (clientIP && clientIP.startsWith('::ffff:')) {
          clientIP = clientIP.replace('::ffff:', '');
        }
      } catch (e) {
        // Игнорируем ошибки получения IP
        logger.debug(`[Socket.IO] Ошибка получения IP для socket ${socket.id}:`, e);
      }
      

      // Обновляем информацию об устройстве
      const deviceType = device_type || 'browser';
      const devicePlatform = platform || 'Unknown';
      const previousIP = devices[device_id].ipAddress;
      devices[device_id].deviceType = deviceType;
      devices[device_id].capabilities = capabilities || defaultCapabilities;
      devices[device_id].platform = devicePlatform;
      devices[device_id].ipAddress = clientIP || null;
      devices[device_id].lastSeen = new Date().toISOString();

      // Сохраняем ipAddress и platform в БД
      try {
        saveDevice(device_id, devices[device_id]);
      } catch (e) {
        logger.warn('[Socket.IO] Не удалось сохранить ipAddress/platform в БД', { deviceId: device_id, error: e.message });
      }
      
      // КРИТИЧНО: Отправляем обновление устройства если IP изменился или это первое подключение
      const ipChanged = previousIP !== devices[device_id].ipAddress;
      if (ipChanged || !previousIP) {
        io.emit('device/updated', {
          device_id,
          device: {
            device_id,
            deviceType,
            platform: devicePlatform,
            ipAddress: devices[device_id].ipAddress,
            capabilities: devices[device_id].capabilities,
            lastSeen: devices[device_id].lastSeen
          }
        });
      }
      
      // Проверяем было ли устройство подключено ранее
      const prevDevice = activeConnections.get(socket.id);
      
      if (prevDevice && prevDevice !== device_id) {
        // Отключаем от предыдущего устройства
        const prevSockets = deviceSockets.get(prevDevice);
        if (prevSockets) {
          prevSockets.delete(socket.id);
          if (prevSockets.size === 0) {
            deviceSockets.delete(prevDevice);
            io.emit('player/offline', { device_id: prevDevice });
          }
        }
      }
      
      // Проверяем повторную регистрацию того же устройства
      if (prevDevice === device_id) {
        const sockets = deviceSockets.get(device_id);
        if (sockets && sockets.has(socket.id)) {
          // Обновляем ping
          if (socket.data) socket.data.lastPing = Date.now();
          
          // КРИТИЧНО: Отправляем обновление устройства если IP изменился при повторной регистрации
          if (ipChanged || !previousIP) {
            io.emit('device/updated', {
              device_id,
              device: {
                device_id,
                deviceType,
                platform: devicePlatform,
                ipAddress: devices[device_id].ipAddress,
                capabilities: devices[device_id].capabilities,
                lastSeen: devices[device_id].lastSeen
              }
            });
          }
          
      // Сбрасываем состояние
      ensureCurrentState(device_id);
      
      // КРИТИЧНО: Проверяем существование файла перед отправкой состояния
      const currentState = devices[device_id].current;
      if (currentState && currentState.file && currentState.type !== 'idle') {
        // Проверяем, существует ли файл в списке файлов устройства
        const deviceFiles = devices[device_id].files || [];
        const deviceStreams = devices[device_id].streams || {};
        const currentFile = currentState.file;
        
        // Проверяем основной файл (включая стримы и папки)
        let fileExists = deviceFiles.includes(currentFile);
        
        // Для стримов также проверяем streams объект
        if (!fileExists && currentState.type === 'streaming') {
          fileExists = !!deviceStreams[currentFile];
        }
        
        // Для папок может быть .zip расширение
        if (!fileExists) {
          const withoutZip = currentFile.replace(/\.zip$/i, '');
          fileExists = deviceFiles.includes(withoutZip);
        }
        
        if (!fileExists) {
          // Файл не существует - сбрасываем состояние на idle
          logger.warn(`[Device] Файл ${currentFile} не найден для устройства ${device_id}, сбрасываем состояние`, {
            deviceId: device_id,
            currentFile,
            currentType: currentState.type,
            availableFiles: deviceFiles.slice(0, 5),
            availableStreams: Object.keys(deviceStreams).slice(0, 5)
          });
          devices[device_id].current = { type: 'idle', file: null, state: 'idle' };
          socket.emit('player/state', devices[device_id].current);
          socket.emit('player/registered', {
            device_id,
            current: devices[device_id].current,
            timestamp: Date.now(),
            repeatRegistration: true
          });
          return;
        }
      }
      
      socket.emit('player/state', devices[device_id].current);
      socket.emit('player/registered', {
        device_id,
        current: devices[device_id].current,
        timestamp: Date.now(),
        repeatRegistration: true
      });
      return;
        }
      }
      
      // Регистрируем новое подключение
      socket.join(`device:${device_id}`);
      socket.data.device_id = device_id;
      socket.data.lastPing = Date.now();
      activeConnections.set(socket.id, device_id);
      
      if (!deviceSockets.has(device_id)) {
        deviceSockets.set(device_id, new Set());
      }
      
      const wasOffline = deviceSockets.get(device_id).size === 0;
      deviceSockets.get(device_id).add(socket.id);
      
      if (wasOffline) {
        io.emit('player/online', { device_id });
      }
      
      // Сбрасываем состояние устройства только если его нет
      ensureCurrentState(device_id);
      
      // КРИТИЧНО: Проверяем существование файла перед отправкой состояния
      const currentState = devices[device_id].current;
      if (currentState && currentState.file && currentState.type !== 'idle') {
        // Проверяем, существует ли файл в списке файлов устройства
        const deviceFiles = devices[device_id].files || [];
        const deviceStreams = devices[device_id].streams || {};
        const currentFile = currentState.file;
        
        // Проверяем основной файл (включая стримы и папки)
        let fileExists = deviceFiles.includes(currentFile);
        
        // Для стримов также проверяем streams объект
        if (!fileExists && currentState.type === 'streaming') {
          fileExists = !!deviceStreams[currentFile];
        }
        
        // Для папок может быть .zip расширение
        if (!fileExists) {
          const withoutZip = currentFile.replace(/\.zip$/i, '');
          fileExists = deviceFiles.includes(withoutZip);
        }
        
        if (!fileExists) {
          // Файл не существует - сбрасываем состояние на idle
          logger.warn(`[Device] Файл ${currentFile} не найден для устройства ${device_id}, сбрасываем состояние`, {
            deviceId: device_id,
            currentFile,
            currentType: currentState.type,
            availableFiles: deviceFiles.slice(0, 5),
            availableStreams: Object.keys(deviceStreams).slice(0, 5)
          });
          devices[device_id].current = { type: 'idle', file: null, state: 'idle' };
        }
      }
      
      socket.emit('player/state', devices[device_id].current);
      
      // КРИТИЧНО: Отправляем подтверждение успешной регистрации
      socket.emit('player/registered', { 
        device_id, 
        current: devices[device_id].current,
        timestamp: Date.now()
      });
      
      if (typeof getVolumeState === 'function') {
        try {
          const volumeState = getVolumeState(device_id);
          socket.emit('player/volume', {
            level: volumeState.level,
            muted: volumeState.muted,
            reason: 'sync'
          });
        } catch (err) {
          logger.warn('[Device] Failed to sync volume state', { deviceId: device_id, error: err.message });
        }
      }
      
      logSocket('info', `Player registered: ${device_id}`, { 
        socketId: socket.id, 
        transport: socket.conn.transport.name,
        deviceType: deviceType,
        platform: devicePlatform 
      });
      recordSocketEvent('connect');
    } catch (e) {
      logSocket('error', `Error during device registration: ${e.message}`, { 
        socketId: socket.id, 
        deviceId: device_id,
        error: e.stack 
      });
      recordSocketEvent('error');
      socket.emit('player/reject', { reason: 'server_error' });
    }
  });
    
  // player/ping - Keep-alive пинг
  socket.on('player/ping', () => {
    if (socket.data.device_id) {
      const device_id = socket.data.device_id;
      
      // Обновляем lastSeen при каждом ping
      if (devices[device_id]) {
        devices[device_id].lastSeen = new Date().toISOString();
      }
      
      socket.emit('player/pong');
      if (socket.data) socket.data.lastPing = Date.now();
      logSocket('debug', `Ping from ${device_id}`, { socketId: socket.id });
    }
  });
  
  // player/progress - Прогресс воспроизведения (ретрансляция для панелей)
  socket.on('player/progress', async (payload) => {
    try {
      // Нормализуем device_id из сессии, если отсутствует в payload
      const device_id = payload?.device_id || socket.data?.device_id;
      if (!device_id) return;
      const currentTime = Number(payload?.currentTime) || 0;
      let duration = Number(payload?.duration) || 0;
      const rawType = typeof payload?.type === 'string' ? payload.type : 'video';
      const type = rawType.toLowerCase();
      const file = (typeof payload?.file === 'string' && payload.file) ? payload.file : null;
      const streamProtocol = typeof payload?.stream_protocol === 'string'
        ? payload.stream_protocol
        : (typeof payload?.streamProtocol === 'string' ? payload.streamProtocol : null);
      
      // Если длительность не пришла от клиента (0), пытаемся получить из БД
      if (duration === 0 && file) {
        try {
          const metadata = getFileMetadata(device_id, file);
          if (metadata && metadata.video_duration) {
            duration = Math.floor(metadata.video_duration); // Округляем до секунд
          }
        } catch (e) {
          // Игнорируем ошибки получения метаданных
        }
      }
      
      let stateChanged = false;
      const device = devices[device_id];
      const page = typeof payload?.page === 'number' ? payload.page : (type !== 'video' ? currentTime : undefined);
      
      if (device) {
        if (type === 'video' && file) {
          const prev = device.current || {};
          if (prev.type !== 'video' || prev.file !== file || prev.state !== 'playing') {
            device.current = { type: 'video', file, state: 'playing' };
            stateChanged = true;
          }
        } else if (type === 'audio' && file) {
          const prev = device.current || {};
          if (prev.type !== 'audio' || prev.file !== file || prev.state !== 'playing') {
            device.current = { type: 'audio', file, state: 'playing' };
            stateChanged = true;
          }
        } else if (type === 'streaming' && file) {
          // КРИТИЧНО: Обновляем состояние для стримов
          const prev = device.current || {};
          const nextProtocol = streamProtocol || prev.streamProtocol || null;
          if (
            prev.type !== 'streaming' ||
            prev.file !== file ||
            prev.state !== 'playing' ||
            prev.streamProtocol !== nextProtocol
          ) {
            device.current = { 
              type: 'streaming', 
              file, 
              state: 'playing',
              streamUrl: payload?.stream_url || prev.streamUrl,
              streamProtocol: nextProtocol
            };
            stateChanged = true;
          }
        } else if (type === 'image' && file) {
          // КРИТИЧНО: Обновляем состояние для изображений
          const prev = device.current || {};
          if (prev.type !== 'image' || prev.file !== file || prev.state !== 'playing') {
            device.current = { type: 'image', file, state: 'playing', page: 1 };
            stateChanged = true;
          }
        } else if (type === 'idle' || type === 'placeholder') {
          const prev = device.current || {};
          if (prev.type !== 'idle' || prev.state !== 'idle') {
            device.current = { type: 'idle', file: null, state: 'idle' };
            stateChanged = true;
          }
        } else if ((type === 'folder' || type === 'pdf' || type === 'pptx') && file && typeof page === 'number') {
          // КРИТИЧНО: Обновляем текущую страницу для папок/PDF/PPTX
          const prev = device.current || {};
          if (prev.type !== type || prev.file !== file || prev.page !== page) {
            if (!device.current) device.current = { type, file, state: 'playing', page };
            else {
              device.current.type = type;
              device.current.file = file;
              device.current.state = 'playing';
              device.current.page = page;
            }
            if (typeof duration === 'number' && duration > 0) {
              if (type === 'folder') {
                device.current.folderImageCount = duration;
              } else {
                device.current.totalSlides = duration;
              }
            }
            stateChanged = true;
          }
        }
      }
      
      // Отправляем всем слушателям (speaker UI) агрегированный прогресс
      io.emit('player/progress', {
        device_id,
        type,
        file,
        currentTime,
        duration,
        page,
        stream_protocol: streamProtocol || undefined
      });
      
      if (stateChanged) {
        io.emit('preview/refresh', { device_id });
      }
    } catch (e) {
      // swallow
    }
  });
  
  socket.on('player/volumeState', (payload = {}) => {
    if (typeof persistVolumeState !== 'function') {
      return;
    }
    const device_id = payload?.device_id || socket.data?.device_id;
    if (!device_id || !devices[device_id]) {
      return;
    }
    const levelValue = typeof payload.level === 'number'
      ? payload.level
      : (typeof payload.volume === 'number' ? payload.volume : undefined);
    const mutedValue = typeof payload.muted === 'boolean' ? payload.muted : undefined;
    if (typeof levelValue === 'undefined' && typeof mutedValue === 'undefined') {
      return;
    }
    
    try {
      persistVolumeState(
        device_id,
        { level: levelValue, muted: mutedValue },
        { source: 'device' }
      );
    } catch (err) {
      logger.warn('[Device] Failed to store volume state', { deviceId: device_id, error: err.message });
    }
  });

  // device/state - Обновление состояния устройства от плеера (текущая страница/слайд для папок/PDF/PPTX)
  socket.on('device/state', ({ device_id, type, file, page }) => {
    const device_id_from_socket = device_id || socket.data?.device_id;
    if (!device_id_from_socket || !devices[device_id_from_socket]) {
      return;
    }
    
    const d = devices[device_id_from_socket];
    if (!d.current) {
      return;
    }
    
    // Обновляем состояние только если это тот же тип контента и файл
    if (d.current.type === type && d.current.file === file && typeof page === 'number' && page >= 1) {
      d.current.page = page;
      // Отправляем обновление спикер панели
      io.emit('preview/refresh', { device_id: device_id_from_socket });
      logger.debug(`[Device] State updated: ${device_id_from_socket} -> ${type}/${file} page=${page}`, { 
        deviceId: device_id_from_socket, 
        type, 
        file, 
        page 
      });
    }
  });
  
  // Таймер неактивности для автоматического отключения
  socket.data.lastPing = Date.now();
  socket.data.inactivityTimeout = setInterval(() => {
    if (!socket.connected || !socket.data.device_id) {
      clearInterval(socket.data.inactivityTimeout);
      socket.data.inactivityTimeout = null;
      return;
    }
    
    const timeSinceLastPing = Date.now() - (socket.data.lastPing || 0);
    
    // Отключаем если нет активности 60 секунд
    if (timeSinceLastPing > 60000) {
      const did = socket.data.device_id;
      const sockets = deviceSockets.get(did);
      
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          deviceSockets.delete(did);
          io.emit('player/offline', { device_id: did });
        }
      }
      
      activeConnections.delete(socket.id);
      clearInterval(socket.data.inactivityTimeout);
      socket.data.inactivityTimeout = null;
      socket.disconnect(true);
    }
  }, 10000); // Проверяем каждые 10 секунд
}

/**
 * Обработчик отключения сокета
 * @param {Socket} socket - Socket.IO сокет
 * @param {Object} deps - Зависимости {io}
 */
export function handleDisconnect(socket, deps) {
  const { io } = deps;
  const activeConnections = getActiveConnections();
  const deviceSockets = getDeviceSockets();
  
  // disconnecting - сокет отключается (до полного разрыва)
  socket.on('disconnecting', () => {
    const did = socket.data?.device_id;
    
    if (socket.data.inactivityTimeout) {
      clearInterval(socket.data.inactivityTimeout);
      socket.data.inactivityTimeout = null;
    }
    
    if (!did) return;
    
    const sockets = deviceSockets.get(did);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        deviceSockets.delete(did);
        io.emit('player/offline', { device_id: did });
      }
    }
    
    activeConnections.delete(socket.id);
  });
  
  // disconnect - сокет полностью отключен
  socket.on('disconnect', (reason) => {
    try {
      // ИСПРАВЛЕНО: Очистка event listeners для предотвращения утечек памяти
      if (socket.conn) {
        socket.conn.removeAllListeners('upgrade');
        socket.conn.removeAllListeners('close');
      }
      
      if (socket.data.inactivityTimeout) {
        clearInterval(socket.data.inactivityTimeout);
        socket.data.inactivityTimeout = null;
      }
      
      const did = socket.data?.device_id;
      const trackedDeviceId = activeConnections.get(socket.id);

      if (did) {
        const sockets = deviceSockets.get(did);
        if (sockets) {
          sockets.delete(socket.id);
          if (sockets.size === 0) {
            deviceSockets.delete(did);
            io.emit('player/offline', { device_id: did });
            logSocket('info', `Device went offline: ${did}`, { socketId: socket.id, reason });
          }
        }
      }

      if (trackedDeviceId) {
        activeConnections.delete(socket.id);
        recordSocketEvent('disconnect');
      }
    } catch (e) {
      logSocket('error', `Error during disconnect: ${e.message}`, { 
        socketId: socket.id, 
        error: e.stack 
      });
    }
  });
}

