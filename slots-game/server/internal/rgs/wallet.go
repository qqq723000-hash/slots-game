package rgs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const (
	// WalletContractVersionV2 标识第一版显式表达模糊/终态并绑定完整经济命令的钱包契约。
	// English: WalletContractVersionV2 identifies the first version of the wallet contract that explicitly expresses
	// fuzzy/final states and binds complete economic commands.
	WalletContractVersionV2 = "rgs-wallet-contract-v2"
	AtomicHTTPProfileID     = "atomic-http-v2"

	// AtomicHTTPNotFoundConsistencyWindow 是权威查询返回 NOT_FOUND 后，再次提交同一规范
	// 操作前必须等待的最短观察窗口；重提必须继续使用同一 OperationID 与命令摘要。
	// English: AtomicHTTPNotFoundConsistencyWindow is the shortest observation window that must wait before submitting
	// the same specification operation again after the authoritative query returns NOT_FOUND; resubmission must
	// continue to use the same OperationID and command summary.
	AtomicHTTPNotFoundConsistencyWindow = time.Second
	MaximumNotFoundConsistencyWindow    = 24 * time.Hour
	walletRouteBindingPrefix            = "rgs-wallet-route-v1:"
)

var ErrWalletUnavailable = errors.New("rgs: wallet unavailable")

// WalletRound 是一项原子经济指令。生产钱包适配器必须以原子方式应用扣款与入账，
// 并强制执行 OperationID 幂等性：相同操作及指纹返回原始回执，使用不同字段复用则为硬冲突。
// English: WalletRound is an atomic economic instruction. Production wallet adapters must apply debits and credits
// atomically and enforce OperationID idempotence: the same operation and fingerprint return the original receipt,
// and reuse with different fields is a hard conflict.
type WalletRound struct {
	OperationID       string
	Fingerprint       string
	OperatorID        string
	PlayerID          string
	WalletAccountID   string
	WalletSessionRef  string
	SessionID         string
	RoundID           string
	GameID            string
	DefinitionVersion string
	DefinitionHash    string
	RoundKind         RoundKind
	Currency          string
	DebitMinor        int64
	CreditMinor       int64
	CommandDigest     string
}

type WalletReceipt struct {
	OperationID   string
	Fingerprint   string
	TransactionID string
	OperatorID    string
	Currency      string
	DebitMinor    int64
	CreditMinor   int64
	BalanceMinor  int64
}

type WalletRollback struct {
	RollbackID  string
	OperationID string
	OperatorID  string
	Reason      string
}

// ResolutionStatus 分离供应商资金终态与传输结果。UNKNOWN 表示请求可能已到达钱包；
// NOT_SENT 只用于能够证明发生在 HTTP 发出前的故障。
// English: ResolutionStatus separates the final status of supplier funds from the transfer result. UNKNOWN
// indicates that the request may have reached the wallet; NOT_SENT is only used to prove that the failure occurred
// before the HTTP was sent.
type ResolutionStatus string

const (
	ResolutionSucceeded     ResolutionStatus = "SUCCEEDED"
	ResolutionRejectedFinal ResolutionStatus = "REJECTED_FINAL"
	ResolutionPending       ResolutionStatus = "PENDING"
	ResolutionNotFound      ResolutionStatus = "NOT_FOUND"
	ResolutionConflict      ResolutionStatus = "CONFLICT"
	ResolutionUnknown       ResolutionStatus = "UNKNOWN"
	ResolutionNotSent       ResolutionStatus = "NOT_SENT"
)

func (status ResolutionStatus) Valid() bool {
	switch status {
	case ResolutionSucceeded, ResolutionRejectedFinal, ResolutionPending,
		ResolutionNotFound, ResolutionConflict, ResolutionUnknown, ResolutionNotSent:
		return true
	default:
		return false
	}
}

// Resolution 是钱包提交或状态查询的规范结果。Receipt 仅在 SUCCEEDED 时有效；
// Cause 只保留用于诊断及 errors.Is 分类，绝不能用于猜测资金终态。
// English: Resolution is the canonical result of a wallet submission or status query. Receipt is only valid when
// SUCCEEDED; Cause is only reserved for diagnosis and errors.Is classification, and must not be used to guess the
// final state of funds.
type Resolution struct {
	Status  ResolutionStatus
	Receipt WalletReceipt
	Code    string
	Cause   error
}

