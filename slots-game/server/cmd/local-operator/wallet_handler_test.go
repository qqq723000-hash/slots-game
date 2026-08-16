package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"slots-game/server/internal/operator"
)

func TestWalletApplyIsSignedAndIdempotent(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	requestKey, requestVerification := testSigningPair(t, "rgs-wallet-request", operator.KeyPurposeHTTPRequest, now)
	responseKey, responseVerification := testSigningPair(t, "operator-wallet-response", operator.KeyPurposeHTTPResponse, now)
	store := newMemoryWalletStore(10_000)
	handler := testWalletHandler(t, store, requestVerification, responseKey, now)

	payload := roundRequest{
		OperationID: "operation-1", Fingerprint: "rgs-fp-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", OperatorID: "local-operator",
		PlayerID: "player-1", WalletAccountID: "wallet-1", SessionID: "session-1",
		RoundID: "round-1", GameID: "iron-colossus", DefinitionVersion: "math-v1",
		DefinitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RoundKind:      "BASE", Currency: "CNY", DebitMinor: "100", CreditMinor: "50",
	}
	first := signedWalletCall(t, handler, requestKey, payload.OperationID, payload, 1, now)
	second := signedWalletCall(t, handler, requestKey, payload.OperationID, payload, 2, now)
	if first.Code != http.StatusOK || second.Code != http.StatusOK {
		t.Fatalf("apply statuses = %d, %d", first.Code, second.Code)
	}

	verifier := testResponseVerifier(t, responseVerification, now)
	firstBody := first.Body.Bytes()
	if err := verifier.Verify(context.Background(), first.Result(), firstBody, "local-operator", "request-1"); err != nil {
		t.Fatalf("verify wallet response: %v", err)
	}
	var decoded walletResponse
	if err := json.Unmarshal(firstBody, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Status != "SUCCEEDED" || decoded.BalanceMinor != "9950" {
		t.Fatalf("wallet response = %+v", decoded)
	}
	if balance, applies := store.snapshot(); balance != 9_950 || applies != 1 {
		t.Fatalf("store state = balance:%d applies:%d", balance, applies)
	}
}

func TestWalletApplyRejectsOperationIdentityConflict(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	requestKey, requestVerification := testSigningPair(t, "rgs-wallet-request", operator.KeyPurposeHTTPRequest, now)
	responseKey, _ := testSigningPair(t, "operator-wallet-response", operator.KeyPurposeHTTPResponse, now)
	store := newMemoryWalletStore(10_000)
	handler := testWalletHandler(t, store, requestVerification, responseKey, now)
	payload := roundRequest{
		OperationID: "operation-1", Fingerprint: "rgs-fp-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", OperatorID: "local-operator",
		PlayerID: "player-1", WalletAccountID: "wallet-1", SessionID: "session-1",
		RoundID: "round-1", GameID: "iron-colossus", DefinitionVersion: "math-v1",
		DefinitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RoundKind:      "BASE", Currency: "CNY", DebitMinor: "100", CreditMinor: "50",
	}
	if got := signedWalletCall(t, handler, requestKey, payload.OperationID, payload, 3, now).Code; got != http.StatusOK {
		t.Fatalf("first apply status = %d", got)
	}
	payload.CreditMinor = "51"
	if got := signedWalletCall(t, handler, requestKey, payload.OperationID, payload, 4, now).Code; got != http.StatusConflict {
		t.Fatalf("conflicting apply status = %d", got)
	}
	if balance, applies := store.snapshot(); balance != 9_950 || applies != 1 {
		t.Fatalf("conflict changed funds = balance:%d applies:%d", balance, applies)
	}
}

func TestWalletRejectsSignatureReplayBeforeStoreSideEffect(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	requestKey, requestVerification := testSigningPair(t, "rgs-wallet-request", operator.KeyPurposeHTTPRequest, now)
	responseKey, _ := testSigningPair(t, "operator-wallet-response", operator.KeyPurposeHTTPResponse, now)
	store := newMemoryWalletStore(10_000)
	handler := testWalletHandler(t, store, requestVerification, responseKey, now)
	payload := roundRequest{
		OperationID: "operation-1", Fingerprint: "rgs-fp-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", OperatorID: "local-operator",
		PlayerID: "player-1", WalletAccountID: "wallet-1", SessionID: "session-1",
		RoundID: "round-1", GameID: "iron-colossus", DefinitionVersion: "math-v1",
		DefinitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RoundKind:      "BASE", Currency: "CNY", DebitMinor: "100", CreditMinor: "50",
	}
	body, _ := json.Marshal(payload)
	request := httptest.NewRequest(http.MethodPost, "https://operator.local/rgs/wallet/v1/rounds/apply", bytes.NewReader(body))
	nonce := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x45}, 24))
	if err := operator.SignRequest(request, body, requestKey, operator.RequestSignatureParams{
		RequestID: "request-replay", IdempotencyKey: payload.OperationID, Nonce: nonce,
		Created: now, Expires: now.Add(time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	first := httptest.NewRecorder()
	handler.ServeHTTP(first, request.Clone(context.Background()))
	replayed := httptest.NewRequest(http.MethodPost, request.URL.String(), bytes.NewReader(body))
	replayed.Header = request.Header.Clone()
	second := httptest.NewRecorder()
	handler.ServeHTTP(second, replayed)
	if first.Code != http.StatusOK || second.Code != http.StatusUnauthorized {
		t.Fatalf("replay statuses = %d, %d", first.Code, second.Code)
	}
	if _, applies := store.snapshot(); applies != 1 {
		t.Fatalf("economic applies = %d", applies)
	}
}

type memoryWalletStore struct {
	mu         sync.Mutex
	balance    int64
	operations map[string]storedOperation
	applies    int
}

func newMemoryWalletStore(balance int64) *memoryWalletStore {
	return &memoryWalletStore{balance: balance, operations: make(map[string]storedOperation)}
}

func (s *memoryWalletStore) Apply(_ context.Context, request validatedRound) (storedOperation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.operations[request.OperationID]; ok {
		if existing.RequestDigest != request.RequestDigest {
			return storedOperation{}, errIdempotencyConflict
		}
		return existing, nil
	}
	if request.Debit > s.balance+request.Credit {
		return storedOperation{}, errInsufficientFunds
	}
	s.balance = s.balance - request.Debit + request.Credit
	stored := newStoredOperation(request, "wallet-tx-1", s.balance)
	s.operations[request.OperationID] = stored
	s.applies++
	return stored, nil
}

func (s *memoryWalletStore) Lookup(_ context.Context, operatorID, operationID string) (storedOperation, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	operation, ok := s.operations[operationID]
	return operation, ok && operation.OperatorID == operatorID, nil
}

func (s *memoryWalletStore) Rollback(context.Context, validatedRollback) (storedOperation, error) {
	return storedOperation{}, errOperationNotFound
}

func (s *memoryWalletStore) EnsureAccount(context.Context, accountSeed) error { return nil }
func (s *memoryWalletStore) Ping(context.Context) error                       { return nil }

func (s *memoryWalletStore) snapshot() (int64, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.balance, s.applies
}

func testWalletHandler(
	t *testing.T,
	store walletStore,
	requestKey operator.VerificationKey,
	responseKey operator.SigningKey,
	now time.Time,
) http.Handler {
	t.Helper()
	ring, err := operator.NewMemoryKeyRing(requestKey)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := operator.NewRequestVerifier(ring, operator.NewMemoryNonceStore(), operator.RequestVerifierOptions{
		Now: func() time.Time { return now }, ClockSkew: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	return newWalletHandler(walletHandlerConfig{
		OperatorID: "local-operator", Store: store, Verifier: verifier,
		ResponseSigningKey: responseKey, Now: func() time.Time { return now }, Metrics: &serviceMetrics{},
	})
}

func signedWalletCall(
	t *testing.T,
	handler http.Handler,
	key operator.SigningKey,
	idempotencyKey string,
	payload any,
	nonceByte byte,
	now time.Time,
) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	requestID := "request-" + string(rune('0'+nonceByte))
	request := httptest.NewRequest(http.MethodPost, "https://operator.local/rgs/wallet/v1/rounds/apply", bytes.NewReader(body))
	if err := operator.SignRequest(request, body, key, operator.RequestSignatureParams{
		RequestID: requestID, IdempotencyKey: idempotencyKey,
		Nonce:   base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{nonceByte}, 24)),
		Created: now, Expires: now.Add(time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func testSigningPair(
	t *testing.T,
	keyID string,
	purpose operator.KeyPurpose,
	now time.Time,
) (operator.SigningKey, operator.VerificationKey) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signing := operator.SigningKey{
		KeyID: keyID, OperatorID: "local-operator", Purpose: purpose,
		PrivateKey: privateKey, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
	}
	verification := operator.VerificationKey{
		KeyID: keyID, OperatorID: "local-operator", Purpose: purpose,
		PublicKey: publicKey, NotBefore: signing.NotBefore, NotAfter: signing.NotAfter,
	}
	return signing, verification
}

func testResponseVerifier(t *testing.T, key operator.VerificationKey, now time.Time) *operator.ResponseVerifier {
	t.Helper()
	ring, err := operator.NewMemoryKeyRing(key)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := operator.NewResponseVerifier(ring, operator.RequestVerifierOptions{
		Now: func() time.Time { return now }, ClockSkew: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	return verifier
}
