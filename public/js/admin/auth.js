/**
 * JWT Authentication для админ-панели
 * @module admin/auth
 */

/**
 * Проверить токен и редиректнуть на login если нужно
 */
export async function ensureAuth() {
  const token = localStorage.getItem('accessToken');
  const userStr = localStorage.getItem('user');
  
  
  // ИСПРАВЛЕНО: Если нет токена - редирект на login
  if (!token || !userStr) {
    localStorage.clear();
    window.location.href = '/index.html';
    return false;
  }
  
  // Проверяем роль
  try {
    const user = JSON.parse(userStr);
  
    if (user.role === 'speaker') {
      window.location.href = '/speaker.html';
      return false;
    }
  
    if (user.role !== 'admin') {
      localStorage.clear();
      window.location.href = '/index.html';
      return false;
    }

    return true;
  } catch (e) {
    console.error('[Admin Auth] Ошибка парсинга данных пользователя:', e);
    localStorage.clear();
    window.location.href = '/index.html';
    return false;
  }
}

/**
 * Обновить access token через refresh token
 */
async function refreshAccessToken() {
  const refreshToken = localStorage.getItem('refreshToken');
    
  if (!refreshToken) {
    return false;
  }
  
  try {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });
    
    if (response.ok) {
      const data = await response.json();
      localStorage.setItem('accessToken', data.accessToken);
      return true;
    }
  } catch (err) {
    console.error('Не удалось обновить токен:', err);
  }
  
  return false;
}

/**
 * Fetch с автоматической JWT авторизацией
 */
export async function adminFetch(url, opts = {}) {
  const token = localStorage.getItem('accessToken');
  
  if (!token) {
    window.location.href = '/index.html';
    throw new Error('Отсутствует токен авторизации');
  }
  
  const init = {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      'Authorization': `Bearer ${token}`
    }
  };
  
  const res = await fetch(url, init);
  
  // Если 401 - токен истек, пробуем refresh
  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    
    if (refreshed) {
      // Повторяем запрос с новым токеном
      return adminFetch(url, opts);
    } else {
      // ИСПРАВЛЕНО: Не удалось обновить - редирект на login
      localStorage.clear();
      window.location.href = '/index.html';
      throw new Error('Сессия истекла');
    }
  }
  
  return res;
}

/**
 * Установить JWT токен для XMLHttpRequest (для upload)
 */
export function setXhrAuth(xhr) {
  const token = localStorage.getItem('accessToken');
  if (token) {
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  }
}

/**
 * Logout
 */
export async function logout() {
  const refreshToken = localStorage.getItem('refreshToken');
  
  try {
    await adminFetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });
  } catch (err) {
    // Игнорируем ошибки при logout
  }
  
  localStorage.clear();
  // ИСПРАВЛЕНО: Редирект на login page
  window.location.href = '/index.html';
}


