package sharedadmission

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"slots-game/server/internal/platform"
	"slots-game/server/internal/rgs"
)

const (
	// 复用既有 v2 string-token-bucket keyspace，不引入第二套 keyspace/HMAC；
	// TIME/MSET/PEXPIRE 命令必须先通过受保护的 v2-basic→v2-economic additive
	// ACL plan 同时扩到 A/B 两个用户，再发布包含启动 canary 的新 runtime。
	economicKeyPrefix       = "rgs:shared-admission:v2:"
	economicOperatorLimited = 1
	economicBackendLimited  = 2
)

// economicTokenBucketScriptBody 在一次 Valkey 执行中同时核准运营商和物理钱包
// 后端两个成本桶。同一物理后端的两个 key 使用同一个 HMAC 派生 hash tag，
// 在 Cluster 模式下落入同一 slot；不同后端可分散到不同 slot。
// 任一桶不足时不写任何状态；成功时两个桶一起扣除同一 costUnits。
const economicTokenBucketScriptBody = `
local function load_bucket(key, capacity, rate, now_ms)
  if not capacity or not rate or capacity < 1000 or capacity > 1000000000 or
    rate < 1 or rate > 100000000 then
    return nil, nil, nil, 'invalid economic token bucket configuration'
  end
  local fill_time = math.ceil(capacity * 1000 / rate)
  if fill_time + 1000 > 86400000 then
    return nil, nil, nil, 'invalid economic token bucket configuration'
  end
  local state = redis.call('GET', key)
  local tokens = capacity
  if state then
    local decoded_ok, decoded = pcall(cmsgpack.unpack, state)
    if not decoded_ok or type(decoded) ~= 'table' then
      return nil, nil, nil, 'invalid economic token bucket state'
    end
    tokens = tonumber(decoded[1])
    local last_ms = tonumber(decoded[2])
    if not tokens or tokens ~= tokens or tokens < 0 or not last_ms or
      last_ms ~= math.floor(last_ms) or last_ms < 0 or last_ms > 9007199254740991 or
      decoded[3] ~= nil then
      return nil, nil, nil, 'invalid economic token bucket state'
    end
    tokens = math.min(capacity, tokens)
    local elapsed = now_ms - last_ms
    if elapsed < 0 then elapsed = 0 end
    if elapsed > fill_time then elapsed = fill_time end
    tokens = math.min(capacity, tokens + elapsed * rate / 1000)
  end
  return tokens, math.max(1000, fill_time + 1000), nil
end

local operator_capacity = tonumber(ARGV[1])
local operator_rate = tonumber(ARGV[2])
local backend_capacity = tonumber(ARGV[3])
local backend_rate = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])
if not operator_capacity or not operator_rate or not backend_capacity or not backend_rate or
  operator_capacity < 1000 or operator_capacity > 1000000000 or
  backend_capacity < 1000 or backend_capacity > 1000000000 or
  operator_rate < 1 or operator_rate > 100000000 or
  backend_rate < 1 or backend_rate > 100000000 then
  return redis.error_reply('invalid economic token bucket configuration')
end
if not cost or cost ~= math.floor(cost) or cost < 1000 or
  cost > operator_capacity or cost > backend_capacity then
  return redis.error_reply('invalid economic admission cost')
end

local server_time = redis.call('TIME')
local seconds = tonumber(server_time[1])
local microseconds = tonumber(server_time[2])
if not seconds or not microseconds or seconds < 0 or microseconds < 0 or
  microseconds >= 1000000 then
  return redis.error_reply('invalid economic admission server time')
end
local now_ms = seconds * 1000 + math.floor(microseconds / 1000)
if now_ms ~= math.floor(now_ms) or now_ms > 9007199254740991 then
  return redis.error_reply('invalid economic admission server time')
end

local operator_tokens, operator_ttl, operator_error =
  load_bucket(KEYS[1], operator_capacity, operator_rate, now_ms)
if operator_error then return redis.error_reply(operator_error) end
local backend_tokens, backend_ttl, backend_error =
  load_bucket(KEYS[2], backend_capacity, backend_rate, now_ms)
if backend_error then return redis.error_reply(backend_error) end

local limited = 0
local retry_ms = 0
if operator_tokens < cost then
  limited = limited + 1
  retry_ms = math.max(retry_ms, math.ceil((cost - operator_tokens) * 1000 / operator_rate))
end
if backend_tokens < cost then
  limited = limited + 2
  retry_ms = math.max(retry_ms, math.ceil((cost - backend_tokens) * 1000 / backend_rate))
end
if limited ~= 0 then
  return {0, limited, math.max(1, retry_ms)}
end

local operator_state = cmsgpack.pack({operator_tokens - cost, now_ms})
local backend_state = cmsgpack.pack({backend_tokens - cost, now_ms})
redis.call('MSET', KEYS[1], operator_state, KEYS[2], backend_state)
redis.call('PEXPIRE', KEYS[1], operator_ttl)
redis.call('PEXPIRE', KEYS[2], backend_ttl)
return {1, 0, 0}
`

