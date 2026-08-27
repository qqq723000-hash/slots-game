package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
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
)

func TestAuditSinkAuthenticatesAndPersistsIdempotently(t *testing.T) {
	now := time.Unix(1_800_000_000, 0).UTC()
	directory := t.TempDir()
	store, err := openJSONLStore(filepath.Join(directory, "audit.jsonl"), 1<<20, 8<<20)
	if err != nil {
		t.Fatal(err)
	}
	key := bytes.Repeat([]byte{0x52}, sha256.Size)
	handler, err := newAuditSink(auditSinkConfig{
		Path: "/audit", KeyID: "audit-key-1", HMACKey: key,
		BearerToken: []byte("audit-bearer-token"), MaximumClockSkew: time.Minute,
		MaximumBodyBytes: 1 << 20, MaximumConcurrent: 2, Store: store,
		Now: func() time.Time { return now }, Metrics: &serviceMetrics{},
	})
	if err != nil {
		t.Fatal(err)
	}
	const hostileMarkup = `</script><script>alert(1)</script>`
	body := []byte(`{"schemaVersion":"rgs-outbox-http-v1","id":"7","operatorId":"local-operator","aggregateType":"round","aggregateId":"round-7","eventType":"ROUND_COMMITTED","occurredAt":"2027-01-15T08:00:00Z","payload":{"balanceMinor":"9950","note":"` + hostileMarkup + `"}}`)
	for range 2 {
		request := signedAuditRequest(t, body, key, now, "7")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatalf("audit status = %d body=%s", response.Code, response.Body.String())
		}
		if response.Body.Len() != 0 || strings.Contains(response.Body.String(), hostileMarkup) {
			t.Fatalf("audit response reflected persisted input: %q", response.Body.String())
		}
	}
	persisted, err := os.ReadFile(filepath.Join(directory, "audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(persisted), "\n") != 1 || !bytes.Contains(persisted, body) {
		t.Fatalf("persisted audit = %q", persisted)
	}
}

func TestLogSinkAndAlertmanagerAuthUseBearer(t *testing.T) {
	directory := t.TempDir()
	store, err := openAppendStore(filepath.Join(directory, "runtime.ndjson"), 1<<20, 8<<20)
	if err != nil {
		t.Fatal(err)
	}
	token := []byte("internal-observability-token")
	logs, err := newLogSink(logSinkConfig{
		Path: "/logs", BearerToken: token, MaximumBodyBytes: 1 << 20,
		MaximumConcurrent: 1, Store: store, Metrics: &serviceMetrics{},
	})
	if err != nil {
		t.Fatal(err)
	}
	const hostileMarkup = `</script><script>alert(1)</script>`
	payload := []byte(
		"{\"service\":\"rgs-server\",\"level\":\"INFO\",\"msg\":\"" + hostileMarkup + "\"}\n" +
			"{\"service\":\"vector\",\"time\":\"2026-08-25T00:00:00Z\",\"level\":\"INFO\",\"msg\":\"archive flush heartbeat\"}\n",
	)
	unauthorized := httptest.NewRecorder()
	logs.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodPost, "https://operator.local/logs", bytes.NewReader(payload)))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized logs status = %d", unauthorized.Code)
	}
	request := httptest.NewRequest(http.MethodPost, "https://operator.local/logs", bytes.NewReader(payload))
	request.Header.Set("Authorization", "Bearer "+string(token))
	request.Header.Set("Content-Type", "application/x-ndjson")
	accepted := httptest.NewRecorder()
	wrappedLogs := requestMiddleware(
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		&serviceMetrics{},
		time.Second,
		logs,
	)
	wrappedLogs.ServeHTTP(accepted, request)
	if accepted.Code != http.StatusNoContent {
		t.Fatalf("logs status = %d", accepted.Code)
	}
	if accepted.Body.Len() != 0 || strings.Contains(accepted.Body.String(), hostileMarkup) {
		t.Fatalf("logs response reflected persisted input: %q", accepted.Body.String())
	}
	if got := accepted.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("logs X-Content-Type-Options = %q", got)
	}
	persisted, err := os.ReadFile(filepath.Join(directory, "runtime.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(persisted, payload) {
		t.Fatalf("persisted mixed RGS/heartbeat logs = %q", persisted)
	}

	auth := alertmanagerAuthHandler(token)
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		request := httptest.NewRequest(method, "https://operator.local/internal/auth/alertmanager", nil)
		request.Header.Set("Authorization", "Bearer "+string(token))
		response := httptest.NewRecorder()
		auth.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatalf("%s alertmanager auth status = %d", method, response.Code)
		}
	}
}

