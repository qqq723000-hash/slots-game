package postgres

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"slots-game/server/internal/game"
	"slots-game/server/internal/rgs"
)

var roundRowColumns = []string{
	"operator_id", "session_id", "round_id", "server_transaction_id",
	"request_fingerprint", "status", "round_kind", "game_id",
	"definition_version", "definition_hash", "currency", "bet_minor",
	"input_feature_state", "charged_minor", "win_minor", "starting_revision", "resulting_revision",
	"sequence", "result_json", "outcome_hash",
	"wallet_phase", "next_attempt_at", "apply_attempts", "lookup_attempts",
	"wallet_command_digest", "wallet_profile", "wallet_transaction_id", "wallet_balance_minor",
	"wallet_lease_until", "failure_code", "retry_count",
	"created_at", "updated_at", "player_id", "wallet_account_id",
	"wallet_session_id", "session_status", "session_integrity_quarantined_at",
}

type roundRowFixture struct {
	request             rgs.SpinRequest
	result              rgs.SpinResult
	status              rgs.RoundStatus
	fingerprint         string
	outcomeHash         string
	serverTransactionID string
	inputFeature        game.FeatureState
	inputFeatureJSON    any
	betMinor            int64
	chargedMinor        int64
	winMinor            int64
	endRevision         int64
	sequence            int64
	resultJSON          []byte
	walletTransaction   any
	walletPhase         string
	nextAttemptAt       any
	applyAttempts       int
	lookupAttempts      int
	walletCommandDigest any
	omitCommandDigest   bool
	walletProfileJSON   any
	walletBalance       any
	walletLease         any
	createdAt           time.Time
	sessionStatus       string
	sessionQuarantined  any
}

func TestGetRoundFailsClosedForIntegrityQuarantinedSession(t *testing.T) {
	db, mock := newRepositoryMock(t)
	repository, err := NewRepository(db)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newRoundRowFixture(t, rgs.RoundPrepared)
	fixture.sessionStatus = string(rgs.SessionBlocked)
	fixture.sessionQuarantined = time.Now().UTC()
	expectGetRound(t, mock, fixture)
	expectSessionQuarantine(mock, sessionRowFixture{
		operatorID: fixture.request.OperatorID, sessionID: fixture.request.SessionID,
		status: fixture.sessionStatus, pendingRoundID: fixture.request.RoundID,
	}, true)

	if _, err := repository.GetRound(context.Background(), fixture.request.Key()); !errors.Is(err, rgs.ErrSessionIntegrity) {
		t.Fatalf("GetRound() error = %v, want ErrSessionIntegrity", err)
	}
	assertRepositoryExpectations(t, mock)
}

func TestGetRoundVerifiesPendingAndCommittedIntegrity(t *testing.T) {
	for _, status := range []rgs.RoundStatus{
		rgs.RoundPrepared, rgs.RoundRiskPending, rgs.RoundCommitted,
	} {
		t.Run(string(status), func(t *testing.T) {
			db, mock := newRepositoryMock(t)
			repository, err := NewRepository(db)
			if err != nil {
				t.Fatal(err)
			}
			fixture := newRoundRowFixture(t, status)
			expectGetRound(t, mock, fixture)

			record, err := repository.GetRound(context.Background(), fixture.request.Key())
			if err != nil {
				t.Fatalf("GetRound() error = %v", err)
			}
			if !reflect.DeepEqual(record.Result, fixture.result) {
				t.Fatalf("GetRound() result = %#v, want %#v", record.Result, fixture.result)
			}
			if record.WalletCommand.DebitMinor != fixture.chargedMinor ||
				record.WalletCommand.CreditMinor != fixture.winMinor {
				t.Fatalf("wallet command = %#v", record.WalletCommand)
			}
			if status == rgs.RoundCommitted {
				if record.WalletReceipt == nil ||
					record.WalletReceipt.TransactionID != fixture.result.WalletTransactionID ||
					record.WalletReceipt.BalanceMinor != fixture.result.BalanceMinor {
					t.Fatalf("wallet receipt = %#v", record.WalletReceipt)
				}
			} else if record.WalletReceipt != nil {
				t.Fatalf("prepared wallet receipt = %#v, want nil", record.WalletReceipt)
			}
			assertRepositoryExpectations(t, mock)
		})
	}
}

