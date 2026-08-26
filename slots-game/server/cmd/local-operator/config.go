package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"slots-game/server/internal/operator"
)

const keyDocumentSchema = "local-operator-keys-v1"

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

type keyDocument struct {
	Schema                        string                    `json:"schema"`
	OperatorID                    string                    `json:"operatorId"`
	WalletRequestVerificationKeys []verificationKeyDocument `json:"walletRequestVerificationKeys"`
	WalletResponseSigningKey      signingKeyDocument        `json:"walletResponseSigningKey"`
	LaunchRequestSigningKey       signingKeyDocument        `json:"launchRequestSigningKey"`
	RGSResponseVerificationKeys   []verificationKeyDocument `json:"rgsResponseVerificationKeys"`
}

type loadedKeys struct {
	OperatorID                    string
	WalletRequestVerificationKeys []operator.VerificationKey
	WalletResponseSigningKey      operator.SigningKey
	LaunchRequestSigningKey       operator.SigningKey
	RGSResponseVerificationKeys   []operator.VerificationKey
}

type runtimeConfig struct {
	ListenAddress          string
	TLSCertificateFile     string
	TLSPrivateKeyFile      string
	DatabaseURLFile        string
	RuntimeDatabaseRole    string
	KeyDocumentFile        string
	RGSBaseURL             string
	RGSRootCAFile          string
	WebBaseURL             string
	AdminTokenFile         string
	MetricsTokenFile       string
	AlertmanagerTokenFile  string
	AlertFile              string
	AuditKeyID             string
	AuditHMACKeyFile       string
	AuditBearerTokenFile   string
	AuditFile              string
	LogBearerTokenFile     string
	LogFile                string
	BackupStatusFile       string
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
	AllowLegacyWalletV1    bool
	ShutdownTimeout        time.Duration
	RequestTimeout         time.Duration
}

type loadedRuntime struct {
	Config            runtimeConfig
	Keys              loadedKeys
	DatabaseURL       string
	AdminToken        []byte
	MetricsToken      []byte
	AlertmanagerToken []byte
	AuditHMACKey      []byte
	AuditBearerToken  []byte
	LogBearerToken    []byte
	RGSClient         *http.Client
}