// Capabilities 是准入时锁定的事实，而非运行时动态协商。恢复协调器仅在能力显式允许，
// 且经过 NotFoundConsistencyWindow 后，才可使用同一规范操作重新提交。
// English: Capabilities are facts locked at admission time, rather than dynamically negotiated at runtime. The
// recovery coordinator can resubmit using the same specification operation only if explicitly allowed by the
// capability and after passing NotFoundConsistencyWindow.
type Capabilities struct {
	AtomicRound                       bool          `json:"atomicRound"`
	LookupByOperation                 bool          `json:"lookupByOperation"`
	ReapplySameOperationAfterNotFound bool          `json:"reapplySameOperationAfterNotFound"`
	NotFoundConsistencyWindow         time.Duration `json:"notFoundConsistencyWindowNanos"`
	ExplicitRollback                  bool          `json:"explicitRollback"`
	RequiresWalletSessionRef          bool          `json:"requiresWalletSessionRef"`
	RequiresCommandDigest             bool          `json:"requiresCommandDigest"`
	ReturnsAuthoritativeBalance       bool          `json:"returnsAuthoritativeBalance"`
}

type Profile struct {
	ContractVersion string       `json:"contractVersion"`
	ProfileID       string       `json:"profileId"`
	RouteBindingID  string       `json:"routeBindingId"`
	Capabilities    Capabilities `json:"capabilities"`
}

// AtomicHTTPProfile 返回 HTTPWallet 实现的显式能力档案。一秒 NOT_FOUND 窗口是下界；
// 恢复策略可以等待更久，但绝不能静默缩短它。
// English: AtomicHTTPProfile Returns the explicit capabilities profile of the HTTPWallet implementation. The
// one-second NOT_FOUND window is a lower bound; recovery strategies can wait longer, but must never silently
// shorten it.
func AtomicHTTPProfile(routeBindingID string) Profile {
	return Profile{
		ContractVersion: WalletContractVersionV2,
		ProfileID:       AtomicHTTPProfileID,
		RouteBindingID:  routeBindingID,
		Capabilities: Capabilities{
			AtomicRound:                       true,
			LookupByOperation:                 true,
			ReapplySameOperationAfterNotFound: true,
			NotFoundConsistencyWindow:         AtomicHTTPNotFoundConsistencyWindow,
			// 自动结算路径未认证独立 rollback saga；该旧接口仅保留给受控人工流程，
			// 不得向协调器宣告为可自动依赖的生产能力。
			// English: The automatic settlement path does not authenticate the independent rollback saga; this legacy
			// interface is reserved for controlled manual processes only and must not be declared to the coordinator as an
			// automatically dependent production capability.
			ExplicitRollback:            false,
			RequiresWalletSessionRef:    true,
			RequiresCommandDigest:       true,
			ReturnsAuthoritativeBalance: true,
		},
	}
}

func ValidateProfile(profile Profile) error {
	capabilities := profile.Capabilities
	if profile.ContractVersion == "" || profile.ProfileID == "" ||
		!strings.HasPrefix(profile.RouteBindingID, walletRouteBindingPrefix) ||
		!digestPattern.MatchString(strings.TrimPrefix(profile.RouteBindingID, walletRouteBindingPrefix)) ||
		capabilities.NotFoundConsistencyWindow < 0 ||
		capabilities.NotFoundConsistencyWindow > MaximumNotFoundConsistencyWindow ||
		(capabilities.ReapplySameOperationAfterNotFound &&
			(!capabilities.LookupByOperation ||
				capabilities.NotFoundConsistencyWindow < AtomicHTTPNotFoundConsistencyWindow)) ||
		(!capabilities.ReapplySameOperationAfterNotFound && capabilities.NotFoundConsistencyWindow != 0) {
		return fmt.Errorf("%w: invalid wallet profile", ErrInvalidRequest)
	}
	return nil
}

