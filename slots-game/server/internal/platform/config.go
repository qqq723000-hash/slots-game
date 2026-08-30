package platform

import (
	"errors"
	"fmt"
	"math"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Environment string

const (
	Development Environment = "development"
	Staging     Environment = "staging"
	Production  Environment = "production"
)

type RuntimeRole string

const (
	RuntimeRoleCombined RuntimeRole = "combined"
	RuntimeRoleAPI      RuntimeRole = "api"
	RuntimeRoleWorker   RuntimeRole = "worker"
)

func (role RuntimeRole) ServesPublicAPI() bool {
	return role == RuntimeRoleCombined || role == RuntimeRoleAPI
}

func (role RuntimeRole) RunsBackgroundWorkloads() bool {
	return role == RuntimeRoleCombined || role == RuntimeRoleWorker
}

type Config struct {
	Environment                     Environment
	RuntimeRole                     RuntimeRole
	HTTPAddress                     string
	OperationsHTTPAddress           string
	OperationsBearerTokenFile       string
	PublicBaseURL                   string
	DatabaseURL                     string
	AllowedOrigins                  []string
	TLSTerminatedUpstream           bool
	TLSCertFile                     string
	TLSKeyFile                      string
	OperatorConfigFile              string
	DefinitionFile                  string
	DefinitionApprovalFile          string
	DefinitionApprovalPublicKeyFile string
	ExpectedDefinitionGameID        string
	ExpectedDefinitionVersion       string
	ExpectedDefinitionSHA256        string
	// AccessPrivateKeyFile 与 AccessPublicKeyFile 仅支持已弃用的 rgs-operators-v1 迁移路径。
	// 生产环境必须使用 rgs-operators-v2 中逐运营商配置的路径，且绝不读取这些全局密钥设置。
	// English: AccessPrivateKeyFile and AccessPublicKeyFile only support the deprecated rgs-operators-v1 migration
	// path. Production environments must use the per-operator configured paths in rgs-operators-v2 and never read
	// these global key settings.
	AccessPrivateKeyFile             string
	AccessPublicKeyFile              string
	LaunchHMACKeyFile                string
	ReadHeaderTimeout                time.Duration
	ReadTimeout                      time.Duration
	RequestTimeout                   time.Duration
	WriteTimeout                     time.Duration
	IdleTimeout                      time.Duration
	ShutdownTimeout                  time.Duration
	DatabaseStatementTimeout         time.Duration
	DatabaseLockTimeout              time.Duration
	DatabaseMaxOpenConns             int
	DatabaseMaxIdleConns             int
	DatabaseCriticalReserveConns     int
	WalletTimeout                    time.Duration
	WalletFastPathTimeout            time.Duration
	WalletRootCAFile                 string
	WalletMaxAttempts                int
	HighValueRiskEnabled             bool
	HighValueRiskThresholdMinor      int64
	HighValueRiskPolicyVersion       string
	HighValueRiskReviewTTL           time.Duration
	HighValueRiskExpiryPolicy        string
	HighValueRiskExpiryBatchSize     int
	LaunchTTL                        time.Duration
	AccessTokenTTL                   time.Duration
	SessionIdleDisconnectMin         time.Duration
	SessionIdleDisconnectMax         time.Duration
	MaxRequestBytes                  int64
	MaxInFlightRequests              int
	MaxCryptoInFlight                int
	MaxConnectionsPerListener        int
	RatePerSecond                    float64
	RateBurst                        int
	PreAuthRatePerSecond             float64
	PreAuthRateBurst                 int
	SuccessAccessLogSamplePerMillion int
	TraceEndpoint                    string
	TraceSampleRatio                 float64
	TraceBatchTimeout                time.Duration
	TraceExportTimeout               time.Duration
	TraceShutdownTimeout             time.Duration
	TraceMaxQueueSize                int
	TraceMaxExportBatchSize          int
	SharedAdmissionURL               string
	SharedAdmissionUsername          string
	SharedAdmissionPasswordFile      string
	SharedAdmissionHMACKeyFile       string
	SharedAdmissionRootCAFile        string
	SharedAdmissionTimeout           time.Duration
	SharedAdmissionRatePerSecond     float64
	SharedAdmissionRateBurst         int
	EconomicOperatorRatePerSecond    float64
	EconomicOperatorRateBurst        int
	EconomicBackendRatePerSecond     float64
	EconomicBackendRateBurst         int
	OutboxEndpointURL                string
	OutboxHMACKeyID                  string
	OutboxHMACKeyFile                string
	OutboxBearerTokenFile            string
	OutboxRootCAFile                 string
	OutboxClientCertFile             string
	OutboxClientKeyFile              string
	OutboxOwner                      string
	OutboxInterval                   time.Duration
	OutboxLeaseDuration              time.Duration
	OutboxPublishTimeout             time.Duration
	OutboxWorkerMaxStaleness         time.Duration
	OutboxBacklogMaxAge              time.Duration
	OutboxInitialBackoff             time.Duration
	OutboxMaximumBackoff             time.Duration
	OutboxBatchSize                  int
	OutboxMaxParallel                int
}

type EnvLookup func(string) (string, bool)

func LoadConfig() (Config, error) {
	return LoadConfigFrom(os.LookupEnv)
}

func LoadConfigFrom(lookup EnvLookup) (Config, error) {
	config := Config{
		Environment:                  Development,
		RuntimeRole:                  RuntimeRoleCombined,
		HTTPAddress:                  ":8080",
		OperationsHTTPAddress:        "127.0.0.1:8081",
		PublicBaseURL:                "http://localhost:8080",
		ReadHeaderTimeout:            5 * time.Second,
		ReadTimeout:                  15 * time.Second,
		RequestTimeout:               15 * time.Second,
		WriteTimeout:                 20 * time.Second,
		IdleTimeout:                  60 * time.Second,
		ShutdownTimeout:              20 * time.Second,
		DatabaseStatementTimeout:     10 * time.Second,
		DatabaseLockTimeout:          2 * time.Second,
		DatabaseMaxOpenConns:         40,
		DatabaseMaxIdleConns:         10,
		DatabaseCriticalReserveConns: 5,
		WalletTimeout:                4 * time.Second,
		WalletFastPathTimeout:        time.Second,
		WalletMaxAttempts:            100,
		LaunchTTL:                    2 * time.Minute,
		AccessTokenTTL:               15 * time.Minute,
		SessionIdleDisconnectMin:     time.Minute,
		SessionIdleDisconnectMax:     24 * time.Hour,
		// AWS WAF/ALB 的受检正文窗口为 8 KiB。RGS 公网请求的最大合法字段即使采用
		// 最坏的 JSON Unicode 转义也小于该值，因此应用边界不得接受 WAF 未完整检查的尾部。
		// English: AWS WAF/ALB has an inspected body window of 8 KiB. The maximum legal field of an RGS public network
		// request is smaller than this value even with the worst JSON Unicode escape, so application boundaries must not
		// accept tails that are not fully inspected by WAF.
		MaxRequestBytes:                  8 << 10,
		MaxInFlightRequests:              256,
		MaxCryptoInFlight:                64,
		MaxConnectionsPerListener:        1_024,
		RatePerSecond:                    20,
		RateBurst:                        40,
		PreAuthRatePerSecond:             5_000,
		PreAuthRateBurst:                 10_000,
		SuccessAccessLogSamplePerMillion: 1_000_000,
		// 只有显式配置 endpoint 才启用 tracing；启用后的资源与时间预算保持明确且有界。
		// English: Tracing is enabled only if the endpoint is explicitly configured; resource and time budgets when
		// enabled remain explicit and bounded.
		TraceSampleRatio:             0.01,
		TraceBatchTimeout:            time.Second,
		TraceExportTimeout:           3 * time.Second,
		TraceShutdownTimeout:         5 * time.Second,
		TraceMaxQueueSize:            1_024,
		TraceMaxExportBatchSize:      256,
		SharedAdmissionTimeout:       100 * time.Millisecond,
		SharedAdmissionRatePerSecond: 20,
		SharedAdmissionRateBurst:     40,
		// EDoS 默认值是 RGS 自身的保守成本护栏，不代表任何第三方钱包合同配额。
		// 生产部署必须按供应商容量证据审定 Chart 中的显式值。
		// English: The EDoS default is RGS's own conservative cost guardrail and does not represent any third-party wallet
		// contract quota. Production deployments must validate the explicit value in the Chart with evidence of vendor
		// capacity.
		EconomicOperatorRatePerSecond: 20,
		EconomicOperatorRateBurst:     40,
		EconomicBackendRatePerSecond:  100,
		EconomicBackendRateBurst:      200,
		OutboxInterval:                time.Second,
		OutboxLeaseDuration:           3 * time.Minute,
		OutboxPublishTimeout:          10 * time.Second,
		OutboxWorkerMaxStaleness:      4 * time.Minute,
		OutboxBacklogMaxAge:           5 * time.Minute,
		OutboxInitialBackoff:          time.Second,
		OutboxMaximumBackoff:          5 * time.Minute,
		OutboxBatchSize:               100,
		OutboxMaxParallel:             8,
	}
	// 这些旧变量按未认证 method/path 分配公网或密码学恢复预留。path 可被任意
	// 调用方伪造，静默忽略会让运维人员误以为合法恢复仍受保护，因此显式失败启动。
	// English: These legacy variables are assigned public network or cryptographic recovery reservations by
	// unauthenticated method/path. The path can be forged by any caller. Silently ignoring it will make the operation
	// and maintenance personnel mistakenly think that legal recovery is still protected, so the startup fails
	// explicitly.
	for _, deprecated := range []string{
		"RGS_RECOVERY_IN_FLIGHT_RESERVE",
		"RGS_CRYPTO_RECOVERY_RESERVE",
	} {
		if _, configured := lookup(deprecated); configured {
			return Config{}, fmt.Errorf("%s is removed: unauthenticated paths cannot authorize recovery capacity", deprecated)
		}
	}
	if value, ok := lookup("RGS_ENVIRONMENT"); ok {
		config.Environment = Environment(strings.ToLower(strings.TrimSpace(value)))
	}
	if value, ok := lookup("RGS_RUNTIME_ROLE"); ok {
		config.RuntimeRole = RuntimeRole(strings.ToLower(strings.TrimSpace(value)))
	}
	assignString(lookup, "RGS_HTTP_ADDR", &config.HTTPAddress)
	assignString(lookup, "RGS_OPERATIONS_HTTP_ADDR", &config.OperationsHTTPAddress)
	assignString(lookup, "RGS_OPERATIONS_BEARER_TOKEN_FILE", &config.OperationsBearerTokenFile)
	assignString(lookup, "RGS_PUBLIC_BASE_URL", &config.PublicBaseURL)
	assignString(lookup, "RGS_DATABASE_URL", &config.DatabaseURL)
	assignString(lookup, "RGS_TLS_CERT_FILE", &config.TLSCertFile)
	assignString(lookup, "RGS_TLS_KEY_FILE", &config.TLSKeyFile)
	assignString(lookup, "RGS_OPERATOR_CONFIG_FILE", &config.OperatorConfigFile)
	assignString(lookup, "RGS_DEFINITION_FILE", &config.DefinitionFile)
	assignString(lookup, "RGS_DEFINITION_APPROVAL_FILE", &config.DefinitionApprovalFile)
	assignString(lookup, "RGS_DEFINITION_APPROVAL_PUBLIC_KEY_FILE", &config.DefinitionApprovalPublicKeyFile)
	assignString(lookup, "RGS_EXPECTED_DEFINITION_GAME_ID", &config.ExpectedDefinitionGameID)
	assignString(lookup, "RGS_EXPECTED_DEFINITION_VERSION", &config.ExpectedDefinitionVersion)
	assignString(lookup, "RGS_EXPECTED_DEFINITION_SHA256", &config.ExpectedDefinitionSHA256)
	assignString(lookup, "RGS_ACCESS_PRIVATE_KEY_FILE", &config.AccessPrivateKeyFile)
	assignString(lookup, "RGS_ACCESS_PUBLIC_KEY_FILE", &config.AccessPublicKeyFile)
	assignString(lookup, "RGS_LAUNCH_HMAC_KEY_FILE", &config.LaunchHMACKeyFile)
	assignString(lookup, "RGS_OTEL_TRACES_ENDPOINT", &config.TraceEndpoint)
	assignString(lookup, "RGS_SHARED_ADMISSION_URL", &config.SharedAdmissionURL)
	assignString(lookup, "RGS_SHARED_ADMISSION_USERNAME", &config.SharedAdmissionUsername)
	assignString(lookup, "RGS_SHARED_ADMISSION_PASSWORD_FILE", &config.SharedAdmissionPasswordFile)
	assignString(lookup, "RGS_SHARED_ADMISSION_HMAC_KEY_FILE", &config.SharedAdmissionHMACKeyFile)
	assignString(lookup, "RGS_SHARED_ADMISSION_ROOT_CA_FILE", &config.SharedAdmissionRootCAFile)
	assignString(lookup, "RGS_WALLET_ROOT_CA_FILE", &config.WalletRootCAFile)
	assignString(lookup, "RGS_HIGH_VALUE_RISK_POLICY_VERSION", &config.HighValueRiskPolicyVersion)
	assignString(lookup, "RGS_HIGH_VALUE_RISK_EXPIRY_POLICY", &config.HighValueRiskExpiryPolicy)
	assignString(lookup, "RGS_OUTBOX_ENDPOINT_URL", &config.OutboxEndpointURL)
	assignString(lookup, "RGS_OUTBOX_HMAC_KEY_ID", &config.OutboxHMACKeyID)
	assignString(lookup, "RGS_OUTBOX_HMAC_KEY_FILE", &config.OutboxHMACKeyFile)
	assignString(lookup, "RGS_OUTBOX_BEARER_TOKEN_FILE", &config.OutboxBearerTokenFile)
	assignString(lookup, "RGS_OUTBOX_ROOT_CA_FILE", &config.OutboxRootCAFile)
	assignString(lookup, "RGS_OUTBOX_CLIENT_CERT_FILE", &config.OutboxClientCertFile)
	assignString(lookup, "RGS_OUTBOX_CLIENT_KEY_FILE", &config.OutboxClientKeyFile)
	assignString(lookup, "RGS_OUTBOX_OWNER", &config.OutboxOwner)
	if value, ok := lookup("RGS_ALLOWED_ORIGINS"); ok {
		for _, origin := range strings.Split(value, ",") {
			if trimmed := strings.TrimSpace(origin); trimmed != "" {
				config.AllowedOrigins = append(config.AllowedOrigins, trimmed)
			}
		}
	}
	var err error
	if config.TLSTerminatedUpstream, err = boolValue(lookup, "RGS_TLS_TERMINATED_UPSTREAM", false); err != nil {
		return Config{}, err
	}
	if config.HighValueRiskEnabled, err = boolValue(lookup, "RGS_HIGH_VALUE_RISK_ENABLED", false); err != nil {
		return Config{}, err
	}
	for name, target := range map[string]*time.Duration{
		"RGS_READ_HEADER_TIMEOUT":         &config.ReadHeaderTimeout,
		"RGS_READ_TIMEOUT":                &config.ReadTimeout,
		"RGS_REQUEST_TIMEOUT":             &config.RequestTimeout,
		"RGS_WRITE_TIMEOUT":               &config.WriteTimeout,
		"RGS_IDLE_TIMEOUT":                &config.IdleTimeout,
		"RGS_SHUTDOWN_TIMEOUT":            &config.ShutdownTimeout,
		"RGS_OTEL_BATCH_TIMEOUT":          &config.TraceBatchTimeout,
		"RGS_OTEL_EXPORT_TIMEOUT":         &config.TraceExportTimeout,
		"RGS_OTEL_SHUTDOWN_TIMEOUT":       &config.TraceShutdownTimeout,
		"RGS_DB_STATEMENT_TIMEOUT":        &config.DatabaseStatementTimeout,
		"RGS_DB_LOCK_TIMEOUT":             &config.DatabaseLockTimeout,
		"RGS_WALLET_TIMEOUT":              &config.WalletTimeout,
		"RGS_WALLET_FAST_PATH_TIMEOUT":    &config.WalletFastPathTimeout,
		"RGS_HIGH_VALUE_RISK_REVIEW_TTL":  &config.HighValueRiskReviewTTL,
		"RGS_LAUNCH_TTL":                  &config.LaunchTTL,
		"RGS_ACCESS_TOKEN_TTL":            &config.AccessTokenTTL,
		"RGS_SESSION_IDLE_DISCONNECT_MIN": &config.SessionIdleDisconnectMin,
		"RGS_SESSION_IDLE_DISCONNECT_MAX": &config.SessionIdleDisconnectMax,
		"RGS_SHARED_ADMISSION_TIMEOUT":    &config.SharedAdmissionTimeout,
		"RGS_OUTBOX_INTERVAL":             &config.OutboxInterval,
		"RGS_OUTBOX_LEASE_DURATION":       &config.OutboxLeaseDuration,
		"RGS_OUTBOX_PUBLISH_TIMEOUT":      &config.OutboxPublishTimeout,
		"RGS_OUTBOX_WORKER_MAX_STALENESS": &config.OutboxWorkerMaxStaleness,
		"RGS_OUTBOX_BACKLOG_MAX_AGE":      &config.OutboxBacklogMaxAge,
		"RGS_OUTBOX_INITIAL_BACKOFF":      &config.OutboxInitialBackoff,
		"RGS_OUTBOX_MAXIMUM_BACKOFF":      &config.OutboxMaximumBackoff,
	} {
		if err := durationValue(lookup, name, target); err != nil {
			return Config{}, err
		}
	}
	if err := int64Value(lookup, "RGS_MAX_REQUEST_BYTES", &config.MaxRequestBytes); err != nil {
		return Config{}, err
	}
	if err := intValue(lookup, "RGS_MAX_IN_FLIGHT_REQUESTS", &config.MaxInFlightRequests); err != nil {
		return Config{}, err
	}
	if err := intValue(lookup, "RGS_MAX_CRYPTO_IN_FLIGHT", &config.MaxCryptoInFlight); err != nil {
		return Config{}, err
	}
	if err := intValue(lookup, "RGS_MAX_CONNECTIONS_PER_LISTENER", &config.MaxConnectionsPerListener); err != nil {
		return Config{}, err
	}
	if err := intValue(lookup, "RGS_OTEL_MAX_QUEUE_SIZE", &config.TraceMaxQueueSize); err != nil {
		return Config{}, err
	}
	if err := intValue(lookup, "RGS_OTEL_MAX_EXPORT_BATCH_SIZE", &config.TraceMaxExportBatchSize); err != nil {
		return Config{}, err
	}
	if err := floatValue(lookup, "RGS_RATE_PER_SECOND", &config.RatePerSecond); err != nil {
		return Config{}, err
	}
	if err := floatValue(lookup, "RGS_PREAUTH_RATE_PER_SECOND", &config.PreAuthRatePerSecond); err != nil {
		return Config{}, err
	}
	if err := floatValue(lookup, "RGS_OTEL_TRACE_SAMPLE_RATIO", &config.TraceSampleRatio); err != nil {
		return Config{}, err
	}
	if err := intValue(lookup, "RGS_PREAUTH_RATE_BURST", &config.PreAuthRateBurst); err != nil {
		return Config{}, err
	}
	if err := floatValue(lookup, "RGS_SHARED_ADMISSION_RATE_PER_SECOND", &config.SharedAdmissionRatePerSecond); err != nil {
		return Config{}, err
	}
	if err := intValue(lookup, "RGS_SHARED_ADMISSION_RATE_BURST", &config.SharedAdmissionRateBurst); err != nil {
		return Config{}, err
	}
	if err := floatValue(lookup, "RGS_ECONOMIC_OPERATOR_RATE_PER_SECOND", &config.EconomicOperatorRatePerSecond); err != nil {
		return Config{}, err
	}
	if err := intValue(lookup, "RGS_ECONOMIC_OPERATOR_RATE_BURST", &config.EconomicOperatorRateBurst); err != nil {
		return Config{}, err
	}
	if err := floatValue(lookup, "RGS_ECONOMIC_BACKEND_RATE_PER_SECOND", &config.EconomicBackendRatePerSecond); err != nil {
		return Config{}, err
	}
	if err := intValue(lookup, "RGS_ECONOMIC_BACKEND_RATE_BURST", &config.EconomicBackendRateBurst); err != nil {
		return Config{}, err
	}
	if err := intValue(lookup, "RGS_RATE_BURST", &config.RateBurst); err != nil {
		return Config{}, err
	}
	if err := intValue(lookup, "RGS_SUCCESS_ACCESS_LOG_SAMPLE_PER_MILLION", &config.SuccessAccessLogSamplePerMillion); err != nil {
		return Config{}, err
	}
	if err := intValue(lookup, "RGS_WALLET_MAX_ATTEMPTS", &config.WalletMaxAttempts); err != nil {
		return Config{}, err
	}
	if err := int64Value(lookup, "RGS_HIGH_VALUE_RISK_THRESHOLD_MINOR", &config.HighValueRiskThresholdMinor); err != nil {
		return Config{}, err
	}
	if err := intValue(lookup, "RGS_HIGH_VALUE_RISK_EXPIRY_BATCH_SIZE", &config.HighValueRiskExpiryBatchSize); err != nil {
		return Config{}, err
	}
	if err := intValue(lookup, "RGS_DB_MAX_OPEN_CONNS", &config.DatabaseMaxOpenConns); err != nil {
		return Config{}, err
	}
	if err := intValue(lookup, "RGS_DB_MAX_IDLE_CONNS", &config.DatabaseMaxIdleConns); err != nil {
		return Config{}, err
	}
	if err := intValue(lookup, "RGS_DB_CRITICAL_RESERVE_CONNS", &config.DatabaseCriticalReserveConns); err != nil {
		return Config{}, err
	}
	if err := intValue(lookup, "RGS_OUTBOX_BATCH_SIZE", &config.OutboxBatchSize); err != nil {
		return Config{}, err
	}
	if err := intValue(lookup, "RGS_OUTBOX_MAX_PARALLEL", &config.OutboxMaxParallel); err != nil {
		return Config{}, err
	}
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

func (c Config) Validate() error {
	switch c.Environment {
	case Development, Staging, Production:
	default:
		return fmt.Errorf("RGS_ENVIRONMENT must be development, staging, or production")
	}
	switch c.RuntimeRole {
	case RuntimeRoleCombined, RuntimeRoleAPI, RuntimeRoleWorker:
	default:
		return errors.New("RGS_RUNTIME_ROLE must be combined, api, or worker")
	}
	if strings.TrimSpace(c.HTTPAddress) == "" {
		return errors.New("RGS_HTTP_ADDR is required")
	}
	if strings.TrimSpace(c.OperationsHTTPAddress) == "" {
		return errors.New("RGS_OPERATIONS_HTTP_ADDR is required")
	}
	if _, _, err := net.SplitHostPort(c.OperationsHTTPAddress); err != nil {
		return errors.New("RGS_OPERATIONS_HTTP_ADDR must be a host:port listen address")
	}
	if c.Environment == Production && listenAddressesConflict(c.HTTPAddress, c.OperationsHTTPAddress) {
		return errors.New("RGS_OPERATIONS_HTTP_ADDR must not conflict with RGS_HTTP_ADDR in production")
	}
	publicURL, err := url.Parse(c.PublicBaseURL)
	if err != nil || publicURL.Host == "" || (publicURL.Scheme != "http" && publicURL.Scheme != "https") ||
		publicURL.User != nil || (publicURL.Path != "" && publicURL.Path != "/") ||
		publicURL.RawQuery != "" || publicURL.Fragment != "" {
		return errors.New("RGS_PUBLIC_BASE_URL must be an origin URL without path, query, fragment, or user info")
	}
	if (c.TLSCertFile == "") != (c.TLSKeyFile == "") {
		return errors.New("RGS_TLS_CERT_FILE and RGS_TLS_KEY_FILE must be configured together")
	}
	if c.Environment == Production {
		type requiredProductionSetting struct {
			name  string
			value string
		}
		required := []requiredProductionSetting{
			{"RGS_DATABASE_URL", c.DatabaseURL},
			{"RGS_OPERATOR_CONFIG_FILE", c.OperatorConfigFile},
			{"RGS_DEFINITION_FILE", c.DefinitionFile},
			{"RGS_DEFINITION_APPROVAL_FILE", c.DefinitionApprovalFile},
			{"RGS_DEFINITION_APPROVAL_PUBLIC_KEY_FILE", c.DefinitionApprovalPublicKeyFile},
			{"RGS_OPERATIONS_BEARER_TOKEN_FILE", c.OperationsBearerTokenFile},
		}
		if c.RuntimeRole.ServesPublicAPI() {
			required = append(required,
				requiredProductionSetting{"RGS_LAUNCH_HMAC_KEY_FILE", c.LaunchHMACKeyFile},
			)
		}
		if c.RuntimeRole == RuntimeRoleAPI || c.RuntimeRole == RuntimeRoleWorker {
			required = append(required,
				requiredProductionSetting{"RGS_EXPECTED_DEFINITION_GAME_ID", c.ExpectedDefinitionGameID},
				requiredProductionSetting{"RGS_EXPECTED_DEFINITION_VERSION", c.ExpectedDefinitionVersion},
				requiredProductionSetting{"RGS_EXPECTED_DEFINITION_SHA256", c.ExpectedDefinitionSHA256},
			)
		}
		if c.RuntimeRole.RunsBackgroundWorkloads() {
			required = append(required,
				requiredProductionSetting{"RGS_OUTBOX_ENDPOINT_URL", c.OutboxEndpointURL},
				requiredProductionSetting{"RGS_OUTBOX_HMAC_KEY_ID", c.OutboxHMACKeyID},
				requiredProductionSetting{"RGS_OUTBOX_HMAC_KEY_FILE", c.OutboxHMACKeyFile},
			)
		}
		for _, item := range required {
			if strings.TrimSpace(item.value) == "" {
				return fmt.Errorf("%s is required in production", item.name)
			}
		}
		if err := validateProductionDatabaseURL(c.DatabaseURL); err != nil {
			return err
		}
		if publicURL.Scheme != "https" {
			return errors.New("RGS_PUBLIC_BASE_URL must use https in production")
		}
		if c.TLSCertFile == "" && !c.TLSTerminatedUpstream {
			return errors.New("production requires local TLS or RGS_TLS_TERMINATED_UPSTREAM=true")
		}
		if len(c.AllowedOrigins) == 0 {
			return errors.New("RGS_ALLOWED_ORIGINS is required in production")
		}
	}
	if err := validateExpectedDefinitionIdentityConfig(c); err != nil {
		return err
	}
	// 非回环运维监听可能被端口转发、测试入口或错误的安全组意外暴露；生产环境
	// 已在上方必填项中拒绝空值，开发及预发布环境也必须在非回环时显式配置承载令牌。
	// A non-loopback operations listener may be exposed accidentally by port forwarding, test ingress, or an incorrect security group;
	// production already rejects empty required values above, and development or staging must also configure a bearer token explicitly for non-loopback listeners.
	if c.Environment != Production && operationsListenerRequiresBearer(c.OperationsHTTPAddress) &&
		strings.TrimSpace(c.OperationsBearerTokenFile) == "" {
		return errors.New("RGS_OPERATIONS_BEARER_TOKEN_FILE is required for a non-loopback operations listener")
	}
	if err := c.validateTracing(); err != nil {
		return err
	}
	if err := c.validateHighValueRisk(); err != nil {
		return err
	}
	if err := c.validateOutbox(); err != nil {
		return err
	}
	if err := c.validateSharedAdmission(); err != nil {
		return err
	}
	seenOrigins := make(map[string]struct{}, len(c.AllowedOrigins))
	for _, raw := range c.AllowedOrigins {
		if raw == "*" {
			return errors.New("wildcard CORS origins are not allowed")
		}
		origin, err := url.Parse(raw)
		if err != nil || origin.Host == "" || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || origin.User != nil {
			return fmt.Errorf("invalid allowed origin %q", raw)
		}
		if c.Environment == Production && origin.Scheme != "https" {
			return fmt.Errorf("production origin %q must use https", raw)
		}
		if _, duplicate := seenOrigins[origin.String()]; duplicate {
			return fmt.Errorf("duplicate allowed origin %q", raw)
		}
		seenOrigins[origin.String()] = struct{}{}
	}
	for name, value := range map[string]time.Duration{
		"read header timeout":             c.ReadHeaderTimeout,
		"read timeout":                    c.ReadTimeout,
		"request timeout":                 c.RequestTimeout,
		"write timeout":                   c.WriteTimeout,
		"idle timeout":                    c.IdleTimeout,
		"shutdown timeout":                c.ShutdownTimeout,
		"database statement timeout":      c.DatabaseStatementTimeout,
		"database lock timeout":           c.DatabaseLockTimeout,
		"wallet timeout":                  c.WalletTimeout,
		"wallet fast path timeout":        c.WalletFastPathTimeout,
		"launch TTL":                      c.LaunchTTL,
		"access token TTL":                c.AccessTokenTTL,
		"session idle disconnect minimum": c.SessionIdleDisconnectMin,
		"session idle disconnect maximum": c.SessionIdleDisconnectMax,
	} {
		if value <= 0 {
			return fmt.Errorf("%s must be positive", name)
		}
	}
	if c.ReadHeaderTimeout > c.ReadTimeout {
		return errors.New("RGS_READ_HEADER_TIMEOUT must not exceed RGS_READ_TIMEOUT")
	}
	if c.ReadHeaderTimeout < 100*time.Millisecond || c.ReadHeaderTimeout > 10*time.Second {
		return errors.New("RGS_READ_HEADER_TIMEOUT must be between 100ms and 10s")
	}
	if c.ReadTimeout < time.Second || c.ReadTimeout > 30*time.Second {
		return errors.New("RGS_READ_TIMEOUT must be between 1s and 30s")
	}
	if c.RequestTimeout < time.Second || c.RequestTimeout > time.Minute {
		return errors.New("RGS_REQUEST_TIMEOUT must be between 1s and 1m")
	}
	if c.WriteTimeout < time.Second || c.WriteTimeout > 90*time.Second {
		return errors.New("RGS_WRITE_TIMEOUT must be between 1s and 1m30s")
	}
	if c.IdleTimeout < time.Second || c.IdleTimeout > 5*time.Minute {
		return errors.New("RGS_IDLE_TIMEOUT must be between 1s and 5m")
	}
	if c.ShutdownTimeout < time.Second || c.ShutdownTimeout > 5*time.Minute {
		return errors.New("RGS_SHUTDOWN_TIMEOUT must be between 1s and 5m")
	}
	if c.ReadTimeout > c.RequestTimeout {
		return errors.New("RGS_READ_TIMEOUT must not exceed RGS_REQUEST_TIMEOUT")
	}
	if c.RequestTimeout >= c.WriteTimeout {
		return errors.New("RGS_REQUEST_TIMEOUT must be shorter than RGS_WRITE_TIMEOUT")
	}
	if c.DatabaseStatementTimeout >= c.RequestTimeout {
		return errors.New("RGS_DB_STATEMENT_TIMEOUT must be shorter than RGS_REQUEST_TIMEOUT")
	}
	if c.DatabaseLockTimeout > c.DatabaseStatementTimeout {
		return errors.New("RGS_DB_LOCK_TIMEOUT must not exceed RGS_DB_STATEMENT_TIMEOUT")
	}
	if c.DatabaseStatementTimeout < time.Millisecond || c.DatabaseLockTimeout < time.Millisecond ||
		c.DatabaseStatementTimeout%time.Millisecond != 0 || c.DatabaseLockTimeout%time.Millisecond != 0 {
		return errors.New("database timeouts must be whole milliseconds")
	}
	if c.WalletTimeout >= c.RequestTimeout {
		return errors.New("RGS_WALLET_TIMEOUT must be shorter than RGS_REQUEST_TIMEOUT")
	}
	if c.WalletFastPathTimeout >= c.WalletTimeout {
		return errors.New("RGS_WALLET_FAST_PATH_TIMEOUT must be shorter than RGS_WALLET_TIMEOUT")
	}
	if c.LaunchTTL < time.Second || c.LaunchTTL > 5*time.Minute ||
		c.LaunchTTL%time.Microsecond != 0 {
		return errors.New("RGS_LAUNCH_TTL must use whole microseconds within [1s,5m]")
	}
	if c.AccessTokenTTL > time.Hour {
		return errors.New("access credentials exceed maximum TTL")
	}
	if c.SessionIdleDisconnectMin < time.Second || c.SessionIdleDisconnectMax > 24*time.Hour ||
		c.SessionIdleDisconnectMin > c.SessionIdleDisconnectMax ||
		c.SessionIdleDisconnectMin%time.Second != 0 || c.SessionIdleDisconnectMax%time.Second != 0 {
		return errors.New("RGS_SESSION_IDLE_DISCONNECT_MIN/MAX must be whole seconds within [1s,24h]")
	}
	if c.Environment != Development && c.SessionIdleDisconnectMin < time.Minute {
		return errors.New("RGS_SESSION_IDLE_DISCONNECT_MIN must be at least 1m outside development")
	}
	if c.MaxRequestBytes != 8<<10 {
		return errors.New("RGS_MAX_REQUEST_BYTES must be exactly 8192 to match the complete edge inspection window")
	}
	// 这是每个 RGS 副本在签名验证和数据库访问之前的硬资源预算；必须有界，
	// 避免配置错误把非阻塞闸门退化为无效保护或制造过量内存占用。
	// English: This is the hard resource budget for each RGS replica before signature verification and database
	// access; it must be bounded to avoid configuration errors that degrade non-blocking gates into ineffective
	// protection or create excessive memory usage.
	if c.MaxInFlightRequests < 1 || c.MaxInFlightRequests > 4_096 {
		return errors.New("RGS_MAX_IN_FLIGHT_REQUESTS must be between 1 and 4096")
	}
	// 未认证 path 不能取得恢复优先级；公网和密码学 gate 都是单一匿名硬上限。
	// 只有身份验证后的 DB 新意图预留与钱包 lookup 预留负责恢复进展。
	// English: Unauthenticated paths cannot obtain recovery priority; both the public network and the cryptographic
	// gate have a single anonymous hard limit. Only authenticated DB new intent reservations and wallet lookup
	// reservations are responsible for recovery progress.
	if c.MaxCryptoInFlight < 1 || c.MaxCryptoInFlight > 1_024 {
		return errors.New("RGS_MAX_CRYPTO_IN_FLIGHT must be between 1 and 1024")
	}
	// 请求闸门无法覆盖慢请求头、未读正文回收和空闲长连接；监听器还必须
	// 独立限制已接受连接总数，才能给文件描述符、TLS 状态和协程设置硬预算。
	// English: Request gates cannot cover slow request headers, unread body recycling, and idle long connections;
	// listeners must also independently limit the total number of accepted connections to set hard budgets for file
	// descriptors, TLS status, and coroutines.
	if c.MaxConnectionsPerListener < 1 || c.MaxConnectionsPerListener > 16_384 {
		return errors.New("RGS_MAX_CONNECTIONS_PER_LISTENER must be between 1 and 16384")
	}
	if !finiteRate(c.RatePerSecond) || c.RatePerSecond <= 0 || c.RatePerSecond > 100_000 ||
		c.RateBurst < 1 || c.RateBurst > 1_000_000 {
		return errors.New("invalid rate limit configuration")
	}
	// 公网预认证速率只使用一个进程级桶，不按 IP、转发头或声明租户建键。
	// 它是边缘设施失效时的高水位背压，应显著高于认证后业务配额但仍保持硬上限。
	// English: The public network pre-authentication rate uses only one process-level bucket and does not create keys
	// based on IP, forwarding headers or declared tenants. It is the high-water back pressure at which edge facilities
	// fail and should be significantly higher than the post-certification business quota but still remain a hard cap.
	if !finiteRate(c.PreAuthRatePerSecond) || c.PreAuthRatePerSecond < 1 || c.PreAuthRatePerSecond > 1_000_000 ||
		c.PreAuthRateBurst < 1 || c.PreAuthRateBurst > 2_000_000 {
		return errors.New("invalid pre-authentication rate limit configuration")
	}
	if c.SuccessAccessLogSamplePerMillion < 0 || c.SuccessAccessLogSamplePerMillion > 1_000_000 {
		return errors.New("RGS_SUCCESS_ACCESS_LOG_SAMPLE_PER_MILLION must be between 0 and 1000000")
	}
	if c.WalletMaxAttempts < 1 || c.WalletMaxAttempts > 10_000 {
		return errors.New("RGS_WALLET_MAX_ATTEMPTS must be between 1 and 10000")
	}
	// 连接池上限是每个 RGS 副本的预算；限制其范围并要求空闲连接数不超过打开连接数，
	// 避免一次环境变量误配在扩容时耗尽 PostgreSQL 可用连接。
	// English: The upper limit of the connection pool is the budget of each RGS copy; limit its scope and require that
	// the number of idle connections does not exceed the number of open connections to avoid a misconfiguration of
	// environment variables from depleting available PostgreSQL connections during expansion.
	if c.DatabaseMaxOpenConns < 1 || c.DatabaseMaxOpenConns > 200 {
		return errors.New("RGS_DB_MAX_OPEN_CONNS must be between 1 and 200")
	}
	if c.DatabaseMaxIdleConns < 0 || c.DatabaseMaxIdleConns > c.DatabaseMaxOpenConns {
		return errors.New("RGS_DB_MAX_IDLE_CONNS must be between 0 and RGS_DB_MAX_OPEN_CONNS")
	}
	if c.DatabaseCriticalReserveConns < 1 || c.DatabaseCriticalReserveConns >= c.DatabaseMaxOpenConns {
		return errors.New("RGS_DB_CRITICAL_RESERVE_CONNS must be between 1 and RGS_DB_MAX_OPEN_CONNS-1")
	}
	return nil
}

func (c Config) validateTracing() error {
	if !finiteRate(c.TraceSampleRatio) || c.TraceSampleRatio < 0 || c.TraceSampleRatio > 1 {
		return errors.New("RGS_OTEL_TRACE_SAMPLE_RATIO must be finite and between 0 and 1")
	}
	for name, value := range map[string]time.Duration{
		"RGS_OTEL_BATCH_TIMEOUT":    c.TraceBatchTimeout,
		"RGS_OTEL_EXPORT_TIMEOUT":   c.TraceExportTimeout,
		"RGS_OTEL_SHUTDOWN_TIMEOUT": c.TraceShutdownTimeout,
	} {
		if value < 100*time.Millisecond || value > 30*time.Second {
			return fmt.Errorf("%s must be between 100ms and 30s", name)
		}
	}
	if c.TraceMaxQueueSize < 1 || c.TraceMaxQueueSize > 8_192 {
		return errors.New("RGS_OTEL_MAX_QUEUE_SIZE must be between 1 and 8192")
	}
	if c.TraceMaxExportBatchSize < 1 || c.TraceMaxExportBatchSize > 1_024 ||
		c.TraceMaxExportBatchSize > c.TraceMaxQueueSize {
		return errors.New("RGS_OTEL_MAX_EXPORT_BATCH_SIZE must be between 1 and 1024 and not exceed RGS_OTEL_MAX_QUEUE_SIZE")
	}
	if c.TraceEndpoint == "" {
		return nil
	}
	if len(c.TraceEndpoint) > 2_048 {
		return errors.New("RGS_OTEL_TRACES_ENDPOINT must not exceed 2048 bytes")
	}
	endpoint, err := url.Parse(c.TraceEndpoint)
	if err != nil || endpoint.Host == "" || endpoint.Opaque != "" ||
		(endpoint.Scheme != "http" && endpoint.Scheme != "https") ||
		endpoint.User != nil || endpoint.Path != "/v1/traces" || endpoint.RawPath != "" ||
		endpoint.ForceQuery || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return errors.New("RGS_OTEL_TRACES_ENDPOINT must be an http(s) URL ending exactly in /v1/traces without user info, query, or fragment")
	}
	if c.Environment == Production && endpoint.Scheme != "https" {
		host := strings.ToLower(endpoint.Hostname())
		address := net.ParseIP(host)
		if host != "localhost" && (address == nil || !address.IsLoopback()) {
			return errors.New("RGS_OTEL_TRACES_ENDPOINT must use https in production unless it targets a loopback collector")
		}
	}
	return nil
}

func (c Config) validateHighValueRisk() error {
	if !c.HighValueRiskEnabled {
		if c.HighValueRiskThresholdMinor != 0 || c.HighValueRiskPolicyVersion != "" ||
			c.HighValueRiskReviewTTL != 0 || c.HighValueRiskExpiryPolicy != "" ||
			c.HighValueRiskExpiryBatchSize != 0 {
			return errors.New("high-value risk settings require RGS_HIGH_VALUE_RISK_ENABLED=true")
		}
		return nil
	}
	if c.HighValueRiskThresholdMinor <= 0 {
		return errors.New("RGS_HIGH_VALUE_RISK_THRESHOLD_MINOR must be positive when risk review is enabled")
	}
	if !validRuntimeIdentifier(c.HighValueRiskPolicyVersion) {
		return errors.New("RGS_HIGH_VALUE_RISK_POLICY_VERSION must be a 1..128 character identifier")
	}
	if c.HighValueRiskReviewTTL < time.Minute || c.HighValueRiskReviewTTL > 72*time.Hour {
		return errors.New("RGS_HIGH_VALUE_RISK_REVIEW_TTL must be between 1m and 72h")
	}
	if c.HighValueRiskExpiryPolicy != "REJECT" && c.HighValueRiskExpiryPolicy != "MANUAL_REVIEW" {
		return errors.New("RGS_HIGH_VALUE_RISK_EXPIRY_POLICY must be REJECT or MANUAL_REVIEW")
	}
	if c.HighValueRiskExpiryBatchSize < 1 || c.HighValueRiskExpiryBatchSize > 1_000 {
		return errors.New("RGS_HIGH_VALUE_RISK_EXPIRY_BATCH_SIZE must be between 1 and 1000")
	}
	return nil
}

func (c Config) validateSharedAdmission() error {
	settings := []string{
		c.SharedAdmissionURL,
		c.SharedAdmissionUsername,
		c.SharedAdmissionPasswordFile,
		c.SharedAdmissionHMACKeyFile,
		c.SharedAdmissionRootCAFile,
	}
	enabled := false
	for _, setting := range settings {
		if strings.TrimSpace(setting) != "" {
			enabled = true
			break
		}
	}
	if c.RuntimeRole == RuntimeRoleWorker && enabled {
		return errors.New("shared admission configuration is not allowed for the worker runtime role")
	}
	if c.Environment == Production && c.RuntimeRole.ServesPublicAPI() && !enabled {
		return errors.New("RGS_SHARED_ADMISSION_URL is required for every production public API runtime role")
	}
	if !enabled {
		return nil
	}
	if c.SharedAdmissionURL == "" || c.SharedAdmissionUsername == "" || c.SharedAdmissionPasswordFile == "" ||
		c.SharedAdmissionHMACKeyFile == "" || c.SharedAdmissionRootCAFile == "" {
		return errors.New("shared admission requires URL, ACL username, password, HMAC key, and root CA files")
	}
	if !validRuntimeIdentifier(c.SharedAdmissionUsername) {
		return errors.New("RGS_SHARED_ADMISSION_USERNAME must be a 1..128 character identifier")
	}
	endpoint, err := url.Parse(c.SharedAdmissionURL)
	if err != nil || endpoint.Scheme != "rediss" || endpoint.Host == "" || endpoint.User != nil ||
		(endpoint.Path != "" && endpoint.Path != "/") || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return errors.New("RGS_SHARED_ADMISSION_URL must be a rediss origin without credentials, query, or fragment")
	}
	for name, path := range map[string]string{
		"RGS_SHARED_ADMISSION_PASSWORD_FILE": pathClean(c.SharedAdmissionPasswordFile),
		"RGS_SHARED_ADMISSION_HMAC_KEY_FILE": pathClean(c.SharedAdmissionHMACKeyFile),
		"RGS_SHARED_ADMISSION_ROOT_CA_FILE":  pathClean(c.SharedAdmissionRootCAFile),
	} {
		if !filepath.IsAbs(path) {
			return fmt.Errorf("%s must be an absolute path", name)
		}
	}
	if c.SharedAdmissionTimeout < 10*time.Millisecond || c.SharedAdmissionTimeout > 500*time.Millisecond ||
		c.SharedAdmissionTimeout >= c.RequestTimeout {
		return errors.New("RGS_SHARED_ADMISSION_TIMEOUT must be between 10ms and 500ms and shorter than the request timeout")
	}
	if !finiteRate(c.SharedAdmissionRatePerSecond) ||
		c.SharedAdmissionRatePerSecond < 0.001 || c.SharedAdmissionRatePerSecond > 100_000 ||
		c.SharedAdmissionRateBurst < 1 || c.SharedAdmissionRateBurst > 1_000_000 {
		return errors.New("invalid shared admission rate limit configuration")
	}
	if !rateHasMilliPrecision(c.SharedAdmissionRatePerSecond) {
		return errors.New("shared admission rate must have at most three decimal places")
	}
	if float64(c.SharedAdmissionRateBurst)/c.SharedAdmissionRatePerSecond > (24*time.Hour - time.Second).Seconds() {
		return errors.New("shared admission full-refill TTL must not exceed 24 hours")
	}
	if err := validateEconomicPolicy(
		"operator",
		c.EconomicOperatorRatePerSecond,
		c.EconomicOperatorRateBurst,
	); err != nil {
		return err
	}
	if err := validateEconomicPolicy(
		"backend",
		c.EconomicBackendRatePerSecond,
		c.EconomicBackendRateBurst,
	); err != nil {
		return err
	}
	return nil
}

