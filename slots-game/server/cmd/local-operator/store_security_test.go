package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"slots-game/server/internal/operator"
)

func TestPostgresStoreNonceConsumeRejectsDatabaseExpiredDeadline(t *testing.T) {
	t.Parallel()
	contract := strings.Join(strings.Fields(localOperatorNonceConsumeSQL), " ")
	if !strings.Contains(contract, "SELECT $1,$2,$3,$4 WHERE $4 > CURRENT_TIMESTAMP") {
		t.Fatalf("nonce consume SQL lacks database-time insertion guard: %s", contract)
	}

	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	store, err := newPostgresStore(database)
	if err != nil {
		t.Fatal(err)
	}
	nonce := "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB"
	digest := sha256.Sum256([]byte(nonce))
	expiresAt := time.Date(2026, time.August, 24, 12, 0, 0, 0, time.UTC)
	mock.ExpectQuery(regexp.QuoteMeta(localOperatorNonceConsumeSQL)).
		WithArgs("local-operator", "wallet-key", hex.EncodeToString(digest[:]), expiresAt).
		WillReturnRows(sqlmock.NewRows([]string{"consumed"}).AddRow(false))

	consumed, err := store.Consume(
		context.Background(),
		string(operator.KeyPurposeHTTPRequest)+"\x00local-operator\x00wallet-key",
		nonce,
		expiresAt,
	)
	if err != nil {
		t.Fatalf("Consume() error = %v", err)
	}
	if consumed {
		t.Fatal("database-expired nonce deadline was accepted")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestReusableWalletSessionUsesDatabaseClockAndTrustedBinding(t *testing.T) {
	t.Parallel()
	contract := strings.Join(strings.Fields(localOperatorReusableWalletSessionSQL), " ")
	for _, required := range []string{
		"operator_id=$1 AND player_id=$2 AND wallet_account_id=$3",
		"game_id=$4 AND definition_version=$5 AND definition_hash=$6",
		"currency=$7 AND expires_at>CURRENT_TIMESTAMP",
	} {
		if !strings.Contains(contract, required) {
			t.Fatalf("relaunch lookup lacks trusted binding/database clock fragment %q: %s", required, contract)
		}
	}

	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	store, err := newPostgresStore(database)
	if err != nil {
		t.Fatal(err)
	}
	expiresAt := time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC)
	mock.ExpectQuery(regexp.QuoteMeta(localOperatorReusableWalletSessionSQL)).
		WithArgs(
			"local-operator", "player-1", "wallet-1", "iron-colossus", "math-v1",
			strings.Repeat("a", 64), "CNY",
		).
		WillReturnRows(sqlmock.NewRows([]string{
			"operator_id", "wallet_session_ref", "player_id", "wallet_account_id",
			"rgs_session_id", "game_id", "definition_version", "definition_hash",
			"currency", "expires_at",
		}).AddRow(
			"local-operator", "wallet-session-1", "player-1", "wallet-1",
			"session-1", "iron-colossus", "math-v1", strings.Repeat("a", 64),
			"CNY", expiresAt,
		))

	seed, found, err := store.FindReusableWalletSession(
		context.Background(), "local-operator", "player-1", "wallet-1", "iron-colossus",
		"math-v1", strings.Repeat("a", 64), "CNY",
	)
	if err != nil || !found || seed.SessionID != "session-1" || seed.WalletSessionRef != "wallet-session-1" ||
		!seed.ExpiresAt.Equal(expiresAt) {
		t.Fatalf("reusable session = %+v found=%t err=%v", seed, found, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
