package rgsapi

import (
	"bytes"
	"context"
	"crypto/ed25519"
	cryptorand "crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"slots-game/server/internal/game"
	"slots-game/server/internal/operator"
	"slots-game/server/internal/rgs"
)

const (
	testOperatorID = "operator-a"
	testSessionID  = "session-a"
	testGameID     = "iron-colossus-demo"
	testDefinition = "definition-v1"
	testCurrency   = "EUR"
	testRegion     = "GB"
)

var testDefinitionHash = strings.Repeat("a", 64)

type fakeLaunchService struct {
	mu            sync.Mutex
	create        func(context.Context, LaunchCommand) (LaunchResult, error)
	exchange      func(context.Context, ExchangeCommand) (ExchangeResult, error)
	refresh       func(context.Context, RefreshCommand) (ExchangeResult, error)
	createCalls   int
	exchangeCalls int
	refreshCalls  int
	lastCreate    LaunchCommand
	lastExchange  ExchangeCommand
	lastRefresh   RefreshCommand
}

func (f *fakeLaunchService) CreateLaunch(ctx context.Context, command LaunchCommand) (LaunchResult, error) {
	f.mu.Lock()
	f.createCalls++
	f.lastCreate = command
	f.mu.Unlock()
	if f.create == nil {
		return LaunchResult{}, ErrUnavailable
	}
	return f.create(ctx, command)
}

func (f *fakeLaunchService) ExchangeSession(ctx context.Context, command ExchangeCommand) (ExchangeResult, error) {
	f.mu.Lock()
	f.exchangeCalls++
	f.lastExchange = command
	f.mu.Unlock()
	if f.exchange == nil {
		return ExchangeResult{}, ErrUnavailable
	}
	return f.exchange(ctx, command)
}

func (f *fakeLaunchService) RefreshSession(ctx context.Context, command RefreshCommand) (ExchangeResult, error) {
	f.mu.Lock()
	f.refreshCalls++
	f.lastRefresh = command
	f.mu.Unlock()
	if f.refresh == nil {
		return ExchangeResult{}, ErrUnavailable
	}
	return f.refresh(ctx, command)
}

type fakeCoordinator struct {
	mu          sync.Mutex
	spin        func(context.Context, rgs.SpinRequest) (rgs.SpinResult, error)
	pending     func(context.Context, string, string) (rgs.ResultDelivery, error)
	acknowledge func(context.Context, rgs.ResultDeliveryAcknowledgement) (rgs.ResultDelivery, bool, error)
	calls       int
	lastSpin    rgs.SpinRequest
}

func (f *fakeCoordinator) GetPendingResultDelivery(ctx context.Context, operatorID, sessionID string) (rgs.ResultDelivery, error) {
	if f.pending == nil {
		return rgs.ResultDelivery{}, rgs.ErrResultDeliveryNotFound
	}
	return f.pending(ctx, operatorID, sessionID)
}

func (f *fakeCoordinator) AcknowledgeResultDelivery(ctx context.Context, receipt rgs.ResultDeliveryAcknowledgement) (rgs.ResultDelivery, bool, error) {
	if f.acknowledge == nil {
		return rgs.ResultDelivery{}, false, rgs.ErrResultDeliveryNotFound
	}
	return f.acknowledge(ctx, receipt)
}

func (f *fakeCoordinator) Spin(ctx context.Context, request rgs.SpinRequest) (rgs.SpinResult, error) {
	f.mu.Lock()
	f.calls++
	f.lastSpin = request
	f.mu.Unlock()
	if f.spin == nil {
		return rgs.SpinResult{}, ErrUnavailable
	}
	return f.spin(ctx, request)
}

type fakeRoundReader struct {
	mu      sync.Mutex
	get     func(context.Context, rgs.RoundKey) (rgs.RoundRecord, error)
	calls   int
	lastKey rgs.RoundKey
}

func (f *fakeRoundReader) GetRound(ctx context.Context, key rgs.RoundKey) (rgs.RoundRecord, error) {
	f.mu.Lock()
	f.calls++
	f.lastKey = key
	f.mu.Unlock()
	if f.get == nil {
		return rgs.RoundRecord{}, rgs.ErrRoundNotFound
	}
	return f.get(ctx, key)
}

type securityFixture struct {
	now              time.Time
	requestSigning   operator.SigningKey
	responseSigning  operator.SigningKey
	responseVerifier *operator.ResponseVerifier
	accessIssuer     *operator.AccessTokenIssuer
	accessVerifier   *operator.AccessTokenVerifier
	requestVerifier  *operator.RequestVerifier
	nonceSequence    byte
}

