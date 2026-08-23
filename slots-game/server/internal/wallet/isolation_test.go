package wallet

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"slots-game/server/internal/platform"
	"slots-game/server/internal/rgs"
)

type isolationStub struct {
	applyStarted  chan struct{}
	applyRelease  chan struct{}
	lookupStarted chan struct{}
	lookupRelease chan struct{}
	applyErr      error
	lookupErr     error
	resolveResult *rgs.Resolution

	mu          sync.Mutex
	applyCalls  int
	lookupCalls int
}

func (stub *isolationStub) ApplyRound(context.Context, rgs.WalletRound) (rgs.WalletReceipt, error) {
	stub.mu.Lock()
	stub.applyCalls++
	stub.mu.Unlock()
	if stub.applyStarted != nil {
		stub.applyStarted <- struct{}{}
	}
	if stub.applyRelease != nil {
		<-stub.applyRelease
	}
	return rgs.WalletReceipt{}, stub.applyErr
}

func (stub *isolationStub) Lookup(context.Context, string, string) (rgs.WalletReceipt, bool, error) {
	stub.mu.Lock()
	stub.lookupCalls++
	stub.mu.Unlock()
	if stub.lookupStarted != nil {
		stub.lookupStarted <- struct{}{}
	}
	if stub.lookupRelease != nil {
		<-stub.lookupRelease
	}
	return rgs.WalletReceipt{}, false, stub.lookupErr
}

func (stub *isolationStub) Rollback(context.Context, rgs.WalletRollback) (rgs.WalletReceipt, error) {
	return rgs.WalletReceipt{}, nil
}

func (stub *isolationStub) ProfileFor(string) (rgs.Profile, error) {
	return rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget("https://wallet.test.invalid/ledger")), nil
}

func (stub *isolationStub) SubmitRound(ctx context.Context, command rgs.WalletRound) rgs.Resolution {
	receipt, err := stub.ApplyRound(ctx, command)
	if err != nil {
		return rgs.Resolution{Status: rgs.ResolutionUnknown, Cause: err}
	}
	return rgs.Resolution{Status: rgs.ResolutionSucceeded, Receipt: receipt}
}

func (stub *isolationStub) Resolve(ctx context.Context, reference rgs.OperationRef) rgs.Resolution {
	if stub.resolveResult != nil {
		return *stub.resolveResult
	}
	receipt, found, err := stub.Lookup(ctx, reference.OperatorID, reference.OperationID)
	if err != nil {
		return rgs.Resolution{Status: rgs.ResolutionUnknown, Cause: err}
	}
	if !found {
		return rgs.Resolution{Status: rgs.ResolutionNotFound}
	}
	return rgs.Resolution{Status: rgs.ResolutionSucceeded, Receipt: receipt}
}

