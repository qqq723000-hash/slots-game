package wallet

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"slots-game/server/internal/operator"
	"slots-game/server/internal/rgs"
	"slots-game/server/internal/telemetry"
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
	client, err := SecureHTTPClient(3*time.Second, "")
	if err != nil {
		t.Fatal(err)
	}
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

func TestSecureHTTPClientUsesConfiguredWalletRootCA(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	rootPath := filepath.Join(t.TempDir(), "wallet-root.pem")
	rootPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
	if err := os.WriteFile(rootPath, rootPEM, 0o644); err != nil {
		t.Fatal(err)
	}
	client, err := SecureHTTPClient(time.Second, rootPath)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatalf("configured wallet root CA was not trusted: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("wallet TLS response status = %d, want %d", response.StatusCode, http.StatusNoContent)
	}
}

func TestSecureHTTPClientFailsClosedOnInvalidWalletRootCA(t *testing.T) {
	directory := t.TempDir()
	malformedPath := filepath.Join(directory, "malformed.pem")
	if err := os.WriteFile(malformedPath, []byte("not a certificate"), 0o644); err != nil {
		t.Fatal(err)
	}
	for name, rootPath := range map[string]string{
		"missing":   filepath.Join(directory, "missing.pem"),
		"malformed": malformedPath,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := SecureHTTPClient(time.Second, rootPath); err == nil {
				t.Fatal("invalid wallet root CA unexpectedly accepted")
			}
		})
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

func TestHTTPWalletSubmitRoundSendsV2BindingAndReturnsSucceeded(t *testing.T) {
	command := resolutionTestCommand()
	var received roundRequest
	httpWallet := newResolutionTestWallet(t, func(
		writer http.ResponseWriter,
		request *http.Request,
		responseKey operator.SigningKey,
		now time.Time,
	) {
		body, _ := io.ReadAll(request.Body)
		if err := json.Unmarshal(body, &received); err != nil {
			t.Errorf("decode request: %v", err)
		}
		writeResolutionTestResponse(t, writer, request, responseKey, now, http.StatusOK, walletResponse{
			Status: "SUCCEEDED", OperationID: command.OperationID,
			Fingerprint: command.Fingerprint, TransactionID: "wallet-transaction-1",
			OperatorID: command.OperatorID, Currency: command.Currency,
			DebitMinor:  strconv.FormatInt(command.DebitMinor, 10),
			CreditMinor: strconv.FormatInt(command.CreditMinor, 10), BalanceMinor: "10150",
			CommandDigest: command.CommandDigest,
		})
	})

	resolution := httpWallet.SubmitRound(context.Background(), command)
	if resolution.Status != rgs.ResolutionSucceeded || resolution.Receipt.BalanceMinor != 10_150 {
		t.Fatalf("SubmitRound() = %+v", resolution)
	}
	if received.WalletSessionRef != command.WalletSessionRef ||
		received.CommandDigest != command.CommandDigest {
		t.Fatalf("v2 request binding = %+v", received)
	}
}

