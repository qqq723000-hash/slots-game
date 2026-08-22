package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"slots-game/server/internal/game"
	"slots-game/server/internal/platform"
)

func TestRuntimeDatabaseReadinessChecksIncludeSchemaAndPrivileges(t *testing.T) {
	checks, err := runtimeDatabaseReadinessChecks(&sql.DB{})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"database_schema", "database_privileges"}
	if len(checks) != len(want) {
		t.Fatalf("checks = %d, want %d", len(checks), len(want))
	}
	for index, name := range want {
		if checks[index].Name() != name {
			t.Fatalf("checks[%d].Name() = %q, want %q", index, checks[index].Name(), name)
		}
	}
}

func TestProductionSelectsStrictDefinitionApprovalPolicy(t *testing.T) {
	if options := definitionLoadOptions(platform.Development); len(options) != 0 {
		t.Fatalf("development definition options = %d, want 0", len(options))
	}
	if options := definitionLoadOptions(platform.Staging); len(options) != 0 {
		t.Fatalf("staging definition options = %d, want 0", len(options))
	}
	if options := definitionLoadOptions(platform.Production); len(options) != 1 {
		t.Fatalf("production definition options = %d, want 1", len(options))
	}
}

func TestLoadedDefinitionMustMatchReleaseIdentity(t *testing.T) {
	definition := game.Config{GameID: "iron-colossus", DefinitionVersion: "definition-v1"}
	config := platform.Config{
		ExpectedDefinitionGameID:  definition.GameID,
		ExpectedDefinitionVersion: definition.DefinitionVersion,
		ExpectedDefinitionSHA256:  strings.Repeat("a", 64),
	}
	if err := validateLoadedDefinitionIdentity(config, definition, strings.Repeat("a", 64)); err != nil {
		t.Fatalf("matching definition identity rejected: %v", err)
	}
	for name, mutate := range map[string]func(*platform.Config){
		"game":    func(value *platform.Config) { value.ExpectedDefinitionGameID = "other" },
		"version": func(value *platform.Config) { value.ExpectedDefinitionVersion = "other" },
		"digest":  func(value *platform.Config) { value.ExpectedDefinitionSHA256 = strings.Repeat("b", 64) },
	} {
		t.Run(name, func(t *testing.T) {
			mismatched := config
			mutate(&mismatched)
			if err := validateLoadedDefinitionIdentity(mismatched, definition, strings.Repeat("a", 64)); err == nil {
				t.Fatal("mismatched definition identity was accepted")
			}
		})
	}
}

func TestWaitForBackgroundHonorsCompletionAndDeadline(t *testing.T) {
	done := make(chan struct{})
	close(done)
	if err := waitForBackground(context.Background(), done); err != nil {
		t.Fatalf("completed background wait: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	if err := waitForBackground(ctx, make(chan struct{})); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timed background wait = %v, want deadline exceeded", err)
	}
}

func TestRuntimeDrainFailsReadinessBeforeStoppingBackgroundAndListeners(t *testing.T) {
	lifecycle := &platform.LifecycleReadiness{}
	server := &shutdownOrderRecorder{lifecycle: lifecycle}
	backgroundSawReady := true
	err := drainAndShutdownHTTPServers(
		context.Background(),
		lifecycle,
		func() { backgroundSawReady = lifecycle.Check(context.Background()) == nil },
		server,
	)
	if err != nil {
		t.Fatalf("drainAndShutdownHTTPServers() error = %v", err)
	}
	if backgroundSawReady || server.shutdownSawReady || server.shutdownCalls != 1 || server.closeCalls != 0 {
		t.Fatalf(
			"drain order = background_ready:%v shutdown_ready:%v shutdown_calls:%d close_calls:%d",
			backgroundSawReady, server.shutdownSawReady, server.shutdownCalls, server.closeCalls,
		)
	}
}

