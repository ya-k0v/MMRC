/**
 * Роутер прикладных профилей питания (конструктор в админке).
 *
 * Профили — команды сна/пробуждения под конкретные модели и версии Android.
 * Здесь только API для админки: список, каталог шагов, сохранение, удаление
 * и проверка отдельного шага на живом устройстве. Сама логика выбора профиля
 * живёт в utils/power-profiles, выполнение — в utils/power-control.
 *
 * @module routes/power-profiles
 */

import express from 'express';
import { createModuleLogger } from '../utils/logger.js';
import { isAndroidDevice } from '../utils/adb.js';
import { resolveDeviceAdbPort } from './devices.js';
import { testPowerStep } from '../utils/power-control.js';
import {
  listPowerProfiles,
  savePowerProfile,
  deletePowerProfile,
  normalizePowerStep,
  POWER_STEP_CATALOG
} from '../utils/power-profiles.js';

const powerLog = createModuleLogger('power-profiles');

/**
 * @param {Object} deps
 * @param {Object} deps.devices - карта устройств
 * @param {Function} deps.requireAdmin - middleware (только админ)
 * @returns {express.Router}
 */
export function createPowerProfilesRouter(deps) {
  const { devices, requireAdmin } = deps;
  const router = express.Router();

  // Список профилей из БД (все правятся и удаляются одинаково).
  router.get('/', requireAdmin, (req, res) => {
    try {
      res.json({ ok: true, profiles: listPowerProfiles() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // Каталог шагов для конструктора.
  router.get('/steps', requireAdmin, (req, res) => {
    res.json({ ok: true, steps: POWER_STEP_CATALOG });
  });

  // Сохранить профиль (создание или обновление по ключу).
  router.post('/', requireAdmin, async (req, res) => {
    const result = await savePowerProfile(req.body || {});
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }
    powerLog.info('Профиль питания сохранён', { key: result.profile.key, label: result.profile.label });
    res.json({ ok: true, profile: result.profile });
  });

  // Удалить профиль.
  router.delete('/:key', requireAdmin, async (req, res) => {
    const result = await deletePowerProfile(String(req.params.key || ''));
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }
    powerLog.info('Профиль питания удалён', { key: String(req.params.key || '') });
    res.json({ ok: true });
  });

  // Проверка одного шага конструктора на живом устройстве.
  router.post('/test', requireAdmin, async (req, res) => {
    const deviceId = String(req.body?.deviceId || '').trim();
    const phase = String(req.body?.phase || 'wake') === 'sleep' ? 'sleep' : 'wake';
    const step = req.body?.step;

    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'Укажите deviceId устройства для проверки' });
    }
    const normalizedStep = normalizePowerStep(step);
    if (normalizedStep === null) {
      return res.status(400).json({ ok: false, error: 'Шаг проверки не распознан: число (KEYCODE) или svc:/cmd:/settings:/am:/input:/dumpsys:/wm:/lan: команда' });
    }

    const device = devices && devices[deviceId];
    if (!device) {
      return res.status(404).json({ ok: false, error: 'Устройство не найдено' });
    }
    if (!isAndroidDevice(device)) {
      return res.status(400).json({ ok: false, error: 'Не Android-устройство' });
    }
    if (!device.ipAddress) {
      return res.status(400).json({ ok: false, error: 'IP адрес устройства не задан' });
    }

    try {
      const port = await resolveDeviceAdbPort(deviceId, device);
      const result = await testPowerStep({
        target: { deviceId, ip: device.ipAddress, port },
        step: normalizedStep,
        phase
      });
      res.json({ ok: true, result });
    } catch (error) {
      powerLog.warn('Проверка шага не выполнена', { deviceId, error: error.message });
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  return router;
}