import { 
  escapeHtml, 
  normalizeString, 
  formatBiography, 
  renderMediaThumbnail,
  setHTML,
  debounce,
  safeFetch,
  showLoadingState,
  showErrorState
} from './hero-utils.js';

const searchInput = document.getElementById('searchInput');
const suggestions = document.getElementById('suggestions');
const contentEl = document.getElementById('heroContent');
const emptyStateEl = document.getElementById('emptyState');
const lightboxEl = document.getElementById('lightbox');

const HERO_BASE_WIDTH = 1920;
const HERO_BASE_HEIGHT = 1080;
let heroScaleInitialized = false;

function updateHeroScale() {
  if (!document.body || !document.body.classList.contains('hero-page')) return;
  const scaleX = window.innerWidth / HERO_BASE_WIDTH;
  const scaleY = window.innerHeight / HERO_BASE_HEIGHT;
  const scale = Math.min(1, scaleX, scaleY);
  const scaledWidth = HERO_BASE_WIDTH * scale;
  const scaledHeight = HERO_BASE_HEIGHT * scale;
  const offsetX = Math.max(0, (window.innerWidth - scaledWidth) / 2);
  const offsetY = Math.max(0, (window.innerHeight - scaledHeight) / 2);
  document.body.style.setProperty('--hero-scale', scale.toFixed(4));
  document.body.style.setProperty('--hero-offset-x', `${offsetX}px`);
  document.body.style.setProperty('--hero-offset-y', `${offsetY}px`);
}

function initHeroScaling() {
  if (heroScaleInitialized) return;
  if (!document.body || !document.body.classList.contains('hero-page')) return;
  heroScaleInitialized = true;
  updateHeroScale();
  window.addEventListener('resize', updateHeroScale);
  window.addEventListener('orientationchange', updateHeroScale);
  window.addEventListener('fullscreenchange', updateHeroScale);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateHeroScale);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHeroScaling, { once: true });
} else {
  initHeroScaling();
}

let currentHero = null;
let currentMediaIndex = 0;
let allHeroes = [];
let autoChangeTimer = null;
let serverHealthCheckInterval = null;
let isServerAvailable = true; // Состояние доступности сервера
const AUTO_CHANGE_INTERVAL = 10 * 60 * 1000; // 10 минут в миллисекундах
const HEALTH_CHECK_INTERVAL = 30 * 1000; // Проверка доступности каждые 30 секунд

// Используем safeFetch вместо fetchJSON
async function fetchJSON(url) {
  return await safeFetch(url);
}

async function searchHeroes(query) {
  if (query.length < 2) {
    suggestions.style.display = 'none';
    return;
  }
  try {
    const items = await fetchJSON(`/api/hero/search?q=${encodeURIComponent(query)}`);
    if (!items.length) {
      setHTML(suggestions, 
        '<div class="suggestion-item suggestion-item--empty" style="cursor:default;color:var(--muted);">Не найдено</div>'
      );
    } else {
      const html = items
        .map(
          (item) => `
            <div class="suggestion-item" data-id="${item.id}">
              <strong>${escapeHtml(item.full_name)}</strong>
              <span>
                ${escapeHtml(item.birth_year || '?')} — ${escapeHtml(item.death_year || 'н.в.')}
                ${item.rank ? ` • ${escapeHtml(item.rank)}` : ''}
              </span>
            </div>
          `
        )
        .join('');
      setHTML(suggestions, html);
    }
    suggestions.style.display = 'block';
  } catch (error) {
    console.error('[Hero] Search error:', error);
    setHTML(suggestions, 
      `<div class="suggestion-item suggestion-item--error" style="cursor:default;color:var(--danger);">Ошибка запроса: ${escapeHtml(error.message || 'Неизвестная ошибка')}</div>`
    );
    suggestions.style.display = 'block';
  }
}

async function loadHero(id, withAnimation = true) {
  try {
    // Показываем состояние загрузки
    if (contentEl) {
      showLoadingState(contentEl, 'Загрузка карточки героя...');
      if (emptyStateEl) emptyStateEl.style.display = 'none';
      contentEl.style.display = 'block';
    }
    
    const hero = await fetchJSON(`/api/hero/${id}`);
    currentHero = hero;
    
    if (withAnimation && contentEl && contentEl.textContent.trim() !== '') {
      // Плавная смена карточек с кроссфейдом
      await fadeOutCurrent();
      await fadeInNew(hero);
    } else {
      // Первая загрузка без анимации
      renderHero(hero);
      if (emptyStateEl) emptyStateEl.style.display = 'none';
      contentEl.style.display = 'block';
    }
    
    // Запускаем таймер смены карточки
    startAutoChangeTimer();
  } catch (error) {
    console.error('[Hero] Load hero error:', error);
    if (contentEl) {
      showErrorState(contentEl, `Не удалось загрузить данные героя: ${error.message || 'Неизвестная ошибка'}`, () => loadHero(id, withAnimation));
    } else {
      alert('Не удалось загрузить данные героя');
    }
  }
}