func TestRuntimeRoleSelectsOnlyOwnedHTTPServers(t *testing.T) {
	public := &shutdownOrderRecorder{}
	operations := &shutdownOrderRecorder{}
	for _, role := range []platform.RuntimeRole{platform.RuntimeRoleCombined, platform.RuntimeRoleAPI} {
		servers := roleHTTPServers(role, public, operations)
		if len(servers) != 2 || servers[0] != public || servers[1] != operations {
			t.Fatalf("role %q servers = %#v", role, servers)
		}
	}
	servers := roleHTTPServers(platform.RuntimeRoleWorker, public, operations)
	if len(servers) != 1 || servers[0] != operations {
		t.Fatalf("worker servers = %#v", servers)
	}
}

func TestDrainExpiredSecurityCredentialsFairlyUntilBothQueuesAreBelowBatch(t *testing.T) {
	order := make([]string, 0, 6)
	nonces := &scriptedSecurityCredentialPurger{
		name: "nonce", batches: []int64{1_000, 0, 0}, order: &order,
	}
	launches := &scriptedSecurityCredentialPurger{
		name: "launch", batches: []int64{1_000, 1_000, 0}, order: &order,
	}

	err := drainExpiredSecurityCredentials(
		context.Background(), time.Unix(1_700_000_000, 0).UTC(), 1_000, nonces, launches,
	)
	if err != nil {
		t.Fatalf("drain expired credentials: %v", err)
	}
	if got, want := strings.Join(order, ","), "nonce,launch,nonce,launch,nonce,launch"; got != want {
		t.Fatalf("purge order = %q, want %q", got, want)
	}
	if nonces.calls != 3 || launches.calls != 3 {
		t.Fatalf("purge calls = nonce:%d launch:%d, want 3 each", nonces.calls, launches.calls)
	}
}

func TestDrainExpiredSecurityCredentialsAttemptsBothQueuesWhenOneFails(t *testing.T) {
	order := make([]string, 0, 2)
	purgeErr := errors.New("nonce purge unavailable")
	nonces := &scriptedSecurityCredentialPurger{name: "nonce", order: &order, err: purgeErr}
	launches := &scriptedSecurityCredentialPurger{name: "launch", order: &order}

	err := drainExpiredSecurityCredentials(
		context.Background(), time.Unix(1_700_000_000, 0).UTC(), 1_000, nonces, launches,
	)
	if !errors.Is(err, purgeErr) {
		t.Fatalf("drain error = %v, want nonce purge error", err)
	}
	if got, want := strings.Join(order, ","), "nonce,launch"; got != want {
		t.Fatalf("purge order = %q, want %q", got, want)
	}
}

type scriptedSecurityCredentialPurger struct {
	name    string
	batches []int64
	order   *[]string
	calls   int
	err     error
}

func (purger *scriptedSecurityCredentialPurger) PurgeExpired(
	ctx context.Context,
	_ time.Time,
	_ int,
) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	*purger.order = append(*purger.order, purger.name)
	index := purger.calls
	purger.calls++
	if index >= len(purger.batches) {
		return 0, purger.err
	}
	return purger.batches[index], purger.err
}

