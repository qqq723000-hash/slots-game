package wallet

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"slots-game/server/internal/rgs"
)

const (
	walletMethodApply    = "apply"
	walletMethodLookup   = "lookup"
	walletMethodRollback = "rollback"

	rejectionBackendBulkhead  = "backend_bulkhead"
	rejectionOperatorBulkhead = "operator_bulkhead"
	rejectionCircuit          = "circuit"
)

var ErrIsolationRejected = errors.New("wallet isolation rejected")

// IsolationError 只包含有界分类值，刻意排除后端、运营商、玩家、轮次和操作标识。
type IsolationError struct {
	Method string
	Reason string
}

func (err *IsolationError) Error() string {
	return fmt.Sprintf("wallet %s rejected by %s", err.Method, err.Reason)
}

func (err *IsolationError) Unwrap() []error {
	return []error{ErrIsolationRejected, rgs.ErrWalletUnavailable}
}

type IsolationConfig struct {
	BackendApplyMaxInFlight   int
	BackendLookupMaxInFlight  int
	OperatorApplyMaxInFlight  int
	OperatorLookupMaxInFlight int
	FailureThreshold          int
	SuccessThreshold          int
	OpenDuration              time.Duration
	HalfOpenMaxInFlight       int
}

func DefaultIsolationConfig() IsolationConfig {
	// HTTP Transport 对每个主机最多开放 32 条连接；Apply 最多占 24 条，
	// 从物理连接层为 Lookup 保留 8 条，避免仅在协程层“逻辑隔离”。
	return IsolationConfig{
		BackendApplyMaxInFlight:   24,
		BackendLookupMaxInFlight:  8,
		OperatorApplyMaxInFlight:  8,
		OperatorLookupMaxInFlight: 4,
		FailureThreshold:          5,
		SuccessThreshold:          2,
		OpenDuration:              5 * time.Second,
		HalfOpenMaxInFlight:       1,
	}
}

func (config IsolationConfig) validate() error {
	if config.BackendApplyMaxInFlight < 1 || config.BackendApplyMaxInFlight > 10_000 ||
		config.BackendLookupMaxInFlight < 1 || config.BackendLookupMaxInFlight > 10_000 ||
		config.OperatorApplyMaxInFlight < 1 || config.OperatorApplyMaxInFlight > 10_000 ||
		config.OperatorLookupMaxInFlight < 1 || config.OperatorLookupMaxInFlight > 10_000 {
		return errors.New("wallet isolation: in-flight limits must be between 1 and 10000")
	}
	if config.FailureThreshold < 1 || config.FailureThreshold > 10_000 ||
		config.SuccessThreshold < 1 || config.SuccessThreshold > 10_000 ||
		config.HalfOpenMaxInFlight < 1 || config.HalfOpenMaxInFlight > 10_000 {
		return errors.New("wallet isolation: circuit thresholds must be between 1 and 10000")
	}
	if config.OpenDuration <= 0 || config.OpenDuration > time.Hour {
		return errors.New("wallet isolation: open duration must be positive and no more than one hour")
	}
	return nil
}

// IsolationObserver 仅接收本包控制的常量，绝不把请求或租户身份交给指标标签。
type IsolationObserver interface {
	ObserveWalletRequest(method, outcome string, duration time.Duration)
	WalletInFlight(method string, delta int64)
	WalletIsolationRejected(method, reason string)
	WalletBreakerStateChanged(method, previous, current string)
}

type IsolationRegistry struct {
	mu sync.Mutex

	config    IsolationConfig
	observer  IsolationObserver
	backends  map[string]*backendIsolation
	ports     map[string]*backendIsolation
	operators map[string]*operatorIsolation
}

type backendIsolation struct {
	applySlots    chan struct{}
	lookupSlots   chan struct{}
	applyCircuit  *circuitBreaker
	lookupCircuit *circuitBreaker
}

