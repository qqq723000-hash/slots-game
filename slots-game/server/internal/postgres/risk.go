package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"slots-game/server/internal/rgs"
	"slots-game/server/internal/telemetry"
)

const riskReviewSelectForUpdate = `
	SELECT policy_version, threshold_minor, payout_minor, summary_hash, expiry_policy, status, expires_at,
		decision, reason_code, request_id, idempotency_key, credential_key_id,
		decision_fingerprint, decided_at, clock_timestamp()
	FROM rgs_risk_reviews
	WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
	FOR UPDATE`

type persistedRiskReview struct {
	policyVersion       string
	thresholdMinor      int64
	payoutMinor         int64
	summaryHash         string
	expiryPolicy        rgs.RiskExpiryPolicy
	status              string
	expiresAt           time.Time
	decision            sql.NullString
	reasonCode          sql.NullString
	requestID           sql.NullString
	idempotencyKey      sql.NullString
	credentialKeyID     sql.NullString
	decisionFingerprint sql.NullString
	decidedAt           sql.NullTime
	databaseNow         time.Time
}

func scanRiskReview(row rowScanner) (persistedRiskReview, error) {
	var review persistedRiskReview
	var expiryPolicy string
	err := row.Scan(
		&review.policyVersion, &review.thresholdMinor, &review.payoutMinor,
		&review.summaryHash, &expiryPolicy, &review.status,
		&review.expiresAt, &review.decision, &review.reasonCode, &review.requestID,
		&review.idempotencyKey, &review.credentialKeyID, &review.decisionFingerprint,
		&review.decidedAt, &review.databaseNow,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return persistedRiskReview{}, rgs.ErrRoundNotFound
	}
	if err != nil {
		return persistedRiskReview{}, fmt.Errorf("postgres repository: scan risk review: %w", err)
	}
	review.expiryPolicy = rgs.RiskExpiryPolicy(expiryPolicy)
	if review.policyVersion == "" || review.thresholdMinor <= 0 ||
		review.payoutMinor < review.thresholdMinor || !isLowerHexDigest(review.summaryHash) ||
		!review.expiryPolicy.Valid() || review.expiresAt.IsZero() || review.databaseNow.IsZero() {
		return persistedRiskReview{}, rgs.ErrManualReview
	}
	switch review.status {
	case "PENDING":
		if review.decision.Valid || review.reasonCode.Valid || review.requestID.Valid ||
			review.idempotencyKey.Valid || review.credentialKeyID.Valid ||
			review.decisionFingerprint.Valid || review.decidedAt.Valid {
			return persistedRiskReview{}, rgs.ErrManualReview
		}
	case "APPROVED", "REJECTED":
		expectedDecision := "APPROVE"
		validReason := review.reasonCode.Valid && review.reasonCode.String == rgs.RiskReasonApproved
		if review.status == "REJECTED" {
			expectedDecision = "REJECT"
			validReason = review.reasonCode.Valid &&
				(review.reasonCode.String == rgs.RiskReasonPolicyRejected ||
					review.reasonCode.String == rgs.RiskReasonFraudSuspected ||
					review.reasonCode.String == rgs.RiskReasonOperatorRejected)
		}
		if !review.decision.Valid || review.decision.String != expectedDecision ||
			!validReason || !review.requestID.Valid ||
			!review.idempotencyKey.Valid || !review.credentialKeyID.Valid ||
			!review.decisionFingerprint.Valid ||
			!isLowerHexDigest(review.decisionFingerprint.String) || !review.decidedAt.Valid {
			return persistedRiskReview{}, rgs.ErrManualReview
		}
	case "EXPIRED_REJECTED", "EXPIRED_MANUAL_REVIEW":
		expectedReason := "RISK_REVIEW_EXPIRED_REJECT"
		if review.status == "EXPIRED_MANUAL_REVIEW" {
			expectedReason = "RISK_REVIEW_EXPIRED_MANUAL"
		}
		if !review.decision.Valid || review.decision.String != "EXPIRE" ||
			!review.reasonCode.Valid || review.reasonCode.String != expectedReason ||
			!review.decidedAt.Valid || review.requestID.Valid ||
			review.idempotencyKey.Valid || review.credentialKeyID.Valid ||
			review.decisionFingerprint.Valid {
			return persistedRiskReview{}, rgs.ErrManualReview
		}
	default:
		return persistedRiskReview{}, rgs.ErrManualReview
	}
	review.expiresAt = review.expiresAt.UTC()
	review.databaseNow = review.databaseNow.UTC()
	return review, nil
}

