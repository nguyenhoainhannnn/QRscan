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
  /nhận tiền từ/i,
  /số tiền:\s*[\d]/i,
  /số tiền giao dịch:\s*\+/i,
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
  /số dư:/i,              // thông báo số dư đơn thuần (MoMo)
];

// ─────────────────────────────────────────────────────────────────────────────
// Regex bóc tách thông tin chính (MoMo)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bóc tách số tiền – hỗ trợ cả dấu chấm (50.000) và dấu phẩy (20,000)
 * Cũng xử lý ký hiệu VNĐ: đ, ₫, vnđ, VND, đồng
 */
const AMOUNT_REGEX = /(?:cộng\s*\+|nhận được\s*|số tiền:\s*)\s*([\d][,.\s\d]*)\s*(?:đ|₫|vnđ|vnd|đồng)?/i;

/**
 * Bóc tách tên người gửi và số điện thoại (tuỳ chọn)
 * Mẫu: "từ NGUYEN VAN A (090xxxx123)" hoặc "Nhận tiền từ Nguyễn Văn A"
 */
const SENDER_REGEX = /(?:từ|nhận tiền từ)\s+([A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠƯẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸ][A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠƯẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸa-zàáâãèéêìíòóôõùúăđĩũơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ\s]+?)(?:\s*\((\+?[\d\s\-x]{8,15})\))?\s*(?:\.|,|Lời nhắn|Nội dung|Mã GD|Mã giao dịch|Số tiền:|$)/i;

/**
 * Bóc tách lời nhắn / nội dung
 * Hỗ trợ cả "Lời nhắn:" và "Nội dung:"
 */
const MESSAGE_REGEX = /(?:lời nhắn|nội dung)\s*:\s*(.+?)(?:\s*[.\n]?\s*(?:Mã GD|Mã giao dịch)|$)/i;

/**
 * Bóc tách mã giao dịch MoMo
 */
const TRANS_ID_REGEX = /(?:mã\s+gd|mã\s+giao\s+dịch|ref)\s*:\s*([A-Z0-9_-]+)/i;