// SupportedSettlementProfile 是当前协调器实际认证过的唯一经济语义。不同第三方
// 钱包必须通过适配器收敛到该契约；转账式、拆分式或缺少权威余额的实现不能只靠
// 设置几个布尔值冒充兼容，必须使用独立持久状态机并重新认证。
// English: SupportedSettlementProfile is the only economic semantics that the current coordinator has actually
// certified. Different third-party wallets must converge to this contract through adapters; implementations of
// transfer-type, split-type, or lack of authoritative balances cannot just set a few Boolean values to pretend
// to be compatible, but must use independent persistent state machines and re-authenticate.
func SupportedSettlementProfile(profile Profile) bool {
	capabilities := profile.Capabilities
	return ValidateProfile(profile) == nil &&
		profile.ContractVersion == WalletContractVersionV2 &&
		profile.ProfileID == AtomicHTTPProfileID &&
		capabilities.AtomicRound &&
		capabilities.LookupByOperation &&
		capabilities.ReapplySameOperationAfterNotFound &&
		!capabilities.ExplicitRollback &&
		capabilities.RequiresWalletSessionRef &&
		capabilities.RequiresCommandDigest &&
		capabilities.ReturnsAuthoritativeBalance
}

// WalletRouteBindingIDForCanonicalTarget 只接受适配器已经规范化的非秘密账本目标。
// 摘要用于阻止发布时把待恢复操作静默改投到另一幂等命名空间，不用于认证 URL。
// English: WalletRouteBindingIDForCanonicalTarget only accepts non-secret ledger targets that have been
// canonicalized by the adapter. Digest is used to prevent the pending recovery operation from being silently
// redirected to another idempotent namespace when publishing, and is not used to authenticate URLs.
func WalletRouteBindingIDForCanonicalTarget(target string) string {
	sum := sha256.Sum256([]byte(target))
	return walletRouteBindingPrefix + hex.EncodeToString(sum[:])
}

// OperationRef 包含解析模糊命令所需的完整持久化身份，恢复时无需接受新的客户端字段。
// English: The OperationRef contains the full persisted identity required to parse the obfuscated command without
// accepting new client fields on recovery.
type OperationRef struct {
	OperationID       string
	Fingerprint       string
	OperatorID        string
	PlayerID          string
	WalletAccountID   string
	WalletSessionRef  string
	SessionID         string
	RoundID           string
	GameID            string
	DefinitionVersion string
	DefinitionHash    string
	RoundKind         RoundKind
	Currency          string
	DebitMinor        int64
	CreditMinor       int64
	CommandDigest     string
}

func OperationRefFor(command WalletRound) OperationRef {
	return OperationRef{
		OperationID: command.OperationID, Fingerprint: command.Fingerprint,
		OperatorID: command.OperatorID, PlayerID: command.PlayerID,
		WalletAccountID: command.WalletAccountID, WalletSessionRef: command.WalletSessionRef,
		SessionID: command.SessionID, RoundID: command.RoundID, GameID: command.GameID,
		DefinitionVersion: command.DefinitionVersion, DefinitionHash: command.DefinitionHash,
		RoundKind: command.RoundKind, Currency: command.Currency,
		DebitMinor: command.DebitMinor, CreditMinor: command.CreditMinor,
		CommandDigest: command.CommandDigest,
	}
}

func (reference OperationRef) WalletRound() WalletRound {
	return WalletRound{
		OperationID: reference.OperationID, Fingerprint: reference.Fingerprint,
		OperatorID: reference.OperatorID, PlayerID: reference.PlayerID,
		WalletAccountID: reference.WalletAccountID, WalletSessionRef: reference.WalletSessionRef,
		SessionID: reference.SessionID, RoundID: reference.RoundID, GameID: reference.GameID,
		DefinitionVersion: reference.DefinitionVersion, DefinitionHash: reference.DefinitionHash,
		RoundKind: reference.RoundKind, Currency: reference.Currency,
		DebitMinor: reference.DebitMinor, CreditMinor: reference.CreditMinor,
		CommandDigest: reference.CommandDigest,
	}
}

