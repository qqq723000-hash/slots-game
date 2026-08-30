package rgs

import (
	"context"
	"errors"
	"fmt"
	"time"

	"slots-game/server/internal/game"
	"slots-game/server/internal/telemetry"
)

// DefinitionRegistry 只解析不可变且已批准的游戏定义版本；禁止静默回退到更新版本。
// English: DefinitionRegistry only resolves immutable and approved versions of the game definition; silent
// rollback to newer versions is prohibited.
type DefinitionRegistry interface {
	Resolve(context.Context, string, string, string) (game.Spinner, error)
}

type DefinitionResolverFunc func(context.Context, string, string, string) (game.Spinner, error)

func (f DefinitionResolverFunc) Resolve(ctx context.Context, gameID, version, hash string) (game.Spinner, error) {
	return f(ctx, gameID, version, hash)
}

type CoordinatorConfig struct {
	WalletLease             time.Duration
	WalletFastPathTimeout   time.Duration
	PendingWait             time.Duration
	PollInterval            time.Duration
	PollMaximumInterval     time.Duration
	MaxWalletAttempts       int
	EconomicIntentAdmission EconomicIntentAdmitter
}

type Coordinator struct {
	repository              Repository
	wallet                  WalletResolutionPort
	intentAdmitter          walletIntentAdmitter
	definitions             DefinitionRegistry
	walletLease             time.Duration
	walletFastPathTimeout   time.Duration
	pendingWait             time.Duration
	pollInterval            time.Duration
	pollMaximumInterval     time.Duration
	maxWalletAttempts       int
	observer                RoundObserver
	economicIntentAdmission EconomicIntentAdmitter
}

const persistedRoundIntegrityFailure = "persisted round integrity validation failed"

// ManualReviewReason* 是提交钱包回执失败时持久化到轮次、钱包账本和审计 Outbox 的
// 稳定低基数原因码。错误链可能携带 DSN、钱包地址或玩家标识，禁止直接作为原因保存。
// English: ManualReviewReason* is a stable low-cardinality reason code that is persisted to rounds, wallet
// ledgers, and audit outboxes when submitting wallet receipts fails. The error chain may carry a DSN, wallet
// address or player ID and is prohibited from being saved directly as a cause.
const (
	ManualReviewReasonWalletReceiptInvalid   = "WALLET_RECEIPT_INVALID"
	ManualReviewReasonCommitRevisionConflict = "COMMIT_REVISION_CONFLICT"
	ManualReviewReasonCommitStateIntegrity   = "COMMIT_STATE_INTEGRITY_FAILURE"
)

// walletIntentAdmitter 只进行本进程、无副作用的快速容量检查。最终准入仍由
// SubmitRound 的非阻塞舱壁决定，因此检查成功绝不构成资金操作已获准的承诺。
// English: walletIntentAdmitter only performs a quick capacity check of this process with no side effects. Final
// admission remains subject to SubmitRound's non-blocking bulkhead, so a successful inspection in no way
// constitutes a commitment that funding operations have been approved.
type walletIntentAdmitter interface {
	AdmitNewIntent(string) error
}

// EconomicIntentAdmitter 只在 Repository 已锁定会话且确认 round 不存在后调用。
// 它可以等待一个有界共享准入 RTT，但不得执行钱包、RNG 或持久化副作用。
// English: EconomicIntentAdmitter is only called after the Repository has locked the session and confirmed that
// the round does not exist. It can wait for a bounded shared admission RTT, but must not perform wallet, RNG, or
// persistence side effects.
type EconomicIntentAdmitter interface {
	AdmitNewEconomicIntent(context.Context, string, int) error
}

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
	resolutionWallet, ok := wallet.(WalletResolutionPort)
	if !ok {
		return nil, errors.New("rgs: wallet must implement the versioned resolution contract")
	}
	if config.WalletLease < 0 || config.WalletFastPathTimeout < 0 ||
		config.PendingWait < 0 || config.PollInterval < 0 ||
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
	if config.WalletFastPathTimeout == 0 {
		config.WalletFastPathTimeout = time.Second
		if config.WalletFastPathTimeout > config.WalletLease {
			config.WalletFastPathTimeout = config.WalletLease
		}
	}
	if config.WalletFastPathTimeout > config.WalletLease {
		return nil, errors.New("rgs: wallet fast-path timeout cannot exceed the wallet lease")
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
		repository: repository, wallet: resolutionWallet, definitions: definitions,
		walletLease: config.WalletLease, pendingWait: config.PendingWait,
		walletFastPathTimeout: config.WalletFastPathTimeout,
		pollInterval:          config.PollInterval, pollMaximumInterval: config.PollMaximumInterval,
		maxWalletAttempts:       config.MaxWalletAttempts,
		observer:                firstRoundObserver(observers),
		intentAdmitter:          firstWalletIntentAdmitter(wallet),
		economicIntentAdmission: config.EconomicIntentAdmission,
	}, nil
}

