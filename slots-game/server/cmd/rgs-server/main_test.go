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
	"sync"
	"testing"
	"time"

	"slots-game/server/internal/game"
	"slots-game/server/internal/operator"
	"slots-game/server/internal/platform"
	"slots-game/server/internal/rgsapi"
	"slots-game/server/internal/safelog"
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

func TestRuntimeFailureLogDoesNotExposeStartupErrorText(t *testing.T) {
	t.Parallel()
	const secret = "postgres://runtime:password@database.internal/rgs /run/secrets/private-key"
	var output bytes.Buffer
	logRuntimeFailure(slog.New(slog.NewJSONHandler(&output, nil)), errors.New(secret))
	logOutput := output.String()
	if strings.Contains(logOutput, secret) || strings.Contains(logOutput, "password") ||
		strings.Contains(logOutput, "private-key") || !strings.Contains(logOutput, `"error_class":"internal"`) {
		t.Fatalf("unsafe runtime failure log: %s", logOutput)
	}
}

type startupReadinessCheckFunc func(context.Context) error

func (check startupReadinessCheckFunc) Check(ctx context.Context) error { return check(ctx) }

func TestSharedAdmissionCanaryFailureStopsStartupBeforeListenerConstruction(t *testing.T) {
	t.Parallel()
	canaryFailure := errors.New("basic canary failed")
	checkCalls := 0
	listenerConstructed := false
	start := func(checker startupReadinessChecker) error {
		if err := checkSharedAdmissionStartup(context.Background(), checker); err != nil {
			return err
		}
		listenerConstructed = true
		return nil
	}
	err := start(startupReadinessCheckFunc(func(context.Context) error {
		checkCalls++
		return canaryFailure
	}))
	if !errors.Is(err, canaryFailure) || !strings.Contains(err.Error(), "shared admission startup readiness") {
		t.Fatalf("startup canary error = %v", err)
	}
	if checkCalls != 1 || listenerConstructed {
		t.Fatalf("startup ordering = checks:%d listener_constructed:%v", checkCalls, listenerConstructed)
	}
}

