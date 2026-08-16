ALTER TABLE rgs_rounds
    ADD COLUMN IF NOT EXISTS integrity_quarantined_at timestamptz;

CREATE INDEX IF NOT EXISTS rgs_rounds_integrity_quarantine
    ON rgs_rounds (integrity_quarantined_at)
    WHERE integrity_quarantined_at IS NOT NULL;
