/**
 * System Monitor Module
 * Отображает состояние сервера: CPU, RAM, Disk
 */

let systemInfoInterval = null;
let fetchFunction = null;

/**
 * Инициализация системного монитора
 * @param {Function} adminFetch - функция для выполнения запросов
 * @param {HTMLElement} container - опциональный контейнер для рендеринга (если не указан, используется systemMonitorContainer)
 */
export function initSystemMonitor(adminFetch, container = null) {
  fetchFunction = adminFetch;
  
  // Создаем UI для системной информации
  createSystemMonitorUI(container);
  
  // Загружаем данные сразу
  loadSystemInfo();
  
  // Обновляем каждые 5 секунд
  if (systemInfoInterval) {
    clearInterval(systemInfoInterval);
  }
  systemInfoInterval = setInterval(loadSystemInfo, 5000);
}

/**
 * Получить HTML для системного монитора
 */
export function getSystemMonitorHTML() {
  return `
    <div id="system-monitor" class="system-monitor">
      <div class="system-stat" id="cpu-stat" title="Загрузка процессора">
        <span class="stat-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="4" width="16" height="16" rx="2" ry="2"/>
            <rect x="9" y="9" width="6" height="6"/>
            <line x1="9" y1="1" x2="9" y2="4"/>
            <line x1="15" y1="1" x2="15" y2="4"/>
            <line x1="9" y1="20" x2="9" y2="23"/>
            <line x1="15" y1="20" x2="15" y2="23"/>
          </svg>
        </span>
        <span class="stat-value" id="cpu-value">--</span>
        <div class="stat-bar">
          <div class="stat-bar-fill" id="cpu-bar"></div>
        </div>
      </div>
      
      <div class="system-stat" id="ram-stat" title="Использование оперативной памяти">
        <span class="stat-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <line x1="9" y1="3" x2="9" y2="21"/>
            <line x1="15" y1="3" x2="15" y2="21"/>
            <line x1="3" y1="9" x2="21" y2="9"/>
            <line x1="3" y1="15" x2="21" y2="15"/>
          </svg>
        </span>
        <span class="stat-value" id="ram-value">--</span>
        <div class="stat-bar">
          <div class="stat-bar-fill" id="ram-bar"></div>
        </div>
      </div>
      
      <div class="system-stat" id="disk-stat" title="Свободное место на диске">
        <span class="stat-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="5" width="18" height="14" rx="2" ry="2"/>
            <rect x="3" y="9" width="18" height="2" opacity="0.6"/>
            <rect x="3" y="13" width="18" height="2" opacity="0.6"/>
            <rect x="3" y="17" width="18" height="2" opacity="0.6"/>
            <line x1="8" y1="5" x2="8" y2="19"/>
            <line x1="16" y1="5" x2="16" y2="19"/>
          </svg>
        </span>
        <span class="stat-value" id="disk-value">--</span>
        <div class="stat-bar">
          <div class="stat-bar-fill" id="disk-bar"></div>
        </div>
      </div>
      
      <div class="system-stat" id="uptime-stat" title="Время работы сервера">
        <span class="stat-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
        </span>
        <span class="stat-value" id="uptime-value">--</span>
      </div>
    </div>
  `;
}

/**
 * Создать UI для системного монитора
 * @param {HTMLElement} container - опциональный контейнер для рендеринга
 */
function createSystemMonitorUI(container = null) {
  // Используем переданный контейнер или ищем по умолчанию
  const targetContainer = container || document.getElementById('systemMonitorContainer');
  if (!targetContainer) {
    return;
  }

  // Проверяем, есть ли уже системный монитор в этом контейнере
  const existingMonitor = targetContainer.querySelector('#system-monitor');
  if (existingMonitor) {
    // UI уже существует, просто убеждаемся что стили добавлены
    addSystemMonitorStyles();
    return;
  }

  // Проверяем, не создан ли уже системный монитор в другом месте
  const globalMonitor = document.getElementById('system-monitor');
  if (globalMonitor && !targetContainer.contains(globalMonitor)) {
    return;
  }

  const monitorHTML = getSystemMonitorHTML();
  targetContainer.innerHTML = monitorHTML;
  
  // Добавляем стили
  addSystemMonitorStyles();
}

