package rgs

import (
	"context"
	"errors"
	"fmt"
	"time"

	"slots-game/server/internal/game"
)

// DefinitionRegistry 只解析不可变且已批准的游戏定义版本；禁止静默回退到更新版本。
type DefinitionRegistry interface {
	Resolve(context.Context, string, string, string) (game.Spinner, error)
}

type DefinitionResolverFunc func(context.Context, string, string, string) (game.Spinner, error)

func (f DefinitionResolverFunc) Resolve(ctx context.Context, gameID, version, hash string) (game.Spinner, error) {
	return f(ctx, gameID, version, hash)
}

type CoordinatorConfig struct {
	WalletLease         time.Duration
	PendingWait         time.Duration
	PollInterval        time.Duration
	PollMaximumInterval time.Duration
	MaxWalletAttempts   int
}

type Coordinator struct {
	repository          Repository
	wallet              WalletPort
	definitions         DefinitionRegistry
	walletLease         time.Duration
	pendingWait         time.Duration
	pollInterval        time.Duration
	pollMaximumInterval time.Duration
	maxWalletAttempts   int
	observer            RoundObserver
}

const persistedRoundIntegrityFailure = "persisted round integrity validation failed"

func NewCoordinator(
	config CoordinatorConfig,
	repository Repository,
	wallet WalletPort,
	definitions DefinitionRegistry,
	observers ...RoundObserver,
) (*Coordinator, error) {
	if repository == nil || wallet == nil || definitions == nil {
		return nil, errors.New("rgs: repository, wallet, and definition registry are required")
	}
	if config.WalletLease < 0 || config.PendingWait < 0 || config.PollInterval < 0 ||
		config.PollMaximumInterval < 0 {
		return nil, errors.New("rgs: coordinator durations cannot be negative")
	}
	if config.MaxWalletAttempts < 0 || config.MaxWalletAttempts > 10_000 {
		return nil, errors.New("rgs: invalid maximum wallet attempts")
	}
	if len(observers) > 1 {
		return nil, errors.New("rgs: at most one round observer is supported")
	}
	if config.WalletLease == 0 {
		config.WalletLease = 5 * time.Second
	}
	if config.PendingWait == 0 {
		config.PendingWait = time.Second
	}
	if config.PollInterval == 0 {
		config.PollInterval = 5 * time.Millisecond
	}
	if config.PollMaximumInterval == 0 {
		config.PollMaximumInterval = 250 * time.Millisecond
	}
	if config.PollMaximumInterval < config.PollInterval {
		return nil, errors.New("rgs: poll maximum interval cannot be below the initial interval")
	}
	if config.MaxWalletAttempts == 0 {
		config.MaxWalletAttempts = 100
	}
	return &Coordinator{
		repository: repository, wallet: wallet, definitions: definitions,
		walletLease: config.WalletLease, pendingWait: config.PendingWait,
		pollInterval: config.PollInterval, pollMaximumInterval: config.PollMaximumInterval,
		maxWalletAttempts: config.MaxWalletAttempts,
		observer:          firstRoundObserver(observers),
	}, nil
}

// Spin 在调用外部钱包前先准备并持久化不可变结果，再执行原子扣款/派彩命令并提交会话迁移。
// 所有重试都必须先解析已持久化的轮次聚合，绝不能重新运行 RNG。
func (c *Coordinator) Spin(ctx context.Context, request SpinRequest) (SpinResult, error) {
	if err := validateSpinRequest(request); err != nil {
		return SpinResult{}, err
	}
	fingerprint := FingerprintFor(request)
	record, prepared, err := c.repository.PrepareRound(ctx, request, fingerprint, func(session Session) (SpinResult, error) {
		return c.prepareOutcome(ctx, session, request)
	})
	if err != nil {
		if errors.Is(err, ErrIdempotencyConflict) {
			c.observe(func(observer RoundObserver) { observer.IdempotencyConflict() })
		}
		return SpinResult{}, err
	}
	if prepared {
		c.observe(func(observer RoundObserver) { observer.RoundPrepared() })
	}
	result, err := c.resolveRound(ctx, record)
	if err == nil && !prepared {
		c.observe(func(observer RoundObserver) { observer.RoundReplayed() })
	}
	return result, err
}

