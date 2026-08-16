// recovery 包在短暂故障或进程重启后恢复持久化的钱包待处理轮次。
package recovery

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"slots-game/server/internal/platform"
	"slots-game/server/internal/rgs"
)

type Resolver interface {
	Reconcile(context.Context, rgs.RoundKey) (rgs.SpinResult, error)
}

type Config struct {
	Interval       time.Duration
	StaleAfter     time.Duration
	AttemptTimeout time.Duration
	BatchSize      int
	MaxParallel    int
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
	if config.BatchSize == 0 {
		config.BatchSize = 100
	}
	if config.MaxParallel == 0 {
		config.MaxParallel = 8
	}
	if config.Interval < 100*time.Millisecond || config.StaleAfter < 0 ||
		config.AttemptTimeout < 100*time.Millisecond ||
		config.BatchSize < 1 || config.BatchSize > 10_000 ||
		config.MaxParallel < 1 || config.MaxParallel > 256 {
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
	keys, err := w.repository.ListRecoverableRounds(
		ctx, time.Now().UTC().Add(-w.config.StaleAfter), w.config.BatchSize,
	)
	if err != nil {
		return err
	}
	semaphore := make(chan struct{}, w.config.MaxParallel)
	var group sync.WaitGroup
	var failuresMu sync.Mutex
	var failures []error
	for _, key := range keys {
		if err := ctx.Err(); err != nil {
			return err
		}
		semaphore <- struct{}{}
		group.Add(1)
		go func(key rgs.RoundKey) {
			defer group.Done()
			defer func() { <-semaphore }()
			attemptCtx, cancel := context.WithTimeout(ctx, w.config.AttemptTimeout)
			defer cancel()
			if w.metrics != nil {
				w.metrics.Reconciliations.Add(1)
			}
			_, err := w.resolver.Reconcile(attemptCtx, key)
			if err == nil || errors.Is(err, rgs.ErrWalletPending) ||
				errors.Is(err, rgs.ErrRoundRejected) ||
				errors.Is(err, rgs.ErrManualReview) ||
				errors.Is(err, rgs.ErrSessionIntegrity) {
				return
			}
			failuresMu.Lock()
			failures = append(failures, err)
			failuresMu.Unlock()
		}(key)
	}
	group.Wait()
	return errors.Join(failures...)
}

func (w *Worker) runAndObserve(ctx context.Context) {
	if err := w.RunOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
		if w.logger != nil {
			// 禁止将玩家、会话或轮次标识写入日志。
			w.logger.Error("round recovery pass failed", "error", err)
		}
	}
}
