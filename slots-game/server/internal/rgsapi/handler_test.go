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
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"slots-game/server/internal/game"
	"slots-game/server/internal/launch"
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
	mu             sync.Mutex
	create         func(context.Context, LaunchCommand) (LaunchResult, error)
	exchange       func(context.Context, ExchangeCommand) (ExchangeResult, error)
	refresh        func(context.Context, RefreshCommand) (ExchangeResult, error)
	authorize      func(context.Context, SessionAuthorizationCommand) (rgs.Session, error)
	createCalls    int
	exchangeCalls  int
	refreshCalls   int
	authorizeCalls int
	lastCreate     LaunchCommand
	lastExchange   ExchangeCommand
	lastRefresh    RefreshCommand
	lastAuthorize  SessionAuthorizationCommand
}

func (f *fakeLaunchService) AuthorizeSession(ctx context.Context, command SessionAuthorizationCommand) (rgs.Session, error) {
	f.mu.Lock()
	f.authorizeCalls++
	f.lastAuthorize = command
	f.mu.Unlock()
	if f.authorize != nil {
		return f.authorize(ctx, command)
	}
	session := validSession(time.Now().UTC())
	session.SessionID = command.Claims.SessionID
	session.TransportGeneration = command.Claims.TransportGeneration
	return session, nil
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

type fakeRiskDecisionService struct {
	decide  func(context.Context, rgs.RiskDecisionCommand) (rgs.RiskDecisionResult, error)
	calls   int
	command rgs.RiskDecisionCommand
}

func (service *fakeRiskDecisionService) DecideRisk(
	ctx context.Context,
	command rgs.RiskDecisionCommand,
) (rgs.RiskDecisionResult, error) {
	service.calls++
	service.command = command
	return service.decide(ctx, command)
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

type fakeSecurityEventObserver struct {
	nonceReplays int
}

func (observer *fakeSecurityEventObserver) NonceReplay() {
	observer.nonceReplays++
}

type securityFixture struct {
	now              time.Time
	requestSigning   operator.SigningKey
	responseSigning  operator.SigningKey
	responseVerifier *operator.ResponseVerifier
	accessIssuer     *operator.AccessTokenIssuer
	accessVerifier   *operator.AccessTokenVerifier
	requestVerifier  *operator.RequestVerifier
	securityEvents   SecurityEventObserver
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
	return f.newHandlerWithAllAdmissions(t, launches, spins, rounds, operatorAdmission, clientAdmission, nil, nil)
}

func (f *securityFixture) newHandlerWithAllAdmissions(
	t *testing.T,
	launches *fakeLaunchService,
	spins *fakeCoordinator,
	rounds *fakeRoundReader,
	operatorAdmission Admission,
	clientAdmission Admission,
	launchAdmission Admission,
	spinAdmission Admission,
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
		LaunchAdmission: launchAdmission, SpinAdmission: spinAdmission,
		SecurityEvents: f.securityEvents,
		Now:            func() time.Time { return f.now }, NewRequestID: func() string { return "generated-request" },
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
		TransportGeneration: 1,
	}, 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func TestClientSessionStatusIsFlatReadOnlyAndUsesAuthoritativeClock(t *testing.T) {
	security := newSecurityFixture(t)
	deadline := security.now.Add(20 * time.Minute)
	launches := &fakeLaunchService{authorize: func(_ context.Context, command SessionAuthorizationCommand) (rgs.Session, error) {
		if command.AllowIdleRecovery {
			t.Fatal("status probe unexpectedly used recovery authorization")
		}
		session := validSession(security.now)
		session.IdleDisconnectAt = deadline
		session.ServerTime = security.now
		return session, nil
	}}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})
	body, _ := json.Marshal(sessionBindingRequest{
		OperatorID: testOperatorID, SessionID: testSessionID,
		GameID: testGameID, DefinitionVersion: testDefinition,
		DefinitionHash: testDefinitionHash, Currency: testCurrency,
		CurrencyExponent: 2, Jurisdiction: testRegion,
	})
	request := clientRequest(ClientSessionStatusPath, body, security.issueAccessToken(t, testDefinitionHash))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status response = %d %s", recorder.Code, recorder.Body.Bytes())
	}
	var envelope struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if len(envelope.Data) != 5 || envelope.Data["operatorId"] != testOperatorID ||
		envelope.Data["sessionId"] != testSessionID || envelope.Data["status"] != "ACTIVE" ||
		envelope.Data["idleDisconnectAt"] != formatTime(deadline) ||
		envelope.Data["serverTime"] != formatTime(security.now) {
		t.Fatalf("flat status data = %#v", envelope.Data)
	}
	if launches.authorizeCalls != 1 || launches.lastAuthorize.AllowIdleRecovery {
		t.Fatalf("status authorization = calls:%d command:%+v", launches.authorizeCalls, launches.lastAuthorize)
	}
}

