package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"slots-game/server/internal/launch"
	"slots-game/server/internal/operator"
)

func TestSecurityStoreConstructorsRejectNilDatabase(t *testing.T) {
	if _, err := NewNonceStore(nil); err == nil {
		t.Fatal("NewNonceStore(nil) error = nil")
	}
	if _, err := NewLaunchStore(nil); err == nil {
		t.Fatal("NewLaunchStore(nil) error = nil")
	}
}

func TestNonceStoreConsumeHashesAndScopesNonce(t *testing.T) {
	db, mock := newSecurityMock(t)
	store, err := NewNonceStore(db)
	if err != nil {
		t.Fatalf("NewNonceStore() error = %v", err)
	}

	nonce := securityTestNonce(0x41)
	digest := sha256.Sum256([]byte(nonce))
	expiresAt := time.Date(2026, 7, 26, 12, 3, 4, 0, time.FixedZone("test", 8*60*60))
	mock.ExpectQuery(regexp.QuoteMeta(nonceConsumeSQL)).
		WithArgs("operator-a", "request-key-1", hex.EncodeToString(digest[:]), expiresAt.UTC()).
		WillReturnRows(sqlmock.NewRows([]string{"consumed"}).AddRow(1))

	consumed, err := store.Consume(
		context.Background(),
		string(operator.KeyPurposeHTTPRequest)+"\x00operator-a\x00request-key-1",
		nonce,
		expiresAt,
	)
	if err != nil {
		t.Fatalf("Consume() error = %v", err)
	}
	if !consumed {
		t.Fatal("Consume() = false, want true")
	}
	assertSecurityExpectations(t, mock)
}

func TestNonceStoreConsumeReturnsFalseForReplayOrExpiredInput(t *testing.T) {
	for _, name := range []string{"unexpired replay", "presented expiry is past"} {
		t.Run(name, func(t *testing.T) {
			db, mock := newSecurityMock(t)
			store, err := NewNonceStore(db)
			if err != nil {
				t.Fatalf("NewNonceStore() error = %v", err)
			}
			nonce := securityTestNonce(0x42)
			digest := sha256.Sum256([]byte(nonce))
			expiresAt := time.Date(2026, 7, 26, 12, 3, 4, 0, time.UTC)
			mock.ExpectQuery(regexp.QuoteMeta(nonceConsumeSQL)).
				WithArgs("operator-a", "request-key-1", hex.EncodeToString(digest[:]), expiresAt).
				WillReturnRows(sqlmock.NewRows([]string{"consumed"}))

			consumed, consumeErr := store.Consume(
				context.Background(),
				string(operator.KeyPurposeHTTPRequest)+"\x00operator-a\x00request-key-1",
				nonce,
				expiresAt,
			)
			if consumeErr != nil {
				t.Fatalf("Consume() error = %v", consumeErr)
			}
			if consumed {
				t.Fatal("Consume() = true, want false")
			}
			assertSecurityExpectations(t, mock)
		})
	}
}

func TestNonceStoreConsumeFailsClosed(t *testing.T) {
	t.Run("malformed scope", func(t *testing.T) {
		db, mock := newSecurityMock(t)
		store, err := NewNonceStore(db)
		if err != nil {
			t.Fatalf("NewNonceStore() error = %v", err)
		}
		if consumed, consumeErr := store.Consume(
			context.Background(), "operator-a\x00request-key-1", securityTestNonce(1), time.Now().Add(time.Minute),
		); consumeErr == nil || consumed {
			t.Fatalf("Consume() = (%v, %v), want (false, error)", consumed, consumeErr)
		}
		assertSecurityExpectations(t, mock)
	})

	t.Run("database unavailable", func(t *testing.T) {
		db, mock := newSecurityMock(t)
		store, err := NewNonceStore(db)
		if err != nil {
			t.Fatalf("NewNonceStore() error = %v", err)
		}
		sentinel := errors.New("database unavailable")
		nonce := securityTestNonce(2)
		digest := sha256.Sum256([]byte(nonce))
		expiresAt := time.Now().UTC().Add(time.Minute)
		mock.ExpectQuery(regexp.QuoteMeta(nonceConsumeSQL)).
			WithArgs("operator-a", "request-key-1", hex.EncodeToString(digest[:]), expiresAt).
			WillReturnError(sentinel)
		consumed, consumeErr := store.Consume(
			context.Background(),
			string(operator.KeyPurposeHTTPRequest)+"\x00operator-a\x00request-key-1",
			nonce,
			expiresAt,
		)
		if consumed || !errors.Is(consumeErr, sentinel) {
			t.Fatalf("Consume() = (%v, %v), want wrapped database error", consumed, consumeErr)
		}
		assertSecurityExpectations(t, mock)
	})
}

