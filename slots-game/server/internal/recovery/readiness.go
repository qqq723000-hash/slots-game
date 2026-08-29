package recovery

import (
	"context"
	"errors"
	"sync/atomic"
)

// StartupReadiness 只记录恢复 worker 是否至少完整完成过一次成功恢复 pass。
// 一旦成功便不可逆地就绪；后续循环故障由恢复新鲜度指标告警，不能反复摘除副本。
// English: StartupReadiness only records whether the recovery worker has completed at least one successful
// recovery pass. Once successful, it is irreversibly ready; subsequent cycle failures are alerted by the recovery
// freshness indicator, and replicas cannot be removed repeatedly.
type StartupReadiness struct {
	succeeded atomic.Bool
}

func NewStartupReadiness() *StartupReadiness { return &StartupReadiness{} }

func (*StartupReadiness) Name() string { return "recovery_startup" }

func (readiness *StartupReadiness) Check(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if readiness == nil || !readiness.succeeded.Load() {
		return errors.New("recovery startup pass has not succeeded")
	}
	return nil
}

func (readiness *StartupReadiness) MarkSuccessfulPass() {
	if readiness != nil {
		readiness.succeeded.Store(true)
	}
}