func TestRecoveryStartupReadinessOnlyGatesDedicatedWorker(t *testing.T) {
	t.Parallel()
	base := []platform.DependencyCheck{&platform.LifecycleReadiness{}}
	for _, role := range []platform.RuntimeRole{platform.RuntimeRoleAPI, platform.RuntimeRoleCombined} {
		checks, readiness := withRecoveryStartupReadiness(role, append([]platform.DependencyCheck(nil), base...))
		if readiness != nil || len(checks) != len(base) {
			t.Fatalf("role %q unexpectedly changed API readiness: checks=%d readiness=%v",
				role, len(checks), readiness)
		}
	}

	checks, readiness := withRecoveryStartupReadiness(
		platform.RuntimeRoleWorker,
		append([]platform.DependencyCheck(nil), base...),
	)
	if readiness == nil || len(checks) != len(base)+1 || checks[len(checks)-1] != readiness {
		t.Fatalf("worker startup readiness assembly = checks:%d readiness:%v", len(checks), readiness)
	}
	handler := platform.Readiness{Checks: checks, Timeout: time.Second}
	before := httptest.NewRecorder()
	handler.ServeHTTP(before, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if before.Code != http.StatusServiceUnavailable {
		t.Fatalf("worker readiness before recovery pass = %d, want 503", before.Code)
	}
	readiness.MarkSuccessfulPass()
	after := httptest.NewRecorder()
	handler.ServeHTTP(after, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if after.Code != http.StatusOK {
		t.Fatalf("worker readiness after recovery pass = %d, want 200", after.Code)
	}
}

func TestRGSAPIAssemblyUsesSameSharedAdmissionForLaunchAndSpin(t *testing.T) {
	shared := &assemblyAdmission{}
	config := withSharedAdmissions(rgsapi.Config{}, shared)
	if config.LaunchAdmission != shared || config.SpinAdmission != shared {
		t.Fatalf(
			"shared admission assembly drifted: launch=%T spin=%T want=%T",
			config.LaunchAdmission, config.SpinAdmission, shared,
		)
	}
	for _, call := range []struct {
		admission rgsapi.Admission
		key       string
	}{
		{admission: config.LaunchAdmission, key: "launch-operator:verified"},
		{admission: config.SpinAdmission, key: "spin-operator:verified"},
	} {
		result := call.admission.Admit(context.Background(), call.key, time.Time{})
		if result.Decision != rgsapi.AdmissionAllowed {
			t.Fatalf("shared admission result for %q = %+v", call.key, result)
		}
	}
	if got := strings.Join(shared.keys, ","); got != "launch-operator:verified,spin-operator:verified" {
		t.Fatalf("shared admission keys = %q", got)
	}
}

type assemblyAdmission struct{ keys []string }

func (admission *assemblyAdmission) Admit(_ context.Context, key string, _ time.Time) rgsapi.AdmissionResult {
	admission.keys = append(admission.keys, key)
	return rgsapi.AdmissionResult{Decision: rgsapi.AdmissionAllowed}
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

func TestRuntimeShutdownStartsAllListenersBeforeOneFinishesDraining(t *testing.T) {
	t.Parallel()
	firstRelease := make(chan struct{})
	first := &concurrentShutdownRecorder{
		entered: make(chan struct{}),
		release: firstRelease,
	}
	second := &concurrentShutdownRecorder{entered: make(chan struct{})}
	done := make(chan error, 1)
	go func() {
		done <- shutdownHTTPServers(context.Background(), first, second)
	}()

	select {
	case <-first.entered:
	case <-time.After(time.Second):
		t.Fatal("first listener did not begin shutdown")
	}
	select {
	case <-second.entered:
	case <-time.After(time.Second):
		t.Fatal("second listener waited for the first listener to finish draining")
	}
	close(firstRelease)
	if err := <-done; err != nil {
		t.Fatalf("concurrent listener shutdown: %v", err)
	}
	if first.shutdownCalls != 1 || second.shutdownCalls != 1 ||
		first.closeCalls != 0 || second.closeCalls != 0 {
		t.Fatalf("listener shutdown calls = first:%d/%d second:%d/%d",
			first.shutdownCalls, first.closeCalls, second.shutdownCalls, second.closeCalls)
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

func TestHTTPServerUsesBoundedTransportTimeoutsAndHeaders(t *testing.T) {
	config := platform.Config{
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	server := newHTTPServer("127.0.0.1:0", http.NotFoundHandler(), config)
	if server.ReadHeaderTimeout != config.ReadHeaderTimeout || server.ReadTimeout != config.ReadTimeout ||
		server.WriteTimeout != config.WriteTimeout || server.IdleTimeout != config.IdleTimeout ||
		server.MaxHeaderBytes != 16<<10 {
		t.Fatalf("unsafe HTTP server bounds: %+v", server)
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
	if publicHealth.Code != http.StatusNotFound {
		t.Fatalf("public health status = %d, want 404", publicHealth.Code)
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
	if entry["route"] != "other" || entry["request_id"] != safelog.CorrelationIDDigest("req_safe-1") ||
		entry["status"] != float64(http.StatusTeapot) || entry["status_class"] != "4xx" {
		t.Fatalf("normalized log entry = %#v", entry)
	}
	if response.Header().Get("X-Request-Id") != "req_safe-1" || strings.Contains(logs.String(), "req_safe-1") {
		t.Fatalf("request ID response/log boundary drifted: headers:%v log:%s", response.Header(), logs.String())
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

func TestNormalizedPublicRouteRecognizesClientSessionStatus(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, rgsapi.ClientSessionStatusPath, nil)
	if route := normalizedPublicRoute(request); route != "client.session_status" {
		t.Fatalf("session status route = %q, want client.session_status", route)
	}
}

func TestObserveRequestsPreservesResponseControllerFlush(t *testing.T) {
	t.Parallel()
	var logs bytes.Buffer
	var flushErr error
	var deadlineErr error
	deadline := time.Unix(1_800_000_000, 0)
	handler := observeRequests(
		slog.New(slog.NewJSONHandler(&logs, nil)),
		&platform.Metrics{},
		1_000_000,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			controller := http.NewResponseController(writer)
			deadlineErr = controller.SetReadDeadline(deadline)
			flushErr = controller.Flush()
			writer.WriteHeader(http.StatusTeapot)
		}),
	)
	response := &rgsResponseControllerRecorder{ResponseRecorder: httptest.NewRecorder()}
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, rgsapi.ClientPendingResultPath, nil))
	if deadlineErr != nil || !response.readDeadline.Equal(deadline) {
		t.Fatalf("ResponseController.SetReadDeadline() through access middleware = %v, deadline:%v", deadlineErr, response.readDeadline)
	}
	if flushErr != nil {
		t.Fatalf("ResponseController.Flush() through access middleware = %v", flushErr)
	}
	if response.Code != http.StatusOK || !response.Flushed {
		t.Fatalf("flushed response = status:%d flushed:%v", response.Code, response.Flushed)
	}
	var entry map[string]any
	if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
		t.Fatalf("decode flushed access log: %v: %s", err, logs.String())
	}
	if entry["status"] != float64(http.StatusOK) {
		t.Fatalf("flushed access log status = %#v, want 200", entry["status"])
	}
}

func TestObserveRequestsKeepsImplicitWriteStatusAfterLateHeader(t *testing.T) {
	t.Parallel()
	var logs bytes.Buffer
	handler := observeRequests(
		slog.New(slog.NewJSONHandler(&logs, nil)),
		&platform.Metrics{},
		1_000_000,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			_, _ = writer.Write([]byte(`{"ok":true}`))
			writer.WriteHeader(http.StatusInternalServerError)
		}),
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, rgsapi.ClientPendingResultPath, nil))
	if response.Code != http.StatusOK || response.Body.String() != `{"ok":true}` {
		t.Fatalf("implicit response = status:%d body:%q", response.Code, response.Body.String())
	}
	var entry map[string]any
	if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
		t.Fatalf("decode implicit-write access log: %v: %s", err, logs.String())
	}
	if entry["status"] != float64(http.StatusOK) || entry["status_class"] != "2xx" {
		t.Fatalf("implicit-write access log status = %#v", entry)
	}
}

