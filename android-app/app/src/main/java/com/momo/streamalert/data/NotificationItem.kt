package com.momo.streamalert.data

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Entity lưu trữ thông báo MoMo trên thiết bị Android
 * Dùng làm nguồn dữ liệu cho hàng đợi retry qua WorkManager
 */
@Entity(tableName = "notification_items")
data class NotificationItem(
    @PrimaryKey(autoGenerate = true)
    val id: Long = 0,

    val notifId: String?,
    val packageName: String,
    val rawTitle: String?,
    val rawText: String,
    val deviceTimestamp: Long,

    // Trạng thái: "PENDING" (chờ gửi / retry), "SUCCESS" (đã gửi thành công 200), "FAILED" (lỗi 4xx)
    val status: String = STATUS_PENDING,

    val retryCount: Int = 0,
    val errorReason: String? = null,
    val createdAt: Long = System.currentTimeMillis()
) {
    companion object {
        const val STATUS_PENDING = "PENDING"
        const val STATUS_SUCCESS = "SUCCESS"
        const val STATUS_FAILED  = "FAILED"
    }
}
