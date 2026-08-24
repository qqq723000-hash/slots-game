package main

import (
	"context"
	"testing"

	"slots-game/server/internal/platform"
	"slots-game/server/internal/rgsapi"
)

func TestCryptographicCapacityUsesSingleAnonymousPoolAndNeverQueues(t *testing.T) {
	metrics := &platform.Metrics{}
	capacity := newServerCryptographicCapacity(1, metrics)

	releaseFirst, first := capacity.TryAcquire(context.Background())
	if first.Decision != rgsapi.AdmissionAllowed || releaseFirst == nil {
		t.Fatalf("first anonymous decision = %+v", first)
	}
	if release, result := capacity.TryAcquire(context.Background()); result.Decision != rgsapi.AdmissionCapacityUnavailable || release != nil {
		t.Fatalf("second anonymous request exceeded crypto capacity: %+v", result)
	}
	if metrics.CryptographicCapacityRejected.Load() != 1 {
		t.Fatalf("crypto rejection metrics = total:%d", metrics.CryptographicCapacityRejected.Load())
	}

	releaseFirst()
	releaseFirst()
	if release, result := capacity.TryAcquire(context.Background()); result.Decision != rgsapi.AdmissionAllowed || release == nil {
		t.Fatalf("released anonymous permit was not reusable: %+v", result)
	} else {
		release()
	}
}
