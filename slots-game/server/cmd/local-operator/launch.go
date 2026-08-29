package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"slots-game/server/internal/operator"
)

type launchPayload struct {
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

type rgsLaunchEnvelope struct {
	Data struct {
		LaunchCode  string `json:"launchCode"`
		ExchangeURL string `json:"exchangeUrl"`
		ExpiresAt   string `json:"expiresAt"`
	} `json:"data"`
	RequestID string `json:"requestId"`
}

type launchResult struct {
	LaunchCode string    `json:"launchCode"`
	SessionID  string    `json:"sessionId"`
	URL        string    `json:"url"`
	ExpiresAt  time.Time `json:"expiresAt"`
}

type launchClient struct {
	operatorID string
	endpoint   string
	signing    operator.SigningKey
	responses  *operator.ResponseVerifier
	client     *http.Client
	now        func() time.Time
}

func newLaunchClient(
	operatorID, baseURL string,
	signing operator.SigningKey,
	responseKeys []operator.VerificationKey,
	client *http.Client,
) (*launchClient, error) {
	base, err := url.Parse(baseURL)
	if err != nil || base.Scheme != "https" || base.Host == "" || base.User != nil ||
		base.RawQuery != "" || base.Fragment != "" || client == nil ||
		signing.OperatorID != operatorID || signing.Purpose != operator.KeyPurposeHTTPRequest {
		return nil, errors.New("invalid RGS launch client configuration")
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/operator/v1/launches"
	ring, err := operator.NewMemoryKeyRing(responseKeys...)
	if err != nil {
		return nil, err
	}
	responses, err := operator.NewResponseVerifier(ring, operator.RequestVerifierOptions{
		ClockSkew: 30 * time.Second, MaxLifetime: operator.DefaultSignatureLifetime,
	})
	if err != nil {
		return nil, err
	}
	return &launchClient{
		operatorID: operatorID, endpoint: base.String(), signing: signing,
		responses: responses, client: client, now: time.Now,
	}, nil
}

func (c *launchClient) Create(ctx context.Context, payload launchPayload) (rgsLaunchEnvelope, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return rgsLaunchEnvelope{}, errors.New("encode launch request")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return rgsLaunchEnvelope{}, errors.New("create launch request")
	}
	requestID, err := randomID("orq")
	if err != nil {
		return rgsLaunchEnvelope{}, err
	}
	idempotencyKey, err := randomID("launch")
	if err != nil {
		return rgsLaunchEnvelope{}, err
	}
	nonce, err := randomNonce()
	if err != nil {
		return rgsLaunchEnvelope{}, err
	}
	now := c.now().UTC()
	if err := operator.SignRequest(request, body, c.signing, operator.RequestSignatureParams{
		RequestID: requestID, IdempotencyKey: idempotencyKey, Nonce: nonce,
		Created: now, Expires: now.Add(time.Minute),
	}); err != nil {
		return rgsLaunchEnvelope{}, fmt.Errorf("sign RGS launch request: %w", err)
	}
	response, err := c.client.Do(request)
	if err != nil {
		return rgsLaunchEnvelope{}, errors.New("RGS launch transport is unavailable")
	}
	defer response.Body.Close()
	encoded, err := io.ReadAll(io.LimitReader(response.Body, 64<<10+1))
	if err != nil || len(encoded) > 64<<10 {
		return rgsLaunchEnvelope{}, errors.New("RGS launch response exceeds limit")
	}
	if err := c.responses.Verify(ctx, response, encoded, c.operatorID, requestID); err != nil {
		return rgsLaunchEnvelope{}, errors.New("RGS launch response authentication failed")
	}
	if response.StatusCode != http.StatusCreated {
		return rgsLaunchEnvelope{}, fmt.Errorf("RGS launch returned status %d", response.StatusCode)
	}
	var envelope rgsLaunchEnvelope
	if decodeStrictJSON(encoded, &envelope) != nil || envelope.RequestID != requestID ||
		!strings.HasPrefix(envelope.Data.LaunchCode, "lc_") || len(envelope.Data.LaunchCode) != 46 {
		return rgsLaunchEnvelope{}, errors.New("RGS launch response is invalid")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, envelope.Data.ExpiresAt)
	if err != nil || !expiresAt.After(now) {
		return rgsLaunchEnvelope{}, errors.New("RGS launch expiry is invalid")
	}
	return envelope, nil
}

type launcherConfig struct {
	OperatorID             string
	WebBaseURL             string
	GameID                 string
	DefinitionVersion      string
	DefinitionHash         string
	Currency               string
	CurrencyExponent       int
	Jurisdiction           string
	InitialBalanceMinor    int64
	SessionTTL             time.Duration
	IdleDisconnect         time.Duration
	DefaultPlayerID        string
	DefaultWalletAccountID string
	AdminToken             []byte
	Store                  walletStore
	Client                 *launchClient
	Metrics                *serviceMetrics
}

type launcher struct {
	config launcherConfig
}

type launchInput struct {
	PlayerID        string `json:"playerId,omitempty"`
	WalletAccountID string `json:"walletAccountId,omitempty"`
}

func newLauncher(config launcherConfig) (http.Handler, error) {
	if !allIdentifiers(config.OperatorID, config.GameID, config.DefinitionVersion,
		config.DefaultPlayerID, config.DefaultWalletAccountID) ||
		!digestPattern.MatchString(config.DefinitionHash) || len(config.AdminToken) < 16 ||
		config.IdleDisconnect < time.Second || config.IdleDisconnect > 24*time.Hour ||
		config.IdleDisconnect%time.Second != 0 || config.Store == nil || config.Client == nil {
		return nil, errors.New("invalid launcher configuration")
	}
	return &launcher{config: config}, nil
}

func (h *launcher) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	switch {
	case request.Method == http.MethodGet && request.URL.Path == "/":
		h.writeLanding(writer)
	case request.Method == http.MethodPost && request.URL.Path == "/launch":
		h.handleFormLaunch(writer, request)
	case request.Method == http.MethodPost && request.URL.Path == "/api/v1/launches":
		h.handleAPILaunch(writer, request)
	default:
		writer.WriteHeader(http.StatusNotFound)
	}
}

