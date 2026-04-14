import fs from 'fs';
import path from 'path';
import { ROOT, DEFAULT_DEVICES_PATH, DEFAULT_DATA_ROOT, setDevicesPath, DEVICES } from './constants.js';

// КРИТИЧНО: НЕ импортируем logger здесь, так как это создает циклическую зависимость:
// logger.js -> settings-manager.js (getLogsDir) -> logger.js
// Вместо этого используем lazy import logger только в функциях, которые его используют

// Сохраняем текущий путь для отслеживания изменений
let currentContentRoot = DEFAULT_DATA_ROOT;

const SETTINGS_FILE = path.join(ROOT, 'config', 'app-settings.json');

const LDAP_DEFAULTS = {
  enabled: false,
  url: '',
  bindDN: '',
  bindPassword: '',
  baseDN: '',
  userFilter: '(sAMAccountName={username})',
  usernameAttribute: 'sAMAccountName',
  searchScope: 'sub',
  autoCreateUsers: true,
  defaultRole: 'speaker',
  connectTimeoutMs: 5000,
  operationTimeoutMs: 5000,
  tlsRejectUnauthorized: true,
  groupRoleMap: {
    admin: [],
    speaker: [],
    hero_admin: []
  },
  rolePriority: ['admin', 'hero_admin', 'speaker']
};

const ALLOWED_SEARCH_SCOPES = new Set(['base', 'one', 'sub']);
const ALLOWED_USER_ROLES = new Set(['admin', 'speaker', 'hero_admin']);

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return fallback;
}

function normalizeNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.round(parsed);
}

function normalizeSearchScope(scope) {
  const normalized = String(scope || '').trim().toLowerCase();
  return ALLOWED_SEARCH_SCOPES.has(normalized) ? normalized : LDAP_DEFAULTS.searchScope;
}

function normalizeRole(role) {
  const normalized = String(role || '').trim().toLowerCase();
  return ALLOWED_USER_ROLES.has(normalized) ? normalized : LDAP_DEFAULTS.defaultRole;
}

function splitList(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => splitList(item));
  }

  if (typeof value !== 'string') {
    return [];
  }

  const text = value.trim();
  if (!text) {
    return [];
  }

  // Для LDAP DN запятые являются частью значения, поэтому
  // разделяем только по ';' или новой строке.
  if (!/[;\n]/.test(text)) {
    return [text];
  }

  return text
    .split(/[;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitRoleList(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => splitRoleList(item));
  }

  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeUniqueCaseInsensitive(values = []) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const key = String(value).trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(String(value).trim());
  }

  return result;
}

function normalizeGroupRoleMap(sourceMap = {}, baseMap = LDAP_DEFAULTS.groupRoleMap) {
  const source = sourceMap && typeof sourceMap === 'object' ? sourceMap : {};
  const base = baseMap && typeof baseMap === 'object' ? baseMap : LDAP_DEFAULTS.groupRoleMap;

  return {
    admin: normalizeUniqueCaseInsensitive(splitList(source.admin ?? base.admin ?? [])),
    speaker: normalizeUniqueCaseInsensitive(splitList(source.speaker ?? base.speaker ?? [])),
    hero_admin: normalizeUniqueCaseInsensitive(splitList(source.hero_admin ?? base.hero_admin ?? []))
  };
}

function normalizeRolePriority(value, fallback = LDAP_DEFAULTS.rolePriority) {
  const source = normalizeUniqueCaseInsensitive(splitRoleList(value));
  const base = Array.isArray(fallback) && fallback.length
    ? fallback
    : LDAP_DEFAULTS.rolePriority;

  const normalized = source
    .map((role) => String(role || '').trim().toLowerCase())
    .filter((role) => ALLOWED_USER_ROLES.has(role));

  if (!normalized.length) {
    return [...base];
  }

  return normalized;
}

