package outbox

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestHTTPPublisherSendsStableSignedIdempotentEnvelope(t *testing.T) {
	key := []byte(strings.Repeat("k", sha256.Size))
	fixedNow := time.Unix(1_800_000_000, 0).UTC()
	var mu sync.Mutex
	var bodies [][]byte
	var headers []http.Header
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read body: %v", err)
		}
		mu.Lock()
		bodies = append(bodies, body)
		headers = append(headers, request.Header.Clone())
		mu.Unlock()
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	publisher, err := NewHTTPPublisher(HTTPPublisherConfig{
		Endpoint: server.URL + "/audit/events", KeyID: "audit-2026-01",
		SigningKey: key, BearerToken: []byte("test-bearer-token-value"),
		Client: server.Client(), AllowInsecureDevelopment: true,
		Now: func() time.Time { return fixedNow },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = publisher.Close() })
	event := Event{
		ID: 9_007_199_254_740_999, OperatorID: "operator-a",
		AggregateType: "round", AggregateID: "round-1", EventType: "ROUND_COMMITTED",
		Payload:   json.RawMessage(`{"roundId":"round-1","amountMinor":"10"}`),
		CreatedAt: time.Date(2026, 7, 26, 1, 2, 3, 400, time.FixedZone("offset", 8*60*60)),
		Attempts:  1,
	}
	if err := publisher.Publish(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	event.Attempts = 7
	if err := publisher.Publish(context.Background(), event); err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 2 || string(bodies[0]) != string(bodies[1]) {
		t.Fatalf("retry bodies are not stable: %q / %q", bodies[0], bodies[1])
	}
	var envelope httpEnvelope
	if err := json.Unmarshal(bodies[0], &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.SchemaVersion != httpEnvelopeVersion || envelope.ID != "9007199254740999" ||
		envelope.OccurredAt != "2026-07-25T17:02:03.0000004Z" {
		t.Fatalf("unexpected envelope: %+v", envelope)
	}
	wantID := "9007199254740999"
	for _, header := range headers {
		if header.Get(HeaderEventID) != wantID || header.Get(HeaderIdempotencyKey) != "outbox-"+wantID ||
			header.Get("Authorization") != "Bearer test-bearer-token-value" ||
			header.Get("Content-Type") != httpEnvelopeContentType {
			t.Fatalf("unexpected headers: %v", header)
		}
		digest := contentDigest(bodies[0])
		request, err := http.NewRequest(http.MethodPost, server.URL+"/audit/events", nil)
		if err != nil {
			t.Fatal(err)
		}
		canonical := canonicalHTTPMessage(request, wantID, "audit-2026-01", "1800000000", digest)
		if !strings.Contains(canonical, `"@authority": `+strings.ToLower(strings.TrimPrefix(server.URL, "http://"))) {
			t.Fatalf("canonical message does not bind URL authority: %q", canonical)
		}
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write([]byte(canonical))
		wantSignature := "hmac-sha256=:" + base64.StdEncoding.EncodeToString(mac.Sum(nil)) + ":"
		if header.Get(HeaderContentDigest) != digest || header.Get(HeaderEventSignature) != wantSignature {
			t.Fatalf("signature headers = %v, want digest %q signature %q", header, digest, wantSignature)
		}
	}
}

func TestHTTPPublisherRejectsRedirectAndDoesNotLeakResponse(t *testing.T) {
	var targetCalled atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		targetCalled.Store(true)
	}))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/redirect" {
			http.Redirect(writer, request, target.URL+"/stolen", http.StatusTemporaryRedirect)
			return
		}
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte("secret downstream diagnostic"))
	}))
	defer redirect.Close()

	publisher, err := NewHTTPPublisher(HTTPPublisherConfig{
		Endpoint: redirect.URL + "/redirect", KeyID: "key-1",
		SigningKey: []byte(strings.Repeat("s", sha256.Size)), Client: redirect.Client(),
		AllowInsecureDevelopment: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	event := validHTTPTestEvent()
	err = publisher.Publish(context.Background(), event)
	if err == nil || targetCalled.Load() {
		t.Fatalf("redirect result = %v, targetCalled = %v", err, targetCalled.Load())
	}
	if strings.Contains(err.Error(), redirect.URL) || strings.Contains(err.Error(), target.URL) {
		t.Fatalf("redirect error leaks endpoint: %v", err)
	}

	publisher, err = NewHTTPPublisher(HTTPPublisherConfig{
		Endpoint: redirect.URL + "/denied", KeyID: "key-1",
		SigningKey: []byte(strings.Repeat("s", sha256.Size)), Client: redirect.Client(),
		AllowInsecureDevelopment: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	err = publisher.Publish(context.Background(), event)
	if err == nil || strings.Contains(err.Error(), "secret downstream") || strings.Contains(err.Error(), redirect.URL) {
		t.Fatalf("unsafe status error = %v", err)
	}
}

func TestHTTPPublisherValidatesConfigurationAndClose(t *testing.T) {
	key := []byte(strings.Repeat("k", sha256.Size))
	for name, config := range map[string]HTTPPublisherConfig{
		"plain HTTP":  {Endpoint: "http://audit.example/events", KeyID: "key-1", SigningKey: key},
		"query":       {Endpoint: "https://audit.example/events?token=secret", KeyID: "key-1", SigningKey: key},
		"missing key": {Endpoint: "https://audit.example/events", KeyID: "key-1"},
		"bad token":   {Endpoint: "https://audit.example/events", KeyID: "key-1", SigningKey: key, BearerToken: []byte("contains whitespace")},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := NewHTTPPublisher(config); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("NewHTTPPublisher() error = %v", err)
			}
		})
	}
	publisher, err := NewHTTPPublisher(HTTPPublisherConfig{
		Endpoint: "https://audit.example/events", KeyID: "key-1", SigningKey: key,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := publisher.Close(); err != nil {
		t.Fatal(err)
	}
	if err := publisher.Close(); err != nil {
		t.Fatal(err)
	}
	if err := publisher.Publish(context.Background(), validHTTPTestEvent()); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("Publish() after close error = %v", err)
	}
}

func TestLoadHTTPPublisherSecrets(t *testing.T) {
	directory := t.TempDir()
	keyPath := filepath.Join(directory, "outbox-hmac.key")
	wantKey := []byte(strings.Repeat("h", sha256.Size))
	if err := os.WriteFile(keyPath, []byte(base64.StdEncoding.EncodeToString(wantKey)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	key, err := LoadHMACKey(keyPath)
	if err != nil || string(key) != string(wantKey) {
		t.Fatalf("LoadHMACKey() = (%q, %v)", key, err)
	}
	tokenPath := filepath.Join(directory, "bearer.token")
	if err := os.WriteFile(tokenPath, []byte("a-long-bearer-token\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	token, err := LoadBearerToken(tokenPath)
	if err != nil || string(token) != "a-long-bearer-token" {
		t.Fatalf("LoadBearerToken() = (%q, %v)", token, err)
	}
	if err := os.Chmod(tokenPath, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadBearerToken(tokenPath); err == nil {
		t.Fatal("world-readable bearer token unexpectedly accepted")
	}
}

func TestNewSecureHTTPClientRejectsInvalidTLSConfiguration(t *testing.T) {
	if _, err := NewSecureHTTPClient(HTTPClientConfig{}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("zero timeout error = %v", err)
	}
	if _, err := NewSecureHTTPClient(HTTPClientConfig{
		Timeout: time.Second, ClientCertFile: "/tmp/cert-only.pem",
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("unpaired client certificate error = %v", err)
	}
}

func TestSecureHTTPClientUsesConfiguredRootCA(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	rootPath := filepath.Join(t.TempDir(), "audit-root.pem")
	rootPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
	if err := os.WriteFile(rootPath, rootPEM, 0o644); err != nil {
		t.Fatal(err)
	}
	client, err := NewSecureHTTPClient(HTTPClientConfig{Timeout: time.Second, RootCAFile: rootPath})
	if err != nil {
		t.Fatal(err)
	}
	publisher, err := NewHTTPPublisher(HTTPPublisherConfig{
		Endpoint: server.URL + "/events", KeyID: "key-1",
		SigningKey: []byte(strings.Repeat("k", sha256.Size)), Client: client,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer publisher.Close()
	if err := publisher.Publish(context.Background(), validHTTPTestEvent()); err != nil {
		t.Fatalf("Publish() with configured root CA error = %v", err)
	}
}

func validHTTPTestEvent() Event {
	return Event{
		ID: 1, OperatorID: "operator-a", AggregateType: "round", AggregateID: "round-1",
		EventType: "ROUND_COMMITTED", Payload: json.RawMessage(`{"roundId":"round-1"}`),
		CreatedAt: time.Now().UTC(), Attempts: 1,
	}
}