func (h *launcher) handleFormLaunch(writer http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(writer, request.Body, 8<<10)
	if err := request.ParseForm(); err != nil || !tokenMatches(request.Form.Get("accessToken"), h.config.AdminToken) {
		writer.WriteHeader(http.StatusUnauthorized)
		return
	}
	result, err := h.create(request.Context(), launchInput{
		PlayerID: request.Form.Get("playerId"), WalletAccountID: request.Form.Get("walletAccountId"),
	})
	if err != nil {
		h.writeLaunchError(writer)
		return
	}
	writer.Header().Set("Location", result.URL)
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(http.StatusSeeOther)
}

func (h *launcher) handleAPILaunch(writer http.ResponseWriter, request *http.Request) {
	if !bearerMatches(request.Header, h.config.AdminToken) || request.Header.Get("Content-Type") != "application/json" {
		writer.WriteHeader(http.StatusUnauthorized)
		return
	}
	body, err := readBoundedBody(request.Body, 8<<10)
	if err != nil {
		writer.WriteHeader(http.StatusBadRequest)
		return
	}
	var input launchInput
	if decodeStrictJSON(body, &input) != nil {
		writer.WriteHeader(http.StatusBadRequest)
		return
	}
	result, err := h.create(request.Context(), input)
	if err != nil {
		h.writeLaunchError(writer)
		return
	}
	encoded, _ := json.Marshal(result)
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(http.StatusCreated)
	_, _ = writer.Write(encoded)
}

