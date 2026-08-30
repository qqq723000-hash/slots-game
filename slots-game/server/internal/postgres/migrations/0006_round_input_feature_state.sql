-- 预备轮次必须保留提供给游戏引擎的确切特性投影。会话记录会刻意等到钱包提交后才推进，
-- 且提交后包含下一状态投影，因此在重放或对账旧轮次时不能作为持久替代来源。
-- English: The preliminary round must preserve the exact feature projection provided to the game engine.
-- Session recording will deliberately wait until the wallet is submitted before advancing. And the next state
-- projection is included after submission, so it cannot be used as a persistent replacement source when
-- replaying or reconciling old rounds.
ALTER TABLE rgs_rounds
    ADD COLUMN IF NOT EXISTS input_feature_state jsonb;

-- 现有经济状态未终结的轮次可以精确恢复：所属会话仍固定在轮次起始修订号及局前特性投影。
-- 历史或终态记录无法在不猜测的情况下重建，因此刻意保留为 NULL，
-- 并由存储库完整性边界按失效即关闭方式处理。
-- English: Rounds whose existing economic status has not ended can be accurately restored: the session to which
-- they belong is still fixed at the round starting revision number and pre-game characteristic projection.
-- History or final state records cannot be reconstructed without guesswork and are therefore intentionally left
-- NULL. And handled by the repository integrity boundary in a fail-to-close manner.
UPDATE rgs_rounds AS r
SET input_feature_state = s.feature_state
FROM rgs_sessions AS s
WHERE r.input_feature_state IS NULL
  AND r.status IN ('PREPARED', 'WALLET_PENDING')
  AND s.operator_id = r.operator_id
  AND s.session_id = r.session_id
  AND s.pending_round_id = r.round_id
  AND s.revision = r.starting_revision;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'rgs_rounds_input_feature_object'
          AND conrelid = 'rgs_rounds'::regclass
    ) THEN
        ALTER TABLE rgs_rounds
            ADD CONSTRAINT rgs_rounds_input_feature_object
            CHECK (
                input_feature_state IS NULL
                OR jsonb_typeof(input_feature_state) = 'object'
            );
    END IF;
END $$;

COMMENT ON COLUMN rgs_rounds.input_feature_state IS
    'Exact session FeatureState supplied to the engine before this round; NULL only for unverifiable legacy rows.';
