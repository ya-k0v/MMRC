/**
 * Наполнение правой панели настроек: форматирование и HTML-блоки без сети.
 */
const {
  formatDateTime,
  formatUptimeShort,
  renderDefs,
  renderServices,
  renderNetwork,
  renderStorageDetails,
  renderLdapDetails,
  renderApkSummary,
  formatReconcileReport
} = await import('../../public/js/admin/settings-panels.js');

describe('форматирование', () => {
  test('uptime кратко и без отрицательных значений', () => {
    expect(formatUptimeShort(0)).toBe('0с');
    expect(formatUptimeShort(93785)).toBe('1д 2ч 3м 5с');
    expect(formatUptimeShort(-10)).toBe('0с');
    expect(formatUptimeShort('abc')).toBe('0с');
  });

  test('дата превращается в локальную строку, мусор — в тире', () => {
    const formatted = formatDateTime('2026-11-26T10:00:00Z');
    expect(formatted).not.toBe('—');
    expect(formatted).toMatch(/\d/);
    expect(formatDateTime('')).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
  });
});

describe('блоки панелей', () => {
  test('renderDefs экранирует значения и помечает code', () => {
    const html = renderDefs([
      { label: 'Путь', value: '<script>&', code: true },
      { label: 'Пусто', value: '' }
    ]);

    expect(html).toContain('&lt;script&gt;&amp;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('class="st-defs-code"');
    expect(html).toContain('<dd>—</dd>');
  });

  test('renderServices различает доступные, отключённые и упавшие сервисы', () => {
    const html = renderServices({
      node: { status: 'ok', version: 'v22.0.0' },
      docker: { status: 'disabled' },
      ffmpeg: { status: 'error' }
    });

    expect(html).toContain('st-dot--success');
    expect(html).toContain('v22.0.0');
    expect(html).toContain('локальный запуск');
    expect(html).toContain('st-dot--danger');
    expect(html).toContain('недоступен');
  });

  test('renderNetwork ограничивает число адресов и экранирует имена', () => {
    const iface = {
      name: '<eth0>',
      addresses: Array.from({ length: 12 }, (_, i) => ({ address: `10.0.0.${i}`, cidr: `10.0.0.${i}/24` }))
    };
    const html = renderNetwork([iface]);

    expect(html).toContain('&lt;eth0&gt;');
    expect((html.match(/st-net-row/g) || []).length).toBe(8);
    expect(renderNetwork([])).toContain('Внешних адресов нет');
  });

  test('renderStorageDetails показывает локальный путь и пути runtime', () => {
    const html = renderStorageDetails(
      { isRemote: false, hostContentRoot: '/host/data' },
      { contentRoot: '/app/data', convertedCache: '/app/cache', logsDir: '/app/logs', tempDir: '/app/tmp' }
    );

    expect(html).toContain('Локальное хранилище');
    expect(html).toContain('/host/data');
    expect(html).toContain('/app/cache');
    expect(html).toContain('/app/logs');
  });

  test('renderStorageDetails для S3 показывает bucket, endpoint и path-style', () => {
    const html = renderStorageDetails({
      isRemote: true,
      endpoint: 'http://minio:9000',
      bucket: 'mmrc',
      region: 'us-east-1',
      forcePathStyle: true
    });

    expect(html).toContain('S3 / MinIO');
    expect(html).toContain('http://minio:9000');
    expect(html).toContain('mmrc');
    expect(html).toContain('включён');
  });

  test('renderLdapDetails не раскрывает пароль', () => {
    const html = renderLdapDetails({
      enabled: true,
      url: 'ldap://dc.local:389',
      baseDN: 'DC=local',
      bindDN: 'CN=admin',
      bindPassword: 'secret',
      bindPasswordSet: true,
      userFilter: '(sAMAccountName={username})'
    });

    expect(html).toContain('ldap://dc.local:389');
    expect(html).toContain('установлен');
    expect(html).not.toContain('secret');
  });

  test('renderApkSummary считает загруженные версии и показывает ошибку GitHub', () => {
    const html = renderApkSummary({
      selectedVersion: '3.4.1',
      latestVersion: '3.4.2',
      installedVersion: '3.4.0',
      versions: [
        { version: '3.4.2', downloaded: false },
        { version: '3.4.1', downloaded: true }
      ],
      publishedAt: '2026-11-20T10:00:00Z',
      error: 'timeout'
    });

    expect(html).toContain('3.4.1');
    expect(html).toContain('3.4.2');
    expect(html).toContain('<dd>1</dd>');
    expect(html).toContain('timeout');
  });

  test('formatReconcileReport собирает итог и сообщает о недоступных сиротах', () => {
    const text = formatReconcileReport({
      checked: 10, present: 7, missing: 1, unknown: 1, orphanCount: 0, errors: 1,
      orphansUnavailable: 'list timeout'
    });

    expect(text).toContain('Проверено: 10');
    expect(text).toContain('отсутствуют: 1');
    expect(text).toContain('list timeout');
    expect(formatReconcileReport({ error: 'boom' })).toBe('boom');
  });
});
