package outbox

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"slots-game/server/internal/safelog"
)

const publishFailureCode = "PUBLISH_FAILED"

type DispatcherConfig struct {
	Owner          string
	Interval       time.Duration
	LeaseDuration  time.Duration
	PublishTimeout time.Duration
	BatchSize      int
	MaxParallel    int
	InitialBackoff time.Duration
	MaximumBackoff time.Duration
	Observer       Observer
}

type BatchResult struct {
	Claimed   int
	Published int
	Failed    int
	LeaseLost int
}

// Observer 接收每次分发扫描的一项有界基数汇总。Published 和 Failed 仅统计已由 Store
// 持久确认的完成结果；LeaseLost 统计被围栏拒绝的过期完成结果。Claimed 统计投递尝试，
// 因此重试事件会刻意再次增加该值。
type Observer interface {
	ObserveOutboxDispatch(BatchResult)
}

type deliveryResult struct {
	published bool
	failed    bool
	err       error
}

type Dispatcher struct {
	config    DispatcherConfig
	store     Store
	publisher Publisher
	logger    *slog.Logger
	observer  Observer
	runSlot   chan struct{}
	// publishSlots 会保持占用直至 Publisher 真正返回，而不是仅持续到其上下文过期。
	// 因此不配合取消的 Publisher 最多遗留 MaxParallel 个协程；后续尝试会在等待槽位时超时，
	// 不会继续创建被阻塞的协程。
	publishSlots chan struct{}
}

func NewDispatcher(
	config DispatcherConfig,
	store Store,
	publisher Publisher,
	logger *slog.Logger,
) (*Dispatcher, error) {
	if store == nil || publisher == nil {
		return nil, fmt.Errorf("%w: store and publisher are required", ErrInvalidInput)
	}
	if config.Interval == 0 {
		config.Interval = time.Second
	}
	if config.LeaseDuration == 0 {
		config.LeaseDuration = 3 * time.Minute
	}
	if config.PublishTimeout == 0 {
		config.PublishTimeout = 10 * time.Second
	}
	if config.BatchSize == 0 {
		config.BatchSize = 100
	}
	if config.MaxParallel == 0 {
		config.MaxParallel = 8
	}
	if config.InitialBackoff == 0 {
		config.InitialBackoff = time.Second
	}
	if config.MaximumBackoff == 0 {
		config.MaximumBackoff = 5 * time.Minute
	}
	if !validIdentifier(config.Owner) ||
		config.Interval < 10*time.Millisecond || config.Interval > time.Hour ||
		config.PublishTimeout < 10*time.Millisecond || config.PublishTimeout > time.Hour ||
		config.LeaseDuration < 10*time.Millisecond || config.LeaseDuration > 2*time.Hour ||
		config.BatchSize < 1 || config.BatchSize > 1_000 ||
		config.MaxParallel < 1 || config.MaxParallel > 256 ||
		config.InitialBackoff < time.Millisecond ||
		config.MaximumBackoff < config.InitialBackoff || config.MaximumBackoff > 24*time.Hour {
		return nil, fmt.Errorf("%w: invalid dispatcher configuration", ErrInvalidInput)
	}
	publishWaves := (config.BatchSize + config.MaxParallel - 1) / config.MaxParallel
	if config.PublishTimeout > 2*time.Hour/time.Duration(publishWaves) ||
		config.LeaseDuration <= config.PublishTimeout*time.Duration(publishWaves) {
		return nil, fmt.Errorf("%w: lease is shorter than the bounded batch publish window", ErrInvalidInput)
	}
	return &Dispatcher{
		config: config, store: store, publisher: publisher, logger: logger,
		observer: config.Observer,
		runSlot:  make(chan struct{}, 1), publishSlots: make(chan struct{}, config.MaxParallel),
	}, nil
}

// Run 立即执行一次分发，随后按配置周期运行。短暂的扫描失败会被观测并重试；
// 只有取消才会终止。崩溃安全由租约提供，而非依赖进程关闭钩子。
func (d *Dispatcher) Run(ctx context.Context) {
	d.runAndObserve(ctx)
	ticker := time.NewTicker(d.config.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.runAndObserve(ctx)
		}
	}
}

