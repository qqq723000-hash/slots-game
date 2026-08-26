package rgs

import (
	"context"
	"errors"
	"testing"
	"time"

	"slots-game/server/internal/game"
)

func TestHighValueRiskPolicyIsExplicitAndDeterministic(t *testing.T) {
	now := time.Date(2026, 8, 25, 1, 2, 3, 0, time.UTC)
	policy := HighValueRiskPolicy{
		Enabled: true, ThresholdMinor: 10_000, PolicyVersion: "payout-v1",
		ReviewTTL: 30 * time.Minute, ExpiryPolicy: RiskExpiryReject,
	}
	result := SpinResult{
		OperatorID: "operator-a", SessionID: "session-a", RoundID: "round-a",
		GameID: "game-a", DefinitionVersion: "definition-v1",
		DefinitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Currency:       "EUR", RoundKind: RoundKindBase, ServerTransactionID: "transaction-a",
		StartRevision: 0, Sequence: 1, BetMinor: 100, ChargedBetMinor: 100,
		TotalWinMinor: 10_000, Grid: game.Grid{{{Symbol: game.SymbolOrbit}}}, FeatureState: game.EmptyFeatureState(),
	}
	first, err := policy.Assess(result, now)
	if err != nil {
		t.Fatal(err)
	}
	second, err := policy.Assess(result, now)
	if err != nil {
		t.Fatal(err)
	}
	if first == nil || second == nil || first.SummaryHash != second.SummaryHash ||
		first.ExpiresAt != now.Add(30*time.Minute) || first.PayoutMinor != 10_000 {
		t.Fatalf("assessment mismatch: first=%+v second=%+v", first, second)
	}
	tampered := *first
	tampered.PayoutMinor++
	if _, err := RiskAssessmentSummaryHash(result, tampered); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("tampered assessment error = %v", err)
	}
	result.TotalWinMinor = 9_999
	assessment, err := policy.Assess(result, now)
	if err != nil || assessment != nil {
		t.Fatalf("below-threshold assessment = %+v, error=%v", assessment, err)
	}
}

func TestRiskDecisionReasonsAreFixedByDecision(t *testing.T) {
	base := RiskDecisionCommand{
		RoundKey:  RoundKey{OperatorID: "operator-a", SessionID: "session-a", RoundID: "round-a"},
		RequestID: "request-a", IdempotencyKey: "decision-a", CredentialKeyID: "key-a",
	}
	for _, test := range []struct {
		decision RiskDecision
		reason   string
		valid    bool
	}{
		{RiskDecisionApprove, RiskReasonApproved, true},
		{RiskDecisionApprove, RiskReasonFraudSuspected, false},
		{RiskDecisionReject, RiskReasonPolicyRejected, true},
		{RiskDecisionReject, RiskReasonFraudSuspected, true},
		{RiskDecisionReject, "ARBITRARY_REASON", false},
	} {
		command := base
		command.Decision, command.ReasonCode = test.decision, test.reason
		err := ValidateRiskDecisionCommand(command)
		if (err == nil) != test.valid {
			t.Fatalf("decision=%s reason=%s error=%v", test.decision, test.reason, err)
		}
	}
}

func TestHighValueRiskPolicyRejectsDormantOrIncompleteConfiguration(t *testing.T) {
	for _, policy := range []HighValueRiskPolicy{
		{ThresholdMinor: 1},
		{Enabled: true, ThresholdMinor: 1, PolicyVersion: "payout-v1", ReviewTTL: time.Minute},
		{Enabled: true, ThresholdMinor: 0, PolicyVersion: "payout-v1", ReviewTTL: time.Minute, ExpiryPolicy: RiskExpiryReject},
	} {
		if err := policy.Validate(); err == nil {
			t.Fatalf("policy %+v unexpectedly validated", policy)
		}
	}
}

type riskPendingTestRepository struct {
	*MemoryRepository
	claimCalls int
}

func (repository *riskPendingTestRepository) PrepareRound(
	ctx context.Context,
	request SpinRequest,
	fingerprint string,
	profile Profile,
	prepare PrepareOutcome,
) (RoundRecord, bool, error) {
	record, prepared, err := repository.MemoryRepository.PrepareRound(
		ctx, request, fingerprint, profile, prepare,
	)
	if err == nil {
		record.Status = RoundRiskPending
		record.WalletPhase = ""
		record.NextAttemptAt = time.Time{}
	}
	return record, prepared, err
}

func (repository *riskPendingTestRepository) ClaimWallet(
	context.Context,
	RoundKey,
	time.Duration,
) (WalletRecoveryClaim, bool, error) {
	repository.claimCalls++
	return WalletRecoveryClaim{}, false, errors.New("wallet claim must not run for risk pending")
}

func TestCoordinatorRiskPendingNeverClaimsOrCallsWalletAndBlocksNextSpin(t *testing.T) {
	repository := &riskPendingTestRepository{MemoryRepository: NewMemoryRepository()}
	createTestSession(t, repository.MemoryRepository, baseSession())
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return payableOutcome(game.EmptyFeatureState()), nil
	}}
	wallet := newTestWallet(10_000)
	coordinator := newTestCoordinator(t, repository, wallet, spinner, time.Second)
	request := baseRequest("round-risk", 100, 0)
	for attempt := 0; attempt < 2; attempt++ {
		if _, err := coordinator.Spin(context.Background(), request); !errors.Is(err, ErrRiskPending) {
			t.Fatalf("Spin attempt %d error = %v", attempt, err)
		}
	}
	if _, err := coordinator.Spin(context.Background(), baseRequest("round-next", 100, 0)); !errors.Is(err, ErrRoundPending) {
		t.Fatalf("next Spin error = %v", err)
	}
	if repository.claimCalls != 0 || wallet.applyCalls.Load() != 0 ||
		wallet.lookupCalls.Load() != 0 || spinner.calls.Load() != 1 {
		t.Fatalf("claim=%d apply=%d lookup=%d rng=%d",
			repository.claimCalls, wallet.applyCalls.Load(), wallet.lookupCalls.Load(), spinner.calls.Load())
	}
}
