package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	_ "github.com/jackc/pgx/v5/stdlib"

	"slots-game/server/internal/game"
	"slots-game/server/internal/rgs"
)

var sessionRowColumns = []string{
	"operator_id", "session_id", "player_id", "wallet_account_id",
	"wallet_session_id", "game_id", "definition_version", "definition_hash",
	"currency", "currency_exponent", "jurisdiction", "status",
	"balance_snapshot_minor", "sequence", "revision", "feature_state",
	"pending_round_id", "expires_at", "idle_disconnect_seconds",
	"idle_disconnect_at", "transport_generation", "integrity_quarantined_at",
}

type sessionRowFixture struct {
	operatorID     string
	sessionID      string
	status         string
	balanceMinor   int64
	sequence       int64
	revision       int64
	featureJSON    []byte
	pendingRoundID any
	quarantinedAt  any
	definitionHash string
}

func TestGetSessionRestoresCompleteFeatureProjection(t *testing.T) {
	db, mock := newRepositoryMock(t)
	repository, err := NewRepository(db)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newSessionRowFixture(t)
	want := game.FeatureState{
		Mode: game.FeatureExpansion, Remaining: 6, Awarded: 11, BetMinor: 500,
		WinMinor: 12_345, RageLevel: 3, RageCollected: 7,
	}
	fixture.featureJSON, err = json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	expectGetSessionRow(mock, fixture)
	session, err := repository.GetSession(context.Background(), fixture.operatorID, fixture.sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if session.Feature != want {
		t.Fatalf("restored feature = %+v, want %+v", session.Feature, want)
	}
	assertRepositoryExpectations(t, mock)
}

func TestGetSessionQuarantinesStrictFeatureFailureExactlyOnce(t *testing.T) {
	db, mock := newRepositoryMock(t)
	observer := &countingIntegrityObserver{}
	repository, err := NewRepository(db, observer)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newSessionRowFixture(t)
	fixture.featureJSON = []byte(`{"Mode":"NONE","Remaining":0,"Awarded":0,"BetMinor":0,"unapproved":true}`)
	fixture.pendingRoundID = "round-pending"

	expectGetSessionRow(mock, fixture)
	expectSessionQuarantine(mock, fixture, false)
	if _, err := repository.GetSession(context.Background(), fixture.operatorID, fixture.sessionID); !errors.Is(err, rgs.ErrSessionIntegrity) {
		t.Fatalf("first GetSession() error = %v, want ErrSessionIntegrity", err)
	}

	// 即使畸形文档随后被修复，隔离标记仍具有权威性；必须由人工流程明确解除隔离。
	fixture.status = string(rgs.SessionBlocked)
	fixture.featureJSON, _ = json.Marshal(game.EmptyFeatureState())
	fixture.quarantinedAt = time.Now().UTC()
	expectGetSessionRow(mock, fixture)
	expectSessionQuarantine(mock, fixture, true)
	if _, err := repository.GetSession(context.Background(), fixture.operatorID, fixture.sessionID); !errors.Is(err, rgs.ErrSessionIntegrity) {
		t.Fatalf("repeated GetSession() error = %v, want ErrSessionIntegrity", err)
	}
	if observer.sessionCalls != 1 || observer.calls != 0 {
		t.Fatalf("integrity observations = session:%d round:%d", observer.sessionCalls, observer.calls)
	}
	assertRepositoryExpectations(t, mock)
}

func TestSpinQuarantinesInvalidSessionBeforeEngineOrWallet(t *testing.T) {
	db, mock := newRepositoryMock(t)
	observer := &countingIntegrityObserver{}
	repository, err := NewRepository(db, observer)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newSessionRowFixture(t)
	fixture.featureJSON = []byte(`{"Mode":"EXPANSION","Remaining":0,"Awarded":8,"BetMinor":100}`)
	fixture.pendingRoundID = "round-existing"

	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(prepareSessionLockSQL)).
		WithArgs(fixture.operatorID, fixture.sessionID).
		WillReturnRows(fixture.prepareRows())
	expectSessionQuarantineLocked(mock, fixture, false)

	spinner := &sessionIntegritySpinner{}
	wallet := &sessionIntegrityWallet{}
	registry, err := rgs.NewMemoryDefinitionRegistry(rgs.DefinitionEntry{
		GameID: "game-a", Version: "math-v1", SHA256: fixture.definitionHash,
		Spinner: spinner,
	})
	if err != nil {
		t.Fatal(err)
	}
	coordinator, err := rgs.NewCoordinator(rgs.CoordinatorConfig{}, repository, wallet, registry)
	if err != nil {
		t.Fatal(err)
	}
	_, err = coordinator.Spin(context.Background(), rgs.SpinRequest{
		OperatorID: fixture.operatorID, SessionID: fixture.sessionID,
		RoundID: "round-existing", GameID: "game-a", DefinitionVersion: "math-v1",
		DefinitionHash: fixture.definitionHash, Currency: "USD",
		RoundKind: rgs.RoundKindBase, BetMinor: 100, StartRevision: 0,
		TransportGeneration: 1,
	})
	if !errors.Is(err, rgs.ErrSessionIntegrity) {
		t.Fatalf("Spin() error = %v, want ErrSessionIntegrity", err)
	}
	if spinner.calls.Load() != 0 || wallet.calls.Load() != 0 {
		t.Fatalf("corrupt session reached side effects: engine=%d wallet=%d",
			spinner.calls.Load(), wallet.calls.Load())
	}
	if observer.sessionCalls != 1 || observer.calls != 0 {
		t.Fatalf("integrity observations = session:%d round:%d", observer.sessionCalls, observer.calls)
	}
	assertRepositoryExpectations(t, mock)
}

