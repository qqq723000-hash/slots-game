package sharedadmission

import (
	"bytes"
	"context"
	"crypto/fips140"
	"crypto/sha1"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"slots-game/server/internal/platform"
)

func TestEconomicTokenBucketScriptDigestIsCurrent(t *testing.T) {
	if fips140.Enforced() {
		t.Skip("FIPS 140-only 模式禁止测试进程计算 SHA-1")
	}
	digest := sha1.Sum([]byte(economicTokenBucketScriptBody))
	if got := fmt.Sprintf("%x", digest); got != economicTokenBucketScriptSHA1 {
		t.Fatalf("economic token bucket script digest is stale: got %s", got)
	}
}

func TestEconomicTokenBucketScriptIsAtomicAndDeniedRequestsDoNotWrite(t *testing.T) {
	for _, required := range []string{
		"load_bucket(KEYS[1]",
		"load_bucket(KEYS[2]",
		"redis.call('TIME')",
		"return {0, limited, math.max(1, retry_ms)}",
		"cmsgpack.pack({operator_tokens - cost, now_ms})",
		"cmsgpack.pack({backend_tokens - cost, now_ms})",
		"redis.call('MSET', KEYS[1], operator_state, KEYS[2], backend_state)",
	} {
		if !strings.Contains(economicTokenBucketScriptBody, required) {
			t.Fatalf("economic script is missing %q", required)
		}
	}
	if strings.Count(economicTokenBucketScriptBody, "redis.call('MSET'") != 1 ||
		strings.Count(economicTokenBucketScriptBody, "redis.call('PEXPIRE'") != 2 ||
		strings.Contains(economicTokenBucketScriptBody, "redis.call('SET'") ||
		strings.Contains(economicTokenBucketScriptBody, "redis.call('HSET'") ||
		strings.Contains(economicTokenBucketScriptBody, "redis.call('PTTL'") {
		t.Fatal("economic script must use one all-or-nothing MSET and two garbage-collection expiries")
	}
	denied := strings.Index(economicTokenBucketScriptBody, "if limited ~= 0 then")
	firstWrite := strings.Index(economicTokenBucketScriptBody, "redis.call('MSET'")
	if denied < 0 || firstWrite < 0 || denied > firstWrite {
		t.Fatal("economic script can write before both buckets have been admitted")
	}
}

func TestEconomicAdmissionStartupCanaryExercisesAtomicWriteACLWithoutBusinessIdentity(t *testing.T) {
	fake := &fakeEconomicExecutor{result: []int64{1, 0, 0}}
	admission := testEconomicAdmission(t, fake, []EconomicRoute{{
		OperatorID: "operator-a", BackendID: "https://wallet.example",
	}}, nil)
	if err := admission.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.calls != 1 || len(fake.keys) != 1 || len(fake.keys[0]) != 2 ||
		economicHashTag(fake.keys[0][0]) != economicHashTag(fake.keys[0][1]) ||
		fake.args[0][0] != "1000" || fake.args[0][1] != "1000000" ||
		fake.args[0][2] != "1000" || fake.args[0][3] != "1000000" || fake.args[0][4] != "1000" {
		t.Fatalf("startup canary call = keys:%#v args:%#v", fake.keys, fake.args)
	}
	for _, key := range fake.keys[0] {
		if !strings.HasPrefix(key, "rgs:shared-admission:v2:{rgs-economic:startup-canary:") ||
			strings.Contains(key, "operator-a") || strings.Contains(key, "wallet.example") {
			t.Fatalf("unsafe startup canary key %q", key)
		}
	}
}