func TestSinkStoresRejectWritesBeyondTotalCapacity(t *testing.T) {
	directory := t.TempDir()
	auditPath := filepath.Join(directory, "bounded-audit.jsonl")
	auditBody := []byte(`{"schemaVersion":"rgs-outbox-http-v1","id":"1","operatorId":"operator","aggregateType":"round","aggregateId":"round-1","eventType":"ROUND_COMMITTED","occurredAt":"2027-01-15T08:00:00Z","payload":{}}`)
	audit, err := openJSONLStore(auditPath, 1<<20, int64(len(auditBody)+1))
	if err != nil {
		t.Fatal(err)
	}
	defer audit.Close()
	if accepted, err := audit.Append("1", auditBody); err != nil || !accepted {
		t.Fatalf("first audit append accepted=%v err=%v", accepted, err)
	}
	if err := audit.Ready(); err != nil {
		t.Fatalf("capacity exhaustion must not trigger a readiness restart loop: %v", err)
	}
	if accepted, err := audit.Append("2", auditBody); err == nil || accepted {
		t.Fatalf("capacity audit append accepted=%v err=%v", accepted, err)
	}

	logPath := filepath.Join(directory, "bounded-runtime.ndjson")
	logs, err := openAppendStore(logPath, 1<<20, 8)
	if err != nil {
		t.Fatal(err)
	}
	defer logs.Close()
	if err := logs.Append([]byte("{}\n")); err != nil {
		t.Fatal(err)
	}
	if err := logs.Append([]byte("{\"a\":1}\n")); err == nil {
		t.Fatal("log store accepted a write beyond its total capacity")
	}
	if err := logs.Ready(); err != nil {
		t.Fatalf("capacity exhaustion must remain observable without failing readiness: %v", err)
	}
}

func TestMetricsExposeReadinessWithoutLeakingFailureDetails(t *testing.T) {
	token := []byte("metrics-observability-token")
	for _, test := range []struct {
		name     string
		ready    bool
		expected string
	}{
		{name: "ready", ready: true, expected: "local_operator_ready 1\n"},
		{name: "unavailable", ready: false, expected: "local_operator_ready 0\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			handler := metricsHandler(token, &serviceMetrics{}, func(context.Context) bool { return test.ready }, localOperationsMetrics{})
			request := httptest.NewRequest(http.MethodGet, "https://operator.local/metrics", nil)
			request.Header.Set("Authorization", "Bearer "+string(token))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), test.expected) {
				t.Fatalf("metrics status=%d body=%q", response.Code, response.Body.String())
			}
		})
	}
}

