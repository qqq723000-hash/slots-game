// rgsapi 包定义生产 RGS 核心的 HTTP 传输契约。
//
// 本包只负责解析、认证、租户及会话绑定和响应形状。启动、轮次与钱包的持久化语义
// 必须留在窄接口之后，禁止运营商特定适配逻辑渗入通用传输层。
package rgsapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"slots-game/server/internal/game"
	"slots-game/server/internal/operator"
	"slots-game/server/internal/rgs"
)

const (
	OperatorLaunchPath        = "/operator/v1/launches"
	OperatorRoundStatusPath   = "/operator/v1/rounds/status"
	OperatorRiskDecisionPath  = "/operator/v1/risk-decisions"
	ClientSessionExchangePath = "/client/v1/sessions/exchange"
	ClientSessionRefreshPath  = "/client/v1/sessions/refresh"
	ClientSessionStatusPath   = "/client/v1/sessions/status"
	ClientSpinPath            = "/client/v1/spins"
	ClientRoundStatusPath     = "/client/v1/rounds/status"
	ClientPendingResultPath   = "/client/v1/results/pending"
	ClientResultAckPath       = "/client/v1/results/acknowledgements"

	DefaultMaxRequestBytes int64 = 8 << 10
)

var (
	// 启动适配器用同一哨兵报告凭据生命周期，HTTP 层无需依赖具体启动码存储。
	// 未知、过期、已消费或绑定不匹配必须全部折叠为该值，避免兑换端点成为枚举判定接口。
	ErrLaunchUnavailable = errors.New("rgsapi: launch credential unavailable")
	ErrUnavailable       = errors.New("rgsapi: dependency unavailable")
)

type OperatorRequestVerifier interface {
	// Authenticate 只验证签名并产出可信身份；HTTP 层据此准入后，必须在业务处理前
	// 调用 ConsumeNonce。这样被限流的合法请求不会写随机数表，已准入请求仍保持防重放。
	Authenticate(context.Context, *http.Request, []byte) (operator.VerifiedRequest, error)
	ConsumeNonce(context.Context, operator.VerifiedRequest) error
}

type AccessTokenVerifier interface {
	Verify(context.Context, string, string) (operator.AccessTokenClaims, error)
}

// ResponseSigningKeyResolver 为已验证或语法有效的声明租户选择 RGS 响应密钥；
// 实现不得在查找失败时回退到其他租户的密钥。
type ResponseSigningKeyResolver interface {
	ResolveResponseSigningKey(context.Context, string) (operator.SigningKey, error)
}

type ResponseSigningKeyResolverFunc func(context.Context, string) (operator.SigningKey, error)

func (f ResponseSigningKeyResolverFunc) ResolveResponseSigningKey(ctx context.Context, operatorID string) (operator.SigningKey, error) {
	return f(ctx, operatorID)
}

// AdmissionDecision 明确区分配额耗尽和共享后端故障，避免把基础设施异常误报为 429。
type AdmissionDecision uint8

const (
	AdmissionAllowed AdmissionDecision = iota + 1
	AdmissionRateLimited
	AdmissionBackendUnavailable
)

type AdmissionResult struct {
	Decision   AdmissionDecision
	RetryAfter time.Duration
}

// Admission 是可选的非阻塞准入控制。生产实现必须限制键数量；需要跨副本限流时，
// 还应由共享设施实施。Admission 用于已验证的运营商签名请求，ClientAdmission
// 则只在访问令牌验证成功后按其不可变会话绑定调用。
type Admission interface {
	Admit(context.Context, string, time.Time) AdmissionResult
}

type AdmissionFunc func(string, time.Time) bool

func (f AdmissionFunc) Admit(_ context.Context, key string, now time.Time) AdmissionResult {
	if f(key, now) {
		return AdmissionResult{Decision: AdmissionAllowed}
	}
	return AdmissionResult{Decision: AdmissionRateLimited, RetryAfter: time.Second}
}

type AdmissionResultFunc func(context.Context, string, time.Time) AdmissionResult

func (f AdmissionResultFunc) Admit(ctx context.Context, key string, now time.Time) AdmissionResult {
	return f(ctx, key, now)
}

// CryptographicCapacity 是验签、令牌验证和运营商响应签名之前的非阻塞 CPU bulkhead。
// 认证前不存在可信恢复身份，所有请求必须使用同一个匿名硬上限；容量耗尽返回 503，
// 不能按攻击者可伪造的 path 分配预留，也不能伪装成调用方超过业务配额的 429。
type CryptographicCapacity interface {
	TryAcquire(context.Context) (release func(), result AdmissionResult)
}

