package platform

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetricsHTTPHandler(t *testing.T) {
	metrics := &Metrics{}
	metrics.RoundsCommitted.Store(7)
	response := httptest.NewRecorder()
	metrics.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if response.Code != http.StatusOK ||
		!strings.Contains(response.Body.String(), "rgs_rounds_committed_total 7") {
		t.Fatalf("metrics response = %d %s", response.Code, response.Body.String())
	}
}
