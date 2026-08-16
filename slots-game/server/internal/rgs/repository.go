package rgs

import (
	"context"
	"time"
)

// PrepareOutcome 在存储库持有会话转换所有权期间执行。实现必须同时持久化返回的预备轮次与
// 待处理标记，或两者都不持久化。同一轮次的并发调用绝不能执行它超过一次。
type PrepareOutcome func(Session) (SpinResult, error)

// Repository 表达 Coordinator 所需的事务操作，避免将会话与轮次错误拆成两个可独立写入的存储。
type Repository interface {
	CreateSession(context.Context, Session) error
	GetSession(context.Context, string, string) (Session, error)
	GetRound(context.Context, RoundKey) (RoundRecord, error)
	GetPendingResultDelivery(context.Context, string, string) (ResultDelivery, error)
	AcknowledgeResultDelivery(context.Context, ResultDeliveryAcknowledgement) (ResultDelivery, bool, error)
	PrepareRound(context.Context, SpinRequest, string, PrepareOutcome) (RoundRecord, bool, error)
	ClaimWallet(context.Context, RoundKey, time.Time, time.Time) (RoundRecord, bool, error)
	// 转换方法返回的布尔值仅在本次调用将轮次持久改为请求状态时为真，
	// 防止并发重试及幂等重放重复累计业务转换指标。
	CommitRound(context.Context, RoundKey, WalletReceipt) (RoundRecord, bool, error)
	RejectRound(context.Context, RoundKey, string) (RoundRecord, bool, error)
	MarkManualReview(context.Context, RoundKey, string) (RoundRecord, bool, error)
}

// RecoveryRepository 由可在进程崩溃后枚举未终结轮次的持久适配器实现。枚举仅供参考；
// 多个副本可能返回同一键，因为实际租约由 ClaimWallet 提供，且所有钱包操作均保持幂等。
type RecoveryRepository interface {
	ListRecoverableRounds(context.Context, time.Time, int) ([]RoundKey, error)
}
