package operator

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"sync"
	"time"
)

type KeyPurpose string

const (
	KeyPurposeHTTPRequest  KeyPurpose = "HTTP_REQUEST"
	KeyPurposeHTTPResponse KeyPurpose = "HTTP_RESPONSE"
	KeyPurposeAccessToken  KeyPurpose = "ACCESS_TOKEN"
)

// VerificationKey 受租户及用途范围约束。同一用途内的密钥标识必须唯一；
// 绝不能使用未经验证的运营商请求头选择密钥。
// English: VerificationKey is subject to tenant and usage scope. Key identification must be unique within the same
// purpose; keys must not be selected using unvalidated operator request headers.
type VerificationKey struct {
	KeyID      string
	OperatorID string
	Purpose    KeyPurpose
	PublicKey  ed25519.PublicKey
	NotBefore  time.Time
	NotAfter   time.Time
}

type SigningKey struct {
	KeyID      string
	OperatorID string
	Purpose    KeyPurpose
	PrivateKey ed25519.PrivateKey
	NotBefore  time.Time
	NotAfter   time.Time
}

type KeyResolver interface {
	ResolveKey(context.Context, KeyPurpose, string) (VerificationKey, bool, error)
}

type MemoryKeyRing struct {
	mu   sync.RWMutex
	keys map[string]VerificationKey
}

func NewMemoryKeyRing(keys ...VerificationKey) (*MemoryKeyRing, error) {
	ring := &MemoryKeyRing{keys: make(map[string]VerificationKey)}
	for _, key := range keys {
		if err := ring.Add(key); err != nil {
			return nil, err
		}
	}
	return ring, nil
}

func (r *MemoryKeyRing) Add(key VerificationKey) error {
	if err := validateVerificationKey(key); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	identity := keyMapID(key.Purpose, key.KeyID)
	if _, exists := r.keys[identity]; exists {
		return fmt.Errorf("%w: duplicate key id for purpose", ErrMalformed)
	}
	key.PublicKey = append(ed25519.PublicKey(nil), key.PublicKey...)
	r.keys[identity] = key
	return nil
}

func (r *MemoryKeyRing) Remove(purpose KeyPurpose, keyID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.keys, keyMapID(purpose, keyID))
}

func (r *MemoryKeyRing) ResolveKey(ctx context.Context, purpose KeyPurpose, keyID string) (VerificationKey, bool, error) {
	if err := ctx.Err(); err != nil {
		return VerificationKey{}, false, err
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	key, ok := r.keys[keyMapID(purpose, keyID)]
	if ok {
		key.PublicKey = append(ed25519.PublicKey(nil), key.PublicKey...)
	}
	return key, ok, nil
}

func keyMapID(purpose KeyPurpose, keyID string) string {
	return string(purpose) + "\x00" + keyID
}

func validateVerificationKey(key VerificationKey) error {
	if !validIdentifier(key.KeyID) || !validIdentifier(key.OperatorID) {
		return fmt.Errorf("%w: invalid key or operator identifier", ErrMalformed)
	}
	if !validKeyPurpose(key.Purpose) {
		return fmt.Errorf("%w: invalid key purpose", ErrMalformed)
	}
	if len(key.PublicKey) != ed25519.PublicKeySize {
		return fmt.Errorf("%w: invalid Ed25519 public key", ErrMalformed)
	}
	if key.NotBefore.IsZero() || key.NotAfter.IsZero() || !key.NotAfter.After(key.NotBefore) {
		return fmt.Errorf("%w: invalid key validity window", ErrMalformed)
	}
	return nil
}

func validateSigningKey(key SigningKey) error {
	if !validIdentifier(key.KeyID) || !validIdentifier(key.OperatorID) {
		return fmt.Errorf("%w: invalid key or operator identifier", ErrMalformed)
	}
	if !validKeyPurpose(key.Purpose) {
		return fmt.Errorf("%w: invalid key purpose", ErrMalformed)
	}
	if len(key.PrivateKey) != ed25519.PrivateKeySize {
		return fmt.Errorf("%w: invalid Ed25519 private key", ErrMalformed)
	}
	if key.NotBefore.IsZero() || key.NotAfter.IsZero() || !key.NotAfter.After(key.NotBefore) {
		return fmt.Errorf("%w: invalid key validity window", ErrMalformed)
	}
	public, ok := key.PrivateKey.Public().(ed25519.PublicKey)
	if !ok || len(public) != ed25519.PublicKeySize {
		return errors.New("invalid Ed25519 signing key")
	}
	return nil
}

func validKeyPurpose(purpose KeyPurpose) bool {
	return purpose == KeyPurposeHTTPRequest || purpose == KeyPurposeHTTPResponse || purpose == KeyPurposeAccessToken
}
