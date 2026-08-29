package rgs

import (
	"fmt"
	"time"
)

// WalletRecoveryAction 是一次钱包恢复外呼的唯一动作。APPLY 只能在持久层先把
// 后续阶段推进到 LOOKUP 后返回，确保进程在资金副作用后崩溃时不会盲目重放写操作。
// English: WalletRecoveryAction is the only action for a wallet recovery outbound call. APPLY can only advance the
// subsequent phase to LOOKUP and then return in the persistence layer to ensure that the write operation will not
// be blindly replayed when the process crashes after side effects.
type WalletRecoveryAction string

const (
	WalletRecoveryApply  WalletRecoveryAction = "APPLY"
	WalletRecoveryLookup WalletRecoveryAction = "LOOKUP"
	// MaxWalletRecoveryClaimBatch 限制单事务持有的钱包轮次锁数量。
	// English: MaxWalletRecoveryClaimBatch limits the number of wallet round locks held by a single transaction.
	MaxWalletRecoveryClaimBatch = 256
)

func (action WalletRecoveryAction) Valid() bool {
	return action == WalletRecoveryApply || action == WalletRecoveryLookup
}

// WalletRecoveryClaim 是带租约 fencing token 的一次执行权。Record 中的计数已经
// 包含本次领取；LeaseUntil 必须原样传回 ScheduleWalletRecovery，旧领取不得覆盖新调度。
// English: WalletRecoveryClaim is a one-time execution right with a lease fencing token. The count in Record
// already includes this collection; LeaseUntil must be returned to ScheduleWalletRecovery as it is, and the old
// collection must not overwrite the new schedule.
type WalletRecoveryClaim struct {
	Record     RoundRecord
	Action     WalletRecoveryAction
	LeaseUntil time.Time
}

// ValidateWalletRecoveryRecord 验证领取外部钱包执行权所依赖的完整持久身份。
// Repository 必须在持有同一 session/round 的写锁后调用它；任何不一致都只能进入
// 完整性隔离，不能把由多份持久数据拼出的猜测命令交给钱包。
// English: ValidateWalletRecoveryRecord Validates the complete persistent identity upon which execution rights for
// external wallets are claimed. Repository must call it after holding the write lock of the same session/round;
// any inconsistency can only enter integrity isolation, and guess commands spelled out from multiple copies of
// persistent data cannot be handed over to the wallet.
func ValidateWalletRecoveryRecord(session Session, record RoundRecord) error {
	if record.Status != RoundPrepared && record.Status != RoundWalletPending {
		return fmt.Errorf("%w: wallet recovery round is not claimable", ErrManualReview)
	}
	if record.Key != record.Request.Key() ||
		session.OperatorID != record.Key.OperatorID ||
		session.SessionID != record.Key.SessionID ||
		session.PlayerID == "" || session.WalletAccountID == "" || session.WalletSessionID == "" ||
		session.GameID != record.Request.GameID ||
		session.DefinitionVersion != record.Request.DefinitionVersion ||
		session.DefinitionHash != record.Request.DefinitionHash ||
		session.Currency != record.Request.Currency ||
		session.PendingRoundID != record.Key.RoundID ||
		session.Revision != record.Request.StartRevision {
		return fmt.Errorf("%w: wallet recovery session binding mismatch", ErrManualReview)
	}
	if validateSpinRequest(record.Request) != nil ||
		record.Fingerprint != FingerprintFor(record.Request) ||
		record.Result.OperatorID != record.Key.OperatorID ||
		record.Result.SessionID != record.Key.SessionID ||
		record.Result.RoundID != record.Key.RoundID ||
		record.Result.GameID != record.Request.GameID ||
		record.Result.DefinitionVersion != record.Request.DefinitionVersion ||
		record.Result.DefinitionHash != record.Request.DefinitionHash ||
		record.Result.RoundKind != record.Request.RoundKind ||
		record.Result.Currency != record.Request.Currency ||
		record.Result.StartRevision != record.Request.StartRevision ||
		record.Result.BetMinor != record.Request.BetMinor ||
		record.Result.ChargedBetMinor < 0 || record.Result.TotalWinMinor < 0 {
		return fmt.Errorf("%w: wallet recovery round binding mismatch", ErrManualReview)
	}
	if record.Request.RoundKind == RoundKindBase &&
		record.Result.ChargedBetMinor != record.Request.BetMinor {
		return fmt.Errorf("%w: wallet recovery debit mismatch", ErrManualReview)
	}
	if record.Request.RoundKind == RoundKindFreeSpin && record.Result.ChargedBetMinor != 0 {
		return fmt.Errorf("%w: wallet recovery Free Spin debit mismatch", ErrManualReview)
	}
	expected := WalletRound{
		OperationID: record.Result.ServerTransactionID, Fingerprint: record.Fingerprint,
		OperatorID: record.Key.OperatorID, PlayerID: session.PlayerID,
		WalletAccountID: session.WalletAccountID, WalletSessionRef: session.WalletSessionID,
		SessionID: record.Key.SessionID, RoundID: record.Key.RoundID,
		GameID: record.Request.GameID, DefinitionVersion: record.Request.DefinitionVersion,
		DefinitionHash: record.Request.DefinitionHash, RoundKind: record.Request.RoundKind,
		Currency: record.Request.Currency, DebitMinor: record.Result.ChargedBetMinor,
		CreditMinor: record.Result.TotalWinMinor,
	}
	expected.CommandDigest = CommandDigestFor(expected)
	if record.WalletCommand != expected || ValidateWalletCommand(record.WalletCommand) != nil ||
		!SupportedSettlementProfile(record.WalletProfile) {
		return fmt.Errorf("%w: wallet recovery command binding mismatch", ErrManualReview)
	}
	actualOutcomeHash, err := PreparedOutcomeHashFor(record.Result)
	if err != nil || actualOutcomeHash != record.OutcomeHash {
		return fmt.Errorf("%w: wallet recovery outcome binding mismatch", ErrManualReview)
	}
	return nil
}

