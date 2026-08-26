#!/bin/sh
# shellcheck disable=SC1003,SC2016

# 该门禁不依赖 Docker daemon，并刻意使用精确匹配：可变镜像/Action 引用或联网构建
# 必须在镜像创建前失败，避免“本机缓存恰好安全”掩盖发布输入漂移。上述 ShellCheck
# 规则只因本文件刻意匹配字面量 `$` 与行尾反斜杠而关闭，不允许执行这些匹配文本。
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_dir/.." && pwd)
workspace_root=$(CDPATH='' cd -- "$repository_root/.." && pwd)

if [ -d "$repository_root/.github/workflows" ]; then
  workflows_root="$repository_root/.github/workflows"
else
  workflows_root="$workspace_root/.github/workflows"
fi

server_dockerfile="$repository_root/deploy/Dockerfile"
web_dockerfile="$repository_root/deploy/web/Dockerfile"
nginx_openssl_patch_verifier="$repository_root/deploy/supply-chain/verify-nginx-openssl-patch.sh"
web_release_renderer="$repository_root/deploy/web/render-release-nginx.mjs"
web_release_renderer_test="$repository_root/deploy/web/render-release-nginx.test.mjs"
web_package_json="$repository_root/web/package.json"
compose_file="$repository_root/deploy/docker-compose.postgres.yml"
env_example="$repository_root/deploy/env.example"
makefile="$repository_root/Makefile"
backend_workflow="$workflows_root/backend-conformance.yml"
frontend_workflow="$workflows_root/frontend-conformance.yml"
deployment_workflow="$workflows_root/deployment-conformance.yml"
observability_contract="$repository_root/deploy/observability/verify-static-contract.sh"
observability_release_workflow="$repository_root/deploy/observability/verify-release-workflow.sh"
vector_bounded_flush_test="$repository_root/deploy/observability/test-vector-bounded-flush.sh"
observability_compose="$repository_root/deploy/observability/compose.yml"
observability_prometheus="$repository_root/deploy/observability/prometheus.yml"
runtime_smoke="$repository_root/deploy/observability/ci-runtime-smoke.sh"
runtime_production_smoke="$repository_root/deploy/observability/ci-runtime-production-smoke.sh"
runtime_fixture_command="$repository_root/server/cmd/ci-runtime-fixture/main.go"
backend_notice_generator="$repository_root/server/scripts/third-party-notices/main.go"
backend_notice_test="$repository_root/server/scripts/third-party-notices/main_test.go"
backend_notice_policy="$repository_root/server/third-party-licenses/policy.json"
backend_notice="$repository_root/server/THIRD_PARTY_NOTICES.txt"

fail() {
  printf '%s\n' "supply-chain contract: $*" >&2
  exit 1
}

require_file() {
  test -f "$1" || fail "missing ${1#"$repository_root/"}"
}

require_line() {
  expected=$1
  file=$2
  grep -F -x -- "$expected" "$file" >/dev/null || fail "missing exact line '$expected' in ${file#"$repository_root/"}"
}

require_fixed() {
  expected=$1
  file=$2
  grep -F -- "$expected" "$file" >/dev/null || fail "missing '$expected' in ${file#"$repository_root/"}"
}

require_regex() {
  expression=$1
  file=$2
  grep -E -- "$expression" "$file" >/dev/null || fail "missing /$expression/ in ${file#"$repository_root/"}"
}

for required_file in \
  "$server_dockerfile" \
  "$web_dockerfile" \
  "$nginx_openssl_patch_verifier" \
  "$web_release_renderer" \
  "$web_release_renderer_test" \
  "$web_package_json" \
  "$compose_file" \
  "$env_example" \
  "$makefile" \
  "$backend_workflow" \
  "$frontend_workflow" \
  "$deployment_workflow" \
  "$observability_contract" \
  "$observability_release_workflow" \
  "$vector_bounded_flush_test" \
  "$observability_compose" \
  "$observability_prometheus" \
  "$runtime_smoke" \
  "$runtime_production_smoke" \
  "$runtime_fixture_command" \
  "$backend_notice_generator" \
  "$backend_notice_test" \
  "$backend_notice_policy" \
  "$backend_notice"