func validateRiskReviewBinding(record rgs.RoundRecord, review persistedRiskReview) error {
	assessment := rgs.RiskAssessment{
		PolicyVersion: review.policyVersion, ThresholdMinor: review.thresholdMinor,
		PayoutMinor: review.payoutMinor, ExpiresAt: review.expiresAt,
		ExpiryPolicy: review.expiryPolicy,
	}
	digest, err := rgs.RiskAssessmentSummaryHash(record.Result, assessment)
	if err != nil || digest != review.summaryHash {
		return rgs.ErrManualReview
	}
	return nil
}

func isLowerHexDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func (r *Repository) DecideRisk(
	ctx context.Context,
	command rgs.RiskDecisionCommand,
) (returned rgs.RiskDecisionResult, err error) {
	ctx, span := telemetry.Start(
		ctx,
		"postgres.transaction.decide_risk",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("db.system.name", "postgresql"),
			attribute.String("db.operation.name", "decide_risk"),
		),
	)
	defer func() { telemetry.End(span, err) }()
	if !r.riskPolicy.Enabled {
		return rgs.RiskDecisionResult{}, rgs.ErrInvalidRequest
	}
	fingerprint, err := rgs.RiskDecisionFingerprint(command)
	if err != nil {
		return rgs.RiskDecisionResult{}, err
	}
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return rgs.RiskDecisionResult{}, fmt.Errorf("postgres repository: risk decision begin: %w", err)
	}
	defer tx.Rollback()
	session, err := lockSession(ctx, tx, command.RoundKey)
	if err != nil {
		return rgs.RiskDecisionResult{}, err
	}
	record, err := lockRound(ctx, tx, command.RoundKey)
	if err != nil {
		return rgs.RiskDecisionResult{}, err
	}
	review, err := scanRiskReview(tx.QueryRowContext(
		ctx, riskReviewSelectForUpdate,
		command.RoundKey.OperatorID, command.RoundKey.SessionID, command.RoundKey.RoundID,
	))
	if err != nil {
		return rgs.RiskDecisionResult{}, err
	}
	if err := validateRiskReviewBinding(record, review); err != nil {
		return rgs.RiskDecisionResult{}, err
	}
	if review.status != "PENDING" {
		result, ok := replayRiskDecision(command, fingerprint, review)
		if !ok {
			return rgs.RiskDecisionResult{}, rgs.ErrRiskDecisionConflict
		}
		if err := tx.Commit(); err != nil {
			return rgs.RiskDecisionResult{}, fmt.Errorf("postgres repository: risk replay commit: %w", err)
		}
		return result, nil
	}
	if record.Status != rgs.RoundRiskPending || session.Status != rgs.SessionActive ||
		session.PendingRoundID != command.RoundKey.RoundID ||
		session.Revision != record.Request.StartRevision {
		return rgs.RiskDecisionResult{}, rgs.ErrManualReview
	}
	if !review.databaseNow.Before(review.expiresAt) {
		if err := expireRiskLocked(ctx, tx, session, record, review); err != nil {
			return rgs.RiskDecisionResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return rgs.RiskDecisionResult{}, fmt.Errorf("postgres repository: expire late risk decision commit: %w", err)
		}
		return rgs.RiskDecisionResult{}, rgs.ErrRiskDecisionConflict
	}
	result, err := applyRiskDecisionLocked(ctx, tx, session, record, review, command, fingerprint)
	if err != nil {
		return rgs.RiskDecisionResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return rgs.RiskDecisionResult{}, fmt.Errorf("postgres repository: risk decision commit: %w", err)
	}
	return result, nil
}

