package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"

	"slots-game/server/internal/application"
	"slots-game/server/internal/bootstrap"
	"slots-game/server/internal/game"
	"slots-game/server/internal/launch"
	"slots-game/server/internal/operator"
	"slots-game/server/internal/platform"
	"slots-game/server/internal/postgres"
	"slots-game/server/internal/recovery"
	"slots-game/server/internal/rgs"
	"slots-game/server/internal/rgsapi"
	"slots-game/server/internal/rng"
	"slots-game/server/internal/safelog"
	"slots-game/server/internal/sharedadmission"
	"slots-game/server/internal/telemetry"
	"slots-game/server/internal/wallet"
)

const (
	accessLogMaxInFlight          = 4
	successAccessLogRatePerSecond = 100
	successAccessLogBurst         = 200
	failureAccessLogRatePerSecond = 20
	failureAccessLogBurst         = 100
)

func traceServiceName(role platform.RuntimeRole) string {
	switch role {
	case platform.RuntimeRoleAPI:
		return telemetry.ServiceNameAPI
	case platform.RuntimeRoleWorker:
		return telemetry.ServiceNameWorker
	default:
		return telemetry.ServiceNameCombined
	}
}

func traceEnvironment(environment platform.Environment) string {
	if environment == platform.Production {
		return telemetry.EnvironmentProd
	}
	// 资源属性刻意只保留 production/development 两个低基数值；当前 staging
	// 运行策略归入非生产，而不是透传任意部署字符串。
	return telemetry.EnvironmentDev
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(logger); err != nil {
		logRuntimeFailure(logger, err)
		os.Exit(1)
	}
}

func logRuntimeFailure(logger *slog.Logger, err error) {
	if logger != nil {
		// 启动错误可能嵌套 DSN、密钥路径、代理地址或证书名；不直接写入长期日志。
		logger.Error("rgs server stopped", "error_class", safelog.ErrorClass(err))
	}
}

type startupReadinessChecker interface {
	Check(context.Context) error
}

func checkSharedAdmissionStartup(ctx context.Context, checker startupReadinessChecker) error {
	if checker == nil {
		return errors.New("shared admission startup checker is required")
	}
	if err := checker.Check(ctx); err != nil {
		return fmt.Errorf("shared admission startup readiness: %w", err)
	}
	return nil
}

func withRecoveryStartupReadiness(
	role platform.RuntimeRole,
	checks []platform.DependencyCheck,
) ([]platform.DependencyCheck, *recovery.StartupReadiness) {
	// combined 角色同时服务客户端 API；不能用后台恢复首轮改变 API
	// readyz。生产拆分的 worker 才使用这个一次性启动门。
	if role != platform.RuntimeRoleWorker {
		return checks, nil
	}
	readiness := recovery.NewStartupReadiness()
	return append(checks, readiness), readiness
}

