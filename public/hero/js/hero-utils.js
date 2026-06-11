/**
 * Общие утилиты для панелей героев
 * Используется в hero.js и hero-admin.js
 */

/**
 * Экранирование HTML для предотвращения XSS
 */
export function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Нормализация строки для поиска: trim, нижний регистр, ё → е
 */
export function normalizeString(str) {
  if (!str) return '';
  // Приводим к строке, убираем пробелы, нижний регистр
  let normalized = String(str).trim().toLowerCase();
  // Заменяем ё на е (обе буквы приводятся к е)
  normalized = normalized.replace(/ё/g, 'е');
  return normalized;
}

/**
 * Форматирование биографии для книжного оформления: конвертация переносов строк в абзацы
 */
export function formatBiography(bio) {
  if (!bio) return '<em style="color:var(--muted);">Информация отсутствует</em>';
  
  // Если биография уже содержит HTML теги (например, <p>), оставляем как есть
  if (bio.includes('<p>') || bio.includes('<br>') || bio.includes('<div>')) {
    return bio;
  }
  
  // Экранируем HTML для безопасности
  const escaped = escapeHtml(bio);
  
  // Разбиваем на абзацы по двойным переносам строк или одиночным
  // Сначала по двойным переносам (пустые строки = новый абзац)
  const paragraphs = escaped
    .split(/\n\s*\n/) // Двойные переносы строк
    .map(p => p.trim())
    .filter(p => p.length > 0);
  
  // Если нет двойных переносов, разбиваем по одиночным
  if (paragraphs.length === 1) {
    const lines = escaped.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    return lines.map(line => `<p>${line}</p>`).join('');
  }
  
  // Форматируем каждый абзац в тег <p>
  return paragraphs.map(p => `<p>${p}</p>`).join('');
}

/**
 * Рендеринг миниатюры медиа
 */
export function renderMediaThumbnail(media, index) {
  return `
    <div class="media-thumbnail" data-index="${index}">
      ${
        media.type === 'photo'
          ? `<img src="${media.media_base64 || media.url}" alt="${escapeHtml(media.caption || '')}" loading="lazy"/>`
          : `<video src="${media.media_base64 || media.url}" preload="metadata"></video>`
      }
    </div>
  `;
}

/**
 * Безопасная установка innerHTML с санитизацией
 * Использует DOMParser для безопасного парсинга HTML
 * Примечание: вызывающий код должен экранировать пользовательские данные через escapeHtml
 */
export function setHTML(element, html) {
  if (!element) return;
  
  if (!html || typeof html !== 'string') {
    element.innerHTML = '';
    return;
  }
  
  // Используем DOMParser для безопасного парсинга HTML
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  
  // Очищаем элемент и добавляем содержимое через DocumentFragment
  const fragment = document.createDocumentFragment();
  const bodyNodes = doc.body.childNodes;
  for (let i = 0; i < bodyNodes.length; i++) {
    fragment.appendChild(bodyNodes[i].cloneNode(true));
  }
  
  element.replaceChildren(fragment);
}

/**
 * Создание элемента из HTML строки с использованием DOMParser для безопасности
 * Примечание: вызывающий код должен экранировать пользовательские данные через escapeHtml
 */
export function createElementFromHTML(htmlString) {
  if (!htmlString || typeof htmlString !== 'string') {
    return document.createElement('div');
  }
  
  // Используем DOMParser для безопасного парсинга HTML
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString.trim(), 'text/html');
  
  // Возвращаем первый элемент из body или создаем пустой div
  const firstElement = doc.body.firstElementChild;
  if (firstElement) {
    return firstElement;
  }
  
  // Если нет элементов, возвращаем контейнер с текстовым содержимым
  const container = document.createElement('div');
  if (doc.body.textContent) {
    container.textContent = doc.body.textContent;
  }
  return container;
}

/**
 * Debounce функция для оптимизации частых вызовов
 */
export function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(null, args), delay);
  };
}

/**
 * Безопасный fetch с обработкой ошибок
 */
export async function safeFetch(url, options = {}) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 секунд таймаут
    
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Превышено время ожидания ответа сервера');
    }
    throw error;
  }
}

/**
 * Fetch с автоматическим retry при сетевых ошибках
 * @param {Function} fetchFn - Функция для выполнения запроса (должна возвращать Promise)
 * @param {Object} options - Опции retry
 * @param {number} options.maxRetries - Максимальное количество попыток (по умолчанию 3)
 * @param {number} options.initialDelay - Начальная задержка в мс (по умолчанию 1000)
 * @param {number} options.maxDelay - Максимальная задержка в мс (по умолчанию 10000)
 * @param {Function} options.shouldRetry - Функция для определения, нужно ли повторять запрос (по умолчанию для сетевых ошибок)
 */
export async function fetchWithRetry(fetchFn, options = {}) {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    shouldRetry = (error) => {
      // Повторяем для сетевых ошибок и 5xx ошибок сервера
      return error.name === 'TypeError' || 
             error.name === 'NetworkError' ||
             (error.message && error.message.includes('Failed to fetch')) ||
             (error.status >= 500 && error.status < 600);
    }
  } = options;
  
  let lastError;
  let delay = initialDelay;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchFn();
    } catch (error) {
      lastError = error;
      
      // Если это последняя попытка или ошибка не требует retry, выбрасываем ошибку
      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }
      
      // Экспоненциальная задержка с jitter
      const jitter = Math.random() * 0.3 * delay; // Добавляем случайность до 30%
      const currentDelay = Math.min(delay + jitter, maxDelay);
      
      await new Promise(resolve => setTimeout(resolve, currentDelay));
      
      // Увеличиваем задержку для следующей попытки
      delay = Math.min(delay * 2, maxDelay);
    }
  }
  
  throw lastError;
}

