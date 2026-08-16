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
