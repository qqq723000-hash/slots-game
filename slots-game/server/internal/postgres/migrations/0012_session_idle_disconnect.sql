ALTER TABLE rgs_sessions
    ADD COLUMN idle_disconnect_seconds bigint DEFAULT 1200,
    -- 该默认值只允许旧 writer 在维护交接期间完成 INSERT，并刻意让其立即超时；
    -- 只有签名的 v3 relaunch 才能建立未来的传输截止时间。
    ADD COLUMN idle_disconnect_at timestamptz DEFAULT clock_timestamp(),
    ADD COLUMN transport_generation bigint DEFAULT 1;

UPDATE rgs_sessions
SET idle_disconnect_seconds = COALESCE(idle_disconnect_seconds, 1200),
    idle_disconnect_at = LEAST(expires_at, clock_timestamp() + INTERVAL '20 minutes'),
    transport_generation = COALESCE(transport_generation, 1);

ALTER TABLE rgs_sessions
    ALTER COLUMN idle_disconnect_seconds SET NOT NULL,
    ALTER COLUMN idle_disconnect_at SET NOT NULL,
    ALTER COLUMN transport_generation SET NOT NULL,
    ADD CONSTRAINT rgs_sessions_idle_disconnect_seconds
        CHECK (idle_disconnect_seconds BETWEEN 1 AND 86400),
    ADD CONSTRAINT rgs_sessions_idle_disconnect_before_absolute_expiry
        CHECK (idle_disconnect_at <= expires_at),
    ADD CONSTRAINT rgs_sessions_transport_generation
        CHECK (transport_generation BETWEEN 1 AND 9223372036854775807);

CREATE INDEX rgs_sessions_idle_disconnect
    ON rgs_sessions (idle_disconnect_at)
    WHERE status = 'ACTIVE';
