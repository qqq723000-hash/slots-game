#!/bin/sh

set -eu

unset CDPATH
server_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)
repository_dir=$(cd -- "$server_dir/.." && pwd)

if [ -z "${RGS_POSTGRES_TEST_URL:-}" ]; then
  echo "RGS_POSTGRES_TEST_URL is required for the PostgreSQL load profile" >&2
  exit 1
fi
if [ -z "${RGS_POSTGRES_MIGRATOR_TEST_URL:-}" ]; then
  echo "RGS_POSTGRES_MIGRATOR_TEST_URL is required for the PostgreSQL load profile" >&2
  exit 1
fi
if [ "${RGS_HIGH_CONCURRENCY_ALLOW_DESTRUCTIVE_TEST_DATABASE:-}" != "YES" ]; then
  echo "Refusing destructive load profile: set RGS_HIGH_CONCURRENCY_ALLOW_DESTRUCTIVE_TEST_DATABASE=YES for an isolated test database" >&2
  exit 1
fi
if [ -z "${RGS_HIGH_CONCURRENCY_MAX_P99_MILLIS:-}" ]; then
  echo "RGS_HIGH_CONCURRENCY_MAX_P99_MILLIS is required for the PostgreSQL load gate" >&2
  exit 1
fi
if [ -z "${RGS_HIGH_CONCURRENCY_MAX_CONNECTION_WAIT_COUNT:-}" ]; then
  echo "RGS_HIGH_CONCURRENCY_MAX_CONNECTION_WAIT_COUNT is required for the PostgreSQL load gate" >&2
  exit 1
fi
if [ -z "${RGS_HIGH_CONCURRENCY_MAX_CONNECTION_WAIT_MILLIS:-}" ]; then
  echo "RGS_HIGH_CONCURRENCY_MAX_CONNECTION_WAIT_MILLIS is required for the PostgreSQL load gate" >&2
  exit 1
fi
if [ -z "${RGS_HIGH_CONCURRENCY_MAX_WAL_BYTES_PER_SUCCESS:-}" ]; then
  echo "RGS_HIGH_CONCURRENCY_MAX_WAL_BYTES_PER_SUCCESS is required for the PostgreSQL load gate" >&2
  exit 1
fi

artifact_path=${RGS_HIGH_CONCURRENCY_ARTIFACT_PATH:-"$repository_dir/.artifacts/high-concurrency/postgres-report.json"}
runtime_role=${RGS_RUNTIME_DATABASE_ROLE:-rgs_runtime}
test_name=TestPostgresHighConcurrencyProfile
case "$artifact_path" in
  /*) ;;
  *)
    echo "RGS_HIGH_CONCURRENCY_ARTIFACT_PATH must be absolute" >&2
    exit 1
    ;;
esac

umask 077
mkdir -p -- "$(dirname -- "$artifact_path")"
command -v jq >/dev/null 2>&1 || {
  echo "jq is required to validate the PostgreSQL load artifact" >&2
  exit 1
}
run_artifact=$(mktemp "${artifact_path}.run.XXXXXX")
rm -f -- "$run_artifact"
trap 'rm -f -- "$run_artifact"' 0 HUP INT TERM

(
  cd -- "$server_dir"
  RGS_MIGRATOR_DATABASE_URL="$RGS_POSTGRES_MIGRATOR_TEST_URL" \
    RGS_RUNTIME_DATABASE_ROLE="$runtime_role" \
    go run ./cmd/rgs-migrator up
)

(
  cd -- "$repository_dir"
  listed=$(cd -- "$server_dir" && go test -list "^${test_name}$" ./internal/postgres)
  if [ "$(printf '%s\n' "$listed" | grep -c "^${test_name}$")" -ne 1 ]; then
    echo "PostgreSQL load profile root test is missing or ambiguous: $test_name" >&2
    exit 1
  fi
  RGS_RUN_POSTGRES_HIGH_CONCURRENCY=1 \
    RGS_HIGH_CONCURRENCY_ARTIFACT_PATH="$run_artifact" \
    go test -count=1 -run "^${test_name}$" -v ./server/internal/postgres
)

if [ ! -s "$run_artifact" ]; then
  echo "PostgreSQL load gate did not create a non-empty artifact for this run" >&2
  exit 1
fi
if ! jq -e \
  --argjson max_p99 "$RGS_HIGH_CONCURRENCY_MAX_P99_MILLIS" \
  --argjson max_wait_count "$RGS_HIGH_CONCURRENCY_MAX_CONNECTION_WAIT_COUNT" \
  --argjson max_wait_ms "$RGS_HIGH_CONCURRENCY_MAX_CONNECTION_WAIT_MILLIS" \
  --argjson max_wal "$RGS_HIGH_CONCURRENCY_MAX_WAL_BYTES_PER_SUCCESS" '
  .schema == "slots-game/postgres-load/v1" and
  .gatePassed == true and
  .assessmentMode == "local-threshold-enforced-nonrelease" and
  .thresholds.maxP99Millis == $max_p99 and
  .thresholds.maxConnectionWaitCount == $max_wait_count and
  .thresholds.maxConnectionWaitMillis == $max_wait_ms and
  .thresholds.maxWalBytesPerSuccessfulOperation == $max_wal and
  (.scenarios | length) >= 14 and
  ([.scenarios[].name] | unique | length) == (.scenarios | length) and
  all(.scenarios[]; .attempted > 0 and .failed == 0 and .succeeded == .attempted and
    ((.errors // []) | length) == 0)
' "$run_artifact" >/dev/null; then
  echo "PostgreSQL load artifact failed schema, threshold, scenario, or functional validation" >&2
  exit 1
fi
mv -f -- "$run_artifact" "$artifact_path"

echo "PostgreSQL high-concurrency local threshold gate passed"
echo "This local profile is not an RDS or release-capacity certification; artifact: $artifact_path"
