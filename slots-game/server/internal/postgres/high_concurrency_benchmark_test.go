package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"slots-game/server/internal/game"
	"slots-game/server/internal/outbox"
	"slots-game/server/internal/rgs"
)

const highConcurrencyWalletIndexSQL = `
	CREATE INDEX rgs_wallet_transactions_round_claim
	ON rgs_wallet_transactions (operator_id, session_id, round_id, transaction_id)`

type postgresHighConcurrencyReport struct {
	Schema            string                            `json:"schema"`
	GatePassed        bool                              `json:"gatePassed"`
	GeneratedAt       time.Time                         `json:"generatedAt"`
	PostgresVersion   string                            `json:"postgresVersion"`
	GoMaxOpenConns    int                               `json:"goMaxOpenConnections"`
	Environment       string                            `json:"environment"`
	AssessmentMode    string                            `json:"assessmentMode"`
	Thresholds        postgresHighConcurrencyThresholds `json:"thresholds"`
	StatementContract postgresStatementContract         `json:"prepareRoundStatementContract"`
	Scenarios         []postgresHighConcurrencyResult   `json:"scenarios"`
	Limitations       []string                          `json:"limitations"`
}

type postgresStatementContract struct {
	BaselineBeforeChange int    `json:"baselineBeforeChange"`
	Optimized            int    `json:"optimized"`
	Scope                string `json:"scope"`
	Evidence             string `json:"evidence"`
}

type postgresHighConcurrencyThresholds struct {
	MaxP99Millis             *float64 `json:"maxP99Millis,omitempty"`
	MaxConnectionWaitCount   *int64   `json:"maxConnectionWaitCount,omitempty"`
	MaxConnectionWaitMillis  *int64   `json:"maxConnectionWaitMillis,omitempty"`
	MaxWALBytesPerSuccessful *float64 `json:"maxWalBytesPerSuccessfulOperation,omitempty"`
}

type postgresHighConcurrencyResult struct {
	Name                 string   `json:"name"`
	Concurrency          int      `json:"concurrency"`
	Attempted            int64    `json:"attempted"`
	Succeeded            int64    `json:"succeeded"`
	Failed               int64    `json:"failed"`
	DurationMillis       int64    `json:"durationMillis"`
	ThroughputPerSecond  float64  `json:"throughputPerSecond"`
	P50Millis            float64  `json:"p50Millis"`
	P95Millis            float64  `json:"p95Millis"`
	P99Millis            float64  `json:"p99Millis"`
	ConnectionWaitCount  int64    `json:"connectionWaitCount"`
	ConnectionWaitMillis int64    `json:"connectionWaitMillis"`
	MaximumOpenConns     int      `json:"maximumOpenConnections"`
	MaximumLockWaiters   int64    `json:"maximumLockWaiters"`
	LockSamples          int64    `json:"lockSamples"`
	WALBytes             int64    `json:"walBytes"`
	Plan                 string   `json:"plan,omitempty"`
	Errors               []string `json:"errors,omitempty"`
}

type measuredLoad struct {
	attempted int64
	succeeded int64
	failed    int64
	latencies []time.Duration
	errors    []string
}

