import { ensureAuth, adminFetch, logout } from '../../js/admin/auth.js';
import { 
  escapeHtml, 
  normalizeString, 
  formatBiography, 
  renderMediaThumbnail,
  setHTML,
  showLoadingState,
  showErrorState,
  validateFileType,
  validateFileSize,
  FILE_LIMITS,
  debounce,
  fetchWithRetry
} from './hero-utils.js';

// Определяем режим разработки для браузера
const IS_DEV = window.location.hostname === 'localhost' || 
               window.location.hostname === '127.0.0.1' ||
               window.location.hostname.includes('.local');

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
  activeEditor: null, // Информация об активном редакторе { field, node }
  savingFields: new Map(), // Очередь сохранений полей для предотвращения race condition
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
    if (IS_DEV) {
      console.error('[HeroAdmin] auth error', err);
    }
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
  const importBtn = document.getElementById('importBtn');
  const importFileInput = document.getElementById('importFileInput');
  if (importBtn && importFileInput) {
    importBtn.addEventListener('click', () => {
      importFileInput.click();
    });
    importFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        await importHeroesFromFile(file);
      } catch (error) {
        showErrorState(state.statusEl, `Ошибка импорта: ${error.message}`, true);
      } finally {
        importFileInput.value = '';
      }
    });
  }
  const importDbBtn = document.getElementById('importDbBtn');
  const importDbFileInput = document.getElementById('importDbFileInput');
  if (importDbBtn && importDbFileInput) {
    importDbBtn.addEventListener('click', () => {
      importDbFileInput.click();
    });
    importDbFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        await importDatabaseFile(file);
      } catch (error) {
        showStatus(`Ошибка импорта БД: ${error.message}`, true);
      } finally {
        importDbFileInput.value = '';
      }
    });
  }
}

async function importHeroesFromFile(file) {
  const formData = new FormData();
  formData.append('file', file);

  showStatus('Импорт данных...');

  try {
    const response = await adminFetch('/api/hero/import', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || 'Ошибка импорта');
    }

    const result = await response.json();
    
    const message = `Импорт завершен: добавлено ${result.added}, обновлено ${result.updated}, ошибок: ${result.errors}`;
    showStatus(message);

    if (result.errorMessages && result.errorMessages.length > 0) {
      if (IS_DEV) {
        console.warn('Ошибки импорта:', result.errorMessages);
      }
      if (result.errorMessages.length > 0) {
        showStatus(`${message}. Первые ошибки: ${result.errorMessages.slice(0, 3).join('; ')}`);
      }
    }

    await loadHeroes();
  } catch (error) {
    throw error;
  }
}

async function importDatabaseFile(file) {
  const formData = new FormData();
  formData.append('file', file);

  showStatus('Импортируем базу данных…');

  try {
    const response = await adminFetch('/api/hero/import-database', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || 'Ошибка импорта базы данных');
    }

    const result = await response.json();
    showStatus(result.message || 'База данных импортирована. Перезапустите сервер при необходимости.');
    await loadHeroes();
  } catch (error) {
    throw error;
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
    if (IS_DEV) {
      console.error('[HeroAdmin] exportDatabase failed', err);
    }
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
    if (IS_DEV) {
      console.error('[HeroAdmin] load heroes failed', err);
    }
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
  
  // Используем debounce для оптимизации поиска (300ms задержка)
  const debouncedSearch = debounce((term) => {
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
  }, 300);
  
  state.searchEl.addEventListener('input', (e) => {
    const term = e.target.value.trim();
    debouncedSearch(term);
  });
}

