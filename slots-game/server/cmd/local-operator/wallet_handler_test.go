package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"slots-game/server/internal/operator"
	"slots-game/server/internal/rgs"
)

func TestCheckedBalanceDebitsStartingBalanceBeforeApplyingCredit(t *testing.T) {
	if _, err := checkedBalance(0, 100, 100); !errors.Is(err, errInsufficientFunds) {
		t.Fatalf("zero-balance winning round error = %v, want insufficient funds", err)
	}
	afterRound, err := checkedBalance(100, 100, 250)
	if err != nil || afterRound != 250 {
		t.Fatalf("winning round balance = %d, %v", afterRound, err)
	}
	restored, err := checkedBalance(afterRound, 250, 100)
	if err != nil || restored != 100 {
		t.Fatalf("rollback balance = %d, %v", restored, err)
	}
	if _, err := checkedBalance(200, 250, 100); !errors.Is(err, errInsufficientFunds) {
		t.Fatalf("underfunded rollback error = %v, want insufficient funds", err)
	}
	if _, err := checkedBalance(math.MaxInt64, 1, 2); err == nil || errors.Is(err, errInsufficientFunds) {
		t.Fatalf("overflow error = %v", err)
	}
}

func TestWalletApplyIsSignedAndIdempotent(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	requestKey, requestVerification := testSigningPair(t, "rgs-wallet-request", operator.KeyPurposeHTTPRequest, now)
	responseKey, responseVerification := testSigningPair(t, "operator-wallet-response", operator.KeyPurposeHTTPResponse, now)
	store := newMemoryWalletStore(10_000)
	handler := testWalletHandler(t, store, requestVerification, responseKey, now)

	payload := bindWalletV2(t, roundRequest{
		OperationID: "operation-1", Fingerprint: "rgs-fp-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", OperatorID: "local-operator",
		PlayerID: "player-1", WalletAccountID: "wallet-1", WalletSessionRef: "wallet-session-1", SessionID: "session-1",
		RoundID: "round-1", GameID: "iron-colossus", DefinitionVersion: "math-v1",
		DefinitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RoundKind:      "BASE", Currency: "CNY", DebitMinor: "100", CreditMinor: "50",
	})
	registerMemoryWalletSession(t, store, payload)
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
	if decoded.Status != "SUCCEEDED" || decoded.BalanceMinor != "9950" ||
		decoded.CommandDigest != payload.CommandDigest {
		t.Fatalf("wallet response = %+v", decoded)
	}
	if balance, applies := store.snapshot(); balance != 9_950 || applies != 1 {
		t.Fatalf("store state = balance:%d applies:%d", balance, applies)
	}
}

func TestWalletRollbackResponseBindsRollbackAndOriginalCommand(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	requestKey, requestVerification := testSigningPair(t, "rgs-wallet-request", operator.KeyPurposeHTTPRequest, now)
	responseKey, responseVerification := testSigningPair(t, "operator-wallet-response", operator.KeyPurposeHTTPResponse, now)
	store := newMemoryWalletStore(10_000)
	handler := testWalletHandler(t, store, requestVerification, responseKey, now)
	apply := bindWalletV2(t, roundRequest{
		OperationID: "operation-rollback", Fingerprint: "rgs-fp-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		OperatorID: "local-operator", PlayerID: "player-1", WalletAccountID: "wallet-1",
		WalletSessionRef: "wallet-session-1", SessionID: "session-1", RoundID: "round-1",
		GameID: "iron-colossus", DefinitionVersion: "math-v1",
		DefinitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RoundKind:      "BASE", Currency: "CNY", DebitMinor: "100", CreditMinor: "50",
	})
	registerMemoryWalletSession(t, store, apply)
	if got := signedWalletCall(t, handler, requestKey, apply.OperationID, apply, 8, now).Code; got != http.StatusOK {
		t.Fatalf("apply status = %d", got)
	}
	rollback := rollbackRequest{
		OperatorID: "local-operator", OperationID: apply.OperationID,
		RollbackID: "rollback-1", Reason: "approved operator reconciliation",
	}
	response := signedWalletCall(t, handler, requestKey, rollback.RollbackID, rollback, 9, now)
	if response.Code != http.StatusOK {
		t.Fatalf("rollback status = %d body=%s", response.Code, response.Body.String())
	}
	body := response.Body.Bytes()
	if err := testResponseVerifier(t, responseVerification, now).Verify(
		context.Background(), response.Result(), body, "local-operator", "request-9",
	); err != nil {
		t.Fatalf("verify rollback response: %v", err)
	}
	var decoded walletResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Status != "ROLLED_BACK" || decoded.OperatorID != rollback.OperatorID ||
		decoded.OperationID != rollback.OperationID || decoded.RollbackID != rollback.RollbackID ||
		decoded.CommandDigest != apply.CommandDigest {
		t.Fatalf("rollback response binding = %+v", decoded)
	}
}

