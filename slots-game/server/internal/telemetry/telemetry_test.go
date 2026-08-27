package telemetry

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

const (
	testTraceID            = "11111111111111111111111111111111"
	testParentID           = "2222222222222222"
	validTraceParentHeader = "00-" + testTraceID + "-" + testParentID + "-01"
)

func TestPublicHTTPAcceptsCaseInsensitiveHeaderAndStripsExternalTraceState(t *testing.T) {
	runtime, recorder, provider := recordingRuntime(t, sdktrace.AlwaysSample())
	defer provider.Shutdown(context.Background())
	var forwarded http.Header
	handler := runtime.WrapPublicHTTP(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		forwarded = make(http.Header)
		Inject(request.Context(), forwarded)
		writer.WriteHeader(http.StatusNoContent)
	}), func(*http.Request) string { return "client.spin" })
	request := httptest.NewRequest(http.MethodPost, "https://rgs.example/rgs/v1/spin?player=private", nil)
	request.Header.Add("tRaCePaReNt", validTraceParentHeader)
	request.Header.Add("TrAcEsTaTe", "vendor=value")
	request.Header.Add("tracestate", "second=state")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("response status = %d", response.Code)
	}
	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("ended spans = %d, want 1", len(spans))
	}
	span := spans[0]
	if span.Parent().TraceID().String() != testTraceID || span.Parent().SpanID().String() != testParentID ||
		!span.Parent().IsRemote() {
		t.Fatalf("server parent = %v", span.Parent())
	}
	if span.Parent().TraceState().Len() != 0 || span.SpanContext().TraceState().Len() != 0 {
		t.Fatalf("untrusted tracestate survived public boundary: parent=%q span=%q",
			span.Parent().TraceState().String(), span.SpanContext().TraceState().String())
	}
	if forwarded.Get("traceparent") == "" || forwarded.Get("tracestate") != "" {
		t.Fatalf("forwarded trace headers = %#v", forwarded)
	}
	assertSafeHTTPAttributes(t, span.Attributes(), "POST", "client.spin", http.StatusNoContent)
	for _, forbidden := range []string{"private", "/rgs/v1/spin", "vendor=value", "second=state"} {
		if strings.Contains(span.Name()+attributesText(span.Attributes()), forbidden) {
			t.Fatalf("span exported forbidden request content %q", forbidden)
		}
	}
}

func TestInvalidTraceStateNeverInvalidatesValidTraceParentOrPropagates(t *testing.T) {
	for name, traceState := range map[string]string{
		"oversize":      strings.Repeat("a", maxTraceStateBytes+1),
		"crlf":          "vendor=value\r\nsecond=state",
		"duplicate key": "vendor=one,vendor=two",
		"invalid key":   "Bad Key=value",
		"invalid value": "vendor=\x01",
	} {
		t.Run(name, func(t *testing.T) {
			runtime, recorder, provider := recordingRuntime(t, sdktrace.AlwaysSample())
			defer provider.Shutdown(context.Background())
			var forwarded http.Header
			handler := runtime.WrapPublicHTTP(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				forwarded = make(http.Header)
				Inject(request.Context(), forwarded)
				writer.WriteHeader(http.StatusOK)
			}), func(*http.Request) string { return "client.round_status" })
			request := httptest.NewRequest(http.MethodGet, "https://rgs.example/status", nil)
			request.Header.Add("traceparent", validTraceParentHeader)
			request.Header.Add("tracestate", traceState)
			handler.ServeHTTP(httptest.NewRecorder(), request)

			spans := recorder.Ended()
			if len(spans) != 1 || spans[0].Parent().SpanID().String() != testParentID || !spans[0].Parent().IsRemote() {
				t.Fatalf("valid traceparent was not preserved: %#v", spans)
			}
			if spans[0].Parent().TraceState().Len() != 0 || forwarded.Get("tracestate") != "" {
				t.Fatalf("external tracestate escaped boundary: span=%q header=%q",
					spans[0].Parent().TraceState().String(), forwarded.Get("tracestate"))
			}
		})
	}
}

