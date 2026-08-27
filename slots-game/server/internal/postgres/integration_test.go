package postgres

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"slots-game/server/internal/game"
	"slots-game/server/internal/launch"
	"slots-game/server/internal/operator"
	"slots-game/server/internal/rgs"
)

func TestPostgresProductionRoundAndCredentialConcurrency(t *testing.T) {
	databaseURLs := requirePostgresTestURLs(t)
	database, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	migrator, err := sql.Open("pgx", databaseURLs.migrator)
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := database.PingContext(ctx); err != nil {
		t.Fatal(err)
	}
	schemaCheck, err := NewSchemaCheck(database)
	if err != nil {
		t.Fatal(err)
	}
	privilegeCheck, err := NewRuntimePrivilegeCheck(database)
	if err != nil {
		t.Fatal(err)
	}
	if err := schemaCheck.Check(ctx); err != nil {
		t.Fatalf("runtime schema readiness: %v", err)
	}
	if err := privilegeCheck.Check(ctx); err != nil {
		t.Fatalf("runtime privilege readiness: %v", err)
	}
	truncateIntegrationTables(t, migrator)
	defer truncateIntegrationTables(t, migrator)

	repositoryA, _ := NewRepository(database)
	repositoryB, _ := NewRepository(database)
	hash := strings.Repeat("a", 64)
	session := rgs.Session{
		OperatorID: "operator-a", SessionID: "session-a", PlayerID: "player-a",
		WalletAccountID: "wallet-a", WalletSessionID: "wallet-session-a",
		GameID: "game-a", DefinitionVersion: "math-v1", DefinitionHash: hash,
		Currency: "EUR", CurrencyExponent: 2, Jurisdiction: "MT",
		Status: rgs.SessionActive, ExpiresAt: time.Now().Add(time.Hour),
		IdleDisconnect: 20 * time.Minute, IdleDisconnectAt: time.Now().Add(20 * time.Minute),
		TransportGeneration: 1,
		BalanceMinor:        10_000, Feature: game.EmptyFeatureState(),
	}
	if err := repositoryA.CreateSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	spinner := &integrationSpinner{}
	wallet := &integrationWallet{balance: session.BalanceMinor, receipts: make(map[string]rgs.WalletReceipt)}
	registry, err := rgs.NewMemoryDefinitionRegistry(rgs.DefinitionEntry{
		GameID: session.GameID, Version: session.DefinitionVersion,
		SHA256: hash, Spinner: spinner,
	})
	if err != nil {
		t.Fatal(err)
	}
	coordinatorA, err := rgs.NewCoordinator(rgs.CoordinatorConfig{}, repositoryA, wallet, registry)
	if err != nil {
		t.Fatal(err)
	}
	coordinatorB, err := rgs.NewCoordinator(rgs.CoordinatorConfig{}, repositoryB, wallet, registry)
	if err != nil {
		t.Fatal(err)
	}
	request := rgs.SpinRequest{
		OperatorID: session.OperatorID, SessionID: session.SessionID,
		RoundID: "round-a", GameID: session.GameID,
		DefinitionVersion: session.DefinitionVersion, DefinitionHash: hash,
		Currency: session.Currency, RoundKind: rgs.RoundKindBase,
		BetMinor: 100, StartRevision: 0, TransportGeneration: 1,
	}
	const callers = 32
	var group sync.WaitGroup
	group.Add(callers)
	results := make([]rgs.SpinResult, callers)
	failures := make([]error, callers)
	for index := range callers {
		go func() {
			defer group.Done()
			coordinator := coordinatorA
			if index%2 == 1 {
				coordinator = coordinatorB
			}
			results[index], failures[index] = coordinator.Spin(context.Background(), request)
		}()
	}
	group.Wait()
	for index, err := range failures {
		if err != nil {
			t.Fatalf("Spin[%d]: %v", index, err)
		}
		if results[index].WalletTransactionID != "wallet-tx-round-a" ||
			results[index].BalanceMinor != 9_950 ||
			len(results[index].Wins) != 1 || len(results[index].Wins[0].PathAwards) != 1 ||
			results[index].Wins[0].PathAwards[0].BaseAmountMinor != 50 {
			t.Fatalf("Spin[%d] = %+v", index, results[index])
		}
	}
	if spinner.calls.Load() != 1 || wallet.applyCalls.Load() != 1 {
		t.Fatalf("side effects: engine=%d wallet=%d", spinner.calls.Load(), wallet.applyCalls.Load())
	}
	var ledgerStatus, operatorReference string
	if err := database.QueryRowContext(ctx, `
		SELECT status, operator_reference
		FROM rgs_wallet_transactions
		WHERE operator_id='operator-a' AND transaction_id=$1`,
		results[0].ServerTransactionID,
	).Scan(&ledgerStatus, &operatorReference); err != nil {
		t.Fatal(err)
	}
	if ledgerStatus != "SUCCEEDED" || operatorReference != "wallet-tx-round-a" {
		t.Fatalf("wallet ledger = %s %s", ledgerStatus, operatorReference)
	}
	delivery, err := repositoryB.GetPendingResultDelivery(ctx, session.OperatorID, session.SessionID)
	if err != nil || delivery.RoundID != request.RoundID ||
		delivery.Sequence != results[0].Sequence || !reflect.DeepEqual(delivery.Result, results[0]) ||
		delivery.OriginFeatureState != session.Feature {
		t.Fatalf("pending delivery = %+v, error = %v", delivery, err)
	}
	if _, err := coordinatorA.Spin(ctx, rgs.SpinRequest{
		OperatorID: session.OperatorID, SessionID: session.SessionID,
		RoundID: "round-b", GameID: session.GameID,
		DefinitionVersion: session.DefinitionVersion, DefinitionHash: hash,
		Currency: session.Currency, RoundKind: rgs.RoundKindBase,
		BetMinor: 100, StartRevision: 1, TransportGeneration: 1,
	}); !errors.Is(err, rgs.ErrResultDeliveryPending) {
		t.Fatalf("next spin before ACK error = %v", err)
	}
	receipt := rgs.ResultDeliveryAcknowledgement{
		OperatorID: delivery.OperatorID, SessionID: delivery.SessionID,
		RoundID: delivery.RoundID, Sequence: delivery.Sequence, ResultHash: delivery.ResultHash,
		TransportGeneration: 1,
	}
	reset, err := repositoryB.ResetSessionTransport(
		ctx, session.OperatorID, session.SessionID, 20*time.Minute,
	)
	if err != nil || reset.TransportGeneration != 2 {
		t.Fatalf("transport reset = %+v error=%v", reset, err)
	}
	if _, changed, err := repositoryA.AcknowledgeResultDelivery(ctx, receipt); !errors.Is(err, rgs.ErrSessionTimeout) || changed {
		t.Fatalf("old-generation result delivery ACK changed=%v error=%v", changed, err)
	}
	if pending, err := repositoryA.GetPendingResultDelivery(ctx, session.OperatorID, session.SessionID); err != nil || pending.ResultHash != delivery.ResultHash || !pending.AcknowledgedAt.IsZero() {
		t.Fatalf("pending delivery after fenced ACK = %+v error=%v", pending, err)
	}
	receipt.TransportGeneration = reset.TransportGeneration
	if _, changed, err := repositoryA.AcknowledgeResultDelivery(ctx, receipt); err != nil || !changed {
		t.Fatalf("first result delivery ACK changed=%v error=%v", changed, err)
	}
	if _, changed, err := repositoryB.AcknowledgeResultDelivery(ctx, receipt); err != nil || changed {
		t.Fatalf("idempotent result delivery ACK changed=%v error=%v", changed, err)
	}
	if _, err := repositoryA.GetPendingResultDelivery(ctx, session.OperatorID, session.SessionID); !errors.Is(err, rgs.ErrResultDeliveryNotFound) {
		t.Fatalf("pending delivery after ACK error = %v", err)
	}

	testPostgresCredentialConcurrency(t, database)
	testRuntimePrivilegeBoundary(t, database)
}

