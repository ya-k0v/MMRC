/**
 * SSRF-фильтр для апстрим-URL (hls-proxy).
 *
 * GET /:id/streams/:safeName/hls-proxy брал ?url= и отдавал его в fetch
 * после единственной проверки new URL(). Этого достаточно, чтобы прочитать
 * cloud metadata (169.254.169.254), loopback и любую внутреннюю сеть.
 *
 * Здесь проверяется только фильтр: схема, имён хостов и адресов. Сам fetch
 * и редиректы покрываются интеграционным сценарием, сетевых вызовов в
 * тестах нет.
 */
import { isBlockedAddress, assertPublicHttpUrl } from '../../src/utils/ssrf.js';

describe('ssrf.isBlockedAddress', () => {
  const blocked = [
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::8.8.8.8'
  ];

  const allowed = [
    '1.1.1.1',
    '8.8.8.8',
    '172.32.0.1',
    '93.184.216.34',
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8'
  ];

  test.each(blocked)('блокирует %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  test.each(allowed)('пропускает %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  test('блокирует IPv4-mapped адрес с внешним IPv4 в loopback-маске не затирает проверку', () => {
    expect(isBlockedAddress('[::ffff:169.254.169.254]')).toBe(true);
  });
});

describe('ssrf.assertPublicHttpUrl', () => {
  const rejected = [
    ['file:///etc/passwd', 'неподдерживаемая схема'],
    ['ftp://1.1.1.1/', 'неподдерживаемая схема'],
    ['http://localhost/', 'заблокированное имя хоста'],
    ['http://metadata.google.internal/', 'заблокированное имя хоста'],
    ['http://foo.localhost/', 'заблокированное имя хоста'],
    ['http://127.0.0.1/', 'loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://10.0.0.1:8080/', 'приватная сеть'],
    ['http://[::1]/', 'loopback IPv6'],
    ['http://[fd00::1]/', 'unique-local'],
    ['not a url', 'неразборчивый URL']
  ];

  test.each(rejected)('отклоняет %s (%s)', async (url) => {
    await expect(assertPublicHttpUrl(url)).rejects.toThrow();
  });

  test('пропускает публичный IPv4-литерал', async () => {
    const url = await assertPublicHttpUrl('http://1.1.1.1/path');
    expect(url.hostname).toBe('1.1.1.1');
  });

  test('пропускает публичный IPv6-литерал', async () => {
    const url = await assertPublicHttpUrl('http://[2606:4700:4700::1111]/');
    expect(url.hostname).toBe('[2606:4700:4700::1111]');
  });
});
