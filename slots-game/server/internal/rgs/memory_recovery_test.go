package rgs

import (
	"context"
	"errors"
	"testing"
	"time"

	"slots-game/server/internal/game"
)

func prepareMemoryRecoveryRound(
	t *testing.T,
	repository *MemoryRepository,
	operatorID, sessionID, roundID string,
) RoundRecord {
	return prepareMemoryRecoveryRoundWithProfile(
		t, repository, operatorID, sessionID, roundID,
		AtomicHTTPProfile(testWalletRouteBindingID()),
	)
}

func prepareMemoryRecoveryRoundWithProfile(
	t *testing.T,
	repository *MemoryRepository,
	operatorID, sessionID, roundID string,
	profile Profile,
) RoundRecord {
	t.Helper()
	session := baseSession()
	session.OperatorID = operatorID
	session.SessionID = sessionID
	session.PlayerID = "player-" + sessionID
	session.WalletAccountID = "wallet-" + sessionID
	session.WalletSessionID = "wallet-session-" + sessionID
	if err := repository.CreateSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	request := baseRequest(roundID, 100, 0)
	request.OperatorID = operatorID
	request.SessionID = sessionID
	outcome := payableOutcome(game.EmptyFeatureState())
	result := SpinResult{
		OperatorID: operatorID, SessionID: sessionID, RoundID: roundID,
		GameID: request.GameID, DefinitionVersion: request.DefinitionVersion,
		DefinitionHash: request.DefinitionHash, Currency: request.Currency,
		RoundKind: request.RoundKind, ServerTransactionID: walletOperationID(request),
		StartRevision: 0, Sequence: 1, BetMinor: request.BetMinor,
		ChargedBetMinor: request.BetMinor, TotalWinMinor: outcome.TotalWinMinor,
		Grid: outcome.Grid, Wins: outcome.Wins, Events: outcome.Events,
		FeatureState: outcome.NextFeature,
	}
	record, prepared, err := repository.PrepareRound(
		context.Background(), request, FingerprintFor(request),
		profile,
		func(Session) (SpinResult, error) { return result, nil },
	)
	if err != nil || !prepared {
		t.Fatalf("PrepareRound() = record:%+v prepared:%v error:%v", record, prepared, err)
	}
	return record
}

func TestMemoryClaimWalletPersistsLookupBeforeReturningApply(t *testing.T) {
	repository := NewMemoryRepository()
	record := prepareMemoryRecoveryRound(t, repository, "operator-a", "session-a", "round-a")
	claim, claimed, err := repository.ClaimWallet(
		context.Background(), record.Key, time.Minute,
	)
	if err != nil || !claimed {
		t.Fatalf("ClaimWallet() = claim:%+v claimed:%v error:%v", claim, claimed, err)
	}
	if claim.Action != WalletRecoveryApply || claim.Record.WalletPhase != WalletRecoveryLookup ||
		claim.Record.WalletApplyAttempts != 1 || claim.Record.RetryCount != 1 ||
		claim.Record.WalletLookupAttempts != 0 || claim.LeaseUntil.IsZero() {
		t.Fatalf("apply claim did not persist lookup-first recovery: %+v", claim)
	}
	persisted, err := repository.GetRound(context.Background(), record.Key)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.WalletPhase != WalletRecoveryLookup ||
		!persisted.WalletLeaseUntil.Equal(claim.LeaseUntil) {
		t.Fatalf("persisted claim = %+v", persisted)
	}
}

