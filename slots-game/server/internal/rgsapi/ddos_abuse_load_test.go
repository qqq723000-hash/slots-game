package rgsapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"slots-game/server/internal/operator"
	"slots-game/server/internal/rgs"
)

type ddosAbuseLoadResult struct {
	Name                    string           `json:"name"`
	Requests                int              `json:"requests"`
	Concurrency             int              `json:"concurrency"`
	Completed               int64            `json:"completed"`
	TransportErrors         int64            `json:"transportErrors"`
	StatusCounts            map[string]int64 `json:"statusCounts"`
	OperationsPerSecond     float64          `json:"operationsPerSecond"`
	P99Milliseconds         float64          `json:"p99Milliseconds"`
	ClientAdmissionCalls    int64            `json:"clientAdmissionCalls"`
	ClientAdmissionKeys     int              `json:"clientAdmissionKeys"`
	SharedAdmissionCalls    int64            `json:"sharedAdmissionCalls"`
	SharedAdmissionKeys     int              `json:"sharedAdmissionKeys"`
	CryptographicCalls      int64            `json:"cryptographicCalls"`
	CryptographicRejected   int64            `json:"cryptographicRejected"`
	CryptographicMaxActive  int64            `json:"cryptographicMaxActive"`
	ProtectedBackendCalls   int              `json:"protectedBackendCalls"`
	UnexpectedResponseCount int64            `json:"unexpectedResponseCount"`
}

type ddosAbuseLoadReport struct {
	Schema      string                `json:"schema"`
	GatePassed  bool                  `json:"gatePassed"`
	GeneratedAt time.Time             `json:"generatedAt"`
	Environment string                `json:"environment"`
	Mode        string                `json:"mode"`
	Scenarios   []ddosAbuseLoadResult `json:"scenarios"`
	Limitations []string              `json:"limitations"`
}

type ddosAdmissionProbe struct {
	calls  atomic.Int64
	limit  int64
	keysMu sync.Mutex
	keys   map[string]struct{}
}

func (probe *ddosAdmissionProbe) Admit(_ context.Context, key string, _ time.Time) AdmissionResult {
	call := probe.calls.Add(1)
	probe.keysMu.Lock()
	probe.keys[key] = struct{}{}
	probe.keysMu.Unlock()
	if probe.limit > 0 && call > probe.limit {
		return AdmissionResult{Decision: AdmissionRateLimited, RetryAfter: time.Second}
	}
	return AdmissionResult{Decision: AdmissionAllowed}
}

func (probe *ddosAdmissionProbe) keyCount() int {
	probe.keysMu.Lock()
	defer probe.keysMu.Unlock()
	return len(probe.keys)
}

type ddosCryptographicCapacityProbe struct {
	permits  chan struct{}
	calls    atomic.Int64
	rejected atomic.Int64
	active   atomic.Int64
	maximum  atomic.Int64
}

func (probe *ddosCryptographicCapacityProbe) TryAcquire(
	ctx context.Context,
) (func(), AdmissionResult) {
	probe.calls.Add(1)
	if ctx == nil || ctx.Err() != nil {
		probe.rejected.Add(1)
		return nil, AdmissionResult{Decision: AdmissionCapacityUnavailable}
	}
	select {
	case probe.permits <- struct{}{}:
		active := probe.active.Add(1)
		for {
			maximum := probe.maximum.Load()
			if active <= maximum || probe.maximum.CompareAndSwap(maximum, active) {
				break
			}
		}
		return sync.OnceFunc(func() {
			probe.active.Add(-1)
			<-probe.permits
		}), AdmissionResult{Decision: AdmissionAllowed}
	default:
		probe.rejected.Add(1)
		return nil, AdmissionResult{Decision: AdmissionCapacityUnavailable, RetryAfter: time.Second}
	}
}

type ddosSlowAccessVerifier struct {
	delegate AccessTokenVerifier
	delay    time.Duration
}

func (verifier ddosSlowAccessVerifier) Verify(
	ctx context.Context,
	token string,
	operatorID string,
) (operator.AccessTokenClaims, error) {
	timer := time.NewTimer(verifier.delay)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
		return operator.AccessTokenClaims{}, ctx.Err()
	}
	return verifier.delegate.Verify(ctx, token, operatorID)
}

