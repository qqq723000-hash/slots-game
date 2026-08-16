package launch

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestIssueStoresOnlyDigestAndConsumesExactlyOnce(t *testing.T) {
	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	store := newMemoryStore(func() time.Time { return now })
	service := newTestService(t, store, now, bytes.NewReader(bytes.Repeat([]byte{0x42}, CodeEntropyBytes)))

	issued, err := service.Issue(context.Background(), validClaims())
	if err != nil {
		t.Fatalf("Issue() error = %v", err)
	}
	if err := validateCode(issued.Code); err != nil {
		t.Fatalf("issued code invalid: %v", err)
	}
	if got, want := issued.ExpiresAt, now.Add(DefaultTTL); !got.Equal(want) {
		t.Fatalf("ExpiresAt = %v, want %v", got, want)
	}

	digest := CodeDigest(sha256.Sum256([]byte(issued.Code)))
	store.mu.Lock()
	stored, found := store.records[digest]
	storeDump := fmt.Sprintf("%#v", store.records)
	store.mu.Unlock()
	if !found {
		t.Fatal("SHA-256 digest was not persisted")
	}
	if strings.Contains(storeDump, issued.Code) {
		t.Fatal("memory store retained the plaintext launch code")
	}
	if stored.record.Claims != validClaims() {
		t.Fatalf("stored claims = %#v", stored.record.Claims)
	}

	claims, err := service.Consume(context.Background(), issued.Code, validBinding())
	if err != nil {
		t.Fatalf("first Consume() error = %v", err)
	}
	if claims != validClaims() {
		t.Fatalf("claims = %#v, want %#v", claims, validClaims())
	}
	if _, err := service.Consume(context.Background(), issued.Code, validBinding()); !errors.Is(err, ErrCodeUnavailable) {
		t.Fatalf("replay error = %v, want ErrCodeUnavailable", err)
	}
}

func TestIssueCodeReplaysExactClaimsAndRejectsChangedRequest(t *testing.T) {
	now := time.Date(2026, 7, 26, 1, 2, 3, 0, time.UTC)
	store := newMemoryStore(func() time.Time { return now })
	service := newTestService(t, store, now, bytes.NewReader(bytes.Repeat([]byte{1}, 64)))
	code := CodePrefix + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, CodeEntropyBytes))
	first, err := service.IssueCode(context.Background(), validClaims(), code)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.IssueCode(context.Background(), validClaims(), code)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || first.Code != code {
		t.Fatalf("idempotent issue differs: %+v %+v", first, second)
	}
	changed := validClaims()
	changed.RequestFingerprint = strings.Repeat("c", 64)
	if _, err := service.IssueCode(context.Background(), changed, code); !errors.Is(err, ErrDigestExists) {
		t.Fatalf("changed request error = %v, want ErrDigestExists", err)
	}
}

func TestIssueCodeRetainsExpiredResponseAsIdempotencyTombstone(t *testing.T) {
	now := time.Date(2026, 7, 26, 1, 2, 3, 0, time.UTC)
	clock := now
	store := newMemoryStore(func() time.Time { return clock })
	service, err := newService(
		store,
		Options{TTL: time.Second},
		bytes.NewReader(bytes.Repeat([]byte{1}, 64)),
		func() time.Time { return clock },
	)
	if err != nil {
		t.Fatal(err)
	}
	code := CodePrefix + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{8}, CodeEntropyBytes))
	first, err := service.IssueCode(context.Background(), validClaims(), code)
	if err != nil {
		t.Fatal(err)
	}

	clock = first.ExpiresAt
	if _, err := service.Consume(context.Background(), code, validBinding()); !errors.Is(err, ErrCodeUnavailable) {
		t.Fatalf("expired consume error = %v, want ErrCodeUnavailable", err)
	}
	replayed, err := service.IssueCode(context.Background(), validClaims(), code)
	if err != nil {
		t.Fatal(err)
	}
	if replayed.Code != first.Code || !replayed.ExpiresAt.Equal(first.ExpiresAt) || !replayed.HistoricalReplay {
		t.Fatalf("expired replay = %+v, want historical replay of %+v", replayed, first)
	}
	changed := validClaims()
	changed.RequestFingerprint = strings.Repeat("c", 64)
	if _, err := service.IssueCode(context.Background(), changed, code); !errors.Is(err, ErrDigestExists) {
		t.Fatalf("changed expired request error = %v, want ErrDigestExists", err)
	}
	nextCode := CodePrefix + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{9}, CodeEntropyBytes))
	next, err := service.IssueCode(context.Background(), changed, nextCode)
	if err != nil {
		t.Fatalf("new handoff alongside expired tombstone failed: %v", err)
	}
	if next.Code == first.Code || next.HistoricalReplay {
		t.Fatalf("new handoff = %+v, old = %+v", next, first)
	}
	if _, err := service.Consume(context.Background(), next.Code, validBinding()); err != nil {
		t.Fatalf("new handoff consume failed: %v", err)
	}
	if _, err := service.Consume(context.Background(), next.Code, validBinding()); !errors.Is(err, ErrCodeUnavailable) {
		t.Fatalf("new handoff second consume error = %v, want ErrCodeUnavailable", err)
	}
	store.mu.Lock()
	retained := len(store.records)
	store.mu.Unlock()
	if retained != 2 {
		t.Fatalf("retained tombstones = %d, want 2", retained)
	}

	clock = first.ExpiresAt.Add(IdempotencyRetention - time.Nanosecond)
	if _, err := store.Get(context.Background(), CodeDigest(sha256.Sum256([]byte(code)))); err != nil {
		t.Fatalf("tombstone disappeared inside retention: %v", err)
	}
	clock = first.ExpiresAt.Add(IdempotencyRetention)
	if _, err := store.Get(context.Background(), CodeDigest(sha256.Sum256([]byte(code)))); !errors.Is(err, ErrCodeUnavailable) {
		t.Fatalf("retention-boundary get error = %v, want ErrCodeUnavailable", err)
	}
}

