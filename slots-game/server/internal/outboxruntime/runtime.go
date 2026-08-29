// outboxruntime 包将与传输层无关的分发器与已配置的 HTTP 审计接收端组合，
// 并负责其进程生命周期及就绪状态。
// English: The outboxruntime package combines a transport-layer-independent dispatcher with a configured HTTP
// audit sink and is responsible for its process lifecycle and readiness status.
package outboxruntime

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"slots-game/server/internal/outbox"
	"slots-game/server/internal/safelog"
)

type Config struct {
	EndpointURL       string
	HMACKeyID         string
	HMACKeyFile       string
	BearerTokenFile   string
	RootCAFile        string
	ClientCertFile    string
	ClientKeyFile     string
	AllowInsecureHTTP bool

	Dispatcher         outbox.DispatcherConfig
	WorkerMaxStaleness time.Duration
	BacklogMaxAge      time.Duration
	Now                func() time.Time
}

type Runtime struct {
	enabled    bool
	config     Config
	dispatcher *outbox.Dispatcher
	backlog    outbox.BacklogChecker
	publisher  *outbox.HTTPPublisher
	logger     *slog.Logger
	now        func() time.Time

	mu            sync.Mutex
	started       bool
	running       bool
	passStartedAt time.Time
	completedAt   time.Time
	passFailed    bool
	done          chan struct{}
}