// SecurityEventObserver 只接收已经完成分类的固定安全事件。实现不得附加运营商、
// 密钥、随机数、玩家、会话或请求标识，避免安全日志与监控时序泄漏敏感信息。
type SecurityEventObserver interface {
	NonceReplay()
}

type LaunchService interface {
	// CreateLaunch 必须先持久化创建（或幂等重放）会话，再返回一次性启动码；
	// ExchangeSession 必须原子消费该启动码，之后才能签发访问令牌。
	CreateLaunch(context.Context, LaunchCommand) (LaunchResult, error)
	ExchangeSession(context.Context, ExchangeCommand) (ExchangeResult, error)
	RefreshSession(context.Context, RefreshCommand) (ExchangeResult, error)
	AuthorizeSession(context.Context, SessionAuthorizationCommand) (rgs.Session, error)
}

type SpinCoordinator interface {
	Spin(context.Context, rgs.SpinRequest) (rgs.SpinResult, error)
}

type ResultDeliveryService interface {
	GetPendingResultDelivery(context.Context, string, string) (rgs.ResultDelivery, error)
	AcknowledgeResultDelivery(context.Context, rgs.ResultDeliveryAcknowledgement) (rgs.ResultDelivery, bool, error)
}

// RoundStatusReader 必须是具备隔离能力的状态服务，不能直接暴露原始存储库。
// 处理器不得返回 PREPARED 结果；轮询发现损坏记录时必须持久隔离，禁止认领或调用钱包。
type RoundStatusReader interface {
	GetRound(context.Context, rgs.RoundKey) (rgs.RoundRecord, error)
}

type RiskDecisionService interface {
	DecideRisk(context.Context, rgs.RiskDecisionCommand) (rgs.RiskDecisionResult, error)
}

type Config struct {
	OperatorRequests    OperatorRequestVerifier
	AccessTokens        AccessTokenVerifier
	ResponseSigningKeys ResponseSigningKeyResolver
	Launches            LaunchService
	Spins               SpinCoordinator
	Rounds              RoundStatusReader
	RiskDecisions       RiskDecisionService
	Admission           Admission
	// ClientAdmission 的键只能来自已验证声明，禁止使用请求头、RemoteAddr
	// 或 X-Forwarded-For 构造，避免伪造键和反向代理后的跨玩家误限流。
	ClientAdmission Admission
	// LaunchAdmission 与 SpinAdmission 是按已验证 operator 聚合的跨副本高水位，
	// 防止大量 session 把请求配额乘开。SpinAdmission 覆盖包括重放/冲突在内的全部
	// Spin 尝试；仅首次合法、可持久化 round 的精确经济成本预算在 Coordinator 内
	// 执行。状态查询、待交付结果、确认和令牌续期均不经过这两个新意图高水位。
	LaunchAdmission       Admission
	SpinAdmission         Admission
	CryptographicCapacity CryptographicCapacity
	// NewIntentCapacity 为 session exchange/launch/spin 持有一个进程内硬许可，使
	// 公网新会话/经济意图不能耗尽 PostgreSQL 为 status、pending result、ACK 和
	// refresh 预留的连接预算。
	NewIntentCapacity    NewIntentCapacity
	SecurityEvents       SecurityEventObserver
	MaxRequestBytes      int64
	ResponseSignatureTTL time.Duration
	Now                  func() time.Time
	NewRequestID         func() string
}

type LaunchCommand struct {
	OperatorID        string
	RequestID         string
	IdempotencyKey    string
	PlayerID          string
	WalletAccountID   string
	WalletSessionID   string
	SessionID         string
	GameID            string
	DefinitionVersion string
	DefinitionHash    string
	Currency          string
	CurrencyExponent  int
	Jurisdiction      string
	BalanceMinor      int64
	SessionTTL        time.Duration
	IdleDisconnect    time.Duration
}

// LaunchResult 是运营商启动器交给游戏客户端的短期凭据；消费语义由
// LaunchService 实现，不能由无状态 HTTP 适配器自行推断。
type LaunchResult struct {
	LaunchCode  string
	ExchangeURL string
	ExpiresAt   time.Time
	// ValidatedAt 是 LaunchService 完成签发或重放时间裁决时使用的权威观测，
	// 仅供适配器验证内部结果，不序列化到协议响应。
	ValidatedAt time.Time
	// HistoricalReplay 是适配器内部元数据：只允许在启动幂等保留窗口内精确重放，
	// 不能让新签发凭据继承一个已经过期的兑换窗口。
	HistoricalReplay bool
}

type ExchangeCommand struct {
	LaunchCode string
	OperatorID string
	SessionID  string
	RequestID  string
}

type ExchangeResult struct {
	Session     rgs.Session
	AccessToken string
}

type RefreshCommand struct {
	Claims    operator.AccessTokenClaims
	RequestID string
}

