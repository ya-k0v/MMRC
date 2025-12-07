/**
 * Модальные окна для admin панели
 * @module admin/modal
 */

import { 
  getAndroidIcon, 
  getUsersIcon, 
  getKeyIcon, 
  getLockIcon, 
  getUnlockIcon, 
  getTrashIcon, 
  getSuccessIcon, 
  getSettingsIcon, 
  getDownloadIcon, 
  getCloseIcon 
} from '../shared/svg-icons.js';
import { escapeHtml } from '../shared/utils.js';

const escapeJsStringForAttr = (value) => escapeHtml(JSON.stringify(value ?? ''));

export function showModal(title, content) {
  const overlay = document.getElementById('modalOverlay');
  const modalContent = document.getElementById('modalContent');
  
  if (!overlay || !modalContent) return;
  
  // Очищаем содержимое модального окна безопасным способом
  modalContent.innerHTML = '';
  
  const header = document.createElement('div');
  header.className = 'header';
  header.style.cssText = 'display:flex; justify-content:space-between; align-items:center;';
  
  const titleEl = document.createElement('div');
  titleEl.className = 'title';
  titleEl.style.cssText = 'font-weight:600; font-size:1.1rem; color:var(--text-primary); display:flex; align-items:center; gap:8px;';
  
  // Проверяем, есть ли в заголовке SVG иконка
  const svgMatch = title.match(/<svg[^>]*>[\s\S]*?<\/svg>/i);
  const emojiMatch = title.match(/^[🔔⚙️📱👥🔑✅❌🗑️🔒🔓]/);
  
  if (svgMatch) {
    // Если есть SVG иконка, используем её
    titleEl.insertAdjacentHTML('beforeend', svgMatch[0]);
    // Убираем SVG из заголовка для получения чистого текста
    let cleanTitle = title.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '').trim();
    const titleText = document.createTextNode(cleanTitle);
    titleEl.appendChild(titleText);
  } else if (emojiMatch) {
    // Если есть эмодзи, оставляем его как есть (он будет отображаться как текст)
    const titleText = document.createTextNode(title);
    titleEl.appendChild(titleText);
  } else {
    // Если иконки нет, добавляем иконку настроек по умолчанию
    titleEl.insertAdjacentHTML('beforeend', getSettingsIcon(18));
    const titleText = document.createTextNode(title);
    titleEl.appendChild(titleText);
  }
  
  header.appendChild(titleEl);
  
  const closeBtn = document.createElement('button');
  closeBtn.className = 'secondary';
  closeBtn.onclick = closeModal;
  closeBtn.style.cssText = 'min-width:auto; padding:8px; display:flex; align-items:center; justify-content:center;';
  // getCloseIcon возвращает безопасную SVG иконку из константы
  closeBtn.insertAdjacentHTML('beforeend', getCloseIcon(18));
  
  header.appendChild(closeBtn);
  modalContent.appendChild(header);
  
  const contentDiv = document.createElement('div');
  contentDiv.style.cssText = 'margin-top:var(--space-md);';
  
  // Используем временный контейнер для безопасного парсинга HTML
  // Примечание: вызывающий код должен экранировать пользовательские данные через escapeHtml
  if (content && typeof content === 'string') {
    // Создаем временный контейнер вне DOM для парсинга
    const tempContainer = document.createElement('div');
    // Используем insertAdjacentHTML вместо innerHTML для лучшей безопасности
    // Это все еще требует, чтобы вызывающий код экранировал пользовательские данные
    tempContainer.insertAdjacentHTML('beforeend', content);
    // Перемещаем узлы из временного контейнера
    while (tempContainer.firstChild) {
      contentDiv.appendChild(tempContainer.firstChild);
    }
  } else {
    // Если content не строка, используем textContent
    contentDiv.textContent = content || '';
  }
  
  modalContent.appendChild(contentDiv);
  
  overlay.style.display = 'flex';
  
  // Закрытие по клику на overlay
  overlay.onclick = (e) => {
    if (e.target === overlay) {
      closeModal();
    }
  };
  
  // Закрытие по ESC
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      closeModal();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
}

