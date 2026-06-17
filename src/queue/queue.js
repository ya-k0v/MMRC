import Bull from 'bull';
import { createModuleLogger } from '../utils/logger.js';
const logger = createModuleLogger('queue');

const REDIS_URL = process.env.REDIS_URL || '';
const QUEUE_RETRY_DELAY = 2000;
const QUEUE_MAX_RETRIES = 15;

function createQueue(name, retries = 0) {
  if (!REDIS_URL) return null;

  const queue = new Bull(name, REDIS_URL, {
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 50
    },
    redis: {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 10000)
    }
  });

  queue.on('completed', job => {
    logger.info(`[Queue/${name}] Job ${job.id} completed`);
  });
  queue.on('failed', (job, err) => {
    logger.error(`[Queue/${name}] Job ${job.id} failed`, { error: err.message });
  });
  queue.on('error', err => {
    logger.warn(`[Queue/${name}] Error${retries < QUEUE_MAX_RETRIES ? ' (retrying)' : ''}`, { error: err.message, retries });
    if (retries >= QUEUE_MAX_RETRIES) {
      logger.error(`[Queue/${name}] Max retries reached, giving up`, { error: err.message });
    }
  });

  queue.on('ready', () => {
    logger.info(`[Queue/${name}] Connected to Redis`);
  });

  return queue;
}

export const videoOptimizeQueue = createQueue('video-optimize');
export const streamQueue = createQueue('stream');
export const converterQueue = createQueue('converter');

export const queuesReady = !!REDIS_URL;