func newSecurityFixture(t *testing.T) *securityFixture {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
	requestPublic, requestPrivate, err := ed25519.GenerateKey(cryptorand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	responsePublic, responsePrivate, err := ed25519.GenerateKey(cryptorand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	accessPublic, accessPrivate, err := ed25519.GenerateKey(cryptorand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	requestSigning := operator.SigningKey{
		KeyID: "request-key", OperatorID: testOperatorID,
		Purpose: operator.KeyPurposeHTTPRequest, PrivateKey: requestPrivate,
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour),
	}
	responseSigning := operator.SigningKey{
		KeyID: "response-key", OperatorID: testOperatorID,
		Purpose: operator.KeyPurposeHTTPResponse, PrivateKey: responsePrivate,
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour),
	}
	accessSigning := operator.SigningKey{
		KeyID: "access-key", OperatorID: testOperatorID,
		Purpose: operator.KeyPurposeAccessToken, PrivateKey: accessPrivate,
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour),
	}
	ring, err := operator.NewMemoryKeyRing(
		operator.VerificationKey{
			KeyID: requestSigning.KeyID, OperatorID: testOperatorID,
			Purpose: operator.KeyPurposeHTTPRequest, PublicKey: requestPublic,
			NotBefore: requestSigning.NotBefore, NotAfter: requestSigning.NotAfter,
		},
		operator.VerificationKey{
			KeyID: responseSigning.KeyID, OperatorID: testOperatorID,
			Purpose: operator.KeyPurposeHTTPResponse, PublicKey: responsePublic,
			NotBefore: responseSigning.NotBefore, NotAfter: responseSigning.NotAfter,
		},
		operator.VerificationKey{
			KeyID: accessSigning.KeyID, OperatorID: testOperatorID,
			Purpose: operator.KeyPurposeAccessToken, PublicKey: accessPublic,
			NotBefore: accessSigning.NotBefore, NotAfter: accessSigning.NotAfter,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	requestVerifier, err := operator.NewRequestVerifier(ring, operator.NewMemoryNonceStore(), operator.RequestVerifierOptions{
		Now: func() time.Time { return now },
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
	accessIssuer, err := operator.NewAccessTokenIssuer(accessSigning, operator.AccessTokenIssuerOptions{
		Issuer: "https://rgs.example", Audience: "iron-colossus-client",
		Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	accessVerifier, err := operator.NewAccessTokenVerifier(ring, operator.AccessTokenVerifierOptions{
		ExpectedIssuer: "https://rgs.example", ExpectedAudience: "iron-colossus-client",
		Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	return &securityFixture{
		now: now, requestSigning: requestSigning, responseSigning: responseSigning,
		responseVerifier: responseVerifier, accessIssuer: accessIssuer,
		accessVerifier: accessVerifier, requestVerifier: requestVerifier,
	}
}

func (f *securityFixture) newHandler(t *testing.T, launches *fakeLaunchService, spins *fakeCoordinator, rounds *fakeRoundReader) *Handler {
	return f.newHandlerWithAdmissions(t, launches, spins, rounds, nil, nil)
}

func (f *securityFixture) newHandlerWithAdmission(t *testing.T, launches *fakeLaunchService, spins *fakeCoordinator, rounds *fakeRoundReader, admission Admission) *Handler {
	return f.newHandlerWithAdmissions(t, launches, spins, rounds, admission, nil)
}

func (f *securityFixture) newHandlerWithAdmissions(
	t *testing.T,
	launches *fakeLaunchService,
	spins *fakeCoordinator,
	rounds *fakeRoundReader,
	operatorAdmission Admission,
	clientAdmission Admission,
) *Handler {
	t.Helper()
	handler, err := NewHandler(Config{
		OperatorRequests: f.requestVerifier, AccessTokens: f.accessVerifier,
		ResponseSigningKeys: ResponseSigningKeyResolverFunc(func(_ context.Context, operatorID string) (operator.SigningKey, error) {
			if operatorID != testOperatorID {
				return operator.SigningKey{}, errors.New("unknown tenant")
			}
			return f.responseSigning, nil
		}),
		Launches: launches, Spins: spins, Rounds: rounds,
		Admission: operatorAdmission, ClientAdmission: clientAdmission,
		Now: func() time.Time { return f.now }, NewRequestID: func() string { return "generated-request" },
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func (f *securityFixture) signOperatorRequest(t *testing.T, path string, body []byte) *http.Request {
	return f.signOperatorRequestWithIdempotency(t, path, body, testSessionID)
}

func (f *securityFixture) signOperatorRequestWithIdempotency(t *testing.T, path string, body []byte, idempotencyKey string) *http.Request {
	t.Helper()
	f.nonceSequence++
	request := httptest.NewRequest(http.MethodPost, "https://rgs.example"+path, bytes.NewReader(body))
	nonceBytes := bytes.Repeat([]byte{f.nonceSequence}, 16)
	requestID := "request-" + string(rune('a'+f.nonceSequence))
	err := operator.SignRequest(request, body, f.requestSigning, operator.RequestSignatureParams{
		RequestID: requestID, IdempotencyKey: idempotencyKey,
		Nonce:   base64.RawURLEncoding.EncodeToString(nonceBytes),
		Created: f.now, Expires: f.now.Add(time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	return request
}

func (f *securityFixture) issueAccessToken(t *testing.T, definitionHash string) string {
	return f.issueAccessTokenForSession(t, testSessionID, definitionHash)
}

func (f *securityFixture) issueAccessTokenForSession(t *testing.T, sessionID, definitionHash string) string {
	t.Helper()
	token, _, err := f.accessIssuer.Issue(operator.AccessTokenSubject{
		OperatorID: testOperatorID, PlayerID: "player-a", WalletSessionID: "wallet-session-a",
		SessionID: sessionID, GameID: testGameID,
		GameDefinitionVersion: testDefinition, GameDefinitionHash: definitionHash,
		Currency: testCurrency, CurrencyExponent: 2, Jurisdiction: testRegion,
	}, 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func TestOperatorLaunchIsAuthenticatedAndResponseSigned(t *testing.T) {
	security := newSecurityFixture(t)
	launches := &fakeLaunchService{}
	launches.create = func(_ context.Context, command LaunchCommand) (LaunchResult, error) {
		if command.OperatorID != testOperatorID || command.BalanceMinor != 12500 || command.SessionTTL != time.Hour {
			t.Fatalf("unexpected launch command: %+v", command)
		}
		return LaunchResult{
			LaunchCode:  validTestLaunchCode(1),
			ExchangeURL: "https://rgs.example" + ClientSessionExchangePath,
			ExpiresAt:   security.now.Add(2 * time.Minute),
		}, nil
	}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})
	body := operatorLaunchBody("12500")
	request := security.signOperatorRequest(t, OperatorLaunchPath, body)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	response := recorder.Result()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", response.StatusCode, responseBody)
	}
	if err := security.responseVerifier.Verify(context.Background(), response, responseBody, testOperatorID, request.Header.Get(operator.HeaderRequestID)); err != nil {
		t.Fatalf("signed response verification failed: %v", err)
	}
	if !bytes.Contains(responseBody, []byte(`"launchCode"`)) || bytes.Contains(responseBody, []byte(`"accessToken"`)) {
		t.Fatalf("unexpected launch response: %s", responseBody)
	}
	if launches.createCalls != 1 || launches.lastCreate.IdempotencyKey == "" {
		t.Fatalf("launch service calls = %d, command = %+v", launches.createCalls, launches.lastCreate)
	}
}

func TestOperatorErrorsAreSignedAndDoNotLeakInternalDetails(t *testing.T) {
	security := newSecurityFixture(t)
	launches := &fakeLaunchService{create: func(context.Context, LaunchCommand) (LaunchResult, error) {
		return LaunchResult{}, errors.New("postgres password and internal trace")
	}}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})
	request := security.signOperatorRequest(t, OperatorLaunchPath, operatorLaunchBody("12500"))
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	response := recorder.Result()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, body = %s", response.StatusCode, responseBody)
	}
	if bytes.Contains(responseBody, []byte("postgres")) || bytes.Contains(responseBody, []byte("trace")) {
		t.Fatalf("internal error leaked: %s", responseBody)
	}
	if err := security.responseVerifier.Verify(context.Background(), response, responseBody, testOperatorID, request.Header.Get(operator.HeaderRequestID)); err != nil {
		t.Fatalf("signed error verification failed: %v", err)
	}
}

func TestOperatorLaunchAcceptsIndependentHandoffIdempotencyKey(t *testing.T) {
	security := newSecurityFixture(t)
	launches := &fakeLaunchService{create: func(_ context.Context, command LaunchCommand) (LaunchResult, error) {
		if command.IdempotencyKey != "handoff-2" || command.SessionID != testSessionID {
			t.Fatalf("unexpected launch identity: %+v", command)
		}
		return LaunchResult{
			LaunchCode: validTestLaunchCode(9), ExchangeURL: "https://rgs.example" + ClientSessionExchangePath,
			ExpiresAt: security.now.Add(2 * time.Minute),
		}, nil
	}}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})
	request := security.signOperatorRequestWithIdempotency(t, OperatorLaunchPath, operatorLaunchBody("12500"), "handoff-2")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	response := recorder.Result()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusCreated || launches.createCalls != 1 ||
		!bytes.Contains(responseBody, []byte(`"launchCode"`)) {
		t.Fatalf("status = %d, calls = %d, body = %s", response.StatusCode, launches.createCalls, responseBody)
	}
	if err := security.responseVerifier.Verify(context.Background(), response, responseBody, testOperatorID, request.Header.Get(operator.HeaderRequestID)); err != nil {
		t.Fatalf("signed launch response verification failed: %v", err)
	}
}

func TestOperatorLaunchSignsRetainedHistoricalReplay(t *testing.T) {
	security := newSecurityFixture(t)
	historicalExpiry := security.now.Add(-time.Minute)
	launches := &fakeLaunchService{create: func(context.Context, LaunchCommand) (LaunchResult, error) {
		return LaunchResult{
			LaunchCode: validTestLaunchCode(10), ExchangeURL: "https://rgs.example" + ClientSessionExchangePath,
			ExpiresAt: historicalExpiry, HistoricalReplay: true,
		}, nil
	}}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})
	request := security.signOperatorRequestWithIdempotency(t, OperatorLaunchPath, operatorLaunchBody("12500"), "handoff-replay")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	response := recorder.Result()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusCreated || launches.createCalls != 1 ||
		!bytes.Contains(responseBody, []byte(formatTime(historicalExpiry))) {
		t.Fatalf("status = %d, calls = %d, body = %s", response.StatusCode, launches.createCalls, responseBody)
	}
	if err := security.responseVerifier.Verify(context.Background(), response, responseBody, testOperatorID, request.Header.Get(operator.HeaderRequestID)); err != nil {
		t.Fatalf("signed historical launch response verification failed: %v", err)
	}
}

func TestOperatorRateLimitResponseIsSigned(t *testing.T) {
	security := newSecurityFixture(t)
	launches := &fakeLaunchService{create: func(context.Context, LaunchCommand) (LaunchResult, error) {
		t.Fatal("rate-limited request reached launch service")
		return LaunchResult{}, nil
	}}
	var admittedKey string
	handler := security.newHandlerWithAdmission(t, launches, &fakeCoordinator{}, &fakeRoundReader{}, AdmissionFunc(func(key string, _ time.Time) bool {
		admittedKey = key
		return false
	}))
	request := security.signOperatorRequest(t, OperatorLaunchPath, operatorLaunchBody("12500"))
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	response := recorder.Result()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusTooManyRequests || response.Header.Get("Retry-After") != "1" {
		t.Fatalf("status = %d, retry-after = %q, body = %s", response.StatusCode, response.Header.Get("Retry-After"), responseBody)
	}
	if admittedKey != "operator:"+testOperatorID {
		t.Fatalf("admission key = %q", admittedKey)
	}
	if launches.createCalls != 0 {
		t.Fatalf("launch calls = %d", launches.createCalls)
	}
	if err := security.responseVerifier.Verify(context.Background(), response, responseBody, testOperatorID, request.Header.Get(operator.HeaderRequestID)); err != nil {
		t.Fatalf("signed rate-limit response verification failed: %v", err)
	}
	if !bytes.Contains(responseBody, []byte(`"code":"RATE_LIMITED"`)) {
		t.Fatalf("unexpected body: %s", responseBody)
	}
}

func TestOperatorRateLimitDoesNotConsumeNonce(t *testing.T) {
	security := newSecurityFixture(t)
	body := operatorLaunchBody("12500")
	request := security.signOperatorRequest(t, OperatorLaunchPath, body)
	rejected := security.newHandlerWithAdmission(
		t,
		&fakeLaunchService{},
		&fakeCoordinator{},
		&fakeRoundReader{},
		AdmissionFunc(func(string, time.Time) bool { return false }),
	)
	first := httptest.NewRecorder()
	rejected.ServeHTTP(first, request)
	if first.Code != http.StatusTooManyRequests {
		t.Fatalf("first status = %d, body = %s", first.Code, first.Body.Bytes())
	}

	// 429 发生在任何业务副作用之前；同一签名请求稍后应可原样重试，随机数不能被提前消费。
	request.Body = io.NopCloser(bytes.NewReader(body))
	request.ContentLength = int64(len(body))
	launches := &fakeLaunchService{create: func(context.Context, LaunchCommand) (LaunchResult, error) {
		return LaunchResult{}, ErrUnavailable
	}}
	accepted := security.newHandlerWithAdmission(
		t,
		launches,
		&fakeCoordinator{},
		&fakeRoundReader{},
		AdmissionFunc(func(string, time.Time) bool { return true }),
	)
	second := httptest.NewRecorder()
	accepted.ServeHTTP(second, request)
	if second.Code != http.StatusServiceUnavailable || launches.createCalls != 1 {
		t.Fatalf(
			"second status = %d, launch calls = %d, body = %s",
			second.Code,
			launches.createCalls,
			second.Body.Bytes(),
		)
	}
}

func TestUnauthenticatedOperatorRequestCannotConsumeTenantAdmission(t *testing.T) {
	security := newSecurityFixture(t)
	admissionCalls := 0
	handler := security.newHandlerWithAdmission(
		t, &fakeLaunchService{}, &fakeCoordinator{}, &fakeRoundReader{},
		AdmissionFunc(func(string, time.Time) bool {
			admissionCalls++
			return true
		}),
	)
	request := security.signOperatorRequest(t, OperatorLaunchPath, operatorLaunchBody("12500"))
	request.Header.Set(operator.HeaderSignature, "invalid")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.Bytes())
	}
	if admissionCalls != 0 {
		t.Fatalf("unauthenticated request consumed tenant admission %d times", admissionCalls)
	}
}

func TestVerifiedClientAdmissionIsSessionScopedAndIndependentOfProxyAddress(t *testing.T) {
	security := newSecurityFixture(t)
	launches := &fakeLaunchService{refresh: func(context.Context, RefreshCommand) (ExchangeResult, error) {
		return ExchangeResult{}, ErrUnavailable
	}}
	admissionCalls := make(map[string]int)
	clientAdmission := AdmissionFunc(func(key string, _ time.Time) bool {
		admissionCalls[key]++
		return admissionCalls[key] == 1
	})
	handler := security.newHandlerWithAdmissions(
		t, launches, &fakeCoordinator{}, &fakeRoundReader{}, nil, clientAdmission,
	)

	tokenA := security.issueAccessTokenForSession(t, "session-a", testDefinitionHash)
	tokenB := security.issueAccessTokenForSession(t, "session-b", testDefinitionHash)
	requests := []struct {
		name       string
		token      string
		sessionID  string
		remoteAddr string
		wantStatus int
	}{
		{name: "session A first proxy", token: tokenA, sessionID: "session-a", remoteAddr: "10.0.0.10:1001", wantStatus: http.StatusServiceUnavailable},
		{name: "session B same proxy", token: tokenB, sessionID: "session-b", remoteAddr: "10.0.0.10:1002", wantStatus: http.StatusServiceUnavailable},
		{name: "session A different proxy", token: tokenA, sessionID: "session-a", remoteAddr: "10.0.0.11:1003", wantStatus: http.StatusTooManyRequests},
	}
	for _, test := range requests {
		t.Run(test.name, func(t *testing.T) {
			request := clientRequest(
				ClientSessionRefreshPath,
				sessionBindingBodyForSession(test.sessionID, testDefinitionHash),
				test.token,
			)
			request.RemoteAddr = test.remoteAddr
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			if recorder.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d, body = %s", recorder.Code, test.wantStatus, recorder.Body.Bytes())
			}
		})
	}
	if admissionCalls["client:operator-a:session-a"] != 2 ||
		admissionCalls["client:operator-a:session-b"] != 1 || len(admissionCalls) != 2 {
		t.Fatalf("client admission calls = %#v", admissionCalls)
	}
}

func TestInvalidClientTokenCannotConsumeClientAdmission(t *testing.T) {
	security := newSecurityFixture(t)
	admissionCalls := 0
	handler := security.newHandlerWithAdmissions(
		t, &fakeLaunchService{}, &fakeCoordinator{}, &fakeRoundReader{}, nil,
		AdmissionFunc(func(string, time.Time) bool {
			admissionCalls++
			return true
		}),
	)
	request := clientRequest(
		ClientSessionRefreshPath,
		sessionBindingBody(testDefinitionHash),
		"not-a-valid-access-token",
	)
	request.RemoteAddr = "10.0.0.12:1004"
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.Bytes())
	}
	if admissionCalls != 0 {
		t.Fatalf("invalid token consumed client admission %d times", admissionCalls)
	}
}

func TestClientAdmissionKeyCannotCollideAcrossColonBearingClaims(t *testing.T) {
	if clientAdmissionKey("operator-a", "session-a") != "client:operator-a:session-a" {
		t.Fatal("ordinary client admission key changed unexpectedly")
	}
	if clientAdmissionKey("operator:a", "session") == clientAdmissionKey("operator", "a:session") {
		t.Fatal("distinct verified operator/session tuples share one client admission key")
	}
}

func TestChunkedBodyRejectedByOuterLimitKeepsBodyTooLargeEnvelope(t *testing.T) {
	security := newSecurityFixture(t)
	handler := security.newHandler(t, &fakeLaunchService{}, &fakeCoordinator{}, &fakeRoundReader{})
	request := security.signOperatorRequest(t, OperatorLaunchPath, operatorLaunchBody("12500"))
	request.ContentLength = -1
	request.Body = http.MaxBytesReader(httptest.NewRecorder(), request.Body, 32)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusRequestEntityTooLarge ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"code":"BODY_TOO_LARGE"`)) {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.Bytes())
	}
}

func TestManualReviewMapsToLockedSessionContract(t *testing.T) {
	for _, target := range []error{rgs.ErrManualReview, rgs.ErrSessionIntegrity} {
		status, code, message := mapError(fmt.Errorf("persisted integrity: %w", target))
		if status != http.StatusLocked || code != "MANUAL_REVIEW" || message == "" {
			t.Fatalf("mapError(%v) = (%d, %q, %q)", target, status, code, message)
		}
	}
}

func TestResultDeliveryErrorsHaveExplicitConflictContracts(t *testing.T) {
	for _, test := range []struct {
		err  error
		code string
	}{
		{err: rgs.ErrResultDeliveryPending, code: "RESULT_DELIVERY_PENDING"},
		{err: rgs.ErrResultDeliveryMismatch, code: "RESULT_DELIVERY_MISMATCH"},
	} {
		status, code, message := mapError(test.err)
		if status != http.StatusConflict || code != test.code || message == "" {
			t.Fatalf("mapError(%v) = (%d, %q, %q)", test.err, status, code, message)
		}
	}
}

func TestDatabaseTimeoutsUseExistingServiceUnavailableContract(t *testing.T) {
	for _, state := range []string{"55P03", "57014"} {
		status, code, message := mapError(fmt.Errorf("postgres request: %w", testSQLStateError(state)))
		if status != http.StatusServiceUnavailable || code != "SERVICE_UNAVAILABLE" || message == "" {
			t.Fatalf("mapError(%s) = (%d, %q, %q)", state, status, code, message)
		}
	}
}

type testSQLStateError string

func (err testSQLStateError) Error() string    { return string(err) }
func (err testSQLStateError) SQLState() string { return string(err) }

func TestTimedOutOperatorRequestStillReturnsSignedServiceUnavailable(t *testing.T) {
	security := newSecurityFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	launches := &fakeLaunchService{create: func(context.Context, LaunchCommand) (LaunchResult, error) {
		cancel()
		return LaunchResult{}, context.DeadlineExceeded
	}}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})
	handler.responseSigningKeys = ResponseSigningKeyResolverFunc(func(ctx context.Context, operatorID string) (operator.SigningKey, error) {
		if err := ctx.Err(); err != nil {
			return operator.SigningKey{}, err
		}
		if operatorID != testOperatorID {
			return operator.SigningKey{}, errors.New("unknown tenant")
		}
		return security.responseSigning, nil
	})
	request := security.signOperatorRequest(t, OperatorLaunchPath, operatorLaunchBody("12500")).WithContext(ctx)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	response := recorder.Result()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusServiceUnavailable || !bytes.Contains(responseBody, []byte(`"code":"SERVICE_UNAVAILABLE"`)) {
		t.Fatalf("status = %d, body = %s", response.StatusCode, responseBody)
	}
	if err := security.responseVerifier.Verify(context.Background(), response, responseBody, testOperatorID, request.Header.Get(operator.HeaderRequestID)); err != nil {
		t.Fatalf("timed-out signed response verification failed: %v", err)
	}
}

func TestClientCanDiscoverAndAcknowledgePendingResultWithoutStoredRoundID(t *testing.T) {
	security := newSecurityFixture(t)
	token := security.issueAccessToken(t, testDefinitionHash)
	result := committedResult(validSpinRequest())
	hash, err := rgs.CommittedResultHashFor(result)
	if err != nil {
		t.Fatal(err)
	}
	acknowledgedAt := security.now.Add(time.Minute)
	spins := &fakeCoordinator{
		pending: func(_ context.Context, operatorID, sessionID string) (rgs.ResultDelivery, error) {
			if operatorID != testOperatorID || sessionID != testSessionID {
				t.Fatalf("pending binding = %s/%s", operatorID, sessionID)
			}
			return rgs.ResultDelivery{
				OperatorID: operatorID, SessionID: sessionID, RoundID: result.RoundID,
				Sequence: result.Sequence, ResultHash: hash, Result: result,
				OriginFeatureState: game.EmptyFeatureState(),
			}, nil
		},
		acknowledge: func(_ context.Context, receipt rgs.ResultDeliveryAcknowledgement) (rgs.ResultDelivery, bool, error) {
			if receipt.RoundID != result.RoundID || receipt.Sequence != result.Sequence || receipt.ResultHash != hash {
				t.Fatalf("ACK receipt = %+v", receipt)
			}
			return rgs.ResultDelivery{
				OperatorID: receipt.OperatorID, SessionID: receipt.SessionID,
				RoundID: receipt.RoundID, Sequence: receipt.Sequence,
				ResultHash: receipt.ResultHash, AcknowledgedAt: acknowledgedAt,
			}, true, nil
		},
	}
	handler := security.newHandler(t, &fakeLaunchService{}, spins, &fakeRoundReader{})
	discover := httptest.NewRequest(http.MethodGet, "https://rgs.example"+ClientPendingResultPath, nil)
	discover.Header.Set(operator.HeaderRequestID, "client-request")
	discover.Header.Set(operator.HeaderOperatorID, testOperatorID)
	discover.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, discover)
	if recorder.Code != http.StatusOK || !bytes.Contains(recorder.Body.Bytes(), []byte(`"resultHash":"`+hash+`"`)) ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"originFeature":{"mode":"NONE"`)) {
		t.Fatalf("discover status=%d body=%s", recorder.Code, recorder.Body.Bytes())
	}

	body := map[string]any{
		"operatorId": testOperatorID, "sessionId": testSessionID,
		"gameId": testGameID, "definitionVersion": testDefinition,
		"definitionHash": testDefinitionHash, "currency": testCurrency,
		"currencyExponent": 2, "jurisdiction": testRegion,
	}
	body["roundId"] = result.RoundID
	body["sequence"] = strconv.FormatUint(result.Sequence, 10)
	body["resultHash"] = hash
	encoded, _ := json.Marshal(body)
	ack := clientRequest(ClientResultAckPath, encoded, token)
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, ack)
	if recorder.Code != http.StatusOK || !bytes.Contains(recorder.Body.Bytes(), []byte(`"acknowledgedAt":"`)) {
		t.Fatalf("ACK status=%d body=%s", recorder.Code, recorder.Body.Bytes())
	}
}