func TestWalletApplyRejectsOperationIdentityConflict(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	requestKey, requestVerification := testSigningPair(t, "rgs-wallet-request", operator.KeyPurposeHTTPRequest, now)
	responseKey, _ := testSigningPair(t, "operator-wallet-response", operator.KeyPurposeHTTPResponse, now)
	store := newMemoryWalletStore(10_000)
	handler := testWalletHandler(t, store, requestVerification, responseKey, now)
	payload := bindWalletV2(t, roundRequest{
		OperationID: "operation-1", Fingerprint: "rgs-fp-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", OperatorID: "local-operator",
		PlayerID: "player-1", WalletAccountID: "wallet-1", WalletSessionRef: "wallet-session-1", SessionID: "session-1",
		RoundID: "round-1", GameID: "iron-colossus", DefinitionVersion: "math-v1",
		DefinitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RoundKind:      "BASE", Currency: "CNY", DebitMinor: "100", CreditMinor: "50",
	})
	registerMemoryWalletSession(t, store, payload)
	if got := signedWalletCall(t, handler, requestKey, payload.OperationID, payload, 3, now).Code; got != http.StatusOK {
		t.Fatalf("first apply status = %d", got)
	}
	payload.CreditMinor = "51"
	payload = bindWalletV2(t, payload)
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
	payload := bindWalletV2(t, roundRequest{
		OperationID: "operation-1", Fingerprint: "rgs-fp-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", OperatorID: "local-operator",
		PlayerID: "player-1", WalletAccountID: "wallet-1", WalletSessionRef: "wallet-session-1", SessionID: "session-1",
		RoundID: "round-1", GameID: "iron-colossus", DefinitionVersion: "math-v1",
		DefinitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RoundKind:      "BASE", Currency: "CNY", DebitMinor: "100", CreditMinor: "50",
	})
	registerMemoryWalletSession(t, store, payload)
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

func TestWalletV2RejectsMissingOrPartialBindingBeforeStoreSideEffect(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	requestKey, requestVerification := testSigningPair(t, "rgs-wallet-request", operator.KeyPurposeHTTPRequest, now)
	responseKey, _ := testSigningPair(t, "operator-wallet-response", operator.KeyPurposeHTTPResponse, now)
	base := bindWalletV2(t, roundRequest{
		OperationID: "operation-binding", Fingerprint: "rgs-fp-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		OperatorID: "local-operator", PlayerID: "player-1", WalletAccountID: "wallet-1",
		WalletSessionRef: "wallet-session-1", SessionID: "session-1", RoundID: "round-1",
		GameID: "iron-colossus", DefinitionVersion: "math-v1",
		DefinitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RoundKind:      "BASE", Currency: "CNY", DebitMinor: "100", CreditMinor: "50",
	})
	tests := []struct {
		name   string
		mutate func(*roundRequest)
	}{
		{name: "missing-session", mutate: func(value *roundRequest) { value.WalletSessionRef = "" }},
		{name: "missing-digest", mutate: func(value *roundRequest) { value.CommandDigest = "" }},
		{name: "legacy-without-opt-in", mutate: func(value *roundRequest) {
			value.WalletSessionRef = ""
			value.CommandDigest = ""
		}},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := newMemoryWalletStore(10_000)
			handler := testWalletHandler(t, store, requestVerification, responseKey, now)
			payload := base
			test.mutate(&payload)
			response := signedWalletCall(
				t, handler, requestKey, payload.OperationID, payload, byte(1+index), now,
			)
			if response.Code != http.StatusConflict {
				t.Fatalf("binding rejection status = %d", response.Code)
			}
			var conflict walletResponse
			if err := json.Unmarshal(response.Body.Bytes(), &conflict); err != nil ||
				conflict.Status != "CONFLICT" || conflict.Code != "INVALID_COMMAND_BINDING" {
				t.Fatalf("binding protocol conflict = %+v, %v", conflict, err)
			}
			if balance, applies := store.snapshot(); balance != 10_000 || applies != 0 {
				t.Fatalf("binding rejection changed store = balance:%d applies:%d", balance, applies)
			}
		})
	}
}

