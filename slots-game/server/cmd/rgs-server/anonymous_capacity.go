package main

import (
	"context"
	"sync"

	"slots-game/server/internal/platform"
	"slots-game/server/internal/rgsapi"
)

// boundedCapacity 为未认证公网请求或密码学工作提供单一非阻塞硬上限。
// 认证前的 path、RemoteAddr 和请求头都可伪造，不能据此分配第二个优先池。
type boundedCapacity struct {
	permits chan struct{}
}

func newBoundedCapacity(total int) *boundedCapacity {
	if total < 1 {
		return nil
	}
	return &boundedCapacity{permits: make(chan struct{}, total)}
}

func (capacity *boundedCapacity) TryAcquire() func() {
	if capacity == nil {
		return nil
	}
	select {
	case capacity.permits <- struct{}{}:
		return sync.OnceFunc(func() { <-capacity.permits })
	default:
		return nil
	}
}

type serverCryptographicCapacity struct {
	capacity *boundedCapacity
	metrics  *platform.Metrics
}

func newServerCryptographicCapacity(
	total int,
	metrics *platform.Metrics,
) *serverCryptographicCapacity {
	return &serverCryptographicCapacity{
		capacity: newBoundedCapacity(total),
		metrics:  metrics,
	}
}

func (capacity *serverCryptographicCapacity) TryAcquire(
	ctx context.Context,
) (func(), rgsapi.AdmissionResult) {
	if capacity == nil || capacity.capacity == nil || ctx == nil || ctx.Err() != nil {
		capacity.rejected()
		return nil, rgsapi.AdmissionResult{Decision: rgsapi.AdmissionCapacityUnavailable}
	}
	release := capacity.capacity.TryAcquire()
	if release == nil {
		capacity.rejected()
		return nil, rgsapi.AdmissionResult{Decision: rgsapi.AdmissionCapacityUnavailable}
	}
	return release, rgsapi.AdmissionResult{Decision: rgsapi.AdmissionAllowed}
}

func (capacity *serverCryptographicCapacity) rejected() {
	if capacity == nil || capacity.metrics == nil {
		return
	}
	capacity.metrics.CryptographicCapacityRejected.Add(1)
}

var _ rgsapi.CryptographicCapacity = (*serverCryptographicCapacity)(nil)