func TestPostgresConcurrentSessionIntegrityQuarantinePreservesEconomicEvidence(t *testing.T) {
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

	observer := &atomicSessionIntegrityObserver{}
	repositoryA, _ := NewRepository(database, observer)
	repositoryB, _ := NewRepository(database, observer)
	hash := strings.Repeat("a", 64)
	session := rgs.Session{
		OperatorID: "operator-session-integrity", SessionID: "session-integrity",
		PlayerID: "player-a", WalletAccountID: "wallet-a", WalletSessionID: "wallet-session-integrity",
		GameID: "game-a", DefinitionVersion: "math-v1", DefinitionHash: hash,
		Currency: "USD", CurrencyExponent: 2, Jurisdiction: "MT",
		Status: rgs.SessionActive, ExpiresAt: time.Now().Add(time.Hour),
		IdleDisconnect: 20 * time.Minute, IdleDisconnectAt: time.Now().Add(20 * time.Minute),
		TransportGeneration: 1,
		BalanceMinor:        10_000, Feature: game.EmptyFeatureState(),
	}
	if err := repositoryA.CreateSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	request := rgs.SpinRequest{
		OperatorID: session.OperatorID, SessionID: session.SessionID,
		RoundID: "round-pending", GameID: session.GameID,
		DefinitionVersion: session.DefinitionVersion, DefinitionHash: hash,
		Currency: session.Currency, RoundKind: rgs.RoundKindBase,
		BetMinor: 100, StartRevision: 0, TransportGeneration: 1,
	}
	_, prepared, err := repositoryA.PrepareRound(
		ctx, request, rgs.FingerprintFor(request),
		rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget("https://wallet.test.invalid/ledger")),
		func(locked rgs.Session) (rgs.SpinResult, error) {
			return validPreparedSessionIntegrityResult(request, locked.Sequence+1), nil
		},
	)
	if err != nil || !prepared {
		t.Fatalf("PrepareRound() = prepared:%v error:%v", prepared, err)
	}
	if _, err := database.ExecContext(ctx, `
		UPDATE rgs_sessions
		SET feature_state='{"Mode":"EXPANSION","Remaining":0,"Awarded":8,"BetMinor":100}'::jsonb
		WHERE operator_id=$1 AND session_id=$2`, session.OperatorID, session.SessionID); err != nil {
		t.Fatal(err)
	}

	spinner := &sessionIntegritySpinner{}
	wallet := &sessionIntegrityWallet{}
	registry, _ := rgs.NewMemoryDefinitionRegistry(rgs.DefinitionEntry{
		GameID: session.GameID, Version: session.DefinitionVersion, SHA256: hash, Spinner: spinner,
	})
	coordinatorA, _ := rgs.NewCoordinator(rgs.CoordinatorConfig{}, repositoryA, wallet, registry)
	coordinatorB, _ := rgs.NewCoordinator(rgs.CoordinatorConfig{}, repositoryB, wallet, registry)

	const callers = 32
	errorsByCaller := make([]error, callers)
	var group sync.WaitGroup
	group.Add(callers)
	for index := range callers {
		go func() {
			defer group.Done()
			if index%3 == 0 {
				_, errorsByCaller[index] = repositoryA.GetSession(
					context.Background(), session.OperatorID, session.SessionID,
				)
				return
			}
			coordinator := coordinatorA
			if index%2 == 1 {
				coordinator = coordinatorB
			}
			_, errorsByCaller[index] = coordinator.Spin(context.Background(), request)
		}()
	}
	group.Wait()
	for index, err := range errorsByCaller {
		if !errors.Is(err, rgs.ErrSessionIntegrity) {
			t.Fatalf("caller %d error = %v, want ErrSessionIntegrity", index, err)
		}
	}
	if spinner.calls.Load() != 0 || wallet.calls.Load() != 0 {
		t.Fatalf("corrupt session reached side effects: engine=%d wallet=%d",
			spinner.calls.Load(), wallet.calls.Load())
	}

	var status, pendingRoundID, featureJSON string
	var balanceMinor, sequence, revision int64
	var quarantined bool
	if err := database.QueryRowContext(ctx, `
		SELECT status, balance_snapshot_minor, sequence, revision,
		       feature_state::text, pending_round_id,
		       integrity_quarantined_at IS NOT NULL
		FROM rgs_sessions
		WHERE operator_id=$1 AND session_id=$2`, session.OperatorID, session.SessionID).
		Scan(&status, &balanceMinor, &sequence, &revision, &featureJSON, &pendingRoundID, &quarantined); err != nil {
		t.Fatal(err)
	}
	if status != string(rgs.SessionBlocked) || !quarantined || balanceMinor != 10_000 ||
		sequence != 0 || revision != 0 || pendingRoundID != request.RoundID ||
		!strings.Contains(featureJSON, "EXPANSION") {
		t.Fatalf("quarantined session evidence changed: status=%s balance=%d sequence=%d revision=%d feature=%s pending=%s marker=%v",
			status, balanceMinor, sequence, revision, featureJSON, pendingRoundID, quarantined)
	}
	var roundStatus, walletStatus string
	if err := database.QueryRowContext(ctx, `
		SELECT r.status, w.status
		FROM rgs_rounds r
		JOIN rgs_wallet_transactions w
		  ON w.operator_id=r.operator_id AND w.session_id=r.session_id AND w.round_id=r.round_id
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3`,
		session.OperatorID, session.SessionID, request.RoundID,
	).Scan(&roundStatus, &walletStatus); err != nil {
		t.Fatal(err)
	}
	if roundStatus != string(rgs.RoundPrepared) || walletStatus != "PENDING" {
		t.Fatalf("economic evidence was rewritten: round=%s wallet=%s", roundStatus, walletStatus)
	}
	var events int
	if err := database.QueryRowContext(ctx, `
		SELECT count(*) FROM rgs_outbox
		WHERE operator_id=$1 AND aggregate_type='session' AND aggregate_id=$2
		  AND event_type='SESSION_INTEGRITY_FAILED'`, session.OperatorID, session.SessionID).
		Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 1 || observer.sessionCalls.Load() != 1 || observer.roundCalls.Load() != 0 {
		t.Fatalf("quarantine signals = events:%d session-metric:%d round-metric:%d",
			events, observer.sessionCalls.Load(), observer.roundCalls.Load())
	}
}

