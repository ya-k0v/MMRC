import Bull from 'bull';
import { createModuleLogger } from '../utils/logger.js';
const logger = createModuleLogger('queue');

const REDIS_URL = process.env.REDIS_URL || '';

function createQueue(name) {
  if (!REDIS_URL) return null;

  const queue = new Bull(name, REDIS_URL, {
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 50
    }
  });

  queue.on('completed', job => {
    logger.info(`[Queue/${name}] Job ${job.id} completed`);
  });
  queue.on('failed', (job, err) => {
    logger.error(`[Queue/${name}] Job ${job.id} failed`, { error: err.message });
  });
  queue.on('error', err => {
    logger.error(`[Queue/${name}] Error`, { error: err.message });
  });

  return queue;
}

export const videoOptimizeQueue = createQueue('video-optimize');
export const streamQueue = createQueue('stream');
export const converterQueue = createQueue('converter');

export const queuesReady = !!REDIS_URL;
