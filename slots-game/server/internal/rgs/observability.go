package rgs

import (
	"context"
	"errors"
)

// RoundObserver 接收有界基数业务事件。实现不得将运营商、玩家、会话、轮次或交易标识附加为标签。
// 仅当存储库报告已持久改变状态时才发出转换回调；重放与冲突回调描述一次已完成的协调器请求结果。
type RoundObserver interface {
	RoundPrepared()
	RoundCommitted()
	RoundReplayed()
	IdempotencyConflict()
	RoundManualReview()
}

// WalletObserver 记录真实适配器调用。只有 ApplyRound 结果的经济状态无法归类为成功、拒绝、
// 冲突或无效回执时，才发出 WalletUnknownOutcome。
type WalletObserver interface {
	WalletCall()
	WalletUnknownOutcome()
}

// IntegrityObserver 与普通轮次状态观测保持分离。只有写入首个持久隔离标记的事务会发出回调；
// 回调必须使用不含实体标识标签的有界基数计数器。
type IntegrityObserver interface {
	RoundIntegrityQuarantined()
	SessionIntegrityQuarantined()
}

// ObservedWallet 装饰钱包端口，但不改变其经济或幂等行为。
type ObservedWallet struct {
	next     WalletPort
	observer WalletObserver
}

func NewObservedWallet(next WalletPort, observer WalletObserver) (*ObservedWallet, error) {
	if next == nil || observer == nil {
		return nil, errors.New("rgs: wallet and observer are required")
	}
	return &ObservedWallet{next: next, observer: observer}, nil
}

func (w *ObservedWallet) ApplyRound(ctx context.Context, command WalletRound) (WalletReceipt, error) {
	notifyWalletObserver(w.observer, func(observer WalletObserver) { observer.WalletCall() })
	receipt, err := w.next.ApplyRound(ctx, command)
	if unknownWalletApplyOutcome(err) {
		notifyWalletObserver(w.observer, func(observer WalletObserver) { observer.WalletUnknownOutcome() })
	}
	return receipt, err
}

func (w *ObservedWallet) Lookup(ctx context.Context, operatorID, operationID string) (WalletReceipt, bool, error) {
	notifyWalletObserver(w.observer, func(observer WalletObserver) { observer.WalletCall() })
	return w.next.Lookup(ctx, operatorID, operationID)
}

func (w *ObservedWallet) Rollback(ctx context.Context, rollback WalletRollback) (WalletReceipt, error) {
	notifyWalletObserver(w.observer, func(observer WalletObserver) { observer.WalletCall() })
	return w.next.Rollback(ctx, rollback)
}

func unknownWalletApplyOutcome(err error) bool {
	return err != nil &&
		!errors.Is(err, ErrWalletRejected) &&
		!errors.Is(err, ErrIdempotencyConflict) &&
		!errors.Is(err, ErrWalletReceiptInvalid)
}

func notifyRoundObserver(observer RoundObserver, notify func(RoundObserver)) {
	if observer == nil {
		return
	}
	defer func() { _ = recover() }()
	notify(observer)
}

func notifyWalletObserver(observer WalletObserver, notify func(WalletObserver)) {
	if observer == nil {
		return
	}
	defer func() { _ = recover() }()
	notify(observer)
}

var _ WalletPort = (*ObservedWallet)(nil)