func run(logger *slog.Logger) error {
	config, err := platform.LoadConfig()
	if err != nil {
		return fmt.Errorf("load runtime config: %w", err)
	}
	if config.DatabaseURL == "" || config.OperatorConfigFile == "" ||
		config.DefinitionFile == "" || config.DefinitionApprovalFile == "" ||
		config.DefinitionApprovalPublicKeyFile == "" {
		return errors.New("rgs-server requires database, definition, trust, and operator configuration in every environment")
	}
	if config.RuntimeRole.ServesPublicAPI() && config.LaunchHMACKeyFile == "" {
		return errors.New("rgs-server API role requires launch-key configuration")
	}
	database, err := openRuntimeDatabase(
		config.DatabaseURL,
		config.DatabaseStatementTimeout,
		config.DatabaseLockTimeout,
	)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer database.Close()
	database.SetMaxOpenConns(config.DatabaseMaxOpenConns)
	database.SetMaxIdleConns(config.DatabaseMaxIdleConns)
	database.SetConnMaxIdleTime(5 * time.Minute)
	database.SetConnMaxLifetime(30 * time.Minute)
	startupContext, startupCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer startupCancel()
	if err := database.PingContext(startupContext); err != nil {
		return fmt.Errorf("connect database: %w", err)
	}
	databaseReadiness, err := runtimeDatabaseReadinessChecks(database)
	if err != nil {
		return err
	}
	for _, check := range databaseReadiness {
		if err := check.Check(startupContext); err != nil {
			return fmt.Errorf("runtime database readiness %s: %w", check.Name(), err)
		}
	}

	definition, definitionHash, err := bootstrap.LoadDefinition(
		config.DefinitionFile,
		config.DefinitionApprovalFile,
		config.DefinitionApprovalPublicKeyFile,
		definitionLoadOptions(config.Environment)...,
	)
	if err != nil {
		return err
	}
	if err := validateLoadedDefinitionIdentity(config, definition, definitionHash); err != nil {
		return err
	}
	operatorOptions := make([]bootstrap.OperatorLoadOption, 0, 1)
	if config.Environment == platform.Development {
		operatorOptions = append(operatorOptions, bootstrap.AllowInsecureWalletHTTPForDevelopment())
	}
	if config.Environment == platform.Production {
		operatorOptions = append(operatorOptions, bootstrap.RequirePerOperatorAccessTokenKeys())
	}
	if config.RuntimeRole == platform.RuntimeRoleWorker {
		operatorOptions = append(operatorOptions, bootstrap.LoadWalletMaterialOnlyForWorker())
	}
	operators, err := bootstrap.LoadOperatorDocument(
		config.OperatorConfigFile,
		config.AccessPrivateKeyFile,
		config.AccessPublicKeyFile,
		operatorOptions...,
	)
	if err != nil {
		return err
	}
	if err := validateKeyReadinessForRole(operators, time.Now().UTC(), config.AccessTokenTTL, config.RuntimeRole); err != nil {
		return err
	}
	var launchHMACKey []byte
	if config.RuntimeRole.ServesPublicAPI() {
		launchHMACKey, err = bootstrap.LoadLaunchHMACKey(config.LaunchHMACKeyFile)
		if err != nil {
			return err
		}
		defer clear(launchHMACKey)
	}

	random := rng.NewCryptoSource()
	if _, err := random.Intn(2); err != nil {
		return fmt.Errorf("initialize cryptographic random source: %w", err)
	}
	engine, err := game.NewEngine(definition, random)
	if err != nil {
		return err
	}
	definitions, err := rgs.NewMemoryDefinitionRegistry(rgs.DefinitionEntry{
		GameID: definition.GameID, Version: definition.DefinitionVersion,
		SHA256: definitionHash, Spinner: engine,
	})
	if err != nil {
		return err
	}

	metrics := &platform.Metrics{}
	metrics.SetDatabasePool(database)
	traceRuntime, traceErr := telemetry.New(startupContext, telemetry.Config{
		Endpoint:           config.TraceEndpoint,
		ServiceName:        traceServiceName(config.RuntimeRole),
		Environment:        traceEnvironment(config.Environment),
		SampleRatio:        config.TraceSampleRatio,
		BatchTimeout:       config.TraceBatchTimeout,
		ExportTimeout:      config.TraceExportTimeout,
		MaxQueueSize:       config.TraceMaxQueueSize,
		MaxExportBatchSize: config.TraceMaxExportBatchSize,
		Observer:           metrics,
	})
	if traceErr != nil {
		// 已通过配置语法校验但 exporter 初始化失败时，追踪失败开放；资金
		// 正确性与服务启动不依赖遥测后端，日志只保留固定错误类别。
		if logger != nil {
			logger.Warn("distributed tracing disabled", "error_class", safelog.ErrorClass(traceErr))
		}
		traceRuntime = telemetry.NewWithProvider(nil)
	}
	defer func() {
		shutdownContext, cancel := context.WithTimeout(context.Background(), config.TraceShutdownTimeout)
		defer cancel()
		if shutdownErr := traceRuntime.Shutdown(shutdownContext); shutdownErr != nil && logger != nil {
			logger.Warn("distributed tracing shutdown failed", "error_class", safelog.ErrorClass(shutdownErr))
		}
	}()
	cryptographicCapacity := newServerCryptographicCapacity(
		config.MaxCryptoInFlight,
		metrics,
	)
	var sharedLimiter *sharedadmission.Limiter
	if config.SharedAdmissionURL != "" {
		sharedLimiter, err = sharedadmission.New(sharedadmission.Config{
			URL:          config.SharedAdmissionURL,
			Username:     config.SharedAdmissionUsername,
			PasswordFile: config.SharedAdmissionPasswordFile,
			HMACKeyFile:  config.SharedAdmissionHMACKeyFile,
			RootCAFile:   config.SharedAdmissionRootCAFile,
			Timeout:      config.SharedAdmissionTimeout,
			Rate:         config.SharedAdmissionRatePerSecond,
			Burst:        config.SharedAdmissionRateBurst,
		}, metrics)
		if err != nil {
			return fmt.Errorf("configure shared admission: %w", err)
		}
		defer sharedLimiter.Close()
		if err := checkSharedAdmissionStartup(startupContext, sharedLimiter); err != nil {
			return err
		}
	}
	riskPolicy := rgs.HighValueRiskPolicy{}
	if config.HighValueRiskEnabled {
		riskPolicy = rgs.HighValueRiskPolicy{
			Enabled: true, ThresholdMinor: config.HighValueRiskThresholdMinor,
			PolicyVersion: config.HighValueRiskPolicyVersion,
			ReviewTTL:     config.HighValueRiskReviewTTL,
			ExpiryPolicy:  rgs.RiskExpiryPolicy(config.HighValueRiskExpiryPolicy),
		}
	}
	repository, err := postgres.NewRepositoryWithOptions(database, postgres.RepositoryOptions{
		IntegrityObserver: metrics,
		RiskPolicy:        riskPolicy,
	})
	if err != nil {
		return err
	}
	nonceStore, err := postgres.NewNonceStore(database)
	if err != nil {
		return err
	}
	launchStore, err := postgres.NewLaunchStore(database)
	if err != nil {
		return err
	}

	keyRing, err := operator.NewMemoryKeyRing(operators.VerificationKeys...)
	if err != nil {
		return err
	}
	walletResponseVerifier, err := operator.NewResponseVerifier(
		keyRing,
		operator.RequestVerifierOptions{
			ClockSkew:   operator.DefaultSignatureClockSkew,
			MaxLifetime: operator.DefaultSignatureLifetime,
		},
	)
	if err != nil {
		return err
	}

	walletPorts := make(map[string]rgs.WalletPort, len(operators.Operators))
	economicRoutes := make([]sharedadmission.EconomicRoute, 0, len(operators.Operators))
	baseWalletClient, err := wallet.SecureHTTPClient(config.WalletTimeout, config.WalletRootCAFile)
	if err != nil {
		return fmt.Errorf("construct wallet HTTP client: %w", err)
	}
	walletIsolation, err := wallet.NewIsolationRegistry(wallet.DefaultIsolationConfig(), metrics)
	if err != nil {
		return fmt.Errorf("construct wallet isolation: %w", err)
	}
	for operatorID, loaded := range operators.Operators {
		backendIdentity, identityErr := wallet.CanonicalBackendIdentity(loaded.Wallet.BaseURL)
		if identityErr != nil {
			return fmt.Errorf("derive economic wallet route for %s: %w", operatorID, identityErr)
		}
		economicRoutes = append(economicRoutes, sharedadmission.EconomicRoute{
			OperatorID: operatorID,
			BackendID:  backendIdentity,
		})
		port, err := wallet.NewHTTPWallet(wallet.HTTPConfig{
			BaseURL: loaded.Wallet.BaseURL, OperatorID: operatorID,
			RequestSigningKey: loaded.Wallet.RequestSigningKey,
			ResponseVerifier:  walletResponseVerifier, Client: baseWalletClient,
			AllowInsecureDevelopment: config.Environment == platform.Development,
		})
		if err != nil {
			return fmt.Errorf("construct wallet adapter for %s: %w", operatorID, err)
		}
		observedPort, err := rgs.NewObservedWallet(port, metrics)
		if err != nil {
			return fmt.Errorf("instrument wallet adapter for %s: %w", operatorID, err)
		}
		isolatedPort, err := walletIsolation.Wrap(loaded.Wallet.BaseURL, operatorID, observedPort)
		if err != nil {
			return fmt.Errorf("isolate wallet adapter for %s: %w", operatorID, err)
		}
		walletPorts[operatorID] = isolatedPort
	}
	var economicAdmission rgs.EconomicIntentAdmitter
	if sharedLimiter != nil {
		configuredEconomicAdmission, economicErr := sharedadmission.NewEconomicAdmission(
			sharedLimiter,
			economicRoutes,
			sharedadmission.EconomicConfig{
				Operator: sharedadmission.EconomicPolicy{
					RatePerSecond: config.EconomicOperatorRatePerSecond,
					Burst:         config.EconomicOperatorRateBurst,
				},
				Backend: sharedadmission.EconomicPolicy{
					RatePerSecond: config.EconomicBackendRatePerSecond,
					Burst:         config.EconomicBackendRateBurst,
				},
			},
			metrics,
		)
		if economicErr != nil {
			return fmt.Errorf("configure economic admission: %w", economicErr)
		}
		if economicErr = configuredEconomicAdmission.Check(startupContext); economicErr != nil {
			return fmt.Errorf("verify economic admission command contract: %w", economicErr)
		}
		economicAdmission = configuredEconomicAdmission
	}
	walletRouter, err := wallet.NewRouter(walletPorts)
	if err != nil {
		return err
	}
	coordinator, err := rgs.NewCoordinator(rgs.CoordinatorConfig{
		WalletLease:           config.WalletTimeout + time.Second,
		WalletFastPathTimeout: config.WalletFastPathTimeout,
		PendingWait:           time.Second, PollInterval: 20 * time.Millisecond,
		MaxWalletAttempts:       config.WalletMaxAttempts,
		EconomicIntentAdmission: economicAdmission,
	}, repository, walletRouter, definitions, metrics)
	if err != nil {
		return err
	}
	auditRuntime, err := configureOutboxRuntime(config, database, logger, metrics)
	if err != nil {
		return fmt.Errorf("configure outbox delivery: %w", err)
	}
	defer auditRuntime.Close()

	apiHandler := http.NotFoundHandler()
	if config.RuntimeRole.ServesPublicAPI() {
		newIntentCapacity, capacityErr := newDatabaseIntentCapacity(
			database,
			config.DatabaseMaxOpenConns,
			config.DatabaseCriticalReserveConns,
			metrics,
		)
		if capacityErr != nil {
			return fmt.Errorf("configure database intent capacity: %w", capacityErr)
		}
		apiHandler, err = newRGSAPIHandler(
			config,
			logger,
			metrics,
			operators,
			nonceStore,
			launchStore,
			launchHMACKey,
			definition.GameID,
			definition.DefinitionVersion,
			definitionHash,
			repository,
			coordinator,
			sharedLimiter,
			newIntentCapacity,
			cryptographicCapacity,
		)
		if err != nil {
			return err
		}
	}

	allowedOrigins := make(map[string]struct{}, len(config.AllowedOrigins))
	for _, origin := range config.AllowedOrigins {
		allowedOrigins[origin] = struct{}{}
	}
	clientHandler := platform.Middleware{
		MaxRequestBytes: config.MaxRequestBytes, AllowedOrigins: allowedOrigins,
	}.Wrap(apiHandler)
	lifecycleReadiness := &platform.LifecycleReadiness{}
	readinessChecks := []platform.DependencyCheck{
		lifecycleReadiness,
		repository,
	}
	readinessChecks, recoveryStartupReadiness := withRecoveryStartupReadiness(
		config.RuntimeRole,
		readinessChecks,
	)
	readinessChecks = append(readinessChecks, databaseReadiness...)
	readinessChecks = append(
		readinessChecks,
		keyReadinessCheck{
			operators: operators,
			accessTTL: config.AccessTokenTTL,
			role:      config.RuntimeRole,
		},
	)
	if config.RuntimeRole.RunsBackgroundWorkloads() && auditRuntime.Enabled() {
		readinessChecks = append(readinessChecks, auditRuntime)
	}
	operationsBearerToken, err := loadOperationsBearerToken(config.OperationsBearerTokenFile)
	if err != nil {
		return err
	}
	defer clear(operationsBearerToken)
	publicHandler := newPublicInFlightGate(
		config.MaxInFlightRequests,
		platform.NewLimiter(
			config.PreAuthRatePerSecond,
			config.PreAuthRateBurst,
			1,
			time.Minute,
		),
		metrics,
		newPublicHandler(apiHandler, clientHandler),
		allowedOrigins,
	)
	operationsHandler := newOperationsHandler(readinessChecks, metrics, operationsBearerToken)

	ctx, stop := context.WithCancel(traceRuntime.Context(context.Background()))
	defer stop()
	shutdownSignals := make(chan os.Signal, 1)
	signal.Notify(shutdownSignals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(shutdownSignals)
	var recoveryWorker *recovery.Worker
	if config.RuntimeRole.RunsBackgroundWorkloads() {
		recoveryWorker, err = recovery.New(recovery.Config{
			Interval: 2 * time.Second, StaleAfter: time.Second,
			AttemptTimeout: config.WalletTimeout + 2*time.Second,
			BatchSize:      100, MaxParallel: 8, StartupReadiness: recoveryStartupReadiness,
			RiskExpiryBatchSize: config.HighValueRiskExpiryBatchSize,
		}, repository, coordinator, logger, metrics)
		if err != nil {
			return err
		}
		if err := auditRuntime.Start(ctx); err != nil {
			return fmt.Errorf("start outbox delivery: %w", err)
		}
	}
	backgroundDone := make(chan struct{})
	var background sync.WaitGroup
	if config.RuntimeRole.RunsBackgroundWorkloads() {
		background.Add(2)
		go func() {
			defer background.Done()
			recoveryWorker.Run(ctx)
		}()
		go func() {
			defer background.Done()
			runSecurityMaintenance(ctx, logger, nonceStore, launchStore)
		}()
	}
	go func() {
		background.Wait()
		close(backgroundDone)
	}()

	tracedPublicHandler := publicHandler
	if config.RuntimeRole.ServesPublicAPI() {
		tracedPublicHandler = traceRuntime.WrapPublicHTTP(publicHandler, normalizedPublicRoute)
	}
	publicServer := newHTTPServer(
		config.HTTPAddress,
		observeRequests(
			logger,
			metrics,
			config.SuccessAccessLogSamplePerMillion,
			withRequestTimeout(config.RequestTimeout, tracedPublicHandler),
		),
		config,
	)
	if config.RuntimeRole.ServesPublicAPI() {
		metrics.HTTPConnectionLimit.Store(int64(config.MaxConnectionsPerListener))
		publicServer.ConnState = func(_ net.Conn, state http.ConnState) {
			observePublicConnectionState(metrics, state)
		}
	}
	operationsServer := newHTTPServer(config.OperationsHTTPAddress, operationsHandler, config)
	var publicListener net.Listener
	if config.RuntimeRole.ServesPublicAPI() {
		publicListener, err = openBoundedListener(config.HTTPAddress, config.MaxConnectionsPerListener)
		if err != nil {
			return fmt.Errorf("listen on public RGS address: %w", err)
		}
		defer publicListener.Close()
	}
	operationsListener, err := openBoundedListener(config.OperationsHTTPAddress, config.MaxConnectionsPerListener)
	if err != nil {
		return fmt.Errorf("listen on operations RGS address: %w", err)
	}
	defer operationsListener.Close()
	serverCount := 1
	if config.RuntimeRole.ServesPublicAPI() {
		serverCount++
	}
	serverErrors := make(chan error, serverCount)
	serversDone := make(chan struct{})
	var servers sync.WaitGroup
	servers.Add(serverCount)
	if config.RuntimeRole.ServesPublicAPI() {
		go func() {
			defer servers.Done()
			logger.Info(
				"public RGS listener started",
				"address", config.HTTPAddress,
				"environment", config.Environment,
				"runtime_role", config.RuntimeRole,
				"game_id", definition.GameID,
				"definition_version", definition.DefinitionVersion,
				"definition_hash", definitionHash,
				"operators", len(operators.Operators),
				"outbox_delivery_enabled", auditRuntime.Enabled(),
				"tracing_enabled", traceRuntime.Enabled(),
				"connection_limit", config.MaxConnectionsPerListener,
			)
			if config.TLSCertFile != "" {
				serverErrors <- publicServer.ServeTLS(publicListener, config.TLSCertFile, config.TLSKeyFile)
				return
			}
			serverErrors <- publicServer.Serve(publicListener)
		}()
	}
	go func() {
		defer servers.Done()
		logger.Info(
			"operations RGS listener started",
			"address", config.OperationsHTTPAddress,
			"runtime_role", config.RuntimeRole,
			"outbox_delivery_enabled", auditRuntime.Enabled(),
			"connection_limit", config.MaxConnectionsPerListener,
		)
		serverErrors <- operationsServer.Serve(operationsListener)
	}()
	go func() {
		servers.Wait()
		close(serversDone)
	}()

	select {
	case err := <-serverErrors:
		shutdownContext, cancel := context.WithTimeout(context.Background(), config.ShutdownTimeout)
		defer cancel()
		shutdownErr := drainAndShutdownHTTPServers(
			shutdownContext, lifecycleReadiness, stop,
			roleHTTPServers(config.RuntimeRole, publicServer, operationsServer)...,
		)
		workerErr := errors.Join(
			auditRuntime.Wait(shutdownContext),
			waitForBackground(shutdownContext, backgroundDone),
		)
		serveErrors := append(
			[]error{err},
			waitForServers(shutdownContext, serversDone, serverErrors, serverCount-1)...,
		)
		return errors.Join(normalizeServerErrors(serveErrors...), shutdownErr, workerErr)
	case <-shutdownSignals:
		shutdownContext, cancel := context.WithTimeout(context.Background(), config.ShutdownTimeout)
		defer cancel()
		shutdownErr := drainAndShutdownHTTPServers(
			shutdownContext, lifecycleReadiness, stop,
			roleHTTPServers(config.RuntimeRole, publicServer, operationsServer)...,
		)
		workerErr := errors.Join(
			auditRuntime.Wait(shutdownContext),
			waitForBackground(shutdownContext, backgroundDone),
		)
		return errors.Join(
			shutdownErr,
			workerErr,
			normalizeServerErrors(waitForServers(shutdownContext, serversDone, serverErrors, serverCount)...),
		)
	}
}

func newRGSAPIHandler(
	config platform.Config,
	logger *slog.Logger,
	metrics *platform.Metrics,
	operators bootstrap.LoadedOperators,
	nonceStore *postgres.NonceStore,
	launchStore *postgres.LaunchStore,
	launchHMACKey []byte,
	gameID string,
	definitionVersion string,
	definitionHash string,
	repository *postgres.Repository,
	coordinator *rgs.Coordinator,
	launchAdmission rgsapi.Admission,
	newIntentCapacity rgsapi.NewIntentCapacity,
	cryptographicCapacity rgsapi.CryptographicCapacity,
) (http.Handler, error) {
	launchService, err := launch.NewService(launchStore, launch.Options{TTL: config.LaunchTTL})
	if err != nil {
		return nil, err
	}
	keyRing, err := operator.NewMemoryKeyRing(operators.VerificationKeys...)
	if err != nil {
		return nil, err
	}
	requestVerifier, err := operator.NewRequestVerifier(
		keyRing,
		nonceStore,
		operator.RequestVerifierOptions{
			ClockSkew:   operator.DefaultSignatureClockSkew,
			MaxLifetime: operator.DefaultSignatureLifetime,
		},
	)
	if err != nil {
		return nil, err
	}
	accessVerifier, err := operator.NewAccessTokenVerifier(
		keyRing,
		operator.AccessTokenVerifierOptions{
			ExpectedIssuer:   operators.TokenIssuer,
			ExpectedAudience: operators.TokenAudience,
			ClockSkew:        operator.DefaultSignatureClockSkew,
			MaxLifetime:      config.AccessTokenTTL,
		},
	)
	if err != nil {
		return nil, err
	}
	accessIssuers := make(map[string]*operator.AccessTokenIssuer, len(operators.Operators))
	for operatorID, loaded := range operators.Operators {
		issuer, issuerErr := operator.NewAccessTokenIssuer(
			loaded.AccessTokenSigningKey,
			operator.AccessTokenIssuerOptions{
				Issuer: operators.TokenIssuer, Audience: operators.TokenAudience,
				MaxLifetime: config.AccessTokenTTL,
			},
		)
		if issuerErr != nil {
			return nil, fmt.Errorf("construct access issuer for %s: %w", operatorID, issuerErr)
		}
		accessIssuers[operatorID] = issuer
	}
	launchManager, err := application.NewLaunchManager(application.LaunchManagerConfig{
		PublicBaseURL: config.PublicBaseURL, LaunchHMACKey: launchHMACKey,
		AccessTokenTTL: config.AccessTokenTTL, GameID: gameID,
		IdleDisconnectMin: config.SessionIdleDisconnectMin,
		IdleDisconnectMax: config.SessionIdleDisconnectMax,
		DefinitionVersion: definitionVersion, DefinitionHash: definitionHash,
	}, repository, launchService, accessIssuers)
	if err != nil {
		return nil, err
	}
	responseKeys := rgsapi.ResponseSigningKeyResolverFunc(func(ctx context.Context, operatorID string) (operator.SigningKey, error) {
		if err := ctx.Err(); err != nil {
			return operator.SigningKey{}, err
		}
		loaded, exists := operators.Operators[operatorID]
		if !exists {
			return operator.SigningKey{}, errors.New("operator response key not found")
		}
		return loaded.OperatorResponseSigningKey, nil
	})
	localOperatorLimiter := newKnownOperatorAdmission(
		operators,
		platform.NewLimiter(config.RatePerSecond, config.RateBurst, 100_000, 10*time.Minute),
	)
	localClientLimiter := localLimiterAdmission{limiter: platform.NewLimiter(
		config.RatePerSecond,
		config.RateBurst,
		100_000,
		10*time.Minute,
	)}
	handlerConfig := rgsapi.Config{
		OperatorRequests: requestVerifier, AccessTokens: accessVerifier,
		ResponseSigningKeys: responseKeys, Launches: launchManager,
		Spins: coordinator, Rounds: coordinator, Admission: localOperatorLimiter,
		ClientAdmission:       localClientLimiter,
		CryptographicCapacity: cryptographicCapacity,
		NewIntentCapacity:     newIntentCapacity,
		SecurityEvents:        newSecurityEventObserver(logger, metrics),
		MaxRequestBytes:       config.MaxRequestBytes, ResponseSignatureTTL: time.Minute,
	}
	if config.HighValueRiskEnabled {
		handlerConfig.RiskDecisions = repository
	}
	return rgsapi.NewHandler(withSharedAdmissions(handlerConfig, launchAdmission))
}

// withSharedAdmissions 把普通 operator 高水位同时组装到 launch 和所有
// Spin 尝试（包括重放/冲突）。经济预算仍只在 Coordinator 的首次
// 可持久化 round 边界调用，不得用它替换这两个普通高水位。
func withSharedAdmissions(config rgsapi.Config, admission rgsapi.Admission) rgsapi.Config {
	config.LaunchAdmission = admission
	config.SpinAdmission = admission
	return config
}

func validateLoadedDefinitionIdentity(config platform.Config, definition game.Config, definitionHash string) error {
	if config.ExpectedDefinitionGameID == "" && config.ExpectedDefinitionVersion == "" &&
		config.ExpectedDefinitionSHA256 == "" {
		return nil
	}
	if definition.GameID != config.ExpectedDefinitionGameID ||
		definition.DefinitionVersion != config.ExpectedDefinitionVersion ||
		definitionHash != config.ExpectedDefinitionSHA256 {
		return errors.New("loaded definition identity does not match the release contract")
	}
	return nil
}

func roleHTTPServers(
	role platform.RuntimeRole,
	publicServer httpServerShutdowner,
	operationsServer httpServerShutdowner,
) []httpServerShutdowner {
	if role.ServesPublicAPI() {
		return []httpServerShutdowner{publicServer, operationsServer}
	}
	return []httpServerShutdowner{operationsServer}
}

func newPublicHandler(apiHandler, clientHandler http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request == nil || request.URL == nil {
			http.NotFound(writer, request)
			return
		}
		// 不使用 ServeMux：它会在 API 验证前清理 ../、重复斜线并重定向，既改变
		// 签名路径语义，也会在重定向短路时遗留未读正文。
		switch {
		case strings.HasPrefix(request.URL.Path, "/operator/") && apiHandler != nil:
			apiHandler.ServeHTTP(writer, request)
		case strings.HasPrefix(request.URL.Path, "/client/") && clientHandler != nil:
			clientHandler.ServeHTTP(writer, request)
		default:
			closePublicUnreadBody(request)
			http.NotFound(writer, request)
		}
	})
}

