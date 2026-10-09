/**
 * Нормализация релизов Android-плеера и версий APK.
 *
 * GitHub отдаёт релизы отдельными объектами с вложенными assets, а логика
 * выбора/сравнения версий нужна и в API, и в тестах. Держим её чистой,
 * без обращения к сети и файловой системе.
 */

export const APK_MAX_VERSIONS = 3;

/** Приводит тег/версию к каноническому виду без префикса "v". */
export function sanitizeApkVersion(version) {
  const normalized = String(version || '').trim().replace(/^v/i, '');
  return /^[0-9A-Za-z._-]+$/.test(normalized) ? normalized : null;
}

/** Превращает ответ GitHub (список релизов) в компактный список версий APK. */
export function normalizeApkReleases(releases, limit = APK_MAX_VERSIONS) {
  if (!Array.isArray(releases)) {
    return [];
  }

  return releases
    .filter((release) => release && !release.draft)
    .map((release) => {
      const tag = release.tag_name || '';
      const apkAsset = (release.assets || []).find((asset) => asset.name?.toLowerCase().endsWith('.apk'));
      return {
        version: sanitizeApkVersion(tag),
        tag,
        downloadUrl: apkAsset?.browser_download_url || null,
        publishedAt: release.published_at || null
      };
    })
    .filter((release) => release.version && release.downloadUrl)
    .slice(0, limit);
}
