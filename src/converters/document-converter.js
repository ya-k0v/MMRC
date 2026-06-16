import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { getDataRoot, getDevicesPath } from '../config/settings-manager.js';
import { DOCKER_TAG, DOCKER_IMAGES } from '../config/constants.js';
import { execWithGuard } from '../utils/exec-with-guard.js';
import { setFileStatus } from '../video/file-status.js';
import { createModuleLogger } from '../utils/logger.js';
const logger = createModuleLogger('convert');
import { validatePath } from '../utils/path-validator.js';

const execFileAsync = promisify(execFile);

function toStorageKey(absPath) {
  const root = getDataRoot();
  const rel = path.relative(root, path.resolve(String(absPath)));
  if (rel.startsWith('..')) throw new Error('Path outside data root');
  return rel.replace(/\\/g, '/');
}

export async function getPdfPageCount(pdfPath, storage = null) {
  let pdfBytes;
  if (storage) {
    try {
      const key = toStorageKey(pdfPath);
      pdfBytes = await storage.read(key);
    } catch {
      try {
        pdfBytes = await fs.promises.readFile(pdfPath);
      } catch {
        return 0;
      }
    }
  } else {
    try {
      pdfBytes = await fs.promises.readFile(pdfPath);
    } catch {
      return 0;
    }
  }
  const pdfDoc = await PDFDocument.load(pdfBytes);
  return pdfDoc.getPageCount();
}

export async function getPdfPageSize(pdfPath, pageIndex = 0, storage = null) {
  let pdfBytes;
  try {
    if (storage) {
      const key = toStorageKey(pdfPath);
      pdfBytes = await storage.read(key);
    } else {
      pdfBytes = await fs.promises.readFile(pdfPath);
    }
  } catch (error) {
    logger.warn(`[Converter] Failed to get page size, using defaults`, { error: error.message, pdfPath });
    return { width: 595, height: 842, aspectRatio: 595 / 842 };
  }
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const page = pdfDoc.getPage(pageIndex);
  const { width, height } = page.getSize();
  return { width, height, aspectRatio: width / height };
}

