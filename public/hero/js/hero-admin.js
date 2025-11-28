import { ensureAuth, adminFetch, logout } from '../../js/admin/auth.js';
import { 
  escapeHtml, 
  normalizeString, 
  formatBiography, 
  renderMediaThumbnail,
  setHTML,
  showLoadingState,
  showErrorState
} from './hero-utils.js';

const state = {
  user: null,
  heroes: [],
  filtered: [],
  active: null,
  listEl: null,
  detailEl: null,
  placeholderEl: null,
  statusEl: null,
  searchEl: null,
  displayedCount: 30, // Количество отображаемых карточек
  loadMoreStep: 10, // Сколько карточек загружать за раз
};

document.addEventListener('DOMContentLoaded', async () => {
  try {
    state.user = await ensureAuth();
    if (!state.user) return;
    if (!['admin', 'hero_admin'].includes(state.user.role)) {
      window.location.href = '/index.html';
      return;
    }
  } catch (err) {
    console.error('[HeroAdmin] auth error', err);
    window.location.href = '/index.html';
    return;
  }

  cacheElements();
  initToolbar();
  bindSearch();
  initLightbox();
  await loadHeroes();
});

function initLightbox() {
  document.addEventListener('click', (event) => {
    if (!lightboxEl || lightboxEl.style.display !== 'block') return;
    
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
  });

  document.addEventListener('keydown', (event) => {
    if (!lightboxEl || lightboxEl.style.display !== 'block') return;
    
    if (event.key === 'Escape') {
      closeLightbox();
    } else if (event.key === 'ArrowLeft') {
      showPrevMedia();
    } else if (event.key === 'ArrowRight') {
      showNextMedia();
    }
  });
}

function cacheElements() {
  state.listEl = document.getElementById('heroList');
  state.detailEl = document.getElementById('heroDetail');
  state.placeholderEl = document.getElementById('heroDetailPlaceholder');
  state.statusEl = document.getElementById('heroDetailStatus');
  state.searchEl = document.getElementById('heroSearch');
  
  // Инициализация начального состояния панели деталей
  if (state.detailEl) {
    state.detailEl.style.display = 'none'; // Скрываем до выбора героя
  }
  if (state.placeholderEl) {
    state.placeholderEl.style.display = 'flex'; // Показываем placeholder
  }
}

function initToolbar() {
  const userFullName = document.getElementById('userFullName');
  if (userFullName) {
    userFullName.textContent = state.user.full_name || state.user.username || '';
  }
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => logout());
  }
  const addHeroBtn = document.getElementById('addHeroBtn');
  if (addHeroBtn) {
    addHeroBtn.addEventListener('click', () => createNewHero());
  }
  const exportDbBtn = document.getElementById('exportDbBtn');
  if (exportDbBtn) {
    exportDbBtn.addEventListener('click', () => exportDatabase());
  }
}

async function exportDatabase() {
  try {
    showStatus('Экспортируем базу данных…');
    
    const response = await adminFetch('/api/hero/export-database');
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || 'Ошибка экспорта');
    }
    
    // Получаем имя файла из заголовка или формируем
    const contentDisposition = response.headers.get('Content-Disposition');
    let filename = 'heroes_backup.db';
    if (contentDisposition) {
      const matches = contentDisposition.match(/filename="(.+)"/);
      if (matches) {
        filename = matches[1];
      }
    }
    
    // Скачиваем файл
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    
    showStatus('База данных экспортирована');
  } catch (err) {
    console.error('[HeroAdmin] exportDatabase failed', err);
    showStatus('Не удалось экспортировать базу данных: ' + (err.message || 'Неизвестная ошибка'), true);
  }
}

async function loadHeroes() {
  try {
    const res = await adminFetch('/api/hero');
    state.heroes = await res.json();
    state.filtered = [...state.heroes];
    state.displayedCount = 30; // Сбрасываем счетчик при загрузке
    renderHeroList();
    initScrollListener(); // Инициализируем обработчик скролла
    if (state.heroes.length) {
      await selectHero(state.heroes[0].id);
    } else {
      showPlaceholder('Карточки не найдены. Добавьте первые записи через API.');
    }
  } catch (err) {
    console.error('[HeroAdmin] load heroes failed', err);
    showStatus('Не удалось загрузить список героев', true);
  }
}