func TestEconomicAdmissionHealthTracksCanaryAndRuntimeOutcomes(t *testing.T) {
	metrics := &platform.Metrics{}
	fake := &fakeEconomicExecutor{result: []int64{1, 0, 0}}
	admission := testEconomicAdmission(t, fake, []EconomicRoute{{
		OperatorID: "operator-a", BackendID: "https://wallet.example",
	}}, metrics)
	now := time.Unix(1_700_000_000, 0)
	admission.now = func() time.Time { return now }
	metrics.ObserveSharedAdmissionHealth(true, now)

	assertEconomicAdmissionHealth(t, metrics, 0, 0)
	now = now.Add(time.Second)
	if err := admission.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertEconomicAdmissionHealth(t, metrics, 1, now.Add(-time.Second).Unix())

	fake.err = errors.New("canary failed")
	now = now.Add(time.Second)
	if err := admission.Check(context.Background()); err == nil {
		t.Fatal("failed atomic canary was accepted")
	}
	assertEconomicAdmissionHealth(t, metrics, 0, now.Add(-2*time.Second).Unix())

	fake.err = nil
	fake.result = []int64{1, 0, 0}
	now = now.Add(time.Second)
	if err := admission.AdmitNewEconomicIntent(context.Background(), "operator-a", 1); err != nil {
		t.Fatal(err)
	}
	assertEconomicAdmissionHealth(t, metrics, 1, now.Add(-3*time.Second).Unix())

	fake.err = errors.New("runtime backend failed")
	now = now.Add(time.Second)
	if err := admission.AdmitNewEconomicIntent(context.Background(), "operator-a", 1); err == nil {
		t.Fatal("failed runtime economic admission was accepted")
	}
	assertEconomicAdmissionHealth(t, metrics, 0, now.Add(-4*time.Second).Unix())

	fake.err = nil
	fake.result = []int64{0, 1, 250}
	now = now.Add(2 * time.Second)
	if err := admission.AdmitNewEconomicIntent(context.Background(), "operator-a", 1); err == nil {
		t.Fatal("economic budget rejection was not returned")
	}
	// 合法的限流响应即使拒绝本次意图，仍能证明 Lua 路径当前可用。
	assertEconomicAdmissionHealth(t, metrics, 1, now.Add(-6*time.Second).Unix())

	fake.wait = true
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	now = now.Add(time.Second)
	if err := admission.AdmitNewEconomicIntent(ctx, "operator-a", 1); err == nil {
		t.Fatal("cancelled economic admission was accepted")
	}
	assertEconomicAdmissionHealth(t, metrics, 1, now.Add(-7*time.Second).Unix())
}

type fakeEconomicExecutor struct {
	mu     sync.Mutex
	result []int64
	err    error
	wait   bool
	calls  int
	keys   [][]string
	args   [][]string
}