export function closeModal() {
  const overlay = document.getElementById('modalOverlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

// Глобальные функции для onclick
window.closeModal = closeModal;
window.showUsersModal = showUsersModal;

export function showDevicesModal(adminFetch, loadDevices, renderTVList, openDevice, renderFilesPane) {
  const content = `
    <div style="display:flex; flex-direction:column; gap:var(--space-md);">
      <div>
        <label style="display:block; margin-bottom:4px; font-weight:500;">ID устройства</label>
        <input id="modalDeviceId" class="input" placeholder="tv-001" required />
      </div>
      
      <div>
        <label style="display:block; margin-bottom:4px; font-weight:500;">Имя устройства</label>
        <input id="modalDeviceName" class="input" placeholder="Living Room TV" />
      </div>
      
      <div id="modalError" style="color:var(--danger); font-size:0.875rem; display:none;"></div>
      
      <button id="modalCreateDevice" class="primary" style="width:100%;">Создать устройство</button>
    </div>
  `;
  
  showModal(`${getAndroidIcon(18)} Новое устройство`, content);
  
  // Обработчики
  setTimeout(() => {
    const deviceIdInput = document.getElementById('modalDeviceId');
    const deviceNameInput = document.getElementById('modalDeviceName');
    const createBtn = document.getElementById('modalCreateDevice');
    const errorEl = document.getElementById('modalError');
    
    if (!deviceIdInput || !createBtn) return;
    
    const doCreate = async () => {
      const device_id = deviceIdInput.value.trim();
      const name = deviceNameInput.value.trim();
      
      if (!device_id) {
        errorEl.textContent = 'Введите ID устройства';
        errorEl.style.display = 'block';
        return;
      }
      
      createBtn.disabled = true;
      createBtn.textContent = 'Создание...';
      errorEl.style.display = 'none';
      
      try {
        const res = await adminFetch('/api/devices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id, name })
        });
        
        if (res.ok) {
          closeModal();
          await loadDevices();
          renderTVList();
          openDevice(device_id);
          renderFilesPane(device_id);
        } else {
          const error = await res.json();
          errorEl.textContent = error.error || 'Ошибка создания';
          errorEl.style.display = 'block';
          createBtn.disabled = false;
          createBtn.textContent = 'Создать устройство';
        }
      } catch (err) {
        errorEl.textContent = 'Ошибка подключения';
        errorEl.style.display = 'block';
        createBtn.disabled = false;
        createBtn.textContent = 'Создать устройство';
      }
    };
    
    createBtn.onclick = doCreate;
    deviceIdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
    deviceNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
    deviceIdInput.focus();
  }, 100);
}

export async function showUsersModal(adminFetch) {
  // Сохраняем adminFetch в window для использования в inline onclick
  window.adminFetch = adminFetch;
  
  // Состояние для поиска и пагинации
  window.usersModalState = {
    allUsers: [],
    filteredUsers: [],
    currentPage: 1,
    itemsPerPage: 5,
    searchQuery: ''
  };
  
  const content = `
    <div style="display:flex; flex-direction:column; gap:var(--space-lg);">
      <!-- Форма создания пользователя -->
      <div style="padding:var(--space-md); background:var(--panel-2); border-radius:var(--radius-sm);">
        <div style="margin-bottom:var(--space-md); font-weight:600;">Создать пользователя</div>
        <div style="display:flex; flex-direction:column; gap:var(--space-sm);">
          <input id="modalUsername" class="input" placeholder="Логин" />
          <input id="modalFullName" class="input" placeholder="ФИО" />
          <input id="modalPassword" class="input" type="password" placeholder="Пароль (мин. 8 символов)" />
          <select id="modalRole" class="input">
            <option value="speaker">Speaker (управление контентом)</option>
            <option value="admin">Admin (полный доступ)</option>
            <option value="hero_admin">Hero Admin (управление карточками героев)</option>
          </select>
          <div id="modalUserError" style="color:var(--danger); font-size:0.875rem; display:none;"></div>
          <button id="modalCreateUser" class="primary">Создать пользователя</button>
        </div>
      </div>
      
      <!-- Список пользователей -->
      <div>
        <div style="margin-bottom:var(--space-md); font-weight:600;">Список пользователей</div>
        
        <!-- Поле поиска -->
        <div style="margin-bottom:var(--space-sm);">
          <input 
            id="modalUsersSearch" 
            class="input" 
            type="text" 
            placeholder="Поиск по логину или ФИО..." 
            style="width:100%;"
          />
        </div>
        
        <!-- Список пользователей -->
        <div id="modalUsersList" style="display:flex; flex-direction:column; gap:var(--space-sm); min-height:200px;">
          <div class="meta" style="text-align:center; padding:var(--space-lg);">Загрузка...</div>
        </div>
        
        <!-- Пагинация -->
        <div id="modalUsersPagination" style="display:flex; justify-content:space-between; align-items:center; margin-top:var(--space-md); padding-top:var(--space-md); border-top:1px solid var(--border);">
          <div class="meta" id="modalUsersPaginationInfo" style="color:var(--text-secondary);"></div>
          <div style="display:flex; gap:var(--space-xs); align-items:center;">
            <button 
              id="modalUsersPrevPage" 
              class="secondary" 
              style="min-width:auto; padding:6px 12px;"
              disabled
            >
              ← Назад
            </button>
            <span class="meta" id="modalUsersPageInfo" style="padding:0 var(--space-sm);"></span>
            <button 
              id="modalUsersNextPage" 
              class="secondary" 
              style="min-width:auto; padding:6px 12px;"
              disabled
            >
              Вперед →
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  
  showModal(`${getUsersIcon(18)} Управление пользователями`, content);
  
  // Загружаем список пользователей
  setTimeout(() => {
    loadModalUsersList(adminFetch);
    setupUsersModalHandlers(adminFetch);
  }, 100);
  
  // Обработчик создания
  setTimeout(() => {
    const usernameInput = document.getElementById('modalUsername');
    const fullNameInput = document.getElementById('modalFullName');
    const passwordInput = document.getElementById('modalPassword');
    const roleSelect = document.getElementById('modalRole');
    const createBtn = document.getElementById('modalCreateUser');
    const errorEl = document.getElementById('modalUserError');
    
    if (!createBtn) return;
    
    const doCreate = async () => {
      const username = usernameInput.value.trim();
      const full_name = fullNameInput.value.trim();
      const password = passwordInput.value;
      const role = roleSelect.value;
      
      if (!username || !full_name || !password) {
        errorEl.textContent = 'Заполните все поля';
        errorEl.style.display = 'block';
        return;
      }
      
      if (password.length < 8) {
        errorEl.textContent = 'Пароль минимум 8 символов';
        errorEl.style.display = 'block';
        return;
      }
      
      createBtn.disabled = true;
      createBtn.textContent = 'Создание...';
      errorEl.style.display = 'none';
      
      try {
        const res = await adminFetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, full_name, password, role })
        });
        
        if (res.ok) {
          usernameInput.value = '';
          fullNameInput.value = '';
          passwordInput.value = '';
          roleSelect.value = 'speaker';
          await loadModalUsersList(adminFetch);
        } else {
          const error = await res.json();
          errorEl.textContent = error.error || 'Ошибка создания';
          errorEl.style.display = 'block';
        }
      } catch (err) {
        errorEl.textContent = 'Ошибка подключения';
        errorEl.style.display = 'block';
      } finally {
        createBtn.disabled = false;
        createBtn.textContent = 'Создать пользователя';
      }
    };
    
    createBtn.onclick = doCreate;
    usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
    fullNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
    passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
    usernameInput.focus();
  }, 100);
}

async function loadModalUsersList(adminFetch) {
  const container = document.getElementById('modalUsersList');
  if (!container) return;
  
  // Инициализируем состояние, если его еще нет
  if (!window.usersModalState) {
    window.usersModalState = {
      allUsers: [],
      filteredUsers: [],
      currentPage: 1,
      itemsPerPage: 5,
      searchQuery: ''
    };
  }
  
  try {
    const res = await adminFetch('/api/auth/users');
    const users = await res.json();
    
    // Загружаем количество устройств для каждого пользователя
    const usersWithDeviceCount = await Promise.all(users.map(async (u) => {
      try {
        const devicesRes = await adminFetch(`/api/auth/users/${u.id}/devices`);
        const deviceIds = await devicesRes.json();
        return { ...u, deviceCount: Array.isArray(deviceIds) ? deviceIds.length : 0 };
      } catch (err) {
        return { ...u, deviceCount: 0 };
      }
    }));
    
    // Сохраняем всех пользователей в состояние
    window.usersModalState.allUsers = usersWithDeviceCount;
    
    // Применяем фильтрацию и пагинацию
    filterAndRenderUsers(adminFetch);
    
  } catch (err) {
    container.innerHTML = '<div class="meta" style="color:var(--danger); text-align:center;">Ошибка загрузки</div>';
  }
}

function setupUsersModalHandlers(adminFetch) {
  const searchInput = document.getElementById('modalUsersSearch');
  const prevBtn = document.getElementById('modalUsersPrevPage');
  const nextBtn = document.getElementById('modalUsersNextPage');
  
  if (!searchInput || !prevBtn || !nextBtn) return;
  
  // Обработчик поиска с debounce
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      window.usersModalState.searchQuery = e.target.value.trim().toLowerCase();
      window.usersModalState.currentPage = 1; // Сбрасываем на первую страницу при поиске
      filterAndRenderUsers(adminFetch);
    }, 300);
  });
  
  // Обработчики пагинации
  prevBtn.onclick = () => {
    if (window.usersModalState.currentPage > 1) {
      window.usersModalState.currentPage--;
      filterAndRenderUsers(adminFetch);
    }
  };
  
  nextBtn.onclick = () => {
    const totalPages = Math.ceil(window.usersModalState.filteredUsers.length / window.usersModalState.itemsPerPage);
    if (window.usersModalState.currentPage < totalPages) {
      window.usersModalState.currentPage++;
      filterAndRenderUsers(adminFetch);
    }
  };
}

function filterAndRenderUsers(adminFetch) {
  const state = window.usersModalState;
  const container = document.getElementById('modalUsersList');
  const paginationInfo = document.getElementById('modalUsersPaginationInfo');
  const pageInfo = document.getElementById('modalUsersPageInfo');
  const prevBtn = document.getElementById('modalUsersPrevPage');
  const nextBtn = document.getElementById('modalUsersNextPage');
  
  if (!container) return;
  
  // Фильтрация пользователей
  if (state.searchQuery) {
    state.filteredUsers = state.allUsers.filter(u => 
      u.username.toLowerCase().includes(state.searchQuery) ||
      (u.full_name && u.full_name.toLowerCase().includes(state.searchQuery))
    );
  } else {
    state.filteredUsers = [...state.allUsers];
  }
  
  // Вычисляем пагинацию
  const totalPages = Math.ceil(state.filteredUsers.length / state.itemsPerPage);
  const startIndex = (state.currentPage - 1) * state.itemsPerPage;
  const endIndex = startIndex + state.itemsPerPage;
  const pageUsers = state.filteredUsers.slice(startIndex, endIndex);
  
  // Обновляем информацию о пагинации
  if (paginationInfo) {
    const total = state.filteredUsers.length;
    const showing = total > 0 ? `${startIndex + 1}-${Math.min(endIndex, total)}` : '0';
    paginationInfo.textContent = total > 0 
      ? `Показано ${showing} из ${total}` 
      : state.searchQuery ? 'Ничего не найдено' : 'Нет пользователей';
  }
  
  if (pageInfo) {
    pageInfo.textContent = totalPages > 0 ? `Страница ${state.currentPage} из ${totalPages}` : '';
  }
  
  // Обновляем кнопки пагинации
  if (prevBtn) {
    prevBtn.disabled = state.currentPage <= 1;
  }
  if (nextBtn) {
    nextBtn.disabled = state.currentPage >= totalPages || totalPages === 0;
  }
  
  // Рендерим пользователей текущей страницы
  if (pageUsers.length === 0) {
    container.innerHTML = state.searchQuery 
      ? '<div class="meta" style="text-align:center; padding:var(--space-lg);">Ничего не найдено</div>'
      : '<div class="meta" style="text-align:center; padding:var(--space-lg);">Нет пользователей</div>';
    return;
  }
  
  container.innerHTML = pageUsers.map(u => {
    const safeUsername = escapeHtml(u.username || '');
    const safeFullName = escapeHtml(u.full_name || '');
    const deviceCountLabel = Number.isFinite(Number(u.deviceCount)) ? Number(u.deviceCount) : 0;
    const safeUserId = Number.isFinite(Number(u.id)) ? Number(u.id) : 0;
    const usernameArg = escapeJsStringForAttr(u.username || '');
    const roleArg = escapeJsStringForAttr(u.role || '');
    return `
      <div class="item" style="display:flex; justify-content:space-between; align-items:center; gap:var(--space-sm);">
        <div style="flex:1; min-width:0;">
          <div style="display:flex; align-items:center; gap:var(--space-xs); flex-wrap:wrap;">
            <strong>${safeUsername}</strong>
            ${u.role === 'admin' ? '<span style="background:var(--brand); color:var(--panel); padding:2px 6px; border-radius:4px; font-size:0.7rem;">ADMIN</span>' : ''}
            ${u.role === 'speaker' ? '<span style="background:var(--success); color:var(--panel); padding:2px 6px; border-radius:4px; font-size:0.7rem;">SPEAKER</span>' : ''}
            ${u.role === 'hero_admin' ? '<span style="background:var(--warning); color:var(--panel); padding:2px 6px; border-radius:4px; font-size:0.7rem;">HERO ADMIN</span>' : ''}
            ${!u.is_active ? '<span style="background:var(--danger); color:var(--panel); padding:2px 6px; border-radius:4px; font-size:0.7rem;">OFF</span>' : ''}
          </div>
          <div class="meta">${safeFullName}</div>
          ${u.role === 'speaker' ? `<div class="meta" style="font-size:0.75rem; color:var(--text-secondary);">Устройств: ${deviceCountLabel}</div>` : ''}
        </div>
        <div style="display:flex; gap:4px; flex-shrink:0;">
          ${u.role === 'speaker' ? `<button class="secondary" style="min-width:auto; padding:6px 10px; display:flex; align-items:center; justify-content:center;" onclick="showUserDevicesModalInModal(${safeUserId}, ${usernameArg}, ${roleArg})" title="Управление устройствами">${getSettingsIcon(16)}</button>` : ''}
          ${u.role === 'admin' || u.role === 'hero_admin' ? `<button class="secondary" style="min-width:auto; padding:6px 10px; display:flex; align-items:center; justify-content:center;" onclick="showUserDevicesModalInModal(${safeUserId}, ${usernameArg}, ${roleArg})" title="Информация об устройствах">${getSettingsIcon(16)}</button>` : ''}
          <button class="secondary" style="min-width:auto; padding:6px 10px; display:flex; align-items:center; justify-content:center;" onclick="resetUserPasswordInModal(${safeUserId}, ${usernameArg})" title="Сбросить пароль">${getKeyIcon(16)}</button>
          ${u.is_active 
            ? `<button class="secondary" style="min-width:auto; padding:6px 10px; display:flex; align-items:center; justify-content:center;" onclick="toggleUserInModal(${safeUserId}, false)" title="Отключить">${getLockIcon(16)}</button>`
            : `<button class="secondary" style="min-width:auto; padding:6px 10px; display:flex; align-items:center; justify-content:center;" onclick="toggleUserInModal(${safeUserId}, true)" title="Включить">${getUnlockIcon(16)}</button>`
          }
          ${u.id !== 1 ? `<button class="danger meta-lg" style="min-width:auto; padding:6px 10px; display:flex; align-items:center; justify-content:center;" onclick="deleteUserInModal(${safeUserId}, ${usernameArg})" title="Удалить">${getTrashIcon(16)}</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
    
  // Регистрируем глобальные функции для onclick (если еще не зарегистрированы)
  if (!window.toggleUserInModal) {
    window.toggleUserInModal = async (userId, activate) => {
      try {
        const res = await window.adminFetch(`/api/auth/users/${userId}/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_active: activate })
        });
        
        if (res.ok) {
          // Сразу обновляем список пользователей
          await loadModalUsersList(window.adminFetch);
        } else {
          const error = await res.json().catch(() => ({ error: 'Ошибка' }));
          alert(error.error || 'Ошибка при изменении статуса пользователя');
        }
      } catch (err) {
        alert(`Ошибка: ${err.message}`);
      }
    };
  }
  
  if (!window.deleteUserInModal) {
    window.deleteUserInModal = async (userId, username) => {
      if (!confirm(`Удалить "${username}"?`)) return;
      
      try {
        const res = await window.adminFetch(`/api/auth/users/${userId}`, {
          method: 'DELETE'
        });
        
        if (res.ok) {
          // Сразу обновляем список пользователей
          await loadModalUsersList(window.adminFetch);
        } else {
          const error = await res.json().catch(() => ({ error: 'Ошибка' }));
          alert(error.error || 'Ошибка при удалении пользователя');
        }
      } catch (err) {
        alert(`Ошибка: ${err.message}`);
      }
    };
  }
  
  if (!window.resetUserPasswordInModal) {
    window.resetUserPasswordInModal = async (userId, username) => {
      const safeUsername = escapeHtml(username || '');
      const passwordResetContent = `
        <div style="display:flex; flex-direction:column; gap:var(--space-md);">
          <div style="color:var(--text-secondary);">
            Сброс пароля для пользователя: <strong>${safeUsername}</strong>
          </div>
          <input id="newPassword1" class="input" type="password" placeholder="Новый пароль (мин. 8 символов)" />
          <input id="newPassword2" class="input" type="password" placeholder="Повторите новый пароль" />
          <div id="passwordResetError" style="color:var(--danger); font-size:0.875rem; display:none;"></div>
          <div style="display:flex; gap:var(--space-sm);">
            <button id="resetPasswordBtn" class="primary" style="flex:1;">Сбросить пароль</button>
            <button onclick="closeModal()" class="secondary" style="flex:1;">Отмена</button>
          </div>
        </div>
      `;
      
      showModal(`${getKeyIcon(18)} Сброс пароля`, passwordResetContent);
      
      setTimeout(() => {
        const password1Input = document.getElementById('newPassword1');
        const password2Input = document.getElementById('newPassword2');
        const resetBtn = document.getElementById('resetPasswordBtn');
        const errorEl = document.getElementById('passwordResetError');
        
        if (!resetBtn) return;
        
        const doReset = async () => {
          const newPassword = password1Input.value;
          const confirmPassword = password2Input.value;
          
          if (!newPassword || newPassword.length < 8) {
            errorEl.textContent = 'Пароль должен быть не менее 8 символов';
            errorEl.style.display = 'block';
            return;
          }
          
          if (newPassword !== confirmPassword) {
            errorEl.textContent = 'Пароли не совпадают';
            errorEl.style.display = 'block';
            return;
          }
          
          resetBtn.disabled = true;
          resetBtn.textContent = 'Сброс...';
          errorEl.style.display = 'none';
          
          try {
            const res = await adminFetch(`/api/auth/users/${userId}/reset-password`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ new_password: newPassword })
            });
            
            if (res.ok) {
              closeModal();
              showModal(`${getSuccessIcon(18)} Успешно`, `
                <div style="text-align:center; padding:var(--space-lg);">
                  Пароль для <strong>${safeUsername}</strong> успешно изменен
                </div>
                <button onclick="closeModal(); setTimeout(() => window.showUsersModal && window.showUsersModal(window.adminFetch), 100)" class="primary" style="width:100%;">OK</button>
              `);
            } else {
              const error = await res.json();
              errorEl.textContent = error.error || 'Ошибка сброса пароля';
              errorEl.style.display = 'block';
            }
          } catch (err) {
            errorEl.textContent = 'Ошибка подключения';
            errorEl.style.display = 'block';
          } finally {
            resetBtn.disabled = false;
            resetBtn.textContent = 'Сбросить пароль';
          }
        };
        
        resetBtn.onclick = doReset;
        password1Input.addEventListener('keydown', (e) => { if (e.key === 'Enter') password2Input.focus(); });
        password2Input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doReset(); });
        password1Input.focus();
      }, 100);
    };
  }
}

