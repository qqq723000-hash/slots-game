package sharedadmission

import (
	"context"
	"crypto/fips140"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	valkey "github.com/valkey-io/valkey-go"
)

// legacyTokenBucketScriptBody 仅保留生产 v1 脚本作为可复现的压测基线，
// 运行时代码绝不能选择这个脚本。
const legacyTokenBucketScriptBody = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'updated')
local tokens = capacity
local updated = now
if state[1] and state[2] then
  tokens = tonumber(state[1])
  updated = tonumber(state[2])
end
local elapsed = now - updated
if elapsed < 0 then elapsed = 0 end
local fill_time = math.ceil(capacity * 1000 / rate)
if elapsed > fill_time then elapsed = fill_time end
tokens = math.min(capacity, tokens + math.floor(elapsed * rate / 1000))
local allowed = 0
local retry_ms = 0
if tokens >= 1000 then
  tokens = tokens - 1000
  allowed = 1
else
  retry_ms = math.max(1, math.ceil((1000 - tokens) * 1000 / rate))
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated', now)
redis.call('PEXPIRE', KEYS[1], math.max(1000, fill_time + 1000))
return {allowed, retry_ms}
`

type loadScenario struct {
	name            string
	keys            int
	capacityMilli   int64
	rateMilli       int64
	firstWorkers    int
	secondWorkers   int
	flushAtMidpoint bool
}

type loadResult struct {
	Variant                 string  `json:"variant"`
	Scenario                string  `json:"scenario"`
	Requests                int     `json:"requests"`
	Workers                 string  `json:"workers"`
	Keys                    int64   `json:"keys"`
	Allowed                 uint64  `json:"allowed"`
	Limited                 uint64  `json:"limited"`
	Errors                  uint64  `json:"errors"`
	NOScriptFallbacks       uint64  `json:"noscript_fallbacks"`
	ScriptBodyEvaluations   int64   `json:"script_body_evaluations"`
	ScriptBodyBytes         int64   `json:"script_body_bytes"`
	OperationsPerSecond     float64 `json:"ops_per_second"`
	P95Microseconds         int64   `json:"p95_us"`
	P99Microseconds         int64   `json:"p99_us"`
	StateWriteCommands      int64   `json:"state_write_commands"`
	StateWritesPerOperation float64 `json:"state_writes_per_operation"`
	ReplicationBytes        int64   `json:"replication_bytes"`
	ReplicationBytesPerOp   float64 `json:"replication_bytes_per_operation"`
	ConnectedClients        int64   `json:"connected_clients"`
	ConnectedReplicas       int64   `json:"connected_replicas"`
	NewConnections          int64   `json:"new_connections"`
	ServerErrorReplies      int64   `json:"server_error_replies"`
	UnexpectedServerErrors  int64   `json:"unexpected_server_errors"`
	RejectedConnections     int64   `json:"rejected_connections"`
}

type loadCapacityThreshold struct {
	MinimumOperationsPerSecond float64 `json:"min_ops_per_second"`
	MaximumP99Microseconds     int64   `json:"max_p99_us"`
}

type loadEnvironment struct {
	CapacityEnvironment string `json:"capacityEnvironment"`
	GoVersion           string `json:"goVersion"`
	LoadArch            string `json:"loadArch"`
	ServerOS            string `json:"serverOS"`
	ValkeyVersion       string `json:"valkeyVersion"`
	Topology            string `json:"topology"`
	ClientConnections   int    `json:"clientConnections"`
	Persistence         string `json:"persistence"`
}

type loadReport struct {
	Schema                     string                           `json:"schema"`
	GeneratedAt                string                           `json:"generatedAt"`
	GatePassed                 bool                             `json:"gatePassed"`
	RequestsPerVariantScenario int                              `json:"requestsPerVariantScenario"`
	TotalRequests              int                              `json:"totalRequests"`
	Environment                loadEnvironment                  `json:"environment"`
	Limitations                []string                         `json:"limitations"`
	Thresholds                 map[string]loadCapacityThreshold `json:"thresholds,omitempty"`
	Results                    []loadResult                     `json:"results"`
}

type loadCounters struct {
	allowed           atomic.Uint64
	limited           atomic.Uint64
	errors            atomic.Uint64
	noscriptFallbacks atomic.Uint64
}

type loadScriptRunner struct {
	client     valkey.Client
	transport  *valkeyExecutor
	body       string
	sha        string
	counters   *loadCounters
	production *valkeyExecutor
}

var loadServerRunIDPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

func (runner *loadScriptRunner) evaluate(ctx context.Context, key string, args []string) {
	if runner.production != nil {
		values, err := runner.production.Evaluate(ctx, key, args)
		runner.record(values, err)
		return
	}
	result := runner.transport.call(ctx, func() valkey.ValkeyResult {
		return runner.client.Do(ctx, runner.client.B().Evalsha().Sha1(runner.sha).
			Numkeys(1).Key(key).Arg(args...).Build())
	})
	if result.noScript {
		runner.counters.noscriptFallbacks.Add(1)
		result = runner.transport.call(ctx, func() valkey.ValkeyResult {
			return runner.client.Do(ctx, runner.client.B().Eval().Script(runner.body).
				Numkeys(1).Key(key).Arg(args...).Build())
		})
	}
	runner.record(result.values, result.err)
}

func (runner *loadScriptRunner) record(values []int64, err error) {
	if err != nil || len(values) != 2 || (values[0] != 0 && values[0] != 1) || values[1] < 0 {
		runner.counters.errors.Add(1)
		return
	}
	if values[0] == 1 {
		runner.counters.allowed.Add(1)
		return
	}
	runner.counters.limited.Add(1)
}

// TestSharedAdmissionLoadProfile 必须显式启用，因为它要求隔离且可销毁的 Valkey 端点，
// 并会主动施加高并发负载。测试为每个变体和场景输出一个 JSON 对象；当
// RGS_SHARED_ADMISSION_LOAD_REPORT_PATH 为绝对路径时，还会原子写入稳定报告。
func TestSharedAdmissionLoadProfile(t *testing.T) {
	address := os.Getenv("RGS_SHARED_ADMISSION_LOAD_ADDR")
	if address == "" {
		t.Skip("set RGS_SHARED_ADMISSION_LOAD_ADDR to an isolated Valkey host:port")
	}
	if fips140.Enforced() {
		t.Skip("Valkey SCRIPT uses SHA-1 protocol addresses, unavailable in this test process under FIPS-only mode")
	}
	requests := loadRequestCount(t)
	clientOptions := boundedValkeyClientOptions(500 * time.Millisecond)
	clientOptions.InitAddress = []string{address}
	clientOptions.ClientName = "rgs-shared-admission-load"
	client, err := valkey.NewClient(clientOptions)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := client.Do(ctx, client.B().Ping().Build()).Error(); err != nil {
		t.Fatalf("ping isolated Valkey: %v", err)
	}
	serverInfo, err := client.Do(ctx, client.B().Arbitrary("INFO", "server").Build()).ToString()
	if err != nil {
		t.Fatal(err)
	}
	requireDisposableLoadTarget(t, ctx, client, address, serverInfo)
	warmBoundedValkeyPool(t, ctx, client)
	environment := loadEnvironment{
		CapacityEnvironment: "local-non-tls",
		ValkeyVersion:       parseInfoString(serverInfo, "valkey_version"),
		ServerOS:            parseInfoString(serverInfo, "os"),
		GoVersion:           runtime.Version(),
		LoadArch:            runtime.GOOS + "/" + runtime.GOARCH,
		Topology:            "one disposable primary plus one replica over Docker loopback",
		ClientConnections:   maximumValkeyConnectionsPerPod,
		Persistence:         "disabled",
	}
	encodedEnvironment, err := json.Marshal(environment)
	if err != nil {
		t.Fatal(err)
	}
	t.Log(string(encodedEnvironment))

	allowedCapacityMilli := int64(min(requests, 1_000_000)) * 1_000
	scenarios := []loadScenario{
		{name: "steady", keys: 4096, capacityMilli: allowedCapacityMilli, rateMilli: 100_000_000, firstWorkers: 16},
		{name: "step", keys: 1, capacityMilli: allowedCapacityMilli, rateMilli: 100_000_000, firstWorkers: 1, secondWorkers: 64},
		{name: "hot_key", keys: 1, capacityMilli: allowedCapacityMilli, rateMilli: 100_000_000, firstWorkers: 64},
		{name: "many_identity", keys: requests, capacityMilli: 40_000, rateMilli: 20_000, firstWorkers: 64},
		// many_identity 与 deny_storm 使用同一 20/s、burst 40 配额；前者模拟旧的
		// session 分桶，后者模拟按 operator 聚合后的爆款流量。
		{name: "deny_storm", keys: 1, capacityMilli: 40_000, rateMilli: 20_000, firstWorkers: 64},
		{name: "failover_noscript", keys: 4096, capacityMilli: allowedCapacityMilli, rateMilli: 100_000_000, firstWorkers: 64, flushAtMidpoint: true},
	}
	thresholds := loadCapacityThresholds(t, scenarios)
	if thresholds == nil {
		t.Log(`{"capacity_gate":"report-only","reason":"RGS_SHARED_ADMISSION_LOAD_THRESHOLDS_JSON is unset; local results are evidence, not an approved production capacity gate"}`)
	}
	t.Log(`{"evidence_scope":"caller-supplied endpoint; this harness does not prove TLS, ElastiCache, Multi-AZ, or a real node failover; failover_noscript only flushes the script cache"}`)
	variants := []struct {
		name string
		body string
	}{
		{name: "baseline_v1", body: legacyTokenBucketScriptBody},
		{name: "optimized_v2", body: tokenBucketScriptBody},
	}
	results := make(map[string]loadResult, len(scenarios)*len(variants))
	for scenarioIndex, scenario := range scenarios {
		orderedVariants := variants
		if scenarioIndex%2 == 1 {
			orderedVariants = []struct {
				name string
				body string
			}{variants[1], variants[0]}
		}
		for _, variant := range orderedVariants {
			result := runLoadScenario(t, ctx, client, variant.name, variant.body, scenario, requests)
			encoded, err := json.Marshal(result)
			if err != nil {
				t.Fatal(err)
			}
			t.Log(string(encoded))
			results[variant.name+"/"+scenario.name] = result
		}
	}

	for _, scenario := range scenarios {
		baseline := results["baseline_v1/"+scenario.name]
		optimized := results["optimized_v2/"+scenario.name]
		if baseline.Errors != 0 || optimized.Errors != 0 {
			t.Fatalf("%s produced application errors: baseline=%d optimized=%d", scenario.name, baseline.Errors, optimized.Errors)
		}
		if baseline.StateWriteCommands != int64(requests)*2 {
			t.Fatalf("%s baseline writes=%d, want %d", scenario.name, baseline.StateWriteCommands, requests*2)
		}
		if optimized.StateWriteCommands != int64(optimized.Allowed) {
			t.Fatalf("%s optimized writes=%d, allowed=%d", scenario.name, optimized.StateWriteCommands, optimized.Allowed)
		}
		if optimized.StateWriteCommands > baseline.StateWriteCommands/2 {
			t.Fatalf("%s optimized write amplification regressed: baseline=%d optimized=%d", scenario.name, baseline.StateWriteCommands, optimized.StateWriteCommands)
		}
		for _, result := range []loadResult{baseline, optimized} {
			if result.UnexpectedServerErrors != 0 || result.RejectedConnections != 0 ||
				result.NewConnections != 0 || result.ConnectedClients != maximumValkeyConnectionsPerPod ||
				result.ConnectedReplicas < 1 {
				t.Fatalf("%s/%s connection or server error gate failed: %+v", result.Variant, result.Scenario, result)
			}
		}
		if threshold, ok := thresholds[scenario.name]; ok {
			if optimized.OperationsPerSecond < threshold.MinimumOperationsPerSecond ||
				optimized.P99Microseconds > threshold.MaximumP99Microseconds {
				t.Fatalf("%s optimized capacity gate failed: result=%+v threshold=%+v", scenario.name, optimized, threshold)
			}
		}
	}
	if results["optimized_v2/deny_storm"].StateWritesPerOperation >= 0.01 {
		t.Fatalf("deny storm still writes per rejected request: %+v", results["optimized_v2/deny_storm"])
	}
	if results["optimized_v2/failover_noscript"].NOScriptFallbacks == 0 {
		t.Fatal("failover scenario did not exercise NOSCRIPT recovery")
	}
	if baseline, optimized := results["baseline_v1/failover_noscript"], results["optimized_v2/failover_noscript"]; baseline.ScriptBodyEvaluations <= 1 || optimized.ScriptBodyEvaluations != 1 {
		t.Fatalf("NOSCRIPT body amplification was not coalesced: baseline=%d optimized=%d", baseline.ScriptBodyEvaluations, optimized.ScriptBodyEvaluations)
	}
	verifyOptimizedScriptIntegrity(t, ctx, client)
	writeLoadReport(t, requests, environment, thresholds, scenarios, results)
}

func warmBoundedValkeyPool(t *testing.T, parent context.Context, client valkey.Client) {
	t.Helper()
	executor := newValkeyExecutor(client)
	ctx, cancel := context.WithTimeout(parent, time.Second)
	defer cancel()
	start := make(chan struct{})
	var group sync.WaitGroup
	var failures atomic.Int64
	for index := range synchronousValkeyPoolSize {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			if err := executor.acquireTransport(ctx); err != nil {
				failures.Add(1)
				return
			}
			defer executor.releaseTransport()
			key := fmt.Sprintf("rgs:shared-admission:v2:{load-warmup-%d}", index)
			if err := client.Do(ctx, client.B().Arbitrary("BLPOP", key, "0.05").Build()).Error(); err != nil && !valkey.IsValkeyNil(err) {
				failures.Add(1)
			}
		}()
	}
	close(start)
	group.Wait()
	if failures.Load() != 0 {
		t.Fatalf("warm bounded Valkey pool failures = %d", failures.Load())
	}
	clientsInfo, err := client.Do(ctx, client.B().Arbitrary("INFO", "clients").Build()).ToString()
	if err != nil {
		t.Fatal(err)
	}
	if connected := parseInfoInteger(clientsInfo, "connected_clients"); connected != maximumValkeyConnectionsPerPod {
		t.Fatalf("bounded Valkey pool connections = %d, want %d", connected, maximumValkeyConnectionsPerPod)
	}
}

func requireDisposableLoadTarget(
	t *testing.T,
	ctx context.Context,
	client valkey.Client,
	address string,
	serverInfo string,
) {
	t.Helper()
	if os.Getenv("RGS_SHARED_ADMISSION_LOAD_ALLOW_DESTRUCTIVE") != "YES" {
		t.Fatal("RGS_SHARED_ADMISSION_LOAD_ALLOW_DESTRUCTIVE=YES is required for destructive Valkey load testing")
	}
	expectedRunID := strings.TrimSpace(os.Getenv("RGS_SHARED_ADMISSION_LOAD_EXPECTED_RUN_ID"))
	if err := validateDisposableLoadTargetInput(address, expectedRunID, parseInfoString(serverInfo, "run_id")); err != nil {
		t.Fatal(err)
	}
	databaseSize, err := client.Do(ctx, client.B().Arbitrary("DBSIZE").Build()).AsInt64()
	if err != nil {
		t.Fatalf("read disposable Valkey database size: %v", err)
	}
	if databaseSize != 0 {
		t.Fatalf("destructive Valkey load target is not empty: dbsize=%d", databaseSize)
	}
	clientsInfo, err := client.Do(ctx, client.B().Arbitrary("INFO", "clients").Build()).ToString()
	if err != nil {
		t.Fatalf("read disposable Valkey clients: %v", err)
	}
	// 此时客户端包含一条基础 mux socket 和第一条延迟创建的同步业务 socket；
	// 出现第三条连接说明另有客户端正在访问本应独占的破坏性测试目标。
	if connected := parseInfoInteger(clientsInfo, "connected_clients"); connected != 2 {
		t.Fatalf("destructive Valkey load target is not exclusively held: connected_clients=%d want=2", connected)
	}
	replicationInfo, err := client.Do(ctx, client.B().Arbitrary("INFO", "replication").Build()).ToString()
	if err != nil {
		t.Fatalf("read disposable Valkey replication: %v", err)
	}
	if role := parseInfoString(replicationInfo, "role"); role != "master" {
		t.Fatalf("destructive Valkey load target must be a disposable primary, got role=%q", role)
	}
	if replicas := parseInfoInteger(replicationInfo, "connected_slaves"); replicas < 1 {
		t.Fatal("destructive Valkey load target must have at least one disposable replica")
	}
}

func validateDisposableLoadTargetInput(address string, expectedRunID string, actualRunID string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("RGS_SHARED_ADMISSION_LOAD_ADDR must be an explicit loopback host:port: %w", err)
	}
	if host != "localhost" {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return errors.New("destructive Valkey load testing is restricted to a loopback disposable endpoint")
		}
	}
	if !loadServerRunIDPattern.MatchString(expectedRunID) {
		return errors.New("RGS_SHARED_ADMISSION_LOAD_EXPECTED_RUN_ID must be the disposable server's 40-character run_id")
	}
	if actualRunID != expectedRunID {
		return errors.New("disposable Valkey run_id does not match the explicit target proof")
	}
	return nil
}

func TestValidateDisposableLoadTargetInput(t *testing.T) {
	runID := strings.Repeat("a", 40)
	for name, testCase := range map[string]struct {
		address  string
		expected string
		actual   string
		valid    bool
	}{
		"IPv4 loopback":         {address: "127.0.0.1:16379", expected: runID, actual: runID, valid: true},
		"IPv6 loopback":         {address: "[::1]:16379", expected: runID, actual: runID, valid: true},
		"localhost":             {address: "localhost:16379", expected: runID, actual: runID, valid: true},
		"remote endpoint":       {address: "cache.example:6379", expected: runID, actual: runID},
		"missing port":          {address: "127.0.0.1", expected: runID, actual: runID},
		"malformed expected ID": {address: "127.0.0.1:16379", expected: "short", actual: "short"},
		"wrong server":          {address: "127.0.0.1:16379", expected: runID, actual: strings.Repeat("b", 40)},
	} {
		t.Run(name, func(t *testing.T) {
			err := validateDisposableLoadTargetInput(testCase.address, testCase.expected, testCase.actual)
			if (err == nil) != testCase.valid {
				t.Fatalf("validation error = %v, valid=%t", err, testCase.valid)
			}
		})
	}
}

func writeLoadReport(
	t *testing.T,
	requests int,
	environment loadEnvironment,
	thresholds map[string]loadCapacityThreshold,
	scenarios []loadScenario,
	results map[string]loadResult,
) {
	t.Helper()
	reportPath := os.Getenv("RGS_SHARED_ADMISSION_LOAD_REPORT_PATH")
	if reportPath == "" {
		return
	}
	if !filepath.IsAbs(reportPath) {
		t.Fatal("RGS_SHARED_ADMISSION_LOAD_REPORT_PATH must be absolute")
	}
	orderedResults := make([]loadResult, 0, len(results))
	for _, scenario := range scenarios {
		for _, variant := range []string{"baseline_v1", "optimized_v2"} {
			result, ok := results[variant+"/"+scenario.name]
			if !ok {
				t.Fatalf("missing load result %s/%s", variant, scenario.name)
			}
			orderedResults = append(orderedResults, result)
		}
	}
	report := loadReport{
		Schema:                     "slots-game/shared-admission-load/v1",
		GeneratedAt:                time.Now().UTC().Format(time.RFC3339),
		GatePassed:                 thresholds != nil,
		RequestsPerVariantScenario: requests,
		TotalRequests:              requests * len(orderedResults),
		Environment:                environment,
		Limitations: []string{
			"No TLS or ACL was exercised by this local harness.",
			"This is not ElastiCache or a Multi-AZ network capacity result.",
			"failover_noscript uses SCRIPT FLUSH and is not a real node failover.",
			"Thresholds are caller-supplied regression gates and are not approved production SLOs.",
		},
		Thresholds: thresholds,
		Results:    orderedResults,
	}
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(reportPath), 0o750); err != nil {
		t.Fatalf("create load report directory: %v", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(reportPath), ".valkey-report-*.tmp")
	if err != nil {
		t.Fatalf("create load report: %v", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		t.Fatalf("protect load report: %v", err)
	}
	if _, err := temporary.Write(append(encoded, '\n')); err != nil {
		_ = temporary.Close()
		t.Fatalf("write load report: %v", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		t.Fatalf("sync load report: %v", err)
	}
	if err := temporary.Close(); err != nil {
		t.Fatalf("close load report: %v", err)
	}
	if err := os.Rename(temporaryPath, reportPath); err != nil {
		t.Fatalf("publish load report: %v", err)
	}
	t.Logf("wrote ignored load report %s", reportPath)
}

func loadCapacityThresholds(t *testing.T, scenarios []loadScenario) map[string]loadCapacityThreshold {
	t.Helper()
	raw := os.Getenv("RGS_SHARED_ADMISSION_LOAD_THRESHOLDS_JSON")
	if raw == "" {
		return nil
	}
	thresholds, err := parseLoadCapacityThresholds(raw, scenarios)
	if err != nil {
		t.Fatalf("RGS_SHARED_ADMISSION_LOAD_THRESHOLDS_JSON: %v", err)
	}
	return thresholds
}

func parseLoadCapacityThresholds(raw string, scenarios []loadScenario) (map[string]loadCapacityThreshold, error) {
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	thresholds := make(map[string]loadCapacityThreshold, len(scenarios))
	if err := decoder.Decode(&thresholds); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, fmt.Errorf("trailing data: %w", err)
	}
	wanted := make(map[string]struct{}, len(scenarios))
	for _, scenario := range scenarios {
		wanted[scenario.name] = struct{}{}
		threshold, ok := thresholds[scenario.name]
		if !ok || threshold.MinimumOperationsPerSecond <= 0 || threshold.MaximumP99Microseconds <= 0 {
			return nil, fmt.Errorf("missing or invalid threshold for %q", scenario.name)
		}
	}
	for name := range thresholds {
		if _, ok := wanted[name]; !ok {
			return nil, fmt.Errorf("threshold names unknown scenario %q", name)
		}
	}
	return thresholds, nil
}

func TestParseLoadCapacityThresholds(t *testing.T) {
	scenarios := []loadScenario{{name: "steady"}, {name: "hot_key"}}
	valid := `{"steady":{"min_ops_per_second":1000,"max_p99_us":2000},"hot_key":{"min_ops_per_second":2000,"max_p99_us":3000}}`
	thresholds, err := parseLoadCapacityThresholds(valid, scenarios)
	if err != nil || thresholds["steady"].MinimumOperationsPerSecond != 1000 || thresholds["hot_key"].MaximumP99Microseconds != 3000 {
		t.Fatalf("valid capacity thresholds = %#v, %v", thresholds, err)
	}
	for name, raw := range map[string]string{
		"missing scenario": `{"steady":{"min_ops_per_second":1000,"max_p99_us":2000}}`,
		"unknown scenario": `{"steady":{"min_ops_per_second":1000,"max_p99_us":2000},"hot_key":{"min_ops_per_second":2000,"max_p99_us":3000},"extra":{"min_ops_per_second":1,"max_p99_us":1}}`,
		"zero threshold":   `{"steady":{"min_ops_per_second":0,"max_p99_us":2000},"hot_key":{"min_ops_per_second":2000,"max_p99_us":3000}}`,
		"unknown field":    `{"steady":{"min_ops_per_second":1000,"max_p99_us":2000,"typo":1},"hot_key":{"min_ops_per_second":2000,"max_p99_us":3000}}`,
		"trailing data":    valid + `{}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseLoadCapacityThresholds(raw, scenarios); err == nil {
				t.Fatal("invalid capacity thresholds accepted")
			}
		})
	}
}

