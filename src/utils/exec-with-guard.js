import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withRetry } from './retry.js';
import { circuitBreakers } from './circuit-breaker.js';
import { createModuleLogger } from './logger.js';

const execFileAsync = promisify(execFile);
const logger = createModuleLogger('exec-guard');

export async function execWithGuard(breakerName, command, args, options = {}) {
  const {
    timeout = 30000,
    maxRetries = 4,
    baseDelay = 1000,
    ...execOptions
  } = options;

  const breaker = circuitBreakers[breakerName];
  if (!breaker) {
    throw new Error(`Unknown circuit breaker: ${breakerName}`);
  }

  return breaker.execute(async () => {
    return withRetry(async () => {
      return execFileAsync(command, args, { timeout, ...execOptions });
    }, {
      maxRetries,
      delay: baseDelay,
      shouldRetry: (err) => {
        if (err.code === 'ETIMEDOUT' || err.message?.includes('timed out')) {
          logger.warn(`[Guard/${breakerName}] Timeout, will retry`, { command, timeout });
          return true;
        }
        return false;
      },
      onRetry: (err, attempt, total) => {
        logger.warn(`[Guard/${breakerName}] Retry ${attempt}/${total} after error`, { command, error: err.message });
      }
    });
  });
}