func (d *Dispatcher) RunOnce(ctx context.Context) (result BatchResult, err error) {
	defer func() { d.observe(result) }()
	if err := ctx.Err(); err != nil {
		return BatchResult{}, err
	}
	select {
	case d.runSlot <- struct{}{}:
		defer func() { <-d.runSlot }()
	case <-ctx.Done():
		return BatchResult{}, ctx.Err()
	}
	leaseToken, err := newLeaseToken()
	if err != nil {
		return BatchResult{}, err
	}
	events, err := d.store.Claim(ctx, ClaimRequest{
		Owner: d.config.Owner, LeaseToken: leaseToken,
		LeaseDuration: d.config.LeaseDuration, Limit: d.config.BatchSize,
	})
	if err != nil {
		return BatchResult{}, err
	}
	result = BatchResult{Claimed: len(events)}
	if len(events) == 0 {
		return result, nil
	}

	semaphore := make(chan struct{}, d.config.MaxParallel)
	completed := make(chan deliveryResult, len(events))
	var group sync.WaitGroup
dispatchLoop:
	for _, event := range events {
		if err := ctx.Err(); err != nil {
			break
		}
		select {
		case semaphore <- struct{}{}:
		case <-ctx.Done():
			break dispatchLoop
		}
		group.Add(1)
		go func(event Event) {
			defer group.Done()
			defer func() { <-semaphore }()
			completed <- d.deliver(ctx, leaseToken, event)
		}(event)
	}
	group.Wait()
	close(completed)

	var failures []error
	for delivery := range completed {
		switch {
		case delivery.published:
			result.Published++
		case delivery.failed:
			result.Failed++
		}
		if delivery.err != nil {
			if errors.Is(delivery.err, ErrLeaseLost) {
				result.LeaseLost++
			}
			failures = append(failures, delivery.err)
		}
	}
	if result.Published+result.Failed+result.LeaseLost < result.Claimed && ctx.Err() != nil {
		failures = append(failures, ctx.Err())
	}
	return result, errors.Join(failures...)
}

func (d *Dispatcher) observe(result BatchResult) {
	if d.observer == nil {
		return
	}
	defer func() { _ = recover() }()
	d.observer.ObserveOutboxDispatch(result)
}

func (d *Dispatcher) deliver(ctx context.Context, leaseToken string, event Event) deliveryResult {
	publishCtx, cancel := context.WithTimeout(ctx, d.config.PublishTimeout)
	publishErr := d.publishWithHardDeadline(publishCtx, event)
	cancel()
	if publishErr == nil {
		err := d.store.MarkPublished(ctx, Completion{EventID: event.ID, LeaseToken: leaseToken})
		return deliveryResult{published: err == nil, err: err}
	}

	retryAfter := RetryDelay(event.Attempts, d.config.InitialBackoff, d.config.MaximumBackoff)
	err := d.store.MarkFailed(ctx, Failure{
		EventID: event.ID, LeaseToken: leaseToken,
		RetryAfter: retryAfter, Code: publishFailureCode,
	})
	return deliveryResult{failed: err == nil, err: err}
}

func (d *Dispatcher) publishWithHardDeadline(ctx context.Context, event Event) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case d.publishSlots <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		<-d.publishSlots
		return err
	}

	completed := make(chan error, 1)
	go func() {
		err := guardedPublish(ctx, d.publisher, event)
		<-d.publishSlots
		completed <- err
	}()
	select {
	case err := <-completed:
		return err
	case <-ctx.Done():
		// Publisher 仍可能稍后产生副作用。其协程会保留全局槽位直至真正返回，
		// 从而限制泄漏数量，并阻止后续扫描生成无限量阻塞调用。
		return ctx.Err()
	}
}

func (d *Dispatcher) runAndObserve(ctx context.Context) {
	result, err := d.RunOnce(ctx)
	if d.logger == nil || errors.Is(err, context.Canceled) {
		return
	}
	if err != nil {
		d.logger.Error(
			"outbox dispatch pass failed",
			"claimed", result.Claimed,
			"published", result.Published,
			"failed", result.Failed,
			"lease_lost", result.LeaseLost,
			"error_class", safelog.ErrorClass(err),
		)
		return
	}
	if result.Failed > 0 {
		d.logger.Warn(
			"outbox publication deferred",
			"claimed", result.Claimed,
			"published", result.Published,
			"failed", result.Failed,
		)
	}
}

// RetryDelay 返回 base*2^(attempt-1)，并在不发生时长溢出的前提下应用上限。
// Attempts 是领取后的持久化尝试次数，因此首次失败恰好等待 base。
func RetryDelay(attempt int, base, maximum time.Duration) time.Duration {
	if base <= 0 || maximum < base {
		return 0
	}
	if attempt < 1 {
		attempt = 1
	}
	delay := base
	for step := 1; step < attempt; step++ {
		if delay >= maximum || delay > maximum/2 {
			return maximum
		}
		delay *= 2
	}
	if delay > maximum {
		return maximum
	}
	return delay
}

func newLeaseToken() (string, error) {
	var entropy [16]byte
	if _, err := cryptorand.Read(entropy[:]); err != nil {
		return "", fmt.Errorf("outbox: generate lease token: %w", err)
	}
	return "lease_" + hex.EncodeToString(entropy[:]), nil
}

func guardedPublish(ctx context.Context, publisher Publisher, event Event) (err error) {
	defer func() {
		if recover() != nil {
			err = errors.New("outbox: publisher panicked")
		}
	}()
	return publisher.Publish(ctx, event)
}

func validIdentifier(value string) bool {
	if len(value) < 1 || len(value) > 128 {
		return false
	}
	for index, character := range value {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			(index > 0 && (character == '.' || character == '_' || character == ':' || character == '-')) {
			continue
		}
		return false
	}
	return true
}