func validateEconomicPolicy(scope string, rate float64, burst int) error {
	if !finiteRate(rate) || rate < 0.001 || rate > 100_000 ||
		burst < 1 || burst > 1_000_000 {
		return fmt.Errorf("invalid %s economic admission policy", scope)
	}
	if !rateHasMilliPrecision(rate) {
		return fmt.Errorf("%s economic admission rate must have at most three decimal places", scope)
	}
	if float64(burst)/rate > (24*time.Hour - time.Second).Seconds() {
		return fmt.Errorf("%s economic admission full-refill TTL must not exceed 24 hours", scope)
	}
	return nil
}

func finiteRate(rate float64) bool {
	return !math.IsNaN(rate) && !math.IsInf(rate, 0)
}

func rateHasMilliPrecision(rate float64) bool {
	scaled := rate * 1_000
	rounded := math.Round(scaled)
	tolerance := 4 * math.Abs(math.Nextafter(scaled, math.Inf(1))-scaled)
	return math.Abs(scaled-rounded) <= tolerance
}

func pathClean(path string) string {
	return strings.TrimSpace(path)
}

// listenAddressesConflict 保守地识别同一端口的重叠监听地址。生产环境宁可
// 拒绝一个含糊的同端口配置，也不能让健康/指标接口意外暴露到公网监听器。
// English: listenAddressesConflict conservatively identifies overlapping listening addresses for the same port. A
// production environment would rather reject an ambiguous same-port configuration than accidentally expose the
// health/metrics interface to a public network listener.
func listenAddressesConflict(left, right string) bool {
	leftHost, leftPort, leftErr := net.SplitHostPort(left)
	rightHost, rightPort, rightErr := net.SplitHostPort(right)
	if leftErr != nil || rightErr != nil {
		return left == right
	}
	if leftPort != rightPort {
		return false
	}
	leftHost = normalizeListenHost(leftHost)
	rightHost = normalizeListenHost(rightHost)
	if leftHost == rightHost || isWildcardListenHost(leftHost) || isWildcardListenHost(rightHost) {
		return true
	}
	return leftHost == "localhost" && isLoopbackListenHost(rightHost) ||
		rightHost == "localhost" && isLoopbackListenHost(leftHost)
}

