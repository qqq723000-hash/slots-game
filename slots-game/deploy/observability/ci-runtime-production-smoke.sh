#!/usr/bin/env bash

# 该 smoke 只验证 production 配置分支能在 CI 中失败闭合并成功启动；所有审批引用、证书与
# 密钥都是短命 CI-only 材料，明确不是生产/监管证据，也绝不进入上传 artifact。
set -euo pipefail
umask 077

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH='' cd -- "$script_dir/../.." && pwd)"
server_root="$repository_root/server"
temporary_root="${TMPDIR:-/tmp}"
temporary_root="${temporary_root%/}"
fixture_root="$(mktemp -d "$temporary_root/rgs-production-smoke.XXXXXX")"
fixture_dir="$fixture_root/production"
development_fixture_dir="$fixture_root/development"
negative_fixture_dir="$fixture_root/negative-v1"
artifact_dir="${RGS_RUNTIME_SMOKE_ARTIFACT_DIR:-$repository_root/.artifacts/runtime-smoke}"
runtime_container=''
audit_sink_pid=''
postgres_data_dir=''

cleanup() {
  exit_code=$?
  if [ -n "$runtime_container" ] && docker container inspect "$runtime_container" >/dev/null 2>&1; then
    # 原始 stderr 可能包含第三方库错误文本，只留在短命目录并随 secret 一起删除，绝不上传。
    docker logs "$runtime_container" >"$fixture_root/runtime-production-ci-only.raw.log" 2>&1 || true
    docker rm -f "$runtime_container" >/dev/null 2>&1 || true
  fi
  if [ -n "$audit_sink_pid" ]; then
    kill "$audit_sink_pid" >/dev/null 2>&1 || true
    wait "$audit_sink_pid" >/dev/null 2>&1 || true
  fi
  if [ -n "${RGS_RUNTIME_SMOKE_POSTGRES_CONTAINER:-}" ] && [ -n "$postgres_data_dir" ] &&
    docker container inspect "$RGS_RUNTIME_SMOKE_POSTGRES_CONTAINER" >/dev/null 2>&1; then
    docker exec --user 0 "$RGS_RUNTIME_SMOKE_POSTGRES_CONTAINER" sh -ceu '
      data_dir=$1
      rm -f -- /tmp/rgs-ci-server.crt /tmp/rgs-ci-server.key \
        "$data_dir/rgs-ci-server.crt" "$data_dir/rgs-ci-server.key"
    ' sh "$postgres_data_dir" >/dev/null 2>&1 || true
  fi
  case "$fixture_root" in
    "$temporary_root"/rgs-production-smoke.*)
      rm -rf -- "$fixture_root"
      ;;
    *)
      printf '%s\n' "production smoke: refusing to remove unexpected temporary path $fixture_root" >&2
      ;;
  esac
  return "$exit_code"
}
trap cleanup EXIT

mkdir -p "$fixture_dir" "$development_fixture_dir"
(cd "$server_root" && RGS_CI_RUNTIME_FIXTURE=1 RGS_CI_RUNTIME_FIXTURE_PROFILE=production \
  go run ./cmd/ci-runtime-fixture "$fixture_dir")
(cd "$server_root" && RGS_CI_RUNTIME_FIXTURE=1 RGS_CI_RUNTIME_FIXTURE_PROFILE=development \
  go run ./cmd/ci-runtime-fixture "$development_fixture_dir")

command -v openssl >/dev/null 2>&1 || {
  printf '%s\n' 'production smoke: openssl is required for the ephemeral TLS fixtures' >&2
  exit 2
}

