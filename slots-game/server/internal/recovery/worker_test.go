package recovery

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"slots-game/server/internal/platform"
	"slots-game/server/internal/rgs"
)

type recoveryRepositoryStub struct {
	mu            sync.Mutex
	claims        []rgs.WalletRecoveryClaim
	claimLimits   []int
	scheduled     []scheduledRecovery
	snapshot      rgs.RecoverySnapshot
	claimErr      error
	snapshotErr   error
	snapshotCalls int
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
	if s.claimErr != nil {
		return nil, s.claimErr
	}
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

func (s *recoveryRepositoryStub) RecoverySnapshot(
	_ context.Context,
) (rgs.RecoverySnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snapshotCalls++
	return s.snapshot, s.snapshotErr
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

func zeroInitialObservationJitter(time.Duration) time.Duration { return 0 }

func TestWorkerClaimsOnlyExecutableWaveAndBoundsParallelRecovery(t *testing.T) {
	repository := &recoveryRepositoryStub{
		claims: recoveryClaims(20),
		snapshot: rgs.RecoverySnapshot{
			ObservedAt: time.Unix(1_700_000_000, 0).UTC(),
		},
	}
	resolver := &resolverStub{resolved: make(map[rgs.RoundKey]int)}
	metrics := &platform.Metrics{}
	worker, err := New(Config{
		Interval: time.Second, AttemptTimeout: time.Second, LeaseDuration: 2 * time.Second,
		InitialBackoff: time.Millisecond, MaximumBackoff: time.Second,
		BatchSize: 100, MaxParallel: 3,
		FullJitter:               func(time.Duration) time.Duration { return 0 },
		InitialObservationJitter: zeroInitialObservationJitter,
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
	_, err = New(
		Config{InitialObservationJitter: func(window time.Duration) time.Duration { return window }},
		&recoveryRepositoryStub{},
		&resolverStub{resolved: make(map[rgs.RoundKey]int)},
		nil,
		nil,
	)
	if err == nil {
		t.Fatal("out-of-range initial observation jitter unexpectedly accepted")
	}
}

func TestWorkerPublishesBacklogAndFreshnessOnlyAfterSuccessfulPass(t *testing.T) {
	fixedNow := time.Unix(1_700_000_123, 0).UTC()
	repository := &recoveryRepositoryStub{snapshot: rgs.RecoverySnapshot{
		Backlog: 9, OldestDueAge: 4250 * time.Millisecond,
		ObservedAt: time.Unix(1_700_000_120, 0).UTC(),
	}}
	metrics := &platform.Metrics{}
	worker, err := New(Config{
		Interval: time.Second, AttemptTimeout: time.Second, LeaseDuration: 2 * time.Second,
		BatchSize: 1, MaxParallel: 1, Now: func() time.Time { return fixedNow },
		InitialObservationJitter: zeroInitialObservationJitter,
	}, repository, &resolverStub{resolved: make(map[rgs.RoundKey]int)}, nil, metrics)
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if repository.snapshotCalls != 1 {
		t.Fatalf("snapshot calls=%d, want one bounded observation across two passes", repository.snapshotCalls)
	}

	var output bytes.Buffer
	if err := metrics.WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		"rgs_recovery_backlog 9",
		"rgs_recovery_oldest_due_age_seconds 4.250000000",
		"rgs_recovery_snapshot_last_success_timestamp_seconds 1700000120",
		"rgs_recovery_snapshot_failures_total 0",
		"rgs_recovery_loop_last_success_timestamp_seconds 1700000123",
		"rgs_recovery_loop_failures_total 0",
	} {
		if !strings.Contains(output.String(), expected) {
			t.Fatalf("missing %q:\n%s", expected, output.String())
		}
	}
}

func TestWorkerDoesNotPublishFreshnessWhenRecoveryPassFails(t *testing.T) {
	repository := &recoveryRepositoryStub{claimErr: errors.New("database unavailable")}
	metrics := &platform.Metrics{}
	worker, err := New(Config{
		Interval: time.Second, AttemptTimeout: time.Second, LeaseDuration: 2 * time.Second,
		BatchSize: 1, MaxParallel: 1,
	}, repository, &resolverStub{resolved: make(map[rgs.RoundKey]int)}, nil, metrics)
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.RunOnce(context.Background()); err == nil {
		t.Fatal("failed recovery pass returned nil")
	}
	if repository.snapshotCalls != 0 {
		t.Fatalf("failed pass queried snapshot %d times", repository.snapshotCalls)
	}

	var output bytes.Buffer
	if err := metrics.WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "rgs_recovery_loop_last_success_timestamp_seconds 0") ||
		!strings.Contains(output.String(), "rgs_recovery_loop_failures_total 1") {
		t.Fatalf("failed pass was marked fresh or not counted:\n%s", output.String())
	}
}

func TestWorkerKeepsLoopFreshButRateLimitsFailedBacklogSnapshots(t *testing.T) {
	currentNow := time.Unix(1_700_000_000, 0).UTC()
	repository := &recoveryRepositoryStub{snapshotErr: errors.New("snapshot unavailable")}
	metrics := &platform.Metrics{}
	worker, err := New(Config{
		Interval: time.Second, AttemptTimeout: time.Second, LeaseDuration: 2 * time.Second,
		BatchSize: 1, MaxParallel: 1, Now: func() time.Time { return currentNow },
		InitialObservationJitter: zeroInitialObservationJitter,
	}, repository, &resolverStub{resolved: make(map[rgs.RoundKey]int)}, nil, metrics)
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatalf("snapshot telemetry failure changed recovery result: %v", err)
	}
	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatalf("bounded observation interval changed recovery result: %v", err)
	}
	if repository.snapshotCalls != 1 {
		t.Fatalf("failed snapshot was hot-looped: calls=%d", repository.snapshotCalls)
	}
	currentNow = currentNow.Add(16 * time.Second)
	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatalf("later snapshot telemetry failure changed recovery result: %v", err)
	}
	if repository.snapshotCalls != 2 {
		t.Fatalf("failed snapshot was not retried after observation interval: calls=%d", repository.snapshotCalls)
	}

	var output bytes.Buffer
	if err := metrics.WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "rgs_recovery_snapshot_failures_total 2") ||
		!strings.Contains(output.String(), "rgs_recovery_snapshot_last_success_timestamp_seconds 0") ||
		!strings.Contains(output.String(), "rgs_recovery_loop_failures_total 0") ||
		!strings.Contains(output.String(), "rgs_recovery_loop_last_success_timestamp_seconds 1700000016") {
		t.Fatalf("snapshot and loop freshness were conflated:\n%s", output.String())
	}
}

