/**
 * Path Validation - защита от Path Traversal атак
 * @module utils/path-validator
 */

import path from 'node:path';
import fs from 'node:fs';

/**
 * Валидация пути для защиты от path traversal
 * @param {string} userPath - Путь от пользователя
 * @param {string} baseDir - Базовая директория
 * @returns {string} Безопасный абсолютный путь
 * @throws {Error} Если path traversal обнаружен
 */
export function validatePath(userPath, baseDir) {
  const normalizedBase = path.resolve(String(baseDir || ''));
  if (!normalizedBase) {
    throw new Error('Invalid base directory');
  }

  // Канонизируем базовую директорию (если существует), чтобы исключить обход через symlink
  const canonicalBase = fs.existsSync(normalizedBase)
    ? fs.realpathSync.native(normalizedBase)
    : normalizedBase;

  // userPath может быть как относительным, так и абсолютным
  const requestedPath = path.resolve(canonicalBase, String(userPath || ''));

  // Канонизируем целевой путь: если не существует, канонизируем ближайшего существующего родителя
  let canonicalTarget;
  if (fs.existsSync(requestedPath)) {
    canonicalTarget = fs.realpathSync.native(requestedPath);
  } else {
    let parent = path.dirname(requestedPath);
    while (parent !== path.dirname(parent) && !fs.existsSync(parent)) {
      parent = path.dirname(parent);
    }

    const canonicalParent = fs.existsSync(parent)
      ? fs.realpathSync.native(parent)
      : canonicalBase;

    canonicalTarget = path.resolve(canonicalParent, path.basename(requestedPath));
  }

  if (!canonicalTarget.startsWith(canonicalBase + path.sep) && canonicalTarget !== canonicalBase) {
    throw new Error('Path traversal attempt detected');
  }

  return canonicalTarget;
}

/**
 * Безопасное чтение файла
 * @param {string} userPath - Путь от пользователя
 * @param {string} baseDir - Базовая директория
 * @returns {Promise<Buffer>} Содержимое файла
 */
export async function safeReadFile(userPath, baseDir) {
  const safePath = validatePath(userPath, baseDir);
  
  if (!fs.existsSync(safePath)) {
    throw new Error('File not found');
  }
  
  const stats = fs.statSync(safePath);
  if (!stats.isFile()) {
    throw new Error('Path is not a file');
  }
  
  return fs.promises.readFile(safePath);
}

/**
 * Безопасное удаление файла/папки
 * @param {string} userPath - Путь от пользователя
 * @param {string} baseDir - Базовая директория
 * @returns {Promise<void>}
 */
export async function safeDelete(userPath, baseDir) {
  const safePath = validatePath(userPath, baseDir);
  
  if (!fs.existsSync(safePath)) {
    throw new Error('Path not found');
  }
  
  return fs.promises.rm(safePath, { recursive: true, force: true });
}

/**
 * Безопасное переименование
 * @param {string} oldPath - Старый путь
 * @param {string} newPath - Новый путь
 * @param {string} baseDir - Базовая директория
 * @returns {Promise<void>}
 */
export async function safeRename(oldPath, newPath, baseDir) {
  const safeOldPath = validatePath(oldPath, baseDir);
  const safeNewPath = validatePath(newPath, baseDir);
  
  if (!fs.existsSync(safeOldPath)) {
    throw new Error('Source path not found');
  }
  
  if (fs.existsSync(safeNewPath)) {
    throw new Error('Destination path already exists');
  }
  
  return fs.promises.rename(safeOldPath, safeNewPath);
}

/**
 * Проверка существования пути (безопасная)
 * @param {string} userPath - Путь от пользователя
 * @param {string} baseDir - Базовая директория
 * @returns {boolean}
 */
export function safeExists(userPath, baseDir) {
  try {
    const safePath = validatePath(userPath, baseDir);
    return fs.existsSync(safePath);
  } catch (e) {
    return false;
  }
}