func newPublicInFlightGate(
	limit int,
	preAuthLimiter *platform.Limiter,
	metrics *platform.Metrics,
	next http.Handler,
	allowedOrigins ...map[string]struct{},
) http.Handler {
	capacity := newBoundedCapacity(limit)
	var browserOrigins map[string]struct{}
	if len(allowedOrigins) > 0 {
		browserOrigins = allowedOrigins[0]
	}
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		// 该高水位桶是 WAF/网关失效时的最后一道常数内存保护。未认证阶段不存在
		// 可信客户端 IP、租户身份或恢复状态，因此所有公网请求只共享一个固定键。
		// 路由 path 可由攻击者伪造，绝不能据此绕过匿名容量或取得恢复优先级。
		if preAuthLimiter != nil && !preAuthLimiter.Allow("public-preauth", time.Now()) {
			if metrics != nil {
				metrics.PreAuthCapacityRejected.Add(1)
			}
			writePublicCapacityUnavailable(writer, request, browserOrigins)
			return
		}
		// 这是调用方无关的进程级硬容量闸门，位于签名/令牌解析及数据库访问之前。
		// 绝不使用 X-Forwarded-For 等未验证身份。公网监听器不暴露 liveness；
		// ALB/Kubernetes 只能通过受限 operations 监听器探测，避免制造匿名旁路。
		if release := capacity.TryAcquire(); release != nil {
			defer release()
			next.ServeHTTP(writer, request)
		} else {
			// 每次满载拒绝只在唯一决策点累计一次；外层 observeRequests 观测逻辑仍独立计入
			// 普通请求、总失败和 5xx，绝不把容量耗尽伪装成速率限流。
			if metrics != nil {
				metrics.CapacityRejected.Add(1)
			}
			writePublicCapacityUnavailable(writer, request, browserOrigins)
		}
	})
}