func TestWorkerJittersOnlyInitialBacklogObservationThenKeepsFixedPeriod(t *testing.T) {
	currentNow := time.Unix(1_700_000_000, 0).UTC()
	repository := &recoveryRepositoryStub{snapshot: rgs.RecoverySnapshot{ObservedAt: currentNow}}
	metrics := &platform.Metrics{}
	jitterCalls := 0
	worker, err := New(Config{
		Interval: time.Second, ObservationInterval: 15 * time.Second,
		AttemptTimeout: time.Second, LeaseDuration: 2 * time.Second,
		BatchSize: 1, MaxParallel: 1, Now: func() time.Time { return currentNow },
		InitialObservationJitter: func(window time.Duration) time.Duration {
			jitterCalls++
			if window != 15*time.Second {
				t.Fatalf("initial observation jitter window=%s", window)
			}
			return 7 * time.Second
		},
	}, repository, &resolverStub{resolved: make(map[rgs.RoundKey]int)}, nil, metrics)
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range []struct {
		advance time.Duration
		calls   int
	}{
		{calls: 0},
		{advance: 6 * time.Second, calls: 0},
		{advance: 2 * time.Second, calls: 1},
		{advance: 14 * time.Second, calls: 1},
		{advance: time.Second, calls: 2},
	} {
		currentNow = currentNow.Add(step.advance)
		if err := worker.RunOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
		if repository.snapshotCalls != step.calls {
			t.Fatalf("at %s snapshot calls=%d, want %d", currentNow, repository.snapshotCalls, step.calls)
		}
	}
	if jitterCalls != 1 {
		t.Fatalf("initial jitter calls=%d, want one", jitterCalls)
	}
}

func TestWorkerShutdownCancellationDoesNotCountAsLoopFailure(t *testing.T) {
	repository := &recoveryRepositoryStub{}
	metrics := &platform.Metrics{}
	worker, err := New(Config{
		Interval: time.Second, AttemptTimeout: time.Second, LeaseDuration: 2 * time.Second,
		BatchSize: 1, MaxParallel: 1,
	}, repository, &resolverStub{resolved: make(map[rgs.RoundKey]int)}, nil, metrics)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := worker.RunOnce(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled pass error=%v", err)
	}

	var output bytes.Buffer
	if err := metrics.WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "rgs_recovery_loop_failures_total 0") || repository.snapshotCalls != 0 {
		t.Fatalf("shutdown cancellation counted as failure or queried DB:\n%s", output.String())
	}
}
