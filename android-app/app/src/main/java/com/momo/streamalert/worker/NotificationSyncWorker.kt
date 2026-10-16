package com.momo.streamalert.worker

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.momo.streamalert.data.AppDatabase
import com.momo.streamalert.data.NotificationItem
import com.momo.streamalert.util.HmacSigner
import com.momo.streamalert.util.PrefsManager
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Worker gửi thông báo MoMo từ Android về Docker Server qua mạng LAN.
 * Tích hợp hàng đợi retry tự động với Exponential Backoff của WorkManager.
 */
class NotificationSyncWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    private val db = AppDatabase.getInstance(appContext)
    private val dao = db.notificationDao()
    private val prefs = PrefsManager(appContext)

    private val client = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .writeTimeout(8, TimeUnit.SECONDS)
        .build()

    override suspend fun doWork(): Result {
        val pendingList = dao.getPendingNotifications()
        if (pendingList.isEmpty()) {
            return Result.success()
        }

        val serverUrl = prefs.serverUrl
        val secretKey = prefs.secretKey
        var hasNetworkFailure = false

        Log.d(TAG, "Bắt đầu đồng bộ ${pendingList.size} thông báo MoMo tới: $serverUrl")

        for (item in pendingList) {
            try {
                // Tạo JSON Body khớp với schema backend
                val payloadObj = JSONObject().apply {
                    put("notifId", item.notifId ?: "notif_${item.id}")
                    put("packageName", item.packageName)
                    put("rawTitle", item.rawTitle ?: "")
                    put("rawText", item.rawText)
                }
                val rawBody = payloadObj.toString()
                val timestamp = System.currentTimeMillis().toString()

                // Ký HMAC-SHA256
                val signature = HmacSigner.calculateHmac(rawBody, secretKey)

                val requestBody = rawBody.toRequestBody("application/json; charset=utf-8".toMediaType())
                val request = Request.Builder()
                    .url(serverUrl)
                    .header("Content-Type", "application/json")
                    .header("X-Signature", signature)
                    .header("X-Timestamp", timestamp)
                    .post(requestBody)
                    .build()

                val response = client.newCall(request).execute()
                val responseBody = response.body?.string() ?: ""

                if (response.isSuccessful) {
                    Log.i(TAG, "Đã gửi thành công notifId=${item.id}: $responseBody")
                    dao.updateStatus(item.id, NotificationItem.STATUS_SUCCESS, null)
                } else {
                    Log.w(TAG, "Server từ chối HTTP ${response.code}: $responseBody")
                    // Lỗi 4xx (client error / invalid signature) thì không retry vô ích
                    if (response.code in 400..499) {
                        dao.updateStatus(
                            item.id,
                            NotificationItem.STATUS_FAILED,
                            "HTTP ${response.code}: $responseBody"
                        )
                    } else {
                        // Lỗi 5xx từ server -> đánh dấu để retry
                        hasNetworkFailure = true
                        dao.updateStatus(
                            item.id,
                            NotificationItem.STATUS_PENDING,
                            "Server lỗi 5xx (${response.code})"
                        )
                    }
                }
            } catch (e: IOException) {
                // Lỗi mất kết nối Wi-Fi, máy Docker tắt, Connection refused, v.v.
                Log.e(TAG, "Lỗi kết nối LAN khi gửi thông báo #${item.id}: ${e.message}")
                hasNetworkFailure = true
                dao.updateStatus(
                    item.id,
                    NotificationItem.STATUS_PENDING,
                    "Không thể kết nối máy chủ: ${e.localizedMessage ?: "Connection error"}"
                )
            } catch (e: Exception) {
                Log.e(TAG, "Lỗi không xác định khi xử lý thông báo #${item.id}: ${e.message}", e)
                dao.updateStatus(
                    item.id,
                    NotificationItem.STATUS_FAILED,
                    "Lỗi cục bộ: ${e.message}"
                )
            }
        }

        return if (hasNetworkFailure) {
            Log.w(TAG, "Có thông báo gửi thất bại do mạng. WorkManager sẽ tự động retry...")
            Result.retry()
        } else {
            Log.i(TAG, "Tất cả thông báo đã được xử lý xong.")
            Result.success()
        }
    }

    companion object {
        private const val TAG = "MomoSyncWorker"
        private const val WORK_NAME = "momo_sync_worker_queue"

        /**
         * Kích hoạt hàng đợi gửi lại ngay lập tức hoặc khi có mạng
         */
        fun enqueueSync(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val workRequest = OneTimeWorkRequestBuilder<NotificationSyncWorker>()
                .setConstraints(constraints)
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    10,
                    TimeUnit.SECONDS
                )
                .build()

            WorkManager.getInstance(context).enqueueUniqueWork(
                WORK_NAME,
                ExistingWorkPolicy.REPLACE,
                workRequest
            )
        }
    }
}
