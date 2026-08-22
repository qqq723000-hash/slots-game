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
	mu          sync.Mutex
	claims      []rgs.WalletRecoveryClaim
	claimLimits []int
	scheduled   []scheduledRecovery
}

type scheduledRecovery struct {
	claim       rgs.WalletRecoveryClaim
	disposition rgs.WalletRecoveryDisposition
	delay       time.Duration
}

func (s *recoveryRepositoryStub) ClaimRecoverableRounds(
	_ context.Context,
	limit int,
	_ time.Duration,
) ([]rgs.WalletRecoveryClaim, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.claimLimits = append(s.claimLimits, limit)
	if len(s.claims) == 0 {
		return nil, nil
	}
	if limit > len(s.claims) {
		limit = len(s.claims)
	}
	claims := append([]rgs.WalletRecoveryClaim(nil), s.claims[:limit]...)
	s.claims = s.claims[limit:]
	return claims, nil
}

func (s *recoveryRepositoryStub) ScheduleWalletRecovery(
	_ context.Context,
	claim rgs.WalletRecoveryClaim,
	disposition rgs.WalletRecoveryDisposition,
	delay time.Duration,
) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.scheduled = append(s.scheduled, scheduledRecovery{
		claim: claim, disposition: disposition, delay: delay,
	})
	return true, nil
}

type resolverStub struct {
	mu       sync.Mutex
	active   int
	max      int
	resolved map[rgs.RoundKey]int
	terminal bool
}

func (s *resolverStub) ReconcileClaim(
	ctx context.Context,
	claim rgs.WalletRecoveryClaim,
) (rgs.SpinResult, rgs.WalletRecoveryDisposition, error) {
	s.mu.Lock()
	s.active++
	if s.active > s.max {
		s.max = s.active
	}
	s.resolved[claim.Record.Key]++
	s.mu.Unlock()
	select {
	case <-ctx.Done():
		return rgs.SpinResult{}, rgs.WalletRecoveryDisposition{}, ctx.Err()
	case <-time.After(10 * time.Millisecond):
	}
	s.mu.Lock()
	s.active--
	s.mu.Unlock()
	if s.terminal {
		return rgs.SpinResult{}, rgs.WalletRecoveryDisposition{Terminal: true}, rgs.ErrRoundRejected
	}
	return rgs.SpinResult{}, rgs.WalletRecoveryDisposition{
		NextAction: rgs.WalletRecoveryLookup,
	}, rgs.ErrWalletPending
}

func recoveryClaims(count int) []rgs.WalletRecoveryClaim {
	claims := make([]rgs.WalletRecoveryClaim, count)
	for index := range claims {
		claims[index] = rgs.WalletRecoveryClaim{
			Record: rgs.RoundRecord{
				Key: rgs.RoundKey{
					OperatorID: "operator", SessionID: "session",
					RoundID: "round-" + string(rune('a'+index)),
				},
				WalletLookupAttempts: 1,
			},
			Action: rgs.WalletRecoveryLookup, LeaseUntil: time.Now().Add(time.Minute),
		}
	}
	return claims
}

func TestWorkerClaimsOnlyExecutableWaveAndBoundsParallelRecovery(t *testing.T) {
	repository := &recoveryRepositoryStub{claims: recoveryClaims(20)}
	resolver := &resolverStub{resolved: make(map[rgs.RoundKey]int)}
	metrics := &platform.Metrics{}
	worker, err := New(Config{
		Interval: time.Second, AttemptTimeout: time.Second, LeaseDuration: 2 * time.Second,
		InitialBackoff: time.Millisecond, MaximumBackoff: time.Second,
		BatchSize: 100, MaxParallel: 3,
		FullJitter: func(time.Duration) time.Duration { return 0 },
	}, repository, resolver, nil, metrics)
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	resolver.mu.Lock()
	defer resolver.mu.Unlock()
	if resolver.max > 3 || len(resolver.resolved) != 20 {
		t.Fatalf("max=%d resolved=%d", resolver.max, len(resolver.resolved))
	}
	if metrics.Reconciliations.Load() != 20 {
		t.Fatalf("reconciliations=%d", metrics.Reconciliations.Load())
	}
	repository.mu.Lock()
	defer repository.mu.Unlock()
	if len(repository.scheduled) != 20 {
		t.Fatalf("scheduled=%d", len(repository.scheduled))
	}
	for _, limit := range repository.claimLimits {
		if limit > 3 {
			t.Fatalf("claim limit=%d exceeds immediately executable slots", limit)
		}
	}
}

func TestWorkerUsesCappedPerActionFullJitter(t *testing.T) {
	claims := recoveryClaims(3)
	claims[0].Record.WalletLookupAttempts = 1
	claims[1].Record.WalletLookupAttempts = 3
	claims[2].Record.WalletLookupAttempts = 30
	repository := &recoveryRepositoryStub{claims: claims}
	resolver := &resolverStub{resolved: make(map[rgs.RoundKey]int)}
	var jitterMu sync.Mutex
	var upperBounds []time.Duration
	worker, err := New(Config{
		Interval: time.Second, AttemptTimeout: time.Second, LeaseDuration: 2 * time.Second,
		InitialBackoff: 10 * time.Millisecond, MaximumBackoff: 25 * time.Millisecond,
		BatchSize: 3, MaxParallel: 3,
		FullJitter: func(upperBound time.Duration) time.Duration {
			jitterMu.Lock()
			upperBounds = append(upperBounds, upperBound)
			jitterMu.Unlock()
			return upperBound
		},
	}, repository, resolver, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	jitterMu.Lock()
	defer jitterMu.Unlock()
	seen := make(map[time.Duration]int)
	for _, upperBound := range upperBounds {
		seen[upperBound]++
	}
	if seen[10*time.Millisecond] != 1 || seen[25*time.Millisecond] != 2 {
		t.Fatalf("upper bounds=%v", upperBounds)
	}
}

func TestWorkerUsesPersistentSchedulerPressureForNotSentApplyBackoff(t *testing.T) {
	worker := &Worker{config: Config{
		InitialBackoff: 10 * time.Millisecond,
		MaximumBackoff: time.Second,
	}}
	record := rgs.RoundRecord{WalletApplyAttempts: 0, RetryCount: 4}
	if got := worker.backoffUpperBound(record, rgs.WalletRecoveryApply); got != 80*time.Millisecond {
		t.Fatalf("NOT_SENT APPLY backoff = %s, want 80ms", got)
	}
}

func TestWorkerDoesNotScheduleTerminalDisposition(t *testing.T) {
	repository := &recoveryRepositoryStub{claims: recoveryClaims(1)}
	resolver := &resolverStub{resolved: make(map[rgs.RoundKey]int), terminal: true}
	worker, err := New(Config{
		Interval: time.Second, AttemptTimeout: time.Second, LeaseDuration: 2 * time.Second,
		BatchSize: 1, MaxParallel: 1,
	}, repository, resolver, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(repository.scheduled) != 0 {
		t.Fatalf("terminal recovery scheduled %d retries", len(repository.scheduled))
	}
}

func TestWorkerValidatesConfiguration(t *testing.T) {
	_, err := New(
		Config{Interval: time.Nanosecond},
		&recoveryRepositoryStub{},
		&resolverStub{resolved: make(map[rgs.RoundKey]int)},
		nil,
		nil,
	)
	if err == nil {
		t.Fatal("unsafe interval unexpectedly accepted")
	}
}