func verifyOptimizedScriptIntegrity(t *testing.T, ctx context.Context, client valkey.Client) {
	t.Helper()
	if err := client.Do(ctx, client.B().Arbitrary("FLUSHDB").Build()).Error(); err != nil {
		t.Fatal(err)
	}
	sha, err := client.Do(ctx, client.B().Arbitrary("SCRIPT", "LOAD", tokenBucketScriptBody).Build()).ToString()
	if err != nil {
		t.Fatal(err)
	}
	key := "load:optimized-integrity:{operator-a}"
	evaluate := func(capacity, rate string) ([]int64, error) {
		return client.Do(ctx, client.B().Evalsha().Sha1(sha).Numkeys(1).Key(key).Arg(capacity, rate).Build()).AsIntSlice()
	}
	if values, err := evaluate("40000", "20000"); err != nil || len(values) != 2 || values[0] != 1 {
		t.Fatalf("initial optimized state = %v, %v", values, err)
	}
	// 安全的速率变更必须读取持久化的 TTL 基准，不能把旧桶误判为损坏，
	// 也不能用 Pod 的墙上时钟推导已经流逝的时间。
	if values, err := evaluate("40000", "10000"); err != nil || len(values) != 2 || values[0] != 1 {
		t.Fatalf("rate-transition optimized state = %v, %v", values, err)
	}
	if err := client.Do(ctx, client.B().Arbitrary("SET", key, "corrupt", "PX", "5000").Build()).Error(); err != nil {
		t.Fatal(err)
	}
	if _, err := evaluate("40000", "20000"); err == nil || !strings.Contains(err.Error(), "invalid token bucket state") {
		t.Fatalf("corrupt optimized state error = %v", err)
	}
	state, err := client.Do(ctx, client.B().Arbitrary("GET", key).Build()).ToString()
	if err != nil || state != "corrupt" {
		t.Fatalf("corrupt state was mutated: %q, %v", state, err)
	}
}

