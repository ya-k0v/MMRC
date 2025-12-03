// VideoControl Player - Video.js версия (упрощенная и надежная)

const socket = io('/', {
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 2000,
  reconnectionDelayMax: 10000,
  timeout: 20000,
  forceNew: false,
  upgrade: true,
  autoConnect: true
});
const url = new URL(location.href);
const device_id = url.searchParams.get('device_id');
const preview = url.searchParams.get('preview') === '1';
const forceMuted = url.searchParams.get('muted') === '1';
const forceSound = (url.searchParams.get('sound') === '1') || (url.searchParams.get('autoplay') === '1');
const previewFile = url.searchParams.get('file');
const previewStreamProtocol = url.searchParams.get('protocol');
const previewStreamUrl = url.searchParams.get('stream_url'); // Прямой URL стрима для превью

const idle = document.getElementById('idle');
const v = document.getElementById('v');
const videoContainer = document.getElementById('videoContainer'); // Контейнер для Video.js
const img1 = document.getElementById('img1');
const img2 = document.getElementById('img2');
const img = img1; // Для обратной совместимости со старым кодом
const pdf = document.getElementById('pdf');
const unmuteBtn = document.getElementById('unmute');

let currentFileState = { type: null, file: null, page: 1 };
let soundUnlocked = false;
let vjsPlayer = null;
let isSwitchingFromPlaceholder = false; // Флаг переключения с заглушки (аналог skipPlaceholderOnVideoEnd в Android)
let isLoadingPlaceholder = false; // Флаг для предотвращения двойной загрузки
let registerInFlight = false; // Предотвращаем одновременные попытки регистрации
let slidesCache = {}; // Кэш предзагруженных слайдов PPTX/PDF: { 'filename': { count: N, images: [Image, ...] } }
let currentImgBuffer = 1; // Текущий активный буфер изображений (1 или 2) для двойной буферизации
let wakeLock = null; // Wake Lock для предотвращения suspend
let currentPlaceholderSrc = null; // Отслеживаем текущую заглушку
let currentVideoFile = null; // Текущий файл видео (для проверки того же файла, как в Android)
let savedVideoPosition = 0; // Сохраненная позиция видео при паузе (в миллисекундах, как в Android)
let progressInterval = null; // Периодическая отправка прогресса (fallback)
let lastProgressEmitTs = 0; // Время последней отправки прогресса (для троттлинга)
let emitProgressStop = null; // Функция для отправки сигнала об остановке прогресса (будет установлена при инициализации Video.js)
let mpegtsPlayer = null;
let hlsPlayer = null;
let dashPlayer = null; // DASH плеер через dashjs

// Функция для остановки отправки прогресса
function stopProgressInterval() {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
}

// Управление звуком
const VOLUME_MIN = 0;
const VOLUME_MAX = 100;
const VOLUME_STEP = 5;
let currentVolumeLevel = 100;
let currentMuteState = true;
let awaitingVolumeSync = false;
let volumeStateSynced = false;
let pendingVolumeApply = false;

try {
  if (
    typeof localStorage !== 'undefined' &&
    !preview &&
    !forceMuted &&
    localStorage.getItem('vc_sound') === '1'
  ) {
    currentMuteState = false;
    volumeStateSynced = true;
  }
} catch (err) {
  currentMuteState = true;
}

function normalizeVolumeLevel(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  const clamped = Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, Math.round(value)));
  const stepped = Math.round(clamped / VOLUME_STEP) * VOLUME_STEP;
  return Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, stepped));
}

function applyVolumeToPlayer(reason = 'server') {
  if (!vjsPlayer) {
    pendingVolumeApply = true;
    return;
  }
  pendingVolumeApply = false;
  const isPlaceholderActive = currentFileState.type === 'placeholder';
  const shouldMute = isPlaceholderActive || forceMuted || currentMuteState || !soundUnlocked;
  const targetGain = shouldMute ? 0 : Math.max(0, Math.min(1, currentVolumeLevel / 100));
  try {
    vjsPlayer.muted(shouldMute);
    vjsPlayer.volume(targetGain);
  } catch (err) {
    console.warn(`[Player] ⚠️ applyVolumeToPlayer error (${reason}):`, err);
  }
}

function emitVolumeState(reason) {
  if (!device_id || preview || !socket || !socket.connected) {
    return;
  }
  const payload = {
    device_id,
    level: currentMuteState ? 0 : currentVolumeLevel,
    muted: forceMuted ? true : currentMuteState
  };
  if (reason) {
    payload.reason = reason;
  }
  socket.emit('player/volumeState', payload);
}

function applyVolumeChange({ level, delta, muted, reason = 'server' } = {}) {
  let nextLevel = currentVolumeLevel;
  if (typeof level === 'number') {
    const normalized = normalizeVolumeLevel(level);
    if (normalized !== null) {
      nextLevel = normalized;
    }
  } else if (typeof delta === 'number') {
    const normalized = normalizeVolumeLevel(currentVolumeLevel + delta);
    if (normalized !== null) {
      nextLevel = normalized;
    }
  }
  currentVolumeLevel = nextLevel;
  if (typeof muted === 'boolean') {
    currentMuteState = muted;
  }
  volumeStateSynced = true;
  applyVolumeToPlayer(reason);
  emitVolumeState(reason);
}

function handleVolumeCommand(payload = {}) {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const rawLevel = typeof payload.level !== 'undefined' ? payload.level : payload.volume;
  const levelNumber = Number(rawLevel);
  const levelValue = Number.isFinite(levelNumber) ? levelNumber : undefined;
  const deltaNumber = Number(payload.delta);
  const deltaValue = Number.isFinite(deltaNumber) ? deltaNumber : undefined;
  const mutedValue = typeof payload.muted === 'boolean' ? payload.muted : undefined;
  const reason = typeof payload.reason === 'string' ? payload.reason : 'server';

  if (
    typeof levelValue === 'undefined' &&
    typeof deltaValue === 'undefined' &&
    typeof mutedValue === 'undefined'
  ) {
    return;
  }

  applyVolumeChange({
    level: levelValue,
    delta: deltaValue,
    muted: mutedValue,
    reason
  });

  if (awaitingVolumeSync && reason === 'sync') {
    awaitingVolumeSync = false;
    emitVolumeState('sync_override');
  } else {
    awaitingVolumeSync = false;
  }
}

function ensureSocketConnected(reason = 'manual') {
  const isActive = typeof socket.active === 'boolean' ? socket.active : false;
  if (socket.connected || isActive) {
    return;
  }
  console.log(`[Player] 🔄 ensureSocketConnected → connect (${reason})`);
  try {
    socket.connect();
  } catch (err) {
    console.error(`[Player] ❌ ensureSocketConnected error (${reason}):`, err);
  }
}

// Функция для принудительного скрытия всех контролов Video.js
function hideVideoJsControls() {
  if (!vjsPlayer) return;
  
  try {
    // Скрываем big play button
    const bigPlayButton = vjsPlayer.getChild('bigPlayButton');
    if (bigPlayButton) {
      bigPlayButton.hide();
      bigPlayButton.el().style.display = 'none';
    }
    
    // Скрываем control bar
    const controlBar = vjsPlayer.getChild('controlBar');
    if (controlBar) {
      controlBar.hide();
      controlBar.el().style.display = 'none';
    }
    
    // Скрываем loading spinner
    const loadingSpinner = vjsPlayer.getChild('loadingSpinner');
    if (loadingSpinner) {
      loadingSpinner.hide();
      loadingSpinner.el().style.display = 'none';
    }
    
    console.log('[Player] 🚫 Все контролы Video.js скрыты');
  } catch (e) {
    console.warn('[Player] ⚠️ Ошибка скрытия контролов:', e);
  }
}

