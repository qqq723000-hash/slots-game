package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"time"

	"slots-game/server/internal/outbox"
)

const (
	outboxClaimSQL = `
WITH candidates AS (
    SELECT pending.id
    FROM rgs_outbox AS pending
    WHERE pending.published_at IS NULL
      AND pending.available_at <= clock_timestamp()
      AND (pending.lease_until IS NULL OR pending.lease_until <= clock_timestamp())
      AND pending.attempts < 2147483647
      AND NOT EXISTS (
          SELECT 1
          FROM rgs_outbox AS predecessor
          WHERE predecessor.operator_id = pending.operator_id
            AND predecessor.aggregate_type = pending.aggregate_type
            AND predecessor.aggregate_id = pending.aggregate_id
            AND predecessor.id < pending.id
            AND predecessor.published_at IS NULL
      )
    ORDER BY pending.available_at, pending.id
    FOR UPDATE SKIP LOCKED
    LIMIT $4
)
UPDATE rgs_outbox AS event
SET lease_owner = $1,
    lease_token = $2,
    lease_until = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
    attempts = event.attempts + 1
FROM candidates
WHERE event.id = candidates.id
RETURNING event.id, event.operator_id, event.aggregate_type,
          event.aggregate_id, event.event_type, event.payload,
          event.created_at, event.available_at, event.lease_until,
          event.attempts`

	outboxMarkPublishedSQL = `
UPDATE rgs_outbox
SET published_at = clock_timestamp(),
    lease_owner = NULL,
    lease_token = NULL,
    lease_until = NULL,
    last_error = NULL
WHERE id = $1 AND lease_token = $2 AND published_at IS NULL`

	outboxMarkFailedSQL = `
UPDATE rgs_outbox
SET available_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
    lease_owner = NULL,
    lease_token = NULL,
    lease_until = NULL,
    last_error = $4
WHERE id = $1 AND lease_token = $2 AND published_at IS NULL`

	outboxBacklogCheckSQL = `
SELECT NOT EXISTS (
    SELECT 1
    FROM rgs_outbox
    WHERE published_at IS NULL
      AND created_at <= clock_timestamp() - ($1::bigint * interval '1 millisecond')
)`

	maximumOutboxBatch = 1_000
)