/**
 * Загрузить информацию о системе
 */
async function loadSystemInfo() {
  if (!fetchFunction) {
    return;
  }
  
  try {
    const response = await fetchFunction('/api/system/info');
    
    if (!response.ok) {
      console.error('Failed to load system info:', response.status);
      return;
    }

    const data = await response.json();
    updateSystemMonitorUI(data);
    
  } catch (error) {
    console.error('Error loading system info:', error);
  }
}

/**
 * Обновить UI с данными системы
 */
function updateSystemMonitorUI(data) {
  // CPU
  const cpuValue = document.getElementById('cpu-value');
  const cpuBar = document.getElementById('cpu-bar');
  if (cpuValue && cpuBar && data.cpu) {
    cpuValue.textContent = `${data.cpu.usage}%`;
    cpuBar.style.width = `${data.cpu.usage}%`;
    cpuBar.style.backgroundColor = getColorByUsage(data.cpu.usage);
  }

  // RAM
  const ramValue = document.getElementById('ram-value');
  const ramBar = document.getElementById('ram-bar');
  if (ramValue && ramBar && data.memory) {
    const usagePercent = parseFloat(data.memory.usagePercent);
    ramValue.textContent = `${usagePercent.toFixed(0)}%`;
    ramBar.style.width = `${usagePercent}%`;
    ramBar.style.backgroundColor = getColorByUsage(usagePercent);
  }

  // Disk - показываем информацию о контент-диске (один диск из настроек)
  const diskStat = document.getElementById('disk-stat');
  if (diskStat && data.disk) {
    // Убираем контейнер множественных дисков если был (теперь всегда один диск)
    const diskContainer = diskStat.querySelector('.disk-container');
    if (diskContainer) {
      diskContainer.remove();
    }
    
    // Восстанавливаем стандартную структуру если её нет
    let diskValue = document.getElementById('disk-value');
    let diskBar = document.getElementById('disk-bar');
    
    if (!diskValue || !diskBar) {
      // Если структуры нет - создаём её (должна быть в HTML, но на всякий случай)
      const icon = diskStat.querySelector('.stat-icon');
      if (icon) {
        const valueContainer = document.createElement('div');
        valueContainer.style.display = 'flex';
        valueContainer.style.alignItems = 'center';
        valueContainer.style.gap = 'var(--space-sm)';
        valueContainer.innerHTML = `
          <span class="stat-value" id="disk-value">--</span>
          <div class="stat-bar" id="disk-bar">
            <div class="stat-bar-fill"></div>
          </div>
        `;
        icon.parentElement.insertBefore(valueContainer, icon.nextSibling);
        diskValue = document.getElementById('disk-value');
        diskBar = document.getElementById('disk-bar');
      }
    }
    
    if (diskValue && diskBar) {
      // Используем данные из data.disk (контентный диск)
      const usagePercent = parseFloat(data.disk?.usagePercent || 0);
      
      if (usagePercent >= 0 && usagePercent <= 100) {
        diskValue.textContent = `${usagePercent.toFixed(0)}%`;
        
        // Обновляем title с информацией о диске
        const mountPoint = data.disk.mountPoint || data.disk.drive || '';
        const available = data.disk.availableFormatted || '';
        diskStat.title = `Контент-диск ${mountPoint}: ${available} свободно`;
        
        const barFill = diskBar.querySelector('.stat-bar-fill');
        if (barFill) {
          barFill.style.width = `${usagePercent}%`;
          barFill.style.backgroundColor = getColorByUsage(usagePercent);
        }
      } else {
        diskValue.textContent = '--';
        diskStat.title = 'Контент-диск: информация недоступна';
      }
    }
  }

  // Uptime
  const uptimeValue = document.getElementById('uptime-value');
  if (uptimeValue && data.processUptimeFormatted) {
    uptimeValue.textContent = data.processUptimeFormatted;
  }
}