func TestClientSessionStatusReturnsStableTimeoutCode(t *testing.T) {
	security := newSecurityFixture(t)
	launches := &fakeLaunchService{authorize: func(context.Context, SessionAuthorizationCommand) (rgs.Session, error) {
		return rgs.Session{}, rgs.ErrSessionTimeout
	}}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})
	body, _ := json.Marshal(sessionBindingRequest{
		OperatorID: testOperatorID, SessionID: testSessionID,
		GameID: testGameID, DefinitionVersion: testDefinition,
		DefinitionHash: testDefinitionHash, Currency: testCurrency,
		CurrencyExponent: 2, Jurisdiction: testRegion,
	})
	request := clientRequest(ClientSessionStatusPath, body, security.issueAccessToken(t, testDefinitionHash))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusGone ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"code":"SESSION_TIMEOUT"`)) {
		t.Fatalf("timeout response = %d %s", recorder.Code, recorder.Body.Bytes())
	}
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
			ValidatedAt: security.now,
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

func TestOperatorLaunchTerminalErrorsUseStableSignedContracts(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{name: "expired", err: rgs.ErrSessionExpired, status: http.StatusGone, code: "EXPIRED"},
		{name: "blocked", err: rgs.ErrManualReview, status: http.StatusLocked, code: "MANUAL_REVIEW"},
		{name: "changed claims", err: rgs.ErrIdempotencyConflict, status: http.StatusConflict, code: "IDEMPOTENCY_CONFLICT"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			security := newSecurityFixture(t)
			launches := &fakeLaunchService{create: func(context.Context, LaunchCommand) (LaunchResult, error) {
				return LaunchResult{}, test.err
			}}
			handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})
			request := security.signOperatorRequest(t, OperatorLaunchPath, operatorLaunchBody("12500"))
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)

			response := recorder.Result()
			body, _ := io.ReadAll(response.Body)
			if response.StatusCode != test.status ||
				!bytes.Contains(body, []byte(`"code":"`+test.code+`"`)) {
				t.Fatalf("terminal launch response = %d %s", response.StatusCode, body)
			}
			if err := security.responseVerifier.Verify(
				context.Background(), response, body, testOperatorID,
				request.Header.Get(operator.HeaderRequestID),
			); err != nil {
				t.Fatalf("signed terminal launch response verification failed: %v", err)
			}
		})
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
			ExpiresAt: security.now.Add(2 * time.Minute), ValidatedAt: security.now,
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
	// Pod 墙钟已越过文档保留边界，但 Store 权威观测仍在窗口内。
	// HTTP 适配器必须使用 LaunchService 携带的裁决时间，不得以 Pod 时钟早拒。
	historicalExpiry := security.now.Add(-launch.IdempotencyRetention - time.Hour)
	authorityTime := historicalExpiry.Add(time.Minute)
	launches := &fakeLaunchService{create: func(context.Context, LaunchCommand) (LaunchResult, error) {
		return LaunchResult{
			LaunchCode: validTestLaunchCode(10), ExchangeURL: "https://rgs.example" + ClientSessionExchangePath,
			ExpiresAt: historicalExpiry, ValidatedAt: authorityTime, HistoricalReplay: true,
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

func TestOperatorAdmissionBackendFailureReturnsSignedServiceUnavailable(t *testing.T) {
	security := newSecurityFixture(t)
	launches := &fakeLaunchService{create: func(context.Context, LaunchCommand) (LaunchResult, error) {
		t.Fatal("共享准入故障时不应进入启动服务")
		return LaunchResult{}, nil
	}}
	rounds := &fakeRoundReader{}
	handler := security.newHandlerWithAllAdmissions(
		t, launches, &fakeCoordinator{}, rounds, nil, nil,
		AdmissionResultFunc(func(context.Context, string, time.Time) AdmissionResult {
			return AdmissionResult{Decision: AdmissionBackendUnavailable, RetryAfter: 1500 * time.Millisecond}
		}), nil,
	)
	request := security.signOperatorRequest(t, OperatorLaunchPath, operatorLaunchBody("12500"))
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	response := recorder.Result()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusServiceUnavailable || response.Header.Get("Retry-After") != "2" {
		t.Fatalf("status = %d, retry-after = %q, body = %s", response.StatusCode, response.Header.Get("Retry-After"), responseBody)
	}
	if !bytes.Contains(responseBody, []byte(`"code":"ADMISSION_UNAVAILABLE"`)) {
		t.Fatalf("unexpected body: %s", responseBody)
	}
	if err := security.responseVerifier.Verify(context.Background(), response, responseBody, testOperatorID, request.Header.Get(operator.HeaderRequestID)); err != nil {
		t.Fatalf("signed admission-unavailable response verification failed: %v", err)
	}
	statusRequest := security.signOperatorRequest(t, OperatorRoundStatusPath, roundStatusBody())
	statusRecorder := httptest.NewRecorder()
	handler.ServeHTTP(statusRecorder, statusRequest)
	if statusRecorder.Code == http.StatusServiceUnavailable || rounds.calls != 1 {
		t.Fatalf("operator status/shared reader = %d/%d, body = %s", statusRecorder.Code, rounds.calls, statusRecorder.Body.Bytes())
	}
}

func TestRetryAfterHeaderValueDoesNotOverflow(t *testing.T) {
	if got := retryAfterHeaderValue(time.Duration(1<<63 - 1)); got != "9223372037" {
		t.Fatalf("maximum Retry-After = %q", got)
	}
	if got := retryAfterHeaderValue(0); got != "1" {
		t.Fatalf("default Retry-After = %q", got)
	}
}

func TestSharedAdmissionFailureBlocksOnlyNewEconomicIntents(t *testing.T) {
	security := newSecurityFixture(t)
	sharedCalls := 0
	var sharedKey string
	unavailable := AdmissionResultFunc(func(_ context.Context, key string, _ time.Time) AdmissionResult {
		sharedCalls++
		sharedKey = key
		return AdmissionResult{Decision: AdmissionBackendUnavailable, RetryAfter: time.Second}
	})
	ackCalls := 0
	spins := &fakeCoordinator{
		spin: func(context.Context, rgs.SpinRequest) (rgs.SpinResult, error) {
			t.Fatal("共享准入故障时不应进入 Spin 协调器")
			return rgs.SpinResult{}, nil
		},
		acknowledge: func(context.Context, rgs.ResultDeliveryAcknowledgement) (rgs.ResultDelivery, bool, error) {
			ackCalls++
			return rgs.ResultDelivery{}, false, ErrUnavailable
		},
	}
	rounds := &fakeRoundReader{}
	launches := &fakeLaunchService{refresh: func(context.Context, RefreshCommand) (ExchangeResult, error) {
		return ExchangeResult{}, ErrUnavailable
	}}
	handler := security.newHandlerWithAllAdmissions(
		t, launches, spins, rounds,
		nil, AdmissionFunc(func(string, time.Time) bool { return true }), nil, unavailable,
	)
	token := security.issueAccessTokenForSession(t, testSessionID, testDefinitionHash)

	spinRecorder := httptest.NewRecorder()
	handler.ServeHTTP(spinRecorder, clientRequest(ClientSpinPath, clientSpinBody(testDefinitionHash), token))
	if spinRecorder.Code != http.StatusServiceUnavailable || sharedCalls != 1 || spins.calls != 0 ||
		sharedKey != "spin-operator:"+testOperatorID {
		t.Fatalf("spin status/shared/coordinator/key = %d/%d/%d/%q, body = %s", spinRecorder.Code, sharedCalls, spins.calls, sharedKey, spinRecorder.Body.Bytes())
	}

	statusRecorder := httptest.NewRecorder()
	handler.ServeHTTP(statusRecorder, clientRequest(ClientRoundStatusPath, roundStatusBody(), token))
	if statusRecorder.Code == http.StatusServiceUnavailable || sharedCalls != 1 || rounds.calls != 1 {
		t.Fatalf("status/shared/reader = %d/%d/%d, body = %s", statusRecorder.Code, sharedCalls, rounds.calls, statusRecorder.Body.Bytes())
	}

	pendingRequest := httptest.NewRequest(http.MethodGet, "https://rgs.example"+ClientPendingResultPath, nil)
	pendingRequest.Header.Set(operator.HeaderOperatorID, testOperatorID)
	pendingRequest.Header.Set("Authorization", "Bearer "+token)
	pendingRecorder := httptest.NewRecorder()
	handler.ServeHTTP(pendingRecorder, pendingRequest)
	if pendingRecorder.Code != http.StatusNoContent || sharedCalls != 1 {
		t.Fatalf("pending status/shared = %d/%d, body = %s", pendingRecorder.Code, sharedCalls, pendingRecorder.Body.Bytes())
	}

	refreshRecorder := httptest.NewRecorder()
	handler.ServeHTTP(refreshRecorder, clientRequest(ClientSessionRefreshPath, sessionBindingBody(testDefinitionHash), token))
	if launches.refreshCalls != 1 || sharedCalls != 1 {
		t.Fatalf("refresh calls/shared = %d/%d, body = %s", launches.refreshCalls, sharedCalls, refreshRecorder.Body.Bytes())
	}

	ackBody, _ := json.Marshal(map[string]any{
		"operatorId": testOperatorID, "sessionId": testSessionID,
		"gameId": testGameID, "definitionVersion": testDefinition,
		"definitionHash": testDefinitionHash, "currency": testCurrency,
		"currencyExponent": 2, "jurisdiction": testRegion,
		"roundId": "round-a", "sequence": "1", "resultHash": strings.Repeat("b", 64),
	})
	ackRecorder := httptest.NewRecorder()
	handler.ServeHTTP(ackRecorder, clientRequest(ClientResultAckPath, ackBody, token))
	if ackCalls != 1 || sharedCalls != 1 {
		t.Fatalf("ack calls/shared = %d/%d, body = %s", ackCalls, sharedCalls, ackRecorder.Body.Bytes())
	}
}

func TestSpinSharedHighWaterAggregatesSessionsAndStillCountsReplay(t *testing.T) {
	security := newSecurityFixture(t)
	var sharedKeys []string
	shared := AdmissionResultFunc(func(_ context.Context, key string, _ time.Time) AdmissionResult {
		sharedKeys = append(sharedKeys, key)
		return AdmissionResult{Decision: AdmissionAllowed}
	})
	spins := &fakeCoordinator{spin: func(_ context.Context, request rgs.SpinRequest) (rgs.SpinResult, error) {
		return committedResult(request), nil
	}}
	handler := security.newHandlerWithAllAdmissions(
		t, &fakeLaunchService{}, spins, &fakeRoundReader{}, nil,
		AdmissionFunc(func(string, time.Time) bool { return true }), nil, shared,
	)
	tokenA := security.issueAccessTokenForSession(t, "session-a", testDefinitionHash)
	tokenB := security.issueAccessTokenForSession(t, "session-b", testDefinitionHash)
	requests := []struct {
		sessionID  string
		roundID    string
		token      string
		remoteAddr string
	}{
		{sessionID: "session-a", roundID: "round-a", token: tokenA, remoteAddr: "10.0.0.10:1001"},
		// 已提交重放仍刻意计入普通高水位桶；精确经济预算位于 Coordinator 内，
		// 因此不会对该重放再次扣费。
		{sessionID: "session-a", roundID: "round-a", token: tokenA, remoteAddr: "10.0.0.11:1002"},
		{sessionID: "session-b", roundID: "round-b", token: tokenB, remoteAddr: "10.0.0.12:1003"},
	}
	for _, test := range requests {
		request := clientRequest(
			ClientSpinPath,
			clientSpinBodyForSession(test.sessionID, test.roundID, testDefinitionHash),
			test.token,
		)
		request.RemoteAddr = test.remoteAddr
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("session %s round %s status = %d, body = %s", test.sessionID, test.roundID, recorder.Code, recorder.Body.Bytes())
		}
	}
	if spins.calls != len(requests) || len(sharedKeys) != len(requests) {
		t.Fatalf("coordinator/shared calls = %d/%d, want %d", spins.calls, len(sharedKeys), len(requests))
	}
	for _, key := range sharedKeys {
		if key != "spin-operator:"+testOperatorID {
			t.Fatalf("multi-session/replay shared key = %q; all calls must aggregate by verified operator", key)
		}
	}
}

func TestCoordinatorEconomicAdmissionErrorsPreserveRateAndFailureSemantics(t *testing.T) {
	security := newSecurityFixture(t)
	for _, test := range []struct {
		name       string
		cause      error
		status     int
		code       string
		retryAfter time.Duration
	}{
		{name: "budget limited", cause: rgs.ErrEconomicRateLimited, status: http.StatusTooManyRequests, code: "RATE_LIMITED", retryAfter: 1250 * time.Millisecond},
		{name: "backend unavailable", cause: rgs.ErrEconomicAdmissionUnavailable, status: http.StatusServiceUnavailable, code: "ADMISSION_UNAVAILABLE", retryAfter: time.Second},
	} {
		t.Run(test.name, func(t *testing.T) {
			spins := &fakeCoordinator{spin: func(context.Context, rgs.SpinRequest) (rgs.SpinResult, error) {
				return rgs.SpinResult{}, &rgs.EconomicAdmissionError{Cause: test.cause, RetryAfter: test.retryAfter}
			}}
			handler := security.newHandlerWithAllAdmissions(
				t, &fakeLaunchService{}, spins, &fakeRoundReader{},
				nil, AdmissionFunc(func(string, time.Time) bool { return true }), nil, nil,
			)
			token := security.issueAccessTokenForSession(t, testSessionID, testDefinitionHash)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, clientRequest(ClientSpinPath, clientSpinBody(testDefinitionHash), token))
			if recorder.Code != test.status || recorder.Header().Get("Retry-After") != strconv.FormatInt(int64((test.retryAfter+time.Second-1)/time.Second), 10) ||
				!bytes.Contains(recorder.Body.Bytes(), []byte(`"code":"`+test.code+`"`)) {
				t.Fatalf("response = status:%d retry:%q body:%s", recorder.Code, recorder.Header().Get("Retry-After"), recorder.Body.Bytes())
			}
		})
	}
}

func TestLocalAdmissionRejectsBeforeSharedAdmission(t *testing.T) {
	security := newSecurityFixture(t)
	sharedCalls := 0
	handler := security.newHandlerWithAllAdmissions(
		t, &fakeLaunchService{}, &fakeCoordinator{}, &fakeRoundReader{}, nil,
		AdmissionFunc(func(string, time.Time) bool { return false }), nil,
		AdmissionResultFunc(func(context.Context, string, time.Time) AdmissionResult {
			sharedCalls++
			return AdmissionResult{Decision: AdmissionAllowed}
		}),
	)
	token := security.issueAccessTokenForSession(t, testSessionID, testDefinitionHash)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, clientRequest(ClientSpinPath, clientSpinBody(testDefinitionHash), token))
	if recorder.Code != http.StatusTooManyRequests || sharedCalls != 0 {
		t.Fatalf("status/shared = %d/%d, body = %s", recorder.Code, sharedCalls, recorder.Body.Bytes())
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

func TestOperatorNonceReplayEmitsDedicatedEventAndKeepsGenericUnauthorizedResponse(t *testing.T) {
	security := newSecurityFixture(t)
	observer := &fakeSecurityEventObserver{}
	security.securityEvents = observer
	body := operatorLaunchBody("12500")
	request := security.signOperatorRequest(t, OperatorLaunchPath, body)
	launches := &fakeLaunchService{create: func(context.Context, LaunchCommand) (LaunchResult, error) {
		return LaunchResult{
			LaunchCode:  validTestLaunchCode(15),
			ExchangeURL: "https://rgs.example" + ClientSessionExchangePath,
			ExpiresAt:   security.now.Add(2 * time.Minute),
			ValidatedAt: security.now,
		}, nil
	}}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})

	first := httptest.NewRecorder()
	handler.ServeHTTP(first, request)
	if first.Code != http.StatusCreated || observer.nonceReplays != 0 {
		t.Fatalf("首次请求状态/重放事件 = %d/%d，响应 = %s", first.Code, observer.nonceReplays, first.Body.Bytes())
	}

	request.Body = io.NopCloser(bytes.NewReader(body))
	request.ContentLength = int64(len(body))
	second := httptest.NewRecorder()
	handler.ServeHTTP(second, request)

	if second.Code != http.StatusUnauthorized || observer.nonceReplays != 1 || launches.createCalls != 1 {
		t.Fatalf(
			"重放状态/事件/业务调用 = %d/%d/%d，响应 = %s",
			second.Code, observer.nonceReplays, launches.createCalls, second.Body.Bytes(),
		)
	}
	if !bytes.Contains(second.Body.Bytes(), []byte(`"code":"UNAUTHORIZED"`)) ||
		!bytes.Contains(second.Body.Bytes(), []byte(`"message":"credential is invalid"`)) ||
		bytes.Contains(bytes.ToLower(second.Body.Bytes()), []byte("replay")) ||
		bytes.Contains(bytes.ToLower(second.Body.Bytes()), []byte("nonce")) {
		t.Fatalf("重放响应未保持通用认证失败形状: %s", second.Body.Bytes())
	}
	response := second.Result()
	responseBody, _ := io.ReadAll(response.Body)
	if err := security.responseVerifier.Verify(
		context.Background(), response, responseBody, testOperatorID,
		request.Header.Get(operator.HeaderRequestID),
	); err != nil {
		t.Fatalf("重放错误响应签名验证失败: %v", err)
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
	if launches.authorizeCalls != 2 {
		t.Fatalf("database authorization calls = %d, want only the two admitted requests", launches.authorizeCalls)
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

func TestSharedNewIntentAdmissionUsesIndependentOperatorBuckets(t *testing.T) {
	if launchAdmissionKey("operator:a") != "launch-operator:operator:a" {
		t.Fatalf("launch admission key = %q", launchAdmissionKey("operator:a"))
	}
	if spinAdmissionKey("operator:a") != "spin-operator:operator:a" {
		t.Fatalf("spin admission key = %q", spinAdmissionKey("operator:a"))
	}
	if launchAdmissionKey("operator:a") == spinAdmissionKey("operator:a") {
		t.Fatal("launch and spin share one operator quota")
	}
	if spinAdmissionKey("operator:a") == spinAdmissionKey("operator:b") {
		t.Fatal("distinct verified operators share one spin quota")
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

func TestWalletUnavailableUsesExplicitRetryableContract(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	(&Handler{}).writeMappedError(recorder, "request-wallet-unavailable", rgs.ErrWalletUnavailable)
	response := recorder.Result()
	if response.StatusCode != http.StatusServiceUnavailable || response.Header.Get("Retry-After") != "1" ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"code":"WALLET_UNAVAILABLE"`)) {
		t.Fatalf("status = %d, retry-after = %q, body = %s",
			response.StatusCode, response.Header.Get("Retry-After"), recorder.Body.Bytes())
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
	deadline := security.now.Add(9 * time.Minute)
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
			if receipt.RoundID != result.RoundID || receipt.Sequence != result.Sequence ||
				receipt.ResultHash != hash || receipt.TransportGeneration != 1 {
				t.Fatalf("ACK receipt = %+v", receipt)
			}
			return rgs.ResultDelivery{
				OperatorID: receipt.OperatorID, SessionID: receipt.SessionID,
				RoundID: receipt.RoundID, Sequence: receipt.Sequence,
				ResultHash: receipt.ResultHash, AcknowledgedAt: acknowledgedAt,
			}, true, nil
		},
	}
	launches := &fakeLaunchService{authorize: func(_ context.Context, command SessionAuthorizationCommand) (rgs.Session, error) {
		if !command.AllowIdleRecovery {
			t.Fatal("pending result recovery must remain readable after the idle boundary")
		}
		session := validSession(security.now)
		session.IdleDisconnectAt = deadline
		return session, nil
	}}
	handler := security.newHandler(t, launches, spins, &fakeRoundReader{})
	discover := httptest.NewRequest(http.MethodGet, "https://rgs.example"+ClientPendingResultPath, nil)
	discover.Header.Set(operator.HeaderRequestID, "client-request")
	discover.Header.Set(operator.HeaderOperatorID, testOperatorID)
	discover.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, discover)
	if recorder.Code != http.StatusOK || !bytes.Contains(recorder.Body.Bytes(), []byte(`"resultHash":"`+hash+`"`)) ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"originFeature":{"mode":"NONE"`)) ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"idleDisconnectAt":"`+formatTime(deadline)+`"`)) {
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
	if !bytes.Contains(recorder.Body.Bytes(), []byte(`"accessToken"`)) ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"definitionHash":"`+testDefinitionHash+`"`)) ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"idleDisconnectAt":"`+formatTime(session.IdleDisconnectAt)+`"`)) ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"serverTime":"`+formatTime(session.ServerTime)+`"`)) {
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
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"sessionId":"`+testSessionID+`"`)) ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"idleDisconnectAt":"`+formatTime(session.IdleDisconnectAt)+`"`)) ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"serverTime":"`+formatTime(session.ServerTime)+`"`)) {
		t.Fatalf("unexpected refresh response: %s", recorder.Body.Bytes())
	}
}