func TestHTTPWalletInjectsOnlyCurrentTraceContextAfterSigning(t *testing.T) {
	command := resolutionTestCommand()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
		sdktrace.WithSpanProcessor(recorder),
	)
	defer provider.Shutdown(context.Background())
	runtime := telemetry.NewWithProvider(provider)
	var traceParent, traceState string
	httpWallet := newResolutionTestWallet(t, func(
		writer http.ResponseWriter,
		request *http.Request,
		responseKey operator.SigningKey,
		now time.Time,
	) {
		traceParent = request.Header.Get("traceparent")
		traceState = request.Header.Get("tracestate")
		writeResolutionTestResponse(t, writer, request, responseKey, now, http.StatusOK, walletResponse{
			Status: "SUCCEEDED", OperationID: command.OperationID,
			Fingerprint: command.Fingerprint, TransactionID: "wallet-transaction-traced",
			OperatorID: command.OperatorID, Currency: command.Currency,
			DebitMinor:  strconv.FormatInt(command.DebitMinor, 10),
			CreditMinor: strconv.FormatInt(command.CreditMinor, 10), BalanceMinor: "10150",
			CommandDigest: command.CommandDigest,
		})
	})
	ctx, parent := telemetry.Start(runtime.Context(context.Background()), "rgs.wallet.submit")
	wantTraceParent := "00-" + parent.SpanContext().TraceID().String() + "-" +
		parent.SpanContext().SpanID().String() + "-01"
	resolution := httpWallet.SubmitRound(ctx, command)
	parent.End()
	if resolution.Status != rgs.ResolutionSucceeded {
		t.Fatalf("SubmitRound() = %+v", resolution)
	}
	if traceParent != wantTraceParent || traceState != "" {
		t.Fatalf("wallet trace headers = traceparent:%q tracestate:%q", traceParent, traceState)
	}
	if len(recorder.Ended()) != 1 {
		t.Fatalf("unexpected local span count = %d", len(recorder.Ended()))
	}
}

func TestHTTPWalletV2SuccessRequiresBoundCommandDigest(t *testing.T) {
	for _, action := range []string{"submit", "resolve"} {
		for _, test := range []struct {
			name   string
			digest func(rgs.WalletRound) string
			want   rgs.ResolutionStatus
		}{
			{name: "exact", digest: func(command rgs.WalletRound) string {
				return command.CommandDigest
			}, want: rgs.ResolutionSucceeded},
			{name: "missing", digest: func(rgs.WalletRound) string { return "" }, want: rgs.ResolutionConflict},
			{name: "wrong", digest: func(rgs.WalletRound) string {
				return "rgs-wallet-cmd-v1:" + strings.Repeat("f", 64)
			}, want: rgs.ResolutionConflict},
		} {
			t.Run(action+"-"+test.name, func(t *testing.T) {
				command := resolutionTestCommand()
				httpWallet := newResolutionTestWallet(t, func(
					writer http.ResponseWriter,
					request *http.Request,
					responseKey operator.SigningKey,
					now time.Time,
				) {
					writeResolutionTestResponse(t, writer, request, responseKey, now, http.StatusOK, walletResponse{
						Status: "SUCCEEDED", OperationID: command.OperationID,
						Fingerprint: command.Fingerprint, TransactionID: "wallet-transaction-1",
						OperatorID: command.OperatorID, Currency: command.Currency,
						DebitMinor:  strconv.FormatInt(command.DebitMinor, 10),
						CreditMinor: strconv.FormatInt(command.CreditMinor, 10), BalanceMinor: "10150",
						CommandDigest: test.digest(command),
					})
				})
				var resolution rgs.Resolution
				if action == "submit" {
					resolution = httpWallet.SubmitRound(context.Background(), command)
				} else {
					resolution = httpWallet.Resolve(context.Background(), rgs.OperationRefFor(command))
				}
				if resolution.Status != test.want {
					t.Fatalf("%s resolution = %+v, want %s", action, resolution, test.want)
				}
				if test.want == rgs.ResolutionConflict &&
					!errors.Is(resolution.Cause, rgs.ErrWalletReceiptInvalid) {
					t.Fatalf("%s digest conflict cause = %v", action, resolution.Cause)
				}
			})
		}
	}
}

