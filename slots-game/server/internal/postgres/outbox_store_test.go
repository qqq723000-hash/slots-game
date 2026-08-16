package postgres

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"slots-game/server/internal/outbox"
)

func TestOutboxStoreClaimUsesFencedSkipLockedStatement(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	store, err := NewOutboxStore(database)
	if err != nil {
		t.Fatal(err)
	}
	created := time.Date(2026, 7, 26, 2, 3, 4, 0, time.UTC)
	available := created.Add(time.Second)
	leaseUntil := available.Add(30 * time.Second)
	columns := []string{
		"id", "operator_id", "aggregate_type", "aggregate_id", "event_type",
		"payload", "created_at", "available_at", "lease_until", "attempts",
	}
	mock.ExpectQuery(regexp.QuoteMeta(outboxClaimSQL)).
		WithArgs("instance-a", "lease-token-a", int64(30_000), 25).
		WillReturnRows(sqlmock.NewRows(columns).AddRow(
			7, "operator-a", "round", "rgs-op-v1:abcdef", "ROUND_COMMITTED",
			[]byte(`{"roundId":"round-a"}`), created, available, leaseUntil, 2,
		))

	events, err := store.Claim(context.Background(), outbox.ClaimRequest{
		Owner: "instance-a", LeaseToken: "lease-token-a",
		LeaseDuration: 30 * time.Second, Limit: 25,
	})
	if err != nil {
		t.Fatalf("Claim() error = %v", err)
	}
	if len(events) != 1 || events[0].ID != 7 || events[0].Attempts != 2 ||
		string(events[0].Payload) != `{"roundId":"round-a"}` ||
		!events[0].LeaseUntil.Equal(leaseUntil) {
		t.Fatalf("Claim() = %+v", events)
	}
	assertOutboxExpectations(t, mock)
}

func TestOutboxStoreRejectsInvalidPersistedEvent(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	store, _ := NewOutboxStore(database)
	now := time.Now().UTC()
	mock.ExpectQuery(regexp.QuoteMeta(outboxClaimSQL)).
		WithArgs("instance-a", "lease-token-a", int64(1_000), 1).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "operator_id", "aggregate_type", "aggregate_id", "event_type",
			"payload", "created_at", "available_at", "lease_until", "attempts",
		}).AddRow(
			1, "operator-a", "round", "round-a", "ROUND_COMMITTED",
			[]byte(`[]`), now, now, now.Add(time.Second), 1,
		))

	_, err = store.Claim(context.Background(), outbox.ClaimRequest{
		Owner: "instance-a", LeaseToken: "lease-token-a",
		LeaseDuration: time.Second, Limit: 1,
	})
	if !errors.Is(err, outbox.ErrInvariant) {
		t.Fatalf("Claim() error = %v, want ErrInvariant", err)
	}
	assertOutboxExpectations(t, mock)
}

func TestOutboxStoreMarksPublishedOnlyForCurrentLease(t *testing.T) {
	for _, test := range []struct {
		name string
		rows int64
		want error
	}{
		{name: "owned", rows: 1},
		{name: "stale token", rows: 0, want: outbox.ErrLeaseLost},
	} {
		t.Run(test.name, func(t *testing.T) {
			database, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer database.Close()
			store, _ := NewOutboxStore(database)
			mock.ExpectExec(regexp.QuoteMeta(outboxMarkPublishedSQL)).
				WithArgs(int64(42), "lease-token-a").
				WillReturnResult(sqlmock.NewResult(0, test.rows))

			err = store.MarkPublished(context.Background(), outbox.Completion{
				EventID: 42, LeaseToken: "lease-token-a",
			})
			if !errors.Is(err, test.want) {
				t.Fatalf("MarkPublished() error = %v, want %v", err, test.want)
			}
			assertOutboxExpectations(t, mock)
		})
	}
}

func TestOutboxStoreSchedulesFailedDeliveryAndReleasesLease(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	store, _ := NewOutboxStore(database)
	mock.ExpectExec(regexp.QuoteMeta(outboxMarkFailedSQL)).
		WithArgs(int64(8), "lease-token-b", int64(2_000), "PUBLISH_FAILED").
		WillReturnResult(sqlmock.NewResult(0, 1))

	err = store.MarkFailed(context.Background(), outbox.Failure{
		EventID: 8, LeaseToken: "lease-token-b",
		RetryAfter: 2 * time.Second, Code: "PUBLISH_FAILED",
	})
	if err != nil {
		t.Fatalf("MarkFailed() error = %v", err)
	}
	assertOutboxExpectations(t, mock)
}

func TestOutboxStoreValidatesBeforeDatabaseAccess(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	store, _ := NewOutboxStore(database)

	if _, err := NewOutboxStore(nil); !errors.Is(err, outbox.ErrInvalidInput) {
		t.Fatalf("NewOutboxStore(nil) error = %v", err)
	}
	if _, err := store.Claim(context.Background(), outbox.ClaimRequest{
		Owner: "invalid owner", LeaseToken: "token", LeaseDuration: time.Second, Limit: 1,
	}); !errors.Is(err, outbox.ErrInvalidInput) {
		t.Fatalf("Claim() error = %v", err)
	}
	if err := store.MarkPublished(context.Background(), outbox.Completion{}); !errors.Is(err, outbox.ErrInvalidInput) {
		t.Fatalf("MarkPublished() error = %v", err)
	}
	if err := store.MarkFailed(context.Background(), outbox.Failure{
		EventID: 1, LeaseToken: "token", RetryAfter: time.Second, Code: "unsafe detail",
	}); !errors.Is(err, outbox.ErrInvalidInput) {
		t.Fatalf("MarkFailed() error = %v", err)
	}
	assertOutboxExpectations(t, mock)
}

func TestOutboxStoreChecksBacklogAgainstDatabaseClock(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	store, err := NewOutboxStore(database)
	if err != nil {
		t.Fatal(err)
	}
	mock.ExpectQuery(regexp.QuoteMeta(outboxBacklogCheckSQL)).
		WithArgs(int64(300_000)).
		WillReturnRows(sqlmock.NewRows([]string{"within_limit"}).AddRow(false))
	if err := store.CheckBacklog(context.Background(), 5*time.Minute); !errors.Is(err, outbox.ErrDeliveryLag) {
		t.Fatalf("CheckBacklog() error = %v", err)
	}
	mock.ExpectQuery(regexp.QuoteMeta(outboxBacklogCheckSQL)).
		WithArgs(int64(300_000)).
		WillReturnRows(sqlmock.NewRows([]string{"within_limit"}).AddRow(true))
	if err := store.CheckBacklog(context.Background(), 5*time.Minute); err != nil {
		t.Fatalf("CheckBacklog() error = %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
	if err := store.CheckBacklog(context.Background(), 0); !errors.Is(err, outbox.ErrInvalidInput) {
		t.Fatalf("invalid CheckBacklog() error = %v", err)
	}
}

func TestRequireOutboxLeaseRejectsImpossibleRowCount(t *testing.T) {
	if err := requireOutboxLease(sqlResult{rows: 2}); !errors.Is(err, outbox.ErrInvariant) {
		t.Fatalf("requireOutboxLease() error = %v", err)
	}
}

type sqlResult struct {
	rows int64
}

func (sqlResult) LastInsertId() (int64, error)        { return 0, errors.New("unsupported") }
func (result sqlResult) RowsAffected() (int64, error) { return result.rows, nil }

func assertOutboxExpectations(t *testing.T, mock sqlmock.Sqlmock) {
	t.Helper()
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

var _ sql.Result = sqlResult{}
