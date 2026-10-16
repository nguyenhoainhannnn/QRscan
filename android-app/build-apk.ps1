# Script build file APK Android MoMo Stream Alert tự động
$ErrorActionPreference = "Stop"

Write-Host "🚀 Đang chuẩn bị môi trường build Android APK..." -ForegroundColor Cyan

$env:JAVA_HOME = "C:\Users\Zephyrus\.jdks\jbr-21.0.11"
$env:ANDROID_HOME = "C:\Users\Zephyrus\AppData\Local\Android\Sdk"

Set-Location -Path $PSScriptRoot

Write-Host "📦 Bắt đầu biên dịch assembleDebug..." -ForegroundColor Yellow
.\gradlew.bat assembleDebug

if ($LASTEXITCODE -eq 0) {
    $apkPath = Join-Path $PSScriptRoot "app\build\outputs\apk\debug\app-debug.apk"
    Write-Host "`n✅ BUILD THÀNH CÔNG!" -ForegroundColor Green
    Write-Host "📁 File APK: $apkPath" -ForegroundColor Cyan
    
    # Mở thư mục chứa file APK trong Windows Explorer
    explorer.exe /select,"$apkPath"
} else {
    Write-Host "`n❌ BUILD THẤT BẠI!" -ForegroundColor Red
}