func normalizeListenHost(host string) string {
	return strings.ToLower(strings.TrimSpace(host))
}

func isWildcardListenHost(host string) bool {
	return host == "" || host == "0.0.0.0" || host == "::"
}

func isLoopbackListenHost(host string) bool {
	if host == "localhost" {
		return true
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}

func operationsListenerRequiresBearer(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return true
	}
	return !isLoopbackListenHost(normalizeListenHost(host))
}

func validateExpectedDefinitionIdentityConfig(config Config) error {
	values := []string{
		config.ExpectedDefinitionGameID,
		config.ExpectedDefinitionVersion,
		config.ExpectedDefinitionSHA256,
	}
	configured := 0
	for _, value := range values {
		if value != "" {
			configured++
		}
	}
	if configured == 0 {
		return nil
	}
	if configured != len(values) {
		return errors.New("expected definition game ID, version, and SHA-256 must be configured together")
	}
	if !validDefinitionIdentityPart(config.ExpectedDefinitionGameID) ||
		!validDefinitionIdentityPart(config.ExpectedDefinitionVersion) {
		return errors.New("expected definition game ID and version must be 1..128 character identifiers")
	}
	if len(config.ExpectedDefinitionSHA256) != 64 {
		return errors.New("RGS_EXPECTED_DEFINITION_SHA256 must be a lowercase SHA-256 digest")
	}
	for _, character := range config.ExpectedDefinitionSHA256 {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return errors.New("RGS_EXPECTED_DEFINITION_SHA256 must be a lowercase SHA-256 digest")
		}
	}
	return nil
}