type rgsResponseControllerRecorder struct {
	*httptest.ResponseRecorder
	readDeadline time.Time
}

func (recorder *rgsResponseControllerRecorder) SetReadDeadline(deadline time.Time) error {
	recorder.readDeadline = deadline
	return nil
}

type rgsMultiStageResponseWriter struct {
	header        http.Header
	informational []int
	status        int
	body          bytes.Buffer
}

type rgsCommittedFlushErrorWriter struct {
	*rgsMultiStageResponseWriter
	flushErr error
}

func (writer *rgsCommittedFlushErrorWriter) FlushError() error {
	if writer.status == 0 {
		writer.WriteHeader(http.StatusOK)
	}
	return writer.flushErr
}

func (writer *rgsMultiStageResponseWriter) Header() http.Header {
	if writer.header == nil {
		writer.header = make(http.Header)
	}
	return writer.header
}

func (writer *rgsMultiStageResponseWriter) WriteHeader(status int) {
	if writer.status != 0 {
		return
	}
	if status >= 100 && status < 200 && status != http.StatusSwitchingProtocols {
		writer.informational = append(writer.informational, status)
		return
	}
	writer.status = status
}

func (writer *rgsMultiStageResponseWriter) Write(encoded []byte) (int, error) {
	if writer.status == 0 {
		writer.status = http.StatusOK
	}
	return writer.body.Write(encoded)
}

func TestObserveRequestsPreservesInformationalThenFinalStatus(t *testing.T) {
	t.Parallel()
	var logs bytes.Buffer
	handler := observeRequests(
		slog.New(slog.NewJSONHandler(&logs, nil)),
		&platform.Metrics{},
		1_000_000,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusEarlyHints)
			writer.WriteHeader(http.StatusNoContent)
		}),
	)
	response := &rgsMultiStageResponseWriter{}
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, rgsapi.ClientPendingResultPath, nil))
	if len(response.informational) != 1 || response.informational[0] != http.StatusEarlyHints ||
		response.status != http.StatusNoContent {
		t.Fatalf("multi-stage response = informational:%v final:%d", response.informational, response.status)
	}
	var entry map[string]any
	if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
		t.Fatalf("decode multi-stage access log: %v: %s", err, logs.String())
	}
	if entry["status"] != float64(http.StatusNoContent) {
		t.Fatalf("multi-stage access log status = %#v, want 204", entry["status"])
	}
}

func TestObserveRequestsDoesNotCommitStatusForUnsupportedFlush(t *testing.T) {
	t.Parallel()
	var logs bytes.Buffer
	var flushErr error
	handler := observeRequests(
		slog.New(slog.NewJSONHandler(&logs, nil)),
		&platform.Metrics{},
		1_000_000,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			flushErr = http.NewResponseController(writer).Flush()
			writer.WriteHeader(http.StatusTeapot)
		}),
	)
	response := &rgsMultiStageResponseWriter{}
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, rgsapi.ClientPendingResultPath, nil))
	if !errors.Is(flushErr, http.ErrNotSupported) || response.status != http.StatusTeapot {
		t.Fatalf("unsupported flush = error:%v final:%d", flushErr, response.status)
	}
	var entry map[string]any
	if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
		t.Fatalf("decode unsupported-flush access log: %v: %s", err, logs.String())
	}
	if entry["status"] != float64(http.StatusTeapot) {
		t.Fatalf("unsupported-flush access log status = %#v, want 418", entry["status"])
	}
}

