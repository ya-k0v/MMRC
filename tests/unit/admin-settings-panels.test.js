/**
 * Наполнение правой панели настроек: форматирование и HTML-блоки без сети.
 */
const {
  formatDateTime,
  formatUptimeShort,
  renderDefs,
  renderServices,
  renderDockerContainers,
  renderNetwork,
  renderStorageDetails,
  renderStorageBar,
  buildStorageSegments,
  formatStorageSize,
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

  test('renderDefs подставляет статическую разметку html как есть', () => {
    const html = renderDefs([
      { label: 'Ветка', html: '<span id="stSysBranchText">—</span>' },
      { label: 'Внешнее значение', value: '<img src=x>', html: true }
    ]);

    expect(html).toContain('<span id="stSysBranchText">—</span>');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<img');
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

  test('renderServices показывает внешние сервисы без ложной ошибки', () => {
    const html = renderServices({
      ffmpeg: { status: 'external', version: 'через mmrc-streamer' },
      ffprobe: { status: 'external', version: 'через mmrc-streamer' },
      git: { status: 'external', version: 'не нужен внутри образа' },
      node: { status: 'ok', version: 'v22' },
      openssl: { status: 'ok', version: 'OpenSSL 3' },
      docker: { status: 'ok', version: 'доступен' }
    });

    expect(html).toContain('st-dot--neutral');
    expect(html).toContain('через mmrc-streamer');
    expect(html).not.toContain('st-dot--danger');
  });

  test('renderDockerContainers показывает статусы стека и скрывает одноразовый setup', () => {
    const html = renderDockerContainers([
      { names: 'mmrc', state: 'running', status: 'Up 54 minutes', runningFor: '54 minutes', image: 'mmrc:v340' },
      { names: 'mmrc-redis', state: 'exited', status: 'Exited (0) 2 minutes ago', image: 'redis:7' },
      { names: 'mmrc-minio-setup', state: 'exited', status: 'Exited (0)', image: 'minio/mc' },
      { names: 'mmrc-streamer', state: 'exited', status: 'Exited (1)', image: 'streamer:v1' }
    ], 'mmrc');

    expect(html).toContain('st-dot--success');
    expect(html).toContain('работает');
    expect(html).toContain('54 minutes');
    expect(html).toContain('st-dot--warning');
    expect(html).toContain('завершён');
    expect(html).toContain('st-dot--danger');
    expect(html).toContain('ошибка');
    expect(html).not.toContain('minio-setup');
    // Префикс проекта убирается только когда он передан конфигурацией.
    expect(html).toContain('>redis<');
  });

  test('renderDockerContainers экранирует данные и работает без списка', () => {
    const html = renderDockerContainers([
      { names: '<evil>', state: 'running', status: 'Up', image: 'x"<script>' }
    ]);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<evil>');
    expect(renderDockerContainers(null)).toContain('недоступно');
    expect(renderDockerContainers([])).toContain('недоступно');
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

describe('сегментированный бар хранилища', () => {
  const MB = 1048576;

  test('форматирует размеры без отрицательных значений', () => {
    expect(formatStorageSize(2 * 1024 ** 3)).toBe('2.0 ГБ');
    expect(formatStorageSize(512 * MB)).toBe('512.0 МБ');
    expect(formatStorageSize(-10)).toBe('0 Б');
  });

  test('разбивает данные по типам, добавляет остаток и прочее на диске', () => {
    const { segments, freeBytes } = buildStorageSegments(
      { usedMB: 1000, availableMB: 1000, dataBytes: 500 * MB },
      [
        { key: 'video', bytes: 200 * MB, files: 5 },
        { key: 'audio', bytes: 50 * MB, files: 2 }
      ]
    );

    expect(segments.map(segment => segment.key)).toEqual(['video', 'audio', 'other', 'system']);
    expect(segments.find(segment => segment.key === 'other').bytes).toBe(250 * MB);
    expect(segments.find(segment => segment.key === 'system').bytes).toBe(500 * MB);
    expect(freeBytes).toBe(1000 * MB);
    expect(segments.reduce((sum, segment) => sum + segment.percent, 0)).toBeCloseTo(50, 5);
  });

  test('устаревшие метаданные не выходят за реальный объём данных', () => {
    const { segments } = buildStorageSegments(
      { usedMB: 100, availableMB: 100, dataBytes: 100 * MB },
      [{ key: 'video', bytes: 150 * MB }]
    );
    expect(segments).toHaveLength(1);
    expect(segments[0].bytes).toBe(100 * MB);
  });

  test('без разбивки показывается один сегмент, как раньше', () => {
    const { segments } = buildStorageSegments({ usedMB: 100, availableMB: 900 }, []);
    expect(segments.map(segment => segment.key)).toEqual(['used']);
    expect(segments[0].percent).toBeCloseTo(10, 5);
    expect(renderStorageBar({ usedMB: 100, availableMB: 900 }, [])).not.toContain('st-bar--stacked');
  });

  test('без данных о наших файлах весь объём MMRC — сегмент «Данные MMRC»', () => {
    const { segments } = buildStorageSegments(
      { usedMB: 100, availableMB: 100, dataMB: 40 },
      []
    );
    expect(segments.map(segment => segment.key)).toEqual(['data', 'system']);
  });

  test('рендерит легенду, цветные сегменты и экранирует атрибуты', () => {
    const html = renderStorageBar(
      { usedMB: 200, availableMB: 800, dataBytes: 100 * MB },
      [{ key: 'video', bytes: 100 * MB }]
    );

    expect(html).toContain('st-bar--stacked');
    expect(html).toContain('storage-seg--video');
    expect(html).toContain('storage-seg--free');
    expect(html).toContain('Видео');
    expect(html).toContain('Свободно');
    expect(html).toMatch(/aria-label="[^"]*Видео/);
    expect(html).not.toContain('<script>');
  });
});
