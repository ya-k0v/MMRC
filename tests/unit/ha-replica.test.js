/** Реплики не должны запускать фоновую работу, меняющую общие данные. */
import { isHaReplica } from '../../src/utils/ha.js';

describe('isHaReplica', () => {
  test('MMRC_HA_MODE=true — реплика', () => {
    expect(isHaReplica({ MMRC_HA_MODE: 'true' })).toBe(true);
  });

  test('регистр и пробелы не важны', () => {
    expect(isHaReplica({ MMRC_HA_MODE: ' TRUE ' })).toBe(true);
  });

  test('основной процесс и не заданный режим — не реплика', () => {
    expect(isHaReplica({ MMRC_HA_MODE: 'false' })).toBe(false);
    expect(isHaReplica({})).toBe(false);
    expect(isHaReplica()).toBe(false);
  });
});