async function fadeOutCurrent() {
  return new Promise((resolve) => {
    if (contentEl && contentEl.textContent.trim() !== '') {
      contentEl.classList.add('fade-out');
      setTimeout(() => {
        if (contentEl) {
          contentEl.classList.remove('fade-out');
        }
        resolve();
      }, 500); // Длительность анимации fade-out
    } else {
      resolve();
    }
  });
}

async function fadeInNew(hero) {
  return new Promise((resolve) => {
    // Сначала очищаем контент
    if (contentEl) {
      setHTML(contentEl, '');
      contentEl.style.opacity = '0';
    }
    
    // Рендерим новый контент
    renderHero(hero);
    if (emptyStateEl) emptyStateEl.style.display = 'none';
    if (contentEl) {
      contentEl.style.display = 'block';
      
      // Применяем анимацию fade-in к новому контенту
      requestAnimationFrame(() => {
        if (contentEl) {
          contentEl.style.opacity = '1';
        }
        const heroView = contentEl.querySelector('.hero-view');
        if (heroView) {
          heroView.classList.add('fade-in');
          setTimeout(() => {
            if (heroView) {
              heroView.classList.remove('fade-in');
            }
            if (contentEl) {
              contentEl.style.opacity = '';
            }
            resolve();
          }, 500); // Длительность анимации fade-in
        } else {
          resolve();
        }
      });
    } else {
      resolve();
    }
  });
}

function getRandomHero() {
  if (!allHeroes || allHeroes.length === 0) return null;
  // Исключаем текущего героя из выбора, если есть другие
  const availableHeroes = allHeroes.filter(h => !currentHero || h.id !== currentHero.id);
  const heroesToChooseFrom = availableHeroes.length > 0 ? availableHeroes : allHeroes;
  const randomIndex = Math.floor(Math.random() * heroesToChooseFrom.length);
  return heroesToChooseFrom[randomIndex];
}

function startAutoChangeTimer() {
  // Очищаем предыдущий таймер
  if (autoChangeTimer) {
    clearTimeout(autoChangeTimer);
    autoChangeTimer = null;
  }
  
  // Обновляем карточки только если сервер доступен
  if (!isServerAvailable) {
    console.log('[Hero Watchdog] Сервер недоступен, автосмена карточек приостановлена');
    return;
  }
  
  // Устанавливаем новый таймер на 10 минут
  autoChangeTimer = setTimeout(async () => {
    if (!isServerAvailable) {
      console.log('[Hero Watchdog] Сервер недоступен, пропускаем автосмену карточки');
      return;
    }
    
    const nextHero = getRandomHero();
    if (nextHero) {
      await loadHero(nextHero.id);
    }
  }, AUTO_CHANGE_INTERVAL);
}

function pauseAutoChangeTimer(reason = '') {
  if (!autoChangeTimer) return;
  clearTimeout(autoChangeTimer);
  autoChangeTimer = null;
  console.log(
    `[Hero Watchdog] Автосмена карточек приостановлена${reason ? `: ${reason}` : ''}`
  );
}

async function loadAllHeroes() {
  try {
    allHeroes = await fetchJSON('/api/hero');
    // Выбираем случайного героя для показа (первая загрузка без анимации)
    const randomHero = getRandomHero();
    if (randomHero) {
      await loadHero(randomHero.id, false); // Первая загрузка без анимации
    } else if (contentEl) {
      // Если нет героев, показываем пустое состояние
      if (emptyStateEl) emptyStateEl.style.display = 'flex';
      contentEl.style.display = 'none';
    }
  } catch (error) {
    console.error('[Hero] Failed to load heroes:', error);
    // Если не удалось загрузить, помечаем сервер как недоступный
    isServerAvailable = false;
    if (contentEl) {
      showErrorState(contentEl, `Не удалось загрузить список героев: ${error.message || 'Неизвестная ошибка'}`, loadAllHeroes);
    }
  }
}

