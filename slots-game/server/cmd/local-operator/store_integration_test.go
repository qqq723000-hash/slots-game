package main

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPostgresWalletStorePersistsConcurrentIdempotency(t *testing.T) {
	databaseURL := os.Getenv("LOCAL_OPERATOR_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("LOCAL_OPERATOR_TEST_DATABASE_URL is not configured")
	}
	database, err := openDatabase(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	runtimeRole := valueOrDefault(os.Getenv("LOCAL_OPERATOR_TEST_RUNTIME_ROLE"), "localop")
	ownerRole := valueOrDefault(os.Getenv("LOCAL_OPERATOR_TEST_OWNER_ROLE"), "localop")
	if err := migrateLocalOperator(ctx, database, ownerRole, runtimeRole); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `
		TRUNCATE local_operator_wallet_rollbacks, local_operator_wallet_operations,
			local_operator_wallet_rejections,
			local_operator_wallet_sessions, local_operator_nonces, local_operator_accounts`); err != nil {
		t.Fatal(err)
	}
	walletDatabase := database
	if runtimeURL := os.Getenv("LOCAL_OPERATOR_TEST_WALLET_DATABASE_URL"); runtimeURL != "" {
		walletDatabase, err = openDatabase(runtimeURL)
		if err != nil {
			t.Fatal(err)
		}
		defer walletDatabase.Close()
	}
	store, err := newPostgresStore(walletDatabase)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Ping(ctx); err != nil {
		t.Fatalf("wallet schema readiness: %v", err)
	}
	if err := store.EnsureAccount(ctx, accountSeed{
		OperatorID: "local-operator", WalletAccountID: "wallet-1",
		Currency: "CNY", BalanceMinor: 10_000,
	}); err != nil {
		t.Fatal(err)
	}
	request, err := validateRound(bindWalletV2(t, roundRequest{
		OperationID: "operation-1",
		Fingerprint: "rgs-fp-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		OperatorID:  "local-operator", PlayerID: "player-1", WalletAccountID: "wallet-1",
		WalletSessionRef: "wallet-session-1", SessionID: "session-1",
		RoundID: "round-1", GameID: "iron-colossus",
		DefinitionVersion: "math-v1",
		DefinitionHash:    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RoundKind:         "BASE", Currency: "CNY", DebitMinor: "100", CreditMinor: "50",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RegisterWalletSession(ctx, walletSessionSeed{
		OperatorID: request.OperatorID, WalletSessionRef: request.WalletSessionRef,
		PlayerID: request.PlayerID, WalletAccountID: request.WalletAccountID,
		SessionID: request.SessionID, GameID: request.GameID,
		DefinitionVersion: request.DefinitionVersion, DefinitionHash: request.DefinitionHash,
		Currency: request.Currency, ExpiresAt: time.Now().UTC().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	results := make(chan storedOperation, 16)
	errorsChannel := make(chan error, 16)
	for range 16 {
		group.Add(1)
		go func() {
			defer group.Done()
			operation, applyErr := store.Apply(context.Background(), request)
			results <- operation
			errorsChannel <- applyErr
		}()
	}
	group.Wait()
	close(results)
	close(errorsChannel)
	for applyErr := range errorsChannel {
		if applyErr != nil {
			t.Fatalf("concurrent apply: %v", applyErr)
		}
	}
	for operation := range results {
		if operation.BalanceMinor != 9_950 {
			t.Fatalf("operation balance = %d", operation.BalanceMinor)
		}
	}
	conflict := request
	conflict.RequestDigest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if _, err := store.Apply(ctx, conflict); !errors.Is(err, errIdempotencyConflict) {
		t.Fatalf("changed operation error = %v", err)
	}
	unknownSessionRequest, err := validateRound(bindWalletV2(t, roundRequest{
		OperationID: "operation-unknown-session",
		Fingerprint: "rgs-fp-v2:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		OperatorID:  "local-operator", PlayerID: "player-1", WalletAccountID: "wallet-1",
		WalletSessionRef: "wallet-session-unknown", SessionID: "session-1",
		RoundID: "round-unknown-session", GameID: "iron-colossus",
		DefinitionVersion: "math-v1",
		DefinitionHash:    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RoundKind:         "BASE", Currency: "CNY", DebitMinor: "100", CreditMinor: "50",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(ctx, unknownSessionRequest); !errors.Is(err, errWalletSessionInvalid) {
		t.Fatalf("unknown wallet session error = %v", err)
	}
	if err := store.EnsureAccount(ctx, accountSeed{
		OperatorID: "local-operator", WalletAccountID: "wallet-reject",
		Currency: "CNY", BalanceMinor: 0,
	}); err != nil {
		t.Fatal(err)
	}
	rejectedRequest, err := validateRound(bindWalletV2(t, roundRequest{
		OperationID: "operation-insufficient",
		Fingerprint: "rgs-fp-v2:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
		OperatorID:  "local-operator", PlayerID: "player-reject",
		WalletAccountID: "wallet-reject", WalletSessionRef: "wallet-session-reject",
		SessionID: "session-reject", RoundID: "round-reject", GameID: "iron-colossus",
		DefinitionVersion: "math-v1",
		DefinitionHash:    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RoundKind:         "BASE", Currency: "CNY", DebitMinor: "100", CreditMinor: "100",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RegisterWalletSession(ctx, walletSessionSeed{
		OperatorID: rejectedRequest.OperatorID, WalletSessionRef: rejectedRequest.WalletSessionRef,
		PlayerID: rejectedRequest.PlayerID, WalletAccountID: rejectedRequest.WalletAccountID,
		SessionID: rejectedRequest.SessionID, GameID: rejectedRequest.GameID,
		DefinitionVersion: rejectedRequest.DefinitionVersion,
		DefinitionHash:    rejectedRequest.DefinitionHash, Currency: rejectedRequest.Currency,
		ExpiresAt: time.Now().UTC().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(ctx, rejectedRequest); !errors.Is(err, errInsufficientFunds) {
		t.Fatalf("initial insufficient funds error = %v", err)
	}
	storedRejection, found, err := store.LookupRejection(
		ctx, rejectedRequest.OperatorID, rejectedRequest.OperationID,
	)
	if err != nil || !found || storedRejection.Code != walletRejectionInsufficientFunds ||
		storedRejection.RequestDigest != rejectedRequest.RequestDigest {
		t.Fatalf("stored terminal rejection = %+v, found=%t, err=%v", storedRejection, found, err)
	}
	assertWalletV2HalfBoundRowsRejected(t, ctx, walletDatabase, request, rejectedRequest)
	if _, err := database.ExecContext(ctx, `
		UPDATE local_operator_accounts SET balance_minor=1000
		WHERE operator_id='local-operator' AND wallet_account_id='wallet-reject' AND currency='CNY'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(ctx, rejectedRequest); !errors.Is(err, errInsufficientFunds) {
		t.Fatalf("replayed terminal rejection after balance change = %v", err)
	}
	if _, found, err := store.Lookup(
		ctx, rejectedRequest.OperatorID, rejectedRequest.OperationID,
	); err != nil || found {
		t.Fatalf("rejected operation became successful: found=%t err=%v", found, err)
	}
	rollback, err := validateRollback(rollbackRequest{
		OperatorID: "local-operator", OperationID: "operation-1",
		RollbackID: "rollback-1", Reason: "operator reconciliation",
	})
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	group.Add(2)
	go func() {
		defer group.Done()
		<-start
		operation, rollbackErr := store.Rollback(context.Background(), rollback)
		if rollbackErr != nil || operation.BalanceMinor != 10_000 {
			t.Errorf("rollback = %+v, %v", operation, rollbackErr)
		}
	}()
	go func() {
		defer group.Done()
		<-start
		_, applyErr := store.Apply(context.Background(), request)
		// Apply 先取得共享决策锁时是精确重放；rollback 先取得时，已回滚操作必须冲突。
		if applyErr != nil && !errors.Is(applyErr, errIdempotencyConflict) {
			t.Errorf("apply/rollback interleave error = %v", applyErr)
		}
	}()
	close(start)
	group.Wait()
	if replay, replayErr := store.Rollback(context.Background(), rollback); replayErr != nil ||
		replay.BalanceMinor != 10_000 || replay.CommandDigest != request.CommandDigest {
		t.Fatalf("rollback replay = %+v, %v", replay, replayErr)
	}
	var balance int64
	if err := database.QueryRowContext(ctx, `
		SELECT balance_minor FROM local_operator_accounts
		WHERE operator_id='local-operator' AND wallet_account_id='wallet-1' AND currency='CNY'`).Scan(&balance); err != nil {
		t.Fatal(err)
	}
	if balance != 10_000 {
		t.Fatalf("wallet balance after rollback = %d", balance)
	}

	var consumed atomic.Int64
	nonce := "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB"
	for range 16 {
		group.Add(1)
		go func() {
			defer group.Done()
			ok, consumeErr := store.Consume(
				context.Background(), "HTTP_REQUEST\x00local-operator\x00wallet-key", nonce,
				time.Now().Add(time.Minute),
			)
			if consumeErr != nil {
				t.Errorf("consume nonce: %v", consumeErr)
			}
			if ok {
				consumed.Add(1)
			}
		}()
	}
	group.Wait()
	if consumed.Load() != 1 {
		t.Fatalf("nonce consumed = %d times", consumed.Load())
	}
}

func assertWalletV2HalfBoundRowsRejected(
	t *testing.T,
	ctx context.Context,
	database interface {
		ExecContext(context.Context, string, ...any) (sql.Result, error)
	},
	success validatedRound,
	rejection validatedRound,
) {
	t.Helper()
	for _, test := range []struct {
		name          string
		table         string
		sourceID      string
		operationID   string
		transactionID string
		walletSession any
		commandDigest any
	}{
		{
			name: "operation-session-only", table: "local_operator_wallet_operations",
			sourceID: success.OperationID, operationID: "half-operation-session",
			transactionID: "half-operation-session-tx",
			walletSession: success.WalletSessionRef, commandDigest: nil,
		},
		{
			name: "operation-digest-only", table: "local_operator_wallet_operations",
			sourceID: success.OperationID, operationID: "half-operation-digest",
			transactionID: "half-operation-digest-tx",
			walletSession: nil, commandDigest: success.CommandDigest,
		},
		{
			name: "rejection-session-only", table: "local_operator_wallet_rejections",
			sourceID: rejection.OperationID, operationID: "half-rejection-session",
			walletSession: rejection.WalletSessionRef, commandDigest: nil,
		},
		{
			name: "rejection-digest-only", table: "local_operator_wallet_rejections",
			sourceID: rejection.OperationID, operationID: "half-rejection-digest",
			walletSession: nil, commandDigest: rejection.CommandDigest,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var statement string
			var args []any
			if test.table == "local_operator_wallet_operations" {
				statement = `
					INSERT INTO local_operator_wallet_operations (
						operator_id, operation_id, request_digest, fingerprint, player_id,
						wallet_account_id, wallet_session_ref, rgs_session_id, round_id,
						game_id, definition_version, definition_hash, round_kind, currency,
						debit_minor, credit_minor, command_digest, balance_minor, transaction_id
					)
					SELECT operator_id, $2, request_digest, fingerprint, player_id,
						wallet_account_id, $3, rgs_session_id, round_id,
						game_id, definition_version, definition_hash, round_kind, currency,
						debit_minor, credit_minor, $4, balance_minor, $5
					FROM local_operator_wallet_operations
					WHERE operator_id=$1 AND operation_id=$6`
				args = []any{success.OperatorID, test.operationID, test.walletSession,
					test.commandDigest, test.transactionID, test.sourceID}
			} else {
				statement = `
					INSERT INTO local_operator_wallet_rejections (
						operator_id, operation_id, request_digest, fingerprint, player_id,
						wallet_account_id, wallet_session_ref, rgs_session_id, round_id,
						game_id, definition_version, definition_hash, round_kind, currency,
						debit_minor, credit_minor, command_digest, rejection_code
					)
					SELECT operator_id, $2, request_digest, fingerprint, player_id,
						wallet_account_id, $3, rgs_session_id, round_id,
						game_id, definition_version, definition_hash, round_kind, currency,
						debit_minor, credit_minor, $4, rejection_code
					FROM local_operator_wallet_rejections
					WHERE operator_id=$1 AND operation_id=$5`
				args = []any{rejection.OperatorID, test.operationID, test.walletSession,
					test.commandDigest, test.sourceID}
			}
			if _, err := database.ExecContext(ctx, statement, args...); err == nil {
				t.Fatal("half-bound wallet row passed PostgreSQL CHECK")
			}
		})
	}
}

func TestPostgresRuntimeRoleIsLeastPrivilege(t *testing.T) {
	databaseURL := os.Getenv("LOCAL_OPERATOR_TEST_RUNTIME_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("LOCAL_OPERATOR_TEST_RUNTIME_DATABASE_URL is not configured")
	}
	database, err := openDatabase(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := verifyRuntimeDatabaseRole(ctx, database, "local_operator_runtime"); err != nil {
		t.Fatal(err)
	}
	store, err := newPostgresStore(database)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `CREATE TABLE local_operator_forbidden_ddl (id bigint)`); err == nil {
		t.Fatal("runtime role unexpectedly created a table")
	}
	if _, err := database.ExecContext(ctx, `TRUNCATE local_operator_accounts`); err == nil {
		t.Fatal("runtime role unexpectedly truncated wallet state")
	}
}
