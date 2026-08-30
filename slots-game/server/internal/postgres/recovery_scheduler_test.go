package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"slots-game/server/internal/game"
	"slots-game/server/internal/recovery"
	"slots-game/server/internal/rgs"
)

func TestRecoverableRoundClaimUsesDueIndexFairRankingAndSkipLocked(t *testing.T) {
	for _, required := range []string{
		"row_number() OVER",
		"PARTITION BY r.operator_id",
		"r.next_attempt_at <= $1",
		"r.wallet_lease_until IS NULL OR r.wallet_lease_until <= $1",
		"s.pending_round_id=r.round_id AND s.revision=r.starting_revision",
		"ORDER BY q.operator_rank",
		"t.last_claimed_at",
		"LIMIT $2",
		"FOR UPDATE OF claim_session, t SKIP LOCKED",
	} {
		if !strings.Contains(recoverableRoundClaimSQL, required) {
			t.Fatalf("recoverable claim SQL is missing %q", required)
		}
	}
	if strings.Contains(recoverableRoundClaimSQL, "SELECT DISTINCT") ||
		strings.Contains(recoverableRoundClaimSQL, "INSERT INTO rgs_wallet_recovery_operators") {
		t.Fatal("recoverable claim SQL reintroduced an unbounded operator-registry scan or write")
	}
}

func TestPrepareRoundKeepsRecoveryRegistryDriftWindowFallback(t *testing.T) {
	for _, required := range []string{
		"inserted_round AS",
		"inserted_wallet AS",
		"updated_session AS",
		"registered_recovery_operator AS",
		"INSERT INTO rgs_wallet_recovery_operators (operator_id)",
		"SELECT operator_id FROM updated_session",
		"ON CONFLICT (operator_id) DO NOTHING",
		"inserted_outbox AS",
	} {
		if !strings.Contains(prepareRoundWriteSQL, required) {
			t.Fatalf("prepare bundle SQL is missing atomic write stage %q", required)
		}
	}
}