type SessionAuthorizationCommand struct {
	Claims            operator.AccessTokenClaims
	AllowIdleRecovery bool
}

type sessionBindingRequest struct {
	OperatorID        string `json:"operatorId"`
	SessionID         string `json:"sessionId"`
	GameID            string `json:"gameId"`
	DefinitionVersion string `json:"definitionVersion"`
	DefinitionHash    string `json:"definitionHash"`
	Currency          string `json:"currency"`
	CurrencyExponent  int    `json:"currencyExponent"`
	Jurisdiction      string `json:"jurisdiction"`
}

type operatorLaunchRequest struct {
	PlayerID              string `json:"playerId"`
	WalletAccountID       string `json:"walletAccountId"`
	WalletSessionID       string `json:"walletSessionId"`
	SessionID             string `json:"sessionId"`
	GameID                string `json:"gameId"`
	DefinitionVersion     string `json:"definitionVersion"`
	DefinitionHash        string `json:"definitionHash"`
	Currency              string `json:"currency"`
	CurrencyExponent      int    `json:"currencyExponent"`
	Jurisdiction          string `json:"jurisdiction"`
	BalanceMinor          string `json:"balanceMinor"`
	SessionTTLSeconds     int64  `json:"sessionTtlSeconds"`
	IdleDisconnectSeconds int64  `json:"idleDisconnectSeconds"`
}

type clientSessionExchangeRequest struct {
	LaunchCode string `json:"launchCode"`
	OperatorID string `json:"operatorId"`
	SessionID  string `json:"sessionId"`
}

type clientSessionRefreshRequest struct {
	sessionBindingRequest
}

type clientSessionStatusRequest struct {
	sessionBindingRequest
}

type clientSpinRequest struct {
	sessionBindingRequest
	RoundID       string        `json:"roundId"`
	RoundKind     rgs.RoundKind `json:"roundKind"`
	BetMinor      string        `json:"betMinor"`
	StartRevision string        `json:"startRevision"`
}

type roundStatusRequest struct {
	sessionBindingRequest
	RoundID string `json:"roundId"`
}

type resultDeliveryAcknowledgementRequest struct {
	sessionBindingRequest
	RoundID    string `json:"roundId"`
	Sequence   string `json:"sequence"`
	ResultHash string `json:"resultHash"`
}

type successEnvelope struct {
	Data      any    `json:"data"`
	RequestID string `json:"requestId"`
}

