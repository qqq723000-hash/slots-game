package rgsapi

import "context"

// AdmissionCapacityUnavailable 表示进程主动为已提交结果的查询、投递和 ACK
// 保留依赖容量。它只允许用于尚未创建的 launch/spin，不能阻断恢复路由。
const AdmissionCapacityUnavailable AdmissionDecision = 4

// NewIntentCapacity 为一次新经济意图提供非阻塞许可。成功返回的 release 必须在
// 请求完成后调用；实现必须允许并发调用，并且不得在容量不足时排队。
type NewIntentCapacity interface {
	TryAcquire(context.Context) (release func(), result AdmissionResult)
}