func TestWalletV2LookupBindsNotFoundAndRejectsPartialOrDriftedIdentity(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	requestKey, requestVerification := testSigningPair(t, "rgs-wallet-request", operator.KeyPurposeHTTPRequest, now)
	responseKey, _ := testSigningPair(t, "operator-wallet-response", operator.KeyPurposeHTTPResponse, now)
	store := newMemoryWalletStore(10_000)
	handler := testWalletHandler(t, store, requestVerification, responseKey, now)
	command := bindWalletV2(t, roundRequest{
		OperationID: "operation-lookup", Fingerprint: "rgs-fp-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		OperatorID: "local-operator", PlayerID: "player-1", WalletAccountID: "wallet-1",
		WalletSessionRef: "wallet-session-1", SessionID: "session-1", RoundID: "round-1",
		GameID: "iron-colossus", DefinitionVersion: "math-v1",
		DefinitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RoundKind:      "BASE", Currency: "CNY", DebitMinor: "100", CreditMinor: "50",
	})
	lookup := lookupRequest{
		OperatorID: command.OperatorID, OperationID: command.OperationID,
		Fingerprint: command.Fingerprint, CommandDigest: command.CommandDigest,
	}
	notFound := signedWalletCall(t, handler, requestKey, lookup.OperationID, lookup, 30, now)
	if notFound.Code != http.StatusNotFound {
		t.Fatalf("v2 lookup status = %d", notFound.Code)
	}
	var bound walletResponse
	if err := json.Unmarshal(notFound.Body.Bytes(), &bound); err != nil ||
		bound.OperatorID != lookup.OperatorID || bound.OperationID != lookup.OperationID ||
		bound.Fingerprint != lookup.Fingerprint || bound.CommandDigest != lookup.CommandDigest {
		t.Fatalf("bound NOT_FOUND = %+v error=%v", bound, err)
	}

	for index, mutate := range []func(*lookupRequest){
		func(value *lookupRequest) { value.Fingerprint = "" },
		func(value *lookupRequest) { value.CommandDigest = "" },
	} {
		partial := lookup
		mutate(&partial)
		response := signedWalletCall(t, handler, requestKey, partial.OperationID, partial, byte(31+index), now)
		if response.Code != http.StatusConflict {
			t.Fatalf("partial lookup %d status = %d", index, response.Code)
		}
	}

	registerMemoryWalletSession(t, store, command)
	if got := signedWalletCall(t, handler, requestKey, command.OperationID, command, 34, now).Code; got != http.StatusOK {
		t.Fatalf("apply status = %d", got)
	}
	drifted := lookup
	drifted.Fingerprint = "rgs-fp-v2:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if got := signedWalletCall(t, handler, requestKey, drifted.OperationID, drifted, 35, now).Code; got != http.StatusConflict {
		t.Fatalf("drifted lookup status = %d", got)
	}

	legacy := lookupRequest{OperatorID: "local-operator", OperationID: "legacy-not-found"}
	legacyResponse := signedWalletCall(t, handler, requestKey, legacy.OperationID, legacy, 36, now)
	if legacyResponse.Code != http.StatusNotFound {
		t.Fatalf("legacy lookup status = %d", legacyResponse.Code)
	}
	var legacyBody walletResponse
	if err := json.Unmarshal(legacyResponse.Body.Bytes(), &legacyBody); err != nil ||
		legacyBody.Fingerprint != "" || legacyBody.CommandDigest != "" {
		t.Fatalf("legacy lookup response expanded = %+v error=%v", legacyBody, err)
	}
}

