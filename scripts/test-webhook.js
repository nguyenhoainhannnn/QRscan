#!/usr/bin/env node
/**
 * test-webhook.js – Script kiểm thử Webhook MoMo Alert
 * ─────────────────────────────────────────────────────
 * Tự động tính HMAC-SHA256, bắn nhiều loại request khác nhau vào API.
 *
 * Sử dụng:
 *   node scripts/test-webhook.js
 *   node scripts/test-webhook.js --host http://localhost:3000
 *   node scripts/test-webhook.js --verbose
 *
 * Yêu cầu: Node.js >= 20 (built-in fetch), không cần cài thêm package.
 */

'use strict';

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

// ── Load .env thủ công (không dùng dotenv để script độc lập) ─────────────────
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

// ── Cấu hình ─────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const getArg   = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const VERBOSE  = args.includes('--verbose') || args.includes('-v');
const HOST     = getArg('--host') || `http://localhost:${process.env.PORT || 3000}`;
const SECRET   = process.env.WEBHOOK_SECRET;
const ENDPOINT = `${HOST}/api/v1/webhook/momo-notify`;

if (!SECRET) {
  console.error('❌ WEBHOOK_SECRET chưa được set trong .env');
  process.exit(1);
}

// ── Helper: tạo chữ ký HMAC-SHA256 ──────────────────────────────────────────
function computeHmac(body, secret) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
}

// ── Helper: gửi request có chữ ký ───────────────────────────────────────────
async function sendWebhook(payload, options = {}) {
  const bodyStr  = JSON.stringify(payload);
  const ts       = options.fakeTimestamp || Date.now().toString();
  const secret   = options.fakeSecret   || SECRET;
  const sig      = computeHmac(bodyStr, secret);

  const headers = {
    'Content-Type': 'application/json',
    'X-Signature':  sig,
    'X-Timestamp':  ts,
    'X-Device-ID':  'test-device-001',
    ...options.extraHeaders,
  };

  if (VERBOSE) {
    console.log('\n  Headers:', JSON.stringify(headers, null, 2));
    console.log('  Body:', bodyStr);
  }

  const res  = await fetch(ENDPOINT, { method: 'POST', headers, body: bodyStr });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ── Màu sắc terminal ─────────────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
};

function pass(msg) { console.log(`  ${c.green}✓ PASS${c.reset}  ${msg}`); }
function fail(msg) { console.log(`  ${c.red}✗ FAIL${c.reset}  ${msg}`); }
function info(msg) { console.log(`  ${c.cyan}ℹ${c.reset}      ${msg}`); }

