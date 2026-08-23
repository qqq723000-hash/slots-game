package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"slots-game/server/internal/game"
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
	const operatorCount = 8
	for operatorIndex := range operatorCount {
		for sessionIndex := range 2 {
			operatorID := fmt.Sprintf("operator-fair-%02d", operatorIndex)
			sessionID := fmt.Sprintf("session-fair-%02d-%d", operatorIndex, sessionIndex)
			roundID := fmt.Sprintf("round-fair-%02d-%d", operatorIndex, sessionIndex)
			preparePostgresRecoveryFixture(t, ctx, repository, profile, operatorID, sessionID, roundID)
		}
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
	second, err := repository.ClaimRecoverableRounds(ctx, 4, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 4 || len(second) != 4 {
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
		Feature:   game.EmptyFeatureState(),
		ExpiresAt: time.Now().UTC().Add(time.Hour),
	}
	if err := repository.CreateSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	request := rgs.SpinRequest{
		OperatorID: operatorID, SessionID: sessionID, RoundID: roundID,
		GameID: session.GameID, DefinitionVersion: session.DefinitionVersion,
		DefinitionHash: hash, Currency: session.Currency,
		RoundKind: rgs.RoundKindBase, BetMinor: 100,
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
	mock.ExpectExec(regexp.QuoteMeta(ensureRecoveryOperatorsSQL)).
		WillReturnResult(sqlmock.NewResult(0, 1))
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
	mock.ExpectQuery(`(?s)SELECT s\.operator_id.*EXISTS \(.*result_acknowledged_at IS NULL.*clock_timestamp\(\).*FOR UPDATE OF s`).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID).
		WillReturnRows(sqlmock.NewRows([]string{
			"operator_id", "session_id", "player_id", "wallet_account_id",
			"wallet_session_id", "game_id", "definition_version", "definition_hash",
			"currency", "currency_exponent", "jurisdiction", "status",
			"balance_snapshot_minor", "sequence", "revision", "feature_state",
			"pending_round_id", "expires_at", "integrity_quarantined_at",
			"result_delivery_pending", "database_now",
		}).AddRow(
			fixture.request.OperatorID, fixture.request.SessionID, "player-a", "wallet-account-a",
			"wallet-session-a", fixture.request.GameID, fixture.request.DefinitionVersion,
			fixture.request.DefinitionHash, fixture.request.Currency, 2, "MT", string(rgs.SessionActive),
			10_000, 7, int64(fixture.request.StartRevision), fixture.inputFeatureJSON,
			nil, fixture.createdAt.Add(time.Hour), nil, false, databaseNow,
		))
	mock.ExpectQuery(regexp.QuoteMeta(roundSelect+`
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(sqlmock.NewRows(roundRowColumns))
	mock.ExpectQuery(`(?s)WITH inserted_round AS .*INSERT INTO rgs_rounds.*inserted_wallet AS .*INSERT INTO rgs_wallet_transactions.*updated_session AS .*UPDATE rgs_sessions.*inserted_outbox AS .*INSERT INTO rgs_outbox.*SELECT`).
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