func (fake *fakeEconomicExecutor) EvaluateEconomic(
	ctx context.Context,
	keys []string,
	args []string,
) ([]int64, error) {
	fake.mu.Lock()
	fake.calls++
	fake.keys = append(fake.keys, append([]string(nil), keys...))
	fake.args = append(fake.args, append([]string(nil), args...))
	wait, result, err := fake.wait, append([]int64(nil), fake.result...), fake.err
	fake.mu.Unlock()
	if wait {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return result, err
}

func testEconomicAdmission(
	t *testing.T,
	executor economicScriptExecutor,
	routes []EconomicRoute,
	metrics *platform.Metrics,
) *EconomicAdmission {
	t.Helper()
	admission, err := newEconomicAdmission(
		executor,
		[]byte("01234567890123456789012345678901"),
		50*time.Millisecond,
		routes,
		EconomicConfig{
			Operator: EconomicPolicy{RatePerSecond: 20, Burst: 40},
			Backend:  EconomicPolicy{RatePerSecond: 100, Burst: 200},
		},
		metrics,
	)
	if err != nil {
		t.Fatal(err)
	}
	return admission
}

func TestEconomicAdmissionPrecomputesBoundedHMACRoutesAndSharesBackendBucket(t *testing.T) {
	if economicKeyPrefix != "rgs:shared-admission:v2:" {
		t.Fatalf("economic key prefix %q escapes the production Valkey ACL namespace", economicKeyPrefix)
	}
	fake := &fakeEconomicExecutor{result: []int64{1, 0, 0}}
	admission := testEconomicAdmission(t, fake, []EconomicRoute{
		{OperatorID: "operator-a", BackendID: "https://wallet.example"},
		{OperatorID: "operator-b", BackendID: "https://wallet.example"},
		{OperatorID: "operator-c", BackendID: "https://other-wallet.example"},
	}, nil)
	for _, operatorID := range []string{"operator-a", "operator-b", "operator-c"} {
		if result := admission.admitCost(context.Background(), operatorID, 1); result.decision != economicAllowed {
			t.Fatalf("%s admission = %+v", operatorID, result)
		}
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.calls != 3 || len(fake.keys) != 3 {
		t.Fatalf("economic calls = %d keys=%d", fake.calls, len(fake.keys))
	}
	if fake.keys[0][0] == fake.keys[1][0] || fake.keys[0][1] != fake.keys[1][1] ||
		fake.keys[0][1] == fake.keys[2][1] {
		t.Fatalf("operator/backend isolation keys = %#v", fake.keys)
	}
	for _, callKeys := range fake.keys {
		if economicHashTag(callKeys[0]) == "" || economicHashTag(callKeys[0]) != economicHashTag(callKeys[1]) {
			t.Fatalf("operator/backend keys do not share one backend slot: %#v", callKeys)
		}
		for _, key := range callKeys {
			if !strings.HasPrefix(key, economicKeyPrefix) || strings.Count(key, "{rgs-economic:") != 1 ||
				strings.Contains(key, "operator-") || strings.Contains(key, "wallet.example") {
				t.Fatalf("unsafe economic key = %q", key)
			}
		}
	}
	if economicHashTag(fake.keys[0][0]) != economicHashTag(fake.keys[1][0]) ||
		economicHashTag(fake.keys[0][0]) == economicHashTag(fake.keys[2][0]) {
		t.Fatalf("backend hash-tag partitioning = %#v", fake.keys)
	}
}

func economicHashTag(key string) string {
	start := strings.IndexByte(key, '{')
	end := strings.IndexByte(key, '}')
	if start < 0 || end <= start+1 {
		return ""
	}
	return key[start+1 : end]
}

func TestEconomicAdmissionClassifiesBothBudgetsWithLowCardinalityMetrics(t *testing.T) {
	metrics := &platform.Metrics{}
	fake := &fakeEconomicExecutor{result: []int64{1, 0, 0}}
	admission := testEconomicAdmission(t, fake, []EconomicRoute{{
		OperatorID: "operator-a", BackendID: "https://wallet.example",
	}}, metrics)
	if result := admission.admitCost(context.Background(), "operator-a", 1); result.decision != economicAllowed {
		t.Fatalf("allowed result = %+v", result)
	}
	fake.result = []int64{0, 3, 1250}
	result := admission.admitCost(context.Background(), "operator-a", 1)
	if result.decision != economicRateLimited || result.retryAfter != 1250*time.Millisecond {
		t.Fatalf("limited result = %+v", result)
	}
	if metrics.EconomicAdmissionAllowed.Load() != 1 ||
		metrics.EconomicAdmissionLimited.Load() != 1 ||
		metrics.EconomicAdmissionOperatorLimited.Load() != 1 ||
		metrics.EconomicAdmissionBackendLimited.Load() != 1 ||
		metrics.EconomicAdmissionErrors.Load() != 0 {
		t.Fatalf("economic metrics = %+v", metrics)
	}
	var exposition bytes.Buffer
	if err := metrics.WritePrometheus(&exposition); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		"rgs_economic_admission_allowed_total 1",
		"rgs_economic_admission_limited_total 1",
		"rgs_economic_admission_operator_limited_total 1",
		"rgs_economic_admission_backend_limited_total 1",
		"rgs_economic_admission_errors_total 0",
	} {
		if !strings.Contains(exposition.String(), expected) {
			t.Fatalf("metrics missing %q:\n%s", expected, exposition.String())
		}
	}
	for _, forbidden := range []string{"operator-a", "wallet.example"} {
		if strings.Contains(exposition.String(), forbidden) {
			t.Fatalf("metrics leaked %q", forbidden)
		}
	}
}

func TestEconomicAdmissionFailsClosedOnUnknownRouteTimeoutAndMalformedReply(t *testing.T) {
	metrics := &platform.Metrics{}
	fake := &fakeEconomicExecutor{result: []int64{1, 0, 0}}
	admission := testEconomicAdmission(t, fake, []EconomicRoute{{
		OperatorID: "operator-a", BackendID: "https://wallet.example",
	}}, metrics)
	if result := admission.admitCost(context.Background(), "unknown", 1); result.decision != economicBackendUnavailable {
		t.Fatalf("unknown route = %+v", result)
	}
	if fake.calls != 0 {
		t.Fatal("unknown route reached Valkey")
	}
	fake.wait = true
	if result := admission.admitCost(context.Background(), "operator-a", 1); result.decision != economicBackendUnavailable {
		t.Fatalf("timeout result = %+v", result)
	}
	fake.wait = false
	fake.result = []int64{1, 1, 0}
	// 上一次后端超时会打开一秒熔断；推进注入时钟，让本次调用真正到达并验证畸形协议响应。
	admission.now = func() time.Time { return time.Now().Add(2 * time.Second) }
	if result := admission.admitCost(context.Background(), "operator-a", 1); result.decision != economicBackendUnavailable {
		t.Fatalf("malformed result = %+v", result)
	}
	if metrics.EconomicAdmissionErrors.Load() != 3 {
		t.Fatalf("economic errors = %d, want 3", metrics.EconomicAdmissionErrors.Load())
	}
}

func TestEconomicAdmissionCostUnitsAreExplicitAndBounded(t *testing.T) {
	fake := &fakeEconomicExecutor{result: []int64{1, 0, 0}}
	admission := testEconomicAdmission(t, fake, []EconomicRoute{{
		OperatorID: "operator-a", BackendID: "https://wallet.example",
	}}, nil)
	if result := admission.admitCost(context.Background(), "operator-a", 7); result.decision != economicAllowed {
		t.Fatalf("weighted admission = %+v", result)
	}
	fake.mu.Lock()
	if got := fake.args[0][4]; got != "7000" {
		fake.mu.Unlock()
		t.Fatalf("cost argument = %s", got)
	}
	fake.mu.Unlock()
	for _, cost := range []int{0, -1, 1_000_001} {
		if result := admission.admitCost(context.Background(), "operator-a", cost); result.decision != economicBackendUnavailable {
			t.Fatalf("cost %d = %+v", cost, result)
		}
	}
}

type linearEconomicExecutor struct {
	mu        sync.Mutex
	remaining int64
	allowed   int64
	keys      map[string]struct{}
}

func (executor *linearEconomicExecutor) EvaluateEconomic(
	_ context.Context,
	keys []string,
	_ []string,
) ([]int64, error) {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	if executor.keys == nil {
		executor.keys = make(map[string]struct{})
	}
	for _, key := range keys {
		executor.keys[key] = struct{}{}
	}
	if executor.remaining == 0 {
		return []int64{0, 3, 1000}, nil
	}
	executor.remaining--
	executor.allowed++
	return []int64{1, 0, 0}, nil
}

func TestEconomicAdmissionHighConcurrencyKeepsOneOperatorAndBackendIdentity(t *testing.T) {
	const requests = 10_000
	executor := &linearEconomicExecutor{remaining: 100}
	admission := testEconomicAdmission(t, executor, []EconomicRoute{{
		OperatorID: "operator-a", BackendID: "https://wallet.example",
	}}, nil)
	var allowed atomic.Int64
	var limited atomic.Int64
	var group sync.WaitGroup
	for index := 0; index < requests; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			result := admission.admitCost(context.Background(), "operator-a", 1)
			switch result.decision {
			case economicAllowed:
				allowed.Add(1)
			case economicRateLimited:
				limited.Add(1)
			default:
				t.Errorf("unexpected decision %d", result.decision)
			}
		}()
	}
	group.Wait()
	if allowed.Load() != 100 || limited.Load() != requests-100 {
		t.Fatalf("allowed/limited = %d/%d", allowed.Load(), limited.Load())
	}
	executor.mu.Lock()
	defer executor.mu.Unlock()
	if executor.allowed != 100 || len(executor.keys) != 2 {
		t.Fatalf("linearized allowed/keys = %d/%d", executor.allowed, len(executor.keys))
	}
}