func writePublicCapacityUnavailable(
	writer http.ResponseWriter,
	request *http.Request,
	allowedOrigins map[string]struct{},
) {
	requestID := "unavailable"
	if request != nil {
		closePublicUnreadBody(request)
		if candidate := safeLogRequestID(request.Header.Get(operator.HeaderRequestID)); candidate != "" {
			requestID = candidate
		}
		if request.URL != nil && strings.HasPrefix(request.URL.Path, "/client/") {
			platform.ApplyCORSHeaders(writer, request, allowedOrigins)
		}
	}
	writer.Header().Set(operator.HeaderRequestID, requestID)
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Retry-After", "1")
	writer.WriteHeader(http.StatusServiceUnavailable)
	_, _ = fmt.Fprintf(
		writer,
		`{"error":{"code":"CAPACITY_UNAVAILABLE","message":"service unavailable"},"requestId":"%s"}`+"\n",
		requestID,
	)
}

func closePublicUnreadBody(request *http.Request) {
	if request != nil && request.Body != nil && request.Body != http.NoBody {
		// 短路发生在 handler 读取正文之前；关闭 HTTP/1 连接，避免服务器为
		// keep-alive 排空攻击者正文。HTTP/2 仍由流级取消和读取截止时间约束。
		request.Close = true
	}
}

