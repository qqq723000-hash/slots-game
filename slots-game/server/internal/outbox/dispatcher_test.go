package outbox

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDispatcherFailureLogUsesFixedClassWithoutStoreErrorText(t *testing.T) {
	t.Parallel()
	const secret = "event-123 operator-a postgres://user:password@database"
	var output bytes.Buffer
	dispatcher, err := NewDispatcher(DispatcherConfig{
		Owner: "worker-a", Interval: time.Second, LeaseDuration: 3 * time.Second,
		PublishTimeout: time.Second, BatchSize: 1, MaxParallel: 1,
		InitialBackoff: time.Second, MaximumBackoff: time.Minute,
	}, &recordingStore{claimErr: errors.New(secret)}, PublisherFunc(func(context.Context, Event) error {
		return nil
	}), slog.New(slog.NewJSONHandler(&output, nil)))
	if err != nil {
		t.Fatal(err)
	}
	dispatcher.runAndObserve(context.Background())
	logOutput := output.String()
	if strings.Contains(logOutput, secret) || strings.Contains(logOutput, "password") ||
		!strings.Contains(logOutput, `"error_class":"internal"`) {
		t.Fatalf("unsafe dispatcher log: %s", logOutput)
	}
}

func TestDispatcherPublishesAndSchedulesExponentialRetry(t *testing.T) {
	store := &recordingStore{events: []Event{
		{ID: 1, Attempts: 1},
		{ID: 2, Attempts: 3},
		{ID: 3, Attempts: 2},
	}}
	publisher := PublisherFunc(func(_ context.Context, event Event) error {
		switch event.ID {
		case 2:
			return errors.New("temporary downstream failure")
		case 3:
			panic("publisher bug")
		default:
			return nil
		}
	})
	dispatcher := newTestDispatcher(t, store, publisher, 2)

	result, err := dispatcher.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce() error = %v", err)
	}
	if result != (BatchResult{Claimed: 3, Published: 1, Failed: 2}) {
		t.Fatalf("RunOnce() result = %+v", result)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.claims) != 1 || store.claims[0].LeaseToken == "" {
		t.Fatalf("claim requests = %+v", store.claims)
	}
	if len(store.completions) != 1 || store.completions[0].EventID != 1 ||
		store.completions[0].LeaseToken != store.claims[0].LeaseToken {
		t.Fatalf("completions = %+v", store.completions)
	}
	if len(store.failures) != 2 {
		t.Fatalf("failures = %+v", store.failures)
	}
	wantDelays := map[int64]time.Duration{2: 40 * time.Millisecond, 3: 20 * time.Millisecond}
	for _, failure := range store.failures {
		if failure.Code != publishFailureCode || failure.LeaseToken != store.claims[0].LeaseToken ||
			failure.RetryAfter != wantDelays[failure.EventID] {
			t.Fatalf("failure = %+v", failure)
		}
	}
}

func TestDispatcherObserverReceivesOneDurableBatchSummary(t *testing.T) {
	store := &recordingStore{events: []Event{{ID: 1, Attempts: 1}, {ID: 2, Attempts: 1}}}
	observer := &recordingObserver{}
	dispatcher, err := NewDispatcher(DispatcherConfig{
		Owner: "worker-observed", Interval: 10 * time.Millisecond,
		LeaseDuration: 2 * time.Second, PublishTimeout: 100 * time.Millisecond,
		BatchSize: 2, MaxParallel: 2, InitialBackoff: 10 * time.Millisecond,
		MaximumBackoff: time.Second, Observer: observer,
	}, store, PublisherFunc(func(_ context.Context, event Event) error {
		if event.ID == 2 {
			return errors.New("downstream unavailable")
		}
		return nil
	}), nil)
	if err != nil {
		t.Fatal(err)
	}

	result, err := dispatcher.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce() error = %v", err)
	}
	if result != (BatchResult{Claimed: 2, Published: 1, Failed: 1}) {
		t.Fatalf("RunOnce() result = %+v", result)
	}
	observer.mu.Lock()
	defer observer.mu.Unlock()
	if len(observer.results) != 1 || observer.results[0] != result {
		t.Fatalf("observer results = %+v, want one %+v", observer.results, result)
	}
}

