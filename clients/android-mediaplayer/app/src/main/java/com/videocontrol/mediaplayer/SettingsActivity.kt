package com.videocontrol.mediaplayer

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

class SettingsActivity : AppCompatActivity() {

    private lateinit var serverUrlInput: EditText
    private lateinit var deviceIdInput: EditText
    private lateinit var showStatusCheckbox: CheckBox
    private lateinit var saveButton: Button

    companion object {
        private const val PREFS_NAME = "VCMediaPlayerSettings"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_SHOW_STATUS = "show_status"

        fun getServerUrl(context: Context): String? {
            return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getString(KEY_SERVER_URL, null)
        }

        fun getDeviceId(context: Context): String? {
            return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getString(KEY_DEVICE_ID, null)
        }
        
        fun getShowStatus(context: Context): Boolean {
            return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getBoolean(KEY_SHOW_STATUS, false) // По умолчанию выключено
        }

        fun isConfigured(context: Context): Boolean {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val serverUrl = prefs.getString(KEY_SERVER_URL, null)
            val deviceId = prefs.getString(KEY_DEVICE_ID, null)
            return !serverUrl.isNullOrBlank() && !deviceId.isNullOrBlank()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        serverUrlInput = findViewById(R.id.serverUrlInput)
        deviceIdInput = findViewById(R.id.deviceIdInput)
        showStatusCheckbox = findViewById(R.id.showStatusCheckbox)
        saveButton = findViewById(R.id.saveButton)

        // Загружаем сохраненные значения
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        serverUrlInput.setText(prefs.getString(KEY_SERVER_URL, "http://10.172.0.151"))
        deviceIdInput.setText(prefs.getString(KEY_DEVICE_ID, "ATV001"))
        showStatusCheckbox.isChecked = prefs.getBoolean(KEY_SHOW_STATUS, false)

        saveButton.setOnClickListener {
            val serverUrl = serverUrlInput.text.toString().trim()
            val deviceId = deviceIdInput.text.toString().trim()
            val showStatus = showStatusCheckbox.isChecked

            if (serverUrl.isEmpty()) {
                Toast.makeText(this, "Укажите адрес сервера", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            if (deviceId.isEmpty()) {
                Toast.makeText(this, "Укажите ID устройства", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            // Сохраняем настройки
            prefs.edit()
                .putString(KEY_SERVER_URL, serverUrl)
                .putString(KEY_DEVICE_ID, deviceId)
                .putBoolean(KEY_SHOW_STATUS, showStatus)
                .apply()

            Toast.makeText(this, "Настройки сохранены", Toast.LENGTH_SHORT).show()

            // Переход к главному экрану
            startActivity(Intent(this, MainActivity::class.java))
            finish()
        }
    }

    override fun onBackPressed() {
        // Если настройки не сохранены - не даем вернуться
        if (!isConfigured(this)) {
            Toast.makeText(this, "Сначала настройте приложение", Toast.LENGTH_SHORT).show()
        } else {
            super.onBackPressed()
        }
    }
}