export async function convertPdfToImages(pdfPath, outputDir, onProgress = null, storage = null) {
  const dataRoot = getDataRoot();
  const safeOutputDir = validatePath(path.resolve(outputDir), dataRoot);
  let safePdfPath = validatePath(path.resolve(pdfPath), dataRoot);

  if (!fs.existsSync(safePdfPath) && storage) {
    try {
      const key = toStorageKey(safePdfPath);
      const readStream = await storage.createReadStream(key);
      const tempPdf = path.join(os.tmpdir(), `mmrc-pdf-${crypto.randomUUID()}-${path.basename(safePdfPath)}`);
      const writeStream = fs.createWriteStream(tempPdf);
      await new Promise((resolve, reject) => {
        readStream.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        readStream.on('error', reject);
      });
      safePdfPath = tempPdf;
    } catch (err) {
      logger.error(`[Converter] Cannot retrieve PDF from storage`, { error: err.message, pdfPath });
      throw new Error(`Source PDF not available locally or in storage: ${pdfPath}`);
    }
  } else if (!fs.existsSync(safePdfPath)) {
    throw new Error(`Source PDF not found: ${pdfPath}`);
  }

  const pageSize = await getPdfPageSize(safePdfPath, 0, storage);
  const { aspectRatio } = pageSize;

  const MAX_WIDTH = 1920;
  const MAX_HEIGHT = 1080;
  const MAX_ASPECT_RATIO = MAX_WIDTH / MAX_HEIGHT;

  let targetWidth, targetHeight;

  if (aspectRatio > 1) {
    if (aspectRatio >= 1.6 && aspectRatio <= 1.9) {
      targetWidth = MAX_WIDTH;
      targetHeight = MAX_HEIGHT;
      logger.info(`[Converter] Landscape ${aspectRatio.toFixed(2)}:1, using ${targetWidth}x${targetHeight}`);
    } else if (aspectRatio > MAX_ASPECT_RATIO) {
      targetWidth = MAX_WIDTH;
      targetHeight = Math.round(MAX_WIDTH / aspectRatio);
      logger.info(`[Converter] Wide ${aspectRatio.toFixed(2)}:1, using ${targetWidth}x${targetHeight}`);
    } else {
      targetHeight = MAX_HEIGHT;
      targetWidth = Math.round(MAX_HEIGHT * aspectRatio);
      logger.info(`[Converter] Landscape ${aspectRatio.toFixed(2)}:1, using ${targetWidth}x${targetHeight}`);
    }
  } else {
    targetHeight = MAX_HEIGHT;
    targetWidth = Math.round(MAX_HEIGHT * aspectRatio);
    logger.info(`[Converter] Portrait ${(1/aspectRatio).toFixed(2)}:1, using ${targetWidth}x${targetHeight}`);
  }

  const pageCount = await getPdfPageCount(safePdfPath, storage);
  logger.info(`[Converter] Starting PDF conversion: ${pageCount} pages, target: ${targetWidth}x${targetHeight}`);

  const density = 150;
  const convertedPages = [];
  for (let i = 1; i <= pageCount; i++) {
    let tempFile = null;
    try {
      const imagePath = path.join(safeOutputDir, `page.${i}.png`);

      tempFile = path.join(os.tmpdir(), `mmrc-pdf-${crypto.randomUUID()}-p${i}.png`);

      await execFileAsync('gs', [
        '-dNOPAUSE', '-dBATCH', '-dSAFER',
        '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
        '-sDEVICE=png16m',
        `-r${density}`,
        `-dFirstPage=${i}`, `-dLastPage=${i}`,
        `-sOutputFile=${tempFile}`,
        safePdfPath
      ]);

      await sharp(tempFile)
        .resize(targetWidth, targetHeight, {
          fit: 'inside',
          withoutEnlargement: true,
          kernel: 'lanczos3'
        })
        .png()
        .toFile(imagePath);

      if (storage) {
        try {
          const pngKey = toStorageKey(imagePath);
          await storage.write(pngKey, fs.createReadStream(imagePath));
        } catch (uploadErr) {
          logger.warn(`[Converter] Failed to upload page ${i} to storage`, { error: uploadErr.message });
        }
      }

      const stats = fs.statSync(imagePath);
      if (stats.size > 100) {
        convertedPages.push({ page: i, path: imagePath });
        logger.info(`[Converter] Page ${i} converted: ${imagePath} (${(stats.size / 1024).toFixed(2)} KB)`);
        if (onProgress) {
          onProgress(Math.max(0, Math.min(99, Math.round((i / pageCount) * 99))));
        }
      } else {
        logger.warn(`[Converter] Page ${i}: file too small: ${imagePath}`);
      }
    } catch (error) {
      logger.error(`[Converter] Error converting page ${i}`, {
        error: error.message, stack: error.stack, page: i
      });
    } finally {
      if (tempFile) {
        try { fs.unlinkSync(tempFile); } catch {}
      }
    }
  }

  if (convertedPages.length === 0) {
    throw new Error(`Failed to convert any of ${pageCount} pages`);
  }

  logger.info(`[Converter] Converted ${convertedPages.length} of ${pageCount} pages`);

  for (const { page, path: imagePath } of convertedPages) {
    if (fs.existsSync(imagePath)) {
      try {
        const meta = await sharp(imagePath).metadata();
        logger.info(`[Converter] Image ${page} ready: ${meta.width}x${meta.height} (target: ${targetWidth}x${targetHeight})`);
      } catch (e) {
      }
    }
  }

  return pageCount;
}

export async function convertPptxToImages(pptxPath, outputDir, onProgress = null, storage = null) {
  const dataRoot = getDataRoot();
  const safeOutputDir = validatePath(path.resolve(outputDir), dataRoot);
  let safePptxPath = validatePath(path.resolve(pptxPath), dataRoot);

  if (!fs.existsSync(safePptxPath) && storage) {
    try {
      const key = toStorageKey(safePptxPath);
      const readStream = await storage.createReadStream(key);
      const tempPptx = path.join(os.tmpdir(), `mmrc-pptx-${crypto.randomUUID()}-${path.basename(safePptxPath)}`);
      const writeStream = fs.createWriteStream(tempPptx);
      await new Promise((resolve, reject) => {
        readStream.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        readStream.on('error', reject);
      });
      safePptxPath = tempPptx;
    } catch (err) {
      logger.error(`[Converter] Cannot retrieve PPTX from storage`, { error: err.message, pptxPath });
      throw new Error(`Source PPTX not available locally or in storage: ${pptxPath}`);
    }
  } else if (!fs.existsSync(safePptxPath)) {
    throw new Error(`Source PPTX not found: ${pptxPath}`);
  }

  const fileNameWithoutExt = path.basename(safePptxPath, path.extname(safePptxPath));
  const pdfPath = path.join(safeOutputDir, `${fileNameWithoutExt}.pdf`);

  try {
    if (process.env.MMRC_DOCKER === '1') {
      await convertPptxToPdfViaDocker(safePptxPath, safeOutputDir);
    } else {
      await execWithGuard('converter', 'soffice', ['--headless', '--convert-to', 'pdf', '--outdir', safeOutputDir, safePptxPath]);
    }
    if (onProgress) onProgress(5);

    if (!fs.existsSync(pdfPath)) {
      throw new Error(`PDF not created: ${pdfPath}`);
    }

    const numPages = await convertPdfToImages(pdfPath, safeOutputDir, onProgress, storage);

    fs.unlinkSync(pdfPath);

    return numPages;
  } catch (error) {
    logger.error(`[Converter] PPTX conversion failed`, { error: error.message, stack: error.stack, pptxPath });
    throw error;
  }
}

