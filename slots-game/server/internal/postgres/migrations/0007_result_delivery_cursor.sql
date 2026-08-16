-- 经济结算与展示交付是相互独立的持久状态转换。旧版已提交记录刻意不设为待交付，
-- 因为其历史客户端消费状态无法确定。
ALTER TABLE rgs_rounds
    ADD COLUMN IF NOT EXISTS result_delivery_required boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS result_hash char(64),
    ADD COLUMN IF NOT EXISTS result_acknowledged_at timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'rgs_rounds_result_delivery_state'
          AND conrelid = 'rgs_rounds'::regclass
    ) THEN
        ALTER TABLE rgs_rounds
            ADD CONSTRAINT rgs_rounds_result_delivery_state CHECK (
                (
                    result_delivery_required
                    AND status = 'COMMITTED'
                    AND result_hash ~ '^[a-f0-9]{64}$'
                )
                OR (
                    NOT result_delivery_required
                    AND result_hash IS NULL
                    AND result_acknowledged_at IS NULL
                )
            );
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS rgs_rounds_one_pending_result_delivery
    ON rgs_rounds (operator_id, session_id)
    WHERE status = 'COMMITTED'
      AND result_delivery_required
      AND result_acknowledged_at IS NULL;

CREATE INDEX IF NOT EXISTS rgs_rounds_result_delivery_lookup
    ON rgs_rounds (operator_id, session_id, sequence)
    WHERE status = 'COMMITTED'
      AND result_delivery_required
      AND result_acknowledged_at IS NULL;

COMMENT ON COLUMN rgs_rounds.result_acknowledged_at IS
    'Client canonical-result consumption receipt; never evidence that the player viewed presentation.';
