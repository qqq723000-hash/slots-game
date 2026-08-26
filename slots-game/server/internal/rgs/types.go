// rgs 包包含真实货币游戏服务使用的持久轮次协调领域；领域逻辑刻意与具体传输适配器及持久化实现解耦。
package rgs

import (
	"errors"
	"fmt"
	"regexp"
	"time"

	"slots-game/server/internal/game"
)

var (
	ErrInvalidRequest  = errors.New("rgs: invalid request")
	ErrSessionNotFound = errors.New("rgs: session not found")
	ErrSessionExists   = errors.New("rgs: session already exists")
	ErrSessionExpired  = errors.New("rgs: session expired")
	ErrSessionTimeout  = errors.New("rgs: session timed out from inactivity")
	// ErrSessionIntegrity 与 ErrManualReview 分离，避免协调器在隔离损坏会话
	// 时重写仍有经济副作用待决的轮次；HTTP 适配器仍将二者统一暴露为 MANUAL_REVIEW。
	ErrSessionIntegrity             = errors.New("rgs: session integrity validation failed")
	ErrRoundNotFound                = errors.New("rgs: round not found")
	ErrIdempotencyConflict          = errors.New("rgs: idempotency conflict")
	ErrRevisionConflict             = errors.New("rgs: session revision conflict")
	ErrRoundPending                 = errors.New("rgs: another round is pending")
	ErrResultDeliveryPending        = errors.New("rgs: committed result delivery is pending")
	ErrResultDeliveryNotFound       = errors.New("rgs: result delivery not found")
	ErrResultDeliveryMismatch       = errors.New("rgs: result delivery receipt mismatch")
	ErrRoundRejected                = errors.New("rgs: round rejected")
	ErrManualReview                 = errors.New("rgs: round requires manual review")
	ErrRiskPending                  = errors.New("rgs: round requires risk approval")
	ErrRiskDecisionConflict         = errors.New("rgs: risk decision conflicts with existing decision")
	ErrWalletPending                = errors.New("rgs: wallet result is pending")
	ErrWalletRejected               = errors.New("rgs: wallet rejected round")
	ErrWalletReceiptInvalid         = errors.New("rgs: wallet receipt is invalid")
	ErrEconomicRateLimited          = errors.New("rgs: economic intent rate limited")
	ErrEconomicAdmissionUnavailable = errors.New("rgs: economic intent admission unavailable")
	// ErrStaleWalletClaim 表示调用方持有的 wallet_lease_until 已被续租、调度或终态转换取代。
	// 收到此错误后只能读取最新轮次，禁止使用旧钱包结果继续写入。
	ErrStaleWalletClaim = errors.New("rgs: stale wallet claim")
)

// EconomicAdmissionError 将新经济意图准入的 429/503 语义带到 HTTP 边界，
// 不包含运营商、钱包、会话或轮次身份。
type EconomicAdmissionError struct {
	Cause      error
	RetryAfter time.Duration
}

func (err *EconomicAdmissionError) Error() string {
	if errors.Is(err.Cause, ErrEconomicRateLimited) {
		return ErrEconomicRateLimited.Error()
	}
	return ErrEconomicAdmissionUnavailable.Error()
}

func (err *EconomicAdmissionError) Unwrap() error {
	if errors.Is(err.Cause, ErrEconomicRateLimited) {
		return ErrEconomicRateLimited
	}
	return ErrEconomicAdmissionUnavailable
}

const (
	MaxClientSequence uint64 = 9_007_199_254_740_991
	MaxStateRevision  uint64 = 9_223_372_036_854_775_807
)

var (
	identifierPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	currencyPattern     = regexp.MustCompile(`^[A-Z]{3}$`)
	digestPattern       = regexp.MustCompile(`^[a-f0-9]{64}$`)
	jurisdictionPattern = regexp.MustCompile(`^[A-Z0-9][A-Z0-9-]{1,15}$`)
)

type SessionStatus string

const (
	SessionActive  SessionStatus = "ACTIVE"
	SessionBlocked SessionStatus = "BLOCKED"
	SessionClosed  SessionStatus = "CLOSED"
	SessionExpired SessionStatus = "EXPIRED"
)

type RoundKind string

