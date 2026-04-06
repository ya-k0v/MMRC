/**
 * JWT Authentication для speaker панели
 * @module speaker/auth
 */

export async function ensureAuth() {
  const token = localStorage.getItem('accessToken');
  
  // ИСПРАВЛЕНО: Редирект на login page
  if (!token) {
    localStorage.clear(); // Очищаем возможный мусор
    window.location.href = '/index.html';
    return false;
  }
  
  // Speaker и Admin могут на speaker панель
  try {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    if (!user.role || (user.role !== 'admin' && user.role !== 'speaker')) {
      localStorage.clear(); // Очищаем невалидные данные
      window.location.href = '/index.html';
      return false;
    }
  } catch (e) {
    localStorage.clear(); // Битые данные
    window.location.href = '/index.html';
    return false;
  }
  
  return true;
}

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

export async function speakerFetch(url, opts = {}) {
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
  
  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    
    if (refreshed) {
      return speakerFetch(url, opts);
    } else {
      // ИСПРАВЛЕНО: Редирект на login page
      localStorage.clear();
      window.location.href = '/index.html';
      throw new Error('Сессия истекла');
    }
  }
  
  return res;
}

export async function logout() {
  const refreshToken = localStorage.getItem('refreshToken');
  
  try {
    await speakerFetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });
  } catch (err) {
    // Ignore
  }
  
  localStorage.clear();
  // ИСПРАВЛЕНО: Редирект на login page
  window.location.href = '/index.html';
}

