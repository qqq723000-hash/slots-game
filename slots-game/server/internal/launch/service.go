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
	now   func() time.Time
}

func NewService(store Store, options Options) (*Service, error) {
	return newService(store, options, cryptorand.Reader, time.Now)
}

func newService(store Store, options Options, random io.Reader, now func() time.Time) (*Service, error) {
	if store == nil || random == nil || now == nil {
		return nil, fmt.Errorf("%w: launch service dependencies are required", ErrInvalidInput)
	}
	if options.TTL == 0 {
		options.TTL = DefaultTTL
	}
	if options.TTL < MinimumTTL || options.TTL > MaximumTTL {
		return nil, fmt.Errorf("%w: launch TTL must be between %s and %s", ErrInvalidInput, MinimumTTL, MaximumTTL)
	}
	return &Service{store: store, ttl: options.TTL, rand: random, now: now}, nil
}

// Issue 创建不透明、高熵且短期有效的凭据。只有 SHA-256 摘要能够跨越 Store 边界。
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
		createdAt := s.now().UTC()
		record := Record{
			Digest: digest, Claims: claims,
			CreatedAt: createdAt, ExpiresAt: createdAt.Add(s.ttl),
		}
		if err := s.store.Create(ctx, record); err != nil {
			if errors.Is(err, ErrDigestExists) {
				continue
			}
			return IssuedCode{}, err
		}
		return IssuedCode{Code: code, ExpiresAt: record.ExpiresAt}, nil
	}
	return IssuedCode{}, fmt.Errorf("%w: repeated launch-code digest collision", ErrEntropy)
}

// IssueCode 持久化预先派生的 256 位启动码；当摘要及所有声明已存在且仍在
// IdempotencyRetention 内时，会重放包含原始过期时间的同一响应。生产环境使用由运营商、
// 会话及交接幂等身份作为输入的 HMAC 派生码；任意调用方提供的启动码绝不能进入此方法。
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
	replays, ok := s.store.(ReplayStore)
	if !ok {
		return IssuedCode{}, fmt.Errorf("%w: store does not support idempotent replay", ErrStoreInvariant)
	}
	digest := CodeDigest(sha256.Sum256([]byte(code)))
	createdAt := s.now().UTC()
	record := Record{
		Digest: digest, Claims: claims,
		CreatedAt: createdAt, ExpiresAt: createdAt.Add(s.ttl),
	}
	err := s.store.Create(ctx, record)
	if err == nil {
		return IssuedCode{Code: code, ExpiresAt: record.ExpiresAt}, nil
	}
	if !errors.Is(err, ErrDigestExists) {
		return IssuedCode{}, err
	}
	existing, getErr := replays.Get(ctx, digest)
	if getErr != nil {
		return IssuedCode{}, getErr
	}
	if existing.Digest != digest || existing.Claims != claims ||
		!idempotencyRetained(existing, createdAt) {
		return IssuedCode{}, ErrDigestExists
	}
	if err := validateRecord(existing); err != nil {
		return IssuedCode{}, fmt.Errorf("%w: %v", ErrStoreInvariant, err)
	}
	return IssuedCode{
		Code: code, ExpiresAt: existing.ExpiresAt,
		HistoricalReplay: !existing.ExpiresAt.After(createdAt),
	}, nil
}

// Consume 仅在启动码原始运营商及会话绑定下执行一次性兑换。
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
	exchangeAt := s.now().UTC()
	digest := CodeDigest(sha256.Sum256([]byte(code)))
	record, err := s.store.Consume(ctx, ConsumeRequest{Digest: digest, Binding: binding})
	if err != nil {
		return Claims{}, err
	}
	if err := validateRecord(record); err != nil {
		return Claims{}, fmt.Errorf("%w: %v", ErrStoreInvariant, err)
	}
	if subtle.ConstantTimeCompare(record.Digest[:], digest[:]) != 1 ||
		record.Claims.OperatorID != binding.OperatorID || record.Claims.SessionID != binding.SessionID ||
		!record.ExpiresAt.After(exchangeAt) {
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