func TestWalletV2RecomputesCommandDigestBeforeStoreSideEffect(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	requestKey, requestVerification := testSigningPair(t, "rgs-wallet-request", operator.KeyPurposeHTTPRequest, now)
	responseKey, _ := testSigningPair(t, "operator-wallet-response", operator.KeyPurposeHTTPResponse, now)
	base := bindWalletV2(t, roundRequest{
		OperationID: "operation-drift", Fingerprint: "rgs-fp-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		OperatorID: "local-operator", PlayerID: "player-1", WalletAccountID: "wallet-1",
		WalletSessionRef: "wallet-session-1", SessionID: "session-1", RoundID: "round-1",
		GameID: "iron-colossus", DefinitionVersion: "math-v1",
		DefinitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RoundKind:      "BASE", Currency: "CNY", DebitMinor: "100", CreditMinor: "50",
	})
	tests := []struct {
		name   string
		mutate func(*roundRequest)
	}{
		{name: "wallet-session", mutate: func(value *roundRequest) { value.WalletSessionRef = "wallet-session-2" }},
		{name: "credit", mutate: func(value *roundRequest) { value.CreditMinor = "51" }},
		{name: "definition", mutate: func(value *roundRequest) {
			value.DefinitionHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		}},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := newMemoryWalletStore(10_000)
			handler := testWalletHandler(t, store, requestVerification, responseKey, now)
			payload := base
			test.mutate(&payload)
			response := signedWalletCall(
				t, handler, requestKey, payload.OperationID, payload, byte(20+index), now,
			)
			if response.Code != http.StatusConflict {
				t.Fatalf("digest drift status = %d", response.Code)
			}
			var conflict walletResponse
			if err := json.Unmarshal(response.Body.Bytes(), &conflict); err != nil ||
				conflict.Status != "CONFLICT" || conflict.Code != "INVALID_COMMAND_BINDING" {
				t.Fatalf("digest protocol conflict = %+v, %v", conflict, err)
			}
			if balance, applies := store.snapshot(); balance != 10_000 || applies != 0 {
				t.Fatalf("digest drift changed store = balance:%d applies:%d", balance, applies)
			}
		})
	}
}

