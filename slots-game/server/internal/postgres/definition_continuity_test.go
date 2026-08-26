package postgres

import (
	"context"
	"errors"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestDefinitionContinuityRequiresEveryPredecessorWorkClassToDrain(t *testing.T) {
	const digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	for _, test := range []struct {
		name    string
		counts  [4]int64
		wantErr bool
	}{
		{name: "drained"},
		{name: "unexpired active session", counts: [4]int64{1, 0, 0, 0}, wantErr: true},
		{name: "active feature", counts: [4]int64{0, 1, 0, 0}, wantErr: true},
		{name: "nonterminal round", counts: [4]int64{0, 0, 1, 0}, wantErr: true},
		{name: "unexpired pending delivery", counts: [4]int64{0, 0, 0, 1}, wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			database, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer database.Close()
			mock.ExpectQuery(regexp.QuoteMeta(definitionContinuitySQL)).
				WithArgs("iron-colossus", "definition-2", digest).
				WillReturnRows(sqlmock.NewRows([]string{
					"active_sessions", "active_features", "nonterminal_rounds", "pending_deliveries",
				}).AddRow(test.counts[0], test.counts[1], test.counts[2], test.counts[3]))

			snapshot, err := CheckDefinitionContinuity(
				context.Background(), database, "iron-colossus", "definition-2", digest,
			)
			if test.wantErr != errors.Is(err, ErrDefinitionContinuity) {
				t.Fatalf("error = %v, want continuity error %v", err, test.wantErr)
			}
			if test.wantErr == snapshot.Drained() {
				t.Fatalf("snapshot = %+v, wantErr = %v", snapshot, test.wantErr)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestDefinitionContinuityFailsClosedOnQueryAndInvalidIdentity(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	const digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	mock.ExpectQuery(regexp.QuoteMeta(definitionContinuitySQL)).
		WithArgs("iron-colossus", "definition-2", digest).
		WillReturnError(errors.New("database unavailable"))
	if _, err := CheckDefinitionContinuity(
		context.Background(), database, "iron-colossus", "definition-2", digest,
	); err == nil || errors.Is(err, ErrDefinitionContinuity) {
		t.Fatalf("query error = %v", err)
	}
	if _, err := CheckDefinitionContinuity(
		context.Background(), database, "", "definition-2", digest,
	); err == nil {
		t.Fatal("invalid identity unexpectedly accepted")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
