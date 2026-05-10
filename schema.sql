-- ============================================================
-- FB Bulk Scheduler — Supabase Database Schema
-- Run this in your Supabase SQL editor (Settings → SQL Editor)
-- ============================================================

-- ── PAGES TABLE ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id      TEXT NOT NULL UNIQUE,
  page_name    TEXT NOT NULL,
  access_token TEXT NOT NULL,       -- Long-lived page access token
  picture_url  TEXT,
  category     TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── UPLOAD LOGS TABLE ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS upload_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id       TEXT,               -- Facebook post ID (after scheduling)
  video_id      TEXT,               -- Facebook video ID
  video_title   TEXT,
  page_id       TEXT NOT NULL,
  page_name     TEXT,
  scheduled_time TIMESTAMPTZ,
  expire_time    TIMESTAMPTZ,
  status        TEXT DEFAULT 'pending',
  -- possible values: pending | uploading | scheduled | failed | expired | deleted
  error_message TEXT,
  file_name     TEXT,
  file_size     BIGINT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── UPLOAD SESSIONS TABLE ────────────────────────────────────
-- Tracks resumable upload state (for recovery)
CREATE TABLE IF NOT EXISTS upload_sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key          TEXT NOT NULL UNIQUE,
  page_id              TEXT NOT NULL,
  video_title          TEXT,
  description          TEXT,
  scheduled_time       TIMESTAMPTZ,
  expire_time          TIMESTAMPTZ,
  fb_upload_session_id TEXT,
  fb_video_id          TEXT,
  file_size            BIGINT,
  bytes_transferred    BIGINT DEFAULT 0,
  status               TEXT DEFAULT 'init',
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ── INDEXES ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_upload_logs_page_id ON upload_logs(page_id);
CREATE INDEX IF NOT EXISTS idx_upload_logs_status  ON upload_logs(status);
CREATE INDEX IF NOT EXISTS idx_upload_logs_created ON upload_logs(created_at DESC);

-- ── ROW LEVEL SECURITY ───────────────────────────────────────
-- Using service role key in backend, so disable RLS for simplicity
-- (The backend never exposes these tables to the browser directly)
ALTER TABLE pages          DISABLE ROW LEVEL SECURITY;
ALTER TABLE upload_logs    DISABLE ROW LEVEL SECURITY;
ALTER TABLE upload_sessions DISABLE ROW LEVEL SECURITY;

-- ── AUTO-UPDATE updated_at TRIGGER ───────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pages_updated_at
  BEFORE UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER upload_logs_updated_at
  BEFORE UPDATE ON upload_logs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── DONE ─────────────────────────────────────────────────────
-- After running this, copy your Supabase URL and Service Role Key
-- into your .env file and start the server.
