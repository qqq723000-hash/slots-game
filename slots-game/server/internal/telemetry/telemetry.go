// Package telemetry 提供 RGS 分布式追踪边界。追踪保持可选且仅随 context 传播：
// exporter endpoint 为空时是真正的 no-op；启用后有界队列满也绝不能阻塞经济请求。
// English: Package telemetry provides RGS distributed tracing boundaries. Tracing remains optional and only
// propagates with the context: the exporter endpoint is a true no-op when empty; when enabled, the bounded queue
// must not block economic requests even if it is full.
package telemetry

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"
)

const (
	instrumentationName = "slots-game/server"
	traceEndpointPath   = "/v1/traces"
	maxTraceStateBytes  = 512
	maxExportBytes      = 512 << 10
	samplerKeyBytes     = 32
	serviceNamespace    = "slots-game"

	ServiceNameAPI      = "slots-game-rgs-api"
	ServiceNameWorker   = "slots-game-rgs-worker"
	ServiceNameCombined = "slots-game-rgs-combined"
	EnvironmentDev      = "development"
	EnvironmentProd     = "production"
)

// Config 是刻意收窄且有界的 OTLP/HTTP 配置；Endpoint 必须包含完整 /v1/traces 路径。
// English: Config is an intentionally narrow and bounded OTLP/HTTP configuration; Endpoint must contain the full
// /v1/traces path.
type Config struct {
	Endpoint           string
	ServiceName        string
	Environment        string
	SampleRatio        float64
	BatchTimeout       time.Duration
	ExportTimeout      time.Duration
	MaxQueueSize       int
	MaxExportBatchSize int
	Observer           Observer
}

// Observer 只接收固定类别的进程信号；实现禁止附加请求、身份、endpoint、key 或错误文本标签。
// English: Observers only receive fixed categories of process signals; the implementation prohibits appending
// request, identity, endpoint, key, or error text labels.
type Observer interface {
	TraceExportFailure()
}

// Runtime 持有 context 作用域的 tracer provider，绝不替换全局 provider，
// 从而隔离测试与进程内无关的 instrumentation。
// English: The runtime holds the tracer provider in the context scope and never replaces the global provider, thus
// isolating the test from instrumentation that has nothing to do with the process.
type Runtime struct {
	provider trace.TracerProvider
	active   bool
	enabled  bool
	shutdown func(context.Context) error
}

type providerContextKey struct{}

// New 构造可选的 OTLP/HTTP tracing runtime。空 endpoint 会在其余校验前返回，
// 且该 provider 没有 exporter 或后台 goroutine。
// English: New Constructs an optional OTLP/HTTP tracing runtime. An empty endpoint will be returned before the
// rest of the validation, and the provider has no exporter or background goroutine.
func New(ctx context.Context, config Config) (*Runtime, error) {
	return newRuntime(ctx, config, rand.Reader)
}

