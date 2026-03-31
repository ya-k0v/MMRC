import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAdmin } from '../middleware/auth.js';

// Получить admin accessToken через /api/auth/login
async function getAdminAccessToken(serverUrl) {
  const fetch = (await import('node-fetch')).default;
  // Можно вынести в env/config
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const loginUrl = `${serverUrl.replace(/\/$/, '')}/api/auth/login`;
  const resp = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (!resp.ok) {
    throw new Error('Не удалось получить admin accessToken: ' + (await resp.text()));
  }
  const data = await resp.json();
  return data.accessToken;
}
import { installAndSetupApk } from '../utils/apk-installer.js';
import { getSettings } from '../config/settings-manager.js';

// Для поддержки __dirname в ES-модулях
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Хранилище для временного сохранения APK
const upload = multer({ dest: '/tmp', limits: { fileSize: 200 * 1024 * 1024 } });

// POST /api/admin/install-apk
router.post('/install-apk', requireAdmin, upload.single('apk'), async (req, res) => {
  const ip = req.body.ip;
  const deviceId = req.body.deviceId;
  const deviceName = req.body.deviceName;

  // Получаем serverUrl из настроек
  const settings = getSettings();
  // Можно хранить serverUrl в app-settings.json или .env, либо задать явно здесь:
  // Например, если сервер работает на 80 порту и доступен по IP сервера:
  const serverUrl = settings.serverUrl || process.env.SERVER_URL || `http://${req.headers.host || '127.0.0.1:3000'}`;
  // Если файл был загружен через multipart — используем его, иначе — фиксированный путь
  let apkPath = req.file?.path;
  const FIXED_APK_PATH = path.resolve(__dirname, '../../clients/android-mediaplayer/app-release.apk');
  if (!apkPath) {
    apkPath = FIXED_APK_PATH;
  }
  // IP — адрес устройства, deviceId — ID устройства, deviceName — имя устройства
  if (!ip || !deviceId || !deviceName || !apkPath || !fs.existsSync(apkPath)) {
    return res.status(400).json({ ok: false, error: 'IP, ID, имя и файл APK обязательны' });
  }
  try {
    // Вся логика установки и настройки APK вынесена в отдельную функцию
    await installAndSetupApk({ ip, deviceId, deviceName, apkPath, serverUrl });

    // После успешной настройки — создать устройство через основной API
    let deviceAdded = false;
    try {
      const fetch = (await import('node-fetch')).default;
      const apiUrl = `${serverUrl.replace(/\/$/, '')}/api/devices`;
      // Получаем admin accessToken
      const accessToken = await getAdminAccessToken(serverUrl);
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({ device_id: deviceId, name: deviceName })
      });
      if (resp.ok) {
        deviceAdded = true;
      } else {
        const errText = await resp.text();
        console.warn('Ошибка при добавлении устройства через API:', errText);
      }
    } catch (e) {
      console.warn('Не удалось создать устройство через API:', e.message);
    }

    // 6. Возвращаем успешный ответ
    // Обновляем панели
    const { default: getIO } = await import('../socket/index.js');
    const io = getIO && typeof getIO === 'function' ? getIO() : (global.io || null);
    if (io && io.emit) {
      io.emit('devices/updated');
    }
    return res.json({ ok: true, deviceAdded });
  } catch (e) {
    console.error('Ошибка при установке APK:', e);
    return res.status(500).json({ ok: false, error: 'Ошибка при установке APK на устройство' });
  } finally {
    // Удаляем временный файл, если он был загружен
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

export default router;
