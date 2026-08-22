package operator

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	HeaderContentDigest  = "Content-Digest"
	HeaderOperatorID     = "X-Operator-Id"
	HeaderRequestID      = "X-Request-Id"
	HeaderNonce          = "X-Nonce"
	HeaderIdempotencyKey = "Idempotency-Key"
	HeaderSignatureInput = "Signature-Input"
	HeaderSignature      = "Signature"

	SignedContentType          = "application/json"
	DefaultSignatureLifetime   = 5 * time.Minute
	DefaultSignatureClockSkew  = 30 * time.Second
	MaximumSignedRequestBody   = 1 << 20
	fixedSignatureComponentSet = `("@method" "@authority" "@path" "content-digest" "content-type" "x-operator-id" "x-request-id" "x-nonce" "idempotency-key")`
)

var (
	signatureInputPattern = regexp.MustCompile(`^sig1=\("@method" "@authority" "@path" "content-digest" "content-type" "x-operator-id" "x-request-id" "x-nonce" "idempotency-key"\);created=(0|[1-9][0-9]{0,18});expires=(0|[1-9][0-9]{0,18});keyid="([A-Za-z0-9][A-Za-z0-9._:-]{0,127})";alg="ed25519"$`)
	contentDigestPattern  = regexp.MustCompile(`^sha-256=:([A-Za-z0-9+/]+={0,2}):$`)
	signaturePattern      = regexp.MustCompile(`^sig1=:([A-Za-z0-9+/]+={0,2}):$`)
)

type RequestSignatureParams struct {
	RequestID      string
	IdempotencyKey string
	Nonce          string
	Created        time.Time
	Expires        time.Time
}

type VerifiedRequest struct {
	OperatorID     string
	KeyID          string
	RequestID      string
	IdempotencyKey string
	Nonce          string
	Created        time.Time
	Expires        time.Time
	verifiedBy     *RequestVerifier
	binding        verifiedRequestBinding
}

type verifiedRequestBinding struct {
	operatorID     string
	keyID          string
	requestID      string
	idempotencyKey string
	nonce          string
	created        time.Time
	expires        time.Time
}

type RequestVerifierOptions struct {
	Now         func() time.Time
	ClockSkew   time.Duration
	MaxLifetime time.Duration
}

type RequestVerifier struct {
	keys        KeyResolver
	nonces      NonceStore
	now         func() time.Time
	clockSkew   time.Duration
	maxLifetime time.Duration
}

