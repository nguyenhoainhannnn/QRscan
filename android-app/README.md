# 📱 MoMo Stream Alert – Android Client App

Ứng dụng Android chạy ngầm sử dụng **`NotificationListenerService`** để tự động đọc thông báo biến động số dư từ app **MoMo** (`com.mservice.momotransfer`), ký bảo mật **HMAC-SHA256** và gửi trực tiếp qua mạng **LAN nội bộ** về máy chủ Docker Desktop (`POST /api/v1/webhook/momo-notify`).

---

## 🌟 Tính năng nổi bật

1. **Lắng nghe thông báo MoMo 24/7:**
   - Chạy **Foreground Service** với notification thường trực trên thanh trạng thái, ngăn Android tự động kill app.
   - Tự động trích xuất thông tin: Tiêu đề, nội dung đầy đủ (`EXTRA_BIG_TEXT`), thời gian và ID thông báo.
2. **Ký số HMAC-SHA256:**
   - Ký payload bằng `WEBHOOK_SECRET` gắn vào Header `X-Signature` và `X-Timestamp` (chống giả mạo và chống replay attack).
3. **Hàng đợi Retry tự động (WorkManager + Room DB):**
   - Nếu mất Wi-Fi hoặc máy tính tắt Docker Server, thông báo được lưu an toàn trong cơ sở dữ liệu SQLite cục bộ (Room DB).
   - Tự động gửi lại theo cơ chế **Exponential Backoff** ngay khi kết nối mạng được phục hồi.
4. **Tối ưu mạng LAN nội bộ:**
   - Cấu hình file `network_security_config.xml` cho phép kết nối Cleartext HTTP nội bộ (`192.168.x.x:3000`).
5. **Giao diện quản lý trực quan:**
   - Kiểm tra và cấp quyền Notification Listener + Tắt tối ưu hóa pin chỉ với 1 chạm.
   - Tùy chỉnh IP LAN của máy tính và Secret Key.
   - Nút **[Gửi Test về Server]** giả lập thông báo MoMo để kiểm thử kết nối LAN ngay lập tức.
   - Danh sách 30 thông báo gần nhất với huy hiệu màu sắc trực quan: `Thành công` (Xanh), `Đang chờ retry` (Vàng cam), `Thất bại` (Đỏ).

---

## 🛠️ Yêu cầu môi trường

