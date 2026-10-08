/**
 * Уровни серьёзности уведомлений: единая расшифровка для списка и тостов.
 *
 * Возвращает ключ для CSS-модификатора (`is-critical` и т.п.), человеческую
 * подпись для бейджа и SVG-иконку. Цвет по ключу задаётся в CSS — так список
 * и тосты не расходятся, а разметка не таскает за собой hex-константы.
 *
 * @module shared/severity
 */

import { getBellIcon, getInfoIcon, getCriticalIcon, getWarningIcon } from './svg-icons.js';

const SEVERITY_LEVELS = {
  critical: { key: 'critical', label: 'Критично', icon: (size) => getCriticalIcon(size) },
  warning: { key: 'warning', label: 'Внимание', icon: (size) => getWarningIcon(size) },
  info: { key: 'info', label: 'Инфо', icon: (size) => getInfoIcon(size) }
};

/**
 * Расшифровать уровень серьёзности уведомления.
 * @param {string} [severity] - critical | warning | info | default | ...
 * @param {number} [iconSize] - Размер иконки в px
 * @returns {{key: string, label: string, icon: string, severity: string}}
 */
export function getSeverityInfo(severity, iconSize = 18) {
  const level = SEVERITY_LEVELS[severity];
  if (level) {
    return { key: level.key, label: level.label, icon: level.icon(iconSize), severity };
  }
  return { key: 'default', label: 'Событие', icon: getBellIcon(iconSize), severity };
}