package com.momo.streamalert.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import androidx.core.app.NotificationCompat
import com.momo.streamalert.MainActivity
import com.momo.streamalert.R
import com.momo.streamalert.data.AppDatabase
import com.momo.streamalert.data.NotificationItem
import com.momo.streamalert.worker.NotificationSyncWorker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Service lắng nghe thông báo của MoMo (package: com.mservice.momotransfer).
 * Chạy Foreground Service với thông báo cố định trên thanh trạng thái để ngăn Android diệt ngầm.
 */
class MomoNotificationListenerService : NotificationListenerService() {

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "MomoNotificationListenerService onCreate")
        startForegroundServiceNotification()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundServiceNotification()
        return START_STICKY
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        Log.i(TAG, "Notification Listener đã được kết nối với hệ điều hành Android")
        startForegroundServiceNotification()
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        Log.w(TAG, "Notification Listener bị ngắt kết nối. Yêu cầu hệ thống kết nối lại...")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            requestRebind(
                android.content.ComponentName(this, MomoNotificationListenerService::class.java)
            )
        }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return

        val packageName = sbn.packageName ?: return
        // Hỗ trợ cả thông báo MoMo và VNPAY
        val isSupported = packageName == MOMO_PACKAGE_NAME
            || packageName.contains("vnpay", ignoreCase = true)
            || packageName == VNPAY_PACKAGE_NAME
            || packageName == VNPAY_ALT_PACKAGE_NAME

        if (!isSupported) {
            return
        }

        val notification = sbn.notification ?: return
        val extras = notification.extras ?: return

        // 1. Trích xuất Tiêu đề thông báo
        val title = extras.getString(Notification.EXTRA_TITLE)
            ?: extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
            ?: ""

        // 2. Trích xuất Nội dung thông báo (ưu tiên BIG_TEXT nếu có để lấy trọn vẹn lời nhắn và mã GD)
        val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
        val standardText = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
        val rawText = when {
            !bigText.isNullOrBlank() -> bigText
            !standardText.isNullOrBlank() -> standardText
            else -> ""
        }

        val appName = if (packageName.contains("vnpay", ignoreCase = true)) "VNPAY" else "MoMo"

        if (rawText.isBlank()) {
            Log.d(TAG, "Bỏ qua thông báo $appName vì nội dung rỗng.")
            return
        }

        val notifId = sbn.id.toString()
        val postTime = if (sbn.postTime > 0) sbn.postTime else System.currentTimeMillis()

        Log.i(TAG, "Nhận được thông báo $appName: [$title] - $rawText")

        // 3. Lưu vào Room DB và gọi WorkManager gửi về Docker Server
        serviceScope.launch {
            try {
                val db = AppDatabase.getInstance(applicationContext)
                val newItem = NotificationItem(
                    notifId = notifId,
                    packageName = packageName,
                    rawTitle = title,
                    rawText = rawText,
                    deviceTimestamp = postTime,
                    status = NotificationItem.STATUS_PENDING
                )
                val rowId = db.notificationDao().insert(newItem)
                Log.d(TAG, "Đã lưu thông báo $appName vào Room DB (id=$rowId). Bắt đầu kích hoạt Worker...")

                NotificationSyncWorker.enqueueSync(applicationContext)
            } catch (e: Exception) {
                Log.e(TAG, "Lỗi khi lưu thông báo $appName vào DB: ${e.message}", e)
            }
        }
    }

    /**
     * Khởi tạo kênh thông báo và duy trì Foreground Service
     */
    private fun startForegroundServiceNotification() {
        val channelId = CHANNEL_ID
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId,
                "MoMo Alert Service Channel",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Duy trì lắng nghe thông báo MoMo liên tục"
                setShowBadge(false)
            }
            manager.createNotificationChannel(channel)
        }

        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            openAppIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val notification = NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_momo_notification)
            .setContentTitle(getString(R.string.fgs_title))
            .setContentText(getString(R.string.fgs_desc))
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pendingIntent)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        private const val TAG = "MomoNotifService"
        const val MOMO_PACKAGE_NAME = "com.mservice.momotransfer"
        const val VNPAY_PACKAGE_NAME = "vnpay.smartacccount"
        const val VNPAY_ALT_PACKAGE_NAME = "vnpay.smartaccount"
        private const val CHANNEL_ID = "momo_alert_foreground_channel"
        private const val NOTIFICATION_ID = 1001
    }
}