# Go 夹具使用 Ed25519 签发通用测试证书，但部分 libpq/OpenSSL 组合无法完成该证书的
# TLS 握手。数据库链改用短命 RSA-3072/SHA-256 专用 CA；仍须通过 verify-full、SAN
# 主机名校验和 pg_stat_ssl.ssl=true，不能回退为 require、verify-ca 或明文连接。
generate_postgres_tls_fixture() {
  local postgres_ca_key postgres_csr postgres_certificate_text
  local postgres_certificate_key_digest postgres_private_key_digest
  postgres_ca_key="$fixture_root/postgres-root-ca-key.pem"
  postgres_csr="$fixture_root/postgres-server.csr"

  openssl req -new -x509 -newkey rsa:3072 -nodes -sha256 -days 2 \
    -subj '/CN=RGS CI Only PostgreSQL Root CA' \
    -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -keyout "$postgres_ca_key" -out "$fixture_dir/postgres-root-ca.pem"
  openssl req -new -newkey rsa:3072 -nodes -sha256 \
    -subj '/CN=localhost' \
    -keyout "$fixture_dir/postgres-server-key.pem" -out "$postgres_csr"
  openssl x509 -req -in "$postgres_csr" \
    -CA "$fixture_dir/postgres-root-ca.pem" -CAkey "$postgres_ca_key" \
    -set_serial 2 -days 2 -sha256 \
    -extfile <(printf '%s\n' \
      '[server]' \
      'basicConstraints=critical,CA:FALSE' \
      'keyUsage=critical,digitalSignature,keyEncipherment' \
      'extendedKeyUsage=serverAuth' \
      'subjectAltName=DNS:localhost,IP:127.0.0.1') \
    -extensions server -out "$fixture_dir/postgres-server.pem"
  chmod 0600 "$postgres_ca_key" "$fixture_dir/postgres-root-ca.pem" \
    "$fixture_dir/postgres-server-key.pem" "$fixture_dir/postgres-server.pem"
  openssl verify -purpose sslserver -CAfile "$fixture_dir/postgres-root-ca.pem" \
    "$fixture_dir/postgres-server.pem"

  postgres_certificate_text="$(openssl x509 -in "$fixture_dir/postgres-server.pem" -noout -text)"
  printf '%s\n' "$postgres_certificate_text" | grep -F 'Signature Algorithm: sha256WithRSAEncryption' >/dev/null
  printf '%s\n' "$postgres_certificate_text" | grep -F 'Public Key Algorithm: rsaEncryption' >/dev/null
  printf '%s\n' "$postgres_certificate_text" | grep -F '(3072 bit)' >/dev/null
  printf '%s\n' "$postgres_certificate_text" | grep -F 'TLS Web Server Authentication' >/dev/null
  printf '%s\n' "$postgres_certificate_text" | grep -F 'DNS:localhost, IP Address:127.0.0.1' >/dev/null

  postgres_certificate_key_digest="$(
    openssl x509 -in "$fixture_dir/postgres-server.pem" -pubkey -noout |
      openssl pkey -pubin -outform DER 2>/dev/null | openssl dgst -sha256
  )"
  postgres_private_key_digest="$(
    openssl pkey -in "$fixture_dir/postgres-server-key.pem" -pubout -outform DER 2>/dev/null |
      openssl dgst -sha256
  )"
  test "$postgres_certificate_key_digest" = "$postgres_private_key_digest"
}

postgres_tls_generation_log="$fixture_root/postgres-tls-generation.raw.log"
if ! generate_postgres_tls_fixture >"$postgres_tls_generation_log" 2>&1; then
  printf '%s\n' 'production smoke: compatible PostgreSQL TLS fixture generation failed' >&2
  tail -n 10 "$postgres_tls_generation_log" >&2 || true
  exit 1
fi

for required_fixture in definition.json definition-approval.json definition-approval-public.pem \
  operators.json launch-hmac.key operations.token CI_ONLY_NOT_RELEASE_EVIDENCE ci-root-ca.pem \
  audit-server.pem audit-server-key.pem postgres-root-ca.pem postgres-server.pem \
  postgres-server-key.pem outbox-hmac.key; do
  test -s "$fixture_dir/$required_fixture" || {
    printf '%s\n' "production smoke: fixture generator omitted $required_fixture" >&2
    exit 1
  }