function normalizeLdapAuthSettings(raw = {}, current = LDAP_DEFAULTS) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const base = current && typeof current === 'object' ? current : LDAP_DEFAULTS;

  const sourceMap = source.groupRoleMap && typeof source.groupRoleMap === 'object'
    ? source.groupRoleMap
    : {
        admin: source.groupsAdmin ?? source.groupAdmin,
        speaker: source.groupsSpeaker ?? source.groupSpeaker,
        hero_admin: source.groupsHeroAdmin ?? source.groupHeroAdmin
      };
  const baseMap = base.groupRoleMap && typeof base.groupRoleMap === 'object'
    ? base.groupRoleMap
    : LDAP_DEFAULTS.groupRoleMap;

  return {
    enabled: normalizeBoolean(source.enabled, normalizeBoolean(base.enabled, LDAP_DEFAULTS.enabled)),
    url: String(source.url ?? base.url ?? LDAP_DEFAULTS.url).trim(),
    bindDN: String(source.bindDN ?? base.bindDN ?? LDAP_DEFAULTS.bindDN).trim(),
    bindPassword: String(source.bindPassword ?? base.bindPassword ?? LDAP_DEFAULTS.bindPassword),
    baseDN: String(source.baseDN ?? base.baseDN ?? LDAP_DEFAULTS.baseDN).trim(),
    userFilter: String(source.userFilter ?? base.userFilter ?? LDAP_DEFAULTS.userFilter).trim() || LDAP_DEFAULTS.userFilter,
    usernameAttribute: String(source.usernameAttribute ?? base.usernameAttribute ?? LDAP_DEFAULTS.usernameAttribute).trim() || LDAP_DEFAULTS.usernameAttribute,
    searchScope: normalizeSearchScope(source.searchScope ?? base.searchScope ?? LDAP_DEFAULTS.searchScope),
    autoCreateUsers: normalizeBoolean(source.autoCreateUsers, normalizeBoolean(base.autoCreateUsers, LDAP_DEFAULTS.autoCreateUsers)),
    defaultRole: normalizeRole(source.defaultRole ?? base.defaultRole ?? LDAP_DEFAULTS.defaultRole),
    connectTimeoutMs: normalizeNumber(source.connectTimeoutMs ?? base.connectTimeoutMs, LDAP_DEFAULTS.connectTimeoutMs),
    operationTimeoutMs: normalizeNumber(source.operationTimeoutMs ?? base.operationTimeoutMs, LDAP_DEFAULTS.operationTimeoutMs),
    tlsRejectUnauthorized: normalizeBoolean(
      source.tlsRejectUnauthorized,
      normalizeBoolean(base.tlsRejectUnauthorized, LDAP_DEFAULTS.tlsRejectUnauthorized)
    ),
    groupRoleMap: normalizeGroupRoleMap(sourceMap, baseMap),
    rolePriority: normalizeRolePriority(source.rolePriority ?? base.rolePriority ?? LDAP_DEFAULTS.rolePriority)
  };
}

// КРИТИЧНО: Инициализируем settings сразу, чтобы избежать ошибки "Cannot access 'settings' before initialization"
// Это важно, так как logger.js может использовать getLogsDir() до полной инициализации модуля
let settings = {
  contentRoot: process.env.CONTENT_ROOT || DEFAULT_DATA_ROOT
};

// КРИТИЧНО: Загружаем настройки из файла синхронно при загрузке модуля
// Это предотвращает ошибку "Cannot access 'settings' before initialization"
// НЕ используем logger здесь, так как он может создать циклическую зависимость
try {
  if (fs.existsSync(SETTINGS_FILE)) {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    if (raw?.trim()) {
      const parsed = JSON.parse(raw);
      settings = {
        ...settings,
        ...parsed
      };
      delete settings.ldapAuth;
      // Environment override: if CONTENT_ROOT is provided via env, prefer it
      if (process.env.CONTENT_ROOT && typeof process.env.CONTENT_ROOT === 'string' && process.env.CONTENT_ROOT.trim()) {
        settings.contentRoot = process.env.CONTENT_ROOT.trim();
      }
    }
  } else {
    // Создаем файл с настройками по умолчанию
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  }
} catch (error) {
  // Игнорируем ошибки при загрузке настроек при инициализации модуля
  // logger еще может быть не инициализирован
}

