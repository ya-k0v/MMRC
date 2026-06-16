import { spawn } from 'node:child_process';
import { DOCKER_TAG, DOCKER_IMAGES } from '../config/constants.js';
import { execWithGuard } from './exec-with-guard.js';
import { createModuleLogger } from './logger.js';
const logger = createModuleLogger('video');

const isDocker = () => process.env.MMRC_DOCKER === '1';
const isStreamerEnabled = () => process.env.MMRC_STREAMER_ENABLED === '1' || process.env.MMRC_STREAMER === '1';

let _streamerClient = null;
async function getStreamerClient() {
  if (_streamerClient) return _streamerClient;
  const { StreamerClient } = await import('../streamer/streamer-client.js');
  const baseUrl = process.env.MMRC_STREAMER_URL || 'http://mmrc-streamer:3001';
  _streamerClient = new StreamerClient(baseUrl);
  try {
    const health = await _streamerClient.health();
    logger.info('[Streamer] Connected', { baseUrl, running: health.running });
  } catch (e) {
    logger.warn('[Streamer] Not available, falling back to direct spawn', { baseUrl, error: e.message });
    _streamerClient = null;
  }
  return _streamerClient;
}

function getDockerConfig() {
  return {
    hostDataDir: process.env.HOST_DATA_DIR || '/opt/mmrc/data',
    image: process.env.FFMPEG_IMAGE || (DOCKER_IMAGES.ffmpeg || 'pingwin1900/mmrc-ffmpeg'),
    tag: process.env.DOCKER_IMAGE_TAG || DOCKER_TAG,
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
    return execWithGuard('ffmpeg', 'docker', dockerArgs, options);
  }
  return execWithGuard('ffmpeg', 'ffmpeg', args, options);
}

export async function execFfprobe(args, options = {}) {
  if (isDocker()) {
    const dockerArgs = buildDockerArgs('ffprobe', args);
    logger.debug('[DockerFFmpeg] Executing ffprobe via Docker', { dockerArgs });
    return execWithGuard('ffmpeg', 'docker', dockerArgs, options);
  }
  return execWithGuard('ffmpeg', 'ffprobe', args, options);
}

export async function spawnFfmpegRemote(args, options) {
  if (!isStreamerEnabled()) {
    return spawnFfmpeg(args, options);
  }
  const client = await getStreamerClient();
  if (!client) {
    return spawnFfmpeg(args, options);
  }
  const proc = await client.spawn('ffmpeg', args);
  return proc;
}

export async function spawnFfprobeRemote(args, options) {
  if (!isStreamerEnabled()) {
    return spawnFfprobe(args, options);
  }
  const client = await getStreamerClient();
  if (!client) {
    return spawnFfprobe(args, options);
  }
  const proc = await client.spawn('ffprobe', args);
  return proc;
}
