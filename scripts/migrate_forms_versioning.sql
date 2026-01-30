-- Migration: Add append-only versioning to forms and reports tables
-- Run this once to upgrade existing tables

-- ============================================================
-- Forms table migration
-- ============================================================

-- Add new columns
ALTER TABLE shared.forms ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
ALTER TABLE shared.forms ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT true;

-- Drop old unique constraint (database_id, name)
ALTER TABLE shared.forms DROP CONSTRAINT IF EXISTS forms_database_id_name_key;

-- Add new unique constraint (database_id, name, version)
ALTER TABLE shared.forms DROP CONSTRAINT IF EXISTS forms_database_id_name_version_key;
ALTER TABLE shared.forms ADD CONSTRAINT forms_database_id_name_version_key UNIQUE (database_id, name, version);

-- Drop updated_at column (no longer needed with append-only)
ALTER TABLE shared.forms DROP COLUMN IF EXISTS updated_at;

-- Add partial index for fast current lookups
DROP INDEX IF EXISTS shared.idx_forms_current;
CREATE INDEX idx_forms_current ON shared.forms(database_id, name) WHERE is_current = true;

-- ============================================================
-- Reports table migration
-- ============================================================

-- Add new columns
ALTER TABLE shared.reports ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
ALTER TABLE shared.reports ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT true;

-- Drop old unique constraint (database_id, name)
ALTER TABLE shared.reports DROP CONSTRAINT IF EXISTS reports_database_id_name_key;

-- Add new unique constraint (database_id, name, version)
ALTER TABLE shared.reports DROP CONSTRAINT IF EXISTS reports_database_id_name_version_key;
ALTER TABLE shared.reports ADD CONSTRAINT reports_database_id_name_version_key UNIQUE (database_id, name, version);

-- Drop updated_at column (no longer needed with append-only)
ALTER TABLE shared.reports DROP COLUMN IF EXISTS updated_at;

-- Add partial index for fast current lookups
DROP INDEX IF EXISTS shared.idx_reports_current;
CREATE INDEX idx_reports_current ON shared.reports(database_id, name) WHERE is_current = true;

-- Verify
SELECT 'Forms table:' as info;
SELECT column_name, data_type, is_nullable FROM information_schema.columns
WHERE table_schema = 'shared' AND table_name = 'forms' ORDER BY ordinal_position;

SELECT 'Reports table:' as info;
SELECT column_name, data_type, is_nullable FROM information_schema.columns
WHERE table_schema = 'shared' AND table_name = 'reports' ORDER BY ordinal_position;
