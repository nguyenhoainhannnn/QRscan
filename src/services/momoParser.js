'use strict';

/**
 * MoMo Notification Parser – bóc tách thông tin giao dịch từ raw notification
 *
 * Hỗ trợ các mẫu thông báo phổ biến của MoMo (package: com.mservice.momotransfer):
 *
 * Mẫu 1 (nhận tiền cổ điển):
 *   "Bạn vừa nhận được 50.000đ từ NGUYEN VAN A (090xxxx123).
 *    Lời nhắn: Chuc ban stream vui ve. Mã GD: 65432109876."
 *
 * Mẫu 2 (cộng tài khoản):
 *   "Tài khoản của bạn vừa được cộng +20,000đ từ TRAN THI B.
 *    Nội dung: Ung ho anh. Mã giao dịch: 65432109877"
 *
 * Mẫu 3 (không lời nhắn):
 *   "Bạn vừa nhận được 100.000đ từ LE VAN C (091xxx456)."
 *
 * Trả về:
 *   { status: 'PARSED', data: {...} }
 *   { status: 'IGNORED', reason: '...' }
 *   { status: 'FAILED_REGEX', reason: '...' }
 */

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Từ khoá nhận dạng giao dịch hợp lệ (nhận tiền / cộng tiền)
// ─────────────────────────────────────────────────────────────────────────────
const VALID_TRANSFER_PATTERNS = [
  /nhận được/i,
  /được cộng/i,
  /cộng \+/i,
  /chuyển tiền thành công/i,
  /bạn vừa nhận/i,
];

// Từ khoá nhận dạng thông báo KHÔNG PHẢI giao dịch nhận tiền (quảng cáo, trừ tiền, v.v.)
const IGNORE_PATTERNS = [
  /hoàn tiền/i,           // hoàn tiền khuyến mãi
  /khuyến mãi/i,
  /ưu đãi/i,
  /voucher/i,
  /cashback/i,
  /flash sale/i,
  /bị trừ/i,              // thông báo trừ tiền
  /thanh toán thành công/i,
  /đã thanh toán/i,
  /mua hàng/i,
  /nạp tiền/i,
  /rút tiền/i,
  /chuyển khoản thành công/i,   // chuyển đi, không phải nhận về
  /bạn đã chuyển/i,
  /số dư:/i,              // thông báo số dư đơn thuần
];

// ─────────────────────────────────────────────────────────────────────────────
// Regex bóc tách thông tin chính
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bóc tách số tiền – hỗ trợ cả dấu chấm (50.000) và dấu phẩy (20,000)
 * Cũng xử lý ký hiệu VNĐ: đ, vnđ, VND, đồng
 * Group 1: số tiền thuần (vd: "50.000" hoặc "20,000")
 */
const AMOUNT_REGEX = /(?:cộng\s*\+|nhận được\s*)\s*([\d][,.\d]+)\s*(?:đ|vnđ|vnd|đồng)?/i;

/**
 * Bóc tách tên người gửi và số điện thoại (tuỳ chọn)
 * Mẫu: "từ NGUYEN VAN A (090xxxx123)"
 * Group 1: tên (ALL CAPS hoặc mixed)
 * Group 2: số điện thoại (tuỳ chọn)
 */
const SENDER_REGEX = /từ\s+([A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠƯẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸ][A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠƯẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸa-zàáâãèéêìíòóôõùúăđĩũơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ\s]+?)(?:\s*\((\+?[\d\s\-x]{8,15})\))?\s*(?:\.|,|Lời nhắn|Nội dung|Mã GD|Mã giao dịch|$)/i;

/**
 * Bóc tách lời nhắn / nội dung
 * Hỗ trợ cả "Lời nhắn:" và "Nội dung:"
 * Group 1: nội dung lời nhắn
 */
const MESSAGE_REGEX = /(?:lời nhắn|nội dung)\s*:\s*(.+?)(?:\s*[.\n]?\s*(?:Mã GD|Mã giao dịch)|$)/i;

/**
 * Bóc tách mã giao dịch MoMo
 * Hỗ trợ: "Mã GD:", "Mã giao dịch:", "Ref:"
 * Group 1: mã giao dịch (dãy số hoặc alphanumeric)
 */
const TRANS_ID_REGEX = /(?:mã\s+gd|mã\s+giao\s+dịch|ref)\s*:\s*([A-Z0-9]+)/i;

