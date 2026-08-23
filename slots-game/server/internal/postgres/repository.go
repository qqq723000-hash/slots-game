package postgres

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"time"

	"slots-game/server/internal/game"
	"slots-game/server/internal/rgs"
)

// Repository 是 RGS 聚合的 PostgreSQL 持久化实现。每个修改轮次的方法必须先锁定
// 所属会话行，确保所有应用副本遵循同一个按会话划分的串行顺序。
type Repository struct {
	db                *sql.DB
	integrityObserver rgs.IntegrityObserver
}

const (
	persistedSessionIntegrityFailure      = "persisted session integrity validation failed"
	persistedRoundIntegrityFailure        = "persisted round integrity validation failed"
	persistedWalletLedgerIntegrityFailure = "persisted wallet ledger integrity validation failed"
)

const walletLeaseClockSQL = `SELECT clock_timestamp()`

const prepareSessionLockSQL = `
	SELECT s.operator_id, s.session_id, s.player_id, s.wallet_account_id,
		s.wallet_session_id, s.game_id, s.definition_version, s.definition_hash,
		s.currency, s.currency_exponent, s.jurisdiction, s.status,
		s.balance_snapshot_minor, s.sequence, s.revision, s.feature_state,
		s.pending_round_id, s.expires_at, s.integrity_quarantined_at,
		EXISTS (
			SELECT 1 FROM rgs_rounds delivery
			WHERE delivery.operator_id=s.operator_id AND delivery.session_id=s.session_id
			  AND delivery.status='COMMITTED' AND delivery.result_delivery_required
			  AND delivery.result_acknowledged_at IS NULL
		) AS result_delivery_pending,
		clock_timestamp() AS database_now
	FROM rgs_sessions s
	WHERE s.operator_id=$1 AND s.session_id=$2
	FOR UPDATE OF s`

const prepareRoundWriteSQL = `
	WITH inserted_round AS (
		INSERT INTO rgs_rounds (
			operator_id, session_id, round_id, server_transaction_id,
			request_fingerprint, status, round_kind, game_id,
			definition_version, definition_hash, currency, bet_minor,
			input_feature_state, charged_minor, win_minor, starting_revision, resulting_revision,
			sequence, result_json, outcome_hash, wallet_phase, wallet_command_digest,
			wallet_profile, next_attempt_at, created_at, updated_at
		) VALUES (
			$1,$2,$3,$4,$5,'PREPARED',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
			'APPLY',$20,$21,$22,$22,$22
		)
		RETURNING operator_id, session_id, round_id, server_transaction_id
	), inserted_wallet AS (
		INSERT INTO rgs_wallet_transactions (
			operator_id, transaction_id, session_id, round_id, kind, status,
			currency, amount_minor, request_fingerprint, created_at, updated_at
		)
		SELECT operator_id, server_transaction_id, session_id, round_id,
			'PLAY', 'PENDING', $10, $13, $5, $22, $22
		FROM inserted_round
		RETURNING operator_id
	), updated_session AS (
		UPDATE rgs_sessions AS session
		SET pending_round_id=$3, updated_at=$22
		FROM inserted_wallet
		WHERE session.operator_id=$1 AND session.session_id=$2
		  AND session.revision=$15 AND session.pending_round_id IS NULL
		RETURNING session.operator_id
	), inserted_outbox AS (
		INSERT INTO rgs_outbox (
			operator_id, aggregate_type, aggregate_id, event_type, payload
		)
		SELECT $1, 'round', $4, 'ROUND_PREPARED', $23::jsonb
		FROM updated_session
		RETURNING id
	)
	SELECT
		(SELECT count(*) FROM inserted_round),
		(SELECT count(*) FROM inserted_wallet),
		(SELECT count(*) FROM updated_session),
		(SELECT count(*) FROM inserted_outbox)`

func NewRepository(db *sql.DB, observers ...rgs.IntegrityObserver) (*Repository, error) {
	if db == nil {
		return nil, errors.New("postgres repository: database is required")
	}
	if len(observers) > 1 {
		return nil, errors.New("postgres repository: at most one integrity observer is supported")
	}
	var observer rgs.IntegrityObserver
	if len(observers) == 1 {
		if observers[0] == nil {
			return nil, errors.New("postgres repository: integrity observer cannot be nil")
		}
		observer = observers[0]
	}
	return &Repository{db: db, integrityObserver: observer}, nil
}

func (r *Repository) CreateSession(ctx context.Context, session rgs.Session) error {
	if err := rgs.ValidateSession(session); err != nil {
		return err
	}
	if session.PendingRoundID != "" {
		return rgs.ErrInvalidRequest
	}
	featureJSON, err := json.Marshal(session.Feature)
	if err != nil {
		return fmt.Errorf("postgres repository: encode feature state: %w", err)
	}
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return fmt.Errorf("postgres repository: create session begin: %w", err)
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `
		INSERT INTO rgs_sessions (
			operator_id, session_id, player_id, wallet_account_id,
			wallet_session_id, game_id, definition_version, definition_hash,
			currency, currency_exponent, jurisdiction, status,
			balance_snapshot_minor, sequence, revision, feature_state,
			pending_round_id, expires_at
		) VALUES (
			$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NULL,$17
		)`,
		session.OperatorID, session.SessionID, session.PlayerID, session.WalletAccountID,
		session.WalletSessionID, session.GameID, session.DefinitionVersion, session.DefinitionHash,
		session.Currency, session.CurrencyExponent, session.Jurisdiction, string(session.Status),
		session.BalanceMinor, checkedInt64(session.Sequence), checkedInt64(session.Revision),
		featureJSON, session.ExpiresAt.UTC(),
	)
	if err != nil {
		if sqlState(err) == "23505" {
			return rgs.ErrSessionExists
		}
		return fmt.Errorf("postgres repository: create session: %w", err)
	}
	if err := insertOutbox(ctx, tx, session.OperatorID, "session", session.SessionID, "SESSION_CREATED", map[string]any{
		"gameId": session.GameID, "definitionVersion": session.DefinitionVersion,
		"currency": session.Currency,
	}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("postgres repository: create session commit: %w", err)
	}
	return nil
}

func (r *Repository) GetSession(ctx context.Context, operatorID, sessionID string) (rgs.Session, error) {
	session, err := scanSession(r.db.QueryRowContext(
		ctx, sessionSelect+` WHERE operator_id=$1 AND session_id=$2`, operatorID, sessionID,
	))
	if !errors.Is(err, rgs.ErrSessionIntegrity) {
		return session, err
	}
	return rgs.Session{}, r.quarantineSession(ctx, operatorID, sessionID)
}

func (r *Repository) GetRound(ctx context.Context, key rgs.RoundKey) (rgs.RoundRecord, error) {
	record, err := scanRound(r.db.QueryRowContext(ctx, roundSelect+`
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3`,
		key.OperatorID, key.SessionID, key.RoundID,
	))
	if !errors.Is(err, rgs.ErrSessionIntegrity) {
		return record, err
	}
	return rgs.RoundRecord{}, r.quarantineSession(ctx, key.OperatorID, key.SessionID)
}

func (r *Repository) GetPendingResultDelivery(
	ctx context.Context,
	operatorID string,
	sessionID string,
) (rgs.ResultDelivery, error) {
	var roundID, resultHash string
	var sequence int64
	err := r.db.QueryRowContext(ctx, `
		SELECT round_id, sequence, result_hash
		FROM rgs_rounds
		WHERE operator_id=$1 AND session_id=$2
		  AND status='COMMITTED' AND result_delivery_required
		  AND result_acknowledged_at IS NULL`,
		operatorID, sessionID,
	).Scan(&roundID, &sequence, &resultHash)
	if errors.Is(err, sql.ErrNoRows) {
		if _, sessionErr := r.GetSession(ctx, operatorID, sessionID); sessionErr != nil {
			return rgs.ResultDelivery{}, sessionErr
		}
		return rgs.ResultDelivery{}, rgs.ErrResultDeliveryNotFound
	}
	if err != nil {
		return rgs.ResultDelivery{}, fmt.Errorf("postgres repository: discover result delivery: %w", err)
	}
	if sequence < 1 || uint64(sequence) > rgs.MaxClientSequence {
		return rgs.ResultDelivery{}, rgs.ErrManualReview
	}
	record, err := r.GetRound(ctx, rgs.RoundKey{
		OperatorID: operatorID, SessionID: sessionID, RoundID: roundID,
	})
	if err != nil {
		return rgs.ResultDelivery{}, err
	}
	actualHash, err := rgs.CommittedResultHashFor(record.Result)
	if err != nil || record.Status != rgs.RoundCommitted ||
		record.Result.Sequence != uint64(sequence) || actualHash != resultHash {
		return rgs.ResultDelivery{}, r.quarantineCommittedDelivery(
			ctx, record.Key, "committed result delivery integrity validation failed",
		)
	}
	return rgs.ResultDelivery{
		OperatorID: operatorID, SessionID: sessionID, RoundID: roundID,
		Sequence: uint64(sequence), ResultHash: resultHash, Result: record.Result,
		OriginFeatureState: record.InputFeatureState,
	}, nil
}

func (r *Repository) quarantineCommittedDelivery(ctx context.Context, key rgs.RoundKey, reason string) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return errors.Join(rgs.ErrManualReview, fmt.Errorf("postgres repository: delivery quarantine begin: %w", err))
	}
	defer tx.Rollback()
	if _, err := lockSession(ctx, tx, key); err != nil {
		return errors.Join(rgs.ErrManualReview, err)
	}
	if _, _, err := quarantineCorruptRound(ctx, tx, key, reason, r.integrityObserver); err != nil {
		return errors.Join(rgs.ErrManualReview, err)
	}
	return rgs.ErrManualReview
}