func loadRuntimeConfig(getenv func(string) string) (loadedRuntime, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	config := runtimeConfig{
		ListenAddress:          valueOrDefault(getenv("LOCAL_OPERATOR_LISTEN_ADDRESS"), ":8443"),
		TLSCertificateFile:     getenv("LOCAL_OPERATOR_TLS_CERT_FILE"),
		TLSPrivateKeyFile:      getenv("LOCAL_OPERATOR_TLS_KEY_FILE"),
		DatabaseURLFile:        getenv("LOCAL_OPERATOR_DATABASE_URL_FILE"),
		RuntimeDatabaseRole:    valueOrDefault(getenv("LOCAL_OPERATOR_RUNTIME_DATABASE_ROLE"), "local_operator_runtime"),
		KeyDocumentFile:        getenv("LOCAL_OPERATOR_KEY_DOCUMENT_FILE"),
		RGSBaseURL:             getenv("LOCAL_OPERATOR_RGS_BASE_URL"),
		RGSRootCAFile:          getenv("LOCAL_OPERATOR_RGS_ROOT_CA_FILE"),
		WebBaseURL:             getenv("LOCAL_OPERATOR_WEB_BASE_URL"),
		AdminTokenFile:         getenv("LOCAL_OPERATOR_ADMIN_TOKEN_FILE"),
		MetricsTokenFile:       getenv("LOCAL_OPERATOR_METRICS_TOKEN_FILE"),
		AlertmanagerTokenFile:  getenv("LOCAL_OPERATOR_ALERTMANAGER_TOKEN_FILE"),
		AlertFile:              getenv("LOCAL_OPERATOR_ALERT_FILE"),
		AuditKeyID:             getenv("LOCAL_OPERATOR_AUDIT_HMAC_KEY_ID"),
		AuditHMACKeyFile:       getenv("LOCAL_OPERATOR_AUDIT_HMAC_KEY_FILE"),
		AuditBearerTokenFile:   getenv("LOCAL_OPERATOR_AUDIT_BEARER_TOKEN_FILE"),
		AuditFile:              getenv("LOCAL_OPERATOR_AUDIT_FILE"),
		LogBearerTokenFile:     getenv("LOCAL_OPERATOR_LOG_BEARER_TOKEN_FILE"),
		LogFile:                getenv("LOCAL_OPERATOR_LOG_FILE"),
		BackupStatusFile:       getenv("LOCAL_OPERATOR_BACKUP_STATUS_FILE"),
		GameID:                 getenv("LOCAL_OPERATOR_GAME_ID"),
		DefinitionVersion:      getenv("LOCAL_OPERATOR_DEFINITION_VERSION"),
		DefinitionHash:         getenv("LOCAL_OPERATOR_DEFINITION_HASH"),
		Currency:               valueOrDefault(getenv("LOCAL_OPERATOR_CURRENCY"), "CNY"),
		Jurisdiction:           valueOrDefault(getenv("LOCAL_OPERATOR_JURISDICTION"), "CN-LOCAL"),
		DefaultPlayerID:        valueOrDefault(getenv("LOCAL_OPERATOR_DEFAULT_PLAYER_ID"), "local-player"),
		DefaultWalletAccountID: valueOrDefault(getenv("LOCAL_OPERATOR_DEFAULT_WALLET_ACCOUNT_ID"), "local-wallet"),
	}
	var err error
	if config.AllowLegacyWalletV1, err = parseStrictBool(
		getenv("LOCAL_OPERATOR_ALLOW_LEGACY_WALLET_V1"), false,
	); err != nil {
		return loadedRuntime{}, err
	}
	if config.CurrencyExponent, err = parseBoundedInt(getenv("LOCAL_OPERATOR_CURRENCY_EXPONENT"), 2, 0, 6); err != nil {
		return loadedRuntime{}, err
	}
	if config.InitialBalanceMinor, err = parseBoundedInt64(getenv("LOCAL_OPERATOR_INITIAL_BALANCE_MINOR"), 100_000, 0, 9_000_000_000_000_000); err != nil {
		return loadedRuntime{}, err
	}
	if config.SessionTTL, err = parseDuration(getenv("LOCAL_OPERATOR_SESSION_TTL"), 8*time.Hour, time.Minute, 24*time.Hour); err != nil {
		return loadedRuntime{}, err
	}
	if config.IdleDisconnect, err = parseDuration(
		getenv("LOCAL_OPERATOR_IDLE_DISCONNECT"), 20*time.Minute, time.Second, 24*time.Hour,
	); err != nil {
		return loadedRuntime{}, err
	}
	if config.ShutdownTimeout, err = parseDuration(getenv("LOCAL_OPERATOR_SHUTDOWN_TIMEOUT"), 20*time.Second, time.Second, time.Minute); err != nil {
		return loadedRuntime{}, err
	}
	if config.RequestTimeout, err = parseDuration(getenv("LOCAL_OPERATOR_REQUEST_TIMEOUT"), 12*time.Second, time.Second, time.Minute); err != nil {
		return loadedRuntime{}, err
	}
	if err := validateRuntimeConfig(config); err != nil {
		return loadedRuntime{}, err
	}
	databaseURLBytes, err := readSecretFile(config.DatabaseURLFile, 4<<10)
	if err != nil {
		return loadedRuntime{}, fmt.Errorf("load database URL: %w", err)
	}
	databaseURL := string(databaseURLBytes)
	clear(databaseURLBytes)
	if err := validateProductionDatabaseURL(databaseURL); err != nil {
		return loadedRuntime{}, err
	}
	keys, err := loadKeyDocument(config.KeyDocumentFile)
	if err != nil {
		return loadedRuntime{}, err
	}
	adminToken, err := readTokenFile(config.AdminTokenFile)
	if err != nil {
		return loadedRuntime{}, fmt.Errorf("load admin token: %w", err)
	}
	metricsToken, err := readTokenFile(config.MetricsTokenFile)
	if err != nil {
		return loadedRuntime{}, fmt.Errorf("load metrics token: %w", err)
	}
	alertToken, err := readTokenFile(config.AlertmanagerTokenFile)
	if err != nil {
		return loadedRuntime{}, fmt.Errorf("load Alertmanager token: %w", err)
	}
	auditKey, err := readCanonicalBase64Key(config.AuditHMACKeyFile)
	if err != nil {
		return loadedRuntime{}, fmt.Errorf("load audit HMAC key: %w", err)
	}
	auditToken, err := readTokenFile(config.AuditBearerTokenFile)
	if err != nil {
		return loadedRuntime{}, fmt.Errorf("load audit bearer: %w", err)
	}
	logToken, err := readTokenFile(config.LogBearerTokenFile)
	if err != nil {
		return loadedRuntime{}, fmt.Errorf("load log bearer: %w", err)
	}
	rgsClient, err := secureHTTPClient(config.RGSRootCAFile, config.RequestTimeout)
	if err != nil {
		return loadedRuntime{}, err
	}
	return loadedRuntime{
		Config: config, Keys: keys, DatabaseURL: databaseURL,
		AdminToken: adminToken, MetricsToken: metricsToken, AlertmanagerToken: alertToken,
		AuditHMACKey: auditKey, AuditBearerToken: auditToken, LogBearerToken: logToken,
		RGSClient: rgsClient,
	}, nil
}