func TestHTTPWalletLegacyApplyKeepsV1WireShape(t *testing.T) {
	command := resolutionTestCommand()
	httpWallet := newResolutionTestWallet(t, func(
		writer http.ResponseWriter,
		request *http.Request,
		responseKey operator.SigningKey,
		now time.Time,
	) {
		body, _ := io.ReadAll(request.Body)
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(body, &fields); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if _, exists := fields["walletSessionRef"]; exists {
			t.Error("legacy apply leaked walletSessionRef into v1 wire contract")
		}
		if _, exists := fields["commandDigest"]; exists {
			t.Error("legacy apply leaked commandDigest into v1 wire contract")
		}
		writeResolutionTestResponse(t, writer, request, responseKey, now, http.StatusOK, walletResponse{
			Status: "SUCCEEDED", OperationID: command.OperationID,
			Fingerprint: command.Fingerprint, TransactionID: "wallet-transaction-1",
			OperatorID: command.OperatorID, Currency: command.Currency,
			DebitMinor:  strconv.FormatInt(command.DebitMinor, 10),
			CreditMinor: strconv.FormatInt(command.CreditMinor, 10), BalanceMinor: "10150",
		})
	})
	if _, err := httpWallet.ApplyRound(context.Background(), command); err != nil {
		t.Fatalf("ApplyRound() error = %v", err)
	}
}

func TestHTTPWalletSubmitRoundRejectsInvalidBindingBeforeDispatch(t *testing.T) {
	var calls int
	httpWallet := newResolutionTestWallet(t, func(
		http.ResponseWriter,
		*http.Request,
		operator.SigningKey,
		time.Time,
	) {
		calls++
	})
	command := resolutionTestCommand()
	command.CreditMinor++

	resolution := httpWallet.SubmitRound(context.Background(), command)
	if resolution.Status != rgs.ResolutionNotSent || !errors.Is(resolution.Cause, rgs.ErrInvalidRequest) {
		t.Fatalf("SubmitRound() = %+v, want NOT_SENT invalid request", resolution)
	}
	if calls != 0 {
		t.Fatalf("wallet HTTP calls = %d, want 0", calls)
	}
}

func TestHTTPWalletRollbackRejectsAuthenticatedIdentityTampering(t *testing.T) {
	rollback := rgs.WalletRollback{
		OperatorID: "operator-a", OperationID: "operation-a",
		RollbackID: "rollback-a", Reason: "approved reconciliation",
	}
	valid := walletResponse{
		Status: "ROLLED_BACK", OperatorID: rollback.OperatorID,
		OperationID: rollback.OperationID, RollbackID: rollback.RollbackID,
		Fingerprint:   "rgs-fp-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		TransactionID: "wallet-rollback-transaction", Currency: "USD",
		DebitMinor: "100", CreditMinor: "25", BalanceMinor: "10000",
		CommandDigest: rgs.CommandDigestFor(resolutionTestCommand()),
	}
	for _, test := range []struct {
		name   string
		mutate func(*walletResponse)
		wantOK bool
	}{
		{name: "valid", wantOK: true},
		{name: "operator", mutate: func(response *walletResponse) { response.OperatorID = "operator-b" }},
		{name: "operation", mutate: func(response *walletResponse) { response.OperationID = "operation-b" }},
		{name: "rollback", mutate: func(response *walletResponse) { response.RollbackID = "rollback-b" }},
		{name: "command digest", mutate: func(response *walletResponse) { response.CommandDigest = "invalid" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := valid
			if test.mutate != nil {
				test.mutate(&response)
			}
			httpWallet := newResolutionTestWallet(t, func(
				writer http.ResponseWriter,
				request *http.Request,
				responseKey operator.SigningKey,
				now time.Time,
			) {
				writeResolutionTestResponse(t, writer, request, responseKey, now, http.StatusOK, response)
			})
			receipt, err := httpWallet.Rollback(context.Background(), rollback)
			if test.wantOK {
				if err != nil || receipt.OperationID != rollback.OperationID {
					t.Fatalf("Rollback() = receipt:%+v error:%v", receipt, err)
				}
				return
			}
			if !errors.Is(err, rgs.ErrWalletReceiptInvalid) {
				t.Fatalf("Rollback() error = %v, want ErrWalletReceiptInvalid", err)
			}
		})
	}
}