func TestPendingResultDiscoveryUsesNoContentWhenCursorIsEmpty(t *testing.T) {
	security := newSecurityFixture(t)
	token := security.issueAccessToken(t, testDefinitionHash)
	handler := security.newHandler(t, &fakeLaunchService{}, &fakeCoordinator{}, &fakeRoundReader{})
	request := httptest.NewRequest(http.MethodGet, "https://rgs.example"+ClientPendingResultPath, nil)
	request.Header.Set(operator.HeaderOperatorID, testOperatorID)
	request.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent || recorder.Body.Len() != 0 {
		t.Fatalf("status=%d body=%q", recorder.Code, recorder.Body.String())
	}
}

func TestPendingResultDiscoveryRejectsNonCanonicalPersistedOrigin(t *testing.T) {
	security := newSecurityFixture(t)
	token := security.issueAccessToken(t, testDefinitionHash)
	result := committedResult(validSpinRequest())
	hash, err := rgs.CommittedResultHashFor(result)
	if err != nil {
		t.Fatal(err)
	}
	spins := &fakeCoordinator{pending: func(
		_ context.Context,
		operatorID string,
		sessionID string,
	) (rgs.ResultDelivery, error) {
		return rgs.ResultDelivery{
			OperatorID: operatorID, SessionID: sessionID, RoundID: result.RoundID,
			Sequence: result.Sequence, ResultHash: hash, Result: result,
			OriginFeatureState: game.FeatureState{
				Mode: game.FeatureExpansion, RageLevel: game.DefaultRageLevel,
			},
		}, nil
	}}
	handler := security.newHandler(t, &fakeLaunchService{}, spins, &fakeRoundReader{})
	request := httptest.NewRequest(http.MethodGet, "https://rgs.example"+ClientPendingResultPath, nil)
	request.Header.Set(operator.HeaderOperatorID, testOperatorID)
	request.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"code":"SERVICE_UNAVAILABLE"`)) ||
		bytes.Contains(recorder.Body.Bytes(), []byte("originFeature")) {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.Bytes())
	}
}

func TestOperatorPanicRecoveryResponseIsSigned(t *testing.T) {
	security := newSecurityFixture(t)
	launches := &fakeLaunchService{create: func(context.Context, LaunchCommand) (LaunchResult, error) {
		panic("sensitive panic value")
	}}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})
	request := security.signOperatorRequest(t, OperatorLaunchPath, operatorLaunchBody("12500"))
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	response := recorder.Result()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusInternalServerError || bytes.Contains(responseBody, []byte("sensitive")) {
		t.Fatalf("status = %d, body = %s", response.StatusCode, responseBody)
	}
	if err := security.responseVerifier.Verify(context.Background(), response, responseBody, testOperatorID, request.Header.Get(operator.HeaderRequestID)); err != nil {
		t.Fatalf("signed panic response verification failed: %v", err)
	}
}

func TestSessionExchangeConsumesCodeThenReturnsVerifiedAccessToken(t *testing.T) {
	security := newSecurityFixture(t)
	token := security.issueAccessToken(t, testDefinitionHash)
	session := validSession(security.now)
	launches := &fakeLaunchService{exchange: func(_ context.Context, command ExchangeCommand) (ExchangeResult, error) {
		if command.LaunchCode != validTestLaunchCode(2) || command.OperatorID != testOperatorID || command.SessionID != testSessionID {
			t.Fatalf("unexpected exchange command: %+v", command)
		}
		return ExchangeResult{Session: session, AccessToken: token}, nil
	}}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})
	body := []byte(`{"launchCode":"` + validTestLaunchCode(2) + `","operatorId":"operator-a","sessionId":"session-a"}`)
	request := clientRequest(ClientSessionExchangePath, body, "")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.Bytes())
	}
	if !bytes.Contains(recorder.Body.Bytes(), []byte(`"accessToken"`)) || !bytes.Contains(recorder.Body.Bytes(), []byte(`"definitionHash":"`+testDefinitionHash+`"`)) {
		t.Fatalf("unexpected exchange response: %s", recorder.Body.Bytes())
	}
	if launches.exchangeCalls != 1 {
		t.Fatalf("exchange calls = %d", launches.exchangeCalls)
	}
}

func TestSessionExchangeRejectsAuthorizationHeader(t *testing.T) {
	security := newSecurityFixture(t)
	launches := &fakeLaunchService{exchange: func(context.Context, ExchangeCommand) (ExchangeResult, error) {
		t.Fatal("exchange service must not be called")
		return ExchangeResult{}, nil
	}}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})
	body := []byte(`{"launchCode":"` + validTestLaunchCode(3) + `","operatorId":"operator-a","sessionId":"session-a"}`)
	request := clientRequest(ClientSessionExchangePath, body, "unexpected-token")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest || launches.exchangeCalls != 0 {
		t.Fatalf("status = %d, calls = %d, body = %s", recorder.Code, launches.exchangeCalls, recorder.Body.Bytes())
	}
}

func TestSessionRefreshRotatesTokenForTheBoundActiveSession(t *testing.T) {
	security := newSecurityFixture(t)
	oldToken := security.issueAccessToken(t, testDefinitionHash)
	newToken := security.issueAccessToken(t, testDefinitionHash)
	session := validSession(security.now)
	launches := &fakeLaunchService{refresh: func(_ context.Context, command RefreshCommand) (ExchangeResult, error) {
		if command.RequestID != "client-request" ||
			command.Claims.OperatorID != testOperatorID ||
			command.Claims.SessionID != testSessionID ||
			command.Claims.GameDefinitionHash != testDefinitionHash {
			t.Fatalf("unexpected refresh command: %+v", command)
		}
		return ExchangeResult{Session: session, AccessToken: newToken}, nil
	}}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})
	request := clientRequest(ClientSessionRefreshPath, sessionBindingBody(testDefinitionHash), oldToken)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.Bytes())
	}
	if launches.refreshCalls != 1 || launches.lastRefresh.Claims.TokenID == "" {
		t.Fatalf("unexpected refresh calls: %d, command: %+v", launches.refreshCalls, launches.lastRefresh)
	}
	if !bytes.Contains(recorder.Body.Bytes(), []byte(`"accessToken":"`+newToken+`"`)) ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"sessionId":"`+testSessionID+`"`)) {
		t.Fatalf("unexpected refresh response: %s", recorder.Body.Bytes())
	}
}