type operatorIsolation struct {
	applySlots    chan struct{}
	lookupSlots   chan struct{}
	applyCircuit  *circuitBreaker
	lookupCircuit *circuitBreaker
}

type isolatedWallet struct {
	next       rgs.WalletPort
	resolution rgs.WalletResolutionPort
	operatorID string
	backend    *backendIsolation
	operator   *operatorIsolation
	observer   IsolationObserver
}

func NewIsolationRegistry(config IsolationConfig, observer IsolationObserver) (*IsolationRegistry, error) {
	if err := config.validate(); err != nil {
		return nil, err
	}
	return &IsolationRegistry{
		config: config, observer: observer, backends: make(map[string]*backendIsolation),
		ports: make(map[string]*backendIsolation), operators: make(map[string]*operatorIsolation),
	}, nil
}

func (registry *IsolationRegistry) Wrap(
	backendURL, operatorID string,
	next rgs.WalletPort,
) (rgs.WalletPort, error) {
	resolution, _ := next.(rgs.WalletResolutionPort)
	return registry.WrapPorts(backendURL, operatorID, next, resolution)
}

// WrapPorts 允许兼容门面与显式结果接口共用同一组容量和熔断状态。
func (registry *IsolationRegistry) WrapPorts(
	backendURL, operatorID string,
	next rgs.WalletPort,
	resolution rgs.WalletResolutionPort,
) (*isolatedWallet, error) {
	if registry == nil || next == nil || strings.TrimSpace(operatorID) == "" {
		return nil, errors.New("wallet isolation: backend, operator, and adapter are required")
	}
	backendKey, err := canonicalBackendKey(backendURL)
	if err != nil {
		return nil, err
	}

	registry.mu.Lock()
	defer registry.mu.Unlock()
	backend := registry.backends[backendKey]
	if backend == nil {
		breakerConfig := circuitConfig{
			FailureThreshold:    registry.config.FailureThreshold,
			SuccessThreshold:    registry.config.SuccessThreshold,
			OpenDuration:        registry.config.OpenDuration,
			HalfOpenMaxInFlight: registry.config.HalfOpenMaxInFlight,
		}
		backend = &backendIsolation{
			applySlots:  make(chan struct{}, registry.config.BackendApplyMaxInFlight),
			lookupSlots: make(chan struct{}, registry.config.BackendLookupMaxInFlight),
		}
		backend.applyCircuit = newCircuitBreaker(breakerConfig, nil, func(previous, current circuitState) {
			registry.observeBreaker(walletMethodApply, previous.String(), current.String())
		})
		backend.lookupCircuit = newCircuitBreaker(breakerConfig, nil, func(previous, current circuitState) {
			registry.observeBreaker(walletMethodLookup, previous.String(), current.String())
		})
		registry.backends[backendKey] = backend
		registry.observeBreaker(walletMethodApply, "", circuitClosed.String())
		registry.observeBreaker(walletMethodLookup, "", circuitClosed.String())
	}
	if existing := registry.ports[operatorID]; existing != nil && existing != backend {
		return nil, errors.New("wallet isolation: operator cannot be rebound to another backend")
	}
	operator := registry.operators[operatorID]
	if operator == nil {
		breakerConfig := circuitConfig{
			FailureThreshold:    registry.config.FailureThreshold,
			SuccessThreshold:    registry.config.SuccessThreshold,
			OpenDuration:        registry.config.OpenDuration,
			HalfOpenMaxInFlight: registry.config.HalfOpenMaxInFlight,
		}
		operator = &operatorIsolation{
			applySlots:  make(chan struct{}, registry.config.OperatorApplyMaxInFlight),
			lookupSlots: make(chan struct{}, registry.config.OperatorLookupMaxInFlight),
		}
		operator.applyCircuit = newCircuitBreaker(breakerConfig, nil, func(previous, current circuitState) {
			registry.observeBreaker("operator_"+walletMethodApply, previous.String(), current.String())
		})
		operator.lookupCircuit = newCircuitBreaker(breakerConfig, nil, func(previous, current circuitState) {
			registry.observeBreaker("operator_"+walletMethodLookup, previous.String(), current.String())
		})
		registry.operators[operatorID] = operator
		registry.observeBreaker("operator_"+walletMethodApply, "", circuitClosed.String())
		registry.observeBreaker("operator_"+walletMethodLookup, "", circuitClosed.String())
	}
	registry.ports[operatorID] = backend
	return &isolatedWallet{
		next: next, resolution: resolution, operatorID: operatorID,
		backend: backend, operator: operator, observer: registry.observer,
	}, nil
}