func newSessionRowFixture(t *testing.T) sessionRowFixture {
	t.Helper()
	featureJSON, err := json.Marshal(game.EmptyFeatureState())
	if err != nil {
		t.Fatal(err)
	}
	return sessionRowFixture{
		operatorID: "operator-a", sessionID: "session-a", status: string(rgs.SessionActive),
		balanceMinor: 10_000, featureJSON: featureJSON,
		definitionHash: strings.Repeat("a", 64),
	}
}

func (fixture sessionRowFixture) rows() *sqlmock.Rows {
	return sqlmock.NewRows(sessionRowColumns).AddRow(
		fixture.operatorID, fixture.sessionID, "player-a", "wallet-account-a",
		"wallet-session-a", "game-a", "math-v1", fixture.definitionHash,
		"USD", 2, "MT", fixture.status, fixture.balanceMinor,
		fixture.sequence, fixture.revision, fixture.featureJSON,
		fixture.pendingRoundID, time.Now().Add(time.Hour), int64(1200),
		time.Now().Add(20*time.Minute), int64(1), fixture.quarantinedAt,
	)
}

func (fixture sessionRowFixture) prepareRows() *sqlmock.Rows {
	return sqlmock.NewRows(sessionRowColumns).AddRow(
		fixture.operatorID, fixture.sessionID, "player-a", "wallet-account-a",
		"wallet-session-a", "game-a", "math-v1", fixture.definitionHash,
		"USD", 2, "MT", fixture.status, fixture.balanceMinor,
		fixture.sequence, fixture.revision, fixture.featureJSON,
		fixture.pendingRoundID, time.Now().Add(time.Hour), int64(1200),
		time.Now().Add(20*time.Minute), int64(1), fixture.quarantinedAt,
	)
}

