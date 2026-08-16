package wallet

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"slots-game/server/internal/operator"
	"slots-game/server/internal/rgs"
)

const maxWalletResponseBytes int64 = 64 << 10

var moneyPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)

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
		client = SecureHTTPClient(4 * time.Second)
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

func SecureHTTPClient(timeout time.Duration) *http.Client {
	if timeout <= 0 {
		timeout = 4 * time.Second
	}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:                  http.ProxyFromEnvironment,
			TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12},
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
	}
}

type roundRequest struct {
	OperationID       string        `json:"operationId"`
	Fingerprint       string        `json:"fingerprint"`
	OperatorID        string        `json:"operatorId"`
	PlayerID          string        `json:"playerId"`
	WalletAccountID   string        `json:"walletAccountId"`
	SessionID         string        `json:"rgsSessionId"`
	RoundID           string        `json:"roundId"`
	GameID            string        `json:"gameId"`
	DefinitionVersion string        `json:"gameDefinitionVersion"`
	DefinitionHash    string        `json:"gameDefinitionHash"`
	RoundKind         rgs.RoundKind `json:"roundKind"`
	Currency          string        `json:"currency"`
	DebitMinor        string        `json:"debitMinor"`
	CreditMinor       string        `json:"creditMinor"`
}

type lookupRequest struct {
	OperatorID  string `json:"operatorId"`
	OperationID string `json:"operationId"`
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
}

func (w *HTTPWallet) ApplyRound(ctx context.Context, command rgs.WalletRound) (rgs.WalletReceipt, error) {
	if command.OperatorID != w.operator {
		return rgs.WalletReceipt{}, rgs.ErrWalletReceiptInvalid
	}
	payload := roundRequest{
		OperationID: command.OperationID, Fingerprint: command.Fingerprint,
		OperatorID: command.OperatorID, PlayerID: command.PlayerID,
		WalletAccountID: command.WalletAccountID, SessionID: command.SessionID,
		RoundID: command.RoundID, GameID: command.GameID,
		DefinitionVersion: command.DefinitionVersion, DefinitionHash: command.DefinitionHash,
		RoundKind: command.RoundKind, Currency: command.Currency,
		DebitMinor:  strconv.FormatInt(command.DebitMinor, 10),
		CreditMinor: strconv.FormatInt(command.CreditMinor, 10),
	}
	response, status, err := w.do(ctx, "/wallet/v1/rounds/apply", command.OperationID, payload)
	if err != nil {
		return rgs.WalletReceipt{}, err
	}
	switch status {
	case http.StatusOK:
		if response.Status != "SUCCEEDED" {
			return rgs.WalletReceipt{}, rgs.ErrWalletReceiptInvalid
		}
		return receiptFromResponse(response)
	case http.StatusConflict:
		return rgs.WalletReceipt{}, rgs.ErrIdempotencyConflict
	case http.StatusUnprocessableEntity:
		return rgs.WalletReceipt{}, fmt.Errorf("%w: %s", rgs.ErrWalletRejected, boundedCode(response.Code))
	case http.StatusAccepted:
		return rgs.WalletReceipt{}, rgs.ErrWalletPending
	default:
		return rgs.WalletReceipt{}, fmt.Errorf("wallet http: apply returned status %d", status)
	}
}

func (w *HTTPWallet) Lookup(
	ctx context.Context,
	operatorID, operationID string,
) (rgs.WalletReceipt, bool, error) {
	if operatorID != w.operator {
		return rgs.WalletReceipt{}, false, rgs.ErrWalletReceiptInvalid
	}
	response, status, err := w.do(ctx, "/wallet/v1/transactions/status", operationID, lookupRequest{
		OperatorID: operatorID, OperationID: operationID,
	})
	if err != nil {
		return rgs.WalletReceipt{}, false, err
	}
	switch status {
	case http.StatusOK:
		if response.Status != "SUCCEEDED" {
			return rgs.WalletReceipt{}, false, rgs.ErrWalletReceiptInvalid
		}
		receipt, err := receiptFromResponse(response)
		return receipt, err == nil, err
	case http.StatusNotFound:
		return rgs.WalletReceipt{}, false, nil
	case http.StatusAccepted:
		return rgs.WalletReceipt{}, false, rgs.ErrWalletPending
	case http.StatusConflict:
		// 状态查询冲突表示钱包发现同一资金身份对应不兼容数据，并非暂时或未知结果；
		// 协调器必须阻断会话并转人工复核。
		return rgs.WalletReceipt{}, false, rgs.ErrIdempotencyConflict
	default:
		return rgs.WalletReceipt{}, false, fmt.Errorf("wallet http: lookup returned status %d", status)
	}
}

