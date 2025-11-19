// Общие утилиты для admin и speaker панелей

// Функция для получения приоритета символа при сортировке
// Порядок: русские буквы (А-Я) -> латинские буквы (A-Z) -> цифры (0-9)
export function getCharPriority(char) {
  const code = char.charCodeAt(0);
  // Русские буквы: А-Я (1040-1071), а-я (1072-1103)
  if ((code >= 1040 && code <= 1103) || (code >= 1072 && code <= 1103)) {
    // Нормализуем к верхнему регистру для сравнения
    const upper = char.toUpperCase();
    const upperCode = upper.charCodeAt(0);
    return 1000 + (upperCode - 1040); // А = 1000, Я = 1063
  }
  // Латинские буквы: A-Z (65-90), a-z (97-122)
  if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
    return 2000 + (char.toUpperCase().charCodeAt(0) - 65); // A = 2000, Z = 2025
  }
  // Цифры: 0-9 (48-57)
  if (code >= 48 && code <= 57) {
    return 3000 + (code - 48); // 0 = 3000, 9 = 3009
  }
  // Остальные символы идут в конец
  return 4000 + code;
}

// Функция для получения приоритета строки (по первому символу)
export function getStringPriority(str) {
  if (!str || str.length === 0) return 5000;
  const firstChar = str[0];
  return getCharPriority(firstChar);
}

// Функция проверки, начинается ли строка с цифры
function startsWithDigit(str) {
  if (!str || str.length === 0) return false;
  const firstChar = str[0];
  const code = firstChar.charCodeAt(0);
  return code >= 48 && code <= 57; // Цифры 0-9
}

// Функция сортировки устройств: сначала элементы с цифрами, потом без цифр, внутри каждой группы - по алфавиту
export function sortDevices(devices, nodeNames = {}) {
  return [...devices].sort((a, b) => {
    const nameA = (a.name || nodeNames[a.device_id] || a.device_id).trim();
    const nameB = (b.name || nodeNames[b.device_id] || b.device_id).trim();
    
    // Проверяем, начинается ли имя с цифры
    const aStartsWithDigit = startsWithDigit(nameA);
    const bStartsWithDigit = startsWithDigit(nameB);
    
    // Сначала идут элементы с цифрами (aStartsWithDigit = true имеет приоритет 0)
    // Потом элементы без цифр (aStartsWithDigit = false имеет приоритет 1)
    if (aStartsWithDigit !== bStartsWithDigit) {
      return aStartsWithDigit ? -1 : 1; // Элементы с цифрами идут первыми
    }
    
    // Если обе строки начинаются с цифр или обе не начинаются с цифр - сортируем по алфавиту
    // Для правильной сортировки используем localeCompare с русской локалью и numeric: true
    return nameA.localeCompare(nameB, 'ru', { numeric: true, sensitivity: 'base' });
  });
}

// Утилита-дебаунс для сглаживания частых обновлений
export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { 
    clearTimeout(t); 
    t = setTimeout(() => fn(...a), ms); 
  };
}

// Динамический расчет размера страницы по высоте экрана
// Рассчитывает сколько элементов влезает на страницу
// @param {number|string} itemHeight - Опциональная высота элемента в пикселях или тип элемента ('device'|'file')
export function getPageSize(itemHeight = null) {
  try {
    let ITEM_HEIGHT;
    
    if (typeof itemHeight === 'number') {
      // Если передана конкретная высота
      ITEM_HEIGHT = itemHeight;
    } else if (itemHeight === 'file') {
      // Для файлов используем меньшую высоту (60px + gap 6px)
      // Gap уменьшен на 2px для компактности в панели спикера
      ITEM_HEIGHT = 60 + 6; // Высота файла 60px + gap 6px в панели спикера
    } else {
      // По умолчанию используем высоту устройств из CSS переменной
      const rootStyles = getComputedStyle(document.documentElement);
      const itemMinHeight = parseInt(rootStyles.getPropertyValue('--item-min-height')) || 100;
      const itemGap = parseInt(rootStyles.getPropertyValue('--item-gap')) || 8;
      ITEM_HEIGHT = itemMinHeight + itemGap;
    }
    
    // Получаем высоту видимой области
    const viewportHeight = window.innerHeight;
    
    // Вычитаем высоту header/toolbar, header панели, отступы и пагинации
    // Оставляем запас для комфортного отображения без скролла
    const HEADER_HEIGHT = 80; // Верхний toolbar
    const PANEL_HEADER_HEIGHT = itemHeight === 'file' ? 50 : 50; // Header панели файлов/устройств
    const PANEL_HEADER_MARGIN = 8; // margin-bottom header
    const PANEL_GAP = itemHeight === 'file' ? 12 : 12; // gap между header и списком, и между списком и пагинацией
    const PAGINATION_HEIGHT = 40; // Высота пагинации
    const PADDING = 16; // Внешние отступы
    
    const availableHeight = viewportHeight 
      - HEADER_HEIGHT 
      - PANEL_HEADER_HEIGHT 
      - PANEL_HEADER_MARGIN 
      - (PANEL_GAP * 2) // gap сверху и снизу списка
      - PAGINATION_HEIGHT 
      - PADDING;
    
    // Рассчитываем сколько элементов влезает (используем Math.floor для консервативного расчета)
    const itemsPerPage = Math.floor(availableHeight / ITEM_HEIGHT);
    
    // Минимум 3 элемента, максимум 20
    const result = Math.max(3, Math.min(20, itemsPerPage));
    
    return result;
  } catch (e) {
    // Fallback на статическое значение при ошибке
    return window.innerWidth < 1024 ? 10 : 5;
  }
}

// Загрузка маппинга имен устройств из API
export async function loadNodeNames() {
  try {
    const res = await fetch('/api/devices');
    const devices = await res.json();
    
    // Преобразуем массив устройств в маппинг {device_id: name}
    const nodeNames = {};
    for (const device of devices) {
      if (device.name) {
        nodeNames[device.device_id] = device.name;
      }
    }
    
    return nodeNames;
  } catch (e) {
    return {};
  }
}

