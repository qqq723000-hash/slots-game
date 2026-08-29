package outbox

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	httpEnvelopeVersion  = "rgs-outbox-http-v1"
	maxSinkResponseBytes = 4 << 10
	maxBearerTokenBytes  = 4 << 10
	maxTLSMaterialBytes  = 1 << 20

	HeaderEventID           = "X-RGS-Event-Id"
	HeaderSignatureKeyID    = "X-RGS-Key-Id"
	HeaderSignatureTime     = "X-RGS-Signature-Timestamp"
	HeaderEventSignature    = "X-RGS-Signature"
	HeaderContentDigest     = "Content-Digest"
	HeaderIdempotencyKey    = "Idempotency-Key"
	httpEnvelopeContentType = "application/json"
)

// HTTPPublisherConfig 定义供应商无关的 rgs-outbox-http-v1 契约。SigningKey 刻意与
// 运营商及钱包签名材料分离；复用任一密钥都会扩大其信任域并增加轮换复杂度。
// English: HTTPPublisherConfig defines the vendor-independent rgs-outbox-http-v1 contract. SigningKey is
// intentionally separated from operator and wallet signing materials; reusing any key expands its trust domain and
// increases rotation complexity.
type HTTPPublisherConfig struct {
	Endpoint                 string
	KeyID                    string
	SigningKey               []byte
	BearerToken              []byte
	Client                   *http.Client
	AllowInsecureDevelopment bool
	Now                      func() time.Time
}

// HTTPPublisher 发送不可变且经过 HMAC 认证的事件信封。接收端通过任意 2xx 响应确认
// 持久化且幂等接收，并且必须按 HeaderEventID 与 HeaderIdempotencyKey 去重。
// 重定向会被拒绝，防止凭据及签名消息转发到其他信任主体。
// English: HTTPPublisher sends immutable HMAC authenticated event envelopes. The receiving end confirms persistent
// and idempotent reception through any 2xx response, and must deduplicate the HeaderEventID and
// HeaderIdempotencyKey. Redirects are denied, preventing credential and signature messages from being forwarded to
// other trusted principals.
type HTTPPublisher struct {
	endpoint *url.URL
	keyID    string
	client   *http.Client
	now      func() time.Time

	secretsMu sync.RWMutex
	signing   []byte
	bearer    []byte
	closed    bool
}

type httpEnvelope struct {
	SchemaVersion string          `json:"schemaVersion"`
	ID            string          `json:"id"`
	OperatorID    string          `json:"operatorId"`
	AggregateType string          `json:"aggregateType"`
	AggregateID   string          `json:"aggregateId"`
	EventType     string          `json:"eventType"`
	OccurredAt    string          `json:"occurredAt"`
	Payload       json.RawMessage `json:"payload"`
}

func NewHTTPPublisher(config HTTPPublisherConfig) (*HTTPPublisher, error) {
	endpoint, err := url.Parse(config.Endpoint)
	if err != nil || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" ||
		endpoint.Fragment != "" || endpoint.Path == "" {
		return nil, fmt.Errorf("%w: outbox endpoint must be an absolute URL with a path and without credentials, query, or fragment", ErrInvalidInput)
	}
	if endpoint.Scheme != "https" && !(config.AllowInsecureDevelopment && endpoint.Scheme == "http") {
		return nil, fmt.Errorf("%w: outbox endpoint requires TLS", ErrInvalidInput)
	}
	if !validIdentifier(config.KeyID) || len(config.SigningKey) != sha256.Size {
		return nil, fmt.Errorf("%w: an identifier key ID and a 256-bit signing key are required", ErrInvalidInput)
	}
	if len(config.BearerToken) > maxBearerTokenBytes || bytes.ContainsAny(config.BearerToken, " \t\r\n") {
		return nil, fmt.Errorf("%w: invalid bearer token", ErrInvalidInput)
	}
	client := config.Client
	if client == nil {
		client, err = NewSecureHTTPClient(HTTPClientConfig{Timeout: 10 * time.Second})
		if err != nil {
			return nil, err
		}
	} else {
		clone := *client
		client = &clone
	}
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return errors.New("outbox http: redirects are not allowed")
	}
	if client.Timeout <= 0 {
		client.Timeout = 10 * time.Second
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	return &HTTPPublisher{
		endpoint: endpoint, keyID: config.KeyID, client: client, now: now,
		signing: append([]byte(nil), config.SigningKey...),
		bearer:  append([]byte(nil), config.BearerToken...),
	}, nil
}