func TestIsolationEnforcesOperatorLookupCapacityWithoutBlockingPeer(t *testing.T) {
	config := testIsolationConfig()
	config.BackendLookupMaxInFlight = 2
	registry, err := NewIsolationRegistry(config, nil)
	if err != nil {
		t.Fatal(err)
	}
	blocking := &isolationStub{lookupStarted: make(chan struct{}, 1), lookupRelease: make(chan struct{})}
	operatorA := mustWrapIsolation(t, registry, "https://wallet.example/a", "operator-a", blocking)
	operatorBStub := &isolationStub{}
	operatorB := mustWrapIsolation(t, registry, "https://wallet.example/a", "operator-b", operatorBStub)

	done := make(chan error, 1)
	go func() {
		_, _, err := operatorA.Lookup(context.Background(), "operator-a", "operation-a")
		done <- err
	}()
	<-blocking.lookupStarted
	if _, _, err := operatorA.Lookup(context.Background(), "operator-a", "operation-b"); !errors.Is(err, ErrIsolationRejected) {
		t.Fatalf("operator lookup saturation error = %v", err)
	}
	if _, _, err := operatorB.Lookup(context.Background(), "operator-b", "operation-c"); err != nil {
		t.Fatalf("peer lookup was blocked by noisy operator: %v", err)
	}
	close(blocking.lookupRelease)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestIsolationInvalidReceiptOpensOnlyOperatorCircuit(t *testing.T) {
	registry, err := NewIsolationRegistry(testIsolationConfig(), nil)
	if err != nil {
		t.Fatal(err)
	}
	invalid := rgs.Resolution{
		Status: rgs.ResolutionConflict,
		Cause:  rgs.ErrWalletReceiptInvalid,
	}
	operatorA := mustWrapIsolation(
		t, registry, "https://wallet.example/a", "operator-a",
		&isolationStub{resolveResult: &invalid},
	).(rgs.WalletResolutionPort)
	operatorB := mustWrapIsolation(
		t, registry, "https://wallet.example/a", "operator-b", &isolationStub{},
	).(rgs.WalletResolutionPort)

	if result := operatorA.Resolve(context.Background(), rgs.OperationRef{}); result.Status != rgs.ResolutionConflict {
		t.Fatalf("first invalid resolution = %+v", result)
	}
	if result := operatorA.Resolve(context.Background(), rgs.OperationRef{}); result.Status != rgs.ResolutionNotSent || !errors.Is(result.Cause, ErrIsolationRejected) {
		t.Fatalf("operator circuit did not open: %+v", result)
	}
	if result := operatorB.Resolve(context.Background(), rgs.OperationRef{}); result.Status != rgs.ResolutionNotFound {
		t.Fatalf("peer operator was blocked by invalid receipt: %+v", result)
	}
}

func TestIsolationResponseAuthenticationFailureOpensOnlyOperatorCircuit(t *testing.T) {
	recorder := &isolationRecorder{}
	registry, err := NewIsolationRegistry(testIsolationConfig(), recorder)
	if err != nil {
		t.Fatal(err)
	}
	invalid := rgs.Resolution{
		Status: rgs.ResolutionUnknown,
		Cause:  errors.Join(errWalletResponseAuthentication, errors.New("key mismatch")),
	}
	operatorA := mustWrapIsolation(
		t, registry, "https://wallet.example/a", "operator-a",
		&isolationStub{resolveResult: &invalid},
	).(rgs.WalletResolutionPort)
	operatorB := mustWrapIsolation(
		t, registry, "https://wallet.example/a", "operator-b", &isolationStub{},
	).(rgs.WalletResolutionPort)

	if result := operatorA.Resolve(context.Background(), rgs.OperationRef{}); result.Status != rgs.ResolutionUnknown {
		t.Fatalf("first authentication failure = %+v", result)
	}
	if result := operatorA.Resolve(context.Background(), rgs.OperationRef{}); result.Status != rgs.ResolutionNotSent || !errors.Is(result.Cause, ErrIsolationRejected) {
		t.Fatalf("operator circuit did not open: %+v", result)
	}
	if result := operatorB.Resolve(context.Background(), rgs.OperationRef{}); result.Status != rgs.ResolutionNotFound {
		t.Fatalf("peer operator was blocked by response authentication failure: %+v", result)
	}
	assertBoundedIsolationObservations(t, recorder.snapshot())
}

func TestIsolationLegacyLookupClassifiesMissingOperationAsNotFound(t *testing.T) {
	recorder := &isolationRecorder{}
	registry, err := NewIsolationRegistry(testIsolationConfig(), recorder)
	if err != nil {
		t.Fatal(err)
	}
	port := mustWrapIsolation(
		t, registry, "https://wallet.example/a", "operator-a", &isolationStub{},
	)
	if _, found, err := port.Lookup(context.Background(), "operator-a", "operation-a"); err != nil || found {
		t.Fatalf("legacy lookup = found:%t error:%v", found, err)
	}
	foundObservation := false
	for _, observation := range recorder.snapshot() {
		if observation.method == "lookup" && observation.outcome == "not_found" {
			foundObservation = true
		}
	}
	if !foundObservation {
		t.Fatalf("missing lookup was not observed as not_found: %+v", recorder.snapshot())
	}
}

func TestIsolationAndPlatformShareEveryFixedTelemetryEnum(t *testing.T) {
	metrics := &platform.Metrics{}
	registry, err := NewIsolationRegistry(testIsolationConfig(), metrics)
	if err != nil {
		t.Fatal(err)
	}
	invalid := rgs.Resolution{
		Status: rgs.ResolutionUnknown,
		Cause:  errors.Join(errWalletResponseAuthentication, errors.New("key mismatch")),
	}
	port := mustWrapIsolation(
		t, registry, "https://wallet.example/a", "operator-a",
		&isolationStub{resolveResult: &invalid},
	).(rgs.WalletResolutionPort)
	if result := port.Resolve(context.Background(), rgs.OperationRef{}); result.Status != rgs.ResolutionUnknown {
		t.Fatalf("authentication failure = %+v", result)
	}

	var output bytes.Buffer
	if err := metrics.WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		`rgs_wallet_request_duration_seconds_count{method="lookup",outcome="response_auth_invalid"} 1`,
		`rgs_wallet_breakers{method="operator_lookup",state="open"} 1`,
	} {
		if !strings.Contains(output.String(), expected) {
			t.Fatalf("cross-package telemetry contract dropped %q:\n%s", expected, output.String())
		}
	}
}

