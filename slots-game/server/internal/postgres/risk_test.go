package postgres

import (
	"context"
	"database/sql"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"slots-game/server/internal/rgs"
)

func TestRiskPrepareSQLPersistsGateWithoutMakingWalletRecoverable(t *testing.T) {
	for _, required := range []string{
		"'RISK_PENDING'", "INSERT INTO rgs_risk_reviews", "'ROUND_RISK_PENDING'",
		"wallet_phase", "wallet_command_digest", "wallet_profile", "NULL,$22,$22",
	} {
		if !strings.Contains(prepareRiskRoundWriteSQL, required) {
			t.Fatalf("risk prepare SQL missing %q", required)
		}
	}
	for _, forbidden := range []string{"registered_recovery_operator", "'ROUND_PREPARED'"} {
		if strings.Contains(prepareRiskRoundWriteSQL, forbidden) {
			t.Fatalf("risk prepare SQL contains premature wallet scheduling token %q", forbidden)
		}
	}
}

func TestHighValueRiskMigrationBindsOperatorIdempotencyToOneRound(t *testing.T) {
	migration, err := migrationFiles.ReadFile("migrations/0011_high_value_risk_review.sql")
	if err != nil {
		t.Fatal(err)
	}
	sqlText := string(migration)
	for _, required := range []string{
		"CREATE UNIQUE INDEX rgs_risk_reviews_operator_idempotency",
		"ON rgs_risk_reviews (operator_id, idempotency_key)",
		"WHERE idempotency_key IS NOT NULL",
	} {
		if !strings.Contains(sqlText, required) {
			t.Fatalf("risk migration missing %q", required)
		}
	}
}

func TestRiskPendingOutboxIsSummaryOnly(t *testing.T) {
	request := rgs.SpinRequest{
		OperatorID: "operator-a", SessionID: "session-a", RoundID: "round-a", Currency: "EUR",
	}
	fields := riskPendingOutboxFields(request, rgs.RiskAssessment{
		PolicyVersion: "payout-v1", ThresholdMinor: 10_000, PayoutMinor: 12_000,
		ExpiresAt:    time.Date(2026, 8, 25, 1, 2, 3, 0, time.UTC),
		ExpiryPolicy: rgs.RiskExpiryReject, SummaryHash: strings.Repeat("a", 64),
	})
	for _, required := range []string{
		"sessionId", "roundId", "policyVersion", "thresholdMinor", "payoutMinor",
		"currency", "expiryPolicy", "summaryHash", "expiresAt",
	} {
		if _, ok := fields[required]; !ok {
			t.Fatalf("risk outbox missing %q: %#v", required, fields)
		}
	}
	for _, forbidden := range []string{
		"result", "grid", "wins", "events", "playerId", "walletAccountId", "walletSessionId",
	} {
		if _, ok := fields[forbidden]; ok {
			t.Fatalf("risk outbox exposes %q: %#v", forbidden, fields)
		}
	}
}

func TestRiskDecisionReplayRequiresSameSignedIdempotencyIdentity(t *testing.T) {
	command := rgs.RiskDecisionCommand{
		RoundKey:  rgs.RoundKey{OperatorID: "operator-a", SessionID: "session-a", RoundID: "round-a"},
		RequestID: "request-a", IdempotencyKey: "decision-a", CredentialKeyID: "key-a",
		Decision: rgs.RiskDecisionApprove, ReasonCode: "RISK_APPROVED",
	}
	fingerprint, err := rgs.RiskDecisionFingerprint(command)
	if err != nil {
		t.Fatal(err)
	}
	decidedAt := time.Date(2026, 8, 25, 1, 2, 3, 0, time.UTC)
	review := persistedRiskReview{
		status: "APPROVED", decision: sql.NullString{String: "APPROVE", Valid: true},
		idempotencyKey:      sql.NullString{String: "decision-a", Valid: true},
		decisionFingerprint: sql.NullString{String: fingerprint, Valid: true},
		decidedAt:           sql.NullTime{Time: decidedAt, Valid: true},
	}
	result, ok := replayRiskDecision(command, fingerprint, review)
	if !ok || !result.Replayed || result.DecidedAt != decidedAt || result.Status != rgs.RoundPrepared {
		t.Fatalf("replay = %+v, ok=%v", result, ok)
	}
	command.IdempotencyKey = "decision-b"
	if _, ok := replayRiskDecision(command, fingerprint, review); ok {
		t.Fatal("different idempotency key replayed")
	}
}

