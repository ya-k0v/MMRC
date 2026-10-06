import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_REDIRECTS = 3;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal'
]);

const blockedAddresses = new net.BlockList();

// IPv4: loopback, приватные, CGNAT, link-local (включая metadata-сервис
// 169.254.169.254), TEST-NET, benchmarking, multicast и зарезервированные.
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]) {
  blockedAddresses.addSubnet(address, prefix, 'ipv4');
}

// IPv6: unspecified, loopback, unique-local, link-local, multicast,
// NAT64, документация и 6to4 (встраивает IPv4 и обходил бы проверку выше).
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
  ['2001:db8::', 32],
  ['2002::', 16]
]) {
  blockedAddresses.addSubnet(address, prefix, 'ipv6');
}

function stripBrackets(hostname) {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

export function isBlockedAddress(address) {
  const normalized = stripBrackets(String(address));
  const family = net.isIP(normalized);
  if (family === 4) return blockedAddresses.check(normalized, 'ipv4');
  if (family === 6) return blockedAddresses.check(normalized, 'ipv6');
  return true;
}

/**
 * Проверяет URL и все адреса, на которые он разрешается.
 * Бросает Error с человекочитаемой причиной — вызывающий код отвечает за HTTP-статус.
 */
export async function assertPublicHttpUrl(rawUrl) {
  let target;
  try {
    target = new URL(String(rawUrl));
  } catch {
    throw new Error('Invalid upstream URL');
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('Upstream URL scheme must be http or https');
  }

  const hostname = stripBrackets(target.hostname).replace(/\.$/, '').toLowerCase();
  if (!hostname) {
    throw new Error('Upstream URL has no host');
  }

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new Error('Upstream host is not allowed');
  }

  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new Error('Upstream host resolves to a blocked address');
    }
    return target;
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Upstream host could not be resolved');
  }

  if (!addresses || addresses.length === 0) {
    throw new Error('Upstream host could not be resolved');
  }

  for (const entry of addresses) {
    if (isBlockedAddress(entry.address)) {
      throw new Error('Upstream host resolves to a blocked address');
    }
  }

  return target;
}

/**
 * GET на внешний адрес с проверкой каждого hop'а редиректа.
 * Redirect: manual, чтобы апстрим не мог увести запрос во внутреннюю сеть.
 */
export async function fetchPublicUrl(rawUrl, options = {}) {
  const { headers, signal, ...rest } = options;

  let current = String(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = await assertPublicHttpUrl(current);
    const response = await fetch(target.toString(), {
      headers,
      signal,
      redirect: 'manual',
      ...rest
    });

    if (!REDIRECT_CODES.has(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      return response;
    }

    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // Тело редиректа не нужно, отбрасываем молча.
      }
    }

    try {
      current = new URL(location, target).toString();
    } catch {
      throw new Error('Upstream sent a redirect to an invalid URL');
    }

    if (hop === MAX_REDIRECTS) {
      throw new Error('Upstream exceeded the redirect limit');
    }
  }

  throw new Error('Upstream exceeded the redirect limit');
}
