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

func (s *MemoryStore) Create(ctx context.Context, record Record) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateRecord(record); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	s.purgeIdempotencyExpiredLocked(s.now())
	if _, exists := s.records[record.Digest]; exists {
		return ErrDigestExists
	}
	s.records[record.Digest] = memoryRecord{record: record}
	return nil
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

	now := s.now()
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

func (s *MemoryStore) Get(ctx context.Context, digest CodeDigest) (Record, error) {
	if err := ctx.Err(); err != nil {
		return Record{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return Record{}, err
	}
	now := s.now()
	s.purgeIdempotencyExpiredLocked(now)
	stored, exists := s.records[digest]
	if !exists {
		return Record{}, ErrCodeUnavailable
	}
	return stored.record, nil
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