func TestWalletV2RejectsUnknownOrCrossBoundWalletSession(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	requestKey, requestVerification := testSigningPair(t, "rgs-wallet-request", operator.KeyPurposeHTTPRequest, now)
	responseKey, _ := testSigningPair(t, "operator-wallet-response", operator.KeyPurposeHTTPResponse, now)
	base := bindWalletV2(t, roundRequest{
		OperationID: "operation-session-binding",
		Fingerprint: "rgs-fp-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		OperatorID:  "local-operator", PlayerID: "player-1", WalletAccountID: "wallet-1",
		WalletSessionRef: "wallet-session-1", SessionID: "session-1", RoundID: "round-1",
		GameID: "iron-colossus", DefinitionVersion: "math-v1",
		DefinitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RoundKind:      "BASE", Currency: "CNY", DebitMinor: "100", CreditMinor: "50",
	})
	tests := []struct {
		name   string
		mutate func(*roundRequest)
	}{
		{name: "unknown-reference", mutate: func(value *roundRequest) {
			value.WalletSessionRef = "wallet-session-unknown"
		}},
		{name: "cross-player", mutate: func(value *roundRequest) { value.PlayerID = "player-2" }},
		{name: "cross-rgs-session", mutate: func(value *roundRequest) { value.SessionID = "session-2" }},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := newMemoryWalletStore(10_000)
			registerMemoryWalletSession(t, store, base)
			handler := testWalletHandler(t, store, requestVerification, responseKey, now)
			payload := base
			test.mutate(&payload)
			payload = bindWalletV2(t, payload)
			response := signedWalletCall(
				t, handler, requestKey, payload.OperationID, payload, byte(30+index), now,
			)
			if response.Code != http.StatusUnprocessableEntity {
				t.Fatalf("wallet session binding status = %d", response.Code)
			}
			var rejected walletResponse
			if err := json.Unmarshal(response.Body.Bytes(), &rejected); err != nil ||
				rejected.Code != "WALLET_SESSION_INVALID" {
				t.Fatalf("wallet session rejection = %+v, %v", rejected, err)
			}
			if balance, applies := store.snapshot(); balance != 10_000 || applies != 0 {
				t.Fatalf("wallet session rejection changed store = balance:%d applies:%d", balance, applies)
			}
		})
	}
}

func TestWalletV2RejectsSignedBodyTamperingBeforeStoreSideEffect(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	requestKey, requestVerification := testSigningPair(t, "rgs-wallet-request", operator.KeyPurposeHTTPRequest, now)
	responseKey, _ := testSigningPair(t, "operator-wallet-response", operator.KeyPurposeHTTPResponse, now)
	store := newMemoryWalletStore(10_000)
	handler := testWalletHandler(t, store, requestVerification, responseKey, now)
	payload := bindWalletV2(t, roundRequest{
		OperationID: "operation-tamper", Fingerprint: "rgs-fp-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		OperatorID: "local-operator", PlayerID: "player-1", WalletAccountID: "wallet-1",
		WalletSessionRef: "wallet-session-1", SessionID: "session-1", RoundID: "round-1",
		GameID: "iron-colossus", DefinitionVersion: "math-v1",
		DefinitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RoundKind:      "BASE", Currency: "CNY", DebitMinor: "100", CreditMinor: "50",
	})
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(
		http.MethodPost, "https://operator.local/rgs/wallet/v1/rounds/apply", bytes.NewReader(body),
	)
	if err := operator.SignRequest(request, body, requestKey, operator.RequestSignatureParams{
		RequestID: "request-tamper", IdempotencyKey: payload.OperationID,
		Nonce:   base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x62}, 24)),
		Created: now, Expires: now.Add(time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	tampered := bytes.Replace(body, []byte(`"creditMinor":"50"`), []byte(`"creditMinor":"51"`), 1)
	request.Body = io.NopCloser(bytes.NewReader(tampered))
	request.ContentLength = int64(len(tampered))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("tampered request status = %d", response.Code)
	}
	if balance, applies := store.snapshot(); balance != 10_000 || applies != 0 {
		t.Fatalf("tampered request changed store = balance:%d applies:%d", balance, applies)
	}
}

func TestWalletLegacyV1RequiresExplicitOptIn(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	requestKey, requestVerification := testSigningPair(t, "rgs-wallet-request", operator.KeyPurposeHTTPRequest, now)
	responseKey, _ := testSigningPair(t, "operator-wallet-response", operator.KeyPurposeHTTPResponse, now)
	store := newMemoryWalletStore(10_000)
	handler := testWalletHandlerWithPolicy(
		t, store, requestVerification, responseKey, now, true,
	)
	payload := roundRequest{
		OperationID: "operation-legacy", Fingerprint: "rgs-fp-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		OperatorID: "local-operator", PlayerID: "player-1", WalletAccountID: "wallet-1",
		SessionID: "session-1", RoundID: "round-1", GameID: "iron-colossus",
		DefinitionVersion: "math-v1",
		DefinitionHash:    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RoundKind:         "BASE", Currency: "CNY", DebitMinor: "100", CreditMinor: "50",
	}
	response := signedWalletCall(t, handler, requestKey, payload.OperationID, payload, 42, now)
	if response.Code != http.StatusOK {
		t.Fatalf("legacy opt-in status = %d", response.Code)
	}
	if balance, applies := store.snapshot(); balance != 9_950 || applies != 1 {
		t.Fatalf("legacy opt-in store = balance:%d applies:%d", balance, applies)
	}
}

