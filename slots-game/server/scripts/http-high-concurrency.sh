#!/bin/sh

set -eu

unset CDPATH
server_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)
repository_dir=$(cd -- "$server_dir/.." && pwd)

if [ -z "${RGS_HTTP_LOAD_MIN_OPS_PER_SECOND:-}" ]; then
  echo "RGS_HTTP_LOAD_MIN_OPS_PER_SECOND is required for the HTTP load gate" >&2
  exit 1
fi
if [ -z "${RGS_HTTP_LOAD_MAX_P99_MS:-}" ]; then
  echo "RGS_HTTP_LOAD_MAX_P99_MS is required for the HTTP load gate" >&2
  exit 1
fi
if [ -z "${RGS_HTTP_LOAD_REQUESTS:-}" ]; then
  echo "RGS_HTTP_LOAD_REQUESTS is required for the HTTP load gate" >&2
  exit 1
fi

artifact_path=${RGS_HTTP_LOAD_ARTIFACT_PATH:-"$repository_dir/.artifacts/high-concurrency/http-report.json"}
test_name=TestRGSAPIHighConcurrencyProfile
case "$artifact_path" in
  /*) ;;
  *)
    echo "RGS_HTTP_LOAD_ARTIFACT_PATH must be absolute" >&2
    exit 1
    ;;
esac

umask 077
mkdir -p -- "$(dirname -- "$artifact_path")"
command -v jq >/dev/null 2>&1 || {
  echo "jq is required to validate the HTTP load artifact" >&2
  exit 1
}
run_artifact=$(mktemp "${artifact_path}.run.XXXXXX")
rm -f -- "$run_artifact"
trap 'rm -f -- "$run_artifact"' 0 HUP INT TERM

(
  cd -- "$server_dir"
  listed=$(go test -list "^${test_name}$" ./internal/rgsapi)
  if [ "$(printf '%s\n' "$listed" | grep -c "^${test_name}$")" -ne 1 ]; then
    echo "HTTP load gate root test is missing or ambiguous: $test_name" >&2
    exit 1
  fi
  RGS_RUN_HTTP_HIGH_CONCURRENCY=1 \
    RGS_HTTP_LOAD_ARTIFACT_PATH="$run_artifact" \
    go test -count=1 -run "^${test_name}$" -v ./internal/rgsapi
)

if [ ! -s "$run_artifact" ]; then
  echo "HTTP load gate did not create a non-empty artifact for this run" >&2
  exit 1
fi
if ! jq -e \
  --argjson requests "$RGS_HTTP_LOAD_REQUESTS" \
  --argjson minimum "$RGS_HTTP_LOAD_MIN_OPS_PER_SECOND" \
  --argjson maximum "$RGS_HTTP_LOAD_MAX_P99_MS" '
  .schema == "slots-game/http-load/v1" and
  .gatePassed == true and
  .mode == "local-threshold-enforced" and
  .thresholds.minimumOperationsPerSecond == $minimum and
  .thresholds.maximumP99Milliseconds == $maximum and
  (.scenarios | length) == 3 and
  ([.scenarios[].name] | sort) == ["capacity_shed", "steady", "step"] and
  all(.scenarios[]; .failed == 0) and
  all(.scenarios[] | select(.name == "steady" or .name == "step");
    .requests == $requests and .succeeded == $requests and .capacityUnavailable == 0) and
  all(.scenarios[] | select(.name == "capacity_shed");
    .requests == ($requests / 2 | floor) and .succeeded > 0 and .capacityUnavailable > 0 and
    (.succeeded + .capacityUnavailable) == .requests)
' "$run_artifact" >/dev/null; then
  echo "HTTP load artifact failed schema, threshold, count, or functional validation" >&2
  exit 1
fi
mv -f -- "$run_artifact" "$artifact_path"

echo "HTTP high-concurrency local threshold gate passed; artifact: $artifact_path"
echo "This loopback profile excludes PostgreSQL, Valkey, wallet RTT, TLS, ingress and HPA; it is not a production capacity certification"
