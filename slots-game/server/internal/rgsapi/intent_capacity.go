package rgsapi

import "context"

// AdmissionCapacityUnavailable 表示进程主动为已提交结果的查询、投递和 ACK
// 保留依赖容量。它只允许用于尚未创建的新会话/经济意图，不能阻断恢复路由。
// English: AdmissionCapacityUnavailable indicates that the process actively reserves dependent capacity for
// querying, delivery, and ACK of submitted results. It is only allowed for new sessions/economic intents that have
// not been created yet and cannot block recovery routing.
const AdmissionCapacityUnavailable AdmissionDecision = 4

// NewIntentCapacity 为一次新会话或新经济意图提供非阻塞许可。成功返回的 release
// 必须在请求完成后调用；实现必须允许并发调用，并且不得在容量不足时排队。
// English: NewIntentCapacity Provides non-blocking permission for a new session or new economic intent. A release
// that returns successfully must be called after the request has completed; the implementation must allow
// concurrent calls and must not be queued when capacity is insufficient.
type NewIntentCapacity interface {
	TryAcquire(context.Context) (release func(), result AdmissionResult)
}
