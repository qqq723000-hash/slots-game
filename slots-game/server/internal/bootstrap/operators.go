package bootstrap

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"slots-game/server/internal/operator"
)

const (
	// OperatorDocumentSchema 是生产模式。每个运营商拥有独立的访问令牌签名密钥，
	// 并可在轮换该密钥时保留额外的验证密钥。
	OperatorDocumentSchema = "rgs-operators-v2"

	// LegacyOperatorDocumentSchema 仅为向后兼容迁移而读取。它从一对全局密钥派生
	// 所有租户密钥，生产运行时绝不能启用该模式。
	LegacyOperatorDocumentSchema = "rgs-operators-v1"
)

var identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// LoadedOperators 包含运行时不可变的信任及路由材料。VerificationKeys 可直接传给
// operator.NewMemoryKeyRing 构造函数。
type LoadedOperators struct {
	Schema           string                     `json:"schema"`
	TokenIssuer      string                     `json:"tokenIssuer"`
	TokenAudience    string                     `json:"tokenAudience"`
	VerificationKeys []operator.VerificationKey `json:"-"`
	Operators        map[string]LoadedOperator  `json:"-"`
}

type LoadedOperator struct {
	OperatorID                 string              `json:"operatorId"`
	AccessTokenSigningKey      operator.SigningKey `json:"-"`
	OperatorResponseSigningKey operator.SigningKey `json:"-"`
	Wallet                     LoadedWallet        `json:"wallet"`
}

type LoadedWallet struct {
	BaseURL                  string                     `json:"baseUrl"`
	RequestSigningKey        operator.SigningKey        `json:"-"`
	ResponseVerificationKeys []operator.VerificationKey `json:"-"`
}

type operatorLoadOptions struct {
	allowInsecureWalletHTTP bool
	requireIsolatedAccess   bool
}

type OperatorLoadOption func(*operatorLoadOptions) error

// AllowInsecureWalletHTTPForDevelopment 只能由明确选择的开发运行时传入。
// HTTPS 始终是失效即关闭的默认设置。
func AllowInsecureWalletHTTPForDevelopment() OperatorLoadOption {
	return func(options *operatorLoadOptions) error {
		options.allowInsecureWalletHTTP = true
		return nil
	}
}

// RequirePerOperatorAccessTokenKeys 拒绝在租户间共享同一访问令牌私钥的旧版文档。
// 生产启动必须传入此选项；旧版路径仅用于受控迁移。
func RequirePerOperatorAccessTokenKeys() OperatorLoadOption {
	return func(options *operatorLoadOptions) error {
		options.requireIsolatedAccess = true
		return nil
	}
}

type operatorDocument struct {
	Schema        string                  `json:"schema"`
	TokenIssuer   string                  `json:"tokenIssuer"`
	TokenAudience string                  `json:"tokenAudience"`
	Operators     []operatorDocumentEntry `json:"operators"`
}

type operatorDocumentEntry struct {
	OperatorID                  string                    `json:"operatorId"`
	AccessTokenSigningKey       signingKeyDocument        `json:"accessTokenSigningKey"`
	AccessTokenVerificationKeys []verificationKeyDocument `json:"accessTokenVerificationKeys"`
	// 已弃用的 v1 字段；v2 文档会拒绝这些字段。
	AccessTokenKeyID                string                    `json:"accessTokenKeyId"`
	NotBefore                       string                    `json:"notBefore"`
	NotAfter                        string                    `json:"notAfter"`
	OperatorRequestVerificationKeys []verificationKeyDocument `json:"operatorRequestVerificationKeys"`
	OperatorResponseSigningKey      signingKeyDocument        `json:"operatorResponseSigningKey"`
	Wallet                          walletDocument            `json:"wallet"`
}

type verificationKeyDocument struct {
	KeyID         string `json:"keyId"`
	NotBefore     string `json:"notBefore"`
	NotAfter      string `json:"notAfter"`
	PublicKeyFile string `json:"publicKeyFile"`
}

