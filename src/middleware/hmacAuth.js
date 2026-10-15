'use strict';

/**
 * Middleware xác thực HMAC-SHA256 cho Webhook MoMo
 *
 * Android App phải gửi:
 *   Header X-Signature: hmac_sha256(rawBody, WEBHOOK_SECRET)
 *   Header X-Timestamp: unix_milliseconds_string
 *
 * Bảo vệ thêm: kiểm tra timestamp không quá 5 phút (chống replay attack)
 */

const crypto = require('crypto');
const logger  = require('../services/logger');

const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000; // 5 phút

/**
 * Express middleware – xác thực HMAC signature.
 * Phải được dùng SAU `express.raw()` hoặc `express.json()` với `verify` callback.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function verifyHmacSignature(req, res, next) {
  const secret    = process.env.WEBHOOK_SECRET;
  const signature = req.headers['x-signature'];
  const timestamp = req.headers['x-timestamp'];

  // ── 1. Kiểm tra header bắt buộc ─────────────────────────────────────────
  if (!signature) {
    logger.warn('Webhook bị từ chối: thiếu header X-Signature', { ip: req.ip });
    return res.status(401).json({
      ok: false,
      error: 'MISSING_SIGNATURE',
      message: 'Header X-Signature là bắt buộc',
    });
  }

  if (!timestamp) {
    logger.warn('Webhook bị từ chối: thiếu header X-Timestamp', { ip: req.ip });
    return res.status(401).json({
      ok: false,
      error: 'MISSING_TIMESTAMP',
      message: 'Header X-Timestamp là bắt buộc',
    });
  }

  // ── 2. Kiểm tra timestamp để chống replay attack ──────────────────────────
  const tsNum = parseInt(timestamp, 10);
  if (isNaN(tsNum)) {
    return res.status(401).json({
      ok: false,
      error: 'INVALID_TIMESTAMP',
      message: 'X-Timestamp phải là Unix milliseconds hợp lệ',
    });
  }

  const drift = Math.abs(Date.now() - tsNum);
  if (drift > MAX_TIMESTAMP_DRIFT_MS) {
    logger.warn('Webhook bị từ chối: timestamp lệch quá 5 phút', {
      ip: req.ip,
      drift: `${Math.round(drift / 1000)}s`,
    });
    return res.status(401).json({
      ok: false,
      error: 'TIMESTAMP_EXPIRED',
      message: 'Timestamp lệch quá 5 phút. Kiểm tra đồng hồ thiết bị Android.',
    });
  }

  // ── 3. Tính chữ ký kỳ vọng ───────────────────────────────────────────────
  // rawBody được lưu vào req.rawBody bởi middleware verify callback trong server.js
  const rawBody = req.rawBody;
  if (!rawBody) {
    logger.error('verifyHmacSignature: req.rawBody không tồn tại – kiểm tra cấu hình middleware');
    return res.status(500).json({
      ok: false,
      error: 'SERVER_CONFIG_ERROR',
      message: 'Lỗi cấu hình server nội bộ',
    });
  }

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // ── 4. So sánh chữ ký (timing-safe) ─────────────────────────────────────
  try {
    const sigBuffer = Buffer.from(signature, 'hex');
    const expBuffer = Buffer.from(expectedSig, 'hex');

    if (sigBuffer.length !== expBuffer.length ||
        !crypto.timingSafeEqual(sigBuffer, expBuffer)) {
      logger.warn('Webhook bị từ chối: chữ ký không hợp lệ', {
        ip: req.ip,
        received: signature.substring(0, 10) + '...',
      });
      return res.status(403).json({
        ok: false,
        error: 'INVALID_SIGNATURE',
        message: 'Chữ ký HMAC không hợp lệ',
      });
    }
  } catch (err) {
    // Buffer.from có thể throw nếu signature không phải hex hợp lệ
    logger.warn('Webhook bị từ chối: signature có định dạng lỗi', { ip: req.ip });
    return res.status(403).json({
      ok: false,
      error: 'MALFORMED_SIGNATURE',
      message: 'Chữ ký có định dạng không hợp lệ (cần hex string)',
    });
  }

  // ── 5. Hợp lệ ───────────────────────────────────────────────────────────
  logger.debug('Webhook HMAC xác thực thành công', { ip: req.ip });
  next();
}

module.exports = { verifyHmacSignature };