func TestObserveRequestsRecordsCommittedStatusWhenFlushFails(t *testing.T) {
	t.Parallel()
	var logs bytes.Buffer
	flushFailure := errors.New("flush network failure")
	var flushErr error
	handler := observeRequests(
		slog.New(slog.NewJSONHandler(&logs, nil)),
		&platform.Metrics{},
		1_000_000,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			flushErr = http.NewResponseController(writer).Flush()
			writer.WriteHeader(http.StatusTeapot)
		}),
	)
	response := &rgsCommittedFlushErrorWriter{
		rgsMultiStageResponseWriter: &rgsMultiStageResponseWriter{},
		flushErr:                    flushFailure,
	}
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, rgsapi.ClientPendingResultPath, nil))
	if !errors.Is(flushErr, flushFailure) || response.status != http.StatusOK {
		t.Fatalf("failed flush = error:%v final:%d", flushErr, response.status)
	}
	var entry map[string]any
	if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
		t.Fatalf("decode failed-flush access log: %v: %s", err, logs.String())
	}
	if entry["status"] != float64(http.StatusOK) {
		t.Fatalf("failed-flush access log status = %#v, want 200", entry["status"])
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
		{name: "client error uses available bounded budget", status: http.StatusBadRequest, sample: 0, wantLevel: "WARN", wantEmitted: 1},
		{name: "server error uses available bounded budget", status: http.StatusServiceUnavailable, sample: 0, wantLevel: "ERROR", wantEmitted: 1},
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

func TestObserveRequestsHashesLoggedRequestIDWithoutChangingSamplingInput(t *testing.T) {
	const samplePerMillion = 500_000
	const route = "client.spin"
	requestID := ""
	for index := 0; index < 10_000; index++ {
		candidate := "req-sampling-secret-" + strconv.Itoa(index)
		if shouldEmitSuccessfulAccessLog(samplePerMillion, route, candidate) &&
			!shouldEmitSuccessfulAccessLog(samplePerMillion, route, safelog.CorrelationIDDigest(candidate)) {
			requestID = candidate
			break
		}
	}
	if requestID == "" {
		t.Fatal("could not find deterministic raw/digest sampling discriminator")
	}

	var logs bytes.Buffer
	metrics := &platform.Metrics{}
	handler := observeRequests(
		slog.New(slog.NewJSONHandler(&logs, nil)),
		metrics,
		samplePerMillion,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.Header().Set("X-Request-Id", requestID)
			writer.WriteHeader(http.StatusNoContent)
		}),
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, rgsapi.ClientSpinPath, nil))

	if got := response.Header().Get("X-Request-Id"); got != requestID {
		t.Fatalf("response request ID = %q, want original %q", got, requestID)
	}
	if metrics.AccessLogsEmitted.Load() != 1 || metrics.AccessLogsDropped.Load() != 0 {
		t.Fatalf("sampling used transformed ID: emitted:%d dropped:%d",
			metrics.AccessLogsEmitted.Load(), metrics.AccessLogsDropped.Load())
	}
	var entry map[string]any
	if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
		t.Fatalf("decode sampled access log: %v: %s", err, logs.String())
	}
	if entry["request_id"] != safelog.CorrelationIDDigest(requestID) || strings.Contains(logs.String(), requestID) {
		t.Fatalf("sampled access log exposes or mis-hashes request ID: %#v", entry)
	}
}

func TestObserveRequestsBoundsFailureAccessLogsUnderFlood(t *testing.T) {
	const requests = 1_000
	var logs bytes.Buffer
	metrics := &platform.Metrics{}
	responseStatus := http.StatusUnauthorized
	handler := observeRequests(
		slog.New(slog.NewJSONHandler(&logs, nil)),
		metrics,
		1_000_000,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(responseStatus)
		}),
	)
	for index := 0; index < requests; index++ {
		request := httptest.NewRequest(http.MethodPost, rgsapi.ClientSpinPath, nil)
		request.Header.Set(operator.HeaderRequestID, "req-flood-"+strconv.Itoa(index))
		handler.ServeHTTP(httptest.NewRecorder(), request)
	}

	emitted := metrics.AccessLogsEmitted.Load()
	dropped := metrics.AccessLogsDropped.Load()
	if emitted >= requests/2 || dropped == 0 || emitted+dropped != requests {
		t.Fatalf("failure access-log budget = emitted:%d dropped:%d requests:%d",
			emitted, dropped, requests)
	}
	responseStatus = http.StatusServiceUnavailable
	handler.ServeHTTP(
		httptest.NewRecorder(),
		httptest.NewRequest(http.MethodPost, rgsapi.ClientSpinPath, nil),
	)
	if metrics.AccessLogsEmitted.Load() != emitted+1 {
		t.Fatalf("exhausted 4xx budget suppressed independent 5xx log: before=%d after=%d",
			emitted, metrics.AccessLogsEmitted.Load())
	}
	lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
	if uint64(len(lines)) != emitted+1 {
		t.Fatalf("physical log lines=%d, emitted metric=%d", len(lines), metrics.AccessLogsEmitted.Load())
	}
}