// Reconcile 恢复已经准备好的轮次，不会再次计算游戏数学；并发工作器和进程重启均可安全调用。
func (c *Coordinator) Reconcile(ctx context.Context, key RoundKey) (SpinResult, error) {
	if err := validateRoundKey(key); err != nil {
		return SpinResult{}, fmt.Errorf("%w: invalid recovery round key", ErrInvalidRequest)
	}
	record, err := c.repository.GetRound(ctx, key)
	if err != nil {
		if errors.Is(err, ErrManualReview) {
			return SpinResult{}, c.quarantinePersistedRound(ctx, key)
		}
		return SpinResult{}, err
	}
	return c.resolveRound(ctx, record)
}

// GetRound 是只读状态查询路径。持久化完整性校验失败时，它只允许执行故障安全隔离迁移；
// 禁止计算游戏数学、领取钱包租约或调用钱包。状态读取统一经过协调器，可防止轮询首次发现的
// 损坏记录继续具备经济操作资格。
func (c *Coordinator) GetRound(ctx context.Context, key RoundKey) (RoundRecord, error) {
	if err := validateRoundKey(key); err != nil {
		return RoundRecord{}, err
	}
	record, err := c.repository.GetRound(ctx, key)
	if err == nil {
		return record, nil
	}
	if errors.Is(err, ErrManualReview) {
		return RoundRecord{}, c.quarantinePersistedRound(ctx, key)
	}
	return RoundRecord{}, err
}

// GetPendingResultDelivery 查询令牌绑定会话中唯一尚未确认交付的已提交结果，
// 不要求客户端自行保留 roundId 字段。
func (c *Coordinator) GetPendingResultDelivery(ctx context.Context, operatorID, sessionID string) (ResultDelivery, error) {
	if !identifierPattern.MatchString(operatorID) || !identifierPattern.MatchString(sessionID) {
		return ResultDelivery{}, ErrInvalidRequest
	}
	delivery, err := c.repository.GetPendingResultDelivery(ctx, operatorID, sessionID)
	if err != nil {
		return ResultDelivery{}, err
	}
	if err := ValidateResultDelivery(delivery); err != nil {
		return ResultDelivery{}, ErrManualReview
	}
	return delivery, nil
}

// AcknowledgeResultDelivery 只记录客户端已消费不可变的提交结果；
// 经济状态早已由 CommitRound 最终确定，此操作不得修改余额或特性状态。
func (c *Coordinator) AcknowledgeResultDelivery(
	ctx context.Context,
	receipt ResultDeliveryAcknowledgement,
) (ResultDelivery, bool, error) {
	if err := ValidateResultDeliveryAcknowledgement(receipt); err != nil {
		return ResultDelivery{}, false, err
	}
	return c.repository.AcknowledgeResultDelivery(ctx, receipt)
}

func (c *Coordinator) prepareOutcome(ctx context.Context, session Session, request SpinRequest) (SpinResult, error) {
	charged := request.BetMinor
	if session.Feature.Active() {
		if session.Feature.BetMinor != request.BetMinor {
			return SpinResult{}, fmt.Errorf("%w: feature bet is locked to %d", ErrInvalidRequest, session.Feature.BetMinor)
		}
		charged = 0
	}
	definition, err := c.definitions.Resolve(
		ctx, request.GameID, request.DefinitionVersion, request.DefinitionHash,
	)
	if err != nil {
		return SpinResult{}, fmt.Errorf("rgs: resolve game definition: %w", err)
	}
	if definition == nil {
		return SpinResult{}, errors.New("rgs: definition registry returned a nil engine")
	}
	outcome, err := definition.Spin(ctx, game.SpinInput{BetMinor: request.BetMinor, Feature: session.Feature})
	if err != nil {
		return SpinResult{}, fmt.Errorf("rgs: evaluate spin: %w", err)
	}
	if outcome.TotalWinMinor < 0 {
		return SpinResult{}, fmt.Errorf("%w: engine returned a negative win", ErrInvalidRequest)
	}
	if err := game.ValidateOutcomeStructure(
		game.SpinInput{BetMinor: request.BetMinor, Feature: session.Feature},
		outcome,
	); err != nil {
		return SpinResult{}, fmt.Errorf("rgs: engine returned an invalid outcome: %w", err)
	}
	return SpinResult{
		OperatorID: request.OperatorID, SessionID: request.SessionID,
		RoundID: request.RoundID, GameID: request.GameID,
		DefinitionVersion: request.DefinitionVersion, DefinitionHash: request.DefinitionHash,
		Currency: request.Currency, RoundKind: request.RoundKind,
		ServerTransactionID: walletOperationID(request),
		StartRevision:       request.StartRevision, Sequence: session.Sequence + 1,
		BetMinor: request.BetMinor, ChargedBetMinor: charged,
		TotalWinMinor: outcome.TotalWinMinor, Grid: cloneGrid(outcome.Grid),
		Wins: cloneWins(outcome.Wins), Events: cloneEvents(outcome.Events),
		FeatureState: outcome.NextFeature,
	}, nil
}