func (r *Repository) AcknowledgeResultDelivery(
	ctx context.Context,
	receipt rgs.ResultDeliveryAcknowledgement,
) (rgs.ResultDelivery, bool, error) {
	if err := rgs.ValidateResultDeliveryAcknowledgement(receipt); err != nil {
		return rgs.ResultDelivery{}, false, err
	}
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return rgs.ResultDelivery{}, false, fmt.Errorf("postgres repository: acknowledge result delivery begin: %w", err)
	}
	defer tx.Rollback()
	if _, err := lockSession(ctx, tx, rgs.RoundKey{
		OperatorID: receipt.OperatorID, SessionID: receipt.SessionID, RoundID: receipt.RoundID,
	}); err != nil {
		return rgs.ResultDelivery{}, false, err
	}
	key := rgs.RoundKey{
		OperatorID: receipt.OperatorID, SessionID: receipt.SessionID, RoundID: receipt.RoundID,
	}
	record, err := scanRound(tx.QueryRowContext(ctx, roundSelect+`
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3 FOR UPDATE OF r`,
		key.OperatorID, key.SessionID, key.RoundID,
	))
	if errors.Is(err, rgs.ErrManualReview) {
		// 确认会解除下一局的结果交付栅栏，因此必须在解除前重新校验完整提交结果；
		// 仅比对客户端提供的哈希会让损坏的经济记录逃过隔离。
		_, _, quarantineErr := quarantineCorruptRound(
			ctx, tx, key, "committed result acknowledgement integrity validation failed",
			r.integrityObserver,
		)
		if quarantineErr != nil {
			return rgs.ResultDelivery{}, false, errors.Join(rgs.ErrManualReview, quarantineErr)
		}
		return rgs.ResultDelivery{}, false, rgs.ErrManualReview
	}
	if err != nil {
		return rgs.ResultDelivery{}, false, err
	}
	if record.Status != rgs.RoundCommitted {
		return rgs.ResultDelivery{}, false, rgs.ErrResultDeliveryNotFound
	}
	var deliveryRequired bool
	var resultHash string
	var acknowledgedAt sql.NullTime
	err = tx.QueryRowContext(ctx, `
		SELECT result_delivery_required, result_hash, result_acknowledged_at
		FROM rgs_rounds
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
		  AND status='COMMITTED'`,
		receipt.OperatorID, receipt.SessionID, receipt.RoundID,
	).Scan(&deliveryRequired, &resultHash, &acknowledgedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return rgs.ResultDelivery{}, false, rgs.ErrResultDeliveryNotFound
	}
	if err != nil {
		return rgs.ResultDelivery{}, false, fmt.Errorf("postgres repository: lock result delivery: %w", err)
	}
	actualHash, hashErr := rgs.CommittedResultHashFor(record.Result)
	if hashErr != nil || actualHash != resultHash {
		_, _, quarantineErr := quarantineCorruptRound(
			ctx, tx, key, "committed result acknowledgement integrity validation failed",
			r.integrityObserver,
		)
		if quarantineErr != nil {
			return rgs.ResultDelivery{}, false, errors.Join(rgs.ErrManualReview, quarantineErr)
		}
		return rgs.ResultDelivery{}, false, rgs.ErrManualReview
	}
	if !deliveryRequired {
		return rgs.ResultDelivery{}, false, rgs.ErrResultDeliveryNotFound
	}
	if record.Result.Sequence != receipt.Sequence || resultHash != receipt.ResultHash {
		return rgs.ResultDelivery{}, false, rgs.ErrResultDeliveryMismatch
	}
	changed := !acknowledgedAt.Valid
	if changed {
		acknowledgedAt = sql.NullTime{Time: time.Now().UTC(), Valid: true}
		updated, err := tx.ExecContext(ctx, `
			UPDATE rgs_rounds SET result_acknowledged_at=$4
			WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
			  AND result_acknowledged_at IS NULL`,
			receipt.OperatorID, receipt.SessionID, receipt.RoundID, acknowledgedAt.Time,
		)
		if err != nil {
			return rgs.ResultDelivery{}, false, fmt.Errorf("postgres repository: acknowledge result delivery: %w", err)
		}
		if rows, _ := updated.RowsAffected(); rows != 1 {
			return rgs.ResultDelivery{}, false, rgs.ErrResultDeliveryMismatch
		}
	}
	if err := tx.Commit(); err != nil {
		return rgs.ResultDelivery{}, false, fmt.Errorf("postgres repository: acknowledge result delivery commit: %w", err)
	}
	return rgs.ResultDelivery{
		OperatorID: receipt.OperatorID, SessionID: receipt.SessionID,
		RoundID: receipt.RoundID, Sequence: receipt.Sequence,
		ResultHash: receipt.ResultHash, Result: record.Result,
		OriginFeatureState: record.InputFeatureState,
		AcknowledgedAt:     acknowledgedAt.Time,
	}, changed, nil
}

func (r *Repository) PrepareRound(
	ctx context.Context,
	request rgs.SpinRequest,
	fingerprint string,
	walletProfile rgs.Profile,
	prepare rgs.PrepareOutcome,
) (rgs.RoundRecord, bool, error) {
	if err := rgs.ValidateSpinRequest(request); err != nil {
		return rgs.RoundRecord{}, false, err
	}
	if prepare == nil || fingerprint != rgs.FingerprintFor(request) ||
		!rgs.SupportedSettlementProfile(walletProfile) {
		return rgs.RoundRecord{}, false, rgs.ErrInvalidRequest
	}
	walletProfileJSON, err := json.Marshal(walletProfile)
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: encode wallet profile: %w", err)
	}
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: prepare begin: %w", err)
	}
	defer tx.Rollback()
	session, resultDeliveryPending, now, err := scanPrepareSession(tx.QueryRowContext(
		ctx, prepareSessionLockSQL, request.OperatorID, request.SessionID,
	))
	if err != nil {
		if errors.Is(err, rgs.ErrSessionIntegrity) {
			return rgs.RoundRecord{}, false, r.quarantineLockedSession(
				ctx, tx, request.OperatorID, request.SessionID,
			)
		}
		return rgs.RoundRecord{}, false, err
	}
	existing, err := scanRound(tx.QueryRowContext(ctx, roundSelect+`
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3`,
		request.OperatorID, request.SessionID, request.RoundID,
	))
	if err == nil {
		if existing.Fingerprint != fingerprint {
			return rgs.RoundRecord{}, false, rgs.ErrIdempotencyConflict
		}
		if err := tx.Commit(); err != nil {
			return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: replay commit: %w", err)
		}
		return existing, false, nil
	}
	if errors.Is(err, rgs.ErrManualReview) {
		if _, _, quarantineErr := quarantineCorruptRound(
			ctx, tx, request.Key(), "persisted round integrity validation failed", r.integrityObserver,
		); quarantineErr != nil {
			return rgs.RoundRecord{}, false, errors.Join(rgs.ErrManualReview, quarantineErr)
		}
		return rgs.RoundRecord{}, false, rgs.ErrManualReview
	}
	if !errors.Is(err, rgs.ErrRoundNotFound) {
		return rgs.RoundRecord{}, false, err
	}
	if resultDeliveryPending {
		return rgs.RoundRecord{}, false, rgs.ErrResultDeliveryPending
	}
	if err := validateBinding(session, request); err != nil {
		return rgs.RoundRecord{}, false, err
	}
	if session.PendingRoundID != "" {
		return rgs.RoundRecord{}, false, fmt.Errorf("%w: %s", rgs.ErrRoundPending, session.PendingRoundID)
	}

	result, err := prepare(session)
	if err != nil {
		return rgs.RoundRecord{}, false, err
	}
	if err := validatePrepared(session, request, result); err != nil {
		return rgs.RoundRecord{}, false, err
	}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: encode prepared result: %w", err)
	}
	inputFeatureJSON, err := json.Marshal(session.Feature)
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: encode round input feature: %w", err)
	}
	outcomeHash, err := rgs.PreparedOutcomeHashFor(result)
	if err != nil {
		return rgs.RoundRecord{}, false, err
	}
	// 会话锁、待交付游标与本次预备时间来自同一条数据库语句；既减少热路径往返，
	// 又确保所有副本继续使用 PostgreSQL 时钟而不是本地时钟。
	now = now.UTC()
	walletCommand := rgs.WalletRound{
		OperationID: result.ServerTransactionID, Fingerprint: fingerprint,
		OperatorID: request.OperatorID, PlayerID: session.PlayerID,
		WalletAccountID: session.WalletAccountID, WalletSessionRef: session.WalletSessionID,
		SessionID: request.SessionID, RoundID: request.RoundID, GameID: request.GameID,
		DefinitionVersion: request.DefinitionVersion, DefinitionHash: request.DefinitionHash,
		RoundKind: request.RoundKind, Currency: request.Currency,
		DebitMinor: result.ChargedBetMinor, CreditMinor: result.TotalWinMinor,
	}
	walletCommand.CommandDigest = rgs.CommandDigestFor(walletCommand)
	record := rgs.RoundRecord{
		Key: request.Key(), Fingerprint: fingerprint, Request: request,
		Status: rgs.RoundPrepared, Result: result,
		InputFeatureState: session.Feature, OutcomeHash: outcomeHash,
		WalletCommand: walletCommand, WalletProfile: walletProfile,
		WalletPhase:   rgs.WalletRecoveryApply,
		NextAttemptAt: now, CreatedAt: now, UpdatedAt: now,
	}
	outboxPayload, err := json.Marshal(map[string]any{
		"sessionId": request.SessionID, "roundId": request.RoundID,
		"fingerprint": fingerprint, "outcomeHash": outcomeHash,
		"definitionVersion": request.DefinitionVersion,
	})
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: encode prepared outbox event: %w", err)
	}
	var roundCount, walletCount, sessionCount, outboxCount int64
	err = tx.QueryRowContext(
		ctx, prepareRoundWriteSQL,
		request.OperatorID, request.SessionID, request.RoundID, result.ServerTransactionID,
		fingerprint, string(request.RoundKind), request.GameID,
		request.DefinitionVersion, request.DefinitionHash, request.Currency,
		request.BetMinor, inputFeatureJSON, result.ChargedBetMinor, result.TotalWinMinor,
		checkedInt64(request.StartRevision), checkedInt64(request.StartRevision+1),
		checkedInt64(result.Sequence), resultJSON, outcomeHash, walletCommand.CommandDigest,
		walletProfileJSON, now, outboxPayload,
	).Scan(&roundCount, &walletCount, &sessionCount, &outboxCount)
	if err != nil {
		if sqlState(err) == "23505" {
			// 会话锁本应阻止同一会话出现此冲突；若仍发生，应按重放竞态安全失败，
			// 只允许调用方用原业务身份重试，不能生成新轮次。
			return rgs.RoundRecord{}, false, rgs.ErrRoundPending
		}
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: persist prepared round bundle: %w", err)
	}
	if roundCount != 1 || walletCount != 1 || outboxCount != sessionCount {
		return rgs.RoundRecord{}, false, rgs.ErrManualReview
	}
	if sessionCount != 1 {
		return rgs.RoundRecord{}, false, rgs.ErrRevisionConflict
	}
	if err := tx.Commit(); err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: prepare commit: %w", err)
	}
	return record, true, nil
}