func New(
	config Config,
	store outbox.Store,
	backlog outbox.BacklogChecker,
	logger *slog.Logger,
) (*Runtime, error) {
	if config.EndpointURL == "" {
		if config.HMACKeyID != "" || config.HMACKeyFile != "" || config.BearerTokenFile != "" ||
			config.RootCAFile != "" || config.ClientCertFile != "" || config.ClientKeyFile != "" {
			return nil, fmt.Errorf("%w: partial outbox HTTP configuration", outbox.ErrInvalidInput)
		}
		done := make(chan struct{})
		close(done)
		return &Runtime{done: done}, nil
	}
	if store == nil || backlog == nil {
		return nil, fmt.Errorf("%w: outbox store and backlog checker are required", outbox.ErrInvalidInput)
	}
	if config.Dispatcher.Interval == 0 {
		config.Dispatcher.Interval = time.Second
	}
	if config.Dispatcher.LeaseDuration == 0 {
		config.Dispatcher.LeaseDuration = 3 * time.Minute
	}
	if config.Dispatcher.PublishTimeout == 0 {
		config.Dispatcher.PublishTimeout = 10 * time.Second
	}
	if config.Dispatcher.Owner == "" {
		owner, err := newOwner()
		if err != nil {
			return nil, err
		}
		config.Dispatcher.Owner = owner
	}
	if config.WorkerMaxStaleness == 0 {
		config.WorkerMaxStaleness = config.Dispatcher.LeaseDuration + 2*config.Dispatcher.Interval
	}
	if config.BacklogMaxAge == 0 {
		config.BacklogMaxAge = 5 * time.Minute
	}
	if config.WorkerMaxStaleness < time.Second || config.WorkerMaxStaleness > 24*time.Hour ||
		config.BacklogMaxAge < time.Second || config.BacklogMaxAge > 30*24*time.Hour {
		return nil, fmt.Errorf("%w: invalid outbox readiness duration", outbox.ErrInvalidInput)
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	signingKey, err := outbox.LoadHMACKey(config.HMACKeyFile)
	if err != nil {
		return nil, err
	}
	defer clear(signingKey)
	bearerToken, err := outbox.LoadBearerToken(config.BearerTokenFile)
	if err != nil {
		return nil, err
	}
	defer clear(bearerToken)
	client, err := outbox.NewSecureHTTPClient(outbox.HTTPClientConfig{
		Timeout:    config.Dispatcher.PublishTimeout,
		RootCAFile: config.RootCAFile, ClientCertFile: config.ClientCertFile,
		ClientKeyFile: config.ClientKeyFile,
	})
	if err != nil {
		return nil, err
	}
	publisher, err := outbox.NewHTTPPublisher(outbox.HTTPPublisherConfig{
		Endpoint: config.EndpointURL, KeyID: config.HMACKeyID,
		SigningKey: signingKey, BearerToken: bearerToken, Client: client,
		AllowInsecureDevelopment: config.AllowInsecureHTTP, Now: now,
	})
	if err != nil {
		return nil, err
	}
	dispatcher, err := outbox.NewDispatcher(config.Dispatcher, store, publisher, nil)
	if err != nil {
		_ = publisher.Close()
		return nil, err
	}
	return &Runtime{
		enabled: true, config: config, dispatcher: dispatcher, backlog: backlog,
		publisher: publisher, logger: logger, now: now, done: make(chan struct{}),
	}, nil
}

func (runtime *Runtime) Enabled() bool { return runtime != nil && runtime.enabled }

// Start 立即开始一次分发扫描，随后按配置周期运行。只允许调用一次 Start，
// 防止两个循环共享同一所有者。
// English: Start starts a distribution scan immediately and then runs it on a configured cycle. Only one call to
// Start is allowed, preventing two loops from sharing the same owner.
func (runtime *Runtime) Start(ctx context.Context) error {
	if runtime == nil || !runtime.enabled {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	runtime.mu.Lock()
	if runtime.started {
		runtime.mu.Unlock()
		return fmt.Errorf("%w: outbox runtime already started", outbox.ErrInvalidInput)
	}
	runtime.started = true
	runtime.running = true
	runtime.passStartedAt = runtime.now().UTC()
	runtime.mu.Unlock()
	go runtime.run(ctx)
	return nil
}

func (runtime *Runtime) run(ctx context.Context) {
	defer func() {
		runtime.mu.Lock()
		runtime.running = false
		runtime.mu.Unlock()
		close(runtime.done)
	}()
	for {
		runtime.mu.Lock()
		runtime.passStartedAt = runtime.now().UTC()
		runtime.mu.Unlock()
		result, err := runtime.dispatcher.RunOnce(ctx)
		if ctx.Err() == nil {
			runtime.mu.Lock()
			runtime.completedAt = runtime.now().UTC()
			runtime.passFailed = err != nil
			runtime.mu.Unlock()
			runtime.observe(result, err)
		}
		if ctx.Err() != nil {
			return
		}
		timer := time.NewTimer(runtime.config.Dispatcher.Interval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return
		case <-timer.C:
		}
	}
}

func (runtime *Runtime) observe(result outbox.BatchResult, err error) {
	if runtime.logger == nil {
		return
	}
	if err != nil {
		runtime.logger.Error(
			"outbox dispatch pass failed",
			"claimed", result.Claimed, "published", result.Published,
			"failed", result.Failed, "lease_lost", result.LeaseLost,
			"error_class", safelog.ErrorClass(err),
		)
		return
	}
	if result.Failed > 0 {
		runtime.logger.Warn(
			"outbox publication deferred",
			"claimed", result.Claimed, "published", result.Published,
			"failed", result.Failed,
		)
	}
}

func (runtime *Runtime) Name() string { return "outbox_delivery" }

// Check 证明循环处于活动状态、其存储及租约扫描足够新，并且没有未发布事件超过配置的
// 服务目标。它刻意不生成合成审计事件；接收端可达性只由真实不可变事件的投递，
// 以及由此形成的有界积压时长证明。
// English: Check proves that the loop is active, that its storage and lease scans are sufficiently current, and
// that no unpublished events exceed the configured service target. It intentionally does not generate synthetic
// audit events; receiver reachability is demonstrated only by the delivery of true immutable events and the
// resulting bounded backlog length.
func (runtime *Runtime) Check(ctx context.Context) error {
	if runtime == nil || !runtime.enabled {
		return outbox.ErrDisabled
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	runtime.mu.Lock()
	running := runtime.running
	passStartedAt := runtime.passStartedAt
	completedAt := runtime.completedAt
	passFailed := runtime.passFailed
	runtime.mu.Unlock()
	if !running || completedAt.IsZero() {
		return errors.New("outbox runtime: dispatch loop has not completed a pass")
	}
	freshest := completedAt
	if passStartedAt.After(freshest) {
		freshest = passStartedAt
	}
	if runtime.now().UTC().Sub(freshest) > runtime.config.WorkerMaxStaleness {
		return errors.New("outbox runtime: dispatch loop is stale")
	}
	if passFailed {
		return errors.New("outbox runtime: last store/lease pass failed")
	}
	return runtime.backlog.CheckBacklog(ctx, runtime.config.BacklogMaxAge)
}

func (runtime *Runtime) Wait(ctx context.Context) error {
	if runtime == nil {
		return nil
	}
	select {
	case <-runtime.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (runtime *Runtime) Close() error {
	if runtime == nil || runtime.publisher == nil {
		return nil
	}
	return runtime.publisher.Close()
}

func newOwner() (string, error) {
	var entropy [12]byte
	if _, err := cryptorand.Read(entropy[:]); err != nil {
		return "", fmt.Errorf("outbox runtime: generate owner: %w", err)
	}
	return "rgs-" + hex.EncodeToString(entropy[:]), nil
}