func TestClientSpinBindsEveryTokenDimension(t *testing.T) {
	security := newSecurityFixture(t)
	token := security.issueAccessToken(t, testDefinitionHash)
	deadline := security.now.Add(17 * time.Minute)
	coordinator := &fakeCoordinator{spin: func(_ context.Context, request rgs.SpinRequest) (rgs.SpinResult, error) {
		// PostgreSQL 轮次恢复刻意不在 result_json 持久化纯传输 idle 元数据；HTTP
		// 边界必须从当前权威会话补齐，且不能改变经济 hash。
		return committedResult(request), nil
	}}
	launches := &fakeLaunchService{authorize: func(_ context.Context, command SessionAuthorizationCommand) (rgs.Session, error) {
		session := validSession(security.now)
		session.IdleDisconnectAt = deadline
		return session, nil
	}}
	handler := security.newHandler(t, launches, coordinator, &fakeRoundReader{})
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
	if !bytes.Contains(recorder.Body.Bytes(), []byte(`"idleDisconnectAt":"`+formatTime(deadline)+`"`)) {
		t.Fatalf("authoritative idle deadline was not hydrated: %s", recorder.Body.Bytes())
	}
	if launches.authorizeCalls != 2 || !launches.lastAuthorize.AllowIdleRecovery {
		// 第一次授权在经济操作前隔离请求，第二次在提交结果返回后读取续期截止时间。
		t.Fatalf("spin authorization calls = %d, last = %+v", launches.authorizeCalls, launches.lastAuthorize)
	}

	tampered := clientRequest(ClientSpinPath, clientSpinBody(strings.Repeat("b", 64)), token)
	tamperedRecorder := httptest.NewRecorder()
	handler.ServeHTTP(tamperedRecorder, tampered)
	if tamperedRecorder.Code != http.StatusForbidden || coordinator.calls != 1 {
		t.Fatalf("binding tamper status = %d, calls = %d, body = %s", tamperedRecorder.Code, coordinator.calls, tamperedRecorder.Body.Bytes())
	}
}