func TestRuntimeDatabaseConfigSetsBoundedTimeoutsOnEveryConnection(t *testing.T) {
	connection, err := runtimeDatabaseConfig(
		"postgres://runtime:secret@postgres.example.internal:5432/rgs?sslmode=verify-full&statement_timeout=0&lock_timeout=0",
		10*time.Second,
		2*time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	if connection.RuntimeParams["statement_timeout"] != "10000" || connection.RuntimeParams["lock_timeout"] != "2000" {
		t.Fatalf("runtime timeout parameters = %#v", connection.RuntimeParams)
	}

	if _, err := runtimeDatabaseConfig(
		"postgres://runtime:secret@postgres.example.internal:5432/rgs?sslmode=verify-full",
		2*time.Second,
		3*time.Second,
	); err == nil {
		t.Fatal("invalid lock timeout unexpectedly accepted")
	}
}

func TestWithRequestTimeoutCancelsHandlerContext(t *testing.T) {
	deadline := 20 * time.Millisecond
	var contextErr error
	handler := withRequestTimeout(deadline, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		<-request.Context().Done()
		contextErr = request.Context().Err()
		writer.WriteHeader(http.StatusServiceUnavailable)
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/client/v1/spins", nil))

	if !errors.Is(contextErr, context.DeadlineExceeded) {
		t.Fatalf("handler context error = %v, want deadline exceeded", contextErr)
	}
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
}

func TestObserveRequestsClassifiesAuthAndAdmissionFailuresOnce(t *testing.T) {
	for _, test := range []struct {
		name         string
		status       int
		authFailed   uint64
		rateLimited  uint64
		serverFailed uint64
	}{
		{name: "unauthorized", status: http.StatusUnauthorized, authFailed: 1},
		{name: "forbidden binding", status: http.StatusForbidden, authFailed: 1},
		{name: "rate limited", status: http.StatusTooManyRequests, rateLimited: 1},
		{name: "application conflict", status: http.StatusConflict},
		{name: "server error", status: http.StatusInternalServerError, serverFailed: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			metrics := &platform.Metrics{}
			handler := observeRequests(
				slog.New(slog.NewTextHandler(io.Discard, nil)), metrics, 1_000_000,
				http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
					writer.WriteHeader(test.status)
				}),
			)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/client/v1/spins", nil))

			if metrics.HTTPRequests.Load() != 1 || metrics.HTTPFailures.Load() != 1 ||
				metrics.AuthFailures.Load() != test.authFailed ||
				metrics.RateLimited.Load() != test.rateLimited ||
				metrics.HTTPServerFailures.Load() != test.serverFailed ||
				metrics.HTTPActiveRequests.Load() != 0 ||
				metrics.HTTPRequestDurationCount.Load() != 1 {
				t.Fatalf(
					"metrics = requests:%d failures:%d server_failures:%d auth:%d limited:%d active:%d duration_count:%d",
					metrics.HTTPRequests.Load(), metrics.HTTPFailures.Load(),
					metrics.HTTPServerFailures.Load(),
					metrics.AuthFailures.Load(), metrics.RateLimited.Load(),
					metrics.HTTPActiveRequests.Load(), metrics.HTTPRequestDurationCount.Load(),
				)
			}
		})
	}
}