func TestBindingMismatchDoesNotConsumeCode(t *testing.T) {
	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	store := newMemoryStore(func() time.Time { return now })
	service := newTestService(t, store, now, bytes.NewReader(bytes.Repeat([]byte{0x21}, CodeEntropyBytes)))
	issued, err := service.Issue(context.Background(), validClaims())
	if err != nil {
		t.Fatal(err)
	}

	wrongTenant := validBinding()
	wrongTenant.OperatorID = "operator-b"
	if _, err := service.Consume(context.Background(), issued.Code, wrongTenant); !errors.Is(err, ErrCodeUnavailable) {
		t.Fatalf("wrong-tenant error = %v, want ErrCodeUnavailable", err)
	}
	wrongSession := validBinding()
	wrongSession.SessionID = "session-b"
	if _, err := service.Consume(context.Background(), issued.Code, wrongSession); !errors.Is(err, ErrCodeUnavailable) {
		t.Fatalf("wrong-session error = %v, want ErrCodeUnavailable", err)
	}
	if _, err := service.Consume(context.Background(), issued.Code, validBinding()); err != nil {
		t.Fatalf("correct binding after mismatches failed: %v", err)
	}
}

func TestExpiredCodeCannotBeConsumed(t *testing.T) {
	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	clock := now
	store := newMemoryStore(func() time.Time { return clock })
	service, err := newService(store, Options{TTL: time.Second}, bytes.NewReader(bytes.Repeat([]byte{0x33}, CodeEntropyBytes)), func() time.Time { return clock })
	if err != nil {
		t.Fatal(err)
	}
	issued, err := service.Issue(context.Background(), validClaims())
	if err != nil {
		t.Fatal(err)
	}
	clock = now.Add(time.Second)
	if _, err := service.Consume(context.Background(), issued.Code, validBinding()); !errors.Is(err, ErrCodeUnavailable) {
		t.Fatalf("expiry-boundary error = %v, want ErrCodeUnavailable", err)
	}
}

func TestConcurrentConsumeSucceedsOnce(t *testing.T) {
	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	store := newMemoryStore(func() time.Time { return now })
	service := newTestService(t, store, now, bytes.NewReader(bytes.Repeat([]byte{0x5a}, CodeEntropyBytes)))
	issued, err := service.Issue(context.Background(), validClaims())
	if err != nil {
		t.Fatal(err)
	}

	const consumers = 128
	start := make(chan struct{})
	errorsCh := make(chan error, consumers)
	var successes atomic.Int64
	var wait sync.WaitGroup
	wait.Add(consumers)
	for range consumers {
		go func() {
			defer wait.Done()
			<-start
			_, consumeErr := service.Consume(context.Background(), issued.Code, validBinding())
			if consumeErr == nil {
				successes.Add(1)
				return
			}
			if !errors.Is(consumeErr, ErrCodeUnavailable) {
				errorsCh <- consumeErr
			}
		}()
	}
	close(start)
	wait.Wait()
	close(errorsCh)
	for consumeErr := range errorsCh {
		t.Errorf("unexpected concurrent consume error: %v", consumeErr)
	}
	if got := successes.Load(); got != 1 {
		t.Fatalf("successful consumes = %d, want 1", got)
	}
}