func TestCommittedClientRoundStatusHydratesCurrentIdleDeadline(t *testing.T) {
	security := newSecurityFixture(t)
	deadline := security.now.Add(11 * time.Minute)
	requestModel := validSpinRequest()
	result := committedResult(requestModel)
	wantHash, err := rgs.CommittedResultHashFor(result)
	if err != nil {
		t.Fatal(err)
	}
	rounds := &fakeRoundReader{get: func(_ context.Context, key rgs.RoundKey) (rgs.RoundRecord, error) {
		return rgs.RoundRecord{Key: key, Request: requestModel, Status: rgs.RoundCommitted, Result: result}, nil
	}}
	launches := &fakeLaunchService{authorize: func(_ context.Context, command SessionAuthorizationCommand) (rgs.Session, error) {
		if !command.AllowIdleRecovery {
			t.Fatal("round recovery must remain readable after the idle boundary")
		}
		session := validSession(security.now)
		session.IdleDisconnectAt = deadline
		return session, nil
	}}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, rounds)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, clientRequest(
		ClientRoundStatusPath,
		roundStatusBody(),
		security.issueAccessToken(t, testDefinitionHash),
	))

	if recorder.Code != http.StatusOK ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"idleDisconnectAt":"`+formatTime(deadline)+`"`)) ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"resultHash":"`+wantHash+`"`)) {
		t.Fatalf("committed recovery response = %d %s", recorder.Code, recorder.Body.Bytes())
	}
}

