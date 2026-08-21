package main

import (
	"log/slog"

	"slots-game/server/internal/platform"
)

type securityEventObserver struct {
	logger  *slog.Logger
	metrics *platform.Metrics
}

func newSecurityEventObserver(logger *slog.Logger, metrics *platform.Metrics) *securityEventObserver {
	return &securityEventObserver{logger: logger, metrics: metrics}
}

func (observer *securityEventObserver) NonceReplay() {
	if observer == nil {
		return
	}
	if observer.metrics != nil {
		observer.metrics.NonceReplay()
	}
	if observer.logger != nil {
		observer.logger.Warn("检测到认证随机数重放", "security_event", "nonce_replay")
	}
}