// AdmitNewIntent 在 RNG/PREPARE 之前只读检查 Apply lane；它不会占用许可，
// 持久化之后的 SubmitRound 仍会再次执行权威非阻塞准入。
func (wallet *isolatedWallet) AdmitNewIntent(operatorID string) error {
	if wallet == nil || operatorID == "" || operatorID != wallet.operatorID {
		return fmt.Errorf("%w: wallet route unavailable", rgs.ErrWalletUnavailable)
	}
	switch {
	case !wallet.backend.applyCircuit.available():
		return wallet.admissionRejection(rejectionCircuit)
	case !wallet.operator.applyCircuit.available():
		return wallet.admissionRejection(rejectionCircuit)
	case len(wallet.backend.applySlots) >= cap(wallet.backend.applySlots):
		return wallet.admissionRejection(rejectionBackendBulkhead)
	case len(wallet.operator.applySlots) >= cap(wallet.operator.applySlots):
		return wallet.admissionRejection(rejectionOperatorBulkhead)
	default:
		return nil
	}
}

func (wallet *isolatedWallet) admissionRejection(reason string) error {
	notifyIsolationObserver(wallet.observer, func(observer IsolationObserver) {
		observer.WalletIsolationRejected(walletMethodApply, reason)
	})
	return &IsolationError{Method: walletMethodApply, Reason: reason}
}

// ApplyAvailable 在 PREPARE 前进行不占用许可的只读准入检查。
// 容量可能紧接着变化，所以 ApplyRound 仍是最终的权威闸门。
func (registry *IsolationRegistry) ApplyAvailable(operatorID string) bool {
	if registry == nil {
		return false
	}
	registry.mu.Lock()
	backend := registry.ports[operatorID]
	operator := registry.operators[operatorID]
	registry.mu.Unlock()
	return backend != nil && operator != nil && backend.applyCircuit.available() &&
		operator.applyCircuit.available() && len(backend.applySlots) < cap(backend.applySlots) &&
		len(operator.applySlots) < cap(operator.applySlots)
}

func (wallet *isolatedWallet) ApplyRound(ctx context.Context, command rgs.WalletRound) (rgs.WalletReceipt, error) {
	return wallet.apply(ctx, walletMethodApply, func() (rgs.WalletReceipt, error) {
		return wallet.next.ApplyRound(ctx, command)
	})
}

func (wallet *isolatedWallet) ProfileFor(operatorID string) (rgs.Profile, error) {
	if wallet == nil || wallet.resolution == nil || operatorID != wallet.operatorID {
		return rgs.Profile{}, fmt.Errorf("%w: wallet profile unavailable", rgs.ErrWalletUnavailable)
	}
	return wallet.resolution.ProfileFor(operatorID)
}