func loadDatabaseURL(path string) (string, error) {
	encoded, err := readSecretFile(path, 4<<10)
	if err != nil {
		return "", err
	}
	defer clear(encoded)
	return string(encoded), nil
}

func validateProductionDatabaseURL(databaseURL string) error {
	parsed, err := url.Parse(databaseURL)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") ||
		parsed.Host == "" || parsed.User == nil || parsed.Fragment != "" {
		return errors.New("database URL must be an authenticated PostgreSQL URI")
	}
	query := parsed.Query()
	if values := query["sslmode"]; len(values) != 1 || values[0] != "verify-full" {
		return errors.New("database URL requires sslmode=verify-full")
	}
	if values := query["sslrootcert"]; len(values) != 1 || values[0] == "" || !filepath.IsAbs(values[0]) {
		return errors.New("database URL requires an absolute sslrootcert path")
	}
	return nil
}

func validateRuntimeConfig(config runtimeConfig) error {
	requiredPaths := []string{
		config.TLSCertificateFile, config.TLSPrivateKeyFile, config.DatabaseURLFile,
		config.KeyDocumentFile, config.RGSRootCAFile, config.AdminTokenFile,
		config.MetricsTokenFile, config.AlertmanagerTokenFile, config.AuditHMACKeyFile,
		config.AlertFile, config.AuditBearerTokenFile, config.AuditFile,
		config.LogBearerTokenFile, config.LogFile, config.BackupStatusFile,
	}
	for _, value := range requiredPaths {
		if value == "" || !filepath.IsAbs(value) {
			return errors.New("local operator requires absolute deployment file paths")
		}
	}
	if host, port, err := net.SplitHostPort(config.ListenAddress); err != nil || port == "" || strings.Contains(host, "/") {
		return errors.New("invalid local operator listen address")
	}
	if !allIdentifiers(config.GameID, config.DefinitionVersion, config.DefaultPlayerID, config.DefaultWalletAccountID) ||
		!digestPattern.MatchString(config.DefinitionHash) || !currencyPattern.MatchString(config.Currency) ||
		!jurisdictionPattern.MatchString(config.Jurisdiction) || !allIdentifiers(config.AuditKeyID) ||
		!databaseRolePattern.MatchString(config.RuntimeDatabaseRole) {
		return errors.New("invalid local operator deployment identity")
	}
	for name, raw := range map[string]string{"RGS": config.RGSBaseURL, "web": config.WebBaseURL} {
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil ||
			parsed.RawQuery != "" || parsed.Fragment != "" {
			return fmt.Errorf("%s base URL must be credential-free HTTPS", name)
		}
	}
	return nil
}