// TestPostgresHighConcurrencyProfile 是显式 opt-in 的破坏性测试数据库负载剖面。
// 它绝不能指向生产库；脚本要求第二个独立确认变量，且生成物只写 ignored artifacts。
// 功能不变量和执行计划始终失败闭合；未配置全部性能阈值时不构成发布容量门禁。
func TestPostgresHighConcurrencyProfile(t *testing.T) {
	if os.Getenv("RGS_RUN_POSTGRES_HIGH_CONCURRENCY") != "1" {
		t.Skip("set RGS_RUN_POSTGRES_HIGH_CONCURRENCY=1 to run the PostgreSQL load profile")
	}
	if os.Getenv("RGS_HIGH_CONCURRENCY_ALLOW_DESTRUCTIVE_TEST_DATABASE") != "YES" {
		t.Fatal("RGS_HIGH_CONCURRENCY_ALLOW_DESTRUCTIVE_TEST_DATABASE=YES is required")
	}
	databaseURLs := requirePostgresTestURLs(t)
	runtimeDB, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer runtimeDB.Close()
	migratorDB, err := sql.Open("pgx", databaseURLs.migrator)
	if err != nil {
		t.Fatal(err)
	}
	defer migratorDB.Close()
	observerDB := migratorDB
	if observerURL := strings.TrimSpace(os.Getenv("RGS_POSTGRES_OBSERVER_TEST_URL")); observerURL != "" {
		observerDB, err = sql.Open("pgx", observerURL)
		if err != nil {
			t.Fatal(err)
		}
		defer observerDB.Close()
	}

	maxOpen := highConcurrencyEnvInt(t, "RGS_HIGH_CONCURRENCY_MAX_OPEN_CONNS", 16, 2, 512)
	runtimeDB.SetMaxOpenConns(maxOpen)
	runtimeDB.SetMaxIdleConns(maxOpen)
	migratorDB.SetMaxOpenConns(4)
	observerDB.SetMaxOpenConns(2)

	truncateIntegrationTables(t, migratorDB)
	defer truncateIntegrationTables(t, migratorDB)
	ctx, cancel := context.WithTimeout(
		context.Background(),
		time.Duration(highConcurrencyEnvInt(t, "RGS_HIGH_CONCURRENCY_TIMEOUT_SECONDS", 300, 30, 3600))*time.Second,
	)
	defer cancel()
	repository, err := NewRepository(runtimeDB)
	if err != nil {
		t.Fatal(err)
	}

	var version string
	if err := observerDB.QueryRowContext(ctx, `SHOW server_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	thresholds := highConcurrencyThresholds(t)
	assessmentMode := highConcurrencyAssessmentMode(thresholds)
	report := postgresHighConcurrencyReport{
		Schema:          "slots-game/postgres-load/v1",
		GatePassed:      assessmentMode == "local-threshold-enforced-nonrelease",
		GeneratedAt:     time.Now().UTC(),
		PostgresVersion: version,
		GoMaxOpenConns:  maxOpen,
		Environment:     "local destructive test database; not an AWS/RDS capacity certification",
		AssessmentMode:  assessmentMode,
		Thresholds:      thresholds,
		StatementContract: postgresStatementContract{
			BaselineBeforeChange: 8,
			Optimized:            3,
			Scope:                "successful PrepareRound SQL statements, excluding BEGIN and COMMIT",
			Evidence:             "strict sqlmock expectations in TestPrepareRoundUsesDatabaseClockForInitialRecoverySchedule",
		},
		Limitations: []string{
			"wallet HTTP, network RTT, RDS Multi-AZ failover and storage throttling are outside this database-only profile",
			"lock waiter visibility is complete only when RGS_POSTGRES_OBSERVER_TEST_URL has pg_monitor-equivalent access",
			"local throughput is comparative evidence, not a production TPS promise",
			"statement counts are a code-and-test contract, not a runtime timing measurement",
		},
	}
	if report.AssessmentMode == "report-only" {
		report.Limitations = append(report.Limitations,
			"no performance approval thresholds were configured; this run is report-only")
	} else if report.AssessmentMode == "partial-local-threshold-enforced-nonrelease" {
		report.Limitations = append(report.Limitations,
			"only a subset of performance thresholds was configured; this run is not a release capacity approval")
	}

	// 在隔离测试库中重建变更前索引布局与逐语句 PrepareRound，实现同一二进制、
	// 同一 PostgreSQL 实例的可重复 A/B；defer 保证任何失败都恢复迁移声明的布局。
	defer setHighConcurrencyIndexLayout(t, context.Background(), migratorDB, true)
	setHighConcurrencyIndexLayout(t, ctx, migratorDB, false)
	report.Scenarios = append(report.Scenarios,
		runHighConcurrencyScenarioSuite(t, ctx, runtimeDB, observerDB, repository, "baseline", true)...)

	truncateIntegrationTables(t, migratorDB)
	setHighConcurrencyIndexLayout(t, ctx, migratorDB, true)
	report.Scenarios = append(report.Scenarios,
		runHighConcurrencyScenarioSuite(t, ctx, runtimeDB, observerDB, repository, "optimized", false)...)

	indexRows := highConcurrencyEnvInt(t, "RGS_HIGH_CONCURRENCY_INDEX_ROWS", 20_000, 1_000, 1_000_000)
	indexIterations := highConcurrencyEnvInt(t, "RGS_HIGH_CONCURRENCY_INDEX_ITERATIONS", 100, 10, 100_000)
	baseline, optimized := compareWalletClaimIndex(
		t, ctx, runtimeDB, migratorDB, observerDB, indexRows, indexIterations,
	)
	report.Scenarios = append(report.Scenarios, baseline, optimized)

	artifactPath := strings.TrimSpace(os.Getenv("RGS_HIGH_CONCURRENCY_ARTIFACT_PATH"))
	if artifactPath == "" {
		artifactPath = filepath.Join("..", "..", "..", ".artifacts", "high-concurrency", "postgres-report.json")
	}
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(artifactPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifactPath, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range report.Scenarios {
		t.Logf("%s: ok=%d fail=%d throughput=%.1f/s p95=%.2fms p99=%.2fms connWait=%d/%dms lockMax=%d wal=%d",
			scenario.Name, scenario.Succeeded, scenario.Failed, scenario.ThroughputPerSecond,
			scenario.P95Millis, scenario.P99Millis, scenario.ConnectionWaitCount,
			scenario.ConnectionWaitMillis, scenario.MaximumLockWaiters, scenario.WALBytes)
	}
	t.Logf("PostgreSQL high-concurrency artifact: %s (assessment=%s)", artifactPath, report.AssessmentMode)
	if failures := validateHighConcurrencyReport(report); len(failures) > 0 {
		t.Fatalf("PostgreSQL high-concurrency profile failed:\n- %s", strings.Join(failures, "\n- "))
	}
}

func setHighConcurrencyIndexLayout(t *testing.T, parent context.Context, database *sql.DB, optimized bool) {
	t.Helper()
	ctx := parent
	if _, hasDeadline := parent.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(parent, 30*time.Second)
		defer cancel()
	}
	statements := []string{
		`DROP INDEX IF EXISTS rgs_wallet_transactions_round_claim`,
		`DROP INDEX IF EXISTS rgs_outbox_unpublished_age`,
		`DROP INDEX IF EXISTS rgs_rounds_recovery`,
		`DROP INDEX IF EXISTS rgs_outbox_dispatch`,
		`DROP INDEX IF EXISTS rgs_outbox_claim`,
	}
	if optimized {
		statements = append(statements,
			highConcurrencyWalletIndexSQL,
			`CREATE INDEX rgs_outbox_claim ON rgs_outbox (available_at, id) WHERE published_at IS NULL`,
			`CREATE INDEX rgs_outbox_unpublished_age ON rgs_outbox (created_at, id) WHERE published_at IS NULL`,
		)
	} else {
		statements = append(statements,
			`CREATE INDEX rgs_rounds_recovery ON rgs_rounds (status, updated_at)
				WHERE status IN ('PREPARED','WALLET_PENDING','ROLLBACK_PENDING','MANUAL_REVIEW')`,
			`CREATE INDEX rgs_outbox_dispatch ON rgs_outbox (available_at, id)
				WHERE published_at IS NULL`,
			`CREATE INDEX rgs_outbox_claim ON rgs_outbox (available_at, lease_until, id)
				WHERE published_at IS NULL`,
		)
	}
	for _, statement := range statements {
		if _, err := database.ExecContext(ctx, statement); err != nil {
			t.Fatalf("set high-concurrency index layout optimized=%v: %v", optimized, err)
		}
	}
}

func runHighConcurrencyScenarioSuite(
	t *testing.T,
	ctx context.Context,
	runtimeDB, observerDB *sql.DB,
	repository *Repository,
	variant string,
	legacyPrepare bool,
) []postgresHighConcurrencyResult {
	t.Helper()
	var scenarios []postgresHighConcurrencyResult
	steadyWorkers := highConcurrencyEnvInt(t, "RGS_HIGH_CONCURRENCY_STEADY_WORKERS", 8, 1, 512)
	steadyOps := highConcurrencyEnvInt(t, "RGS_HIGH_CONCURRENCY_STEADY_OPS_PER_WORKER", 10, 1, 10_000)
	steadyPrefix := variant + "-steady"
	seedRoundLifecycleSessions(t, ctx, repository, steadyPrefix, steadyWorkers, false)
	scenarios = append(scenarios, measurePostgresLoad(
		t, ctx, runtimeDB, observerDB, variant+"_steady_distinct_operators", steadyWorkers,
		func(ctx context.Context) measuredLoad {
			return runRoundLifecycleLoad(ctx, repository, steadyPrefix, steadyWorkers, steadyOps, false, legacyPrepare)
		},
	))

	stepOps := highConcurrencyEnvInt(t, "RGS_HIGH_CONCURRENCY_STEP_OPS_PER_WORKER", 3, 1, 10_000)
	for _, concurrency := range highConcurrencyStepLevels(t) {
		level := concurrency
		stepPrefix := fmt.Sprintf("%s-step-%d", variant, level)
		seedRoundLifecycleSessions(t, ctx, repository, stepPrefix, level, false)
		scenarios = append(scenarios, measurePostgresLoad(
			t, ctx, runtimeDB, observerDB, fmt.Sprintf("%s_step_%03d", variant, level), level,
			func(ctx context.Context) measuredLoad {
				return runRoundLifecycleLoad(ctx, repository, stepPrefix,
					level, stepOps, false, legacyPrepare)
			},
		))
	}

	operatorWorkers := highConcurrencyEnvInt(t, "RGS_HIGH_CONCURRENCY_OPERATOR_WORKERS", 16, 1, 512)
	operatorOps := highConcurrencyEnvInt(t, "RGS_HIGH_CONCURRENCY_OPERATOR_OPS_PER_WORKER", 5, 1, 10_000)
	operatorPrefix := variant + "-hot-operator"
	seedRoundLifecycleSessions(t, ctx, repository, operatorPrefix, operatorWorkers, true)
	scenarios = append(scenarios, measurePostgresLoad(
		t, ctx, runtimeDB, observerDB, variant+"_hot_operator_many_sessions", operatorWorkers,
		func(ctx context.Context) measuredLoad {
			return runRoundLifecycleLoad(ctx, repository, operatorPrefix,
				operatorWorkers, operatorOps, true, legacyPrepare)
		},
	))

	hotContenders := highConcurrencyEnvInt(t, "RGS_HIGH_CONCURRENCY_HOT_SESSION_CONTENDERS", 16, 2, 512)
	scenarios = append(scenarios, measurePostgresLoad(
		t, ctx, runtimeDB, observerDB, variant+"_hot_session_lock_contention", hotContenders,
		func(ctx context.Context) measuredLoad {
			return runHotSessionReplayContention(t, ctx, runtimeDB, repository, variant, hotContenders, legacyPrepare)
		},
	))

	recoveryRounds := highConcurrencyEnvInt(t, "RGS_HIGH_CONCURRENCY_RECOVERY_ROUNDS", 128, 1, 100_000)
	recoveryBatch := highConcurrencyEnvInt(t, "RGS_HIGH_CONCURRENCY_RECOVERY_BATCH", 32, 1, rgs.MaxWalletRecoveryClaimBatch)
	recoveryWorkers := highConcurrencyEnvInt(t, "RGS_HIGH_CONCURRENCY_RECOVERY_WORKERS", 4, 1, 128)
	seedRecoveryBacklog(t, ctx, repository, variant, recoveryRounds, legacyPrepare)
	scenarios = append(scenarios, measurePostgresLoad(
		t, ctx, runtimeDB, observerDB, variant+"_recovery_backlog", recoveryWorkers,
		func(ctx context.Context) measuredLoad {
			return runRecoveryBacklog(ctx, repository, recoveryRounds, recoveryBatch, recoveryWorkers)
		},
	))

	outboxWorkers := highConcurrencyEnvInt(t, "RGS_HIGH_CONCURRENCY_OUTBOX_WORKERS", 4, 1, 128)
	outboxBatch := highConcurrencyEnvInt(t, "RGS_HIGH_CONCURRENCY_OUTBOX_BATCH", 64, 1, maximumOutboxBatch)
	scenarios = append(scenarios, measurePostgresLoad(
		t, ctx, runtimeDB, observerDB, variant+"_outbox_backlog", outboxWorkers,
		func(ctx context.Context) measuredLoad {
			return runOutboxBacklog(ctx, runtimeDB, outboxWorkers, outboxBatch)
		},
	))
	return scenarios
}

func seedRoundLifecycleSessions(
	t *testing.T,
	ctx context.Context,
	repository *Repository,
	prefix string,
	workers int,
	oneOperator bool,
) {
	t.Helper()
	for worker := 0; worker < workers; worker++ {
		operatorID := fmt.Sprintf("hc-%s-op-%d", prefix, worker)
		if oneOperator {
			operatorID = "hc-" + prefix + "-op"
		}
		createHighConcurrencySession(t, ctx, repository, operatorID, fmt.Sprintf("hc-%s-session-%d", prefix, worker))
	}
}

func runRoundLifecycleLoad(
	ctx context.Context,
	repository *Repository,
	prefix string,
	workers int,
	opsPerWorker int,
	oneOperator bool,
	legacyPrepare bool,
) measuredLoad {
	profile := rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
		"https://wallet.test.invalid/high-concurrency-ledger",
	))
	start := make(chan struct{})
	var wait sync.WaitGroup
	latencies := make(chan time.Duration, workers*opsPerWorker)
	errorsSeen := make(chan string, workers*opsPerWorker)
	var succeeded atomic.Int64
	var failed atomic.Int64
	for worker := 0; worker < workers; worker++ {
		workerID := worker
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			operatorID := fmt.Sprintf("hc-%s-op-%d", prefix, workerID)
			if oneOperator {
				operatorID = "hc-" + prefix + "-op"
			}
			sessionID := fmt.Sprintf("hc-%s-session-%d", prefix, workerID)
			for operation := 0; operation < opsPerWorker; operation++ {
				started := time.Now()
				err := executeHighConcurrencyRound(
					ctx, repository, profile, operatorID, sessionID, workerID, operation, legacyPrepare,
				)
				latencies <- time.Since(started)
				if err != nil {
					failed.Add(1)
					errorsSeen <- err.Error()
					return
				}
				succeeded.Add(1)
			}
		}()
	}
	close(start)
	wait.Wait()
	close(latencies)
	close(errorsSeen)
	return measuredLoad{
		attempted: int64(workers * opsPerWorker),
		succeeded: succeeded.Load(), failed: failed.Load(),
		latencies: collectDurations(latencies), errors: collectErrors(errorsSeen),
	}
}

func executeHighConcurrencyRound(
	ctx context.Context,
	repository *Repository,
	profile rgs.Profile,
	operatorID, sessionID string,
	worker, operation int,
	legacyPrepare bool,
) error {
	session, err := repository.GetSession(ctx, operatorID, sessionID)
	if err != nil {
		return err
	}
	roundID := fmt.Sprintf("hc-round-%d-%d-%d", worker, operation, session.Revision)
	request := rgs.SpinRequest{
		OperatorID: operatorID, SessionID: sessionID, RoundID: roundID,
		GameID: session.GameID, DefinitionVersion: session.DefinitionVersion,
		DefinitionHash: session.DefinitionHash, Currency: session.Currency,
		RoundKind: rgs.RoundKindBase, BetMinor: 100, StartRevision: session.Revision,
		TransportGeneration: session.TransportGeneration,
	}
	record, prepared, err := prepareRoundForLoad(
		ctx, repository, request, rgs.FingerprintFor(request), profile, legacyPrepare,
		func(locked rgs.Session) (rgs.SpinResult, error) {
			result := validPreparedSessionIntegrityResult(request, locked.Sequence+1)
			result.ServerTransactionID = fmt.Sprintf("rgs-op-v1:hc-%d-%d-%d", worker, operation, locked.Revision)
			return result, nil
		},
	)
	if err != nil || !prepared {
		return errors.Join(errors.New("prepare round"), err)
	}
	claim, claimed, err := repository.ClaimWallet(ctx, record.Key, time.Minute)
	if err != nil || !claimed {
		return errors.Join(errors.New("claim wallet"), err)
	}
	command := claim.Record.WalletCommand
	balance := int64(1_000_000_000) - int64(session.Revision+1)*command.DebitMinor + command.CreditMinor
	committed, changed, err := repository.CommitClaim(ctx, claim, rgs.WalletReceipt{
		OperationID: command.OperationID, Fingerprint: command.Fingerprint,
		TransactionID: fmt.Sprintf("wallet-hc-%d-%d-%d", worker, operation, session.Revision),
		OperatorID:    command.OperatorID, Currency: command.Currency,
		DebitMinor: command.DebitMinor, CreditMinor: command.CreditMinor,
		BalanceMinor: balance,
	})
	if err != nil || !changed {
		return errors.Join(errors.New("commit claim"), err)
	}
	resultHash, err := rgs.CommittedResultHashFor(committed.Result)
	if err != nil {
		return err
	}
	_, changed, err = repository.AcknowledgeResultDelivery(ctx, rgs.ResultDeliveryAcknowledgement{
		OperatorID: operatorID, SessionID: sessionID, RoundID: roundID,
		Sequence: committed.Result.Sequence, ResultHash: resultHash, TransportGeneration: 1,
	})
	if err != nil || !changed {
		return errors.Join(errors.New("acknowledge result"), err)
	}
	return nil
}

func prepareRoundForLoad(
	ctx context.Context,
	repository *Repository,
	request rgs.SpinRequest,
	fingerprint string,
	profile rgs.Profile,
	legacy bool,
	prepare rgs.PrepareOutcome,
) (rgs.RoundRecord, bool, error) {
	if legacy {
		return prepareRoundLegacyForLoad(ctx, repository, request, fingerprint, profile, prepare)
	}
	return repository.PrepareRound(ctx, request, fingerprint, profile, prepare)
}

// prepareRoundLegacyForLoad 保留本次优化前的八语句成功路径，仅供隔离数据库 A/B。
// 它写入与生产实现完全相同的 round、ledger、session cursor 与 outbox 行，不参与运行时构建。
func prepareRoundLegacyForLoad(
	ctx context.Context,
	repository *Repository,
	request rgs.SpinRequest,
	fingerprint string,
	walletProfile rgs.Profile,
	prepare rgs.PrepareOutcome,
) (rgs.RoundRecord, bool, error) {
	return prepareRoundLegacyForLoadWithCommitHook(
		ctx, repository, request, fingerprint, walletProfile, prepare, nil,
	)
}

func prepareRoundLegacyForLoadWithCommitHook(
	ctx context.Context,
	repository *Repository,
	request rgs.SpinRequest,
	fingerprint string,
	walletProfile rgs.Profile,
	prepare rgs.PrepareOutcome,
	beforeCommit func() error,
) (rgs.RoundRecord, bool, error) {
	if err := rgs.ValidateSpinRequest(request); err != nil || prepare == nil ||
		fingerprint != rgs.FingerprintFor(request) || !rgs.SupportedSettlementProfile(walletProfile) {
		return rgs.RoundRecord{}, false, rgs.ErrInvalidRequest
	}
	walletProfileJSON, err := json.Marshal(walletProfile)
	if err != nil {
		return rgs.RoundRecord{}, false, err
	}
	tx, err := repository.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return rgs.RoundRecord{}, false, err
	}
	defer tx.Rollback()
	session, err := scanSession(tx.QueryRowContext(ctx, sessionSelect+`
		WHERE operator_id=$1 AND session_id=$2 FOR UPDATE`, request.OperatorID, request.SessionID))
	if err != nil {
		return rgs.RoundRecord{}, false, err
	}
	existing, err := scanRound(tx.QueryRowContext(ctx, roundSelect+`
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3`,
		request.OperatorID, request.SessionID, request.RoundID,
	))
	if err == nil {
		if existing.Fingerprint != fingerprint {
			return rgs.RoundRecord{}, false, rgs.ErrIdempotencyConflict
		}
		if err := tx.Commit(); err != nil {
			return rgs.RoundRecord{}, false, err
		}
		return existing, false, nil
	}
	if !errors.Is(err, rgs.ErrRoundNotFound) {
		return rgs.RoundRecord{}, false, err
	}
	var resultDeliveryPending bool
	if err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM rgs_rounds
			WHERE operator_id=$1 AND session_id=$2
			  AND status='COMMITTED' AND result_delivery_required
			  AND result_acknowledged_at IS NULL
		)`, request.OperatorID, request.SessionID).Scan(&resultDeliveryPending); err != nil {
		return rgs.RoundRecord{}, false, err
	}
	if resultDeliveryPending {
		return rgs.RoundRecord{}, false, rgs.ErrResultDeliveryPending
	}
	var now time.Time
	if err := tx.QueryRowContext(ctx, walletLeaseClockSQL).Scan(&now); err != nil {
		return rgs.RoundRecord{}, false, err
	}
	now = now.UTC()
	if err := validateBinding(session, request, now); err != nil {
		return rgs.RoundRecord{}, false, err
	}
	if session.PendingRoundID != "" {
		return rgs.RoundRecord{}, false, rgs.ErrRoundPending
	}
	result, err := prepare(session)
	if err != nil {
		return rgs.RoundRecord{}, false, err
	}
	if err := validatePrepared(session, request, result); err != nil {
		return rgs.RoundRecord{}, false, err
	}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return rgs.RoundRecord{}, false, err
	}
	inputFeatureJSON, err := json.Marshal(session.Feature)
	if err != nil {
		return rgs.RoundRecord{}, false, err
	}
	outcomeHash, err := rgs.PreparedOutcomeHashFor(result)
	if err != nil {
		return rgs.RoundRecord{}, false, err
	}
	walletCommand := rgs.WalletRound{
		OperationID: result.ServerTransactionID, Fingerprint: fingerprint,
		OperatorID: request.OperatorID, PlayerID: session.PlayerID,
		WalletAccountID: session.WalletAccountID, WalletSessionRef: session.WalletSessionID,
		SessionID: request.SessionID, RoundID: request.RoundID, GameID: request.GameID,
		DefinitionVersion: request.DefinitionVersion, DefinitionHash: request.DefinitionHash,
		RoundKind: request.RoundKind, Currency: request.Currency,
		DebitMinor: result.ChargedBetMinor, CreditMinor: result.TotalWinMinor,
	}
	walletCommand.CommandDigest = rgs.CommandDigestFor(walletCommand)
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO rgs_rounds (
			operator_id, session_id, round_id, server_transaction_id,
			request_fingerprint, status, round_kind, game_id,
			definition_version, definition_hash, currency, bet_minor,
			input_feature_state, charged_minor, win_minor, starting_revision, resulting_revision,
			sequence, result_json, outcome_hash, wallet_phase, wallet_command_digest,
			wallet_profile, next_attempt_at, created_at, updated_at
		) VALUES (
			$1,$2,$3,$4,$5,'PREPARED',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
			'APPLY',$20,$21,$22,$22,$22
		)`,
		request.OperatorID, request.SessionID, request.RoundID, result.ServerTransactionID,
		fingerprint, string(request.RoundKind), request.GameID, request.DefinitionVersion,
		request.DefinitionHash, request.Currency, request.BetMinor, inputFeatureJSON,
		result.ChargedBetMinor, result.TotalWinMinor, checkedInt64(request.StartRevision),
		checkedInt64(request.StartRevision+1), checkedInt64(result.Sequence), resultJSON,
		outcomeHash, walletCommand.CommandDigest, walletProfileJSON, now,
	); err != nil {
		return rgs.RoundRecord{}, false, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO rgs_wallet_transactions (
			operator_id, transaction_id, session_id, round_id, kind, status,
			currency, amount_minor, request_fingerprint, created_at, updated_at
		) VALUES ($1,$2,$3,$4,'PLAY','PENDING',$5,$6,$7,$8,$8)`,
		request.OperatorID, result.ServerTransactionID, request.SessionID, request.RoundID,
		request.Currency, result.ChargedBetMinor, fingerprint, now,
	); err != nil {
		return rgs.RoundRecord{}, false, err
	}
	updated, err := tx.ExecContext(ctx, `
		UPDATE rgs_sessions SET pending_round_id=$3, updated_at=$4
		WHERE operator_id=$1 AND session_id=$2 AND revision=$5 AND pending_round_id IS NULL`,
		request.OperatorID, request.SessionID, request.RoundID, now, checkedInt64(request.StartRevision),
	)
	if err != nil {
		return rgs.RoundRecord{}, false, err
	}
	if rows, _ := updated.RowsAffected(); rows != 1 {
		return rgs.RoundRecord{}, false, rgs.ErrRevisionConflict
	}
	if err := insertOutbox(ctx, tx, request.OperatorID, "round", result.ServerTransactionID, "ROUND_PREPARED", map[string]any{
		"sessionId": request.SessionID, "roundId": request.RoundID,
		"fingerprint": fingerprint, "outcomeHash": outcomeHash,
		"definitionVersion": request.DefinitionVersion,
	}); err != nil {
		return rgs.RoundRecord{}, false, err
	}
	if beforeCommit != nil {
		if err := beforeCommit(); err != nil {
			return rgs.RoundRecord{}, false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return rgs.RoundRecord{}, false, err
	}
	return rgs.RoundRecord{
		Key: request.Key(), Fingerprint: fingerprint, Request: request,
		Status: rgs.RoundPrepared, Result: result, InputFeatureState: session.Feature,
		WalletCommand: walletCommand, WalletProfile: walletProfile, OutcomeHash: outcomeHash,
		WalletPhase: rgs.WalletRecoveryApply, NextAttemptAt: now, CreatedAt: now, UpdatedAt: now,
	}, true, nil
}