func loadRequestCount(t *testing.T) int {
	t.Helper()
	const defaultRequests = 50_000
	raw := os.Getenv("RGS_SHARED_ADMISSION_LOAD_REQUESTS")
	if raw == "" {
		return defaultRequests
	}
	requests, err := strconv.Atoi(raw)
	if err != nil || requests < 10_000 || requests > 5_000_000 {
		t.Fatalf("RGS_SHARED_ADMISSION_LOAD_REQUESTS must be 10000..5000000, got %q", raw)
	}
	return requests
}

func runLoadScenario(
	t *testing.T,
	ctx context.Context,
	client valkey.Client,
	variant string,
	body string,
	scenario loadScenario,
	requests int,
) loadResult {
	t.Helper()
	if err := client.Do(ctx, client.B().Arbitrary("FLUSHDB").Build()).Error(); err != nil {
		t.Fatalf("flush isolated Valkey: %v", err)
	}
	sha, err := client.Do(ctx, client.B().Arbitrary("SCRIPT", "LOAD", body).Build()).ToString()
	if err != nil {
		t.Fatalf("load %s script: %v", variant, err)
	}
	before := readLoadServerStats(t, ctx, client)
	counters := &loadCounters{}
	runner := &loadScriptRunner{
		client: client, transport: newValkeyExecutor(client), body: body, sha: sha, counters: counters,
	}
	if variant == "optimized_v2" {
		// 使用与生产完全相同的执行器，覆盖感知截止时间的 NOSCRIPT 重载合并，
		// 而不是只在基准测试中使用近似实现。
		runner.production = newValkeyExecutor(client)
	}
	args := []string{strconv.FormatInt(scenario.capacityMilli, 10), strconv.FormatInt(scenario.rateMilli, 10)}
	latencies := make([]time.Duration, 0, requests)
	started := time.Now()
	if scenario.secondWorkers > 0 {
		firstRequests := requests / 4
		latencies = append(latencies, runLoadPhase(ctx, runner, variant, scenario, args, 0, firstRequests, scenario.firstWorkers)...)
		latencies = append(latencies, runLoadPhase(ctx, runner, variant, scenario, args, firstRequests, requests-firstRequests, scenario.secondWorkers)...)
	} else if scenario.flushAtMidpoint {
		firstRequests := requests / 2
		latencies = append(latencies, runLoadPhase(ctx, runner, variant, scenario, args, 0, firstRequests, scenario.firstWorkers)...)
		if err := client.Do(ctx, client.B().Arbitrary("SCRIPT", "FLUSH", "SYNC").Build()).Error(); err != nil {
			t.Fatalf("flush script cache: %v", err)
		}
		latencies = append(latencies, runLoadPhase(ctx, runner, variant, scenario, args, firstRequests, requests-firstRequests, scenario.firstWorkers)...)
	} else {
		latencies = runLoadPhase(ctx, runner, variant, scenario, args, 0, requests, scenario.firstWorkers)
	}
	elapsed := time.Since(started)
	after := readLoadServerStats(t, ctx, client)
	keyCount, err := client.Do(ctx, client.B().Arbitrary("DBSIZE").Build()).AsInt64()
	if err != nil {
		t.Fatalf("read load key count: %v", err)
	}
	sort.Slice(latencies, func(left, right int) bool { return latencies[left] < latencies[right] })
	writes := deltaCommands(before, after, "set", "hset", "pexpire")
	scriptBodyEvaluations := deltaCommands(before, after, "eval")
	replicationBytes := after.masterReplicationOffset - before.masterReplicationOffset
	noscriptFallbacks := counters.noscriptFallbacks.Load()
	if runner.production != nil {
		noscriptFallbacks = runner.production.noScriptMisses.Load()
	}
	serverErrorReplies := after.totalErrorReplies - before.totalErrorReplies
	return loadResult{
		Variant:                 variant,
		Scenario:                scenario.name,
		Requests:                requests,
		Workers:                 loadWorkerLabel(scenario),
		Keys:                    keyCount,
		Allowed:                 counters.allowed.Load(),
		Limited:                 counters.limited.Load(),
		Errors:                  counters.errors.Load(),
		NOScriptFallbacks:       noscriptFallbacks,
		ScriptBodyEvaluations:   scriptBodyEvaluations,
		ScriptBodyBytes:         scriptBodyEvaluations * int64(len(body)),
		OperationsPerSecond:     float64(requests) / elapsed.Seconds(),
		P95Microseconds:         latencyPercentile(latencies, 0.95).Microseconds(),
		P99Microseconds:         latencyPercentile(latencies, 0.99).Microseconds(),
		StateWriteCommands:      writes,
		StateWritesPerOperation: float64(writes) / float64(requests),
		ReplicationBytes:        replicationBytes,
		ReplicationBytesPerOp:   float64(replicationBytes) / float64(requests),
		ConnectedClients:        after.connectedClients,
		ConnectedReplicas:       after.connectedReplicas,
		NewConnections:          after.totalConnections - before.totalConnections,
		ServerErrorReplies:      serverErrorReplies,
		UnexpectedServerErrors:  serverErrorReplies - int64(noscriptFallbacks),
		RejectedConnections:     after.rejectedConnections - before.rejectedConnections,
	}
}