func TestLaunchStoreCreatePersistsDigestAndCanonicalClaims(t *testing.T) {
	db, mock := newSecurityMock(t)
	store, err := NewLaunchStore(db)
	if err != nil {
		t.Fatalf("NewLaunchStore() error = %v", err)
	}
	record := validLaunchRecord()
	claimsJSON, err := json.Marshal(claimsDocumentFrom(record.Claims))
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	if bytes.Contains(claimsJSON, []byte(launch.CodePrefix)) {
		t.Fatal("claims JSON unexpectedly contains plaintext launch credential")
	}
	mock.ExpectExec(regexp.QuoteMeta(launchCreateSQL)).WithArgs(
		hex.EncodeToString(record.Digest[:]),
		record.Claims.OperatorID,
		claimsJSON,
		record.ExpiresAt.UTC(),
		record.CreatedAt.UTC(),
	).WillReturnResult(sqlmock.NewResult(0, 1))

	if err := store.Create(context.Background(), record); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	assertSecurityExpectations(t, mock)
}

func TestLaunchStoreCreateMapsDigestCollision(t *testing.T) {
	db, mock := newSecurityMock(t)
	store, err := NewLaunchStore(db)
	if err != nil {
		t.Fatalf("NewLaunchStore() error = %v", err)
	}
	record := validLaunchRecord()
	mock.ExpectExec(regexp.QuoteMeta(launchCreateSQL)).
		WithArgs(
			hex.EncodeToString(record.Digest[:]),
			record.Claims.OperatorID,
			sqlmock.AnyArg(),
			record.ExpiresAt.UTC(),
			record.CreatedAt.UTC(),
		).
		WillReturnResult(sqlmock.NewResult(0, 0))

	if err := store.Create(context.Background(), record); !errors.Is(err, launch.ErrDigestExists) {
		t.Fatalf("Create() error = %v, want ErrDigestExists", err)
	}
	assertSecurityExpectations(t, mock)
}

func TestLaunchStoreConsumeAtomicallyBindsTenantSessionAndExpiry(t *testing.T) {
	db, mock := newSecurityMock(t)
	store, err := NewLaunchStore(db)
	if err != nil {
		t.Fatalf("NewLaunchStore() error = %v", err)
	}
	record := validLaunchRecord()
	claimsJSON, err := json.Marshal(claimsDocumentFrom(record.Claims))
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	request := launch.ConsumeRequest{
		Digest: record.Digest,
		Binding: launch.Binding{
			OperatorID: record.Claims.OperatorID,
			SessionID:  record.Claims.SessionID,
		},
	}
	mock.ExpectQuery(regexp.QuoteMeta(launchConsumeSQL)).WithArgs(
		hex.EncodeToString(record.Digest[:]),
		record.Claims.OperatorID,
		record.Claims.SessionID,
	).WillReturnRows(sqlmock.NewRows([]string{
		"operator_id", "claims_json", "created_at", "expires_at",
	}).AddRow(record.Claims.OperatorID, claimsJSON, record.CreatedAt, record.ExpiresAt))

	consumed, err := store.Consume(context.Background(), request)
	if err != nil {
		t.Fatalf("Consume() error = %v", err)
	}
	if consumed != record {
		t.Fatalf("Consume() = %#v, want %#v", consumed, record)
	}
	assertSecurityExpectations(t, mock)
}

func TestLaunchStoreGetSupportsExpiredOrConsumedIdempotencyReplay(t *testing.T) {
	db, mock := newSecurityMock(t)
	store, err := NewLaunchStore(db)
	if err != nil {
		t.Fatal(err)
	}
	record := validLaunchRecord()
	claimsJSON, err := json.Marshal(claimsDocumentFrom(record.Claims))
	if err != nil {
		t.Fatal(err)
	}
	digest := hex.EncodeToString(record.Digest[:])
	mock.ExpectQuery(regexp.QuoteMeta(launchGetSQL)).
		WithArgs(digest).
		WillReturnRows(sqlmock.NewRows([]string{
			"code_hash", "operator_id", "claims_json", "created_at", "expires_at",
		}).AddRow(digest, record.Claims.OperatorID, claimsJSON, record.CreatedAt, record.ExpiresAt))

	got, err := store.Get(context.Background(), record.Digest)
	if err != nil {
		t.Fatal(err)
	}
	if got != record {
		t.Fatalf("Get = %#v, want %#v", got, record)
	}
	assertSecurityExpectations(t, mock)
}

