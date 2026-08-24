package sharedadmission

import (
	"context"
	"crypto/fips140"
	"encoding/json"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	valkey "github.com/valkey-io/valkey-go"
)

type economicLoadReport struct {
	Schema                string  `json:"schema"`
	Requests              int     `json:"requests"`
	Concurrency           int     `json:"concurrency"`
	Allowed               int64   `json:"allowed"`
	Limited               int64   `json:"limited"`
	Errors                int64   `json:"errors"`
	OperationsPerSecond   float64 `json:"operationsPerSecond"`
	Keys                  int64   `json:"keys"`
	ConnectedClients      int64   `json:"connectedClients"`
	NOScriptMisses        uint64  `json:"noscriptMisses"`
	GoVersion             string  `json:"goVersion"`
	AtomicStateEquivalent bool    `json:"atomicStateEquivalent"`
}

// TestEconomicAdmissionValkeyLoadProfile 必须指向调用方显式证明为一次性、空、独占的
// loopback Valkey。它验证真实 Lua 线性化、同 slot 双桶、NOSCRIPT 恢复和 10k 请求/
// 1,024 并发
// 下的硬外呼上界；不证明 TLS、ElastiCache、Multi-AZ 或生产 SLO。
func TestEconomicAdmissionValkeyLoadProfile(t *testing.T) {
	address := os.Getenv("RGS_ECONOMIC_ADMISSION_LOAD_ADDR")
	if address == "" {
		t.Skip("set RGS_ECONOMIC_ADMISSION_LOAD_ADDR to an isolated Valkey host:port")
	}
	if fips140.Enforced() {
		t.Skip("Valkey SCRIPT SHA-1 addresses are unavailable in FIPS-only test mode")
	}
	clientOptions := boundedValkeyClientOptions(500 * time.Millisecond)
	clientOptions.InitAddress = []string{address}
	clientOptions.ClientName = "rgs-economic-admission-load"
	client, err := valkey.NewClient(clientOptions)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	serverInfo, err := client.Do(ctx, client.B().Arbitrary("INFO", "server").Build()).ToString()
	if err != nil {
		t.Fatal(err)
	}
	requireDisposableLoadTarget(t, ctx, client, address, serverInfo)
	if err := client.Do(ctx, client.B().Arbitrary("SCRIPT", "FLUSH").Build()).Error(); err != nil {
		t.Fatal(err)
	}

	executor := newValkeyExecutor(client)
	admission, err := newEconomicAdmission(
		executor,
		[]byte("01234567890123456789012345678901"),
		500*time.Millisecond,
		[]EconomicRoute{{OperatorID: "load-operator", BackendID: "https://load-wallet.invalid"}},
		EconomicConfig{
			Operator: EconomicPolicy{RatePerSecond: 0.002, Burst: 100},
			Backend:  EconomicPolicy{RatePerSecond: 0.002, Burst: 100},
		},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	const requests = 10_000
	const concurrency = 1_024
	var allowed atomic.Int64
	var limited atomic.Int64
	var failures atomic.Int64
	var next atomic.Int64
	started := time.Now()
	start := make(chan struct{})
	var group sync.WaitGroup
	for range concurrency {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			for {
				if index := next.Add(1); index > requests {
					return
				}
				result := admission.admitCost(context.Background(), "load-operator", 1)
				switch result.decision {
				case economicAllowed:
					allowed.Add(1)
				case economicRateLimited:
					limited.Add(1)
				default:
					failures.Add(1)
				}
			}
		}()
	}
	close(start)
	group.Wait()
	elapsed := time.Since(started)

	route := admission.routes["load-operator"]
	if !strings.HasPrefix(route.operator, "rgs:shared-admission:v2:") ||
		!strings.HasPrefix(route.backend, "rgs:shared-admission:v2:") {
		t.Fatalf("economic load keys escape the production ACL namespace: %+v", route)
	}
	states, err := client.Do(ctx, client.B().Mget().Key(route.operator, route.backend).Build()).ToArray()
	if err != nil || len(states) != 2 {
		t.Fatalf("read economic states: len=%d err=%v", len(states), err)
	}
	operatorState, operatorErr := states[0].AsBytes()
	backendState, backendErr := states[1].AsBytes()
	statesEqual := operatorErr == nil && backendErr == nil && string(operatorState) == string(backendState)
	databaseSize, err := client.Do(ctx, client.B().Arbitrary("DBSIZE").Build()).AsInt64()
	if err != nil {
		t.Fatal(err)
	}
	clientsInfo, err := client.Do(ctx, client.B().Arbitrary("INFO", "clients").Build()).ToString()
	if err != nil {
		t.Fatal(err)
	}
	report := economicLoadReport{
		Schema:      "slots-game/economic-admission-load/v1",
		Requests:    requests,
		Concurrency: concurrency,
		Allowed:     allowed.Load(), Limited: limited.Load(), Errors: failures.Load(),
		OperationsPerSecond:   float64(requests) / elapsed.Seconds(),
		Keys:                  databaseSize,
		ConnectedClients:      parseInfoInteger(clientsInfo, "connected_clients"),
		NOScriptMisses:        executor.economicNoScriptMisses.Load(),
		GoVersion:             runtime.Version(),
		AtomicStateEquivalent: statesEqual,
	}
	encoded, _ := json.Marshal(report)
	t.Log(string(encoded))
	if report.Allowed != 100 || report.Limited != requests-100 || report.Errors != 0 ||
		report.Keys != 2 || report.ConnectedClients != maximumValkeyConnectionsPerPod ||
		report.NOScriptMisses == 0 ||
		!report.AtomicStateEquivalent {
		t.Fatalf("economic admission load gate failed: %+v", report)
	}
	verifyEconomicNoEvictionOOM(t, ctx, client)
}