func (publisher *HTTPPublisher) Publish(ctx context.Context, event Event) error {
	if err := validateHTTPEvent(event); err != nil {
		return err
	}
	publisher.secretsMu.RLock()
	if publisher.closed {
		publisher.secretsMu.RUnlock()
		return errors.New("outbox http: publisher is closed")
	}
	signingKey := append([]byte(nil), publisher.signing...)
	bearerToken := append([]byte(nil), publisher.bearer...)
	publisher.secretsMu.RUnlock()
	defer clear(signingKey)
	defer clear(bearerToken)

	eventID := strconv.FormatInt(event.ID, 10)
	body, err := json.Marshal(httpEnvelope{
		SchemaVersion: httpEnvelopeVersion,
		ID:            eventID,
		OperatorID:    event.OperatorID,
		AggregateType: event.AggregateType,
		AggregateID:   event.AggregateID,
		EventType:     event.EventType,
		OccurredAt:    event.CreatedAt.UTC().Format(time.RFC3339Nano),
		Payload:       event.Payload,
	})
	if err != nil {
		return fmt.Errorf("outbox http: encode envelope: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, publisher.endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("outbox http: create request: %w", err)
	}
	timestamp := strconv.FormatInt(publisher.now().UTC().Unix(), 10)
	digest := contentDigest(body)
	request.Header.Set("Content-Type", httpEnvelopeContentType)
	request.Header.Set(HeaderContentDigest, digest)
	request.Header.Set(HeaderEventID, eventID)
	request.Header.Set(HeaderIdempotencyKey, "outbox-"+eventID)
	request.Header.Set(HeaderSignatureKeyID, publisher.keyID)
	request.Header.Set(HeaderSignatureTime, timestamp)
	request.Header.Set(HeaderEventSignature, signatureHeader(signingKey, canonicalHTTPMessage(
		request, eventID, publisher.keyID, timestamp, digest,
	)))
	if len(bearerToken) > 0 {
		request.Header.Set("Authorization", "Bearer "+string(bearerToken))
	}

	response, err := publisher.client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		// net/http 错误通常包含完整 URL、代理或 TLS 细节，而分发器会记录该错误；
		// 因此只返回稳定分类，禁止把部署内部信息传入日志。
		// English: Net/http errors typically contain full URL, proxy or TLS details and are logged by the dispatcher;
		// therefore only stable classifications are returned and deployment-internal information is not passed into the
		// log.
		return errors.New("outbox http: delivery transport failed")
	}
	defer response.Body.Close()
	_, _ = io.CopyN(io.Discard, response.Body, maxSinkResponseBytes)
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		// 错误中禁止包含响应体或端点；二者都可能携带凭据或下游内部信息并被后续日志记录。
		// Errors must not include the response body or endpoint; either may carry credentials or downstream internals and be logged later.
		return fmt.Errorf("outbox http: sink returned status %d", response.StatusCode)
	}
	return nil
}

// Close 清除从文件加载的应用凭据并关闭空闲连接。该操作幂等；正在进行的 Publish
// 使用私有密钥副本，不会读取已清除的共享切片。
// English: Close Clears application credentials loaded from file and closes idle connections. The operation is
// idempotent; an ongoing Publish uses a copy of the private key and does not read cleared shared slices.
func (publisher *HTTPPublisher) Close() error {
	if publisher == nil {
		return nil
	}
	publisher.secretsMu.Lock()
	if !publisher.closed {
		publisher.closed = true
		clear(publisher.signing)
		clear(publisher.bearer)
		publisher.signing = nil
		publisher.bearer = nil
	}
	publisher.secretsMu.Unlock()
	if closer, ok := publisher.client.Transport.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
	return nil
}

func validateHTTPEvent(event Event) error {
	if event.ID <= 0 || !validIdentifier(event.OperatorID) ||
		!validIdentifier(event.AggregateType) || !validIdentifier(event.AggregateID) ||
		!validIdentifier(event.EventType) || event.CreatedAt.IsZero() || !json.Valid(event.Payload) {
		return fmt.Errorf("%w: invalid event", ErrInvalidInput)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(event.Payload, &object); err != nil || object == nil {
		return fmt.Errorf("%w: event payload must be an object", ErrInvalidInput)
	}
	return nil
}

func contentDigest(body []byte) string {
	digest := sha256.Sum256(body)
	return "sha-256=:" + base64.StdEncoding.EncodeToString(digest[:]) + ":"
}

func canonicalHTTPMessage(
	request *http.Request,
	eventID, keyID, timestamp, digest string,
) string {
	path := request.URL.EscapedPath()
	if path == "" {
		path = "/"
	}
	authority := request.Host
	if authority == "" {
		authority = request.URL.Host
	}
	return strings.Join([]string{
		httpEnvelopeVersion,
		`"@method": ` + request.Method,
		`"@authority": ` + strings.ToLower(authority),
		`"@path": ` + path,
		`"content-digest": ` + digest,
		`"x-rgs-event-id": ` + eventID,
		`"x-rgs-key-id": ` + keyID,
		`"x-rgs-signature-timestamp": ` + timestamp,
	}, "\n")
}

func signatureHeader(key []byte, canonical string) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(canonical))
	return "hmac-sha256=:" + base64.StdEncoding.EncodeToString(mac.Sum(nil)) + ":"
}