func replayRiskDecision(
	command rgs.RiskDecisionCommand,
	fingerprint string,
	review persistedRiskReview,
) (rgs.RiskDecisionResult, bool) {
	if !review.idempotencyKey.Valid || review.idempotencyKey.String != command.IdempotencyKey ||
		!review.decisionFingerprint.Valid || review.decisionFingerprint.String != fingerprint ||
		!review.decision.Valid || !review.decidedAt.Valid {
		return rgs.RiskDecisionResult{}, false
	}
	decision := rgs.RiskDecision(review.decision.String)
	status := rgs.RoundRejected
	if review.status == "APPROVED" && decision == rgs.RiskDecisionApprove {
		status = rgs.RoundPrepared
	} else if review.status != "REJECTED" || decision != rgs.RiskDecisionReject {
		return rgs.RiskDecisionResult{}, false
	}
	return rgs.RiskDecisionResult{
		RoundKey: command.RoundKey, Decision: decision, Status: status,
		DecidedAt: review.decidedAt.Time.UTC(), Replayed: true,
	}, true
}

func applyRiskDecisionLocked(
	ctx context.Context,
	tx *sql.Tx,
	session rgs.Session,
	record rgs.RoundRecord,
	review persistedRiskReview,
	command rgs.RiskDecisionCommand,
	fingerprint string,
) (rgs.RiskDecisionResult, error) {
	now := review.databaseNow
	riskStatus := "APPROVED"
	roundStatus := rgs.RoundPrepared
	eventType := "ROUND_RISK_APPROVED"
	if command.Decision == rgs.RiskDecisionApprove {
		result, err := tx.ExecContext(ctx, `
			UPDATE rgs_rounds
			SET status='PREPARED', wallet_phase='APPLY', next_attempt_at=$4,
				wallet_lease_until=NULL, updated_at=$4
			WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
			  AND status='RISK_PENDING'`,
			record.Key.OperatorID, record.Key.SessionID, record.Key.RoundID, now,
		)
		if err != nil {
			return rgs.RiskDecisionResult{}, fmt.Errorf("postgres repository: approve risk round: %w", err)
		}
		if rows, _ := result.RowsAffected(); rows != 1 {
			return rgs.RiskDecisionResult{}, rgs.ErrRiskDecisionConflict
		}
	} else {
		riskStatus = "REJECTED"
		roundStatus = rgs.RoundRejected
		eventType = "ROUND_RISK_REJECTED"
		if err := rejectRiskRoundLocked(ctx, tx, session, record, now, "RISK_REJECTED"); err != nil {
			return rgs.RiskDecisionResult{}, err
		}
	}
	updated, err := tx.ExecContext(ctx, `
		UPDATE rgs_risk_reviews
		SET status=$4, decision=$5, reason_code=$6, request_id=$7,
			idempotency_key=$8, credential_key_id=$9, decision_fingerprint=$10,
			decided_at=$11, updated_at=$11
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3 AND status='PENDING'`,
		command.RoundKey.OperatorID, command.RoundKey.SessionID, command.RoundKey.RoundID,
		riskStatus, string(command.Decision), command.ReasonCode, command.RequestID,
		command.IdempotencyKey, command.CredentialKeyID, fingerprint, now,
	)
	if err != nil {
		if sqlState(err) == "23505" {
			return rgs.RiskDecisionResult{}, rgs.ErrRiskDecisionConflict
		}
		return rgs.RiskDecisionResult{}, fmt.Errorf("postgres repository: persist risk decision: %w", err)
	}
	if rows, _ := updated.RowsAffected(); rows != 1 {
		return rgs.RiskDecisionResult{}, rgs.ErrRiskDecisionConflict
	}
	if err := insertOutbox(ctx, tx, command.RoundKey.OperatorID, "round",
		record.Result.ServerTransactionID, eventType, map[string]any{
			"sessionId": command.RoundKey.SessionID, "roundId": command.RoundKey.RoundID,
			"decision": command.Decision, "reasonCode": command.ReasonCode,
			"policyVersion": review.policyVersion, "summaryHash": review.summaryHash,
			"requestId": command.RequestID, "credentialKeyId": command.CredentialKeyID,
		}); err != nil {
		return rgs.RiskDecisionResult{}, err
	}
	return rgs.RiskDecisionResult{
		RoundKey: command.RoundKey, Decision: command.Decision, Status: roundStatus,
		DecidedAt: now,
	}, nil
}

