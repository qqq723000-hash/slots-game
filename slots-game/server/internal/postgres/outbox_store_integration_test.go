package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"slots-game/server/internal/outbox"
)

func TestPostgresOutboxConcurrentClaimsOrderingAndFencing(t *testing.T) {
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
	operatorID := fmt.Sprintf("outbox-test-%d", time.Now().UnixNano())
	defer migrator.ExecContext(context.Background(), `DELETE FROM rgs_outbox WHERE operator_id=$1`, operatorID)

	for index := range 20 {
		insertOutboxFixture(t, ctx, database, operatorID, fmt.Sprintf("aggregate-%d", index))
	}
	storeA, _ := NewOutboxStore(database)
	storeB, _ := NewOutboxStore(database)
	requests := []outbox.ClaimRequest{
		{Owner: "instance-a", LeaseToken: "lease-a", LeaseDuration: time.Minute, Limit: 20},
		{Owner: "instance-b", LeaseToken: "lease-b", LeaseDuration: time.Minute, Limit: 20},
	}
	claims := make([][]outbox.Event, 2)
	failures := make([]error, 2)
	var group sync.WaitGroup
	for index, store := range []*OutboxStore{storeA, storeB} {
		group.Add(1)
		go func() {
			defer group.Done()
			claims[index], failures[index] = store.Claim(ctx, requests[index])
		}()
	}
	group.Wait()
	seen := make(map[int64]struct{}, 20)
	for claimIndex, events := range claims {
		if failures[claimIndex] != nil {
			t.Fatalf("Claim[%d] error = %v", claimIndex, failures[claimIndex])
		}
		for _, event := range events {
			if _, duplicate := seen[event.ID]; duplicate {
				t.Fatalf("event %d was leased by two instances", event.ID)
			}
			seen[event.ID] = struct{}{}
			if event.Attempts != 1 {
				t.Fatalf("event %d attempts = %d", event.ID, event.Attempts)
			}
			if err := storeA.MarkPublished(ctx, outbox.Completion{
				EventID: event.ID, LeaseToken: requests[claimIndex].LeaseToken,
			}); err != nil {
				t.Fatalf("MarkPublished(%d): %v", event.ID, err)
			}
		}
	}
	if len(seen) != 20 {
		t.Fatalf("unique claims = %d, want 20", len(seen))
	}

	firstID := insertOutboxFixture(t, ctx, database, operatorID, "ordered-aggregate")
	secondID := insertOutboxFixture(t, ctx, database, operatorID, "ordered-aggregate")
	ordered, err := storeA.Claim(ctx, outbox.ClaimRequest{
		Owner: "instance-a", LeaseToken: "ordered-lease-a",
		LeaseDuration: time.Minute, Limit: 10,
	})
	if err != nil || len(ordered) != 1 || ordered[0].ID != firstID {
		t.Fatalf("first ordered Claim() = (%+v, %v)", ordered, err)
	}
	if err := storeA.MarkPublished(ctx, outbox.Completion{
		EventID: firstID, LeaseToken: "ordered-lease-a",
	}); err != nil {
		t.Fatal(err)
	}
	ordered, err = storeB.Claim(ctx, outbox.ClaimRequest{
		Owner: "instance-b", LeaseToken: "ordered-lease-b",
		LeaseDuration: time.Minute, Limit: 10,
	})
	if err != nil || len(ordered) != 1 || ordered[0].ID != secondID {
		t.Fatalf("second ordered Claim() = (%+v, %v)", ordered, err)
	}
	if err := storeB.MarkPublished(ctx, outbox.Completion{
		EventID: secondID, LeaseToken: "ordered-lease-b",
	}); err != nil {
		t.Fatal(err)
	}

	fencedID := insertOutboxFixture(t, ctx, database, operatorID, "fenced-aggregate")
	oldClaim, err := storeA.Claim(ctx, outbox.ClaimRequest{
		Owner: "instance-a", LeaseToken: "stale-lease",
		LeaseDuration: time.Minute, Limit: 1,
	})
	if err != nil || len(oldClaim) != 1 || oldClaim[0].ID != fencedID {
		t.Fatalf("old Claim() = (%+v, %v)", oldClaim, err)
	}
	if _, err := database.ExecContext(ctx, `
		UPDATE rgs_outbox SET lease_until=clock_timestamp()-interval '1 second'
		WHERE id=$1`, fencedID); err != nil {
		t.Fatal(err)
	}
	newClaim, err := storeB.Claim(ctx, outbox.ClaimRequest{
		Owner: "instance-b", LeaseToken: "current-lease",
		LeaseDuration: time.Minute, Limit: 1,
	})
	if err != nil || len(newClaim) != 1 || newClaim[0].ID != fencedID {
		t.Fatalf("new Claim() = (%+v, %v)", newClaim, err)
	}
	if err := storeA.MarkPublished(ctx, outbox.Completion{
		EventID: fencedID, LeaseToken: "stale-lease",
	}); !errors.Is(err, outbox.ErrLeaseLost) {
		t.Fatalf("stale MarkPublished() error = %v", err)
	}
	if err := storeB.MarkPublished(ctx, outbox.Completion{
		EventID: fencedID, LeaseToken: "current-lease",
	}); err != nil {
		t.Fatal(err)
	}
}

func insertOutboxFixture(
	t *testing.T,
	ctx context.Context,
	database *sql.DB,
	operatorID, aggregateID string,
) int64 {
	t.Helper()
	var id int64
	if err := database.QueryRowContext(ctx, `
		INSERT INTO rgs_outbox (
			operator_id, aggregate_type, aggregate_id, event_type, payload
		) VALUES ($1, 'round', $2, 'ROUND_COMMITTED', '{}'::jsonb)
		RETURNING id`, operatorID, aggregateID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