func TestDuplicateOrMalformedTraceParentStartsNewRootWithoutRejectingRequest(t *testing.T) {
	malformed := map[string][]string{
		"duplicate":      {validTraceParentHeader, validTraceParentHeader},
		"comma merged":   {validTraceParentHeader + "," + validTraceParentHeader},
		"uppercase id":   {"00-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-2222222222222222-01"},
		"zero trace":     {"00-00000000000000000000000000000000-2222222222222222-01"},
		"zero parent":    {"00-11111111111111111111111111111111-0000000000000000-01"},
		"reserved flags": {"00-11111111111111111111111111111111-2222222222222222-04"},
	}
	for name, values := range malformed {
		t.Run(name, func(t *testing.T) {
			runtime, recorder, provider := recordingRuntime(t, sdktrace.AlwaysSample())
			defer provider.Shutdown(context.Background())
			handler := runtime.WrapPublicHTTP(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.WriteHeader(http.StatusAccepted)
			}), func(*http.Request) string { return "client.spin" })
			request := httptest.NewRequest(http.MethodPost, "https://rgs.example/spin", nil)
			request.Header[http.CanonicalHeaderKey("traceparent")] = values
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusAccepted {
				t.Fatalf("malformed trace header altered response: %d", response.Code)
			}
			spans := recorder.Ended()
			if len(spans) != 1 || spans[0].Parent().IsValid() {
				t.Fatalf("malformed traceparent retained remote parent: %#v", spans)
			}
		})
	}
}

func TestLevelTwoRandomFlagIsAcceptedAndPreservedOutbound(t *testing.T) {
	for _, flags := range []string{"02", "03"} {
		t.Run(flags, func(t *testing.T) {
			runtime, recorder, provider := recordingRuntime(t, sdktrace.AlwaysSample())
			defer provider.Shutdown(context.Background())
			var forwarded http.Header
			handler := runtime.WrapPublicHTTP(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				forwarded = make(http.Header)
				Inject(request.Context(), forwarded)
				writer.WriteHeader(http.StatusNoContent)
			}), func(*http.Request) string { return "client.spin" })
			header := validTraceParentHeader[:len(validTraceParentHeader)-2] + flags
			request := httptest.NewRequest(http.MethodPost, "https://rgs.example/spin", nil)
			request.Header.Set("traceparent", header)
			handler.ServeHTTP(httptest.NewRecorder(), request)

			spans := recorder.Ended()
			if len(spans) != 1 || spans[0].Parent().TraceFlags() != trace.TraceFlags(flags[1]-'0') ||
				!spans[0].Parent().IsRemote() {
				t.Fatalf("Level 2 parent flags were not preserved: %#v", spans)
			}
			// AlwaysSample 可把 02 的 sampled 位提升为 1，但 random 位必须保留，
			// 因而两种输入的 child 出站 flags 都是 03。
			if !strings.HasSuffix(forwarded.Get("traceparent"), "-03") {
				t.Fatalf("outbound random flag was not preserved: %q", forwarded.Get("traceparent"))
			}
		})
	}
	for _, flags := range []string{"00", "01", "02", "03"} {
		if !validTraceParent(validTraceParentHeader[:len(validTraceParentHeader)-2] + flags) {
			t.Fatalf("valid Level 2 flags rejected: %s", flags)
		}
	}
	if validTraceParent(validTraceParentHeader[:len(validTraceParentHeader)-2] + "04") {
		t.Fatal("reserved Level 2 flags accepted")
	}
}

func TestRemoteSampledFlagCannotForceZeroRatioSampler(t *testing.T) {
	runtime, recorder, provider := recordingRuntime(t, publicSampler(0, [samplerKeyBytes]byte{}))
	defer provider.Shutdown(context.Background())
	handler := runtime.WrapPublicHTTP(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusOK)
	}), func(*http.Request) string { return "client.spin" })
	request := httptest.NewRequest(http.MethodPost, "https://rgs.example/spin", nil)
	request.Header.Set("traceparent", validTraceParentHeader)
	handler.ServeHTTP(httptest.NewRecorder(), request)
	if spans := recorder.Ended(); len(spans) != 0 {
		t.Fatalf("remote sampled flag forced collection at ratio zero: %#v", spans)
	}
}

