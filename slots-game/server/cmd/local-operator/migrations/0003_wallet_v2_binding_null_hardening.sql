-- 0002 的原始 CHECK 在 PostgreSQL 三值逻辑下会让 half-bound NULL 表达式得到
-- UNKNOWN，而 CHECK 只拒绝 FALSE。此迁移为已经应用旧 0002 的数据库补上强约束；
-- 新安装中 0002 已包含同名 rejection 约束，因此该分支保持幂等。
-- English: The original CHECK of 0002 will result in a half-bound NULL expression under PostgreSQL three-valued
-- logic. UNKNOWN, while CHECK only rejects FALSE. This migration adds strong constraints to the database that
-- has the old 0002 applied; New installations 0002 already include a rejection constraint of the same name, so
-- this branch remains idempotent.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'local_operator_wallet_rejections'::regclass
          AND conname = 'local_operator_wallet_rejection_v2_binding_shape'
    ) THEN
        ALTER TABLE local_operator_wallet_rejections
            ADD CONSTRAINT local_operator_wallet_rejection_v2_binding_shape CHECK (
                (wallet_session_ref IS NULL AND command_digest IS NULL)
                OR
                (
                    wallet_session_ref IS NOT NULL
                    AND command_digest IS NOT NULL
                    AND wallet_session_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
                    AND command_digest ~ '^rgs-wallet-cmd-v1:[a-f0-9]{64}$'
                )
            );
    END IF;
END
$$;

ALTER TABLE local_operator_wallet_operations
    DROP CONSTRAINT local_operator_wallet_v2_binding_shape,
    ADD CONSTRAINT local_operator_wallet_v2_binding_shape CHECK (
        (wallet_session_ref IS NULL AND command_digest IS NULL)
        OR
        (
            wallet_session_ref IS NOT NULL
            AND command_digest IS NOT NULL
            AND wallet_session_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
            AND command_digest ~ '^rgs-wallet-cmd-v1:[a-f0-9]{64}$'
        )
    );
