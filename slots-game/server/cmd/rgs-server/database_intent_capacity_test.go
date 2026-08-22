package main

import (
	"context"
	"database/sql"
	"sync"
	"testing"

	"slots-game/server/internal/platform"
	"slots-game/server/internal/rgsapi"
)

type fixedDatabaseStats struct {
	mu    sync.RWMutex
	stats sql.DBStats
}

func (pool *fixedDatabaseStats) Stats() sql.DBStats {
	pool.mu.RLock()
	defer pool.mu.RUnlock()
	return pool.stats
}

func (pool *fixedDatabaseStats) setInUse(inUse int) {
	pool.mu.Lock()
	pool.stats.InUse = inUse
	pool.mu.Unlock()
}

func TestDatabaseIntentCapacityPreservesCriticalConnectionReserve(t *testing.T) {
	pool := &fixedDatabaseStats{stats: sql.DBStats{MaxOpenConnections: 20, InUse: 14}}
	metrics := &platform.Metrics{}
	capacity, err := newDatabaseIntentCapacity(pool, 20, 5, metrics)
	if err != nil {
		t.Fatal(err)
	}
	release, result := capacity.TryAcquire(context.Background())
	if result.Decision != rgsapi.AdmissionAllowed || release == nil {
		t.Fatalf("below-threshold acquire = %+v release=%v", result, release != nil)
	}
	release()
	release()

	pool.setInUse(15)
	if release, result = capacity.TryAcquire(context.Background()); result.Decision != rgsapi.AdmissionCapacityUnavailable || release != nil {
		t.Fatalf("threshold acquire = %+v release=%v", result, release != nil)
	}
	if metrics.NewIntentCapacityRejected.Load() != 1 {
		t.Fatalf("new-intent rejection metric = %d", metrics.NewIntentCapacityRejected.Load())
	}
}

func TestDatabaseIntentCapacityRejectsConcurrentOverflowWithoutQueueing(t *testing.T) {
	pool := &fixedDatabaseStats{stats: sql.DBStats{MaxOpenConnections: 4}}
	metrics := &platform.Metrics{}
	capacity, err := newDatabaseIntentCapacity(pool, 4, 2, metrics)
	if err != nil {
		t.Fatal(err)
	}
	first, firstResult := capacity.TryAcquire(context.Background())
	second, secondResult := capacity.TryAcquire(context.Background())
	if firstResult.Decision != rgsapi.AdmissionAllowed || secondResult.Decision != rgsapi.AdmissionAllowed {
		t.Fatalf("initial permits = %+v %+v", firstResult, secondResult)
	}
	if release, result := capacity.TryAcquire(context.Background()); result.Decision != rgsapi.AdmissionCapacityUnavailable || release != nil {
		t.Fatalf("overflow acquire = %+v release=%v", result, release != nil)
	}
	first()
	if release, result := capacity.TryAcquire(context.Background()); result.Decision != rgsapi.AdmissionAllowed || release == nil {
		t.Fatalf("permit was not returned = %+v release=%v", result, release != nil)
	} else {
		release()
	}
	second()
	if metrics.NewIntentCapacityRejected.Load() != 1 {
		t.Fatalf("new-intent rejection metric = %d", metrics.NewIntentCapacityRejected.Load())
	}
}

func TestDatabaseIntentCapacityCountsOutstandingReservationsAgainstPoolUsage(t *testing.T) {
	pool := &fixedDatabaseStats{stats: sql.DBStats{MaxOpenConnections: 20, InUse: 14}}
	metrics := &platform.Metrics{}
	capacity, err := newDatabaseIntentCapacity(pool, 20, 5, metrics)
	if err != nil {
		t.Fatal(err)
	}

	const workers = 32
	start := make(chan struct{})
	results := make(chan rgsapi.AdmissionResult, workers)
	releases := make(chan func(), workers)
	var group sync.WaitGroup
	for range workers {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			release, result := capacity.TryAcquire(context.Background())
			results <- result
			if release != nil {
				releases <- release
			}
		}()
	}
	close(start)
	group.Wait()
	close(results)
	close(releases)

	allowed := 0
	for result := range results {
		switch result.Decision {
		case rgsapi.AdmissionAllowed:
			allowed++
		case rgsapi.AdmissionCapacityUnavailable:
		default:
			t.Fatalf("unexpected admission decision: %v", result.Decision)
		}
	}
	for release := range releases {
		release()
	}
	if allowed != 1 {
		t.Fatalf("allowed=%d, want exactly one reservation below threshold", allowed)
	}
	if rejected := metrics.NewIntentCapacityRejected.Load(); rejected != workers-1 {
		t.Fatalf("new-intent rejections=%d, want %d", rejected, workers-1)
	}
}

func TestDatabaseIntentCapacityRejectsInvalidConfigurationAndCancelledCalls(t *testing.T) {
	pool := &fixedDatabaseStats{}
	for _, values := range [][2]int{{1, 1}, {20, 0}, {20, 20}, {20, 21}} {
		if capacity, err := newDatabaseIntentCapacity(pool, values[0], values[1], nil); err == nil || capacity != nil {
			t.Fatalf("invalid capacity max=%d reserve=%d was accepted", values[0], values[1])
		}
	}
	capacity, err := newDatabaseIntentCapacity(pool, 20, 5, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if release, result := capacity.TryAcquire(ctx); result.Decision != rgsapi.AdmissionCapacityUnavailable || release != nil {
		t.Fatalf("cancelled acquire = %+v release=%v", result, release != nil)
	}
}