done
grep -F 'NOT RELEASE EVIDENCE' "$fixture_dir/CI_ONLY_NOT_RELEASE_EVIDENCE" >/dev/null
grep -F '"schema":"rgs-definition-approval-v2"' "$fixture_dir/definition-approval.json" >/dev/null
grep -F 'ci-only-not-release-evidence' "$fixture_dir/definition-approval.json" >/dev/null

if [ "${RGS_RUNTIME_SMOKE_GENERATE_ONLY:-0}" = 1 ]; then
  printf '%s\n' 'production smoke: ephemeral CI-only production-configuration fixtures ok'
  exit 0
fi

: "${RGS_POSTGRES_MIGRATOR_TEST_URL:?RGS_POSTGRES_MIGRATOR_TEST_URL is required}"
: "${RGS_POSTGRES_TEST_URL:?RGS_POSTGRES_TEST_URL is required}"
: "${RGS_RUNTIME_SMOKE_POSTGRES_CONTAINER:?RGS_RUNTIME_SMOKE_POSTGRES_CONTAINER is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"
command -v docker >/dev/null 2>&1 || {
  printf '%s\n' 'production smoke: docker is required' >&2
  exit 2
}
command -v curl >/dev/null 2>&1 || {
  printf '%s\n' 'production smoke: curl is required' >&2
  exit 2
}
command -v psql >/dev/null 2>&1 || {
  printf '%s\n' 'production smoke: psql is required for the PostgreSQL TLS barrier' >&2
  exit 2
}
test "$(uname -s)" = Linux || {
  printf '%s\n' 'production smoke: Linux host networking is required' >&2
  exit 2
}
printf '%s' "$RGS_RUNTIME_SMOKE_POSTGRES_CONTAINER" | grep -E '^[0-9a-f]{12,64}$' >/dev/null || {
  printf '%s\n' 'production smoke: invalid PostgreSQL service container ID' >&2
  exit 2
}
case "$RGS_POSTGRES_TEST_URL" in
  *sslmode=disable*) ;;
  *)
    printf '%s\n' 'production smoke: expected the isolated CI runtime DSN with sslmode=disable' >&2
    exit 2
    ;;
esac

runtime_image="${RGS_RUNTIME_SMOKE_RUNTIME_IMAGE:-slots-rgs-runtime:conformance}"
migrator_image="${RGS_RUNTIME_SMOKE_MIGRATOR_IMAGE:-slots-rgs-migrator:conformance}"
mkdir -p "$artifact_dir"

# 先确保 schema 与 runtime grants 已存在；migrator 的 DDL DSN 永不传给 runtime 容器。
docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -e RGS_MIGRATOR_DATABASE_URL="$RGS_POSTGRES_MIGRATOR_TEST_URL" \
  -e RGS_RUNTIME_DATABASE_ROLE=rgs_runtime -e RGS_MIGRATION_TIMEOUT=2m \
  "$migrator_image" up >"$artifact_dir/migrator-production-up.json"
docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -e RGS_MIGRATOR_DATABASE_URL="$RGS_POSTGRES_MIGRATOR_TEST_URL" \
  -e RGS_RUNTIME_DATABASE_ROLE=rgs_runtime -e RGS_MIGRATION_TIMEOUT=2m \
  "$migrator_image" verify >"$artifact_dir/migrator-production-verify.json"

# GitHub service PostgreSQL 默认未启 TLS。只在短命 CI service container 内安装临时证书并
# reload，随后 production runtime 必须用 verify-full 和独立 CA 文件连接。
postgres_data_dir="$(docker exec "$RGS_RUNTIME_SMOKE_POSTGRES_CONTAINER" sh -ceu 'printf %s "$PGDATA"')"
printf '%s' "$postgres_data_dir" | grep -E '^/[A-Za-z0-9._/-]+$' >/dev/null || {
  printf '%s\n' 'production smoke: unsafe PostgreSQL data directory' >&2
  exit 1
}
docker cp "$fixture_dir/postgres-server.pem" \
  "$RGS_RUNTIME_SMOKE_POSTGRES_CONTAINER:/tmp/rgs-ci-server.crt"
