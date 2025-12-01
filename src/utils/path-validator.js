/**
 * Path Validation - защита от Path Traversal атак
 * @module utils/path-validator
 */

import path from 'path';
import fs from 'fs';

/**
 * Валидация пути для защиты от path traversal
 * @param {string} userPath - Путь от пользователя
 * @param {string} baseDir - Базовая директория
 * @returns {string} Безопасный абсолютный путь
 * @throws {Error} Если path traversal обнаружен
 */
export function validatePath(userPath, baseDir) {
  // Резолвим в абсолютный путь
  const resolvedPath = path.resolve(baseDir, userPath);
  const normalizedBase = path.resolve(baseDir);
  
  // Проверяем что путь внутри baseDir
  if (!resolvedPath.startsWith(normalizedBase + path.sep) && resolvedPath !== normalizedBase) {
    throw new Error('Path traversal attempt detected');
  }
  
  return resolvedPath;
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