// ── Danh sách test cases ─────────────────────────────────────────────────────
const TEST_CASES = [
  // ─── TC01: Giao dịch hợp lệ mẫu 1 ──────────────────────────────────────
  {
    name: 'TC01 – Giao dịch hợp lệ mẫu 1 (nhận được + Mã GD + lời nhắn)',
    payload: {
      notifId:     `test_notif_${Date.now()}`,
      packageName: 'com.mservice.momotransfer',
      rawTitle:    'MoMo: Nhận tiền thành công',
      rawText:     `Bạn vừa nhận được 50.000đ từ NGUYEN VAN A (0901234567). Lời nhắn: Chuc ban stream vui. Mã GD: ${Date.now()}.`,
    },
    expect: (s, j) => {
      const ok = (s === 201 || s === 200) && (j.result === 'CREATED' || j.result === 'DUPLICATE');
      return [ok, `status=${s}, result=${j.result}, donationId=${j.donationId}`];
    },
  },

  // ─── TC02: Giao dịch hợp lệ mẫu 2 ──────────────────────────────────────
  {
    name: 'TC02 – Giao dịch hợp lệ mẫu 2 (cộng +, dấu phẩy, Nội dung)',
    payload: {
      notifId:     `test_notif_${Date.now() + 1}`,
      packageName: 'com.mservice.momotransfer',
      rawTitle:    'Số dư MoMo thay đổi',
      rawText:     `Tài khoản của bạn vừa được cộng +20,000đ từ TRAN THI B. Nội dung: Ung ho anh stream. Mã giao dịch: ${Date.now() + 1}`,
    },
    expect: (s, j) => {
      const ok = (s === 201 || s === 200) && (j.result === 'CREATED' || j.result === 'DUPLICATE');
      return [ok, `status=${s}, result=${j.result}`];
    },
  },

  // ─── TC03: Không có lời nhắn, không có Mã GD ─────────────────────────────
  {
    name: 'TC03 – Không có lời nhắn & Mã GD → sinh hash fallback',
    payload: {
      notifId:     `test_notif_${Date.now() + 2}`,
      packageName: 'com.mservice.momotransfer',
      rawTitle:    'Nhận tiền MoMo',
      rawText:     'Bạn vừa nhận được 15.000đ từ LE VAN C.',
    },
    expect: (s, j) => {
      // Có thể CREATED hoặc BELOW_MINIMUM nếu ngưỡng > 15000
      const ok = [200, 201].includes(s) &&
                 ['CREATED', 'DUPLICATE', 'BELOW_MINIMUM'].includes(j.result);
      return [ok, `status=${s}, result=${j.result}`];
    },
  },

  // ─── TC04: Thông báo khuyến mãi → IGNORED ────────────────────────────────
  {
    name: 'TC04 – Thông báo khuyến mãi → phải IGNORED',
    payload: {
      notifId:     `test_notif_promo_${Date.now()}`,
      packageName: 'com.mservice.momotransfer',
      rawTitle:    'MoMo Ưu đãi',
      rawText:     'MoMo Khuyến mãi: Hoàn tiền 20% khi thanh toán hóa đơn. Áp dụng đến hết tháng.',
    },
    expect: (s, j) => {
      const ok = s === 200 && j.result === 'IGNORED';
      return [ok, `status=${s}, result=${j.result}, reason="${j.reason}"`];
    },
  },

  // ─── TC05: Thông báo thanh toán → IGNORED ────────────────────────────────
  {
    name: 'TC05 – Thông báo thanh toán → phải IGNORED',
    payload: {
      notifId:     `test_notif_payment_${Date.now()}`,
      packageName: 'com.mservice.momotransfer',
      rawTitle:    'Thanh toán thành công',
      rawText:     'Thanh toán thành công 85.000đ tại Highlands Coffee. Mã GD: 00099988.',
    },
    expect: (s, j) => {
      const ok = s === 200 && j.result === 'IGNORED';
      return [ok, `status=${s}, result=${j.result}`];
    },
  },

  // ─── TC06: Số tiền lớn 1.500.000đ ────────────────────────────────────────
  {
    name: 'TC06 – Số tiền lớn 1.500.000đ',
    payload: {
      notifId:     `test_notif_big_${Date.now()}`,
      packageName: 'com.mservice.momotransfer',
      rawTitle:    'Nhận tiền MoMo',
      rawText:     `Bạn vừa nhận được 1.500.000đ từ PHAM VAN D. Lời nhắn: Top donate. Mã GD: ${Date.now() + 5}.`,
    },
    expect: (s, j) => {
      const ok = [200, 201].includes(s) && ['CREATED', 'DUPLICATE'].includes(j.result);
      return [ok, `status=${s}, amount=${j.data?.amount}`];
    },
  },

  // ─── TC07: Thiếu rawText → 400 ───────────────────────────────────────────
  {
    name: 'TC07 – Thiếu rawText → phải trả về 400',
    payload: {
      packageName: 'com.mservice.momotransfer',
      rawTitle:    'Test',
      // rawText bị thiếu cố ý
    },
    expect: (s, _j) => {
      const ok = s === 400;
      return [ok, `status=${s} (mong đợi 400)`];
    },
  },

  // ─── TC08: Chữ ký sai → 403 ──────────────────────────────────────────────
  {
    name: 'TC08 – Chữ ký HMAC sai → phải trả về 401 Unauthorized',
    payload: {
      packageName: 'com.mservice.momotransfer',
      rawText:     'Bạn vừa nhận được 50.000đ từ TEST.',
    },
    options: { fakeSecret: 'wrong_secret_key_haha' },
    expect: (s, _j) => {
      const ok = s === 401 || s === 403;
      return [ok, `status=${s} (mong đợi 401 Unauthorized)`];
    },
  },

  // ─── TC09: Timestamp cũ (> 5 phút) → 401 ────────────────────────────────
  {
    name: 'TC09 – Timestamp quá cũ → phải trả về 401',
    payload: {
      packageName: 'com.mservice.momotransfer',
      rawText:     'Bạn vừa nhận được 50.000đ từ TEST.',
    },
    options: { fakeTimestamp: (Date.now() - 10 * 60 * 1000).toString() }, // -10 phút
    expect: (s, j) => {
      const ok = s === 401 && j.error === 'TIMESTAMP_EXPIRED';
      return [ok, `status=${s}, error=${j.error}`];
    },
  },
];

// ── Test Overlay Token ────────────────────────────────────────────────────────
const OVERLAY_TOKEN = process.env.OBS_OVERLAY_TOKEN;

