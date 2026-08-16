package launch

import "context"

// Store 只持久化启动凭据摘要。Consume 必须以原子方式验证运营商及会话绑定、验证过期时间，
// 并将记录标为已用。所有不可消费凭据均返回 ErrCodeUnavailable，Create 冲突则返回
// ErrDigestExists 错误。
type Store interface {
	Create(context.Context, Record) error
	Consume(context.Context, ConsumeRequest) (Record, error)
}

// ReplayStore 支持受信运营商在丢失 HTTP 响应后重试启动时进行幂等恢复。查询仅供内部使用，
// 接收与 Create 相同的不可逆摘要，并在幂等墓碑保留期间返回已消费或兑换窗口已过期的记录。
type ReplayStore interface {
	Store
	Get(context.Context, CodeDigest) (Record, error)
}
