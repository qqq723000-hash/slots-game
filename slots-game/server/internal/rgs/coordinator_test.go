package rgs

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"slots-game/server/internal/game"
	"slots-game/server/internal/rng"
)

func TestConcurrentIdenticalRoundEvaluatesAndAppliesWalletOnce(t *testing.T) {
	repository := NewMemoryRepository()
	createTestSession(t, repository, baseSession())
	spinner := &countingSpinner{spin: func(input game.SpinInput) (game.SpinOutcome, error) {
		return payableOutcome(game.EmptyFeatureState()), nil
	}}
	wallet := newTestWallet(10_000)
	wallet.applyDelay = 20 * time.Millisecond
	observer := &testRoundObserver{}
	coordinator := newTestCoordinator(t, repository, wallet, spinner, time.Second, observer)
	request := baseRequest("round-concurrent", 100, 0)

	const callers = 50
	start := make(chan struct{})
	results := make([]SpinResult, callers)
	errorsSeen := make([]error, callers)
	var group sync.WaitGroup
	group.Add(callers)
	for index := range callers {
		go func() {
			defer group.Done()
			<-start
			results[index], errorsSeen[index] = coordinator.Spin(context.Background(), request)
		}()
	}
	close(start)
	group.Wait()

	for index, err := range errorsSeen {
		if err != nil {
			t.Fatalf("Spin[%d] error = %v", index, err)
		}
		if !reflect.DeepEqual(results[0], results[index]) {
			t.Fatalf("Spin[%d] did not return canonical replay", index)
		}
	}
	if calls := spinner.calls.Load(); calls != 1 {
		t.Fatalf("engine calls = %d, want 1", calls)
	}
	if calls := wallet.applyCalls.Load(); calls != 1 {
		t.Fatalf("wallet ApplyRound calls = %d, want 1", calls)
	}
	if got := observer.prepared.Load(); got != 1 {
		t.Fatalf("prepared transitions = %d, want 1", got)
	}
	if got := observer.committed.Load(); got != 1 {
		t.Fatalf("committed transitions = %d, want 1", got)
	}
	if got := observer.replayed.Load(); got != callers-1 {
		t.Fatalf("successful idempotent replays = %d, want %d", got, callers-1)
	}
	if applies := wallet.economicApplyCount(); applies != 1 {
		t.Fatalf("wallet economic applies = %d, want 1", applies)
	}
	if results[0].BalanceMinor != 9_950 || results[0].EndRevision != 1 || results[0].Sequence != 1 {
		t.Fatalf("committed result = %+v", results[0])
	}
	session, err := repository.GetSession(context.Background(), "operator-a", "session-a")
	if err != nil {
		t.Fatal(err)
	}
	if session.PendingRoundID != "" || session.Revision != 1 || session.BalanceMinor != 9_950 {
		t.Fatalf("committed session = %+v", session)
	}
}

func TestCloneSpinResultIsolatesAuthoritativePreMultiplierAmount(t *testing.T) {
	source := SpinResult{Wins: []game.Win{{
		PathAwards: []game.PathAward{{
			Multiplier: 5, BaseAmountMinor: 50, AmountMinor: 250,
			Cells: []game.Position{{Reel: 0}, {Reel: 1}, {Reel: 2}},
		}},
	}}}
	cloned := cloneSpinResult(source)
	cloned.Wins[0].PathAwards[0].BaseAmountMinor = 999
	if source.Wins[0].PathAwards[0].BaseAmountMinor != 50 {
		t.Fatalf("source path award was mutated through clone: %+v", source.Wins)
	}
}

func TestSameRoundWithDifferentBetConflicts(t *testing.T) {
	repository := NewMemoryRepository()
	createTestSession(t, repository, baseSession())
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return payableOutcome(game.EmptyFeatureState()), nil
	}}
	wallet := newTestWallet(10_000)
	observer := &testRoundObserver{}
	coordinator := newTestCoordinator(t, repository, wallet, spinner, time.Second, observer)

	if _, err := coordinator.Spin(context.Background(), baseRequest("round-conflict", 100, 0)); err != nil {
		t.Fatalf("first Spin error = %v", err)
	}
	_, err := coordinator.Spin(context.Background(), baseRequest("round-conflict", 200, 0))
	if !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("conflicting Spin error = %v, want ErrIdempotencyConflict", err)
	}
	if spinner.calls.Load() != 1 || wallet.applyCalls.Load() != 1 {
		t.Fatalf("conflict repeated side effects: engine=%d wallet=%d", spinner.calls.Load(), wallet.applyCalls.Load())
	}
	if got := observer.conflicts.Load(); got != 1 {
		t.Fatalf("idempotency conflicts = %d, want 1", got)
	}
}

func TestConcurrentManualReviewRetriesCountOneDurableTransition(t *testing.T) {
	repository := NewMemoryRepository()
	createTestSession(t, repository, baseSession())
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return payableOutcome(game.EmptyFeatureState()), nil
	}}
	wallet := newTestWallet(10_000)
	wallet.applyError = ErrIdempotencyConflict
	observer := &testRoundObserver{}
	coordinator := newTestCoordinator(t, repository, wallet, spinner, time.Second, observer)
	request := baseRequest("round-manual-review-concurrent", 100, 0)

	const callers = 30
	start := make(chan struct{})
	errorsSeen := make(chan error, callers)
	var group sync.WaitGroup
	group.Add(callers)
	for range callers {
		go func() {
			defer group.Done()
			<-start
			_, err := coordinator.Spin(context.Background(), request)
			errorsSeen <- err
		}()
	}
	close(start)
	group.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		if !errors.Is(err, ErrManualReview) {
			t.Fatalf("Spin() error = %v, want ErrManualReview", err)
		}
	}

	if got := observer.prepared.Load(); got != 1 {
		t.Fatalf("prepared transitions = %d, want 1", got)
	}
	if got := observer.manualReview.Load(); got != 1 {
		t.Fatalf("manual-review transitions = %d, want 1", got)
	}
	if got := observer.conflicts.Load(); got != 1 {
		t.Fatalf("wallet idempotency conflicts = %d, want 1", got)
	}
	if got := observer.committed.Load(); got != 0 {
		t.Fatalf("committed transitions = %d, want 0", got)
	}
}