- **Hệ điều hành Android:** Android 8.0 (API 26) trở lên.
- **Môi trường phát triển:** [Android Studio Hedgehog / Iguana / Jellyfish trở lên](https://developer.android.com/studio) (khuyến nghị).
- **JDK:** Java 17 trở lên.

---

## 📦 Hướng dẫn Build File `.apk`

### Cách 1: Build bằng Android Studio (Khuyến nghị - Nhanh nhất)

1. Mở phần mềm **Android Studio**.
2. Chọn **File** ➔ **Open...** và duyệt đến thư mục:
   ```
   E:\QRscan\android-app
   ```
3. Đợi Android Studio hoàn tất quá trình tải thư viện và đồng bộ Gradle (**Gradle Sync**).
4. Để xuất file `.apk`:
   - Trên thanh menu trên cùng, chọn:
     **Build** ➔ **Build Bundle(s) / APK(s)** ➔ **Build APK(s)**.
5. Sau khi quá trình build hoàn tất (khoảng 1–2 phút), ở góc dưới bên phải màn hình sẽ xuất hiện thông báo:
   > *APK(s) generated successfully.*
6. Bấm vào chữ **`locate`** trên thông báo đó để mở thư mục chứa file APK vừa build:
   ```
   android-app/app/build/outputs/apk/debug/app-debug.apk
   ```

---

### Cách 2: Build bằng dòng lệnh (Terminal / Command Prompt)

Nếu máy tính của bạn đã cài đặt JDK 17:

1. Mở PowerShell hoặc CMD tại thư mục `E:\QRscan\android-app`.
2. Chạy lệnh:
   - **Trên Windows:**
     ```powershell
     .\gradlew.bat assembleDebug
     ```
   - **Trên macOS / Linux:**
     ```bash
     chmod +x gradlew
     ./gradlew assembleDebug
     ```
3. File APK sẽ được tạo tại:
   ```
   app/build/outputs/apk/debug/app-debug.apk
   ```

---

## 📲 Hướng dẫn Cài đặt & Cấu hình trên Điện thoại

### Bước 1: Chuyển file APK sang điện thoại
Bạn có thể chuyển file `app-debug.apk` vào điện thoại bằng bất kỳ cách nào sau đây:
- Cắm dây cáp sạc USB kết nối điện thoại với máy tính, chép file vào thư mục `Download` của điện thoại.
- Hoặc gửi file qua **Zalo / Telegram / Google Drive**.

### Bước 2: Cài đặt ứng dụng
1. Mở trình quản lý tệp trên điện thoại và bấm vào file `app-debug.apk`.
2. Nếu điện thoại hỏi *"Cho phép cài đặt ứng dụng từ nguồn này"*, hãy bật **Cho phép (Allow)**.
3. Bấm **Cài đặt (Install)** và hoàn tất.

### Bước 3: Cấp 2 quyền quan trọng trong ứng dụng
Khi mở app **MoMo Stream Alert** lần đầu:
1. **Cấp quyền đọc thông báo (Notification Listener):**
   - Bấm nút **[Cấp quyền]** màu hồng.
   - Hệ thống sẽ mở cài đặt *Truy cập thông báo*. Tìm ứng dụng **MoMo Stream Alert** và gạt công tắc sang **Bật**.
   - Bấm nút Back quay lại ứng dụng ➔ Trạng thái sẽ chuyển sang màu xanh: **Đã cấp quyền**.
2. **Tắt tối ưu hóa pin (Chạy ngầm):**
   - Bấm nút **[Tắt tối ưu pin]**.
   - Khi có hộp thoại hiện lên hỏi *“Cho phép ứng dụng luôn chạy ngầm?”*, chọn **Cho phép (Allow)**.
   - *(Lưu ý trên điện thoại Xiaomi/Oppo/Vivo: Bạn nên vào cài đặt ứng dụng bật thêm quyền **Tự khởi chạy (Autostart)** và khóa ứng dụng trong danh sách đa nhiệm).*

---

## 🔗 Cấu hình kết nối Mạng LAN với Máy tính

Để điện thoại gửi được dữ liệu về máy tính, **điện thoại và máy tính phải bắt chung 1 mạng Wi-Fi tại nhà**.

1. **Tìm địa chỉ IP LAN của máy tính Windows:**
   - Mở PowerShell trên máy tính và gõ:
     ```powershell
     ipconfig
     ```
   - Tìm dòng **IPv4 Address** của card Wi-Fi hoặc Ethernet, ví dụ: `192.168.1.50`.

2. **Nhập cấu hình trên App Android:**
   - **Server Webhook URL:**
     ```
     http://192.168.1.50:3000/api/v1/webhook/momo-notify
     ```
     *(Thay `192.168.1.50` bằng IP thực tế của máy bạn, cổng mặc định là `3000`)*.
   - **HMAC Secret Key:**
     Điền giá trị `WEBHOOK_SECRET` trong file `.env` của bạn (Mặc định: `super_secret_webhook_key_momo_2024_abcxyz`).
   - Bấm nút **[Lưu cấu hình]**.

3. **Kiểm thử kết nối ngay lập tức:**
   - Bấm nút **[Gửi Test về Server]**.
   - Màn hình sẽ hiển thị 1 thông báo MoMo giả lập trong danh sách bên dưới với trạng thái **Thành công** (màu xanh lá).
   - Kiểm tra màn hình máy tính:
     - **Admin Dashboard** (`http://localhost:3000/admin`): Thấy giao dịch mới xuất hiện tức thì!
     - **OBS Browser Source** (`http://localhost:3000/overlay?token=...`): Alert box nổ hiệu ứng và Google TTS đọc lời cảm ơn!

---

## 🛡️ Khắc phục sự cố thường gặp (Troubleshooting)

| Tình trạng | Nguyên nhân | Cách xử lý |
| :--- | :--- | :--- |
| Trạng thái báo **"Không thể kết nối máy chủ"** | Tường lửa (Windows Firewall) chặn cổng 3000 | Mở PowerShell quyền Admin trên Windows và chạy lệnh mở port: `netsh advfirewall firewall add rule name="MoMo Alert Port 3000" dir=in action=allow protocol=TCP localport=3000` |
| Báo lỗi **HTTP 401: Invalid Signature** | Secret Key trên app Android không khớp với file `.env` trên máy | Kiểm tra lại ô `HMAC Secret Key` trên app phải trùng khớp 100% với `WEBHOOK_SECRET` trong file `.env` |
| Báo lỗi **HTTP 401: TIMESTAMP_EXPIRED** | Đồng hồ điện thoại lệch so với máy tính quá 5 phút | Vào Cài đặt ngày giờ trên điện thoại và chọn *"Tự động đồng bộ giờ theo mạng"* |
| App bị tắt ngầm sau khi tắt màn hình | Cơ chế tiết kiệm pin sâu của hãng điện thoại | Vào Cài đặt pin của máy ➔ chọn ứng dụng MoMo Stream Alert ➔ chọn "Không hạn chế pin" và bật "Tự khởi chạy (Autostart)" |