func newRuntime(ctx context.Context, config Config, entropy io.Reader) (*Runtime, error) {
	config.Endpoint = strings.TrimSpace(config.Endpoint)
	if config.Endpoint == "" {
		return &Runtime{provider: noop.NewTracerProvider()}, nil
	}
	if err := config.validate(); err != nil {
		return nil, err
	}
	remoteSamplerKey, err := readSamplerKey(entropy)
	if err != nil {
		// 不把 entropy provider 的错误文本带入日志；main 会按既有失败开放路径
		// 禁用 tracing，资金处理与服务启动不依赖采样密钥。
		// English: The error text of the entropy provider is not entered into the log; main disables tracing according to
		// the existing failed open path, and fund processing and service startup do not rely on the sampling key.
		return nil, errors.New("initialize trace sampling entropy")
	}

	exporter, err := otlptracehttp.New(
		ctx,
		otlptracehttp.WithEndpointURL(config.Endpoint),
		otlptracehttp.WithTimeout(config.ExportTimeout),
		otlptracehttp.WithMaxRequestSize(maxExportBytes),
		otlptracehttp.WithRetry(otlptracehttp.RetryConfig{
			Enabled:         true,
			InitialInterval: 100 * time.Millisecond,
			MaxInterval:     500 * time.Millisecond,
			MaxElapsedTime:  config.ExportTimeout,
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("initialize OTLP trace exporter: %w", err)
	}
	processor := sdktrace.NewBatchSpanProcessor(
		observedExporter{next: exporter, observer: config.Observer},
		sdktrace.WithBatchTimeout(config.BatchTimeout),
		sdktrace.WithExportTimeout(config.ExportTimeout),
		sdktrace.WithMaxQueueSize(config.MaxQueueSize),
		sdktrace.WithMaxExportBatchSize(config.MaxExportBatchSize),
		// 刻意不传 WithBlocking：队列压力允许丢 trace，但经济请求路径绝不能等待。
		// English: Deliberately not pass WithBlocking: Queue pressure allows trace loss, but the economic request path
		// must not wait.
	)
	provider := sdktrace.NewTracerProvider(
		// 本地 child 继承可信本地 parent；不可信 remote sampled flag 则重新按
		// 配置比例判定，不能强制采集。
		// English: The local child inherits the trusted local parent; the untrusted remote sampled flag is re-determined
		// according to the configuration ratio and cannot be forced to collect.
		sdktrace.WithSampler(publicSampler(config.SampleRatio, remoteSamplerKey)),
		sdktrace.WithSpanLimits(sdktrace.SpanLimits{
			AttributeValueLengthLimit:   256,
			AttributeCountLimit:         8,
			EventCountLimit:             0,
			LinkCountLimit:              0,
			AttributePerEventCountLimit: 0,
			AttributePerLinkCountLimit:  0,
		}),
		sdktrace.WithSpanProcessor(processor),
		sdktrace.WithResource(tracingResource(config.ServiceName, config.Environment)),
	)
	return &Runtime{
		provider: provider,
		active:   true,
		enabled:  true,
		shutdown: provider.Shutdown,
	}, nil
}

func readSamplerKey(entropy io.Reader) ([samplerKeyBytes]byte, error) {
	var key [samplerKeyBytes]byte
	if entropy == nil {
		return key, errors.New("entropy reader is unavailable")
	}
	_, err := io.ReadFull(entropy, key[:])
	return key, err
}

func publicSampler(ratio float64, remoteKey [samplerKeyBytes]byte) sdktrace.Sampler {
	rootSampler := sdktrace.TraceIDRatioBased(ratio)
	remoteSampler := keyedRatioSampler{ratio: ratio, key: remoteKey}
	return sdktrace.ParentBased(
		rootSampler,
		sdktrace.WithRemoteParentSampled(remoteSampler),
		sdktrace.WithRemoteParentNotSampled(remoteSampler),
	)
}

// keyedRatioSampler 只处理不可信 remote parent。调用方可选择 trace ID，
// 但不知道进程启动时生成的密钥，不能用官方 sampler 的低 63 位阈值强制命中。
// English: keyedRatioSampler only handles untrusted remote parents. The caller can choose the trace ID, but
// without knowing the key generated when the process is started, it cannot force a hit with the official sampler's
// lower 63-bit threshold.
type keyedRatioSampler struct {
	ratio float64
	key   [samplerKeyBytes]byte
}

func (sampler keyedRatioSampler) ShouldSample(parameters sdktrace.SamplingParameters) sdktrace.SamplingResult {
	decision := sdktrace.Drop
	if sampler.ratio >= 1 {
		decision = sdktrace.RecordAndSample
	} else if sampler.ratio > 0 {
		mac := hmac.New(sha256.New, sampler.key[:])
		_, _ = mac.Write(parameters.TraceID[:])
		digest := mac.Sum(nil)
		value := binary.BigEndian.Uint64(digest[:8]) >> 1
		threshold := uint64(sampler.ratio * (1 << 63))
		if value < threshold {
			decision = sdktrace.RecordAndSample
		}
	}
	return sdktrace.SamplingResult{
		Decision:   decision,
		Tracestate: trace.SpanContextFromContext(parameters.ParentContext).TraceState(),
	}
}

func (sampler keyedRatioSampler) Description() string { return "RemoteParentKeyedRatio" }

func (config Config) validate() error {
	if !validServiceName(config.ServiceName) {
		return errors.New("trace service name is outside the fixed allowlist")
	}
	if config.Environment != EnvironmentDev && config.Environment != EnvironmentProd {
		return errors.New("trace environment must be development or production")
	}
	if len(config.Endpoint) > 2_048 {
		return errors.New("trace endpoint exceeds 2048 bytes")
	}
	endpoint, err := url.Parse(config.Endpoint)
	if err != nil || endpoint.Host == "" ||
		(endpoint.Scheme != "http" && endpoint.Scheme != "https") ||
		endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" ||
		endpoint.Path != traceEndpointPath {
		return errors.New("trace endpoint must be an http(s) URL ending exactly in /v1/traces without user info, query, or fragment")
	}
	if math.IsNaN(config.SampleRatio) || math.IsInf(config.SampleRatio, 0) ||
		config.SampleRatio < 0 || config.SampleRatio > 1 {
		return errors.New("trace sample ratio must be finite and between 0 and 1")
	}
	if config.BatchTimeout < 100*time.Millisecond || config.BatchTimeout > 30*time.Second {
		return errors.New("trace batch timeout must be between 100ms and 30s")
	}
	if config.ExportTimeout < 100*time.Millisecond || config.ExportTimeout > 30*time.Second {
		return errors.New("trace export timeout must be between 100ms and 30s")
	}
	if config.MaxQueueSize < 1 || config.MaxQueueSize > 8_192 {
		return errors.New("trace queue size must be between 1 and 8192")
	}
	if config.MaxExportBatchSize < 1 || config.MaxExportBatchSize > 1_024 ||
		config.MaxExportBatchSize > config.MaxQueueSize {
		return errors.New("trace export batch size must be between 1 and 1024 and not exceed the queue size")
	}
	return nil
}

func validServiceName(name string) bool {
	switch name {
	case ServiceNameAPI, ServiceNameWorker, ServiceNameCombined:
		return true
	default:
		return false
	}
}

func tracingResource(serviceName, environment string) *resource.Resource {
	return resource.NewWithAttributes(
		"",
		attribute.String("service.name", serviceName),
		attribute.String("service.namespace", serviceNamespace),
		attribute.String("deployment.environment.name", environment),
	)
}

// NewWithProvider 包装调用方管理的 provider，供嵌入或确定性测试使用；
// 所有权仍属于调用方，因此 Shutdown 是 no-op。
// English: NewWithProvider wraps a caller-managed provider for use by embedding or deterministic testing;
// ownership remains with the caller, so Shutdown is a no-op.
func NewWithProvider(provider trace.TracerProvider) *Runtime {
	if provider == nil {
		return &Runtime{provider: noop.NewTracerProvider()}
	}
	return &Runtime{provider: provider, active: true}
}

// Enabled 返回是否已配置带 exporter 的 provider。
// English: Enabled Returns whether the provider with exporter has been configured.
func (runtime *Runtime) Enabled() bool {
	return runtime != nil && runtime.enabled
}

// Context 将 runtime provider 交给已 instrument 的内部边界，且不修改 OpenTelemetry 全局状态。
// English: Context hands the runtime provider to the instrument's internal boundaries without modifying the
// OpenTelemetry global state.
func (runtime *Runtime) Context(ctx context.Context) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if runtime == nil || !runtime.active {
		return ctx
	}
	return context.WithValue(ctx, providerContextKey{}, runtimeProvider(runtime))
}

// Shutdown 刷新并关闭已配置 exporter；deadline 由调用方控制，禁用或外部管理的 runtime 立即返回。
// English: Shutdown refreshes and closes the configured exporter; deadline is controlled by the caller, and a
// disabled or externally managed runtime returns immediately.
func (runtime *Runtime) Shutdown(ctx context.Context) error {
	if runtime == nil || runtime.shutdown == nil {
		return nil
	}
	return runtime.shutdown(ctx)
}

func runtimeProvider(runtime *Runtime) trace.TracerProvider {
	if runtime != nil && runtime.provider != nil {
		return runtime.provider
	}
	return noop.NewTracerProvider()
}

func providerFromContext(ctx context.Context) trace.TracerProvider {
	if provider, ok := ctx.Value(providerContextKey{}).(trace.TracerProvider); ok && provider != nil {
		return provider
	}
	return noop.NewTracerProvider()
}

// Start 使用 Runtime 附加的 provider 创建内部 child span；context 未带 runtime 时为轻量 no-op。
// English: Start uses the provider attached to the Runtime to create an internal child span; when the context does
// not have a runtime, it is a lightweight no-op.
func Start(ctx context.Context, name string, options ...trace.SpanStartOption) (context.Context, trace.Span) {
	return providerFromContext(ctx).Tracer(instrumentationName).Start(ctx, name, options...)
}

// End 写入隐私安全的失败状态并结束 span；刻意不调用 RecordError 或附加 err.Error()，
// 且不把调用方主动取消视为 backend 故障。
// English: End writes a privacy-safe failure status and ends the span; intentionally does not call RecordError or
// append err.Error(), and does not treat the caller's active cancellation as a backend failure.
func End(span trace.Span, err error) {
	if span == nil {
		return
	}
	if err != nil && !errors.Is(err, context.Canceled) {
		span.SetStatus(codes.Error, "")
	}
	span.End()
}

// Inject 只写 W3C traceparent/tracestate；本包绝不传播 baggage 或业务字段。
// English: Inject only writes W3C traceparent/tracestate; this package never propagates baggage or business
// fields.
func Inject(ctx context.Context, header http.Header) {
	if header == nil {
		return
	}
	propagation.TraceContext{}.Inject(ctx, propagation.HeaderCarrier(header))
}

// WrapPublicHTTP 为公网 RGS 请求创建一个 server span；非法 trace header 只会脱离
// remote parent，绝不拒绝或改变业务请求。
// English: WrapPublicHTTP creates a server span for public network RGS requests; illegal trace headers will only
// be separated from the remote parent and will never reject or change business requests.
func (runtime *Runtime) WrapPublicHTTP(next http.Handler, route func(*http.Request) string) http.Handler {
	if next == nil {
		next = http.NotFoundHandler()
	}
	if runtime == nil || !runtime.active {
		return next
	}
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requestContext := extractRemoteParent(request.Context(), request.Header)
		requestContext = runtime.Context(requestContext)
		publicRoute := "other"
		if route != nil {
			publicRoute = normalizePublicRoute(route(request))
		}
		method := normalizeHTTPMethod(request.Method)
		requestContext, span := runtimeProvider(runtime).Tracer(instrumentationName).Start(
			requestContext,
			"rgs.http.request",
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(
				attribute.String("http.request.method", method),
				attribute.String("http.route", publicRoute),
			),
		)
		recorder := &responseRecorder{ResponseWriter: writer}
		defer func() {
			panicValue := recover()
			status := recorder.status
			if panicValue != nil {
				status = http.StatusInternalServerError
			} else if status == 0 {
				status = http.StatusOK
			}
			span.SetAttributes(attribute.Int("http.response.status_code", status))
			if status >= http.StatusInternalServerError {
				span.SetStatus(codes.Error, "")
			}
			span.End()
			if panicValue != nil {
				panic(panicValue)
			}
		}()
		next.ServeHTTP(recorder, request.WithContext(requestContext))
	})
}

