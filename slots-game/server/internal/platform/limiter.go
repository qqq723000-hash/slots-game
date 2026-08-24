package platform

import (
	"container/list"
	"sync"
	"time"
)

type bucket struct {
	tokens   float64
	last     time.Time
	lastSeen time.Time
	key      string
	element  *list.Element
}

// Limiter 是有界的进程内准入限制器。生产还必须在入口网关实施全局限制；即使上游
// 策略误配，本限制器仍保护每个进程，但不能冒充跨副本限流。
type Limiter struct {
	mu         sync.Mutex
	rate       float64
	burst      float64
	maxKeys    int
	idleExpiry time.Duration
	buckets    map[string]*bucket
	idleOrder  list.List
}

func NewLimiter(rate float64, burst, maxKeys int, idleExpiry time.Duration) *Limiter {
	return &Limiter{
		rate: rate, burst: float64(burst), maxKeys: maxKeys,
		idleExpiry: idleExpiry, buckets: make(map[string]*bucket),
	}
}

func (l *Limiter) Allow(key string, now time.Time) bool {
	if l == nil || key == "" || l.rate <= 0 || l.burst < 1 || l.maxKeys < 1 || l.idleExpiry <= 0 {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	// LRU 顺序让清理只检查最老键；单次最多回收固定数量，避免 100k 会话桶
	// 在同一 mutex 临界区产生 O(n) 停顿。过期键会在后续请求中渐进回收。
	l.cleanupExpired(now, 64)
	state, exists := l.buckets[key]
	if !exists {
		if len(l.buckets) >= l.maxKeys {
			return false
		}
		state = &bucket{tokens: l.burst, last: now, key: key}
		state.element = l.idleOrder.PushBack(state)
		l.buckets[key] = state
	} else {
		l.idleOrder.MoveToBack(state.element)
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
	return allowed
}

func (l *Limiter) cleanupExpired(now time.Time, budget int) {
	for budget > 0 {
		oldest := l.idleOrder.Front()
		if oldest == nil {
			return
		}
		state, ok := oldest.Value.(*bucket)
		if !ok || state == nil {
			l.idleOrder.Remove(oldest)
			budget--
			continue
		}
		if now.Sub(state.lastSeen) < l.idleExpiry {
			return
		}
		delete(l.buckets, state.key)
		l.idleOrder.Remove(oldest)
		budget--
	}
}