func expectGetSessionRow(mock sqlmock.Sqlmock, fixture sessionRowFixture) {
	mock.ExpectQuery(regexp.QuoteMeta(sessionSelect+` WHERE operator_id=$1 AND session_id=$2`)).
		WithArgs(fixture.operatorID, fixture.sessionID).
		WillReturnRows(fixture.rows())
}

func expectSessionQuarantine(mock sqlmock.Sqlmock, fixture sessionRowFixture, already bool) {
	mock.ExpectBegin()
	expectSessionQuarantineLocked(mock, fixture, already)
}

func expectSessionQuarantineLocked(mock sqlmock.Sqlmock, fixture sessionRowFixture, already bool) {
	mock.ExpectQuery(regexp.QuoteMeta(`
		SELECT status, pending_round_id, integrity_quarantined_at IS NOT NULL
		FROM rgs_sessions
		WHERE operator_id=$1 AND session_id=$2
		FOR UPDATE`)).
		WithArgs(fixture.operatorID, fixture.sessionID).
		WillReturnRows(sqlmock.NewRows([]string{"status", "pending_round_id", "already_quarantined"}).
			AddRow(fixture.status, fixture.pendingRoundID, already))
	if already {
		mock.ExpectCommit()
		return
	}
	mock.ExpectExec(regexp.QuoteMeta(`
		UPDATE rgs_sessions
		SET status='BLOCKED', integrity_quarantined_at=$3, updated_at=$3
		WHERE operator_id=$1 AND session_id=$2
		  AND integrity_quarantined_at IS NULL`)).
		WithArgs(fixture.operatorID, fixture.sessionID, sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`
		INSERT INTO rgs_outbox (
			operator_id, aggregate_type, aggregate_id, event_type, payload
		) VALUES ($1,$2,$3,$4,$5)`)).
		WithArgs(fixture.operatorID, "session", fixture.sessionID, "SESSION_INTEGRITY_FAILED", sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()
}