type signingKeyDocument struct {
	KeyID          string `json:"keyId"`
	NotBefore      string `json:"notBefore"`
	NotAfter       string `json:"notAfter"`
	PrivateKeyFile string `json:"privateKeyFile"`
	PublicKeyFile  string `json:"publicKeyFile"`
}

type walletDocument struct {
	BaseURL                  string                    `json:"baseUrl"`
	RequestSigningKey        signingKeyDocument        `json:"requestSigningKey"`
	ResponseVerificationKeys []verificationKeyDocument `json:"responseVerificationKeys"`
}

// LoadOperatorDocument 加载多租户信任文档。文档内的密钥文件路径相对于文档目录解析。
func LoadOperatorDocument(
	documentPath, accessPrivateKeyPath, accessPublicKeyPath string,
	optionFunctions ...OperatorLoadOption,
) (LoadedOperators, error) {
	options := operatorLoadOptions{}
	for _, apply := range optionFunctions {
		if apply == nil {
			return LoadedOperators{}, errors.New("nil operator load option")
		}
		if err := apply(&options); err != nil {
			return LoadedOperators{}, fmt.Errorf("apply operator load option: %w", err)
		}
	}

	var document operatorDocument
	if err := decodeStrictJSONFile(documentPath, &document); err != nil {
		return LoadedOperators{}, fmt.Errorf("load operator document: %w", err)
	}
	if document.Schema != OperatorDocumentSchema && document.Schema != LegacyOperatorDocumentSchema {
		return LoadedOperators{}, errors.New("unsupported operator document schema")
	}
	if options.requireIsolatedAccess && document.Schema != OperatorDocumentSchema {
		return LoadedOperators{}, errors.New("production requires rgs-operators-v2 with per-operator access-token keys")
	}
	if !validTextClaim(document.TokenIssuer, 256) || !validTextClaim(document.TokenAudience, 256) {
		return LoadedOperators{}, errors.New("invalid token issuer or audience")
	}
	if len(document.Operators) == 0 {
		return LoadedOperators{}, errors.New("operator document must contain at least one operator")
	}

	var legacyAccessPrivate ed25519.PrivateKey
	var legacyAccessPublic ed25519.PublicKey
	if document.Schema == LegacyOperatorDocumentSchema {
		var err error
		legacyAccessPrivate, legacyAccessPublic, err = loadMatchingEd25519KeyPair(accessPrivateKeyPath, accessPublicKeyPath)
		if err != nil {
			return LoadedOperators{}, fmt.Errorf("load legacy global access token key pair: %w", err)
		}
		defer clear(legacyAccessPrivate)
	}

	loaded := LoadedOperators{
		Schema: document.Schema, TokenIssuer: document.TokenIssuer,
		TokenAudience: document.TokenAudience,
		Operators:     make(map[string]LoadedOperator, len(document.Operators)),
	}
	keyIDs := make(map[string]string)
	accessPublicOwners := make(map[string]string)
	baseDirectory := filepath.Dir(documentPath)
	for index, configured := range document.Operators {
		contextName := fmt.Sprintf("operator %d", index)
		operatorID := configured.OperatorID
		if !identifierPattern.MatchString(operatorID) {
			return LoadedOperators{}, fmt.Errorf("%s has invalid operatorId", contextName)
		}
		if _, duplicate := loaded.Operators[operatorID]; duplicate {
			return LoadedOperators{}, fmt.Errorf("duplicate operatorId %q", operatorID)
		}

		accessSigning, accessVerificationKeys, err := loadAccessTokenKeys(
			document.Schema, baseDirectory, operatorID, configured,
			legacyAccessPrivate, legacyAccessPublic, keyIDs, accessPublicOwners,
		)
		if err != nil {
			return LoadedOperators{}, fmt.Errorf("%s access token keys: %w", contextName, err)
		}
		// 此构造函数同时验证签名材料、签发方及受众语义，且不会让引导层依赖未导出的验证器。
		if _, err := operator.NewAccessTokenIssuer(accessSigning, operator.AccessTokenIssuerOptions{
			Issuer: document.TokenIssuer, Audience: document.TokenAudience,
		}); err != nil {
			return LoadedOperators{}, fmt.Errorf("%s access token material: %w", contextName, err)
		}

		requestKeys, err := loadVerificationKeys(
			baseDirectory, operatorID, operator.KeyPurposeHTTPRequest,
			configured.OperatorRequestVerificationKeys, keyIDs,
			operatorID+" operator request",
		)
		if err != nil {
			return LoadedOperators{}, fmt.Errorf("%s: %w", contextName, err)
		}
		responseSigning, err := loadSigningKey(
			baseDirectory, operatorID, operator.KeyPurposeHTTPResponse,
			configured.OperatorResponseSigningKey, keyIDs,
			operatorID+" operator response",
		)
		if err != nil {
			return LoadedOperators{}, fmt.Errorf("%s: %w", contextName, err)
		}
		walletURL, err := validateWalletURL(configured.Wallet.BaseURL, options.allowInsecureWalletHTTP)
		if err != nil {
			return LoadedOperators{}, fmt.Errorf("%s wallet: %w", contextName, err)
		}
		walletRequestSigning, err := loadSigningKey(
			baseDirectory, operatorID, operator.KeyPurposeHTTPRequest,
			configured.Wallet.RequestSigningKey, keyIDs,
			operatorID+" wallet request",
		)
		if err != nil {
			return LoadedOperators{}, fmt.Errorf("%s wallet: %w", contextName, err)
		}
		walletResponseKeys, err := loadVerificationKeys(
			baseDirectory, operatorID, operator.KeyPurposeHTTPResponse,
			configured.Wallet.ResponseVerificationKeys, keyIDs,
			operatorID+" wallet response",
		)
		if err != nil {
			return LoadedOperators{}, fmt.Errorf("%s wallet: %w", contextName, err)
		}

		loaded.VerificationKeys = append(loaded.VerificationKeys, accessVerificationKeys...)
		loaded.VerificationKeys = append(loaded.VerificationKeys, requestKeys...)
		loaded.VerificationKeys = append(loaded.VerificationKeys, walletResponseKeys...)
		loaded.Operators[operatorID] = LoadedOperator{
			OperatorID: operatorID, AccessTokenSigningKey: accessSigning,
			OperatorResponseSigningKey: responseSigning,
			Wallet: LoadedWallet{
				BaseURL: walletURL, RequestSigningKey: walletRequestSigning,
				ResponseVerificationKeys: walletResponseKeys,
			},
		}
	}
	if _, err := operator.NewMemoryKeyRing(loaded.VerificationKeys...); err != nil {
		return LoadedOperators{}, fmt.Errorf("construct operator verification key ring: %w", err)
	}
	return loaded, nil
}