func TestRemoteKeyedSamplerDefeatsChosenLowTailTraceIDs(t *testing.T) {
	const ratio = 0.1
	var key [samplerKeyBytes]byte
	for index := range key {
		key[index] = byte(index + 1)
	}
	keyed := keyedRatioSampler{ratio: ratio, key: key}
	ordinary := sdktrace.TraceIDRatioBased(ratio)
	var first trace.TraceID
	binary.BigEndian.PutUint64(first[:8], 0x1111111111111111)
	binary.BigEndian.PutUint64(first[8:], 1)
	parameters := sdktrace.SamplingParameters{TraceID: first}
	if ordinary.ShouldSample(parameters).Decision != sdktrace.RecordAndSample {
		t.Fatal("official low-tail ratio precondition did not reproduce")
	}
	firstDecision := keyed.ShouldSample(parameters).Decision
	for attempt := 0; attempt < 10; attempt++ {
		if keyed.ShouldSample(parameters).Decision != firstDecision {
			t.Fatal("keyed decision changed for the same key and trace ID")
		}
	}
	sampledAcrossProcessKeys := 0
	for seed := uint64(1); seed <= 256; seed++ {
		var processKey [samplerKeyBytes]byte
		binary.BigEndian.PutUint64(processKey[:8], seed)
		if (keyedRatioSampler{ratio: ratio, key: processKey}).ShouldSample(parameters).Decision == sdktrace.RecordAndSample {
			sampledAcrossProcessKeys++
		}
	}
	if sampledAcrossProcessKeys < 10 || sampledAcrossProcessKeys > 45 {
		t.Fatalf("chosen low-tail trace ID sampled for %d/256 deterministic process keys", sampledAcrossProcessKeys)
	}
	public := publicSampler(ratio, key)
	if public.ShouldSample(parameters).Decision != sdktrace.RecordAndSample {
		t.Fatal("local root no longer uses official TraceIDRatioBased decision")
	}
	parent := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: first,
		SpanID:  trace.SpanID{1},
		Remote:  true,
	})
	parameters.ParentContext = trace.ContextWithRemoteSpanContext(context.Background(), parent)
	if public.ShouldSample(parameters).Decision != firstDecision {
		t.Fatal("remote parent did not use keyed ratio decision")
	}
	localSampled := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    first,
		SpanID:     trace.SpanID{2},
		TraceFlags: trace.FlagsSampled,
	})
	parameters.ParentContext = trace.ContextWithSpanContext(context.Background(), localSampled)
	if publicSampler(0, key).ShouldSample(parameters).Decision != sdktrace.RecordAndSample {
		t.Fatal("sampled local child did not inherit parent decision")
	}
	parameters.ParentContext = trace.ContextWithSpanContext(context.Background(), localSampled.WithTraceFlags(0))
	if publicSampler(1, key).ShouldSample(parameters).Decision != sdktrace.Drop {
		t.Fatal("unsampled local child did not inherit parent decision")
	}

	sampled := 0
	for index := uint64(1); index <= 10_000; index++ {
		var traceID trace.TraceID
		binary.BigEndian.PutUint64(traceID[:8], index)
		// 官方 sampler 只看低 63 位，调用方固定为 1 就会全部命中；keyed
		// sampler 对完整 trace ID 做 HMAC，结果应接近配置比例。
		binary.BigEndian.PutUint64(traceID[8:], 1)
		if keyed.ShouldSample(sdktrace.SamplingParameters{TraceID: traceID}).Decision == sdktrace.RecordAndSample {
			sampled++
		}
	}
	if sampled < 850 || sampled > 1_150 {
		t.Fatalf("keyed sample count = %d, want deterministic 10%% band", sampled)
	}
	for _, boundary := range []struct {
		ratio    float64
		decision sdktrace.SamplingDecision
	}{{0, sdktrace.Drop}, {1, sdktrace.RecordAndSample}} {
		sampler := keyedRatioSampler{ratio: boundary.ratio, key: key}
		if sampler.ShouldSample(parameters).Decision != boundary.decision {
			t.Fatalf("ratio %v boundary decision mismatch", boundary.ratio)
		}
	}
}

