package wallet

import (
	"context"
	"errors"
	"testing"

	"slots-game/server/internal/rgs"
)

type routerStub struct {
	operator        string
	profileCalls    int
	submitCalls     int
	resolutionCalls int
	admissionCalls  int
}

type legacyRouterPort struct{ next *routerStub }

func (port legacyRouterPort) ApplyRound(ctx context.Context, command rgs.WalletRound) (rgs.WalletReceipt, error) {
	return port.next.ApplyRound(ctx, command)
}

func (port legacyRouterPort) Lookup(ctx context.Context, operatorID, operationID string) (rgs.WalletReceipt, bool, error) {
	return port.next.Lookup(ctx, operatorID, operationID)
}

func (port legacyRouterPort) Rollback(ctx context.Context, command rgs.WalletRollback) (rgs.WalletReceipt, error) {
	return port.next.Rollback(ctx, command)
}

func (s *routerStub) ApplyRound(_ context.Context, command rgs.WalletRound) (rgs.WalletReceipt, error) {
	if command.OperatorID != s.operator {
		return rgs.WalletReceipt{}, errors.New("misrouted apply")
	}
	return rgs.WalletReceipt{OperatorID: command.OperatorID}, nil
}

func (s *routerStub) Lookup(_ context.Context, operatorID, _ string) (rgs.WalletReceipt, bool, error) {
	if operatorID != s.operator {
		return rgs.WalletReceipt{}, false, errors.New("misrouted lookup")
	}
	return rgs.WalletReceipt{OperatorID: operatorID}, true, nil
}

func (s *routerStub) Rollback(_ context.Context, command rgs.WalletRollback) (rgs.WalletReceipt, error) {
	if command.OperatorID != s.operator {
		return rgs.WalletReceipt{}, errors.New("misrouted rollback")
	}
	return rgs.WalletReceipt{OperatorID: command.OperatorID}, nil
}

func (s *routerStub) ProfileFor(operatorID string) (rgs.Profile, error) {
	if operatorID != s.operator {
		return rgs.Profile{}, errors.New("misrouted profile")
	}
	s.profileCalls++
	return rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget("https://wallet.test.invalid/ledger")), nil
}

func (s *routerStub) SubmitRound(_ context.Context, command rgs.WalletRound) rgs.Resolution {
	if command.OperatorID != s.operator {
		return rgs.Resolution{Status: rgs.ResolutionNotSent, Cause: errors.New("misrouted submit")}
	}
	s.submitCalls++
	return rgs.Resolution{
		Status:  rgs.ResolutionSucceeded,
		Receipt: rgs.WalletReceipt{OperatorID: command.OperatorID},
	}
}

func (s *routerStub) Resolve(_ context.Context, reference rgs.OperationRef) rgs.Resolution {
	if reference.OperatorID != s.operator {
		return rgs.Resolution{Status: rgs.ResolutionNotSent, Cause: errors.New("misrouted resolve")}
	}
	s.resolutionCalls++
	return rgs.Resolution{Status: rgs.ResolutionNotFound}
}

func (s *routerStub) AdmitNewIntent(operatorID string) error {
	if operatorID != s.operator {
		return errors.New("misrouted admission")
	}
	s.admissionCalls++
	return nil
}

func TestRouterUsesVerifiedRoundTenant(t *testing.T) {
	router, err := NewRouter(map[string]rgs.WalletPort{
		"operator-a": &routerStub{operator: "operator-a"},
		"operator-b": &routerStub{operator: "operator-b"},
	})
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := router.ApplyRound(context.Background(), rgs.WalletRound{OperatorID: "operator-b"})
	if err != nil || receipt.OperatorID != "operator-b" {
		t.Fatalf("ApplyRound = %+v, %v", receipt, err)
	}
	if _, _, err := router.Lookup(context.Background(), "unknown", "operation"); !errors.Is(err, rgs.ErrWalletReceiptInvalid) {
		t.Fatalf("unknown tenant error = %v", err)
	}
}

func TestRouterRejectsLegacyOnlyAdapterAtStartup(t *testing.T) {
	_, err := NewRouter(map[string]rgs.WalletPort{
		"operator-a": legacyRouterPort{next: &routerStub{operator: "operator-a"}},
	})
	if err == nil {
		t.Fatal("legacy-only adapter unexpectedly passed strict router construction")
	}
}

func TestRouterForwardsResolutionContractByPersistedTenant(t *testing.T) {
	portA := &routerStub{operator: "operator-a"}
	portB := &routerStub{operator: "operator-b"}
	router, err := NewRouter(map[string]rgs.WalletPort{
		"operator-a": portA,
		"operator-b": portB,
	})
	if err != nil {
		t.Fatal(err)
	}

	profile, err := router.ProfileFor("operator-b")
	if err != nil || profile.ProfileID != rgs.AtomicHTTPProfileID || portB.profileCalls != 1 {
		t.Fatalf("ProfileFor() = %+v, %v calls=%d", profile, err, portB.profileCalls)
	}
	submitted := router.SubmitRound(context.Background(), rgs.WalletRound{OperatorID: "operator-b"})
	if submitted.Status != rgs.ResolutionSucceeded || portA.submitCalls != 0 || portB.submitCalls != 1 {
		t.Fatalf("SubmitRound() = %+v callsA=%d callsB=%d", submitted, portA.submitCalls, portB.submitCalls)
	}
	resolved := router.Resolve(context.Background(), rgs.OperationRef{OperatorID: "operator-b"})
	if resolved.Status != rgs.ResolutionNotFound || portA.resolutionCalls != 0 || portB.resolutionCalls != 1 {
		t.Fatalf("Resolve() = %+v callsA=%d callsB=%d", resolved, portA.resolutionCalls, portB.resolutionCalls)
	}
	if err := router.AdmitNewIntent("operator-b"); err != nil || portA.admissionCalls != 0 || portB.admissionCalls != 1 {
		t.Fatalf("AdmitNewIntent() error=%v callsA=%d callsB=%d", err, portA.admissionCalls, portB.admissionCalls)
	}

	unknown := router.SubmitRound(context.Background(), rgs.WalletRound{OperatorID: "unknown"})
	if unknown.Status != rgs.ResolutionNotSent || !errors.Is(unknown.Cause, rgs.ErrWalletReceiptInvalid) {
		t.Fatalf("unknown tenant resolution = %+v", unknown)
	}
}
