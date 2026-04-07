import { Client } from 'ldapts';
import logger from '../utils/logger.js';

const SEARCH_SCOPES = new Set(['base', 'one', 'sub']);
const DEFAULT_TIMEOUT_MS = 5000;

function escapeLdapFilter(value = '') {
  return String(value)
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\u0000/g, '\\00');
}

function pickFirst(value) {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  return value ?? null;
}

function toSafeString(value) {
  const picked = pickFirst(value);
  if (picked === null || typeof picked === 'undefined') return '';
  if (Buffer.isBuffer(picked)) return picked.toString('utf8');
  return String(picked);
}

function buildFilter(template, username) {
  const safeUsername = escapeLdapFilter(username);
  const source = template && typeof template === 'string'
    ? template
    : '(sAMAccountName={username})';

  return source
    .replaceAll('{username}', safeUsername)
    .replaceAll('{user}', safeUsername)
    .replaceAll('{login}', safeUsername);
}

function resolveSearchScope(scope) {
  const normalized = String(scope || '').trim().toLowerCase();
  return SEARCH_SCOPES.has(normalized) ? normalized : 'sub';
}

function resolveUsername(entry, usernameAttribute, fallback) {
  const attr = toSafeString(entry[usernameAttribute])
    || toSafeString(entry.sAMAccountName)
    || toSafeString(entry.uid)
    || toSafeString(entry.userPrincipalName)
    || fallback;

  return String(attr || fallback || '').trim();
}

function resolveFullName(entry, fallback) {
  const fullName = toSafeString(entry.displayName)
    || toSafeString(entry.cn)
    || fallback;

  return String(fullName || fallback || '').trim();
}

export async function authenticateAgainstLdap(username, password, ldapConfig = {}) {
  if (!username || !password) {
    return { ok: false, reason: 'invalid_input' };
  }

  if (!ldapConfig.enabled) {
    return { ok: false, reason: 'disabled' };
  }

  const url = String(ldapConfig.url || '').trim();
  const baseDN = String(ldapConfig.baseDN || '').trim();

  if (!url || !baseDN) {
    return { ok: false, reason: 'misconfigured' };
  }

  const usernameAttribute = String(ldapConfig.usernameAttribute || 'sAMAccountName').trim() || 'sAMAccountName';
  const bindDN = String(ldapConfig.bindDN || '').trim();
  const bindPassword = String(ldapConfig.bindPassword || '');
  const userFilter = buildFilter(ldapConfig.userFilter, username);
  const searchScope = resolveSearchScope(ldapConfig.searchScope);
  const connectTimeoutMs = Number.isFinite(Number(ldapConfig.connectTimeoutMs))
    ? Number(ldapConfig.connectTimeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const operationTimeoutMs = Number.isFinite(Number(ldapConfig.operationTimeoutMs))
    ? Number(ldapConfig.operationTimeoutMs)
    : DEFAULT_TIMEOUT_MS;

  const client = new Client({
    url,
    connectTimeout: connectTimeoutMs,
    timeout: operationTimeoutMs,
    tlsOptions: {
      rejectUnauthorized: ldapConfig.tlsRejectUnauthorized !== false
    }
  });

  try {
    if (bindDN) {
      await client.bind(bindDN, bindPassword);
    }

    const searchResult = await client.search(baseDN, {
      scope: searchScope,
      filter: userFilter,
      attributes: [
        usernameAttribute,
        'sAMAccountName',
        'uid',
        'cn',
        'displayName',
        'userPrincipalName',
        'mail'
      ],
      sizeLimit: 2
    });

    const entries = Array.isArray(searchResult?.searchEntries)
      ? searchResult.searchEntries
      : [];

    if (!entries.length) {
      return { ok: false, reason: 'user_not_found' };
    }

    const entry = entries[0];
    const userDn = toSafeString(entry?.dn || entry?.distinguishedName);

    if (!userDn) {
      return { ok: false, reason: 'invalid_user_dn' };
    }

    await client.bind(userDn, password);

    return {
      ok: true,
      user: {
        username: resolveUsername(entry, usernameAttribute, username),
        fullName: resolveFullName(entry, username),
        dn: userDn
      }
    };
  } catch (error) {
    const message = String(error?.message || '').toLowerCase();
    const invalidCredentials = message.includes('invalid credentials') || message.includes('data 52e');

    if (invalidCredentials) {
      return { ok: false, reason: 'invalid_password' };
    }

    logger.warn('[LDAP] Authentication failed', {
      username,
      reason: error?.message || 'unknown_error'
    });

    return {
      ok: false,
      reason: 'ldap_error',
      error: error?.message || 'LDAP error'
    };
  } finally {
    try {
      await client.unbind();
    } catch {
      // Ignore unbind errors
    }
  }
}

export async function testLdapConnection(ldapConfig = {}, options = {}) {
  if (!ldapConfig || !ldapConfig.enabled) {
    return { ok: false, reason: 'disabled' };
  }

  const url = String(ldapConfig.url || '').trim();
  const baseDN = String(ldapConfig.baseDN || '').trim();

  if (!url || !baseDN) {
    return { ok: false, reason: 'misconfigured' };
  }

  const bindDN = String(ldapConfig.bindDN || '').trim();
  const bindPassword = String(ldapConfig.bindPassword || '');
  const testFilter = String(ldapConfig.testFilter || '(objectClass=*)').trim();
  const searchScope = resolveSearchScope(ldapConfig.searchScope);
  const connectTimeoutMs = Number.isFinite(Number(ldapConfig.connectTimeoutMs))
    ? Number(ldapConfig.connectTimeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const operationTimeoutMs = Number.isFinite(Number(ldapConfig.operationTimeoutMs))
    ? Number(ldapConfig.operationTimeoutMs)
    : DEFAULT_TIMEOUT_MS;

  const client = new Client({
    url,
    connectTimeout: connectTimeoutMs,
    timeout: operationTimeoutMs,
    tlsOptions: {
      rejectUnauthorized: ldapConfig.tlsRejectUnauthorized !== false
    }
  });

  try {
    if (bindDN) {
      await client.bind(bindDN, bindPassword);
    }

    // Выполняем пробный поиск в baseDN
    const searchResult = await client.search(baseDN, {
      scope: searchScope,
      filter: testFilter,
      attributes: ['dn'],
      sizeLimit: 1
    });

    const entries = Array.isArray(searchResult?.searchEntries)
      ? searchResult.searchEntries
      : [];

    if (!entries.length) {
      return { ok: false, reason: 'no_entries' };
    }

    return { ok: true, reason: 'ok', found: entries.length };
  } catch (error) {
    logger.warn('[LDAP] Test connection failed', { reason: error?.message || 'unknown' });
    return { ok: false, reason: 'ldap_error', error: error?.message || String(error) };
  } finally {
    try {
      await client.unbind();
    } catch {
      // ignore
    }
  }
}