func TestPostgresPrepareRechecksIdleDeadlineAfterWaitingForSessionLock(t *testing.T) {
	databaseURLs := requirePostgresTestURLs(t)
	lockerDB, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer lockerDB.Close()
	contenderDB, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer contenderDB.Close()
	// 单连接连接池保证下方取得的后端 PID 就是执行 PrepareRound 的连接，
	// 因而 pg_blocking_pids 的锁等待判定具有确定性。
	contenderDB.SetMaxOpenConns(1)
	contenderDB.SetMaxIdleConns(1)
	migrator, err := sql.Open("pgx", databaseURLs.migrator)
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	truncateIntegrationTables(t, migrator)
	defer truncateIntegrationTables(t, migrator)

	var databaseNow time.Time
	if err := migrator.QueryRowContext(ctx, databaseClockSQL).Scan(&databaseNow); err != nil {
		t.Fatal(err)
	}
	databaseNow = databaseNow.UTC()
	idleDeadline := databaseNow.Add(2 * time.Second)
	hash := strings.Repeat("a", 64)
	session := rgs.Session{
		OperatorID: "operator-idle-lock", SessionID: "session-idle-lock",
		PlayerID: "player-idle-lock", WalletAccountID: "wallet-idle-lock",
		WalletSessionID: "wallet-session-idle-lock",
		GameID:          "game-a", DefinitionVersion: "math-v1", DefinitionHash: hash,
		Currency: "USD", CurrencyExponent: 2, Jurisdiction: "MT",
		Status: rgs.SessionActive, ExpiresAt: databaseNow.Add(time.Hour),
		IdleDisconnect: 2 * time.Second, IdleDisconnectAt: idleDeadline,
		TransportGeneration: 1, BalanceMinor: 10_000, Feature: game.EmptyFeatureState(),
	}
	lockerRepository, err := NewRepository(lockerDB)
	if err != nil {
		t.Fatal(err)
	}
	if err := lockerRepository.CreateSession(ctx, session); err != nil {
		t.Fatal(err)
	}

	lockerTx, err := lockerDB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	defer lockerTx.Rollback()
	if _, err := lockerTx.ExecContext(ctx, `
		SELECT 1 FROM rgs_sessions
		WHERE operator_id=$1 AND session_id=$2
		FOR UPDATE`, session.OperatorID, session.SessionID); err != nil {
		t.Fatal(err)
	}

	var contenderPID int
	if err := contenderDB.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&contenderPID); err != nil {
		t.Fatal(err)
	}
	contenderRepository, err := NewRepository(contenderDB)
	if err != nil {
		t.Fatal(err)
	}
	request := rgs.SpinRequest{
		OperatorID: session.OperatorID, SessionID: session.SessionID,
		RoundID: "round-idle-lock", GameID: session.GameID,
		DefinitionVersion: session.DefinitionVersion, DefinitionHash: session.DefinitionHash,
		Currency: session.Currency, RoundKind: rgs.RoundKindBase,
		BetMinor: 100, StartRevision: 0, TransportGeneration: 1,
	}
	type prepareResult struct {
		prepared bool
		err      error
	}
	resultChannel := make(chan prepareResult, 1)
	var prepareCalls atomic.Int64
	go func() {
		_, prepared, prepareErr := contenderRepository.PrepareRound(
			ctx, request, rgs.FingerprintFor(request),
			rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
				"https://wallet.test.invalid/idle-lock",
			)),
			func(rgs.Session) (rgs.SpinResult, error) {
				prepareCalls.Add(1)
				return validPreparedSessionIntegrityResult(request, 1), nil
			},
		)
		resultChannel <- prepareResult{prepared: prepared, err: prepareErr}
	}()

	// 直接证明竞争者在截止时间前已进入并阻塞于会话行，不依赖调度器休眠或进程时钟。
	waitForPostgresBlocker(t, ctx, migrator, contenderPID)
	var blockedAt time.Time
	if err := migrator.QueryRowContext(ctx, databaseClockSQL).Scan(&blockedAt); err != nil {
		t.Fatal(err)
	}
	if !blockedAt.Before(idleDeadline) {
		t.Fatalf("contender reached row lock wait at %s, not before idle deadline %s",
			blockedAt.UTC(), idleDeadline)
	}
	waitForPostgresClock(t, ctx, migrator, idleDeadline)
	if err := lockerTx.Commit(); err != nil {
		t.Fatal(err)
	}

	select {
	case result := <-resultChannel:
		if !errors.Is(result.err, rgs.ErrSessionTimeout) || result.prepared {
			t.Fatalf("PrepareRound after lock wait = prepared:%t error:%v, want SESSION_TIMEOUT",
				result.prepared, result.err)
		}
	case <-ctx.Done():
		t.Fatalf("PrepareRound remained blocked: %v", ctx.Err())
	}
	if calls := prepareCalls.Load(); calls != 0 {
		t.Fatalf("RNG/prepare callback calls = %d, want 0", calls)
	}

	var roundCount, walletCount, roundOutboxCount, riskCount int
	if err := migrator.QueryRowContext(ctx, `
		SELECT
			(SELECT count(*) FROM rgs_rounds
			 WHERE operator_id=$1 AND session_id=$2),
			(SELECT count(*) FROM rgs_wallet_transactions
			 WHERE operator_id=$1 AND session_id=$2),
			(SELECT count(*) FROM rgs_outbox
			 WHERE operator_id=$1 AND aggregate_type='round'),
			(SELECT count(*) FROM rgs_risk_reviews
			 WHERE operator_id=$1 AND session_id=$2)`,
		session.OperatorID, session.SessionID,
	).Scan(&roundCount, &walletCount, &roundOutboxCount, &riskCount); err != nil {
		t.Fatal(err)
	}
	if roundCount != 0 || walletCount != 0 || roundOutboxCount != 0 || riskCount != 0 {
		t.Fatalf("timed-out intent side effects = rounds:%d wallet:%d outbox:%d risk:%d",
			roundCount, walletCount, roundOutboxCount, riskCount)
	}
	var pendingRoundID sql.NullString
	var persistedDeadline time.Time
	var revision, sequence int64
	if err := migrator.QueryRowContext(ctx, `
		SELECT pending_round_id, idle_disconnect_at, revision, sequence
		FROM rgs_sessions WHERE operator_id=$1 AND session_id=$2`,
		session.OperatorID, session.SessionID,
	).Scan(&pendingRoundID, &persistedDeadline, &revision, &sequence); err != nil {
		t.Fatal(err)
	}
	if pendingRoundID.Valid || !persistedDeadline.Equal(idleDeadline) || revision != 0 || sequence != 0 {
		t.Fatalf("timed-out intent mutated session = pending:%v idle:%s revision:%d sequence:%d",
			pendingRoundID, persistedDeadline.UTC(), revision, sequence)
	}
}

