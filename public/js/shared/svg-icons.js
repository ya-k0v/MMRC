/**
 * SVG иконки для замены эмодзи
 * @module shared/svg-icons
 */

/**
 * Получить SVG иконку Android устройства
 * @param {number} size - Размер иконки (по умолчанию 20)
 * @param {string} color - Цвет заливки (по умолчанию #A4C639)
 * @returns {string} SVG код
 */
export function getAndroidIcon(size = 20, color = '#A4C639') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024" style="display:inline-block;vertical-align:middle;margin-right:4px;">
  <g fill="${color}">
    <rect x="408" y="78" width="26" height="120" rx="13" transform="rotate(-25 421 138)"/>
    <rect x="590" y="78" width="26" height="120" rx="13" transform="rotate(25 603 138)"/>
    <path
      fill="${color}"
      fill-rule="evenodd"
      d="M256 386 A256 256 0 0 1 768 386 L256 386 Z M400 250 m -40 0 a 40 40 0 1 0 80 0 a 40 40 0 1 0 -80 0 M624 250 m -40 0 a 40 40 0 1 0 80 0 a 40 40 0 1 0 -80 0"
    />
    <rect x="256" y="386" width="512" height="26" fill="none"/>
    <rect x="224" y="412" width="576" height="456" rx="60"/>
    <rect x="100" y="420" width="112" height="360" rx="56"/>
    <rect x="812" y="420" width="112" height="360" rx="56"/>
    <rect x="340" y="800" width="128" height="180" rx="64"/>
    <rect x="556" y="800" width="128" height="180" rx="64"/>
  </g>
</svg>`;
}

export function getVolumeMutedIcon(size = 18, color = 'currentColor') {
  return `<svg class="volume-icon-svg" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 15H8.5L13 19V5L8.5 9H5V15Z"></path>
    <path d="M16 9L20 15"></path>
    <path d="M20 9L16 15"></path>
  </svg>`;
}

export function getVolumeOnIcon(size = 18, color = 'currentColor') {
  return `<svg class="volume-icon-svg" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 15H8.5L13 19V5L8.5 9H5V15Z"></path>
    <path d="M17 9C18.2 10.2 18.2 13.8 17 15"></path>
    <path d="M19.5 6.5C22 9 22 15 19.5 17.5"></path>
  </svg>`;
}

export function getVolumeUnknownIcon(size = 18, color = 'currentColor') {
  return `<svg class="volume-icon-svg" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 15H8.5L13 19V5L8.5 9H5V15Z"></path>
    <circle cx="18" cy="12" r="1.5" fill="${color}" stroke="none"></circle>
  </svg>`;
}

/**
 * Получить SVG иконку галочки (готов)
 * @param {number} size - Размер иконки (по умолчанию 16)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getCheckIcon(size = 16, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:4px;">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>`;
}