func rejectRiskRoundLocked(
	ctx context.Context,
	tx *sql.Tx,
	session rgs.Session,
	record rgs.RoundRecord,
	now time.Time,
	failureCode string,
) error {
	roundResult, err := tx.ExecContext(ctx, `
		UPDATE rgs_rounds
		SET status='REJECTED', failure_code=$4, wallet_phase='', next_attempt_at=NULL,
			wallet_lease_until=NULL, updated_at=$5
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
		  AND status='RISK_PENDING'`,
		record.Key.OperatorID, record.Key.SessionID, record.Key.RoundID, failureCode, now,
	)
	if err != nil {
		return fmt.Errorf("postgres repository: reject risk round: %w", err)
	}
	if rows, _ := roundResult.RowsAffected(); rows != 1 {
		return rgs.ErrRiskDecisionConflict
	}
	walletResult, err := tx.ExecContext(ctx, `
		UPDATE rgs_wallet_transactions
		SET status='FAILED', failure_code=$3, updated_at=$4
		WHERE operator_id=$1 AND transaction_id=$2 AND status='PENDING'`,
		record.Key.OperatorID, record.WalletCommand.OperationID, failureCode, now,
	)
	if err != nil {
		return fmt.Errorf("postgres repository: reject risk wallet ledger: %w", err)
	}
	if rows, _ := walletResult.RowsAffected(); rows != 1 {
		return rgs.ErrManualReview
	}
	sessionResult, err := tx.ExecContext(ctx, `
		UPDATE rgs_sessions
		SET pending_round_id=NULL, updated_at=$4
		WHERE operator_id=$1 AND session_id=$2 AND pending_round_id=$3`,
		session.OperatorID, session.SessionID, record.Key.RoundID, now,
	)
	if err != nil {
		return fmt.Errorf("postgres repository: clear rejected risk session: %w", err)
	}
	if rows, _ := sessionResult.RowsAffected(); rows != 1 {
		return rgs.ErrManualReview
	}
	return nil
}

func (r *Repository) ExpireRiskReviews(
	ctx context.Context,
	limit int,
) (expired int, err error) {
	ctx, span := telemetry.Start(
		ctx,
		"postgres.transaction.expire_risk",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("db.system.name", "postgresql"),
			attribute.String("db.operation.name", "expire_risk"),
		),
	)
	defer func() { telemetry.End(span, err) }()
	if !r.riskPolicy.Enabled {
		return 0, nil
	}
	if limit < 1 || limit > 1_000 {
		return 0, rgs.ErrInvalidRequest
	}
	rows, err := r.db.QueryContext(ctx, `
		SELECT operator_id, session_id, round_id
		FROM rgs_risk_reviews
		WHERE status='PENDING' AND expires_at <= clock_timestamp()
		ORDER BY expires_at, operator_id, session_id, round_id
		LIMIT $1`, limit)
	if err != nil {
		return 0, fmt.Errorf("postgres repository: discover expired risk reviews: %w", err)
	}
	var keys []rgs.RoundKey
	for rows.Next() {
		var key rgs.RoundKey
		if err := rows.Scan(&key.OperatorID, &key.SessionID, &key.RoundID); err != nil {
			rows.Close()
			return 0, fmt.Errorf("postgres repository: scan expired risk review key: %w", err)
		}
		keys = append(keys, key)
	}
	if err := rows.Close(); err != nil {
		return 0, fmt.Errorf("postgres repository: close expired risk reviews: %w", err)
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("postgres repository: iterate expired risk reviews: %w", err)
	}
	var failures []error
	for _, key := range keys {
		changed, err := r.expireRiskReview(ctx, key)
		if err != nil {
			// 单条损坏记录保持失败关闭，但不能阻止同一有界批次内其他独立会话到期。
			// One corrupt record remains fail-closed but must not prevent other independent sessions in the same bounded batch from expiring.
			failures = append(failures, err)
			continue
		}
		if changed {
			expired++
		}
	}
	return expired, errors.Join(failures...)
}

func (r *Repository) expireRiskReview(ctx context.Context, key rgs.RoundKey) (bool, error) {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return false, fmt.Errorf("postgres repository: expire risk begin: %w", err)
	}
	defer tx.Rollback()
	session, err := lockSession(ctx, tx, key)
	if err != nil {
		return false, err
	}
	record, err := lockRound(ctx, tx, key)
	if err != nil {
		return false, err
	}
	review, err := scanRiskReview(tx.QueryRowContext(
		ctx, riskReviewSelectForUpdate, key.OperatorID, key.SessionID, key.RoundID,
	))
	if err != nil {
		return false, err
	}
	if err := validateRiskReviewBinding(record, review); err != nil {
		return false, err
	}
	if review.status != "PENDING" || review.databaseNow.Before(review.expiresAt) {
		if err := tx.Commit(); err != nil {
			return false, fmt.Errorf("postgres repository: expire risk no-op commit: %w", err)
		}
		return false, nil
	}
	if record.Status != rgs.RoundRiskPending || session.PendingRoundID != key.RoundID {
		return false, rgs.ErrManualReview
	}
	if err := expireRiskLocked(ctx, tx, session, record, review); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("postgres repository: expire risk commit: %w", err)
	}
	return true, nil
}

