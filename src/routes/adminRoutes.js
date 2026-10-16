'use strict';

/**
 * adminRoutes.js – Tất cả routes cho Admin Dashboard (Giai đoạn 3)
 * ─────────────────────────────────────────────────────────────────
 * Mount vào server.js: app.use(adminRouter)
 *
 * HTML Routes:
 *   GET  /admin/login    – Trang đăng nhập
 *   POST /admin/login    – Xử lý đăng nhập
 *   POST /admin/logout   – Đăng xuất
 *   GET  /admin          – Dashboard (redirect về /admin/ nếu chưa login)
 *   GET  /admin/*        – Serve static files của admin UI
 *
 * API Routes (đều yêu cầu session cookie):
 *   GET  /api/v1/admin/stats
 *   GET  /api/v1/admin/donations
 *   POST /api/v1/admin/donations/:id/replay
 *   GET  /api/v1/admin/raw-logs
 *   POST /api/v1/admin/raw-logs/:id/reparse
 *   POST /api/v1/admin/test-alert
 *   GET  /api/v1/admin/settings
 *   PUT  /api/v1/admin/settings
 */

const express   = require('express');
const path      = require('path');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');
const router    = express.Router();

const db     = require('../services/database');
const logger = require('../services/logger');
const { parseMomoNotification, filterBadWords } = require('../services/momoParser');
const {
  requireSession,
  setSessionCookie,
  clearSessionCookie,
  checkPassword,
} = require('../middleware/adminAuth');

// Rate limiter cho trang login: tối đa 5 lần thử / 15 phút (Phase 5)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 phút
  max: 5,                   // tối đa 5 lần thử / 15 phút
  skipSuccessfulRequests: true, // Thành công không tính vào giới hạn thử
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit admin login bị vượt quá (tối đa 5 lần thử / 15 phút)', { ip: req.ip });
    const message = 'Bạn đã thử đăng nhập sai quá 5 lần. Vui lòng thử lại sau 15 phút.';
    if (req.headers['content-type']?.includes('application/json') || req.xhr) {
      return res.status(429).json({ ok: false, error: 'RATE_LIMIT_LOGIN', message });
    }
    return res.status(429).send(message);
  },
});

// io được inject khi router được mount (xem cuối file)
let _io = null;
function setIo(io) { _io = io; }

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function fmt(n) {
  return new Intl.NumberFormat('vi-VN').format(Number(n) || 0);
}

function renderTts(template, { name, amount, message }) {
  if (!template) return '';
  return template
    .replace(/\{name\}/g, name || 'Người ẩn danh')
    .replace(/\{amount\}/g, fmt(amount))
    .replace(/\{message\}/g, message || '');
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH Routes (không cần session)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /admin/login – Trang đăng nhập */
router.get('/admin/login', (req, res) => {
  // Nếu đã đăng nhập → redirect về dashboard
  const { requireSession: _r, ...rest } = require('../middleware/adminAuth');
  // Quick check cookie without full middleware
  const cookieHeader = req.headers.cookie || '';
  // Serve login page (luôn luôn)
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'admin', 'login.html'));
});

