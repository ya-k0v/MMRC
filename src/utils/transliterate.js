/**
 * Транслитерация кириллицы в латиницу для безопасных имен файлов
 * @module utils/transliterate
 */

/**
 * Карта транслитерации русских букв
 */
const translitMap = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
  'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch',
  'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
  'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ё': 'Yo',
  'Ж': 'Zh', 'З': 'Z', 'И': 'I', 'Й': 'Y', 'К': 'K', 'Л': 'L', 'М': 'M',
  'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T', 'У': 'U',
  'Ф': 'F', 'Х': 'H', 'Ц': 'Ts', 'Ч': 'Ch', 'Ш': 'Sh', 'Щ': 'Sch',
  'Ъ': '', 'Ы': 'Y', 'Ь': '', 'Э': 'E', 'Ю': 'Yu', 'Я': 'Ya',
  // Украинские буквы
  'і': 'i', 'ї': 'yi', 'є': 'ye', 'ґ': 'g',
  'І': 'I', 'Ї': 'Yi', 'Є': 'Ye', 'Ґ': 'G',
  // Другие символы
  ' ': '_',
  '\u2014': '-',  // —
  '\u2013': '-',  // –
  '\u201C': '',   // "
  '\u201D': '',   // "
  '\u201E': '',   // „
  '\u2018': '',   // '
  '\u2019': '',   // '
  '\u00AB': '',   // «
  '\u00BB': ''    // »
};

/**
 * Транслитерация строки (кириллица → латиница)
 * @param {string} text - Исходный текст
 * @returns {string} Транслитерированный текст
 */
export function transliterate(text) {
  if (!text) return text;
  
  let result = '';
  for (const char of text) {
    result += translitMap[char] || char;
  }
  
  return result;
}

/**
 * Создать безопасное имя файла из оригинального
 * @param {string} filename - Оригинальное имя файла
 * @returns {string} Безопасное имя файла
 */
export function makeSafeFilename(filename) {
  if (!filename) return filename;
  
  // Разделяем имя и расширение
  const lastDotIndex = filename.lastIndexOf('.');
  let name = filename;
  let ext = '';
  
  if (lastDotIndex > 0) {
    name = filename.substring(0, lastDotIndex);
    ext = filename.substring(lastDotIndex); // Включая точку
  }
  
  // Транслитерируем имя (расширение оставляем как есть)
  let safeName = transliterate(name);
  
  // Заменяем небезопасные символы
  safeName = safeName
    .replace(/[^a-zA-Z0-9_\-\.\(\) ]/g, '_') // Оставляем только безопасные символы
    .replace(/\s+/g, '_') // Пробелы в подчеркивания
    .replace(/_+/g, '_') // Множественные подчеркивания в одно
    .replace(/^_+|_+$/g, ''); // Убираем подчеркивания в начале/конце
  
  // Если имя стало пустым, используем timestamp
  if (!safeName) {
    safeName = `file_${Date.now()}`;
  }
  
  return safeName + ext;
}

/**
 * Создать безопасное имя папки из оригинального
 * @param {string} folderName - Оригинальное имя папки
 * @returns {string} Безопасное имя папки
 */
export function makeSafeFolderName(folderName) {
  if (!folderName) return folderName;
  
  // Транслитерируем
  let safeName = transliterate(folderName);
  
  // Заменяем небезопасные символы
  safeName = safeName
    .replace(/[^a-zA-Z0-9_\-\(\) ]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  
  // Если имя стало пустым, используем timestamp
  if (!safeName) {
    safeName = `folder_${Date.now()}`;
  }
  
  return safeName;
}

