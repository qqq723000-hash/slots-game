// application 包将与传输层无关的 RGS 领域能力组合为生产用例。
package application

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"net/url"
	"regexp"
	"strings"
	"time"

	"slots-game/server/internal/game"
	"slots-game/server/internal/launch"
	"slots-game/server/internal/operator"
	"slots-game/server/internal/rgs"
	"slots-game/server/internal/rgsapi"
)

var launchIdempotencyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

type LaunchManagerConfig struct {
	PublicBaseURL     string
	LaunchHMACKey     []byte
	AccessTokenTTL    time.Duration
	IdleDisconnectMin time.Duration
	IdleDisconnectMax time.Duration
	GameID            string
	DefinitionVersion string
	DefinitionHash    string
	Now               func() time.Time
}

type LaunchManager struct {
	repository        rgs.Repository
	launches          *launch.Service
	issuers           map[string]*operator.AccessTokenIssuer
	exchangeURL       string
	hmacKey           []byte
	accessTTL         time.Duration
	idleDisconnectMin time.Duration
	idleDisconnectMax time.Duration
	gameID            string
	version           string
	hash              string
	now               func() time.Time
}

func NewLaunchManager(
	config LaunchManagerConfig,
	repository rgs.Repository,
	launches *launch.Service,
	issuers map[string]*operator.AccessTokenIssuer,
) (*LaunchManager, error) {
	if repository == nil || launches == nil || len(issuers) == 0 {
		return nil, errors.New("application: launch dependencies are required")
	}
	if len(config.LaunchHMACKey) < 32 || len(config.LaunchHMACKey) > 64 {
		return nil, errors.New("application: launch HMAC key must contain 32 to 64 bytes")
	}
	if config.AccessTokenTTL < time.Second || config.AccessTokenTTL > time.Hour {
		return nil, errors.New("application: invalid access token TTL")
	}
	if config.IdleDisconnectMin == 0 {
		config.IdleDisconnectMin = time.Second
	}
	if config.IdleDisconnectMax == 0 {
		config.IdleDisconnectMax = 24 * time.Hour
	}
	if config.IdleDisconnectMin < time.Second || config.IdleDisconnectMax > 24*time.Hour ||
		config.IdleDisconnectMin > config.IdleDisconnectMax ||
		config.IdleDisconnectMin%time.Second != 0 || config.IdleDisconnectMax%time.Second != 0 {
		return nil, errors.New("application: invalid idle disconnect bounds")
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	identity := rgs.SpinRequest{
		OperatorID: "validation", SessionID: "validation", RoundID: "validation",
		GameID: config.GameID, DefinitionVersion: config.DefinitionVersion,
		DefinitionHash: config.DefinitionHash, Currency: "USD",
		RoundKind: rgs.RoundKindBase, BetMinor: 1, TransportGeneration: 1,
	}
	if err := rgs.ValidateSpinRequest(identity); err != nil {
		return nil, fmt.Errorf("application: invalid approved definition identity: %w", err)
	}
	publicBase, err := url.Parse(config.PublicBaseURL)
	if err != nil || publicBase.Host == "" || publicBase.User != nil ||
		(publicBase.Scheme != "https" && publicBase.Scheme != "http") ||
		(publicBase.Path != "" && publicBase.Path != "/") ||
		publicBase.RawQuery != "" || publicBase.Fragment != "" {
		return nil, errors.New("application: invalid public base URL")
	}
	exchange := *publicBase
	exchange.Path = strings.TrimRight(exchange.Path, "/") + rgsapi.ClientSessionExchangePath
	exchange.RawQuery, exchange.Fragment = "", ""
	copyIssuers := make(map[string]*operator.AccessTokenIssuer, len(issuers))
	for operatorID, issuer := range issuers {
		if issuer == nil {
			return nil, errors.New("application: nil operator access token issuer")
		}
		copyIssuers[operatorID] = issuer
	}
	return &LaunchManager{
		repository: repository, launches: launches, issuers: copyIssuers,
		exchangeURL: exchange.String(), hmacKey: append([]byte(nil), config.LaunchHMACKey...),
		accessTTL: config.AccessTokenTTL, gameID: config.GameID,
		idleDisconnectMin: config.IdleDisconnectMin,
		idleDisconnectMax: config.IdleDisconnectMax,
		version:           config.DefinitionVersion, hash: config.DefinitionHash, now: config.Now,
	}, nil
}

func (m *LaunchManager) CreateLaunch(
	ctx context.Context,
	command rgsapi.LaunchCommand,
) (rgsapi.LaunchResult, error) {
	if !launchIdempotencyPattern.MatchString(command.IdempotencyKey) {
		return rgsapi.LaunchResult{}, rgs.ErrInvalidRequest
	}
	requestFingerprint := launchRequestFingerprint(command)
	claims := launch.Claims{
		OperatorID: command.OperatorID, SessionID: command.SessionID,
		PlayerID: command.PlayerID, WalletSessionID: command.WalletSessionID,
		GameID: command.GameID, DefinitionVersion: command.DefinitionVersion,
		DefinitionHash:     command.DefinitionHash,
		RequestFingerprint: requestFingerprint,
		Currency:           command.Currency, CurrencyExponent: command.CurrencyExponent,
		Jurisdiction:          command.Jurisdiction,
		IdleDisconnectSeconds: int64(command.IdleDisconnect / time.Second),
	}
	code := m.launchCode(command.OperatorID, command.SessionID, command.IdempotencyKey)
	// 相同交接幂等身份的查询重试必须在 durable session 的创建、读取或终态
	// 裁决之前返回已持久化的原始响应。它只重放 handoff 响应；exchange 仍按
	// 当前 durable 状态拒绝，不会创建或复活会话。
	replayed, found, replayErr := m.launches.FindCodeReplay(ctx, claims, code)
	if errors.Is(replayErr, launch.ErrDigestExists) {
		return rgsapi.LaunchResult{}, rgs.ErrIdempotencyConflict
	}
	if errors.Is(replayErr, launch.ErrInvalidInput) {
		return rgsapi.LaunchResult{}, rgs.ErrInvalidRequest
	}
	if replayErr != nil {
		return rgsapi.LaunchResult{}, fmt.Errorf(
			"%w: launch replay persistence failed", rgsapi.ErrUnavailable,
		)
	}
	if found {
		return rgsapi.LaunchResult{
			LaunchCode: replayed.Code, ExchangeURL: m.exchangeURL,
			ExpiresAt: replayed.ExpiresAt, ValidatedAt: replayed.ValidatedAt,
			HistoricalReplay: replayed.HistoricalReplay,
		}, nil
	}
	if command.SessionTTL < time.Minute || command.SessionTTL > 24*time.Hour {
		return rgsapi.LaunchResult{}, rgs.ErrInvalidRequest
	}
	if command.IdleDisconnect < time.Second || command.IdleDisconnect > 24*time.Hour ||
		command.IdleDisconnect%time.Second != 0 {
		return rgsapi.LaunchResult{}, rgs.ErrInvalidRequest
	}
	// 当前定义与 access-token issuer 只约束新的 handoff。已认证请求的 exact
	// replay 必须跨定义/issuer 滚动继续返回原响应，且不会因此恢复兑换能力。
	if command.GameID != m.gameID || command.DefinitionVersion != m.version ||
		command.DefinitionHash != m.hash {
		return rgsapi.LaunchResult{}, rgs.ErrInvalidRequest
	}
	if _, exists := m.issuers[command.OperatorID]; !exists {
		return rgsapi.LaunchResult{}, rgs.ErrInvalidRequest
	}
	if command.IdleDisconnect < m.idleDisconnectMin ||
		command.IdleDisconnect > m.idleDisconnectMax {
		return rgsapi.LaunchResult{}, rgs.ErrInvalidRequest
	}
	now := m.now().UTC()
	session := rgs.Session{
		OperatorID: command.OperatorID, SessionID: command.SessionID,
		PlayerID: command.PlayerID, WalletAccountID: command.WalletAccountID,
		WalletSessionID: command.WalletSessionID, GameID: command.GameID,
		DefinitionVersion: command.DefinitionVersion, DefinitionHash: command.DefinitionHash,
		Currency: command.Currency, CurrencyExponent: command.CurrencyExponent,
		Jurisdiction: command.Jurisdiction, Status: rgs.SessionActive,
		ExpiresAt: now.Add(command.SessionTTL), BalanceMinor: command.BalanceMinor,
		IdleDisconnect:   command.IdleDisconnect,
		IdleDisconnectAt: now.Add(command.IdleDisconnect), TransportGeneration: 1,
		Feature: game.EmptyFeatureState(),
	}
	if session.IdleDisconnectAt.After(session.ExpiresAt) {
		session.IdleDisconnectAt = session.ExpiresAt
	}
	if err := rgs.ValidateSession(session); err != nil {
		return rgsapi.LaunchResult{}, err
	}
	if err := m.repository.CreateSession(ctx, session); err != nil {
		if !errors.Is(err, rgs.ErrSessionExists) {
			return rgsapi.LaunchResult{}, err
		}
		existing, getErr := m.repository.GetSession(ctx, command.OperatorID, command.SessionID)
		if getErr != nil {
			return rgsapi.LaunchResult{}, getErr
		}
		if !sameLaunchIdentity(existing, command) {
			return rgsapi.LaunchResult{}, rgs.ErrIdempotencyConflict
		}
		// GetSession 保留稳定的身份冲突语义；absolute expiry 与终态必须随后在
		// 同一次权威存储观测中裁决。idle 超时仍允许 relaunch，并只在 exchange
		// 阶段通过 ResetSessionTransport 推进浏览器隔离代际。
		if _, authorizeErr := m.repository.AuthorizeSessionRelaunch(
			ctx, command.OperatorID, command.SessionID,
		); authorizeErr != nil {
			return rgsapi.LaunchResult{}, authorizeErr
		}
		// balanceMinor 与 sessionTTL 仅用于首次创建会话。再次启动时，持久化余额和
		// 绝对过期时间仍是权威值；新的浏览器交接绝不能重置或延长持久会话状态。
		// 预检与 exchange 都不使用 Pod 时钟；最终 ResetSessionTransport 仍在
		// 兑换时原子重检，覆盖签发交接码后才跨越 absolute expiry 的竞态。
	}
	issued, err := m.launches.IssueCode(ctx, claims, code)
	if errors.Is(err, launch.ErrDigestExists) {
		return rgsapi.LaunchResult{}, rgs.ErrIdempotencyConflict
	}
	if err != nil {
		return rgsapi.LaunchResult{}, fmt.Errorf("%w: launch persistence failed", rgsapi.ErrUnavailable)
	}
	return rgsapi.LaunchResult{
		LaunchCode: issued.Code, ExchangeURL: m.exchangeURL, ExpiresAt: issued.ExpiresAt,
		ValidatedAt: issued.ValidatedAt, HistoricalReplay: issued.HistoricalReplay,
	}, nil
}

func (m *LaunchManager) ExchangeSession(
	ctx context.Context,
	command rgsapi.ExchangeCommand,
) (rgsapi.ExchangeResult, error) {
	claims, err := m.launches.Consume(ctx, command.LaunchCode, launch.Binding{
		OperatorID: command.OperatorID, SessionID: command.SessionID,
	})
	if errors.Is(err, launch.ErrCodeUnavailable) || errors.Is(err, launch.ErrInvalidInput) {
		return rgsapi.ExchangeResult{}, rgsapi.ErrLaunchUnavailable
	}
	if err != nil {
		return rgsapi.ExchangeResult{}, fmt.Errorf("%w: launch exchange failed", rgsapi.ErrUnavailable)
	}
	session, err := m.repository.GetSession(ctx, command.OperatorID, command.SessionID)
	if err != nil {
		return rgsapi.ExchangeResult{}, err
	}
	if session.Status != rgs.SessionActive || !claimsMatchSession(claims, session) {
		return rgsapi.ExchangeResult{}, rgsapi.ErrLaunchUnavailable
	}
	idleDisconnect := time.Duration(claims.IdleDisconnectSeconds) * time.Second
	if idleDisconnect < m.idleDisconnectMin || idleDisconnect > m.idleDisconnectMax {
		return rgsapi.ExchangeResult{}, rgsapi.ErrLaunchUnavailable
	}
	session, err = m.repository.ResetSessionTransport(
		ctx, command.OperatorID, command.SessionID, idleDisconnect,
	)
	if err != nil {
		return rgsapi.ExchangeResult{}, err
	}
	return m.issueSessionToken(session, session.ServerTime)
}

func (m *LaunchManager) RefreshSession(
	ctx context.Context,
	command rgsapi.RefreshCommand,
) (rgsapi.ExchangeResult, error) {
	session, err := m.repository.AuthorizeSessionTransport(
		ctx, command.Claims.OperatorID, command.Claims.SessionID,
		command.Claims.TransportGeneration, false,
	)
	if err != nil {
		return rgsapi.ExchangeResult{}, err
	}
	if session.Status == rgs.SessionBlocked {
		return rgsapi.ExchangeResult{}, rgs.ErrManualReview
	}
	if session.Status != rgs.SessionActive {
		return rgsapi.ExchangeResult{}, rgs.ErrInvalidRequest
	}
	if command.Claims.PlayerID != session.PlayerID ||
		command.Claims.WalletSessionID != session.WalletSessionID ||
		command.Claims.GameID != session.GameID ||
		command.Claims.GameDefinitionVersion != session.DefinitionVersion ||
		command.Claims.GameDefinitionHash != session.DefinitionHash ||
		command.Claims.Currency != session.Currency ||
		command.Claims.CurrencyExponent != session.CurrencyExponent ||
		command.Claims.Jurisdiction != session.Jurisdiction {
		return rgsapi.ExchangeResult{}, rgs.ErrInvalidRequest
	}
	return m.issueSessionToken(session, session.ServerTime)
}

func (m *LaunchManager) AuthorizeSession(
	ctx context.Context,
	command rgsapi.SessionAuthorizationCommand,
) (rgs.Session, error) {
	session, err := m.repository.AuthorizeSessionTransport(
		ctx, command.Claims.OperatorID, command.Claims.SessionID,
		command.Claims.TransportGeneration, command.AllowIdleRecovery,
	)
	if err != nil {
		return rgs.Session{}, err
	}
	if command.Claims.PlayerID != session.PlayerID ||
		command.Claims.WalletSessionID != session.WalletSessionID ||
		command.Claims.GameID != session.GameID ||
		command.Claims.GameDefinitionVersion != session.DefinitionVersion ||
		command.Claims.GameDefinitionHash != session.DefinitionHash ||
		command.Claims.Currency != session.Currency ||
		command.Claims.CurrencyExponent != session.CurrencyExponent ||
		command.Claims.Jurisdiction != session.Jurisdiction {
		return rgs.Session{}, rgs.ErrInvalidRequest
	}
	return session, nil
}

func (m *LaunchManager) issueSessionToken(
	session rgs.Session,
	authoritativeNow time.Time,
) (rgsapi.ExchangeResult, error) {
	issuer := m.issuers[session.OperatorID]
	if issuer == nil {
		return rgsapi.ExchangeResult{}, rgsapi.ErrUnavailable
	}
	lifetime := m.accessTTL
	if authoritativeNow.IsZero() {
		return rgsapi.ExchangeResult{}, rgsapi.ErrUnavailable
	}
	if remaining := session.ExpiresAt.Sub(authoritativeNow); remaining < lifetime {
		lifetime = remaining
	}
	if lifetime < time.Second {
		return rgsapi.ExchangeResult{}, rgs.ErrSessionExpired
	}
	token, _, err := issuer.IssueAt(operator.AccessTokenSubject{
		OperatorID: session.OperatorID, PlayerID: session.PlayerID,
		WalletSessionID: session.WalletSessionID, SessionID: session.SessionID,
		GameID: session.GameID, GameDefinitionVersion: session.DefinitionVersion,
		GameDefinitionHash: session.DefinitionHash, Currency: session.Currency,
		CurrencyExponent: session.CurrencyExponent, Jurisdiction: session.Jurisdiction,
		TransportGeneration: session.TransportGeneration,
	}, lifetime, authoritativeNow)
	if err != nil {
		return rgsapi.ExchangeResult{}, fmt.Errorf("%w: access token issue failed", rgsapi.ErrUnavailable)
	}
	return rgsapi.ExchangeResult{Session: session, AccessToken: token}, nil
}

func (m *LaunchManager) launchCode(operatorID, sessionID, idempotencyKey string) string {
	digest := hmac.New(sha256.New, m.hmacKey)
	// 对首次交接使用 sessionId 作为幂等键的既有集成保留原始派生方式。
	// 不同的已签名幂等键使用 v2，为同一持久会话生成新的伪随机凭据。
	if idempotencyKey == sessionID {
		writeLaunchField(digest, "schema", "rgs-launch-code-v1")
		writeLaunchField(digest, "operator", operatorID)
		writeLaunchField(digest, "session", sessionID)
		return launch.CodePrefix + base64.RawURLEncoding.EncodeToString(digest.Sum(nil))
	}
	writeLaunchField(digest, "schema", "rgs-launch-code-v2")
	writeLaunchField(digest, "operator", operatorID)
	writeLaunchField(digest, "session", sessionID)
	writeLaunchField(digest, "idempotency", idempotencyKey)
	return launch.CodePrefix + base64.RawURLEncoding.EncodeToString(digest.Sum(nil))
}

func launchRequestFingerprint(command rgsapi.LaunchCommand) string {
	digest := sha256.New()
	writeLaunchField(digest, "schema", "rgs-launch-request-v1")
	writeLaunchField(digest, "operator", command.OperatorID)
	writeLaunchField(digest, "idempotency", command.IdempotencyKey)
	writeLaunchField(digest, "player", command.PlayerID)
	writeLaunchField(digest, "walletAccount", command.WalletAccountID)
	writeLaunchField(digest, "walletSession", command.WalletSessionID)
	writeLaunchField(digest, "session", command.SessionID)
	writeLaunchField(digest, "game", command.GameID)
	writeLaunchField(digest, "definitionVersion", command.DefinitionVersion)
	writeLaunchField(digest, "definitionHash", command.DefinitionHash)
	writeLaunchField(digest, "currency", command.Currency)
	writeLaunchField(digest, "currencyExponent", fmt.Sprintf("%d", command.CurrencyExponent))
	writeLaunchField(digest, "jurisdiction", command.Jurisdiction)
	writeLaunchField(digest, "balanceMinor", fmt.Sprintf("%d", command.BalanceMinor))
	writeLaunchField(digest, "sessionTTL", command.SessionTTL.String())
	writeLaunchField(digest, "idleDisconnect", command.IdleDisconnect.String())
	return hex.EncodeToString(digest.Sum(nil))
}

func writeLaunchField(digest hash.Hash, name, value string) {
	var size [8]byte
	binary.BigEndian.PutUint64(size[:], uint64(len(name)))
	_, _ = digest.Write(size[:])
	_, _ = digest.Write([]byte(name))
	binary.BigEndian.PutUint64(size[:], uint64(len(value)))
	_, _ = digest.Write(size[:])
	_, _ = digest.Write([]byte(value))
}

func sameLaunchIdentity(session rgs.Session, command rgsapi.LaunchCommand) bool {
	return session.OperatorID == command.OperatorID &&
		session.SessionID == command.SessionID &&
		session.PlayerID == command.PlayerID &&
		session.WalletAccountID == command.WalletAccountID &&
		session.WalletSessionID == command.WalletSessionID &&
		session.GameID == command.GameID &&
		session.DefinitionVersion == command.DefinitionVersion &&
		session.DefinitionHash == command.DefinitionHash &&
		session.Currency == command.Currency &&
		session.CurrencyExponent == command.CurrencyExponent &&
		session.Jurisdiction == command.Jurisdiction
}

func claimsMatchSession(claims launch.Claims, session rgs.Session) bool {
	return claims.OperatorID == session.OperatorID &&
		claims.SessionID == session.SessionID &&
		claims.PlayerID == session.PlayerID &&
		claims.WalletSessionID == session.WalletSessionID &&
		claims.GameID == session.GameID &&
		claims.DefinitionVersion == session.DefinitionVersion &&
		claims.DefinitionHash == session.DefinitionHash &&
		claims.Currency == session.Currency &&
		claims.CurrencyExponent == session.CurrencyExponent &&
		claims.Jurisdiction == session.Jurisdiction
}

var _ rgsapi.LaunchService = (*LaunchManager)(nil)
