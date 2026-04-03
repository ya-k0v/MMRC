// ui-helpers.js - UI вспомогательные функции (РЕАЛЬНЫЙ код из admin.js)

export function clearDetail(title = 'Не выбрано', message = 'Выберите устройство слева') {
  const pane = document.getElementById('detailPane');
  if (!pane) return;
  pane.innerHTML = `
    <div class="card" style="min-height:200px; display:flex; flex-direction:column; justify-content:center">
      <div class="header">
        <div>
          <div class="title">${title}</div>
          <div class="meta">${message}</div>
        </div>
      </div>
    </div>
  `;
}

export function clearFilesPane(metaText = 'Выберите устройство слева', placeholderText = 'Список файлов появится после выбора устройства.') {
  const title = document.getElementById('filesPaneTitle');
  const meta = document.getElementById('filesPaneMeta');
  const panel = document.getElementById('filesPanel');
  const pager = document.getElementById('filePagerAdmin');
  if (title) title.textContent = 'Файлы';
  if (meta) meta.textContent = metaText;
  if (panel) {
    panel.innerHTML = `<div class="meta" style="padding:var(--space-md); text-align:center;">${placeholderText}</div>`;
  }
  if (pager) pager.innerHTML = '';
}

export function openDevice(deviceId) {
  // Обновляем URL при переключении устройства
  const url = new URL(location.href);
  url.searchParams.set('device_id', deviceId);
  history.replaceState(null, '', url.toString());
}
