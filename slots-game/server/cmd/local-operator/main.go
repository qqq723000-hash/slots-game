// Command local-operator 提供本机集成验收所需的持久化运营商配套服务。
// 它不是测试夹具：钱包、nonce、审计和日志都在进程重启后保留，且所有信任材料由部署注入。
package main

import (
	"context"
	"crypto/tls"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"

	"slots-game/server/internal/operator"
	"slots-game/server/internal/safelog"
)

func main() {
	if err := run(os.Args[1:], os.Getenv); err != nil {
		logRuntimeFailure(
			slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})),
			err,
		)
		os.Exit(1)
	}
}

func logRuntimeFailure(logger *slog.Logger, err error) {
	if logger != nil {
		// 启动错误可能包含数据库地址、秘密文件路径、证书名或监听地址，只记录固定错误族。
		logger.Error("local operator stopped", "error_class", safelog.ErrorClass(err))
	}
}

func run(arguments []string, getenv func(string) string) error {
	command := "serve"
	if len(arguments) > 0 {
		command = arguments[0]
	}
	switch command {
	case "bootstrap":
		if len(arguments) != 1 {
			return errors.New("usage: local-operator bootstrap")
		}
		config, err := loadDatabaseBootstrapConfig(getenv)
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		if err := bootstrapDatabase(ctx, config); err != nil {
			return err
		}
		_, _ = io.WriteString(os.Stdout, "local operator database roles and DSNs are current\n")
		return nil
	case "migrate":
		if len(arguments) != 1 {
			return errors.New("usage: local-operator migrate")
		}
		path := getenv("LOCAL_OPERATOR_DATABASE_URL_FILE")
		if path == "" {
			return errors.New("LOCAL_OPERATOR_DATABASE_URL_FILE is required")
		}
		databaseURL, err := loadDatabaseURL(path)
		if err != nil {
			return fmt.Errorf("load migration database URL: %w", err)
		}
		if err := validateProductionDatabaseURL(databaseURL); err != nil {
			return err
		}
		database, err := openDatabase(databaseURL)
		if err != nil {
			return err
		}
		defer database.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		ownerRole := valueOrDefault(getenv("LOCAL_OPERATOR_OWNER_DATABASE_ROLE"), "local_operator_owner")
		runtimeRole := valueOrDefault(getenv("LOCAL_OPERATOR_RUNTIME_DATABASE_ROLE"), "local_operator_runtime")
		if err := migrateLocalOperator(ctx, database, ownerRole, runtimeRole); err != nil {
			return err
		}
		_, _ = io.WriteString(os.Stdout, "local operator schema is current\n")
		return nil
	case "serve":
		if len(arguments) > 1 {
			return errors.New("usage: local-operator [bootstrap|migrate|serve]")
		}
		return serve(getenv)
	default:
		return errors.New("usage: local-operator [bootstrap|migrate|serve]")
	}
}

