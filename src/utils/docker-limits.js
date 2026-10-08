import { createModuleLogger } from './logger.js';
const logger = createModuleLogger('video');

function toPositiveNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

// Аргументы docker run для sibling-контейнеров (ffmpeg/ffprobe/конвертер).
// Без них обработка видео запускается на хосте БЕЗ всяких лимитов и может
// занять все ядра и память, «заморозив» остальные контейнеры и сам хост.
// Лимиты настраиваются в .env и, по возможности, соответствуют лимитам
// самого mmrc (MMRC_CPU_LIMIT, MMRC_MEMORY_LIMIT, MMRC_PIDS_LIMIT).
export function getDockerResourceArgs() {
  const args = [];

  const cpu = toPositiveNumber(process.env.MMRC_CPU_LIMIT || '');
  const memory = (process.env.MMRC_MEMORY_LIMIT || '4G').trim();
  const pids = toPositiveNumber(process.env.MMRC_PIDS_LIMIT || '');

  if (cpu > 0) args.push('--cpus', String(cpu));
  if (memory && memory !== '0' && memory.toLowerCase() !== 'off') {
    args.push('--memory', memory);
    args.push('--memory-swap', memory);
  }
  if (pids > 0) args.push('--pids-limit', String(pids));

  if (args.length > 0) {
    logger.debug('[DockerLimits] Resource constraints for sibling container', {
      cpus: cpu > 0 ? cpu : undefined,
      memory: args.includes('--memory') ? memory : undefined,
      pids: pids > 0 ? pids : undefined
    });
  }

  return args;
}