func TestEconomicScriptReloadCoalescesConcurrentNOSCRIPT(t *testing.T) {
	const workers = 64
	executor := &valkeyExecutor{economicReload: make(chan struct{}, 1)}
	var initialCalls atomic.Int64
	var bodyCalls atomic.Int64
	var loaded atomic.Bool
	allInitialCalls := make(chan struct{})
	var group sync.WaitGroup
	for range workers {
		group.Add(1)
		go func() {
			defer group.Done()
			first := true
			values, err := executor.evaluateEconomicCached(context.Background(), func() scriptCallResult {
				if first {
					first = false
					if initialCalls.Add(1) == workers {
						close(allInitialCalls)
					}
					<-allInitialCalls
					return scriptCallResult{err: errors.New("NOSCRIPT"), noScript: true}
				}
				if !loaded.Load() {
					return scriptCallResult{err: errors.New("not loaded"), noScript: true}
				}
				return scriptCallResult{values: []int64{1, 0, 0}}
			}, func() scriptCallResult {
				bodyCalls.Add(1)
				loaded.Store(true)
				return scriptCallResult{values: []int64{1, 0, 0}}
			})
			if err != nil || len(values) != 3 || values[0] != 1 {
				t.Errorf("values=%v err=%v", values, err)
			}
		}()
	}
	group.Wait()
	if initialCalls.Load() != workers || bodyCalls.Load() != 1 ||
		executor.economicNoScriptMisses.Load() != workers {
		t.Fatalf("NOSCRIPT initial/body/miss = %d/%d/%d", initialCalls.Load(), bodyCalls.Load(), executor.economicNoScriptMisses.Load())
	}
}

