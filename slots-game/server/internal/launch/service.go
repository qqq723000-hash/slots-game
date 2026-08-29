package launch

import (
	"context"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

type Options struct {
	TTL time.Duration
}

type Service struct {
	store Store
	ttl   time.Duration
	rand  io.Reader
}

func NewService(store Store, options Options) (*Service, error) {
	return newService(store, options, cryptorand.Reader)
}

func newService(store Store, options Options, random io.Reader) (*Service, error) {
	if store == nil || random == nil {
		return nil, fmt.Errorf("%w: launch service dependencies are required", ErrInvalidInput)
	}
	if options.TTL == 0 {
		options.TTL = DefaultTTL
	}
	if options.TTL < MinimumTTL || options.TTL > MaximumTTL {
		return nil, fmt.Errorf("%w: launch TTL must be between %s and %s", ErrInvalidInput, MinimumTTL, MaximumTTL)
	}
	if options.TTL%time.Microsecond != 0 {
		return nil, fmt.Errorf("%w: launch TTL must use microsecond precision", ErrInvalidInput)
	}
	return &Service{store: store, ttl: options.TTL, rand: random}, nil
}

// Issue 创建不透明、高熵且短期有效的凭据。只有 SHA-256 摘要能够跨越 Store 边界。
// English: Issue creates credentials that are opaque, high-entropy, and short-lived. Only SHA-256 digests can
// cross Store boundaries.
func (s *Service) Issue(ctx context.Context, claims Claims) (IssuedCode, error) {
	if err := ctx.Err(); err != nil {
		return IssuedCode{}, err
	}
	if err := validateClaims(claims); err != nil {
		return IssuedCode{}, err
	}

	for attempt := 0; attempt < codeGenerationTries; attempt++ {
		var entropy [CodeEntropyBytes]byte
		if _, err := io.ReadFull(s.rand, entropy[:]); err != nil {
			return IssuedCode{}, fmt.Errorf("%w: %v", ErrEntropy, err)
		}
		code := CodePrefix + base64.RawURLEncoding.EncodeToString(entropy[:])
		digest := CodeDigest(sha256.Sum256([]byte(code)))
		record, err := s.create(ctx, digest, claims)
		if err != nil {
			if errors.Is(err, ErrDigestExists) {
				continue
			}
			return IssuedCode{}, err
		}
		return IssuedCode{
			Code: code, ExpiresAt: record.ExpiresAt, ValidatedAt: record.CreatedAt,
		}, nil
	}
	return IssuedCode{}, fmt.Errorf("%w: repeated launch-code digest collision", ErrEntropy)
}

// IssueCode 持久化预先派生的 256 位启动码；当摘要及所有声明已存在且仍在
// IdempotencyRetention 内时，会重放包含原始过期时间的同一响应。生产环境使用由运营商、
// 会话及交接幂等身份作为输入的 HMAC 派生码；任意调用方提供的启动码绝不能进入此方法。
// English: IssueCode persists a pre-derived 256-bit activation code; while the digest and all claims exist and are
// still within the IdempotencyRetention, the same response is replayed with the original expiration time.
// Production environments use HMAC derived codes with operator, session, and handover idempotent identities as
// input; any caller-supplied activation code MUST NOT enter this method.
func (s *Service) IssueCode(ctx context.Context, claims Claims, code string) (IssuedCode, error) {
	if err := ctx.Err(); err != nil {
		return IssuedCode{}, err
	}
	if err := validateClaims(claims); err != nil {
		return IssuedCode{}, err
	}
	if err := validateCode(code); err != nil {
		return IssuedCode{}, err
	}
	if _, ok := s.store.(ReplayStore); !ok {
		return IssuedCode{}, fmt.Errorf("%w: store does not support idempotent replay", ErrStoreInvariant)
	}
	digest := CodeDigest(sha256.Sum256([]byte(code)))
	record, err := s.create(ctx, digest, claims)
	if err == nil {
		return IssuedCode{
			Code: code, ExpiresAt: record.ExpiresAt, ValidatedAt: record.CreatedAt,
		}, nil
	}
	if !errors.Is(err, ErrDigestExists) {
		return IssuedCode{}, err
	}
	replayed, found, replayErr := s.findCodeReplay(ctx, claims, code)
	if replayErr != nil {
		return IssuedCode{}, replayErr
	}
	if !found {
		return IssuedCode{}, ErrCodeUnavailable
	}
	return replayed, nil
}

func (s *Service) create(ctx context.Context, digest CodeDigest, claims Claims) (Record, error) {
	record, err := s.store.Create(ctx, CreateRequest{
		Digest: digest,
		Claims: claims,
		TTL:    s.ttl,
	})
	if err != nil {
		return Record{}, err
	}
	if err := validateRecord(record); err != nil {
		return Record{}, fmt.Errorf("%w: invalid created launch record", ErrStoreInvariant)
	}
	if record.Digest != digest || record.Claims != claims ||
		record.ExpiresAt.Sub(record.CreatedAt) != s.ttl {
		return Record{}, ErrStoreInvariant
	}
	return record, nil
}

// FindCodeReplay 只查询已持久化的确定性交接响应，不创建新的启动码。它供上层在
// durable session 绝对到期后仍满足同一 idempotency key 的有界 HTTP 重放，同时
// 确保新的 handoff 必须先通过会话有效期裁决。
// English: FindCodeReplay only queries persisted deterministic handover responses and does not create new startup
// codes. It provides the upper layer with bounded HTTP replay that still satisfies the same idempotency key after
// the absolute expiration of the durable session, while ensuring that new handoffs must first pass the session
// validity period.
func (s *Service) FindCodeReplay(
	ctx context.Context,
	claims Claims,
	code string,
) (IssuedCode, bool, error) {
	if err := ctx.Err(); err != nil {
		return IssuedCode{}, false, err
	}
	if err := validateClaims(claims); err != nil {
		return IssuedCode{}, false, err
	}
	if err := validateCode(code); err != nil {
		return IssuedCode{}, false, err
	}
	return s.findCodeReplay(ctx, claims, code)
}

func (s *Service) findCodeReplay(
	ctx context.Context,
	claims Claims,
	code string,
) (IssuedCode, bool, error) {
	replays, ok := s.store.(ReplayStore)
	if !ok {
		return IssuedCode{}, false, fmt.Errorf(
			"%w: store does not support idempotent replay", ErrStoreInvariant,
		)
	}
	digest := CodeDigest(sha256.Sum256([]byte(code)))
	observation, err := replays.Get(ctx, digest)
	if errors.Is(err, ErrCodeUnavailable) {
		return IssuedCode{}, false, nil
	}
	if err != nil {
		return IssuedCode{}, false, err
	}
	if observation.ObservedAt.IsZero() {
		return IssuedCode{}, false, fmt.Errorf(
			"%w: replay observation time is required", ErrStoreInvariant,
		)
	}
	existing := observation.Record
	observedAt := observation.ObservedAt.UTC()
	if existing.Digest != digest || existing.Claims != claims ||
		!idempotencyRetained(existing, observedAt) {
		return IssuedCode{}, false, ErrDigestExists
	}
	if err := validateRecord(existing); err != nil {
		return IssuedCode{}, false, fmt.Errorf("%w: %v", ErrStoreInvariant, err)
	}
	return IssuedCode{
		Code: code, ExpiresAt: existing.ExpiresAt,
		ValidatedAt:      observedAt,
		HistoricalReplay: !existing.ExpiresAt.After(observedAt),
	}, true, nil
}

// Consume 仅在启动码原始运营商及会话绑定下执行一次性兑换。
// English: Consume only performs one-time redemption under the original operator and session binding of the
// activation code.
func (s *Service) Consume(ctx context.Context, code string, binding Binding) (Claims, error) {
	if err := ctx.Err(); err != nil {
		return Claims{}, err
	}
	if err := validateBinding(binding); err != nil {
		return Claims{}, err
	}
	if err := validateCode(code); err != nil {
		return Claims{}, err
	}
	digest := CodeDigest(sha256.Sum256([]byte(code)))
	record, err := s.store.Consume(ctx, ConsumeRequest{Digest: digest, Binding: binding})
	if err != nil {
		return Claims{}, err
	}
	if err := validateRecord(record); err != nil {
		return Claims{}, fmt.Errorf("%w: %v", ErrStoreInvariant, err)
	}
	if subtle.ConstantTimeCompare(record.Digest[:], digest[:]) != 1 ||
		record.Claims.OperatorID != binding.OperatorID || record.Claims.SessionID != binding.SessionID {
		return Claims{}, ErrStoreInvariant
	}
	return record.Claims, nil
}

func validateCode(code string) error {
	if len(code) != len(CodePrefix)+base64.RawURLEncoding.EncodedLen(CodeEntropyBytes) || !strings.HasPrefix(code, CodePrefix) {
		return fmt.Errorf("%w: invalid launch code", ErrInvalidInput)
	}
	encoded := strings.TrimPrefix(code, CodePrefix)
	if strings.Contains(encoded, "=") {
		return fmt.Errorf("%w: invalid launch code", ErrInvalidInput)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(decoded) != CodeEntropyBytes || base64.RawURLEncoding.EncodeToString(decoded) != encoded {
		return fmt.Errorf("%w: invalid launch code", ErrInvalidInput)
	}
	return nil
}
