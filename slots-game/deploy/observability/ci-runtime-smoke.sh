#!/usr/bin/env bash

# 该动态 smoke 仅供 CI：它在隔离 PostgreSQL 上运行 migrator/runtime，再探测两个监听器。
# 信任材料由入库且显式受控的 CI-only 命令临时生成，不上传，也绝不代表生产审批。
set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH='' cd -- "$script_dir/../.." && pwd)"
server_root="$repository_root/server"
temporary_root="${TMPDIR:-/tmp}"
temporary_root="${temporary_root%/}"
fixture_dir="$(mktemp -d "$temporary_root/rgs-runtime-smoke.XXXXXX")"
artifact_dir="${RGS_RUNTIME_SMOKE_ARTIFACT_DIR:-$repository_root/.artifacts/runtime-smoke}"
runtime_container=''

cleanup() {
  exit_code=$?
  if [ -n "$runtime_container" ] && docker container inspect "$runtime_container" >/dev/null 2>&1; then
    # 原始 stderr 可能包含第三方库错误文本，只留在短命目录并随 secret 一起删除，绝不上传。
    docker logs "$runtime_container" >"$fixture_dir/runtime.raw.log" 2>&1 || true
    docker rm -f "$runtime_container" >/dev/null 2>&1 || true
  fi
  case "$fixture_dir" in
    "$temporary_root"/rgs-runtime-smoke.*)
      rm -rf -- "$fixture_dir"
      ;;
    *)
      printf '%s\n' "runtime smoke: refusing to remove unexpected temporary path $fixture_dir" >&2
      ;;
  esac
  return "$exit_code"
}
trap cleanup EXIT

(cd "$server_root" && RGS_CI_RUNTIME_FIXTURE=1 RGS_CI_RUNTIME_FIXTURE_PROFILE=development \
  go run ./cmd/ci-runtime-fixture "$fixture_dir")

for required_fixture in definition.json definition-approval.json definition-approval-public.pem \
  operators.json launch-hmac.key operations.token; do
  test -s "$fixture_dir/$required_fixture" || {
    printf '%s\n' "runtime smoke: fixture generator omitted $required_fixture" >&2
    exit 1
  }
done

if [ "${RGS_RUNTIME_SMOKE_GENERATE_ONLY:-0}" = 1 ]; then
  printf '%s\n' 'runtime smoke: ephemeral development fixture generation ok'
  exit 0
fi

: "${RGS_POSTGRES_MIGRATOR_TEST_URL:?RGS_POSTGRES_MIGRATOR_TEST_URL is required}"
: "${RGS_POSTGRES_TEST_URL:?RGS_POSTGRES_TEST_URL is required}"
command -v docker >/dev/null 2>&1 || {
  printf '%s\n' 'runtime smoke: docker is required' >&2
  exit 2
}
command -v curl >/dev/null 2>&1 || {
  printf '%s\n' 'runtime smoke: curl is required' >&2
  exit 2
}
test "$(uname -s)" = Linux || {
  printf '%s\n' 'runtime smoke: Linux host networking is required' >&2
  exit 2
}

runtime_image="${RGS_RUNTIME_SMOKE_RUNTIME_IMAGE:-slots-rgs-runtime:conformance}"
migrator_image="${RGS_RUNTIME_SMOKE_MIGRATOR_IMAGE:-slots-rgs-migrator:conformance}"
mkdir -p "$artifact_dir"

# 职责隔离：migrator 容器只接收 DDL 凭据，runtime 容器只接收 DML 凭据。
docker run --rm --network host \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -e RGS_MIGRATOR_DATABASE_URL="$RGS_POSTGRES_MIGRATOR_TEST_URL" \
  -e RGS_RUNTIME_DATABASE_ROLE=rgs_runtime \
  -e RGS_MIGRATION_TIMEOUT=2m \
  "$migrator_image" up >"$artifact_dir/migrator-up.json"
docker run --rm --network host \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -e RGS_MIGRATOR_DATABASE_URL="$RGS_POSTGRES_MIGRATOR_TEST_URL" \
  -e RGS_RUNTIME_DATABASE_ROLE=rgs_runtime \
  -e RGS_MIGRATION_TIMEOUT=2m \
  "$migrator_image" verify >"$artifact_dir/migrator-verify.json"

