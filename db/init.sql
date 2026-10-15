-- ============================================================
--  MoMo Stream Alert – Database Schema
--  PostgreSQL 16 | Encoding: UTF-8
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid(), crypt()

-- ============================================================
-- 1. RAW_NOTIFICATION_LOGS
--    Lưu toàn bộ notification thô từ Android, kể cả rác/quảng cáo.
--    Đây là nguồn sự thật (source of truth) để debug/audit.
-- ============================================================
CREATE TABLE IF NOT EXISTS raw_notification_logs (
    id                BIGSERIAL PRIMARY KEY,
    android_notif_id  VARCHAR(128),                -- notificationId từ Android listener
    package_name      VARCHAR(128),                -- vd: com.mservice.momotransfer
    raw_title         TEXT,
    raw_text          TEXT NOT NULL,
    device_timestamp  TIMESTAMPTZ,                 -- thời điểm thiết bị ghi nhận
    parse_status      VARCHAR(16) NOT NULL DEFAULT 'PENDING'
                          CHECK (parse_status IN ('PENDING','PARSED','IGNORED','FAILED_REGEX','DUPLICATE')),
    error_reason      TEXT,                        -- lý do nếu parse thất bại
    client_ip         VARCHAR(45),                 -- IPv4 hoặc IPv6 của app Android
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_raw_logs_parse_status ON raw_notification_logs(parse_status);
CREATE INDEX IF NOT EXISTS idx_raw_logs_created_at   ON raw_notification_logs(created_at DESC);

COMMENT ON TABLE raw_notification_logs IS 'Lưu trữ toàn bộ raw notification nhận từ Android listener, dùng để audit và debug.';

-- ============================================================
-- 2. DONATIONS
--    Chỉ chứa các giao dịch MoMo đã được parse thành công.
-- ============================================================
CREATE TABLE IF NOT EXISTS donations (
    id              BIGSERIAL PRIMARY KEY,
    raw_log_id      BIGINT REFERENCES raw_notification_logs(id) ON DELETE SET NULL,
    momo_trans_id   VARCHAR(64) UNIQUE NOT NULL,   -- Mã GD từ MoMo hoặc hash tự sinh
    sender_name     VARCHAR(256) NOT NULL DEFAULT 'Người ẩn danh',
    sender_phone    VARCHAR(20),
    amount          NUMERIC(12,0) NOT NULL CHECK (amount > 0),
    message         TEXT,                          -- lời nhắn đã lọc từ cấm
    raw_message     TEXT,                          -- lời nhắn gốc chưa lọc
    alert_status    VARCHAR(10) NOT NULL DEFAULT 'QUEUED'
                        CHECK (alert_status IN ('QUEUED','PLAYED','SKIPPED','REPLAYED')),
    played_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_donations_created_at   ON donations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_donations_alert_status ON donations(alert_status);
CREATE INDEX IF NOT EXISTS idx_donations_momo_trans_id ON donations(momo_trans_id);

COMMENT ON TABLE donations IS 'Giao dịch MoMo đã được parse thành công. Dùng cho OBS overlay và dashboard.';
COMMENT ON COLUMN donations.momo_trans_id IS 'Mã GD chính thức từ MoMo. Nếu không có, dùng SHA256 hash để chống trùng.';
COMMENT ON COLUMN donations.message IS 'Lời nhắn đã được lọc từ cấm (bad_words -> ***)';
COMMENT ON COLUMN donations.raw_message IS 'Lời nhắn gốc, chưa lọc. Chỉ admin mới xem.';

-- ============================================================
-- 3. APP_SETTINGS
--    Bảng 1 dòng (Singleton pattern). id luôn = 1.
-- ============================================================
CREATE TABLE IF NOT EXISTS app_settings (
    id                  INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    min_donate_amount   NUMERIC(12,0) NOT NULL DEFAULT 10000,
    tts_enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    tts_template        VARCHAR(512) NOT NULL DEFAULT 'Cảm ơn {name} đã donate {amount} đồng. {message}',
    alert_duration_ms   INT NOT NULL DEFAULT 8000 CHECK (alert_duration_ms >= 1000),
    bad_words_list      TEXT[] NOT NULL DEFAULT '{}',
    obs_overlay_token   VARCHAR(256),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE app_settings IS 'Cấu hình toàn cục. Singleton – chỉ có đúng 1 dòng với id=1.';
COMMENT ON COLUMN app_settings.tts_template IS 'Template TTS. Hỗ trợ {name}, {amount}, {message}.';
COMMENT ON COLUMN app_settings.bad_words_list IS 'Danh sách từ cấm (mảng PostgreSQL). Khớp case-insensitive.';

-- Seed dòng mặc định (chỉ insert nếu chưa tồn tại)
INSERT INTO app_settings (id, obs_overlay_token)
VALUES (1, 'obs_overlay_secure_token_2024')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Function: tự động cập nhật updated_at khi settings thay đổi
-- ============================================================
CREATE OR REPLACE FUNCTION update_settings_timestamp()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_app_settings_updated_at
BEFORE UPDATE ON app_settings
FOR EACH ROW EXECUTE FUNCTION update_settings_timestamp();

-- ============================================================
-- View: tổng hợp nhanh dùng cho dashboard
-- ============================================================
CREATE OR REPLACE VIEW v_donation_summary AS
SELECT
    COUNT(*)                                        AS total_count,
    COALESCE(SUM(amount), 0)                        AS total_amount,
    COALESCE(AVG(amount), 0)::NUMERIC(12,0)         AS avg_amount,
    COALESCE(MAX(amount), 0)                        AS max_amount,
    COUNT(*) FILTER (WHERE alert_status = 'QUEUED') AS queued_count,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 hour') AS last_hour_count,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS last_24h_count
FROM donations;

COMMENT ON VIEW v_donation_summary IS 'Tổng hợp thống kê donation – dùng cho dashboard.';

-- Hoàn tất
DO $$ BEGIN
    RAISE NOTICE 'MoMo Alert DB schema initialized successfully at %', NOW();
END $$;
