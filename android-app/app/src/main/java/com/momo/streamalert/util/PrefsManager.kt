package com.momo.streamalert.util

import android.content.Context
import android.content.SharedPreferences

class PrefsManager(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
        set(value) = prefs.edit().putString(KEY_SERVER_URL, value.trim()).apply()

    var secretKey: String
        get() = prefs.getString(KEY_SECRET_KEY, DEFAULT_SECRET_KEY) ?: DEFAULT_SECRET_KEY
        set(value) = prefs.edit().putString(KEY_SECRET_KEY, value.trim()).apply()

    companion object {
        private const val PREFS_NAME = "momo_alert_prefs"
        private const val KEY_SERVER_URL = "key_server_url"
        private const val KEY_SECRET_KEY = "key_secret_key"

        const val DEFAULT_SERVER_URL = "http://192.168.1.50:3000/api/v1/webhook/momo-notify"
        const val DEFAULT_SECRET_KEY = "super_secret_webhook_key_momo_2024_abcxyz"
    }
}
