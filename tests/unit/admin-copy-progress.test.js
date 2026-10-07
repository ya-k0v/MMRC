/**
 * @jest-environment jsdom
 */
import { jest } from '@jest/globals';

const mockShowToastNotification = jest.fn();

jest.unstable_mockModule('../../public/js/admin/notifications.js', () => ({
  initNotifications: jest.fn(),
  showToastNotification: (...args) => mockShowToastNotification(...args)
}));

const {
  createCopyOpId,
  showCopyProgress,
  updateCopyProgress,
  finishCopyProgress
} = await import('../../public/js/admin/copy-progress.js');

const BASE = {
  from: 'devA',
  to: 'devB',
  fromName: 'Источник',
  toName: 'Приёмник',
  folder: 'Презентация',
  action: 'move'
};

function card(opId) {
  return document.querySelector(`.copy-progress-toast[data-op-id="${opId}"]`);
}

beforeEach(() => {
  jest.clearAllMocks();
  document.body.innerHTML = '';
});

describe('карточка прогресса переноса', () => {
  test('opId уникален', () => {
    expect(createCopyOpId()).not.toBe(createCopyOpId());
  });

  test('карточка создаётся сразу, без ожидания событий сокета', () => {
    const opId = createCopyOpId();
    showCopyProgress({ ...BASE, opId });

    const el = card(opId);
    expect(el).not.toBeNull();
    expect(el.textContent).toContain('Перенос папки');
    expect(el.textContent).toContain('Презентация · Источник → Приёмник');
  });

  test('прогресс отображается в процентах и с подписью фазы', () => {
    const opId = createCopyOpId();
    showCopyProgress({ ...BASE, opId, phase: 'prepare', done: 0, total: 0 });
    updateCopyProgress({ ...BASE, opId, phase: 'storage', done: 50, total: 200 });

    const el = card(opId);
    expect(el.dataset.percent).toBe('25');
    expect(el.querySelector('.copy-progress-toast__bar > span').style.width).toBe('25%');
    expect(el.querySelector('.copy-progress-toast__meta').textContent)
      .toBe('50 из 200 · загрузка в хранилище');
  });

  test('два завершения (сокет + HTTP-ответ) дают один тост', async () => {
    const opId = createCopyOpId();
    showCopyProgress({ ...BASE, opId });
    updateCopyProgress({ ...BASE, opId, phase: 'disk', done: 10, total: 10 });

    expect(finishCopyProgress({ ...BASE, opId, ok: true })).toBe(true);
    expect(finishCopyProgress({ ...BASE, opId, ok: true })).toBe(false);

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(card(opId)).toBeNull();
    expect(mockShowToastNotification).toHaveBeenCalledTimes(1);
    expect(mockShowToastNotification.mock.calls[0][0]).toMatchObject({
      title: 'Перенос папки',
      severity: 'info'
    });
  });

  test('ошибка переноса показывается тостом и убирает карточку', async () => {
    const opId = createCopyOpId();
    showCopyProgress({ ...BASE, opId });

    finishCopyProgress({ ...BASE, opId, ok: false, error: 'Хранилище недоступно' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(card(opId)).toBeNull();
    expect(mockShowToastNotification).toHaveBeenCalledTimes(1);
    expect(mockShowToastNotification.mock.calls[0][0]).toMatchObject({
      title: 'Ошибка переноса',
      message: 'Хранилище недоступно',
      severity: 'critical'
    });
  });

  test('после завершения запоздавший прогресс игнорируется', () => {
    const opId = createCopyOpId();
    showCopyProgress({ ...BASE, opId });
    finishCopyProgress({ ...BASE, opId, ok: true });

    showCopyProgress({ ...BASE, opId, done: 1, total: 10 });

    expect(card(opId)).toBeNull();
  });
});
