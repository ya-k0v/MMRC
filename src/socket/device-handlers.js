/**
 * Обработчики устройств (player/register, player/ping)
 * @module socket/device-handlers
 */

import { getActiveConnections, getDeviceSockets } from './connection-manager.js';
import { getFileMetadata } from '../database/files-metadata.js';
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
      
      // Обновляем информацию об устройстве
      const deviceType = device_type || 'browser';
      const devicePlatform = platform || 'Unknown';
      devices[device_id].deviceType = deviceType;
      devices[device_id].capabilities = capabilities || defaultCapabilities;
      devices[device_id].platform = devicePlatform;
      devices[device_id].lastSeen = new Date().toISOString();
      
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
          
          // Сбрасываем состояние
          ensureCurrentState(device_id);
          socket.emit('player/state', devices[device_id].current);
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
      socket.emit('player/state', devices[device_id].current);
      
      // КРИТИЧНО: Отправляем подтверждение успешной регистрации
      socket.emit('player/registered', { 
        device_id, 
        current: devices[device_id].current,
        timestamp: Date.now()
      });
      
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
      socket.emit('player/pong');
      if (socket.data) socket.data.lastPing = Date.now();
      logSocket('debug', `Ping from ${socket.data.device_id}`, { socketId: socket.id });
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
      const file = payload?.file || null;
      
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
      
      // Отправляем всем слушателям (speaker UI) агрегированный прогресс
      io.emit('player/progress', { device_id, type: 'video', file, currentTime, duration });
    } catch (e) {
      // swallow
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
    
    // Отключаем если нет активности 30 секунд
    if (timeSinceLastPing > 30000) {
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
      
      if (did && activeConnections.get(socket.id) === did) {
        const sockets = deviceSockets.get(did);
        if (sockets) {
          sockets.delete(socket.id);
          if (sockets.size === 0) {
            deviceSockets.delete(did);
            io.emit('player/offline', { device_id: did });
            logSocket('info', `Device went offline: ${did}`, { socketId: socket.id, reason });
          }
        }
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

