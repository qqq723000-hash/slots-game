// recovery 包在短暂故障或进程重启后恢复持久化的钱包待处理轮次。
package recovery

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"slots-game/server/internal/platform"
	"slots-game/server/internal/rgs"
	"slots-game/server/internal/safelog"
)

type Resolver interface {
	ReconcileClaim(
		context.Context,
		rgs.WalletRecoveryClaim,
	) (rgs.SpinResult, rgs.WalletRecoveryDisposition, error)
}

type Config struct {
	Interval            time.Duration
	ObservationInterval time.Duration
	ObservationTimeout  time.Duration
	// StaleAfter 只为旧配置源代码兼容保留；到期时间现在完全由持久 next_attempt_at 决定。
	StaleAfter          time.Duration
	AttemptTimeout      time.Duration
	LeaseDuration       time.Duration
	InitialBackoff      time.Duration
	MaximumBackoff      time.Duration
	BatchSize           int
	MaxParallel         int
	RiskExpiryBatchSize int
	// FullJitter 仅用于确定性测试。生产默认在 [0, upperBound] 内均匀取值。
	FullJitter func(time.Duration) time.Duration
	// InitialObservationJitter 只错开首次数据库 backlog 快照；恢复 pass 仍会立即执行，
	// 后续快照保持 ObservationInterval 固定周期。测试可注入返回零的函数。
	InitialObservationJitter func(time.Duration) time.Duration
	// Now 仅用于确定性测试恢复循环新鲜度。生产默认使用进程 UTC 时钟；积压年龄
	// 始终由存储适配器使用权威存储时钟计算。
	Now              func() time.Time
	StartupReadiness *StartupReadiness
}

type Worker struct {
	config                  Config
	repository              rgs.RecoveryRepository
	resolver                Resolver
	riskExpiryRepository    rgs.RiskExpiryRepository
	logger                  *slog.Logger
	metrics                 *platform.Metrics
	startupReadiness        *StartupReadiness
	observationMu           sync.Mutex
	nextObservationAt       time.Time
	initialObservationDelay time.Duration
	observationInitialized  bool
}

func New(
	config Config,
	repository rgs.RecoveryRepository,
	resolver Resolver,
	logger *slog.Logger,
	metrics *platform.Metrics,
) (*Worker, error) {
	if repository == nil || resolver == nil {
		return nil, errors.New("recovery: repository and resolver are required")
	}
	if config.Interval == 0 {
		config.Interval = 2 * time.Second
	}
	if config.StaleAfter == 0 {
		config.StaleAfter = time.Second
	}
	if config.ObservationInterval == 0 {
		config.ObservationInterval = 15 * time.Second
	}
	if config.ObservationTimeout == 0 {
		config.ObservationTimeout = time.Second
	}
	if config.AttemptTimeout == 0 {
		config.AttemptTimeout = 5 * time.Second
	}
	if config.LeaseDuration == 0 {
		config.LeaseDuration = config.AttemptTimeout + 2*time.Second
	}
	if config.InitialBackoff == 0 {
		config.InitialBackoff = 250 * time.Millisecond
	}
	if config.MaximumBackoff == 0 {
		config.MaximumBackoff = 30 * time.Second
	}
	if config.BatchSize == 0 {
		config.BatchSize = 100
	}
	if config.MaxParallel == 0 {
		config.MaxParallel = 8
	}
	var riskExpiryRepository rgs.RiskExpiryRepository
	if config.RiskExpiryBatchSize != 0 {
		if config.RiskExpiryBatchSize < 1 || config.RiskExpiryBatchSize > 1_000 {
			return nil, errors.New("recovery: invalid risk expiry batch size")
		}
		var ok bool
		riskExpiryRepository, ok = repository.(rgs.RiskExpiryRepository)
		if !ok {
			return nil, errors.New("recovery: risk expiry repository is required")
		}
	}
	if config.FullJitter == nil {
		config.FullJitter = func(upperBound time.Duration) time.Duration {
			if upperBound <= 0 {
				return 0
			}
			return time.Duration(rand.Int64N(int64(upperBound) + 1))
		}
	}
	if config.InitialObservationJitter == nil {
		config.InitialObservationJitter = func(window time.Duration) time.Duration {
			if window <= 0 {
				return 0
			}
			return time.Duration(rand.Int64N(int64(window)))
		}
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	initialObservationDelay := -time.Nanosecond
	if config.ObservationInterval >= time.Second && config.ObservationInterval <= time.Hour {
		initialObservationDelay = config.InitialObservationJitter(config.ObservationInterval)
	}
	if config.Interval < 100*time.Millisecond || config.StaleAfter < 0 ||
		config.ObservationInterval < time.Second || config.ObservationInterval > time.Hour ||
		config.ObservationTimeout < 100*time.Millisecond ||
		config.ObservationTimeout > config.ObservationInterval ||
		initialObservationDelay < 0 || initialObservationDelay >= config.ObservationInterval ||
		config.AttemptTimeout < 100*time.Millisecond ||
		config.LeaseDuration < config.AttemptTimeout || config.LeaseDuration > 24*time.Hour ||
		config.InitialBackoff <= 0 || config.MaximumBackoff < config.InitialBackoff ||
		config.MaximumBackoff > 24*time.Hour ||
		config.BatchSize < 1 || config.BatchSize > 10_000 ||
		config.MaxParallel < 1 || config.MaxParallel > rgs.MaxWalletRecoveryClaimBatch {
		return nil, errors.New("recovery: invalid worker configuration")
	}
	if metrics != nil {
		metrics.EnableRecoveryMetrics()
	}
	return &Worker{
		config: config, repository: repository, resolver: resolver,
		riskExpiryRepository: riskExpiryRepository,
		logger:               logger, metrics: metrics, startupReadiness: config.StartupReadiness,
		initialObservationDelay: initialObservationDelay,
	}, nil
}

// Run 立即执行恢复，随后按有界周期运行，直至进程上下文被取消。
func (w *Worker) Run(ctx context.Context) {
	w.runAndObserve(ctx)
	ticker := time.NewTicker(w.config.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.runAndObserve(ctx)
		}
	}
}