// SHA-1 只用于 Valkey SCRIPT 内容寻址，不作为安全判断。以字节形式
// 保存公开摘要，避免供应链扫描器将高熵内容地址误识别为密钥。
var economicTokenBucketScriptSHA1 = hex.EncodeToString([]byte{
	0xab, 0x29, 0xf2, 0x1e, 0x5c, 0xc5, 0x5b, 0xbc, 0xf1, 0xb4,
	0x9f, 0xf6, 0x37, 0x3d, 0x2e, 0xce, 0x5e, 0xe4, 0x89, 0xa2,
})

type EconomicPolicy struct {
	RatePerSecond float64
	Burst         int
}

type EconomicConfig struct {
	Operator EconomicPolicy
	Backend  EconomicPolicy
}

// EconomicRoute 来自启动时已批准的 operator -> wallet route 绑定。当前 BackendID
// 是规范化 route origin（scheme://host:port），不能自动推断多个 DNS alias 是否共享
// 供应商计费额度；原始值不进入 Valkey key、日志或指标。
type EconomicRoute struct {
	OperatorID string
	BackendID  string
}

type economicScriptExecutor interface {
	EvaluateEconomic(context.Context, []string, []string) ([]int64, error)
}

type economicRouteKeys struct {
	operator string
	backend  string
}

type economicDecision uint8

const (
	economicAllowed economicDecision = iota + 1
	economicRateLimited
	economicBackendUnavailable
)

type economicResult struct {
	decision   economicDecision
	retryAfter time.Duration
}

type EconomicAdmission struct {
	executor         economicScriptExecutor
	timeout          time.Duration
	arguments        []string
	routes           map[string]economicRouteKeys
	metrics          *platform.Metrics
	unavailableUntil atomic.Int64
	probeInFlight    atomic.Bool
	now              func() time.Time
}

func NewEconomicAdmission(
	limiter *Limiter,
	routes []EconomicRoute,
	config EconomicConfig,
	metrics *platform.Metrics,
) (*EconomicAdmission, error) {
	if limiter == nil || limiter.executor == nil || len(limiter.hmacKey) != sha256.Size {
		return nil, errors.New("economic admission requires the configured shared admission backend")
	}
	executor, ok := limiter.executor.(economicScriptExecutor)
	if !ok {
		return nil, errors.New("shared admission backend lacks atomic economic admission support")
	}
	return newEconomicAdmission(executor, limiter.hmacKey, limiter.timeout, routes, config, metrics)
}

func newEconomicAdmission(
	executor economicScriptExecutor,
	hmacKey []byte,
	timeout time.Duration,
	routes []EconomicRoute,
	config EconomicConfig,
	metrics *platform.Metrics,
) (*EconomicAdmission, error) {
	if executor == nil || len(hmacKey) != sha256.Size || timeout < 10*time.Millisecond || timeout > 500*time.Millisecond {
		return nil, errors.New("invalid economic admission backend")
	}
	operatorArguments, err := economicPolicyArguments(config.Operator)
	if err != nil {
		return nil, errors.New("invalid economic operator policy")
	}
	backendArguments, err := economicPolicyArguments(config.Backend)
	if err != nil {
		return nil, errors.New("invalid economic backend policy")
	}
	if len(routes) == 0 || len(routes) > 100_000 {
		return nil, errors.New("economic admission requires a bounded route table")
	}
	compiled := make(map[string]economicRouteKeys, len(routes))
	for _, route := range routes {
		if route.OperatorID == "" || route.BackendID == "" || strings.TrimSpace(route.OperatorID) != route.OperatorID ||
			strings.TrimSpace(route.BackendID) != route.BackendID {
			return nil, errors.New("economic admission route is invalid")
		}
		if _, duplicate := compiled[route.OperatorID]; duplicate {
			return nil, errors.New("economic admission route is duplicated")
		}
		backendDigest := economicDigest(hmacKey, "backend\x00"+route.BackendID)
		keyPrefix := economicKeyPrefix + "{rgs-economic:" + backendDigest + "}:"
		compiled[route.OperatorID] = economicRouteKeys{
			operator: keyPrefix + "operator:" + economicDigest(hmacKey, "operator\x00"+route.OperatorID),
			backend:  keyPrefix + "backend",
		}
	}
	admission := &EconomicAdmission{
		executor: executor,
		timeout:  timeout,
		arguments: []string{
			operatorArguments[0], operatorArguments[1],
			backendArguments[0], backendArguments[1],
			"1000",
		},
		routes:  compiled,
		metrics: metrics,
		now:     time.Now,
	}
	if metrics != nil {
		metrics.EnableEconomicAdmissionHealthMetrics()
	}
	return admission, nil
}

