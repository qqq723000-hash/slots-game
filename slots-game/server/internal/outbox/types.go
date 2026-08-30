// outbox 包提供与传输层无关的事务发件箱投递能力。领域事务在 PostgreSQL 中追加记录；
// Dispatcher 租用并发布这些记录，且不会重复领域副作用。
// English: The outbox package provides transport-layer independent transaction outbox delivery capabilities. Realm
// transactions append records in PostgreSQL; the Dispatcher leases and publishes these records without duplicating
// realm side effects.
package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

var (
	ErrInvalidInput = errors.New("outbox: invalid input")
	ErrLeaseLost    = errors.New("outbox: delivery lease lost")
	ErrInvariant    = errors.New("outbox: persisted event invariant violated")
	ErrDeliveryLag  = errors.New("outbox: unpublished event age exceeds readiness limit")
	ErrDisabled     = errors.New("outbox: delivery is disabled")
)

// Event 是不可变的发件箱消息。事件被租用时，存储会递增 Attempts。消费者必须按 ID 去重；
// 跨越发布与确认之间的崩溃边界时，投递语义刻意设为至少一次。
// English: Events are immutable outbox messages. When an event is rented, the storage increments Attempts.
// Consumers must deduplicate by ID; delivery semantics are intentionally set to at-least-once when crossing the
// crash boundary between publish and acknowledge.
type Event struct {
	ID            int64
	OperatorID    string
	AggregateType string
	AggregateID   string
	EventType     string
	Payload       json.RawMessage
	CreatedAt     time.Time
	AvailableAt   time.Time
	LeaseUntil    time.Time
	Attempts      int
}

type ClaimRequest struct {
	Owner         string
	LeaseToken    string
	LeaseDuration time.Duration
	Limit         int
}

type Completion struct {
	EventID    int64
	LeaseToken string
}

type Failure struct {
	EventID    int64
	LeaseToken string
	RetryAfter time.Duration
	Code       string
}

// Store 负责租约围栏。事件被其他分发器重新领取后，过期的完成或失败操作必须返回 ErrLeaseLost。
// English: Store is responsible for the lease fencing. Expired completion or failure operations must return
// ErrLeaseLost after the event is reclaimed by another dispatcher.
type Store interface {
	Claim(context.Context, ClaimRequest) ([]Event, error)
	MarkPublished(context.Context, Completion) error
	MarkFailed(context.Context, Failure) error
}

// BacklogChecker 报告每个未发布事件的存续时间是否小于配置的投递时效服务目标。
// 它刻意只读，不会使用合成审计事件探测外部接收端。
// English: BacklogChecker reports whether the age of each unpublished event is less than the configured delivery
// aging service target. It is intentionally read-only and does not use synthetic audit events to probe external
// sinks.
type BacklogChecker interface {
	CheckBacklog(context.Context, time.Duration) error
}

// Publisher 向外部审计或事件系统发送一个不可变事件。实现必须将 Event.ID 作为幂等键，
// 因为 Publish 成功后、MarkPublished 提交前发生崩溃会导致重复投递。当实现忽略上下文取消，
// 并在 Dispatcher 已判定超时且安排重试后才完成时，同样适用此要求。
// English: Publisher sends an immutable event to an external audit or event system. Implementations must use
// Event.ID as an idempotent key because a crash after Publish succeeds but before MarkPublished is submitted will
// result in duplicate delivery. This requirement also applies when the implementation ignores context cancellation
// and completes after the Dispatcher has determined that it has timed out and scheduled a retry.
type Publisher interface {
	Publish(context.Context, Event) error
}