func TestPendingRoundBlocksDifferentRound(t *testing.T) {
	repository := NewMemoryRepository()
	createTestSession(t, repository, baseSession())
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return payableOutcome(game.EmptyFeatureState()), nil
	}}
	wallet := newTestWallet(10_000)
	wallet.applyEntered = make(chan struct{})
	wallet.applyBlock = make(chan struct{})
	coordinator := newTestCoordinator(t, repository, wallet, spinner, time.Second)

	firstDone := make(chan error, 1)
	go func() {
		_, err := coordinator.Spin(context.Background(), baseRequest("round-pending", 100, 0))
		firstDone <- err
	}()
	select {
	case <-wallet.applyEntered:
	case <-time.After(time.Second):
		t.Fatal("wallet ApplyRound was not reached")
	}

	_, err := coordinator.Spin(context.Background(), baseRequest("round-overtake", 100, 0))
	if !errors.Is(err, ErrRoundPending) {
		t.Fatalf("overtaking round error = %v, want ErrRoundPending", err)
	}
	record, err := repository.GetRound(context.Background(), baseRequest("round-pending", 100, 0).Key())
	if err != nil {
		t.Fatal(err)
	}
	if record.Status != RoundWalletPending {
		t.Fatalf("first round status = %s, want WALLET_PENDING", record.Status)
	}
	if spinner.calls.Load() != 1 {
		t.Fatalf("engine calls = %d, competing round must not evaluate", spinner.calls.Load())
	}

	close(wallet.applyBlock)
	select {
	case err := <-firstDone:
		if err != nil {
			t.Fatalf("first Spin error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("first Spin did not finish")
	}
}

func TestWalletCommittedButResponseTimedOutRecoversWithoutSecondApply(t *testing.T) {
	repository := NewMemoryRepository()
	createTestSession(t, repository, baseSession())
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return payableOutcome(game.EmptyFeatureState()), nil
	}}
	wallet := newTestWallet(10_000)
	wallet.ambiguousAfterApply = true
	wallet.lookupAllowed.Store(false)
	coordinator := newTestCoordinator(t, repository, wallet, spinner, 12*time.Millisecond)
	request := baseRequest("round-ambiguous", 100, 0)

	_, err := coordinator.Spin(context.Background(), request)
	if !errors.Is(err, ErrWalletPending) {
		t.Fatalf("ambiguous Spin error = %v, want ErrWalletPending", err)
	}
	if wallet.balanceValue() != 9_950 || wallet.economicApplyCount() != 1 {
		t.Fatalf("wallet did not atomically apply once: balance=%d applies=%d", wallet.balanceValue(), wallet.economicApplyCount())
	}
	record, err := repository.GetRound(context.Background(), request.Key())
	if err != nil {
		t.Fatal(err)
	}
	if record.Status != RoundWalletPending {
		t.Fatalf("ambiguous round status = %s", record.Status)
	}

	wallet.lookupAllowed.Store(true)
	if _, err := coordinator.Spin(context.Background(), request); !errors.Is(err, ErrWalletPending) {
		t.Fatalf("client retry error = %v, want ErrWalletPending", err)
	}
	result, err := coordinator.Reconcile(context.Background(), request.Key())
	if err != nil {
		t.Fatalf("worker recovery error = %v", err)
	}
	if result.BalanceMinor != 9_950 || result.EndRevision != 1 {
		t.Fatalf("recovered result = %+v", result)
	}
	if spinner.calls.Load() != 1 || wallet.applyCalls.Load() != 1 || wallet.economicApplyCount() != 1 {
		t.Fatalf("recovery repeated side effects: engine=%d applyCalls=%d economic=%d", spinner.calls.Load(), wallet.applyCalls.Load(), wallet.economicApplyCount())
	}
}

func TestWalletIntegrityFailuresBlockSessionForManualReview(t *testing.T) {
	for _, failure := range []error{ErrIdempotencyConflict, ErrWalletReceiptInvalid} {
		t.Run(failure.Error(), func(t *testing.T) {
			repository := NewMemoryRepository()
			createTestSession(t, repository, baseSession())
			spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
				return payableOutcome(game.EmptyFeatureState()), nil
			}}
			wallet := newTestWallet(10_000)
			wallet.applyError = failure
			coordinator := newTestCoordinator(t, repository, wallet, spinner, time.Second)
			request := baseRequest("round-integrity-failure", 100, 0)

			_, err := coordinator.Spin(context.Background(), request)
			if !errors.Is(err, ErrManualReview) {
				t.Fatalf("Spin error = %v, want ErrManualReview", err)
			}
			record, err := repository.GetRound(context.Background(), request.Key())
			if err != nil {
				t.Fatal(err)
			}
			if record.Status != RoundManualReview {
				t.Fatalf("round status = %s, want MANUAL_REVIEW", record.Status)
			}
			session, err := repository.GetSession(context.Background(), request.OperatorID, request.SessionID)
			if err != nil {
				t.Fatal(err)
			}
			if session.Status != SessionBlocked || session.PendingRoundID != request.RoundID {
				t.Fatalf("session was not blocked on the affected round: %+v", session)
			}
			if wallet.economicApplyCount() != 0 {
				t.Fatal("integrity failure must not be recorded as a successful economic apply")
			}
		})
	}
}

