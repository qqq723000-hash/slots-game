package main

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"sync/atomic"

	"slots-game/server/internal/platform"
	"slots-game/server/internal/rgsapi"
)

type databasePoolStats interface {
	Stats() sql.DBStats
}

// databaseIntentCapacity 同时使用硬许可与数据库池快照。每个尚未结束的新意图都
// 保守预留至多一条连接；预留与当前 InUse 的和不得侵占关键读取预算，因此并发请求
// 不能共同观察同一个空闲快照后穿透。
//
// database/sql 不暴露连接与请求的归属，已经进入 InUse 的新意图仍可能同时计入预留。
// 这是同池模型刻意选择的失败关闭上界：允许提前 shed，绝不为避免双计而漏算尚未
// 取得连接的请求。只有把关键读取迁移到独立连接池后，才能安全消除该保守双计。
type databaseIntentCapacity struct {
	pool         databasePoolStats
	reservations atomic.Int64
	threshold    int64
	metrics      *platform.Metrics
}

func newDatabaseIntentCapacity(
	pool databasePoolStats,
	maxOpen int,
	criticalReserve int,
	metrics *platform.Metrics,
) (*databaseIntentCapacity, error) {
	if pool == nil || maxOpen < 2 || criticalReserve < 1 || criticalReserve >= maxOpen {
		return nil, errors.New("database intent capacity requires a non-empty critical reserve")
	}
	threshold := int64(maxOpen - criticalReserve)
	return &databaseIntentCapacity{
		pool: pool, threshold: threshold, metrics: metrics,
	}, nil
}

func (capacity *databaseIntentCapacity) TryAcquire(
	ctx context.Context,
) (func(), rgsapi.AdmissionResult) {
	if capacity == nil || capacity.pool == nil || ctx.Err() != nil {
		return nil, rgsapi.AdmissionResult{
			Decision: rgsapi.AdmissionCapacityUnavailable,
		}
	}
	for {
		if ctx.Err() != nil {
			return nil, rgsapi.AdmissionResult{Decision: rgsapi.AdmissionCapacityUnavailable}
		}
		reserved := capacity.reservations.Load()
		inUse := int64(capacity.pool.Stats().InUse)
		if inUse >= capacity.threshold || reserved >= capacity.threshold-inUse {
			capacity.rejected()
			return nil, rgsapi.AdmissionResult{Decision: rgsapi.AdmissionCapacityUnavailable}
		}
		// CAS 把快照对应的空闲预算原子转换为本次预留；竞争失败必须重新读取
		// InUse 和预留总数，禁止复用已经过期的共同空闲快照。
		if !capacity.reservations.CompareAndSwap(reserved, reserved+1) {
			continue
		}
		release := sync.OnceFunc(func() { capacity.reservations.Add(-1) })
		return release, rgsapi.AdmissionResult{Decision: rgsapi.AdmissionAllowed}
	}
}

func (capacity *databaseIntentCapacity) rejected() {
	if capacity.metrics != nil {
		capacity.metrics.NewIntentCapacityRejected.Add(1)
	}
}

var _ rgsapi.NewIntentCapacity = (*databaseIntentCapacity)(nil)
