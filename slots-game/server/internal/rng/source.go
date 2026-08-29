// rng 包包含供权威游戏引擎使用的可互换随机源。生产环境使用 CryptoSource，
// 测试可注入 SequenceSource。
// English: The rng package contains interchangeable random sources for use by authoritative game engines. The
// production environment uses CryptoSource, and testing can inject SequenceSource.
package rng

import (
	cryptorand "crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync"
)

// Source 返回区间 [0, n) 内的无偏整数。
// English: Source returns an unbiased integer in the interval [0, n).
type Source interface {
	Intn(n int) (int, error)
}

// CryptoSource 使用 crypto/rand 及拒绝采样。导出 Reader 是为了便于测试拒绝行为；
// 生产环境应使用 NewCryptoSource。
// English: CryptoSource uses crypto/rand and rejects sampling. Reader is exported to facilitate testing of
// rejection behavior; production environments should use NewCryptoSource.
type CryptoSource struct {
	Reader io.Reader
}

func NewCryptoSource() *CryptoSource {
	return &CryptoSource{Reader: cryptorand.Reader}
}

func (s *CryptoSource) Intn(n int) (int, error) {
	if n <= 0 {
		return 0, fmt.Errorf("rng: n must be positive: %d", n)
	}
	if s == nil || s.Reader == nil {
		return 0, errors.New("rng: crypto source has no reader")
	}

	bound := uint64(n)
	// 该值等于 2^64 对 bound 取模。拒绝低于阈值的数值后，剩余可能值数量恰好是 bound 的
	// 整数倍，因此不会产生取模偏差。
	// English: This value is equal to 2^64 modulo bound. After rejecting values below the threshold, the number of
	// remaining possible values is exactly an integer multiple of bound, so there is no modulo bias.
	threshold := -bound % bound
	var raw [8]byte
	for {
		if _, err := io.ReadFull(s.Reader, raw[:]); err != nil {
			return 0, fmt.Errorf("rng: read entropy: %w", err)
		}
		value := binary.BigEndian.Uint64(raw[:])
		if value >= threshold {
			return int(value % bound), nil
		}
	}
}

// SequenceSource 是确定性且并发安全的测试随机源。数值会对 n 取模；序列耗尽即报错，
// 防止测试静默使用非预期熵源。
// English: SequenceSource is a deterministic and concurrency-safe source of randomness for testing. The value is
// modulo n; an error is reported when the sequence is exhausted, preventing the test from silently using
// unintended entropy sources.
type SequenceSource struct {
	mu     sync.Mutex
	values []uint64
	index  int
}

func NewSequenceSource(values ...uint64) *SequenceSource {
	copyValues := append([]uint64(nil), values...)
	return &SequenceSource{values: copyValues}
}

func (s *SequenceSource) Intn(n int) (int, error) {
	if n <= 0 {
		return 0, fmt.Errorf("rng: n must be positive: %d", n)
	}
	if s == nil {
		return 0, errors.New("rng: nil sequence source")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.index >= len(s.values) {
		return 0, errors.New("rng: deterministic sequence exhausted")
	}
	value := s.values[s.index]
	s.index++
	return int(value % uint64(n)), nil
}

func (s *SequenceSource) Consumed() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.index
}