func (w *Worker) RunOnce(ctx context.Context) (runErr error) {
	defer func() {
		runErr = w.finishObservedPass(ctx, runErr)
		if runErr == nil && ctx.Err() == nil {
			w.startupReadiness.MarkSuccessfulPass()
		}
	}()
	var failures []error
	if w.riskExpiryRepository != nil {
		if _, err := w.riskExpiryRepository.ExpireRiskReviews(ctx, w.config.RiskExpiryBatchSize); err != nil {
			// 风险到期失败必须让本轮观测失败，但不能饿死独立的钱包未知结果恢复。
			failures = append(failures, err)
		}
	}
	for remaining := w.config.BatchSize; remaining > 0; {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(failures, err)...)
		}
		claimLimit := min(remaining, w.config.MaxParallel)
		claims, err := w.repository.ClaimRecoverableRounds(
			ctx, claimLimit, w.config.LeaseDuration,
		)
		if err != nil {
			return errors.Join(append(failures, err)...)
		}
		if len(claims) == 0 {
			break
		}
		remaining -= len(claims)
		failures = append(failures, w.processClaims(ctx, claims)...)
	}
	return errors.Join(failures...)
}

func (w *Worker) finishObservedPass(ctx context.Context, passErr error) error {
	if w.metrics == nil {
		return passErr
	}
	if passErr != nil {
		if !errors.Is(passErr, context.Canceled) {
			w.metrics.RecoveryLoopFailed()
		}
		return passErr
	}
	if err := ctx.Err(); err != nil {
		if !errors.Is(err, context.Canceled) {
			w.metrics.RecoveryLoopFailed()
		}
		return err
	}
	completedAt := w.config.Now().UTC()
	if completedAt.IsZero() || completedAt.Unix() <= 0 {
		w.metrics.RecoveryLoopFailed()
		return errors.New("recovery: observation clock returned an invalid time")
	}
	w.metrics.RecoveryLoopSucceeded(completedAt)
	if w.claimBacklogObservation(completedAt) {
		observationCtx, cancel := context.WithTimeout(ctx, w.config.ObservationTimeout)
		snapshot, err := w.repository.RecoverySnapshot(observationCtx)
		cancel()
		if err != nil {
			if errors.Is(err, context.Canceled) && errors.Is(ctx.Err(), context.Canceled) {
				return ctx.Err()
			}
			w.metrics.RecoverySnapshotFailed()
			w.logObservationFailure(err)
			return nil
		}
		if snapshot.Backlog < 0 || snapshot.Backlog > rgs.RecoverySnapshotBacklogLimit ||
			snapshot.OldestDueAge < 0 ||
			(snapshot.Backlog == 0 && snapshot.OldestDueAge != 0) ||
			snapshot.ObservedAt.IsZero() || snapshot.ObservedAt.Unix() <= 0 {
			err := errors.New("recovery: repository returned an invalid backlog snapshot")
			w.metrics.RecoverySnapshotFailed()
			w.logObservationFailure(err)
			return nil
		}
		w.metrics.ObserveRecoveryBacklog(
			snapshot.Backlog, snapshot.OldestDueAge, snapshot.ObservedAt,
		)
	}
	return nil
}