func TestMemoryWalletClaimsQuarantineLedgerAndCommandIntegrityFailures(t *testing.T) {
	mutations := []struct {
		name   string
		mutate func(*memorySession, RoundRecord)
	}{
		{
			name: "missing ledger",
			mutate: func(entry *memorySession, record RoundRecord) {
				delete(entry.walletTransactions, record.WalletCommand.OperationID)
			},
		},
		{
			name: "wrong ledger binding",
			mutate: func(entry *memorySession, record RoundRecord) {
				ledger := entry.walletTransactions[record.WalletCommand.OperationID]
				ledger.Command.Currency = "EUR"
				ledger.Command.CommandDigest = CommandDigestFor(ledger.Command)
				entry.walletTransactions[record.WalletCommand.OperationID] = ledger
			},
		},
		{
			name: "duplicate ledger identity",
			mutate: func(entry *memorySession, record RoundRecord) {
				ledger := entry.walletTransactions[record.WalletCommand.OperationID]
				ledger.Command.OperationID = "rgs-op-v1:duplicate"
				ledger.Command.CommandDigest = CommandDigestFor(ledger.Command)
				entry.walletTransactions[ledger.Command.OperationID] = ledger
			},
		},
		{
			name: "terminal ledger status",
			mutate: func(entry *memorySession, record RoundRecord) {
				ledger := entry.walletTransactions[record.WalletCommand.OperationID]
				ledger.Status = memoryWalletStatusSuccess
				entry.walletTransactions[record.WalletCommand.OperationID] = ledger
			},
		},
		{
			name: "credit command drift",
			mutate: func(entry *memorySession, record RoundRecord) {
				record.WalletCommand.CreditMinor++
				record.WalletCommand.CommandDigest = CommandDigestFor(record.WalletCommand)
				entry.rounds[record.Key.RoundID] = record
			},
		},
	}
	claimers := []struct {
		name  string
		claim func(*MemoryRepository, RoundKey) ([]WalletRecoveryClaim, error)
	}{
		{
			name: "direct",
			claim: func(repository *MemoryRepository, key RoundKey) ([]WalletRecoveryClaim, error) {
				claim, claimed, err := repository.ClaimWallet(context.Background(), key, time.Minute)
				if claimed {
					return []WalletRecoveryClaim{claim}, err
				}
				return nil, err
			},
		},
		{
			name: "batch",
			claim: func(repository *MemoryRepository, _ RoundKey) ([]WalletRecoveryClaim, error) {
				return repository.ClaimRecoverableRounds(context.Background(), 1, time.Minute)
			},
		},
	}
	for _, claimer := range claimers {
		for _, mutation := range mutations {
			t.Run(claimer.name+"/"+mutation.name, func(t *testing.T) {
				repository := NewMemoryRepository()
				record := prepareMemoryRecoveryRound(
					t, repository, "operator-a", "session-a", "round-a",
				)
				entry, err := repository.lookupSession(
					context.Background(), record.Key.OperatorID, record.Key.SessionID,
				)
				if err != nil {
					t.Fatal(err)
				}
				entry.mu.Lock()
				mutation.mutate(entry, record)
				entry.mu.Unlock()

				claims, err := claimer.claim(repository, record.Key)
				if !errors.Is(err, ErrManualReview) || len(claims) != 0 {
					t.Fatalf("claim integrity result = claims:%+v error:%v", claims, err)
				}
				persisted, getErr := repository.GetRound(context.Background(), record.Key)
				if getErr != nil || persisted.Status != RoundManualReview ||
					persisted.WalletPhase != "" || !persisted.WalletLeaseUntil.IsZero() {
					t.Fatalf("quarantined round = record:%+v error:%v", persisted, getErr)
				}
				session, getErr := repository.GetSession(
					context.Background(), record.Key.OperatorID, record.Key.SessionID,
				)
				if getErr != nil || session.Status != SessionBlocked {
					t.Fatalf("quarantined session = session:%+v error:%v", session, getErr)
				}
			})
		}
	}
}

