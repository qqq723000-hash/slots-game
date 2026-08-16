package wallet

import (
	"context"
	"errors"
	"testing"

	"slots-game/server/internal/rgs"
)

type routerStub struct {
	operator string
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
