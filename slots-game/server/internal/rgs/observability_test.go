package rgs

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
)

func TestObservedWalletCountsCallsAndOnlyAmbiguousApplyOutcomes(t *testing.T) {
	next := newTestWallet(10_000)
	observer := &testWalletObserver{}
	wallet, err := NewObservedWallet(next, observer)
	if err != nil {
		t.Fatal(err)
	}
	command := WalletRound{OperatorID: "operator-a"}

	next.applyError = errors.New("transport disconnected after request write")
	if _, err := wallet.ApplyRound(context.Background(), command); err == nil {
		t.Fatal("ambiguous ApplyRound() error = nil")
	}
	next.applyError = ErrWalletPending
	if _, err := wallet.ApplyRound(context.Background(), command); !errors.Is(err, ErrWalletPending) {
		t.Fatalf("pending ApplyRound() error = %v", err)
	}
	next.applyError = ErrWalletRejected
	if _, err := wallet.ApplyRound(context.Background(), command); !errors.Is(err, ErrWalletRejected) {
		t.Fatalf("rejected ApplyRound() error = %v", err)
	}
	next.applyError = ErrIdempotencyConflict
	if _, err := wallet.ApplyRound(context.Background(), command); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("conflicting ApplyRound() error = %v", err)
	}
	_, _, _ = wallet.Lookup(context.Background(), "operator-a", "operation-a")
	_, _ = wallet.Rollback(context.Background(), WalletRollback{
		OperatorID: "operator-a", OperationID: "operation-a",
	})

	if got := observer.calls.Load(); got != 6 {
		t.Fatalf("wallet calls = %d, want 6", got)
	}
	if got := observer.unknown.Load(); got != 2 {
		t.Fatalf("unknown ApplyRound outcomes = %d, want 2", got)
	}
}

func TestObservedWalletObserverPanicCannotSuppressWalletCall(t *testing.T) {
	next := newTestWallet(10_000)
	wallet, err := NewObservedWallet(next, panicWalletObserver{})
	if err != nil {
		t.Fatal(err)
	}
	next.applyError = ErrWalletRejected
	if _, err := wallet.ApplyRound(context.Background(), WalletRound{OperatorID: "operator-a"}); !errors.Is(err, ErrWalletRejected) {
		t.Fatalf("ApplyRound() error = %v", err)
	}
	if got := next.applyCalls.Load(); got != 1 {
		t.Fatalf("underlying wallet calls = %d, want 1", got)
	}
}

type testWalletObserver struct {
	calls   atomic.Int64
	unknown atomic.Int64
}

func (o *testWalletObserver) WalletCall()           { o.calls.Add(1) }
func (o *testWalletObserver) WalletUnknownOutcome() { o.unknown.Add(1) }

type panicWalletObserver struct{}

func (panicWalletObserver) WalletCall()           { panic("metric observer") }
func (panicWalletObserver) WalletUnknownOutcome() { panic("metric observer") }
