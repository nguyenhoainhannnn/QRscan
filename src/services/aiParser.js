'use strict';

/**
 * AI Notification Parser – Tận dụng mô hình SLM (Qwen 2.5) qua Ollama
 * để bóc tách thông tin giao dịch nhận tiền từ ngân hàng / ví điện tử.
 *
 * Tích hợp cơ chế:
 * 1. AI Parsing: Trích xuất Người gửi, Số tiền, Ngân hàng, Mã GD, Lời nhắn.
 * 2. Accent Restoration: Tự động khôi phục dấu tiếng Việt cho lời nhắn (tien nuoc -> tiền nước).
 * 3. Fallback: Nếu AI lỗi hoặc quá thời gian chờ, tự động rơi về Regex Parser truyền thống.
 */

const http = require('http');
const logger = require('./logger');
const { parseMomoNotification } = require('./momoParser');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://ollama:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';
const AI_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '10000', 10);

const SYSTEM_PROMPT = `Bạn là chuyên gia AI phân tích thông báo biến động số dư ngân hàng và ví điện tử tại Việt Nam.
Nhiệm vụ: Trích xuất thông tin nhận tiền thành 1 JSON object.

QUY TẮC BẮT BUỘC:
1. is_valid_donation (boolean):
   - true: Nếu nhận tiền / cộng tiền (+)
   - false: Nếu trừ tiền (-), thanh toán hóa đơn, nạp rút, quảng cáo, khuyến mãi.
2. amount (number): Số tiền nhận (VD: 10000, 50000). Không kèm chữ VND hay dấu chấm.
3. sender_name (string): Tên người gửi tiền thực tế.
   - Nếu có "CT tu [STK] [TÊN GỬI] toi [STK] [TÊN NHẬN]", BẮT BUỘC lấy đúng [TÊN GỬI], không lấy tên người nhận.
4. bank_name (string): Tên ngân hàng gửi (Vietcombank, Techcombank, MBBank, VNPAY, MoMo...).
5. message (string): Lời nhắn của người gửi.
   - BẮT BUỘC: Bỏ hết mã hệ thống ("MBVCB...", "Ref...", "CT tu ... toi ..."), chỉ giữ lời nhắn của người chuyển.
   - BẮT BUỘC: Viết lại lời nhắn CÓ DẤU TIẾNG VIỆT CHUẨN (Ví dụ: "tien nuoc" PHẢI viết thành "tiền nước", "ung ho streamer" -> "ủng hộ streamer").
   - Nếu không có lời nhắn của người chuyển, để rỗng "".
6. trans_id (string): Mã giao dịch (VD: "16572433113", "6289BFTVGLCJZP18"). Nếu không có thì null.

VÍ DỤ MẪU:
Đầu vào: "So du TK VCB 0441000784711 +10,000 VND luc 16-10-2026 20:30:22. So du 14,000 VND. Ref MBVCB.16572433113.6289BFTVGLCJZP18.tien nuoc.CT tu 0441000784711 NGUYEN HOAI NHAN toi 0783694473 NGUYEN HOAI NHAN tai VNPAY"
Đầu ra JSON: {"is_valid_donation": true, "amount": 10000, "sender_name": "NGUYEN HOAI NHAN", "bank_name": "Vietcombank", "message": "tiền nước", "trans_id": "16572433113"}

Đầu vào: "GD: +10,000VND tai 16/10/26 19:39. ND: TECHCOMBANK (*6018)-NGUYEN HOAI NHAN-chuc ban buoi toi vui ve. So du: 14,000VND"
Đầu ra JSON: {"is_valid_donation": true, "amount": 10000, "sender_name": "NGUYEN HOAI NHAN", "bank_name": "Techcombank", "message": "chúc bạn buổi tối vui vẻ", "trans_id": null}

Đầu vào: "So du TK VCB 0441000784711 -50,000 VND luc 16-10-2026 21:00. Thanh toan hoa don Internet"
Đầu ra JSON: {"is_valid_donation": false, "amount": 0, "sender_name": "", "bank_name": "", "message": "", "trans_id": null}

Chỉ trả về DUY NHẤT 1 JSON object:
{"is_valid_donation": boolean, "amount": number, "sender_name": string, "bank_name": string, "message": string, "trans_id": string}`;