func TestDispatcherBoundsPublisherConcurrency(t *testing.T) {
	events := make([]Event, 12)
	for index := range events {
		events[index] = Event{ID: int64(index + 1), Attempts: 1}
	}
	store := &recordingStore{events: events}
	var active atomic.Int64
	var maximum atomic.Int64
	publisher := PublisherFunc(func(context.Context, Event) error {
		current := active.Add(1)
		for {
			previous := maximum.Load()
			if current <= previous || maximum.CompareAndSwap(previous, current) {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
		active.Add(-1)
		return nil
	})
	dispatcher := newTestDispatcher(t, store, publisher, 3)

	result, err := dispatcher.RunOnce(context.Background())
	if err != nil || result.Published != len(events) {
		t.Fatalf("RunOnce() = (%+v, %v)", result, err)
	}
	if got := maximum.Load(); got < 2 || got > 3 {
		t.Fatalf("maximum concurrency = %d, want [2,3]", got)
	}
}

func TestDispatcherHardTimeoutWhenPublisherIgnoresContext(t *testing.T) {
	store := &recordingStore{events: []Event{{ID: 41, Attempts: 1}}}
	release := make(chan struct{})
	returned := make(chan struct{}, 1)
	var releaseOnce sync.Once
	releasePublisher := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(releasePublisher)

	dispatcher := newTimeoutTestDispatcher(t, store, PublisherFunc(func(context.Context, Event) error {
		<-release
		returned <- struct{}{}
		return nil
	}), 1, 1, 20*time.Millisecond)

	startedAt := time.Now()
	result, err := dispatcher.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce() error = %v", err)
	}
	if result != (BatchResult{Claimed: 1, Failed: 1}) {
		t.Fatalf("RunOnce() result = %+v", result)
	}
	if elapsed := time.Since(startedAt); elapsed > 500*time.Millisecond {
		t.Fatalf("RunOnce() took %s after its hard publish timeout", elapsed)
	}

	releasePublisher()
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("non-cooperative Publisher did not return after release")
	}
}

func TestDispatcherCancellationReturnsWhenPublisherIgnoresContext(t *testing.T) {
	store := &recordingStore{events: []Event{{ID: 42, Attempts: 1}}}
	started := make(chan struct{})
	release := make(chan struct{})
	returned := make(chan struct{}, 1)
	var releaseOnce sync.Once
	releasePublisher := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(releasePublisher)

	dispatcher := newTimeoutTestDispatcher(t, store, PublisherFunc(func(context.Context, Event) error {
		close(started)
		<-release
		returned <- struct{}{}
		return nil
	}), 1, 1, time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan struct {
		batch BatchResult
		err   error
	}, 1)
	go func() {
		batch, err := dispatcher.RunOnce(ctx)
		result <- struct {
			batch BatchResult
			err   error
		}{batch: batch, err: err}
	}()

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("Publisher was not called")
	}
	cancel()
	select {
	case outcome := <-result:
		if !errors.Is(outcome.err, context.Canceled) {
			t.Fatalf("RunOnce() error = %v, want context.Canceled", outcome.err)
		}
		if outcome.batch.Claimed != 1 {
			t.Fatalf("RunOnce() result = %+v", outcome.batch)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("RunOnce() did not return after cancellation")
	}

	releasePublisher()
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("non-cooperative Publisher did not return after release")
	}
}

func TestDispatcherBoundsNonCooperativePublisherGoroutines(t *testing.T) {
	events := make([]Event, 6)
	for index := range events {
		events[index] = Event{ID: int64(index + 1), Attempts: 1}
	}
	store := &recordingStore{events: events}
	release := make(chan struct{})
	returned := make(chan struct{}, len(events))
	var calls atomic.Int64
	var releaseOnce sync.Once
	releasePublisher := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(releasePublisher)

	dispatcher := newTimeoutTestDispatcher(t, store, PublisherFunc(func(context.Context, Event) error {
		calls.Add(1)
		<-release
		returned <- struct{}{}
		return nil
	}), len(events), 2, 20*time.Millisecond)

	result, err := dispatcher.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce() error = %v", err)
	}
	if result != (BatchResult{Claimed: len(events), Failed: len(events)}) {
		t.Fatalf("RunOnce() result = %+v", result)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("Publisher calls = %d, want MaxParallel 2", got)
	}

	releasePublisher()
	for range 2 {
		select {
		case <-returned:
		case <-time.After(time.Second):
			t.Fatal("non-cooperative Publisher did not return after release")
		}
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("late Publisher calls = %d, want 2", got)
	}
}

func TestDispatcherDoesNotStartPublisherAfterCancellation(t *testing.T) {
	var calls atomic.Int64
	dispatcher := newTimeoutTestDispatcher(t, &recordingStore{}, PublisherFunc(func(context.Context, Event) error {
		calls.Add(1)
		return nil
	}), 1, 1, time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := dispatcher.publishWithHardDeadline(ctx, Event{ID: 43})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("publishWithHardDeadline() error = %v, want context.Canceled", err)
	}
	if got := calls.Load(); got != 0 {
		t.Fatalf("Publisher calls = %d, want 0", got)
	}
}