func newOperationsHandler(
	checks []platform.DependencyCheck,
	metrics *platform.Metrics,
	bearerToken []byte,
) http.Handler {
	mux := http.NewServeMux()
	readiness := platform.Readiness{Checks: checks, Timeout: 2 * time.Second}
	mux.HandleFunc("/healthz", platform.LivenessHandler)
	mux.Handle("/readyz", protectOperationsEndpoint(
		bearerToken,
		metrics,
		readiness,
	))
	mux.Handle("/metrics", protectOperationsEndpoint(
		bearerToken,
		metrics,
		platform.MetricsEndpoint{Metrics: metrics, Readiness: readiness},
	))
	return mux
}

const maximumOperationsBearerTokenBytes int64 = 4 << 10

func loadOperationsBearerToken(path string) ([]byte, error) {
	if path == "" {
		return nil, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open operations bearer token: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat operations bearer token: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("operations bearer token must be a regular file")
	}
	if permission := info.Mode().Perm(); permission&0o137 != 0 {
		return nil, fmt.Errorf("operations bearer token permissions %04o are too broad", permission)
	}
	token, err := io.ReadAll(io.LimitReader(file, maximumOperationsBearerTokenBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read operations bearer token: %w", err)
	}
	if int64(len(token)) > maximumOperationsBearerTokenBytes {
		clear(token)
		return nil, fmt.Errorf("operations bearer token exceeds %d bytes", maximumOperationsBearerTokenBytes)
	}
	token = bytes.TrimSuffix(token, []byte("\n"))
	if len(token) < 16 || bytes.ContainsAny(token, " \t\r\n") {
		clear(token)
		return nil, errors.New("operations bearer token must be at least 16 bytes without whitespace")
	}
	return token, nil
}

func protectOperationsEndpoint(
	bearerToken []byte,
	metrics *platform.Metrics,
	next http.Handler,
) http.Handler {
	if len(bearerToken) == 0 {
		return next
	}
	expectedAuthorization := append([]byte("Bearer "), bearerToken...)
	expectedDigest := sha256.Sum256(expectedAuthorization)
	clear(expectedAuthorization)
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		values := request.Header.Values("Authorization")
		provided := ""
		if len(values) == 1 {
			provided = values[0]
		}
		providedDigest := sha256.Sum256([]byte(provided))
		if subtle.ConstantTimeCompare(providedDigest[:], expectedDigest[:]) != 1 {
			// 运维面不经过公网 observeRequests 观测逻辑；认证失败只累积一个低基数计数，且
			// 不回显令牌、端点内部状态或请求头，避免成为可枚举的探测接口。
			if metrics != nil {
				metrics.AuthFailures.Add(1)
			}
			writer.Header().Set("WWW-Authenticate", `Bearer realm="rgs-operations"`)
			writer.Header().Set("Cache-Control", "no-store")
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(writer, request)
	})
}

