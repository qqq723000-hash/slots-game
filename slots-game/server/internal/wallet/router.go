package wallet

import (
	"context"
	"errors"

	"slots-game/server/internal/rgs"
)

// Router 按已绑定到持久轮次的运营商身份分派钱包操作；路由表构造后不可变，
// 禁止由未验证请求字段动态选择钱包。
// English: The Router dispatches wallet operations by operator identity bound to a persistent round; the routing
// table is constructed immutable and dynamic selection of wallets by unverified request fields is prohibited.
type Router struct {
	ports map[string]routedWallet
}

// routedWallet 要求每个启动期绑定同时交付兼容门面、显式结果协议和新意图准入。
// Router 不会从旧接口猜测能力，也不会在运行中降级到不明确的资金语义。
// English: routedWallet requires each startup binding to also deliver a compatible facade, explicit result
// protocol, and new intent admission. Router will not guess capabilities from the old interface, nor will it
// degrade to ambiguous funding semantics on the fly.
type routedWallet interface {
	rgs.WalletPort
	rgs.WalletResolutionPort
	AdmitNewIntent(string) error
}

func NewRouter(ports map[string]rgs.WalletPort) (*Router, error) {
	if len(ports) == 0 {
		return nil, errors.New("wallet router: at least one operator adapter is required")
	}
	copyPorts := make(map[string]routedWallet, len(ports))
	for operatorID, port := range ports {
		if operatorID == "" || port == nil {
			return nil, errors.New("wallet router: invalid operator adapter")
		}
		routed, ok := port.(routedWallet)
		if !ok {
			return nil, errors.New("wallet router: adapter lacks explicit resolution or admission contract")
		}
		if _, duplicate := copyPorts[operatorID]; duplicate {
			return nil, errors.New("wallet router: duplicate operator adapter")
		}
		copyPorts[operatorID] = routed
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

func (r *Router) ProfileFor(operatorID string) (rgs.Profile, error) {
	port, err := r.resolve(operatorID)
	if err != nil {
		return rgs.Profile{}, errors.Join(rgs.ErrWalletUnavailable, err)
	}
	return port.ProfileFor(operatorID)
}

func (r *Router) SubmitRound(ctx context.Context, command rgs.WalletRound) rgs.Resolution {
	port, err := r.resolve(command.OperatorID)
	if err != nil {
		return rgs.Resolution{Status: rgs.ResolutionNotSent, Cause: errors.Join(rgs.ErrWalletUnavailable, err)}
	}
	return port.SubmitRound(ctx, command)
}

func (r *Router) Resolve(ctx context.Context, reference rgs.OperationRef) rgs.Resolution {
	port, err := r.resolve(reference.OperatorID)
	if err != nil {
		return rgs.Resolution{Status: rgs.ResolutionNotSent, Cause: errors.Join(rgs.ErrWalletUnavailable, err)}
	}
	return port.Resolve(ctx, reference)
}

func (r *Router) AdmitNewIntent(operatorID string) error {
	port, err := r.resolve(operatorID)
	if err != nil {
		return errors.Join(rgs.ErrWalletUnavailable, err)
	}
	return port.AdmitNewIntent(operatorID)
}

func (r *Router) resolve(operatorID string) (routedWallet, error) {
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
var _ rgs.WalletResolutionPort = (*Router)(nil)