func TestRecoverySnapshotUsesDatabaseClockAndBoundedScheduledRecoveryIndex(t *testing.T) {
	if rgs.RecoverySnapshotBacklogLimit != 501 {
		t.Fatalf("recovery snapshot limit=%d, SQL contract requires 501", rgs.RecoverySnapshotBacklogLimit)
	}
	for _, required := range []string{
		"bounded_recovery AS MATERIALIZED",
		"count(*)",
		"MIN(bounded_recovery.next_attempt_at)",
		"r.status IN ('PREPARED', 'WALLET_PENDING')",
		"r.wallet_phase IN ('APPLY', 'LOOKUP')",
		"r.next_attempt_at IS NOT NULL",
		"ORDER BY r.next_attempt_at, r.operator_id, r.updated_at, r.session_id, r.round_id",
		"LIMIT 501",
		"clock_timestamp()",
		"COALESCE(MAX(recovery_clock.now)",
	} {
		if !strings.Contains(recoverySnapshotSQL, required) {
			t.Fatalf("recovery snapshot SQL is missing %q", required)
		}
	}
	if strings.Contains(recoverySnapshotSQL, "JOIN rgs_sessions") {
		t.Fatal("bounded recovery snapshot unexpectedly performs an unbounded per-row session join")
	}

	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	repository, err := NewRepository(database)
	if err != nil {
		t.Fatal(err)
	}
	rows := sqlmock.NewRows([]string{"backlog", "oldest_due_age_millis", "observed_at"}).
		AddRow(int64(7), int64(3250), time.Unix(1_700_000_000, 0).UTC())
	mock.ExpectQuery(regexp.QuoteMeta(recoverySnapshotSQL)).WillReturnRows(rows)
	snapshot, err := repository.RecoverySnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Backlog != 7 || snapshot.OldestDueAge != 3250*time.Millisecond ||
		!snapshot.ObservedAt.Equal(time.Unix(1_700_000_000, 0).UTC()) {
		t.Fatalf("snapshot=%+v", snapshot)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestRecoverySnapshotRejectsCountBeyondBoundedContract(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	repository, err := NewRepository(database)
	if err != nil {
		t.Fatal(err)
	}
	rows := sqlmock.NewRows([]string{"backlog", "oldest_due_age_millis", "observed_at"}).
		AddRow(rgs.RecoverySnapshotBacklogLimit+1, int64(1), time.Unix(1_700_000_000, 0).UTC())
	mock.ExpectQuery(regexp.QuoteMeta(recoverySnapshotSQL)).WillReturnRows(rows)
	if _, err := repository.RecoverySnapshot(context.Background()); err == nil {
		t.Fatal("out-of-contract recovery snapshot count was accepted")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresRecoveryFairnessPersistsAcrossClaimWaves(t *testing.T) {
	databaseURLs := requirePostgresTestURLs(t)
	database, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	migrator, err := sql.Open("pgx", databaseURLs.migrator)
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	truncateIntegrationTables(t, migrator)
	defer truncateIntegrationTables(t, migrator)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repository, err := NewRepository(database)
	if err != nil {
		t.Fatal(err)
	}
	profile := rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
		"https://wallet.test.invalid/fairness-ledger",
	))
	assertFailedPrepareDoesNotRegisterRecoveryOperator(
		t, ctx, database, migrator, repository, profile,
	)
	const operatorCount = 8
	for operatorIndex := range operatorCount {
		for sessionIndex := range 2 {
			operatorID := fmt.Sprintf("operator-fair-%02d", operatorIndex)
			sessionID := fmt.Sprintf("session-fair-%02d-%d", operatorIndex, sessionIndex)
			roundID := fmt.Sprintf("round-fair-%02d-%d", operatorIndex, sessionIndex)
			preparePostgresRecoveryFixture(t, ctx, repository, profile, operatorID, sessionID, roundID)
		}
	}
	var registeredOperators, untouchedCursors int
	if err := database.QueryRowContext(ctx, `
		SELECT count(*), count(*) FILTER (
			WHERE last_claimed_at='-infinity'::timestamptz
		)
		FROM rgs_wallet_recovery_operators`,
	).Scan(&registeredOperators, &untouchedCursors); err != nil {
		t.Fatal(err)
	}
	if registeredOperators != operatorCount || untouchedCursors != operatorCount {
		t.Fatalf("PREPARE recovery registry = operators:%d untouched:%d, want %d/%d",
			registeredOperators, untouchedCursors, operatorCount, operatorCount)
	}
	snapshot, err := repository.RecoverySnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Backlog != operatorCount*2 || snapshot.OldestDueAge < 0 ||
		snapshot.ObservedAt.IsZero() || snapshot.ObservedAt.Unix() <= 0 {
		t.Fatalf("recovery snapshot before claims = %+v", snapshot)
	}

	first, err := repository.ClaimRecoverableRounds(ctx, 4, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 4 {
		t.Fatalf("first claim wave size = %d, want 4", len(first))
	}
	firstOperator := first[0].Record.Key.OperatorID
	var cursorBeforeRepeat time.Time
	if err := database.QueryRowContext(ctx, `
		SELECT last_claimed_at FROM rgs_wallet_recovery_operators WHERE operator_id=$1`,
		firstOperator,
	).Scan(&cursorBeforeRepeat); err != nil {
		t.Fatal(err)
	}
	preparePostgresRecoveryFixture(
		t, ctx, repository, profile, firstOperator,
		"session-fair-repeat", "round-fair-repeat",
	)
	var cursorAfterRepeat time.Time
	if err := database.QueryRowContext(ctx, `
		SELECT last_claimed_at FROM rgs_wallet_recovery_operators WHERE operator_id=$1`,
		firstOperator,
	).Scan(&cursorAfterRepeat); err != nil {
		t.Fatal(err)
	}
	if !cursorAfterRepeat.Equal(cursorBeforeRepeat) {
		t.Fatalf("repeat PREPARE reset fairness cursor: before=%s after=%s",
			cursorBeforeRepeat, cursorAfterRepeat)
	}
	second, err := repository.ClaimRecoverableRounds(ctx, 4, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 4 {
		t.Fatalf("claim wave sizes = first:%d second:%d", len(first), len(second))
	}
	firstOperators := make(map[string]struct{}, len(first))
	for _, claim := range first {
		firstOperators[claim.Record.Key.OperatorID] = struct{}{}
	}
	for _, claim := range second {
		if _, repeated := firstOperators[claim.Record.Key.OperatorID]; repeated {
			t.Fatalf("operator %q was reclaimed before unserved operators: first=%+v second=%+v",
				claim.Record.Key.OperatorID, first, second)
		}
	}
	var advancedCursors int
	if err := database.QueryRowContext(ctx, `
		SELECT count(*) FROM rgs_wallet_recovery_operators
		WHERE last_claimed_at > '-infinity'::timestamptz`,
	).Scan(&advancedCursors); err != nil {
		t.Fatal(err)
	}
	if advancedCursors != operatorCount {
		t.Fatalf("advanced fairness cursors = %d, want %d", advancedCursors, operatorCount)
	}
}

func TestPostgresRollingOldPrepareIsRecoverableByNewWorker(t *testing.T) {
	databaseURLs := requirePostgresTestURLs(t)
	database, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	migrator, err := sql.Open("pgx", databaseURLs.migrator)
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	truncateIntegrationTables(t, migrator)
	defer truncateIntegrationTables(t, migrator)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repository, err := NewRepository(database)
	if err != nil {
		t.Fatal(err)
	}
	var runtimeRole string
	if err := database.QueryRowContext(ctx, `SELECT current_user`).Scan(&runtimeRole); err != nil {
		t.Fatal(err)
	}
	if runtimeRole != CanonicalRuntimeRole {
		t.Fatalf("rolling writer role = %q, want %q", runtimeRole, CanonicalRuntimeRole)
	}
	const (
		operatorID = "operator-rolling-old-api"
		sessionID  = "session-rolling-old-api"
		roundID    = "round-rolling-old-api"
	)
	hash := strings.Repeat("a", 64)
	session := rgs.Session{
		OperatorID: operatorID, SessionID: sessionID,
		PlayerID: "player-rolling-old-api", WalletAccountID: "wallet-rolling-old-api",
		WalletSessionID: "wallet-session-rolling-old-api",
		GameID:          "game-a", DefinitionVersion: "math-v1", DefinitionHash: hash,
		Currency: "USD", CurrencyExponent: 2, Jurisdiction: "MT",
		Status: rgs.SessionActive, BalanceMinor: 10_000,
		Feature:        game.EmptyFeatureState(),
		ExpiresAt:      time.Now().UTC().Add(time.Hour),
		IdleDisconnect: 20 * time.Minute, IdleDisconnectAt: time.Now().UTC().Add(20 * time.Minute),
		TransportGeneration: 1,
	}
	if err := repository.CreateSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	var registered int
	if err := database.QueryRowContext(ctx, `
		SELECT count(*) FROM rgs_wallet_recovery_operators WHERE operator_id=$1`,
		operatorID,
	).Scan(&registered); err != nil {
		t.Fatal(err)
	}
	if registered != 0 {
		t.Fatalf("new operator was registered before a recoverable round: %d", registered)
	}

	request := rgs.SpinRequest{
		OperatorID: operatorID, SessionID: sessionID, RoundID: roundID,
		GameID: session.GameID, DefinitionVersion: session.DefinitionVersion,
		DefinitionHash: hash, Currency: session.Currency,
		RoundKind: rgs.RoundKindBase, BetMinor: 100, TransportGeneration: 1,
	}
	result := validPreparedSessionIntegrityResult(request, 1)
	result.ServerTransactionID = "rgs-op-v1:" + roundID
	profile := rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
		"https://wallet.test.invalid/rolling-old-api-ledger",
	))
	// 该 helper 保留旧 API 的多语句 PREPARE，不包含新版本的 registry CTE。
	// English: This helper retains the multi-statement PREPARE of the old API and does not include the new version of
	// the registry CTE.
	if _, prepared, err := prepareRoundLegacyForLoad(
		ctx, repository, request, rgs.FingerprintFor(request), profile, func(rgs.Session) (rgs.SpinResult, error) {
			return result, nil
		},
	); err != nil || !prepared {
		t.Fatalf("legacy PrepareRound() = prepared:%v error:%v", prepared, err)
	}
	if err := database.QueryRowContext(ctx, `
		SELECT count(*) FROM rgs_wallet_recovery_operators WHERE operator_id=$1`,
		operatorID,
	).Scan(&registered); err != nil {
		t.Fatal(err)
	}
	if registered != 1 {
		t.Fatalf("legacy PREPARE trigger registration = %d, want 1", registered)
	}
	// backfill 只扫描可领取 phase；若旧数据稍后从不可领取 phase 修复为 APPLY，
	// UPDATE 触发器必须补注册，避免为了走部分索引引入永久假阴性。
	// English: The backfill only scans the retrievable phase; if the old data is later restored from the retrievable
	// phase to APPLY, the UPDATE trigger must be re-registered to avoid introducing permanent false negatives for
	// partial indexing.
	if _, err := migrator.ExecContext(ctx,
		`DELETE FROM rgs_wallet_recovery_operators WHERE operator_id=$1`, operatorID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `
		UPDATE rgs_rounds SET wallet_phase=''
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3`,
		operatorID, sessionID, roundID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `
		UPDATE rgs_rounds SET wallet_phase='APPLY'
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3`,
		operatorID, sessionID, roundID,
	); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `
		SELECT count(*) FROM rgs_wallet_recovery_operators WHERE operator_id=$1`,
		operatorID,
	).Scan(&registered); err != nil {
		t.Fatal(err)
	}
	if registered != 1 {
		t.Fatalf("recovery phase transition trigger registration = %d, want 1", registered)
	}

	claims, err := repository.ClaimRecoverableRounds(ctx, 1, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 1 || claims[0].Record.Key != request.Key() ||
		claims[0].Action != rgs.WalletRecoveryApply {
		t.Fatalf("new worker claim after legacy PREPARE = %+v", claims)
	}
}

const testRecoveryRegistryTriggerInstallSQL = `
	CREATE TRIGGER rgs_register_wallet_recovery_operator_insert
	AFTER INSERT ON rgs_rounds
	FOR EACH ROW
	WHEN (
		NEW.status IN ('PREPARED', 'WALLET_PENDING')
		AND NEW.wallet_phase IN ('APPLY', 'LOOKUP')
	)
	EXECUTE FUNCTION rgs_register_wallet_recovery_operator();

	CREATE TRIGGER rgs_register_wallet_recovery_operator_recovery_update
	AFTER UPDATE OF status, wallet_phase ON rgs_rounds
	FOR EACH ROW
	WHEN (
		NEW.status IN ('PREPARED', 'WALLET_PENDING')
		AND NEW.wallet_phase IN ('APPLY', 'LOOKUP')
		AND (
			OLD.status NOT IN ('PREPARED', 'WALLET_PENDING')
			OR OLD.wallet_phase NOT IN ('APPLY', 'LOOKUP')
		)
	)
	EXECUTE FUNCTION rgs_register_wallet_recovery_operator()`

func TestPostgresWalletRecoveryRegistryMigrationFencesRollingWriters(t *testing.T) {
	databaseURLs := requirePostgresTestURLs(t)
	database, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	migrator, err := sql.Open("pgx", databaseURLs.migrator)
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repository, err := NewRepository(database)
	if err != nil {
		t.Fatal(err)
	}
	defer restoreRecoveryRegistryTriggers(t, migrator)

	t.Run("writer committed before migration lock is backfilled", func(t *testing.T) {
		truncateIntegrationTables(t, migrator)
		dropRecoveryRegistryTriggers(t, ctx, migrator)
		request, profile, outcome := createRollingLegacyPrepareFixture(
			t, ctx, repository, "before-lock",
		)

		writerAtCommit := make(chan struct{})
		releaseWriter := make(chan struct{})
		writerDone := startRollingLegacyPrepare(
			ctx, repository, request, profile, outcome, writerAtCommit, releaseWriter,
		)
		waitForSignal(t, ctx, writerAtCommit, "old writer before migration lock")

		migrationStarted := make(chan struct{})
		migrationDone := make(chan error, 1)
		go func() {
			tx, beginErr := migrator.BeginTx(ctx, nil)
			if beginErr != nil {
				migrationDone <- beginErr
				return
			}
			defer tx.Rollback()
			close(migrationStarted)
			if _, lockErr := tx.ExecContext(ctx,
				`LOCK TABLE rgs_rounds IN SHARE ROW EXCLUSIVE MODE`); lockErr != nil {
				migrationDone <- lockErr
				return
			}
			if backfillErr := backfillAndInstallRecoveryRegistryTriggers(ctx, tx); backfillErr != nil {
				migrationDone <- backfillErr
				return
			}
			migrationDone <- tx.Commit()
		}()
		waitForSignal(t, ctx, migrationStarted, "migration lock attempt")
		assertStillBlocked(t, migrationDone, "migration lock passed an uncommitted old writer")

		close(releaseWriter)
		if err := waitForResult(t, ctx, writerDone, "old writer commit"); err != nil {
			t.Fatal(err)
		}
		if err := waitForResult(t, ctx, migrationDone, "migration after old writer"); err != nil {
			t.Fatal(err)
		}
		assertRecoveryOperatorRegisteredAndClaimable(t, ctx, database, repository, request)
	})

	t.Run("writer blocked after migration lock uses committed trigger", func(t *testing.T) {
		truncateIntegrationTables(t, migrator)
		dropRecoveryRegistryTriggers(t, ctx, migrator)
		request, profile, outcome := createRollingLegacyPrepareFixture(
			t, ctx, repository, "after-lock",
		)

		migration, err := migrator.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer migration.Rollback()
		if _, err := migration.ExecContext(ctx,
			`LOCK TABLE rgs_rounds IN SHARE ROW EXCLUSIVE MODE`); err != nil {
			t.Fatal(err)
		}
		if err := backfillAndInstallRecoveryRegistryTriggers(ctx, migration); err != nil {
			t.Fatal(err)
		}

		writerAtCommit := make(chan struct{})
		releaseWriter := make(chan struct{})
		writerDone := startRollingLegacyPrepare(
			ctx, repository, request, profile, outcome, writerAtCommit, releaseWriter,
		)
		assertStillBlocked(t, writerDone, "old writer bypassed the migration table lock")
		select {
		case <-writerAtCommit:
			t.Fatal("old writer reached commit before migration published its trigger")
		default:
		}

		if err := migration.Commit(); err != nil {
			t.Fatal(err)
		}
		waitForSignal(t, ctx, writerAtCommit, "old writer after migration commit")
		close(releaseWriter)
		if err := waitForResult(t, ctx, writerDone, "old writer after migration lock"); err != nil {
			t.Fatal(err)
		}
		assertRecoveryOperatorRegisteredAndClaimable(t, ctx, database, repository, request)
	})
}

func dropRecoveryRegistryTriggers(t *testing.T, ctx context.Context, migrator *sql.DB) {
	t.Helper()
	if _, err := migrator.ExecContext(ctx, `
		DROP TRIGGER IF EXISTS rgs_register_wallet_recovery_operator_insert ON rgs_rounds;
		DROP TRIGGER IF EXISTS rgs_register_wallet_recovery_operator_recovery_update ON rgs_rounds`); err != nil {
		t.Fatal(err)
	}
}

func restoreRecoveryRegistryTriggers(t *testing.T, migrator *sql.DB) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := migrator.ExecContext(ctx, `
		DROP TRIGGER IF EXISTS rgs_register_wallet_recovery_operator_insert ON rgs_rounds;
		DROP TRIGGER IF EXISTS rgs_register_wallet_recovery_operator_recovery_update ON rgs_rounds`); err != nil {
		t.Errorf("drop recovery registry test triggers: %v", err)
		return
	}
	if _, err := migrator.ExecContext(ctx, testRecoveryRegistryTriggerInstallSQL); err != nil {
		t.Errorf("restore recovery registry triggers: %v", err)
	}
}

func backfillAndInstallRecoveryRegistryTriggers(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO rgs_wallet_recovery_operators (operator_id)
		SELECT DISTINCT operator_id
		FROM rgs_rounds
		WHERE status IN ('PREPARED', 'WALLET_PENDING')
		  AND wallet_phase IN ('APPLY', 'LOOKUP')
		ON CONFLICT (operator_id) DO NOTHING`); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, testRecoveryRegistryTriggerInstallSQL)
	return err
}

func createRollingLegacyPrepareFixture(
	t *testing.T,
	ctx context.Context,
	repository *Repository,
	suffix string,
) (rgs.SpinRequest, rgs.Profile, rgs.SpinResult) {
	t.Helper()
	hash := strings.Repeat("a", 64)
	session := rgs.Session{
		OperatorID: "operator-rolling-" + suffix, SessionID: "session-rolling-" + suffix,
		PlayerID: "player-rolling-" + suffix, WalletAccountID: "wallet-rolling-" + suffix,
		WalletSessionID: "wallet-session-rolling-" + suffix,
		GameID:          "game-a", DefinitionVersion: "math-v1", DefinitionHash: hash,
		Currency: "USD", CurrencyExponent: 2, Jurisdiction: "MT",
		Status: rgs.SessionActive, BalanceMinor: 10_000,
		Feature: game.EmptyFeatureState(), ExpiresAt: time.Now().UTC().Add(time.Hour),
		IdleDisconnect: 20 * time.Minute, IdleDisconnectAt: time.Now().UTC().Add(20 * time.Minute),
		TransportGeneration: 1,
	}
	if err := repository.CreateSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	request := rgs.SpinRequest{
		OperatorID: session.OperatorID, SessionID: session.SessionID,
		RoundID: "round-rolling-" + suffix,
		GameID:  session.GameID, DefinitionVersion: session.DefinitionVersion,
		DefinitionHash: hash, Currency: session.Currency,
		RoundKind: rgs.RoundKindBase, BetMinor: 100, TransportGeneration: 1,
	}
	outcome := validPreparedSessionIntegrityResult(request, 1)
	outcome.ServerTransactionID = "rgs-op-v1:" + request.RoundID
	profile := rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
		"https://wallet.test.invalid/rolling-" + suffix,
	))
	return request, profile, outcome
}

func startRollingLegacyPrepare(
	ctx context.Context,
	repository *Repository,
	request rgs.SpinRequest,
	profile rgs.Profile,
	outcome rgs.SpinResult,
	atCommit chan<- struct{},
	release <-chan struct{},
) <-chan error {
	done := make(chan error, 1)
	go func() {
		_, prepared, err := prepareRoundLegacyForLoadWithCommitHook(
			ctx, repository, request, rgs.FingerprintFor(request), profile,
			func(rgs.Session) (rgs.SpinResult, error) { return outcome, nil },
			func() error {
				close(atCommit)
				select {
				case <-release:
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			},
		)
		if err == nil && !prepared {
			err = errors.New("legacy rolling writer did not prepare a new round")
		}
		done <- err
	}()
	return done
}

func assertRecoveryOperatorRegisteredAndClaimable(
	t *testing.T,
	ctx context.Context,
	database *sql.DB,
	repository *Repository,
	request rgs.SpinRequest,
) {
	t.Helper()
	var registered int
	if err := database.QueryRowContext(ctx, `
		SELECT count(*) FROM rgs_wallet_recovery_operators WHERE operator_id=$1`,
		request.OperatorID,
	).Scan(&registered); err != nil {
		t.Fatal(err)
	}
	if registered != 1 {
		t.Fatalf("rolling registry count = %d, want 1", registered)
	}
	claims, err := repository.ClaimRecoverableRounds(ctx, 1, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 1 || claims[0].Record.Key != request.Key() {
		t.Fatalf("rolling recovery claims = %+v", claims)
	}
}

func assertStillBlocked(t *testing.T, result <-chan error, reason string) {
	t.Helper()
	select {
	case err := <-result:
		t.Fatalf("%s: completed early with %v", reason, err)
	case <-time.After(150 * time.Millisecond):
	}
}

func waitForSignal(t *testing.T, ctx context.Context, signal <-chan struct{}, operation string) {
	t.Helper()
	select {
	case <-signal:
	case <-ctx.Done():
		t.Fatalf("%s: %v", operation, ctx.Err())
	}
}

func waitForResult(t *testing.T, ctx context.Context, result <-chan error, operation string) error {
	t.Helper()
	select {
	case err := <-result:
		if err != nil {
			return fmt.Errorf("%s: %w", operation, err)
		}
		return nil
	case <-ctx.Done():
		return fmt.Errorf("%s: %w", operation, ctx.Err())
	}
}

func assertFailedPrepareDoesNotRegisterRecoveryOperator(
	t *testing.T,
	ctx context.Context,
	database *sql.DB,
	migrator *sql.DB,
	repository *Repository,
	profile rgs.Profile,
) {
	t.Helper()
	const (
		operatorID   = "operator-fair-rollback"
		sessionID    = "session-fair-rollback"
		roundID      = "round-fair-rollback"
		triggerName  = "rgs_test_fail_recovery_registration"
		functionName = "rgs_test_fail_recovery_registration"
	)
	if _, err := migrator.ExecContext(ctx, `
		CREATE OR REPLACE FUNCTION rgs_test_fail_recovery_registration()
		RETURNS trigger LANGUAGE plpgsql AS $function$
		BEGIN
			IF NEW.operator_id = 'operator-fair-rollback'
			   AND NEW.event_type = 'ROUND_PREPARED' THEN
				RAISE EXCEPTION 'forced PREPARE rollback';
			END IF;
			RETURN NEW;
		END
		$function$`); err != nil {
		t.Fatal(err)
	}
	if _, err := migrator.ExecContext(ctx, `
		DROP TRIGGER IF EXISTS rgs_test_fail_recovery_registration ON rgs_outbox`); err != nil {
		t.Fatal(err)
	}
	if _, err := migrator.ExecContext(ctx, `
		CREATE TRIGGER rgs_test_fail_recovery_registration
		BEFORE INSERT ON rgs_outbox
		FOR EACH ROW EXECUTE FUNCTION rgs_test_fail_recovery_registration()`); err != nil {
		t.Fatal(err)
	}
	triggerInstalled := true
	cleanup := func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := migrator.ExecContext(cleanupCtx,
			`DROP TRIGGER IF EXISTS `+triggerName+` ON rgs_outbox`); err != nil {
			t.Errorf("drop rollback trigger: %v", err)
		}
		if _, err := migrator.ExecContext(cleanupCtx,
			`DROP FUNCTION IF EXISTS `+functionName+`()`); err != nil {
			t.Errorf("drop rollback function: %v", err)
		}
	}
	defer func() {
		if triggerInstalled {
			cleanup()
		}
	}()

	hash := strings.Repeat("a", 64)
	session := rgs.Session{
		OperatorID: operatorID, SessionID: sessionID,
		PlayerID: "player-fair-rollback", WalletAccountID: "wallet-fair-rollback",
		WalletSessionID: "wallet-session-fair-rollback",
		GameID:          "game-a", DefinitionVersion: "math-v1", DefinitionHash: hash,
		Currency: "USD", CurrencyExponent: 2, Jurisdiction: "MT",
		Status: rgs.SessionActive, BalanceMinor: 10_000,
		Feature:        game.EmptyFeatureState(),
		ExpiresAt:      time.Now().UTC().Add(time.Hour),
		IdleDisconnect: 20 * time.Minute, IdleDisconnectAt: time.Now().UTC().Add(20 * time.Minute),
		TransportGeneration: 1,
	}
	if err := repository.CreateSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	request := rgs.SpinRequest{
		OperatorID: operatorID, SessionID: sessionID, RoundID: roundID,
		GameID: session.GameID, DefinitionVersion: session.DefinitionVersion,
		DefinitionHash: hash, Currency: session.Currency,
		RoundKind: rgs.RoundKindBase, BetMinor: 100, TransportGeneration: 1,
	}
	result := validPreparedSessionIntegrityResult(request, 1)
	result.ServerTransactionID = "rgs-op-v1:" + roundID
	if _, prepared, err := repository.PrepareRound(
		ctx, request, rgs.FingerprintFor(request), profile,
		func(rgs.Session) (rgs.SpinResult, error) { return result, nil },
	); err == nil || prepared {
		t.Fatalf("forced PREPARE rollback = prepared:%v error:%v", prepared, err)
	}

	var registered, rounds, walletRows, preparedEvents int
	var sessionCursorClean bool
	if err := database.QueryRowContext(ctx, `
		SELECT
			(SELECT count(*) FROM rgs_wallet_recovery_operators WHERE operator_id=$1),
			(SELECT count(*) FROM rgs_rounds WHERE operator_id=$1),
			(SELECT count(*) FROM rgs_wallet_transactions WHERE operator_id=$1),
			(SELECT count(*) FROM rgs_outbox
			 WHERE operator_id=$1 AND event_type='ROUND_PREPARED'),
			(SELECT pending_round_id IS NULL FROM rgs_sessions
			 WHERE operator_id=$1 AND session_id=$2)`,
		operatorID, sessionID,
	).Scan(&registered, &rounds, &walletRows, &preparedEvents, &sessionCursorClean); err != nil {
		t.Fatal(err)
	}
	if registered != 0 || rounds != 0 || walletRows != 0 || preparedEvents != 0 || !sessionCursorClean {
		t.Fatalf("failed PREPARE leaked state = registry:%d rounds:%d wallet:%d events:%d clean_cursor:%v",
			registered, rounds, walletRows, preparedEvents, sessionCursorClean)
	}
	cleanup()
	triggerInstalled = false
}

func TestPostgresRecoveryQuarantinesPoisonBeforeNextClaim(t *testing.T) {
	databaseURLs := requirePostgresTestURLs(t)
	database, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	migrator, err := sql.Open("pgx", databaseURLs.migrator)
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	truncateIntegrationTables(t, migrator)
	defer truncateIntegrationTables(t, migrator)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repository, err := NewRepository(database)
	if err != nil {
		t.Fatal(err)
	}
	profile := rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
		"https://wallet.test.invalid/poison-ledger",
	))
	preparePostgresRecoveryFixture(t, ctx, repository, profile,
		"operator-poison", "session-poison", "round-poison")
	preparePostgresRecoveryFixture(t, ctx, repository, profile,
		"operator-healthy", "session-healthy", "round-healthy")
	if _, err := migrator.ExecContext(ctx, `
		UPDATE rgs_rounds
		SET wallet_profile='{"unsupported":true}'::jsonb,
			next_attempt_at=clock_timestamp()-interval '2 minutes'
		WHERE operator_id='operator-poison';
		UPDATE rgs_rounds
		SET next_attempt_at=clock_timestamp()-interval '1 minute'
		WHERE operator_id='operator-healthy'`); err != nil {
		t.Fatal(err)
	}

	if _, err := repository.ClaimRecoverableRounds(ctx, 2, time.Minute); !errors.Is(err, rgs.ErrManualReview) {
		t.Fatalf("poison claim error = %v, want ErrManualReview", err)
	}
	var poisonStatus string
	if err := database.QueryRowContext(ctx, `
		SELECT status FROM rgs_rounds
		WHERE operator_id='operator-poison' AND round_id='round-poison'`,
	).Scan(&poisonStatus); err != nil {
		t.Fatal(err)
	}
	if poisonStatus != string(rgs.RoundManualReview) {
		t.Fatalf("poison status = %q", poisonStatus)
	}
	claims, err := repository.ClaimRecoverableRounds(ctx, 1, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 1 || claims[0].Record.Key.OperatorID != "operator-healthy" {
		t.Fatalf("healthy claim after quarantine = %+v", claims)
	}
}

func TestPostgresRecoverySkipsSessionLockedByBusinessTransaction(t *testing.T) {
	databaseURLs := requirePostgresTestURLs(t)
	database, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	migrator, err := sql.Open("pgx", databaseURLs.migrator)
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	truncateIntegrationTables(t, migrator)
	defer truncateIntegrationTables(t, migrator)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	repository, err := NewRepository(database)
	if err != nil {
		t.Fatal(err)
	}
	profile := rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
		"https://wallet.test.invalid/skip-locked-ledger",
	))
	preparePostgresRecoveryFixture(t, ctx, repository, profile,
		"operator-hot", "session-hot", "round-hot")
	preparePostgresRecoveryFixture(t, ctx, repository, profile,
		"operator-healthy", "session-healthy", "round-healthy")
	if _, err := migrator.ExecContext(ctx, `
		UPDATE rgs_rounds SET next_attempt_at=clock_timestamp()-interval '2 minutes'
		WHERE operator_id='operator-hot';
		UPDATE rgs_rounds SET next_attempt_at=clock_timestamp()-interval '1 minute'
		WHERE operator_id='operator-healthy'`); err != nil {
		t.Fatal(err)
	}

	locker, err := database.BeginTx(ctx, &sql.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer locker.Rollback()
	var lockedSession string
	if err := locker.QueryRowContext(ctx, `
		SELECT session_id FROM rgs_sessions
		WHERE operator_id='operator-hot' AND session_id='session-hot'
		FOR UPDATE`,
	).Scan(&lockedSession); err != nil {
		t.Fatal(err)
	}

	started := time.Now()
	claims, err := repository.ClaimRecoverableRounds(ctx, 1, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed >= time.Second {
		t.Fatalf("skip-locked claim blocked for %s", elapsed)
	}
	if len(claims) != 1 || claims[0].Record.Key.OperatorID != "operator-healthy" {
		t.Fatalf("claims while hot session is locked = %+v", claims)
	}
}

func TestPostgresWalletClaimsQuarantineLedgerAndCommandIntegrityFailures(t *testing.T) {
	databaseURLs := requirePostgresTestURLs(t)
	database, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	migrator, err := sql.Open("pgx", databaseURLs.migrator)
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	profile := rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
		"https://wallet.test.invalid/claim-preflight-ledger",
	))
	mutations := []struct {
		name   string
		mutate func(context.Context) error
	}{
		{
			name: "missing ledger",
			mutate: func(ctx context.Context) error {
				_, err := migrator.ExecContext(ctx, `
					DELETE FROM rgs_wallet_transactions
					WHERE operator_id='operator-preflight' AND round_id='round-preflight'`)
				return err
			},
		},
		{
			name: "wrong operation identity",
			mutate: func(ctx context.Context) error {
				_, err := migrator.ExecContext(ctx, `
					UPDATE rgs_wallet_transactions SET transaction_id=$1
					WHERE operator_id='operator-preflight' AND round_id='round-preflight'`,
					"rgs-op-v1:"+strings.Repeat("b", 64),
				)
				return err
			},
		},
		{
			name: "wrong fingerprint",
			mutate: func(ctx context.Context) error {
				_, err := migrator.ExecContext(ctx, `
					UPDATE rgs_wallet_transactions SET request_fingerprint=$1
					WHERE operator_id='operator-preflight' AND round_id='round-preflight'`,
					"rgs-fp-v2:"+strings.Repeat("b", 64),
				)
				return err
			},
		},
		{
			name: "wrong debit and currency",
			mutate: func(ctx context.Context) error {
				_, err := migrator.ExecContext(ctx, `
					UPDATE rgs_wallet_transactions SET amount_minor=amount_minor+1, currency='EUR'
					WHERE operator_id='operator-preflight' AND round_id='round-preflight'`)
				return err
			},
		},
		{
			name: "duplicate logical transaction",
			mutate: func(ctx context.Context) error {
				_, err := migrator.ExecContext(ctx, `
					INSERT INTO rgs_wallet_transactions (
						operator_id, transaction_id, session_id, round_id, kind, status,
						currency, amount_minor, request_fingerprint, created_at, updated_at
					)
					SELECT operator_id, $1, session_id, round_id, kind, status,
						currency, amount_minor, request_fingerprint, created_at, updated_at
					FROM rgs_wallet_transactions
					WHERE operator_id='operator-preflight' AND round_id='round-preflight'`,
					"rgs-op-v1:"+strings.Repeat("c", 64),
				)
				return err
			},
		},
		{
			name: "terminal ledger status",
			mutate: func(ctx context.Context) error {
				_, err := migrator.ExecContext(ctx, `
					UPDATE rgs_wallet_transactions SET status='SUCCEEDED'
					WHERE operator_id='operator-preflight' AND round_id='round-preflight'`)
				return err
			},
		},
		{
			name: "credit command drift",
			mutate: func(ctx context.Context) error {
				_, err := migrator.ExecContext(ctx, `
					UPDATE rgs_rounds SET win_minor=win_minor+1
					WHERE operator_id='operator-preflight' AND round_id='round-preflight'`)
				return err
			},
		},
	}
	claimers := []struct {
		name  string
		claim func(context.Context, *Repository, rgs.RoundKey) ([]rgs.WalletRecoveryClaim, error)
	}{
		{
			name: "direct",
			claim: func(ctx context.Context, repository *Repository, key rgs.RoundKey) ([]rgs.WalletRecoveryClaim, error) {
				claim, claimed, err := repository.ClaimWallet(ctx, key, time.Minute)
				if claimed {
					return []rgs.WalletRecoveryClaim{claim}, err
				}
				return nil, err
			},
		},
		{
			name: "batch",
			claim: func(ctx context.Context, repository *Repository, _ rgs.RoundKey) ([]rgs.WalletRecoveryClaim, error) {
				return repository.ClaimRecoverableRounds(ctx, 1, time.Minute)
			},
		},
	}
	for _, claimer := range claimers {
		for _, mutation := range mutations {
			t.Run(claimer.name+"/"+mutation.name, func(t *testing.T) {
				truncateIntegrationTables(t, migrator)
				defer truncateIntegrationTables(t, migrator)
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				repository, err := NewRepository(database)
				if err != nil {
					t.Fatal(err)
				}
				preparePostgresRecoveryFixture(
					t, ctx, repository, profile,
					"operator-preflight", "session-preflight", "round-preflight",
				)
				if err := mutation.mutate(ctx); err != nil {
					t.Fatal(err)
				}
				key := rgs.RoundKey{
					OperatorID: "operator-preflight", SessionID: "session-preflight",
					RoundID: "round-preflight",
				}
				claims, err := claimer.claim(ctx, repository, key)
				if !errors.Is(err, rgs.ErrManualReview) || len(claims) != 0 {
					t.Fatalf("claim integrity result = claims:%+v error:%v", claims, err)
				}
				var roundStatus, sessionStatus string
				if err := database.QueryRowContext(ctx, `
					SELECT r.status, s.status
					FROM rgs_rounds r
					JOIN rgs_sessions s
					  ON s.operator_id=r.operator_id AND s.session_id=r.session_id
					WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3`,
					key.OperatorID, key.SessionID, key.RoundID,
				).Scan(&roundStatus, &sessionStatus); err != nil {
					t.Fatal(err)
				}
				if roundStatus != string(rgs.RoundManualReview) ||
					sessionStatus != string(rgs.SessionBlocked) {
					t.Fatalf("quarantine state = round:%q session:%q", roundStatus, sessionStatus)
				}
			})
		}
	}
}

func TestPostgresPendingRoundRequiresImmutableCommandDigest(t *testing.T) {
	databaseURLs := requirePostgresTestURLs(t)
	database, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	migrator, err := sql.Open("pgx", databaseURLs.migrator)
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	truncateIntegrationTables(t, migrator)
	defer truncateIntegrationTables(t, migrator)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	repository, err := NewRepository(database)
	if err != nil {
		t.Fatal(err)
	}
	profile := rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
		"https://wallet.test.invalid/digest-ledger",
	))
	preparePostgresRecoveryFixture(t, ctx, repository, profile,
		"operator-digest", "session-digest", "round-digest")
	if _, err := migrator.ExecContext(ctx, `
		UPDATE rgs_rounds SET wallet_command_digest=NULL
		WHERE operator_id='operator-digest' AND round_id='round-digest'`); err == nil {
		t.Fatal("pending round accepted a missing immutable command digest")
	}
}

func TestPostgresNotSentApplyReturnsReservedAttemptBudget(t *testing.T) {
	databaseURLs := requirePostgresTestURLs(t)
	database, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	migrator, err := sql.Open("pgx", databaseURLs.migrator)
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	truncateIntegrationTables(t, migrator)
	defer truncateIntegrationTables(t, migrator)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	repository, err := NewRepository(database)
	if err != nil {
		t.Fatal(err)
	}
	profile := rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
		"https://wallet.test.invalid/not-sent-ledger",
	))
	preparePostgresRecoveryFixture(t, ctx, repository, profile,
		"operator-not-sent", "session-not-sent", "round-not-sent")
	key := rgs.RoundKey{OperatorID: "operator-not-sent", SessionID: "session-not-sent", RoundID: "round-not-sent"}
	claim, claimed, err := repository.ClaimWallet(ctx, key, time.Minute)
	if err != nil || !claimed || claim.Record.WalletApplyAttempts != 1 {
		t.Fatalf("ClaimWallet() = claim:%+v claimed:%v error:%v", claim, claimed, err)
	}
	scheduled, err := repository.ScheduleWalletRecovery(ctx, claim, rgs.WalletRecoveryDisposition{
		NextAction: rgs.WalletRecoveryApply, ApplyNotSent: true,
	}, 0)
	if err != nil || !scheduled {
		t.Fatalf("ScheduleWalletRecovery() = scheduled:%v error:%v", scheduled, err)
	}
	persisted, err := repository.GetRound(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.WalletApplyAttempts != 0 || persisted.RetryCount != 1 ||
		persisted.WalletPhase != rgs.WalletRecoveryApply {
		t.Fatalf("NOT_SENT budget was not returned: %+v", persisted)
	}
	secondClaim, claimed, err := repository.ClaimWallet(ctx, key, time.Minute)
	if err != nil || !claimed || secondClaim.Record.WalletApplyAttempts != 1 ||
		secondClaim.Record.RetryCount != 2 {
		t.Fatalf("second ClaimWallet() = claim:%+v claimed:%v error:%v", secondClaim, claimed, err)
	}
	if scheduled, err = repository.ScheduleWalletRecovery(ctx, secondClaim, rgs.WalletRecoveryDisposition{
		NextAction: rgs.WalletRecoveryApply, ApplyNotSent: true,
	}, 0); err != nil || !scheduled {
		t.Fatalf("second ScheduleWalletRecovery() = scheduled:%v error:%v", scheduled, err)
	}
	persisted, err = repository.GetRound(ctx, key)
	if err != nil || persisted.WalletApplyAttempts != 0 || persisted.RetryCount != 2 {
		t.Fatalf("second NOT_SENT did not preserve scheduler pressure: record:%+v error:%v", persisted, err)
	}
}

func TestPostgresWorkerLookupLimitFencesAcrossPasses(t *testing.T) {
	databaseURLs := requirePostgresTestURLs(t)
	database, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	migrator, err := sql.Open("pgx", databaseURLs.migrator)
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	truncateIntegrationTables(t, migrator)
	defer truncateIntegrationTables(t, migrator)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	claimRepository, err := NewRepository(database)
	if err != nil {
		t.Fatal(err)
	}
	transitionRepository, err := NewRepository(database)
	if err != nil {
		t.Fatal(err)
	}
	profile := rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
		"https://wallet.test.invalid/lookup-limit-ledger",
	))
	preparePostgresRecoveryFixture(
		t, ctx, claimRepository, profile,
		"operator-lookup-limit", "session-lookup-limit", "round-lookup-limit",
	)
	key := rgs.RoundKey{
		OperatorID: "operator-lookup-limit", SessionID: "session-lookup-limit",
		RoundID: "round-lookup-limit",
	}
	applyClaim, claimed, err := claimRepository.ClaimWallet(ctx, key, time.Second)
	if err != nil || !claimed || applyClaim.Action != rgs.WalletRecoveryApply {
		t.Fatalf("initial apply claim = claim:%+v claimed:%v error:%v", applyClaim, claimed, err)
	}
	if scheduled, scheduleErr := claimRepository.ScheduleWalletRecovery(
		ctx,
		applyClaim,
		rgs.WalletRecoveryDisposition{NextAction: rgs.WalletRecoveryLookup},
		0,
	); scheduleErr != nil || !scheduled {
		t.Fatalf("initial unknown apply schedule = scheduled:%v error:%v", scheduled, scheduleErr)
	}

	wallet := &permanentlyPendingLookupWallet{profile: profile}
	definitions := rgs.DefinitionResolverFunc(func(
		context.Context, string, string, string,
	) (game.Spinner, error) {
		return &integrationSpinner{}, nil
	})
	coordinator, err := rgs.NewCoordinator(rgs.CoordinatorConfig{
		WalletLease: time.Second, WalletFastPathTimeout: 100 * time.Millisecond,
		PendingWait: 100 * time.Millisecond, PollInterval: time.Millisecond,
		MaxWalletAttempts: 1,
	}, transitionRepository, wallet, definitions)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := recovery.New(recovery.Config{
		Interval: 100 * time.Millisecond, AttemptTimeout: 500 * time.Millisecond,
		LeaseDuration: time.Second, InitialBackoff: time.Millisecond,
		MaximumBackoff: time.Millisecond, BatchSize: 1, MaxParallel: 1,
		FullJitter: func(time.Duration) time.Duration { return 0 },
	}, claimRepository, coordinator, nil, nil)
	if err != nil {
		t.Fatal(err)
	}

	// 第一个 Worker pass 是配置允许的最后一次查询。
	// English: The first Worker pass is the last query allowed by the configuration.
	if err := worker.RunOnce(ctx); err != nil {
		t.Fatalf("last allowed lookup pass: %v", err)
	}
	if wallet.resolveCalls.Load() != 1 {
		t.Fatalf("wallet lookups after first pass = %d, want 1", wallet.resolveCalls.Load())
	}
	// 第二个 pass 由另一 Repository 实例执行 fenced 状态转换；达到上限后只能
	// 隔离，不能再次访问第三方钱包。
	// English: In the second pass, another Repository instance performs fenced state transition; after reaching the
	// upper limit, it can only be isolated and cannot access the third-party wallet again.
	if err := worker.RunOnce(ctx); err != nil {
		t.Fatalf("lookup limit pass: %v", err)
	}
	if wallet.resolveCalls.Load() != 1 {
		t.Fatalf("wallet lookups after limit = %d, want 1", wallet.resolveCalls.Load())
	}
	var roundStatus, sessionStatus, failureCode string
	var lookupAttempts int
	if err := database.QueryRowContext(ctx, `
		SELECT r.status, r.lookup_attempts, r.failure_code, s.status
		FROM rgs_rounds r
		JOIN rgs_sessions s
		  ON s.operator_id=r.operator_id AND s.session_id=r.session_id
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3`,
		key.OperatorID, key.SessionID, key.RoundID,
	).Scan(&roundStatus, &lookupAttempts, &failureCode, &sessionStatus); err != nil {
		t.Fatal(err)
	}
	if roundStatus != string(rgs.RoundManualReview) || lookupAttempts != 2 ||
		failureCode != "wallet lookup attempt limit exceeded" ||
		sessionStatus != string(rgs.SessionBlocked) {
		t.Fatalf("lookup limit persisted state = round:%q attempts:%d failure:%q session:%q",
			roundStatus, lookupAttempts, failureCode, sessionStatus)
	}
}

type permanentlyPendingLookupWallet struct {
	profile      rgs.Profile
	resolveCalls atomic.Int64
}

func (wallet *permanentlyPendingLookupWallet) ProfileFor(string) (rgs.Profile, error) {
	return wallet.profile, nil
}

func (*permanentlyPendingLookupWallet) SubmitRound(context.Context, rgs.WalletRound) rgs.Resolution {
	return rgs.Resolution{Status: rgs.ResolutionNotSent, Cause: rgs.ErrWalletUnavailable}
}

func (wallet *permanentlyPendingLookupWallet) Resolve(context.Context, rgs.OperationRef) rgs.Resolution {
	wallet.resolveCalls.Add(1)
	return rgs.Resolution{Status: rgs.ResolutionPending, Cause: rgs.ErrWalletPending}
}

func (*permanentlyPendingLookupWallet) ApplyRound(
	context.Context,
	rgs.WalletRound,
) (rgs.WalletReceipt, error) {
	return rgs.WalletReceipt{}, rgs.ErrWalletUnavailable
}

func (*permanentlyPendingLookupWallet) Lookup(
	context.Context,
	string,
	string,
) (rgs.WalletReceipt, bool, error) {
	return rgs.WalletReceipt{}, false, rgs.ErrWalletPending
}

func (*permanentlyPendingLookupWallet) Rollback(
	context.Context,
	rgs.WalletRollback,
) (rgs.WalletReceipt, error) {
	return rgs.WalletReceipt{}, rgs.ErrWalletUnavailable
}

func TestPostgresIntegrityQuarantinePreservesSucceededWalletEvidence(t *testing.T) {
	databaseURLs := requirePostgresTestURLs(t)
	database, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	migrator, err := sql.Open("pgx", databaseURLs.migrator)
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	truncateIntegrationTables(t, migrator)
	defer truncateIntegrationTables(t, migrator)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	repository, err := NewRepository(database)
	if err != nil {
		t.Fatal(err)
	}
	profile := rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
		"https://wallet.test.invalid/evidence-ledger",
	))
	preparePostgresRecoveryFixture(t, ctx, repository, profile,
		"operator-evidence", "session-evidence", "round-evidence")
	if _, err := migrator.ExecContext(ctx, `
		UPDATE rgs_wallet_transactions SET status='SUCCEEDED'
		WHERE operator_id='operator-evidence'`); err != nil {
		t.Fatal(err)
	}
	key := rgs.RoundKey{OperatorID: "operator-evidence", SessionID: "session-evidence", RoundID: "round-evidence"}
	if _, changed, err := repository.MarkManualReview(ctx, key, "PERSISTED_STATE_MISMATCH"); err != nil || !changed {
		t.Fatalf("MarkManualReview() = changed:%v error:%v", changed, err)
	}
	var status, failureCode string
	if err := database.QueryRowContext(ctx, `
		SELECT status, failure_code FROM rgs_wallet_transactions
		WHERE operator_id='operator-evidence'`,
	).Scan(&status, &failureCode); err != nil {
		t.Fatal(err)
	}
	if status != "SUCCEEDED" || failureCode != "PERSISTED_STATE_MISMATCH" {
		t.Fatalf("quarantined wallet evidence = status:%q failure:%q", status, failureCode)
	}
}

func preparePostgresRecoveryFixture(
	t *testing.T,
	ctx context.Context,
	repository *Repository,
	profile rgs.Profile,
	operatorID, sessionID, roundID string,
) {
	t.Helper()
	hash := strings.Repeat("a", 64)
	session := rgs.Session{
		OperatorID: operatorID, SessionID: sessionID,
		PlayerID: "player-" + sessionID, WalletAccountID: "wallet-" + sessionID,
		WalletSessionID: "wallet-session-" + sessionID,
		GameID:          "game-a", DefinitionVersion: "math-v1", DefinitionHash: hash,
		Currency: "USD", CurrencyExponent: 2, Jurisdiction: "MT",
		Status: rgs.SessionActive, BalanceMinor: 10_000,
		Feature:        game.EmptyFeatureState(),
		ExpiresAt:      time.Now().UTC().Add(time.Hour),
		IdleDisconnect: 20 * time.Minute, IdleDisconnectAt: time.Now().UTC().Add(20 * time.Minute),
		TransportGeneration: 1,
	}
	if err := repository.CreateSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	request := rgs.SpinRequest{
		OperatorID: operatorID, SessionID: sessionID, RoundID: roundID,
		GameID: session.GameID, DefinitionVersion: session.DefinitionVersion,
		DefinitionHash: hash, Currency: session.Currency,
		RoundKind: rgs.RoundKindBase, BetMinor: 100, TransportGeneration: 1,
	}
	result := validPreparedSessionIntegrityResult(request, 1)
	result.ServerTransactionID = "rgs-op-v1:" + roundID
	if _, prepared, err := repository.PrepareRound(
		ctx, request, rgs.FingerprintFor(request), profile,
		func(rgs.Session) (rgs.SpinResult, error) { return result, nil },
	); err != nil || !prepared {
		t.Fatalf("PrepareRound(%s) = prepared:%v error:%v", roundID, prepared, err)
	}
}

func TestClaimRecoverableRoundsAtomicallyReturnsPreswitchedAction(t *testing.T) {
	database, mock := newRepositoryMock(t)
	repository, err := NewRepository(database)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newRoundRowFixture(t, rgs.RoundPrepared)
	databaseNow := fixture.createdAt.Add(time.Minute)
	lockAcquiredAt := databaseNow.Add(7 * time.Second)
	const leaseDuration = 45 * time.Second

	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(walletLeaseClockSQL)).
		WillReturnRows(sqlmock.NewRows([]string{"clock_timestamp"}).AddRow(databaseNow))
	mock.ExpectQuery(regexp.QuoteMeta(recoverableRoundClaimSQL)).
		WithArgs(databaseNow, 1).
		WillReturnRows(sqlmock.NewRows([]string{"operator_id", "session_id", "round_id"}).
			AddRow(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID))
	mock.ExpectQuery(regexp.QuoteMeta(sessionSelect+`
		WHERE operator_id=$1 AND session_id=$2 FOR UPDATE`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID).
		WillReturnRows(validSessionRows(t, fixture))
	mock.ExpectQuery(regexp.QuoteMeta(roundSelect+`
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3 FOR UPDATE`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(fixture.rows(t))
	mock.ExpectQuery(regexp.QuoteMeta(walletClaimLedgerSelect)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(validWalletLedgerRows(fixture, "PENDING"))
	mock.ExpectQuery(regexp.QuoteMeta(walletLeaseClockSQL)).
		WillReturnRows(sqlmock.NewRows([]string{"clock_timestamp"}).AddRow(lockAcquiredAt))
	mock.ExpectExec(regexp.QuoteMeta(`
		UPDATE rgs_rounds
		SET status='WALLET_PENDING', wallet_phase=$4, next_attempt_at=$5,
			wallet_lease_until=$5, apply_attempts=apply_attempts+$6,
			lookup_attempts=lookup_attempts+$7, retry_count=retry_count+$8,
			updated_at=$9
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3`)).
		WithArgs(
			fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID,
			string(rgs.WalletRecoveryLookup), lockAcquiredAt.Add(leaseDuration),
			1, 0, 1, lockAcquiredAt,
		).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`
		INSERT INTO rgs_outbox (
			operator_id, aggregate_type, aggregate_id, event_type, payload
		) VALUES ($1,$2,$3,$4,$5)`)).
		WithArgs(
			fixture.request.OperatorID, "round", fixture.serverTransactionID,
			"WALLET_CLAIMED", sqlmock.AnyArg(),
		).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(regexp.QuoteMeta(touchRecoveryOperatorSQL)).
		WithArgs(fixture.request.OperatorID, lockAcquiredAt).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	claims, err := repository.ClaimRecoverableRounds(
		context.Background(), 1, leaseDuration,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 1 || claims[0].Action != rgs.WalletRecoveryApply ||
		claims[0].Record.WalletPhase != rgs.WalletRecoveryLookup ||
		claims[0].Record.WalletApplyAttempts != 1 ||
		!claims[0].LeaseUntil.Equal(lockAcquiredAt.Add(leaseDuration)) {
		t.Fatalf("recovery claims = %+v", claims)
	}
	assertRepositoryExpectations(t, mock)
}

func TestPrepareRoundUsesDatabaseClockForInitialRecoverySchedule(t *testing.T) {
	database, mock := newRepositoryMock(t)
	repository, err := NewRepository(database)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newRoundRowFixture(t, rgs.RoundPrepared)
	fixture.createdAt = time.Now().UTC()
	databaseNow := fixture.createdAt.Add(time.Minute)

	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(prepareSessionLockSQL)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID).
		WillReturnRows(sqlmock.NewRows([]string{
			"operator_id", "session_id", "player_id", "wallet_account_id",
			"wallet_session_id", "game_id", "definition_version", "definition_hash",
			"currency", "currency_exponent", "jurisdiction", "status",
			"balance_snapshot_minor", "sequence", "revision", "feature_state",
			"pending_round_id", "expires_at", "idle_disconnect_seconds",
			"idle_disconnect_at", "transport_generation", "integrity_quarantined_at",
		}).AddRow(
			fixture.request.OperatorID, fixture.request.SessionID, "player-a", "wallet-account-a",
			"wallet-session-a", fixture.request.GameID, fixture.request.DefinitionVersion,
			fixture.request.DefinitionHash, fixture.request.Currency, 2, "MT", string(rgs.SessionActive),
			10_000, 7, int64(fixture.request.StartRevision), fixture.inputFeatureJSON,
			nil, fixture.createdAt.Add(time.Hour), int64(1200),
			fixture.createdAt.Add(20*time.Minute), int64(1), nil,
		))
	mock.ExpectQuery(regexp.QuoteMeta(roundSelect+`
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(sqlmock.NewRows(roundRowColumns))
	mock.ExpectQuery(regexp.QuoteMeta(prepareAdmissionStateSQL)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID).
		WillReturnRows(sqlmock.NewRows([]string{"clock_timestamp", "result_delivery_pending"}).
			AddRow(databaseNow, false))
	mock.ExpectQuery(`(?s)WITH inserted_round AS .*INSERT INTO rgs_rounds.*inserted_wallet AS .*INSERT INTO rgs_wallet_transactions.*updated_session AS .*UPDATE rgs_sessions.*registered_recovery_operator AS .*INSERT INTO rgs_wallet_recovery_operators.*SELECT operator_id FROM updated_session.*ON CONFLICT \(operator_id\) DO NOTHING.*inserted_outbox AS .*INSERT INTO rgs_outbox.*SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{
			"round_count", "wallet_count", "session_count", "outbox_count",
		}).AddRow(1, 1, 1, 1))
	mock.ExpectCommit()

	record, prepared, err := repository.PrepareRound(
		context.Background(), fixture.request, fixture.fingerprint,
		rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget("https://wallet.test.invalid/ledger")),
		func(rgs.Session) (rgs.SpinResult, error) { return fixture.result, nil },
	)
	if err != nil || !prepared {
		t.Fatalf("PrepareRound() = record:%+v prepared:%v error:%v", record, prepared, err)
	}
	if !record.CreatedAt.Equal(databaseNow) || !record.UpdatedAt.Equal(databaseNow) ||
		!record.NextAttemptAt.Equal(databaseNow) || record.WalletPhase != rgs.WalletRecoveryApply {
		t.Fatalf("prepared recovery clock = %+v", record)
	}
	if record.WalletCommand.WalletSessionRef != "wallet-session-a" ||
		record.WalletCommand.CommandDigest != rgs.CommandDigestFor(record.WalletCommand) {
		t.Fatalf("prepared wallet command binding = %+v", record.WalletCommand)
	}
	assertRepositoryExpectations(t, mock)
}

func TestScheduleWalletRecoveryUsesLeaseFenceAndDatabaseClock(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	repository, err := NewRepository(database)
	if err != nil {
		t.Fatal(err)
	}
	leaseUntil := time.Date(2026, 8, 22, 10, 0, 0, 0, time.UTC)
	retryAfter := leaseUntil.Add(time.Minute)
	claim := rgs.WalletRecoveryClaim{
		Record: rgs.RoundRecord{Key: rgs.RoundKey{
			OperatorID: "operator-a", SessionID: "session-a", RoundID: "round-a",
		}},
		Action: rgs.WalletRecoveryLookup, LeaseUntil: leaseUntil,
	}
	disposition := rgs.WalletRecoveryDisposition{
		NextAction: rgs.WalletRecoveryLookup, MinimumDelay: 2*time.Second + 500*time.Nanosecond,
		NextAttemptAt: retryAfter,
	}
	mock.ExpectExec(regexp.QuoteMeta(scheduleWalletRecoverySQL)).
		WithArgs(
			"operator-a", "session-a", "round-a", leaseUntil,
			string(rgs.WalletRecoveryLookup), int64(2_000_001), retryAfter, false,
		).
		WillReturnResult(sqlmock.NewResult(0, 1))
	scheduled, err := repository.ScheduleWalletRecovery(
		context.Background(), claim, disposition, 1500*time.Microsecond,
	)
	if err != nil || !scheduled {
		t.Fatalf("ScheduleWalletRecovery() = scheduled:%v error:%v", scheduled, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
