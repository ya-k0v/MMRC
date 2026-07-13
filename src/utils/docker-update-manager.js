import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, DOCKER_TAG, DOCKER_IMAGES, APP_BRANCH } from '../config/constants.js';
import { createModuleLogger } from './logger.js';
const logger = createModuleLogger('system');
import { notificationsManager } from './notifications.js';

const execFileAsync = promisify(execFile);

const DEFAULT_REPO_OWNER = 'ya-k0v';
const DEFAULT_REPO_NAME = 'MMRC';
const DEFAULT_BRANCH = APP_BRANCH;
const DEFAULT_IMAGE = DOCKER_IMAGES.server || 'pingwin1900/mmrc';
const DEFAULT_COMPOSE_FILE = 'docker-compose.yml';
const DEFAULT_COMMAND_TIMEOUT_MS = Math.max(
  5000,
  Number.parseInt(process.env.UPDATE_CHECK_COMMAND_TIMEOUT_MS || '20000', 10) || 20000
);
const DEFAULT_PULL_TIMEOUT_MS = Math.max(
  30000,
  Number.parseInt(process.env.UPDATE_DOCKER_PULL_TIMEOUT_MS || '180000', 10) || 180000
);
const DEFAULT_SYNC_TIMEOUT_MS = Math.max(
  30000,
  Number.parseInt(process.env.UPDATE_SYNC_TIMEOUT_MS || '120000', 10) || 120000
);

const UPDATE_NOTIFICATION_KEY = 'update_docker_available';
const UPDATE_APPLY_STATUS_KEY = 'update_docker_apply_status';
const DEFAULT_STATE_FILE = path.join(ROOT, '.tmp', 'docker-update-checker-state.json');

function nowIso() {
  return new Date().toISOString();
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
  if (!normalized) return 'n/a';
  return normalized.slice(0, 8);
}

function clipText(value, maxLength = 2000) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function normalizeErrorMessage(error) {
  if (!error) return 'Неизвестная ошибка';
  if (typeof error === 'string') return error;
  return error.message || String(error);
}

