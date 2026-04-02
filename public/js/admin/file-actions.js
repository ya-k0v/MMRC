// file-actions.js - Действия над файлами

import { adminFetch } from './auth.js';

// Универсальная функция формирования src для превью
export function buildPreviewSrc({ deviceId, fileName, type, trailerUrl, page }) {
  let src = `/player-videojs.html?device_id=${encodeURIComponent(deviceId)}&file=${encodeURIComponent(fileName)}&preview=1&muted=1`;
  if (type) src += `&type=${encodeURIComponent(type)}`;
  if (typeof page !== 'undefined') src += `&page=${encodeURIComponent(page)}`;
  if (trailerUrl) src += `&trailerUrl=${encodeURIComponent(trailerUrl)}`;
  src += `&t=${Date.now()}`;
  return src;
}

// previewFile теперь поддерживает трейлеры и типы
export async function previewFile(deviceId, fileName, opts = {}) {
  const src = buildPreviewSrc({
    deviceId,
    fileName,
    type: opts.type,
    trailerUrl: opts.trailerUrl,
    page: opts.page
  });
  window.open(src, '_blank');
}

export async function makeDefault(deviceId, fileName) {
  const res = await adminFetch(`/api/devices/${deviceId}/make-default`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: fileName })
  });
  return await res.json();
}

export async function renameFile(deviceId, oldName, newName) {
  const res = await adminFetch(`/api/devices/${deviceId}/files/${encodeURIComponent(oldName)}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newName })
  });
  return await res.json();
}

export async function deleteFile(deviceId, fileName) {
  const res = await adminFetch(`/api/devices/${deviceId}/files/${encodeURIComponent(fileName)}`, {
    method: 'DELETE'
  });
  return await res.json();
}
