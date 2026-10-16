'use strict';

/**
 * Unit Tests – MoMo Notification Parser
 * Chạy: npm test hoặc npm run test:parser
 *
 * 12 test cases bao phủ:
 *  1. Mẫu 1 chuẩn (có lời nhắn + Mã GD + SĐT)
 *  2. Mẫu 2 chuẩn (cộng + dấu phẩy + có nội dung)
 *  3. Không có lời nhắn → message = null
 *  4. Không có Mã GD → sinh hash fallback
 *  5. Số tiền dấu chấm lớn (1.500.000đ)
 *  6. Số tiền dấu phẩy US style (20,000đ)
 *  7. Thông báo khuyến mãi → IGNORED
 *  8. Thông báo thanh toán (trừ tiền) → IGNORED
 *  9. Thông báo rác / không phải MoMo → IGNORED
 * 10. Văn bản không có từ khoá nhận tiền → IGNORED
 * 11. Văn bản hỏng – không bóc được số tiền → FAILED_REGEX
 * 12. filterBadWords hoạt động đúng
 */

const {
  parseMomoNotification,
  filterBadWords,
  _parseAmount,
  _generateFallbackTransId,
} = require('../src/services/momoParser');

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Shorthand để tạo input cho parser */
function makeInput(rawText, rawTitle = '', packageName = 'com.mservice.momotransfer') {
  return { rawText, rawTitle, packageName, timestamp: Date.now() };
}