func TestCanonicalBackendKeyNormalizesDefaultPorts(t *testing.T) {
	for _, pair := range [][2]string{
		{"https://wallet.example/path-a", "https://wallet.example:443/path-b"},
		{"http://wallet.example/path-a", "http://wallet.example:080/path-b"},
	} {
		first, firstErr := canonicalBackendKey(pair[0])
		second, secondErr := canonicalBackendKey(pair[1])
		if firstErr != nil || secondErr != nil || first != second {
			t.Fatalf("canonical origins = %q/%q errors:%v/%v", first, second, firstErr, secondErr)
		}
	}
	nonDefault, err := canonicalBackendKey("https://wallet.example:8443/path")
	if err != nil || nonDefault != "https://wallet.example:8443" {
		t.Fatalf("non-default origin = %q error:%v", nonDefault, err)
	}
}

func TestCanonicalLedgerTargetNormalizesOriginButPreservesNamespacePath(t *testing.T) {
	first, err := canonicalLedgerTarget("https://WALLET.example:443/ledger-a/")
	if err != nil {
		t.Fatal(err)
	}
	second, err := canonicalLedgerTarget("https://wallet.example/ledger-a")
	if err != nil {
		t.Fatal(err)
	}
	other, err := canonicalLedgerTarget("https://wallet.example/ledger-b")
	if err != nil {
		t.Fatal(err)
	}
	if first != second || first == other {
		t.Fatalf("ledger targets = first:%q second:%q other:%q", first, second, other)
	}
}

func (stub *isolationStub) calls() (int, int) {
	stub.mu.Lock()
	defer stub.mu.Unlock()
	return stub.applyCalls, stub.lookupCalls
}

type isolationObservation struct {
	method   string
	outcome  string
	reason   string
	previous string
	current  string
}

type isolationRecorder struct {
	mu           sync.Mutex
	observations []isolationObservation
}

type panicIsolationObserver struct{}

func (panicIsolationObserver) ObserveWalletRequest(string, string, time.Duration) {
	panic("metric observer")
}
func (panicIsolationObserver) WalletInFlight(string, int64)           { panic("metric observer") }
func (panicIsolationObserver) WalletIsolationRejected(string, string) { panic("metric observer") }
func (panicIsolationObserver) WalletBreakerStateChanged(string, string, string) {
	panic("metric observer")
}

func (recorder *isolationRecorder) ObserveWalletRequest(method, outcome string, _ time.Duration) {
	recorder.append(isolationObservation{method: method, outcome: outcome})
}

func (recorder *isolationRecorder) WalletInFlight(method string, _ int64) {
	recorder.append(isolationObservation{method: method})
}

func (recorder *isolationRecorder) WalletIsolationRejected(method, reason string) {
	recorder.append(isolationObservation{method: method, reason: reason})
}

func (recorder *isolationRecorder) WalletBreakerStateChanged(method, previous, current string) {
	recorder.append(isolationObservation{method: method, previous: previous, current: current})
}

func (recorder *isolationRecorder) append(observation isolationObservation) {
	recorder.mu.Lock()
	recorder.observations = append(recorder.observations, observation)
	recorder.mu.Unlock()
}

func (recorder *isolationRecorder) snapshot() []isolationObservation {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return append([]isolationObservation(nil), recorder.observations...)
}

func testIsolationConfig() IsolationConfig {
	return IsolationConfig{
		BackendApplyMaxInFlight: 2, BackendLookupMaxInFlight: 1,
		OperatorApplyMaxInFlight: 1, OperatorLookupMaxInFlight: 1, FailureThreshold: 1,
		SuccessThreshold: 1, OpenDuration: time.Minute, HalfOpenMaxInFlight: 1,
	}
}