function isWritableDirectory(dirPath) {
  try {
    if (typeof dirPath !== 'string') {
      return false;
    }

    const trimmed = dirPath.trim();
    if (!trimmed || trimmed.includes('\0') || !/^[a-zA-Z0-9_./\-\s]+$/.test(trimmed)) {
      return false;
    }

    const normalizedCandidate = path.resolve(trimmed);
    const projectRoot = path.resolve(ROOT);
    const mountRoot = path.resolve('/mnt');

    return (
      normalizedCandidate === projectRoot ||
      normalizedCandidate.startsWith(projectRoot + path.sep) ||
      normalizedCandidate === mountRoot ||
      normalizedCandidate.startsWith(mountRoot + path.sep)
    );
  } catch (error) {
    return false;
  }
}

function uniqueResolvedPaths(paths = []) {
  const seen = new Set();
  return paths.filter((candidate) => {
    if (!candidate || typeof candidate !== 'string') {
      return false;
    }
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function resolveWritableContentRoot(preferredPath) {
  const preferred = path.resolve(preferredPath || DEFAULT_DATA_ROOT);
  const fallbackDefault = path.resolve(DEFAULT_DATA_ROOT);
  const fallbackTmp = path.resolve(path.join(ROOT, '.tmp', 'data'));

  const candidates = uniqueResolvedPaths([preferred, fallbackDefault, fallbackTmp]);
  for (const candidate of candidates) {
    if (isWritableDirectory(candidate)) {
      if (candidate !== preferred) {
        try {
          process.stderr.write(`[Settings] Content root fallback: ${preferred} -> ${candidate}\n`);
        } catch (e) {
          // ignore
        }
      }
      return candidate;
    }
  }

  try {
    process.stderr.write(`[Settings] Unable to find writable content root, keeping: ${preferred}\n`);
  } catch (e) {
    // ignore
  }
  return preferred;
}

function applyContentRootPolicy() {
  const envContentRoot =
    typeof process.env.CONTENT_ROOT === 'string' ? process.env.CONTENT_ROOT.trim() : '';
  if (envContentRoot) {
    settings.contentRoot = envContentRoot;
  }

  const resolvedRoot = resolveWritableContentRoot(settings.contentRoot || DEFAULT_DATA_ROOT);
  settings.contentRoot = resolvedRoot;
  currentContentRoot = resolvedRoot;
  setDevicesPath(path.join(resolvedRoot, 'content'));
}

applyContentRootPolicy();

function readLdapAuthSettingsFromEnv() {
  const raw = {
    enabled: process.env.LDAP_ENABLED,
    url: process.env.LDAP_URL || process.env.LDAP_URI || '',
    bindDN: process.env.LDAP_BIND_DN || '',
    bindPassword: process.env.LDAP_BIND_PASSWORD || '',
    baseDN: process.env.LDAP_BASE_DN || '',
    userFilter: process.env.LDAP_USER_FILTER || LDAP_DEFAULTS.userFilter,
    usernameAttribute: process.env.LDAP_USERNAME_ATTRIBUTE || LDAP_DEFAULTS.usernameAttribute,
    searchScope: process.env.LDAP_SEARCH_SCOPE || LDAP_DEFAULTS.searchScope,
    autoCreateUsers: process.env.LDAP_AUTO_CREATE_USERS,
    defaultRole: process.env.LDAP_DEFAULT_ROLE || LDAP_DEFAULTS.defaultRole,
    connectTimeoutMs: process.env.LDAP_CONNECT_TIMEOUT_MS,
    operationTimeoutMs: process.env.LDAP_OPERATION_TIMEOUT_MS,
    tlsRejectUnauthorized: process.env.LDAP_TLS_REJECT_UNAUTHORIZED,
    groupRoleMap: {
      admin: process.env.LDAP_GROUPS_ADMIN || process.env.LDAP_GROUP_ADMIN || '',
      speaker: process.env.LDAP_GROUPS_SPEAKER || process.env.LDAP_GROUP_SPEAKER || '',
      hero_admin: process.env.LDAP_GROUPS_HERO_ADMIN || process.env.LDAP_GROUP_HERO_ADMIN || ''
    },
    rolePriority: process.env.LDAP_ROLE_PRIORITY || LDAP_DEFAULTS.rolePriority.join(',')
  };

  return normalizeLdapAuthSettings(raw, LDAP_DEFAULTS);
}

function safeWriteSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    const { ldapAuth, ...persistableSettings } = settings;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(persistableSettings, null, 2), 'utf-8');
  } catch (error) {
    // КРИТИЧНО: Используем lazy import logger, чтобы избежать циклической зависимости
    import('../utils/logger.js').then(({ default: logger }) => {
      logger.error('[Settings] Failed to persist settings', { error: error.message, stack: error.stack });
    }).catch(() => {
      // Игнорируем ошибки логирования
    });
  }
}