func TestReconcileQuarantinesPersistedIntegrityFailureBeforeWalletCall(t *testing.T) {
	key := RoundKey{OperatorID: "operator-a", SessionID: "session-a", RoundID: "round-corrupt"}
	repository := &integrityFaultRepository{Repository: NewMemoryRepository(), key: key}
	wallet := newTestWallet(10_000)
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return payableOutcome(game.EmptyFeatureState()), nil
	}}
	coordinator := newTestCoordinator(t, repository, wallet, spinner, time.Second)

	_, err := coordinator.Reconcile(context.Background(), key)
	if !errors.Is(err, ErrManualReview) {
		t.Fatalf("Reconcile() error = %v, want ErrManualReview", err)
	}
	if repository.markCalls != 1 || repository.markedKey != key ||
		repository.reason != persistedRoundIntegrityFailure {
		t.Fatalf("manual-review transition = calls:%d key:%#v reason:%q",
			repository.markCalls, repository.markedKey, repository.reason)
	}
	if wallet.applyCalls.Load() != 0 || spinner.calls.Load() != 0 {
		t.Fatalf("integrity failure reached side effects: wallet=%d engine=%d",
			wallet.applyCalls.Load(), spinner.calls.Load())
	}
}

func TestRoundStatusQuarantinesPersistedIntegrityFailureWithoutWalletCall(t *testing.T) {
	key := RoundKey{OperatorID: "operator-a", SessionID: "session-a", RoundID: "round-status-corrupt"}
	repository := &integrityFaultRepository{Repository: NewMemoryRepository(), key: key}
	wallet := newTestWallet(10_000)
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return payableOutcome(game.EmptyFeatureState()), nil
	}}
	observer := &testRoundObserver{}
	coordinator := newTestCoordinator(t, repository, wallet, spinner, time.Second, observer)

	for attempt := range 2 {
		_, err := coordinator.GetRound(context.Background(), key)
		if !errors.Is(err, ErrManualReview) {
			t.Fatalf("GetRound() attempt %d error = %v, want ErrManualReview", attempt+1, err)
		}
	}
	if repository.markCalls != 2 {
		t.Fatalf("manual-review calls = %d, want 2 status checks", repository.markCalls)
	}
	if got := observer.manualReview.Load(); got != 1 {
		t.Fatalf("manual-review transitions = %d, want 1", got)
	}
	if wallet.applyCalls.Load() != 0 || wallet.lookupCalls.Load() != 0 ||
		wallet.rollbackCalls.Load() != 0 || spinner.calls.Load() != 0 {
		t.Fatalf("status integrity failure reached side effects: apply=%d lookup=%d rollback=%d engine=%d",
			wallet.applyCalls.Load(), wallet.lookupCalls.Load(), wallet.rollbackCalls.Load(), spinner.calls.Load())
	}
}

func TestBlockedSessionFailsAsManualReviewBeforeEngineAndWallet(t *testing.T) {
	repository := NewMemoryRepository()
	session := baseSession()
	session.Status = SessionBlocked
	createTestSession(t, repository, session)
	wallet := newTestWallet(10_000)
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return payableOutcome(game.EmptyFeatureState()), nil
	}}
	coordinator := newTestCoordinator(t, repository, wallet, spinner, time.Second)

	_, err := coordinator.Spin(context.Background(), baseRequest("round-blocked", 100, 0))
	if !errors.Is(err, ErrManualReview) {
		t.Fatalf("Spin() error = %v, want ErrManualReview", err)
	}
	if wallet.applyCalls.Load() != 0 || spinner.calls.Load() != 0 {
		t.Fatalf("blocked session reached side effects: wallet=%d engine=%d",
			wallet.applyCalls.Load(), spinner.calls.Load())
	}
}

func TestWalletAdmissionRejectsBeforeRNGAndRoundPersistence(t *testing.T) {
	repository := NewMemoryRepository()
	createTestSession(t, repository, baseSession())
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return payableOutcome(game.EmptyFeatureState()), nil
	}}
	wallet := newTestWallet(10_000)
	wallet.admitError = ErrWalletUnavailable
	coordinator := newTestCoordinator(t, repository, wallet, spinner, time.Second)
	request := baseRequest("round-admission-rejected", 100, 0)

	_, err := coordinator.Spin(context.Background(), request)
	if !errors.Is(err, ErrWalletUnavailable) {
		t.Fatalf("Spin() error = %v, want ErrWalletUnavailable", err)
	}
	if spinner.calls.Load() != 0 || wallet.applyCalls.Load() != 0 || wallet.admitCalls.Load() != 1 {
		t.Fatalf("rejected admission reached side effects: engine=%d apply=%d admit=%d",
			spinner.calls.Load(), wallet.applyCalls.Load(), wallet.admitCalls.Load())
	}
	if _, err := repository.GetRound(context.Background(), request.Key()); !errors.Is(err, ErrRoundNotFound) {
		t.Fatalf("GetRound() error = %v, want ErrRoundNotFound", err)
	}
}

func TestNotSentApplyRemainsApplyWithoutLookup(t *testing.T) {
	repository := NewMemoryRepository()
	createTestSession(t, repository, baseSession())
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return payableOutcome(game.EmptyFeatureState()), nil
	}}
	wallet := newTestWallet(10_000)
	wallet.applyError = ErrWalletUnavailable
	coordinator := newTestCoordinator(t, repository, wallet, spinner, time.Second)
	request := baseRequest("round-not-sent", 100, 0)

	if _, err := coordinator.Spin(context.Background(), request); !errors.Is(err, ErrWalletPending) {
		t.Fatalf("Spin() error = %v, want ErrWalletPending", err)
	}
	record, err := repository.GetRound(context.Background(), request.Key())
	if err != nil {
		t.Fatal(err)
	}
	if record.WalletPhase != WalletRecoveryApply || wallet.lookupCalls.Load() != 0 ||
		wallet.applyCalls.Load() != 1 || wallet.economicApplyCount() != 0 {
		t.Fatalf("not-sent state = phase:%s apply:%d lookup:%d economic:%d",
			record.WalletPhase, wallet.applyCalls.Load(), wallet.lookupCalls.Load(), wallet.economicApplyCount())
	}
}

