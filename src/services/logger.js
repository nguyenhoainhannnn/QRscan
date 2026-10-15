'use strict';

/**
 * Winston logger – structured JSON logging
 * Level được điều khiển qua LOG_LEVEL trong .env
 */

const { createLogger, format, transports } = require('winston');
const path = require('path');
const fs   = require('fs');

// Đảm bảo thư mục logs tồn tại
const LOG_DIR = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const isDev = process.env.NODE_ENV !== 'production';

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: 'momo-alert-backend' },
  transports: [
    // File: tất cả log từ warn trở lên
    new transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024,  // 10MB rotate
      maxFiles: 5,
    }),
    new transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      maxsize: 20 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
});

// Console: format đẹp hơn khi dev
if (isDev) {
  logger.add(new transports.Console({
    format: format.combine(
      format.colorize(),
      format.timestamp({ format: 'HH:mm:ss' }),
      format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length && meta.service !== 'momo-alert-backend'
          ? ' ' + JSON.stringify(meta)
          : '';
        return `${timestamp} [${level}] ${message}${metaStr}`;
      })
    ),
  }));
} else {
  // Production: cũng log ra console nhưng JSON format
  logger.add(new transports.Console());
}

module.exports = logger;