func (r *Repository) ClaimWallet(
	ctx context.Context,
	key rgs.RoundKey,
	leaseDuration time.Duration,
) (rgs.WalletRecoveryClaim, bool, error) {
	if leaseDuration <= 0 || leaseDuration > 24*time.Hour {
		return rgs.WalletRecoveryClaim{}, false, rgs.ErrInvalidRequest
	}
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return rgs.WalletRecoveryClaim{}, false, fmt.Errorf("postgres repository: wallet claim begin: %w", err)
	}
	defer tx.Rollback()
	session, err := lockSession(ctx, tx, key)
	if err != nil {
		if errors.Is(err, rgs.ErrSessionIntegrity) {
			return rgs.WalletRecoveryClaim{}, false, r.quarantineLockedSession(
				ctx, tx, key.OperatorID, key.SessionID,
			)
		}
		return rgs.WalletRecoveryClaim{}, false, err
	}
	record, err := lockRound(ctx, tx, key)
	if err != nil {
		if errors.Is(err, rgs.ErrManualReview) {
			_, _, quarantineErr := quarantineCorruptRound(
				ctx, tx, key, persistedRoundIntegrityFailure, r.integrityObserver,
			)
			return rgs.WalletRecoveryClaim{}, false, errors.Join(rgs.ErrManualReview, quarantineErr)
		}
		return rgs.WalletRecoveryClaim{}, false, err
	}
	if record.Status == rgs.RoundPrepared || record.Status == rgs.RoundWalletPending {
		if err := lockAndValidateWalletClaimLedger(ctx, tx, session, record); err != nil {
			if errors.Is(err, rgs.ErrManualReview) {
				return rgs.WalletRecoveryClaim{}, false, r.quarantineWalletClaimIntegrity(
					ctx, tx, key, persistedWalletLedgerIntegrityFailure,
				)
			}
			return rgs.WalletRecoveryClaim{}, false, err
		}
	}
	// 多副本的本地时钟可能存在偏差。租约判定与持久化时间都以 PostgreSQL 为唯一时钟，
	// 调用方仅表达已校验的租约时长，禁止快时钟副本提前抢占租约。
	var databaseNow time.Time
	if err := tx.QueryRowContext(ctx, walletLeaseClockSQL).Scan(&databaseNow); err != nil {
		return rgs.WalletRecoveryClaim{}, false, fmt.Errorf("postgres repository: read wallet lease clock: %w", err)
	}
	claim, claimed, err := claimWalletLocked(
		ctx, tx, session, record, databaseNow.UTC(), leaseDuration,
	)
	if err != nil {
		return rgs.WalletRecoveryClaim{}, false, err
	}
	if !claimed {
		_ = tx.Commit()
		return claim, false, nil
	}
	if err := tx.Commit(); err != nil {
		return rgs.WalletRecoveryClaim{}, false, fmt.Errorf("postgres repository: wallet claim commit: %w", err)
	}
	return claim, true, nil
}

const walletClaimLedgerSelect = `
	SELECT operator_id, transaction_id, session_id, round_id, kind, status,
		currency, amount_minor, request_fingerprint
	FROM rgs_wallet_transactions
	WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
	ORDER BY transaction_id
	FOR UPDATE`

func lockAndValidateWalletClaimLedger(
	ctx context.Context,
	tx *sql.Tx,
	session rgs.Session,
	record rgs.RoundRecord,
) error {
	if err := rgs.ValidateWalletRecoveryRecord(session, record); err != nil {
		return err
	}
	rows, err := tx.QueryContext(
		ctx, walletClaimLedgerSelect,
		record.Key.OperatorID, record.Key.SessionID, record.Key.RoundID,
	)
	if err != nil {
		return fmt.Errorf("postgres repository: lock wallet claim ledger: %w", err)
	}
	defer rows.Close()
	type walletLedgerIdentity struct {
		operatorID, transactionID, sessionID, roundID string
		kind, status, currency, fingerprint           string
		amountMinor                                   int64
	}
	var ledger walletLedgerIdentity
	count := 0
	for rows.Next() {
		count++
		var current walletLedgerIdentity
		if err := rows.Scan(
			&current.operatorID, &current.transactionID, &current.sessionID,
			&current.roundID, &current.kind, &current.status, &current.currency,
			&current.amountMinor, &current.fingerprint,
		); err != nil {
			return fmt.Errorf("postgres repository: scan wallet claim ledger: %w", err)
		}
		if count == 1 {
			ledger = current
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("postgres repository: wallet claim ledger rows: %w", err)
	}
	command := record.WalletCommand
	if count != 1 || ledger.operatorID != command.OperatorID ||
		ledger.transactionID != command.OperationID ||
		ledger.sessionID != command.SessionID || ledger.roundID != command.RoundID ||
		ledger.kind != "PLAY" ||
		(ledger.status != "PENDING" && ledger.status != "UNKNOWN") ||
		ledger.currency != command.Currency || ledger.amountMinor != command.DebitMinor ||
		ledger.fingerprint != command.Fingerprint {
		return rgs.ErrManualReview
	}
	return nil
}

func claimWalletLocked(
	ctx context.Context,
	tx *sql.Tx,
	session rgs.Session,
	record rgs.RoundRecord,
	databaseNow time.Time,
	leaseDuration time.Duration,
) (rgs.WalletRecoveryClaim, bool, error) {
	claim := rgs.WalletRecoveryClaim{Record: record}
	if record.Status != rgs.RoundPrepared && record.Status != rgs.RoundWalletPending {
		return claim, false, nil
	}
	if session.Status != rgs.SessionActive || !record.WalletPhase.Valid() ||
		record.NextAttemptAt.After(databaseNow) || record.WalletLeaseUntil.After(databaseNow) {
		return claim, false, nil
	}
	if session.PendingRoundID != record.Key.RoundID || session.Revision != record.Request.StartRevision {
		return rgs.WalletRecoveryClaim{}, false, rgs.ErrManualReview
	}
	action := record.WalletPhase
	record.Status = rgs.RoundWalletPending
	record.WalletLeaseUntil = databaseNow.Add(leaseDuration)
	record.NextAttemptAt = record.WalletLeaseUntil
	applyIncrement, lookupIncrement, retryIncrement := 0, 0, 0
	if action == rgs.WalletRecoveryApply {
		// 在任何 APPLY 外呼之前持久切到 LOOKUP；即使随后进程崩溃，也只能先查权威结果。
		record.WalletPhase = rgs.WalletRecoveryLookup
		record.WalletApplyAttempts++
		record.RetryCount++
		applyIncrement, retryIncrement = 1, 1
	} else {
		record.WalletLookupAttempts++
		lookupIncrement = 1
	}
	record.UpdatedAt = databaseNow
	updated, err := tx.ExecContext(ctx, `
		UPDATE rgs_rounds
		SET status='WALLET_PENDING', wallet_phase=$4, next_attempt_at=$5,
			wallet_lease_until=$5, apply_attempts=apply_attempts+$6,
			lookup_attempts=lookup_attempts+$7, retry_count=retry_count+$8,
			updated_at=$9
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3`,
		record.Key.OperatorID, record.Key.SessionID, record.Key.RoundID,
		string(record.WalletPhase), record.WalletLeaseUntil,
		applyIncrement, lookupIncrement, retryIncrement, databaseNow,
	)
	if err != nil {
		return rgs.WalletRecoveryClaim{}, false, fmt.Errorf("postgres repository: claim wallet: %w", err)
	}
	if rows, _ := updated.RowsAffected(); rows != 1 {
		return rgs.WalletRecoveryClaim{}, false, rgs.ErrRevisionConflict
	}
	if action == rgs.WalletRecoveryApply {
		if err := insertOutbox(ctx, tx, record.Key.OperatorID, "round", record.Result.ServerTransactionID, "WALLET_CLAIMED", map[string]any{
			"sessionId": record.Key.SessionID, "roundId": record.Key.RoundID,
			"attempt": record.WalletApplyAttempts,
		}); err != nil {
			return rgs.WalletRecoveryClaim{}, false, err
		}
	}
	return rgs.WalletRecoveryClaim{
		Record: record, Action: action, LeaseUntil: record.WalletLeaseUntil,
	}, true, nil
}

func (r *Repository) CommitClaim(ctx context.Context, claim rgs.WalletRecoveryClaim, receipt rgs.WalletReceipt) (rgs.RoundRecord, bool, error) {
	key := claim.Record.Key
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: commit round begin: %w", err)
	}
	defer tx.Rollback()
	session, err := lockSession(ctx, tx, key)
	if err != nil {
		if errors.Is(err, rgs.ErrSessionIntegrity) {
			return rgs.RoundRecord{}, false, r.quarantineLockedSession(
				ctx, tx, key.OperatorID, key.SessionID,
			)
		}
		return rgs.RoundRecord{}, false, err
	}
	record, err := lockRound(ctx, tx, key)
	if err != nil {
		return rgs.RoundRecord{}, false, err
	}
	if !ownsWalletClaim(record, claim) {
		return rgs.RoundRecord{}, false, rgs.ErrStaleWalletClaim
	}
	if err := validateReceipt(record.WalletCommand, receipt); err != nil {
		return rgs.RoundRecord{}, false, err
	}
	if session.PendingRoundID != key.RoundID || session.Revision != record.Request.StartRevision {
		return rgs.RoundRecord{}, false, rgs.ErrManualReview
	}
	if record.Request.StartRevision >= rgs.MaxStateRevision {
		return rgs.RoundRecord{}, false, rgs.ErrManualReview
	}
	record.Status = rgs.RoundCommitted
	record.Result.BalanceMinor = receipt.BalanceMinor
	record.Result.EndRevision = record.Request.StartRevision + 1
	record.Result.WalletTransactionID = receipt.TransactionID
	record.WalletReceipt = &receipt
	record.WalletPhase = ""
	record.NextAttemptAt = time.Time{}
	record.WalletLeaseUntil = time.Time{}
	record.UpdatedAt = time.Now().UTC()
	resultJSON, err := json.Marshal(record.Result)
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: encode committed result: %w", err)
	}
	featureJSON, err := json.Marshal(record.Result.FeatureState)
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: encode committed feature: %w", err)
	}
	receiptJSON, err := json.Marshal(receipt)
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: encode wallet receipt: %w", err)
	}
	resultHash, err := rgs.CommittedResultHashFor(record.Result)
	if err != nil {
		return rgs.RoundRecord{}, false, err
	}
	roundUpdated, err := tx.ExecContext(ctx, `
		UPDATE rgs_rounds SET status='COMMITTED', result_json=$4,
			wallet_transaction_id=$5, wallet_balance_minor=$6,
			wallet_phase='', next_attempt_at=NULL, wallet_lease_until=NULL,
			committed_at=$7, updated_at=$7,
			result_delivery_required=true, result_hash=$8,
			result_acknowledged_at=NULL
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
		  AND status IN ('PREPARED','WALLET_PENDING') AND wallet_lease_until=$9`,
		key.OperatorID, key.SessionID, key.RoundID, resultJSON,
		receipt.TransactionID, receipt.BalanceMinor, record.UpdatedAt, resultHash, claim.LeaseUntil.UTC(),
	)
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: commit round record: %w", err)
	}
	if rows, _ := roundUpdated.RowsAffected(); rows != 1 {
		return rgs.RoundRecord{}, false, rgs.ErrStaleWalletClaim
	}
	walletUpdated, err := tx.ExecContext(ctx, `
		UPDATE rgs_wallet_transactions
		SET status='SUCCEEDED', operator_reference=$3, response_json=$4,
			failure_code=NULL, updated_at=$5
		WHERE operator_id=$1 AND transaction_id=$2 AND status IN ('PENDING','UNKNOWN')`,
		key.OperatorID, record.Result.ServerTransactionID,
		receipt.TransactionID, receiptJSON, record.UpdatedAt,
	)
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: commit wallet ledger: %w", err)
	}
	if rows, _ := walletUpdated.RowsAffected(); rows != 1 {
		return rgs.RoundRecord{}, false, rgs.ErrManualReview
	}
	updated, err := tx.ExecContext(ctx, `
		UPDATE rgs_sessions SET balance_snapshot_minor=$3, sequence=$4,
			revision=$5, feature_state=$6, pending_round_id=NULL, updated_at=$7
		WHERE operator_id=$1 AND session_id=$2 AND revision=$8 AND pending_round_id=$9`,
		key.OperatorID, key.SessionID, receipt.BalanceMinor, checkedInt64(record.Result.Sequence),
		checkedInt64(record.Result.EndRevision), featureJSON, record.UpdatedAt,
		checkedInt64(record.Request.StartRevision), key.RoundID,
	)
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: commit session transition: %w", err)
	}
	if rows, _ := updated.RowsAffected(); rows != 1 {
		return rgs.RoundRecord{}, false, rgs.ErrRevisionConflict
	}
	if err := insertOutbox(ctx, tx, key.OperatorID, "round", record.Result.ServerTransactionID, "ROUND_COMMITTED", map[string]any{
		"sessionId": key.SessionID, "roundId": key.RoundID,
		"walletTransactionId": receipt.TransactionID,
		"debitMinor":          receipt.DebitMinor, "creditMinor": receipt.CreditMinor,
		"balanceMinor": receipt.BalanceMinor, "sequence": record.Result.Sequence,
	}); err != nil {
		return rgs.RoundRecord{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: commit round transaction: %w", err)
	}
	return record, true, nil
}