func TestObserveRequestsBoundsRepeatedSampledSuccess(t *testing.T) {
	const requests = 1_000
	var logs bytes.Buffer
	metrics := &platform.Metrics{}
	responseStatus := http.StatusOK
	handler := observeRequests(
		slog.New(slog.NewJSONHandler(&logs, nil)),
		metrics,
		1_000_000,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(responseStatus)
		}),
	)
	for range requests {
		request := httptest.NewRequest(http.MethodPost, rgsapi.ClientSpinPath, nil)
		// 重复一个已命中确定性采样的攻击者可控 ID；采样决定不能成为无限日志许可。
		// English: Repeat an attacker-controllable ID that has hit deterministic sampling; sampling decisions cannot be
		// unlimited log permissions.
		request.Header.Set(operator.HeaderRequestID, "req-replayed-sampled")
		handler.ServeHTTP(httptest.NewRecorder(), request)
	}

	emitted := metrics.AccessLogsEmitted.Load()
	dropped := metrics.AccessLogsDropped.Load()
	if emitted >= requests/2 || dropped == 0 || emitted+dropped != requests {
		t.Fatalf("successful access-log budget = emitted:%d dropped:%d requests:%d",
			emitted, dropped, requests)
	}
	responseStatus = http.StatusServiceUnavailable
	handler.ServeHTTP(
		httptest.NewRecorder(),
		httptest.NewRequest(http.MethodPost, rgsapi.ClientSpinPath, nil),
	)
	if metrics.AccessLogsEmitted.Load() != emitted+1 {
		t.Fatalf("exhausted success budget suppressed independent 5xx log: before=%d after=%d",
			emitted, metrics.AccessLogsEmitted.Load())
	}
	lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
	if uint64(len(lines)) != emitted+1 {
		t.Fatalf("physical log lines=%d, emitted metric=%d", len(lines), metrics.AccessLogsEmitted.Load())
	}
}

type blockingAccessLogHandler struct {
	started chan<- struct{}
	release <-chan struct{}
}

func (handler blockingAccessLogHandler) Enabled(context.Context, slog.Level) bool { return true }

func (handler blockingAccessLogHandler) Handle(context.Context, slog.Record) error {
	handler.started <- struct{}{}
	<-handler.release
	return nil
}

func (handler blockingAccessLogHandler) WithAttrs([]slog.Attr) slog.Handler { return handler }

func (handler blockingAccessLogHandler) WithGroup(string) slog.Handler { return handler }