func (c *Coordinator) resolveRound(ctx context.Context, initial RoundRecord) (SpinResult, error) {
	deadline := time.Now().Add(c.pendingWait)
	pollInterval := c.pollInterval
	record := initial
	for {
		if result, done, err := terminalRoundResult(record); done {
			return result, err
		}

		now := time.Now()
		claimed, ownsWallet, err := c.repository.ClaimWallet(
			ctx, record.Key, now, now.Add(c.walletLease),
		)
		if err != nil {
			if errors.Is(err, ErrSessionIntegrity) {
				return SpinResult{}, ErrSessionIntegrity
			}
			if errors.Is(err, ErrManualReview) {
				return SpinResult{}, c.quarantinePersistedRound(ctx, record.Key)
			}
			return SpinResult{}, err
		}
		record = claimed
		if result, done, err := terminalRoundResult(record); done {
			return result, err
		}

		if ownsWallet {
			if record.RetryCount > c.maxWalletAttempts {
				if _, changed, err := c.repository.MarkManualReview(
					ctx, record.Key, "wallet retry limit exceeded",
				); err != nil {
					return SpinResult{}, err
				} else if changed {
					c.observe(func(observer RoundObserver) { observer.RoundManualReview() })
				}
				return SpinResult{}, ErrManualReview
			}
			receipt, applyErr := c.wallet.ApplyRound(ctx, record.WalletCommand)
			switch {
			case applyErr == nil:
				return c.commitReceipt(ctx, record.Key, receipt)
			case errors.Is(applyErr, ErrWalletRejected):
				if _, _, err := c.repository.RejectRound(ctx, record.Key, applyErr.Error()); err != nil {
					return SpinResult{}, err
				}
				return SpinResult{}, ErrWalletRejected
			case errors.Is(applyErr, ErrIdempotencyConflict),
				errors.Is(applyErr, ErrWalletReceiptInvalid):
				if errors.Is(applyErr, ErrIdempotencyConflict) {
					c.observe(func(observer RoundObserver) { observer.IdempotencyConflict() })
				}
				if _, changed, err := c.repository.MarkManualReview(ctx, record.Key, applyErr.Error()); err != nil {
					return SpinResult{}, errors.Join(applyErr, err)
				} else if changed {
					c.observe(func(observer RoundObserver) { observer.RoundManualReview() })
				}
				return SpinResult{}, ErrManualReview
			default:
				// 未知传输/服务端故障的资金结果不确定；必须保留 WALLET_PENDING，
				// 并用稳定操作标识查询，禁止重新扣款或重新运行 RNG。
			}
		}

		receipt, found, lookupErr := c.wallet.Lookup(
			ctx, record.WalletCommand.OperatorID, record.WalletCommand.OperationID,
		)
		if lookupErr == nil && found {
			return c.commitReceipt(ctx, record.Key, receipt)
		}
		if errors.Is(lookupErr, ErrIdempotencyConflict) ||
			errors.Is(lookupErr, ErrWalletReceiptInvalid) {
			if errors.Is(lookupErr, ErrIdempotencyConflict) {
				c.observe(func(observer RoundObserver) { observer.IdempotencyConflict() })
			}
			if _, changed, err := c.repository.MarkManualReview(ctx, record.Key, lookupErr.Error()); err != nil {
				return SpinResult{}, errors.Join(lookupErr, err)
			} else if changed {
				c.observe(func(observer RoundObserver) { observer.RoundManualReview() })
			}
			return SpinResult{}, ErrManualReview
		}

		latest, err := c.repository.GetRound(ctx, record.Key)
		if err != nil {
			if errors.Is(err, ErrManualReview) {
				return SpinResult{}, c.quarantinePersistedRound(ctx, record.Key)
			}
			return SpinResult{}, err
		}
		record = latest
		if result, done, err := terminalRoundResult(record); done {
			return result, err
		}
		now = time.Now()
		if !now.Before(deadline) {
			return SpinResult{}, ErrWalletPending
		}
		wait := pollInterval
		if remaining := time.Until(deadline); wait > remaining {
			wait = remaining
		}
		if err := waitForPoll(ctx, wait); err != nil {
			return SpinResult{}, err
		}
		// 钱包结果待定时采用有上限的指数退避，避免每个并发请求以固定高频率
		// 轮询数据库和钱包；上限同时保证外部结算完成后仍能及时收敛。
		pollInterval = nextPollInterval(pollInterval, c.pollMaximumInterval)
	}
}

