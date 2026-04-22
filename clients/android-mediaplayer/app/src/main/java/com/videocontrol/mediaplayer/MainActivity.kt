
package com.videocontrol.mediaplayer

import android.content.Intent
import android.content.Context
import android.content.BroadcastReceiver
import android.content.IntentFilter
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.media.AudioManager
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.exoplayer2.ExoPlayer
import com.google.android.exoplayer2.MediaItem
import com.google.android.exoplayer2.Player
import com.google.android.exoplayer2.ui.StyledPlayerView
import com.google.android.exoplayer2.source.ProgressiveMediaSource
import com.google.android.exoplayer2.source.dash.DashMediaSource
import com.google.android.exoplayer2.source.hls.HlsMediaSource
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
import com.videocontrol.mediaplayer.BuildConfig
import com.bumptech.glide.load.engine.DiskCacheStrategy
import android.graphics.drawable.TransitionDrawable
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.PictureDrawable
import android.graphics.Bitmap
import com.bumptech.glide.load.resource.drawable.DrawableTransitionOptions
import com.bumptech.glide.request.target.CustomTarget
import com.bumptech.glide.request.transition.DrawableCrossFadeFactory
import com.bumptech.glide.request.transition.Transition
import java.net.URISyntaxException
import java.net.HttpURLConnection
import java.net.URL
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
import kotlin.math.roundToInt
import android.os.Build
import android.view.KeyEvent
import android.graphics.Color
import androidx.core.content.ContextCompat
import com.caverock.androidsvg.SVG

// Sealed class для типов контента
sealed class ContentType {
    object Video : ContentType()
    object Audio : ContentType()
    object Image : ContentType()
    object Pdf : ContentType()
    object Pptx : ContentType()
    object Folder : ContentType()
    object Streaming : ContentType()
    object Placeholder : ContentType()
    
    fun asString(): String = when (this) {
        is Video -> "video"
        is Audio -> "audio"
        is Image -> "image"
        is Pdf -> "pdf"
        is Pptx -> "pptx"
        is Folder -> "folder"
        is Streaming -> "streaming"
        is Placeholder -> "placeholder"
    }
}

// Расширенный FileState
data class FileState(
    val type: String?,
    val file: String?,
    var page: Int = 1,
    val originDeviceId: String? = null,
    val streamProtocol: String? = null,
    val isPlaceholder: Boolean = false,
    var savedPosition: Long = 0
)

// State Machine для состояний плеера
sealed class PlayerState {
    object Idle : PlayerState()
    data class Loading(val fileName: String, val contentType: ContentType) : PlayerState()
    data class Playing(val fileName: String, val contentType: ContentType) : PlayerState()
    data class Error(val message: String, val retryCount: Int) : PlayerState()
    object Paused : PlayerState()
}

// Флаги воспроизведения
data class PlaybackFlags(
    var skipPlaceholderOnVideoEnd: Boolean = false,
    var isPlayingPlaceholder: Boolean = false,
    var isLoadingPlaceholder: Boolean = false,
    var isSwitchingFromPlaceholder: Boolean = false
) {
    fun reset() {
        skipPlaceholderOnVideoEnd = false
        isPlayingPlaceholder = false
        isLoadingPlaceholder = false
        isSwitchingFromPlaceholder = false
    }
}

class MainActivity : AppCompatActivity() {

    private lateinit var playerView: StyledPlayerView
    private lateinit var playerViewPrimary: StyledPlayerView
    private lateinit var playerViewSecondary: StyledPlayerView
    private lateinit var bufferPlayerView: StyledPlayerView
    private lateinit var imageView: ImageView
    private lateinit var statusText: TextView
    private lateinit var brandBg: ImageView
    private lateinit var versionOverlay: TextView
    private lateinit var loadingIndicator: ProgressBar

    private var player: ExoPlayer? = null
    private var bufferPlayer: ExoPlayer? = null
    private var pendingPlayer: ExoPlayer? = null
    private var pendingPlayerView: StyledPlayerView? = null
    private var socket: Socket? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var simpleCache: SimpleCache? = null
    // Объединенный Handler для всех задач
    private val mainHandler = Handler(Looper.getMainLooper())
    private var retryRunnable: Runnable? = null
    private var placeholderJob: Job? = null
    private var progressRunnable: Runnable? = null
    private var audioLogoJob: Job? = null
    private var lastAudioLogoFetchMs: Long = 0
    private var audioLogoUrl: String? = null
    private val audioLogoRefreshIntervalMs = 6 * 60 * 60 * 1000L
    
    // Используем PlaybackFlags вместо отдельных boolean
    private val playbackFlags = PlaybackFlags()
    
    // State Machine для состояний
    private var currentPlayerState: PlayerState = PlayerState.Idle
    private var mediaCodecInitRunnable: Runnable? = null // Для отмены pending инициализации MediaCodec
    
    // Новые компоненты
    private var config: RemoteConfig.Config = RemoteConfig.Config()
    private var showStatus: Boolean = false
    
    // Для retry при ошибках
    private var errorRetryCount = 0
    private val maxRetryAttempts = 3
    
    // Флаг первого запуска (чтобы не загружать заглушку дважды)
    private var isFirstLaunch = true
    
    private var currentFileState: FileState? = null
    
    // Кэш информации о заглушке (чтобы не запрашивать сервер каждый раз)
    private var cachedPlaceholderFile: String? = null
    private var cachedPlaceholderType: String? = null
    private var placeholderTimestamp: Long = 0 // Для обхода кэша при смене заглушки
    private var lastSocketReconnectAttempt = 0L
    private var isSocketReconnecting = false
    private var socketBackoffMs = 2000L
    private lateinit var audioManager: AudioManager
    private var currentVolumePercent: Int = 100
    private var currentMuteState: Boolean = false
    private var volumeChangeReceiver: BroadcastReceiver? = null
    private var suppressVolumeBroadcast = false
    private val volumeStep = 5
    private var awaitingVolumeSync = false
    private var pendingVolumeCommand: JSONObject? = null // Отложенная команда громкости
    private var pendingSyncedPlayRunnable: Runnable? = null

    private val TAG = "MMRCPlayer"
    private val userAgent by lazy { "MMRC/${BuildConfig.VERSION_NAME}" }
    private var SERVER_URL = ""
    private var DEVICE_ID = ""
    private var contentDeviceId: String = ""

    private val audioExtensions = setOf("mp3", "aac", "wav", "flac", "ogg", "m4a", "opus", "weba")
    private val videoExtensions = setOf("mp4", "webm", "ogg", "mkv", "mov", "avi", "m4v", "ts")
    private val imageExtensions = setOf("png", "jpg", "jpeg", "gif", "webp")
    private val documentExtensions = setOf("pdf", "pptx")
    private val folderExtensions = setOf("zip")
    private val mediaContentTypes = setOf("video", "audio", "streaming")

    // Проверка активности (упрощенная)
    private fun isActivityValid(): Boolean = !isDestroyed && !isFinishing
    
    // Получение deviceId для контента (универсальная функция)
    private fun getDeviceIdForContent(): String = 
        if (contentDeviceId.isNotEmpty()) contentDeviceId else DEVICE_ID

    private fun getFileExtension(fileName: String?): String {
        if (fileName.isNullOrBlank()) return ""
        val index = fileName.lastIndexOf('.')
        return if (index >= 0 && index < fileName.length - 1) {
            fileName.substring(index + 1).lowercase()
        } else {
            ""
        }
    }

    private fun resolveContentType(
        contentType: String?,
        fileName: String?,
        originalName: String?,
        fallbackToFolder: Boolean = false
    ): String {
        val normalizedContentType = contentType?.trim()?.lowercase()
        val resolvedContentType = normalizedContentType
            ?.takeIf { it.isNotEmpty() && it != "file" && it != "unknown" }

        val extFromFile = getFileExtension(fileName)
        val extFromOriginal = getFileExtension(originalName)
        val ext = if (extFromFile.isNotEmpty()) extFromFile else extFromOriginal

        if (resolvedContentType != null) {
            if (resolvedContentType == "video" && ext.isNotEmpty()) {
                return when {
                    audioExtensions.contains(ext) -> "audio"
                    imageExtensions.contains(ext) -> "image"
                    documentExtensions.contains(ext) -> ext
                    folderExtensions.contains(ext) -> "folder"
                    !videoExtensions.contains(ext) -> if (fallbackToFolder) "folder" else "video"
                    else -> "video"
                }
            }
            return resolvedContentType
        }

        if (ext.isEmpty()) return if (fallbackToFolder) "folder" else "unknown"

        return when {
            audioExtensions.contains(ext) -> "audio"
            videoExtensions.contains(ext) -> "video"
            imageExtensions.contains(ext) -> "image"
            documentExtensions.contains(ext) -> ext
            folderExtensions.contains(ext) -> "folder"
            else -> if (fallbackToFolder) "folder" else "unknown"
        }
    }

    private fun isMediaContentType(type: String?): Boolean {
        return type != null && mediaContentTypes.contains(type)
    }

    private fun clearImageView() {
        Glide.with(this).clear(imageView)
        imageView.setImageDrawable(null)
        imageView.visibility = View.GONE
        imageView.alpha = 0f
    }

    private fun resolveAudioLogoUrl(): String? {
        val baseUrl = SERVER_URL.trim()
        if (baseUrl.isEmpty()) return null
        return "${baseUrl.trimEnd('/')}/audio-logo.svg"
    }

    private fun refreshAudioLogo(force: Boolean = false) {
        val logoBaseUrl = resolveAudioLogoUrl() ?: return
        val now = SystemClock.elapsedRealtime()
        if (!force &&
            logoBaseUrl == audioLogoUrl &&
            brandBg.drawable != null &&
            now - lastAudioLogoFetchMs < audioLogoRefreshIntervalMs
        ) {
            return
        }

        audioLogoJob?.cancel()
        val requestUrl = if (force) "${logoBaseUrl}?t=${System.currentTimeMillis()}" else logoBaseUrl

        audioLogoJob = lifecycleScope.launch(Dispatchers.IO) {
            try {
                val connection = (URL(requestUrl).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 5000
                    readTimeout = 5000
                    requestMethod = "GET"
                }

                if (connection.responseCode != 200) {
                    Log.w(TAG, "Audio logo request failed: HTTP ${connection.responseCode}")
                    connection.disconnect()
                    return@launch
                }

                connection.inputStream.use { input ->
                    val svg = SVG.getFromInputStream(input)
                    val drawable = PictureDrawable(svg.renderToPicture())
                    withContext(Dispatchers.Main) {
                        if (!isActivityValid()) return@withContext
                        brandBg.setLayerType(View.LAYER_TYPE_SOFTWARE, null)
                        brandBg.setImageDrawable(drawable)
                        audioLogoUrl = logoBaseUrl
                        lastAudioLogoFetchMs = now
                    }
                }

                connection.disconnect()
            } catch (e: Exception) {
                Log.w(TAG, "Failed to load audio logo", e)
            }
        }
    }

    private fun showAudioLogo() {
        refreshAudioLogo()
        brandBg.visibility = View.VISIBLE
        brandBg.alpha = 1f
    }

    private fun hideAudioLogo() {
        brandBg.visibility = View.GONE
        brandBg.alpha = 0f
    }

    private fun resetStaticContentState() {
        currentPdfFile = null
        currentPptxFile = null
        currentFolderName = null
    }

    private fun resetPendingVideoState() {
        pendingVideoFileName = null
        pendingVideoIsPlaceholder = false
        isVideoReadyToShow = false
        hasVideoSize = false
    }

    // Extension функции для упрощения кода
    private fun View.fadeIn(duration: Long = 500, onComplete: (() -> Unit)? = null) {
        fadeInView(this, duration, onComplete)
    }

    private fun View.fadeOut(duration: Long = 500, onComplete: (() -> Unit)? = null) {
        fadeOutView(this, duration, onComplete)
    }

    private fun ExoPlayer?.safePause() {
        this?.pause()
    }

    private fun ExoPlayer?.safePlay() {
        this?.play()
    }

    // Проверка и инициализация плеера
    private fun ensurePlayerInitialized(): Boolean {
        if (player == null || playerView == null) {
            if (player == null) {
                Log.w(TAG, "Player is null, attempting to reinitialize")
                try {
                    initializePlayer()
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to reinitialize player", e)
                    return false
                }
            }
            return player != null && playerView != null
        }
        return true
    }