docker cp "$fixture_dir/postgres-server-key.pem" \
  "$RGS_RUNTIME_SMOKE_POSTGRES_CONTAINER:/tmp/rgs-ci-server.key"
docker exec --user 0 "$RGS_RUNTIME_SMOKE_POSTGRES_CONTAINER" sh -ceu '
  data_dir=$1
  cp /tmp/rgs-ci-server.crt "$data_dir/rgs-ci-server.crt"
  cp /tmp/rgs-ci-server.key "$data_dir/rgs-ci-server.key"
  chown postgres:postgres "$data_dir/rgs-ci-server.crt" "$data_dir/rgs-ci-server.key"
  chmod 0600 "$data_dir/rgs-ci-server.crt" "$data_dir/rgs-ci-server.key"
' sh "$postgres_data_dir"
docker exec --user postgres "$RGS_RUNTIME_SMOKE_POSTGRES_CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$PGUSER" --dbname "$PGDATABASE" \
  --command "ALTER SYSTEM SET ssl = 'on'" \
  --command "ALTER SYSTEM SET ssl_cert_file = '$postgres_data_dir/rgs-ci-server.crt'" \
  --command "ALTER SYSTEM SET ssl_key_file = '$postgres_data_dir/rgs-ci-server.key'" \
  --command 'SELECT pg_reload_conf()' >/dev/null

# reload 返回不代表新连接已经使用 TLS。先从 runner 以与 runtime 相同的 DML 角色、
# verify-full 和独立 CA 建立真实连接，并由 pg_stat_ssl 证明当前 backend 的 ssl=true；
# 只有该 barrier 成功后才进入负向 gates，避免把数据库尚未生效误判成配置拒绝。
runner_tls_database_url="${RGS_POSTGRES_TEST_URL/sslmode=disable/sslmode=verify-full}"
postgres_tls_probe_log="$fixture_root/postgres-tls-barrier.raw.log"
postgres_tls_ready=0
for _attempt in $(seq 1 20); do
  if PGSSLROOTCERT="$fixture_dir/postgres-root-ca.pem" \
    psql --no-psqlrc --set ON_ERROR_STOP=1 --tuples-only --no-align \
      --dbname "$runner_tls_database_url" \
      --command 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()' \
      2>"$postgres_tls_probe_log" | \
      grep -F -x 't' >/dev/null; then
    postgres_tls_ready=1
    break
  fi
  sleep 1
done
if [ "$postgres_tls_ready" != 1 ]; then
  printf '%s\n' 'production smoke: PostgreSQL verify-full TLS barrier timed out' >&2
  if [ -s "$postgres_tls_probe_log" ]; then
    # 只输出隐藏连接凭据后的最后一条错误；原始诊断随短命目录清除且不上传。
    tail -n 1 "$postgres_tls_probe_log" | \
      sed -E 's#(postgres(ql)?://)[^@[:space:]]+@#\1[credentials-redacted]@#g' >&2
  fi
  docker logs --tail 80 "$RGS_RUNTIME_SMOKE_POSTGRES_CONTAINER" >&2 || true
  exit 1
fi

production_database_url="${RGS_POSTGRES_TEST_URL/sslmode=disable/sslmode=verify-full}"
production_database_url="${production_database_url}&sslrootcert=/run/rgs-production-smoke/postgres-root-ca.pem"

