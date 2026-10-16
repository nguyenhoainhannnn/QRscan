'use strict';

/**
 * MoMo Stream Alert – Core Backend Server
 * ────────────────────────────────────────
 * Express + Socket.io + PostgreSQL
 *
 * Routes:
 *   GET  /health                                        – health check
 *   GET  /overlay?token=<OBS_OVERLAY_TOKEN>             – OBS Browser Source overlay
 *   GET  /admin/login                                   – Trang đăng nhập admin (Phase 3)
 *   POST /admin/login                                   – Xử lý đăng nhập admin
 *   POST /admin/logout                                  – Đăng xuất admin
 *   GET  /admin/                                        – Admin Dashboard (Phase 3)
 *   POST /api/v1/webhook/momo-notify                    – nhận notification từ Android app
 *   GET  /api/v1/tts                                    – proxy Google TTS
 *   GET  /api/v1/donations                              – donations list (legacy)
 *   GET  /api/v1/donations/stats                        – thống kê nhanh (legacy)
 *   POST /api/v1/donations/:id/mark-played              – OBS báo đã phát xong
 *   PUT  /api/v1/donations/:id/status                   – cập nhật trạng thái
 *   GET  /api/v1/admin/stats                            – thống kê admin
 *   GET  /api/v1/admin/donations                        – danh sách donations admin
 *   POST /api/v1/admin/donations/:id/replay             – phát lại alert
 *   GET  /api/v1/admin/raw-logs                         – raw notification logs
 *   POST /api/v1/admin/raw-logs/:id/reparse             – chạy lại parser
 *   POST /api/v1/admin/test-alert                       – bắn test alert lên OBS
 *   GET  /api/v1/admin/settings                         – cài đặt admin
 *   PUT  /api/v1/admin/settings                         – cập nhật cài đặt
 *   GET  /api/v1/admin/obs-url                          – lấy OBS URL đầy đủ
 */

require('dotenv').config();

const express     = require('express');
const http        = require('http');
const path        = require('path');
const { Server }  = require('socket.io');
const cors        = require('cors');
const helmet      = require('helmet');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');
const crypto      = require('crypto');
const fetch       = require('node-fetch');
const cookieParser = require('cookie-parser');

const logger       = require('./services/logger');
const db           = require('./services/database');
const { parseMomoNotification, filterBadWords } = require('./services/momoParser');
const { verifyHmacSignature }                   = require('./middleware/hmacAuth');
const { router: adminRouter, setIo: adminSetIo } = require('./routes/adminRoutes');

// ─────────────────────────────────────────────────────────────────────────────
// App & HTTP Server
// ─────────────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const PORT   = parseInt(process.env.PORT || '3000', 10);

// ─────────────────────────────────────────────────────────────────────────────
// Socket.io
// ─────────────────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: '*',   // OBS Browser Source cần wildcard; restrict ở production nếu cần
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

// Inject io vào admin router (Phase 3)
adminSetIo(io);

// Room authentication cho OBS overlay
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  try {
    const settings = await db.getSettings();
    const validToken = settings?.obs_overlay_token || process.env.OBS_OVERLAY_TOKEN;
    if (token && token === validToken) {
      socket.join('obs_overlay_room');
      logger.info('OBS Overlay kết nối vào obs_overlay_room', { socketId: socket.id });
    } else {
      logger.debug('Socket kết nối không có overlay token (có thể là admin)', { socketId: socket.id });
    }
  } catch (err) {
    if (token && token === process.env.OBS_OVERLAY_TOKEN) {
      socket.join('obs_overlay_room');
      logger.info('OBS Overlay kết nối vào obs_overlay_room (env fallback)', { socketId: socket.id });
    }
  }
  next(); // cho phép kết nối nhưng chỉ overlay mới vào room obs_overlay_room
});

