package operator

import (
	"context"
	"sync"
	"time"
)

// NonceStore 在已验证密钥范围内原子消费随机数。返回假表示该随机数已被消费，
// 当前请求属于重放。生产实现必须由所有服务副本共享。
type NonceStore interface {
	Consume(context.Context, string, string, time.Time) (bool, error)
}

type MemoryNonceStore struct {
	mu      sync.Mutex
	expires map[string]time.Time
	now     func() time.Time
}

func NewMemoryNonceStore() *MemoryNonceStore {
	return newMemoryNonceStore(time.Now)
}

func newMemoryNonceStore(now func() time.Time) *MemoryNonceStore {
	return &MemoryNonceStore{expires: make(map[string]time.Time), now: now}
}

func (s *MemoryNonceStore) Consume(ctx context.Context, scope, nonce string, expiresAt time.Time) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	for key, expiry := range s.expires {
		if !expiry.After(now) {
			delete(s.expires, key)
		}
	}
	key := scope + "\x00" + nonce
	if expiry, exists := s.expires[key]; exists && expiry.After(now) {
		return false, nil
	}
	if !expiresAt.After(now) {
		return false, nil
	}
	s.expires[key] = expiresAt
	return true, nil
}