func (w *Worker) claimBacklogObservation(now time.Time) bool {
	w.observationMu.Lock()
	defer w.observationMu.Unlock()
	if !w.observationInitialized {
		w.nextObservationAt = now.Add(w.initialObservationDelay)
		w.observationInitialized = true
	}
	if !w.nextObservationAt.IsZero() && now.Before(w.nextObservationAt) {
		return false
	}
	w.nextObservationAt = now.Add(w.config.ObservationInterval)
	return true
}

func (w *Worker) logObservationFailure(err error) {
	w.logFailure("recovery backlog observation failed", err)
}

func (w *Worker) logFailure(message string, err error) {
	if w.logger != nil {
		// 底层 PostgreSQL 错误可能包含 SQL、绑定值或拓扑；只输出固定错误族。
		w.logger.Error(message, "error_class", safelog.ErrorClass(err))
	}
}

func (w *Worker) processClaims(
	ctx context.Context,
	claims []rgs.WalletRecoveryClaim,
) []error {
	var group sync.WaitGroup
	var failuresMu sync.Mutex
	var failures []error
	for _, claim := range claims {
		claim := claim
		group.Add(1)
		go func() {
			defer group.Done()
			if w.metrics != nil {
				w.metrics.Reconciliations.Add(1)
			}
			if err := w.processClaim(ctx, claim); err != nil {
				failuresMu.Lock()
				failures = append(failures, err)
				failuresMu.Unlock()
			}
		}()
	}
	group.Wait()
	return failures
}

func (w *Worker) processClaim(ctx context.Context, claim rgs.WalletRecoveryClaim) error {
	if !claim.Action.Valid() || claim.LeaseUntil.IsZero() {
		return errors.New("recovery: repository returned an invalid claim")
	}
	attemptCtx, cancel := context.WithTimeout(ctx, w.config.AttemptTimeout)
	_, disposition, reconcileErr := w.resolver.ReconcileClaim(attemptCtx, claim)
	cancel()
	if err := rgs.ValidateWalletRecoveryDisposition(disposition); err != nil {
		return errors.Join(errors.New("recovery: resolver returned an invalid disposition"), reconcileErr)
	}
	if disposition.Terminal {
		if reconcileErr == nil || expectedTerminalError(reconcileErr) {
			return nil
		}
		return reconcileErr
	}
	upperBound := w.backoffUpperBound(claim.Record, disposition.NextAction)
	jitterDelay := w.config.FullJitter(upperBound)
	if jitterDelay < 0 || jitterDelay > upperBound {
		return errors.New("recovery: full-jitter source returned an out-of-range delay")
	}
	scheduled, scheduleErr := w.repository.ScheduleWalletRecovery(
		ctx, claim, disposition, jitterDelay,
	)
	if scheduleErr != nil {
		return errors.Join(reconcileErr, scheduleErr)
	}
	if !scheduled {
		// 终态转换或带新栅栏的领取已经赢得竞态。两者都不允许旧 Worker 覆盖持久状态，
		// 并且都是预期的收敛路径。
		return nil
	}
	// 有效的非终态决策与已持久化重试共同表示本次恢复步骤完成；即使 Resolver
	// 将钱包待决或传输状态报告为错误，也不应把已安全调度的步骤判为失败。
	return nil
}

func (w *Worker) backoffUpperBound(record rgs.RoundRecord, next rgs.WalletRecoveryAction) time.Duration {
	attempts := record.WalletLookupAttempts
	if next == rgs.WalletRecoveryApply {
		// APPLY 预算会在能够证明 NOT_SENT 时归还；RetryCount 不归还，专门保证
		// 本地熔断、bulkhead 或配置失败不会永远以初始间隔打热数据库。
		attempts = record.RetryCount
	}
	if attempts < 1 {
		attempts = 1
	}
	upperBound := w.config.InitialBackoff
	for exponent := 1; exponent < attempts && upperBound < w.config.MaximumBackoff; exponent++ {
		if upperBound > w.config.MaximumBackoff/2 {
			return w.config.MaximumBackoff
		}
		upperBound *= 2
	}
	if upperBound > w.config.MaximumBackoff {
		return w.config.MaximumBackoff
	}
	return upperBound
}

func expectedTerminalError(err error) bool {
	return errors.Is(err, rgs.ErrWalletPending) ||
		errors.Is(err, rgs.ErrWalletRejected) ||
		errors.Is(err, rgs.ErrRoundRejected) ||
		errors.Is(err, rgs.ErrManualReview) ||
		errors.Is(err, rgs.ErrSessionIntegrity)
}

func (w *Worker) runAndObserve(ctx context.Context) {
	if err := w.RunOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
		// 联合错误链可能携带轮次、会话、钱包或数据库细节。
		w.logFailure("round recovery pass failed", err)
	}
}