func TestPostgresPrepareRechecksDeliveryFenceAfterWaitingForSessionLock(t *testing.T) {
	databaseURLs := requirePostgresTestURLs(t)
	lockerDB, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer lockerDB.Close()
	contenderDB, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer contenderDB.Close()
	contenderDB.SetMaxOpenConns(1)
	contenderDB.SetMaxIdleConns(1)
	migrator, err := sql.Open("pgx", databaseURLs.migrator)
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	truncateIntegrationTables(t, migrator)
	defer truncateIntegrationTables(t, migrator)

	var databaseNow time.Time
	if err := migrator.QueryRowContext(ctx, databaseClockSQL).Scan(&databaseNow); err != nil {
		t.Fatal(err)
	}
	databaseNow = databaseNow.UTC()
	hash := strings.Repeat("a", 64)
	session := rgs.Session{
		OperatorID: "operator-delivery-lock", SessionID: "session-delivery-lock",
		PlayerID: "player-delivery-lock", WalletAccountID: "wallet-delivery-lock",
		WalletSessionID: "wallet-session-delivery-lock",
		GameID:          "game-a", DefinitionVersion: "math-v1", DefinitionHash: hash,
		Currency: "USD", CurrencyExponent: 2, Jurisdiction: "MT",
		Status: rgs.SessionActive, ExpiresAt: databaseNow.Add(time.Hour),
		IdleDisconnect: 20 * time.Minute, IdleDisconnectAt: databaseNow.Add(20 * time.Minute),
		TransportGeneration: 1, BalanceMinor: 10_000, Feature: game.EmptyFeatureState(),
	}
	lockerRepository, err := NewRepository(lockerDB)
	if err != nil {
		t.Fatal(err)
	}
	if err := lockerRepository.CreateSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	spinner := &integrationSpinner{}
	wallet := &integrationWallet{balance: session.BalanceMinor, receipts: make(map[string]rgs.WalletReceipt)}
	registry, err := rgs.NewMemoryDefinitionRegistry(rgs.DefinitionEntry{
		GameID: session.GameID, Version: session.DefinitionVersion,
		SHA256: session.DefinitionHash, Spinner: spinner,
	})
	if err != nil {
		t.Fatal(err)
	}
	coordinator, err := rgs.NewCoordinator(rgs.CoordinatorConfig{}, lockerRepository, wallet, registry)
	if err != nil {
		t.Fatal(err)
	}
	committedRequest := rgs.SpinRequest{
		OperatorID: session.OperatorID, SessionID: session.SessionID,
		RoundID: "round-delivery-committed", GameID: session.GameID,
		DefinitionVersion: session.DefinitionVersion, DefinitionHash: session.DefinitionHash,
		Currency: session.Currency, RoundKind: rgs.RoundKindBase,
		BetMinor: 100, StartRevision: 0, TransportGeneration: 1,
	}
	committed, err := coordinator.Spin(ctx, committedRequest)
	if err != nil {
		t.Fatal(err)
	}
	delivery, err := lockerRepository.GetPendingResultDelivery(ctx, session.OperatorID, session.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if _, changed, err := lockerRepository.AcknowledgeResultDelivery(ctx, rgs.ResultDeliveryAcknowledgement{
		OperatorID: session.OperatorID, SessionID: session.SessionID,
		RoundID: committedRequest.RoundID, Sequence: committed.Sequence,
		ResultHash: delivery.ResultHash, TransportGeneration: 1,
	}); err != nil || !changed {
		t.Fatalf("acknowledge setup delivery changed=%t error=%v", changed, err)
	}

	var baselineRounds, baselineWallet, baselineRoundOutbox, baselineRisk int
	if err := migrator.QueryRowContext(ctx, `
		SELECT
			(SELECT count(*) FROM rgs_rounds
			 WHERE operator_id=$1 AND session_id=$2),
			(SELECT count(*) FROM rgs_wallet_transactions
			 WHERE operator_id=$1 AND session_id=$2),
			(SELECT count(*) FROM rgs_outbox
			 WHERE operator_id=$1 AND aggregate_type='round'),
			(SELECT count(*) FROM rgs_risk_reviews
			 WHERE operator_id=$1 AND session_id=$2)`,
		session.OperatorID, session.SessionID,
	).Scan(&baselineRounds, &baselineWallet, &baselineRoundOutbox, &baselineRisk); err != nil {
		t.Fatal(err)
	}
	var baselineDeadline time.Time
	if err := migrator.QueryRowContext(ctx, `
		SELECT idle_disconnect_at FROM rgs_sessions
		WHERE operator_id=$1 AND session_id=$2`,
		session.OperatorID, session.SessionID,
	).Scan(&baselineDeadline); err != nil {
		t.Fatal(err)
	}

	lockerTx, err := lockerDB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	defer lockerTx.Rollback()
	if _, err := lockerTx.ExecContext(ctx, `
		SELECT 1 FROM rgs_sessions
		WHERE operator_id=$1 AND session_id=$2
		FOR UPDATE`, session.OperatorID, session.SessionID); err != nil {
		t.Fatal(err)
	}

	var contenderPID int
	if err := contenderDB.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&contenderPID); err != nil {
		t.Fatal(err)
	}
	contenderRepository, err := NewRepository(contenderDB)
	if err != nil {
		t.Fatal(err)
	}
	request := rgs.SpinRequest{
		OperatorID: session.OperatorID, SessionID: session.SessionID,
		RoundID: "round-delivery-next", GameID: session.GameID,
		DefinitionVersion: session.DefinitionVersion, DefinitionHash: session.DefinitionHash,
		Currency: session.Currency, RoundKind: rgs.RoundKindBase,
		BetMinor: 100, StartRevision: 1, TransportGeneration: 1,
	}
	type prepareResult struct {
		prepared bool
		err      error
	}
	resultChannel := make(chan prepareResult, 1)
	var prepareCalls atomic.Int64
	go func() {
		_, prepared, prepareErr := contenderRepository.PrepareRound(
			ctx, request, rgs.FingerprintFor(request),
			rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
				"https://wallet.test.invalid/delivery-lock",
			)),
			func(rgs.Session) (rgs.SpinResult, error) {
				prepareCalls.Add(1)
				result := validPreparedSessionIntegrityResult(request, 2)
				result.ServerTransactionID = "rgs-op-v1:delivery-lock-next"
				return result, nil
			},
		)
		resultChannel <- prepareResult{prepared: prepared, err: prepareErr}
	}()

	waitForPostgresBlocker(t, ctx, migrator, contenderPID)
	if _, err := lockerTx.ExecContext(ctx, `
		UPDATE rgs_rounds
		SET result_delivery_required=TRUE, result_acknowledged_at=NULL
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
		  AND status='COMMITTED'`,
		session.OperatorID, session.SessionID, committedRequest.RoundID,
	); err != nil {
		t.Fatal(err)
	}
	if err := lockerTx.Commit(); err != nil {
		t.Fatal(err)
	}

	select {
	case result := <-resultChannel:
		if !errors.Is(result.err, rgs.ErrResultDeliveryPending) || result.prepared {
			t.Fatalf("PrepareRound after delivery commit = prepared:%t error:%v, want pending fence",
				result.prepared, result.err)
		}
	case <-ctx.Done():
		t.Fatalf("PrepareRound remained blocked: %v", ctx.Err())
	}
	if calls := prepareCalls.Load(); calls != 0 {
		t.Fatalf("RNG/prepare callback calls = %d, want 0", calls)
	}

	var roundCount, walletCount, roundOutboxCount, riskCount int
	if err := migrator.QueryRowContext(ctx, `
		SELECT
			(SELECT count(*) FROM rgs_rounds
			 WHERE operator_id=$1 AND session_id=$2),
			(SELECT count(*) FROM rgs_wallet_transactions
			 WHERE operator_id=$1 AND session_id=$2),
			(SELECT count(*) FROM rgs_outbox
			 WHERE operator_id=$1 AND aggregate_type='round'),
			(SELECT count(*) FROM rgs_risk_reviews
			 WHERE operator_id=$1 AND session_id=$2)`,
		session.OperatorID, session.SessionID,
	).Scan(&roundCount, &walletCount, &roundOutboxCount, &riskCount); err != nil {
		t.Fatal(err)
	}
	if roundCount != baselineRounds || walletCount != baselineWallet ||
		roundOutboxCount != baselineRoundOutbox || riskCount != baselineRisk {
		t.Fatalf("fenced intent changed economic counts: rounds %d/%d wallet %d/%d outbox %d/%d risk %d/%d",
			roundCount, baselineRounds, walletCount, baselineWallet,
			roundOutboxCount, baselineRoundOutbox, riskCount, baselineRisk)
	}
	var pendingRoundID sql.NullString
	var persistedDeadline time.Time
	var revision, sequence int64
	if err := migrator.QueryRowContext(ctx, `
		SELECT pending_round_id, idle_disconnect_at, revision, sequence
		FROM rgs_sessions WHERE operator_id=$1 AND session_id=$2`,
		session.OperatorID, session.SessionID,
	).Scan(&pendingRoundID, &persistedDeadline, &revision, &sequence); err != nil {
		t.Fatal(err)
	}
	if pendingRoundID.Valid || !persistedDeadline.Equal(baselineDeadline) || revision != 1 || sequence != 1 {
		t.Fatalf("fenced intent mutated session = pending:%v idle:%s revision:%d sequence:%d",
			pendingRoundID, persistedDeadline.UTC(), revision, sequence)
	}
}