    // Универсальная подготовка контента
    private fun prepareContentPlayback(contentType: ContentType, resetCallbacks: () -> Unit) {
        clearImageView()
        resetStaticContentState()
        resetPendingVideoState()
        stopProgressUpdates()
        resetCallbacks()
    }

    // Универсальная обработка ошибок
    private fun handleContentError(
        error: Exception,
        contentType: ContentType,
        fileName: String,
        isPlaceholder: Boolean = false
    ) {
        Log.e(TAG, "Error loading ${contentType.asString()}: $fileName", error)
        if (!isPlaceholder && errorRetryCount < maxRetryAttempts) {
            errorRetryCount++
            Log.w(TAG, "Retrying (attempt $errorRetryCount/$maxRetryAttempts)")
        } else if (!isPlaceholder) {
            Log.e(TAG, "Max retry attempts reached, loading placeholder")
            currentPlayerState = PlayerState.Error(error.message ?: "Unknown error", errorRetryCount)
            mainHandler.postDelayed({
                if (!isDestroyed && !isFinishing) {
                    loadPlaceholder()
                }
            }, 1000)
        }
    }

    // Остановка всех плееров (универсальная функция)
    private fun stopAllPlayers(reason: String) {
        cancelPendingBuffer(reason)
        stopProgressUpdates()
        
        // Отвязываем плееры от Surface перед остановкой
        playerView.player = null
        bufferPlayerView.player = null
        
        // Останавливаем активный плеер
        player?.pause()
        player?.stop()
        player?.clearMediaItems()
        
        // Останавливаем буферный плеер
        bufferPlayer?.pause()
        bufferPlayer?.stop()
        bufferPlayer?.clearMediaItems()
        
        // Скрываем View
        playerView.visibility = View.GONE
        playerView.alpha = 0f
        bufferPlayerView.visibility = View.GONE
        bufferPlayerView.alpha = 0f
    }

    private fun cancelPendingBuffer(reason: String) {
        val pending = pendingPlayer ?: return
        val pendingView = pendingPlayerView
        mediaCodecInitRunnable?.let {
            mainHandler.removeCallbacks(it)
            mediaCodecInitRunnable = null
        }
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
        resetPendingVideoState()
    }

    private fun initializeVolumeState() {
        try {
            audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val stream = AudioManager.STREAM_MUSIC
            val maxVolume = audioManager.getStreamMaxVolume(stream).coerceAtLeast(1)
            val currentVolume = audioManager.getStreamVolume(stream)
            currentVolumePercent = normalizeVolumePercent(((currentVolume.toFloat() / maxVolume) * 100f).roundToInt())
            currentMuteState = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                audioManager.isStreamMute(stream)
            } else {
                currentVolume == 0
            }
            registerVolumeReceiver()
            pendingVolumeCommand?.let { pending ->
                handleVolumeCommand(pending)
                pendingVolumeCommand = null
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to initialize audio manager", e)
        }
    }

    private fun normalizeVolumePercent(value: Int): Int {
        val clamped = value.coerceIn(0, 100)
        return ((clamped.toFloat() / volumeStep).roundToInt() * volumeStep).coerceIn(0, 100)
    }

    private fun handleVolumeCommand(data: JSONObject) {
        val targetLevel = if (data.has("level") && !data.isNull("level")) data.optInt("level") else null
        val delta = if (data.has("delta") && !data.isNull("delta")) data.optInt("delta") else null
        val muted = if (data.has("muted") && !data.isNull("muted")) data.optBoolean("muted") else null
        val reason = data.optString("reason", "server")
        
        if (!::audioManager.isInitialized) {
            pendingVolumeCommand = data
            if (reason != "sync") {
                awaitingVolumeSync = false
            }
            return
        }
        
        applyVolumeChange(targetLevel, delta, muted, reason)
        
        if (awaitingVolumeSync && reason == "sync") {
            awaitingVolumeSync = false
            emitVolumeState("sync_override")
        } else {
            awaitingVolumeSync = false
        }
    }

    private fun applyVolumeChange(level: Int?, delta: Int?, muted: Boolean?, reason: String = "server") {
        if (!::audioManager.isInitialized) {
            Log.w(TAG, "applyVolumeChange called but audioManager not initialized, saving command")
            pendingVolumeCommand = JSONObject().apply {
                if (level != null) put("level", level)
                if (delta != null) put("delta", delta)
                if (muted != null) put("muted", muted)
                put("reason", reason)
            }
            return
        }
        val targetLevel = when {
            level != null -> normalizeVolumePercent(level)
            delta != null -> normalizeVolumePercent(currentVolumePercent + delta)
            else -> currentVolumePercent
        }
        val targetMuted = muted ?: currentMuteState
        val stream = AudioManager.STREAM_MUSIC
        val maxVolume = audioManager.getStreamMaxVolume(stream).coerceAtLeast(1)
        val targetStreamValue = ((targetLevel / 100f) * maxVolume).roundToInt().coerceIn(0, maxVolume)

        if (targetLevel != currentVolumePercent) {
            try {
                suppressVolumeBroadcast = true
                audioManager.setStreamVolume(stream, targetStreamValue, 0)
                currentVolumePercent = targetLevel
            } catch (e: Exception) {
                Log.e(TAG, "Failed to set volume level", e)
            } finally {
                mainHandler.postDelayed({ suppressVolumeBroadcast = false }, 200)
            }
        }

        if (targetMuted != currentMuteState) {
            try {
                suppressVolumeBroadcast = true
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    audioManager.adjustStreamVolume(
                        stream,
                        if (targetMuted) AudioManager.ADJUST_MUTE else AudioManager.ADJUST_UNMUTE,
                        0
                    )
                } else {
                    @Suppress("DEPRECATION")
                    audioManager.setStreamMute(stream, targetMuted)
                }
                currentMuteState = targetMuted
            } catch (e: Exception) {
                Log.e(TAG, "Failed to update mute state", e)
            } finally {
                mainHandler.postDelayed({ suppressVolumeBroadcast = false }, 200)
            }
        }

