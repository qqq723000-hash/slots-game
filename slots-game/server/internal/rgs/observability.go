package rgs

import (
	"context"
	"errors"

	"go.opentelemetry.io/otel/trace"

	"slots-game/server/internal/telemetry"
)

// RoundObserver 接收有界基数业务事件。实现不得将运营商、玩家、会话、轮次或交易标识附加为标签。
// 仅当存储库报告已持久改变状态时才发出转换回调；重放与冲突回调描述一次已完成的协调器请求结果。
// English: RoundObserver receives bounded cardinality business events. Implementations MUST not append operator,
// player, session, round, or transaction identifiers as tags. Transition callbacks are emitted only when the
// repository reports a persistent change in state; replay and conflict callbacks describe the results of a
// completed coordinator request.
type RoundObserver interface {
	RoundPrepared()
	RoundCommitted()
	RoundReplayed()
	IdempotencyConflict()
	RoundManualReview()
}

// WalletObserver 记录真实适配器调用。只有 ApplyRound 结果的经济状态无法归类为成功、拒绝、
// 冲突或无效回执时，才发出 WalletUnknownOutcome。
// English: WalletObserver records real adapter calls. WalletUnknownOutcome is issued only if the economic status
// of the ApplyRound result cannot be classified as success, rejection, conflict, or invalid receipt.
type WalletObserver interface {
	WalletCall()
	WalletUnknownOutcome()
}

// IntegrityObserver 与普通轮次状态观测保持分离。只有写入首个持久隔离标记的事务会发出回调；
// 回调必须使用不含实体标识标签的有界基数计数器。
// English: IntegrityObserver remains separate from normal round state observations. Only the transaction that
// writes the first durable isolation token issues a callback; the callback must use a bounded cardinality counter
// without an entity identification tag.
type IntegrityObserver interface {
	RoundIntegrityQuarantined()
	SessionIntegrityQuarantined()
}

// ObservedWallet 装饰钱包端口，但不改变其经济或幂等行为。
// English: ObservedWallet decorates the wallet port but does not change its economic or idempotent behavior.
type ObservedWallet struct {
	next           WalletPort
	nextResolution WalletResolutionPort
	observer       WalletObserver
}

func NewObservedWallet(next WalletPort, observer WalletObserver) (*ObservedWallet, error) {
	if next == nil || observer == nil {
		return nil, errors.New("rgs: wallet and observer are required")
	}
	resolution, _ := next.(WalletResolutionPort)
	return &ObservedWallet{next: next, nextResolution: resolution, observer: observer}, nil
}

func (w *ObservedWallet) ApplyRound(ctx context.Context, command WalletRound) (receipt WalletReceipt, err error) {
	ctx, span := telemetry.Start(ctx, "rgs.wallet.apply", trace.WithSpanKind(trace.SpanKindClient))
	defer func() { telemetry.End(span, err) }()
	notifyWalletObserver(w.observer, func(observer WalletObserver) { observer.WalletCall() })
	receipt, err = w.next.ApplyRound(ctx, command)
	if unknownWalletApplyOutcome(err) {
		notifyWalletObserver(w.observer, func(observer WalletObserver) { observer.WalletUnknownOutcome() })
	}
	return receipt, err
}

func (w *ObservedWallet) Lookup(ctx context.Context, operatorID, operationID string) (receipt WalletReceipt, found bool, err error) {
	ctx, span := telemetry.Start(ctx, "rgs.wallet.lookup", trace.WithSpanKind(trace.SpanKindClient))
	defer func() { telemetry.End(span, err) }()
	notifyWalletObserver(w.observer, func(observer WalletObserver) { observer.WalletCall() })
	return w.next.Lookup(ctx, operatorID, operationID)
}

func (w *ObservedWallet) Rollback(ctx context.Context, rollback WalletRollback) (receipt WalletReceipt, err error) {
	ctx, span := telemetry.Start(ctx, "rgs.wallet.rollback", trace.WithSpanKind(trace.SpanKindClient))
	defer func() { telemetry.End(span, err) }()
	notifyWalletObserver(w.observer, func(observer WalletObserver) { observer.WalletCall() })
	return w.next.Rollback(ctx, rollback)
}

func (w *ObservedWallet) ProfileFor(operatorID string) (Profile, error) {
	if w == nil || w.nextResolution == nil {
		return Profile{}, ErrWalletUnavailable
	}
	return w.nextResolution.ProfileFor(operatorID)
}

func (w *ObservedWallet) SubmitRound(ctx context.Context, command WalletRound) Resolution {
	ctx, span := telemetry.Start(ctx, "rgs.wallet.submit", trace.WithSpanKind(trace.SpanKindClient))
	if w == nil || w.nextResolution == nil {
		result := Resolution{Status: ResolutionNotSent, Cause: ErrWalletUnavailable}
		telemetry.End(span, result.Cause)
		return result
	}
	notifyWalletObserver(w.observer, func(observer WalletObserver) { observer.WalletCall() })
	result := w.nextResolution.SubmitRound(ctx, command)
	if result.Status == ResolutionUnknown {
		notifyWalletObserver(w.observer, func(observer WalletObserver) { observer.WalletUnknownOutcome() })
	}
	telemetry.End(span, result.Cause)
	return result
}

func (w *ObservedWallet) Resolve(ctx context.Context, reference OperationRef) Resolution {
	ctx, span := telemetry.Start(ctx, "rgs.wallet.resolve", trace.WithSpanKind(trace.SpanKindClient))
	if w == nil || w.nextResolution == nil {
		result := Resolution{Status: ResolutionNotSent, Cause: ErrWalletUnavailable}
		telemetry.End(span, result.Cause)
		return result
	}
	notifyWalletObserver(w.observer, func(observer WalletObserver) { observer.WalletCall() })
	result := w.nextResolution.Resolve(ctx, reference)
	if result.Status == ResolutionUnknown {
		notifyWalletObserver(w.observer, func(observer WalletObserver) { observer.WalletUnknownOutcome() })
	}
	telemetry.End(span, result.Cause)
	return result
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
var _ WalletResolutionPort = (*ObservedWallet)(nil)