// ──────────────────────────────────────────────────────────────────────────────
// Test 1: Mẫu 1 chuẩn – nhận tiền có SĐT + lời nhắn + Mã GD
// ──────────────────────────────────────────────────────────────────────────────
describe('parseMomoNotification', () => {

  test('TC01 – Mẫu 1: nhận được, có SĐT, lời nhắn và Mã GD', () => {
    const result = parseMomoNotification(makeInput(
      'Bạn vừa nhận được 50.000đ từ NGUYEN VAN A (0901234567). ' +
      'Lời nhắn: Chuc ban stream vui ve. Mã GD: 65432109876.'
    ));

    expect(result.status).toBe('PARSED');
    expect(result.data.amount).toBe(50000);
    expect(result.data.senderName).toMatch(/NGUYEN VAN A/i);
    expect(result.data.senderPhone).toBe('0901234567');
    expect(result.data.message).toBe('Chuc ban stream vui ve');
    expect(result.data.momoTransId).toBe('65432109876');
    // Không phải hash fallback
    expect(result.data.momoTransId).not.toMatch(/^HASH_/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 2: Mẫu 2 – cộng +, dấu phẩy, nội dung, Mã giao dịch (đầy đủ)
  // ──────────────────────────────────────────────────────────────────────────
  test('TC02 – Mẫu 2: được cộng +, dấu phẩy, Nội dung, Mã giao dịch', () => {
    const result = parseMomoNotification(makeInput(
      'Tài khoản của bạn vừa được cộng +20,000đ từ TRAN THI B. ' +
      'Nội dung: Ung ho anh. Mã giao dịch: 65432109877'
    ));

    expect(result.status).toBe('PARSED');
    expect(result.data.amount).toBe(20000);
    expect(result.data.senderName).toMatch(/TRAN THI B/i);
    expect(result.data.message).toBe('Ung ho anh');
    expect(result.data.momoTransId).toBe('65432109877');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 3: Không có lời nhắn
  // ──────────────────────────────────────────────────────────────────────────
  test('TC03 – Không có lời nhắn → message = null', () => {
    const result = parseMomoNotification(makeInput(
      'Bạn vừa nhận được 100.000đ từ LE VAN C (0912345678). Mã GD: 99887766.'
    ));

    expect(result.status).toBe('PARSED');
    expect(result.data.amount).toBe(100000);
    expect(result.data.message).toBeNull();
    expect(result.data.momoTransId).toBe('99887766');
    expect(result.data.senderPhone).toBe('0912345678');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 4: Không có Mã GD → sinh hash fallback bắt đầu bằng HASH_
  // ──────────────────────────────────────────────────────────────────────────
  test('TC04 – Không có Mã GD → sinh hash fallback', () => {
    const result = parseMomoNotification(makeInput(
      'Bạn vừa nhận được 30.000đ từ PHAM THI D. Lời nhắn: cam on ban rat nhieu.'
    ));

    expect(result.status).toBe('PARSED');
    expect(result.data.amount).toBe(30000);
    expect(result.data.message).toBe('cam on ban rat nhieu');
    expect(result.data.momoTransId).toMatch(/^HASH_[A-F0-9]{20}$/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 5: Số tiền lớn có nhiều dấu chấm 1.500.000đ
  // ──────────────────────────────────────────────────────────────────────────
  test('TC05 – Số tiền 1.500.000đ (nhiều dấu chấm)', () => {
    const result = parseMomoNotification(makeInput(
      'Bạn vừa nhận được 1.500.000đ từ HO VAN E. Mã GD: 11223344.'
    ));

    expect(result.status).toBe('PARSED');
    expect(result.data.amount).toBe(1500000);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 6: Số tiền dạng US comma 2,500,000đ
  // ──────────────────────────────────────────────────────────────────────────
  test('TC06 – Số tiền 2,500,000đ (dấu phẩy kiểu US)', () => {
    const result = parseMomoNotification(makeInput(
      'Tài khoản của bạn vừa được cộng +2,500,000đ từ DANG THI F. Mã GD: 55667788.'
    ));

    expect(result.status).toBe('PARSED');
    expect(result.data.amount).toBe(2500000);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 7: Thông báo khuyến mãi → IGNORED
  // ──────────────────────────────────────────────────────────────────────────
  test('TC07 – Thông báo khuyến mãi → IGNORED', () => {
    const result = parseMomoNotification(makeInput(
      'MoMo Khuyến mãi: Hoàn tiền 20% khi thanh toán hóa đơn điện. ' +
      'Áp dụng đến hết 31/10/2024.'
    ));

    expect(result.status).toBe('IGNORED');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 8: Thông báo thanh toán / mua hàng → IGNORED
  // ──────────────────────────────────────────────────────────────────────────
  test('TC08 – Thông báo thanh toán mua hàng → IGNORED', () => {
    const result = parseMomoNotification(makeInput(
      'Thanh toán thành công 85.000đ tại Highlands Coffee. ' +
      'Số dư: 1.200.000đ. Mã GD: 12345678.'
    ));

    expect(result.status).toBe('IGNORED');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 9: Package không phải MoMo → IGNORED
  // ──────────────────────────────────────────────────────────────────────────
  test('TC09 – Package không được hỗ trợ → IGNORED', () => {
    const result = parseMomoNotification({
      rawText: 'Bạn vừa nhận được 50.000đ từ ai đó.',
      rawTitle: '',
      packageName: 'com.unknown.app',
      timestamp: Date.now(),
    });

    expect(result.status).toBe('IGNORED');
    expect(result.reason).toMatch(/Package/i);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 10: Thông báo không có từ khoá nhận tiền → IGNORED
  // ──────────────────────────────────────────────────────────────────────────
  test('TC10 – Không có từ khoá nhận tiền → IGNORED', () => {
    const result = parseMomoNotification(makeInput(
      'Số dư ví MoMo của bạn là 500.000đ. Hãy sử dụng ví để thanh toán.'
    ));

    expect(result.status).toBe('IGNORED');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 11: Text hợp lệ nhưng không bóc được số tiền → FAILED_REGEX
  // ──────────────────────────────────────────────────────────────────────────
  test('TC11 – Có từ khoá nhận tiền nhưng không có số tiền → FAILED_REGEX', () => {
    const result = parseMomoNotification(makeInput(
      'Bạn vừa nhận được tiền từ NGUYEN VAN G. Mã GD: 12345.'
    ));

    expect(result.status).toBe('FAILED_REGEX');
    expect(result.reason).toMatch(/số tiền/i);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 12: filterBadWords
  // ──────────────────────────────────────────────────────────────────────────
  test('TC12 – filterBadWords thay thế từ cấm bằng ***', () => {
    const text    = 'Hello badword1, đây là nội dung có BADWORD2 và bình thường';
    const result  = filterBadWords(text, ['badword1', 'BADWORD2']);

    expect(result).not.toContain('badword1');
    expect(result).not.toContain('BADWORD2');
    expect(result).toContain('***');
    expect(result).toContain('bình thường');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 13: Thông báo VNPAY chuẩn theo mẫu người dùng
  // ──────────────────────────────────────────────────────────────────────────
  test('TC13 – VNPAY nhận tiền từ ngân hàng có nội dung và FT mã giao dịch', () => {
    const rawText = `Thời gian giao dịch: 16/10/2026 20:49
Số tiền giao dịch: + 8.000 VNĐ
Số dư cuối: 28.000 VNĐ
Nội dung: Nhan tien: Techcombank _ **********6018: tien nuoc
FT26289409070214`;

    const result = parseMomoNotification({
      rawTitle: 'Ứng dụng VNPAY',
      rawText,
      packageName: 'vnpay.smartacccount',
      timestamp: Date.now(),
    });

    expect(result.status).toBe('PARSED');
    expect(result.data.amount).toBe(8000);
    expect(result.data.momoTransId).toBe('FT26289409070214');
    expect(result.data.senderName).toBe('Techcombank (*6018)');
    expect(result.data.message).toBe('tien nuoc');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 14: VNPAY trừ tiền (-) → IGNORED
  // ──────────────────────────────────────────────────────────────────────────
  test('TC14 – VNPAY trừ tiền (-) → IGNORED', () => {
    const rawText = `Thời gian giao dịch: 16/10/2026 20:50
Số tiền giao dịch: - 50.000 VNĐ
Số dư cuối: 28.000 VNĐ
Nội dung: Thanh toan hoa don`;

    const result = parseMomoNotification({
      rawTitle: 'Ứng dụng VNPAY',
      rawText,
      packageName: 'vnpay.smartacccount',
      timestamp: Date.now(),
    });

    expect(result.status).toBe('IGNORED');
    expect(result.reason).toMatch(/trừ tiền/i);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 15: VNPAY chuyển tiền P2P
  // ──────────────────────────────────────────────────────────────────────────
  test('TC15 – VNPAY nhận tiền P2P giữa 2 ví', () => {
    const rawText = `Thời gian giao dịch: 16/10/2026 21:00
Số tiền giao dịch: + 50.000 VNĐ
Số dư cuối: 78.000 VNĐ
Nội dung: NGUYEN VAN A chuyen tien: ung ho streamer
FT26289409099999`;

    const result = parseMomoNotification({
      rawTitle: 'Ứng dụng VNPAY',
      rawText,
      packageName: 'vnpay.smartacccount',
      timestamp: Date.now(),
    });

    expect(result.status).toBe('PARSED');
    expect(result.data.amount).toBe(50000);
    expect(result.data.momoTransId).toBe('FT26289409099999');
    expect(result.data.senderName).toBe('NGUYEN VAN A');
    expect(result.data.message).toBe('ung ho streamer');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 16: VNPAY nhận tiền từ Vietcombank (VCB Napas chuyển khoản)
  // ──────────────────────────────────────────────────────────────────────────
  test('TC16 – VNPAY nhận tiền từ Vietcombank trích xuất đúng tên người thật và lời nhắn', () => {
    const rawText = `Thời gian giao dịch 16/10/2026 21:18
Số tiền giao dịch +10.000 VND
Số dư cuối 38.000 VND
Nội dung Nhan tien: Vietcombank - **********4711: MBVCB.16572433113.6289BFTVGLCJZP18.tien nuoc.CT tu 0441000784711 NGUYEN HOAI NHAN toi 0783694473 NGUYEN HOAI NHAN tai VNPAY`;

    const result = parseMomoNotification({
      rawTitle: 'Nhận tiền ngân hàng',
      rawText,
      packageName: 'vnpay.smartacccount',
      timestamp: Date.now(),
    });

    expect(result.status).toBe('PARSED');
    expect(result.data.amount).toBe(10000);
    expect(result.data.momoTransId).toBe('VCB_16572433113');
    expect(result.data.senderName).toBe('NGUYEN HOAI NHAN (VCB)');
    expect(result.data.message).toBe('tien nuoc');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Bonus: Test helper _parseAmount
  // ──────────────────────────────────────────────────────────────────────────
  describe('_parseAmount helper', () => {
    test('50.000 → 50000', () => expect(_parseAmount('50.000')).toBe(50000));
    test('20,000 → 20000', () => expect(_parseAmount('20,000')).toBe(20000));
    test('1.500.000 → 1500000', () => expect(_parseAmount('1.500.000')).toBe(1500000));
    test('2,500,000 → 2500000', () => expect(_parseAmount('2,500,000')).toBe(2500000));
    test('null → null', () => expect(_parseAmount(null)).toBeNull());
    test('rác → null', () => expect(_parseAmount('abc')).toBeNull());
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Bonus: Test _generateFallbackTransId
  // ──────────────────────────────────────────────────────────────────────────
  describe('_generateFallbackTransId helper', () => {
    test('Cùng input trong cùng phút → cùng hash', () => {
      const ts = Date.now();
      const id1 = _generateFallbackTransId(ts, 50000, 'NGUYEN VAN A');
      const id2 = _generateFallbackTransId(ts + 30000, 50000, 'NGUYEN VAN A'); // +30s, cùng phút
      // Cùng minute bucket → cùng hash
      if (Math.floor(ts / 60000) === Math.floor((ts + 30000) / 60000)) {
        expect(id1).toBe(id2);
      }
    });

    test('Khác amount → khác hash', () => {
      const ts = Date.now();
      const id1 = _generateFallbackTransId(ts, 50000, 'NGUYEN VAN A');
      const id2 = _generateFallbackTransId(ts, 100000, 'NGUYEN VAN A');
      expect(id1).not.toBe(id2);
    });

    test('Format đúng: bắt đầu bằng HASH_ + 20 ký tự hex hoa', () => {
      const id = _generateFallbackTransId(Date.now(), 50000, 'TEST');
      expect(id).toMatch(/^HASH_[A-F0-9]{20}$/);
    });
  });

});
