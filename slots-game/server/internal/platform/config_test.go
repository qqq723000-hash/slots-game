package platform

import (
	"strings"
	"testing"
	"time"
)

func lookup(values map[string]string) EnvLookup {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

func TestDevelopmentConfigHasSafeBoundedDefaults(t *testing.T) {
	config, err := LoadConfigFrom(lookup(nil))
	if err != nil {
		t.Fatalf("LoadConfigFrom returned error: %v", err)
	}
	if config.MaxRequestBytes != 8<<10 || config.LaunchTTL.String() != "2m0s" ||
		config.RequestTimeout.String() != "15s" ||
		config.DatabaseStatementTimeout.String() != "10s" ||
		config.DatabaseLockTimeout.String() != "2s" ||
		config.DatabaseMaxOpenConns != 40 || config.DatabaseMaxIdleConns != 10 ||
		config.DatabaseCriticalReserveConns != 5 ||
		config.WalletTimeout.String() != "4s" || config.WalletFastPathTimeout.String() != "1s" ||
		config.MaxInFlightRequests != 256 ||
		config.MaxCryptoInFlight != 64 ||
		config.MaxConnectionsPerListener != 1_024 ||
		config.PreAuthRatePerSecond != 5_000 || config.PreAuthRateBurst != 10_000 ||
		config.SuccessAccessLogSamplePerMillion != 1_000_000 ||
		config.TraceEndpoint != "" || config.TraceSampleRatio != 0.01 ||
		config.TraceBatchTimeout.String() != "1s" || config.TraceExportTimeout.String() != "3s" ||
		config.TraceShutdownTimeout.String() != "5s" || config.TraceMaxQueueSize != 1_024 ||
		config.TraceMaxExportBatchSize != 256 ||
		config.EconomicOperatorRatePerSecond != 20 || config.EconomicOperatorRateBurst != 40 ||
		config.EconomicBackendRatePerSecond != 100 || config.EconomicBackendRateBurst != 200 ||
		config.OperationsHTTPAddress != "127.0.0.1:8081" ||
		config.RuntimeRole != RuntimeRoleCombined {
		t.Fatalf("unexpected defaults: %+v", config)
	}
	if config.HighValueRiskEnabled || config.HighValueRiskThresholdMinor != 0 ||
		config.HighValueRiskPolicyVersion != "" || config.HighValueRiskReviewTTL != 0 ||
		config.HighValueRiskExpiryPolicy != "" || config.HighValueRiskExpiryBatchSize != 0 {
		t.Fatalf("development default unexpectedly enables risk review: %+v", config)
	}
	if config.OutboxEndpointURL != "" {
		t.Fatalf("development default unexpectedly enables external delivery: %q", config.OutboxEndpointURL)
	}
}

func TestTracingConfigurationIsOptionalExplicitAndBounded(t *testing.T) {
	valid := map[string]string{
		"RGS_OTEL_TRACES_ENDPOINT":       "https://collector.example/v1/traces",
		"RGS_OTEL_TRACE_SAMPLE_RATIO":    "0.125",
		"RGS_OTEL_BATCH_TIMEOUT":         "250ms",
		"RGS_OTEL_EXPORT_TIMEOUT":        "2s",
		"RGS_OTEL_SHUTDOWN_TIMEOUT":      "4s",
		"RGS_OTEL_MAX_QUEUE_SIZE":        "512",
		"RGS_OTEL_MAX_EXPORT_BATCH_SIZE": "128",
	}
	config, err := LoadConfigFrom(lookup(valid))
	if err != nil {
		t.Fatalf("valid tracing config rejected: %v", err)
	}
	if config.TraceEndpoint != valid["RGS_OTEL_TRACES_ENDPOINT"] ||
		config.TraceSampleRatio != 0.125 || config.TraceBatchTimeout != 250*time.Millisecond ||
		config.TraceExportTimeout != 2*time.Second || config.TraceShutdownTimeout != 4*time.Second ||
		config.TraceMaxQueueSize != 512 || config.TraceMaxExportBatchSize != 128 {
		t.Fatalf("tracing config = %+v", config)
	}

	invalid := []map[string]string{
		{"RGS_OTEL_TRACES_ENDPOINT": "https://collector.example"},
		{"RGS_OTEL_TRACES_ENDPOINT": "https://collector.example/v1/traces/"},
		{"RGS_OTEL_TRACES_ENDPOINT": "https://user@collector.example/v1/traces"},
		{"RGS_OTEL_TRACES_ENDPOINT": "https://collector.example/v1/traces?token=secret"},
		{"RGS_OTEL_TRACES_ENDPOINT": "https://collector.example/v1/traces#fragment"},
		{"RGS_OTEL_TRACES_ENDPOINT": "grpc://collector.example/v1/traces"},
		{"RGS_OTEL_TRACE_SAMPLE_RATIO": "NaN"},
		{"RGS_OTEL_TRACE_SAMPLE_RATIO": "+Inf"},
		{"RGS_OTEL_TRACE_SAMPLE_RATIO": "-0.01"},
		{"RGS_OTEL_TRACE_SAMPLE_RATIO": "1.01"},
		{"RGS_OTEL_BATCH_TIMEOUT": "99ms"},
		{"RGS_OTEL_EXPORT_TIMEOUT": "31s"},
		{"RGS_OTEL_SHUTDOWN_TIMEOUT": "0s"},
		{"RGS_OTEL_MAX_QUEUE_SIZE": "0"},
		{"RGS_OTEL_MAX_QUEUE_SIZE": "8193"},
		{"RGS_OTEL_MAX_EXPORT_BATCH_SIZE": "0"},
		{"RGS_OTEL_MAX_EXPORT_BATCH_SIZE": "1025"},
		{"RGS_OTEL_MAX_QUEUE_SIZE": "64", "RGS_OTEL_MAX_EXPORT_BATCH_SIZE": "65"},
	}
	for index, values := range invalid {
		if _, err := LoadConfigFrom(lookup(values)); err == nil {
			t.Fatalf("unsafe tracing config %d unexpectedly accepted: %#v", index, values)
		}
	}
}

func TestHighValueRiskConfigurationIsExplicitCompleteAndBounded(t *testing.T) {
	valid := map[string]string{
		"RGS_HIGH_VALUE_RISK_ENABLED":           "true",
		"RGS_HIGH_VALUE_RISK_THRESHOLD_MINOR":   "100000",
		"RGS_HIGH_VALUE_RISK_POLICY_VERSION":    "payout-review-v1",
		"RGS_HIGH_VALUE_RISK_REVIEW_TTL":        "30m",
		"RGS_HIGH_VALUE_RISK_EXPIRY_POLICY":     "REJECT",
		"RGS_HIGH_VALUE_RISK_EXPIRY_BATCH_SIZE": "50",
	}
	config, err := LoadConfigFrom(lookup(valid))
	if err != nil {
		t.Fatalf("valid risk config rejected: %v", err)
	}
	if !config.HighValueRiskEnabled || config.HighValueRiskThresholdMinor != 100_000 ||
		config.HighValueRiskPolicyVersion != "payout-review-v1" ||
		config.HighValueRiskReviewTTL != 30*time.Minute ||
		config.HighValueRiskExpiryPolicy != "REJECT" || config.HighValueRiskExpiryBatchSize != 50 {
		t.Fatalf("risk config = %+v", config)
	}
	for name, mutate := range map[string]func(map[string]string){
		"disabled dormant":  func(values map[string]string) { values["RGS_HIGH_VALUE_RISK_ENABLED"] = "false" },
		"missing threshold": func(values map[string]string) { delete(values, "RGS_HIGH_VALUE_RISK_THRESHOLD_MINOR") },
		"missing version":   func(values map[string]string) { delete(values, "RGS_HIGH_VALUE_RISK_POLICY_VERSION") },
		"short ttl":         func(values map[string]string) { values["RGS_HIGH_VALUE_RISK_REVIEW_TTL"] = "59s" },
		"unknown expiry":    func(values map[string]string) { values["RGS_HIGH_VALUE_RISK_EXPIRY_POLICY"] = "ALLOW" },
		"unbounded batch":   func(values map[string]string) { values["RGS_HIGH_VALUE_RISK_EXPIRY_BATCH_SIZE"] = "1001" },
	} {
		t.Run(name, func(t *testing.T) {
			values := make(map[string]string, len(valid))
			for key, value := range valid {
				values[key] = value
			}
			mutate(values)
			if _, err := LoadConfigFrom(lookup(values)); err == nil {
				t.Fatal("incomplete risk configuration unexpectedly accepted")
			}
		})
	}
}

func TestConfigBoundsGlobalPreAuthenticationRate(t *testing.T) {
	for name, values := range map[string]map[string]string{
		"zero rate":       {"RGS_PREAUTH_RATE_PER_SECOND": "0"},
		"NaN rate":        {"RGS_PREAUTH_RATE_PER_SECOND": "NaN"},
		"positive Inf":    {"RGS_PREAUTH_RATE_PER_SECOND": "+Inf"},
		"negative Inf":    {"RGS_PREAUTH_RATE_PER_SECOND": "-Inf"},
		"negative burst":  {"RGS_PREAUTH_RATE_BURST": "-1"},
		"unbounded rate":  {"RGS_PREAUTH_RATE_PER_SECOND": "1000001"},
		"unbounded burst": {"RGS_PREAUTH_RATE_BURST": "2000001"},
		"malformed":       {"RGS_PREAUTH_RATE_PER_SECOND": "many"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := LoadConfigFrom(lookup(values)); err == nil {
				t.Fatal("unsafe pre-authentication rate unexpectedly accepted")
			}
		})
	}
	config, err := LoadConfigFrom(lookup(map[string]string{
		"RGS_PREAUTH_RATE_PER_SECOND": "12500.5",
		"RGS_PREAUTH_RATE_BURST":      "25000",
	}))
	if err != nil {
		t.Fatalf("valid pre-authentication rate rejected: %v", err)
	}
	if config.PreAuthRatePerSecond != 12_500.5 || config.PreAuthRateBurst != 25_000 {
		t.Fatalf("pre-authentication rate config = %+v", config)
	}
}