func TestHTTPWalletRollbackRejectsInvalidRequestBeforeDispatch(t *testing.T) {
	var calls int
	httpWallet := newResolutionTestWallet(t, func(
		http.ResponseWriter,
		*http.Request,
		operator.SigningKey,
		time.Time,
	) {
		calls++
	})
	_, err := httpWallet.Rollback(context.Background(), rgs.WalletRollback{
		OperatorID: "operator-a", OperationID: "", RollbackID: "rollback-a", Reason: "approved",
	})
	if !errors.Is(err, rgs.ErrWalletReceiptInvalid) || calls != 0 {
		t.Fatalf("Rollback() = calls:%d error:%v", calls, err)
	}
}

func TestHTTPWalletDistinguishesAuthenticatedConflictFromUnauthenticatedGateway(t *testing.T) {
	for _, test := range []struct {
		name          string
		authenticated bool
		want          rgs.ResolutionStatus
	}{
		{name: "authenticated", authenticated: true, want: rgs.ResolutionConflict},
		{name: "unauthenticated-gateway", authenticated: false, want: rgs.ResolutionUnknown},
	} {
		t.Run(test.name, func(t *testing.T) {
			httpWallet := newResolutionTestWallet(t, func(
				writer http.ResponseWriter,
				request *http.Request,
				responseKey operator.SigningKey,
				now time.Time,
			) {
				payload := walletResponse{Status: "CONFLICT", Code: "IDEMPOTENCY_CONFLICT"}
				if test.authenticated {
					writeResolutionTestResponse(
						t, writer, request, responseKey, now, http.StatusConflict, payload,
					)
					return
				}
				writer.Header().Set("Content-Type", "application/json")
				writer.WriteHeader(http.StatusConflict)
				_ = json.NewEncoder(writer).Encode(payload)
			})

			resolution := httpWallet.SubmitRound(context.Background(), resolutionTestCommand())
			if resolution.Status != test.want {
				t.Fatalf("SubmitRound() status = %s, want %s; cause=%v", resolution.Status, test.want, resolution.Cause)
			}
			if test.authenticated && !errors.Is(resolution.Cause, rgs.ErrIdempotencyConflict) {
				t.Fatalf("authenticated conflict cause = %v", resolution.Cause)
			}
			if !test.authenticated && (errors.Is(resolution.Cause, rgs.ErrIdempotencyConflict) ||
				errors.Is(resolution.Cause, rgs.ErrWalletReceiptInvalid)) {
				t.Fatalf("unauthenticated gateway was treated as an integrity conflict: %v", resolution.Cause)
			}
		})
	}
}

func TestHTTPWalletMapsAuthenticatedApplyFinality(t *testing.T) {
	for _, test := range []struct {
		name       string
		httpStatus int
		payload    walletResponse
		want       rgs.ResolutionStatus
		bind       bool
	}{
		{
			name: "pending", httpStatus: http.StatusAccepted,
			payload: walletResponse{Status: "PENDING", Code: "PROCESSING"},
			want:    rgs.ResolutionPending,
		},
		{
			name: "rejected-final", httpStatus: http.StatusUnprocessableEntity,
			payload: walletResponse{Status: "REJECTED", Code: "INSUFFICIENT_FUNDS"},
			want:    rgs.ResolutionRejectedFinal, bind: true,
		},
		{
			name: "unbound-rejection", httpStatus: http.StatusUnprocessableEntity,
			payload: walletResponse{Status: "REJECTED", Code: "INSUFFICIENT_FUNDS"},
			want:    rgs.ResolutionConflict,
		},
		{
			name: "authenticated-service-failure", httpStatus: http.StatusServiceUnavailable,
			payload: walletResponse{Status: "PENDING", Code: "BACKEND_UNAVAILABLE"},
			want:    rgs.ResolutionUnknown,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			command := resolutionTestCommand()
			payload := test.payload
			if test.bind {
				payload.OperationID = command.OperationID
				payload.Fingerprint = command.Fingerprint
				payload.OperatorID = command.OperatorID
				payload.CommandDigest = command.CommandDigest
			}
			httpWallet := newResolutionTestWallet(t, func(
				writer http.ResponseWriter,
				request *http.Request,
				responseKey operator.SigningKey,
				now time.Time,
			) {
				writeResolutionTestResponse(
					t, writer, request, responseKey, now, test.httpStatus, payload,
				)
			})
			resolution := httpWallet.SubmitRound(context.Background(), command)
			if resolution.Status != test.want {
				t.Fatalf("SubmitRound() status = %s, want %s; cause=%v", resolution.Status, test.want, resolution.Cause)
			}
		})
	}
}

