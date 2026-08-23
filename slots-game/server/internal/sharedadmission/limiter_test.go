package sharedadmission

import (
	"bytes"
	"context"
	"crypto/fips140"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"slots-game/server/internal/platform"
	"slots-game/server/internal/rgsapi"
)

func TestTokenBucketScriptDigestIsCurrent(t *testing.T) {
	if fips140.Enforced() {
		t.Skip("FIPS 140-only 模式禁止测试进程计算 SHA-1")
	}
	digest := sha1.Sum([]byte(tokenBucketScriptBody))
	if fmt.Sprintf("%x", digest) != tokenBucketScriptSHA1 {
		t.Fatal("token bucket script digest is stale")
	}
}

func TestTokenBucketScriptUsesOneAllowedWriteAndZeroDeniedWrites(t *testing.T) {
	for _, required := range []string{
		"redis.call('GET', KEYS[1])",
		"redis.call('PTTL', KEYS[1])",
		"redis.call('SET', KEYS[1]",
		"pcall(cmsgpack.unpack, state)",
		"cmsgpack.pack({tokens, ttl_base}), 'PX', ttl_base",
		"fill_time + 1000 > 86400000",
		"return redis.error_reply('invalid token bucket state')",
	} {
		if !strings.Contains(tokenBucketScriptBody, required) {
			t.Fatalf("token bucket script is missing %q", required)
		}
	}
	if strings.Count(tokenBucketScriptBody, "redis.call('SET'") != 1 ||
		strings.Contains(tokenBucketScriptBody, "redis.call('HSET'") ||
		strings.Contains(tokenBucketScriptBody, "redis.call('PEXPIRE'") {
		t.Fatal("token bucket write contract regressed: allowed must use one SET PX, denied zero writes")
	}
	setIndex := strings.Index(tokenBucketScriptBody, "redis.call('SET'")
	allowedIndex := strings.Index(tokenBucketScriptBody, "if tokens >= 1000 then")
	deniedIndex := strings.Index(tokenBucketScriptBody, "else\n  retry_ms")
	if allowedIndex < 0 || setIndex < allowedIndex || deniedIndex < setIndex {
		t.Fatal("token bucket SET is no longer confined to the allowed branch")
	}
}

type fakeExecutor struct {
	result []int64
	err    error
	key    string
	args   []string
	ping   error
	wait   bool
	calls  int
}