// ─────────────────────────────────────────────────────────────────────────────
// Parser chuyên dụng cho VNPAY
// ─────────────────────────────────────────────────────────────────────────────
function parseVnpayNotification({ title, text, pkg, ts }) {
  // 1. Kiểm tra tiền vào (+) hay trừ tiền (-)
  if (/Số tiền giao dịch[:\s]*-/i.test(text)) {
    return {
      status: 'IGNORED',
      reason: 'Giao dịch trừ tiền / thanh toán VNPAY (-)',
    };
  }

  // Chấp nhận: "Số tiền giao dịch: +10.000 VND", "Số tiền giao dịch +10.000 VND", "+ 8.000 VNĐ", v.v.
  if (!/Số tiền giao dịch[:\s]*\+/i.test(text) && !/\+\s*[\d.,]+\s*(?:VNĐ|VND|đ|₫)/i.test(text)) {
    return {
      status: 'IGNORED',
      reason: 'Không tìm thấy dấu cộng tiền (+) trong thông báo VNPAY',
    };
  }

  // 2. Bóc tách số tiền
  const amountMatch = /Số tiền giao dịch[:\s]*\+\s*([\d.,\s]+)\s*(?:VNĐ|VND|đ|₫)?/i.exec(text)
    || /\+\s*([\d.,\s]+)\s*(?:VNĐ|VND|đ|₫)/i.exec(text);

  if (!amountMatch) {
    return {
      status: 'FAILED_REGEX',
      reason: 'Không bóc tách được số tiền từ thông báo VNPAY',
    };
  }

  const amount = parseAmount(amountMatch[1]);
  if (!amount || amount <= 0) {
    return {
      status: 'FAILED_REGEX',
      reason: `Số tiền không hợp lệ: "${amountMatch[1]}"`,
    };
  }

  // 3. Bóc tách Mã giao dịch (FT... hoặc mã số)
  const ftMatch = /\b(FT\d+)\b/i.exec(text) || /(?:Mã GD|Mã giao dịch):\s*([A-Z0-9]+)/i.exec(text);
  let momoTransId = ftMatch ? ftMatch[1].trim() : null;

  // 4. Bóc tách Nội dung & Người gửi
  const contentMatch = /Nội dung[:\s]*(.+?)(?:\r?\n\s*FT|\r?\n|$)/is.exec(text);
  const rawContent = contentMatch ? contentMatch[1].trim() : '';

  let senderName = 'Khách VNPAY';
  let message = rawContent || null;

  if (rawContent) {
    let body = rawContent;
    let bankName = null;
    let bankAcc = null;

    // Pattern header ngân hàng:
    // "Nhan tien: Vietcombank - **********4711: ..."
    // "Nhan tien: Techcombank _ **********6018: ..."
    const bankHeaderMatch = /^Nhan tien:\s*([^:_-]+?)\s*(?:[-_]\s*([^\s:]+?))?:\s*(.+)$/is.exec(rawContent);
    if (bankHeaderMatch) {
      bankName = bankHeaderMatch[1].trim();
      bankAcc = bankHeaderMatch[2] ? bankHeaderMatch[2].replace(/\*+/g, '').trim() : '';
      body = bankHeaderMatch[3].trim();
    }

    // A. Bóc tách tên người gửi từ cụm Napas 247:
    // ".CT tu 0441000784711 NGUYEN HOAI NHAN toi 0783694473 NGUYEN HOAI NHAN tai VNPAY"
    // hoặc "CT tu [STK] [TÊN] toi ..."
    const ctTuMatch = /\.CT tu\s+(?:[A-Za-z0-9]+)?\s+([A-ZÀ-Ỹ\s]+?)\s+toi\s+/i.exec(body)
      || /CT tu\s+(?:[A-Za-z0-9]+)?\s+([A-ZÀ-Ỹ\s]+?)\s+toi\s+/i.exec(body);

    if (ctTuMatch) {
      senderName = ctTuMatch[1].trim();
      // Cắt bỏ phần thông tin Napas phía sau khỏi message
      body = body.substring(0, ctTuMatch.index).trim();
    }

    // B. Xử lý mã giao dịch Vietcombank nếu không có mã FT:
    // "MBVCB.16572433113.6289BFTVGLCJZP18.tien nuoc..."
    const vcbMatch = /^MBVCB\.([0-9]+)\.([A-Za-z0-9]+)\.(.*)$/is.exec(body);
    if (vcbMatch) {
      if (!momoTransId) {
        momoTransId = `VCB_${vcbMatch[1]}`;
      }
      body = vcbMatch[3].trim();
    } else {
      // Cắt các tiền tố mã giao dịch dạng [MÃ].[Lời nhắn]
      const prefixCodeMatch = /^(?:[A-Za-z0-9_-]{8,})\.(.*)$/is.exec(body);
      if (prefixCodeMatch) {
        body = prefixCodeMatch[1].trim();
      }
    }

    // C. Xử lý VNPAY to VNPAY (Ví sang Ví):
    // 1) "[Tên người gửi] chuyen tien: [lời nhắn]"
    const p2pMatch1 = /^(.+?)\s+(?:chuyen tien|chuyển tiền):\s*(.+)$/is.exec(body);
    if (p2pMatch1) {
      senderName = p2pMatch1[1].trim();
      body = p2pMatch1[2].trim();
    } else {
      // 2) "Nhan tien tu ví [SĐT] - [Tên]: [lời nhắn]" hoặc "Nhan tien tu [Tên]: [lời nhắn]"
      const p2pMatch2 = /^(?:nhan tien tu|nhận tiền từ)(?:\s+ví\s+[\d]+)?(?:\s*-\s*)?\s*([^:]+?):\s*(.+)$/is.exec(body);
      if (p2pMatch2) {
        senderName = p2pMatch2[1].trim();
        body = p2pMatch2[2].trim();
      }
    }

    // D. Gán tên hiển thị:
    if (senderName === 'Khách VNPAY' && bankName) {
      const accSuffix = bankAcc ? ` (*${bankAcc})` : '';
      senderName = `${bankName}${accSuffix}`;
    } else if (senderName !== 'Khách VNPAY' && bankName) {
      // Chuẩn hóa tên viết tắt ngân hàng nếu có tên người thật: "NGUYEN HOAI NHAN (VCB)"
      const shortBank = bankName.replace(/Vietcombank/i, 'VCB')
                                .replace(/Techcombank/i, 'TCB');
      senderName = `${senderName} (${shortBank})`;
    }

    message = body.trim() || null;
  }

  // Fallback transId nếu không tìm thấy mã FT hay VCB
  if (!momoTransId) {
    momoTransId = generateFallbackTransId(ts, amount, senderName);
  }

  return {
    status: 'PARSED',
    data: {
      momoTransId,
      senderName,
      senderPhone: null,
      amount,
      message,
      rawText: text,
    },
  };
}

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

  // ── Kiểm tra thông báo VNPAY ──────────────────────────────────────────
  const isVnpay = pkg.includes('vnpay')
    || title.includes('VNPAY')
    || text.includes('VNPAY')
    || text.includes('Số tiền giao dịch:');

  if (isVnpay) {
    return parseVnpayNotification({ title, text, pkg, ts });
  }

  // ── Bước 1: Kiểm tra package name cho MoMo ──────────────────────────────
  if (pkg && !pkg.includes('mservice') && !pkg.includes('momo')) {
    return {
      status: 'IGNORED',
      reason: `Package không được hỗ trợ: ${packageName}`,
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
  if (message && /vào chat để xem/i.test(message)) {
    message = null;
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