function ensureDirectory(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    // Не прерываем выполнение при ошибках доступа в средах CI/runner
    // Логируем в STDERR, чтобы проблема была видна, но не ломала тесты
    try {
      process.stderr.write(`[Settings] Could not create directory ${dirPath}: ${error.message}\n`);
    } catch (e) {
      // ignore
    }
    return;
  }
}

function loadSettingsFromFile() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      // Создаем файл с настройками по умолчанию
      safeWriteSettings();
      return;
    }

    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    if (raw?.trim()) {
      const parsed = JSON.parse(raw);
      settings = {
        ...settings,
        ...parsed
      };
      delete settings.ldapAuth;
      applyContentRootPolicy();
    }
  } catch (error) {
    // КРИТИЧНО: Не используем logger здесь из-за циклической зависимости
    // Используем process.stderr для критических ошибок при загрузке модуля
    process.stderr.write(`[Settings] Failed to read settings file: ${error.message}\n`);
  }
}

export async function initializeSettings() {
  // КРИТИЧНО: loadSettingsFromFile() уже вызван при загрузке модуля
  // Но вызываем еще раз для обновления настроек при инициализации
  loadSettingsFromFile();
  const currentPath = settings.contentRoot || DEFAULT_DATA_ROOT;
  const normalizedPath = path.resolve(currentPath);
  
  // КРИТИЧНО: contentRoot - это корневая директория данных (например: /mnt/videocontrol-data/)
  // getDataRoot() возвращает contentRoot
  // getDevicesPath() возвращает contentRoot/content (создается автоматически)
  setDevicesPath(getDevicesPath());
  
  // КРИТИЧНО: Создаем все необходимые директории
  ensureDirectory(normalizedPath); // dataRoot (contentRoot из настроек)
  ensureDirectory(getDevicesPath()); // dataRoot/content (DEVICES)
  ensureDirectory(getStreamsOutputDir()); // dataRoot/streams
  ensureDirectory(getConvertedCache()); // dataRoot/converted
  ensureDirectory(getLogsDir()); // dataRoot/logs
  ensureDirectory(getTempDir()); // dataRoot/temp
  
  // КРИТИЧНО: Используем lazy import logger, чтобы избежать циклической зависимости
  const { default: logger } = await import('../utils/logger.js');
  
  // КРИТИЧНО: Проверяем и мигрируем пути в БД при старте, если нужно
  // Проверяем, отличается ли путь от значения по умолчанию
  const defaultDataRoot = DEFAULT_DATA_ROOT.replace(/\/+$/, '');
  const normalizedDefault = path.resolve(defaultDataRoot);
  if (normalizedPath !== normalizedDefault) {
    try {
      const { getAllFilePaths, migrateFilePaths } = await import('../database/files-metadata.js');
      const allPaths = getAllFilePaths();
      
      if (allPaths.length > 0) {
        // Проверяем первый путь чтобы понять, нужна ли миграция
        const firstPath = allPaths[0];
        const pathNormalized = normalizedPath.replace(/\/+$/, '');
        const firstPathRoot = firstPath.split('/').slice(0, -1).join('/'); // Путь без имени файла
        
        // Если пути начинаются с другого корня - мигрируем
        if (!firstPath.startsWith(pathNormalized)) {
          // Пробуем определить старый корень из первого пути
          // Например: /vid/videocontrol/public/content/video.mp4 -> /vid/videocontrol/public/content
          const oldRoot = firstPathRoot || DEFAULT_DATA_ROOT.replace(/\/+$/, '');
          
          logger.info(`[Settings] 🔄 Detected path mismatch, migrating: ${oldRoot} -> ${pathNormalized}`);
          const updated = migrateFilePaths(oldRoot, pathNormalized);
          if (updated > 0) {
            logger.info(`[Settings] ✅ Migrated ${updated} file paths on startup`);
          }
        }
      }
    } catch (error) {
      logger.warn('[Settings] Failed to check/migrate paths on startup', {
        error: error.message,
        stack: error.stack
      });
      // Не прерываем инициализацию при ошибке миграции
    }
  }
  
  currentContentRoot = normalizedPath;
  logger.info(`[Settings] 📁 Data root (contentRoot): ${normalizedPath}`);
  logger.info(`[Settings] 📁 Devices (content): ${getDevicesPath()}`);
  logger.info(`[Settings] 📁 Streams: ${getStreamsOutputDir()}`);
  logger.info(`[Settings] 📁 Converted: ${getConvertedCache()}`);
  logger.info(`[Settings] 📁 Logs: ${getLogsDir()}`);
  logger.info(`[Settings] 📁 Temp: ${getTempDir()}`);
}