func createHighConcurrencySession(
	t *testing.T,
	ctx context.Context,
	repository *Repository,
	operatorID, sessionID string,
) {
	t.Helper()
	if err := repository.CreateSession(ctx, rgs.Session{
		OperatorID: operatorID, SessionID: sessionID,
		PlayerID: "player-" + sessionID, WalletAccountID: "wallet-" + sessionID,
		WalletSessionID: "wallet-session-" + sessionID,
		GameID:          "game-a", DefinitionVersion: "math-v1",
		DefinitionHash: strings.Repeat("a", 64), Currency: "USD", CurrencyExponent: 2,
		Jurisdiction: "MT", Status: rgs.SessionActive, BalanceMinor: 1_000_000_000,
		Feature: gameEmptyFeatureStateForLoad(), ExpiresAt: time.Now().UTC().Add(time.Hour),
		IdleDisconnect: 20 * time.Minute, IdleDisconnectAt: time.Now().UTC().Add(20 * time.Minute),
		TransportGeneration: 1,
	}); err != nil {
		t.Fatal(err)
	}
}

func gameEmptyFeatureStateForLoad() game.FeatureState {
	return game.EmptyFeatureState()
}

func runHotSessionReplayContention(
	t *testing.T,
	ctx context.Context,
	database *sql.DB,
	repository *Repository,
	variant string,
	contenders int,
	legacyPrepare bool,
) measuredLoad {
	t.Helper()
	operatorID := "hc-" + variant + "-hot-session-op"
	sessionID := "hc-" + variant + "-hot-session"
	createHighConcurrencySession(t, ctx, repository, operatorID, sessionID)
	session, err := repository.GetSession(ctx, operatorID, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	request := rgs.SpinRequest{
		OperatorID: operatorID, SessionID: sessionID, RoundID: "hc-hot-session-round",
		GameID: session.GameID, DefinitionVersion: session.DefinitionVersion,
		DefinitionHash: session.DefinitionHash, Currency: session.Currency,
		RoundKind: rgs.RoundKindBase, BetMinor: 100,
		TransportGeneration: session.TransportGeneration,
	}
	profile := rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
		"https://wallet.test.invalid/high-concurrency-ledger",
	))
	_, prepared, err := prepareRoundForLoad(
		ctx, repository, request, rgs.FingerprintFor(request), profile, legacyPrepare,
		func(locked rgs.Session) (rgs.SpinResult, error) {
			result := validPreparedSessionIntegrityResult(request, locked.Sequence+1)
			result.ServerTransactionID = "rgs-op-v1:hc-hot-session"
			return result, nil
		},
	)
	if err != nil || !prepared {
		t.Fatalf("prepare hot session fixture = prepared:%v error:%v", prepared, err)
	}
	locker, err := database.BeginTx(ctx, &sql.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer locker.Rollback()
	if _, err := locker.ExecContext(ctx, `
		SELECT 1 FROM rgs_sessions
		WHERE operator_id=$1 AND session_id=$2 FOR UPDATE`, operatorID, sessionID); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	latencies := make(chan time.Duration, contenders)
	errorsSeen := make(chan string, contenders+1)
	var succeeded atomic.Int64
	var failed atomic.Int64
	var wait sync.WaitGroup
	for contender := 0; contender < contenders; contender++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			started := time.Now()
			_, replayPrepared, replayErr := prepareRoundForLoad(
				ctx, repository, request, rgs.FingerprintFor(request), profile, legacyPrepare,
				func(rgs.Session) (rgs.SpinResult, error) {
					return rgs.SpinResult{}, errors.New("replay unexpectedly evaluated RNG")
				},
			)
			latencies <- time.Since(started)
			if replayErr != nil || replayPrepared {
				failed.Add(1)
				errorsSeen <- fmt.Sprintf("prepared=%v error=%v", replayPrepared, replayErr)
				return
			}
			succeeded.Add(1)
		}()
	}
	close(start)
	timer := time.NewTimer(150 * time.Millisecond)
	select {
	case <-ctx.Done():
		timer.Stop()
		t.Fatal(ctx.Err())
	case <-timer.C:
	}
	if err := locker.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
		t.Fatal(err)
	}
	wait.Wait()
	claim, claimed, cleanupErr := repository.ClaimWallet(ctx, request.Key(), time.Minute)
	if cleanupErr == nil && claimed {
		_, changed, rejectErr := repository.RejectClaim(ctx, claim, "HIGH_CONCURRENCY_TEST_REJECT")
		if rejectErr != nil || !changed {
			cleanupErr = fmt.Errorf("reject changed=%v: %w", changed, rejectErr)
		}
	} else if cleanupErr == nil {
		cleanupErr = errors.New("hot-session fixture was not claimable for cleanup")
	}
	if cleanupErr != nil {
		failed.Add(1)
		errorsSeen <- "hot-session cleanup: " + cleanupErr.Error()
	}
	close(latencies)
	close(errorsSeen)
	return measuredLoad{
		attempted: int64(contenders), succeeded: succeeded.Load(), failed: failed.Load(),
		latencies: collectDurations(latencies), errors: collectErrors(errorsSeen),
	}
}

