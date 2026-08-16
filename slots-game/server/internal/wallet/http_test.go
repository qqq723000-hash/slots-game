package wallet

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"slots-game/server/internal/operator"
	"slots-game/server/internal/rgs"
)

func TestDecodeStrictObjectRejectsDuplicateAndUnknownWalletFields(t *testing.T) {
	for _, encoded := range []string{
		`{"status":"SUCCEEDED","status":"FAILED"}`,
		`{"status":"SUCCEEDED","unexpected":true}`,
		`[{"status":"SUCCEEDED"}]`,
		`{"status":"SUCCEEDED"} {}`,
	} {
		var response walletResponse
		if err := decodeStrictObject([]byte(encoded), &response); err == nil {
			t.Fatalf("unsafe wallet response unexpectedly accepted: %s", encoded)
		}
	}
}

func TestSecureHTTPClientBoundsConnectionsPerWalletHost(t *testing.T) {
	client := SecureHTTPClient(3 * time.Second)
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport type = %T, want *http.Transport", client.Transport)
	}
	if transport.MaxConnsPerHost != 32 {
		t.Fatalf("MaxConnsPerHost = %d, want 32", transport.MaxConnsPerHost)
	}
	if transport.MaxResponseHeaderBytes != 32<<10 {
		t.Fatalf(
			"MaxResponseHeaderBytes = %d, want %d",
			transport.MaxResponseHeaderBytes,
			32<<10,
		)
	}
	if !transport.DisableCompression {
		t.Fatal("wallet transport must not negotiate transparent response compression")
	}
	if transport.MaxIdleConnsPerHost > transport.MaxConnsPerHost {
		t.Fatalf(
			"idle connections per host = %d, exceeds hard connection cap %d",
			transport.MaxIdleConnsPerHost,
			transport.MaxConnsPerHost,
		)
	}
}