func loadKeyDocument(path string) (loadedKeys, error) {
	encoded, err := readRegularFile(path, 256<<10, false)
	if err != nil {
		return loadedKeys{}, fmt.Errorf("read local operator key document: %w", err)
	}
	var document keyDocument
	if err := decodeStrictJSON(encoded, &document); err != nil || document.Schema != keyDocumentSchema ||
		!allIdentifiers(document.OperatorID) || len(document.WalletRequestVerificationKeys) == 0 ||
		len(document.RGSResponseVerificationKeys) == 0 {
		return loadedKeys{}, errors.New("invalid local operator key document")
	}
	directory := filepath.Dir(path)
	walletRequests, err := loadVerificationKeys(directory, document.OperatorID, operator.KeyPurposeHTTPRequest, document.WalletRequestVerificationKeys)
	if err != nil {
		return loadedKeys{}, fmt.Errorf("load wallet request keys: %w", err)
	}
	walletResponse, err := loadSigningKey(directory, document.OperatorID, operator.KeyPurposeHTTPResponse, document.WalletResponseSigningKey)
	if err != nil {
		return loadedKeys{}, fmt.Errorf("load wallet response key: %w", err)
	}
	launchRequest, err := loadSigningKey(directory, document.OperatorID, operator.KeyPurposeHTTPRequest, document.LaunchRequestSigningKey)
	if err != nil {
		return loadedKeys{}, fmt.Errorf("load launch request key: %w", err)
	}
	rgsResponses, err := loadVerificationKeys(directory, document.OperatorID, operator.KeyPurposeHTTPResponse, document.RGSResponseVerificationKeys)
	if err != nil {
		return loadedKeys{}, fmt.Errorf("load RGS response keys: %w", err)
	}
	return loadedKeys{
		OperatorID: document.OperatorID, WalletRequestVerificationKeys: walletRequests,
		WalletResponseSigningKey: walletResponse, LaunchRequestSigningKey: launchRequest,
		RGSResponseVerificationKeys: rgsResponses,
	}, nil
}

func loadVerificationKeys(directory, operatorID string, purpose operator.KeyPurpose, documents []verificationKeyDocument) ([]operator.VerificationKey, error) {
	result := make([]operator.VerificationKey, 0, len(documents))
	seen := make(map[string]struct{})
	for _, document := range documents {
		if _, duplicate := seen[document.KeyID]; duplicate {
			return nil, errors.New("duplicate verification key ID")
		}
		seen[document.KeyID] = struct{}{}
		notBefore, notAfter, err := keyWindow(document.KeyID, document.NotBefore, document.NotAfter)
		if err != nil {
			return nil, err
		}
		publicKey, err := readPublicKey(resolvePath(directory, document.PublicKeyFile))
		if err != nil {
			return nil, err
		}
		result = append(result, operator.VerificationKey{
			KeyID: document.KeyID, OperatorID: operatorID, Purpose: purpose,
			PublicKey: publicKey, NotBefore: notBefore, NotAfter: notAfter,
		})
	}
	if _, err := operator.NewMemoryKeyRing(result...); err != nil {
		return nil, err
	}
	return result, nil
}

