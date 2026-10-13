/**
 * Единая точка правды: «устройство спит или активно».
 *
 * Разные прошивки по-разному сообщают о сне. Набор маркеров `dumpsys power`
 * отличается, а часть панелей (Fake Standby у Lumien) держит OS в состоянии
 * Awake и гасит только подсветку — по одному `mWakefulness` такой экран
 * выглядел бы «активным». Поэтому решение разрешается в одном месте, а не
 * размножается по воркеру опроса, командам питания и тесту ступени.
 *
 * Стратегия берётся из профиля питания (поле «источник статуса»), чтобы
 * админ мог подобрать её под модель и версию Android:
 *  - `auto` — экранный маркер, если он есть, иначе `mWakefulness` (по умолчанию);
 *  - `display` — только экран: гашение дисплея (`cmd:display power-off`) = «спит»;
 *  - `wakefulness` — только `mWakefulness`.
 *
 * Сырые маркеры экрана уже сведены в одно значение `screenOn` в
 * `adb.parsePowerState` (mHoldingDisplay → Display Power: state → mScreenOn →
 * mScreenState). Здесь остаётся только выбрать, какому сигналу доверять.
 *
 * @module utils/power-state
 */

export const SLEEP_DETECT_STRATEGIES = ['auto', 'display', 'wakefulness', 'custom'];
export const DEFAULT_SLEEP_DETECT = 'auto';

/** Привести значение стратегии к допустимому (по умолчанию `auto`). */
export function normalizeSleepDetect(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return SLEEP_DETECT_STRATEGIES.includes(normalized) ? normalized : DEFAULT_SLEEP_DETECT;
}

/**
 * Свести сырое состояние `dumpsys power` к одному значению «активен».
 *
 * @param {{awake?: boolean|null, screenOn?: boolean|null}|null} state
 * @param {string} [strategy] `auto` | `display` | `wakefulness`
 * @returns {boolean|null} true — активен, false — спит, null — определить нельзя
 */
export function resolveAwakeState(state, strategy = DEFAULT_SLEEP_DETECT) {
  if (!state) return null;
  const mode = normalizeSleepDetect(strategy);
  const screenOn = state.screenOn === null || state.screenOn === undefined ? null : Boolean(state.screenOn);
  const awake = state.awake === null || state.awake === undefined ? null : Boolean(state.awake);

  if (mode === 'display') return screenOn;
  if (mode === 'wakefulness') return awake;
  // strategy === 'custom' резолвится отдельно, по выводу команды профиля.
  if (mode === 'custom') return null;
  // auto: экранный маркер приоритетнее — гашение дисплея и Fake Standby
  // (OS бодрствует, подсветка выключена) должны считаться сном.
  return screenOn !== null ? screenOn : awake;
}

/**
 * Проверить, означает ли вывод команды определения состояния «спит».
 *
 * Используется стратегией `custom`, когда штатный `dumpsys power` не отражает
 * сон (например, панель гасит экран своим OffScreenActivity, а состояние лежит
 * в системном свойстве `sys.power.screen_off`).
 *
 * @param {string} output Вывод ADB-команды
 * @param {string} match Подстрока, наличие которой означает «спит»
 * @returns {boolean}
 */
export function matchesSleepOutput(output, match) {
  const needle = String(match || '').trim();
  if (!needle) return false;
  return String(output || '').toLowerCase().includes(needle.toLowerCase());
}