func waitForPostgresBlocker(t *testing.T, ctx context.Context, observer *sql.DB, backendPID int) {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var blockers int
		if err := observer.QueryRowContext(ctx,
			`SELECT cardinality(pg_blocking_pids($1))`, backendPID,
		).Scan(&blockers); err != nil {
			t.Fatal(err)
		}
		if blockers > 0 {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("backend %d never waited for the session row lock: %v", backendPID, ctx.Err())
		case <-ticker.C:
		}
	}
}

func waitForPostgresClock(t *testing.T, ctx context.Context, database *sql.DB, deadline time.Time) {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var now time.Time
		if err := database.QueryRowContext(ctx, databaseClockSQL).Scan(&now); err != nil {
			t.Fatal(err)
		}
		if !now.Before(deadline) {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("database clock did not reach idle deadline %s: %v", deadline, ctx.Err())
		case <-ticker.C:
		}
	}
}

func TestPostgresHighValueRiskApprovalGatesWalletClaim(t *testing.T) {
	databaseURLs := requirePostgresTestURLs(t)
	database, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	migrator, err := sql.Open("pgx", databaseURLs.migrator)
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	truncateIntegrationTables(t, migrator)
	defer truncateIntegrationTables(t, migrator)

	policy := rgs.HighValueRiskPolicy{
		Enabled: true, ThresholdMinor: 50, PolicyVersion: "payout-v1",
		ReviewTTL: time.Hour, ExpiryPolicy: rgs.RiskExpiryReject,
	}
	repository, err := NewRepositoryWithOptions(database, RepositoryOptions{RiskPolicy: policy})
	if err != nil {
		t.Fatal(err)
	}
	hash := strings.Repeat("a", 64)
	session := rgs.Session{
		OperatorID: "operator-risk", SessionID: "session-risk", PlayerID: "player-risk",
		WalletAccountID: "wallet-risk", WalletSessionID: "wallet-session-risk",
		GameID: "game-a", DefinitionVersion: "math-v1", DefinitionHash: hash,
		Currency: "EUR", CurrencyExponent: 2, Jurisdiction: "MT",
		Status: rgs.SessionActive, ExpiresAt: time.Now().Add(time.Hour),
		IdleDisconnect: 20 * time.Minute, IdleDisconnectAt: time.Now().Add(20 * time.Minute),
		TransportGeneration: 1,
		BalanceMinor:        10_000, Feature: game.EmptyFeatureState(),
	}
	if err := repository.CreateSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	request := rgs.SpinRequest{
		OperatorID: session.OperatorID, SessionID: session.SessionID, RoundID: "round-risk",
		GameID: session.GameID, DefinitionVersion: session.DefinitionVersion,
		DefinitionHash: hash, Currency: session.Currency, RoundKind: rgs.RoundKindBase,
		BetMinor: 100, StartRevision: 0, TransportGeneration: 1,
	}
	outcome, err := (&integrationSpinner{}).Spin(ctx, game.SpinInput{BetMinor: request.BetMinor})
	if err != nil {
		t.Fatal(err)
	}
	result := rgs.SpinResult{
		ResultSchemaVersion: rgs.ResultSchemaPaidFactsV1,
		OperatorID:          request.OperatorID, SessionID: request.SessionID, RoundID: request.RoundID,
		GameID: request.GameID, DefinitionVersion: request.DefinitionVersion,
		DefinitionHash: request.DefinitionHash, Currency: request.Currency,
		RoundKind: request.RoundKind, ServerTransactionID: "rgs-op-v1:risk",
		StartRevision: 0, Sequence: 1, BetMinor: 100, ChargedBetMinor: 100,
		TotalWinMinor: outcome.TotalWinMinor, Grid: outcome.Grid, Wins: outcome.Wins,
		Events: outcome.Events, FeatureState: outcome.NextFeature,
	}
	profile := rgs.AtomicHTTPProfile(
		rgs.WalletRouteBindingIDForCanonicalTarget("https://wallet.test.invalid/ledger"),
	)
	record, prepared, err := repository.PrepareRound(
		ctx, request, rgs.FingerprintFor(request), profile,
		func(rgs.Session) (rgs.SpinResult, error) { return result, nil },
	)
	if err != nil || !prepared || record.Status != rgs.RoundRiskPending ||
		record.WalletPhase != "" || !record.NextAttemptAt.IsZero() {
		t.Fatalf("risk prepare = record:%+v prepared:%v error:%v", record, prepared, err)
	}
	if _, claimed, err := repository.ClaimWallet(ctx, request.Key(), time.Minute); err != nil || claimed {
		t.Fatalf("pre-approval wallet claim = claimed:%v error:%v", claimed, err)
	}
	var reviewStatus, roundStatus, walletPhase string
	var nextAttempt sql.NullTime
	if err := database.QueryRowContext(ctx, `
		SELECT review.status, round.status, round.wallet_phase, round.next_attempt_at
		FROM rgs_risk_reviews review
		JOIN rgs_rounds round USING (operator_id, session_id, round_id)
		WHERE review.operator_id=$1 AND review.session_id=$2 AND review.round_id=$3`,
		request.OperatorID, request.SessionID, request.RoundID,
	).Scan(&reviewStatus, &roundStatus, &walletPhase, &nextAttempt); err != nil {
		t.Fatal(err)
	}
	if reviewStatus != "PENDING" || roundStatus != "RISK_PENDING" || walletPhase != "" || nextAttempt.Valid {
		t.Fatalf("persisted risk gate = review:%s round:%s phase:%q next:%v",
			reviewStatus, roundStatus, walletPhase, nextAttempt)
	}
	command := rgs.RiskDecisionCommand{
		RoundKey: request.Key(), RequestID: "request-risk-a", IdempotencyKey: "decision-risk-a",
		CredentialKeyID: "operator-key-a", Decision: rgs.RiskDecisionApprove,
		ReasonCode: rgs.RiskReasonApproved,
	}
	decision, err := repository.DecideRisk(ctx, command)
	if err != nil || decision.Status != rgs.RoundPrepared || decision.Replayed {
		t.Fatalf("risk approval = %+v, error=%v", decision, err)
	}
	command.RequestID = "request-risk-b"
	replay, err := repository.DecideRisk(ctx, command)
	if err != nil || !replay.Replayed || replay.DecidedAt != decision.DecidedAt {
		t.Fatalf("risk approval replay = %+v, error=%v", replay, err)
	}
	if _, claimed, err := repository.ClaimWallet(ctx, request.Key(), time.Minute); err != nil || !claimed {
		t.Fatalf("approved wallet claim = claimed:%v error:%v", claimed, err)
	}
}

