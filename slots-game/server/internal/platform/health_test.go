package platform

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type checkStub struct {
	name string
	err  error
}

func TestLivenessRemainsHealthyWithoutDatabaseState(t *testing.T) {
	recorder := httptest.NewRecorder()
	LivenessHandler(recorder, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if recorder.Code != http.StatusOK || !contains(recorder.Body.String(), `"status":"ok"`) {
		t.Fatalf("liveness = %d %s", recorder.Code, recorder.Body.String())
	}
}

func (c checkStub) Name() string                { return c.name }
func (c checkStub) Check(context.Context) error { return c.err }

func TestReadinessFailsClosedAndDoesNotLeakErrors(t *testing.T) {
	handler := Readiness{Checks: []DependencyCheck{
		checkStub{name: "database"},
		checkStub{name: "wallet", err: errors.New("secret endpoint and credential")},
	}, Timeout: time.Second}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", recorder.Code)
	}
	if body := recorder.Body.String(); body == "" || contains(body, "secret") {
		t.Fatalf("unsafe readiness body: %s", body)
	}
}

func TestLifecycleReadinessFailsClosedAfterDrainBegins(t *testing.T) {
	lifecycle := &LifecycleReadiness{}
	if lifecycle.Name() != "lifecycle" {
		t.Fatalf("Name() = %q", lifecycle.Name())
	}
	if err := lifecycle.Check(context.Background()); err != nil {
		t.Fatalf("Check() before drain error = %v", err)
	}

	lifecycle.BeginDrain()
	lifecycle.BeginDrain()
	if err := lifecycle.Check(context.Background()); err == nil {
		t.Fatal("Check() after drain succeeded")
	}

	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := lifecycle.Check(canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("Check() canceled error = %v", err)
	}
}

func TestOperationsHandlersRejectOtherMethodsAsPlainText(t *testing.T) {
	t.Parallel()
	metrics := &Metrics{}
	readiness := Readiness{Timeout: time.Second}
	for _, test := range []struct {
		name    string
		handler http.Handler
	}{
		{name: "liveness", handler: http.HandlerFunc(LivenessHandler)},
		{name: "readiness", handler: readiness},
		{name: "metrics", handler: MetricsEndpoint{Metrics: metrics, Readiness: readiness}},
	} {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			test.handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/", nil))
			if recorder.Code != http.StatusMethodNotAllowed || recorder.Header().Get("Allow") != http.MethodGet ||
				!strings.HasPrefix(recorder.Header().Get("Content-Type"), "text/plain") {
				t.Fatalf("method response = status %d, Allow %q, Content-Type %q", recorder.Code,
					recorder.Header().Get("Allow"), recorder.Header().Get("Content-Type"))
			}
		})
	}
}

func TestOperationsHandlersRejectDeclaredOrChunkedBodies(t *testing.T) {
	t.Parallel()
	metrics := &Metrics{}
	readiness := Readiness{Timeout: time.Second}
	for _, test := range []struct {
		name    string
		handler http.Handler
	}{
		{name: "liveness", handler: http.HandlerFunc(LivenessHandler)},
		{name: "readiness", handler: readiness},
		{name: "metrics", handler: MetricsEndpoint{Metrics: metrics, Readiness: readiness}},
	} {
		for _, transfer := range []string{"content-length", "chunked"} {
			t.Run(test.name+"/"+transfer, func(t *testing.T) {
				request := httptest.NewRequest(http.MethodGet, "/", nil)
				if transfer == "content-length" {
					request.ContentLength = 1
				} else {
					request.TransferEncoding = []string{"chunked"}
				}
				recorder := httptest.NewRecorder()
				test.handler.ServeHTTP(recorder, request)
				if recorder.Code != http.StatusBadRequest || recorder.Header().Get("Connection") != "close" ||
					recorder.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("body response = status %d, headers %v", recorder.Code, recorder.Header())
				}
			})
		}
	}
}

func contains(value, needle string) bool {
	for i := 0; i+len(needle) <= len(value); i++ {
		if value[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
