ALTER TABLE rgs_sessions
    ADD COLUMN IF NOT EXISTS integrity_quarantined_at timestamptz;

CREATE INDEX IF NOT EXISTS rgs_sessions_integrity_quarantine
    ON rgs_sessions (integrity_quarantined_at)
    WHERE integrity_quarantined_at IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'rgs_sessions_integrity_quarantine_state'
          AND conrelid = 'rgs_sessions'::regclass
    ) THEN
        ALTER TABLE rgs_sessions
            ADD CONSTRAINT rgs_sessions_integrity_quarantine_state
            CHECK (integrity_quarantined_at IS NULL OR status = 'BLOCKED');
    END IF;
END $$;