func newHTTPServer(address string, handler http.Handler, config platform.Config) *http.Server {
	return &http.Server{
		Addr: address, Handler: handler,
		ReadHeaderTimeout: config.ReadHeaderTimeout, ReadTimeout: config.ReadTimeout,
		WriteTimeout: config.WriteTimeout, IdleTimeout: config.IdleTimeout,
		// 16 KiB 是应用最终兜底，不是边缘可直接采用的 aggregate-header Block 证明。
		// 边缘 8 KiB 阈值必须先覆盖最大合法签发令牌、固定协议头及代理附加头的实测。
		MaxHeaderBytes: 16 << 10,
	}
}

func openBoundedListener(address string, maximum int) (net.Listener, error) {
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return nil, err
	}
	limited, err := platform.LimitListener(listener, maximum)
	if err != nil {
		_ = listener.Close()
		return nil, err
	}
	return limited, nil
}

func observePublicConnectionState(metrics *platform.Metrics, state http.ConnState) {
	if metrics == nil {
		return
	}
	switch state {
	case http.StateNew:
		metrics.HTTPActiveConnections.Add(1)
	case http.StateHijacked, http.StateClosed:
		metrics.HTTPActiveConnections.Add(-1)
	}
}

type httpServerShutdowner interface {
	Shutdown(context.Context) error
	Close() error
}

func drainAndShutdownHTTPServers(
	ctx context.Context,
	lifecycle *platform.LifecycleReadiness,
	stopBackground func(),
	servers ...httpServerShutdowner,
) error {
	// 必须先让 /readyz 失败，再取消后台任务并关闭监听器；这样终止探针与负载均衡
	// 不会在请求排空期间把本副本重新加入服务池。
	lifecycle.BeginDrain()
	if stopBackground != nil {
		stopBackground()
	}
	return shutdownHTTPServers(ctx, servers...)
}

func shutdownHTTPServers(ctx context.Context, servers ...httpServerShutdowner) error {
	errorsByServer := make([][]error, len(servers))
	var group sync.WaitGroup
	for index, server := range servers {
		if server == nil {
			continue
		}
		group.Add(1)
		go func(index int, server httpServerShutdowner) {
			defer group.Done()
			if err := server.Shutdown(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errorsByServer[index] = append(
					errorsByServer[index],
					fmt.Errorf("shutdown HTTP server: %w", err),
				)
				if closeErr := server.Close(); closeErr != nil && !errors.Is(closeErr, http.ErrServerClosed) {
					errorsByServer[index] = append(
						errorsByServer[index],
						fmt.Errorf("force-close HTTP server: %w", closeErr),
					)
				}
			}
		}(index, server)
	}
	group.Wait()
	shutdownErrors := make([]error, 0, len(servers)*2)
	for _, serverErrors := range errorsByServer {
		shutdownErrors = append(shutdownErrors, serverErrors...)
	}
	return errors.Join(shutdownErrors...)
}

func waitForServers(
	ctx context.Context,
	done <-chan struct{},
	serverErrors <-chan error,
	count int,
) []error {
	select {
	case <-done:
		errorsSeen := make([]error, 0, count)
		for range count {
			errorsSeen = append(errorsSeen, <-serverErrors)
		}
		return errorsSeen
	case <-ctx.Done():
		return []error{ctx.Err()}
	}
}

func normalizeServerErrors(values ...error) error {
	filtered := make([]error, 0, len(values))
	for _, value := range values {
		if value != nil && !errors.Is(value, http.ErrServerClosed) {
			filtered = append(filtered, value)
		}
	}
	return errors.Join(filtered...)
}

func openRuntimeDatabase(databaseURL string, statementTimeout, lockTimeout time.Duration) (*sql.DB, error) {
	connection, err := runtimeDatabaseConfig(databaseURL, statementTimeout, lockTimeout)
	if err != nil {
		return nil, err
	}
	return stdlib.OpenDB(*connection), nil
}

func runtimeDatabaseConfig(databaseURL string, statementTimeout, lockTimeout time.Duration) (*pgx.ConnConfig, error) {
	if statementTimeout < time.Millisecond || lockTimeout < time.Millisecond ||
		statementTimeout%time.Millisecond != 0 || lockTimeout%time.Millisecond != 0 ||
		lockTimeout > statementTimeout {
		return nil, errors.New("invalid runtime database timeout configuration")
	}
	connection, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse runtime database URL: %w", err)
	}
	if connection.RuntimeParams == nil {
		connection.RuntimeParams = make(map[string]string)
	}
	// RuntimeParams 会作用于每条 database/sql 连接，包括启动探测后才获取的事务连接；
	// 刻意覆盖 URL 中同名值，确保所有连接只服从一套有界运行时超时策略。
	connection.RuntimeParams["statement_timeout"] = postgresTimeoutMilliseconds(statementTimeout)
	connection.RuntimeParams["lock_timeout"] = postgresTimeoutMilliseconds(lockTimeout)
	return connection, nil
}

func postgresTimeoutMilliseconds(timeout time.Duration) string {
	return strconv.FormatInt(timeout.Milliseconds(), 10)
}

func withRequestTimeout(timeout time.Duration, next http.Handler) http.Handler {
	if timeout <= 0 {
		return next
	}
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		ctx, cancel := context.WithTimeout(request.Context(), timeout)
		defer cancel()
		next.ServeHTTP(writer, request.WithContext(ctx))
	})
}

func definitionLoadOptions(environment platform.Environment) []bootstrap.DefinitionLoadOption {
	if environment == platform.Production {
		return []bootstrap.DefinitionLoadOption{bootstrap.RequireProductionDefinitionApproval()}
	}
	return nil
}

func runtimeDatabaseReadinessChecks(database *sql.DB) ([]platform.DependencyCheck, error) {
	schema, err := postgres.NewSchemaCheck(database)
	if err != nil {
		return nil, err
	}
	privileges, err := postgres.NewRuntimePrivilegeCheck(database)
	if err != nil {
		return nil, err
	}
	return []platform.DependencyCheck{schema, privileges}, nil
}

