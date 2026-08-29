package launch

import (
	"context"
	"crypto/subtle"
	"sync"
	"time"
)

type memoryRecord struct {
	record     Record
	consumedAt time.Time
}

// MemoryStore 不存在数据竞争，但仅限当前进程使用。它用于测试和开发；生产副本必须使用
// 共享的事务型 Store。
// English: There is no data race in MemoryStore, but it is only used by the current process. It is used for
// testing and development; production copies must use a shared transactional store.
type MemoryStore struct {
	mu      sync.Mutex
	records map[CodeDigest]memoryRecord
	now     func() time.Time
}

func NewMemoryStore() *MemoryStore {
	return newMemoryStore(time.Now)
}

func newMemoryStore(now func() time.Time) *MemoryStore {
	return &MemoryStore{records: make(map[CodeDigest]memoryRecord), now: now}
}

func (s *MemoryStore) Create(ctx context.Context, request CreateRequest) (Record, error) {
	if err := ctx.Err(); err != nil {
		return Record{}, err
	}
	if err := validateCreateRequest(request); err != nil {
		return Record{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return Record{}, err
	}
	// 创建时间、到期时间、清理和冲突裁决共享锁内唯一一次权威时钟观测。
	// Creation time, expiry time, cleanup, and conflict resolution share one authoritative clock observation under the lock.
	now := s.now().UTC()
	s.purgeIdempotencyExpiredLocked(now)
	if _, exists := s.records[request.Digest]; exists {
		return Record{}, ErrDigestExists
	}
	record := Record{
		Digest:    request.Digest,
		Claims:    request.Claims,
		CreatedAt: now,
		ExpiresAt: now.Add(request.TTL),
	}
	if err := validateRecord(record); err != nil {
		return Record{}, ErrStoreInvariant
	}
	s.records[record.Digest] = memoryRecord{record: record}
	return record, nil
}

func (s *MemoryStore) Consume(ctx context.Context, request ConsumeRequest) (Record, error) {
	if err := ctx.Err(); err != nil {
		return Record{}, err
	}
	if err := validateBinding(request.Binding); err != nil {
		return Record{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return Record{}, err
	}

	now := s.now().UTC()
	s.purgeIdempotencyExpiredLocked(now)
	stored, exists := s.records[request.Digest]
	if !exists || !stored.consumedAt.IsZero() || !stored.record.ExpiresAt.After(now) ||
		subtle.ConstantTimeCompare([]byte(stored.record.Claims.OperatorID), []byte(request.Binding.OperatorID)) != 1 ||
		subtle.ConstantTimeCompare([]byte(stored.record.Claims.SessionID), []byte(request.Binding.SessionID)) != 1 {
		return Record{}, ErrCodeUnavailable
	}
	stored.consumedAt = now
	s.records[request.Digest] = stored
	return stored.record, nil
}

func (s *MemoryStore) Get(ctx context.Context, digest CodeDigest) (ReplayObservation, error) {
	if err := ctx.Err(); err != nil {
		return ReplayObservation{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return ReplayObservation{}, err
	}
	// 读取、清理和返回给 Service 的时间必须来自锁内同一次存储时钟观测。
	// English: The times read, cleaned, and returned to the Service must come from the same storage clock observation
	// within the lock.
	now := s.now().UTC()
	s.purgeIdempotencyExpiredLocked(now)
	stored, exists := s.records[digest]
	if !exists {
		return ReplayObservation{}, ErrCodeUnavailable
	}
	return ReplayObservation{Record: stored.record, ObservedAt: now}, nil
}

func (s *MemoryStore) purgeIdempotencyExpiredLocked(now time.Time) {
	for digest, record := range s.records {
		if !idempotencyRetained(record.record, now) {
			delete(s.records, digest)
		}
	}
}

var _ Store = (*MemoryStore)(nil)
var _ ReplayStore = (*MemoryStore)(nil)