func TestIsolationSharesBackendApplyCapacityAcrossOperators(t *testing.T) {
	config := testIsolationConfig()
	config.BackendApplyMaxInFlight = 1
	registry, err := NewIsolationRegistry(config, nil)
	if err != nil {
		t.Fatal(err)
	}
	blocking := &isolationStub{applyStarted: make(chan struct{}, 1), applyRelease: make(chan struct{})}
	first := mustWrapIsolation(t, registry, "https://wallet.example/a", "operator-a", blocking)
	secondStub := &isolationStub{}
	second := mustWrapIsolation(t, registry, "https://wallet.example/b", "operator-b", secondStub)

	done := make(chan error, 1)
	go func() {
		_, err := first.ApplyRound(context.Background(), rgs.WalletRound{})
		done <- err
	}()
	<-blocking.applyStarted
	started := time.Now()
	_, err = second.ApplyRound(context.Background(), rgs.WalletRound{})
	if !errors.Is(err, ErrIsolationRejected) {
		t.Fatalf("shared backend rejection = %v, want ErrIsolationRejected", err)
	}
	if time.Since(started) > 100*time.Millisecond {
		t.Fatal("shared backend rejection blocked instead of failing immediately")
	}
	if calls, _ := secondStub.calls(); calls != 0 {
		t.Fatalf("rejected backend was called %d times", calls)
	}
	close(blocking.applyRelease)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestIsolationEnforcesOperatorApplyCapacityWithoutBlockingPeer(t *testing.T) {
	registry, err := NewIsolationRegistry(testIsolationConfig(), nil)
	if err != nil {
		t.Fatal(err)
	}
	blocking := &isolationStub{applyStarted: make(chan struct{}, 1), applyRelease: make(chan struct{})}
	operatorA := mustWrapIsolation(t, registry, "https://wallet.example/a", "operator-a", blocking)
	operatorBStub := &isolationStub{}
	operatorB := mustWrapIsolation(t, registry, "https://wallet.example/a", "operator-b", operatorBStub)

	done := make(chan error, 1)
	go func() {
		_, err := operatorA.ApplyRound(context.Background(), rgs.WalletRound{})
		done <- err
	}()
	<-blocking.applyStarted
	if _, err := operatorA.ApplyRound(context.Background(), rgs.WalletRound{}); !errors.Is(err, ErrIsolationRejected) {
		t.Fatalf("operator saturation error = %v, want ErrIsolationRejected", err)
	}
	if _, err := operatorB.ApplyRound(context.Background(), rgs.WalletRound{}); err != nil {
		t.Fatalf("peer operator was blocked by another operator: %v", err)
	}
	if calls, _ := operatorBStub.calls(); calls != 1 {
		t.Fatalf("peer operator calls = %d, want 1", calls)
	}
	close(blocking.applyRelease)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestIsolationReservesLookupCapacityWhenApplyIsSaturated(t *testing.T) {
	config := testIsolationConfig()
	config.BackendApplyMaxInFlight = 1
	stub := &isolationStub{applyStarted: make(chan struct{}, 1), applyRelease: make(chan struct{})}
	registry, err := NewIsolationRegistry(config, nil)
	if err != nil {
		t.Fatal(err)
	}
	port := mustWrapIsolation(t, registry, "https://wallet.example", "operator-a", stub)
	done := make(chan error, 1)
	go func() {
		_, err := port.ApplyRound(context.Background(), rgs.WalletRound{})
		done <- err
	}()
	<-stub.applyStarted
	if _, _, err := port.Lookup(context.Background(), "operator-a", "operation-a"); err != nil {
		t.Fatalf("lookup was blocked by saturated apply lane: %v", err)
	}
	close(stub.applyRelease)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestIsolationApplyBreakerDoesNotBlockLookup(t *testing.T) {
	stub := &isolationStub{applyErr: errors.New("wallet transport unavailable")}
	recorder := &isolationRecorder{}
	registry, err := NewIsolationRegistry(testIsolationConfig(), recorder)
	if err != nil {
		t.Fatal(err)
	}
	port := mustWrapIsolation(t, registry, "https://wallet.example", "operator-a", stub)
	if _, err := port.ApplyRound(context.Background(), rgs.WalletRound{}); err == nil {
		t.Fatal("transport failure unexpectedly succeeded")
	}
	if _, err := port.ApplyRound(context.Background(), rgs.WalletRound{}); !errors.Is(err, ErrIsolationRejected) {
		t.Fatalf("open apply circuit error = %v, want ErrIsolationRejected", err)
	}
	if _, _, err := port.Lookup(context.Background(), "operator-a", "operation-a"); err != nil {
		t.Fatalf("lookup was blocked by apply circuit: %v", err)
	}
	applyCalls, lookupCalls := stub.calls()
	if applyCalls != 1 || lookupCalls != 1 {
		t.Fatalf("downstream calls = apply:%d lookup:%d, want 1/1", applyCalls, lookupCalls)
	}
	assertBoundedIsolationObservations(t, recorder.snapshot())
}

func TestIsolationApplyAvailabilityDoesNotConsumeCapacity(t *testing.T) {
	registry, err := NewIsolationRegistry(testIsolationConfig(), nil)
	if err != nil {
		t.Fatal(err)
	}
	stub := &isolationStub{}
	port := mustWrapIsolation(t, registry, "https://wallet.example", "operator-a", stub)
	for iteration := 0; iteration < 100; iteration++ {
		if !registry.ApplyAvailable("operator-a") {
			t.Fatalf("read-only availability check failed at iteration %d", iteration)
		}
	}
	if registry.ApplyAvailable("unknown") {
		t.Fatal("unknown operator passed apply availability")
	}
	if _, err := port.ApplyRound(context.Background(), rgs.WalletRound{}); err != nil {
		t.Fatalf("availability checks consumed a permit: %v", err)
	}
}

func TestIsolationResolutionRejectsAsProvenNotSent(t *testing.T) {
	config := testIsolationConfig()
	config.BackendApplyMaxInFlight = 1
	registry, err := NewIsolationRegistry(config, nil)
	if err != nil {
		t.Fatal(err)
	}
	stub := &isolationStub{applyStarted: make(chan struct{}, 1), applyRelease: make(chan struct{})}
	port := mustWrapIsolation(t, registry, "https://wallet.example", "operator-a", stub)
	resolutionPort := port.(rgs.WalletResolutionPort)
	done := make(chan rgs.Resolution, 1)
	go func() {
		done <- resolutionPort.SubmitRound(context.Background(), rgs.WalletRound{})
	}()
	<-stub.applyStarted
	result := resolutionPort.SubmitRound(context.Background(), rgs.WalletRound{})
	if result.Status != rgs.ResolutionNotSent || !errors.Is(result.Cause, rgs.ErrWalletUnavailable) ||
		!errors.Is(result.Cause, ErrIsolationRejected) {
		t.Fatalf("isolation resolution = %+v, want NOT_SENT wallet unavailable", result)
	}
	close(stub.applyRelease)
	if result := <-done; result.Status != rgs.ResolutionSucceeded {
		t.Fatalf("admitted resolution = %+v, want SUCCEEDED", result)
	}
}

func TestIsolationObserverPanicCannotSuppressWalletCall(t *testing.T) {
	registry, err := NewIsolationRegistry(testIsolationConfig(), panicIsolationObserver{})
	if err != nil {
		t.Fatal(err)
	}
	stub := &isolationStub{}
	port := mustWrapIsolation(t, registry, "https://wallet.example", "operator-a", stub)
	if _, err := port.ApplyRound(context.Background(), rgs.WalletRound{}); err != nil {
		t.Fatalf("observer panic suppressed wallet call: %v", err)
	}
	if calls, _ := stub.calls(); calls != 1 {
		t.Fatalf("downstream calls = %d, want 1", calls)
	}
}

func mustWrapIsolation(
	t *testing.T,
	registry *IsolationRegistry,
	backendURL, operatorID string,
	next rgs.WalletPort,
) rgs.WalletPort {
	t.Helper()
	port, err := registry.Wrap(backendURL, operatorID, next)
	if err != nil {
		t.Fatal(err)
	}
	return port
}

func assertBoundedIsolationObservations(t *testing.T, observations []isolationObservation) {
	t.Helper()
	allowedMethods := map[string]bool{"": true, "apply": true, "lookup": true, "rollback": true, "operator_apply": true, "operator_lookup": true}
	allowedOutcomes := map[string]bool{"": true, "success": true, "pending": true, "rejected": true, "not_found": true, "not_sent": true, "conflict": true, "invalid": true, "response_auth_invalid": true, "unknown": true, "isolated": true}
	allowedReasons := map[string]bool{"": true, "backend_bulkhead": true, "operator_bulkhead": true, "circuit": true}
	allowedStates := map[string]bool{"": true, "closed": true, "open": true, "half_open": true}
	for _, observation := range observations {
		if !allowedMethods[observation.method] || !allowedOutcomes[observation.outcome] ||
			!allowedReasons[observation.reason] || !allowedStates[observation.previous] ||
			!allowedStates[observation.current] {
			t.Fatalf("unbounded observation: %+v", observation)
		}
	}
}