// ─────────────────────────────────────────────────────────────────────────────
// Helper: chuẩn hoá số tiền (xoá dấu chấm/phẩy ngăn cách, chuyển thành integer)
// ─────────────────────────────────────────────────────────────────────────────
function parseAmount(raw) {
  if (!raw) return null;
  // Xử lý 2 trường hợp:
  // "50.000"  -> 50000 (dấu chấm là phân cách hàng nghìn kiểu VN)
  // "20,000"  -> 20000 (dấu phẩy là phân cách hàng nghìn kiểu US)
  // "1.500.000" -> 1500000
  // "1,500,000" -> 1500000
  const cleaned = raw
    .replace(/\./g, '')   // xoá tất cả dấu chấm
    .replace(/,/g, '');   // xoá tất cả dấu phẩy
  const value = parseInt(cleaned, 10);
  return isNaN(value) ? null : value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: sinh fallback transaction ID từ hash SHA256
// ─────────────────────────────────────────────────────────────────────────────
function generateFallbackTransId(timestamp, amount, senderName) {
  const minuteBucket = Math.floor(timestamp / 60000); // bucket theo phút
  const raw = `${minuteBucket}|${amount}|${senderName}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return `HASH_${hash.substring(0, 20).toUpperCase()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main parser function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse raw MoMo notification
 *
 * @param {object} params
 * @param {string} params.rawTitle   - Tiêu đề thông báo (có thể null/rỗng)
 * @param {string} params.rawText    - Nội dung thông báo (bắt buộc)
 * @param {string} [params.packageName='com.mservice.momotransfer'] - Package Android
 * @param {number} [params.timestamp=Date.now()] - Unix milliseconds
 *
 * @returns {{ status: string, data?: object, reason?: string }}
 */
function parseMomoNotification({ rawTitle, rawText, packageName, timestamp }) {
  // Chuẩn hoá input
  const title   = (rawTitle  || '').trim();
  const text    = (rawText   || '').trim();
  const pkg     = (packageName || '').toLowerCase();
  const ts      = timestamp || Date.now();

  // ── Bước 1: Kiểm tra package name ──────────────────────────────────────────
  if (pkg && !pkg.includes('mservice') && !pkg.includes('momo')) {
    return {
      status: 'IGNORED',
      reason: `Package không phải MoMo: ${packageName}`,
    };
  }

  // ── Bước 2: Ghép toàn bộ text để phân tích ────────────────────────────────
  const fullText = [title, text].filter(Boolean).join(' ');

  // ── Bước 3: Lọc thông báo rác / quảng cáo / trừ tiền ─────────────────────
  for (const pattern of IGNORE_PATTERNS) {
    if (pattern.test(fullText)) {
      return {
        status: 'IGNORED',
        reason: `Khớp pattern loại trừ: ${pattern.toString()}`,
      };
    }
  }

  // ── Bước 4: Kiểm tra có phải thông báo nhận tiền không ──────────────────
  const isValidTransfer = VALID_TRANSFER_PATTERNS.some(p => p.test(fullText));
  if (!isValidTransfer) {
    return {
      status: 'IGNORED',
      reason: 'Không tìm thấy từ khoá giao dịch nhận tiền trong thông báo',
    };
  }

  // ── Bước 5: Bóc tách số tiền ──────────────────────────────────────────────
  const amountMatch = AMOUNT_REGEX.exec(fullText);
  if (!amountMatch) {
    return {
      status: 'FAILED_REGEX',
      reason: 'Không bóc tách được số tiền từ thông báo',
    };
  }
  const amount = parseAmount(amountMatch[1]);
  if (!amount || amount <= 0) {
    return {
      status: 'FAILED_REGEX',
      reason: `Số tiền không hợp lệ: "${amountMatch[1]}"`,
    };
  }

  // ── Bước 6: Bóc tách tên & SĐT người gửi ──────────────────────────────────
  let senderName  = 'Người ẩn danh';
  let senderPhone = null;

  const senderMatch = SENDER_REGEX.exec(fullText);
  if (senderMatch) {
    senderName  = senderMatch[1].trim();
    senderPhone = senderMatch[2] ? senderMatch[2].replace(/\s+/g, '').trim() : null;
  }

  // ── Bước 7: Bóc tách lời nhắn ────────────────────────────────────────────
  let message = null;
  const messageMatch = MESSAGE_REGEX.exec(fullText);
  if (messageMatch) {
    message = messageMatch[1].trim().replace(/\.$/, ''); // bỏ dấu chấm cuối
  }

  // ── Bước 8: Bóc tách mã giao dịch ────────────────────────────────────────
  let momoTransId = null;
  const transMatch = TRANS_ID_REGEX.exec(fullText);
  if (transMatch) {
    momoTransId = transMatch[1].trim();
  }

  // Fallback: sinh mã hash nếu không tìm thấy Mã GD
  if (!momoTransId) {
    momoTransId = generateFallbackTransId(ts, amount, senderName);
  }

  // ── Kết quả ──────────────────────────────────────────────────────────────
  return {
    status: 'PARSED',
    data: {
      momoTransId,
      senderName,
      senderPhone,
      amount,
      message,
      rawText: fullText,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: lọc từ cấm trong lời nhắn
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thay thế các từ cấm trong chuỗi bằng '***'
 * Khớp case-insensitive, khớp toàn từ
 *
 * @param {string|null} text
 * @param {string[]} badWords - danh sách từ cấm từ DB
 * @returns {string|null}
 */
function filterBadWords(text, badWords = []) {
  if (!text || !badWords.length) return text;

  let filtered = text;
  for (const word of badWords) {
    if (!word || word.trim() === '') continue;
    // Escape regex special chars trong bad word
    const escaped = word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    filtered = filtered.replace(regex, '***');
  }
  return filtered;
}

module.exports = {
  parseMomoNotification,
  filterBadWords,
  // Export các helper để unit test
  _parseAmount: parseAmount,
  _generateFallbackTransId: generateFallbackTransId,
};
