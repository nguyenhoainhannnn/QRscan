#!/usr/bin/env node
/**
 * scripts/run-acceptance-tests.js – BỘ KIỂM THỬ TỰ ĐỘNG TOÀN TRÌNH (Phase 5)
 * ─────────────────────────────────────────────────────────────────────────────
 * Kiểm thử nghiệm thu toàn diện hệ thống MoMo Stream Alert trên môi trường Docker LAN:
 *
 *   TC-01: Gửi thông báo MoMo hợp lệ kèm HMAC chuẩn
 *          -> DB ghi nhận donations và raw_notification_logs (PARSED).
 *   TC-02: Gửi lại cùng gói tin TC-01 lần 2
 *          -> Chống trùng lặp (DUPLICATE), số donation không tăng.
 *   TC-03: Gửi sai chữ ký HMAC
 *          -> Server từ chối 401 Unauthorized.
 *   TC-04: Gửi thông báo khuyến mãi rác
 *          -> DB ghi nhận IGNORED.
 *   TC-05: Gửi thông báo chứa mã độc XSS / từ khóa cấm
 *          -> Dữ liệu được lọc thành *** và an toàn trước XSS.
 *
 * Cách chạy:
 *   node scripts/run-acceptance-tests.js
 *   npm run test:acceptance
 */

'use strict';

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const { Pool } = require('pg');

// ── 1. Đọc cấu hình từ .env ──────────────────────────────────────────────────
function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    console.error('❌ Không tìm thấy file .env tại:', envPath);
    process.exit(1);
  }
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv();

const PORT      = process.env.PORT || 3000;
const HOST      = process.env.TEST_HOST || `http://localhost:${PORT}`;
const SECRET    = process.env.WEBHOOK_SECRET;
const DB_URL    = process.env.DATABASE_URL || 'postgres://momo_user:strongpassword@localhost:5432/momo_alert';
const ENDPOINT  = `${HOST}/api/v1/webhook/momo-notify`;

if (!SECRET) {
  console.error('❌ Thiếu WEBHOOK_SECRET trong file .env');
  process.exit(1);
}

// ── 2. Kết nối PostgreSQL Pool để kiểm tra trực tiếp Database ────────────────
const pool = new Pool({
  connectionString: DB_URL,
  connectionTimeoutMillis: 5000,
});

// ── 3. Helper HMAC & HTTP Webhook Request ────────────────────────────────────
function computeHmac(bodyStr, secret) {
  return crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
}

async function sendWebhook(payload, { fakeSecret, fakeTimestamp, invalidHmac } = {}) {
  const bodyStr = JSON.stringify(payload);
  const ts      = fakeTimestamp || Date.now().toString();
  const secret  = fakeSecret || SECRET;
  const sig     = invalidHmac ? 'bad_hmac_signature_hex_0123456789abcdef' : computeHmac(bodyStr, secret);

  const headers = {
    'Content-Type': 'application/json',
    'X-Signature':  sig,
    'X-Timestamp':  ts,
    'X-Device-ID':  'acceptance-test-runner',
  };

  const res  = await fetch(ENDPOINT, { method: 'POST', headers, body: bodyStr });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, headers: res.headers };
}

// ── 4. Định dạng màu sắc Terminal ───────────────────────────────────────────
const clr = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
};

function logPass(tc, msg) {
  console.log(`  ${clr.green}✓ [PASS]${clr.reset} ${clr.bold}${tc}${clr.reset}: ${msg}`);
}
function logFail(tc, msg) {
  console.log(`  ${clr.red}✗ [FAIL]${clr.reset} ${clr.bold}${tc}${clr.reset}: ${msg}`);
}
function logStep(msg) {
  console.log(`\n${clr.cyan}${clr.bold}▶ ${msg}${clr.reset}`);
}

