/**
 * Проверка и применение обновлений из удаленной ветки
 * @module utils/update-manager
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from '../config/constants.js';
import logger from './logger.js';
import { notificationsManager } from './notifications.js';

const execFileAsync = promisify(execFile);

const TRACKED_BRANCH = 'main';
const DEFAULT_COMMAND_TIMEOUT_MS = Math.max(
  5000,
  Number.parseInt(process.env.UPDATE_CHECK_COMMAND_TIMEOUT_MS || '20000', 10) || 20000
);
const DEFAULT_SYNC_TIMEOUT_MS = Math.max(
  30000,
  Number.parseInt(process.env.UPDATE_SYNC_TIMEOUT_MS || '900000', 10) || 900000
);

const UPDATE_NOTIFICATION_KEY = 'update_main_available';
const UPDATE_APPLY_STATUS_KEY = 'update_main_apply_status';
const DEFAULT_STATE_FILE = path.join(ROOT, '.tmp', 'update-checker-state.json');

function nowIso() {
  return new Date().toISOString();
}

function parseCount(rawValue) {
  const parsed = Number.parseInt(String(rawValue || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function sanitizeSha(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (/^[0-9a-f]{7,40}$/.test(normalized)) {
    return normalized;
  }
  return '';
}

function shortSha(value) {
  const normalized = sanitizeSha(value);
  if (!normalized) {
    return 'n/a';
  }
  return normalized.slice(0, 8);
}

function clipText(value, maxLength = 2000) {
  const text = String(value || '');
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function normalizeErrorMessage(error) {
  if (!error) return 'Неизвестная ошибка';
  if (typeof error === 'string') return error;
  return error.message || String(error);
}

class UpdateManager {
  constructor(options = {}) {
    const requestedBranch = String(options.branch || '').trim().toLowerCase();
    if (requestedBranch && requestedBranch !== TRACKED_BRANCH) {
      logger.warn('[UpdateManager] Non-main branch request ignored', {
        requestedBranch,
        enforcedBranch: TRACKED_BRANCH
      });
    }

    this.branch = TRACKED_BRANCH;
    this.repoRoot = path.resolve(String(options.repoRoot || ROOT));
    this.syncScriptPath = path.resolve(String(options.syncScriptPath || path.join(ROOT, 'scripts', 'post-pull-sync.sh')));
    this.stateFile = path.resolve(String(options.stateFile || DEFAULT_STATE_FILE));
    this.commandTimeoutMs = Math.max(5000, Number(options.commandTimeoutMs) || DEFAULT_COMMAND_TIMEOUT_MS);
    this.syncTimeoutMs = Math.max(30000, Number(options.syncTimeoutMs) || DEFAULT_SYNC_TIMEOUT_MS);

    this.state = this.getDefaultState();
    this.loadState();
  }

  getDefaultState() {
    return {
      dismissedRemoteSha: null,
      lastCheckedAt: null,
      lastKnownLocalSha: null,
      lastKnownRemoteSha: null,
      lastKnownBehind: 0,
      lastKnownAhead: 0,
      updating: false,
      lastUpdateStartedAt: null,
      lastUpdateFinishedAt: null,
      lastUpdateError: null,
      lastUpdateRequestedBy: null
    };
  }

  ensureStateDir() {
    const dirPath = path.dirname(this.stateFile);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  loadState() {
    try {
      if (!fs.existsSync(this.stateFile)) {
        return;
      }

      const raw = fs.readFileSync(this.stateFile, 'utf8');
      if (!raw.trim()) {
        return;
      }

      const parsed = JSON.parse(raw);
      this.state = {
        ...this.getDefaultState(),
        ...(parsed && typeof parsed === 'object' ? parsed : {})
      };

      this.state.dismissedRemoteSha = sanitizeSha(this.state.dismissedRemoteSha) || null;
      this.state.lastKnownLocalSha = sanitizeSha(this.state.lastKnownLocalSha) || null;
      this.state.lastKnownRemoteSha = sanitizeSha(this.state.lastKnownRemoteSha) || null;
      this.state.lastKnownBehind = parseCount(this.state.lastKnownBehind);
      this.state.lastKnownAhead = parseCount(this.state.lastKnownAhead);
      this.state.updating = Boolean(this.state.updating);
    } catch (error) {
      logger.warn('[UpdateManager] Failed to load state file', {
        stateFile: this.stateFile,
        error: normalizeErrorMessage(error)
      });
    }
  }

  saveState() {
    try {
      this.ensureStateDir();
      fs.writeFileSync(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    } catch (error) {
      logger.warn('[UpdateManager] Failed to save state file', {
        stateFile: this.stateFile,
        error: normalizeErrorMessage(error)
      });
    }
  }

  async runGit(args = [], options = {}) {
    const timeoutMs = Math.max(5000, Number(options.timeoutMs) || this.commandTimeoutMs);

    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd: this.repoRoot,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024
      });

      return {
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim()
      };
    } catch (error) {
      const stderr = String(error?.stderr || '').trim();
      const stdout = String(error?.stdout || '').trim();
      const message = stderr || stdout || normalizeErrorMessage(error);
      const wrapped = new Error(message);
      wrapped.code = error?.code;
      wrapped.originalError = error;
      throw wrapped;
    }
  }

  async getStatus({ fetchRemote = true } = {}) {
    const checkedAt = nowIso();

    const insideRepo = await this.runGit(['rev-parse', '--is-inside-work-tree']);
    if (insideRepo.stdout !== 'true') {
      throw new Error('Текущая директория не является git-репозиторием');
    }

    const currentBranchResult = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    const localShaResult = await this.runGit(['rev-parse', 'HEAD']);

    const currentBranchRaw = String(currentBranchResult.stdout || '').trim();
    const currentBranch = currentBranchRaw
      .replace(/^refs\/heads\//, '')
      .replace(/^heads\//, '');
    const localSha = sanitizeSha(localShaResult.stdout);

    if (fetchRemote) {
      await this.runGit(['fetch', '--quiet', 'origin', this.branch], {
        timeoutMs: Math.max(this.commandTimeoutMs, 30000)
      });
    }

    const remoteRef = `refs/remotes/origin/${this.branch}`;
    let remoteSha = '';
    try {
      const remoteShaResult = await this.runGit(['rev-parse', remoteRef]);
      remoteSha = sanitizeSha(remoteShaResult.stdout);
    } catch (error) {
      logger.warn('[UpdateManager] Failed to resolve remote branch SHA', {
        branch: this.branch,
        remoteRef,
        error: normalizeErrorMessage(error)
      });
    }

    const statusResult = await this.runGit(['status', '--porcelain']);
    const cleanWorkingTree = statusResult.stdout.length === 0;

    let behindCount = 0;
    let aheadCount = 0;

    if (localSha && remoteSha) {
      const behindResult = await this.runGit(['rev-list', '--count', `${localSha}..${remoteSha}`]);
      const aheadResult = await this.runGit(['rev-list', '--count', `${remoteSha}..${localSha}`]);
      behindCount = parseCount(behindResult.stdout);
      aheadCount = parseCount(aheadResult.stdout);
    }

    const onTrackedBranch = currentBranch === this.branch;
    const canFastForward = onTrackedBranch && behindCount > 0 && aheadCount === 0;
    const updateAvailable = Boolean(canFastForward);
    const dismissed = Boolean(this.state.dismissedRemoteSha && remoteSha && this.state.dismissedRemoteSha === remoteSha);

    const status = {
      checkedAt,
      branch: this.branch,
      currentBranch,
      onTrackedBranch,
      localSha: localSha || null,
      remoteSha: remoteSha || null,
      behindCount,
      aheadCount,
      updateAvailable,
      canFastForward,
      cleanWorkingTree,
      dismissed
    };

    this.state.lastCheckedAt = checkedAt;
    this.state.lastKnownLocalSha = status.localSha;
    this.state.lastKnownRemoteSha = status.remoteSha;
    this.state.lastKnownBehind = behindCount;
    this.state.lastKnownAhead = aheadCount;

    return status;
  }

  buildUpdateNotification(status) {
    const behindLabel = status.behindCount === 1
      ? '1 коммит'
      : `${status.behindCount} коммитов`;

    const localLabel = shortSha(status.localSha);
    const remoteLabel = shortSha(status.remoteSha);

    return {
      type: 'project_update_available',
      severity: 'info',
      title: 'Доступно обновление проекта',
      message: `Ветка ${status.branch} отстает на ${behindLabel}: ${localLabel} -> ${remoteLabel}. Обновить сейчас?`,
      key: UPDATE_NOTIFICATION_KEY,
      source: 'update-manager',
      details: {
        branch: status.branch,
        currentBranch: status.currentBranch,
        localSha: status.localSha,
        remoteSha: status.remoteSha,
        behindCount: status.behindCount,
        aheadCount: status.aheadCount,
        checkedAt: status.checkedAt
      },
      actions: [
        {
          id: 'apply_update',
          label: 'Да, обновить',
          method: 'POST',
          url: '/api/admin/update/apply',
          body: {
            remoteSha: status.remoteSha,
            branch: status.branch
          },
          confirm: 'Применить обновление проекта и перезапустить сервис?',
          variant: 'primary'
        },
        {
          id: 'dismiss_update',
          label: 'Нет, позже',
          method: 'POST',
          url: '/api/admin/update/dismiss',
          body: {
            remoteSha: status.remoteSha,
            branch: status.branch
          },
          variant: 'secondary'
        }
      ]
    };
  }

  async checkAndNotify({ force = false, fetchRemote = true, source = 'scheduler' } = {}) {
    const status = await this.getStatus({ fetchRemote });

    let notified = false;
    let skippedDismissed = false;

    if (status.updateAvailable) {
      if (!force && status.dismissed) {
        skippedDismissed = true;
        notificationsManager.removeByKey(UPDATE_NOTIFICATION_KEY);
      } else {
        notificationsManager.upsert(this.buildUpdateNotification(status));
        notified = true;
      }
    } else {
      notificationsManager.removeByKey(UPDATE_NOTIFICATION_KEY);
      if (status.localSha && status.remoteSha && status.localSha === status.remoteSha) {
        this.state.dismissedRemoteSha = null;
      }
    }

    this.saveState();

    logger.debug('[UpdateManager] Update check finished', {
      source,
      branch: status.branch,
      currentBranch: status.currentBranch,
      updateAvailable: status.updateAvailable,
      dismissed: status.dismissed,
      notified,
      skippedDismissed,
      behindCount: status.behindCount,
      aheadCount: status.aheadCount
    });

    return {
      status,
      notified,
      skippedDismissed
    };
  }

  dismiss(remoteSha = '') {
    const targetSha = sanitizeSha(remoteSha) || sanitizeSha(this.state.lastKnownRemoteSha);
    if (targetSha) {
      this.state.dismissedRemoteSha = targetSha;
    }

    const removedNotification = notificationsManager.removeByKey(UPDATE_NOTIFICATION_KEY);
    this.saveState();

    return {
      dismissedRemoteSha: this.state.dismissedRemoteSha,
      removedNotification
    };
  }

  async runSyncScript() {
    if (!fs.existsSync(this.syncScriptPath)) {
      throw new Error(`Скрипт синхронизации не найден: ${this.syncScriptPath}`);
    }

    const { stdout, stderr } = await execFileAsync('bash', [this.syncScriptPath], {
      cwd: this.repoRoot,
      timeout: this.syncTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        SKIP_SERVICE_RESTART: '1'
      }
    });

    logger.info('[UpdateManager] post-pull-sync completed', {
      stdout: clipText(stdout, 1200),
      stderr: clipText(stderr, 1200)
    });
  }

  async startApplyUpdate({ requestedBy = 'unknown', scheduleRestart = null } = {}) {
    if (this.state.updating) {
      return {
        ok: false,
        status: 'in_progress',
        error: 'Обновление уже выполняется'
      };
    }

    if (!fs.existsSync(this.syncScriptPath)) {
      return {
        ok: false,
        status: 'invalid_config',
        error: `Скрипт синхронизации не найден: ${this.syncScriptPath}`
      };
    }

    this.state.updating = true;
    this.state.lastUpdateStartedAt = nowIso();
    this.state.lastUpdateFinishedAt = null;
    this.state.lastUpdateError = null;
    this.state.lastUpdateRequestedBy = String(requestedBy || 'unknown');
    this.saveState();

    notificationsManager.upsert({
      type: 'project_update_apply',
      severity: 'info',
      title: 'Обновление проекта запущено',
      message: 'Проверяем обновления и применяем изменения из удаленного репозитория.',
      key: UPDATE_APPLY_STATUS_KEY,
      source: 'update-manager',
      details: {
        requestedBy: this.state.lastUpdateRequestedBy,
        startedAt: this.state.lastUpdateStartedAt
      }
    });

    (async () => {
      try {
        const checkResult = await this.checkAndNotify({
          force: true,
          fetchRemote: true,
          source: 'apply'
        });
        const status = checkResult.status;

        if (status.currentBranch !== this.branch) {
          throw new Error(`Обновление разрешено только из ветки ${this.branch}. Текущая ветка: ${status.currentBranch}`);
        }

        if (!status.cleanWorkingTree) {
          throw new Error('Рабочее дерево git не чистое. Завершите или закоммитьте локальные изменения.');
        }

        if (!status.remoteSha) {
          throw new Error(`Не удалось получить commit удаленной ветки origin/${this.branch}`);
        }

        if (!status.updateAvailable) {
          if (status.localSha === status.remoteSha) {
            throw new Error('Проект уже обновлен до актуальной версии.');
          }

          if (status.aheadCount > 0 && status.behindCount > 0) {
            throw new Error('Локальная ветка расходится с origin/main. Требуется ручное вмешательство.');
          }

          if (status.aheadCount > 0) {
            throw new Error('Локальная ветка содержит коммиты, которых нет в origin/main. Fast-forward невозможен.');
          }

          throw new Error('Нет доступных обновлений для fast-forward.');
        }

        await this.runGit(['merge', '--ff-only', `origin/${this.branch}`], {
          timeoutMs: this.syncTimeoutMs
        });

        await this.runSyncScript();

        this.state.dismissedRemoteSha = null;
        this.state.lastUpdateError = null;
        this.state.lastUpdateFinishedAt = nowIso();

        let restartScheduled = false;
        if (typeof scheduleRestart === 'function') {
          try {
            restartScheduled = Boolean(await scheduleRestart());
          } catch (restartError) {
            logger.warn('[UpdateManager] Failed to schedule restart after apply', {
              error: normalizeErrorMessage(restartError)
            });
          }
        }

        notificationsManager.upsert({
          type: 'project_update_apply',
          severity: 'info',
          title: 'Обновление проекта применено',
          message: restartScheduled
            ? 'Обновление выполнено успешно. Перезапуск сервиса запланирован.'
            : 'Обновление выполнено успешно. Перезапустите сервис вручную.',
          key: UPDATE_APPLY_STATUS_KEY,
          source: 'update-manager',
          details: {
            requestedBy: this.state.lastUpdateRequestedBy,
            finishedAt: this.state.lastUpdateFinishedAt,
            restartScheduled
          }
        });

        await this.checkAndNotify({
          force: true,
          fetchRemote: false,
          source: 'apply_success'
        });
      } catch (error) {
        const errorMessage = normalizeErrorMessage(error);
        this.state.lastUpdateError = errorMessage;
        this.state.lastUpdateFinishedAt = nowIso();

        logger.error('[UpdateManager] Failed to apply update', {
          requestedBy: this.state.lastUpdateRequestedBy,
          error: errorMessage,
          stack: error?.stack
        });

        notificationsManager.upsert({
          type: 'project_update_apply_error',
          severity: 'warning',
          title: 'Не удалось применить обновление',
          message: errorMessage,
          key: UPDATE_APPLY_STATUS_KEY,
          source: 'update-manager',
          details: {
            requestedBy: this.state.lastUpdateRequestedBy,
            finishedAt: this.state.lastUpdateFinishedAt,
            error: errorMessage
          }
        });
      } finally {
        this.state.updating = false;
        this.saveState();
      }
    })().catch((error) => {
      logger.error('[UpdateManager] Unhandled apply task error', {
        error: normalizeErrorMessage(error),
        stack: error?.stack
      });
      this.state.updating = false;
      this.state.lastUpdateError = normalizeErrorMessage(error);
      this.state.lastUpdateFinishedAt = nowIso();
      this.saveState();
    });

    return {
      ok: true,
      status: 'scheduled',
      message: 'Обновление запущено в фоновом режиме'
    };
  }

  getRuntimeState() {
    return {
      branch: this.branch,
      repoRoot: this.repoRoot,
      syncScriptPath: this.syncScriptPath,
      stateFile: this.stateFile,
      ...this.state
    };
  }
}

export function createUpdateManager(options = {}) {
  return new UpdateManager(options);
}

export { UPDATE_NOTIFICATION_KEY, UPDATE_APPLY_STATUS_KEY };