// TestRGSAPIDDoSAbuseProfile 是显式 opt-in 的应用层拒绝画像。它证明异常输入在认证、
// 共享准入或经济协调器之前被拒绝，并证明大量有效会话不能绕过按运营商聚合的经济意图配额。
// 该本机画像不产生真实资金副作用，也绝不能被表述为互联网规模 DDoS 或 AWS Shield 认证。
// English: TestRGSAPIDDoSAbuseProfile is an explicit opt-in application layer denial profile. It demonstrates that
// anomalous input is rejected before authentication, shared admissions, or the economic coordinator, and
// demonstrates that a large number of valid sessions cannot bypass economic intent quotas aggregated by carrier.
// This native profile has no real-money side effects and is in no way represented as Internet-scale DDoS or AWS
// Shield certification.
func TestRGSAPIDDoSAbuseProfile(t *testing.T) {
	if os.Getenv("RGS_RUN_HTTP_DDOS_ABUSE") != "1" {
		t.Skip("set RGS_RUN_HTTP_DDOS_ABUSE=1 to run the HTTP DDoS abuse profile")
	}
	requests := ddosLoadEnvInt(t, "RGS_DDOS_ABUSE_REQUESTS", 10_000, 1_000, 1_000_000)
	concurrency := ddosLoadEnvInt(t, "RGS_DDOS_ABUSE_CONCURRENCY", 128, 1, 2_048)
	security := newSecurityFixture(t)

	results := make([]ddosAbuseLoadResult, 0, 5)
	for _, scenario := range []struct {
		name               string
		wantStatus         int
		cryptographicFlood bool
		request            func(string, int) *http.Request
	}{
		{
			name: "oversized_body_flood", wantStatus: http.StatusRequestEntityTooLarge,
			request: func(baseURL string, index int) *http.Request {
				body := bytes.Repeat([]byte{'x'}, int(maxPublicRequestBytes)+1)
				return ddosPOSTRequest(baseURL+ClientSpinPath, body, "", index)
			},
		},
		{
			name: "malformed_json_flood", wantStatus: http.StatusBadRequest,
			request: func(baseURL string, index int) *http.Request {
				return ddosPOSTRequest(baseURL+ClientSpinPath, []byte(`{"operatorId":`), "", index)
			},
		},
		{
			name: "duplicate_header_flood", wantStatus: http.StatusUnsupportedMediaType,
			request: func(baseURL string, index int) *http.Request {
				request := ddosPOSTRequest(baseURL+ClientSpinPath, []byte(`{}`), "", index)
				request.Header["Content-Type"] = []string{"application/json", "application/json"}
				return request
			},
		},
		{
			name: "invalid_token_flood", cryptographicFlood: true,
			request: func(baseURL string, index int) *http.Request {
				return ddosPOSTRequest(baseURL+ClientSpinPath, ddosSpinBody(testSessionID, index), "invalid-token", index)
			},
		},
	} {
		clientAdmission := &ddosAdmissionProbe{keys: make(map[string]struct{})}
		sharedAdmission := &ddosAdmissionProbe{keys: make(map[string]struct{})}
		coordinator := &fakeCoordinator{}
		handler := security.newHandlerWithAllAdmissions(
			t, &fakeLaunchService{}, coordinator, &fakeRoundReader{},
			nil, clientAdmission, nil, sharedAdmission,
		)
		var cryptographic *ddosCryptographicCapacityProbe
		if scenario.cryptographicFlood {
			cryptographic = &ddosCryptographicCapacityProbe{permits: make(chan struct{}, 8)}
			handler.cryptographicCapacity = cryptographic
			handler.accessTokens = ddosSlowAccessVerifier{
				delegate: security.accessVerifier,
				delay:    2 * time.Millisecond,
			}
		}
		result := runDDoSAbuseLoad(t, handler, scenario.name, requests, concurrency, scenario.request)
		result.ClientAdmissionCalls = clientAdmission.calls.Load()
		result.ClientAdmissionKeys = clientAdmission.keyCount()
		result.SharedAdmissionCalls = sharedAdmission.calls.Load()
		result.SharedAdmissionKeys = sharedAdmission.keyCount()
		result.ProtectedBackendCalls = ddosCoordinatorCalls(coordinator)
		if cryptographic != nil {
			result.CryptographicCalls = cryptographic.calls.Load()
			result.CryptographicRejected = cryptographic.rejected.Load()
			result.CryptographicMaxActive = cryptographic.maximum.Load()
			result.UnexpectedResponseCount = unexpectedDDoSStatusClasses(
				result.StatusCounts, http.StatusUnauthorized, http.StatusServiceUnavailable,
			)
		} else {
			result.UnexpectedResponseCount = unexpectedDDoSStatuses(result.StatusCounts, map[int]int64{
				scenario.wantStatus: int64(requests),
			})
		}
		if result.TransportErrors != 0 || result.UnexpectedResponseCount != 0 ||
			result.ClientAdmissionCalls != 0 || result.SharedAdmissionCalls != 0 ||
			result.ProtectedBackendCalls != 0 {
			t.Fatalf("%s failed early-rejection invariant: %+v", scenario.name, result)
		}
		if cryptographic != nil && (result.CryptographicCalls != int64(requests) ||
			result.CryptographicRejected == 0 || result.CryptographicMaxActive > 8 ||
			result.StatusCounts[strconv.Itoa(http.StatusUnauthorized)] == 0 ||
			result.StatusCounts[strconv.Itoa(http.StatusServiceUnavailable)] != result.CryptographicRejected) {
			t.Fatalf("%s failed cryptographic bulkhead invariant: %+v", scenario.name, result)
		}
		results = append(results, result)
	}

	clientAdmission := &ddosAdmissionProbe{keys: make(map[string]struct{})}
	allowed := int64(max(1, requests/20))
	sharedAdmission := &ddosAdmissionProbe{limit: allowed, keys: make(map[string]struct{})}
	coordinator := &fakeCoordinator{spin: func(_ context.Context, request rgs.SpinRequest) (rgs.SpinResult, error) {
		return committedResult(request), nil
	}}
	identityHandler := security.newHandlerWithAllAdmissions(
		t, &fakeLaunchService{}, coordinator, &fakeRoundReader{},
		nil, clientAdmission, nil, sharedAdmission,
	)
	tokens := make([]string, requests)
	for index := range requests {
		tokens[index] = security.issueAccessTokenForSession(t, fmt.Sprintf("flood-session-%d", index), testDefinitionHash)
	}
	identity := runDDoSAbuseLoad(
		t, identityHandler, "many_identity_spin_flood", requests, concurrency,
		func(baseURL string, index int) *http.Request {
			sessionID := fmt.Sprintf("flood-session-%d", index)
			return ddosPOSTRequest(baseURL+ClientSpinPath, ddosSpinBody(sessionID, index), tokens[index], index)
		},
	)
	identity.ClientAdmissionCalls = clientAdmission.calls.Load()
	identity.ClientAdmissionKeys = clientAdmission.keyCount()
	identity.SharedAdmissionCalls = sharedAdmission.calls.Load()
	identity.SharedAdmissionKeys = sharedAdmission.keyCount()
	identity.ProtectedBackendCalls = ddosCoordinatorCalls(coordinator)
	identity.UnexpectedResponseCount = unexpectedDDoSStatuses(identity.StatusCounts, map[int]int64{
		http.StatusOK:              allowed,
		http.StatusTooManyRequests: int64(requests) - allowed,
	})
	if identity.TransportErrors != 0 || identity.UnexpectedResponseCount != 0 ||
		identity.ClientAdmissionCalls != int64(requests) || identity.ClientAdmissionKeys != requests ||
		identity.SharedAdmissionCalls != int64(requests) || identity.SharedAdmissionKeys != 1 ||
		identity.ProtectedBackendCalls != int(allowed) {
		t.Fatalf("many-identity aggregation invariant failed: %+v", identity)
	}
	results = append(results, identity)

	report := ddosAbuseLoadReport{
		Schema:      "slots-game/ddos-abuse-load/v1",
		GatePassed:  true,
		GeneratedAt: time.Now().UTC(),
		Environment: fmt.Sprintf("local loopback %s/%s go=%s; invariant evidence only", runtime.GOOS, runtime.GOARCH, runtime.Version()),
		Mode:        "invariant-enforced",
		Scenarios:   results,
		Limitations: []string{
			"the coordinator is side-effect free; this profile does not measure PostgreSQL, Valkey, wallet or outbox capacity",
			"the invalid-token scenario uses a synthetic eight-slot bulkhead and delayed verifier to enforce saturation invariants, not to certify cryptographic throughput",
			"loopback HTTP/1 traffic is not a bandwidth, TLS, HTTP/2, ALB, WAF, CloudFront or Shield DDoS certification",
			"production thresholds require an approved baseline, authorized load window and external edge telemetry",
		},
	}
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	artifactPath := os.Getenv("RGS_DDOS_ABUSE_ARTIFACT_PATH")
	if artifactPath == "" {
		artifactPath = filepath.Join("..", "..", "..", ".artifacts", "security", "ddos-abuse-report.json")
	}
	if err := os.MkdirAll(filepath.Dir(artifactPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifactPath, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, result := range results {
		t.Logf("%s: statuses=%v backend=%d throughput=%.1f/s p99=%.2fms",
			result.Name, result.StatusCounts, result.ProtectedBackendCalls,
			result.OperationsPerSecond, result.P99Milliseconds)
	}
	t.Logf("HTTP DDoS abuse artifact: %s", artifactPath)
}

func runDDoSAbuseLoad(
	t *testing.T,
	handler http.Handler,
	name string,
	requests int,
	concurrency int,
	requestFactory func(string, int) *http.Request,
) ddosAbuseLoadResult {
	t.Helper()
	server := httptest.NewServer(handler)
	defer server.Close()
	transport := &http.Transport{
		MaxIdleConns:        concurrency,
		MaxIdleConnsPerHost: concurrency,
		MaxConnsPerHost:     concurrency,
		IdleConnTimeout:     15 * time.Second,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	latencies := make([]time.Duration, requests)
	statusCounts := make(map[string]int64)
	var statusMu sync.Mutex
	var next atomic.Int64
	var completed atomic.Int64
	var transportErrors atomic.Int64
	start := make(chan struct{})
	var workers sync.WaitGroup
	started := time.Now()
	for range concurrency {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			for {
				index := int(next.Add(1) - 1)
				if index >= requests {
					return
				}
				request := requestFactory(server.URL, index)
				requestStarted := time.Now()
				response, err := client.Do(request)
				latencies[index] = time.Since(requestStarted)
				if err != nil {
					transportErrors.Add(1)
					continue
				}
				_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
				_ = response.Body.Close()
				completed.Add(1)
				statusMu.Lock()
				statusCounts[strconv.Itoa(response.StatusCode)]++
				statusMu.Unlock()
			}
		}()
	}
	close(start)
	workers.Wait()
	elapsed := time.Since(started)
	sort.Slice(latencies, func(left, right int) bool { return latencies[left] < latencies[right] })
	return ddosAbuseLoadResult{
		Name: name, Requests: requests, Concurrency: concurrency,
		Completed: completed.Load(), TransportErrors: transportErrors.Load(),
		StatusCounts: statusCounts, OperationsPerSecond: float64(requests) / elapsed.Seconds(),
		P99Milliseconds: httpLoadPercentile(latencies, 0.99),
	}
}

func ddosPOSTRequest(url string, body []byte, token string, index int) *http.Request {
	request, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-Id", fmt.Sprintf("ddos-profile-%d", index))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	return request
}

func ddosSpinBody(sessionID string, index int) []byte {
	encoded, _ := json.Marshal(map[string]any{
		"operatorId": testOperatorID, "sessionId": sessionID,
		"gameId": testGameID, "definitionVersion": testDefinition,
		"definitionHash": testDefinitionHash, "currency": testCurrency,
		"currencyExponent": 2, "jurisdiction": testRegion,
		"roundId": fmt.Sprintf("ddos-round-%d", index), "roundKind": "BASE",
		"betMinor": "100", "startRevision": "0",
	})
	return encoded
}

func unexpectedDDoSStatuses(actual map[string]int64, expected map[int]int64) int64 {
	var unexpected int64
	for status, count := range actual {
		code, err := strconv.Atoi(status)
		if err != nil {
			unexpected += count
			continue
		}
		want, exists := expected[code]
		if !exists || want != count {
			unexpected += count
		}
	}
	for status, want := range expected {
		if actual[strconv.Itoa(status)] != want {
			unexpected += want
		}
	}
	return unexpected
}

func unexpectedDDoSStatusClasses(actual map[string]int64, allowed ...int) int64 {
	accepted := make(map[string]struct{}, len(allowed))
	for _, status := range allowed {
		accepted[strconv.Itoa(status)] = struct{}{}
	}
	var unexpected int64
	for status, count := range actual {
		if _, exists := accepted[status]; !exists {
			unexpected += count
		}
	}
	return unexpected
}

func ddosCoordinatorCalls(coordinator *fakeCoordinator) int {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	return coordinator.calls
}

func ddosLoadEnvInt(t *testing.T, name string, fallback, minimum, maximum int) int {
	t.Helper()
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		t.Fatalf("%s must be %d..%d, got %q", name, minimum, maximum, raw)
	}
	return value
}
