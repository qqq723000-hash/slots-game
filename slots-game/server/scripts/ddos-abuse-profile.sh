#!/bin/sh

set -eu

unset CDPATH
server_dir=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
repository_dir=$(cd -- "$server_dir/.." && pwd -P)

if [ -z "${RGS_DDOS_ABUSE_REQUESTS:-}" ]; then
  echo "RGS_DDOS_ABUSE_REQUESTS is required for the DDoS abuse profile" >&2
  exit 1
fi
if [ -z "${RGS_DDOS_ABUSE_CONCURRENCY:-}" ]; then
  echo "RGS_DDOS_ABUSE_CONCURRENCY is required for the DDoS abuse profile" >&2
  exit 1
fi

artifact_root="$repository_dir/.artifacts/security"
artifact_path=${RGS_DDOS_ABUSE_ARTIFACT_PATH:-"$artifact_root/ddos-abuse-report.json"}
test_name=TestRGSAPIDDoSAbuseProfile
case "$artifact_path" in
  /*) ;;
  *)
    echo "RGS_DDOS_ABUSE_ARTIFACT_PATH must be absolute" >&2
    exit 1
    ;;
esac

umask 077
mkdir -p -- "$artifact_root"
canonical_artifact_root=$(cd -- "$artifact_root" && pwd -P)
artifact_directory=$(dirname -- "$artifact_path")
canonical_artifact_directory=$(cd -- "$artifact_directory" 2>/dev/null && pwd -P) || {
  echo "RGS_DDOS_ABUSE_ARTIFACT_PATH parent directory must already exist" >&2
  exit 1
}
artifact_name=$(basename -- "$artifact_path")
if [ "$canonical_artifact_root" != "$artifact_root" ] ||
   [ "$canonical_artifact_directory" != "$canonical_artifact_root" ]; then
  echo "RGS_DDOS_ABUSE_ARTIFACT_PATH must be an immediate child of $artifact_root" >&2
  exit 1
fi
case "$artifact_name" in
  ""|"."|".."|*[!A-Za-z0-9._-]*)
    echo "RGS_DDOS_ABUSE_ARTIFACT_PATH filename contains unsupported characters" >&2
    exit 1
    ;;
esac
if [ -L "$artifact_path" ] || { [ -e "$artifact_path" ] && [ ! -f "$artifact_path" ]; }; then
  echo "RGS_DDOS_ABUSE_ARTIFACT_PATH must be absent or a regular non-symlink file" >&2
  exit 1
fi
command -v jq >/dev/null 2>&1 || {
  echo "jq is required to validate the DDoS abuse artifact" >&2
  exit 1
}
run_artifact=$(mktemp "${artifact_path}.run.XXXXXX")
rm -f -- "$run_artifact"
trap 'rm -f -- "$run_artifact"' 0 HUP INT TERM

(
  cd -- "$server_dir"
  listed=$(go test -list "^${test_name}$" ./internal/rgsapi)
  if [ "$(printf '%s\n' "$listed" | grep -c "^${test_name}$")" -ne 1 ]; then
    echo "DDoS abuse profile root test is missing or ambiguous: $test_name" >&2
    exit 1
  fi
  go test -count=1 -run '^TestDDoSTransport' ./cmd/rgs-server
  RGS_RUN_HTTP_DDOS_ABUSE=1 \
    RGS_DDOS_ABUSE_ARTIFACT_PATH="$run_artifact" \
    go test -count=1 -run "^${test_name}$" -v ./internal/rgsapi
)

if [ ! -s "$run_artifact" ]; then
  echo "DDoS abuse profile did not create a non-empty artifact for this run" >&2
  exit 1
fi
if ! jq -e \
  --argjson requests "$RGS_DDOS_ABUSE_REQUESTS" \
  --argjson concurrency "$RGS_DDOS_ABUSE_CONCURRENCY" '
  .schema == "slots-game/ddos-abuse-load/v1" and
  .gatePassed == true and
  .mode == "invariant-enforced" and
  (.scenarios | length) == 5 and
  ([.scenarios[].name] | sort) == [
    "duplicate_header_flood",
    "invalid_token_flood",
    "malformed_json_flood",
    "many_identity_spin_flood",
    "oversized_body_flood"
  ] and
  all(.scenarios[]; .requests == $requests and .concurrency == $concurrency) and
  all(.scenarios[]; .completed == .requests and .transportErrors == 0 and .unexpectedResponseCount == 0) and
  all(.scenarios[] | select(.name != "many_identity_spin_flood");
    .clientAdmissionCalls == 0 and .sharedAdmissionCalls == 0 and .protectedBackendCalls == 0) and
  (.scenarios[] | select(.name == "oversized_body_flood") | .statusCounts["413"]) == $requests and
  (.scenarios[] | select(.name == "malformed_json_flood") | .statusCounts["400"]) == $requests and
  (.scenarios[] | select(.name == "duplicate_header_flood") | .statusCounts["415"]) == $requests and
  (.scenarios[] | select(.name == "invalid_token_flood") |
    .statusCounts["401"] > 0 and .statusCounts["503"] > 0 and
    (.statusCounts["401"] + .statusCounts["503"]) == $requests and
    .cryptographicCalls == $requests and .cryptographicRejected == .statusCounts["503"] and
    .cryptographicMaxActive > 0 and .cryptographicMaxActive <= 8) and
  (.scenarios[] | select(.name == "many_identity_spin_flood") |
    .clientAdmissionCalls == $requests and .clientAdmissionKeys == $requests and
    .sharedAdmissionCalls == $requests and .sharedAdmissionKeys == 1 and
    .statusCounts["200"] > 0 and .statusCounts["429"] > 0 and
    .protectedBackendCalls == .statusCounts["200"])
' "$run_artifact" >/dev/null; then
  echo "DDoS abuse artifact failed schema or invariant validation" >&2
  exit 1
fi
mv -f -- "$run_artifact" "$artifact_path"

echo "DDoS abuse invariant profile passed; artifact: $artifact_path"
echo "This local loopback profile is not an Internet-scale, AWS WAF, Shield, TLS, HTTP/2 or bandwidth certification"