func TestPostgresFeatureRoundInputStateRecovery(t *testing.T) {
	databaseURLs := requirePostgresTestURLs(t)
	database, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	migrator, err := sql.Open("pgx", databaseURLs.migrator)
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := database.PingContext(ctx); err != nil {
		t.Fatal(err)
	}
	truncateIntegrationTables(t, migrator)
	defer truncateIntegrationTables(t, migrator)

	tests := []struct {
		name   string
		input  game.FeatureState
		next   game.FeatureState
		events []game.Event
	}{
		{
			name: "active-expansion",
			input: game.FeatureState{
				Mode: game.FeatureExpansion, Remaining: 2, Awarded: 8, BetMinor: 100,
				WinMinor: 250, RageLevel: 2, RageCollected: 4,
			},
			next: game.FeatureState{
				Mode: game.FeatureExpansion, Remaining: 1, Awarded: 8, BetMinor: 100,
				WinMinor: 250, RageLevel: 2, RageCollected: 4,
			},
			events: []game.Event{{Type: "grid.expanded", Rows: 3, Ways: 27}},
		},
		{
			name: "terminal-overdrive",
			input: game.FeatureState{
				Mode: game.FeatureOverdrive, Remaining: 1, Awarded: 8, BetMinor: 100,
				WinMinor: 250, RageLevel: 3, RageCollected: 7,
			},
			next: game.FeatureState{
				Mode: game.FeatureNone, RageLevel: 3, RageCollected: 7,
			},
			events: []game.Event{{
				Type: "free_spins.completed", Mode: game.FeatureOverdrive,
				Awarded: 8, CumulativeWinMinor: 250,
			}},
		},
	}

	repository, err := NewRepository(database)
	if err != nil {
		t.Fatal(err)
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			id := fmt.Sprintf("%d", index+1)
			hash := strings.Repeat("a", 64)
			session := rgs.Session{
				OperatorID: "operator-feature-" + id, SessionID: "session-feature-" + id,
				PlayerID: "player-" + id, WalletAccountID: "wallet-" + id,
				WalletSessionID: "wallet-session-feature-" + id,
				GameID:          "game-a", DefinitionVersion: "math-v1", DefinitionHash: hash,
				Currency: "USD", CurrencyExponent: 2, Jurisdiction: "MT",
				Status: rgs.SessionActive, ExpiresAt: time.Now().Add(time.Hour),
				IdleDisconnect: 20 * time.Minute, IdleDisconnectAt: time.Now().Add(20 * time.Minute),
				TransportGeneration: 1,
				BalanceMinor:        10_000, Feature: test.input,
			}
			if err := repository.CreateSession(ctx, session); err != nil {
				t.Fatal(err)
			}
			request := rgs.SpinRequest{
				OperatorID: session.OperatorID, SessionID: session.SessionID,
				RoundID: "round-feature-" + id, GameID: session.GameID,
				DefinitionVersion: session.DefinitionVersion, DefinitionHash: hash,
				Currency: session.Currency, RoundKind: rgs.RoundKindFreeSpin,
				BetMinor: test.input.BetMinor, StartRevision: session.Revision,
				TransportGeneration: 1,
			}
			result := recoverableFeatureResult(request, test.next, test.events)
			record, prepared, err := repository.PrepareRound(
				ctx, request, rgs.FingerprintFor(request),
				rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget("https://wallet.test.invalid/ledger")),
				func(locked rgs.Session) (rgs.SpinResult, error) {
					if locked.Feature != test.input {
						t.Fatalf("locked input feature = %+v, want %+v", locked.Feature, test.input)
					}
					return result, nil
				},
			)
			if err != nil || !prepared || record.Status != rgs.RoundPrepared {
				t.Fatalf("PrepareRound() = record:%+v prepared:%v error:%v", record, prepared, err)
			}

			var persisted []byte
			if err := database.QueryRowContext(ctx, `
				SELECT input_feature_state
				FROM rgs_rounds
				WHERE operator_id=$1 AND session_id=$2 AND round_id=$3`,
				request.OperatorID, request.SessionID, request.RoundID,
			).Scan(&persisted); err != nil {
				t.Fatal(err)
			}
			var restored game.FeatureState
			if err := json.Unmarshal(persisted, &restored); err != nil {
				t.Fatal(err)
			}
			if restored != test.input {
				t.Fatalf("persisted input feature = %+v, want %+v", restored, test.input)
			}

			claim, ownsWallet, err := repository.ClaimWallet(ctx, request.Key(), time.Minute)
			if err != nil || !ownsWallet || claim.Record.Status != rgs.RoundWalletPending {
				t.Fatalf("ClaimWallet() = claim:%+v owns:%v error:%v", claim, ownsWallet, err)
			}

			prepareCalled := false
			replayed, prepared, err := repository.PrepareRound(
				ctx, request, rgs.FingerprintFor(request),
				rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget("https://wallet.test.invalid/ledger")),
				func(rgs.Session) (rgs.SpinResult, error) {
					prepareCalled = true
					return rgs.SpinResult{}, errors.New("replay evaluated outcome")
				},
			)
			if err != nil || prepared || prepareCalled || replayed.Status != rgs.RoundWalletPending {
				t.Fatalf("replay = record:%+v prepared:%v called:%v error:%v",
					replayed, prepared, prepareCalled, err)
			}
		})
	}
}