func NewRequestVerifier(keys KeyResolver, nonces NonceStore, options RequestVerifierOptions) (*RequestVerifier, error) {
	if keys == nil || nonces == nil {
		return nil, fmt.Errorf("%w: key resolver and nonce store are required", ErrMalformed)
	}
	if options.ClockSkew < 0 || options.MaxLifetime < 0 {
		return nil, fmt.Errorf("%w: invalid verifier durations", ErrMalformed)
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.MaxLifetime == 0 {
		options.MaxLifetime = DefaultSignatureLifetime
	}
	if options.MaxLifetime < time.Second {
		return nil, fmt.Errorf("%w: max signature lifetime must be at least one second", ErrMalformed)
	}
	return &RequestVerifier{
		keys: keys, nonces: nonces, now: options.Now,
		clockSkew: options.ClockSkew, maxLifetime: options.MaxLifetime,
	}, nil
}

// SignRequest 应用本包固定的 RFC 9421 风格配置，并签署 fixedSignatureComponentSet
// 记录的确切组件集合。查询字符串及其他内容类型刻意不在此配置范围内。
func SignRequest(request *http.Request, body []byte, key SigningKey, params RequestSignatureParams) error {
	if request == nil || len(body) > MaximumSignedRequestBody {
		return fmt.Errorf("%w: invalid signed request", ErrMalformed)
	}
	if err := validateSigningKey(key); err != nil {
		return err
	}
	if key.Purpose != KeyPurposeHTTPRequest {
		return fmt.Errorf("%w: signing key has wrong purpose", ErrMalformed)
	}
	if !validIdentifier(params.RequestID) || !validIdentifier(params.IdempotencyKey) || !validNonce(params.Nonce) {
		return fmt.Errorf("%w: invalid request correlation headers", ErrMalformed)
	}
	created, expires := params.Created.Truncate(time.Second), params.Expires.Truncate(time.Second)
	if created.IsZero() || expires.IsZero() || !expires.After(created) || expires.Sub(created) > DefaultSignatureLifetime {
		return fmt.Errorf("%w: invalid signature validity window", ErrMalformed)
	}
	if created.Before(key.NotBefore) || expires.After(key.NotAfter) {
		return ErrKeyInactive
	}
	if request.Header == nil {
		request.Header = make(http.Header)
	}
	request.Header.Set("Content-Type", SignedContentType)
	request.Header.Set(HeaderOperatorID, key.OperatorID)
	request.Header.Set(HeaderRequestID, params.RequestID)
	request.Header.Set(HeaderIdempotencyKey, params.IdempotencyKey)
	request.Header.Set(HeaderNonce, params.Nonce)
	request.Header.Set(HeaderContentDigest, makeContentDigest(body))
	input := formatSignatureInput(created.Unix(), expires.Unix(), key.KeyID)
	request.Header.Set(HeaderSignatureInput, input)

	canonical, err := canonicalRequest(request, input)
	if err != nil {
		return err
	}
	signature := ed25519.Sign(key.PrivateKey, []byte(canonical))
	request.Header.Set(HeaderSignature, "sig1=:"+base64.StdEncoding.EncodeToString(signature)+":")
	return nil
}

// Authenticate 完成纯验证并返回已经过签名认证的身份，但不会写入随机数存储。
// HTTP 边界可据此按可信运营商进行准入；只有准入成功后才消费随机数，避免被限流流量
// 持续制造持久化写入。调用方必须紧接着调用 ConsumeNonce，之后才能触发业务副作用。
func (v *RequestVerifier) Authenticate(ctx context.Context, request *http.Request, body []byte) (VerifiedRequest, error) {
	if request == nil || len(body) > MaximumSignedRequestBody {
		return VerifiedRequest{}, fmt.Errorf("%w: invalid signed request", ErrMalformed)
	}
	input, err := singleHeader(request.Header, HeaderSignatureInput)
	if err != nil {
		return VerifiedRequest{}, err
	}
	createdUnix, expiresUnix, keyID, err := parseSignatureInput(input)
	if err != nil {
		return VerifiedRequest{}, err
	}
	key, found, err := v.keys.ResolveKey(ctx, KeyPurposeHTTPRequest, keyID)
	if err != nil {
		return VerifiedRequest{}, err
	}
	if !found {
		return VerifiedRequest{}, ErrUnknownKey
	}
	if err := validateVerificationKey(key); err != nil {
		return VerifiedRequest{}, ErrUnknownKey
	}

	created, expires := time.Unix(createdUnix, 0), time.Unix(expiresUnix, 0)
	now := v.now()
	if !expires.After(created) || expires.Sub(created) > v.maxLifetime {
		return VerifiedRequest{}, fmt.Errorf("%w: invalid signature validity window", ErrMalformed)
	}
	if created.After(now.Add(v.clockSkew)) {
		return VerifiedRequest{}, ErrNotYetValid
	}
	if !expires.After(now.Add(-v.clockSkew)) {
		return VerifiedRequest{}, ErrExpired
	}
	if created.Before(key.NotBefore.Add(-v.clockSkew)) || expires.After(key.NotAfter.Add(v.clockSkew)) || now.After(key.NotAfter.Add(v.clockSkew)) {
		return VerifiedRequest{}, ErrKeyInactive
	}

	operatorID, err := singleHeader(request.Header, HeaderOperatorID)
	if err != nil {
		return VerifiedRequest{}, err
	}
	if subtle.ConstantTimeCompare([]byte(operatorID), []byte(key.OperatorID)) != 1 {
		return VerifiedRequest{}, ErrTenantMismatch
	}
	requestID, err := singleHeader(request.Header, HeaderRequestID)
	if err != nil || !validIdentifier(requestID) {
		return VerifiedRequest{}, fmt.Errorf("%w: invalid request id", ErrMalformed)
	}
	idempotencyKey, err := singleHeader(request.Header, HeaderIdempotencyKey)
	if err != nil || !validIdentifier(idempotencyKey) {
		return VerifiedRequest{}, fmt.Errorf("%w: invalid idempotency key", ErrMalformed)
	}
	nonce, err := singleHeader(request.Header, HeaderNonce)
	if err != nil || !validNonce(nonce) {
		return VerifiedRequest{}, fmt.Errorf("%w: invalid nonce", ErrMalformed)
	}

	digestHeader, err := singleHeader(request.Header, HeaderContentDigest)
	if err != nil {
		return VerifiedRequest{}, err
	}
	digest, err := decodeFixedBase64(contentDigestPattern, digestHeader, sha256.Size)
	if err != nil {
		return VerifiedRequest{}, ErrContentDigest
	}
	wantDigest := sha256.Sum256(body)
	if subtle.ConstantTimeCompare(digest, wantDigest[:]) != 1 {
		return VerifiedRequest{}, ErrContentDigest
	}

	canonical, err := canonicalRequest(request, input)
	if err != nil {
		return VerifiedRequest{}, err
	}
	signatureHeader, err := singleHeader(request.Header, HeaderSignature)
	if err != nil {
		return VerifiedRequest{}, err
	}
	signature, err := decodeFixedBase64(signaturePattern, signatureHeader, ed25519.SignatureSize)
	if err != nil || !ed25519.Verify(key.PublicKey, []byte(canonical), signature) {
		return VerifiedRequest{}, ErrSignatureInvalid
	}

	verified := VerifiedRequest{
		OperatorID: key.OperatorID, KeyID: key.KeyID,
		RequestID: requestID, IdempotencyKey: idempotencyKey, Nonce: nonce,
		Created: created, Expires: expires,
		verifiedBy: v,
	}
	verified.binding = verifiedRequestBinding{
		operatorID: verified.OperatorID, keyID: verified.KeyID,
		requestID: verified.RequestID, idempotencyKey: verified.IdempotencyKey,
		nonce: verified.Nonce, created: verified.Created, expires: verified.Expires,
	}
	return verified, nil
}

// ConsumeNonce 是认证后的唯一持久化阶段。它必须先于任何业务副作用调用，并依赖
// NonceStore 的原子语义，让同一签名请求在所有副本上至多通过一次。
func (v *RequestVerifier) ConsumeNonce(ctx context.Context, verified VerifiedRequest) error {
	// 私有绑定证明该值确由同一个验证器实例的 Authenticate 产生，且公开字段在准入
	// 与随机数消费之间没有被内部调用方改写；不能用手工构造值绕过验签阶段。
	if verified.verifiedBy != v || verified.binding != (verifiedRequestBinding{
		operatorID: verified.OperatorID, keyID: verified.KeyID,
		requestID: verified.RequestID, idempotencyKey: verified.IdempotencyKey,
		nonce: verified.Nonce, created: verified.Created, expires: verified.Expires,
	}) ||
		!validIdentifier(verified.OperatorID) || !validIdentifier(verified.KeyID) ||
		!validIdentifier(verified.RequestID) || !validIdentifier(verified.IdempotencyKey) ||
		!validNonce(verified.Nonce) || verified.Created.IsZero() || verified.Expires.IsZero() ||
		!verified.Expires.After(verified.Created) || verified.Expires.Sub(verified.Created) > v.maxLifetime {
		return fmt.Errorf("%w: invalid verified request", ErrMalformed)
	}
	scope := string(KeyPurposeHTTPRequest) + "\x00" + verified.OperatorID + "\x00" + verified.KeyID
	// 应用时钟最晚会在 expires+skew 前接受请求；PostgreSQL 时钟又可能领先应用
	// 一个允许偏差，因此随机数必须保留到 expires+2*skew 才能覆盖完整接受窗口。
	nonceRetentionDeadline := verified.Expires.Add(v.clockSkew).Add(v.clockSkew)
	consumed, err := v.nonces.Consume(ctx, scope, verified.Nonce, nonceRetentionDeadline)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrNonceStore, err)
	}
	if !consumed {
		return ErrReplay
	}
	return nil
}

