// upload-manager.js - Upload и drag-drop
import { adminFetch, setXhrAuth } from './auth.js';

export async function uploadFiles(deviceId, files, onProgress) {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }
  
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    setXhrAuth(xhr);
    
    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          onProgress(percent);
        }
      });
    }
    
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        reject(new Error(`Upload failed: ${xhr.status}`));
      }
    });
    
    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.open('POST', `/api/devices/${deviceId}/upload`);
    xhr.send(formData);
  });
}

export async function copyFile(sourceDeviceId, targetDeviceId, fileName, move = false) {
  const res = await adminFetch(`/api/devices/${targetDeviceId}/copy-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceDeviceId, fileName, move })
  });
  return await res.json();
}
