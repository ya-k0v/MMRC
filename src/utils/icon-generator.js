import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import logger from './logger.js';
import { ROOT, PUBLIC } from '../config/constants.js';

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

const WEB_ICONS = [
  { size: 16, fileName: 'favicon-16.png' },
  { size: 32, fileName: 'favicon-32.png' },
  { size: 180, fileName: 'apple-touch-icon.png' },
  { size: 192, fileName: 'icon-192.png' },
  { size: 512, fileName: 'icon-512.png' }
];

const ANDROID_ICONS = [
  { size: 48, dir: 'mipmap-mdpi' },
  { size: 72, dir: 'mipmap-hdpi' },
  { size: 96, dir: 'mipmap-xhdpi' },
  { size: 144, dir: 'mipmap-xxhdpi' },
  { size: 192, dir: 'mipmap-xxxhdpi' }
];

function resolveSourceSvg() {
  const publicSvg = path.join(PUBLIC, 'icon.svg');
  if (fs.existsSync(publicSvg)) {
    return publicSvg;
  }
  const rootSvg = path.join(ROOT, 'icon.svg');
  if (fs.existsSync(rootSvg)) {
    return rootSvg;
  }
  return null;
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let stderr = '';

    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
      }
    });

    proc.on('error', reject);
  });
}

function checkTool(command) {
  return new Promise((resolve) => {
    const proc = spawn('which', [command]);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function resolveConverter() {
  if (await checkTool('convert')) {
    return 'convert';
  }
  if (await checkTool('inkscape')) {
    return 'inkscape';
  }
  if (await checkTool('rsvg-convert')) {
    return 'rsvg-convert';
  }
  return null;
}

async function convertSvg(converter, svgPath, size, outputPath) {
  ensureDir(outputPath);

  if (converter === 'convert') {
    const args = [
      '-background', 'none',
      svgPath,
      '-resize', `${size}x${size}`,
      outputPath
    ];
    await runCommand('convert', args);
    return;
  }

  if (converter === 'inkscape') {
    const args = [
      svgPath,
      '-w', size.toString(),
      '-h', size.toString(),
      '-o', outputPath
    ];
    await runCommand('inkscape', args);
    return;
  }

  if (converter === 'rsvg-convert') {
    const args = [
      '-w', size.toString(),
      '-h', size.toString(),
      '-o', outputPath,
      svgPath
    ];
    await runCommand('rsvg-convert', args);
  }
}

async function generateIcons(sourceSvg, converter) {
  logger.info('[Icons] Generating icons', { sourceSvg, converter });

  for (const { size, fileName } of WEB_ICONS) {
    const outputPath = path.join(PUBLIC, fileName);
    try {
      await convertSvg(converter, sourceSvg, size, outputPath);
      logger.info('[Icons] Generated web icon', { fileName, size });
    } catch (error) {
      logger.warn('[Icons] Failed to generate web icon', {
        fileName,
        size,
        error: error.message
      });
    }
  }

  const androidResDir = path.join(
    ROOT,
    'clients',
    'android-mediaplayer',
    'app',
    'src',
    'main',
    'res'
  );

  for (const { size, dir } of ANDROID_ICONS) {
    const outputPath = path.join(androidResDir, dir, 'ic_launcher.png');
    try {
      await convertSvg(converter, sourceSvg, size, outputPath);
      logger.info('[Icons] Generated Android icon', { dir, size });
    } catch (error) {
      logger.warn('[Icons] Failed to generate Android icon', {
        dir,
        size,
        error: error.message
      });
    }
  }
}

export async function maybeGenerateIcons({ force = false } = {}) {
  const sourceSvg = resolveSourceSvg();
  if (!sourceSvg) {
    logger.warn('[Icons] icon.svg not found, skipping');
    return;
  }

  const stats = fs.statSync(sourceSvg);
  const ageMs = Date.now() - stats.mtimeMs;

  if (!force && ageMs > THREE_HOURS_MS) {
    logger.info('[Icons] icon.svg is older than 3 hours, skipping generation', {
      ageMinutes: Math.round(ageMs / 60000)
    });
    return;
  }

  const converter = await resolveConverter();
  if (!converter) {
    logger.warn('[Icons] No SVG converter found (convert/inkscape/rsvg-convert), skipping');
    return;
  }

  await generateIcons(sourceSvg, converter);
}