// Глобальная функция для открытия модального окна назначения устройств
window.showUserDevicesModalInModal = async function(userId, username, userRole) {
  if (!window.adminFetch) return;
  const safeUsername = escapeHtml(username || '');
  
  // Если admin, показываем сообщение что ему доступны все устройства
  if (userRole === 'admin') {
    showModal(`${getSettingsIcon(18)} Управление устройствами`, `
      <div style="text-align:center; padding:var(--space-lg);">
        <div class="meta" style="margin-bottom:var(--space-md);">
          Пользователь <strong>${safeUsername}</strong> имеет роль <strong>ADMIN</strong>
        </div>
        <div class="meta" style="color:var(--text-secondary);">
          Администраторам доступны все устройства автоматически
        </div>
        <button onclick="closeModal()" class="primary" style="width:100%; margin-top:var(--space-md);">OK</button>
      </div>
    `);
    return;
  }
  
  // Если hero_admin, показываем сообщение что у него своя панель
  if (userRole === 'hero_admin') {
    showModal(`${getSettingsIcon(18)} Управление устройствами`, `
      <div style="text-align:center; padding:var(--space-lg);">
        <div class="meta" style="margin-bottom:var(--space-md);">
          Пользователь <strong>${safeUsername}</strong> имеет роль <strong>HERO ADMIN</strong>
        </div>
        <div class="meta" style="color:var(--text-secondary);">
          Hero Admin имеет свою панель управления и не имеет доступа к устройствам
        </div>
        <button onclick="closeModal()" class="primary" style="width:100%; margin-top:var(--space-md);">OK</button>
      </div>
    `);
    return;
  }
  
  // Состояние для модального окна устройств
  window.userDevicesModalState = {
    allDevices: [],
    filteredDevices: [],
    userDeviceIds: [],
    currentPage: 1,
    itemsPerPage: 9,  // 3 колонки × 3 ряда = 9 устройств на страницу
    searchQuery: ''
  };
  
  const content = `
    <div style="display:flex; flex-direction:column; gap:var(--space-lg);">
      <div style="padding:var(--space-md); background:var(--panel-2); border-radius:var(--radius-sm);">
        <div style="margin-bottom:var(--space-sm);">
          <div class="meta" style="color:var(--text-secondary);">Пользователь:</div>
          <div style="font-weight:600; margin-top:4px;">${safeUsername}</div>
        </div>
      </div>
      
      <div>
        <div style="margin-bottom:var(--space-md); font-weight:600;">Доступные устройства</div>
        
        <!-- Поле поиска -->
        <div style="margin-bottom:var(--space-sm);">
          <input 
            id="modalDevicesSearch" 
            class="input" 
            type="text" 
            placeholder="Поиск устройств..." 
            style="width:100%;"
          />
        </div>
        
        <!-- Кнопки выбора -->
        <div style="display:flex; gap:var(--space-xs); margin-bottom:var(--space-sm);">
          <button id="modalDevicesSelectAll" class="secondary meta" style="flex:1;">Выбрать все</button>
          <button id="modalDevicesDeselectAll" class="secondary meta" style="flex:1;">Снять все</button>
        </div>
        
        <!-- Список устройств -->
        <div id="modalDevicesList" style="display:grid; grid-template-columns:repeat(3, 1fr); gap:var(--space-sm); min-height:200px; max-height:400px; overflow-y:auto; padding:var(--space-xs);">
          <div class="meta" style="text-align:center; padding:var(--space-lg); grid-column:1/-1;">Загрузка...</div>
        </div>
        
        <!-- Информация о выборе -->
        <div id="modalDevicesSelectedInfo" class="meta" style="margin-top:var(--space-sm); color:var(--text-secondary);"></div>
        
        <!-- Пагинация -->
        <div id="modalDevicesPagination" style="display:flex; justify-content:space-between; align-items:center; margin-top:var(--space-md); padding-top:var(--space-md); border-top:1px solid var(--border);">
          <div class="meta" id="modalDevicesPaginationInfo" style="color:var(--text-secondary);"></div>
          <div style="display:flex; gap:var(--space-xs); align-items:center;">
            <button 
              id="modalDevicesPrevPage" 
              class="secondary" 
              style="min-width:auto; padding:6px 12px;"
              disabled
            >
              ← Назад
            </button>
            <span class="meta" id="modalDevicesPageInfo" style="padding:0 var(--space-sm);"></span>
            <button 
              id="modalDevicesNextPage" 
              class="secondary" 
              style="min-width:auto; padding:6px 12px;"
              disabled
            >
              Вперед →
            </button>
          </div>
        </div>
        
        <!-- Кнопки действий -->
        <div style="display:flex; gap:var(--space-sm); margin-top:var(--space-md);">
          <button id="modalDevicesSaveBtn" class="primary" style="flex:1;">Сохранить</button>
          <button onclick="closeModal()" class="secondary" style="flex:1;">Отмена</button>
        </div>
      </div>
    </div>
  `;
  
  showModal(`${getSettingsIcon(18)} Назначение устройств`, content);
  
  // Загружаем данные
  setTimeout(() => {
    loadUserDevicesModalData(window.adminFetch, userId);
    setupUserDevicesModalHandlers(window.adminFetch, userId, username);
  }, 100);
};

