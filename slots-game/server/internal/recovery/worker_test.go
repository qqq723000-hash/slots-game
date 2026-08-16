package recovery

import (
	"context"
	"sync"
	"testing"
	"time"

	"slots-game/server/internal/platform"
	"slots-game/server/internal/rgs"
)

type recoveryRepositoryStub struct {
	keys []rgs.RoundKey
}

func (s recoveryRepositoryStub) ListRecoverableRounds(
	context.Context,
	time.Time,
	int,
) ([]rgs.RoundKey, error) {
	return append([]rgs.RoundKey(nil), s.keys...), nil
}

type resolverStub struct {
	mu       sync.Mutex
	active   int
	max      int
	resolved map[rgs.RoundKey]int
}

func (s *resolverStub) Reconcile(ctx context.Context, key rgs.RoundKey) (rgs.SpinResult, error) {
	s.mu.Lock()
	s.active++
	if s.active > s.max {
		s.max = s.active
	}
	s.resolved[key]++
	s.mu.Unlock()
	select {
	case <-ctx.Done():
		return rgs.SpinResult{}, ctx.Err()
	case <-time.After(10 * time.Millisecond):
	}
	s.mu.Lock()
	s.active--
	s.mu.Unlock()
	return rgs.SpinResult{}, rgs.ErrWalletPending
}

func TestWorkerBoundsParallelRecoveryAndTreatsPendingAsExpected(t *testing.T) {
	keys := make([]rgs.RoundKey, 20)
	for index := range keys {
		keys[index] = rgs.RoundKey{
			OperatorID: "operator", SessionID: "session",
			RoundID: "round-" + string(rune('a'+index)),
		}
	}
	resolver := &resolverStub{resolved: make(map[rgs.RoundKey]int)}
	metrics := &platform.Metrics{}
	worker, err := New(Config{
		Interval: time.Second, AttemptTimeout: time.Second,
		BatchSize: 100, MaxParallel: 3,
	}, recoveryRepositoryStub{keys: keys}, resolver, nil, metrics)
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	resolver.mu.Lock()
	defer resolver.mu.Unlock()
	if resolver.max > 3 || len(resolver.resolved) != len(keys) {
		t.Fatalf("max=%d resolved=%d", resolver.max, len(resolver.resolved))
	}
	if metrics.Reconciliations.Load() != uint64(len(keys)) {
		t.Fatalf("reconciliations=%d", metrics.Reconciliations.Load())
	}
}

func TestWorkerValidatesConfiguration(t *testing.T) {
	_, err := New(
		Config{Interval: time.Nanosecond},
		recoveryRepositoryStub{},
		&resolverStub{resolved: make(map[rgs.RoundKey]int)},
		nil,
		nil,
	)
	if err == nil {
		t.Fatal("unsafe interval unexpectedly accepted")
	}
}