func TestMemoryWalletClaimAllowsUnknownNonterminalLedgerEvidence(t *testing.T) {
	repository := NewMemoryRepository()
	record := prepareMemoryRecoveryRound(t, repository, "operator-a", "session-a", "round-a")
	entry, err := repository.lookupSession(context.Background(), record.Key.OperatorID, record.Key.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	entry.mu.Lock()
	ledger := entry.walletTransactions[record.WalletCommand.OperationID]
	ledger.Status = memoryWalletStatusUnknown
	entry.walletTransactions[record.WalletCommand.OperationID] = ledger
	entry.mu.Unlock()
	claim, claimed, err := repository.ClaimWallet(context.Background(), record.Key, time.Minute)
	if err != nil || !claimed || claim.Action != WalletRecoveryApply {
		t.Fatalf("ClaimWallet() = claim:%+v claimed:%v error:%v", claim, claimed, err)
	}
}

func TestMemoryRecoveryClaimsFairOperatorWaveAndFencesSchedule(t *testing.T) {
	repository := NewMemoryRepository()
	prepareMemoryRecoveryRound(t, repository, "operator-a", "session-a1", "round-a1")
	prepareMemoryRecoveryRound(t, repository, "operator-a", "session-a2", "round-a2")
	prepareMemoryRecoveryRound(t, repository, "operator-b", "session-b1", "round-b1")

	claims, err := repository.ClaimRecoverableRounds(context.Background(), 2, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 2 || claims[0].Record.Key.OperatorID == claims[1].Record.Key.OperatorID {
		t.Fatalf("first recovery wave is not operator-fair: %+v", claims)
	}
	for _, claim := range claims {
		if claim.Action != WalletRecoveryApply || claim.Record.WalletPhase != WalletRecoveryLookup {
			t.Fatalf("unsafe recovery claim: %+v", claim)
		}
	}
	explicitNotBefore := time.Now().UTC().Add(2 * time.Minute)
	disposition := WalletRecoveryDisposition{
		NextAction: WalletRecoveryLookup, MinimumDelay: 3 * time.Minute,
		NextAttemptAt: explicitNotBefore,
	}
	scheduled, err := repository.ScheduleWalletRecovery(
		context.Background(), claims[0], disposition, time.Millisecond,
	)
	if err != nil || !scheduled {
		t.Fatalf("ScheduleWalletRecovery() = scheduled:%v error:%v", scheduled, err)
	}
	persisted, err := repository.GetRound(context.Background(), claims[0].Record.Key)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.NextAttemptAt.Before(time.Now().UTC().Add(2*time.Minute+50*time.Second)) ||
		!persisted.WalletLeaseUntil.IsZero() {
		t.Fatalf("retry lower bound or lease release was lost: %+v", persisted)
	}
	staleScheduled, err := repository.ScheduleWalletRecovery(
		context.Background(), claims[0], disposition, 0,
	)
	if err != nil || staleScheduled {
		t.Fatalf("stale lease fence = scheduled:%v error:%v", staleScheduled, err)
	}
}

func TestMemoryWalletTerminalTransitionsRejectStaleClaim(t *testing.T) {
	for _, test := range []struct {
		name       string
		transition func(*MemoryRepository, WalletRecoveryClaim) error
	}{
		{
			name: "commit",
			transition: func(repository *MemoryRepository, claim WalletRecoveryClaim) error {
				command := claim.Record.WalletCommand
				_, _, err := repository.CommitClaim(context.Background(), claim, WalletReceipt{
					OperationID: command.OperationID, Fingerprint: command.Fingerprint,
					TransactionID: "wallet-transaction-a", OperatorID: command.OperatorID,
					Currency: command.Currency, DebitMinor: command.DebitMinor,
					CreditMinor: command.CreditMinor, BalanceMinor: 9_900,
				})
				return err
			},
		},
		{
			name: "reject",
			transition: func(repository *MemoryRepository, claim WalletRecoveryClaim) error {
				_, _, err := repository.RejectClaim(context.Background(), claim, "declined")
				return err
			},
		},
		{
			name: "manual review",
			transition: func(repository *MemoryRepository, claim WalletRecoveryClaim) error {
				_, _, err := repository.MarkClaimManualReview(context.Background(), claim, "conflict")
				return err
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository := NewMemoryRepository()
			record := prepareMemoryRecoveryRound(t, repository, "operator-a", "session-a", "round-a")
			oldClaim, claimed, err := repository.ClaimWallet(context.Background(), record.Key, time.Minute)
			if err != nil || !claimed {
				t.Fatalf("first ClaimWallet() = claim:%+v claimed:%v error:%v", oldClaim, claimed, err)
			}
			scheduled, err := repository.ScheduleWalletRecovery(context.Background(), oldClaim,
				WalletRecoveryDisposition{NextAction: WalletRecoveryLookup}, 0)
			if err != nil || !scheduled {
				t.Fatalf("ScheduleWalletRecovery() = scheduled:%v error:%v", scheduled, err)
			}
			newClaim, claimed, err := repository.ClaimWallet(context.Background(), record.Key, time.Minute)
			if err != nil || !claimed || newClaim.LeaseUntil.Equal(oldClaim.LeaseUntil) {
				t.Fatalf("second ClaimWallet() = claim:%+v claimed:%v error:%v", newClaim, claimed, err)
			}
			if err := test.transition(repository, oldClaim); !errors.Is(err, ErrStaleWalletClaim) {
				t.Fatalf("stale transition error = %v, want ErrStaleWalletClaim", err)
			}
			persisted, err := repository.GetRound(context.Background(), record.Key)
			if err != nil || persisted.Status != RoundWalletPending ||
				!persisted.WalletLeaseUntil.Equal(newClaim.LeaseUntil) {
				t.Fatalf("new claim was overwritten: record:%+v error:%v", persisted, err)
			}
		})
	}
}

func TestMemoryNotSentApplyReturnsReservedAttemptBudget(t *testing.T) {
	repository := NewMemoryRepository()
	record := prepareMemoryRecoveryRound(t, repository, "operator-a", "session-a", "round-a")
	claim, claimed, err := repository.ClaimWallet(context.Background(), record.Key, time.Minute)
	if err != nil || !claimed || claim.Record.WalletApplyAttempts != 1 {
		t.Fatalf("ClaimWallet() = claim:%+v claimed:%v error:%v", claim, claimed, err)
	}
	scheduled, err := repository.ScheduleWalletRecovery(
		context.Background(), claim,
		WalletRecoveryDisposition{NextAction: WalletRecoveryApply, ApplyNotSent: true}, 0,
	)
	if err != nil || !scheduled {
		t.Fatalf("ScheduleWalletRecovery() = scheduled:%v error:%v", scheduled, err)
	}
	persisted, err := repository.GetRound(context.Background(), record.Key)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.WalletApplyAttempts != 0 || persisted.RetryCount != 1 ||
		persisted.WalletPhase != WalletRecoveryApply {
		t.Fatalf("NOT_SENT budget was not returned: %+v", persisted)
	}
	secondClaim, claimed, err := repository.ClaimWallet(context.Background(), record.Key, time.Minute)
	if err != nil || !claimed || secondClaim.Record.WalletApplyAttempts != 1 ||
		secondClaim.Record.RetryCount != 2 {
		t.Fatalf("second ClaimWallet() = claim:%+v claimed:%v error:%v", secondClaim, claimed, err)
	}
	if scheduled, err = repository.ScheduleWalletRecovery(
		context.Background(), secondClaim,
		WalletRecoveryDisposition{NextAction: WalletRecoveryApply, ApplyNotSent: true}, 0,
	); err != nil || !scheduled {
		t.Fatalf("second ScheduleWalletRecovery() = scheduled:%v error:%v", scheduled, err)
	}
	persisted, err = repository.GetRound(context.Background(), record.Key)
	if err != nil || persisted.WalletApplyAttempts != 0 || persisted.RetryCount != 2 {
		t.Fatalf("second NOT_SENT did not preserve scheduler pressure: record:%+v error:%v", persisted, err)
	}
}

func TestCoordinatorProfileFailureReturnsReservedApplyBudget(t *testing.T) {
	repository := NewMemoryRepository()
	record := prepareMemoryRecoveryRound(t, repository, "operator-a", "session-a", "round-a")
	claim, claimed, err := repository.ClaimWallet(context.Background(), record.Key, time.Minute)
	if err != nil || !claimed {
		t.Fatalf("ClaimWallet() = claim:%+v claimed:%v error:%v", claim, claimed, err)
	}
	wallet := newTestWallet(10_000)
	wallet.profileError = ErrWalletUnavailable
	coordinator := newTestCoordinator(t, repository, wallet, &countingSpinner{}, time.Second)
	if _, err := coordinator.executeClaimAndSchedule(
		context.Background(), context.Background(), claim,
	); !errors.Is(err, ErrWalletPending) {
		t.Fatalf("executeClaimAndSchedule() error = %v, want ErrWalletPending", err)
	}
	persisted, err := repository.GetRound(context.Background(), record.Key)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.WalletApplyAttempts != 0 || persisted.RetryCount != 1 ||
		persisted.WalletPhase != WalletRecoveryApply {
		t.Fatalf("profile failure consumed APPLY budget: %+v", persisted)
	}
}

func TestCoordinatorReadsLatestCommittedRoundAfterStaleRejectedClaim(t *testing.T) {
	repository := NewMemoryRepository()
	record := prepareMemoryRecoveryRound(t, repository, "operator-a", "session-a", "round-a")
	oldClaim, claimed, err := repository.ClaimWallet(context.Background(), record.Key, time.Minute)
	if err != nil || !claimed {
		t.Fatalf("first ClaimWallet() = claim:%+v claimed:%v error:%v", oldClaim, claimed, err)
	}
	if scheduled, scheduleErr := repository.ScheduleWalletRecovery(context.Background(), oldClaim,
		WalletRecoveryDisposition{NextAction: WalletRecoveryLookup}, 0); scheduleErr != nil || !scheduled {
		t.Fatalf("ScheduleWalletRecovery() = scheduled:%v error:%v", scheduled, scheduleErr)
	}
	newClaim, claimed, err := repository.ClaimWallet(context.Background(), record.Key, time.Minute)
	if err != nil || !claimed {
		t.Fatalf("second ClaimWallet() = claim:%+v claimed:%v error:%v", newClaim, claimed, err)
	}
	command := newClaim.Record.WalletCommand
	committed, changed, err := repository.CommitClaim(context.Background(), newClaim, WalletReceipt{
		OperationID: command.OperationID, Fingerprint: command.Fingerprint,
		TransactionID: "wallet-transaction-new-owner", OperatorID: command.OperatorID,
		Currency: command.Currency, DebitMinor: command.DebitMinor,
		CreditMinor: command.CreditMinor, BalanceMinor: 9_900,
	})
	if err != nil || !changed {
		t.Fatalf("new-owner CommitClaim() = changed:%v error:%v", changed, err)
	}
	wallet := newTestWallet(0)
	coordinator := newTestCoordinator(t, repository, wallet, &countingSpinner{}, time.Second)
	result, disposition, err := coordinator.applyWalletResolution(
		context.Background(), oldClaim, oldClaim.Record.WalletProfile,
		Resolution{Status: ResolutionRejectedFinal, Code: "INSUFFICIENT_FUNDS"},
	)
	if err != nil || !disposition.Terminal || result.ServerTransactionID != committed.Result.ServerTransactionID {
		t.Fatalf("stale resolution = result:%+v disposition:%+v error:%v", result, disposition, err)
	}
	persisted, err := repository.GetRound(context.Background(), record.Key)
	if err != nil || persisted.Status != RoundCommitted {
		t.Fatalf("latest round = record:%+v error:%v", persisted, err)
	}
}

func TestRejectedResolutionPersistsProviderCode(t *testing.T) {
	repository := NewMemoryRepository()
	record := prepareMemoryRecoveryRound(t, repository, "operator-a", "session-a", "round-a")
	claim, claimed, err := repository.ClaimWallet(context.Background(), record.Key, time.Minute)
	if err != nil || !claimed {
		t.Fatalf("ClaimWallet() = claim:%+v claimed:%v error:%v", claim, claimed, err)
	}
	coordinator := newTestCoordinator(t, repository, newTestWallet(0), &countingSpinner{}, time.Second)
	_, disposition, err := coordinator.applyWalletResolution(
		context.Background(), claim, claim.Record.WalletProfile,
		Resolution{Status: ResolutionRejectedFinal, Code: "LIMIT_EXCEEDED"},
	)
	if !errors.Is(err, ErrWalletRejected) || !disposition.Terminal {
		t.Fatalf("rejected resolution = disposition:%+v error:%v", disposition, err)
	}
	persisted, err := repository.GetRound(context.Background(), record.Key)
	if err != nil || persisted.Status != RoundRejected || persisted.FailureReason != "LIMIT_EXCEEDED" {
		t.Fatalf("persisted rejection = record:%+v error:%v", persisted, err)
	}
}

func TestClaimManualReviewEscalatesMissingLedgerToIntegrityQuarantine(t *testing.T) {
	repository := &claimIntegrityEscalationRepository{}
	coordinator := newTestCoordinator(t, repository, newTestWallet(0), &countingSpinner{}, time.Second)
	claim := WalletRecoveryClaim{
		Record: RoundRecord{Key: RoundKey{
			OperatorID: "operator-a", SessionID: "session-a", RoundID: "round-a",
		}},
		Action: WalletRecoveryLookup, LeaseUntil: time.Now().Add(time.Minute),
	}
	_, disposition, err := coordinator.markClaimForManualReview(
		context.Background(), claim, "wallet ledger is missing", nil,
	)
	if !errors.Is(err, ErrManualReview) || !disposition.Terminal ||
		repository.claimCalls != 1 || repository.quarantineCalls != 1 {
		t.Fatalf("integrity escalation = disposition:%+v error:%v claim:%d quarantine:%d",
			disposition, err, repository.claimCalls, repository.quarantineCalls)
	}
}

type claimIntegrityEscalationRepository struct {
	Repository
	claimCalls      int
	quarantineCalls int
}

func (r *claimIntegrityEscalationRepository) MarkClaimManualReview(
	context.Context,
	WalletRecoveryClaim,
	string,
) (RoundRecord, bool, error) {
	r.claimCalls++
	return RoundRecord{}, false, ErrManualReview
}

func (r *claimIntegrityEscalationRepository) MarkManualReview(
	_ context.Context,
	key RoundKey,
	reason string,
) (RoundRecord, bool, error) {
	r.quarantineCalls++
	return RoundRecord{Key: key, Status: RoundManualReview, FailureReason: reason}, true, nil
}

func TestNotFoundRecoveryUsesDatabaseRelativeMinimumDelay(t *testing.T) {
	repository := NewMemoryRepository()
	wallet := newTestWallet(10_000)
	wallet.profile = AtomicHTTPProfile(testWalletRouteBindingID())
	wallet.profile.Capabilities.NotFoundConsistencyWindow = 1370 * time.Millisecond
	record := prepareMemoryRecoveryRoundWithProfile(
		t, repository, "operator-a", "session-a", "round-a", wallet.profile,
	)
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return game.SpinOutcome{}, errors.New("recovery test: engine must not be called")
	}}
	coordinator := newTestCoordinator(t, repository, wallet, spinner, time.Second)
	leaseUntil := time.Now().Add(time.Second)
	record.WalletLeaseUntil = leaseUntil
	_, disposition, err := coordinator.ReconcileClaim(context.Background(), WalletRecoveryClaim{
		Record: record, Action: WalletRecoveryLookup, LeaseUntil: leaseUntil,
	})
	if !errors.Is(err, ErrWalletPending) {
		t.Fatalf("ReconcileClaim() error = %v, want ErrWalletPending", err)
	}
	if disposition.Terminal || disposition.NextAction != WalletRecoveryApply ||
		disposition.MinimumDelay != 1370*time.Millisecond || !disposition.NextAttemptAt.IsZero() {
		t.Fatalf("NOT_FOUND disposition = %+v", disposition)
	}
}

