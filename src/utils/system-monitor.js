/**
 * Модуль мониторинга системы и отправки уведомлений
 * @module utils/system-monitor
 */

import logger from './logger.js';
import { 
  notifyDiskUsageHigh, 
  notifyDbError,
  notifyFfmpegProcessHung,
  notifyStreamStartFailed,
  notifyMemoryUsageHigh
} from './notifications.js';
import { getSettings } from '../config/settings-manager.js';
import { getDatabase } from '../database/database.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { timerRegistry } from './timer-registry.js';

const execFileAsync = promisify(execFile);

class SystemMonitor {
  constructor(streamManager, devices) {
    this.streamManager = streamManager;
    this.devices = devices;
    this.lastDiskCheck = {};
    this.lastMemoryCheck = {};
    this.lastFfmpegCheck = {};
    this.monitoringInterval = null;
  }

  /**
   * Запустить мониторинг системы
   */
  start() {
    // Проверяем каждые 5 минут
    const CHECK_INTERVAL = 5 * 60 * 1000;
    
    // Первая проверка через 30 секунд после запуска
    timerRegistry.setTimeout(() => {
      this.checkAll();
    }, 30000, 'SystemMonitor initial check');
    
    // Потом каждые 5 минут
    this.monitoringInterval = timerRegistry.setInterval(() => {
      this.checkAll();
    }, CHECK_INTERVAL, 'SystemMonitor periodic check');
    
    logger.info('[SystemMonitor] Monitoring started', {
      interval: CHECK_INTERVAL
    });
  }

  /**
   * Остановить мониторинг
   */
  stop() {
    if (this.monitoringInterval) {
      timerRegistry.clear(this.monitoringInterval);
      this.monitoringInterval = null;
      logger.info('[SystemMonitor] Monitoring stopped');
    }
  }

