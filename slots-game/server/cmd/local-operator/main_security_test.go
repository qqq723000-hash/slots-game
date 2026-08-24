package main

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type localOperatorShutdownRecorder struct {
	shutdownErr  error
	closeErr     error
	shutdownCall int
	closeCall    int
}

type blockingLocalOperatorShutdownRecorder struct {
	shutdownEntered chan struct{}
	shutdownRelease chan struct{}
	closeCall       int
}

type localOperatorResponseControllerRecorder struct {
	*httptest.ResponseRecorder
	readDeadline time.Time
}

func (recorder *localOperatorResponseControllerRecorder) SetReadDeadline(deadline time.Time) error {
	recorder.readDeadline = deadline
	return nil
}

type localOperatorMultiStageResponseWriter struct {
	header        http.Header
	informational []int
	status        int
	body          bytes.Buffer
}

type localOperatorCommittedFlushErrorWriter struct {
	*localOperatorMultiStageResponseWriter
	flushErr error
}

func (writer *localOperatorCommittedFlushErrorWriter) FlushError() error {
	if writer.status == 0 {
		writer.WriteHeader(http.StatusOK)
	}
	return writer.flushErr
}

func (writer *localOperatorMultiStageResponseWriter) Header() http.Header {
	if writer.header == nil {
		writer.header = make(http.Header)
	}
	return writer.header
}

func (writer *localOperatorMultiStageResponseWriter) WriteHeader(status int) {
	if writer.status != 0 {
		return
	}
	if status >= 100 && status < 200 && status != http.StatusSwitchingProtocols {
		writer.informational = append(writer.informational, status)
		return
	}
	writer.status = status
}

func (writer *localOperatorMultiStageResponseWriter) Write(encoded []byte) (int, error) {
	if writer.status == 0 {
		writer.status = http.StatusOK
	}
	return writer.body.Write(encoded)
}

func (recorder *localOperatorShutdownRecorder) Shutdown(context.Context) error {
	recorder.shutdownCall++
	return recorder.shutdownErr
}

func (recorder *localOperatorShutdownRecorder) Close() error {
	recorder.closeCall++
	return recorder.closeErr
}

func (recorder *blockingLocalOperatorShutdownRecorder) Shutdown(ctx context.Context) error {
	close(recorder.shutdownEntered)
	select {
	case <-recorder.shutdownRelease:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (recorder *blockingLocalOperatorShutdownRecorder) Close() error {
	recorder.closeCall++
	return nil
}

func TestRuntimeFailureLogDoesNotExposeStartupErrorText(t *testing.T) {
	t.Parallel()
	const secret = "postgres://operator:password@database.internal/rgs /run/secrets/operator-key"
	var output bytes.Buffer
	logRuntimeFailure(slog.New(slog.NewJSONHandler(&output, nil)), errors.New(secret))
	logOutput := output.String()
	if strings.Contains(logOutput, secret) || strings.Contains(logOutput, "password") ||
		strings.Contains(logOutput, "operator-key") ||
		!strings.Contains(logOutput, `"error_class":"internal"`) {
		t.Fatalf("unsafe runtime failure log: %s", logOutput)
	}
}

func TestShutdownLocalOperatorForceClosesAfterGracefulFailure(t *testing.T) {
	t.Parallel()
	shutdownFailure := errors.New("graceful shutdown deadline")
	closeFailure := errors.New("forced close failed")
	recorder := &localOperatorShutdownRecorder{
		shutdownErr: shutdownFailure,
		closeErr:    closeFailure,
	}
	err := shutdownLocalOperatorHTTPServer(context.Background(), recorder)
	if !errors.Is(err, shutdownFailure) || !errors.Is(err, closeFailure) {
		t.Fatalf("shutdown error = %v, want both failures", err)
	}
	if recorder.shutdownCall != 1 || recorder.closeCall != 1 {
		t.Fatalf("shutdown calls = graceful:%d close:%d", recorder.shutdownCall, recorder.closeCall)
	}

	clean := &localOperatorShutdownRecorder{}
	if err := shutdownLocalOperatorHTTPServer(context.Background(), clean); err != nil {
		t.Fatalf("clean shutdown error = %v", err)
	}
	if clean.shutdownCall != 1 || clean.closeCall != 0 {
		t.Fatalf("clean shutdown calls = graceful:%d close:%d", clean.shutdownCall, clean.closeCall)
	}
}

func TestServeFailureWaitsForActiveHandlersBeforeReturning(t *testing.T) {
	t.Parallel()
	serveFailure := errors.New("listener failed while serving")
	recorder := &blockingLocalOperatorShutdownRecorder{
		shutdownEntered: make(chan struct{}),
		shutdownRelease: make(chan struct{}),
	}
	completed := make(chan error, 1)
	go func() {
		completed <- shutdownLocalOperatorAfterServeFailure(context.Background(), recorder, serveFailure)
	}()

	select {
	case <-recorder.shutdownEntered:
	case <-time.After(time.Second):
		t.Fatal("serve failure did not start graceful shutdown")
	}
	select {
	case err := <-completed:
		t.Fatalf("serve failure returned before active handler drain: %v", err)
	default:
	}
	close(recorder.shutdownRelease)
	select {
	case err := <-completed:
		if !errors.Is(err, serveFailure) {
			t.Fatalf("serve failure result = %v, want original failure", err)
		}
	case <-time.After(time.Second):
		t.Fatal("serve failure did not return after active handler drain")
	}
	if recorder.closeCall != 0 {
		t.Fatalf("clean serve failure drain forced close %d times", recorder.closeCall)
	}
}

func TestServeFailurePreservesOriginalErrorAndForceCloseFailure(t *testing.T) {
	t.Parallel()
	serveFailure := errors.New("listener failed")
	shutdownFailure := errors.New("active handler drain failed")
	closeFailure := errors.New("forced connection close failed")
	recorder := &localOperatorShutdownRecorder{
		shutdownErr: shutdownFailure,
		closeErr:    closeFailure,
	}
	err := shutdownLocalOperatorAfterServeFailure(context.Background(), recorder, serveFailure)
	if !errors.Is(err, serveFailure) || !errors.Is(err, shutdownFailure) || !errors.Is(err, closeFailure) {
		t.Fatalf("serve failure result = %v, want serve, shutdown, and close failures", err)
	}
	if recorder.shutdownCall != 1 || recorder.closeCall != 1 {
		t.Fatalf("serve failure calls = graceful:%d close:%d", recorder.shutdownCall, recorder.closeCall)
	}
}

func TestRequestMiddlewarePreservesResponseControllerFlush(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	var flushErr error
	var deadlineErr error
	deadline := time.Unix(1_800_000_000, 0)
	handler := requestMiddleware(
		slog.New(slog.NewJSONHandler(&output, nil)),
		&serviceMetrics{},
		time.Second,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			controller := http.NewResponseController(writer)
			deadlineErr = controller.SetReadDeadline(deadline)
			flushErr = controller.Flush()
			writer.WriteHeader(http.StatusTeapot)
		}),
	)
	response := &localOperatorResponseControllerRecorder{ResponseRecorder: httptest.NewRecorder()}
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "https://operator.local/healthz", nil))
	if deadlineErr != nil || !response.readDeadline.Equal(deadline) {
		t.Fatalf("ResponseController.SetReadDeadline() through middleware = %v, deadline:%v", deadlineErr, response.readDeadline)
	}
	if flushErr != nil {
		t.Fatalf("ResponseController.Flush() through middleware = %v", flushErr)
	}
	if response.Code != http.StatusOK || !response.Flushed {
		t.Fatalf("flushed response = status:%d flushed:%v", response.Code, response.Flushed)
	}
	if !strings.Contains(output.String(), `"status":200`) || strings.Contains(output.String(), `"status":418`) {
		t.Fatalf("flush commit was not reflected in access log: %s", output.String())
	}
}