const (
	RoundKindBase     RoundKind = "BASE"
	RoundKindFreeSpin RoundKind = "FREE_SPIN"
	RoundKindBonus    RoundKind = "BONUS"
)

// RoundStatus 在每次外部经济副作用前后都必须持久化；MANUAL_REVIEW 轮次会刻意保持会话阻断。
type RoundStatus string

const (
	RoundPrepared      RoundStatus = "PREPARED"
	RoundRiskPending   RoundStatus = "RISK_PENDING"
	RoundWalletPending RoundStatus = "WALLET_PENDING"
	RoundCommitted     RoundStatus = "COMMITTED"
	RoundRejected      RoundStatus = "REJECTED"
	RoundManualReview  RoundStatus = "MANUAL_REVIEW"
)

// Session 永久绑定一个运营商、钱包主体、币种、游戏及不可变定义版本。
// Revision 是经济/特性状态的乐观并发令牌；Sequence 是客户端可见的已提交结果顺序。
type Session struct {
	OperatorID        string
	SessionID         string
	PlayerID          string
	WalletAccountID   string
	WalletSessionID   string
	GameID            string
	DefinitionVersion string
	DefinitionHash    string
	Currency          string
	CurrencyExponent  int
	Jurisdiction      string
	Status            SessionStatus
	ExpiresAt         time.Time
	// IdleDisconnectAt 是数据库支持的权威截止时间。传输 keepalive、token refresh
	// 与结果恢复都不能推进它；只有成功接受的新经济轮次或 operator relaunch 可以。
	IdleDisconnectAt time.Time
	IdleDisconnect   time.Duration
	// TransportGeneration 隔离每个浏览器 token；relaunch 推进后，旧标签 token 永久失效。
	TransportGeneration uint64
	// ServerTime 是传输生命周期操作返回的瞬时数据库观测值，绝不持久化为经济会话状态。
	ServerTime     time.Time
	BalanceMinor   int64
	Revision       uint64
	Sequence       uint64
	Feature        game.FeatureState
	PendingRoundID string
}

// SpinRequest 包含轮次经济身份的全部字段。调用方提供 StartRevision，防止旧客户端
// 静默使用更新后的特性状态进行求值。
type SpinRequest struct {
	OperatorID          string
	SessionID           string
	RoundID             string
	GameID              string
	DefinitionVersion   string
	DefinitionHash      string
	Currency            string
	RoundKind           RoundKind
	BetMinor            int64
	StartRevision       uint64
	TransportGeneration uint64
}

type RoundKey struct {
	OperatorID string
	SessionID  string
	RoundID    string
}

func (r SpinRequest) Key() RoundKey {
	return RoundKey{OperatorID: r.OperatorID, SessionID: r.SessionID, RoundID: r.RoundID}
}

// SpinResult 是可规范重放的结果模型；BalanceMinor 只能在提交时由已验证钱包回执填入。
type SpinResult struct {
	// ResultSchemaVersion 绑定持久化的经济表示。空值专用于在名义奖励与已支付奖励
	// 拆分前写入的历史结果；所有新准备的结果都必须使用当前模式。
	// omitempty 可保持历史 JSON 和哈希投影完全不变。
	ResultSchemaVersion string `json:",omitempty"`
	OperatorID          string
	SessionID           string
	RoundID             string
	GameID              string
	DefinitionVersion   string
	DefinitionHash      string
	Currency            string
	RoundKind           RoundKind
	ServerTransactionID string
	WalletTransactionID string
	StartRevision       uint64
	EndRevision         uint64
	Sequence            uint64
	BetMinor            int64
	ChargedBetMinor     int64
	BalanceMinor        int64
	TotalWinMinor       int64
	// IdleDisconnectAt 是只在 HTTP 边界填充的传输元数据；排除在规范经济 JSON 之外，
	// 才能保持全部历史 hash 不变。
	IdleDisconnectAt time.Time `json:"-"`
	Grid             game.Grid
	Wins             []game.Win
	Events           []game.Event
	FeatureState     game.FeatureState
}