func serve(getenv func(string) string) error {
	runtime, err := loadRuntimeConfig(getenv)
	if err != nil {
		return fmt.Errorf("load local operator configuration: %w", err)
	}
	defer runtime.clearSecrets()
	privateKeyPEM, err := readRegularFile(runtime.Config.TLSPrivateKeyFile, 1<<20, true)
	clear(privateKeyPEM)
	if err != nil {
		return fmt.Errorf("validate local operator TLS private key: %w", err)
	}
	if _, err := tls.LoadX509KeyPair(runtime.Config.TLSCertificateFile, runtime.Config.TLSPrivateKeyFile); err != nil {
		return errors.New("local operator TLS certificate/key pair is invalid")
	}
	database, err := openDatabase(runtime.DatabaseURL)
	if err != nil {
		return err
	}
	defer database.Close()
	store, err := newPostgresStore(database)
	if err != nil {
		return err
	}
	startupCtx, startupCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer startupCancel()
	if err := verifyRuntimeDatabaseRole(startupCtx, database, runtime.Config.RuntimeDatabaseRole); err != nil {
		return err
	}
	if err := store.Ping(startupCtx); err != nil {
		return fmt.Errorf("local operator database is not ready: %w", err)
	}

	// 本机长期运行仍必须有明确磁盘故障边界：审计保留 512 MiB，脱敏运行日志
	// 保留 256 MiB。达到上限后 sink 失败闭合，由 RGS outbox/Vector 告警接管。
	auditStore, err := openJSONLStore(runtime.Config.AuditFile, 1<<20, 512<<20)
	if err != nil {
		return fmt.Errorf("open audit store: %w", err)
	}
	defer auditStore.Close()
	logStore, err := openAppendStore(runtime.Config.LogFile, 4<<20, 256<<20)
	if err != nil {
		return fmt.Errorf("open log store: %w", err)
	}
	defer logStore.Close()
	// Alertmanager webhook 采用内容摘要幂等落盘；相同通知重试只保留一条，
	// 但仍返回 204，避免通知端在本机故障恢复后制造重复风暴。
	alertStore, err := openDeduplicatingAppendStore(runtime.Config.AlertFile, 1<<20, 64<<20)
	if err != nil {
		return fmt.Errorf("open alert store: %w", err)
	}
	defer alertStore.Close()
	metrics := &serviceMetrics{}
	walletKeyRing, err := operator.NewMemoryKeyRing(runtime.Keys.WalletRequestVerificationKeys...)
	if err != nil {
		return err
	}
	walletVerifier, err := operator.NewRequestVerifier(walletKeyRing, store, operator.RequestVerifierOptions{
		ClockSkew: 30 * time.Second, MaxLifetime: operator.DefaultSignatureLifetime,
	})
	if err != nil {
		return err
	}
	wallet := newWalletHandler(walletHandlerConfig{
		OperatorID: runtime.Keys.OperatorID, Store: store, Verifier: walletVerifier,
		ResponseSigningKey: runtime.Keys.WalletResponseSigningKey,
		AllowLegacyV1:      runtime.Config.AllowLegacyWalletV1, Metrics: metrics,
	})
	launchClient, err := newLaunchClient(
		runtime.Keys.OperatorID, runtime.Config.RGSBaseURL,
		runtime.Keys.LaunchRequestSigningKey, runtime.Keys.RGSResponseVerificationKeys,
		runtime.RGSClient,
	)
	if err != nil {
		return err
	}
	launcherHandler, err := newLauncher(launcherConfig{
		OperatorID: runtime.Keys.OperatorID, WebBaseURL: runtime.Config.WebBaseURL,
		GameID: runtime.Config.GameID, DefinitionVersion: runtime.Config.DefinitionVersion,
		DefinitionHash: runtime.Config.DefinitionHash, Currency: runtime.Config.Currency,
		CurrencyExponent: runtime.Config.CurrencyExponent, Jurisdiction: runtime.Config.Jurisdiction,
		InitialBalanceMinor: runtime.Config.InitialBalanceMinor, SessionTTL: runtime.Config.SessionTTL,
		IdleDisconnect:         runtime.Config.IdleDisconnect,
		DefaultPlayerID:        runtime.Config.DefaultPlayerID,
		DefaultWalletAccountID: runtime.Config.DefaultWalletAccountID,
		AdminToken:             runtime.AdminToken, Store: store, Client: launchClient, Metrics: metrics,
	})
	if err != nil {
		return err
	}
	auditHandler, err := newAuditSink(auditSinkConfig{
		Path: "/audit", KeyID: runtime.Config.AuditKeyID, HMACKey: runtime.AuditHMACKey,
		BearerToken: runtime.AuditBearerToken, MaximumClockSkew: 5 * time.Minute,
		MaximumBodyBytes: 1 << 20, MaximumConcurrent: 8, Store: auditStore, Metrics: metrics,
	})
	if err != nil {
		return err
	}
	logHandler, err := newLogSink(logSinkConfig{
		Path: "/logs", BearerToken: runtime.LogBearerToken,
		MaximumBodyBytes: 4 << 20, MaximumConcurrent: 4, Store: logStore, Metrics: metrics,
	})
	if err != nil {
		return err
	}
	alertHandler, err := newAlertSink(alertSinkConfig{
		Path: "/alerts", BearerToken: runtime.AlertmanagerToken,
		MaximumBodyBytes: 1 << 20, MaximumConcurrent: 4, Store: alertStore, Metrics: metrics,
	})
	if err != nil {
		return err
	}
	readiness := func(ctx context.Context) bool {
		// 容量水位通过独立指标失败闭合；readiness 只表达服务、DB 和文件句柄
		// 是否可用，避免容量告警演变成容器重启循环并遮蔽真实原因。
		return store.Ping(ctx) == nil && auditStore.Ready() == nil &&
			logStore.Ready() == nil && alertStore.Ready() == nil
	}
	operationsMetrics := localOperationsMetrics{
		Audit: auditStore, Logs: logStore, Alerts: alertStore,
		BackupStatusFile: runtime.Config.BackupStatusFile,
	}

	mux := http.NewServeMux()
	mux.Handle("/rgs/wallet/v1/rounds/apply", wallet)
	mux.Handle("/rgs/wallet/v1/transactions/status", wallet)
	mux.Handle("/rgs/wallet/v1/transactions/rollback", wallet)
	mux.Handle("/audit", auditHandler)
	mux.Handle("/logs", logHandler)
	mux.Handle("/alerts", alertHandler)
	mux.Handle("/healthz", healthHandler(readiness))
	mux.Handle("/metrics", metricsHandler(runtime.MetricsToken, metrics, readiness, operationsMetrics))
	mux.Handle("/internal/auth/alertmanager", alertmanagerAuthHandler(runtime.AlertmanagerToken))
	mux.Handle("/", launcherHandler)

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if runtime.Config.AllowLegacyWalletV1 {
		logger.Warn("legacy wallet v1 compatibility is enabled; v2 command binding is not enforced for legacy requests")
	}
	handler := requestMiddleware(logger, metrics, runtime.Config.RequestTimeout, mux)
	server := &http.Server{
		Addr: runtime.Config.ListenAddress, Handler: handler,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second,
		MaxHeaderBytes: 32 << 10,
		TLSConfig:      &tls.Config{MinVersion: tls.VersionTLS12},
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	serveError := make(chan error, 1)
	go func() {
		logger.Info("local operator started", "address", runtime.Config.ListenAddress)
		serveError <- server.ListenAndServeTLS(runtime.Config.TLSCertificateFile, runtime.Config.TLSPrivateKeyFile)
	}()
	select {
	case err := <-serveError:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		shutdownCtx, cancel := context.WithTimeout(context.Background(), runtime.Config.ShutdownTimeout)
		defer cancel()
		return shutdownLocalOperatorAfterServeFailure(shutdownCtx, server, err)
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), runtime.Config.ShutdownTimeout)
		defer cancel()
		shutdownErr := shutdownLocalOperatorHTTPServer(shutdownCtx, server)
		serveErr := <-serveError
		if errors.Is(serveErr, http.ErrServerClosed) {
			serveErr = nil
		} else if serveErr != nil {
			serveErr = fmt.Errorf("close local operator: %w", serveErr)
		}
		if err := errors.Join(shutdownErr, serveErr); err != nil {
			return err
		}
		logger.Info("local operator stopped")
		return nil
	}
}

