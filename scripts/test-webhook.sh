#!/usr/bin/env bash
# =============================================================================
# test-webhook.sh – Bash script kiểm thử Webhook MoMo Alert
# Dùng trên Ubuntu Server (môi trường production)
#
# Yêu cầu: bash, curl, openssl (có sẵn trên Ubuntu)
# Sử dụng:
#   chmod +x scripts/test-webhook.sh
#   bash scripts/test-webhook.sh
#   bash scripts/test-webhook.sh http://192.168.1.x:3000
# =============================================================================

set -euo pipefail

# ── Cấu hình ─────────────────────────────────────────────────────────────────
HOST="${1:-http://localhost:3000}"
ENDPOINT="${HOST}/api/v1/webhook/momo-notify"

# Load WEBHOOK_SECRET từ .env (nếu có), hoặc dùng giá trị fallback
if [ -f "$(dirname "$0")/../.env" ]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' "$(dirname "$0")/../.env" | grep 'WEBHOOK_SECRET' | xargs)
fi

SECRET="${WEBHOOK_SECRET:-super_secret_webhook_key_momo_2024_abcxyz}"

# ── Màu sắc ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'
YELLOW='\033[1;33m'; BOLD='\033[1m'; RESET='\033[0m'

PASS=0; FAIL=0

# ── Helper: tính HMAC-SHA256 ─────────────────────────────────────────────────
hmac_sha256() {
  local body="$1"
  echo -n "$body" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}'
}

# ── Helper: gửi request có chữ ký ────────────────────────────────────────────
send_request() {
  local body="$1"
  local ts
  ts=$(date +%s%3N)  # Unix milliseconds
  local sig
  sig=$(hmac_sha256 "$body")

  curl -s -o /tmp/momo_resp.json -w "%{http_code}" \
    -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "X-Signature: $sig" \
    -H "X-Timestamp: $ts" \
    -d "$body"
}

# ── Helper: run test ──────────────────────────────────────────────────────────
run_test() {
  local name="$1"
  local body="$2"
  local expected_status="$3"
  local expected_result="$4"

  echo -e "\n${BOLD}  ▶ ${name}${RESET}"

  local http_code
  http_code=$(send_request "$body")
  local response
  response=$(cat /tmp/momo_resp.json 2>/dev/null || echo '{}')

  local actual_result
  actual_result=$(echo "$response" | grep -o '"result":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "N/A")

  if [ "$http_code" = "$expected_status" ] && [ "$actual_result" = "$expected_result" ]; then
    echo -e "  ${GREEN}✓ PASS${RESET}  HTTP=$http_code | result=$actual_result"
    ((PASS++)) || true
  else
    echo -e "  ${RED}✗ FAIL${RESET}  HTTP=$http_code (expect $expected_status) | result=$actual_result (expect $expected_result)"
    echo -e "  ${YELLOW}Response: $response${RESET}"
    ((FAIL++)) || true
  fi
}

# ── Header ───────────────────────────────────────────────────────────────────
echo -e "\n${BOLD}${CYAN}═══════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  🧪 MoMo Alert Webhook Test Suite (bash)${RESET}"
echo -e "${BOLD}${CYAN}═══════════════════════════════════════════════════${RESET}"
echo -e "  Endpoint: ${ENDPOINT}"
echo -e "  Secret:   ${SECRET:0:6}...\n"

# ── Kiểm tra server ───────────────────────────────────────────────────────────
echo -ne "  Kiểm tra server health..."
HEALTH=$(curl -s --max-time 5 "${HOST}/health" 2>/dev/null || echo '{"ok":false}')
DB_STATUS=$(echo "$HEALTH" | grep -o '"db":"[^"]*"' | cut -d'"' -f4)
if echo "$HEALTH" | grep -q '"ok":true'; then
  echo -e " ${GREEN}OK${RESET} (DB: $DB_STATUS)"
else
  echo -e " ${RED}THẤT BẠI${RESET}"
  echo "  Hãy chạy: docker compose up -d"
  exit 1
fi

# ── Test 1: Mẫu 1 chuẩn ─────────────────────────────────────────────────────
TS=$(date +%s%3N)
BODY_1="{\"notifId\":\"bash_test_${TS}\",\"packageName\":\"com.mservice.momotransfer\",\"rawTitle\":\"MoMo: Nhan tien\",\"rawText\":\"Ban vua nhan duoc 50.000d tu NGUYEN VAN A (0901234567). Loi nhan: Chuc ban stream vui. Ma GD: BASH${TS}.\"}"
run_test "TC01 – Mẫu 1: nhận được + SĐT + Mã GD" "$BODY_1" "201" "CREATED"

# ── Test 2: Mẫu 2 cộng + ──────────────────────────────────────────────────
TS2=$(date +%s%3N)
BODY_2="{\"notifId\":\"bash_test2_${TS2}\",\"packageName\":\"com.mservice.momotransfer\",\"rawTitle\":\"So du thay doi\",\"rawText\":\"Tai khoan cua ban vua duoc cong +20,000d tu TRAN THI B. Noi dung: Ung ho. Ma giao dich: BASH2${TS2}\"}"
run_test "TC02 – Mẫu 2: cộng +, dấu phẩy, Nội dung" "$BODY_2" "201" "CREATED"

# ── Test 3: Thông báo khuyến mãi → IGNORED ───────────────────────────────
TS3=$(date +%s%3N)
BODY_3="{\"notifId\":\"bash_test3_${TS3}\",\"packageName\":\"com.mservice.momotransfer\",\"rawTitle\":\"Khuyen mai\",\"rawText\":\"MoMo Khuyen mai: Hoan tien 20% khi thanh toan hoa don dien. Ap dung den het thang.\"}"
run_test "TC03 – Thông báo khuyến mãi → IGNORED" "$BODY_3" "200" "IGNORED"

# ── Test 4: Thanh toán → IGNORED ─────────────────────────────────────────
TS4=$(date +%s%3N)
BODY_4="{\"notifId\":\"bash_test4_${TS4}\",\"packageName\":\"com.mservice.momotransfer\",\"rawTitle\":\"Thanh toan\",\"rawText\":\"Thanh toan thanh cong 85.000d tai Highlands Coffee. Ma GD: 00099988.\"}"
run_test "TC04 – Thanh toán mua hàng → IGNORED" "$BODY_4" "200" "IGNORED"

# ── Test 5: Thiếu rawText → 400 ──────────────────────────────────────────
BODY_5="{\"packageName\":\"com.mservice.momotransfer\",\"rawTitle\":\"Test thieu field\"}"
run_test "TC05 – Thiếu rawText → 400" "$BODY_5" "400" "N/A"

# Ghi chú: TC05 result là N/A vì server trả về error không có field "result"
# Kiểm tra status 400 là đủ
if [ "$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" \
      -X POST "$ENDPOINT" \
      -H "Content-Type: application/json" \
      -H "X-Signature: $(hmac_sha256 "$BODY_5")" \
      -H "X-Timestamp: $(date +%s%3N)" \
      -d "$BODY_5")" = "400" ]; then
  echo -e "  ${CYAN}ℹ${RESET}      (HTTP 400 xác nhận thêm lần nữa: OK)"
fi

# ── Test 6: Chữ ký sai → 403 ─────────────────────────────────────────────
echo -e "\n${BOLD}  ▶ TC06 – Chữ ký HMAC sai → phải 403${RESET}"
TS6=$(date +%s%3N)
BODY_6="{\"rawText\":\"Ban vua nhan duoc 50.000d tu TEST.\"}"
HTTP_BAD=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "X-Signature: deadbeefdeadbeefdeadbeef00000000000000000000000000000000deadbeef" \
  -H "X-Timestamp: $TS6" \
  -d "$BODY_6")
