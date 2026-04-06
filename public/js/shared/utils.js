/**
 * Shared utility helpers
 */

/**
 * Escapes HTML special characters to prevent XSS.
 * @param {string | number | boolean | null | undefined} value
 * @returns {string}
 */
export function escapeHtml(value = '') {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