func loadSigningKey(directory, operatorID string, purpose operator.KeyPurpose, document signingKeyDocument) (operator.SigningKey, error) {
	notBefore, notAfter, err := keyWindow(document.KeyID, document.NotBefore, document.NotAfter)
	if err != nil {
		return operator.SigningKey{}, err
	}
	privateKey, err := readPrivateKey(resolvePath(directory, document.PrivateKeyFile))
	if err != nil {
		return operator.SigningKey{}, err
	}
	publicKey, err := readPublicKey(resolvePath(directory, document.PublicKeyFile))
	if err != nil {
		clear(privateKey)
		return operator.SigningKey{}, err
	}
	derived := privateKey.Public().(ed25519.PublicKey)
	if subtleCompare(derived, publicKey) == 0 {
		clear(privateKey)
		return operator.SigningKey{}, errors.New("Ed25519 signing key pair does not match")
	}
	key := operator.SigningKey{
		KeyID: document.KeyID, OperatorID: operatorID, Purpose: purpose,
		PrivateKey: privateKey, NotBefore: notBefore, NotAfter: notAfter,
	}
	// 启动时执行一次真实签名，确保私钥当前有效且至少覆盖一个完整响应窗口。
	now := time.Now().UTC().Truncate(time.Second)
	if purpose == operator.KeyPurposeHTTPResponse {
		response := &http.Response{StatusCode: http.StatusNoContent, Header: make(http.Header)}
		if err := operator.SignResponse(response, nil, key, operator.ResponseSignatureParams{
			RequestID: "startup-key-check", Created: now, Expires: now.Add(time.Minute),
		}); err != nil {
			clear(privateKey)
			return operator.SigningKey{}, err
		}
	} else {
		request, _ := http.NewRequest(http.MethodPost, "https://startup.invalid/key-check", bytes.NewReader([]byte("{}")))
		if err := operator.SignRequest(request, []byte("{}"), key, operator.RequestSignatureParams{
			RequestID: "startup-key-check", IdempotencyKey: "startup-key-check",
			Nonce: "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB", Created: now, Expires: now.Add(time.Minute),
		}); err != nil {
			clear(privateKey)
			return operator.SigningKey{}, err
		}
	}
	return key, nil
}

func keyWindow(keyID, from, until string) (time.Time, time.Time, error) {
	if !allIdentifiers(keyID) {
		return time.Time{}, time.Time{}, errors.New("invalid key ID")
	}
	notBefore, err := time.Parse(time.RFC3339, from)
	if err != nil {
		return time.Time{}, time.Time{}, errors.New("invalid key notBefore")
	}
	notAfter, err := time.Parse(time.RFC3339, until)
	if err != nil || !notAfter.After(notBefore) {
		return time.Time{}, time.Time{}, errors.New("invalid key notAfter")
	}
	return notBefore, notAfter, nil
}

