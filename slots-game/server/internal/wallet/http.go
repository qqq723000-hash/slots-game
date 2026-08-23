package wallet

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"slots-game/server/internal/operator"
	"slots-game/server/internal/rgs"
)

const (
	maxWalletResponseBytes int64 = 64 << 10
	maxWalletRootCABytes   int64 = 1 << 20
)

var errWalletResponseAuthentication = errors.New("wallet response authentication failed")

var (
	moneyPattern               = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
	walletCodePattern          = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,127}$`)
	walletIdentifierPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	walletCommandDigestPattern = regexp.MustCompile(`^rgs-wallet-cmd-v1:[a-f0-9]{64}$`)
)

type HTTPConfig struct {
	BaseURL                  string
	OperatorID               string
	RequestSigningKey        operator.SigningKey
	ResponseVerifier         *operator.ResponseVerifier
	Client                   *http.Client
	AllowInsecureDevelopment bool
}

type HTTPWallet struct {
	baseURL   *url.URL
	operator  string
	signing   operator.SigningKey
	responses *operator.ResponseVerifier
	client    *http.Client
}

func NewHTTPWallet(config HTTPConfig) (*HTTPWallet, error) {
	base, err := url.Parse(config.BaseURL)
	if err != nil || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, errors.New("wallet http: base URL must be an absolute URL without credentials, query, or fragment")
	}
	if base.Scheme != "https" && !(config.AllowInsecureDevelopment && base.Scheme == "http") {
		return nil, errors.New("wallet http: TLS is required")
	}
	if config.OperatorID == "" || config.RequestSigningKey.OperatorID != config.OperatorID ||
		config.RequestSigningKey.Purpose != operator.KeyPurposeHTTPRequest ||
		config.ResponseVerifier == nil {
		return nil, errors.New("wallet http: invalid operator signing configuration")
	}
	client := config.Client
	if client == nil {
		client, err = SecureHTTPClient(4*time.Second, "")
		if err != nil {
			return nil, err
		}
	} else {
		clone := *client
		client = &clone
	}
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return errors.New("wallet http: redirects are not allowed")
	}
	if client.Timeout <= 0 {
		client.Timeout = 4 * time.Second
	}
	return &HTTPWallet{
		baseURL: base, operator: config.OperatorID,
		signing: config.RequestSigningKey, responses: config.ResponseVerifier,
		client: client,
	}, nil
}

// SecureHTTPClient 构造钱包专用 TLS 传输。配置独立根 CA 时只在启动阶段读取一次；
// 文件缺失、不是普通文件、超限或不含证书都会拒绝启动，绝不降级跳过验证。
func SecureHTTPClient(timeout time.Duration, rootCAFile string) (*http.Client, error) {
	if timeout <= 0 {
		timeout = 4 * time.Second
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if rootCAFile != "" {
		rootPEM, err := readWalletRootCAFile(rootCAFile)
		if err != nil {
			return nil, fmt.Errorf("wallet http: load root CA: %w", err)
		}
		roots, err := x509.SystemCertPool()
		if err != nil || roots == nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(rootPEM) {
			return nil, errors.New("wallet http: root CA file contains no certificates")
		}
		tlsConfig.RootCAs = roots
	}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:                  http.ProxyFromEnvironment,
			TLSClientConfig:        tlsConfig,
			ForceAttemptHTTP2:      true,
			DisableCompression:     true,
			MaxResponseHeaderBytes: 32 << 10,
			// 钱包故障时慢响应可能长期占用连接；单主机硬上限防止连接数无界增长。
			// 响应头同样必须显式有界，不能沿用 net/http 的 MiB 级默认值放大并发内存。
			MaxConnsPerHost:       32,
			MaxIdleConns:          100,
			MaxIdleConnsPerHost:   20,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   5 * time.Second,
			ResponseHeaderTimeout: timeout,
		},
	}, nil
}

func readWalletRootCAFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("wallet root CA file must be regular")
	}
	contents, err := io.ReadAll(io.LimitReader(file, maxWalletRootCABytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(contents)) > maxWalletRootCABytes {
		return nil, fmt.Errorf("wallet root CA file exceeds %d-byte limit", maxWalletRootCABytes)
	}
	return contents, nil
}

type roundRequest struct {
	OperationID       string        `json:"operationId"`
	Fingerprint       string        `json:"fingerprint"`
	OperatorID        string        `json:"operatorId"`
	PlayerID          string        `json:"playerId"`
	WalletAccountID   string        `json:"walletAccountId"`
	WalletSessionRef  string        `json:"walletSessionRef,omitempty"`
	SessionID         string        `json:"rgsSessionId"`
	RoundID           string        `json:"roundId"`
	GameID            string        `json:"gameId"`
	DefinitionVersion string        `json:"gameDefinitionVersion"`
	DefinitionHash    string        `json:"gameDefinitionHash"`
	RoundKind         rgs.RoundKind `json:"roundKind"`
	Currency          string        `json:"currency"`
	DebitMinor        string        `json:"debitMinor"`
	CreditMinor       string        `json:"creditMinor"`
	CommandDigest     string        `json:"commandDigest,omitempty"`
}

type lookupRequest struct {
	OperatorID    string `json:"operatorId"`
	OperationID   string `json:"operationId"`
	Fingerprint   string `json:"fingerprint,omitempty"`
	CommandDigest string `json:"commandDigest,omitempty"`
}

type rollbackRequest struct {
	OperatorID  string `json:"operatorId"`
	OperationID string `json:"operationId"`
	RollbackID  string `json:"rollbackId"`
	Reason      string `json:"reason"`
}

type walletResponse struct {
	Status        string `json:"status"`
	Code          string `json:"code,omitempty"`
	OperationID   string `json:"operationId,omitempty"`
	Fingerprint   string `json:"fingerprint,omitempty"`
	TransactionID string `json:"transactionId,omitempty"`
	OperatorID    string `json:"operatorId,omitempty"`
	Currency      string `json:"currency,omitempty"`
	DebitMinor    string `json:"debitMinor,omitempty"`
	CreditMinor   string `json:"creditMinor,omitempty"`
	BalanceMinor  string `json:"balanceMinor,omitempty"`
	CommandDigest string `json:"commandDigest,omitempty"`
	RollbackID    string `json:"rollbackId,omitempty"`
}

func (w *HTTPWallet) ProfileFor(operatorID string) (rgs.Profile, error) {
	if w == nil || operatorID != w.operator {
		return rgs.Profile{}, rgs.ErrWalletReceiptInvalid
	}
	canonicalTarget, err := canonicalLedgerTarget(w.baseURL.String())
	if err != nil {
		return rgs.Profile{}, err
	}
	profile := rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
		canonicalTarget,
	))
	if err := rgs.ValidateProfile(profile); err != nil {
		return rgs.Profile{}, err
	}
	return profile, nil
}

// SubmitRound 是 v2 结算入口；它会在发出请求前拒绝损坏的命令绑定，并返回显式供应商终态。
func (w *HTTPWallet) SubmitRound(ctx context.Context, command rgs.WalletRound) rgs.Resolution {
	return w.submitRound(ctx, command, true)
}

func (w *HTTPWallet) ApplyRound(ctx context.Context, command rgs.WalletRound) (rgs.WalletReceipt, error) {
	return legacyApplyResult(w.submitRound(ctx, command, false))
}

func (w *HTTPWallet) submitRound(
	ctx context.Context,
	command rgs.WalletRound,
	requireV2Binding bool,
) rgs.Resolution {
	if command.OperatorID != w.operator {
		return rgs.Resolution{Status: rgs.ResolutionNotSent, Cause: rgs.ErrWalletReceiptInvalid}
	}
	if err := validateCommandBinding(command, requireV2Binding); err != nil {
		return rgs.Resolution{Status: rgs.ResolutionNotSent, Cause: err}
	}
	walletSessionRef, commandDigest := "", ""
	if requireV2Binding {
		// 旧 ApplyRound 兼容面继续发送 v1 JSON；只有显式 v2 SubmitRound 才扩展线协议。
		// 即使走旧面，只要命令已携带绑定字段，上方仍会先完成本地摘要校验。
		walletSessionRef, commandDigest = command.WalletSessionRef, command.CommandDigest
	}
	payload := roundRequest{
		OperationID: command.OperationID, Fingerprint: command.Fingerprint,
		OperatorID: command.OperatorID, PlayerID: command.PlayerID,
		WalletAccountID: command.WalletAccountID, WalletSessionRef: walletSessionRef,
		SessionID: command.SessionID,
		RoundID:   command.RoundID, GameID: command.GameID,
		DefinitionVersion: command.DefinitionVersion, DefinitionHash: command.DefinitionHash,
		RoundKind: command.RoundKind, Currency: command.Currency,
		DebitMinor:    strconv.FormatInt(command.DebitMinor, 10),
		CreditMinor:   strconv.FormatInt(command.CreditMinor, 10),
		CommandDigest: commandDigest,
	}
	exchange := w.do(ctx, "/wallet/v1/rounds/apply", command.OperationID, payload)
	if exchange.Cause != nil {
		return resolutionForExchangeFailure(exchange)
	}
	switch exchange.StatusCode {
	case http.StatusOK:
		if exchange.Response.Status != string(rgs.ResolutionSucceeded) {
			return protocolConflict("wallet http: apply success has invalid status")
		}
		if requireV2Binding && exchange.Response.CommandDigest != command.CommandDigest {
			return protocolConflict("wallet http: apply success has invalid command digest")
		}
		receipt, err := receiptFromResponse(exchange.Response)
		if err != nil || rgs.ValidateWalletReceipt(command, receipt) != nil {
			return protocolConflict("wallet http: apply returned an invalid receipt")
		}
		return rgs.Resolution{Status: rgs.ResolutionSucceeded, Receipt: receipt}
	case http.StatusConflict:
		if exchange.Response.Status != "CONFLICT" {
			return protocolConflict("wallet http: apply conflict has invalid status")
		}
		return rgs.Resolution{
			Status: rgs.ResolutionConflict, Code: boundedCode(exchange.Response.Code),
			Cause: rgs.ErrIdempotencyConflict,
		}
	case http.StatusUnprocessableEntity:
		if !validTerminalRejection(
			exchange.Response, rgs.OperationRefFor(command), requireV2Binding,
		) {
			return protocolConflict("wallet http: apply rejection has invalid identity")
		}
		code := boundedCode(exchange.Response.Code)
		return rgs.Resolution{
			Status: rgs.ResolutionRejectedFinal, Code: code,
			Cause: fmt.Errorf("%w: %s", rgs.ErrWalletRejected, code),
		}
	case http.StatusAccepted:
		if exchange.Response.Status != "PENDING" {
			return protocolConflict("wallet http: apply pending response has invalid status")
		}
		return rgs.Resolution{
			Status: rgs.ResolutionPending, Code: boundedCode(exchange.Response.Code),
			Cause: rgs.ErrWalletPending,
		}
	default:
		return rgs.Resolution{
			Status: rgs.ResolutionUnknown, Code: boundedCode(exchange.Response.Code),
			Cause: fmt.Errorf("wallet http: apply returned authenticated status %d", exchange.StatusCode),
		}
	}
}

// Resolve 查询一个完整持久化操作；命令摘要校验失败时不接受调用方提供的替代身份。
func (w *HTTPWallet) Resolve(ctx context.Context, reference rgs.OperationRef) rgs.Resolution {
	return w.resolve(ctx, reference, true)
}

func (w *HTTPWallet) Lookup(
	ctx context.Context,
	operatorID, operationID string,
) (rgs.WalletReceipt, bool, error) {
	return legacyLookupResult(w.resolve(ctx, rgs.OperationRef{
		OperatorID: operatorID, OperationID: operationID,
	}, false))
}

func (w *HTTPWallet) resolve(
	ctx context.Context,
	reference rgs.OperationRef,
	requireV2Binding bool,
) rgs.Resolution {
	if reference.OperatorID != w.operator {
		return rgs.Resolution{Status: rgs.ResolutionNotSent, Cause: rgs.ErrWalletReceiptInvalid}
	}
	if err := validateCommandBinding(reference.WalletRound(), requireV2Binding); err != nil {
		return rgs.Resolution{Status: rgs.ResolutionNotSent, Cause: err}
	}
	payload := lookupRequest{OperatorID: reference.OperatorID, OperationID: reference.OperationID}
	if requireV2Binding {
		payload.Fingerprint = reference.Fingerprint
		payload.CommandDigest = reference.CommandDigest
	}
	exchange := w.do(ctx, "/wallet/v1/transactions/status", reference.OperationID, payload)
	if exchange.Cause != nil {
		return resolutionForExchangeFailure(exchange)
	}
	switch exchange.StatusCode {
	case http.StatusOK:
		if exchange.Response.Status != string(rgs.ResolutionSucceeded) {
			return protocolConflict("wallet http: lookup success has invalid status")
		}
		if requireV2Binding && exchange.Response.CommandDigest != reference.CommandDigest {
			return protocolConflict("wallet http: lookup success has invalid command digest")
		}
		receipt, err := receiptFromResponse(exchange.Response)
		if err != nil {
			return protocolConflict("wallet http: lookup returned an invalid receipt")
		}
		if requireV2Binding && rgs.ValidateWalletReceipt(reference.WalletRound(), receipt) != nil {
			return protocolConflict("wallet http: lookup receipt does not match operation")
		}
		return rgs.Resolution{Status: rgs.ResolutionSucceeded, Receipt: receipt}
	case http.StatusUnprocessableEntity:
		code := boundedCode(exchange.Response.Code)
		if !validTerminalRejection(exchange.Response, reference, requireV2Binding) {
			return protocolConflict("wallet http: lookup rejection has invalid identity")
		}
		return rgs.Resolution{
			Status: rgs.ResolutionRejectedFinal, Code: code,
			Cause: fmt.Errorf("%w: %s", rgs.ErrWalletRejected, code),
		}
	case http.StatusNotFound:
		if exchange.Response.Status != "NOT_FOUND" ||
			(requireV2Binding && !lookupResponseMatches(exchange.Response, reference)) {
			return protocolConflict("wallet http: lookup not-found response has invalid status")
		}
		return rgs.Resolution{
			Status: rgs.ResolutionNotFound, Code: boundedCode(exchange.Response.Code),
		}
	case http.StatusAccepted:
		if exchange.Response.Status != "PENDING" {
			return protocolConflict("wallet http: lookup pending response has invalid status")
		}
		return rgs.Resolution{
			Status: rgs.ResolutionPending, Code: boundedCode(exchange.Response.Code),
			Cause: rgs.ErrWalletPending,
		}
	case http.StatusConflict:
		// 状态查询冲突表示钱包发现同一资金身份对应不兼容数据，并非暂时或未知结果；
		// 协调器必须阻断会话并转人工复核。
		if exchange.Response.Status != "CONFLICT" {
			return protocolConflict("wallet http: lookup conflict has invalid status")
		}
		return rgs.Resolution{
			Status: rgs.ResolutionConflict, Code: boundedCode(exchange.Response.Code),
			Cause: rgs.ErrIdempotencyConflict,
		}
	default:
		return rgs.Resolution{
			Status: rgs.ResolutionUnknown, Code: boundedCode(exchange.Response.Code),
			Cause: fmt.Errorf("wallet http: lookup returned authenticated status %d", exchange.StatusCode),
		}
	}
}

func lookupResponseMatches(response walletResponse, reference rgs.OperationRef) bool {
	return response.OperatorID == reference.OperatorID &&
		response.OperationID == reference.OperationID &&
		response.Fingerprint == reference.Fingerprint &&
		response.CommandDigest == reference.CommandDigest
}

func (w *HTTPWallet) Rollback(ctx context.Context, rollback rgs.WalletRollback) (rgs.WalletReceipt, error) {
	if rollback.OperatorID != w.operator ||
		!walletIdentifierPattern.MatchString(rollback.OperationID) ||
		!walletIdentifierPattern.MatchString(rollback.RollbackID) ||
		rollback.Reason == "" || len(rollback.Reason) > 512 {
		return rgs.WalletReceipt{}, rgs.ErrWalletReceiptInvalid
	}
	exchange := w.do(ctx, "/wallet/v1/transactions/rollback", rollback.RollbackID, rollbackRequest{
		OperatorID: rollback.OperatorID, OperationID: rollback.OperationID,
		RollbackID: rollback.RollbackID, Reason: rollback.Reason,
	})
	if exchange.Cause != nil {
		return rgs.WalletReceipt{}, exchange.Cause
	}
	switch exchange.StatusCode {
	case http.StatusOK:
		if exchange.Response.Status != "ROLLED_BACK" && exchange.Response.Status != "SUCCEEDED" {
			return rgs.WalletReceipt{}, rgs.ErrWalletReceiptInvalid
		}
		if exchange.Response.OperatorID != rollback.OperatorID ||
			exchange.Response.OperationID != rollback.OperationID ||
			exchange.Response.RollbackID != rollback.RollbackID ||
			(exchange.Response.CommandDigest != "" &&
				!walletCommandDigestPattern.MatchString(exchange.Response.CommandDigest)) {
			return rgs.WalletReceipt{}, rgs.ErrWalletReceiptInvalid
		}
		return receiptFromResponse(exchange.Response)
	case http.StatusConflict:
		return rgs.WalletReceipt{}, rgs.ErrIdempotencyConflict
	case http.StatusUnprocessableEntity:
		return rgs.WalletReceipt{}, fmt.Errorf(
			"%w: %s", rgs.ErrWalletRejected, boundedCode(exchange.Response.Code),
		)
	case http.StatusAccepted:
		return rgs.WalletReceipt{}, rgs.ErrWalletPending
	default:
		return rgs.WalletReceipt{}, fmt.Errorf(
			"wallet http: rollback returned status %d", exchange.StatusCode,
		)
	}
}

type httpExchange struct {
	Response      walletResponse
	StatusCode    int
	Sent          bool
	Authenticated bool
	Cause         error
}

func (w *HTTPWallet) do(
	ctx context.Context,
	path, idempotencyKey string,
	payload any,
) httpExchange {
	if err := ctx.Err(); err != nil {
		return httpExchange{Cause: fmt.Errorf("wallet http: request not sent: %w", err)}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return httpExchange{Cause: fmt.Errorf("wallet http: encode request: %w", err)}
	}
	endpoint := *w.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + path
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return httpExchange{Cause: fmt.Errorf("wallet http: create request: %w", err)}
	}
	requestID, nonce, err := newCorrelation()
	if err != nil {
		return httpExchange{Cause: err}
	}
	now := time.Now().UTC()
	if err := operator.SignRequest(request, body, w.signing, operator.RequestSignatureParams{
		RequestID: requestID, IdempotencyKey: idempotencyKey, Nonce: nonce,
		Created: now, Expires: now.Add(time.Minute),
	}); err != nil {
		return httpExchange{Cause: fmt.Errorf("wallet http: sign request: %w", err)}
	}
	response, err := w.client.Do(request)
	if err != nil {
		// 传输故障后的资金结果不确定；协调器必须使用完全相同的操作标识
		// 查询状态，禁止重新创建资金操作。
		return httpExchange{
			Sent: true, Cause: fmt.Errorf("wallet http: transport outcome unknown: %w", err),
		}
	}
	defer response.Body.Close()
	exchange := httpExchange{StatusCode: response.StatusCode, Sent: true}
	limited := io.LimitReader(response.Body, maxWalletResponseBytes+1)
	responseBody, err := io.ReadAll(limited)
	if err != nil {
		exchange.Cause = fmt.Errorf("wallet http: unauthenticated response read failed: %w", err)
		return exchange
	}
	if int64(len(responseBody)) > maxWalletResponseBytes {
		exchange.Cause = errors.New("wallet http: unauthenticated response exceeds size limit")
		return exchange
	}
	if err := w.responses.Verify(ctx, response, responseBody, w.operator, requestID); err != nil {
		exchange.Cause = fmt.Errorf("%w: %v", errWalletResponseAuthentication, err)
		return exchange
	}
	exchange.Authenticated = true
	var decoded walletResponse
	if err := decodeStrictObject(responseBody, &decoded); err != nil {
		exchange.Cause = fmt.Errorf(
			"%w: %v", rgs.ErrWalletReceiptInvalid, err,
		)
		return exchange
	}
	exchange.Response = decoded
	return exchange
}

func validateCommandBinding(command rgs.WalletRound, required bool) error {
	if !required && command.WalletSessionRef == "" && command.CommandDigest == "" {
		return nil
	}
	return rgs.ValidateWalletCommand(command)
}

func resolutionForExchangeFailure(exchange httpExchange) rgs.Resolution {
	status := rgs.ResolutionNotSent
	if exchange.Sent {
		status = rgs.ResolutionUnknown
	}
	if exchange.Authenticated {
		status = rgs.ResolutionConflict
	}
	return rgs.Resolution{Status: status, Cause: exchange.Cause}
}

func protocolConflict(message string) rgs.Resolution {
	return rgs.Resolution{
		Status: rgs.ResolutionConflict,
		Cause:  fmt.Errorf("%w: %s", rgs.ErrWalletReceiptInvalid, message),
	}
}

func validTerminalRejection(
	response walletResponse,
	reference rgs.OperationRef,
	requireV2Binding bool,
) bool {
	return response.Status == "REJECTED" && walletCodePattern.MatchString(response.Code) &&
		response.OperationID == reference.OperationID &&
		response.OperatorID == reference.OperatorID &&
		(reference.Fingerprint == "" || response.Fingerprint == reference.Fingerprint) &&
		(!requireV2Binding || response.CommandDigest == reference.CommandDigest)
}

func legacyApplyResult(resolution rgs.Resolution) (rgs.WalletReceipt, error) {
	switch resolution.Status {
	case rgs.ResolutionSucceeded:
		return resolution.Receipt, nil
	case rgs.ResolutionRejectedFinal, rgs.ResolutionPending, rgs.ResolutionConflict,
		rgs.ResolutionUnknown, rgs.ResolutionNotSent:
		if resolution.Cause != nil {
			return rgs.WalletReceipt{}, resolution.Cause
		}
	case rgs.ResolutionNotFound:
		return rgs.WalletReceipt{}, rgs.ErrWalletPending
	}
	return rgs.WalletReceipt{}, errors.New("wallet http: invalid apply resolution")
}

func legacyLookupResult(resolution rgs.Resolution) (rgs.WalletReceipt, bool, error) {
	switch resolution.Status {
	case rgs.ResolutionSucceeded:
		return resolution.Receipt, true, nil
	case rgs.ResolutionNotFound:
		return rgs.WalletReceipt{}, false, nil
	case rgs.ResolutionRejectedFinal, rgs.ResolutionPending, rgs.ResolutionConflict,
		rgs.ResolutionUnknown, rgs.ResolutionNotSent:
		if resolution.Cause != nil {
			return rgs.WalletReceipt{}, false, resolution.Cause
		}
	}
	return rgs.WalletReceipt{}, false, errors.New("wallet http: invalid lookup resolution")
}

func receiptFromResponse(response walletResponse) (rgs.WalletReceipt, error) {
	debit, err := parseMoney(response.DebitMinor)
	if err != nil {
		return rgs.WalletReceipt{}, rgs.ErrWalletReceiptInvalid
	}
	credit, err := parseMoney(response.CreditMinor)
	if err != nil {
		return rgs.WalletReceipt{}, rgs.ErrWalletReceiptInvalid
	}
	balance, err := parseMoney(response.BalanceMinor)
	if err != nil || response.OperationID == "" || response.Fingerprint == "" ||
		response.TransactionID == "" || response.OperatorID == "" || response.Currency == "" {
		return rgs.WalletReceipt{}, rgs.ErrWalletReceiptInvalid
	}
	return rgs.WalletReceipt{
		OperationID: response.OperationID, Fingerprint: response.Fingerprint,
		TransactionID: response.TransactionID, OperatorID: response.OperatorID,
		Currency: response.Currency, DebitMinor: debit, CreditMinor: credit,
		BalanceMinor: balance,
	}, nil
}

func parseMoney(value string) (int64, error) {
	if !moneyPattern.MatchString(value) {
		return 0, errors.New("invalid money")
	}
	return strconv.ParseInt(value, 10, 64)
}

func newCorrelation() (string, string, error) {
	var raw [24]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", "", fmt.Errorf("wallet http: generate correlation: %w", err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(raw[:])
	return "wr_" + encoded, encoded, nil
}

func boundedCode(code string) string {
	if len(code) > 128 {
		return code[:128]
	}
	return code
}

func decodeStrictObject(encoded []byte, target any) error {
	shape := json.NewDecoder(bytes.NewReader(encoded))
	first, err := shape.Token()
	if err != nil || first != json.Delim('{') {
		return errors.New("wallet http: response must be a JSON object")
	}
	seen := make(map[string]struct{})
	for shape.More() {
		keyToken, err := shape.Token()
		if err != nil {
			return errors.New("wallet http: invalid response object")
		}
		key, ok := keyToken.(string)
		if !ok {
			return errors.New("wallet http: invalid response field")
		}
		if _, duplicate := seen[key]; duplicate {
			return errors.New("wallet http: duplicate response field")
		}
		seen[key] = struct{}{}
		var value json.RawMessage
		if err := shape.Decode(&value); err != nil {
			return errors.New("wallet http: invalid response field")
		}
	}
	if closing, err := shape.Token(); err != nil || closing != json.Delim('}') {
		return errors.New("wallet http: invalid response object")
	}
	if _, err := shape.Token(); !errors.Is(err, io.EOF) {
		return errors.New("wallet http: response contains trailing data")
	}

	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("wallet http: invalid response: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("wallet http: response contains multiple JSON values")
	}
	return nil
}

var _ rgs.WalletPort = (*HTTPWallet)(nil)
var _ rgs.WalletResolutionPort = (*HTTPWallet)(nil)