// ResultDelivery 是等待客户端消费回执的权威已提交结果。回执只证明客户端接受了规范载荷，
// 不证明玩家已经看完表现动画。
type ResultDelivery struct {
	OperatorID string
	SessionID  string
	RoundID    string
	Sequence   uint64
	ResultHash string
	Result     SpinResult
	// OriginFeatureState 是结果对应局次在 RNG 求值前持久化的权威特性状态。
	// 浏览器本地账本丢失后只能使用该字段恢复，禁止从局后结果或当前会话猜测。
	OriginFeatureState game.FeatureState
	AcknowledgedAt     time.Time
}

// ResultDeliveryAcknowledgement 将消费回执绑定到完整已提交结果身份；幂等确认要求全部字段存在。
type ResultDeliveryAcknowledgement struct {
	OperatorID          string
	SessionID           string
	RoundID             string
	Sequence            uint64
	ResultHash          string
	TransportGeneration uint64
}

// RoundRecord 是可恢复聚合；调用 ApplyRound 前必须先写入预备结果与钱包命令。
type RoundRecord struct {
	Key         RoundKey
	Fingerprint string
	Request     SpinRequest
	Status      RoundStatus
	Result      SpinResult
	// InputFeatureState 与预备结果在同一事务中持久化，是恢复展示的局前权威状态。
	InputFeatureState game.FeatureState
	WalletCommand     WalletRound
	// WalletProfile 与预备结果同事务持久化；恢复必须使用该快照，而不是把旧轮次
	// 重新解释为发布后适配器临时报告的新能力。
	WalletProfile        Profile
	WalletReceipt        *WalletReceipt
	OutcomeHash          string
	WalletPhase          WalletRecoveryAction
	NextAttemptAt        time.Time
	WalletApplyAttempts  int
	WalletLookupAttempts int
	WalletLeaseUntil     time.Time
	FailureReason        string
	RetryCount           int
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

func validateSession(session Session) error {
	for name, value := range map[string]string{
		"operatorId":        session.OperatorID,
		"sessionId":         session.SessionID,
		"playerId":          session.PlayerID,
		"walletAccountId":   session.WalletAccountID,
		"walletSessionId":   session.WalletSessionID,
		"gameId":            session.GameID,
		"definitionVersion": session.DefinitionVersion,
	} {
		if !identifierPattern.MatchString(value) {
			return fmt.Errorf("%w: invalid %s", ErrInvalidRequest, name)
		}
	}
	if !digestPattern.MatchString(session.DefinitionHash) {
		return fmt.Errorf("%w: invalid definition hash", ErrInvalidRequest)
	}
	if !currencyPattern.MatchString(session.Currency) {
		return fmt.Errorf("%w: currency must be a three-letter uppercase code", ErrInvalidRequest)
	}
	if session.CurrencyExponent < 0 || session.CurrencyExponent > 6 {
		return fmt.Errorf("%w: currency exponent must be in [0,6]", ErrInvalidRequest)
	}
	if !jurisdictionPattern.MatchString(session.Jurisdiction) {
		return fmt.Errorf("%w: invalid jurisdiction", ErrInvalidRequest)
	}
	if session.Status != SessionActive && session.Status != SessionBlocked && session.Status != SessionClosed && session.Status != SessionExpired {
		return fmt.Errorf("%w: invalid session status", ErrInvalidRequest)
	}
	if session.ExpiresAt.IsZero() {
		return fmt.Errorf("%w: session expiry is required", ErrInvalidRequest)
	}
	if session.IdleDisconnect < time.Second || session.IdleDisconnect > 24*time.Hour ||
		session.IdleDisconnectAt.IsZero() || session.IdleDisconnectAt.After(session.ExpiresAt) ||
		session.TransportGeneration == 0 || session.TransportGeneration > MaxStateRevision {
		return fmt.Errorf("%w: invalid idle-disconnect state", ErrInvalidRequest)
	}
	if session.BalanceMinor < 0 {
		return fmt.Errorf("%w: negative balance", ErrInvalidRequest)
	}
	if session.Sequence > MaxClientSequence || session.Revision > MaxStateRevision {
		return fmt.Errorf("%w: sequence or revision exceeds the persistent protocol limit", ErrInvalidRequest)
	}
	if session.PendingRoundID != "" && !identifierPattern.MatchString(session.PendingRoundID) {
		return fmt.Errorf("%w: invalid pending round id", ErrInvalidRequest)
	}
	if err := validatePersistedFeatureState(session.Feature); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidRequest, err)
	}
	return nil
}

