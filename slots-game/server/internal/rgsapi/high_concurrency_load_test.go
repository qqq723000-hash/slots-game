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

type httpLoadResult struct {
	Name                string           `json:"name"`
	Requests            int              `json:"requests"`
	Concurrency         int              `json:"concurrency"`
	Succeeded           int64            `json:"succeeded"`
	CapacityUnavailable int64            `json:"capacityUnavailable"`
	Failed              int64            `json:"failed"`
	OperationsPerSecond float64          `json:"operationsPerSecond"`
	P50Milliseconds     float64          `json:"p50Milliseconds"`
	P95Milliseconds     float64          `json:"p95Milliseconds"`
	P99Milliseconds     float64          `json:"p99Milliseconds"`
	StatusCounts        map[string]int64 `json:"statusCounts"`
	ErrorSamples        []string         `json:"errorSamples,omitempty"`
}

type httpLoadReport struct {
	Schema      string             `json:"schema"`
	GatePassed  bool               `json:"gatePassed"`
	GeneratedAt time.Time          `json:"generatedAt"`
	Environment string             `json:"environment"`
	Mode        string             `json:"mode"`
	Thresholds  map[string]float64 `json:"thresholds,omitempty"`
	Scenarios   []httpLoadResult   `json:"scenarios"`
	Limitations []string           `json:"limitations"`
}

type loadIntentCapacity struct {
	permits chan struct{}
}

func (capacity *loadIntentCapacity) TryAcquire(context.Context) (func(), AdmissionResult) {
	select {
	case capacity.permits <- struct{}{}:
		return func() { <-capacity.permits }, AdmissionResult{Decision: AdmissionAllowed}
	default:
		return nil, AdmissionResult{Decision: AdmissionCapacityUnavailable}
	}
}