func TestLaunchStoreConsumeUnifiesEveryNonConsumableCode(t *testing.T) {
	for _, condition := range []string{
		"unknown digest", "expired", "already consumed", "wrong tenant", "wrong session",
	} {
		t.Run(condition, func(t *testing.T) {
			db, mock := newSecurityMock(t)
			store, err := NewLaunchStore(db)
			if err != nil {
				t.Fatalf("NewLaunchStore() error = %v", err)
			}
			record := validLaunchRecord()
			request := launch.ConsumeRequest{
				Digest: record.Digest,
				Binding: launch.Binding{
					OperatorID: record.Claims.OperatorID,
					SessionID:  record.Claims.SessionID,
				},
			}
			mock.ExpectQuery(regexp.QuoteMeta(launchConsumeSQL)).WithArgs(
				hex.EncodeToString(record.Digest[:]),
				request.Binding.OperatorID,
				request.Binding.SessionID,
			).WillReturnRows(sqlmock.NewRows([]string{
				"operator_id", "claims_json", "created_at", "expires_at",
			}))

			if _, consumeErr := store.Consume(context.Background(), request); !errors.Is(consumeErr, launch.ErrCodeUnavailable) {
				t.Fatalf("Consume() error = %v, want ErrCodeUnavailable", consumeErr)
			}
			assertSecurityExpectations(t, mock)
		})
	}
}

func TestLaunchStoreConsumeSeparatesDatabaseFailureFromUnavailableCode(t *testing.T) {
	db, mock := newSecurityMock(t)
	store, err := NewLaunchStore(db)
	if err != nil {
		t.Fatalf("NewLaunchStore() error = %v", err)
	}
	record := validLaunchRecord()
	sentinel := errors.New("database unavailable")
	mock.ExpectQuery(regexp.QuoteMeta(launchConsumeSQL)).WithArgs(
		hex.EncodeToString(record.Digest[:]),
		record.Claims.OperatorID,
		record.Claims.SessionID,
	).WillReturnError(sentinel)

	_, consumeErr := store.Consume(context.Background(), launch.ConsumeRequest{
		Digest: record.Digest,
		Binding: launch.Binding{
			OperatorID: record.Claims.OperatorID,
			SessionID:  record.Claims.SessionID,
		},
	})
	if !errors.Is(consumeErr, sentinel) || errors.Is(consumeErr, launch.ErrCodeUnavailable) {
		t.Fatalf("Consume() error = %v, want wrapped database error only", consumeErr)
	}
	assertSecurityExpectations(t, mock)
}

func TestLaunchStoreConsumeRejectsCorruptPersistedClaims(t *testing.T) {
	db, mock := newSecurityMock(t)
	store, err := NewLaunchStore(db)
	if err != nil {
		t.Fatalf("NewLaunchStore() error = %v", err)
	}
	record := validLaunchRecord()
	corrupt := []byte(`{"operatorId":"operator-a","unexpected":true}`)
	mock.ExpectQuery(regexp.QuoteMeta(launchConsumeSQL)).WithArgs(
		hex.EncodeToString(record.Digest[:]),
		record.Claims.OperatorID,
		record.Claims.SessionID,
	).WillReturnRows(sqlmock.NewRows([]string{
		"operator_id", "claims_json", "created_at", "expires_at",
	}).AddRow(record.Claims.OperatorID, corrupt, record.CreatedAt, record.ExpiresAt))

	_, consumeErr := store.Consume(context.Background(), launch.ConsumeRequest{
		Digest: record.Digest,
		Binding: launch.Binding{
			OperatorID: record.Claims.OperatorID,
			SessionID:  record.Claims.SessionID,
		},
	})
	if !errors.Is(consumeErr, launch.ErrStoreInvariant) {
		t.Fatalf("Consume() error = %v, want ErrStoreInvariant", consumeErr)
	}
	assertSecurityExpectations(t, mock)
}

func TestDecodeLaunchClaimsRejectsDuplicateMembers(t *testing.T) {
	encoded := []byte(`{"operatorId":"operator-a","operatorId":"operator-b"}`)
	if _, err := decodeClaimsDocument(encoded); err == nil {
		t.Fatal("duplicate persisted claim unexpectedly accepted")
	}
}