func expireRiskLocked(
	ctx context.Context,
	tx *sql.Tx,
	session rgs.Session,
	record rgs.RoundRecord,
	review persistedRiskReview,
) error {
	now := review.databaseNow
	riskStatus := "EXPIRED_REJECTED"
	failureCode := "RISK_REVIEW_EXPIRED_REJECT"
	eventType := "ROUND_RISK_EXPIRED_REJECTED"
	if review.expiryPolicy == rgs.RiskExpiryReject {
		if err := rejectRiskRoundLocked(ctx, tx, session, record, now, failureCode); err != nil {
			return err
		}
	} else {
		riskStatus = "EXPIRED_MANUAL_REVIEW"
		failureCode = "RISK_REVIEW_EXPIRED_MANUAL"
		eventType = "ROUND_RISK_EXPIRED_MANUAL_REVIEW"
		roundResult, err := tx.ExecContext(ctx, `
			UPDATE rgs_rounds
			SET status='MANUAL_REVIEW', failure_code=$4, wallet_phase='',
				next_attempt_at=NULL, wallet_lease_until=NULL, updated_at=$5
			WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
			  AND status='RISK_PENDING'`,
			record.Key.OperatorID, record.Key.SessionID, record.Key.RoundID, failureCode, now,
		)
		if err != nil {
			return fmt.Errorf("postgres repository: expire risk to manual review: %w", err)
		}
		if rows, _ := roundResult.RowsAffected(); rows != 1 {
			return rgs.ErrRiskDecisionConflict
		}
		walletResult, err := tx.ExecContext(ctx, `
			UPDATE rgs_wallet_transactions
			SET status='FAILED', failure_code=$3, updated_at=$4
			WHERE operator_id=$1 AND transaction_id=$2 AND status='PENDING'`,
			record.Key.OperatorID, record.WalletCommand.OperationID, failureCode, now,
		)
		if err != nil {
			return fmt.Errorf("postgres repository: close expired risk wallet ledger: %w", err)
		}
		if rows, _ := walletResult.RowsAffected(); rows != 1 {
			return rgs.ErrManualReview
		}
		sessionResult, err := tx.ExecContext(ctx, `
			UPDATE rgs_sessions SET status='BLOCKED', updated_at=$4
			WHERE operator_id=$1 AND session_id=$2 AND pending_round_id=$3`,
			session.OperatorID, session.SessionID, record.Key.RoundID, now,
		)
		if err != nil {
			return fmt.Errorf("postgres repository: block expired risk session: %w", err)
		}
		if rows, _ := sessionResult.RowsAffected(); rows != 1 {
			return rgs.ErrManualReview
		}
	}
	updated, err := tx.ExecContext(ctx, `
		UPDATE rgs_risk_reviews
		SET status=$4, decision='EXPIRE', reason_code=$5,
			decided_at=$6, updated_at=$6
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3 AND status='PENDING'`,
		record.Key.OperatorID, record.Key.SessionID, record.Key.RoundID,
		riskStatus, failureCode, now,
	)
	if err != nil {
		return fmt.Errorf("postgres repository: persist expired risk decision: %w", err)
	}
	if rows, _ := updated.RowsAffected(); rows != 1 {
		return rgs.ErrRiskDecisionConflict
	}
	return insertOutbox(ctx, tx, record.Key.OperatorID, "round",
		record.Result.ServerTransactionID, eventType, map[string]any{
			"sessionId": record.Key.SessionID, "roundId": record.Key.RoundID,
			"decision": "EXPIRE", "reasonCode": failureCode,
			"policyVersion": review.policyVersion, "summaryHash": review.summaryHash,
		})
}

var _ rgs.RiskDecisionService = (*Repository)(nil)
var _ rgs.RiskExpiryRepository = (*Repository)(nil)