func TestOperationsEndpointsAreOffThePublicListenerAndBearerProtected(t *testing.T) {
	api := http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNoContent)
	})
	public := newPublicHandler(api, api)
	for _, path := range []string{"/readyz", "/metrics"} {
		response := httptest.NewRecorder()
		public.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusNotFound {
			t.Fatalf("public %s status = %d, want 404", path, response.Code)
		}
	}
	publicHealth := httptest.NewRecorder()
	public.ServeHTTP(publicHealth, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if publicHealth.Code != http.StatusOK {
		t.Fatalf("public health status = %d, want 200", publicHealth.Code)
	}

	const token = "operations-token-value-1234"
	metrics := &platform.Metrics{}
	operations := newOperationsHandler(nil, metrics, []byte(token))
	for _, path := range []string{"/readyz", "/metrics"} {
		response := httptest.NewRecorder()
		operations.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusUnauthorized || response.Header().Get("Cache-Control") != "no-store" ||
			strings.Contains(response.Body.String(), token) {
			t.Fatalf("unauthenticated operations %s = %d %q", path, response.Code, response.Body.String())
		}
	}
	wrongScheme := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	wrongScheme.Header.Set("Authorization", "Basic "+token)
	wrongSchemeResponse := httptest.NewRecorder()
	operations.ServeHTTP(wrongSchemeResponse, wrongScheme)
	if wrongSchemeResponse.Code != http.StatusUnauthorized {
		t.Fatalf("wrong authorization scheme status = %d, want 401", wrongSchemeResponse.Code)
	}
	duplicateAuthorization := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	duplicateAuthorization.Header.Add("Authorization", "Bearer "+token)
	duplicateAuthorization.Header.Add("Authorization", "Bearer "+token)
	duplicateAuthorizationResponse := httptest.NewRecorder()
	operations.ServeHTTP(duplicateAuthorizationResponse, duplicateAuthorization)
	if duplicateAuthorizationResponse.Code != http.StatusUnauthorized {
		t.Fatalf("duplicate authorization status = %d, want 401", duplicateAuthorizationResponse.Code)
	}
	operationsHealth := httptest.NewRecorder()
	operations.ServeHTTP(operationsHealth, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if operationsHealth.Code != http.StatusOK {
		t.Fatalf("operations health status = %d, want 200", operationsHealth.Code)
	}

	ready := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	ready.Header.Set("Authorization", "Bearer "+token)
	readyResponse := httptest.NewRecorder()
	operations.ServeHTTP(readyResponse, ready)
	if readyResponse.Code != http.StatusOK {
		t.Fatalf("authenticated readiness status = %d, want 200", readyResponse.Code)
	}
	metricsRequest := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	metricsRequest.Header.Set("Authorization", "Bearer "+token)
	metricsResponse := httptest.NewRecorder()
	operations.ServeHTTP(metricsResponse, metricsRequest)
	if metricsResponse.Code != http.StatusOK ||
		!strings.Contains(metricsResponse.Body.String(), "rgs_http_requests_total") ||
		!strings.Contains(metricsResponse.Body.String(), "rgs_ready 1") {
		t.Fatalf("authenticated metrics = %d %q", metricsResponse.Code, metricsResponse.Body.String())
	}
	if metrics.AuthFailures.Load() != 4 {
		t.Fatalf("operations authentication failures = %d, want 4", metrics.AuthFailures.Load())
	}
}

func TestPublicConnectionTelemetryCoversPreHandlerAndHijackedLifetimes(t *testing.T) {
	metrics := &platform.Metrics{}
	observePublicConnectionState(metrics, http.StateNew)
	observePublicConnectionState(metrics, http.StateActive)
	observePublicConnectionState(metrics, http.StateIdle)
	if active := metrics.HTTPActiveConnections.Load(); active != 1 {
		t.Fatalf("active connections before close = %d, want 1", active)
	}
	observePublicConnectionState(metrics, http.StateClosed)
	if active := metrics.HTTPActiveConnections.Load(); active != 0 {
		t.Fatalf("active connections after close = %d, want 0", active)
	}
	observePublicConnectionState(metrics, http.StateNew)
	observePublicConnectionState(metrics, http.StateHijacked)
	if active := metrics.HTTPActiveConnections.Load(); active != 0 {
		t.Fatalf("active connections after hijack = %d, want 0", active)
	}
}

func TestLoadOperationsBearerTokenRejectsBroadPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "operations-token")
	const token = "operations-token-value-1234"
	if err := os.WriteFile(path, []byte(token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadOperationsBearerToken(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(loaded) != token {
		t.Fatalf("loaded token = %q", loaded)
	}
	clear(loaded)
	if err := os.Chmod(path, 0o604); err != nil {
		t.Fatal(err)
	}
	if _, err := loadOperationsBearerToken(path); err == nil || !strings.Contains(err.Error(), "permissions") {
		t.Fatalf("broad-permission token error = %v", err)
	}
}

func TestObserveRequestsLogsOnlyNormalizedSafeFields(t *testing.T) {
	var logs bytes.Buffer
	handler := observeRequests(
		slog.New(slog.NewJSONHandler(&logs, nil)),
		&platform.Metrics{},
		1_000_000,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.Header().Set("X-Request-Id", "req_safe-1")
			writer.WriteHeader(http.StatusTeapot)
		}),
	)
	request := httptest.NewRequest(http.MethodPost, "/client/v1/not-a-real-route?player=secret", nil)
	request.RemoteAddr = "203.0.113.9:443"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	var entry map[string]any
	if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
		t.Fatalf("decode log entry: %v: %s", err, logs.String())
	}
	if entry["route"] != "other" || entry["request_id"] != "req_safe-1" ||
		entry["status"] != float64(http.StatusTeapot) || entry["status_class"] != "4xx" {
		t.Fatalf("normalized log entry = %#v", entry)
	}
	if entry["level"] != "WARN" {
		t.Fatalf("4xx log level = %#v, want WARN", entry["level"])
	}
	if _, exists := entry["duration_ms"]; !exists {
		t.Fatalf("duration missing from log entry: %#v", entry)
	}
	if _, exists := entry["path"]; exists || entry["remote_ip"] != nil ||
		strings.Contains(logs.String(), "not-a-real-route") || strings.Contains(logs.String(), "203.0.113.9") {
		t.Fatalf("log leaks raw routing or IP data: %s", logs.String())
	}
}