/**
 * Получить цвет по проценту использования
 */
function getColorByUsage(percent) {
  // Используем CSS переменные из app.css
  const root = getComputedStyle(document.documentElement);
  const success = root.getPropertyValue('--success').trim() || '#10b981';
  const warning = root.getPropertyValue('--warning').trim() || '#f59e0b';
  const danger = root.getPropertyValue('--danger').trim() || '#ef4444';
  
  if (percent < 50) return success;
  if (percent < 75) return warning;
  return danger;
}

/**
 * Добавить стили для системного монитора
 */
function addSystemMonitorStyles() {
  const styleId = 'system-monitor-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .system-monitor {
      display: flex;
      align-items: center;
      gap: var(--space-lg);
      padding: var(--space-sm) var(--space-xl);
      background: var(--brand-light);
      border-radius: var(--radius-sm);
      border: var(--border-2);
    }

    .system-stat {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      position: relative;
    }

    .stat-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      opacity: 0.8;
      flex-shrink: 0;
    }

    .stat-icon svg {
      width: 100%;
      height: 100%;
      color: currentColor;
    }

    .stat-value {
      font-size: var(--font-size-sm);
      font-weight: var(--font-weight-bold);
      color: var(--text);
      min-width: 45px;
      text-align: center;
    }

    .stat-bar {
      width: 50px;
      height: 6px;
      background: var(--panel-2);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }

    .stat-bar-fill {
      height: 100%;
      background: var(--success);
      border-radius: var(--radius-sm);
      transition: width var(--transition-base), background-color var(--transition-base);
    }

    /* Множественные диски */
    .disk-container {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      min-width: 120px;
    }

    .disk-item {
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      font-size: var(--font-size-xs);
    }

    .disk-label {
      min-width: 30px;
      font-weight: var(--font-weight-medium);
      color: var(--text-2);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .disk-item .disk-value {
      min-width: 35px;
      font-size: var(--font-size-xs);
      font-weight: var(--font-weight-bold);
      text-align: center;
      color: var(--text);
    }

    .disk-item .stat-bar {
      width: 40px;
      height: 4px;
    }

    /* Адаптивность */
    @media (max-width: 1200px) {
      #uptime-stat {
        display: none;
      }
    }

    @media (max-width: 900px) {
      .system-monitor {
        gap: var(--space-sm);
        padding: var(--space-xs) var(--space-sm);
        flex-wrap: wrap;
        justify-content: center;
      }
      
      .stat-bar {
        width: 35px;
      }
      
      .stat-value {
        font-size: var(--font-size-xs);
        min-width: 32px;
      }
      
      .stat-icon {
        width: 16px;
        height: 16px;
      }
    }

    @media (max-width: 768px) {
      .system-monitor {
        gap: var(--space-xs);
        padding: var(--space-xs);
        flex-wrap: wrap;
        font-size: 0.75rem;
      }
      
      .stat-bar {
        width: 30px;
        height: 4px;
      }
      
      .stat-value {
        font-size: 0.7rem;
        min-width: 28px;
      }
      
      .stat-icon {
        width: 14px;
        height: 14px;
      }
    }

    @media (max-width: 480px) {
      .system-monitor {
        display: none;
      }
    }
  `;

  document.head.appendChild(style);
}

/**
 * Остановить мониторинг
 */
export function stopSystemMonitor() {
  if (systemInfoInterval) {
    clearInterval(systemInfoInterval);
    systemInfoInterval = null;
  }
}

export default {
  initSystemMonitor,
  stopSystemMonitor
};