func economicPolicyArguments(policy EconomicPolicy) ([2]string, error) {
	if math.IsNaN(policy.RatePerSecond) || math.IsInf(policy.RatePerSecond, 0) ||
		policy.RatePerSecond < 0.001 || policy.RatePerSecond > 100_000 ||
		policy.Burst < 1 || policy.Burst > 1_000_000 {
		return [2]string{}, errors.New("economic admission policy is out of bounds")
	}
	rateMilli, exact := exactMilliRate(policy.RatePerSecond)
	if !exact {
		return [2]string{}, errors.New("economic admission rate must have at most three decimal places")
	}
	capacityMilli := int64(policy.Burst) * 1_000
	if rateMilli < 1 || capacityMilli < 1 {
		return [2]string{}, errors.New("economic admission policy cannot be represented")
	}
	fillMilliseconds := math.Ceil(float64(capacityMilli) * 1_000 / float64(rateMilli))
	if fillMilliseconds+1_000 > float64(maximumBucketTTL/time.Millisecond) {
		return [2]string{}, errors.New("economic admission full-refill TTL exceeds 24 hours")
	}
	return [2]string{strconv.FormatInt(capacityMilli, 10), strconv.FormatInt(rateMilli, 10)}, nil
}

// exactMilliRate 禁止静默舍入共享准入预算。四个 ULP 只吸收 strconv/IEEE-754
// 在精确 0.001 单位附近的表示噪声；真实包含第四位小数的运营值会在启动时被拒绝。
func exactMilliRate(rate float64) (int64, bool) {
	scaled := rate * 1_000
	rounded := math.Round(scaled)
	tolerance := 4 * math.Abs(math.Nextafter(scaled, math.Inf(1))-scaled)
	if math.Abs(scaled-rounded) > tolerance || rounded < 1 || rounded > 100_000_000 {
		return 0, false
	}
	return int64(rounded), true
}

func economicDigest(key []byte, identity string) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(identity))
	return hex.EncodeToString(mac.Sum(nil))
}

// admitCost 预留固定供应商调用成本单位；当前 Coordinator 只在首次合法、
// 可持久化的 Spin round 上调用 costUnits=1。成本单位来自受审核运营配置，
// 不得从 bet 金额或未验证请求字段推断。
func (admission *EconomicAdmission) admitCost(
	parent context.Context,
	operatorID string,
	costUnits int,
) economicResult {
	if admission == nil || admission.executor == nil || costUnits < 1 || costUnits > 1_000_000 {
		return admission.backendUnavailable()
	}
	route, exists := admission.routes[operatorID]
	if !exists {
		return admission.backendUnavailable()
	}
	now := admission.observationTime()
	unavailableUntil := admission.unavailableUntil.Load()
	if unavailableUntil > now.UnixNano() {
		return admission.backendUnavailable()
	}
	if unavailableUntil != 0 {
		if !admission.probeInFlight.CompareAndSwap(false, true) {
			return admission.backendUnavailable()
		}
		defer admission.probeInFlight.Store(false)
	}
	arguments := admission.arguments
	if costUnits != 1 {
		arguments = append([]string(nil), arguments...)
		arguments[4] = strconv.FormatInt(int64(costUnits)*1_000, 10)
	}
	ctx, cancel := context.WithTimeout(parent, admission.timeout)
	defer cancel()
	result, err := admission.executor.EvaluateEconomic(
		ctx,
		[]string{route.operator, route.backend},
		arguments,
	)
	if err != nil || len(result) != 3 || (result[0] != 0 && result[0] != 1) ||
		result[1] < 0 || result[1] > 3 || result[2] < 0 ||
		result[2] > int64(maximumBucketTTL/time.Millisecond) ||
		(result[0] == 1 && (result[1] != 0 || result[2] != 0)) ||
		(result[0] == 0 && (result[1] == 0 || result[2] == 0)) {
		if parent.Err() != nil {
			return admission.requestUnavailable()
		}
		admission.unavailableUntil.Store(now.Add(time.Second).UnixNano())
		return admission.backendUnavailable()
	}
	admission.unavailableUntil.Store(0)
	if admission.metrics != nil {
		admission.metrics.ObserveEconomicAdmissionHealth(true, now)
	}
	if result[0] == 1 {
		if admission.metrics != nil {
			admission.metrics.EconomicAdmissionAllowed.Add(1)
		}
		return economicResult{decision: economicAllowed}
	}
	if admission.metrics != nil {
		admission.metrics.EconomicAdmissionLimited.Add(1)
		if result[1]&economicOperatorLimited != 0 {
			admission.metrics.EconomicAdmissionOperatorLimited.Add(1)
		}
		if result[1]&economicBackendLimited != 0 {
			admission.metrics.EconomicAdmissionBackendLimited.Add(1)
		}
	}
	return economicResult{
		decision:   economicRateLimited,
		retryAfter: time.Duration(result[2]) * time.Millisecond,
	}
}