func TestRequestMiddlewarePreservesInformationalThenFinalStatus(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	handler := requestMiddleware(
		slog.New(slog.NewJSONHandler(&output, nil)),
		&serviceMetrics{},
		time.Second,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusEarlyHints)
			writer.WriteHeader(http.StatusNoContent)
		}),
	)
	response := &localOperatorMultiStageResponseWriter{}
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "https://operator.local/healthz", nil))
	if len(response.informational) != 1 || response.informational[0] != http.StatusEarlyHints ||
		response.status != http.StatusNoContent {
		t.Fatalf("multi-stage response = informational:%v final:%d", response.informational, response.status)
	}
	if !strings.Contains(output.String(), `"status":204`) || strings.Contains(output.String(), `"status":103`) {
		t.Fatalf("multi-stage response log drifted: %s", output.String())
	}
}

func TestRequestMiddlewareDoesNotCommitStatusForUnsupportedFlush(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	var flushErr error
	handler := requestMiddleware(
		slog.New(slog.NewJSONHandler(&output, nil)),
		&serviceMetrics{},
		time.Second,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			flushErr = http.NewResponseController(writer).Flush()
			writer.WriteHeader(http.StatusTeapot)
		}),
	)
	response := &localOperatorMultiStageResponseWriter{}
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "https://operator.local/healthz", nil))
	if !errors.Is(flushErr, http.ErrNotSupported) || response.status != http.StatusTeapot {
		t.Fatalf("unsupported flush = error:%v final:%d", flushErr, response.status)
	}
	if !strings.Contains(output.String(), `"status":418`) || strings.Contains(output.String(), `"status":200`) {
		t.Fatalf("unsupported-flush response log drifted: %s", output.String())
	}
}

func TestRequestMiddlewareRecordsCommittedStatusWhenFlushFails(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	flushFailure := errors.New("flush network failure")
	var flushErr error
	handler := requestMiddleware(
		slog.New(slog.NewJSONHandler(&output, nil)),
		&serviceMetrics{},
		time.Second,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			flushErr = http.NewResponseController(writer).Flush()
			writer.WriteHeader(http.StatusTeapot)
		}),
	)
	response := &localOperatorCommittedFlushErrorWriter{
		localOperatorMultiStageResponseWriter: &localOperatorMultiStageResponseWriter{},
		flushErr:                              flushFailure,
	}
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "https://operator.local/healthz", nil))
	if !errors.Is(flushErr, flushFailure) || response.status != http.StatusOK {
		t.Fatalf("failed flush = error:%v final:%d", flushErr, response.status)
	}
	if !strings.Contains(output.String(), `"status":200`) || strings.Contains(output.String(), `"status":418`) {
		t.Fatalf("failed-flush response log drifted: %s", output.String())
	}
}

