/**
 * Утилиты для исправления кодировок файлов
 * @module utils/encoding
 */

/**
 * Исправляет неправильную кодировку имени файла (latin1 → utf-8)
 * @param {string} str - Строка с возможно неправильной кодировкой
 * @returns {string} Исправленная строка
 */
export function fixEncoding(str) {
  if (!str || typeof str !== 'string') return str;
  
  // Если уже есть кириллица, ничего не делаем
  if (/[а-яё]/i.test(str)) return str;
  
  // Проверка на двойную кодировку
  const doubleEncodedPattern = /Ð[ÑÐµÐ·Ð½ÑÐ°ÑÐ¸Ð¼Ð¸Ð´Ð¾Ñ]/;
  if (doubleEncodedPattern.test(str)) {
    try {
      const step1 = Buffer.from(str, 'latin1');
      const decoded = step1.toString('utf-8');
      if (/[а-яё]/i.test(decoded) && decoded.length > 0 && decoded.length <= str.length * 2) {
        return decoded;
      }
    } catch {}
  }
  
  // Попытка декодировать latin1 → utf-8
  try {
    const decoded = Buffer.from(str, 'latin1').toString('utf-8');
    if (/[а-яё]/i.test(decoded) && decoded.length > 0 && decoded.length <= str.length * 2) {
      return decoded;
    }
  } catch {}
  
  // Попытка декодировать URL-encoded строку
  if (str.includes('%')) {
    try {
      const decoded = decodeURIComponent(str);
      if (/[а-яё]/i.test(decoded)) return decoded;
    } catch {}
  }
  
  // Если ничего не помогло, возвращаем как есть
  return str;
}

