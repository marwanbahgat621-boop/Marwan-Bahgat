-- ═══════════════════════════════════════
--  BeamIt — Supabase Setup Script
--  شغّل هذا في Supabase → SQL Editor
-- ═══════════════════════════════════════

-- 1. جدول التحويلات
CREATE TABLE IF NOT EXISTS transfers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code       TEXT NOT NULL UNIQUE,
  files      JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- فهرس سريع على الكود
CREATE INDEX IF NOT EXISTS idx_transfers_code ON transfers(code);

-- فهرس على وقت الانتهاء (للحذف التلقائي)
CREATE INDEX IF NOT EXISTS idx_transfers_expires ON transfers(expires_at);

-- 2. حذف تلقائي للسجلات المنتهية (يعمل كل ساعة)
SELECT cron.schedule(
  'delete-expired-transfers',
  '0 * * * *',
  $$
    DELETE FROM transfers WHERE expires_at < NOW();
  $$
);

-- 3. تأكد من إنشاء الـ Bucket يدوياً في:
--    Supabase → Storage → New Bucket
--    الاسم: beamit-files
--    Public: OFF