// Verify 保留给无需单独准入阶段的内部调用；其安全语义与历史行为一致。
func (v *RequestVerifier) Verify(ctx context.Context, request *http.Request, body []byte) (VerifiedRequest, error) {
	verified, err := v.Authenticate(ctx, request, body)
	if err != nil {
		return VerifiedRequest{}, err
	}
	if err := v.ConsumeNonce(ctx, verified); err != nil {
		return VerifiedRequest{}, err
	}
	return verified, nil
}

func canonicalRequest(request *http.Request, signatureInput string) (string, error) {
	if request.URL == nil || request.URL.RawQuery != "" || request.URL.ForceQuery {
		return "", fmt.Errorf("%w: signed request query is not supported", ErrMalformed)
	}
	if request.Method == "" || request.Method != strings.ToUpper(request.Method) {
		return "", fmt.Errorf("%w: method must be uppercase", ErrMalformed)
	}
	for _, character := range request.Method {
		if character < 'A' || character > 'Z' {
			return "", fmt.Errorf("%w: invalid method", ErrMalformed)
		}
	}
	authority := strings.ToLower(request.Host)
	if !authorityPattern.MatchString(authority) {
		return "", fmt.Errorf("%w: invalid authority", ErrMalformed)
	}
	path := request.URL.EscapedPath()
	if path == "" {
		path = "/"
	}
	if !strings.HasPrefix(path, "/") || strings.ContainsAny(path, "\r\n\"") {
		return "", fmt.Errorf("%w: invalid path", ErrMalformed)
	}
	contentType, err := singleHeader(request.Header, "Content-Type")
	if err != nil || contentType != SignedContentType {
		return "", fmt.Errorf("%w: content type must be %s", ErrMalformed, SignedContentType)
	}
	digest, err := singleHeader(request.Header, HeaderContentDigest)
	if err != nil {
		return "", err
	}
	operatorID, err := singleHeader(request.Header, HeaderOperatorID)
	if err != nil {
		return "", err
	}
	requestID, err := singleHeader(request.Header, HeaderRequestID)
	if err != nil {
		return "", err
	}
	nonce, err := singleHeader(request.Header, HeaderNonce)
	if err != nil {
		return "", err
	}
	idempotencyKey, err := singleHeader(request.Header, HeaderIdempotencyKey)
	if err != nil {
		return "", err
	}

	return strings.Join([]string{
		`"@method": ` + request.Method,
		`"@authority": ` + authority,
		`"@path": ` + path,
		`"content-digest": ` + digest,
		`"content-type": ` + contentType,
		`"x-operator-id": ` + operatorID,
		`"x-request-id": ` + requestID,
		`"x-nonce": ` + nonce,
		`"idempotency-key": ` + idempotencyKey,
		`"@signature-params": ` + strings.TrimPrefix(signatureInput, "sig1="),
	}, "\n"), nil
}