func TestObserveRequestsSamplesOnlySuccessfulAccessLogs(t *testing.T) {
	for _, test := range []struct {
		name        string
		status      int
		sample      int
		wantLevel   string
		wantEmitted uint64
		wantDropped uint64
	}{
		{name: "successful request dropped", status: http.StatusNoContent, sample: 0, wantDropped: 1},
		{name: "successful request emitted", status: http.StatusOK, sample: 1_000_000, wantLevel: "INFO", wantEmitted: 1},
		{name: "client error is never sampled", status: http.StatusBadRequest, sample: 0, wantLevel: "WARN", wantEmitted: 1},
		{name: "server error is never sampled", status: http.StatusServiceUnavailable, sample: 0, wantLevel: "ERROR", wantEmitted: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			var logs bytes.Buffer
			metrics := &platform.Metrics{}
			handler := observeRequests(
				slog.New(slog.NewJSONHandler(&logs, nil)),
				metrics,
				test.sample,
				http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
					writer.Header().Set("X-Request-Id", "req_sampling-1")
					writer.WriteHeader(test.status)
				}),
			)
			handler.ServeHTTP(
				httptest.NewRecorder(),
				httptest.NewRequest(http.MethodPost, "/client/v1/spins", nil),
			)

			if metrics.AccessLogsEmitted.Load() != test.wantEmitted ||
				metrics.AccessLogsDropped.Load() != test.wantDropped {
				t.Fatalf(
					"access log metrics = emitted:%d dropped:%d, want emitted:%d dropped:%d",
					metrics.AccessLogsEmitted.Load(), metrics.AccessLogsDropped.Load(),
					test.wantEmitted, test.wantDropped,
				)
			}
			if test.wantLevel == "" {
				if logs.Len() != 0 {
					t.Fatalf("sampled-out success unexpectedly logged: %s", logs.String())
				}
				return
			}
			var entry map[string]any
			if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
				t.Fatalf("decode access log: %v: %s", err, logs.String())
			}
			if entry["level"] != test.wantLevel || entry["status"] != float64(test.status) {
				t.Fatalf("access log = %#v", entry)
			}
		})
	}
}

func TestSuccessfulAccessLogSamplingIsDeterministic(t *testing.T) {
	if shouldEmitSuccessfulAccessLog(0, "client.spin", "req-1") {
		t.Fatal("zero sample unexpectedly emitted a success")
	}
	if !shouldEmitSuccessfulAccessLog(1_000_000, "client.spin", "req-1") {
		t.Fatal("full sample unexpectedly dropped a success")
	}

	const sample = 500_000
	first := shouldEmitSuccessfulAccessLog(sample, "client.spin", "req-stable")
	for attempt := 0; attempt < 100; attempt++ {
		if got := shouldEmitSuccessfulAccessLog(sample, "client.spin", "req-stable"); got != first {
			t.Fatalf("same access log key changed decision on attempt %d", attempt)
		}
	}

	var emitted, dropped bool
	for index := 0; index < 10_000 && !(emitted && dropped); index++ {
		decision := shouldEmitSuccessfulAccessLog(sample, "client.spin", "req-"+strconv.Itoa(index))
		emitted = emitted || decision
		dropped = dropped || !decision
	}
	if !emitted || !dropped {
		t.Fatalf("partial deterministic sample did not produce both decisions: emitted=%v dropped=%v", emitted, dropped)
	}
}