// verifyEconomicNoEvictionOOM 闭合 Lua 的细微错误边界：脚本通常不会回滚事务，
// 因此生产脚本用一条 MSET 写两个状态。noeviction OOM 不得改变任一状态，准入必须失败关闭。
func verifyEconomicNoEvictionOOM(t *testing.T, ctx context.Context, client valkey.Client) {
	t.Helper()
	defer func() {
		_ = client.Do(context.Background(), client.B().Arbitrary("CONFIG", "SET", "maxmemory", "0").Build()).Error()
		_ = client.Do(context.Background(), client.B().Arbitrary("FLUSHALL").Build()).Error()
	}()
	for _, command := range [][]string{
		{"CONFIG", "SET", "maxmemory", "0"},
		{"CONFIG", "SET", "maxmemory-policy", "noeviction"},
		{"FLUSHALL"},
		{"SCRIPT", "FLUSH"},
		{"SCRIPT", "LOAD", economicTokenBucketScriptBody},
	} {
		if err := client.Do(ctx, client.B().Arbitrary(command...).Build()).Error(); err != nil {
			t.Fatalf("prepare noeviction OOM proof %v: %v", command[:2], err)
		}
	}
	executor := newValkeyExecutor(client)
	admission, err := newEconomicAdmission(
		executor,
		[]byte("01234567890123456789012345678901"),
		500*time.Millisecond,
		[]EconomicRoute{{OperatorID: "oom-operator", BackendID: "https://oom-wallet.invalid"}},
		EconomicConfig{
			Operator: EconomicPolicy{RatePerSecond: 1, Burst: 10},
			Backend:  EconomicPolicy{RatePerSecond: 1, Burst: 10},
		},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if result := admission.admitCost(context.Background(), "oom-operator", 1); result.decision != economicAllowed {
		t.Fatalf("OOM baseline admission failed: %+v", result)
	}
	route := admission.routes["oom-operator"]
	before, err := client.Do(ctx, client.B().Mget().Key(route.operator, route.backend).Build()).ToArray()
	if err != nil || len(before) != 2 {
		t.Fatalf("read states before OOM: len=%d err=%v", len(before), err)
	}
	beforeOperator, operatorErr := before[0].AsBytes()
	beforeBackend, backendErr := before[1].AsBytes()
	if operatorErr != nil || backendErr != nil {
		t.Fatalf("baseline admission left a partial state: operator=%v backend=%v", operatorErr, backendErr)
	}
	memoryInfo, err := client.Do(ctx, client.B().Arbitrary("INFO", "memory").Build()).ToString()
	if err != nil {
		t.Fatal(err)
	}
	used := parseInfoInteger(memoryInfo, "used_memory")
	if used <= 1 {
		t.Fatalf("invalid used_memory before OOM: %d", used)
	}
	if err := client.Do(ctx, client.B().Arbitrary("CONFIG", "SET", "maxmemory", strconv.FormatInt(used-1, 10)).Build()).Error(); err != nil {
		t.Fatal(err)
	}
	if result := admission.admitCost(context.Background(), "oom-operator", 1); result.decision != economicBackendUnavailable {
		t.Fatalf("noeviction OOM did not fail closed: %+v", result)
	}
	after, err := client.Do(ctx, client.B().Mget().Key(route.operator, route.backend).Build()).ToArray()
	if err != nil || len(after) != 2 {
		t.Fatalf("read states after OOM denial: len=%d err=%v", len(after), err)
	}
	afterOperator, operatorErr := after[0].AsBytes()
	afterBackend, backendErr := after[1].AsBytes()
	if operatorErr != nil || backendErr != nil || string(afterOperator) != string(beforeOperator) ||
		string(afterBackend) != string(beforeBackend) {
		t.Fatalf("OOM denial partially changed economic state: operator=%v backend=%v", operatorErr, backendErr)
	}
}
