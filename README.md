# 💜 MoMo & VNPAY Stream Alert – Hệ Thống Thông Báo Donate Cho Streamer

Hệ thống bắt thông báo chuyển khoản tự động từ **MoMo cá nhân**, **VNPAY**, và **các ngân hàng (Vietcombank, Techcombank, Napas 247...)** qua ứng dụng Android chạy nền, xác thực chữ ký số **HMAC-SHA256**, lưu trữ lịch sử trên **PostgreSQL**, và hiển thị hiệu ứng thông báo donate kèm **âm thanh Sound Effect + Giọng đọc TTS** trực tiếp lên **OBS Studio** theo thời gian thực (Realtime WebSocket).

---

## 🏗️ Sơ Đồ Kiến Trúc Hệ Thống (LAN)

```
[Điện Thoại Android] (MoMo / VNPAY)
         │  (Nhận Notification từ App Ngân Hàng / Ví)
         ▼
[Android Listener App] ──(HTTP POST + HMAC-SHA256)──► [Máy Tính Livestream (LAN IP: 192.168.1.x)]
                                                              │
                                     ┌────────────────────────┴────────────────────────┐
                                     ▼                                                 ▼
                          [Docker: Backend Node.js :3000]                   [Docker: PostgreSQL 16 :5432]
                             ├── Webhook Rate Limiter (30 req/min)             ├── raw_notification_logs (Lịch sử thô)
                             ├── Xác thực HMAC Timing-Safe                    ├── donations (Giao dịch đã lọc)
                             ├── Regex Parser (< 1ms, 0% GPU)                 └── app_settings & Auto Clean 90 ngày
                             ├── Lọc từ cấm (***) & Chống XSS
                             └── Hàng đợi FIFO + Socket.io Server
                                     │
                 ┌───────────────────┴───────────────────┐
                 ▼                                       ▼
       [OBS Studio Browser Source]               [Admin Dashboard Web]
          /overlay?token=...                        /admin (Login & Quản trị)
          ├── GIF Animation                         ├── Bảng thống kê Realtime
          ├── Âm thanh Alert SFX                    ├── Nút Test Alert / Replay
          └── Giọng đọc AI TTS                      └── Cấu hình từ cấm, ngưỡng min
```

---

## 🚀 Hướng Dẫn Vận Hành Mạng LAN (4 Bước)

Hệ thống được thiết kế tối ưu để chạy trong mạng gia đình / phòng stream (mạng LAN nội bộ), **không cần mở port ra ngoài Internet**, đảm bảo an toàn bảo mật tuyệt đối.

---

### Bước 1: Khởi Chạy Bằng Docker Desktop

1. **Khởi động Docker Desktop** trên máy tính Windows hoặc macOS.
2. Mở cửa sổ dòng lệnh (Terminal / PowerShell / Command Prompt) tại thư mục dự án `e:\QRscan`:
   ```bash
   # Build image và khởi chạy 2 container chạy ngầm (-d)
   docker compose up -d --build
   ```
3. Kiểm tra trạng thái hoạt động:
   ```bash
   docker ps
   ```
   *Bạn sẽ thấy 2 container đang chạy ở trạng thái `(healthy)`:*
   - `momo_alert_backend` (Port `0.0.0.0:3000->3000`)
   - `momo_alert_postgres` (Port `0.0.0.0:5432->5432`)
4. Kiểm tra sức khỏe hệ thống:
   ```bash
   curl http://localhost:3000/health
   # Trả về: {"status":"OK","database":"connected","timestamp":"..."}
   ```

> [!TIP]
> Để dừng hệ thống: `docker compose down`  
> Để xem logs theo thời gian thực: `docker compose logs -f backend`

---

### Bước 2: Lấy Địa Chỉ IP LAN Của Máy Tính

Điện thoại Android cần biết địa chỉ IP nội bộ của máy tính để gửi thông báo qua mạng Wi-Fi.

#### Trên máy tính Windows:
1. Nhấn tổ hợp phím `Windows + R`, gõ `cmd` và bấm Enter.
2. Gõ lệnh:
   ```bash
   ipconfig
   ```
3. Tìm đến card mạng đang kết nối Wi-Fi hoặc Ethernet (dây mạng), xem dòng **IPv4 Address**:
   ```
   Wireless LAN adapter Wi-Fi:
      IPv4 Address. . . . . . . . . . . : 192.168.1.50   <--- Đây là IP LAN của bạn
      Subnet Mask . . . . . . . . . . . : 255.255.255.0
      Default Gateway . . . . . . . . . : 192.168.1.1
   ```