func (wallet *isolatedWallet) SubmitRound(ctx context.Context, command rgs.WalletRound) rgs.Resolution {
	started := time.Now()
	backendPermit, ok := wallet.backend.applyCircuit.acquire()
	if !ok {
		return wallet.rejectedResolution(walletMethodApply, rejectionCircuit, started)
	}
	operatorPermit, ok := wallet.operator.applyCircuit.acquire()
	if !ok {
		backendPermit.cancel()
		return wallet.rejectedResolution(walletMethodApply, rejectionCircuit, started)
	}
	if !tryAcquire(wallet.backend.applySlots) {
		operatorPermit.cancel()
		backendPermit.cancel()
		return wallet.rejectedResolution(walletMethodApply, rejectionBackendBulkhead, started)
	}
	if !tryAcquire(wallet.operator.applySlots) {
		release(wallet.backend.applySlots)
		operatorPermit.cancel()
		backendPermit.cancel()
		return wallet.rejectedResolution(walletMethodApply, rejectionOperatorBulkhead, started)
	}
	wallet.inFlight(walletMethodApply, 1)
	defer func() {
		wallet.inFlight(walletMethodApply, -1)
		release(wallet.operator.applySlots)
		release(wallet.backend.applySlots)
	}()
	if wallet.resolution == nil {
		result := rgs.Resolution{Status: rgs.ResolutionNotSent, Cause: rgs.ErrWalletUnavailable}
		operatorPermit.complete(true)
		backendPermit.complete(true)
		wallet.observe(walletMethodApply, "not_sent", time.Since(started))
		return result
	}
	result := wallet.resolution.SubmitRound(ctx, command)
	outcome, backendHealthy, operatorHealthy := classifyResolution(result)
	operatorPermit.complete(operatorHealthy)
	backendPermit.complete(backendHealthy)
	wallet.observe(walletMethodApply, outcome, time.Since(started))
	return result
}

func (wallet *isolatedWallet) Lookup(
	ctx context.Context,
	operatorID, operationID string,
) (rgs.WalletReceipt, bool, error) {
	started := time.Now()
	backendPermit, ok := wallet.backend.lookupCircuit.acquire()
	if !ok {
		err := wallet.reject(walletMethodLookup, rejectionCircuit, started)
		return rgs.WalletReceipt{}, false, err
	}
	operatorPermit, ok := wallet.operator.lookupCircuit.acquire()
	if !ok {
		backendPermit.cancel()
		err := wallet.reject(walletMethodLookup, rejectionCircuit, started)
		return rgs.WalletReceipt{}, false, err
	}
	if !tryAcquire(wallet.backend.lookupSlots) {
		operatorPermit.cancel()
		backendPermit.cancel()
		err := wallet.reject(walletMethodLookup, rejectionBackendBulkhead, started)
		return rgs.WalletReceipt{}, false, err
	}
	if !tryAcquire(wallet.operator.lookupSlots) {
		release(wallet.backend.lookupSlots)
		operatorPermit.cancel()
		backendPermit.cancel()
		err := wallet.reject(walletMethodLookup, rejectionOperatorBulkhead, started)
		return rgs.WalletReceipt{}, false, err
	}
	wallet.inFlight(walletMethodLookup, 1)
	defer func() {
		wallet.inFlight(walletMethodLookup, -1)
		release(wallet.operator.lookupSlots)
		release(wallet.backend.lookupSlots)
	}()
	receipt, found, err := wallet.next.Lookup(ctx, operatorID, operationID)
	outcome, backendHealthy, operatorHealthy := classifyWalletOutcome(err)
	operatorPermit.complete(operatorHealthy)
	backendPermit.complete(backendHealthy)
	wallet.observe(walletMethodLookup, outcome, time.Since(started))
	return receipt, found, err
}