func (w *HTTPWallet) Rollback(ctx context.Context, rollback rgs.WalletRollback) (rgs.WalletReceipt, error) {
	if rollback.OperatorID != w.operator {
		return rgs.WalletReceipt{}, rgs.ErrWalletReceiptInvalid
	}
	response, status, err := w.do(ctx, "/wallet/v1/transactions/rollback", rollback.RollbackID, rollbackRequest{
		OperatorID: rollback.OperatorID, OperationID: rollback.OperationID,
		RollbackID: rollback.RollbackID, Reason: rollback.Reason,
	})
	if err != nil {
		return rgs.WalletReceipt{}, err
	}
	switch status {
	case http.StatusOK:
		if response.Status != "ROLLED_BACK" && response.Status != "SUCCEEDED" {
			return rgs.WalletReceipt{}, rgs.ErrWalletReceiptInvalid
		}
		return receiptFromResponse(response)
	case http.StatusConflict:
		return rgs.WalletReceipt{}, rgs.ErrIdempotencyConflict
	case http.StatusUnprocessableEntity:
		return rgs.WalletReceipt{}, fmt.Errorf("%w: %s", rgs.ErrWalletRejected, boundedCode(response.Code))
	case http.StatusAccepted:
		return rgs.WalletReceipt{}, rgs.ErrWalletPending
	default:
		return rgs.WalletReceipt{}, fmt.Errorf("wallet http: rollback returned status %d", status)
	}
}

func (w *HTTPWallet) do(
	ctx context.Context,
	path, idempotencyKey string,
	payload any,
) (walletResponse, int, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return walletResponse{}, 0, fmt.Errorf("wallet http: encode request: %w", err)
	}
	endpoint := *w.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + path
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return walletResponse{}, 0, fmt.Errorf("wallet http: create request: %w", err)
	}
	requestID, nonce, err := newCorrelation()
	if err != nil {
		return walletResponse{}, 0, err
	}
	now := time.Now().UTC()
	if err := operator.SignRequest(request, body, w.signing, operator.RequestSignatureParams{
		RequestID: requestID, IdempotencyKey: idempotencyKey, Nonce: nonce,
		Created: now, Expires: now.Add(time.Minute),
	}); err != nil {
		return walletResponse{}, 0, fmt.Errorf("wallet http: sign request: %w", err)
	}
	response, err := w.client.Do(request)
	if err != nil {
		// 传输故障后的资金结果不确定；协调器必须使用完全相同的操作标识
		// 查询状态，禁止重新创建资金操作。
		return walletResponse{}, 0, fmt.Errorf("wallet http: transport outcome unknown: %w", err)
	}
	defer response.Body.Close()
	limited := io.LimitReader(response.Body, maxWalletResponseBytes+1)
	responseBody, err := io.ReadAll(limited)
	if err != nil {
		return walletResponse{}, response.StatusCode, fmt.Errorf("wallet http: read response: %w", err)
	}
	if int64(len(responseBody)) > maxWalletResponseBytes {
		return walletResponse{}, response.StatusCode, fmt.Errorf(
			"%w: wallet response exceeds size limit", rgs.ErrWalletReceiptInvalid,
		)
	}
	if err := w.responses.Verify(ctx, response, responseBody, w.operator, requestID); err != nil {
		return walletResponse{}, response.StatusCode, fmt.Errorf(
			"%w: response authentication failed: %v", rgs.ErrWalletReceiptInvalid, err,
		)
	}
	var decoded walletResponse
	if err := decodeStrictObject(responseBody, &decoded); err != nil {
		return walletResponse{}, response.StatusCode, fmt.Errorf(
			"%w: %v", rgs.ErrWalletReceiptInvalid, err,
		)
	}
	return decoded, response.StatusCode, nil
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
