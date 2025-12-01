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
 * Использует DocumentFragment для лучшей производительности
 */
export function setHTML(element, html) {
  if (!element) return;
  
  // Создаем временный контейнер для парсинга HTML
  const temp = document.createElement('div');
  temp.innerHTML = html;
  
  // Очищаем элемент и добавляем содержимое через DocumentFragment
  const fragment = document.createDocumentFragment();
  while (temp.firstChild) {
    fragment.appendChild(temp.firstChild);
  }
  
  element.replaceChildren(fragment);
}

/**
 * Создание элемента из HTML строки с использованием DocumentFragment
 */
export function createElementFromHTML(htmlString) {
  const temp = document.createElement('div');
  temp.innerHTML = htmlString.trim();
  return temp.firstElementChild || temp;
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