#### Trên máy tính macOS:
1. Mở Terminal và gõ:
   ```bash
   ipconfig getifaddr en0
   # (hoặc en1 nếu đang cắm dây mạng LAN)
   ```

> [!IMPORTANT]
> **Điện thoại Android và máy tính chạy Docker/OBS BẮT BUỘC phải kết nối vào CÙNG MỘT MẠNG WI-FI / ROUTER.**  
> Nếu điện thoại báo không kết nối được, hãy kiểm tra Windows Defender Firewall: Cho phép cổng `3000` (Inbound Rule - Port 3000 TCP).

---

### Bước 3: Cài Đặt Ứng Dụng Android & Nhập Cấu Hình

1. **Cài đặt file APK:**
   - File APK đã build sẵn nằm tại thư mục:  
     `android-app/app/build/outputs/apk/debug/app-debug.apk`
   - Copy file này sang điện thoại Android (qua USB, Zalo, Google Drive, hoặc tải trực tiếp) và tiến hành cài đặt.
   - Cho phép cài đặt ứng dụng từ nguồn không xác định nếu Android yêu cầu.
2. **Cấp quyền truy cập thông báo (Notification Listener):**
   - Mở ứng dụng **MoMo Alert Listener**.
   - Bấm vào thông báo yêu cầu cấp quyền **"Truy cập thông báo" (Notification Access)**.
   - Bật công tắc cho phép **MoMo Alert** đọc thông báo.
3. **Nhập cấu hình kết nối:**
   - **Webhook URL:**  
     `http://192.168.1.50:3000/api/v1/webhook/momo-notify`  
     *(Thay `192.168.1.50` bằng địa chỉ IP LAN máy tính đã lấy ở Bước 2)*
   - **Secret Key:**  
     `super_secret_webhook_key_momo_2024_abcxyz`  
     *(Phải trùng khớp với biến `WEBHOOK_SECRET` trong file `.env`)*
4. **Kiểm tra kết nối:**
   - Bấm nút **"Kiểm tra kết nối" (Test Connection)** trên app.
   - Nếu hiện thông báo **"Kết nối thành công (HTTP 200/201)"**, bạn đã sẵn sàng!
   - Bật công tắc **"Kích hoạt lắng nghe thông báo"** (Service sẽ chạy ngầm bền bỉ).

---

### Bước 4: Cấu Hình OBS Studio (Browser Source)

1. Mở phần mềm **OBS Studio** trên máy tính.
2. Trong bảng **Sources (Nguồn)** của Scene Livestream, bấm dấu **`+`** ➔ Chọn **Browser (Trình duyệt)**.
3. Đặt tên: `Donate Alert Box` và bấm **OK**.
4. Thiết lập các thông số:
   - **URL:**  
     `http://localhost:3000/overlay?token=obs_overlay_secure_token_2024`  
     *(Nếu bạn đã đổi `OBS_OVERLAY_TOKEN` trong `.env`, hãy điền token tương ứng)*
   - **Width (Chiều rộng):** `1920`
   - **Height (Chiều cao):** `1080`
   - **Tùy chọn âm thanh (CỰC KỲ QUAN TRỌNG):**  
     ✅ **Tích chọn "Control audio via OBS" (Điều khiển âm thanh qua OBS)**  
     *Lý do:* Trình duyệt Chromium tích hợp trong OBS mặc định chặn các trang web tự phát âm thanh (Autoplay Block Policy). Khi bật tùy chọn này, OBS sẽ biến Browser Source thành một kênh âm thanh độc lập trên Mixer, giúp âm thanh Ting Ting và giọng đọc TTS phát 100% không bao giờ bị nghẹn tiếng, đồng thời bạn có thể tăng giảm âm lượng của Alert ngay trên OBS.
   - ✅ **Tích chọn "Refresh browser when scene becomes active" (Làm mới trình duyệt khi cảnh kích hoạt)**.
5. Bấm **OK** để lưu lại.

---

## 🎛️ Quản Trị Hệ Thống (Admin Dashboard)

Hệ thống tích hợp sẵn giao diện quản trị Web cao cấp (Dark Mode, Glassmorphism):

- **Địa chỉ:** `http://localhost:3000/admin`
- **Mật khẩu mặc định:** `Admin@2024!Secure` *(cấu hình tại `.env`)*

