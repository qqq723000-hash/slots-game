#!/bin/sh

set -eu

unset CDPATH
server_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)
repository_dir=$(cd -- "$server_dir/.." && pwd)

if [ -z "${RGS_POSTGRES_TEST_URL:-}" ]; then
  echo "RGS_POSTGRES_TEST_URL is required for the PostgreSQL conformance gate" >&2
  exit 1
fi
if [ -z "${RGS_POSTGRES_MIGRATOR_TEST_URL:-}" ]; then
  echo "RGS_POSTGRES_MIGRATOR_TEST_URL is required for the PostgreSQL conformance gate" >&2
  exit 1
fi

artifact_dir=${RGS_CONFORMANCE_ARTIFACT_DIR:-"$repository_dir/.artifacts/postgres-conformance"}
evidence_file="$artifact_dir/postgres-conformance.jsonl"
migration_evidence_file="$artifact_dir/postgres-migration.jsonl"
test_pattern='^(TestPostgresProductionRoundAndCredentialConcurrency|TestPostgresFeatureRoundInputStateRecovery|TestPostgresOutboxConcurrentClaimsOrderingAndFencing|TestPostgresConcurrentSessionIntegrityQuarantinePreservesEconomicEvidence)$'

umask 077
mkdir -p -- "$artifact_dir"

run_migrator() {
  (
    cd -- "$server_dir"
    RGS_MIGRATOR_DATABASE_URL="$RGS_POSTGRES_MIGRATOR_TEST_URL" \
      RGS_RUNTIME_DATABASE_ROLE=rgs_runtime \
      go run ./cmd/rgs-migrator "$1"
  )
}

: >"$migration_evidence_file"
run_migrator up >>"$migration_evidence_file"
run_migrator up >>"$migration_evidence_file" &
first_migrator_pid=$!
run_migrator up >>"$migration_evidence_file" &
second_migrator_pid=$!
concurrent_status=0
wait "$first_migrator_pid" || concurrent_status=1
wait "$second_migrator_pid" || concurrent_status=1
if [ "$concurrent_status" -ne 0 ]; then
  echo "Concurrent PostgreSQL migration gate failed" >&2
  exit 1
fi
run_migrator verify >>"$migration_evidence_file"

test_status=0
if (
  cd -- "$server_dir"
  RGS_REQUIRE_POSTGRES_TESTS=1 go test -json -count=1 -run "$test_pattern" ./internal/postgres
) >"$evidence_file"; then
  test_status=0
else
  test_status=$?
fi

validation_status=0
if (
  cd -- "$server_dir"
  go run ./scripts/verify-postgres-conformance.go "$evidence_file"
); then
  validation_status=0
else
  validation_status=$?
fi

if [ "$test_status" -ne 0 ] || [ "$validation_status" -ne 0 ]; then
  echo "PostgreSQL conformance gate failed; evidence: $evidence_file" >&2
  exit 1
fi

echo "PostgreSQL conformance gate passed; evidence: $evidence_file"