// Проверка доступности сервера через /health endpoint
async function checkServerHealth() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // Таймаут 5 секунд
    
    const res = await fetch('/health', {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-cache'
    });
    
    clearTimeout(timeoutId);
    
    if (res.ok) {
      const health = await res.json();
      const wasAvailable = isServerAvailable;
      isServerAvailable = health.status === 'ok' || health.status === 'degraded';
      
      // Если сервер стал доступен после недоступности, обновляем карточки
      if (!wasAvailable && isServerAvailable) {
        console.log('[Hero Watchdog] Сервер снова доступен, обновляем карточки');
        await refreshHeroes();
      }
      
      return isServerAvailable;
    } else {
      isServerAvailable = false;
      pauseAutoChangeTimer('сервер недоступен');
      return false;
    }
  } catch (error) {
    // Сервер недоступен (сеть, таймаут, ошибка)
    const wasAvailable = isServerAvailable;
    isServerAvailable = false;
    
    if (wasAvailable) {
      console.log('[Hero Watchdog] Сервер стал недоступен:', error.message);
      pauseAutoChangeTimer('потеряна связь с сервером');
    }
    
    return false;
  }
}

// Обновление списка героев и текущей карточки
async function refreshHeroes() {
  if (!isServerAvailable) {
    console.log('[Hero Watchdog] Сервер недоступен, пропускаем обновление');
    return;
  }
  
  try {
    const newHeroes = await fetchJSON('/api/hero');
    
    // Обновляем список героев
    allHeroes = newHeroes;
    
    // Если текущий герой все еще в списке, обновляем его данные
    if (currentHero && allHeroes.some(h => h.id === currentHero.id)) {
      const updatedHero = allHeroes.find(h => h.id === currentHero.id);
      if (updatedHero) {
        // Обновляем данные текущего героя без анимации
        currentHero = updatedHero;
        renderHero(updatedHero);
        // Перезапускаем таймер автосмены
        startAutoChangeTimer();
      }
    } else if (allHeroes.length > 0) {
      // Если текущего героя нет в списке, выбираем случайного
      const randomHero = getRandomHero();
      if (randomHero) {
        await loadHero(randomHero.id);
      }
    }
  } catch (error) {
    console.error('[Hero Watchdog] Ошибка обновления карточек:', error);
    isServerAvailable = false;
  }
}

// Инициализация watchdog для проверки доступности сервера
function initServerWatchdog() {
  // Первая проверка сразу при загрузке
  checkServerHealth();
  
  // Устанавливаем периодическую проверку доступности сервера
  serverHealthCheckInterval = setInterval(async () => {
    await checkServerHealth();
  }, HEALTH_CHECK_INTERVAL);
  
  // Если сервер доступен, обновляем список героев каждые 10 минут
  setInterval(async () => {
    if (isServerAvailable) {
      await refreshHeroes();
    }
  }, AUTO_CHANGE_INTERVAL);
  
  console.log('[Hero Watchdog] Инициализирован: проверка доступности каждые', HEALTH_CHECK_INTERVAL / 1000, 'сек, обновление карточек каждые', AUTO_CHANGE_INTERVAL / 1000 / 60, 'мин');
  }

// Функции escapeHtml, formatBiography, renderMediaThumbnail теперь импортируются из hero-utils.js

function renderHero(hero) {
  const mediaThumbnails = hero.media?.length
    ? `
        <div class="hero-media-thumbnails">
          ${hero.media.map((item, idx) => renderMediaThumbnail(item, idx)).join('')}
        </div>
      `
    : '';

  const html = `
    <div class="hero-view">
      <div class="hero-layout">
        <div class="hero-portrait">
          ${hero.photo_base64
            ? `<img src="${hero.photo_base64}" class="hero-photo" alt="${hero.full_name}"/>`
            : `<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--muted); height: 100%; min-height: 520px;">
                 <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.5;">
                   <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                   <circle cx="8.5" cy="8.5" r="1.5"></circle>
                   <polyline points="21 15 16 10 5 21"></polyline>
                 </svg>
                 <strong style="font-size: 1.1rem;">НЕТ ФОТО</strong>
               </div>`}
          ${mediaThumbnails}
        </div>
        <div class="hero-card-right">
          <div class="hero-info">
            <div class="hero-info-header">
              <h1>${escapeHtml(hero.full_name)}</h1>
              <div class="hero-info-item hero-rank-years">
                <div class="hero-rank">
                  <strong>Звание:</strong>
                  <span>${hero.rank ? escapeHtml(hero.rank) : '—'}</span>
      </div>
                <div class="hero-years">
                  <span>${hero.birth_year || '?'} – ${hero.death_year || 'н.в.'}</span>
                </div>
              </div>
            </div>
          </div>
          <div class="hero-scroll">
            <div class="hero-scroll__bio">
              ${formatBiography(hero.biography)}
            </div>
        </div>
        </div>
      </div>
    </div>
  `;
  
  // Используем оптимизированную функцию setHTML вместо innerHTML
  setHTML(contentEl, html);
}

// renderMediaThumbnail теперь импортируется из hero-utils.js


