# 🚀 MoMo Stream Alert – Backend Server

Hệ thống nhận thông báo chuyển khoản từ **MoMo cá nhân** qua luồng:
```
Android Notification Listener → Ubuntu Server → PostgreSQL → WebSocket → OBS Overlay & Admin Dashboard
```

---

## 📁 Cấu trúc thư mục (Giai đoạn 1)

```
momo-stream-alert/
├── docker-compose.yml          # 2 services: postgres + backend
├── Dockerfile                  # Node.js 20 Alpine image
├── .env                        # Biến môi trường (KHÔNG commit)
├── .env.example                # Template cấu hình
├── package.json
│
├── db/
│   └── init.sql                # Schema PostgreSQL: 3 bảng + view
│
├── src/
│   ├── server.js               # Express + Socket.io server chính
│   ├── middleware/
│   │   └── hmacAuth.js         # HMAC-SHA256 signature verification
│   └── services/
│       ├── momoParser.js       # Regex parser bóc tách notification MoMo
│       ├── database.js         # PostgreSQL pool + settings cache
│       └── logger.js           # Winston structured logging
│
├── tests/
│   └── parser.test.js          # 12+ Jest unit tests cho momoParser
│
└── scripts/
    └── test-webhook.js         # Script test HMAC webhook (9 test cases)
```

---

## ⚡ Khởi động nhanh

### Yêu cầu
- **Docker** & **Docker Compose** v2+
- **Node.js** >= 20 (chỉ để chạy test cục bộ)

### Bước 1: Cấu hình

```bash
# Sao chép và chỉnh sửa .env
cp .env.example .env

# Bắt buộc thay đổi các giá trị sau trước khi production:
# WEBHOOK_SECRET, ADMIN_PASSWORD, OBS_OVERLAY_TOKEN
```

### Bước 2: Khởi động Docker

```bash
# Build và chạy lần đầu
docker compose up -d --build

# Xem log real-time
docker compose logs -f backend

# Kiểm tra health
curl http://localhost:3000/health
```

### Bước 3: Cài và chạy unit test

```bash
npm install
npm run test:parser   # chỉ test parser (không cần DB)
npm test              # tất cả tests
```

### Bước 4: Test Webhook với script

```bash
# Đảm bảo Docker đang chạy, sau đó:
node scripts/test-webhook.js

# Verbose mode (xem đầy đủ request/response):
node scripts/test-webhook.js --verbose
```

---

## 🔑 API Reference

### `POST /api/v1/webhook/momo-notify`
Nhận notification từ Android app.

**Headers bắt buộc:**
| Header | Mô tả |
|--------|-------|
| `X-Signature` | HMAC-SHA256 của raw JSON body với `WEBHOOK_SECRET` |
| `X-Timestamp` | Unix milliseconds hiện tại (không lệch quá 5 phút) |
| `Content-Type` | `application/json` |

**Body:**
```json
{
  "notifId": "android_notif_id_12345",
  "packageName": "com.mservice.momotransfer",
  "rawTitle": "MoMo: Nhận tiền thành công",
  "rawText": "Bạn vừa nhận được 50.000đ từ NGUYEN VAN A (0901234567). Lời nhắn: Chuc ban. Mã GD: 12345678."
}
```

**Response kết quả:**
| `result` | HTTP | Ý nghĩa |
|---------|------|---------|
| `CREATED` | 201 | Donation mới, đã phát Socket.io |
| `DUPLICATE` | 200 | Trùng Mã GD, bỏ qua |
| `IGNORED` | 200 | Quảng cáo / thanh toán / không phải nhận tiền |
| `BELOW_MINIMUM` | 200 | Dưới ngưỡng min_donate_amount |
| `FAILED_REGEX` | 422 | Không parse được |

---

### `GET /api/v1/tts?text=...&lang=vi`
Proxy Google Translate TTS. OBS Browser Source dùng để phát giọng đọc mà không bị CORS.

```bash
curl "http://localhost:3000/api/v1/tts?text=Cảm+ơn+bạn+đã+donate" --output audio.mp3
```

---

### `GET /health`
Health check (không cần auth).

```bash
curl http://localhost:3000/health
```

---

## 🔐 Tính chữ ký HMAC (cho Android App)

```javascript
// JavaScript / Node.js
const crypto = require('crypto');
const body = JSON.stringify({ rawText: '...', packageName: '...' });
const ts   = Date.now().toString();
const sig  = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

fetch('http://SERVER:3000/api/v1/webhook/momo-notify', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Signature':  sig,
    'X-Timestamp':  ts,
  },
  body,
});
```

```kotlin
// Kotlin / Android
val body = """{"rawText":"...","packageName":"com.mservice.momotransfer"}"""
val ts   = System.currentTimeMillis().toString()
val mac  = Mac.getInstance("HmacSHA256")
mac.init(SecretKeySpec(WEBHOOK_SECRET.toByteArray(), "HmacSHA256"))
val sig  = mac.doFinal(body.toByteArray()).joinToString("") { "%02x".format(it) }
```

---

## 🎯 Socket.io Events

### OBS Overlay kết nối:
```javascript
const socket = io('http://SERVER:3000', {
  auth: { token: OBS_OVERLAY_TOKEN }
});

socket.on('new_donation', (data) => {
  // data = { id, senderName, amount, message, ttsText, alertDurationMs, ... }
  showAlert(data);
  // Sau khi hiện xong:
  socket.emit('alert_played', { donationId: data.id });
});
```

### Admin Dashboard kết nối:
```javascript
socket.emit('join_admin', { password: ADMIN_PASSWORD });
socket.on('new_donation', (data) => { /* real-time cập nhật */ });
```

---

## 🗄️ Database

### Kết nối trực tiếp PostgreSQL:
```bash
docker exec -it momo_alert_postgres psql -U momo_user -d momo_alert

# Xem donations:
SELECT id, sender_name, amount, message, alert_status, created_at
FROM donations ORDER BY created_at DESC LIMIT 10;

# Thống kê tổng hợp:
SELECT * FROM v_donation_summary;

# Raw logs (debug):
SELECT id, raw_text, parse_status, error_reason FROM raw_notification_logs
ORDER BY created_at DESC LIMIT 20;
```

---

## 🐛 Debug & Troubleshooting

```bash
# Xem log backend:
docker compose logs -f backend

# Restart service:
docker compose restart backend

# Rebuild hoàn toàn:
docker compose down && docker compose up -d --build

# Kiểm tra DB kết nối:
docker exec momo_alert_backend wget -qO- http://localhost:3000/health
```

---

## 📋 Roadmap

- [x] **Giai đoạn 1**: Docker, DB Schema, Core API, Regex Parser, HMAC Auth
- [ ] **Giai đoạn 2**: OBS Overlay HTML/CSS/JS (WebSocket client)
- [ ] **Giai đoạn 3**: Admin Dashboard (React hoặc vanilla JS)
- [ ] **Giai đoạn 4**: Android Notification Listener App (Kotlin)
- [ ] **Giai đoạn 5**: TTS nâng cao, hiệu ứng âm thanh custom, alerts queue