func TestPendingRoundStatusNeverRevealsPreparedOutcome(t *testing.T) {
	for _, status := range []rgs.RoundStatus{rgs.RoundRiskPending, rgs.RoundWalletPending} {
		t.Run(string(status), func(t *testing.T) {
			security := newSecurityFixture(t)
			token := security.issueAccessToken(t, testDefinitionHash)
			requestModel := validSpinRequest()
			rounds := &fakeRoundReader{get: func(_ context.Context, key rgs.RoundKey) (rgs.RoundRecord, error) {
				return rgs.RoundRecord{
					Key: key, Request: requestModel, Status: status,
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
			if !bytes.Contains(recorder.Body.Bytes(), []byte(`"status":"`+string(status)+`"`)) {
				t.Fatalf("missing pending state: %s", recorder.Body.Bytes())
			}
		})
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

func TestOperatorRiskDecisionUsesSignedIdentityAndReturnsNoCandidateResult(t *testing.T) {
	security := newSecurityFixture(t)
	decidedAt := security.now.Add(time.Second)
	service := &fakeRiskDecisionService{decide: func(
		_ context.Context,
		command rgs.RiskDecisionCommand,
	) (rgs.RiskDecisionResult, error) {
		return rgs.RiskDecisionResult{
			RoundKey: command.RoundKey, Decision: command.Decision,
			Status: rgs.RoundPrepared, DecidedAt: decidedAt,
		}, nil
	}}
	handler := security.newHandler(t, &fakeLaunchService{}, &fakeCoordinator{}, &fakeRoundReader{})
	handler.riskDecisions = service
	body, _ := json.Marshal(map[string]any{
		"operatorId": testOperatorID, "sessionId": testSessionID, "roundId": "round-risk",
		"decision": "APPROVE", "reasonCode": "RISK_APPROVED",
	})
	request := security.signOperatorRequestWithIdempotency(
		t, OperatorRiskDecisionPath, body, "risk-decision-a",
	)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	response := recorder.Result()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.StatusCode, responseBody)
	}
	if err := security.responseVerifier.Verify(
		context.Background(), response, responseBody, testOperatorID,
		request.Header.Get(operator.HeaderRequestID),
	); err != nil {
		t.Fatalf("risk response signature failed: %v", err)
	}
	if service.calls != 1 || service.command.RoundKey.OperatorID != testOperatorID ||
		service.command.IdempotencyKey != "risk-decision-a" ||
		service.command.CredentialKeyID != security.requestSigning.KeyID ||
		service.command.RequestID != request.Header.Get(operator.HeaderRequestID) {
		t.Fatalf("decision command = %+v, calls=%d", service.command, service.calls)
	}
	if bytes.Contains(responseBody, []byte(`"result"`)) ||
		!bytes.Contains(responseBody, []byte(`"status":"PREPARED"`)) {
		t.Fatalf("unexpected risk response: %s", responseBody)
	}
}

func TestOperatorRiskDecisionRejectsUnsignedRequestBeforeRepository(t *testing.T) {
	security := newSecurityFixture(t)
	service := &fakeRiskDecisionService{decide: func(
		context.Context,
		rgs.RiskDecisionCommand,
	) (rgs.RiskDecisionResult, error) {
		return rgs.RiskDecisionResult{}, nil
	}}
	handler := security.newHandler(t, &fakeLaunchService{}, &fakeCoordinator{}, &fakeRoundReader{})
	handler.riskDecisions = service
	body := []byte(`{"operatorId":"operator-a","sessionId":"session-a","roundId":"round-risk","decision":"REJECT","reasonCode":"RISK_REJECTED"}`)
	request := httptest.NewRequest(http.MethodPost, "https://rgs.example"+OperatorRiskDecisionPath, bytes.NewReader(body))
	request.Header.Set("Content-Type", operator.SignedContentType)
	request.Header.Set(operator.HeaderOperatorID, testOperatorID)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized || service.calls != 0 {
		t.Fatalf("status=%d calls=%d body=%s", recorder.Code, service.calls, recorder.Body.Bytes())
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

func TestStrictJSONRejectsThousandObjectNestingBomb(t *testing.T) {
	const nestedObjects = 1_000
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

	if recorder.Code != http.StatusRequestEntityTooLarge || !request.Close ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"code":"BODY_TOO_LARGE"`)) {
		t.Fatalf("status = %d, close = %v, body = %s", recorder.Code, request.Close, recorder.Body.Bytes())
	}
}

func TestDeclaredOversizedBodyClosesInsteadOfDrainingRejectedConnection(t *testing.T) {
	security := newSecurityFixture(t)
	handler := security.newHandler(t, &fakeLaunchService{}, &fakeCoordinator{}, &fakeRoundReader{})
	request := clientRequest(ClientSpinPath, []byte(`{}`), "")
	request.ContentLength = maxPublicRequestBytes + 1
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusRequestEntityTooLarge || !request.Close {
		t.Fatalf("oversized body response/connection = %d/%v", recorder.Code, request.Close)
	}
}

func TestRejectedQueryClosesUnreadRequestBody(t *testing.T) {
	security := newSecurityFixture(t)
	handler := security.newHandler(t, &fakeLaunchService{}, &fakeCoordinator{}, &fakeRoundReader{})
	request := clientRequest(ClientSpinPath+"?debug=1", []byte(`{"unexpected":true}`), "")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest || !request.Close {
		t.Fatalf("query rejection response/connection = %d/%v body:%s",
			recorder.Code, request.Close, recorder.Body.String())
	}
}

func TestPendingResultRejectsUnknownLengthGETBodyAndClosesConnection(t *testing.T) {
	security := newSecurityFixture(t)
	handler := security.newHandler(t, &fakeLaunchService{}, &fakeCoordinator{}, &fakeRoundReader{})
	request := httptest.NewRequest(http.MethodGet, ClientPendingResultPath, strings.NewReader(`{"unexpected":true}`))
	request.ContentLength = -1
	request.TransferEncoding = []string{"chunked"}
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest || !request.Close ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"code":"INVALID_REQUEST"`)) {
		t.Fatalf("GET body rejection response/connection = %d/%v body:%s",
			recorder.Code, request.Close, recorder.Body.String())
	}
}

func TestPendingResultAcceptsReverseProxyEmptyEOFBodyWrapper(t *testing.T) {
	security := newSecurityFixture(t)
	token := security.issueAccessToken(t, testDefinitionHash)
	launches := &fakeLaunchService{authorize: func(context.Context, SessionAuthorizationCommand) (rgs.Session, error) {
		return validSession(security.now), nil
	}}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})
	bodyObserved := make(chan *scriptedGETBody, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		// 模拟 Nginx/反向代理为零长度 GET 安装的 EOF 包装器，而不是 http.NoBody。
		body := &scriptedGETBody{readErr: io.EOF}
		request.Body = body
		request.ContentLength = 0
		handler.ServeHTTP(writer, request)
		bodyObserved <- body
	}))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(httputil.NewSingleHostReverseProxy(target))
	defer proxy.Close()

	request, err := http.NewRequest(http.MethodGet, proxy.URL+ClientPendingResultPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set(operator.HeaderOperatorID, testOperatorID)
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := proxy.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusNoContent || len(responseBody) != 0 {
		t.Fatalf("proxied pending response = %d %q", response.StatusCode, responseBody)
	}
	body := <-bodyObserved
	if body.reads != 1 || !body.closed {
		t.Fatalf("EOF wrapper reads/closed = %d/%t, want 1/true", body.reads, body.closed)
	}
}