production_env=(
  -e RGS_ENVIRONMENT=production
  -e RGS_HTTP_ADDR=127.0.0.1:18180
  -e RGS_OPERATIONS_HTTP_ADDR=127.0.0.1:18181
  -e RGS_PUBLIC_BASE_URL=https://127.0.0.1:18180
  -e RGS_TLS_TERMINATED_UPSTREAM=true
  -e RGS_ALLOWED_ORIGINS=https://operator.ci.invalid
  -e RGS_DATABASE_URL="$production_database_url"
  -e RGS_OPERATOR_CONFIG_FILE=/run/rgs-production-smoke/operators.json
  -e RGS_DEFINITION_FILE=/run/rgs-production-smoke/definition.json
  -e RGS_DEFINITION_APPROVAL_FILE=/run/rgs-production-smoke/definition-approval.json
  -e RGS_DEFINITION_APPROVAL_PUBLIC_KEY_FILE=/run/rgs-production-smoke/definition-approval-public.pem
  -e RGS_LAUNCH_HMAC_KEY_FILE=/run/rgs-production-smoke/launch-hmac.key
  -e RGS_OUTBOX_ENDPOINT_URL=https://127.0.0.1:18443/audit
  -e RGS_OUTBOX_HMAC_KEY_ID=ci-only-outbox
  -e RGS_OUTBOX_HMAC_KEY_FILE=/run/rgs-production-smoke/outbox-hmac.key
  -e RGS_OUTBOX_ROOT_CA_FILE=/run/rgs-production-smoke/ci-root-ca.pem
  -e RGS_OUTBOX_INTERVAL=100ms
  -e RGS_OUTBOX_PUBLISH_TIMEOUT=2s
  -e RGS_OUTBOX_WORKER_MAX_STALENESS=5s
  -e RGS_OUTBOX_BACKLOG_MAX_AGE=1m
)
runtime_security=(
  --network host --user "$(id -u):$(id -g)" --read-only --cap-drop ALL
  --security-opt no-new-privileges:true --pids-limit 128 --memory 256m --cpus 1
)

# 负向 1：production 即使绑定 loopback，也不能缺少独立 operations token 文件。
missing_token_log="$fixture_root/missing-token.log"
if docker run --rm "${runtime_security[@]}" \
  --mount "type=bind,src=$fixture_dir,dst=/run/rgs-production-smoke,readonly" \
  "${production_env[@]}" "$runtime_image" >"$missing_token_log" 2>&1; then
  printf '%s\n' 'production smoke: runtime started without operations token' >&2
  exit 1
fi
grep -F 'RGS_OPERATIONS_BEARER_TOKEN_FILE is required in production' "$missing_token_log" >/dev/null

# 负向 2：development v1/demo approval 即使被放进其余 production 配置，也必须拒绝启动。
cp -R "$fixture_dir" "$negative_fixture_dir"
cp "$development_fixture_dir/definition.json" "$negative_fixture_dir/definition.json"
cp "$development_fixture_dir/definition-approval.json" "$negative_fixture_dir/definition-approval.json"
cp "$development_fixture_dir/definition-approval-public.pem" \
  "$negative_fixture_dir/definition-approval-public.pem"
v1_log="$fixture_root/v1-approval.log"
if docker run --rm "${runtime_security[@]}" \
  --mount "type=bind,src=$negative_fixture_dir,dst=/run/rgs-production-smoke,readonly" \
  "${production_env[@]}" \
  -e RGS_OPERATIONS_BEARER_TOKEN_FILE=/run/rgs-production-smoke/operations.token \
  "$runtime_image" >"$v1_log" 2>&1; then
  printf '%s\n' 'production smoke: runtime accepted v1/demo approval' >&2
  exit 1
fi
grep -F 'production requires rgs-definition-approval-v2' "$v1_log" >/dev/null

# 本地 TLS sink 只验证 production HTTPS/CA 配置与 outbox readiness；没有事件时不会伪造审计记录。
openssl s_server -accept 18443 -cert "$fixture_dir/audit-server.pem" \
  -key "$fixture_dir/audit-server-key.pem" -quiet -www \
  >"$fixture_root/audit-sink.log" 2>&1 &
audit_sink_pid=$!
audit_status='000'
for _attempt in $(seq 1 20); do
  audit_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --cacert "$fixture_dir/ci-root-ca.pem" https://127.0.0.1:18443/health || true)"
  [ "$audit_status" = 200 ] && break
  sleep 1
done
test "$audit_status" = 200 || {
  printf '%s\n' "production smoke: local HTTPS audit sink returned $audit_status" >&2
  exit 1
}