func (wallet *isolatedWallet) Resolve(ctx context.Context, reference rgs.OperationRef) rgs.Resolution {
	started := time.Now()
	backendPermit, ok := wallet.backend.lookupCircuit.acquire()
	if !ok {
		return wallet.rejectedResolution(walletMethodLookup, rejectionCircuit, started)
	}
	operatorPermit, ok := wallet.operator.lookupCircuit.acquire()
	if !ok {
		backendPermit.cancel()
		return wallet.rejectedResolution(walletMethodLookup, rejectionCircuit, started)
	}
	if !tryAcquire(wallet.backend.lookupSlots) {
		operatorPermit.cancel()
		backendPermit.cancel()
		return wallet.rejectedResolution(walletMethodLookup, rejectionBackendBulkhead, started)
	}
	if !tryAcquire(wallet.operator.lookupSlots) {
		release(wallet.backend.lookupSlots)
		operatorPermit.cancel()
		backendPermit.cancel()
		return wallet.rejectedResolution(walletMethodLookup, rejectionOperatorBulkhead, started)
	}
	wallet.inFlight(walletMethodLookup, 1)
	defer func() {
		wallet.inFlight(walletMethodLookup, -1)
		release(wallet.operator.lookupSlots)
		release(wallet.backend.lookupSlots)
	}()
	if wallet.resolution == nil {
		result := rgs.Resolution{Status: rgs.ResolutionNotSent, Cause: rgs.ErrWalletUnavailable}
		operatorPermit.complete(true)
		backendPermit.complete(true)
		wallet.observe(walletMethodLookup, "not_sent", time.Since(started))
		return result
	}
	result := wallet.resolution.Resolve(ctx, reference)
	outcome, backendHealthy, operatorHealthy := classifyResolution(result)
	operatorPermit.complete(operatorHealthy)
	backendPermit.complete(backendHealthy)
	wallet.observe(walletMethodLookup, outcome, time.Since(started))
	return result
}

func (wallet *isolatedWallet) Rollback(ctx context.Context, rollback rgs.WalletRollback) (rgs.WalletReceipt, error) {
	// Rollback 会改变经济状态，因此复用 Apply 的后端/运营商容量与熔断器，
	// 同时保留独立的有界指标方法名。
	return wallet.apply(ctx, walletMethodRollback, func() (rgs.WalletReceipt, error) {
		return wallet.next.Rollback(ctx, rollback)
	})
}

func (wallet *isolatedWallet) apply(
	ctx context.Context,
	metricMethod string,
	call func() (rgs.WalletReceipt, error),
) (rgs.WalletReceipt, error) {
	started := time.Now()
	backendPermit, ok := wallet.backend.applyCircuit.acquire()
	if !ok {
		return rgs.WalletReceipt{}, wallet.reject(metricMethod, rejectionCircuit, started)
	}
	operatorPermit, ok := wallet.operator.applyCircuit.acquire()
	if !ok {
		backendPermit.cancel()
		return rgs.WalletReceipt{}, wallet.reject(metricMethod, rejectionCircuit, started)
	}
	if !tryAcquire(wallet.backend.applySlots) {
		operatorPermit.cancel()
		backendPermit.cancel()
		return rgs.WalletReceipt{}, wallet.reject(metricMethod, rejectionBackendBulkhead, started)
	}
	if !tryAcquire(wallet.operator.applySlots) {
		release(wallet.backend.applySlots)
		operatorPermit.cancel()
		backendPermit.cancel()
		return rgs.WalletReceipt{}, wallet.reject(metricMethod, rejectionOperatorBulkhead, started)
	}
	wallet.inFlight(metricMethod, 1)
	defer func() {
		wallet.inFlight(metricMethod, -1)
		release(wallet.operator.applySlots)
		release(wallet.backend.applySlots)
	}()
	receipt, err := call()
	outcome, backendHealthy, operatorHealthy := classifyWalletOutcome(err)
	operatorPermit.complete(operatorHealthy)
	backendPermit.complete(backendHealthy)
	wallet.observe(metricMethod, outcome, time.Since(started))
	return receipt, err
}

func (wallet *isolatedWallet) reject(method, reason string, started time.Time) error {
	notifyIsolationObserver(wallet.observer, func(observer IsolationObserver) {
		observer.WalletIsolationRejected(method, reason)
	})
	wallet.observe(method, "isolated", time.Since(started))
	return &IsolationError{Method: method, Reason: reason}
}

func (wallet *isolatedWallet) rejectedResolution(method, reason string, started time.Time) rgs.Resolution {
	err := wallet.reject(method, reason, started)
	return rgs.Resolution{Status: rgs.ResolutionNotSent, Cause: err}
}

