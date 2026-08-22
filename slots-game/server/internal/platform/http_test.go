package platform

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMiddlewareAppliesSecurityCORSAndAdmissionLimits(t *testing.T) {
	metrics := &Metrics{}
	middleware := Middleware{
		Metrics: metrics, Limiter: NewLimiter(1, 1, 10, time.Minute), MaxRequestBytes: 1024,
		AllowedOrigins: map[string]struct{}{"https://casino.example": {}},
	}
	handler := middleware.Wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	request := httptest.NewRequest(http.MethodGet, "/client/v1/session", nil)
	request.RemoteAddr = "192.0.2.3:1234"
	request.Header.Set("Origin", "https://casino.example")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent || recorder.Header().Get("X-Content-Type-Options") != "nosniff" || recorder.Header().Get("Access-Control-Allow-Origin") == "" {
		t.Fatalf("unexpected response: %d %#v", recorder.Code, recorder.Header())
	}
	if got := recorder.Header().Get("Access-Control-Expose-Headers"); got != "Retry-After" {
		t.Fatalf("exposed CORS headers = %q, want Retry-After", got)
	}
	second := httptest.NewRecorder()
	handler.ServeHTTP(second, request)
	if second.Code != http.StatusTooManyRequests || metrics.RateLimited.Load() != 1 {
		t.Fatalf("second response = %d, rate limited = %d", second.Code, metrics.RateLimited.Load())
	}
	if second.Header().Get("Content-Type") != "application/json" ||
		!bytes.Contains(second.Body.Bytes(), []byte(`"code":"RATE_LIMITED"`)) {
		t.Fatalf("rate-limit envelope = headers:%v body:%s", second.Header(), second.Body.Bytes())
	}
}

func TestMiddlewareDoesNotExposeRetryAfterToRejectedOrigin(t *testing.T) {
	middleware := Middleware{
		AllowedOrigins: map[string]struct{}{"https://casino.example": {}},
	}
	handler := middleware.Wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "2")
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	request := httptest.NewRequest(http.MethodGet, "/client/v1/rounds/status", nil)
	request.Header.Set("Origin", "https://rejected.example")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("rejected origin received Access-Control-Allow-Origin %q", got)
	}
	if got := recorder.Header().Get("Access-Control-Expose-Headers"); got != "" {
		t.Fatalf("rejected origin received exposed CORS headers %q", got)
	}
}

func TestMiddlewareAdmissionIgnoresUnverifiedOperatorHeader(t *testing.T) {
	middleware := Middleware{Limiter: NewLimiter(1, 1, 10, time.Minute)}
	handler := middleware.Wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	first := httptest.NewRequest(http.MethodPost, "/operator/v1/launch", nil)
	first.RemoteAddr = "192.0.2.44:1234"
	first.Header.Set("X-Operator-Id", "operator-a")
	firstRecorder := httptest.NewRecorder()
	handler.ServeHTTP(firstRecorder, first)
	if firstRecorder.Code != http.StatusNoContent {
		t.Fatalf("first response = %d", firstRecorder.Code)
	}

	second := httptest.NewRequest(http.MethodPost, "/operator/v1/launch", nil)
	second.RemoteAddr = first.RemoteAddr
	second.Header.Set("X-Operator-Id", "operator-b")
	secondRecorder := httptest.NewRecorder()
	handler.ServeHTTP(secondRecorder, second)
	if secondRecorder.Code != http.StatusTooManyRequests {
		t.Fatalf("rotated unverified tenant header bypassed peer limit: %d", secondRecorder.Code)
	}
}

func TestMiddlewareLogsOnlySafeRequestMetadata(t *testing.T) {
	var logs bytes.Buffer
	middleware := Middleware{Logger: slog.New(slog.NewJSONHandler(&logs, nil))}
	handler := middleware.Wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	request := httptest.NewRequest("BREW", "/client/v1/private-path?player=secret", nil)
	request.RemoteAddr = "203.0.113.22:443"
	request.Header.Set("X-Request-Id", "req_safe-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("response status = %d, want %d", response.Code, http.StatusNoContent)
	}
	assertMiddlewareLogsRedacted(t, logs.String(), "req_safe-1", "OTHER", "/client/v1/private-path", "203.0.113.22")
}

func TestMiddlewarePanicLogDoesNotLeakRequestLocation(t *testing.T) {
	var logs bytes.Buffer
	metrics := &Metrics{}
	middleware := Middleware{Logger: slog.New(slog.NewJSONHandler(&logs, nil)), Metrics: metrics}
	handler := middleware.Wrap(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("test panic")
	}))
	request := httptest.NewRequest(http.MethodPost, "/client/v1/private-path?session=secret", nil)
	request.RemoteAddr = "203.0.113.23:443"
	request.Header.Set("X-Request-Id", "req_safe-2")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("panic response status = %d, want %d", response.Code, http.StatusInternalServerError)
	}
	if metrics.HTTPFailures.Load() != 1 || metrics.HTTPServerFailures.Load() != 1 {
		t.Fatalf("panic metrics = total:%d server:%d", metrics.HTTPFailures.Load(), metrics.HTTPServerFailures.Load())
	}
	assertMiddlewareLogsRedacted(t, logs.String(), "req_safe-2", http.MethodPost, "/client/v1/private-path", "203.0.113.23")
}

func assertMiddlewareLogsRedacted(
	t *testing.T,
	output, requestID, method, forbiddenPath, forbiddenAddress string,
) {
	t.Helper()
	if strings.Contains(output, forbiddenPath) || strings.Contains(output, forbiddenAddress) {
		t.Fatalf("middleware log leaks raw request location: %s", output)
	}
	entries := strings.Split(strings.TrimSpace(output), "\n")
	if len(entries) == 0 || entries[0] == "" {
		t.Fatal("middleware did not emit a log record")
	}
	for _, line := range entries {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("decode middleware log: %v: %s", err, line)
		}
		if entry["request_id"] != requestID || entry["method"] != method {
			t.Fatalf("unsafe or unexpected middleware log fields: %#v", entry)
		}
		if _, exists := entry["duration_ms"]; !exists {
			t.Fatalf("duration missing from middleware log: %#v", entry)
		}
		for _, forbidden := range []string{"path", "url", "remote_addr", "remote_ip"} {
			if _, exists := entry[forbidden]; exists {
				t.Fatalf("forbidden %s field in middleware log: %#v", forbidden, entry)
			}
		}
	}
}