func (fake *fakeExecutor) Evaluate(ctx context.Context, key string, args []string) ([]int64, error) {
	fake.key = key
	fake.calls++
	fake.args = append([]string(nil), args...)
	if fake.wait {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return append([]int64(nil), fake.result...), fake.err
}

func TestLimiterOpensCircuitAfterBackendFailure(t *testing.T) {
	fake := &fakeExecutor{err: errors.New("backend unavailable")}
	limiter, err := newLimiter(fake, Config{Timeout: 50 * time.Millisecond, Rate: 1, Burst: 1}, []byte("01234567890123456789012345678901"), nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(100, 0)
	limiter.now = func() time.Time { return now }
	for range 20 {
		if result := limiter.Admit(context.Background(), "operator:known", time.Time{}); result.Decision != rgsapi.AdmissionBackendUnavailable {
			t.Fatalf("failure result = %+v", result)
		}
	}
	if fake.calls != 1 {
		t.Fatalf("executor calls during open circuit = %d, want 1", fake.calls)
	}
	now = now.Add(time.Second)
	_ = limiter.Admit(context.Background(), "operator:known", time.Time{})
	if fake.calls != 2 {
		t.Fatalf("executor calls after cooldown = %d, want 2", fake.calls)
	}
}

func TestLimiterBoundsBackendWait(t *testing.T) {
	fake := &fakeExecutor{wait: true}
	limiter, err := newLimiter(fake, Config{Timeout: 10 * time.Millisecond, Rate: 1, Burst: 1}, []byte("01234567890123456789012345678901"), nil)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	result := limiter.Admit(context.Background(), "operator:known", time.Time{})
	if result.Decision != rgsapi.AdmissionBackendUnavailable || time.Since(started) > 250*time.Millisecond {
		t.Fatalf("result/elapsed = %+v/%s", result, time.Since(started))
	}
}

func (fake *fakeExecutor) Ping(context.Context) error { return fake.ping }
func (fake *fakeExecutor) Close()                     {}

func TestLimiterHashesIdentityAndSeparatesDecisions(t *testing.T) {
	metrics := &platform.Metrics{}
	fake := &fakeExecutor{result: []int64{1, 0}}
	limiter, err := newLimiter(fake, Config{
		Timeout: 50 * time.Millisecond,
		Rate:    20,
		Burst:   40,
	}, []byte("01234567890123456789012345678901"), metrics)
	if err != nil {
		t.Fatal(err)
	}

	result := limiter.Admit(context.Background(), "client:operator-a:session-secret", time.Time{})
	if result.Decision != rgsapi.AdmissionAllowed || metrics.SharedAdmissionAllowed.Load() != 1 {
		t.Fatalf("result = %+v, allowed metric = %d", result, metrics.SharedAdmissionAllowed.Load())
	}
	if strings.Contains(fake.key, "operator-a") || strings.Contains(fake.key, "session-secret") ||
		!strings.HasPrefix(fake.key, keyPrefix) || !strings.HasSuffix(fake.key, "}") ||
		len(fake.key) != len(keyPrefix)+64+1 {
		t.Fatalf("unsafe shared key = %q", fake.key)
	}
	if len(fake.args) != 2 || fake.args[0] != "40000" || fake.args[1] != "20000" {
		t.Fatalf("script args = %#v", fake.args)
	}

	fake.result = []int64{0, 1250}
	result = limiter.Admit(context.Background(), "client:operator-a:session-secret", time.Time{})
	if result.Decision != rgsapi.AdmissionRateLimited || result.RetryAfter != 1250*time.Millisecond ||
		metrics.SharedAdmissionLimited.Load() != 1 {
		t.Fatalf("result = %+v, limited metric = %d", result, metrics.SharedAdmissionLimited.Load())
	}

	fake.err = errors.New("后端断开")
	result = limiter.Admit(context.Background(), "client:operator-a:session-secret", time.Time{})
	if result.Decision != rgsapi.AdmissionBackendUnavailable || metrics.SharedAdmissionErrors.Load() != 1 {
		t.Fatalf("result = %+v, error metric = %d", result, metrics.SharedAdmissionErrors.Load())
	}
	var exposition bytes.Buffer
	if err := metrics.WritePrometheus(&exposition); err != nil {
		t.Fatal(err)
	}
	for _, metric := range []string{
		"rgs_shared_admission_allowed_total 1",
		"rgs_shared_admission_limited_total 1",
		"rgs_shared_admission_errors_total 1",
	} {
		if !strings.Contains(exposition.String(), metric) {
			t.Fatalf("metrics missing %q:\n%s", metric, exposition.String())
		}
	}
}

func TestLimiterCancellationDoesNotOpenGlobalBackendCircuit(t *testing.T) {
	fake := &fakeExecutor{wait: true}
	limiter, err := newLimiter(fake, Config{Timeout: 50 * time.Millisecond, Rate: 1, Burst: 1},
		[]byte("01234567890123456789012345678901"), nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if result := limiter.Admit(ctx, "client:operator-a:session-a", time.Time{}); result.Decision != rgsapi.AdmissionBackendUnavailable {
		t.Fatalf("cancelled admission = %+v", result)
	}
	fake.wait = false
	fake.result = []int64{1, 0}
	if result := limiter.Admit(context.Background(), "client:operator-b:session-b", time.Time{}); result.Decision != rgsapi.AdmissionAllowed || fake.calls != 2 {
		t.Fatalf("post-cancellation admission = %+v calls=%d", result, fake.calls)
	}
}

func TestValkeyExecutorCoalescesConcurrentNoScriptReload(t *testing.T) {
	const workers = 64
	executor := &valkeyExecutor{scriptReload: make(chan struct{}, 1)}
	var initialCalls atomic.Int64
	var bodyCalls atomic.Int64
	var loaded atomic.Bool
	allInitialCalls := make(chan struct{})
	errorsSeen := make(chan error, workers)
	var group sync.WaitGroup
	for range workers {
		group.Add(1)
		go func() {
			defer group.Done()
			firstCall := true
			values, err := executor.evaluateCached(context.Background(), func() scriptCallResult {
				if firstCall {
					firstCall = false
					if initialCalls.Add(1) == workers {
						close(allInitialCalls)
					}
					<-allInitialCalls
					return scriptCallResult{err: errors.New("NOSCRIPT"), noScript: true}
				}
				if !loaded.Load() {
					return scriptCallResult{err: errors.New("script unexpectedly absent"), noScript: true}
				}
				return scriptCallResult{values: []int64{1, 0}}
			}, func() scriptCallResult {
				bodyCalls.Add(1)
				loaded.Store(true)
				return scriptCallResult{values: []int64{1, 0}}
			})
			if err != nil || len(values) != 2 || values[0] != 1 {
				errorsSeen <- fmt.Errorf("values=%v err=%w", values, err)
			}
		}()
	}
	group.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		t.Error(err)
	}
	if initialCalls.Load() != workers || executor.noScriptMisses.Load() != workers || bodyCalls.Load() != 1 {
		t.Fatalf("NOSCRIPT initial/miss/body calls = %d/%d/%d, want %d/%d/1",
			initialCalls.Load(), executor.noScriptMisses.Load(), bodyCalls.Load(), workers, workers)
	}
}

func TestValkeyExecutorNoScriptReloadWaitHonorsContext(t *testing.T) {
	executor := &valkeyExecutor{scriptReload: make(chan struct{}, 1)}
	executor.scriptReload <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	values, err := executor.evaluateCached(ctx,
		func() scriptCallResult { return scriptCallResult{err: errors.New("NOSCRIPT"), noScript: true} },
		func() scriptCallResult {
			t.Fatal("cancelled waiter executed full script body")
			return scriptCallResult{}
		},
	)
	if !errors.Is(err, context.Canceled) || values != nil {
		t.Fatalf("cancelled NOSCRIPT wait = %v, %v", values, err)
	}
}

type concurrentKeyExecutor struct {
	mu   sync.Mutex
	keys map[string]int
}

func (executor *concurrentKeyExecutor) Evaluate(
	_ context.Context,
	key string,
	_ []string,
) ([]int64, error) {
	executor.mu.Lock()
	executor.keys[key]++
	executor.mu.Unlock()
	return []int64{1, 0}, nil
}

func (*concurrentKeyExecutor) Ping(context.Context) error { return nil }
func (*concurrentKeyExecutor) Close()                     {}

func TestLimiterSeparatesOperatorAndSessionBucketsUnderConcurrency(t *testing.T) {
	executor := &concurrentKeyExecutor{keys: make(map[string]int)}
	limiter, err := newLimiter(executor, Config{Timeout: 100 * time.Millisecond, Rate: 1000, Burst: 1000},
		[]byte("01234567890123456789012345678901"), nil)
	if err != nil {
		t.Fatal(err)
	}
	const sessions = 128
	var group sync.WaitGroup
	for index := range sessions {
		group.Add(1)
		go func() {
			defer group.Done()
			identity := fmt.Sprintf("client:operator-a:session-%d", index)
			if result := limiter.Admit(context.Background(), identity, time.Time{}); result.Decision != rgsapi.AdmissionAllowed {
				t.Errorf("session admission = %+v", result)
			}
		}()
	}
	group.Add(1)
	go func() {
		defer group.Done()
		_ = limiter.Admit(context.Background(), "operator:operator-a", time.Time{})
	}()
	group.Wait()
	executor.mu.Lock()
	defer executor.mu.Unlock()
	if len(executor.keys) != sessions+1 {
		t.Fatalf("independent shared admission keys = %d, want %d", len(executor.keys), sessions+1)
	}
	for key, calls := range executor.keys {
		if calls != 1 || !strings.HasPrefix(key, keyPrefix) || !strings.HasSuffix(key, "}") {
			t.Fatalf("invalid cluster-safe key %q calls=%d", key, calls)
		}
	}
}

func TestLimiterRejectsUnboundedKeyTTLConfiguration(t *testing.T) {
	if _, err := newLimiter(&fakeExecutor{}, Config{
		Timeout: 50 * time.Millisecond, Rate: 1, Burst: 86_399,
	}, []byte("01234567890123456789012345678901"), nil); err != nil {
		t.Fatalf("exact 24-hour bucket TTL rejected: %v", err)
	}
	_, err := newLimiter(&fakeExecutor{}, Config{
		Timeout: 50 * time.Millisecond, Rate: 1, Burst: 86_400,
	}, []byte("01234567890123456789012345678901"), nil)
	if err == nil || !strings.Contains(err.Error(), "TTL") {
		t.Fatalf("over-24-hour TTL configuration error = %v", err)
	}
	_, err = newLimiter(&fakeExecutor{}, Config{
		Timeout: 50 * time.Millisecond, Rate: 0.001, Burst: 1_000_000,
	}, []byte("01234567890123456789012345678901"), nil)
	if err == nil || !strings.Contains(err.Error(), "TTL") {
		t.Fatalf("unbounded TTL configuration error = %v", err)
	}
}

func TestLimiterUsesIndependentSharedRateArguments(t *testing.T) {
	fake := &fakeExecutor{result: []int64{1, 0}}
	limiter, err := newLimiter(fake, Config{Timeout: 50 * time.Millisecond, Rate: 500, Burst: 1000}, []byte("01234567890123456789012345678901"), nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = limiter.Admit(context.Background(), "client:operator-a:session-a", time.Time{})
	if len(fake.args) != 2 || fake.args[0] != "1000000" || fake.args[1] != "500000" {
		t.Fatalf("independent shared script args = %#v", fake.args)
	}
}

func TestSharedAdmissionSourcePinsSinglePipelineConnection(t *testing.T) {
	if singlePipelineConnectionMultiplex != -1 {
		t.Fatal("shared admission client no longer pins one pipeline connection per discovered node")
	}
	if !forceSingleValkeyClient {
		t.Fatal("shared admission client must not probe cluster commands on a non-cluster endpoint")
	}
}

func TestLimiterRejectsMalformedBackendReplyAndReadinessFailure(t *testing.T) {
	fake := &fakeExecutor{result: []int64{9}, ping: errors.New("ping failed")}
	metrics := &platform.Metrics{}
	limiter, err := newLimiter(fake, Config{Timeout: 50 * time.Millisecond, Rate: 1, Burst: 1}, []byte("01234567890123456789012345678901"), metrics)
	if err != nil {
		t.Fatal(err)
	}
	if result := limiter.Admit(context.Background(), "operator:known", time.Time{}); result.Decision != rgsapi.AdmissionBackendUnavailable {
		t.Fatalf("malformed result = %+v", result)
	}
	if err := limiter.Check(context.Background()); err == nil || !strings.Contains(err.Error(), "ping") {
		t.Fatalf("readiness error = %v", err)
	}
}

func TestSecretFilesRequireAbsoluteRestrictedRegularFiles(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "secret")
	if err := os.WriteFile(path, []byte(base64.StdEncoding.EncodeToString([]byte("01234567890123456789012345678901"))+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	secret, err := readHMACKey(path)
	if err != nil || len(secret) != 32 {
		t.Fatalf("read HMAC key = %d bytes, %v", len(secret), err)
	}
	clear(secret)
	if _, err := readHMACKey("relative.key"); err == nil || !strings.Contains(err.Error(), "absolute") {
		t.Fatalf("relative secret error = %v", err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readHMACKey(path); err == nil || !strings.Contains(err.Error(), "permissions") {
		t.Fatalf("broad secret permissions error = %v", err)
	}
}