do
  require_file "$required_file"
done

test -x "$nginx_openssl_patch_verifier" || fail 'Nginx OpenSSL patch verifier must be executable'
"$nginx_openssl_patch_verifier" web "$web_dockerfile" >/dev/null \
  || fail 'Nginx OpenSSL patch contract failed'

require_line 'ARG GO_IMAGE=golang:1.26.6-bookworm@sha256:116d58cbd88c1297624acc6e967a060012422bacf9930927e23fb719189c6f36' "$server_dockerfile"
require_line 'ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian12:nonroot@sha256:1b7b9f0f0e0a1d2155f531db587cc48ec26aaf97ab64364225f5bf18a054e66a' "$server_dockerfile"
require_line '# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e' "$server_dockerfile"
network_none_line=$(printf '%s\134' '    --network=none ')
require_line "$network_none_line" "$server_dockerfile"
require_regex '^    CGO_ENABLED=0 GOOS=linux go build ' "$server_dockerfile"
require_line 'EXPOSE 8080 8081' "$server_dockerfile"
require_line '    go run ./scripts/third-party-notices --check && \' "$server_dockerfile"
backend_notice_copy='COPY --from=build --chown=nonroot:nonroot /src/server/THIRD_PARTY_NOTICES.txt /THIRD_PARTY_NOTICES.txt'
test "$(grep -F -x -c "$backend_notice_copy" "$server_dockerfile" || true)" -eq 2 ||
  fail 'runtime and migrator must each deliver the authoritative Go third-party notice'
require_fixed 'var productionTargets = []string{"./cmd/rgs-server", "./cmd/rgs-migrator"}' "$backend_notice_generator"
require_fixed 'TestCollectProductionModulesExcludesTestOnlyDependencies' "$backend_notice_test"
require_fixed '"name": "NOTICE"' "$backend_notice_policy"
require_fixed '生产第三方模块数量：27' "$backend_notice"
if grep -F 'github.com/DATA-DOG/go-sqlmock' "$backend_notice" >/dev/null; then
  fail 'test-only Go dependency leaked into production third-party notice'
fi

require_regex '^ARG NODE_IMAGE=[^[:space:]]+@sha256:[0-9a-f]{64}$' "$web_dockerfile"
require_regex '^ARG NGINX_IMAGE=[^[:space:]]+@sha256:[0-9a-f]{64}$' "$web_dockerfile"
require_line 'ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.4-alpine3.24-slim@sha256:bcf91d2c73ab64fa1c4ac7fbac5ac523057c8af7d553ab9251c7aef38c260979' "$web_dockerfile"
require_line 'FROM scratch AS openssl-patches' "$web_dockerfile"
require_line 'ADD --checksum=sha256:161223a16f042b8e469e9441291e071464fd91d4f4bbe6f496ee8d0abd4e0701 https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/libcrypto3-3.5.8-r0.apk /x86_64/libcrypto3.apk' "$web_dockerfile"
require_line 'ADD --checksum=sha256:aca521e5ae4a321322a9d47ed64a1775f5ab1ffd215d1e9fc0433c58f7bfd037 https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/libssl3-3.5.8-r0.apk /x86_64/libssl3.apk' "$web_dockerfile"
require_line 'ADD --checksum=sha256:35b892813c23664a3592e4fc8c12a03538a22c579057655361c7043305272a9a https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/libcrypto3-3.5.8-r0.apk /aarch64/libcrypto3.apk' "$web_dockerfile"
require_line 'ADD --checksum=sha256:d6ec970cc10e01539e41626f720c4e0ac69016eaa2079a10ef776ffd3243db5b https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/libssl3-3.5.8-r0.apk /aarch64/libssl3.apk' "$web_dockerfile"
test "$(grep -F -c -- '--mount=type=bind,from=openssl-patches,source=/,target=/patches,readonly' "$web_dockerfile")" -eq 3 ||
  fail 'all Nginx targets must use the digest-bound OpenSSL patch mount'
