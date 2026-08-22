package platform

import (
	"strings"
	"testing"
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
	if config.MaxRequestBytes != 64<<10 || config.LaunchTTL.String() != "2m0s" ||
		config.RequestTimeout.String() != "15s" ||
		config.DatabaseStatementTimeout.String() != "10s" ||
		config.DatabaseLockTimeout.String() != "2s" ||
		config.DatabaseMaxOpenConns != 40 || config.DatabaseMaxIdleConns != 10 ||
		config.DatabaseCriticalReserveConns != 5 ||
		config.WalletTimeout.String() != "4s" || config.WalletFastPathTimeout.String() != "1s" ||
		config.MaxInFlightRequests != 256 ||
		config.MaxConnectionsPerListener != 1_024 ||
		config.SuccessAccessLogSamplePerMillion != 1_000_000 ||
		config.OperationsHTTPAddress != "127.0.0.1:8081" ||
		config.RuntimeRole != RuntimeRoleCombined {
		t.Fatalf("unexpected defaults: %+v", config)
	}
	if config.OutboxEndpointURL != "" {
		t.Fatalf("development default unexpectedly enables external delivery: %q", config.OutboxEndpointURL)
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
	}
	config, err := LoadConfigFrom(lookup(values))
	if err != nil {
		t.Fatalf("valid production config rejected: %v", err)
	}
	if config.Environment != Production || config.PublicBaseURL != values["RGS_PUBLIC_BASE_URL"] {
		t.Fatalf("unexpected production config: %+v", config)
	}
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
		"RGS_SHARED_ADMISSION_URL":             "rediss://valkey.example:6379",
		"RGS_SHARED_ADMISSION_USERNAME":        "rgs-api",
		"RGS_SHARED_ADMISSION_PASSWORD_FILE":   "/run/secrets/valkey-password",
		"RGS_SHARED_ADMISSION_HMAC_KEY_FILE":   "/run/secrets/admission-hmac.key",
		"RGS_SHARED_ADMISSION_ROOT_CA_FILE":    "/run/config/valkey-root.pem",
		"RGS_SHARED_ADMISSION_TIMEOUT":         "75ms",
		"RGS_SHARED_ADMISSION_RATE_PER_SECOND": "125.5",
		"RGS_SHARED_ADMISSION_RATE_BURST":      "300",
		"RGS_RATE_PER_SECOND":                  "50",
		"RGS_RATE_BURST":                       "100",
	}
	config, err := LoadConfigFrom(lookup(valid))
	if err != nil {
		t.Fatalf("valid shared admission config rejected: %v", err)
	}
	if config.SharedAdmissionTimeout.String() != "75ms" || config.SharedAdmissionRatePerSecond != 125.5 ||
		config.SharedAdmissionRateBurst != 300 || config.RatePerSecond != 50 || config.RateBurst != 100 {
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
		"relative password": func(values map[string]string) { values["RGS_SHARED_ADMISSION_PASSWORD_FILE"] = "password" },
		"missing root CA":   func(values map[string]string) { delete(values, "RGS_SHARED_ADMISSION_ROOT_CA_FILE") },
		"excess timeout":    func(values map[string]string) { values["RGS_SHARED_ADMISSION_TIMEOUT"] = "501ms" },
		"zero rate":         func(values map[string]string) { values["RGS_SHARED_ADMISSION_RATE_PER_SECOND"] = "0" },
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
		"wildcard":       {"RGS_ALLOWED_ORIGINS": "*"},
		"long launch":    {"RGS_LAUNCH_TTL": "6m"},
		"tiny body":      {"RGS_MAX_REQUEST_BYTES": "12"},
		"partial outbox": {"RGS_OUTBOX_HMAC_KEY_ID": "key-1"},
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