func seedRecoveryBacklog(
	t *testing.T,
	ctx context.Context,
	repository *Repository,
	variant string,
	roundCount int,
	legacyPrepare bool,
) {
	t.Helper()
	profile := rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
		"https://wallet.test.invalid/high-concurrency-ledger",
	))
	for index := 0; index < roundCount; index++ {
		operatorID := fmt.Sprintf("hc-%s-recovery-op-%d", variant, index)
		sessionID := fmt.Sprintf("hc-%s-recovery-session-%d", variant, index)
		createHighConcurrencySession(t, ctx, repository, operatorID, sessionID)
		session, err := repository.GetSession(ctx, operatorID, sessionID)
		if err != nil {
			t.Fatal(err)
		}
		request := rgs.SpinRequest{
			OperatorID: operatorID, SessionID: sessionID,
			RoundID: fmt.Sprintf("hc-%s-recovery-round-%d", variant, index),
			GameID:  session.GameID, DefinitionVersion: session.DefinitionVersion,
			DefinitionHash: session.DefinitionHash, Currency: session.Currency,
			RoundKind: rgs.RoundKindBase, BetMinor: 100,
			TransportGeneration: session.TransportGeneration,
		}
		_, prepared, err := prepareRoundForLoad(
			ctx, repository, request, rgs.FingerprintFor(request), profile, legacyPrepare,
			func(locked rgs.Session) (rgs.SpinResult, error) {
				result := validPreparedSessionIntegrityResult(request, locked.Sequence+1)
				result.ServerTransactionID = fmt.Sprintf("rgs-op-v1:hc-recovery-%d", index)
				return result, nil
			},
		)
		if err != nil || !prepared {
			t.Fatalf("prepare recovery %d = prepared:%v error:%v", index, prepared, err)
		}
	}
}