func TestApproveRiskDecisionIsOneAuditedTransaction(t *testing.T) {
	database, mock := newRepositoryMock(t)
	policy := rgs.HighValueRiskPolicy{
		Enabled: true, ThresholdMinor: 1, PolicyVersion: "payout-v1",
		ReviewTTL: time.Hour, ExpiryPolicy: rgs.RiskExpiryReject,
	}
	repository, err := NewRepositoryWithOptions(database, RepositoryOptions{RiskPolicy: policy})
	if err != nil {
		t.Fatal(err)
	}
	fixture := newRoundRowFixture(t, rgs.RoundRiskPending)
	setFixturePathAward(t, &fixture)
	now := fixture.createdAt.Add(time.Minute)
	expiresAt := now.Add(time.Hour)
	summaryHash, err := rgs.RiskAssessmentSummaryHash(fixture.result, rgs.RiskAssessment{
		PolicyVersion: "payout-v1", ThresholdMinor: 1, PayoutMinor: fixture.result.TotalWinMinor,
		ExpiresAt: expiresAt, ExpiryPolicy: rgs.RiskExpiryReject,
	})
	if err != nil {
		t.Fatal(err)
	}
	command := rgs.RiskDecisionCommand{
		RoundKey: fixture.request.Key(), RequestID: "request-a", IdempotencyKey: "decision-a",
		CredentialKeyID: "key-a", Decision: rgs.RiskDecisionApprove, ReasonCode: "RISK_APPROVED",
	}
	fingerprint, err := rgs.RiskDecisionFingerprint(command)
	if err != nil {
		t.Fatal(err)
	}
	mock.ExpectBegin()
	expectIntegritySessionLock(t, mock, fixture)
	mock.ExpectQuery(regexp.QuoteMeta(roundSelect+`
		WHERE r.operator_id=$1 AND r.session_id=$2 AND r.round_id=$3 FOR UPDATE OF r`)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(fixture.rows(t))
	mock.ExpectQuery(regexp.QuoteMeta(riskReviewSelectForUpdate)).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID).
		WillReturnRows(sqlmock.NewRows([]string{
			"policy_version", "threshold_minor", "payout_minor", "summary_hash", "expiry_policy", "status", "expires_at",
			"decision", "reason_code", "request_id", "idempotency_key", "credential_key_id",
			"decision_fingerprint", "decided_at", "database_now",
		}).AddRow(
			"payout-v1", int64(1), fixture.result.TotalWinMinor, summaryHash, "REJECT", "PENDING", expiresAt,
			nil, nil, nil, nil, nil, nil, nil, now,
		))
	mock.ExpectExec(`UPDATE rgs_rounds`).
		WithArgs(fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID, now).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE rgs_risk_reviews`).
		WithArgs(
			fixture.request.OperatorID, fixture.request.SessionID, fixture.request.RoundID,
			"APPROVED", "APPROVE", "RISK_APPROVED", "request-a", "decision-a", "key-a",
			fingerprint, now,
		).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO rgs_outbox`).
		WithArgs(
			fixture.request.OperatorID, "round", fixture.serverTransactionID,
			"ROUND_RISK_APPROVED", sqlmock.AnyArg(),
		).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	result, err := repository.DecideRisk(context.Background(), command)
	if err != nil {
		t.Fatalf("DecideRisk() error = %v", err)
	}
	if result.Status != rgs.RoundPrepared || result.Decision != rgs.RiskDecisionApprove ||
		result.DecidedAt != now || result.Replayed {
		t.Fatalf("DecideRisk() = %+v", result)
	}
	assertRepositoryExpectations(t, mock)
}
