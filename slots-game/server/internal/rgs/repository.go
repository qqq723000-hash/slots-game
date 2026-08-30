package rgs

import (
	"context"
	"time"
)

// PrepareOutcome 在存储库持有会话转换所有权期间执行。实现必须同时持久化返回的预备轮次与
// 待处理标记，或两者都不持久化。同一轮次的并发调用绝不能执行它超过一次。
// English: PrepareOutcome is executed while the repository holds ownership of the session transition.
// Implementations MUST persist both the returned preparation round and the pending token, or neither. Concurrent
// calls of the same round must never execute it more than once.
type PrepareOutcome func(Session) (SpinResult, error)

// Repository 表达 Coordinator 所需的事务操作，避免将会话与轮次错误拆成两个可独立写入的存储。
// English: Repository expresses the transaction operations required by the Coordinator to avoid splitting session
// and round errors into two independently writable stores.
type Repository interface {
	CreateSession(context.Context, Session) error
	GetSession(context.Context, string, string) (Session, error)
	// AuthorizeSessionRelaunch 使用权威存储时钟确认持久会话仍处于可恢复的绝对
	// 有效期。idle 超时只终止旧浏览器传输，不阻止 operator relaunch；该方法不得
	// 推进传输代际、延长绝对有效期或修改任何经济状态。
	// English: AuthorizeSessionRelaunch uses the authoritative storage clock to confirm that the persistent session is
	// still in a recoverable absolute validity period. The idle timeout only terminates the old browser transfer and
	// does not prevent operator relaunch; this method must not advance transfer generations, extend the absolute
	// validity period, or modify any economic state.
	AuthorizeSessionRelaunch(context.Context, string, string) (Session, error)
	// ResetSessionTransport 是唯一 relaunch 原语：保留全部经济字段与绝对到期时间，
	// 同时原子推进浏览器隔离代际并替换 idle 截止时间。返回的 ServerTime 必须来自
	// 执行到期判定的同一权威存储时钟。
	// English: ResetSessionTransport is the only relaunch primitive: retaining all economic fields and absolute
	// expiration times, while atomically advancing the browser isolation generation and replacing the idle expiration
	// time. The returned ServerTime must be from the same authoritative storage clock that performed the expiration
	// decision.
	ResetSessionTransport(context.Context, string, string, time.Duration) (Session, error)
	// AuthorizeSessionTransport 校验持久代际与数据库期限。allowIdleRecovery 只保留给
	// round/result 恢复与 ACK，idle 超时后绝不允许新经济意图或 token refresh；
	// 返回的 ServerTime 必须来自权威存储时钟。
	// English: AuthorizeSessionTransport verifies persistence generation and database expiration. allowIdleRecovery is
	// only reserved for round/result recovery with ACK, and new economic intent or token refresh is never allowed
	// after idle timeout; the returned ServerTime must come from the authoritative storage clock.
	AuthorizeSessionTransport(context.Context, string, string, uint64, bool) (Session, error)
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
	// Transition methods return true only when this call persistently changes the round to the requested state,
	// preventing concurrent retries and idempotent replays from double-counting business-transition metrics.
	CommitClaim(context.Context, WalletRecoveryClaim, WalletReceipt) (RoundRecord, bool, error)
	RejectClaim(context.Context, WalletRecoveryClaim, string) (RoundRecord, bool, error)
	MarkClaimManualReview(context.Context, WalletRecoveryClaim, string) (RoundRecord, bool, error)
	// MarkManualReview 是不依赖钱包 claim 的数据完整性隔离入口。正常钱包结果必须使用
	// MarkClaimManualReview，防止旧 worker 绕过租约栅栏覆盖新 owner 的状态。
	// English: MarkManualReview is a data integrity isolation portal that does not rely on wallet claims. Normal
	// wallet results must use MarkClaimManualReview to prevent old workers from bypassing the lease fence and
	// overwriting the new owner's state.
	MarkManualReview(context.Context, RoundKey, string) (RoundRecord, bool, error)
}

// RecoveryRepository 由可在进程崩溃后领取未终结轮次的持久适配器实现。领取必须以
// 存储时钟、行级跳锁和租约栅栏原子完成，避免多个 Worker 重复扫描或同时外呼钱包。
// English: RecoveryRepository is implemented by a persistent adapter that can claim outstanding rounds after a
// process crash. Receipt must be completed atomically with storage clocks, row-level skip locks, and lease fences
// to avoid multiple workers from repeatedly scanning or making outbound calls to the wallet at the same time.
type RecoveryRepository interface {
	ClaimRecoverableRounds(context.Context, int, time.Duration) ([]WalletRecoveryClaim, error)
	ScheduleWalletRecovery(
		context.Context,
		WalletRecoveryClaim,
		WalletRecoveryDisposition,
		time.Duration,
	) (bool, error)
	// RecoverySnapshot 返回数据库全局持久调度恢复积压的有界下界，而不是当前 Worker
	// 本地领取数。Backlog 达到 RecoverySnapshotBacklogLimit 表示实际值至少达到该值；
	// OldestDueAge 仍使用存储时钟计算全局最早 next_attempt_at 的逾期时间。
	// English: RecoverySnapshot returns the bounded lower bound of the database's global persistent schedule recovery
	// backlog, rather than the current number of Worker local claims. Backlog reaching RecoverySnapshotBacklogLimit
	// means that the actual value reaches at least that value; OldestDueAge still uses the storage clock to calculate
	// the expiration time of the global earliest next_attempt_at.
	RecoverySnapshot(context.Context) (RecoverySnapshot, error)
}

// RecoverySnapshotBacklogLimit 是饱和告警门槛：返回 501 只证明实际积压至少
// 达到 501，同时避免观测查询在事故积压上做无界精确计数。
// English: RecoverySnapshotBacklogLimit is the saturation alarm threshold: returning 501 only proves that the
// actual backlog reaches at least 501, and avoids observation queries from making unbounded accurate counts on the
// accident backlog.
const RecoverySnapshotBacklogLimit int64 = 501

type RecoverySnapshot struct {
	Backlog      int64
	OldestDueAge time.Duration
	ObservedAt   time.Time
}
