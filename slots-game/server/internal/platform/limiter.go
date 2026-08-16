package platform

import (
	"sync"
	"time"
)

type bucket struct {
	tokens   float64
	last     time.Time
	lastSeen time.Time
}

// Limiter 是有界的进程内准入限制器。生产还必须在入口网关实施全局限制；即使上游
// 策略误配，本限制器仍保护每个进程，但不能冒充跨副本限流。
type Limiter struct {
	mu          sync.Mutex
	rate        float64
	burst       float64
	maxKeys     int
	idleExpiry  time.Duration
	lastCleanup time.Time
	buckets     map[string]bucket
}

func NewLimiter(rate float64, burst, maxKeys int, idleExpiry time.Duration) *Limiter {
	return &Limiter{
		rate: rate, burst: float64(burst), maxKeys: maxKeys,
		idleExpiry: idleExpiry, buckets: make(map[string]bucket),
	}
}

func (l *Limiter) Allow(key string, now time.Time) bool {
	if l == nil || key == "" || l.rate <= 0 || l.burst < 1 || l.maxKeys < 1 {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.lastCleanup.IsZero() || now.Sub(l.lastCleanup) >= l.idleExpiry/2 {
		for candidate, state := range l.buckets {
			if now.Sub(state.lastSeen) >= l.idleExpiry {
				delete(l.buckets, candidate)
			}
		}
		l.lastCleanup = now
	}
	state, exists := l.buckets[key]
	if !exists {
		if len(l.buckets) >= l.maxKeys {
			return false
		}
		state = bucket{tokens: l.burst, last: now}
	}
	if now.After(state.last) {
		state.tokens += now.Sub(state.last).Seconds() * l.rate
		if state.tokens > l.burst {
			state.tokens = l.burst
		}
		state.last = now
	}
	state.lastSeen = now
	allowed := state.tokens >= 1
	if allowed {
		state.tokens--
	}
	l.buckets[key] = state
	return allowed
}
