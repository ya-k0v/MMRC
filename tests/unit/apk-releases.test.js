import { APK_MAX_VERSIONS, sanitizeApkVersion, normalizeApkReleases } from '../../src/utils/apk-releases.js';

function release(tag, { draft = false, apk = `app-release.apk`, published_at = '2026-10-09T00:00:00Z' } = {}) {
  const assets = apk ? [{ name: apk, browser_download_url: `https://example.com/${tag}/${apk}` }] : [];
  return { tag_name: tag, draft, assets, published_at };
}

describe('sanitizeApkVersion', () => {
  test('снимает префикс v и пробелы', () => {
    expect(sanitizeApkVersion('v1.0.1')).toBe('1.0.1');
    expect(sanitizeApkVersion(' 1.0.0 ')).toBe('1.0.0');
    expect(sanitizeApkVersion('1.0.0')).toBe('1.0.0');
  });

  test('отклоняет пустые и опасные значения', () => {
    expect(sanitizeApkVersion('')).toBeNull();
    expect(sanitizeApkVersion(null)).toBeNull();
    expect(sanitizeApkVersion('../etc')).toBeNull();
    expect(sanitizeApkVersion('1.0/1')).toBeNull();
  });
});

describe('normalizeApkReleases', () => {
  test('оставляет не более трёх последних версий', () => {
    const result = normalizeApkReleases([
      release('v1.0.2'),
      release('v1.0.1'),
      release('v1.0.0'),
      release('v0.9.9')
    ]);

    expect(result).toHaveLength(APK_MAX_VERSIONS);
    expect(result.map(r => r.version)).toEqual(['1.0.2', '1.0.1', '1.0.0']);
  });

  test('если релизов меньше трёх — отдаёт сколько есть', () => {
    const result = normalizeApkReleases([release('v1.0.1'), release('v1.0.0')]);

    expect(result.map(r => r.version)).toEqual(['1.0.1', '1.0.0']);
  });

  test('выкидывает черновики и релизы без APK', () => {
    const result = normalizeApkReleases([
      release('v2.0.0', { draft: true }),
      release('v1.0.1', { apk: null }),
      release('v1.0.0')
    ]);

    expect(result.map(r => r.version)).toEqual(['1.0.0']);
  });

  test('берёт ссылку на .apk и дату публикации', () => {
    const [first] = normalizeApkReleases([release('v1.0.1')]);

    expect(first.tag).toBe('v1.0.1');
    expect(first.downloadUrl).toBe('https://example.com/v1.0.1/app-release.apk');
    expect(first.publishedAt).toBe('2026-10-09T00:00:00Z');
  });

  test('не падает на не-массиве', () => {
    expect(normalizeApkReleases(null)).toEqual([]);
    expect(normalizeApkReleases({})).toEqual([]);
  });
});