func (wallet *isolatedWallet) observe(method, outcome string, duration time.Duration) {
	notifyIsolationObserver(wallet.observer, func(observer IsolationObserver) {
		observer.ObserveWalletRequest(method, outcome, duration)
	})
}

func (wallet *isolatedWallet) inFlight(method string, delta int64) {
	notifyIsolationObserver(wallet.observer, func(observer IsolationObserver) {
		observer.WalletInFlight(method, delta)
	})
}

func (registry *IsolationRegistry) observeBreaker(method, previous, current string) {
	notifyIsolationObserver(registry.observer, func(observer IsolationObserver) {
		observer.WalletBreakerStateChanged(method, previous, current)
	})
}

func notifyIsolationObserver(observer IsolationObserver, notify func(IsolationObserver)) {
	if observer == nil {
		return
	}
	defer func() { _ = recover() }()
	notify(observer)
}

func classifyWalletOutcome(err error) (string, bool, bool) {
	switch {
	case err == nil:
		return "success", true, true
	case errors.Is(err, rgs.ErrWalletPending):
		return "pending", true, true
	case errors.Is(err, rgs.ErrWalletRejected):
		return "rejected", true, true
	case errors.Is(err, rgs.ErrIdempotencyConflict):
		return "conflict", true, true
	case errors.Is(err, rgs.ErrWalletReceiptInvalid):
		// 已认证但与该运营商命令身份不符的回执只熔断该运营商，不能误杀
		// 共享同一物理钱包平台的其他租户。
		return "invalid", true, false
	default:
		return "unknown", false, true
	}
}

func classifyResolution(result rgs.Resolution) (string, bool, bool) {
	switch result.Status {
	case rgs.ResolutionSucceeded:
		return "success", true, true
	case rgs.ResolutionRejectedFinal:
		return "rejected", true, true
	case rgs.ResolutionPending:
		return "pending", true, true
	case rgs.ResolutionNotFound:
		return "not_found", true, true
	case rgs.ResolutionConflict:
		if errors.Is(result.Cause, rgs.ErrIdempotencyConflict) {
			return "conflict", true, true
		}
		return "invalid", true, false
	case rgs.ResolutionNotSent:
		return "not_sent", true, true
	case rgs.ResolutionUnknown:
		if errors.Is(result.Cause, errWalletResponseAuthentication) {
			// 响应验签失败通常是该运营商密钥/路由绑定错误；只熔断租户，
			// 不能把同一大平台物理后端上的其他运营商一起切断。
			return "response_auth_invalid", true, false
		}
		return "unknown", false, true
	default:
		return "invalid", true, false
	}
}

func tryAcquire(slots chan struct{}) bool {
	select {
	case slots <- struct{}{}:
		return true
	default:
		return false
	}
}

func release(slots chan struct{}) { <-slots }

func canonicalBackendKey(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return "", errors.New("wallet isolation: backend URL must be an HTTP(S) origin")
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return "", errors.New("wallet isolation: backend URL must include a host")
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port := parsed.Port(); port != "" {
		portNumber, err := strconv.Atoi(port)
		if err != nil || portNumber < 1 || portNumber > 65_535 {
			return "", errors.New("wallet isolation: backend URL has an invalid port")
		}
		defaultPort := parsed.Scheme == "https" && portNumber == 443 ||
			parsed.Scheme == "http" && portNumber == 80
		if !defaultPort {
			host += ":" + strconv.Itoa(portNumber)
		}
	}
	return strings.ToLower(parsed.Scheme) + "://" + host, nil
}

func canonicalLedgerTarget(raw string) (string, error) {
	origin, err := canonicalBackendKey(raw)
	if err != nil {
		return "", err
	}
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("wallet isolation: ledger target cannot contain query or fragment")
	}
	return origin + strings.TrimRight(parsed.EscapedPath(), "/"), nil
}

var _ rgs.WalletPort = (*isolatedWallet)(nil)
var _ rgs.WalletResolutionPort = (*isolatedWallet)(nil)