// CommandDigestFor 绑定全部不可变路由、游戏定义和经济字段；投影刻意排除摘要字段自身。
// English: CommandDigestFor binds all immutable route, game definition, and economy fields; the projection
// intentionally excludes the digest field itself.
func CommandDigestFor(command WalletRound) string {
	digest := sha256.New()
	writeFingerprintField(digest, "schema", "rgs-wallet-command-v1")
	writeFingerprintField(digest, "walletContractVersion", WalletContractVersionV2)
	writeFingerprintField(digest, "walletProfileId", AtomicHTTPProfileID)
	writeFingerprintField(digest, "operationId", command.OperationID)
	writeFingerprintField(digest, "fingerprint", command.Fingerprint)
	writeFingerprintField(digest, "operatorId", command.OperatorID)
	writeFingerprintField(digest, "playerId", command.PlayerID)
	writeFingerprintField(digest, "walletAccountId", command.WalletAccountID)
	writeFingerprintField(digest, "walletSessionRef", command.WalletSessionRef)
	writeFingerprintField(digest, "rgsSessionId", command.SessionID)
	writeFingerprintField(digest, "roundId", command.RoundID)
	writeFingerprintField(digest, "gameId", command.GameID)
	writeFingerprintField(digest, "definitionVersion", command.DefinitionVersion)
	writeFingerprintField(digest, "definitionHash", command.DefinitionHash)
	writeFingerprintField(digest, "roundKind", string(command.RoundKind))
	writeFingerprintField(digest, "currency", command.Currency)
	writeFingerprintField(digest, "debitMinor", strconv.FormatInt(command.DebitMinor, 10))
	writeFingerprintField(digest, "creditMinor", strconv.FormatInt(command.CreditMinor, 10))
	return "rgs-wallet-cmd-v1:" + hex.EncodeToString(digest.Sum(nil))
}

func ValidateWalletCommand(command WalletRound) error {
	for _, value := range []string{
		command.OperationID, command.OperatorID, command.PlayerID, command.WalletAccountID,
		command.WalletSessionRef, command.SessionID, command.RoundID, command.GameID,
		command.DefinitionVersion,
	} {
		if !identifierPattern.MatchString(value) {
			return fmt.Errorf("%w: invalid wallet command identity", ErrInvalidRequest)
		}
	}
	if !strings.HasPrefix(command.Fingerprint, "rgs-fp-v2:") ||
		!digestPattern.MatchString(strings.TrimPrefix(command.Fingerprint, "rgs-fp-v2:")) ||
		!digestPattern.MatchString(command.DefinitionHash) ||
		!currencyPattern.MatchString(command.Currency) ||
		(command.RoundKind != RoundKindBase && command.RoundKind != RoundKindFreeSpin &&
			command.RoundKind != RoundKindBonus) ||
		command.DebitMinor < 0 || command.CreditMinor < 0 ||
		command.CommandDigest == "" ||
		command.CommandDigest != CommandDigestFor(command) {
		return fmt.Errorf("%w: invalid wallet command binding", ErrInvalidRequest)
	}
	return nil
}

// WalletResolutionPort 是版本化适配器 SPI。迁移期间保留下方 WalletPort 作为现有协调器兼容面。
// English: WalletResolutionPort is a versioned adapter SPI. The underlying WalletPort is retained during migration
// as a compatibility surface for existing coordinators.
type WalletResolutionPort interface {
	ProfileFor(string) (Profile, error)
	SubmitRound(context.Context, WalletRound) Resolution
	Resolve(context.Context, OperationRef) Resolution
}

// WalletPort 刻意公开 Lookup。钱包已提交后的传输超时不代表拒绝；协调器会按操作标识解析结果。
// Rollback 本身按 RollbackID 幂等，仅供明确的对账或运维流程使用，绝不能作为超时后的自动响应。
// English: WalletPort deliberately makes its lookup public. A transfer timeout after the wallet has been submitted
// does not represent a rejection; the coordinator will parse the results by operation ID. Rollback itself is
// idempotent according to RollbackID and is only used for clear reconciliation or operation and maintenance
// processes. It must not be used as an automatic response after timeout.
type WalletPort interface {
	ApplyRound(context.Context, WalletRound) (WalletReceipt, error)
	Lookup(context.Context, string, string) (WalletReceipt, bool, error)
	Rollback(context.Context, WalletRollback) (WalletReceipt, error)
}