func TestRecoveryQuarantinesWalletRouteOrCapabilityDrift(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*Profile)
	}{
		{
			name: "ledger route changed",
			mutate: func(profile *Profile) {
				profile.RouteBindingID = WalletRouteBindingIDForCanonicalTarget(
					"https://wallet.test.invalid/other-ledger",
				)
			},
		},
		{
			name: "not-found policy changed",
			mutate: func(profile *Profile) {
				profile.Capabilities.NotFoundConsistencyWindow = 2 * time.Second
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository := NewMemoryRepository()
			preparedProfile := AtomicHTTPProfile(testWalletRouteBindingID())
			record := prepareMemoryRecoveryRoundWithProfile(
				t, repository, "operator-a", "session-a", "round-a", preparedProfile,
			)
			claim, claimed, claimErr := repository.ClaimWallet(context.Background(), record.Key, time.Second)
			if claimErr != nil || !claimed {
				t.Fatalf("ClaimWallet() = claim:%+v claimed:%v error:%v", claim, claimed, claimErr)
			}
			wallet := newTestWallet(10_000)
			wallet.profile = preparedProfile
			test.mutate(&wallet.profile)
			spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
				return game.SpinOutcome{}, errors.New("recovery must not execute game math")
			}}
			coordinator := newTestCoordinator(t, repository, wallet, spinner, time.Second)
			_, disposition, err := coordinator.ReconcileClaim(context.Background(), claim)
			if !errors.Is(err, ErrManualReview) || !disposition.Terminal {
				t.Fatalf("ReconcileClaim() = disposition:%+v error:%v", disposition, err)
			}
			if wallet.applyCalls.Load() != 0 || wallet.lookupCalls.Load() != 0 {
				t.Fatalf("drift reached wallet: apply=%d lookup=%d",
					wallet.applyCalls.Load(), wallet.lookupCalls.Load())
			}
			persisted, getErr := repository.GetRound(context.Background(), record.Key)
			if getErr != nil || persisted.Status != RoundManualReview {
				t.Fatalf("persisted quarantine = record:%+v error:%v", persisted, getErr)
			}
		})
	}
}

func TestWalletRecoveryDispositionValidatesRelativeDelayContract(t *testing.T) {
	if err := ValidateWalletRecoveryDisposition(WalletRecoveryDisposition{
		NextAction: WalletRecoveryLookup, MinimumDelay: time.Second,
	}); err != nil {
		t.Fatalf("valid relative delay rejected: %v", err)
	}
	for _, invalid := range []WalletRecoveryDisposition{
		{Terminal: true, MinimumDelay: time.Second},
		{Terminal: true, ApplyNotSent: true},
		{NextAction: WalletRecoveryLookup, ApplyNotSent: true},
		{NextAction: WalletRecoveryLookup, MinimumDelay: -time.Nanosecond},
		{NextAction: WalletRecoveryLookup, MinimumDelay: 24*time.Hour + time.Nanosecond},
	} {
		if err := ValidateWalletRecoveryDisposition(invalid); err == nil {
			t.Fatalf("invalid disposition accepted: %+v", invalid)
		}
	}
}
