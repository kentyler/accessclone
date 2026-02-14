-- AccessClone Infrastructure
-- Run this on a fresh PostgreSQL database before migrating Access data
--
-- Usage:
--   psql -h localhost -U postgres -d your_database -f infrastructure.sql

--------------------------------------------------------------------------------
-- TABLES
--------------------------------------------------------------------------------

-- Session state storage for function execution
CREATE TABLE IF NOT EXISTS execution_state (
    session_id uuid NOT NULL,
    var_name text NOT NULL,
    var_value text,
    var_type text,
    updated_at timestamp DEFAULT now(),
    PRIMARY KEY (session_id, var_name)
);

CREATE INDEX IF NOT EXISTS idx_execution_state_updated ON execution_state (updated_at);

-- Application configuration settings
CREATE TABLE IF NOT EXISTS app_config (
    setting_name text PRIMARY KEY,
    setting_value text,
    description text
);

-- Migration tracking log
CREATE TABLE IF NOT EXISTS migration_log (
    log_id serial PRIMARY KEY,
    migration_session_id uuid DEFAULT gen_random_uuid(),
    migration_timestamp timestamp DEFAULT CURRENT_TIMESTAMP,
    source_database_path text,
    source_database_name varchar(255),
    object_type varchar(50) NOT NULL,
    object_name varchar(255) NOT NULL,
    parent_object varchar(255),
    source_properties jsonb,
    target_properties jsonb,
    migration_status varchar(50) DEFAULT 'pending',
    sql_executed text,
    error_message text,
    notes text,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_migration_log_session ON migration_log (migration_session_id);
CREATE INDEX IF NOT EXISTS idx_migration_log_object_type ON migration_log (object_type);
CREATE INDEX IF NOT EXISTS idx_migration_log_status ON migration_log (migration_status);
CREATE INDEX IF NOT EXISTS idx_migration_log_parent ON migration_log (parent_object);
CREATE INDEX IF NOT EXISTS idx_migration_log_source_props ON migration_log USING gin (source_properties);
CREATE INDEX IF NOT EXISTS idx_migration_log_target_props ON migration_log USING gin (target_properties);

--------------------------------------------------------------------------------
-- SESSION MANAGEMENT FUNCTIONS
--------------------------------------------------------------------------------

-- Create a new session, returns UUID
CREATE OR REPLACE FUNCTION create_session()
RETURNS uuid
LANGUAGE sql
AS $$
    SELECT gen_random_uuid();
$$;

-- Delete all state for a session
CREATE OR REPLACE FUNCTION clear_session(p_session uuid)
RETURNS void
LANGUAGE sql
AS $$
    DELETE FROM execution_state WHERE session_id = p_session;
$$;

-- Clean up old sessions (default: older than 24 hours)
CREATE OR REPLACE FUNCTION cleanup_old_sessions(p_hours integer DEFAULT 24)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_count integer;
BEGIN
    DELETE FROM execution_state
    WHERE updated_at < now() - (p_hours || ' hours')::interval;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

--------------------------------------------------------------------------------
-- STATE GETTER FUNCTIONS
--------------------------------------------------------------------------------

-- Get state as text
CREATE OR REPLACE FUNCTION get_state(p_session uuid, p_name text)
RETURNS text
LANGUAGE sql
AS $$
    SELECT var_value
    FROM execution_state
    WHERE session_id = p_session AND var_name = p_name;
$$;

-- Get state as integer
CREATE OR REPLACE FUNCTION get_state_int(p_session uuid, p_name text)
RETURNS integer
LANGUAGE sql
AS $$
    SELECT var_value::integer
    FROM execution_state
    WHERE session_id = p_session AND var_name = p_name;
$$;

-- Get state as numeric
CREATE OR REPLACE FUNCTION get_state_numeric(p_session uuid, p_name text)
RETURNS numeric
LANGUAGE sql
AS $$
    SELECT var_value::numeric
    FROM execution_state
    WHERE session_id = p_session AND var_name = p_name;
$$;

-- Get state as boolean
CREATE OR REPLACE FUNCTION get_state_bool(p_session uuid, p_name text)
RETURNS boolean
LANGUAGE sql
AS $$
    SELECT var_value::boolean
    FROM execution_state
    WHERE session_id = p_session AND var_name = p_name;
$$;

-- Get state as date
CREATE OR REPLACE FUNCTION get_state_date(p_session uuid, p_name text)
RETURNS date
LANGUAGE sql
AS $$
    SELECT var_value::date
    FROM execution_state
    WHERE session_id = p_session AND var_name = p_name;
$$;

-- Get state as timestamp
CREATE OR REPLACE FUNCTION get_state_timestamp(p_session uuid, p_name text)
RETURNS timestamp
LANGUAGE sql
AS $$
    SELECT var_value::timestamp
    FROM execution_state
    WHERE session_id = p_session AND var_name = p_name;
$$;

--------------------------------------------------------------------------------
-- STATE SETTER FUNCTION
--------------------------------------------------------------------------------

-- Set state (upsert)
CREATE OR REPLACE FUNCTION set_state(p_session uuid, p_name text, p_value text, p_type text DEFAULT 'text')
RETURNS void
LANGUAGE sql
AS $$
    INSERT INTO execution_state (session_id, var_name, var_value, var_type, updated_at)
    VALUES (p_session, p_name, p_value, p_type, now())
    ON CONFLICT (session_id, var_name)
    DO UPDATE SET
        var_value = EXCLUDED.var_value,
        var_type = EXCLUDED.var_type,
        updated_at = now();
$$;

--------------------------------------------------------------------------------
-- UTILITY FUNCTIONS
--------------------------------------------------------------------------------

-- Normalize text: NULL -> '', trim whitespace
CREATE OR REPLACE FUNCTION normalize_text(p_value text)
RETURNS text
LANGUAGE sql
AS $$
    SELECT COALESCE(TRIM(p_value), '');
$$;

--------------------------------------------------------------------------------
-- CONFIG FUNCTIONS
--------------------------------------------------------------------------------

-- Get a config setting
CREATE OR REPLACE FUNCTION get_app_config(p_setting_name text)
RETURNS text
LANGUAGE sql
AS $$
    SELECT COALESCE(setting_value, '')
    FROM app_config
    WHERE setting_name = p_setting_name;
$$;

-- Set a config setting (upsert)
CREATE OR REPLACE FUNCTION set_app_config(p_setting_name text, p_setting_value text, p_description text DEFAULT NULL)
RETURNS void
LANGUAGE sql
AS $$
    INSERT INTO app_config (setting_name, setting_value, description)
    VALUES (p_setting_name, p_setting_value, p_description)
    ON CONFLICT (setting_name)
    DO UPDATE SET
        setting_value = EXCLUDED.setting_value,
        description = COALESCE(EXCLUDED.description, app_config.description);
$$;

--------------------------------------------------------------------------------
-- MIGRATION LOGGING FUNCTION
--------------------------------------------------------------------------------

-- Log a migration event
CREATE OR REPLACE FUNCTION log_migration(
    p_session_id uuid,
    p_object_type varchar,
    p_object_name varchar,
    p_parent_object varchar DEFAULT NULL,
    p_source_props jsonb DEFAULT NULL,
    p_target_props jsonb DEFAULT NULL,
    p_sql_executed text DEFAULT NULL,
    p_status varchar DEFAULT 'completed',
    p_notes text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    new_log_id INTEGER;
BEGIN
    INSERT INTO migration_log (
        migration_session_id,
        object_type,
        object_name,
        parent_object,
        source_properties,
        target_properties,
        sql_executed,
        migration_status,
        notes
    ) VALUES (
        p_session_id,
        p_object_type,
        p_object_name,
        p_parent_object,
        p_source_props,
        p_target_props,
        p_sql_executed,
        p_status,
        p_notes
    ) RETURNING log_id INTO new_log_id;

    RETURN new_log_id;
END;
$$;

--------------------------------------------------------------------------------
-- VERIFICATION
--------------------------------------------------------------------------------

-- Verify infrastructure is set up correctly
DO $$
BEGIN
    RAISE NOTICE 'AccessClone infrastructure installed successfully.';
    RAISE NOTICE 'Tables: execution_state, app_config, migration_log';
    RAISE NOTICE 'Functions: create_session, clear_session, cleanup_old_sessions,';
    RAISE NOTICE '           get_state, get_state_int, get_state_numeric, get_state_bool,';
    RAISE NOTICE '           get_state_date, get_state_timestamp, set_state,';
    RAISE NOTICE '           normalize_text, get_app_config, set_app_config, log_migration';
END;
$$;