func TestClaimWalletUsesDatabaseClockAcrossReplicas(t *testing.T) {
	db, mock := newRepositoryMock(t)
	repository, err := NewRepository(db)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newRoundRowFixture(t, rgs.RoundPrepared)
	databaseNow := fixture.createdAt.Add(time.Minute)
	const leaseDuration = 45 * time.Second

	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(sessionSelect+`
		WHERE operator_id=$1 AND session_id=$2 FOR UPDATE`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID).
		WillReturnRows(validSessionRows(t, fixture))
	mock.ExpectQuery(regexp.QuoteMeta(roundSelect+`
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3 FOR UPDATE OF r`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(fixture.rows(t))
	mock.ExpectQuery(regexp.QuoteMeta(walletClaimLedgerSelect)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(validWalletLedgerRows(fixture, "PENDING"))
	mock.ExpectQuery(regexp.QuoteMeta(walletLeaseClockSQL)).
		WillReturnRows(sqlmock.NewRows([]string{"clock_timestamp"}).AddRow(databaseNow))
	mock.ExpectExec(regexp.QuoteMeta(`
		UPDATE rgs_rounds
		SET status='WALLET_PENDING', wallet_phase=$4, next_attempt_at=$5,
			wallet_lease_until=$5, apply_attempts=apply_attempts+$6,
			lookup_attempts=lookup_attempts+$7, retry_count=retry_count+$8,
			updated_at=$9
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3`)).
		WithArgs(
			fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID,
			string(rgs.WalletRecoveryLookup), databaseNow.Add(leaseDuration), 1, 0, 1, databaseNow,
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
	mock.ExpectCommit()

	claim, ownsWallet, err := repository.ClaimWallet(
		context.Background(), fixture.request.Key(), leaseDuration,
	)
	if err != nil || !ownsWallet {
		t.Fatalf("ClaimWallet() = owns:%v error:%v", ownsWallet, err)
	}
	if claim.Action != rgs.WalletRecoveryApply ||
		claim.Record.WalletPhase != rgs.WalletRecoveryLookup ||
		!claim.Record.UpdatedAt.Equal(databaseNow) ||
		!claim.LeaseUntil.Equal(databaseNow.Add(leaseDuration)) {
		t.Fatalf("database lease clock = updated:%s until:%s",
			claim.Record.UpdatedAt, claim.LeaseUntil)
	}
	assertRepositoryExpectations(t, mock)
}

func TestClaimWalletDoesNotLetFastReplicaStealUnexpiredDatabaseLease(t *testing.T) {
	db, mock := newRepositoryMock(t)
	repository, err := NewRepository(db)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newRoundRowFixture(t, rgs.RoundWalletPending)
	databaseNow := fixture.createdAt.Add(time.Minute)
	fixture.walletLease = databaseNow.Add(30 * time.Second)

	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(sessionSelect+`
		WHERE operator_id=$1 AND session_id=$2 FOR UPDATE`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID).
		WillReturnRows(validSessionRows(t, fixture))
	mock.ExpectQuery(regexp.QuoteMeta(roundSelect+`
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3 FOR UPDATE OF r`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(fixture.rows(t))
	mock.ExpectQuery(regexp.QuoteMeta(walletClaimLedgerSelect)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(validWalletLedgerRows(fixture, "PENDING"))
	mock.ExpectQuery(regexp.QuoteMeta(walletLeaseClockSQL)).
		WillReturnRows(sqlmock.NewRows([]string{"clock_timestamp"}).AddRow(databaseNow))
	mock.ExpectCommit()

	claim, ownsWallet, err := repository.ClaimWallet(
		context.Background(), fixture.request.Key(), time.Minute,
	)
	if err != nil || ownsWallet {
		t.Fatalf("ClaimWallet() = owns:%v error:%v", ownsWallet, err)
	}
	if !claim.Record.WalletLeaseUntil.Equal(fixture.walletLease.(time.Time)) {
		t.Fatalf("preserved lease = %s", claim.Record.WalletLeaseUntil)
	}
	assertRepositoryExpectations(t, mock)
}

func TestCommitClaimRejectsLeaseReplacedByAnotherWorker(t *testing.T) {
	db, mock := newRepositoryMock(t)
	repository, err := NewRepository(db)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newRoundRowFixture(t, rgs.RoundWalletPending)
	newLease := fixture.createdAt.Add(2 * time.Minute)
	fixture.walletLease = newLease
	oldClaim := rgs.WalletRecoveryClaim{
		Record:     rgs.RoundRecord{Key: fixture.request.Key()},
		Action:     rgs.WalletRecoveryLookup,
		LeaseUntil: fixture.createdAt.Add(time.Minute),
	}

	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(sessionSelect+`
		WHERE operator_id=$1 AND session_id=$2 FOR UPDATE`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID).
		WillReturnRows(validSessionRows(t, fixture))
	mock.ExpectQuery(regexp.QuoteMeta(roundSelect+`
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3 FOR UPDATE OF r`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(fixture.rows(t))
	mock.ExpectRollback()

	_, changed, err := repository.CommitClaim(context.Background(), oldClaim, rgs.WalletReceipt{})
	if !errors.Is(err, rgs.ErrStaleWalletClaim) || changed {
		t.Fatalf("CommitClaim() = changed:%v error:%v, want stale claim", changed, err)
	}
	assertRepositoryExpectations(t, mock)
}

func TestRejectClaimFencesRoundAndRequiresWalletLedgerTransition(t *testing.T) {
	db, mock := newRepositoryMock(t)
	repository, err := NewRepository(db)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newRoundRowFixture(t, rgs.RoundWalletPending)
	leaseUntil := fixture.createdAt.Add(time.Minute)
	fixture.walletLease = leaseUntil
	claim := rgs.WalletRecoveryClaim{
		Record:     rgs.RoundRecord{Key: fixture.request.Key()},
		Action:     rgs.WalletRecoveryLookup,
		LeaseUntil: leaseUntil,
	}
	const failureCode = "LIMIT_EXCEEDED"

	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(sessionSelect+`
		WHERE operator_id=$1 AND session_id=$2 FOR UPDATE`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID).
		WillReturnRows(validSessionRows(t, fixture))
	mock.ExpectQuery(regexp.QuoteMeta(roundSelect+`
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3 FOR UPDATE OF r`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(fixture.rows(t))
	mock.ExpectExec(regexp.QuoteMeta(`
		UPDATE rgs_rounds SET status=$4, failure_code=$5,
			wallet_phase='', next_attempt_at=NULL, wallet_lease_until=NULL, updated_at=$6
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
		  AND status IN ('PREPARED','WALLET_PENDING') AND wallet_lease_until=$7`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID,
			string(rgs.RoundRejected), failureCode, sqlmock.AnyArg(), leaseUntil).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`
		UPDATE rgs_wallet_transactions
		SET status=$3, failure_code=$4, updated_at=$5
		WHERE operator_id=$1 AND transaction_id=$2
		  AND status IN ('PENDING','UNKNOWN')`)).
		WithArgs(fixture.request.OperatorID, fixture.serverTransactionID, "FAILED", failureCode, sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`
			UPDATE rgs_sessions SET pending_round_id=NULL, updated_at=$3
			WHERE operator_id=$1 AND session_id=$2 AND pending_round_id=$4 AND revision=$5`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, sqlmock.AnyArg(),
			fixture.request.RoundID, int64(fixture.request.StartRevision)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`
		INSERT INTO rgs_outbox (
			operator_id, aggregate_type, aggregate_id, event_type, payload
		) VALUES ($1,$2,$3,$4,$5)`)).
		WithArgs(fixture.request.OperatorID, "round", fixture.serverTransactionID,
			"ROUND_REJECTED", sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	record, changed, err := repository.RejectClaim(context.Background(), claim, failureCode)
	if err != nil || !changed || record.Status != rgs.RoundRejected || record.FailureReason != failureCode {
		t.Fatalf("RejectClaim() = record:%+v changed:%v error:%v", record, changed, err)
	}
	assertRepositoryExpectations(t, mock)
}

func TestMarkClaimManualReviewPersistsStableReasonCodeAcrossAuditRecords(t *testing.T) {
	db, mock := newRepositoryMock(t)
	repository, err := NewRepository(db)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newRoundRowFixture(t, rgs.RoundWalletPending)
	leaseUntil := fixture.createdAt.Add(time.Minute)
	fixture.walletLease = leaseUntil
	claim := rgs.WalletRecoveryClaim{
		Record: rgs.RoundRecord{Key: fixture.request.Key()}, Action: rgs.WalletRecoveryLookup,
		LeaseUntil: leaseUntil,
	}
	const reason = rgs.ManualReviewReasonWalletReceiptInvalid

	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(sessionSelect+`
		WHERE operator_id=$1 AND session_id=$2 FOR UPDATE`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID).
		WillReturnRows(validSessionRows(t, fixture))
	mock.ExpectQuery(regexp.QuoteMeta(roundSelect+`
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3 FOR UPDATE OF r`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(fixture.rows(t))
	mock.ExpectExec(regexp.QuoteMeta(`
		UPDATE rgs_rounds SET status=$4, failure_code=$5,
			wallet_phase='', next_attempt_at=NULL, wallet_lease_until=NULL, updated_at=$6
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
		  AND status IN ('PREPARED','WALLET_PENDING') AND wallet_lease_until=$7`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID,
			string(rgs.RoundManualReview), reason, sqlmock.AnyArg(), leaseUntil).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`
		UPDATE rgs_wallet_transactions
		SET status=$3, failure_code=$4, updated_at=$5
		WHERE operator_id=$1 AND transaction_id=$2
		  AND status IN ('PENDING','UNKNOWN')`)).
		WithArgs(fixture.request.OperatorID, fixture.serverTransactionID,
			"UNKNOWN", reason, sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`
			UPDATE rgs_sessions SET status='BLOCKED', updated_at=$3
			WHERE operator_id=$1 AND session_id=$2 AND pending_round_id=$4 AND revision=$5`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, sqlmock.AnyArg(),
			fixture.request.RoundID, int64(fixture.request.StartRevision)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`
		INSERT INTO rgs_outbox (
			operator_id, aggregate_type, aggregate_id, event_type, payload
		) VALUES ($1,$2,$3,$4,$5)`)).
		WithArgs(fixture.request.OperatorID, "round", fixture.serverTransactionID,
			"ROUND_MANUAL_REVIEW", jsonReasonArgument(reason)).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	record, changed, err := repository.MarkClaimManualReview(context.Background(), claim, reason)
	if err != nil || !changed || record.Status != rgs.RoundManualReview || record.FailureReason != reason {
		t.Fatalf("MarkClaimManualReview() = record:%+v changed:%v error:%v", record, changed, err)
	}
	assertRepositoryExpectations(t, mock)
}

func TestRejectClaimRollsBackWhenWalletLedgerIsMissing(t *testing.T) {
	db, mock := newRepositoryMock(t)
	repository, err := NewRepository(db)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newRoundRowFixture(t, rgs.RoundWalletPending)
	leaseUntil := fixture.createdAt.Add(time.Minute)
	fixture.walletLease = leaseUntil
	claim := rgs.WalletRecoveryClaim{
		Record: rgs.RoundRecord{Key: fixture.request.Key()}, Action: rgs.WalletRecoveryLookup,
		LeaseUntil: leaseUntil,
	}

	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(sessionSelect+`
		WHERE operator_id=$1 AND session_id=$2 FOR UPDATE`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID).
		WillReturnRows(validSessionRows(t, fixture))
	mock.ExpectQuery(regexp.QuoteMeta(roundSelect+`
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3 FOR UPDATE OF r`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(fixture.rows(t))
	mock.ExpectExec(regexp.QuoteMeta(`
		UPDATE rgs_rounds SET status=$4, failure_code=$5,
			wallet_phase='', next_attempt_at=NULL, wallet_lease_until=NULL, updated_at=$6
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
		  AND status IN ('PREPARED','WALLET_PENDING') AND wallet_lease_until=$7`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID,
			string(rgs.RoundRejected), "WALLET_REJECTED", sqlmock.AnyArg(), leaseUntil).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`
		UPDATE rgs_wallet_transactions
		SET status=$3, failure_code=$4, updated_at=$5
		WHERE operator_id=$1 AND transaction_id=$2
		  AND status IN ('PENDING','UNKNOWN')`)).
		WithArgs(fixture.request.OperatorID, fixture.serverTransactionID,
			"FAILED", "WALLET_REJECTED", sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectRollback()

	_, changed, err := repository.RejectClaim(context.Background(), claim, "WALLET_REJECTED")
	if !errors.Is(err, rgs.ErrManualReview) || changed {
		t.Fatalf("RejectClaim() = changed:%v error:%v, want ledger integrity failure", changed, err)
	}
	assertRepositoryExpectations(t, mock)
}

func TestAcknowledgeResultDeliveryQuarantinesCorruptCommittedRound(t *testing.T) {
	db, mock := newRepositoryMock(t)
	observer := &countingIntegrityObserver{}
	repository, err := NewRepository(db, observer)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newRoundRowFixture(t, rgs.RoundCommitted)
	fixture.resultJSON = []byte(`{"not":"a SpinResult"}`)
	resultHash, err := rgs.CommittedResultHashFor(fixture.result)
	if err != nil {
		t.Fatal(err)
	}
	receipt := rgs.ResultDeliveryAcknowledgement{
		OperatorID:          fixture.request.OperatorID,
		SessionID:           fixture.request.SessionID,
		RoundID:             fixture.request.RoundID,
		Sequence:            uint64(fixture.sequence),
		ResultHash:          resultHash,
		TransportGeneration: 1,
	}
	const reason = "committed result acknowledgement integrity validation failed"

	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(sessionSelect+`
		WHERE operator_id=$1 AND session_id=$2 FOR UPDATE`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID).
		WillReturnRows(validSessionRows(t, fixture))
	mock.ExpectQuery(regexp.QuoteMeta(roundSelect+`
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3 FOR UPDATE OF r`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(fixture.rows(t))
	mock.ExpectQuery(regexp.QuoteMeta(`
		SELECT server_transaction_id, status, integrity_quarantined_at IS NOT NULL
		FROM rgs_rounds
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
		FOR UPDATE`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(sqlmock.NewRows([]string{
			"server_transaction_id", "status", "already_quarantined",
		}).AddRow(fixture.serverTransactionID, string(fixture.status), false))
	mock.ExpectExec(regexp.QuoteMeta(`
		UPDATE rgs_rounds
		SET status=$4, failure_code=$5, wallet_phase='', next_attempt_at=NULL,
			wallet_lease_until=NULL, updated_at=$6,
			integrity_quarantined_at=$6
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID,
			string(rgs.RoundCommitted), reason, sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`
		UPDATE rgs_sessions SET status='BLOCKED', updated_at=$3
		WHERE operator_id=$1 AND session_id=$2`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`
		INSERT INTO rgs_outbox (
			operator_id, aggregate_type, aggregate_id, event_type, payload
		) VALUES ($1,$2,$3,$4,$5)`)).
		WithArgs(fixture.request.OperatorID, "round", fixture.serverTransactionID,
			"ROUND_INTEGRITY_FAILED", sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	_, changed, err := repository.AcknowledgeResultDelivery(context.Background(), receipt)
	if !errors.Is(err, rgs.ErrManualReview) || changed {
		t.Fatalf("AcknowledgeResultDelivery() changed=%v error=%v, want manual review", changed, err)
	}
	if observer.calls != 1 {
		t.Fatalf("integrity quarantine observations = %d, want 1", observer.calls)
	}
	assertRepositoryExpectations(t, mock)
}

func TestAcknowledgeResultDeliveryRejectsStaleTransportGenerationBeforeMutation(t *testing.T) {
	db, mock := newRepositoryMock(t)
	repository, err := NewRepository(db)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newRoundRowFixture(t, rgs.RoundCommitted)
	receipt := rgs.ResultDeliveryAcknowledgement{
		OperatorID: fixture.request.OperatorID, SessionID: fixture.request.SessionID,
		RoundID: fixture.request.RoundID, Sequence: uint64(fixture.sequence),
		ResultHash: strings.Repeat("a", 64), TransportGeneration: 1,
	}
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(sessionSelect+`
		WHERE operator_id=$1 AND session_id=$2 FOR UPDATE`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID).
		WillReturnRows(validSessionRowsWithGeneration(t, fixture, 2))
	mock.ExpectRollback()

	_, changed, err := repository.AcknowledgeResultDelivery(context.Background(), receipt)
	if !errors.Is(err, rgs.ErrSessionTimeout) || changed {
		t.Fatalf("stale-generation ACK changed=%t error=%v", changed, err)
	}
	assertRepositoryExpectations(t, mock)
}

func TestGetRoundRestoresExactFreeSpinInputFeature(t *testing.T) {
	tests := []struct {
		name   string
		input  game.FeatureState
		next   game.FeatureState
		events []game.Event
	}{
		{
			name: "active Kong Quest",
			input: game.FeatureState{
				Mode: game.FeatureExpansion, Remaining: 2, Awarded: 8, BetMinor: 100,
				WinMinor: 250, RageLevel: 2, RageCollected: 4,
			},
			next: game.FeatureState{
				Mode: game.FeatureExpansion, Remaining: 1, Awarded: 8, BetMinor: 100,
				WinMinor: 250, RageLevel: 2, RageCollected: 4,
			},
			events: []game.Event{{Type: "grid.expanded", Rows: 3, Ways: 27}},
		},
		{
			name: "terminal King Spin",
			input: game.FeatureState{
				Mode: game.FeatureOverdrive, Remaining: 1, Awarded: 8, BetMinor: 100,
				WinMinor: 250, RageLevel: 3, RageCollected: 7,
			},
			next: game.FeatureState{
				Mode: game.FeatureNone, RageLevel: 3, RageCollected: 7,
			},
			events: []game.Event{{
				Type: "free_spins.completed", Mode: game.FeatureOverdrive,
				Awarded: 8, CumulativeWinMinor: 250,
			}},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db, mock := newRepositoryMock(t)
			repository, err := NewRepository(db)
			if err != nil {
				t.Fatal(err)
			}
			fixture := newRoundRowFixture(t, rgs.RoundPrepared)
			makeFreeSpinFixture(t, &fixture, test.input, test.next, test.events)
			expectGetRound(t, mock, fixture)

			record, err := repository.GetRound(context.Background(), fixture.request.Key())
			if err != nil {
				t.Fatalf("GetRound() error = %v", err)
			}
			if record.Status != rgs.RoundPrepared || record.Result.FeatureState != test.next ||
				record.InputFeatureState != test.input {
				t.Fatalf("restored round = %#v", record)
			}
			assertRepositoryExpectations(t, mock)
		})
	}
}

func TestGetRoundFailsClosedWithoutProvableInputFeature(t *testing.T) {
	db, mock := newRepositoryMock(t)
	repository, err := NewRepository(db)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newRoundRowFixture(t, rgs.RoundPrepared)
	fixture.inputFeatureJSON = nil
	expectGetRound(t, mock, fixture)

	if _, err := repository.GetRound(context.Background(), fixture.request.Key()); !errors.Is(err, rgs.ErrManualReview) {
		t.Fatalf("GetRound() error = %v, want ErrManualReview", err)
	}
	assertRepositoryExpectations(t, mock)
}

func TestGetRoundRejectsPersistedIntegrityMismatches(t *testing.T) {
	tests := []struct {
		name   string
		status rgs.RoundStatus
		mutate func(*testing.T, *roundRowFixture)
	}{
		{
			name: "economic JSON disagrees with redundant columns", status: rgs.RoundPrepared,
			mutate: func(_ *testing.T, fixture *roundRowFixture) {
				fixture.result.TotalWinMinor = 100
				fixture.result.Events = []game.Event{{Type: "bonus.awarded", AmountMinor: 100}}
			},
		},
		{
			name: "visual outcome disagrees with prepared hash", status: rgs.RoundPrepared,
			mutate: func(_ *testing.T, fixture *roundRowFixture) {
				fixture.result.Grid[0][0].Symbol = game.SymbolPrism
			},
		},
		{
			name: "request fingerprint disagrees with columns", status: rgs.RoundPrepared,
			mutate: func(_ *testing.T, fixture *roundRowFixture) {
				fixture.fingerprint = "rgs-fp-v2:" + strings.Repeat("b", 64)
			},
		},
		{
			name: "wallet command digest disagrees with persisted identity", status: rgs.RoundPrepared,
			mutate: func(_ *testing.T, fixture *roundRowFixture) {
				fixture.walletCommandDigest = "rgs-wallet-cmd-v1:" + strings.Repeat("b", 64)
			},
		},
		{
			name: "open wallet phase is invalid", status: rgs.RoundPrepared,
			mutate: func(_ *testing.T, fixture *roundRowFixture) {
				fixture.walletPhase = "UNSAFE"
			},
		},
		{
			name: "open wallet schedule is absent", status: rgs.RoundPrepared,
			mutate: func(_ *testing.T, fixture *roundRowFixture) {
				fixture.nextAttemptAt = nil
			},
		},
		{
			name: "wallet attempt counter is negative", status: rgs.RoundPrepared,
			mutate: func(_ *testing.T, fixture *roundRowFixture) {
				fixture.lookupAttempts = -1
			},
		},
		{
			name: "unknown JSON field is not silently discarded", status: rgs.RoundPrepared,
			mutate: func(t *testing.T, fixture *roundRowFixture) {
				encoded, err := json.Marshal(fixture.result)
				if err != nil {
					t.Fatal(err)
				}
				var document map[string]any
				if err := json.Unmarshal(encoded, &document); err != nil {
					t.Fatal(err)
				}
				document["unapprovedEconomicExtension"] = 1
				fixture.resultJSON, err = json.Marshal(document)
				if err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "pre-multiplier path amount is not optional", status: rgs.RoundPrepared,
			mutate: func(t *testing.T, fixture *roundRowFixture) {
				setFixturePathAward(t, fixture)
				encoded, err := json.Marshal(fixture.result)
				if err != nil {
					t.Fatal(err)
				}
				var document map[string]any
				if err := json.Unmarshal(encoded, &document); err != nil {
					t.Fatal(err)
				}
				wins := document["Wins"].([]any)
				paths := wins[0].(map[string]any)["PathAwards"].([]any)
				delete(paths[0].(map[string]any), "BaseAmountMinor")
				fixture.resultJSON, err = json.Marshal(document)
				if err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "zero pre-multiplier path amount must still be present", status: rgs.RoundPrepared,
			mutate: func(t *testing.T, fixture *roundRowFixture) {
				setFixtureZeroPathAward(t, fixture)
				encoded, err := json.Marshal(fixture.result)
				if err != nil {
					t.Fatal(err)
				}
				var document map[string]any
				if err := json.Unmarshal(encoded, &document); err != nil {
					t.Fatal(err)
				}
				wins := document["Wins"].([]any)
				paths := wins[0].(map[string]any)["PathAwards"].([]any)
				delete(paths[1].(map[string]any), "BaseAmountMinor")
				fixture.resultJSON, err = json.Marshal(document)
				if err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "committed wallet transaction disagrees with receipt column", status: rgs.RoundCommitted,
			mutate: func(_ *testing.T, fixture *roundRowFixture) {
				fixture.result.WalletTransactionID = "wallet-tx-corrupt"
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db, mock := newRepositoryMock(t)
			repository, err := NewRepository(db)
			if err != nil {
				t.Fatal(err)
			}
			fixture := newRoundRowFixture(t, test.status)
			test.mutate(t, &fixture)
			expectGetRound(t, mock, fixture)

			_, err = repository.GetRound(context.Background(), fixture.request.Key())
			if !errors.Is(err, rgs.ErrManualReview) {
				t.Fatalf("GetRound() error = %v, want ErrManualReview", err)
			}
			assertRepositoryExpectations(t, mock)
		})
	}
}

func TestGetRoundReplaysAuthoritativePreMultiplierPathAmount(t *testing.T) {
	db, mock := newRepositoryMock(t)
	repository, err := NewRepository(db)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newRoundRowFixture(t, rgs.RoundPrepared)
	setFixturePathAward(t, &fixture)
	expectGetRound(t, mock, fixture)

	record, err := repository.GetRound(context.Background(), fixture.request.Key())
	if err != nil {
		t.Fatalf("GetRound() error = %v", err)
	}
	if len(record.Result.Wins) != 1 || len(record.Result.Wins[0].PathAwards) != 1 ||
		record.Result.Wins[0].PathAwards[0].BaseAmountMinor != 50 {
		t.Fatalf("replayed path awards = %+v", record.Result.Wins)
	}
	assertRepositoryExpectations(t, mock)
}

func TestGetRoundHydratesLegacyPaidFactsWithoutChangingOutcomeHash(t *testing.T) {
	db, mock := newRepositoryMock(t)
	repository, err := NewRepository(db)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newRoundRowFixture(t, rgs.RoundPrepared)
	setFixturePathAward(t, &fixture)
	fixture.result.ResultSchemaVersion = ""
	fixture.result.Wins[0].PaidAmountMinor = 0
	fixture.result.Wins[0].PathAwards[0].PaidAmountMinor = 0
	fixture.outcomeHash, err = rgs.PreparedOutcomeHashFor(fixture.result)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(fixture.result)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatal(err)
	}
	wins := document["Wins"].([]any)
	win := wins[0].(map[string]any)
	delete(win, "PaidAmountMinor")
	paths := win["PathAwards"].([]any)
	delete(paths[0].(map[string]any), "PaidAmountMinor")
	fixture.resultJSON, err = json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	expectGetRound(t, mock, fixture)

	record, err := repository.GetRound(context.Background(), fixture.request.Key())
	if err != nil {
		t.Fatalf("GetRound() error = %v", err)
	}
	if record.Result.ResultSchemaVersion != "" || len(record.Result.Wins) != 1 ||
		record.Result.Wins[0].PaidAmountMinor != 250 ||
		record.Result.Wins[0].PathAwards[0].PaidAmountMinor != 250 {
		t.Fatalf("hydrated legacy result = %+v", record.Result)
	}
	actualHash, err := rgs.PreparedOutcomeHashFor(record.Result)
	if err != nil || actualHash != fixture.outcomeHash {
		t.Fatalf("legacy outcome hash = %q error=%v, want %q", actualHash, err, fixture.outcomeHash)
	}
	assertRepositoryExpectations(t, mock)
}

func TestDecodeStrictRoundResultRequiresExplicitZeroPreMultiplierAmount(t *testing.T) {
	fixture := newRoundRowFixture(t, rgs.RoundPrepared)
	setFixtureZeroPathAward(t, &fixture)
	encoded, err := json.Marshal(fixture.result)
	if err != nil {
		t.Fatal(err)
	}
	var decoded rgs.SpinResult
	if err := decodeStrictRoundResult(encoded, &decoded); err != nil {
		t.Fatalf("decode explicit zero base amount: %v", err)
	}

	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatal(err)
	}
	wins := document["Wins"].([]any)
	paths := wins[0].(map[string]any)["PathAwards"].([]any)
	delete(paths[1].(map[string]any), "BaseAmountMinor")
	missing, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if err := decodeStrictRoundResult(missing, &decoded); err == nil {
		t.Fatal("decodeStrictRoundResult accepted a missing zero pre-multiplier amount")
	}
}

func TestMarkManualReviewQuarantinesUndecodableRoundWithoutWalletSideEffect(t *testing.T) {
	db, mock := newRepositoryMock(t)
	observer := &countingIntegrityObserver{}
	repository, err := NewRepository(db, observer)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newRoundRowFixture(t, rgs.RoundWalletPending)
	fixture.resultJSON = []byte(`{"not":"a SpinResult"}`)
	reason := "persisted round integrity validation failed"

	mock.ExpectBegin()
	expectIntegritySessionLock(t, mock, fixture)
	mock.ExpectQuery(regexp.QuoteMeta(`
		SELECT server_transaction_id, status, integrity_quarantined_at IS NOT NULL
		FROM rgs_rounds
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
		FOR UPDATE`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(sqlmock.NewRows([]string{"server_transaction_id", "status", "already_quarantined"}).
			AddRow(fixture.serverTransactionID, string(fixture.status), false))
	mock.ExpectExec(regexp.QuoteMeta(`
		UPDATE rgs_rounds
		SET status=$4, failure_code=$5, wallet_phase='', next_attempt_at=NULL,
			wallet_lease_until=NULL, updated_at=$6,
			integrity_quarantined_at=$6
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID,
			string(rgs.RoundManualReview), reason, sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`
			UPDATE rgs_wallet_transactions
			SET status=CASE WHEN status='PENDING' THEN $5 ELSE status END,
				failure_code=$3, updated_at=$4
			WHERE operator_id=$1 AND transaction_id=$2`)).
		WithArgs(fixture.request.OperatorID, fixture.serverTransactionID, reason, sqlmock.AnyArg(), "UNKNOWN").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`
		UPDATE rgs_sessions SET status='BLOCKED', updated_at=$3
		WHERE operator_id=$1 AND session_id=$2`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`
		INSERT INTO rgs_outbox (
			operator_id, aggregate_type, aggregate_id, event_type, payload
		) VALUES ($1,$2,$3,$4,$5)`)).
		WithArgs(fixture.request.OperatorID, "round", fixture.serverTransactionID,
			"ROUND_INTEGRITY_FAILED", sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	record, changed, err := repository.MarkManualReview(context.Background(), fixture.request.Key(), reason)
	if err != nil {
		t.Fatalf("MarkManualReview() error = %v", err)
	}
	if !changed {
		t.Fatal("MarkManualReview() changed = false, want true")
	}
	if observer.calls != 1 {
		t.Fatalf("integrity quarantine observations = %d, want 1", observer.calls)
	}
	if record.Status != rgs.RoundManualReview || record.FailureReason != reason {
		t.Fatalf("quarantined record = %#v", record)
	}
	assertRepositoryExpectations(t, mock)
}

func TestCommittedCorruptRoundSignalsIntegrityWithoutChangingEconomicStatus(t *testing.T) {
	db, mock := newRepositoryMock(t)
	observer := &countingIntegrityObserver{}
	repository, err := NewRepository(db, observer)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newRoundRowFixture(t, rgs.RoundCommitted)
	fixture.resultJSON = []byte(`{"not":"a SpinResult"}`)
	reason := "persisted round integrity validation failed"

	mock.ExpectBegin()
	expectIntegritySessionLock(t, mock, fixture)
	mock.ExpectQuery(regexp.QuoteMeta(`
		SELECT server_transaction_id, status, integrity_quarantined_at IS NOT NULL
		FROM rgs_rounds
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
		FOR UPDATE`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(sqlmock.NewRows([]string{
			"server_transaction_id", "status", "already_quarantined",
		}).AddRow(fixture.serverTransactionID, string(fixture.status), false))
	mock.ExpectExec(regexp.QuoteMeta(`
		UPDATE rgs_rounds
		SET status=$4, failure_code=$5, wallet_phase='', next_attempt_at=NULL,
			wallet_lease_until=NULL, updated_at=$6,
			integrity_quarantined_at=$6
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID,
			string(rgs.RoundCommitted), reason, sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`
		UPDATE rgs_sessions SET status='BLOCKED', updated_at=$3
		WHERE operator_id=$1 AND session_id=$2`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`
		INSERT INTO rgs_outbox (
			operator_id, aggregate_type, aggregate_id, event_type, payload
		) VALUES ($1,$2,$3,$4,$5)`)).
		WithArgs(fixture.request.OperatorID, "round", fixture.serverTransactionID,
			"ROUND_INTEGRITY_FAILED", sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	record, changed, err := repository.MarkManualReview(context.Background(), fixture.request.Key(), reason)
	if err != nil {
		t.Fatalf("MarkManualReview() error = %v", err)
	}
	if changed {
		t.Fatal("committed quarantine changed economic status")
	}
	if record.Status != rgs.RoundCommitted || observer.calls != 1 {
		t.Fatalf("quarantine result = status:%s observations:%d", record.Status, observer.calls)
	}
	assertRepositoryExpectations(t, mock)
}

func TestRepeatedIntegrityQuarantineIsIdempotentAndEmitsNoDuplicateOutboxEvent(t *testing.T) {
	for _, status := range []rgs.RoundStatus{rgs.RoundManualReview, rgs.RoundCommitted} {
		t.Run(string(status), func(t *testing.T) {
			db, mock := newRepositoryMock(t)
			observer := &countingIntegrityObserver{}
			repository, err := NewRepository(db, observer)
			if err != nil {
				t.Fatal(err)
			}
			fixture := newRoundRowFixture(t, status)
			fixture.resultJSON = []byte(`{"not":"a SpinResult"}`)
			reason := "persisted round integrity validation failed"

			mock.ExpectBegin()
			expectIntegritySessionLock(t, mock, fixture)
			mock.ExpectQuery(regexp.QuoteMeta(`
		SELECT server_transaction_id, status, integrity_quarantined_at IS NOT NULL
		FROM rgs_rounds
		WHERE operator_id=$1 AND session_id=$2 AND round_id=$3
		FOR UPDATE`)).
				WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
				WillReturnRows(sqlmock.NewRows([]string{
					"server_transaction_id", "status", "already_quarantined",
				}).AddRow(fixture.serverTransactionID, string(status), true))
			mock.ExpectCommit()

			record, changed, err := repository.MarkManualReview(
				context.Background(), fixture.request.Key(), reason,
			)
			if err != nil {
				t.Fatalf("repeated MarkManualReview() error = %v", err)
			}
			if changed {
				t.Fatal("repeated MarkManualReview() changed = true, want false")
			}
			if record.Status != status {
				t.Fatalf("repeated quarantine status = %s, want %s", record.Status, status)
			}
			if observer.calls != 0 {
				t.Fatalf("repeated integrity observations = %d, want 0", observer.calls)
			}
			// 未设置 UPDATE 或 INSERT 预期也使 sqlmock 能够证明，持久标记会抑制重复的
			// ROUND_INTEGRITY_FAILED 事件。
			assertRepositoryExpectations(t, mock)
		})
	}
}

func expectIntegritySessionLock(t *testing.T, mock sqlmock.Sqlmock, fixture roundRowFixture) {
	t.Helper()
	mock.ExpectQuery(regexp.QuoteMeta(sessionSelect+`
		WHERE operator_id=$1 AND session_id=$2 FOR UPDATE`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID).
		WillReturnRows(validSessionRows(t, fixture))
}

type countingIntegrityObserver struct {
	calls        int
	sessionCalls int
}

func (observer *countingIntegrityObserver) RoundIntegrityQuarantined() {
	observer.calls++
}

func (observer *countingIntegrityObserver) SessionIntegrityQuarantined() {
	observer.sessionCalls++
}

func TestValidateBindingMapsBlockedSessionToManualReview(t *testing.T) {
	fixture := newRoundRowFixture(t, rgs.RoundPrepared)
	session := rgs.Session{
		OperatorID: fixture.request.OperatorID, SessionID: fixture.request.SessionID,
		GameID: fixture.request.GameID, DefinitionVersion: fixture.request.DefinitionVersion,
		DefinitionHash: fixture.request.DefinitionHash, Currency: fixture.request.Currency,
		Status: rgs.SessionBlocked, ExpiresAt: time.Now().Add(time.Hour),
	}
	if err := validateBinding(session, fixture.request, time.Now().UTC()); !errors.Is(err, rgs.ErrManualReview) {
		t.Fatalf("validateBinding() error = %v, want ErrManualReview", err)
	}
}

func TestPrepareRoundExpiryUsesLockedDatabaseClock(t *testing.T) {
	database, mock := newRepositoryMock(t)
	repository, err := NewRepository(database)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newRoundRowFixture(t, rgs.RoundPrepared)
	podNow := time.Now().UTC()
	// 模拟该 Pod 慢两小时：按进程时钟会错误接受会话，但同一事务返回的
	// PostgreSQL 时钟已经越过会话到期点。
	expiresAt := podNow.Add(time.Hour)
	databaseNow := podNow.Add(2 * time.Hour)

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
			10_000, fixture.sequence-1, int64(fixture.request.StartRevision), fixture.inputFeatureJSON,
			nil, expiresAt, int64(1200), expiresAt, int64(1), nil,
		))
	mock.ExpectQuery(regexp.QuoteMeta(roundSelect+`
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(sqlmock.NewRows(roundRowColumns))
	mock.ExpectQuery(regexp.QuoteMeta(prepareAdmissionStateSQL)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID).
		WillReturnRows(sqlmock.NewRows([]string{"clock_timestamp", "result_delivery_pending"}).
			AddRow(databaseNow, false))
	mock.ExpectRollback()

	prepareCalled := false
	_, prepared, err := repository.PrepareRound(
		context.Background(), fixture.request, fixture.fingerprint,
		rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
			"https://wallet.test.invalid/database-clock-ledger",
		)),
		func(rgs.Session) (rgs.SpinResult, error) {
			prepareCalled = true
			return fixture.result, nil
		},
	)
	if !errors.Is(err, rgs.ErrSessionExpired) || prepared || prepareCalled {
		t.Fatalf("PrepareRound() = prepared:%v callback:%v error:%v, want database-clock expiry",
			prepared, prepareCalled, err)
	}
	assertRepositoryExpectations(t, mock)
}

func newRoundRowFixture(t *testing.T, status rgs.RoundStatus) roundRowFixture {
	t.Helper()
	request := rgs.SpinRequest{
		OperatorID: "operator-a", SessionID: "session-a", RoundID: "round-a",
		GameID: "game-a", DefinitionVersion: "math-v1",
		DefinitionHash: strings.Repeat("a", 64), Currency: "USD",
		RoundKind: rgs.RoundKindBase, BetMinor: 100, StartRevision: 4,
		TransportGeneration: 1,
	}
	result := rgs.SpinResult{
		ResultSchemaVersion: rgs.ResultSchemaPaidFactsV1,
		OperatorID:          request.OperatorID, SessionID: request.SessionID, RoundID: request.RoundID,
		GameID: request.GameID, DefinitionVersion: request.DefinitionVersion,
		DefinitionHash: request.DefinitionHash, Currency: request.Currency,
		RoundKind: request.RoundKind, ServerTransactionID: "rgs-op-v1:fixture",
		StartRevision: request.StartRevision, Sequence: 8, BetMinor: request.BetMinor,
		ChargedBetMinor: request.BetMinor,
		Grid: game.Grid{
			{{Symbol: game.SymbolOrbit}, {Symbol: game.SymbolPrism}, {Symbol: game.SymbolPulse}},
			{{Symbol: game.SymbolNova}, {Symbol: game.SymbolCircuit}, {Symbol: game.SymbolTank}},
			{{Symbol: game.SymbolOrbit}, {Symbol: game.SymbolPrism}, {Symbol: game.SymbolPulse}},
		},
		FeatureState: game.EmptyFeatureState(),
	}
	fixture := roundRowFixture{
		request: request, result: result, status: status,
		fingerprint: rgs.FingerprintFor(request), serverTransactionID: result.ServerTransactionID,
		inputFeature: game.EmptyFeatureState(),
		betMinor:     request.BetMinor, chargedMinor: result.ChargedBetMinor,
		winMinor: result.TotalWinMinor, endRevision: int64(request.StartRevision + 1),
		sequence: int64(result.Sequence), createdAt: time.Date(2026, 7, 26, 4, 5, 6, 0, time.UTC),
		sessionStatus: string(rgs.SessionActive),
	}
	profileJSON, err := json.Marshal(rgs.AtomicHTTPProfile(
		rgs.WalletRouteBindingIDForCanonicalTarget("https://wallet.test.invalid/ledger"),
	))
	if err != nil {
		t.Fatal(err)
	}
	fixture.walletProfileJSON = profileJSON
	if status == rgs.RoundPrepared || status == rgs.RoundWalletPending {
		fixture.walletPhase = string(rgs.WalletRecoveryApply)
		if status == rgs.RoundWalletPending {
			fixture.walletPhase = string(rgs.WalletRecoveryLookup)
		}
		fixture.nextAttemptAt = fixture.createdAt
	}
	if status == rgs.RoundCommitted {
		fixture.result.EndRevision = request.StartRevision + 1
		fixture.result.WalletTransactionID = "wallet-tx-a"
		fixture.result.BalanceMinor = 9_900
		fixture.walletTransaction = fixture.result.WalletTransactionID
		fixture.walletBalance = fixture.result.BalanceMinor
	}
	fixture.inputFeatureJSON, err = json.Marshal(fixture.inputFeature)
	if err != nil {
		t.Fatal(err)
	}
	fixture.outcomeHash, err = rgs.PreparedOutcomeHashFor(fixture.result)
	if err != nil {
		t.Fatal(err)
	}
	return fixture
}

func setFixturePathAward(t *testing.T, fixture *roundRowFixture) {
	t.Helper()
	fixture.result.Grid[1][0] = game.Cell{Symbol: game.SymbolWild, Multiplier: 5}
	fixture.result.Wins = []game.Win{{
		ID: "orbit-3", Symbol: game.SymbolOrbit, Ways: 1,
		AmountMinor: 250, PaidAmountMinor: 250,
		Cells: []game.Position{{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0}},
		PathAwards: []game.PathAward{{
			Cells: []game.Position{
				{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0},
			},
			Multiplier: 5, BaseAmountMinor: 50,
			AmountMinor: 250, PaidAmountMinor: 250,
		}},
	}}
	fixture.result.TotalWinMinor = 250
	fixture.winMinor = 250
	var err error
	fixture.outcomeHash, err = rgs.PreparedOutcomeHashFor(fixture.result)
	if err != nil {
		t.Fatal(err)
	}
}

func setFixtureZeroPathAward(t *testing.T, fixture *roundRowFixture) {
	t.Helper()
	fixture.result.Grid[1][0] = game.Cell{Symbol: game.SymbolWild, Multiplier: 5}
	fixture.result.Grid[1][1] = game.Cell{Symbol: game.SymbolOrbit}
	fixture.result.Wins = []game.Win{{
		ID: "orbit-3", Symbol: game.SymbolOrbit, Ways: 2,
		AmountMinor: 250, PaidAmountMinor: 250,
		Cells: []game.Position{
			{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 1, Row: 1}, {Reel: 2, Row: 0},
		},
		PathAwards: []game.PathAward{
			{
				Cells: []game.Position{
					{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0},
				},
				Multiplier: 5, BaseAmountMinor: 50,
				AmountMinor: 250, PaidAmountMinor: 250,
			},
			{
				Cells: []game.Position{
					{Reel: 0, Row: 0}, {Reel: 1, Row: 1}, {Reel: 2, Row: 0},
				},
				Multiplier: 1, BaseAmountMinor: 0, AmountMinor: 0,
			},
		},
	}}
	fixture.result.TotalWinMinor = 250
	fixture.winMinor = 250
	var err error
	fixture.outcomeHash, err = rgs.PreparedOutcomeHashFor(fixture.result)
	if err != nil {
		t.Fatal(err)
	}
}

func (fixture roundRowFixture) rows(t *testing.T) *sqlmock.Rows {
	t.Helper()
	resultJSON := fixture.resultJSON
	if resultJSON == nil {
		var err error
		resultJSON, err = json.Marshal(fixture.result)
		if err != nil {
			t.Fatal(err)
		}
	}
	walletCommandDigest := fixture.walletCommandDigest
	if walletCommandDigest == nil && !fixture.omitCommandDigest {
		walletCommandDigest = rgs.CommandDigestFor(rgs.WalletRound{
			OperationID: fixture.serverTransactionID, Fingerprint: fixture.fingerprint,
			OperatorID: fixture.request.OperatorID, PlayerID: "player-a",
			WalletAccountID: "wallet-account-a", WalletSessionRef: "wallet-session-a",
			SessionID: fixture.request.SessionID, RoundID: fixture.request.RoundID,
			GameID: fixture.request.GameID, DefinitionVersion: fixture.request.DefinitionVersion,
			DefinitionHash: fixture.request.DefinitionHash, RoundKind: fixture.request.RoundKind,
			Currency: fixture.request.Currency, DebitMinor: fixture.chargedMinor,
			CreditMinor: fixture.winMinor,
		})
	}
	return sqlmock.NewRows(roundRowColumns).AddRow(
		fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID,
		fixture.serverTransactionID, fixture.fingerprint, string(fixture.status),
		string(fixture.request.RoundKind), fixture.request.GameID,
		fixture.request.DefinitionVersion, fixture.request.DefinitionHash,
		fixture.request.Currency, fixture.betMinor, fixture.inputFeatureJSON,
		fixture.chargedMinor, fixture.winMinor,
		int64(fixture.request.StartRevision), fixture.endRevision, fixture.sequence,
		resultJSON, fixture.outcomeHash, fixture.walletPhase, fixture.nextAttemptAt,
		fixture.applyAttempts, fixture.lookupAttempts, walletCommandDigest,
		fixture.walletProfileJSON,
		fixture.walletTransaction, fixture.walletBalance,
		fixture.walletLease, nil, 1, fixture.createdAt, fixture.createdAt,
		"player-a", "wallet-account-a", "wallet-session-a",
		fixture.sessionStatus, fixture.sessionQuarantined,
	)
}

func makeFreeSpinFixture(
	t *testing.T,
	fixture *roundRowFixture,
	input game.FeatureState,
	next game.FeatureState,
	events []game.Event,
) {
	t.Helper()
	fixture.request.RoundKind = rgs.RoundKindFreeSpin
	fixture.result.RoundKind = rgs.RoundKindFreeSpin
	fixture.result.ChargedBetMinor = 0
	fixture.result.Events = events
	fixture.result.FeatureState = next
	fixture.inputFeature = input
	fixture.chargedMinor = 0
	fixture.fingerprint = rgs.FingerprintFor(fixture.request)
	var err error
	fixture.inputFeatureJSON, err = json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	fixture.outcomeHash, err = rgs.PreparedOutcomeHashFor(fixture.result)
	if err != nil {
		t.Fatal(err)
	}
}

func validSessionRows(t *testing.T, fixture roundRowFixture) *sqlmock.Rows {
	return validSessionRowsWithGeneration(t, fixture, 1)
}

func validSessionRowsWithGeneration(t *testing.T, fixture roundRowFixture, generation int64) *sqlmock.Rows {
	t.Helper()
	featureJSON, err := json.Marshal(fixture.inputFeature)
	if err != nil {
		t.Fatal(err)
	}
	return sqlmock.NewRows([]string{
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
		10_000, 7, int64(fixture.request.StartRevision), featureJSON,
		fixture.request.RoundID, fixture.createdAt.Add(time.Hour), int64(1200),
		fixture.createdAt.Add(20*time.Minute), generation, nil,
	)
}

func validWalletLedgerRows(fixture roundRowFixture, status string) *sqlmock.Rows {
	return sqlmock.NewRows([]string{
		"operator_id", "transaction_id", "session_id", "round_id", "kind", "status",
		"currency", "amount_minor", "request_fingerprint",
	}).AddRow(
		fixture.request.OperatorID, fixture.serverTransactionID,
		fixture.request.SessionID, fixture.request.RoundID, "PLAY", status,
		fixture.request.Currency, fixture.chargedMinor, fixture.fingerprint,
	)
}

func expectGetRound(t *testing.T, mock sqlmock.Sqlmock, fixture roundRowFixture) {
	t.Helper()
	mock.ExpectQuery(regexp.QuoteMeta(roundSelect+`
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(fixture.rows(t))
}

func newRepositoryMock(t *testing.T) (*sql.DB, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db, mock
}

func assertRepositoryExpectations(t *testing.T, mock sqlmock.Sqlmock) {
	t.Helper()
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("database expectations: %v", err)
	}
}

type jsonReasonArgument string

func (expected jsonReasonArgument) Match(value driver.Value) bool {
	var encoded []byte
	switch typed := value.(type) {
	case []byte:
		encoded = typed
	case string:
		encoded = []byte(typed)
	default:
		return false
	}
	var payload struct {
		Reason string `json:"reason"`
	}
	return json.Unmarshal(encoded, &payload) == nil && payload.Reason == string(expected)
}
