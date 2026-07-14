import logger from '../utils/logger.js';

const VOLUME_MIN = 0;
const VOLUME_MAX = 100;
const VOLUME_STEP = 5;

export function normalizeVolumeLevel(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  const clamped = Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, Math.round(value)));
  const stepped = Math.round(clamped / VOLUME_STEP) * VOLUME_STEP;
  return Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, stepped));
}

export function createVolumeService({ devices, io, saveDeviceVolumeState }) {
  const deviceVolumeState = {};

  function ensureVolumeState(deviceId) {
    if (!deviceVolumeState[deviceId]) {
      const now = new Date().toISOString();
      deviceVolumeState[deviceId] = { level: 50, muted: false, updatedAt: now };
      saveDeviceVolumeState(deviceId, { volumeLevel: 50, isMuted: false }).catch(err => {
        logger.warn('[Volume] Initial state save failed', { deviceId, error: err.message });
      });
    }
    return deviceVolumeState[deviceId];
  }

  function getVolumeState(deviceId) {
    const current = ensureVolumeState(deviceId);
    return { ...current };
  }

  function persistVolumeState(deviceId, nextState = {}, options = {}) {
    const current = ensureVolumeState(deviceId);
    const normalizedLevel =
      typeof nextState.level === 'number'
        ? normalizeVolumeLevel(nextState.level)
        : current.level;
    const normalizedMuted =
      typeof nextState.muted === 'boolean' ? nextState.muted : current.muted;

    if (
      normalizedLevel === current.level &&
      normalizedMuted === current.muted &&
      !options.force
    ) {
      return current;
    }

    const updatedAt = new Date().toISOString();
    deviceVolumeState[deviceId] = {
      level: normalizedLevel,
      muted: normalizedMuted,
      updatedAt
    };

    saveDeviceVolumeState(deviceId, {
      volumeLevel: normalizedLevel,
      isMuted: normalizedMuted
    }).catch(err => {
      logger.warn('[Volume] State persist failed', { deviceId, error: err.message });
    });

    if (options.broadcast !== false) {
      io.emit('devices/volume/state', {
        device_id: deviceId,
        level: normalizedLevel,
        muted: normalizedMuted,
        updated_at: updatedAt,
        source: options.source || 'server'
      });
    }

    return deviceVolumeState[deviceId];
  }

  function emitVolumeCommand(deviceId, state, reason = 'control') {
    io.to(`device:${deviceId}`).emit('player/volume', {
      level: state.level,
      muted: state.muted,
      reason
    });
  }

  function applyVolumeCommand(deviceId, params = {}, meta = {}) {
    if (!devices[deviceId]) {
      throw new Error('device not found');
    }

    const current = ensureVolumeState(deviceId);
    let nextLevel = current.level;

    if (typeof params.level === 'number' && !Number.isNaN(params.level)) {
      const normalized = normalizeVolumeLevel(params.level);
      if (normalized === null) {
        throw new Error('invalid volume level');
      }
      nextLevel = normalized;
    } else if (typeof params.delta === 'number' && !Number.isNaN(params.delta)) {
      const normalized = normalizeVolumeLevel(current.level + params.delta);
      if (normalized !== null) {
        nextLevel = normalized;
      }
    }

    const nextMuted =
      typeof params.muted === 'boolean' ? params.muted : current.muted;

    const updated = persistVolumeState(
      deviceId,
      { level: nextLevel, muted: nextMuted },
      { source: meta.source, broadcast: meta.broadcast }
    );

    if (!meta.skipEmit) {
      emitVolumeCommand(deviceId, updated, meta.reason || meta.source || 'control');
    }

    return updated;
  }

  function getAllVolumeStates() {
    return deviceVolumeState;
  }

  function initDeviceVolume(deviceId) {
    const state = ensureVolumeState(deviceId);
    io.emit('devices/volume/state', {
      device_id: deviceId,
      level: state.level,
      muted: state.muted,
      updated_at: state.updatedAt,
      source: 'server'
    });
    return state;
  }

  function removeDeviceVolume(deviceId) {
    delete deviceVolumeState[deviceId];
  }

  return {
    normalizeVolumeLevel,
    getVolumeState,
    persistVolumeState,
    emitVolumeCommand,
    applyVolumeCommand,
    getAllVolumeStates,
    initDeviceVolume,
    removeDeviceVolume,
    deviceVolumeState
  };
}