func recoverableFeatureResult(
	request rgs.SpinRequest,
	next game.FeatureState,
	events []game.Event,
) rgs.SpinResult {
	return rgs.SpinResult{
		ResultSchemaVersion: rgs.ResultSchemaPaidFactsV1,
		OperatorID:          request.OperatorID, SessionID: request.SessionID, RoundID: request.RoundID,
		GameID: request.GameID, DefinitionVersion: request.DefinitionVersion,
		DefinitionHash: request.DefinitionHash, Currency: request.Currency,
		RoundKind: request.RoundKind, ServerTransactionID: "rgs-op-v1:" + request.RoundID,
		StartRevision: request.StartRevision, Sequence: 1, BetMinor: request.BetMinor,
		ChargedBetMinor: 0,
		Grid: game.Grid{
			{{Symbol: game.SymbolOrbit}, {Symbol: game.SymbolPrism}, {Symbol: game.SymbolPulse}},
			{{Symbol: game.SymbolNova}, {Symbol: game.SymbolCircuit}, {Symbol: game.SymbolTank}},
			{{Symbol: game.SymbolOrbit}, {Symbol: game.SymbolPrism}, {Symbol: game.SymbolPulse}},
		},
		Events: events, FeatureState: next,
	}
}

type integrationSpinner struct {
	calls atomic.Int64
}