func runLoadPhase(
	ctx context.Context,
	runner *loadScriptRunner,
	variant string,
	scenario loadScenario,
	args []string,
	offset int,
	requests int,
	workers int,
) []time.Duration {
	latencies := make([]time.Duration, requests)
	var next atomic.Int64
	start := make(chan struct{})
	var group sync.WaitGroup
	for range workers {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			for {
				localIndex := int(next.Add(1) - 1)
				if localIndex >= requests {
					return
				}
				requestIndex := offset + localIndex
				keyIndex := requestIndex % scenario.keys
				key := fmt.Sprintf("load:%s:%s:{%d}", variant, scenario.name, keyIndex)
				started := time.Now()
				runner.evaluate(ctx, key, args)
				latencies[localIndex] = time.Since(started)
			}
		}()
	}
	close(start)
	group.Wait()
	return latencies
}

func loadWorkerLabel(scenario loadScenario) string {
	if scenario.secondWorkers == 0 {
		return strconv.Itoa(scenario.firstWorkers)
	}
	return fmt.Sprintf("%d->%d", scenario.firstWorkers, scenario.secondWorkers)
}

func latencyPercentile(sorted []time.Duration, percentile float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	index := int(float64(len(sorted)-1) * percentile)
	return sorted[index]
}

type loadServerStats struct {
	commands                map[string]int64
	masterReplicationOffset int64
	connectedClients        int64
	connectedReplicas       int64
	totalConnections        int64
	totalErrorReplies       int64
	rejectedConnections     int64
}