// validatePersistedFeatureState 校验与具体定义无关的不变式。不可变游戏定义会在引擎求值前
// 应用更严格的奖励上限，但畸形或非规范持久化 JSON 绝不能进入引擎。
func validatePersistedFeatureState(state game.FeatureState) error {
	if state.RageLevel < game.DefaultRageLevel || state.RageLevel > game.MaxRageCollected ||
		state.RageCollected < 0 || state.RageCollected > game.MaxRageCollected ||
		(state.RageCollected == 0 && state.RageLevel != game.DefaultRageLevel) {
		return errors.New("Rage meter state is invalid")
	}
	if !state.Active() {
		if state.Mode != "" && state.Mode != game.FeatureNone {
			return errors.New("inactive feature mode is invalid")
		}
		if state.Remaining != 0 || state.Awarded != 0 || state.BetMinor != 0 || state.WinMinor != 0 {
			return errors.New("inactive feature state is not canonical")
		}
		return nil
	}
	if state.Mode != game.FeatureExpansion && state.Mode != game.FeatureOverdrive {
		return errors.New("active feature mode is invalid")
	}
	if state.Remaining < 1 || state.Awarded < state.Remaining ||
		state.Remaining > game.MaxFeatureSpins || state.Awarded > game.MaxFeatureSpins ||
		state.BetMinor <= 0 || state.WinMinor < 0 {
		return errors.New("active feature counters or bet are invalid")
	}
	return nil
}

// ValidateSession 应用所有存储库适配器共享的生产会话不变式。
func ValidateSession(session Session) error {
	return validateSession(session)
}

func validateSpinRequest(request SpinRequest) error {
	for name, value := range map[string]string{
		"operatorId":        request.OperatorID,
		"sessionId":         request.SessionID,
		"roundId":           request.RoundID,
		"gameId":            request.GameID,
		"definitionVersion": request.DefinitionVersion,
	} {
		if !identifierPattern.MatchString(value) {
			return fmt.Errorf("%w: invalid %s", ErrInvalidRequest, name)
		}
	}
	if !digestPattern.MatchString(request.DefinitionHash) {
		return fmt.Errorf("%w: invalid definition hash", ErrInvalidRequest)
	}
	if !currencyPattern.MatchString(request.Currency) {
		return fmt.Errorf("%w: currency must be a three-letter uppercase code", ErrInvalidRequest)
	}
	if request.BetMinor <= 0 {
		return fmt.Errorf("%w: bet must be positive", ErrInvalidRequest)
	}
	if request.StartRevision > MaxStateRevision {
		return fmt.Errorf("%w: starting revision exceeds the persistent protocol limit", ErrInvalidRequest)
	}
	if request.TransportGeneration == 0 || request.TransportGeneration > MaxStateRevision {
		return fmt.Errorf("%w: invalid transport generation", ErrInvalidRequest)
	}
	if request.RoundKind != RoundKindBase && request.RoundKind != RoundKindFreeSpin && request.RoundKind != RoundKindBonus {
		return fmt.Errorf("%w: invalid round kind", ErrInvalidRequest)
	}
	return nil
}

// ValidateSpinRequest 应用规范经济请求不变式。
func ValidateSpinRequest(request SpinRequest) error {
	return validateSpinRequest(request)
}

// ValidateResultDeliveryAcknowledgement 应用传输层与存储库共享的规范交付回执身份不变式。
func ValidateResultDeliveryAcknowledgement(receipt ResultDeliveryAcknowledgement) error {
	if !identifierPattern.MatchString(receipt.OperatorID) ||
		!identifierPattern.MatchString(receipt.SessionID) ||
		!identifierPattern.MatchString(receipt.RoundID) ||
		receipt.Sequence == 0 || receipt.Sequence > MaxClientSequence ||
		receipt.TransportGeneration == 0 || receipt.TransportGeneration > MaxStateRevision ||
		!digestPattern.MatchString(receipt.ResultHash) {
		return fmt.Errorf("%w: invalid result delivery acknowledgement", ErrInvalidRequest)
	}
	return nil
}

