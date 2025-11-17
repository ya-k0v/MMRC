package com.videocontrol.mediaplayer

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.exoplayer2.ExoPlayer
import com.google.android.exoplayer2.MediaItem
import com.google.android.exoplayer2.Player
import com.google.android.exoplayer2.ui.StyledPlayerView
import com.google.android.exoplayer2.source.ProgressiveMediaSource
import com.google.android.exoplayer2.upstream.DefaultHttpDataSource
import com.google.android.exoplayer2.upstream.DefaultDataSource
import com.google.android.exoplayer2.upstream.DefaultAllocator
import com.google.android.exoplayer2.DefaultLoadControl
import com.google.android.exoplayer2.C
import com.google.android.exoplayer2.upstream.cache.CacheDataSource
import com.google.android.exoplayer2.upstream.cache.LeastRecentlyUsedCacheEvictor
import com.google.android.exoplayer2.upstream.cache.SimpleCache
import com.google.android.exoplayer2.database.StandaloneDatabaseProvider
import java.io.File
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import com.bumptech.glide.load.resource.drawable.DrawableTransitionOptions
import java.net.URISyntaxException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.lifecycle.lifecycleScope
import android.animation.ObjectAnimator
import android.animation.AnimatorListenerAdapter

class MainActivity : AppCompatActivity() {

    private lateinit var playerView: StyledPlayerView
    private lateinit var imageView: ImageView
    private lateinit var statusText: TextView
    private lateinit var brandBg: ImageView

    private var player: ExoPlayer? = null
    private var socket: Socket? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var simpleCache: SimpleCache? = null
    private val pingHandler = Handler(Looper.getMainLooper())
    private val retryHandler = Handler(Looper.getMainLooper())
    private val progressHandler = Handler(Looper.getMainLooper())
    private val logoRefreshHandler = Handler(Looper.getMainLooper())
    private var retryRunnable: Runnable? = null
    private var placeholderJob: Job? = null
    private var isPlayingPlaceholder: Boolean = false
    private var isLoadingPlaceholder: Boolean = false  // Защита от параллельных вызовов loadPlaceholder()
    private var progressRunnable: Runnable? = null
    private var logoRefreshRunnable: Runnable? = null
    
    // Новые компоненты
    private var config: RemoteConfig.Config = RemoteConfig.Config()
    private var showStatus: Boolean = false
    
    // Для retry при ошибках
    private var errorRetryCount = 0
    private val maxRetryAttempts = 3
    
    // Флаг первого запуска (чтобы не загружать заглушку дважды)
    private var isFirstLaunch = true
    
    // Кэш информации о заглушке (чтобы не запрашивать сервер каждый раз)
    private var cachedPlaceholderFile: String? = null
    private var cachedPlaceholderType: String? = null
    private var placeholderTimestamp: Long = 0 // Для обхода кэша при смене заглушки

    private val TAG = "VCMediaPlayer"
    private var SERVER_URL = ""
    private var DEVICE_ID = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        Log.i(TAG, "=== MainActivity onCreate ===")

        // Проверяем настройки при запуске
        if (!SettingsActivity.isConfigured(this)) {
            Log.w(TAG, "Not configured, redirecting to settings")
            // Перенаправляем на настройки
            startActivity(Intent(this, SettingsActivity::class.java))
            finish()
            return
        }

        // Загружаем настройки
        SERVER_URL = SettingsActivity.getServerUrl(this) ?: ""
        DEVICE_ID = SettingsActivity.getDeviceId(this) ?: ""
        showStatus = SettingsActivity.getShowStatus(this)

        Log.i(TAG, "Loaded settings: SERVER_URL=$SERVER_URL, DEVICE_ID=$DEVICE_ID, showStatus=$showStatus")
        
        // Используем дефолтные настройки (без RemoteConfig для стабильности)
        config = RemoteConfig.Config()
        
        setContentView(R.layout.activity_main)

