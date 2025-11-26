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

// const idle = document.getElementById('idle'); // Убрано - больше не используется
const v = document.getElementById('v');
const videoContainer = document.getElementById('videoContainer'); // Контейнер для Video.js
const img1 = document.getElementById('img1');
const img = img1; // Для обратной совместимости со старым кодом
const pdf = document.getElementById('pdf');
const unmuteBtn = document.getElementById('unmute');
const brandBg = document.getElementById('brandBg');

let currentFileState = { type: null, file: null, page: 1 };
// КРИТИЧНО: Retry счетчик для сетевых ошибок (как в Android) - доступен из всех обработчиков
let networkErrorRetryCount = 0;
let networkErrorRetryTimeout = null;
const maxNetworkRetryAttempts = 10; // Для контента (не заглушки) - больше попыток
const maxPlaceholderRetryAttempts = 3; // Для заглушки - меньше попыток
// КРИТИЧНО: Сохраненная позиция воспроизведения при разрыве сети
let savedVideoPosition = null;
let savedVideoSrc = null;
let isNetworkDisconnected = false; // Флаг разрыва сети
let soundUnlocked = false;
let vjsPlayer = null;
let isLoadingPlaceholder = false; // Флаг для предотвращения двойной загрузки
let registerInFlight = false; // Предотвращаем одновременные попытки регистрации
let slidesCache = {}; // Кэш предзагруженных слайдов PPTX/PDF: { 'filename': { count: N, images: [Image, ...] } }
let wakeLock = null; // Wake Lock для предотвращения suspend
let lastProgressEmitTs = 0; // троттлинг отправки прогресса
let progressInterval = null; // периодическая отправка прогресса (fallback)
// КРИТИЧНО: Функция для отправки сигнала об остановке прогресса (очистка информации на панели спикера)
let emitProgressStop = null; // Будет установлена при инициализации Video.js

// Функция для остановки отправки прогресса
function stopProgressInterval() {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
}

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

// Режим фона: 'logo' для видео, 'black' для слайдов/папок/статического контента
function setBrandBackgroundMode(mode) {
  if (!brandBg) return;
  if (mode === 'logo') {
    brandBg.style.backgroundImage = `url('/branding/logo.svg?t=${Date.now()}')`;
    brandBg.style.backgroundRepeat = 'no-repeat';
    brandBg.style.backgroundPosition = 'center';
    brandBg.style.backgroundSize = 'contain';
    brandBg.style.backgroundColor = '#000';
  } else {
    brandBg.style.backgroundImage = 'none';
    brandBg.style.backgroundColor = '#000';
  }
}

// Утилита: ожидание завершения CSS-перехода opacity у элемента (глобально)
function waitForOpacityTransitionEnd(el, expectedProperty = 'opacity', timeoutMs = 600) {
  return new Promise(resolve => {
    let done = false;
    const onEnd = (evt) => {
      if (evt && evt.target !== el) return;
      if (evt && evt.propertyName && evt.propertyName !== expectedProperty) return;
      if (done) return;
      done = true;
      el.removeEventListener('transitionend', onEnd);
      resolve();
    };
    el.addEventListener('transitionend', onEnd, { once: true });
    setTimeout(() => {
      if (done) return;
      done = true;
      el.removeEventListener('transitionend', onEnd);
      resolve();
    }, timeoutMs);
  });
}

function ensureSocketConnected(reason = 'manual') {
  const isActive = typeof socket.active === 'boolean' ? socket.active : false;
  if (socket.connected || isActive) {
    return;
  }
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
    
  } catch (e) {
  }
}

