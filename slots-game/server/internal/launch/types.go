package launch

import (
	"crypto/sha256"
	"fmt"
	"regexp"
	"time"
)

const (
	CodePrefix       = "lc_"
	CodeEntropyBytes = 32
	DefaultTTL       = 2 * time.Minute
	MaximumTTL       = 5 * time.Minute
	MinimumTTL       = time.Second
	// IdempotencyRetention 是启动码兑换窗口关闭后的墓碑保留期。该时长超过持久会话的
	// 最大生存期，因此在会话仍可能重新启动期间，确定性交接凭据不会恢复为可用状态。
	IdempotencyRetention = 25 * time.Hour
	codeGenerationTries  = 4
)

var (
	identifierPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	currencyPattern     = regexp.MustCompile(`^[A-Z]{3}$`)
	digestPattern       = regexp.MustCompile(`^[a-f0-9]{64}$`)
	jurisdictionPattern = regexp.MustCompile(`^[A-Z0-9][A-Z0-9-]{1,15}$`)
)

// CodeDigest 是 Store 可见的唯一启动码表示形式。持久化记录绝不包含明文凭据。
type CodeDigest [sha256.Size]byte

// Claims 是成功兑换后复制到短期客户端访问令牌中的不可变启动事实。
type Claims struct {
	OperatorID            string
	SessionID             string
	PlayerID              string
	WalletSessionID       string
	GameID                string
	DefinitionVersion     string
	DefinitionHash        string
	RequestFingerprint    string
	Currency              string
	CurrencyExponent      int
	Jurisdiction          string
	IdleDisconnectSeconds int64
}

// Binding 由兑换端点提供。两个字段都必须匹配创建该启动码的已签名运营商启动请求。
type Binding struct {
	OperatorID string
	SessionID  string
}

// Record 是持久化契约。它刻意不含明文启动码字段；适配器只接收其 SHA-256 摘要。
type Record struct {
	Digest    CodeDigest
	Claims    Claims
	CreatedAt time.Time
	ExpiresAt time.Time
}

// CreateRequest 只携带调用方可决定的启动事实。绝对创建及到期时间必须由 Store 在
// 同一次原子写入中使用其权威时钟生成并返回，不能由 Service 或 Pod 墙钟提供。
type CreateRequest struct {
	Digest CodeDigest
	Claims Claims
	TTL    time.Duration
}

// ConsumeRequest 标识启动码及其必要的租户和会话绑定。Store 实现必须在同一次原子写入中
// 检查全部三个字段。
type ConsumeRequest struct {
	Digest  CodeDigest
	Binding Binding
}

// IssuedCode 只返回给受信启动调用方。Code 必须通过受保护的一次性启动重定向发送给浏览器，
// 并且绝不能写入日志。
type IssuedCode struct {
	Code      string
	ExpiresAt time.Time
	// ValidatedAt 是签发或重放裁决使用的同一权威时间。首次签发来自 Store
	// 原子创建返回的 CreatedAt；持久化重放必须来自 Store 的 ReplayObservation。
	// HTTP 适配器只能用它做结果不变式校验，不能再用 Pod 墙钟替代。
	ValidatedAt      time.Time
	HistoricalReplay bool
}

func validateClaims(claims Claims) error {
	for name, value := range map[string]string{
		"operatorId":        claims.OperatorID,
		"sessionId":         claims.SessionID,
		"playerId":          claims.PlayerID,
		"walletSessionId":   claims.WalletSessionID,
		"gameId":            claims.GameID,
		"definitionVersion": claims.DefinitionVersion,
	} {
		if !identifierPattern.MatchString(value) {
			return fmt.Errorf("%w: invalid %s", ErrInvalidInput, name)
		}
	}
	if !digestPattern.MatchString(claims.DefinitionHash) {
		return fmt.Errorf("%w: invalid definition hash", ErrInvalidInput)
	}
	if !digestPattern.MatchString(claims.RequestFingerprint) {
		return fmt.Errorf("%w: invalid launch request fingerprint", ErrInvalidInput)
	}
	if !currencyPattern.MatchString(claims.Currency) {
		return fmt.Errorf("%w: currency must be a three-letter uppercase code", ErrInvalidInput)
	}
	if claims.CurrencyExponent < 0 || claims.CurrencyExponent > 6 {
		return fmt.Errorf("%w: currency exponent must be in [0,6]", ErrInvalidInput)
	}
	if !jurisdictionPattern.MatchString(claims.Jurisdiction) {
		return fmt.Errorf("%w: invalid jurisdiction", ErrInvalidInput)
	}
	if claims.IdleDisconnectSeconds < 1 || claims.IdleDisconnectSeconds > 86400 {
		return fmt.Errorf("%w: idle disconnect seconds must be in [1,86400]", ErrInvalidInput)
	}
	return nil
}

func validateBinding(binding Binding) error {
	if !identifierPattern.MatchString(binding.OperatorID) || !identifierPattern.MatchString(binding.SessionID) {
		return fmt.Errorf("%w: invalid launch binding", ErrInvalidInput)
	}
	return nil
}

func validateRecord(record Record) error {
	if err := validateClaims(record.Claims); err != nil {
		return err
	}
	if record.CreatedAt.IsZero() || record.ExpiresAt.IsZero() || !record.ExpiresAt.After(record.CreatedAt) {
		return fmt.Errorf("%w: invalid launch validity window", ErrInvalidInput)
	}
	validity := record.ExpiresAt.Sub(record.CreatedAt)
	if validity < MinimumTTL || validity > MaximumTTL {
		return fmt.Errorf("%w: launch validity must be between %s and %s", ErrInvalidInput, MinimumTTL, MaximumTTL)
	}
	return nil
}

func validateCreateRequest(request CreateRequest) error {
	if err := validateClaims(request.Claims); err != nil {
		return err
	}
	if request.TTL < MinimumTTL || request.TTL > MaximumTTL {
		return fmt.Errorf(
			"%w: launch TTL must be between %s and %s",
			ErrInvalidInput, MinimumTTL, MaximumTTL,
		)
	}
	// PostgreSQL timestamptz/interval 持久化精度为微秒；在 Store 边界统一精度，
	// 避免内存与生产适配器返回不同的有效期。
	if request.TTL%time.Microsecond != 0 {
		return fmt.Errorf("%w: launch TTL must use microsecond precision", ErrInvalidInput)
	}
	return nil
}

func idempotencyRetained(record Record, now time.Time) bool {
	return record.ExpiresAt.Add(IdempotencyRetention).After(now)
}

// ValidateClaims 向持久化层及 HTTP 适配器提供固定启动协议校验，避免其重复实现策略。
func ValidateClaims(claims Claims) error {
	return validateClaims(claims)
}

// ValidateRecord 应用 Store 适配器共同使用的持久化不变式。
func ValidateRecord(record Record) error {
	return validateRecord(record)
}

// ValidateCreateRequest 应用 Store 适配器共同使用的创建请求不变式。
func ValidateCreateRequest(request CreateRequest) error {
	return validateCreateRequest(request)
}