func TestSamplerEntropyFailureDisablesOnlyTracingWithoutLeakingError(t *testing.T) {
	config := validEnabledConfig()
	runtime, err := newRuntime(context.Background(), config, failingEntropyReader{})
	if runtime != nil || err == nil || strings.Contains(err.Error(), "entropy-private") ||
		strings.Contains(err.Error(), config.Endpoint) {
		t.Fatalf("entropy failure result runtime=%#v err=%v", runtime, err)
	}
	if runtime, err := newRuntime(context.Background(), Config{}, failingEntropyReader{}); err != nil || runtime.Enabled() {
		t.Fatalf("disabled tracing consumed entropy: runtime=%#v err=%v", runtime, err)
	}
}

func TestDisabledRuntimeIsNoopAndDoesNotChangeHandler(t *testing.T) {
	runtime, err := New(context.Background(), Config{})
	if err != nil {
		t.Fatal(err)
	}
	if runtime.Enabled() {
		t.Fatal("empty endpoint enabled exporter")
	}
	handler := runtime.WrapPublicHTTP(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusTeapot)
	}), nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "https://rgs.example/", nil))
	if response.Code != http.StatusTeapot {
		t.Fatalf("disabled runtime changed handler response: %d", response.Code)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := runtime.Shutdown(ctx); err != nil {
		t.Fatalf("disabled shutdown = %v", err)
	}
}

func TestPublicHTTPAllowsClientSessionStatusRoute(t *testing.T) {
	runtime, recorder, provider := recordingRuntime(t, sdktrace.AlwaysSample())
	defer provider.Shutdown(context.Background())
	handler := runtime.WrapPublicHTTP(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusOK)
	}), func(*http.Request) string { return "client.session_status" })
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "https://rgs.example/client/v1/sessions/status", nil))

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("ended spans = %d, want 1", len(spans))
	}
	assertSafeHTTPAttributes(t, spans[0].Attributes(), "POST", "client.session_status", http.StatusOK)
}

func TestEndDoesNotRecordErrorTextOrTreatCallerCancellationAsBackendFailure(t *testing.T) {
	runtime, recorder, provider := recordingRuntime(t, sdktrace.AlwaysSample())
	defer provider.Shutdown(context.Background())
	ctx, canceledSpan := Start(runtime.Context(context.Background()), "test.canceled")
	_ = ctx
	End(canceledSpan, context.Canceled)
	_, failedSpan := Start(runtime.Context(context.Background()), "test.failed")
	End(failedSpan, errors.New("player-private endpoint-secret"))
	spans := recorder.Ended()
	if len(spans) != 2 {
		t.Fatalf("ended spans = %d", len(spans))
	}
	if spans[0].Status().Code != 0 {
		t.Fatalf("caller cancellation status = %+v", spans[0].Status())
	}
	if spans[1].Status().Code == 0 || spans[1].Status().Description != "" ||
		strings.Contains(attributesText(spans[1].Attributes()), "player-private") {
		t.Fatalf("privacy-unsafe failed span = status:%+v attrs:%v", spans[1].Status(), spans[1].Attributes())
	}
}

func TestObservedExporterCountsFailureAndReturnsOnlyFixedCategory(t *testing.T) {
	observer := &testObserver{}
	exporter := observedExporter{next: failingExporter{}, observer: observer}
	err := exporter.ExportSpans(context.Background(), nil)
	if !errors.Is(err, errTraceExportFailed) || strings.Contains(err.Error(), "collector-secret") {
		t.Fatalf("export error = %v", err)
	}
	if err := exporter.Shutdown(context.Background()); !errors.Is(err, errTraceExportFailed) {
		t.Fatalf("shutdown error = %v", err)
	}
	if observer.failures.Load() != 2 {
		t.Fatalf("export failure observations = %d", observer.failures.Load())
	}
}