if (!device_id || !device_id.trim()) {
  [idle, v, img1, img2, pdf].forEach(el => el && el.classList.remove('visible'));
  document.documentElement.style.background = '#000 !important';
  document.body.style.background = '#000 !important';
  if (unmuteBtn) unmuteBtn.style.display = 'none';
} else {
  // КРИТИЧНО: Очищаем буферы при загрузке страницы, чтобы не было старых данных из кэша браузера
  // Это нужно делать ДО инициализации Video.js
  if (img1) {
    img1.src = ''; // Сначала устанавливаем пустой src для принудительной очистки
    img1.removeAttribute('src'); // Затем удаляем атрибут
    img1.classList.remove('visible', 'preloading');
    img1.style.opacity = ''; // Сбрасываем inline стили
  }
  if (img2) {
    img2.src = ''; // Сначала устанавливаем пустой src для принудительной очистки
    img2.removeAttribute('src'); // Затем удаляем атрибут
    img2.classList.remove('visible', 'preloading');
    img2.style.opacity = ''; // Сбрасываем inline стили
  }
  if (pdf) {
    pdf.src = ''; // Очищаем iframe
    pdf.removeAttribute('src');
    pdf.srcdoc = ''; // Очищаем srcdoc если использовался
    pdf.classList.remove('visible', 'preloading');
  }
  if (videoContainer) {
    videoContainer.classList.remove('visible', 'preloading');
    videoContainer.style.display = '';
  }
  if (idle) {
    idle.classList.remove('visible', 'preloading');
  }
  
  // КРИТИЧНО: Очищаем видео-элемент (если он уже был инициализирован браузером)
  // Очищаем через v элемент напрямую, если Video.js еще не инициализирован
  if (v && v.src) {
    try {
      v.pause();
      v.currentTime = 0;
      v.src = '';
      v.removeAttribute('src');
      v.load(); // Принудительно перезагружаем видео-элемент для очистки буферов
    } catch (e) {
      // Игнорируем ошибки если видео еще не инициализировано
    }
  }
  
  // Сбрасываем состояние буферов
  currentImgBuffer = 1;
  currentFileState = { type: null, file: null, page: 1 };
  isSwitchingFromPlaceholder = false;
  currentPlaceholderSrc = null; // Сбрасываем кэш заглушки
  currentVideoFile = null; // Сбрасываем текущий файл видео
  savedVideoPosition = 0; // Сбрасываем сохраненную позицию
  
  console.log('[Player] 🧹 Буферы очищены при загрузке страницы');
  
  // Инициализация Video.js
  document.addEventListener('DOMContentLoaded', () => {
    if (typeof videojs !== 'undefined') {
      try {
        vjsPlayer = videojs('v', {
          controls: false,
          autoplay: preview ? 'muted' : false, // SAFARI: autoplay только в preview режиме и только если muted
          preload: preview ? 'auto' : 'metadata', // В preview загружаем сразу для Safari
          muted: true,
          loop: false,
          playsinline: true,
          disablePictureInPicture: true,
          nativeControlsForTouch: false,
          // КРИТИЧНО для Android WebView: полностью нативный режим
          html5: {
            nativeVideoTracks: true,
            nativeAudioTracks: true,
            nativeTextTracks: true
          },
          liveui: false,
          responsive: false,
          fluid: false
        });
        
        // Ждем полной готовности Video.js
        vjsPlayer.ready(function() {
          console.log('[Player] ✅ Video.js готов к работе');
          
          // КРИТИЧНО: НЕ очищаем буферы здесь - они уже очищены при инициализации выше
          // Если очистить здесь, можно случайно удалить заглушку, которая уже загружается
          // Дополнительная очистка нужна только для видео, если оно случайно воспроизводится из кэша
          if (vjsPlayer) {
            try {
              // Останавливаем видео на случай если оно играет из кэша
              vjsPlayer.pause();
              vjsPlayer.currentTime(0);
              // НЕ очищаем src здесь - заглушка будет загружена через showPlaceholder()
              // Очистка src нужна только при переключении контента, не при инициализации
            } catch (e) {
              // Игнорируем ошибки при инициализации
            }
          }
          
          // Скрываем все контролы при инициализации
          hideVideoJsControls();
          applyVolumeToPlayer('player_ready');
          
          // Если было отложенное применение громкости - применяем сейчас
          if (pendingVolumeApply) {
            pendingVolumeApply = false;
            applyVolumeToPlayer('player_ready_pending');
          }
          
          // Автовключение звука ПОСЛЕ готовности Video.js
          if (!preview && forceSound && !forceMuted) {
            console.log('[Player] 🔊 Автовключение звука (sound=1)');
            setTimeout(() => enableSound(), 500);
            if (unmuteBtn) unmuteBtn.style.display = 'none';
          } else if (!preview && localStorage.getItem('vc_sound') === '1' && !forceMuted) {
            console.log('[Player] 🔊 Автовключение звука (из localStorage)');
            setTimeout(() => enableSound(), 500);
            if (unmuteBtn) unmuteBtn.style.display = 'none';
          } else if (unmuteBtn && !forceMuted && !preview) {
            // Показываем unmute кнопку если звук не включен автоматически
            unmuteBtn.style.display = 'inline-block';
          } else if (preview) {
            // SAFARI: В preview режиме ВСЕГДА скрываем кнопку unmute
            if (unmuteBtn) unmuteBtn.style.display = 'none';
          }
          
          // Обработчик окончания видео
          vjsPlayer.on('ended', () => {
            console.log('[Player] 🎬 Video.js ended event');
            
            // КРИТИЧНО: Для live стримов (streaming) игнорируем ended событие
            // Live стримы не должны заканчиваться
            if (currentFileState.type === 'streaming') {
              console.log('[Player] ⚠️ Ignoring ended event for live stream, attempting to resume');
              // Пытаемся возобновить воспроизведение
              setTimeout(() => {
                if (vjsPlayer.paused()) {
                  vjsPlayer.play().catch(err => {
                  });
                }
              }, 100);
              return;
            }
            
            // КРИТИЧНО: Android WebView может генерировать 'ended' при паузе (баг)
            // Проверяем, что видео ДЕЙСТВИТЕЛЬНО закончилось
            const currentTime = vjsPlayer.currentTime();
            const duration = vjsPlayer.duration();
            const isActuallyEnded = duration > 0 && currentTime >= duration - 0.5;
            const isLooping = vjsPlayer.loop();
            
            console.log('[Player] 🔍 Проверка ended:', { currentTime, duration, isActuallyEnded, paused: vjsPlayer.paused(), loop: isLooping });
            
            // КРИТИЧНО: Если включен loop - НЕ показываем placeholder!
            if (isLooping && isActuallyEnded) {
              console.log('[Player] 🔄 Loop видео, начинаем сначала БЕЗ черного экрана');
              vjsPlayer.currentTime(0);
              vjsPlayer.play();
              return;
            }
            
            // КРИТИЧНО: Показываем заглушку ТОЛЬКО если:
            // 1. Это не preview режим
            // 2. Видео действительно закончилось (isActuallyEnded проверяет currentTime >= duration - 0.5)
            // 3. Текущий контент - это видео (не placeholder, не изображение, не папка/PDF/PPTX)
            // 4. НЕ установлен флаг skipPlaceholderOnVideoEnd (isSwitchingFromPlaceholder) - аналог Android
            // КРИТИЧНО: НЕ проверяем isPaused, так как при окончании видео оно всегда на паузе
            const isPlaceholder = currentFileState.type === 'placeholder';
            const isVideo = currentFileState.type === 'video' || currentFileState.type === null;
            const skipPlaceholderOnVideoEnd = isSwitchingFromPlaceholder; // Используем существующий флаг как аналог Android skipPlaceholderOnVideoEnd
            
            // Останавливаем отправку прогресса при окончании видео
            stopProgressInterval();
            if (emitProgressStop) {
              emitProgressStop();
            }
            
            // КРИТИЧНО: Показываем заглушку если видео действительно закончилось
            // isActuallyEnded уже проверяет, что currentTime >= duration - 0.5, что гарантирует окончание
            if (!preview && isActuallyEnded && isVideo && !isPlaceholder && !skipPlaceholderOnVideoEnd) {
              console.log('[Player] ✅ Видео закончилось, останавливаем и показываем заглушку');
              
              // КРИТИЧНО: Полностью останавливаем видео (stop) перед показом заглушки
              // Это аналогично поведению Android клиента
              try {
                vjsPlayer.pause();
                vjsPlayer.currentTime(0);
                // Очищаем состояние видео
                currentVideoFile = null;
                savedVideoPosition = 0;
                currentFileState = { type: null, file: null, page: 1 };
              } catch (e) {
                console.warn('[Player] ⚠️ Ошибка при остановке видео:', e);
              }
              
              showPlaceholder();
            } else if (!isActuallyEnded) {
              console.log('[Player] ⚠️ Ложное ended событие (Android WebView bug), игнорируем');
            } else {
              console.log('[Player] ⚠️ Не показываем заглушку:', { preview, isActuallyEnded, currentFileStateType: currentFileState.type, isPlaceholder, isVideo, skipPlaceholderOnVideoEnd });
            }
          });
          
          // Обработчик ошибок
          vjsPlayer.on('error', function() {
            const error = vjsPlayer.error();
            console.error('[Player] ❌ Video.js error:', error);
            
            // КРИТИЧНО: При ошибке MEDIA_ERR_SRC_NOT_SUPPORTED пытаемся перезагрузить
            if (error && error.code === 4) {
              console.warn('[Player] ⚠️ MEDIA_ERR_SRC_NOT_SUPPORTED, возможно элемент был скрыт при загрузке');
              
              // КРИТИЧНО: Если на плеере во время стрима пропало соединение, возвращаемся на заглушку
              const isStreaming = currentFileState.type === 'streaming';
              const isDisconnected = !socket.connected;
              
              if (isStreaming && !preview && isDisconnected) {
                console.log('[Player] 🔄 Ошибка Video.js при потере соединения во время стрима, возвращаемся на заглушку');
                
                // Останавливаем все плееры стрима
                destroyMpegtsPlayer('videojs_error_disconnect');
                destroyHlsPlayer('videojs_error_disconnect');
                destroyDashPlayer('videojs_error_disconnect');
                
                // Очищаем состояние стрима
                clearAllBuffers();
                currentFileState = { type: null, file: null, page: 1 };
                currentVideoFile = null;
                savedVideoPosition = 0;
                isSwitchingFromPlaceholder = false;
                
                // Возвращаемся на заглушку
                showPlaceholder(false);
                return;
              }
              
              // Не делаем автоматический retry - это может создать цикл
              // Просто логируем для диагностики
            }
          });
          
          // КРИТИЧНО для Android: обработчики буферизации и зависания
          let stalledTimeout = null;
          let waitingTimeout = null;
          
          // КРИТИЧНО для Android: обработчики состояния воспроизведения
          let lastLoggedPercent = -1;
          
          vjsPlayer.on('stalled', () => {
            // КРИТИЧНО: stalled - нормальное поведение при медленном интернете
            // Браузер сам управляет буферизацией, не нужно ничего делать
          });
          
          vjsPlayer.on('waiting', () => {
            // КРИТИЧНО: waiting - нормальное поведение, видео ждет буферизации
          });
          
          // КРИТИЧНО: Функция для отправки прогресса воспроизведения
          const emitProgress = () => {
            // КРИТИЧНО: Не шлем прогресс из превью, не для заглушки, и только для активного видео
            if (!vjsPlayer || !device_id || preview) return;
            
            // КРИТИЧНО: Не отправляем прогресс если показывается заглушка
            if (currentFileState && (currentFileState.type !== 'video' || currentFileState.type === 'placeholder')) {
              return;
            }
            
            // КРИТИЧНО: Не отправляем прогресс если видео на паузе или остановлено
            if (vjsPlayer.paused() || vjsPlayer.ended()) {
              return;
            }
            
            const now = Date.now();
            // троттлим до ~2 раза в секунду
            if (now - lastProgressEmitTs < 500) return;
            lastProgressEmitTs = now;
            try {
              const cur = Number.isFinite(vjsPlayer.currentTime()) ? vjsPlayer.currentTime() : 0;
              const dur = Number.isFinite(vjsPlayer.duration()) ? vjsPlayer.duration() : 0;
              socket.emit('player/progress', {
                device_id,
                type: 'video',
                file: currentFileState?.file || null,
                currentTime: Math.max(0, Math.floor(cur)),
                duration: Math.max(0, Math.floor(dur))
              });
            } catch (e) {
              // ignore
            }
          };
          
          // КРИТИЧНО: Отправка сигнала об остановке прогресса (для очистки информации на панели спикера)
          emitProgressStop = () => {
            if (!device_id || preview) return;
            try {
              // Отправляем сигнал с нулевым прогрессом для очистки информации
              socket.emit('player/progress', {
                device_id,
                type: 'idle',
                file: null,
                currentTime: 0,
                duration: 0
              });
            } catch (e) {
              // ignore
            }
          };
          
          // Дополнительно: регулярная отправка прогресса раз в 1с, пока идёт воспроизведение
          const startProgressInterval = () => {
            if (progressInterval || preview) return;
            progressInterval = setInterval(() => {
              if (!vjsPlayer || vjsPlayer.paused()) return;
              emitProgress();
            }, 1000);
          };
          
          // Регистрируем обработчики событий для отправки прогресса
          vjsPlayer.on('timeupdate', emitProgress);
          vjsPlayer.on('loadedmetadata', emitProgress);
          vjsPlayer.on('seeking', emitProgress);
          vjsPlayer.on('seeked', emitProgress);
          vjsPlayer.on('playing', startProgressInterval);
          vjsPlayer.on('pause', stopProgressInterval);
          vjsPlayer.on('ended', stopProgressInterval);
          vjsPlayer.on('dispose', stopProgressInterval);
          
          vjsPlayer.on('playing', () => {
            console.log('[Player] ▶️ Video playing');
            
            // КРИТИЧНО: Запрашиваем Wake Lock для предотвращения suspend
            if ('wakeLock' in navigator && !wakeLock) {
              navigator.wakeLock.request('screen').then(wl => {
                wakeLock = wl;
                console.log('[Player] 🔒 Wake Lock получен - предотвращаем suspend');
                
                wakeLock.addEventListener('release', () => {
                  console.log('[Player] 🔓 Wake Lock освобожден');
                  wakeLock = null;
                });
              }).catch(e => {
              });
            }
          });
          
          vjsPlayer.on('progress', () => {
            // Логируем прогресс буферизации
            const buffered = vjsPlayer.buffered();
            const duration = vjsPlayer.duration();
            
            if (buffered.length > 0) {
              const bufferedEnd = buffered.end(buffered.length - 1);
              const percent = duration > 0 ? Math.round((bufferedEnd / duration) * 100) : 0;
              
              // Логируем каждый раз при изменении процента (для отладки)
              if (percent !== lastLoggedPercent) {
                lastLoggedPercent = percent;
              }
            } else {
              // Если буфер пуст, логируем для отладки
              if (duration > 0) {
                console.debug(`[Player] 📊 Прогресс: буфер пуст, duration=${duration.toFixed(2)}s`);
              } else {
                console.debug(`[Player] 📊 Прогресс: буфер пуст, duration неизвестна`);
              }
            }
          });
          
          vjsPlayer.on('suspend', () => {
          });
          
          vjsPlayer.on('canplay', () => {
            const buffered = vjsPlayer.buffered();
            const duration = vjsPlayer.duration();
            const bufferedInfo = buffered.length > 0 
              ? `${buffered.end(buffered.length - 1).toFixed(2)}s` 
              : '0s';
            console.log(`[Player] ✅ canplay - достаточно данных для воспроизведения (buffered=${bufferedInfo}, duration=${duration > 0 ? duration.toFixed(2) : '?'}s)`);
          });
          
          vjsPlayer.on('canplaythrough', () => {
            const buffered = vjsPlayer.buffered();
            const duration = vjsPlayer.duration();
            const bufferedInfo = buffered.length > 0 
              ? `${buffered.end(buffered.length - 1).toFixed(2)}s` 
              : '0s';
          });
          
          vjsPlayer.on('loadstart', () => {
            console.log('[Player] 🔄 loadstart - начало загрузки видео');
          });
          
          vjsPlayer.on('loadeddata', () => {
            const buffered = vjsPlayer.buffered();
            const duration = vjsPlayer.duration();
            const bufferedInfo = buffered.length > 0 
              ? `${buffered.end(buffered.length - 1).toFixed(2)}s` 
              : '0s';
            console.log(`[Player] 📥 loadeddata - первые данные загружены (buffered=${bufferedInfo}, duration=${duration > 0 ? duration.toFixed(2) : '?'}s)`);
          });
          
          // Загружаем заглушку или preview файл после готовности
          if (preview && previewFile) {
            // Preview режим - показываем указанный файл
            setTimeout(() => {
              const previewType = url.searchParams.get('type');
              const previewPage = url.searchParams.get('page');
              const ext = previewFile.split('.').pop().toLowerCase();
              
              console.log('[Player] 🔍 Preview режим:', { previewFile, previewType, previewPage, ext });
              
              if (previewType === 'pdf' && previewPage) {
                // PDF preview
                const imageUrl = `/api/devices/${encodeURIComponent(device_id)}/converted/${encodeURIComponent(previewFile)}/page/${previewPage}`;
                console.log('[Player] 📄 Preview PDF:', imageUrl);
                img.src = imageUrl;
                show(img);
              } else if (previewType === 'pptx' && previewPage) {
                // PPTX preview
                const imageUrl = `/api/devices/${encodeURIComponent(device_id)}/converted/${encodeURIComponent(previewFile)}/slide/${previewPage}`;
                console.log('[Player] 📊 Preview PPTX:', imageUrl);
                img.src = imageUrl;
                show(img);
              } else if (previewType === 'image' || ['png','jpg','jpeg','gif','webp'].includes(ext)) {
                // Изображение preview
                console.log('[Player] 🖼️ Preview изображение:', previewFile);
                img.src = content(previewFile);
                show(img);
              } else if (previewType === 'streaming') {
                console.log('[Player] 📡 Preview стрима:', previewFile);
                
                // КРИТИЧНО: Если stream_url передан напрямую (из превью), используем его без запроса к API
                if (previewStreamUrl) {
                  // КРИТИЧНО: Если URL содержит .m3u8 (проксированный HLS), всегда используем 'hls'
                  // независимо от исходного протокола
                  let proto = previewStreamProtocol || 'hls';
                  if (previewStreamUrl.includes('.m3u8')) {
                    proto = 'hls';
                  }
                  console.log('[Player] 📡 Используем прямой URL для превью (из параметра):', { playbackUrl: previewStreamUrl, proto });
                  
                  // КРИТИЧНО: Для HLS стримов проверяем доступность плейлиста с retry
                  if (previewStreamUrl.includes('.m3u8') || proto === 'hls') {
                    console.log('[Player] 📡 Проверяем доступность HLS плейлиста для превью...');
                    let retryCount = 0;
                    const maxRetries = 5;
                    const retryDelay = 1000; // 1 секунда
                    
                    const tryLoadStream = async () => {
                      try {
                        // Проверяем доступность плейлиста
                        const checkRes = await fetch(previewStreamUrl, { method: 'HEAD', cache: 'no-cache' });
                        if (checkRes.ok) {
                          console.log('[Player] ✅ HLS плейлист доступен, запускаем воспроизведение');
                          handleStreamingPlayback(previewStreamUrl, previewFile, proto);
                        } else if (retryCount < maxRetries) {
                          retryCount++;
                          console.log(`[Player] ⏳ HLS плейлист еще не готов, повтор через ${retryDelay}ms (попытка ${retryCount}/${maxRetries})`);
                          setTimeout(tryLoadStream, retryDelay);
                        } else {
                          console.warn('[Player] ⚠️ HLS плейлист не стал доступен после всех попыток, пробуем запустить');
                          handleStreamingPlayback(previewStreamUrl, previewFile, proto);
                        }
                      } catch (err) {
                        if (retryCount < maxRetries) {
                          retryCount++;
                          console.log(`[Player] ⏳ Ошибка проверки плейлиста, повтор через ${retryDelay}ms (попытка ${retryCount}/${maxRetries}):`, err.message);
                          setTimeout(tryLoadStream, retryDelay);
                        } else {
                          console.warn('[Player] ⚠️ Не удалось проверить HLS плейлист, пробуем запустить:', err);
                          handleStreamingPlayback(previewStreamUrl, previewFile, proto);
                        }
                      }
                    };
                    
                    // Начинаем с небольшой задержки
                    setTimeout(tryLoadStream, 500);
                  } else {
                    handleStreamingPlayback(previewStreamUrl, previewFile, proto);
                  }
                  return;
                }
                
                // Если stream_url не передан - получаем через API (старый способ для обратной совместимости)
                fetch(`/api/devices/${encodeURIComponent(device_id)}/streams/${encodeURIComponent(previewFile)}`)
                  .then(res => res.ok ? res.json() : Promise.reject(new Error('stream not found')))
                  .then(data => {
                    // КРИТИЧНО: Используем ИСКЛЮЧИТЕЛЬНО streamProxyUrl (без fallback)
                    const playbackUrl = data?.streamProxyUrl;
                    if (playbackUrl) {
                      const proto = data?.protocol || previewStreamProtocol;
                      console.log('[Player] 📡 Используем streamProxyUrl для превью (из API):', { playbackUrl, proto });
                      
                      // КРИТИЧНО: Для HLS стримов проверяем доступность плейлиста с retry
                      if (playbackUrl.includes('.m3u8') || proto === 'hls') {
                        console.log('[Player] 📡 Проверяем доступность HLS плейлиста для превью...');
                        let retryCount = 0;
                        const maxRetries = 5;
                        const retryDelay = 1000; // 1 секунда
                        
                        const tryLoadStream = async () => {
                          try {
                            // Проверяем доступность плейлиста
                            const checkRes = await fetch(playbackUrl, { method: 'HEAD', cache: 'no-cache' });
                            if (checkRes.ok) {
                              console.log('[Player] ✅ HLS плейлист доступен, запускаем воспроизведение');
                              handleStreamingPlayback(playbackUrl, previewFile, proto);
                            } else if (retryCount < maxRetries) {
                              retryCount++;
                              console.log(`[Player] ⏳ HLS плейлист еще не готов, повтор через ${retryDelay}ms (попытка ${retryCount}/${maxRetries})`);
                              setTimeout(tryLoadStream, retryDelay);
                            } else {
                              console.warn('[Player] ⚠️ HLS плейлист не стал доступен после всех попыток, пробуем запустить');
                              handleStreamingPlayback(playbackUrl, previewFile, proto);
                            }
                          } catch (err) {
                            if (retryCount < maxRetries) {
                              retryCount++;
                              console.log(`[Player] ⏳ Ошибка проверки плейлиста, повтор через ${retryDelay}ms (попытка ${retryCount}/${maxRetries}):`, err.message);
                              setTimeout(tryLoadStream, retryDelay);
                            } else {
                              console.warn('[Player] ⚠️ Не удалось проверить HLS плейлист, пробуем запустить:', err);
                              handleStreamingPlayback(playbackUrl, previewFile, proto);
                            }
                          }
                        };
                        
                        // Начинаем с небольшой задержки
                        setTimeout(tryLoadStream, 500);
                      } else {
                        handleStreamingPlayback(playbackUrl, previewFile, proto);
                      }
                    } else {
                      console.warn('[Player] ⚠️ Предпросмотр стрима: отсутствует streamUrl');
                    }
                  })
                  .catch(err => {
                    console.warn('[Player] ⚠️ Не удалось загрузить данные стрима', err);
                  });
              } else if (['mp4','webm','ogg','mkv','mov','avi'].includes(ext) || previewType === 'video') {
                // Видео preview
                console.log('[Player] 🎬 Preview видео:', previewFile);
                vjsPlayer.loop(true);
                vjsPlayer.muted(true);
                vjsPlayer.volume(0);
                
                // КРИТИЧНО: Проверяем наличие трейлера - используем его вместо полного файла
                const trailerUrlParam = url.searchParams.get('trailerUrl');
                let videoSrc;
                
                if (trailerUrlParam) {
                  // КРИТИЧНО: URLSearchParams.get() автоматически декодирует значение
                  // trailerUrlParam уже должен быть правильным путем (/api/files/trailer/...)
                  // Используем как есть, так как это уже декодированный путь
                  const trailerUrl = trailerUrlParam;
                  console.log('[Player] 🎬 Используем трейлер для превью:', trailerUrl);
                  videoSrc = trailerUrl;
                } else {
                  // Fallback: используем preview endpoint (первые 10 секунд)
                  const previewSeconds = parseInt(url.searchParams.get('seconds') || '10', 10);
                  const previewStart = parseInt(url.searchParams.get('start') || '0', 10);
                  videoSrc = videoPreviewSource(previewFile, { start: previewStart, seconds: previewSeconds });
                  console.log('[Player] 🎬 Используем preview endpoint (трейлер недоступен):', videoSrc);
                }
                
                vjsPlayer.src({ src: videoSrc, type: 'video/mp4' });
                videoContainer.style.display = ''; // КРИТИЧНО: Сбрасываем display:none
                show(videoContainer);
                
                // Даем время для загрузки src
                setTimeout(() => {
                  vjsPlayer.play().then(() => {
                    console.log('[Player] ✅ Preview видео запущено:', previewFile);
                  }).catch(err => {
                    // КРИТИЧНО: Игнорируем AbortError - браузер блокирует autoplay на фоновых вкладках
                    // Видео всё равно загружено и показан первый кадр
                    if (err.name === 'AbortError') {
                      console.log('[Player] ℹ️ Preview видео загружен (autoplay заблокирован браузером - это нормально для фоновых вкладок)');
                    } else {
                      console.warn('[Player] ⚠️ Preview ошибка:', err.name, err.message);
                    }
                    
                    // SAFARI FIX: Если autoplay не сработал, пробуем запустить при клике
                    if (preview) {
                      const startOnInteraction = () => {
                        vjsPlayer.play().then(() => {
                          console.log('[Player] ✅ Safari: видео запущено после user interaction');
                        }).catch(e => console.log('[Player] Safari play error:', e));
                        document.removeEventListener('click', startOnInteraction);
                        document.removeEventListener('touchstart', startOnInteraction);
                      };
                      document.addEventListener('click', startOnInteraction, { once: true });
                      document.addEventListener('touchstart', startOnInteraction, { once: true });
                    }
                  });
                }, 150);
              } else {
                console.warn('[Player] ⚠️ Неизвестный тип preview:', ext, previewType);
              }
            }, 100);
          } else {
            // Обычный режим - показываем заглушку
            setTimeout(() => showPlaceholder(), 100);
          }
        });
      } catch (e) {
        console.error('[Player] ❌ Ошибка инициализации Video.js:', e);
      }
    } else {
      console.error('[Player] ❌ Video.js library не загружена!');
    }
  });
  
  // Функция для получения текущего и следующего буфера изображений
  function getImageBuffers() {
    const current = currentImgBuffer === 1 ? img1 : img2;
    const next = currentImgBuffer === 1 ? img2 : img1;
    return { current, next };
  }
  
  // Универсальная функция полной очистки всех буферов
  function clearAllBuffers() {
    console.log('[Player] 🧹 Очистка всех буферов');
    
    // Останавливаем отправку прогресса
    stopProgressInterval();
    if (emitProgressStop) {
      emitProgressStop();
    }
    destroyMpegtsPlayer('clear_buffers');
    destroyHlsPlayer('clear_buffers');
    destroyDashPlayer('clear_buffers');
    
    // КРИТИЧНО: Сначала скрываем videoContainer, чтобы Video.js не пытался загрузить видео в скрытый элемент
    if (videoContainer) {
      videoContainer.classList.remove('visible', 'preloading');
      videoContainer.style.display = 'none';
    }
    
    // Останавливаем видео ПОСЛЕ скрытия контейнера
    // КРИТИЧНО: НЕ вызываем src('') - это вызывает ошибку MEDIA_ERR_SRC_NOT_SUPPORTED
    // Video.js сам заменит src когда мы установим новый источник
    if (vjsPlayer) {
      try {
        vjsPlayer.pause();
        vjsPlayer.currentTime(0);
        // НЕ вызываем vjsPlayer.src('') - это вызывает ошибку!
        // Просто останавливаем воспроизведение - этого достаточно
      } catch (e) {
        console.warn('[Player] ⚠️ Ошибка очистки видео:', e);
      }
    }
    
    // Очищаем изображения
    if (img1) {
      img1.removeAttribute('src');
      img1.removeAttribute('style');
      img1.classList.remove('visible', 'preloading');
    }
    if (img2) {
      img2.removeAttribute('src');
      img2.removeAttribute('style');
      img2.classList.remove('visible', 'preloading');
    }
    
    // Очищаем PDF
    if (pdf) {
      pdf.removeAttribute('src');
      pdf.removeAttribute('style');
      pdf.classList.remove('visible', 'preloading');
    }
    
    // Скрываем idle (черный экран)
    if (idle) {
      idle.classList.remove('visible', 'preloading');
    }
    
    // Сбрасываем буфер
    currentImgBuffer = 1;
    
    // КРИТИЧНО: Сбрасываем состояние видео (как в Android)
    currentVideoFile = null;
    savedVideoPosition = 0;
  }
  
  // Мгновенный показ элемента без задержек
  function show(el, skipTransition = false) {
    if (!el) {
      console.warn('[Player] ⚠️ show() вызван с null/undefined element!');
      return;
    }
    
    console.log('[Player] 🎬 show() - мгновенный показ:', el.id || el.className);
    
    // Убедимся что body черный
    document.body.style.background = '#000';
    document.documentElement.style.background = '#000';
    
    // Мгновенно показываем новый элемент
    el.classList.add('visible');
    el.classList.remove('preloading');
    
    // Скрываем все остальные элементы
    [idle, videoContainer, img1, img2, pdf].forEach(e => {
      if (e && e !== el) {
        e.classList.remove('visible', 'preloading');
      }
    });
    
    console.log('[Player] ✅ Элемент показан мгновенно');
  }
  
  // Предзагрузка элемента (скрыто)
  function preload(el) {
    if (!el) return;
    console.log('[Player] 📥 Предзагрузка:', el.id || el.className);
    el.classList.remove('visible');
    el.classList.add('preloading');
  }

  function content(file){ 
    // НОВОЕ: Используем API resolver для поддержки shared storage (дедупликация)
    return `/api/files/resolve/${encodeURIComponent(device_id)}/${encodeURIComponent(file)}`; 
  }

  const STREAM_PROTOCOLS = new Set(['hls', 'dash', 'mpegts']);

  function detectStreamProtocolFromUrl(url = '') {
    const lower = (url || '').toLowerCase();
    if (lower.includes('.m3u8') || lower.includes('format=m3u8')) {
      return 'hls';
    }
    if (lower.endsWith('.mpd') || lower.includes('format=mpd') || lower.includes('dash-live')) {
      return 'dash';
    }
    return 'mpegts';
  }

  function normalizeStreamProtocol(protocol, url) {
    // КРИТИЧНО: Сначала проверяем URL - если это проксированный HLS (содержит .m3u8),
    // то всегда используем HLS, независимо от исходного протокола
    // Это важно, так как все стримы рестримятся в HLS формат через FFmpeg
    if (url) {
      const urlLower = url.toLowerCase();
      if (urlLower.includes('.m3u8') || urlLower.includes('format=m3u8')) {
        return 'hls';
      }
      if (urlLower.includes('.mpd') || urlLower.includes('format=mpd') || urlLower.includes('dash-live')) {
        return 'dash';
      }
    }
    
    // Если URL не указывает на формат, проверяем переданный протокол
    const normalized = (protocol || '').toString().trim().toLowerCase();
    if (STREAM_PROTOCOLS.has(normalized)) {
      return normalized;
    }
    
    // Fallback: определяем по URL
    return detectStreamProtocolFromUrl(url);
  }

  // КРИТИЧНО: Добавляет cache-busting параметр к URL для предотвращения кэширования старых m3u8 плейлистов
  function addCacheBustParam(url) {
    if (!url) return url;
    try {
      const urlObj = new URL(url, window.location.origin);
      // Добавляем timestamp для предотвращения кэширования
      urlObj.searchParams.set('_t', Date.now().toString());
      return urlObj.toString();
    } catch (e) {
      // Если URL относительный или невалидный, добавляем параметр вручную
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}_t=${Date.now()}`;
    }
  }

  function detectStreamMime(protocol, url = '') {
    if (protocol === 'dash') {
      return 'application/dash+xml';
    }
    if (protocol === 'hls') {
      return 'application/x-mpegURL';
    }
    // fallback for auto detection
    const lower = (url || '').toLowerCase();
    if (lower.includes('.m3u8') || lower.includes('format=m3u8')) {
      return 'application/x-mpegURL';
    }
    if (lower.endsWith('.mpd') || lower.includes('format=mpd')) {
      return 'application/dash+xml';
    }
    return 'video/mp2t';
  }

  function destroyMpegtsPlayer(reason = 'unknown') {
    if (mpegtsPlayer) {
      try {
        console.log('[Player] 📴 Отключаем MPEG-TS поток', reason);
        if (typeof mpegtsPlayer.destroy === 'function') {
          mpegtsPlayer.destroy();
        }
      } catch (err) {
        console.warn('[Player] ⚠️ Ошибка остановки MPEG-TS', err);
      }
      mpegtsPlayer = null;
    }
  }

  function destroyHlsPlayer(reason = 'unknown') {
    if (hlsPlayer) {
      try {
        console.log('[Player] 📴 Отключаем HLS.js', reason);
        if (typeof hlsPlayer.destroy === 'function') {
          hlsPlayer.destroy();
        }
      } catch (err) {
        console.warn('[Player] ⚠️ Ошибка остановки HLS.js', err);
      }
      hlsPlayer = null;
    }
  }

  function destroyDashPlayer(reason = 'unknown') {
    if (dashPlayer) {
      try {
        console.log('[Player] 📴 Отключаем DASH плеер', reason);
        // Правильный порядок остановки dashjs
        if (typeof dashPlayer.reset === 'function') {
          dashPlayer.reset();
        }
        if (typeof dashPlayer.detachView === 'function') {
          dashPlayer.detachView();
        }
        if (typeof dashPlayer.destroy === 'function') {
          dashPlayer.destroy();
        }
      } catch (err) {
        console.warn('[Player] ⚠️ Ошибка остановки DASH плеера', err);
      }
      dashPlayer = null;
    }
  }

  function playViaVideoJs(streamUrl, protocolHint) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => {
          // КРИТИЧНО: Добавляем cache-busting для HLS, чтобы избежать кэширования старых m3u8
          const finalUrl = (protocolHint === 'hls' || streamUrl?.includes('.m3u8')) 
            ? addCacheBustParam(streamUrl) 
            : streamUrl;
          const mimeType = detectStreamMime(protocolHint, streamUrl);
          vjsPlayer.src({ src: finalUrl, type: mimeType });
          vjsPlayer.play().then(() => {
            show(videoContainer, true);
            console.log('[Player] ▶️ Стрим запущен через Video.js', { streamUrl, mimeType });
            // КРИТИЧНО: Отправляем player/progress для обновления информации на панели спикера
            // КРИТИЧНО: Не отправляем в preview режиме
            if (!preview && device_id && currentFileState?.file && currentFileState?.type === 'streaming') {
              socket.emit('player/progress', {
                device_id,
                type: 'streaming',
                file: currentFileState.file,
                currentTime: 0,
                duration: 0,
                stream_protocol: currentFileState.streamProtocol || protocolHint
              });
            }
          }).catch(err => {
            console.error('[Player] ❌ Ошибка запуска стрима через Video.js', err);
            
            // КРИТИЧНО: Если на плеере во время стрима пропало соединение, возвращаемся на заглушку
            const isStreaming = currentFileState.type === 'streaming';
            const isDisconnected = !socket.connected;
            
            if (isStreaming && !preview && isDisconnected) {
              console.log('[Player] 🔄 Ошибка запуска стрима при потере соединения, возвращаемся на заглушку');
              
              // Очищаем состояние стрима
              clearAllBuffers();
              currentFileState = { type: null, file: null, page: 1 };
              currentVideoFile = null;
              savedVideoPosition = 0;
              isSwitchingFromPlaceholder = false;
              
              // Возвращаемся на заглушку
              showPlaceholder(false);
            }
          });
        }, 50);
      });
    });
  }

  function handleStreamingPlayback(streamUrl, file, streamProtocol = null) {
    if (!streamUrl || !vjsPlayer) {
      console.warn('[Player] ⚠️ Нет stream_url для воспроизведения стрима', { file });
      return;
    }

    const resolvedProtocol = normalizeStreamProtocol(streamProtocol, streamUrl);
    console.log('[Player] 🌐 Streaming playback', { 
      file, 
      streamUrl, 
      streamProtocol,  // Исходный протокол из сервера
      resolvedProtocol,  // Нормализованный протокол
      hasHls: !!window.Hls,
      hlsSupported: window.Hls ? window.Hls.isSupported() : false
    });

    clearAllBuffers();
    currentFileState = { type: 'streaming', file, page: 1, streamProtocol: resolvedProtocol };
    currentVideoFile = file;
    savedVideoPosition = 0;
    destroyMpegtsPlayer('switch_to_streaming');
    destroyHlsPlayer('switch_to_streaming');

    try {
      vjsPlayer.pause();
      vjsPlayer.currentTime(0);
    } catch {}

    vjsPlayer.loop(false);
    applyVolumeToPlayer('play_stream');
    hideVideoJsControls();

    videoContainer.style.display = 'block';
    videoContainer.classList.remove('visible', 'preloading');

    const tech = vjsPlayer.tech(true);
    const mediaEl = tech && typeof tech.el === 'function' ? tech.el() : document.getElementById('v_html5_api') || v;
    if (mediaEl) {
      mediaEl.crossOrigin = 'anonymous';
    }

    if (resolvedProtocol === 'hls' && window.Hls && window.Hls.isSupported()) {
      try {
        if (!mediaEl) {
          console.error('[Player] ❌ Не удалось получить video элемент для HLS');
        } else {
          // КРИТИЧНО: Добавляем cache-busting параметр к URL для предотвращения кэширования старого m3u8
          // Это решает проблему, когда плеер воспроизводит старые сегменты после перезапуска стрима
          const cacheBustUrl = addCacheBustParam(streamUrl);
          console.log('[Player] 🔄 HLS URL с cache-busting', { original: streamUrl, cacheBust: cacheBustUrl });
          
          hlsPlayer = new window.Hls({
            liveSyncDurationCount: 3,
            enableWorker: true,
            lowLatencyMode: true,
            backBufferLength: 30,
            // КРИТИЧНО: Настройки для live стримов
            maxBufferLength: 30,        // Максимальная длина буфера (секунды)
            maxMaxBufferLength: 60,     // Максимальная максимальная длина буфера
            maxBufferSize: 60 * 1000 * 1000, // Максимальный размер буфера (60MB)
            maxBufferHole: 0.5,         // Максимальная дыра в буфере (секунды)
            highBufferWatchdogPeriod: 2, // Период проверки буфера
            nudgeOffset: 0.1,           // Смещение для синхронизации
            nudgeMaxRetry: 3,           // Максимальное количество попыток синхронизации
            maxFragLoadingTimeOut: 20000, // Таймаут загрузки фрагмента (20 секунд)
            fragLoadingTimeOut: 20000,   // Таймаут загрузки фрагмента
            manifestLoadingTimeOut: 10000, // Таймаут загрузки манифеста (10 секунд)
            // КРИТИЧНО: Отключаем автоматическую паузу при достижении конца
            autoStartLoad: true,
            startPosition: -1,          // Начинаем с последнего доступного сегмента (live)
            liveDurationInfinity: true,  // Live стрим без конечной длительности
            // КРИТИЧНО: Отключаем кэширование манифеста и сегментов
            xhrSetup: (xhr, url) => {
              // Добавляем cache-busting к каждому запросу манифеста
              if (url.includes('.m3u8')) {
                const separator = url.includes('?') ? '&' : '?';
                const bustedUrl = `${url}${separator}_t=${Date.now()}`;
                console.log('[Player] 🔄 HLS манифест запрос с cache-busting', { original: url, busted: bustedUrl });
                xhr.open('GET', bustedUrl, true);
                return;
              }
              xhr.open('GET', url, true);
            }
          });
          hlsPlayer.loadSource(cacheBustUrl);
          hlsPlayer.attachMedia(mediaEl);
          hlsPlayer.on(window.Hls.Events.MANIFEST_PARSED, () => {
            mediaEl.play().then(() => {
              show(videoContainer, true);
              console.log('[Player] ▶️ HLS поток запущен');
              // КРИТИЧНО: Отправляем player/progress для обновления информации на панели спикера
              // КРИТИЧНО: Не отправляем в preview режиме
              if (!preview && device_id && file) {
                socket.emit('player/progress', {
                  device_id,
                  type: 'streaming',
                  file: file,
                  currentTime: 0,
                  duration: 0,
                  stream_protocol: resolvedProtocol
                });
              }
            }).catch(err => {
              console.error('[Player] ❌ Ошибка запуска HLS', err);
            });
          });
          
          // КРИТИЧНО: Для live стримов отслеживаем загрузку новых сегментов
          hlsPlayer.on(window.Hls.Events.FRAG_LOADED, () => {
            // Если плеер на паузе в конце буфера, возобновляем воспроизведение
            if (mediaEl.paused && mediaEl.readyState >= 3) {
              const buffered = mediaEl.buffered;
              const currentTime = mediaEl.currentTime;
              const bufferedEnd = buffered.length > 0 ? buffered.end(buffered.length - 1) : 0;
              
              // Если мы близко к концу буфера (в пределах 1 секунды), возобновляем
              if (bufferedEnd > 0 && (bufferedEnd - currentTime) < 1) {
                mediaEl.play().catch(err => {
                });
              }
            }
          });
          hlsPlayer.on(window.Hls.Events.ERROR, (_, data) => {
            if (data?.fatal) {
              console.error('[Player] ❌ HLS fatal error', data);
              
              // КРИТИЧНО: Для preview стримов не пытаемся перезапускать через Video.js
              // так как это может быть проблема с доступностью плейлиста
              if (preview && previewFile) {
                console.warn('[Player] ⚠️ HLS ошибка в preview режиме, возможно плейлист еще не готов');
                // Не перезапускаем, просто логируем
                return;
              }
              
              // КРИТИЧНО: Если на плеере во время стрима пропало соединение, возвращаемся на заглушку
              const isStreaming = currentFileState.type === 'streaming';
              const isNetworkError = data.type === 'networkError' || data.details === 'levelLoadError';
              const isDisconnected = !socket.connected;
              
              if (isStreaming && !preview && (isDisconnected || isNetworkError)) {
                console.log('[Player] 🔄 HLS fatal ошибка при потере соединения во время стрима, возвращаемся на заглушку');
                
                destroyHlsPlayer('fatal_error_disconnect');
                
                // Очищаем состояние стрима
                clearAllBuffers();
                currentFileState = { type: null, file: null, page: 1 };
                currentVideoFile = null;
                savedVideoPosition = 0;
                isSwitchingFromPlaceholder = false;
                
                // Возвращаемся на заглушку
                showPlaceholder(false);
                return;
              }
              
              destroyHlsPlayer('fatal_error');
              playViaVideoJs(streamUrl, 'hls');
            }
          });
          return;
        }
      } catch (err) {
        console.error('[Player] ❌ Ошибка HLS.js', err);
        destroyHlsPlayer('exception');
        playViaVideoJs(streamUrl, 'hls');
        return;
      }
    } else {
      destroyHlsPlayer('protocol_change');
    }

    if (resolvedProtocol === 'mpegts' && window.mpegts && window.mpegts.isSupported()) {
      try {
        const mediaTarget = mediaEl;
        if (!mediaTarget) {
          console.error('[Player] ❌ Не удалось получить video элемент для MPEG-TS');
        } else {
          mpegtsPlayer = window.mpegts.createPlayer({
            type: 'mpegts',
            isLive: true,
            url: streamUrl
          }, {
            enableStashBuffer: false,
            stashInitialSize: 128
          });
          if (typeof mpegtsPlayer.attachMediaElement === 'function') {
            mpegtsPlayer.attachMediaElement(mediaTarget);
          } else if (typeof mpegtsPlayer.attachMedia === 'function') {
            mpegtsPlayer.attachMedia(mediaTarget);
          }
          mpegtsPlayer.load();
          mpegtsPlayer.play();
          show(videoContainer, true);
          console.log('[Player] ▶️ MPEG-TS поток запущен');
          // КРИТИЧНО: Отправляем player/progress для обновления информации на панели спикера
          // КРИТИЧНО: Не отправляем в preview режиме
          if (!preview && device_id && file) {
            socket.emit('player/progress', {
              device_id,
              type: 'streaming',
              file: file,
              currentTime: 0,
              duration: 0
            });
          }
          return;
        }
      } catch (err) {
        console.error('[Player] ❌ Ошибка запуска MPEG-TS', err);
        destroyMpegtsPlayer('exception');
      }
    } else {
      destroyMpegtsPlayer('protocol_change');
    }

    // КРИТИЧНО: DASH обрабатываем через dashjs напрямую (без videojs-contrib-dash из-за проблем совместимости)
    if (resolvedProtocol === 'dash' && window.dashjs && window.dashjs.MediaPlayer) {
      try {
        destroyDashPlayer('switch_to_dash');
        const mediaTarget = mediaEl;
        if (!mediaTarget) {
          console.error('[Player] ❌ Не удалось получить video элемент для DASH');
        } else {
          // Используем dashjs напрямую, без Video.js плагина
          // Правильный API для dashjs 4.x
          dashPlayer = window.dashjs.MediaPlayer().create();
          if (dashPlayer) {
            dashPlayer.initialize();
            dashPlayer.attachView(mediaTarget);
            dashPlayer.attachSource(streamUrl);
            
            // Обработка событий
            dashPlayer.on(window.dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
              mediaTarget.play().then(() => {
                show(videoContainer, true);
                console.log('[Player] ▶️ DASH поток запущен через dashjs');
                // КРИТИЧНО: Отправляем player/progress для обновления информации на панели спикера
                // КРИТИЧНО: Не отправляем в preview режиме
                if (!preview && device_id && file) {
                  socket.emit('player/progress', {
                    device_id,
                    type: 'streaming',
                    file: file,
                    currentTime: 0,
                    duration: 0
                  });
                }
              }).catch(err => {
                console.error('[Player] ❌ Ошибка запуска DASH', err);
              });
            });
            
            dashPlayer.on(window.dashjs.MediaPlayer.events.ERROR, (event) => {
              console.error('[Player] ❌ DASH error', event);
              destroyDashPlayer('dash_error');
              // Fallback: пробуем через Video.js VHS
              playViaVideoJs(streamUrl, 'dash');
            });
            
            return;
          }
        }
      } catch (err) {
        console.error('[Player] ❌ Ошибка запуска DASH', err);
        destroyDashPlayer('exception');
        // Fallback: пробуем через Video.js VHS
        playViaVideoJs(streamUrl, 'dash');
        return;
      }
    } else if (resolvedProtocol === 'dash') {
      // Fallback: если dashjs недоступен, пробуем через Video.js VHS
      console.warn('[Player] ⚠️ dashjs недоступен, используем Video.js VHS fallback');
      playViaVideoJs(streamUrl, 'dash');
      return;
    }

    playViaVideoJs(streamUrl, resolvedProtocol);
  }

  function videoPreviewSource(file, options = {}) {
    const params = new URLSearchParams();
    const seconds = Number.isFinite(options.seconds) ? options.seconds : 10;
    const start = Number.isFinite(options.start) ? options.start : 0;
    if (start > 0) params.set('start', start);
    params.set('seconds', Math.max(1, seconds));
    const query = params.toString();
    return `/api/files/preview/${encodeURIComponent(device_id)}/${encodeURIComponent(file)}${query ? `?${query}` : ''}`;
  }

  function enableSound(){
    if (forceMuted) return;
    if (soundUnlocked) {
      applyVolumeToPlayer('unlock');
      return;
    }
    soundUnlocked = true;
    try { localStorage.setItem('vc_sound', '1'); } catch {}
    if (!volumeStateSynced) {
      currentMuteState = false;
      currentVolumeLevel = 100;
      volumeStateSynced = true;
    }
    applyVolumeToPlayer('unlock');
    emitVolumeState('unlock');
    if (vjsPlayer) {
      try {
        vjsPlayer.play();
      } catch (err) {
      }
    }
    if (unmuteBtn) unmuteBtn.style.display = 'none';
  }

  // Обработчики unmute кнопки
  if (unmuteBtn && !forceMuted) {
    unmuteBtn.addEventListener('click', enableSound);
  }
  
  if (!forceMuted) {
    document.addEventListener('click', () => { if (!soundUnlocked) enableSound(); }, { once:true });
  }

  // Поиск заглушки
  async function resolvePlaceholder(force = false) {
    // КРИТИЧНО: При force=true генерируем timestamp для полного обхода кэша
    const cacheBuster = force ? `?t=${Date.now()}` : '';
    
    // Хелпер для fetch с timeout (защита от зависания)
    const fetchWithTimeout = (url, options, timeoutMs = 5000) => {
      return Promise.race([
        fetch(url, options),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
        )
      ]);
    };
    
    try {
      // API запрос тоже с cache-busting при force=true
      const apiUrl = `/api/devices/${encodeURIComponent(device_id)}/placeholder${cacheBuster}`;
      const apiRes = await fetchWithTimeout(apiUrl, {
        cache: force ? 'no-store' : 'default' // Запрещаем браузеру использовать HTTP кэш при force=true
      }, 5000);
      
      if (apiRes.ok) {
        const data = await apiRes.json();
        if (data.placeholder) {
          let url = `/content/${encodeURIComponent(device_id)}/${data.placeholder}`;
          
          // КРИТИЧНО: НЕ проверяем доступность файла через HEAD запрос - это блокирует загрузку
          // Если API вернул заглушку - сразу возвращаем URL
          // Видео/изображение плеер сам обработает ошибку загрузки, если файл недоступен
          // Это позволяет заглушке загружаться мгновенно без задержек
          return url + cacheBuster;
        }
      }
    } catch (e) {
      console.warn('[Player] ⚠️ Ошибка запроса placeholder API:', e);
    }
    
    // НОВОЕ: Fallback больше не используется с новой архитектурой
    // Заглушки управляются через БД (is_placeholder flag)
    // Если API не вернул заглушку - значит её нет, и не должно быть fallback поиска
    console.warn('[Player] ❌ Заглушка не установлена для устройства');
    console.log('[Player] 💡 Установите заглушку через админ панель: выберите файл → "Заглушка"');
    return null;
  }

  async function showPlaceholder(forceRefresh = false) {
    console.log('[Player] 🔍 showPlaceholder вызван, forceRefresh=', forceRefresh);
    console.log('[Player] 🔍 currentFileState:', currentFileState);
    
    // При force refresh сбрасываем текущую заглушку для принудительной перезагрузки
    if (forceRefresh) {
      currentPlaceholderSrc = null;
      console.log('[Player] 🔄 Force refresh: сбросили currentPlaceholderSrc');
    }
    
    const src = await resolvePlaceholder(forceRefresh);
    console.log('[Player] 🔍 Заглушка найдена:', src);
    console.log('[Player] 🔍 src type:', typeof src, 'length:', src?.length);
    
    if (!src) {
      console.warn('[Player] ⚠️ Заглушка не найдена!');
      
      // Показываем сообщение об отсутствии заглушки
      if (preview) {
        // В preview режиме показываем сообщение в PDF элементе
        pdf.srcdoc = `
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width,initial-scale=1">
              <style>
                body { 
                  margin:0; padding:0; 
                  display:flex; align-items:center; justify-content:center; 
                  min-height:100vh; 
                  background:#1e293b; color:#fff; 
                  font-family:sans-serif; text-align:center;
                }
                .message {
                  padding: 2rem;
                  max-width: 400px;
                }
                h2 { margin: 0 0 1rem 0; color: #fbbf24; }
                p { margin: 0.5rem 0; color: #cbd5e1; line-height: 1.5; }
              </style>
            </head>
            <body>
              <div class="message">
                <h2>⚠️ Заглушка не найдена</h2>
                <p>Для этого устройства не установлена заглушка.</p>
                <p>Загрузите видео файл и установите его как заглушку через кнопку "Заглушка".</p>
              </div>
            </body>
          </html>
        `;
        show(pdf);
      } else {
        // В обычном плеере просто скрываем все (включая оба буфера)
        [idle, v, img1, img2, pdf].forEach(el => el && el.classList.remove('visible'));
      }
      return;
    }
    
    // КРИТИЧНО: Если та же заглушка уже играет - не перезагружаем (кроме force refresh)
    if (!forceRefresh && currentPlaceholderSrc === src && vjsPlayer && !vjsPlayer.paused()) {
      console.log('[Player] ℹ️ Та же заглушка уже играет, пропускаем');
      return;
    }
    
    currentPlaceholderSrc = src;
    currentFileState = { type: 'placeholder', file: src, page: 1 }; // КРИТИЧНО: Сбрасываем состояние
    
    // КРИТИЧНО: Убираем query параметры перед проверкой типа файла
    // URL может содержать ?t=timestamp для cache busting
    const srcWithoutQuery = src.split('?')[0];
    const isImage = /\.(png|jpg|jpeg|gif|webp)$/i.test(srcWithoutQuery);
    console.log('[Player] 🔍 Тип заглушки:', isImage ? 'изображение' : 'видео', 'src:', src, 'srcWithoutQuery:', srcWithoutQuery);
    
    if (isImage) {
      console.log('[Player] 🖼️ Загрузка изображения заглушки');
      // КРИТИЧНО: Для изображения-заглушки НЕ трогаем Video.js вообще
      // Просто останавливаем воспроизведение если оно идет, и скрываем контейнер
      // НЕ вызываем src('') - это вызывает ошибку MEDIA_ERR_SRC_NOT_SUPPORTED
      if (vjsPlayer) {
        try {
          // Просто останавливаем воспроизведение, но НЕ очищаем src
          if (!vjsPlayer.paused()) {
            vjsPlayer.pause();
          }
          // НЕ вызываем vjsPlayer.src('') - это вызывает ошибку!
        } catch (e) {
          console.warn('[Player] ⚠️ Ошибка остановки Video.js при загрузке изображения-заглушки:', e);
        }
      }
      if (videoContainer) {
        // КРИТИЧНО: Просто скрываем videoContainer - этого достаточно
        // НЕ нужно очищать src Video.js - это вызывает ошибку
        videoContainer.classList.remove('visible', 'preloading');
        videoContainer.style.display = 'none';
      }
      if (pdf) {
        pdf.removeAttribute('src');
        pdf.srcdoc = '';
        pdf.classList.remove('visible', 'preloading');
      }
      
      // КРИТИЧНО: Очищаем ОБА буфера перед загрузкой новой заглушки
      // Иначе старый контент может остаться в одном из буферов
      if (img1) {
        img1.removeAttribute('src');
        img1.classList.remove('visible', 'preloading');
      }
      if (img2) {
        img2.removeAttribute('src');
        img2.classList.remove('visible', 'preloading');
      }
      currentImgBuffer = 1; // Сбрасываем буфер на начальный
      
      // КРИТИЧНО: Дожидаемся загрузки изображения ПЕРЕД показом!
      // Иначе показывается черный экран
      const tempImg = new Image();
      
      const showImagePlaceholder = () => {
        console.log('[Player] ✅ Заглушка-изображение загружена, показываем');
        // Используем img1 для заглушки (буфер 1)
        img1.src = src;
        show(img1);
      };
      
      tempImg.onload = () => {
        showImagePlaceholder();
      };
      
      tempImg.onerror = () => {
        console.error('[Player] ❌ Ошибка загрузки заглушки-изображения');
        // Показываем сообщение об ошибке
        if (preview) {
          pdf.srcdoc = `
            <!DOCTYPE html>
            <html>
              <head>
                <meta charset="utf-8">
                <style>
                  body { 
                    margin:0; padding:2rem; 
                    display:flex; align-items:center; justify-content:center; 
                    min-height:100vh; 
                    background:#1e293b; color:#fff; 
                    font-family:sans-serif; text-align:center;
                  }
                  h2 { color: #fbbf24; margin-bottom: 1rem; }
                  p { color: #cbd5e1; line-height: 1.5; }
                </style>
              </head>
              <body>
                <div>
                  <h2>⚠️ Ошибка загрузки заглушки</h2>
                  <p>Изображение не найдено или повреждено</p>
                </div>
              </body>
            </html>
          `;
          show(pdf);
        }
      };
      
      tempImg.src = src;
      
      // КРИТИЧНО: Если изображение уже загружено (например из кэша),
      // событие onload НЕ сработает! Проверяем и показываем сразу
      if (tempImg.complete && tempImg.naturalWidth > 0) {
        console.log('[Player] ⚡ Заглушка-изображение из кэша, показываем сразу');
        showImagePlaceholder();
      }
    } else {
      // Видео заглушка через Video.js
      console.log('[Player] 🎬 Загрузка видео заглушки через Video.js');
      console.log('[Player] 🔍 vjsPlayer существует:', !!vjsPlayer);
      
      // КРИТИЧНО: Очищаем изображения-заглушки перед загрузкой видео-заглушки
      if (img1) {
        img1.removeAttribute('src');
        img1.classList.remove('visible', 'preloading');
      }
      if (img2) {
        img2.removeAttribute('src');
        img2.classList.remove('visible', 'preloading');
      }
      if (pdf) {
        pdf.removeAttribute('src');
        pdf.srcdoc = '';
        pdf.classList.remove('visible', 'preloading');
      }
      
      if (vjsPlayer) {
        // КРИТИЧНО: НЕ проверяем доступность файла - это блокирует загрузку заглушки
        // Если API вернул заглушку - сразу устанавливаем src
        // Video.js сам обработает ошибку загрузки, если файл недоступен
        console.log('[Player] 🔍 Установка параметров Video.js...');
        
        // КРИТИЧНО: Останавливаем и очищаем предыдущее видео перед загрузкой заглушки
        try {
          vjsPlayer.pause();
          vjsPlayer.currentTime(0);
          // КРИТИЧНО: НЕ очищаем src здесь - это может вызвать ошибку если элемент скрыт
          // src будет заменен при установке нового
        } catch (e) {
          console.warn('[Player] ⚠️ Ошибка очистки предыдущего видео:', e);
        }
        
        vjsPlayer.loop(true);
        vjsPlayer.muted(true);
        vjsPlayer.volume(0);
        
        // КРИТИЧНО: Скрываем контролы
        hideVideoJsControls();
        
        // КРИТИЧНО: videoContainer ДОЛЖЕН быть видим ПЕРЕД установкой src
        // Video.js не может загрузить видео в скрытый элемент (display: none)
        videoContainer.style.display = 'block';
        // НЕ показываем через show() пока - только делаем видимым для загрузки
        videoContainer.classList.remove('visible', 'preloading');
        
        // КРИТИЧНО: Даем браузеру время обновить DOM после изменения display
        // Это необходимо для правильной инициализации Video.js
        // Используем двойной requestAnimationFrame + задержка для гарантии обновления DOM
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            // КРИТИЧНО: Задержка для гарантии что DOM полностью обновлен
            setTimeout(() => {
              console.log('[Player] 🔍 Установка src:', src);
              
              // КРИТИЧНО: Проверяем что videoContainer готов для загрузки видео
              // Video.js может загружать видео даже если opacity=0 (для fade-in анимации)
              // Главное - элемент должен быть в DOM с размерами и display=block
              const trySetSrc = (attempt = 1) => {
                const computedStyle = window.getComputedStyle(videoContainer);
                const rect = videoContainer.getBoundingClientRect();
                // Проверяем только критичные параметры: display, visibility и размеры
                // opacity=0 - это нормально, Video.js может работать с прозрачными элементами
                const isReady = computedStyle.display !== 'none' && 
                               computedStyle.visibility !== 'hidden' && 
                               rect.width > 0 && 
                               rect.height > 0;
                
                if (!isReady) {
                  // Принудительно устанавливаем видимость
                  videoContainer.style.display = 'block';
                  videoContainer.style.visibility = 'visible';
                  // Даем время на обновление DOM и пробуем снова (максимум 2 попытки)
                  if (attempt < 2) {
                    setTimeout(() => trySetSrc(attempt + 1), 100);
                    return;
                  }
                }
                
                // Устанавливаем src - Video.js сам обработает загрузку
                // opacity может быть 0, это нормально для fade-in
                vjsPlayer.src({ src: src, type: 'video/mp4' });
                vjsPlayer.load(); // КРИТИЧНО: Явно вызываем load() после установки src
              };
              
              trySetSrc();
              
              // Ждем готовности метаданных
              vjsPlayer.one('loadedmetadata', () => {
                console.log('[Player] 📊 Заглушка: метаданные готовы, показываем с fade in');
                hideVideoJsControls();
                
                // Показываем с плавным появлением
                show(videoContainer);
                
                // Запускаем воспроизведение
                vjsPlayer.play().then(() => {
                  console.log('[Player] ✅ Заглушка запущена успешно!');
                }).catch(err => {
                  console.error('[Player] ❌ Ошибка запуска заглушки:', err);
                });
              });
              
              // КРИТИЧНО: Обработка ошибок загрузки заглушки
              vjsPlayer.one('error', () => {
                const error = vjsPlayer.error();
                console.error('[Player] ❌ Ошибка загрузки заглушки:', error);
                // Скрываем videoContainer при ошибке
                videoContainer.style.display = 'none';
                videoContainer.classList.remove('visible', 'preloading');
              });
            }, 50); // Небольшая задержка для гарантии обновления DOM
          });
        });
      } else {
        console.error('[Player] ❌ vjsPlayer не инициализирован!');
      }
    }
  }

  // Предзагрузка всех слайдов PPTX/PDF в кэш
  async function preloadAllSlides(file, type) {
    try {
      console.log(`[Player] 🔄 Предзагрузка слайдов: ${file}`);
      
      // Получаем количество слайдов через API (используем query параметр для поддержки пробелов в именах)
      const response = await fetch(`/api/devices/${encodeURIComponent(device_id)}/slides-count?file=${encodeURIComponent(file)}&type=${type}`);
      if (!response.ok) {
        console.warn('[Player] ⚠️ Не удалось получить количество слайдов');
        return;
      }
      
      const data = await response.json();
      const count = data.count || 0;
      
      if (count === 0) {
        console.warn('[Player] ⚠️ Нет слайдов для предзагрузки');
        return;
      }
      
      console.log(`[Player] 📊 Найдено слайдов: ${count}. Начинаем предзагрузку...`);
      
      // Создаем массив Image объектов
      const images = [];
      const urlType = type === 'pdf' ? 'page' : 'slide';
      
      // Предзагружаем все слайды параллельно
      const preloadPromises = [];
      for (let i = 1; i <= count; i++) {
        const imageUrl = `/api/devices/${encodeURIComponent(device_id)}/converted/${encodeURIComponent(file)}/${urlType}/${i}`;
        const imgObj = new Image();
        images[i - 1] = imgObj;
        
        const promise = new Promise((resolve, reject) => {
          imgObj.onload = () => {
            console.log(`[Player] ✅ Слайд ${i}/${count} загружен`);
            resolve();
          };
          imgObj.onerror = () => {
            console.warn(`[Player] ⚠️ Ошибка загрузки слайда ${i}/${count}`);
            resolve(); // Не прерываем весь процесс из-за одного слайда
          };
          imgObj.src = imageUrl;
        });
        
        preloadPromises.push(promise);
      }
      
      // Ждем загрузки всех слайдов
      await Promise.all(preloadPromises);
      
      // Сохраняем в кэш
      slidesCache[file] = { count, images, type };
      console.log(`[Player] 🎉 Все слайды загружены в кэш: ${file} (${count} слайдов)`);
      
    } catch (error) {
      console.error('[Player] ❌ Ошибка предзагрузки слайдов:', error);
    }
  }

  // Предзагрузка всех изображений из папки в кэш
  async function preloadAllFolderImages(folderName) {
    try {
      console.log(`[Player] 🔄 Предзагрузка изображений из папки: ${folderName}`);
      
      // Получаем список изображений через API
      const response = await fetch(`/api/devices/${encodeURIComponent(device_id)}/folder/${encodeURIComponent(folderName)}/images`);
      if (!response.ok) {
        console.warn('[Player] ⚠️ Не удалось получить список изображений из папки');
        return;
      }
      
      const data = await response.json();
      const imageList = data.images || [];
      const count = imageList.length;
      
      if (count === 0) {
        console.warn('[Player] ⚠️ Нет изображений для предзагрузки');
        return;
      }
      
      console.log(`[Player] 📊 Найдено изображений: ${count}. Начинаем предзагрузку...`);
      
      // Создаем массив Image объектов
      const images = [];
      
      // Предзагружаем все изображения параллельно
      const preloadPromises = [];
      for (let i = 1; i <= count; i++) {
        const imageUrl = `/api/devices/${encodeURIComponent(device_id)}/folder/${encodeURIComponent(folderName)}/image/${i}`;
        const imgObj = new Image();
        images[i - 1] = imgObj;
        
        const promise = new Promise((resolve, reject) => {
          imgObj.onload = () => {
            console.log(`[Player] ✅ Изображение ${i}/${count} загружено`);
            resolve();
          };
          imgObj.onerror = () => {
            console.warn(`[Player] ⚠️ Ошибка загрузки изображения ${i}/${count}`);
            resolve(); // Не прерываем весь процесс из-за одного изображения
          };
          imgObj.src = imageUrl;
        });
        
        preloadPromises.push(promise);
      }
      
      // Ждем загрузки всех изображений
      await Promise.all(preloadPromises);
      
      // Сохраняем в кэш
      slidesCache[folderName] = { count, images, type: 'folder' };
      console.log(`[Player] 🎉 Все изображения загружены в кэш: ${folderName} (${count} изображений)`);
      
    } catch (error) {
      console.error('[Player] ❌ Ошибка предзагрузки изображений из папки:', error);
    }
  }

  // Показать изображение из папки
  function showFolderImage(folderName, num, isFromPlaceholder = false) {
    // КРИТИЧНО: Полностью останавливаем и скрываем Video.js плеер
    if (vjsPlayer) {
      try {
        vjsPlayer.pause();
        vjsPlayer.currentTime(0);
        // КРИТИЧНО: НЕ очищаем src здесь - Video.js сам заменит src при установке нового
        // Очистка src('') может вызвать ошибку если элемент скрыт
      } catch (e) {
        console.warn('[Player] ⚠️ Ошибка очистки видео:', e);
      }
      // Скрываем все контролы Video.js
      hideVideoJsControls();
    }
    pdf.removeAttribute('src');
    
    // Убеждаемся что videoContainer полностью скрыт
    videoContainer.classList.remove('visible', 'preloading');
    videoContainer.style.display = 'none';
    
    const { current, next } = getImageBuffers();
    
    // КРИТИЧНО: Определяем, это первый показ папки на основе переданного флага
    // Черный экран нужен только если переходим с заглушки/STOP/null или с видео
    const isFirstShow = isFromPlaceholder;
    console.log(`[Player] 🔍 showFolderImage: isFirstShow=${isFirstShow}, isFromPlaceholder=${isFromPlaceholder}`);
    
    // Проверяем кэш
    if (slidesCache[folderName] && slidesCache[folderName].images) {
      const cached = slidesCache[folderName];
      const index = Math.max(0, Math.min(num - 1, cached.count - 1));
      const cachedImage = cached.images[index];
      
      if (cachedImage && cachedImage.complete && cachedImage.naturalWidth > 0) {
        console.log(`[Player] ⚡ Изображение ${num} из кэша (двойная буферизация)`);
        
        // Загружаем в следующий буфер
        next.src = cachedImage.src;
        
        // Первый показ - сразу черный, потом fade in; переключение - мгновенно
        // Мгновенно показываем изображение
        show(next);
        
      // Переключаем активный буфер
      currentImgBuffer = currentImgBuffer === 1 ? 2 : 1;
      console.log(`[Player] 🔄 Переключен буфер на: ${currentImgBuffer}`);
      
      // Отправляем информацию о текущей странице на сервер для обновления спикер панели
      // Используем player/progress с параметром page (как Android)
      if (device_id && !preview && socket && socket.connected) {
        socket.emit('player/progress', {
          device_id,
          type: 'folder',
          file: folderName,
          currentTime: num,
          duration: 0,
          page: num
        });
      }
      return;
    }
  }
  
  // Fallback: загружаем через API если нет в кэше
  console.log(`[Player] 🌐 Изображение ${num} загружается через API (двойная буферизация)`);
  const imageUrl = `/api/devices/${encodeURIComponent(device_id)}/folder/${encodeURIComponent(folderName)}/image/${num}`;
  
  // Предзагружаем в следующий буфер
  const tempImg = new Image();
  tempImg.onload = () => {
    console.log(`[Player] ✅ Изображение ${num} загружено в буфер ${currentImgBuffer === 1 ? 2 : 1}`);
    
    // Устанавливаем в следующий буфер
    next.src = imageUrl;
    
    // Мгновенно показываем изображение
    show(next);
    
    // Переключаем активный буфер
    currentImgBuffer = currentImgBuffer === 1 ? 2 : 1;
    console.log(`[Player] 🔄 Переключен буфер на: ${currentImgBuffer}`);
    
    // Отправляем информацию о текущей странице на сервер для обновления спикер панели
    // Используем player/progress с параметром page (как Android)
    if (device_id && !preview && socket && socket.connected) {
      socket.emit('player/progress', {
        device_id,
        type: 'folder',
        file: folderName,
        currentTime: num,
        duration: 0,
        page: num
      });
    }
  };
  tempImg.onerror = () => {
    console.error(`[Player] ❌ Ошибка загрузки изображения ${num}`);
    next.src = imageUrl;
    show(next);
    currentImgBuffer = currentImgBuffer === 1 ? 2 : 1;
    
    // Отправляем информацию о текущей странице даже при ошибке
    if (device_id && !preview && socket && socket.connected) {
      socket.emit('player/progress', {
        device_id,
        type: 'folder',
        file: folderName,
        currentTime: num,
        duration: 0,
        page: num
      });
    }
  };
  tempImg.src = imageUrl;
}

  function showConvertedPage(file, type, num, isFromPlaceholder = false) {
    // КРИТИЧНО: Полностью останавливаем и скрываем Video.js плеер
    if (vjsPlayer) {
      try {
        vjsPlayer.pause();
        vjsPlayer.currentTime(0);
        // КРИТИЧНО: НЕ очищаем src здесь - Video.js сам заменит src при установке нового
        // Очистка src('') может вызвать ошибку если элемент скрыт
      } catch (e) {
        console.warn('[Player] ⚠️ Ошибка очистки видео:', e);
      }
      // Скрываем все контролы Video.js
      hideVideoJsControls();
    }
    pdf.removeAttribute('src');
    
    // Убеждаемся что videoContainer полностью скрыт
    videoContainer.classList.remove('visible', 'preloading');
    videoContainer.style.display = 'none';
    
    const { current, next } = getImageBuffers();
    
    // КРИТИЧНО: Определяем, это первый показ презентации на основе переданного флага
    // Черный экран нужен только если переходим с заглушки/STOP/null или с видео
    const isFirstShow = isFromPlaceholder;
    console.log(`[Player] 🔍 showConvertedPage: isFirstShow=${isFirstShow}, isFromPlaceholder=${isFromPlaceholder}`);
    
    // Проверяем кэш
    if (slidesCache[file] && slidesCache[file].images) {
      const cached = slidesCache[file];
      const index = Math.max(0, Math.min(num - 1, cached.count - 1));
      const cachedImage = cached.images[index];
      
      if (cachedImage && cachedImage.complete && cachedImage.naturalWidth > 0) {
        console.log(`[Player] ⚡ Слайд ${num} из кэша (двойная буферизация)`);
        
        // Загружаем в следующий буфер
        next.src = cachedImage.src;
        
        // Мгновенно показываем слайд
        show(next);
        
      // Переключаем активный буфер
      currentImgBuffer = currentImgBuffer === 1 ? 2 : 1;
      console.log(`[Player] 🔄 Переключен буфер на: ${currentImgBuffer}`);
      
      // Отправляем информацию о текущей странице на сервер для обновления спикер панели
      // Используем player/progress с параметром page (как Android)
      if (device_id && !preview && socket && socket.connected) {
        socket.emit('player/progress', {
          device_id,
          type: type === 'page' ? 'pdf' : 'pptx',
          file: file,
          currentTime: num,
          duration: 0,
          page: num
        });
      }
      return;
    }
  }
  
  // Fallback: загружаем через API если нет в кэше
  console.log(`[Player] 🌐 Слайд ${num} загружается через API (двойная буферизация)`);
  const imageUrl = `/api/devices/${encodeURIComponent(device_id)}/converted/${encodeURIComponent(file)}/${type}/${num}`;
  
  // Предзагружаем в следующий буфер
  const tempImg = new Image();
  tempImg.onload = () => {
    console.log(`[Player] ✅ Слайд ${num} загружен в буфер ${currentImgBuffer === 1 ? 2 : 1}`);
    
    // Устанавливаем в следующий буфер
    next.src = imageUrl;
    
    // Мгновенно показываем слайд
    show(next);
    
    // Переключаем активный буфер
    currentImgBuffer = currentImgBuffer === 1 ? 2 : 1;
    console.log(`[Player] 🔄 Переключен буфер на: ${currentImgBuffer}`);
    
    // Отправляем информацию о текущей странице на сервер для обновления спикер панели
    // Используем player/progress с параметром page (как Android)
    if (device_id && !preview && socket && socket.connected) {
      socket.emit('player/progress', {
        device_id,
        type: type === 'page' ? 'pdf' : 'pptx',
        file: file,
        currentTime: num,
        duration: 0,
        page: num
      });
    }
  };
  tempImg.onerror = () => {
    console.error(`[Player] ❌ Ошибка загрузки слайда ${num}`);
    next.src = imageUrl;
    show(next, isFirstShow ? false : true);
    currentImgBuffer = currentImgBuffer === 1 ? 2 : 1;
    
    // Отправляем информацию о текущей странице даже при ошибке
    if (device_id && !preview && socket && socket.connected) {
      socket.emit('player/progress', {
        device_id,
        type: type === 'page' ? 'pdf' : 'pptx',
        file: file,
        currentTime: num,
        duration: 0,
        page: num
      });
    }
  };
  tempImg.src = imageUrl;
}

  // WebSocket обработчики
  socket.on('player/play', ({ type, file, page, stream_url, stream_protocol }) => {
    console.log('[Player] 📡 player/play:', { type, file, page, stream_url });
    
    // КРИТИЧНО: СРАЗУ скрываем ВСЕ элементы кроме того, который будет показан
    // Это гарантирует что при нажатии Play виден только новый контент
    [idle, videoContainer, img1, img2, pdf].forEach(e => {
      if (e) {
        e.classList.remove('visible', 'preloading');
      }
    });
    
    // КРИТИЧНО: Сохраняем предыдущий тип для определения типа перехода
    const prevFileStateType = currentFileState.type;
    const wasPlaceholder = prevFileStateType === 'placeholder';
    
    // КРИТИЧНО: Останавливаем заглушку при любой команде от спикера
    if (wasPlaceholder) {
      console.log('[Player] 🛑 Останавливаем заглушку, воспроизводим контент');
      
      // Устанавливаем флаг переключения (сбросим после загрузки контента)
      isSwitchingFromPlaceholder = true;
      
      // Временно обновляем состояние, чтобы обработчики событий знали что контент меняется
      // Полное обновление будет в соответствующих блоках ниже
      if (type === 'video' && file) {
        currentFileState = { type: 'video', file, page: 1 };
      } else if (type === 'image' && file) {
        currentFileState = { type: 'image', file, page: 1 };
      } else if (type === 'pdf' && file) {
        currentFileState = { type: 'pdf', file, page: page || 1 };
      } else if (type === 'pptx' && file) {
        currentFileState = { type: 'pptx', file, page: page || 1 };
      } else if (type === 'folder' && file) {
        currentFileState = { type: 'folder', file: file.replace(/\.zip$/i, ''), page: page || 1 };
      }
      
      // Останавливаем заглушку
      if (vjsPlayer && !vjsPlayer.paused()) {
        vjsPlayer.pause();
      }
      // КРИТИЧНО: Очищаем src у обоих буферов от заглушки
      // (универсальная очистка выше уже скрыла все элементы)
      if (img1) {
        img1.removeAttribute('src');
      }
      if (img2) {
        img2.removeAttribute('src');
      }
      
      // НЕ сбрасываем флаг здесь - он сбросится после загрузки контента в соответствующих блоках
    }
    
    if (type === 'streaming') {
      handleStreamingPlayback(stream_url, file, stream_protocol);
      return;
    }
    destroyMpegtsPlayer('player_play_non_stream');
    destroyHlsPlayer('player_play_non_stream');
    destroyDashPlayer('player_play_non_stream');
    
    if (type === 'video') {
      // КРИТИЧНО: Полностью очищаем все буферы изображений при переключении на видео
      clearAllBuffers();
      
      if (!file && vjsPlayer) {
        // Resume текущего видео (нет файла = продолжить с паузы)
        console.log('[Player] ⏯️ Resume с текущей позиции');
        currentFileState = { type: 'video', file: currentVideoFile, page: 1 };
        
        // КРИТИЧНО: Восстанавливаем позицию если была сохранена (как в Android)
        if (savedVideoPosition > 0) {
          vjsPlayer.currentTime(savedVideoPosition / 1000);
          savedVideoPosition = 0; // Сбрасываем после использования
        }
        
        applyVolumeToPlayer('resume_video');
        
        vjsPlayer.play().then(() => {
          console.log('[Player] ✅ Resume успешен');
        }).catch(err => {
          console.error('[Player] ❌ Ошибка resume:', err);
        });
        return;
      }
      
      if (file) {
        const fileUrl = content(file);
        
        // КРИТИЧНО: Проверяем тот же ли файл воспроизводится (используем currentVideoFile как в Android)
        const isSameFile = currentVideoFile === file;
        
        console.log('[Player] 🔍 Проверка файла:', { file, currentVideoFile, isSameFile });
        
        if (isSameFile && vjsPlayer) {
          // Тот же файл - продолжаем с сохраненной позиции (без перезагрузки, как в Android)
          console.log('[Player] ⏯️ Тот же файл, продолжаем с позиции:', savedVideoPosition, 'ms');
          currentFileState = { type: 'video', file, page: 1 };
          
          // КРИТИЧНО: Восстанавливаем позицию если была сохранена (как в Android)
          if (savedVideoPosition > 0) {
            vjsPlayer.currentTime(savedVideoPosition / 1000);
            savedVideoPosition = 0; // Сбрасываем после использования
          }
          
          applyVolumeToPlayer('resume_video_same_file');
          
          // Показываем videoContainer если он скрыт
          if (!videoContainer.classList.contains('visible')) {
            videoContainer.style.display = ''; // Сбрасываем display:none
            show(videoContainer);
          }
          
          if (vjsPlayer.paused()) {
            vjsPlayer.play().then(() => {
              console.log('[Player] ✅ Resume с позиции:', vjsPlayer.currentTime());
            }).catch(err => {
              console.error('[Player] ❌ Ошибка resume:', err);
            });
          }
          return;
        }
        
        // Новый файл - загружаем с начала
        console.log('[Player] 🎬 Загрузка НОВОГО видео:', fileUrl);
        currentFileState = { type: 'video', file, page: 1 };
        currentVideoFile = file; // Сохраняем текущий файл (как в Android)
        savedVideoPosition = 0; // Сбрасываем позицию для нового файла
        
        if (vjsPlayer) {
          // КРИТИЧНО: Останавливаем и очищаем предыдущее видео перед загрузкой нового
          try {
            vjsPlayer.pause();
            vjsPlayer.currentTime(0);
            // КРИТИЧНО: НЕ очищаем src здесь - Video.js сам заменит src при установке нового
            // Очистка src('') может вызвать ошибку если элемент скрыт
          } catch (e) {
            console.warn('[Player] ⚠️ Ошибка очистки предыдущего видео:', e);
          }
          
          vjsPlayer.loop(false);
          applyVolumeToPlayer('play_video');
          
          // КРИТИЧНО: Скрываем big play button ДО установки src
          hideVideoJsControls();
          
          // КРИТИЧНО: videoContainer ДОЛЖЕН быть видим ПЕРЕД установкой src
          // Video.js не может загрузить видео в скрытый элемент (display: none)
          videoContainer.style.display = 'block';
          // НЕ показываем через show() пока - только делаем видимым для загрузки
          videoContainer.classList.remove('visible', 'preloading');
          
          // КРИТИЧНО: Даем браузеру время обновить DOM после изменения display
          // Это необходимо для правильной инициализации Video.js
          // Используем двойной requestAnimationFrame + небольшая задержка для гарантии обновления DOM
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              // КРИТИЧНО: Небольшая задержка для гарантии что DOM полностью обновлен
              setTimeout(() => {
                // КРИТИЧНО: Проверяем что videoContainer действительно видим перед установкой src
                const computedStyle = window.getComputedStyle(videoContainer);
                if (computedStyle.display === 'none') {
                  console.warn('[Player] ⚠️ videoContainer все еще скрыт, устанавливаем display:block');
                  videoContainer.style.display = 'block';
                  // Даем еще немного времени
                  setTimeout(() => {
                    vjsPlayer.src({ src: fileUrl, type: 'video/mp4' });
                    vjsPlayer.load(); // КРИТИЧНО: Явно вызываем load() после установки src
                  }, 50);
                } else {
                  vjsPlayer.src({ src: fileUrl, type: 'video/mp4' });
                  vjsPlayer.load(); // КРИТИЧНО: Явно вызываем load() после установки src
                }
                
                // КРИТИЧНО: Функция для запуска воспроизведения (чтобы не дублировать код)
                let playbackStarted = false;
                const startPlayback = () => {
                  if (playbackStarted) return; // Предотвращаем двойной запуск
                  playbackStarted = true;
                  
                  // Сбрасываем флаг переключения - контент загрузился
                  isSwitchingFromPlaceholder = false;
                  hideVideoJsControls();
                  
                  // Мгновенно показываем видео
                  show(videoContainer);
                  
                  console.log('[Player] ✅ Видео показано');
                  
                  // Запускаем воспроизведение
                  vjsPlayer.play().then(() => {
                    console.log('[Player] ✅ Видео запущено');
                    // Проверяем буфер сразу после запуска
                    setTimeout(() => {
                      const bufferedAfter = vjsPlayer.buffered();
                      const durationAfter = vjsPlayer.duration();
                      if (bufferedAfter.length > 0) {
                        const bufferedEnd = bufferedAfter.end(bufferedAfter.length - 1);
                        const percent = durationAfter > 0 ? Math.round((bufferedEnd / durationAfter) * 100) : 0;
                        console.log(`[Player] 📊 Буфер после запуска: ${percent}% (${bufferedEnd.toFixed(2)}s / ${durationAfter > 0 ? durationAfter.toFixed(2) : '?'}s)`);
                      } else {
                        console.warn(`[Player] ⚠️ Буфер пуст после запуска, duration=${durationAfter > 0 ? durationAfter.toFixed(2) : '?'}s`);
                      }
                    }, 500);
                  }).catch(err => {
                    console.error('[Player] ❌ Ошибка воспроизведения:', err);
                    hideVideoJsControls();
                  });
                };
                
                // Ждем готовности метаданных
                vjsPlayer.one('loadedmetadata', () => {
                  const duration = vjsPlayer.duration();
                  const buffered = vjsPlayer.buffered();
                  const bufferedInfo = buffered.length > 0 
                    ? `${buffered.end(buffered.length - 1).toFixed(2)}s` 
                    : '0s';
                  console.log(`[Player] 📊 Метаданные загружены: duration=${duration > 0 ? duration.toFixed(2) : '?'}s, buffered=${bufferedInfo}`);
                  
                  // КРИТИЧНО: Если duration известна (> 0), запускаем сразу
                  // Если duration неизвестна (0 или NaN), ждем canplay
                  if (duration > 0 && Number.isFinite(duration)) {
                    console.log('[Player] ⚡ Duration известна, запускаем сразу');
                    startPlayback();
                  } else {
                    console.log('[Player] ⏳ Duration неизвестна, ждем canplay для начала воспроизведения');
                    // Для файлов без duration ждем canplay (достаточно данных для воспроизведения)
                    vjsPlayer.one('canplay', () => {
                      const bufferedOnCanplay = vjsPlayer.buffered();
                      const bufferedInfoCanplay = bufferedOnCanplay.length > 0 
                        ? `${bufferedOnCanplay.end(bufferedOnCanplay.length - 1).toFixed(2)}s` 
                        : '0s';
                      console.log(`[Player] ⚡ canplay - достаточно данных для воспроизведения (buffered=${bufferedInfoCanplay})`);
                      startPlayback();
                    });
                  }
                });
                
                // КРИТИЧНО: Обработка ошибок загрузки
                vjsPlayer.one('error', () => {
                  const error = vjsPlayer.error();
                  console.error('[Player] ❌ Ошибка загрузки видео:', error);
                  // Скрываем videoContainer при ошибке
                  videoContainer.style.display = 'none';
                  videoContainer.classList.remove('visible', 'preloading');
                });
              }, 50); // Небольшая задержка для гарантии обновления DOM
            });
          });
        }
      }
    } else if (type === 'image' && file) {
      currentFileState = { type: 'image', file, page: 1 };
      
      // Останавливаем отправку прогресса
      stopProgressInterval();
      if (emitProgressStop) {
        emitProgressStop();
      }
      
      // КРИТИЧНО: Сбрасываем currentVideoFile чтобы при возврате к видео загружалось заново (как в Android)
      currentVideoFile = null;
      savedVideoPosition = 0;
      
      // Останавливаем видео (универсальная очистка уже скрыла все элементы)
      if (vjsPlayer) {
        try {
          vjsPlayer.pause();
          vjsPlayer.currentTime(0);
          // КРИТИЧНО: НЕ очищаем src здесь - Video.js сам заменит src при установке нового
          // Очистка src('') может вызвать ошибку если элемент скрыт
        } catch (e) {
          console.warn('[Player] ⚠️ Ошибка очистки видео:', e);
        }
      }
      if (videoContainer) {
        videoContainer.style.display = 'none';
      }
      
      // КРИТИЧНО: Для первого изображения используем img1
      // Это гарантирует что первое изображение всегда идет в img1
      if (currentImgBuffer !== 1) {
        currentImgBuffer = 1;
      }
      const { current } = getImageBuffers(); // current = img1
      
      const imageUrl = content(file);
      
      // Предзагружаем изображение
      const tempImg = new Image();
      tempImg.onload = () => {
        console.log('[Player] ✅ Изображение загружено, показываем');
        // Сбрасываем флаг переключения - контент загрузился
        isSwitchingFromPlaceholder = false;
        
        // Устанавливаем src в img1
        current.src = imageUrl;
        
        // Мгновенно показываем изображение
        show(current);
        
        // Переключаем буфер на 2 для следующего изображения
        currentImgBuffer = 2;
        console.log('[Player] ✅ Изображение показано в img1, следующий буфер: 2');
        
        // КРИТИЧНО: Отправляем player/progress для обновления информации на панели спикера
        if (device_id && !preview && socket && socket.connected) {
          socket.emit('player/progress', {
            device_id,
            type: 'image',
            file: file,
            currentTime: 0,
            duration: 0,
            page: 1
          });
        }
      };
      tempImg.onerror = () => {
        console.warn('[Player] ⚠️ Ошибка загрузки изображения');
        // Показываем даже при ошибке
        current.src = imageUrl;
        show(current);
        currentImgBuffer = 2;
        
        // КРИТИЧНО: Отправляем player/progress даже при ошибке
        if (device_id && !preview && socket && socket.connected) {
          socket.emit('player/progress', {
            device_id,
            type: 'image',
            file: file,
            currentTime: 0,
            duration: 0,
            page: 1
          });
        }
      };
      tempImg.src = imageUrl;
    } else if (type === 'pdf' && file) {
      const pageNum = page || 1;
      // Сохраняем предыдущий тип для передачи в функцию
      const prevType = currentFileState.type;
      // Обновляем состояние ПЕРЕД вызовом (для внутренней логики функции)
      currentFileState = { type: 'pdf', file, page: pageNum };
      
      // Останавливаем отправку прогресса
      stopProgressInterval();
      if (emitProgressStop) {
        emitProgressStop();
      }
      
      // КРИТИЧНО: Сбрасываем currentVideoFile для корректного возврата к видео (как в Android)
      currentVideoFile = null;
      savedVideoPosition = 0;
      
      // Передаем информацию о том, был ли переход с заглушки/STOP/видео
      showConvertedPage(file, 'page', pageNum, wasPlaceholder || !prevType || prevType === 'video');
      // Сбрасываем флаг переключения
      isSwitchingFromPlaceholder = false;
      
      // КРИТИЧНО: Предзагружаем ВСЕ страницы в кэш для мгновенного переключения
      if (!slidesCache[file]) {
        preloadAllSlides(file, 'pdf');
      }
      
      // КРИТИЧНО: Отправляем информацию о текущей странице на сервер сразу после запуска
      // Используем player/progress с параметром page (как Android)
      if (device_id && !preview && socket && socket.connected) {
      socket.emit('player/progress', {
        device_id,
        type: 'pdf',
        file: file,
        currentTime: pageNum,
        duration: slidesCache[file]?.count || 0,
        page: pageNum
      });
      }
    } else if (type === 'pptx' && file) {
      const slideNum = page || 1;
      // Сохраняем предыдущий тип для передачи в функцию
      const prevType = currentFileState.type;
      // Обновляем состояние ПЕРЕД вызовом (для внутренней логики функции)
      currentFileState = { type: 'pptx', file, page: slideNum };
      
      // Останавливаем отправку прогресса
      stopProgressInterval();
      if (emitProgressStop) {
        emitProgressStop();
      }
      
      // КРИТИЧНО: Сбрасываем currentVideoFile для корректного возврата к видео (как в Android)
      currentVideoFile = null;
      savedVideoPosition = 0;
      
      // Передаем информацию о том, был ли переход с заглушки/STOP/видео
      showConvertedPage(file, 'slide', slideNum, wasPlaceholder || !prevType || prevType === 'video');
      // Сбрасываем флаг переключения
      isSwitchingFromPlaceholder = false;
      
      // КРИТИЧНО: Предзагружаем ВСЕ слайды в кэш для мгновенного переключения
      if (!slidesCache[file]) {
        preloadAllSlides(file, 'pptx');
      }
      
      // КРИТИЧНО: Отправляем информацию о текущей странице на сервер сразу после запуска
      // Используем player/progress с параметром page (как Android)
      if (device_id && !preview && socket && socket.connected) {
      socket.emit('player/progress', {
        device_id,
        type: 'pptx',
        file: file,
        currentTime: slideNum,
        duration: slidesCache[file]?.count || 0,
        page: slideNum
      });
      }
    } else if (type === 'folder' && file) {
      // Папка с изображениями
      const imageNum = page || 1;
      const folderName = file.replace(/\.zip$/i, ''); // Убираем .zip если есть
      // Сохраняем предыдущий тип для передачи в функцию
      const prevType = currentFileState.type;
      // Обновляем состояние ПЕРЕД вызовом (для внутренней логики функции)
      currentFileState = { type: 'folder', file: folderName, page: imageNum };
      
      // Останавливаем отправку прогресса
      stopProgressInterval();
      if (emitProgressStop) {
        emitProgressStop();
      }
      
      // КРИТИЧНО: Сбрасываем currentVideoFile для корректного возврата к видео (как в Android)
      currentVideoFile = null;
      savedVideoPosition = 0;
      
      // Передаем информацию о том, был ли переход с заглушки/STOP/видео
      showFolderImage(folderName, imageNum, wasPlaceholder || !prevType || prevType === 'video');
      // Сбрасываем флаг переключения
      isSwitchingFromPlaceholder = false;
      
      // КРИТИЧНО: Предзагружаем ВСЕ изображения в кэш для мгновенного переключения
      if (!slidesCache[folderName]) {
        preloadAllFolderImages(folderName);
      }
      
      // КРИТИЧНО: Отправляем информацию о текущей странице на сервер сразу после запуска
      // Используем player/progress с параметром page (как Android)
      if (device_id && !preview && socket && socket.connected) {
      const totalImages = slidesCache[folderName]?.count || 0;
      socket.emit('player/progress', {
        device_id,
        type: 'folder',
        file: folderName,
        currentTime: imageNum,
        duration: totalImages,
        page: imageNum
      });
      }
    }
  });

  socket.on('player/pause', () => {
    console.log('[Player] ⏸️ player/pause');
    
    // КРИТИЧНО: Заглушка НЕ реагирует на паузу (как в Android)
    if (currentFileState.type === 'placeholder') {
      console.log('[Player] ⏸️ Pause игнорируется - играет заглушка');
      return;
    }
    
    if (vjsPlayer && !vjsPlayer.paused()) {
      // КРИТИЧНО: Сохраняем позицию перед паузой (в миллисекундах, как в Android)
      savedVideoPosition = Math.round(vjsPlayer.currentTime() * 1000);
      vjsPlayer.pause();
      console.log('[Player] ⏸️ Видео на паузе, позиция сохранена:', savedVideoPosition, 'ms');
    }
  });
  
  socket.on('player/resume', () => {
    console.log('[Player] ▶️ player/resume');
    
    // КРИТИЧНО: Заглушка НЕ реагирует на resume (как в Android)
    if (currentFileState.type === 'placeholder') {
      console.log('[Player] ▶️ Resume игнорируется - играет заглушка');
      return;
    }
    
    // Продолжаем воспроизведение с сохраненной позиции (как в Android)
    if (vjsPlayer && vjsPlayer.paused() && currentVideoFile) {
      // КРИТИЧНО: Восстанавливаем позицию перед воспроизведением
      if (savedVideoPosition > 0) {
        vjsPlayer.currentTime(savedVideoPosition / 1000); // Конвертируем в секунды
      }
      vjsPlayer.play();
      console.log('[Player] ▶️ Продолжение воспроизведения с позиции:', savedVideoPosition, 'ms');
    } else if (vjsPlayer && vjsPlayer.paused()) {
      // Если нет сохраненной позиции, просто продолжаем
      vjsPlayer.play();
      console.log('[Player] ▶️ Продолжение воспроизведения с текущей позиции');
    }
  });

  socket.on('player/restart', () => {
    console.log('[Player] 🔄 player/restart');
    
    // КРИТИЧНО: Заглушка НЕ реагирует на restart (как в Android)
    if (currentFileState.type === 'placeholder') {
      console.log('[Player] 🔄 Restart игнорируется - играет заглушка');
      return;
    }
    
    if (vjsPlayer) {
      vjsPlayer.currentTime(0);
      savedVideoPosition = 0; // Сбрасываем сохраненную позицию
      vjsPlayer.play();
      console.log('[Player] 🔄 Restart выполнен');
    }
  });

  socket.on('player/seek', ({ position }) => {
    console.log('[Player] 🎯 player/seek:', position);
    
    // КРИТИЧНО: Заглушка НЕ реагирует на seek (как в Android)
    if (currentFileState.type === 'placeholder') {
      console.log('[Player] 🎯 Seek игнорируется - играет заглушка');
      return;
    }
    
    if (vjsPlayer && typeof position === 'number' && position >= 0) {
      const targetTime = position; // position уже в секундах
      vjsPlayer.currentTime(targetTime);
      savedVideoPosition = Math.round(targetTime * 1000); // Сохраняем в миллисекундах
      console.log('[Player] 🎯 Перемотка выполнена:', targetTime, 'сек');
    }
  });

  socket.on('player/stop', (payload) => {
    console.log('[Player] ⏹️ player/stop', payload);
    destroyMpegtsPlayer('player_stop');
    destroyHlsPlayer('player_stop');
    destroyDashPlayer('player_stop');
    
    // КРИТИЧНО: Заглушка НЕ реагирует на stop (кроме placeholder_refresh, как в Android)
    const reason = payload?.reason || '';
    if (currentFileState.type === 'placeholder' && reason !== 'placeholder_refresh') {
      console.log('[Player] ⏹️ Stop игнорируется - играет заглушка');
      return;
    }
    
    // Обработка switch_content - просто паузим без показа заглушки (как в Android)
    if (reason === 'switch_content') {
      console.log('[Player] ⏹️ Stop (switch_content) - ждем следующий контент без заглушки');
      isSwitchingFromPlaceholder = true; // Устанавливаем флаг для предотвращения показа заглушки
      if (vjsPlayer && !vjsPlayer.paused()) {
        savedVideoPosition = Math.round(vjsPlayer.currentTime() * 1000);
        vjsPlayer.pause();
      }
      return;
    }
    
    // Обычный stop - возврат на заглушку (как в Android)
    console.log('[Player] ⏹️ Stop - возврат на заглушку (reason=' + reason + ')');
    
    // КРИТИЧНО: Полностью очищаем все буферы и сбрасываем состояние
    clearAllBuffers();
    currentFileState = { type: null, file: null, page: 1 };
    currentVideoFile = null; // Сбрасываем текущий файл видео
    savedVideoPosition = 0; // Сбрасываем сохраненную позицию
    isSwitchingFromPlaceholder = false; // Сбрасываем флаг переключения
    
    // КРИТИЧНО: Просто вызываем showPlaceholder() как в Android loadPlaceholder()
    // showPlaceholder() сам правильно обработает тип заглушки (изображение или видео)
    // forceRefresh = false (как в Android, кроме placeholder_refresh)
    showPlaceholder(false);
  });

  socket.on('placeholder/refresh', () => {
    console.log('[Player] 🔄 placeholder/refresh - перезагрузка заглушки');
    
    // Очищаем slidesCache при смене заглушки
    slidesCache = {};
    
    // КРИТИЧНО: Очищаем текущую заглушку из памяти для принудительной перезагрузки
    currentPlaceholderSrc = null;
    
    // КРИТИЧНО: Сбрасываем currentFileState в idle (важно для перезагрузки заглушки)
    currentFileState = { type: null, file: null, page: 1 };
    
    // Останавливаем плеер (НЕ очищаем src - это вызывает ошибку, просто паузим)
    if (vjsPlayer) {
      try {
        console.log('[Player] ⏸️ Остановка плеера...');
        vjsPlayer.pause();
        // НЕ вызываем vjsPlayer.src('') - это генерирует ошибку
        // Новый src установится автоматически при загрузке заглушки
        console.log('[Player] ✅ Плеер остановлен');
      } catch (e) {
        console.warn('[Player] ⚠️ Ошибка остановки плеера:', e);
      }
    }
    
    // Небольшая задержка, затем ВСЕГДА загружаем новую заглушку
    setTimeout(() => {
      // УБРАЛИ УСЛОВИЕ - всегда загружаем новую заглушку при placeholder/refresh
      console.log('[Player] 🔄 Загрузка новой заглушки с cache-busting...');
      showPlaceholder(true); // Принудительная перезагрузка с ?t=timestamp
    }, 100); // Небольшая задержка для остановки плеера
  });

  socket.on('player/pdfPage', (page) => {
    if (!currentFileState.file || currentFileState.type !== 'pdf') return;
    currentFileState.page = page;
    showConvertedPage(currentFileState.file, 'page', page, false);
    
    // Отправляем информацию о текущей странице на сервер для обновления спикер панели
    // Используем player/progress с параметром page (как Android)
    if (device_id && !preview && socket && socket.connected) {
      socket.emit('player/progress', {
        device_id,
        type: 'pdf',
        file: currentFileState.file,
        currentTime: page,
        duration: 0,
        page: page
      });
    }
  });

  socket.on('player/pptxPage', (slide) => {
    if (!currentFileState.file || currentFileState.type !== 'pptx') return;
    currentFileState.page = slide;
    showConvertedPage(currentFileState.file, 'slide', slide, false);
    
    // Отправляем информацию о текущей странице на сервер для обновления спикер панели
    // Используем player/progress с параметром page (как Android)
    if (device_id && !preview && socket && socket.connected) {
      socket.emit('player/progress', {
        device_id,
        type: 'pptx',
        file: currentFileState.file,
        currentTime: slide,
        duration: 0,
        page: slide
      });
    }
  });

  socket.on('player/folderPage', (imageNum) => {
    if (!currentFileState.file || currentFileState.type !== 'folder') return;
    currentFileState.page = imageNum;
    showFolderImage(currentFileState.file, imageNum, false);
    
    // Отправляем информацию о текущей странице на сервер для обновления спикер панели
    // Используем player/progress с параметром page (как Android)
    if (device_id && !preview && socket && socket.connected) {
      socket.emit('player/progress', {
        device_id,
        type: 'folder',
        file: currentFileState.file,
        currentTime: imageNum,
        duration: 0,
        page: imageNum
      });
    }
  });

  socket.on('player/state', (cur) => {
    console.log('[Player] 📡 player/state:', cur, 'currentFileState:', currentFileState);
    
    // КРИТИЧНО: Если состояние idle или нет файла - показываем заглушку ТОЛЬКО если сейчас ничего не играет
    if (!cur || cur.type === 'idle' || !cur.file) {
      // Показываем заглушку только если сейчас действительно idle (не играет контент)
      if (currentFileState.type === null || currentFileState.type === 'placeholder' || currentFileState.type === 'idle') {
        console.log('[Player] 📡 player/state: idle, показываем заглушку');
        showPlaceholder();
        currentFileState = { type: null, file: null, page: 1 };
      } else {
        console.log('[Player] 📡 player/state: игнорируем idle (сейчас играет контент)');
      }
      return;
    }
    
    // КРИТИЧНО: Применяем состояние только если это переподключение и контент действительно изменился
    // Не вызываем control/play если тот же контент уже играет
    const isSameContent = currentFileState.type === cur.type && 
                          currentFileState.file === cur.file && 
                          (currentFileState.type !== 'video' || currentFileState.page === (cur.page || 1));
    
    if (!isSameContent) {
      console.log('[Player] 📡 player/state: применяем состояние (переподключение)');
      socket.emit('control/play', { device_id, file: cur.file });
    } else {
      console.log('[Player] 📡 player/state: тот же контент уже играет, пропускаем');
    }
  });

  // Регистрация плеера
  let isRegistered = false;
  let heartbeatInterval = null;
  let pingTimeout = null;
  let registrationTimeout = null;
  
  function registerPlayer() {
    if (preview || !device_id) return;
    if (!socket.connected) {
      console.warn('[Player] ⚠️ Нельзя зарегистрироваться: нет соединения');
      ensureSocketConnected('register');
      return;
    }
    if (registerInFlight) {
      console.log('[Player] ⏳ Регистрация уже выполняется, пропуск');
      return;
    }
    registerInFlight = true;
    console.log('[Player] 📡 Попытка регистрации устройства:', device_id);
    
    // Отправляем запрос на регистрацию
    socket.emit('player/register', { 
      device_id, 
      device_type: 'VJC', 
      platform: navigator.platform,
      capabilities: {
        video: true,
        audio: true,
        images: true,
        pdf: true,
        pptx: true,
        streaming: true
      }
    });
    
    // Если через 3 секунды нет подтверждения - повторяем попытку
    if (registrationTimeout) clearTimeout(registrationTimeout);
    registrationTimeout = setTimeout(() => {
      registerInFlight = false;
      if (!isRegistered && socket.connected && device_id && !preview) {
        console.warn('[Player] ⚠️ Нет подтверждения регистрации через 3с, повторная попытка...');
        registerPlayer();
      }
    }, 3000);
  }
  
  
  function startHeartbeat() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      if (pingTimeout) clearTimeout(pingTimeout);
    }
    
    heartbeatInterval = setInterval(() => {
      if (!socket.connected || !isRegistered || preview) {
        clearInterval(heartbeatInterval);
        if (pingTimeout) clearTimeout(pingTimeout);
        heartbeatInterval = null;
        return;
      }
      
      socket.emit('player/ping');
      
      pingTimeout = setTimeout(() => {
        console.warn('⚠️ Heartbeat timeout');
        isRegistered = false;
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }, 5000);
    }, 15000);
  }
  
  socket.on('player/pong', () => {
    if (pingTimeout) {
      clearTimeout(pingTimeout);
      pingTimeout = null;
    }
    console.log('[Player] 💓 Pong получен, соединение активно');
  });
  
  socket.on('player/reject', ({ reason }) => {
    console.error('[Player] ❌ Регистрация отклонена:', reason);
    isRegistered = false;
    registerInFlight = false;
  });

  // Обработчик команд управления звуком
  socket.on('player/volume', handleVolumeCommand);

  // КРИТИЧНО: Обработчик должен быть зарегистрирован ДО вызова registerPlayer()
  socket.on('player/registered', (payload) => {
    console.log('[Player] 📨 Получено событие player/registered:', payload);
    if (registrationTimeout) {
      clearTimeout(registrationTimeout);
      registrationTimeout = null;
    }
    registerInFlight = false;
    const registeredId = payload?.device_id || payload?.deviceId || device_id;
    console.log('[Player] ✅ Регистрация ПОДТВЕРЖДЕНА сервером:', registeredId, 'payload:', payload);
    isRegistered = true;
    emitVolumeState('register');
    startHeartbeat();
    console.log('[Player] 💓 Heartbeat запущен');
  });
  
  // Дополнительный обработчик для отладки - проверяем все входящие события
  socket.onAny((eventName, ...args) => {
    if (eventName === 'player/registered' || eventName === 'player/reject' || eventName === 'player/state') {
      console.log(`[Player] 🔍 Socket событие: ${eventName}`, args);
    }
  });

  socket.on('connect', () => {
    console.log('✅ Connected');
    isRegistered = false; // Сбрасываем при каждом connect
    registerInFlight = false;
    registerPlayer();
  });

  socket.on('disconnect', (reason) => {
    console.warn('⚠️ Disconnected, reason:', reason);
    isRegistered = false;
    registerInFlight = false;
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (pingTimeout) {
      clearTimeout(pingTimeout);
      pingTimeout = null;
    }
    if (registrationTimeout) {
      clearTimeout(registrationTimeout);
      registrationTimeout = null;
    }
    
    // КРИТИЧНО: Если на плеере во время стрима пропало соединение, возвращаемся на заглушку
    if (currentFileState.type === 'streaming' && !preview) {
      console.log('[Player] 🔄 Потеря соединения во время стрима, возвращаемся на заглушку');
      
      // Останавливаем все плееры стрима
      destroyMpegtsPlayer('disconnect_during_stream');
      destroyHlsPlayer('disconnect_during_stream');
      destroyDashPlayer('disconnect_during_stream');
      
      // Очищаем состояние стрима
      clearAllBuffers();
      currentFileState = { type: null, file: null, page: 1 };
      currentVideoFile = null;
      savedVideoPosition = 0;
      isSwitchingFromPlaceholder = false;
      
      // Возвращаемся на заглушку
      showPlaceholder(false);
    }
    
    // КРИТИЧНО: Для Android - явное переподключение после disconnect
    if (reason === 'transport close' || reason === 'transport error') {
      console.log('🔄 Transport закрыт, попытка переподключения через 2с...');
      setTimeout(() => {
        if (!preview && device_id) {
          ensureSocketConnected('disconnect-transport');
        }
      }, 2000);
    }
    if (reason === 'ping timeout') {
      ensureSocketConnected('disconnect-ping-timeout');
    }
  });

  socket.on('reconnect', () => {
    console.log('🔄 Reconnected');
    isRegistered = false;
    registerInFlight = false;
    registerPlayer();
  });
  
  // НОВОЕ: Обработчики попыток переподключения
  socket.on('reconnect_attempt', (attemptNumber) => {
    console.log(`🔄 Попытка переподключения #${attemptNumber}`);
  });
  
  socket.on('reconnect_error', (error) => {
    console.warn('⚠️ Ошибка переподключения:', error);
  });
  
  socket.on('reconnect_failed', () => {
    console.error('❌ Переподключение не удалось');
    // Пробуем еще раз вручную через 5 секунд
    setTimeout(() => {
      if (!preview && device_id) {
        ensureSocketConnected('reconnect-failed');
      }
    }, 5000);
  });
  
  socket.on('connect_error', (error) => {
    console.error('[Player] ❌ connect_error:', error?.message || error, error?.code || '');
  });

  socket.on('error', (error) => {
    console.error('[Player] ❌ socket error:', error);
  });

  // Watchdog проверка каждые 5 секунд (чаще для надежности)
  setInterval(() => {
    if (!preview && device_id) {
      // Проверяем подключение
      if (!socket.connected) {
        console.warn('🔄 Watchdog: socket disconnected, пытаемся переподключиться...');
        ensureSocketConnected('watchdog-disconnected');
      } else if (!isRegistered && !registerInFlight) {
        // Подключены, но не зарегистрированы
        console.log('🔄 Watchdog: re-registering (device not registered)');
        registerPlayer();
      }
    }
  }, 5000);
}