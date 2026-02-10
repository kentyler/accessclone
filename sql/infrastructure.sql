-- AccessClone VBA Translation Infrastructure
-- Run this script after table migration to enable VBA function translation
--
-- This creates the session-state infrastructure that all translated VBA functions use.

-- ============================================================================
-- 1. EXECUTION STATE TABLE
-- ============================================================================
-- Stores all intermediate values during function execution.
-- The session_id isolates concurrent users/operations.

CREATE TABLE IF NOT EXISTS execution_state (
    session_id uuid,
    var_name text,
    var_value text,
    var_type text,  -- 'text', 'integer', 'numeric', 'boolean', 'date'
    updated_at timestamp DEFAULT now(),
    PRIMARY KEY (session_id, var_name)
);

-- Index for cleanup operations
CREATE INDEX IF NOT EXISTS idx_execution_state_updated
ON execution_state (updated_at);

-- ============================================================================
-- 2. SESSION MANAGEMENT
-- ============================================================================

-- Create a new session, returns the session UUID
CREATE OR REPLACE FUNCTION create_session()
RETURNS uuid AS $$
    SELECT gen_random_uuid();
$$ LANGUAGE SQL;

-- Clear all state for a session (call when done)
CREATE OR REPLACE FUNCTION clear_session(p_session uuid)
RETURNS void AS $$
    DELETE FROM execution_state WHERE session_id = p_session;
$$ LANGUAGE SQL;

-- Clean up old sessions (run periodically, e.g., sessions older than 1 day)
CREATE OR REPLACE FUNCTION cleanup_old_sessions(p_hours integer DEFAULT 24)
RETURNS integer AS $$
DECLARE
    v_count integer;
BEGIN
    DELETE FROM execution_state
    WHERE updated_at < now() - (p_hours || ' hours')::interval;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 3. STATE GETTERS
-- ============================================================================

-- Get state as text (raw)
CREATE OR REPLACE FUNCTION get_state(p_session uuid, p_name text)
RETURNS text AS $$
    SELECT var_value
    FROM execution_state
    WHERE session_id = p_session AND var_name = p_name;
$$ LANGUAGE SQL;

-- Get state as integer
CREATE OR REPLACE FUNCTION get_state_int(p_session uuid, p_name text)
RETURNS integer AS $$
    SELECT var_value::integer
    FROM execution_state
    WHERE session_id = p_session AND var_name = p_name;
$$ LANGUAGE SQL;

-- Get state as numeric (for decimals, currency)
CREATE OR REPLACE FUNCTION get_state_numeric(p_session uuid, p_name text)
RETURNS numeric AS $$
    SELECT var_value::numeric
    FROM execution_state
    WHERE session_id = p_session AND var_name = p_name;
$$ LANGUAGE SQL;

-- Get state as boolean
CREATE OR REPLACE FUNCTION get_state_bool(p_session uuid, p_name text)
RETURNS boolean AS $$
    SELECT var_value::boolean
    FROM execution_state
    WHERE session_id = p_session AND var_name = p_name;
$$ LANGUAGE SQL;

-- Get state as date
CREATE OR REPLACE FUNCTION get_state_date(p_session uuid, p_name text)
RETURNS date AS $$
    SELECT var_value::date
    FROM execution_state
    WHERE session_id = p_session AND var_name = p_name;
$$ LANGUAGE SQL;

-- Get state as timestamp
CREATE OR REPLACE FUNCTION get_state_timestamp(p_session uuid, p_name text)
RETURNS timestamp AS $$
    SELECT var_value::timestamp
    FROM execution_state
    WHERE session_id = p_session AND var_name = p_name;
$$ LANGUAGE SQL;

-- ============================================================================
-- 4. STATE SETTER
-- ============================================================================

-- Set state (upsert pattern)
CREATE OR REPLACE FUNCTION set_state(
    p_session uuid,
    p_name text,
    p_value text,
    p_type text DEFAULT 'text'
)
RETURNS void AS $$
    INSERT INTO execution_state (session_id, var_name, var_value, var_type, updated_at)
    VALUES (p_session, p_name, p_value, p_type, now())
    ON CONFLICT (session_id, var_name)
    DO UPDATE SET
        var_value = EXCLUDED.var_value,
        var_type = EXCLUDED.var_type,
        updated_at = now();
$$ LANGUAGE SQL;

-- ============================================================================
-- 5. TEXT NORMALIZATION
-- ============================================================================

-- Normalize text: NULL -> '', trim whitespace
-- Use this when reading text that might be NULL
CREATE OR REPLACE FUNCTION normalize_text(p_value text)
RETURNS text AS $$
    SELECT COALESCE(TRIM(p_value), '');
$$ LANGUAGE SQL;

-- ============================================================================
-- 6. APP CONFIGURATION (Optional but common pattern)
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_config (
    setting_name text PRIMARY KEY,
    setting_value text,
    description text
);

-- Get a config setting
CREATE OR REPLACE FUNCTION get_config(p_setting_name text)
RETURNS text AS $$
    SELECT COALESCE(setting_value, '')
    FROM app_config
    WHERE setting_name = p_setting_name;
$$ LANGUAGE SQL;

-- Set a config setting
CREATE OR REPLACE FUNCTION set_config(
    p_setting_name text,
    p_setting_value text,
    p_description text DEFAULT NULL
)
RETURNS void AS $$
    INSERT INTO app_config (setting_name, setting_value, description)
    VALUES (p_setting_name, p_setting_value, p_description)
    ON CONFLICT (setting_name)
    DO UPDATE SET
        setting_value = EXCLUDED.setting_value,
        description = COALESCE(EXCLUDED.description, app_config.description);
$$ LANGUAGE SQL;

-- ============================================================================
-- 7. UTILITY FUNCTIONS
-- ============================================================================

-- Random number between bounds (example util_ function)
CREATE OR REPLACE FUNCTION util_random_number(p_lower integer, p_upper integer)
RETURNS integer AS $$
    SELECT floor(random() * (p_upper - p_lower + 1) + p_lower)::integer;
$$ LANGUAGE SQL;

-- ============================================================================
-- USAGE EXAMPLE
-- ============================================================================
/*
-- Create a session
SELECT create_session();  -- returns uuid, e.g., 'a1b2c3d4-...'

-- Set some state
SELECT set_state('a1b2c3d4-...', 'recipe_id', '42', 'integer');
SELECT set_state('a1b2c3d4-...', 'amount', '15.5', 'numeric');

-- Call a translated VBA function
SELECT vba_calculate_potency('a1b2c3d4-...');

-- Read results
SELECT get_state('a1b2c3d4-...', 'result');
SELECT get_state('a1b2c3d4-...', 'user_message');

-- Clean up
SELECT clear_session('a1b2c3d4-...');
*/
