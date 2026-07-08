import fs from 'node:fs';
import path from 'node:path';
import { getHlsVodDir, getDataRoot } from '../config/settings-manager.js';
import { spawnFfmpeg } from '../utils/docker-ffmpeg.js';
import { createModuleLogger } from '../utils/logger.js';
const logger = createModuleLogger('hls-vod');

const inProgress = new Set();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawnFfmpeg(args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const lines = stderr.split('\n').filter(l => l).slice(-5).join('\n');
        reject(new Error(`ffmpeg exited with code ${code}\n${lines}`));
      }
    });
  });
}

const RENDITIONS = [
  { name: '1080p', maxHeight: 1080, maxWidth: 1920, videoBitrate: '4000k', audioBitrate: '192k' },
  { name: '720p',  maxHeight: 720,  maxWidth: 1280, videoBitrate: '2000k', audioBitrate: '128k' },
  { name: '480p',  maxHeight: 480,  maxWidth: 854,  videoBitrate: '1000k', audioBitrate: '96k' },
];

function getRenditionsForSource(sourceHeight) {
  if (!sourceHeight || sourceHeight <= 480) return [];
  if (sourceHeight <= 720) return RENDITIONS.filter(r => r.name === '480p');
  if (sourceHeight <= 1080) return RENDITIONS.filter(r => r.name === '720p' || r.name === '480p');
  return RENDITIONS;
}

function getAudioBitrateVariants(audioBitrate) {
  const maxB = audioBitrate || 320000;
  const variants = [];
  if (maxB >= 256000) variants.push({ name: '320k', bitrate: '320k' });
  if (maxB >= 192000) variants.push({ name: '192k', bitrate: '192k' });
  variants.push({ name: '128k', bitrate: '128k' });
  return variants;
}

async function generateSingleRendition(inputPath, outputDir, rendition, params) {
  const { name, maxHeight, maxWidth, videoBitrate, audioBitrate } = rendition;
  const rDir = path.join(outputDir, name);
  ensureDir(rDir);

  const isSource = name === 'source';
  const flags = params.isVideo && !isSource
    ? ['-vf', `scale=w=${maxWidth}:h=${maxHeight}:force_original_aspect_ratio=decrease`, '-c:v', 'libx264', '-b:v', videoBitrate]
    : [];

  const videoOpts = params.isVideo && isSource
    ? ['-c:v', 'copy']
    : [];

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', inputPath,
    ...videoOpts,
    ...flags,
    '-c:a', 'aac', '-b:a', audioBitrate,
    '-f', 'hls',
    '-hls_playlist_type', 'vod',
    '-hls_list_size', '0',
    '-hls_time', '6',
    '-hls_segment_filename', path.join(rDir, 'segment_%05d.ts'),
    path.join(rDir, 'index.m3u8')
  ];

  logger.info(`[HLS] Generating ${name} rendition...`, { rendition: name });
  await runFfmpeg(args);
  logger.info(`[HLS] ${name} rendition done`, { rendition: name });
}

function generateMasterPlaylist(outputDir, generatedRenditions, params) {
  const entries = generatedRenditions.map(r => {
    const videoBw = r.videoBitrate === 'copy' || r.videoBitrate === '0'
      ? 10000 * 1000
      : parseInt(r.videoBitrate) * 1000;
    const audioBw = parseInt(r.audioBitrate) * 1000;
    const bandwidth = videoBw + audioBw;
    const resolution = params.isVideo ? `${r.maxWidth}x${r.maxHeight}` : undefined;
    const line = `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}${resolution ? `,RESOLUTION=${resolution}` : ''}`;
    return `${line}\n${r.name}/index.m3u8`;
  });

  const content = `#EXTM3U\n#EXT-X-VERSION:3\n${entries.join('\n')}\n`;
  fs.writeFileSync(path.join(outputDir, 'master.m3u8'), content, 'utf-8');
}

