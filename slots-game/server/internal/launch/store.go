package launch

import (
	"context"
	"time"
)

// Store 只持久化启动凭据摘要。Create 必须在同一次原子写入中以 Store 权威时钟生成并返回
// CreatedAt/ExpiresAt。Consume 必须以原子方式验证运营商及会话绑定、验证过期时间，并将记录
// 标为已用。所有不可消费凭据均返回 ErrCodeUnavailable，Create 冲突则返回 ErrDigestExists。
type Store interface {
	Create(context.Context, CreateRequest) (Record, error)
	Consume(context.Context, ConsumeRequest) (Record, error)
}

// ReplayObservation 把启动记录与存储在同一次读取中观测到的权威时间绑定。
// Service 不得用进程墙钟替代 ObservedAt 裁决保留窗口或 historical replay。
type ReplayObservation struct {
	Record     Record
	ObservedAt time.Time
}

// ReplayStore 支持受信运营商在丢失 HTTP 响应后重试启动时进行幂等恢复。查询仅供内部使用，
// 接收与 Create 相同的不可逆摘要，并在幂等墓碑保留期间返回已消费或兑换窗口已过期的记录。
type ReplayStore interface {
	Store
	Get(context.Context, CodeDigest) (ReplayObservation, error)
}