func readLoadServerStats(t *testing.T, ctx context.Context, client valkey.Client) loadServerStats {
	t.Helper()
	sections := make(map[string]string, 4)
	for _, section := range []string{"commandstats", "replication", "clients", "stats"} {
		value, err := client.Do(ctx, client.B().Arbitrary("INFO", section).Build()).ToString()
		if err != nil {
			t.Fatalf("read Valkey INFO %s: %v", section, err)
		}
		sections[section] = value
	}
	return loadServerStats{
		commands:                parseCommandCalls(sections["commandstats"]),
		masterReplicationOffset: parseInfoInteger(sections["replication"], "master_repl_offset"),
		connectedClients:        parseInfoInteger(sections["clients"], "connected_clients"),
		connectedReplicas:       parseInfoInteger(sections["replication"], "connected_slaves"),
		totalConnections:        parseInfoInteger(sections["stats"], "total_connections_received"),
		totalErrorReplies:       parseInfoInteger(sections["stats"], "total_error_replies"),
		rejectedConnections:     parseInfoInteger(sections["stats"], "rejected_connections"),
	}
}

func parseCommandCalls(info string) map[string]int64 {
	calls := make(map[string]int64)
	for _, line := range strings.Split(info, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "cmdstat_") {
			continue
		}
		nameAndStats := strings.SplitN(strings.TrimPrefix(line, "cmdstat_"), ":", 2)
		if len(nameAndStats) != 2 {
			continue
		}
		for _, field := range strings.Split(nameAndStats[1], ",") {
			if !strings.HasPrefix(field, "calls=") {
				continue
			}
			calls[nameAndStats[0]], _ = strconv.ParseInt(strings.TrimPrefix(field, "calls="), 10, 64)
		}
	}
	return calls
}

func parseInfoInteger(info string, key string) int64 {
	for _, line := range strings.Split(info, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, key+":") {
			continue
		}
		value, _ := strconv.ParseInt(strings.TrimPrefix(line, key+":"), 10, 64)
		return value
	}
	return 0
}

func parseInfoString(info string, key string) string {
	for _, line := range strings.Split(info, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, key+":") {
			return strings.TrimPrefix(line, key+":")
		}
	}
	return "unknown"
}

func deltaCommands(before, after loadServerStats, names ...string) int64 {
	var total int64
	for _, name := range names {
		total += after.commands[name] - before.commands[name]
	}
	return total
}