func TestPendingResultRejectsGETEntitySignalsAndProbeFailures(t *testing.T) {
	security := newSecurityFixture(t)
	handler := security.newHandler(t, &fakeLaunchService{}, &fakeCoordinator{}, &fakeRoundReader{})
	readFailure := errors.New("GET body read failed")
	closeFailure := errors.New("GET body close failed")
	tests := []struct {
		name      string
		configure func(*http.Request, *scriptedGETBody)
		wantReads int
	}{
		{
			name: "actual byte despite zero content length",
			configure: func(_ *http.Request, body *scriptedGETBody) {
				body.payload = []byte("x")
			},
			wantReads: 1,
		},
		{
			name: "body read failure",
			configure: func(_ *http.Request, body *scriptedGETBody) {
				body.readErr = readFailure
			},
			wantReads: 1,
		},
		{
			name:      "zero byte read without EOF",
			configure: func(_ *http.Request, _ *scriptedGETBody) {},
			wantReads: 1,
		},
		{
			name: "EOF wrapper close failure",
			configure: func(_ *http.Request, body *scriptedGETBody) {
				body.readErr = io.EOF
				body.closeErr = closeFailure
			},
			wantReads: 1,
		},
		{
			name: "positive content length",
			configure: func(request *http.Request, body *scriptedGETBody) {
				request.ContentLength = 1
				body.readErr = io.EOF
			},
		},
		{
			name: "unknown content length",
			configure: func(request *http.Request, body *scriptedGETBody) {
				request.ContentLength = -1
				body.readErr = io.EOF
			},
		},
		{
			name: "transfer encoding",
			configure: func(request *http.Request, body *scriptedGETBody) {
				request.TransferEncoding = []string{"chunked"}
				body.readErr = io.EOF
			},
		},
		{
			name: "content type",
			configure: func(request *http.Request, body *scriptedGETBody) {
				request.Header.Set("Content-Type", "application/json")
				body.readErr = io.EOF
			},
		},
		{
			name: "content encoding",
			configure: func(request *http.Request, body *scriptedGETBody) {
				request.Header.Set("Content-Encoding", "gzip")
				body.readErr = io.EOF
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body := &scriptedGETBody{}
			request := httptest.NewRequest(http.MethodGet, ClientPendingResultPath, nil)
			request.Body = body
			request.ContentLength = 0
			test.configure(request, body)
			recorder := httptest.NewRecorder()

			handler.ServeHTTP(recorder, request)

			if recorder.Code != http.StatusBadRequest || !request.Close ||
				!bytes.Contains(recorder.Body.Bytes(), []byte(`"code":"INVALID_REQUEST"`)) {
				t.Fatalf("GET rejection response/connection = %d/%t body:%s",
					recorder.Code, request.Close, recorder.Body.String())
			}
			if body.reads != test.wantReads {
				t.Fatalf("GET body reads = %d, want %d", body.reads, test.wantReads)
			}
		})
	}
}

type scriptedGETBody struct {
	payload  []byte
	readErr  error
	closeErr error
	reads    int
	closed   bool
}

func (body *scriptedGETBody) Read(destination []byte) (int, error) {
	body.reads++
	if len(body.payload) != 0 {
		read := copy(destination, body.payload)
		body.payload = body.payload[read:]
		return read, nil
	}
	return 0, body.readErr
}

func (body *scriptedGETBody) Close() error {
	body.closed = true
	return body.closeErr
}

func TestRequestBodyLimitsAreRouteSpecificBeforeJSONAndCrypto(t *testing.T) {
	security := newSecurityFixture(t)
	handler := security.newHandler(t, &fakeLaunchService{}, &fakeCoordinator{}, &fakeRoundReader{})
	handler.maxRequestBytes = DefaultMaxRequestBytes

	body := bytes.Repeat([]byte("x"), int(maxClientRecoveryRequestBytes)+1)
	request := clientRequest(ClientRoundStatusPath, body, "not-a-token")
	request.ContentLength = -1
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusRequestEntityTooLarge ||
		!bytes.Contains(recorder.Body.Bytes(), []byte(`"code":"BODY_TOO_LARGE"`)) {
		t.Fatalf("route-specific body response = %d %s", recorder.Code, recorder.Body.Bytes())
	}

	exchangeBody := bytes.Repeat([]byte("x"), int(maxSessionExchangeRequestBytes)+1)
	exchange := clientRequest(ClientSessionExchangePath, exchangeBody, "")
	exchange.ContentLength = -1
	exchangeRecorder := httptest.NewRecorder()
	handler.ServeHTTP(exchangeRecorder, exchange)
	if exchangeRecorder.Code != http.StatusRequestEntityTooLarge ||
		!bytes.Contains(exchangeRecorder.Body.Bytes(), []byte(`"code":"BODY_TOO_LARGE"`)) {
		t.Fatalf("exchange body response = %d %s", exchangeRecorder.Code, exchangeRecorder.Body.Bytes())
	}
}

