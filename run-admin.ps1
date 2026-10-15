#!/usr/bin/env pwsh
# run-admin.ps1 – Khởi động stack và mở trang admin
# Dùng: .\run-admin.ps1

Set-Location "e:\QRscan"

Write-Host "`n💜 MoMo Alert – Khởi động stack..." -ForegroundColor Cyan

# 1. Khởi động Docker Compose (chỉ postgres nếu chạy Node trực tiếp)
Write-Host "`n[1/3] Khởi động PostgreSQL + Backend qua Docker Compose..." -ForegroundColor Yellow
docker compose up -d --build

if ($LASTEXITCODE -ne 0) {
    Write-Host "`n❌ Docker compose thất bại. Đảm bảo Docker Desktop đang chạy." -ForegroundColor Red
    exit 1
}

# 2. Chờ backend sẵn sàng (health check)
Write-Host "`n[2/3] Chờ server sẵn sàng..." -ForegroundColor Yellow
$maxRetry = 20
$retryCount = 0
do {
    Start-Sleep -Seconds 2
    $retryCount++
    try {
        $res = Invoke-WebRequest -Uri "http://localhost:3000/health" -TimeoutSec 3 -ErrorAction Stop
        if ($res.StatusCode -eq 200) {
            Write-Host "   ✅ Server đang chạy!" -ForegroundColor Green
            break
        }
    } catch {
        Write-Host "   ⏳ Lần thử $retryCount/$maxRetry..." -ForegroundColor Gray
    }
} while ($retryCount -lt $maxRetry)

if ($retryCount -ge $maxRetry) {
    Write-Host "`n⚠️  Server chưa sẵn sàng sau $($maxRetry * 2)s. Kiểm tra logs:" -ForegroundColor Yellow
    Write-Host "   docker compose logs backend --tail=30" -ForegroundColor Gray
    exit 1
}

# 3. Mở trang admin trong trình duyệt
Write-Host "`n[3/3] Mở Admin Dashboard..." -ForegroundColor Yellow
Start-Process "http://localhost:3000/admin/login"

Write-Host @"

╔══════════════════════════════════════════════════════╗
║  💜 MoMo Alert Admin Dashboard đang chạy!            ║
║                                                      ║
║  🌐 Admin:   http://localhost:3000/admin/login        ║
║  📡 Overlay: http://localhost:3000/overlay?token=    ║
║             obs_overlay_secure_token_2024            ║
║  ❤️  Health:  http://localhost:3000/health            ║
║                                                      ║
║  🔑 Mật khẩu admin: Admin@2024!Secure                ║
║                                                      ║
║  📋 Logs: docker compose logs -f backend             ║
╚══════════════════════════════════════════════════════╝
"@ -ForegroundColor Cyan