func TestObserveRequestsBoundsBlockedAccessLogWrites(t *testing.T) {
	const expectedMaximumWrites = 4
	started := make(chan struct{}, expectedMaximumWrites+1)
	release := make(chan struct{})
	metrics := &platform.Metrics{}
	handler := observeRequests(
		slog.New(blockingAccessLogHandler{started: started, release: release}),
		metrics,
		1_000_000,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusOK)
		}),
	)

	var admitted sync.WaitGroup
	for range expectedMaximumWrites {
		admitted.Add(1)
		go func() {
			defer admitted.Done()
			handler.ServeHTTP(
				httptest.NewRecorder(),
				httptest.NewRequest(http.MethodPost, rgsapi.ClientSpinPath, nil),
			)
		}()
	}
	for range expectedMaximumWrites {
		<-started
	}

	overflowDone := make(chan struct{})
	go func() {
		defer close(overflowDone)
		handler.ServeHTTP(
			httptest.NewRecorder(),
			httptest.NewRequest(http.MethodPost, rgsapi.ClientSpinPath, nil),
		)
	}()
	select {
	case <-overflowDone:
		close(release)
		admitted.Wait()
	case <-time.After(250 * time.Millisecond):
		close(release)
		admitted.Wait()
		<-overflowDone
		t.Fatal("access-log overflow blocked a request instead of dropping the log")
	}
	if metrics.AccessLogsDropped.Load() != 1 ||
		metrics.AccessLogsEmitted.Load() != expectedMaximumWrites {
		t.Fatalf("blocked access-log metrics = emitted:%d dropped:%d",
			metrics.AccessLogsEmitted.Load(), metrics.AccessLogsDropped.Load())
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

func TestObserveRequestsTreatsRemovedPublicHealthAsBusinessTraffic(t *testing.T) {
	metrics := &platform.Metrics{}
	handler := observeRequests(
		nil,
		metrics,
		1_000_000,
		newPublicHandler(http.NotFoundHandler(), http.NotFoundHandler()),
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	if response.Code != http.StatusNotFound {
		t.Fatalf("removed public health response status = %d, want 404", response.Code)
	}
	if metrics.HTTPRequests.Load() != 1 || metrics.HTTPFailures.Load() != 1 ||
		metrics.HTTPServerFailures.Load() != 0 || metrics.HTTPActiveRequests.Load() != 0 ||
		metrics.HTTPRequestDurationCount.Load() != 1 {
		t.Fatalf(
			"removed public health metrics: requests:%d failures:%d server:%d active:%d durations:%d",
			metrics.HTTPRequests.Load(), metrics.HTTPFailures.Load(), metrics.HTTPServerFailures.Load(),
			metrics.HTTPActiveRequests.Load(), metrics.HTTPRequestDurationCount.Load(),
		)
	}
}

func TestObserveRequestsCountsNonCanonicalHealthTrafficAsBusinessFailure(t *testing.T) {
	metrics := &platform.Metrics{}
	handler := observeRequests(
		nil,
		metrics,
		1_000_000,
		newPublicHandler(http.NotFoundHandler(), http.NotFoundHandler()),
	)
	request := httptest.NewRequest(http.MethodPost, "/healthz", strings.NewReader(`{"unexpected":true}`))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusNotFound || !request.Close || metrics.HTTPRequests.Load() != 1 ||
		metrics.HTTPFailures.Load() != 1 || metrics.HTTPRequestDurationCount.Load() != 1 {
		t.Fatalf("non-canonical health metrics = status:%d close:%v requests:%d failures:%d durations:%d",
			response.Code, request.Close, metrics.HTTPRequests.Load(), metrics.HTTPFailures.Load(),
			metrics.HTTPRequestDurationCount.Load())
	}
}

func TestPublicHandlerDoesNotCanonicalizeAttackerPathAndClosesUnknownBody(t *testing.T) {
	clientCalls := 0
	handler := newPublicHandler(
		http.NotFoundHandler(),
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			clientCalls++
			writer.WriteHeader(http.StatusTeapot)
		}),
	)
	nonCanonical := httptest.NewRequest(http.MethodPost, "/client/../healthz", nil)
	nonCanonicalRecorder := httptest.NewRecorder()
	handler.ServeHTTP(nonCanonicalRecorder, nonCanonical)
	if nonCanonicalRecorder.Code != http.StatusTeapot || clientCalls != 1 {
		t.Fatalf("attacker path was canonicalized before API validation: status:%d calls:%d location:%q",
			nonCanonicalRecorder.Code, clientCalls, nonCanonicalRecorder.Header().Get("Location"))
	}

	unknown := httptest.NewRequest(http.MethodPost, "/unknown", strings.NewReader(`{"unread":true}`))
	unknownRecorder := httptest.NewRecorder()
	handler.ServeHTTP(unknownRecorder, unknown)
	if unknownRecorder.Code != http.StatusNotFound || !unknown.Close {
		t.Fatalf("unknown route = status:%d close:%v body:%s",
			unknownRecorder.Code, unknown.Close, unknownRecorder.Body.String())
	}
}

func TestPublicHandlerRejectsRemovedPublicLivenessAndClosesBodies(t *testing.T) {
	handler := newPublicHandler(http.NotFoundHandler(), http.NotFoundHandler())
	tests := []struct {
		name       string
		request    *http.Request
		wantStatus int
		wantClose  bool
	}{
		{
			name:       "removed canonical probe",
			request:    httptest.NewRequest(http.MethodGet, "/healthz", nil),
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "post body",
			request:    httptest.NewRequest(http.MethodPost, "/healthz", strings.NewReader(`{"unexpected":true}`)),
			wantStatus: http.StatusNotFound,
			wantClose:  true,
		},
		{
			name:       "query",
			request:    httptest.NewRequest(http.MethodGet, "/healthz?attacker=1", nil),
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "get body",
			request:    httptest.NewRequest(http.MethodGet, "/healthz", strings.NewReader(`{"unexpected":true}`)),
			wantStatus: http.StatusNotFound,
			wantClose:  true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, test.request)
			if response.Code != test.wantStatus || test.request.Close != test.wantClose {
				t.Fatalf("response = status:%d close:%v body:%q, want status:%d close:%v",
					response.Code, test.request.Close, response.Body.String(), test.wantStatus, test.wantClose)
			}
		})
	}
}

