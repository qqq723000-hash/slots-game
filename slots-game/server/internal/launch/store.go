package launch

import (
	"context"
	"time"
)

// Store 只持久化启动凭据摘要。Create 必须在同一次原子写入中以 Store 权威时钟生成并返回
// CreatedAt/ExpiresAt。Consume 必须以原子方式验证运营商及会话绑定、验证过期时间，并将记录
// 标为已用。所有不可消费凭据均返回 ErrCodeUnavailable，Create 冲突则返回 ErrDigestExists。
// English: The Store only persists the startup credential digest. Create must generate and return
// CreatedAt/ExpiresAt with the Store's authoritative clock in the same atomic write. Consume must atomically
// validate carrier and session bindings, validate expiration times, and mark records as used. All unconsumable
// credentials return ErrCodeUnavailable, Create conflicts return ErrDigestExists.
type Store interface {
	Create(context.Context, CreateRequest) (Record, error)
	Consume(context.Context, ConsumeRequest) (Record, error)
}

// ReplayObservation 把启动记录与存储在同一次读取中观测到的权威时间绑定。
// Service 不得用进程墙钟替代 ObservedAt 裁决保留窗口或 historical replay。
// English: ReplayObservation binds the startup record to the authoritative time observed during the same read. A
// Service must not use the process wall clock in place of the ObservedAt ruling to preserve windows or historical
// replay.
type ReplayObservation struct {
	Record     Record
	ObservedAt time.Time
}

// ReplayStore 支持受信运营商在丢失 HTTP 响应后重试启动时进行幂等恢复。查询仅供内部使用，
// 接收与 Create 相同的不可逆摘要，并在幂等墓碑保留期间返回已消费或兑换窗口已过期的记录。
// English: ReplayStore supports idempotent recovery by trusted operators when retrying startup after a lost HTTP
// response. The query is for internal use only, receives the same irreversible digest as Create and returns
// records that have been consumed or whose redemption window has expired during the idempotent tombstone retention
// period.
type ReplayStore interface {
	Store
	Get(context.Context, CodeDigest) (ReplayObservation, error)
}
