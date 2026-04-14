/**
 * System Information API
 * Предоставляет информацию о состоянии сервера
 */
import express from 'express';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';
import logger from '../utils/logger.js';
import { getSettings } from '../config/settings-manager.js';

const execFileAsync = promisify(execFile);

export function createSystemInfoRouter() {
  const router = express.Router();

  /**
   * GET /api/system/info - Получить информацию о системе
   */
  router.get('/info', async (req, res) => {
    try {
      const systemInfo = await getSystemInfo();
      res.json(systemInfo);
    } catch (error) {
      logger.error('Error getting system info', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Не удалось получить системную информацию' });
    }
  });

  return router;
}

/**
 * Получить информацию о CPU
 */
function getCPUInfo() {
  const cpus = os.cpus();
  const cpuCount = cpus.length;
  
  // Вычисляем загрузку CPU
  let totalIdle = 0;
  let totalTick = 0;
  
  cpus.forEach(cpu => {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });

  const idle = totalIdle / cpuCount;
  const total = totalTick / cpuCount;
  const usage = 100 - ~~(100 * idle / total);

  return {
    count: cpuCount,
    model: cpus[0].model,
    speed: cpus[0].speed,
    usage: usage,
    loadAverage: os.loadavg()
  };
}

/**
 * Получить информацию о памяти
 */
function getMemoryInfo() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const usagePercent = (usedMemory / totalMemory) * 100;

  // Информация о процессе Node.js
  const processMemory = process.memoryUsage();

  return {
    total: totalMemory,
    free: freeMemory,
    used: usedMemory,
    usagePercent: usagePercent.toFixed(2),
    totalFormatted: formatBytes(totalMemory),
    freeFormatted: formatBytes(freeMemory),
    usedFormatted: formatBytes(usedMemory),
    process: {
      rss: processMemory.rss,
      heapTotal: processMemory.heapTotal,
      heapUsed: processMemory.heapUsed,
      external: processMemory.external,
      rssFormatted: formatBytes(processMemory.rss),
      heapUsedFormatted: formatBytes(processMemory.heapUsed)
    }
  };
}

/**
 * Получить информацию о диске контента
 * Возвращает информацию только о том диске, где хранится контент (из настроек)
 */
async function getDiskInfo() {
  try {
    // Получаем путь к контент-диску из настроек
    const settings = getSettings();
    const contentRoot = settings.runtime?.contentRoot || settings.contentRoot || '/';
    
    // Для Linux/Mac
    if (process.platform !== 'win32') {
      // Получаем информацию о диске, где находится путь к контенту
      // df -k показывает информацию о файловой системе, в которой находится указанный путь
      let contentPath = path.resolve(contentRoot);
      
      // Убеждаемся что путь существует
      if (!fs.existsSync(contentPath)) {
        // Если путь не существует, используем родительский каталог
        contentPath = path.dirname(contentPath);
        if (!fs.existsSync(contentPath)) {
          contentPath = '/';
        }
      }
      
      // Получаем информацию о диске для этого пути
        const { stdout } = await execFileAsync('df', ['-k', contentPath]);
        const line = stdout
          .split(/\r?\n/)
          .slice(1)
          .map((item) => item.trim())
          .find((item) => item.length > 0) || '';
      
      if (!line) {
        throw new Error('Не удалось получить информацию о диске');
      }
      
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) {
        throw new Error('Неверный формат вывода df');
      }
      
      const filesystem = parts[0];
      const total = parseInt(parts[1]) * 1024; // KB to bytes
      const used = parseInt(parts[2]) * 1024;
      const available = parseInt(parts[3]) * 1024;
      const usagePercentStr = parts[4].replace('%', '');
      const usagePercent = parseInt(usagePercentStr) || 0;
      // Точка монтирования - это последний элемент (может содержать пробелы)
      const mountPoint = parts.slice(5).join(' ') || parts[parts.length - 1];
      
      const diskInfo = {
        total,
        used,
        available,
        usagePercent,
        totalFormatted: formatBytes(total),
        usedFormatted: formatBytes(used),
        availableFormatted: formatBytes(available),
        filesystem,
        mountPoint,
        contentPath: contentRoot
      };
      
      // Возвращаем один диск (контентный) в массиве для совместимости с фронтендом
      return {
        ...diskInfo,
        disks: [diskInfo]
      };
    } else {
      // Для Windows - определяем диск из пути
      const driveLetter = path.parse(contentRoot).root.replace('\\', '').replace('/', '');
      
      if (!driveLetter) {
        throw new Error('Не удалось определить диск из пути');
      }
      
      // Получаем информацию о логическом диске
        const { stdout } = await execFileAsync('wmic', [
          'logicaldisk',
          'where',
          `caption='${driveLetter}'`,
          'get',
          'size,freespace,caption',
          '/format:value'
        ]);
      const lines = stdout.trim().split('\n').filter(line => line.trim());
      
      let total = 0;
      let available = 0;
      
      for (const line of lines) {
        const [key, value] = line.split('=');
        if (key === 'Size') total = parseInt(value) || 0;
        if (key === 'FreeSpace') available = parseInt(value) || 0;
      }
      
      if (total === 0) {
        throw new Error('Диск не найден или недоступен');
      }
      
      const used = total - available;
      const usagePercent = parseFloat(((used / total) * 100).toFixed(2));

      const diskInfo = {
        total,
        used,
        available,
        usagePercent,
        totalFormatted: formatBytes(total),
        usedFormatted: formatBytes(used),
        availableFormatted: formatBytes(available),
        drive: driveLetter,
        contentPath: contentRoot
      };
      
      // Возвращаем один диск (контентный) в массиве для совместимости с фронтендом
      return {
        ...diskInfo,
        disks: [diskInfo]
      };
    }
  } catch (error) {
    logger.error('Error getting disk info', { error: error.message, stack: error.stack });
    return {
      total: 0,
      used: 0,
      available: 0,
      usagePercent: 0,
      disks: [],
      error: 'Failed to get disk info'
    };
  }
}

/**
 * Получить информацию о системе
 */
async function getSystemInfo() {
  const cpu = getCPUInfo();
  const memory = getMemoryInfo();
  const disk = await getDiskInfo();

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptime: os.uptime(),
    uptimeFormatted: formatUptime(os.uptime()),
    nodeVersion: process.version,
    processUptime: process.uptime(),
    processUptimeFormatted: formatUptime(process.uptime()),
    cpu,
    memory,
    disk,
    timestamp: new Date().toISOString()
  };
}

/**
 * Форматировать байты в читаемый вид
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

/**
 * Форматировать uptime
 */
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (days > 0) parts.push(`${days}д`);
  if (hours > 0) parts.push(`${hours}ч`);
  if (minutes > 0) parts.push(`${minutes}м`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}с`);

  return parts.join(' ');
}

export default createSystemInfoRouter;