func TestPublicInFlightGateRejectsWithoutBlockingAndDoesNotReservePublicHealth(t *testing.T) {
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
		newPublicInFlightGate(1, nil, metrics, newPublicHandler(api, api)),
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
	if healthResponse.Code != http.StatusServiceUnavailable ||
		!strings.Contains(healthResponse.Body.String(), `"code":"CAPACITY_UNAVAILABLE"`) {
		t.Fatalf("removed public health capacity response = status:%d body:%s",
			healthResponse.Code, healthResponse.Body.String())
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
		!strings.Contains(secondResponse.Body.String(), `"code":"CAPACITY_UNAVAILABLE"`) {
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
	if metrics.HTTPRequests.Load() != 3 || metrics.HTTPFailures.Load() != 2 ||
		metrics.HTTPServerFailures.Load() != 2 || metrics.CapacityRejected.Load() != 2 ||
		metrics.RateLimited.Load() != 0 || metrics.HTTPRequestDurationCount.Load() != 3 {
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

func TestPublicInFlightGateDoesNotBypassNonCanonicalHealthOrDrainRejectedBody(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	api := http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		writer.WriteHeader(http.StatusNoContent)
	})
	handler := newPublicInFlightGate(1, nil, &platform.Metrics{}, newPublicHandler(api, api))
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, rgsapi.ClientSpinPath, nil))
	}()
	<-started

	nonCanonical := httptest.NewRequest(http.MethodPost, "/healthz", strings.NewReader(`{"unexpected":true}`))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, nonCanonical)
	if recorder.Code != http.StatusServiceUnavailable || !nonCanonical.Close ||
		!strings.Contains(recorder.Body.String(), `"code":"CAPACITY_UNAVAILABLE"`) {
		t.Fatalf("non-canonical health = status:%d close:%v body:%s",
			recorder.Code, nonCanonical.Close, recorder.Body.String())
	}

	close(release)
	<-firstDone
}

func TestPublicInFlightGateAppliesCorsToClientCapacityResponseOnlyForAllowedOrigin(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	api := http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		writer.WriteHeader(http.StatusNoContent)
	})
	allowedOrigins := map[string]struct{}{"https://casino.example": {}}
	handler := newPublicInFlightGate(
		1, nil, &platform.Metrics{}, newPublicHandler(api, api), allowedOrigins,
	)
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		handler.ServeHTTP(
			httptest.NewRecorder(),
			httptest.NewRequest(http.MethodPost, "/operator/v1/launches", nil),
		)
	}()
	<-started

	allowed := httptest.NewRequest(http.MethodPost, "/client/v1/spins", nil)
	allowed.Header.Set("Origin", "https://casino.example")
	allowedResponse := httptest.NewRecorder()
	handler.ServeHTTP(allowedResponse, allowed)
	if allowedResponse.Code != http.StatusServiceUnavailable ||
		allowedResponse.Header().Get("Access-Control-Allow-Origin") != "https://casino.example" ||
		allowedResponse.Header().Get("Access-Control-Expose-Headers") != "Retry-After" ||
		allowedResponse.Header().Get("Retry-After") != "1" ||
		!strings.Contains(allowedResponse.Body.String(), `"code":"CAPACITY_UNAVAILABLE"`) {
		t.Fatalf("allowed capacity CORS response = status:%d headers:%v body:%s",
			allowedResponse.Code, allowedResponse.Header(), allowedResponse.Body.String())
	}

	rejected := httptest.NewRequest(http.MethodPost, "/client/v1/spins", nil)
	rejected.Header.Set("Origin", "https://rejected.example")
	rejectedResponse := httptest.NewRecorder()
	handler.ServeHTTP(rejectedResponse, rejected)
	if rejectedResponse.Code != http.StatusServiceUnavailable ||
		rejectedResponse.Header().Get("Access-Control-Allow-Origin") != "" ||
		rejectedResponse.Header().Get("Access-Control-Expose-Headers") != "" {
		t.Fatalf("rejected capacity CORS response = status:%d headers:%v",
			rejectedResponse.Code, rejectedResponse.Header())
	}

	close(release)
	<-firstDone
}

func TestPublicInFlightGateDoesNotTrustSpoofableRecoveryPath(t *testing.T) {
	started := make(chan string, 2)
	release := make(chan struct{})
	api := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		started <- request.URL.Path
		<-release
		writer.WriteHeader(http.StatusNoContent)
	})
	metrics := &platform.Metrics{}
	handler := newPublicInFlightGate(1, nil, metrics, newPublicHandler(api, api))

	start := func(path string) <-chan *httptest.ResponseRecorder {
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, nil))
			done <- response
		}()
		return done
	}

	spinDone := start("/client/v1/spins")
	if path := <-started; path != "/client/v1/spins" {
		t.Fatalf("first admitted path = %q", path)
	}

	launch := httptest.NewRecorder()
	handler.ServeHTTP(launch, httptest.NewRequest(http.MethodPost, "/operator/v1/launches", nil))
	if launch.Code != http.StatusServiceUnavailable {
		t.Fatalf("second anonymous request exceeded global capacity: %d", launch.Code)
	}

	forgedACKDone := start("/client/v1/results/acknowledgements")
	forgedAdmitted := false
	var forgedACK *httptest.ResponseRecorder
	select {
	case forgedACK = <-forgedACKDone:
	case <-started:
		forgedAdmitted = true
	}

	close(release)
	if response := <-spinDone; response.Code != http.StatusNoContent {
		t.Fatalf("spin response = %d", response.Code)
	}
	if forgedAdmitted {
		forgedACK = <-forgedACKDone
	}
	if forgedAdmitted || forgedACK.Code != http.StatusServiceUnavailable {
		t.Fatalf("unverified ACK path received extra capacity: admitted:%v status:%d",
			forgedAdmitted, forgedACK.Code)
	}
	if metrics.CapacityRejected.Load() != 2 {
		t.Fatalf("capacity metrics = total:%d", metrics.CapacityRejected.Load())
	}
}

