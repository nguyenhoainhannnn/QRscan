package com.momo.streamalert.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface NotificationDao {

    @Query("SELECT * FROM notification_items ORDER BY createdAt DESC LIMIT 30")
    fun getRecentNotifications(): Flow<List<NotificationItem>>

    @Query("SELECT * FROM notification_items WHERE status = 'PENDING' ORDER BY createdAt ASC")
    suspend fun getPendingNotifications(): List<NotificationItem>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(item: NotificationItem): Long

    @Update
    suspend fun update(item: NotificationItem)

    @Query("UPDATE notification_items SET status = :status, errorReason = :error, retryCount = retryCount + 1 WHERE id = :id")
    suspend fun updateStatus(id: Long, status: String, error: String? = null)

    @Query("DELETE FROM notification_items WHERE status = 'SUCCESS' AND createdAt < :threshold")
    suspend fun cleanOldSuccessItems(threshold: Long)
}