func TestMaximumSchemaValidBodiesFitCompleteEdgeInspectionWindow(t *testing.T) {
	id := strings.Repeat("a", 128)
	digest := strings.Repeat("a", 64)
	binding := sessionBindingRequest{
		OperatorID: id, SessionID: id, GameID: id, DefinitionVersion: id,
		DefinitionHash: digest, Currency: "EUR", CurrencyExponent: 6,
		Jurisdiction: strings.Repeat("A", 16),
	}
	tests := []struct {
		name     string
		value    any
		limit    int
		validate func([]byte) error
	}{
		{
			name: "operator launch",
			value: operatorLaunchRequest{
				PlayerID: id, WalletAccountID: id, WalletSessionID: id,
				SessionID: id, GameID: id, DefinitionVersion: id,
				DefinitionHash: digest, Currency: "EUR", CurrencyExponent: 6,
				Jurisdiction: strings.Repeat("A", 16), BalanceMinor: "9223372036854775807",
				SessionTTLSeconds: 86400, IdleDisconnectSeconds: 86400,
			},
			limit: maxPublicRequestBytes,
			validate: func(body []byte) error {
				var value operatorLaunchRequest
				if err := decodeStrictJSON(body, &value); err != nil {
					return err
				}
				return validateOperatorLaunchRequest(value)
			},
		},
		{
			name: "session exchange",
			value: clientSessionExchangeRequest{
				LaunchCode: validTestLaunchCode(1), OperatorID: id, SessionID: id,
			},
			limit: maxSessionExchangeRequestBytes,
			validate: func(body []byte) error {
				var value clientSessionExchangeRequest
				if err := decodeStrictJSON(body, &value); err != nil {
					return err
				}
				return validateClientSessionExchangeRequest(value)
			},
		},
		{
			name: "session refresh", value: clientSessionRefreshRequest{sessionBindingRequest: binding},
			limit: maxPublicRequestBytes,
			validate: func(body []byte) error {
				var value clientSessionRefreshRequest
				if err := decodeStrictJSON(body, &value); err != nil {
					return err
				}
				return validateBinding(value.sessionBindingRequest)
			},
		},
		{
			name: "spin",
			value: clientSpinRequest{
				sessionBindingRequest: binding, RoundID: id, RoundKind: rgs.RoundKindFreeSpin,
				BetMinor: "9223372036854775807", StartRevision: "9223372036854775807",
			},
			limit: maxPublicRequestBytes,
			validate: func(body []byte) error {
				var value clientSpinRequest
				if err := decodeStrictJSON(body, &value); err != nil {
					return err
				}
				_, _, err := validateClientSpinRequest(value)
				return err
			},
		},
		{
			name: "round status", value: roundStatusRequest{sessionBindingRequest: binding, RoundID: id},
			limit: maxPublicRequestBytes,
			validate: func(body []byte) error {
				var value roundStatusRequest
				if err := decodeStrictJSON(body, &value); err != nil {
					return err
				}
				return validateRoundStatusRequest(value)
			},
		},
		{
			name: "result acknowledgement",
			value: resultDeliveryAcknowledgementRequest{
				sessionBindingRequest: binding, RoundID: id,
				Sequence: "9007199254740991", ResultHash: digest,
			},
			limit: maxPublicRequestBytes,
			validate: func(body []byte) error {
				var value resultDeliveryAcknowledgementRequest
				if err := decodeStrictJSON(body, &value); err != nil {
					return err
				}
				_, err := validateResultDeliveryAcknowledgementRequest(value)
				return err
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			compact, err := json.Marshal(test.value)
			if err != nil {
				t.Fatal(err)
			}
			escaped := maximallyEscapeJSONStrings(t, compact)
			if len(escaped) > test.limit {
				t.Fatalf("maximally escaped body = %d bytes, limit = %d", len(escaped), test.limit)
			}
			if err := test.validate(escaped); err != nil {
				t.Fatalf("maximally escaped schema-valid body rejected: %v", err)
			}
			t.Logf("compact=%d maximally_escaped=%d limit=%d", len(compact), len(escaped), test.limit)
		})
	}
}

func maximallyEscapeJSONStrings(t *testing.T, compact []byte) []byte {
	t.Helper()
	var escaped bytes.Buffer
	inString := false
	for _, character := range compact {
		if character == '"' {
			inString = !inString
			escaped.WriteByte(character)
			continue
		}
		if !inString {
			escaped.WriteByte(character)
			continue
		}
		if character < 0x20 || character > 0x7e || character == '\\' {
			t.Fatalf("fixture contains unsupported pre-escaped character %#x", character)
		}
		_, _ = fmt.Fprintf(&escaped, `\u%04x`, character)
	}
	if inString {
		t.Fatal("fixture ended inside JSON string")
	}
	return escaped.Bytes()
}

type rejectingCryptographicCapacity struct {
	calls int
}

func (capacity *rejectingCryptographicCapacity) TryAcquire(
	_ context.Context,
) (func(), AdmissionResult) {
	capacity.calls++
	return nil, AdmissionResult{Decision: AdmissionCapacityUnavailable}
}

type scriptedCryptographicCapacity struct {
	calls    int
	rejectAt int
	active   int
	releases int
	maximum  int
}

type boundedTestCryptographicCapacity struct {
	mu       sync.Mutex
	limit    int
	calls    int
	active   int
	maximum  int
	releases int
}

func (capacity *boundedTestCryptographicCapacity) TryAcquire(
	_ context.Context,
) (func(), AdmissionResult) {
	capacity.mu.Lock()
	capacity.calls++
	if capacity.active >= capacity.limit {
		capacity.mu.Unlock()
		return nil, AdmissionResult{Decision: AdmissionCapacityUnavailable}
	}
	capacity.active++
	if capacity.active > capacity.maximum {
		capacity.maximum = capacity.active
	}
	capacity.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			capacity.mu.Lock()
			capacity.active--
			capacity.releases++
			capacity.mu.Unlock()
		})
	}, AdmissionResult{Decision: AdmissionAllowed}
}

func (capacity *boundedTestCryptographicCapacity) snapshot() (calls, active, maximum, releases int) {
	capacity.mu.Lock()
	defer capacity.mu.Unlock()
	return capacity.calls, capacity.active, capacity.maximum, capacity.releases
}

func (capacity *scriptedCryptographicCapacity) TryAcquire(
	_ context.Context,
) (func(), AdmissionResult) {
	capacity.calls++
	if capacity.calls == capacity.rejectAt {
		return nil, AdmissionResult{Decision: AdmissionCapacityUnavailable}
	}
	capacity.active++
	if capacity.active > capacity.maximum {
		capacity.maximum = capacity.active
	}
	return func() {
		capacity.active--
		capacity.releases++
	}, AdmissionResult{Decision: AdmissionAllowed}
}

func TestCryptographicCapacityRejectsBeforeUntrustedVerification(t *testing.T) {
	security := newSecurityFixture(t)
	capacity := &rejectingCryptographicCapacity{}
	handler := security.newHandler(t, &fakeLaunchService{}, &fakeCoordinator{}, &fakeRoundReader{})
	handler.cryptographicCapacity = capacity

	spin := clientRequest(
		ClientSpinPath,
		clientSpinBody(testDefinitionHash),
		security.issueAccessToken(t, testDefinitionHash),
	)
	spinRecorder := httptest.NewRecorder()
	handler.ServeHTTP(spinRecorder, spin)
	if spinRecorder.Code != http.StatusServiceUnavailable || capacity.calls != 1 {
		t.Fatalf("spin crypto capacity = status:%d calls:%d body:%s",
			spinRecorder.Code, capacity.calls, spinRecorder.Body.Bytes())
	}

	capacity.calls = 0
	status := clientRequest(
		ClientRoundStatusPath,
		roundStatusBody(),
		security.issueAccessToken(t, testDefinitionHash),
	)
	statusRecorder := httptest.NewRecorder()
	handler.ServeHTTP(statusRecorder, status)
	if statusRecorder.Code != http.StatusServiceUnavailable || capacity.calls != 1 {
		t.Fatalf("spoofable status path did not use the same anonymous crypto capacity = status:%d calls:%d body:%s",
			statusRecorder.Code, capacity.calls, statusRecorder.Body.Bytes())
	}
}