func TestEconomicPolicyRejectsOverflowAndUnboundedTTL(t *testing.T) {
	valid := EconomicPolicy{RatePerSecond: 1, Burst: 86_399}
	if _, err := economicPolicyArguments(valid); err != nil {
		t.Fatalf("24-hour boundary rejected: %v", err)
	}
	for _, policy := range []EconomicPolicy{
		{RatePerSecond: 0, Burst: 1},
		{RatePerSecond: 1.0001, Burst: 1},
		{RatePerSecond: 99_999.9995, Burst: 1},
		{RatePerSecond: 1, Burst: 86_400},
		{RatePerSecond: 100_001, Burst: 1},
		{RatePerSecond: 1, Burst: 1_000_001},
	} {
		if args, err := economicPolicyArguments(policy); err == nil {
			t.Fatalf("unsafe policy accepted: %+v -> %s/%s", policy, args[0], args[1])
		}
	}
	for _, rate := range []float64{0.001, 0.333, 25.5, 99_999.999, 100_000} {
		if _, err := economicPolicyArguments(EconomicPolicy{RatePerSecond: rate, Burst: 1}); err != nil {
			t.Fatalf("exact millitoken rate %v rejected: %v", rate, err)
		}
	}
	if got := strconv.IntSize; got < 32 {
		t.Fatalf("unsupported integer size %d", got)
	}
}
