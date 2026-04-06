import fs from 'fs';
import path from 'path';
import https from 'https';

const RELEASE_BASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const LOCAL_BIN_DIR = path.join(process.cwd(), 'bin');
const LOCAL_BIN_NAME = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const LOCAL_BIN_PATH = path.join(LOCAL_BIN_DIR, LOCAL_BIN_NAME);

let installPromise = null;

function logWithFallback(logger, level, message, meta = undefined) {
  try {
    if (logger && typeof logger[level] === 'function') {
      logger[level](message, meta);
      return;
    }
    if (meta !== undefined) {
      // eslint-disable-next-line no-console
      console.log(`[yt-dlp] ${message}`, meta);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[yt-dlp] ${message}`);
  } catch {
    // Do nothing on logging failures.
  }
}

function getReleaseAssetForCurrentPlatform() {
  if (process.platform === 'linux') {
    if (process.arch === 'x64') return 'yt-dlp_linux';
    if (process.arch === 'arm64') return 'yt-dlp_linux_aarch64';
    return 'yt-dlp';
  }

  if (process.platform === 'darwin') {
    return 'yt-dlp_macos';
  }

  if (process.platform === 'win32') {
    return 'yt-dlp.exe';
  }

  return 'yt-dlp';
}

function hasExecutablePermissions(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureExecutablePermissions(filePath) {
  if (process.platform === 'win32') return;

  try {
    if (!hasExecutablePermissions(filePath)) {
      fs.chmodSync(filePath, 0o755);
    }
  } catch {
    // Ignore chmod errors here, caller will fail later if execution is not possible.
  }
}

function downloadWithRedirects(url, targetPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'User-Agent': 'videocontrol-yt-dlp-bootstrap/1.0'
      }
    }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;

      if (REDIRECT_STATUS_CODES.has(status) && location) {
        response.resume();

        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects while downloading yt-dlp binary'));
          return;
        }

        const redirectedUrl = new URL(location, url).toString();
        downloadWithRedirects(redirectedUrl, targetPath, redirectsLeft - 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (status !== 200) {
        response.resume();
        reject(new Error(`yt-dlp download failed with HTTP ${status}`));
        return;
      }

      const fileStream = fs.createWriteStream(targetPath, { mode: 0o755 });

      fileStream.on('error', (err) => {
        response.resume();
        reject(err);
      });

      response.on('error', (err) => {
        reject(err);
      });

      fileStream.on('finish', () => {
        fileStream.close((closeErr) => {
          if (closeErr) {
            reject(closeErr);
            return;
          }
          resolve();
        });
      });

      response.pipe(fileStream);
    });

    request.on('error', (err) => {
      reject(err);
    });
  });
}

async function installLocalBinary(logger) {
  const assetName = getReleaseAssetForCurrentPlatform();
  const url = `${RELEASE_BASE_URL}/${assetName}`;

  if (!fs.existsSync(LOCAL_BIN_DIR)) {
    fs.mkdirSync(LOCAL_BIN_DIR, { recursive: true });
  }

  const tmpPath = `${LOCAL_BIN_PATH}.tmp-${Date.now()}-${process.pid}`;

  logWithFallback(logger, 'info', '[yt-dlp] Downloading local binary', {
    assetName,
    url,
    targetPath: LOCAL_BIN_PATH
  });

  try {
    await downloadWithRedirects(url, tmpPath);
    fs.renameSync(tmpPath, LOCAL_BIN_PATH);
    ensureExecutablePermissions(LOCAL_BIN_PATH);

    logWithFallback(logger, 'info', '[yt-dlp] Local binary ready', {
      path: LOCAL_BIN_PATH
    });
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors.
    }
    throw error;
  }

  return LOCAL_BIN_PATH;
}

export function getLocalYtDlpBinaryPath() {
  return LOCAL_BIN_PATH;
}

export async function ensureLocalYtDlpBinary(options = {}) {
  const { force = false, logger = null } = options;

  if (!force && fs.existsSync(LOCAL_BIN_PATH)) {
    ensureExecutablePermissions(LOCAL_BIN_PATH);
    return LOCAL_BIN_PATH;
  }

  if (!installPromise) {
    installPromise = installLocalBinary(logger)
      .finally(() => {
        installPromise = null;
      });
  }

  return installPromise;
}