test "$(grep -F -c -- 'apk add --no-network --no-cache --repositories-file /dev/null "/patches/$openssl_patch_arch/libcrypto3.apk" "/patches/$openssl_patch_arch/libssl3.apk"' "$web_dockerfile")" -eq 3 ||
  fail 'all Nginx targets must install the offline OpenSSL patch pair'
test "$(grep -F -c -- 'case "$openssl_patch_arch" in x86_64|aarch64) ;; *) exit 1 ;; esac' "$web_dockerfile")" -eq 3 ||
  fail 'all Nginx targets must reject unreviewed patch architectures'
test "$(grep -F -c -- "apk info -e 'libcrypto3=3.5.8-r0'" "$web_dockerfile")" -eq 3 ||
  fail 'all Nginx targets must prove fixed libcrypto3'
test "$(grep -F -c -- "apk info -e 'libssl3=3.5.8-r0'" "$web_dockerfile")" -eq 3 ||
  fail 'all Nginx targets must prove fixed libssl3'
require_line '# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e' "$web_dockerfile"
# Docker ARG 在这里按 Dockerfile 字面量校验，不能让当前 shell 展开。
# shellcheck disable=SC2016
require_line 'FROM ${NODE_IMAGE} AS dependencies' "$web_dockerfile"
test "$(grep -F -x -c -- '    npm ci --ignore-scripts' "$web_dockerfile" || true)" -eq 1 ||
  fail 'Web dependency installation must disable npm lifecycle scripts exactly once'
require_line 'FROM dependencies AS static-conformance-build' "$web_dockerfile"
require_line 'FROM dependencies AS release-config-build' "$web_dockerfile"
require_line 'FROM release-config-build AS release-build' "$web_dockerfile"
require_line 'ARG VITE_RGS_BASE_URL' "$web_dockerfile"
require_line 'ARG VITE_RGS_BET_OPTIONS_MINOR' "$web_dockerfile"
require_line 'ARG VITE_RGS_DEFAULT_BET_MINOR' "$web_dockerfile"
require_line 'ARG VITE_RGS_HOST_ORIGIN' "$web_dockerfile"
require_fixed 'ARG WEB_RELEASE_VERSION' "$web_dockerfile"
require_fixed 'ARG WEB_RELEASE_REVISION' "$web_dockerfile"
release_network_none_line=$(printf '%s\134' 'RUN --network=none ')
require_line "$release_network_none_line" "$web_dockerfile"
require_fixed '--mount=type=secret,id=release_asset_approval,required=true,target=/run/secrets/release_asset_approval' "$web_dockerfile"
require_fixed 'node ./src/validateReleaseRgsBuildConfig.mjs &&' "$web_dockerfile"
require_line 'COPY deploy/web/nginx.conf deploy/web/content-security-policy.mjs deploy/web/render-release-nginx.mjs /src/release-web/' "$web_dockerfile"
require_fixed 'node /src/release-web/render-release-nginx.mjs \' "$web_dockerfile"
require_fixed '--rgs-base-url "$VITE_RGS_BASE_URL" \' "$web_dockerfile"
require_fixed '--host-origin "$VITE_RGS_HOST_ORIGIN" && \' "$web_dockerfile"
test "$(grep -F -c -- 'npm --ignore-scripts run build' "$web_dockerfile" || true)" -eq 2 ||
  fail 'both Web build stages must disable npm pre/post lifecycle scripts'
test "$(grep -F -c -- 'node ./scripts/generate-third-party-notices.mjs --check' "$web_dockerfile" || true)" -eq 2 ||
  fail 'both Web build stages must retain the explicit license check'
test "$(grep -F -c -- 'node ./scripts/verify-asset-provenance.mjs' "$web_dockerfile" || true)" -eq 2 ||
  fail 'both Web build stages must retain the explicit asset provenance check'
test "$(grep -F -c -- 'node ./scripts/finalize-production-assets.mjs --check' "$web_dockerfile" || true)" -eq 3 ||
  fail 'Web builds and approval must each verify the complete dist tree'
test "$(grep -F -c -- 'node ./scripts/verify-production-javascript-bundles.mjs' "$web_dockerfile" || true)" -eq 2 ||
  fail 'both Web builds must re-verify JavaScript after npm returns'