type errorEnvelope struct {
	Error     errorBody `json:"error"`
	RequestID string    `json:"requestId"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type launchResponse struct {
	LaunchCode  string `json:"launchCode"`
	ExchangeURL string `json:"exchangeUrl"`
	ExpiresAt   string `json:"expiresAt"`
}

type sessionExchangeResponse struct {
	AccessToken string          `json:"accessToken"`
	Session     sessionResponse `json:"session"`
	ServerTime  string          `json:"serverTime"`
}

type sessionStatusResponse struct {
	OperatorID       string            `json:"operatorId"`
	SessionID        string            `json:"sessionId"`
	Status           rgs.SessionStatus `json:"status"`
	IdleDisconnectAt string            `json:"idleDisconnectAt"`
	ServerTime       string            `json:"serverTime"`
}

type sessionResponse struct {
	OperatorID         string               `json:"operatorId"`
	SessionID          string               `json:"sessionId"`
	GameID             string               `json:"gameId"`
	DefinitionVersion  string               `json:"definitionVersion"`
	DefinitionHash     string               `json:"definitionHash"`
	EngineRulesVersion string               `json:"engineRulesVersion"`
	Currency           string               `json:"currency"`
	CurrencyExponent   int                  `json:"currencyExponent"`
	Jurisdiction       string               `json:"jurisdiction"`
	Status             rgs.SessionStatus    `json:"status"`
	ExpiresAt          string               `json:"expiresAt"`
	IdleDisconnectAt   string               `json:"idleDisconnectAt"`
	BalanceMinor       string               `json:"balanceMinor"`
	Revision           string               `json:"revision"`
	Sequence           string               `json:"sequence"`
	Feature            featureStateResponse `json:"feature"`
}

type roundStatusResponse struct {
	OperatorID string              `json:"operatorId"`
	SessionID  string              `json:"sessionId"`
	RoundID    string              `json:"roundId"`
	Status     rgs.RoundStatus     `json:"status"`
	Result     *spinResultResponse `json:"result,omitempty"`
}

type operatorRiskDecisionRequest struct {
	OperatorID string           `json:"operatorId"`
	SessionID  string           `json:"sessionId"`
	RoundID    string           `json:"roundId"`
	Decision   rgs.RiskDecision `json:"decision"`
	ReasonCode string           `json:"reasonCode"`
}

type operatorRiskDecisionResponse struct {
	OperatorID string           `json:"operatorId"`
	SessionID  string           `json:"sessionId"`
	RoundID    string           `json:"roundId"`
	Decision   rgs.RiskDecision `json:"decision"`
	Status     rgs.RoundStatus  `json:"status"`
	DecidedAt  string           `json:"decidedAt"`
	Replayed   bool             `json:"replayed"`
}

type pendingResultDeliveryResponse struct {
	OperatorID    string               `json:"operatorId"`
	SessionID     string               `json:"sessionId"`
	RoundID       string               `json:"roundId"`
	Sequence      string               `json:"sequence"`
	ResultHash    string               `json:"resultHash"`
	OriginFeature featureStateResponse `json:"originFeature"`
	Result        spinResultResponse   `json:"result"`
}

type resultDeliveryAcknowledgementResponse struct {
	OperatorID     string `json:"operatorId"`
	SessionID      string `json:"sessionId"`
	RoundID        string `json:"roundId"`
	Sequence       string `json:"sequence"`
	ResultHash     string `json:"resultHash"`
	AcknowledgedAt string `json:"acknowledgedAt"`
}

type spinResultResponse struct {
	OperatorID          string               `json:"operatorId"`
	SessionID           string               `json:"sessionId"`
	RoundID             string               `json:"roundId"`
	GameID              string               `json:"gameId"`
	DefinitionVersion   string               `json:"definitionVersion"`
	DefinitionHash      string               `json:"definitionHash"`
	Currency            string               `json:"currency"`
	RoundKind           rgs.RoundKind        `json:"roundKind"`
	ServerTransactionID string               `json:"serverTransactionId"`
	WalletTransactionID string               `json:"walletTransactionId"`
	StartRevision       string               `json:"startRevision"`
	EndRevision         string               `json:"endRevision"`
	Sequence            string               `json:"sequence"`
	ResultHash          string               `json:"resultHash"`
	BetMinor            string               `json:"betMinor"`
	ChargedBetMinor     string               `json:"chargedBetMinor"`
	BalanceMinor        string               `json:"balanceMinor"`
	TotalWinMinor       string               `json:"totalWinMinor"`
	IdleDisconnectAt    string               `json:"idleDisconnectAt,omitempty"`
	Grid                game.Grid            `json:"grid"`
	Wins                []winResponse        `json:"wins"`
	Events              []eventResponse      `json:"events"`
	Feature             featureStateResponse `json:"feature"`
}

type winResponse struct {
	ID                 string              `json:"id"`
	Symbol             game.Symbol         `json:"symbol"`
	Ways               int                 `json:"ways"`
	NominalAmountMinor string              `json:"nominalAmountMinor"`
	AmountMinor        string              `json:"amountMinor"`
	Multiplier         string              `json:"multiplier,omitempty"`
	Cells              []game.Position     `json:"cells"`
	PathAwards         []pathAwardResponse `json:"pathAwards"`
}

type pathAwardResponse struct {
	Cells              []game.Position `json:"cells"`
	Multiplier         string          `json:"multiplier"`
	BaseAmountMinor    string          `json:"baseAmountMinor"`
	NominalAmountMinor string          `json:"nominalAmountMinor"`
	AmountMinor        string          `json:"amountMinor"`
}

type eventResponse struct {
	Type               string           `json:"type"`
	Count              int              `json:"count"`
	Cells              []game.Position  `json:"cells"`
	Triggered          bool             `json:"triggered"`
	Guaranteed         bool             `json:"guaranteed"`
	Outcome            string           `json:"outcome"`
	Prize              string           `json:"prize"`
	Multiplier         string           `json:"multiplier"`
	AmountMinor        string           `json:"amountMinor"`
	CumulativeWinMinor string           `json:"cumulativeWinMinor"`
	Mode               game.FeatureMode `json:"mode"`
	Awarded            int              `json:"awarded"`
	Rows               int              `json:"rows"`
	Ways               int              `json:"ways"`
	Reel               int              `json:"reel"`
	Row                int              `json:"row"`
	Level              int              `json:"level"`
	Total              int              `json:"total"`
	Step               int              `json:"step"`
	FromMultiplier     string           `json:"fromMultiplier"`
	ToMultiplier       string           `json:"toMultiplier"`
}

type featureStateResponse struct {
	Mode          game.FeatureMode `json:"mode"`
	Remaining     int              `json:"remaining"`
	Awarded       int              `json:"awarded"`
	BetMinor      string           `json:"betMinor"`
	WinMinor      string           `json:"winMinor"`
	RageLevel     int              `json:"rageLevel"`
	RageCollected int              `json:"rageCollected"`
}
