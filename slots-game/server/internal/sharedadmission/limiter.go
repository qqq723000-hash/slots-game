// sharedadmission 包只提供已验证身份后的跨副本限流。
// PostgreSQL 仍是会话、轮次、钱包和幂等状态的唯一权威。
// English: The sharedadmission package only provides cross-replica flow limiting after identity verification.
// PostgreSQL remains the sole authority on sessions, rounds, wallets, and idempotent state.
package sharedadmission

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"time"

	valkey "github.com/valkey-io/valkey-go"

	"slots-game/server/internal/platform"
	"slots-game/server/internal/rgsapi"
)

const (
	maximumSecretBytes = 4 << 10
	maximumRootCABytes = 1 << 20
	// v2 使用单字符串状态，避免与旧 hash 状态发生 WRONGTYPE；花括号使每个身份及其
	// 未来的关联键在 Valkey Cluster 中稳定落到同一 slot，而不同 HMAC 仍均匀分布。
	// English: v2 uses a single string state to avoid WRONGTYPE with the old hash state; the curly braces allow each
	// identity and its future associated keys to stably fall into the same slot in the Valkey Cluster, while different
	// HMACs are still evenly distributed.
	keyPrefix = "rgs:shared-admission:v2:{"
	// valkey-go 的单节点客户端会把 0 解释为按 GOMAXPROCS 扩展管线；-1 会
	// 规范化为一条未用的管线通道。业务命令强制走下面的有界同步池。
	// English: The single-node client of valkey-go will interpret 0 as extending the pipeline by GOMAXPROCS; -1 will
	// normalize to an unused pipeline channel. Business commands force the bounded synchronization pool below.
	singlePipelineConnectionMultiplex = -1
	// 自动管线的环形队列在黑洞 peer 下不保证 PutOne 响应 context。应用层
	// 四许可闸门保证不会有第五条命令进入依赖池，socket deadline 限制在途读写；四条是
	// 对健康跨 AZ RTT 吞吐与每 Pod 连接上界的保守折中。
	// English: The automatic pipeline's circular queue does not guarantee PutOne response context under the blackhole
	// peer. The four permission gates of the application layer ensure that no fifth command will enter the dependency
	// pool, and the socket deadline limits in-transit reading and writing; the four permission gates are a
	// conservative compromise between healthy cross-AZ RTT throughput and the upper bound of each Pod connection.
	synchronousValkeyPoolSize = 4
	// ForceSingleClient 在构造时还会保留一条基础 mux socket；禁用自动
	// 管线后它不承载业务命令，但必须计入 ElastiCache 连接预算。
	// English: ForceSingleClient also retains a basic mux socket when it is constructed; it does not carry business
	// commands after disabling the automatic pipeline, but must be included in the ElastiCache connection budget.
	maximumValkeyConnectionsPerPod = synchronousValkeyPoolSize + 1
	// ElastiCache 端点使用关闭集群模式的单节点协议；显式关闭集群探测，
	// 避免客户端发送 ACL 未授权的 CLUSTER SLOTS 并制造误告警。
	// English: The ElastiCache endpoint uses a single-node protocol that turns off cluster mode; explicitly turning
	// off cluster detection prevents clients from sending ACL-unauthorized CLUSTER SLOTS and creating false alarms.
	forceSingleValkeyClient = true
	maximumBucketTTL        = 24 * time.Hour
	// 启动 canary 使用两个 token，连续两次成功都会走 SET；极高回填率把每次
	// 写入的 TTL 固定在约一秒。第二次调用因此必须读取同一个尚未过期的状态并
	// 执行 PTTL，而随机 key 不含运营商、玩家、会话或钱包身份。
	// English: Two tokens are used to start the canary, and SET will be used for two consecutive successes; the
	// extremely high backfill rate fixes the TTL of each write to about one second. The second call must therefore
	// read the same not-yet-expired state and perform PTTL with a random key that does not contain operator, player,
	// session or wallet identity.
	basicCanaryCapacityMilli      int64 = 2_000
	basicCanaryRateMilliPerSecond int64 = 2_000_000
	basicCanaryNonceBytes               = 16
)