// TestRGSAPIHighConcurrencyProfile 是显式 opt-in 的 HTTP 协议画像。它经过真实 socket、
// access-token 验证、严格 JSON、响应编码和 Ed25519 签名，但使用无资金副作用的协调器；
// PostgreSQL、Valkey 和钱包容量由各自的隔离负载门禁测量，不能把本结果外推为整站 TPS。
// English: TestRGSAPIHighConcurrencyProfile is an explicit opt-in HTTP protocol profile. It is authenticated with
// real sockets, access-token verification, strict JSON, response encoding, and Ed25519 signatures, but uses a
// coordinator with no financial side effects; PostgreSQL, Valkey, and wallet capacity are measured by their
// respective isolated load gates, and this result cannot be extrapolated to the entire site TPS.
func TestRGSAPIHighConcurrencyProfile(t *testing.T) {
	if os.Getenv("RGS_RUN_HTTP_HIGH_CONCURRENCY") != "1" {
		t.Skip("set RGS_RUN_HTTP_HIGH_CONCURRENCY=1 to run the HTTP load profile")
	}
	requests := httpLoadEnvInt(t, "RGS_HTTP_LOAD_REQUESTS", 20_000, 10_000, 2_000_000)
	minimumThroughput := httpLoadOptionalFloat(t, "RGS_HTTP_LOAD_MIN_OPS_PER_SECOND")
	maximumP99 := httpLoadOptionalFloat(t, "RGS_HTTP_LOAD_MAX_P99_MS")
	if (minimumThroughput == 0) != (maximumP99 == 0) {
		t.Fatal("RGS_HTTP_LOAD_MIN_OPS_PER_SECOND and RGS_HTTP_LOAD_MAX_P99_MS must be configured together")
	}
	security := newSecurityFixture(t)
	token := security.issueAccessTokenForSession(t, testSessionID, testDefinitionHash)

	steadyHandler := security.newHandler(
		t,
		&fakeLaunchService{},
		&fakeCoordinator{spin: func(_ context.Context, request rgs.SpinRequest) (rgs.SpinResult, error) {
			return committedResult(request), nil
		}},
		&fakeRoundReader{},
	)
	steady := runRGSAPILoad(t, steadyHandler, token, "steady", requests, 32)
	if steady.Failed != 0 || steady.CapacityUnavailable != 0 || steady.Succeeded != int64(requests) {
		t.Fatalf("steady HTTP profile failed: %+v", steady)
	}

	step := runRGSAPILoad(t, steadyHandler, token, "step", requests, 128)
	if step.Failed != 0 || step.CapacityUnavailable != 0 || step.Succeeded != int64(requests) {
		t.Fatalf("step HTTP profile failed: %+v", step)
	}
	if minimumThroughput > 0 {
		for _, scenario := range []httpLoadResult{steady, step} {
			if scenario.OperationsPerSecond < minimumThroughput || scenario.P99Milliseconds > maximumP99 {
				t.Fatalf("%s missed approved local threshold: throughput=%.1f minimum=%.1f p99=%.2f maximum=%.2f",
					scenario.Name, scenario.OperationsPerSecond, minimumThroughput,
					scenario.P99Milliseconds, maximumP99)
			}
		}
	}

	capacityHandler := security.newHandler(
		t,
		&fakeLaunchService{},
		&fakeCoordinator{spin: func(_ context.Context, request rgs.SpinRequest) (rgs.SpinResult, error) {
			time.Sleep(5 * time.Millisecond)
			return committedResult(request), nil
		}},
		&fakeRoundReader{},
	)
	capacityHandler.newIntentCapacity = &loadIntentCapacity{permits: make(chan struct{}, 15)}
	capacity := runRGSAPILoad(t, capacityHandler, token, "capacity_shed", requests/2, 128)
	if capacity.Failed != 0 || capacity.CapacityUnavailable == 0 || capacity.Succeeded == 0 ||
		capacity.Succeeded+capacity.CapacityUnavailable != int64(requests/2) {
		t.Fatalf("capacity HTTP profile failed: %+v", capacity)
	}

	report := httpLoadReport{
		Schema:      "slots-game/http-load/v1",
		GatePassed:  minimumThroughput > 0,
		GeneratedAt: time.Now().UTC(),
		Environment: fmt.Sprintf("local %s/%s go=%s; comparative evidence only", runtime.GOOS, runtime.GOARCH, runtime.Version()),
		Mode:        "report-only",
		Scenarios:   []httpLoadResult{steady, step, capacity},
		Limitations: []string{
			"the coordinator is side-effect free; PostgreSQL, Valkey and wallet are profiled by separate isolated gates",
			"local loopback throughput is not an AWS, TLS ingress or third-party wallet capacity certification",
			"the 24-hour soak, AZ loss and cloud failover gates remain external release evidence",
		},
	}
	if minimumThroughput > 0 {
		report.Mode = "local-threshold-enforced"
		report.Thresholds = map[string]float64{
			"minimumOperationsPerSecond": minimumThroughput,
			"maximumP99Milliseconds":     maximumP99,
		}
	}
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	artifactPath := os.Getenv("RGS_HTTP_LOAD_ARTIFACT_PATH")
	if artifactPath == "" {
		artifactPath = filepath.Join("..", "..", "..", ".artifacts", "high-concurrency", "http-report.json")
	}
	if err := os.MkdirAll(filepath.Dir(artifactPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifactPath, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range report.Scenarios {
		t.Logf("%s: ok=%d shed=%d fail=%d throughput=%.1f/s p95=%.2fms p99=%.2fms",
			scenario.Name, scenario.Succeeded, scenario.CapacityUnavailable, scenario.Failed,
			scenario.OperationsPerSecond, scenario.P95Milliseconds, scenario.P99Milliseconds)
	}
	t.Logf("HTTP high-concurrency artifact: %s", artifactPath)
}

func runRGSAPILoad(
	t *testing.T,
	handler http.Handler,
	token string,
	name string,
	requests int,
	concurrency int,
) httpLoadResult {
	t.Helper()
	server := httptest.NewServer(handler)
	defer server.Close()
	transport := &http.Transport{
		MaxIdleConns:        concurrency,
		MaxIdleConnsPerHost: concurrency,
		MaxConnsPerHost:     concurrency,
		IdleConnTimeout:     30 * time.Second,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second}
	latencies := make([]time.Duration, requests)
	var next atomic.Int64
	var succeeded atomic.Int64
	var capacityUnavailable atomic.Int64
	var failed atomic.Int64
	statusCounts := make(map[string]int64)
	errorSamples := make([]string, 0, 8)
	var diagnosticMu sync.Mutex
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
				body := httpLoadSpinBody(index)
				req, err := http.NewRequest(http.MethodPost, server.URL+ClientSpinPath, bytes.NewReader(body))
				if err != nil {
					failed.Add(1)
					continue
				}
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Authorization", "Bearer "+token)
				req.Header.Set(operator.HeaderRequestID, fmt.Sprintf("load-%s-%d", name, index))
				requestStarted := time.Now()
				response, err := client.Do(req)
				latencies[index] = time.Since(requestStarted)
				if err != nil {
					failed.Add(1)
					diagnosticMu.Lock()
					statusCounts["transport_error"]++
					if len(errorSamples) < cap(errorSamples) {
						errorSamples = append(errorSamples, err.Error())
					}
					diagnosticMu.Unlock()
					continue
				}
				responseBody, readErr := io.ReadAll(io.LimitReader(response.Body, 64<<10))
				_ = response.Body.Close()
				diagnosticMu.Lock()
				statusCounts[strconv.Itoa(response.StatusCode)]++
				diagnosticMu.Unlock()
				if readErr != nil {
					failed.Add(1)
					diagnosticMu.Lock()
					if len(errorSamples) < cap(errorSamples) {
						errorSamples = append(errorSamples, readErr.Error())
					}
					diagnosticMu.Unlock()
					continue
				}
				switch response.StatusCode {
				case http.StatusOK:
					succeeded.Add(1)
				case http.StatusServiceUnavailable:
					if response.Header.Get("Retry-After") == "1" {
						capacityUnavailable.Add(1)
					} else {
						failed.Add(1)
					}
				default:
					failed.Add(1)
					diagnosticMu.Lock()
					if len(errorSamples) < cap(errorSamples) {
						errorSamples = append(errorSamples, fmt.Sprintf("status=%d body=%s", response.StatusCode, responseBody))
					}
					diagnosticMu.Unlock()
				}
			}
		}()
	}
	close(start)
	workers.Wait()
	elapsed := time.Since(started)
	sort.Slice(latencies, func(left, right int) bool { return latencies[left] < latencies[right] })
	return httpLoadResult{
		Name: name, Requests: requests, Concurrency: concurrency,
		Succeeded: succeeded.Load(), CapacityUnavailable: capacityUnavailable.Load(), Failed: failed.Load(),
		OperationsPerSecond: float64(requests) / elapsed.Seconds(),
		P50Milliseconds:     httpLoadPercentile(latencies, 0.50),
		P95Milliseconds:     httpLoadPercentile(latencies, 0.95),
		P99Milliseconds:     httpLoadPercentile(latencies, 0.99),
		StatusCounts:        statusCounts,
		ErrorSamples:        errorSamples,
	}
}

func httpLoadSpinBody(index int) []byte {
	encoded, _ := json.Marshal(map[string]any{
		"operatorId": testOperatorID, "sessionId": testSessionID,
		"gameId": testGameID, "definitionVersion": testDefinition,
		"definitionHash": testDefinitionHash, "currency": testCurrency,
		"currencyExponent": 2, "jurisdiction": testRegion,
		"roundId": fmt.Sprintf("load-round-%d", index), "roundKind": "BASE",
		"betMinor": "100", "startRevision": "0",
	})
	return encoded
}

func httpLoadPercentile(latencies []time.Duration, percentile float64) float64 {
	if len(latencies) == 0 {
		return 0
	}
	index := int(float64(len(latencies)-1) * percentile)
	return float64(latencies[index]) / float64(time.Millisecond)
}

func httpLoadEnvInt(t *testing.T, name string, fallback, minimum, maximum int) int {
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

func httpLoadOptionalFloat(t *testing.T, name string) float64 {
	t.Helper()
	raw := os.Getenv(name)
	if raw == "" {
		return 0
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || value <= 0 {
		t.Fatalf("%s must be a positive number, got %q", name, raw)
	}
	return value
}
