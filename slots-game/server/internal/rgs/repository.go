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
	PrepareRound(context.Context, SpinRequest, string, Profile, PrepareOutcome) (RoundRecord, bool, error)
	ClaimWallet(context.Context, RoundKey, time.Duration) (WalletRecoveryClaim, bool, error)
	ScheduleWalletRecovery(
		context.Context,
		WalletRecoveryClaim,
		WalletRecoveryDisposition,
		time.Duration,
	) (bool, error)
	// 转换方法返回的布尔值仅在本次调用将轮次持久改为请求状态时为真，
	// 防止并发重试及幂等重放重复累计业务转换指标。
	CommitClaim(context.Context, WalletRecoveryClaim, WalletReceipt) (RoundRecord, bool, error)
	RejectClaim(context.Context, WalletRecoveryClaim, string) (RoundRecord, bool, error)
	MarkClaimManualReview(context.Context, WalletRecoveryClaim, string) (RoundRecord, bool, error)
	// MarkManualReview 是不依赖钱包 claim 的数据完整性隔离入口。正常钱包结果必须使用
	// MarkClaimManualReview，防止旧 worker 绕过租约栅栏覆盖新 owner 的状态。
	MarkManualReview(context.Context, RoundKey, string) (RoundRecord, bool, error)
}

// RecoveryRepository 由可在进程崩溃后领取未终结轮次的持久适配器实现。领取必须以
// 存储时钟、行级跳锁和租约栅栏原子完成，避免多个 Worker 重复扫描或同时外呼钱包。
type RecoveryRepository interface {
	ClaimRecoverableRounds(context.Context, int, time.Duration) ([]WalletRecoveryClaim, error)
	ScheduleWalletRecovery(
		context.Context,
		WalletRecoveryClaim,
		WalletRecoveryDisposition,
		time.Duration,
	) (bool, error)
}