function generateAudioMasterPlaylist(outputDir, variants) {
  const entries = variants.map(v => {
    const bitrateNum = parseInt(v.bitrate);
    return `#EXT-X-STREAM-INF:BANDWIDTH=${bitrateNum * 1000}\n${v.name}/index.m3u8`;
  });

  const content = `#EXTM3U\n#EXT-X-VERSION:3\n${entries.join('\n')}\n`;
  fs.writeFileSync(path.join(outputDir, 'master.m3u8'), content, 'utf-8');
}

export async function generateHlsVod(filePath, md5Hash, metadata = {}) {
  const key = md5Hash;
  if (inProgress.has(key)) {
    logger.info(`[HLS] Already generating for ${md5Hash}, skipping`);
    return { success: false, reason: 'already_in_progress' };
  }

  if (!fs.existsSync(filePath)) {
    logger.warn(`[HLS] File not found: ${filePath}`);
    return { success: false, reason: 'file_not_found' };
  }

  const isVideo = metadata.video_codec && metadata.video_codec !== 'none';
  const outputDir = path.join(getHlsVodDir(), md5Hash);

  if (fs.existsSync(path.join(outputDir, 'master.m3u8'))) {
    logger.info(`[HLS] Already exists for ${md5Hash}, skipping`);
    return { success: true, cached: true };
  }

  inProgress.add(key);

  try {
    ensureDir(outputDir);

    if (isVideo) {
      const sourceHeight = metadata.video_height || 1080;
      const targetRenditions = getRenditionsForSource(sourceHeight);

      await generateSingleRendition(filePath, outputDir, {
        name: 'source', videoBitrate: 'copy', audioBitrate: '192k',
        maxHeight: sourceHeight, maxWidth: metadata.video_width || 1920, isVideo: true
      }, { isVideo: true });

      for (const r of targetRenditions) {
        await generateSingleRendition(filePath, outputDir, { ...r, isVideo: true }, { isVideo: true });
      }

      const allRenditions = [
        { name: 'source', videoBitrate: 'copy', audioBitrate: '192k', maxWidth: metadata.video_width || 1920, maxHeight: sourceHeight },
        ...targetRenditions
      ];
      generateMasterPlaylist(outputDir, allRenditions, { isVideo: true });
    } else {
      const audioBitrate = metadata.audio_bitrate || 320000;
      const variants = getAudioBitrateVariants(audioBitrate);

      for (const v of variants) {
        const rDir = path.join(outputDir, v.name);
        ensureDir(rDir);
        const args = [
          '-hide_banner', '-loglevel', 'error',
          '-i', filePath,
          '-c:a', 'aac', '-b:a', v.bitrate,
          '-vn',
          '-f', 'hls',
          '-hls_playlist_type', 'vod',
          '-hls_list_size', '0',
          '-hls_time', '6',
          '-hls_segment_filename', path.join(rDir, 'segment_%05d.ts'),
          path.join(rDir, 'index.m3u8')
        ];
        logger.info(`[HLS] Generating audio ${v.name} variant...`);
        await runFfmpeg(args);
      }

      generateAudioMasterPlaylist(outputDir, variants);
    }

    const manifestPath = path.join('hls-vod', md5Hash, 'master.m3u8');
    logger.info(`[HLS] Generation complete for ${md5Hash}`, { manifestPath });
    return {
      success: true,
      manifestPath,
      renditions: isVideo
        ? ['source', ...getRenditionsForSource(metadata.video_height || 1080).map(r => r.name)]
        : getAudioBitrateVariants(metadata.audio_bitrate || 320000).map(v => v.name)
    };
  } catch (err) {
    logger.error(`[HLS] Generation failed for ${md5Hash}`, { error: err.message });
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
      logger.info(`[HLS] Cleaned up output directory for ${md5Hash}`);
    }
    return { success: false, reason: err.message };
  } finally {
    inProgress.delete(key);
  }
}

export function getHlsManifestPath(md5Hash) {
  return path.join(getHlsVodDir(), md5Hash, 'master.m3u8');
}

export function getHlsPublicPath(md5Hash) {
  return path.join('/hls-vod', md5Hash, 'master.m3u8');
}

export function deleteHlsVod(md5Hash) {
  const dir = path.join(getHlsVodDir(), md5Hash);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    logger.info(`[HLS] Deleted VOD for ${md5Hash}`);
  }
}
