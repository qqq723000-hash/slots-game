package operator

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net/http"
	"testing"
	"time"
)

func TestSignedResponseBindsStatusBodyRequestAndTenant(t *testing.T) {
	now := time.Unix(1_800_000_000, 0).UTC()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signing := SigningKey{
		KeyID: "wallet-response-1", OperatorID: "operator-a",
		Purpose: KeyPurposeHTTPResponse, PrivateKey: private,
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
	}
	ring, err := NewMemoryKeyRing(VerificationKey{
		KeyID: signing.KeyID, OperatorID: signing.OperatorID,
		Purpose: KeyPurposeHTTPResponse, PublicKey: public,
		NotBefore: signing.NotBefore, NotAfter: signing.NotAfter,
	})
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := NewResponseVerifier(ring, RequestVerifierOptions{Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"status":"SUCCEEDED"}`)
	response := &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: ioNopCloser(body)}
	if err := SignResponse(response, body, signing, ResponseSignatureParams{
		RequestID: "request-1", Created: now, Expires: now.Add(time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	if err := verifier.Verify(context.Background(), response, body, "operator-a", "request-1"); err != nil {
		t.Fatalf("valid response rejected: %v", err)
	}
	if err := verifier.Verify(context.Background(), response, []byte(`{"status":"FAILED"}`), "operator-a", "request-1"); !errors.Is(err, ErrContentDigest) {
		t.Fatalf("body tamper error = %v", err)
	}
	response.StatusCode = http.StatusCreated
	if err := verifier.Verify(context.Background(), response, body, "operator-a", "request-1"); !errors.Is(err, ErrSignatureInvalid) {
		t.Fatalf("status tamper error = %v", err)
	}
	response.StatusCode = http.StatusOK
	if err := verifier.Verify(context.Background(), response, body, "operator-b", "request-1"); !errors.Is(err, ErrTenantMismatch) {
		t.Fatalf("tenant mismatch error = %v", err)
	}
}

func ioNopCloser(body []byte) *nopCloser {
	return &nopCloser{Reader: bytes.NewReader(body)}
}

type nopCloser struct {
	*bytes.Reader
}

func (n *nopCloser) Close() error { return nil }