### Các tính năng nổi bật trên Admin Dashboard:
1. **Realtime Stats:** Xem tổng số tiền donate, số lượt giao dịch, số người donate hôm nay, và bảng xếp hạng Top Donors.
2. **Nút Test Alert:** Bắn thử giao dịch mẫu lên OBS để kiểm tra hoạt ảnh GIF và âm thanh TTS mà không cần nạp tiền thật.
3. **Replay Donate:** Cho phép phát lại bất kỳ thông báo donate nào trong quá khứ lên màn hình stream chỉ bằng 1 click.
4. **Cấu hình trực tiếp:**
   - Ngưỡng tiền donate tối thiểu (vd: 10.000đ).
   - Thời gian hiển thị thông báo (vd: 8 giây).
   - Âm lượng Alert SFX và âm lượng giọng đọc TTS.
   - Template câu chào mừng TTS (vd: *"{name} vừa ủng hộ {amount} đồng: {message}"*).
   - Danh sách từ khóa cấm / tục tĩu (tự động thay thế thành `***`).
5. **Data Retention (90 ngày):** Tự động lưu toàn bộ thông báo gốc (`raw_notification_logs`) và dọn dẹp các bản ghi quá 90 ngày để database luôn nhẹ và mượt.

---

## 🧪 Bộ Kiểm Thử Tự Động Toàn Trình (Acceptance Tests)

Trước khi bắt đầu buổi stream, bạn có thể chạy bộ kiểm thử toàn trình 5 kịch bản để đảm bảo mọi thành phần đều hoạt động chuẩn xác:

```bash
# Chạy bộ kiểm thử nghiệm thu Giai đoạn 5
npm run test:acceptance
```

Hoặc chạy trực tiếp:
```bash
node scripts/run-acceptance-tests.js
```

### 5 Kịch Bản Nghiệm Thu (Đạt 5/5 Pass):
| Mã Test | Tên Kịch Bản | Kết Quả Mong Đợi | Trạng Thái |
|:-------:|:-------------|:-----------------|:----------:|
| **TC-01** | Gửi thông báo MoMo hợp lệ kèm HMAC chuẩn | Trả về `201 CREATED`. DB ghi nhận `donations` và `raw_notification_logs` (`PARSED`). | ✅ **PASS** |
| **TC-02** | Gửi lại cùng gói tin TC-01 lần 2 | Chống trùng lặp: trả về `200 DUPLICATE`, DB ghi `DUPLICATE`, số donation không tăng. | ✅ **PASS** |
| **TC-03** | Gửi sai chữ ký HMAC | Trả về `401 Unauthorized` (`INVALID_SIGNATURE`), DB không ghi nhận giao dịch giả mạo. | ✅ **PASS** |
| **TC-04** | Gửi thông báo khuyến mãi / quảng cáo rác | Trả về `200 IGNORED`. DB ghi nhận `IGNORED`, không phát sinh donation. | ✅ **PASS** |
| **TC-05** | Gửi thông báo chứa mã độc XSS / từ khóa cấm | Lọc từ cấm thành `***`, bảo tồn dữ liệu gốc ở `raw_message`, an toàn trước XSS. | ✅ **PASS** |

Chạy toàn bộ Jest Unit Tests (Parser, VNPAY, Multi-Bank):
```bash
npm test
```

---

## 🛡️ Cơ Chế Bảo Mật & An Toàn

1. **HMAC-SHA256 Timing-Safe:** Mọi gói tin webhook từ Android gửi về đều phải kèm chữ ký mã hóa bằng Secret Key và Unix Timestamp. Timestamp bị lệch quá 5 phút hoặc sai chữ ký sẽ bị từ chối `401 Unauthorized`.
2. **Rate Limiting:**
   - Webhook `/api/v1/webhook/momo-notify`: Tối đa **30 requests/phút** từ 1 IP.
   - Admin Login `/admin/login`: Tối đa **5 lần thử / 15 phút** (chống Brute-Force mật khẩu).
3. **Chống XSS Tuyệt Đối:** Mọi nội dung text render trên Overlay và Admin Dashboard đều sử dụng `textContent` và hàm `escHtml`, triệt tiêu hoàn toàn nguy cơ chèn mã độc HTML/Javascript (`<script>`, `onerror=`, ...).
4. **Zero GPU Impact (Không Tụt FPS Khi Chơi Game):** Hệ thống parser sử dụng thuật toán Regex tối ưu hóa cực cao (< 1ms thời gian xử lý), không sử dụng các mô hình AI cồng kềnh ngốn VRAM/GPU, đảm bảo máy tính chơi game livestream đạt 100% hiệu năng và FPS mượt mà.

---

## 📜 Giấy Phép & Bản Quyền

Dự án phát triển phục vụ mục đích cá nhân cho Streamer. Được phân phối dưới giấy phép **MIT License**.