func TestDispatcherReportsFencedStaleCompletion(t *testing.T) {
	store := &recordingStore{
		events:      []Event{{ID: 9, Attempts: 1}},
		completeErr: ErrLeaseLost,
	}
	dispatcher := newTestDispatcher(t, store, PublisherFunc(func(context.Context, Event) error {
		return nil
	}), 1)

	result, err := dispatcher.RunOnce(context.Background())
	if !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("RunOnce() error = %v, want ErrLeaseLost", err)
	}
	if result != (BatchResult{Claimed: 1, LeaseLost: 1}) {
		t.Fatalf("RunOnce() result = %+v", result)
	}
}

func TestDispatcherUsesFreshLeaseTokenPerBatch(t *testing.T) {
	store := &recordingStore{}
	dispatcher := newTestDispatcher(t, store, PublisherFunc(func(context.Context, Event) error {
		return nil
	}), 1)
	if _, err := dispatcher.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := dispatcher.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.claims) != 2 || store.claims[0].LeaseToken == store.claims[1].LeaseToken {
		t.Fatalf("lease tokens = %q, %q", store.claims[0].LeaseToken, store.claims[1].LeaseToken)
	}
}

func TestRetryDelayCapsWithoutOverflow(t *testing.T) {
	for _, test := range []struct {
		attempt int
		want    time.Duration
	}{
		{0, time.Second},
		{1, time.Second},
		{2, 2 * time.Second},
		{4, 8 * time.Second},
		{1000, 10 * time.Second},
	} {
		if got := RetryDelay(test.attempt, time.Second, 10*time.Second); got != test.want {
			t.Fatalf("RetryDelay(%d) = %s, want %s", test.attempt, got, test.want)
		}
	}
	if got := RetryDelay(1, 0, time.Second); got != 0 {
		t.Fatalf("invalid RetryDelay = %s", got)
	}
}

func TestNewDispatcherRejectsUnsafeLeaseWindow(t *testing.T) {
	_, err := NewDispatcher(DispatcherConfig{
		Owner: "worker-a", LeaseDuration: time.Second, PublishTimeout: time.Second,
	}, &recordingStore{}, PublisherFunc(func(context.Context, Event) error { return nil }), nil)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("NewDispatcher() error = %v", err)
	}
}

func newTestDispatcher(t *testing.T, store Store, publisher Publisher, parallel int) *Dispatcher {
	t.Helper()
	dispatcher, err := NewDispatcher(DispatcherConfig{
		Owner: "worker-a", Interval: 10 * time.Millisecond,
		LeaseDuration: 2 * time.Second, PublishTimeout: 100 * time.Millisecond,
		BatchSize: 12, MaxParallel: parallel,
		InitialBackoff: 10 * time.Millisecond, MaximumBackoff: time.Second,
	}, store, publisher, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("NewDispatcher() error = %v", err)
	}
	return dispatcher
}

func newTimeoutTestDispatcher(
	t *testing.T,
	store Store,
	publisher Publisher,
	batchSize, parallel int,
	publishTimeout time.Duration,
) *Dispatcher {
	t.Helper()
	dispatcher, err := NewDispatcher(DispatcherConfig{
		Owner: "worker-a", Interval: 10 * time.Millisecond,
		LeaseDuration: 2 * time.Second, PublishTimeout: publishTimeout,
		BatchSize: batchSize, MaxParallel: parallel,
		InitialBackoff: 10 * time.Millisecond, MaximumBackoff: time.Second,
	}, store, publisher, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("NewDispatcher() error = %v", err)
	}
	return dispatcher
}

type PublisherFunc func(context.Context, Event) error

func (function PublisherFunc) Publish(ctx context.Context, event Event) error {
	return function(ctx, event)
}

type recordingStore struct {
	mu          sync.Mutex
	events      []Event
	claims      []ClaimRequest
	completions []Completion
	failures    []Failure
	claimErr    error
	completeErr error
	failureErr  error
}

type recordingObserver struct {
	mu      sync.Mutex
	results []BatchResult
}

func (observer *recordingObserver) ObserveOutboxDispatch(result BatchResult) {
	observer.mu.Lock()
	defer observer.mu.Unlock()
	observer.results = append(observer.results, result)
}

func (store *recordingStore) Claim(ctx context.Context, request ClaimRequest) ([]Event, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	store.claims = append(store.claims, request)
	return append([]Event(nil), store.events...), store.claimErr
}

func (store *recordingStore) MarkPublished(ctx context.Context, completion Completion) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	store.completions = append(store.completions, completion)
	return store.completeErr
}

func (store *recordingStore) MarkFailed(ctx context.Context, failure Failure) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	store.failures = append(store.failures, failure)
	return store.failureErr
}