/**
 * Получить SVG иконку крестика (не готов/ошибка)
 * @param {number} size - Размер иконки (по умолчанию 16)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getCrossIcon(size = 16, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:4px;">
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </svg>`;
}

/**
 * Получить SVG иконку телевизора
 * @param {number} size - Размер иконки (по умолчанию 20)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getTVIcon(size = 20, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:4px;">
    <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
    <polyline points="17 2 12 7 7 2"></polyline>
  </svg>`;
}

/**
 * Получить SVG иконку браузера/глобуса
 * @param {number} size - Размер иконки (по умолчанию 20)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getBrowserIcon(size = 20, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:4px;">
    <circle cx="12" cy="12" r="10"></circle>
    <line x1="2" y1="12" x2="22" y2="12"></line>
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
  </svg>`;
}

/**
 * Получить SVG иконку монитора/компьютера
 * @param {number} size - Размер иконки (по умолчанию 20)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getMonitorIcon(size = 20, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:4px;">
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
    <line x1="8" y1="21" x2="16" y2="21"></line>
    <line x1="12" y1="17" x2="12" y2="21"></line>
  </svg>`;
}

/**
 * Получить SVG иконку фильма/камеры
 * @param {number} size - Размер иконки (по умолчанию 20)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getFilmIcon(size = 20, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:4px;">
    <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect>
    <line x1="7" y1="2" x2="7" y2="22"></line>
    <line x1="17" y1="2" x2="17" y2="22"></line>
    <line x1="2" y1="12" x2="22" y2="12"></line>
    <line x1="2" y1="7" x2="7" y2="7"></line>
    <line x1="2" y1="17" x2="7" y2="17"></line>
    <line x1="17" y1="17" x2="22" y2="17"></line>
    <line x1="17" y1="7" x2="22" y2="7"></line>
  </svg>`;
}

/**
 * Получить SVG иконку часов/обработки
 * @param {number} size - Размер иконки (по умолчанию 16)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getClockIcon(size = 16, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:4px;">
    <circle cx="12" cy="12" r="10"></circle>
    <polyline points="12 6 12 12 16 14"></polyline>
  </svg>`;
}

/**
 * Получить SVG иконку файла
 * @param {number} size - Размер иконки (по умолчанию 16)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getFileIcon(size = 16, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:4px;">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
    <line x1="16" y1="13" x2="8" y2="13"></line>
    <line x1="16" y1="17" x2="8" y2="17"></line>
    <polyline points="10 9 9 9 8 9"></polyline>
  </svg>`;
}

/**
 * Получить SVG иконку папки
 * @param {number} size - Размер иконки (по умолчанию 16)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getFolderIcon(size = 16, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:4px;">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
  </svg>`;
}

/**
 * Получить SVG иконку предупреждения
 * @param {number} size - Размер иконки (по умолчанию 20)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getWarningIcon(size = 20, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:4px;">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
    <line x1="12" y1="9" x2="12" y2="13"></line>
    <line x1="12" y1="17" x2="12.01" y2="17"></line>
  </svg>`;
}

/**
 * Получить SVG иконку крестика закрытия (X)
 * @param {number} size - Размер иконки (по умолчанию 16)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getCloseIcon(size = 16, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;">
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </svg>`;
}

/**
 * Получить SVG иконку пользователей
 * @param {number} size - Размер иконки (по умолчанию 20)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getUsersIcon(size = 20, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:4px;">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
    <circle cx="9" cy="7" r="4"></circle>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
  </svg>`;
}

/**
 * Получить SVG иконку ключа
 * @param {number} size - Размер иконки (по умолчанию 16)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getKeyIcon(size = 16, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;">
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path>
  </svg>`;
}

/**
 * Получить SVG иконку замка (закрытый)
 * @param {number} size - Размер иконки (по умолчанию 16)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getLockIcon(size = 16, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
  </svg>`;
}

/**
 * Получить SVG иконку замка (открытый)
 * @param {number} size - Размер иконки (по умолчанию 16)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getUnlockIcon(size = 16, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
    <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
  </svg>`;
}

/**
 * Получить SVG иконку корзины
 * @param {number} size - Размер иконки (по умолчанию 16)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getTrashIcon(size = 16, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;">
    <polyline points="3 6 5 6 21 6"></polyline>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
    <line x1="10" y1="11" x2="10" y2="17"></line>
    <line x1="14" y1="11" x2="14" y2="17"></line>
  </svg>`;
}

/**
 * Получить SVG иконку булавки (pin)
 * @param {number} size - Размер иконки (по умолчанию 16)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
 

/**
 * Получить SVG иконку успеха (галочка в круге)
 * @param {number} size - Размер иконки (по умолчанию 16)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getSuccessIcon(size = 16, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:4px;">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
    <polyline points="22 4 12 14.01 9 11.01"></polyline>
  </svg>`;
}

/**
 * Получить SVG иконку скачивания
 * @param {number} size - Размер иконки (по умолчанию 16)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getDownloadIcon(size = 16, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:4px;">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
    <polyline points="7 10 12 15 17 10"></polyline>
    <line x1="12" y1="15" x2="12" y2="3"></line>
  </svg>`;
}

/**
 * Получить SVG иконку настроек
 * @param {number} size - Размер иконки (по умолчанию 20)
 * @param {string} color - Цвет (по умолчанию currentColor)
 * @returns {string} SVG код
 */
export function getSettingsIcon(size = 20, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;">
  <circle cx="12" cy="12" r="3"/>
  <path d="M19.4 12.94a7.8 7.8 0 0 0 0-1.88l2-1.55a.5.5 0 0 0 .12-.64l-1.9-3.3a.5.5 0 0 0-.6-.22l-2.35.95a7.9 7.9 0 0 0-1.62-.94l-.35-2.5A.5.5 0 0 0 14.2 2h-4.4a.5.5 0 0 0-.5.42l-.35 2.5a7.8 7.8 0 0 0-1.62.94L5 5.35a.5.5 0 0 0-.6.22l-1.9 3.3a.5.5 0 0 0 .12.64l2 1.55c-.08.62-.08 1.26 0 1.88l-2 1.55a.5.5 0 0 0-.12.64l1.9 3.3a.5.5 0 0 0 .6.22l2.35-.95c.5.39 1.05.71 1.62.94l.35 2.5a.5.5 0 0 0 .5.42h4.4a.5.5 0 0 0 .5-.42l.35-2.5c.57-.23 1.12-.55 1.62-.94l2.35.95a.5.5 0 0 0 .6-.22l1.9-3.3a.5.5 0 0 0-.12-.64l-2-1.55z"/>
  </svg>`;
}

