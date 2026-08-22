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
)

type Resolver interface {
	ReconcileClaim(
		context.Context,
		rgs.WalletRecoveryClaim,
	) (rgs.SpinResult, rgs.WalletRecoveryDisposition, error)
}

type Config struct {
	Interval time.Duration
	// StaleAfter 只为旧配置源代码兼容保留；到期时间现在完全由持久 next_attempt_at 决定。
	StaleAfter     time.Duration
	AttemptTimeout time.Duration
	LeaseDuration  time.Duration
	InitialBackoff time.Duration
	MaximumBackoff time.Duration
	BatchSize      int
	MaxParallel    int
	// FullJitter 仅用于确定性测试。生产默认在 [0, upperBound] 内均匀取值。
	FullJitter func(time.Duration) time.Duration
}

type Worker struct {
	config     Config
	repository rgs.RecoveryRepository
	resolver   Resolver
	logger     *slog.Logger
	metrics    *platform.Metrics
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
	if config.FullJitter == nil {
		config.FullJitter = func(upperBound time.Duration) time.Duration {
			if upperBound <= 0 {
				return 0
			}
			return time.Duration(rand.Int64N(int64(upperBound) + 1))
		}
	}
	if config.Interval < 100*time.Millisecond || config.StaleAfter < 0 ||
		config.AttemptTimeout < 100*time.Millisecond ||
		config.LeaseDuration < config.AttemptTimeout || config.LeaseDuration > 24*time.Hour ||
		config.InitialBackoff <= 0 || config.MaximumBackoff < config.InitialBackoff ||
		config.MaximumBackoff > 24*time.Hour ||
		config.BatchSize < 1 || config.BatchSize > 10_000 ||
		config.MaxParallel < 1 || config.MaxParallel > rgs.MaxWalletRecoveryClaimBatch {
		return nil, errors.New("recovery: invalid worker configuration")
	}
	return &Worker{
		config: config, repository: repository, resolver: resolver,
		logger: logger, metrics: metrics,
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

func (w *Worker) RunOnce(ctx context.Context) error {
	var failures []error
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
		if w.logger != nil {
			// 禁止将玩家、会话或轮次标识写入日志。
			w.logger.Error("round recovery pass failed", "error", err)
		}
	}
}