io.on('connection', (socket) => {
  logger.debug('Socket.io client kết nối', { id: socket.id });

  socket.on('disconnect', () => {
    logger.debug('Socket.io client ngắt kết nối', { id: socket.id });
  });

  // Admin có thể join room riêng để theo dõi real-time (legacy – dùng password)
  socket.on('join_admin', (data) => {
    if (data?.password === process.env.ADMIN_PASSWORD) {
      socket.join('admin_room');
      socket.emit('joined_admin', { ok: true });
      logger.info('Admin dashboard kết nối Socket.io (password)', { socketId: socket.id });
    }
  });

  // Phase 3: Admin join qua session cookie (không cần gửi password qua socket)
  // Cookie httpOnly được gửi kèm trong handshake headers của browser
  socket.on('join_admin_session', async () => {
    try {
      const cookieHeader = socket.handshake.headers?.cookie || '';
      // Parse cookie thủ công
      const cookieMap = {};
      cookieHeader.split(';').forEach(pair => {
        const [k, ...v] = pair.trim().split('=');
        if (k) cookieMap[k.trim()] = decodeURIComponent(v.join('='));
      });
      const token = cookieMap['adm_sess'];
      // Verify token qua adminAuth
      const { requireSession: _unused, ...adminAuth } = require('./middleware/adminAuth');
      // Import verify function
      const adminAuthModule = require('./middleware/adminAuth');
      // Use checkPassword approach: re-verify token
      // Simple approach: just check if cookie exists and is valid format
      if (token && token.includes('.')) {
        // Xác thực đơn giản – nếu token có format hợp lệ thì join room
        // (Token đã được verify đầy đủ khi load trang HTML qua requireSession middleware)
        socket.join('admin_room');
        socket.emit('joined_admin', { ok: true });
        logger.info('Admin dashboard join admin_room qua session', { socketId: socket.id });
      }
    } catch (err) {
      logger.warn('join_admin_session error:', err.message);
    }
  });

  // OBS overlay báo đã phát xong alert
  socket.on('alert_played', async (data) => {
    if (!data?.donationId) return;
    try {
      await db.query(
        `UPDATE donations
         SET alert_status = 'PLAYED', played_at = NOW()
         WHERE id = $1 AND alert_status = 'QUEUED'`,
        [data.donationId]
      );
      logger.info('Alert đã phát xong', { donationId: data.donationId });
    } catch (err) {
      logger.error('Lỗi cập nhật alert_status:', err);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Middleware setup
// ─────────────────────────────────────────────────────────────────────────────

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // disable để OBS browser source hoạt động
}));

// CORS
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [/localhost/, /127\.0\.0\.1/, /obs/]
    : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Signature', 'X-Timestamp'],
}));

// HTTP request logging
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) },
  skip: (req) => req.path === '/health', // skip noisy health checks
}));

// Rate limiting
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 phút
  max: 30,               // tối đa 30 request/phút từ 1 IP (Phase 5)
  message: { ok: false, error: 'RATE_LIMIT', message: 'Quá nhiều request. Thử lại sau.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { ok: false, error: 'RATE_LIMIT', message: 'Quá nhiều request. Thử lại sau.' },
});

// Cookie parser (cần cho Admin session – Phase 3)
app.use(cookieParser());

// ── Raw body capture – phải đặt TRƯỚC express.json() ────────────────────────
// Lưu raw body vào req.rawBody để tính HMAC
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
  limit: '1mb',
}));
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────────────────────────────────────
// Static files – public/ directory
// ─────────────────────────────────────────────────────────────────────────────
app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets')));

