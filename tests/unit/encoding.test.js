import { fixEncoding } from '../../src/utils/encoding.js';

describe('fixEncoding', () => {
  it('returns the input unchanged for falsy values', () => {
    expect(fixEncoding(null)).toBeNull();
    expect(fixEncoding(undefined)).toBeUndefined();
    expect(fixEncoding('')).toBe('');
  });

  it('returns the input unchanged for non-string types', () => {
    expect(fixEncoding(123)).toBe(123);
  });

  it('returns the input unchanged if already contains Cyrillic', () => {
    const cyrillic = 'Привет мир';
    expect(fixEncoding(cyrillic)).toBe(cyrillic);
  });

  it('decodes latin1→utf-8 mojibake', () => {
    const mojibake = Buffer.from('Привет', 'utf-8').toString('latin1');
    const result = fixEncoding(mojibake);
    expect(result).toBe('Привет');
  });

  it('decodes URL-encoded strings containing Cyrillic', () => {
    const encoded = encodeURIComponent('тест');
    const result = fixEncoding(encoded);
    expect(result).toBe('тест');
  });

  it('returns the input unchanged if it cannot be decoded', () => {
    const ascii = 'hello world 123';
    expect(fixEncoding(ascii)).toBe(ascii);
  });
});