function renderHeroList() {
  if (!state.listEl) return;
  const countEl = document.getElementById('heroCount');
  if (countEl) countEl.textContent = state.filtered.length;

  if (!state.filtered.length) {
    setHTML(state.listEl, '<li class="hero-list__item hero-list__empty">Ничего не найдено</li>');
    return;
  }

  // Отображаем только часть списка (умный скролл)
  const itemsToShow = state.filtered.slice(0, state.displayedCount);
  
  let html = itemsToShow
    .map((hero) => {
      const isActive = state.active?.id === hero.id;
      return `
        <li class="hero-list__item${isActive ? ' is-active' : ''}" data-id="${hero.id}">
          <div class="hero-list__name">${escapeHtml(hero.full_name || 'Без имени')}</div>
          <div class="hero-list__meta">${formatHeroMeta(hero)}</div>
        </li>
      `;
    })
    .join('');

  // Показываем индикатор загрузки, если есть еще элементы
  if (state.displayedCount < state.filtered.length) {
    html += `
      <li class="hero-list__item hero-list__loading" style="text-align:center; padding:var(--space-md); color:var(--muted);">
        <div class="meta">Загружено ${state.displayedCount} из ${state.filtered.length}</div>
      </li>
    `;
  }
  
  setHTML(state.listEl, html);

  state.listEl.querySelectorAll('.hero-list__item:not(.hero-list__loading)').forEach((item) => {
    const id = Number(item.dataset.id);
    item.addEventListener('click', () => selectHero(id));
  });
}

function initScrollListener() {
  if (!state.listEl) return;
  
  // Удаляем предыдущий обработчик, если есть
  if (state.listEl._scrollHandler) {
    state.listEl.removeEventListener('scroll', state.listEl._scrollHandler);
  }
  
  // Создаем новый обработчик скролла
  state.listEl._scrollHandler = () => {
    const { scrollTop, scrollHeight, clientHeight } = state.listEl;
    const scrollBottom = scrollHeight - scrollTop - clientHeight;
    
    // Если прокрутили до 100px от конца и есть еще элементы для загрузки
    if (scrollBottom < 100 && state.displayedCount < state.filtered.length) {
      state.displayedCount = Math.min(
        state.displayedCount + state.loadMoreStep,
        state.filtered.length
      );
      renderHeroList();
      // После рендеринга восстанавливаем позицию скролла (примерно)
      // Чтобы не было "прыжка" при добавлении элементов
    }
  };
  
  state.listEl.addEventListener('scroll', state.listEl._scrollHandler);
}

// normalizeString теперь импортируется из hero-utils.js

function bindSearch() {
  if (!state.searchEl) return;
  state.searchEl.addEventListener('input', (e) => {
    const term = e.target.value.trim();
    if (!term) {
      state.filtered = [...state.heroes];
    } else {
      const normalizedTerm = normalizeString(term);
      state.filtered = normalizedTerm
        ? state.heroes.filter((hero) => {
            const normalizedName = normalizeString(hero.full_name || '');
            return normalizedName.startsWith(normalizedTerm);
          })
        : [...state.heroes];
    }
    state.displayedCount = 30; // Сбрасываем счетчик при поиске
    renderHeroList();
    // Переинициализируем скролл после фильтрации
    initScrollListener();
  });
}

async function selectHero(id) {
  if (!Number.isFinite(id) || state.active?.id === id) return;
  try {
    toggleLoading(true);
    const hero = await fetchHero(id);
    state.active = hero;
    renderHeroDetail(hero);
    highlightActive(id);
  } catch (err) {
    console.error('[HeroAdmin] select hero failed', err);
    showStatus('Не удалось загрузить карточку', true);
  } finally {
    toggleLoading(false);
  }
}

async function fetchHero(id) {
  const res = await adminFetch(`/api/hero/${id}`);
  if (!res.ok) throw new Error('Failed to fetch hero');
  return res.json();
}