if [ "$HTTP_BAD" = "403" ]; then
  echo -e "  ${GREEN}✓ PASS${RESET}  HTTP=403 (INVALID_SIGNATURE)"
  ((PASS++)) || true
else
  echo -e "  ${RED}✗ FAIL${RESET}  HTTP=$HTTP_BAD (mong đợi 403)"
  ((FAIL++)) || true
fi

# ── Test 7: Timestamp quá cũ → 401 ───────────────────────────────────────
echo -e "\n${BOLD}  ▶ TC07 – Timestamp quá cũ (10 phút) → phải 401${RESET}"
OLD_TS=$(( $(date +%s%3N) - 600000 ))  # -10 phút
BODY_7="{\"rawText\":\"Ban vua nhan duoc 50.000d tu TEST.\"}"
SIG_7=$(hmac_sha256 "$BODY_7")
HTTP_OLD=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIG_7" \
  -H "X-Timestamp: $OLD_TS" \
  -d "$BODY_7")
if [ "$HTTP_OLD" = "401" ]; then
  echo -e "  ${GREEN}✓ PASS${RESET}  HTTP=401 (TIMESTAMP_EXPIRED)"
  ((PASS++)) || true
else
  echo -e "  ${RED}✗ FAIL${RESET}  HTTP=$HTTP_OLD (mong đợi 401)"
  ((FAIL++)) || true
fi

# ── Summary ───────────────────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL))
echo -e "\n${BOLD}${CYAN}═══════════════════════════════════════════════════${RESET}"
if [ "$FAIL" -eq 0 ]; then
  echo -e "${BOLD}  Kết quả: ${GREEN}${PASS}/${TOTAL} PASSED ✓${RESET}"
else
  echo -e "${BOLD}  Kết quả: ${GREEN}${PASS} PASSED${RESET}, ${RED}${FAIL} FAILED ✗${RESET} (tổng: $TOTAL)"
fi
echo -e "${BOLD}${CYAN}═══════════════════════════════════════════════════${RESET}\n"

[ "$FAIL" -eq 0 ]  # exit code 0 nếu tất cả pass