// ValidateResultDelivery 校验待交付结果、完整结果哈希与持久化局前状态属于同一局。
// 恢复方不得使用已推进的会话或局后 FeatureState 反推该输入。
func ValidateResultDelivery(delivery ResultDelivery) error {
	result := delivery.Result
	if err := NormalizePersistedSpinResult(&result); err != nil {
		return fmt.Errorf("%w: invalid result schema", ErrInvalidRequest)
	}
	if !identifierPattern.MatchString(delivery.OperatorID) ||
		!identifierPattern.MatchString(delivery.SessionID) ||
		!identifierPattern.MatchString(delivery.RoundID) ||
		delivery.OperatorID != result.OperatorID || delivery.SessionID != result.SessionID ||
		delivery.RoundID != result.RoundID || delivery.Sequence != result.Sequence ||
		delivery.Sequence == 0 || delivery.Sequence > MaxClientSequence ||
		!digestPattern.MatchString(delivery.ResultHash) {
		return fmt.Errorf("%w: invalid result delivery identity", ErrInvalidRequest)
	}
	actualHash, err := CommittedResultHashFor(result)
	if err != nil || actualHash != delivery.ResultHash {
		return fmt.Errorf("%w: invalid result delivery hash", ErrInvalidRequest)
	}
	origin := delivery.OriginFeatureState
	if err := validatePersistedFeatureState(origin); err != nil {
		return fmt.Errorf("%w: invalid result delivery origin", ErrInvalidRequest)
	}
	expectedKind := RoundKindBase
	expectedCharge := result.BetMinor
	if origin.Active() {
		expectedKind = RoundKindFreeSpin
		expectedCharge = 0
		if origin.BetMinor != result.BetMinor {
			return fmt.Errorf("%w: result delivery origin bet mismatch", ErrInvalidRequest)
		}
	}
	if result.RoundKind != expectedKind || result.ChargedBetMinor != expectedCharge ||
		result.StartRevision >= MaxStateRevision || result.EndRevision != result.StartRevision+1 ||
		result.BetMinor <= 0 || result.BalanceMinor < 0 || result.TotalWinMinor < 0 ||
		!identifierPattern.MatchString(result.WalletTransactionID) {
		return fmt.Errorf("%w: invalid committed result delivery", ErrInvalidRequest)
	}
	if err := game.ValidateOutcomeStructure(
		game.SpinInput{BetMinor: result.BetMinor, Feature: origin},
		game.SpinOutcome{
			Grid: result.Grid, Wins: result.Wins, Events: result.Events,
			TotalWinMinor: result.TotalWinMinor, NextFeature: result.FeatureState,
		},
	); err != nil {
		return fmt.Errorf("%w: invalid result delivery outcome", ErrInvalidRequest)
	}
	return nil
}

func validateSessionBinding(session Session, request SpinRequest) error {
	if session.OperatorID != request.OperatorID || session.SessionID != request.SessionID {
		return ErrSessionNotFound
	}
	if session.GameID != request.GameID ||
		session.DefinitionVersion != request.DefinitionVersion ||
		session.DefinitionHash != request.DefinitionHash ||
		session.Currency != request.Currency {
		return fmt.Errorf("%w: request does not match the session definition binding", ErrInvalidRequest)
	}
	if session.Status == SessionBlocked {
		return ErrManualReview
	}
	if session.Status != SessionActive {
		return fmt.Errorf("%w: session is not active", ErrInvalidRequest)
	}
	if !session.ExpiresAt.After(time.Now()) {
		return ErrSessionExpired
	}
	expectedKind := RoundKindBase
	if session.Feature.Active() {
		expectedKind = RoundKindFreeSpin
	}
	if request.RoundKind != expectedKind {
		return fmt.Errorf("%w: round kind does not match feature state", ErrInvalidRequest)
	}
	if session.Revision != request.StartRevision {
		return ErrRevisionConflict
	}
	if session.Sequence >= MaxClientSequence || session.Revision >= MaxStateRevision {
		return fmt.Errorf("%w: session has reached a persistent protocol limit", ErrInvalidRequest)
	}
	return nil
}
