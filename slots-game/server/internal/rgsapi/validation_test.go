package rgsapi

import (
	"strings"
	"testing"
	"time"

	"slots-game/server/internal/launch"
)

func TestValidateLaunchResultAllowsOnlyBoundedHistoricalReplay(t *testing.T) {
	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	base := LaunchResult{
		LaunchCode:  launch.CodePrefix + strings.Repeat("A", 43),
		ExchangeURL: "https://rgs.example" + ClientSessionExchangePath,
		ExpiresAt:   now.Add(time.Minute),
	}
	if err := validateLaunchResult(base, operatorLaunchRequest{}, now); err != nil {
		t.Fatalf("new result rejected: %v", err)
	}

	expired := base
	expired.ExpiresAt = now.Add(-time.Second)
	if err := validateLaunchResult(expired, operatorLaunchRequest{}, now); err == nil {
		t.Fatal("newly issued expired result unexpectedly accepted")
	}
	expired.HistoricalReplay = true
	if err := validateLaunchResult(expired, operatorLaunchRequest{}, now); err != nil {
		t.Fatalf("retained historical replay rejected: %v", err)
	}

	tooOld := expired
	tooOld.ExpiresAt = now.Add(-launch.IdempotencyRetention)
	if err := validateLaunchResult(tooOld, operatorLaunchRequest{}, now); err == nil {
		t.Fatal("historical replay outside retention unexpectedly accepted")
	}
}
