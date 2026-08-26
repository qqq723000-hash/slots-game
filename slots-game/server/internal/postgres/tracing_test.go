package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"slots-game/server/internal/rgs"
	"slots-game/server/internal/telemetry"
)

func TestCriticalPostgresBoundariesAreChildrenWithOnlyFixedDatabaseAttributes(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	repository, err := NewRepository(database)
	if err != nil {
		t.Fatal(err)
	}
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
		sdktrace.WithSpanProcessor(recorder),
	)
	defer provider.Shutdown(context.Background())
	runtime := telemetry.NewWithProvider(provider)
	ctx, root := telemetry.Start(runtime.Context(context.Background()), "test.coordinator")

	_, _, _ = repository.PrepareRound(ctx, rgs.SpinRequest{}, "private-fingerprint", rgs.Profile{}, nil)
	_, _, _ = repository.ClaimWallet(ctx, rgs.RoundKey{}, 0)
	mock.ExpectBegin().WillReturnError(errors.New("dsn-and-player-private"))
	_, _, _ = repository.CommitClaim(ctx, rgs.WalletRecoveryClaim{}, rgs.WalletReceipt{})
	root.End()
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}

	spans := recorder.Ended()
	byName := make(map[string]sdktrace.ReadOnlySpan, len(spans))
	for _, span := range spans {
		byName[span.Name()] = span
	}
	rootSpan := byName["test.coordinator"]
	for name, operation := range map[string]string{
		"postgres.transaction.prepare_round": "prepare_round",
		"postgres.transaction.claim_wallet":  "claim_wallet",
		"postgres.transaction.commit_claim":  "commit_claim",
	} {
		span, ok := byName[name]
		if !ok {
			t.Fatalf("missing span %q: %#v", name, byName)
		}
		if span.Parent().SpanID() != rootSpan.SpanContext().SpanID() {
			t.Fatalf("span %q parent = %v, want %v", name, span.Parent(), rootSpan.SpanContext())
		}
		if len(span.Attributes()) != 2 ||
			string(span.Attributes()[0].Key) != "db.system.name" || span.Attributes()[0].Value.AsString() != "postgresql" ||
			string(span.Attributes()[1].Key) != "db.operation.name" || span.Attributes()[1].Value.AsString() != operation {
			t.Fatalf("span %q attributes = %#v", name, span.Attributes())
		}
		if span.Status().Description != "" {
			t.Fatalf("span %q exported error description %q", name, span.Status().Description)
		}
	}
}