async function createNewHero() {
  try {
    showStatus('Создаём новую карточку…');
    
    // Создаем нового героя с минимальными данными
    const res = await adminFetch('/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: 'ФИО',
        birth_year: null,
        death_year: null,
        rank: null,
        photo_base64: null,
        biography: null,
        media: []
      })
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || 'Ошибка создания карточки');
    }

    const data = await res.json();
    const newHeroId = data.id;

    // Обновляем список героев
    await loadHeroes();
    
    // Обновляем отфильтрованный список, чтобы новый герой был виден
    const searchTerm = state.searchEl?.value.trim().toLowerCase() || '';
    state.filtered = searchTerm
      ? state.heroes.filter((hero) => (hero.full_name || '').toLowerCase().includes(searchTerm))
      : [...state.heroes];
    renderHeroList();

    // Выбираем нового героя для редактирования
    await selectHero(newHeroId);
    
    showStatus('Новая карточка создана');
  } catch (err) {
    console.error('[HeroAdmin] createNewHero failed', err);
    showStatus('Не удалось создать карточку: ' + (err.message || 'Неизвестная ошибка'), true);
  }
}

function renderHeroDetail(hero) {
  if (!state.detailEl) return;
  state.placeholderEl.style.display = 'none';
  state.detailEl.style.display = 'flex'; // Используем flex вместо block для правильного отображения

  const mediaThumbnails = hero.media?.length
    ? `
        <div class="hero-media-thumbnails">
          ${hero.media.map((item, idx) => renderMediaThumbnailAdmin(item, idx)).join('')}
        </div>
      `
    : '';

  const detailHTML = `
    <div class="hero-view">
      <div class="hero-layout">
        <div class="hero-portrait">
          <div data-avatar style="cursor: pointer; position: relative;">
            ${hero.photo_base64
              ? `<img src="${hero.photo_base64}" class="hero-photo" alt="${escapeHtml(hero.full_name || '')}"/>
                 <button class="hero-avatar-delete" data-action="delete-avatar" title="Удалить фото">×</button>`
              : `<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--muted); height: 100%; min-height: clamp(320px, 60vh, 520px);">
                   <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.5;">
                     <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                     <circle cx="8.5" cy="8.5" r="1.5"></circle>
                     <polyline points="21 15 16 10 5 21"></polyline>
                   </svg>
                   <strong style="font-size: 1.1rem;">НЕТ ФОТО</strong>
                   <span style="font-size: 0.9rem;">Нажмите, чтобы загрузить</span>
                 </div>`}
          </div>
          ${mediaThumbnails}
          <button class="hero-media-add" data-action="add-media" style="margin-top: 12px; width: 100%;">+ Добавить материал</button>
        </div>
        <div class="hero-card-right" style="position: relative;">
          <div id="heroDetailStatus" class="hero-admin-status" aria-live="polite"></div>
          <div class="hero-info">
            <div class="hero-info-header">
              <h1 data-edit="full_name" data-type="text">${escapeHtml(hero.full_name || 'Без имени')}</h1>
              <div class="hero-info-item hero-rank-years">
                <div class="hero-rank">
                  <strong>Звание:</strong>
                  <span data-edit="rank" data-type="text" data-placeholder="Без звания">
                    ${escapeHtml(hero.rank || '—')}
                  </span>
                </div>
                <div class="hero-years">
                  <span data-edit="birth_year" data-type="text" data-placeholder="Дата рождения">
                    ${escapeHtml(hero.birth_year || '?')}
                  </span>
                  <span>–</span>
                  <span data-edit="death_year" data-type="text" data-placeholder="н.в.">
                    ${escapeHtml(hero.death_year || 'н.в.')}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <button class="danger meta" data-action="delete-hero" title="Удалить карточку" style="position: absolute; top: 24px; right: 28px; z-index: 10; display: flex; align-items: center; gap: 4px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: block;">
              <path d="M3 6h18"></path>
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
            </svg>
            Удалить
          </button>
          <div class="hero-scroll">
            <div class="hero-scroll__bio" data-edit="biography" data-type="multiline" data-placeholder="Добавьте биографию">
              ${formatBiography(hero.biography)}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  
  // УСТАНАВЛИВАЕМ HTML В ЭЛЕМЕНТ - это было пропущено!
  setHTML(state.detailEl, detailHTML);
  
  // Обновляем ссылку на statusEl после рендеринга
  const statusElInCard = document.getElementById('heroDetailStatus');
  if (statusElInCard) {
    state.statusEl = statusElInCard;
  }
  
  // Отладка: проверяем что биография отображается
  const bioEl = state.detailEl.querySelector('.hero-scroll__bio');
  if (bioEl) {
    console.log('[HeroAdmin] Биография элемент найден');
    console.log('[HeroAdmin] Содержимое биографии:', bioEl.innerHTML.substring(0, 100));
    console.log('[HeroAdmin] Hero biography value:', hero.biography ? hero.biography.substring(0, 50) + '...' : 'null/undefined');
  } else {
    console.warn('[HeroAdmin] Элемент .hero-scroll__bio не найден после рендеринга!');
  }

  attachInlineEditors(hero);
  attachAvatarUploader(hero);
  attachMediaUploader(hero);
  attachLightboxHandlers(hero);
  attachAvatarDelete(hero);
  attachHeroDelete(hero);
}

let currentMediaIndex = 0;
let currentHeroMedia = null;
const lightboxEl = document.getElementById('lightbox');

function attachLightboxHandlers(hero) {
  currentHeroMedia = hero.media || [];
  
  // Обработчики для миниатюр
  state.detailEl?.querySelectorAll('.media-thumbnail').forEach((thumb) => {
    thumb.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = Number(thumb.dataset.index);
      openLightbox(index);
    });
  });
}

function openLightbox(index) {
  const hero = state.active;
  if (!hero || !hero.media?.length) return;
  currentMediaIndex = index;
  const media = hero.media[index];
  const total = hero.media.length;
  const isLast = index === total - 1;

  if (!lightboxEl) return;

  const lightboxHTML = `
    <div class="lightbox-overlay" data-action="${isLast ? 'close' : 'next'}">
      <button class="lightbox-close" data-action="close" title="Закрыть">✕</button>
      ${index > 0 ? '<button class="lightbox-nav prev" data-action="prev" title="Предыдущее">←</button>' : ''}
      ${!isLast ? '<button class="lightbox-nav next" data-action="next" title="Следующее">→</button>' : ''}
      <div class="lightbox-content" data-action="${isLast ? 'close' : 'next'}">
        ${
          media.type === 'photo'
            ? `<img src="${media.media_base64 || media.url}" alt="${escapeHtml(media.caption || '')}"/>`
            : `<video src="${media.media_base64 || media.url}" controls autoplay></video>`
        }
        ${media.caption ? `<div class="lightbox-caption">${escapeHtml(media.caption)}</div>` : ''}
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
  if (!lightboxEl) return;
  lightboxEl.style.display = 'none';
  setHTML(lightboxEl, '');
  document.body.style.overflow = '';
}

