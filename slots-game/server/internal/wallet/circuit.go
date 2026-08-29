package wallet

import (
	"sync"
	"time"
)

type circuitState uint8

const (
	circuitClosed circuitState = iota
	circuitOpen
	circuitHalfOpen
)

func (state circuitState) String() string {
	switch state {
	case circuitClosed:
		return "closed"
	case circuitOpen:
		return "open"
	case circuitHalfOpen:
		return "half_open"
	default:
		return "unknown"
	}
}

type circuitConfig struct {
	FailureThreshold    int
	SuccessThreshold    int
	OpenDuration        time.Duration
	HalfOpenMaxInFlight int
}

type circuitBreaker struct {
	mu sync.Mutex

	config circuitConfig
	now    func() time.Time

	state               circuitState
	generation          uint64
	openedAt            time.Time
	consecutiveFailures int
	consecutiveSuccess  int
	halfOpenInFlight    int

	onTransition func(circuitState, circuitState)
}

type circuitPermit struct {
	breaker    *circuitBreaker
	generation uint64
	state      circuitState
	once       sync.Once
}

func newCircuitBreaker(
	config circuitConfig,
	now func() time.Time,
	onTransition func(circuitState, circuitState),
) *circuitBreaker {
	if now == nil {
		now = time.Now
	}
	return &circuitBreaker{
		config: config, now: now, state: circuitClosed, generation: 1,
		onTransition: onTransition,
	}
}

// acquire 刻意采用非阻塞语义。熔断器已打开或半开探针额度占满时，
// 调用方会立即收到拒绝，绝不在本进程内排队等待。
// English: acquire intentionally uses non-blocking semantics. When the fuse is open or the half-open probe quota
// is full, the caller will receive a rejection immediately and will never wait in line in this process.
func (breaker *circuitBreaker) acquire() (*circuitPermit, bool) {
	breaker.mu.Lock()
	previous := breaker.state
	if breaker.state == circuitOpen && breaker.now().Sub(breaker.openedAt) >= breaker.config.OpenDuration {
		breaker.transitionLocked(circuitHalfOpen)
	}
	if breaker.state == circuitOpen ||
		(breaker.state == circuitHalfOpen && breaker.halfOpenInFlight >= breaker.config.HalfOpenMaxInFlight) {
		current := breaker.state
		breaker.mu.Unlock()
		breaker.emitTransition(previous, current)
		return nil, false
	}
	if breaker.state == circuitHalfOpen {
		breaker.halfOpenInFlight++
	}
	permit := &circuitPermit{
		breaker: breaker, generation: breaker.generation, state: breaker.state,
	}
	current := breaker.state
	breaker.mu.Unlock()
	breaker.emitTransition(previous, current)
	return permit, true
}

// available 只读检查当前是否有准入可能，不占用探针或长期许可。
// 因此成功只是一项提示；经济意图持久化之后仍必须以 acquire 为最终闸门。
// English: available Read-only checks whether access is currently possible and does not occupy probes or long-term
// licenses. Success is therefore only a hint; after economic intentions are sustained, acquisition must still be
// the final gate.
func (breaker *circuitBreaker) available() bool {
	breaker.mu.Lock()
	defer breaker.mu.Unlock()
	switch breaker.state {
	case circuitClosed:
		return true
	case circuitOpen:
		return breaker.now().Sub(breaker.openedAt) >= breaker.config.OpenDuration
	case circuitHalfOpen:
		return breaker.halfOpenInFlight < breaker.config.HalfOpenMaxInFlight
	default:
		return false
	}
}

func (permit *circuitPermit) complete(success bool) {
	if permit == nil || permit.breaker == nil {
		return
	}
	permit.once.Do(func() {
		breaker := permit.breaker
		breaker.mu.Lock()
		if permit.generation != breaker.generation || permit.state != breaker.state {
			breaker.mu.Unlock()
			return
		}
		previous := breaker.state
		switch breaker.state {
		case circuitClosed:
			if success {
				breaker.consecutiveFailures = 0
			} else {
				breaker.consecutiveFailures++
				if breaker.consecutiveFailures >= breaker.config.FailureThreshold {
					breaker.transitionLocked(circuitOpen)
				}
			}
		case circuitHalfOpen:
			breaker.halfOpenInFlight--
			if !success {
				breaker.transitionLocked(circuitOpen)
			} else {
				breaker.consecutiveSuccess++
				if breaker.consecutiveSuccess >= breaker.config.SuccessThreshold {
					breaker.transitionLocked(circuitClosed)
				}
			}
		}
		current := breaker.state
		breaker.mu.Unlock()
		breaker.emitTransition(previous, current)
	})
}

// cancel 归还半开探针，但不会把本地容量压力误记成远端钱包故障。
// English: cancel returns the half-open probe, but does not mistakenly register local capacity pressure as a
// remote wallet failure.
func (permit *circuitPermit) cancel() {
	if permit == nil || permit.breaker == nil {
		return
	}
	permit.once.Do(func() {
		breaker := permit.breaker
		breaker.mu.Lock()
		if permit.generation == breaker.generation && permit.state == circuitHalfOpen && breaker.state == circuitHalfOpen {
			breaker.halfOpenInFlight--
		}
		breaker.mu.Unlock()
	})
}

func (breaker *circuitBreaker) transitionLocked(next circuitState) {
	if breaker.state == next {
		return
	}
	breaker.state = next
	breaker.generation++
	breaker.consecutiveFailures = 0
	breaker.consecutiveSuccess = 0
	breaker.halfOpenInFlight = 0
	if next == circuitOpen {
		breaker.openedAt = breaker.now()
	}
}

func (breaker *circuitBreaker) emitTransition(previous, current circuitState) {
	if previous != current && breaker.onTransition != nil {
		breaker.onTransition(previous, current)
	}
}