require_fixed 'RELEASE_ASSET_APPROVAL_FILE=/run/secrets/release_asset_approval \' "$web_dockerfile"
require_fixed 'node ./scripts/verify-release-asset-approval.mjs' "$web_dockerfile"
# 配置正向门禁只能继承未接触审批 secret 的 release-config-build，且最终产物不得包含 dist。
# shellcheck disable=SC2016
require_line 'FROM ${NGINX_IMAGE} AS config-conformance-nginx' "$web_dockerfile"
require_line 'COPY --from=release-config-build --chown=101:101 /src/web/release-nginx.conf /etc/nginx/conf.d/default.conf' "$web_dockerfile"
require_line 'FROM scratch AS config-conformance' "$web_dockerfile"
require_fixed 'CI_ONLY_NOT_RELEASE_EVIDENCE' "$web_dockerfile"
require_line 'COPY --from=config-conformance-nginx /etc/nginx/conf.d/default.conf /ci-only-not-release-evidence/release-nginx.conf' "$web_dockerfile"
release_config_stage=$(awk '
  /^FROM[[:space:]].*[[:space:]]AS[[:space:]]release-config-build$/ { capture = 1 }
  capture && /^FROM[[:space:]]+/ && $NF != "release-config-build" { capture = 0 }
  capture { print }
' "$web_dockerfile")
release_approval_stage=$(awk '
  /^FROM[[:space:]].*[[:space:]]AS[[:space:]]release-build$/ { capture = 1 }
  capture && /^FROM[[:space:]]+/ && $NF != "release-build" { capture = 0 }
  capture { print }
' "$web_dockerfile")
config_conformance_stage=$(awk '
  /^FROM[[:space:]].*[[:space:]]AS[[:space:]]config-conformance$/ { capture = 1 }
  capture && /^FROM[[:space:]]+/ && $NF != "config-conformance" { capture = 0 }
  capture { print }
' "$web_dockerfile")
if printf '%s\n' "$release_config_stage" | grep -F 'release_asset_approval' >/dev/null; then
  fail 'release-config-build must not consume or fabricate the external approval secret'
fi
printf '%s\n' "$release_approval_stage" | grep -F 'verify-release-asset-approval.mjs' >/dev/null \
  || fail 'release-build must retain the real external approval gate'
printf '%s\n' "$release_approval_stage" | grep -F 'finalize-production-assets.mjs --check' >/dev/null \
  || fail 'release-build must re-verify the complete dist tree before approval'
if printf '%s\n' "$config_conformance_stage" | grep -Ei '/usr/share/nginx/html|release_asset_approval|COPY.*dist' >/dev/null; then
  fail 'config-conformance must contain neither release content nor approval material'
fi
# shellcheck disable=SC2016
require_line 'FROM ${NGINX_IMAGE} AS static-conformance' "$web_dockerfile"
require_line 'COPY --from=static-conformance-build --chown=0:0 /src/web/dist/ /usr/share/nginx/html/' "$web_dockerfile"
# shellcheck disable=SC2016
require_line 'FROM ${NGINX_IMAGE} AS runtime' "$web_dockerfile"
require_line 'COPY --from=release-build --chown=0:0 /src/web/release-nginx.conf /etc/nginx/conf.d/default.conf' "$web_dockerfile"
require_line 'COPY --from=release-build --chown=0:0 /src/web/dist/ /usr/share/nginx/html/' "$web_dockerfile"
require_line 'RUN --network=none nginx -t' "$web_dockerfile"
require_line 'LABEL org.opencontainers.image.title="primal-rampage-web" \' "$web_dockerfile"
last_web_stage=$(awk '/^FROM[[:space:]]+/ { stage = $NF } END { print stage }' "$web_dockerfile")
test "$last_web_stage" = runtime || fail 'web runtime must remain the default final Docker target'
require_line '    "build:release": "npm run build && node scripts/verify-release-asset-approval.mjs",' "$web_package_json"
require_line 'verify-supply-chain-contract: verify-hardening-checklist verify-hardening-stability-contract' "$makefile"
require_regex '^[[:space:]]+node --test deploy/supply-chain/verify-release-version\.test\.mjs$' "$makefile"
require_regex '^[[:space:]]+node deploy/supply-chain/verify-release-version\.mjs$' "$makefile"
require_line 'verify-hardening-checklist:' "$makefile"
require_regex '^[[:space:]]+node --test scripts/verify-hardening-checklist\.test\.mjs$' "$makefile"
require_regex '^[[:space:]]+node scripts/verify-hardening-checklist\.mjs$' "$makefile"
require_regex '^[[:space:]]+sh \./deploy/verify-supply-chain-contract\.sh$' "$makefile"
require_line 'verify-backend-licenses:' "$makefile"
require_regex '^[[:space:]]+cd server && go run \./scripts/third-party-notices --check$' "$makefile"
require_regex '^[[:space:]]+cd server && go test \./scripts/third-party-notices$' "$makefile"
require_line 'verify-backend: verify-supply-chain-contract verify-backend-licenses' "$makefile"
require_line 'verify-observability-contract:' "$makefile"
require_regex '^[[:space:]]+\./deploy/observability/verify-static-contract\.sh$' "$makefile"
require_line 'verify-observability-release:' "$makefile"
# Makefile 中的转义环境变量是待执行文本，不能让本脚本提前展开。
# shellcheck disable=SC2016
require_fixed '--rendered-dir "$${OBSERVABILITY_RENDERED_DIR}"' "$makefile"
require_regex '^[[:space:]]+\$\(MAKE\) verify-observability-contract$' "$makefile"
require_line 'test-vector-bounded-flush:' "$makefile"
require_regex '^[[:space:]]+@\./deploy/observability/test-vector-bounded-flush\.sh$' "$makefile"
require_line 'smoke-runtime-operations: verify-supply-chain-contract' "$makefile"
require_regex '^[[:space:]]+\./deploy/observability/ci-runtime-smoke\.sh$' "$makefile"
require_line 'smoke-runtime-production: verify-supply-chain-contract' "$makefile"
require_regex '^[[:space:]]+\./deploy/observability/ci-runtime-production-smoke\.sh$' "$makefile"
require_line 'build-web-release-image: verify-supply-chain-contract' "$makefile"
# Makefile 中的转义环境变量是刻意保留的字面量。
# shellcheck disable=SC2016
require_fixed 'VITE_RGS_BASE_URL is required' "$makefile"
require_fixed 'VITE_RGS_BET_OPTIONS_MINOR is required' "$makefile"
require_fixed 'VITE_RGS_DEFAULT_BET_MINOR is required' "$makefile"
require_fixed 'VITE_RGS_HOST_ORIGIN is required' "$makefile"
require_fixed 'WEB_RELEASE_VERSION is required' "$makefile"
require_fixed 'WEB_RELEASE_REVISION is required' "$makefile"
require_fixed 'DOCKER_BUILDKIT=1 docker build --file deploy/web/Dockerfile --target runtime \' "$makefile"
require_fixed '--build-arg VITE_RGS_BASE_URL="$${VITE_RGS_BASE_URL}"' "$makefile"
require_fixed '--build-arg VITE_RGS_BET_OPTIONS_MINOR="$${VITE_RGS_BET_OPTIONS_MINOR}"' "$makefile"
require_fixed '--build-arg VITE_RGS_DEFAULT_BET_MINOR="$${VITE_RGS_DEFAULT_BET_MINOR}"' "$makefile"
require_fixed '--build-arg VITE_RGS_HOST_ORIGIN="$${VITE_RGS_HOST_ORIGIN}"' "$makefile"
require_fixed '--build-arg WEB_RELEASE_VERSION="$${WEB_RELEASE_VERSION}"' "$makefile"
require_fixed '--build-arg WEB_RELEASE_REVISION="$${WEB_RELEASE_REVISION}"' "$makefile"
require_fixed '--secret id=release_asset_approval,src="$${RELEASE_ASSET_APPROVAL_FILE}"' "$makefile"

vector_image='timberio/vector:0.57.0-debian@sha256:ed2134fa8f9844c1ca6405260903c2c2c52f94af9e16bc8fa9de9655134e0b39'
require_line "      VECTOR_IMAGE: $vector_image" "$deployment_workflow"
require_line '        run: docker pull "$VECTOR_IMAGE" >/dev/null' "$deployment_workflow"
require_line '        run: make test-vector-bounded-flush' "$deployment_workflow"
require_line 'docker pull "$VECTOR_IMAGE"' "$observability_release_workflow"
require_line 'make test-vector-bounded-flush' "$observability_release_workflow"
test -x "$observability_release_workflow" ||
  fail 'rendered observability release workflow entrypoint must be executable'
test -x "$vector_bounded_flush_test" ||
  fail 'bounded Vector recovery test must be executable'
sh -n "$vector_bounded_flush_test" >/dev/null 2>&1 ||
  fail 'bounded Vector recovery test has invalid shell syntax'
require_fixed "expected_vector_image='$vector_image'" "$vector_bounded_flush_test"
require_fixed "heartbeat_source['interval_secs'] == 10" "$vector_bounded_flush_test"
require_fixed "'count' => 1" "$vector_bounded_flush_test"
require_fixed 'outage_sender_data="$test_directory/outage-sender-data"' "$vector_bounded_flush_test"
require_fixed 'online_sender_data="$test_directory/online-sender-data"' "$vector_bounded_flush_test"
require_fixed "files.any? { |path| File.binread(path).include?(marker) }" "$vector_bounded_flush_test"
require_fixed 'test "$readiness_ready" -eq 1' "$vector_bounded_flush_test"
require_fixed 'outage_deadline=$((outage_started_at + 25))' "$vector_bounded_flush_test"
require_fixed 'online_deadline=$((online_started_at + 25))' "$vector_bounded_flush_test"
require_fixed "event.keys.sort == heartbeat_keys" "$vector_bounded_flush_test"
require_fixed "raise 'business probe count mismatch' unless probes.length == 1" "$vector_bounded_flush_test"
require_fixed "raise 'raw metric escaped' if raw_metric" "$vector_bounded_flush_test"
require_fixed "raise 'outage probe count mismatch' unless all.count { |event| event['bounded_flush_probe'] == 'vector-bounded-flush-outage-v1' } == 1" "$vector_bounded_flush_test"
require_fixed "raise 'online probe count mismatch' unless all.count { |event| event['bounded_flush_probe'] == 'vector-bounded-flush-online-v1' } == 1" "$vector_bounded_flush_test"
if grep -F 'docker pull' "$vector_bounded_flush_test" >/dev/null; then
  fail 'bounded Vector recovery test must use only the preloaded image'
fi
observability_release_workflow_sha=$(ruby -rdigest -e \
  'print Digest::SHA256.file(ARGV.fetch(0)).hexdigest' "$observability_release_workflow")
test "$observability_release_workflow_sha" = '25d0424e0a12d5faa2274bb5bd0f6bc297a302bb1e40ed3f7f2535fb44751b7b' ||
  fail 'rendered observability release workflow entrypoint drifted from the reviewed implementation'
vector_bounded_flush_sha=$(ruby -rdigest -e \
  'print Digest::SHA256.file(ARGV.fetch(0)).hexdigest' "$vector_bounded_flush_test")
test "$vector_bounded_flush_sha" = '248f272074880be00a9c840d389fbeb9e89d7bcc938393c9cfa646653f9971f2' ||
  fail 'bounded Vector recovery test drifted from the reviewed implementation'

postgres_image='postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193'
require_line "    image: $postgres_image" "$compose_file"
require_line '      - "${POSTGRES_BIND_ADDRESS:-127.0.0.1}:${POSTGRES_PORT:-5432}:5432"' "$compose_file"
require_line '      - rgs-host-access' "$compose_file"
require_line '  rgs-data:' "$compose_file"
require_line '  rgs-host-access:' "$compose_file"
require_line '      com.docker.network.bridge.enable_ip_masquerade: "false"' "$compose_file"
require_line "        image: $postgres_image" "$backend_workflow"
if grep -F -- 'POSTGRES_IMAGE' "$compose_file" "$env_example" >/dev/null; then
  fail 'PostgreSQL image must not be overrideable through POSTGRES_IMAGE'
fi

checkout_sha='3d3c42e5aac5ba805825da76410c181273ba90b1'
setup_go_sha='d35c59abb061a4a6fb18e82ac0862c26744d6ab5'
setup_node_sha='49933ea5288caeca8642d1e84afbd3f7d6820020'
upload_artifact_sha='043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'

require_line "        uses: actions/checkout@$checkout_sha # v7.0.1" "$backend_workflow"
test "$(grep -F -c -- '          lfs: true' "$backend_workflow" || true)" -eq 1 ||
  fail 'backend workflow must materialize the reviewed LFS source exactly once'
test "$(grep -F -c -- '          persist-credentials: false' "$backend_workflow" || true)" -eq 1 ||
  fail 'backend workflow must remove checkout credentials before repository code runs'
require_line "        uses: actions/setup-go@$setup_go_sha # v5.5.0" "$backend_workflow"
test "$(grep -F -x -c -- "        uses: actions/upload-artifact@$upload_artifact_sha # v7.0.1" "$backend_workflow" || true)" -eq 2 ||
  fail 'backend workflow must use the reviewed artifact uploader exactly twice'
require_line "        uses: actions/setup-node@$setup_node_sha # v4.4.0" "$frontend_workflow"
require_line '        run: make verify-supply-chain-contract' "$backend_workflow"
require_line '        run: make verify-backend' "$backend_workflow"
test "$(grep -F -c 'docker cp "$runtime_container:/THIRD_PARTY_NOTICES.txt"' "$backend_workflow" || true)" -eq 1 ||
  fail 'backend CI does not extract the runtime Go third-party notice'
test "$(grep -F -c 'docker cp "$migrator_container:/THIRD_PARTY_NOTICES.txt"' "$backend_workflow" || true)" -eq 1 ||
  fail 'backend CI does not extract the migrator Go third-party notice'
test "$(grep -F -c 'cmp server/THIRD_PARTY_NOTICES.txt' "$backend_workflow" || true)" -eq 2 ||
  fail 'backend CI does not compare both image notices with the authority file'
require_line '        run: make smoke-runtime-operations' "$backend_workflow"
require_fixed 'RGS_RUNTIME_SMOKE_POSTGRES_CONTAINER: ${{ job.services.postgres.id }}' "$backend_workflow"
require_line '        run: make smoke-runtime-production' "$backend_workflow"
require_fixed 'RGS_RUNTIME_SMOKE_ARTIFACT_DIR:' "$backend_workflow"
# CI smoke 脚本中的 fixture_dir 必须由脚本运行时展开。
# shellcheck disable=SC2016
require_fixed 'RGS_CI_RUNTIME_FIXTURE=1 RGS_CI_RUNTIME_FIXTURE_PROFILE=development' "$runtime_smoke"
require_fixed 'go run ./cmd/ci-runtime-fixture "$fixture_dir"' "$runtime_smoke"
require_fixed 'ci-runtime-fixture is disabled outside the explicit CI smoke' "$runtime_fixture_command"
if grep -E '(cat[[:space:]]*>|helper_file=|ci_runtime_smoke_fixture_[^/]*\.go)' "$runtime_smoke" >/dev/null; then
  fail 'runtime smoke must not generate or mutate Go source files'
fi
require_fixed 'RGS_OPERATIONS_HTTP_ADDR=127.0.0.1:18081' "$runtime_smoke"
require_fixed "expect_status 404 http://127.0.0.1:18080/metrics" "$runtime_smoke"
require_fixed "expect_status 401 http://127.0.0.1:18081/readyz" "$runtime_smoke"
# 运维 token 只能由 smoke 脚本运行时从临时夹具读取，本契约只匹配字面量。
# shellcheck disable=SC2016
require_fixed 'expect_status 200 http://127.0.0.1:18081/readyz "Bearer $operations_token"' "$runtime_smoke"
require_fixed "grep -F -x 'rgs_ready 1' \"\$artifact_dir/metrics.prom\" >/dev/null" "$runtime_smoke"
require_fixed 'RGS_CI_RUNTIME_FIXTURE=1 RGS_CI_RUNTIME_FIXTURE_PROFILE=production' "$runtime_production_smoke"
require_fixed 'RGS_ENVIRONMENT=production' "$runtime_production_smoke"
require_fixed 'sslmode=verify-full' "$runtime_production_smoke"
require_fixed 'verify_safe_startup_failure "$missing_token_log"' "$runtime_production_smoke"
require_fixed 'verify_safe_startup_failure "$v1_log"' "$runtime_production_smoke"
require_fixed 'allowed_keys = {"time", "level", "msg", "error_class"}' "$runtime_production_smoke"
require_fixed 'safe-startup-envelope.raw.log' "$runtime_production_smoke"
require_fixed 'RGS_OPERATIONS_BEARER_TOKEN_FILE=/run/rgs-production-smoke/operations.token' "$runtime_production_smoke"
require_fixed 'expect_status 404 http://127.0.0.1:18180/metrics' "$runtime_production_smoke"
require_fixed "grep -F -x 'rgs_ready 1' \"\$artifact_dir/metrics-production-ci-only.prom\" >/dev/null" "$runtime_production_smoke"
require_line '        run: make verify-supply-chain-contract' "$frontend_workflow"
require_line '        run: npm run assets:check-streaming-packages' "$frontend_workflow"
require_line '        run: npm test -- --run --fileParallelism=false' "$frontend_workflow"
require_line '        run: DOCKER_BUILDKIT=1 docker build --file deploy/web/Dockerfile --target static-conformance --tag slots-web-static-conformance:ci-only .' "$frontend_workflow"
require_line '          if DOCKER_BUILDKIT=1 docker build \' "$frontend_workflow"
require_line '            --target runtime \' "$frontend_workflow"
require_line '            --tag slots-web-runtime-missing-approval:conformance \' "$frontend_workflow"
require_line '            . 2>&1 | tee web-runtime-missing-approval.log; then' "$frontend_workflow"
require_line "          grep -F 'release_asset_approval' web-runtime-missing-approval.log >/dev/null" "$frontend_workflow"
for fixed_argument in \
  '--build-arg VITE_RGS_BASE_URL=https://rgs.ci.invalid' \
  '--build-arg VITE_RGS_BET_OPTIONS_MINOR=100,200,500' \
  '--build-arg VITE_RGS_DEFAULT_BET_MINOR=200' \
  '--build-arg VITE_RGS_HOST_ORIGIN=https://operator.ci.invalid'
do
  test "$(grep -F -c -- "$fixed_argument" "$frontend_workflow")" -eq 2 ||
    fail "positive config and missing-approval gates must both use $fixed_argument"
done

checkout_count=$(grep -F -c -- "uses: actions/checkout@$checkout_sha # v7.0.1" "$frontend_workflow" || true)
test "$checkout_count" -eq 2 || fail 'frontend workflow must pin both checkout actions to the reviewed SHA'
test "$(grep -F -c -- '          lfs: true' "$frontend_workflow" || true)" -eq 2 ||
  fail 'both frontend jobs must materialize the reviewed LFS source'
test "$(grep -F -c -- '          persist-credentials: false' "$frontend_workflow" || true)" -eq 2 ||
  fail 'both frontend jobs must remove checkout credentials before repository code runs'

invalid_actions=$(grep -RE '^[[:space:]]*uses:[[:space:]]+' "$workflows_root" | grep -Ev '@[0-9a-f]{40}([[:space:]]|$)' || true)
test -z "$invalid_actions" || fail "workflow contains a mutable or malformed action reference: $invalid_actions"

# 生产响应头 renderer 的语义与 CLI 失败闭合必须作为供应链门禁执行，不能只校验文件存在。
command -v node >/dev/null 2>&1 || fail 'node is required to verify the release nginx renderer'
node --test "$web_release_renderer_test" >/dev/null || fail 'release nginx renderer tests failed'

printf '%s\n' 'supply-chain contract: ok'
