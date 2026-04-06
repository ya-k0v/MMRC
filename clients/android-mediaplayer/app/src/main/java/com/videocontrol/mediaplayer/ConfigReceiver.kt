package com.videocontrol.mediaplayer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * BroadcastReceiver для удаленной настройки приложения через adb
 * 
 * Использование:
 * adb shell am broadcast -a com.videocontrol.mediaplayer.CONFIGURE \
 *   --es server_url "10.172.1.74" \
 *   --es device_id "ATV001" \
 *   --ez show_status false
 */
class ConfigReceiver : BroadcastReceiver() {
    
    private val TAG = "ConfigReceiver"
    
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == "com.videocontrol.mediaplayer.CONFIGURE") {
            val serverUrl = intent.getStringExtra("server_url")
            val deviceId = intent.getStringExtra("device_id")
            val showStatus = intent.getBooleanExtra("show_status", false)
            
            if (serverUrl.isNullOrBlank() || deviceId.isNullOrBlank()) {
                Log.w(TAG, "Invalid configuration: server_url or device_id is empty")
                return
            }
            
            try {
                val prefs = context.getSharedPreferences("VCMediaPlayerSettings", Context.MODE_PRIVATE)
                val cleanUrl = serverUrl.removePrefix("http://").removePrefix("https://")
                
                prefs.edit()
                    .putString("server_url", cleanUrl)
                    .putString("device_id", deviceId)
                    .putBoolean("show_status", showStatus)
                    .apply()
                
                Log.i(TAG, "Configuration updated: server_url=$cleanUrl, device_id=$deviceId, show_status=$showStatus")
            } catch (e: Exception) {
                Log.e(TAG, "Error saving configuration", e)
            }
        }
    }
}