container_name="rgs-runtime-smoke-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-0}"
runtime_container="$container_name"
docker run --detach --rm --name "$container_name" --network host \
  --user "$(id -u):$(id -g)" \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 128 --memory 256m --cpus 1 \
  --mount "type=bind,src=$fixture_dir,dst=/run/rgs-smoke,readonly" \
  -e RGS_ENVIRONMENT=development \
  -e RGS_HTTP_ADDR=127.0.0.1:18080 \
  -e RGS_OPERATIONS_HTTP_ADDR=127.0.0.1:18081 \
  -e RGS_PUBLIC_BASE_URL=http://127.0.0.1:18080 \
  -e RGS_DATABASE_URL="$RGS_POSTGRES_TEST_URL" \
  -e RGS_OPERATOR_CONFIG_FILE=/run/rgs-smoke/operators.json \
  -e RGS_DEFINITION_FILE=/run/rgs-smoke/definition.json \
  -e RGS_DEFINITION_APPROVAL_FILE=/run/rgs-smoke/definition-approval.json \
  -e RGS_DEFINITION_APPROVAL_PUBLIC_KEY_FILE=/run/rgs-smoke/definition-approval-public.pem \
  -e RGS_LAUNCH_HMAC_KEY_FILE=/run/rgs-smoke/launch-hmac.key \
  -e RGS_OPERATIONS_BEARER_TOKEN_FILE=/run/rgs-smoke/operations.token \
  "$runtime_image" >/dev/null

public_health_status='000'
for _attempt in $(seq 1 30); do
  public_health_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    http://127.0.0.1:18080/healthz || true)"
  if [ "$public_health_status" = 200 ]; then
    break
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)" != true ]; then
    printf '%s\n' 'runtime smoke: rgs-server exited before liveness succeeded' >&2
    docker logs "$container_name" >"$fixture_dir/runtime-startup-failure.raw.log" 2>&1 || true
    printf '%s\n' 'runtime smoke: raw startup log withheld from retained CI output' >&2
    exit 1
  fi
  sleep 1
done
test "$public_health_status" = 200 || {
  printf '%s\n' "runtime smoke: public /healthz returned $public_health_status" >&2
  exit 1
}

operations_token=''
IFS= read -r operations_token <"$fixture_dir/operations.token"
test -n "$operations_token"

expect_status() {
  expected=$1
  url=$2
  authorization=${3:-}
  if [ -n "$authorization" ]; then
    actual="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
      --header "Authorization: $authorization" "$url")"
  else
    actual="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$url")"
  fi
  test "$actual" = "$expected" || {
    printf '%s\n' "runtime smoke: $url returned $actual, expected $expected" >&2
    exit 1
  }
}

# 公网只保留 liveness；8081 独立验证无 token/错 token 失败闭合，正确 token 才可读。
expect_status 200 http://127.0.0.1:18080/healthz
expect_status 404 http://127.0.0.1:18080/readyz
expect_status 404 http://127.0.0.1:18080/metrics
expect_status 200 http://127.0.0.1:18081/healthz
expect_status 401 http://127.0.0.1:18081/readyz
expect_status 401 http://127.0.0.1:18081/metrics 'Bearer definitely-wrong-ci-token'
expect_status 200 http://127.0.0.1:18081/readyz "Bearer $operations_token"
expect_status 200 http://127.0.0.1:18081/metrics "Bearer $operations_token"

curl --fail --silent --show-error --header "Authorization: Bearer $operations_token" \
  http://127.0.0.1:18081/readyz >"$artifact_dir/readyz.json"
grep -F '"status":"ready"' "$artifact_dir/readyz.json" >/dev/null
curl --fail --silent --show-error --header "Authorization: Bearer $operations_token" \
  http://127.0.0.1:18081/metrics >"$artifact_dir/metrics.prom"
grep -F '# TYPE rgs_http_requests_total counter' "$artifact_dir/metrics.prom" >/dev/null
grep -F '# TYPE rgs_http_server_failures_total counter' "$artifact_dir/metrics.prom" >/dev/null
grep -F '# TYPE rgs_ready gauge' "$artifact_dir/metrics.prom" >/dev/null
grep -F -x 'rgs_ready 1' "$artifact_dir/metrics.prom" >/dev/null
grep -F '# TYPE rgs_db_pool_max_open_connections gauge' "$artifact_dir/metrics.prom" >/dev/null

runtime_image_id="$(docker image inspect --format '{{.Id}}' "$runtime_image")"
migrator_image_id="$(docker image inspect --format '{{.Id}}' "$migrator_image")"
python3 - "$artifact_dir/result.json" "$runtime_image_id" "$migrator_image_id" <<'PYEOF'
import datetime
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
result = {
    "schemaVersion": 1,
    "status": "passed",
    "environment": "development-ci-only-not-release-evidence",
    "runtimeImageId": sys.argv[2],
    "migratorImageId": sys.argv[3],
    "probes": {
        "publicHealthz": 200,
        "publicReadyz": 404,
        "publicMetrics": 404,
        "operationsHealthz": 200,
        "operationsReadyzWithoutBearer": 401,
        "operationsMetricsWrongBearer": 401,
        "operationsReadyzWithBearer": 200,
        "operationsMetricsWithBearer": 200,
    },
    "completedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
path.write_text(json.dumps(result, separators=(",", ":")) + "\n", encoding="utf-8")
PYEOF

printf '%s\n' 'runtime smoke: migrator, runtime, public and authenticated operations probes ok'
