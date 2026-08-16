package main

import (
	"crypto/sha256"
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"slots-game/server/internal/platform"
)

func TestConfigureOutboxRuntimeIsDisabledWithoutEndpoint(t *testing.T) {
	runtime, err := configureOutboxRuntime(platform.Config{}, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.Enabled() {
		t.Fatal("empty outbox configuration unexpectedly enabled delivery")
	}
}

func TestConfigureOutboxRuntimeBuildsEnabledHTTPDelivery(t *testing.T) {
	database, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	sink := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer sink.Close()
	keyPath := filepath.Join(t.TempDir(), "outbox.key")
	encoded := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", sha256.Size)))
	if err := os.WriteFile(keyPath, []byte(encoded+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config := platform.Config{
		Environment:       platform.Development,
		OutboxEndpointURL: sink.URL + "/events", OutboxHMACKeyID: "audit-key-1",
		OutboxHMACKeyFile: keyPath, OutboxInterval: time.Second,
		OutboxLeaseDuration: 3 * time.Minute, OutboxPublishTimeout: time.Second,
		OutboxWorkerMaxStaleness: 4 * time.Minute, OutboxBacklogMaxAge: 5 * time.Minute,
		OutboxInitialBackoff: time.Second, OutboxMaximumBackoff: time.Minute,
		OutboxBatchSize: 10, OutboxMaxParallel: 2,
	}
	runtime, err := configureOutboxRuntime(
		config, database, slog.New(slog.NewTextHandler(io.Discard, nil)), &platform.Metrics{},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	if !runtime.Enabled() {
		t.Fatal("configured outbox delivery is disabled")
	}
}
