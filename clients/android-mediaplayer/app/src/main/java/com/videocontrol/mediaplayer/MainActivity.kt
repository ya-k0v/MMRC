package com.videocontrol.mediaplayer

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
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
import com.google.android.exoplayer2.LoadControl
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
import android.graphics.drawable.TransitionDrawable
import android.graphics.drawable.BitmapDrawable
import android.graphics.Bitmap
import com.bumptech.glide.load.resource.drawable.DrawableTransitionOptions
import com.bumptech.glide.request.target.CustomTarget
import com.bumptech.glide.request.transition.DrawableCrossFadeFactory
import com.bumptech.glide.request.transition.Transition
import java.net.URISyntaxException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.lifecycle.lifecycleScope
import android.animation.ObjectAnimator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import kotlin.math.max
import kotlin.math.min

class MainActivity : AppCompatActivity() {

    private lateinit var playerView: StyledPlayerView
    private lateinit var playerViewPrimary: StyledPlayerView
    private lateinit var playerViewSecondary: StyledPlayerView
    private lateinit var bufferPlayerView: StyledPlayerView
    private lateinit var imageView: ImageView
    private lateinit var statusText: TextView
    private lateinit var brandBg: ImageView

    private var player: ExoPlayer? = null
    private var bufferPlayer: ExoPlayer? = null
    private var pendingPlayer: ExoPlayer? = null
    private var pendingPlayerView: StyledPlayerView? = null
    private var socket: Socket? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var simpleCache: SimpleCache? = null
    private val pingHandler = Handler(Looper.getMainLooper())
    private val retryHandler = Handler(Looper.getMainLooper())
    private val progressHandler = Handler(Looper.getMainLooper())
    private val connectionWatchdogHandler = Handler(Looper.getMainLooper())
    private var retryRunnable: Runnable? = null
    private var placeholderJob: Job? = null
    private var isPlayingPlaceholder: Boolean = false
    private var isLoadingPlaceholder: Boolean = false  // Защита от параллельных вызовов loadPlaceholder()
    private var progressRunnable: Runnable? = null
    
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
    private var lastSocketReconnectAttempt = 0L
    private var isSocketReconnecting = false
    private var socketBackoffMs = 2000L

    private val TAG = "VCMediaPlayer"
    private var SERVER_URL = ""
    private var DEVICE_ID = ""

    private fun cancelPendingBuffer(reason: String) {
        val pending = pendingPlayer ?: return
        val pendingView = pendingPlayerView
        Log.d(TAG, "🧹 Cancel pending buffer ($reason)")
        try {
            pending.stop()
            pending.clearMediaItems()
        } catch (_: Exception) {
        }
        pendingView?.let {
            it.alpha = 0f
            it.visibility = View.GONE
        }
        pendingPlayer = null
        pendingPlayerView = null
        pendingVideoFileName = null
        pendingVideoIsPlaceholder = false
        isVideoReadyToShow = false
        hasVideoSize = false
    }

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

        playerViewPrimary = findViewById(R.id.playerView)
        playerViewSecondary = findViewById(R.id.playerViewBuffer)
        playerView = playerViewPrimary
        bufferPlayerView = playerViewSecondary
        imageView = findViewById(R.id.imageView)
        statusText = findViewById(R.id.statusText)
        brandBg = findViewById(R.id.brandBg)
        // Логотип больше не используется - смена контента идет через кроссфейд
        bufferPlayerView.alpha = 0f
        bufferPlayerView.visibility = View.GONE