func (h *launcher) create(ctx context.Context, input launchInput) (launchResult, error) {
	playerID := valueOrDefault(input.PlayerID, h.config.DefaultPlayerID)
	walletAccountID := valueOrDefault(input.WalletAccountID, h.config.DefaultWalletAccountID)
	if !allIdentifiers(playerID, walletAccountID) {
		return launchResult{}, errors.New("invalid launch identity")
	}
	if err := h.config.Store.EnsureAccount(ctx, accountSeed{
		OperatorID: h.config.OperatorID, WalletAccountID: walletAccountID,
		Currency: h.config.Currency, BalanceMinor: h.config.InitialBalanceMinor,
	}); err != nil {
		return launchResult{}, err
	}
	now := time.Now().UTC()
	reusable, reused, err := h.config.Store.FindReusableWalletSession(
		ctx, h.config.OperatorID, playerID, walletAccountID, h.config.GameID,
		h.config.DefinitionVersion, h.config.DefinitionHash, h.config.Currency,
	)
	if err != nil {
		return launchResult{}, err
	}
	sessionID, walletSessionID := reusable.SessionID, reusable.WalletSessionRef
	if !reused {
		sessionID, err = randomID("session")
		if err != nil {
			return launchResult{}, err
		}
		walletSessionID, err = randomID("wallet-session")
		if err != nil {
			return launchResult{}, err
		}
	}
	payload := launchPayload{
		PlayerID: playerID, WalletAccountID: walletAccountID, WalletSessionID: walletSessionID,
		SessionID: sessionID, GameID: h.config.GameID,
		DefinitionVersion: h.config.DefinitionVersion, DefinitionHash: h.config.DefinitionHash,
		Currency: h.config.Currency, CurrencyExponent: h.config.CurrencyExponent,
		Jurisdiction:          h.config.Jurisdiction,
		BalanceMinor:          strconv.FormatInt(h.config.InitialBalanceMinor, 10),
		SessionTTLSeconds:     int64(h.config.SessionTTL / time.Second),
		IdleDisconnectSeconds: int64(h.config.IdleDisconnect / time.Second),
	}
	envelope, err := h.config.Client.Create(ctx, payload)
	if err != nil {
		return launchResult{}, err
	}
	// RGS launch 已成功但尚未把代码交给浏览器；此时先持久化 operator 权威的钱包
	// 会话绑定，确保任何随后到达的资金命令都不能伪造或串用 walletSessionRef。
	// English: RGS launch has been successful but the code has not yet been handed to the browser; at this time, the
	// operator's authoritative wallet session binding is persisted to ensure that any subsequently arriving funding
	// commands cannot forge or manipulate the walletSessionRef.
	if !reused {
		err = h.config.Store.RegisterWalletSession(ctx, walletSessionSeed{
			OperatorID: h.config.OperatorID, WalletSessionRef: walletSessionID,
			PlayerID: playerID, WalletAccountID: walletAccountID, SessionID: sessionID,
			GameID: h.config.GameID, DefinitionVersion: h.config.DefinitionVersion,
			DefinitionHash: h.config.DefinitionHash, Currency: h.config.Currency,
			ExpiresAt: now.Add(h.config.SessionTTL),
		})
		if err != nil {
			return launchResult{}, err
		}
	}
	webURL, err := url.Parse(h.config.WebBaseURL)
	if err != nil {
		return launchResult{}, err
	}
	fragment := url.Values{}
	fragment.Set("rgsLaunchCode", envelope.Data.LaunchCode)
	fragment.Set("rgsOperatorId", h.config.OperatorID)
	fragment.Set("rgsSessionId", sessionID)
	webURL.Fragment = fragment.Encode()
	expiresAt, _ := time.Parse(time.RFC3339Nano, envelope.Data.ExpiresAt)
	h.config.Metrics.launches.Add(1)
	return launchResult{
		LaunchCode: envelope.Data.LaunchCode, SessionID: sessionID,
		URL: webURL.String(), ExpiresAt: expiresAt,
	}, nil
}

func (h *launcher) writeLanding(writer http.ResponseWriter) {
	writer.Header().Set("Content-Type", "text/html; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
	writer.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(writer, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>本机集成验收启动器</title><style>body{font:16px system-ui;background:#10131a;color:#eef;max-width:42rem;margin:8vh auto;padding:2rem}form{display:grid;gap:1rem}input,button{font:inherit;padding:.8rem;border-radius:.5rem;border:1px solid #566;background:#181d28;color:#fff}button{background:#335cff;border:0;font-weight:700}</style><h1>本机集成验收启动器</h1><p>输入部署时生成的管理员访问令牌，创建一次性游戏会话。</p><form method="post" action="/launch"><label>访问令牌<input required type="password" name="accessToken" autocomplete="off"></label><label>玩家 ID（可选）<input name="playerId" autocomplete="off"></label><label>钱包账户 ID（可选）<input name="walletAccountId" autocomplete="off"></label><button type="submit">创建并进入游戏</button></form></html>`)
}

func (h *launcher) writeLaunchError(writer http.ResponseWriter) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(http.StatusServiceUnavailable)
	_, _ = writer.Write([]byte(`{"error":{"code":"LAUNCH_UNAVAILABLE","message":"launch service is unavailable"}}`))
}

func randomID(prefix string) (string, error) {
	var raw [24]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate %s ID: %w", prefix, err)
	}
	return prefix + "_" + base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

func randomNonce() (string, error) {
	var raw [24]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate request nonce: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

func tokenMatches(provided string, want []byte) bool {
	providedBytes := []byte(provided)
	return len(providedBytes) == len(want) && subtle.ConstantTimeCompare(providedBytes, want) == 1
}