function showPrevMedia() {
  const hero = state.active;
  if (currentMediaIndex > 0 && hero) {
    openLightbox(currentMediaIndex - 1);
  }
}

function showNextMedia() {
  const hero = state.active;
  if (hero && currentMediaIndex < hero.media.length - 1) {
    openLightbox(currentMediaIndex + 1);
  } else if (hero && currentMediaIndex === hero.media.length - 1) {
    // При клике на последний материал закрываем лайтбокс
    closeLightbox();
  }
}

function attachInlineEditors(hero) {
  state.detailEl.querySelectorAll('[data-edit]').forEach((node) => {
    node.addEventListener('click', () => startInlineEdit(node, hero));
  });
}

function startInlineEdit(node, hero) {
  if (node.dataset.editing === 'true') return;
  node.dataset.editing = 'true';

  const field = node.dataset.edit;
  const type = node.dataset.type || 'text';
  const placeholder = node.dataset.placeholder || '';
  const currentValue = hero[field] ?? '';

  const editor = document.createElement(type === 'multiline' ? 'textarea' : 'input');
  editor.className = 'hero-inline-input';
  
  // Применяем специфичный класс для каждого поля
  if (field === 'full_name') {
    editor.classList.add('hero-inline-input--full-name');
  } else if (field === 'rank') {
    editor.classList.add('hero-inline-input--rank');
  } else if (field === 'birth_year' || field === 'death_year') {
    editor.classList.add('hero-inline-input--year');
  } else if (field === 'biography') {
    editor.classList.add('hero-inline-input--biography');
  }
  
  editor.value = currentValue || '';
  editor.placeholder = placeholder;

  // Для inline полей устанавливаем size атрибут для автоматической ширины
  if (type !== 'multiline') {
    // Используем только реальное значение, не placeholder
    let textLength = (currentValue || '').length;
    // Если значения нет, используем минимальную длину
    if (textLength === 0) {
      // Для полей дат - минимум 4 символа, для остальных - по placeholder или 4
      if (field === 'birth_year' || field === 'death_year') {
        textLength = 4;
      } else {
        textLength = Math.min((placeholder || '').length || 4, 20); // Ограничиваем placeholder
      }
    }
    // Для полей дат устанавливаем минимальный size для одинаковой ширины
    if (field === 'birth_year' || field === 'death_year') {
      textLength = Math.max(textLength, 4); // Минимум 4 символа
    }
    // Устанавливаем size строго по реальной длине, без учета placeholder
    const actualLength = (currentValue || '').length || textLength;
    editor.setAttribute('size', Math.max(actualLength, textLength));
  }

  const hint = document.createElement('div');
  hint.className = 'hero-inline-hint';
  if (type === 'multiline') {
    hint.textContent = 'Ctrl+Enter или клик вне поля — сохранить, Esc — отмена';
  } else {
    hint.textContent = 'Enter — сохранить, Esc — отмена';
  }

  const wrapper = document.createElement('div');
  if (field === 'biography') {
    wrapper.style.width = '100%';
    wrapper.style.height = '100%';
    wrapper.style.minHeight = '400px'; /* Минимальная высота для комфортного редактирования */
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.boxSizing = 'border-box';
  } else {
    wrapper.style.display = 'inline-block';
  }
  wrapper.appendChild(editor);
  if (type === 'multiline') wrapper.appendChild(hint);

  node.style.display = 'none';
  node.after(wrapper);
  editor.focus();
  
  // Для inline полей обновляем size при вводе
  if (type !== 'multiline') {
    const adjustSize = () => {
      // Используем только реальное значение, не placeholder
      let textLength = (editor.value || '').length;
      if (textLength === 0) {
        // Для полей дат - минимум 4 символа, для остальных - по placeholder или 4
        if (field === 'birth_year' || field === 'death_year') {
          textLength = 4;
        } else {
          textLength = Math.min((placeholder || '').length || 4, 20); // Ограничиваем placeholder
        }
      }
      // Для полей дат устанавливаем минимальный size для одинаковой ширины
      if (field === 'birth_year' || field === 'death_year') {
        textLength = Math.max(textLength, 4); // Минимум 4 символа
      }
      editor.setAttribute('size', textLength);
    };
    editor.addEventListener('input', adjustSize);
    
    // Сохраняем обработчик для удаления при завершении
    editor._adjustSizeHandler = adjustSize;
  }

  const finish = async (commit) => {
    editor.removeEventListener('keydown', onKeydown);
    editor.removeEventListener('blur', onBlur);
    if (editor._adjustSizeHandler) {
      editor.removeEventListener('input', editor._adjustSizeHandler);
    }
    wrapper.remove();
    node.style.display = '';
    node.dataset.editing = 'false';

    if (commit) {
      await saveField(field, editor.value, hero);
    }
  };

  const onKeydown = (event) => {
    if (type === 'multiline') {
      // Для textarea: Ctrl+Enter или Cmd+Enter сохраняет, Esc отменяет
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    } else {
      // Для input: Enter сохраняет, Esc отменяет
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    }
  };

  const onBlur = () => finish(true);

  editor.addEventListener('keydown', onKeydown);
  editor.addEventListener('blur', onBlur);
}

