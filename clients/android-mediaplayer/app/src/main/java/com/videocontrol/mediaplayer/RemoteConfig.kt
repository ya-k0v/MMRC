package com.videocontrol.mediaplayer

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Загрузка конфигурации с сервера
 */
class RemoteConfig(private val context: Context) {
    
    private val TAG = "RemoteConfig"
    
    data class Config(
        val pingInterval: Int = 20000,           // Интервал ping в мс
        val reconnectDelay: Int = 5000,          // Задержка переподключения
        val watchdogInterval: Int = 60000,       // Интервал проверки watchdog
        val maxDisconnectTime: Int = 180000,     // Макс время отключения перед перезапуском
        val bufferMinMs: Int = 30000,            // Минимальный буфер видео (уменьшено для памяти)
        val bufferMaxMs: Int = 60000,            // Максимальный буфер видео (уменьшено для памяти)
        val cacheSize: Long = 200L * 1024 * 1024, // Размер кэша видео (уменьшено до 200MB)
        val showStatus: Boolean = false          // Показывать статусы
    )
    
    /**
     * Загрузить конфигурацию с сервера
     */
    suspend fun fetchConfig(serverUrl: String, deviceId: String): Config? {
        return withContext(Dispatchers.IO) {
            try {
                val url = URL("$serverUrl/api/devices/$deviceId/config")
                val connection = url.openConnection() as HttpURLConnection
                connection.connectTimeout = 10000
                connection.readTimeout = 10000
                connection.requestMethod = "GET"
                
                if (connection.responseCode == 200) {
                    val response = connection.inputStream.bufferedReader().use { it.readText() }
                    val json = JSONObject(response)
                    
                    val config = Config(
                        pingInterval = json.optInt("ping_interval", 20000),
                        reconnectDelay = json.optInt("reconnect_delay", 5000),
                        watchdogInterval = json.optInt("watchdog_interval", 60000),
                        maxDisconnectTime = json.optInt("max_disconnect_time", 180000),
                        bufferMinMs = json.optInt("buffer_min_ms", 30000),
                        bufferMaxMs = json.optInt("buffer_max_ms", 60000),
                        cacheSize = json.optLong("cache_size", 200L * 1024 * 1024),
                        showStatus = json.optBoolean("show_status", false)
                    )
                    
                    Log.i(TAG, "Config loaded from server: $config")
                    connection.disconnect()
                    config
                    
                } else if (connection.responseCode == 404) {
                    // Сервер не поддерживает remote config - используем defaults
                    Log.i(TAG, "Server doesn't support remote config (404), using defaults")
                    connection.disconnect()
                    Config()
                    
                } else {
                    Log.w(TAG, "Failed to load config: HTTP ${connection.responseCode}")
                    connection.disconnect()
                    null
                }
                
            } catch (e: Exception) {
                Log.e(TAG, "Error loading config: ${e.message}", e)
                null
            }
        }
    }
    
    /**
     * Сохранить конфигурацию в SharedPreferences
     */
    fun saveConfig(config: Config) {
        val prefs = context.getSharedPreferences("VCMediaPlayerSettings", Context.MODE_PRIVATE)
        prefs.edit().apply {
            putInt("ping_interval", config.pingInterval)
            putInt("reconnect_delay", config.reconnectDelay)
            putInt("watchdog_interval", config.watchdogInterval)
            putInt("max_disconnect_time", config.maxDisconnectTime)
            putInt("buffer_min_ms", config.bufferMinMs)
            putInt("buffer_max_ms", config.bufferMaxMs)
            putLong("cache_size", config.cacheSize)
            putBoolean("show_status", config.showStatus)
            apply()
        }
        Log.i(TAG, "Config saved to SharedPreferences")
    }
    
    /**
     * Загрузить конфигурацию из SharedPreferences
     */
    fun loadConfig(): Config {
        val prefs = context.getSharedPreferences("VCMediaPlayerSettings", Context.MODE_PRIVATE)
        return Config(
            pingInterval = prefs.getInt("ping_interval", 20000),
            reconnectDelay = prefs.getInt("reconnect_delay", 5000),
            watchdogInterval = prefs.getInt("watchdog_interval", 60000),
            maxDisconnectTime = prefs.getInt("max_disconnect_time", 180000),
            bufferMinMs = prefs.getInt("buffer_min_ms", 30000),
            bufferMaxMs = prefs.getInt("buffer_max_ms", 60000),
            cacheSize = prefs.getLong("cache_size", 200L * 1024 * 1024),
            showStatus = prefs.getBoolean("show_status", false)
        )
    }
}

