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
 * Список «параметр — значение». Значения экранируются; `html` — готовая
 * статическая разметка служебного элемента (иконки, пустой заполнитель с id),
 * которую caller подставляет сам. Данные с сервера в `html` передавать нельзя.
 */
export function renderDefs(rows) {
  const items = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (!items.length) return '';
  return `<dl class="st-defs">${items.map((row) => {
    const value = row.value == null || row.value === '' ? '—' : String(row.value);
    const rendered = typeof row.html === 'string' ? row.html : escapeHtml(value);
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
    const external = check.status === 'external';
    const tone = ok ? 'st-dot--success' : disabled ? 'st-dot--warning'
      : external ? 'st-dot--neutral' : 'st-dot--danger';
    const version = ok ? (check.version || 'доступен')
      : disabled ? 'локальный запуск'
        : external ? (check.version || 'внешний сервис')
          : 'недоступен';
    return `<span class="st-service" title="${escapeHtml(label)}: ${escapeHtml(version)}">
      <span class="st-dot ${tone}"></span>
      <span class="st-service-name">${escapeHtml(label)}</span>
      <code>${escapeHtml(version)}</code>
    </span>`;
  });
  return `<div class="st-service-grid">${items.join('')}</div>`;
}

/**
 * Состояние стека в Docker-режиме: здесь статус контейнеров важнее проверок
 * бинарников внутри mmrc. Префикс проекта приходит из конфигурации, а не
 * хардкодится, чтобы панель работала с любым compose-проектом.
 */
export function renderDockerContainers(containers, projectPrefix = '') {
  const prefix = String(projectPrefix || '');
  const stripPrefix = (name) => (
    prefix && name.startsWith(`${prefix}-`) ? name.slice(prefix.length + 1) : name
  );
  const shortName = (value) => stripPrefix(String(value || ''));
  // Образ показываем без registry/пользователя, тега и digest — только имя.
  const shortImage = (value) => {
    const image = String(value || '').split('@')[0];
    const lastPart = image.slice(image.lastIndexOf('/') + 1);
    return stripPrefix(lastPart.split(':')[0]);
  };

  const rows = (Array.isArray(containers) ? containers : [])
    .filter(Boolean)
    .filter((container) => shortName(container.names) !== 'minio-setup')
    .map((container) => {
      const running = String(container.state || '').toLowerCase() === 'running';
      const exitCode = /Exited \((\d+)\)/.exec(String(container.status || ''));
      const exitedClean = !running && exitCode && Number(exitCode[1]) === 0;
      const dot = running ? 'st-dot--success' : exitedClean ? 'st-dot--warning' : 'st-dot--danger';
      const status = running ? 'работает' : exitedClean ? 'завершён' : 'ошибка';
      const detail = [container.runningFor || container.status, shortImage(container.image)]
        .filter(Boolean).join(' · ');
      return `<div class="st-docker-row">
        <span class="st-dot ${dot}"></span>
        <span class="st-docker-name">${escapeHtml(shortName(container.names))}</span>
        <span class="st-docker-status">${status}</span>
        <span class="st-docker-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</span>
      </div>`;
    });

  if (!rows.length) return '<div class="meta">Состояние контейнеров недоступно</div>';
  return `<div class="st-docker-list">${rows.join('')}</div>`;
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

const STORAGE_SEGMENT_LABELS = Object.freeze({
  video: 'Видео',
  audio: 'Аудио',
  image: 'Изображения',
  documents: 'Документы',
  other: 'Другое',
  data: 'Данные MMRC',
  system: 'Система и прочее',
  used: 'Занято'
});
const STORAGE_SEGMENT_ORDER = Object.keys(STORAGE_SEGMENT_LABELS);

/** Размер в человекочитаемом виде; отрицательные значения не показываем. */
export function formatStorageSize(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} ГБ`;
  if (value >= 1048576) return `${(value / 1048576).toFixed(1)} МБ`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} КБ`;
  return `${Math.round(value)} Б`;
}

/**
 * Сегменты бара занятости в стиле «Хранилище iPhone»: типы контента из БД,
 * остаток данных без метаданных, прочее на диске и свободное место.
 * Значения в байтах; сумма сегментов не превышает ёмкость раздела.
 */
export function buildStorageSegments(usage = {}, byType = []) {
  const MB = 1048576;
  const usedBytes = Math.max(0, (Number(usage?.usedMB) || 0) * MB);
  const freeBytes = Math.max(0, (Number(usage?.availableMB) || 0) * MB);
  const capacityBytes = usedBytes + freeBytes;
  const hasDataSize = usage?.dataBytes != null || usage?.dataMB != null;
  const dataBytes = hasDataSize
    ? Math.max(0, Number(usage.dataBytes ?? ((Number(usage.dataMB) || 0) * MB)) || 0)
    : null;

  const totals = new Map();
  for (const item of Array.isArray(byType) ? byType : []) {
    const key = item?.key;
    if (!Object.hasOwn(STORAGE_SEGMENT_LABELS, key) || key === 'system' || key === 'data' || key === 'used') continue;
    totals.set(key, (totals.get(key) || 0) + Math.max(0, Number(item.bytes) || 0));
  }

  const sum = (map) => [...map.values()].reduce((acc, value) => acc + value, 0);
  const classifiedBytes = sum(totals);
  // Метаданные могут быть устаревшими (дубли, удалённые файлы): не даём
  // сегментам вылезти за реальный объём данных.
  if (dataBytes != null && classifiedBytes > dataBytes && classifiedBytes > 0) {
    const scale = dataBytes / classifiedBytes;
    for (const [key, bytes] of totals) totals.set(key, bytes * scale);
  }

  if (dataBytes != null) {
    const residual = Math.max(0, dataBytes - sum(totals));
    if (residual > 0) {
      // Если разбивки нет, весь объём MMRC — один сегмент «Данные MMRC».
      const key = totals.size ? 'other' : 'data';
      totals.set(key, (totals.get(key) || 0) + residual);
    }
    const systemBytes = Math.max(0, usedBytes - dataBytes);
    if (systemBytes > 0) totals.set('system', systemBytes);
  } else if (usedBytes > 0) {
    // Старый режим: объём наших данных неизвестен — сплошная заливка.
    totals.set('used', usedBytes);
  }

  const denominator = capacityBytes > 0 ? capacityBytes : sum(totals);
  const segments = [...totals.entries()]
    .filter(([, bytes]) => bytes > 0)
    .sort(([a], [b]) => STORAGE_SEGMENT_ORDER.indexOf(a) - STORAGE_SEGMENT_ORDER.indexOf(b))
    .map(([key, bytes]) => ({
      key,
      label: STORAGE_SEGMENT_LABELS[key],
      bytes: Math.round(bytes),
      percent: denominator > 0 ? (bytes * 100) / denominator : 0
    }));

  return { segments, freeBytes, capacityBytes };
}

/** Сегментированный бар и легенда под ним. При отсутствии разбивки — как раньше. */
export function renderStorageBar(usage = {}, byType = []) {
  const { segments, freeBytes } = buildStorageSegments(usage, byType);
  const stacked = segments.some(segment => segment.key !== 'used');
  const description = segments.map(segment => `${segment.label}: ${formatStorageSize(segment.bytes)}`).join('; ');

  const bar = `<div class="st-bar${stacked ? ' st-bar--stacked' : ''}" role="img" aria-label="${escapeHtml(description || 'Нет данных о занятости')}">
    ${segments.map(segment => {
      const tone = segment.key === 'used'
        ? segment.percent >= 90 ? ' st-bar-fill--danger' : segment.percent >= 75 ? ' st-bar-fill--warning' : ' st-bar-fill--success'
        : '';
      const title = `${segment.label}: ${formatStorageSize(segment.bytes)} · ${segment.percent.toFixed(1)}%`;
      return `<span class="st-bar-seg storage-seg--${segment.key}${tone}" style="width:${Math.min(100, segment.percent).toFixed(3)}%" title="${escapeHtml(title)}"></span>`;
    }).join('')}
  </div>`;
  if (!stacked) return bar;

  const legend = segments.map(segment => `<span class="st-storage-legend-item">
    <span class="st-legend-dot storage-seg--${segment.key}"></span>
    <span class="st-legend-label">${escapeHtml(segment.label)}</span>
    <strong>${formatStorageSize(segment.bytes)}</strong>
  </span>`);
  if (freeBytes > 0) {
    legend.push(`<span class="st-storage-legend-item">
      <span class="st-legend-dot storage-seg--free"></span>
      <span class="st-legend-label">Свободно</span>
      <strong>${formatStorageSize(freeBytes)}</strong>
    </span>`);
  }

  return `${bar}<div class="st-storage-legend">${legend.join('')}</div>`;
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
    // Кэш релизов уже показан в сводке; подробность оставляем в подсказке,
    // чтобы открытие раздела не пугало ошибкой GitHub API 403.
    html += `<div class="meta st-apk-error" title="${escapeHtml(data.error)}">Релизы GitHub недоступны — показаны локальные данные.</div>`;
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