func TestClientSpinBindsEveryTokenDimension(t *testing.T) {
	security := newSecurityFixture(t)
	token := security.issueAccessToken(t, testDefinitionHash)
	coordinator := &fakeCoordinator{spin: func(_ context.Context, request rgs.SpinRequest) (rgs.SpinResult, error) {
		return committedResult(request), nil
	}}
	handler := security.newHandler(t, &fakeLaunchService{}, coordinator, &fakeRoundReader{})
	body := clientSpinBody(testDefinitionHash)
	request := clientRequest(ClientSpinPath, body, token)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.Bytes())
	}
	if coordinator.calls != 1 || coordinator.lastSpin.BetMinor != 100 || coordinator.lastSpin.StartRevision != 0 {
		t.Fatalf("unexpected coordinator call: %+v", coordinator.lastSpin)
	}
	if !bytes.Contains(recorder.Body.Bytes(), []byte(`"balanceMinor":"10100"`)) {
		t.Fatalf("minor units were not encoded as strings: %s", recorder.Body.Bytes())
	}

	tampered := clientRequest(ClientSpinPath, clientSpinBody(strings.Repeat("b", 64)), token)
	tamperedRecorder := httptest.NewRecorder()
	handler.ServeHTTP(tamperedRecorder, tampered)
	if tamperedRecorder.Code != http.StatusForbidden || coordinator.calls != 1 {
		t.Fatalf("binding tamper status = %d, calls = %d, body = %s", tamperedRecorder.Code, coordinator.calls, tamperedRecorder.Body.Bytes())
	}
}

