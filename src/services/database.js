'use strict';

/**
 * PostgreSQL connection pool
 * Đọc DATABASE_URL từ .env, tự động retry khi DB chưa sẵn sàng.
 */

const { Pool } = require('pg');
const logger   = require('./logger');

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,                    // tối đa 20 concurrent connections
      idleTimeoutMillis: 30000,   // đóng idle connection sau 30s
      connectionTimeoutMillis: 5000,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });

    pool.on('error', (err) => {
      logger.error('Lỗi PostgreSQL pool không mong muốn:', err);
    });

    pool.on('connect', () => {
      logger.debug('Kết nối PostgreSQL mới được tạo');
    });
  }
  return pool;
}

/**
 * Thực thi query với tự động retry
 * @param {string} text - SQL query
 * @param {Array}  values - tham số
 * @param {number} retries - số lần retry (mặc định 3)
 */
async function query(text, values, retries = 3) {
  const db = getPool();
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await db.query(text, values);
      return result;
    } catch (err) {
      if (attempt === retries) throw err;
      logger.warn(`DB query thất bại (lần ${attempt}/${retries}):`, err.message);
      await new Promise(r => setTimeout(r, 500 * attempt)); // exponential backoff nhẹ
    }
  }
}

/**
 * Lấy settings hiện tại từ bảng app_settings (cache ngắn hạn 30s)
 */
let _settingsCache = null;
let _settingsCacheAt = 0;
const SETTINGS_CACHE_TTL = 30_000; // 30 giây

async function getSettings() {
  const now = Date.now();
  if (_settingsCache && (now - _settingsCacheAt) < SETTINGS_CACHE_TTL) {
    return _settingsCache;
  }
  const result = await query('SELECT * FROM app_settings WHERE id = 1');
  _settingsCache = result.rows[0] || null;
  _settingsCacheAt = now;
  return _settingsCache;
}

function invalidateSettingsCache() {
  _settingsCache = null;
  _settingsCacheAt = 0;
}

/**
 * Kiểm tra kết nối DB (dùng trong health check)
 */
async function checkConnection() {
  const result = await query('SELECT NOW() AS now');
  return result.rows[0].now;
}

module.exports = { query, getPool, getSettings, invalidateSettingsCache, checkConnection };