func loadAccessTokenKeys(
	schema, baseDirectory, operatorID string,
	configured operatorDocumentEntry,
	legacyPrivate ed25519.PrivateKey,
	legacyPublic ed25519.PublicKey,
	keyIDs map[string]string,
	publicOwners map[string]string,
) (operator.SigningKey, []operator.VerificationKey, error) {
	owner := operatorID + " access token"
	if schema == LegacyOperatorDocumentSchema {
		if configured.AccessTokenSigningKey != (signingKeyDocument{}) ||
			len(configured.AccessTokenVerificationKeys) != 0 {
			return operator.SigningKey{}, nil, errors.New("v1 cannot contain v2 access-token key fields")
		}
		window, err := parseWindow(configured.NotBefore, configured.NotAfter)
		if err != nil {
			return operator.SigningKey{}, nil, err
		}
		if err := reserveKeyID(keyIDs, operator.KeyPurposeAccessToken, configured.AccessTokenKeyID, owner); err != nil {
			return operator.SigningKey{}, nil, err
		}
		signing := operator.SigningKey{
			KeyID: configured.AccessTokenKeyID, OperatorID: operatorID,
			Purpose:    operator.KeyPurposeAccessToken,
			PrivateKey: append(ed25519.PrivateKey(nil), legacyPrivate...),
			NotBefore:  window.notBefore, NotAfter: window.notAfter,
		}
		verification := operator.VerificationKey{
			KeyID: configured.AccessTokenKeyID, OperatorID: operatorID,
			Purpose:   operator.KeyPurposeAccessToken,
			PublicKey: append(ed25519.PublicKey(nil), legacyPublic...),
			NotBefore: window.notBefore, NotAfter: window.notAfter,
		}
		return signing, []operator.VerificationKey{verification}, nil
	}

	if configured.AccessTokenKeyID != "" || configured.NotBefore != "" || configured.NotAfter != "" {
		return operator.SigningKey{}, nil, errors.New("v2 cannot contain legacy access-token key fields")
	}
	signing, err := loadSigningKey(
		baseDirectory, operatorID, operator.KeyPurposeAccessToken,
		configured.AccessTokenSigningKey, keyIDs, owner+" active",
	)
	if err != nil {
		return operator.SigningKey{}, nil, err
	}
	activePublic, ok := signing.PrivateKey.Public().(ed25519.PublicKey)
	if !ok || len(activePublic) != ed25519.PublicKeySize {
		clear(signing.PrivateKey)
		return operator.SigningKey{}, nil, errors.New("active signing key has invalid Ed25519 public key")
	}
	if err := reserveAccessPublicKey(publicOwners, activePublic, owner+" active"); err != nil {
		clear(signing.PrivateKey)
		return operator.SigningKey{}, nil, err
	}
	verification := []operator.VerificationKey{{
		KeyID: signing.KeyID, OperatorID: operatorID,
		Purpose: operator.KeyPurposeAccessToken, PublicKey: append(ed25519.PublicKey(nil), activePublic...),
		NotBefore: signing.NotBefore, NotAfter: signing.NotAfter,
	}}
	if len(configured.AccessTokenVerificationKeys) == 0 {
		return signing, verification, nil
	}
	additional, err := loadVerificationKeys(
		baseDirectory, operatorID, operator.KeyPurposeAccessToken,
		configured.AccessTokenVerificationKeys, keyIDs, owner+" retained verification",
	)
	if err != nil {
		clear(signing.PrivateKey)
		return operator.SigningKey{}, nil, err
	}
	for _, key := range additional {
		if err := reserveAccessPublicKey(publicOwners, key.PublicKey, owner+" retained verification"); err != nil {
			clear(signing.PrivateKey)
			return operator.SigningKey{}, nil, err
		}
	}
	return signing, append(verification, additional...), nil
}