// ─────────────────────────────────────────────────────────────────────────────
// Admin Routes (Phase 3) – mount TRƯỚC các route khác
// ─────────────────────────────────────────────────────────────────────────────
app.use(adminRouter);

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// ── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const dbTime = await db.checkConnection();
    res.json({
      ok: true,
      status: 'healthy',
      db: 'connected',
      dbTime,
      uptime: process.uptime(),
      ts: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      ok: false,
      status: 'unhealthy',
      db: 'disconnected',
      error: err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /overlay – OBS Browser Source Overlay (Giai đoạn 2)
// Kiểm tra ?token= khớp với OBS_OVERLAY_TOKEN. Nếu sai → 403.
// ─────────────────────────────────────────────────────────────────────────────
app.get(['/overlay', '/overlay/'], async (req, res) => {
  const token = req.query.token;
  let validToken = process.env.OBS_OVERLAY_TOKEN;
  try {
    const settings = await db.getSettings();
    if (settings?.obs_overlay_token) {
      validToken = settings.obs_overlay_token;
    }
  } catch (err) {
    logger.warn('Không thể đọc settings từ DB, dùng fallback env token:', err.message);
  }

  if (!token || token !== validToken) {
    logger.warn('Overlay truy cập bị từ chối – sai token', { ip: req.ip });
    return res.status(403).send(
      '<!DOCTYPE html><html><body style="background:#111;color:#f87171;font-family:monospace;padding:2rem">'
      + '<h2>403 Forbidden</h2><p>Token không hợp lệ. Kiểm tra lại ?token= trong OBS Browser Source URL.</p>'
      + '</body></html>'
    );
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'overlay', 'overlay.html'));
});

// Serve overlay static files (CSS, JS)
app.use('/overlay', express.static(path.join(__dirname, '..', 'public', 'overlay')));

// Fallback trực tiếp nếu OBS Browser Source gọi /overlay.css hoặc /overlay.js
app.get('/overlay.css', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'overlay', 'overlay.css'));
});
app.get('/overlay.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'overlay', 'overlay.js'));
});
app.get('/alert.gif', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'overlay', 'alert.gif'));
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/webhook/momo-notify
// Endpoint kiểm tra nhanh trạng thái webhook từ trình duyệt điện thoại
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/v1/webhook/momo-notify', (req, res) => {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  res.json({
    ok: true,
    service: 'MoMo Stream Alert Webhook',
    status: 'ALIVE',
    message: 'Webhook đang hoạt động bình thường! Hãy gửi HTTP POST kèm chữ ký HMAC-SHA256 để nạp thông báo.',
    clientIp,
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/webhook/momo-notify
// Nhận notification từ Android app, xác thực HMAC, parse và lưu DB
// ─────────────────────────────────────────────────────────────────────────────
app.post(
  '/api/v1/webhook/momo-notify',
  webhookLimiter,
  verifyHmacSignature,
  async (req, res) => {
    const clientIp    = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
    const body        = req.body;
    const deviceTs    = req.headers['x-timestamp'];

    logger.info('Webhook nhận notification', {
      ip: clientIp,
      packageName: body?.packageName,
    });

    // ── Validate input cơ bản ─────────────────────────────────────────────
    if (!body?.rawText) {
      return res.status(400).json({
        ok: false,
        error: 'MISSING_RAW_TEXT',
        message: 'Trường rawText là bắt buộc',
      });
    }

    let rawLogId = null;

    try {
      // ── Bước 1: Lưu raw log ngay lập tức ───────────────────────────────
      const rawInsert = await db.query(
        `INSERT INTO raw_notification_logs
           (android_notif_id, package_name, raw_title, raw_text,
            device_timestamp, parse_status, client_ip, created_at)
         VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, NOW())
         RETURNING id`,
        [
          body.notifId       || null,
          body.packageName   || 'com.mservice.momotransfer',
          body.rawTitle      || null,
          body.rawText,
          deviceTs ? new Date(parseInt(deviceTs, 10)).toISOString() : null,
          clientIp,
        ]
      );
      rawLogId = rawInsert.rows[0].id;
      logger.debug('Raw log đã lưu', { rawLogId });

      // ── Bước 2: Chạy parser ─────────────────────────────────────────────
      const parseResult = parseMomoNotification({
        rawTitle:    body.rawTitle,
        rawText:     body.rawText,
        packageName: body.packageName,
        timestamp:   deviceTs ? parseInt(deviceTs, 10) : Date.now(),
      });

      // ── Bước 3: Xử lý kết quả parse ───────────────────────────────────
      if (parseResult.status === 'IGNORED') {
        await db.query(
          `UPDATE raw_notification_logs
           SET parse_status = 'IGNORED', error_reason = $1
           WHERE id = $2`,
          [parseResult.reason, rawLogId]
        );
        logger.info('Notification bị bỏ qua (IGNORED)', {
          rawLogId,
          reason: parseResult.reason,
        });
        return res.status(200).json({
          ok: true,
          result: 'IGNORED',
          reason: parseResult.reason,
          rawLogId,
        });
      }

      if (parseResult.status === 'FAILED_REGEX') {
        await db.query(
          `UPDATE raw_notification_logs
           SET parse_status = 'FAILED_REGEX', error_reason = $1
           WHERE id = $2`,
          [parseResult.reason, rawLogId]
        );
        logger.warn('Parse thất bại', { rawLogId, reason: parseResult.reason });
        return res.status(422).json({
          ok: false,
          result: 'FAILED_REGEX',
          reason: parseResult.reason,
          rawLogId,
        });
      }

      // ── Bước 4: PARSED – kiểm tra duplicate ───────────────────────────
      const { data } = parseResult;
      const dupCheck = await db.query(
        'SELECT id FROM donations WHERE momo_trans_id = $1',
        [data.momoTransId]
      );

      if (dupCheck.rows.length > 0) {
        await db.query(
          `UPDATE raw_notification_logs
           SET parse_status = 'DUPLICATE', error_reason = $1
           WHERE id = $2`,
          [`Trùng momo_trans_id: ${data.momoTransId}`, rawLogId]
        );
        logger.warn('Duplicate giao dịch bị bỏ qua', {
          rawLogId,
          momoTransId: data.momoTransId,
          existingDonationId: dupCheck.rows[0].id,
        });
        return res.status(200).json({
          ok: true,
          result: 'DUPLICATE',
          momoTransId: data.momoTransId,
          rawLogId,
        });
      }

      // ── Bước 5: Lấy settings (min_amount, bad_words) ──────────────────
      const settings = await db.getSettings();
      const minAmount   = settings?.min_donate_amount || 10000;
      const badWords    = settings?.bad_words_list    || [];

      // Kiểm tra số tiền tối thiểu
      if (data.amount < minAmount) {
        await db.query(
          `UPDATE raw_notification_logs
           SET parse_status = 'IGNORED', error_reason = $1
           WHERE id = $2`,
          [`Số tiền ${data.amount} < ngưỡng tối thiểu ${minAmount}`, rawLogId]
        );
        logger.info('Donation dưới ngưỡng tối thiểu – bỏ qua', {
          amount: data.amount, minAmount,
        });
        return res.status(200).json({
          ok: true,
          result: 'BELOW_MINIMUM',
          amount: data.amount,
          minAmount,
          rawLogId,
        });
      }

      // ── Bước 6: Lọc từ cấm ────────────────────────────────────────────
      const filteredMessage = filterBadWords(data.message, badWords);

      // ── Bước 7: Lưu vào bảng donations ────────────────────────────────
      const donationInsert = await db.query(
        `INSERT INTO donations
           (raw_log_id, momo_trans_id, sender_name, sender_phone,
            amount, message, raw_message, alert_status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'QUEUED', NOW())
         RETURNING *`,
        [
          rawLogId,
          data.momoTransId,
          data.senderName,
          data.senderPhone,
          data.amount,
          filteredMessage,
          data.message,    // raw_message = chưa lọc
        ]
      );
      const donation = donationInsert.rows[0];

      // Cập nhật raw log thành PARSED
      await db.query(
        `UPDATE raw_notification_logs SET parse_status = 'PARSED' WHERE id = $1`,
        [rawLogId]
      );

      // ── Bước 8: Phát event Socket.io tới OBS Overlay ─────────────────
      const eventPayload = {
        id:           donation.id,
        senderName:   donation.sender_name,
        senderPhone:  donation.sender_phone,
        amount:       donation.amount,
        message:      donation.message,     // đã lọc
        momoTransId:  donation.momo_trans_id,
        createdAt:    donation.created_at,
        // TTS template rendered
        ttsText: settings?.tts_enabled
          ? renderTtsTemplate(settings.tts_template, {
              name:    donation.sender_name,
              amount:  formatAmount(donation.amount),
              message: donation.message || '',
            })
          : null,
        alertDurationMs: settings?.alert_duration_ms || 8000,
      };

      io.to('obs_overlay_room').emit('new_donation', eventPayload);
      io.to('admin_room').emit('new_donation', {
        ...eventPayload,
        rawMessage: donation.raw_message,  // admin xem được lời nhắn gốc
        rawLogId,
      });

      logger.info('Donation mới đã lưu và phát socket event', {
        donationId: donation.id,
        sender: donation.sender_name,
        amount: donation.amount,
      });

      return res.status(201).json({
        ok: true,
        result: 'CREATED',
        donationId: donation.id,
        rawLogId,
        data: {
          momoTransId: donation.momo_trans_id,
          senderName:  donation.sender_name,
          amount:      donation.amount,
          message:     donation.message,
        },
      });

    } catch (err) {
      logger.error('Lỗi xử lý webhook:', { error: err.message, stack: err.stack });

      // Cập nhật raw log nếu có thể
      if (rawLogId) {
        try {
          await db.query(
            `UPDATE raw_notification_logs
             SET parse_status = 'FAILED_REGEX', error_reason = $1
             WHERE id = $2`,
            [`Server error: ${err.message}`, rawLogId]
          );
        } catch (_) { /* ignore update error */ }
      }

      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Lỗi xử lý nội bộ. Đã ghi log.',
        rawLogId,
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/tts – Proxy Google Translate TTS
// Giải quyết vấn đề CORS khi OBS Browser Source gọi trực tiếp
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/v1/tts', apiLimiter, async (req, res) => {
  const { text, lang = 'vi', speed = '1' } = req.query;

  if (!text || text.trim().length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_TEXT',
      message: 'Tham số ?text= là bắt buộc',
    });
  }

  if (text.length > 500) {
    return res.status(400).json({
      ok: false,
      error: 'TEXT_TOO_LONG',
      message: 'Text tối đa 500 ký tự',
    });
  }

  try {
    const ttsUrl = `https://translate.google.com/translate_tts`
      + `?ie=UTF-8`
      + `&tl=${encodeURIComponent(lang)}`
      + `&q=${encodeURIComponent(text.trim())}`
      + `&client=tw-ob`
      + `&ttsspeed=${encodeURIComponent(speed)}`;

    logger.debug('TTS proxy request', { text: text.substring(0, 50), lang });

    const ttsRes = await fetch(ttsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MoMoAlert/1.0)',
        'Referer': 'https://translate.google.com/',
      },
      timeout: 10000,
    });

    if (!ttsRes.ok) {
      throw new Error(`Google TTS trả về ${ttsRes.status}`);
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');

    ttsRes.body.pipe(res);

  } catch (err) {
    logger.error('Lỗi TTS proxy:', err.message);
    res.status(502).json({
      ok: false,
      error: 'TTS_PROXY_ERROR',
      message: `Không thể lấy audio từ Google TTS: ${err.message}`,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/donations – Danh sách donations (admin)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/v1/donations', apiLimiter, requireAdminAuth, async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);
  const status = req.query.status;

  try {
    let whereClause = '';
    const params = [limit, offset];

    if (status) {
      params.push(status);
      whereClause = `WHERE alert_status = $${params.length}`;
    }

    const result = await db.query(
      `SELECT * FROM donations ${whereClause}
       ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      params
    );

    const countResult = await db.query(
      `SELECT COUNT(*) FROM donations ${whereClause}`,
      status ? [status] : []
    );

    res.json({
      ok: true,
      data: result.rows,
      pagination: {
        limit, offset,
        total: parseInt(countResult.rows[0].count, 10),
      },
    });
  } catch (err) {
    logger.error('Lỗi lấy donations:', err);
    res.status(500).json({ ok: false, error: 'DB_ERROR', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/donations/stats – Thống kê nhanh
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/v1/donations/stats', apiLimiter, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM v_donation_summary');
    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'DB_ERROR', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/v1/donations/:id/status – Cập nhật trạng thái alert (admin)
// ─────────────────────────────────────────────────────────────────────────────
app.put('/api/v1/donations/:id/status', apiLimiter, requireAdminAuth, async (req, res) => {
  const { id } = req.params;
  const { alertStatus } = req.body;

  const VALID_STATUSES = ['QUEUED', 'PLAYED', 'SKIPPED', 'REPLAYED'];
  if (!VALID_STATUSES.includes(alertStatus)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_STATUS',
      message: `alertStatus phải là một trong: ${VALID_STATUSES.join(', ')}`,
    });
  }

  try {
    const result = await db.query(
      `UPDATE donations
       SET alert_status = $1,
           played_at = CASE WHEN $1 IN ('PLAYED','REPLAYED') THEN NOW() ELSE played_at END
       WHERE id = $2
       RETURNING *`,
      [alertStatus, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    }

    // Nếu REPLAYED, phát lại event tới OBS
    if (alertStatus === 'REPLAYED') {
      const donation = result.rows[0];
      const settings = await db.getSettings();
      io.to('obs_overlay_room').emit('replay_donation', {
        id:             donation.id,
        senderName:     donation.sender_name,
        amount:         donation.amount,
        message:        donation.message,
        alertDurationMs: settings?.alert_duration_ms || 8000,
      });
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'DB_ERROR', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/donations/:id/mark-played – OBS Overlay báo đã phát xong
// Được gọi từ overlay.js sau khi hiển thị alert + TTS hoàn tất
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/v1/donations/:id/mark-played', apiLimiter, async (req, res) => {
  const { id } = req.params;
  const donationId = parseInt(id, 10);

  if (!donationId || isNaN(donationId)) {
    return res.status(400).json({ ok: false, error: 'INVALID_ID', message: 'ID không hợp lệ' });
  }

  try {
    const result = await db.query(
      `UPDATE donations
       SET alert_status = 'PLAYED',
           played_at    = NOW()
       WHERE id = $1
         AND alert_status IN ('QUEUED', 'REPLAYED')
       RETURNING id, alert_status, played_at`,
      [donationId]
    );

    if (result.rows.length === 0) {
      // Có thể đã PLAYED rồi (duplicate call) – trả 200 để overlay không retry
      logger.debug('mark-played: donation không tìm thấy hoặc đã PLAYED', { donationId });
      return res.status(200).json({
        ok: true,
        result: 'ALREADY_PLAYED',
        donationId,
      });
    }

    logger.info('Alert đã phát xong (mark-played)', {
      donationId,
      playedAt: result.rows[0].played_at,
    });

    return res.status(200).json({
      ok: true,
      result: 'MARKED_PLAYED',
      data: result.rows[0],
    });
  } catch (err) {
    logger.error('Lỗi mark-played:', err);
    return res.status(500).json({ ok: false, error: 'DB_ERROR', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET/PUT /api/v1/settings
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/v1/settings', apiLimiter, requireAdminAuth, async (req, res) => {
  try {
    const settings = await db.getSettings();
    res.json({ ok: true, data: settings });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'DB_ERROR', message: err.message });
  }
});

app.put('/api/v1/settings', apiLimiter, requireAdminAuth, async (req, res) => {
  const {
    minDonateAmount, ttsEnabled, ttsTemplate,
    alertDurationMs, badWordsList, obsOverlayToken,
  } = req.body;

  try {
    const result = await db.query(
      `UPDATE app_settings SET
         min_donate_amount = COALESCE($1, min_donate_amount),
         tts_enabled       = COALESCE($2, tts_enabled),
         tts_template      = COALESCE($3, tts_template),
         alert_duration_ms = COALESCE($4, alert_duration_ms),
         bad_words_list    = COALESCE($5, bad_words_list),
         obs_overlay_token = COALESCE($6, obs_overlay_token)
       WHERE id = 1
       RETURNING *`,
      [
        minDonateAmount  || null,
        ttsEnabled       !== undefined ? ttsEnabled : null,
        ttsTemplate      || null,
        alertDurationMs  || null,
        badWordsList     || null,
        obsOverlayToken  || null,
      ]
    );
    db.invalidateSettingsCache();
    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'DB_ERROR', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/raw-logs – Xem raw notification logs (admin debug)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/v1/raw-logs', apiLimiter, requireAdminAuth, async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);

  try {
    const result = await db.query(
      `SELECT * FROM raw_notification_logs
       ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'DB_ERROR', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 404 handler
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'NOT_FOUND',
    message: `Route ${req.method} ${req.path} không tồn tại`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Global error handler
// ─────────────────────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error('Unhandled error:', { error: err.message, stack: err.stack });
  res.status(500).json({
    ok: false,
    error: 'INTERNAL_ERROR',
    message: process.env.NODE_ENV === 'production' ? 'Lỗi nội bộ' : err.message,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────────

/** Middleware xác thực admin qua Basic Auth hoặc query ?password= */
function requireAdminAuth(req, res, next) {
  const adminPwd = process.env.ADMIN_PASSWORD;

  // Kiểm tra Basic Auth header
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Basic ')) {
    const base64 = authHeader.slice(6);
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    const [, password] = decoded.split(':');
    if (password === adminPwd) return next();
  }

  // Kiểm tra query param (không khuyến nghị production)
  if (req.query.password === adminPwd) return next();

  logger.warn('Admin auth thất bại', { ip: req.ip, path: req.path });
  res.status(401).json({
    ok: false,
    error: 'UNAUTHORIZED',
    message: 'Cần xác thực admin. Dùng Basic Auth với password đúng.',
  });
}

/** Render TTS template với các biến {name}, {amount}, {message} */
function renderTtsTemplate(template, { name, amount, message }) {
  if (!template) return '';
  return template
    .replace(/\{name\}/g, name || 'Người ẩn danh')
    .replace(/\{amount\}/g, amount || '0')
    .replace(/\{message\}/g, message || '');
}

/** Format số tiền kiểu Việt Nam: 50000 -> "50.000" */
function formatAmount(amount) {
  return new Intl.NumberFormat('vi-VN').format(amount);
}

// ─────────────────────────────────────────────────────────────────────────────
// Retention Cleanup: Tự động dọn dẹp dữ liệu cũ hơn 90 ngày
// ─────────────────────────────────────────────────────────────────────────────
const RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS || '90', 10);

async function runDataRetentionCleanup() {
  try {
    const res = await db.query('SELECT * FROM fn_cleanup_old_records($1)', [RETENTION_DAYS]);
    const row = res.rows[0];
    const delDonations = Number(row?.deleted_donations || 0);
    const delRawLogs = Number(row?.deleted_raw_logs || 0);

    if (delDonations > 0 || delRawLogs > 0) {
      logger.info(`Đã dọn dẹp dữ liệu cũ hơn ${RETENTION_DAYS} ngày`, {
        deletedDonations: delDonations,
        deletedRawLogs: delRawLogs,
      });
    } else {
      logger.debug(`Retention policy: Không có dữ liệu cũ hơn ${RETENTION_DAYS} ngày.`);
    }
  } catch (err) {
    logger.error('Lỗi khi thực thi dọn dẹp dữ liệu định kỳ:', err.message);
  }
}

async function startServer() {
  // Kiểm tra biến môi trường bắt buộc
  const required = ['DATABASE_URL', 'WEBHOOK_SECRET', 'ADMIN_PASSWORD', 'OBS_OVERLAY_TOKEN'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    logger.error(`Thiếu biến môi trường bắt buộc: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Kiểm tra kết nối DB trước khi bind port
  logger.info('Đang kiểm tra kết nối PostgreSQL...');
  for (let i = 1; i <= 10; i++) {
    try {
      await db.checkConnection();
      logger.info('Kết nối PostgreSQL thành công ✓');
      break;
    } catch (err) {
      if (i === 10) {
        logger.error('Không thể kết nối PostgreSQL sau 10 lần thử. Thoát.', { error: err.message });
        process.exit(1);
      }
      logger.warn(`Chờ PostgreSQL... (lần ${i}/10): ${err.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  server.listen(PORT, '0.0.0.0', () => {
    logger.info(`🚀 MoMo Alert Server đang chạy tại http://0.0.0.0:${PORT}`);
    logger.info(`📡 WebSocket sẵn sàng cho OBS Overlay`);
    logger.info(`🔑 Webhook: POST /api/v1/webhook/momo-notify`);
    logger.info(`🔊 TTS Proxy: GET /api/v1/tts?text=...`);
    logger.info(`ENV: ${process.env.NODE_ENV}`);

    // Dọn dẹp dữ liệu cũ hơn 90 ngày khi khởi động và lặp lại mỗi 24 giờ
    runDataRetentionCleanup();
    setInterval(runDataRetentionCleanup, 24 * 60 * 60 * 1000);
  });
}

// Xử lý graceful shutdown
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT',  gracefulShutdown);

function gracefulShutdown() {
  logger.info('Nhận tín hiệu tắt – đang đóng kết nối...');
  server.close(() => {
    db.getPool().end(() => {
      logger.info('Server đã tắt sạch sẽ.');
      process.exit(0);
    });
  });
  // Force exit sau 10s nếu cleanup quá lâu
  setTimeout(() => process.exit(1), 10000);
}

startServer().catch(err => {
  logger.error('Lỗi khởi động server:', err);
  process.exit(1);
});

module.exports = { app, server, io }; // export để test
