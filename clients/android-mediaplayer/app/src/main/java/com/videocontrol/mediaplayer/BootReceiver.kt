package com.videocontrol.mediaplayer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * BroadcastReceiver для автозапуска приложения при включении устройства
 */
class BootReceiver : BroadcastReceiver() {
    
    companion object {
        private const val TAG = "BootReceiver"
        private const val LAUNCH_DELAY = 1000L // 1 секунда задержки (уменьшена для быстрого запуска)
    }
    
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        
        if (action == Intent.ACTION_BOOT_COMPLETED || 
            action == Intent.ACTION_LOCKED_BOOT_COMPLETED ||
            action == "android.intent.action.QUICKBOOT_POWERON") {
            
            Log.d(TAG, "📱 Boot completed detected: $action")
            
            // Проверяем что настройки заполнены
            if (SettingsActivity.isConfigured(context)) {
                Log.i(TAG, "✅ Configuration found, will launch MainActivity in ${LAUNCH_DELAY}ms")
                
                // Задержка для стабильности (дать системе время загрузиться)
                Handler(Looper.getMainLooper()).postDelayed({
                    try {
                        // Запускаем MainActivity с флагами для обхода Background Activity Start restrictions
                        val launchIntent = Intent(context, MainActivity::class.java).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
                            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK)
                            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                            addFlags(Intent.FLAG_ACTIVITY_NO_USER_ACTION)  // Обход ограничений фонового запуска
                        }
                        
                        context.startActivity(launchIntent)
                        Log.i(TAG, "🚀 MainActivity launched successfully (delay: ${LAUNCH_DELAY}ms)")
                        
                    } catch (e: Exception) {
                        Log.e(TAG, "❌ Failed to launch MainActivity", e)
                    }
                }, LAUNCH_DELAY)
                
            } else {
                Log.w(TAG, "⚠️ Configuration not found, skipping auto-start")
                Log.i(TAG, "ℹ️ User needs to configure app first")
            }
        }
    }
}