func TestStrictValidationRejectsMalformedClaimsWithoutPersistence(t *testing.T) {
	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	base := validClaims()
	tests := []struct {
		name   string
		mutate func(*Claims)
	}{
		{name: "operator", mutate: func(c *Claims) { c.OperatorID = "bad tenant" }},
		{name: "session", mutate: func(c *Claims) { c.SessionID = "" }},
		{name: "player", mutate: func(c *Claims) { c.PlayerID = strings.Repeat("a", 129) }},
		{name: "wallet session", mutate: func(c *Claims) { c.WalletSessionID = "/wallet" }},
		{name: "game", mutate: func(c *Claims) { c.GameID = "" }},
		{name: "definition version", mutate: func(c *Claims) { c.DefinitionVersion = "version with spaces" }},
		{name: "definition hash", mutate: func(c *Claims) { c.DefinitionHash = strings.Repeat("A", 64) }},
		{name: "currency", mutate: func(c *Claims) { c.Currency = "usd" }},
		{name: "currency exponent", mutate: func(c *Claims) { c.CurrencyExponent = 7 }},
		{name: "jurisdiction", mutate: func(c *Claims) { c.Jurisdiction = "?" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := newMemoryStore(func() time.Time { return now })
			service := newTestService(t, store, now, bytes.NewReader(bytes.Repeat([]byte{0x66}, CodeEntropyBytes)))
			claims := base
			test.mutate(&claims)
			if _, err := service.Issue(context.Background(), claims); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("Issue() error = %v, want ErrInvalidInput", err)
			}
			store.mu.Lock()
			count := len(store.records)
			store.mu.Unlock()
			if count != 0 {
				t.Fatalf("store count = %d after invalid issue", count)
			}
		})
	}
}

func TestConsumeRejectsMalformedCodeAndBinding(t *testing.T) {
	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	service := newTestService(t, newMemoryStore(func() time.Time { return now }), now, bytes.NewReader(bytes.Repeat([]byte{0x11}, CodeEntropyBytes)))
	for _, code := range []string{"", "lc_bad", strings.Repeat("x", 10_000), "lc_" + strings.Repeat("=", 43)} {
		if _, err := service.Consume(context.Background(), code, validBinding()); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("Consume(%q) error = %v, want ErrInvalidInput", code, err)
		}
	}
	binding := validBinding()
	binding.SessionID = "bad session"
	code := CodePrefix + strings.Repeat("A", 43)
	if _, err := service.Consume(context.Background(), code, binding); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("bad binding error = %v, want ErrInvalidInput", err)
	}
}

func TestServiceOptionsEntropyFailureAndCollision(t *testing.T) {
	store := NewMemoryStore()
	for _, ttl := range []time.Duration{-time.Second, time.Nanosecond, MaximumTTL + time.Nanosecond} {
		if _, err := NewService(store, Options{TTL: ttl}); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("TTL %s error = %v, want ErrInvalidInput", ttl, err)
		}
	}
	if _, err := NewService(nil, Options{}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("nil store error = %v, want ErrInvalidInput", err)
	}

	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	failing := newTestService(t, newMemoryStore(func() time.Time { return now }), now, errorReader{})
	if _, err := failing.Issue(context.Background(), validClaims()); !errors.Is(err, ErrEntropy) {
		t.Fatalf("entropy error = %v, want ErrEntropy", err)
	}

	collidingStore := digestCollisionStore{}
	colliding := newTestService(t, collidingStore, now, bytes.NewReader(bytes.Repeat([]byte{0x77}, CodeEntropyBytes*codeGenerationTries)))
	if _, err := colliding.Issue(context.Background(), validClaims()); !errors.Is(err, ErrEntropy) {
		t.Fatalf("collision error = %v, want ErrEntropy", err)
	}
}

func TestCanceledContextDoesNotCreateOrConsume(t *testing.T) {
	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	store := newMemoryStore(func() time.Time { return now })
	service := newTestService(t, store, now, bytes.NewReader(bytes.Repeat([]byte{0x12}, CodeEntropyBytes)))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := service.Issue(ctx, validClaims()); !errors.Is(err, context.Canceled) {
		t.Fatalf("Issue canceled error = %v", err)
	}
	if _, err := service.Consume(ctx, CodePrefix+strings.Repeat("A", 43), validBinding()); !errors.Is(err, context.Canceled) {
		t.Fatalf("Consume canceled error = %v", err)
	}
}

type errorReader struct{}

func (errorReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

type digestCollisionStore struct{}

func (digestCollisionStore) Create(context.Context, Record) error {
	return ErrDigestExists
}

func (digestCollisionStore) Consume(context.Context, ConsumeRequest) (Record, error) {
	return Record{}, ErrCodeUnavailable
}

func newTestService(t *testing.T, store Store, now time.Time, random io.Reader) *Service {
	t.Helper()
	service, err := newService(store, Options{}, random, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func validBinding() Binding {
	return Binding{OperatorID: "operator-a", SessionID: "session-a"}
}

func validClaims() Claims {
	return Claims{
		OperatorID: "operator-a", SessionID: "session-a", PlayerID: "player-a",
		WalletSessionID: "wallet-session-a", GameID: "iron-colossus",
		DefinitionVersion: "math-2026.07.1", DefinitionHash: strings.Repeat("a", 64),
		RequestFingerprint: strings.Repeat("b", 64),
		Currency:           "EUR", CurrencyExponent: 2, Jurisdiction: "GB",
	}
}