func (s *integrationSpinner) Spin(context.Context, game.SpinInput) (game.SpinOutcome, error) {
	s.calls.Add(1)
	return game.SpinOutcome{
		Grid: game.Grid{
			{{Symbol: game.SymbolOrbit}, {Symbol: game.SymbolPrism}, {Symbol: game.SymbolPulse}},
			{{Symbol: game.SymbolOrbit}, {Symbol: game.SymbolCircuit}, {Symbol: game.SymbolTank}},
			{{Symbol: game.SymbolOrbit}, {Symbol: game.SymbolPrism}, {Symbol: game.SymbolPulse}},
		},
		Wins: []game.Win{{
			ID: "orbit-3", Symbol: game.SymbolOrbit, Ways: 1,
			AmountMinor: 50, PaidAmountMinor: 50,
			Cells: []game.Position{{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0}},
			PathAwards: []game.PathAward{{
				Cells:      []game.Position{{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0}},
				Multiplier: 1, BaseAmountMinor: 50,
				AmountMinor: 50, PaidAmountMinor: 50,
			}},
		}},
		TotalWinMinor: 50, NextFeature: game.EmptyFeatureState(),
	}, nil
}

type integrationWallet struct {
	mu         sync.Mutex
	balance    int64
	receipts   map[string]rgs.WalletReceipt
	applyCalls atomic.Int64
}

func (*integrationWallet) ProfileFor(string) (rgs.Profile, error) {
	return rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget("https://wallet.test.invalid/ledger")), nil
}

func (w *integrationWallet) SubmitRound(
	ctx context.Context,
	command rgs.WalletRound,
) rgs.Resolution {
	receipt, err := w.ApplyRound(ctx, command)
	if err != nil {
		return rgs.Resolution{Status: rgs.ResolutionUnknown, Cause: err}
	}
	return rgs.Resolution{Status: rgs.ResolutionSucceeded, Receipt: receipt}
}

func (w *integrationWallet) Resolve(
	ctx context.Context,
	reference rgs.OperationRef,
) rgs.Resolution {
	receipt, found, err := w.Lookup(ctx, reference.OperatorID, reference.OperationID)
	if err != nil {
		return rgs.Resolution{Status: rgs.ResolutionUnknown, Cause: err}
	}
	if !found {
		return rgs.Resolution{Status: rgs.ResolutionNotFound}
	}
	return rgs.Resolution{Status: rgs.ResolutionSucceeded, Receipt: receipt}
}

func (w *integrationWallet) ApplyRound(
	_ context.Context,
	command rgs.WalletRound,
) (rgs.WalletReceipt, error) {
	w.applyCalls.Add(1)
	w.mu.Lock()
	defer w.mu.Unlock()
	if receipt, exists := w.receipts[command.OperationID]; exists {
		return receipt, nil
	}
	w.balance = w.balance - command.DebitMinor + command.CreditMinor
	receipt := rgs.WalletReceipt{
		OperationID: command.OperationID, Fingerprint: command.Fingerprint,
		TransactionID: "wallet-tx-" + command.RoundID,
		OperatorID:    command.OperatorID, Currency: command.Currency,
		DebitMinor: command.DebitMinor, CreditMinor: command.CreditMinor,
		BalanceMinor: w.balance,
	}
	w.receipts[command.OperationID] = receipt
	return receipt, nil
}

func (w *integrationWallet) Lookup(
	_ context.Context,
	_ string,
	operationID string,
) (rgs.WalletReceipt, bool, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	receipt, exists := w.receipts[operationID]
	return receipt, exists, nil
}

func (*integrationWallet) Rollback(context.Context, rgs.WalletRollback) (rgs.WalletReceipt, error) {
	return rgs.WalletReceipt{}, errors.New("not implemented in integration stub")
}