func (r *Repository) RejectClaim(ctx context.Context, claim rgs.WalletRecoveryClaim, reason string) (rgs.RoundRecord, bool, error) {
	return r.transitionClaimFailure(ctx, claim, rgs.RoundRejected, reason, true)
}

func (r *Repository) MarkClaimManualReview(ctx context.Context, claim rgs.WalletRecoveryClaim, reason string) (rgs.RoundRecord, bool, error) {
	return r.transitionClaimFailure(ctx, claim, rgs.RoundManualReview, reason, false)
}

func (r *Repository) MarkManualReview(ctx context.Context, key rgs.RoundKey, reason string) (rgs.RoundRecord, bool, error) {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: integrity quarantine begin: %w", err)
	}
	defer tx.Rollback()
	// 全仓持久写统一遵守 session→round 锁序。完整性隔离虽然不依赖可解析的
	// round 内容，也必须先取得 session 锁，避免与 Commit/Claim 形成反序死锁。
	if _, err := lockSession(ctx, tx, key); err != nil {
		if errors.Is(err, rgs.ErrSessionIntegrity) {
			return rgs.RoundRecord{}, false, r.quarantineLockedSession(
				ctx, tx, key.OperatorID, key.SessionID,
			)
		}
		return rgs.RoundRecord{}, false, err
	}
	return quarantineCorruptRound(ctx, tx, key, reason, r.integrityObserver)
}

const recoverySnapshotSQL = `
	WITH recovery_clock AS MATERIALIZED (
		SELECT clock_timestamp() AS now
	), bounded_recovery AS MATERIALIZED (
		SELECT r.next_attempt_at
		FROM rgs_rounds r
		WHERE r.status IN ('PREPARED', 'WALLET_PENDING')
		  AND r.wallet_phase IN ('APPLY', 'LOOKUP')
		  AND r.next_attempt_at IS NOT NULL
		ORDER BY r.next_attempt_at, r.operator_id, r.updated_at, r.session_id, r.round_id
		LIMIT 501
	)
	SELECT count(*)::bigint,
		COALESCE(
			floor(GREATEST(
				EXTRACT(EPOCH FROM (
					COALESCE(MAX(recovery_clock.now), (SELECT now FROM recovery_clock)) -
					MIN(bounded_recovery.next_attempt_at)
				)),
				0
			) * 1000)::bigint,
			0
		),
		COALESCE(MAX(recovery_clock.now), (SELECT now FROM recovery_clock))
	FROM bounded_recovery
	CROSS JOIN recovery_clock`

// RecoverySnapshot 使用数据库时钟生成所有 Worker 共享的有界恢复视图。它按 0008
// partial index 顺序最多读取 501 个持久调度候选；501 表示实际积压至少达到告警门槛，
// 而不是精确总数。第一行仍是全局最早候选，因此逾期年龄不会因截断失真。会话
// 绑定继续由领取事务强校验；异常失配行不能从积压观测中静默消失。
func (r *Repository) RecoverySnapshot(ctx context.Context) (rgs.RecoverySnapshot, error) {
	var backlog, oldestDueMillis int64
	var observedAt time.Time
	if err := r.db.QueryRowContext(ctx, recoverySnapshotSQL).Scan(
		&backlog, &oldestDueMillis, &observedAt,
	); err != nil {
		return rgs.RecoverySnapshot{}, fmt.Errorf("postgres repository: inspect recovery backlog: %w", err)
	}
	maximumDurationMillis := int64((time.Duration(1<<63 - 1)) / time.Millisecond)
	observedAt = observedAt.UTC()
	if backlog < 0 || backlog > rgs.RecoverySnapshotBacklogLimit || oldestDueMillis < 0 ||
		observedAt.IsZero() || observedAt.Unix() <= 0 ||
		(backlog == 0 && oldestDueMillis != 0) || oldestDueMillis > maximumDurationMillis {
		return rgs.RecoverySnapshot{}, errors.New("postgres repository: invalid recovery backlog snapshot")
	}
	return rgs.RecoverySnapshot{
		Backlog: backlog, OldestDueAge: time.Duration(oldestDueMillis) * time.Millisecond,
		ObservedAt: observedAt,
	}, nil
}

