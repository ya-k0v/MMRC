import express from 'express';
import os from 'node:os';
import http from 'node:http';
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
      const [metricsData, dockerStats, redisInfo, pgInfo, queueInfo, systemInfo, nginxStats, replicaMetrics] = await Promise.all([
        Promise.resolve(getInAppMetrics()),
        getDockerStats(),
        getRedisInfo(),
        getPostgresInfo(),
        getQueueInfo(),
        Promise.resolve(getSystemMetrics()),
        getNginxUpstreamStats(),
        getReplicaMetrics()
      ]);

      const flowMap = buildFlowMap(dockerStats, nginxStats, replicaMetrics, redisInfo, pgInfo, queueInfo);

      res.json({
        inApp: metricsData,
        docker: dockerStats,
        redis: redisInfo,
        postgres: pgInfo,
        queues: queueInfo,
        system: systemInfo,
        nginx: nginxStats,
        replicaMetrics,
        flowMap,
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

async function getNginxUpstreamStats() {
  try {
    const log = await execAsync(
      'docker exec mmrc-nginx-ha cat /var/log/nginx/access.log 2>/dev/null || echo ""',
      { timeout: 5000 }
    );
    const lines = log.stdout.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    const upstreams = {};
    const statusCodes = {};
    let total = 0;

    for (const line of lines) {
      const upMatch = line.match(/upstream="([^"]+)"/);
      const statusMatch = line.match(/"\s+(\d{3})\s+/);
      if (upMatch) {
        const addr = upMatch[1];
        upstreams[addr] = (upstreams[addr] || 0) + 1;
      }
      if (statusMatch) {
        const code = statusMatch[1];
        statusCodes[code] = (statusCodes[code] || 0) + 1;
      }
      total++;
    }

    return {
      total,
      lines: lines.length,
      upstreams,
      statusCodes,
      lastEntry: lines[lines.length - 1] || null
    };
  } catch (e) {
    return null;
  }
}

async function getReplicaMetrics() {
  try {
    const { stdout } = await execAsync(
      'docker ps --filter name=mmrc-replica --format "{{.Names}}" 2>/dev/null'
    );
    const names = stdout.trim().split('\n').filter(Boolean);
    if (names.length === 0) return null;

    const results = {};
    for (const name of names) {
      try {
        const json = await httpGet(`http://${name}:80/internal/metrics`, 3000);
        if (json) results[name] = JSON.parse(json);
      } catch {
        // skip
      }
    }
    return Object.keys(results).length > 0 ? results : null;
  } catch {
    return null;
  }
}

function httpGet(url, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getRedisInfo() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;

  let redis;
  try {
    redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
    await redis.connect();
    const info = await redis.info();
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

function buildFlowMap(dockerStats, nginxStats, replicaMetrics, redisInfo, pgInfo, queueInfo) {
  const nodes = [];
  const edges = [];

  const replicaCounts = {};
  if (replicaMetrics) {
    for (const [name, m] of Object.entries(replicaMetrics)) {
      replicaCounts[name] = m.requests?.total || 0;
    }
  }

  const upstreamCounts = {};
  let nginxTotal = 0;
  if (nginxStats && nginxStats.upstreams) {
    for (const [addr, count] of Object.entries(nginxStats.upstreams)) {
      upstreamCounts[addr] = count;
      nginxTotal += count;
    }
  }

  const containers = dockerStats?.containers || [];
  const getContainer = (name) => containers.find(c =>
    c.name.includes(name) || name.includes(c.name)
  );

  nodes.push({
    id: 'browser',
    label: 'Браузеры / Устройства',
    type: 'source',
    requests: 0
  });

  const nginxC = getContainer('nginx-ha') || getContainer('nginx');
  nodes.push({
    id: 'nginx',
    label: 'NGINX LB',
    type: 'lb',
    requests: nginxTotal || undefined,
    cpu: nginxC?.cpuPercent,
    mem: nginxC?.memoryPercent,
    status: nginxC?.status
  });

  edges.push({
    from: 'browser',
    to: 'nginx',
    label: 'HTTP / WebSocket',
    requests: nginxTotal || undefined
  });

  const replicaNodes = [];
  let replicaIndex = 0;
  for (const c of containers) {
    if (c.name.includes('mmrc-replica') || c.name.includes('replica')) {
      const shortName = `replica-${++replicaIndex}`;
      const repName = c.name;
      const repMetrics = replicaMetrics ? replicaMetrics[repName] : null;
      replicaNodes.push({
        id: shortName,
        label: c.name.length > 30 ? c.name.substring(0, 28) + '…' : c.name,
        type: 'app',
        requests: repMetrics?.requests?.total || (upstreamCounts[Object.keys(upstreamCounts)[replicaIndex - 1]] || 0),
        socketConns: repMetrics?.socket?.activeConnections,
        cpu: c.cpuPercent,
        mem: c.memoryPercent,
        status: c.status
      });

      const upstreamReqs = Object.values(upstreamCounts)[replicaIndex - 1] || 0;
      edges.push({
        from: 'nginx',
        to: shortName,
        label: 'upstream',
        requests: upstreamReqs
      });
    }
  }
  nodes.push(...replicaNodes);

  if (replicaNodes.length > 0) {
    for (const rep of replicaNodes) {
      edges.push({
        from: rep.id,
        to: 'redis',
        label: 'Pub/Sub + Queue',
        meta: redisInfo ? `cmd: ${(redisInfo.totalCommands || 0).toLocaleString()}` : undefined
      });
      edges.push({
        from: rep.id,
        to: 'postgres',
        label: 'SQL',
        meta: pgInfo ? `q: ${(pgInfo.transactions?.commit || 0).toLocaleString()}` : undefined
      });
      edges.push({
        from: rep.id,
        to: 'minio',
        label: 'S3'
      });
      edges.push({
        from: rep.id,
        to: 'streamer',
        label: 'Bull Queue',
        meta: queueInfo ? Object.values(queueInfo).reduce((s, q) => s + (q?.active || 0) + (q?.waiting || 0), 0).toString() + ' jobs' : undefined
      });
    }
  }

  nodes.push({
    id: 'redis',
    label: 'Redis',
    type: 'service',
    commands: redisInfo?.totalCommands,
    clients: redisInfo?.connectedClients,
    memory: redisInfo?.usedMemoryHuman,
    version: redisInfo?.version
  });
  nodes.push({
    id: 'postgres',
    label: 'PostgreSQL',
    type: 'service',
    version: pgInfo?.version,
    size: pgInfo?.databaseSize,
    connections: pgInfo?.activeConnections
  });
  nodes.push({
    id: 'minio',
    label: 'MinIO',
    type: 'service'
  });
  nodes.push({
    id: 'streamer',
    label: 'Streamer (FFmpeg)',
    type: 'service',
    active: queueInfo ? Object.values(queueInfo).reduce((s, q) => s + (q?.active || 0), 0) : 0
  });

  return { nodes, edges };
}
