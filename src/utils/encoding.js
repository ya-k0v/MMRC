/**
 * Утилиты для исправления кодировок файлов
 * @module utils/encoding
 */

// Символ замены U+FFFD означает, что байты НЕ были валидным UTF-8. Такой
// результат — не починка, а новый мусор: принимать его нельзя, даже если в
// строке уже появилась кириллица. Именно из-за такой неудачной декодировки
// «исправленные» имена раньше выглядели испорченными по-другому.
const REPLACEMENT = '\uFFFD';

// Результат декодирования принимаем только если он осмыслен: кириллица
// появилась, ничего не превратилось в символ замены, длина правдоподобна.
function isPlausibleCyrillic(decoded, original) {
  return typeof decoded === 'string'
    && decoded.length > 0
    && !decoded.includes(REPLACEMENT)
    && /[а-яё]/i.test(decoded)
    && decoded.length <= original.length * 2;
}

/**
 * Исправляет неправильную кодировку имени файла (latin1 → utf-8)
 * @param {string} str - Строка с возможно неправильной кодировкой
 * @returns {string} Исправленная строка
 */
export function fixEncoding(str) {
  if (!str || typeof str !== 'string') return str;

  // Если уже есть кириллица, ничего не делаем: строка либо корректна,
  // либо испорчена не полностью, и её нельзя починить повторным перебором.
  if (/[а-яё]/i.test(str)) return str;
  // Символы замены в исходной строке починить невозможно — байты потеряны.
  if (str.includes(REPLACEMENT)) return str;

  // Проверка на двойную кодировку
  const doubleEncodedPattern = /Ð[ÑÐµÐ·Ð½Ð°ÑÐ¸Ð¼Ð¸Ð´Ð¾Ñ]/;
  if (doubleEncodedPattern.test(str)) {
    try {
      const step1 = Buffer.from(str, 'latin1');
      const decoded = step1.toString('utf-8');
      if (isPlausibleCyrillic(decoded, str)) {
        return decoded;
      }
    } catch {}
  }

  // Попытка декодировать latin1 → utf-8
  try {
    const decoded = Buffer.from(str, 'latin1').toString('utf-8');
    if (isPlausibleCyrillic(decoded, str)) {
      return decoded;
    }
  } catch {}

  // Попытка декодировать URL-encoded строку
  if (str.includes('%')) {
    try {
      const decoded = decodeURIComponent(str);
      if (isPlausibleCyrillic(decoded, str)) return decoded;
    } catch {}
  }

  // Если ничего не помогло, возвращаем как есть
  return str;
}