func readPrivateKey(path string) (ed25519.PrivateKey, error) {
	encoded, err := readRegularFile(path, 16<<10, true)
	if err != nil {
		return nil, err
	}
	defer clear(encoded)
	block, trailing := pem.Decode(encoded)
	if block == nil || len(bytes.TrimSpace(trailing)) != 0 || block.Type != "PRIVATE KEY" {
		return nil, errors.New("invalid PKCS#8 private key PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	key, ok := parsed.(ed25519.PrivateKey)
	if err != nil || !ok || len(key) != ed25519.PrivateKeySize {
		return nil, errors.New("private key is not Ed25519")
	}
	return append(ed25519.PrivateKey(nil), key...), nil
}

func readPublicKey(path string) (ed25519.PublicKey, error) {
	encoded, err := readRegularFile(path, 16<<10, false)
	if err != nil {
		return nil, err
	}
	block, trailing := pem.Decode(encoded)
	if block == nil || len(bytes.TrimSpace(trailing)) != 0 || block.Type != "PUBLIC KEY" {
		return nil, errors.New("invalid PKIX public key PEM")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	key, ok := parsed.(ed25519.PublicKey)
	if err != nil || !ok || len(key) != ed25519.PublicKeySize {
		return nil, errors.New("public key is not Ed25519")
	}
	return append(ed25519.PublicKey(nil), key...), nil
}

func readCanonicalBase64Key(path string) ([]byte, error) {
	encoded, err := readSecretFile(path, 128)
	if err != nil {
		return nil, err
	}
	defer clear(encoded)
	decoded, err := base64.StdEncoding.DecodeString(string(encoded))
	if err != nil || len(decoded) != sha256.Size || base64.StdEncoding.EncodeToString(decoded) != string(encoded) {
		clear(decoded)
		return nil, errors.New("key must be canonical base64 for exactly 32 bytes")
	}
	return decoded, nil
}

func readTokenFile(path string) ([]byte, error) {
	token, err := readSecretFile(path, 4<<10)
	if err != nil {
		return nil, err
	}
	if len(token) < 16 || bytes.ContainsAny(token, " \t\r\n") {
		clear(token)
		return nil, errors.New("token must contain at least 16 non-whitespace bytes")
	}
	return token, nil
}

func readSecretFile(path string, maximum int64) ([]byte, error) {
	encoded, err := readRegularFile(path, maximum, true)
	if err != nil {
		return nil, err
	}
	encoded = bytes.TrimSuffix(encoded, []byte("\n"))
	if len(encoded) == 0 || bytes.ContainsAny(encoded, "\r\n") {
		clear(encoded)
		return nil, errors.New("secret file is empty or contains multiple lines")
	}
	return encoded, nil
}

func readRegularFile(path string, maximum int64, secret bool) ([]byte, error) {
	if path == "" || !filepath.IsAbs(path) {
		return nil, errors.New("absolute file path is required")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("configuration file must be regular")
	}
	if secret && info.Mode().Perm()&0o137 != 0 {
		return nil, fmt.Errorf("secret file permissions %04o are too broad", info.Mode().Perm())
	}
	encoded, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil || int64(len(encoded)) > maximum {
		return nil, errors.New("configuration file exceeds size limit")
	}
	return encoded, nil
}

func resolvePath(directory, configured string) string {
	if filepath.IsAbs(configured) {
		return configured
	}
	return filepath.Join(directory, configured)
}

func secureHTTPClient(rootCAFile string, timeout time.Duration) (*http.Client, error) {
	rootPEM, err := readRegularFile(rootCAFile, 1<<20, false)
	if err != nil {
		return nil, fmt.Errorf("load RGS root CA: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(rootPEM) {
		return nil, errors.New("RGS root CA contains no certificates")
	}
	transport := &http.Transport{
		Proxy:             http.ProxyFromEnvironment,
		DialContext:       (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig:   &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots},
		ForceAttemptHTTP2: true, DisableCompression: true, MaxConnsPerHost: 16,
		MaxIdleConns: 32, MaxIdleConnsPerHost: 8, IdleConnTimeout: 60 * time.Second,
		TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: timeout,
		MaxResponseHeaderBytes: 32 << 10,
	}
	return &http.Client{
		Timeout: timeout, Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirects are disabled") },
	}, nil
}

func valueOrDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func parseBoundedInt(value string, fallback, minimum, maximum int) (int, error) {
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < minimum || parsed > maximum {
		return 0, errors.New("integer environment value is out of range")
	}
	return parsed, nil
}

func parseBoundedInt64(value string, fallback, minimum, maximum int64) (int64, error) {
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || strconv.FormatInt(parsed, 10) != value || parsed < minimum || parsed > maximum {
		return 0, errors.New("int64 environment value is out of range")
	}
	return parsed, nil
}

func parseDuration(value string, fallback, minimum, maximum time.Duration) (time.Duration, error) {
	if value == "" {
		return fallback, nil
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed < minimum || parsed > maximum {
		return 0, errors.New("duration environment value is out of range")
	}
	return parsed, nil
}

func parseStrictBool(value string, fallback bool) (bool, error) {
	if value == "" {
		return fallback, nil
	}
	switch value {
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, errors.New("boolean environment value must be true or false")
	}
}

func subtleCompare(left, right []byte) int {
	if len(left) != len(right) {
		return 0
	}
	var difference byte
	for index := range left {
		difference |= left[index] ^ right[index]
	}
	if difference == 0 {
		return 1
	}
	return 0
}