func waitForBackground(ctx context.Context, done <-chan struct{}) error {
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

type knownOperatorAdmission struct {
	known   map[string]struct{}
	limiter *platform.Limiter
}

func newKnownOperatorAdmission(
	operators bootstrap.LoadedOperators,
	limiter *platform.Limiter,
) *knownOperatorAdmission {
	known := make(map[string]struct{}, len(operators.Operators))
	for operatorID := range operators.Operators {
		known[operatorID] = struct{}{}
	}
	return &knownOperatorAdmission{known: known, limiter: limiter}
}

func (a *knownOperatorAdmission) Admit(_ context.Context, key string, now time.Time) rgsapi.AdmissionResult {
	const prefix = "operator:"
	if strings.HasPrefix(key, prefix) {
		if _, exists := a.known[strings.TrimPrefix(key, prefix)]; !exists {
			key = "operator:unknown"
		}
	}
	return localAdmissionResult(a.limiter.Allow(key, now))
}

type localLimiterAdmission struct {
	limiter *platform.Limiter
}

func (admission localLimiterAdmission) Admit(_ context.Context, key string, now time.Time) rgsapi.AdmissionResult {
	return localAdmissionResult(admission.limiter.Allow(key, now))
}

func localAdmissionResult(allowed bool) rgsapi.AdmissionResult {
	if allowed {
		return rgsapi.AdmissionResult{Decision: rgsapi.AdmissionAllowed}
	}
	return rgsapi.AdmissionResult{Decision: rgsapi.AdmissionRateLimited, RetryAfter: time.Second}
}

type keyReadinessCheck struct {
	operators bootstrap.LoadedOperators
	accessTTL time.Duration
	role      platform.RuntimeRole
}

func (keyReadinessCheck) Name() string { return "operator_keys" }

func (check keyReadinessCheck) Check(context.Context) error {
	return validateKeyReadinessForRole(check.operators, time.Now().UTC(), check.accessTTL, check.role)
}

func validateKeyReadinessForRole(
	operators bootstrap.LoadedOperators,
	now time.Time,
	accessTTL time.Duration,
	role platform.RuntimeRole,
) error {
	if role == platform.RuntimeRoleWorker {
		return validateWalletKeyReadiness(operators, now)
	}
	return validateKeyReadiness(operators, now, accessTTL)
}

func validateWalletKeyReadiness(operators bootstrap.LoadedOperators, now time.Time) error {
	for operatorID, loaded := range operators.Operators {
		requestKey := loaded.Wallet.RequestSigningKey
		if now.Before(requestKey.NotBefore) || requestKey.NotAfter.Before(now.Add(time.Minute)) {
			return fmt.Errorf("%s wallet request signing key is not ready", operatorID)
		}
		hasWalletResponseKey := false
		for _, key := range operators.VerificationKeys {
			if key.OperatorID == operatorID && key.Purpose == operator.KeyPurposeHTTPResponse &&
				!now.Before(key.NotBefore) && key.NotAfter.After(now) {
				hasWalletResponseKey = true
				break
			}
		}
		if !hasWalletResponseKey {
			return fmt.Errorf("%s does not have an active wallet response verification key", operatorID)
		}
	}
	return nil
}

func validateKeyReadiness(
	operators bootstrap.LoadedOperators,
	now time.Time,
	accessTTL time.Duration,
) error {
	for operatorID, loaded := range operators.Operators {
		for name, required := range map[string]struct {
			key      operator.SigningKey
			validFor time.Duration
		}{
			"access":            {loaded.AccessTokenSigningKey, accessTTL},
			"operator response": {loaded.OperatorResponseSigningKey, time.Minute},
			"wallet request":    {loaded.Wallet.RequestSigningKey, time.Minute},
		} {
			if now.Before(required.key.NotBefore) ||
				required.key.NotAfter.Before(now.Add(required.validFor)) {
				return fmt.Errorf("%s %s signing key is not ready", operatorID, name)
			}
		}
		hasRequestKey, hasWalletResponseKey := false, false
		for _, key := range operators.VerificationKeys {
			if key.OperatorID != operatorID || now.Before(key.NotBefore) || !key.NotAfter.After(now) {
				continue
			}
			hasRequestKey = hasRequestKey || key.Purpose == operator.KeyPurposeHTTPRequest
			hasWalletResponseKey = hasWalletResponseKey || key.Purpose == operator.KeyPurposeHTTPResponse
		}
		if !hasRequestKey || !hasWalletResponseKey {
			return fmt.Errorf("%s does not have active request and wallet response verification keys", operatorID)
		}
	}
	return nil
}

type expiredSecurityCredentialPurger interface {
	PurgeExpired(context.Context, time.Time, int) (int64, error)
}

func drainExpiredSecurityCredentials(
	ctx context.Context,
	now time.Time,
	batchSize int,
	nonces expiredSecurityCredentialPurger,
	launches expiredSecurityCredentialPurger,
) error {
	if batchSize <= 0 || nonces == nil || launches == nil {
		return errors.New("invalid security credential cleanup configuration")
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		// 每一轮都让两类凭据各清一批，避免一个持续满批次的表长期饿死另一类清理；
		// 只有两者在同一轮都低于批次上限，才说明当前积压已经排空。
		nonceCount, nonceErr := nonces.PurgeExpired(ctx, now, batchSize)
		launchCount, launchErr := launches.PurgeExpired(ctx, now, batchSize)
		if err := errors.Join(nonceErr, launchErr); err != nil {
			return err
		}
		if nonceCount < int64(batchSize) && launchCount < int64(batchSize) {
			return nil
		}
	}
}

func runSecurityMaintenance(
	ctx context.Context,
	logger *slog.Logger,
	nonces *postgres.NonceStore,
	launches *postgres.LaunchStore,
) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			maintenanceContext, cancel := context.WithTimeout(ctx, 10*time.Second)
			maintenanceErr := drainExpiredSecurityCredentials(
				maintenanceContext, now.UTC(), 1_000, nonces, launches,
			)
			cancel()
			if maintenanceErr != nil && !errors.Is(maintenanceErr, context.Canceled) {
				logger.Error(
					"security credential cleanup failed",
					"error_class", safelog.ErrorClass(maintenanceErr),
				)
			}
		}
	}
}

type responseStatusRecorder struct {
	http.ResponseWriter
	status int
}

// Unwrap 让 http.ResponseController 穿过访问日志包装器访问底层 Flush、Hijack
// 与 deadline 能力；记录状态不能改变 handler 可见的标准传输契约。
func (writer *responseStatusRecorder) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

// FlushError 在底层执行刷新路径后记录已隐式提交的 200，即使网络刷新失败；
// ErrNotSupported 没有提交响应，不能提前锁死后续 handler 仍可提交的错误状态。
func (writer *responseStatusRecorder) FlushError() error {
	err := http.NewResponseController(writer.ResponseWriter).Flush()
	if !errors.Is(err, http.ErrNotSupported) && writer.status == 0 {
		writer.status = http.StatusOK
	}
	return err
}

