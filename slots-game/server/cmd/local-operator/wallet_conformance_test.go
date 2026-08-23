package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"slots-game/server/internal/operator"
	"slots-game/server/internal/rgs"
	walletadapter "slots-game/server/internal/wallet"
)

// TestLocalOperatorWalletV2ConformanceFixture 运行仓库内 RGS 适配器到本地 operator
// 的真实签名线协议；它是可执行回归门禁，不代表任何外部钱包或监管机构认证。
func TestLocalOperatorWalletV2ConformanceFixture(t *testing.T) {
	store := newMemoryWalletStore(10_000)
	adapter, closeServer := newLocalOperatorConformanceWallet(t, store, nil)
	defer closeServer()
	command := rgs.WalletRound{
		OperationID: "conformance-operation-1",
		Fingerprint: "rgs-fp-v2:" + strings.Repeat("a", 64),
		OperatorID:  "local-operator", PlayerID: "player-1", WalletAccountID: "wallet-1",
		WalletSessionRef: "wallet-session-1", SessionID: "session-1", RoundID: "round-1",
		GameID: "iron-colossus", DefinitionVersion: "math-v1",
		DefinitionHash: strings.Repeat("b", 64), RoundKind: rgs.RoundKindBase,
		Currency: "CNY", DebitMinor: 100, CreditMinor: 50,
	}
	command.CommandDigest = rgs.CommandDigestFor(command)
	const expectedCommandDigest = "rgs-wallet-cmd-v1:0ee1189149c0e0814b1c1006102ecce342bbd662634af50eb6d2e2ead321fd30"
	if command.CommandDigest != expectedCommandDigest {
		t.Fatalf("wallet v2 command digest vector = %s", command.CommandDigest)
	}
	if err := store.RegisterWalletSession(context.Background(), walletSessionSeed{
		OperatorID: command.OperatorID, WalletSessionRef: command.WalletSessionRef,
		PlayerID: command.PlayerID, WalletAccountID: command.WalletAccountID,
		SessionID: command.SessionID, GameID: command.GameID,
		DefinitionVersion: command.DefinitionVersion, DefinitionHash: command.DefinitionHash,
		Currency: command.Currency, ExpiresAt: time.Now().UTC().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		resolution := adapter.SubmitRound(context.Background(), command)
		if resolution.Status != rgs.ResolutionSucceeded ||
			resolution.Receipt.BalanceMinor != 9_950 {
			t.Fatalf("submit attempt %d = %+v", attempt+1, resolution)
		}
	}
	if balance, applies := store.snapshot(); balance != 9_950 || applies != 1 {
		t.Fatalf("conformance duplicate state = balance:%d applies:%d", balance, applies)
	}
	resolution := adapter.Resolve(context.Background(), rgs.OperationRefFor(command))
	if resolution.Status != rgs.ResolutionSucceeded ||
		resolution.Receipt.TransactionID != "wallet-tx-1" {
		t.Fatalf("conformance resolve = %+v", resolution)
	}
}

func TestLocalOperatorPersistsLostTerminalRejection(t *testing.T) {
	store := newMemoryWalletStore(0)
	drop := &dropFirstApplyResponseTransport{}
	adapter, closeServer := newLocalOperatorConformanceWallet(
		t, store, func(base http.RoundTripper) http.RoundTripper {
			drop.base = base
			return drop
		},
	)
	defer closeServer()
	command := rgs.WalletRound{
		OperationID: "conformance-rejected-operation",
		Fingerprint: "rgs-fp-v2:" + strings.Repeat("e", 64),
		OperatorID:  "local-operator", PlayerID: "player-rejected",
		WalletAccountID: "wallet-rejected", WalletSessionRef: "wallet-session-rejected",
		SessionID: "session-rejected", RoundID: "round-rejected", GameID: "iron-colossus",
		DefinitionVersion: "math-v1", DefinitionHash: strings.Repeat("f", 64),
		RoundKind: rgs.RoundKindBase, Currency: "CNY", DebitMinor: 100, CreditMinor: 100,
	}
	command.CommandDigest = rgs.CommandDigestFor(command)
	if err := store.RegisterWalletSession(context.Background(), walletSessionSeed{
		OperatorID: command.OperatorID, WalletSessionRef: command.WalletSessionRef,
		PlayerID: command.PlayerID, WalletAccountID: command.WalletAccountID,
		SessionID: command.SessionID, GameID: command.GameID,
		DefinitionVersion: command.DefinitionVersion, DefinitionHash: command.DefinitionHash,
		Currency: command.Currency, ExpiresAt: time.Now().UTC().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	first := adapter.SubmitRound(context.Background(), command)
	if first.Status != rgs.ResolutionUnknown {
		t.Fatalf("lost apply response = %+v", first)
	}
	store.setBalance(1_000)
	resolved := adapter.Resolve(context.Background(), rgs.OperationRefFor(command))
	if resolved.Status != rgs.ResolutionRejectedFinal ||
		resolved.Code != walletRejectionInsufficientFunds ||
		!errors.Is(resolved.Cause, rgs.ErrWalletRejected) {
		t.Fatalf("resolved terminal rejection = %+v", resolved)
	}
	replayed := adapter.SubmitRound(context.Background(), command)
	if replayed.Status != rgs.ResolutionRejectedFinal ||
		replayed.Code != walletRejectionInsufficientFunds {
		t.Fatalf("replayed terminal rejection = %+v", replayed)
	}
	conflictCommand := command
	conflictCommand.DebitMinor = 101
	conflictCommand.CommandDigest = rgs.CommandDigestFor(conflictCommand)
	conflict := adapter.SubmitRound(context.Background(), conflictCommand)
	if conflict.Status != rgs.ResolutionConflict ||
		!errors.Is(conflict.Cause, rgs.ErrIdempotencyConflict) {
		t.Fatalf("changed rejected command = %+v", conflict)
	}
	if balance, applies := store.snapshot(); balance != 1_000 || applies != 0 {
		t.Fatalf("rejected command changed after funds arrived = balance:%d applies:%d", balance, applies)
	}
}

type dropFirstApplyResponseTransport struct {
	base    http.RoundTripper
	dropped atomic.Bool
}

func (t *dropFirstApplyResponseTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := t.base.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	if strings.HasSuffix(request.URL.Path, "/wallet/v1/rounds/apply") &&
		t.dropped.CompareAndSwap(false, true) {
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		return nil, errors.New("conformance fixture: apply response lost after wallet decision")
	}
	return response, nil
}

func newLocalOperatorConformanceWallet(
	t *testing.T,
	store walletStore,
	wrapTransport func(http.RoundTripper) http.RoundTripper,
) (*walletadapter.HTTPWallet, func()) {
	t.Helper()
	now := testClock()
	requestSigning, requestVerification := testSigningPair(
		t, "rgs-wallet-request", operator.KeyPurposeHTTPRequest, now,
	)
	responseSigning, responseVerification := testSigningPair(
		t, "operator-wallet-response", operator.KeyPurposeHTTPResponse, now,
	)
	requestKeys, err := operator.NewMemoryKeyRing(requestVerification)
	if err != nil {
		t.Fatal(err)
	}
	requests, err := operator.NewRequestVerifier(
		requestKeys, operator.NewMemoryNonceStore(), operator.RequestVerifierOptions{},
	)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(newWalletHandler(walletHandlerConfig{
		OperatorID: "local-operator", Store: store, Verifier: requests,
		ResponseSigningKey: responseSigning, Metrics: &serviceMetrics{},
	}))
	responseKeys, err := operator.NewMemoryKeyRing(responseVerification)
	if err != nil {
		server.Close()
		t.Fatal(err)
	}
	responses, err := operator.NewResponseVerifier(
		responseKeys, operator.RequestVerifierOptions{},
	)
	if err != nil {
		server.Close()
		t.Fatal(err)
	}
	client := server.Client()
	if wrapTransport != nil {
		client.Transport = wrapTransport(client.Transport)
	}
	adapter, err := walletadapter.NewHTTPWallet(walletadapter.HTTPConfig{
		BaseURL: server.URL + "/rgs", OperatorID: "local-operator",
		RequestSigningKey: requestSigning, ResponseVerifier: responses,
		Client: client, AllowInsecureDevelopment: true,
	})
	if err != nil {
		server.Close()
		t.Fatal(err)
	}
	return adapter, server.Close
}

func testClock() time.Time {
	return time.Now().UTC().Truncate(time.Second)
}