func TestAlertmanagerWebhookAuthenticatesValidatesAndPersistsIdempotently(t *testing.T) {
	directory := t.TempDir()
	store, err := openDeduplicatingAppendStore(filepath.Join(directory, "alerts.jsonl"), 1<<20, 8<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	token := []byte("alertmanager-webhook-token")
	metrics := &serviceMetrics{}
	handler, err := newAlertSink(alertSinkConfig{
		Path: "/alerts", BearerToken: token, MaximumBodyBytes: 1 << 20,
		MaximumConcurrent: 2, Store: store, Metrics: metrics,
	})
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte(`{"version":"4","groupKey":"{}:{alertname=\"RGSNotReady\"}","truncatedAlerts":0,"status":"firing","receiver":"local-production","groupLabels":{"alertname":"RGSNotReady"},"commonLabels":{"alertname":"RGSNotReady","severity":"critical"},"commonAnnotations":{"summary":"RGS unavailable"},"externalURL":"http://alertmanager:9093","notification_reason":"new","alerts":[{"status":"firing","labels":{"alertname":"RGSNotReady","severity":"critical"},"annotations":{"summary":"RGS unavailable"},"startsAt":"2027-01-15T08:00:00Z","endsAt":"0001-01-01T00:00:00Z","generatorURL":"http://prometheus:9090/graph","fingerprint":"0123456789abcdef"}]}`)

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodPost, "https://wallet/alerts", bytes.NewReader(payload)))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized alert status = %d", unauthorized.Code)
	}
	for range 2 {
		request := httptest.NewRequest(http.MethodPost, "https://wallet/alerts", bytes.NewReader(payload))
		request.Header.Set("Authorization", "Bearer "+string(token))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatalf("alert status = %d body=%s", response.Code, response.Body.String())
		}
	}
	persisted, err := os.ReadFile(filepath.Join(directory, "alerts.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(persisted), "\n") != 1 || metrics.alertAccepted.Load() != 2 {
		t.Fatalf("alerts were not idempotent: lines=%d accepted=%d", strings.Count(string(persisted), "\n"), metrics.alertAccepted.Load())
	}
}

func TestAuditStoreRotatesSealedSegmentsAndRebuildsIdempotency(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "events.jsonl")
	store, err := openJSONLStoreWithSegment(path, 1024, 16<<10, 1024)
	if err != nil {
		t.Fatal(err)
	}
	bodies := make([][]byte, 0, 12)
	for id := 1; id <= 12; id++ {
		body := []byte(fmt.Sprintf(`{"schemaVersion":"rgs-outbox-http-v1","id":"%d","operatorId":"operator","aggregateType":"round","aggregateId":"round-%d","eventType":"ROUND_COMMITTED","occurredAt":"2027-01-15T08:00:00Z","payload":{"padding":"%s"}}`, id, id, strings.Repeat("x", 180)))
		bodies = append(bodies, body)
		if accepted, err := store.Append(strconv.Itoa(id), body); err != nil || !accepted {
			t.Fatalf("append %d accepted=%v err=%v", id, accepted, err)
		}
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	segments, err := JSONLSegments(path)
	if err != nil || len(segments) < 2 {
		t.Fatalf("segments=%v err=%v", segments, err)
	}
	for _, archive := range segments[:len(segments)-1] {
		info, err := os.Stat(archive)
		if err != nil || info.Mode().Perm() != 0o400 {
			t.Fatalf("archive %s mode=%v err=%v", archive, info.Mode().Perm(), err)
		}
	}
	reopened, err := openJSONLStoreWithSegment(path, 1024, 16<<10, 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	accepted, err := reopened.Append("1", bodies[0])
	if err != nil || accepted {
		t.Fatalf("archived duplicate accepted=%v err=%v", accepted, err)
	}
}

func signedAuditRequest(t *testing.T, body, key []byte, now time.Time, eventID string) *http.Request {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "https://operator.local/audit", bytes.NewReader(body))
	digestBytes := sha256.Sum256(body)
	digest := "sha-256=:" + base64.StdEncoding.EncodeToString(digestBytes[:]) + ":"
	timestamp := strconv.FormatInt(now.Unix(), 10)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Content-Digest", digest)
	request.Header.Set("X-RGS-Event-Id", eventID)
	request.Header.Set("Idempotency-Key", "outbox-"+eventID)
	request.Header.Set("X-RGS-Key-Id", "audit-key-1")
	request.Header.Set("X-RGS-Signature-Timestamp", timestamp)
	request.Header.Set("Authorization", "Bearer audit-bearer-token")
	canonical := strings.Join([]string{
		"rgs-outbox-http-v1", `"@method": POST`, `"@authority": operator.local`,
		`"@path": /audit`, `"content-digest": ` + digest,
		`"x-rgs-event-id": ` + eventID, `"x-rgs-key-id": audit-key-1`,
		fmt.Sprintf(`"x-rgs-signature-timestamp": %d`, now.Unix()),
	}, "\n")
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(canonical))
	request.Header.Set("X-RGS-Signature", "hmac-sha256=:"+base64.StdEncoding.EncodeToString(mac.Sum(nil))+":")
	return request
}