func TestConfigRejectsNonFiniteProcessRate(t *testing.T) {
	for _, value := range []string{"NaN", "+Inf", "-Inf"} {
		if _, err := LoadConfigFrom(lookup(map[string]string{"RGS_RATE_PER_SECOND": value})); err == nil {
			t.Fatalf("non-finite process rate %q was accepted", value)
		}
	}
	config, err := LoadConfigFrom(lookup(map[string]string{"RGS_RATE_PER_SECOND": "20.12345"}))
	if err != nil || config.RatePerSecond != 20.12345 {
		t.Fatalf("finite process rate must not be restricted to millitokens: config=%+v err=%v", config, err)
	}
}

func TestSuccessAccessLogSamplingConfigurationBounds(t *testing.T) {
	for _, test := range []struct {
		raw  string
		want int
	}{
		{raw: "0", want: 0},
		{raw: "10000", want: 10_000},
		{raw: "1000000", want: 1_000_000},
	} {
		config, err := LoadConfigFrom(lookup(map[string]string{
			"RGS_SUCCESS_ACCESS_LOG_SAMPLE_PER_MILLION": test.raw,
		}))
		if err != nil {
			t.Fatalf("sample %s was rejected: %v", test.raw, err)
		}
		if config.SuccessAccessLogSamplePerMillion != test.want {
			t.Fatalf("sample %s parsed as %d, want %d", test.raw, config.SuccessAccessLogSamplePerMillion, test.want)
		}
	}
	for _, value := range []string{"-1", "1000001", "not-a-number"} {
		if _, err := LoadConfigFrom(lookup(map[string]string{
			"RGS_SUCCESS_ACCESS_LOG_SAMPLE_PER_MILLION": value,
		})); err == nil {
			t.Fatalf("unsafe sample %s was accepted", value)
		}
	}
}

