import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import util from 'node:util';
import { createModuleLogger } from './logger.js';
const logger = createModuleLogger('video');

const execFileAsync = util.promisify(execFile);

const isDocker = () => process.env.MMRC_DOCKER === '1';

function getDockerConfig() {
  return {
    hostDataDir: process.env.HOST_DATA_DIR || '/opt/mmrc/data',
    image: process.env.FFMPEG_IMAGE || 'pingwin1900/mmrc-ffmpeg',
    tag: process.env.DOCKER_IMAGE_TAG || 'v330',
    containerDataRoot: process.env.MMRC_DATA_DIR || '/app/data',
    containerPath: '/data'
  };
}

function translateArgs(args) {
  const cfg = getDockerConfig();
  return args.map(a => {
    if (typeof a === 'string' && a.startsWith(cfg.containerDataRoot)) {
      return a.replace(cfg.containerDataRoot, cfg.containerPath);
    }
    return a;
  });
}

function buildDockerArgs(binary, args) {
  const cfg = getDockerConfig();
  const translated = translateArgs(args);
  return [
    'run', '--rm',
    '-v', `${cfg.hostDataDir}:${cfg.containerPath}:rw`,
    `${cfg.image}:${cfg.tag}`,
    binary,
    ...translated
  ];
}

export function spawnFfmpeg(args, options) {
  if (isDocker()) {
    const dockerArgs = buildDockerArgs('ffmpeg', args);
    logger.debug('[DockerFFmpeg] Spawning ffmpeg via Docker', { dockerArgs });
    return spawn('docker', dockerArgs, options);
  }
  return spawn('ffmpeg', args, options);
}

export function spawnFfprobe(args, options) {
  if (isDocker()) {
    const dockerArgs = buildDockerArgs('ffprobe', args);
    logger.debug('[DockerFFmpeg] Spawning ffprobe via Docker', { dockerArgs });
    return spawn('docker', dockerArgs, options);
  }
  return spawn('ffprobe', args, options);
}

export async function execFfmpeg(args, options = {}) {
  if (isDocker()) {
    const dockerArgs = buildDockerArgs('ffmpeg', args);
    logger.debug('[DockerFFmpeg] Executing ffmpeg via Docker', { dockerArgs });
    return execFileAsync('docker', dockerArgs, options);
  }
  return execFileAsync('ffmpeg', args, options);
}

export async function execFfprobe(args, options = {}) {
  if (isDocker()) {
    const dockerArgs = buildDockerArgs('ffprobe', args);
    logger.debug('[DockerFFmpeg] Executing ffprobe via Docker', { dockerArgs });
    return execFileAsync('docker', dockerArgs, options);
  }
  return execFileAsync('ffprobe', args, options);
}