async function loadUserDevicesModalData(adminFetch, userId) {
  try {
    // Загружаем все устройства
    const devicesRes = await adminFetch('/api/devices');
    const allDevices = await devicesRes.json();
    
    // Загружаем назначенные устройства пользователя
    const userDevicesRes = await adminFetch(`/api/auth/users/${userId}/devices`);
    const userDeviceIds = await userDevicesRes.json();
    
    window.userDevicesModalState.allDevices = allDevices;
    window.userDevicesModalState.userDeviceIds = Array.isArray(userDeviceIds) ? userDeviceIds : [];
    
    // Применяем фильтрацию и рендеринг
    filterAndRenderDevices();
  } catch (err) {
    const container = document.getElementById('modalDevicesList');
    if (container) {
      container.innerHTML = '<div class="meta" style="color:var(--danger); text-align:center;">Ошибка загрузки</div>';
    }
  }
}

function setupUserDevicesModalHandlers(adminFetch, userId, username) {
  const searchInput = document.getElementById('modalDevicesSearch');
  const selectAllBtn = document.getElementById('modalDevicesSelectAll');
  const deselectAllBtn = document.getElementById('modalDevicesDeselectAll');
  const saveBtn = document.getElementById('modalDevicesSaveBtn');
  const prevBtn = document.getElementById('modalDevicesPrevPage');
  const nextBtn = document.getElementById('modalDevicesNextPage');
  
  if (!searchInput || !selectAllBtn || !deselectAllBtn || !saveBtn) return;
  const safeUsername = escapeHtml(username || '');
  
  // Обработчик поиска
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      window.userDevicesModalState.searchQuery = e.target.value.trim().toLowerCase();
      window.userDevicesModalState.currentPage = 1;
      filterAndRenderDevices();
    }, 300);
  });
  
  // Выбрать все
  selectAllBtn.onclick = () => {
    const state = window.userDevicesModalState;
    const filteredIds = state.filteredDevices.map(d => d.device_id);
    state.userDeviceIds = [...new Set([...state.userDeviceIds, ...filteredIds])];
    filterAndRenderDevices();
  };
  
  // Снять все
  deselectAllBtn.onclick = () => {
    const state = window.userDevicesModalState;
    const filteredIds = state.filteredDevices.map(d => d.device_id);
    state.userDeviceIds = state.userDeviceIds.filter(id => !filteredIds.includes(id));
    filterAndRenderDevices();
  };
  
  // Сохранение
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Сохранение...';
    
    try {
      const res = await adminFetch(`/api/auth/users/${userId}/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: window.userDevicesModalState.userDeviceIds })
      });
      
      if (res.ok) {
        closeModal();
        showModal(`${getSuccessIcon(18)} Успешно`, `
          <div style="text-align:center; padding:var(--space-lg);">
            Устройства для <strong>${safeUsername}</strong> успешно обновлены
          </div>
          <button onclick="closeModal(); setTimeout(() => window.showUsersModal && window.showUsersModal(window.adminFetch), 100)" class="primary" style="width:100%;">OK</button>
        `);
      } else {
        const error = await res.json();
        alert(error.error || 'Ошибка сохранения');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Сохранить';
      }
    } catch (err) {
      alert(`Ошибка: ${err.message}`);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Сохранить';
    }
  };
  
  // Пагинация
  if (prevBtn) {
    prevBtn.onclick = () => {
      if (window.userDevicesModalState.currentPage > 1) {
        window.userDevicesModalState.currentPage--;
        filterAndRenderDevices();
      }
    };
  }
  
  if (nextBtn) {
    nextBtn.onclick = () => {
      const totalPages = Math.ceil(window.userDevicesModalState.filteredDevices.length / window.userDevicesModalState.itemsPerPage);
      if (window.userDevicesModalState.currentPage < totalPages) {
        window.userDevicesModalState.currentPage++;
        filterAndRenderDevices();
      }
    };
  }
}

function filterAndRenderDevices() {
  const state = window.userDevicesModalState;
  const container = document.getElementById('modalDevicesList');
  const paginationInfo = document.getElementById('modalDevicesPaginationInfo');
  const pageInfo = document.getElementById('modalDevicesPageInfo');
  const selectedInfo = document.getElementById('modalDevicesSelectedInfo');
  const prevBtn = document.getElementById('modalDevicesPrevPage');
  const nextBtn = document.getElementById('modalDevicesNextPage');
  
  if (!container) return;
  
  // Фильтрация устройств
  if (state.searchQuery) {
    state.filteredDevices = state.allDevices.filter(d => 
      d.device_id.toLowerCase().includes(state.searchQuery) ||
      (d.name && d.name.toLowerCase().includes(state.searchQuery))
    );
  } else {
    state.filteredDevices = [...state.allDevices];
  }
  
  // Вычисляем пагинацию
  const totalPages = Math.ceil(state.filteredDevices.length / state.itemsPerPage);
  const startIndex = (state.currentPage - 1) * state.itemsPerPage;
  const endIndex = startIndex + state.itemsPerPage;
  const pageDevices = state.filteredDevices.slice(startIndex, endIndex);
  
  // Обновляем информацию
  if (paginationInfo) {
    const total = state.filteredDevices.length;
    const showing = total > 0 ? `${startIndex + 1}-${Math.min(endIndex, total)}` : '0';
    paginationInfo.textContent = total > 0 ? `Показано ${showing} из ${total}` : 'Нет устройств';
  }
  
  if (pageInfo) {
    pageInfo.textContent = totalPages > 0 ? `Страница ${state.currentPage} из ${totalPages}` : '';
  }
  
  if (selectedInfo) {
    const selectedCount = state.userDeviceIds.length;
    selectedInfo.textContent = `Выбрано: ${selectedCount} из ${state.allDevices.length}`;
  }
  
  // Обновляем кнопки пагинации
  if (prevBtn) {
    prevBtn.disabled = state.currentPage <= 1;
  }
  if (nextBtn) {
    nextBtn.disabled = state.currentPage >= totalPages || totalPages === 0;
  }
  
  // Рендерим устройства
  if (pageDevices.length === 0) {
    container.innerHTML = state.searchQuery 
      ? '<div class="meta" style="text-align:center; padding:var(--space-lg); grid-column:1/-1;">Ничего не найдено</div>'
      : '<div class="meta" style="text-align:center; padding:var(--space-lg); grid-column:1/-1;">Нет устройств</div>';
    return;
  }
  
  container.innerHTML = pageDevices.map(d => {
    const isSelected = state.userDeviceIds.includes(d.device_id);
    const deviceName = d.name || d.device_id;
    const safeDeviceName = escapeHtml(deviceName || '');
    const safeDeviceId = escapeHtml(d.device_id || '');
    const deviceIdArg = escapeJsStringForAttr(d.device_id || '');
    return `
      <label style="display:flex; flex-direction:column; gap:var(--space-xs); padding:var(--space-sm); border:1px solid var(--border); border-radius:var(--radius-sm); cursor:pointer; transition:all 0.2s; ${isSelected ? 'background:var(--panel-2); border-color:var(--brand);' : 'background:var(--panel);'}" onmouseover="this.style.background='var(--panel-hover)'; this.style.borderColor='var(--border-hover)'" onmouseout="this.style.background=${isSelected ? "'var(--panel-2)'" : "'var(--panel)'"}; this.style.borderColor=${isSelected ? "'var(--brand)'" : "'var(--border)'"}">
        <div style="display:flex; align-items:center; gap:var(--space-xs);">
          <input 
            type="checkbox" 
            ${isSelected ? 'checked' : ''} 
            onchange="toggleDeviceSelection(${deviceIdArg})"
            style="cursor:pointer; flex-shrink:0;"
          />
          <div style="flex:1; min-width:0; font-weight:500; font-size:var(--font-size-sm);">${safeDeviceName}</div>
        </div>
        <div class="meta" style="font-size:0.7rem; padding-left:calc(var(--space-xs) + 16px); color:var(--muted);">${safeDeviceId}</div>
      </label>
    `;
  }).join('');
}

// Глобальная функция для переключения выбора устройства
window.toggleDeviceSelection = function(deviceId) {
  const state = window.userDevicesModalState;
  const index = state.userDeviceIds.indexOf(deviceId);
  if (index > -1) {
    state.userDeviceIds.splice(index, 1);
  } else {
    state.userDeviceIds.push(deviceId);
  }
  filterAndRenderDevices();
};

export function showSettingsModal() {
  // Импортируем системный монитор динамически
  Promise.all([
    import('./system-monitor.js'),
    import('./auth.js')
  ]).then(([{ getSystemMonitorHTML, initSystemMonitor }, { adminFetch }]) => {
    const content = `
      <div id="settingsModalSystemMonitor" style="margin-bottom:var(--space-md);">
        ${getSystemMonitorHTML()}
      </div>
      <div id="settingsModalContainer" style="display:flex; flex-direction:column; gap:var(--space-lg);">
        <div class="meta" style="text-align:center;">Загрузка настроек...</div>
      </div>
    `;
    
    showModal(`${getSettingsIcon(18)} Настройки`, content);
    
    // Инициализируем системный монитор в модальном окне после того как DOM обновлен
    setTimeout(() => {
      const monitorContainer = document.getElementById('settingsModalSystemMonitor');
      if (monitorContainer && adminFetch) {
        initSystemMonitor(adminFetch, monitorContainer);
      }
    }, 0);
    
    // Загружаем настройки
    loadSettingsContent(adminFetch);
  }).catch(() => {
    // Fallback если импорт не удался
    import('./auth.js').then(({ adminFetch }) => {
      const content = `
        <div id="settingsModalContainer" style="display:flex; flex-direction:column; gap:var(--space-lg);">
          <div class="meta" style="text-align:center;">Загрузка настроек...</div>
        </div>
      `;
      showModal(`${getSettingsIcon(18)} Настройки`, content);
      loadSettingsContent(adminFetch);
    });
  });
}

async function loadSettingsContent(adminFetch) {
  const container = document.getElementById('settingsModalContainer');
  if (!container) return;
  
  let settingsData = null;
  
  try {
    const response = await adminFetch('/api/admin/settings');
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Ошибка загрузки настроек' }));
      throw new Error(error.error || 'Ошибка загрузки настроек');
    }
    settingsData = await response.json();
  } catch (err) {
    const safeError = escapeHtml(err.message || 'Ошибка загрузки настроек');
    container.innerHTML = `<div class="meta" style="color:var(--danger); text-align:center;">${safeError}</div>`;
    return;
  }
  
  // Очищаем контейнер перед добавлением нового содержимого
  container.innerHTML = '';
  
  const currentContentRoot = settingsData?.runtime?.contentRoot || settingsData?.contentRoot || '';
  // По умолчанию используется локальная папка проекта (data/ внутри проекта)
  // Админ может изменить на любой абсолютный путь через настройки
  // defaults.contentRoot всегда содержит значение по умолчанию, вычисляемое сервером
  const defaultContentRoot = settingsData?.defaults?.contentRoot || '';
  
  // Используем DOM методы вместо innerHTML для безопасности
  const mainDiv = document.createElement('div');
  mainDiv.style.cssText = 'padding:var(--space-md); background:var(--panel-2); border-radius:var(--radius-sm); display:flex; flex-direction:column; gap:0;';
  
  // Хранилище контента
  const storageSection = document.createElement('div');
  storageSection.style.cssText = 'padding-bottom:var(--space-md);';
  
  const storageTitle = document.createElement('div');
  storageTitle.style.cssText = 'font-weight:600; font-size:1.1rem; color:var(--text-primary); margin-bottom:var(--space-sm);';
  storageTitle.textContent = 'Хранилище контента';
  
  const storageContent = document.createElement('div');
  storageContent.style.cssText = 'display:flex; align-items:center; gap:var(--space-md);';
  
  const storageInputContainer = document.createElement('div');
  storageInputContainer.style.cssText = 'flex:1; display:flex; flex-direction:column; gap:var(--space-xs);';
  
  const contentRootInput = document.createElement('input');
  contentRootInput.id = 'contentRootInput';
  contentRootInput.className = 'input';
  contentRootInput.spellcheck = false;
  
  if (defaultContentRoot) {
    const defaultInfo = document.createElement('div');
    defaultInfo.className = 'meta';
    defaultInfo.style.cssText = 'font-size:0.85rem; color:var(--text-secondary);';
    const defaultText = document.createTextNode('По умолчанию: ');
    const codeEl = document.createElement('code');
    codeEl.style.fontFamily = 'monospace';
    codeEl.textContent = defaultContentRoot;
    defaultInfo.appendChild(defaultText);
    defaultInfo.appendChild(codeEl);
    storageInputContainer.appendChild(defaultInfo);
  }
  
  const contentRootStatus = document.createElement('div');
  contentRootStatus.id = 'contentRootStatus';
  contentRootStatus.className = 'meta';
  contentRootStatus.style.cssText = 'min-height:1.2em; font-size:0.85rem;';
  
  storageInputContainer.appendChild(contentRootInput);
  storageInputContainer.appendChild(contentRootStatus);
  
  const contentRootSaveBtn = document.createElement('button');
  contentRootSaveBtn.id = 'contentRootSaveBtn';
  contentRootSaveBtn.className = 'primary';
  contentRootSaveBtn.style.cssText = 'flex-shrink:0;';
  contentRootSaveBtn.textContent = 'Сохранить';
  
  storageContent.appendChild(storageInputContainer);
  storageContent.appendChild(contentRootSaveBtn);
  storageSection.appendChild(storageTitle);
  storageSection.appendChild(storageContent);
  
  // Разделитель
  const divider1 = document.createElement('div');
  divider1.style.cssText = 'border-top:1px solid var(--border-color, rgba(255,255,255,0.1)); margin:0;';
  
  // База данных
  const dbSection = document.createElement('div');
  dbSection.style.cssText = 'padding:var(--space-md) 0;';
  
  const dbTitle = document.createElement('div');
  dbTitle.style.cssText = 'font-weight:600; font-size:1.1rem; color:var(--text-primary); margin-bottom:var(--space-sm);';
  dbTitle.textContent = 'База данных';
  
  const dbContent = document.createElement('div');
  dbContent.style.cssText = 'display:flex; align-items:center; gap:var(--space-md);';
  
  const dbDescription = document.createElement('div');
  dbDescription.className = 'meta';
  dbDescription.style.cssText = 'flex:1; color:var(--text-secondary); line-height:1.4;';
  dbDescription.textContent = 'Экспортируйте базу данных для резервного копирования или миграции.';
  
  const exportDatabaseBtn = document.createElement('button');
  exportDatabaseBtn.id = 'exportDatabaseBtn';
  exportDatabaseBtn.className = 'primary';
  exportDatabaseBtn.style.cssText = 'flex-shrink:0;';
  exportDatabaseBtn.innerHTML = `${getDownloadIcon(16)} Экспорт`;
  
  dbContent.appendChild(dbDescription);
  dbContent.appendChild(exportDatabaseBtn);
  dbSection.appendChild(dbTitle);
  dbSection.appendChild(dbContent);
  
  // Разделитель 2
  const divider2 = document.createElement('div');
  divider2.style.cssText = 'border-top:1px solid var(--border-color, rgba(255,255,255,0.1)); margin:0;';
  
  // Очистка базы данных
  const cleanupSection = document.createElement('div');
  cleanupSection.style.cssText = 'padding-top:var(--space-md);';
  
  const cleanupTitle = document.createElement('div');
  cleanupTitle.style.cssText = 'font-weight:600; font-size:1.1rem; color:var(--text-primary); margin-bottom:var(--space-sm);';
  cleanupTitle.textContent = 'Очистка базы данных';
  
  const cleanupContent = document.createElement('div');
  cleanupContent.style.cssText = 'display:flex; align-items:center; gap:var(--space-md);';
  
  const cleanupLeft = document.createElement('div');
  cleanupLeft.style.cssText = 'flex:1; display:flex; flex-direction:column; gap:var(--space-xs);';
  
  const cleanupDescription = document.createElement('div');
  cleanupDescription.className = 'meta';
  cleanupDescription.style.cssText = 'color:var(--text-secondary); line-height:1.4;';
  cleanupDescription.textContent = 'Проверьте файлы из базы данных на наличие на диске. Удалите записи о несуществующих файлах.';
  
  const cleanupStatus = document.createElement('div');
  cleanupStatus.id = 'cleanupStatus';
  cleanupStatus.className = 'meta';
  cleanupStatus.style.cssText = 'min-height:1.2em; font-size:0.85rem;';
  
  cleanupLeft.appendChild(cleanupDescription);
  cleanupLeft.appendChild(cleanupStatus);
  
  const cleanupButtons = document.createElement('div');
  cleanupButtons.style.cssText = 'flex-shrink:0; display:flex; gap:var(--space-xs);';
  
  const checkFilesBtn = document.createElement('button');
  checkFilesBtn.id = 'checkFilesBtn';
  checkFilesBtn.className = 'secondary';
  checkFilesBtn.style.cssText = 'width:36px; height:36px; padding:0; display:flex; align-items:center; justify-content:center;';
  checkFilesBtn.title = 'Проверить файлы';
  checkFilesBtn.textContent = '🔍';
  
  const cleanupFilesBtn = document.createElement('button');
  cleanupFilesBtn.id = 'cleanupFilesBtn';
  cleanupFilesBtn.className = 'danger meta-lg';
  cleanupFilesBtn.style.cssText = 'width:36px; height:36px; padding:0; display:flex; align-items:center; justify-content:center;';
  cleanupFilesBtn.disabled = true;
  cleanupFilesBtn.title = 'Очистить';
  cleanupFilesBtn.textContent = '🗑️';
  
  cleanupButtons.appendChild(checkFilesBtn);
  cleanupButtons.appendChild(cleanupFilesBtn);
  cleanupContent.appendChild(cleanupLeft);
  cleanupContent.appendChild(cleanupButtons);
  cleanupSection.appendChild(cleanupTitle);
  cleanupSection.appendChild(cleanupContent);
  
  mainDiv.appendChild(storageSection);
  mainDiv.appendChild(divider1);
  mainDiv.appendChild(dbSection);
  mainDiv.appendChild(divider2);
  mainDiv.appendChild(cleanupSection);
  container.appendChild(mainDiv);
  
  // Используем уже созданные элементы напрямую
  const inputEl = contentRootInput;
  const saveBtn = contentRootSaveBtn;
  const statusEl = contentRootStatus;
  const exportBtn = exportDatabaseBtn;
  const cleanupStatusEl = cleanupStatus;
  
  if (!inputEl || !saveBtn || !statusEl || !exportBtn || !checkFilesBtn || !cleanupFilesBtn || !cleanupStatusEl) return;
  
  let lastSavedValue = currentContentRoot;
  inputEl.value = currentContentRoot;
  
  const toggleSaveState = () => {
    const same = inputEl.value.trim() === lastSavedValue;
    saveBtn.disabled = same;
    if (!same) {
      statusEl.textContent = '';
      statusEl.style.color = 'var(--text-secondary)';
    }
  };
  
  toggleSaveState();
  inputEl.addEventListener('input', toggleSaveState);
  
  saveBtn.onclick = async () => {
    const newPath = inputEl.value.trim();
    if (!newPath) {
      statusEl.textContent = 'Укажите абсолютный путь';
      statusEl.style.color = 'var(--danger)';
      return;
    }
    
    saveBtn.disabled = true;
    saveBtn.textContent = 'Сохранение...';
    statusEl.textContent = 'Проверяем путь...';
    statusEl.style.color = 'var(--text-secondary)';
    
    try {
      const response = await adminFetch('/api/admin/settings/content-root', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newPath })
      });
      
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Не удалось сохранить' }));
        throw new Error(error.error || 'Не удалось сохранить');
      }
      
      const data = await response.json();
      lastSavedValue = data.contentRoot || newPath;
      inputEl.value = lastSavedValue;
      statusEl.textContent = 'Путь сохранён. Контент будет загружаться и читаться из новой папки.';
      statusEl.style.color = 'var(--success)';
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.style.color = 'var(--danger)';
    } finally {
      saveBtn.textContent = 'Сохранить путь';
      toggleSaveState();
    }
  };
  
  exportBtn.onclick = async () => {
      exportBtn.disabled = true;
      exportBtn.textContent = 'Экспорт...';
      
      try {
        const response = await adminFetch('/api/admin/export-database');
        
        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: 'Ошибка экспорта' }));
          throw new Error(error.error || 'Ошибка экспорта');
        }
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.style.display = 'none';
        link.href = url;
        link.download = `main_${new Date().toISOString().split('T')[0]}.db`;
        document.body.appendChild(link);
        link.click();
        
        setTimeout(() => {
          document.body.removeChild(link);
          window.URL.revokeObjectURL(url);
        }, 100);
        
        exportBtn.disabled = false;
        exportBtn.innerHTML = `${getDownloadIcon(16)} Экспортировано`;
        setTimeout(() => {
          exportBtn.innerHTML = `${getDownloadIcon(16)} Экспорт`;
        }, 2000);
      } catch (err) {
        alert(`Ошибка экспорта: ${err.message}`);
        exportBtn.disabled = false;
        exportBtn.innerHTML = `${getDownloadIcon(16)} Экспорт`;
      }
    };

  // Обработчики для очистки БД
  let lastCheckResult = null;

  checkFilesBtn.onclick = async () => {
    checkFilesBtn.disabled = true;
    checkFilesBtn.innerHTML = '⏳';
    cleanupStatusEl.textContent = '';
    cleanupStatusEl.style.color = 'var(--text-secondary)';
    cleanupFilesBtn.disabled = true;

    try {
      const response = await adminFetch('/api/admin/database/check-files');

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Ошибка проверки' }));
        throw new Error(error.error || 'Ошибка проверки');
      }

      const result = await response.json();
      lastCheckResult = result;

      let statusText = `Проверено: ${result.checked} файлов. `;
      if (result.missingOnDisk > 0) {
        statusText += `Отсутствует на диске (в БД есть): ${result.missingOnDisk}.`;
      }
      
      // Активируем кнопку, если есть что удалять
      if (result.missingOnDisk > 0) {
        cleanupFilesBtn.disabled = false;
      }
      
      if (result.missingOnDisk === 0) {
        statusText = '✅ Все файлы на месте. Проблем не обнаружено.';
        cleanupStatusEl.style.color = 'var(--success)';
      } else if (result.missingOnDisk > 0) {
        cleanupStatusEl.style.color = 'var(--warning)';
      } else {
        cleanupStatusEl.style.color = 'var(--text-secondary)';
      }

      cleanupStatusEl.textContent = statusText;
    } catch (err) {
      cleanupStatusEl.textContent = `Ошибка: ${err.message}`;
      cleanupStatusEl.style.color = 'var(--danger)';
    } finally {
      checkFilesBtn.disabled = false;
      checkFilesBtn.innerHTML = '🔍';
    }
  };

  cleanupFilesBtn.onclick = async () => {
    if (!lastCheckResult || lastCheckResult.missingOnDisk === 0) {
      alert('Сначала выполните проверку файлов');
      return;
    }

    const confirmMessage = `Удалить ${lastCheckResult.missingOnDisk} записей из БД (файлов нет на диске)?`;

    if (!confirm(confirmMessage)) {
      return;
    }

    cleanupFilesBtn.disabled = true;
    cleanupFilesBtn.innerHTML = '⏳';
    cleanupStatusEl.textContent = 'Удаление...';
    cleanupStatusEl.style.color = 'var(--text-secondary)';

    try {
      const response = await adminFetch('/api/admin/database/cleanup-missing-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: null }) // null = все устройства
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Ошибка очистки' }));
        throw new Error(error.error || 'Ошибка очистки');
      }

      const result = await response.json();
      
      let resultText = '';
      if (result.deletedFromDB > 0) {
        resultText = `✅ Удалено ${result.deletedFromDB} записей из базы данных.`;
      } else {
        resultText = '✅ Очистка завершена.';
      }
      
      cleanupStatusEl.textContent = resultText;
      cleanupStatusEl.style.color = 'var(--success, #22c55e)';
      cleanupFilesBtn.disabled = true;
      cleanupFilesBtn.innerHTML = '🗑️';
      lastCheckResult = null;

      // Обновляем данные после очистки
      setTimeout(() => {
        cleanupStatusEl.textContent = '';
      }, 5000);
    } catch (err) {
      cleanupStatusEl.textContent = `Ошибка: ${err.message}`;
      cleanupStatusEl.style.color = 'var(--danger)';
      cleanupFilesBtn.disabled = false;
    } finally {
      cleanupFilesBtn.innerHTML = '🗑️';
    }
  };
}