const tokenBucketScriptBody = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
if not capacity or not rate or capacity < 1000 or capacity > 1000000000 or
  rate < 1 or rate > 100000000 then
  return redis.error_reply('invalid token bucket configuration')
end
local fill_time = math.ceil(capacity * 1000 / rate)
if fill_time + 1000 > 86400000 then
  return redis.error_reply('invalid token bucket configuration')
end
local state = redis.call('GET', KEYS[1])
local tokens = capacity
local elapsed = 0
if state then
  local decoded_ok, decoded = pcall(cmsgpack.unpack, state)
  local ttl = redis.call('PTTL', KEYS[1])
  if not decoded_ok or type(decoded) ~= 'table' then
    return redis.error_reply('invalid token bucket state')
  end
  tokens = tonumber(decoded[1])
  local ttl_base = tonumber(decoded[2])
  if not tokens or tokens ~= tokens or tokens < 0 or not ttl_base or
    ttl_base ~= math.floor(ttl_base) or ttl_base < 1000 or ttl_base > 86400000 or
    ttl < 0 or ttl > ttl_base or decoded[3] ~= nil then
    return redis.error_reply('invalid token bucket state')
  end
  tokens = math.min(capacity, tokens)
  elapsed = ttl_base - ttl
  if elapsed < 0 then elapsed = 0 end
  if elapsed > fill_time then elapsed = fill_time end
end
tokens = math.min(capacity, tokens + elapsed * rate / 1000)
local allowed = 0
local retry_ms = 0
if tokens >= 1000 then
  tokens = tokens - 1000
  allowed = 1
  local ttl_base = math.max(1000, fill_time + 1000)
  redis.call('SET', KEYS[1], cmsgpack.pack({tokens, ttl_base}), 'PX', ttl_base)
else
  retry_ms = math.max(1, math.ceil((1000 - tokens) * 1000 / rate))
