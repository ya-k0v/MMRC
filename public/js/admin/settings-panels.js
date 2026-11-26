/**
 * Наполнение правой панели дерева настроек. Функции чистые: получают уже
 * загруженные админские данные и возвращают HTML — это позволяет покрыть
 * разметку юнит-тестами и не дергать сеть повторно.
 * @module admin/settings-panels
 */

import { escapeHtml } from '../shared/utils.js';

/** Дата в локальном формате браузера; невалидное значение превращается в тире. */
export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** Короткий uptime в стиле бэкенда: 2д 3ч 4м 5с. */
export function formatUptimeShort(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const parts = [];
  if (days) parts.push(`${days}д`);
  if (hours) parts.push(`${hours}ч`);
  if (minutes) parts.push(`${minutes}м`);
  if (secs || parts.length === 0) parts.push(`${secs}с`);
  return parts.join(' ');
}

/**
 * Список «параметр — значение». Значения экранируются; `html` нужен только
 * для служебных элементов вроде иконки статуса обновления.
 */
export function renderDefs(rows) {
  const items = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (!items.length) return '';
  return `<dl class="st-defs">${items.map((row) => {
    const value = row.value == null || row.value === '' ? '—' : String(row.value);
    const rendered = row.html ? value : escapeHtml(value);
    const title = row.title ? ` title="${escapeHtml(row.title)}"` : '';
    return `<div class="st-defs-item">
      <dt>${escapeHtml(row.label)}</dt>
      <dd${row.code ? ' class="st-defs-code"' : ''}${title}>${row.code ? `<code>${rendered}</code>` : rendered}</dd>
    </div>`;
  }).join('')}</dl>`;
}

/** Ряд диагностики сервиса: цветная точка, имя и версия/режим. */
export function renderServices(services = {}) {
  const checks = [
    ['node', 'Node.js'],
    ['ffmpeg', 'FFmpeg'],
    ['ffprobe', 'FFprobe'],
    ['git', 'Git'],
    ['openssl', 'OpenSSL'],
    ['docker', 'Docker']
  ];
  const items = checks.map(([key, label]) => {
    const check = services[key] || {};
    const disabled = check.status === 'disabled';
    const ok = check.status === 'ok';
    const tone = ok ? 'st-dot--success' : disabled ? 'st-dot--warning' : 'st-dot--danger';
    const version = ok ? (check.version || 'доступен') : disabled ? 'локальный запуск' : 'недоступен';
    return `<span class="st-service" title="${escapeHtml(label)}: ${escapeHtml(version)}">
      <span class="st-dot ${tone}"></span>
      <span class="st-service-name">${escapeHtml(label)}</span>
      <code>${escapeHtml(version)}</code>
    </span>`;
  });
  return `<div class="st-service-grid">${items.join('')}</div>`;
}

/** Внешние (не loopback) адреса интерфейсов сервера. */
export function renderNetwork(network = []) {
  const rows = [];
  (Array.isArray(network) ? network : []).forEach((iface) => {
    (Array.isArray(iface?.addresses) ? iface.addresses : []).forEach((addr) => {
      rows.push({ name: iface.name, addr });
    });
  });
  if (!rows.length) return '<div class="meta">Внешних адресов нет</div>';

  return `<div class="st-net-list">${rows.slice(0, 8).map(({ name, addr }) => `
    <div class="st-net-row">
      <span class="st-net-iface">${escapeHtml(name)}</span>
      <code class="st-net-addr">${escapeHtml(addr.address || '—')}</code>
      <span class="meta">${escapeHtml(addr.cidr || addr.family || '')}</span>
    </div>`).join('')}</div>`;
}

/** Пути и параметры хранилища: и локальный, и S3 variant показывают своё. */
export function renderStorageDetails(storage = {}, runtime = {}) {
  const remote = Boolean(storage.isRemote);
  const rows = [
    { label: 'Режим', value: remote ? 'S3 / MinIO' : 'Локальное хранилище' },
    remote
      ? { label: 'Endpoint', value: storage.endpoint, code: true }
      : { label: 'Путь на хосте', value: storage.hostContentRoot || runtime.contentRoot, code: true }
  ];

  if (remote) {
    rows.push(
      { label: 'Bucket', value: storage.bucket, code: true },
      { label: 'Регион', value: storage.region || 'по умолчанию' },
      { label: 'Path-style', value: storage.forcePathStyle ? 'включён' : 'выключен' }
    );
  }

  rows.push(
    { label: 'Корень данных', value: runtime.dataRoot || runtime.contentRoot, code: true },
    { label: 'Converted cache', value: runtime.convertedCache, code: true },
    { label: 'Temp', value: runtime.tempDir, code: true },
    { label: 'Логи', value: runtime.logsDir, code: true }
  );
  return renderDefs(rows);
}

/** Безопасные (без пароля) настройки LDAP из /api/admin/settings/extended. */
export function renderLdapDetails(ldap = {}) {
  const rows = [
    { label: 'Статус', value: ldap.enabled ? 'Включена' : 'Отключена' },
    { label: 'URL', value: ldap.url, code: true },
    { label: 'Base DN', value: ldap.baseDN, code: true },
    { label: 'Bind DN', value: ldap.bindDN, code: true },
    { label: 'Пароль', value: ldap.bindPasswordSet ? 'установлен' : 'не установлен' },
    { label: 'Фильтр пользователей', value: ldap.userFilter, code: true },
    { label: 'Атрибут имени', value: ldap.usernameAttribute, code: true },
    { label: 'Область поиска', value: ldap.searchScope },
    { label: 'Автосоздание пользователей', value: ldap.autoCreateUsers ? 'да' : 'нет' },
    { label: 'Роль по умолчанию', value: ldap.defaultRole },
    { label: 'Таймауты', value: `${ldap.connectTimeoutMs || '—'} / ${ldap.operationTimeoutMs || '—'} мс` },
    { label: 'Проверка TLS', value: ldap.tlsRejectUnauthorized ? 'строго' : 'отключена' }
  ];
  return renderDefs(rows);
}

/** Сводка по версиям APK: что выбрано, что выложено, что лежит на сервере. */
export function renderApkSummary(data = {}) {
  const versions = Array.isArray(data.versions) ? data.versions : [];
  const downloaded = versions.filter(v => v.downloaded).length;
  const selected = data.selectedVersion || data.installedVersion || '—';
  const rows = [
    { label: 'Выбранная версия', value: selected },
    { label: 'Последний релиз', value: data.latestVersion || '—' },
    { label: 'APK на сервере', value: data.installedVersion || '—' },
    { label: 'Релизов найдено', value: versions.length },
    { label: 'Файлов загружено', value: downloaded },
    { label: 'Опубликован', value: formatDateTime(data.publishedAt) }
  ];
  let html = renderDefs(rows);
  if (data.error) {
    html += `<div class="meta st-apk-error">GitHub недоступен: ${escapeHtml(data.error)}</div>`;
  }
  return html;
}

/** Человекочитаемый итог отчёта сверки БД и хранилища. */
export function formatReconcileReport(report = {}) {
  if (!report || report.error) return report?.error || 'Не удалось выполнить сверку';
  const parts = [
    `Проверено: ${report.checked ?? 0}`,
    `на месте: ${report.present ?? 0}`,
    `отсутствуют: ${report.missing ?? 0}`,
    `не определено: ${report.unknown ?? 0}`,
    `сироты: ${report.orphanCount ?? 0}`,
    `ошибки: ${report.errors ?? 0}`
  ];
  const base = parts.join(' · ');
  return report.orphansUnavailable ? `${base}. Сироты: ${report.orphansUnavailable}` : base;
}