func TestHTTPWalletResolveDistinguishesSignedNotFoundFromGateway404(t *testing.T) {
	for _, test := range []struct {
		name          string
		authenticated bool
		want          rgs.ResolutionStatus
	}{
		{name: "wallet-not-found", authenticated: true, want: rgs.ResolutionNotFound},
		{name: "gateway-not-found", authenticated: false, want: rgs.ResolutionUnknown},
	} {
		t.Run(test.name, func(t *testing.T) {
			command := resolutionTestCommand()
			httpWallet := newResolutionTestWallet(t, func(
				writer http.ResponseWriter,
				request *http.Request,
				responseKey operator.SigningKey,
				now time.Time,
			) {
				payload := walletResponse{Status: "NOT_FOUND", Code: "OPERATION_NOT_FOUND"}
				if test.authenticated {
					payload.OperatorID = command.OperatorID
					payload.OperationID = command.OperationID
					payload.Fingerprint = command.Fingerprint
					payload.CommandDigest = command.CommandDigest
					writeResolutionTestResponse(
						t, writer, request, responseKey, now, http.StatusNotFound, payload,
					)
					return
				}
				writer.Header().Set("Content-Type", "application/json")
				writer.WriteHeader(http.StatusNotFound)
				_ = json.NewEncoder(writer).Encode(payload)
			})

			resolution := httpWallet.Resolve(
				context.Background(), rgs.OperationRefFor(command),
			)
			if resolution.Status != test.want {
				t.Fatalf("Resolve() status = %s, want %s; cause=%v", resolution.Status, test.want, resolution.Cause)
			}
		})
	}
}

func TestHTTPWalletResolveRequiresFullyBoundSignedNotFound(t *testing.T) {
	command := resolutionTestCommand()
	reference := rgs.OperationRefFor(command)
	base := walletResponse{
		Status: "NOT_FOUND", Code: "OPERATION_NOT_FOUND",
		OperatorID: command.OperatorID, OperationID: command.OperationID,
		Fingerprint: command.Fingerprint, CommandDigest: command.CommandDigest,
	}
	for _, test := range []struct {
		name   string
		mutate func(*walletResponse)
		want   rgs.ResolutionStatus
	}{
		{name: "exact", mutate: func(*walletResponse) {}, want: rgs.ResolutionNotFound},
		{name: "missing operator", mutate: func(value *walletResponse) { value.OperatorID = "" }, want: rgs.ResolutionConflict},
		{name: "wrong operation", mutate: func(value *walletResponse) { value.OperationID = "operation-other" }, want: rgs.ResolutionConflict},
		{name: "missing fingerprint", mutate: func(value *walletResponse) { value.Fingerprint = "" }, want: rgs.ResolutionConflict},
		{name: "wrong digest", mutate: func(value *walletResponse) {
			value.CommandDigest = "rgs-wallet-cmd-v1:" + strings.Repeat("f", 64)
		}, want: rgs.ResolutionConflict},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := base
			test.mutate(&response)
			httpWallet := newResolutionTestWallet(t, func(
				writer http.ResponseWriter,
				request *http.Request,
				responseKey operator.SigningKey,
				now time.Time,
			) {
				body, _ := io.ReadAll(request.Body)
				var lookup lookupRequest
				if err := json.Unmarshal(body, &lookup); err != nil ||
					lookup.OperatorID != reference.OperatorID || lookup.OperationID != reference.OperationID ||
					lookup.Fingerprint != reference.Fingerprint || lookup.CommandDigest != reference.CommandDigest {
					t.Errorf("v2 lookup request binding = %+v error=%v", lookup, err)
				}
				writeResolutionTestResponse(t, writer, request, responseKey, now, http.StatusNotFound, response)
			})
			resolution := httpWallet.Resolve(context.Background(), reference)
			if resolution.Status != test.want {
				t.Fatalf("Resolve() = %+v, want %s", resolution, test.want)
			}
			if test.want == rgs.ResolutionConflict && !errors.Is(resolution.Cause, rgs.ErrWalletReceiptInvalid) {
				t.Fatalf("Resolve() conflict cause = %v", resolution.Cause)
			}
		})
	}
}