async function selectHero(id) {
  if (!Number.isFinite(id) || state.active?.id === id) return;
  try {
    toggleLoading(true);
    // Сохраняем ID предыдущей карточки для проверки в renderHeroDetail
    const previousHeroId = state.active?.id;
    
    // Закрываем активный редактор, если он открыт, чтобы сохранить изменения
    if (state.activeEditor && state.activeEditor.heroId === previousHeroId) {
      const activeNode = state.detailEl?.querySelector(`[data-edit="${state.activeEditor.field}"]`);
      if (activeNode && activeNode.dataset.editing === 'true') {
        const wrapper = activeNode.nextElementSibling;
        if (wrapper) {
          const editor = wrapper.querySelector('input, textarea');
          if (editor) {
            // Сохраняем текущее поле перед переключением
            editor.blur();
            // Ждем немного, чтобы blur успел обработаться
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }
      }
    }
    
    const hero = await fetchHero(id);
    // Устанавливаем state.active только после получения данных, но перед renderHeroDetail
    state.active = hero;
    renderHeroDetail(hero, previousHeroId);
    highlightActive(id);
  } catch (err) {
    if (IS_DEV) {
      console.error('[HeroAdmin] select hero failed', err);
    }
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
    
    // Закрываем активный редактор, если он открыт, чтобы сохранить изменения
    if (state.activeEditor) {
      const activeNode = state.detailEl?.querySelector(`[data-edit="${state.activeEditor.field}"]`);
      if (activeNode && activeNode.dataset.editing === 'true') {
        const wrapper = activeNode.nextElementSibling;
        if (wrapper) {
          const editor = wrapper.querySelector('input, textarea');
          if (editor) {
            // Сохраняем текущее поле перед созданием новой карточки
            editor.blur();
            // Ждем немного, чтобы blur успел обработаться
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }
      }
    }
    
    // Очищаем активную карточку перед созданием новой, чтобы не сохранялись старые значения
    state.active = null;
    state.activeEditor = null;
    
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
    if (IS_DEV) {
      console.error('[HeroAdmin] createNewHero failed', err);
    }
    showStatus('Не удалось создать карточку: ' + (err.message || 'Неизвестная ошибка'), true);
  }
}

function renderHeroDetail(hero, previousHeroId = null) {
  // Сохраняем информацию об активном редакторе перед перерисовкой
  const wasEditing = state.activeEditor && state.activeEditor.heroId === hero.id 
    ? { field: state.activeEditor.field }
    : null;
  
  // Сохраняем текущие значения всех редактируемых полей перед перерисовкой
  // Только если это та же карточка (не переключение на другую)
  // previousHeroId позволяет определить, переключаемся ли мы на другую карточку
  const savedFieldValues = {};
  const isSameHero = previousHeroId === null || previousHeroId === hero.id;
  if (state.detailEl && isSameHero && state.active && state.active.id === hero.id) {
    // Сначала берем значения из state.active (могут быть несохраненные изменения)
    const activeFields = ['full_name', 'birth_year', 'death_year', 'rank', 'biography'];
    activeFields.forEach((fieldName) => {
      if (state.active[fieldName] !== undefined && state.active[fieldName] !== null) {
        savedFieldValues[fieldName] = state.active[fieldName];
      }
    });
    
    // Затем обновляем значения из DOM, если поле редактируется
    state.detailEl.querySelectorAll('[data-edit]').forEach((fieldNode) => {
      const fieldName = fieldNode.dataset.edit;
      // Если поле редактируется, берем значение из редактора (приоритет)
      if (fieldNode.dataset.editing === 'true') {
        const wrapper = fieldNode.nextElementSibling;
        if (wrapper) {
          const editor = wrapper.querySelector('input, textarea');
          if (editor && editor.value !== undefined) {
            savedFieldValues[fieldName] = editor.value;
          }
        }
      } else {
        // Иначе берем текущее значение из DOM, если оно отличается от state.active
        if (fieldName === 'biography') {
          // Для биографии нужно извлечь текст из HTML
          const text = fieldNode.textContent || fieldNode.innerText || '';
          const domValue = text.trim();
          // Сохраняем только если значение в DOM отличается от state.active
          if (domValue && domValue !== (state.active[fieldName] || '')) {
            savedFieldValues[fieldName] = domValue;
          }
        } else {
          const domValue = fieldNode.textContent?.trim() || '';
          // Сохраняем только если значение в DOM отличается от state.active
          if (domValue && domValue !== (state.active[fieldName] || '')) {
            savedFieldValues[fieldName] = domValue;
          }
        }
      }
    });
  }
  
  // Очищаем активный редактор перед перерисовкой
  state.activeEditor = null;
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
                <div class="hero-years">
                  <span data-edit="birth_year" data-type="text" data-placeholder="Дата рождения" class="${!hero.birth_year || hero.birth_year === '?' ? 'hero-field-placeholder' : ''}">
                    ${escapeHtml(hero.birth_year || 'Дата рождения')}
                  </span>
                  <span>–</span>
                  <span data-edit="death_year" data-type="text" data-placeholder="н.в." class="${!hero.death_year || hero.death_year === 'н.в.' ? 'hero-field-placeholder' : ''}">
                    ${escapeHtml(hero.death_year || 'н.в.')}
                  </span>
                </div>
                <div class="hero-rank">
                  <span data-edit="rank" data-type="text" data-placeholder="Без звания" class="${!hero.rank || hero.rank === '—' ? 'hero-field-placeholder' : ''}">
                    ${escapeHtml(hero.rank || 'Без звания')}
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
  
  // Проверка наличия элемента биографии (без логирования в продакшене)
  const bioEl = state.detailEl.querySelector('.hero-scroll__bio');
  // Проверка наличия элемента биографии (без логирования в продакшене)
  if (!bioEl && IS_DEV) {
    console.warn('[HeroAdmin] Элемент .hero-scroll__bio не найден после рендеринга!');
  }

  attachInlineEditors(hero);
  attachAvatarUploader(hero);
  attachMediaUploader(hero);
  attachLightboxHandlers(hero);
  attachAvatarDelete(hero);
  attachHeroDelete(hero);
  
  // Восстанавливаем сохраненные значения полей, если они были изменены пользователем
  if (Object.keys(savedFieldValues).length > 0 && state.active?.id === hero.id) {
    Object.entries(savedFieldValues).forEach(([fieldName, savedValue]) => {
      const fieldNode = state.detailEl?.querySelector(`[data-edit="${fieldName}"]`);
      if (fieldNode && fieldNode.dataset.editing !== 'true') {
        // Получаем значение из hero (из базы данных)
        const heroValue = hero[fieldName] || '';
        const heroValueNormalized = fieldName === 'biography' 
          ? (heroValue || '').trim()
          : (heroValue || '').trim();
        const savedValueNormalized = (savedValue || '').trim();
        
        // Если сохраненное значение отличается от значения в hero, 
        // значит пользователь ввел текст, но не сохранил - восстанавливаем его
        if (savedValueNormalized !== heroValueNormalized) {
          if (fieldName === 'biography') {
            setHTML(fieldNode, formatBiography(savedValueNormalized || ''));
          } else {
            const placeholder = fieldNode.dataset.placeholder || '';
            const displayValue = savedValueNormalized || placeholder;
            fieldNode.textContent = displayValue;
            
            // Добавляем/убираем класс placeholder для полей дат и звания
            if (['birth_year', 'death_year', 'rank'].includes(fieldName)) {
              let isEmpty = false;
              if (fieldName === 'birth_year') {
                isEmpty = !savedValueNormalized || savedValueNormalized === '?' || savedValueNormalized === 'Дата рождения' || savedValueNormalized === placeholder;
                if (isEmpty && (!savedValueNormalized || savedValueNormalized === '?')) {
                  fieldNode.textContent = placeholder;
                }
              } else if (fieldName === 'death_year') {
                // Для death_year "н.в." - это валидное значение, не placeholder
                isEmpty = !savedValueNormalized || savedValueNormalized === placeholder;
                if (isEmpty && !savedValueNormalized) {
                  fieldNode.textContent = placeholder;
                }
              } else if (fieldName === 'rank') {
                isEmpty = !savedValueNormalized || savedValueNormalized === '—' || savedValueNormalized === 'Без звания' || savedValueNormalized === placeholder;
                if (isEmpty && (!savedValueNormalized || savedValueNormalized === '—')) {
                  fieldNode.textContent = placeholder;
                }
              }
              
              if (isEmpty) {
                fieldNode.classList.add('hero-field-placeholder');
              } else {
                fieldNode.classList.remove('hero-field-placeholder');
              }
            }
          }
          // Обновляем локальное состояние
          state.active = { ...state.active, [fieldName]: savedValueNormalized || null };
        }
      }
    });
  }
  
  // Восстанавливаем активный редактор, если он был до перерисовки
  if (wasEditing) {
    const fieldNode = state.detailEl?.querySelector(`[data-edit="${wasEditing.field}"]`);
    if (fieldNode) {
      // Небольшая задержка для стабильности
      setTimeout(() => {
        startInlineEdit(fieldNode, hero);
      }, 100);
    }
  }
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

  // Фиксируем размеры экрана при открытии
  const screenWidth = window.innerWidth;
  const screenHeight = window.innerHeight;
  const maxWidth = screenWidth - 100;
  const maxHeight = screenHeight - 200;

  const lightboxHTML = `
    <div class="lightbox-overlay" data-action="${isLast ? 'close' : 'next'}">
      <button class="lightbox-close" data-action="close" title="Закрыть">✕</button>
      <div class="lightbox-content" data-action="${isLast ? 'close' : 'next'}">
        ${
          media.type === 'photo'
            ? `<img src="${media.media_base64 || media.url}" alt="${escapeHtml(media.caption || '')}" style="max-width: ${maxWidth}px; max-height: ${maxHeight}px; width: auto; height: auto; object-fit: contain;"/>`
            : `<video src="${media.media_base64 || media.url}" controls autoplay style="max-width: ${maxWidth}px; max-height: ${maxHeight}px; width: auto; height: auto; object-fit: contain;"></video>`
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
  
  // Принудительное масштабирование изображения после загрузки
  const img = lightboxEl.querySelector('img');
  const video = lightboxEl.querySelector('video');
  const mediaEl = img || video;
  
  if (mediaEl) {
    // Используем зафиксированные размеры экрана через замыкание
    const fixedMaxWidth = maxWidth;
    const fixedMaxHeight = maxHeight;
    
    // Сразу устанавливаем максимальные размеры, чтобы медиа не рендерилось в полном размере
    mediaEl.style.maxWidth = fixedMaxWidth + 'px';
    mediaEl.style.maxHeight = fixedMaxHeight + 'px';
    mediaEl.style.width = 'auto';
    mediaEl.style.height = 'auto';
    mediaEl.style.objectFit = 'contain';
    
    const scaleMedia = function() {
      let mediaWidth, mediaHeight;
      
      if (this.tagName === 'IMG') {
        // Для изображений
        if (this.naturalWidth === 0 || this.naturalHeight === 0) {
          setTimeout(() => scaleMedia.call(this), 50);
          return;
        }
        mediaWidth = this.naturalWidth;
        mediaHeight = this.naturalHeight;
      } else {
        // Для видео
        if (this.videoWidth === 0 || this.videoHeight === 0) {
          setTimeout(() => scaleMedia.call(this), 50);
          return;
        }
        mediaWidth = this.videoWidth;
        mediaHeight = this.videoHeight;
      }
      
      // Вычисляем масштаб для подгонки под экран
      const scaleX = fixedMaxWidth / mediaWidth;
      const scaleY = fixedMaxHeight / mediaHeight;
      const scale = Math.min(scaleX, scaleY, 1); // Не увеличиваем маленькие медиа
      
      // Устанавливаем размеры принудительно
      const newWidth = Math.floor(mediaWidth * scale);
      const newHeight = Math.floor(mediaHeight * scale);
      
      // Принудительно устанавливаем размеры
      this.style.width = newWidth + 'px';
      this.style.height = newHeight + 'px';
      this.style.maxWidth = fixedMaxWidth + 'px';
      this.style.maxHeight = fixedMaxHeight + 'px';
      this.style.minWidth = '0';
      this.style.minHeight = '0';
      this.style.objectFit = 'contain';
    };
    
    if (mediaEl.tagName === 'IMG') {
      if (mediaEl.complete) {
        scaleMedia.call(mediaEl);
      } else {
        mediaEl.addEventListener('load', scaleMedia, { once: true });
      }
    } else {
      mediaEl.addEventListener('loadedmetadata', scaleMedia, { once: true });
    }
  }
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
  // Удаляем старые обработчики перед добавлением новых для предотвращения утечек памяти
  state.detailEl.querySelectorAll('[data-edit]').forEach((node) => {
    // Сохраняем данные атрибута перед удалением обработчиков
    const editField = node.dataset.edit;
    
    // Удаляем старый обработчик, если он был сохранен
    if (node._inlineEditorHandler) {
      node.removeEventListener('click', node._inlineEditorHandler);
    }
    
    // Создаем новый обработчик
    const handler = (e) => {
      // Если уже редактируется другое поле, сначала сохраняем его
      if (state.activeEditor && state.activeEditor.field !== editField) {
        const activeNode = state.detailEl.querySelector(`[data-edit="${state.activeEditor.field}"]`);
        if (activeNode && activeNode.dataset.editing === 'true') {
          // Находим активный редактор и помечаем, что переключаемся на другое поле
          const activeWrapper = activeNode.nextElementSibling;
          if (activeWrapper) {
            const activeEditor = activeWrapper.querySelector('input, textarea');
            if (activeEditor) {
              activeEditor._switchingToAnotherField = true;
              // Вызываем blur для сохранения текущего поля
              activeEditor.blur();
            }
          }
          e.preventDefault();
          e.stopPropagation();
          // Небольшая задержка перед открытием нового редактора
          setTimeout(() => {
            startInlineEdit(node, hero);
          }, 100);
          return;
        }
      }
      startInlineEdit(node, hero);
    };
    
    // Сохраняем ссылку на обработчик для последующего удаления
    node._inlineEditorHandler = handler;
    node.addEventListener('click', handler);
  });
}

function startInlineEdit(node, hero) {
  if (node.dataset.editing === 'true') return;
  node.dataset.editing = 'true';
  
  // Сохраняем информацию об активном редакторе
  state.activeEditor = {
    field: node.dataset.edit,
    node: node,
    heroId: hero.id
  };

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
    } else {
      // Для полей дат используем реальную длину + небольшой запас для комфорта
      if (field === 'birth_year' || field === 'death_year') {
        textLength = Math.max(textLength, 4); // Минимум 4 символа, но не ограничиваем максимум
        textLength = Math.max(textLength + 1, 4); // Добавляем небольшой запас
      }
    }
    // Устанавливаем size строго по реальной длине
    editor.setAttribute('size', textLength);
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
      } else {
        // Для полей дат используем реальную длину + небольшой запас для комфорта
        if (field === 'birth_year' || field === 'death_year') {
          textLength = Math.max(textLength + 1, 4); // Добавляем запас, минимум 4 символа
        }
      }
      editor.setAttribute('size', textLength);
    };
    editor.addEventListener('input', adjustSize);
    
    // Сохраняем обработчик для удаления при завершении
    editor._adjustSizeHandler = adjustSize;
    
    // Вызываем adjustSize сразу для установки правильного размера при открытии
    adjustSize();
  }

  // Флаг для предотвращения закрытия при клике внутри редактора
  let isClickingInside = false;
  let blurTimeout = null;

  const finish = async (commit) => {
    // Очищаем таймаут blur, если он был установлен
    if (blurTimeout) {
      clearTimeout(blurTimeout);
      blurTimeout = null;
    }
    
    editor.removeEventListener('keydown', onKeydown);
    editor.removeEventListener('blur', onBlur);
    if (editor._adjustSizeHandler) {
      editor.removeEventListener('input', editor._adjustSizeHandler);
    }
    if (editor._onMouseDownHandler) {
      document.removeEventListener('mousedown', editor._onMouseDownHandler);
    }
    wrapper.remove();
    node.style.display = '';
    node.dataset.editing = 'false';

    // Сохраняем значение перед сохранением
    const savedValue = editor.value;
    
    // Не восстанавливаем текущий редактор после сохранения.
    // При переключении на другое поле его откроет обработчик attachInlineEditors.
    const shouldRestore = false;
 
    // Очищаем активный редактор перед сохранением
    state.activeEditor = null;

    // Сохраняем всегда при commit (при blur или Enter)
    if (commit) {
      try {
        await saveField(field, savedValue, hero, shouldRestore);
      } catch (err) {
        // Если ошибка при сохранении, логируем
        console.error('[HeroAdmin] saveField failed in finish', err, { field, savedValue });
        // Не пробрасываем ошибку дальше, чтобы не блокировать закрытие редактора
        // Ошибка уже обработана в saveField и показана пользователю
      }
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

  const onMouseDown = (event) => {
    // Проверяем, был ли клик внутри wrapper или editor
    if (wrapper.contains(event.target) || editor.contains(event.target)) {
      isClickingInside = true;
      // Сбрасываем флаг через небольшую задержку
      setTimeout(() => {
        isClickingInside = false;
      }, 100);
    } else {
      isClickingInside = false;
      // Проверяем, был ли клик на другое поле редактирования
      const clickedEditField = event.target.closest('[data-edit]');
      if (clickedEditField && clickedEditField !== node) {
        // Клик на другое поле - помечаем это для восстановления нового редактора
        editor._switchingToAnotherField = true;
      } else {
        // Клик вне всех полей редактирования - не восстанавливаем редактор
        editor._switchingToAnotherField = false;
      }
    }
  };

  const onBlur = () => {
    // Отменяем предыдущий таймаут, если он был
    if (blurTimeout) {
      clearTimeout(blurTimeout);
    }
    
    // Добавляем небольшую задержку перед закрытием, чтобы клик успел обработаться
    blurTimeout = setTimeout(async () => {
      // Проверяем, что редактор все еще активен (не был закрыт другим способом)
      // Также проверяем, что wrapper еще существует (не был удален)
      if (node.dataset.editing === 'true' && wrapper && wrapper.parentNode) {
        // Всегда сохраняем при blur, если редактор еще активен
        try {
          await finish(true);
        } catch (err) {
          // Ошибка уже обработана в saveField, но на всякий случай логируем
          console.error('[HeroAdmin] finish failed in onBlur', err);
          // Ошибка уже показана пользователю в saveField
        }
      }
    }, 150);
  };

  // Добавляем обработчик mousedown на document для отслеживания кликов
  document.addEventListener('mousedown', onMouseDown);
  
  // Сохраняем обработчик для удаления при завершении
  editor._onMouseDownHandler = onMouseDown;

  editor.addEventListener('keydown', onKeydown);
  editor.addEventListener('blur', onBlur);
  
  // Также предотвращаем закрытие при клике на wrapper
  wrapper.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    isClickingInside = true;
    // Сбрасываем флаг через задержку, чтобы не блокировать последующие blur
    setTimeout(() => {
      isClickingInside = false;
    }, 200); // Немного больше, чем задержка blur (150ms)
  });
}

async function saveField(field, rawValue, hero, restoreEditor = false) {
  // Используем актуальные данные из state.active, если они есть
  // Это важно, чтобы не потерять недавно сохраненные изменения других полей
  const currentHero = state.active && state.active.id === hero.id ? state.active : hero;
  
  // Создаем уникальный ключ для поля
  const saveKey = `${currentHero.id}_${field}`;
  
  // Если уже идет сохранение этого поля, отменяем предыдущее и ставим новое в очередь
  if (state.savingFields.has(saveKey)) {
    const previousSave = state.savingFields.get(saveKey);
    if (previousSave.abortController) {
      previousSave.abortController.abort();
    }
  }
  
  // Создаем новый контроллер для отмены
  const abortController = new AbortController();
  const savePromise = (async () => {
    try {
      // Валидация поля перед сохранением
      const validation = validateHeroField(field, rawValue);
      if (!validation.valid) {
        showStatus(validation.error, true);
        throw new Error(validation.error);
      }
      
      showStatus('Сохраняем изменения…');
      const value = normalizeFieldValue(field, rawValue);
      // Используем currentHero вместо hero, чтобы получить актуальные данные
      const payload = buildPayload(currentHero, { [field]: value }, field);
      
      // Логируем для отладки
      if (IS_DEV) {
        console.log('[HeroAdmin] Saving field', { field, rawValue, normalizedValue: value, payload });
      }
      
      // Используем fetchWithRetry для автоматического повторения при сетевых ошибках
      const response = await fetchWithRetry(
        () => adminFetch(`/api/hero/${currentHero.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: abortController.signal,
        }),
        {
          maxRetries: 3,
          initialDelay: 1000,
          shouldRetry: (error) => {
            // Повторяем только для сетевых ошибок, не для ошибок валидации
            return error.name === 'TypeError' || 
                   error.message?.includes('Failed to fetch') ||
                   (error.status >= 500 && error.status < 600);
          }
        }
      );
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }
      
      // Обновляем локальные данные без полной перерисовки
      state.active = { ...state.active, ...payload };
      updateHeroListItem(currentHero.id, payload);
      
      // Специальная обработка для photo_base64 - обновляем изображение
      if (field === 'photo_base64') {
        const avatarContainer = state.detailEl?.querySelector('[data-avatar]');
        if (avatarContainer) {
          if (value) {
            // Если есть фото, показываем его
            const existingImg = avatarContainer.querySelector('.hero-photo');
            const existingDeleteBtn = avatarContainer.querySelector('[data-action="delete-avatar"]');
            const placeholder = avatarContainer.querySelector('div');
            
            if (existingImg) {
              // Обновляем существующее изображение
              existingImg.src = value;
            } else {
              // Создаем новое изображение
              if (placeholder) {
                placeholder.remove();
              }
              const img = document.createElement('img');
              img.src = value;
              img.className = 'hero-photo';
              img.alt = escapeHtml(state.active.full_name || '');
              
              const deleteBtn = document.createElement('button');
              deleteBtn.className = 'hero-avatar-delete';
              deleteBtn.setAttribute('data-action', 'delete-avatar');
              deleteBtn.title = 'Удалить фото';
              deleteBtn.textContent = '×';
              
              avatarContainer.appendChild(img);
              avatarContainer.appendChild(deleteBtn);
              
              // Перепривязываем обработчики после небольшой задержки, чтобы DOM обновился
              setTimeout(() => {
                attachAvatarDelete(state.active);
              }, 0);
            }
            
            // Убеждаемся, что кнопка удаления есть (если её еще нет)
            if (!existingDeleteBtn && !avatarContainer.querySelector('[data-action="delete-avatar"]')) {
              const deleteBtn = document.createElement('button');
              deleteBtn.className = 'hero-avatar-delete';
              deleteBtn.setAttribute('data-action', 'delete-avatar');
              deleteBtn.title = 'Удалить фото';
              deleteBtn.textContent = '×';
              avatarContainer.appendChild(deleteBtn);
              // Перепривязываем обработчики после небольшой задержки, чтобы DOM обновился
              setTimeout(() => {
                attachAvatarDelete(state.active);
              }, 0);
            }
          } else {
            // Если фото удалено, показываем placeholder
            const existingImg = avatarContainer.querySelector('.hero-photo');
            const existingDeleteBtn = avatarContainer.querySelector('[data-action="delete-avatar"]');
            
            if (existingImg) {
              existingImg.remove();
            }
            if (existingDeleteBtn) {
              existingDeleteBtn.remove();
            }
            
            // Проверяем, есть ли уже placeholder
            if (!avatarContainer.querySelector('div')) {
              const placeholder = document.createElement('div');
              placeholder.style.cssText = 'display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--muted); height: 100%; min-height: clamp(320px, 60vh, 520px);';
              placeholder.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.5;">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                  <circle cx="8.5" cy="8.5" r="1.5"></circle>
                  <polyline points="21 15 16 10 5 21"></polyline>
                </svg>
                <strong style="font-size: 1.1rem;">НЕТ ФОТО</strong>
                <span style="font-size: 0.9rem;">Нажмите, чтобы загрузить</span>
              `;
              avatarContainer.appendChild(placeholder);
            }
          }
        }
      } else {
        // Обновляем только измененное поле в DOM без полной перерисовки
        const fieldNode = state.detailEl?.querySelector(`[data-edit="${field}"]`);
        if (fieldNode) {
          // Обновляем текст поля, если оно не редактируется
          if (fieldNode.dataset.editing !== 'true') {
            if (field === 'biography') {
              // Используем безопасный метод setHTML вместо innerHTML для предотвращения XSS
              setHTML(fieldNode, formatBiography(value || ''));
            } else {
              // Для пустых значений показываем placeholder или пустую строку
              const placeholder = fieldNode.dataset.placeholder || '';
              const displayValue = value || placeholder;
              fieldNode.textContent = displayValue;
              
              // Добавляем/убираем класс placeholder для полей дат и звания
              if (['birth_year', 'death_year', 'rank'].includes(field)) {
                // Определяем, является ли значение пустым или placeholder
                let isEmpty = false;
                if (field === 'birth_year') {
                  isEmpty = !value || value === '?' || value === 'Дата рождения' || value === placeholder;
                  if (isEmpty && (!value || value === '?')) {
                    fieldNode.textContent = placeholder;
                  }
                } else if (field === 'death_year') {
                  // Для death_year "н.в." - это валидное значение, не placeholder
                  isEmpty = !value || value === placeholder;
                  if (isEmpty && !value) {
                    fieldNode.textContent = placeholder;
                  }
                } else if (field === 'rank') {
                  isEmpty = !value || value === '—' || value === 'Без звания' || value === placeholder;
                  if (isEmpty && (!value || value === '—')) {
                    fieldNode.textContent = placeholder;
                  }
                }
                
                if (isEmpty) {
                  fieldNode.classList.add('hero-field-placeholder');
                } else {
                  fieldNode.classList.remove('hero-field-placeholder');
                }
              }
            }
          }
        }
      }
      
      showStatus('Изменения сохранены');
      
      // Если нужно восстановить редактор (при переключении между полями)
      if (restoreEditor && fieldNode) {
        // Небольшая задержка, чтобы DOM успел обновиться
        setTimeout(() => {
          startInlineEdit(fieldNode, state.active);
        }, 50);
      }
    } catch (err) {
      // Игнорируем ошибки отмены
      if (err.name === 'AbortError') {
        return;
      }
      if (IS_DEV) {
        console.error('[HeroAdmin] saveField failed', err, { field, heroId: currentHero?.id });
      }
      showStatus(`Не удалось сохранить изменения: ${err.message}`, true);
      throw err;
    } finally {
      // Удаляем из очереди сохранений
      state.savingFields.delete(saveKey);
    }
  })();
  
  // Сохраняем промис и контроллер в очередь
  state.savingFields.set(saveKey, { promise: savePromise, abortController });
  
  return savePromise;
}

/**
 * Валидация поля перед сохранением
 */
function validateHeroField(field, value) {
  const trimmed = value?.toString().trim() ?? '';
  
  // Для photo_base64 и media_base64 не валидируем здесь
  if (field === 'photo_base64' || field === 'media_base64') {
    return { valid: true };
  }
  
  // Валидация длины полей
  if (field === 'full_name') {
    if (trimmed.length > 200) {
      return { valid: false, error: 'Имя слишком длинное (максимум 200 символов)' };
    }
    if (trimmed.length < 1) {
      return { valid: false, error: 'Имя не может быть пустым' };
    }
  }
  
  if (field === 'rank') {
    if (trimmed.length > 100) {
      return { valid: false, error: 'Звание слишком длинное (максимум 100 символов)' };
    }
  }
  
  if (field === 'birth_year' || field === 'death_year') {
    // Пустые значения допустимы для дат
    if (!trimmed) {
      return { valid: true };
    }
    // Проверяем формат года (может быть "1480" или "12.12.1480" или "н.в.")
    if (trimmed !== 'н.в.' && trimmed !== '?' && trimmed.length > 50) {
      return { valid: false, error: 'Дата слишком длинная (максимум 50 символов)' };
    }
    // Проверяем, что если это не "н.в." или "?", то содержит хотя бы одну цифру
    if (trimmed !== 'н.в.' && trimmed !== '?' && !/\d/.test(trimmed)) {
      return { valid: false, error: 'Дата должна содержать хотя бы одну цифру' };
    }
  }
  
  if (field === 'biography') {
    if (trimmed.length > 50000) {
      return { valid: false, error: 'Биография слишком длинная (максимум 50000 символов)' };
    }
  }
  
  return { valid: true };
}

function normalizeFieldValue(field, value) {
  // Для photo_base64 и media_base64 не делаем trim, возвращаем как есть или null
  if (field === 'photo_base64' || field === 'media_base64') {
    if (!value || (typeof value === 'string' && value.trim().length === 0)) {
      return null;
    }
    return value;
  }
  
  // Для всех остальных полей делаем trim
  const trimmed = value?.toString().trim() ?? '';
  
  // Для дат сохраняем как текст (может быть формат "12.12.1480" или просто "1480" или пустая строка)
  if (['birth_year', 'death_year'].includes(field)) {
    // Для дат возвращаем пустую строку как null, но сохраняем непустые значения
    return trimmed || null;
  }
  
  // Для остальных полей: пустая строка = null
  // Но для biography и rank пустая строка может быть валидной, поэтому возвращаем null только если действительно пусто
  if (field === 'biography' || field === 'rank') {
    return trimmed || null;
  }
  
  // Для full_name пустая строка недопустима, но это проверяется в валидации
  // Здесь просто возвращаем trimmed или null
  return trimmed || null;
}

function buildPayload(hero, overrides = {}, changedField) {
  const payload = {
    id: hero.id,
    // Используем hasOwnProperty для проверки, что значение явно передано
    full_name: overrides.hasOwnProperty('full_name') ? (overrides.full_name || '') : (hero.full_name ?? ''),
    birth_year: overrides.hasOwnProperty('birth_year') ? overrides.birth_year : (hero.birth_year ?? null),
    death_year: overrides.hasOwnProperty('death_year') ? overrides.death_year : (hero.death_year ?? null),
    rank: overrides.hasOwnProperty('rank') ? overrides.rank : (hero.rank ?? null),
    // Если photo_base64 явно передан (включая null для удаления), используем его
    photo_base64: overrides.hasOwnProperty('photo_base64') ? overrides.photo_base64 : (hero.photo_base64 ?? null),
    biography: overrides.hasOwnProperty('biography') ? overrides.biography : (hero.biography ?? null),
  };

  if (Array.isArray(hero.media) && hero.media.length > 0 && changedField !== 'media') {
    payload.media = hero.media;
  }

  return payload;
}

async function refreshActiveHero(id) {
  // Сохраняем ID текущей карточки для проверки в renderHeroDetail
  const previousHeroId = state.active?.id;
  const fresh = await fetchHero(id);
  state.active = fresh;
  // Передаем previousHeroId, чтобы не сохранять старые значения при обновлении той же карточки
  renderHeroDetail(fresh, previousHeroId);
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

/**
 * Модальное окно подтверждения (замена confirm)
 */
function showConfirmModal(message, title = 'Подтверждение') {
  return new Promise((resolve) => {
    // Создаем overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    `;
    
    // Создаем модальное окно
    const modal = document.createElement('div');
    modal.style.cssText = `
      background: var(--bg, #1a1a1a);
      border-radius: var(--radius-md, 8px);
      padding: 24px;
      max-width: 400px;
      width: 90%;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    `;
    
    modal.innerHTML = `
      <h3 style="margin: 0 0 16px 0; font-size: 1.25rem; color: var(--text, #fff);">${escapeHtml(title)}</h3>
      <p style="margin: 0 0 24px 0; color: var(--text-secondary, #aaa); line-height: 1.5;">${escapeHtml(message)}</p>
      <div style="display: flex; gap: 12px; justify-content: flex-end;">
        <button id="modal-cancel" class="meta-lg" style="background: transparent; border: 1px solid var(--border, #333);">Отмена</button>
        <button id="modal-confirm" class="meta-lg danger" style="background: var(--danger, #ef4444); border: none; color: #fff;">Подтвердить</button>
      </div>
    `;
    
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    // Обработчики
    const handleCancel = () => {
      document.body.removeChild(overlay);
      resolve(false);
    };
    
    const handleConfirm = () => {
      document.body.removeChild(overlay);
      resolve(true);
    };
    
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        handleCancel();
      }
    };
    
    modal.querySelector('#modal-cancel').addEventListener('click', handleCancel);
    modal.querySelector('#modal-confirm').addEventListener('click', handleConfirm);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        handleCancel();
      }
    });
    document.addEventListener('keydown', handleEscape);
    
    // Удаляем обработчик Escape после закрытия
    const originalHandleEscape = handleEscape;
    const cleanup = () => {
      document.removeEventListener('keydown', originalHandleEscape);
    };
    
    modal.querySelector('#modal-cancel').addEventListener('click', cleanup, { once: true });
    modal.querySelector('#modal-confirm').addEventListener('click', cleanup, { once: true });
  });
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
    
    // Валидация типа файла
    const typeValidation = await validateFileType(file, 'image');
    if (!typeValidation.valid) {
      showStatus(typeValidation.error, true);
      return;
    }
    
    // Валидация размера файла
    const sizeValidation = validateFileSize(file, false);
    if (!sizeValidation.valid) {
      showStatus(sizeValidation.error, true);
      return;
    }
    
    // Показываем прогресс загрузки
    showStatus('Конвертируем файл…');
    const base64 = await fileToBase64(file, (percent) => {
      showStatus(`Конвертируем файл… ${Math.round(percent)}%`);
    });
    
    // Проверка размера base64
    if (base64.length > FILE_LIMITS.PHOTO_MAX_SIZE * FILE_LIMITS.BASE64_OVERHEAD) {
      showStatus('Файл слишком большой после конвертации', true);
      return;
    }
    
    await saveField('photo_base64', base64, hero);
  });
}