type localOperatorHTTPServer interface {
	Shutdown(context.Context) error
	Close() error
}

func shutdownLocalOperatorHTTPServer(ctx context.Context, server localOperatorHTTPServer) error {
	if server == nil {
		return nil
	}
	if err := server.Shutdown(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		failures := []error{fmt.Errorf("shutdown local operator: %w", err)}
		// Shutdown 超时后必须先强制断开活动请求，再由上层释放数据库与落盘存储。
		// 否则仍运行的 handler 会在资源关闭后继续读写并遗留协程或部分响应。
		if closeErr := server.Close(); closeErr != nil && !errors.Is(closeErr, http.ErrServerClosed) {
			failures = append(failures, fmt.Errorf("force-close local operator: %w", closeErr))
		}
		return errors.Join(failures...)
	}
	return nil
}

func shutdownLocalOperatorAfterServeFailure(
	ctx context.Context,
	server localOperatorHTTPServer,
	serveErr error,
) error {
	if serveErr == nil || errors.Is(serveErr, http.ErrServerClosed) {
		return nil
	}
	// Listener 在运行期异常退出时，已接收的 handler 仍可能访问数据库和落盘存储。
	// 必须先完成有界排空或强制断连，再允许 serve 返回并执行上层资源清理 defer。
	return errors.Join(
		fmt.Errorf("serve local operator: %w", serveErr),
		shutdownLocalOperatorHTTPServer(ctx, server),
	)
}