func TestSlowWalletLeavesFastPathAsDurableLookup(t *testing.T) {
	repository := NewMemoryRepository()
	createTestSession(t, repository, baseSession())
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return payableOutcome(game.EmptyFeatureState()), nil
	}}
	wallet := newTestWallet(10_000)
	wallet.applyDelay = 100 * time.Millisecond
	registry := DefinitionResolverFunc(func(context.Context, string, string, string) (game.Spinner, error) {
		return spinner, nil
	})
	coordinator, err := NewCoordinator(CoordinatorConfig{
		WalletLease: 100 * time.Millisecond, WalletFastPathTimeout: 5 * time.Millisecond,
		PendingWait: 5 * time.Millisecond, PollInterval: time.Millisecond,
	}, repository, wallet, registry)
	if err != nil {
		t.Fatal(err)
	}
	request := baseRequest("round-slow-fast-path", 100, 0)
	started := time.Now()
	if _, err := coordinator.Spin(context.Background(), request); !errors.Is(err, ErrWalletPending) {
		t.Fatalf("Spin() error = %v, want ErrWalletPending", err)
	}
	if elapsed := time.Since(started); elapsed >= 50*time.Millisecond {
		t.Fatalf("fast path elapsed = %s, want below 50ms", elapsed)
	}
	record, err := repository.GetRound(context.Background(), request.Key())
	if err != nil {
		t.Fatal(err)
	}
	if record.WalletPhase != WalletRecoveryLookup || wallet.applyCalls.Load() != 1 {
		t.Fatalf("slow-wallet state = phase:%s apply:%d", record.WalletPhase, wallet.applyCalls.Load())
	}
	if _, err := coordinator.Spin(context.Background(), request); !errors.Is(err, ErrWalletPending) {
		t.Fatalf("client replay error = %v, want ErrWalletPending", err)
	}
	if wallet.applyCalls.Load() != 1 {
		t.Fatalf("client replay repeated apply: %d", wallet.applyCalls.Load())
	}
}

func TestWalletRetryLimitBlocksBeforeAnotherEconomicAttempt(t *testing.T) {
	repository := NewMemoryRepository()
	createTestSession(t, repository, baseSession())
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return payableOutcome(game.EmptyFeatureState()), nil
	}}
	wallet := newTestWallet(10_000)
	wallet.applyError = errors.New("wallet temporarily unavailable")
	wallet.profile = AtomicHTTPProfile(testWalletRouteBindingID())
	registry := DefinitionResolverFunc(func(context.Context, string, string, string) (game.Spinner, error) {
		return spinner, nil
	})
	coordinator, err := NewCoordinator(CoordinatorConfig{
		WalletLease: 2 * time.Millisecond, PendingWait: time.Millisecond,
		PollInterval: time.Millisecond, MaxWalletAttempts: 1,
	}, repository, wallet, registry)
	if err != nil {
		t.Fatal(err)
	}
	request := baseRequest("round-retry-limit", 100, 0)
	if _, err := coordinator.Spin(context.Background(), request); !errors.Is(err, ErrWalletPending) {
		t.Fatalf("first Spin error = %v", err)
	}
	if _, err := coordinator.Reconcile(context.Background(), request.Key()); !errors.Is(err, ErrWalletPending) {
		t.Fatalf("lookup recovery error = %v", err)
	}
	entry, err := repository.lookupSession(context.Background(), request.OperatorID, request.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	entry.mu.Lock()
	due := entry.rounds[request.RoundID]
	due.NextAttemptAt = time.Now().Add(-time.Millisecond)
	entry.rounds[request.RoundID] = due
	entry.mu.Unlock()
	if _, err := coordinator.Reconcile(context.Background(), request.Key()); !errors.Is(err, ErrManualReview) {
		t.Fatalf("apply retry error = %v", err)
	}
	if wallet.applyCalls.Load() != 1 {
		t.Fatalf("wallet attempts = %d, want 1", wallet.applyCalls.Load())
	}
}

func TestPreparedClaimFinishesNotSentScheduleAfterClientCancellation(t *testing.T) {
	baseRepository := NewMemoryRepository()
	clientCtx, cancelClient := context.WithCancel(context.Background())
	repository := &cancelAfterClaimRepository{Repository: baseRepository, cancel: cancelClient}
	createTestSession(t, repository, baseSession())
	wallet := newTestWallet(10_000)
	wallet.applyError = ErrWalletUnavailable
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return payableOutcome(game.EmptyFeatureState()), nil
	}}
	coordinator := newTestCoordinator(t, repository, wallet, spinner, time.Second)
	request := baseRequest("round-cancel-after-claim", 100, 0)
	if _, err := coordinator.Spin(clientCtx, request); !errors.Is(err, ErrWalletPending) {
		t.Fatalf("Spin() error = %v, want ErrWalletPending", err)
	}
	persisted, err := baseRepository.GetRound(context.Background(), request.Key())
	if err != nil {
		t.Fatal(err)
	}
	if persisted.WalletApplyAttempts != 0 || persisted.RetryCount != 1 ||
		persisted.WalletPhase != WalletRecoveryApply || !persisted.WalletLeaseUntil.IsZero() {
		t.Fatalf("client cancellation stranded NOT_SENT claim: %+v", persisted)
	}
}

func TestCommittedReplayDoesNotRequireCurrentWalletProfile(t *testing.T) {
	repository := NewMemoryRepository()
	createTestSession(t, repository, baseSession())
	wallet := newTestWallet(10_000)
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return payableOutcome(game.EmptyFeatureState()), nil
	}}
	coordinator := newTestCoordinator(t, repository, wallet, spinner, time.Second)
	request := baseRequest("round-profile-offline-replay", 100, 0)
	first, err := coordinator.Spin(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	wallet.profileError = ErrWalletUnavailable
	replayed, err := coordinator.Spin(context.Background(), request)
	if err != nil {
		t.Fatalf("committed replay failed with profile offline: %v", err)
	}
	if replayed.ServerTransactionID != first.ServerTransactionID ||
		replayed.BalanceMinor != first.BalanceMinor || wallet.applyCalls.Load() != 1 {
		t.Fatalf("replayed result = %+v first=%+v applyCalls=%d", replayed, first, wallet.applyCalls.Load())
	}
}

