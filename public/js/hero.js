const searchInput = document.getElementById('searchInput');
const suggestions = document.getElementById('suggestions');
const contentEl = document.getElementById('heroContent');
const emptyStateEl = document.getElementById('emptyState');
const lightboxEl = document.getElementById('lightbox');

let currentHero = null;
let currentMediaIndex = 0;
let allHeroes = [];
let autoChangeTimer = null;
let serverHealthCheckInterval = null;
let isServerAvailable = true; // Состояние доступности сервера
const AUTO_CHANGE_INTERVAL = 10 * 60 * 1000; // 10 минут в миллисекундах
const HEALTH_CHECK_INTERVAL = 30 * 1000; // Проверка доступности каждые 30 секунд

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(null, args), delay);
  };
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

async function searchHeroes(query) {
  if (query.length < 2) {
    suggestions.style.display = 'none';
    return;
  }
  try {
    const items = await fetchJSON(`/api/hero/search?q=${encodeURIComponent(query)}`);
    if (!items.length) {
      suggestions.innerHTML =
        '<div class="suggestion-item suggestion-item--empty" style="cursor:default;color:var(--muted);">Не найдено</div>';
    } else {
      suggestions.innerHTML = items
        .map(
          (item) => `
            <div class="suggestion-item" data-id="${item.id}">
              <strong>${item.full_name}</strong>
              <span>
                ${item.birth_year || '?'} — ${item.death_year || 'н.в.'}
                ${item.rank ? ` • ${item.rank}` : ''}
              </span>
            </div>
          `
        )
        .join('');
    }
    suggestions.style.display = 'block';
  } catch (error) {
    suggestions.innerHTML =
      '<div class="suggestion-item suggestion-item--error" style="cursor:default;color:var(--danger);">Ошибка запроса</div>';
    suggestions.style.display = 'block';
  }
}

async function loadHero(id, withAnimation = true) {
  try {
    const hero = await fetchJSON(`/api/hero/${id}`);
    currentHero = hero;
    
    if (withAnimation && contentEl && contentEl.innerHTML.trim() !== '') {
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
    alert('Не удалось загрузить данные героя');
  }
}

async function fadeOutCurrent() {
  return new Promise((resolve) => {
    if (contentEl && contentEl.innerHTML.trim() !== '') {
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
      contentEl.innerHTML = '';
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

async function loadAllHeroes() {
  try {
    allHeroes = await fetchJSON('/api/hero');
    // Выбираем случайного героя для показа (первая загрузка без анимации)
    const randomHero = getRandomHero();
    if (randomHero) {
      await loadHero(randomHero.id, false); // Первая загрузка без анимации
    }
  } catch (error) {
    console.error('[Hero] Failed to load heroes:', error);
    // Если не удалось загрузить, помечаем сервер как недоступный
    isServerAvailable = false;
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
      return false;
    }
  } catch (error) {
    // Сервер недоступен (сеть, таймаут, ошибка)
    const wasAvailable = isServerAvailable;
    isServerAvailable = false;
    
    if (wasAvailable) {
      console.log('[Hero Watchdog] Сервер стал недоступен:', error.message);
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

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHero(hero) {
  const mediaThumbnails = hero.media?.length
    ? `
        <div class="hero-media-thumbnails">
          ${hero.media.map((item, idx) => renderMediaThumbnail(item, idx)).join('')}
        </div>
      `
    : '';

  contentEl.innerHTML = `
    <div class="hero-view">
      <div class="hero-layout">
        <div class="hero-portrait">
          ${hero.photo_base64
            ? `<img src="${hero.photo_base64}" class="hero-photo" alt="${hero.full_name}"/>`
            : `<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--muted); height: 100%; min-height: clamp(320px, 60vh, 520px);">
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
            <strong>Годы жизни:</strong>
                  <span>${hero.birth_year || '?'} – ${hero.death_year || 'н.в.'}</span>
                </div>
              </div>
            </div>
          </div>
          <div class="hero-scroll">
            <div class="hero-scroll__bio">
              ${hero.biography || '<em style="color:var(--muted);">Информация отсутствует</em>'}
            </div>
        </div>
        </div>
      </div>
    </div>
  `;
}

function renderMediaThumbnail(media, index) {
  return `
    <div class="media-thumbnail" data-index="${index}">
      ${
        media.type === 'photo'
          ? `<img src="${media.media_base64}" alt="${media.caption || ''}" loading="lazy"/>`
          : `<video src="${media.media_base64}" preload="metadata"></video>`
      }
    </div>
  `;
}


function openLightbox(index) {
  if (!currentHero || !currentHero.media?.length) return;
  currentMediaIndex = index;
  const media = currentHero.media[index];
  const total = currentHero.media.length;
  const isLast = index === total - 1;

  lightboxEl.innerHTML = `
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
  lightboxEl.style.display = 'block';
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  lightboxEl.style.display = 'none';
  lightboxEl.innerHTML = '';
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