func TestRuntimeRolesExposeOnlyTheirIntendedWorkloads(t *testing.T) {
	for _, test := range []struct {
		role        RuntimeRole
		servesAPI   bool
		runsWorkers bool
	}{
		{role: RuntimeRoleCombined, servesAPI: true, runsWorkers: true},
		{role: RuntimeRoleAPI, servesAPI: true, runsWorkers: false},
		{role: RuntimeRoleWorker, servesAPI: false, runsWorkers: true},
	} {
		if test.role.ServesPublicAPI() != test.servesAPI ||
			test.role.RunsBackgroundWorkloads() != test.runsWorkers {
			t.Fatalf("role %q exposure = api:%v workers:%v", test.role,
				test.role.ServesPublicAPI(), test.role.RunsBackgroundWorkloads())
		}
	}
}

func TestRuntimeConfigNeverFallsBackToMigratorCredential(t *testing.T) {
	config, err := LoadConfigFrom(lookup(map[string]string{
		"RGS_MIGRATOR_DATABASE_URL": "postgres://migration-secret",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if config.DatabaseURL != "" {
		t.Fatalf("runtime database URL unexpectedly read migrator credential: %q", config.DatabaseURL)
	}
}

func TestRuntimeConfigLoadsWalletRootCAFile(t *testing.T) {
	config, err := LoadConfigFrom(lookup(map[string]string{
		"RGS_WALLET_ROOT_CA_FILE": " /run/secrets/wallet-root.pem ",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if config.WalletRootCAFile != "/run/secrets/wallet-root.pem" {
		t.Fatalf("WalletRootCAFile = %q", config.WalletRootCAFile)
	}
}

func TestProductionConfigFailsClosed(t *testing.T) {
	_, err := LoadConfigFrom(lookup(map[string]string{"RGS_ENVIRONMENT": "production"}))
	if err == nil || !strings.Contains(err.Error(), "RGS_DATABASE_URL") {
		t.Fatalf("missing production settings error = %v", err)
	}

	values := map[string]string{
		"RGS_ENVIRONMENT":                         "production",
		"RGS_DATABASE_URL":                        "postgres://db/rgs?sslmode=verify-full",
		"RGS_PUBLIC_BASE_URL":                     "https://rgs.example",
		"RGS_TLS_TERMINATED_UPSTREAM":             "true",
		"RGS_ALLOWED_ORIGINS":                     "https://casino.example",
		"RGS_OPERATOR_CONFIG_FILE":                "/run/config/operators.json",
		"RGS_DEFINITION_FILE":                     "/run/config/game-definition.json",
		"RGS_DEFINITION_APPROVAL_FILE":            "/run/config/definition.json",
		"RGS_DEFINITION_APPROVAL_PUBLIC_KEY_FILE": "/run/secrets/definition-approval-public.pem",
		"RGS_EXPECTED_DEFINITION_GAME_ID":         "iron-colossus",
		"RGS_EXPECTED_DEFINITION_VERSION":         "definition-v1",
		"RGS_EXPECTED_DEFINITION_SHA256":          strings.Repeat("a", 64),
		"RGS_LAUNCH_HMAC_KEY_FILE":                "/run/secrets/launch-hmac.key",
		"RGS_OPERATIONS_BEARER_TOKEN_FILE":        "/run/secrets/operations-bearer.token",
		"RGS_OUTBOX_ENDPOINT_URL":                 "https://audit.example/rgs/v1/events",
		"RGS_OUTBOX_HMAC_KEY_ID":                  "audit-2026-01",
		"RGS_OUTBOX_HMAC_KEY_FILE":                "/run/secrets/outbox-hmac.key",
		"RGS_SHARED_ADMISSION_URL":                "rediss://valkey.example:6379",
		"RGS_SHARED_ADMISSION_USERNAME":           "rgs-api",
		"RGS_SHARED_ADMISSION_PASSWORD_FILE":      "/run/secrets/valkey-password",
		"RGS_SHARED_ADMISSION_HMAC_KEY_FILE":      "/run/secrets/admission-hmac.key",
		"RGS_SHARED_ADMISSION_ROOT_CA_FILE":       "/run/config/valkey-root.pem",
	}
	config, err := LoadConfigFrom(lookup(values))
	if err != nil {
		t.Fatalf("valid production config rejected: %v", err)
	}
	if config.Environment != Production || config.PublicBaseURL != values["RGS_PUBLIC_BASE_URL"] {
		t.Fatalf("unexpected production config: %+v", config)
	}
	values["RGS_OTEL_TRACES_ENDPOINT"] = "http://collector.internal/v1/traces"
	if _, err := LoadConfigFrom(lookup(values)); err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("production plaintext remote trace endpoint error = %v", err)
	}
	values["RGS_OTEL_TRACES_ENDPOINT"] = "http://127.0.0.1:4318/v1/traces"
	if _, err := LoadConfigFrom(lookup(values)); err != nil {
		t.Fatalf("production loopback collector rejected: %v", err)
	}
	values["RGS_OTEL_TRACES_ENDPOINT"] = "https://collector.internal/v1/traces"
	if _, err := LoadConfigFrom(lookup(values)); err != nil {
		t.Fatalf("production TLS collector rejected: %v", err)
	}
	delete(values, "RGS_OTEL_TRACES_ENDPOINT")
	missingOperationsBearer := make(map[string]string, len(values)-1)
	for key, value := range values {
		if key != "RGS_OPERATIONS_BEARER_TOKEN_FILE" {
			missingOperationsBearer[key] = value
		}
	}
	if _, err := LoadConfigFrom(lookup(missingOperationsBearer)); err == nil ||
		!strings.Contains(err.Error(), "RGS_OPERATIONS_BEARER_TOKEN_FILE") {
		t.Fatalf("missing operations bearer token error = %v", err)
	}

	apiValues := make(map[string]string, len(values))
	for key, value := range values {
		if strings.HasPrefix(key, "RGS_OUTBOX_") {
			continue
		}
		apiValues[key] = value
	}
	apiValues["RGS_RUNTIME_ROLE"] = "api"
	apiValues["RGS_SHARED_ADMISSION_URL"] = "rediss://valkey.example:6379"
	apiValues["RGS_SHARED_ADMISSION_USERNAME"] = "rgs-api"
	apiValues["RGS_SHARED_ADMISSION_PASSWORD_FILE"] = "/run/secrets/valkey-password"
	apiValues["RGS_SHARED_ADMISSION_HMAC_KEY_FILE"] = "/run/secrets/admission-hmac.key"
	apiValues["RGS_SHARED_ADMISSION_ROOT_CA_FILE"] = "/run/config/valkey-root.pem"
	apiConfig, err := LoadConfigFrom(lookup(apiValues))
	if err != nil {
		t.Fatalf("valid production api config rejected: %v", err)
	}
	if apiConfig.RuntimeRole != RuntimeRoleAPI || apiConfig.RuntimeRole.RunsBackgroundWorkloads() {
		t.Fatalf("unexpected api role config: %+v", apiConfig)
	}
	apiValues["RGS_OUTBOX_ENDPOINT_URL"] = values["RGS_OUTBOX_ENDPOINT_URL"]
	if _, err := LoadConfigFrom(lookup(apiValues)); err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("api outbox configuration error = %v", err)
	}

	workerValues := make(map[string]string, len(values)+1)
	for key, value := range values {
		workerValues[key] = value
	}
	workerValues["RGS_RUNTIME_ROLE"] = "worker"
	delete(workerValues, "RGS_LAUNCH_HMAC_KEY_FILE")
	for _, name := range []string{
		"RGS_SHARED_ADMISSION_URL", "RGS_SHARED_ADMISSION_USERNAME",
		"RGS_SHARED_ADMISSION_PASSWORD_FILE", "RGS_SHARED_ADMISSION_HMAC_KEY_FILE",
		"RGS_SHARED_ADMISSION_ROOT_CA_FILE",
	} {
		delete(workerValues, name)
	}
	workerConfig, err := LoadConfigFrom(lookup(workerValues))
	if err != nil {
		t.Fatalf("valid production worker config rejected: %v", err)
	}
	if workerConfig.RuntimeRole != RuntimeRoleWorker || workerConfig.RuntimeRole.ServesPublicAPI() {
		t.Fatalf("unexpected worker role config: %+v", workerConfig)
	}
	if workerConfig.LaunchHMACKeyFile != "" {
		t.Fatalf("worker retained launch HMAC configuration: %q", workerConfig.LaunchHMACKeyFile)
	}
	missingDefinitionIdentity := make(map[string]string, len(workerValues)-1)
	for key, value := range workerValues {
		if key != "RGS_EXPECTED_DEFINITION_SHA256" {
			missingDefinitionIdentity[key] = value
		}
	}
	if _, err := LoadConfigFrom(lookup(missingDefinitionIdentity)); err == nil ||
		!strings.Contains(err.Error(), "RGS_EXPECTED_DEFINITION_SHA256") {
		t.Fatalf("worker without expected definition digest error = %v", err)
	}
	delete(workerValues, "RGS_OUTBOX_ENDPOINT_URL")
	if _, err := LoadConfigFrom(lookup(workerValues)); err == nil ||
		!strings.Contains(err.Error(), "RGS_OUTBOX_ENDPOINT_URL") {
		t.Fatalf("worker without outbox endpoint error = %v", err)
	}

	if _, err := LoadConfigFrom(lookup(map[string]string{"RGS_RUNTIME_ROLE": "unexpected"})); err == nil ||
		!strings.Contains(err.Error(), "RGS_RUNTIME_ROLE") {
		t.Fatalf("invalid runtime role error = %v", err)
	}
	if _, err := LoadConfigFrom(lookup(map[string]string{"RGS_RUNTIME_ROLE": "worker"})); err == nil ||
		!strings.Contains(err.Error(), "RGS_OUTBOX_ENDPOINT_URL") {
		t.Fatalf("worker without outbox error = %v", err)
	}
}

func TestSharedAdmissionConfigFailsClosed(t *testing.T) {
	valid := map[string]string{
		"RGS_SHARED_ADMISSION_URL":              "rediss://valkey.example:6379",
		"RGS_SHARED_ADMISSION_USERNAME":         "rgs-api",
		"RGS_SHARED_ADMISSION_PASSWORD_FILE":    "/run/secrets/valkey-password",
		"RGS_SHARED_ADMISSION_HMAC_KEY_FILE":    "/run/secrets/admission-hmac.key",
		"RGS_SHARED_ADMISSION_ROOT_CA_FILE":     "/run/config/valkey-root.pem",
		"RGS_SHARED_ADMISSION_TIMEOUT":          "75ms",
		"RGS_SHARED_ADMISSION_RATE_PER_SECOND":  "125.5",
		"RGS_SHARED_ADMISSION_RATE_BURST":       "300",
		"RGS_ECONOMIC_OPERATOR_RATE_PER_SECOND": "25.5",
		"RGS_ECONOMIC_OPERATOR_RATE_BURST":      "60",
		"RGS_ECONOMIC_BACKEND_RATE_PER_SECOND":  "125.5",
		"RGS_ECONOMIC_BACKEND_RATE_BURST":       "300",
		"RGS_RATE_PER_SECOND":                   "50",
		"RGS_RATE_BURST":                        "100",
	}
	config, err := LoadConfigFrom(lookup(valid))
	if err != nil {
		t.Fatalf("valid shared admission config rejected: %v", err)
	}
	if config.SharedAdmissionTimeout.String() != "75ms" || config.SharedAdmissionRatePerSecond != 125.5 ||
		config.SharedAdmissionRateBurst != 300 || config.RatePerSecond != 50 || config.RateBurst != 100 ||
		config.EconomicOperatorRatePerSecond != 25.5 || config.EconomicOperatorRateBurst != 60 ||
		config.EconomicBackendRatePerSecond != 125.5 || config.EconomicBackendRateBurst != 300 {
		t.Fatalf("shared admission timeout = %s", config.SharedAdmissionTimeout)
	}
	boundary := make(map[string]string, len(valid))
	for key, value := range valid {
		boundary[key] = value
	}
	boundary["RGS_SHARED_ADMISSION_RATE_PER_SECOND"] = "1"
	boundary["RGS_SHARED_ADMISSION_RATE_BURST"] = "86399"
	if _, err := LoadConfigFrom(lookup(boundary)); err != nil {
		t.Fatalf("exact 24-hour shared admission TTL rejected: %v", err)
	}
	boundary["RGS_SHARED_ADMISSION_RATE_BURST"] = "86400"
	if _, err := LoadConfigFrom(lookup(boundary)); err == nil || !strings.Contains(err.Error(), "TTL") {
		t.Fatalf("over-24-hour shared admission TTL error = %v", err)
	}

	for name, mutate := range map[string]func(map[string]string){
		"plain scheme": func(values map[string]string) { values["RGS_SHARED_ADMISSION_URL"] = "redis://valkey.example:6379" },
		"embedded credential": func(values map[string]string) {
			values["RGS_SHARED_ADMISSION_URL"] = "rediss://user:secret@valkey.example:6379"
		},
		"relative password":                 func(values map[string]string) { values["RGS_SHARED_ADMISSION_PASSWORD_FILE"] = "password" },
		"missing root CA":                   func(values map[string]string) { delete(values, "RGS_SHARED_ADMISSION_ROOT_CA_FILE") },
		"excess timeout":                    func(values map[string]string) { values["RGS_SHARED_ADMISSION_TIMEOUT"] = "501ms" },
		"zero rate":                         func(values map[string]string) { values["RGS_SHARED_ADMISSION_RATE_PER_SECOND"] = "0" },
		"non-finite shared rate":            func(values map[string]string) { values["RGS_SHARED_ADMISSION_RATE_PER_SECOND"] = "NaN" },
		"fractional shared millitoken rate": func(values map[string]string) { values["RGS_SHARED_ADMISSION_RATE_PER_SECOND"] = "125.5001" },
		"zero operator economic rate":       func(values map[string]string) { values["RGS_ECONOMIC_OPERATOR_RATE_PER_SECOND"] = "0" },
		"non-finite backend economic rate":  func(values map[string]string) { values["RGS_ECONOMIC_BACKEND_RATE_PER_SECOND"] = "+Inf" },
		"fractional operator millitoken rate": func(values map[string]string) {
			values["RGS_ECONOMIC_OPERATOR_RATE_PER_SECOND"] = "25.5005"
		},
		"fractional backend millitoken rate": func(values map[string]string) {
			values["RGS_ECONOMIC_BACKEND_RATE_PER_SECOND"] = "125.5001"
		},
		"unbounded operator economic ttl": func(values map[string]string) {
			values["RGS_ECONOMIC_OPERATOR_RATE_PER_SECOND"] = "0.001"
			values["RGS_ECONOMIC_OPERATOR_RATE_BURST"] = "100"
		},
		"unbounded key ttl": func(values map[string]string) {
			values["RGS_SHARED_ADMISSION_RATE_PER_SECOND"] = "0.001"
			values["RGS_SHARED_ADMISSION_RATE_BURST"] = "100"
		},
	} {
		t.Run(name, func(t *testing.T) {
			values := make(map[string]string, len(valid))
			for key, value := range valid {
				values[key] = value
			}
			mutate(values)
			if _, err := LoadConfigFrom(lookup(values)); err == nil {
				t.Fatal("unsafe shared admission config unexpectedly accepted")
			}
		})
	}

	worker := make(map[string]string, len(valid)+2)
	for key, value := range valid {
		worker[key] = value
	}
	worker["RGS_RUNTIME_ROLE"] = "worker"
	worker["RGS_OUTBOX_ENDPOINT_URL"] = "https://audit.example/events"
	worker["RGS_OUTBOX_HMAC_KEY_ID"] = "key-1"
	worker["RGS_OUTBOX_HMAC_KEY_FILE"] = "/run/secrets/outbox.key"
	if _, err := LoadConfigFrom(lookup(worker)); err == nil || !strings.Contains(err.Error(), "worker runtime role") {
		t.Fatalf("worker shared admission error = %v", err)
	}
}

func TestProductionDatabaseURLRequiresVerifyFull(t *testing.T) {
	base := map[string]string{
		"RGS_ENVIRONMENT":                         "production",
		"RGS_PUBLIC_BASE_URL":                     "https://rgs.example",
		"RGS_TLS_TERMINATED_UPSTREAM":             "true",
		"RGS_ALLOWED_ORIGINS":                     "https://casino.example",
		"RGS_OPERATOR_CONFIG_FILE":                "/run/config/operators.json",
		"RGS_DEFINITION_FILE":                     "/run/config/game-definition.json",
		"RGS_DEFINITION_APPROVAL_FILE":            "/run/config/definition.json",
		"RGS_DEFINITION_APPROVAL_PUBLIC_KEY_FILE": "/run/secrets/definition-approval-public.pem",
		"RGS_LAUNCH_HMAC_KEY_FILE":                "/run/secrets/launch-hmac.key",
		"RGS_OPERATIONS_BEARER_TOKEN_FILE":        "/run/secrets/operations-bearer.token",
		"RGS_OUTBOX_ENDPOINT_URL":                 "https://audit.example/rgs/v1/events",
		"RGS_OUTBOX_HMAC_KEY_ID":                  "audit-2026-01",
		"RGS_OUTBOX_HMAC_KEY_FILE":                "/run/secrets/outbox-hmac.key",
		"RGS_SHARED_ADMISSION_URL":                "rediss://valkey.example:6379",
		"RGS_SHARED_ADMISSION_USERNAME":           "rgs-api",
		"RGS_SHARED_ADMISSION_PASSWORD_FILE":      "/run/secrets/valkey-password",
		"RGS_SHARED_ADMISSION_HMAC_KEY_FILE":      "/run/secrets/admission-hmac.key",
		"RGS_SHARED_ADMISSION_ROOT_CA_FILE":       "/run/config/valkey-root.pem",
	}
	tests := []struct {
		name     string
		database string
		wantErr  bool
	}{
		{name: "verify full", database: "postgres://db/rgs?sslmode=verify-full"},
		{name: "missing sslmode", database: "postgres://db/rgs", wantErr: true},
		{name: "disable", database: "postgres://db/rgs?sslmode=disable", wantErr: true},
		{name: "require", database: "postgres://db/rgs?sslmode=require", wantErr: true},
		{name: "verify ca", database: "postgres://db/rgs?sslmode=verify-ca", wantErr: true},
		{name: "noncanonical sslmode", database: "postgres://db/rgs?SSLMODE=verify-full", wantErr: true},
		{name: "conflicting sslmode", database: "postgres://db/rgs?sslmode=verify-full&sslmode=disable", wantErr: true},
		{name: "duplicate sslmode", database: "postgres://db/rgs?sslmode=verify-full&sslmode=verify-full", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			values := make(map[string]string, len(base)+1)
			for key, value := range base {
				values[key] = value
			}
			values["RGS_DATABASE_URL"] = test.database
			_, err := LoadConfigFrom(lookup(values))
			if test.wantErr {
				if err == nil || !strings.Contains(err.Error(), "sslmode=verify-full") {
					t.Fatalf("LoadConfigFrom error = %v, want sslmode=verify-full rejection", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("LoadConfigFrom returned error: %v", err)
			}
		})
	}

	for _, environment := range []string{"development", "staging"} {
		t.Run(environment+" remains unchanged", func(t *testing.T) {
			config, err := LoadConfigFrom(lookup(map[string]string{
				"RGS_ENVIRONMENT":  environment,
				"RGS_DATABASE_URL": "postgres://db/rgs?sslmode=disable",
			}))
			if err != nil {
				t.Fatalf("%s database URL unexpectedly rejected: %v", environment, err)
			}
			if config.DatabaseURL != "postgres://db/rgs?sslmode=disable" {
				t.Fatalf("unexpected %s database URL: %q", environment, config.DatabaseURL)
			}
		})
	}
}

func TestProductionOperationsListenerMustRemainSeparate(t *testing.T) {
	base := map[string]string{
		"RGS_ENVIRONMENT":                         "production",
		"RGS_DATABASE_URL":                        "postgres://db/rgs?sslmode=verify-full",
		"RGS_PUBLIC_BASE_URL":                     "https://rgs.example",
		"RGS_TLS_TERMINATED_UPSTREAM":             "true",
		"RGS_ALLOWED_ORIGINS":                     "https://casino.example",
		"RGS_OPERATOR_CONFIG_FILE":                "/run/config/operators.json",
		"RGS_DEFINITION_FILE":                     "/run/config/game-definition.json",
		"RGS_DEFINITION_APPROVAL_FILE":            "/run/config/definition.json",
		"RGS_DEFINITION_APPROVAL_PUBLIC_KEY_FILE": "/run/secrets/definition-approval-public.pem",
		"RGS_LAUNCH_HMAC_KEY_FILE":                "/run/secrets/launch-hmac.key",
		"RGS_OPERATIONS_BEARER_TOKEN_FILE":        "/run/secrets/operations-bearer.token",
		"RGS_OUTBOX_ENDPOINT_URL":                 "https://audit.example/rgs/v1/events",
		"RGS_OUTBOX_HMAC_KEY_ID":                  "audit-2026-01",
		"RGS_OUTBOX_HMAC_KEY_FILE":                "/run/secrets/outbox-hmac.key",
		"RGS_SHARED_ADMISSION_URL":                "rediss://valkey.example:6379",
		"RGS_SHARED_ADMISSION_USERNAME":           "rgs-api",
		"RGS_SHARED_ADMISSION_PASSWORD_FILE":      "/run/secrets/valkey-password",
		"RGS_SHARED_ADMISSION_HMAC_KEY_FILE":      "/run/secrets/admission-hmac.key",
		"RGS_SHARED_ADMISSION_ROOT_CA_FILE":       "/run/config/valkey-root.pem",
	}
	for name, operationsAddress := range map[string]string{
		"same":                       ":8080",
		"wildcard overlaps loopback": "127.0.0.1:8080",
	} {
		t.Run(name, func(t *testing.T) {
			values := make(map[string]string, len(base)+1)
			for key, value := range base {
				values[key] = value
			}
			values["RGS_OPERATIONS_HTTP_ADDR"] = operationsAddress
			if _, err := LoadConfigFrom(lookup(values)); err == nil || !strings.Contains(err.Error(), "must not conflict") {
				t.Fatalf("operations/public conflict error = %v", err)
			}
		})
	}

	separate := make(map[string]string, len(base)+1)
	for key, value := range base {
		separate[key] = value
	}
	separate["RGS_OPERATIONS_HTTP_ADDR"] = "127.0.0.1:8081"
	if _, err := LoadConfigFrom(lookup(separate)); err != nil {
		t.Fatalf("separate operations listener rejected: %v", err)
	}
	if _, err := LoadConfigFrom(lookup(map[string]string{
		"RGS_OPERATIONS_HTTP_ADDR": "not-a-listen-address",
	})); err == nil || !strings.Contains(err.Error(), "host:port") {
		t.Fatalf("invalid operations listener error = %v", err)
	}
}

func TestNonLoopbackOperationsListenerRequiresBearerInEveryEnvironment(t *testing.T) {
	for _, environment := range []string{"development", "staging"} {
		t.Run(environment, func(t *testing.T) {
			values := map[string]string{
				"RGS_ENVIRONMENT":          environment,
				"RGS_OPERATIONS_HTTP_ADDR": ":8081",
			}
			if _, err := LoadConfigFrom(lookup(values)); err == nil ||
				!strings.Contains(err.Error(), "RGS_OPERATIONS_BEARER_TOKEN_FILE") {
				t.Fatalf("unauthenticated non-loopback operations listener error = %v", err)
			}
			values["RGS_OPERATIONS_BEARER_TOKEN_FILE"] = "/run/secrets/operations.token"
			if _, err := LoadConfigFrom(lookup(values)); err != nil {
				t.Fatalf("authenticated non-loopback operations listener rejected: %v", err)
			}
		})
	}

	for _, environment := range []string{"development", "staging"} {
		t.Run(environment+" loopback may omit bearer", func(t *testing.T) {
			if _, err := LoadConfigFrom(lookup(map[string]string{
				"RGS_ENVIRONMENT":          environment,
				"RGS_OPERATIONS_HTTP_ADDR": "127.0.0.1:8081",
			})); err != nil {
				t.Fatalf("loopback operations listener rejected: %v", err)
			}
		})
	}
}

func TestConfigRejectsUnsafeOriginsAndCredentialTTLs(t *testing.T) {
	for name, values := range map[string]map[string]string{
		"wildcard":                     {"RGS_ALLOWED_ORIGINS": "*"},
		"long launch":                  {"RGS_LAUNCH_TTL": "6m"},
		"tiny body":                    {"RGS_MAX_REQUEST_BYTES": "12"},
		"body below public contract":   {"RGS_MAX_REQUEST_BYTES": "4096"},
		"body exceeds edge inspection": {"RGS_MAX_REQUEST_BYTES": "8193"},
		"partial outbox":               {"RGS_OUTBOX_HMAC_KEY_ID": "key-1"},
		"plain staging sink": {
			"RGS_ENVIRONMENT": "staging", "RGS_OUTBOX_ENDPOINT_URL": "http://audit.example/events",
			"RGS_OUTBOX_HMAC_KEY_ID": "key-1", "RGS_OUTBOX_HMAC_KEY_FILE": "/run/key",
		},
		"short outbox lease": {
			"RGS_OUTBOX_LEASE_DURATION": "10s", "RGS_OUTBOX_PUBLISH_TIMEOUT": "10s",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := LoadConfigFrom(lookup(values)); err == nil {
				t.Fatal("unsafe config unexpectedly accepted")
			}
		})
	}
}

func TestConfigRejectsUnboundedRuntimeTimeouts(t *testing.T) {
	for name, values := range map[string]map[string]string{
		"read header exceeds read timeout": {
			"RGS_READ_HEADER_TIMEOUT": "16s",
		},
		"read header exceeds hard cap": {
			"RGS_READ_HEADER_TIMEOUT": "11s",
		},
		"read exceeds hard cap": {
			"RGS_READ_TIMEOUT":    "31s",
			"RGS_REQUEST_TIMEOUT": "40s",
			"RGS_WRITE_TIMEOUT":   "50s",
		},
		"request exceeds hard cap": {
			"RGS_REQUEST_TIMEOUT": "61s",
			"RGS_WRITE_TIMEOUT":   "70s",
		},
		"write exceeds hard cap": {
			"RGS_WRITE_TIMEOUT": "91s",
		},
		"idle exceeds hard cap": {
			"RGS_IDLE_TIMEOUT": "6m",
		},
		"shutdown exceeds hard cap": {
			"RGS_SHUTDOWN_TIMEOUT": "6m",
		},
		"read exceeds request timeout": {
			"RGS_READ_TIMEOUT": "16s",
		},
		"request equals write timeout": {
			"RGS_REQUEST_TIMEOUT": "20s",
		},
		"statement reaches request timeout": {
			"RGS_REQUEST_TIMEOUT":      "10s",
			"RGS_DB_STATEMENT_TIMEOUT": "10s",
		},
		"lock exceeds statement timeout": {
			"RGS_REQUEST_TIMEOUT":      "12s",
			"RGS_DB_STATEMENT_TIMEOUT": "8s",
			"RGS_DB_LOCK_TIMEOUT":      "9s",
		},
		"malformed statement timeout": {
			"RGS_DB_STATEMENT_TIMEOUT": "not-a-duration",
		},
		"sub millisecond lock timeout": {
			"RGS_DB_LOCK_TIMEOUT": "500us",
		},
		"wallet reaches request timeout": {
			"RGS_WALLET_TIMEOUT": "15s",
		},
		"fast path is zero": {
			"RGS_WALLET_FAST_PATH_TIMEOUT": "0s",
		},
		"fast path reaches wallet timeout": {
			"RGS_WALLET_FAST_PATH_TIMEOUT": "4s",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := LoadConfigFrom(lookup(values)); err == nil {
				t.Fatal("unsafe runtime timeout configuration unexpectedly accepted")
			}
		})
	}

	config, err := LoadConfigFrom(lookup(map[string]string{
		"RGS_READ_TIMEOUT":         "14s",
		"RGS_REQUEST_TIMEOUT":      "14s",
		"RGS_DB_STATEMENT_TIMEOUT": "9s",
		"RGS_DB_LOCK_TIMEOUT":      "1500ms",
	}))
	if err != nil {
		t.Fatalf("valid runtime timeout configuration rejected: %v", err)
	}
	if config.RequestTimeout.String() != "14s" || config.DatabaseStatementTimeout.String() != "9s" ||
		config.DatabaseLockTimeout.String() != "1.5s" {
		t.Fatalf("runtime timeouts = request:%s statement:%s lock:%s", config.RequestTimeout, config.DatabaseStatementTimeout, config.DatabaseLockTimeout)
	}

	config, err = LoadConfigFrom(lookup(map[string]string{
		"RGS_WALLET_FAST_PATH_TIMEOUT": "750ms",
		"RGS_WALLET_TIMEOUT":           "4s",
	}))
	if err != nil {
		t.Fatalf("valid wallet fast-path timeout rejected: %v", err)
	}
	if config.WalletFastPathTimeout != 750_000_000 {
		t.Fatalf("wallet fast-path timeout = %s, want 750ms", config.WalletFastPathTimeout)
	}
}

func TestConfigBoundsPerReplicaDatabasePool(t *testing.T) {
	for name, values := range map[string]map[string]string{
		"zero max open": {
			"RGS_DB_MAX_OPEN_CONNS": "0",
		},
		"max open above safety cap": {
			"RGS_DB_MAX_OPEN_CONNS": "201",
		},
		"negative idle": {
			"RGS_DB_MAX_IDLE_CONNS": "-1",
		},
		"idle exceeds open": {
			"RGS_DB_MAX_OPEN_CONNS": "8",
			"RGS_DB_MAX_IDLE_CONNS": "9",
		},
		"malformed max open": {
			"RGS_DB_MAX_OPEN_CONNS": "many",
		},
		"zero new intent reserve": {
			"RGS_DB_CRITICAL_RESERVE_CONNS": "0",
		},
		"reserve reaches max open": {
			"RGS_DB_MAX_OPEN_CONNS":         "8",
			"RGS_DB_CRITICAL_RESERVE_CONNS": "8",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := LoadConfigFrom(lookup(values)); err == nil {
				t.Fatal("unsafe database pool configuration unexpectedly accepted")
			}
		})
	}

	config, err := LoadConfigFrom(lookup(map[string]string{
		"RGS_DB_MAX_OPEN_CONNS":         "24",
		"RGS_DB_MAX_IDLE_CONNS":         "6",
		"RGS_DB_CRITICAL_RESERVE_CONNS": "7",
	}))
	if err != nil {
		t.Fatalf("valid database pool configuration rejected: %v", err)
	}
	if config.DatabaseMaxOpenConns != 24 || config.DatabaseMaxIdleConns != 6 ||
		config.DatabaseCriticalReserveConns != 7 {
		t.Fatalf("database pool = open:%d idle:%d reserve:%d", config.DatabaseMaxOpenConns,
			config.DatabaseMaxIdleConns, config.DatabaseCriticalReserveConns)
	}
}

func TestConfigBoundsPublicInFlightRequests(t *testing.T) {
	for name, value := range map[string]string{
		"zero":      "0",
		"negative":  "-1",
		"above cap": "4097",
		"malformed": "many",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := LoadConfigFrom(lookup(map[string]string{
				"RGS_MAX_IN_FLIGHT_REQUESTS": value,
			})); err == nil {
				t.Fatal("unsafe public in-flight limit unexpectedly accepted")
			}
		})
	}

	config, err := LoadConfigFrom(lookup(map[string]string{
		"RGS_MAX_IN_FLIGHT_REQUESTS": "64",
	}))
	if err != nil {
		t.Fatalf("valid public in-flight limit rejected: %v", err)
	}
	if config.MaxInFlightRequests != 64 {
		t.Fatalf("MaxInFlightRequests = %d, want 64", config.MaxInFlightRequests)
	}
}

