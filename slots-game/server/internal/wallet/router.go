package wallet

import (
	"context"
	"errors"

	"slots-game/server/internal/rgs"
)

// Router 按已绑定到持久轮次的运营商身份分派钱包操作；路由表构造后不可变，
// 禁止由未验证请求字段动态选择钱包。
type Router struct {
	ports map[string]rgs.WalletPort
}

func NewRouter(ports map[string]rgs.WalletPort) (*Router, error) {
	if len(ports) == 0 {
		return nil, errors.New("wallet router: at least one operator adapter is required")
	}
	copyPorts := make(map[string]rgs.WalletPort, len(ports))
	for operatorID, port := range ports {
		if operatorID == "" || port == nil {
			return nil, errors.New("wallet router: invalid operator adapter")
		}
		if _, duplicate := copyPorts[operatorID]; duplicate {
			return nil, errors.New("wallet router: duplicate operator adapter")
		}
		copyPorts[operatorID] = port
	}
	return &Router{ports: copyPorts}, nil
}

func (r *Router) ApplyRound(ctx context.Context, command rgs.WalletRound) (rgs.WalletReceipt, error) {
	port, err := r.resolve(command.OperatorID)
	if err != nil {
		return rgs.WalletReceipt{}, err
	}
	return port.ApplyRound(ctx, command)
}

func (r *Router) Lookup(
	ctx context.Context,
	operatorID, operationID string,
) (rgs.WalletReceipt, bool, error) {
	port, err := r.resolve(operatorID)
	if err != nil {
		return rgs.WalletReceipt{}, false, err
	}
	return port.Lookup(ctx, operatorID, operationID)
}

func (r *Router) Rollback(ctx context.Context, rollback rgs.WalletRollback) (rgs.WalletReceipt, error) {
	port, err := r.resolve(rollback.OperatorID)
	if err != nil {
		return rgs.WalletReceipt{}, err
	}
	return port.Rollback(ctx, rollback)
}

func (r *Router) resolve(operatorID string) (rgs.WalletPort, error) {
	if r == nil {
		return nil, rgs.ErrWalletReceiptInvalid
	}
	port, exists := r.ports[operatorID]
	if !exists {
		return nil, rgs.ErrWalletReceiptInvalid
	}
	return port, nil
}

var _ rgs.WalletPort = (*Router)(nil)