func (writer *responseStatusRecorder) WriteHeader(status int) {
	// 103 等临时响应可以在最终状态前重复发送；101 协议切换本身是最终提交。
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

func (writer *responseStatusRecorder) Write(body []byte) (int, error) {
	if writer.status == 0 {
		writer.status = http.StatusOK
	}
	return writer.ResponseWriter.Write(body)
}

func observeRequests(
	logger *slog.Logger,
	metrics *platform.Metrics,
	successSamplePerMillion int,
	next http.Handler,
) http.Handler {
	// 4xx 与 5xx 使用两个固定键、各自独立的日志预算。攻击流量不能创建新键，
	// 也不能用大量 4xx 压掉稀有 5xx；完整请求/安全计数仍由无采样指标保留。
	failureAccessLogs := platform.NewLimiter(
		failureAccessLogRatePerSecond,
		failureAccessLogBurst,
		2,
		time.Hour,
	)
	// 确定性采样只决定候选集合，不能成为无限日志许可：request_id 可由调用方
	// 选择并重放。所有成功候选再共享一个固定键预算，攻击者无法制造新桶。
	successAccessLogs := platform.NewLimiter(
		successAccessLogRatePerSecond,
		successAccessLogBurst,
		1,
		time.Hour,
	)
	// 日志管道本身可能因 stdout/runtime/collector 背压而阻塞。速率预算限制写入
	// 数量，但不能限制已经阻塞的 goroutine；独立非阻塞 bulkhead 给物理写日志
	// 设置硬并发上限，避免它在释放公网请求许可后反向耗尽连接与协程。
	accessLogWrites := newBoundedCapacity(accessLogMaxInFlight)
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		started := time.Now()
		route := normalizedPublicRoute(request)
		if metrics != nil {
			metrics.HTTPRequests.Add(1)
			metrics.BeginHTTPRequest()
		}
		recorder := &responseStatusRecorder{ResponseWriter: writer}
		defer func() {
			status := recorder.status
			if status == 0 {
				status = http.StatusOK
			}
			duration := time.Since(started)
			if metrics != nil {
				metrics.EndHTTPRequest(duration)
				if status >= http.StatusBadRequest {
					metrics.HTTPFailures.Add(1)
				}
				if status >= http.StatusInternalServerError {
					metrics.HTTPServerFailures.Add(1)
				}
				if status == http.StatusUnauthorized || status == http.StatusForbidden {
					metrics.AuthFailures.Add(1)
				}
				if status == http.StatusTooManyRequests {
					metrics.RateLimited.Add(1)
				}
			}
			if logger != nil {
				requestID := loggedRequestID(request, recorder.Header())
				logRequestID := safelog.CorrelationIDDigest(requestID)
				// 访问日志会长期保留：只记录固定路由枚举和 request_id 的稳定单向摘要。
				// 绝不写入原始 URL、未知路径、查询参数、RemoteAddr 或经济/玩家标识，
				// 以免不可信输入扩大隐私暴露面或污染日志检索索引。
				arguments := []any{
					"route", route,
					"request_id", logRequestID,
					"status", status,
					"status_class", httpStatusClass(status),
					"duration_ms", duration.Milliseconds(),
				}
				switch {
				case status >= http.StatusInternalServerError:
					if failureAccessLogs.Allow("5xx", time.Now()) {
						emitBoundedAccessLog(accessLogWrites, metrics, func() {
							logger.Error("http request", arguments...)
						})
					} else {
						recordAccessLogDropped(metrics)
					}
				case status >= http.StatusBadRequest:
					if failureAccessLogs.Allow("4xx", time.Now()) {
						emitBoundedAccessLog(accessLogWrites, metrics, func() {
							logger.Warn("http request", arguments...)
						})
					} else {
						recordAccessLogDropped(metrics)
					}
				case shouldEmitSuccessfulAccessLog(successSamplePerMillion, route, requestID):
					if successAccessLogs.Allow("success", time.Now()) {
						emitBoundedAccessLog(accessLogWrites, metrics, func() {
							logger.Info("http request", arguments...)
						})
					} else {
						recordAccessLogDropped(metrics)
					}
				default:
					recordAccessLogDropped(metrics)
				}
			}
		}()
		next.ServeHTTP(recorder, request)
	})
}

func emitBoundedAccessLog(
	capacity *boundedCapacity,
	metrics *platform.Metrics,
	emit func(),
) {
	if emit == nil {
		recordAccessLogDropped(metrics)
		return
	}
	release := capacity.TryAcquire()
	if release == nil {
		recordAccessLogDropped(metrics)
		return
	}
	defer release()
	emit()
	recordAccessLogEmitted(metrics)
}

func recordAccessLogEmitted(metrics *platform.Metrics) {
	if metrics != nil {
		metrics.AccessLogEmitted()
	}
}

func recordAccessLogDropped(metrics *platform.Metrics) {
	if metrics != nil {
		metrics.AccessLogDropped()
	}
}

func shouldEmitSuccessfulAccessLog(samplePerMillion int, route, requestID string) bool {
	if samplePerMillion <= 0 {
		return false
	}
	if samplePerMillion >= 1_000_000 {
		return true
	}
	// 固定路由和安全请求标识经过 SHA-256 分桶；同一输入始终得到相同决定，
	// 副本扩缩容或进程重启不会改变采样结果，也不会引入高基数监控标签。
	digest := sha256.Sum256([]byte(route + "\x00" + requestID))
	bucket := binary.BigEndian.Uint64(digest[:8]) % 1_000_000
	return bucket < uint64(samplePerMillion)
}

func normalizedPublicRoute(request *http.Request) string {
	if request == nil || request.URL == nil {
		return "invalid"
	}
	switch request.URL.Path {
	case rgsapi.OperatorLaunchPath:
		return "operator.launch"
	case rgsapi.OperatorRoundStatusPath:
		return "operator.round_status"
	case rgsapi.OperatorRiskDecisionPath:
		return "operator.risk_decision"
	case rgsapi.ClientSessionExchangePath:
		return "client.session_exchange"
	case rgsapi.ClientSessionRefreshPath:
		return "client.session_refresh"
	case rgsapi.ClientSpinPath:
		return "client.spin"
	case rgsapi.ClientRoundStatusPath:
		return "client.round_status"
	case rgsapi.ClientPendingResultPath:
		return "client.pending_result"
	case rgsapi.ClientResultAckPath:
		return "client.result_ack"
	default:
		return "other"
	}
}

func loggedRequestID(request *http.Request, headers http.Header) string {
	if requestID := safeLogRequestID(headers.Get(operator.HeaderRequestID)); requestID != "" {
		return requestID
	}
	if request != nil {
		if requestID := safeLogRequestID(request.Header.Get(operator.HeaderRequestID)); requestID != "" {
			return requestID
		}
	}
	return "unavailable"
}

func safeLogRequestID(value string) string {
	if len(value) < 1 || len(value) > 128 {
		return ""
	}
	for _, character := range value {
		if !(character >= 'a' && character <= 'z') && !(character >= 'A' && character <= 'Z') &&
			!(character >= '0' && character <= '9') && !strings.ContainsRune("._:-", character) {
			return ""
		}
	}
	return value
}

func httpStatusClass(status int) string {
	if status < 100 || status > 599 {
		return "unknown"
	}
	return strconv.Itoa(status/100) + "xx"
}