        emitVolumeState(reason)
    }

    private fun emitVolumeState(trigger: String? = null) {
        if (socket?.connected() != true) return
        try {
            val payload = JSONObject().apply {
                put("device_id", DEVICE_ID)
                put("level", if (currentMuteState) 0 else currentVolumePercent)
                put("muted", currentMuteState)
                trigger?.let { put("reason", it) }
            }
            socket?.emit("player/volumeState", payload)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to emit volume state", e)
        }
    }

    private fun emitIdleProgress(reason: String = "placeholder") {
        if (socket?.connected() != true) return
        try {
            val payload = JSONObject().apply {
                put("device_id", DEVICE_ID)
                put("type", "idle")
                put("file", JSONObject.NULL)
                put("currentTime", 0)
                put("duration", 0)
                put("reason", reason)
            }
            socket?.emit("player/progress", payload)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to emit idle progress", e)
        }
    }
    
    private fun emitStaticContentProgress(contentType: String, file: String, page: Int) {
        if (socket?.connected() != true) {
            Log.w(TAG, "Socket not connected, skipping static content progress update")
            return
        }
        try {
            val progressData = JSONObject().apply {
                put("device_id", DEVICE_ID)
                put("type", contentType)
                put("file", file)
                put("page", page)
                put("currentTime", 0)
                put("duration", 0)
            }
            
            socket?.emit("player/progress", progressData)
        } catch (e: Exception) {
            Log.w(TAG, "Error sending static content progress: ${e.message}")
        }
    }

    private fun registerVolumeReceiver() {
        if (!::audioManager.isInitialized || volumeChangeReceiver != null) return
        val filter = IntentFilter("android.media.VOLUME_CHANGED_ACTION")
        volumeChangeReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action != "android.media.VOLUME_CHANGED_ACTION" || suppressVolumeBroadcast) return
                val streamType = intent.getIntExtra("android.media.EXTRA_VOLUME_STREAM_TYPE", -1)
                if (streamType != AudioManager.STREAM_MUSIC) return
                val newVolume = intent.getIntExtra("android.media.EXTRA_VOLUME_STREAM_VALUE", -1)
                if (newVolume < 0) return
                val stream = AudioManager.STREAM_MUSIC
                val maxVolume = audioManager.getStreamMaxVolume(stream).coerceAtLeast(1)
                currentVolumePercent = normalizeVolumePercent(((newVolume.toFloat() / maxVolume) * 100f).roundToInt())
                currentMuteState = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    audioManager.isStreamMute(stream)
                } else {
                    currentVolumePercent == 0
                }
                emitVolumeState("hardware")
            }
        }
        try {
            registerReceiver(volumeChangeReceiver, filter)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to register volume receiver", e)
            volumeChangeReceiver = null
        }
    }

    private fun unregisterVolumeReceiver() {
        if (volumeChangeReceiver == null) return
        try {
            unregisterReceiver(volumeChangeReceiver)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to unregister volume receiver", e)
        } finally {
            volumeChangeReceiver = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!SettingsActivity.isConfigured(this)) {
            startActivity(Intent(this, SettingsActivity::class.java))
            finish()
            return
        }

        SERVER_URL = SettingsActivity.getServerUrl(this) ?: ""
        DEVICE_ID = SettingsActivity.getDeviceId(this) ?: ""
        showStatus = SettingsActivity.getShowStatus(this)
        contentDeviceId = DEVICE_ID
        
        // Используем дефолтные настройки (без RemoteConfig для стабильности)
        config = RemoteConfig.Config()
        
        setContentView(R.layout.activity_main)
        initializeVolumeState()

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
        versionOverlay = findViewById(R.id.versionOverlay)
        loadingIndicator = findViewById(R.id.loadingIndicator)
        bufferPlayerView.alpha = 0f
        bufferPlayerView.visibility = View.GONE
        loadingIndicator.visibility = View.GONE
        loadingIndicator.alpha = 0f

        updateVersionOverlay()
        loadingIndicator.bringToFront()
        versionOverlay.bringToFront()

        refreshAudioLogo(force = true)

        // Длинное нажатие на экран - открывает настройки (для сенсорных экранов)
        val openSettingsListener = View.OnLongClickListener {
            openSettings()
            true
        }
        playerViewPrimary.setOnLongClickListener(openSettingsListener)
        playerViewSecondary.setOnLongClickListener(openSettingsListener)
        playerViewPrimary.requestFocus()

        playerViewPrimary.useController = false
        playerViewSecondary.useController = false

        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "MMRCPlayer::WakeLock"
        )
        wakeLock?.acquire()

        initializePlayer()
        connectSocket()
        startConnectionWatchdog()
        loadPlaceholder()
    }

    private fun updateVersionOverlay() {
        if (!::versionOverlay.isInitialized) return
        val deviceLabel = if (DEVICE_ID.isNotBlank()) DEVICE_ID else "unknown"
        versionOverlay.text = "ID: $deviceLabel | v${BuildConfig.VERSION_NAME}"
    }

    private fun initializePlayer() {
        try {
            if (!::playerViewPrimary.isInitialized) {
                Log.e(TAG, "playerViewPrimary not initialized, cannot create player")
                return
            }
            
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
            
            if (player == null) {
                Log.e(TAG, "Failed to create player instance")
            } else {
                Log.d(TAG, "Player initialized successfully")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error initializing player", e)
            player = null
            bufferPlayer = null
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
                            Player.STATE_IDLE -> {}
                                Player.STATE_BUFFERING -> {
                                if (isActivePlayer) {
                                    showStatus("Буферизация...", autohideSeconds = 0)
                                }
                                }

                                Player.STATE_READY -> {
                                if (isActivePlayer) {
                                    errorRetryCount = 0
                                    hideStatus()
                                }
                                }

                                Player.STATE_ENDED -> {
                                if (isActivePlayer) {
                                    if (playbackFlags.skipPlaceholderOnVideoEnd) {
                                        playbackFlags.skipPlaceholderOnVideoEnd = false
                                    } else if (!playbackFlags.isPlayingPlaceholder) {
                                        if (playerView.alpha > 0f && playerView.visibility == View.VISIBLE) {
                                            player?.pause()
                                            fadeOutView(playerView, 500) {
                                                // 1. Сначала отвязываем плеер от Surface, чтобы MediaCodec освободил ресурсы
                                                playerView.player = null
                                                // 2. Затем останавливаем плеер и очищаем медиа
                                                player?.stop()
                                                player?.clearMediaItems()
                                                // 3. Скрываем View
                                                playerView.alpha = 0f
                                                playerView.visibility = View.GONE
                                                // 4. Небольшая задержка для полного освобождения ресурсов MediaCodec
                                                mainHandler.postDelayed({
                                                    if (!isDestroyed && !isFinishing) {
                                                        loadPlaceholder()
                                                    }
                                                }, 100)
                                            }
                                        } else {
                                            loadPlaceholder()
                                        }
                                    } else {
                                    }
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
                            resetPendingVideoState()
                            showStatus("Ошибка подготовки видео, ожидаем новое задание", autohideSeconds = 3)
                            return
                        }

                            val maxAttempts = if (!playbackFlags.isPlayingPlaceholder) 10 else maxRetryAttempts
                            
                            showStatus("Ошибка воспроизведения, попытка $errorRetryCount/$maxAttempts...")
                            
                            retryRunnable?.let { mainHandler.removeCallbacks(it) }
                            retryRunnable = Runnable {
                                if (isDestroyed || isFinishing) {
                                    return@Runnable
                                }
                                
                                if (errorRetryCount < maxAttempts) {
                                    errorRetryCount++
                                    
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
                                    if (!playbackFlags.isPlayingPlaceholder) {
                                        Log.e(TAG, "Max retry attempts for content, loading placeholder")
                                        loadPlaceholder()
                                    }
                                    errorRetryCount = 0
                                    loadPlaceholder()
                                }
                            }
                        mainHandler.postDelayed(retryRunnable!!, 5000)
                        }

                        override fun onIsPlayingChanged(isPlaying: Boolean) {
                        if (exoPlayer !== player) {
                            return
                        }
                            
                        val activeState = currentFileState
                        val hasMedia = activeState?.file != null && isMediaContentType(activeState.type)
                        if (!playbackFlags.isPlayingPlaceholder && hasMedia) {
                            val isMediaReady = player?.playbackState == Player.STATE_READY
                            if (isMediaReady || isPlaying) {
                                startProgressUpdates()
                            } else {
                                stopProgressUpdates()
                            }
                        } else {
                            stopProgressUpdates()
                        }
                        }
                        
                        override fun onVideoSizeChanged(videoSize: com.google.android.exoplayer2.video.VideoSize) {
                        if (exoPlayer !== player) {
                            return
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
                runOnUiThread {
                    showStatus("Подключено", autohideSeconds = 2)  // Скрываем через 2 сек
                    registerDevice()
                    startPingTimer()
                    refreshAudioLogo(force = true)
                    
                    
                    // Если играет контент - продолжаем воспроизведение
                    if (!playbackFlags.isPlayingPlaceholder && player?.isPlaying == true) {
                        if (currentVideoFile != null) {
                            startProgressUpdates()
                        }
                    } else if (!playbackFlags.isPlayingPlaceholder && player?.isPlaying == false) {
                        if (currentVideoFile != null) {
                            startProgressUpdates()
                        }
                    } else {
                        if (player?.isPlaying != true) {
                            loadPlaceholder()
                        }
                    }
                }
            }

            socket?.on(Socket.EVENT_DISCONNECT) { args ->
                val reason = if (args.isNotEmpty()) args[0].toString() else "unknown"
                Log.w(TAG, "Socket disconnected: $reason")
                runOnUiThread {
                    showStatus("Нет связи с сервером...", autohideSeconds = 0)  // Не скрываем до переподключения
                    stopPingTimer()
                    isSocketReconnecting = false
                    increaseSocketBackoff()
                    scheduleConnectionWatchdog()
                    ensureSocketConnected("EVENT_DISCONNECT")
                    
                    // ExoPlayer продолжит воспроизведение из кэша и автоматически подгрузит при reconnect
                    // Заглушка продолжает крутиться в loop mode
                    if (!playbackFlags.isPlayingPlaceholder) {
                        Log.i(TAG, "Connection lost during content, ExoPlayer will continue from cache...")
                    } else {
                    }
                }
            }
            
            socket?.on(Socket.EVENT_CONNECT_ERROR) { args ->
                val error = if (args.isNotEmpty()) args[0].toString() else "unknown"
                Log.e(TAG, "Socket connect error: $error")
                isSocketReconnecting = false
                increaseSocketBackoff()
                runOnUiThread {
                    showStatus("Ошибка подключения", autohideSeconds = 5)  // Скрываем через 5 сек
                    ensureSocketConnected("EVENT_CONNECT_ERROR")
                }
            }
            
            socket?.on("reconnect") { args ->
                val attempt = if (args.isNotEmpty()) args[0].toString() else "?"
                
                // ИСПРАВЛЕНО: Регистрируемся заново при reconnect (в т.ч. после transport upgrade)
                runOnUiThread {
                    registerDevice()
                    startPingTimer()
                    // Обновляем логотип при переподключении (может быть обновлен на сервере)
                    refreshAudioLogo(force = true)
                }
            }
            
            socket?.on("reconnect_attempt") { args ->
                val attempt = if (args.isNotEmpty()) args[0].toString() else "?"
                runOnUiThread {
                    showStatus("Переподключение...", autohideSeconds = 0)  // Не скрываем до успеха
                }
            }

            socket?.on("player/play") { args ->
                if (args.isNotEmpty()) {
                    val data = args[0] as? JSONObject ?: return@on
                    val startAtMs = data.optLong("startAt", 0L)
                    val startDelayHintMs = data.optLong("startDelayMs", 0L)

                    pendingSyncedPlayRunnable?.let {
                        mainHandler.removeCallbacks(it)
                        pendingSyncedPlayRunnable = null
                    }

                    val delayMs = when {
                        startDelayHintMs > 0L -> max(0L, startDelayHintMs)
                        startAtMs > 0L -> max(0L, startAtMs - System.currentTimeMillis())
                        else -> 0L
                    }

                    if (delayMs > 0L) {
                        val deferredPayload = JSONObject(data.toString())
                        val scheduledPlay = Runnable {
                            pendingSyncedPlayRunnable = null
                            if (!isActivityValid()) return@Runnable
                            handlePlay(deferredPayload)
                        }
                        pendingSyncedPlayRunnable = scheduledPlay
                        mainHandler.postDelayed(scheduledPlay, delayMs)
                        return@on
                    }

                    runOnUiThread { handlePlay(data) }
                }
            }

            socket?.on("player/pause") {
                runOnUiThread {
                    if (playbackFlags.isPlayingPlaceholder) {
                        return@runOnUiThread
                    }
                    
                    savedPosition = player?.currentPosition ?: 0
                    player?.pause()
                    stopProgressUpdates() // Останавливаем отправку прогресса
                }
            }

            socket?.on("player/resume") {
                runOnUiThread {
                    // Команда resume - продолжить воспроизведение с текущей позиции
                    // Используется когда сервер перезапустился и не знает о текущем файле
                    if (playbackFlags.isPlayingPlaceholder) {
                        return@runOnUiThread
                    }
                    
                    if (player != null && currentVideoFile != null) {
                        // Продолжаем воспроизведение с сохраненной позиции
                        player?.apply {
                            playWhenReady = true
                            play()
                        }
                    } else {
                        Log.w(TAG, "Resume: нет активного видео для продолжения")
                    }
                }
            }

            socket?.on("player/stop") { args ->
                val reason = when (val payload = args.firstOrNull()) {
                    is JSONObject -> payload.optString("reason", "")
                    is String -> payload
                    else -> ""
                } ?: ""

                pendingSyncedPlayRunnable?.let {
                    mainHandler.removeCallbacks(it)
                    pendingSyncedPlayRunnable = null
                }
                
                runOnUiThread {
                    if (playbackFlags.isPlayingPlaceholder && reason != "placeholder_refresh") {
                        return@runOnUiThread
                    }
                    
                    stopProgressUpdates() // Останавливаем отправку прогресса
                    
                    if (reason == "switch_content") {
                        playbackFlags.skipPlaceholderOnVideoEnd = true
                        if (player != null && currentVideoFile != null) {
                            savedPosition = player?.currentPosition ?: 0
                        }
                        player?.pause()
                        player?.playWhenReady = false
                        return@runOnUiThread
                    }
                    
                    // Обычный stop - возврат на заглушку (как в videojs)
                    
                    currentVideoFile = null
                    savedPosition = 0
                    playbackFlags.skipPlaceholderOnVideoEnd = false
                    
                    loadPlaceholder(skipLogoTransition = reason == "manual_stop", forceReload = reason == "placeholder_refresh")
                }
            }

            socket?.on("player/restart") {
                runOnUiThread {
                    if (playbackFlags.isPlayingPlaceholder) {
                        return@runOnUiThread
                    }
                    
                    player?.seekTo(0)
                    player?.play()
                }
            }

            socket?.on("player/seek") { args ->
                runOnUiThread {
                    if (playbackFlags.isPlayingPlaceholder) {
                        return@runOnUiThread
                    }

                    val activeState = currentFileState
                    val activeType = activeState?.type
                    if (activeState?.file.isNullOrEmpty() || (activeType != "video" && activeType != "audio")) {
                        return@runOnUiThread
                    }
                    
                    val currentPlayer = player
                    if (currentPlayer == null) {
                        Log.w(TAG, "Seek: плеер не инициализирован")
                        return@runOnUiThread
                    }
                    
                    val playbackState = currentPlayer.playbackState
                    if (playbackState == Player.STATE_BUFFERING || playbackState == Player.STATE_IDLE) {
                        // Повторяем попытку через 200ms
                        mainHandler.postDelayed({
                            // Проверяем что состояние не изменилось
                            if (currentVideoFile != null && player?.playbackState == Player.STATE_READY) {
                                performSeek(args)
                            } else {
                                Log.w(TAG, "Seek отменен - состояние изменилось после задержки")
                            }
                        }, 200)
                        return@runOnUiThread
                    }
                    
                    performSeek(args)
                }
            }

            socket?.on("placeholder/refresh") {
                runOnUiThread {
                    
                    cachedPlaceholderFile = null
                    cachedPlaceholderType = null
                    
                    placeholderTimestamp = System.currentTimeMillis()
                    
                    currentFileState = null
                    
                    if (player != null) {
                        try {
                            player?.pause()
                            // НЕ вызываем player?.stop() или clearMediaItems() здесь - это может вызвать ошибку
                            // Новый src установится автоматически при загрузке заглушки
                        } catch (e: Exception) {
                            Log.w(TAG, "Ошибка остановки плеера при placeholder/refresh: ${e.message}")
                        }
                    }
                    
                    // Небольшая задержка, затем ВСЕГДА загружаем новую заглушку (как в videojs)
                    mainHandler.postDelayed({
                        // УБРАЛИ УСЛОВИЕ - всегда загружаем новую заглушку при placeholder/refresh
                        loadPlaceholder(forceReload = true)
                    }, 100) // Небольшая задержка для остановки плеера
                }
            }

            socket?.on("player/pdfPage") { args ->
                try {
                    val page = when {
                        args.isEmpty() -> 1
                        args[0] is Number -> (args[0] as Number).toInt()
                        args[0] is String -> args[0].toString().toIntOrNull() ?: 1
                        else -> 1
                    }
                    runOnUiThread {
                        // Простая проверка как в player-videojs.js: if (!currentFileState.file || currentFileState.type !== 'pdf') return;
                        val file = currentFileState?.file
                        if (file == null || currentFileState?.type != "pdf") {
                            Log.w(TAG, "player/pdfPage: PDF file not found, currentFileState=${currentFileState?.type}/${currentFileState?.file}")
                            return@runOnUiThread
                        }
                        // Обновляем currentFileState как в player-videojs.js: currentFileState.page = page;
                        currentFileState = FileState("pdf", file, page)
                        // Вызываем функцию показа (как в player-videojs.js: showConvertedPage(currentFileState.file, 'page', page, false))
                        showPdfPage(null, page)
                        // Отправляем прогресс (как в player-videojs.js)
                        emitStaticContentProgress("pdf", file, page)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error handling player/pdfPage", e)
                }
            }

            socket?.on("player/pptxPage") { args ->
                try {
                    val slide = when {
                        args.isEmpty() -> 1
                        args[0] is Number -> (args[0] as Number).toInt()
                        args[0] is String -> args[0].toString().toIntOrNull() ?: 1
                        else -> 1
                    }
                    runOnUiThread {
                        // Простая проверка как в player-videojs.js: if (!currentFileState.file || currentFileState.type !== 'pptx') return;
                        val file = currentFileState?.file
                        if (file == null || currentFileState?.type != "pptx") {
                            Log.w(TAG, "player/pptxPage: PPTX file not found, currentFileState=${currentFileState?.type}/${currentFileState?.file}")
                            return@runOnUiThread
                        }
                        // Обновляем currentFileState как в player-videojs.js: currentFileState.page = slide;
                        currentFileState = FileState("pptx", file, slide)
                        // Вызываем функцию показа (как в player-videojs.js: showConvertedPage(currentFileState.file, 'slide', slide, false))
                        showPptxSlide(null, slide)
                        // Отправляем прогресс (как в player-videojs.js)
                        emitStaticContentProgress("pptx", file, slide)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error handling player/pptxPage", e)
                }
            }

            socket?.on("player/folderPage") { args ->
                try {
                    val imageNum = when {
                        args.isEmpty() -> 1
                        args[0] is Number -> (args[0] as Number).toInt()
                        args[0] is String -> args[0].toString().toIntOrNull() ?: 1
                        else -> 1
                    }
                    runOnUiThread {
                        // Простая проверка как в player-videojs.js: if (!currentFileState.file || currentFileState.type !== 'folder') return;
                        val folder = currentFileState?.file
                        if (folder == null || currentFileState?.type != "folder") {
                            Log.w(TAG, "player/folderPage: Folder not found, currentFileState=${currentFileState?.type}/${currentFileState?.file}")
                            return@runOnUiThread
                        }
                        // Обновляем currentFileState как в player-videojs.js: currentFileState.page = imageNum;
                        currentFileState = FileState("folder", folder, imageNum)
                        // Вызываем функцию показа (как в player-videojs.js: showFolderImage(currentFileState.file, imageNum, false))
                        showFolderImage(null, imageNum)
                        // Отправляем прогресс (как в player-videojs.js)
                        emitStaticContentProgress("folder", folder, imageNum)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error handling player/folderPage", e)
                }
            }
            
            socket?.on("player/volume") { args ->
                if (args.isNotEmpty()) {
                    val data = args[0] as? JSONObject ?: return@on
                    runOnUiThread { handleVolumeCommand(data) }
                }
            }

            socket?.on("player/registered") {
                runOnUiThread { emitVolumeState("register") }
            }
            
            socket?.on("player/pong") {
                // Pong получен - соединение работает нормально
                // Socket.IO сам управляет reconnect, Watchdog больше не нужен
            }
            
            socket?.on("player/openSettings") {
                runOnUiThread {
                    openSettings()
                }
            }

            socket?.connect()

        } catch (e: URISyntaxException) {
            Log.e(TAG, "Socket connection error", e)
        }
    }

    private fun registerDevice() {
        if (isDestroyed || isFinishing) {
            return
        }
        
        try {
            if (socket?.connected() != true) {
                Log.w(TAG, "Socket not connected, cannot register device")
                return
            }
            
            val data = JSONObject().apply {
                put("device_id", DEVICE_ID)
                put("device_type", "NATIVE_MEDIAPLAYER")
                put("platform", "Android ${android.os.Build.VERSION.RELEASE} | MMRC ${BuildConfig.VERSION_NAME}")
                put("app_version", BuildConfig.VERSION_NAME)
                put("model", android.os.Build.MODEL)
                put("manufacturer", android.os.Build.MANUFACTURER)
                put("capabilities", JSONObject().apply {
                    put("video", true)
                    put("audio", true)
                    put("images", true)
                    put("pdf", true)   // Теперь поддерживаем через конвертированные изображения
                    put("pptx", true)  // Теперь поддерживаем через конвертированные изображения
                    put("streaming", true)
                })
            }

            awaitingVolumeSync = true
            socket?.emit("player/register", data)
            
        } catch (e: Exception) {
            Log.e(TAG, "Error registering device", e)
        }
    }

    private fun handlePlay(data: JSONObject) {
        try {
            val rawType = data.optString("type")
            val type = rawType.takeIf { it.isNotBlank() }
            val fileName = data.optString("file").takeIf { it.isNotBlank() }
            val page = data.optInt("page", 1)
            val streamUrl = data.optString("stream_url").takeIf { it.isNotBlank() }
            val streamProtocolRaw = data.optString("stream_protocol", "").trim().lowercase()
            val streamProtocol = when {
                streamProtocolRaw.isNotBlank() -> streamProtocolRaw
                streamUrl?.contains(".mpd", ignoreCase = true) == true -> "dash"
                streamUrl?.contains(".m3u8", ignoreCase = true) == true -> "hls"
                else -> "hls"
            }
            val originalName = data.optString("originalName").takeIf { it.isNotBlank() }
                ?: data.optString("original_name").takeIf { it.isNotBlank() }
            // НОВОЕ: Запоминаем устройство, с которого нужно брать контент (для статических файлов из "Все файлы")
            val originDeviceId = data.optString("originDeviceId", null)
            if (!originDeviceId.isNullOrEmpty()) {
                contentDeviceId = originDeviceId
            } else {
                // Если originDeviceId не передан, используем текущее устройство
                contentDeviceId = DEVICE_ID
            }


            val resolvedType = resolveContentType(type, fileName, originalName, fallbackToFolder = true)
            val normalizedType = if (resolvedType == "unknown") "folder" else resolvedType

            if (fileName.isNullOrEmpty() && normalizedType != "streaming" && normalizedType != "video" && normalizedType != "audio") {
                Log.e(TAG, "File name is empty for type=$normalizedType")
                showStatus("Ошибка: имя файла не указано")
                return
            }
            
            val prevFileStateType = currentFileState?.type
            val wasPlaceholder = prevFileStateType == "placeholder" || prevFileStateType == null || playbackFlags.isPlayingPlaceholder
            
            if (wasPlaceholder && playbackFlags.isPlayingPlaceholder) {
                playbackFlags.skipPlaceholderOnVideoEnd = true
                if (player != null && player!!.isPlaying) {
                    player?.pause()
                }
                if (imageView.drawable != null) {
                    clearImageView()
                }
            }

            when (normalizedType) {
                "video" -> {
                    if (fileName.isNullOrEmpty()) {
                        if (currentVideoFile != null && player != null) {
                            if (savedPosition > 0) {
                                player?.seekTo(savedPosition)
                                savedPosition = 0
                            }
                            player?.playWhenReady = true
                            player?.play()
                            startProgressUpdates()
                            playbackFlags.skipPlaceholderOnVideoEnd = false
                        }
                    } else {
                        playVideo(fileName, isPlaceholder = false)
                        currentFileState = FileState("video", fileName, 1)
                        playbackFlags.skipPlaceholderOnVideoEnd = false
                    }
                }
                "audio" -> {
                    if (fileName.isNullOrEmpty()) {
                        if (currentVideoFile != null && player != null) {
                            if (savedPosition > 0) {
                                player?.seekTo(savedPosition)
                                savedPosition = 0
                            }
                            player?.playWhenReady = true
                            player?.play()
                            startProgressUpdates()
                            playbackFlags.skipPlaceholderOnVideoEnd = false
                        }
                    } else {
                        playAudio(fileName)
                        currentFileState = FileState("audio", fileName, 1)
                        playbackFlags.skipPlaceholderOnVideoEnd = false
                    }
                }
                "streaming" -> {
                    if (!streamUrl.isNullOrEmpty()) {
                        playStream(streamUrl, streamProtocol, fileName ?: "")
                        currentFileState = FileState("streaming", fileName ?: "", 1, streamProtocol = streamProtocol)
                        playbackFlags.skipPlaceholderOnVideoEnd = false
                    } else {
                        Log.e(TAG, "Stream URL is missing")
                        showStatus("Ошибка: URL стрима не указан")
                    }
                }
                "image" -> {
                    if (!fileName.isNullOrEmpty()) {
                        showImage(fileName, isPlaceholder = false)
                        currentFileState = FileState("image", fileName, 1)
                        playbackFlags.skipPlaceholderOnVideoEnd = false
                    } else {
                        Log.e(TAG, "Image file name is empty")
                        showStatus("Ошибка: имя файла изображения не указано")
                    }
                }
                "pdf" -> {
                    if (!fileName.isNullOrEmpty()) {
                        // КРИТИЧНО: Устанавливаем currentFileState ДО вызова showPdfPage, чтобы команды листания работали сразу
                        currentFileState = FileState("pdf", fileName, page)
                        currentPdfFile = fileName
                        currentPdfPage = page
                        val isFromPlaceholder = wasPlaceholder || prevFileStateType == null || prevFileStateType == "video"
                        showPdfPage(fileName, page, isFromPlaceholder)
                        playbackFlags.skipPlaceholderOnVideoEnd = false
                    } else {
                        Log.e(TAG, "PDF file name is empty")
                        showStatus("Ошибка: имя файла PDF не указано")
                    }
                }
                "pptx" -> {
                    if (!fileName.isNullOrEmpty()) {
                        // КРИТИЧНО: Устанавливаем currentFileState ДО вызова showPptxSlide, чтобы команды листания работали сразу
                        currentFileState = FileState("pptx", fileName, page)
                        currentPptxFile = fileName
                        currentPptxSlide = page
                        val isFromPlaceholder = wasPlaceholder || prevFileStateType == null || prevFileStateType == "video"
                        showPptxSlide(fileName, page, isFromPlaceholder)
                        playbackFlags.skipPlaceholderOnVideoEnd = false
                    } else {
                        Log.e(TAG, "PPTX file name is empty")
                        showStatus("Ошибка: имя файла PPTX не указано")
                    }
                }
                "folder" -> {
                    if (!fileName.isNullOrEmpty()) {
                        val folderName = fileName.replace(Regex("\\.zip$", RegexOption.IGNORE_CASE), "")
                        // КРИТИЧНО: Устанавливаем currentFileState ДО вызова showFolderImage, чтобы команды листания работали сразу
                        currentFileState = FileState("folder", folderName, page)
                        currentFolderName = folderName
                        currentFolderImage = page
                        val isFromPlaceholder = wasPlaceholder || prevFileStateType == null || prevFileStateType == "video"
                        showFolderImage(folderName, page, isFromPlaceholder)
                        playbackFlags.skipPlaceholderOnVideoEnd = false
                    } else {
                        Log.e(TAG, "Folder name is empty")
                        showStatus("Ошибка: имя папки не указано")
                    }
                }
                else -> {
                    Log.w(TAG, "Unknown content type: $normalizedType (original: $type)")
                    showStatus("Неподдерживаемый тип контента: $normalizedType")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error handling play command", e)
            showStatus("Ошибка воспроизведения")
        }
    }
    
    private fun performSeek(args: Array<out Any>) {
        try {
            val position = when {
                args.isNotEmpty() -> {
                    val data = args[0]
                    when (data) {
                        is JSONObject -> data.optDouble("position", 0.0)
                        is Number -> data.toDouble()
                        else -> 0.0
                    }
                }
                else -> 0.0
            }
            
            val currentPlayer = player ?: return
            if (position >= 0) {
                val positionMs = (position * 1000).toLong()
                val duration = currentPlayer.duration
                
                val targetPosition = if (duration > 0 && positionMs > duration) {
                    duration
                } else {
                    positionMs
                }
                
                if (currentPlayer.playbackState == Player.STATE_READY || 
                    currentPlayer.playbackState == Player.STATE_BUFFERING) {
                    currentPlayer.seekTo(targetPosition)
                    savedPosition = targetPosition
                } else {
                    Log.w(TAG, "Seek отменен - плеер не готов (state=${currentPlayer.playbackState})")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error performing seek", e)
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
        player?.pause()
        fadeOutView(playerView, durationMs) {
            // 1. Отвязываем плеер от Surface
            playerView.player = null
            // 2. Останавливаем плеер и очищаем медиа
            player?.stop()
            player?.clearMediaItems()
            // 3. Скрываем View
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
                        // 1. Отвязываем плеер от Surface
                        if (outgoingView is StyledPlayerView) {
                            outgoingView.player = null
                        }
                        // 2. Останавливаем плеер и очищаем медиа
                        outgoingPlayer?.stop()
                        outgoingPlayer?.clearMediaItems()
                        // 3. Скрываем View
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
        resetPendingVideoState()
    }

    private fun playVideo(fileName: String, isPlaceholder: Boolean = false) {
        if (isDestroyed || isFinishing) return

        hideAudioLogo()
        
        if (fileName.isNullOrEmpty()) {
            Log.e(TAG, "playVideo: fileName is empty")
            if (!isPlaceholder) {
                showStatus("Ошибка: имя файла не указано")
                loadPlaceholder()
            }
            return
        }
        
        try {
            // НОВОЕ: Используем API resolver для поддержки shared storage (дедупликация)
            // Вместо /content/{device}/{file} используем /api/files/resolve/{device}/{file}
            val deviceIdForContent = getDeviceIdForContent()
            val videoUrl = if (isPlaceholder && placeholderTimestamp > 0) {
                "$SERVER_URL/api/files/resolve/$deviceIdForContent/${Uri.encode(fileName)}?t=$placeholderTimestamp"
            } else {
                "$SERVER_URL/api/files/resolve/$deviceIdForContent/${Uri.encode(fileName)}"
            }

            prepareContentPlayback(ContentType.Video) {
                playbackFlags.skipPlaceholderOnVideoEnd = false
                errorRetryCount = 0
                retryRunnable?.let { mainHandler.removeCallbacks(it) }
                retryRunnable = null
            }

            val isSameFile = currentVideoFile == fileName && !isPlaceholder
            
            if (isSameFile && player != null) {
                // Тот же файл - продолжаем с сохраненной позиции (без переходов, как в videojs)
                if (savedPosition > 0) {
                    player?.seekTo(savedPosition)
                    savedPosition = 0 // Сбрасываем после использования
                }
                player?.apply {
                    playWhenReady = true
                    play()
                }
                currentFileState = FileState(if (isPlaceholder) "placeholder" else "video", fileName, 1)
                playbackFlags.skipPlaceholderOnVideoEnd = false
                if (playerView.alpha > 0f) {
                    playerView.visibility = View.VISIBLE
                }
                if (!isPlaceholder) {
                    startProgressUpdates()
                }
                return
            }

            stopProgressUpdates()
            currentVideoFile = fileName
            savedPosition = 0

            if (!ensurePlayerInitialized()) {
                showStatus("Ошибка подготовки видео")
                if (!isPlaceholder) {
                    mainHandler.postDelayed({
                        if (!isDestroyed && !isFinishing) {
                            loadPlaceholder()
                        }
                    }, 1000)
                }
                return
            }

            loadNewVideo(videoUrl, fileName, isPlaceholder, player!!, playerView)
            
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OutOfMemoryError playing video: $fileName", e)
            handleOutOfMemory()
        } catch (e: Exception) {
            Log.e(TAG, "Error playing video: $fileName", e)
            if (!isDestroyed && !isFinishing) {
                showStatus("Ошибка загрузки видео")
                if (!isPlaceholder) {
                    mainHandler.postDelayed({
                        if (!isDestroyed && !isFinishing) {
                            loadPlaceholder()
                        }
                    }, 1000)
                }
            }
        }
    }

    private fun playAudio(fileName: String) {
        if (isDestroyed || isFinishing) return

        if (fileName.isEmpty()) {
            Log.e(TAG, "playAudio: fileName is empty")
            showStatus("Ошибка: имя файла не указано")
            loadPlaceholder()
            return
        }

        showAudioLogo()

        try {
            val deviceIdForContent = getDeviceIdForContent()
            val audioUrl = "$SERVER_URL/api/files/resolve/$deviceIdForContent/${Uri.encode(fileName)}"

            prepareContentPlayback(ContentType.Audio) {
                playbackFlags.skipPlaceholderOnVideoEnd = false
                errorRetryCount = 0
                retryRunnable?.let { mainHandler.removeCallbacks(it) }
                retryRunnable = null
            }

            val isSameFile = currentVideoFile == fileName
            if (isSameFile && player != null) {
                if (savedPosition > 0) {
                    player?.seekTo(savedPosition)
                    savedPosition = 0
                }
                player?.apply {
                    playWhenReady = true
                    play()
                }
                currentFileState = FileState("audio", fileName, 1)
                playbackFlags.skipPlaceholderOnVideoEnd = false
                startProgressUpdates()
                return
            }

            stopProgressUpdates()
            currentVideoFile = fileName
            savedPosition = 0

            if (!ensurePlayerInitialized()) {
                showStatus("Ошибка подготовки аудио")
                mainHandler.postDelayed({
                    if (!isDestroyed && !isFinishing) {
                        loadPlaceholder()
                    }
                }, 1000)
                return
            }

            loadNewAudio(audioUrl, fileName, player!!, playerView)

        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OutOfMemoryError playing audio: $fileName", e)
            handleOutOfMemory()
        } catch (e: Exception) {
            Log.e(TAG, "Error playing audio: $fileName", e)
            if (!isDestroyed && !isFinishing) {
                showStatus("Ошибка загрузки аудио")
                mainHandler.postDelayed({
                    if (!isDestroyed && !isFinishing) {
                        loadPlaceholder()
                    }
                }, 1000)
            }
        }
    }
    
    private fun playStream(streamUrl: String, streamProtocol: String, fileName: String) {
        if (isDestroyed || isFinishing) return

        hideAudioLogo()
        try {
            prepareContentPlayback(ContentType.Streaming) {
                playbackFlags.skipPlaceholderOnVideoEnd = false
                errorRetryCount = 0
                retryRunnable?.let { mainHandler.removeCallbacks(it) }
                retryRunnable = null
                currentVideoFile = fileName
                savedPosition = 0
            }

            if (!ensurePlayerInitialized()) {
                showStatus("Ошибка подготовки стрима")
                return
            }

            loadNewStream(streamUrl, streamProtocol, fileName, player!!, playerView)
            
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OutOfMemoryError playing stream: $fileName", e)
            handleOutOfMemory()
        } catch (e: Exception) {
            Log.e(TAG, "Error playing stream: $fileName", e)
            if (!isDestroyed && !isFinishing) {
                showStatus("Ошибка загрузки стрима")
            }
        }
    }
    
    // Функция для безопасного освобождения плеера с увеличенной задержкой
    private fun safeReleasePlayer(
        player: ExoPlayer,
        view: StyledPlayerView,
        onComplete: (Boolean) -> Unit
    ) {
        try {
            // 1. Отвязываем от Surface
            view.player = null
            
            // 2. Останавливаем воспроизведение
            if (player.playbackState != Player.STATE_IDLE) {
                player.pause()
                player.stop()
            }
            
            // 3. Очищаем медиа
            player.clearMediaItems()
            
            // 4. Увеличиваем задержку до 300ms для полного освобождения MediaCodec
            mainHandler.postDelayed({
                onComplete(true)
            }, 300) // Увеличено с 100ms до 300ms для предотвращения вылетов
            
        } catch (e: Exception) {
            Log.e(TAG, "Error in safeReleasePlayer", e)
            // Даже при ошибке продолжаем через задержку
            mainHandler.postDelayed({
                onComplete(false)
            }, 300)
        }
    }

    private fun loadNewAudio(
        audioUrl: String,
        originalFileName: String,
        targetPlayer: ExoPlayer,
        targetView: StyledPlayerView
    ) {
        try {
            val httpDataSourceFactory = DefaultHttpDataSource.Factory().apply {
                setAllowCrossProtocolRedirects(true)
                setConnectTimeoutMs(60000)
                setReadTimeoutMs(60000)
                setUserAgent(userAgent)
            }

            val cacheDataSourceFactory = if (simpleCache != null) {
                CacheDataSource.Factory()
                    .setCache(simpleCache!!)
                    .setUpstreamDataSourceFactory(DefaultDataSource.Factory(this, httpDataSourceFactory))
                    .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
            } else {
                DefaultDataSource.Factory(this, httpDataSourceFactory)
            }

            val mediaItem = MediaItem.fromUri(audioUrl)
            val mediaSource = ProgressiveMediaSource.Factory(cacheDataSourceFactory)
                .createMediaSource(mediaItem)

            mediaCodecInitRunnable?.let {
                mainHandler.removeCallbacks(it)
                mediaCodecInitRunnable = null
            }

            if (isDestroyed || isFinishing) {
                return
            }

            safeReleasePlayer(targetPlayer, targetView) { released ->
                if (!released) {
                    Log.w(TAG, "Player release failed or timed out, continuing anyway")
                }

                if (isDestroyed || isFinishing) {
                    return@safeReleasePlayer
                }

                try {
                    targetView.player = targetPlayer
                    targetView.visibility = View.GONE
                    targetView.alpha = 0f

                    targetPlayer.apply {
                        setMediaSource(mediaSource)
                        repeatMode = Player.REPEAT_MODE_OFF
                        prepare()
                        playWhenReady = true
                        play()
                    }

                    playbackFlags.isPlayingPlaceholder = false
                    currentFileState = FileState("audio", originalFileName, 1)
                    playbackFlags.skipPlaceholderOnVideoEnd = false
                    startProgressUpdates()
                } catch (e: Exception) {
                    Log.e(TAG, "Error initializing audio source", e)
                    if (!isDestroyed && !isFinishing) {
                        showStatus("Ошибка инициализации аудио")
                    }
                }
            }

        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OutOfMemoryError loading new audio", e)
            handleOutOfMemory()
        } catch (e: Exception) {
            Log.e(TAG, "Error loading new audio", e)
            if (!isDestroyed && !isFinishing) {
                showStatus("Ошибка загрузки аудио")
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
            
            
            // HTTP Data Source с увеличенными таймаутами для больших файлов
            val httpDataSourceFactory = DefaultHttpDataSource.Factory().apply {
                setAllowCrossProtocolRedirects(true)
                setConnectTimeoutMs(60000)   // 60 секунд на подключение
                setReadTimeoutMs(60000)      // 60 секунд на чтение
                setUserAgent(userAgent)
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

            mediaCodecInitRunnable?.let { 
                mainHandler.removeCallbacks(it)
                mediaCodecInitRunnable = null
            }
            
            if (isDestroyed || isFinishing) {
                return
            }
            
            safeReleasePlayer(targetPlayer, targetView) { released ->
                if (!released) {
                    Log.w(TAG, "Player release failed or timed out, continuing anyway")
                }
                
                // Проверяем состояние Activity после задержки
                if (isDestroyed || isFinishing) {
                    return@safeReleasePlayer
                }
                
                // Инициализируем новый контент
                try {
                    targetView.player = targetPlayer
                    targetView.visibility = View.VISIBLE
                    targetView.alpha = 1f
                    targetView.bringToFront()
                    statusText.bringToFront()
                    
                    targetPlayer.apply {
                        setMediaSource(mediaSource)
                        repeatMode = if (isPlaceholder) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
                        prepare()
                        playWhenReady = true
                        play()
                    }
                    
                    playbackFlags.isPlayingPlaceholder = isPlaceholder
                    currentFileState = FileState(if (isPlaceholder) "placeholder" else "video", originalFileName, 1)
                    // Сбрасываем флаг переключения после загрузки контента (как в videojs)
                    playbackFlags.skipPlaceholderOnVideoEnd = false
                    if (isPlaceholder) {
                        emitIdleProgress("placeholder_video")
                    }
                    if (!isPlaceholder) {
                        startProgressUpdates()
                    }
                    
                    
                } catch (e: Exception) {
                    Log.e(TAG, "Error initializing video source", e)
                    if (!isDestroyed && !isFinishing) {
                        showStatus("Ошибка инициализации видео")
                    }
                }
            }
            
            
            
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OutOfMemoryError loading new video", e)
            handleOutOfMemory()
            // Не показываем сообщение зрителям - очистка происходит в фоне
        } catch (e: Exception) {
            Log.e(TAG, "Error loading new video", e)
            if (!isDestroyed && !isFinishing) {
                showStatus("Ошибка загрузки видео")
            }
        }
    }
    
    private fun loadNewStream(
        streamUrl: String,
        streamProtocol: String,
        originalFileName: String,
        targetPlayer: ExoPlayer,
        targetView: StyledPlayerView
    ) {
        try {
            // Если нет - добавляем SERVER_URL в начало
            val fullStreamUrl = if (streamUrl.startsWith("http://") || streamUrl.startsWith("https://")) {
                streamUrl
            } else {
                // Относительный путь - добавляем SERVER_URL
                val baseUrl = SERVER_URL.trimEnd('/')
                val path = if (streamUrl.startsWith("/")) streamUrl else "/$streamUrl"
                "$baseUrl$path"
            }
            
            
            
            // HTTP Data Source с увеличенными таймаутами для стримов
            val httpDataSourceFactory = DefaultHttpDataSource.Factory().apply {
                setAllowCrossProtocolRedirects(true)
                setConnectTimeoutMs(60000)   // 60 секунд на подключение
                setReadTimeoutMs(60000)      // 60 секунд на чтение
                setUserAgent(userAgent)
            }

            val dataSourceFactory = DefaultDataSource.Factory(this, httpDataSourceFactory)
            
            val mediaItem = MediaItem.fromUri(fullStreamUrl)
            val effectiveProtocol = when {
                streamProtocol.equals("dash", ignoreCase = true) || fullStreamUrl.contains(".mpd", ignoreCase = true) -> "dash"
                streamProtocol.equals("hls", ignoreCase = true) || fullStreamUrl.contains(".m3u8", ignoreCase = true) -> "hls"
                else -> streamProtocol.lowercase()
            }

            Log.i(
                TAG,
                "Loading stream: protocol=$streamProtocol effectiveProtocol=$effectiveProtocol url=$fullStreamUrl"
            )

            val mediaSource = when (effectiveProtocol) {
                "hls" -> {
                    HlsMediaSource.Factory(dataSourceFactory)
                        .setAllowChunklessPreparation(true)
                        .createMediaSource(mediaItem)
                }
                "dash" -> {
                    DashMediaSource.Factory(dataSourceFactory)
                        .createMediaSource(mediaItem)
                }
                else -> {
                    // Для неизвестных режимов используем HLS fallback,
                    // чтобы не ломать старые конфигурации стримов.
                    
                    HlsMediaSource.Factory(dataSourceFactory)
                        .setAllowChunklessPreparation(true)
                        .createMediaSource(mediaItem)
                }
            }

            mediaCodecInitRunnable?.let { 
                mainHandler.removeCallbacks(it)
                mediaCodecInitRunnable = null
            }
            
            if (isDestroyed || isFinishing) {
                return
            }
            
            safeReleasePlayer(targetPlayer, targetView) { released ->
                if (!released) {
                    Log.w(TAG, "Player release failed or timed out, continuing anyway")
                }
                
                // Проверяем состояние Activity после задержки
                if (isDestroyed || isFinishing) {
                    return@safeReleasePlayer
                }
                
                // Инициализируем новый стрим
                try {
                    targetView.player = targetPlayer
                    targetView.visibility = View.VISIBLE
                    targetView.alpha = 1f
                    targetView.bringToFront()
                    statusText.bringToFront()
                    
                    targetPlayer.apply {
                        setMediaSource(mediaSource)
                        repeatMode = Player.REPEAT_MODE_OFF // Стримы не повторяются
                        prepare()
                        playWhenReady = true
                        play()
                    }
                    
                    playbackFlags.isPlayingPlaceholder = false
                    currentFileState = FileState("streaming", originalFileName, 1, streamProtocol = streamProtocol)
                    // Сбрасываем флаг переключения после загрузки контента (как в videojs)
                    playbackFlags.skipPlaceholderOnVideoEnd = false
                    startProgressUpdates()
                    
                    
                } catch (e: Exception) {
                    Log.e(TAG, "Error initializing stream source", e)
                    if (!isDestroyed && !isFinishing) {
                        showStatus("Ошибка инициализации стрима")
                    }
                }
            }
            
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OutOfMemoryError loading new stream", e)
            handleOutOfMemory()
            // Не показываем сообщение зрителям - очистка происходит в фоне
        } catch (e: Exception) {
            Log.e(TAG, "Error loading new stream", e)
            if (!isDestroyed && !isFinishing) {
                showStatus("Ошибка загрузки стрима")
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

    // Общая функция для показа статического контента (изображения, PDF, PPTX, папки)
    private fun showStaticContent(
        contentType: ContentType,
        imageUrl: String,
        contentName: String,
        pageNum: Int,
        progressType: String,
        resetStaticState: Boolean = true
    ) {
        if (isDestroyed || isFinishing) return

        hideAudioLogo()
        
        // Если resetStaticState = false, не сбрасываем переменные статического контента (для первого показа)
        if (resetStaticState) {
            prepareContentPlayback(contentType) {
                errorRetryCount = 0
                retryRunnable?.let { mainHandler.removeCallbacks(it) }
                retryRunnable = null
                currentVideoFile = null
                savedPosition = 0
            }
        } else {
            // Только очищаем изображение и сбрасываем состояние видео, но НЕ сбрасываем переменные статического контента
            clearImageView()
            resetPendingVideoState()
            stopProgressUpdates()
            errorRetryCount = 0
            retryRunnable?.let { mainHandler.removeCallbacks(it) }
            retryRunnable = null
            currentVideoFile = null
            savedPosition = 0
        }
        
        playbackFlags.isPlayingPlaceholder = false
        val hasPreviousImage = imageView.drawable != null
        val hasVideo = playerView.alpha > 0f && playerView.visibility == View.VISIBLE
        
        playbackFlags.skipPlaceholderOnVideoEnd = true
        stopAllPlayers("showStaticContent - switching to $progressType")
        
        loadImageToView(
            imageUrl,
            useFadeFromLogo = false,
            delayMs = 0,
            crossFadeFromCurrent = !hasVideo && hasPreviousImage,
            crossFadeFromVideo = hasVideo
        )
        
        emitStaticContentProgress(progressType, contentName, pageNum)
        preloadAdjacentSlides(contentName, pageNum, 999, progressType)
    }

    private fun showImage(fileName: String, isPlaceholder: Boolean = false) {
        if (isDestroyed || isFinishing) return

        hideAudioLogo()
        
        if (fileName.isNullOrEmpty()) {
            Log.e(TAG, "showImage: fileName is empty!")
            if (!isPlaceholder) {
                showStatus("Ошибка: имя файла не указано")
                loadPlaceholder()
            }
            return
        }
        
        try {
            val deviceIdForContent = getDeviceIdForContent()
            val imageUrl = if (isPlaceholder && placeholderTimestamp > 0) {
                "$SERVER_URL/api/files/resolve/$deviceIdForContent/${Uri.encode(fileName)}?t=$placeholderTimestamp"
            } else {
                "$SERVER_URL/api/files/resolve/$deviceIdForContent/${Uri.encode(fileName)}"
            }
            
            if (isPlaceholder) {
                brandBg.visibility = View.GONE
                brandBg.alpha = 0f
            }
            
            if (isPlaceholder) {
                // Для placeholder используем прямую загрузку (без showStaticContent)
                prepareContentPlayback(ContentType.Image) {
                    errorRetryCount = 0
                    retryRunnable?.let { mainHandler.removeCallbacks(it) }
                    retryRunnable = null
                    currentVideoFile = null
                    savedPosition = 0
                }
                
                playbackFlags.isPlayingPlaceholder = true
                val hasPreviousImage = imageView.drawable != null && imageView.alpha > 0f && imageView.visibility == View.VISIBLE
                val hasVideo = playerView.alpha > 0f && playerView.visibility == View.VISIBLE
                
                playbackFlags.skipPlaceholderOnVideoEnd = true
                stopAllPlayers("showImage - switching to placeholder image")
                
                loadImageToView(
                    imageUrl,
                    useFadeFromLogo = false,
                    delayMs = 0,
                    crossFadeFromCurrent = !hasVideo && hasPreviousImage,
                    crossFadeFromVideo = hasVideo
                )
                
                emitIdleProgress("placeholder_image")
            } else {
                showStaticContent(ContentType.Image, imageUrl, fileName, 1, "image")
            }
            
            
            
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OutOfMemoryError showing image: $fileName", e)
            handleOutOfMemory()
            // Не показываем сообщение зрителям - очистка происходит в фоне
        } catch (e: Exception) {
            Log.e(TAG, "Error showing image: $fileName", e)
            if (!isDestroyed && !isFinishing) {
                showStatus("Ошибка загрузки изображения")
                if (!isPlaceholder) {
                    mainHandler.postDelayed({
                        if (!isDestroyed && !isFinishing) {
                            Log.w(TAG, "Ошибка загрузки изображения, возврат на заглушку")
                            loadPlaceholder()
                        }
                    }, 1000)
                }
            }
        }
    }
    
    // Функция оставлена для совместимости
    private fun showLogoBackground(fadeDurationMs: Long = 500L) {
        showAudioLogo()
    }

    private fun showPdfPage(fileName: String?, page: Int, isFromPlaceholder: Boolean = false) {
        if (isDestroyed || isFinishing) return
        
        try {
            val file = fileName ?: currentPdfFile
            if (file == null) {
                Log.w(TAG, "PDF file name is null")
                return
            }

            // Устанавливаем переменные (если еще не установлены из handlePlay)
            if (currentPdfFile != file) {
                currentPdfFile = file
            }
            currentPdfPage = page
            
            val deviceIdForContent = getDeviceIdForContent()
            val pageUrl = "$SERVER_URL/api/devices/$deviceIdForContent/converted/${Uri.encode(file)}/page/$page"
            
            // Возвращаем использование showStaticContent для первого показа, но без сброса переменных
            if (isFromPlaceholder) {
                // Первый показ - используем showStaticContent с resetStaticState=false, чтобы не сбросить переменные
                showStaticContent(ContentType.Pdf, pageUrl, file, page, "pdf", resetStaticState = false)
            } else {
                // Листание - прямая загрузка для быстрого переключения
                playbackFlags.isPlayingPlaceholder = false
                playbackFlags.skipPlaceholderOnVideoEnd = true
                stopAllPlayers("showPdfPage - switching page")
                
                val hasPreviousImage = imageView.drawable != null
                val hasVideo = playerView.alpha > 0f && playerView.visibility == View.VISIBLE
                val crossFadeFromCurrent = !hasVideo && hasPreviousImage
                val crossFadeFromVideo = hasVideo
                
                loadImageToView(pageUrl, crossFadeFromCurrent = crossFadeFromCurrent, crossFadeFromVideo = crossFadeFromVideo)
                emitStaticContentProgress("pdf", file, page)
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "Error showing PDF page", e)
            showStatus("Ошибка загрузки PDF")
        }
    }

    private fun showPptxSlide(fileName: String?, slide: Int, isFromPlaceholder: Boolean = false) {
        if (isDestroyed || isFinishing) return
        
        try {
            val file = fileName ?: currentPptxFile
            if (file == null) {
                Log.w(TAG, "PPTX file name is null")
                return
            }

            // Устанавливаем переменные (если еще не установлены из handlePlay)
            if (currentPptxFile != file) {
                currentPptxFile = file
            }
            currentPptxSlide = slide
            
            val deviceIdForContent = getDeviceIdForContent()
            val slideUrl = "$SERVER_URL/api/devices/$deviceIdForContent/converted/${Uri.encode(file)}/slide/$slide"
            
            // Возвращаем использование showStaticContent для первого показа, но без сброса переменных
            if (isFromPlaceholder) {
                // Первый показ - используем showStaticContent с resetStaticState=false, чтобы не сбросить переменные
                showStaticContent(ContentType.Pptx, slideUrl, file, slide, "pptx", resetStaticState = false)
            } else {
                // Листание - прямая загрузка для быстрого переключения
                playbackFlags.isPlayingPlaceholder = false
                playbackFlags.skipPlaceholderOnVideoEnd = true
                stopAllPlayers("showPptxSlide - switching slide")
                
                val hasPreviousImage = imageView.drawable != null
                val hasVideo = playerView.alpha > 0f && playerView.visibility == View.VISIBLE
                val crossFadeFromCurrent = !hasVideo && hasPreviousImage
                val crossFadeFromVideo = hasVideo
                
                loadImageToView(slideUrl, crossFadeFromCurrent = crossFadeFromCurrent, crossFadeFromVideo = crossFadeFromVideo)
                emitStaticContentProgress("pptx", file, slide)
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "Error showing PPTX slide", e)
            showStatus("Ошибка загрузки PPTX")
        }
    }

    private fun showFolderImage(folderName: String?, imageNum: Int, isFromPlaceholder: Boolean = false) {
        if (isDestroyed || isFinishing) return
        
        try {
            val folder = folderName ?: currentFolderName
            if (folder == null) {
                Log.w(TAG, "Folder name is null")
                return
            }

            // Устанавливаем переменные (если еще не установлены из handlePlay)
            if (currentFolderName != folder) {
                currentFolderName = folder
            }
            currentFolderImage = imageNum
            
            val deviceIdForContent = getDeviceIdForContent()
            val imageUrl = "$SERVER_URL/api/devices/$deviceIdForContent/folder/${Uri.encode(folder)}/image/$imageNum"
            
            // Возвращаем использование showStaticContent для первого показа, но без сброса переменных
            if (isFromPlaceholder) {
                // Первый показ - используем showStaticContent с resetStaticState=false, чтобы не сбросить переменные
                showStaticContent(ContentType.Folder, imageUrl, folder, imageNum, "folder", resetStaticState = false)
            } else {
                // Листание - прямая загрузка для быстрого переключения
                playbackFlags.isPlayingPlaceholder = false
                playbackFlags.skipPlaceholderOnVideoEnd = true
                stopAllPlayers("showFolderImage - switching image")
                
                val hasPreviousImage = imageView.drawable != null
                val hasVideo = playerView.alpha > 0f && playerView.visibility == View.VISIBLE
                val crossFadeFromCurrent = !hasVideo && hasPreviousImage
                val crossFadeFromVideo = hasVideo
                
                loadImageToView(imageUrl, crossFadeFromCurrent = crossFadeFromCurrent, crossFadeFromVideo = crossFadeFromVideo)
                emitStaticContentProgress("folder", folder, imageNum)
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "Error showing folder image", e)
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
            if (isDestroyed || isFinishing) {
                return
            }

            
            // Glide для быстрой загрузки изображений
            
            
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
                            mainHandler.postDelayed({
                                if (!isDestroyed && !isFinishing) {
                                    fadeInView(imageView, 500) {
                                        
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
                            Log.e(TAG, "Glide failed to load image: $imageUrl", e)
                            if (!playbackFlags.isPlayingPlaceholder && !isDestroyed && !isFinishing) {
                                mainHandler.postDelayed({
                                    if (!isDestroyed && !isFinishing && !playbackFlags.isPlayingPlaceholder) {
                                        Log.w(TAG, "Ошибка загрузки изображения, возврат на заглушку")
                                        loadPlaceholder()
                                    }
                                }, 1000)
                            }
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
                                        // 1. Отвязываем плеер от Surface
                                        if (outgoingView is StyledPlayerView) {
                                            outgoingView.player = null
                                        }
                                        // 2. Останавливаем плеер и очищаем медиа
                                        outgoingPlayer?.stop()
                                        outgoingPlayer?.clearMediaItems()
                                        // 3. Скрываем View
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
                            Log.e(TAG, "Glide failed to load image: $imageUrl", e)
                            if (!playbackFlags.isPlayingPlaceholder && !isDestroyed && !isFinishing) {
                                mainHandler.postDelayed({
                                    if (!isDestroyed && !isFinishing && !playbackFlags.isPlayingPlaceholder) {
                                        Log.w(TAG, "Ошибка загрузки изображения, возврат на заглушку")
                                        loadPlaceholder()
                                    }
                                }, 1000)
                            }
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
                            Log.e(TAG, "Glide failed to load image: $imageUrl", e)
                            if (!playbackFlags.isPlayingPlaceholder && !isDestroyed && !isFinishing) {
                                mainHandler.postDelayed({
                                    if (!isDestroyed && !isFinishing && !playbackFlags.isPlayingPlaceholder) {
                                        Log.w(TAG, "Ошибка загрузки изображения, возврат на заглушку")
                                        loadPlaceholder()
                                    }
                                }, 1000)
                            }
                            return false
                        }
                        }).into(imageView)
                    }
                }
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "Error loading image with Glide", e)
            if (!isDestroyed && !isFinishing) {
                showStatus("Ошибка загрузки изображения")
                if (!playbackFlags.isPlayingPlaceholder) {
                    mainHandler.postDelayed({
                        if (!isDestroyed && !isFinishing && !playbackFlags.isPlayingPlaceholder) {
                            Log.w(TAG, "Ошибка загрузки изображения, возврат на заглушку")
                            loadPlaceholder()
                        }
                    }, 1000)
                }
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
                        Log.w(TAG, "Previous bitmap is already recycled")
                        return null
                    }
                    // Создаем полную копию bitmap
                    val bitmapCopy = bitmap.copy(bitmap.config, true)
                    if (bitmapCopy == null) {
                        Log.w(TAG, "Failed to copy bitmap")
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
                        Log.w(TAG, "Cannot create copy for drawable type: ${drawable.javaClass.simpleName}")
                        null
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error creating drawable copy: ${e.message}", e)
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
            return
        }
        
                    request.into(object : CustomTarget<android.graphics.drawable.Drawable>() {
                        override fun onResourceReady(
                            resource: android.graphics.drawable.Drawable,
                            transition: Transition<in android.graphics.drawable.Drawable>?
                        ) {
                if (isDestroyed || isFinishing) {
                    return
                }
                
                            if (previousDrawable == null) {
                    // Нет предыдущего изображения - показываем сразу без fade-in (чтобы избежать черного экрана)
                    imageView.alpha = 1f
                    imageView.setImageDrawable(resource)
                    return
                }

                // Создаем кроссфейд между предыдущим и новым изображением
                val previousCopy = try {
                    createIndependentDrawableCopy(previousDrawable)
                } catch (e: Exception) {
                    Log.w(TAG, "Failed to copy previous drawable, using fade-in instead: ${e.message}")
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
                            mainHandler.postDelayed({
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
            
            // Это предотвращает черный экран при переходе на второй кадр
            if (currentPage == 1 && totalPages > 1) {
                pagesToPreload.add(2)
            }
            
            val deviceIdForContent = getDeviceIdForContent()
            
            pagesToPreload.forEach { page ->
                val url = when (type) {
                    "pdf" -> "$SERVER_URL/api/devices/$deviceIdForContent/converted/${Uri.encode(file)}/page/$page"
                    "pptx" -> "$SERVER_URL/api/devices/$deviceIdForContent/converted/${Uri.encode(file)}/slide/$page"
                    "folder" -> "$SERVER_URL/api/devices/$deviceIdForContent/folder/${Uri.encode(file)}/image/$page"
                    else -> return@forEach
                }
                
                // Предзагружаем в фоне (Glide автоматически кэширует)
                Glide.with(this)
                    .load(url)
                    .diskCacheStrategy(DiskCacheStrategy.ALL)
                    .skipMemoryCache(false)  // Используем memory cache для мгновенного показа
                    .preload()
                
                
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to preload adjacent slides: ${e.message}")
        }
    }

    private fun loadPlaceholder(skipLogoTransition: Boolean = false, forceReload: Boolean = false) {
        if (playbackFlags.isLoadingPlaceholder) {
            
            return
        }

        if (!forceReload) {
            val isPlaceholderVisible = playbackFlags.isPlayingPlaceholder && (
                (playerView.visibility == View.VISIBLE && playerView.alpha > 0f) ||
                (imageView.visibility == View.VISIBLE && imageView.alpha > 0f)
            )
            
            if (isPlaceholderVisible) {
                
                return
            }
            
            if (pendingPlayer != null && pendingVideoIsPlaceholder) {
                
                return
            }
        }
        
        playbackFlags.isLoadingPlaceholder = true
        Log.i(TAG, "🔍 Loading placeholder...")
        
        cancelPendingBuffer("loadPlaceholder")

        // Проверяем кэш - если есть, загружаем сразу без запроса к серверу!
        if (cachedPlaceholderFile != null && cachedPlaceholderType != null) {
            
            
            when (cachedPlaceholderType) {
                "video" -> {
                    playVideo(cachedPlaceholderFile!!, isPlaceholder = true)
                    currentFileState = FileState("placeholder", cachedPlaceholderFile, 1)
                }
                "image" -> {
                    showImage(cachedPlaceholderFile!!, isPlaceholder = true)
                    currentFileState = FileState("placeholder", cachedPlaceholderFile, 1)
                }
            }
            playbackFlags.isLoadingPlaceholder = false  // Сбрасываем флаг после успешной загрузки из кэша
            return
        }
        
        // Кэша нет - запрашиваем заглушку с сервера (только первый раз)
        loadPlaceholderFromServer()
    }
    
    private fun loadPlaceholderFromServer() {
        placeholderJob?.cancel()  // Отменяем предыдущую загрузку если была
        placeholderJob = lifecycleScope.launch(Dispatchers.IO) {
            if (isDestroyed || isFinishing) {
                return@launch
            }
            
            try {
                val url = java.net.URL("$SERVER_URL/api/devices/$DEVICE_ID/placeholder")
                val connection = url.openConnection() as java.net.HttpURLConnection
                connection.connectTimeout = 5000  // Уменьшен таймаут
                connection.readTimeout = 5000
                connection.requestMethod = "GET"
                
                if (isDestroyed || isFinishing) {
                    connection.disconnect()
                    return@launch
                }
                
                if (connection.responseCode == 200) {
                    val response = connection.inputStream.bufferedReader().use { it.readText() }
                    val json = JSONObject(response)
                    val placeholderFile = json.optString("placeholder", null)
                    
                    if (placeholderFile != null && placeholderFile != "null") {
                        
                        
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
                        
                        if (isDestroyed || isFinishing) {
                            connection.disconnect()
                            return@launch
                        }
                        
                        withContext(Dispatchers.Main) {
                            if (isDestroyed || isFinishing) return@withContext
                            
                            when (cachedPlaceholderType) {
                                "video" -> {
                                    playVideo(placeholderFile, isPlaceholder = true)
                                    currentFileState = FileState("placeholder", placeholderFile, 1)
                                }
                                "image" -> {
                                    showImage(placeholderFile, isPlaceholder = true)
                                    currentFileState = FileState("placeholder", placeholderFile, 1)
                                }
                                else -> Log.w(TAG, "Unknown placeholder type: $ext")
                            }
                            playbackFlags.isLoadingPlaceholder = false  // Сбрасываем флаг после успешной загрузки
                        }
                    } else {
                        
                        // Заглушка ДОЛЖНА быть, поэтому продолжаем попытки
                        if (!isDestroyed && !isFinishing) {
                            withContext(Dispatchers.Main) {
                                if (isDestroyed || isFinishing) return@withContext
                                playbackFlags.isLoadingPlaceholder = false  // Сбрасываем флаг перед retry
                            }
                            scheduleRetryPlaceholder()
                        }
                    }
                } else {
                    Log.e(TAG, "Failed to load placeholder: HTTP ${connection.responseCode}, retrying in 10s...")
                    if (!isDestroyed && !isFinishing) {
                        withContext(Dispatchers.Main) {
                            if (!isDestroyed && !isFinishing) {
                                playbackFlags.isLoadingPlaceholder = false  // Сбрасываем флаг перед retry
                            }
                        }
                        scheduleRetryPlaceholder()
                    }
                }
                connection.disconnect()
            } catch (e: OutOfMemoryError) {
                Log.e(TAG, "OutOfMemoryError loading placeholder, clearing caches", e)
                if (!isDestroyed && !isFinishing) {
                    withContext(Dispatchers.Main) {
                        if (!isDestroyed && !isFinishing) {
                            handleOutOfMemory()
                            playbackFlags.isLoadingPlaceholder = false
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error loading placeholder: ${e.message}, retrying in 10s...", e)
                if (!isDestroyed && !isFinishing) {
                    withContext(Dispatchers.Main) {
                        if (!isDestroyed && !isFinishing) {
                            playbackFlags.isLoadingPlaceholder = false  // Сбрасываем флаг перед retry
                        }
                    }
                    scheduleRetryPlaceholder()
                }
            }
        }
    }
    
    private fun scheduleRetryPlaceholder() {
        // Retry через 10 секунд
        retryRunnable?.let { mainHandler.removeCallbacks(it) }
        retryRunnable = Runnable {
            if (isDestroyed || isFinishing) {
                return@Runnable
            }
            
            if (cachedPlaceholderFile == null && socket?.connected() == true) {
                
                loadPlaceholder()
            }
        }
        mainHandler.postDelayed(retryRunnable!!, 10000)
    }

    private val hideStatusRunnable = Runnable {
        if (isDestroyed || isFinishing) return@Runnable
        // Используем функцию hideStatus() которая проверяет флаг showStatus
        hideStatus()
    }

    private fun showStatus(message: String, autohideSeconds: Int = 3) {
        if (!showStatus) return
        
        mainHandler.removeCallbacks(hideStatusRunnable)
        
        statusText.text = message
        statusText.visibility = View.VISIBLE
        
        // Применение цветов из панели спикера
        when {
            message.contains("Ошибка", ignoreCase = true) -> {
                statusText.setTextColor(ContextCompat.getColor(this, R.color.status_error))
                statusText.setBackgroundColor(ContextCompat.getColor(this, R.color.bg_secondary))
            }
            message.contains("Буферизация", ignoreCase = true) -> {
                statusText.setTextColor(ContextCompat.getColor(this, R.color.status_warning))
                statusText.setBackgroundColor(ContextCompat.getColor(this, R.color.bg_secondary))
            }
            else -> {
                statusText.setTextColor(ContextCompat.getColor(this, R.color.text_primary))
                statusText.setBackgroundColor(ContextCompat.getColor(this, R.color.bg_secondary))
            }
        }
        
        // Автоскрытие через N секунд
        if (autohideSeconds > 0) {
            mainHandler.postDelayed(hideStatusRunnable, autohideSeconds * 1000L)
        }
    }

    private fun hideStatus() {
        mainHandler.removeCallbacks(hideStatusRunnable)
        if (showStatus) {
            statusText.visibility = View.GONE
        }
    }

    private val pingRunnable = object : Runnable {
        override fun run() {
            if (isDestroyed || isFinishing) {
                return
            }
            
            if (socket?.connected() == true) {
                socket?.emit("player/ping")
                Log.d(TAG, "🏓 Ping sent")
            } else {
                Log.w(TAG, "Socket not connected, skipping ping")
                ensureSocketConnected("ping watchdog")
            }
            
            // Планируем следующий ping
            val interval = config.pingInterval.toLong()
            mainHandler.postDelayed(this, interval)
        }
    }
    
    private val connectionWatchdogRunnable = object : Runnable {
        override fun run() {
            if (isDestroyed || isFinishing) {
                return
            }
            
            ensureSocketConnected("watchdog")
            scheduleConnectionWatchdog()
        }
    }
    
    private fun startPingTimer() {
        stopPingTimer() // Останавливаем предыдущий таймер если был
        
        val interval = config.pingInterval.toLong()
        mainHandler.postDelayed(pingRunnable, interval) // Первый ping через interval
        
        
    }
    
    private fun stopPingTimer() {
        mainHandler.removeCallbacks(pingRunnable)
        
    }

    private fun startConnectionWatchdog() {
        mainHandler.removeCallbacks(connectionWatchdogRunnable)
        scheduleConnectionWatchdog()
        Log.d(TAG, "🔍 Connection watchdog started")
    }
    
    private fun stopConnectionWatchdog() {
        mainHandler.removeCallbacks(connectionWatchdogRunnable)
        Log.d(TAG, "🔍 Connection watchdog stopped")
    }
    
    private fun scheduleConnectionWatchdog() {
        mainHandler.removeCallbacks(connectionWatchdogRunnable)
        val interval = max(5000L, config.reconnectDelay.toLong())
        mainHandler.postDelayed(connectionWatchdogRunnable, interval)
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
        
        mainHandler.postDelayed({
            connectSocket()
        }, 200) // небольшая задержка, чтобы disconnect завершился
    }
    
    // Отправка прогресса воспроизведения на сервер
    private fun startProgressUpdates() {
        stopProgressUpdates() // Останавливаем предыдущий если был
        
        progressRunnable = object : Runnable {
            override fun run() {
                if (isDestroyed || isFinishing) {
                    return
                }
                
                try {
                    val exoPlayer = player ?: return
                    val stateSnapshot = currentFileState
                    val fileName = stateSnapshot?.file?.takeIf { it.isNotBlank() } ?: return
                    val contentType = stateSnapshot.type ?: return
                    if (!isMediaContentType(contentType)) {
                        return
                    }
                    
                    // Отправляем прогресс только для медиа (видео/аудио/стрим), не для заглушек
                    // Проверяем не только isPlaying, но и состояние буферизации
                    val isPlayingOrBuffering = exoPlayer.isPlaying || 
                        exoPlayer.playbackState == Player.STATE_BUFFERING ||
                        exoPlayer.playbackState == Player.STATE_READY
                    
                    // Это нужно для отображения текущей позиции на панели спикера
                    val isVideoReady = exoPlayer.playbackState == Player.STATE_READY
                    
                    if (!playbackFlags.isPlayingPlaceholder && (isPlayingOrBuffering || isVideoReady)) {
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
                            put("type", contentType)
                            put("file", fileName)
                            put("currentTime", currentTime)
                            put("duration", durationSeconds)
                            if (contentType == "streaming") {
                                stateSnapshot.streamProtocol?.let { put("stream_protocol", it) }
                            }
                        }
                        
                        if (socket?.connected() == true) {
                            socket?.emit("player/progress", progressData)
                            if (durationSeconds > 0) {
                                
                            } else {
                                
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
                mainHandler.postDelayed(this, 1000)
            }
        }
        
        // Первая отправка сразу
        mainHandler.post(progressRunnable!!)
        
    }
    
    private fun stopProgressUpdates() {
        progressRunnable?.let {
            mainHandler.removeCallbacks(it)
            progressRunnable = null
            
        }
    }
    

    override fun onDestroy() {
        super.onDestroy()
        Log.i(TAG, "=== MainActivity onDestroy ===")
        
        // Очищаем все Handler
        stopPingTimer()
        stopConnectionWatchdog()
        stopProgressUpdates()
        pendingSyncedPlayRunnable?.let {
            mainHandler.removeCallbacks(it)
            pendingSyncedPlayRunnable = null
        }
        // stopLogoRefreshTimer() удален - логотип больше не используется
        mainHandler.removeCallbacks(hideStatusRunnable)
        mainHandler.removeCallbacksAndMessages(null)
        // Отменяем pending инициализацию MediaCodec
        mediaCodecInitRunnable?.let {
            mainHandler.removeCallbacks(it)
            mediaCodecInitRunnable = null
        }
        // logoRefreshHandler удален - логотип больше не используется
        unregisterVolumeReceiver()
        
        // Отменяем корутины
        placeholderJob?.cancel()
        audioLogoJob?.cancel()
        playbackFlags.isLoadingPlaceholder = false  // Сбрасываем флаг загрузки заглушки
        
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
        
        if (isFirstLaunch) {
            Log.d(TAG, "First launch, skipping restore (onCreate is loading placeholder)")
            isFirstLaunch = false  // Сбрасываем ЗДЕСЬ в onResume
            return
        }
        
        // Восстанавливаем воспроизведение только если оно реально остановилось
        if (player?.isPlaying == false && (playerView.visibility == View.VISIBLE || imageView.visibility == View.VISIBLE)) {
            Log.i(TAG, "Player not playing in onResume, restoring...")
            if (playbackFlags.isPlayingPlaceholder) {
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
        
        // Все происходит незаметно для зрителей - воспроизведение не прерывается
        if (level >= android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            Log.w(TAG, "Low memory detected (level $level), clearing caches in background")
            
            val isPlaceholderPlaying = playbackFlags.isPlayingPlaceholder
            val isPlayerPlaying = player?.isPlaying == true
            
            // Очистка в фоне, чтобы не блокировать воспроизведение
            lifecycleScope.launch(Dispatchers.IO) {
                try {
                    // Очищаем Glide memory cache
                    withContext(Dispatchers.Main) {
                        try {
                            Glide.get(this@MainActivity).clearMemory()
                            
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
                            
                        } catch (e: Exception) {
                            Log.e(TAG, "Failed to clear Glide disk cache: ${e.message}", e)
                        }
                        
                        // Если играет заглушка - НЕ трогаем, она должна продолжать играть
                        if (!isPlayerPlaying && !isPlaceholderPlaying) {
                            withContext(Dispatchers.Main) {
                                try {
                                    releaseSimpleCache()
                                    // Переинициализируем через задержку
                                    mainHandler.postDelayed({
                                        try {
                                            if (!isDestroyed && !isFinishing) {
                                                initializeSimpleCache()
                                            }
                                        } catch (e: Exception) {
                                            Log.e(TAG, "Error reinitializing cache: ${e.message}", e)
                                        }
                                    }, 1000)
                                    
                                } catch (e: Exception) {
                                    Log.e(TAG, "Error clearing ExoPlayer cache: ${e.message}", e)
                                }
                            }
                        } else {
                            
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
        Log.e(TAG, "Handling OutOfMemoryError - clearing caches in background")
        
        val wasPlayingPlaceholder = playbackFlags.isPlayingPlaceholder
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
                            mainHandler.postDelayed({
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
                
                
                
                // 5. Если играла заглушка и она остановилась - восстанавливаем незаметно
                if (wasPlayingPlaceholder) {
                    withContext(Dispatchers.Main) {
                        mainHandler.postDelayed({
                            try {
                                if (isDestroyed || isFinishing) return@postDelayed
                                // Проверяем, играет ли еще заглушка
                                if (!playbackFlags.isPlayingPlaceholder || player?.isPlaying != true) {
                                    // Восстанавливаем незаметно, без сообщений
                                    loadPlaceholder()
                                    
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
    
    /**
     * Открытие экрана настроек
     * Вызывается из разных мест: длительное нажатие, кнопки пульта, Socket.IO команда
     */
    private fun openSettings() {
        try {
            startActivity(Intent(this, SettingsActivity::class.java))
            Log.i(TAG, "📱 Открытие настроек")
        } catch (e: Exception) {
            Log.e(TAG, "Ошибка открытия настроек: ${e.message}", e)
        }
    }
    
    /**
     * Обработка нажатий кнопок пульта Android TV
     * Длительное нажатие кнопки OK (DPAD_CENTER) - открывает настройки
     */
    private var okButtonPressTime: Long = 0
    private val LONG_PRESS_DURATION_MS = 2000L // 2 секунды для длительного нажатия
    private var lastUpPressTime: Long = 0
    private var upPressCount: Int = 0
    
    override fun dispatchKeyEvent(event: KeyEvent?): Boolean {
        if (event == null) return super.dispatchKeyEvent(event)
        
        // Пульт используется только для локальных настроек
        if (event.keyCode == KeyEvent.KEYCODE_DPAD_UP && event.action == KeyEvent.ACTION_DOWN) {
            // Считаем количество нажатий UP подряд
            val now = System.currentTimeMillis()
            if (now - lastUpPressTime < 500) { // В пределах 500мс
                upPressCount++
            } else {
                upPressCount = 1
            }
            lastUpPressTime = now
            
            // Если нажали UP дважды подряд - готовы к открытию настроек по OK
            if (upPressCount >= 2) {
                Log.d(TAG, "📱 Двойное нажатие UP - ожидание OK для открытия настроек")
            }
            return super.dispatchKeyEvent(event)
        }
        
        if (event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER || 
            event.keyCode == KeyEvent.KEYCODE_ENTER || 
            event.keyCode == KeyEvent.KEYCODE_BUTTON_A) {
            
            when (event.action) {
                KeyEvent.ACTION_DOWN -> {
                    okButtonPressTime = System.currentTimeMillis()
                    // Проверяем комбинацию UP+UP+OK
                    if (upPressCount >= 2) {
                        Log.i(TAG, "📱 Комбинация UP+UP+OK - открытие настроек")
                        upPressCount = 0
                        openSettings()
                        return true
                    }
                }
                KeyEvent.ACTION_UP -> {
                    val pressDuration = System.currentTimeMillis() - okButtonPressTime
                    if (pressDuration >= LONG_PRESS_DURATION_MS) {
                        // Длительное нажатие - открываем настройки
                        Log.i(TAG, "📱 Длительное нажатие OK (${pressDuration}ms) - открытие настроек")
                        openSettings()
                        return true
                    }
                    // Сбрасываем счетчик UP при обычном нажатии OK
                    upPressCount = 0
                }
            }
        } else {
            // Сбрасываем счетчик UP при нажатии других кнопок
            if (event.action == KeyEvent.ACTION_DOWN) {
                upPressCount = 0
            }
        }
        
        return super.dispatchKeyEvent(event)
    }
}


