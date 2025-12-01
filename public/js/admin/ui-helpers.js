// ui-helpers.js - UI вспомогательные функции (РЕАЛЬНЫЙ код из admin.js)

export function clearDetail() {
  const pane = document.getElementById('detailPane');
  if (!pane) return;
  pane.innerHTML = `
    <div class="card" style="min-height:200px">
      <div class="header">
        <div>
          <div class="title">Не выбрано</div>
          <div class="meta">Выберите слева</div>
        </div>
      </div>
    </div>
  `;
}

export function clearFilesPane() {
  const meta = document.getElementById('filesPaneMeta');
  const panel = document.getElementById('filesPanel');
  if (meta) meta.textContent = 'Выберите слева';
  if (panel) panel.innerHTML = '';
}

export function openDevice(deviceId) {
  // Обновляем URL при переключении устройства
  const url = new URL(location.href);
  url.searchParams.set('device_id', deviceId);
  history.replaceState(null, '', url.toString());
}
