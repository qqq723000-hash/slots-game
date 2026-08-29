package operator

import (
	"bytes"
	"context"
	"crypto/ed25519"
	cryptorand "crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

const (
	AccessTokenType            = "RGS-ACCESS"
	AccessTokenAlgorithm       = "EdDSA"
	AccessTokenVersion         = 3
	DefaultAccessTokenLifetime = 15 * time.Minute
	MaximumCompactTokenBytes   = 8 << 10
)

type AccessTokenSubject struct {
	OperatorID            string
	PlayerID              string
	WalletSessionID       string
	SessionID             string
	GameID                string
	GameDefinitionVersion string
	GameDefinitionHash    string
	Currency              string
	CurrencyExponent      int
	Jurisdiction          string
	TransportGeneration   uint64
}

type AccessTokenClaims struct {
	Issuer                string `json:"iss"`
	Audience              string `json:"aud"`
	OperatorID            string `json:"operator_id"`
	PlayerID              string `json:"player_id"`
	WalletSessionID       string `json:"wallet_session_id"`
	SessionID             string `json:"session_id"`
	GameID                string `json:"game_id"`
	GameDefinitionVersion string `json:"game_definition_version"`
	GameDefinitionHash    string `json:"game_definition_hash"`
	Currency              string `json:"currency"`
	CurrencyExponent      int    `json:"currency_exponent"`
	Jurisdiction          string `json:"jurisdiction"`
	IssuedAt              int64  `json:"iat"`
	ExpiresAt             int64  `json:"exp"`
	TokenID               string `json:"jti"`
	TransportGeneration   uint64 `json:"transport_generation"`
}

type compactTokenHeader struct {
	Algorithm string `json:"alg"`
	Type      string `json:"typ"`
	KeyID     string `json:"kid"`
	Version   int    `json:"v"`
}

type AccessTokenIssuerOptions struct {
	Issuer      string
	Audience    string
	Now         func() time.Time
	MaxLifetime time.Duration
}

type AccessTokenIssuer struct {
	key         SigningKey
	issuer      string
	audience    string
	now         func() time.Time
	maxLifetime time.Duration
}

func NewAccessTokenIssuer(key SigningKey, options AccessTokenIssuerOptions) (*AccessTokenIssuer, error) {
	if err := validateSigningKey(key); err != nil {
		return nil, err
	}
	if key.Purpose != KeyPurposeAccessToken {
		return nil, fmt.Errorf("%w: signing key has wrong purpose", ErrMalformed)
	}
	if !validTextClaim(options.Issuer, 256) || !validTextClaim(options.Audience, 256) || options.MaxLifetime < 0 {
		return nil, fmt.Errorf("%w: invalid token issuer options", ErrMalformed)
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.MaxLifetime == 0 {
		options.MaxLifetime = DefaultAccessTokenLifetime
	}
	if options.MaxLifetime < time.Second {
		return nil, fmt.Errorf("%w: max token lifetime must be at least one second", ErrMalformed)
	}
	return &AccessTokenIssuer{
		key: key, issuer: options.Issuer, audience: options.Audience,
		now: options.Now, maxLifetime: options.MaxLifetime,
	}, nil
}

func (i *AccessTokenIssuer) Issue(subject AccessTokenSubject, lifetime time.Duration) (string, AccessTokenClaims, error) {
	return i.IssueAt(subject, lifetime, i.now())
}

// IssueAt 使用调用方已从权威持久化操作取得的时间签发令牌。session exchange、
// relaunch 与 refresh 不得再次用 Pod 墙钟推导 iat/exp。
// English: IssueAt issues the token using the time that the caller has obtained from the authoritative persistence
// operation. Session exchange, relaunch and refresh must not use the Pod wall clock to derive iat/exp again.
func (i *AccessTokenIssuer) IssueAt(
	subject AccessTokenSubject,
	lifetime time.Duration,
	authoritativeNow time.Time,
) (string, AccessTokenClaims, error) {
	if err := validateAccessSubject(subject); err != nil {
		return "", AccessTokenClaims{}, err
	}
	if subtle.ConstantTimeCompare([]byte(subject.OperatorID), []byte(i.key.OperatorID)) != 1 {
		return "", AccessTokenClaims{}, ErrTenantMismatch
	}
	if lifetime < time.Second || lifetime > i.maxLifetime {
		return "", AccessTokenClaims{}, fmt.Errorf("%w: invalid token lifetime", ErrMalformed)
	}
	if authoritativeNow.IsZero() {
		return "", AccessTokenClaims{}, fmt.Errorf("%w: authoritative issue time is required", ErrMalformed)
	}
	issuedAt := authoritativeNow.UTC().Truncate(time.Second)
	expiresAt := issuedAt.Add(lifetime).Truncate(time.Second)
	if issuedAt.Before(i.key.NotBefore) {
		return "", AccessTokenClaims{}, ErrNotYetValid
	}
	if expiresAt.After(i.key.NotAfter) {
		return "", AccessTokenClaims{}, ErrKeyInactive
	}
	tokenID, err := newAccessTokenID()
	if err != nil {
		return "", AccessTokenClaims{}, err
	}
	claims := AccessTokenClaims{
		Issuer: i.issuer, Audience: i.audience,
		OperatorID: subject.OperatorID, PlayerID: subject.PlayerID,
		WalletSessionID: subject.WalletSessionID, SessionID: subject.SessionID,
		GameID: subject.GameID, GameDefinitionVersion: subject.GameDefinitionVersion,
		GameDefinitionHash: subject.GameDefinitionHash,
		Currency:           subject.Currency, CurrencyExponent: subject.CurrencyExponent,
		Jurisdiction:        subject.Jurisdiction,
		TransportGeneration: subject.TransportGeneration,
		IssuedAt:            issuedAt.Unix(), ExpiresAt: expiresAt.Unix(), TokenID: tokenID,
	}
	header := compactTokenHeader{
		Algorithm: AccessTokenAlgorithm, Type: AccessTokenType,
		KeyID: i.key.KeyID, Version: AccessTokenVersion,
	}
	headerJSON, err := json.Marshal(header)
	if err != nil {
		return "", AccessTokenClaims{}, err
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		return "", AccessTokenClaims{}, err
	}
	headerPart := base64.RawURLEncoding.EncodeToString(headerJSON)
	claimsPart := base64.RawURLEncoding.EncodeToString(claimsJSON)
	signingInput := headerPart + "." + claimsPart
	signature := ed25519.Sign(i.key.PrivateKey, []byte(signingInput))
	token := signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)
	return token, claims, nil
}

type AccessTokenVerifierOptions struct {
	ExpectedIssuer   string
	ExpectedAudience string
	Now              func() time.Time
	ClockSkew        time.Duration
	MaxLifetime      time.Duration
}

type AccessTokenVerifier struct {
	keys             KeyResolver
	expectedIssuer   string
	expectedAudience string
	now              func() time.Time
	clockSkew        time.Duration
	maxLifetime      time.Duration
}

func NewAccessTokenVerifier(keys KeyResolver, options AccessTokenVerifierOptions) (*AccessTokenVerifier, error) {
	if keys == nil || !validTextClaim(options.ExpectedIssuer, 256) || !validTextClaim(options.ExpectedAudience, 256) {
		return nil, fmt.Errorf("%w: invalid access token verifier options", ErrMalformed)
	}
	if options.ClockSkew < 0 || options.MaxLifetime < 0 {
		return nil, fmt.Errorf("%w: invalid verifier durations", ErrMalformed)
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.MaxLifetime == 0 {
		options.MaxLifetime = DefaultAccessTokenLifetime
	}
	if options.MaxLifetime < time.Second {
		return nil, fmt.Errorf("%w: max token lifetime must be at least one second", ErrMalformed)
	}
	return &AccessTokenVerifier{
		keys: keys, expectedIssuer: options.ExpectedIssuer,
		expectedAudience: options.ExpectedAudience, now: options.Now,
		clockSkew: options.ClockSkew, maxLifetime: options.MaxLifetime,
	}, nil
}

// Verify 认证紧凑令牌，并将其绑定到调用方预期的租户。这是固定令牌格式，
// 并非通用 JWT 实现。
// English: Verify authenticates the compact token and binds it to the tenant expected by the caller. This is a
// fixed token format, not a universal JWT implementation.
func (v *AccessTokenVerifier) Verify(ctx context.Context, token, expectedOperatorID string) (AccessTokenClaims, error) {
	if len(token) == 0 || len(token) > MaximumCompactTokenBytes || !validIdentifier(expectedOperatorID) {
		return AccessTokenClaims{}, fmt.Errorf("%w: invalid compact token", ErrMalformed)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return AccessTokenClaims{}, fmt.Errorf("%w: compact token must have three parts", ErrMalformed)
	}
	headerJSON, err := decodeRawURLPart(parts[0], 1024)
	if err != nil {
		return AccessTokenClaims{}, err
	}
	var header compactTokenHeader
	if err := decodeStrictFlatObject(headerJSON, &header); err != nil {
		return AccessTokenClaims{}, err
	}
	if header.Algorithm != AccessTokenAlgorithm || header.Type != AccessTokenType || header.Version != AccessTokenVersion || !validIdentifier(header.KeyID) {
		return AccessTokenClaims{}, fmt.Errorf("%w: unsupported compact token header", ErrMalformed)
	}
	key, found, err := v.keys.ResolveKey(ctx, KeyPurposeAccessToken, header.KeyID)
	if err != nil {
		return AccessTokenClaims{}, err
	}
	if !found {
		return AccessTokenClaims{}, ErrUnknownKey
	}
	if err := validateVerificationKey(key); err != nil {
		return AccessTokenClaims{}, ErrUnknownKey
	}
	signature, err := decodeRawURLPart(parts[2], ed25519.SignatureSize*2)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return AccessTokenClaims{}, ErrSignatureInvalid
	}
	if !ed25519.Verify(key.PublicKey, []byte(parts[0]+"."+parts[1]), signature) {
		return AccessTokenClaims{}, ErrSignatureInvalid
	}

	claimsJSON, err := decodeRawURLPart(parts[1], 4096)
	if err != nil {
		return AccessTokenClaims{}, err
	}
	var claims AccessTokenClaims
	if err := decodeStrictFlatObject(claimsJSON, &claims); err != nil {
		return AccessTokenClaims{}, err
	}
	if err := validateAccessClaims(claims); err != nil {
		return AccessTokenClaims{}, err
	}
	if subtle.ConstantTimeCompare([]byte(claims.OperatorID), []byte(key.OperatorID)) != 1 ||
		subtle.ConstantTimeCompare([]byte(claims.OperatorID), []byte(expectedOperatorID)) != 1 {
		return AccessTokenClaims{}, ErrTenantMismatch
	}
	if subtle.ConstantTimeCompare([]byte(claims.Issuer), []byte(v.expectedIssuer)) != 1 {
		return AccessTokenClaims{}, ErrIssuerMismatch
	}
	if subtle.ConstantTimeCompare([]byte(claims.Audience), []byte(v.expectedAudience)) != 1 {
		return AccessTokenClaims{}, ErrAudienceMismatch
	}

	issuedAt, expiresAt := time.Unix(claims.IssuedAt, 0), time.Unix(claims.ExpiresAt, 0)
	now := v.now()
	if !expiresAt.After(issuedAt) || expiresAt.Sub(issuedAt) > v.maxLifetime {
		return AccessTokenClaims{}, fmt.Errorf("%w: invalid token validity window", ErrMalformed)
	}
	if issuedAt.After(now.Add(v.clockSkew)) {
		return AccessTokenClaims{}, ErrNotYetValid
	}
	if !expiresAt.After(now.Add(-v.clockSkew)) {
		return AccessTokenClaims{}, ErrExpired
	}
	if issuedAt.Before(key.NotBefore.Add(-v.clockSkew)) || expiresAt.After(key.NotAfter.Add(v.clockSkew)) || now.After(key.NotAfter.Add(v.clockSkew)) {
		return AccessTokenClaims{}, ErrKeyInactive
	}
	return claims, nil
}

func validateAccessSubject(subject AccessTokenSubject) error {
	if !validIdentifier(subject.OperatorID) || !validIdentifier(subject.PlayerID) ||
		!validIdentifier(subject.WalletSessionID) || !validIdentifier(subject.SessionID) ||
		!validIdentifier(subject.GameID) || !validIdentifier(subject.GameDefinitionVersion) ||
		!digestPattern.MatchString(subject.GameDefinitionHash) ||
		!currencyPattern.MatchString(subject.Currency) || subject.CurrencyExponent < 0 || subject.CurrencyExponent > 6 ||
		!jurisdictionPattern.MatchString(subject.Jurisdiction) {
		return fmt.Errorf("%w: invalid access token subject", ErrMalformed)
	}
	if subject.TransportGeneration == 0 || subject.TransportGeneration > 9_223_372_036_854_775_807 {
		return fmt.Errorf("%w: invalid transport generation", ErrMalformed)
	}
	return nil
}

func validateAccessClaims(claims AccessTokenClaims) error {
	if !validTextClaim(claims.Issuer, 256) || !validTextClaim(claims.Audience, 256) ||
		!validIdentifier(claims.TokenID) || claims.IssuedAt < 0 || claims.ExpiresAt < 0 {
		return fmt.Errorf("%w: invalid access token claims", ErrMalformed)
	}
	return validateAccessSubject(AccessTokenSubject{
		OperatorID: claims.OperatorID, PlayerID: claims.PlayerID,
		WalletSessionID: claims.WalletSessionID, SessionID: claims.SessionID,
		GameID: claims.GameID, GameDefinitionVersion: claims.GameDefinitionVersion,
		GameDefinitionHash: claims.GameDefinitionHash,
		Currency:           claims.Currency, CurrencyExponent: claims.CurrencyExponent,
		Jurisdiction:        claims.Jurisdiction,
		TransportGeneration: claims.TransportGeneration,
	})
}

func newAccessTokenID() (string, error) {
	var raw [16]byte
	if _, err := cryptorand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate access token id: %w", err)
	}
	return "at_" + base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

func decodeRawURLPart(value string, maxDecodedBytes int) ([]byte, error) {
	if value == "" || strings.Contains(value, "=") || len(value) > maxDecodedBytes*2 {
		return nil, fmt.Errorf("%w: invalid compact token encoding", ErrMalformed)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) > maxDecodedBytes || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return nil, fmt.Errorf("%w: invalid compact token encoding", ErrMalformed)
	}
	return decoded, nil
}

func decodeStrictFlatObject(encoded []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return fmt.Errorf("%w: token data must be an object", ErrMalformed)
	}
	seen := make(map[string]struct{})
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("%w: invalid token object", ErrMalformed)
		}
		key, ok := keyToken.(string)
		if !ok {
			return fmt.Errorf("%w: invalid token object key", ErrMalformed)
		}
		if _, exists := seen[key]; exists {
			return fmt.Errorf("%w: duplicate token field", ErrMalformed)
		}
		seen[key] = struct{}{}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return fmt.Errorf("%w: invalid token field", ErrMalformed)
		}
	}
	if closing, err := decoder.Token(); err != nil || closing != json.Delim('}') {
		return fmt.Errorf("%w: invalid token object", ErrMalformed)
	}
	if _, err := decoder.Token(); err != io.EOF {
		return fmt.Errorf("%w: trailing token data", ErrMalformed)
	}

	strict := json.NewDecoder(bytes.NewReader(encoded))
	strict.DisallowUnknownFields()
	if err := strict.Decode(target); err != nil {
		return fmt.Errorf("%w: invalid token shape", ErrMalformed)
	}
	if err := strict.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("%w: trailing token data", ErrMalformed)
	}
	return nil
}
