package platform

import (
	"testing"
	"time"
)

func TestLimiterRefillsAndBoundsKeys(t *testing.T) {
	limiter := NewLimiter(2, 2, 2, time.Minute)
	now := time.Unix(1_000, 0)
	if !limiter.Allow("a", now) || !limiter.Allow("a", now) || limiter.Allow("a", now) {
		t.Fatal("burst accounting is incorrect")
	}
	if !limiter.Allow("a", now.Add(500*time.Millisecond)) {
		t.Fatal("token did not refill")
	}
	if !limiter.Allow("b", now) || limiter.Allow("c", now) {
		t.Fatal("key bound was not enforced")
	}
	if !limiter.Allow("c", now.Add(2*time.Minute)) {
		t.Fatal("idle keys were not evicted")
	}
}

func TestLimiterIncrementallyCleansRotatingKeysWithoutEvictingActiveKey(t *testing.T) {
	const keys = 1_000
	limiter := NewLimiter(10, 10, keys, time.Minute)
	now := time.Unix(1_000, 0)
	for index := 0; index < keys; index++ {
		if !limiter.Allow(string(rune(index+1)), now) {
			t.Fatalf("key %d unexpectedly rejected", index)
		}
	}
	if limiter.Allow("new-before-expiry", now.Add(30*time.Second)) {
		t.Fatal("rotating keys bypassed the hard key bound")
	}
	if !limiter.Allow("new-after-expiry", now.Add(2*time.Minute)) {
		t.Fatal("incremental cleanup did not make bounded progress")
	}
	if len(limiter.buckets) >= keys {
		t.Fatalf("expired key cleanup made no bounded progress: %d", len(limiter.buckets))
	}
}
