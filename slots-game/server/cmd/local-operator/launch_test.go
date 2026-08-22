package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"slots-game/server/internal/operator"
)

func TestLaunchClientSignsRequestAndVerifiesRGSResponse(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	requestSigning, requestVerification := testSigningPair(t, "operator-launch-request", operator.KeyPurposeHTTPRequest, now)
	responseSigning, responseVerification := testSigningPair(t, "rgs-launch-response", operator.KeyPurposeHTTPResponse, now)
	ring, err := operator.NewMemoryKeyRing(requestVerification)
	if err != nil {
		t.Fatal(err)
	}
	requests, err := operator.NewRequestVerifier(ring, operator.NewMemoryNonceStore(), operator.RequestVerifierOptions{})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, readErr := io.ReadAll(request.Body)
		if readErr != nil {
			t.Errorf("read launch request: %v", readErr)
			return
		}
		verified, verifyErr := requests.Verify(request.Context(), request, body)
		if verifyErr != nil || verified.OperatorID != "local-operator" {
			t.Errorf("verify launch request: %+v %v", verified, verifyErr)
			return
		}
		encoded, _ := json.Marshal(map[string]any{
			"data": map[string]string{
				"launchCode":  "lc_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
				"exchangeUrl": "https://rgs.local/client/v1/sessions/exchange",
				"expiresAt":   now.Add(2 * time.Minute).Format(time.RFC3339Nano),
			},
			"requestId": verified.RequestID,
		})
		response := &http.Response{StatusCode: http.StatusCreated, Header: writer.Header()}
		if signErr := operator.SignResponse(response, encoded, responseSigning, operator.ResponseSignatureParams{
			RequestID: verified.RequestID, Created: now, Expires: now.Add(time.Minute),
		}); signErr != nil {
			t.Errorf("sign launch response: %v", signErr)
			return
		}
		writer.WriteHeader(http.StatusCreated)
		_, _ = writer.Write(encoded)
	}))
	defer server.Close()
	client, err := newLaunchClient(
		"local-operator", server.URL, requestSigning,
		[]operator.VerificationKey{responseVerification}, server.Client(),
	)
	if err != nil {
		t.Fatal(err)
	}
	client.now = func() time.Time { return now }
	result, err := client.Create(context.Background(), launchPayload{
		PlayerID: "player-1", WalletAccountID: "wallet-1", WalletSessionID: "wallet-session-1",
		SessionID: "session-1", GameID: "iron-colossus", DefinitionVersion: "math-v1",
		DefinitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Currency:       "CNY", CurrencyExponent: 2, Jurisdiction: "CN-LOCAL",
		BalanceMinor: "10000", SessionTTLSeconds: 3600,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Data.LaunchCode != "lc_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ" {
		t.Fatalf("launch response = %+v", result)
	}
}

func TestLauncherPersistsAuthoritativeWalletSessionBindingBeforeReturn(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	requestSigning, _ := testSigningPair(t, "operator-launch-request", operator.KeyPurposeHTTPRequest, now)
	responseSigning, responseVerification := testSigningPair(t, "rgs-launch-response", operator.KeyPurposeHTTPResponse, now)
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requestID := request.Header.Get(operator.HeaderRequestID)
		encoded, _ := json.Marshal(map[string]any{
			"data": map[string]string{
				"launchCode":  "lc_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
				"exchangeUrl": "https://rgs.local/client/v1/sessions/exchange",
				"expiresAt":   now.Add(2 * time.Minute).Format(time.RFC3339Nano),
			},
			"requestId": requestID,
		})
		response := &http.Response{StatusCode: http.StatusCreated, Header: writer.Header()}
		if err := operator.SignResponse(response, encoded, responseSigning, operator.ResponseSignatureParams{
			RequestID: requestID, Created: now, Expires: now.Add(time.Minute),
		}); err != nil {
			t.Errorf("sign launch response: %v", err)
			return
		}
		writer.WriteHeader(http.StatusCreated)
		_, _ = writer.Write(encoded)
	}))
	defer server.Close()
	client, err := newLaunchClient(
		"local-operator", server.URL, requestSigning,
		[]operator.VerificationKey{responseVerification}, server.Client(),
	)
	if err != nil {
		t.Fatal(err)
	}
	client.now = func() time.Time { return now }
	store := newMemoryWalletStore(10_000)
	handler, err := newLauncher(launcherConfig{
		OperatorID: "local-operator", WebBaseURL: "https://slots.local",
		GameID: "iron-colossus", DefinitionVersion: "math-v1",
		DefinitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Currency:       "CNY", CurrencyExponent: 2, Jurisdiction: "CN-LOCAL",
		InitialBalanceMinor: 10_000, SessionTTL: time.Hour,
		DefaultPlayerID: "player-1", DefaultWalletAccountID: "wallet-1",
		AdminToken: []byte("0123456789abcdef"), Store: store, Client: client,
		Metrics: &serviceMetrics{},
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := handler.(*launcher).create(context.Background(), launchInput{})
	if err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.sessions) != 1 {
		t.Fatalf("registered wallet sessions = %d", len(store.sessions))
	}
	for _, seed := range store.sessions {
		if seed.OperatorID != "local-operator" || seed.PlayerID != "player-1" ||
			seed.WalletAccountID != "wallet-1" || seed.SessionID != result.SessionID ||
			seed.GameID != "iron-colossus" || seed.DefinitionVersion != "math-v1" ||
			seed.Currency != "CNY" || !seed.ExpiresAt.After(time.Now().UTC()) {
			t.Fatalf("wallet session binding = %+v", seed)
		}
	}
}
