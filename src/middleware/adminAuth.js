'use strict';

/**
 * adminAuth.js – Xác thực Admin qua Signed Session Cookie
 * ─────────────────────────────────────────────────────────
 * Không cần thư viện thêm (chỉ dùng crypto built-in Node.js).
 *
 * Cách hoạt động:
 *   1. POST /admin/login  → kiểm tra password, set HTTP-only cookie "adm_sess"
 *   2. Middleware requireSession → kiểm tra cookie trên mọi route /admin/* & /api/v1/admin/*
 *   3. POST /admin/logout → xóa cookie
 *
 * Định dạng token: base64(payload).signature
 *   payload = { ts: <unix_ms>, exp: <unix_ms> }
 *   signature = HMAC-SHA256(payload_b64, ADMIN_SESSION_SECRET)
 */

const crypto = require('crypto');
const logger = require('../services/logger');

const COOKIE_NAME    = 'adm_sess';
const SESSION_MAX_MS = 8 * 60 * 60 * 1000; // 8 giờ

/** Lấy secret để ký token (dùng ADMIN_PASSWORD + WEBHOOK_SECRET làm seed) */
function getSecret() {
  return crypto
    .createHash('sha256')
    .update(`${process.env.ADMIN_PASSWORD}:${process.env.WEBHOOK_SECRET}:admin_session`)
    .digest('hex');
}

/** Tạo signed session token */
function createToken() {
  const now     = Date.now();
  const payload = JSON.stringify({ ts: now, exp: now + SESSION_MAX_MS });
  const b64     = Buffer.from(payload).toString('base64url');
  const sig     = crypto.createHmac('sha256', getSecret()).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

/** Xác thực token – trả về payload hoặc null nếu invalid/hết hạn */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [b64, sig] = parts;
  const expected   = crypto.createHmac('sha256', getSecret()).update(b64).digest('base64url');

  // Timing-safe compare
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  // Decode payload
  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }

  // Kiểm tra expiry
  if (!payload.exp || Date.now() > payload.exp) return null;

  return payload;
}

/** Đặt HTTP-only session cookie */
function setSessionCookie(res) {
  const token = createToken();
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   SESSION_MAX_MS,
    path:     '/',
  });
  return token;
}

/** Xóa session cookie */
function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/** Express middleware – bảo vệ route, redirect về /admin/login nếu chưa đăng nhập */
function requireSession(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  const payload = verifyToken(token);

  if (!payload) {
    // API request → trả JSON 401
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({
        ok:      false,
        error:   'SESSION_REQUIRED',
        message: 'Phiên đăng nhập hết hạn hoặc chưa đăng nhập. Vui lòng đăng nhập lại.',
      });
    }
    // Browser request → redirect
    return res.redirect('/admin/login');
  }

  next();
}

/** Kiểm tra password từ form → boolean */
function checkPassword(password) {
  const adminPwd = process.env.ADMIN_PASSWORD;
  if (!adminPwd || !password) return false;
  // Timing-safe compare
  try {
    const a = Buffer.from(password);
    const b = Buffer.from(adminPwd);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = {
  requireSession,
  setSessionCookie,
  clearSessionCookie,
  checkPassword,
  COOKIE_NAME,
};
