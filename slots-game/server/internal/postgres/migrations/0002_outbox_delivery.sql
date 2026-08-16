ALTER TABLE rgs_outbox
    ADD COLUMN lease_token text,
    ADD COLUMN last_error text;

-- 本次迁移前，数据库模式已有 lease_owner 与 lease_until 列，但没有围栏令牌，
-- 也没有能够安全确认这些租约的分发器。释放所有此类未设围栏的旧版租约，
-- 使识别令牌的分发器能够重新领取。发布状态及尝试次数保持不变。
UPDATE rgs_outbox
SET lease_owner = NULL,
    lease_until = NULL
WHERE lease_owner IS NOT NULL OR lease_until IS NOT NULL;

ALTER TABLE rgs_outbox
    ADD CONSTRAINT rgs_outbox_operator_id CHECK (
        operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
    ADD CONSTRAINT rgs_outbox_aggregate_type CHECK (
        aggregate_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
    ADD CONSTRAINT rgs_outbox_aggregate_id CHECK (
        aggregate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
    ADD CONSTRAINT rgs_outbox_event_type CHECK (
        event_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
    ADD CONSTRAINT rgs_outbox_payload_object CHECK (
        jsonb_typeof(payload) = 'object'
    ),
    ADD CONSTRAINT rgs_outbox_attempts CHECK (
        attempts BETWEEN 0 AND 2147483647
    ),
    ADD CONSTRAINT rgs_outbox_failure_code CHECK (
        last_error IS NULL OR last_error ~ '^[A-Z][A-Z0-9_]{0,127}$'
    ),
    ADD CONSTRAINT rgs_outbox_lease_state CHECK (
        (
            lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL
        ) OR (
            published_at IS NULL
            AND lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
            AND lease_token ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
            AND lease_until IS NOT NULL
        )
    );

CREATE INDEX rgs_outbox_claim
    ON rgs_outbox (available_at, lease_until, id)
    WHERE published_at IS NULL;

CREATE INDEX rgs_outbox_aggregate_order
    ON rgs_outbox (operator_id, aggregate_type, aggregate_id, id)
    WHERE published_at IS NULL;
