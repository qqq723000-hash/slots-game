-- 钱包 v2 会把能力与账本路由快照锁定到每个新轮次，因此这是一次失败闭合的
-- 维护窗口迁移，而不是允许旧版 API 继续写入的普通滚动扩展。发布前必须停止新 Spin、
-- 排空旧 Pod；旧二进制遗漏 wallet_profile 的新写入会被下方约束拒绝。
ALTER TABLE rgs_rounds
    ADD COLUMN wallet_phase text NOT NULL DEFAULT '',
    ADD COLUMN next_attempt_at timestamptz,
    ADD COLUMN apply_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN lookup_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN wallet_command_digest varchar(82),
    ADD COLUMN wallet_profile jsonb;

-- 旧版记录没有锁定钱包契约及账本路由。即使 PREPARED 尚未外呼，也不能在迁移后
-- 猜测它应由哪个账本命名空间接管；WALLET_PENDING 更可能已经跨过外部边界。
-- 这些少量在途轮次必须失败闭合转人工审查，禁止用当前部署配置重新解释。
INSERT INTO rgs_outbox (
    operator_id, aggregate_type, aggregate_id, event_type, payload,
    created_at, available_at
)
SELECT operator_id, 'round', server_transaction_id, 'ROUND_MANUAL_REVIEW',
       jsonb_build_object(
           'sessionId', session_id,
           'roundId', round_id,
           'reason', 'WALLET_PROFILE_SNAPSHOT_MISSING'
       ),
       clock_timestamp(), clock_timestamp()
FROM rgs_rounds
WHERE status IN ('PREPARED', 'WALLET_PENDING');

UPDATE rgs_wallet_transactions wt
SET status = 'UNKNOWN',
    failure_code = 'WALLET_PROFILE_SNAPSHOT_MISSING',
    updated_at = clock_timestamp()
FROM rgs_rounds r
WHERE r.status IN ('PREPARED', 'WALLET_PENDING')
  AND wt.operator_id = r.operator_id
  AND wt.transaction_id = r.server_transaction_id
  AND wt.status = 'PENDING';

UPDATE rgs_sessions s
SET status = 'BLOCKED', updated_at = clock_timestamp()
WHERE EXISTS (
    SELECT 1 FROM rgs_rounds r
    WHERE r.operator_id = s.operator_id
      AND r.session_id = s.session_id
      AND r.status IN ('PREPARED', 'WALLET_PENDING')
);

UPDATE rgs_rounds
SET status = 'MANUAL_REVIEW',
    failure_code = 'WALLET_PROFILE_SNAPSHOT_MISSING',
    wallet_phase = '',
    next_attempt_at = NULL,
    wallet_lease_until = NULL,
    apply_attempts = GREATEST(retry_count, 0),
    lookup_attempts = 0,
    updated_at = clock_timestamp()
WHERE status IN ('PREPARED', 'WALLET_PENDING');

ALTER TABLE rgs_rounds
    ALTER COLUMN wallet_phase SET DEFAULT 'APPLY',
    ALTER COLUMN next_attempt_at SET DEFAULT clock_timestamp(),
    ADD CONSTRAINT rgs_rounds_wallet_phase CHECK (wallet_phase IN ('', 'APPLY', 'LOOKUP')),
    ADD CONSTRAINT rgs_rounds_wallet_attempts CHECK (apply_attempts >= 0 AND lookup_attempts >= 0),
    ADD CONSTRAINT rgs_rounds_wallet_command_digest CHECK (
        (status NOT IN ('PREPARED', 'WALLET_PENDING') AND wallet_command_digest IS NULL)
        OR (wallet_command_digest IS NOT NULL
            AND wallet_command_digest ~ '^rgs-wallet-cmd-v1:[a-f0-9]{64}$')
    ),
    ADD CONSTRAINT rgs_rounds_wallet_profile CHECK (
        status NOT IN ('PREPARED', 'WALLET_PENDING')
        OR (wallet_profile IS NOT NULL AND jsonb_typeof(wallet_profile) = 'object')
    );

CREATE INDEX rgs_rounds_wallet_recovery_due
    ON rgs_rounds (next_attempt_at, operator_id, updated_at, session_id, round_id)
    WHERE status IN ('PREPARED', 'WALLET_PENDING')
      AND wallet_phase IN ('APPLY', 'LOOKUP');

-- 单批 row_number 只能提供瞬时多样性；跨 Worker、跨批次的公平轮转必须持久化。
-- 与候选轮次一起锁住本行后，另一 Worker 会跳过该运营商，而不是重复争抢其最老轮次。
CREATE TABLE rgs_wallet_recovery_operators (
    operator_id varchar(128) PRIMARY KEY,
    last_claimed_at timestamptz NOT NULL DEFAULT '-infinity'::timestamptz,
    CONSTRAINT rgs_wallet_recovery_operators_id CHECK (
        operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    )
);

INSERT INTO rgs_wallet_recovery_operators (operator_id)
SELECT DISTINCT operator_id
FROM rgs_rounds
WHERE status IN ('PREPARED', 'WALLET_PENDING')
ON CONFLICT (operator_id) DO NOTHING;