func TestHTTPWalletLegacyLookupKeepsUnboundV1WireShape(t *testing.T) {
	httpWallet := newResolutionTestWallet(t, func(
		writer http.ResponseWriter,
		request *http.Request,
		responseKey operator.SigningKey,
		now time.Time,
	) {
		body, _ := io.ReadAll(request.Body)
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(body, &fields); err != nil {
			t.Errorf("decode legacy lookup: %v", err)
		}
		if _, exists := fields["fingerprint"]; exists {
			t.Error("legacy lookup leaked fingerprint into v1 wire contract")
		}
		if _, exists := fields["commandDigest"]; exists {
			t.Error("legacy lookup leaked commandDigest into v1 wire contract")
		}
		writeResolutionTestResponse(t, writer, request, responseKey, now, http.StatusNotFound,
			walletResponse{Status: "NOT_FOUND", Code: "OPERATION_NOT_FOUND"})
	})
	if receipt, found, err := httpWallet.Lookup(context.Background(), "operator-a", "legacy-operation"); err != nil || found || receipt.OperationID != "" {
		t.Fatalf("Lookup() = receipt:%+v found:%v error:%v", receipt, found, err)
	}
}

func TestHTTPWalletResolveRequiresBoundTerminalRejection(t *testing.T) {
	command := resolutionTestCommand()
	base := walletResponse{
		Status: "REJECTED", Code: "INSUFFICIENT_FUNDS",
		OperationID: command.OperationID, Fingerprint: command.Fingerprint,
		OperatorID: command.OperatorID, CommandDigest: command.CommandDigest,
	}
	for _, test := range []struct {
		name   string
		mutate func(*walletResponse)
		want   rgs.ResolutionStatus
	}{
		{name: "valid", mutate: func(*walletResponse) {}, want: rgs.ResolutionRejectedFinal},
		{name: "wrong-operation", mutate: func(value *walletResponse) {
			value.OperationID = "operation-v2-other"
		}, want: rgs.ResolutionConflict},
		{name: "wrong-fingerprint", mutate: func(value *walletResponse) {
			value.Fingerprint = "rgs-fp-v2:" + strings.Repeat("c", 64)
		}, want: rgs.ResolutionConflict},
		{name: "wrong-command-digest", mutate: func(value *walletResponse) {
			value.CommandDigest = "rgs-wallet-cmd-v1:" + strings.Repeat("d", 64)
		}, want: rgs.ResolutionConflict},
		{name: "wrong-operator", mutate: func(value *walletResponse) {
			value.OperatorID = "operator-b"
		}, want: rgs.ResolutionConflict},
		{name: "invalid-code", mutate: func(value *walletResponse) {
			value.Code = "invalid code"
		}, want: rgs.ResolutionConflict},
		{name: "oversized-code", mutate: func(value *walletResponse) {
			value.Code = strings.Repeat("A", 129)
		}, want: rgs.ResolutionConflict},
	} {
		t.Run(test.name, func(t *testing.T) {
			payload := base
			test.mutate(&payload)
			httpWallet := newResolutionTestWallet(t, func(
				writer http.ResponseWriter,
				request *http.Request,
				responseKey operator.SigningKey,
				now time.Time,
			) {
				writeResolutionTestResponse(
					t, writer, request, responseKey, now,
					http.StatusUnprocessableEntity, payload,
				)
			})
			resolution := httpWallet.Resolve(
				context.Background(), rgs.OperationRefFor(command),
			)
			if resolution.Status != test.want {
				t.Fatalf("Resolve() = %+v, want %s", resolution, test.want)
			}
			if test.want == rgs.ResolutionRejectedFinal &&
				(!errors.Is(resolution.Cause, rgs.ErrWalletRejected) ||
					resolution.Code != "INSUFFICIENT_FUNDS") {
				t.Fatalf("terminal rejection = %+v", resolution)
			}
		})
	}
}