func runRecoveryBacklog(
	ctx context.Context,
	repository *Repository,
	roundCount, batchSize, workers int,
) measuredLoad {
	load := measuredLoad{attempted: int64(roundCount)}
	var claimed atomic.Int64
	var succeeded atomic.Int64
	var failed atomic.Int64
	var resultMu sync.Mutex
	var wait sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for claimed.Load() < int64(roundCount) {
				started := time.Now()
				claims, err := repository.ClaimRecoverableRounds(ctx, batchSize, time.Minute)
				claimLatency := time.Since(started)
				if err != nil {
					failed.Add(1)
					resultMu.Lock()
					load.errors = append(load.errors, err.Error())
					resultMu.Unlock()
					return
				}
				if len(claims) == 0 {
					if claimed.Load() >= int64(roundCount) {
						return
					}
					select {
					case <-ctx.Done():
						failed.Add(1)
						resultMu.Lock()
						load.errors = append(load.errors, ctx.Err().Error())
						resultMu.Unlock()
						return
					default:
						runtime.Gosched()
						continue
					}
				}
				claimed.Add(int64(len(claims)))
				for _, claim := range claims {
					transitionStarted := time.Now()
					_, changed, err := repository.RejectClaim(ctx, claim, "HIGH_CONCURRENCY_TEST_REJECT")
					latency := claimLatency/time.Duration(len(claims)) + time.Since(transitionStarted)
					resultMu.Lock()
					load.latencies = append(load.latencies, latency)
					resultMu.Unlock()
					if err != nil || !changed {
						failed.Add(1)
						resultMu.Lock()
						load.errors = append(load.errors, fmt.Sprintf("changed=%v error=%v", changed, err))
						resultMu.Unlock()
						continue
					}
					succeeded.Add(1)
				}
			}
		}()
	}
	wait.Wait()
	load.succeeded = succeeded.Load()
	load.failed = failed.Load()
	return load
}