func (c *Coordinator) quarantinePersistedRound(ctx context.Context, key RoundKey) error {
	_, changed, err := c.repository.MarkManualReview(ctx, key, persistedRoundIntegrityFailure)
	if err != nil {
		return errors.Join(ErrManualReview, err)
	}
	if changed {
		c.observe(func(observer RoundObserver) { observer.RoundManualReview() })
	}
	return ErrManualReview
}

func (c *Coordinator) commitReceipt(ctx context.Context, key RoundKey, receipt WalletReceipt) (SpinResult, error) {
	record, changed, err := c.repository.CommitRound(ctx, key, receipt)
	if err == nil {
		if changed {
			c.observe(func(observer RoundObserver) { observer.RoundCommitted() })
		}
		return cloneSpinResult(record.Result), nil
	}
	if errors.Is(err, ErrSessionIntegrity) {
		return SpinResult{}, ErrSessionIntegrity
	}
	if errors.Is(err, ErrWalletReceiptInvalid) || errors.Is(err, ErrManualReview) {
		_, manualReviewChanged, markErr := c.repository.MarkManualReview(ctx, key, err.Error())
		if markErr != nil {
			return SpinResult{}, errors.Join(err, markErr)
		}
		if manualReviewChanged {
			c.observe(func(observer RoundObserver) { observer.RoundManualReview() })
		}
		return SpinResult{}, ErrManualReview
	}
	return SpinResult{}, err
}

func (c *Coordinator) observe(notify func(RoundObserver)) {
	notifyRoundObserver(c.observer, notify)
}

func firstRoundObserver(observers []RoundObserver) RoundObserver {
	if len(observers) == 0 {
		return nil
	}
	return observers[0]
}

func terminalRoundResult(record RoundRecord) (SpinResult, bool, error) {
	switch record.Status {
	case RoundCommitted:
		return cloneSpinResult(record.Result), true, nil
	case RoundRejected:
		return SpinResult{}, true, ErrRoundRejected
	case RoundManualReview:
		return SpinResult{}, true, ErrManualReview
	case RoundPrepared, RoundWalletPending:
		return SpinResult{}, false, nil
	default:
		return SpinResult{}, true, fmt.Errorf("%w: unknown round status %q", ErrManualReview, record.Status)
	}
}

func waitForPoll(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func nextPollInterval(current, maximum time.Duration) time.Duration {
	if current >= maximum || current > maximum/2 {
		return maximum
	}
	return current * 2
}

func validateRoundKey(key RoundKey) error {
	if !identifierPattern.MatchString(key.OperatorID) ||
		!identifierPattern.MatchString(key.SessionID) ||
		!identifierPattern.MatchString(key.RoundID) {
		return fmt.Errorf("%w: invalid round key", ErrInvalidRequest)
	}
	return nil
}

func cloneWins(wins []game.Win) []game.Win {
	copyWins := append([]game.Win(nil), wins...)
	for index := range copyWins {
		copyWins[index].Cells = append([]game.Position(nil), copyWins[index].Cells...)
	}
	return copyWins
}

func cloneEvents(events []game.Event) []game.Event {
	copyEvents := append([]game.Event(nil), events...)
	for index := range copyEvents {
		copyEvents[index].Cells = append([]game.Position(nil), copyEvents[index].Cells...)
	}
	return copyEvents
}