var (
	outboxIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	outboxFailurePattern    = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,127}$`)
)

// OutboxStore 提供带围栏的 PostgreSQL 投递租约。可领取时间和到期时间统一使用数据库时钟，
// 避免副本间的微小时钟差破坏归属判断；租约被重新领取后，唯一 LeaseToken 会拒绝旧工作器的迟到确认。
// English: OutboxStore provides fenced PostgreSQL delivery leases. The retrievable time and expiration time use
// the database clock uniformly to avoid the slight clock difference between replicas from damaging the ownership
// judgment; after the lease is re-claimed, the only LeaseToken will reject the late confirmation from the old
// worker.
type OutboxStore struct {
	db *sql.DB
}

func NewOutboxStore(db *sql.DB) (*OutboxStore, error) {
	if db == nil {
		return nil, fmt.Errorf("%w: database is required", outbox.ErrInvalidInput)
	}
	return &OutboxStore{db: db}, nil
}

func (s *OutboxStore) Claim(ctx context.Context, request outbox.ClaimRequest) ([]outbox.Event, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !outboxIdentifierPattern.MatchString(request.Owner) ||
		!outboxIdentifierPattern.MatchString(request.LeaseToken) ||
		request.LeaseDuration < time.Millisecond || request.LeaseDuration > 2*time.Hour ||
		request.Limit < 1 || request.Limit > maximumOutboxBatch {
		return nil, outbox.ErrInvalidInput
	}
	rows, err := s.db.QueryContext(
		ctx, outboxClaimSQL, request.Owner, request.LeaseToken,
		durationMilliseconds(request.LeaseDuration), request.Limit,
	)
	if err != nil {
		return nil, fmt.Errorf("postgres outbox: claim: %w", err)
	}
	defer rows.Close()
	events := make([]outbox.Event, 0, request.Limit)
	for rows.Next() {
		var event outbox.Event
		if err := rows.Scan(
			&event.ID, &event.OperatorID, &event.AggregateType,
			&event.AggregateID, &event.EventType, &event.Payload,
			&event.CreatedAt, &event.AvailableAt, &event.LeaseUntil,
			&event.Attempts,
		); err != nil {
			return nil, fmt.Errorf("postgres outbox: scan claim: %w", err)
		}
		if !validClaimedEvent(event) {
			return nil, outbox.ErrInvariant
		}
		event.Payload = append(json.RawMessage(nil), event.Payload...)
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres outbox: claim rows: %w", err)
	}
	return events, nil
}

func (s *OutboxStore) MarkPublished(ctx context.Context, completion outbox.Completion) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if completion.EventID <= 0 || !outboxIdentifierPattern.MatchString(completion.LeaseToken) {
		return outbox.ErrInvalidInput
	}
	result, err := s.db.ExecContext(
		ctx, outboxMarkPublishedSQL, completion.EventID, completion.LeaseToken,
	)
	if err != nil {
		return fmt.Errorf("postgres outbox: mark published: %w", err)
	}
	return requireOutboxLease(result)
}

func (s *OutboxStore) MarkFailed(ctx context.Context, failure outbox.Failure) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if failure.EventID <= 0 || !outboxIdentifierPattern.MatchString(failure.LeaseToken) ||
		failure.RetryAfter < time.Millisecond || failure.RetryAfter > 24*time.Hour ||
		!outboxFailurePattern.MatchString(failure.Code) {
		return outbox.ErrInvalidInput
	}
	result, err := s.db.ExecContext(
		ctx, outboxMarkFailedSQL, failure.EventID, failure.LeaseToken,
		durationMilliseconds(failure.RetryAfter), failure.Code,
	)
	if err != nil {
		return fmt.Errorf("postgres outbox: mark failed: %w", err)
	}
	return requireOutboxLease(result)
}

func (s *OutboxStore) CheckBacklog(ctx context.Context, maximumAge time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if maximumAge < time.Second || maximumAge > 30*24*time.Hour {
		return outbox.ErrInvalidInput
	}
	var withinLimit bool
	if err := s.db.QueryRowContext(
		ctx, outboxBacklogCheckSQL, durationMilliseconds(maximumAge),
	).Scan(&withinLimit); err != nil {
		return fmt.Errorf("postgres outbox: check delivery backlog: %w", err)
	}
	if !withinLimit {
		return outbox.ErrDeliveryLag
	}
	return nil
}

func validClaimedEvent(event outbox.Event) bool {
	if event.ID <= 0 || event.Attempts < 1 ||
		!outboxIdentifierPattern.MatchString(event.OperatorID) ||
		!outboxIdentifierPattern.MatchString(event.AggregateType) ||
		!outboxIdentifierPattern.MatchString(event.AggregateID) ||
		!outboxIdentifierPattern.MatchString(event.EventType) ||
		event.CreatedAt.IsZero() || event.AvailableAt.IsZero() || event.LeaseUntil.IsZero() ||
		!json.Valid(event.Payload) {
		return false
	}
	var payload map[string]json.RawMessage
	return json.Unmarshal(event.Payload, &payload) == nil && payload != nil
}

func requireOutboxLease(result sql.Result) error {
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("postgres outbox: affected rows: %w", err)
	}
	if rows == 0 {
		return outbox.ErrLeaseLost
	}
	if rows != 1 {
		return outbox.ErrInvariant
	}
	return nil
}

func durationMilliseconds(duration time.Duration) int64 {
	return int64((duration + time.Millisecond - 1) / time.Millisecond)
}

var _ outbox.Store = (*OutboxStore)(nil)
var _ outbox.BacklogChecker = (*OutboxStore)(nil)
