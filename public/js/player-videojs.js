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

const idle = document.getElementById('idle');
const v = document.getElementById('v');
const videoContainer = document.getElementById('videoContainer'); // Контейнер для Video.js
const img1 = document.getElementById('img1');
const img2 = document.getElementById('img2');
const img = img1; // Для обратной совместимости со старым кодом
const pdf = document.getElementById('pdf');
const unmuteBtn = document.getElementById('unmute');
const brandBg = document.getElementById('brandBg');

let currentFileState = { type: null, file: null, page: 1 };
let soundUnlocked = false;
let vjsPlayer = null;
let isLoadingPlaceholder = false; // Флаг для предотвращения двойной загрузки
let registerInFlight = false; // Предотвращаем одновременные попытки регистрации
let slidesCache = {}; // Кэш предзагруженных слайдов PPTX/PDF: { 'filename': { count: N, images: [Image, ...] } }
let currentImgBuffer = 1; // Текущий активный буфер изображений (1 или 2) для двойной буферизации
let wakeLock = null; // Wake Lock для предотвращения suspend
let lastProgressEmitTs = 0; // троттлинг отправки прогресса
let progressInterval = null; // периодическая отправка прогресса (fallback)

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
  [idle, v, img1, img2, pdf].forEach(el => el && el.classList.remove('visible'));
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
          // По умолчанию для видео включаем логотип на фоне
          setBrandBackgroundMode('logo');
          
          // КРИТИЧНО: Скрываем все контролы при инициализации
          hideVideoJsControls();
          
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
            
            if (!preview && isActuallyEnded && (currentFileState.type === null || currentFileState.type === 'video')) {
              showPlaceholder();
            } else if (!isActuallyEnded) {
            } else {
            }
          });
          
          // Обработчик ошибок
          vjsPlayer.on('error', function() {
            const error = vjsPlayer.error();
            console.error('[Player] ❌ Video.js error:', error);
          });
          
          // КРИТИЧНО для Android: обработчики буферизации и зависания
          let stalledTimeout = null;
          let waitingTimeout = null;
          
          // КРИТИЧНО для Android: обработчики состояния воспроизведения
          let lastLoggedPercent = -1;
          
          vjsPlayer.on('stalled', () => {
          });
          
          vjsPlayer.on('waiting', () => {
          });
          
          vjsPlayer.on('playing', () => {
            
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
          
          // Отправка прогресса на спикер-панель
          const emitProgress = () => {
            // Не шлем прогресс из превью и не для не-видео контента
            if (!vjsPlayer || !device_id || preview || (currentFileState && currentFileState.type !== 'video')) return;
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
  
  // Плавный показ элемента с ОБЯЗАТЕЛЬНЫМ переходом через черный экран
  function show(el, skipTransition = false) {
    if (!el) {
      return;
    }
    
    
    // Убедимся что body черный
    document.body.style.background = 'transparent';
    document.documentElement.style.background = 'transparent';
    
    // Если нужен мгновенный показ (например для слайдов презентации)
    if (skipTransition) {
      // Сначала показываем новый
      el.classList.add('visible');
      el.classList.remove('preloading');
      
      // Потом скрываем остальные (включая оба буфера)
      [idle, videoContainer, img1, img2, pdf].forEach(e => {
        if (e && e !== el) {
          e.classList.remove('visible', 'preloading');
        }
      });
      
      return;
    }
    
    // ПЕРЕХОД ЧЕРЕЗ ЧЕРНЫЙ: Сначала показываем черный экран
    
    // 1. Скрываем все кроме idle
    [videoContainer, img1, img2, pdf].forEach(e => {
      if (e) {
        e.classList.remove('visible', 'preloading');
      }
    });
    
    // 2. Показываем черный экран (idle)
    idle.classList.add('visible');
    
    // 3. После fade in черного (0.5s) - показываем новый контент
    setTimeout(() => {
      // Если новый контент это не сам idle
      if (el !== idle) {
        el.classList.remove('preloading');
        el.style.zIndex = '3';
        
        requestAnimationFrame(() => {
          el.classList.add('visible'); // Fade in нового контента
          idle.classList.remove('visible'); // Fade out черного экрана
          
          
          setTimeout(() => {
            if (el) el.style.zIndex = '';
          }, 500);
        });
      }
    }, 500); // Время показа черного экрана
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
    soundUnlocked = true;
    try { localStorage.setItem('vc_sound', '1'); } catch {}
    if (vjsPlayer) {
      vjsPlayer.muted(false);
      vjsPlayer.volume(1.0);
      vjsPlayer.play();
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
          
          // КРИТИЧНО: Проверяем что файл реально доступен (может быть удален после создания записи в API)
          // При force=true проверка тоже идет с cache-busting
          try {
            const checkUrl = url + cacheBuster;
            const checkRes = await fetchWithTimeout(checkUrl, { 
              method: 'HEAD',
              cache: force ? 'no-store' : 'default' // Обход HTTP кэша браузера
            }, 3000);
            
            if (checkRes.ok) {
              // Возвращаем URL с cache-busting если force=true
              return url + cacheBuster;
            } else {
            }
          } catch (e) {
          }
        }
      }
    } catch (e) {
    }
    
    // НОВОЕ: Fallback больше не используется с новой архитектурой
    // Заглушки управляются через БД (is_placeholder flag)
    // Если API не вернул заглушку - значит её нет, и не должно быть fallback поиска
    return null;
  }

  let currentPlaceholderSrc = null; // Отслеживаем текущую заглушку
  
  async function showPlaceholder(forceRefresh = false) {
    
    // При force refresh сбрасываем текущую заглушку для принудительной перезагрузки
    if (forceRefresh) {
      currentPlaceholderSrc = null;
    }
    
    const src = await resolvePlaceholder(forceRefresh);
    
    if (!src) {
      
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
      return;
    }
    
    currentPlaceholderSrc = src;
    currentFileState = { type: 'placeholder', file: src, page: 1 }; // КРИТИЧНО: Сбрасываем состояние
    
    const isImage = /\.(png|jpg|jpeg|gif|webp)$/i.test(src);
    
    if (isImage) {
      if (vjsPlayer) vjsPlayer.pause();
      pdf.removeAttribute('src');
      
      // КРИТИЧНО: Дожидаемся загрузки изображения ПЕРЕД показом!
      // Иначе показывается черный экран
      const tempImg = new Image();
      
      const showImagePlaceholder = () => {
        // КРИТИЧНО: Убираем черный экран перед показом заглушки
        idle.classList.remove('visible');
        img.src = src;
        show(img);
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
              // Показываем предупреждение вместо ошибки Video.js
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
                        p { color: #cbd5e1; line-height: 1.5; margin: 0.5rem 0; }
                      </style>
                    </head>
                    <body>
                      <div>
                        <h2>⚠️ Заглушка недоступна</h2>
                      </div>
                    </body>
                  </html>
                `;
                show(pdf);
              }
              return;
            }
            
            
            vjsPlayer.loop(true);
            vjsPlayer.muted(true);
            vjsPlayer.volume(0);
            
            // КРИТИЧНО: Скрываем контролы
            hideVideoJsControls();
            
            // Делаем плавный переход как видео→видео: слой уходит в прозрачность, под ним виден бренд-фон
            const TRANSITION_MS_PLACEHOLDER = 500;
            const needFadeOutPlaceholder = videoContainer.classList.contains('visible');
            videoContainer.classList.remove('visible');
            videoContainer.classList.add('preloading');
            
            const setPlaceholderSrcAndShow = () => {
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
            if (needFadeOutPlaceholder) {
              waitForOpacityTransitionEnd(videoContainer, 'opacity', TRANSITION_MS_PLACEHOLDER + 150)
                .then(() => setPlaceholderSrcAndShow());
            } else {
              setPlaceholderSrcAndShow();
            }
          } catch (e) {
            console.error('[Player] ❌ Ошибка проверки или загрузки заглушки:', e);
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
  function showFolderImage(folderName, num) {
    // КРИТИЧНО: Полностью останавливаем и скрываем Video.js плеер
    if (vjsPlayer) {
      vjsPlayer.pause();
      vjsPlayer.currentTime(0);
      // Скрываем все контролы Video.js
      hideVideoJsControls();
    }
    pdf.removeAttribute('src');
    
    // Убеждаемся что videoContainer скрыт классами (без display:none)
    videoContainer.classList.remove('visible', 'preloading');
    
    const { current, next } = getImageBuffers();
    // Для папок (слайд-шоу) фон ДОЛЖЕН быть черным, без логотипа
    setBrandBackgroundMode('black');
    
    // Определяем, это первый показ папки или переключение изображений
    const isFirstShow = !current.classList.contains('visible') && !next.classList.contains('visible');
    
    // Проверяем кэш
    if (slidesCache[folderName] && slidesCache[folderName].images) {
      const cached = slidesCache[folderName];
      const index = Math.max(0, Math.min(num - 1, cached.count - 1));
      const cachedImage = cached.images[index];
      
      if (cachedImage && cachedImage.complete && cachedImage.naturalWidth > 0) {
        
        // Загружаем в следующий буфер
        next.src = cachedImage.src;
        
        if (isFirstShow) {
          // Первый показ папки - через черный, с фиксированным временем
          [videoContainer, current, next].forEach(e => {
            if (e) e.classList.remove('visible', 'preloading');
          });
          idle.classList.add('visible');
          
          setTimeout(() => {
            next.classList.add('visible');
            idle.classList.remove('visible');
          }, 500);
        } else {
          // Переключение внутри папки - МГНОВЕННО, без плавного перехода
          show(next, true); // skipTransition = true
        }
        
        // Переключаем активный буфер
        currentImgBuffer = currentImgBuffer === 1 ? 2 : 1;
        return;
      }
    }
    
    // Fallback: загружаем через API если нет в кэше
    const imageUrl = `/api/devices/${encodeURIComponent(device_id)}/folder/${encodeURIComponent(folderName)}/image/${num}`;
    
    // Предзагружаем в следующий буфер
    const tempImg = new Image();
    tempImg.onload = () => {
      
      // Устанавливаем в следующий буфер
      next.src = imageUrl;
      
      if (isFirstShow) {
        // Первый показ папки - через черный, с фиксированным временем
        [videoContainer, current, next].forEach(e => {
          if (e) e.classList.remove('visible', 'preloading');
        });
        idle.classList.add('visible');
        
        setTimeout(() => {
          next.classList.add('visible');
          idle.classList.remove('visible');
        }, 500);
      } else {
        // Переключение внутри папки - МГНОВЕННО
        show(next, true);
      }
      
      // Переключаем активный буфер
      currentImgBuffer = currentImgBuffer === 1 ? 2 : 1;
    };
    tempImg.onerror = () => {
      console.error(`[Player] ❌ Ошибка загрузки изображения ${num}`);
      next.src = imageUrl;
      // При ошибке тоже используем черный экран
      [videoContainer, current, next].forEach(e => {
        if (e) e.classList.remove('visible', 'preloading');
      });
      idle.classList.add('visible');
      setTimeout(() => {
        next.classList.add('visible');
        idle.classList.remove('visible');
      }, 500);
      currentImgBuffer = currentImgBuffer === 1 ? 2 : 1;
    };
    tempImg.src = imageUrl;
  }

  function showConvertedPage(file, type, num) {
    // КРИТИЧНО: Полностью останавливаем и скрываем Video.js плеер
    if (vjsPlayer) {
      vjsPlayer.pause();
      vjsPlayer.currentTime(0);
      // Скрываем все контролы Video.js
      hideVideoJsControls();
    }
    pdf.removeAttribute('src');
    
    // Убеждаемся что videoContainer скрыт классами (без display:none)
    videoContainer.classList.remove('visible', 'preloading');
    
    const { current, next } = getImageBuffers();
    // Для презентаций фон ДОЛЖЕН быть черным, без логотипа
    setBrandBackgroundMode('black');
    
    // Определяем, это первый показ презентации или переключение слайдов
    const isFirstShow = !current.classList.contains('visible') && !next.classList.contains('visible');
    
    // Проверяем кэш
    if (slidesCache[file] && slidesCache[file].images) {
      const cached = slidesCache[file];
      const index = Math.max(0, Math.min(num - 1, cached.count - 1));
      const cachedImage = cached.images[index];
      
      if (cachedImage && cachedImage.complete && cachedImage.naturalWidth > 0) {
        
        // Загружаем в следующий буфер
        next.src = cachedImage.src;
        
        // Первый показ - сразу черный, потом фиксированный fade in; переключение слайдов - мгновенно
        if (isFirstShow) {
          // Сразу черный экран
          [videoContainer, img1, img2, pdf].forEach(e => {
            if (e) e.classList.remove('visible', 'preloading');
          });
          idle.classList.add('visible');
          
          // Затем fade in слайда (фиксированное время)
          setTimeout(() => {
            next.classList.add('visible');
            idle.classList.remove('visible');
          }, 500);
        } else {
          show(next, true); // skipTransition = true для мгновенной смены
        }
        
        // Переключаем активный буфер
        currentImgBuffer = currentImgBuffer === 1 ? 2 : 1;
        return;
      }
    }
    
    // Fallback: загружаем через API если нет в кэше
    const imageUrl = `/api/devices/${encodeURIComponent(device_id)}/converted/${encodeURIComponent(file)}/${type}/${num}`;
    
    // Предзагружаем в следующий буфер
    const tempImg = new Image();
    tempImg.onload = () => {
      
      // Устанавливаем в следующий буфер
      next.src = imageUrl;
      
      // Первый показ - сразу черный, потом фиксированный fade in; переключение слайдов - мгновенно
      if (isFirstShow) {
        // Сразу черный экран
        [videoContainer, img1, img2, pdf].forEach(e => {
          if (e) e.classList.remove('visible', 'preloading');
        });
        idle.classList.add('visible');
        
        // Затем fade in слайда (фиксированное время)
        setTimeout(() => {
          next.classList.add('visible');
          idle.classList.remove('visible');
        }, 500);
      } else {
        show(next, true); // skipTransition = true для мгновенной смены
      }
      
      // Переключаем активный буфер
      currentImgBuffer = currentImgBuffer === 1 ? 2 : 1;
    };
    tempImg.onerror = () => {
      console.error(`[Player] ❌ Ошибка загрузки слайда ${num}`);
      next.src = imageUrl;
      show(next, isFirstShow ? false : true);
      currentImgBuffer = currentImgBuffer === 1 ? 2 : 1;
    };
    tempImg.src = imageUrl;
  }

  // WebSocket обработчики
  socket.on('player/play', ({ type, file, page }) => {
    
    if (type === 'video') {
      img1.removeAttribute('src');
      img2.removeAttribute('src');
      pdf.removeAttribute('src');
      
      if (!file && vjsPlayer) {
        // Resume текущего видео (нет файла = продолжить с паузы)
        currentFileState = { type: 'video', file: currentFileState.file, page: 1 };
        
        vjsPlayer.muted(soundUnlocked && !forceMuted ? false : true);
        vjsPlayer.volume(soundUnlocked && !forceMuted ? 1.0 : 0.0);
        
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
        
        
        if (isSameFile && vjsPlayer) {
          // Тот же файл - просто возобновляем (это нажатие Play после паузы)
          currentFileState = { type: 'video', file, page: 1 };
          
          vjsPlayer.muted(soundUnlocked && !forceMuted ? false : true);
          vjsPlayer.volume(soundUnlocked && !forceMuted ? 1.0 : 0.0);
          
          // Показываем videoContainer если он скрыт (без трогания display)
          if (!videoContainer.classList.contains('visible')) {
            show(videoContainer);
          }
          
          // КРИТИЧНО: НЕ проверяем ended() на Android - он врет после паузы!
          // Просто возобновляем с текущей позиции (currentTime сохраняется)
          if (vjsPlayer.paused()) {
            vjsPlayer.play().then(() => {
            }).catch(err => {
              console.error('[Player] ❌ Ошибка resume:', err);
            });
          }
          return;
        }
        
        // Новый файл - загружаем с начала
        currentFileState = { type: 'video', file, page: 1 };
        
        // Плавный переход через бренд‑фон (без черного экрана)
        // Шаг 1: уводим текущий видео-слой в прозрачность (старое видео продолжает играть во время fade-out)
        const TRANSITION_MS = 500;
        const needFadeOut = videoContainer.classList.contains('visible');
        videoContainer.classList.remove('visible');
        videoContainer.classList.add('preloading');
        
        if (vjsPlayer) {
          vjsPlayer.loop(false);
          vjsPlayer.muted(soundUnlocked && !forceMuted ? false : true);
          vjsPlayer.volume(soundUnlocked && !forceMuted ? 1.0 : 0.0);
          
          // Скрываем контролы ДО установки src
          hideVideoJsControls();
          
          const setSrcAndShow = () => {
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
                          if (soundUnlocked && !forceMuted) {
                            setTimeout(() => {
                              vjsPlayer.muted(false);
                              vjsPlayer.volume(1.0);
                            }, 200);
                          }
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
      currentFileState = { type: 'image', file, page: 1 };
      if (vjsPlayer) vjsPlayer.pause();
      pdf.removeAttribute('src');
      
      // СРАЗУ показываем черный экран (мгновенная реакция)
      [videoContainer, img1, img2, pdf].forEach(e => {
        if (e) e.classList.remove('visible', 'preloading');
      });
      idle.classList.add('visible');
      
      const { next } = getImageBuffers();
      const imageUrl = content(file);
      
      // Предзагружаем в фоне (пока черный экран)
      const tempImg = new Image();
      tempImg.onload = () => {
        next.src = imageUrl;
        
        // Плавный переход из черного в изображение
        setTimeout(() => {
          next.classList.add('visible');
          idle.classList.remove('visible');
          currentImgBuffer = currentImgBuffer === 1 ? 2 : 1;
        }, 300);
      };
      tempImg.onerror = () => {
        next.src = imageUrl;
        next.classList.add('visible');
        idle.classList.remove('visible');
        currentImgBuffer = currentImgBuffer === 1 ? 2 : 1;
      };
      tempImg.src = imageUrl;
    } else if (type === 'pdf' && file) {
      const pageNum = page || 1;
      currentFileState = { type: 'pdf', file, page: pageNum };
      showConvertedPage(file, 'page', pageNum);
      
      // КРИТИЧНО: Предзагружаем ВСЕ страницы в кэш для мгновенного переключения
      if (!slidesCache[file]) {
        preloadAllSlides(file, 'pdf');
      }
    } else if (type === 'pptx' && file) {
      const slideNum = page || 1;
      currentFileState = { type: 'pptx', file, page: slideNum };
      showConvertedPage(file, 'slide', slideNum);
      
      // КРИТИЧНО: Предзагружаем ВСЕ слайды в кэш для мгновенного переключения
      if (!slidesCache[file]) {
        preloadAllSlides(file, 'pptx');
      }
    } else if (type === 'folder' && file) {
      // Папка с изображениями
      const imageNum = page || 1;
      const folderName = file.replace(/\.zip$/i, ''); // Убираем .zip если есть
      currentFileState = { type: 'folder', file: folderName, page: imageNum };
      showFolderImage(folderName, imageNum);
      
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
  socket.on('player/stop', () => {
    if (vjsPlayer) vjsPlayer.pause();
    const layers = [videoContainer, img1, img2, pdf].filter(Boolean);
    const active = layers.find(el => el.classList.contains('visible'));
    const TRANSITION_MS = 800;
    
    // КРИТИЧНО: Убираем черный экран сразу, чтобы не было перехода в черный
    idle.classList.remove('visible');
    
    const afterFade = () => {
      // Очистка источников после завершения fade-out
      img1.removeAttribute('src');
      img2.removeAttribute('src');
      pdf.removeAttribute('src');
      currentFileState = { type: null, file: null, page: 1 };
      currentImgBuffer = 1;
      
      // Не показываем black/idle — оставляем бренд-фон видимым
      layers.forEach(e => e.classList.remove('visible', 'preloading'));
      
      // Загружаем заглушку в фоне, затем мягко показываем (без черного экрана)
      setTimeout(() => showPlaceholder(true), 100);
    };
    
    if (active) {
      // Запускаем fade-out текущего слоя
      active.classList.remove('visible');
      setTimeout(afterFade, TRANSITION_MS);
    } else {
      afterFade();
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
    [videoContainer, img1, img2, pdf].forEach(e => {
      if (e) e.classList.remove('visible', 'preloading');
    });
    idle.classList.add('visible');
    
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
    setTimeout(() => {
      // УБРАЛИ УСЛОВИЕ - всегда загружаем новую заглушку при placeholder/refresh
      showPlaceholder(true); // Принудительная перезагрузка с ?t=timestamp
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
    if (!currentFileState.file || currentFileState.type !== 'folder') return;
    currentFileState.page = imageNum;
    showFolderImage(currentFileState.file, imageNum);
  });

  socket.on('player/state', (cur) => {
    if (!cur || cur.type === 'idle' || !cur.file) {
      showPlaceholder();
      currentFileState = { type: null, file: null, page: 1 };
      return;
    }
    // Применяем состояние (для переподключения)
    socket.emit('control/play', { device_id, file: cur.file });
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
  });

  socket.on('connect', () => {
    isRegistered = false; // Сбрасываем при каждом connect
    registerInFlight = false;
    registerPlayer();
  });

  socket.on('disconnect', (reason) => {
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
    
    // КРИТИЧНО: Для Android - явное переподключение после disconnect
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

