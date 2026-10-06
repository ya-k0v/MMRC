/**
 * Регрессия: файл показывал «Обработка... 100%» ещё до начала конвертации.
 *
 * Причина — `progress ?? 100` в рендере списка: у файла в состоянии
 * processing прогресса ещё нет, и подпись утверждала, что всё готово.
 * Теперь неизвестный прогресс даёт неопределённое состояние без процентов,
 * а известный ограничен 99% — 100% на этапе обработки означала бы то же самое.
 */
import { describeProcessing } from '../../public/js/admin/files-manager.js';

describe('describeProcessing', () => {
  test('неизвестный прогресс не превращается в 100%', () => {
    expect(describeProcessing(undefined)).toEqual({ text: 'Обработка...', percent: null });
    expect(describeProcessing(null)).toEqual({ text: 'Обработка...', percent: null });
    expect(describeProcessing(NaN)).toEqual({ text: 'Обработка...', percent: null });
    expect(describeProcessing('50')).toEqual({ text: 'Обработка...', percent: null });
  });

  test('известный прогресс показывается', () => {
    expect(describeProcessing(0)).toEqual({ text: 'Обработка... 0%', percent: 0 });
    expect(describeProcessing(45)).toEqual({ text: 'Обработка... 45%', percent: 45 });
  });

  test('100% во время обработки не показывается', () => {
    expect(describeProcessing(100).percent).toBe(99);
    expect(describeProcessing(100).text).toBe('Обработка... 99%');
    expect(describeProcessing(150).percent).toBe(99);
  });

  test('дробные значения округляются, отрицательные не уходят ниже нуля', () => {
    expect(describeProcessing(33.4).percent).toBe(33);
    expect(describeProcessing(33.6).percent).toBe(34);
    expect(describeProcessing(-5).percent).toBe(0);
  });
});