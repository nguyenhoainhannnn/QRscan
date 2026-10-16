package com.momo.streamalert

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.LinearLayoutManager
import com.momo.streamalert.data.AppDatabase
import com.momo.streamalert.data.NotificationItem
import com.momo.streamalert.databinding.ActivityMainBinding
import com.momo.streamalert.service.MomoNotificationListenerService
import com.momo.streamalert.ui.NotificationAdapter
import com.momo.streamalert.util.PrefsManager
import com.momo.streamalert.worker.NotificationSyncWorker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: PrefsManager
    private val adapter = NotificationAdapter()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        prefs = PrefsManager(this)

        setupRecyclerView()
        loadConfig()
        setupListeners()
        observeNotifications()
    }

    override fun onResume() {
        super.onResume()
        updatePermissionStatus()
    }

    private fun setupRecyclerView() {
        binding.rvNotifications.layoutManager = LinearLayoutManager(this)
        binding.rvNotifications.adapter = adapter
    }

    private fun loadConfig() {
        binding.etServerUrl.setText(prefs.serverUrl)
        binding.etSecretKey.setText(prefs.secretKey)
    }

    private fun setupListeners() {
        // Nút Cấp quyền đọc thông báo (Notification Listener Service)
        binding.btnGrantNotifPermission.setOnClickListener {
            val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
            startActivity(intent)
        }

        // Nút Yêu cầu bỏ qua tối ưu hóa pin (Chạy ngầm liên tục)
        binding.btnIgnoreBattery.setOnClickListener {
            requestIgnoreBatteryOptimization()
        }

        // Nút Lưu cấu hình IP LAN & Secret Key
        binding.btnSaveConfig.setOnClickListener {
            val url = binding.etServerUrl.text?.toString()?.trim() ?: ""
            val secret = binding.etSecretKey.text?.toString()?.trim() ?: ""

            if (url.isEmpty()) {
                Toast.makeText(this, "Vui lòng nhập Server URL hợp lệ", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            prefs.serverUrl = url
            prefs.secretKey = secret
            Toast.makeText(this, getString(R.string.toast_config_saved), Toast.LENGTH_SHORT).show()
        }

        // Nút Gửi thông báo Test giả lập (Click: VNPAY, Giữ: MoMo)
        binding.btnSendTest.setOnClickListener {
            sendSimulatedTestNotification(isVnpay = true)
        }
        binding.btnSendTest.setOnLongClickListener {
            sendSimulatedTestNotification(isVnpay = false)
            true
        }
    }

    /**
     * Bắn 1 thông báo VNPAY hoặc MoMo giả lập để test ngay lập tức mà không cần đợi giao dịch thật
     */
    private fun sendSimulatedTestNotification(isVnpay: Boolean = true) {
        val randomAmount = (5..50).random() * 1000
        val formattedAmount = "%,d".format(randomAmount).replace(',', '.')
        val banks = listOf("Techcombank", "Vietcombank", "MBBank", "ACB", "VPBank")
        val bank = banks.random()
        val accMasked = (1000..9999).random()
        val messages = listOf("tien nuoc", "ung ho streamer", "cafe buoi sang", "chuc stream vui ve", "donate vui ve")
        val msg = messages.random()
        val ftId = "FT26${(100000000000L..999999999999L).random()}"

        val sampleText = if (isVnpay) {
            when ((1..3).random()) {
                1 -> {
                    // Mẫu 1: Vietcombank -> VNPAY (chuẩn mẫu Vietcombank Napas)
                    val vcbCode = (10000000000L..99999999999L).random()
                    val donorName = listOf("NGUYEN HOAI NHAN", "LE THI MAI", "TRAN VAN MINH", "HOANG DUC ANH").random()
                    "Thời gian giao dịch 16/10/2026 21:18\n" +
                    "Số tiền giao dịch +$formattedAmount VND\n" +
                    "Số dư cuối 38.000 VND\n" +
                    "Nội dung Nhan tien: Vietcombank - **********$accMasked: MBVCB.$vcbCode.6289BFTVGL.$msg.CT tu 0441000784711 $donorName toi 0783694473 NGUYEN HOAI NHAN tai VNPAY"
                }
                2 -> {
                    // Mẫu 2: Techcombank -> VNPAY
                    "Thời gian giao dịch: 16/10/2026 20:49\n" +
                    "Số tiền giao dịch: + $formattedAmount VNĐ\n" +
                    "Số dư cuối: 28.000 VNĐ\n" +
                    "Nội dung: Nhan tien: Techcombank _ **********$accMasked: $msg\n" +
                    ftId
                }
                else -> {
                    // Mẫu 3: Ví VNPAY to VNPAY
                    val donorName = listOf("PHAM DUC DUY", "VO THI TUYET", "NGUYEN VAN A", "TRAN THI B").random()
                    "Thời gian giao dịch: 16/10/2026 21:30\n" +
                    "Số tiền giao dịch: +$formattedAmount VND\n" +
                    "Số dư cuối: 128.000 VND\n" +
                    "Nội dung: $donorName chuyen tien: $msg\n" +
                    ftId
                }
            }
        } else {
            "Bạn vừa nhận được ${formattedAmount}đ từ $bank. Lời nhắn: $msg. Mã GD: ${(1000000000L..9999999999L).random()}"
        }

        val testItem = NotificationItem(
            notifId = "test_${System.currentTimeMillis()}",
            packageName = if (isVnpay) MomoNotificationListenerService.VNPAY_PACKAGE_NAME else MomoNotificationListenerService.MOMO_PACKAGE_NAME,
            rawTitle = if (isVnpay) "Ứng dụng VNPAY" else "Giao dịch thành công",
            rawText = sampleText,
            deviceTimestamp = System.currentTimeMillis(),
            status = NotificationItem.STATUS_PENDING
        )

        lifecycleScope.launch(Dispatchers.IO) {
            val db = AppDatabase.getInstance(applicationContext)
            db.notificationDao().insert(testItem)
            NotificationSyncWorker.enqueueSync(applicationContext)

            withContext(Dispatchers.Main) {
                val label = if (isVnpay) "VNPAY (+ $formattedAmount VNĐ)" else "MoMo (+${formattedAmount}đ)"
                Toast.makeText(this@MainActivity, "Đã gửi test $label! (Nhấn giữ để test MoMo)", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /**
     * Lắng nghe biến động danh sách 30 thông báo gần nhất từ Room Database qua Flow
     */
    private fun observeNotifications() {
        val db = AppDatabase.getInstance(this)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                db.notificationDao().getRecentNotifications().collect { list ->
                    adapter.submitList(list)

                    binding.tvCountBadge.text = "${list.size} mục"
                    if (list.isEmpty()) {
                        binding.tvEmptyState.visibility = View.VISIBLE
                        binding.rvNotifications.visibility = View.GONE
                    } else {
                        binding.tvEmptyState.visibility = View.GONE
                        binding.rvNotifications.visibility = View.VISIBLE
                    }
                }
            }
        }
    }

    /**
     * Kiểm tra và hiển thị trực quan trạng thái cấp quyền của Android
     */
    private fun updatePermissionStatus() {
        val isNotifPermissionGranted = isNotificationServiceEnabled()
        if (isNotifPermissionGranted) {
            binding.tvNotifPermissionStatus.text = getString(R.string.status_permission_granted)
            binding.tvNotifPermissionStatus.setTextColor(ContextCompat.getColor(this, R.color.status_success))
            binding.btnGrantNotifPermission.text = "Đã bật"
            binding.btnGrantNotifPermission.isEnabled = false

            binding.tvServiceRunningBadge.text = "Đang chạy"
            binding.tvServiceRunningBadge.setBackgroundResource(R.drawable.bg_badge_success)
            binding.tvServiceRunningBadge.setTextColor(ContextCompat.getColor(this, R.color.status_success))
        } else {
            binding.tvNotifPermissionStatus.text = getString(R.string.status_permission_denied)
            binding.tvNotifPermissionStatus.setTextColor(ContextCompat.getColor(this, R.color.status_failed))
            binding.btnGrantNotifPermission.text = "Cấp quyền"
            binding.btnGrantNotifPermission.isEnabled = true

            binding.tvServiceRunningBadge.text = "Chờ cấp quyền"
            binding.tvServiceRunningBadge.setBackgroundResource(R.drawable.bg_badge_pending)
            binding.tvServiceRunningBadge.setTextColor(ContextCompat.getColor(this, R.color.status_pending))
        }

        val isBatteryIgnored = isIgnoringBatteryOptimizations()
        if (isBatteryIgnored) {
            binding.tvBatteryStatus.text = getString(R.string.status_battery_ignored)
            binding.tvBatteryStatus.setTextColor(ContextCompat.getColor(this, R.color.status_success))
            binding.btnIgnoreBattery.text = "Đã tối ưu"
            binding.btnIgnoreBattery.isEnabled = false
        } else {
            binding.tvBatteryStatus.text = getString(R.string.status_battery_optimizing)
            binding.tvBatteryStatus.setTextColor(ContextCompat.getColor(this, R.color.status_pending))
            binding.btnIgnoreBattery.text = "Tắt tối ưu pin"
            binding.btnIgnoreBattery.isEnabled = true
        }
    }

    private fun isNotificationServiceEnabled(): Boolean {
        val packageNames = NotificationManagerCompat.getEnabledListenerPackages(this)
        return packageNames.contains(packageName)
    }

    private fun isIgnoringBatteryOptimizations(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            return pm.isIgnoringBatteryOptimizations(packageName)
        }
        return true
    }

    @SuppressLint("BatteryLife")
    private fun requestIgnoreBatteryOptimization() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val intent = Intent().apply {
                action = Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
                data = Uri.parse("package:$packageName")
            }
            try {
                startActivity(intent)
            } catch (e: Exception) {
                // Fallback nếu hãng điện thoại tùy biến chặn intent trực tiếp
                val fallbackIntent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                startActivity(fallbackIntent)
            }
        }
    }
}