func TestSecurityStoresPurgeExpiredInBoundedSkipLockedBatches(t *testing.T) {
	db, mock := newSecurityMock(t)
	nonceStore, err := NewNonceStore(db)
	if err != nil {
		t.Fatalf("NewNonceStore() error = %v", err)
	}
	launchStore, err := NewLaunchStore(db)
	if err != nil {
		t.Fatalf("NewLaunchStore() error = %v", err)
	}
	before := time.Date(2026, 7, 26, 8, 0, 0, 0, time.FixedZone("test", 8*60*60))
	mock.ExpectExec(regexp.QuoteMeta(noncePurgeSQL)).
		WithArgs(before.UTC(), 250).
		WillReturnResult(sqlmock.NewResult(0, 250))
	mock.ExpectExec(regexp.QuoteMeta(launchPurgeSQL)).
		WithArgs(before.UTC(), launch.IdempotencyRetention.Microseconds(), 100).
		WillReturnResult(sqlmock.NewResult(0, 37))

	if count, purgeErr := nonceStore.PurgeExpired(context.Background(), before, 250); purgeErr != nil || count != 250 {
		t.Fatalf("NonceStore.PurgeExpired() = (%d, %v), want (250, nil)", count, purgeErr)
	}
	if count, purgeErr := launchStore.PurgeExpired(context.Background(), before, 100); purgeErr != nil || count != 37 {
		t.Fatalf("LaunchStore.PurgeExpired() = (%d, %v), want (37, nil)", count, purgeErr)
	}
	assertSecurityExpectations(t, mock)
}

func TestSecurityPurgeSQLCapsCallerClockAtDatabaseTime(t *testing.T) {
	t.Parallel()
	for name, query := range map[string]string{
		"nonce":  noncePurgeSQL,
		"launch": launchPurgeSQL,
	} {
		if !strings.Contains(query, "LEAST($1, CURRENT_TIMESTAMP)") {
			t.Errorf("%s purge SQL does not cap the caller clock at PostgreSQL time", name)
		}
	}
	if !strings.Contains(launchPurgeSQL, "$2::bigint * INTERVAL '1 microsecond'") {
		t.Error("launch purge SQL does not apply the idempotency retention window in PostgreSQL")
	}
}

func TestSecurityStoresRejectUnboundedPurge(t *testing.T) {
	db, mock := newSecurityMock(t)
	nonceStore, err := NewNonceStore(db)
	if err != nil {
		t.Fatalf("NewNonceStore() error = %v", err)
	}
	launchStore, err := NewLaunchStore(db)
	if err != nil {
		t.Fatalf("NewLaunchStore() error = %v", err)
	}
	for _, test := range []struct {
		name  string
		purge func() error
	}{
		{name: "zero time", purge: func() error {
			_, purgeErr := nonceStore.PurgeExpired(context.Background(), time.Time{}, 1)
			return purgeErr
		}},
		{name: "zero batch", purge: func() error {
			_, purgeErr := launchStore.PurgeExpired(context.Background(), time.Now(), 0)
			return purgeErr
		}},
		{name: "oversized batch", purge: func() error {
			_, purgeErr := nonceStore.PurgeExpired(context.Background(), time.Now(), MaximumSecurityPurgeBatch+1)
			return purgeErr
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := test.purge(); err == nil {
				t.Fatal("PurgeExpired() error = nil")
			}
		})
	}
	assertSecurityExpectations(t, mock)
}

func newSecurityMock(t *testing.T) (*sql.DB, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error = %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})
	return db, mock
}

func assertSecurityExpectations(t *testing.T, mock sqlmock.Sqlmock) {
	t.Helper()
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("database expectations: %v", err)
	}
}

func securityTestNonce(fill byte) string {
	return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{fill}, 24))
}

func validLaunchRecord() launch.Record {
	digest := sha256.Sum256([]byte(launch.CodePrefix + strings.Repeat("A", 43)))
	createdAt := time.Date(2026, 7, 26, 3, 4, 5, 0, time.UTC)
	return launch.Record{
		Digest: launch.CodeDigest(digest),
		Claims: launch.Claims{
			OperatorID:            "operator-a",
			SessionID:             "session-1",
			PlayerID:              "player-1",
			WalletSessionID:       "wallet-session-1",
			GameID:                "iron-colossus",
			DefinitionVersion:     "math-2026.07.1",
			DefinitionHash:        strings.Repeat("a", 64),
			RequestFingerprint:    strings.Repeat("b", 64),
			Currency:              "EUR",
			CurrencyExponent:      2,
			Jurisdiction:          "MT",
			IdleDisconnectSeconds: 1200,
		},
		CreatedAt: createdAt,
		ExpiresAt: createdAt.Add(launch.DefaultTTL),
	}
}