function openLightbox(index) {
  if (!currentHero || !currentHero.media?.length) return;
  currentMediaIndex = index;
  const media = currentHero.media[index];
  const total = currentHero.media.length;
  const isLast = index === total - 1;

  const lightboxHTML = `
    <div class="lightbox-overlay" data-action="${isLast ? 'close' : 'next'}">
      <button class="lightbox-close" data-action="close" title="Закрыть">✕</button>
      ${index > 0 ? '<button class="lightbox-nav prev" data-action="prev" title="Предыдущее">←</button>' : ''}
      ${!isLast ? '<button class="lightbox-nav next" data-action="next" title="Следующее">→</button>' : ''}
      <div class="lightbox-content" data-action="${isLast ? 'close' : 'next'}">
        ${
          media.type === 'photo'
            ? `<img src="${media.media_base64}" alt="${media.caption || ''}"/>`
            : `<video src="${media.media_base64}" controls autoplay></video>`
        }
        ${media.caption ? `<div class="lightbox-caption">${media.caption}</div>` : ''}
      </div>
      <div class="lightbox-counter">
        ${index + 1} / ${total}
      </div>
    </div>
  `;
  setHTML(lightboxEl, lightboxHTML);
  lightboxEl.style.display = 'block';
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  lightboxEl.style.display = 'none';
  setHTML(lightboxEl, '');
  document.body.style.overflow = '';
}

function showPrevMedia() {
  if (currentMediaIndex > 0) openLightbox(currentMediaIndex - 1);
}

function showNextMedia() {
  if (currentHero && currentMediaIndex < currentHero.media.length - 1) {
    openLightbox(currentMediaIndex + 1);
  } else if (currentHero && currentMediaIndex === currentHero.media.length - 1) {
    // При клике на последний материал закрываем лайтбокс
    closeLightbox();
  }
}

document.addEventListener('click', (event) => {
  if (event.target.closest('.media-thumbnail')) {
    const idx = Number(event.target.closest('.media-thumbnail').dataset.index);
    openLightbox(idx);
  } else if (lightboxEl.style.display === 'block') {
    // Закрытие по клику на фон или на последний материал
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'close') {
    closeLightbox();
    } else if (action === 'prev') {
      event.stopPropagation();
    showPrevMedia();
    } else if (action === 'next') {
      event.stopPropagation();
    showNextMedia();
    }
  } else if (!searchInput.contains(event.target) && !suggestions.contains(event.target)) {
    suggestions.style.display = 'none';
  }
});

document.addEventListener('keydown', (event) => {
  if (lightboxEl.style.display === 'block') {
    if (event.key === 'Escape') closeLightbox();
    if (event.key === 'ArrowLeft') showPrevMedia();
    if (event.key === 'ArrowRight') showNextMedia();
  }
});

if (searchInput) {
  searchInput.addEventListener(
    'input',
    debounce((e) => {
      const query = e.target.value.trim();
      // Если начинается ввод, останавливаем таймер автосмены
      if (query.length > 0 && autoChangeTimer) {
        clearTimeout(autoChangeTimer);
        autoChangeTimer = null;
      }
      searchHeroes(query);
    }, 300)
  );
  
  // При фокусе на поле поиска останавливаем таймер и предотвращаем смещение страницы
  searchInput.addEventListener('focus', (e) => {
    if (autoChangeTimer) {
      clearTimeout(autoChangeTimer);
      autoChangeTimer = null;
    }
    
    // Предотвращаем изменение viewport при появлении клавиатуры
    // Блокируем прокрутку страницы, фиксируя позицию
    const scrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.width = '100%';
    document.body.style.top = `-${scrollY}px`;
    
    // Дополнительная защита от прокрутки
    setTimeout(() => {
      window.scrollTo(0, 0);
      document.body.scrollTop = 0;
      document.documentElement.scrollTop = 0;
    }, 50);
  });

  searchInput.addEventListener('blur', () => {
    // Возвращаем обычное поведение после потери фокуса
    const scrollY = document.body.style.top;
    document.body.style.position = '';
    document.body.style.width = '';
    document.body.style.top = '';
    
    if (scrollY) {
      window.scrollTo(0, parseInt(scrollY || '0') * -1);
    }
  });
}

suggestions.addEventListener('click', (event) => {
  const item = event.target.closest('.suggestion-item');
  if (!item || !item.dataset.id) return;
  // Останавливаем таймер при ручном выборе
  if (autoChangeTimer) {
    clearTimeout(autoChangeTimer);
    autoChangeTimer = null;
  }
  loadHero(item.dataset.id);
  suggestions.style.display = 'none';
  searchInput.value = '';
});

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', async () => {
  await loadAllHeroes();
  initServerWatchdog(); // Запускаем watchdog для проверки доступности сервера
});

console.log('[Hero] module loaded');