func TestPendingRoundStatusNeverRevealsPreparedOutcome(t *testing.T) {
	security := newSecurityFixture(t)
	token := security.issueAccessToken(t, testDefinitionHash)
	requestModel := validSpinRequest()
	rounds := &fakeRoundReader{get: func(_ context.Context, key rgs.RoundKey) (rgs.RoundRecord, error) {
		return rgs.RoundRecord{
			Key: key, Request: requestModel, Status: rgs.RoundWalletPending,
			Result: rgs.SpinResult{TotalWinMinor: 987654321},
		}, nil
	}}
	handler := security.newHandler(t, &fakeLaunchService{}, &fakeCoordinator{}, rounds)
	body := roundStatusBody()
	request := clientRequest(ClientRoundStatusPath, body, token)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.Bytes())
	}
	if bytes.Contains(recorder.Body.Bytes(), []byte("987654321")) || bytes.Contains(recorder.Body.Bytes(), []byte(`"result"`)) {
		t.Fatalf("prepared outcome leaked: %s", recorder.Body.Bytes())
	}
	if !bytes.Contains(recorder.Body.Bytes(), []byte(`"status":"WALLET_PENDING"`)) {
		t.Fatalf("missing pending state: %s", recorder.Body.Bytes())
	}
}

func TestRoundStatusIntegrityFailureReturnsLockedWithoutLeakingOutcome(t *testing.T) {
	security := newSecurityFixture(t)
	token := security.issueAccessToken(t, testDefinitionHash)
	rounds := &fakeRoundReader{get: func(context.Context, rgs.RoundKey) (rgs.RoundRecord, error) {
		// 生产环境中该对象为协调器状态服务，会在返回通用人工复核哨兵错误前持久执行隔离。
		return rgs.RoundRecord{}, rgs.ErrManualReview
	}}
	handler := security.newHandler(t, &fakeLaunchService{}, &fakeCoordinator{}, rounds)
	request := clientRequest(ClientRoundStatusPath, roundStatusBody(), token)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusLocked ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"code":"MANUAL_REVIEW"`)) ||
		bytes.Contains(recorder.Body.Bytes(), []byte(`"result"`)) {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.Bytes())
	}
	if rounds.calls != 1 {
		t.Fatalf("status service calls = %d, want 1", rounds.calls)
	}
}

func TestOperatorRoundStatusResponseIsSigned(t *testing.T) {
	security := newSecurityFixture(t)
	requestModel := validSpinRequest()
	result := committedResult(requestModel)
	rounds := &fakeRoundReader{get: func(_ context.Context, key rgs.RoundKey) (rgs.RoundRecord, error) {
		return rgs.RoundRecord{Key: key, Request: requestModel, Status: rgs.RoundCommitted, Result: result}, nil
	}}
	handler := security.newHandler(t, &fakeLaunchService{}, &fakeCoordinator{}, rounds)
	body := roundStatusBody()
	request := security.signOperatorRequest(t, OperatorRoundStatusPath, body)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	response := recorder.Result()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.StatusCode, responseBody)
	}
	if err := security.responseVerifier.Verify(context.Background(), response, responseBody, testOperatorID, request.Header.Get(operator.HeaderRequestID)); err != nil {
		t.Fatalf("status response signature failed: %v", err)
	}
	if !bytes.Contains(responseBody, []byte(`"status":"COMMITTED"`)) || !bytes.Contains(responseBody, []byte(`"result"`)) {
		t.Fatalf("unexpected response: %s", responseBody)
	}
}

func TestStrictTransportAndJSONFailuresUseEnvelope(t *testing.T) {
	security := newSecurityFixture(t)
	handler := security.newHandler(t, &fakeLaunchService{}, &fakeCoordinator{}, &fakeRoundReader{})
	tests := []struct {
		name       string
		request    *http.Request
		wantStatus int
		wantCode   string
	}{
		{
			name: "method", request: httptest.NewRequest(http.MethodGet, ClientSpinPath, nil),
			wantStatus: http.StatusMethodNotAllowed, wantCode: "METHOD_NOT_ALLOWED",
		},
		{
			name: "content type parameters",
			request: func() *http.Request {
				r := httptest.NewRequest(http.MethodPost, ClientSpinPath, strings.NewReader(`{}`))
				r.Header.Set("Content-Type", "application/json; charset=utf-8")
				return r
			}(),
			wantStatus: http.StatusUnsupportedMediaType, wantCode: "UNSUPPORTED_MEDIA_TYPE",
		},
		{
			name:       "unknown field",
			request:    clientRequest(ClientSpinPath, append(bytes.TrimSuffix(clientSpinBody(testDefinitionHash), []byte("}")), []byte(`,"unexpected":true}`)...), "token"),
			wantStatus: http.StatusBadRequest, wantCode: "INVALID_JSON",
		},
		{
			name:       "duplicate field",
			request:    clientRequest(ClientSessionExchangePath, []byte(`{"launchCode":"`+validTestLaunchCode(4)+`","operatorId":"operator-a","operatorId":"operator-a","sessionId":"session-a"}`), ""),
			wantStatus: http.StatusBadRequest, wantCode: "INVALID_JSON",
		},
		{
			name:       "field name casing",
			request:    clientRequest(ClientSessionExchangePath, []byte(`{"launchCode":"`+validTestLaunchCode(5)+`","OperatorId":"operator-a","sessionId":"session-a"}`), ""),
			wantStatus: http.StatusBadRequest, wantCode: "INVALID_JSON",
		},
		{
			name:       "query",
			request:    clientRequest(ClientSessionExchangePath+"?debug=1", []byte(`{}`), ""),
			wantStatus: http.StatusBadRequest, wantCode: "INVALID_REQUEST",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, test.request)
			if recorder.Code != test.wantStatus || !bytes.Contains(recorder.Body.Bytes(), []byte(`"code":"`+test.wantCode+`"`)) {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.Bytes())
			}
			if recorder.Header().Get("Content-Type") != "application/json" || recorder.Header().Get(operator.HeaderRequestID) == "" {
				t.Fatalf("missing envelope headers: %v", recorder.Header())
			}
		})
	}
}

func TestStrictJSONRejectsExcessiveNestingBeforeTypedDecode(t *testing.T) {
	const maximumDepth = 32
	type nestedDocument struct {
		Value any `json:"value"`
	}
	makeArrayDocument := func(nestedArrays int) []byte {
		return []byte(
			`{"value":` + strings.Repeat("[", nestedArrays) + `0` +
				strings.Repeat("]", nestedArrays) + `}`,
		)
	}

	// 顶层对象也计入深度，因此其下最多再容纳 maximumDepth-1 层容器。
	var accepted nestedDocument
	if err := decodeStrictJSON(makeArrayDocument(maximumDepth-1), &accepted); err != nil {
		t.Fatalf("maximum nesting was rejected: %v", err)
	}
	var rejected nestedDocument
	if err := decodeStrictJSON(makeArrayDocument(maximumDepth), &rejected); err == nil {
		t.Fatal("maximum+1 nesting was accepted")
	}
}

func TestStrictJSONRejectsTenThousandObjectNestingBomb(t *testing.T) {
	const nestedObjects = 9_000
	type nestedDocument struct {
		Value any `json:"value"`
	}
	body := []byte(
		`{"value":` + strings.Repeat(`{"a":`, nestedObjects) + `0` +
			strings.Repeat("}", nestedObjects+1),
	)
	if len(body) > int(DefaultMaxRequestBytes) {
		t.Fatalf("bomb fixture = %d bytes, exceeds request limit", len(body))
	}
	var decoded nestedDocument
	if err := decodeStrictJSON(body, &decoded); err == nil {
		t.Fatal("deep object nesting bomb was accepted")
	}
}

func TestRequestBodyLimitAppliesWhenContentLengthIsUnknown(t *testing.T) {
	security := newSecurityFixture(t)
	handler := security.newHandler(t, &fakeLaunchService{}, &fakeCoordinator{}, &fakeRoundReader{})
	handler.maxRequestBytes = 8
	request := clientRequest(ClientSessionExchangePath, []byte(`{"more":"than-eight"}`), "")
	request.ContentLength = -1
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusRequestEntityTooLarge || !bytes.Contains(recorder.Body.Bytes(), []byte(`"code":"BODY_TOO_LARGE"`)) {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.Bytes())
	}
}

func TestNewHandlerRequiresSecurityAndDomainDependencies(t *testing.T) {
	if _, err := NewHandler(Config{}); err == nil {
		t.Fatal("empty handler configuration was accepted")
	}
}

func operatorLaunchBody(balance string) []byte {
	payload := map[string]any{
		"playerId": "player-a", "walletAccountId": "wallet-account-a",
		"walletSessionId": "wallet-session-a", "sessionId": testSessionID,
		"gameId": testGameID, "definitionVersion": testDefinition,
		"definitionHash": testDefinitionHash, "currency": testCurrency,
		"currencyExponent": 2, "jurisdiction": testRegion,
		"balanceMinor": balance, "sessionTtlSeconds": 3600,
	}
	encoded, _ := json.Marshal(payload)
	return encoded
}

func clientSpinBody(definitionHash string) []byte {
	payload := map[string]any{
		"operatorId": testOperatorID, "sessionId": testSessionID,
		"gameId": testGameID, "definitionVersion": testDefinition,
		"definitionHash": definitionHash, "currency": testCurrency,
		"currencyExponent": 2, "jurisdiction": testRegion,
		"roundId": "round-a", "roundKind": "BASE",
		"betMinor": "100", "startRevision": "0",
	}
	encoded, _ := json.Marshal(payload)
	return encoded
}

func sessionBindingBody(definitionHash string) []byte {
	return sessionBindingBodyForSession(testSessionID, definitionHash)
}

func sessionBindingBodyForSession(sessionID, definitionHash string) []byte {
	payload := map[string]any{
		"operatorId": testOperatorID, "sessionId": sessionID,
		"gameId": testGameID, "definitionVersion": testDefinition,
		"definitionHash": definitionHash, "currency": testCurrency,
		"currencyExponent": 2, "jurisdiction": testRegion,
	}
	encoded, _ := json.Marshal(payload)
	return encoded
}

func roundStatusBody() []byte {
	payload := map[string]any{
		"operatorId": testOperatorID, "sessionId": testSessionID,
		"gameId": testGameID, "definitionVersion": testDefinition,
		"definitionHash": testDefinitionHash, "currency": testCurrency,
		"currencyExponent": 2, "jurisdiction": testRegion, "roundId": "round-a",
	}
	encoded, _ := json.Marshal(payload)
	return encoded
}

func clientRequest(path string, body []byte, token string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "https://rgs.example"+path, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(operator.HeaderRequestID, "client-request")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	return request
}

func validTestLaunchCode(fill byte) string {
	return "lc_" + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{fill}, 32))
}

func validSession(now time.Time) rgs.Session {
	return rgs.Session{
		OperatorID: testOperatorID, SessionID: testSessionID,
		PlayerID: "player-a", WalletAccountID: "wallet-account-a",
		WalletSessionID: "wallet-session-a", GameID: testGameID,
		DefinitionVersion: testDefinition, DefinitionHash: testDefinitionHash,
		Currency: testCurrency, CurrencyExponent: 2, Jurisdiction: testRegion,
		Status: rgs.SessionActive, ExpiresAt: now.Add(time.Hour), BalanceMinor: 10000,
		Feature: game.EmptyFeatureState(),
	}
}

func validSpinRequest() rgs.SpinRequest {
	return rgs.SpinRequest{
		OperatorID: testOperatorID, SessionID: testSessionID, RoundID: "round-a",
		GameID: testGameID, DefinitionVersion: testDefinition,
		DefinitionHash: testDefinitionHash, Currency: testCurrency,
		RoundKind: rgs.RoundKindBase, BetMinor: 100, StartRevision: 0,
	}
}

func committedResult(request rgs.SpinRequest) rgs.SpinResult {
	return rgs.SpinResult{
		OperatorID: request.OperatorID, SessionID: request.SessionID,
		RoundID: request.RoundID, GameID: request.GameID,
		DefinitionVersion: request.DefinitionVersion, DefinitionHash: request.DefinitionHash,
		Currency: request.Currency, RoundKind: request.RoundKind,
		ServerTransactionID: "server-transaction-a", WalletTransactionID: "wallet-transaction-a",
		StartRevision: request.StartRevision, EndRevision: request.StartRevision + 1,
		Sequence: 1, BetMinor: request.BetMinor, ChargedBetMinor: request.BetMinor,
		BalanceMinor: 10100, TotalWinMinor: 0,
		Grid: game.Grid{
			{{Symbol: game.SymbolOrbit}, {Symbol: game.SymbolPrism}, {Symbol: game.SymbolPulse}},
			{{Symbol: game.SymbolNova}, {Symbol: game.SymbolCircuit}, {Symbol: game.SymbolTank}},
			{{Symbol: game.SymbolPrism}, {Symbol: game.SymbolPulse}, {Symbol: game.SymbolNova}},
		},
		Wins: []game.Win{}, Events: []game.Event{}, FeatureState: game.EmptyFeatureState(),
	}
}
