package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// ErrDefinitionContinuity 表示数据库仍存在属于某个定义且可继续游戏或
// 经济上尚未终结的工作，而新的单定义进程将无法再为该定义执行旋转。
var ErrDefinitionContinuity = errors.New("postgres definition continuity is not drained")

const definitionContinuitySQL = `
WITH predecessor_sessions AS (
    SELECT operator_id, session_id, status, expires_at, feature_state
    FROM rgs_sessions
    WHERE game_id=$1
      AND (definition_version<>$2 OR definition_hash<>$3)
), predecessor_rounds AS (
    SELECT round.operator_id, round.session_id, round.status,
           round.result_delivery_required, round.result_acknowledged_at
    FROM rgs_rounds AS round
    WHERE round.game_id=$1
      AND (round.definition_version<>$2 OR round.definition_hash<>$3)
)
SELECT
    (SELECT count(*) FROM predecessor_sessions
     WHERE status='ACTIVE' AND expires_at>clock_timestamp()),
    (SELECT count(*) FROM predecessor_sessions
     WHERE COALESCE((feature_state->>'Remaining')::integer, 0)>0
       AND COALESCE(feature_state->>'Mode', 'NONE')<>'NONE'),
    (SELECT count(*) FROM predecessor_rounds
     WHERE status IN ('PREPARED', 'RISK_PENDING', 'WALLET_PENDING', 'ROLLBACK_PENDING')),
    (SELECT count(*)
     FROM predecessor_rounds AS round
     JOIN predecessor_sessions AS session
       ON session.operator_id=round.operator_id AND session.session_id=round.session_id
     WHERE round.status='COMMITTED'
       AND round.result_delivery_required
       AND round.result_acknowledged_at IS NULL
       AND session.expires_at>clock_timestamp())`

type DefinitionContinuitySnapshot struct {
	UnexpiredActiveSessions    int64
	ActiveFeatures             int64
	NonTerminalRounds          int64
	UnexpiredPendingDeliveries int64
}

func (snapshot DefinitionContinuitySnapshot) Drained() bool {
	return snapshot.UnexpiredActiveSessions == 0 &&
		snapshot.ActiveFeatures == 0 &&
		snapshot.NonTerminalRounds == 0 &&
		snapshot.UnexpiredPendingDeliveries == 0
}

// CheckDefinitionContinuity 是只读且失败时关闭的启动门禁。它绝不会使前代
// 会话或轮次过期、关闭、重放或发生其他变更。操作方必须先排空这些对象，
// 或部署支持多定义的运行时，之后才能替换唯一注册的旋转执行器。
func CheckDefinitionContinuity(
	ctx context.Context,
	database *sql.DB,
	gameID, definitionVersion, definitionHash string,
) (DefinitionContinuitySnapshot, error) {
	if database == nil || gameID == "" || definitionVersion == "" || len(definitionHash) != 64 {
		return DefinitionContinuitySnapshot{}, errors.New("postgres definition continuity identity is invalid")
	}
	var snapshot DefinitionContinuitySnapshot
	if err := database.QueryRowContext(
		ctx,
		definitionContinuitySQL,
		gameID,
		definitionVersion,
		definitionHash,
	).Scan(
		&snapshot.UnexpiredActiveSessions,
		&snapshot.ActiveFeatures,
		&snapshot.NonTerminalRounds,
		&snapshot.UnexpiredPendingDeliveries,
	); err != nil {
		return DefinitionContinuitySnapshot{}, fmt.Errorf("postgres definition continuity query: %w", err)
	}
	if !snapshot.Drained() {
		return snapshot, fmt.Errorf(
			"%w: active_sessions=%d active_features=%d nonterminal_rounds=%d pending_deliveries=%d",
			ErrDefinitionContinuity,
			snapshot.UnexpiredActiveSessions,
			snapshot.ActiveFeatures,
			snapshot.NonTerminalRounds,
			snapshot.UnexpiredPendingDeliveries,
		)
	}
	return snapshot, nil
}