func (r *Repository) ClaimRecoverableRounds(
	ctx context.Context,
	limit int,
	leaseDuration time.Duration,
) ([]rgs.WalletRecoveryClaim, error) {
	if limit < 1 || limit > rgs.MaxWalletRecoveryClaimBatch ||
		leaseDuration <= 0 || leaseDuration > 24*time.Hour {
		return nil, rgs.ErrInvalidRequest
	}
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, fmt.Errorf("postgres repository: recovery claim begin: %w", err)
	}
	defer tx.Rollback()
	var selectionNow time.Time
	if err := tx.QueryRowContext(ctx, walletLeaseClockSQL).Scan(&selectionNow); err != nil {
		return nil, fmt.Errorf("postgres repository: read recovery clock: %w", err)
	}
	selectionNow = selectionNow.UTC()
	if _, err := tx.ExecContext(ctx, ensureRecoveryOperatorsSQL); err != nil {
		return nil, fmt.Errorf("postgres repository: register recovery operators: %w", err)
	}
	// session 行在候选 SQL 内以 SKIP LOCKED 领取；PostgreSQL 的 LockRows 节点先于
	// LIMIT 产出行，因此热会话不会占掉批次名额。返回后再按 session→round→wallet
	// ledger 完成完整锁序与校验，绝不把未经核验的命令交给外部钱包。
	rows, err := tx.QueryContext(ctx, recoverableRoundClaimSQL, selectionNow, limit)
	if err != nil {
		return nil, fmt.Errorf("postgres repository: lock recoverable rounds: %w", err)
	}
	keys := make([]rgs.RoundKey, 0, limit)
	for rows.Next() {
		var key rgs.RoundKey
		if err := rows.Scan(&key.OperatorID, &key.SessionID, &key.RoundID); err != nil {
			rows.Close()
			return nil, fmt.Errorf("postgres repository: scan recoverable round: %w", err)
		}
		keys = append(keys, key)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("postgres repository: recoverable round rows: %w", err)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("postgres repository: close recoverable rows: %w", err)
	}
	type lockedRecoveryCandidate struct {
		session rgs.Session
		record  rgs.RoundRecord
	}
	lockedCandidates := make([]lockedRecoveryCandidate, 0, len(keys))
	for _, key := range keys {
		// 候选 SQL 已持有本 session 的写锁；这里重新扫描完整状态并继续统一锁序。
		session, err := lockSession(ctx, tx, key)
		if err != nil {
			if errors.Is(err, rgs.ErrSessionIntegrity) {
				return nil, r.quarantineLockedSession(ctx, tx, key.OperatorID, key.SessionID)
			}
			return nil, err
		}
		record, err := lockRound(ctx, tx, key)
		if err != nil {
			if errors.Is(err, rgs.ErrManualReview) {
				_, _, quarantineErr := quarantineCorruptRound(
					ctx, tx, key, persistedRoundIntegrityFailure, r.integrityObserver,
				)
				return nil, errors.Join(rgs.ErrManualReview, quarantineErr)
			}
			return nil, err
		}
		if err := lockAndValidateWalletClaimLedger(ctx, tx, session, record); err != nil {
			if errors.Is(err, rgs.ErrManualReview) {
				return nil, r.quarantineWalletClaimIntegrity(
					ctx, tx, key, persistedWalletLedgerIntegrityFailure,
				)
			}
			return nil, err
		}
		lockedCandidates = append(lockedCandidates, lockedRecoveryCandidate{
			session: session,
			record:  record,
		})
	}
	// 候选锁等待可能消耗租约窗口。所有 session/round 锁到手后重新读取数据库时钟，
	// 确保交付给 worker 的完整 leaseDuration 从实际取得写所有权的时刻开始计算。
	databaseNow := selectionNow
	if len(lockedCandidates) > 0 {
		if err := tx.QueryRowContext(ctx, walletLeaseClockSQL).Scan(&databaseNow); err != nil {
			return nil, fmt.Errorf("postgres repository: refresh recovery claim clock: %w", err)
		}
		databaseNow = databaseNow.UTC()
	}

	claims := make([]rgs.WalletRecoveryClaim, 0, len(lockedCandidates))
	claimedOperators := make(map[string]struct{}, len(lockedCandidates))
	for _, candidate := range lockedCandidates {
		claim, claimed, err := claimWalletLocked(
			ctx, tx, candidate.session, candidate.record, databaseNow, leaseDuration,
		)
		if err != nil {
			return nil, err
		}
		if claimed {
			claims = append(claims, claim)
			claimedOperators[claim.Record.Key.OperatorID] = struct{}{}
		}
	}
	operators := make([]string, 0, len(claimedOperators))
	for operatorID := range claimedOperators {
		operators = append(operators, operatorID)
	}
	sort.Strings(operators)
	for _, operatorID := range operators {
		if _, err := tx.ExecContext(
			ctx, touchRecoveryOperatorSQL, operatorID, databaseNow,
		); err != nil {
			return nil, fmt.Errorf("postgres repository: advance recovery operator: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("postgres repository: recovery claim commit: %w", err)
	}
	return claims, nil
}

const ensureRecoveryOperatorsSQL = `
	INSERT INTO rgs_wallet_recovery_operators (operator_id)
	SELECT DISTINCT r.operator_id
	FROM rgs_rounds r
	WHERE r.status IN ('PREPARED', 'WALLET_PENDING')
	  AND r.wallet_phase IN ('APPLY', 'LOOKUP')
	ON CONFLICT (operator_id) DO NOTHING`

const touchRecoveryOperatorSQL = `
	UPDATE rgs_wallet_recovery_operators
	SET last_claimed_at=$2
	WHERE operator_id=$1`

const recoverableRoundClaimSQL = `
	WITH ranked AS MATERIALIZED (
		SELECT r.operator_id, r.session_id, r.round_id, r.next_attempt_at, r.updated_at,
			row_number() OVER (
				PARTITION BY r.operator_id
				ORDER BY r.next_attempt_at, r.updated_at, r.session_id, r.round_id
			) AS operator_rank
		FROM rgs_rounds r
		JOIN rgs_sessions s
		  ON s.operator_id=r.operator_id AND s.session_id=r.session_id
		WHERE r.status IN ('PREPARED', 'WALLET_PENDING')
		  AND r.wallet_phase IN ('APPLY', 'LOOKUP')
		  AND r.next_attempt_at <= $1
		  AND (r.wallet_lease_until IS NULL OR r.wallet_lease_until <= $1)
		  AND s.status='ACTIVE' AND s.integrity_quarantined_at IS NULL
		  AND s.pending_round_id=r.round_id AND s.revision=r.starting_revision
	), candidates AS (
		SELECT q.operator_id, q.session_id, q.round_id
		FROM ranked q
		JOIN rgs_wallet_recovery_operators t ON t.operator_id=q.operator_id
		JOIN rgs_sessions claim_session
		  ON claim_session.operator_id=q.operator_id AND claim_session.session_id=q.session_id
		ORDER BY q.operator_rank, t.last_claimed_at, q.next_attempt_at, q.operator_id, q.updated_at,
			q.session_id, q.round_id
		LIMIT $2
		FOR UPDATE OF claim_session, t SKIP LOCKED
	)
	SELECT operator_id, session_id, round_id FROM candidates`

const scheduleWalletRecoverySQL = `
	UPDATE rgs_rounds
	SET wallet_phase=$5,
		next_attempt_at=GREATEST(
			clock_timestamp() + ($6 * interval '1 microsecond'),
			COALESCE($7::timestamptz, '-infinity'::timestamptz)
		),
		wallet_lease_until=NULL,
		apply_attempts=apply_attempts-CASE WHEN $8 THEN 1 ELSE 0 END,
		updated_at=clock_timestamp()
	WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
	  AND wallet_lease_until=$4
	  AND status IN ('PREPARED', 'WALLET_PENDING')
	  AND (NOT $8 OR apply_attempts > 0)`

func (r *Repository) ScheduleWalletRecovery(
	ctx context.Context,
	claim rgs.WalletRecoveryClaim,
	disposition rgs.WalletRecoveryDisposition,
	jitterDelay time.Duration,
) (bool, error) {
	if disposition.Terminal || rgs.ValidateWalletRecoveryDisposition(disposition) != nil ||
		claim.LeaseUntil.IsZero() || jitterDelay < 0 || jitterDelay > 24*time.Hour ||
		(disposition.ApplyNotSent &&
			(claim.Action != rgs.WalletRecoveryApply || claim.Record.WalletApplyAttempts < 1)) {
		return false, rgs.ErrInvalidRequest
	}
	// PostgreSQL 是调度时钟；显式 Retry-After 只作为下界，绝不能缩短 full-jitter。
	var explicitNotBefore any
	if !disposition.NextAttemptAt.IsZero() {
		explicitNotBefore = disposition.NextAttemptAt.UTC()
	}
	effectiveDelay := jitterDelay
	if disposition.MinimumDelay > effectiveDelay {
		effectiveDelay = disposition.MinimumDelay
	}
	delayMicros := effectiveDelay.Microseconds()
	if effectiveDelay%time.Microsecond != 0 {
		delayMicros++
	}
	updated, err := r.db.ExecContext(ctx, scheduleWalletRecoverySQL,
		claim.Record.Key.OperatorID, claim.Record.Key.SessionID, claim.Record.Key.RoundID,
		claim.LeaseUntil.UTC(), string(disposition.NextAction), delayMicros, explicitNotBefore,
		disposition.ApplyNotSent,
	)
	if err != nil {
		return false, fmt.Errorf("postgres repository: schedule wallet recovery: %w", err)
	}
	rows, err := updated.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("postgres repository: inspect wallet recovery schedule: %w", err)
	}
	if rows > 1 {
		return false, rgs.ErrManualReview
	}
	return rows == 1, nil
}

func (r *Repository) transitionClaimFailure(
	ctx context.Context,
	claim rgs.WalletRecoveryClaim,
	target rgs.RoundStatus,
	reason string,
	clearPending bool,
) (rgs.RoundRecord, bool, error) {
	key := claim.Record.Key
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: failure transition begin: %w", err)
	}
	defer tx.Rollback()
	session, err := lockSession(ctx, tx, key)
	if err != nil {
		if errors.Is(err, rgs.ErrSessionIntegrity) {
			return rgs.RoundRecord{}, false, r.quarantineLockedSession(
				ctx, tx, key.OperatorID, key.SessionID,
			)
		}
		return rgs.RoundRecord{}, false, err
	}
	record, err := lockRound(ctx, tx, key)
	if err != nil {
		if target == rgs.RoundManualReview && errors.Is(err, rgs.ErrManualReview) {
			return quarantineCorruptRound(ctx, tx, key, reason, r.integrityObserver)
		}
		return rgs.RoundRecord{}, false, err
	}
	if !ownsWalletClaim(record, claim) {
		return rgs.RoundRecord{}, false, rgs.ErrStaleWalletClaim
	}
	if record.Status == target {
		_ = tx.Commit()
		return record, false, nil
	}
	if record.Status == rgs.RoundCommitted {
		return rgs.RoundRecord{}, false, rgs.ErrManualReview
	}
	if record.Status == rgs.RoundManualReview && target != rgs.RoundManualReview {
		return rgs.RoundRecord{}, false, rgs.ErrManualReview
	}
	if session.PendingRoundID != key.RoundID || session.Revision != record.Request.StartRevision {
		return rgs.RoundRecord{}, false, rgs.ErrRevisionConflict
	}
	reason = boundReason(reason)
	now := time.Now().UTC()
	record.Status, record.FailureReason, record.UpdatedAt = target, reason, now
	record.WalletPhase = ""
	record.NextAttemptAt = time.Time{}
	record.WalletLeaseUntil = time.Time{}
	roundUpdated, err := tx.ExecContext(ctx, `
		UPDATE rgs_rounds SET status=$4, failure_code=$5,
			wallet_phase='', next_attempt_at=NULL, wallet_lease_until=NULL, updated_at=$6
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
		  AND status IN ('PREPARED','WALLET_PENDING') AND wallet_lease_until=$7`,
		key.OperatorID, key.SessionID, key.RoundID, string(target), reason, now,
		claim.LeaseUntil.UTC(),
	)
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: failure round update: %w", err)
	}
	if rows, _ := roundUpdated.RowsAffected(); rows != 1 {
		return rgs.RoundRecord{}, false, rgs.ErrStaleWalletClaim
	}
	walletStatus := "FAILED"
	if target == rgs.RoundManualReview {
		walletStatus = "UNKNOWN"
	}
	walletUpdated, err := tx.ExecContext(ctx, `
		UPDATE rgs_wallet_transactions
		SET status=$3, failure_code=$4, updated_at=$5
		WHERE operator_id=$1 AND transaction_id=$2
		  AND status IN ('PENDING','UNKNOWN')`,
		key.OperatorID, record.Result.ServerTransactionID, walletStatus, reason, now,
	)
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: failure wallet ledger update: %w", err)
	}
	if rows, _ := walletUpdated.RowsAffected(); rows != 1 {
		return rgs.RoundRecord{}, false, rgs.ErrManualReview
	}
	if clearPending {
		sessionUpdated, sessionErr := tx.ExecContext(ctx, `
			UPDATE rgs_sessions SET pending_round_id=NULL, updated_at=$3
			WHERE operator_id=$1 AND session_id=$2 AND pending_round_id=$4 AND revision=$5`,
			key.OperatorID, key.SessionID, now, key.RoundID,
			checkedInt64(record.Request.StartRevision),
		)
		err = sessionErr
		if err == nil {
			if rows, _ := sessionUpdated.RowsAffected(); rows != 1 {
				err = rgs.ErrRevisionConflict
			}
		}
	} else {
		sessionUpdated, sessionErr := tx.ExecContext(ctx, `
			UPDATE rgs_sessions SET status='BLOCKED', updated_at=$3
			WHERE operator_id=$1 AND session_id=$2 AND pending_round_id=$4 AND revision=$5`,
			key.OperatorID, key.SessionID, now, key.RoundID,
			checkedInt64(record.Request.StartRevision),
		)
		err = sessionErr
		if err == nil {
			if rows, _ := sessionUpdated.RowsAffected(); rows != 1 {
				err = rgs.ErrRevisionConflict
			}
		}
	}
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: failure session update: %w", err)
	}
	event := "ROUND_REJECTED"
	if target == rgs.RoundManualReview {
		event = "ROUND_MANUAL_REVIEW"
	}
	if err := insertOutbox(ctx, tx, key.OperatorID, "round", record.Result.ServerTransactionID, event, map[string]any{
		"sessionId": key.SessionID, "roundId": key.RoundID, "reason": reason,
	}); err != nil {
		return rgs.RoundRecord{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: failure transition commit: %w", err)
	}
	return record, true, nil
}