func validDefinitionIdentityPart(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') && !strings.ContainsRune("._:-", character) {
			return false
		}
	}
	return true
}

func validateProductionDatabaseURL(raw string) error {
	databaseURL, err := url.Parse(raw)
	if err != nil {
		return errors.New("RGS_DATABASE_URL must include exactly one sslmode=verify-full query parameter in production")
	}
	query, err := url.ParseQuery(databaseURL.RawQuery)
	if err != nil {
		return errors.New("RGS_DATABASE_URL must include exactly one sslmode=verify-full query parameter in production")
	}
	var modes []string
	for name, values := range query {
		if strings.EqualFold(name, "sslmode") {
			if name != "sslmode" {
				return errors.New("RGS_DATABASE_URL must include exactly one sslmode=verify-full query parameter in production")
			}
			modes = append(modes, values...)
		}
	}
	if len(modes) != 1 || modes[0] != "verify-full" {
		return errors.New("RGS_DATABASE_URL must include exactly one sslmode=verify-full query parameter in production")
	}
	return nil
}

func (c Config) validateOutbox() error {
	if c.RuntimeRole == RuntimeRoleAPI && (c.OutboxEndpointURL != "" || c.OutboxHMACKeyID != "" ||
		c.OutboxHMACKeyFile != "" || c.OutboxBearerTokenFile != "" || c.OutboxRootCAFile != "" ||
		c.OutboxClientCertFile != "" || c.OutboxClientKeyFile != "" || c.OutboxOwner != "") {
		return errors.New("outbox delivery configuration is not allowed for the api runtime role")
	}
	if c.RuntimeRole == RuntimeRoleWorker && c.OutboxEndpointURL == "" {
		return errors.New("RGS_OUTBOX_ENDPOINT_URL is required for the worker runtime role")
	}
	if (c.OutboxClientCertFile == "") != (c.OutboxClientKeyFile == "") {
		return errors.New("RGS_OUTBOX_CLIENT_CERT_FILE and RGS_OUTBOX_CLIENT_KEY_FILE must be configured together")
	}
	if c.OutboxEndpointURL == "" {
		if c.OutboxHMACKeyID != "" || c.OutboxHMACKeyFile != "" || c.OutboxBearerTokenFile != "" ||
			c.OutboxRootCAFile != "" || c.OutboxClientCertFile != "" || c.OutboxClientKeyFile != "" ||
			c.OutboxOwner != "" {
			return errors.New("RGS_OUTBOX_ENDPOINT_URL is required when outbox sink settings are configured")
		}
	} else {
		endpoint, err := url.Parse(c.OutboxEndpointURL)
		if err != nil || endpoint.Host == "" || endpoint.User != nil || endpoint.Path == "" ||
			endpoint.RawQuery != "" || endpoint.Fragment != "" ||
			(endpoint.Scheme != "https" && !(c.Environment == Development && endpoint.Scheme == "http")) {
			return errors.New("RGS_OUTBOX_ENDPOINT_URL must be an HTTPS URL with a path and without credentials, query, or fragment")
		}
		if !validRuntimeIdentifier(c.OutboxHMACKeyID) || strings.TrimSpace(c.OutboxHMACKeyFile) == "" {
			return errors.New("RGS_OUTBOX_HMAC_KEY_ID and RGS_OUTBOX_HMAC_KEY_FILE are required when outbox delivery is enabled")
		}
		if c.OutboxOwner != "" && !validRuntimeIdentifier(c.OutboxOwner) {
			return errors.New("RGS_OUTBOX_OWNER must be a 1..128 character identifier")
		}
	}
	for name, value := range map[string]time.Duration{
		"RGS_OUTBOX_INTERVAL":             c.OutboxInterval,
		"RGS_OUTBOX_LEASE_DURATION":       c.OutboxLeaseDuration,
		"RGS_OUTBOX_PUBLISH_TIMEOUT":      c.OutboxPublishTimeout,
		"RGS_OUTBOX_WORKER_MAX_STALENESS": c.OutboxWorkerMaxStaleness,
		"RGS_OUTBOX_BACKLOG_MAX_AGE":      c.OutboxBacklogMaxAge,
		"RGS_OUTBOX_INITIAL_BACKOFF":      c.OutboxInitialBackoff,
		"RGS_OUTBOX_MAXIMUM_BACKOFF":      c.OutboxMaximumBackoff,
	} {
		if value <= 0 {
			return fmt.Errorf("%s must be positive", name)
		}
	}
	if c.OutboxInterval < 10*time.Millisecond || c.OutboxInterval > time.Hour ||
		c.OutboxLeaseDuration < 10*time.Millisecond || c.OutboxLeaseDuration > 2*time.Hour ||
		c.OutboxPublishTimeout < 10*time.Millisecond || c.OutboxPublishTimeout > time.Hour ||
		c.OutboxWorkerMaxStaleness < time.Second || c.OutboxWorkerMaxStaleness > 24*time.Hour ||
		c.OutboxWorkerMaxStaleness < c.OutboxInterval ||
		c.OutboxBacklogMaxAge < time.Second || c.OutboxBacklogMaxAge > 30*24*time.Hour ||
		c.OutboxInitialBackoff < time.Millisecond ||
		c.OutboxMaximumBackoff < c.OutboxInitialBackoff || c.OutboxMaximumBackoff > 24*time.Hour ||
		c.OutboxBatchSize < 1 || c.OutboxBatchSize > 1_000 ||
		c.OutboxMaxParallel < 1 || c.OutboxMaxParallel > 256 {
		return errors.New("invalid outbox delivery bounds")
	}
	waves := (c.OutboxBatchSize + c.OutboxMaxParallel - 1) / c.OutboxMaxParallel
	if c.OutboxPublishTimeout > 2*time.Hour/time.Duration(waves) ||
		c.OutboxLeaseDuration <= c.OutboxPublishTimeout*time.Duration(waves) {
		return errors.New("RGS_OUTBOX_LEASE_DURATION is shorter than the bounded batch publish window")
	}
	return nil
}