/**
 * Показ состояния загрузки
 */
export function showLoadingState(container, message = 'Загрузка...') {
  if (!container) return;
  setHTML(container, `
    <div class="hero-loading-state" style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 40px; color: var(--muted);">
      <div class="loading-spinner" style="width: 48px; height: 48px; border: 4px solid rgba(255,255,255,0.1); border-top-color: var(--brand, #3b82f6); border-radius: 50%; animation: spin 1s linear infinite;"></div>
      <p style="margin: 0; font-size: 1rem;">${escapeHtml(message)}</p>
    </div>
  `);
}

/**
 * Показ состояния ошибки
 */
export function showErrorState(container, message = 'Произошла ошибка', retryCallback = null) {
  if (!container) return;
  const retryButton = retryCallback 
    ? `<button class="primary" style="margin-top: 16px;" onclick="(${retryCallback.toString()})()">Повторить</button>`
    : '';
  setHTML(container, `
    <div class="hero-error-state" style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 40px; color: var(--danger, #ef4444); text-align: center;">
      <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      <p style="margin: 0; font-size: 1rem;">${escapeHtml(message)}</p>
      ${retryButton}
    </div>
  `);
}

/**
 * Конфигурация лимитов для файлов
 */
export const FILE_LIMITS = {
  PHOTO_MAX_SIZE: 10 * 1024 * 1024, // 10MB
  VIDEO_MAX_SIZE: 200 * 1024 * 1024, // 200MB
  BASE64_OVERHEAD: 1.33, // Base64 увеличивает размер примерно на 33%
};

/**
 * Magic bytes (сигнатуры) для валидации типов файлов
 */
const FILE_SIGNATURES = {
  // Изображения
  'image/jpeg': [
    [0xFF, 0xD8, 0xFF],
  ],
  'image/png': [
    [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
  ],
  'image/gif': [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // GIF87a
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a
  ],
  'image/webp': [
    [0x52, 0x49, 0x46, 0x46], // RIFF
  ],
  // Видео
  'video/mp4': [
    [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70], // ftyp box
    [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], // ftyp box variant
  ],
  'video/webm': [
    [0x1A, 0x45, 0xDF, 0xA3], // EBML header
  ],
};

/**
 * Проверка magic bytes файла
 */
async function checkFileSignature(file, expectedMimeType) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const arrayBuffer = e.target.result;
      const bytes = new Uint8Array(arrayBuffer);
      const signatures = FILE_SIGNATURES[expectedMimeType];
      
      if (!signatures) {
        // Если нет сигнатуры для типа, разрешаем (fallback на проверку file.type)
        resolve(true);
        return;
      }
      
      // Проверяем каждую возможную сигнатуру
      for (const signature of signatures) {
        let matches = true;
        for (let i = 0; i < signature.length && i < bytes.length; i++) {
          if (bytes[i] !== signature[i]) {
            matches = false;
            break;
          }
        }
        if (matches) {
          resolve(true);
          return;
        }
      }
      
      resolve(false);
    };
    reader.onerror = () => resolve(false);
    // Читаем только первые 12 байт для проверки сигнатуры
    reader.readAsArrayBuffer(file.slice(0, 12));
  });
}

/**
 * Валидация типа файла по MIME и magic bytes
 */
export async function validateFileType(file, expectedType) {
  if (!file || !file.type) {
    return { valid: false, error: 'Файл не определен' };
  }
  
  const isImage = expectedType === 'image';
  const isVideo = expectedType === 'video';
  
  // Проверка MIME типа
  if (isImage && !file.type.startsWith('image/')) {
    return { valid: false, error: 'Файл не является изображением' };
  }
  if (isVideo && !file.type.startsWith('video/')) {
    return { valid: false, error: 'Файл не является видео' };
  }
  
  // Проверка magic bytes для критичных типов
  const criticalTypes = ['image/jpeg', 'image/png', 'image/gif', 'video/mp4'];
  if (criticalTypes.includes(file.type)) {
    const signatureValid = await checkFileSignature(file, file.type);
    if (!signatureValid) {
      return { valid: false, error: `Файл не соответствует заявленному типу ${file.type}` };
    }
  }
  
  return { valid: true };
}

/**
 * Валидация размера файла и base64
 */
export function validateFileSize(file, isVideo = false) {
  const maxSize = isVideo ? FILE_LIMITS.VIDEO_MAX_SIZE : FILE_LIMITS.PHOTO_MAX_SIZE;
  
  if (file.size > maxSize) {
    const maxSizeMB = (maxSize / (1024 * 1024)).toFixed(0);
    return {
      valid: false,
      error: `Файл слишком большой (максимум ${maxSizeMB}MB)`
    };
  }
  
  // Проверяем размер base64 (примерно на 33% больше)
  const estimatedBase64Size = file.size * FILE_LIMITS.BASE64_OVERHEAD;
  if (estimatedBase64Size > maxSize * 1.5) {
    return {
      valid: false,
      error: 'Файл слишком большой для конвертации в base64'
    };
  }
  
  return { valid: true };
}

/**
 * Добавление CSS анимации для спиннера (если еще не добавлена)
 */
if (!document.getElementById('hero-loading-spinner-style')) {
  const style = document.createElement('style');
  style.id = 'hero-loading-spinner-style';
  style.textContent = `
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
}

