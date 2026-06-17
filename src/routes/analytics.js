import express from 'express';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createModuleLogger } from '../utils/logger.js';
import { getMetrics } from '../utils/metrics.js';
import { getDatabase, getDriverType } from '../database/database.js';
import { videoOptimizeQueue, streamQueue, converterQueue, queuesReady } from '../queue/queue.js';
import { Redis } from 'ioredis';

const logger = createModuleLogger('api');
const execAsync = promisify(exec);

export function createAnalyticsRouter() {
  const router = express.Router();

  router.get('/analytics', async (req, res) => {
    try {
      const start = Date.now();
      const [metricsData, dockerStats, redisInfo, pgInfo, queueInfo, systemInfo] = await Promise.all([
        Promise.resolve(getInAppMetrics()),
        getDockerStats(),
        getRedisInfo(),
        getPostgresInfo(),
        getQueueInfo(),
        Promise.resolve(getSystemMetrics())
      ]);

      res.json({
        inApp: metricsData,
        docker: dockerStats,
        redis: redisInfo,
        postgres: pgInfo,
        queues: queueInfo,
        system: systemInfo,
        collectTimeMs: Date.now() - start,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('[Analytics] Error:', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Failed to collect analytics' });
    }
  });

  return router;
}

function getInAppMetrics() {
  try {
    return getMetrics();
  } catch (e) {
    logger.error('[Analytics] Error getting in-app metrics:', e);
    return null;
  }
}

async function getDockerStats() {
  try {
    const { stdout } = await execAsync('docker stats --no-stream --format \'{{json .}}\' 2>/dev/null');
    const lines = stdout.trim().split('\n').filter(Boolean);
    const containers = lines.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    return {
      containers: containers.map(c => ({
        name: c.Name,
        id: c.ID?.substring(0, 12),
        cpuPercent: c.CPUPerc,
        memoryUsage: c.MemUsage,
        memoryPercent: c.MemPerc,
        netIO: c.NetIO,
        blockIO: c.BlockIO,
        pids: c.PIDs,
        status: c.Status
      })),
      total: containers.length,
      running: containers.filter(c => c.Status?.includes('Up')).length
    };
  } catch {
    return null;
  }
}

async function getRedisInfo() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;

  let redis;
  try {
    redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
    await redis.connect();
    const info = await redis.info();
    const infoAll = await redis.info('all');
    await redis.quit();

    const parsed = {};
    info.split('\n').forEach(line => {
      if (line && !line.startsWith('#') && line.includes(':')) {
        const [key, ...val] = line.split(':');
        parsed[key.trim()] = val.join(':').trim();
      }
    });

    const keyspaceHits = parseInt(parsed.keyspace_hits) || 0;
    const keyspaceMisses = parseInt(parsed.keyspace_misses) || 0;
    const totalOps = keyspaceHits + keyspaceMisses;

    return {
      version: parsed.redis_version,
      uptime: parseInt(parsed.uptime_in_seconds) || 0,
      connectedClients: parseInt(parsed.connected_clients) || 0,
      usedMemory: parseInt(parsed.used_memory) || 0,
      usedMemoryHuman: parsed.used_memory_human || '0B',
      totalConnections: parseInt(parsed.total_connections_received) || 0,
      totalCommands: parseInt(parsed.total_commands_processed) || 0,
      hitRate: totalOps > 0 ? ((keyspaceHits / totalOps) * 100).toFixed(2) + '%' : '0%',
      keyspaceHits,
      keyspaceMisses,
      role: parsed.role || 'unknown'
    };
  } catch (e) {
    logger.error('[Analytics] Error getting Redis info:', e.message);
    if (redis) { try { await redis.quit(); } catch {} }
    return null;
  }
}

async function getPostgresInfo() {
  try {
    if (getDriverType() !== 'postgres') return null;
    const db = getDatabase();
    const pool = db.pool;
    if (!pool) return null;

    const client = await pool.connect();
    try {
      const [versionRes, dbSizeRes, connectionsRes, statsRes] = await Promise.all([
        client.query('SELECT version()'),
        client.query('SELECT pg_database_size(current_database()) as size'),
        client.query(`SELECT count(*) as active FROM pg_stat_activity WHERE state = 'active'`),
        client.query(`SELECT numbackends, xact_commit, xact_rollback, blks_read, blks_hit
          FROM pg_stat_database WHERE datname = current_database()`)
      ]);

      const version = versionRes.rows[0]?.version || '';
      const pgVersion = version.split(' ')[1] || version.split(',')[0] || 'unknown';
      const row = statsRes.rows[0];
      const totalReads = (row?.blks_hit || 0) + (row?.blks_read || 0);

      return {
        version: pgVersion,
        databaseSize: parseInt(dbSizeRes.rows[0]?.size) || 0,
        activeConnections: parseInt(connectionsRes.rows[0]?.active) || 0,
        transactions: {
          commit: parseInt(row?.xact_commit) || 0,
          rollback: parseInt(row?.xact_rollback) || 0
        },
        cacheHitRatio: totalReads > 0
          ? ((row.blks_hit / totalReads) * 100).toFixed(2) + '%'
          : '0%',
        backends: parseInt(row?.numbackends) || 0
      };
    } finally {
      client.release();
    }
  } catch (e) {
    logger.error('[Analytics] Error getting PostgreSQL info:', e.message);
    return null;
  }
}

async function getQueueInfo() {
  if (!queuesReady) return null;

  const queues = {};
  const queueMap = { videoOptimize: videoOptimizeQueue, stream: streamQueue, converter: converterQueue };

  for (const [name, q] of Object.entries(queueMap)) {
    if (!q) continue;
    try {
      queues[name] = await q.getJobCounts();
    } catch (e) {
      logger.error(`[Analytics] Error getting queue ${name} info:`, e.message);
      queues[name] = null;
    }
  }

  return Object.keys(queues).length > 0 ? queues : null;
}

function getSystemMetrics() {
  try {
    const cpus = os.cpus();
    let totalIdle = 0, totalTick = 0;
    cpus.forEach(cpu => {
      for (const type in cpu.times) totalTick += cpu.times[type];
      totalIdle += cpu.times.idle;
    });
    const cpuCount = cpus.length;
    const usage = cpuCount > 0 ? Math.round(100 - (100 * totalIdle / totalTick)) : 0;
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    return {
      cpu: {
        count: cpuCount,
        model: cpus[0]?.model || 'unknown',
        usage,
        loadAverage: os.loadavg()
      },
      memory: {
        total: totalMem,
        free: freeMem,
        used: totalMem - freeMem,
        usagePercent: totalMem > 0 ? ((totalMem - freeMem) / totalMem * 100).toFixed(1) : '0',
        process: {
          rss: process.memoryUsage().rss,
          heapUsed: process.memoryUsage().heapUsed,
          heapTotal: process.memoryUsage().heapTotal
        }
      },
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptime: os.uptime(),
      nodeVersion: process.version
    };
  } catch (e) {
    logger.error('[Analytics] Error getting system metrics:', e);
    return null;
  }
}