function attachAvatarDelete(hero) {
  const deleteBtn = state.detailEl?.querySelector('[data-action="delete-avatar"]');
  if (!deleteBtn) return;

  deleteBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    const confirmed = await showConfirmModal('Удалить основное фото?', 'Удаление фото');
    if (!confirmed) return;
    
    try {
      showStatus('Удаляем фото…');
      // Удаляем фото, явно передавая null
      // saveField уже вызовет refreshActiveHero после успешного сохранения
      await saveField('photo_base64', null, hero);
      showStatus('Фото удалено');
    } catch (err) {
      if (IS_DEV) {
        console.error('[HeroAdmin] deleteAvatar failed', err);
      }
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
    const confirmed = await showConfirmModal(
      `Удалить карточку "${escapeHtml(heroName)}"? Это действие нельзя отменить.`,
      'Удаление карточки'
    );
    if (!confirmed) return;
    
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
    if (IS_DEV) {
      console.error('[HeroAdmin] deleteHero failed', err);
    }
    showStatus('Не удалось удалить карточку: ' + (err.message || 'Неизвестная ошибка'), true);
  }
}

function attachMediaUploader(hero) {
  const addBtn = state.detailEl?.querySelector('[data-action="add-media"]');
  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      const files = await pickFile({ accept: 'image/*,video/*', multiple: true });
      if (!files || files.length === 0) return;
      
      // Обрабатываем все выбранные файлы
      let successCount = 0;
      let errorCount = 0;
      
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          const isVideo = file.type.startsWith('video');
          const expectedType = isVideo ? 'video' : 'image';
          
          // Валидация типа файла
          const typeValidation = await validateFileType(file, expectedType);
          if (!typeValidation.valid) {
            showStatus(`Файл ${i + 1}/${files.length}: ${typeValidation.error}`, true);
            errorCount++;
            continue;
          }
          
          // Валидация размера файла
          const sizeValidation = validateFileSize(file, isVideo);
          if (!sizeValidation.valid) {
            showStatus(`Файл ${i + 1}/${files.length}: ${sizeValidation.error}`, true);
            errorCount++;
            continue;
          }
          
          // Показываем прогресс загрузки
          showStatus(`Конвертируем файл ${i + 1}/${files.length}…`);
          const base64 = await fileToBase64(file, (percent) => {
            showStatus(`Конвертируем файл ${i + 1}/${files.length}… ${Math.round(percent)}%`);
          });
          
          // Проверка размера base64
          const maxSize = isVideo ? FILE_LIMITS.VIDEO_MAX_SIZE : FILE_LIMITS.PHOTO_MAX_SIZE;
          if (base64.length > maxSize * FILE_LIMITS.BASE64_OVERHEAD) {
            showStatus(`Файл ${i + 1}/${files.length}: слишком большой после конвертации`, true);
            errorCount++;
            continue;
          }
          
          await uploadMedia(hero.id, {
            type: isVideo ? 'video' : 'photo',
            media_base64: base64,
            caption: file.name.replace(/\.[^.]+$/, '') || (isVideo ? 'Видео' : 'Фото'),
          });
          
          successCount++;
        } catch (err) {
          if (IS_DEV) {
            console.error(`[HeroAdmin] Failed to process file ${i + 1}`, err);
          }
          errorCount++;
        }
      }
      
      // Показываем итоговый статус
      if (successCount > 0) {
        if (errorCount > 0) {
          showStatus(`Добавлено: ${successCount}, ошибок: ${errorCount}`);
        } else {
          showStatus(`Добавлено материалов: ${successCount}`);
        }
      } else if (errorCount > 0) {
        showStatus(`Не удалось добавить материалы (${errorCount} ошибок)`, true);
      }
    });
  }

  // Обработчики удаления медиа (и для миниатюр, и для обычного списка)
  state.detailEl?.querySelectorAll('[data-action="remove-media"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const mediaId = Number(btn.dataset.id);
      if (!Number.isFinite(mediaId)) return;
      const confirmed = await showConfirmModal('Удалить материал?', 'Удаление материала');
      if (!confirmed) return;
      await deleteMedia(mediaId);
    });
  });
}