async function saveField(field, rawValue, hero) {
  try {
    showStatus('Сохраняем изменения…');
    const value = normalizeFieldValue(field, rawValue);
    const payload = buildPayload(hero, { [field]: value }, field);
    
    const response = await adminFetch(`/api/hero/${hero.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }
    
    await refreshActiveHero(hero.id);
    updateHeroListItem(hero.id, payload);
    showStatus('Изменения сохранены');
  } catch (err) {
    console.error('[HeroAdmin] saveField failed', err, { field, heroId: hero.id });
    showStatus(`Не удалось сохранить изменения: ${err.message}`, true);
  }
}

function normalizeFieldValue(field, value) {
  // Для photo_base64 и media_base64 не делаем trim, возвращаем как есть или null
  if (field === 'photo_base64' || field === 'media_base64') {
    if (!value || (typeof value === 'string' && value.trim().length === 0)) {
      return null;
    }
    return value;
  }
  
  const trimmed = value?.toString().trim() ?? '';
  if (!trimmed) return null;
  
  // Для дат сохраняем как текст (может быть формат "12.12.1480" или просто "1480")
  if (['birth_year', 'death_year'].includes(field)) {
    return trimmed; // Сохраняем как есть, без преобразования в число
  }
  
  return trimmed;
}

function buildPayload(hero, overrides = {}, changedField) {
  const payload = {
    id: hero.id,
    full_name: overrides.full_name ?? hero.full_name ?? '',
    birth_year: overrides.birth_year ?? hero.birth_year ?? null,
    death_year: overrides.death_year ?? hero.death_year ?? null,
    rank: overrides.rank ?? hero.rank ?? null,
    // Если photo_base64 явно передан (включая null для удаления), используем его
    photo_base64: overrides.hasOwnProperty('photo_base64') ? overrides.photo_base64 : (hero.photo_base64 ?? null),
    biography: overrides.biography ?? hero.biography ?? null,
  };

  if (Array.isArray(hero.media) && hero.media.length > 0 && changedField !== 'media') {
    payload.media = hero.media;
  }

  return payload;
}

async function refreshActiveHero(id) {
  const fresh = await fetchHero(id);
  state.active = fresh;
  renderHeroDetail(fresh);
}

function updateHeroListItem(id, payload) {
  state.heroes = state.heroes.map((hero) => (hero.id === id ? { ...hero, ...payload } : hero));
  state.filtered = state.filtered.map((hero) => (hero.id === id ? { ...hero, ...payload } : hero));
  renderHeroList();
}

function highlightActive(id) {
  state.listEl?.querySelectorAll('.hero-list__item').forEach((item) => {
    item.classList.toggle('is-active', Number(item.dataset.id) === id);
  });
}

// Базовая renderMediaThumbnail импортируется из hero-utils.js
// Для админ-панели нужна расширенная версия с кнопкой удаления
function renderMediaThumbnailAdmin(media, index) {
  const baseThumbnail = renderMediaThumbnail(media, index);
  // Добавляем кнопку удаления и оборачиваем в position: relative
  return baseThumbnail.replace(
    '<div class="media-thumbnail"',
    '<div class="media-thumbnail" style="position: relative;"'
  ).replace(
    '</div>',
    `<button class="hero-media-thumbnail-delete" data-action="remove-media" data-id="${media.id}" data-index="${index}" title="Удалить материал">×</button></div>`
  );
}

function renderMediaItem(media, index) {
  return `
    <div class="media-item hero-media__item" data-index="${index}">
      ${
        media.type === 'photo'
          ? `<img src="${media.media_base64 || media.url}" alt="${escapeHtml(media.caption || '')}" loading="lazy"/>`
          : `<video src="${media.media_base64 || media.url}" preload="metadata"></video>`
      }
      ${media.caption ? `<div class="media-item-caption">${escapeHtml(media.caption)}</div>` : ''}
      <button class="hero-media__remove" data-action="remove-media" data-id="${media.id}" title="Удалить материал">×</button>
    </div>
  `;
}

function formatHeroMeta(hero) {
  const years = `${hero.birth_year || '—'} – ${hero.death_year || 'н.в.'}`;
  const rank = hero.rank ? ` • ${hero.rank}` : '';
  return `${years}${rank}`;
}

function showPlaceholder(message) {
  if (state.placeholderEl) {
    state.placeholderEl.style.display = 'flex';
    state.placeholderEl.querySelector('p').textContent = message;
  }
  if (state.detailEl) state.detailEl.style.display = 'none';
}

function toggleLoading(isLoading) {
  if (!state.statusEl) return;
  state.statusEl.textContent = isLoading ? 'Загружаем данные…' : '';
}

function showStatus(message, isError = false) {
  if (!state.statusEl) return;
  state.statusEl.textContent = message;
  state.statusEl.style.color = isError ? 'var(--danger)' : 'var(--muted)';
}

// escapeHtml, formatBiography, renderMediaThumbnail теперь импортируются из hero-utils.js

function attachAvatarUploader(hero) {
  const container = state.detailEl?.querySelector('[data-avatar]');
  if (!container) return;

  container.addEventListener('click', async (e) => {
    // Не обрабатываем клик, если кликнули на кнопку добавления медиа или удаления
    if (e.target.closest('[data-action="add-media"]') || 
        e.target.closest('[data-action="delete-avatar"]')) {
      return;
    }
    
    e.preventDefault();
    e.stopPropagation();
    const file = await pickFile({ accept: 'image/*' });
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      showStatus('Фото слишком большое (максимум 10MB)', true);
      return;
    }
    const base64 = await fileToBase64(file);
    await saveField('photo_base64', base64, hero);
  });
}

function attachAvatarDelete(hero) {
  const deleteBtn = state.detailEl?.querySelector('[data-action="delete-avatar"]');
  if (!deleteBtn) return;

  deleteBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!confirm('Удалить основное фото?')) return;
    
    try {
      showStatus('Удаляем фото…');
      // Удаляем фото, явно передавая null
      // saveField уже вызовет refreshActiveHero после успешного сохранения
      await saveField('photo_base64', null, hero);
      showStatus('Фото удалено');
    } catch (err) {
      console.error('[HeroAdmin] deleteAvatar failed', err);
      showStatus('Не удалось удалить фото', true);
    }
  });
}

function attachHeroDelete(hero) {
  const deleteBtn = state.detailEl?.querySelector('[data-action="delete-hero"]');
  if (!deleteBtn) return;

  deleteBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    const heroName = hero.full_name || 'Без имени';
    if (!confirm(`Удалить карточку "${heroName}"? Это действие нельзя отменить.`)) return;
    
    await deleteHero(hero.id);
  });
}

async function deleteHero(id) {
  try {
    showStatus('Удаляем карточку…');
    
    const res = await adminFetch(`/api/hero/${id}`, {
      method: 'DELETE'
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || 'Ошибка удаления карточки');
    }

    // Удаляем из локального состояния
    state.heroes = state.heroes.filter(h => h.id !== id);
    state.filtered = state.filtered.filter(h => h.id !== id);
    
    // Если удаляли активную карточку, выбираем другую или показываем placeholder
    if (state.active?.id === id) {
      state.active = null;
      
      // Обновляем список
      renderHeroList();
      
      // Выбираем другую карточку или показываем placeholder
      if (state.filtered.length > 0) {
        await selectHero(state.filtered[0].id);
      } else {
        showPlaceholder('Карточки не найдены. Добавьте первые записи.');
      }
    } else {
      // Просто обновляем список
      renderHeroList();
    }
    
    showStatus('Карточка удалена');
  } catch (err) {
    console.error('[HeroAdmin] deleteHero failed', err);
    showStatus('Не удалось удалить карточку: ' + (err.message || 'Неизвестная ошибка'), true);
  }
}

function attachMediaUploader(hero) {
  const addBtn = state.detailEl?.querySelector('[data-action="add-media"]');
  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      const file = await pickFile({ accept: 'image/*,video/*' });
      if (!file) return;
      const isVideo = file.type.startsWith('video');
      const limit = isVideo ? 200 * 1024 * 1024 : 10 * 1024 * 1024;
      if (file.size > limit) {
        showStatus(`Файл слишком большой (макс ${isVideo ? '200MB' : '10MB'})`, true);
        return;
      }
      const base64 = await fileToBase64(file);
      await uploadMedia(hero.id, {
        type: isVideo ? 'video' : 'photo',
        media_base64: base64,
        caption: file.name.replace(/\.[^.]+$/, '') || (isVideo ? 'Видео' : 'Фото'),
      });
    });
  }

  // Обработчики удаления медиа (и для миниатюр, и для обычного списка)
  state.detailEl?.querySelectorAll('[data-action="remove-media"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const mediaId = Number(btn.dataset.id);
      if (!Number.isFinite(mediaId)) return;
      if (!confirm('Удалить материал?')) return;
      await deleteMedia(mediaId);
    });
  });
}

async function uploadMedia(heroId, payload) {
  try {
    showStatus('Загружаем материал…');
    const response = await adminFetch(`/api/hero/${heroId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }
    
    await refreshActiveHero(heroId);
    showStatus('Материал добавлен');
  } catch (err) {
    console.error('[HeroAdmin] uploadMedia failed', err, { heroId, payload });
    showStatus(`Не удалось добавить материал: ${err.message}`, true);
  }
}

async function deleteMedia(mediaId) {
  try {
    showStatus('Удаляем материал…');
    await adminFetch(`/api/hero/media/${mediaId}`, { method: 'DELETE' });
    await refreshActiveHero(state.active.id);
    showStatus('Материал удалён');
  } catch (err) {
    console.error('[HeroAdmin] deleteMedia failed', err);
    showStatus('Не удалось удалить материал', true);
  }
}

async function pickFile({ accept }) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      resolve(input.files?.[0] || null);
    };
    input.click();
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

