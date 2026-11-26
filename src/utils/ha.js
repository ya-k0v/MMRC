/**
 * Признак HA-реплики. Реплики читают общие БД/хранилище, но не должны
 * выполнять фоновую работу, которая меняет общие данные или temp-каталог:
 * коммит локальных файлов, очистку scratch, периодические отчёты/уведомления.
 *
 * @param {NodeJS.ProcessEnv|object} env
 * @returns {boolean}
 */
export function isHaReplica(env = process.env) {
  return String(env.MMRC_HA_MODE || '').trim().toLowerCase() === 'true';
}