func TestPublicPreAuthenticationRateUsesOneGlobalBucket(t *testing.T) {
	metrics := &platform.Metrics{}
	handler := newPublicInFlightGate(
		2,
		platform.NewLimiter(1, 1, 1, time.Minute),
		metrics,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusNoContent)
		}),
	)
	first := httptest.NewRequest(http.MethodPost, "/client/v1/spins", nil)
	first.RemoteAddr = "192.0.2.1:1234"
	first.Header.Set("X-Forwarded-For", "198.51.100.1")
	firstResponse := httptest.NewRecorder()
	handler.ServeHTTP(firstResponse, first)
	if firstResponse.Code != http.StatusNoContent {
		t.Fatalf("first response = %d", firstResponse.Code)
	}

	second := httptest.NewRequest(http.MethodPost, "/operator/v1/launches", nil)
	second.RemoteAddr = "192.0.2.2:5678"
	second.Header.Set("X-Forwarded-For", "198.51.100.2")
	second.Header.Set(operator.HeaderOperatorID, "rotated-operator")
	secondResponse := httptest.NewRecorder()
	handler.ServeHTTP(secondResponse, second)
	if secondResponse.Code != http.StatusServiceUnavailable ||
		secondResponse.Header().Get("Retry-After") != "1" ||
		!strings.Contains(secondResponse.Body.String(), `"code":"CAPACITY_UNAVAILABLE"`) {
		t.Fatalf("global pre-auth response = %d %v %s",
			secondResponse.Code, secondResponse.Header(), secondResponse.Body.String())
	}
	if metrics.PreAuthCapacityRejected.Load() != 1 || metrics.CapacityRejected.Load() != 0 ||
		metrics.RateLimited.Load() != 0 {
		t.Fatalf("pre-auth metrics = preauth:%d inflight:%d rate:%d",
			metrics.PreAuthCapacityRejected.Load(), metrics.CapacityRejected.Load(), metrics.RateLimited.Load())
	}
	recovery := httptest.NewRequest(http.MethodPost, rgsapi.ClientRoundStatusPath, nil)
	recovery.RemoteAddr = "192.0.2.3:9999"
	recovery.Header.Set("X-Forwarded-For", "198.51.100.3")
	recoveryResponse := httptest.NewRecorder()
	handler.ServeHTTP(recoveryResponse, recovery)
	if recoveryResponse.Code != http.StatusServiceUnavailable {
		t.Fatalf("unverified recovery path bypassed anonymous pre-auth capacity: %d", recoveryResponse.Code)
	}
}

func TestPublicPreAuthenticationRejectionClosesUnreadRequestBody(t *testing.T) {
	handler := newPublicInFlightGate(
		2,
		platform.NewLimiter(1, 1, 1, time.Minute),
		&platform.Metrics{},
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusNoContent)
		}),
	)
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, rgsapi.ClientSpinPath, nil))
	rejected := httptest.NewRequest(http.MethodPost, rgsapi.ClientSpinPath, strings.NewReader(`{"unread":true}`))
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, rejected)

	if recorder.Code != http.StatusServiceUnavailable || !rejected.Close {
		t.Fatalf("pre-auth response = status:%d close:%v body:%s", recorder.Code, rejected.Close, recorder.Body.String())
	}
}

type shutdownOrderRecorder struct {
	lifecycle        *platform.LifecycleReadiness
	shutdownSawReady bool
	shutdownCalls    int
	closeCalls       int
}

type concurrentShutdownRecorder struct {
	entered       chan struct{}
	release       <-chan struct{}
	shutdownCalls int
	closeCalls    int
}

func (recorder *concurrentShutdownRecorder) Shutdown(ctx context.Context) error {
	recorder.shutdownCalls++
	close(recorder.entered)
	if recorder.release == nil {
		return nil
	}
	select {
	case <-recorder.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (recorder *concurrentShutdownRecorder) Close() error {
	recorder.closeCalls++
	return nil
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