func extractRemoteParent(ctx context.Context, header http.Header) context.Context {
	traceParents := header.Values("traceparent")
	if len(traceParents) != 1 || !validTraceParent(traceParents[0]) {
		return ctx
	}
	carrier := propagation.HeaderCarrier(http.Header{})
	carrier.Set("traceparent", traceParents[0])
	traceStates := header.Values("tracestate")
	if len(traceStates) > 0 {
		// Trace Context Level 2 允许多个 tracestate 字段；按字段顺序合并后
		// 只做有界语法检查。无论是否合法，都不能影响合法 traceparent 的解析。
		// English: Trace Context Level 2 allows multiple tracestate fields; only bounded syntax checking is performed
		// after merging in field order. Regardless of whether it is legal or not, it cannot affect the parsing of legal
		// traceparents.
		combined := strings.Join(traceStates, ",")
		if len(combined) <= maxTraceStateBytes && !strings.ContainsAny(combined, "\r\n") {
			_, _ = trace.ParseTraceState(combined)
		}
		// 公网调用方可控制 opaque value；当前没有受信 vendor allowlist，因此
		// 无论语法是否合法都在此隐私边界丢弃，绝不导出或转发任意身份/高基数内容。
		// English: The public network caller has control over the opaque value; there is currently no trusted vendor
		// allowlist, so any identity/high cardinality content is never exported or forwarded at this privacy boundary
		// regardless of whether the syntax is valid or not.
	}
	extracted := propagation.TraceContext{}.Extract(ctx, carrier)
	spanContext := trace.SpanContextFromContext(extracted)
	if !spanContext.IsValid() || !spanContext.IsRemote() {
		return ctx
	}
	return extracted
}