type HTTPClientConfig struct {
	Timeout        time.Duration
	RootCAFile     string
	ClientCertFile string
	ClientKeyFile  string
}

// NewSecureHTTPClient 构造审计接收端专用传输。可选 CA 及 mTLS 材料只在启动时读取一次；
// 即使调用方提供自定义客户端，发布器仍会禁用重定向。
// English: NewSecureHTTPClient Constructs an audit receiver-specific transport. Optional CA and mTLS material is
// read only once at startup; the publisher still disables redirection even if the caller provides a custom client.
func NewSecureHTTPClient(config HTTPClientConfig) (*http.Client, error) {
	if config.Timeout <= 0 || config.Timeout > time.Hour {
		return nil, fmt.Errorf("%w: invalid HTTP timeout", ErrInvalidInput)
	}
	if (config.ClientCertFile == "") != (config.ClientKeyFile == "") {
		return nil, fmt.Errorf("%w: client certificate and key must be configured together", ErrInvalidInput)
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if config.RootCAFile != "" {
		rootPEM, err := readLimitedRegularFile(config.RootCAFile, maxTLSMaterialBytes, false)
		if err != nil {
			return nil, fmt.Errorf("outbox http: load root CA: %w", err)
		}
		roots, err := x509.SystemCertPool()
		if err != nil || roots == nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(rootPEM) {
			return nil, errors.New("outbox http: root CA file contains no certificates")
		}
		tlsConfig.RootCAs = roots
	}
	if config.ClientCertFile != "" {
		certificatePEM, err := readLimitedRegularFile(config.ClientCertFile, maxTLSMaterialBytes, false)
		if err != nil {
			return nil, fmt.Errorf("outbox http: load client certificate: %w", err)
		}
		privatePEM, err := readLimitedRegularFile(config.ClientKeyFile, maxTLSMaterialBytes, true)
		if err != nil {
			return nil, fmt.Errorf("outbox http: load client key: %w", err)
		}
		certificate, err := tls.X509KeyPair(certificatePEM, privatePEM)
		clear(privatePEM)
		if err != nil {
			return nil, errors.New("outbox http: invalid client certificate/key pair")
		}
		tlsConfig.Certificates = []tls.Certificate{certificate}
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	return &http.Client{
		Timeout: config.Timeout,
		Transport: &http.Transport{
			Proxy:                  http.ProxyFromEnvironment,
			DialContext:            dialer.DialContext,
			ForceAttemptHTTP2:      true,
			TLSClientConfig:        tlsConfig,
			MaxIdleConns:           100,
			MaxIdleConnsPerHost:    20,
			MaxConnsPerHost:        32,
			IdleConnTimeout:        90 * time.Second,
			TLSHandshakeTimeout:    5 * time.Second,
			ResponseHeaderTimeout:  config.Timeout,
			MaxResponseHeaderBytes: 32 << 10,
			DisableCompression:     true,
		},
	}, nil
}

func LoadHMACKey(path string) ([]byte, error) {
	encoded, err := readLimitedRegularFile(path, 128, true)
	if err != nil {
		return nil, fmt.Errorf("outbox http: load signing key: %w", err)
	}
	defer clear(encoded)
	encoded = bytes.TrimSuffix(encoded, []byte("\n"))
	if bytes.ContainsAny(encoded, " \t\r\n") {
		return nil, errors.New("outbox http: signing key contains whitespace")
	}
	decoded, err := base64.StdEncoding.DecodeString(string(encoded))
	if err != nil || len(decoded) != sha256.Size ||
		base64.StdEncoding.EncodeToString(decoded) != string(encoded) {
		clear(decoded)
		return nil, errors.New("outbox http: signing key must be canonical base64 for exactly 32 bytes")
	}
	return decoded, nil
}

func LoadBearerToken(path string) ([]byte, error) {
	if path == "" {
		return nil, nil
	}
	token, err := readLimitedRegularFile(path, maxBearerTokenBytes, true)
	if err != nil {
		return nil, fmt.Errorf("outbox http: load bearer token: %w", err)
	}
	token = bytes.TrimSuffix(token, []byte("\n"))
	if len(token) < 16 || bytes.ContainsAny(token, " \t\r\n") {
		clear(token)
		return nil, errors.New("outbox http: bearer token must be at least 16 bytes without whitespace")
	}
	return token, nil
}

func readLimitedRegularFile(path string, maximum int64, secret bool) ([]byte, error) {
	if path == "" {
		return nil, errors.New("file path is required")
	}
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
		return nil, errors.New("file must be regular")
	}
	if secret && info.Mode().Perm()&0o137 != 0 {
		return nil, fmt.Errorf("secret file permissions %04o are too broad", info.Mode().Perm())
	}
	contents, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(contents)) > maximum {
		clear(contents)
		return nil, fmt.Errorf("file exceeds %d-byte limit", maximum)
	}
	return contents, nil
}

var _ Publisher = (*HTTPPublisher)(nil)