func TestCryptographicCapacityRejectsExchangeBeforeOneTimeCodeConsumption(t *testing.T) {
	security := newSecurityFixture(t)
	capacity := &rejectingCryptographicCapacity{}
	launches := &fakeLaunchService{exchange: func(context.Context, ExchangeCommand) (ExchangeResult, error) {
		t.Fatal("crypto-capacity rejection consumed a one-time launch code")
		return ExchangeResult{}, nil
	}}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})
	handler.cryptographicCapacity = capacity
	body := []byte(`{"launchCode":"` + validTestLaunchCode(41) + `","operatorId":"operator-a","sessionId":"session-a"}`)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, clientRequest(ClientSessionExchangePath, body, ""))

	if recorder.Code != http.StatusServiceUnavailable || capacity.calls != 1 ||
		launches.exchangeCalls != 0 || recorder.Header().Get("Retry-After") != "1" {
		t.Fatalf("exchange crypto gate = status:%d capacity:%d exchange:%d retry:%q body:%s",
			recorder.Code, capacity.calls, launches.exchangeCalls,
			recorder.Header().Get("Retry-After"), recorder.Body.String())
	}
}

func TestCryptographicCapacityProtectsRefreshResultTokenVerification(t *testing.T) {
	security := newSecurityFixture(t)
	capacity := &scriptedCryptographicCapacity{rejectAt: 2}
	session := validSession(security.now)
	launches := &fakeLaunchService{refresh: func(context.Context, RefreshCommand) (ExchangeResult, error) {
		return ExchangeResult{
			Session:     session,
			AccessToken: security.issueAccessToken(t, testDefinitionHash),
		}, nil
	}}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})
	handler.cryptographicCapacity = capacity
	token := security.issueAccessToken(t, testDefinitionHash)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(
		recorder,
		clientRequest(ClientSessionRefreshPath, sessionBindingBody(testDefinitionHash), token),
	)

	if recorder.Code != http.StatusServiceUnavailable || capacity.calls != 2 ||
		capacity.releases != 1 || capacity.active != 0 || launches.refreshCalls != 0 ||
		recorder.Header().Get("Retry-After") != "1" {
		t.Fatalf("refresh result crypto gate = status:%d calls:%d releases:%d active:%d refresh:%d retry:%q body:%s",
			recorder.Code, capacity.calls, capacity.releases, capacity.active,
			launches.refreshCalls, recorder.Header().Get("Retry-After"), recorder.Body.String())
	}
}

func TestRefreshSigningAndReturnedTokenVerificationShareOneCryptographicPermit(t *testing.T) {
	security := newSecurityFixture(t)
	capacity := &scriptedCryptographicCapacity{}
	session := validSession(security.now)
	resultToken := security.issueAccessToken(t, testDefinitionHash)
	launches := &fakeLaunchService{refresh: func(context.Context, RefreshCommand) (ExchangeResult, error) {
		if capacity.active != 1 {
			t.Fatalf("refresh token signing ran with crypto capacity active=%d, want 1", capacity.active)
		}
		return ExchangeResult{Session: session, AccessToken: resultToken}, nil
	}}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})
	handler.cryptographicCapacity = capacity
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(
		recorder,
		clientRequest(
			ClientSessionRefreshPath,
			sessionBindingBody(testDefinitionHash),
			security.issueAccessToken(t, testDefinitionHash),
		),
	)

	if recorder.Code != http.StatusOK || capacity.calls != 2 || capacity.releases != 2 ||
		capacity.active != 0 || capacity.maximum != 1 || launches.refreshCalls != 1 {
		t.Fatalf("refresh crypto chain = status:%d calls:%d releases:%d active:%d max:%d refresh:%d body:%s",
			recorder.Code, capacity.calls, capacity.releases, capacity.active,
			capacity.maximum, launches.refreshCalls, recorder.Body.String())
	}
}

func TestConcurrentRefreshSigningCannotExceedCryptographicCapacity(t *testing.T) {
	security := newSecurityFixture(t)
	capacity := &boundedTestCryptographicCapacity{limit: 1}
	session := validSession(security.now)
	resultToken := security.issueAccessToken(t, testDefinitionHash)
	firstRefreshEntered := make(chan struct{})
	releaseFirstRefresh := make(chan struct{})

	var signingMu sync.Mutex
	signingActive := 0
	signingMaximum := 0
	signingOutsideCapacity := 0
	signingEntries := 0
	launches := &fakeLaunchService{refresh: func(context.Context, RefreshCommand) (ExchangeResult, error) {
		signingMu.Lock()
		signingEntries++
		entry := signingEntries
		signingActive++
		if signingActive > signingMaximum {
			signingMaximum = signingActive
		}
		_, cryptoActive, _, _ := capacity.snapshot()
		if cryptoActive != 1 {
			signingOutsideCapacity++
		}
		signingMu.Unlock()
		defer func() {
			signingMu.Lock()
			signingActive--
			signingMu.Unlock()
		}()

		if entry == 1 {
			close(firstRefreshEntered)
			<-releaseFirstRefresh
		}
		return ExchangeResult{Session: session, AccessToken: resultToken}, nil
	}}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})
	handler.cryptographicCapacity = capacity
	token := security.issueAccessToken(t, testDefinitionHash)

	firstRecorder := httptest.NewRecorder()
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		handler.ServeHTTP(
			firstRecorder,
			clientRequest(ClientSessionRefreshPath, sessionBindingBody(testDefinitionHash), token),
		)
	}()
	select {
	case <-firstRefreshEntered:
	case <-time.After(time.Second):
		t.Fatal("first refresh never entered the signing chain")
	}

	secondRecorder := httptest.NewRecorder()
	secondDone := make(chan struct{})
	go func() {
		defer close(secondDone)
		handler.ServeHTTP(
			secondRecorder,
			clientRequest(ClientSessionRefreshPath, sessionBindingBody(testDefinitionHash), token),
		)
	}()
	select {
	case <-secondDone:
	case <-time.After(time.Second):
		close(releaseFirstRefresh)
		<-firstDone
		t.Fatal("second refresh queued behind saturated cryptographic capacity")
	}
	close(releaseFirstRefresh)
	<-firstDone

	calls, active, maximum, releases := capacity.snapshot()
	signingMu.Lock()
	maxSigning, outsideCapacity := signingMaximum, signingOutsideCapacity
	signingMu.Unlock()
	if firstRecorder.Code != http.StatusOK || secondRecorder.Code != http.StatusServiceUnavailable ||
		launches.refreshCalls != 1 || calls != 3 || releases != 2 || active != 0 || maximum != 1 ||
		maxSigning != 1 || outsideCapacity != 0 {
		t.Fatalf("concurrent refresh crypto chain = first:%d second:%d refresh:%d calls:%d releases:%d active:%d max_crypto:%d max_signing:%d outside:%d",
			firstRecorder.Code, secondRecorder.Code, launches.refreshCalls, calls, releases,
			active, maximum, maxSigning, outsideCapacity)
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
		"idleDisconnectSeconds": 1200,
	}
	encoded, _ := json.Marshal(payload)
	return encoded
}

func clientSpinBody(definitionHash string) []byte {
	return clientSpinBodyForSession(testSessionID, "round-a", definitionHash)
}

func clientSpinBodyForSession(sessionID, roundID, definitionHash string) []byte {
	payload := map[string]any{
		"operatorId": testOperatorID, "sessionId": sessionID,
		"gameId": testGameID, "definitionVersion": testDefinition,
		"definitionHash": definitionHash, "currency": testCurrency,
		"currencyExponent": 2, "jurisdiction": testRegion,
		"roundId": roundID, "roundKind": "BASE",
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
		IdleDisconnect: 20 * time.Minute, IdleDisconnectAt: now.Add(20 * time.Minute),
		TransportGeneration: 1, ServerTime: now,
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