class DockerUpdateManager {
  constructor(options = {}) {
    this.branch = String(options.branch || DEFAULT_BRANCH).trim();
    this.repoOwner = String(options.repoOwner || DEFAULT_REPO_OWNER).trim();
    this.repoName = String(options.repoName || DEFAULT_REPO_NAME).trim();
    this.imageName = String(options.image || `${DEFAULT_IMAGE}:${this.branch}`).trim();
    this.composeDir = path.resolve(String(options.composeDir || process.env.MMRC_COMPOSE_DIR || ROOT));
    this.composeFile = path.resolve(String(options.composeFile || path.join(this.composeDir, DEFAULT_COMPOSE_FILE)));
    this.stateFile = path.resolve(String(options.stateFile || DEFAULT_STATE_FILE));
    this.commandTimeoutMs = Math.max(5000, Number(options.commandTimeoutMs) || DEFAULT_COMMAND_TIMEOUT_MS);
    this.pullTimeoutMs = Math.max(30000, Number(options.pullTimeoutMs) || DEFAULT_PULL_TIMEOUT_MS);
    this.syncTimeoutMs = Math.max(30000, Number(options.syncTimeoutMs) || DEFAULT_SYNC_TIMEOUT_MS);
    this.dockerSocketPath = '/var/run/docker.sock';
    this.githubApiUrl = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/branches/${this.branch}`;

    this.state = this.getDefaultState();
    this.loadState();

    this._pendingShaSync = null;
    if (this.state.deployedSha && this.state.lastKnownRemoteSha && this.state.deployedSha !== this.state.lastKnownRemoteSha) {
      this._pendingShaSync = this.state.lastKnownRemoteSha;
    }
  }

  getDefaultState() {
    return {
      deployedSha: null,
      dismissedRemoteSha: null,
      lastCheckedAt: null,
      lastKnownRemoteSha: null,
      updating: false,
      lastUpdateStartedAt: null,
      lastUpdateFinishedAt: null,
      lastUpdateError: null
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
      if (!fs.existsSync(this.stateFile)) return;

      const raw = fs.readFileSync(this.stateFile, 'utf8');
      if (!raw.trim()) return;

      const parsed = JSON.parse(raw);
      this.state = {
        ...this.getDefaultState(),
        ...(parsed && typeof parsed === 'object' ? parsed : {})
      };

      this.state.deployedSha = sanitizeSha(this.state.deployedSha) || null;
      this.state.dismissedRemoteSha = sanitizeSha(this.state.dismissedRemoteSha) || null;
      this.state.lastKnownRemoteSha = sanitizeSha(this.state.lastKnownRemoteSha) || null;
      this.state.updating = Boolean(this.state.updating);

      // Reset stale "updating" flag: if updating was set >30 min ago, the process likely crashed
      if (this.state.updating && this.state.lastUpdateStartedAt) {
        const startedAt = new Date(this.state.lastUpdateStartedAt).getTime();
        const STALE_THRESHOLD_MS = 30 * 60 * 1000;
        if (Date.now() - startedAt > STALE_THRESHOLD_MS) {
          logger.warn('[DockerUpdateManager] Resetting stale updating flag (started >30 min ago)', {
            lastUpdateStartedAt: this.state.lastUpdateStartedAt
          });
          this.state.updating = false;
          this.state.lastUpdateFinishedAt = new Date().toISOString();
          this.state.lastUpdateError = 'Обновление прервано (процесс перезапущен)';
          this.saveState();
        }
      }

      // first init: deployedSha = last known remote (best guess for current image)
      if (!this.state.deployedSha && this.state.lastKnownRemoteSha) {
        this.state.deployedSha = this.state.lastKnownRemoteSha;
      }
    } catch (error) {
      logger.warn('[DockerUpdateManager] Failed to load state file', {
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
      logger.warn('[DockerUpdateManager] Failed to save state file', {
        stateFile: this.stateFile,
        error: normalizeErrorMessage(error)
      });
    }
  }

  hasDockerAccess() {
    try {
      return fs.existsSync(this.dockerSocketPath);
    } catch {
      return false;
    }
  }

  async checkDockerCli() {
    try {
      await execFileAsync('docker', ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async fetchLatestCommitSha() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.commandTimeoutMs);

    try {
      const response = await fetch(this.githubApiUrl, {
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'MMRC-DockerUpdateChecker'
        }
      });

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data.commit?.sha ? sanitizeSha(data.commit.sha) : null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getStatus({ fetchRemote = true } = {}) {
    const checkedAt = nowIso();
    let remoteSha = this.state.lastKnownRemoteSha;

    if (fetchRemote) {
      try {
        const sha = await this.fetchLatestCommitSha();
        if (sha) remoteSha = sha;
      } catch (error) {
        logger.warn('[DockerUpdateManager] Failed to fetch remote SHA', {
          branch: this.branch,
          error: normalizeErrorMessage(error)
        });
      }
    }

    const localSha = this.state.deployedSha;
    let updateAvailable = Boolean(
      localSha && remoteSha && remoteSha !== localSha
    );
    const dismissed = Boolean(
      this.state.dismissedRemoteSha && remoteSha && this.state.dismissedRemoteSha === remoteSha
    );

    if (updateAvailable && this._pendingShaSync && remoteSha === this._pendingShaSync) {
      this.state.deployedSha = remoteSha;
      this._pendingShaSync = null;
      updateAvailable = false;
      this.saveState();
    }

    const status = {
      checkedAt,
      branch: this.branch,
      currentBranch: this.branch,
      onTrackedBranch: true,
      localSha: this.state.deployedSha || null,
      remoteSha: remoteSha || null,
      behindCount: updateAvailable ? 1 : 0,
      aheadCount: 0,
      updateAvailable,
      canFastForward: updateAvailable,
      cleanWorkingTree: true,
      dismissed
    };

    this.state.lastCheckedAt = checkedAt;
    if (remoteSha) {
      this.state.lastKnownRemoteSha = remoteSha;
    }

    return status;
  }

  buildUpdateNotification(status) {
    const behindLabel = status.behindCount === 1
      ? '1 коммит'
      : `${status.behindCount} коммитов`;

    const localLabel = shortSha(status.localSha);
    const remoteLabel = shortSha(status.remoteSha);

    return {
      type: 'docker_update_available',
      severity: 'info',
      title: 'Доступно обновление',
      message: `Новая версия: ${localLabel} -> ${remoteLabel} (${behindLabel}). Для обновления выполните в консоли:\nsudo mmrc update`,
      key: UPDATE_NOTIFICATION_KEY,
      source: 'docker-update-manager',
      details: {
        branch: status.branch,
        image: this.imageName,
        localSha: status.localSha,
        remoteSha: status.remoteSha,
        behindCount: status.behindCount,
        aheadCount: status.aheadCount,
        checkedAt: status.checkedAt
      },
      actions: [
        {
          id: 'dismiss_update',
          label: 'Ок',
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

    logger.debug('[DockerUpdateManager] Update check finished', {
      source,
      branch: status.branch,
      updateAvailable: status.updateAvailable,
      dismissed: status.dismissed,
      notified,
      skippedDismissed,
      behindCount: status.behindCount
    });

    return { status, notified, skippedDismissed };
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

  async startApplyUpdate({ requestedBy = 'unknown', scheduleRestart = null } = {}) {
    if (this.state.updating) {
      return {
        ok: false,
        status: 'in_progress',
        error: 'Обновление уже выполняется'
      };
    }

    if (!(await this.checkDockerCli())) {
      return {
        ok: false,
        status: 'no_docker_cli',
        error: 'Docker CLI не установлен в образе. Соберите образ с INCLUDE_DOCKER_CLI=true или выполните обновление на хосте: mmrc update'
      };
    }

    if (!this.hasDockerAccess()) {
      return {
        ok: false,
        status: 'no_docker_socket',
        error: 'Docker socket недоступен. Выполните обновление вручную: docker compose pull && docker compose up -d'
      };
    }

    this.state.updating = true;
    this.state.lastUpdateStartedAt = nowIso();
    this.state.lastUpdateFinishedAt = null;
    this.state.lastUpdateError = null;
    this.saveState();

    notificationsManager.upsert({
      type: 'docker_update_apply',
      severity: 'info',
      title: 'Обновление Docker образа запущено',
      message: 'Выполняется docker pull и перезапуск сервиса.',
      key: UPDATE_APPLY_STATUS_KEY,
      source: 'docker-update-manager',
      details: {
        requestedBy,
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

        if (!status.remoteSha) {
          throw new Error('Не удалось получить информацию о последнем коммите');
        }

        if (!status.updateAvailable) {
          throw new Error('Образ уже обновлен до актуальной версии');
        }

        notificationsManager.upsert({
          type: 'docker_update_apply',
          severity: 'info',
          title: 'Обновление Docker образа',
          message: 'Загрузка нового образа...',
          key: UPDATE_APPLY_STATUS_KEY,
          source: 'docker-update-manager',
          details: { requestedBy, startedAt: this.state.lastUpdateStartedAt, step: 'pull' }
        });

        logger.info('[DockerUpdateManager] Pulling image', { image: this.imageName });
        await execFileAsync('docker', ['pull', this.imageName], {
          timeout: this.pullTimeoutMs,
          maxBuffer: 4 * 1024 * 1024
        });
        logger.info('[DockerUpdateManager] Image pulled successfully', { image: this.imageName });

        // Remove old container to avoid name conflict
        try {
          await execFileAsync('docker', ['rm', '-f', 'mmrc'], { timeout: 10000 });
          logger.info('[DockerUpdateManager] Old container removed');
        } catch (rmErr) {
          logger.debug('[DockerUpdateManager] No old container to remove', {
            error: normalizeErrorMessage(rmErr)
          });
        }

        const composeArgs = fs.existsSync(this.composeFile)
          ? ['-f', this.composeFile, '-p', 'mmrc', 'up', '-d', '--force-recreate', '--remove-orphans']
          : ['-p', 'mmrc', 'up', '-d', '--force-recreate', '--remove-orphans'];

        notificationsManager.upsert({
          type: 'docker_update_apply',
          severity: 'info',
          title: 'Обновление Docker образа',
          message: 'Образ загружен, перезапуск контейнера...',
          key: UPDATE_APPLY_STATUS_KEY,
          source: 'docker-update-manager',
          details: { requestedBy, startedAt: this.state.lastUpdateStartedAt, step: 'restart' }
        });

        let composeRan = false;

        try {
          await execFileAsync('docker', ['compose', ...composeArgs], {
            cwd: this.composeDir,
            timeout: this.syncTimeoutMs,
            maxBuffer: 4 * 1024 * 1024
          });
          composeRan = true;
        } catch (composePluginError) {
          logger.warn('[DockerUpdateManager] docker compose plugin failed, trying docker-compose', {
            error: normalizeErrorMessage(composePluginError)
          });
        }

        if (!composeRan) {
          await execFileAsync('docker-compose', composeArgs, {
            cwd: this.composeDir,
            timeout: this.syncTimeoutMs,
            maxBuffer: 4 * 1024 * 1024
          });
        }

        this.state.dismissedRemoteSha = null;
        this.state.lastUpdateError = null;
        this.state.lastUpdateFinishedAt = nowIso();
        this.state.deployedSha = this.state.lastKnownRemoteSha;

        notificationsManager.upsert({
          type: 'docker_update_apply',
          severity: 'success',
          title: 'Docker образ обновлен',
          message: 'Обновление выполнено успешно. Контейнер перезапущен с новой версией.',
          key: UPDATE_APPLY_STATUS_KEY,
          source: 'docker-update-manager',
          details: {
            requestedBy,
            finishedAt: this.state.lastUpdateFinishedAt
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

        logger.error('[DockerUpdateManager] Failed to apply update', {
          requestedBy,
          error: errorMessage,
          stack: error?.stack
        });

        notificationsManager.upsert({
          type: 'docker_update_apply_error',
          severity: 'warning',
          title: 'Не удалось применить обновление',
          message: errorMessage,
          key: UPDATE_APPLY_STATUS_KEY,
          source: 'docker-update-manager',
          details: {
            requestedBy,
            finishedAt: this.state.lastUpdateFinishedAt,
            error: errorMessage
          }
        });
      } finally {
        this.state.updating = false;
        this.saveState();
      }
    })().catch((error) => {
      logger.error('[DockerUpdateManager] Unhandled apply task error', {
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
      imageName: this.imageName,
      composeFile: this.composeFile,
      stateFile: this.stateFile,
      hasDockerAccess: this.hasDockerAccess(),
      ...this.state
    };
  }
}

export function createDockerUpdateManager(options = {}) {
  return new DockerUpdateManager(options);
}

export { UPDATE_NOTIFICATION_KEY, UPDATE_APPLY_STATUS_KEY };