/**
 * Получить корневой путь данных (contentRoot из настроек)
 * contentRoot - это корневая директория для всех данных (например: /mnt/videocontrol-data/)
 * Это единая точка входа для всех путей данных
 */
export function getDataRoot() {
  // Используем текущий contentRoot из настроек или значение по умолчанию
  const contentRoot = settings.contentRoot || currentContentRoot || DEFAULT_DATA_ROOT;
  return path.resolve(contentRoot);
}

/**
 * Получить путь к директории стримов (HLS)
 */
export function getStreamsOutputDir() {
  return path.join(getDataRoot(), 'streams');
}

/**
 * Получить путь к кэшу конвертированных файлов (PDF/PPTX)
 */
export function getConvertedCache() {
  return path.join(getDataRoot(), 'converted');
}

/**
 * Получить путь к директории логов
 */
export function getLogsDir() {
  return path.join(getDataRoot(), 'logs');
}

/**
 * Получить путь к директории временных файлов
 */
export function getTempDir() {
  return path.join(getDataRoot(), 'temp');
}

/**
 * Получить путь к контенту устройств (DEVICES)
 * contentRoot - это корневая директория данных (например: /mnt/videocontrol-data/)
 * getDevicesPath() возвращает contentRoot/content (например: /mnt/videocontrol-data/content)
 */
export function getDevicesPath() {
  return path.join(getDataRoot(), 'content');
}

export function getSettings() {
  const { ldapAuth, ...restSettings } = settings;

  return {
    ...restSettings,
    ldapAuth: getLdapAuthSettings(),
    defaults: {
      contentRoot: DEFAULT_DATA_ROOT
    },
    runtime: {
      contentRoot: getDataRoot(), // Корневая директория данных из настроек
      devices: getDevicesPath(), // Путь к контенту устройств (contentRoot/content)
      dataRoot: getDataRoot(),
      streamsOutputDir: getStreamsOutputDir(),
      convertedCache: getConvertedCache(),
      logsDir: getLogsDir(),
      tempDir: getTempDir()
    }
  };
}

export function getLdapAuthSettings(options = {}) {
  const includeSecrets = options?.includeSecrets === true;
  const normalized = readLdapAuthSettingsFromEnv();

  if (includeSecrets) {
    return { ...normalized };
  }

  const { bindPassword, ...safeSettings } = normalized;
  return {
    ...safeSettings,
    bindPasswordSet: Boolean(bindPassword)
  };
}

export function updateLdapAuthSettings() {
  throw new Error('LDAP настраивается через .env и перезапуск сервиса');
}