func ownsWalletClaim(record rgs.RoundRecord, claim rgs.WalletRecoveryClaim) bool {
	return (record.Status == rgs.RoundPrepared || record.Status == rgs.RoundWalletPending) &&
		!claim.LeaseUntil.IsZero() && record.WalletLeaseUntil.Equal(claim.LeaseUntil)
}

func (r *Repository) quarantineSession(
	ctx context.Context,
	operatorID, sessionID string,
) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return errors.Join(
			rgs.ErrSessionIntegrity,
			fmt.Errorf("postgres repository: session quarantine begin: %w", err),
		)
	}
	defer tx.Rollback()
	return r.quarantineLockedSession(ctx, tx, operatorID, sessionID)
}

func (r *Repository) quarantineLockedSession(
	ctx context.Context,
	tx *sql.Tx,
	operatorID, sessionID string,
) error {
	if err := quarantineCorruptSession(
		ctx, tx, operatorID, sessionID, persistedSessionIntegrityFailure,
		r.integrityObserver,
	); err != nil {
		return errors.Join(rgs.ErrSessionIntegrity, err)
	}
	return rgs.ErrSessionIntegrity
}

// quarantineCorruptSession 刻意只更新会话生命周期标记，不重写余额、序号、修订号、
// 特性状态、待决轮次归属、轮次状态或钱包账本状态。这些值是人工对账证据，
// 也可能对应无法从损坏状态安全推断的外部资金副作用。
func quarantineCorruptSession(
	ctx context.Context,
	tx *sql.Tx,
	operatorID, sessionID, reason string,
	observer rgs.IntegrityObserver,
) error {
	var previousStatus string
	var pendingRoundID sql.NullString
	var alreadyQuarantined bool
	err := tx.QueryRowContext(ctx, `
		SELECT status, pending_round_id, integrity_quarantined_at IS NOT NULL
		FROM rgs_sessions
		WHERE operator_id=$1 AND session_id=$2
		FOR UPDATE`, operatorID, sessionID,
	).Scan(&previousStatus, &pendingRoundID, &alreadyQuarantined)
	if errors.Is(err, sql.ErrNoRows) {
		return rgs.ErrSessionNotFound
	}
	if err != nil {
		return fmt.Errorf("postgres repository: quarantine session identity: %w", err)
	}
	if alreadyQuarantined {
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("postgres repository: repeated session quarantine commit: %w", err)
		}
		return nil
	}

	reason = boundReason(reason)
	if reason == "" {
		reason = persistedSessionIntegrityFailure
	}
	now := time.Now().UTC()
	updated, err := tx.ExecContext(ctx, `
		UPDATE rgs_sessions
		SET status='BLOCKED', integrity_quarantined_at=$3, updated_at=$3
		WHERE operator_id=$1 AND session_id=$2
		  AND integrity_quarantined_at IS NULL`,
		operatorID, sessionID, now,
	)
	if err != nil {
		return fmt.Errorf("postgres repository: quarantine session update: %w", err)
	}
	if rows, _ := updated.RowsAffected(); rows != 1 {
		return fmt.Errorf("postgres repository: quarantine session marker was not acquired")
	}
	payload := map[string]any{
		"sessionId":      sessionID,
		"reason":         reason,
		"previousStatus": previousStatus,
	}
	if pendingRoundID.Valid {
		payload["pendingRoundId"] = pendingRoundID.String
	}
	if err := insertOutbox(
		ctx, tx, operatorID, "session", sessionID, "SESSION_INTEGRITY_FAILED", payload,
	); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("postgres repository: session quarantine commit: %w", err)
	}
	notifySessionIntegrityObserver(observer)
	return nil
}

// quarantineCorruptRound 是 result_json 字段或冗余资金列不可信时的故障安全路径。
// 它无需解码派彩即可阻断所属会话；已提交轮次保留资金状态和成功钱包账本，
// 未提交轮次统一进入 MANUAL_REVIEW，且不得再做自动钱包恢复。
func quarantineCorruptRound(
	ctx context.Context,
	tx *sql.Tx,
	key rgs.RoundKey,
	reason string,
	observer rgs.IntegrityObserver,
) (rgs.RoundRecord, bool, error) {
	var serverTransactionID, persistedStatus string
	var alreadyQuarantined bool
	err := tx.QueryRowContext(ctx, `
		SELECT server_transaction_id, status, integrity_quarantined_at IS NOT NULL
		FROM rgs_rounds
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
		FOR UPDATE`,
		key.OperatorID, key.SessionID, key.RoundID,
	).Scan(&serverTransactionID, &persistedStatus, &alreadyQuarantined)
	if errors.Is(err, sql.ErrNoRows) {
		return rgs.RoundRecord{}, false, rgs.ErrRoundNotFound
	}
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: quarantine round identity: %w", err)
	}

	reason = boundReason(reason)
	if reason == "" {
		reason = "persisted round integrity validation failed"
	}
	if alreadyQuarantined {
		if err := tx.Commit(); err != nil {
			return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: repeated quarantine commit: %w", err)
		}
		return rgs.RoundRecord{
			Key: key, Status: rgs.RoundStatus(persistedStatus), FailureReason: reason,
		}, false, nil
	}
	now := time.Now().UTC()
	nextStatus := string(rgs.RoundManualReview)
	economicallyFinal := persistedStatus == string(rgs.RoundCommitted) || persistedStatus == "ROLLED_BACK"
	if economicallyFinal {
		nextStatus = persistedStatus
	}
	updated, err := tx.ExecContext(ctx, `
		UPDATE rgs_rounds
		SET status=$4, failure_code=$5, wallet_phase='', next_attempt_at=NULL,
			wallet_lease_until=NULL, updated_at=$6,
			integrity_quarantined_at=$6
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3`,
		key.OperatorID, key.SessionID, key.RoundID, nextStatus, reason, now,
	)
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: quarantine round update: %w", err)
	}
	if rows, _ := updated.RowsAffected(); rows != 1 {
		return rgs.RoundRecord{}, false, rgs.ErrRoundNotFound
	}
	if !economicallyFinal {
		_, err = tx.ExecContext(ctx, `
			UPDATE rgs_wallet_transactions
			SET status=CASE WHEN status='PENDING' THEN 'UNKNOWN' ELSE status END,
				failure_code=$3, updated_at=$4
			WHERE operator_id=$1 AND transaction_id=$2`,
			key.OperatorID, serverTransactionID, reason, now,
		)
		if err != nil {
			return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: quarantine wallet ledger: %w", err)
		}
	}
	sessionUpdated, err := tx.ExecContext(ctx, `
		UPDATE rgs_sessions SET status='BLOCKED', updated_at=$3
		WHERE operator_id=$1 AND session_id=$2`,
		key.OperatorID, key.SessionID, now,
	)
	if err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: quarantine session: %w", err)
	}
	if rows, _ := sessionUpdated.RowsAffected(); rows != 1 {
		return rgs.RoundRecord{}, false, rgs.ErrSessionNotFound
	}
	if err := insertOutbox(ctx, tx, key.OperatorID, "round", serverTransactionID, "ROUND_INTEGRITY_FAILED", map[string]any{
		"sessionId": key.SessionID, "roundId": key.RoundID,
		"reason": reason, "persistedStatus": persistedStatus,
	}); err != nil {
		return rgs.RoundRecord{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return rgs.RoundRecord{}, false, fmt.Errorf("postgres repository: quarantine commit: %w", err)
	}
	notifyRoundIntegrityObserver(observer)
	return rgs.RoundRecord{
		Key: key, Status: rgs.RoundStatus(nextStatus), FailureReason: reason,
		UpdatedAt: now,
	}, !economicallyFinal && persistedStatus != string(rgs.RoundManualReview), nil
}

// quarantineWalletClaimIntegrity 处理领取前发现的钱包账本缺失、重复或错绑。
// 调用方已按 session→round→wallet ledger 顺序持锁；这里先把该逻辑轮次下所有
// 非终态账本证据标记为 UNKNOWN，再复用轮次完整性隔离并原子提交。
func (r *Repository) quarantineWalletClaimIntegrity(
	ctx context.Context,
	tx *sql.Tx,
	key rgs.RoundKey,
	reason string,
) error {
	_, err := tx.ExecContext(ctx, `
		UPDATE rgs_wallet_transactions
		SET status=CASE WHEN status='PENDING' THEN 'UNKNOWN' ELSE status END,
			failure_code=$4, updated_at=clock_timestamp()
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3`,
		key.OperatorID, key.SessionID, key.RoundID, boundReason(reason),
	)
	if err != nil {
		return errors.Join(
			rgs.ErrManualReview,
			fmt.Errorf("postgres repository: quarantine wallet claim ledger: %w", err),
		)
	}
	_, _, quarantineErr := quarantineCorruptRound(
		ctx, tx, key, reason, r.integrityObserver,
	)
	return errors.Join(rgs.ErrManualReview, quarantineErr)
}

func notifyRoundIntegrityObserver(observer rgs.IntegrityObserver) {
	if observer == nil {
		return
	}
	defer func() { _ = recover() }()
	observer.RoundIntegrityQuarantined()
}

func notifySessionIntegrityObserver(observer rgs.IntegrityObserver) {
	if observer == nil {
		return
	}
	defer func() { _ = recover() }()
	observer.SessionIntegrityQuarantined()
}

func (r *Repository) Ping(ctx context.Context) error {
	if err := r.db.PingContext(ctx); err != nil {
		return fmt.Errorf("postgres repository: ping: %w", err)
	}
	return nil
}

// Name 与 Check 让 Repository 直接参与 platform.Readiness 的同一套依赖检查。
func (r *Repository) Name() string                    { return "database" }
func (r *Repository) Check(ctx context.Context) error { return r.Ping(ctx) }