// WalletRecoveryDisposition 只表达业务决策。MinimumDelay 是相对数据库时钟的最小等待，
// NextAttemptAt 仅承载钱包 Retry-After 等显式绝对下界；Worker 另生成 full-jitter。
// 终态不得携带后续动作、延迟或时间。
// English: WalletRecoveryDisposition only expresses business decisions. MinimumDelay is the minimum wait relative
// to the database clock. NextAttemptAt only carries explicit absolute lower bounds such as wallet Retry-After;
// Worker also generates full-jitter. Final states must not carry subsequent actions, delays, or times.
type WalletRecoveryDisposition struct {
	Terminal      bool
	NextAction    WalletRecoveryAction
	MinimumDelay  time.Duration
	NextAttemptAt time.Time
	// ApplyNotSent 只在适配器能够证明 APPLY 未越过外部发送边界时设置。
	// 持久层据此归还领取时预占的资金写预算；进程崩溃或 UNKNOWN 绝不归还。
	// English: ApplyNotSent is only set if the adapter can prove that APPLY did not cross an external send boundary.
	// The persistence layer will return the funds pre-occupied when receiving the budget accordingly; the process will
	// never be returned if the process crashes or UNKNOWN occurs.
	ApplyNotSent bool
}

func ValidateWalletRecoveryDisposition(disposition WalletRecoveryDisposition) error {
	if disposition.Terminal {
		if disposition.NextAction != "" || disposition.MinimumDelay != 0 ||
			!disposition.NextAttemptAt.IsZero() || disposition.ApplyNotSent {
			return ErrInvalidRequest
		}
		return nil
	}
	if !disposition.NextAction.Valid() {
		return ErrInvalidRequest
	}
	if disposition.MinimumDelay < 0 || disposition.MinimumDelay > 24*time.Hour {
		return ErrInvalidRequest
	}
	if disposition.ApplyNotSent && disposition.NextAction != WalletRecoveryApply {
		return ErrInvalidRequest
	}
	return nil
}
