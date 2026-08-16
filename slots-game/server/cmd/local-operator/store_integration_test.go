package main

import (
	"context"
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
			local_operator_nonces, local_operator_accounts`); err != nil {
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
	request, err := validateRound(roundRequest{
		OperationID: "operation-1",
		Fingerprint: "rgs-fp-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		OperatorID:  "local-operator", PlayerID: "player-1", WalletAccountID: "wallet-1",
		SessionID: "session-1", RoundID: "round-1", GameID: "iron-colossus",
		DefinitionVersion: "math-v1",
		DefinitionHash:    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RoundKind:         "BASE", Currency: "CNY", DebitMinor: "100", CreditMinor: "50",
	}, nil)
	if err != nil {
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
	rollback, err := validateRollback(rollbackRequest{
		OperatorID: "local-operator", OperationID: "operation-1",
		RollbackID: "rollback-1", Reason: "operator reconciliation",
	})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		group.Add(1)
		go func() {
			defer group.Done()
			operation, rollbackErr := store.Rollback(context.Background(), rollback)
			if rollbackErr != nil || operation.BalanceMinor != 10_000 {
				t.Errorf("rollback = %+v, %v", operation, rollbackErr)
			}
		}()
	}
	group.Wait()
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