        // Длинное нажатие на экран - открывает настройки
        val openSettingsListener = View.OnLongClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
            true
        }
        playerViewPrimary.setOnLongClickListener(openSettingsListener)
        playerViewSecondary.setOnLongClickListener(openSettingsListener)

        // Скрываем контролы ExoPlayer
        playerViewPrimary.useController = false
        playerViewSecondary.useController = false

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
        startConnectionWatchdog()
        
        // КРИТИЧНО: Загружаем заглушку при старте (постоянно показываем заглушку)
        loadPlaceholder()
    }

    private fun initializePlayer() {
        try {
            // Освобождаем старый кэш если был
            releaseSimpleCache()
            initializeSimpleCache()

            fun buildLoadControl(): LoadControl {
                return DefaultLoadControl.Builder()
                    .setAllocator(DefaultAllocator(true, C.DEFAULT_BUFFER_SEGMENT_SIZE))
                    .setBufferDurationsMs(
                        config.bufferMinMs,
                        config.bufferMaxMs,
                        2500,
                        5000
                    )
                    .setPrioritizeTimeOverSizeThresholds(true)
                    .build()
            }

            val primaryLoadControl = buildLoadControl()
            val secondaryLoadControl = buildLoadControl()

            player = buildPlayer(primaryLoadControl, playerViewPrimary)
            bufferPlayer = buildPlayer(secondaryLoadControl, playerViewSecondary)

            Log.i(TAG, "ExoPlayer initialized (cache: ${config.cacheSize / 1024 / 1024}MB, buffer: ${config.bufferMinMs}-${config.bufferMaxMs}ms)")
            
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error initializing player", e)
        }
    }

    private fun buildPlayer(loadControl: LoadControl, targetView: StyledPlayerView): ExoPlayer {
        return ExoPlayer.Builder(this)
                .setLoadControl(loadControl)
                .build()
                .also { exoPlayer ->
                targetView.player = exoPlayer

                    exoPlayer.addListener(object : Player.Listener {
                        override fun onPlaybackStateChanged(playbackState: Int) {
                        val isActivePlayer = exoPlayer === player
                        val isPendingPlayerInstance = exoPlayer === pendingPlayer

                            when (playbackState) {
                            Player.STATE_IDLE -> Log.d(TAG, "Player STATE_IDLE (${if (isActivePlayer) "active" else "buffer"})")
                                Player.STATE_BUFFERING -> {
                                if (isActivePlayer) {
                                    Log.d(TAG, "Player STATE_BUFFERING (active)")
                                    showStatus("Буферизация...", autohideSeconds = 0)
                                } else {
                                    Log.d(TAG, "Player STATE_BUFFERING (buffer)")
                                }
                                }

                                Player.STATE_READY -> {
                                Log.d(TAG, "Player STATE_READY (${if (isActivePlayer) "active" else "buffer"})")
                                if (isActivePlayer) {
                                    errorRetryCount = 0
                                    hideStatus()
                                }
                                    
                                if (isPendingPlayerInstance && !isVideoReadyToShow && pendingVideoFileName != null) {
                                        if (hasVideoSize) {
                                            startVideoFadeIn()
                                        } else {
                                            Log.d(TAG, "📸 STATE_READY получен, ждем onVideoSizeChanged для: ${pendingVideoFileName}")
                                            Handler(Looper.getMainLooper()).postDelayed({
                                            if (!isDestroyed && !isFinishing && !isVideoReadyToShow && pendingVideoFileName != null && pendingPlayer === exoPlayer) {
                                                    Log.d(TAG, "⏱️ Таймаут ожидания onVideoSizeChanged, начинаем fade-in")
                                                    startVideoFadeIn()
                                                }
                                        }, 500)
                                        }
                                    }
                                }

                                Player.STATE_ENDED -> {
                                if (isActivePlayer) {
                                    Log.d(TAG, "Player STATE_ENDED (active)")
                                    if (!isPlayingPlaceholder) {
                                        Log.i(TAG, "Контент закончился, fade-out перед возвратом на заглушку")
                                        if (playerView.alpha > 0f && playerView.visibility == View.VISIBLE) {
                                            player?.pause()
                                            fadeOutView(playerView, 500) {
                                                player?.stop()
                                                player?.clearMediaItems()
                                                playerView.alpha = 0f
                                                playerView.visibility = View.GONE
                                        loadPlaceholder()
                                            }
                                        } else {
                                            loadPlaceholder()
                                        }
                                    } else {
                                        Log.d(TAG, "Заглушка зациклена, ExoPlayer перезапустит автоматически")
                                    }
                                } else {
                                    Log.d(TAG, "Player STATE_ENDED (buffer) - ignored")
                                    }
                                }
                            }
                        }

                        override fun onPlayerError(error: com.google.android.exoplayer2.PlaybackException) {
                        val isActivePlayer = exoPlayer === player
                        if (!isActivePlayer && exoPlayer !== pendingPlayer) {
                            Log.e(TAG, "Player error on inactive buffer layer: ${error.message}")
                            return
                        }

                        Log.e(TAG, "Player error (${if (isActivePlayer) "active" else "buffer"}): ${error.message} (attempt $errorRetryCount/$maxRetryAttempts)", error)

                        if (!isActivePlayer) {
                            pendingPlayer = null
                            pendingPlayerView?.let {
                                it.alpha = 0f
                                it.visibility = View.GONE
                            }
                            pendingPlayerView = null
                            pendingVideoFileName = null
                            pendingVideoIsPlaceholder = false
                            isVideoReadyToShow = false
                            hasVideoSize = false
                            showStatus("Ошибка подготовки видео, ожидаем новое задание", autohideSeconds = 3)
                            return
                        }

                            val maxAttempts = if (!isPlayingPlaceholder) 10 else maxRetryAttempts
                            
                            showStatus("Ошибка воспроизведения, попытка $errorRetryCount/$maxAttempts...")
                            
                            retryRunnable?.let { retryHandler.removeCallbacks(it) }
                            retryRunnable = Runnable {
                                if (isDestroyed || isFinishing) {
                                    Log.d(TAG, "Activity destroyed, skipping retry")
                                    return@Runnable
                                }
                                
                                if (errorRetryCount < maxAttempts) {
                                    errorRetryCount++
                                    Log.i(TAG, "Retrying playback (attempt $errorRetryCount/$maxAttempts) [content=${!isPlayingPlaceholder}]...")
                                    
                                    try {
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
                        retryHandler.postDelayed(retryRunnable!!, 5000)
                        }

                        override fun onIsPlayingChanged(isPlaying: Boolean) {
                        if (exoPlayer !== player) {
                            return
                        }
                            Log.d(TAG, "Player isPlaying: $isPlaying")
                            
                        if (!isPlayingPlaceholder && currentVideoFile != null) {
                            val isVideoReady = player?.playbackState == Player.STATE_READY
                            if (isVideoReady || isPlaying) {
                                startProgressUpdates()
                            } else {
                                stopProgressUpdates()
                            }
                            } else {
                                stopProgressUpdates()
                            }
                        }
                        
                        override fun onVideoSizeChanged(videoSize: com.google.android.exoplayer2.video.VideoSize) {
                        if (exoPlayer !== pendingPlayer) {
                            return
                        }
                        Log.d(TAG, "📐 Video size changed (buffer): ${videoSize.width}x${videoSize.height}")
                            hasVideoSize = true
                            
                        if (!isVideoReadyToShow && pendingVideoFileName != null) {
                                startVideoFadeIn()
                            }
                        }
                    })
        }
    }

    private fun releaseSimpleCache() {
        try {
            simpleCache?.release()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to release cache: ${e.message}")
        } finally {
            simpleCache = null
        }
    }

    private fun initializeSimpleCache() {
        if (simpleCache != null) return

        val videoCacheDir = File(cacheDir, "video_cache")
        try {
            simpleCache = SimpleCache(
                videoCacheDir,
                LeastRecentlyUsedCacheEvictor(config.cacheSize),
                StandaloneDatabaseProvider(this)
            )
        } catch (e: IllegalStateException) {
            Log.w(TAG, "Cache folder locked, recreating...")
            videoCacheDir.deleteRecursively()
            videoCacheDir.mkdirs()
            simpleCache = SimpleCache(
                videoCacheDir,
                LeastRecentlyUsedCacheEvictor(config.cacheSize),
                StandaloneDatabaseProvider(this)
            )
        } catch (e: Exception) {
            Log.e(TAG, "Unable to initialize cache: ${e.message}", e)
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
                isSocketReconnecting = false
                socketBackoffMs = 2000L
                Log.i(TAG, "✅ Socket connected")
                runOnUiThread {
                    showStatus("Подключено", autohideSeconds = 2)  // Скрываем через 2 сек
                    registerDevice()
                    startPingTimer()
                    
                    // Логотип больше не используется - смена контента идет через кроссфейд
                    
                    // КРИТИЧНО: При переподключении НЕ сбрасываем на заглушку!
                    // Если играет контент - продолжаем воспроизведение
                    if (!isPlayingPlaceholder && player?.isPlaying == true) {
                        Log.i(TAG, "Reconnected: content is playing, continuing...")
                        // КРИТИЧНО: Перезапускаем отправку прогресса после переподключения
                        if (currentVideoFile != null) {
                            startProgressUpdates()
                            Log.d(TAG, "✅ Restarted progress updates after reconnect")
                        }
                    } else if (!isPlayingPlaceholder && player?.isPlaying == false) {
                        Log.i(TAG, "Reconnected: content was paused, keeping paused")
                        // КРИТИЧНО: Перезапускаем отправку прогресса даже если на паузе (для отображения текущей позиции)
                        if (currentVideoFile != null) {
                            startProgressUpdates()
                            Log.d(TAG, "✅ Restarted progress updates after reconnect (paused)")
                        }
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
                    isSocketReconnecting = false
                    increaseSocketBackoff()
                    scheduleConnectionWatchdog()
                    ensureSocketConnected("EVENT_DISCONNECT")
                    
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
                isSocketReconnecting = false
                increaseSocketBackoff()
                runOnUiThread {
                    showStatus("Ошибка подключения", autohideSeconds = 5)  // Скрываем через 5 сек
                    ensureSocketConnected("EVENT_CONNECT_ERROR")
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
                    // Логотип больше не используется
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
                    loadPlaceholder(skipLogoTransition = true)
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
                    loadPlaceholder(forceReload = true)
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
                    runOnUiThread {
                        // КРИТИЧНО: Обрабатываем команду только если устройство воспроизводит папку
                        // Это защита от случайных команд, предназначенных другим устройствам
                        if (currentFolderName != null) {
                            showFolderImage(null, imageNum)
                        } else {
                            Log.d(TAG, "⚠️ player/folderPage игнорируется - устройство не воспроизводит папку")
                        }
                    }
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

    private fun fadeOutVideoWithLogo(durationMs: Long = 500, onComplete: () -> Unit) {
        // Логотип больше не используется - просто fade-out видео
        player?.pause()
        fadeOutView(playerView, durationMs) {
            player?.stop()
            player?.clearMediaItems()
            playerView.alpha = 0f
            playerView.visibility = View.GONE
            onComplete()
        }
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
        val targetPlayer = pendingPlayer ?: return
        val targetView = pendingPlayerView ?: return
        
        isVideoReadyToShow = true
        val fileName = pendingVideoFileName!!
        val isPlaceholder = pendingVideoIsPlaceholder
        Log.d(TAG, "📸 Начинаем fade-in видео: $fileName (hasVideoSize=$hasVideoSize, isPlaceholder=$isPlaceholder)")
        
        targetView.visibility = View.VISIBLE
        targetView.bringToFront()
        imageView.bringToFront()
        statusText.bringToFront()
        targetView.alpha = 0f
        
        if (brandBg.visibility == View.VISIBLE && brandBg.alpha > 0f) {
            brandBg.animate()
                .alpha(0f)
                .setDuration(200)
                .withEndAction { brandBg.visibility = View.GONE }
                .start()
        } else {
            brandBg.visibility = View.GONE
            brandBg.alpha = 0f
        }
        
        val outgoingView = playerView
        val outgoingPlayer = player
        val hasOutgoingVideo = outgoingView.alpha > 0f && outgoingView.visibility == View.VISIBLE
        val hasOutgoingImage = imageView.alpha > 0f && imageView.visibility == View.VISIBLE

        if (hasOutgoingVideo) {
            outgoingPlayer?.pause()
        }

        val playerToStart = targetPlayer
        playerToStart.playWhenReady = true
        playerToStart.play()

        val fadeDuration = 500L
        val animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = fadeDuration
            addUpdateListener { valueAnimator ->
                val value = valueAnimator.animatedValue as Float
                targetView.alpha = value
                when {
                    hasOutgoingImage -> imageView.alpha = 1f - value
                    hasOutgoingVideo -> outgoingView.alpha = 1f - value
                }
            }
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: android.animation.Animator) {
                    if (hasOutgoingVideo) {
                        outgoingPlayer?.stop()
                        outgoingPlayer?.clearMediaItems()
                        outgoingView.alpha = 0f
                        outgoingView.visibility = View.GONE
                    }
                    if (hasOutgoingImage) {
                        imageView.alpha = 0f
                        imageView.visibility = View.GONE
                        Glide.with(this@MainActivity).clear(imageView)
                        imageView.setImageDrawable(null)
                    }
                    finalizeVideoSwap(targetPlayer, targetView)
                }
            })
        }

        animator.start()
    }

    private fun finalizeVideoSwap(newActivePlayer: ExoPlayer, newActiveView: StyledPlayerView) {
        val previousPlayer = player
        val previousView = playerView

        player = newActivePlayer
        playerView = newActiveView

        bufferPlayer = previousPlayer
        bufferPlayerView = previousView

        bufferPlayerView.alpha = 0f
        bufferPlayerView.visibility = View.GONE

        pendingPlayer = null
        pendingPlayerView = null
        pendingVideoFileName = null
        pendingVideoIsPlaceholder = false
        isVideoReadyToShow = false
        hasVideoSize = false
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
            
        cancelPendingBuffer("new playVideo command for $fileName")

            // Новый файл - плавный переход с двойной буферизацией
            Log.i(TAG, "🎬 Загрузка НОВОГО видео с буферизацией: $fileName")
            stopProgressUpdates()
            currentVideoFile = fileName
            savedPosition = 0
            isVideoReadyToShow = false
            hasVideoSize = false

        val targetPlayer = bufferPlayer ?: player
        val targetView = if (targetPlayer === player) playerView else bufferPlayerView

            if (targetPlayer == null || targetView == null) {
                Log.e(TAG, "❌ Нет свободного буфера для загрузки видео")
                showStatus("Ошибка подготовки видео")
                return
            }

            loadNewVideo(videoUrl, fileName, isPlaceholder, targetPlayer, targetView)
            
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "❌ OutOfMemoryError playing video: $fileName", e)
            handleOutOfMemory()
            // Не показываем сообщение зрителям - очистка происходит в фоне
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error playing video: $fileName", e)
            if (!isDestroyed && !isFinishing) {
                showStatus("Ошибка загрузки видео")
            }
        }
    }
    
    private fun loadNewVideo(
        videoUrl: String,
        originalFileName: String,
        isPlaceholder: Boolean,
        targetPlayer: ExoPlayer,
        targetView: StyledPlayerView
    ) {
        try {
            Log.d(TAG, "📥 Загрузка нового видео: $videoUrl")
            
            // HTTP Data Source с увеличенными таймаутами для больших файлов
            val httpDataSourceFactory = DefaultHttpDataSource.Factory().apply {
                setAllowCrossProtocolRedirects(true)
                setConnectTimeoutMs(60000)   // 60 секунд на подключение
                setReadTimeoutMs(60000)      // 60 секунд на чтение
                setUserAgent("VideoControl/1.0")
            }

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

            pendingPlayer = targetPlayer
            pendingPlayerView = targetView
            pendingVideoFileName = originalFileName
            pendingVideoIsPlaceholder = isPlaceholder
            isVideoReadyToShow = false
            hasVideoSize = false

        targetView.visibility = View.VISIBLE
        targetView.alpha = 0f
        targetView.bringToFront()
        statusText.bringToFront()

            targetPlayer.apply {
                stop()
                setMediaSource(mediaSource)
                repeatMode = if (isPlaceholder) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
                prepare()
                playWhenReady = false
            }
            
            isPlayingPlaceholder = isPlaceholder
            
            Log.i(TAG, "✅ Video source set, waiting for STATE_READY and fade-in...")
            
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "❌ OutOfMemoryError loading new video", e)
            handleOutOfMemory()
            // Не показываем сообщение зрителям - очистка происходит в фоне
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

            // КРИТИЧНО: Для заглушки НЕ показываем логотип - заглушка должна быть всегда видна
            // Логотип только для переходов между контентом
            if (isPlaceholder) {
                brandBg.visibility = View.GONE
                brandBg.alpha = 0f
            }

            val hasPreviousImage = imageView.drawable != null && imageView.alpha > 0f && imageView.visibility == View.VISIBLE
            val hasVideo = playerView.alpha > 0f && playerView.visibility == View.VISIBLE

            if (!hasVideo) {
                player?.stop()
                player?.clearMediaItems()
                playerView.visibility = View.GONE
                playerView.alpha = 0f
            }

            loadImageToView(
                imageUrl,
                useFadeFromLogo = false,
                delayMs = 0,
                crossFadeFromCurrent = !hasVideo && hasPreviousImage,
                crossFadeFromVideo = hasVideo
            )

            // Отмечаем тип контента
            isPlayingPlaceholder = isPlaceholder
            
            Log.i(TAG, "✅ Image loading: isPlaceholder=$isPlaceholder")
            
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "❌ OutOfMemoryError showing image: $fileName", e)
            handleOutOfMemory()
            // Не показываем сообщение зрителям - очистка происходит в фоне
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error showing image: $fileName", e)
            if (!isDestroyed && !isFinishing) {
                showStatus("Ошибка загрузки изображения")
            }
        }
    }
    
    // Логотип больше не используется - смена контента идет через кроссфейд
    // Функция оставлена для совместимости, но ничего не делает
    private fun showLogoBackground(fadeDurationMs: Long = 500L) {
        // Скрываем brandBg, так как логотип не используется
        brandBg.visibility = View.GONE
            brandBg.alpha = 0f
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

            // КРИТИЧНО: Логика переходов - всегда используем кроссфейд если есть предыдущий контент
            // Проверяем наличие предыдущего изображения (для кроссфейда между слайдами)
            // Важно: проверяем drawable независимо от visibility, так как изображение может быть загружено но скрыто
            val hasPreviousImage = imageView.drawable != null
            val hasVideo = playerView.alpha > 0f && playerView.visibility == View.VISIBLE

            if (!hasVideo) {
                player?.stop()
                player?.clearMediaItems()
                playerView.visibility = View.GONE
                playerView.alpha = 0f
            }

            loadImageToView(
                pageUrl,
                useFadeFromLogo = false,
                delayMs = 0,
                crossFadeFromCurrent = !hasVideo && hasPreviousImage,
                crossFadeFromVideo = hasVideo
            )
            
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

            // КРИТИЧНО: Логика переходов - всегда используем кроссфейд если есть предыдущий контент
            // Проверяем наличие предыдущего изображения (для кроссфейда между слайдами)
            // Важно: проверяем drawable независимо от visibility, так как изображение может быть загружено но скрыто
            val hasPreviousImage = imageView.drawable != null
            val hasVideo = playerView.alpha > 0f && playerView.visibility == View.VISIBLE

            if (!hasVideo) {
                player?.stop()
                player?.clearMediaItems()
                playerView.visibility = View.GONE
                playerView.alpha = 0f
            }

            loadImageToView(
                slideUrl,
                useFadeFromLogo = false,
                delayMs = 0,
                crossFadeFromCurrent = !hasVideo && hasPreviousImage,
                crossFadeFromVideo = hasVideo
            )
            
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

            // КРИТИЧНО: Логика переходов - всегда используем кроссфейд если есть предыдущий контент
            // Проверяем наличие предыдущего изображения (для кроссфейда между изображениями)
            // Важно: проверяем только наличие drawable, не alpha, чтобы кроссфейд работал даже если изображение еще в процессе fade-in
            val hasPreviousImage = imageView.drawable != null
            val hasVideo = playerView.alpha > 0f && playerView.visibility == View.VISIBLE

            if (!hasVideo) {
                player?.stop()
                player?.clearMediaItems()
                playerView.visibility = View.GONE
                playerView.alpha = 0f
            }

            loadImageToView(
                imageUrl,
                useFadeFromLogo = false,
                delayMs = 0,
                crossFadeFromCurrent = !hasVideo && hasPreviousImage,
                crossFadeFromVideo = hasVideo
            )
            
            // Предзагружаем соседние изображения для быстрого переключения
            preloadAdjacentSlides(folder, imageNum, 999, "folder")  // 999 как max (не знаем точное кол-во)
            
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error showing folder image", e)
            showStatus("Ошибка загрузки изображения")
        }
    }

    private fun loadImageToView(
        imageUrl: String,
        useFadeFromLogo: Boolean = false,
        delayMs: Int = 0,
        crossFadeFromCurrent: Boolean = false,
        crossFadeFromVideo: Boolean = false
    ) {
        try {
            // КРИТИЧНО: Проверяем состояние Activity перед началом
            if (isDestroyed || isFinishing) {
                Log.d(TAG, "Activity destroyed, skipping loadImageToView")
                return
            }
            
            // Glide для быстрой загрузки изображений
            Log.d(TAG, "🖼️ Loading image with Glide: $imageUrl (useFadeFromLogo=$useFadeFromLogo, delayMs=$delayMs, crossFadeFromCurrent=$crossFadeFromCurrent)")
            
            imageView.visibility = View.VISIBLE
            imageView.bringToFront()
            statusText.bringToFront()
            
            val request = Glide.with(this)
                .load(imageUrl)
                .diskCacheStrategy(DiskCacheStrategy.ALL)  // Полный кэш для презентаций
                .skipMemoryCache(false)  // Используем memory cache для мгновенного показа
                .timeout(10000)
                .error(android.R.drawable.ic_dialog_alert)
            
            val crossFadeVideoActive = crossFadeFromVideo && playerView.alpha > 0f && playerView.visibility == View.VISIBLE

            when {
                useFadeFromLogo -> {
                    imageView.alpha = 0f  // Всегда начинаем с прозрачности для fade-in
                    request.listener(object : com.bumptech.glide.request.RequestListener<android.graphics.drawable.Drawable> {
                        override fun onResourceReady(
                            resource: android.graphics.drawable.Drawable,
                            model: Any,
                            target: com.bumptech.glide.request.target.Target<android.graphics.drawable.Drawable>,
                            dataSource: com.bumptech.glide.load.DataSource,
                            isFirstResource: Boolean
                        ): Boolean {
                            Handler(Looper.getMainLooper()).postDelayed({
                                if (!isDestroyed && !isFinishing) {
                                    fadeInView(imageView, 500) {
                                        Log.d(TAG, "✅ Fade-in изображения поверх логотипа завершен")
                                    }
                                }
                            }, delayMs.toLong())
                            return false
                        }
                        
                        override fun onLoadFailed(
                            e: com.bumptech.glide.load.engine.GlideException?,
                            model: Any?,
                            target: com.bumptech.glide.request.target.Target<android.graphics.drawable.Drawable>,
                            isFirstResource: Boolean
                        ): Boolean {
                            Log.e(TAG, "❌ Glide failed to load image: $imageUrl", e)
                            return false
                        }
                    }).into(imageView)
                }
                crossFadeVideoActive -> {
                    request.into(object : CustomTarget<android.graphics.drawable.Drawable>() {
                        override fun onResourceReady(
                            resource: android.graphics.drawable.Drawable,
                            transition: Transition<in android.graphics.drawable.Drawable>?
                        ) {
                            if (isDestroyed || isFinishing) return
                            val outgoingView = playerView
                            val outgoingPlayer = player
                            imageView.setImageDrawable(resource)
                            imageView.alpha = 0f
                            imageView.visibility = View.VISIBLE
                            imageView.bringToFront()
                            statusText.bringToFront()
                            outgoingPlayer?.pause()

                            val animator = ValueAnimator.ofFloat(0f, 1f).apply {
                                duration = 500
                                addUpdateListener { animation ->
                                    val value = animation.animatedValue as Float
                                    imageView.alpha = value
                                    outgoingView.alpha = 1f - value
                                }
                                addListener(object : AnimatorListenerAdapter() {
                                    override fun onAnimationEnd(animation: android.animation.Animator) {
                                        outgoingPlayer?.stop()
                                        outgoingPlayer?.clearMediaItems()
                                        outgoingView.alpha = 0f
                                        outgoingView.visibility = View.GONE
                                    }
                                })
                            }
                            animator.start()
                        }

                        override fun onLoadCleared(placeholder: android.graphics.drawable.Drawable?) {
                            // Nothing
                        }
                    })
                }
                crossFadeFromCurrent -> {
                    val hasPreviousImage = imageView.drawable != null
                    val previousDrawable = if (hasPreviousImage) imageView.drawable else null
                    loadImageWithCrossfade(request, previousDrawable)
                }
                else -> {
                    val hasPreviousImage = imageView.drawable != null
                    val hasPreviousVideo = playerView.alpha > 0f && playerView.visibility == View.VISIBLE
                    
                    if (hasPreviousImage) {
                        Log.d(TAG, "🔄 Используем кроссфейд (обнаружено предыдущее изображение)")
                        loadImageWithCrossfade(request, imageView.drawable)
                    } else if (hasPreviousVideo) {
                        val outgoingView = playerView
                        val outgoingPlayer = player
                        outgoingPlayer?.pause()
                        request.listener(object : com.bumptech.glide.request.RequestListener<android.graphics.drawable.Drawable> {
                            override fun onResourceReady(
                                resource: android.graphics.drawable.Drawable,
                                model: Any,
                                target: com.bumptech.glide.request.target.Target<android.graphics.drawable.Drawable>,
                                dataSource: com.bumptech.glide.load.DataSource,
                                isFirstResource: Boolean
                            ): Boolean {
                                if (isDestroyed || isFinishing) return false
                                imageView.alpha = 0f
                                imageView.visibility = View.VISIBLE
                                imageView.setImageDrawable(resource)
                                imageView.bringToFront()
                                statusText.bringToFront()
                                val animator = ValueAnimator.ofFloat(0f, 1f).apply {
                                    duration = 500
                                    addUpdateListener { animation ->
                                        val value = animation.animatedValue as Float
                                        imageView.alpha = value
                                        outgoingView.alpha = 1f - value
                                    }
                                    addListener(object : AnimatorListenerAdapter() {
                                        override fun onAnimationEnd(animation: android.animation.Animator) {
                                            outgoingPlayer?.stop()
                                            outgoingPlayer?.clearMediaItems()
                                            outgoingView.alpha = 0f
                                            outgoingView.visibility = View.GONE
                                        }
                                    })
                                }
                                animator.start()
                                return true
                            }

                            override fun onLoadFailed(
                                e: com.bumptech.glide.load.engine.GlideException?,
                                model: Any?,
                                target: com.bumptech.glide.request.target.Target<android.graphics.drawable.Drawable>,
                                isFirstResource: Boolean
                            ): Boolean {
                                Log.e(TAG, "❌ Glide failed to load image: $imageUrl", e)
                                return false
                            }
                        }).into(imageView)
                    } else {
                        imageView.alpha = 0f
                        request.listener(object : com.bumptech.glide.request.RequestListener<android.graphics.drawable.Drawable> {
                            override fun onResourceReady(
                                resource: android.graphics.drawable.Drawable,
                                model: Any,
                                target: com.bumptech.glide.request.target.Target<android.graphics.drawable.Drawable>,
                                dataSource: com.bumptech.glide.load.DataSource,
                                isFirstResource: Boolean
                            ): Boolean {
                                if (!isDestroyed && !isFinishing) {
                                    fadeInView(imageView, 500)
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
                                return false
                            }
                        }).into(imageView)
                    }
                }
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error loading image with Glide", e)
            if (!isDestroyed && !isFinishing) {
                showStatus("Ошибка загрузки изображения")
            }
        }
    }
    
    /**
     * Создает полную независимую копию drawable с копией bitmap
     * Это необходимо для предотвращения использования recycled bitmap в TransitionDrawable
     */
    private fun createIndependentDrawableCopy(drawable: android.graphics.drawable.Drawable): android.graphics.drawable.Drawable? {
        return try {
            when (drawable) {
                is BitmapDrawable -> {
                    val bitmap = drawable.bitmap
                    if (bitmap.isRecycled) {
                        Log.w(TAG, "⚠️ Previous bitmap is already recycled")
                        return null
                    }
                    // Создаем полную копию bitmap
                    val bitmapCopy = bitmap.copy(bitmap.config, true)
                    if (bitmapCopy == null) {
                        Log.w(TAG, "⚠️ Failed to copy bitmap")
                        return null
                    }
                    // Создаем новый BitmapDrawable из копии
                    BitmapDrawable(resources, bitmapCopy)
                }
                else -> {
                    // Для других типов drawable пытаемся использовать constantState
                    val copied = drawable.constantState?.newDrawable()?.mutate()
                    if (copied != null) {
                        copied
                    } else {
                        Log.w(TAG, "⚠️ Cannot create copy for drawable type: ${drawable.javaClass.simpleName}")
                        null
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error creating drawable copy: ${e.message}", e)
            null
        }
    }
    
    /**
     * Вспомогательная функция для загрузки изображения с кроссфейдом
     */
    private fun loadImageWithCrossfade(
        request: com.bumptech.glide.RequestBuilder<android.graphics.drawable.Drawable>,
        previousDrawable: android.graphics.drawable.Drawable?
    ) {
        if (isDestroyed || isFinishing) {
            Log.d(TAG, "Activity destroyed, skipping crossfade")
            return
        }
        
                    request.into(object : CustomTarget<android.graphics.drawable.Drawable>() {
                        override fun onResourceReady(
                            resource: android.graphics.drawable.Drawable,
                            transition: Transition<in android.graphics.drawable.Drawable>?
                        ) {
                // КРИТИЧНО: Проверяем состояние Activity
                if (isDestroyed || isFinishing) {
                    Log.d(TAG, "Activity destroyed during image load, skipping")
                    return
                }
                
                            if (previousDrawable == null) {
                    // Нет предыдущего изображения - показываем сразу без fade-in (чтобы избежать черного экрана)
                    imageView.alpha = 1f
                    imageView.setImageDrawable(resource)
                    return
                }

                // Создаем кроссфейд между предыдущим и новым изображением
                // КРИТИЧНО: Создаем полную независимую копию bitmap, чтобы избежать recycled bitmap
                val previousCopy = try {
                    createIndependentDrawableCopy(previousDrawable)
                } catch (e: Exception) {
                    Log.w(TAG, "⚠️ Failed to copy previous drawable, using fade-in instead: ${e.message}")
                    // Если не удалось создать копию, используем простой fade-in
                                imageView.alpha = 0f
                                imageView.setImageDrawable(resource)
                    fadeInView(imageView, 500)
                                return
                            }

                if (previousCopy == null) {
                    // Не удалось создать копию - используем простой fade-in
                    imageView.alpha = 0f
                    imageView.setImageDrawable(resource)
                    fadeInView(imageView, 500)
                    return
                }
                
                // КРИТИЧНО: Убеждаемся, что imageView видим и имеет правильный alpha перед кроссфейдом
                // Это предотвращает черный экран при переходе
                imageView.visibility = View.VISIBLE
                imageView.alpha = 1f
                imageView.bringToFront()
                statusText.bringToFront()
                
                val transitionDrawable = TransitionDrawable(arrayOf(previousCopy, resource))
                            transitionDrawable.isCrossFadeEnabled = true
                            imageView.setImageDrawable(transitionDrawable)
                            transitionDrawable.startTransition(500)
                            
                // Заменяем TransitionDrawable на финальное изображение после завершения анимации
                            Handler(Looper.getMainLooper()).postDelayed({
                    if (!isDestroyed && !isFinishing && imageView.drawable == transitionDrawable) {
                                imageView.setImageDrawable(resource)
                    }
                            }, 500)
                        }

                        override fun onLoadCleared(placeholder: android.graphics.drawable.Drawable?) {
                // Glide очищает ресурс - это нормально
            }
        })
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
            
            // КРИТИЧНО: При первом показе (currentPage == 1) предзагружаем также второе изображение
            // Это предотвращает черный экран при переходе на второй кадр
            if (currentPage == 1 && totalPages > 1) {
                pagesToPreload.add(2)
            }
            
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
                    .skipMemoryCache(false)  // Используем memory cache для мгновенного показа
                    .preload()
                
                Log.d(TAG, "📥 Preloading $type page $page")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to preload adjacent slides: ${e.message}")
        }
    }

    private fun loadPlaceholder(skipLogoTransition: Boolean = false, forceReload: Boolean = false) {
        // КРИТИЧНО: Защита от параллельных вызовов
        if (isLoadingPlaceholder) {
            Log.d(TAG, "⚠️ loadPlaceholder() уже выполняется, пропускаем...")
            return
        }

        if (!forceReload) {
            val isPlaceholderVisible = isPlayingPlaceholder && (
                (playerView.visibility == View.VISIBLE && playerView.alpha > 0f) ||
                (imageView.visibility == View.VISIBLE && imageView.alpha > 0f)
            )
            
            if (isPlaceholderVisible) {
                Log.d(TAG, "ℹ️ Placeholder уже отображается, пропускаем повторный запуск")
                return
            }
            
            if (pendingPlayer != null && pendingVideoIsPlaceholder) {
                Log.d(TAG, "ℹ️ Placeholder уже готовится (${pendingVideoFileName ?: "unknown"}), ждём завершения")
                return
            }
        }
        
        isLoadingPlaceholder = true
        Log.i(TAG, "🔍 Loading placeholder...")
        
        cancelPendingBuffer("loadPlaceholder")

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
                        Log.i(TAG, "ℹ️ No placeholder set for this device, retrying in 10s...")
                        // КРИТИЧНО: Если заглушки нет - retry, а не показываем логотип
                        // Заглушка ДОЛЖНА быть, поэтому продолжаем попытки
                        if (!isDestroyed && !isFinishing) {
                            withContext(Dispatchers.Main) {
                                if (isDestroyed || isFinishing) return@withContext
                                isLoadingPlaceholder = false  // Сбрасываем флаг перед retry
                            }
                            scheduleRetryPlaceholder()
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
        // Используем функцию hideStatus() которая проверяет флаг showStatus
        hideStatus()
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
                ensureSocketConnected("ping watchdog")
            }
            
            // Планируем следующий ping
            val interval = config.pingInterval.toLong()
            pingHandler.postDelayed(this, interval)
        }
    }
    
    private val connectionWatchdogRunnable = object : Runnable {
        override fun run() {
            if (isDestroyed || isFinishing) {
                Log.d(TAG, "Activity destroyed, stopping connection watchdog")
                return
            }
            
            ensureSocketConnected("watchdog")
            scheduleConnectionWatchdog()
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

    private fun startConnectionWatchdog() {
        connectionWatchdogHandler.removeCallbacks(connectionWatchdogRunnable)
        scheduleConnectionWatchdog()
        Log.d(TAG, "🔍 Connection watchdog started")
    }
    
    private fun stopConnectionWatchdog() {
        connectionWatchdogHandler.removeCallbacks(connectionWatchdogRunnable)
        Log.d(TAG, "🔍 Connection watchdog stopped")
    }
    
    private fun scheduleConnectionWatchdog() {
        connectionWatchdogHandler.removeCallbacks(connectionWatchdogRunnable)
        val interval = max(5000L, config.reconnectDelay.toLong())
        connectionWatchdogHandler.postDelayed(connectionWatchdogRunnable, interval)
    }

    private fun increaseSocketBackoff() {
        socketBackoffMs = min(socketBackoffMs * 2, 60000L)
        Log.d(TAG, "Socket reconnect backoff increased to ${socketBackoffMs}ms")
    }
    
    private fun ensureSocketConnected(reason: String) {
        if (isDestroyed || isFinishing || isSocketReconnecting) return
        
        val now = SystemClock.elapsedRealtime()
        if (now - lastSocketReconnectAttempt < socketBackoffMs) {
            return
        }
        
        val currentSocket = socket
        if (currentSocket != null && currentSocket.connected()) {
            socketBackoffMs = 2000L
            return
        }
        
        isSocketReconnecting = true
        lastSocketReconnectAttempt = now
        
        if (currentSocket != null) {
            Log.w(TAG, "Socket disconnected, forcing reconnect ($reason)")
            try {
                currentSocket.off()
                currentSocket.disconnect()
            } catch (e: Exception) {
                Log.w(TAG, "Failed to clean socket before reconnect: ${e.message}")
            }
            socket = null
        } else {
            Log.w(TAG, "Socket instance is null, reconnecting ($reason)")
        }
        
        connectionWatchdogHandler.postDelayed({
            connectSocket()
        }, 200) // небольшая задержка, чтобы disconnect завершился
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
                    // КРИТИЧНО: Отправляем прогресс даже если видео на паузе (для отображения текущей позиции)
                    // Проверяем не только isPlaying, но и состояние буферизации
                    val isPlayingOrBuffering = exoPlayer.isPlaying || 
                        exoPlayer.playbackState == Player.STATE_BUFFERING ||
                        exoPlayer.playbackState == Player.STATE_READY
                    
                    // КРИТИЧНО: Отправляем прогресс если видео загружено (STATE_READY) даже на паузе
                    // Это нужно для отображения текущей позиции на панели спикера
                    val isVideoReady = exoPlayer.playbackState == Player.STATE_READY
                    
                    if (!isPlayingPlaceholder && (isPlayingOrBuffering || isVideoReady)) {
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
    // Логотип больше не используется - смена контента идет через кроссфейд
    // Функции удалены

    override fun onDestroy() {
        super.onDestroy()
        Log.i(TAG, "=== MainActivity onDestroy ===")
        
        // Очищаем все Handler
        stopPingTimer()
        stopConnectionWatchdog()
        stopProgressUpdates()
        // stopLogoRefreshTimer() удален - логотип больше не используется
        statusHandler.removeCallbacks(hideStatusRunnable)
        retryHandler.removeCallbacksAndMessages(null)
        progressHandler.removeCallbacksAndMessages(null)
        // logoRefreshHandler удален - логотип больше не используется
        
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
            bufferPlayer?.release()
            bufferPlayer = null
        } catch (e: Exception) {
            Log.e(TAG, "Error releasing buffer player: ${e.message}", e)
        }

        pendingPlayer = null
        pendingPlayerView = null
        
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
        
        // КРИТИЧНО: Очищаем память в фоне при нехватке (для стабильности 24/7)
        // Все происходит незаметно для зрителей - воспроизведение не прерывается
        if (level >= android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            Log.w(TAG, "Low memory detected (level $level), clearing caches in background")
            
            val isPlaceholderPlaying = isPlayingPlaceholder
            val isPlayerPlaying = player?.isPlaying == true
            
            // Очистка в фоне, чтобы не блокировать воспроизведение
            lifecycleScope.launch(Dispatchers.IO) {
                try {
                    // Очищаем Glide memory cache
                    withContext(Dispatchers.Main) {
                        try {
                            Glide.get(this@MainActivity).clearMemory()
                            Log.d(TAG, "✅ Glide memory cache cleared in background")
                        } catch (e: Exception) {
                            Log.e(TAG, "Failed to clear Glide memory: ${e.message}", e)
                        }
                    }
                    
                    // При критической нехватке памяти - более агрессивная очистка
                    if (level >= android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL) {
                        Log.w(TAG, "Critical memory level - aggressive cleanup in background")
                        
                        // Очищаем disk cache Glide
                        try {
                            Glide.get(this@MainActivity).clearDiskCache()
                            Log.d(TAG, "✅ Glide disk cache cleared in background")
                        } catch (e: Exception) {
                            Log.e(TAG, "Failed to clear Glide disk cache: ${e.message}", e)
                        }
                        
                        // КРИТИЧНО: Очищаем ExoPlayer кэш только если НЕ играет контент
                        // Если играет заглушка - НЕ трогаем, она должна продолжать играть
                        if (!isPlayerPlaying && !isPlaceholderPlaying) {
                            withContext(Dispatchers.Main) {
                                try {
                                    releaseSimpleCache()
                                    // Переинициализируем через задержку
                                    Handler(Looper.getMainLooper()).postDelayed({
                                        try {
                                            if (!isDestroyed && !isFinishing) {
                                                initializeSimpleCache()
                                            }
                                        } catch (e: Exception) {
                                            Log.e(TAG, "Error reinitializing cache: ${e.message}", e)
                                        }
                                    }, 1000)
                                    Log.d(TAG, "✅ ExoPlayer cache cleared in background (no playback active)")
                                } catch (e: Exception) {
                                    Log.e(TAG, "Error clearing ExoPlayer cache: ${e.message}", e)
                                }
                            }
                        } else {
                            Log.d(TAG, "⚠️ Skipping ExoPlayer cache cleanup - playback active (placeholder: $isPlaceholderPlaying)")
                        }
                    }
                    
                    // Принудительный сбор мусора в фоне
                    System.gc()
                    
                } catch (e: Exception) {
                    Log.e(TAG, "Error in background memory cleanup: ${e.message}", e)
                }
            }
        }
    }
    
    /**
     * Обработка OutOfMemoryError - очистка кэшей в фоне без прерывания воспроизведения
     * Все происходит незаметно для зрителей - только контент на экране
     */
    private fun handleOutOfMemory() {
        Log.e(TAG, "⚠️ Handling OutOfMemoryError - clearing caches in background")
        
        // КРИТИЧНО: Если играет заглушка - НЕ останавливаем её, очищаем память в фоне
        val wasPlayingPlaceholder = isPlayingPlaceholder
        val wasPlayerPlaying = player?.isPlaying == true
        
        // Очистка памяти в фоне (не блокируем UI и воспроизведение)
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                // 1. Очищаем кэши Glide в фоне
                try {
                    withContext(Dispatchers.Main) {
                        Glide.get(this@MainActivity).clearMemory()
                    }
                    Glide.get(this@MainActivity).clearDiskCache()
                    Log.d(TAG, "✅ Glide caches cleared in background")
                } catch (e: Exception) {
                    Log.e(TAG, "Error clearing Glide cache: ${e.message}", e)
                }
                
                // 2. Очищаем ImageView только если не играет контент
                if (!wasPlayerPlaying) {
                    withContext(Dispatchers.Main) {
                        try {
                            imageView.setImageDrawable(null)
                            Glide.with(this@MainActivity).clear(imageView)
                        } catch (e: Exception) {
                            Log.e(TAG, "Error clearing ImageView: ${e.message}", e)
                        }
                    }
                }
                
                // 3. Очищаем ExoPlayer кэш только если не играет контент
                // (если играет заглушка - не трогаем, она должна продолжать играть)
                if (!wasPlayerPlaying && !wasPlayingPlaceholder) {
                    withContext(Dispatchers.Main) {
                        try {
                            releaseSimpleCache()
                            // Переинициализируем кэш через небольшую задержку
                            Handler(Looper.getMainLooper()).postDelayed({
                                try {
                                    if (!isDestroyed && !isFinishing) {
                                        initializeSimpleCache()
                                    }
                                } catch (e: Exception) {
                                    Log.e(TAG, "Error reinitializing cache: ${e.message}", e)
                                }
                            }, 1000)
                        } catch (e: Exception) {
                            Log.e(TAG, "Error releasing cache: ${e.message}", e)
                        }
                    }
                }
                
                // 4. Принудительный сбор мусора в фоне
                System.gc()
                
                Log.i(TAG, "✅ Memory cleanup completed in background (placeholder was playing: $wasPlayingPlaceholder)")
                
                // 5. Если играла заглушка и она остановилась - восстанавливаем незаметно
                if (wasPlayingPlaceholder) {
                    withContext(Dispatchers.Main) {
                        Handler(Looper.getMainLooper()).postDelayed({
                            try {
                                if (isDestroyed || isFinishing) return@postDelayed
                                // Проверяем, играет ли еще заглушка
                                if (!isPlayingPlaceholder || player?.isPlaying != true) {
                                    // Восстанавливаем незаметно, без сообщений
                                    loadPlaceholder()
                                    Log.d(TAG, "✅ Placeholder restored silently after OOM cleanup")
                                }
                            } catch (e: Exception) {
                                Log.e(TAG, "Error restoring placeholder: ${e.message}", e)
                            }
                        }, 500)
                    }
                }
                
            } catch (e: Exception) {
                Log.e(TAG, "Critical error in background OOM cleanup: ${e.message}", e)
            }
        }
    }
}