func validRuntimeIdentifier(value string) bool {
	if len(value) < 1 || len(value) > 128 {
		return false
	}
	for index, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			(index > 0 && (character == '.' || character == '_' || character == ':' || character == '-')) {
			continue
		}
		return false
	}
	return true
}

func assignString(lookup EnvLookup, name string, target *string) {
	if value, ok := lookup(name); ok {
		*target = strings.TrimSpace(value)
	}
}

func durationValue(lookup EnvLookup, name string, target *time.Duration) error {
	value, ok := lookup(name)
	if !ok {
		return nil
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	*target = parsed
	return nil
}

func boolValue(lookup EnvLookup, name string, fallback bool) (bool, error) {
	value, ok := lookup(name)
	if !ok {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s: %w", name, err)
	}
	return parsed, nil
}

func intValue(lookup EnvLookup, name string, target *int) error {
	value, ok := lookup(name)
	if !ok {
		return nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	*target = parsed
	return nil
}

func int64Value(lookup EnvLookup, name string, target *int64) error {
	value, ok := lookup(name)
	if !ok {
		return nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	*target = parsed
	return nil
}

func floatValue(lookup EnvLookup, name string, target *float64) error {
	value, ok := lookup(name)
	if !ok {
		return nil
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	*target = parsed
	return nil
}
