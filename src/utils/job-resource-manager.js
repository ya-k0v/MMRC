/**
 * Ограничение ресурсов для фоновых задач (ffmpeg/yt-dlp/стрим-воркеры)
 * @module utils/job-resource-manager
 */

import os from 'os';
import logger from './logger.js';

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

class JobResourceManager {
  constructor() {
    const reserveCpu = toPositiveInt(process.env.JOB_RESERVE_CPU_PERCENT, 10);
    const reserveMemory = toPositiveInt(process.env.JOB_RESERVE_MEMORY_MB, 200);
    const maxSingleJobPercent = toPositiveInt(process.env.JOB_MAX_SINGLE_JOB_PERCENT, 70);

    this.reserveCpuPercent = clamp(reserveCpu, 1, 90);
    this.reserveMemoryMb = Math.max(64, reserveMemory);
    this.maxSingleJobPercent = clamp(maxSingleJobPercent, 10, 100);

    this.totalCpuUnits = Math.max(1, (os.cpus() || []).length);
    this.cpuBudgetUnits = Math.max(
      1,
      Math.floor(this.totalCpuUnits * ((100 - this.reserveCpuPercent) / 100))
    );

    const totalMemoryMb = Math.floor(os.totalmem() / 1024 / 1024);
    this.memoryBudgetMb = Math.max(256, totalMemoryMb - this.reserveMemoryMb);
    this.maxSingleJobCpuUnits = Math.max(
      1,
      Math.floor(this.cpuBudgetUnits * (this.maxSingleJobPercent / 100))
    );
    this.maxSingleJobMemoryMb = Math.max(
      64,
      Math.floor(this.memoryBudgetMb * (this.maxSingleJobPercent / 100))
    );

    this.activeReservations = new Map(); // Map<id, reservation>
    this.waitQueue = [];

    logger.info('[JobResource] Resource manager initialized', {
      totalCpuUnits: this.totalCpuUnits,
      cpuBudgetUnits: this.cpuBudgetUnits,
      reserveCpuPercent: this.reserveCpuPercent,
      memoryBudgetMb: this.memoryBudgetMb,
      reserveMemoryMb: this.reserveMemoryMb,
      maxSingleJobPercent: this.maxSingleJobPercent,
      maxSingleJobCpuUnits: this.maxSingleJobCpuUnits,
      maxSingleJobMemoryMb: this.maxSingleJobMemoryMb
    });
  }

  _usage() {
    let cpuUsed = 0;
    let memoryUsed = 0;

    for (const reservation of this.activeReservations.values()) {
      cpuUsed += reservation.cpuUnits;
      memoryUsed += reservation.memoryMb;
    }

    return {
      cpuUsed,
      memoryUsed
    };
  }

  _canAcquire(request) {
    const usage = this._usage();
    return (
      usage.cpuUsed + request.cpuUnits <= this.cpuBudgetUnits &&
      usage.memoryUsed + request.memoryMb <= this.memoryBudgetMb
    );
  }

