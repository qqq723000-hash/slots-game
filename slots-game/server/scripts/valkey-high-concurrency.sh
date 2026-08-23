#!/bin/sh

set -eu

unset CDPATH
server_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)
repository_dir=$(cd -- "$server_dir/.." && pwd)

if [ -z "${RGS_SHARED_ADMISSION_LOAD_ADDR:-}" ]; then
  echo "RGS_SHARED_ADMISSION_LOAD_ADDR is required for the Valkey load gate" >&2
  exit 1
fi
if [ -z "${RGS_SHARED_ADMISSION_LOAD_REQUESTS:-}" ]; then
  echo "RGS_SHARED_ADMISSION_LOAD_REQUESTS is required for the Valkey load gate" >&2
  exit 1
fi
if [ "${RGS_SHARED_ADMISSION_LOAD_ALLOW_DESTRUCTIVE:-}" != "YES" ]; then
  echo "RGS_SHARED_ADMISSION_LOAD_ALLOW_DESTRUCTIVE=YES is required for the isolated destructive Valkey load gate" >&2
  exit 1
fi
if ! printf '%s\n' "${RGS_SHARED_ADMISSION_LOAD_EXPECTED_RUN_ID:-}" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "RGS_SHARED_ADMISSION_LOAD_EXPECTED_RUN_ID must be the disposable Valkey server run_id" >&2
  exit 1
fi
if [ -z "${RGS_SHARED_ADMISSION_LOAD_THRESHOLDS_JSON:-}" ]; then
  echo "RGS_SHARED_ADMISSION_LOAD_THRESHOLDS_JSON is required for the Valkey load gate" >&2
  exit 1
fi

artifact_path=${RGS_SHARED_ADMISSION_LOAD_REPORT_PATH:-"$repository_dir/.artifacts/high-concurrency/valkey-report.json"}
test_name=TestSharedAdmissionLoadProfile
case "$artifact_path" in
  /*) ;;
  *)
    echo "RGS_SHARED_ADMISSION_LOAD_REPORT_PATH must be absolute" >&2
    exit 1
    ;;
esac

umask 077
mkdir -p -- "$(dirname -- "$artifact_path")"
command -v jq >/dev/null 2>&1 || {
  echo "jq is required to validate the Valkey load artifact" >&2
  exit 1
}
run_artifact=$(mktemp "${artifact_path}.run.XXXXXX")
rm -f -- "$run_artifact"
trap 'rm -f -- "$run_artifact"' 0 HUP INT TERM

(
  cd -- "$server_dir"
  listed=$(go test -list "^${test_name}$" ./internal/sharedadmission)
  if [ "$(printf '%s\n' "$listed" | grep -c "^${test_name}$")" -ne 1 ]; then
    echo "Valkey load gate root test is missing or ambiguous: $test_name" >&2
    exit 1
  fi
  RGS_SHARED_ADMISSION_LOAD_REPORT_PATH="$run_artifact" \
    go test -count=1 -run "^${test_name}$" -v ./internal/sharedadmission
)

if [ ! -s "$run_artifact" ]; then
  echo "Valkey load gate did not create a non-empty artifact for this run" >&2
  exit 1
fi
if ! jq -e --argjson requests "$RGS_SHARED_ADMISSION_LOAD_REQUESTS" '
  .schema == "slots-game/shared-admission-load/v1" and
  .gatePassed == true and
  .requestsPerVariantScenario == $requests and
  .totalRequests == ($requests * 12) and
  (.thresholds | length) == 6 and
  (.results | length) == 12 and
  all(.results[]; .requests == $requests and .errors == 0)
' "$run_artifact" >/dev/null; then
  echo "Valkey load artifact failed schema, threshold, count, or error validation" >&2
  exit 1
fi
mv -f -- "$run_artifact" "$artifact_path"

echo "Valkey high-concurrency local threshold gate passed; artifact: $artifact_path"
echo "This profile excludes TLS, ElastiCache and a real Multi-AZ failover; it is not a production capacity certification"
