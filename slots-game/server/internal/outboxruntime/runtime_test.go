package outboxruntime

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"slots-game/server/internal/outbox"
)

func TestRuntimeDispatchesChecksReadinessAndStops(t *testing.T) {
	var requests atomic.Int64
	sink := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests.Add(1)
		_, _ = io.Copy(io.Discard, request.Body)
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer sink.Close()
	store := &runtimeStore{
		events: []outbox.Event{{
			ID: 1, OperatorID: "operator-a", AggregateType: "round", AggregateID: "round-a",
			EventType: "ROUND_COMMITTED", Payload: json.RawMessage(`{"roundId":"round-a"}`),
			CreatedAt: time.Now().UTC(), Attempts: 1,
		}},
		published: make(chan struct{}, 1),
	}
	var observations atomic.Int64
	config := runtimeTestConfig(t, sink.URL+"/events")
	config.Dispatcher.Observer = observerFunc(func(outbox.BatchResult) { observations.Add(1) })
	runtime, err := New(config, store, store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	ctx, cancel := context.WithCancel(context.Background())
	if err := runtime.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Start(ctx); !errors.Is(err, outbox.ErrInvalidInput) {
		t.Fatalf("second Start() error = %v", err)
	}
	select {
	case <-store.published:
	case <-time.After(5 * time.Second):
		t.Fatal("event was not published")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if err := runtime.Check(context.Background()); err == nil {
			break
		} else if time.Now().After(deadline) {
			t.Fatalf("Check() did not become ready: %v", err)
		}
		time.Sleep(time.Millisecond)
	}
	if requests.Load() != 1 || observations.Load() < 1 {
		t.Fatalf("requests = %d observations = %d", requests.Load(), observations.Load())
	}
	store.setBacklogError(outbox.ErrDeliveryLag)
	if err := runtime.Check(context.Background()); !errors.Is(err, outbox.ErrDeliveryLag) {
		t.Fatalf("lagged Check() error = %v", err)
	}
	cancel()
	waitCtx, waitCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer waitCancel()
	if err := runtime.Wait(waitCtx); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Check(context.Background()); err == nil {
		t.Fatal("stopped runtime unexpectedly ready")
	}
}

func TestRuntimeFailureLogUsesFixedClassWithoutStoreErrorText(t *testing.T) {
	t.Parallel()
	const secret = "event-123 operator-a postgres://user:password@database"
	var output strings.Builder
	runtime := &Runtime{logger: slog.New(slog.NewJSONHandler(&output, nil))}
	runtime.observe(outbox.BatchResult{Claimed: 1}, errors.New(secret))
	logOutput := output.String()
	if strings.Contains(logOutput, secret) || strings.Contains(logOutput, "password") ||
		!strings.Contains(logOutput, `"error_class":"internal"`) {
		t.Fatalf("unsafe outbox runtime log: %s", logOutput)
	}
}

func TestDisabledRuntimeDoesNotSendAndIsNotAReadinessDependency(t *testing.T) {
	runtime, err := New(Config{}, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.Enabled() {
		t.Fatal("empty configuration unexpectedly enabled delivery")
	}
	if err := runtime.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Check(context.Background()); !errors.Is(err, outbox.ErrDisabled) {
		t.Fatalf("disabled Check() error = %v", err)
	}
	_, err = New(Config{HMACKeyID: "partial"}, nil, nil, nil)
	if !errors.Is(err, outbox.ErrInvalidInput) {
		t.Fatalf("partial config error = %v", err)
	}
}

func TestRuntimeReadinessFailsBeforeFirstCompletedPass(t *testing.T) {
	sink := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer sink.Close()
	store := &runtimeStore{claimBlock: make(chan struct{})}
	runtime, err := New(runtimeTestConfig(t, sink.URL+"/events"), store, store, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	ctx, cancel := context.WithCancel(context.Background())
	if err := runtime.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Check(context.Background()); err == nil {
		t.Fatal("runtime ready before first pass completed")
	}
	cancel()
	close(store.claimBlock)
	waitCtx, waitCancel := context.WithTimeout(context.Background(), time.Second)
	defer waitCancel()
	if err := runtime.Wait(waitCtx); err != nil {
		t.Fatal(err)
	}
}

func runtimeTestConfig(t *testing.T, endpoint string) Config {
	t.Helper()
	keyPath := filepath.Join(t.TempDir(), "outbox-hmac.key")
	encoded := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", sha256.Size)))
	if err := os.WriteFile(keyPath, []byte(encoded+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return Config{
		EndpointURL: endpoint, HMACKeyID: "audit-key-1", HMACKeyFile: keyPath,
		AllowInsecureHTTP: true, WorkerMaxStaleness: time.Second, BacklogMaxAge: time.Minute,
		Dispatcher: outbox.DispatcherConfig{
			Owner: "runtime-test", Interval: 10 * time.Millisecond,
			LeaseDuration: time.Second, PublishTimeout: 50 * time.Millisecond,
			BatchSize: 1, MaxParallel: 1,
			InitialBackoff: 10 * time.Millisecond, MaximumBackoff: time.Second,
		},
	}
}

type observerFunc func(outbox.BatchResult)

func (observe observerFunc) ObserveOutboxDispatch(result outbox.BatchResult) { observe(result) }

type runtimeStore struct {
	mu         sync.Mutex
	events     []outbox.Event
	backlogErr error
	published  chan struct{}
	claimBlock chan struct{}
}

func (store *runtimeStore) Claim(ctx context.Context, _ outbox.ClaimRequest) ([]outbox.Event, error) {
	if store.claimBlock != nil {
		select {
		case <-store.claimBlock:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	events := append([]outbox.Event(nil), store.events...)
	store.events = nil
	return events, nil
}

func (store *runtimeStore) MarkPublished(context.Context, outbox.Completion) error {
	if store.published != nil {
		select {
		case store.published <- struct{}{}:
		default:
		}
	}
	return nil
}

func (*runtimeStore) MarkFailed(context.Context, outbox.Failure) error { return nil }

func (store *runtimeStore) CheckBacklog(context.Context, time.Duration) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.backlogErr
}

func (store *runtimeStore) setBacklogError(err error) {
	store.mu.Lock()
	store.backlogErr = err
	store.mu.Unlock()
}