async function uploadMedia(heroId, payload) {
  try {
    showStatus('Загружаем материал…');
    const response = await fetchWithRetry(
      () => adminFetch(`/api/hero/${heroId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      {
        maxRetries: 2, // Меньше попыток для больших файлов
        initialDelay: 2000,
      }
    );
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }
    
    await refreshActiveHero(heroId);
    showStatus('Материал добавлен');
  } catch (err) {
    if (IS_DEV) {
      console.error('[HeroAdmin] uploadMedia failed', err, { heroId });
    }
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
    if (IS_DEV) {
      console.error('[HeroAdmin] deleteMedia failed', err);
    }
    showStatus('Не удалось удалить материал', true);
  }
}

async function pickFile({ accept, multiple = false }) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    if (multiple) {
      input.multiple = true;
    }
    input.onchange = () => {
      if (multiple) {
        // Возвращаем массив всех выбранных файлов
        resolve(input.files ? Array.from(input.files) : []);
      } else {
        // Возвращаем один файл (для обратной совместимости)
        resolve(input.files?.[0] || null);
      }
    };
    input.oncancel = () => {
      resolve(multiple ? [] : null);
    };
    input.click();
  });
}

function fileToBase64(file, onProgress = null) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        const percent = (e.loaded / e.total) * 100;
        onProgress(percent);
      }
    };
    
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

