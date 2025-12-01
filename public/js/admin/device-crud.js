// device-crud.js - CRUD операции с устройствами
import { adminFetch } from './auth.js';

export async function createDevice(deviceId, name) {
  const res = await adminFetch('/api/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId, name })
  });
  return await res.json();
}

export async function renameDevice(deviceId, newName) {
  const res = await adminFetch(`/api/devices/${deviceId}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName })
  });
  return await res.json();
}

export async function deleteDevice(deviceId) {
  const res = await adminFetch(`/api/devices/${deviceId}`, {
    method: 'DELETE'
  });
  return await res.json();
}
