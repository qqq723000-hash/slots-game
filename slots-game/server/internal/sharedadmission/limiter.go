// sharedadmission 包只提供已验证身份后的跨副本限流。
// PostgreSQL 仍是会话、轮次、钱包和幂等状态的唯一权威。
package sharedadmission

import (
	"bytes"
	"context"
	"crypto/hmac"
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
	keyPrefix = "rgs:shared-admission:v2:{"
	// valkey-go 的单节点客户端会把 0 解释为按 GOMAXPROCS 扩展连接；-1 会
	// 规范化为一条管线连接，避免每个 API Pod 在故障时放大连接风暴。
	singlePipelineConnectionMultiplex = -1
	// ElastiCache 端点使用关闭集群模式的单节点协议；显式关闭集群探测，
	// 避免客户端发送 ACL 未授权的 CLUSTER SLOTS 并制造误告警。
	forceSingleValkeyClient = true
	maximumBucketTTL        = 24 * time.Hour
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
	Evaluate(context.Context, string, []string) ([]int64, error)
	Ping(context.Context) error
	Close()
}

type valkeyExecutor struct {
	client           valkey.Client
	scriptReload     chan struct{}
	scriptGeneration atomic.Uint64
	noScriptMisses   atomic.Uint64
}

func (executor *valkeyExecutor) Evaluate(ctx context.Context, key string, args []string) ([]int64, error) {
	evalsha := func() scriptCallResult {
		return parseScriptCallResult(executor.client.Do(ctx, executor.client.B().Evalsha().Sha1(tokenBucketScriptSHA1).
			Numkeys(1).Key(key).Arg(args...).Build()))
	}
	eval := func() scriptCallResult {
		return parseScriptCallResult(executor.client.Do(ctx, executor.client.B().Eval().Script(tokenBucketScriptBody).
			Numkeys(1).Key(key).Arg(args...).Build()))
	}
	return executor.evaluateCached(ctx, evalsha, eval)
}

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

func (executor *valkeyExecutor) Ping(ctx context.Context) error {
	return executor.client.Do(ctx, executor.client.B().Ping().Build()).Error()
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
	client, err := valkey.NewClient(valkey.ClientOption{
		InitAddress:       []string{address},
		ForceSingleClient: forceSingleValkeyClient,
		Username:          config.Username,
		Password:          string(password),
		ClientName:        "rgs-shared-admission",
		TLSConfig:         &tls.Config{MinVersion: tls.VersionTLS12, ServerName: endpoint.Hostname(), RootCAs: rootCAs},
		Dialer:            net.Dialer{Timeout: config.Timeout, KeepAlive: 30 * time.Second},
		ConnWriteTimeout:  config.Timeout,
		PipelineMultiplex: singlePipelineConnectionMultiplex,
		BlockingPoolSize:  1,
		DisableRetry:      true,
		DisableCache:      true,
	})
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

func newValkeyExecutor(client valkey.Client) *valkeyExecutor {
	return &valkeyExecutor{client: client, scriptReload: make(chan struct{}, 1)}
}

func newLimiter(executor scriptExecutor, config Config, hmacKey []byte, metrics *platform.Metrics) (*Limiter, error) {
	if executor == nil || len(hmacKey) != sha256.Size {
		return nil, errors.New("shared admission executor and 32-byte HMAC key are required")
	}
	if config.Timeout < 10*time.Millisecond || config.Timeout > 500*time.Millisecond ||
		config.Rate <= 0 || config.Rate > 100_000 || config.Burst < 1 || config.Burst > 1_000_000 {
		return nil, errors.New("invalid shared admission bounds")
	}
	rateMilli := math.Round(config.Rate * 1_000)
	if rateMilli < 1 || rateMilli > math.MaxInt64 || float64(config.Burst)*1_000 > math.MaxInt64 {
		return nil, errors.New("shared admission rate cannot be represented safely")
	}
	fillMilliseconds := math.Ceil(float64(config.Burst) * 1_000 * 1_000 / rateMilli)
	if fillMilliseconds+1_000 > float64(maximumBucketTTL/time.Millisecond) {
		return nil, errors.New("shared admission full-refill TTL exceeds 24 hours")
	}
	return &Limiter{
		executor: executor,
		hmacKey:  append([]byte(nil), hmacKey...),
		timeout:  config.Timeout,
		arguments: []string{
			strconv.FormatInt(int64(config.Burst)*1_000, 10),
			strconv.FormatInt(int64(rateMilli), 10),
		},
		metrics: metrics,
		now:     time.Now,
	}, nil
}

func (limiter *Limiter) Admit(parent context.Context, identity string, _ time.Time) rgsapi.AdmissionResult {
	if limiter == nil || limiter.executor == nil || len(limiter.hmacKey) != sha256.Size || identity == "" {
		return limiter.backendUnavailable()
	}
	now := limiter.now()
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
	ctx, cancel := context.WithTimeout(parent, limiter.timeout)
	defer cancel()
	mac := hmac.New(sha256.New, limiter.hmacKey)
	_, _ = mac.Write([]byte(identity))
	key := keyPrefix + hex.EncodeToString(mac.Sum(nil)) + "}"
	result, err := limiter.executor.Evaluate(ctx, key, limiter.arguments)
	if err != nil || len(result) != 2 || (result[0] != 0 && result[0] != 1) || result[1] < 0 {
		// 调用方主动取消不代表共享后端故障；本次仍 fail-closed，但不能让单个取消请求
		// 打开全局熔断并隔离其他运营商/会话。内部超时和真实协议错误仍开启熔断。
		if parent.Err() == nil {
			limiter.unavailableUntil.Store(now.Add(time.Second).UnixNano())
		}
		return limiter.backendUnavailable()
	}
	limiter.unavailableUntil.Store(0)
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
	}
	return rgsapi.AdmissionResult{Decision: rgsapi.AdmissionBackendUnavailable, RetryAfter: time.Second}
}

func (limiter *Limiter) Name() string { return "shared_admission" }

func (limiter *Limiter) Check(parent context.Context) error {
	if limiter == nil || limiter.executor == nil {
		return errors.New("shared admission client is not configured")
	}
	ctx, cancel := context.WithTimeout(parent, limiter.timeout)
	defer cancel()
	if err := limiter.executor.Ping(ctx); err != nil {
		return fmt.Errorf("shared admission ping: %w", err)
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
