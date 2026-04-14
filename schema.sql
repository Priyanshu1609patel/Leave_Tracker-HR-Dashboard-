-- ============================================================
-- HR Leave & Attendance Tracker — Supabase Schema
-- Run this entire file in: Supabase → SQL Editor → New query
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT UNIQUE NOT NULL,
  password     TEXT NOT NULL,
  role         TEXT DEFAULT 'employee',
  department   TEXT DEFAULT 'General',
  position     TEXT DEFAULT 'Staff',
  avatar_color TEXT DEFAULT '#4F46E5',
  clockify_user_id TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS work_schedule (
  id                    BIGSERIAL PRIMARY KEY,
  start_time            TEXT DEFAULT '09:00',
  end_time              TEXT DEFAULT '18:00',
  late_threshold        TEXT DEFAULT '09:30',
  early_exit_threshold  TEXT DEFAULT '17:00',
  half_day_hours        NUMERIC DEFAULT 4.5,
  work_days             TEXT DEFAULT '1,2,3,4,5'
);

CREATE TABLE IF NOT EXISTS attendance (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date           TEXT NOT NULL,
  check_in       TEXT,
  check_out      TEXT,
  status         TEXT DEFAULT 'present',
  is_late        BOOLEAN DEFAULT FALSE,
  is_early_exit  BOOLEAN DEFAULT FALSE,
  work_hours     NUMERIC DEFAULT 0,
  clockify_hours NUMERIC DEFAULT 0,
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, date)
);

CREATE TABLE IF NOT EXISTS leaves (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  leave_type  TEXT DEFAULT 'casual',
  reason      TEXT,
  status      TEXT DEFAULT 'pending',
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clockify_config (
  id           BIGSERIAL PRIMARY KEY,
  api_key      TEXT DEFAULT '',
  workspace_id TEXT DEFAULT '',
  last_synced  TIMESTAMPTZ
);

-- Disable RLS (we handle auth with our own JWT)
ALTER TABLE users          DISABLE ROW LEVEL SECURITY;
ALTER TABLE attendance     DISABLE ROW LEVEL SECURITY;
ALTER TABLE leaves         DISABLE ROW LEVEL SECURITY;
ALTER TABLE work_schedule  DISABLE ROW LEVEL SECURITY;
ALTER TABLE clockify_config DISABLE ROW LEVEL SECURITY;