func TestWalletPendingPollBackoffIsBounded(t *testing.T) {
	t.Parallel()

	const maximum = 250 * time.Millisecond
	interval := 20 * time.Millisecond
	want := []time.Duration{
		40 * time.Millisecond,
		80 * time.Millisecond,
		160 * time.Millisecond,
		maximum,
		maximum,
	}
	for index, expected := range want {
		interval = nextPollInterval(interval, maximum)
		if interval != expected {
			t.Fatalf("backoff step %d = %s, want %s", index, interval, expected)
		}
	}
}

func TestCoordinatorRejectsPollMaximumBelowInitialInterval(t *testing.T) {
	t.Parallel()

	_, err := NewCoordinator(CoordinatorConfig{
		WalletLease: time.Second, PendingWait: time.Second,
		PollInterval: 50 * time.Millisecond, PollMaximumInterval: 20 * time.Millisecond,
	}, NewMemoryRepository(), newTestWallet(10_000), DefinitionResolverFunc(
		func(context.Context, string, string, string) (game.Spinner, error) {
			return &countingSpinner{}, nil
		},
	))
	if err == nil {
		t.Fatal("NewCoordinator() accepted a poll maximum below the initial interval")
	}
}

func TestFreeSpinStateSurvivesAmbiguousWalletAndCoordinatorRestart(t *testing.T) {
	repository := NewMemoryRepository()
	session := baseSession()
	session.Revision = 7
	session.Sequence = 12
	session.BalanceMinor = 5_000
	session.Feature = game.FeatureState{
		Mode: game.FeatureOverdrive, Remaining: 2, Awarded: 8, BetMinor: 500,
		WinMinor: 1_200, RageLevel: game.DefaultRageLevel,
	}
	createTestSession(t, repository, session)
	nextFeature := game.FeatureState{
		Mode: game.FeatureOverdrive, Remaining: 1, Awarded: 8, BetMinor: 500,
		WinMinor: 2_200, RageLevel: game.DefaultRageLevel,
	}
	spinner := &countingSpinner{spin: func(input game.SpinInput) (game.SpinOutcome, error) {
		if !reflect.DeepEqual(input.Feature, session.Feature) || input.BetMinor != 500 {
			t.Fatalf("engine input = %+v", input)
		}
		outcome := payableOutcome(nextFeature)
		outcome.TotalWinMinor = 1_000
		outcome.Wins[0].AmountMinor = 1_000
		outcome.Wins[0].PathAwards[0].BaseAmountMinor = 1_000
		outcome.Wins[0].PathAwards[0].AmountMinor = 1_000
		return outcome, nil
	}}
	wallet := newTestWallet(5_000)
	wallet.ambiguousAfterApply = true
	wallet.lookupAllowed.Store(false)
	firstCoordinator := newTestCoordinator(t, repository, wallet, spinner, 12*time.Millisecond)
	request := baseRequest("round-free-recovery", 500, 7)
	request.RoundKind = RoundKindFreeSpin

	_, err := firstCoordinator.Spin(context.Background(), request)
	if !errors.Is(err, ErrWalletPending) {
		t.Fatalf("first free Spin error = %v, want ErrWalletPending", err)
	}
	record, err := repository.GetRound(context.Background(), request.Key())
	if err != nil {
		t.Fatal(err)
	}
	if record.Result.ChargedBetMinor != 0 || record.Result.FeatureState.Remaining != 1 ||
		record.Result.FeatureState.WinMinor != 2_200 {
		t.Fatalf("prepared free result = %+v", record.Result)
	}
	if wallet.balanceValue() != 6_000 {
		t.Fatalf("free-spin wallet balance = %d, want 6000", wallet.balanceValue())
	}

	// 新的 Coordinator 实例表示进程重启。持久化存储状态及钱包查询已足够，引擎绝不能再次运行。
	wallet.lookupAllowed.Store(true)
	secondCoordinator := newTestCoordinator(t, repository, wallet, spinner, time.Second)
	result, err := secondCoordinator.Reconcile(context.Background(), request.Key())
	if err != nil {
		t.Fatalf("recovered free Spin error = %v", err)
	}
	replayed, err := secondCoordinator.Spin(context.Background(), request)
	if err != nil || !reflect.DeepEqual(replayed, result) {
		t.Fatalf("replayed recovered free Spin = %+v, error=%v", replayed, err)
	}
	if result.ChargedBetMinor != 0 || result.BalanceMinor != 6_000 ||
		result.EndRevision != 8 || result.Sequence != 13 || result.FeatureState.Remaining != 1 ||
		result.FeatureState.WinMinor != 2_200 {
		t.Fatalf("recovered free result = %+v", result)
	}
	resumed, err := repository.GetSession(context.Background(), session.OperatorID, session.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if resumed.PendingRoundID != "" || resumed.Revision != 8 || resumed.Sequence != 13 ||
		resumed.Feature.Remaining != 1 || resumed.Feature.WinMinor != 2_200 || resumed.BalanceMinor != 6_000 {
		t.Fatalf("resumed free session = %+v", resumed)
	}
	delivery, err := secondCoordinator.GetPendingResultDelivery(
		context.Background(), session.OperatorID, session.SessionID,
	)
	if err != nil || delivery.RoundID != request.RoundID || delivery.Sequence != result.Sequence ||
		!reflect.DeepEqual(delivery.Result, result) {
		t.Fatalf("recovery delivery = %+v, error=%v", delivery, err)
	}
	if spinner.calls.Load() != 1 || wallet.applyCalls.Load() != 1 || wallet.economicApplyCount() != 1 {
		t.Fatalf("free recovery repeated effects: engine=%d wallet=%d economic=%d", spinner.calls.Load(), wallet.applyCalls.Load(), wallet.economicApplyCount())
	}
}

func TestCoordinatorRejectsKongRetriggerCounterDriftBeforeRoundAndWallet(t *testing.T) {
	repository := NewMemoryRepository()
	session := baseSession()
	session.Feature = game.FeatureState{
		Mode: game.FeatureExpansion, Remaining: 2, Awarded: 8, BetMinor: 100,
		WinMinor: 500, RageLevel: game.DefaultRageLevel,
	}
	createTestSession(t, repository, session)

	config := game.DemoConfig()
	config.Reels[0] = []game.WeightedSymbol{{Value: game.SymbolOrbit, Weight: 1}}
	config.Reels[1] = []game.WeightedSymbol{{Value: game.SymbolVault, Weight: 1}}
	config.Reels[2] = []game.WeightedSymbol{{Value: game.SymbolPulse, Weight: 1}}
	config.VaultMultipliers = []game.WeightedInt{{Value: 1, Weight: 1}}
	config.Feature.VaultFreeSpinWeight = 1
	config.Feature.VaultUnlockChanceBP = 10_000
	values := make([]uint64, 96)
	for index := range values {
		values[index] = 1
	}
	values[0] = 0 // Select the three-row Kong Quest result.
	engine, err := game.NewEngine(config, rng.NewSequenceSource(values...))
	if err != nil {
		t.Fatal(err)
	}
	input := game.SpinInput{BetMinor: 100, Feature: session.Feature}
	outcome, err := engine.Spin(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	awards := 0
	for _, event := range outcome.Events {
		if event.Type == "free_spin.awarded" {
			awards += event.Count
		}
	}
	if awards == 0 {
		t.Fatal("fixture did not produce an authoritative Kong Quest retrigger")
	}
	if err := game.ValidateOutcomeStructure(input, outcome); err != nil {
		t.Fatalf("valid retrigger fixture rejected before mutation: %v", err)
	}
	outcome.NextFeature.Awarded--

	spinner := &countingSpinner{spin: func(got game.SpinInput) (game.SpinOutcome, error) {
		if !reflect.DeepEqual(got, input) {
			t.Fatalf("engine input = %+v, want %+v", got, input)
		}
		return outcome, nil
	}}
	wallet := newTestWallet(session.BalanceMinor)
	coordinator := newTestCoordinator(t, repository, wallet, spinner, time.Second)
	request := baseRequest("round-invalid-retrigger", 100, session.Revision)
	request.RoundKind = RoundKindFreeSpin

	_, err = coordinator.Spin(context.Background(), request)
	if err == nil || !strings.Contains(err.Error(), "engine returned an invalid outcome") {
		t.Fatalf("Spin() error = %v, want invalid engine outcome", err)
	}
	if wallet.applyCalls.Load() != 0 || wallet.lookupCalls.Load() != 0 ||
		wallet.economicApplyCount() != 0 {
		t.Fatalf("invalid outcome reached wallet: apply=%d lookup=%d economic=%d",
			wallet.applyCalls.Load(), wallet.lookupCalls.Load(), wallet.economicApplyCount())
	}
	if _, err := repository.GetRound(context.Background(), request.Key()); !errors.Is(err, ErrRoundNotFound) {
		t.Fatalf("invalid outcome persisted a round: %v", err)
	}
	stored, err := repository.GetSession(context.Background(), session.OperatorID, session.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(stored.Feature, session.Feature) || stored.Revision != session.Revision ||
		stored.Sequence != session.Sequence || stored.BalanceMinor != session.BalanceMinor ||
		stored.PendingRoundID != "" {
		t.Fatalf("invalid outcome changed session: %+v", stored)
	}
}

func TestCanonicalResultIsDeepCopiedAcrossRepositoryAndReplay(t *testing.T) {
	repository := NewMemoryRepository()
	createTestSession(t, repository, baseSession())
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return payableOutcome(game.EmptyFeatureState()), nil
	}}
	wallet := newTestWallet(10_000)
	coordinator := newTestCoordinator(t, repository, wallet, spinner, time.Second)
	request := baseRequest("round-clone", 100, 0)

	result, err := coordinator.Spin(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	result.Grid[0][0].Symbol = game.SymbolNova
	result.Wins[0].Cells[0].Row = 2
	result.Events[0].Cells[0].Row = 2
	record, err := repository.GetRound(context.Background(), request.Key())
	if err != nil {
		t.Fatal(err)
	}
	record.Result.Grid[0][0].Symbol = game.SymbolPulse
	record.Result.Wins[0].Cells[0].Row = 1

	replayed, err := coordinator.Spin(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if replayed.Grid[0][0].Symbol != game.SymbolOrbit ||
		replayed.Wins[0].Cells[0] != (game.Position{Reel: 0, Row: 0}) ||
		replayed.Events[0].Cells[0] != (game.Position{Reel: 0, Row: 0}) {
		t.Fatalf("canonical result was mutated: %+v", replayed)
	}
}

func TestFingerprintCoversEveryRequiredEconomicField(t *testing.T) {
	base := baseRequest("round-fingerprint", 100, 9)
	want := FingerprintFor(base)
	mutations := []SpinRequest{
		func() SpinRequest { value := base; value.OperatorID = "operator-b"; return value }(),
		func() SpinRequest { value := base; value.SessionID = "session-b"; return value }(),
		func() SpinRequest { value := base; value.RoundID = "round-other"; return value }(),
		func() SpinRequest { value := base; value.GameID = "game-b"; return value }(),
		func() SpinRequest { value := base; value.DefinitionVersion = "math-v2"; return value }(),
		func() SpinRequest { value := base; value.DefinitionHash = strings.Repeat("b", 64); return value }(),
		func() SpinRequest { value := base; value.Currency = "EUR"; return value }(),
		func() SpinRequest { value := base; value.RoundKind = RoundKindBonus; return value }(),
		func() SpinRequest { value := base; value.BetMinor = 200; return value }(),
		func() SpinRequest { value := base; value.StartRevision = 10; return value }(),
	}
	for index, mutation := range mutations {
		if got := FingerprintFor(mutation); got == want {
			t.Fatalf("mutation %d did not change fingerprint", index)
		}
	}
}

type countingSpinner struct {
	calls atomic.Int64
	spin  func(game.SpinInput) (game.SpinOutcome, error)
}

type testRoundObserver struct {
	prepared     atomic.Int64
	committed    atomic.Int64
	replayed     atomic.Int64
	conflicts    atomic.Int64
	manualReview atomic.Int64
}

func (o *testRoundObserver) RoundPrepared()       { o.prepared.Add(1) }
func (o *testRoundObserver) RoundCommitted()      { o.committed.Add(1) }
func (o *testRoundObserver) RoundReplayed()       { o.replayed.Add(1) }
func (o *testRoundObserver) IdempotencyConflict() { o.conflicts.Add(1) }
func (o *testRoundObserver) RoundManualReview()   { o.manualReview.Add(1) }

type integrityFaultRepository struct {
	Repository
	key       RoundKey
	markedKey RoundKey
	reason    string
	markCalls int
}

func (r *integrityFaultRepository) GetRound(_ context.Context, key RoundKey) (RoundRecord, error) {
	if key != r.key {
		return RoundRecord{}, ErrRoundNotFound
	}
	return RoundRecord{}, ErrManualReview
}

func (r *integrityFaultRepository) MarkManualReview(
	_ context.Context,
	key RoundKey,
	reason string,
) (RoundRecord, bool, error) {
	r.markCalls++
	r.markedKey = key
	r.reason = reason
	return RoundRecord{Key: key, Status: RoundManualReview, FailureReason: reason}, r.markCalls == 1, nil
}

func (s *countingSpinner) Spin(_ context.Context, input game.SpinInput) (game.SpinOutcome, error) {
	s.calls.Add(1)
	return s.spin(input)
}

type testWallet struct {
	mu                  sync.Mutex
	balance             int64
	receipts            map[string]WalletReceipt
	economicApplies     int
	applyCalls          atomic.Int64
	lookupCalls         atomic.Int64
	rollbackCalls       atomic.Int64
	lookupAllowed       atomic.Bool
	ambiguousAfterApply bool
	applyDelay          time.Duration
	applyEntered        chan struct{}
	applyBlock          chan struct{}
	applyError          error
	enteredOnce         sync.Once
	profile             Profile
	profileError        error
	admitCalls          atomic.Int64
	admitError          error
}

type cancelAfterClaimRepository struct {
	Repository
	cancel context.CancelFunc
	once   sync.Once
}

func (repository *cancelAfterClaimRepository) ClaimWallet(
	ctx context.Context,
	key RoundKey,
	lease time.Duration,
) (WalletRecoveryClaim, bool, error) {
	claim, claimed, err := repository.Repository.ClaimWallet(ctx, key, lease)
	if claimed {
		repository.once.Do(repository.cancel)
	}
	return claim, claimed, err
}

func newTestWallet(balance int64) *testWallet {
	wallet := &testWallet{balance: balance, receipts: make(map[string]WalletReceipt)}
	wallet.lookupAllowed.Store(true)
	return wallet
}

func (w *testWallet) ApplyRound(ctx context.Context, command WalletRound) (WalletReceipt, error) {
	w.applyCalls.Add(1)
	if w.applyError != nil {
		return WalletReceipt{}, w.applyError
	}
	if w.applyEntered != nil {
		w.enteredOnce.Do(func() { close(w.applyEntered) })
	}
	if w.applyBlock != nil {
		select {
		case <-ctx.Done():
			return WalletReceipt{}, ctx.Err()
		case <-w.applyBlock:
		}
	}
	if w.applyDelay > 0 {
		timer := time.NewTimer(w.applyDelay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return WalletReceipt{}, ctx.Err()
		case <-timer.C:
		}
	}

	w.mu.Lock()
	receipt, exists := w.receipts[command.OperationID]
	if exists {
		w.mu.Unlock()
		if receipt.Fingerprint != command.Fingerprint {
			return WalletReceipt{}, ErrIdempotencyConflict
		}
		return receipt, nil
	}
	if w.balance < command.DebitMinor {
		w.mu.Unlock()
		return WalletReceipt{}, ErrWalletRejected
	}
	w.balance = w.balance - command.DebitMinor + command.CreditMinor
	receipt = WalletReceipt{
		OperationID: command.OperationID, Fingerprint: command.Fingerprint,
		TransactionID: "wallet-tx-" + command.RoundID,
		OperatorID:    command.OperatorID, Currency: command.Currency,
		DebitMinor: command.DebitMinor, CreditMinor: command.CreditMinor,
		BalanceMinor: w.balance,
	}
	w.receipts[command.OperationID] = receipt
	w.economicApplies++
	ambiguous := w.ambiguousAfterApply
	w.mu.Unlock()
	if ambiguous {
		return WalletReceipt{}, errors.New("wallet transport timed out after commit")
	}
	return receipt, nil
}

func (w *testWallet) ProfileFor(operatorID string) (Profile, error) {
	if operatorID != "operator-a" {
		return Profile{}, ErrWalletUnavailable
	}
	if w.profileError != nil {
		return Profile{}, w.profileError
	}
	if w.profile.ProfileID != "" {
		return w.profile, nil
	}
	return AtomicHTTPProfile(testWalletRouteBindingID()), nil
}

func (w *testWallet) AdmitNewIntent(operatorID string) error {
	w.admitCalls.Add(1)
	if operatorID != "operator-a" {
		return ErrWalletUnavailable
	}
	return w.admitError
}

func (w *testWallet) SubmitRound(ctx context.Context, command WalletRound) Resolution {
	receipt, err := w.ApplyRound(ctx, command)
	return testApplyResolution(receipt, err)
}

func (w *testWallet) Resolve(ctx context.Context, reference OperationRef) Resolution {
	receipt, found, err := w.Lookup(ctx, reference.OperatorID, reference.OperationID)
	switch {
	case err == nil && found:
		return Resolution{Status: ResolutionSucceeded, Receipt: receipt}
	case err == nil:
		return Resolution{Status: ResolutionNotFound}
	case errors.Is(err, ErrIdempotencyConflict), errors.Is(err, ErrWalletReceiptInvalid):
		return Resolution{Status: ResolutionConflict, Cause: err}
	default:
		return Resolution{Status: ResolutionUnknown, Cause: err}
	}
}

func testApplyResolution(receipt WalletReceipt, err error) Resolution {
	switch {
	case err == nil:
		return Resolution{Status: ResolutionSucceeded, Receipt: receipt}
	case errors.Is(err, ErrWalletRejected):
		return Resolution{Status: ResolutionRejectedFinal, Cause: err}
	case errors.Is(err, ErrIdempotencyConflict), errors.Is(err, ErrWalletReceiptInvalid):
		return Resolution{Status: ResolutionConflict, Cause: err}
	case errors.Is(err, ErrWalletUnavailable):
		return Resolution{Status: ResolutionNotSent, Cause: err}
	default:
		return Resolution{Status: ResolutionUnknown, Cause: err}
	}
}

func (w *testWallet) Lookup(_ context.Context, operatorID, operationID string) (WalletReceipt, bool, error) {
	w.lookupCalls.Add(1)
	if !w.lookupAllowed.Load() {
		return WalletReceipt{}, false, errors.New("wallet lookup unavailable")
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	receipt, exists := w.receipts[operationID]
	if exists && receipt.OperatorID != operatorID {
		return WalletReceipt{}, false, ErrWalletReceiptInvalid
	}
	return receipt, exists, nil
}

func (w *testWallet) Rollback(_ context.Context, rollback WalletRollback) (WalletReceipt, error) {
	w.rollbackCalls.Add(1)
	w.mu.Lock()
	defer w.mu.Unlock()
	receipt, exists := w.receipts[rollback.OperationID]
	if !exists || receipt.OperatorID != rollback.OperatorID {
		return WalletReceipt{}, ErrRoundNotFound
	}
	return receipt, nil
}

func (w *testWallet) balanceValue() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.balance
}

func (w *testWallet) economicApplyCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.economicApplies
}

func newTestCoordinator(
	t *testing.T,
	repository Repository,
	wallet WalletPort,
	spinner game.Spinner,
	pendingWait time.Duration,
	observers ...RoundObserver,
) *Coordinator {
	t.Helper()
	registry := DefinitionResolverFunc(func(_ context.Context, gameID, version, hash string) (game.Spinner, error) {
		if gameID != "game-a" || version != "math-v1" ||
			hash != strings.Repeat("a", 64) {
			return nil, errors.New("unknown definition")
		}
		return spinner, nil
	})
	coordinator, err := NewCoordinator(CoordinatorConfig{
		WalletLease: time.Second, PendingWait: pendingWait, PollInterval: time.Millisecond,
	}, repository, wallet, registry, observers...)
	if err != nil {
		t.Fatal(err)
	}
	return coordinator
}

func createTestSession(t *testing.T, repository Repository, session Session) {
	t.Helper()
	if err := repository.CreateSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
}

func baseSession() Session {
	return Session{
		OperatorID: "operator-a", SessionID: "session-a", PlayerID: "player-a",
		WalletAccountID: "wallet-a", WalletSessionID: "wallet-session-a",
		GameID: "game-a", DefinitionVersion: "math-v1", DefinitionHash: strings.Repeat("a", 64),
		Currency: "USD", CurrencyExponent: 2, Jurisdiction: "MT", Status: SessionActive,
		ExpiresAt: time.Now().Add(time.Hour), BalanceMinor: 10_000, Feature: game.EmptyFeatureState(),
	}
}

func testWalletRouteBindingID() string {
	return WalletRouteBindingIDForCanonicalTarget("https://wallet.test.invalid/ledger-a")
}

func baseRequest(roundID string, bet int64, revision uint64) SpinRequest {
	return SpinRequest{
		OperatorID: "operator-a", SessionID: "session-a", RoundID: roundID,
		GameID: "game-a", DefinitionVersion: "math-v1", Currency: "USD",
		DefinitionHash: strings.Repeat("a", 64), RoundKind: RoundKindBase,
		BetMinor: bet, StartRevision: revision,
	}
}

func payableOutcome(next game.FeatureState) game.SpinOutcome {
	return game.SpinOutcome{
		Grid: game.Grid{
			{{Symbol: game.SymbolOrbit}, {Symbol: game.SymbolPrism}, {Symbol: game.SymbolPulse}},
			{{Symbol: game.SymbolOrbit}, {Symbol: game.SymbolWild, Multiplier: 2}, {Symbol: game.SymbolPulse}},
			{{Symbol: game.SymbolOrbit}, {Symbol: game.SymbolPrism}, {Symbol: game.SymbolNova}},
		},
		Wins: []game.Win{{
			ID: "orbit-3", Symbol: game.SymbolOrbit, Ways: 1, AmountMinor: 50,
			Cells: []game.Position{{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0}},
			PathAwards: []game.PathAward{{
				Cells:      []game.Position{{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0}},
				Multiplier: 1, BaseAmountMinor: 50, AmountMinor: 50,
			}},
		}},
		Events: []game.Event{{
			Type: "test.marker", Count: 1,
			Cells: []game.Position{{Reel: 0, Row: 0}},
		}},
		TotalWinMinor: 50,
		NextFeature:   next,
	}
}