func testPostgresCredentialConcurrency(t *testing.T, database *sql.DB) {
	t.Helper()
	store, err := NewLaunchStore(database)
	if err != nil {
		t.Fatal(err)
	}
	claims := launch.Claims{
		OperatorID: "operator-a", SessionID: "launch-session", PlayerID: "player-a",
		WalletSessionID: "wallet-launch", GameID: "game-a",
		DefinitionVersion: "math-v1", DefinitionHash: strings.Repeat("a", 64),
		RequestFingerprint: strings.Repeat("b", 64),
		Currency:           "EUR", CurrencyExponent: 2, Jurisdiction: "MT",
		IdleDisconnectSeconds: 1200,
	}
	testPostgresLaunchCreateAuthorityAfterConflictWait(t, database, store, claims)
	service, err := launch.NewService(store, launch.Options{TTL: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	issued, err := service.Issue(context.Background(), claims)
	if err != nil {
		t.Fatal(err)
	}
	var launchSuccess atomic.Int64
	var group sync.WaitGroup
	for range 32 {
		group.Add(1)
		go func() {
			defer group.Done()
			if _, err := service.Consume(context.Background(), issued.Code, launch.Binding{
				OperatorID: claims.OperatorID, SessionID: claims.SessionID,
			}); err == nil {
				launchSuccess.Add(1)
			} else if !errors.Is(err, launch.ErrCodeUnavailable) {
				t.Errorf("launch consume: %v", err)
			}
		}()
	}
	group.Wait()
	if launchSuccess.Load() != 1 {
		t.Fatalf("launch successes = %d", launchSuccess.Load())
	}

	nonces, err := NewNonceStore(database)
	if err != nil {
		t.Fatal(err)
	}
	nonce := "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB"
	scope := string(operator.KeyPurposeHTTPRequest) + "\x00operator-a\x00request-key"
	var nonceSuccess atomic.Int64
	for range 32 {
		group.Add(1)
		go func() {
			defer group.Done()
			consumed, err := nonces.Consume(
				context.Background(), scope, nonce, time.Now().Add(time.Minute),
			)
			if err != nil {
				t.Errorf("nonce consume: %v", err)
			}
			if consumed {
				nonceSuccess.Add(1)
			}
		}()
	}
	group.Wait()
	if nonceSuccess.Load() != 1 {
		t.Fatalf("nonce successes = %d", nonceSuccess.Load())
	}
}

func testPostgresLaunchCreateAuthorityAfterConflictWait(
	t *testing.T,
	database *sql.DB,
	store *LaunchStore,
	claims launch.Claims,
) {
	t.Helper()
	digest := launch.CodeDigest(sha256.Sum256([]byte("launch-authority-conflict-rollback")))
	request := launch.CreateRequest{
		Digest: digest,
		Claims: claims,
		TTL:    launch.MinimumTTL,
	}
	claimsJSON, err := json.Marshal(claimsDocumentFrom(claims))
	if err != nil {
		t.Fatal(err)
	}
	digestText := hex.EncodeToString(digest[:])

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	var (
		storedDigest     string
		storedOperatorID string
		storedClaimsJSON []byte
		createdAt        time.Time
		expiresAt        time.Time
	)
	if err := tx.QueryRowContext(
		ctx,
		launchCreateSQL,
		digestText,
		claims.OperatorID,
		claimsJSON,
		request.TTL.Microseconds(),
	).Scan(
		&storedDigest,
		&storedOperatorID,
		&storedClaimsJSON,
		&createdAt,
		&expiresAt,
	); err != nil {
		t.Fatalf("hold first launch create transaction: %v", err)
	}

	type createResult struct {
		record launch.Record
		err    error
	}
	resultCh := make(chan createResult, 1)
	go func() {
		record, createErr := store.Create(ctx, request)
		resultCh <- createResult{record: record, err: createErr}
	}()

	for {
		var waiting int
		if err := database.QueryRowContext(ctx, `
			SELECT count(*)
			FROM pg_locks
			WHERE locktype = 'advisory'
				AND NOT granted
				AND database = (
					SELECT oid FROM pg_database WHERE datname = current_database()
				)`).Scan(&waiting); err != nil {
			t.Fatalf("observe launch advisory lock waiter: %v", err)
		}
		if waiting > 0 {
			break
		}
		select {
		case result := <-resultCh:
			t.Fatalf(
				"competing launch create completed before authority lock release: record=%+v error=%v",
				result.record,
				result.err,
			)
		case <-time.After(10 * time.Millisecond):
		case <-ctx.Done():
			t.Fatalf("wait for launch advisory lock contention: %v", ctx.Err())
		}
	}

	// 第二个 Create 已在摘要锁上等待；此时再观测数据库时钟，能证明它最终返回的
	// CreatedAt 是等待之后而不是等待之前取得的值。
	var beforeRollback time.Time
	if err := database.QueryRowContext(ctx, `SELECT clock_timestamp()`).Scan(&beforeRollback); err != nil {
		t.Fatalf("observe database time before rollback: %v", err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatalf("rollback competing launch create: %v", err)
	}

	var result createResult
	select {
	case result = <-resultCh:
	case <-ctx.Done():
		t.Fatalf("competing launch create did not resume: %v", ctx.Err())
	}
	if result.err != nil {
		t.Fatalf("competing launch create after rollback: %v", result.err)
	}
	if result.record.CreatedAt.Before(beforeRollback.UTC()) {
		t.Fatalf(
			"createdAt %s predates pre-rollback database time %s",
			result.record.CreatedAt,
			beforeRollback.UTC(),
		)
	}
	if result.record.ExpiresAt.Sub(result.record.CreatedAt) != request.TTL {
		t.Fatalf(
			"created launch TTL = %s, want %s",
			result.record.ExpiresAt.Sub(result.record.CreatedAt),
			request.TTL,
		)
	}
}

func testRuntimePrivilegeBoundary(t *testing.T, database *sql.DB) {
	t.Helper()
	tests := []struct {
		name      string
		statement string
	}{
		{name: "create", statement: `CREATE TABLE public.rgs_forbidden (id bigint)`},
		{name: "create temporary", statement: `CREATE TEMPORARY TABLE rgs_forbidden_temp (id bigint)`},
		{name: "alter", statement: `ALTER TABLE public.rgs_sessions ADD COLUMN forbidden text`},
		{name: "drop", statement: `DROP TABLE public.rgs_sessions`},
		{name: "truncate", statement: `TRUNCATE TABLE public.rgs_sessions`},
		{name: "migration ledger write", statement: `INSERT INTO public.rgs_schema_migrations (version, checksum) VALUES ('forbidden', repeat('0', 64))`},
		{name: "migration ledger update", statement: `UPDATE public.rgs_schema_migrations SET checksum=repeat('0', 64)`},
		{name: "session delete", statement: `DELETE FROM public.rgs_sessions`},
		{name: "round delete", statement: `DELETE FROM public.rgs_rounds`},
		{name: "risk review delete", statement: `DELETE FROM public.rgs_risk_reviews`},
		{name: "wallet delete", statement: `DELETE FROM public.rgs_wallet_transactions`},
		{name: "outbox delete", statement: `DELETE FROM public.rgs_outbox`},
	}
	for _, test := range tests {
		t.Run("runtime denies "+test.name, func(t *testing.T) {
			tx, err := database.BeginTx(context.Background(), nil)
			if err != nil {
				t.Fatal(err)
			}
			_, executionErr := tx.ExecContext(context.Background(), test.statement)
			_ = tx.Rollback()
			if executionErr == nil {
				t.Fatalf("runtime unexpectedly executed %s", test.name)
			}
			if got := sqlState(executionErr); got != "42501" {
				t.Fatalf("runtime %s SQLSTATE = %q, want 42501", test.name, got)
			}
		})
	}
}

func truncateIntegrationTables(t *testing.T, database *sql.DB) {
	t.Helper()
	_, err := database.Exec(`
		TRUNCATE TABLE
			rgs_operator_nonces, rgs_launch_codes, rgs_outbox,
			rgs_risk_reviews, rgs_wallet_transactions, rgs_rounds, rgs_sessions,
			rgs_wallet_recovery_operators
		RESTART IDENTITY CASCADE`)
	if err != nil {
		t.Fatalf("truncate integration tables: %v", err)
	}
}
