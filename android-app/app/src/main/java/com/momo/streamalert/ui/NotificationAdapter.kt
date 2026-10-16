package com.momo.streamalert.ui

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.momo.streamalert.R
import com.momo.streamalert.data.NotificationItem
import com.momo.streamalert.databinding.ItemNotificationBinding
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class NotificationAdapter :
    ListAdapter<NotificationItem, NotificationAdapter.NotificationViewHolder>(DiffCallback) {

    private val dateFormat = SimpleDateFormat("HH:mm:ss - dd/MM/yyyy", Locale.getDefault())

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): NotificationViewHolder {
        val binding = ItemNotificationBinding.inflate(
            LayoutInflater.from(parent.context),
            parent,
            false
        )
        return NotificationViewHolder(binding)
    }

    override fun onBindViewHolder(holder: NotificationViewHolder, position: Int) {
        holder.bind(getItem(position))
    }

    inner class NotificationViewHolder(
        private val binding: ItemNotificationBinding
    ) : RecyclerView.ViewHolder(binding.root) {

        fun bind(item: NotificationItem) {
            val context = binding.root.context

            binding.tvTitle.text = if (!item.rawTitle.isNullOrBlank()) {
                item.rawTitle
            } else if (item.packageName?.contains("vnpay", ignoreCase = true) == true) {
                "Ứng dụng VNPAY"
            } else {
                "Thông báo MoMo"
            }

            binding.tvContent.text = item.rawText
            binding.tvTime.text = dateFormat.format(Date(item.createdAt))
            binding.tvRetryCount.text = "Lần thử: ${item.retryCount}"

            // Trạng thái Badge
            when (item.status) {
                NotificationItem.STATUS_SUCCESS -> {
                    binding.tvStatusBadge.text = "Thành công"
                    binding.tvStatusBadge.setBackgroundResource(R.drawable.bg_badge_success)
                    binding.tvStatusBadge.setTextColor(ContextCompat.getColor(context, R.color.status_success))
                }
                NotificationItem.STATUS_PENDING -> {
                    binding.tvStatusBadge.text = "Đang chờ retry"
                    binding.tvStatusBadge.setBackgroundResource(R.drawable.bg_badge_pending)
                    binding.tvStatusBadge.setTextColor(ContextCompat.getColor(context, R.color.status_pending))
                }
                NotificationItem.STATUS_FAILED -> {
                    binding.tvStatusBadge.text = "Thất bại"
                    binding.tvStatusBadge.setBackgroundResource(R.drawable.bg_badge_failed)
                    binding.tvStatusBadge.setTextColor(ContextCompat.getColor(context, R.color.status_failed))
                }
            }

            // Hiển thị lý do lỗi nếu có
            if (!item.errorReason.isNullOrBlank() && item.status != NotificationItem.STATUS_SUCCESS) {
                binding.tvErrorReason.visibility = View.VISIBLE
                binding.tvErrorReason.text = item.errorReason
            } else {
                binding.tvErrorReason.visibility = View.GONE
            }
        }
    }

    companion object {
        private val DiffCallback = object : DiffUtil.ItemCallback<NotificationItem>() {
            override fun areItemsTheSame(oldItem: NotificationItem, newItem: NotificationItem): Boolean {
                return oldItem.id == newItem.id
            }

            override fun areContentsTheSame(oldItem: NotificationItem, newItem: NotificationItem): Boolean {
                return oldItem == newItem
            }
        }
    }
}
