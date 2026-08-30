package main

import (
	"log/slog"
	"time"

	"slots-game/server/internal/platform"
)

const (
	securityLogRatePerSecond = 10
	securityLogBurst         = 20
	securityLogMaxInFlight   = 2
)

type securityEventObserver struct {
	logger   *slog.Logger
	metrics  *platform.Metrics
	limiter  *platform.Limiter
	capacity *boundedCapacity
}

func newSecurityEventObserver(logger *slog.Logger, metrics *platform.Metrics) *securityEventObserver {
	return &securityEventObserver{
		logger: logger, metrics: metrics,
		limiter: platform.NewLimiter(
			securityLogRatePerSecond,
			securityLogBurst,
			1,
			time.Hour,
		),
		capacity: newBoundedCapacity(securityLogMaxInFlight),
	}
}

func (observer *securityEventObserver) NonceReplay() {
	if observer == nil {
		return
	}
	if observer.metrics != nil {
		observer.metrics.NonceReplay()
	}
	if observer.logger == nil {
		return
	}
	// 安全事件计数在上方始终完整记录；这里只限制重复物理日志写入。固定键避免
	// 攻击者制造 limiter 状态，非阻塞 bulkhead 防止 stdout/collector 背压占满协程。
	// English: Security event counts are always fully logged above; only repeated physical log writes are limited
	// here. Fixed keys prevent attackers from creating limiter states, and non-blocking bulkhead prevents
	// stdout/collector back pressure from filling up the coroutine.
	if observer.limiter == nil || !observer.limiter.Allow("nonce-replay", time.Now()) {
		observer.securityLogDropped()
		return
	}
	release := observer.capacity.TryAcquire()
	if release == nil {
		observer.securityLogDropped()
		return
	}
	defer release()
	observer.logger.Warn("检测到认证随机数重放", "security_event", "nonce_replay")
}

func (observer *securityEventObserver) securityLogDropped() {
	if observer != nil && observer.metrics != nil {
		observer.metrics.SecurityLogDropped()
	}
}