func TestNormalizedLocalOperatorRoutePreservesOnlyRegisteredRoutes(t *testing.T) {
	t.Parallel()
	registered := []string{
		"/",
		"/launch",
		"/api/v1/launches",
		"/rgs/wallet/v1/rounds/apply",
		"/rgs/wallet/v1/transactions/status",
		"/rgs/wallet/v1/transactions/rollback",
		"/audit",
		"/logs",
		"/alerts",
		"/healthz",
		"/metrics",
		"/internal/auth/alertmanager",
	}
	for _, route := range registered {
		if got := normalizedLocalOperatorRoute(route); got != route {
			t.Errorf("normalizedLocalOperatorRoute(%q) = %q", route, got)
		}
	}
	if got := normalizedLocalOperatorRoute("/players/private-player/wallet/private-wallet"); got != "other" {
		t.Fatalf("unknown route = %q", got)
	}
}

func TestRequestLogPreservesKnownMethodAndRoute(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	handler := requestMiddleware(
		slog.New(slog.NewJSONHandler(&output, nil)),
		&serviceMetrics{},
		time.Second,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusNoContent)
		}),
	)
	handler.ServeHTTP(
		httptest.NewRecorder(),
		httptest.NewRequest(http.MethodPost, "https://operator.local/audit", nil),
	)
	logOutput := output.String()
	if !strings.Contains(logOutput, `"method":"POST"`) ||
		!strings.Contains(logOutput, `"route":"/audit"`) || strings.Contains(logOutput, `"path"`) {
		t.Fatalf("known route log = %s", logOutput)
	}
}

func TestRequestLogFoldsUnknownMethodAndPathWithoutIdentity(t *testing.T) {
	t.Parallel()
	const method = "TRACE-PRIVATE-PLAYER"
	const path = "/players/private-player/wallet/private-wallet"
	var output bytes.Buffer
	handler := requestMiddleware(
		slog.New(slog.NewJSONHandler(&output, nil)),
		&serviceMetrics{},
		time.Second,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusNotFound)
		}),
	)
	handler.ServeHTTP(
		httptest.NewRecorder(),
		httptest.NewRequest(method, "https://operator.local"+path, nil),
	)
	logOutput := output.String()
	if !strings.Contains(logOutput, `"method":"other"`) ||
		!strings.Contains(logOutput, `"route":"other"`) ||
		strings.Contains(logOutput, method) || strings.Contains(logOutput, "private-player") ||
		strings.Contains(logOutput, "private-wallet") {
		t.Fatalf("unknown request log = %s", logOutput)
	}
}

func TestRequestLogNeverIncludesRawQuery(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	handler := requestMiddleware(
		slog.New(slog.NewJSONHandler(&output, nil)),
		&serviceMetrics{},
		time.Second,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusUnauthorized)
		}),
	)
	handler.ServeHTTP(
		httptest.NewRecorder(),
		httptest.NewRequest(
			http.MethodGet,
			"https://operator.local/metrics?access_token=private-token&player=private-player",
			nil,
		),
	)
	logOutput := output.String()
	if !strings.Contains(logOutput, `"route":"/metrics"`) ||
		strings.Contains(logOutput, "access_token") || strings.Contains(logOutput, "private-token") ||
		strings.Contains(logOutput, "private-player") {
		t.Fatalf("query leaked into request log: %s", logOutput)
	}
}

func TestSuccessfulLogSinkStillSuppressesFeedbackLog(t *testing.T) {
	t.Parallel()
	var successful bytes.Buffer
	successHandler := requestMiddleware(
		slog.New(slog.NewJSONHandler(&successful, nil)),
		&serviceMetrics{},
		time.Second,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusNoContent)
		}),
	)
	successHandler.ServeHTTP(
		httptest.NewRecorder(),
		httptest.NewRequest(http.MethodPost, "https://operator.local/logs", nil),
	)
	if successful.Len() != 0 {
		t.Fatalf("successful /logs request created a feedback log: %s", successful.String())
	}

	var failed bytes.Buffer
	failureHandler := requestMiddleware(
		slog.New(slog.NewJSONHandler(&failed, nil)),
		&serviceMetrics{},
		time.Second,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusUnauthorized)
		}),
	)
	failureHandler.ServeHTTP(
		httptest.NewRecorder(),
		httptest.NewRequest(http.MethodPost, "https://operator.local/logs", nil),
	)
	if !strings.Contains(failed.String(), `"route":"/logs"`) ||
		!strings.Contains(failed.String(), `"status":401`) {
		t.Fatalf("failed /logs request was not observable: %s", failed.String())
	}
}