func validPreparedSessionIntegrityResult(request rgs.SpinRequest, sequence uint64) rgs.SpinResult {
	return rgs.SpinResult{
		OperatorID: request.OperatorID, SessionID: request.SessionID, RoundID: request.RoundID,
		GameID: request.GameID, DefinitionVersion: request.DefinitionVersion,
		DefinitionHash: request.DefinitionHash, Currency: request.Currency,
		RoundKind: request.RoundKind, ServerTransactionID: "rgs-op-v1:session-integrity",
		StartRevision: request.StartRevision, Sequence: sequence,
		BetMinor: request.BetMinor, ChargedBetMinor: request.BetMinor,
		Grid: game.Grid{
			{{Symbol: game.SymbolOrbit}, {Symbol: game.SymbolPrism}, {Symbol: game.SymbolPulse}},
			{{Symbol: game.SymbolNova}, {Symbol: game.SymbolCircuit}, {Symbol: game.SymbolTank}},
			{{Symbol: game.SymbolOrbit}, {Symbol: game.SymbolPrism}, {Symbol: game.SymbolPulse}},
		},
		FeatureState: game.EmptyFeatureState(),
	}
}

type sessionIntegritySpinner struct {
	calls atomic.Int64
}

func (spinner *sessionIntegritySpinner) Spin(context.Context, game.SpinInput) (game.SpinOutcome, error) {
	spinner.calls.Add(1)
	return game.SpinOutcome{}, errors.New("session integrity test: engine must not be called")
}

type sessionIntegrityWallet struct {
	calls atomic.Int64
}

func (wallet *sessionIntegrityWallet) ProfileFor(string) (rgs.Profile, error) {
	// 档案解析是无网络、无经济副作用的本地路由读取；Spin 必须先取得它，才能把
	// 恢复契约与准备记录原子绑定。损坏会话仍不得到达 Submit/Resolve/旧钱包调用。
	return rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
		"https://wallet.test.invalid/session-integrity",
	)), nil
}

func (wallet *sessionIntegrityWallet) SubmitRound(context.Context, rgs.WalletRound) rgs.Resolution {
	wallet.calls.Add(1)
	return rgs.Resolution{
		Status: rgs.ResolutionUnknown,
		Cause:  errors.New("session integrity test: wallet must not be called"),
	}
}

func (wallet *sessionIntegrityWallet) Resolve(context.Context, rgs.OperationRef) rgs.Resolution {
	wallet.calls.Add(1)
	return rgs.Resolution{
		Status: rgs.ResolutionUnknown,
		Cause:  errors.New("session integrity test: wallet must not be called"),
	}
}

func (wallet *sessionIntegrityWallet) ApplyRound(context.Context, rgs.WalletRound) (rgs.WalletReceipt, error) {
	wallet.calls.Add(1)
	return rgs.WalletReceipt{}, errors.New("session integrity test: wallet must not be called")
}

func (wallet *sessionIntegrityWallet) Lookup(context.Context, string, string) (rgs.WalletReceipt, bool, error) {
	wallet.calls.Add(1)
	return rgs.WalletReceipt{}, false, errors.New("session integrity test: wallet must not be called")
}

func (wallet *sessionIntegrityWallet) Rollback(context.Context, rgs.WalletRollback) (rgs.WalletReceipt, error) {
	wallet.calls.Add(1)
	return rgs.WalletReceipt{}, errors.New("session integrity test: wallet must not be called")
}

type atomicSessionIntegrityObserver struct {
	roundCalls   atomic.Int64
	sessionCalls atomic.Int64
}

func (observer *atomicSessionIntegrityObserver) RoundIntegrityQuarantined() {
	observer.roundCalls.Add(1)
}

func (observer *atomicSessionIntegrityObserver) SessionIntegrityQuarantined() {
	observer.sessionCalls.Add(1)
}