type memoryWalletStore struct {
	mu         sync.Mutex
	balance    int64
	operations map[string]storedOperation
	rollbacks  map[string]storedOperation
	rejections map[string]storedRejection
	sessions   map[string]walletSessionSeed
	applies    int
}

func newMemoryWalletStore(balance int64) *memoryWalletStore {
	return &memoryWalletStore{
		balance: balance, operations: make(map[string]storedOperation),
		rollbacks:  make(map[string]storedOperation),
		rejections: make(map[string]storedRejection), sessions: make(map[string]walletSessionSeed),
	}
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
	if rejection, ok := s.rejections[request.OperationID]; ok {
		if rejection.RequestDigest != request.RequestDigest {
			return storedOperation{}, errIdempotencyConflict
		}
		return storedOperation{}, rejectionError(rejection.Code)
	}
	if request.WalletSessionRef != "" {
		seed, ok := s.sessions[request.OperatorID+"\x00"+request.WalletSessionRef]
		if !ok || seed.PlayerID != request.PlayerID ||
			seed.WalletAccountID != request.WalletAccountID || seed.SessionID != request.SessionID ||
			seed.GameID != request.GameID || seed.DefinitionVersion != request.DefinitionVersion ||
			seed.DefinitionHash != request.DefinitionHash || seed.Currency != request.Currency {
			s.rejections[request.OperationID] = newStoredRejection(
				request, walletRejectionSessionInvalid,
			)
			return storedOperation{}, errWalletSessionInvalid
		}
	}
	updatedBalance, err := checkedBalance(s.balance, request.Debit, request.Credit)
	if err != nil {
		if errors.Is(err, errInsufficientFunds) {
			s.rejections[request.OperationID] = newStoredRejection(
				request, walletRejectionInsufficientFunds,
			)
		}
		return storedOperation{}, err
	}
	s.balance = updatedBalance
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

func (s *memoryWalletStore) LookupRejection(
	_ context.Context,
	operatorID, operationID string,
) (storedRejection, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rejection, ok := s.rejections[operationID]
	return rejection, ok && rejection.OperatorID == operatorID, nil
}

func (s *memoryWalletStore) Rollback(_ context.Context, request validatedRollback) (storedOperation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if replay, ok := s.rollbacks[request.RollbackID]; ok {
		if replay.RequestDigest != request.RequestDigest || replay.OperationID != request.OperationID {
			return storedOperation{}, errIdempotencyConflict
		}
		return replay, nil
	}
	operation, ok := s.operations[request.OperationID]
	if !ok || operation.OperatorID != request.OperatorID {
		return storedOperation{}, errOperationNotFound
	}
	if operation.RolledBack {
		return storedOperation{}, errAlreadyRolledBack
	}
	updated, err := checkedBalance(s.balance, operation.CreditMinor, operation.DebitMinor)
	if err != nil {
		return storedOperation{}, err
	}
	s.balance = updated
	operation.RolledBack = true
	operation.BalanceMinor = updated
	operation.TransactionID = "wallet-rollback-tx-1"
	operation.RequestDigest = request.RequestDigest
	s.operations[request.OperationID] = operation
	s.rollbacks[request.RollbackID] = operation
	return operation, nil
}

func (s *memoryWalletStore) EnsureAccount(context.Context, accountSeed) error { return nil }
func (s *memoryWalletStore) RegisterWalletSession(_ context.Context, seed walletSessionSeed) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := seed.OperatorID + "\x00" + seed.WalletSessionRef
	if _, exists := s.sessions[key]; exists {
		return errWalletSessionInvalid
	}
	s.sessions[key] = seed
	return nil
}
func (s *memoryWalletStore) FindReusableWalletSession(
	_ context.Context,
	operatorID, playerID, walletAccountID, gameID, definitionVersion, definitionHash, currency string,
) (walletSessionSeed, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	for _, seed := range s.sessions {
		if seed.OperatorID == operatorID && seed.PlayerID == playerID &&
			seed.WalletAccountID == walletAccountID && seed.GameID == gameID &&
			seed.DefinitionVersion == definitionVersion && seed.DefinitionHash == definitionHash &&
			seed.Currency == currency && seed.ExpiresAt.After(now) {
			return seed, true, nil
		}
	}
	return walletSessionSeed{}, false, nil
}
func (s *memoryWalletStore) Ping(context.Context) error { return nil }