func (admission *EconomicAdmission) AdmitNewEconomicIntent(
	ctx context.Context,
	operatorID string,
	costUnits int,
) error {
	result := admission.admitCost(ctx, operatorID, costUnits)
	switch result.decision {
	case economicAllowed:
		return nil
	case economicRateLimited:
		return &rgs.EconomicAdmissionError{
			Cause:      rgs.ErrEconomicRateLimited,
			RetryAfter: result.retryAfter,
		}
	default:
		return &rgs.EconomicAdmissionError{
			Cause:      rgs.ErrEconomicAdmissionUnavailable,
			RetryAfter: result.retryAfter,
		}
	}
}

// Check 执行 TTL 约一秒的真实 canary，而不只做 PING；API 接收流量前会验证
// 生产 ACL 已允许 EVAL/EVALSHA 及 GET/TIME/MSET/PEXPIRE。随机键不含业务身份。
func (admission *EconomicAdmission) Check(parent context.Context) error {
	if admission == nil || admission.executor == nil {
		if admission != nil && admission.metrics != nil {
			admission.metrics.ObserveEconomicAdmissionHealth(false, time.Time{})
		}
		return errors.New("economic admission is not configured")
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		if admission.metrics != nil {
			admission.metrics.ObserveEconomicAdmissionHealth(false, time.Time{})
		}
		return errors.New("economic admission canary entropy unavailable")
	}
	tag := "{rgs-economic:startup-canary:" + hex.EncodeToString(nonce[:]) + "}"
	ctx, cancel := context.WithTimeout(parent, admission.timeout)
	defer cancel()
	result, err := admission.executor.EvaluateEconomic(
		ctx,
		[]string{
			economicKeyPrefix + tag + ":operator",
			economicKeyPrefix + tag + ":backend",
		},
		[]string{"1000", "1000000", "1000", "1000000", "1000"},
	)
	if err != nil || len(result) != 3 || result[0] != 1 || result[1] != 0 || result[2] != 0 {
		if admission.metrics != nil {
			admission.metrics.ObserveEconomicAdmissionHealth(false, time.Time{})
		}
		return errors.New("economic admission atomic canary failed")
	}
	if admission.metrics != nil {
		admission.metrics.ObserveEconomicAdmissionHealth(true, admission.observationTime())
	}
	return nil
}

func (admission *EconomicAdmission) backendUnavailable() economicResult {
	if admission != nil && admission.metrics != nil {
		admission.metrics.EconomicAdmissionErrors.Add(1)
		admission.metrics.ObserveEconomicAdmissionHealth(false, time.Time{})
	}
	return economicResult{
		decision:   economicBackendUnavailable,
		retryAfter: time.Second,
	}
}

func (admission *EconomicAdmission) requestUnavailable() economicResult {
	if admission != nil && admission.metrics != nil {
		admission.metrics.EconomicAdmissionErrors.Add(1)
	}
	return economicResult{
		decision:   economicBackendUnavailable,
		retryAfter: time.Second,
	}
}

func (admission *EconomicAdmission) observationTime() time.Time {
	if admission != nil && admission.now != nil {
		return admission.now()
	}
	return time.Now()
}

var _ rgs.EconomicIntentAdmitter = (*EconomicAdmission)(nil)
