import { sanitizeDeviceId, isSystemFile } from '../../src/utils/sanitize.js';

describe('sanitizeDeviceId', () => {
  it('returns null for falsy values', () => {
    expect(sanitizeDeviceId(null)).toBeNull();
    expect(sanitizeDeviceId(undefined)).toBeNull();
    expect(sanitizeDeviceId('')).toBeNull();
  });

  it('returns null for non-string values', () => {
    expect(sanitizeDeviceId(123)).toBeNull();
    expect(sanitizeDeviceId({})).toBeNull();
  });

  it('returns the id if it contains only valid characters', () => {
    expect(sanitizeDeviceId('device-123_ABC')).toBe('device-123_ABC');
    expect(sanitizeDeviceId('a')).toBe('a');
  });

  it('returns null if the id contains invalid characters', () => {
    expect(sanitizeDeviceId('device/123')).toBeNull();
    expect(sanitizeDeviceId('../etc')).toBeNull();
    expect(sanitizeDeviceId('device 123')).toBeNull();
  });
});

describe('isSystemFile', () => {
  it('returns true for default.* files', () => {
    expect(isSystemFile('default.mp4')).toBe(true);
    expect(isSystemFile('default.mp3')).toBe(true);
    expect(isSystemFile('default.png')).toBe(true);
    expect(isSystemFile('default.pdf')).toBe(true);
  });

  it('returns true for .optimizing_* files', () => {
    expect(isSystemFile('.optimizing_video_123')).toBe(true);
  });

  it('returns true for .tmp_default_* files', () => {
    expect(isSystemFile('.tmp_default_video')).toBe(true);
  });

  it('returns true for .original_* files', () => {
    expect(isSystemFile('.original_video')).toBe(true);
  });

  it('returns true for any dotfile', () => {
    expect(isSystemFile('.hidden')).toBe(true);
    expect(isSystemFile('..hidden')).toBe(true);
  });

  it('returns false for regular files', () => {
    expect(isSystemFile('video.mp4')).toBe(false);
    expect(isSystemFile('document.pdf')).toBe(false);
    expect(isSystemFile('image.png')).toBe(false);
  });

  it('matches case-insensitively for default.*', () => {
    expect(isSystemFile('Default.MP4')).toBe(true);
    expect(isSystemFile('DEFAULT.PNG')).toBe(true);
  });
});