if (!device_id || !device_id.trim()) {
  [v, img1, pdf].forEach(el => el && el.classList.remove('visible'));
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';
  // В режиме без device_id используем черный фон без логотипа
  setBrandBackgroundMode('black');
  if (unmuteBtn) unmuteBtn.style.display = 'none';
} else {
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
          // КРИТИЧНО: При загрузке страницы сбрасываем состояние и останавливаем видео
          // Это предотвращает продолжение воспроизведения из кэша браузера
          currentFileState = { type: null, file: null, page: 1 };
          if (vjsPlayer) {
            vjsPlayer.pause();
            vjsPlayer.currentTime(0);
            // НЕ устанавливаем пустой src - это вызывает ошибку Video.js
            // Просто останавливаем и скрываем
            videoContainer.classList.remove('visible', 'preloading');
          }
          
          // По умолчанию для видео включаем логотип на фоне
          setBrandBackgroundMode('logo');
          
          // КРИТИЧНО: Скрываем все контролы при инициализации
          hideVideoJsControls();
          applyVolumeToPlayer('player_ready');
          
          // Автовключение звука ПОСЛЕ готовности Video.js
          if (!preview && forceSound && !forceMuted) {
            setTimeout(() => enableSound(), 500);
            if (unmuteBtn) unmuteBtn.style.display = 'none';
          } else if (!preview && localStorage.getItem('vc_sound') === '1' && !forceMuted) {
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
            // КРИТИЧНО: Проверяем, не из-за ли разрыва сети видео остановилось
            // Если есть сохраненная позиция и сеть была разорвана - это не реальное окончание
            if (isNetworkDisconnected && savedVideoPosition !== null && savedVideoSrc) {
              console.log('[Player] ⚠️ Видео остановилось из-за разрыва сети, не переключаемся на заглушку');
              // Не переключаемся на заглушку, ждем восстановления сети
              return;
            }
            
            // КРИТИЧНО: Android WebView может генерировать 'ended' при паузе (баг)
            // Проверяем, что видео ДЕЙСТВИТЕЛЬНО закончилось
            const currentTime = vjsPlayer.currentTime();
            const duration = vjsPlayer.duration();
            const isActuallyEnded = duration > 0 && currentTime >= duration - 0.5;
            const isLooping = vjsPlayer.loop();
            
            // КРИТИЧНО: Если включен loop - НЕ показываем placeholder!
            if (isLooping && isActuallyEnded) {
              vjsPlayer.currentTime(0);
              vjsPlayer.play();
              return;
            }
            
            // КРИТИЧНО: Показываем заглушку ТОЛЬКО если видео действительно закончилось 
            // И текущий контент - это видео (не изображение/PDF/PPTX/папка/заглушка)
            if (!preview && isActuallyEnded && currentFileState.type === 'video') {
              console.log('[Player] ✅ Видео закончилось, переключаемся на заглушку');
              // Сбрасываем состояние перед показом заглушки
              currentFileState = { type: null, file: null, page: 1 };
              showPlaceholder();
            } else if (!isActuallyEnded) {
              // Видео не закончилось - игнорируем
            } else {
              // Контент не видео - игнорируем (изображение/PDF/PPTX/папка/заглушка уже показывается)
            }
          });
          
                  // Обработчик ошибок
          vjsPlayer.on('error', function() {
            const error = vjsPlayer.error();
            console.error('[Player] ❌ Video.js error:', error);
            
            // КРИТИЧНО: При ошибке загрузки видео обрабатываем по типу ошибки (как в Android)
            if (error && error.code) {
              const errorCode = error.code;
              const isNetworkError = errorCode === 2; // MEDIA_ERR_NETWORK
              const isDecodeError = errorCode === 3; // MEDIA_ERR_DECODE
              const isSrcError = errorCode === 4; // MEDIA_ERR_SRC_NOT_SUPPORTED (404, формат не поддерживается)
              
              const isContent = currentFileState.type === 'video' && currentFileState.type !== 'placeholder';
              const isPlaceholder = currentFileState.type === 'placeholder';
              
              // КРИТИЧНО: Для сетевых ошибок при воспроизведении контента - делаем retry (как в Android)
              if (isNetworkError && isContent) {
                const maxAttempts = maxNetworkRetryAttempts;
                
                // КРИТИЧНО: Сохраняем позицию и источник при сетевой ошибке
                const currentTime = vjsPlayer.currentTime();
                const currentSrc = vjsPlayer.currentSrc();
                if (currentTime > 0 && currentSrc) {
                  savedVideoPosition = currentTime;
                  savedVideoSrc = currentSrc;
                  isNetworkDisconnected = true;
                  console.log(`[Player] 💾 Сохранена позиция при сетевой ошибке: ${currentTime.toFixed(1)}s`);
                }
                
                // Отменяем предыдущий retry
                if (networkErrorRetryTimeout) {
                  clearTimeout(networkErrorRetryTimeout);
                  networkErrorRetryTimeout = null;
                }
                
                if (networkErrorRetryCount < maxAttempts) {
                  networkErrorRetryCount++;
                  console.warn(`[Player] ⚠️ Сетевая ошибка при воспроизведении контента, retry ${networkErrorRetryCount}/${maxAttempts}...`);
                  
                  // Retry через 5 секунд (как в Android)
                  networkErrorRetryTimeout = setTimeout(() => {
                    networkErrorRetryTimeout = null;
                    
                    if (currentFileState.type === 'video' && currentFileState.type !== 'placeholder') {
                      const retryTime = savedVideoPosition || vjsPlayer.currentTime();
                      console.log(`[Player] 🔄 Retry воспроизведения с позиции ${retryTime.toFixed(1)}s...`);
                      
                      // Пробуем перезагрузить с той же позиции
                      vjsPlayer.load(); // Перезагружаем текущий источник
                      
                      vjsPlayer.one('loadedmetadata', () => {
                        // Восстанавливаем позицию
                        if (retryTime > 0 && retryTime < vjsPlayer.duration()) {
                          vjsPlayer.currentTime(retryTime);
                        }
                        vjsPlayer.play().catch(err => {
                          console.error('[Player] ❌ Ошибка retry воспроизведения:', err);
                        });
                      });
                    }
                  }, 5000);
                  
                  return; // Не показываем заглушку, ждем восстановления сети
                } else {
                  // Превышен лимит попыток - возвращаемся к заглушке
                  console.error(`[Player] ❌ Превышен лимит retry (${maxAttempts}), возвращаемся к заглушке`);
                  networkErrorRetryCount = 0;
                  isNetworkDisconnected = false;
                  savedVideoPosition = null;
                  savedVideoSrc = null;
                  // Продолжаем вниз - показываем заглушку
                }
              }
              
              // Для других ошибок или если retry не помог - показываем заглушку
              if (isContent) {
                console.warn(`[Player] ⚠️ Ошибка загрузки видео (code: ${errorCode}), возвращаемся к заглушке`);
                
                // Используем кэшированную заглушку если есть
                if (cachedPlaceholderSrc) {
                  if (cachedPlaceholderType === 'video' && cachedPlaceholderSrc) {
                    vjsPlayer.src({ src: cachedPlaceholderSrc, type: 'video/mp4' });
                    vjsPlayer.loop(true);
                    vjsPlayer.muted(true);
                    vjsPlayer.volume(0);
                    currentPlaceholderSrc = cachedPlaceholderSrc;
                    currentFileState = { type: 'placeholder', file: cachedPlaceholderSrc, page: 1 };
                    
                    // Показываем заглушку и запускаем воспроизведение
                    vjsPlayer.one('loadedmetadata', () => {
                      hideVideoJsControls();
                      vjsPlayer.one('loadeddata', () => {
                        requestAnimationFrame(() => {
                          requestAnimationFrame(() => {
                            videoContainer.classList.remove('preloading');
                            videoContainer.classList.add('visible');
                            // idle убран
                            vjsPlayer.one('canplay', () => {
                              setTimeout(() => {
                                vjsPlayer.play().catch(err => {
                                  console.error('[Player] ❌ Ошибка воспроизведения кэшированной заглушки:', err);
                                });
                              }, 200);
                            });
                          });
                        });
                      });
                    });
                  } else if (cachedPlaceholderType === 'image' && cachedPlaceholderSrc) {
                    // Используем изображение заглушку
                    const tempImg = new Image();
                    tempImg.onload = () => {
                      // idle убран
                      img.src = cachedPlaceholderSrc;
                      currentPlaceholderSrc = cachedPlaceholderSrc;
                      currentFileState = { type: 'placeholder', file: cachedPlaceholderSrc, page: 1 };
                      // Если уже показывается изображение - не трогаем класс visible (однотипное переключение)
                      const isSameTypeSwitch = img.classList.contains('visible');
                      show(img, true, isSameTypeSwitch);
                    };
                    tempImg.src = cachedPlaceholderSrc;
                  }
                } else {
                  // Кэша нет - загружаем заглушку с сервера
                  showPlaceholder();
                }
              } else if (isPlaceholder && cachedPlaceholderSrc) {
                // Ошибка при загрузке заглушки - пробуем еще раз через некоторое время
                if (networkErrorRetryCount < maxPlaceholderRetryAttempts) {
                  networkErrorRetryCount++;
                  console.warn(`[Player] ⚠️ Ошибка загрузки заглушки, повтор ${networkErrorRetryCount}/${maxPlaceholderRetryAttempts} через 5 секунд...`);
                  setTimeout(() => {
                    if (currentFileState.type === 'placeholder') {
                      showPlaceholder(true);
                    }
                  }, 5000);
                } else {
                  networkErrorRetryCount = 0;
                  console.error('[Player] ❌ Превышен лимит retry для заглушки');
                }
              }
            }
          });
          
          // КРИТИЧНО для Android: обработчики буферизации и зависания
          let stalledTimeout = null;
          let waitingTimeout = null;
          
          // КРИТИЧНО для Android: обработчики состояния воспроизведения
          let lastLoggedPercent = -1;
          
          // КРИТИЧНО: При stalled/waiting не показываем ошибку - это нормально при сетевых проблемах
          vjsPlayer.on('stalled', () => {
            // Видео остановилось из-за нехватки данных - это нормально, ждем загрузки
            if (currentFileState.type === 'video' && currentFileState.type !== 'placeholder') {
              console.log('[Player] ⏸️ Видео остановилось (stalled), ждем загрузки данных...');
              
              // КРИТИЧНО: Сохраняем позицию при остановке из-за нехватки буфера
              const currentTime = vjsPlayer.currentTime();
              const currentSrc = vjsPlayer.currentSrc();
              if (currentTime > 0 && currentSrc) {
                savedVideoPosition = currentTime;
                savedVideoSrc = currentSrc;
                isNetworkDisconnected = true;
                console.log(`[Player] 💾 Сохранена позиция: ${currentTime.toFixed(1)}s`);
              }
            }
          });
          
          vjsPlayer.on('waiting', () => {
            // Видео ждет загрузки данных - это нормально, не показываем ошибку
            if (currentFileState.type === 'video' && currentFileState.type !== 'placeholder') {
              console.log('[Player] ⏳ Видео ждет загрузки данных (waiting)...');
              
              // КРИТИЧНО: Сохраняем позицию при ожидании загрузки данных
              const currentTime = vjsPlayer.currentTime();
              const currentSrc = vjsPlayer.currentSrc();
              if (currentTime > 0 && currentSrc && !savedVideoPosition) {
                savedVideoPosition = currentTime;
                savedVideoSrc = currentSrc;
                isNetworkDisconnected = true;
                console.log(`[Player] 💾 Сохранена позиция при waiting: ${currentTime.toFixed(1)}s`);
              }
            }
          });
          
          vjsPlayer.on('playing', () => {
            // КРИТИЧНО: При возобновлении воспроизведения сбрасываем флаг разрыва сети
            if (isNetworkDisconnected && savedVideoPosition !== null) {
              console.log('[Player] ✅ Воспроизведение возобновлено, сбрасываем флаг разрыва сети');
              isNetworkDisconnected = false;
              // Не сбрасываем savedVideoPosition - может понадобиться при следующем разрыве
            }
            
            // КРИТИЧНО: Запрашиваем Wake Lock для предотвращения suspend
            if ('wakeLock' in navigator && !wakeLock) {
              navigator.wakeLock.request('screen').then(wl => {
                wakeLock = wl;
                
                wakeLock.addEventListener('release', () => {
                  wakeLock = null;
                });
              }).catch(e => {
              });
            }
          });
          
          // КРИТИЧНО: Отслеживаем паузу из-за нехватки буфера
          vjsPlayer.on('pause', () => {
            // Если видео на паузе и это не заглушка - возможно, из-за разрыва сети
            if (currentFileState.type === 'video' && currentFileState.type !== 'placeholder') {
              const currentTime = vjsPlayer.currentTime();
              const duration = vjsPlayer.duration();
              const buffered = vjsPlayer.buffered();
              
              // Проверяем, закончился ли буфер
              if (buffered.length > 0) {
                const bufferedEnd = buffered.end(buffered.length - 1);
                const isBufferExhausted = currentTime >= bufferedEnd - 0.5; // Буфер закончился
                
                if (isBufferExhausted && currentTime < duration - 1) {
                  // Буфер закончился, но видео не закончилось - сохраняем позицию
                  const currentSrc = vjsPlayer.currentSrc();
                  if (currentTime > 0 && currentSrc) {
                    savedVideoPosition = currentTime;
                    savedVideoSrc = currentSrc;
                    isNetworkDisconnected = true;
                    console.log(`[Player] 💾 Буфер закончился, сохранена позиция: ${currentTime.toFixed(1)}s`);
                  }
                }
              }
            }
          });
          
          // Отправка прогресса на спикер-панель
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
          
          vjsPlayer.on('timeupdate', emitProgress);
          vjsPlayer.on('loadedmetadata', emitProgress);
          vjsPlayer.on('seeking', emitProgress);
          vjsPlayer.on('seeked', emitProgress);
          
          // Дополнительно: регулярная отправка прогресса раз в 1с, пока идёт воспроизведение
          const startProgressInterval = () => {
            if (progressInterval || preview) return;
            progressInterval = setInterval(() => {
              if (!vjsPlayer || vjsPlayer.paused()) return;
              emitProgress();
            }, 1000);
          };
          const stopProgressInterval = () => {
            if (progressInterval) {
              clearInterval(progressInterval);
              progressInterval = null;
            }
          };
          vjsPlayer.on('playing', startProgressInterval);
          vjsPlayer.on('pause', stopProgressInterval);
          vjsPlayer.on('ended', stopProgressInterval);
          vjsPlayer.on('dispose', stopProgressInterval);
          
          vjsPlayer.on('progress', () => {
            // Логируем только изменения процента (не спамим)
            const buffered = vjsPlayer.buffered();
            if (buffered.length > 0) {
              const bufferedEnd = buffered.end(buffered.length - 1);
              const duration = vjsPlayer.duration();
              const percent = duration > 0 ? Math.round((bufferedEnd / duration) * 100) : 0;
              if (percent !== lastLoggedPercent && percent % 10 === 0) {
                lastLoggedPercent = percent;
              }
            }
          });
          
          vjsPlayer.on('suspend', () => {
            // НИЧЕГО НЕ ДЕЛАЕМ - Android сам управляет буферизацией
            // videoEl.load() ПРЕРЫВАЕТ воспроизведение - это создает цикл ошибок
          });
          
          vjsPlayer.on('canplay', () => {
          });
          
          vjsPlayer.on('canplaythrough', () => {
          });
          
          // Загружаем заглушку или preview файл после готовности
          if (preview && previewFile) {
            // Preview режим - показываем указанный файл
            setTimeout(() => {
              const previewType = url.searchParams.get('type');
              const previewPage = url.searchParams.get('page');
              const ext = previewFile.split('.').pop().toLowerCase();
              
              
              if (previewType === 'pdf' && previewPage) {
                // PDF preview
                const imageUrl = `/api/devices/${encodeURIComponent(device_id)}/converted/${encodeURIComponent(previewFile)}/page/${previewPage}`;
                img.src = imageUrl;
                show(img);
              } else if (previewType === 'pptx' && previewPage) {
                // PPTX preview
                const imageUrl = `/api/devices/${encodeURIComponent(device_id)}/converted/${encodeURIComponent(previewFile)}/slide/${previewPage}`;
                img.src = imageUrl;
                show(img);
              } else if (previewType === 'image' || ['png','jpg','jpeg','gif','webp'].includes(ext)) {
                // Изображение preview
                img.src = content(previewFile);
                show(img);
              } else if (['mp4','webm','ogg','mkv','mov','avi'].includes(ext) || previewType === 'video') {
                // Видео preview
                vjsPlayer.loop(true);
                vjsPlayer.muted(true);
                vjsPlayer.volume(0);
                // Пытаемся отдать предсгенерированный трейлер (5s). Если его нет (404) — сразу используем on-the-fly превью
                const trailerSrc = `/api/files/trailer/${encodeURIComponent(device_id)}/${encodeURIComponent(previewFile)}`;
                const fallbackPreviewSrc = `/api/files/preview/${encodeURIComponent(device_id)}/${encodeURIComponent(previewFile)}?start=0&seconds=5`;
                
                // HEAD-проверка наличия трейлера, чтобы избежать MEDIA_ERR_SRC_NOT_SUPPORTED при 404
                (async () => {
                  try {
                    const head = await fetch(trailerSrc, { method: 'HEAD', cache: 'no-store' });
                    if (head.ok) {
                      vjsPlayer.src({ src: trailerSrc, type: 'video/mp4' });
                    } else {
                      vjsPlayer.src({ src: fallbackPreviewSrc, type: 'video/mp4' });
                    }
                  } catch {
                    vjsPlayer.src({ src: fallbackPreviewSrc, type: 'video/mp4' });
                  }
                })();
                show(videoContainer);
                
                // Даем время для загрузки src
                setTimeout(() => {
                  vjsPlayer.play().then(() => {
                  }).catch(err => {
                    // КРИТИЧНО: Игнорируем AbortError - браузер блокирует autoplay на фоновых вкладках
                    // Видео всё равно загружено и показан первый кадр
                    if (err.name === 'AbortError') {
                    } else {
                    }
                    
                    // SAFARI FIX: Если autoplay не сработал, пробуем запустить при клике
                    if (preview) {
                      const startOnInteraction = () => {
                        vjsPlayer.play().then(() => {
                          document.removeEventListener('click', startOnInteraction);
                          document.removeEventListener('touchstart', startOnInteraction);
                        });
                      };
                      document.addEventListener('click', startOnInteraction, { once: true });
                      document.addEventListener('touchstart', startOnInteraction, { once: true });
                    }
                  });
                }, 150);
              } else {
              }
            }, 100);
          } else {
            // Обычный режим - показываем заглушку
            // КРИТИЧНО: Отправляем сигнал об остановке прогресса при загрузке страницы
            if (typeof emitProgressStop === 'function') {
              emitProgressStop();
            }
            
            setTimeout(async () => {
              try {
                await showPlaceholder();
                // КРИТИЧНО: После показа заглушки еще раз отправляем сигнал об остановке прогресса
                if (typeof emitProgressStop === 'function') {
                  setTimeout(() => emitProgressStop(), 500);
                }
              } catch (e) {
                console.error('[Player] ❌ Ошибка загрузки заглушки при инициализации:', e);
                // Убираем черный экран при ошибке, показываем бренд-фон
                // idle убран
                [videoContainer, img1, pdf].forEach(e => {
                  if (e) e.classList.remove('visible', 'preloading');
                });
                // Отправляем сигнал об остановке прогресса при ошибке
                if (typeof emitProgressStop === 'function') {
                  emitProgressStop();
                }
              }
            }, 100);
          }
        });
      } catch (e) {
        console.error('[Player] ❌ Ошибка инициализации Video.js:', e);
      }
    } else {
      console.error('[Player] ❌ Video.js library не загружена!');
    }
  });
  
  // Унифицированная функция для полной очистки всех буферов при переключении типа контента
  function clearAllBuffers() {
    // КРИТИЧНО: Полная очистка видео плеера
    if (vjsPlayer) {
      vjsPlayer.pause();
      vjsPlayer.currentTime(0);
      // Останавливаем воспроизведение и очищаем медиа-источник
      try {
        // Используем load() для полной очистки состояния плеера
        vjsPlayer.load();
      } catch (e) {
        // Игнорируем ошибки при очистке (load() должен работать всегда)
      }
      hideVideoJsControls();
    }
    
    // Останавливаем отправку прогресса
    stopProgressInterval();
    if (typeof emitProgressStop === 'function') {
      emitProgressStop();
    }
    
    // Скрываем видео контейнер
    videoContainer.classList.remove('visible', 'preloading');
    
    // КРИТИЧНО: Полная очистка буфера изображений
    if (img1) {
      img1.removeAttribute('src');
      img1.src = '';
      // Очищаем обработчики событий
      img1.onload = null;
      img1.onerror = null;
      img1.classList.remove('visible', 'preloading');
      // Убираем все inline стили при остановке папок/PDF/PPTX
      img1.removeAttribute('style');
    }
    
    // Также очищаем PDF
    if (pdf) {
      pdf.removeAttribute('src');
      pdf.src = '';
      pdf.classList.remove('visible', 'preloading');
      // Убираем все inline стили при остановке
      pdf.removeAttribute('style');
    }
    
    
    // Очистка PDF
    if (pdf) {
      pdf.removeAttribute('src');
      pdf.src = '';
      pdf.classList.remove('visible', 'preloading');
      // Убираем все inline стили при остановке папок/PDF/PPTX
      pdf.removeAttribute('style');
    }
    
    console.log('[Player] 🧹 Все буферы очищены');
  }
  
  // ============================================================================
  // УНИВЕРСАЛЬНАЯ СИСТЕМА ПЛАВНОГО ПЕРЕКЛЮЧЕНИЯ КОНТЕНТА
  // ============================================================================
  
  // Переменная для отслеживания текущего активного перехода (для отмены при новой команде)
  let currentTransition = null;
  const TRANSITION_DURATION = 500; // Длительность перехода в мс
  
  /**
   * Предзагрузка видео (загружает метаданные и первый кадр)
   * НЕ изменяет текущий src, если видео уже воспроизводится
   */
  async function preloadVideo(src) {
    if (!vjsPlayer || !src) return null;
    
    return new Promise((resolve, reject) => {
      const currentSrc = vjsPlayer.currentSrc();
      
      // Если это тот же источник и уже загружен - возвращаем сразу
      if (currentSrc === src || currentSrc.includes(src.split('/').pop())) {
        if (vjsPlayer.readyState() >= 2) {
          resolve({ 
            src, 
            readyState: vjsPlayer.readyState(), 
            duration: vjsPlayer.duration() 
          });
          return;
        }
        // Если тот же src, но еще загружается - ждем
        const onReady = () => {
          vjsPlayer.off('loadedmetadata', onReady);
          vjsPlayer.off('error', onError);
          resolve({ 
            src, 
            readyState: vjsPlayer.readyState(),
            duration: vjsPlayer.duration()
          });
        };
        const onError = (error) => {
          vjsPlayer.off('loadedmetadata', onReady);
          vjsPlayer.off('error', onError);
          reject(new Error(`Video preload failed: ${error?.message || 'Unknown error'}`));
        };
        vjsPlayer.one('loadedmetadata', onReady);
        vjsPlayer.one('error', onError);
      return;
    }
    
      // Проверяем существование файла перед загрузкой
      fetch(src, { method: 'HEAD', cache: 'no-store' })
        .then(response => {
          if (!response.ok) {
            reject(new Error(`Video file not found: ${response.status}`));
            return;
          }
          
          // Устанавливаем источник для предзагрузки метаданных
          // Сохраняем текущий src для восстановления (если нужно)
          const wasPaused = vjsPlayer.paused();
          
          const cleanup = () => {
            vjsPlayer.off('loadedmetadata', onLoaded);
            vjsPlayer.off('error', onError);
          };
          
          const onLoaded = () => {
            cleanup();
            resolve({ 
              src, 
              readyState: vjsPlayer.readyState(),
              duration: vjsPlayer.duration()
            });
          };
          
          const onError = (error) => {
            cleanup();
            reject(new Error(`Video preload failed: ${error?.message || 'Unknown error'}`));
          };
          
          vjsPlayer.one('loadedmetadata', onLoaded);
          vjsPlayer.one('error', onError);
          
          // Устанавливаем источник
          try {
            vjsPlayer.src({ src, type: 'video/mp4' });
          } catch (e) {
            cleanup();
            reject(e);
          }
        })
        .catch(error => {
          // Ошибка проверки - пробуем все равно загрузить
          const cleanup = () => {
            vjsPlayer.off('loadedmetadata', onLoaded);
            vjsPlayer.off('error', onError);
          };
          
          const onLoaded = () => {
            cleanup();
            resolve({ 
              src, 
              readyState: vjsPlayer.readyState(),
              duration: vjsPlayer.duration()
            });
          };
          
          const onError = (error) => {
            cleanup();
            reject(new Error(`Video preload failed: ${error?.message || 'Unknown error'}`));
          };
          
          vjsPlayer.one('loadedmetadata', onLoaded);
          vjsPlayer.one('error', onError);
          
          try {
            vjsPlayer.src({ src, type: 'video/mp4' });
          } catch (e) {
            cleanup();
            reject(e);
          }
        });
    });
  }
  
  /**
   * Предзагрузка изображения
   */
  async function preloadImage(src) {
    if (!src) return null;
    
    return new Promise((resolve, reject) => {
      const img = new Image();
      
      img.onload = () => {
        resolve({ src, width: img.naturalWidth, height: img.naturalHeight, image: img });
      };
      
      img.onerror = () => {
        reject(new Error(`Image preload failed: ${src}`));
      };
      
      img.src = src;
    });
  }
  
  /**
   * Предзагрузка PDF страницы или PPTX слайда
   */
  async function preloadConvertedSlide(file, type, num) {
    // Проверяем кэш
    if (slidesCache[file] && slidesCache[file].images) {
      const cached = slidesCache[file];
      const index = Math.max(0, Math.min(num - 1, cached.count - 1));
      const cachedImage = cached.images[index];
      
      if (cachedImage && cachedImage.complete && cachedImage.naturalWidth > 0) {
        const urlType = type === 'pdf' ? 'page' : 'slide';
        const expectedUrl = `/api/devices/${encodeURIComponent(device_id)}/converted/${encodeURIComponent(file)}/${urlType}/${num}`;
        const cachedSrc = cachedImage.src || expectedUrl;
        return Promise.resolve({ src: cachedSrc, image: cachedImage });
      }
    }
    
    // Загружаем через API
    const urlType = type === 'pdf' ? 'page' : 'slide';
    const imageUrl = `/api/devices/${encodeURIComponent(device_id)}/converted/${encodeURIComponent(file)}/${urlType}/${num}`;
    
    return preloadImage(imageUrl);
  }
  
  /**
   * Предзагрузка изображения из папки
   */
  async function preloadFolderImage(folderName, num) {
    // Проверяем кэш
    if (slidesCache[folderName] && slidesCache[folderName].images) {
      const cached = slidesCache[folderName];
      const index = Math.max(0, Math.min(num - 1, cached.count - 1));
      const cachedImage = cached.images[index];
      
      if (cachedImage && cachedImage.complete && cachedImage.naturalWidth > 0) {
        const expectedUrl = `/api/devices/${encodeURIComponent(device_id)}/folder/${encodeURIComponent(folderName)}/image/${num}`;
        const cachedSrc = cachedImage.src || expectedUrl;
        return Promise.resolve({ src: cachedSrc, image: cachedImage });
      }
    }
    
    // Загружаем через API
    const imageUrl = `/api/devices/${encodeURIComponent(device_id)}/folder/${encodeURIComponent(folderName)}/image/${num}`;
    
    return preloadImage(imageUrl);
  }
  
  /**
   * Универсальная функция предзагрузки любого типа контента
   */
  async function preloadContent(type, file, page = 1, options = {}) {
    try {
      switch (type) {
        case 'video':
          const videoSrc = content(file);
          return await preloadVideo(videoSrc);
          
        case 'image':
          const imageSrc = content(file);
          return await preloadImage(imageSrc);
          
        case 'pdf':
          return await preloadConvertedSlide(file, 'pdf', page);
          
        case 'pptx':
          return await preloadConvertedSlide(file, 'pptx', page);
          
        case 'folder':
          const folderName = file.replace(/\.zip$/i, '');
          return await preloadFolderImage(folderName, page);
          
        case 'placeholder':
          // Для placeholder определяем тип по расширению или используем resolvePlaceholder
          // file может быть либо URL, либо именем файла
          if (file.startsWith('/') || file.startsWith('http')) {
            // Это уже URL - определяем тип по расширению
            const ext = file.split('.').pop().toLowerCase().split('?')[0];
            if (['mp4', 'webm', 'ogg', 'mkv', 'mov', 'avi'].includes(ext)) {
              return await preloadVideo(file);
            } else {
              return await preloadImage(file);
            }
          } else {
            // Это имя файла или путь - используем resolvePlaceholder
            const placeholderData = await resolvePlaceholder(false);
            if (placeholderData && placeholderData.type) {
              if (placeholderData.type === 'video') {
                return await preloadVideo(placeholderData.src);
              } else {
                return await preloadImage(placeholderData.src);
              }
            }
            throw new Error('Placeholder not found');
          }
          
        default:
          throw new Error(`Unsupported content type: ${type}`);
      }
    } catch (error) {
      console.error(`[Player] ❌ Ошибка предзагрузки ${type}:`, error);
      throw error;
    }
  }
  
  /**
   * Получает DOM элемент для указанного типа контента
   */
  function getElementForContentType(type, placeholderType = null) {
    switch (type) {
      case 'video':
        return videoContainer;
      case 'image':
      case 'pdf':
      case 'pptx':
      case 'folder':
        return img1;
      case 'placeholder':
        // Для placeholder определяем элемент по типу заглушки
        if (placeholderType === 'video') {
          return videoContainer;
        } else {
          return img1;
        }
      default:
        return null;
    }
  }
  
  /**
   * Получает текущее состояние для перехода
   */
  function getCurrentStateForTransition() {
    const activeElement = [videoContainer, img1, pdf].find(el => 
      el && el.classList.contains('visible')
    );
    
    return {
      type: currentFileState.type || null,
      file: currentFileState.file || null,
      page: currentFileState.page || 1,
      element: activeElement || null
    };
  }
  
  /**
   * Плавное переключение между контентами (crossfade)
   */
  async function smoothTransition(fromState, toConfig, options = {}) {
    const {
      duration = TRANSITION_DURATION,
      crossfade = true,
      skipTransition = false,
      onProgress = null
    } = options;
    
    // Отменяем текущий переход, если есть
    if (currentTransition) {
      currentTransition.cancelled = true;
      currentTransition = null;
    }
    
    // Создаем объект перехода для отслеживания
    const transition = { cancelled: false };
    currentTransition = transition;
    
    try {
      const fromType = fromState?.type;
      const fromElement = fromState?.element;
      const toType = toConfig.type;
      const toFile = toConfig.file;
      const toPage = toConfig.page || 1;
      
      // Для placeholder определяем тип заглушки заранее (до предзагрузки)
      let placeholderType = null;
      if (toType === 'placeholder') {
        // Если file это URL, определяем тип по расширению
        if (toFile && (toFile.startsWith('/') || toFile.startsWith('http'))) {
          const ext = toFile.split('.').pop().toLowerCase().split('?')[0];
          placeholderType = ['mp4', 'webm', 'ogg', 'mkv', 'mov', 'avi'].includes(ext) ? 'video' : 'image';
        } else {
          // Используем cachedPlaceholderType если есть
          placeholderType = cachedPlaceholderType || 'image';
        }
      }
      
      // Определяем целевой элемент (может быть переопределен для placeholder после предзагрузки)
      let toElement = getElementForContentType(toType, placeholderType);
      if (!toElement && toType !== 'placeholder') {
        throw new Error(`No element for content type: ${toType}`);
      }
      
      // Проверяем, не тот же ли это контент
      const isSameContent = fromType === toType && 
                           fromState?.file === toFile && 
                           fromState?.page === toPage;
      
      if (isSameContent && fromElement && fromElement.classList.contains('visible')) {
        console.log('[Player] ℹ️ Тот же контент, переход не требуется');
        transition.cancelled = true;
        currentTransition = null;
        return;
      }
      
      // Предзагружаем новый контент
      if (onProgress) onProgress({ stage: 'preloading', progress: 0 });
      
      let preloadedData;
      try {
        preloadedData = await preloadContent(toType, toFile, toPage);
        
        // Если это placeholder и тип еще не определен, определяем по src
        if (toType === 'placeholder' && !placeholderType && preloadedData && preloadedData.src) {
          const ext = preloadedData.src.split('.').pop().toLowerCase().split('?')[0];
          placeholderType = ['mp4', 'webm', 'ogg', 'mkv', 'mov', 'avi'].includes(ext) ? 'video' : 'image';
          // Обновляем toElement на основе реального типа placeholder
          toElement = getElementForContentType(toType, placeholderType);
          if (!toElement) {
            throw new Error(`No element for placeholder type: ${placeholderType}`);
          }
        }
      } catch (error) {
        // Если предзагрузка не удалась, пробуем все равно показать (может быть кэш)
        console.warn('[Player] ⚠️ Предзагрузка не удалась, продолжаем:', error);
        preloadedData = null;
      }
      
      if (transition.cancelled) return;
      if (onProgress) onProgress({ stage: 'preloaded', progress: 50 });
      
      // Мгновенное переключение (без анимации)
    if (skipTransition) {
        // Скрываем старое
        if (fromElement && fromElement !== toElement) {
          fromElement.classList.remove('visible', 'preloading');
        }
        
        // Показываем новое
        if ((toType === 'video' || (toType === 'placeholder' && placeholderType === 'video')) && vjsPlayer && preloadedData) {
          // Для видео устанавливаем src и показываем
          if (vjsPlayer.currentSrc() !== preloadedData.src) {
            vjsPlayer.src({ src: preloadedData.src, type: 'video/mp4' });
          }
          vjsPlayer.loop(toType === 'placeholder' ? true : false); // Зацикливаем только placeholder
          if (toType === 'placeholder') {
            vjsPlayer.muted(true);
            vjsPlayer.volume(0);
          } else {
            applyVolumeToPlayer('prepare_new_video');
          }
          
          videoContainer.classList.remove('preloading');
          videoContainer.classList.add('visible');
          
          vjsPlayer.play().catch(() => {});
        } else if (preloadedData) {
          // Для изображений устанавливаем src и показываем
          toElement.removeAttribute('src');
          toElement.src = preloadedData.src;
          toElement.classList.remove('preloading');
          toElement.classList.add('visible');
        }
        
        // Скрываем другие элементы
        [videoContainer, img1, pdf].forEach(el => {
          if (el && el !== toElement) {
            el.classList.remove('visible', 'preloading');
          }
        });
        
        currentTransition = null;
      return;
    }
    
      // Плавное переключение
      const isSameElement = fromElement === toElement;
      const canCrossfade = crossfade && !isSameElement && fromElement && fromElement.classList.contains('visible');
      
      if (canCrossfade) {
        // Crossfade: одновременно fade-out старого и fade-in нового
        
        // 1. Подготовка нового элемента
        if ((toType === 'video' || (toType === 'placeholder' && placeholderType === 'video')) && vjsPlayer && preloadedData) {
          // Для видео устанавливаем src и готовим к показу
          if (vjsPlayer.currentSrc() !== preloadedData.src) {
            vjsPlayer.src({ src: preloadedData.src, type: 'video/mp4' });
          }
          vjsPlayer.loop(toType === 'placeholder' ? true : false); // Зацикливаем только placeholder
          if (toType === 'placeholder') {
            vjsPlayer.muted(true);
            vjsPlayer.volume(0);
          } else {
            applyVolumeToPlayer('prepare_new_video');
          }
          hideVideoJsControls();
          videoContainer.classList.add('preloading');
          
          // Ждем готовности видео
          await new Promise((resolve) => {
            if (vjsPlayer.readyState() >= 2) {
              resolve();
            } else {
              vjsPlayer.one('loadeddata', resolve);
            }
          });
          
          if (transition.cancelled) return;
        } else if (preloadedData) {
          // Для изображений устанавливаем src и готовим к показу
          toElement.removeAttribute('src');
          toElement.src = preloadedData.src;
          toElement.classList.add('preloading');
          
          // Ждем загрузки изображения
          if (preloadedData.image && preloadedData.image.complete) {
            // Уже загружено
          } else {
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error('Image load timeout')), 5000);
              toElement.onload = () => {
                clearTimeout(timeout);
                resolve();
              };
              toElement.onerror = () => {
                clearTimeout(timeout);
                reject(new Error('Image load error'));
              };
            });
          }
          
          if (transition.cancelled) return;
        }
        
        // 2. Одновременный crossfade
        toElement.style.opacity = '0';
        toElement.classList.remove('preloading');
        toElement.classList.add('visible');
        
        // Запускаем fade-out старого и fade-in нового одновременно
        fromElement.style.transition = `opacity ${duration}ms ease-in-out`;
        toElement.style.transition = `opacity ${duration}ms ease-in-out`;
        
        requestAnimationFrame(() => {
          if (transition.cancelled) return;
          
          fromElement.style.opacity = '0';
          toElement.style.opacity = '1';
          
          if (onProgress) onProgress({ stage: 'transitioning', progress: 75 });
        });
        
        // Ждем завершения перехода
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            resolve();
          }, duration + 50); // Небольшая задержка для завершения
          
          const onTransitionEnd = (e) => {
            if (e.target === fromElement || e.target === toElement) {
              clearTimeout(timeout);
              fromElement.removeEventListener('transitionend', onTransitionEnd);
              toElement.removeEventListener('transitionend', onTransitionEnd);
              resolve();
            }
          };
          
          fromElement.addEventListener('transitionend', onTransitionEnd);
          toElement.addEventListener('transitionend', onTransitionEnd);
        });
        
        if (transition.cancelled) return;
        
        // 3. Очистка после перехода
        fromElement.classList.remove('visible', 'preloading');
        fromElement.style.opacity = '';
        fromElement.style.transition = '';
        toElement.style.opacity = '';
        toElement.style.transition = '';
        
        // Останавливаем старое видео, если это был видео элемент
        if (fromElement === videoContainer && vjsPlayer) {
          vjsPlayer.pause();
        }
        
        // Запускаем новое видео, если это видео
        if (toElement === videoContainer && vjsPlayer) {
          vjsPlayer.play().catch(() => {});
        }
        
      } else {
        // Последовательное переключение: сначала fade-out старого, потом fade-in нового
        
        // 1. Fade-out старого
        if (fromElement && fromElement.classList.contains('visible')) {
          fromElement.style.transition = `opacity ${duration}ms ease-in-out`;
          fromElement.style.opacity = '0';
          
          await new Promise((resolve) => {
            const timeout = setTimeout(resolve, duration + 50);
            fromElement.addEventListener('transitionend', () => {
              clearTimeout(timeout);
              resolve();
            }, { once: true });
          });
          
          if (transition.cancelled) return;
          
          fromElement.classList.remove('visible', 'preloading');
          fromElement.style.opacity = '';
          fromElement.style.transition = '';
          
          // Останавливаем видео, если это был видео элемент
          if (fromElement === videoContainer && vjsPlayer) {
            vjsPlayer.pause();
          }
        }
        
        // 2. Подготовка нового элемента
        if ((toType === 'video' || (toType === 'placeholder' && placeholderType === 'video')) && vjsPlayer && preloadedData) {
          if (vjsPlayer.currentSrc() !== preloadedData.src) {
            vjsPlayer.src({ src: preloadedData.src, type: 'video/mp4' });
          }
          vjsPlayer.loop(toType === 'placeholder' ? true : false); // Зацикливаем только placeholder
          if (toType === 'placeholder') {
            vjsPlayer.muted(true);
            vjsPlayer.volume(0);
          } else {
            applyVolumeToPlayer('prepare_new_video');
          }
          hideVideoJsControls();
          videoContainer.classList.add('preloading');
          
          // Ждем готовности видео
          await new Promise((resolve) => {
            if (vjsPlayer.readyState() >= 2) {
              resolve();
            } else {
              vjsPlayer.one('loadeddata', resolve);
            }
          });
          
          if (transition.cancelled) return;
        } else if (preloadedData) {
          toElement.removeAttribute('src');
          toElement.src = preloadedData.src;
          toElement.classList.add('preloading');
          
          // Ждем загрузки изображения
          if (preloadedData.image && preloadedData.image.complete) {
            // Уже загружено
          } else {
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error('Image load timeout')), 5000);
              toElement.onload = () => {
                clearTimeout(timeout);
                resolve();
              };
              toElement.onerror = () => {
                clearTimeout(timeout);
                reject(new Error('Image load error'));
              };
            });
          }
          
          if (transition.cancelled) return;
        }
        
        // 3. Fade-in нового
        toElement.style.opacity = '0';
        toElement.classList.remove('preloading');
        toElement.classList.add('visible');
        
        // Скрываем другие элементы
        [videoContainer, img1, pdf].forEach(el => {
          if (el && el !== toElement) {
            el.classList.remove('visible', 'preloading');
          }
        });
        
        requestAnimationFrame(() => {
          if (transition.cancelled) return;
          
          toElement.style.transition = `opacity ${duration}ms ease-in-out`;
          toElement.style.opacity = '1';
          
          if (onProgress) onProgress({ stage: 'transitioning', progress: 90 });
        });
        
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, duration + 50);
          toElement.addEventListener('transitionend', () => {
            clearTimeout(timeout);
            resolve();
          }, { once: true });
        });
        
        if (transition.cancelled) return;
        
        toElement.style.opacity = '';
        toElement.style.transition = '';
        
        // Запускаем новое видео, если это видео
        if (toElement === videoContainer && vjsPlayer) {
          // Применяем настройки звука перед запуском (не для placeholder)
          if (toType !== 'placeholder') {
            applyVolumeToPlayer('canplay_autounmute');
          }
          vjsPlayer.play().catch(() => {});
        }
      }
      
      // Обновляем currentFileState после успешного перехода
      currentFileState = { 
        type: toType, 
        file: toFile, 
        page: toPage 
      };
      
      // Останавливаем отправку прогресса для не-видео контента
      if (toType !== 'video') {
        stopProgressInterval();
        if (typeof emitProgressStop === 'function') {
          emitProgressStop();
        }
      }
      
      // Устанавливаем правильный режим фона
      if (toType === 'video') {
        setBrandBackgroundMode('logo');
      } else {
        setBrandBackgroundMode('black');
      }
      
      if (onProgress) onProgress({ stage: 'completed', progress: 100 });
      currentTransition = null;
      
    } catch (error) {
      console.error('[Player] ❌ Ошибка плавного переключения:', error);
      currentTransition = null;
      throw error;
    }
  }
  
  // Плавный показ элемента (без черного экрана)
  function show(el, skipTransition = false, isSameType = false) {
    if (!el) {
      return;
    }
    
    // Убедимся что body прозрачный
    document.body.style.background = 'transparent';
    document.documentElement.style.background = 'transparent';
    
    // Если это переключение однотипного контента - не трогаем класс visible
    if (isSameType && el.classList.contains('visible')) {
      // Просто обновляем preloading статус
      el.classList.remove('preloading');
      // Скрываем только другие элементы
      [videoContainer, img1, pdf].forEach(e => {
        if (e && e !== el) {
          e.classList.remove('visible', 'preloading');
        }
      });
      return;
    }
    
    // КРИТИЧНО: Проверяем, что у img1 есть src перед показом
    if (el === img1 && (!el.src || el.src === '')) {
      console.warn('[Player] ⚠️ Попытка показать img1 без src, отменяем');
      // КРИТИЧНО: Убеждаемся что элемент скрыт, если нет src
      el.classList.remove('visible');
      return;
    }
    
    // Всегда мгновенный показ (черный экран убран)
    // Сначала показываем новый элемент
    el.classList.add('visible');
    el.classList.remove('preloading');
    
    // Потом скрываем остальные
    [videoContainer, img1, pdf].forEach(e => {
      if (e && e !== el) {
        e.classList.remove('visible', 'preloading');
      }
    });
  }
  
  // Предзагрузка элемента (скрыто)
  function preload(el) {
    if (!el) return;
    el.classList.remove('visible');
    el.classList.add('preloading');
  }

  function content(file){ 
    // НОВОЕ: Используем API resolver для поддержки shared storage (дедупликация)
    return `/api/files/resolve/${encodeURIComponent(device_id)}/${encodeURIComponent(file)}`; 
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
  // Возвращает: { src: string, mimeType: string } или null (заглушка не найдена, но сервер доступен)
  // Выбрасывает исключение только при реальных сетевых ошибках (сервер недоступен)
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
          
          // КРИТИЧНО: Проверяем что файл реально доступен (может быть удален после создания записи в API)
          // При force=true проверка тоже идет с cache-busting
          try {
            const checkUrl = url + cacheBuster;
            const checkRes = await fetchWithTimeout(checkUrl, { 
              method: 'HEAD',
              cache: force ? 'no-store' : 'default' // Обход HTTP кэша браузера
            }, 3000);
            
            if (checkRes.ok) {
              // Определяем тип по MIME type из метаданных
              const mimeType = data.mimeType || null;
              let type = null;
              
              if (mimeType) {
                // Определяем тип из MIME type
                if (mimeType.startsWith('image/')) {
                  type = 'image';
                } else if (mimeType.startsWith('video/')) {
                  type = 'video';
                }
            } else {
                // Fallback: определяем тип по расширению файла, если mimeType не доступен
                const fileName = data.placeholder || '';
                const ext = fileName.split('.').pop().toLowerCase();
                if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
                  type = 'image';
                } else if (['mp4', 'webm', 'ogg', 'mkv', 'mov', 'avi'].includes(ext)) {
                  type = 'video';
                }
              }
              
              // Возвращаем объект с URL и типом
              return { 
                src: url + cacheBuster,
                mimeType: mimeType,
                type: type
              };
            }
            // Файл недоступен (404 и т.д.) - сервер доступен, но заглушки нет
            return null;
          } catch (e) {
            // Ошибка сети при проверке файла - считаем это недоступностью сервера
            throw new Error('Network error checking placeholder file: ' + e.message);
          }
        }
        // API вернул ответ, но нет заглушки - сервер доступен, заглушки просто нет
        return null;
      }
      // API вернул не-OK статус (например, 404) - сервер доступен, но заглушки нет
      return null;
    } catch (e) {
      // Реальная сетевая ошибка (timeout, network error, CORS и т.д.) - сервер недоступен
      // Выбрасываем исключение, чтобы вызывающий код мог отличить это от "заглушки нет"
      throw new Error('Server unavailable: ' + e.message);
    }
  }

  let currentPlaceholderSrc = null; // Отслеживаем текущую заглушку
  let cachedPlaceholderSrc = null; // Кэшированная заглушка (для восстановления при ошибках)
  let cachedPlaceholderType = null; // Тип кэшированной заглушки ('video' или 'image')
  
  async function showPlaceholder(forceRefresh = false) {
    
    // При force refresh сбрасываем текущую заглушку для принудительной перезагрузки
    if (forceRefresh) {
      currentPlaceholderSrc = null;
    }
    
    let placeholderData = null;
    let serverUnavailable = false;
    
    try {
      placeholderData = await resolvePlaceholder(forceRefresh);
      // placeholderData === null означает, что заглушка не найдена, но сервер доступен
    } catch (e) {
      // Исключение означает, что сервер недоступен (сетевая ошибка)
      serverUnavailable = true;
    }
    
    const src = placeholderData ? placeholderData.src : null;
    const mimeType = placeholderData ? placeholderData.mimeType : null;
    let placeholderType = placeholderData ? placeholderData.type : null;
    
    // Fallback: если тип не определен из метаданных, пытаемся определить по расширению файла
    if (!placeholderType && src) {
      const fileName = src.split('/').pop().split('?')[0];
      const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
      if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
        placeholderType = 'image';
      } else if (['mp4', 'webm', 'ogg', 'mkv', 'mov', 'avi'].includes(ext)) {
        placeholderType = 'video';
      }
    }
    
    // КРИТИЧНО: Используем кэшированную заглушку ТОЛЬКО если сервер действительно недоступен
    if (serverUnavailable && cachedPlaceholderSrc && !forceRefresh) {
      console.log('[Player] ⚠️ Сервер недоступен, используем кэшированную заглушку');
      const cachedSrc = cachedPlaceholderSrc;
      const cachedType = cachedPlaceholderType;
      
      if (cachedType === 'video' && vjsPlayer) {
        // Восстанавливаем видео заглушку из кэша
        vjsPlayer.loop(true);
        vjsPlayer.muted(true);
        vjsPlayer.volume(0);
        currentPlaceholderSrc = cachedSrc;
        currentFileState = { type: 'placeholder', file: cachedSrc, page: 1 };
        hideVideoJsControls();
        
        vjsPlayer.src({ src: cachedSrc, type: 'video/mp4' });
        vjsPlayer.one('loadedmetadata', () => {
          hideVideoJsControls();
          vjsPlayer.one('loadeddata', () => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                videoContainer.classList.remove('preloading');
                videoContainer.classList.add('visible');
                // idle убран
                vjsPlayer.one('canplay', () => {
                  setTimeout(() => {
                    vjsPlayer.play().catch(err => {
                      console.error('[Player] ❌ Ошибка воспроизведения кэшированной заглушки:', err);
                    });
                  }, 200);
                });
              });
            });
          });
        });
        return;
      } else if (cachedType === 'image' && cachedSrc) {
        // Восстанавливаем изображение заглушку из кэша
        const tempImg = new Image();
        tempImg.onload = () => {
          // idle убран
          img.src = cachedSrc;
          currentPlaceholderSrc = cachedSrc;
          currentFileState = { type: 'placeholder', file: cachedSrc, page: 1 };
          // Если уже показывается изображение - не трогаем класс visible (однотипное переключение)
          const isSameTypeSwitch = img.classList.contains('visible');
          show(img, true, isSameTypeSwitch);
        };
        tempImg.onerror = () => {
          // Если даже кэш не загрузился - показываем ошибку
          // idle убран
          [videoContainer, img1, img2, pdf].forEach(el => el && el.classList.remove('visible', 'preloading'));
        };
        tempImg.src = cachedSrc;
        return;
      }
    }
    
    if (!src) {
      // Нет заглушки или сервер недоступен — сбрасываем состояние и прогресс,
      // чтобы панель спикера не показывала «висящий» контент.
      currentFileState = { type: 'idle', file: null, page: 1 };
      if (emitProgressStop) {
        emitProgressStop();
      }
      // КРИТИЧНО: Убираем черный экран, чтобы показывался бренд-фон
      // idle убран
      
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
        // В обычном плеере скрываем все слои (включая idle) - показывается бренд-фон
        [videoContainer, img1, pdf].forEach(el => el && el.classList.remove('visible', 'preloading'));
      }
      return;
    }
    
    // КРИТИЧНО: Если та же заглушка уже играет - не перезагружаем (кроме force refresh)
    // Также не прерываем воспроизведение при перезагрузке заглушки, если она уже играет
    const isSamePlaceholderPlaying = !forceRefresh && currentPlaceholderSrc === src && 
                                     ((vjsPlayer && !vjsPlayer.paused() && currentFileState.type === 'placeholder' && videoContainer.classList.contains('visible')) ||
                                      (img1.classList.contains('visible') && img1.src === src));
    if (isSamePlaceholderPlaying) {
      // КРИТИЧНО: Убеждаемся что черный экран скрыт
      // idle убран
      return;
    }
    
    currentPlaceholderSrc = src;
    currentFileState = { type: 'placeholder', file: src, page: 1 }; // КРИТИЧНО: Сбрасываем состояние
    
    // КРИТИЧНО: Отправляем сигнал об остановке прогресса при показе заглушки
    if (emitProgressStop) {
      emitProgressStop();
    }
    
    // Проверяем, что тип определен (из метаданных или fallback)
    if (!placeholderType) {
      console.error('[Player] ❌ Тип заглушки не определен из метаданных и не удалось определить по расширению', { src, mimeType });
      currentFileState = { type: 'idle', file: null, page: 1 };
      if (emitProgressStop) {
        emitProgressStop();
      }
      // idle убран
      [videoContainer, img1, img2, pdf].forEach(el => el && el.classList.remove('visible', 'preloading'));
      return;
    }
    
    // Сохраняем заглушку в кэш для использования при недоступности сервера
    if (src && placeholderType) {
    cachedPlaceholderSrc = src;
      cachedPlaceholderType = placeholderType;
    }
    
    // Определяем тип заглушки по метаданным (mimeType)
    const isImage = placeholderType === 'image';
    
    if (isImage) {
      // КРИТИЧНО: Скрываем видео и PDF перед показом изображения-заглушки
      if (vjsPlayer) {
        vjsPlayer.pause();
        // Скрываем videoContainer
        videoContainer.classList.remove('visible', 'preloading');
      }
      pdf.removeAttribute('src');
      pdf.classList.remove('visible', 'preloading');
      
      // КРИТИЧНО: Если уже показывается изображение (заглушка или другое) - не удаляем класс visible
      // Это предотвратит моргание при переключении заглушка-изображение → изображение
      const isImageCurrentlyVisible = img1.classList.contains('visible');
      if (!isImageCurrentlyVisible) {
        img1.classList.remove('preloading');
      }
      
      // КРИТИЧНО: Дожидаемся загрузки изображения ПЕРЕД показом!
      // Иначе показывается черный экран
      img.classList.add('preloading');
      const tempImg = new Image();
      
      const showImagePlaceholder = () => {
        // КРИТИЧНО: Для заглушки-изображения - просто замена src без переходов
        // Если уже показывается изображение - не трогаем класс visible, только обновляем src и убираем preloading
        img.src = src;
        if (isImageCurrentlyVisible && img.classList.contains('visible')) {
          // Однотипное переключение - только убираем preloading, не трогаем visible
          img.classList.remove('preloading');
        } else {
          // Если это смена типа или первое показывание - используем show()
          show(img, true, false);
        }
      };
      
      tempImg.onload = () => {
        // Тип уже сохранен в кэш выше на основе метаданных
        showImagePlaceholder();
      };
      
      tempImg.onerror = () => {
        console.error('[Player] ❌ Ошибка загрузки заглушки-изображения');
        
        // КРИТИЧНО: При ошибке загрузки используем кэшированную заглушку, если она есть
        if (cachedPlaceholderSrc && cachedPlaceholderSrc !== src) {
          console.log('[Player] ⚠️ Ошибка загрузки изображения, используем кэшированную заглушку');
          const cachedSrc = cachedPlaceholderSrc;
          const cachedType = cachedPlaceholderType;
          
          if (cachedType === 'video' && vjsPlayer) {
            // Используем видео заглушку из кэша
            vjsPlayer.loop(true);
            vjsPlayer.muted(true);
            vjsPlayer.volume(0);
            currentPlaceholderSrc = cachedSrc;
            currentFileState = { type: 'placeholder', file: cachedSrc, page: 1 };
            hideVideoJsControls();
            
            vjsPlayer.src({ src: cachedSrc, type: 'video/mp4' });
            vjsPlayer.one('loadedmetadata', () => {
              hideVideoJsControls();
              vjsPlayer.one('loadeddata', () => {
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => {
                    videoContainer.classList.remove('preloading');
                    videoContainer.classList.add('visible');
                    // idle убран
                    vjsPlayer.one('canplay', () => {
                      setTimeout(() => {
                        vjsPlayer.play().catch(err => {
                          console.error('[Player] ❌ Ошибка воспроизведения кэшированной заглушки:', err);
                        });
                      }, 200);
                    });
                  });
                });
              });
            });
            return;
          } else if (cachedType === 'image' && cachedSrc) {
            // Пробуем загрузить кэшированное изображение
            const cachedImg = new Image();
            cachedImg.onload = () => {
              // idle убран
              img.src = cachedSrc;
              currentPlaceholderSrc = cachedSrc;
              currentFileState = { type: 'placeholder', file: cachedSrc, page: 1 };
              show(img);
            };
            cachedImg.onerror = () => {
              // Если даже кэш не загрузился - показываем ошибку
              // idle убран
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
              } else {
                [videoContainer, img1, pdf].forEach(el => el && el.classList.remove('visible', 'preloading'));
              }
            };
            cachedImg.src = cachedSrc;
            return;
          }
        }
        
        // Если кэша нет - показываем ошибку
        // КРИТИЧНО: Убираем черный экран при ошибке загрузки
        // idle убран
        
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
        } else {
          // В обычном плеере скрываем все - показывается бренд-фон
          [videoContainer, img1, pdf].forEach(el => el && el.classList.remove('visible', 'preloading'));
        }
      };
      
      tempImg.src = src;
      
      // КРИТИЧНО: Если изображение уже загружено (например из кэша),
      // событие onload НЕ сработает! Проверяем и показываем сразу
      if (tempImg.complete && tempImg.naturalWidth > 0) {
        showImagePlaceholder();
      }
    } else {
      // Видео заглушка через Video.js
      
      if (vjsPlayer) {
            // КРИТИЧНО: Финальная проверка доступности ПЕРЕД установкой src в Video.js
            // Избегаем ошибок "no supported source" для несуществующих файлов
            (async () => {
              try {
                const finalCheck = await fetch(src, { method: 'HEAD' });
                if (!finalCheck.ok) {
                  console.error(`[Player] ❌ Файл заглушки недоступен: ${finalCheck.status}`);
                  
                  // Статус не OK (например, 404) - сервер доступен, но файл не найден
                  // Не используем кэшированную заглушку, просто логируем ошибку
                      return;
                }
                
                // Файл доступен - продолжаем загрузку
                // Тип уже сохранен в кэш выше на основе метаданных
            
            vjsPlayer.loop(true);
            vjsPlayer.muted(true);
            vjsPlayer.volume(0);
            
            // КРИТИЧНО: Скрываем контролы
            hideVideoJsControls();
            
            // КРИТИЧНО: Проверяем, не играет ли уже эта заглушка - не показываем черный экран
            const isAlreadyPlayingPlaceholder = currentPlaceholderSrc === src && 
                                                 vjsPlayer && !vjsPlayer.paused() && 
                                                 videoContainer.classList.contains('visible');
            
            if (isAlreadyPlayingPlaceholder && !forceRefresh) {
              // Заглушка уже играет - ничего не делаем, убираем черный экран
              // idle убран
              return;
            }
            
            // Делаем плавный переход как видео→видео: слой уходит в прозрачность, под ним виден бренд-фон
            const TRANSITION_MS_PLACEHOLDER = 500;
            const needFadeOutPlaceholder = videoContainer.classList.contains('visible');
            
            // КРИТИЧНО: Не скрываем videoContainer если заглушка уже играет
            if (!isAlreadyPlayingPlaceholder) {
              videoContainer.classList.remove('visible');
              videoContainer.classList.add('preloading');
            }
            
            const setPlaceholderSrcAndShow = () => {
              // КРИТИЧНО: Проверяем еще раз, не играет ли уже эта заглушка
              const isStillPlaying = currentPlaceholderSrc === src && 
                                       vjsPlayer && !vjsPlayer.paused() && 
                                       videoContainer.classList.contains('visible');
              
              if (isStillPlaying && !forceRefresh) {
                // Заглушка уже играет - ничего не делаем, только убираем черный экран
                // idle убран
                return;
              }
              
              vjsPlayer.src({ src: src, type: 'video/mp4' });
              
              // Ждем готовности метаданных, затем показываем новый слой с fade-in
              vjsPlayer.one('loadedmetadata', () => {
                hideVideoJsControls();
                
                // Ждём loadeddata (первый кадр загружен) перед показом
                vjsPlayer.one('loadeddata', () => {
                  
                  // Двойной requestAnimationFrame для гарантии, что браузер готов к рендерингу
                  requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                      videoContainer.classList.remove('preloading');
                      videoContainer.classList.add('visible');
                      // КРИТИЧНО: Убираем черный экран сразу, не ждем fade-in
                      // idle убран
                      
                      // Ждём canplay перед запуском воспроизведения
                      vjsPlayer.one('canplay', () => {
                        // Задержка для завершения CSS fade-in (500ms transition)
                        setTimeout(() => {
                          vjsPlayer.play().then(() => {
                          }).catch(err => {
                            console.error('[Player] ❌ Ошибка запуска заглушки:', err);
                          });
                        }, 200); // Задержка для завершения fade-in
                      });
                    });
                  });
                });
              });
            };
            
            // Если слой был видимым — дождёмся завершения fade-out, иначе сразу ставим заглушку
            if (needFadeOutPlaceholder && !isAlreadyPlayingPlaceholder) {
              waitForOpacityTransitionEnd(videoContainer, 'opacity', TRANSITION_MS_PLACEHOLDER + 150)
                .then(() => setPlaceholderSrcAndShow());
            } else {
              setPlaceholderSrcAndShow();
            }
          } catch (e) {
            console.error('[Player] ❌ Ошибка проверки или загрузки заглушки:', e);
            
            // КРИТИЧНО: При ошибке загрузки используем кэшированную заглушку, если она есть
            if (cachedPlaceholderSrc) {
              console.log('[Player] ⚠️ Ошибка загрузки, используем кэшированную заглушку');
              const cachedSrc = cachedPlaceholderSrc;
              const cachedType = cachedPlaceholderType;
              if (cachedType === 'video' && vjsPlayer) {
                vjsPlayer.loop(true);
                vjsPlayer.muted(true);
                vjsPlayer.volume(0);
                currentPlaceholderSrc = cachedSrc;
                currentFileState = { type: 'placeholder', file: cachedSrc, page: 1 };
                hideVideoJsControls();
                
                vjsPlayer.src({ src: cachedSrc, type: 'video/mp4' });
                vjsPlayer.one('loadedmetadata', () => {
                  hideVideoJsControls();
                  vjsPlayer.one('loadeddata', () => {
                    requestAnimationFrame(() => {
                      requestAnimationFrame(() => {
                        videoContainer.classList.remove('preloading');
                        videoContainer.classList.add('visible');
                        // idle убран
                        vjsPlayer.one('canplay', () => {
                          setTimeout(() => {
                            vjsPlayer.play().catch(err => {
                              console.error('[Player] ❌ Ошибка воспроизведения кэшированной заглушки:', err);
                            });
                          }, 200);
                        });
                      });
                    });
                  });
                });
                return;
              } else if (cachedType === 'image') {
                const tempImg = new Image();
                tempImg.onload = () => {
                  // idle убран
                  img.src = cachedSrc;
                  currentPlaceholderSrc = cachedSrc;
                  currentFileState = { type: 'placeholder', file: cachedSrc, page: 1 };
                  show(img);
                };
                tempImg.src = cachedSrc;
                return;
              }
            }
            
            // Если кэша нет - показываем ошибку
            // КРИТИЧНО: Убираем черный экран при ошибке
            // idle убран
            // Скрываем все слои - показывается бренд-фон
            [videoContainer, img1, pdf].forEach(el => el && el.classList.remove('visible', 'preloading'));
          }
        })();
      } else {
        console.error('[Player] ❌ vjsPlayer не инициализирован!');
      }
    }
  }

  // Предзагрузка всех слайдов PPTX/PDF в кэш
  async function preloadAllSlides(file, type) {
    try {
      
      // Получаем количество слайдов через API (используем query параметр для поддержки пробелов в именах)
      const response = await fetch(`/api/devices/${encodeURIComponent(device_id)}/slides-count?file=${encodeURIComponent(file)}`);
      if (!response.ok) {
        return;
      }
      
      const data = await response.json();
      const count = data.count || 0;
      
      if (count === 0) {
        return;
      }
      
      
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
            resolve();
          };
          imgObj.onerror = () => {
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
      
    } catch (error) {
      console.error('[Player] ❌ Ошибка предзагрузки слайдов:', error);
    }
  }

  // Предзагрузка всех изображений из папки в кэш
  async function preloadAllFolderImages(folderName) {
    try {
      
      // Получаем список изображений через API
      const response = await fetch(`/api/devices/${encodeURIComponent(device_id)}/folder/${encodeURIComponent(folderName)}/images`);
      if (!response.ok) {
        return;
      }
      
      const data = await response.json();
      const imageList = data.images || [];
      const count = imageList.length;
      
      if (count === 0) {
        return;
      }
      
      
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
            resolve();
          };
          imgObj.onerror = () => {
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
      
    } catch (error) {
      console.error('[Player] ❌ Ошибка предзагрузки изображений из папки:', error);
    }
  }

  // Показать изображение из папки
  function showFolderImage(folderName, num, isTypeChange = false) {
    // Проверяем номер изображения ДО обновления currentFileState
    const previousPage = currentFileState.type === 'folder' && currentFileState.file === folderName 
                        ? currentFileState.page 
                        : null;
    
    // Защита от повторных вызовов: если уже показывается то же изображение, игнорируем
    if (!isTypeChange && previousPage === num && img1.classList.contains('visible')) {
      // Проверяем, действительно ли src соответствует нужному изображению
      const expectedUrl = `/api/devices/${encodeURIComponent(device_id)}/folder/${encodeURIComponent(folderName)}/image/${num}`;
      if (img1.src && (img1.src.includes(`/image/${num}`) || img1.src.endsWith(`/image/${num}`))) {
        // КРИТИЧНО: Убеждаемся что черный экран скрыт
        // idle убран
        return; // Уже показывается то же изображение с правильным src
      }
    }
    
    // Если isTypeChange не передан, определяем автоматически
    if (isTypeChange === false) {
      const previousType = currentFileState.type;
      isTypeChange = previousType && previousType !== 'folder';
    }
    
    // КРИТИЧНО: Обновляем currentFileState СРАЗУ, чтобы он был актуальным
    currentFileState = { type: 'folder', file: folderName, page: num };
    
    // КРИТИЧНО: При переключении изображения → изображение скрываем черный экран сразу
    if (!isTypeChange && previousPage !== null) {
      // idle убран
    }
    
    // КРИТИЧНО: Полностью очищаем все буферы при переключении на папку
    if (isTypeChange) {
      clearAllBuffers();
    } else {
      // Если это просто переключение внутри папки, очищаем только видео и PDF
    if (vjsPlayer) {
      vjsPlayer.pause();
      vjsPlayer.currentTime(0);
        // НЕ устанавливаем пустой src - это вызывает ошибку
        // Просто останавливаем и очищаем состояние через load()
        try {
          vjsPlayer.load();
        } catch (e) {
          // Игнорируем ошибки
        }
      hideVideoJsControls();
    }
      stopProgressInterval();
      if (typeof emitProgressStop === 'function') {
        emitProgressStop();
      }
      videoContainer.classList.remove('visible', 'preloading');
      if (pdf) {
    pdf.removeAttribute('src');
        pdf.src = '';
    pdf.classList.remove('visible', 'preloading');
        // Убираем все inline стили при остановке папок/PDF/PPTX
        pdf.removeAttribute('style');
      }
    }
    
    // Для папок (слайд-шоу) фон ДОЛЖЕН быть черным, без логотипа
    setBrandBackgroundMode('black');
    
    // КРИТИЧНО: При переключении изображения → изображение черный экран НЕ показывается
    // Убеждаемся что idle скрыт перед началом переключения
    if (!isTypeChange && previousPage !== null) {
      // idle убран
      // Также очищаем inline opacity если был установлен
      // idle убран
    }
    
    // Папки - это изображения, всегда мгновенный показ
    
    // Проверяем кэш
    if (slidesCache[folderName] && slidesCache[folderName].images) {
      const cached = slidesCache[folderName];
      const index = Math.max(0, Math.min(num - 1, cached.count - 1));
      const cachedImage = cached.images[index];
      
      if (cachedImage && cachedImage.complete && cachedImage.naturalWidth > 0) {
        // КРИТИЧНО: Формируем правильный URL для сравнения
        const expectedUrl = `/api/devices/${encodeURIComponent(device_id)}/folder/${encodeURIComponent(folderName)}/image/${num}`;
        const cachedSrc = cachedImage.src || expectedUrl;
        
        // Всегда мгновенный показ - папки это изображения
        // КРИТИЧНО: Принудительно обновляем src даже если он кажется таким же
        // Это гарантирует обновление при переключении изображений
        img1.classList.add('preloading');
        if (img1.src !== cachedSrc) {
          img1.removeAttribute('src');
          img1.src = cachedSrc;
        } else {
          // Если src совпадает, принудительно обновляем для гарантии
          img1.removeAttribute('src');
          img1.src = cachedSrc;
        }
        
        // Очищаем inline opacity если был установлен
        img1.style.opacity = '';
        // Если уже показывается изображение - не трогаем класс visible, только обновляем preloading
        if (img1.classList.contains('visible') && !isTypeChange) {
          // Однотипное переключение - только обновляем preloading, не трогаем visible
          img1.classList.remove('preloading');
          return;
        }
        // Если это смена типа или первое показывание - используем show()
        show(img1, true, false);
        return;
      }
    }
    
    // Fallback: загружаем через API если нет в кэше
    const imageUrl = `/api/devices/${encodeURIComponent(device_id)}/folder/${encodeURIComponent(folderName)}/image/${num}`;
    
    // КРИТИЧНО: Принудительно обновляем src при переключении
    img1.classList.add('preloading');
    if (img1.src !== imageUrl) {
      // Удаляем старый src для гарантии обновления
      img1.removeAttribute('src');
    }
    
    // Предзагружаем изображение
    const tempImg = new Image();
    tempImg.onload = () => {
      // Изображение предзагружено, теперь безопасно устанавливаем src
      
      // Всегда мгновенный показ - папки это изображения
      // tempImg уже загружен, устанавливаем src и мгновенно показываем
      if (img1.src !== imageUrl) {
        img1.removeAttribute('src');
        img1.src = imageUrl;
      }
      
      // Очищаем inline opacity если был установлен
      img1.style.opacity = '';
      // Если уже показывается изображение - не трогаем класс visible, только обновляем preloading
      if (img1.classList.contains('visible') && !isTypeChange) {
        // Однотипное переключение - только обновляем preloading, не трогаем visible
        img1.classList.remove('preloading');
        // НЕ отправляем прогресс - выделение обновится через preview/refresh от сервера
        return;
      }
      // Если это смена типа или первое показывание - используем show()
      show(img1, true, false);
      // НЕ отправляем прогресс - выделение обновится через preview/refresh от сервера
    };
    tempImg.onerror = () => {
      console.error(`[Player] ❌ Ошибка загрузки изображения ${num}`);
      img1.src = imageUrl;
      // При ошибке тоже используем черный экран
      [videoContainer, img1, pdf].forEach(e => {
        if (e) e.classList.remove('visible', 'preloading');
      });
      // idle убран
      setTimeout(() => {
        // КРИТИЧНО: Проверяем, что src установлен перед показом
        if (img1.src && img1.src !== '') {
          // КРИТИЧНО: Проверяем, что src установлен перед показом
          if (img1.src && img1.src !== '') {
            img1.classList.add('visible');
          } else {
            console.warn('[Player] ⚠️ Попытка показать img1 без src, пропускаем');
          }
        } else {
          console.warn('[Player] ⚠️ Попытка показать img1 без src, пропускаем');
        }
        // idle убран
      }, 500);
    };
    tempImg.src = imageUrl;
  }

  function showConvertedPage(file, type, num, isTypeChange = false) {
    // Определяем тип контента (pdf или pptx)
    const contentType = type === 'page' ? 'pdf' : 'pptx';
    
    // Если isTypeChange не передан, определяем автоматически
    if (isTypeChange === false) {
      const previousType = currentFileState.type;
      isTypeChange = previousType && previousType !== contentType;
    }
    
    // КРИТИЧНО: Обновляем currentFileState СРАЗУ, чтобы он был актуальным
    currentFileState = { type: contentType, file: file, page: num };
    
    // НЕ отправляем прогресс для PDF/PPTX - выделение обновится через preview/refresh от сервера
    // (как в Android плеере)
    
    // КРИТИЧНО: Полностью очищаем все буферы при переключении на PDF/PPTX
    if (isTypeChange) {
      clearAllBuffers();
    } else {
      // Если это просто переключение внутри презентации, очищаем только видео
    if (vjsPlayer) {
      vjsPlayer.pause();
      vjsPlayer.currentTime(0);
        // НЕ устанавливаем пустой src - это вызывает ошибку
        // Просто останавливаем и очищаем состояние через load()
        try {
          vjsPlayer.load();
        } catch (e) {
          // Игнорируем ошибки
        }
      hideVideoJsControls();
    }
      stopProgressInterval();
      if (typeof emitProgressStop === 'function') {
        emitProgressStop();
      }
    videoContainer.classList.remove('visible', 'preloading');
      if (pdf) {
        pdf.removeAttribute('src');
        pdf.src = '';
        pdf.classList.remove('visible', 'preloading');
        // Убираем все inline стили при остановке папок/PDF/PPTX
        pdf.removeAttribute('style');
      }
      // Очищаем буфер изображений
    img1.classList.remove('visible', 'preloading');
    }
    
    // Для презентаций фон ДОЛЖЕН быть черным, без логотипа
    setBrandBackgroundMode('black');
    
    // Определяем, это первый показ презентации или переключение слайдов
    const isFirstShow = !img1.classList.contains('visible');
    
    // Проверяем кэш
    if (slidesCache[file] && slidesCache[file].images) {
      const cached = slidesCache[file];
      const index = Math.max(0, Math.min(num - 1, cached.count - 1));
      const cachedImage = cached.images[index];
      
      if (cachedImage && cachedImage.complete && cachedImage.naturalWidth > 0) {
        
        // Загружаем изображение
        img1.classList.add('preloading');
        img1.src = cachedImage.src;
        
        // Первый показ - сразу черный, потом фиксированный fade in; переключение слайдов - мгновенно
        if (isFirstShow) {
          // Сразу черный экран - убираем preloading перед показом
          [videoContainer, img1, pdf].forEach(e => {
            if (e) e.classList.remove('visible', 'preloading');
          });
          // idle убран
          
          // Затем fade in слайда (фиксированное время)
          setTimeout(() => {
            // КРИТИЧНО: Проверяем, что src установлен перед показом
          if (img1.src && img1.src !== '') {
            img1.classList.add('visible');
            // НЕ отправляем прогресс - выделение обновится через preview/refresh от сервера
          } else {
            console.warn('[Player] ⚠️ Попытка показать img1 без src, пропускаем');
          }
            // idle убран
          }, 500);
        } else {
          // Переключение внутри презентации - не трогаем класс visible, только обновляем preloading
          if (img1.classList.contains('visible') && !isTypeChange) {
            // Однотипное переключение - только убираем preloading, не трогаем visible
            img1.classList.remove('preloading');
            // НЕ отправляем прогресс - выделение обновится через preview/refresh от сервера
          } else {
            // Если это смена типа или первое показывание - используем show()
            show(img1, true, false);
            // НЕ отправляем прогресс - выделение обновится через preview/refresh от сервера
          }
        }
        return;
      }
    }
    
    // Fallback: загружаем через API если нет в кэше
    const imageUrl = `/api/devices/${encodeURIComponent(device_id)}/converted/${encodeURIComponent(file)}/${type}/${num}`;
    
    // Предзагружаем изображение
    img1.classList.add('preloading');
    const tempImg = new Image();
    tempImg.onload = () => {
      
      // Устанавливаем изображение
      img1.src = imageUrl;
      
      // Первый показ - сразу черный, потом фиксированный fade in; переключение слайдов - мгновенно
      if (isFirstShow) {
        // Сразу черный экран
        [videoContainer, img1, pdf].forEach(e => {
          if (e) e.classList.remove('visible', 'preloading');
        });
        // idle убран
        
        // Затем fade in слайда (фиксированное время)
        setTimeout(() => {
          // КРИТИЧНО: Проверяем, что src установлен перед показом
          if (img1.src && img1.src !== '') {
            img1.classList.add('visible');
            // НЕ отправляем прогресс - выделение обновится через preview/refresh от сервера
          } else {
            console.warn('[Player] ⚠️ Попытка показать img1 без src, пропускаем');
          }
          // idle убран
        }, 500);
      } else {
        // Переключение внутри презентации - не трогаем класс visible, только обновляем preloading
        if (img1.classList.contains('visible') && !isTypeChange) {
          // Однотипное переключение - только убираем preloading, не трогаем visible
          img1.classList.remove('preloading');
          // КРИТИЧНО: Отправляем на сервер информацию о текущей странице для синхронизации выделения
          sendPageProgress();
        } else {
          // Если это смена типа или первое показывание - используем show()
          show(img1, true, false);
          // КРИТИЧНО: Отправляем на сервер информацию о текущей странице для синхронизации выделения
          sendPageProgress();
        }
      }
    };
    tempImg.onerror = () => {
      console.error(`[Player] ❌ Ошибка загрузки слайда ${num}`);
      img1.src = imageUrl;
      const isSameTypeSwitch = !isFirstShow && img1.classList.contains('visible') && !isTypeChange;
      show(img1, isFirstShow ? false : true, isSameTypeSwitch);
    };
    tempImg.src = imageUrl;
  }

  // WebSocket обработчики
  socket.on('player/play', ({ type, file, page }) => {
    // КРИТИЧНО: Останавливаем заглушку при любой команде от спикера
    if (currentFileState.type === 'placeholder') {
      if (vjsPlayer && !vjsPlayer.paused()) {
        vjsPlayer.pause();
      }
      // Скрываем заглушку (изображение или видео)
      [videoContainer, img1].forEach(e => {
        if (e) e.classList.remove('visible', 'preloading');
      });
      currentPlaceholderSrc = null;
    }
    
    if (type === 'video') {
      if (!file && vjsPlayer) {
        // Resume текущего видео (нет файла = продолжить с паузы)
        // НЕ очищаем буферы - продолжаем то же видео
        currentFileState = { type: 'video', file: currentFileState.file, page: 1 };
        
        applyVolumeToPlayer('resume_video');
        
        // Не трогаем currentTime - продолжаем с места паузы
        vjsPlayer.play().then(() => {
        }).catch(err => {
          console.error('[Player] ❌ Ошибка resume:', err);
        });
        return;
      }
      
      if (file) {
        const fileUrl = content(file);
        
        // Проверяем, не тот же ли файл уже загружен
        const currentSrc = vjsPlayer ? vjsPlayer.currentSrc() : '';
        const isSameFile = currentSrc.includes(encodeURIComponent(file)) || currentSrc.endsWith(fileUrl);
        
        // Проверяем, меняется ли тип контента
        // КРИТИЧНО: Если предыдущий тип был НЕ 'video', а сейчас включается 'video' - это смена типа
        // Даже если файл тот же (видео -> картинка -> то же видео должно начаться с начала)
        const previousType = currentFileState.type;
        const isTypeChange = previousType && previousType !== 'video';
        const isBackToVideo = previousType && previousType !== 'video' && previousType !== null && type === 'video';
        
        // Возобновляем только если:
        // 1. Тот же файл И
        // 2. Предыдущий тип был 'video' И
        // 3. Не было смены типа (не переключались на картинку/PDF/папку)
        if (isSameFile && vjsPlayer && previousType === 'video' && !isTypeChange && !isBackToVideo) {
          // Тот же файл и тот же тип - просто возобновляем (это нажатие Play после паузы или переподключение)
          currentFileState = { type: 'video', file, page: 1 };
          
          applyVolumeToPlayer('resume_video_same_file');
          
          // Показываем videoContainer если он скрыт (без трогания display)
          if (!videoContainer.classList.contains('visible')) {
            show(videoContainer);
          }
          
          // КРИТИЧНО: НЕ проверяем ended() на Android - он врет после паузы!
          // Просто возобновляем с текущей позиции (currentTime сохраняется)
          // КРИТИЧНО: При переподключении видео продолжает играть из кэша браузера
          // Не перезагружаем src - просто возобновляем воспроизведение если оно остановилось
          if (vjsPlayer.paused()) {
            vjsPlayer.play().then(() => {
              console.log('[Player] ✅ Возобновлено воспроизведение того же файла');
            }).catch(err => {
              console.error('[Player] ❌ Ошибка resume:', err);
            });
          } else {
            // Видео уже играет - ничего не делаем, продолжаем воспроизведение
            console.log('[Player] ✅ Видео уже играет, продолжаем...');
          }
          return;
        }
        
        // Новый файл или смена типа контента - загружаем с начала
        currentFileState = { type: 'video', file, page: 1 };
        
        // КРИТИЧНО: Полностью очищаем все буферы при переключении на видео
        // Это также включает возврат к видео после картинки/PDF/папки (isBackToVideo)
        if (isTypeChange || isBackToVideo) {
          clearAllBuffers();
          // КРИТИЧНО: Сбрасываем позицию видео в начало при возврате к видео после другого типа контента
          if (vjsPlayer && isBackToVideo) {
            vjsPlayer.pause();
            vjsPlayer.currentTime(0);
          }
        } else {
          // Если это просто новое видео (не смена типа), очищаем только изображения
          // КРИТИЧНО: Сразу очищаем img1, чтобы не показывалась старая картинка
          img1.removeAttribute('src');
          img1.src = '';
          img1.classList.remove('visible', 'preloading');
          // Убираем все inline стили при остановке папок/PDF/PPTX
          img1.removeAttribute('style');
          if (pdf) {
            pdf.removeAttribute('src');
            pdf.src = '';
            pdf.classList.remove('visible', 'preloading');
            // Убираем все inline стили при остановке
            pdf.removeAttribute('style');
          }
        }
        
        // Очищаем кэш слайдов для освобождения памяти
        slidesCache = {};
        
        // Плавный переход через бренд‑фон (без черного экрана)
        // Шаг 1: уводим текущий видео-слой в прозрачность (старое видео продолжает играть во время fade-out)
        // КРИТИЧНО: Сразу скрываем img1, чтобы не показывалась старая картинка
        img1.classList.remove('visible', 'preloading');
        
        const TRANSITION_MS = 500;
        const needFadeOut = videoContainer.classList.contains('visible');
        videoContainer.classList.remove('visible');
        videoContainer.classList.add('preloading');
        
        if (vjsPlayer) {
          vjsPlayer.loop(false);
          applyVolumeToPlayer('prepare_new_video');
          
          // Скрываем контролы ДО установки src
          hideVideoJsControls();
          
          const setSrcAndShow = () => {
            // КРИТИЧНО: Проверяем существование файла перед установкой src (защита от 404)
            fetch(fileUrl, { method: 'HEAD', cache: 'no-store' })
              .then(response => {
                if (!response.ok) {
                  // Файл не существует (404) - не загружаем, возвращаемся к заглушке
                  console.error(`[Player] ❌ Файл недоступен (${response.status}): ${file}`);
                  
                  // Отменяем fade-out и возвращаемся к текущему контенту или заглушке
                  videoContainer.classList.remove('preloading');
                  
                  // КРИТИЧНО: Проверяем, играет ли уже другой файл
                  const currentSrc = vjsPlayer ? vjsPlayer.currentSrc() : '';
                  const hasCurrentVideo = currentSrc && currentFileState.type === 'video' && currentFileState.file && 
                                         currentFileState.file !== file && videoContainer.classList.contains('visible');
                  
                  if (hasCurrentVideo && vjsPlayer && !vjsPlayer.paused()) {
                    // Другое видео уже играет - продолжаем его, не перезагружаем
                    console.log('[Player] ✅ Файл недоступен, продолжаем воспроизведение текущего видео:', currentFileState.file);
                    videoContainer.classList.add('visible');
                    // Не меняем currentFileState - оставляем текущий файл
                  } else {
                    // Видео не было или остановлено - возвращаемся к заглушке
                    console.log('[Player] ℹ️ Файл недоступен, возвращаемся к заглушке');
                    if (cachedPlaceholderSrc) {
                      currentPlaceholderSrc = cachedPlaceholderSrc;
                      currentFileState = { type: 'placeholder', file: cachedPlaceholderSrc, page: 1 };
                      // Загружаем заглушку
                      if (cachedPlaceholderType === 'video' && vjsPlayer) {
                        vjsPlayer.src({ src: cachedPlaceholderSrc, type: 'video/mp4' });
                        vjsPlayer.loop(true);
                        vjsPlayer.muted(true);
                        vjsPlayer.volume(0);
                        hideVideoJsControls();
                        vjsPlayer.one('loadedmetadata', () => {
                          hideVideoJsControls();
                          vjsPlayer.one('loadeddata', () => {
                            requestAnimationFrame(() => {
                              requestAnimationFrame(() => {
                                videoContainer.classList.remove('preloading');
                                videoContainer.classList.add('visible');
                                // idle убран
                                vjsPlayer.one('canplay', () => {
                                  setTimeout(() => {
                                    vjsPlayer.play().catch(err => {
                                      console.error('[Player] ❌ Ошибка воспроизведения кэшированной заглушки:', err);
                                    });
                                  }, 200);
                                });
                              });
                            });
                          });
                        });
                      } else if (cachedPlaceholderType === 'image') {
                        const tempImg = new Image();
                        tempImg.onload = () => {
                          // idle убран
                          img.src = cachedPlaceholderSrc;
                          // Если уже показывается изображение - не трогаем класс visible (однотипное переключение)
                          const isSameTypeSwitch = img.classList.contains('visible');
                          show(img, true, isSameTypeSwitch);
                        };
                        tempImg.src = cachedPlaceholderSrc;
                      }
                    } else {
                      showPlaceholder();
                    }
                  }
                  return;
                }
                
                // Файл существует - загружаем его
                // Шаг 2: меняем источник ПОСЛЕ завершения fade-out
                vjsPlayer.src({ src: fileUrl, type: 'video/mp4' });
                // Шаг 3: ждём готовности и показываем новый слой с fade-in
                vjsPlayer.one('loadedmetadata', () => {
                  hideVideoJsControls();
                  
                  // Ждём loadeddata (первый кадр загружен) перед показом
                  vjsPlayer.one('loadeddata', () => {
                    
                    // Двойной requestAnimationFrame для гарантии, что браузер готов к рендерингу
                    requestAnimationFrame(() => {
                      requestAnimationFrame(() => {
                        videoContainer.classList.remove('preloading');
                        videoContainer.classList.add('visible');
                        
                        // Ждём canplay перед запуском воспроизведения
                        vjsPlayer.one('canplay', () => {
                          // Задержка для завершения CSS fade-in (500ms transition)
                          setTimeout(() => {
                            vjsPlayer.play().then(() => {
                              setTimeout(() => {
                                applyVolumeToPlayer('canplay_autounmute');
                              }, 200);
                            }).catch(err => {
                              console.error('[Player] ❌ Ошибка воспроизведения:', err);
                              hideVideoJsControls();
                            });
                          }, 200); // Задержка для завершения fade-in
                        });
                      });
                    });
                  });
                });
              })
              .catch(error => {
                // Ошибка сети при проверке - пробуем загрузить (может быть временная проблема)
                console.warn(`[Player] ⚠️ Ошибка проверки файла: ${error.message}, пробуем загрузить...`);
                
                // Пробуем загрузить файл (может быть временная проблема сети)
                vjsPlayer.src({ src: fileUrl, type: 'video/mp4' });
                vjsPlayer.one('loadedmetadata', () => {
                  hideVideoJsControls();
                  vjsPlayer.one('loadeddata', () => {
                    requestAnimationFrame(() => {
                      requestAnimationFrame(() => {
                        videoContainer.classList.remove('preloading');
                        videoContainer.classList.add('visible');
                        vjsPlayer.one('canplay', () => {
                          setTimeout(() => {
                            vjsPlayer.play().then(() => {
                              setTimeout(() => {
                                applyVolumeToPlayer('canplay_autounmute');
                              }, 200);
                            }).catch(err => {
                              console.error('[Player] ❌ Ошибка воспроизведения:', err);
                              hideVideoJsControls();
                            });
                          }, 200);
                        });
                      });
                    });
                  });
                });
              });
          };
          
          // Если был видимым — дождёмся завершения CSS fade-out (transitionend с таймаутом)
          if (needFadeOut) {
            waitForOpacityTransitionEnd(videoContainer, 'opacity', TRANSITION_MS + 150).then(() => {
              setSrcAndShow();
            });
          } else {
            setSrcAndShow();
          }
        }
      }
    } else if (type === 'image' && file) {
      // Используем плавное переключение для изображений
      const fromState = getCurrentStateForTransition();
      const isTypeChange = fromState.type && fromState.type !== 'image';
      
      // Для однотипного переключения используем crossfade, для смены типа - последовательное
      const useCrossfade = !isTypeChange && fromState.type === 'image';
      
      smoothTransition(fromState, {
        type: 'image',
        file: file,
        page: 1
      }, {
        crossfade: useCrossfade,
        skipTransition: false
      }).catch(error => {
        console.error('[Player] ❌ Ошибка переключения на изображение:', error);
        // Fallback на старый метод при ошибке
      const imageUrl = content(file);
        img1.src = imageUrl;
        show(img1);
      });
    } else if (type === 'pdf' && file) {
      const pageNum = page || 1;
      
      // КРИТИЧНО: Устанавливаем currentFileState сразу, чтобы обработчики pdfPage/pdfPrev/pdfNext работали
      currentFileState = { type: 'pdf', file: file, page: pageNum };
      
      const fromState = getCurrentStateForTransition();
      const contentType = 'pdf';
      const isTypeChange = fromState.type && fromState.type !== contentType;
      
      // Для однотипного переключения используем crossfade
      const useCrossfade = !isTypeChange && fromState.type === contentType;
      
      smoothTransition(fromState, {
        type: contentType,
        file: file,
        page: pageNum
      }, {
        crossfade: useCrossfade,
        skipTransition: false
      }).catch(error => {
        console.error('[Player] ❌ Ошибка переключения на PDF:', error);
        // Fallback на старый метод
        showConvertedPage(file, 'page', pageNum, isTypeChange);
      });
      
      // КРИТИЧНО: Предзагружаем ВСЕ страницы в кэш для мгновенного переключения
      if (!slidesCache[file]) {
        preloadAllSlides(file, 'pdf');
      }
    } else if (type === 'pptx' && file) {
      const slideNum = page || 1;
      
      // КРИТИЧНО: Устанавливаем currentFileState сразу, чтобы обработчики pptxPage/pdfPrev/pdfNext работали
      currentFileState = { type: 'pptx', file: file, page: slideNum };
      
      const fromState = getCurrentStateForTransition();
      const contentType = 'pptx';
      const isTypeChange = fromState.type && fromState.type !== contentType;
      
      // Для однотипного переключения используем crossfade
      const useCrossfade = !isTypeChange && fromState.type === contentType;
      
      smoothTransition(fromState, {
        type: contentType,
        file: file,
        page: slideNum
      }, {
        crossfade: useCrossfade,
        skipTransition: false
      }).catch(error => {
        console.error('[Player] ❌ Ошибка переключения на PPTX:', error);
        // Fallback на старый метод
        showConvertedPage(file, 'slide', slideNum, isTypeChange);
      });
      
      // КРИТИЧНО: Предзагружаем ВСЕ слайды в кэш для мгновенного переключения
      if (!slidesCache[file]) {
        preloadAllSlides(file, 'pptx');
      }
    } else if (type === 'folder' && file) {
      // Папка с изображениями
      const imageNum = page || 1;
      const folderName = file.replace(/\.zip$/i, ''); // Убираем .zip если есть
      
      // КРИТИЧНО: Устанавливаем currentFileState сразу, чтобы обработчики folderPage/pdfPrev/pdfNext работали
      currentFileState = { type: 'folder', file: folderName, page: imageNum };
      
      const fromState = getCurrentStateForTransition();
      const contentType = 'folder';
      const isTypeChange = fromState.type && fromState.type !== contentType;
      
      // Для однотипного переключения используем crossfade
      const useCrossfade = !isTypeChange && fromState.type === contentType;
      
      smoothTransition(fromState, {
        type: contentType,
        file: folderName,
        page: imageNum
      }, {
        crossfade: useCrossfade,
        skipTransition: false
      }).catch(error => {
        console.error('[Player] ❌ Ошибка переключения на папку:', error);
        // Fallback на старый метод
        showFolderImage(folderName, imageNum, isTypeChange);
      });
      
      // КРИТИЧНО: Предзагружаем ВСЕ изображения в кэш для мгновенного переключения
      if (!slidesCache[folderName]) {
        preloadAllFolderImages(folderName);
      }
    }
  });

  socket.on('player/pause', () => {
    if (vjsPlayer && !vjsPlayer.paused()) {
      vjsPlayer.pause();
    }
  });
  
  socket.on('player/resume', () => {
    // Продолжаем воспроизведение с текущей позиции (не сбрасываем!)
    if (vjsPlayer && vjsPlayer.paused()) {
      vjsPlayer.play();
    }
  });

  socket.on('player/restart', () => {
    if (vjsPlayer) {
      vjsPlayer.currentTime(0);
      vjsPlayer.play();
    }
  });

  // Плавное завершение воспроизведения: контент уходит в прозрачность, под ним виден бренд-фон
  socket.on('player/stop', async (payload = {}) => {
    const reason = typeof payload === 'string'
      ? payload
      : (payload && typeof payload === 'object' && payload.reason) || '';
      
    if (reason === 'switch_content') {
      // При переключении контента просто останавливаем, не показываем заглушку
      if (vjsPlayer) vjsPlayer.pause();
      stopProgressInterval();
      if (typeof emitProgressStop === 'function') {
        emitProgressStop();
      }
      // Очищаем img1 и pdf, убираем inline стили при остановке папок/PDF/PPTX
      if (img1) {
      img1.removeAttribute('src');
        img1.src = '';
        img1.classList.remove('visible', 'preloading');
        img1.removeAttribute('style');
      }
      if (pdf) {
      pdf.removeAttribute('src');
        pdf.src = '';
        pdf.classList.remove('visible', 'preloading');
        pdf.removeAttribute('style');
      }
      currentFileState = { type: null, file: null, page: 1 };
      return;
    }
    
    // Останавливаем прогресс
    stopProgressInterval();
    if (typeof emitProgressStop === 'function') {
      emitProgressStop();
    }
    
    // Получаем текущее состояние для плавного перехода
    const fromState = getCurrentStateForTransition();
    
    // Если нет активного контента - сразу показываем заглушку
    if (!fromState.element || !fromState.element.classList.contains('visible')) {
        try {
          await showPlaceholder();
        } catch (e) {
          console.error('[Player] ❌ Ошибка загрузки заглушки при stop:', e);
        [videoContainer, img1, pdf].forEach(el => {
          if (el) el.classList.remove('visible', 'preloading');
        });
      }
      return;
    }
    
      // Используем плавный переход к заглушке
      try {
        // Сначала предзагружаем заглушку
        const placeholderData = await resolvePlaceholder(false);
        
        if (placeholderData && placeholderData.src) {
          // Используем smoothTransition для плавного перехода к заглушке
          // Передаем URL заглушки напрямую (smoothTransition сам определит тип по расширению или использует placeholderData.type)
          await smoothTransition(fromState, {
            type: 'placeholder',
            file: placeholderData.src, // Передаем полный URL
            page: 1
          }, {
            crossfade: false, // Последовательный переход при СТОП
            skipTransition: false
          });
          
          // Обновляем currentFileState для заглушки
          currentPlaceholderSrc = placeholderData.src;
          currentFileState = { type: 'placeholder', file: placeholderData.src, page: 1 };
      } else {
        // Заглушка не найдена - просто fade-out и очистка
        const activeElement = fromState.element;
        if (activeElement) {
          activeElement.style.transition = `opacity ${TRANSITION_DURATION}ms ease-in-out`;
          activeElement.style.opacity = '0';
          
          await new Promise((resolve) => {
            setTimeout(resolve, TRANSITION_DURATION + 50);
            activeElement.addEventListener('transitionend', resolve, { once: true });
          });
          
          activeElement.classList.remove('visible', 'preloading');
          activeElement.style.opacity = '';
          activeElement.style.transition = '';
        }
        
        // Очищаем все элементы
        [videoContainer, img1, pdf].forEach(el => {
          if (el) {
            el.removeAttribute('src');
            el.src = '';
            el.classList.remove('visible', 'preloading');
            // Убираем все inline стили с img1 и pdf при остановке папок/PDF/PPTX
            if (el === img1 || el === pdf) {
              el.removeAttribute('style');
            }
          }
        });
        
        currentFileState = { type: null, file: null, page: 1 };
      }
    } catch (error) {
      console.error('[Player] ❌ Ошибка при плавном переходе к заглушке:', error);
      
      // Fallback: используем старый метод
      if (vjsPlayer) vjsPlayer.pause();
      const layers = [videoContainer, img1, pdf].filter(Boolean);
      const active = layers.find(el => el.classList.contains('visible'));
      
      // Очищаем элементы
      if (img1) {
        img1.removeAttribute('src');
        img1.src = '';
        img1.classList.remove('visible', 'preloading');
        // Убираем все inline стили с img1 при остановке папок/PDF/PPTX
        img1.removeAttribute('style');
      }
      if (pdf) {
        pdf.removeAttribute('src');
        pdf.src = '';
        pdf.classList.remove('visible', 'preloading');
        // Убираем все inline стили с pdf при остановке
        pdf.removeAttribute('style');
      }
    
    if (active) {
      active.classList.remove('visible');
        setTimeout(async () => {
          layers.forEach(e => e.classList.remove('visible', 'preloading'));
          try {
            await showPlaceholder();
          } catch (e) {
            console.error('[Player] ❌ Ошибка загрузки заглушки при stop (fallback):', e);
          }
        }, TRANSITION_DURATION);
    } else {
        try {
          await showPlaceholder();
        } catch (e) {
          console.error('[Player] ❌ Ошибка загрузки заглушки при stop (fallback):', e);
        }
      }
    }
  });

  socket.on('placeholder/refresh', () => {
    
    // Очищаем slidesCache при смене заглушки
    slidesCache = {};
    
    // КРИТИЧНО: Очищаем текущую заглушку из памяти для принудительной перезагрузки
    currentPlaceholderSrc = null;
    
    // КРИТИЧНО: Сбрасываем currentFileState в idle (важно для перезагрузки заглушки)
    currentFileState = { type: null, file: null, page: 1 };
    
    // СРАЗУ показываем черный экран (мгновенная реакция)
    // Это предотвращает показ старой/поврежденной заглушки
    [videoContainer, img1, pdf].forEach(e => {
      if (e) e.classList.remove('visible', 'preloading');
    });
    // idle убран
    
    // Останавливаем плеер (НЕ очищаем src - это вызывает ошибку, просто паузим)
    if (vjsPlayer) {
      try {
        vjsPlayer.pause();
        // НЕ вызываем vjsPlayer.src('') - это генерирует ошибку
        // Новый src установится автоматически при загрузке заглушки
      } catch (e) {
      }
    }
    
    // Небольшая задержка, затем ВСЕГДА загружаем новую заглушку
    const placeholderTimeout = setTimeout(() => {
      // Таймаут: если заглушка не загрузилась за 5 секунд, убираем черный экран
      // idle убран - проверка не нужна
      {
        console.warn('[Player] ⚠️ Таймаут загрузки заглушки, показываем бренд-фон');
        // idle убран
        [videoContainer, img1, pdf].forEach(e => {
          if (e) e.classList.remove('visible', 'preloading');
        });
      }
    }, 5000); // 5 секунд на загрузку заглушки
    
    setTimeout(async () => {
      // УБРАЛИ УСЛОВИЕ - всегда загружаем новую заглушку при placeholder/refresh
      try {
        await showPlaceholder(true); // Принудительная перезагрузка с ?t=timestamp
        // Если заглушка успешно загрузилась, очищаем таймаут
        clearTimeout(placeholderTimeout);
      } catch (e) {
        console.error('[Player] ❌ Ошибка загрузки заглушки при refresh:', e);
        // Убираем черный экран при ошибке
        clearTimeout(placeholderTimeout);
        // idle убран
        [videoContainer, img1, pdf].forEach(e => {
          if (e) e.classList.remove('visible', 'preloading');
        });
      }
    }, 300); // Даем время на переход к черному экрану
  });

  socket.on('player/pdfPage', (page) => {
    if (!currentFileState.file || currentFileState.type !== 'pdf') return;
    currentFileState.page = page;
    showConvertedPage(currentFileState.file, 'page', page);
  });

  socket.on('player/pptxPage', (slide) => {
    if (!currentFileState.file || currentFileState.type !== 'pptx') return;
    currentFileState.page = slide;
    showConvertedPage(currentFileState.file, 'slide', slide);
  });

  socket.on('player/folderPage', (imageNum) => {
    // Простая логика как в рабочей версии 2.7.0
    if (!currentFileState.file || currentFileState.type !== 'folder') return;
    currentFileState.page = imageNum;
    showFolderImage(currentFileState.file, imageNum, false);
  });

  socket.on('player/volume', (payload) => {
    handleVolumeCommand(payload || {});
  });

  // Переменная для отслеживания последнего логированного состояния (защита от спама в консоль)
  let lastLoggedState = null;

  socket.on('player/state', (cur) => {
    if (!cur || cur.type === 'idle' || !cur.file) {
      // КРИТИЧНО: При получении idle проверяем реальное состояние воспроизведения
      // Если видео закончилось и показывается заглушка - не трогаем
      const isContentPlaying = currentFileState.type && currentFileState.type !== 'placeholder' &&
                               ((currentFileState.type === 'video' && vjsPlayer && !vjsPlayer.paused() && !vjsPlayer.ended() && videoContainer.classList.contains('visible')) ||
                                (currentFileState.type !== 'video' && img1.classList.contains('visible')));
      
      const isPlaceholderPlaying = currentFileState.type === 'placeholder' && 
                                    ((vjsPlayer && !vjsPlayer.paused() && videoContainer.classList.contains('visible')) || 
                                     img1.classList.contains('visible'));
      
      // КРИТИЧНО: Если видео закончилось (ended), не считаем его играющим
      const isVideoEnded = currentFileState.type === 'video' && vjsPlayer && vjsPlayer.ended();
      
      if (isContentPlaying && !isVideoEnded) {
        // КРИТИЧНО: Контент играет (и не закончился) - продолжаем воспроизведение, НЕ показываем заглушку!
        console.log('[Player] ✅ Получен idle, но контент играет - продолжаем воспроизведение...');
        // НЕ меняем currentFileState - оставляем текущий контент
        return;
      } else if (isPlaceholderPlaying || isVideoEnded) {
        // Заглушка уже играет ИЛИ видео закончилось - показываем/продолжаем заглушку
        if (!isPlaceholderPlaying) {
          // Видео закончилось, но заглушка еще не показана - показываем её
          console.log('[Player] ✅ Видео закончилось, показываем заглушку');
          showPlaceholder();
        } else {
        // Заглушка уже играет - просто обновляем состояние
        currentFileState = { type: 'placeholder', file: currentPlaceholderSrc || cachedPlaceholderSrc, page: 1 };
        }
        return;
      } else {
        // Контент не играет и заглушка не играет - показываем заглушку
        if (cachedPlaceholderSrc) {
          // Используем кэшированную заглушку без перезагрузки
          currentPlaceholderSrc = cachedPlaceholderSrc;
          currentFileState = { type: 'placeholder', file: cachedPlaceholderSrc, page: 1 };
          // Не вызываем showPlaceholder() - заглушка уже должна быть видна
        } else {
          // Кэша нет - загружаем заглушку
          showPlaceholder();
        }
      }
      return;
    }
    
    // КРИТИЧНО: Если показывается заглушка - НЕ загружаем видео автоматически!
    // Заглушка включилась после проблем с сетью - она должна продолжать играть
    const isPlaceholderPlaying = currentFileState.type === 'placeholder' && 
                                  ((vjsPlayer && !vjsPlayer.paused() && videoContainer.classList.contains('visible')) || 
                                   img1.classList.contains('visible'));
    
    if (isPlaceholderPlaying) {
      // КРИТИЧНО: Заглушка играет - НЕ переключаемся на видео автоматически!
      // Если заглушка включилась после проблем с сетью, она должна продолжать играть
      console.log('[Player] ✅ Получен player/state с файлом, но заглушка играет - продолжаем показывать заглушку');
      // НЕ меняем currentFileState - оставляем заглушку
      return;
    }
    
    // КРИТИЧНО: Проверяем, не закончилось ли видео - если да, не запускаем его снова
    const isVideoEnded = currentFileState.type === 'video' && 
                         currentFileState.file === cur.file && 
                         cur.type === 'video' &&
                         vjsPlayer && vjsPlayer.ended();
    
    if (isVideoEnded) {
      // Видео закончилось - не запускаем его снова, показываем заглушку
      console.log('[Player] ✅ Видео закончилось, не запускаем снова, показываем заглушку');
      currentFileState = { type: null, file: null, page: 1 };
      showPlaceholder();
      return;
    }
    
    // КРИТИЧНО: При переподключении НЕ сбрасываем контент если он уже играет (как в Android)
    // Проверяем, не играет ли уже тот же файл
    const isSameContentPlaying = currentFileState.type === cur.type && 
                                  currentFileState.file === cur.file &&
                                  ((cur.type === 'video' && vjsPlayer && !vjsPlayer.paused() && !vjsPlayer.ended() && videoContainer.classList.contains('visible')) ||
                                   (cur.type === 'image' && img1.classList.contains('visible')) ||
                                   (cur.type === 'pdf' && img1.classList.contains('visible')) ||
                                   (cur.type === 'pptx' && img1.classList.contains('visible')) ||
                                   (cur.type === 'folder' && img1.classList.contains('visible')));
    
    if (isSameContentPlaying) {
      // Тот же контент уже играет - продолжаем воспроизведение, не перезагружаем
      // Логируем только один раз для каждого файла (защита от спама)
      const stateKey = `${cur.type}:${cur.file}:${cur.page || 1}`;
      if (lastLoggedState !== stateKey) {
        lastLoggedState = stateKey;
      console.log('[Player] ✅ Переподключено: контент уже играет, продолжаем воспроизведение...');
      }
      // Обновляем состояние, но не перезагружаем
      currentFileState = { type: cur.type, file: cur.file, page: cur.page || 1 };
      
      // Для видео - убеждаемся что воспроизведение продолжается (только если не закончилось)
      if (cur.type === 'video' && vjsPlayer && vjsPlayer.paused() && !vjsPlayer.ended()) {
        vjsPlayer.play().catch(err => {
          console.error('[Player] ❌ Ошибка возобновления:', err);
        });
      }
      return;
    }
    
    // Сбрасываем отслеживание при изменении состояния
    lastLoggedState = null;
    
    // Контент не играет или другой - проверяем существование файла перед загрузкой
    console.log('[Player] 📡 Применяем состояние при переподключении:', cur.type, cur.file);
    
    // КРИТИЧНО: Проверяем существование файла перед загрузкой (защита от 404)
    if (cur.type === 'video' || cur.type === 'image') {
      const fileUrl = content(cur.file);
      
      // Проверяем существование файла через HEAD запрос
      fetch(fileUrl, { method: 'HEAD', cache: 'no-store' })
        .then(response => {
          if (response.ok) {
            // Файл существует - загружаем его
            socket.emit('control/play', { device_id, file: cur.file });
          } else {
            // Файл не существует (404) - не загружаем, продолжаем текущий контент или заглушку
            console.warn(`[Player] ⚠️ Файл недоступен (${response.status}): ${cur.file}, продолжаем текущий контент`);
            
            // Если есть текущий контент - продолжаем его
            const hasCurrentContent = currentFileState.type && currentFileState.type !== 'placeholder' &&
                                     ((currentFileState.type === 'video' && vjsPlayer && !vjsPlayer.paused() && videoContainer.classList.contains('visible')) ||
                                      (currentFileState.type !== 'video' && img1.classList.contains('visible')));
            
            if (hasCurrentContent) {
              console.log('[Player] ✅ Продолжаем воспроизведение текущего контента');
              // Обновляем состояние на текущий контент
              currentFileState = { type: currentFileState.type, file: currentFileState.file, page: currentFileState.page || 1 };
            } else {
              // Текущего контента нет - возвращаемся к заглушке
              console.log('[Player] ℹ️ Возвращаемся к заглушке');
              if (cachedPlaceholderSrc) {
                currentPlaceholderSrc = cachedPlaceholderSrc;
                currentFileState = { type: 'placeholder', file: cachedPlaceholderSrc, page: 1 };
                // Не вызываем showPlaceholder() - заглушка должна быть видна
              } else {
                showPlaceholder();
              }
            }
          }
        })
        .catch(error => {
          // Ошибка сети - продолжаем текущий контент или заглушку
          console.warn(`[Player] ⚠️ Ошибка проверки файла: ${error.message}, продолжаем текущий контент`);
          
          const hasCurrentContent = currentFileState.type && currentFileState.type !== 'placeholder' &&
                                   ((currentFileState.type === 'video' && vjsPlayer && !vjsPlayer.paused() && videoContainer.classList.contains('visible')) ||
                                    (currentFileState.type !== 'video' && img1.classList.contains('visible')));
          
          if (hasCurrentContent) {
            console.log('[Player] ✅ Продолжаем воспроизведение текущего контента');
            currentFileState = { type: currentFileState.type, file: currentFileState.file, page: currentFileState.page || 1 };
          } else {
            if (cachedPlaceholderSrc) {
              currentPlaceholderSrc = cachedPlaceholderSrc;
              currentFileState = { type: 'placeholder', file: cachedPlaceholderSrc, page: 1 };
            } else {
              showPlaceholder();
            }
          }
        });
    } else {
      // Для PDF/PPTX/folder - сразу загружаем (они всегда доступны через API)
      socket.emit('control/play', { device_id, file: cur.file });
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
      ensureSocketConnected('register');
      return;
    }
    if (registerInFlight) {
      return;
    }
    registerInFlight = true;
    awaitingVolumeSync = true;
    
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
        registerPlayer();
      }
    }, 3000);
  }
  
  // КРИТИЧНО: Обработчик подтверждения регистрации от сервера
  socket.on('player/registered', ({ device_id: registeredId, current }) => {
    if (registrationTimeout) clearTimeout(registrationTimeout);
    registerInFlight = false;
    isRegistered = true;
    startHeartbeat();
    emitVolumeState('register');
    
    // КРИТИЧНО: При регистрации НЕ сбрасываем контент если он уже играет (как в Android)
    // Сервер отправит player/state, который обработает состояние корректно
    const isContentPlaying = currentFileState.type && currentFileState.type !== 'placeholder' &&
                             ((currentFileState.type === 'video' && vjsPlayer && !vjsPlayer.paused() && videoContainer.classList.contains('visible')) ||
                              (currentFileState.type !== 'video' && img1.classList.contains('visible')));
    
    if (isContentPlaying) {
      console.log('[Player] ✅ Зарегистрировано: контент играет, продолжаем...');
      // Не трогаем контент - ждем player/state от сервера
    } else if (currentFileState.type === 'placeholder') {
      console.log('[Player] ✅ Зарегистрировано: заглушка играет, продолжаем...');
      // КРИТИЧНО: Отправляем сигнал об остановке прогресса при показе заглушки
      if (emitProgressStop) {
        emitProgressStop();
      }
    } else {
      // Нет активного контента - отправляем сигнал об остановке прогресса
      if (emitProgressStop) {
        emitProgressStop();
      }
    }
  });
  
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
  });
  
  socket.on('player/reject', ({ reason }) => {
    console.error('[Player] ❌ Регистрация отклонена:', reason);
    isRegistered = false;
    registerInFlight = false;
    awaitingVolumeSync = false;
  });

  socket.on('connect', () => {
    isRegistered = false; // Сбрасываем при каждом connect
    registerInFlight = false;
    registerPlayer();
  });

  socket.on('disconnect', (reason) => {
    isRegistered = false;
    registerInFlight = false;
    awaitingVolumeSync = false;
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
    
    // КРИТИЧНО: При потере связи НЕ прерываем контент (как в Android)!
    // Контент продолжает играть из кэша браузера, переподключение происходит в фоне
    const isContentPlaying = currentFileState.type && currentFileState.type !== 'placeholder' &&
                             ((currentFileState.type === 'video' && vjsPlayer && !vjsPlayer.paused() && videoContainer.classList.contains('visible')) ||
                              (currentFileState.type !== 'video' && img1.classList.contains('visible')));
    
    const isPlaceholderPlaying = currentFileState.type === 'placeholder' && 
                                  ((vjsPlayer && !vjsPlayer.paused() && videoContainer.classList.contains('visible')) || 
                                   img1.classList.contains('visible'));
    
    if (isContentPlaying) {
      // КРИТИЧНО: Контент играет - продолжаем воспроизведение, НЕ показываем заглушку!
      console.log('[Player] ✅ Потеря связи: контент играет, продолжаем воспроизведение из кэша, переподключение в фоне...');
      // НЕ трогаем контент - он продолжает играть из кэша браузера
    } else if (isPlaceholderPlaying) {
      console.log('[Player] ℹ️ Потеря связи: заглушка продолжает играть, переподключение в фоне...');
      // Заглушка продолжает играть, не показываем черный экран
    } else if (cachedPlaceholderSrc) {
      // Если контент не играет и заглушка не играет, но есть в кэше - запускаем её
      console.log('[Player] ℹ️ Потеря связи: запускаем кэшированную заглушку...');
      currentPlaceholderSrc = cachedPlaceholderSrc;
      if (cachedPlaceholderType === 'video' && vjsPlayer) {
        // Восстанавливаем видео заглушку из кэша
        vjsPlayer.src({ src: cachedPlaceholderSrc, type: 'video/mp4' });
        vjsPlayer.loop(true);
        vjsPlayer.muted(true);
        vjsPlayer.volume(0);
        currentFileState = { type: 'placeholder', file: cachedPlaceholderSrc, page: 1 };
        hideVideoJsControls();
        
        vjsPlayer.one('loadedmetadata', () => {
          hideVideoJsControls();
          vjsPlayer.one('loadeddata', () => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                videoContainer.classList.remove('preloading');
                videoContainer.classList.add('visible');
                // idle убран
                vjsPlayer.one('canplay', () => {
                  setTimeout(() => {
                    vjsPlayer.play().catch(err => {
                      console.error('[Player] ❌ Ошибка воспроизведения кэшированной заглушки:', err);
                    });
                  }, 200);
                });
              });
            });
          });
        });
      } else if (cachedPlaceholderType === 'image' && cachedPlaceholderSrc) {
        // Восстанавливаем изображение заглушку из кэша
        const tempImg = new Image();
        tempImg.onload = () => {
          // idle убран
          img.src = cachedPlaceholderSrc;
          currentFileState = { type: 'placeholder', file: cachedPlaceholderSrc, page: 1 };
          show(img);
        };
        tempImg.src = cachedPlaceholderSrc;
      }
    }
    
    // КРИТИЧНО: Для Android - явное переподключение после disconnect (в фоне)
    if (reason === 'transport close' || reason === 'transport error') {
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
    isRegistered = false;
    registerInFlight = false;
    
    // КРИТИЧНО: При переподключении НЕ сбрасываем контент (как в Android)
    // Проверяем, играет ли контент или заглушка
    const isContentPlaying = currentFileState.type && currentFileState.type !== 'placeholder' &&
                             ((currentFileState.type === 'video' && vjsPlayer && !vjsPlayer.paused() && videoContainer.classList.contains('visible')) ||
                              (currentFileState.type !== 'video' && img1.classList.contains('visible')));
    
    const isPlaceholderPlaying = currentFileState.type === 'placeholder' && 
                                  ((vjsPlayer && !vjsPlayer.paused() && videoContainer.classList.contains('visible')) || 
                                   img1.classList.contains('visible'));
    
    // КРИТИЧНО: Если показывается заглушка - НЕ переключаемся на контент автоматически!
    // Заглушка включилась после проблем с сетью - она должна продолжать играть
    if (isPlaceholderPlaying) {
      console.log('[Player] ✅ Переподключено: заглушка играет, продолжаем показывать заглушку (не переключаемся на контент)');
      // НЕ трогаем заглушку - она должна продолжать играть
      return;
    }
    
    if (isContentPlaying) {
      // Контент играет - продолжаем воспроизведение, не трогаем
      console.log('[Player] ✅ Переподключено: контент играет, продолжаем воспроизведение...');
      
      // КРИТИЧНО: Сбрасываем счетчик retry и флаг разрыва сети при успешном переподключении
      if (typeof networkErrorRetryCount !== 'undefined') {
        networkErrorRetryCount = 0;
      }
      isNetworkDisconnected = false;
      
      // Если видео было на паузе из-за ошибки - пробуем возобновить
      if (currentFileState.type === 'video' && vjsPlayer) {
        if (vjsPlayer.paused() && vjsPlayer.readyState() >= 2) {
          // КРИТИЧНО: Восстанавливаем позицию если была сохранена
          if (savedVideoPosition !== null && savedVideoPosition > 0) {
            const restoreTime = savedVideoPosition;
            console.log(`[Player] 🔄 Восстанавливаем позицию после переподключения: ${restoreTime.toFixed(1)}s`);
            if (restoreTime < vjsPlayer.duration()) {
              vjsPlayer.currentTime(restoreTime);
            }
            savedVideoPosition = null;
            savedVideoSrc = null;
          }
          
          console.log('[Player] 🔄 Возобновляем воспроизведение после переподключения...');
          vjsPlayer.play().catch(err => {
            console.error('[Player] ❌ Ошибка возобновления после переподключения:', err);
          });
        } else if (vjsPlayer.readyState() < 2 || vjsPlayer.paused()) {
          // Видео не загружено или на паузе - пробуем перезагрузить с сохраненной позиции
          const restoreTime = savedVideoPosition || vjsPlayer.currentTime();
          console.log(`[Player] 🔄 Перезагружаем видео после переподключения с позиции ${restoreTime.toFixed(1)}s...`);
          
          vjsPlayer.load();
          vjsPlayer.one('loadedmetadata', () => {
            if (restoreTime > 0 && restoreTime < vjsPlayer.duration()) {
              vjsPlayer.currentTime(restoreTime);
            }
            savedVideoPosition = null;
            savedVideoSrc = null;
            vjsPlayer.play().catch(err => {
              console.error('[Player] ❌ Ошибка воспроизведения после перезагрузки:', err);
            });
          });
        }
      }
    } else if (isPlaceholderPlaying) {
      // Заглушка играет - продолжаем, не перезагружаем
      console.log('[Player] ✅ Переподключено: заглушка играет, продолжаем...');
    } else {
      // Ничего не играет - проверяем заглушку
      if (player?.isPlaying != true) {
        console.log('[Player] ℹ️ Переподключено: контент остановлен, проверяем заглушку...');
        // Не загружаем заглушку сразу - ждем player/state от сервера
      }
    }
    
    // Регистрируемся заново (сервер отправит player/state с текущим состоянием)
    console.log('[Player] 📡 Регистрация в фоне...');
    registerPlayer();
  });
  
  // НОВОЕ: Обработчики попыток переподключения
  socket.on('reconnect_attempt', (attemptNumber) => {
  });
  
  socket.on('reconnect_error', (error) => {
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
        ensureSocketConnected('watchdog-disconnected');
      } else if (!isRegistered && !registerInFlight) {
        // Подключены, но не зарегистрированы
        registerPlayer();
      }
    }
  }, 5000);
}