container_name="rgs-production-smoke-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-0}"
runtime_container="$container_name"
docker run --detach --rm --name "$container_name" "${runtime_security[@]}" \
  --mount "type=bind,src=$fixture_dir,dst=/run/rgs-production-smoke,readonly" \
  "${production_env[@]}" \
  -e RGS_OPERATIONS_BEARER_TOKEN_FILE=/run/rgs-production-smoke/operations.token \
  "$runtime_image" >/dev/null

operations_health_status='000'
for _attempt in $(seq 1 30); do
  operations_health_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    http://127.0.0.1:18181/healthz || true)"
  [ "$operations_health_status" = 200 ] && break
  if [ "$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)" != true ]; then
    printf '%s\n' 'production smoke: rgs-server exited before liveness succeeded' >&2
    docker logs "$container_name" >"$fixture_root/runtime-startup-failure.raw.log" 2>&1 || true
    printf '%s\n' 'production smoke: raw startup log withheld from retained CI output' >&2
    exit 1
  fi
  sleep 1
done
test "$operations_health_status" = 200

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
    printf '%s\n' "production smoke: $url returned $actual, expected $expected" >&2
    exit 1
  }
}

expect_status 404 http://127.0.0.1:18180/healthz
expect_status 404 http://127.0.0.1:18180/readyz
expect_status 404 http://127.0.0.1:18180/metrics
expect_status 200 http://127.0.0.1:18181/healthz
expect_status 401 http://127.0.0.1:18181/readyz
expect_status 401 http://127.0.0.1:18181/metrics 'Bearer definitely-wrong-ci-token'

operations_ready_status='000'
for _attempt in $(seq 1 30); do
  operations_ready_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --header "Authorization: Bearer $operations_token" http://127.0.0.1:18181/readyz || true)"
  [ "$operations_ready_status" = 200 ] && break
  sleep 1
done
test "$operations_ready_status" = 200 || {
  printf '%s\n' "production smoke: authenticated /readyz returned $operations_ready_status" >&2
  exit 1
}
expect_status 200 http://127.0.0.1:18181/metrics "Bearer $operations_token"

curl --fail --silent --show-error --header "Authorization: Bearer $operations_token" \
  http://127.0.0.1:18181/readyz >"$artifact_dir/readyz-production-ci-only.json"
grep -F '"status":"ready"' "$artifact_dir/readyz-production-ci-only.json" >/dev/null
grep -F '"name":"outbox_delivery","ok":true' "$artifact_dir/readyz-production-ci-only.json" >/dev/null
curl --fail --silent --show-error --header "Authorization: Bearer $operations_token" \
  http://127.0.0.1:18181/metrics >"$artifact_dir/metrics-production-ci-only.prom"
grep -F '# TYPE rgs_ready gauge' "$artifact_dir/metrics-production-ci-only.prom" >/dev/null
grep -F -x 'rgs_ready 1' "$artifact_dir/metrics-production-ci-only.prom" >/dev/null
grep -F '# TYPE rgs_outbox_claimed_total counter' "$artifact_dir/metrics-production-ci-only.prom" >/dev/null

runtime_image_id="$(docker image inspect --format '{{.Id}}' "$runtime_image")"
python3 - "$artifact_dir/result-production-ci-only.json" "$runtime_image_id" <<'PYEOF'
import datetime
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
result = {
    "schemaVersion": 1,
    "status": "passed",
    "environment": "production-config-ci-only-not-release-evidence",
    "runtimeImageId": sys.argv[2],
    "checks": {
        "definitionApprovalV2CIOnly": True,
        "missingOperationsTokenRejected": True,
        "developmentApprovalRejected": True,
        "databaseTLSVerifyFull": True,
        "localHTTPSAuditSinkConfigured": True,
        "outboxReadiness": True,
        "rgsReady": 1,
    },
    "completedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
path.write_text(json.dumps(result, separators=(",", ":")) + "\n", encoding="utf-8")
PYEOF

printf '%s\n' 'production smoke: CI-only v2 startup, TLS DB, outbox readiness and negative gates ok'