func openDatabase(databaseURL string) (*sql.DB, error) {
	configuration, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return nil, errors.New("local operator database URL is invalid")
	}
	configuration.RuntimeParams["statement_timeout"] = "10000"
	configuration.RuntimeParams["lock_timeout"] = "3000"
	configuration.RuntimeParams["idle_in_transaction_session_timeout"] = "15000"
	database := stdlib.OpenDB(*configuration)
	database.SetMaxOpenConns(8)
	database.SetMaxIdleConns(4)
	database.SetConnMaxLifetime(30 * time.Minute)
	database.SetConnMaxIdleTime(5 * time.Minute)
	return database, nil
}

func healthHandler(readiness func(context.Context) bool) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			writer.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
		defer cancel()
		status := http.StatusOK
		if readiness == nil || !readiness(ctx) {
			status = http.StatusServiceUnavailable
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("Cache-Control", "no-store")
		writer.WriteHeader(status)
		if request.Method != http.MethodHead {
			if status == http.StatusOK {
				_, _ = writer.Write([]byte(`{"status":"ok"}`))
			} else {
				_, _ = writer.Write([]byte(`{"status":"unavailable"}`))
			}
		}
	})
}

func metricsHandler(
	token []byte,
	metrics *serviceMetrics,
	readiness func(context.Context) bool,
	operations localOperationsMetrics,
) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || !bearerMatches(request.Header, token) {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		writer.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
		defer cancel()
		ready := "0"
		if readiness != nil && readiness(ctx) {
			ready = "1"
		}
		lines := []string{
			"# HELP local_operator_ready Whether the database and persistent sink file handles are available.",
			"# TYPE local_operator_ready gauge",
			"local_operator_ready " + ready,
			"# TYPE local_operator_requests_total counter",
			"local_operator_requests_total " + strconv.FormatUint(metrics.requests.Load(), 10),
			"# TYPE local_operator_failures_total counter",
			"local_operator_failures_total " + strconv.FormatUint(metrics.failures.Load(), 10),
			"local_operator_auth_failures_total " + strconv.FormatUint(metrics.authFailures.Load(), 10),
			"local_operator_wallet_applies_total " + strconv.FormatUint(metrics.walletApplies.Load(), 10),
			"local_operator_wallet_lookups_total " + strconv.FormatUint(metrics.walletLookups.Load(), 10),
			"local_operator_wallet_rollbacks_total " + strconv.FormatUint(metrics.walletRollbacks.Load(), 10),
			"local_operator_launches_total " + strconv.FormatUint(metrics.launches.Load(), 10),
			"local_operator_audit_accepted_total " + strconv.FormatUint(metrics.auditAccepted.Load(), 10),
			"local_operator_log_batches_total " + strconv.FormatUint(metrics.logBatches.Load(), 10),
			"local_operator_alert_accepted_total " + strconv.FormatUint(metrics.alertAccepted.Load(), 10),
			"local_operator_alert_rejected_total " + strconv.FormatUint(metrics.alertRejected.Load(), 10),
			"local_operator_active_requests " + strconv.FormatInt(metrics.active.Load(), 10),
		}
		lines = append(lines, operations.PrometheusLines()...)
		_, _ = io.WriteString(writer, strings.Join(lines, "\n")+"\n")
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

// Unwrap 让 http.ResponseController 在访问 Flush、Hijack 或 deadline 能力时继续
// 检查底层 writer；中间件只观测状态，不能截断标准可选接口。
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// FlushError 在底层执行刷新路径后记录已隐式提交的 200，即使网络刷新失败；
// ErrNotSupported 没有提交响应，不能提前锁死后续 handler 仍可提交的错误状态。
func (r *statusRecorder) FlushError() error {
	err := http.NewResponseController(r.ResponseWriter).Flush()
	if !errors.Is(err, http.ErrNotSupported) && r.status == 0 {
		r.status = http.StatusOK
	}
	return err
}

func (r *statusRecorder) WriteHeader(status int) {
	// 103 等临时响应可以在最终状态前重复发送；101 协议切换本身是最终提交。
	if status >= 100 && status < 200 && status != http.StatusSwitchingProtocols {
		if r.status == 0 {
			r.ResponseWriter.WriteHeader(status)
		}
		return
	}
	if r.status != 0 {
		return
	}
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(encoded []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.ResponseWriter.Write(encoded)
}

func requestMiddleware(logger *slog.Logger, metrics *serviceMetrics, timeout time.Duration, next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		started := time.Now()
		method := normalizedLocalOperatorMethod(request.Method)
		route := normalizedLocalOperatorRoute(request.URL.Path)
		metrics.requests.Add(1)
		metrics.active.Add(1)
		defer metrics.active.Add(-1)
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("Referrer-Policy", "no-referrer")
		writer.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		writer.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		writer.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		ctx, cancel := context.WithTimeout(request.Context(), timeout)
		defer cancel()
		recorder := &statusRecorder{ResponseWriter: writer}
		defer func() {
			if recover() != nil {
				if recorder.status == 0 {
					recorder.WriteHeader(http.StatusInternalServerError)
				}
			}
			status := recorder.status
			if status == 0 {
				status = http.StatusOK
			}
			if status >= http.StatusBadRequest {
				metrics.failures.Add(1)
			}
			// Vector 会把 stdout 再投递到 /logs；成功日志接收本身禁止产生日志，避免反馈环。
			if route != "/logs" || status >= http.StatusBadRequest {
				logger.Info("http request", "method", method, "route", route,
					"status", status, "duration_ms", time.Since(started).Milliseconds())
			}
		}()
		next.ServeHTTP(recorder, request.WithContext(ctx))
	})
}

func normalizedLocalOperatorMethod(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost:
		return method
	default:
		return "other"
	}
}

func normalizedLocalOperatorRoute(path string) string {
	switch path {
	case "/",
		"/launch",
		"/api/v1/launches",
		"/rgs/wallet/v1/rounds/apply",
		"/rgs/wallet/v1/transactions/status",
		"/rgs/wallet/v1/transactions/rollback",
		"/audit",
		"/logs",
		"/alerts",
		"/healthz",
		"/metrics",
		"/internal/auth/alertmanager":
		return path
	default:
		return "other"
	}
}

func (runtime *loadedRuntime) clearSecrets() {
	clear(runtime.AdminToken)
	clear(runtime.MetricsToken)
	clear(runtime.AlertmanagerToken)
	clear(runtime.AuditHMACKey)
	clear(runtime.AuditBearerToken)
	clear(runtime.LogBearerToken)
	clear(runtime.Keys.WalletResponseSigningKey.PrivateKey)
	clear(runtime.Keys.LaunchRequestSigningKey.PrivateKey)
}
