package recovery

import (
	"context"
	"errors"
	"testing"
	"time"

	"slots-game/server/internal/rgs"
)

func TestStartupReadinessWaitsForSuccessfulRecoveryPassAndNeverCloses(t *testing.T) {
	repository := &riskRecoveryRepositoryStub{
		recoveryRepositoryStub: &recoveryRepositoryStub{},
		riskErr:                errors.New("risk expiry unavailable"),
	}
	readiness := NewStartupReadiness()
	worker, err := New(Config{
		Interval: time.Second, AttemptTimeout: time.Second, LeaseDuration: 2 * time.Second,
		BatchSize: 1, MaxParallel: 1, RiskExpiryBatchSize: 1, StartupReadiness: readiness,
	}, repository, &resolverStub{resolved: make(map[rgs.RoundKey]int)}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if readiness.Name() != "recovery_startup" || readiness.Check(context.Background()) == nil {
		t.Fatal("recovery startup readiness was open before a successful recovery pass")
	}

	for attempt := 1; attempt <= 2; attempt++ {
		if err := worker.RunOnce(context.Background()); err == nil {
			t.Fatalf("failed recovery pass attempt %d returned nil", attempt)
		}
		if readiness.Check(context.Background()) == nil {
			t.Fatalf("failed recovery pass attempt %d opened recovery startup readiness", attempt)
		}
	}

	repository.riskErr = nil
	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatalf("successful no-work recovery pass: %v", err)
	}
	if err := readiness.Check(context.Background()); err != nil {
		t.Fatalf("successful no-work recovery pass did not open readiness: %v", err)
	}
	repository.mu.Lock()
	claimQueries := len(repository.claimLimits)
	repository.claimErr = errors.New("database unavailable again")
	repository.mu.Unlock()
	if claimQueries != 3 {
		t.Fatalf("recovery pass claim queries = %d, want 3", claimQueries)
	}

	if err := worker.RunOnce(context.Background()); err == nil {
		t.Fatal("later failed claim query returned nil")
	}
	if err := readiness.Check(context.Background()); err != nil {
		t.Fatalf("later loop failure closed permanent startup readiness: %v", err)
	}

	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := readiness.Check(canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled readiness check = %v", err)
	}
}
