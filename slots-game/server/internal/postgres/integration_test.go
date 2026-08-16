package postgres

import (
	"context"
	"database/sql"
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
		BalanceMinor: 10_000, Feature: game.EmptyFeatureState(),
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
	coordinatorA, _ := rgs.NewCoordinator(rgs.CoordinatorConfig{}, repositoryA, wallet, registry)
	coordinatorB, _ := rgs.NewCoordinator(rgs.CoordinatorConfig{}, repositoryB, wallet, registry)
	request := rgs.SpinRequest{
		OperatorID: session.OperatorID, SessionID: session.SessionID,
		RoundID: "round-a", GameID: session.GameID,
		DefinitionVersion: session.DefinitionVersion, DefinitionHash: hash,
		Currency: session.Currency, RoundKind: rgs.RoundKindBase,
		BetMinor: 100, StartRevision: 0,
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
		BetMinor: 100, StartRevision: 1,
	}); !errors.Is(err, rgs.ErrResultDeliveryPending) {
		t.Fatalf("next spin before ACK error = %v", err)
	}
	receipt := rgs.ResultDeliveryAcknowledgement{
		OperatorID: delivery.OperatorID, SessionID: delivery.SessionID,
		RoundID: delivery.RoundID, Sequence: delivery.Sequence, ResultHash: delivery.ResultHash,
	}
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
				BalanceMinor: 10_000, Feature: test.input,
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
			}
			result := recoverableFeatureResult(request, test.next, test.events)
			record, prepared, err := repository.PrepareRound(
				ctx, request, rgs.FingerprintFor(request),
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

			now := time.Now().UTC()
			claimed, ownsWallet, err := repository.ClaimWallet(ctx, request.Key(), now, now.Add(time.Minute))
			if err != nil || !ownsWallet || claimed.Status != rgs.RoundWalletPending {
				t.Fatalf("ClaimWallet() = record:%+v owns:%v error:%v", claimed, ownsWallet, err)
			}

			prepareCalled := false
			replayed, prepared, err := repository.PrepareRound(
				ctx, request, rgs.FingerprintFor(request), func(rgs.Session) (rgs.SpinResult, error) {
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
		OperatorID: request.OperatorID, SessionID: request.SessionID, RoundID: request.RoundID,
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
			ID: "orbit-3", Symbol: game.SymbolOrbit, Ways: 1, AmountMinor: 50,
			Cells: []game.Position{{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0}},
			PathAwards: []game.PathAward{{
				Cells:      []game.Position{{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0}},
				Multiplier: 1, BaseAmountMinor: 50, AmountMinor: 50,
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
	service, err := launch.NewService(store, launch.Options{TTL: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	claims := launch.Claims{
		OperatorID: "operator-a", SessionID: "launch-session", PlayerID: "player-a",
		WalletSessionID: "wallet-launch", GameID: "game-a",
		DefinitionVersion: "math-v1", DefinitionHash: strings.Repeat("a", 64),
		RequestFingerprint: strings.Repeat("b", 64),
		Currency:           "EUR", CurrencyExponent: 2, Jurisdiction: "MT",
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
			rgs_wallet_transactions, rgs_rounds, rgs_sessions
		RESTART IDENTITY CASCADE`)
	if err != nil {
		t.Fatalf("truncate integration tables: %v", err)
	}
}