func TestEnabledConfigRequiresCompleteBoundedEndpoint(t *testing.T) {
	base := validEnabledConfig()
	if err := base.validate(); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	base.Endpoint = "https://collector.example"
	if err := base.validate(); err == nil {
		t.Fatal("endpoint without /v1/traces accepted")
	}
}

func validEnabledConfig() Config {
	return Config{
		Endpoint: "https://collector.example/v1/traces", SampleRatio: 0.1,
		ServiceName: ServiceNameAPI, Environment: EnvironmentProd,
		BatchTimeout: time.Second, ExportTimeout: time.Second,
		MaxQueueSize: 64, MaxExportBatchSize: 16,
	}
}

func TestTracingResourceContainsOnlyFixedLowCardinalityIdentity(t *testing.T) {
	resource := tracingResource(ServiceNameWorker, EnvironmentProd)
	attributes := resource.Set()
	if attributes.Len() != 3 {
		t.Fatalf("resource attribute count = %d, want 3", attributes.Len())
	}
	want := map[string]string{
		"service.name":                ServiceNameWorker,
		"service.namespace":           serviceNamespace,
		"deployment.environment.name": EnvironmentProd,
	}
	iterator := attributes.Iter()
	for iterator.Next() {
		item := iterator.Attribute()
		key := string(item.Key)
		value, allowed := want[key]
		if !allowed || item.Value.AsString() != value {
			t.Fatalf("unexpected resource attribute %s=%v", key, item.Value.AsInterface())
		}
		delete(want, key)
	}
	if len(want) != 0 {
		t.Fatalf("missing resource attributes: %#v", want)
	}
	forbidden := resource.Encoded(attribute.DefaultEncoder())
	for _, fragment := range []string{"endpoint", "host.", "process.", "service.instance", "player", "session", "amount"} {
		if strings.Contains(forbidden, fragment) {
			t.Fatalf("resource contains forbidden identity %q: %s", fragment, forbidden)
		}
	}
}

func recordingRuntime(t *testing.T, sampler sdktrace.Sampler) (*Runtime, *tracetest.SpanRecorder, *sdktrace.TracerProvider) {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sampler),
		sdktrace.WithSpanProcessor(recorder),
	)
	return NewWithProvider(provider), recorder, provider
}

func assertSafeHTTPAttributes(t *testing.T, attributes []attribute.KeyValue, method, route string, status int) {
	t.Helper()
	if len(attributes) != 3 {
		t.Fatalf("HTTP attribute count = %d, want 3: %#v", len(attributes), attributes)
	}
	want := map[string]string{
		"http.request.method":       method,
		"http.route":                route,
		"http.response.status_code": fmt.Sprint(status),
	}
	for _, item := range attributes {
		key := string(item.Key)
		value, allowed := want[key]
		if !allowed || fmt.Sprint(item.Value.AsInterface()) != value {
			t.Fatalf("unexpected HTTP attribute %s=%v", key, item.Value.AsInterface())
		}
		delete(want, key)
	}
	if len(want) != 0 {
		t.Fatalf("missing HTTP attributes: %#v", want)
	}
}

func attributesText(attributes []attribute.KeyValue) string {
	var builder strings.Builder
	for _, item := range attributes {
		builder.WriteString(string(item.Key))
		builder.WriteString("=")
		builder.WriteString(fmt.Sprint(item.Value.AsInterface()))
		builder.WriteString(";")
	}
	return builder.String()
}

type testObserver struct{ failures atomic.Uint64 }

func (observer *testObserver) TraceExportFailure() { observer.failures.Add(1) }

type failingExporter struct{}

type failingEntropyReader struct{}

func (failingEntropyReader) Read([]byte) (int, error) {
	return 0, errors.New("entropy-private")
}

func (failingExporter) ExportSpans(context.Context, []sdktrace.ReadOnlySpan) error {
	return errors.New("collector-secret response-body-private")
}

func (failingExporter) Shutdown(context.Context) error {
	return errors.New("collector-secret shutdown-private")
}