export async function updateContentRootPath(newPath) {
  if (!newPath || typeof newPath !== 'string') {
    throw new Error('Путь не указан');
  }

  const trimmed = newPath.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error('Укажите абсолютный путь (начинается с /)');
  }

  const normalized = path.resolve(trimmed);
  let canonicalRoot;
  const realRoot = fs.realpathSync(normalizedRoot);
  const normalizedNewRoot = fs.realpathSync(normalized);
  if (normalizedNewRoot !== realRoot && !normalizedNewRoot.startsWith(realRoot + path.sep)) {
  try {
    rootStat = fs.statSync(normalized);
    canonicalRoot = fs.realpathSync(normalized);
  } catch (error) {
    throw new Error('Указанный путь не существует или недоступен');
  }

  if (!rootStat.isDirectory()) {
    throw new Error('Укажите путь к существующей директории');
  }

  const normalizedRoot = path.resolve(ROOT);
  if (canonicalRoot !== normalizedRoot && !canonicalRoot.startsWith(normalizedRoot + path.sep)) {
    throw new Error('Путь должен находиться внутри разрешенной директории приложения');
  }
  
  // КРИТИЧНО: Сохраняем старый путь для миграции
  const oldRoot = currentContentRoot || DEFAULT_DATA_ROOT;
  const normalizedOldRoot = oldRoot.replace(/\/+$/, '');
  const normalizedNewRoot = normalized.replace(/\/+$/, '');

  // Обновляем настройки
  settings.contentRoot = normalized;
  safeWriteSettings();
  setDevicesPath(getDevicesPath()); // contentRoot/content
  
  // КРИТИЧНО: Создаем все необходимые поддиректории
  ensureDirectory(normalized); // dataRoot (contentRoot из настроек)
  ensureDirectory(getDevicesPath()); // dataRoot/content (DEVICES)
  ensureDirectory(getStreamsOutputDir()); // dataRoot/streams
  ensureDirectory(getConvertedCache()); // dataRoot/converted
  ensureDirectory(getLogsDir()); // dataRoot/logs
  ensureDirectory(getTempDir()); // dataRoot/temp
  
  // КРИТИЧНО: Используем lazy import logger, чтобы избежать циклической зависимости
  const { default: logger } = await import('../utils/logger.js');
  
  logger.info(`[Settings] 📁 Created all data directories:`, {
    dataRoot: normalized,
    devices: getDevicesPath(),
    streams: getStreamsOutputDir(),
    converted: getConvertedCache(),
    logs: getLogsDir(),
    temp: getTempDir()
  });
  
  // КРИТИЧНО: Мигрируем пути в базе данных если путь изменился
  if (normalizedOldRoot !== normalizedNewRoot) {
    try {
      const { migrateFilePaths } = await import('../database/files-metadata.js');
      const updated = migrateFilePaths(normalizedOldRoot, normalizedNewRoot);
      
      if (updated > 0) {
        logger.info(`[Settings] ✅ Migrated ${updated} file paths in database`, {
          oldRoot: normalizedOldRoot,
          newRoot: normalizedNewRoot,
          updated
        });
      } else {
        logger.info(`[Settings] 🔄 Content root updated (no paths to migrate)`, {
          oldRoot: normalizedOldRoot,
          newRoot: normalizedNewRoot
        });
      }
    } catch (error) {
      logger.error('[Settings] Failed to migrate file paths', {
  currentContentRoot = normalizedNewRoot;
        stack: error.stack,
        oldRoot: normalizedOldRoot,
    dataRoot: normalizedNewRoot,
      });
      // НЕ прерываем выполнение - путь всё равно обновлен в настройках
    }
  } else {
    logger.info(`[Settings] 🔄 Content root updated (same path, no migration needed)`, {
      path: normalizedNewRoot
  return normalizedNewRoot;
  }

  currentContentRoot = canonicalRoot;
  
  logger.info(`[Settings] 📁 Updated paths:`, {
    dataRoot: canonicalRoot,
    streams: getStreamsOutputDir(),
    converted: getConvertedCache(),
    logs: getLogsDir(),
    temp: getTempDir()
  });
  
  return canonicalRoot;
}

// Инициализация при загрузке модуля (синхронная часть)
loadSettingsFromFile();
const initialPath = settings.contentRoot || DEFAULT_DATA_ROOT;
const normalizedInitialPath = path.resolve(initialPath);
ensureDirectory(normalizedInitialPath);
// Создаем поддиректории синхронно при загрузке модуля
try {
  ensureDirectory(path.join(normalizedInitialPath, 'content')); // DEVICES
  ensureDirectory(path.join(normalizedInitialPath, 'streams'));
  ensureDirectory(path.join(normalizedInitialPath, 'converted'));
  ensureDirectory(path.join(normalizedInitialPath, 'logs'));
  ensureDirectory(path.join(normalizedInitialPath, 'temp'));
} catch (error) {
  // Игнорируем ошибки при создании поддиректорий на этом этапе
  // Они будут созданы в initializeSettings()
}
setDevicesPath(path.join(normalizedInitialPath, 'content'));
currentContentRoot = normalizedInitialPath;

// Асинхронная миграция будет вызвана после инициализации БД