func TestHTTPWalletProfileBindsCanonicalTarget(t *testing.T) {
	httpWallet := newResolutionTestWallet(t, func(
		http.ResponseWriter,
		*http.Request,
		operator.SigningKey,
		time.Time,
	) {
	})
	profile, err := httpWallet.ProfileFor("operator-a")
	if err != nil {
		t.Fatal(err)
	}
	want := rgs.WalletRouteBindingIDForCanonicalTarget(
		strings.TrimRight(httpWallet.baseURL.String(), "/"),
	)
	if profile.RouteBindingID != want || rgs.ValidateProfile(profile) != nil ||
		profile.Capabilities.ExplicitRollback {
		t.Fatalf("HTTP wallet profile = %+v", profile)
	}
}

func resolutionTestCommand() rgs.WalletRound {
	command := rgs.WalletRound{
		OperationID: "operation-v2-1",
		Fingerprint: "rgs-fp-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		OperatorID:  "operator-a", PlayerID: "player-a", WalletAccountID: "wallet-a",
		WalletSessionRef: "wallet-session-a", SessionID: "session-a", RoundID: "round-a",
		GameID: "game-a", DefinitionVersion: "math-v1",
		DefinitionHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		RoundKind:      rgs.RoundKindBase, Currency: "USD", DebitMinor: 100, CreditMinor: 250,
	}
	command.CommandDigest = rgs.CommandDigestFor(command)
	return command
}

func newResolutionTestWallet(
	t *testing.T,
	handler func(http.ResponseWriter, *http.Request, operator.SigningKey, time.Time),
) *HTTPWallet {
	t.Helper()
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
		KeyID: "rgs-request-v2", OperatorID: "operator-a",
		Purpose: operator.KeyPurposeHTTPRequest, PrivateKey: requestPrivate,
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
	}
	responseKey := operator.SigningKey{
		KeyID: "wallet-response-v2", OperatorID: "operator-a",
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
	responseVerifier, err := operator.NewResponseVerifier(ring, operator.RequestVerifierOptions{
		Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		handler(writer, request, responseKey, now)
	}))
	t.Cleanup(server.Close)
	httpWallet, err := NewHTTPWallet(HTTPConfig{
		BaseURL: server.URL, OperatorID: "operator-a", RequestSigningKey: requestKey,
		ResponseVerifier: responseVerifier, Client: server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return httpWallet
}

func writeResolutionTestResponse(
	t *testing.T,
	writer http.ResponseWriter,
	request *http.Request,
	responseKey operator.SigningKey,
	now time.Time,
	status int,
	payload walletResponse,
) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Errorf("marshal response: %v", err)
		return
	}
	response := &http.Response{StatusCode: status, Header: writer.Header()}
	if err := operator.SignResponse(response, body, responseKey, operator.ResponseSignatureParams{
		RequestID: request.Header.Get(operator.HeaderRequestID),
		Created:   now, Expires: now.Add(time.Minute),
	}); err != nil {
		t.Errorf("sign response: %v", err)
		return
	}
	writer.WriteHeader(status)
	_, _ = writer.Write(body)
}