  /**
   * Выполнить все проверки
   */
  async checkAll() {
    try {
      await Promise.all([
        this.checkDiskUsage(),
        this.checkDatabase(),
        this.checkFfmpegProcesses(),
        this.checkMemoryUsage()
      ]);
    } catch (error) {
      logger.error('[SystemMonitor] Error during system checks', {
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Проверить использование диска
   */
  async checkDiskUsage() {
    try {
      const settings = getSettings();
      const contentRoot = settings?.runtime?.contentRoot || settings?.contentRoot || '/';
      
      // Получаем информацию о диске
      let usagePercent = 0;
      
      if (process.platform !== 'win32') {
        let contentPath = path.resolve(contentRoot);
        if (!fs.existsSync(contentPath)) {
          contentPath = path.dirname(contentPath);
          if (!fs.existsSync(contentPath)) {
            contentPath = '/';
          }
        }
        
        const { stdout } = await execFileAsync('df', ['-k', contentPath]);
        const line = stdout
          .split(/\r?\n/)
          .slice(1)
          .map((item) => item.trim())
          .find((item) => item.length > 0) || '';
        if (line) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5) {
            const usagePercentStr = parts[4].replace('%', '');
            usagePercent = parseInt(usagePercentStr) || 0;
          }
        }
      }
      
      // Проверяем пороги
      const lastNotification = this.lastDiskCheck[contentRoot];
      const now = Date.now();
      
      // Не отправляем уведомления слишком часто (минимум раз в час)
      const shouldNotify = !lastNotification || (now - lastNotification) > 60 * 60 * 1000;
      
      if (usagePercent >= 85 && shouldNotify) {
        this.lastDiskCheck[contentRoot] = now;
        
        notifyDiskUsageHigh(usagePercent, {
          contentRoot,
          available: usagePercent < 100 ? `${100 - usagePercent}%` : '0%'
        });
        
        logger.warn('[SystemMonitor] High disk usage detected', {
          usagePercent,
          contentRoot
        });
      }
    } catch (error) {
      logger.error('[SystemMonitor] Error checking disk usage', {
        error: error.message
      });
    }
  }

  /**
   * Проверить состояние базы данных
   */
  async checkDatabase() {
    try {
      const db = getDatabase();
      if (!db) {
        notifyDbError({
          error: 'Database instance is null',
          recommendation: 'Перезапустите сервис'
        });
        return;
      }
      
      // Простая проверка - выполняем простой запрос
      try {
        db.prepare('SELECT 1').get();
      } catch (error) {
        // Если БД заблокирована - это нормально, не отправляем уведомление
        if (error.message?.includes('locked') || error.message?.includes('busy')) {
          return;
        }
        
        // Другие ошибки - критично
        notifyDbError({
          error: error.message,
          errorCode: error.code,
          recommendation: 'Проверьте целостность базы данных'
        });
        
        logger.error('[SystemMonitor] Database check failed', {
          error: error.message,
          errorCode: error.code
        });
      }
    } catch (error) {
      logger.error('[SystemMonitor] Error checking database', {
        error: error.message
      });
    }
  }

  /**
   * Проверить зависшие FFmpeg процессы
   * Уведомления отправляются ТОЛЬКО если процесс мертв И нет свежих файлов
   * Если процесс жив ИЛИ создаются свежие файлы - стрим работает нормально
   */
  async checkFfmpegProcesses() {
    if (!this.streamManager || !this.streamManager.jobs) {
      return;
    }
    
    try {
      const now = Date.now();
      
      for (const [safeName, job] of this.streamManager.jobs.entries()) {
        if (!job || job.status !== 'running' || !job.process) {
          continue;
        }
        
        // Проверяем, жив ли процесс
        const isProcessAlive = !job.process.killed && 
                              this.streamManager._checkProcessAlive(job.process);
        
        // Проверяем наличие свежих файлов (сегментов или плейлиста)
        let hasFreshActivity = false;
        
        try {
          // Получаем пути к файлам стрима
          const paths = this.streamManager._getPaths(safeName);
          const folderPath = paths.folderPath;
          const playlistPath = paths.playlistPath;
          
          // Проверка 1: Плейлист обновлялся недавно (менее 30 секунд)
          if (fs.existsSync(playlistPath)) {
            const playlistStats = fs.statSync(playlistPath);
            const playlistAge = now - playlistStats.mtimeMs;
            if (playlistAge < 30 * 1000) { // 30 секунд
              hasFreshActivity = true;
            }
          }
          
          // Проверка 2: Есть свежие .ts сегменты (моложе 2 минут)
          if (!hasFreshActivity && fs.existsSync(folderPath)) {
            const files = fs.readdirSync(folderPath);
            const tsFiles = files.filter(f => f.endsWith('.ts'));
            
            for (const tsFile of tsFiles) {
              const tsPath = path.join(folderPath, tsFile);
              try {
                const tsStats = fs.statSync(tsPath);
                const tsAge = now - tsStats.mtimeMs;
                
                // Если есть сегмент, созданный менее 2 минут назад - стрим активен
                if (tsAge < 2 * 60 * 1000) { // 2 минуты
                  hasFreshActivity = true;
                  break;
                }
              } catch (err) {
                // Игнорируем ошибки чтения отдельных файлов
                continue;
              }
            }
          }
        } catch (err) {
          // Если не удалось проверить файлы - считаем, что активности нет
          logger.debug('[SystemMonitor] Error checking stream files', {
            safeName,
            error: err.message
          });
        }
        
        // Если процесс жив ИЛИ есть свежая активность - все в порядке
        if (isProcessAlive || hasFreshActivity) {
          continue; // Стрим работает нормально
        }
        
        // Процесс мертв И нет свежих файлов - это реальная проблема
        const lastNotification = this.lastFfmpegCheck[safeName];
        const shouldNotify = !lastNotification || (now - lastNotification) > 60 * 60 * 1000; // Раз в час
        
        if (shouldNotify) {
          this.lastFfmpegCheck[safeName] = now;
          
          notifyFfmpegProcessHung(job.deviceId, job.safeName, {
            timeSinceActivity: job.process.killed ? 'process_killed' : 'process_dead',
            streamUrl: job.sourceUrl,
            processPid: job.process.pid,
            reason: job.process.killed 
              ? 'Процесс был завершен и нет свежих файлов' 
              : 'Процесс завершился и нет свежих файлов'
          });
          
          logger.warn('[SystemMonitor] Dead FFmpeg process with no fresh activity', {
            deviceId: job.deviceId,
            safeName: job.safeName,
            killed: job.process.killed,
            pid: job.process.pid,
            isProcessAlive,
            hasFreshActivity
          });
        }
      }
    } catch (error) {
      logger.error('[SystemMonitor] Error checking FFmpeg processes', {
        error: error.message
      });
    }
  }

  /**
   * Проверить использование памяти
   */
  async checkMemoryUsage() {
    try {
      const usage = process.memoryUsage();
      const totalMemory = os.totalmem();
      const usedMemory = usage.heapUsed + (usage.external || 0);
      const usagePercent = (usedMemory / totalMemory) * 100;
      
      const lastNotification = this.lastMemoryCheck.usagePercent || 0;
      const now = Date.now();
      const lastNotificationTime = this.lastMemoryCheck.timestamp || 0;
      
      // Уведомляем только если использование > 80% и не уведомляли в последний час
      if (usagePercent > 80 && (usagePercent - lastNotification > 5 || (now - lastNotificationTime) > 60 * 60 * 1000)) {
        this.lastMemoryCheck.usagePercent = usagePercent;
        this.lastMemoryCheck.timestamp = now;
        
        notifyMemoryUsageHigh(usagePercent, {
          heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
          heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
          external: Math.round((usage.external || 0) / 1024 / 1024),
          totalMemory: Math.round(totalMemory / 1024 / 1024),
          unit: 'MB'
        });
        
        logger.warn('[SystemMonitor] High memory usage detected', {
          usagePercent: usagePercent.toFixed(1),
          heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024)
        });
      }
    } catch (error) {
      logger.error('[SystemMonitor] Error checking memory usage', {
        error: error.message
      });
    }
  }
}

let systemMonitorInstance = null;

/**
 * Инициализировать системный мониторинг
 */
export function initSystemMonitor(streamManager, devices) {
  if (systemMonitorInstance) {
    systemMonitorInstance.stop();
  }
  
  systemMonitorInstance = new SystemMonitor(streamManager, devices);
  systemMonitorInstance.start();
  
  return systemMonitorInstance;
}

/**
 * Остановить системный мониторинг
 */
export function stopSystemMonitor() {
  if (systemMonitorInstance) {
    systemMonitorInstance.stop();
    systemMonitorInstance = null;
  }
}