func reserveAccessPublicKey(owners map[string]string, public ed25519.PublicKey, owner string) error {
	identity := string(public)
	if previous, duplicate := owners[identity]; duplicate {
		return fmt.Errorf("access-token public key material is reused (%s and %s)", previous, owner)
	}
	owners[identity] = owner
	return nil
}

type keyWindow struct {
	notBefore time.Time
	notAfter  time.Time
}

func parseWindow(rawNotBefore, rawNotAfter string) (keyWindow, error) {
	notBefore, err := parseKeyTime(rawNotBefore)
	if err != nil {
		return keyWindow{}, fmt.Errorf("invalid notBefore: %w", err)
	}
	notAfter, err := parseKeyTime(rawNotAfter)
	if err != nil {
		return keyWindow{}, fmt.Errorf("invalid notAfter: %w", err)
	}
	if !notAfter.After(notBefore) {
		return keyWindow{}, errors.New("notAfter must be later than notBefore")
	}
	return keyWindow{notBefore: notBefore, notAfter: notAfter}, nil
}

func parseKeyTime(raw string) (time.Time, error) {
	if raw == "" {
		return time.Time{}, errors.New("timestamp is required")
	}
	parsed, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}, errors.New("timestamp must be RFC3339")
	}
	if parsed.Nanosecond() != 0 {
		return time.Time{}, errors.New("timestamp must have whole-second precision")
	}
	return parsed.UTC(), nil
}