func TestObserveRequestsExcludesPublicHealthFromBusinessMetrics(t *testing.T) {
	metrics := &platform.Metrics{}
	handler := observeRequests(
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		metrics,
		1_000_000,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusOK)
		}),
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("health response status = %d, want 200", response.Code)
	}
	if metrics.HTTPRequests.Load() != 0 || metrics.HTTPFailures.Load() != 0 ||
		metrics.HTTPServerFailures.Load() != 0 || metrics.HTTPActiveRequests.Load() != 0 ||
		metrics.HTTPRequestDurationCount.Load() != 0 {
		t.Fatalf(
			"health probe polluted business metrics: requests:%d failures:%d server:%d active:%d durations:%d",
			metrics.HTTPRequests.Load(), metrics.HTTPFailures.Load(), metrics.HTTPServerFailures.Load(),
			metrics.HTTPActiveRequests.Load(), metrics.HTTPRequestDurationCount.Load(),
		)
	}
}

func TestPublicInFlightGateRejectsWithoutBlockingAndBypassesHealth(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	api := http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		writer.WriteHeader(http.StatusNoContent)
	})
	metrics := &platform.Metrics{}
	handler := observeRequests(
		nil,
		metrics,
		1_000_000,
		newPublicInFlightGate(1, metrics, newPublicHandler(api, api)),
	)

	firstResponse := httptest.NewRecorder()
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		handler.ServeHTTP(
			firstResponse,
			httptest.NewRequest(http.MethodPost, "/operator/v1/launches", nil),
		)
	}()
	<-started

	healthResponse := httptest.NewRecorder()
	handler.ServeHTTP(healthResponse, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if healthResponse.Code != http.StatusOK {
		t.Fatalf("health status at capacity = %d, want 200", healthResponse.Code)
	}

	secondResponse := httptest.NewRecorder()
	secondRequest := httptest.NewRequest(http.MethodPost, "/operator/v1/launches", nil)
	secondRequest.Header.Set("X-Forwarded-For", "198.51.100.1")
	secondDone := make(chan struct{})
	go func() {
		defer close(secondDone)
		handler.ServeHTTP(secondResponse, secondRequest)
	}()
	select {
	case <-secondDone:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("capacity rejection blocked instead of failing immediately")
	}
	if secondResponse.Code != http.StatusServiceUnavailable ||
		secondResponse.Header().Get("Retry-After") != "1" ||
		!strings.Contains(secondResponse.Body.String(), `"code":"SERVICE_UNAVAILABLE"`) {
		t.Fatalf(
			"capacity response = status:%d headers:%v body:%s",
			secondResponse.Code,
			secondResponse.Header(),
			secondResponse.Body.String(),
		)
	}

	close(release)
	<-firstDone
	if firstResponse.Code != http.StatusNoContent {
		t.Fatalf("admitted response = %d, want 204", firstResponse.Code)
	}
	if metrics.HTTPRequests.Load() != 2 || metrics.HTTPFailures.Load() != 1 ||
		metrics.HTTPServerFailures.Load() != 1 || metrics.CapacityRejected.Load() != 1 ||
		metrics.RateLimited.Load() != 0 || metrics.HTTPRequestDurationCount.Load() != 2 {
		t.Fatalf(
			"capacity metrics = requests:%d failures:%d server:%d capacity:%d limited:%d durations:%d",
			metrics.HTTPRequests.Load(),
			metrics.HTTPFailures.Load(),
			metrics.HTTPServerFailures.Load(),
			metrics.CapacityRejected.Load(),
			metrics.RateLimited.Load(),
			metrics.HTTPRequestDurationCount.Load(),
		)
	}
}

type shutdownOrderRecorder struct {
	lifecycle        *platform.LifecycleReadiness
	shutdownSawReady bool
	shutdownCalls    int
	closeCalls       int
}

func (recorder *shutdownOrderRecorder) Shutdown(ctx context.Context) error {
	recorder.shutdownCalls++
	recorder.shutdownSawReady = recorder.lifecycle.Check(ctx) == nil
	return nil
}

func (recorder *shutdownOrderRecorder) Close() error {
	recorder.closeCalls++
	return nil
}
