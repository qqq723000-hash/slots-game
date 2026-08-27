package rgsapi

import (
	"strings"
	"testing"
	"time"

	"slots-game/server/internal/launch"
	"slots-game/server/internal/rgs"
)

func TestValidateLaunchResultAllowsOnlyBoundedHistoricalReplay(t *testing.T) {
	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	base := LaunchResult{
		LaunchCode:  launch.CodePrefix + strings.Repeat("A", 43),
		ExchangeURL: "https://rgs.example" + ClientSessionExchangePath,
		ExpiresAt:   now.Add(time.Minute),
		ValidatedAt: now,
	}
	if err := validateLaunchResult(base, operatorLaunchRequest{}); err != nil {
		t.Fatalf("new result rejected: %v", err)
	}

	expired := base
	expired.ExpiresAt = now.Add(-time.Second)
	if err := validateLaunchResult(expired, operatorLaunchRequest{}); err == nil {
		t.Fatal("newly issued expired result unexpectedly accepted")
	}
	expired.HistoricalReplay = true
	if err := validateLaunchResult(expired, operatorLaunchRequest{}); err != nil {
		t.Fatalf("retained historical replay rejected: %v", err)
	}

	tooOld := expired
	tooOld.ExpiresAt = now.Add(-launch.IdempotencyRetention)
	if err := validateLaunchResult(tooOld, operatorLaunchRequest{}); err == nil {
		t.Fatal("historical replay outside retention unexpectedly accepted")
	}

	missingAuthority := base
	missingAuthority.ValidatedAt = time.Time{}
	if err := validateLaunchResult(missingAuthority, operatorLaunchRequest{}); err == nil {
		t.Fatal("launch result without authority time unexpectedly accepted")
	}
}

func TestSpinResultMatchesRejectsInvalidCommittedTransition(t *testing.T) {
	request := validSpinRequest()
	valid := committedResult(request)
	if !spinResultMatches(valid, request) {
		t.Fatal("valid committed transition rejected")
	}

	for _, test := range []struct {
		name   string
		mutate func(*rgs.SpinResult)
	}{
		{name: "revision does not advance", mutate: func(result *rgs.SpinResult) {
			result.EndRevision = result.StartRevision
		}},
		{name: "zero sequence", mutate: func(result *rgs.SpinResult) {
			result.Sequence = 0
		}},
		{name: "incorrect base charge", mutate: func(result *rgs.SpinResult) {
			result.ChargedBetMinor = 0
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			result := valid
			test.mutate(&result)
			if spinResultMatches(result, request) {
				t.Fatalf("invalid committed transition accepted: %+v", result)
			}
		})
	}

	freeSpinRequest := request
	freeSpinRequest.RoundKind = rgs.RoundKindFreeSpin
	freeSpin := committedResult(freeSpinRequest)
	freeSpin.ChargedBetMinor = 0
	if !spinResultMatches(freeSpin, freeSpinRequest) {
		t.Fatal("valid free-spin committed transition rejected")
	}
	freeSpin.ChargedBetMinor = freeSpin.BetMinor
	if spinResultMatches(freeSpin, freeSpinRequest) {
		t.Fatal("charged free-spin committed transition accepted")
	}
}