/** POST /admin/login – Xử lý đăng nhập */
router.post('/admin/login', loginLimiter, express.urlencoded({ extended: false }), express.json(), (req, res) => {
  const password = req.body?.password || '';

  if (!checkPassword(password)) {
    logger.warn('Admin login thất bại', { ip: req.ip });

    // API request
    if (req.headers['content-type']?.includes('application/json')) {
      return res.status(401).json({ ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu không đúng' });
    }
    // Form submit
    return res.redirect('/admin/login?error=wrong_password');
  }

  setSessionCookie(res);
  logger.info('Admin đăng nhập thành công', { ip: req.ip });

  if (req.headers['content-type']?.includes('application/json')) {
    return res.json({ ok: true, redirect: '/admin/' });
  }
  res.redirect('/admin/');
});

/** POST /admin/logout */
router.post('/admin/logout', (req, res) => {
  clearSessionCookie(res);
  res.redirect('/admin/login');
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin Static Files (cần session)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /admin và /admin/ → Serve dashboard HTML (cần session) */
router.get(['/admin', '/admin/'], requireSession, (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'admin', 'index.html'));
});

/** Serve static assets của admin UI (CSS, JS) – không tự phục vụ index.html */
router.use('/admin', express.static(path.join(__dirname, '..', '..', 'public', 'admin'), { index: false }));

// ─────────────────────────────────────────────────────────────────────────────
// API Routes – tất cả cần session
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/v1/admin/stats ──────────────────────────────────────────────────
router.get('/api/v1/admin/stats', requireSession, async (req, res) => {
  try {
    const [todayStats, monthStats, topDonors] = await Promise.all([
      // Hôm nay
      db.query(`
        SELECT
          COUNT(*)                                          AS today_count,
          COALESCE(SUM(amount), 0)                         AS today_amount,
          COALESCE(SUM(CASE WHEN alert_status = 'QUEUED'
            THEN 1 ELSE 0 END), 0)                         AS pending_count
        FROM donations
        WHERE created_at >= CURRENT_DATE
          AND created_at <  CURRENT_DATE + INTERVAL '1 day'
      `),
      // Tháng này
      db.query(`
        SELECT
          COUNT(*)                         AS month_count,
          COALESCE(SUM(amount), 0)         AS month_amount
        FROM donations
        WHERE date_trunc('month', created_at) = date_trunc('month', NOW())
      `),
      // Top 5 donors (all-time)
      db.query(`
        SELECT
          sender_name,
          COUNT(*)                   AS donate_count,
          SUM(amount)                AS total_amount,
          MAX(amount)                AS max_single
        FROM donations
        GROUP BY sender_name
        ORDER BY total_amount DESC
        LIMIT 5
      `),
    ]);

    res.json({
      ok: true,
      data: {
        today: {
          count:      parseInt(todayStats.rows[0].today_count),
          amount:     parseFloat(todayStats.rows[0].today_amount),
          pendingCount: parseInt(todayStats.rows[0].pending_count),
        },
        month: {
          count:  parseInt(monthStats.rows[0].month_count),
          amount: parseFloat(monthStats.rows[0].month_amount),
        },
        topDonors: topDonors.rows.map(r => ({
          name:        r.sender_name,
          count:       parseInt(r.donate_count),
          totalAmount: parseFloat(r.total_amount),
          maxSingle:   parseFloat(r.max_single),
        })),
      },
    });
  } catch (err) {
    logger.error('Admin stats error:', err);
    res.status(500).json({ ok: false, error: 'DB_ERROR', message: err.message });
  }
});

// ── GET /api/v1/admin/donations ──────────────────────────────────────────────
router.get('/api/v1/admin/donations', requireSession, async (req, res) => {
  const limit   = Math.min(parseInt(req.query.limit  || '50', 10), 200);
  const offset  = parseInt(req.query.offset || '0', 10);
  const search  = (req.query.search  || '').trim();
  const dateFrom = req.query.date_from || null;  // YYYY-MM-DD
  const dateTo   = req.query.date_to   || null;
  const status   = req.query.status   || null;

  try {
    const conditions = [];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      conditions.push(
        `(sender_name ILIKE $${idx} OR message ILIKE $${idx} OR momo_trans_id ILIKE $${idx})`
      );
    }
    if (dateFrom) {
      params.push(dateFrom);
      conditions.push(`created_at >= $${params.length}::date`);
    }
    if (dateTo) {
      params.push(dateTo);
      conditions.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    if (status) {
      params.push(status);
      conditions.push(`alert_status = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows, countRow] = await Promise.all([
      db.query(
        `SELECT id, momo_trans_id, sender_name, sender_phone, amount,
                message, alert_status, played_at, created_at
         FROM donations
         ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      db.query(
        `SELECT COUNT(*) FROM donations ${where}`,
        params
      ),
    ]);

    res.json({
      ok: true,
      data: rows.rows,
      pagination: {
        limit, offset,
        total: parseInt(countRow.rows[0].count),
      },
    });
  } catch (err) {
    logger.error('Admin donations list error:', err);
    res.status(500).json({ ok: false, error: 'DB_ERROR', message: err.message });
  }
});

// ── POST /api/v1/admin/donations/:id/replay ──────────────────────────────────
router.post('/api/v1/admin/donations/:id/replay', requireSession, async (req, res) => {
  const donationId = parseInt(req.params.id, 10);
  if (!donationId) return res.status(400).json({ ok: false, error: 'INVALID_ID' });

  try {
    const result = await db.query(
      `UPDATE donations
       SET alert_status = 'REPLAYED',
           played_at    = NOW()
       WHERE id = $1
       RETURNING *`,
      [donationId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Donation không tồn tại' });
    }

    const donation = result.rows[0];
    const settings = await db.getSettings();

    const eventPayload = {
      id:             donation.id,
      senderName:     donation.sender_name,
      amount:         donation.amount,
      message:        donation.message,
      alertDurationMs: settings?.alert_duration_ms || 8000,
      ttsText: settings?.tts_enabled
        ? renderTts(settings.tts_template, {
            name:    donation.sender_name,
            amount:  donation.amount,
            message: donation.message || '',
          })
        : null,
      _replay: true,
    };

    if (_io) {
      _io.to('obs_overlay_room').emit('new_donation', eventPayload);
      _io.to('admin_room').emit('donation_replayed', { donationId, ok: true });
    }

    logger.info('Admin replay donation', { donationId, admin: req.ip });
    res.json({ ok: true, message: 'Đã gửi lại lên OBS', data: donation });
  } catch (err) {
    logger.error('Replay error:', err);
    res.status(500).json({ ok: false, error: 'DB_ERROR', message: err.message });
  }
});

// ── GET /api/v1/admin/raw-logs ───────────────────────────────────────────────
router.get('/api/v1/admin/raw-logs', requireSession, async (req, res) => {
  const limit   = Math.min(parseInt(req.query.limit  || '50', 10), 200);
  const offset  = parseInt(req.query.offset || '0', 10);
  const status  = req.query.status || 'ALL';  // ALL | PARSED | FAILED_REGEX | IGNORED | DUPLICATE | PENDING

  try {
    const VALID = ['ALL', 'PENDING', 'PARSED', 'IGNORED', 'FAILED_REGEX', 'DUPLICATE'];
    const params = [];
    let where = '';

    if (status !== 'ALL' && VALID.includes(status)) {
      params.push(status);
      where = `WHERE parse_status = $1`;
    }

    const [rows, countRow] = await Promise.all([
      db.query(
        `SELECT id, android_notif_id, package_name, raw_title, raw_text,
                device_timestamp, parse_status, error_reason, client_ip, created_at
         FROM raw_notification_logs
         ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      db.query(`SELECT COUNT(*) FROM raw_notification_logs ${where}`, params),
    ]);

    res.json({
      ok: true,
      data: rows.rows,
      pagination: { limit, offset, total: parseInt(countRow.rows[0].count) },
    });
  } catch (err) {
    logger.error('Raw logs error:', err);
    res.status(500).json({ ok: false, error: 'DB_ERROR', message: err.message });
  }
});

// ── POST /api/v1/admin/raw-logs/:id/reparse ─────────────────────────────────
router.post('/api/v1/admin/raw-logs/:id/reparse', requireSession, async (req, res) => {
  const logId = parseInt(req.params.id, 10);
  if (!logId) return res.status(400).json({ ok: false, error: 'INVALID_ID' });

  try {
    // Lấy raw log
    const logResult = await db.query(
      'SELECT * FROM raw_notification_logs WHERE id = $1',
      [logId]
    );
    if (!logResult.rows.length) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    }

    const rawLog = logResult.rows[0];

    // Chạy lại parser
    const parseResult = parseMomoNotification({
      rawTitle:    rawLog.raw_title,
      rawText:     rawLog.raw_text,
      packageName: rawLog.package_name,
      timestamp:   rawLog.device_timestamp
        ? new Date(rawLog.device_timestamp).getTime()
        : Date.now(),
    });

    if (parseResult.status !== 'PARSED') {
      // Vẫn thất bại → cập nhật error_reason mới
      await db.query(
        `UPDATE raw_notification_logs
         SET parse_status = $1, error_reason = $2
         WHERE id = $3`,
        [parseResult.status, parseResult.reason, logId]
      );
      return res.json({
        ok:     false,
        result: parseResult.status,
        reason: parseResult.reason,
        message: 'Parser vẫn thất bại với dữ liệu gốc. Có thể nhập tay qua test-alert.',
      });
    }

    const { data } = parseResult;
    const settings = await db.getSettings();
    const minAmount = settings?.min_donate_amount || 10000;

    // Kiểm tra duplicate
    const dup = await db.query(
      'SELECT id FROM donations WHERE momo_trans_id = $1',
      [data.momoTransId]
    );
    if (dup.rows.length) {
      return res.json({
        ok:     true,
        result: 'DUPLICATE',
        message: 'Giao dịch này đã được lưu trước đó.',
        existingId: dup.rows[0].id,
      });
    }

    // Kiểm tra min amount
    if (data.amount < minAmount) {
      return res.json({
        ok:     true,
        result: 'BELOW_MINIMUM',
        amount: data.amount,
        minAmount,
      });
    }

    // Lưu vào donations
    const filteredMsg = filterBadWords(data.message, settings?.bad_words_list || []);
    const ins = await db.query(
      `INSERT INTO donations
         (raw_log_id, momo_trans_id, sender_name, sender_phone,
          amount, message, raw_message, alert_status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'QUEUED',NOW())
       RETURNING *`,
      [logId, data.momoTransId, data.senderName, data.senderPhone,
       data.amount, filteredMsg, data.message]
    );

    // Cập nhật raw_log
    await db.query(
      `UPDATE raw_notification_logs SET parse_status = 'PARSED' WHERE id = $1`,
      [logId]
    );

    const donation = ins.rows[0];

    // Phát lên OBS
    if (_io) {
      _io.to('obs_overlay_room').emit('new_donation', {
        id:          donation.id,
        senderName:  donation.sender_name,
        amount:      donation.amount,
        message:     donation.message,
        alertDurationMs: settings?.alert_duration_ms || 8000,
        ttsText: settings?.tts_enabled
          ? renderTts(settings.tts_template, {
              name: donation.sender_name, amount: donation.amount, message: donation.message || ''
            })
          : null,
      });
    }

    logger.info('Admin reparse thành công', { logId, donationId: donation.id });
    res.json({
      ok:        true,
      result:    'CREATED',
      donationId: donation.id,
      data:      donation,
    });
  } catch (err) {
    logger.error('Reparse error:', err);
    res.status(500).json({ ok: false, error: 'DB_ERROR', message: err.message });
  }
});

// ── POST /api/v1/admin/test-alert ────────────────────────────────────────────
router.post('/api/v1/admin/test-alert', requireSession, async (req, res) => {
  const { sender_name, amount, message } = req.body || {};

  if (!sender_name || !amount) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_FIELDS',
      message: 'sender_name và amount là bắt buộc',
    });
  }

  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    return res.status(400).json({ ok: false, error: 'INVALID_AMOUNT' });
  }

  const settings = await db.getSettings().catch(() => null);

  const payload = {
    id:          null,  // TEST – không có DB record
    senderName:  String(sender_name).substring(0, 100),
    amount:      amountNum,
    message:     message ? String(message).substring(0, 500) : '',
    alertDurationMs: settings?.alert_duration_ms || 8000,
    ttsText: settings?.tts_enabled
      ? renderTts(settings.tts_template, {
          name:    String(sender_name),
          amount:  amountNum,
          message: message || '',
        })
      : null,
    _isTest: true,
  };

  if (_io) {
    _io.to('obs_overlay_room').emit('new_donation', payload);
    _io.to('admin_room').emit('test_alert_sent', { ok: true });
  }

  logger.info('Admin test-alert bắn lên OBS', { admin: req.ip, name: sender_name, amount: amountNum });
  res.json({ ok: true, message: 'Đã bắn test alert lên OBS', payload });
});

// ── GET /api/v1/admin/settings ───────────────────────────────────────────────
router.get('/api/v1/admin/settings', requireSession, async (req, res) => {
  try {
    const settings = await db.getSettings();
    // Không expose obs_overlay_token đầy đủ – chỉ show một phần
    const safeSettings = { ...settings };
    if (safeSettings.obs_overlay_token) {
      safeSettings._token_preview = safeSettings.obs_overlay_token.substring(0, 8) + '...';
    }
    res.json({ ok: true, data: safeSettings });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'DB_ERROR', message: err.message });
  }
});

// ── PUT /api/v1/admin/settings ───────────────────────────────────────────────
router.put('/api/v1/admin/settings', requireSession, async (req, res) => {
  const {
    min_donate_amount,
    tts_enabled,
    tts_template,
    alert_duration_ms,
    bad_words_list,
    rotate_token,      // boolean – nếu true thì sinh token mới
  } = req.body || {};

  try {
    // Sinh token mới nếu được yêu cầu
    let newToken = null;
    if (rotate_token) {
      newToken = crypto.randomBytes(24).toString('base64url');
    }

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
        min_donate_amount  != null ? parseFloat(min_donate_amount) : null,
        tts_enabled        != null ? Boolean(tts_enabled)          : null,
        tts_template       || null,
        alert_duration_ms  != null ? parseInt(alert_duration_ms)   : null,
        bad_words_list     != null ? bad_words_list                : null,
        newToken,
      ]
    );

    db.invalidateSettingsCache();

    const updated = result.rows[0];
    logger.info('Admin settings updated', { admin: req.ip, rotateToken: !!rotate_token });

    res.json({
      ok: true,
      data: updated,
      newToken: newToken || undefined,  // trả về token mới nếu vừa đổi
      message: newToken
        ? '⚠️ Token OBS đã được đổi. Cập nhật URL trong OBS ngay!'
        : 'Cài đặt đã lưu.',
    });
  } catch (err) {
    logger.error('Settings update error:', err);
    res.status(500).json({ ok: false, error: 'DB_ERROR', message: err.message });
  }
});

// ── GET /api/v1/admin/obs-url ─────────────────────────────────────────────────
// Trả về URL đầy đủ cho OBS Browser Source (cần session)
router.get('/api/v1/admin/obs-url', requireSession, async (req, res) => {
  try {
    const settings = await db.getSettings();
    const token    = settings?.obs_overlay_token || process.env.OBS_OVERLAY_TOKEN;
    const host     = req.headers.host || `localhost:${process.env.PORT || 3000}`;
    const proto    = req.headers['x-forwarded-proto'] || 'http';
    const url      = `${proto}://${host}/overlay?token=${encodeURIComponent(token)}`;
    res.json({ ok: true, url, token });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'DB_ERROR', message: err.message });
  }
});

// ── POST /api/v1/admin/cleanup ────────────────────────────────────────────────
// Kích hoạt dọn dẹp dữ liệu cũ (mặc định 90 ngày)
router.post('/api/v1/admin/cleanup', requireSession, async (req, res) => {
  try {
    const days = parseInt(req.body?.days || '90', 10);
    const result = await db.query('SELECT * FROM fn_cleanup_old_records($1)', [days]);
    const row = result.rows[0];
    logger.info('Admin kích hoạt dọn dẹp dữ liệu:', { days, row });
    res.json({
      ok: true,
      retentionDays: days,
      deletedDonations: Number(row?.deleted_donations || 0),
      deletedRawLogs: Number(row?.deleted_raw_logs || 0),
      message: `Đã dọn dẹp dữ liệu cũ hơn ${days} ngày.`,
    });
  } catch (err) {
    logger.error('Cleanup error:', err);
    res.status(500).json({ ok: false, error: 'DB_ERROR', message: err.message });
  }
});

module.exports = { router, setIo };