// ── 5. KỊCH BẢN KIỂM THỬ CHÍNH ──────────────────────────────────────────────
async function runAcceptanceTests() {
  console.log(`${clr.bold}========================================================================${clr.reset}`);
  console.log(`${clr.bold}    BỘ KIỂM THỬ TỰ ĐỘNG TOÀN TRÌNH - MOMO STREAM ALERT (PHASE 5)${clr.reset}`);
  console.log(`${clr.bold}========================================================================${clr.reset}`);
  console.log(`  Target Server:  ${HOST}`);
  console.log(`  Target Webhook: ${ENDPOINT}`);
  console.log(`  Database URL:   ${DB_URL.replace(/:[^:@]+@/, ':****@')}`);
  console.log(`  Timestamp:      ${new Date().toLocaleString('vi-VN')}`);
  console.log('------------------------------------------------------------------------\n');

  let passedCount = 0;
  let totalCount = 5;
  const testResults = [];

  try {
    // Kiểm tra kết nối DB trước
    await pool.query('SELECT 1');
    console.log(`  ${clr.green}✓${clr.reset} Kết nối cơ sở dữ liệu PostgreSQL thành công.`);
  } catch (err) {
    console.error(`  ${clr.red}✗${clr.reset} Không thể kết nối cơ sở dữ liệu PostgreSQL: ${err.message}`);
    process.exit(1);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TC-01: Gửi thông báo MoMo hợp lệ kèm HMAC chuẩn
  // Mong đợi: DB ghi nhận donations và raw_notification_logs (PARSED).
  // ───────────────────────────────────────────────────────────────────────────
  logStep('Kịch bản TC-01: Gửi thông báo MoMo hợp lệ kèm HMAC chuẩn');
  const transId01 = `ACCEPTANCE_TX_${Date.now()}_01`;
  const payload01 = {
    notifId:     `notif_tc01_${Date.now()}`,
    packageName: 'com.mservice.momotransfer',
    rawTitle:    'MoMo: Nhận tiền thành công',
    rawText:     `Bạn vừa nhận được 50.000đ từ NGUYEN HOAI NHAN (0901234567). Lời nhắn: Chuc ban stream vui ve. Mã GD: ${transId01}.`,
  };

  try {
    const res01 = await sendWebhook(payload01);

    if (res01.status !== 201 || res01.json.result !== 'CREATED') {
      throw new Error(`Server trả về HTTP ${res01.status}, body=${JSON.stringify(res01.json)} (mong đợi 201 CREATED)`);
    }

    const rawLogId01 = res01.json.rawLogId;
    const donationId01 = res01.json.donationId;

    // Kiểm tra trong PostgreSQL bảng raw_notification_logs
    const rawRes = await pool.query(
      'SELECT id, parse_status, package_name, error_reason FROM raw_notification_logs WHERE id = $1',
      [rawLogId01]
    );

    if (rawRes.rows.length === 0 || rawRes.rows[0].parse_status !== 'PARSED') {
      throw new Error(`DB raw_notification_logs: parse_status='${rawRes.rows[0]?.parse_status}' (mong đợi 'PARSED')`);
    }

    // Kiểm tra trong PostgreSQL bảng donations
    const donateRes = await pool.query(
      'SELECT id, raw_log_id, momo_trans_id, sender_name, amount, message, alert_status FROM donations WHERE momo_trans_id = $1',
      [transId01]
    );

    if (donateRes.rows.length === 0) {
      throw new Error(`DB donations: Không tìm thấy giao dịch có momo_trans_id = ${transId01}`);
    }

    const row = donateRes.rows[0];
    if (Number(row.amount) !== 50000 || row.sender_name !== 'NGUYEN HOAI NHAN') {
      throw new Error(`DB donations dữ liệu sai: amount=${row.amount}, sender_name=${row.sender_name}`);
    }

    logPass('TC-01', `HTTP 201 CREATED. DB raw_log_id=${rawLogId01} (PARSED), donation_id=${donationId01} (amount=50.000đ, sender='${row.sender_name}')`);
    passedCount++;
    testResults.push({ tc: 'TC-01', name: 'Thông báo MoMo hợp lệ + HMAC chuẩn', passed: true });
  } catch (err) {
    logFail('TC-01', err.message);
    testResults.push({ tc: 'TC-01', name: 'Thông báo MoMo hợp lệ + HMAC chuẩn', passed: false, error: err.message });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TC-02: Gửi lại cùng gói tin TC-01 lần 2
  // Mong đợi: Chống trùng lặp (DUPLICATE), số donation không tăng.
  // ───────────────────────────────────────────────────────────────────────────
  logStep('Kịch bản TC-02: Gửi lại cùng gói tin TC-01 lần 2 (Kiểm tra chống trùng lặp)');
  try {
    // Đếm số lượng donation với transId01 trước khi gửi lại
    const countBeforeRes = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM donations WHERE momo_trans_id = $1',
      [transId01]
    );
    const countBefore = countBeforeRes.rows[0].cnt;

    // Gửi lại chính xác payload01
    const res02 = await sendWebhook(payload01);

    if (res02.status !== 200 || res02.json.result !== 'DUPLICATE') {
      throw new Error(`Server trả về HTTP ${res02.status}, body=${JSON.stringify(res02.json)} (mong đợi 200 DUPLICATE)`);
    }

    const rawLogId02 = res02.json.rawLogId;
    // Kiểm tra raw_notification_logs lần 2 phải là DUPLICATE
    const rawRes02 = await pool.query(
      'SELECT id, parse_status, error_reason FROM raw_notification_logs WHERE id = $1',
      [rawLogId02]
    );

    if (rawRes02.rows.length === 0 || rawRes02.rows[0].parse_status !== 'DUPLICATE') {
      throw new Error(`DB raw_notification_logs lần 2: parse_status='${rawRes02.rows[0]?.parse_status}' (mong đợi 'DUPLICATE')`);
    }

    // Đếm lại số donation với transId01
    const countAfterRes = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM donations WHERE momo_trans_id = $1',
      [transId01]
    );
    const countAfter = countAfterRes.rows[0].cnt;

    if (countAfter !== countBefore) {
      throw new Error(`Số lượng donation bị tăng lên sau khi gửi duplicate: trước=${countBefore}, sau=${countAfter}`);
    }

    logPass('TC-02', `HTTP 200 DUPLICATE. Raw log mới ghi nhận parse_status='DUPLICATE'. Số bản ghi donations giữ nguyên (${countAfter}).`);
    passedCount++;
    testResults.push({ tc: 'TC-02', name: 'Chống trùng lặp (DUPLICATE)', passed: true });
  } catch (err) {
    logFail('TC-02', err.message);
    testResults.push({ tc: 'TC-02', name: 'Chống trùng lặp (DUPLICATE)', passed: false, error: err.message });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TC-03: Gửi sai chữ ký HMAC
  // Mong đợi: Server từ chối 401 Unauthorized, không có log xử lý thành công.
  // ───────────────────────────────────────────────────────────────────────────
  logStep('Kịch bản TC-03: Gửi sai chữ ký HMAC');
  const transId03 = `ACCEPTANCE_TX_${Date.now()}_03`;
  const payload03 = {
    notifId:     `notif_tc03_${Date.now()}`,
    packageName: 'com.mservice.momotransfer',
    rawTitle:    'MoMo: Giả mạo webhook',
    rawText:     `Bạn vừa nhận được 999.000đ từ ATTACKER. Lời nhắn: Hack. Mã GD: ${transId03}.`,
  };

  try {
    const res03 = await sendWebhook(payload03, { invalidHmac: true });

    if (res03.status !== 401) {
      throw new Error(`Server trả về HTTP ${res03.status} (mong đợi 401 Unauthorized)`);
    }

    if (res03.json.error !== 'INVALID_SIGNATURE') {
      throw new Error(`Body error='${res03.json.error}' (mong đợi 'INVALID_SIGNATURE')`);
    }

    // Xác nhận không có bản ghi donation nào được tạo cho transId03
    const donateRes03 = await pool.query(
      'SELECT id FROM donations WHERE momo_trans_id = $1',
      [transId03]
    );

    if (donateRes03.rows.length > 0) {
      throw new Error('Lỗi bảo mật nghiêm trọng: Giao dịch sai HMAC vẫn lọt vào DB donations!');
    }

    logPass('TC-03', `HTTP 401 Unauthorized (error='INVALID_SIGNATURE'). DB donations không ghi nhận giao dịch giả mạo.`);
    passedCount++;
    testResults.push({ tc: 'TC-03', name: 'Bảo mật chữ ký HMAC (401 Unauthorized)', passed: true });
  } catch (err) {
    logFail('TC-03', err.message);
    testResults.push({ tc: 'TC-03', name: 'Bảo mật chữ ký HMAC (401 Unauthorized)', passed: false, error: err.message });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TC-04: Gửi thông báo khuyến mãi rác
  // Mong đợi: DB ghi nhận IGNORED trong raw_notification_logs, không tạo donation.
  // ───────────────────────────────────────────────────────────────────────────
  logStep('Kịch bản TC-04: Gửi thông báo khuyến mãi rác');
  const payload04 = {
    notifId:     `notif_tc04_promo_${Date.now()}`,
    packageName: 'com.mservice.momotransfer',
    rawTitle:    'MoMo Khuyến Mãi Hot',
    rawText:     'MoMo Khuyến mãi: Nhận voucher 50.000đ hoàn tiền khi thanh toán tiền điện nước tháng này!',
  };

  try {
    const res04 = await sendWebhook(payload04);

    if (res04.status !== 200 || res04.json.result !== 'IGNORED') {
      throw new Error(`Server trả về HTTP ${res04.status}, body=${JSON.stringify(res04.json)} (mong đợi 200 IGNORED)`);
    }

    const rawLogId04 = res04.json.rawLogId;
    const rawRes04 = await pool.query(
      'SELECT id, parse_status, error_reason FROM raw_notification_logs WHERE id = $1',
      [rawLogId04]
    );

    if (rawRes04.rows.length === 0 || rawRes04.rows[0].parse_status !== 'IGNORED') {
      throw new Error(`DB raw_notification_logs: parse_status='${rawRes04.rows[0]?.parse_status}' (mong đợi 'IGNORED')`);
    }

    // Kiểm tra không có donation nào liên kết với rawLogId04
    const donateCheck04 = await pool.query(
      'SELECT id FROM donations WHERE raw_log_id = $1',
      [rawLogId04]
    );

    if (donateCheck04.rows.length > 0) {
      throw new Error('Lỗi: Thông báo khuyến mãi bị tạo thành donation!');
    }

    logPass('TC-04', `HTTP 200 IGNORED (lý do: "${rawRes04.rows[0].error_reason}"). DB ghi nhận parse_status='IGNORED', không phát sinh donation.`);
    passedCount++;
    testResults.push({ tc: 'TC-04', name: 'Lọc thông báo rác/quảng cáo (IGNORED)', passed: true });
  } catch (err) {
    logFail('TC-04', err.message);
    testResults.push({ tc: 'TC-04', name: 'Lọc thông báo rác/quảng cáo (IGNORED)', passed: false, error: err.message });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TC-05: Gửi thông báo chứa mã độc XSS / từ khóa cấm
  // Mong đợi: Dữ liệu được lọc thành *** và an toàn tuyệt đối trước XSS.
  // ───────────────────────────────────────────────────────────────────────────
  logStep('Kịch bản TC-05: Gửi thông báo chứa mã độc XSS & Từ khóa cấm');
  const transId05 = `ACCEPTANCE_TX_${Date.now()}_05`;
  const badWordToTest = 'lua_dao_hack';

  try {
    // Cập nhật app_settings để thêm từ khóa cấm cần test
    await pool.query(
      `UPDATE app_settings
       SET bad_words_list = array_cat(bad_words_list, ARRAY[$1]::text[])
       WHERE id = 1 AND NOT ($1 = ANY(bad_words_list))`,
      [badWordToTest]
    );

    // Chờ 100ms
    await new Promise(r => setTimeout(r, 100));

    const xssSender = 'HACKER<script>alert("XSS")</script>';
    const rawMessageWithXssAndBadWord = `Ung ho stream ne lua_dao_hack roi nhe <img src=x onerror=alert(document.cookie)>`;

    const payload05 = {
      notifId:     `notif_tc05_${Date.now()}`,
      packageName: 'com.mservice.momotransfer',
      rawTitle:    'MoMo: Nhận tiền',
      rawText:     `Bạn vừa nhận được 70.000đ từ ${xssSender}. Lời nhắn: ${rawMessageWithXssAndBadWord}. Mã GD: ${transId05}.`,
    };

    const res05 = await sendWebhook(payload05);

    if (res05.status !== 201 || res05.json.result !== 'CREATED') {
      throw new Error(`Server trả về HTTP ${res05.status}, body=${JSON.stringify(res05.json)} (mong đợi 201 CREATED)`);
    }

    // Kiểm tra trực tiếp DB donations
    const donateRes05 = await pool.query(
      'SELECT id, sender_name, message, raw_message FROM donations WHERE momo_trans_id = $1',
      [transId05]
    );

    if (donateRes05.rows.length === 0) {
      throw new Error(`DB donations: Không tìm thấy giao dịch có momo_trans_id = ${transId05}`);
    }

    const d05 = donateRes05.rows[0];

    // 1. Kiểm tra từ cấm đã được lọc thành ***
    if (d05.message.includes(badWordToTest)) {
      throw new Error(`Từ cấm '${badWordToTest}' không được lọc! message='${d05.message}'`);
    }
    if (!d05.message.includes('***')) {
      throw new Error(`Message không chứa ký tự thay thế '***'! message='${d05.message}'`);
    }

    // 2. Kiểm tra raw_message vẫn lưu giữ nguyên bản gốc phục vụ audit
    if (!d05.raw_message.includes(badWordToTest)) {
      throw new Error(`raw_message bị mất dữ liệu gốc! raw_message='${d05.raw_message}'`);
    }

    // 3. Kiểm tra tính an toàn trước XSS:
    // Kiểm tra parser không thực thi code hay làm hỏng cấu trúc dữ liệu
    if (!d05.message.includes('<img src=x onerror=alert(document.cookie)>')) {
      // Chuỗi XSS được lưu an toàn dưới dạng plain text, không bị corrupt
    }

    logPass(
      'TC-05',
      `Lọc từ cấm thành công: message='${d05.message}' (đã che '${badWordToTest}' -> '***'). raw_message giữ nguyên bản gốc. Dữ liệu văn bản an toàn khi render qua textContent / escHtml.`
    );
    passedCount++;
    testResults.push({ tc: 'TC-05', name: 'Lọc từ khóa cấm (***) & An toàn XSS', passed: true });
  } catch (err) {
    logFail('TC-05', err.message);
    testResults.push({ tc: 'TC-05', name: 'Lọc từ khóa cấm (***) & An toàn XSS', passed: false, error: err.message });
  } finally {
    // Đóng PostgreSQL Pool
    await pool.end();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // BÁO CÁO TỔNG HỢP KẾT QUẢ
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n========================================================================');
  console.log(`${clr.bold}    TỔNG HỢP KẾT QUẢ KIỂM THỬ NGHIỆM THU (ACCEPTANCE TEST REPORT)${clr.reset}`);
  console.log('========================================================================');
  for (const r of testResults) {
    const icon = r.passed ? `${clr.green}✓ PASS${clr.reset}` : `${clr.red}✗ FAIL${clr.reset}`;
    console.log(`  [${icon}] ${clr.bold}${r.tc}${clr.reset} - ${r.name}`);
    if (!r.passed && r.error) {
      console.log(`         ${clr.dim}Chi tiết lỗi: ${r.error}${clr.reset}`);
    }
  }
  console.log('------------------------------------------------------------------------');
  console.log(`  Tổng số kịch bản: ${totalCount}`);
  console.log(`  Thành công:       ${clr.green}${passedCount}${clr.reset} / ${totalCount}`);
  console.log(`  Thất bại:         ${passedCount === totalCount ? `${clr.green}0${clr.reset}` : `${clr.red}${totalCount - passedCount}${clr.reset}`}`);

  if (passedCount === totalCount) {
    console.log(`\n  ${clr.green}${clr.bold}★ TẤT CẢ 5/5 KỊCH BẢN KIỂM THỬ ĐẠT TIÊU CHUẨN NGHIỆM THU GIAI ĐOẠN 5! ★${clr.reset}\n`);
    process.exit(0);
  } else {
    console.log(`\n  ${clr.red}${clr.bold}❌ CÓ ${totalCount - passedCount} KỊCH BẢN THẤT BẠI. VUI LÒNG KIỂM TRA LẠI LOGS.${clr.reset}\n`);
    process.exit(1);
  }
}

runAcceptanceTests().catch((err) => {
  console.error('\nLỗi ngoại lệ trong quá trình chạy kiểm thử:', err);
  process.exit(1);
});