func TestConfigRejectsSpoofableRecoveryReserveAndBoundsAnonymousCryptoCapacity(t *testing.T) {
	for name, values := range map[string]map[string]string{
		"legacy public path reserve": {
			"RGS_RECOVERY_IN_FLIGHT_RESERVE": "16",
		},
		"legacy crypto path reserve": {
			"RGS_CRYPTO_RECOVERY_RESERVE": "8",
		},
		"zero crypto slots": {
			"RGS_MAX_CRYPTO_IN_FLIGHT": "0",
		},
		"negative crypto slots": {
			"RGS_MAX_CRYPTO_IN_FLIGHT": "-1",
		},
		"unbounded crypto slots": {
			"RGS_MAX_CRYPTO_IN_FLIGHT": "1025",
		},
		"malformed crypto slots": {
			"RGS_MAX_CRYPTO_IN_FLIGHT": "many",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := LoadConfigFrom(lookup(values)); err == nil {
				t.Fatal("unsafe anonymous crypto/recovery capacity unexpectedly accepted")
			}
		})
	}

	config, err := LoadConfigFrom(lookup(map[string]string{
		"RGS_MAX_IN_FLIGHT_REQUESTS": "96",
		"RGS_MAX_CRYPTO_IN_FLIGHT":   "1",
	}))
	if err != nil {
		t.Fatalf("valid anonymous capacity rejected: %v", err)
	}
	if config.MaxInFlightRequests != 96 || config.MaxCryptoInFlight != 1 {
		t.Fatalf("capacity config = %+v", config)
	}
}

func TestConfigBoundsAcceptedConnectionsPerListener(t *testing.T) {
	for name, value := range map[string]string{
		"zero":      "0",
		"negative":  "-1",
		"above cap": "16385",
		"malformed": "many",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := LoadConfigFrom(lookup(map[string]string{
				"RGS_MAX_CONNECTIONS_PER_LISTENER": value,
			})); err == nil {
				t.Fatal("unsafe accepted-connection limit unexpectedly accepted")
			}
		})
	}

	config, err := LoadConfigFrom(lookup(map[string]string{
		"RGS_MAX_CONNECTIONS_PER_LISTENER": "512",
	}))
	if err != nil {
		t.Fatalf("valid accepted-connection limit rejected: %v", err)
	}
	if config.MaxConnectionsPerListener != 512 {
		t.Fatalf("MaxConnectionsPerListener = %d, want 512", config.MaxConnectionsPerListener)
	}
}
