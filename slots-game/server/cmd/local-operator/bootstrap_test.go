package main

import (
	"context"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDatabaseURLForRolePreservesTLSContract(t *testing.T) {
	admin := "postgres://postgres:admin@postgres.local:5432/rgs?sslmode=verify-full&sslrootcert=%2Frun%2Fsecrets%2Fpostgres-ca.pem"
	result, err := databaseURLForRole(admin, "local_operator_runtime", "abcdefghijklmnopqrstuvwxyzABCDEFG_12345")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(result)
	if err != nil {
		t.Fatal(err)
	}
	password, _ := parsed.User.Password()
	if parsed.User.Username() != "local_operator_runtime" || password != "abcdefghijklmnopqrstuvwxyzABCDEFG_12345" ||
		parsed.Query().Get("sslmode") != "verify-full" ||
		parsed.Query().Get("sslrootcert") != "/run/secrets/postgres-ca.pem" {
		t.Fatalf("role database URL = %s", result)
	}
}

func TestWriteSecretAtomicallyRestrictsPermissionsAndRejectsSymlink(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "runtime.dsn")
	if err := writeSecretAtomically(target, []byte("first\n")); err != nil {
		t.Fatal(err)
	}
	if err := writeSecretAtomically(target, []byte("second\n")); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "second\n" || info.Mode().Perm() != 0o600 {
		t.Fatalf("secret output = %q mode=%04o", contents, info.Mode().Perm())
	}
	symlink := filepath.Join(directory, "unsafe.dsn")
	if err := os.Symlink(target, symlink); err != nil {
		t.Fatal(err)
	}
	if err := writeSecretAtomically(symlink, []byte("unsafe\n")); err == nil {
		t.Fatal("symlink secret target unexpectedly replaced")
	}
}

func TestPostgresBootstrapCreatesSeparatedOwnerAndRuntimeRoles(t *testing.T) {
	adminURL := os.Getenv("LOCAL_OPERATOR_TEST_ADMIN_DATABASE_URL")
	if adminURL == "" {
		t.Skip("LOCAL_OPERATOR_TEST_ADMIN_DATABASE_URL is not configured")
	}
	const (
		ownerPassword   = "owner_bootstrap_password_ABCDEFGHIJKLMNOPQRSTUVWXYZ"
		runtimePassword = "runtime_bootstrap_password_ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	admin, err := openDatabase(adminURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if err := reconcileDatabaseRoles(
		ctx, admin, "local_operator_owner", ownerPassword,
		"local_operator_runtime", runtimePassword,
	); err != nil {
		t.Fatal(err)
	}
	ownerURL, err := databaseURLForRole(adminURL, "local_operator_owner", ownerPassword)
	if err != nil {
		t.Fatal(err)
	}
	owner, err := openDatabase(ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	if err := migrateLocalOperator(ctx, owner, "local_operator_owner", "local_operator_runtime"); err != nil {
		owner.Close()
		t.Fatal(err)
	}
	owner.Close()
	runtimeURL, err := databaseURLForRole(adminURL, "local_operator_runtime", runtimePassword)
	if err != nil {
		t.Fatal(err)
	}
	runtimeDatabase, err := openDatabase(runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	defer runtimeDatabase.Close()
	if err := verifyRuntimeDatabaseRole(ctx, runtimeDatabase, "local_operator_runtime"); err != nil {
		t.Fatal(err)
	}
	store, err := newPostgresStore(runtimeDatabase)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.EnsureAccount(ctx, accountSeed{
		OperatorID: "local-operator", WalletAccountID: "bootstrap-wallet",
		Currency: "CNY", BalanceMinor: 1_000,
	}); err != nil {
		t.Fatalf("runtime account insert privilege: %v", err)
	}
	request, err := validateRound(bindWalletV2(t, roundRequest{
		OperationID: "bootstrap-operation",
		Fingerprint: "rgs-fp-v2:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		OperatorID:  "local-operator", PlayerID: "bootstrap-player",
		WalletAccountID: "bootstrap-wallet", WalletSessionRef: "bootstrap-wallet-session",
		SessionID: "bootstrap-session",
		RoundID:   "bootstrap-round", GameID: "iron-colossus", DefinitionVersion: "math-v1",
		DefinitionHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		RoundKind:      "BASE", Currency: "CNY", DebitMinor: "100", CreditMinor: "0",
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
		t.Fatalf("runtime wallet session insert privilege: %v", err)
	}
	if operation, err := store.Apply(ctx, request); err != nil || operation.BalanceMinor != 900 {
		t.Fatalf("runtime wallet DML = %+v, %v", operation, err)
	}
	if _, err := runtimeDatabase.ExecContext(ctx, `TRUNCATE local_operator_accounts`); err == nil {
		t.Fatal("runtime role unexpectedly truncated wallet state")
	}
}