        // Fullscreen и не гасим экран
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                        View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                )

        playerView = findViewById(R.id.playerView)
        imageView = findViewById(R.id.imageView)
        statusText = findViewById(R.id.statusText)
        brandBg = findViewById(R.id.brandBg)
        
        // Загружаем логотип в brandBg с cache-busting
        loadBrandLogo()
        startLogoRefreshTimer() // Запускаем периодическое обновление логотипа

        // Длинное нажатие на экран - открывает настройки
        playerView.setOnLongClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
            true
        }

        // Скрываем контролы ExoPlayer
        playerView.useController = false

        // Wake Lock для предотвращения suspend
        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "VCMediaPlayer::WakeLock"
        )
        wakeLock?.acquire()

        Log.i(TAG, "MainActivity initialized")

        initializePlayer()
        connectSocket()
        
        // КРИТИЧНО: Загружаем заглушку при старте (постоянно показываем заглушку)
        loadPlaceholder()
    }

    private fun initializePlayer() {
        try {
            // Освобождаем старый кэш если был
            try {
                simpleCache?.release()
                simpleCache = null
            } catch (e: Exception) {
                Log.w(TAG, "Failed to release old cache: ${e.message}")
            }
            
            // Инициализация кэша для больших видео (используем config)
            val cacheDir = File(cacheDir, "video_cache")
            
            try {
                simpleCache = SimpleCache(
                    cacheDir,
                    LeastRecentlyUsedCacheEvictor(config.cacheSize),
                    StandaloneDatabaseProvider(this)
                )
            } catch (e: IllegalStateException) {
                // Папка занята - удаляем и создаем заново
                Log.w(TAG, "Cache folder locked, recreating...")
                cacheDir.deleteRecursively()
                cacheDir.mkdirs()
                
                simpleCache = SimpleCache(
                    cacheDir,
                    LeastRecentlyUsedCacheEvictor(config.cacheSize),
                    StandaloneDatabaseProvider(this)
                )
            }

            // Настройки буферизации для тяжелых видео (используем config)
            val loadControl = DefaultLoadControl.Builder()
                .setAllocator(DefaultAllocator(true, C.DEFAULT_BUFFER_SEGMENT_SIZE))
                .setBufferDurationsMs(
                    config.bufferMinMs,  // minBufferMs
                    config.bufferMaxMs,  // maxBufferMs
                    2500,   // bufferForPlaybackMs: начать воспроизведение через 2.5 сек
                    5000    // bufferForPlaybackAfterRebufferMs: после паузы - 5 сек
                )
                .setPrioritizeTimeOverSizeThresholds(true)
                .build()

            player = ExoPlayer.Builder(this)
                .setLoadControl(loadControl)
                .build()
                .also { exoPlayer ->
                    playerView.player = exoPlayer

                    // Обработчик событий
                    exoPlayer.addListener(object : Player.Listener {
                        override fun onPlaybackStateChanged(playbackState: Int) {
                            when (playbackState) {
                                Player.STATE_IDLE -> Log.d(TAG, "Player STATE_IDLE")
                                Player.STATE_BUFFERING -> {
                                    Log.d(TAG, "Player STATE_BUFFERING")
                                    showStatus("Буферизация...", autohideSeconds = 0)  // Не скрываем автоматически
                                }

                                Player.STATE_READY -> {
                                    Log.d(TAG, "Player STATE_READY")
                                    errorRetryCount = 0  // Сбрасываем счетчик при успешном воспроизведении
                                    hideStatus()
                                    
                                    // Плавный fade-in нового видео после готовности
                                    // КРИТИЧНО: Ждем и STATE_READY и onVideoSizeChanged для коротких файлов
                                    if (!isVideoReadyToShow && pendingVideoFileName != null) {
                                        // Если размер видео уже известен - можно сразу начинать fade-in
                                        if (hasVideoSize) {
                                            startVideoFadeIn()
                                        } else {
                                            // Ждем onVideoSizeChanged - он вызовет startVideoFadeIn()
                                            Log.d(TAG, "📸 STATE_READY получен, ждем onVideoSizeChanged для: ${pendingVideoFileName}")
                                            // Таймаут на случай если onVideoSizeChanged не придет (для очень коротких файлов)
                                            Handler(Looper.getMainLooper()).postDelayed({
                                                if (!isVideoReadyToShow && pendingVideoFileName != null) {
                                                    Log.d(TAG, "⏱️ Таймаут ожидания onVideoSizeChanged, начинаем fade-in")
                                                    startVideoFadeIn()
                                                }
                                            }, 500) // Таймаут 500ms
                                        }
                                    }
                                }

                                Player.STATE_ENDED -> {
                                    Log.d(TAG, "Player STATE_ENDED")
                                    // КРИТИЧНО: Заглушка зацикливается (ExoPlayer сам перезапустит)
                                    // Обычное видео - показываем заглушку
                                    if (!isPlayingPlaceholder) {
                                        Log.i(TAG, "Контент закончился, возврат на заглушку")
                                        loadPlaceholder()
                                    } else {
                                        Log.d(TAG, "Заглушка зациклена, ExoPlayer перезапустит автоматически")
                                    }
                                }
                            }
                        }

                        override fun onPlayerError(error: com.google.android.exoplayer2.PlaybackException) {
                            Log.e(TAG, "Player error: ${error.message} (attempt $errorRetryCount/$maxRetryAttempts)", error)
                            
                            // КРИТИЧНО: Если играет контент (не заглушка) - больше попыток!
                            val maxAttempts = if (!isPlayingPlaceholder) 10 else maxRetryAttempts
                            
                            showStatus("Ошибка воспроизведения, попытка $errorRetryCount/$maxAttempts...")
                            
                            // Автоматический retry для стабильности 24/7
                            // КРИТИЧНО: Отменяем предыдущий retry перед созданием нового
                            retryRunnable?.let { retryHandler.removeCallbacks(it) }
                            retryRunnable = Runnable {
                                // КРИТИЧНО: Проверяем что Activity еще жива
                                if (isDestroyed || isFinishing) {
                                    Log.d(TAG, "Activity destroyed, skipping retry")
                                    return@Runnable
                                }
                                
                                if (errorRetryCount < maxAttempts) {
                                    errorRetryCount++
                                    Log.i(TAG, "Retrying playback (attempt $errorRetryCount/$maxAttempts) [content=${!isPlayingPlaceholder}]...")
                                    
                                    try {
                                        // ExoPlayer сам продолжит с текущей позиции благодаря кэшу
                                        player?.prepare()
                                        player?.play()
                                    } catch (e: OutOfMemoryError) {
                                        Log.e(TAG, "OutOfMemoryError during retry, clearing caches", e)
                                        handleOutOfMemory()
                                    } catch (e: Exception) {
                                        Log.e(TAG, "Retry failed: ${e.message}", e)
                                    }
                                } else {
                                    if (!isPlayingPlaceholder) {
                                        Log.e(TAG, "Max retry attempts for content, loading placeholder")
                                    }
                                    errorRetryCount = 0
                                    loadPlaceholder()
                                }
                            }
                            retryHandler.postDelayed(retryRunnable!!, 5000) // 5 секунд для сетевых ошибок
                        }

                        override fun onIsPlayingChanged(isPlaying: Boolean) {
                            Log.d(TAG, "Player isPlaying: $isPlaying")
                            
                            // Запускаем/останавливаем отправку прогресса
                            if (isPlaying && !isPlayingPlaceholder && currentVideoFile != null) {
                                startProgressUpdates()
                            } else {
                                stopProgressUpdates()
                            }
                        }
                        
                        override fun onVideoSizeChanged(videoSize: com.google.android.exoplayer2.video.VideoSize) {
                            Log.d(TAG, "📐 Video size changed: ${videoSize.width}x${videoSize.height}")
                            hasVideoSize = true
                            
                            // Если видео готово к показу и размер известен - можно начинать fade-in
                            if (!isVideoReadyToShow && pendingVideoFileName != null && hasVideoSize) {
                                startVideoFadeIn()
                            }
                        }
                    })
                }

            Log.i(TAG, "ExoPlayer initialized (cache: ${config.cacheSize / 1024 / 1024}MB, buffer: ${config.bufferMinMs}-${config.bufferMaxMs}ms)")
            
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error initializing player", e)
        }
    }

    private fun connectSocket() {
        try {
            val opts = IO.Options().apply {
                reconnection = true
                reconnectionAttempts = Integer.MAX_VALUE
                reconnectionDelay = config.reconnectDelay.toLong()
                timeout = 20000
            }

            socket = IO.socket(SERVER_URL, opts)

            socket?.on(Socket.EVENT_CONNECT) {
                Log.i(TAG, "✅ Socket connected")
                runOnUiThread {
                    showStatus("Подключено", autohideSeconds = 2)  // Скрываем через 2 сек
                    registerDevice()
                    startPingTimer()
                    
                    // Обновляем логотип при переподключении (может быть обновлен на сервере)
                    loadBrandLogo()
                    startLogoRefreshTimer() // Запускаем периодическое обновление логотипа
                    
                    // КРИТИЧНО: При переподключении НЕ сбрасываем на заглушку!
                    // Если играет контент - продолжаем воспроизведение
                    if (!isPlayingPlaceholder && player?.isPlaying == true) {
                        Log.i(TAG, "Reconnected: content is playing, continuing...")
                    } else if (!isPlayingPlaceholder && player?.isPlaying == false) {
                        Log.i(TAG, "Reconnected: content was paused, keeping paused")
                    } else {
                        // Заглушка должна играть - проверяем что плеер действительно играет
                        if (player?.isPlaying != true) {
                            Log.i(TAG, "Reconnected: placeholder stopped, reloading...")
                            loadPlaceholder()
                        } else {
                            Log.d(TAG, "Reconnected: placeholder is playing correctly")
                        }
                    }
                }
            }

            socket?.on(Socket.EVENT_DISCONNECT) { args ->
                val reason = if (args.isNotEmpty()) args[0].toString() else "unknown"
                Log.w(TAG, "⚠️ Socket disconnected: $reason")
                runOnUiThread {
                    showStatus("⚠️ Нет связи с сервером...", autohideSeconds = 0)  // Не скрываем до переподключения
                    stopPingTimer()
                    
                    // КРИТИЧНО: При потере связи НЕ останавливаем контент!
                    // ExoPlayer продолжит воспроизведение из кэша и автоматически подгрузит при reconnect
                    // Заглушка продолжает крутиться в loop mode
                    if (!isPlayingPlaceholder) {
                        Log.i(TAG, "Connection lost during content, ExoPlayer will continue from cache...")
                    } else {
                        Log.i(TAG, "Connection lost, placeholder continues playing (loop mode)...")
                    }
                }
            }
            
            socket?.on(Socket.EVENT_CONNECT_ERROR) { args ->
                val error = if (args.isNotEmpty()) args[0].toString() else "unknown"
                Log.e(TAG, "❌ Socket connect error: $error")
                runOnUiThread {
                    showStatus("Ошибка подключения", autohideSeconds = 5)  // Скрываем через 5 сек
                }
            }
            
            socket?.on("reconnect") { args ->
                val attempt = if (args.isNotEmpty()) args[0].toString() else "?"
                Log.i(TAG, "🔄 Socket reconnected (attempt $attempt)")
                
                // ИСПРАВЛЕНО: Регистрируемся заново при reconnect (в т.ч. после transport upgrade)
                runOnUiThread {
                    registerDevice()
                    startPingTimer()
                    // Обновляем логотип при переподключении (может быть обновлен на сервере)
                    loadBrandLogo()
                    startLogoRefreshTimer() // Запускаем периодическое обновление логотипа
                    Log.i(TAG, "📡 Re-registered device after reconnect")
                }
            }
            
            socket?.on("reconnect_attempt") { args ->
                val attempt = if (args.isNotEmpty()) args[0].toString() else "?"
                Log.d(TAG, "🔄 Socket reconnection attempt $attempt")
                runOnUiThread {
                    showStatus("Переподключение...", autohideSeconds = 0)  // Не скрываем до успеха
                }
            }

            socket?.on("player/play") { args ->
                if (args.isNotEmpty()) {
                    val data = args[0] as JSONObject
                    runOnUiThread { handlePlay(data) }
                }
            }

            socket?.on("player/pause") {
                runOnUiThread {
                    // КРИТИЧНО: Заглушка НЕ реагирует на паузу
                    if (isPlayingPlaceholder) {
                        Log.d(TAG, "⏸️ Pause игнорируется - играет заглушка")
                        return@runOnUiThread
                    }
                    
                    // КРИТИЧНО: Сохраняем позицию перед паузой
                    savedPosition = player?.currentPosition ?: 0
                    player?.pause()
                    stopProgressUpdates() // Останавливаем отправку прогресса
                    Log.i(TAG, "⏸️ Пауза на позиции: $savedPosition ms")
                }
            }

            socket?.on("player/resume") {
                runOnUiThread {
                    // Команда resume - продолжить воспроизведение с текущей позиции
                    // Используется когда сервер перезапустился и не знает о текущем файле
                    if (isPlayingPlaceholder) {
                        Log.d(TAG, "▶️ Resume игнорируется - играет заглушка")
                        return@runOnUiThread
                    }
                    
                    if (player != null && currentVideoFile != null) {
                        // Продолжаем воспроизведение с сохраненной позиции
                        Log.i(TAG, "▶️ Resume: продолжаем $currentVideoFile с позиции $savedPosition ms")
                        player?.apply {
                            playWhenReady = true
                            play()
                        }
                    } else {
                        Log.w(TAG, "⚠️ Resume: нет активного видео для продолжения")
                    }
                }
            }

            socket?.on("player/stop") {
                runOnUiThread {
                    // КРИТИЧНО: Заглушка НЕ реагирует на stop
                    if (isPlayingPlaceholder) {
                        Log.d(TAG, "⏹️ Stop игнорируется - играет заглушка")
                        return@runOnUiThread
                    }
                    
                    stopProgressUpdates() // Останавливаем отправку прогресса
                    Log.i(TAG, "⏹️ Stop - возврат на заглушку")
                    
                    // КРИТИЧНО: Логика как в JS плеере - fade-out 800ms, затем заглушка БЕЗ черного экрана
                    // Определяем активный контент (видео или изображение)
                    val hasVideo = playerView.alpha > 0f && playerView.visibility == View.VISIBLE
                    val hasImage = imageView.alpha > 0f && imageView.visibility == View.VISIBLE
                    
                    if (hasVideo || hasImage) {
                        Log.d(TAG, "🎬 Fade-out текущего контента (800ms как в JS)...")
                        
                        val afterFade = {
                            // После fade-out загружаем заглушку БЕЗ черного экрана (как в JS)
                            player?.stop()
                            player?.clearMediaItems()
                            playerView.alpha = 0f
                            playerView.visibility = View.GONE
                            
                            Glide.with(this).clear(imageView)
                            imageView.setImageDrawable(null)
                            imageView.alpha = 0f
                            imageView.visibility = View.GONE
                            
                            // Загружаем заглушку в фоне, затем мягко показываем поверх логотипа
                            // brandBg с логотипом остается видимым
                            loadPlaceholder(skipLogoTransition = true)
                        }
                        
                        if (hasVideo) {
                            player?.pause()
                            fadeOutView(playerView, 800, afterFade)
                        } else if (hasImage) {
                            fadeOutView(imageView, 800, afterFade)
                        }
                    } else {
                        // Контента не было - сразу загружаем заглушку поверх логотипа
                        loadPlaceholder(skipLogoTransition = true)
                    }
                }
            }

            socket?.on("player/restart") {
                runOnUiThread {
                    // КРИТИЧНО: Заглушка НЕ реагирует на restart
                    if (isPlayingPlaceholder) {
                        Log.d(TAG, "🔄 Restart игнорируется - играет заглушка")
                        return@runOnUiThread
                    }
                    
                    player?.seekTo(0)
                    player?.play()
                    Log.i(TAG, "🔄 Restart выполнен")
                }
            }

            socket?.on("placeholder/refresh") {
                runOnUiThread { 
                    // КРИТИЧНО: Обновляем timestamp для обхода кэша ExoPlayer
                    placeholderTimestamp = System.currentTimeMillis()
                    
                    // КРИТИЧНО: Полностью очищаем плеер для освобождения декодера
                    player?.stop()
                    player?.clearMediaItems()
                    
                    // Очищаем кэш заглушки при обновлении
                    cachedPlaceholderFile = null
                    cachedPlaceholderType = null
                    
                    Log.i(TAG, "🔄 Placeholder changed (timestamp=$placeholderTimestamp), clearing decoder and reloading...")
                    loadPlaceholder()
                }
            }

            socket?.on("player/pdfPage") { args ->
                if (args.isNotEmpty()) {
                    val page = args[0] as? Int ?: 1
                    runOnUiThread { showPdfPage(null, page) }
                }
            }

            socket?.on("player/pptxPage") { args ->
                if (args.isNotEmpty()) {
                    val page = args[0] as? Int ?: 1
                    runOnUiThread { showPptxSlide(null, page) }
                }
            }

            socket?.on("player/folderPage") { args ->
                if (args.isNotEmpty()) {
                    val imageNum = args[0] as? Int ?: 1
                    runOnUiThread { showFolderImage(null, imageNum) }
                }
            }
            
            socket?.on("player/pong") {
                // Pong получен - соединение работает нормально
                // Socket.IO сам управляет reconnect, Watchdog больше не нужен
            }

            socket?.connect()
            Log.d(TAG, "Socket connecting to $SERVER_URL")

        } catch (e: URISyntaxException) {
            Log.e(TAG, "Socket connection error", e)
        }
    }

    private fun registerDevice() {
        // КРИТИЧНО: Проверяем состояние Activity и соединения
        if (isDestroyed || isFinishing) {
            Log.d(TAG, "Activity destroyed, skipping device registration")
            return
        }
        
        try {
            // КРИТИЧНО: Проверяем состояние соединения перед регистрацией
            if (socket?.connected() != true) {
                Log.w(TAG, "Socket not connected, cannot register device")
                return
            }
            
            val data = JSONObject().apply {
                put("device_id", DEVICE_ID)
                put("device_type", "NATIVE_MEDIAPLAYER")
                put("platform", "Android ${android.os.Build.VERSION.RELEASE}")
                put("model", android.os.Build.MODEL)
                put("manufacturer", android.os.Build.MANUFACTURER)
                put("capabilities", JSONObject().apply {
                    put("video", true)
                    put("audio", true)
                    put("images", true)
                    put("pdf", true)   // ✅ Теперь поддерживаем через конвертированные изображения
                    put("pptx", true)  // ✅ Теперь поддерживаем через конвертированные изображения
                    put("streaming", true)
                })
            }

            socket?.emit("player/register", data)
            Log.i(TAG, "📡 Device registration sent: $DEVICE_ID (${android.os.Build.MODEL})")
            
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error registering device", e)
        }
    }

    private fun handlePlay(data: JSONObject) {
        try {
            val type = data.optString("type")
            val file = data.optString("file")
            val page = data.optInt("page", 1)

            Log.i(TAG, "📡 player/play: type=$type, file=$file, page=$page")

            when (type) {
                "video" -> playVideo(file, isPlaceholder = false)
                "image" -> showImage(file, isPlaceholder = false)
                "pdf" -> showPdfPage(file, page)
                "pptx" -> showPptxSlide(file, page)
                "folder" -> showFolderImage(file, page)
                else -> {
                    Log.w(TAG, "Unknown content type: $type")
                    showStatus("Неподдерживаемый тип контента")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error handling play command", e)
            showStatus("Ошибка воспроизведения")
        }
    }

    // Функции для плавных переходов
    private fun fadeOutView(view: View, durationMs: Long = 500, onComplete: (() -> Unit)? = null) {
        val animator = ObjectAnimator.ofFloat(view, "alpha", view.alpha, 0f).apply {
            duration = durationMs
            if (onComplete != null) {
                addListener(object : AnimatorListenerAdapter() {
                    override fun onAnimationEnd(animation: android.animation.Animator) {
                        onComplete()
                    }
                })
            }
        }
        animator.start()
    }
    
    private fun fadeInView(view: View, durationMs: Long = 500, onComplete: (() -> Unit)? = null) {
        view.visibility = View.VISIBLE
        // КРИТИЧНО: Убеждаемся что начинаем с alpha = 0
        view.alpha = 0f
        val animator = ObjectAnimator.ofFloat(view, "alpha", 0f, 1f).apply {
            duration = durationMs
            if (onComplete != null) {
                addListener(object : AnimatorListenerAdapter() {
                    override fun onAnimationEnd(animation: android.animation.Animator) {
                        onComplete()
                    }
                })
            }
        }
        animator.start()
    }
    
    // Флаг для отслеживания готовности видео перед показом
    private var isVideoReadyToShow = false
    private var pendingVideoFileName: String? = null
    private var pendingVideoIsPlaceholder = false
    private var hasVideoSize = false // Флаг что размер видео известен (первый кадр готов)
    
    // Функция для начала fade-in видео (вызывается когда и STATE_READY и onVideoSizeChanged получены)
    // Логика аналогична JS плееру: loadeddata → requestAnimationFrame → fade-in → canplay → play()
    private fun startVideoFadeIn() {
        if (isVideoReadyToShow || pendingVideoFileName == null) return
        
        isVideoReadyToShow = true
        val fileName = pendingVideoFileName!!
        Log.d(TAG, "📸 Начинаем fade-in видео: $fileName (hasVideoSize=$hasVideoSize)")
        
        // Убеждаемся что playerView видим и alpha = 0 перед fade-in
        playerView.visibility = View.VISIBLE
        playerView.alpha = 0f
        
        // Аналогично JS плееру: двойной post для гарантии готовности рендеринга (как requestAnimationFrame)
        Handler(Looper.getMainLooper()).post {
            Handler(Looper.getMainLooper()).post {
                // Fade-in видео (500ms как в JS)
                fadeInView(playerView, 500) {
                    // После завершения fade-in ждем canplay (аналог JS плеера)
                    // В ExoPlayer это STATE_READY + isPlaying или проверка через onIsPlayingChanged
                    // Задержка 200ms как в JS плеере для завершения CSS fade-in
                    Handler(Looper.getMainLooper()).postDelayed({
                        player?.apply {
                            playWhenReady = true
                            play()
                        }
                        Log.d(TAG, "✅ Видео запущено после fade-in (аналог canplay в JS)")
                    }, 200) // Задержка для завершения fade-in (как в JS плеере)
                }
            }
        }
        
        pendingVideoFileName = null
    }

    private fun playVideo(fileName: String, isPlaceholder: Boolean = false) {
        // КРИТИЧНО: Проверяем состояние Activity перед началом
        if (isDestroyed || isFinishing) {
            Log.d(TAG, "Activity destroyed, skipping playVideo")
            return
        }
        
        try {
            // НОВОЕ: Используем API resolver для поддержки shared storage (дедупликация)
            // Вместо /content/{device}/{file} используем /api/files/resolve/{device}/{file}
            val videoUrl = if (isPlaceholder && placeholderTimestamp > 0) {
                "$SERVER_URL/api/files/resolve/$DEVICE_ID/${Uri.encode(fileName)}?t=$placeholderTimestamp"
            } else {
                "$SERVER_URL/api/files/resolve/$DEVICE_ID/${Uri.encode(fileName)}"
            }
            Log.i(TAG, "🎬 Playing video: $videoUrl (isPlaceholder=$isPlaceholder)")

            // КРИТИЧНО: Очищаем ImageView и останавливаем Glide загрузку
            Glide.with(this).clear(imageView)
            imageView.setImageDrawable(null)
            imageView.visibility = View.GONE
            imageView.alpha = 0f

            // КРИТИЧНО: Проверяем тот же ли файл воспроизводится
            val isSameFile = currentVideoFile == fileName
            
            if (isSameFile && player != null) {
                // Тот же файл - продолжаем с сохраненной позиции (без переходов)
                Log.d(TAG, "⏯️ Тот же файл, продолжаем с позиции: $savedPosition ms")
                player?.apply {
                    seekTo(savedPosition)
                    playWhenReady = true
                    play()
                }
                // Показываем сразу если уже видим
                if (playerView.alpha > 0f) {
                    playerView.visibility = View.VISIBLE
                }
                // Запускаем отправку прогресса (onIsPlayingChanged тоже запустит, но лучше явно)
                if (!isPlaceholder) {
                    startProgressUpdates()
                }
                return
            }
            
            // Новый файл - плавный переход через бренд-фон
            Log.i(TAG, "🎬 Загрузка НОВОГО видео: $fileName")
            stopProgressUpdates() // Останавливаем прогресс старого видео
            currentVideoFile = fileName
            savedPosition = 0
            isVideoReadyToShow = false
            hasVideoSize = false // Сбрасываем флаг размера видео для нового файла
            pendingVideoFileName = fileName
            pendingVideoIsPlaceholder = isPlaceholder

            // Шаг 1: Fade-out старого видео (если оно было видимым)
            val needFadeOut = playerView.alpha > 0f && playerView.visibility == View.VISIBLE
            if (needFadeOut) {
                Log.d(TAG, "🎬 Fade-out старого видео...")
                fadeOutView(playerView, 500) {
                    // После fade-out скрываем и сбрасываем alpha
                    playerView.alpha = 0f
                    loadNewVideo(videoUrl, isPlaceholder)
                }
            } else {
                // Старого видео не было - сразу загружаем новое
                playerView.alpha = 0f
                loadNewVideo(videoUrl, isPlaceholder)
            }
            
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "❌ OutOfMemoryError playing video: $fileName", e)
            handleOutOfMemory()
            showStatus("Недостаточно памяти")
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error playing video: $fileName", e)
            if (!isDestroyed && !isFinishing) {
                showStatus("Ошибка загрузки видео")
            }
        }
    }
    
    private fun loadNewVideo(videoUrl: String, isPlaceholder: Boolean) {
        try {
            Log.d(TAG, "📥 Загрузка нового видео: $videoUrl")
            
            // HTTP Data Source с увеличенными таймаутами для больших файлов
            val httpDataSourceFactory = DefaultHttpDataSource.Factory().apply {
                setAllowCrossProtocolRedirects(true)
                setConnectTimeoutMs(60000)   // 60 секунд на подключение
                setReadTimeoutMs(60000)      // 60 секунд на чтение
                setUserAgent("VideoControl/1.0")
            }

            // Data Source с кэшированием
            val cacheDataSourceFactory = if (simpleCache != null) {
                CacheDataSource.Factory()
                    .setCache(simpleCache!!)
                    .setUpstreamDataSourceFactory(DefaultDataSource.Factory(this, httpDataSourceFactory))
                    .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
            } else {
                DefaultDataSource.Factory(this, httpDataSourceFactory)
            }

            val mediaItem = MediaItem.fromUri(videoUrl)
            val mediaSource = ProgressiveMediaSource.Factory(cacheDataSourceFactory)
                .createMediaSource(mediaItem)

            player?.apply {
                setMediaSource(mediaSource)
                // КРИТИЧНО: Заглушка зацикливается, контент - нет
                repeatMode = if (isPlaceholder) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
                prepare()
                // НЕ запускаем play() сразу - ждём STATE_READY
                playWhenReady = false
            }
            
            // Отмечаем тип контента
            isPlayingPlaceholder = isPlaceholder
            
            Log.i(TAG, "✅ Video source set, waiting for STATE_READY...")
            
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "❌ OutOfMemoryError loading new video", e)
            handleOutOfMemory()
            if (!isDestroyed && !isFinishing) {
                showStatus("Недостаточно памяти")
            }
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error loading new video", e)
            if (!isDestroyed && !isFinishing) {
                showStatus("Ошибка загрузки видео")
            }
        }
    }

    private var currentPdfFile: String? = null
    private var currentPdfPage: Int = 1
    private var currentPptxFile: String? = null
    private var currentPptxSlide: Int = 1
    private var currentFolderName: String? = null
    private var currentFolderImage: Int = 1
    private var currentVideoFile: String? = null
    private var savedPosition: Long = 0

    private fun showImage(fileName: String, isPlaceholder: Boolean = false) {
        // КРИТИЧНО: Проверяем состояние Activity перед началом
        if (isDestroyed || isFinishing) {
            Log.d(TAG, "Activity destroyed, skipping showImage")
            return
        }
        
        try {
            // НОВОЕ: Используем API resolver для поддержки shared storage
            val imageUrl = if (isPlaceholder && placeholderTimestamp > 0) {
                "$SERVER_URL/api/files/resolve/$DEVICE_ID/${Uri.encode(fileName)}?t=$placeholderTimestamp"
            } else {
                "$SERVER_URL/api/files/resolve/$DEVICE_ID/${Uri.encode(fileName)}"
            }
            Log.i(TAG, "🖼️ Showing image: $imageUrl (isPlaceholder=$isPlaceholder)")

            // КРИТИЧНО: Сбрасываем currentVideoFile чтобы при возврате к видео загружалось заново!
            currentVideoFile = null
            savedPosition = 0

            // КРИТИЧНО: Логика переходов как в JS плеере
            // Для изображений ВСЕГДА показываем логотип сначала (через brandBg)
            val needFadeOut = playerView.alpha > 0f && playerView.visibility == View.VISIBLE
            
            if (needFadeOut) {
                Log.d(TAG, "🎬 Fade-out видео перед показом изображения...")
                player?.pause()
                fadeOutView(playerView, 500) {
                    // После fade-out останавливаем видео
                    player?.stop()
                    player?.clearMediaItems()
                    playerView.alpha = 0f
                    playerView.visibility = View.GONE
                    
                    // Показываем логотип через brandBg (переходы через прозрачность)
                    showLogoBackground()
                    // Загружаем изображение с fade-in поверх логотипа (500ms как в JS)
                    loadImageToView(imageUrl, useFadeFromLogo = true, delayMs = 300)
                }
            } else {
                // Видео не было - СРАЗУ показываем логотип (переходы через прозрачность)
                player?.stop()
                player?.clearMediaItems()
                playerView.visibility = View.GONE
                playerView.alpha = 0f
                imageView.alpha = 0f
                imageView.visibility = View.GONE
                
                showLogoBackground()
                // Загружаем изображение с fade-in поверх логотипа (500ms как в JS)
                loadImageToView(imageUrl, useFadeFromLogo = true, delayMs = 300)
            }

            // Отмечаем тип контента
            isPlayingPlaceholder = isPlaceholder
            
            Log.i(TAG, "✅ Image loading: isPlaceholder=$isPlaceholder")
            
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "❌ OutOfMemoryError showing image: $fileName", e)
            handleOutOfMemory()
            if (!isDestroyed && !isFinishing) {
                showStatus("Недостаточно памяти")
            }
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error showing image: $fileName", e)
            if (!isDestroyed && !isFinishing) {
                showStatus("Ошибка загрузки изображения")
            }
        }
    }
    
    // Функция для показа логотипа через brandBg (вместо черного экрана)
    // Контент будет делать fade-in/fade-out поверх логотипа через прозрачность
    private fun showLogoBackground() {
        // Показываем brandBg с логотипом (если еще не загружен - загрузится)
        brandBg.alpha = 1f
        brandBg.visibility = View.VISIBLE
        
        // Убеждаемся что логотип загружен (если еще не загружен - загружаем)
        if (brandBg.drawable == null) {
            loadBrandLogo()
        }
        
        Log.d(TAG, "🎨 Логотип показан (brandBg) - переходы через прозрачность")
    }

    private fun showPdfPage(fileName: String?, page: Int) {
        // КРИТИЧНО: Проверяем состояние Activity перед началом
        if (isDestroyed || isFinishing) {
            Log.d(TAG, "Activity destroyed, skipping showPdfPage")
            return
        }
        
        try {
            val file = fileName ?: currentPdfFile
            if (file == null) {
                Log.w(TAG, "⚠️ PDF file name is null")
                return
            }

            val wasFirstShow = currentPdfFile == null
            currentPdfFile = file
            currentPdfPage = page
            
            // Презентация - НЕ заглушка, при stop вернемся на заглушку
            isPlayingPlaceholder = false

            val pageUrl = "$SERVER_URL/api/devices/$DEVICE_ID/converted/${Uri.encode(file)}/page/$page"
            Log.i(TAG, "📄 Showing PDF page: $pageUrl (page $page, wasFirstShow=$wasFirstShow)")

            // Сбрасываем currentVideoFile для корректного возврата к видео
            currentVideoFile = null
            savedPosition = 0

            // КРИТИЧНО: Логика переходов как в JS плеере
            // Первый показ презентации - через черный экран (500ms)
            // Переключение слайдов - мгновенно (skipTransition)
            val needFadeOut = playerView.alpha > 0f && playerView.visibility == View.VISIBLE
            
            if (needFadeOut) {
                Log.d(TAG, "🎬 Fade-out видео перед показом PDF...")
                player?.pause()
                fadeOutView(playerView, 500) {
                    player?.stop()
                    player?.clearMediaItems()
                    playerView.alpha = 0f
                    playerView.visibility = View.GONE
                    
                    // Первый показ - через логотип (fade-in поверх логотипа)
                    if (wasFirstShow) {
                        showLogoBackground()
                        loadImageToView(pageUrl, useFadeFromLogo = true, delayMs = 300)
                    } else {
                        // Переключение слайдов - мгновенно
                        loadImageToView(pageUrl, useFadeFromLogo = false, delayMs = 0)
                    }
                }
            } else {
                // Видео не было
                player?.stop()
                player?.clearMediaItems()
                playerView.visibility = View.GONE
                playerView.alpha = 0f
                imageView.alpha = 0f
                imageView.visibility = View.GONE
                
                // Первый показ - через логотип (fade-in поверх логотипа), переключение - мгновенно
                if (wasFirstShow) {
                    showLogoBackground()
                    loadImageToView(pageUrl, useFadeFromLogo = true, delayMs = 300)
                } else {
                    // Переключение слайдов - мгновенно (skipTransition как в JS)
                    loadImageToView(pageUrl, useFadeFromLogo = false, delayMs = 0)
                }
            }
            
            // Предзагружаем соседние страницы для быстрого переключения
            preloadAdjacentSlides(file, page, 999, "pdf")  // 999 как max (не знаем точное кол-во)
            
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error showing PDF page", e)
            showStatus("Ошибка загрузки PDF")
        }
    }

    private fun showPptxSlide(fileName: String?, slide: Int) {
        // КРИТИЧНО: Проверяем состояние Activity перед началом
        if (isDestroyed || isFinishing) {
            Log.d(TAG, "Activity destroyed, skipping showPptxSlide")
            return
        }
        
        try {
            val file = fileName ?: currentPptxFile
            if (file == null) {
                Log.w(TAG, "⚠️ PPTX file name is null")
                return
            }

            val wasFirstShow = currentPptxFile == null
            currentPptxFile = file
            currentPptxSlide = slide
            
            // Презентация - НЕ заглушка, при stop вернемся на заглушку
            isPlayingPlaceholder = false

            val slideUrl = "$SERVER_URL/api/devices/$DEVICE_ID/converted/${Uri.encode(file)}/slide/$slide"
            Log.i(TAG, "📊 Showing PPTX slide: $slideUrl (slide $slide, wasFirstShow=$wasFirstShow)")

            // Сбрасываем currentVideoFile для корректного возврата к видео
            currentVideoFile = null
            savedPosition = 0

            // КРИТИЧНО: Логика переходов как в JS плеере
            // Первый показ презентации - через черный экран (500ms)
            // Переключение слайдов - мгновенно (skipTransition)
            val needFadeOut = playerView.alpha > 0f && playerView.visibility == View.VISIBLE
            
            if (needFadeOut) {
                Log.d(TAG, "🎬 Fade-out видео перед показом PPTX...")
                player?.pause()
                fadeOutView(playerView, 500) {
                    player?.stop()
                    player?.clearMediaItems()
                    playerView.alpha = 0f
                    playerView.visibility = View.GONE
                    
                    // Первый показ - через логотип (fade-in поверх логотипа)
                    if (wasFirstShow) {
                        showLogoBackground()
                        loadImageToView(slideUrl, useFadeFromLogo = true, delayMs = 300)
                    } else {
                        // Переключение слайдов - мгновенно
                        loadImageToView(slideUrl, useFadeFromLogo = false, delayMs = 0)
                    }
                }
            } else {
                // Видео не было
                player?.stop()
                player?.clearMediaItems()
                playerView.visibility = View.GONE
                playerView.alpha = 0f
                imageView.alpha = 0f
                imageView.visibility = View.GONE
                
                // Первый показ - через логотип (fade-in поверх логотипа), переключение - мгновенно
                if (wasFirstShow) {
                    showLogoBackground()
                    loadImageToView(slideUrl, useFadeFromLogo = true, delayMs = 300)
                } else {
                    // Переключение слайдов - мгновенно (skipTransition как в JS)
                    loadImageToView(slideUrl, useFadeFromLogo = false, delayMs = 0)
                }
            }
            
            // Предзагружаем соседние слайды для быстрого переключения
            preloadAdjacentSlides(file, slide, 999, "pptx")  // 999 как max (не знаем точное кол-во)
            
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error showing PPTX slide", e)
            showStatus("Ошибка загрузки PPTX")
        }
    }

    private fun showFolderImage(folderName: String?, imageNum: Int) {
        // КРИТИЧНО: Проверяем состояние Activity перед началом
        if (isDestroyed || isFinishing) {
            Log.d(TAG, "Activity destroyed, skipping showFolderImage")
            return
        }
        
        try {
            val folder = folderName ?: currentFolderName
            if (folder == null) {
                Log.w(TAG, "⚠️ Folder name is null")
                return
            }

            val wasFirstShow = currentFolderName == null
            currentFolderName = folder
            currentFolderImage = imageNum
            
            // Папка с изображениями - НЕ заглушка, при stop вернемся на заглушку
            isPlayingPlaceholder = false

            val imageUrl = "$SERVER_URL/api/devices/$DEVICE_ID/folder/${Uri.encode(folder)}/image/$imageNum"
            Log.i(TAG, "📁 Showing folder image: $imageUrl (image $imageNum, wasFirstShow=$wasFirstShow)")

            // Сбрасываем currentVideoFile для корректного возврата к видео
            currentVideoFile = null
            savedPosition = 0

            // КРИТИЧНО: Логика переходов как в JS плеере
            // Первый показ папки - через черный экран (500ms)
            // Переключение изображений - мгновенно (skipTransition)
            val needFadeOut = playerView.alpha > 0f && playerView.visibility == View.VISIBLE
            
            if (needFadeOut) {
                Log.d(TAG, "🎬 Fade-out видео перед показом изображения из папки...")
                player?.pause()
                fadeOutView(playerView, 500) {
                    player?.stop()
                    player?.clearMediaItems()
                    playerView.alpha = 0f
                    playerView.visibility = View.GONE
                    
                    // Первый показ - через логотип (fade-in поверх логотипа)
                    if (wasFirstShow) {
                        showLogoBackground()
                        loadImageToView(imageUrl, useFadeFromLogo = true, delayMs = 300)
                    } else {
                        // Переключение изображений - мгновенно
                        loadImageToView(imageUrl, useFadeFromLogo = false, delayMs = 0)
                    }
                }
            } else {
                // Видео не было
                player?.stop()
                player?.clearMediaItems()
                playerView.visibility = View.GONE
                playerView.alpha = 0f
                imageView.alpha = 0f
                imageView.visibility = View.GONE
                
                // Первый показ - через логотип (fade-in поверх логотипа), переключение - мгновенно
                if (wasFirstShow) {
                    showLogoBackground()
                    loadImageToView(imageUrl, useFadeFromLogo = true, delayMs = 300)
                } else {
                    // Переключение изображений - мгновенно (skipTransition как в JS)
                    loadImageToView(imageUrl, useFadeFromLogo = false, delayMs = 0)
                }
            }
            
            // Предзагружаем соседние изображения для быстрого переключения
            preloadAdjacentSlides(folder, imageNum, 999, "folder")  // 999 как max (не знаем точное кол-во)
            
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error showing folder image", e)
            showStatus("Ошибка загрузки изображения")
        }
    }

    private fun loadImageToView(imageUrl: String, useFadeFromLogo: Boolean = false, delayMs: Int = 0) {
        try {
            // Glide для быстрой загрузки изображений
            Log.d(TAG, "🖼️ Loading image with Glide: $imageUrl (useFadeFromLogo=$useFadeFromLogo, delayMs=$delayMs)")
            
            imageView.visibility = View.VISIBLE
            imageView.alpha = 0f  // Всегда начинаем с прозрачности для fade-in
            
            val request = Glide.with(this)
                .load(imageUrl)
                .diskCacheStrategy(DiskCacheStrategy.ALL)  // Полный кэш для презентаций
                .skipMemoryCache(false)  // Используем memory cache для мгновенного показа
                .timeout(10000)
                .error(android.R.drawable.ic_dialog_alert)
                .listener(object : com.bumptech.glide.request.RequestListener<android.graphics.drawable.Drawable> {
                    override fun onResourceReady(
                        resource: android.graphics.drawable.Drawable,
                        model: Any,
                        target: com.bumptech.glide.request.target.Target<android.graphics.drawable.Drawable>,
                        dataSource: com.bumptech.glide.load.DataSource,
                        isFirstResource: Boolean
                    ): Boolean {
                        // Изображение загружено - делаем fade-in поверх логотипа (как в JS плеере)
                        if (useFadeFromLogo) {
                            Handler(Looper.getMainLooper()).postDelayed({
                                // Показываем изображение с fade-in поверх логотипа (500ms как в JS)
                                // brandBg остается видимым под изображением
                                fadeInView(imageView, 500) {
                                    Log.d(TAG, "✅ Fade-in изображения поверх логотипа завершен")
                                }
                            }, delayMs.toLong())
                        } else {
                            // Без fade - сразу показываем (для мгновенных переходов слайдов)
                            // brandBg остается видимым под изображением
                            imageView.alpha = 1f
                        }
                        return false
                    }
                    
                    override fun onLoadFailed(
                        e: com.bumptech.glide.load.engine.GlideException?,
                        model: Any?,
                        target: com.bumptech.glide.request.target.Target<android.graphics.drawable.Drawable>,
                        isFirstResource: Boolean
                    ): Boolean {
                        Log.e(TAG, "❌ Glide failed to load image: $imageUrl", e)
                        // При ошибке логотип остается видимым
                        return false
                    }
                })
            
            request.into(imageView)
            
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error loading image with Glide", e)
            showStatus("Ошибка загрузки изображения")
            // При ошибке логотип остается видимым
        }
    }
    
    /**
     * Предзагрузка соседних слайдов в кэш для мгновенного переключения
     */
    private fun preloadAdjacentSlides(file: String, currentPage: Int, totalPages: Int, type: String) {
        try {
            // Предзагружаем предыдущий и следующий слайды
            val pagesToPreload = mutableListOf<Int>()
            
            if (currentPage > 1) pagesToPreload.add(currentPage - 1)  // Предыдущий
            if (currentPage < totalPages) pagesToPreload.add(currentPage + 1)  // Следующий
            
            pagesToPreload.forEach { page ->
                val url = when (type) {
                    "pdf" -> "$SERVER_URL/api/devices/$DEVICE_ID/converted/${Uri.encode(file)}/page/$page"
                    "pptx" -> "$SERVER_URL/api/devices/$DEVICE_ID/converted/${Uri.encode(file)}/slide/$page"
                    "folder" -> "$SERVER_URL/api/devices/$DEVICE_ID/folder/${Uri.encode(file)}/image/$page"
                    else -> return
                }
                
                // Предзагружаем в фоне (Glide автоматически кэширует)
                Glide.with(this)
                    .load(url)
                    .diskCacheStrategy(DiskCacheStrategy.ALL)
                    .preload()
                
                Log.d(TAG, "📥 Preloading $type page $page")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to preload adjacent slides: ${e.message}")
        }
    }

    private fun loadPlaceholder(skipLogoTransition: Boolean = false) {
        // КРИТИЧНО: Защита от параллельных вызовов
        if (isLoadingPlaceholder) {
            Log.d(TAG, "⚠️ loadPlaceholder() уже выполняется, пропускаем...")
            return
        }
        
        isLoadingPlaceholder = true
        Log.i(TAG, "🔍 Loading placeholder...")
        
        // Сбрасываем currentVideoFile для корректной загрузки заглушки заново
        currentVideoFile = null
        savedPosition = 0
        isVideoReadyToShow = false
        pendingVideoFileName = null
        
        // КРИТИЧНО: Логика переходов как в JS плеере
        // При skipLogoTransition=true (из player/stop) - без дополнительного показа логотипа
        // Иначе - показываем логотип перед заглушкой если нужно
        
        // Плавный переход: fade-out текущего контента
        val hasVisibleContent = (playerView.alpha > 0f && playerView.visibility == View.VISIBLE) ||
                                (imageView.alpha > 0f && imageView.visibility == View.VISIBLE)
        
        if (hasVisibleContent && !skipLogoTransition) {
            Log.d(TAG, "🎬 Fade-out текущего контента перед заглушкой...")
            
            // Fade-out видео если видимо
            if (playerView.alpha > 0f && playerView.visibility == View.VISIBLE) {
                player?.pause()
                fadeOutView(playerView, 500) {
                    player?.stop()
                    player?.clearMediaItems()  // КРИТИЧНО: Очищаем медиа-элементы для освобождения ресурсов
                    playerView.alpha = 0f
                    loadPlaceholderAfterFade(false)  // После fade-out - обычный переход
                }
            } 
            // Fade-out изображения если видимо
            else if (imageView.alpha > 0f && imageView.visibility == View.VISIBLE) {
                fadeOutView(imageView, 500) {
                    imageView.alpha = 0f
                    imageView.visibility = View.GONE
                    Glide.with(this).clear(imageView)
                    imageView.setImageDrawable(null)
                    loadPlaceholderAfterFade(false)  // После fade-out - обычный переход
                }
            }
        } else {
            // Контента не было или skipLogoTransition - сразу загружаем заглушку
            loadPlaceholderAfterFade(skipLogoTransition)
        }
    }
    
    private fun loadPlaceholderAfterFade(skipLogoTransition: Boolean = false) {
        // КРИТИЧНО: Очищаем плеер полностью перед загрузкой заглушки
        player?.stop()
        player?.clearMediaItems()
        
        // Очищаем ImageView
        Glide.with(this).clear(imageView)
        imageView.setImageDrawable(null)
        imageView.visibility = View.GONE
        imageView.alpha = 0f
        playerView.visibility = View.GONE
        playerView.alpha = 0f
        
        // КРИТИЧНО: Логотип всегда остается видимым (если не skipLogoTransition)
        // При skipLogoTransition логотип уже видим, при обычном переходе показываем его
        if (!skipLogoTransition) {
            showLogoBackground()
        }
        
        // Проверяем кэш - если есть, загружаем сразу без запроса к серверу!
        if (cachedPlaceholderFile != null && cachedPlaceholderType != null) {
            Log.i(TAG, "✅ Using cached placeholder: $cachedPlaceholderFile ($cachedPlaceholderType)")
            
            when (cachedPlaceholderType) {
                "video" -> playVideo(cachedPlaceholderFile!!, isPlaceholder = true)
                "image" -> showImage(cachedPlaceholderFile!!, isPlaceholder = true)
            }
            isLoadingPlaceholder = false  // Сбрасываем флаг после успешной загрузки из кэша
            return
        }
        
        // Кэша нет - запрашиваем заглушку с сервера (только первый раз)
        loadPlaceholderFromServer()
    }
    
    private fun loadPlaceholderFromServer() {
        placeholderJob?.cancel()  // Отменяем предыдущую загрузку если была
        // КРИТИЧНО: Используем lifecycleScope для автоматической отмены при уничтожении Activity
        placeholderJob = lifecycleScope.launch(Dispatchers.IO) {
            // КРИТИЧНО: Проверяем что Activity еще жива перед началом
            if (isDestroyed || isFinishing) {
                Log.d(TAG, "Activity destroyed, canceling placeholder load")
                return@launch
            }
            
            try {
                val url = java.net.URL("$SERVER_URL/api/devices/$DEVICE_ID/placeholder")
                val connection = url.openConnection() as java.net.HttpURLConnection
                connection.connectTimeout = 5000  // Уменьшен таймаут
                connection.readTimeout = 5000
                connection.requestMethod = "GET"
                
                // КРИТИЧНО: Проверяем состояние Activity перед обработкой ответа
                if (isDestroyed || isFinishing) {
                    connection.disconnect()
                    return@launch
                }
                
                if (connection.responseCode == 200) {
                    val response = connection.inputStream.bufferedReader().use { it.readText() }
                    val json = JSONObject(response)
                    val placeholderFile = json.optString("placeholder", null)
                    
                    if (placeholderFile != null && placeholderFile != "null") {
                        Log.i(TAG, "✅ Placeholder found: $placeholderFile")
                        
                        // Определяем тип заглушки (видео или изображение)
                        val ext = placeholderFile.substringAfterLast('.', "").lowercase()
                        
                        // СОХРАНЯЕМ В КЭШ для быстрой загрузки в следующий раз!
                        cachedPlaceholderFile = placeholderFile
                        cachedPlaceholderType = when {
                            ext in listOf("mp4", "webm", "ogg", "mkv", "mov", "avi") -> "video"
                            ext in listOf("png", "jpg", "jpeg", "gif", "webp") -> "image"
                            else -> null
                        }
                        
                        Log.i(TAG, "💾 Cached placeholder: $cachedPlaceholderFile ($cachedPlaceholderType)")
                        
                        // КРИТИЧНО: Проверяем состояние Activity перед переключением на Main
                        if (isDestroyed || isFinishing) {
                            connection.disconnect()
                            return@launch
                        }
                        
                        withContext(Dispatchers.Main) {
                            // КРИТИЧНО: Дополнительная проверка на Main потоке
                            if (isDestroyed || isFinishing) return@withContext
                            
                            when (cachedPlaceholderType) {
                                "video" -> playVideo(placeholderFile, isPlaceholder = true)
                                "image" -> showImage(placeholderFile, isPlaceholder = true)
                                else -> Log.w(TAG, "⚠️ Unknown placeholder type: $ext")
                            }
                            isLoadingPlaceholder = false  // Сбрасываем флаг после успешной загрузки
                        }
                    } else {
                        Log.i(TAG, "ℹ️ No placeholder set for this device")
                        // КРИТИЧНО: Проверяем состояние Activity перед переключением на Main
                        if (!isDestroyed && !isFinishing) {
                            withContext(Dispatchers.Main) {
                                if (isDestroyed || isFinishing) return@withContext
                                // Показываем логотип (без контента)
                                playerView.visibility = View.GONE
                                imageView.visibility = View.GONE
                                showLogoBackground()
                                isLoadingPlaceholder = false  // Сбрасываем флаг даже если заглушки нет
                            }
                        }
                    }
                } else {
                    Log.e(TAG, "❌ Failed to load placeholder: HTTP ${connection.responseCode}, retrying in 10s...")
                    // КРИТИЧНО: Проверяем состояние Activity перед retry
                    if (!isDestroyed && !isFinishing) {
                        withContext(Dispatchers.Main) {
                            if (!isDestroyed && !isFinishing) {
                                isLoadingPlaceholder = false  // Сбрасываем флаг перед retry
                            }
                        }
                        scheduleRetryPlaceholder()
                    }
                }
                connection.disconnect()
            } catch (e: OutOfMemoryError) {
                Log.e(TAG, "❌ OutOfMemoryError loading placeholder, clearing caches", e)
                // КРИТИЧНО: Обработка OOM
                if (!isDestroyed && !isFinishing) {
                    withContext(Dispatchers.Main) {
                        if (!isDestroyed && !isFinishing) {
                            handleOutOfMemory()
                            isLoadingPlaceholder = false
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "❌ Error loading placeholder: ${e.message}, retrying in 10s...", e)
                // КРИТИЧНО: Проверяем состояние Activity перед retry
                if (!isDestroyed && !isFinishing) {
                    withContext(Dispatchers.Main) {
                        if (!isDestroyed && !isFinishing) {
                            isLoadingPlaceholder = false  // Сбрасываем флаг перед retry
                        }
                    }
                    scheduleRetryPlaceholder()
                }
            }
        }
    }
    
    private fun scheduleRetryPlaceholder() {
        // Retry через 10 секунд
        // КРИТИЧНО: Отменяем предыдущий retry перед созданием нового
        retryRunnable?.let { retryHandler.removeCallbacks(it) }
        retryRunnable = Runnable {
            // КРИТИЧНО: Проверяем что Activity еще жива
            if (isDestroyed || isFinishing) {
                Log.d(TAG, "Activity destroyed, skipping placeholder retry")
                return@Runnable
            }
            
            if (cachedPlaceholderFile == null && socket?.connected() == true) {
                Log.i(TAG, "🔄 Retrying to load placeholder...")
                loadPlaceholder()
            }
        }
        retryHandler.postDelayed(retryRunnable!!, 10000)
    }

    private val statusHandler = Handler(Looper.getMainLooper())
    private val hideStatusRunnable = Runnable {
        // КРИТИЧНО: Проверяем что Activity еще жива
        if (isDestroyed || isFinishing) return@Runnable
        statusText.visibility = View.GONE
    }
    
    private fun showStatus(message: String, autohideSeconds: Int = 3) {
        if (showStatus) {
            // Отменяем предыдущий таймер скрытия
            statusHandler.removeCallbacks(hideStatusRunnable)
            
            statusText.text = message
            statusText.visibility = View.VISIBLE
            
            // Автоскрытие через N секунд
            if (autohideSeconds > 0) {
                statusHandler.postDelayed(hideStatusRunnable, autohideSeconds * 1000L)
            }
        }
        Log.d(TAG, "Status: $message (autohide: ${autohideSeconds}s)")
    }

    private fun hideStatus() {
        statusHandler.removeCallbacks(hideStatusRunnable)
        if (showStatus) {
            statusText.visibility = View.GONE
        }
    }

    private val pingRunnable = object : Runnable {
        override fun run() {
            // КРИТИЧНО: Проверяем что Activity еще жива
            if (isDestroyed || isFinishing) {
                Log.d(TAG, "Activity destroyed, stopping ping timer")
                return
            }
            
            // КРИТИЧНО: Проверяем состояние соединения перед отправкой
            if (socket?.connected() == true) {
                socket?.emit("player/ping")
                Log.d(TAG, "🏓 Ping sent")
            } else {
                Log.w(TAG, "Socket not connected, skipping ping")
            }
            
            // Планируем следующий ping
            val interval = config.pingInterval.toLong()
            pingHandler.postDelayed(this, interval)
        }
    }
    
    private fun startPingTimer() {
        stopPingTimer() // Останавливаем предыдущий таймер если был
        
        val interval = config.pingInterval.toLong()
        pingHandler.postDelayed(pingRunnable, interval) // Первый ping через interval
        
        Log.i(TAG, "✅ Ping timer started (interval: ${interval}ms)")
    }
    
    private fun stopPingTimer() {
        pingHandler.removeCallbacks(pingRunnable)
        Log.d(TAG, "⏹️ Ping timer stopped")
    }
    
    // Отправка прогресса воспроизведения на сервер
    private fun startProgressUpdates() {
        stopProgressUpdates() // Останавливаем предыдущий если был
        
        progressRunnable = object : Runnable {
            override fun run() {
                // КРИТИЧНО: Проверяем что Activity еще жива
                if (isDestroyed || isFinishing) {
                    Log.d(TAG, "Activity destroyed, stopping progress updates")
                    return
                }
                
                try {
                    val exoPlayer = player ?: return
                    val fileName = currentVideoFile ?: return
                    
                    // Отправляем прогресс только для видео (не для заглушек)
                    // Проверяем не только isPlaying, но и состояние буферизации
                    val isPlayingOrBuffering = exoPlayer.isPlaying || 
                        exoPlayer.playbackState == Player.STATE_BUFFERING ||
                        exoPlayer.playbackState == Player.STATE_READY
                    
                    if (!isPlayingPlaceholder && isPlayingOrBuffering) {
                        val currentTime = exoPlayer.currentPosition / 1000 // в секундах
                        val duration = exoPlayer.duration
                        val durationSeconds = if (duration > 0 && duration != com.google.android.exoplayer2.C.TIME_UNSET) {
                            duration / 1000
                        } else {
                            // Если длительность еще не известна, используем 0 (будет обновлено когда появится)
                            0
                        }
                        
                        // Отправляем прогресс даже если длительность еще не известна (0)
                        // Сервер сможет обновить когда длительность появится
                        val progressData = JSONObject().apply {
                            put("device_id", DEVICE_ID)
                            put("type", "video")
                            put("file", fileName)
                            put("currentTime", currentTime)
                            put("duration", durationSeconds)
                        }
                        
                        // КРИТИЧНО: Проверяем состояние соединения перед отправкой
                        if (socket?.connected() == true) {
                            socket?.emit("player/progress", progressData)
                            if (durationSeconds > 0) {
                                Log.d(TAG, "📊 Progress sent: ${currentTime}s / ${durationSeconds}s")
                            } else {
                                Log.d(TAG, "📊 Progress sent: ${currentTime}s / ? (duration not ready yet)")
                            }
                        } else {
                            Log.d(TAG, "Socket not connected, skipping progress update")
                        }
                    }
                } catch (e: OutOfMemoryError) {
                    Log.e(TAG, "OutOfMemoryError sending progress, clearing caches", e)
                    handleOutOfMemory()
                } catch (e: Exception) {
                    Log.w(TAG, "Error sending progress: ${e.message}")
                }
                
                // Планируем следующую отправку через 1 секунду
                progressHandler.postDelayed(this, 1000)
            }
        }
        
        // Первая отправка сразу
        progressHandler.post(progressRunnable!!)
        Log.d(TAG, "✅ Progress updates started")
    }
    
    private fun stopProgressUpdates() {
        progressRunnable?.let {
            progressHandler.removeCallbacks(it)
            progressRunnable = null
            Log.d(TAG, "⏹️ Progress updates stopped")
        }
    }
    
    // Загрузка логотипа в brandBg с cache-busting
    private fun loadBrandLogo() {
        try {
            // Используем timestamp для обхода кэша и получения свежего логотипа
            val logoUrl = "$SERVER_URL/branding/logo.svg?t=${System.currentTimeMillis()}"
            Log.d(TAG, "🖼️ Loading brand logo: $logoUrl")
            
            Glide.with(this)
                .load(logoUrl)
                .diskCacheStrategy(DiskCacheStrategy.NONE) // Не кэшируем, чтобы всегда получать свежий логотип
                .skipMemoryCache(true)
                .timeout(5000)
                .error(android.graphics.Color.BLACK) // Fallback на черный цвет
                .listener(object : com.bumptech.glide.request.RequestListener<android.graphics.drawable.Drawable> {
                    override fun onResourceReady(
                        resource: android.graphics.drawable.Drawable,
                        model: Any,
                        target: com.bumptech.glide.request.target.Target<android.graphics.drawable.Drawable>,
                        dataSource: com.bumptech.glide.load.DataSource,
                        isFirstResource: Boolean
                    ): Boolean {
                        Log.d(TAG, "✅ Brand logo loaded successfully")
                        return false
                    }
                    
                    override fun onLoadFailed(
                        e: com.bumptech.glide.load.engine.GlideException?,
                        model: Any?,
                        target: com.bumptech.glide.request.target.Target<android.graphics.drawable.Drawable>,
                        isFirstResource: Boolean
                    ): Boolean {
                        Log.w(TAG, "⚠️ Brand logo failed to load, using black background")
                        brandBg.setBackgroundColor(android.graphics.Color.BLACK)
                        return false
                    }
                })
                .into(brandBg)
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error loading brand logo", e)
            brandBg.setBackgroundColor(android.graphics.Color.BLACK)
        }
    }
    
    // Периодическое обновление логотипа (каждые 5 минут)
    private fun startLogoRefreshTimer() {
        stopLogoRefreshTimer()
        
        logoRefreshRunnable = Runnable {
            // КРИТИЧНО: Проверяем что Activity еще жива
            if (isDestroyed || isFinishing) {
                Log.d(TAG, "Activity destroyed, stopping logo refresh timer")
                return@Runnable
            }
            
            loadBrandLogo()
            // Планируем следующее обновление через 5 минут
            logoRefreshHandler.postDelayed(logoRefreshRunnable!!, 5 * 60 * 1000)
        }
        
        // Первое обновление через 5 минут
        logoRefreshHandler.postDelayed(logoRefreshRunnable!!, 5 * 60 * 1000)
        Log.d(TAG, "✅ Logo refresh timer started (every 5 minutes)")
    }
    
    private fun stopLogoRefreshTimer() {
        logoRefreshRunnable?.let {
            logoRefreshHandler.removeCallbacks(it)
            logoRefreshRunnable = null
            Log.d(TAG, "⏹️ Logo refresh timer stopped")
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        Log.i(TAG, "=== MainActivity onDestroy ===")
        
        // Очищаем все Handler
        stopPingTimer()
        stopProgressUpdates()
        stopLogoRefreshTimer()
        statusHandler.removeCallbacks(hideStatusRunnable)
        retryHandler.removeCallbacksAndMessages(null)
        progressHandler.removeCallbacksAndMessages(null)
        logoRefreshHandler.removeCallbacksAndMessages(null)
        
        // Отменяем корутины
        placeholderJob?.cancel()
        isLoadingPlaceholder = false  // Сбрасываем флаг загрузки заглушки
        
        // Освобождаем ресурсы с обработкой ошибок
        try {
            player?.release()
            player = null
        } catch (e: Exception) {
            Log.e(TAG, "Error releasing player: ${e.message}", e)
        }
        
        try {
            socket?.disconnect()
            socket?.off()  // Удаляем все слушатели
            socket = null
        } catch (e: Exception) {
            Log.e(TAG, "Error disconnecting socket: ${e.message}", e)
        }
        
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
            wakeLock = null
        } catch (e: Exception) {
            Log.e(TAG, "Error releasing wakeLock: ${e.message}", e)
        }
        
        try {
            simpleCache?.release()
            simpleCache = null
        } catch (e: Exception) {
            Log.e(TAG, "Error releasing cache: ${e.message}", e)
        }
        
        Log.i(TAG, "MainActivity destroyed - all resources released")
    }

    override fun onPause() {
        super.onPause()
        // НЕ паузим плеер для стабильности 24/7
        // Управление pause/play только через команды от сервера!
        Log.d(TAG, "onPause called, player continues running")
    }

    override fun onResume() {
        super.onResume()
        Log.d(TAG, "onResume called (isFirstLaunch=$isFirstLaunch)")
        
        // КРИТИЧНО: Пропускаем onResume сразу после onCreate
        if (isFirstLaunch) {
            Log.d(TAG, "First launch, skipping restore (onCreate is loading placeholder)")
            isFirstLaunch = false  // Сбрасываем ЗДЕСЬ в onResume
            return
        }
        
        // Восстанавливаем воспроизведение только если оно реально остановилось
        if (player?.isPlaying == false && (playerView.visibility == View.VISIBLE || imageView.visibility == View.VISIBLE)) {
            Log.i(TAG, "Player not playing in onResume, restoring...")
            if (isPlayingPlaceholder) {
                // Заглушка должна всегда играть
                player?.play()
            } else {
                // Если контент остановился - возвращаемся на заглушку
                loadPlaceholder()
            }
        }
    }
    
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        
        // КРИТИЧНО: Очищаем память при нехватке (для стабильности 24/7)
        if (level >= android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            Log.w(TAG, "Low memory detected (level $level), clearing caches")
            try {
                // Очищаем Glide memory cache
                Glide.get(this).clearMemory()
                Log.d(TAG, "Glide memory cache cleared")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to clear Glide memory: ${e.message}", e)
            }
            
            // КРИТИЧНО: При критической нехватке памяти очищаем и ExoPlayer кэш
            // (но только если контент не играет, чтобы не прерывать воспроизведение)
            if (level >= android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL) {
                Log.w(TAG, "Critical memory level, considering cache cleanup")
                // Не очищаем ExoPlayer кэш во время воспроизведения - это прервет playback
                // Вместо этого надеемся что система сама убьет процесс если нужно
            }
        }
    }
    
    /**
     * Обработка OutOfMemoryError - очистка кэшей и перезапуск компонентов
     */
    private fun handleOutOfMemory() {
        Log.e(TAG, "⚠️ Handling OutOfMemoryError - clearing caches and restarting")
        try {
            // Очищаем Glide полностью
            Glide.get(this).clearMemory()
            Glide.get(this).clearDiskCache()
            
            // Очищаем кэш ExoPlayer (вынужденная мера)
            try {
                simpleCache?.release()
                simpleCache = null
                
                // Пересоздаем кэш
                val cacheDir = File(cacheDir, "video_cache")
                cacheDir.deleteRecursively()
                cacheDir.mkdirs()
                
                simpleCache = SimpleCache(
                    cacheDir,
                    LeastRecentlyUsedCacheEvictor(config.cacheSize),
                    StandaloneDatabaseProvider(this)
                )
                Log.d(TAG, "ExoPlayer cache recreated after OOM")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to recreate cache after OOM: ${e.message}", e)
            }
            
            // Перезагружаем заглушку (она пересоздаст кэш при необходимости)
            if (isPlayingPlaceholder) {
                loadPlaceholder()
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "Error handling OOM: ${e.message}", e)
            // В критической ситуации - просто логируем
        }
    }
}