const sessionSelect = `
	SELECT operator_id, session_id, player_id, wallet_account_id,
		wallet_session_id, game_id, definition_version, definition_hash,
		currency, currency_exponent, jurisdiction, status,
		balance_snapshot_minor, sequence, revision, feature_state,
		pending_round_id, expires_at, integrity_quarantined_at
	FROM rgs_sessions`

const roundSelect = `
	SELECT r.operator_id, r.session_id, r.round_id, r.server_transaction_id,
		r.request_fingerprint, r.status, r.round_kind, r.game_id,
		r.definition_version, r.definition_hash, r.currency, r.bet_minor,
		r.input_feature_state, r.charged_minor, r.win_minor, r.starting_revision,
		r.resulting_revision, r.sequence, r.result_json, r.outcome_hash,
		r.wallet_phase, r.next_attempt_at, r.apply_attempts, r.lookup_attempts,
		r.wallet_command_digest, r.wallet_profile,
		r.wallet_transaction_id, r.wallet_balance_minor, r.wallet_lease_until,
		r.failure_code, r.retry_count, r.created_at, r.updated_at,
		s.player_id, s.wallet_account_id, s.wallet_session_id,
		s.status, s.integrity_quarantined_at
	FROM rgs_rounds r
	JOIN rgs_sessions s ON s.operator_id=r.operator_id AND s.session_id=r.session_id`

type rowScanner interface {
	Scan(...any) error
}

func scanSession(row rowScanner) (rgs.Session, error) {
	return scanSessionWithTrailing(row)
}

func scanPrepareSession(row rowScanner) (rgs.Session, bool, time.Time, error) {
	var resultDeliveryPending bool
	var databaseNow time.Time
	session, err := scanSessionWithTrailing(row, &resultDeliveryPending, &databaseNow)
	if err != nil {
		return rgs.Session{}, false, time.Time{}, err
	}
	if databaseNow.IsZero() {
		return rgs.Session{}, false, time.Time{}, rgs.ErrSessionIntegrity
	}
	return session, resultDeliveryPending, databaseNow.UTC(), nil
}

func scanSessionWithTrailing(row rowScanner, trailing ...any) (rgs.Session, error) {
	var session rgs.Session
	var status string
	var sequence, revision int64
	var featureJSON []byte
	var pending sql.NullString
	var quarantinedAt sql.NullTime
	destinations := []any{
		&session.OperatorID, &session.SessionID, &session.PlayerID,
		&session.WalletAccountID, &session.WalletSessionID,
		&session.GameID, &session.DefinitionVersion, &session.DefinitionHash,
		&session.Currency, &session.CurrencyExponent, &session.Jurisdiction,
		&status, &session.BalanceMinor, &sequence, &revision, &featureJSON,
		&pending, &session.ExpiresAt, &quarantinedAt,
	}
	destinations = append(destinations, trailing...)
	err := row.Scan(destinations...)
	if errors.Is(err, sql.ErrNoRows) {
		return rgs.Session{}, rgs.ErrSessionNotFound
	}
	if err != nil {
		return rgs.Session{}, fmt.Errorf("postgres repository: scan session: %w", err)
	}
	if quarantinedAt.Valid {
		return rgs.Session{}, rgs.ErrSessionIntegrity
	}
	if sequence < 0 || revision < 0 || uint64(sequence) > rgs.MaxClientSequence {
		return rgs.Session{}, rgs.ErrSessionIntegrity
	}
	session.Status = rgs.SessionStatus(status)
	session.Sequence, session.Revision = uint64(sequence), uint64(revision)
	if pending.Valid {
		session.PendingRoundID = pending.String
	}
	if err := decodeStrictFeatureState(featureJSON, &session.Feature); err != nil {
		return rgs.Session{}, rgs.ErrSessionIntegrity
	}
	if err := rgs.ValidateSession(session); err != nil {
		return rgs.Session{}, rgs.ErrSessionIntegrity
	}
	return session, nil
}

func decodeStrictFeatureState(encoded []byte, destination *game.FeatureState) error {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("postgres repository: multiple feature-state documents")
		}
		return err
	}
	return nil
}

func scanRound(row rowScanner) (rgs.RoundRecord, error) {
	var record rgs.RoundRecord
	var status, roundKind string
	var startRevision, endRevision, sequence int64
	var serverTransactionID string
	var betMinor, chargedMinor, winMinor int64
	var inputFeatureJSON, resultJSON []byte
	var walletPhase string
	var nextAttemptAt sql.NullTime
	var walletCommandDigest sql.NullString
	var walletProfileJSON []byte
	var walletTransaction sql.NullString
	var walletBalance sql.NullInt64
	var walletLease sql.NullTime
	var failure sql.NullString
	var playerID, walletAccountID, walletSessionRef string
	var sessionStatus string
	var sessionQuarantinedAt sql.NullTime
	err := row.Scan(
		&record.Key.OperatorID, &record.Key.SessionID, &record.Key.RoundID,
		&serverTransactionID, &record.Fingerprint, &status,
		&roundKind, &record.Request.GameID, &record.Request.DefinitionVersion,
		&record.Request.DefinitionHash, &record.Request.Currency,
		&betMinor, &inputFeatureJSON, &chargedMinor, &winMinor, &startRevision, &endRevision,
		&sequence, &resultJSON, &record.OutcomeHash, &walletPhase, &nextAttemptAt,
		&record.WalletApplyAttempts, &record.WalletLookupAttempts, &walletCommandDigest,
		&walletProfileJSON,
		&walletTransaction,
		&walletBalance, &walletLease, &failure, &record.RetryCount,
		&record.CreatedAt, &record.UpdatedAt, &playerID, &walletAccountID,
		&walletSessionRef, &sessionStatus, &sessionQuarantinedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return rgs.RoundRecord{}, rgs.ErrRoundNotFound
	}
	if err != nil {
		return rgs.RoundRecord{}, fmt.Errorf("postgres repository: scan round: %w", err)
	}
	if sessionQuarantinedAt.Valid {
		return rgs.RoundRecord{}, rgs.ErrSessionIntegrity
	}
	if sessionStatus != string(rgs.SessionActive) && sessionStatus != string(rgs.SessionBlocked) &&
		sessionStatus != string(rgs.SessionClosed) && sessionStatus != string(rgs.SessionExpired) {
		return rgs.RoundRecord{}, rgs.ErrSessionIntegrity
	}
	if startRevision < 0 || startRevision >= int64(rgs.MaxStateRevision) ||
		endRevision != startRevision+1 || sequence < 1 ||
		uint64(sequence) > rgs.MaxClientSequence || betMinor <= 0 ||
		chargedMinor < 0 || winMinor < 0 {
		return rgs.RoundRecord{}, rgs.ErrManualReview
	}
	record.Status = rgs.RoundStatus(status)
	record.WalletPhase = rgs.WalletRecoveryAction(walletPhase)
	if len(walletProfileJSON) > 0 {
		if err := decodeStrictWalletProfile(walletProfileJSON, &record.WalletProfile); err != nil ||
			rgs.ValidateProfile(record.WalletProfile) != nil {
			return rgs.RoundRecord{}, rgs.ErrManualReview
		}
	}
	if nextAttemptAt.Valid {
		record.NextAttemptAt = nextAttemptAt.Time.UTC()
	}
	if record.RetryCount < 0 || record.WalletApplyAttempts < 0 || record.WalletLookupAttempts < 0 ||
		((record.Status == rgs.RoundPrepared || record.Status == rgs.RoundWalletPending) &&
			(!record.WalletPhase.Valid() || record.NextAttemptAt.IsZero() ||
				!rgs.SupportedSettlementProfile(record.WalletProfile))) {
		return rgs.RoundRecord{}, rgs.ErrManualReview
	}
	record.Request.OperatorID = record.Key.OperatorID
	record.Request.SessionID = record.Key.SessionID
	record.Request.RoundID = record.Key.RoundID
	record.Request.RoundKind = rgs.RoundKind(roundKind)
	record.Request.BetMinor = betMinor
	record.Request.StartRevision = uint64(startRevision)
	if err := rgs.ValidateSpinRequest(record.Request); err != nil {
		return rgs.RoundRecord{}, rgs.ErrManualReview
	}
	if record.Fingerprint != rgs.FingerprintFor(record.Request) {
		return rgs.RoundRecord{}, rgs.ErrManualReview
	}
	var inputFeature game.FeatureState
	if len(inputFeatureJSON) == 0 ||
		decodeStrictFeatureState(inputFeatureJSON, &inputFeature) != nil ||
		validateRoundInputFeature(inputFeature, record.Request) != nil {
		// input_feature_state 字段允许为空，只为迁移时保留无法证明局前状态的旧记录。
		// 禁止从当前会话或局后结果猜测；二者都可能描述更晚的状态。
		return rgs.RoundRecord{}, rgs.ErrManualReview
	}
	record.InputFeatureState = inputFeature
	if err := decodeStrictRoundResult(resultJSON, &record.Result); err != nil {
		return rgs.RoundRecord{}, rgs.ErrManualReview
	}
	if record.Result.OperatorID != record.Key.OperatorID ||
		record.Result.SessionID != record.Key.SessionID ||
		record.Result.RoundID != record.Key.RoundID ||
		record.Result.GameID != record.Request.GameID ||
		record.Result.DefinitionVersion != record.Request.DefinitionVersion ||
		record.Result.DefinitionHash != record.Request.DefinitionHash ||
		record.Result.Currency != record.Request.Currency ||
		record.Result.RoundKind != record.Request.RoundKind ||
		record.Result.StartRevision != uint64(startRevision) ||
		record.Result.Sequence != uint64(sequence) ||
		record.Result.ServerTransactionID != serverTransactionID ||
		record.Result.BetMinor != betMinor ||
		record.Result.ChargedBetMinor != chargedMinor ||
		record.Result.TotalWinMinor != winMinor {
		return rgs.RoundRecord{}, rgs.ErrManualReview
	}
	if record.Request.RoundKind == rgs.RoundKindBase && chargedMinor != betMinor {
		return rgs.RoundRecord{}, rgs.ErrManualReview
	}
	if record.Request.RoundKind == rgs.RoundKindFreeSpin && chargedMinor != 0 {
		return rgs.RoundRecord{}, rgs.ErrManualReview
	}
	if err := game.ValidateOutcomeStructure(
		game.SpinInput{BetMinor: betMinor, Feature: inputFeature},
		game.SpinOutcome{
			Grid: record.Result.Grid, Wins: record.Result.Wins,
			Events: record.Result.Events, TotalWinMinor: winMinor,
			NextFeature: record.Result.FeatureState,
		},
	); err != nil {
		return rgs.RoundRecord{}, rgs.ErrManualReview
	}
	actualOutcomeHash, err := rgs.PreparedOutcomeHashFor(record.Result)
	if err != nil || actualOutcomeHash != record.OutcomeHash {
		return rgs.RoundRecord{}, rgs.ErrManualReview
	}
	switch record.Status {
	case rgs.RoundCommitted:
		if record.Result.EndRevision != uint64(endRevision) ||
			!walletTransaction.Valid || !walletBalance.Valid ||
			record.Result.WalletTransactionID != walletTransaction.String ||
			record.Result.BalanceMinor != walletBalance.Int64 ||
			walletTransaction.String == "" || walletBalance.Int64 < 0 {
			return rgs.RoundRecord{}, rgs.ErrManualReview
		}
	case rgs.RoundPrepared, rgs.RoundWalletPending, rgs.RoundRejected, rgs.RoundManualReview:
		if record.Result.EndRevision != 0 ||
			record.Result.WalletTransactionID != "" || record.Result.BalanceMinor != 0 ||
			walletTransaction.Valid || walletBalance.Valid {
			return rgs.RoundRecord{}, rgs.ErrManualReview
		}
	default:
		return rgs.RoundRecord{}, rgs.ErrManualReview
	}
	record.WalletCommand = rgs.WalletRound{
		OperationID: serverTransactionID, Fingerprint: record.Fingerprint,
		OperatorID: record.Key.OperatorID, PlayerID: playerID,
		WalletAccountID: walletAccountID, WalletSessionRef: walletSessionRef,
		SessionID: record.Key.SessionID,
		RoundID:   record.Key.RoundID, GameID: record.Request.GameID,
		DefinitionVersion: record.Request.DefinitionVersion,
		DefinitionHash:    record.Request.DefinitionHash, RoundKind: record.Request.RoundKind,
		Currency: record.Request.Currency, DebitMinor: record.Result.ChargedBetMinor,
		CreditMinor: record.Result.TotalWinMinor,
	}
	computedCommandDigest := rgs.CommandDigestFor(record.WalletCommand)
	if (record.Status == rgs.RoundPrepared || record.Status == rgs.RoundWalletPending) &&
		!walletCommandDigest.Valid {
		return rgs.RoundRecord{}, rgs.ErrManualReview
	}
	if walletCommandDigest.Valid && walletCommandDigest.String != computedCommandDigest {
		return rgs.RoundRecord{}, rgs.ErrManualReview
	}
	record.WalletCommand.CommandDigest = computedCommandDigest
	if err := rgs.ValidateWalletCommand(record.WalletCommand); err != nil {
		return rgs.RoundRecord{}, rgs.ErrManualReview
	}
	if walletTransaction.Valid && walletBalance.Valid {
		record.WalletReceipt = &rgs.WalletReceipt{
			OperationID: record.WalletCommand.OperationID,
			Fingerprint: record.Fingerprint, TransactionID: walletTransaction.String,
			OperatorID: record.Key.OperatorID, Currency: record.Request.Currency,
			DebitMinor:   record.Result.ChargedBetMinor,
			CreditMinor:  record.Result.TotalWinMinor,
			BalanceMinor: walletBalance.Int64,
		}
	}
	if walletLease.Valid {
		record.WalletLeaseUntil = walletLease.Time
	}
	if failure.Valid {
		record.FailureReason = failure.String
	}
	return record, nil
}

