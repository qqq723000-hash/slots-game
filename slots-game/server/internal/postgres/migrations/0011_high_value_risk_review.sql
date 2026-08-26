-- 高额派奖审批是显式启用的持久安全闸门。迁移只扩展可表达状态；未配置策略的
-- 应用仍只写 PREPARED，因此升级本身不改变任何经济语义。
ALTER TABLE rgs_rounds DROP CONSTRAINT rgs_rounds_status;
ALTER TABLE rgs_rounds ADD CONSTRAINT rgs_rounds_status CHECK (status IN (
    'PREPARED', 'RISK_PENDING', 'WALLET_PENDING', 'COMMITTED', 'REJECTED',
    'ROLLBACK_PENDING', 'ROLLED_BACK', 'MANUAL_REVIEW'
));

CREATE TABLE rgs_risk_reviews (
    operator_id            text        NOT NULL,
    session_id             text        NOT NULL,
    round_id               text        NOT NULL,
    policy_version         text        NOT NULL,
    threshold_minor        bigint      NOT NULL,
    payout_minor           bigint      NOT NULL,
    summary_hash           char(64)    NOT NULL,
    expiry_policy          text        NOT NULL,
    status                 text        NOT NULL,
    expires_at             timestamptz NOT NULL,
    decision               text,
    reason_code            text,
    request_id             text,
    idempotency_key        text,
    credential_key_id      text,
    decision_fingerprint   char(64),
    decided_at             timestamptz,
    created_at             timestamptz NOT NULL,
    updated_at             timestamptz NOT NULL,
    PRIMARY KEY (operator_id, session_id, round_id),
    FOREIGN KEY (operator_id, session_id, round_id)
        REFERENCES rgs_rounds (operator_id, session_id, round_id),
    CONSTRAINT rgs_risk_reviews_identifiers CHECK (
        policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND (request_id IS NULL OR request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
        AND (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
        AND (credential_key_id IS NULL OR credential_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
        AND (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
    ),
    CONSTRAINT rgs_risk_reviews_amounts CHECK (
        threshold_minor > 0 AND payout_minor >= threshold_minor
    ),
    CONSTRAINT rgs_risk_reviews_summary_hash CHECK (summary_hash ~ '^[a-f0-9]{64}$'),
    CONSTRAINT rgs_risk_reviews_expiry_policy CHECK (
        expiry_policy IN ('REJECT', 'MANUAL_REVIEW')
    ),
    CONSTRAINT rgs_risk_reviews_status CHECK (status IN (
        'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED_REJECTED', 'EXPIRED_MANUAL_REVIEW'
    )),
    CONSTRAINT rgs_risk_reviews_decision CHECK (
        (status = 'PENDING'
         AND decision IS NULL AND reason_code IS NULL AND request_id IS NULL
         AND idempotency_key IS NULL AND credential_key_id IS NULL
         AND decision_fingerprint IS NULL AND decided_at IS NULL)
        OR
        (status = 'APPROVED' AND decision = 'APPROVE'
         AND reason_code = 'RISK_APPROVED' AND request_id IS NOT NULL
         AND idempotency_key IS NOT NULL AND credential_key_id IS NOT NULL
         AND decision_fingerprint IS NOT NULL AND decided_at IS NOT NULL)
        OR
        (status = 'REJECTED' AND decision = 'REJECT'
         AND reason_code IN ('RISK_POLICY_REJECTED', 'RISK_FRAUD_SUSPECTED', 'RISK_OPERATOR_REJECTED')
         AND request_id IS NOT NULL
         AND idempotency_key IS NOT NULL AND credential_key_id IS NOT NULL
         AND decision_fingerprint IS NOT NULL AND decided_at IS NOT NULL)
        OR
        (status = 'EXPIRED_REJECTED'
         AND decision = 'EXPIRE' AND reason_code = 'RISK_REVIEW_EXPIRED_REJECT'
         AND request_id IS NULL AND idempotency_key IS NULL
         AND credential_key_id IS NULL AND decision_fingerprint IS NULL
         AND decided_at IS NOT NULL)
        OR
        (status = 'EXPIRED_MANUAL_REVIEW'
         AND decision = 'EXPIRE' AND reason_code = 'RISK_REVIEW_EXPIRED_MANUAL'
         AND request_id IS NULL AND idempotency_key IS NULL
         AND credential_key_id IS NULL AND decision_fingerprint IS NULL
         AND decided_at IS NOT NULL)
    ),
    CONSTRAINT rgs_risk_reviews_decision_fingerprint CHECK (
        decision_fingerprint IS NULL OR decision_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT rgs_risk_reviews_times CHECK (
        expires_at > created_at AND updated_at >= created_at
        AND (decided_at IS NULL OR decided_at >= created_at)
    )
);

CREATE INDEX rgs_risk_reviews_expiry
    ON rgs_risk_reviews (expires_at, operator_id, session_id, round_id)
    WHERE status = 'PENDING';

-- 签名 Idempotency-Key 在同一运营商审批端点内只能标识一个业务决定；禁止误把同一键
-- 用于不同轮次并分别生效。PENDING 行尚无键，因此不参与唯一性判断。
CREATE UNIQUE INDEX rgs_risk_reviews_operator_idempotency
    ON rgs_risk_reviews (operator_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- RISK_PENDING 必须保留钱包命令摘要，但绝不能处于可领取状态。
ALTER TABLE rgs_rounds ADD CONSTRAINT rgs_rounds_risk_pending_wallet_gate CHECK (
    status <> 'RISK_PENDING'
    OR (wallet_phase = '' AND next_attempt_at IS NULL AND wallet_lease_until IS NULL
        AND wallet_command_digest IS NOT NULL AND wallet_profile IS NOT NULL)
);
