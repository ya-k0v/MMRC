import { Router } from 'express';
import { getAvailableModules, getEnabledModules, setModuleEnabled } from '../modules/index.js';
import logger from '../utils/logger.js';

export function createModulesRouter() {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const available = getAvailableModules();
      const enabled = await getEnabledModules();
      const enabledSet = new Set(enabled);

      const modules = available.map(m => ({
        ...m,
        enabled: enabledSet.has(m.id)
      }));

      res.json({ modules });
    } catch (err) {
      logger.error('[Modules] Failed to list modules:', err.message);
      res.status(500).json({ error: 'Failed to list modules' });
    }
  });

  router.post('/:id/toggle', async (req, res) => {
    try {
      const { id } = req.params;
      const { enabled } = req.body;

      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }

      const available = getAvailableModules();
      const mod = available.find(m => m.id === id);
      if (!mod) {
        return res.status(404).json({ error: `Module '${id}' not found` });
      }

      await setModuleEnabled(id, enabled);

      res.json({
        module: id,
        enabled,
        message: `Модуль "${mod.name}" ${enabled ? 'включён' : 'выключен'}. Для применения изменений перезапустите сервис.`
      });
    } catch (err) {
      logger.error('[Modules] Failed to toggle module:', err.message);
      res.status(500).json({ error: err.message || 'Failed to toggle module' });
    }
  });

  return router;
}