// Spin 在调用外部钱包前先准备并持久化不可变结果，再执行原子扣款/派彩命令并提交会话迁移。
// 所有重试都必须先解析已持久化的轮次聚合，绝不能重新运行 RNG。
// English: Spin prepares and persists the immutable results before calling the external wallet, then executes the
// atomic deduction/payout command and submits the session migration. All retries must first resolve the persisted
// round aggregate and must never rerun the RNG.
func (c *Coordinator) Spin(ctx context.Context, request SpinRequest) (returned SpinResult, err error) {
	ctx, span := telemetry.Start(ctx, "rgs.coordinator.spin")
	defer func() { telemetry.End(span, err) }()
	if err := validateSpinRequest(request); err != nil {
		return SpinResult{}, err
	}
	fingerprint := FingerprintFor(request)
	walletProfile, err := c.wallet.ProfileFor(request.OperatorID)
	if err != nil || !SupportedSettlementProfile(walletProfile) {
		// 已持久化终态的精确重放不依赖当前钱包路由是否在线。只有新意图才需要
		// 当前 Profile；这避免配置摘除或供应商故障破坏历史结果交付。
		// English: Accurate replay of the persisted final state does not depend on whether the current wallet route is
		// online. Only new intents require the current Profile; this avoids configuration stripping or vendor failure from
		// disrupting historical result delivery.
		existing, existingErr := c.repository.GetRound(ctx, request.Key())
		if existingErr == nil {
			if existing.Fingerprint != fingerprint {
				c.observe(func(observer RoundObserver) { observer.IdempotencyConflict() })
				return SpinResult{}, ErrIdempotencyConflict
			}
			result, replayErr := c.waitForRound(ctx, existing)
			if replayErr == nil {
				c.observe(func(observer RoundObserver) { observer.RoundReplayed() })
			}
			return result, replayErr
		}
		if claimIntegrityFailure(existingErr) {
			return SpinResult{}, c.quarantinePersistedRound(ctx, request.Key())
		}
		if !errors.Is(existingErr, ErrRoundNotFound) {
			return SpinResult{}, existingErr
		}
		return SpinResult{}, errors.Join(ErrWalletUnavailable, err)
	}
	record, prepared, err := c.repository.PrepareRound(ctx, request, fingerprint, walletProfile, func(session Session) (SpinResult, error) {
		// PrepareOutcome 由存储层在会话锁内、且仅对首次出现的 round 调用一次；
		// 因此 committed/prepared 重放和同 round 并发不会重复消耗经济成本预算。
		// English: PrepareOutcome is called by the storage layer within the session lock and only once for the first
		// occurrence of round; therefore committed/prepared replay and same-round concurrency do not repeatedly consume
		// the economic cost budget.
		if c.intentAdmitter != nil {
			if err := c.intentAdmitter.AdmitNewIntent(request.OperatorID); err != nil {
				return SpinResult{}, errors.Join(ErrWalletUnavailable, err)
			}
		}
		result, err := c.prepareOutcome(ctx, session, request)
		if err != nil {
			return SpinResult{}, err
		}
		// 存储层仍会重复验证这一不变量；先在共享成本扣减前验证一次，避免
		// 定义/RNG 或内部结果错误变成可反复消耗后端钱包预算的反向 EDoS。
		// English: The storage layer still verifies this invariant repeatedly; verifying it once before sharing cost
		// deductions prevents definition/RNG or internal result errors from turning into reverse EDoS that can repeatedly
		// consume the backend wallet budget.
		if err := validatePreparedResult(session, request, result); err != nil {
			return SpinResult{}, err
		}
		if c.economicIntentAdmission != nil {
			// 当前 SubmitRound 的供应商成本固定为一个单位；不要从 bet 金额或
			// 未验证请求字段推断成本。接口保留显式单位供未来已审定路由使用。
			// English: The supplier cost for SubmitRound is currently fixed at one unit; do not infer the cost from the bet
			// amount or the unvalidated request field. The interface reserves explicit units for use by future audited routes.
			if err := c.economicIntentAdmission.AdmitNewEconomicIntent(ctx, request.OperatorID, 1); err != nil {
				return SpinResult{}, err
			}
		}
		return result, nil
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
	var result SpinResult
	if prepared {
		result, err = c.resolvePreparedRound(ctx, record)
	} else {
		// 已存在轮次的客户端重试只观察持久状态；恢复钱包的唯一所有者是持有
		// fenced claim 的初始请求或 Worker，禁止重试请求再次触发外部写入。
		// English: Client retries for existing rounds only observe persistent state; the only owner of the recovery wallet
		// is the initial request or worker holding the fenced claim, and retry requests are prohibited from triggering
		// external writes again.
		result, err = c.waitForRound(ctx, record)
	}
	if err == nil && !prepared {
		c.observe(func(observer RoundObserver) { observer.RoundReplayed() })
	}
	return result, err
}

// Reconcile 恢复已经准备好的轮次，不会再次计算游戏数学；并发工作器和进程重启均可安全调用。
// English: Reconcile resumes an already prepared turn without recalculating game math; safe to call from both
// concurrent workers and process restarts.
func (c *Coordinator) Reconcile(ctx context.Context, key RoundKey) (returned SpinResult, err error) {
	ctx, span := telemetry.Start(ctx, "rgs.coordinator.reconcile")
	defer func() { telemetry.End(span, err) }()
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
	if result, done, terminalErr := terminalRoundResult(record); done {
		return result, terminalErr
	}
	claim, claimed, err := c.repository.ClaimWallet(ctx, key, c.walletLease)
	if err != nil {
		return SpinResult{}, err
	}
	if !claimed {
		return SpinResult{}, ErrWalletPending
	}
	return c.executeClaimAndSchedule(ctx, ctx, claim)
}

// GetRound 是只读状态查询路径。持久化完整性校验失败时，它只允许执行故障安全隔离迁移；
// 禁止计算游戏数学、领取钱包租约或调用钱包。状态读取统一经过协调器，可防止轮询首次发现的
// 损坏记录继续具备经济操作资格。
// English: GetRound is a read-only status query path. It only allows failsafe isolation migrations to be performed
// when persistence integrity checks fail; it is prohibited to calculate game math, claim wallet leases, or make
// wallet calls. Status reads are uniformly routed through the coordinator, preventing corrupt records first
// discovered by polling from continuing to qualify for economical operation.
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
// English: GetPendingResultDelivery queries the only submitted result in the token binding session that has not
// yet confirmed delivery, and does not require the client to retain the roundId field itself.
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
// English: AcknowledgeResultDelivery only records the immutable submission results that have been consumed by the
// client; the economic status has already been finalized by CommitRound, and this operation must not modify the
// balance or feature status.
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
		ResultSchemaVersion: ResultSchemaPaidFactsV1,
		OperatorID:          request.OperatorID, SessionID: request.SessionID,
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

func (c *Coordinator) resolvePreparedRound(ctx context.Context, record RoundRecord) (SpinResult, error) {
	if result, done, err := terminalRoundResult(record); done {
		return result, err
	}
	claim, claimed, err := c.repository.ClaimWallet(ctx, record.Key, c.walletLease)
	if err != nil {
		if errors.Is(err, ErrManualReview) {
			return SpinResult{}, c.quarantinePersistedRound(ctx, record.Key)
		}
		return SpinResult{}, err
	}
	if !claimed {
		return c.waitForRound(ctx, claim.Record)
	}
	return c.executeClaimAndScheduleDetached(ctx, claim)
}

func (c *Coordinator) waitForRound(ctx context.Context, initial RoundRecord) (SpinResult, error) {
	deadline := time.Now().Add(c.pendingWait)
	pollInterval := c.pollInterval
	record := initial
	for {
		if result, done, err := terminalRoundResult(record); done {
			return result, err
		}
		latest, err := c.repository.GetRound(ctx, record.Key)
		if err != nil {
			if claimIntegrityFailure(err) {
				return SpinResult{}, c.quarantinePersistedRound(ctx, record.Key)
			}
			return SpinResult{}, err
		}
		record = latest
		if result, done, err := terminalRoundResult(record); done {
			return result, err
		}
		now := time.Now()
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
		// Pending wallet results use bounded exponential backoff so concurrent requests do not poll the database and wallet at a fixed high rate;
		// the cap also preserves timely convergence after external settlement completes.
		pollInterval = nextPollInterval(pollInterval, c.pollMaximumInterval)
	}
}

// ReconcileClaim 只执行存储层声明的一项钱包动作。APPLY claim 在返回调用者前已经
// 持久推进为 LOOKUP，因此任何进程崩溃都只能从状态查询继续，不会盲目重扣。
// English: ReconcileClaim only performs one wallet action declared by the storage layer. APPLY claim has been
// persistently advanced to LOOKUP before returning to the caller, so any process crash can only continue from the
// status query and will not blindly re-deduct.
func (c *Coordinator) ReconcileClaim(
	ctx context.Context,
	claim WalletRecoveryClaim,
) (returned SpinResult, disposition WalletRecoveryDisposition, err error) {
	ctx, span := telemetry.Start(ctx, "rgs.coordinator.wallet_reconcile")
	defer func() { telemetry.End(span, err) }()
	if !claim.Action.Valid() || claim.LeaseUntil.IsZero() ||
		claim.Record.Key != claim.Record.Request.Key() ||
		!claim.Record.WalletLeaseUntil.Equal(claim.LeaseUntil) {
		return SpinResult{}, WalletRecoveryDisposition{Terminal: true}, ErrInvalidRequest
	}
	if result, done, err := terminalRoundResult(claim.Record); done {
		return result, WalletRecoveryDisposition{Terminal: true}, err
	}
	if claim.Action == WalletRecoveryApply && claim.Record.WalletApplyAttempts > c.maxWalletAttempts {
		return c.markClaimForManualReview(ctx, claim, "wallet apply attempt limit exceeded", nil)
	}
	if claim.Action == WalletRecoveryLookup && claim.Record.WalletLookupAttempts > c.maxWalletAttempts {
		return c.markClaimForManualReview(ctx, claim, "wallet lookup attempt limit exceeded", nil)
	}
	if err := ValidateWalletCommand(claim.Record.WalletCommand); err != nil {
		return c.markClaimForManualReview(ctx, claim, "wallet command binding is invalid", err)
	}
	profile, err := c.wallet.ProfileFor(claim.Record.WalletCommand.OperatorID)
	if err != nil {
		return SpinResult{}, WalletRecoveryDisposition{
			NextAction:   claim.Action,
			ApplyNotSent: claim.Action == WalletRecoveryApply,
		}, ErrWalletPending
	}
	if !SupportedSettlementProfile(claim.Record.WalletProfile) ||
		!SupportedSettlementProfile(profile) || profile != claim.Record.WalletProfile {
		return c.markClaimForManualReview(
			ctx, claim, "wallet settlement profile changed after round preparation", nil,
		)
	}

	var resolution Resolution
	if claim.Action == WalletRecoveryApply {
		resolution = c.wallet.SubmitRound(ctx, claim.Record.WalletCommand)
	} else {
		resolution = c.wallet.Resolve(ctx, OperationRefFor(claim.Record.WalletCommand))
	}
	return c.applyWalletResolution(ctx, claim, profile, resolution)
}

func (c *Coordinator) applyWalletResolution(
	ctx context.Context,
	claim WalletRecoveryClaim,
	profile Profile,
	resolution Resolution,
) (SpinResult, WalletRecoveryDisposition, error) {
	if !resolution.Status.Valid() {
		return c.markClaimForManualReview(ctx, claim, "wallet returned an invalid resolution", resolution.Cause)
	}
	switch resolution.Status {
	case ResolutionSucceeded:
		result, err := c.commitReceipt(ctx, claim, resolution.Receipt)
		return result, WalletRecoveryDisposition{Terminal: true}, err
	case ResolutionRejectedFinal:
		failureCode := resolution.Code
		if failureCode == "" {
			failureCode = "WALLET_REJECTED"
		}
		if _, _, err := c.repository.RejectClaim(ctx, claim, failureCode); err != nil {
			if errors.Is(err, ErrStaleWalletClaim) {
				return c.resolveStaleClaim(ctx, claim.Record.Key)
			}
			if errors.Is(err, ErrManualReview) {
				return SpinResult{}, WalletRecoveryDisposition{Terminal: true},
					c.quarantinePersistedRound(ctx, claim.Record.Key)
			}
			return SpinResult{}, WalletRecoveryDisposition{Terminal: true}, err
		}
		return SpinResult{}, WalletRecoveryDisposition{Terminal: true}, ErrWalletRejected
	case ResolutionConflict:
		if errors.Is(resolution.Cause, ErrIdempotencyConflict) {
			c.observe(func(observer RoundObserver) { observer.IdempotencyConflict() })
		}
		return c.markClaimForManualReview(ctx, claim, "wallet operation identity conflict", resolution.Cause)
	case ResolutionPending, ResolutionUnknown:
		return SpinResult{}, WalletRecoveryDisposition{NextAction: WalletRecoveryLookup}, ErrWalletPending
	case ResolutionNotSent:
		return SpinResult{}, WalletRecoveryDisposition{
			NextAction:   claim.Action,
			ApplyNotSent: claim.Action == WalletRecoveryApply,
		}, ErrWalletPending
	case ResolutionNotFound:
		if claim.Action != WalletRecoveryLookup {
			return c.markClaimForManualReview(ctx, claim, "wallet apply returned NOT_FOUND", resolution.Cause)
		}
		if !profile.Capabilities.ReapplySameOperationAfterNotFound {
			return c.markClaimForManualReview(ctx, claim, "wallet operation is absent and cannot be reapplied", nil)
		}
		return SpinResult{}, WalletRecoveryDisposition{
			NextAction:   WalletRecoveryApply,
			MinimumDelay: profile.Capabilities.NotFoundConsistencyWindow,
		}, ErrWalletPending
	default:
		return c.markClaimForManualReview(ctx, claim, "wallet returned an unsupported resolution", resolution.Cause)
	}
}

func (c *Coordinator) markClaimForManualReview(
	ctx context.Context,
	claim WalletRecoveryClaim,
	reason string,
	cause error,
) (SpinResult, WalletRecoveryDisposition, error) {
	_, changed, err := c.repository.MarkClaimManualReview(ctx, claim, reason)
	if err != nil {
		if errors.Is(err, ErrStaleWalletClaim) {
			return c.resolveStaleClaim(ctx, claim.Record.Key)
		}
		if claimIntegrityFailure(err) {
			return SpinResult{}, WalletRecoveryDisposition{Terminal: true},
				errors.Join(cause, c.quarantinePersistedRound(ctx, claim.Record.Key))
		}
		return SpinResult{}, WalletRecoveryDisposition{Terminal: true}, errors.Join(cause, err)
	}
	if changed {
		c.observe(func(observer RoundObserver) { observer.RoundManualReview() })
	}
	return SpinResult{}, WalletRecoveryDisposition{Terminal: true}, ErrManualReview
}

func (c *Coordinator) executeClaimAndSchedule(
	scheduleCtx context.Context,
	executionCtx context.Context,
	claim WalletRecoveryClaim,
) (SpinResult, error) {
	result, disposition, err := c.ReconcileClaim(executionCtx, claim)
	return c.scheduleClaimDisposition(scheduleCtx, claim, result, disposition, err)
}

// executeClaimAndScheduleDetached 在 PREPARE+claim 已经提交后脱离客户端取消信号，
// 但保留 trace/value。外部调用和后续 DB 写各自有独立硬截止，确保客户端断线不会
// 把已持久化 saga 留在已知 NOT_SENT 却无法退款、或钱包成功却无法提交的半状态。
// English: executeClaimAndScheduleDetached detaches the client cancellation signal after the PREPARE+claim has
// been submitted, but retains the trace/value. External calls and subsequent DB writes each have independent hard
// cutoffs to ensure that client disconnection will not leave the persisted saga in a semi-state where NOT_SENT is
// known but cannot be refunded, or the wallet is successful but cannot be submitted.
func (c *Coordinator) executeClaimAndScheduleDetached(
	parent context.Context,
	claim WalletRecoveryClaim,
) (SpinResult, error) {
	base := context.WithoutCancel(parent)
	executionCtx, cancelExecution := context.WithTimeout(base, c.walletFastPathTimeout)
	result, disposition, err := c.ReconcileClaim(executionCtx, claim)
	cancelExecution()
	if disposition.Terminal {
		return result, err
	}
	scheduleCtx, cancelSchedule := context.WithTimeout(base, c.walletFastPathTimeout)
	defer cancelSchedule()
	return c.scheduleClaimDisposition(scheduleCtx, claim, result, disposition, err)
}

func (c *Coordinator) scheduleClaimDisposition(
	scheduleCtx context.Context,
	claim WalletRecoveryClaim,
	result SpinResult,
	disposition WalletRecoveryDisposition,
	err error,
) (SpinResult, error) {
	if disposition.Terminal {
		return result, err
	}
	if validateErr := ValidateWalletRecoveryDisposition(disposition); validateErr != nil {
		return SpinResult{}, errors.Join(err, validateErr)
	}
	scheduled, scheduleErr := c.repository.ScheduleWalletRecovery(
		scheduleCtx, claim, disposition, 0,
	)
	if scheduleErr != nil {
		return SpinResult{}, errors.Join(err, scheduleErr)
	}
	if !scheduled {
		latest, latestErr := c.repository.GetRound(scheduleCtx, claim.Record.Key)
		if latestErr == nil {
			if terminal, done, terminalErr := terminalRoundResult(latest); done {
				return terminal, terminalErr
			}
		}
	}
	return SpinResult{}, ErrWalletPending
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

func (c *Coordinator) commitReceipt(ctx context.Context, claim WalletRecoveryClaim, receipt WalletReceipt) (SpinResult, error) {
	record, changed, err := c.repository.CommitClaim(ctx, claim, receipt)
	if err == nil {
		if changed {
			c.observe(func(observer RoundObserver) { observer.RoundCommitted() })
		}
		return cloneSpinResult(record.Result), nil
	}
	if errors.Is(err, ErrSessionIntegrity) {
		return SpinResult{}, ErrSessionIntegrity
	}
	if errors.Is(err, ErrStaleWalletClaim) {
		result, _, latestErr := c.resolveStaleClaim(ctx, claim.Record.Key)
		return result, latestErr
	}
	if errors.Is(err, ErrWalletReceiptInvalid) || claimIntegrityFailure(err) {
		_, manualReviewChanged, markErr := c.repository.MarkClaimManualReview(
			ctx,
			claim,
			commitManualReviewReason(err),
		)
		if errors.Is(markErr, ErrStaleWalletClaim) {
			result, _, latestErr := c.resolveStaleClaim(ctx, claim.Record.Key)
			return result, latestErr
		}
		if claimIntegrityFailure(markErr) {
			return SpinResult{}, errors.Join(err, c.quarantinePersistedRound(ctx, claim.Record.Key))
		}
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

func claimIntegrityFailure(err error) bool {
	return errors.Is(err, ErrManualReview) || errors.Is(err, ErrRevisionConflict)
}

func commitManualReviewReason(err error) string {
	switch {
	case errors.Is(err, ErrWalletReceiptInvalid):
		return ManualReviewReasonWalletReceiptInvalid
	case errors.Is(err, ErrRevisionConflict):
		return ManualReviewReasonCommitRevisionConflict
	default:
		return ManualReviewReasonCommitStateIntegrity
	}
}

// resolveStaleClaim 绝不重放旧 claim 的写操作。它只读取最新持久状态；若新的 owner
// 仍在处理则保持 pending，若已终结则复用统一的终态映射。
// English: resolveStaleClaim never replays old claim writes. It only reads the latest persistent state; if the new
// owner is still being processed, it remains pending, and if it has been terminated, it reuses the unified final
// state mapping.
func (c *Coordinator) resolveStaleClaim(
	ctx context.Context,
	key RoundKey,
) (SpinResult, WalletRecoveryDisposition, error) {
	latest, err := c.repository.GetRound(ctx, key)
	if err != nil {
		return SpinResult{}, WalletRecoveryDisposition{Terminal: true}, err
	}
	if result, done, terminalErr := terminalRoundResult(latest); done {
		return result, WalletRecoveryDisposition{Terminal: true}, terminalErr
	}
	return SpinResult{}, WalletRecoveryDisposition{Terminal: true}, ErrWalletPending
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

func firstWalletIntentAdmitter(wallet WalletPort) walletIntentAdmitter {
	admitter, _ := wallet.(walletIntentAdmitter)
	return admitter
}

func terminalRoundResult(record RoundRecord) (SpinResult, bool, error) {
	switch record.Status {
	case RoundCommitted:
		return cloneSpinResult(record.Result), true, nil
	case RoundRejected:
		return SpinResult{}, true, ErrRoundRejected
	case RoundManualReview:
		return SpinResult{}, true, ErrManualReview
	case RoundRiskPending:
		return SpinResult{}, true, ErrRiskPending
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
