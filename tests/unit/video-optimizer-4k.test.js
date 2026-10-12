import { needsOptimization, getVideoOptConfig } from '../../src/video/optimizer.js';

function baseParams(overrides = {}) {
  return {
    codec: 'h264',
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 4000000,
    profile: 'High',
    level: 40,
    pixFmt: 'yuv420p',
    ...overrides
  };
}

describe('needsOptimization: 4K seek-риск', () => {
  test('4K H.264 High@5.1 помечается как требующий оптимизации', () => {
    expect(needsOptimization(baseParams({
      width: 3840,
      height: 2160,
      fps: 25,
      bitrate: 12000000,
      level: 51
    }))).toBe(true);
  });

  test('1080p H.264 не требует оптимизации', () => {
    expect(needsOptimization(baseParams())).toBe(false);
  });

  test('1440p не помечается 4K-правилом (во избежание апскейла)', () => {
    expect(needsOptimization(baseParams({ width: 2560, height: 1440 }))).toBe(false);
  });

  test('4K без флага reencode4k не помечается', () => {
    const config = getVideoOptConfig();
    const previous = config.thresholds.reencode4k;
    config.thresholds.reencode4k = false;
    try {
      expect(needsOptimization(baseParams({ width: 3840, height: 2160 }))).toBe(false);
    } finally {
      config.thresholds.reencode4k = previous;
    }
  });

  test('не-h264 по-прежнему требует оптимизации', () => {
    expect(needsOptimization(baseParams({ codec: 'hevc' }))).toBe(true);
  });
});