  _sortQueue() {
    this.waitQueue.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.queuedAt - b.queuedAt;
    });
  }

  _drainQueue() {
    if (this.waitQueue.length === 0) return;

    this._sortQueue();

    let changed = true;
    while (changed && this.waitQueue.length > 0) {
      changed = false;
      for (let i = 0; i < this.waitQueue.length; i += 1) {
        const pending = this.waitQueue[i];
        if (!this._canAcquire(pending)) continue;

        this.waitQueue.splice(i, 1);
        if (pending.timeoutTimer) {
          clearTimeout(pending.timeoutTimer);
          pending.timeoutTimer = null;
        }

        this._activateReservation(pending);
        changed = true;
        break;
      }
    }
  }

  _activateReservation(request) {
    const startedAt = Date.now();

    const reservation = {
      id: request.id,
      jobType: request.jobType,
      cpuUnits: request.cpuUnits,
      memoryMb: request.memoryMb,
      priority: request.priority,
      meta: request.meta,
      startedAt
    };

    this.activeReservations.set(request.id, reservation);

    request.resolve({
      id: request.id,
      jobType: request.jobType,
      release: () => this.release(request.id)
    });

    const usage = this._usage();
    logger.info('[JobResource] Reservation acquired', {
      id: request.id,
      jobType: request.jobType,
      cpuUnits: request.cpuUnits,
      memoryMb: request.memoryMb,
      cpuUsed: usage.cpuUsed,
      memoryUsed: usage.memoryUsed,
      queueLength: this.waitQueue.length
    });
  }

  async acquire({
    id,
    jobType = 'generic',
    cpuUnits = 1,
    memoryMb = 256,
    priority = 0,
    timeoutMs = 120000,
    meta = {}
  } = {}) {
    const requestId = String(id || `${jobType}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`);
    const requestedCpuUnits = Math.max(1, Number(cpuUnits) || 1);
    const requestedMemoryMb = Math.max(32, Number(memoryMb) || 32);
    const normalizedCpuUnits = Math.min(requestedCpuUnits, this.maxSingleJobCpuUnits);
    const normalizedMemoryMb = Math.min(requestedMemoryMb, this.maxSingleJobMemoryMb);

    if (requestedCpuUnits !== normalizedCpuUnits || requestedMemoryMb !== normalizedMemoryMb) {
      logger.warn('[JobResource] Request exceeded per-job cap, clamped', {
        id: requestId,
        jobType,
        requestedCpuUnits,
        requestedMemoryMb,
        normalizedCpuUnits,
        normalizedMemoryMb,
        maxSingleJobPercent: this.maxSingleJobPercent
      });
    }

    const request = {
      id: requestId,
      jobType,
      cpuUnits: normalizedCpuUnits,
      memoryMb: normalizedMemoryMb,
      priority: Number(priority) || 0,
      timeoutMs: Number(timeoutMs) || 0,
      meta,
      queuedAt: Date.now(),
      resolve: null,
      reject: null,
      timeoutTimer: null
    };

    return await new Promise((resolve, reject) => {
      request.resolve = resolve;
      request.reject = reject;

      if (this._canAcquire(request)) {
        this._activateReservation(request);
        return;
      }

      if (request.timeoutMs > 0) {
        request.timeoutTimer = setTimeout(() => {
          const idx = this.waitQueue.findIndex((entry) => entry.id === request.id);
          if (idx >= 0) {
            this.waitQueue.splice(idx, 1);
          }
          reject(new Error('Resource acquisition timeout'));
        }, request.timeoutMs);

        if (typeof request.timeoutTimer.unref === 'function') {
          request.timeoutTimer.unref();
        }
      }

      this.waitQueue.push(request);
      this._sortQueue();

      const usage = this._usage();
      logger.warn('[JobResource] Reservation queued (insufficient resources)', {
        id: request.id,
        jobType: request.jobType,
        cpuUnits: request.cpuUnits,
        memoryMb: request.memoryMb,
        cpuUsed: usage.cpuUsed,
        memoryUsed: usage.memoryUsed,
        cpuBudgetUnits: this.cpuBudgetUnits,
        memoryBudgetMb: this.memoryBudgetMb,
        queueLength: this.waitQueue.length
      });
    });
  }

  cancel(id, reason = 'Reservation cancelled') {
    const key = String(id || '');
    if (!key) {
      return {
        cancelledQueued: false,
        releasedActive: false
      };
    }

    let cancelledQueued = false;
    const queueIndex = this.waitQueue.findIndex((entry) => entry.id === key);
    if (queueIndex >= 0) {
      const [pending] = this.waitQueue.splice(queueIndex, 1);
      if (pending?.timeoutTimer) {
        clearTimeout(pending.timeoutTimer);
      }
      if (pending?.reject) {
        pending.reject(new Error(reason));
      }
      cancelledQueued = true;

      logger.info('[JobResource] Queued reservation cancelled', {
        id: key,
        jobType: pending?.jobType || null,
        reason,
        queueLength: this.waitQueue.length
      });
    }

    const releasedActive = this.release(key);

    return {
      cancelledQueued,
      releasedActive
    };
  }

  release(id) {
    const key = String(id || '');
    if (!key) return false;

    const existing = this.activeReservations.get(key);
    if (!existing) {
      return false;
    }

    this.activeReservations.delete(key);
    this._drainQueue();

    const usage = this._usage();
    logger.info('[JobResource] Reservation released', {
      id: key,
      jobType: existing.jobType,
      cpuUsed: usage.cpuUsed,
      memoryUsed: usage.memoryUsed,
      queueLength: this.waitQueue.length
    });

    return true;
  }

  getStatus() {
    const usage = this._usage();
    return {
      reserveCpuPercent: this.reserveCpuPercent,
      reserveMemoryMb: this.reserveMemoryMb,
      totalCpuUnits: this.totalCpuUnits,
      cpuBudgetUnits: this.cpuBudgetUnits,
      memoryBudgetMb: this.memoryBudgetMb,
      maxSingleJobPercent: this.maxSingleJobPercent,
      maxSingleJobCpuUnits: this.maxSingleJobCpuUnits,
      maxSingleJobMemoryMb: this.maxSingleJobMemoryMb,
      cpuUsed: usage.cpuUsed,
      memoryUsed: usage.memoryUsed,
      cpuAvailable: Math.max(0, this.cpuBudgetUnits - usage.cpuUsed),
      memoryAvailable: Math.max(0, this.memoryBudgetMb - usage.memoryUsed),
      activeJobs: this.activeReservations.size,
      queuedJobs: this.waitQueue.length
    };
  }
}

export const jobResourceManager = new JobResourceManager();