async function convertPptxToPdfViaDocker(pptxPath, outputDir) {
  const hostDataDir = process.env.HOST_DATA_DIR || '/opt/mmrc/data';
  const converterImage = process.env.CONVERTER_IMAGE || DOCKER_IMAGES.converter;
  const imageTag = process.env.DOCKER_IMAGE_TAG || DOCKER_TAG;

  const dataRoot = getDataRoot();
  const converterPptxPath = pptxPath.replace(dataRoot, '/data');
  const converterOutputDir = outputDir.replace(dataRoot, '/data');

  await execWithGuard('converter', 'docker', [
    'run', '--rm',
    '-v', `${hostDataDir}:/data:rw`,
    `${converterImage}:${imageTag}`,
    '--convert-to', 'pdf',
    '--outdir', converterOutputDir,
    converterPptxPath,
  ]);
}

export async function findFileFolder(deviceFolderOrId, fileName, storage = null) {
  const devicesPath = getDevicesPath();
  const deviceFolder = path.join(devicesPath, deviceFolderOrId);
  if (!fs.existsSync(deviceFolder)) {
    if (storage) {
      try {
        const prefix = toStorageKey(deviceFolder);
        const entries = await storage.list(prefix);
        const folderName = fileName.replace(/\.(pdf|pptx)$/i, '');
        const possibleFolderRel = path.posix.join(prefix, folderName);
        const pngPattern = `${possibleFolderRel}/page.`;
        const hasPng = entries.some(e => e.startsWith(pngPattern));
        if (hasPng) {
          const possibleFolder = path.join(deviceFolder, folderName);
          return possibleFolder;
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  const ext = path.extname(fileName).toLowerCase();
  const folderName = fileName.replace(/\.(pdf|pptx)$/i, '');
  const possibleFolder = path.join(deviceFolder, folderName);

  if (fs.existsSync(possibleFolder) && fs.statSync(possibleFolder).isDirectory()) {
    const folderContents = fs.readdirSync(possibleFolder);
    const hasPngFiles = folderContents.some(f => f.toLowerCase().endsWith('.png'));
    if (hasPngFiles) {
      return possibleFolder;
    }
    if (ext === '.pdf' || ext === '.pptx') {
      return possibleFolder;
    }
  }

  if (!ext || ext === '') {
    const directFolder = path.join(deviceFolder, fileName);
    if (fs.existsSync(directFolder) && fs.statSync(directFolder).isDirectory()) {
      return directFolder;
    }
  }

  if (storage) {
    try {
      const prefix = toStorageKey(deviceFolder);
      const entries = await storage.list(prefix);
      const targetFolder = path.posix.join(prefix, folderName);
      const hasPng = entries.some(e => e.startsWith(`${targetFolder}/page.`) && e.endsWith('.png'));
      if (hasPng) {
        return path.join(deviceFolder, folderName);
      }
    } catch {
    }
  }

  return null;
}

export async function getPageSlideCount(deviceId, fileName, storage = null) {
  try {
    const convertedDir = await findFileFolder(deviceId, fileName, storage);
    if (!convertedDir) return 0;

    if (fs.existsSync(convertedDir)) {
      const pngFiles = fs.readdirSync(convertedDir)
        .filter(f => f.toLowerCase().endsWith('.png'))
        .sort();
      if (pngFiles.length > 0) return pngFiles.length;
    }

    if (storage) {
      try {
        const prefix = toStorageKey(convertedDir);
        const entries = await storage.list(prefix);
        const pngFiles = entries
          .filter(e => e.endsWith('.png'))
          .sort();
        return pngFiles.length;
      } catch {
      }
    }

    return 0;
  } catch {
    return 0;
  }
}

export async function autoConvertFile(deviceId, fileName, devices, fileNamesMap, saveFileNamesMapFn, io = null, storage = null) {
  const d = devices[deviceId];
  if (!d) return 0;

  const devicesPath = getDevicesPath();
  const deviceFolder = path.join(devicesPath, d.folder);
  const filePath = path.join(deviceFolder, fileName);

  if (fs.existsSync(filePath)) {
  } else if (storage) {
    try {
      const key = toStorageKey(filePath);
      await storage.stat(key);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      const readStream = await storage.createReadStream(key);
      const writeStream = fs.createWriteStream(filePath);
      await new Promise((resolve, reject) => {
        readStream.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        readStream.on('error', reject);
      });
      logger.info(`[Converter] Downloaded source from storage: ${fileName}`, { deviceId, fileName });
    } catch {
      logger.warn(`[Converter] File not found locally or in storage: ${filePath}`, { deviceId, fileName, deviceFolder, devicesPath });
      return 0;
    }
  } else {
    logger.warn(`[Converter] File not found: ${filePath}`, { deviceId, fileName, deviceFolder, devicesPath });
    return 0;
  }

  const ext = path.extname(fileName).toLowerCase();
  if (ext !== '.pdf' && ext !== '.pptx') return 0;
  const folderName = fileName.replace(/\.(pdf|pptx)$/i, '');

  if (io) {
    io.emit('file/processing', { device_id: deviceId, file: fileName, type: ext.substring(1) });
    io.emit('file/progress', { device_id: deviceId, file: fileName, progress: 0 });
    logger.info(`[Converter] Starting conversion: ${fileName}`, { deviceId, fileName });
  }
  setFileStatus(deviceId, fileName, { status: 'processing', progress: 0, canPlay: false });

  const convertedDir = path.join(deviceFolder, folderName);
  const originalName = fileNamesMap[deviceId]?.[fileName] || fileName;

  const existing = fs.existsSync(convertedDir) && fs.statSync(convertedDir).isDirectory()
    ? fs.readdirSync(convertedDir).filter(f => f.toLowerCase().endsWith('.png')).length
    : 0;

  if (existing > 0) {
    if (!fileNamesMap[deviceId]) fileNamesMap[deviceId] = {};
    if (!fileNamesMap[deviceId][folderName]) {
      fileNamesMap[deviceId][folderName] = originalName;
      saveFileNamesMapFn(fileNamesMap);
    }

    setFileStatus(deviceId, fileName, { status: 'ready', progress: 100, canPlay: true });

    if (io) {
      io.emit('file/progress', { device_id: deviceId, file: fileName, progress: 100 });
      io.emit('file/ready', { device_id: deviceId, file: fileName, pages: existing });
      logger.info(`[Converter] Already converted: ${fileName} (${existing} pages)`, { deviceId, fileName, pages: existing });
    }

    return existing;
  }

  try {
    if (!fs.existsSync(convertedDir)) {
      fs.mkdirSync(convertedDir, { recursive: true });
    }

    let count = 0;
    if (ext === '.pptx') {
      count = await convertPptxToImages(filePath, convertedDir, (progress) => {
        setFileStatus(deviceId, fileName, { status: 'processing', progress, canPlay: false });
        if (io) {
          io.emit('file/progress', { device_id: deviceId, file: fileName, progress });
        }
      }, storage);
    } else if (ext === '.pdf') {
      count = await convertPdfToImages(filePath, convertedDir, (progress) => {
        setFileStatus(deviceId, fileName, { status: 'processing', progress, canPlay: false });
        if (io) {
          io.emit('file/progress', { device_id: deviceId, file: fileName, progress });
        }
      }, storage);
    }

    if (count > 0 && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        logger.info(`[Converter] Source file deleted: ${fileName}`, { deviceId, fileName });
      } catch (delErr) {
        logger.warn(`[Converter] Failed to delete source file: ${fileName}`, {
          error: delErr.message, deviceId, fileName
        });
      }
    }

    if (!fileNamesMap[deviceId]) fileNamesMap[deviceId] = {};
    fileNamesMap[deviceId][folderName] = originalName;
    if (fileNamesMap[deviceId][fileName]) {
      delete fileNamesMap[deviceId][fileName];
    }
    saveFileNamesMapFn(fileNamesMap);

    if (io && count > 0) {
      io.emit('file/progress', { device_id: deviceId, file: fileName, progress: 100 });
      io.emit('file/ready', { device_id: deviceId, file: fileName, pages: count });
      logger.info(`[Converter] Converted: ${fileName} (${count} pages)`, { deviceId, fileName, pages: count });
      io.emit('devices/updated');
    }

    setFileStatus(deviceId, fileName, { status: 'ready', progress: 100, canPlay: true });

    return count;

  } catch (error) {
    logger.error(`[Converter] Conversion error ${fileName}`, { error: error.message, stack: error.stack, deviceId, fileName });

    if (io) {
      io.emit('file/error', {
        device_id: deviceId, file: fileName, error: error.message || String(error)
      });
      io.emit('file/progress', { device_id: deviceId, file: fileName, progress: 0 });
    }

    setFileStatus(deviceId, fileName, { status: 'error', progress: 0, canPlay: false, error: error.message });

    return 0;
  }
}