func loadVerificationKeys(
	baseDirectory, operatorID string,
	purpose operator.KeyPurpose,
	documents []verificationKeyDocument,
	keyIDs map[string]string,
	owner string,
) ([]operator.VerificationKey, error) {
	if len(documents) == 0 {
		return nil, errors.New("at least one verification key is required")
	}
	result := make([]operator.VerificationKey, 0, len(documents))
	for index, document := range documents {
		window, err := parseWindow(document.NotBefore, document.NotAfter)
		if err != nil {
			return nil, fmt.Errorf("verification key %d: %w", index, err)
		}
		if err := reserveKeyID(keyIDs, purpose, document.KeyID, owner); err != nil {
			return nil, err
		}
		publicKey, err := loadEd25519PublicKey(resolveAssetPath(baseDirectory, document.PublicKeyFile))
		if err != nil {
			return nil, fmt.Errorf("verification key %d: %w", index, err)
		}
		result = append(result, operator.VerificationKey{
			KeyID: document.KeyID, OperatorID: operatorID, Purpose: purpose,
			PublicKey: publicKey, NotBefore: window.notBefore, NotAfter: window.notAfter,
		})
	}
	return result, nil
}

func loadSigningKey(
	baseDirectory, operatorID string,
	purpose operator.KeyPurpose,
	document signingKeyDocument,
	keyIDs map[string]string,
	owner string,
) (operator.SigningKey, error) {
	window, err := parseWindow(document.NotBefore, document.NotAfter)
	if err != nil {
		return operator.SigningKey{}, fmt.Errorf("signing key: %w", err)
	}
	if err := reserveKeyID(keyIDs, purpose, document.KeyID, owner); err != nil {
		return operator.SigningKey{}, err
	}
	privateKey, _, err := loadMatchingEd25519KeyPair(
		resolveAssetPath(baseDirectory, document.PrivateKeyFile),
		resolveAssetPath(baseDirectory, document.PublicKeyFile),
	)
	if err != nil {
		return operator.SigningKey{}, fmt.Errorf("signing key: %w", err)
	}
	return operator.SigningKey{
		KeyID: document.KeyID, OperatorID: operatorID, Purpose: purpose,
		PrivateKey: privateKey, NotBefore: window.notBefore, NotAfter: window.notAfter,
	}, nil
}

func reserveKeyID(keyIDs map[string]string, purpose operator.KeyPurpose, keyID, owner string) error {
	if !identifierPattern.MatchString(keyID) {
		return fmt.Errorf("%s has invalid keyId", owner)
	}
	identity := string(purpose) + "\x00" + keyID
	if previous, duplicate := keyIDs[identity]; duplicate {
		return fmt.Errorf("duplicate keyId %q for purpose %s (%s and %s)", keyID, purpose, previous, owner)
	}
	keyIDs[identity] = owner
	return nil
}

func resolveAssetPath(baseDirectory, configuredPath string) string {
	if configuredPath == "" || filepath.IsAbs(configuredPath) {
		return configuredPath
	}
	return filepath.Join(baseDirectory, configuredPath)
}

func validateWalletURL(raw string, allowInsecureDevelopment bool) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.Hostname() == "" || parsed.User != nil ||
		parsed.Opaque != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.ForceQuery {
		return "", errors.New("baseUrl must be an absolute URL without credentials, query, or fragment")
	}
	if parsed.Scheme != "https" && !(allowInsecureDevelopment && parsed.Scheme == "http") {
		return "", errors.New("baseUrl must use HTTPS")
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

func validTextClaim(value string, maximum int) bool {
	if value == "" || len(value) > maximum {
		return false
	}
	for _, character := range value {
		if character <= 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}
