package operator

import (
	"bytes"
	"context"
	"crypto/ed25519"
	cryptorand "crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestRequestSignatureVerifiesAndRejectsReplay(t *testing.T) {
	now := fixedTestTime()
	signing, verification := testKeyPair(t, "http-key-1", "operator-a", KeyPurposeHTTPRequest, now)
	ring, err := NewMemoryKeyRing(verification)
	if err != nil {
		t.Fatalf("NewMemoryKeyRing: %v", err)
	}
	nonces := newMemoryNonceStore(func() time.Time { return now })
	verifier := testRequestVerifier(t, ring, nonces, now)
	body := []byte(`{"amount":{"currency":"EUR","minor":"100"}}`)
	request := signedTestRequest(t, signing, now, testNonce(1), body)

	principal, err := verifier.Verify(context.Background(), request, body)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if principal.OperatorID != "operator-a" || principal.KeyID != "http-key-1" ||
		principal.RequestID != "request-1" || principal.IdempotencyKey != "idem-1" {
		t.Fatalf("verified request = %+v", principal)
	}
	if _, err := verifier.Verify(context.Background(), request, body); !errors.Is(err, ErrReplay) {
		t.Fatalf("replay error = %v, want ErrReplay", err)
	}
}

func TestRequestAuthenticationDefersNonceConsumption(t *testing.T) {
	now := fixedTestTime()
	signing, verification := testKeyPair(t, "http-key-1", "operator-a", KeyPurposeHTTPRequest, now)
	ring, err := NewMemoryKeyRing(verification)
	if err != nil {
		t.Fatalf("NewMemoryKeyRing: %v", err)
	}
	verifier := testRequestVerifier(t, ring, newMemoryNonceStore(func() time.Time { return now }), now)
	body := []byte(`{"roundId":"round-1"}`)
	request := signedTestRequest(t, signing, now, testNonce(2), body)

	first, err := verifier.Authenticate(context.Background(), request, body)
	if err != nil {
		t.Fatalf("first Authenticate: %v", err)
	}
	if _, err := verifier.Authenticate(context.Background(), request, body); err != nil {
		t.Fatalf("Authenticate consumed nonce: %v", err)
	}
	if err := verifier.ConsumeNonce(context.Background(), first); err != nil {
		t.Fatalf("first ConsumeNonce: %v", err)
	}
	if err := verifier.ConsumeNonce(context.Background(), first); !errors.Is(err, ErrReplay) {
		t.Fatalf("second ConsumeNonce error = %v, want ErrReplay", err)
	}
}

type recordingNonceStore struct {
	expiresAt time.Time
}

func (store *recordingNonceStore) Consume(_ context.Context, _, _ string, expiresAt time.Time) (bool, error) {
	store.expiresAt = expiresAt
	return true, nil
}