func decodeStrictWalletProfile(encoded []byte, destination *rgs.Profile) error {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("postgres repository: wallet profile contains trailing data")
	}
	return nil
}

func validateRoundInputFeature(feature game.FeatureState, request rgs.SpinRequest) error {
	if feature.RageLevel < game.DefaultRageLevel || feature.RageLevel > game.MaxRageCollected ||
		feature.RageCollected < 0 || feature.RageCollected > game.MaxRageCollected ||
		(feature.RageCollected == 0 && feature.RageLevel != game.DefaultRageLevel) {
		return errors.New("postgres repository: invalid round input Rage meter")
	}
	if !feature.Active() {
		if (feature.Mode != "" && feature.Mode != game.FeatureNone) ||
			feature.Remaining != 0 || feature.Awarded != 0 || feature.BetMinor != 0 ||
			feature.WinMinor != 0 || request.RoundKind != rgs.RoundKindBase {
			return errors.New("postgres repository: invalid base round input feature")
		}
		return nil
	}
	if (feature.Mode != game.FeatureExpansion && feature.Mode != game.FeatureOverdrive) ||
		feature.Remaining < 1 || feature.Awarded < feature.Remaining ||
		feature.Remaining > game.MaxFeatureSpins || feature.Awarded > game.MaxFeatureSpins ||
		feature.BetMinor != request.BetMinor || feature.WinMinor < 0 ||
		request.RoundKind != rgs.RoundKindFreeSpin {
		return errors.New("postgres repository: invalid Free Spin round input feature")
	}
	return nil
}

func decodeStrictRoundResult(encoded []byte, destination *rgs.SpinResult) error {
	if err := requirePathAwardBaseAmountPresence(encoded); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("postgres repository: multiple round result documents")
		}
		return err
	}
	return nil
}

// requirePathAwardBaseAmountPresence 区分缺失数字字段与显式零值；Go JSON 解码器会把
// 两者都映射为 int64(0)。低投注分配可以合法产生零值路径，但权威的乘数前金额仍必须
// 显式存在于持久化结果中，不能因零值而省略。
func requirePathAwardBaseAmountPresence(encoded []byte) error {
	type pathAwardPresence struct {
		BaseAmountMinor *json.RawMessage `json:"BaseAmountMinor"`
	}
	var projection struct {
		Wins []struct {
			PathAwards []pathAwardPresence `json:"PathAwards"`
		} `json:"Wins"`
	}
	if err := json.Unmarshal(encoded, &projection); err != nil {
		return err
	}
	for winIndex, win := range projection.Wins {
		for pathIndex, award := range win.PathAwards {
			if award.BaseAmountMinor == nil {
				return fmt.Errorf(
					"postgres repository: Wins[%d].PathAwards[%d].BaseAmountMinor is required",
					winIndex,
					pathIndex,
				)
			}
		}
	}
	return nil
}

func lockSession(ctx context.Context, tx *sql.Tx, key rgs.RoundKey) (rgs.Session, error) {
	return scanSession(tx.QueryRowContext(ctx, sessionSelect+`
		WHERE operator_id=$1 AND session_id=$2 FOR UPDATE`, key.OperatorID, key.SessionID))
}

func lockRound(ctx context.Context, tx *sql.Tx, key rgs.RoundKey) (rgs.RoundRecord, error) {
	return scanRound(tx.QueryRowContext(ctx, roundSelect+`
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3 FOR UPDATE OF r`,
		key.OperatorID, key.SessionID, key.RoundID,
	))
}

func validateBinding(session rgs.Session, request rgs.SpinRequest) error {
	if session.OperatorID != request.OperatorID || session.SessionID != request.SessionID {
		return rgs.ErrSessionNotFound
	}
	if session.GameID != request.GameID ||
		session.DefinitionVersion != request.DefinitionVersion ||
		session.DefinitionHash != request.DefinitionHash ||
		session.Currency != request.Currency {
		return rgs.ErrInvalidRequest
	}
	if session.Status == rgs.SessionBlocked {
		return rgs.ErrManualReview
	}
	if session.Status != rgs.SessionActive {
		return rgs.ErrInvalidRequest
	}
	if !session.ExpiresAt.After(time.Now()) {
		return rgs.ErrSessionExpired
	}
	if session.Revision != request.StartRevision {
		return rgs.ErrRevisionConflict
	}
	expectedKind := rgs.RoundKindBase
	if session.Feature.Active() {
		expectedKind = rgs.RoundKindFreeSpin
	}
	if request.RoundKind != expectedKind {
		return rgs.ErrInvalidRequest
	}
	if session.Sequence >= rgs.MaxClientSequence || session.Revision >= rgs.MaxStateRevision {
		return rgs.ErrInvalidRequest
	}
	return nil
}

func validatePrepared(session rgs.Session, request rgs.SpinRequest, result rgs.SpinResult) error {
	if result.OperatorID != request.OperatorID || result.SessionID != request.SessionID ||
		result.RoundID != request.RoundID || result.GameID != request.GameID ||
		result.DefinitionVersion != request.DefinitionVersion ||
		result.DefinitionHash != request.DefinitionHash ||
		result.Currency != request.Currency || result.RoundKind != request.RoundKind ||
		result.StartRevision != request.StartRevision || result.EndRevision != 0 ||
		result.Sequence != session.Sequence+1 || result.BetMinor != request.BetMinor ||
		result.ServerTransactionID == "" || result.WalletTransactionID != "" ||
		result.BalanceMinor != 0 || result.ChargedBetMinor < 0 ||
		result.TotalWinMinor < 0 {
		return rgs.ErrInvalidRequest
	}
	if request.RoundKind == rgs.RoundKindBase && result.ChargedBetMinor != request.BetMinor {
		return rgs.ErrInvalidRequest
	}
	if request.RoundKind == rgs.RoundKindFreeSpin && result.ChargedBetMinor != 0 {
		return rgs.ErrInvalidRequest
	}
	return nil
}

func validateReceipt(command rgs.WalletRound, receipt rgs.WalletReceipt) error {
	return rgs.ValidateWalletReceipt(command, receipt)
}

func insertOutbox(
	ctx context.Context,
	tx *sql.Tx,
	operatorID, aggregateType, aggregateID, eventType string,
	payload any,
) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("postgres repository: encode outbox event: %w", err)
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO rgs_outbox (
			operator_id, aggregate_type, aggregate_id, event_type, payload
		) VALUES ($1,$2,$3,$4,$5)`,
		operatorID, aggregateType, aggregateID, eventType, encoded,
	)
	if err != nil {
		return fmt.Errorf("postgres repository: insert outbox event: %w", err)
	}
	return nil
}

func checkedInt64(value uint64) int64 {
	if value > uint64(^uint64(0)>>1) {
		panic("postgres repository: uint64 exceeds bigint")
	}
	return int64(value)
}

func boundReason(reason string) string {
	if len(reason) > 512 {
		return reason[:512]
	}
	return reason
}

type sqlStateError interface {
	SQLState() string
}

func sqlState(err error) string {
	var state sqlStateError
	if errors.As(err, &state) {
		return state.SQLState()
	}
	return ""
}

var _ rgs.Repository = (*Repository)(nil)
var _ rgs.RecoveryRepository = (*Repository)(nil)