func validTraceParent(value string) bool {
	if len(value) != 55 || value[2] != '-' || value[35] != '-' || value[52] != '-' ||
		value[:2] != "00" ||
		(value[53:] != "00" && value[53:] != "01" && value[53:] != "02" && value[53:] != "03") {
		return false
	}
	for index, character := range value {
		if index == 2 || index == 35 || index == 52 {
			continue
		}
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')) {
			return false
		}
	}
	traceID, err := trace.TraceIDFromHex(value[3:35])
	if err != nil || !traceID.IsValid() {
		return false
	}
	spanID, err := trace.SpanIDFromHex(value[36:52])
	return err == nil && spanID.IsValid()
}

func normalizeHTTPMethod(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodOptions:
		return method
	default:
		return "OTHER"
	}
}

func normalizePublicRoute(route string) string {
	switch route {
	case "operator.launch", "operator.round_status", "operator.risk_decision", "client.session_exchange",
		"client.session_refresh", "client.session_status", "client.spin", "client.round_status",
		"client.pending_result", "client.result_ack":
		return route
	default:
		return "other"
	}
}

type responseRecorder struct {
	http.ResponseWriter
	status int
}

func (writer *responseRecorder) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

func (writer *responseRecorder) FlushError() error {
	err := http.NewResponseController(writer.ResponseWriter).Flush()
	if !errors.Is(err, http.ErrNotSupported) && writer.status == 0 {
		writer.status = http.StatusOK
	}
	return err
}