TEST_CASES.push(
  // ─── TC10: Overlay 403 sai token ─────────────────────────────────────────
  {
    name: 'TC10 – GET /overlay sai token → phải trả về 403',
    _isOverlayTest: true,
    _overlayToken: 'wrong_token_haha',
    expect: (s, _body) => {
      const ok = s === 403;
      return [ok, `status=${s} (mong đợi 403)`];
    },
  },

  // ─── TC11: Overlay 200 đúng token ────────────────────────────────────────
  {
    name: 'TC11 – GET /overlay đúng token → phải trả về 200 HTML',
    _isOverlayTest: true,
    _overlayToken: OVERLAY_TOKEN,
    expect: (s, _body) => {
      const ok = s === 200;
      return [ok, `status=${s} (mong đợi 200)`];
    },
  }
);

// ── Runner ───────────────────────────────────────────────────────────────────
async function runTests() {
  console.log(`\n${c.bold}${c.cyan}═══════════════════════════════════════════════════${c.reset}`);
  console.log(`${c.bold}  🧪 MoMo Alert Webhook Test Suite${c.reset}`);
  console.log(`${c.bold}${c.cyan}═══════════════════════════════════════════════════${c.reset}`);
  console.log(`  ${c.dim}Endpoint: ${ENDPOINT}${c.reset}`);
  console.log(`  ${c.dim}Secret:   ${SECRET.substring(0, 6)}...${c.reset}\n`);

  // Kiểm tra server đang chạy
  try {
    const healthRes = await fetch(`${HOST}/health`, { signal: AbortSignal.timeout(5000) });
    const health    = await healthRes.json();
    if (health.ok) {
      info(`Server health: ${c.green}OK${c.reset} | DB: ${health.db} | Uptime: ${Math.round(health.uptime)}s`);
    } else {
      fail('Server health check thất bại');
    }
  } catch (err) {
    console.error(`\n${c.red}❌ Không kết nối được server tại ${HOST}${c.reset}`);
    console.error(`   Hãy chạy: docker compose up -d\n`);
    process.exit(1);
  }

  console.log('');

  // ── Chế độ --fifo: Bắn 3 donate liên tiếp để kiểm tra hàng đợi FIFO ──────
  if (args.includes('--fifo')) {
    await runFifoTest();
    return;
  }

  let passed = 0, failed = 0;
  const results = [];

  for (const tc of TEST_CASES) {
    console.log(`${c.bold}  ▶ ${tc.name}${c.reset}`);
    try {
      let status, json;

      if (tc._isOverlayTest) {
        // Test overlay HTTP route trực tiếp
        const res = await fetch(
          `${HOST}/overlay?token=${encodeURIComponent(tc._overlayToken || '')}`,
          { signal: AbortSignal.timeout(5000) }
        );
        status = res.status;
        json   = {};
      } else {
        ({ status, json } = await sendWebhook(tc.payload, tc.options || {}));
      }

      const [isPass, detail] = tc.expect(status, json);

      if (isPass) {
        pass(detail);
        passed++;
      } else {
        fail(`${detail} | full response: ${JSON.stringify(json)}`);
        failed++;
      }
      results.push({ name: tc.name, pass: isPass, status, detail });

      if (VERBOSE) {
        info(`Response: ${JSON.stringify(json, null, 2)}`);
      }
    } catch (err) {
      fail(`Exception: ${err.message}`);
      failed++;
      results.push({ name: tc.name, pass: false, error: err.message });
    }
    console.log('');
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`${c.bold}${c.cyan}═══════════════════════════════════════════════════${c.reset}`);
  const total = passed + failed;
  const color = failed === 0 ? c.green : c.red;
  console.log(`  ${c.bold}Kết quả: ${color}${passed}/${total} PASSED${c.reset}${failed > 0 ? `, ${c.red}${failed} FAILED${c.reset}` : ''}`);
  console.log(`${c.bold}${c.cyan}═══════════════════════════════════════════════════${c.reset}\n`);

  if (failed > 0) {
    console.log(`${c.yellow}Tip: Chạy với --verbose để xem chi tiết request/response${c.reset}\n`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FIFO Queue Test – bắn 3 donate liên tiếp cách nhau 0.5s
// Dùng: node scripts/test-webhook.js --fifo
// Mục đích: kiểm tra hàng đợi FIFO trên OBS Overlay Browser Source
// ─────────────────────────────────────────────────────────────────────────────
async function runFifoTest() {
  const ts = Date.now();
  console.log(`\n${c.bold}${c.cyan}═══════════════════════════════════════════════════${c.reset}`);
  console.log(`${c.bold}  🎯 FIFO Queue Stress Test – 3 Donate liên tiếp${c.reset}`);
  console.log(`${c.bold}${c.cyan}═══════════════════════════════════════════════════${c.reset}`);
  console.log(`  ${c.dim}Bắn 3 donate, mỗi cái cách nhau 500ms${c.reset}`);
  console.log(`  ${c.dim}Mở http://localhost:${process.env.PORT || 3000}/overlay?token=${OVERLAY_TOKEN} trong OBS${c.reset}\n`);

  const FIFO_DONATIONS = [
    {
      label: 'Donate #1 (50.000đ – Nguyễn Văn A)',
      payload: {
        notifId:     `fifo_test_1_${ts}`,
        packageName: 'com.mservice.momotransfer',
        rawTitle:    'MoMo: Nhận tiền thành công',
        rawText:     `Bạn vừa nhận được 50.000đ từ NGUYEN VAN A (0901111111). Lời nhắn: Ủng hộ anh stream số 1 nha! Mã GD: FIFO_${ts}_1.`,
      },
    },
    {
      label: 'Donate #2 (100.000đ – Trần Thị B)',
      payload: {
        notifId:     `fifo_test_2_${ts}`,
        packageName: 'com.mservice.momotransfer',
        rawTitle:    'MoMo: Nhận tiền thành công',
        rawText:     `Bạn vừa nhận được 100.000đ từ TRAN THI B (0902222222). Lời nhắn: 100k giữ sức nhé boss! Mã GD: FIFO_${ts}_2.`,
      },
    },
    {
      label: 'Donate #3 (200.000đ – Lê Văn C – Top Donate)',
      payload: {
        notifId:     `fifo_test_3_${ts}`,
        packageName: 'com.mservice.momotransfer',
        rawTitle:    'MoMo: Nhận tiền thành công',
        rawText:     `Bạn vừa nhận được 200.000đ từ LE VAN C (0903333333). Lời nhắn: 200k top donate buổi hôm nay! Mã GD: FIFO_${ts}_3.`,
      },
    },
  ];

  let allPass = true;
  const donationIds = [];

  for (let i = 0; i < FIFO_DONATIONS.length; i++) {
    const { label, payload } = FIFO_DONATIONS[i];
    console.log(`${c.bold}  ▶ ${label}${c.reset}`);

    try {
      const { status, json } = await sendWebhook(payload);
      const isCreated = [200, 201].includes(status) && ['CREATED', 'DUPLICATE'].includes(json.result);

      if (isCreated) {
        pass(`status=${status}, donationId=${json.donationId}, result=${json.result}`);
        if (json.donationId) donationIds.push(json.donationId);
      } else {
        fail(`status=${status}, result=${json.result} | ${JSON.stringify(json)}`);
        allPass = false;
      }
    } catch (err) {
      fail(`Exception: ${err.message}`);
      allPass = false;
    }

    console.log('');

    // Đợi 500ms trước khi bắn donate tiếp theo
    if (i < FIFO_DONATIONS.length - 1) {
      info(`${c.dim}Đợi 500ms...${c.reset}`);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // ── Tóm tắt ──────────────────────────────────────────────────────────────
  console.log(`${c.bold}${c.cyan}═══════════════════════════════════════════════════${c.reset}`);
  if (allPass) {
    console.log(`  ${c.bold}${c.green}✅ 3/3 donate đã được bắn thành công vào server!${c.reset}`);
    console.log(`  ${c.dim}Donation IDs: [${donationIds.join(', ')}]${c.reset}`);
    console.log(`\n  ${c.yellow}👀 Quan sát OBS Overlay để xác nhận:${c.reset}`);
    console.log(`     1. Alert #1 (50.000đ) xuất hiện trước → phát hết → biến mất`);
    console.log(`     2. Nghỉ 1.5s → Alert #2 (100.000đ) xuất hiện`);
    console.log(`     3. Nghỉ 1.5s → Alert #3 (200.000đ) xuất hiện`);
    console.log(`     4. Kiểm tra DB: cả 3 bản ghi alert_status = 'PLAYED'`);
  } else {
    console.log(`  ${c.bold}${c.red}❌ Có lỗi khi bắn donate. Xem chi tiết ở trên.${c.reset}`);
  }
  console.log(`${c.bold}${c.cyan}═══════════════════════════════════════════════════${c.reset}\n`);

  // Hướng dẫn kiểm tra DB
  if (donationIds.length > 0) {
    console.log(`  ${c.bold}Kiểm tra trạng thái sau khi overlay phát xong:${c.reset}`);
    console.log(`  ${c.dim}docker exec -it <postgres_container> psql -U momo_user -d momo_alert \\${c.reset}`);
    console.log(`  ${c.dim}  -c "SELECT id, sender_name, amount, alert_status, played_at FROM donations WHERE id IN (${donationIds.join(',')}) ORDER BY id;"${c.reset}\n`);
  }

  if (!allPass) process.exit(1);
}

runTests().catch(err => {
  console.error('Lỗi runner:', err);
  process.exit(1);
});
