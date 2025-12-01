// file-actions.js - Действия над файлами
import { adminFetch } from './auth.js';

export async function previewFile(deviceId, fileName) {
  window.open(`/player-videojs.html?device_id=${deviceId}&file=${encodeURIComponent(fileName)}&preview=1`, '_blank');
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