func formatSignatureInput(created, expires int64, keyID string) string {
	return "sig1=" + fixedSignatureComponentSet + ";created=" + strconv.FormatInt(created, 10) +
		";expires=" + strconv.FormatInt(expires, 10) + ";keyid=\"" + keyID + "\";alg=\"ed25519\""
}

func parseSignatureInput(value string) (int64, int64, string, error) {
	matches := signatureInputPattern.FindStringSubmatch(value)
	if matches == nil {
		return 0, 0, "", fmt.Errorf("%w: signature input does not match the fixed profile", ErrMalformed)
	}
	created, err := strconv.ParseInt(matches[1], 10, 64)
	if err != nil {
		return 0, 0, "", fmt.Errorf("%w: invalid created parameter", ErrMalformed)
	}
	expires, err := strconv.ParseInt(matches[2], 10, 64)
	if err != nil {
		return 0, 0, "", fmt.Errorf("%w: invalid expires parameter", ErrMalformed)
	}
	return created, expires, matches[3], nil
}

func makeContentDigest(body []byte) string {
	digest := sha256.Sum256(body)
	return "sha-256=:" + base64.StdEncoding.EncodeToString(digest[:]) + ":"
}

func singleHeader(header http.Header, name string) (string, error) {
	values := header.Values(name)
	if len(values) != 1 || values[0] == "" || strings.ContainsAny(values[0], "\r\n") {
		return "", fmt.Errorf("%w: header %s must occur exactly once", ErrMalformed, name)
	}
	return values[0], nil
}

func decodeFixedBase64(pattern *regexp.Regexp, value string, size int) ([]byte, error) {
	matches := pattern.FindStringSubmatch(value)
	if matches == nil {
		return nil, ErrMalformed
	}
	decoded, err := base64.StdEncoding.DecodeString(matches[1])
	if err != nil || len(decoded) != size || base64.StdEncoding.EncodeToString(decoded) != matches[1] {
		return nil, ErrMalformed
	}
	return decoded, nil
}