/**
 * Gọi Ollama API với format JSON và timeout
 */
function callOllama({ prompt, model = OLLAMA_MODEL, timeoutMs = AI_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL('/api/generate', OLLAMA_HOST);
    } catch (e) {
      return reject(new Error(`OLLAMA_HOST không hợp lệ: ${OLLAMA_HOST}`));
    }

    const postData = JSON.stringify({
      model,
      prompt,
      system: SYSTEM_PROMPT,
      format: 'json',
      stream: false,
      options: {
        temperature: 0.1, // Nhiệt độ thấp để đảm bảo tính chính xác cao
        top_p: 0.9,
      },
    });

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 11434,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: timeoutMs,
    };

    const req = http.request(options, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Ollama HTTP ${res.statusCode}: ${responseBody}`));
        }
        try {
          const parsedRes = JSON.parse(responseBody);
          const aiJson = JSON.parse(parsedRes.response);
          resolve(aiJson);
        } catch (err) {
          reject(new Error(`Không thể parse JSON từ phản hồi Ollama: ${err.message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Ollama request bị timeout sau ${timeoutMs}ms`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Phân tích thông báo bằng AI, tự động fallback về Regex nếu có sự cố
 */
async function parseNotificationSmart({ rawTitle, rawText, packageName, timestamp }) {
  const ts = timestamp || Date.now();
  const startTime = Date.now();

  const userPrompt = `Tiêu đề: ${rawTitle || ''}\nNội dung: ${rawText || ''}\nPackage: ${packageName || ''}`;

  try {
    logger.debug('Bắt đầu phân tích thông báo bằng AI Model:', { model: OLLAMA_MODEL });
    const aiResult = await callOllama({ prompt: userPrompt });
    const duration = Date.now() - startTime;
    logger.info(`AI phân tích hoàn tất trong ${duration}ms`, { aiResult });

    if (!aiResult || typeof aiResult !== 'object') {
      throw new Error('AI trả về kết quả rỗng hoặc sai cấu trúc');
    }

    const isValid = aiResult.is_valid_donation === true || aiResult.is_valid_donation === 'true';
    const numAmount = Math.round(Number(aiResult.amount) || 0);

    if (!isValid || numAmount <= 0) {
      return {
        status: 'IGNORED',
        reason: 'Không phải giao dịch nhận tiền hợp lệ (tiền ra hoặc không có số tiền dương)',
        aiDurationMs: duration,
      };
    }

    // Tên hiển thị người gửi
    let senderName = (aiResult.sender_name || '').trim();
    if (aiResult.bank_name && !senderName.includes(aiResult.bank_name)) {
      const shortBank = aiResult.bank_name.replace(/Vietcombank/i, 'VCB').replace(/Techcombank/i, 'TCB');
      senderName = `${senderName} (${shortBank})`;
    }
    if (!senderName) {
      senderName = 'Người ủng hộ';
    }

    const momoTransId = aiResult.trans_id
      ? String(aiResult.trans_id).trim()
      : `AI_${Date.now()}_${aiResult.amount}`;

    return {
      status: 'PARSED',
      source: 'AI_MODEL',
      aiDurationMs: duration,
      data: {
        momoTransId,
        senderName,
        senderPhone: null,
        amount: Math.round(Number(aiResult.amount)),
        message: aiResult.message ? aiResult.message.trim() : null,
        rawText,
      },
    };
  } catch (err) {
    logger.warn(`AI Parser gặp lỗi (${err.message}) -> Tự động Fallback sang Regex Engine`, {
      durationMs: Date.now() - startTime,
    });

    // Fallback an toàn về Regex Engine
    const fallbackResult = parseMomoNotification({ rawTitle, rawText, packageName, timestamp: ts });
    return {
      ...fallbackResult,
      source: 'REGEX_FALLBACK',
      fallbackReason: err.message,
    };
  }
}

module.exports = {
  parseNotificationSmart,
  callOllama,
  SYSTEM_PROMPT,
};