end
return {allowed, retry_ms}
`

// SHA-1 只作为 Valkey SCRIPT 协议规定的内容地址，不承担任何密码学安全判断。
// 使用预计算值可避免 FIPS 140-only 进程在启动时调用被禁止的 SHA-1 实现。
// English: SHA-1 only serves as the content address specified in the Valkey SCRIPT protocol and does not assume
// any cryptographic security judgment. Using precomputed values prevents FIPS 140-only processes from calling
// forbidden SHA-1 implementations at startup.
const tokenBucketScriptSHA1 = "8058bf83ba" +
	"86e36cf118" +
	"3596a03259" +
	"d1b818058b"

type Config struct {
	URL          string
	Username     string
	PasswordFile string
	HMACKeyFile  string
	RootCAFile   string
	Timeout      time.Duration
	Rate         float64
	Burst        int
}

type scriptExecutor interface {
	EvaluateDirect(context.Context, string, []string) ([]int64, error)
	Evaluate(context.Context, string, []string) ([]int64, error)
	Close()
}

type valkeyExecutor struct {
	client                 valkey.Client
	transportPermits       chan struct{}
	scriptReload           chan struct{}
	economicReload         chan struct{}
	scriptGeneration       atomic.Uint64
	economicGeneration     atomic.Uint64
	noScriptMisses         atomic.Uint64
	economicNoScriptMisses atomic.Uint64
}

func (executor *valkeyExecutor) Evaluate(ctx context.Context, key string, args []string) ([]int64, error) {
	evalsha := func() scriptCallResult {
		return executor.call(ctx, func() valkey.ValkeyResult {
			return executor.client.Do(ctx, executor.client.B().Evalsha().Sha1(tokenBucketScriptSHA1).
				Numkeys(1).Key(key).Arg(args...).Build())
		})
	}
	eval := func() scriptCallResult {
		return executor.evaluateTokenBucketBody(ctx, key, args)
	}
	return executor.evaluateCached(ctx, evalsha, eval)
}

// EvaluateDirect 只用于监听器启动前的匿名 canary，强制携带完整 Lua body，确保
// 热脚本缓存不能掩盖缺失的 EVAL ACL。普通 Admit 继续使用 Evaluate 的
// EVALSHA/NOSCRIPT 单飞恢复路径，不改变热路径语义。
// English: EvaluateDirect is only used for anonymous canary before the listener is started, forcing the complete
// Lua body to be carried to ensure that the hot script cache cannot cover up the missing EVAL ACL. Ordinary Admit
// continues to use Evaluate's EVALSHA/NOSCRIPT solo recovery path without changing the hot path semantics.
func (executor *valkeyExecutor) EvaluateDirect(
	ctx context.Context,
	key string,
	args []string,
) ([]int64, error) {
	result := executor.evaluateTokenBucketBody(ctx, key, args)
	return result.values, result.err
}

func (executor *valkeyExecutor) evaluateTokenBucketBody(
	ctx context.Context,
	key string,
	args []string,
) scriptCallResult {
	return executor.call(ctx, func() valkey.ValkeyResult {
		return executor.client.Do(ctx, executor.client.B().Eval().Script(tokenBucketScriptBody).
			Numkeys(1).Key(key).Arg(args...).Build())
	})
}

func (executor *valkeyExecutor) EvaluateEconomic(
	ctx context.Context,
	keys []string,
	args []string,
) ([]int64, error) {
	if len(keys) != 2 {
		return nil, errors.New("economic admission requires exactly two keys")
	}
	evalsha := func() scriptCallResult {
		return executor.call(ctx, func() valkey.ValkeyResult {
			return executor.client.Do(ctx, executor.client.B().Evalsha().Sha1(economicTokenBucketScriptSHA1).
				Numkeys(2).Key(keys...).Arg(args...).Build())
		})
	}
	eval := func() scriptCallResult {
		return executor.call(ctx, func() valkey.ValkeyResult {
			return executor.client.Do(ctx, executor.client.B().Eval().Script(economicTokenBucketScriptBody).
				Numkeys(2).Key(keys...).Arg(args...).Build())
		})
	}
	return executor.evaluateEconomicCached(ctx, evalsha, eval)
}

func (executor *valkeyExecutor) call(ctx context.Context, command func() valkey.ValkeyResult) scriptCallResult {
	if err := executor.acquireTransport(ctx); err != nil {
		return scriptCallResult{err: err}
	}
	defer executor.releaseTransport()
	return parseScriptCallResult(command())
}

func (executor *valkeyExecutor) acquireTransport(ctx context.Context) error {
	select {
	case executor.transportPermits <- struct{}{}:
		// 取消与许可同时就绪时 select 可能选择任一分支；进入 valkey-go 前再次检查，
		// 防止已经过期的等待者进入依赖连接池。
		// English: When cancellation and permission are ready at the same time, select may select any branch; check again
		// before entering valkey-go to prevent expired waiters from entering the dependent connection pool.
		if err := ctx.Err(); err != nil {
			executor.releaseTransport()
			return err
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (executor *valkeyExecutor) releaseTransport() { <-executor.transportPermits }

type scriptCallResult struct {
	values   []int64
	err      error
	noScript bool
}

func parseScriptCallResult(result valkey.ValkeyResult) scriptCallResult {
	resultError := result.Error()
	valkeyError, isValkeyError := valkey.IsValkeyErr(resultError)
	values, err := result.AsIntSlice()
	return scriptCallResult{values: values, err: err, noScript: isValkeyError && valkeyError.IsNoScript()}
}

func (executor *valkeyExecutor) evaluateCached(
	ctx context.Context,
	evalsha func() scriptCallResult,
	eval func() scriptCallResult,
) ([]int64, error) {
	for {
		generation := executor.scriptGeneration.Load()
		result := evalsha()
		if !result.noScript {
			return result.values, result.err
		}
		executor.noScriptMisses.Add(1)
		// 故障转移会清空服务端脚本缓存。只允许一个并发请求携带完整 Lua body；
		// 其余请求等待该次装载后重试 EVALSHA，避免 N 个并发请求放大脚本文本流量。
		// 获取闸门必须响应调用方 deadline，不能让缓存恢复突破准入超时。
		// English: Failover clears the server script cache. Only one concurrent request is allowed to carry the complete
		// Lua body; the remaining requests wait for the load and then retry EVALSHA to avoid N concurrent requests from
		// amplifying script text traffic. The acquisition gate must respond to the caller's deadline and cannot allow
		// cache recovery to exceed the admission timeout.
		select {
		case executor.scriptReload <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		if executor.scriptGeneration.Load() != generation {
			<-executor.scriptReload
			continue
		}
		result = eval()
		if result.err == nil {
			executor.scriptGeneration.Add(1)
		}
		<-executor.scriptReload
		return result.values, result.err
	}
}

func (executor *valkeyExecutor) evaluateEconomicCached(
	ctx context.Context,
	evalsha func() scriptCallResult,
	eval func() scriptCallResult,
) ([]int64, error) {
	for {
		generation := executor.economicGeneration.Load()
		result := evalsha()
		if !result.noScript {
			return result.values, result.err
		}
		executor.economicNoScriptMisses.Add(1)
		select {
		case executor.economicReload <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		if executor.economicGeneration.Load() != generation {
			<-executor.economicReload
			continue
		}
		result = eval()
		if result.err == nil {
			executor.economicGeneration.Add(1)
		}
		<-executor.economicReload
		return result.values, result.err
	}
}

func (executor *valkeyExecutor) Close() { executor.client.Close() }

type Limiter struct {
	executor         scriptExecutor
	hmacKey          []byte
	timeout          time.Duration
	arguments        []string
	metrics          *platform.Metrics
	unavailableUntil atomic.Int64
	probeInFlight    atomic.Bool
	now              func() time.Time
}

func New(config Config, metrics *platform.Metrics) (*Limiter, error) {
	endpoint, err := parseEndpoint(config.URL)
	if err != nil {
		return nil, err
	}
	password, err := readPassword(config.PasswordFile)
	if err != nil {
		return nil, fmt.Errorf("load shared admission password: %w", err)
	}
	defer clear(password)
	hmacKey, err := readHMACKey(config.HMACKeyFile)
	if err != nil {
		return nil, fmt.Errorf("load shared admission HMAC key: %w", err)
	}
	rootCAs, err := loadRootCAs(config.RootCAFile)
	if err != nil {
		clear(hmacKey)
		return nil, fmt.Errorf("load shared admission root CA: %w", err)
	}
	address := endpoint.Host
	if endpoint.Port() == "" {
		address = net.JoinHostPort(endpoint.Hostname(), "6379")
	}
	clientOptions := boundedValkeyClientOptions(config.Timeout)
	clientOptions.InitAddress = []string{address}
	clientOptions.Username = config.Username
	clientOptions.Password = string(password)
	clientOptions.ClientName = "rgs-shared-admission"
	clientOptions.TLSConfig = &tls.Config{
		MinVersion: tls.VersionTLS12,
		ServerName: endpoint.Hostname(),
		RootCAs:    rootCAs,
	}
	client, err := valkey.NewClient(clientOptions)
	if err != nil {
		clear(hmacKey)
		return nil, fmt.Errorf("construct shared admission client: %w", err)
	}
	limiter, err := newLimiter(newValkeyExecutor(client), config, hmacKey, metrics)
	if err != nil {
		client.Close()
		clear(hmacKey)
		return nil, err
	}
	return limiter, nil
}

// boundedValkeyClientOptions 是生产和故障/负载测试共用的传输安全契约。
// DisableAutoPipelining 不能被省略：valkey-go v1.0.67 的自动管线环形队列在
// peer 不读响应时可能在 context 取消后仍阻塞入队。valkeyExecutor 的应用许可
// 在调用依赖前响应 context，因此同步池不承担等待队列；ConnWriteTimeout 为已获准
// 命令的读写设置第二道硬上界。
// English: boundedValkeyClientOptions is a transport security contract common to production and failure/load
// testing. DisableAutoPipelining cannot be omitted: the automatic pipeline ring queue of valkey-go v1.0.67 may
// still block enqueueing after the context is canceled when the peer does not read the response. The application
// permission of valkeyExecutor responds to the context before calling the dependency, so the synchronization pool
// does not bear the waiting queue; ConnWriteTimeout sets a second hard upper bound for the reading and writing of
// approved commands.
func boundedValkeyClientOptions(timeout time.Duration) valkey.ClientOption {
	return valkey.ClientOption{
		ForceSingleClient:     forceSingleValkeyClient,
		Dialer:                net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second},
		ConnWriteTimeout:      timeout,
		PipelineMultiplex:     singlePipelineConnectionMultiplex,
		BlockingPoolSize:      synchronousValkeyPoolSize,
		DisableAutoPipelining: true,
		DisableRetry:          true,
		DisableCache:          true,
	}
}

func newValkeyExecutor(client valkey.Client) *valkeyExecutor {
	return &valkeyExecutor{
		client:           client,
		transportPermits: make(chan struct{}, synchronousValkeyPoolSize),
		scriptReload:     make(chan struct{}, 1),
		economicReload:   make(chan struct{}, 1),
	}
}

func newLimiter(executor scriptExecutor, config Config, hmacKey []byte, metrics *platform.Metrics) (*Limiter, error) {
	if executor == nil || len(hmacKey) != sha256.Size {
		return nil, errors.New("shared admission executor and 32-byte HMAC key are required")
	}
	if config.Timeout < 10*time.Millisecond || config.Timeout > 500*time.Millisecond ||
		math.IsNaN(config.Rate) || math.IsInf(config.Rate, 0) ||
		config.Rate <= 0 || config.Rate > 100_000 || config.Burst < 1 || config.Burst > 1_000_000 {
		return nil, errors.New("invalid shared admission bounds")
	}
	rateMilli, exact := exactMilliRate(config.Rate)
	if !exact || rateMilli < 1 || float64(config.Burst)*1_000 > math.MaxInt64 {
		return nil, errors.New("shared admission rate must be exactly representable in millitokens")
	}
	fillMilliseconds := math.Ceil(float64(config.Burst) * 1_000 * 1_000 / float64(rateMilli))
	if fillMilliseconds+1_000 > float64(maximumBucketTTL/time.Millisecond) {
		return nil, errors.New("shared admission full-refill TTL exceeds 24 hours")
	}
	limiter := &Limiter{
		executor: executor,
		hmacKey:  append([]byte(nil), hmacKey...),
		timeout:  config.Timeout,
		arguments: []string{
			strconv.FormatInt(int64(config.Burst)*1_000, 10),
			strconv.FormatInt(rateMilli, 10),
		},
		metrics: metrics,
		now:     time.Now,
	}
	if metrics != nil {
		metrics.EnableEconomicAdmissionHealthMetrics()
	}
	return limiter, nil
}

func (limiter *Limiter) Admit(parent context.Context, identity string, _ time.Time) rgsapi.AdmissionResult {
	if limiter == nil || limiter.executor == nil || len(limiter.hmacKey) != sha256.Size || identity == "" {
		return limiter.backendUnavailable()
	}
	now := limiter.observationTime()
	unavailableUntil := limiter.unavailableUntil.Load()
	if unavailableUntil > now.UnixNano() {
		return limiter.backendUnavailable()
	}
	if unavailableUntil != 0 {
		if !limiter.probeInFlight.CompareAndSwap(false, true) {
			return limiter.backendUnavailable()
		}
		defer limiter.probeInFlight.Store(false)
	}
	// 客户端时间只用于旧的进程内限制器；共享桶从 Valkey PTTL 推导经过时间，
	// 避免 Pod 时钟漂移并保持故障转移后的服务端 TTL 语义。
	// English: Client time is used only with the old in-process limiter; shared buckets derive elapsed time from
	// Valkey PTTL, avoiding Pod clock drift and maintaining server-side TTL semantics after failover.
	ctx, cancel := context.WithTimeout(parent, limiter.timeout)
	defer cancel()
	mac := hmac.New(sha256.New, limiter.hmacKey)
	_, _ = mac.Write([]byte(identity))
	key := keyPrefix + hex.EncodeToString(mac.Sum(nil)) + "}"
	result, err := limiter.executor.Evaluate(ctx, key, limiter.arguments)
	if err != nil || len(result) != 2 || (result[0] != 0 && result[0] != 1) || result[1] < 0 ||
		result[1] > int64(maximumBucketTTL/time.Millisecond) {
		// 调用方主动取消不代表共享后端故障；本次仍 fail-closed，但不能让单个取消请求
		// 打开全局熔断并隔离其他运营商/会话。内部超时和真实协议错误仍开启熔断。
		// English: Active cancellation by the caller does not mean a failure of the shared backend; it is still
		// fail-closed this time, but a single cancellation request cannot turn on global circuit breaker and isolate other
		// operators/sessions. Internal timeouts and real protocol errors still enable circuit breakers.
		if parent.Err() != nil {
			return limiter.requestUnavailable()
		}
		limiter.unavailableUntil.Store(now.Add(time.Second).UnixNano())
		return limiter.backendUnavailable()
	}
	limiter.unavailableUntil.Store(0)
	if limiter.metrics != nil {
		limiter.metrics.ObserveSharedAdmissionHealth(true, now)
	}
	if result[0] == 0 {
		if limiter.metrics != nil {
			limiter.metrics.SharedAdmissionLimited.Add(1)
		}
		return rgsapi.AdmissionResult{
			Decision:   rgsapi.AdmissionRateLimited,
			RetryAfter: time.Duration(result[1]) * time.Millisecond,
		}
	}
	if limiter.metrics != nil {
		limiter.metrics.SharedAdmissionAllowed.Add(1)
	}
	return rgsapi.AdmissionResult{Decision: rgsapi.AdmissionAllowed}
}

func (limiter *Limiter) backendUnavailable() rgsapi.AdmissionResult {
	if limiter != nil && limiter.metrics != nil {
		limiter.metrics.SharedAdmissionErrors.Add(1)
		limiter.metrics.ObserveSharedAdmissionHealth(false, time.Time{})
	}
	return rgsapi.AdmissionResult{Decision: rgsapi.AdmissionBackendUnavailable, RetryAfter: time.Second}
}

func (limiter *Limiter) requestUnavailable() rgsapi.AdmissionResult {
	if limiter != nil && limiter.metrics != nil {
		limiter.metrics.SharedAdmissionErrors.Add(1)
	}
	return rgsapi.AdmissionResult{Decision: rgsapi.AdmissionBackendUnavailable, RetryAfter: time.Second}
}

func (limiter *Limiter) observationTime() time.Time {
	if limiter != nil && limiter.now != nil {
		return limiter.now()
	}
	return time.Now()
}

func (limiter *Limiter) Name() string { return "shared_admission" }

func (limiter *Limiter) Check(parent context.Context) error {
	if limiter == nil || limiter.executor == nil {
		return errors.New("shared admission client is not configured")
	}
	ctx, cancel := context.WithTimeout(parent, limiter.timeout)
	defer cancel()
	var nonce [basicCanaryNonceBytes]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		if limiter.metrics != nil {
			limiter.metrics.ObserveSharedAdmissionHealth(false, time.Time{})
		}
		return errors.New("shared admission basic canary entropy unavailable")
	}
	key := keyPrefix + "startup-canary:" + hex.EncodeToString(nonce[:]) + "}"
	arguments := []string{
		strconv.FormatInt(basicCanaryCapacityMilli, 10),
		strconv.FormatInt(basicCanaryRateMilliPerSecond, 10),
	}
	evaluations := []func(context.Context, string, []string) ([]int64, error){
		limiter.executor.EvaluateDirect,
		limiter.executor.Evaluate,
	}
	for _, evaluate := range evaluations {
		result, err := evaluate(ctx, key, arguments)
		if err != nil || len(result) != 2 || result[0] != 1 || result[1] != 0 {
			if limiter.metrics != nil {
				limiter.metrics.ObserveSharedAdmissionHealth(false, time.Time{})
			}
			// 不拼接 Valkey 错误：ACL、端点或传输细节不能进入上层启动错误。
			// English: Not splicing Valkey error: ACL, endpoint, or transport details cannot be entered into the upper layer
			// startup error.
			return errors.New("shared admission basic canary failed")
		}
	}
	if limiter.metrics != nil {
		limiter.metrics.ObserveSharedAdmissionHealth(true, limiter.observationTime())
	}
	return nil
}

func (limiter *Limiter) Close() {
	if limiter == nil {
		return
	}
	if limiter.executor != nil {
		limiter.executor.Close()
	}
	clear(limiter.hmacKey)
}

func parseEndpoint(raw string) (*url.URL, error) {
	endpoint, err := url.Parse(raw)
	if err != nil || endpoint.Scheme != "rediss" || endpoint.Host == "" || endpoint.Hostname() == "" ||
		endpoint.User != nil || (endpoint.Path != "" && endpoint.Path != "/") || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, errors.New("shared admission URL must be a rediss origin without credentials, query, or fragment")
	}
	return endpoint, nil
}

func readPassword(path string) ([]byte, error) {
	contents, err := readFile(path, maximumSecretBytes, true)
	if err != nil {
		return nil, err
	}
	contents = bytes.TrimSuffix(contents, []byte("\n"))
	if len(contents) < 16 || bytes.ContainsAny(contents, " \t\r\n") {
		clear(contents)
		return nil, errors.New("password must contain at least 16 bytes without whitespace")
	}
	return contents, nil
}

func readHMACKey(path string) ([]byte, error) {
	encoded, err := readFile(path, maximumSecretBytes, true)
	if err != nil {
		return nil, err
	}
	encoded = bytes.TrimSuffix(encoded, []byte("\n"))
	decoded := make([]byte, base64.StdEncoding.DecodedLen(len(encoded)))
	decodedLength, err := base64.StdEncoding.Strict().Decode(decoded, encoded)
	decoded = decoded[:decodedLength]
	canonical := make([]byte, base64.StdEncoding.EncodedLen(len(decoded)))
	base64.StdEncoding.Encode(canonical, decoded)
	isCanonical := bytes.Equal(canonical, encoded)
	clear(canonical)
	clear(encoded)
	if err != nil || len(decoded) != sha256.Size || !isCanonical {
		clear(decoded)
		return nil, errors.New("HMAC key must be canonical base64 for exactly 32 bytes")
	}
	return decoded, nil
}

func loadRootCAs(path string) (*x509.CertPool, error) {
	pem, err := readFile(path, maximumRootCABytes, false)
	if err != nil {
		return nil, err
	}
	defer clear(pem)
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, errors.New("root CA file does not contain a PEM certificate")
	}
	return pool, nil
}

func readFile(path string, maximum int64, secret bool) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("file path must be absolute")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("file must be regular")
	}
	if secret && info.Mode().Perm() != 0o400 && info.Mode().Perm() != 0o600 {
		return nil, fmt.Errorf("secret file permissions %04o must be 0400 or 0600", info.Mode().Perm())
	}
	contents, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(contents)) > maximum {
		clear(contents)
		return nil, fmt.Errorf("file exceeds %d-byte limit", maximum)
	}
	return contents, nil
}

var _ rgsapi.Admission = (*Limiter)(nil)
var _ platform.DependencyCheck = (*Limiter)(nil)