func TestHTTPWalletSignsAndReplaysOneEconomicOperation(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	requestPublic, requestPrivate, _ := ed25519.GenerateKey(rand.Reader)
	responsePublic, responsePrivate, _ := ed25519.GenerateKey(rand.Reader)
	requestKey := operator.SigningKey{
		KeyID: "rgs-request-1", OperatorID: "operator-a",
		Purpose: operator.KeyPurposeHTTPRequest, PrivateKey: requestPrivate,
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
	}
	responseKey := operator.SigningKey{
		KeyID: "wallet-response-1", OperatorID: "operator-a",
		Purpose: operator.KeyPurposeHTTPResponse, PrivateKey: responsePrivate,
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
	}
	ring, err := operator.NewMemoryKeyRing(
		operator.VerificationKey{
			KeyID: requestKey.KeyID, OperatorID: "operator-a",
			Purpose: operator.KeyPurposeHTTPRequest, PublicKey: requestPublic,
			NotBefore: requestKey.NotBefore, NotAfter: requestKey.NotAfter,
		},
		operator.VerificationKey{
			KeyID: responseKey.KeyID, OperatorID: "operator-a",
			Purpose: operator.KeyPurposeHTTPResponse, PublicKey: responsePublic,
			NotBefore: responseKey.NotBefore, NotAfter: responseKey.NotAfter,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	nonces := operator.NewMemoryNonceStore()
	requestVerifier, _ := operator.NewRequestVerifier(ring, nonces, operator.RequestVerifierOptions{
		Now: func() time.Time { return time.Now().UTC() },
	})
	responseVerifier, _ := operator.NewResponseVerifier(ring, operator.RequestVerifierOptions{
		Now: func() time.Time { return time.Now().UTC() },
	})
	var mu sync.Mutex
	applies := make(map[string]walletResponse)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		verified, verifyErr := requestVerifier.Verify(request.Context(), request, body)
		if verifyErr != nil {
			http.Error(w, verifyErr.Error(), http.StatusUnauthorized)
			return
		}
		var payload roundRequest
		if err := json.Unmarshal(body, &payload); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		mu.Lock()
		reply, exists := applies[payload.OperationID]
		if !exists {
			reply = walletResponse{
				Status: "SUCCEEDED", OperationID: payload.OperationID,
				Fingerprint: payload.Fingerprint, TransactionID: "wallet-tx-1",
				OperatorID: payload.OperatorID, Currency: payload.Currency,
				DebitMinor: payload.DebitMinor, CreditMinor: payload.CreditMinor,
				BalanceMinor: strconv.FormatInt(9_950, 10),
			}
			applies[payload.OperationID] = reply
		}
		mu.Unlock()
		encoded, _ := json.Marshal(reply)
		response := &http.Response{StatusCode: http.StatusOK, Header: w.Header()}
		_ = operator.SignResponse(response, encoded, responseKey, operator.ResponseSignatureParams{
			RequestID: verified.RequestID, Created: time.Now().UTC(), Expires: time.Now().UTC().Add(time.Minute),
		})
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(encoded)
	}))
	defer server.Close()
	httpWallet, err := NewHTTPWallet(HTTPConfig{
		BaseURL: server.URL, OperatorID: "operator-a", RequestSigningKey: requestKey,
		ResponseVerifier: responseVerifier, Client: server.Client(),
		AllowInsecureDevelopment: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	command := rgs.WalletRound{
		OperationID: "operation-1", Fingerprint: "rgs-fp-v2:abc",
		OperatorID: "operator-a", PlayerID: "player-a",
		WalletAccountID: "wallet-a", SessionID: "session-a", RoundID: "round-a",
		GameID: "game-a", DefinitionVersion: "math-v1",
		DefinitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RoundKind:      rgs.RoundKindBase, Currency: "USD", DebitMinor: 100, CreditMinor: 50,
	}
	first, err := httpWallet.ApplyRound(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	second, err := httpWallet.ApplyRound(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || first.BalanceMinor != 9_950 {
		t.Fatalf("receipts differ: %+v %+v", first, second)
	}
	mu.Lock()
	if len(applies) != 1 {
		t.Fatalf("economic operations = %d", len(applies))
	}
	mu.Unlock()
}

func TestHTTPWalletLookupMapsSignedConflictToIdempotencyConflict(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	_, requestPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	responsePublic, responsePrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	requestKey := operator.SigningKey{
		KeyID: "rgs-request-1", OperatorID: "operator-a",
		Purpose: operator.KeyPurposeHTTPRequest, PrivateKey: requestPrivate,
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
	}
	responseKey := operator.SigningKey{
		KeyID: "wallet-response-1", OperatorID: "operator-a",
		Purpose: operator.KeyPurposeHTTPResponse, PrivateKey: responsePrivate,
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
	}
	ring, err := operator.NewMemoryKeyRing(operator.VerificationKey{
		KeyID: responseKey.KeyID, OperatorID: responseKey.OperatorID,
		Purpose: responseKey.Purpose, PublicKey: responsePublic,
		NotBefore: responseKey.NotBefore, NotAfter: responseKey.NotAfter,
	})
	if err != nil {
		t.Fatal(err)
	}
	responseVerifier, err := operator.NewResponseVerifier(ring, operator.RequestVerifierOptions{})
	if err != nil {
		t.Fatal(err)
	}

	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/wallet/v1/transactions/status" {
			http.Error(writer, "unexpected request", http.StatusNotFound)
			return
		}
		body := []byte(`{"status":"CONFLICT","code":"IDEMPOTENCY_CONFLICT"}`)
		response := &http.Response{StatusCode: http.StatusConflict, Header: writer.Header()}
		if err := operator.SignResponse(response, body, responseKey, operator.ResponseSignatureParams{
			RequestID: request.Header.Get(operator.HeaderRequestID),
			Created:   now, Expires: now.Add(time.Minute),
		}); err != nil {
			t.Errorf("sign response: %v", err)
			return
		}
		writer.WriteHeader(http.StatusConflict)
		_, _ = writer.Write(body)
	}))
	defer server.Close()

	httpWallet, err := NewHTTPWallet(HTTPConfig{
		BaseURL: server.URL, OperatorID: "operator-a", RequestSigningKey: requestKey,
		ResponseVerifier: responseVerifier, Client: server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	receipt, found, err := httpWallet.Lookup(context.Background(), "operator-a", "operation-1")
	if !errors.Is(err, rgs.ErrIdempotencyConflict) {
		t.Fatalf("Lookup error = %v, want ErrIdempotencyConflict", err)
	}
	if found || receipt != (rgs.WalletReceipt{}) {
		t.Fatalf("Lookup returned receipt=%+v found=%t for conflict", receipt, found)
	}
}