func runOutboxBacklog(ctx context.Context, database *sql.DB, workers, batchSize int) measuredLoad {
	store, err := NewOutboxStore(database)
	if err != nil {
		return measuredLoad{attempted: 1, failed: 1, errors: []string{err.Error()}}
	}
	var backlog int64
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM rgs_outbox WHERE published_at IS NULL`).Scan(&backlog); err != nil {
		return measuredLoad{attempted: 1, failed: 1, errors: []string{err.Error()}}
	}
	load := measuredLoad{attempted: backlog}
	var claimed atomic.Int64
	var succeeded atomic.Int64
	var failed atomic.Int64
	var resultMu sync.Mutex
	var wait sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		workerID := worker
		wait.Add(1)
		go func() {
			defer wait.Done()
			for wave := 0; claimed.Load() < backlog; wave++ {
				leaseToken := fmt.Sprintf("hc-outbox-%d-%d", workerID, wave)
				started := time.Now()
				events, err := store.Claim(ctx, outbox.ClaimRequest{
					Owner: fmt.Sprintf("hc-outbox-worker-%d", workerID), LeaseToken: leaseToken,
					LeaseDuration: time.Minute, Limit: batchSize,
				})
				claimLatency := time.Since(started)
				if err != nil {
					failed.Add(1)
					resultMu.Lock()
					load.errors = append(load.errors, err.Error())
					resultMu.Unlock()
					return
				}
				if len(events) == 0 {
					if claimed.Load() >= backlog {
						return
					}
					select {
					case <-ctx.Done():
						failed.Add(1)
						resultMu.Lock()
						load.errors = append(load.errors, ctx.Err().Error())
						resultMu.Unlock()
						return
					default:
						runtime.Gosched()
						continue
					}
				}
				claimed.Add(int64(len(events)))
				for _, event := range events {
					markStarted := time.Now()
					err := store.MarkPublished(ctx, outbox.Completion{EventID: event.ID, LeaseToken: leaseToken})
					latency := claimLatency/time.Duration(len(events)) + time.Since(markStarted)
					resultMu.Lock()
					load.latencies = append(load.latencies, latency)
					resultMu.Unlock()
					if err != nil {
						failed.Add(1)
						resultMu.Lock()
						load.errors = append(load.errors, err.Error())
						resultMu.Unlock()
						continue
					}
					succeeded.Add(1)
				}
			}
		}()
	}
	wait.Wait()
	load.succeeded = succeeded.Load()
	load.failed = failed.Load()
	return load
}

func compareWalletClaimIndex(
	t *testing.T,
	ctx context.Context,
	runtimeDB, migratorDB, observerDB *sql.DB,
	rowCount, iterations int,
) (postgresHighConcurrencyResult, postgresHighConcurrencyResult) {
	t.Helper()
	seedWalletClaimIndexRows(t, ctx, migratorDB, rowCount)
	defer cleanupWalletClaimIndexRows(t, migratorDB)
	if _, err := migratorDB.ExecContext(ctx, `DROP INDEX IF EXISTS rgs_wallet_transactions_round_claim`); err != nil {
		t.Fatal(err)
	}
	recreated := false
	defer func() {
		if recreated {
			return
		}
		if _, err := migratorDB.ExecContext(context.Background(), highConcurrencyWalletIndexSQL); err != nil {
			t.Errorf("restore wallet claim index: %v", err)
		}
	}()
	if _, err := migratorDB.ExecContext(ctx, `ANALYZE rgs_wallet_transactions`); err != nil {
		t.Fatal(err)
	}
	targetSession := fmt.Sprintf("hc-index-session-%d", rowCount)
	targetRound := fmt.Sprintf("hc-index-round-%d", rowCount)
	baseline := measureWalletClaimLookup(
		t, ctx, runtimeDB, observerDB, "wallet_claim_lookup_without_round_index",
		targetSession, targetRound, iterations,
	)
	if _, err := migratorDB.ExecContext(ctx, highConcurrencyWalletIndexSQL); err != nil {
		t.Fatal(err)
	}
	recreated = true
	if _, err := migratorDB.ExecContext(ctx, `ANALYZE rgs_wallet_transactions`); err != nil {
		t.Fatal(err)
	}
	optimized := measureWalletClaimLookup(
		t, ctx, runtimeDB, observerDB, "wallet_claim_lookup_with_round_index",
		targetSession, targetRound, iterations,
	)
	return baseline, optimized
}

func seedWalletClaimIndexRows(t *testing.T, ctx context.Context, database *sql.DB, count int) {
	t.Helper()
	cleanupWalletClaimIndexRows(t, database)
	tx, err := database.BeginTx(ctx, &sql.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	statements := []string{`
		INSERT INTO rgs_sessions (
			operator_id, session_id, player_id, wallet_account_id, wallet_session_id,
			game_id, definition_version, definition_hash, currency, currency_exponent,
			jurisdiction, status, balance_snapshot_minor, sequence, revision, feature_state,
			expires_at
		)
		SELECT 'hc-index-op', 'hc-index-session-'||item,
			'hc-index-player-'||item, 'hc-index-wallet-'||item, 'hc-index-wallet-session-'||item,
			'game-a', 'math-v1', repeat('a',64), 'USD', 2, 'MT', 'BLOCKED',
			1000000, 0, 0, '{}'::jsonb, clock_timestamp()+interval '1 hour'
		FROM generate_series(1,$1) AS item`, `
		INSERT INTO rgs_rounds (
			operator_id, session_id, round_id, server_transaction_id,
			request_fingerprint, status, round_kind, game_id, definition_version,
			definition_hash, currency, bet_minor, input_feature_state, charged_minor,
			win_minor, starting_revision, resulting_revision, sequence, result_json,
			outcome_hash, wallet_phase, next_attempt_at, created_at, updated_at
		)
		SELECT 'hc-index-op', 'hc-index-session-'||item, 'hc-index-round-'||item,
			'rgs-op-v1:hc-index-'||item, 'rgs-fp-v2:'||repeat('a',64),
			'MANUAL_REVIEW', 'BASE', 'game-a', 'math-v1', repeat('a',64), 'USD',
			100, '{}'::jsonb, 100, 0, 0, 1, 1, '{}'::jsonb, repeat('a',64),
			'', NULL, clock_timestamp(), clock_timestamp()
		FROM generate_series(1,$1) AS item`, `
		INSERT INTO rgs_wallet_transactions (
			operator_id, transaction_id, session_id, round_id, kind, status,
			currency, amount_minor, request_fingerprint
		)
		SELECT 'hc-index-op', 'rgs-op-v1:hc-index-'||item,
			'hc-index-session-'||item, 'hc-index-round-'||item,
			'PLAY', 'PENDING', 'USD', 100, 'rgs-fp-v2:'||repeat('a',64)
		FROM generate_series(1,$1) AS item`}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement, count); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func cleanupWalletClaimIndexRows(t *testing.T, database *sql.DB) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for _, statement := range []string{
		`DELETE FROM rgs_wallet_transactions WHERE operator_id='hc-index-op'`,
		`DELETE FROM rgs_rounds WHERE operator_id='hc-index-op'`,
		`DELETE FROM rgs_sessions WHERE operator_id='hc-index-op'`,
	} {
		if _, err := database.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
}

func measureWalletClaimLookup(
	t *testing.T,
	ctx context.Context,
	runtimeDB, observerDB *sql.DB,
	name, sessionID, roundID string,
	iterations int,
) postgresHighConcurrencyResult {
	t.Helper()
	query := walletClaimLedgerSelect
	for warmup := 0; warmup < 10; warmup++ {
		rows, err := runtimeDB.QueryContext(ctx, query, "hc-index-op", sessionID, roundID)
		if err != nil {
			t.Fatal(err)
		}
		rows.Close()
	}
	plan := explainWalletClaimLookup(t, ctx, observerDB, sessionID, roundID)
	return measurePostgresLoad(t, ctx, runtimeDB, observerDB, name, 1, func(ctx context.Context) measuredLoad {
		load := measuredLoad{attempted: int64(iterations)}
		for iteration := 0; iteration < iterations; iteration++ {
			started := time.Now()
			rows, err := runtimeDB.QueryContext(ctx, query, "hc-index-op", sessionID, roundID)
			if err == nil {
				for rows.Next() {
					var operatorID, transactionID, persistedSessionID, persistedRoundID string
					var kind, status, currency, fingerprint string
					var amount int64
					err = rows.Scan(&operatorID, &transactionID, &persistedSessionID, &persistedRoundID,
						&kind, &status, &currency, &amount, &fingerprint)
				}
				if rowErr := rows.Err(); err == nil {
					err = rowErr
				}
				rows.Close()
			}
			load.latencies = append(load.latencies, time.Since(started))
			if err != nil {
				load.failed++
				load.errors = append(load.errors, err.Error())
			} else {
				load.succeeded++
			}
		}
		return load
	}).WithPlan(plan)
}

func explainWalletClaimLookup(t *testing.T, ctx context.Context, database *sql.DB, sessionID, roundID string) string {
	t.Helper()
	var encoded []byte
	err := database.QueryRowContext(ctx, `
		EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
		SELECT operator_id, transaction_id, session_id, round_id, kind, status,
			currency, amount_minor, request_fingerprint
		FROM rgs_wallet_transactions
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
		ORDER BY transaction_id
		FOR UPDATE`, "hc-index-op", sessionID, roundID).Scan(&encoded)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func (result postgresHighConcurrencyResult) WithPlan(plan string) postgresHighConcurrencyResult {
	result.Plan = plan
	return result
}

func measurePostgresLoad(
	t *testing.T,
	ctx context.Context,
	runtimeDB, observerDB *sql.DB,
	name string,
	concurrency int,
	run func(context.Context) measuredLoad,
) postgresHighConcurrencyResult {
	t.Helper()
	beforeStats := runtimeDB.Stats()
	beforeWAL := readWALLSN(ctx, observerDB)
	monitor := startLockMonitor(ctx, observerDB)
	started := time.Now()
	load := run(ctx)
	duration := time.Since(started)
	maximumLockWaiters, lockSamples := monitor.stop()
	afterWAL := readWALLSN(ctx, observerDB)
	afterStats := runtimeDB.Stats()
	walBytes := walDifference(ctx, observerDB, beforeWAL, afterWAL)
	result := postgresHighConcurrencyResult{
		Name: name, Concurrency: concurrency,
		Attempted: load.attempted, Succeeded: load.succeeded, Failed: load.failed,
		DurationMillis:       duration.Milliseconds(),
		ConnectionWaitCount:  int64(afterStats.WaitCount - beforeStats.WaitCount),
		ConnectionWaitMillis: (afterStats.WaitDuration - beforeStats.WaitDuration).Milliseconds(),
		MaximumOpenConns:     afterStats.MaxOpenConnections,
		MaximumLockWaiters:   maximumLockWaiters, LockSamples: lockSamples,
		WALBytes: walBytes, Errors: boundedLoadErrors(load.errors),
	}
	if duration > 0 {
		result.ThroughputPerSecond = float64(load.succeeded) / duration.Seconds()
	}
	result.P50Millis = percentileMilliseconds(load.latencies, 0.50)
	result.P95Millis = percentileMilliseconds(load.latencies, 0.95)
	result.P99Millis = percentileMilliseconds(load.latencies, 0.99)
	return result
}

type lockMonitor struct {
	cancel  context.CancelFunc
	done    chan struct{}
	max     atomic.Int64
	samples atomic.Int64
}

func startLockMonitor(parent context.Context, database *sql.DB) *lockMonitor {
	ctx, cancel := context.WithCancel(parent)
	monitor := &lockMonitor{cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(monitor.done)
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				var waiters int64
				err := database.QueryRowContext(ctx, `
					SELECT count(*) FROM pg_stat_activity
					WHERE datname=current_database() AND wait_event_type='Lock'`).Scan(&waiters)
				if err != nil {
					continue
				}
				monitor.samples.Add(1)
				for current := monitor.max.Load(); waiters > current; current = monitor.max.Load() {
					if monitor.max.CompareAndSwap(current, waiters) {
						break
					}
				}
			}
		}
	}()
	return monitor
}

func (monitor *lockMonitor) stop() (int64, int64) {
	monitor.cancel()
	<-monitor.done
	return monitor.max.Load(), monitor.samples.Load()
}

func readWALLSN(ctx context.Context, database *sql.DB) string {
	var lsn string
	if err := database.QueryRowContext(ctx, `SELECT pg_current_wal_lsn()::text`).Scan(&lsn); err != nil {
		return ""
	}
	return lsn
}

func walDifference(ctx context.Context, database *sql.DB, before, after string) int64 {
	if before == "" || after == "" {
		return -1
	}
	var bytes int64
	if err := database.QueryRowContext(ctx,
		`SELECT pg_wal_lsn_diff($1::pg_lsn,$2::pg_lsn)::bigint`, after, before,
	).Scan(&bytes); err != nil {
		return -1
	}
	return bytes
}

func percentileMilliseconds(values []time.Duration, percentile float64) float64 {
	if len(values) == 0 {
		return 0
	}
	ordered := append([]time.Duration(nil), values...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i] < ordered[j] })
	index := int(float64(len(ordered)-1) * percentile)
	return float64(ordered[index]) / float64(time.Millisecond)
}

func collectDurations(values <-chan time.Duration) []time.Duration {
	var collected []time.Duration
	for value := range values {
		collected = append(collected, value)
	}
	return collected
}

func collectErrors(values <-chan string) []string {
	var collected []string
	for value := range values {
		collected = append(collected, value)
	}
	return collected
}

func boundedLoadErrors(values []string) []string {
	if len(values) > 8 {
		return append(append([]string(nil), values[:8]...), fmt.Sprintf("%d additional errors", len(values)-8))
	}
	return values
}

func highConcurrencyEnvInt(t *testing.T, name string, fallback, minimum, maximum int) int {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		t.Fatalf("%s must be an integer in [%d,%d]", name, minimum, maximum)
	}
	return value
}

func highConcurrencyStepLevels(t *testing.T) []int {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv("RGS_HIGH_CONCURRENCY_STEP_LEVELS"))
	if raw == "" {
		raw = "1,4,16,32"
	}
	parts := strings.Split(raw, ",")
	levels := make([]int, 0, len(parts))
	for _, part := range parts {
		value, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || value < 1 || value > 512 {
			t.Fatalf("RGS_HIGH_CONCURRENCY_STEP_LEVELS contains invalid value %q", part)
		}
		levels = append(levels, value)
	}
	return levels
}

func highConcurrencyThresholds(t *testing.T) postgresHighConcurrencyThresholds {
	t.Helper()
	return postgresHighConcurrencyThresholds{
		MaxP99Millis:             optionalHighConcurrencyFloat(t, "RGS_HIGH_CONCURRENCY_MAX_P99_MILLIS"),
		MaxConnectionWaitCount:   optionalHighConcurrencyInt64(t, "RGS_HIGH_CONCURRENCY_MAX_CONNECTION_WAIT_COUNT"),
		MaxConnectionWaitMillis:  optionalHighConcurrencyInt64(t, "RGS_HIGH_CONCURRENCY_MAX_CONNECTION_WAIT_MILLIS"),
		MaxWALBytesPerSuccessful: optionalHighConcurrencyFloat(t, "RGS_HIGH_CONCURRENCY_MAX_WAL_BYTES_PER_SUCCESS"),
	}
}

func optionalHighConcurrencyFloat(t *testing.T, name string) *float64 {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return nil
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || value < 0 || math.IsNaN(value) || math.IsInf(value, 0) {
		t.Fatalf("%s must be a non-negative finite number", name)
	}
	return &value
}

func optionalHighConcurrencyInt64(t *testing.T, name string) *int64 {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 {
		t.Fatalf("%s must be a non-negative integer", name)
	}
	return &value
}

func highConcurrencyAssessmentMode(thresholds postgresHighConcurrencyThresholds) string {
	configured := 0
	for _, present := range []bool{
		thresholds.MaxP99Millis != nil,
		thresholds.MaxConnectionWaitCount != nil,
		thresholds.MaxConnectionWaitMillis != nil,
		thresholds.MaxWALBytesPerSuccessful != nil,
	} {
		if present {
			configured++
		}
	}
	if configured == 0 {
		return "report-only"
	}
	if configured == 4 {
		return "local-threshold-enforced-nonrelease"
	}
	return "partial-local-threshold-enforced-nonrelease"
}

func validateHighConcurrencyReport(report postgresHighConcurrencyReport) []string {
	var failures []string
	byName := make(map[string]postgresHighConcurrencyResult, len(report.Scenarios))
	for _, scenario := range report.Scenarios {
		if _, duplicate := byName[scenario.Name]; duplicate {
			failures = append(failures, fmt.Sprintf("duplicate scenario %s", scenario.Name))
		}
		byName[scenario.Name] = scenario
		if scenario.Attempted <= 0 {
			failures = append(failures, fmt.Sprintf("%s attempted no operations", scenario.Name))
		}
		if scenario.Failed != 0 || scenario.Succeeded != scenario.Attempted || len(scenario.Errors) != 0 {
			failures = append(failures, fmt.Sprintf(
				"%s functional result attempted=%d succeeded=%d failed=%d errors=%d",
				scenario.Name, scenario.Attempted, scenario.Succeeded, scenario.Failed, len(scenario.Errors),
			))
		}
		if threshold := report.Thresholds.MaxP99Millis; threshold != nil && scenario.P99Millis > *threshold {
			failures = append(failures, fmt.Sprintf("%s p99 %.3fms exceeds %.3fms", scenario.Name, scenario.P99Millis, *threshold))
		}
		if threshold := report.Thresholds.MaxConnectionWaitCount; threshold != nil && scenario.ConnectionWaitCount > *threshold {
			failures = append(failures, fmt.Sprintf("%s connection wait count %d exceeds %d", scenario.Name, scenario.ConnectionWaitCount, *threshold))
		}
		if threshold := report.Thresholds.MaxConnectionWaitMillis; threshold != nil && scenario.ConnectionWaitMillis > *threshold {
			failures = append(failures, fmt.Sprintf("%s connection wait %dms exceeds %dms", scenario.Name, scenario.ConnectionWaitMillis, *threshold))
		}
		if threshold := report.Thresholds.MaxWALBytesPerSuccessful; threshold != nil {
			if scenario.WALBytes < 0 || scenario.Succeeded <= 0 {
				failures = append(failures, fmt.Sprintf("%s WAL budget cannot be evaluated", scenario.Name))
			} else if perOperation := float64(scenario.WALBytes) / float64(scenario.Succeeded); perOperation > *threshold {
				failures = append(failures, fmt.Sprintf("%s WAL %.1f bytes/op exceeds %.1f", scenario.Name, perOperation, *threshold))
			}
		}
	}
	for _, suffix := range []string{
		"steady_distinct_operators", "hot_operator_many_sessions",
		"hot_session_lock_contention", "recovery_backlog", "outbox_backlog",
	} {
		baselineName, optimizedName := "baseline_"+suffix, "optimized_"+suffix
		baselineScenario, baselinePresent := byName[baselineName]
		optimizedScenario, optimizedPresent := byName[optimizedName]
		if !baselinePresent || !optimizedPresent {
			failures = append(failures, fmt.Sprintf("matched A/B scenario pair %s is incomplete", suffix))
		} else if baselineScenario.Attempted != optimizedScenario.Attempted {
			failures = append(failures, fmt.Sprintf("matched A/B scenario pair %s attempted %d versus %d operations",
				suffix, baselineScenario.Attempted, optimizedScenario.Attempted))
		}
	}
	stepPairs := 0
	for name, baselineScenario := range byName {
		if !strings.HasPrefix(name, "baseline_step_") {
			continue
		}
		stepPairs++
		optimizedName := "optimized_" + strings.TrimPrefix(name, "baseline_")
		optimizedScenario, present := byName[optimizedName]
		if !present || optimizedScenario.Attempted != baselineScenario.Attempted {
			failures = append(failures, fmt.Sprintf("matched A/B step pair %s is missing or has unequal attempts", name))
		}
	}
	if stepPairs == 0 {
		failures = append(failures, "no matched concurrency step scenario was recorded")
	}
	baseline, ok := byName["wallet_claim_lookup_without_round_index"]
	if !ok || !explainPlanContains(baseline.Plan, "Seq Scan", "rgs_wallet_transactions", "") {
		failures = append(failures, "wallet claim baseline plan did not contain the required rgs_wallet_transactions Seq Scan")
	}
	optimized, ok := byName["wallet_claim_lookup_with_round_index"]
	if !ok || (!explainPlanContains(optimized.Plan, "Index Scan", "rgs_wallet_transactions", "rgs_wallet_transactions_round_claim") &&
		!explainPlanContains(optimized.Plan, "Bitmap Index Scan", "", "rgs_wallet_transactions_round_claim")) {
		failures = append(failures, "wallet claim optimized plan did not use rgs_wallet_transactions_round_claim")
	}
	return failures
}

func explainPlanContains(encoded, nodeType, relationName, indexName string) bool {
	var document any
	if json.Unmarshal([]byte(encoded), &document) != nil {
		return false
	}
	var visit func(any) bool
	visit = func(value any) bool {
		switch typed := value.(type) {
		case []any:
			for _, child := range typed {
				if visit(child) {
					return true
				}
			}
		case map[string]any:
			if typed["Node Type"] == nodeType &&
				(relationName == "" || typed["Relation Name"] == relationName) &&
				(indexName == "" || typed["Index Name"] == indexName) {
				return true
			}
			for _, child := range typed {
				if visit(child) {
					return true
				}
			}
		}
		return false
	}
	return visit(document)
}

func TestValidateHighConcurrencyReportRejectsFunctionalAndPlanFailures(t *testing.T) {
	validPlan := `[{"Plan":{"Node Type":"Index Scan","Relation Name":"rgs_wallet_transactions","Index Name":"rgs_wallet_transactions_round_claim"}}]`
	broken := postgresHighConcurrencyReport{Scenarios: []postgresHighConcurrencyResult{
		{Name: "steady", Attempted: 2, Succeeded: 1, Failed: 1, Errors: []string{"boom"}},
		{Name: "wallet_claim_lookup_without_round_index", Attempted: 1, Succeeded: 1, Plan: validPlan},
		{Name: "wallet_claim_lookup_with_round_index", Attempted: 1, Succeeded: 1, Plan: `[{"Plan":{"Node Type":"Seq Scan","Relation Name":"rgs_wallet_transactions"}}]`},
	}}
	failures := strings.Join(validateHighConcurrencyReport(broken), "\n")
	for _, required := range []string{"steady functional result", "baseline plan", "optimized plan"} {
		if !strings.Contains(failures, required) {
			t.Fatalf("validation failures %q are missing %q", failures, required)
		}
	}
}

func TestValidateHighConcurrencyReportEnforcesConfiguredThresholds(t *testing.T) {
	maxP99, maxWaitCount, maxWaitMillis, maxWAL := 5.0, int64(0), int64(0), 100.0
	report := postgresHighConcurrencyReport{
		Thresholds: postgresHighConcurrencyThresholds{
			MaxP99Millis: &maxP99, MaxConnectionWaitCount: &maxWaitCount,
			MaxConnectionWaitMillis: &maxWaitMillis, MaxWALBytesPerSuccessful: &maxWAL,
		},
		Scenarios: []postgresHighConcurrencyResult{
			{Name: "steady", Attempted: 1, Succeeded: 1, P99Millis: 6, ConnectionWaitCount: 1, ConnectionWaitMillis: 2, WALBytes: 101},
			{Name: "wallet_claim_lookup_without_round_index", Attempted: 1, Succeeded: 1, WALBytes: 1,
				Plan: `[{"Plan":{"Node Type":"Seq Scan","Relation Name":"rgs_wallet_transactions"}}]`},
			{Name: "wallet_claim_lookup_with_round_index", Attempted: 1, Succeeded: 1, WALBytes: 1,
				Plan: `[{"Plan":{"Node Type":"Index Scan","Relation Name":"rgs_wallet_transactions","Index Name":"rgs_wallet_transactions_round_claim"}}]`},
		},
	}
	failures := strings.Join(validateHighConcurrencyReport(report), "\n")
	for _, required := range []string{"p99", "connection wait count", "connection wait 2ms", "WAL"} {
		if !strings.Contains(failures, required) {
			t.Fatalf("validation failures %q are missing %q", failures, required)
		}
	}
}