func TestConsumeNonceRetentionCoversApplicationAndDatabaseClockSkew(t *testing.T) {
	now := fixedTestTime()
	skew := 30 * time.Second
	signing, verification := testKeyPair(t, "http-key-1", "operator-a", KeyPurposeHTTPRequest, now)
	ring, err := NewMemoryKeyRing(verification)
	if err != nil {
		t.Fatal(err)
	}
	store := &recordingNonceStore{}
	verifier, err := NewRequestVerifier(ring, store, RequestVerifierOptions{
		Now: func() time.Time { return now }, ClockSkew: skew, MaxLifetime: DefaultSignatureLifetime,
	})
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"roundId":"round-1"}`)
	request := signedTestRequest(t, signing, now, testNonce(4), body)
	verified, err := verifier.Authenticate(context.Background(), request, body)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifier.ConsumeNonce(context.Background(), verified); err != nil {
		t.Fatal(err)
	}
	want := verified.Expires.Add(2 * skew)
	if !store.expiresAt.Equal(want) {
		t.Fatalf("nonce retention deadline = %s, want %s", store.expiresAt, want)
	}
}

func TestConsumeNonceRejectsForgedMutatedOrCrossVerifierAuthentication(t *testing.T) {
	now := fixedTestTime()
	signing, verification := testKeyPair(t, "http-key-1", "operator-a", KeyPurposeHTTPRequest, now)
	ring, err := NewMemoryKeyRing(verification)
	if err != nil {
		t.Fatalf("NewMemoryKeyRing: %v", err)
	}
	verifier := testRequestVerifier(t, ring, newMemoryNonceStore(func() time.Time { return now }), now)
	other := testRequestVerifier(t, ring, newMemoryNonceStore(func() time.Time { return now }), now)
	body := []byte(`{"roundId":"round-1"}`)
	verified, err := verifier.Authenticate(
		context.Background(),
		signedTestRequest(t, signing, now, testNonce(3), body),
		body,
	)
	if err != nil {
		t.Fatal(err)
	}

	if err := other.ConsumeNonce(context.Background(), verified); !errors.Is(err, ErrMalformed) {
		t.Fatalf("cross-verifier ConsumeNonce error = %v, want ErrMalformed", err)
	}
	mutated := verified
	mutated.OperatorID = "operator-b"
	if err := verifier.ConsumeNonce(context.Background(), mutated); !errors.Is(err, ErrMalformed) {
		t.Fatalf("mutated ConsumeNonce error = %v, want ErrMalformed", err)
	}
	if err := verifier.ConsumeNonce(context.Background(), VerifiedRequest{
		OperatorID: "operator-a", KeyID: "http-key-1", RequestID: "request-1",
		IdempotencyKey: "idem-1", Nonce: testNonce(3), Created: now, Expires: now.Add(time.Minute),
	}); !errors.Is(err, ErrMalformed) {
		t.Fatalf("forged ConsumeNonce error = %v, want ErrMalformed", err)
	}
	if err := verifier.ConsumeNonce(context.Background(), verified); err != nil {
		t.Fatalf("original authenticated request rejected after forged attempts: %v", err)
	}
}

func TestRequestSignatureRejectsCoveredComponentTampering(t *testing.T) {
	now := fixedTestTime()
	signing, verification := testKeyPair(t, "http-key-1", "operator-a", KeyPurposeHTTPRequest, now)
	body := []byte(`{"roundId":"round-1","minor":"100"}`)

	tests := []struct {
		name   string
		mutate func(*signedRequestFixture)
	}{
		{name: "body", mutate: func(f *signedRequestFixture) { f.body = []byte(`{"roundId":"round-1","minor":"101"}`) }},
		{name: "method", mutate: func(f *signedRequestFixture) { f.request.Method = "PUT" }},
		{name: "authority", mutate: func(f *signedRequestFixture) { f.request.Host = "other.example" }},
		{name: "path", mutate: func(f *signedRequestFixture) { f.request.URL.Path = "/wallet/v1/wins/credit" }},
		{name: "content digest", mutate: func(f *signedRequestFixture) {
			f.request.Header.Set(HeaderContentDigest, makeContentDigest([]byte("other")))
		}},
		{name: "content type", mutate: func(f *signedRequestFixture) { f.request.Header.Set("Content-Type", "application/problem+json") }},
		{name: "operator", mutate: func(f *signedRequestFixture) { f.request.Header.Set(HeaderOperatorID, "operator-b") }},
		{name: "request id", mutate: func(f *signedRequestFixture) { f.request.Header.Set(HeaderRequestID, "request-other") }},
		{name: "nonce", mutate: func(f *signedRequestFixture) { f.request.Header.Set(HeaderNonce, testNonce(99)) }},
		{name: "idempotency", mutate: func(f *signedRequestFixture) { f.request.Header.Set(HeaderIdempotencyKey, "idem-other") }},
		{name: "signature input", mutate: func(f *signedRequestFixture) {
			value := f.request.Header.Get(HeaderSignatureInput)
			f.request.Header.Set(HeaderSignatureInput, value[:len(value)-1]+"0")
		}},
	}

	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ring, err := NewMemoryKeyRing(verification)
			if err != nil {
				t.Fatalf("NewMemoryKeyRing: %v", err)
			}
			verifier := testRequestVerifier(t, ring, newMemoryNonceStore(func() time.Time { return now }), now)
			fixture := signedRequestFixture{
				request: signedTestRequest(t, signing, now, testNonce(byte(index+2)), body),
				body:    append([]byte(nil), body...),
			}
			test.mutate(&fixture)
			if _, err := verifier.Verify(context.Background(), fixture.request, fixture.body); err == nil {
				t.Fatal("tampered request unexpectedly verified")
			}
		})
	}
}

func TestRequestSignatureRejectsExpiredFutureAndNonProfileRequests(t *testing.T) {
	now := fixedTestTime()
	signing, verification := testKeyPair(t, "http-key-1", "operator-a", KeyPurposeHTTPRequest, now)
	ring, err := NewMemoryKeyRing(verification)
	if err != nil {
		t.Fatalf("NewMemoryKeyRing: %v", err)
	}
	body := []byte(`{"roundId":"round-1"}`)

	t.Run("expired", func(t *testing.T) {
		request := unsignedTestRequest(body)
		if err := SignRequest(request, body, signing, RequestSignatureParams{
			RequestID: "expired-request", IdempotencyKey: "expired-idem", Nonce: testNonce(31),
			Created: now.Add(-4 * time.Minute), Expires: now.Add(-time.Minute),
		}); err != nil {
			t.Fatalf("SignRequest: %v", err)
		}
		verifier := testRequestVerifier(t, ring, newMemoryNonceStore(func() time.Time { return now }), now)
		if _, err := verifier.Verify(context.Background(), request, body); !errors.Is(err, ErrExpired) {
			t.Fatalf("expired error = %v, want ErrExpired", err)
		}
	})

	t.Run("future", func(t *testing.T) {
		request := unsignedTestRequest(body)
		if err := SignRequest(request, body, signing, RequestSignatureParams{
			RequestID: "future-request", IdempotencyKey: "future-idem", Nonce: testNonce(32),
			Created: now.Add(time.Minute), Expires: now.Add(2 * time.Minute),
		}); err != nil {
			t.Fatalf("SignRequest: %v", err)
		}
		verifier := testRequestVerifier(t, ring, newMemoryNonceStore(func() time.Time { return now }), now)
		if _, err := verifier.Verify(context.Background(), request, body); !errors.Is(err, ErrNotYetValid) {
			t.Fatalf("future error = %v, want ErrNotYetValid", err)
		}
	})

	t.Run("query is outside fixed profile", func(t *testing.T) {
		request := unsignedTestRequest(body)
		request.URL.RawQuery = "page=1"
		err := SignRequest(request, body, signing, RequestSignatureParams{
			RequestID: "query-request", IdempotencyKey: "query-idem", Nonce: testNonce(33),
			Created: now, Expires: now.Add(time.Minute),
		})
		if !errors.Is(err, ErrMalformed) {
			t.Fatalf("query signing error = %v, want ErrMalformed", err)
		}
	})

	t.Run("duplicate covered header", func(t *testing.T) {
		request := signedTestRequest(t, signing, now, testNonce(34), body)
		request.Header.Add(HeaderRequestID, "second-request")
		verifier := testRequestVerifier(t, ring, newMemoryNonceStore(func() time.Time { return now }), now)
		if _, err := verifier.Verify(context.Background(), request, body); !errors.Is(err, ErrMalformed) {
			t.Fatalf("duplicate header error = %v, want ErrMalformed", err)
		}
	})
}

func TestRequestSignatureKeyRotationAndTenantBinding(t *testing.T) {
	now := fixedTestTime()
	oldSigning, oldVerification := testKeyPair(t, "http-old", "operator-a", KeyPurposeHTTPRequest, now)
	newSigning, newVerification := testKeyPair(t, "http-new", "operator-a", KeyPurposeHTTPRequest, now)
	ring, err := NewMemoryKeyRing(oldVerification, newVerification)
	if err != nil {
		t.Fatalf("NewMemoryKeyRing: %v", err)
	}
	verifier := testRequestVerifier(t, ring, newMemoryNonceStore(func() time.Time { return now }), now)
	body := []byte(`{"roundId":"round-rotation"}`)
	if _, err := verifier.Verify(context.Background(), signedTestRequest(t, oldSigning, now, testNonce(40), body), body); err != nil {
		t.Fatalf("old key during overlap: %v", err)
	}
	if _, err := verifier.Verify(context.Background(), signedTestRequest(t, newSigning, now, testNonce(41), body), body); err != nil {
		t.Fatalf("new key during overlap: %v", err)
	}
	ring.Remove(KeyPurposeHTTPRequest, oldSigning.KeyID)
	if _, err := verifier.Verify(context.Background(), signedTestRequest(t, oldSigning, now, testNonce(42), body), body); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("retired key error = %v, want ErrUnknownKey", err)
	}

	crossTenant := signedTestRequest(t, newSigning, now, testNonce(43), body)
	crossTenant.Header.Set(HeaderOperatorID, "operator-b")
	if _, err := verifier.Verify(context.Background(), crossTenant, body); !errors.Is(err, ErrTenantMismatch) {
		t.Fatalf("cross-tenant error = %v, want ErrTenantMismatch", err)
	}
}

func TestMemoryNonceStoreConsumesConcurrentlyOnce(t *testing.T) {
	now := fixedTestTime()
	store := newMemoryNonceStore(func() time.Time { return now })
	const workers = 64
	var accepted atomic.Int32
	var wait sync.WaitGroup
	wait.Add(workers)
	for range workers {
		go func() {
			defer wait.Done()
			ok, err := store.Consume(context.Background(), "scope", testNonce(55), now.Add(time.Minute))
			if err != nil {
				t.Errorf("Consume: %v", err)
				return
			}
			if ok {
				accepted.Add(1)
			}
		}()
	}
	wait.Wait()
	if got := accepted.Load(); got != 1 {
		t.Fatalf("accepted nonce count = %d, want 1", got)
	}
}

type signedRequestFixture struct {
	request *http.Request
	body    []byte
}

func fixedTestTime() time.Time {
	return time.Date(2026, time.July, 25, 12, 0, 0, 0, time.UTC)
}

func testKeyPair(t *testing.T, keyID, operatorID string, purpose KeyPurpose, now time.Time) (SigningKey, VerificationKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(cryptorand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	notBefore, notAfter := now.Add(-24*time.Hour), now.Add(24*time.Hour)
	return SigningKey{
			KeyID: keyID, OperatorID: operatorID, Purpose: purpose,
			PrivateKey: private, NotBefore: notBefore, NotAfter: notAfter,
		}, VerificationKey{
			KeyID: keyID, OperatorID: operatorID, Purpose: purpose,
			PublicKey: public, NotBefore: notBefore, NotAfter: notAfter,
		}
}

func testRequestVerifier(t *testing.T, keys KeyResolver, nonces NonceStore, now time.Time) *RequestVerifier {
	t.Helper()
	verifier, err := NewRequestVerifier(keys, nonces, RequestVerifierOptions{
		Now: func() time.Time { return now }, MaxLifetime: DefaultSignatureLifetime,
	})
	if err != nil {
		t.Fatalf("NewRequestVerifier: %v", err)
	}
	return verifier
}

func signedTestRequest(t *testing.T, key SigningKey, now time.Time, nonce string, body []byte) *http.Request {
	t.Helper()
	request := unsignedTestRequest(body)
	if err := SignRequest(request, body, key, RequestSignatureParams{
		RequestID: "request-1", IdempotencyKey: "idem-1", Nonce: nonce,
		Created: now, Expires: now.Add(time.Minute),
	}); err != nil {
		t.Fatalf("SignRequest: %v", err)
	}
	return request
}

func unsignedTestRequest(body []byte) *http.Request {
	return httptest.NewRequest("POST", "https://wallet.example/wallet/v1/wagers/reserve", bytes.NewReader(body))
}

func testNonce(value byte) string {
	return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{value}, 16))
}