func (writer *responseRecorder) WriteHeader(status int) {
	if status >= 100 && status < 200 && status != http.StatusSwitchingProtocols {
		if writer.status == 0 {
			writer.ResponseWriter.WriteHeader(status)
		}
		return
	}
	if writer.status != 0 {
		return
	}
	writer.status = status
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *responseRecorder) Write(payload []byte) (int, error) {
	if writer.status == 0 {
		writer.WriteHeader(http.StatusOK)
	}
	return writer.ResponseWriter.Write(payload)
}

func (writer *responseRecorder) ReadFrom(reader io.Reader) (int64, error) {
	if writer.status == 0 {
		writer.WriteHeader(http.StatusOK)
	}
	if readerFrom, ok := writer.ResponseWriter.(io.ReaderFrom); ok {
		return readerFrom.ReadFrom(reader)
	}
	return io.Copy(struct{ io.Writer }{writer.ResponseWriter}, reader)
}

var errTraceExportFailed = errors.New("trace export failed")

// observedExporter 在 SDK error handler 接触诊断前将其收敛为固定错误类别；
// 既保留失败可见性，又不让 endpoint、传输、响应正文或凭据文本进入进程日志。
// English: observedExporter Convergs the SDK error handler to a fixed error class before it touches diagnostics;
// retains failure visibility without letting the endpoint, transport, response body, or credential text enter the
// process log.
type observedExporter struct {
	next     sdktrace.SpanExporter
	observer Observer
}

func (exporter observedExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	if exporter.next == nil {
		return nil
	}
	if err := exporter.next.ExportSpans(ctx, spans); err != nil {
		notifyObserver(exporter.observer, func(observer Observer) {
			observer.TraceExportFailure()
		})
		return errTraceExportFailed
	}
	return nil
}

func (exporter observedExporter) Shutdown(ctx context.Context) error {
	if exporter.next == nil {
		return nil
	}
	if err := exporter.next.Shutdown(ctx); err != nil {
		notifyObserver(exporter.observer, func(observer Observer) {
			observer.TraceExportFailure()
		})
		return errTraceExportFailed
	}
	return nil
}

func notifyObserver(observer Observer, notify func(Observer)) {
	if observer == nil {
		return
	}
	defer func() { _ = recover() }()
	notify(observer)
}