func (s *memoryWalletStore) snapshot() (int64, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.balance, s.applies
}

func (s *memoryWalletStore) setBalance(balance int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.balance = balance
}

func testWalletHandler(
	t *testing.T,
	store walletStore,
	requestKey operator.VerificationKey,
	responseKey operator.SigningKey,
	now time.Time,
) http.Handler {
	return testWalletHandlerWithPolicy(t, store, requestKey, responseKey, now, false)
}

func testWalletHandlerWithPolicy(
	t *testing.T,
	store walletStore,
	requestKey operator.VerificationKey,
	responseKey operator.SigningKey,
	now time.Time,
	allowLegacyV1 bool,
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
		ResponseSigningKey: responseKey, AllowLegacyV1: allowLegacyV1,
		Now: func() time.Time { return now }, Metrics: &serviceMetrics{},
	})
}

func bindWalletV2(t *testing.T, request roundRequest) roundRequest {
	t.Helper()
	debit, err := strconv.ParseInt(request.DebitMinor, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	credit, err := strconv.ParseInt(request.CreditMinor, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	request.CommandDigest = rgs.CommandDigestFor(rgs.WalletRound{
		OperationID: request.OperationID, Fingerprint: request.Fingerprint,
		OperatorID: request.OperatorID, PlayerID: request.PlayerID,
		WalletAccountID: request.WalletAccountID, WalletSessionRef: request.WalletSessionRef,
		SessionID: request.SessionID, RoundID: request.RoundID, GameID: request.GameID,
		DefinitionVersion: request.DefinitionVersion, DefinitionHash: request.DefinitionHash,
		RoundKind: rgs.RoundKind(request.RoundKind), Currency: request.Currency,
		DebitMinor: debit, CreditMinor: credit,
	})
	return request
}

func registerMemoryWalletSession(t *testing.T, store *memoryWalletStore, request roundRequest) {
	t.Helper()
	if err := store.RegisterWalletSession(context.Background(), walletSessionSeed{
		OperatorID: request.OperatorID, WalletSessionRef: request.WalletSessionRef,
		PlayerID: request.PlayerID, WalletAccountID: request.WalletAccountID,
		SessionID: request.SessionID, GameID: request.GameID,
		DefinitionVersion: request.DefinitionVersion, DefinitionHash: request.DefinitionHash,
		Currency: request.Currency, ExpiresAt: time.Now().UTC().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
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
	path := "/rgs/wallet/v1/rounds/apply"
	if _, lookup := payload.(lookupRequest); lookup {
		path = "/rgs/wallet/v1/transactions/status"
	} else if _, rollback := payload.(rollbackRequest); rollback {
		path = "/rgs/wallet/v1/transactions/rollback"
	}
	request := httptest.NewRequest(http.MethodPost, "https://operator.local"+path, bytes.NewReader(body))
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
