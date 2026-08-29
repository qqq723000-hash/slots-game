#!/bin/sh
# shellcheck disable=SC1003,SC2016

# 该门禁不调用 Docker 或网络；它验证发布工作流、扫描阈值、身份约束和工具引用没有被
# 静默放宽。动态漏洞结果仍由 scan.sh 在 CI 中产生，二者不能互相替代。SC1003/SC2016
# 仅因本文件刻意匹配工作流/脚本中的字面量 `$` 与 Dockerfile 行尾反斜杠而关闭。
# English: This gatekeeper does not make calls to Docker or networking; it verifies that release workflows, scan
# thresholds, identity constraints, and tool references have not been Silence relaxes. Dynamic vulnerability
# results are still generated in CI by scan.sh, and the two are not substitutes for each other. SC1003/SC2016
# Closed only because this file intentionally matches the literal `$` with the Dockerfile end-of-line backslash
# in the workflow/script.
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
default_root=$(CDPATH='' cd -- "$script_dir/../.." && pwd)

case "$#" in
  0) repository_root=$default_root ;;
  2)
    test "$1" = --root || { printf '%s\n' 'usage: verify-contract.sh [--root REPOSITORY_ROOT]' >&2; exit 2; }
    repository_root=$(CDPATH='' cd -- "$2" && pwd)
    ;;
  *) printf '%s\n' 'usage: verify-contract.sh [--root REPOSITORY_ROOT]' >&2; exit 2 ;;
esac

workspace_root=$(CDPATH='' cd -- "$repository_root/.." && pwd)
if [ -d "$repository_root/.github/workflows" ]; then
  workflows_root="$repository_root/.github/workflows"
else
  workflows_root="$workspace_root/.github/workflows"
fi
github_root=${workflows_root%/workflows}
delivery_root=${github_root%/.github}

tool_file="$repository_root/deploy/supply-chain/tool-images.env"
scan_script="$repository_root/deploy/supply-chain/scan.sh"
trivy_asset_verifier="$repository_root/deploy/supply-chain/verify-trivy-assets.sh"
trivy_source_report_verifier="$repository_root/deploy/supply-chain/verify-trivy-source-report.mjs"
trivy_report_sanitizer="$repository_root/deploy/supply-chain/sanitize-trivy-report.mjs"
nginx_openssl_patch_verifier="$repository_root/deploy/supply-chain/verify-nginx-openssl-patch.sh"
release_script="$repository_root/deploy/supply-chain/release-sign.sh"
release_bundle_script="$repository_root/deploy/supply-chain/release-bundle.sh"
release_version_verifier="$repository_root/deploy/supply-chain/verify-release-version.mjs"
release_version_test="$repository_root/deploy/supply-chain/verify-release-version.test.mjs"
codeql_sarif_verifier="$repository_root/deploy/supply-chain/verify-codeql-sarif.mjs"
codeql_sarif_test="$repository_root/deploy/supply-chain/verify-codeql-sarif.test.mjs"
observability_release_workflow_script="$repository_root/deploy/observability/verify-release-workflow.sh"
vector_bounded_flush_test="$repository_root/deploy/observability/test-vector-bounded-flush.sh"
web_static_verifier="$repository_root/deploy/supply-chain/verify-web-static-root.mjs"
aws_web_extractor="$repository_root/deploy/supply-chain/extract-aws-web-static-root.sh"
exception_file="$repository_root/deploy/supply-chain/vulnerability-exceptions.json"
readme="$repository_root/deploy/supply-chain/README.md"
source_workflow="$workflows_root/supply-chain.yml"
release_workflow="$workflows_root/supply-chain-release.yml"
deployment_workflow="$workflows_root/deployment-conformance.yml"
backend_workflow="$workflows_root/backend-conformance.yml"
frontend_workflow="$workflows_root/frontend-conformance.yml"
visual_fixture_browser_gate="$repository_root/web/scripts/verify-visual-fixture-cross-browser.mjs"
codeql_workflow="$workflows_root/codeql.yml"
dependency_review_workflow="$workflows_root/dependency-review.yml"
dependabot_config="$github_root/dependabot.yml"
issue_config="$github_root/ISSUE_TEMPLATE/config.yml"
bug_report_template="$github_root/ISSUE_TEMPLATE/bug_report.yml"
change_proposal_template="$github_root/ISSUE_TEMPLATE/change_proposal.yml"
support_doc="$delivery_root/SUPPORT.md"
makefile="$repository_root/Makefile"
web_package_json="$repository_root/web/package.json"
cluster_dockerfile="$repository_root/deploy/cluster-production/Dockerfile.services"
cluster_kubeconform_contract="$repository_root/deploy/cluster-production/verify-kubeconform.sh"
cluster_image_contract="$repository_root/deploy/cluster-production/verify-image-runtime-contract.sh"
cluster_prometheus_rule_contract="$repository_root/deploy/cluster-production/verify-prometheus-rule-contract.sh"
web_dockerfile="$repository_root/deploy/web/Dockerfile"
local_web_dockerfile="$repository_root/deploy/local-production/Dockerfile.web"
local_web_payload_test="$repository_root/deploy/local-production/test-web-candidate-payload.sh"
local_nginx_proxy_dockerfile="$repository_root/deploy/local-production/Dockerfile.nginx-proxy"
aws_deployment_guide="$repository_root/docs/aws-production-deployment.md"
backend_release_gates="$repository_root/docs/backend-release-gates.md"

fail() {
  printf '%s\n' "supply-chain security contract: $*" >&2
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

reject_fixed() {
  forbidden=$1
  file=$2
  if grep -F -- "$forbidden" "$file" >/dev/null; then
    fail "forbidden '$forbidden' in ${file#"$repository_root/"}"
  fi
}

docker_stage_source() {
  stage_name=$1
  dockerfile=$2
  awk -v wanted="$stage_name" '
    /^FROM[[:space:]]+/ {
      if (inside) exit
      inside = ($NF == wanted)
    }
    inside { print }
  ' "$dockerfile"
}

for required_file in \
  "$tool_file" \
  "$scan_script" \
  "$trivy_asset_verifier" \
  "$trivy_source_report_verifier" \
  "$trivy_report_sanitizer" \
  "$nginx_openssl_patch_verifier" \
  "$release_script" \
  "$release_bundle_script" \
  "$release_version_verifier" \
  "$release_version_test" \
  "$codeql_sarif_verifier" \
  "$codeql_sarif_test" \
  "$observability_release_workflow_script" \
  "$vector_bounded_flush_test" \
  "$web_static_verifier" \
  "$aws_web_extractor" \
  "$exception_file" \
  "$readme" \
  "$source_workflow" \
  "$release_workflow" \
  "$deployment_workflow" \
  "$backend_workflow" \
  "$frontend_workflow" \
  "$visual_fixture_browser_gate" \
  "$codeql_workflow" \
  "$dependency_review_workflow" \
  "$dependabot_config" \
  "$issue_config" \
  "$bug_report_template" \
  "$change_proposal_template" \
  "$support_doc" \
  "$makefile" \
  "$web_package_json" \
  "$cluster_dockerfile" \
  "$cluster_kubeconform_contract" \
  "$cluster_image_contract" \
  "$cluster_prometheus_rule_contract" \
  "$web_dockerfile" \
  "$local_web_dockerfile" \
  "$local_web_payload_test" \
  "$local_nginx_proxy_dockerfile" \
  "$aws_deployment_guide" \
  "$backend_release_gates"
do
  require_file "$required_file"
done

test -x "$nginx_openssl_patch_verifier" || fail 'Nginx OpenSSL patch verifier must be executable'
"$nginx_openssl_patch_verifier" web "$web_dockerfile" >/dev/null \
  || fail 'web Nginx OpenSSL patch contract failed'
"$nginx_openssl_patch_verifier" local "$local_web_dockerfile" >/dev/null \
  || fail 'local web Nginx OpenSSL patch contract failed'
"$nginx_openssl_patch_verifier" local "$local_nginx_proxy_dockerfile" >/dev/null \
  || fail 'local proxy Nginx OpenSSL patch contract failed'

test "$(grep -F -x -c -- '    npm ci --ignore-scripts' "$web_dockerfile" || true)" -eq 1 ||
  fail 'Web image dependency installation must disable npm lifecycle scripts'
test "$(grep -F -c -- 'npm --ignore-scripts run build' "$web_dockerfile" || true)" -eq 2 ||
  fail 'both Web image builds must disable npm pre/post lifecycle scripts'
test "$(grep -F -c -- 'node ./scripts/generate-third-party-notices.mjs --check' "$web_dockerfile" || true)" -eq 2 ||
  fail 'both Web image builds must explicitly retain the license declaration check'
test "$(grep -F -c -- 'node ./scripts/verify-asset-provenance.mjs' "$web_dockerfile" || true)" -eq 2 ||
  fail 'both Web image builds must explicitly retain the asset provenance check'
test "$(grep -F -c -- 'node ./scripts/finalize-production-assets.mjs --check' "$web_dockerfile" || true)" -eq 3 ||
  fail 'Web image builds and approval must independently verify the complete dist tree'
test "$(grep -F -c -- 'node ./scripts/verify-production-javascript-bundles.mjs' "$web_dockerfile" || true)" -eq 2 ||
  fail 'both Web image builds must re-verify JavaScript bundles after npm returns'
web_release_build_stage=$(awk '
  /^FROM[[:space:]].*[[:space:]]AS[[:space:]]release-build$/ { capture = 1 }
  capture && /^FROM[[:space:]]+/ && $NF != "release-build" { capture = 0 }
  capture { print }
' "$web_dockerfile")
web_release_build_instructions=$(printf '%s\n' "$web_release_build_stage" | sed '/^[[:space:]]*#/d; /^[[:space:]]*$/d')
expected_web_release_build_instructions=$(printf '%s\n' \
  'FROM release-config-build AS release-build' \
  'RUN --network=none \' \
  '    --mount=type=bind,from=release-config-build,source=/src/web,target=/src/web,readonly \' \
  '    node ./scripts/finalize-production-assets.mjs --check' \
  'RUN --network=none \' \
  '    --mount=type=bind,from=release-config-build,source=/src/web,target=/src/web,readonly \' \
  '    --mount=type=secret,id=release_asset_approval,required=true,target=/run/secrets/release_asset_approval \' \
  '    RELEASE_ASSET_APPROVAL_FILE=/run/secrets/release_asset_approval \' \
  '      node ./scripts/verify-release-asset-approval.mjs')
test "$web_release_build_instructions" = "$expected_web_release_build_instructions" ||
  fail 'Web release approval stage must verify the complete dist tree immediately before approval and perform no later mutation'

require_line 'ARG GO_IMAGE=golang:1.26.6-bookworm@sha256:116d58cbd88c1297624acc6e967a060012422bacf9930927e23fb719189c6f36' "$cluster_dockerfile"
require_line 'ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian12:nonroot@sha256:1b7b9f0f0e0a1d2155f531db587cc48ec26aaf97ab64364225f5bf18a054e66a' "$cluster_dockerfile"
require_fixed 'ENTRYPOINT ["/secret-env", "RGS_DATABASE_URL", "/rgs-server"]' "$cluster_dockerfile"
require_fixed 'COPY --from=build --chown=nonroot:nonroot /out/service-probe /service-probe' "$cluster_dockerfile"
require_fixed 'ENTRYPOINT ["/secret-env", "RGS_MIGRATOR_DATABASE_URL", "/rgs-migrator"]' "$cluster_dockerfile"
require_fixed 'go run ./scripts/third-party-notices --check' "$cluster_dockerfile"
backend_notice_copy='COPY --from=build --chown=nonroot:nonroot /src/server/THIRD_PARTY_NOTICES.txt /THIRD_PARTY_NOTICES.txt'
test "$(grep -F -x -c "$backend_notice_copy" "$cluster_dockerfile" || true)" -eq 2 ||
  fail 'both protected Go image targets must deliver the authoritative third-party notice'
require_fixed 'HELM_ARCHIVE_SHA256: 3f43c0aa57243852dd542493a0f54f1396c0bc8ec7296bbb2c01e802010819ce' "$deployment_workflow"
require_fixed 'KUBECONFORM_ARCHIVE_SHA256: c31518ddd122663b3f3aa874cfe8178cb0988de944f29c74a0b9260920d115d3' "$deployment_workflow"
require_line '        run: make verify-deployment-contracts' "$deployment_workflow"
require_line '        run: make verify-cluster-prometheus-rules' "$deployment_workflow"
vector_image='timberio/vector:0.57.0-debian@sha256:ed2134fa8f9844c1ca6405260903c2c2c52f94af9e16bc8fa9de9655134e0b39'
require_line "      VECTOR_IMAGE: $vector_image" "$deployment_workflow"
require_line '        run: docker pull "$VECTOR_IMAGE" >/dev/null' "$deployment_workflow"
require_line '        run: make test-vector-bounded-flush' "$deployment_workflow"
require_fixed 'verify-deployment-contracts: verify-cluster-production' "$makefile"
require_line 'test-vector-bounded-flush:' "$makefile"
bounded_flush_make_command=$(printf '\t%s' '@./deploy/observability/test-vector-bounded-flush.sh')
require_line "$bounded_flush_make_command" "$makefile"
test "$(grep -F -x -c 'test-vector-bounded-flush:' "$makefile" || true)" -eq 1 ||
  fail 'Makefile must expose exactly one bounded Vector recovery target'
test "$(grep -F -x -c "$bounded_flush_make_command" "$makefile" || true)" -eq 1 ||
  fail 'Makefile must invoke the bounded Vector recovery test exactly once'
require_line 'verify-backend-licenses:' "$makefile"
require_line 'verify-cluster-image-contract:' "$makefile"
require_line 'verify-cluster-prometheus-rules:' "$makefile"
require_fixed 'c8f4e61c63bc529749125ac566bccc6986e08d45' "$cluster_kubeconform_contract"
require_fixed '--target rgs-runtime' "$cluster_image_contract"
require_fixed '--target rgs-migrator' "$cluster_image_contract"
require_fixed 'secret-env: absolute secret file path is required' "$cluster_image_contract"
require_fixed 'RGS_DATABASE_URL_FILE=/run/cluster-contract/database-url' "$cluster_image_contract"
require_fixed '"$runtime_image" RGS_DATABASE_URL /service-probe' "$cluster_image_contract"
require_fixed 'service-probe: unexpected HTTP status 503' "$cluster_image_contract"
require_fixed 'docker volume create "$materializer_volume"' "$cluster_image_contract"
require_fixed 'docker cp "$materializer_container:/run/materializer/destination/secret" -' "$cluster_image_contract"
require_fixed 'member.mode != 0o400' "$cluster_image_contract"
require_fixed 'payload != b"materialized-secret\n"' "$cluster_image_contract"
require_fixed "fail '/secret-materializer 错误覆盖了已有凭据'" "$cluster_image_contract"
require_fixed 'prom/prometheus:v3.13.1@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893' "$cluster_prometheus_rule_contract"
require_fixed 'check rules /rules.yaml' "$cluster_prometheus_rule_contract"

# 低流量磁盘缓冲恢复必须在固定镜像预载后运行真实黑盒门禁；步骤名、命令和顺序都属于
# 发布合同，不能用注释、可跳过条件或第二条业务事件制造“恢复”假象。
# English: Low-traffic disk buffer recovery must run true black box access after fixed image preload; step
# names, commands, and sequences are When publishing a contract, you cannot use comments, skippable conditions,
# or second business events to create the illusion of "recovery."
ruby -ryaml -e '
  workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
  job = workflow.dig("jobs", "verify-deployment-contracts")
  abort "deployment conformance job missing" unless job.is_a?(Hash)
  abort "deployment Vector digest drifted" unless
    job.dig("env", "VECTOR_IMAGE") == ARGV.fetch(1)
  steps = job.fetch("steps")
  abort "deployment conformance steps missing" unless steps.is_a?(Array)
  preload = steps.each_index.select do |index|
    step = steps.fetch(index)
    step.is_a?(Hash) && step["name"] == "Preload fixed Vector image"
  end
  gate = steps.each_index.select do |index|
    step = steps.fetch(index)
    step.is_a?(Hash) && step["name"] == "Verify bounded Vector disk-buffer recovery"
  end
  abort "Vector preload step must exist exactly once" unless preload.length == 1
  abort "bounded Vector gate step must exist exactly once" unless gate.length == 1
  preload_step = steps.fetch(preload.first)
  gate_step = steps.fetch(gate.first)
  abort "Vector preload step keys drifted" unless preload_step.keys.sort == %w[name run]
  abort "bounded Vector gate step keys drifted" unless gate_step.keys.sort == %w[name run]
  abort "Vector preload command drifted" unless
    preload_step["run"] == "docker pull \"$VECTOR_IMAGE\" >/dev/null"
  abort "bounded Vector gate command drifted" unless
    gate_step["run"] == "make test-vector-bounded-flush"
  abort "bounded Vector gate must immediately follow image preload" unless
    gate.first == preload.first + 1
' "$deployment_workflow" "$vector_image" ||
  fail 'deployment bounded Vector recovery workflow semantic contract failed'

test -x "$vector_bounded_flush_test" ||
  fail 'bounded Vector recovery test must be executable'
sh -n "$vector_bounded_flush_test" >/dev/null 2>&1 ||
  fail 'bounded Vector recovery test has invalid shell syntax'
for bounded_flush_control in \
  "expected_vector_image='$vector_image'" \
  'docker image inspect "$vector_image"' \
  "source_name = 'archive_flush_heartbeat_metric'" \
  "metric_transform_name = 'archive_flush_heartbeat_to_log'" \
  "safe_transform_name = 'safe_archive_flush_heartbeat'" \
  "heartbeat_source['interval_secs'] == 10" \
  "heartbeat_metric_transform == {" \
  "heartbeat_safe_transform['inputs'] == [metric_transform_name]" \
  "'count' => 1" \
  "'sequence' => false" \
  'outage_sender_data="$test_directory/outage-sender-data"' \
  'online_sender_data="$test_directory/online-sender-data"' \
  "outage_sender = bounded_sender(" \
  "online_sender = bounded_sender(" \
  "marker: 'vector-bounded-flush-outage-v1'" \
  "marker: 'vector-bounded-flush-online-v1'" \
  "files.any? { |path| File.binread(path).include?(marker) }" \
  "test \"\$readiness_ready\" -eq 1" \
  "event.keys.sort == heartbeat_keys" \
  "raise 'business probe count mismatch' unless probes.length == 1" \
  "raise 'raw metric escaped' if raw_metric" \
  "raise 'outage probe count mismatch' unless all.count { |event| event['bounded_flush_probe'] == 'vector-bounded-flush-outage-v1' } == 1" \
  "raise 'online probe count mismatch' unless all.count { |event| event['bounded_flush_probe'] == 'vector-bounded-flush-online-v1' } == 1" \
  'docker network create --internal "$network_name"' \
  '--pull never' \
  'sleep 8' \
  'outage_deadline=$((outage_started_at + 25))' \
  'online_deadline=$((online_started_at + 25))'
do
  require_fixed "$bounded_flush_control" "$vector_bounded_flush_test"
done
reject_fixed 'docker pull' "$vector_bounded_flush_test"
reject_fixed 'docker run -p' "$vector_bounded_flush_test"
reject_fixed 'docker run --publish' "$vector_bounded_flush_test"
vector_bounded_flush_sha=$(ruby -rdigest -e \
  'print Digest::SHA256.file(ARGV.fetch(0)).hexdigest' "$vector_bounded_flush_test")
test "$vector_bounded_flush_sha" = '91359b501a6ffac24912a07319b7b866e22d9bebdc86dfbf7b3ea2adabeb9fb9' ||
  fail 'bounded Vector recovery test drifted from the reviewed implementation'

# 两阶段的顺序本身是证据：先在 receiver 不存在时确认磁盘持久化，再停止第一 sender，
# 通过独立 HTTP->file 控制探针确认 receiver 就绪，最后才启动全新 data_dir 的在线 sender。
# English: The order of the two phases is evidence in itself: first confirm disk persistence when the receiver
# does not exist, then stop the first sender, Confirm receiver readiness through a separate HTTP->file control
# probe, and finally start the new data_dir's online sender.
outage_buffer_evidence_line=$(grep -n -F "files.any? { |path| File.binread(path).include?(marker) }" "$vector_bounded_flush_test" | cut -d: -f1)
receiver_start_line=$(grep -n -F 'run_vector "$receiver_name" "$receiver_config" "$receiver_data"' "$vector_bounded_flush_test" | cut -d: -f1)
outage_remove_line=$(grep -n -F 'docker rm "$outage_sender_name"' "$vector_bounded_flush_test" | cut -d: -f1)
readiness_line=$(grep -n -F 'test "$readiness_ready" -eq 1' "$vector_bounded_flush_test" | cut -d: -f1)
online_start_line=$(grep -n -F 'run_vector "$online_sender_name" "$online_sender_config" "$online_sender_data"' "$vector_bounded_flush_test" | cut -d: -f1)
test -n "$outage_buffer_evidence_line" && test -n "$receiver_start_line" && \
  test "$outage_buffer_evidence_line" -lt "$receiver_start_line" ||
  fail 'bounded Vector recovery must prove disk persistence before starting the receiver'
test -n "$outage_remove_line" && test -n "$readiness_line" && test -n "$online_start_line" && \
  test "$outage_remove_line" -lt "$readiness_line" && test "$readiness_line" -lt "$online_start_line" ||
  fail 'bounded Vector recovery must isolate outage, readiness and online phases in order'

require_cancellable_conformance_concurrency() {
  workflow=$1
  expected_group=$2
  label=$3
  concurrency_block=$(awk '
    $0 == "concurrency:" { inside = 1 }
    inside { print }
    inside && $0 == "  cancel-in-progress: true" { exit }
  ' "$workflow")
  expected_block=$(printf '%s\n' \
    'concurrency:' \
    "  group: $expected_group" \
    '  cancel-in-progress: true')
  test "$concurrency_block" = "$expected_block" ||
    fail "$label concurrency must cancel the stale run for the exact workflow and ref"
  test "$(grep -F -x -c 'concurrency:' "$workflow" || true)" -eq 1 ||
    fail "$label workflow must define exactly one workflow-level concurrency lock"
}

require_cancellable_conformance_concurrency \
  "$backend_workflow" \
  'backend-conformance-${{ github.workflow }}-${{ github.ref }}' \
  'backend conformance'
require_cancellable_conformance_concurrency \
  "$frontend_workflow" \
  'frontend-conformance-${{ github.workflow }}-${{ github.ref }}' \
  'frontend conformance'

# 工具版本和多架构清单 digest 均为经复核的发布输入；标签用于审计可读性，digest 才是执行身份。
# English: The tool version and multi-architecture manifest digest are both audited release inputs; tags are
# used for audit readability, and digest is the execution identity.
require_line 'GOLANG_IMAGE=docker.io/library/golang:1.26.6-bookworm@sha256:116d58cbd88c1297624acc6e967a060012422bacf9930927e23fb719189c6f36' "$tool_file"
require_line 'NODE_IMAGE=docker.io/library/node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94' "$tool_file"
require_line 'GOVULNCHECK_MODULE=golang.org/x/vuln/cmd/govulncheck@v1.7.0' "$tool_file"
require_line 'GITLEAKS_IMAGE=docker.io/zricethezav/gitleaks:v8.29.1@sha256:aa036a2f4bdfe3cc3c55fa4326308efabb4a6be498c883c864fd1d0d5585438a' "$tool_file"
require_line 'SYFT_IMAGE=docker.io/anchore/syft:v1.51.0@sha256:678bfa565b60f747aac0f8e964fe5588a24445b8d0a480e91f6efd70020dfbb0' "$tool_file"
require_line 'TRIVY_IMAGE=docker.io/aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969' "$tool_file"
require_line 'COSIGN_IMAGE=ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8' "$tool_file"
require_line 'BUILDKIT_IMAGE=docker.io/moby/buildkit:v0.32.2@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8' "$tool_file"
require_line 'SKOPEO_IMAGE=quay.io/skopeo/stable:v1.21.0@sha256:a585e4a3b8a045baa87c7f1b2f940d6d299ebede85ab3f2419d52d2264eefc93' "$tool_file"

image_line_count=$(grep -E -c '^[A-Z_]+_IMAGE=[^[:space:]@]+:[^[:space:]@]+@sha256:[0-9a-f]{64}$' "$tool_file" || true)
test "$image_line_count" -eq 8 || fail 'all eight scanner/build/conversion/signing tool images must use version plus sha256 digest'
tool_assignment_count=$(grep -E -c '^[A-Z_]+=' "$tool_file" || true)
test "$tool_assignment_count" -eq 9 || fail 'tool manifest must contain only the eight images and one govulncheck module assignment'
invalid_tool_lines=$(grep -Ev '^(#[[:space:]].*|[[:space:]]*$|[A-Z_]+=[A-Za-z0-9./_:@+-]+)$' "$tool_file" || true)
test -z "$invalid_tool_lines" || fail 'tool manifest contains executable or malformed content'

# 当前策略没有任何仓库内豁免；不能用伪工单或无到期日白名单绕过 HIGH/CRITICAL 门禁。
# English: The current policy has no in-repository exemptions; HIGH/CRITICAL gates cannot be bypassed with
# fabricated tickets or non-expiring allowlist entries.
require_line '  "policy": "block-high-and-critical",' "$exception_file"
require_line '  "exceptions": []' "$exception_file"
if grep -E 'CVE-|GHSA-|GO-[0-9]{4}-|"id"[[:space:]]*:' "$exception_file" >/dev/null; then
  fail 'repository vulnerability exceptions are not approved'
fi

# 依赖、secret、双格式 SBOM、文件系统与容器扫描必须同时存在。
# English: Dependencies, secrets, dual-format SBOM, file system, and container scanning must exist at the same
# time.
require_line '      "$GOBIN/govulncheck" -json ./... > /out/govulncheck.json' "$scan_script"
require_line '      sha256sum "$GOBIN/govulncheck" > /out/govulncheck-binary.sha256' "$scan_script"
require_fixed '--env GOPATH=/tmp/go' "$scan_script"
require_fixed '--tmpfs /run/govulncheck:rw,nosuid,nodev,exec,size=64m,mode=1777' "$scan_script"
require_fixed '--env GOBIN=/run/govulncheck' "$scan_script"
require_line '      mkdir -p "$HOME" "$GOPATH" "$GOCACHE" "$GOMODCACHE" "$GOBIN"' "$scan_script"
require_line '      npm audit --package-lock-only --audit-level=high --json > /out/npm-audit-all.json || result=1' "$scan_script"
require_line '      npm audit --package-lock-only --omit=dev --audit-level=high --json > /out/npm-audit-production.json || result=1' "$scan_script"
require_line '      exit "$result"' "$scan_script"
require_fixed 'git_root=$(git -C "$repository_root" rev-parse --show-toplevel' "$scan_script"
require_fixed "gitleaks_canary_secret='ghp_'" "$scan_script"
require_fixed '"$GITLEAKS_IMAGE" dir /canary --no-banner --redact=100 --exit-code 1' "$scan_script"
require_fixed '"RuleID"[[:space:]]*:[[:space:]]*"github-pat"' "$scan_script"
require_fixed 'if grep -F -- "$gitleaks_canary_secret" "$evidence_dir/gitleaks-canary.json" >/dev/null; then' "$scan_script"
require_fixed '"$GITLEAKS_IMAGE" git /workspace --log-opts='"'"'--full-history HEAD --diff-filter=tuxdb'"'"'' "$scan_script"
reject_fixed "--log-opts='--full-history --all --diff-filter=tuxdb'" "$scan_script"
require_fixed '"$GITLEAKS_IMAGE" dir /workspace --no-banner --redact=100 --exit-code 1' "$scan_script"
require_fixed '--gitleaks-ignore-path /dev/null --ignore-gitleaks-allow' "$scan_script"
require_fixed 'test ! -e "$git_root/.gitleaks.toml"' "$scan_script"
require_fixed "trivy_inline_marker='trivy:'" "$scan_script"
require_fixed 'trivy_inline_marker="${trivy_inline_marker}ignore"' "$scan_script"
require_fixed 'git -C "$git_root" grep -F "$trivy_inline_marker" -- .' "$scan_script"
require_fixed 'git -C "$git_root" rev-list HEAD --count > "$output_dir/gitleaks-history-commit-count.txt"' "$scan_script"
reject_fixed 'git -C "$git_root" rev-list --all --count' "$scan_script"
require_fixed '--output cyclonedx-json@1.6=/out/source.cyclonedx.json' "$scan_script"
require_fixed '--output spdx-json@2.3=/out/source.spdx.json' "$scan_script"
require_fixed '"$SYFT_IMAGE" "dir:/workspace"' "$scan_script"
require_fixed '--output "cyclonedx-json@1.6=/out/$report_name.cyclonedx.json"' "$scan_script"
require_fixed '--output "spdx-json@2.3=/out/$report_name.spdx.json"' "$scan_script"
require_fixed '--tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777' "$scan_script"
require_fixed '--tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777' "$scan_script"
require_fixed '--env HOME=/tmp/syft-home' "$scan_script"
require_fixed '--env XDG_CACHE_HOME=/tmp/syft-cache' "$scan_script"
require_fixed '"$TRIVY_IMAGE" config /canary' "$scan_script"
require_fixed '--config /dev/null --cache-dir /cache' "$scan_script"
require_fixed '--timeout 30m --no-progress' "$scan_script"
require_fixed '--checks-bundle-repository mirror.gcr.io/aquasec/trivy-checks:2' "$scan_script"
require_fixed '--ignorefile /dev/null --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL' "$scan_script"
require_fixed '"$trivy_asset_verifier" "$cache_dir" "$evidence_dir" >/dev/null' "$scan_script"
require_fixed '"$trivy_asset_verifier" "$trivy_cache" "$output_dir" >/dev/null' "$scan_script"
require_fixed '"$TRIVY_IMAGE" fs /workspace' "$scan_script"
require_fixed '--config /dev/null --cache-dir /cache --cache-backend memory' "$scan_script"
require_fixed '--skip-db-update --no-progress' "$scan_script"
require_fixed '--scanners vuln --severity HIGH,CRITICAL --exit-code 1' "$scan_script"
require_fixed '--tmpfs /scan:rw,nosuid,nodev,size=64m,mode=1777' "$scan_script"
require_fixed '--tmpfs /terraform:rw,nosuid,nodev,size=64m,mode=1777' "$scan_script"
require_line "      trivy config /scan \\" "$scan_script"
require_fixed '--helm-values /scan/cluster/values.example.yaml' "$scan_script"
require_fixed 'cp "$PROJECT_ROOT/deploy/Dockerfile" /scan/dockerfiles/root/Dockerfile' "$scan_script"
require_fixed 'cp "$PROJECT_ROOT/deploy/cluster-production/Dockerfile.services" /scan/dockerfiles/cluster/Dockerfile.services' "$scan_script"
require_fixed 'cp "$PROJECT_ROOT/deploy/local-production/Dockerfile.nginx-proxy" /scan/dockerfiles/local-nginx-proxy/Dockerfile.nginx-proxy' "$scan_script"
require_fixed 'cp "$PROJECT_ROOT/deploy/local-production/Dockerfile.services" /scan/dockerfiles/local-services/Dockerfile.services' "$scan_script"
require_fixed 'cp "$PROJECT_ROOT/deploy/local-production/Dockerfile.web" /scan/dockerfiles/local-web/Dockerfile.web' "$scan_script"
require_fixed 'cp "$PROJECT_ROOT/deploy/web/Dockerfile" /scan/dockerfiles/web/Dockerfile' "$scan_script"
require_fixed 'cp -R "$PROJECT_ROOT/deploy/cluster-production/chart" /scan/cluster/chart' "$scan_script"
require_fixed 'terraform_pathspec=":(glob)$terraform_git_prefix/**/*.tf"' "$scan_script"
require_fixed "git -C \"\$git_root\" ls-files -z -- \\" "$scan_script"
require_fixed '"$terraform_git_prefix/environments/dev/terraform.tfvars.example"' "$scan_script"
require_fixed '"$terraform_git_prefix/environments/staging/terraform.tfvars.example"' "$scan_script"
require_fixed '"$terraform_git_prefix/environments/prod-primary/terraform.tfvars.example"' "$scan_script"
require_fixed '"$terraform_git_prefix/environments/prod-dr/terraform.tfvars.example"' "$scan_script"
require_fixed '"$terraform_git_prefix/modules/web-edge/release-request.js"' "$scan_script"
require_fixed '"$terraform_git_prefix/modules/web-edge/release-response.js" > "$terraform_input_dir/tracked-files.nul"' "$scan_script"
require_fixed '--mount "type=bind,src=$terraform_input_dir,dst=/terraform-input,readonly"' "$scan_script"
require_fixed 'while IFS= read -r -d "" tracked_path' "$scan_script"
require_fixed '"$TERRAFORM_GIT_PREFIX"/*)' "$scan_script"
require_fixed '*.tf|environments/dev/terraform.tfvars.example|environments/staging/terraform.tfvars.example|environments/prod-primary/terraform.tfvars.example|environments/prod-dr/terraform.tfvars.example|modules/web-edge/release-request.js|modules/web-edge/release-response.js)' "$scan_script"
require_fixed 'test ! -L "$source_path" || { echo "tracked Terraform scanner source must not be a symbolic link" >&2; exit 1; }' "$scan_script"
require_fixed 'printf "terraform/%s\n" "$relative_path" >> /out/trivy-terraform-tracked-files.txt' "$scan_script"
require_fixed 'find /terraform -type f -print' "$scan_script"
require_fixed 'LC_ALL=C sort > /out/trivy-terraform-copied-files.txt' "$scan_script"
require_fixed 'cmp -s /out/trivy-terraform-tracked-files.txt /out/trivy-terraform-copied-files.txt' "$scan_script"
require_fixed '--env TF_VAR_valkey_password_a=ScannerOnlyPasswordA123456789' "$scan_script"
require_fixed '--env TF_VAR_valkey_password_b=ScannerOnlyPasswordB123456789' "$scan_script"
require_fixed "terraform_scanner_hmac_key=\$(printf '%s' 'scanner-only-hmac-input-not-a-secret-000000' | base64 | tr -d '\\n')" "$scan_script"
require_fixed '--env "TF_VAR_shared_admission_hmac_key=$terraform_scanner_hmac_key"' "$scan_script"
require_fixed '--env TF_VAR_valkey_root_ca_pem=SCANNER_ONLY_CA_PLACEHOLDER' "$scan_script"
require_fixed "trivy config . \\" "$scan_script"
require_fixed '--tf-vars "/terraform/environments/$environment/terraform.tfvars.example"' "$scan_script"
require_fixed '--format json --output "/out/trivy-terraform-$environment.json"' "$scan_script"
require_fixed 'node /policy/verify-trivy-source-report.mjs' "$scan_script"
require_fixed 'expectedConfigurationTargets' "$trivy_source_report_verifier"
require_fixed 'expectedTerraformResultTargets' "$trivy_source_report_verifier"
require_fixed 'expectedTerraformReports' "$trivy_source_report_verifier"
require_fixed 'requiredTerraformEnvironmentSources' "$trivy_source_report_verifier"
require_fixed 'requiredTerraformVariableInputs' "$trivy_source_report_verifier"
require_fixed 'requiredTerraformSupportInputs' "$trivy_source_report_verifier"
require_fixed 'Git 跟踪 Terraform 清单与隔离复制清单不一致' "$trivy_source_report_verifier"
require_fixed 'Trivy 源码扫描覆盖契约通过' "$trivy_source_report_verifier"
require_fixed '--scanners vuln,secret --severity HIGH,CRITICAL --exit-code 1' "$scan_script"
require_fixed '"$SYFT_IMAGE" "oci-archive:/input/$archive_name"' "$scan_script"
require_fixed 'sanitize_trivy_image_report "$output_dir/$report_name.trivy.json"' "$scan_script"
require_fixed '"$NODE_IMAGE" node /policy/sanitize-trivy-report.mjs "/out/$report_name"' "$scan_script"
require_fixed 'delete finding.Code;' "$trivy_report_sanitizer"
require_fixed 'delete finding.Match;' "$trivy_report_sanitizer"
require_fixed 'sanitized Trivy image evidence still contains secret plaintext fields' "$scan_script"
require_fixed 'record_trivy_database "$trivy_cache" "$output_dir"' "$scan_script"
require_fixed 'sha256sum "$cache_dir/db/trivy.db" > "$output_dir/trivy-db.sha256"' "$scan_script"
require_fixed 'source scan output must be outside the Git root to prevent self-scanning evidence' "$scan_script"
require_fixed 'Trivy cache must be outside the Git root scanned as source' "$scan_script"
require_fixed '--network=none' "$scan_script"

redact_count=$(grep -F -c -- '--redact=100' "$scan_script" || true)
test "$redact_count" -eq 3 || fail 'Gitleaks canary, complete history and worktree scans must all use redact=100'
gitleaks_ignore_count=$(grep -F -c -- '--gitleaks-ignore-path /dev/null --ignore-gitleaks-allow' "$scan_script" || true)
test "$gitleaks_ignore_count" -eq 3 || fail 'all Gitleaks scans must disable repository ignore and inline allow directives'
terraform_environment_loop_count=$(grep -F -c -- 'for environment in dev staging prod-primary prod-dr' "$scan_script" || true)
test "$terraform_environment_loop_count" -eq 1 || fail 'Terraform per-environment scans must cover the exact four environments'
syft_source_tmpfs_count=$(grep -F -c -- '--tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777' "$scan_script" || true)
test "$syft_source_tmpfs_count" -eq 1 || fail 'source Syft must have one writable sticky temporary filesystem'
syft_archive_tmpfs_count=$(grep -F -c -- '--tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777' "$scan_script" || true)
test "$syft_archive_tmpfs_count" -eq 2 || fail 'daemon-image and OCI-archive Syft must each have a writable sticky temporary filesystem'
syft_home_count=$(grep -F -c -- '--env HOME=/tmp/syft-home' "$scan_script" || true)
test "$syft_home_count" -eq 3 || fail 'all three Syft modes must use an isolated writable home directory'
syft_cache_count=$(grep -F -c -- '--env XDG_CACHE_HOME=/tmp/syft-cache' "$scan_script" || true)
test "$syft_cache_count" -eq 3 || fail 'all three Syft modes must use an isolated writable cache directory'
trivy_ignore_count=$(grep -F -c -- '--ignorefile /dev/null' "$scan_script" || true)
test "$trivy_ignore_count" -eq 6 || fail 'all Trivy canary, dependency, Docker/Helm, Terraform and image command definitions must disable repository ignore files'
trivy_config_count=$(grep -F -c -- '--config /dev/null' "$scan_script" || true)
test "$trivy_config_count" -eq 7 || fail 'all Trivy download/canary/dependency/Docker/Helm/Terraform/image command definitions must disable repository config files'
checks_repository_count=$(grep -F -c -- '--checks-bundle-repository mirror.gcr.io/aquasec/trivy-checks:2' "$scan_script" || true)
test "$checks_repository_count" -eq 3 || fail 'online, Docker/Helm and Terraform IaC stages must use the reviewed official checks repository'
all_checks_repository_count=$(grep -F -c -- '--checks-bundle-repository' "$scan_script" || true)
test "$all_checks_repository_count" -eq "$checks_repository_count" || fail 'custom Trivy checks repositories are forbidden'
trivy_database_record_count=$(grep -F -c -- 'record_trivy_database "$trivy_cache" "$output_dir"' "$scan_script" || true)
test "$trivy_database_record_count" -eq 3 || fail 'source, daemon image and OCI archive scans must record the Trivy vulnerability DB identity'
sanitize_call_count=$(grep -F -c -- 'sanitize_trivy_image_report "$output_dir/$report_name.trivy.json"' "$scan_script" || true)
test "$sanitize_call_count" -eq 2 || fail 'both image scan modes must sanitize Trivy evidence'
for scan_function in run_image_scan run_oci_archive_scan
do
  scan_block=$(awk -v start="${scan_function}() {" '$0 == start { inside = 1 } inside { print } inside && /^}$/ { exit }' "$scan_script")
  trivy_report_line=$(printf '%s\n' "$scan_block" | grep -n -F -- '--format json --output "/out/$report_name.trivy.json"' | cut -d: -f1)
  sanitize_line=$(printf '%s\n' "$scan_block" | grep -n -F 'sanitize_trivy_image_report "$output_dir/$report_name.trivy.json"' | cut -d: -f1)
  test -n "$trivy_report_line" && test -n "$sanitize_line" && test "$trivy_report_line" -lt "$sanitize_line" || \
    fail "$scan_function must sanitize only after Trivy writes the report"
done

trivy_prepare_block=$(awk '/^prepare_trivy_checks\(\)/ { inside = 1 } inside { print } inside && /^}/ { exit }' "$scan_script")
printf '%s\n' "$trivy_prepare_block" | grep -F '"$TRIVY_IMAGE" config /canary' >/dev/null || fail 'Trivy checks canary is not in the online preparation stage'
if printf '%s\n' "$trivy_prepare_block" | grep -Ev '^[[:space:]]*#' | grep -E -- '--network=none|--skip-check-update' >/dev/null; then
  fail 'Trivy checks preparation must be allowed to download the reviewed bundle'
fi
if printf '%s\n' "$trivy_prepare_block" | grep -Ev '^[[:space:]]*#' | grep -E -- '--no-progress|--scanners([=[:space:]]|$)' >/dev/null; then
  fail 'Trivy config canary contains flags unsupported by the pinned scanner version'
fi

# checks bundle 不能只依赖镜像内隐式 fallback；必须校验动态 metadata、内容与真实 IaC 命中并留存哈希。
# English: The checks bundle cannot rely solely on the image's implicit fallback; it must verify dynamic
# metadata, content, and real IaC hits and persist the hashes.
require_fixed 'test -s "$cache_dir/db/metadata.json"' "$trivy_asset_verifier"
require_fixed 'test -s "$cache_dir/policy/metadata.json"' "$trivy_asset_verifier"
require_fixed 'test -d "$cache_dir/policy/content"' "$trivy_asset_verifier"
require_fixed '"Digest"[[:space:]]*:[[:space:]]*"sha256:[0-9a-f]{64}"' "$trivy_asset_verifier"
require_fixed '"MajorVersion"[[:space:]]*:[[:space:]]*2[[:space:]]*([,}])' "$trivy_asset_verifier"
require_fixed 'checks bundle must not contain symbolic links' "$trivy_asset_verifier"
require_fixed 'test -s "$canary_report"' "$trivy_asset_verifier"
require_fixed 'cp "$cache_dir/policy/metadata.json" "$evidence_dir/trivy-checks-metadata.json"' "$trivy_asset_verifier"
require_fixed 'trivy-checks-files.sha256' "$trivy_asset_verifier"
require_fixed 'trivy-checks-content.sha256' "$trivy_asset_verifier"

reject_fixed '--ignore-unfixed' "$scan_script"
reject_fixed '--exit-code 0' "$scan_script"
reject_fixed '--baseline-path' "$scan_script"
reject_fixed '--enable-rule' "$scan_script"
reject_fixed '--ignore-policy' "$scan_script"
reject_fixed '--ignore-status' "$scan_script"
reject_fixed '--skip-files' "$scan_script"
reject_fixed '--skip-dirs' "$scan_script"
reject_fixed '--db-repository' "$scan_script"
reject_fixed '--java-db-repository' "$scan_script"
reject_fixed '--secret-config' "$scan_script"
reject_fixed '--config-check' "$scan_script"
reject_fixed '--check-namespaces' "$scan_script"
reject_fixed '--misconfig-scanners' "$scan_script"
reject_fixed '--tf-exclude' "$scan_script"
reject_fixed '--exclude' "$scan_script"
reject_fixed '--insecure' "$scan_script"

# 跨权限域发布包必须把源码、目标、公开配置、Web 审批摘要、OCI manifest 和每个文件摘要绑定。
# English: Cross-authority domain distribution packages must bind the source code, target, public configuration,
# web approval digest, OCI manifest and each file digest.
require_fixed 'case "$SUPPLY_CHAIN_ARTIFACT:$build_kind" in' "$release_bundle_script"
require_fixed 'rgs-runtime:rgs-unprivileged|rgs-migrator:rgs-unprivileged|web-runtime:web-approved)' "$release_bundle_script"
require_fixed 'tar -xOf "$bundle_dir/release-image.oci.tar" oci-layout' "$release_bundle_script"
require_fixed '.manifests | select(length == 1) | .[0].digest' "$release_bundle_script"
require_fixed 'test "$metadata_digest" = "$oci_manifest_digest"' "$release_bundle_script"
require_fixed 'approved Web build must bind the exact approval SHA-256' "$release_bundle_script"
require_fixed 'ASSET_APPROVAL_EXPIRES_AT=%s' "$release_bundle_script"
require_fixed 'ASSET_APPROVAL_METADATA_SHA256=%s' "$release_bundle_script"
require_fixed 'approval_expires_at=%s' "$release_bundle_script"
require_fixed 'approval_metadata_sha256=%s' "$release_bundle_script"
require_fixed 'approval has expired before bundle finalization' "$release_bundle_script"
require_fixed 'RGS build must not carry a Web approval digest' "$release_bundle_script"
require_fixed 'CONFIGURATION_SHA256=%s' "$release_bundle_script"
require_fixed 'SOURCE_TREE_SHA=%s' "$release_bundle_script"
require_fixed 'printf '\''SOURCE_TREE_SHA=%s\n'\'' "$SOURCE_TREE_SHA"' "$release_bundle_script"
require_fixed 'ASSET_APPROVAL_SHA256=%s' "$release_bundle_script"
require_fixed 'OCI_ARCHIVE_SHA256=%s' "$release_bundle_script"
require_fixed 'CHECKSUMS_SHA256=%s' "$release_bundle_script"
require_fixed 'bundle_manifest_sha256=%s' "$release_bundle_script"
require_fixed 'bundle_checksums_sha256=%s' "$release_bundle_script"
require_fixed 'oci_archive_sha256=%s' "$release_bundle_script"
reject_fixed 'source "$bundle_dir/bundle-manifest.env"' "$release_bundle_script"

# AWS 静态发布只能逐文件验证从不可变制品提取的根目录，拒绝软链接、额外文件和摘要漂移。
# English: AWS static publishing can only verify root directories extracted from immutable artifacts on a
# file-by-file basis, rejecting soft links, extra files, and digest drift.
require_fixed 'release-manifest.json' "$web_static_verifier"
require_fixed 'extracted Web root contains a symbolic link' "$web_static_verifier"
require_fixed 'extracted Web root contains a file outside release-manifest' "$web_static_verifier"
require_fixed 'extracted Web file SHA-256 does not match release-manifest' "$web_static_verifier"
require_fixed 'Web image must be addressed by an immutable sha256 digest, never a tag' "$aws_web_extractor"
require_fixed 'docker image inspect "$image_reference"' "$aws_web_extractor"
require_fixed 'docker create "$image_reference"' "$aws_web_extractor"
require_fixed 'docker cp "$container_id:/usr/share/nginx/html/." "$static_root"' "$aws_web_extractor"
require_fixed 'node "$static_verifier" "$static_root"' "$aws_web_extractor"
require_fixed 'CONFIGURATION_SHA256=%s' "$aws_web_extractor"
require_fixed 'cloudfront-content-security-policy.txt' "$aws_web_extractor"
require_fixed '["trusted-types", "slots-game-static-html"],' "$aws_web_extractor"
require_fixed '["require-trusted-types-for", "\u0027script\u0027"],' "$aws_web_extractor"
reject_fixed 'docker pull' "$aws_web_extractor"
reject_fixed 'web/dist/' "$aws_web_extractor"
require_fixed 'extract-aws-web-static-root.sh' "$aws_deployment_guide"
require_fixed 'set -euo pipefail' "$aws_deployment_guide"
require_fixed '`deploy/aws-production/workflow/publish-web-release.sh`' "$aws_deployment_guide"
require_fixed 'put-object --if-none-match' "$aws_deployment_guide"
require_fixed 'bucket policy 是服务端' "$aws_deployment_guide"
reject_fixed 'SLOTS_EXISTING_OBJECT_COUNT=' "$aws_deployment_guide"
reject_fixed 'aws s3 sync "$SLOTS_EXTRACTED_STATIC_ROOT/"' "$aws_deployment_guide"
require_fixed '`CONFIGURATION_SHA256`' "$aws_deployment_guide"
require_fixed '`cloudfront-content-security-policy.txt`' "$aws_deployment_guide"
require_fixed '逐文件通过 `release-manifest.json`' "$aws_deployment_guide"
aws_workspace_publish=$(grep -E '^[[:space:]]*aws[[:space:]]+s3[[:space:]]+(sync|cp)[[:space:]].*(web/)?dist(/|[[:space:]])' "$aws_deployment_guide" || true)
test -z "$aws_workspace_publish" || fail 'AWS guide must never upload a mutable workspace dist directory'
aws_extract_line=$(grep -n -F 'sh deploy/supply-chain/extract-aws-web-static-root.sh' "$aws_deployment_guide" | head -n 1 | cut -d: -f1)
aws_publisher_line=$(grep -n -F 'deploy/aws-production/workflow/publish-web-release.sh' "$aws_deployment_guide" | tail -n 1 | cut -d: -f1)
test -n "$aws_extract_line" && test -n "$aws_publisher_line" \
  && test "$aws_extract_line" -lt "$aws_publisher_line" || \
  fail 'AWS guide must extract and verify immutable Web bytes before the conditional publisher'

# 获批 Web OCI 在扫描和上传前必须把精确静态字节装入真实 Chrome；源码目录的普通构建不能替代。
# English: Approved Web OCI must load the exact static bytes into real Chrome before scanning and uploading; a
# normal build of the source directory is not a substitute.
require_fixed 'Smoke the exact approval-gated Web bytes in a real browser' "$release_workflow"
require_fixed '"docker-archive:/output/release-image.docker.tar:$local_ref"' "$release_workflow"
require_fixed 'docker load --input "$conversion_root/release-image.docker.tar"' "$release_workflow"
require_fixed 'docker cp "$container_id:/usr/share/nginx/html/." "$static_root"' "$release_workflow"
require_fixed 'node deploy/supply-chain/verify-web-static-root.mjs "$static_root"' "$release_workflow"
require_fixed "node web/scripts/verify-production-browser-bootstrap.mjs \\" "$release_workflow"
require_fixed '--distribution-root "$static_root"' "$release_workflow"
require_fixed "VITE_RGS_BASE_URL=\"\$RGS_BASE_URL\" \\" "$release_workflow"
require_fixed "VITE_RGS_HOST_ORIGIN=\"\$RGS_HOST_ORIGIN\" \\" "$release_workflow"
web_build_line=$(grep -n -F 'Build exact approval-gated Web result as an OCI archive' "$release_workflow" | head -n 1 | cut -d: -f1)
web_browser_line=$(grep -n -F 'Smoke the exact approval-gated Web bytes in a real browser' "$release_workflow" | head -n 1 | cut -d: -f1)
web_static_root_line=$(grep -n -F 'node deploy/supply-chain/verify-web-static-root.mjs "$static_root"' "$release_workflow" | head -n 1 | cut -d: -f1)
web_browser_command_line=$(grep -n -F 'node web/scripts/verify-production-browser-bootstrap.mjs \' "$release_workflow" | head -n 1 | cut -d: -f1)
web_scan_line=$(grep -n -F 'Scan the exact approved Web OCI archive and generate dual-format SBOM' "$release_workflow" | head -n 1 | cut -d: -f1)
test -n "$web_build_line" && test -n "$web_browser_line" && test -n "$web_static_root_line" \
  && test -n "$web_browser_command_line" && test -n "$web_scan_line" \
  && test "$web_build_line" -lt "$web_browser_line" \
  && test "$web_browser_line" -lt "$web_static_root_line" \
  && test "$web_static_root_line" -lt "$web_browser_command_line" \
  && test "$web_browser_command_line" -lt "$web_scan_line" || \
  fail 'exact approved Web browser smoke must run after build and before scan/upload'

# 发布必须来自受保护 tag，身份须精确绑定本工作流；Cosign 禁止弱化 Registry/TLog/身份校验。
# English: Publishing must come from protected tags, and the identity must be accurately bound to this workflow;
# Cosign prohibits weakening Registry/TLog/identity verification.
require_fixed 'test "$GITHUB_REF_PROTECTED" = true' "$release_script"
require_fixed 'refs/tags/*)' "$release_script"
require_fixed 'rgs-runtime|rgs-migrator)' "$release_script"
require_fixed 'web-runtime)' "$release_script"
require_fixed 'RGS artifacts must not accept Web runtime configuration' "$release_script"
require_fixed 'RGS_BASE_URL RGS_BET_OPTIONS_MINOR RGS_DEFAULT_BET_MINOR RGS_HOST_ORIGIN' "$release_script"
require_fixed 'test "$SUPPLY_CHAIN_IMAGE_TAG" = "$GITHUB_REF_NAME"' "$release_script"
require_fixed 'printf '\''%s\n'\'' "$release_version" | cmp -s - "$version_file"' "$release_script"
require_fixed 'test "$GITHUB_REF_NAME" = "v$release_version"' "$release_script"
require_fixed 'expected_workflow_ref="$GITHUB_REPOSITORY/.github/workflows/supply-chain-release.yml@$GITHUB_REF"' "$release_script"
require_fixed 'test "$SUPPLY_CHAIN_EXPECTED_CERTIFICATE_IDENTITY" = "$computed_identity"' "$release_script"
require_fixed "test \"\$SUPPLY_CHAIN_EXPECTED_OIDC_ISSUER\" = 'https://token.actions.githubusercontent.com'" "$release_script"
require_fixed "grep -Eq '^sha256:[0-9a-f]{64}$'" "$release_script"
require_fixed 'sign --yes "$image_reference"' "$release_script"
require_fixed '--certificate-identity "$SUPPLY_CHAIN_EXPECTED_CERTIFICATE_IDENTITY"' "$release_script"
require_fixed '--certificate-oidc-issuer "$SUPPLY_CHAIN_EXPECTED_OIDC_ISSUER"' "$release_script"
reject_fixed '--allow-http-registry' "$release_script"
reject_fixed '--allow-insecure-registry' "$release_script"
reject_fixed '--insecure-ignore-tlog' "$release_script"
reject_fixed '--tlog-upload=false' "$release_script"
reject_fixed 'generate-key-pair' "$release_script"

checkout_sha='3d3c42e5aac5ba805825da76410c181273ba90b1'
upload_sha='043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'
attest_sha='1e69f48acb82d1966a394da916b4c1698aa569d6'
configure_aws_sha='61815dcd50bd041e203e49132bacad1fd04d2708'
ecr_login_sha='03f1aad4c6c7ffd436567f42f9384779290529bd'
setup_go_sha='d35c59abb061a4a6fb18e82ac0862c26744d6ab5'
setup_node_sha='49933ea5288caeca8642d1e84afbd3f7d6820020'
setup_buildx_sha='bb05f3f5519dd87d3ba754cc423b652a5edd6d2c'
download_sha='3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'

require_line '        run: node deploy/supply-chain/verify-release-version.mjs --formal' "$release_workflow"
require_line "        uses: actions/checkout@$checkout_sha # v7.0.1" "$source_workflow"
require_line '          fetch-depth: 0' "$source_workflow"
require_line '          persist-credentials: false' "$source_workflow"
require_line '        run: ./deploy/supply-chain/scan.sh source "$SUPPLY_CHAIN_REPORT_DIR"' "$source_workflow"
require_fixed 'CLUSTER_RUNTIME_IMAGE=slots-rgs-runtime:supply-chain' "$source_workflow"
require_fixed 'CLUSTER_MIGRATOR_IMAGE=slots-rgs-migrator:supply-chain' "$source_workflow"
require_fixed 'make verify-cluster-image-contract' "$source_workflow"
require_fixed 'scan.sh image slots-rgs-runtime:supply-chain rgs-runtime' "$source_workflow"
require_fixed 'scan.sh image slots-rgs-migrator:supply-chain rgs-migrator' "$source_workflow"
require_fixed 'scan.sh image slots-web-static-conformance:ci-only web-static-conformance' "$source_workflow"
reject_fixed 'docker build --file deploy/Dockerfile --target runtime --tag slots-rgs-runtime:supply-chain .' "$source_workflow"
reject_fixed 'docker build --file deploy/Dockerfile --target migrator --tag slots-rgs-migrator:supply-chain .' "$source_workflow"
require_line '        if: always()' "$source_workflow"
require_line "        uses: actions/upload-artifact@$upload_sha # v7.0.1" "$source_workflow"

test "$(grep -F -c -- "uses: actions/checkout@$checkout_sha # v7.0.1" "$backend_workflow" || true)" -eq 1 ||
  fail 'backend workflow must use the reviewed checkout exactly once'
test "$(grep -F -c -- '          lfs: true' "$backend_workflow" || true)" -eq 1 ||
  fail 'backend workflow must materialize LFS source exactly once'
test "$(grep -F -c -- '          persist-credentials: false' "$backend_workflow" || true)" -eq 1 ||
  fail 'backend workflow must remove checkout credentials'
test "$(grep -F -c -- "uses: actions/checkout@$checkout_sha # v7.0.1" "$frontend_workflow" || true)" -eq 4 ||
  fail 'all four frontend jobs must use the reviewed checkout'
test "$(grep -F -c -- '          lfs: true' "$frontend_workflow" || true)" -eq 4 ||
  fail 'all four frontend jobs must materialize LFS source'
test "$(grep -F -c -- '          persist-credentials: false' "$frontend_workflow" || true)" -eq 4 ||
  fail 'all four frontend jobs must remove checkout credentials'
require_fixed '  verify-special-features:' "$frontend_workflow"
require_fixed '    name: verify-special-features (${{ matrix.browser }})' "$frontend_workflow"
require_line '    # Firefox/WebKit 脚本各保留 20 分钟且作业 35 分钟；Chromium 脚本保留 32 分钟且作业 37 分钟。' "$frontend_workflow"
require_fixed '    timeout-minutes: ${{ matrix.job_timeout_minutes }}' "$frontend_workflow"
require_line '      fail-fast: false' "$frontend_workflow"
require_line '          - browser: chromium' "$frontend_workflow"
require_line '            job_timeout_minutes: 37' "$frontend_workflow"
require_line '          - browser: firefox' "$frontend_workflow"
require_line '            job_timeout_minutes: 35' "$frontend_workflow"
require_line '          - browser: webkit' "$frontend_workflow"
require_fixed '  verify-edge:' "$frontend_workflow"
require_fixed '    runs-on: windows-latest' "$frontend_workflow"
require_line '    # Windows 软件渲染截图受脚本 32 分钟硬截止；额外预算只覆盖安装、生产构建与 Edge 事务门禁。' "$frontend_workflow"
require_line '    timeout-minutes: 40' "$frontend_workflow"
require_line '        run: npx playwright install --with-deps firefox webkit' "$frontend_workflow"
require_fixed 'SLOTS_FIREFOX_XVFB_SOFTWARE_WEBGL=1' "$frontend_workflow"
require_fixed 'LIBGL_ALWAYS_SOFTWARE=true' "$frontend_workflow"
require_fixed 'GALLIUM_DRIVER=llvmpipe' "$frontend_workflow"
require_fixed 'xvfb-run --auto-servernum' "$frontend_workflow"
require_fixed 'npm run build:browser-matrix' "$frontend_workflow"
require_line '        run: npm run build:browser-matrix -- --browser msedge' "$frontend_workflow"
require_line '        run: npx playwright install --with-deps "${{ matrix.browser }}"' "$frontend_workflow"
require_fixed 'npm run test:visual-fixtures-browser-matrix -- --browser "${{ matrix.browser }}"' "$frontend_workflow"
require_line '        run: npm run test:visual-fixtures-browser-matrix -- --browser msedge' "$frontend_workflow"

require_line 'const chromiumDesktopKongScenarioDeadlineMs = 360_000;' "$visual_fixture_browser_gate"
require_line 'const edgeCapSummaryScenarioDeadlineMs = 300_000;' "$visual_fixture_browser_gate"
require_line 'const slowKongScenarioDeadlineMs = 270_000;' "$visual_fixture_browser_gate"
require_line 'const slowBrowserDeadlineMs = 32 * 60_000;' "$visual_fixture_browser_gate"
require_line 'const edgeBrowserDeadlineMs = 32 * 60_000;' "$visual_fixture_browser_gate"
require_line 'const slowMaximumBrowserBudgetMs = 33 * 60_000;' "$visual_fixture_browser_gate"
require_line 'const edgeMaximumBrowserBudgetMs = 33 * 60_000;' "$visual_fixture_browser_gate"
node - "$visual_fixture_browser_gate" <<'NODE'
const { readFileSync } = require("node:fs");
const source = readFileSync(process.argv[2], "utf8");
const chromiumDesktopKongBranch = [
  '  if (browserName === "chromium"',
  '    && surface.id === "desktop-1440x900"',
  '    && contract.scenario === "kong-flow") {',
  "    return chromiumDesktopKongScenarioDeadlineMs;",
  "  }",
].join("\n");
const sharedSlowKongBranch = [
  '  if (slowBrowser && contract.scenario === "kong-flow"',
  '    && (surface.id === "desktop-1440x900" || surface.id === "tablet-1024x768")) {',
  "    return slowKongScenarioDeadlineMs;",
  "  }",
].join("\n");
const edgeCapSummaryBranch = [
  '  if (browserName === "msedge"',
  '    && surface.id === "desktop-1440x900"',
  '    && contract.scenario === "cap-summary") {',
  "    return edgeCapSummaryScenarioDeadlineMs;",
  "  }",
].join("\n");
const sharedSlowExtendedBranch = [
  '  if (slowBrowser',
  '    && ((surface.id === "desktop-1440x900" && contract.scenario === "cap-summary")',
  '      || (surface.id === "mobile-390x844" && contract.scenario === "king-flow"))) {',
  "    return slowExtendedScenarioDeadlineMs;",
  "  }",
].join("\n");
const count = (value) => source.split(value).length - 1;
if (count(chromiumDesktopKongBranch) !== 1) {
  throw new Error("Chromium desktop Kong timing tuple drifted");
}
if (count(sharedSlowKongBranch) !== 1) {
  throw new Error("shared slow Kong timing tuple drifted");
}
if (count(edgeCapSummaryBranch) !== 1) {
  throw new Error("Edge desktop cap-summary timing tuple drifted");
}
if (count(sharedSlowExtendedBranch) !== 1) {
  throw new Error("shared slow extended timing tuple drifted");
}
if (source.indexOf(chromiumDesktopKongBranch) >= source.indexOf(sharedSlowKongBranch)) {
  throw new Error("Chromium desktop Kong timing tuple must precede the shared slow tuple");
}
if (source.indexOf(edgeCapSummaryBranch) >= source.indexOf(sharedSlowExtendedBranch)) {
  throw new Error("Edge desktop cap-summary timing tuple must precede the shared slow tuple");
}
NODE

# 前端门禁的命令字面量必须位于预期 job/step 中并保持无条件执行。仅 grep 到同一命令不能证明
# 它没有被移入禁用 step、容错 step 或不受保护的新 job；YAML 语义检查同时固定权限、runner、
# 超时、矩阵、工作目录、步骤顺序和经复核的 Action 身份。
# English: The command literal of the front-end gate must be located in the expected job/step and remain
# unconditionally executed. Just greping to the same command doesn't prove It has not been moved into a disabled
# step, a fault-tolerant step, or a new unprotected job; YAML semantics checks while fixing permissions,
# runners, Timeouts, matrices, working directories, step sequences, and reviewed Action identities.
ruby -ryaml -e '
  workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
  abort "frontend workflow root must be a mapping" unless workflow.is_a?(Hash)
  abort "frontend workflow permissions drifted" unless
    workflow["permissions"] == { "contents" => "read" }

  jobs = workflow["jobs"]
  abort "frontend jobs must be a mapping" unless jobs.is_a?(Hash)
  expected_job_ids = %w[
    verify-frontend
    verify-special-features
    verify-edge
    verify-web-static-image
  ]
  abort "frontend job set drifted" unless jobs.keys.sort == expected_job_ids.sort

  checkout_ref = "actions/checkout@#{ARGV.fetch(1)}"
  setup_go_ref = "actions/setup-go@#{ARGV.fetch(2)}"
  setup_node_ref = "actions/setup-node@#{ARGV.fetch(3)}"

  reject_bypass = lambda do |mapping, label|
    abort "#{label} must not declare if" if mapping.key?("if")
    abort "#{label} must not declare continue-on-error" if mapping.key?("continue-on-error")
  end

  expected_steps = {
    "verify-frontend" => [
      "Check out repository",
      "Set up Go for cross-runtime RGS E2E",
      "Set up Node.js",
      "Install locked dependencies",
      "Audit complete locked dependency tree",
      "Audit production dependencies",
      "Verify streaming package manifests",
      "Type-check frontend",
      "Run frontend tests",
      "Build production frontend",
      "Verify production transaction in real Chrome",
      "Install Firefox and WebKit engines",
      "Verify production transaction across browser engines",
      "Rebuild and verify deterministic release bytes",
    ],
    "verify-special-features" => [
      "Check out repository",
      "Set up Node.js",
      "Install locked dependencies",
      "Install selected browser engine",
      "Verify non-production special-feature fixtures",
    ],
    "verify-edge" => [
      "Check out repository",
      "Set up Node.js",
      "Install locked dependencies",
      "Build production frontend",
      "Verify production transaction in Microsoft Edge",
      "Verify non-production special-feature fixtures in Microsoft Edge",
    ],
    "verify-web-static-image" => [
      "Check out repository",
      "Verify release supply-chain contract",
      "Verify daemon-independent web container contract",
      "Build unprivileged CI-only static image",
      "Build CI-only release configuration conformance artifact",
      "Verify CI-only release configuration boundary",
      "Reject production web image without approval secret",
      "Verify CI-only static image ownership and content boundary",
      "Probe CI-only static health, cache, range and security response contracts",
    ],
  }

  job_specs = {
    "verify-frontend" => {
      "runs-on" => "ubuntu-latest",
      "timeout-minutes" => 30,
      "defaults" => { "run" => { "working-directory" => "slots-game/web" } },
    },
    "verify-special-features" => {
      "runs-on" => "ubuntu-latest",
      "timeout-minutes" => "${{ matrix.job_timeout_minutes }}",
      "defaults" => { "run" => { "working-directory" => "slots-game/web" } },
    },
    "verify-edge" => {
      "runs-on" => "windows-latest",
      "timeout-minutes" => 40,
      "defaults" => {
        "run" => { "shell" => "bash", "working-directory" => "slots-game/web" },
      },
    },
    "verify-web-static-image" => {
      "runs-on" => "ubuntu-latest",
      "timeout-minutes" => 20,
      "defaults" => nil,
    },
  }

  step_by_name = {}
  expected_job_ids.each do |job_id|
    job = jobs[job_id]
    abort "frontend job #{job_id} must be a mapping" unless job.is_a?(Hash)
    reject_bypass.call(job, "frontend job #{job_id}")
    abort "frontend job #{job_id} must inherit the read-only workflow permissions" if
      job.key?("permissions")

    spec = job_specs.fetch(job_id)
    abort "frontend job #{job_id} runner drifted" unless job["runs-on"] == spec["runs-on"]
    abort "frontend job #{job_id} timeout drifted" unless
      job["timeout-minutes"] == spec["timeout-minutes"]
    if spec["defaults"].nil?
      abort "frontend job #{job_id} gained unreviewed defaults" if job.key?("defaults")
    else
      abort "frontend job #{job_id} defaults drifted" unless job["defaults"] == spec["defaults"]
    end

    steps = job["steps"]
    abort "frontend job #{job_id} steps must be an array" unless steps.is_a?(Array)
    abort "frontend job #{job_id} step order or membership drifted" unless
      steps.map { |step| step.is_a?(Hash) ? step["name"] : nil } == expected_steps.fetch(job_id)
    steps.each do |step|
      label = "frontend job #{job_id} step #{step.fetch("name")}"
      reject_bypass.call(step, label)
      abort "#{label} must not override the reviewed shell" if step.key?("shell")
      if job_id != "verify-web-static-image" && step.key?("working-directory")
        abort "#{label} must inherit the reviewed Web working directory"
      end
      step_by_name[[job_id, step.fetch("name")]] = step
    end
  end

  special = jobs.fetch("verify-special-features")
  abort "special-feature job display name drifted" unless
    special["name"] == "verify-special-features (${{ matrix.browser }})"
  abort "special-feature browser strategy drifted" unless special["strategy"] == {
    "fail-fast" => false,
    "matrix" => {
      "include" => [
        { "browser" => "chromium", "job_timeout_minutes" => 37 },
        { "browser" => "firefox", "job_timeout_minutes" => 35 },
        { "browser" => "webkit", "job_timeout_minutes" => 35 },
      ],
    },
  }

  expect_action = lambda do |job_id, name, reference|
    step = step_by_name.fetch([job_id, name])
    abort "#{job_id}/#{name} Action drifted" unless
      step["uses"] == reference && !step.key?("run")
  end
  expected_job_ids.each do |job_id|
    expect_action.call(job_id, "Check out repository", checkout_ref)
    checkout = step_by_name.fetch([job_id, "Check out repository"])
    abort "#{job_id} checkout inputs drifted" unless checkout["with"] == {
      "lfs" => true,
      "persist-credentials" => false,
    }
  end
  expect_action.call("verify-frontend", "Set up Go for cross-runtime RGS E2E", setup_go_ref)
  %w[verify-frontend verify-special-features verify-edge].each do |job_id|
    expect_action.call(job_id, "Set up Node.js", setup_node_ref)
  end

  line_continuation = 92.chr
  production_browser_matrix_run = [
    "SLOTS_FIREFOX_XVFB_SOFTWARE_WEBGL=1 #{line_continuation}",
    "LIBGL_ALWAYS_SOFTWARE=true #{line_continuation}",
    "GALLIUM_DRIVER=llvmpipe #{line_continuation}",
    "xvfb-run --auto-servernum --server-args=\"-screen 0 1920x1080x24 -nolisten tcp +extension GLX +extension RENDER -noreset\" #{line_continuation}",
    "  npm run build:browser-matrix",
  ].join("\n") + "\n"
  special_feature_matrix_run = [
    %q(if [[ "${{ matrix.browser }}" == "firefox" ]]; then),
    "  SLOTS_FIREFOX_XVFB_SOFTWARE_WEBGL=1 #{line_continuation}",
    "  LIBGL_ALWAYS_SOFTWARE=true #{line_continuation}",
    "  GALLIUM_DRIVER=llvmpipe #{line_continuation}",
    "  xvfb-run --auto-servernum --server-args=\"-screen 0 1920x1080x24 -nolisten tcp +extension GLX +extension RENDER -noreset\" #{line_continuation}",
    "    npm run test:visual-fixtures-browser-matrix -- --browser firefox",
    "else",
    %q(  npm run test:visual-fixtures-browser-matrix -- --browser "${{ matrix.browser }}"),
    "fi",
  ].join("\n") + "\n"

  expected_runs = {
    ["verify-frontend", "Install locked dependencies"] => "npm ci",
    ["verify-frontend", "Audit complete locked dependency tree"] =>
      "npm audit --audit-level=high",
    ["verify-frontend", "Audit production dependencies"] =>
      "npm audit --omit=dev --audit-level=high",
    ["verify-frontend", "Verify streaming package manifests"] =>
      "npm run assets:check-streaming-packages",
    ["verify-frontend", "Type-check frontend"] => "npm run typecheck",
    ["verify-frontend", "Run frontend tests"] =>
      "npm test -- --run --fileParallelism=false",
    ["verify-frontend", "Build production frontend"] => "npm run build",
    ["verify-frontend", "Verify production transaction in real Chrome"] =>
      "npm run build:browser-smoke",
    ["verify-frontend", "Install Firefox and WebKit engines"] =>
      "npx playwright install --with-deps firefox webkit",
    ["verify-frontend", "Verify production transaction across browser engines"] =>
      production_browser_matrix_run,
    ["verify-frontend", "Rebuild and verify deterministic release bytes"] =>
      "npm run build:determinism-check",
    ["verify-special-features", "Install locked dependencies"] => "npm ci",
    ["verify-special-features", "Install selected browser engine"] =>
      %q(npx playwright install --with-deps "${{ matrix.browser }}"),
    ["verify-special-features", "Verify non-production special-feature fixtures"] =>
      special_feature_matrix_run,
    ["verify-edge", "Install locked dependencies"] => "npm ci",
    ["verify-edge", "Build production frontend"] => "npm run build",
    ["verify-edge", "Verify production transaction in Microsoft Edge"] =>
      "npm run build:browser-matrix -- --browser msedge",
    ["verify-edge", "Verify non-production special-feature fixtures in Microsoft Edge"] =>
      "npm run test:visual-fixtures-browser-matrix -- --browser msedge",
    ["verify-web-static-image", "Verify release supply-chain contract"] =>
      "make verify-supply-chain-contract",
    ["verify-web-static-image", "Verify daemon-independent web container contract"] =>
      "./deploy/web/verify-static-contract.sh",
    ["verify-web-static-image", "Build unprivileged CI-only static image"] =>
      "DOCKER_BUILDKIT=1 docker build --file deploy/web/Dockerfile --target static-conformance --tag slots-web-static-conformance:ci-only .",
  }
  expected_runs.each do |identity, command|
    step = step_by_name.fetch(identity)
    abort "#{identity.join("/")} command drifted" unless
      step["run"] == command && !step.key?("uses")
    if identity.first == "verify-web-static-image"
      abort "#{identity.join("/")} working directory drifted" unless
        step["working-directory"] == "slots-game"
    end
  end
' "$frontend_workflow" "$checkout_sha" "$setup_go_sha" "$setup_node_sha" ||
  fail 'frontend workflow YAML semantic contract failed'
require_fixed 'shellcheck -S warning -x -P . -P "$(dirname "$script")" "$script"' "$deployment_workflow"
require_fixed "done < <(git ls-files -- '*.sh')" "$deployment_workflow"
reject_fixed 'npm run build:demo' "$frontend_workflow"

# 公开试玩与 Pages 已按产品范围移除；门禁同时拒绝工作流、构建入口和源码重新出现。
# English: Public demos and Pages have been removed artifacts-wide; gated workflows, build entries, and source
# code have reappeared.
for removed_demo_path in \
  "$workflows_root/pages-demo.yml" \
  "$repository_root/web/demo" \
  "$repository_root/web/src/demo" \
  "$repository_root/web/vite.demo.config.ts" \
  "$repository_root/web/scripts/finalize-static-demo.mjs" \
  "$repository_root/web/scripts/verify-static-demo-asset-approval.mjs" \
  "$repository_root/web/scripts/verify-static-demo-build.mjs" \
  "$repository_root/web/tests/public-static-demo-gateway.test.ts" \
  "$repository_root/web/tests/static-demo-asset-approval.test.ts" \
  "$repository_root/web/tests/static-demo-contract.test.ts"
do
  test ! -e "$removed_demo_path" || fail "removed public demo surface reappeared: ${removed_demo_path#"$delivery_root/"}"
done
ruby -rjson -e '
  scripts = JSON.parse(File.read(ARGV.fetch(0))).fetch("scripts")
  demo = scripts.keys.grep(/demo/i)
  abort "public demo npm scripts reappeared: #{demo.join(", ")}" unless demo.empty?
' "$web_package_json" || fail 'removed public demo npm contract failed'
for public_doc in "$delivery_root/README.md" "$repository_root/README.md" "$repository_root/web/README.md"; do
  test -f "$public_doc" || continue
  if grep -Ei 'GitHub Pages|一键在线试玩|静态试玩' "$public_doc" >/dev/null; then
    fail "removed public demo statement reappeared in ${public_doc#"$delivery_root/"}"
  fi
done

# release 只允许人工 dispatch，并把执行仓库代码、Web 素材审批和最终发布拆成三个权限域。
# English: Release only allows manual dispatch, and splits the execution of repository code, web asset approval
# and final release into three permission areas.
release_trigger=$(awk '/^on:$/ { inside = 1; next } /^permissions:$/ { inside = 0 } inside { print }' "$release_workflow")
printf '%s\n' "$release_trigger" | grep -F -x '  workflow_dispatch:' >/dev/null || fail 'release workflow must use workflow_dispatch'
if printf '%s\n' "$release_trigger" | grep -E '^[[:space:]]+(push|pull_request|schedule|workflow_run):' >/dev/null; then
  fail 'release signing must not run from an automatic trigger'
fi

release_concurrency=$(awk '
  $0 == "concurrency:" { inside = 1 }
  inside { print }
  inside && $0 == "  cancel-in-progress: false" { exit }
' "$release_workflow")
expected_release_concurrency=$(printf '%s\n' \
  'concurrency:' \
  '  group: ${{ format('\''slots-supply-chain-release-{0}-{1}'\'', inputs.image_repository, inputs.image_tag) }}' \
  '  cancel-in-progress: false')
test "$release_concurrency" = "$expected_release_concurrency" ||
  fail 'release concurrency must serialize the exact image repository and tag without cancelling an in-flight release'
test "$(grep -F -x -c 'concurrency:' "$release_workflow" || true)" -eq 1 ||
  fail 'release workflow must define exactly one workflow-level concurrency lock'

extract_release_job() {
  job_name=$1
  awk -v expected="  $job_name:" '
    /^  [A-Za-z0-9_-]+:$/ {
      if (inside) exit
      inside = ($0 == expected)
    }
    inside { print }
  ' "$release_workflow"
}

conformance_job=$(extract_release_job verify-source-conformance)
rgs_job=$(extract_release_job build-rgs)
web_job=$(extract_release_job build-approved-web)
artifact_binding_job=$(extract_release_job bind-release-artifact)
publish_job=$(extract_release_job publish-sign)
test -n "$conformance_job" && test -n "$rgs_job" && test -n "$web_job" && \
  test -n "$artifact_binding_job" && test -n "$publish_job" || \
  fail 'all five release permission domains are required'
conformance_job_code=$(printf '%s\n' "$conformance_job" | grep -Ev '^[[:space:]]*#' || true)
rgs_job_code=$(printf '%s\n' "$rgs_job" | grep -Ev '^[[:space:]]*#' || true)
web_job_code=$(printf '%s\n' "$web_job" | grep -Ev '^[[:space:]]*#' || true)
artifact_binding_job_code=$(printf '%s\n' "$artifact_binding_job" | grep -Ev '^[[:space:]]*#' || true)
publish_job_code=$(printf '%s\n' "$publish_job" | grep -Ev '^[[:space:]]*#' || true)

extract_job_permissions() {
  printf '%s\n' "$1" | awk '
    $0 == "    permissions:" { inside = 1; next }
    inside && /^    [^ ]/ { exit }
    inside && $0 !~ /^[[:space:]]*(#|$)/ { print }
  '
}

require_exact_job_permissions() {
  permission_job_name=$1
  permission_job=$2
  expected_permissions=$3
  actual_permissions=$(extract_job_permissions "$permission_job")
  test "$actual_permissions" = "$expected_permissions" ||
    fail "$permission_job_name job permissions must match the exact allowlist"
}

readonly_permissions='      contents: read'
artifact_binding_permissions='      actions: read'
publish_permissions=$(printf '%s\n' \
  '      contents: read' \
  '      id-token: write' \
  '      attestations: write' \
  '      artifact-metadata: write')
require_exact_job_permissions verify-source-conformance "$conformance_job" "$readonly_permissions"
require_exact_job_permissions build-rgs "$rgs_job" "$readonly_permissions"
require_exact_job_permissions build-approved-web "$web_job" "$readonly_permissions"
require_exact_job_permissions bind-release-artifact "$artifact_binding_job" "$artifact_binding_permissions"
require_exact_job_permissions publish-sign "$publish_job" "$publish_permissions"

# A：源码/依赖/数据库/runtime 门禁在纯 contents:read job；此 job 绝不产出候选镜像。
printf '%s\n' "$conformance_job" | grep -F -x '  verify-source-conformance:' >/dev/null || fail 'missing verify-source-conformance job'
printf '%s\n' "$conformance_job" | grep -F -x '    permissions:' >/dev/null || fail 'conformance job needs explicit permissions'
printf '%s\n' "$conformance_job" | grep -F -x '      contents: read' >/dev/null || fail 'conformance job must only read contents'
if printf '%s\n' "$conformance_job_code" | grep -E '^[[:space:]]+(environment|id-token|attestations|artifact-metadata):|\$\{\{ secrets\.' >/dev/null; then
  fail 'source conformance job must not receive Environment, OIDC, attestation or secrets'
fi
printf '%s\n' "$conformance_job" | grep -F -x '    timeout-minutes: 90' >/dev/null || fail 'conformance job timeout is not fixed'
require_line '        run: make verify' "$release_workflow"
printf '%s\n' "$conformance_job" | grep -F 'postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193' >/dev/null || fail 'release PostgreSQL service must use the reviewed digest'
printf '%s\n' "$conformance_job" | grep -F "uses: actions/setup-go@$setup_go_sha # v5.5.0" >/dev/null || fail 'reviewed setup-go is missing'
printf '%s\n' "$conformance_job" | grep -F 'go-version: 1.26.6' >/dev/null || fail 'release Go version is not fixed'
printf '%s\n' "$conformance_job" | grep -F "uses: actions/setup-node@$setup_node_sha # v4.4.0" >/dev/null || fail 'reviewed setup-node is missing'
printf '%s\n' "$conformance_job" | grep -F 'node-version: 22.22.0' >/dev/null || fail 'release Node version is not fixed'
for required_control in \
  'run: ./deploy/supply-chain/release-sign.sh validate-build' \
  'run: test -z "$(git status --porcelain=v1 --untracked-files=all)"' \
  'run: ./deploy/supply-chain/scan.sh source "$SUPPLY_CHAIN_REPORT_DIR/source"' \
  'run: npm ci' \
  'run: npm run assets:check-streaming-packages' \
  'run: make verify-deployment-contracts' \
  'run: make verify-cluster-prometheus-rules' \
  'run: ./deploy/observability/verify-release-workflow.sh' \
  'run: make verify' \
  'run: npm run build:determinism-check' \
  'run: make test-postgres' \
  'run: make smoke-runtime-production' \
  'run: make verify-cluster-image-contract'
do
  printf '%s\n' "$conformance_job" | grep -F -- "$required_control" >/dev/null || fail "conformance job missing $required_control"
done
for observability_release_binding in \
  'PROMETHEUS_IMAGE: prom/prometheus:v3.13.1@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893' \
  'VECTOR_IMAGE: timberio/vector:0.57.0-debian@sha256:ed2134fa8f9844c1ca6405260903c2c2c52f94af9e16bc8fa9de9655134e0b39' \
  'GRAFANA_IMAGE: grafana/grafana:13.1.0@sha256:121a7a9ece6dc10b969f1f96eed64b4f07dfac0d0b8abc070f7cb83bbde86f63' \
  'RGS_LOG_SINK_URI: https://logs.release.invalid/v1/ingest' \
  'RGS_CONTAINER_LOG_GLOB: /var/log/containers/rgs-server-*.log' \
  'PROMETHEUS_RENDER_PROFILE: local-production' \
  'RGS_OPERATIONS_TARGET: rgs-server:8081' \
  'ALERTMANAGER_TARGET: alert-proxy:8443' \
  'ALERTMANAGER_CA_FILE: /run/secrets/alertmanager_root_ca.pem' \
  'ALERTMANAGER_SERVER_NAME: alert-proxy'
do
  printf '%s\n' "$conformance_job" | grep -F -- "$observability_release_binding" >/dev/null ||
    fail "release observability validation missing $observability_release_binding"
done
test -x "$observability_release_workflow_script" ||
  fail 'rendered observability release workflow entrypoint must be executable'
require_line 'docker pull "$VECTOR_IMAGE"' "$observability_release_workflow_script"
require_line 'make test-vector-bounded-flush' "$observability_release_workflow_script"
test "$(grep -F -x -c 'docker pull "$VECTOR_IMAGE"' "$observability_release_workflow_script" || true)" -eq 1 ||
  fail 'rendered observability release entrypoint must preload Vector exactly once'
test "$(grep -F -x -c 'make test-vector-bounded-flush' "$observability_release_workflow_script" || true)" -eq 1 ||
  fail 'rendered observability release entrypoint must run the bounded recovery gate exactly once'
release_vector_pull_line=$(grep -n -F -x 'docker pull "$VECTOR_IMAGE"' "$observability_release_workflow_script" | cut -d: -f1)
release_bounded_gate_line=$(grep -n -F -x 'make test-vector-bounded-flush' "$observability_release_workflow_script" | cut -d: -f1)
release_observability_verify_line=$(grep -n -F 'make verify-observability-release' "$observability_release_workflow_script" | cut -d: -f1)
test -n "$release_vector_pull_line" && test -n "$release_bounded_gate_line" && \
  test "$release_vector_pull_line" -lt "$release_bounded_gate_line" ||
  fail 'rendered observability release entrypoint must preload Vector before the bounded recovery gate'
test -n "$release_observability_verify_line" && test "$release_bounded_gate_line" -lt "$release_observability_verify_line" ||
  fail 'bounded Vector recovery must pass before rendered release verification'
observability_release_workflow_sha=$(ruby -rdigest -e \
  'print Digest::SHA256.file(ARGV.fetch(0)).hexdigest' "$observability_release_workflow_script")
test "$observability_release_workflow_sha" = 'f302cdc1f2aa49916f0650268129db99adc8b016d7c09f6125ef8fb7fcb360e6' ||
  fail 'rendered observability release workflow entrypoint drifted from the reviewed implementation'
ruby -ryaml -rjson -rdigest -e '
  workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
  steps = workflow.dig("jobs", "verify-source-conformance", "steps")
  abort "release conformance steps missing" unless steps.is_a?(Array)
  canonicalize = lambda do |value|
    case value
    when Hash
      value.keys.sort.to_h { |key| [key, canonicalize.call(value.fetch(key))] }
    when Array
      value.map { |item| canonicalize.call(item) }
    else
      value
    end
  end
  semantic_digest = Digest::SHA256.hexdigest(JSON.generate(canonicalize.call(steps)))
  abort "release conformance step graph drifted" unless
    semantic_digest == "e7ad1d384362f3706f2cf85fb350b1742989e109cc7c364de11007c98bb80eac"
  matches = steps.select { |step| step.is_a?(Hash) && step["name"] == "Validate rendered observability release with fixed images" }
  abort "rendered observability release step must exist exactly once" unless matches.length == 1
  step = matches.first
  abort "rendered observability release step keys drifted" unless step.keys.sort == %w[env name run shell]
  abort "rendered observability release step must use bash" unless step["shell"] == "bash"
  expected_env = {
    "PROMETHEUS_IMAGE" => "prom/prometheus:v3.13.1@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893",
    "VECTOR_IMAGE" => "timberio/vector:0.57.0-debian@sha256:ed2134fa8f9844c1ca6405260903c2c2c52f94af9e16bc8fa9de9655134e0b39",
    "GRAFANA_IMAGE" => "grafana/grafana:13.1.0@sha256:121a7a9ece6dc10b969f1f96eed64b4f07dfac0d0b8abc070f7cb83bbde86f63",
    "RGS_LOG_SINK_URI" => "https://logs.release.invalid/v1/ingest",
    "RGS_CONTAINER_LOG_GLOB" => "/var/log/containers/rgs-server-*.log",
    "PROMETHEUS_RENDER_PROFILE" => "local-production",
    "RGS_OPERATIONS_TARGET" => "rgs-server:8081",
    "ALERTMANAGER_TARGET" => "alert-proxy:8443",
    "ALERTMANAGER_CA_FILE" => "/run/secrets/alertmanager_root_ca.pem",
    "ALERTMANAGER_SERVER_NAME" => "alert-proxy"
  }
  abort "rendered observability release environment drifted" unless step["env"] == expected_env
  abort "rendered observability release run command drifted" unless
    step["run"] == "./deploy/observability/verify-release-workflow.sh"
' "$release_workflow" || fail 'rendered observability release workflow semantic contract failed'
printf '%s\n' "$conformance_job" | grep -F 'HELM_ARCHIVE_SHA256: 3f43c0aa57243852dd542493a0f54f1396c0bc8ec7296bbb2c01e802010819ce' >/dev/null || fail 'release Helm archive checksum is not fixed'
printf '%s\n' "$conformance_job" | grep -F 'KUBECONFORM_ARCHIVE_SHA256: c31518ddd122663b3f3aa874cfe8178cb0988de944f29c74a0b9260920d115d3' >/dev/null || fail 'release kubeconform archive checksum is not fixed'
deployment_contract_line=$(printf '%s\n' "$conformance_job" | grep -n -F 'run: make verify-deployment-contracts' | head -n 1 | cut -d: -f1)
prometheus_rule_contract_line=$(printf '%s\n' "$conformance_job" | grep -n -F 'run: make verify-cluster-prometheus-rules' | head -n 1 | cut -d: -f1)
observability_release_line=$(printf '%s\n' "$conformance_job" | grep -n -F 'run: ./deploy/observability/verify-release-workflow.sh' | head -n 1 | cut -d: -f1)
npm_install_line=$(printf '%s\n' "$conformance_job" | grep -n -F 'run: npm ci' | head -n 1 | cut -d: -f1)
test -n "$deployment_contract_line" && test -n "$npm_install_line" && test "$deployment_contract_line" -lt "$npm_install_line" || fail 'deployment contracts must run before dependency installation and release builds'
test -n "$prometheus_rule_contract_line" && test "$prometheus_rule_contract_line" -lt "$npm_install_line" || fail 'promtool must parse rendered cluster rules before dependency installation and release builds'
test -n "$observability_release_line" && test "$observability_release_line" -lt "$npm_install_line" || fail 'fixed-image rendered observability validation must run before dependency installation and release builds'
source_verify_line=$(printf '%s\n' "$conformance_job" | grep -n -F 'run: make verify' | head -n 1 | cut -d: -f1)
determinism_line=$(printf '%s\n' "$conformance_job" | grep -n -F 'run: npm run build:determinism-check' | head -n 1 | cut -d: -f1)
test -n "$source_verify_line" && test -n "$determinism_line" && test "$source_verify_line" -lt "$determinism_line" || fail 'frontend determinism check must rebuild the output produced by complete source conformance'
printf '%s\n' "$conformance_job" | grep -F 'docker build --file deploy/Dockerfile --target runtime --tag slots-rgs-runtime:conformance .' >/dev/null || fail 'runtime smoke build is missing'
printf '%s\n' "$conformance_job" | grep -F 'docker build --file deploy/Dockerfile --target migrator --tag slots-rgs-migrator:conformance .' >/dev/null || fail 'migrator smoke build is missing'
printf '%s\n' "$conformance_job" | grep -F 'CLUSTER_RUNTIME_IMAGE: slots-rgs-cluster-runtime:conformance' >/dev/null || fail 'cluster runtime conformance image is not isolated'
printf '%s\n' "$conformance_job" | grep -F 'CLUSTER_MIGRATOR_IMAGE: slots-rgs-cluster-migrator:conformance' >/dev/null || fail 'cluster migrator conformance image is not isolated'
if printf '%s\n' "$conformance_job_code" | grep -E 'release-image\.oci\.tar|release-bundle\.sh finalize' >/dev/null; then
  fail 'dependency-executing conformance job must not create a release candidate bundle'
fi

# B：RGS 候选必须从独立 fresh checkout 构建，绑定真实 Git tree，且不运行宿主 npm/go/make。
# English: B: RGS candidates must be built from a standalone fresh checkout, bound to the real Git tree, and not
# run the host npm/go/make.
printf '%s\n' "$rgs_job" | grep -F -x '  build-rgs:' >/dev/null || fail 'missing isolated build-rgs job'
printf '%s\n' "$rgs_job" | grep -F -x '    needs: verify-source-conformance' >/dev/null || fail 'RGS build must depend on source conformance'
printf '%s\n' "$rgs_job" | grep -F -x '      contents: read' >/dev/null || fail 'RGS build must only read contents'
if printf '%s\n' "$rgs_job_code" | grep -E '^[[:space:]]+(environment|id-token|attestations|artifact-metadata):|\$\{\{ secrets\.|run:[[:space:]]+(npm|go|make)([[:space:]]|$)' >/dev/null; then
  fail 'isolated RGS build must not receive privilege/secrets or run host dependencies'
fi
for required_control in \
  'ref: ${{ github.sha }}' \
  'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"' \
  'source_tree_sha=$(git rev-parse "$GITHUB_SHA^{tree}")' \
  'SOURCE_TREE_SHA=%s' \
  'com.slots.release.source-tree=$SOURCE_TREE_SHA' \
  '--file deploy/cluster-production/Dockerfile.services' \
  'rgs-runtime) target=rgs-runtime' \
  'rgs-migrator) target=rgs-migrator' \
  '--build-arg "OCI_IMAGE_CREATED=$image_created"' \
  '--build-arg "OCI_IMAGE_REVISION=$GITHUB_SHA"' \
  '--build-arg "OCI_IMAGE_SOURCE=$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"' \
  'release_version="${SUPPLY_CHAIN_IMAGE_TAG#v}"' \
  'test "v$release_version" = "$SUPPLY_CHAIN_IMAGE_TAG"' \
  'test "$release_version" = "$(tr -d '\''\n'\'' < VERSION)"' \
  '--build-arg "OCI_IMAGE_VERSION=$release_version"' \
  'scan.sh oci-archive' \
  '--output "type=oci,dest=$SUPPLY_CHAIN_REPORT_DIR/bundle/release-image.oci.tar"' \
  'release-bundle.sh finalize "$SUPPLY_CHAIN_REPORT_DIR/bundle" rgs-unprivileged'
do
  printf '%s\n' "$rgs_job" | grep -F -- "$required_control" >/dev/null || fail "isolated RGS build missing $required_control"
done
if printf '%s\n' "$rgs_job_code" | grep -F -- '--file deploy/Dockerfile' >/dev/null; then
  fail '受保护 RGS 发布不得回退到缺少集群 secret/probe helper 的通用镜像'
fi
printf '%s\n' "$rgs_job" | grep -F "uses: docker/setup-buildx-action@$setup_buildx_sha # v4.2.0" >/dev/null || fail 'RGS builder must use reviewed Buildx'
printf '%s\n' "$rgs_job" | grep -F 'driver-opts: image=moby/buildkit:v0.32.2@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8' >/dev/null || fail 'RGS BuildKit runtime is not digest-pinned'
printf '%s\n' "$rgs_job" | grep -F 'buildkitd-flags: --debug=false' >/dev/null || fail 'RGS BuildKit insecure entitlement defaults must be replaced'
printf '%s\n' "$rgs_job_code" | grep -F -- '--allow-insecure-entitlement' >/dev/null && fail 'BuildKit insecure entitlements are forbidden'

# C：只有 Web 构建能进入独立审批 Environment；它没有发布身份或 Registry 凭据。
# English: C: Only the web build can enter the standalone approval environment; it does not have publishing
# identity or registry credentials.
printf '%s\n' "$web_job" | grep -F -x '    environment: supply-chain-web-approval' >/dev/null || fail 'Web build must use its dedicated approval Environment'
printf '%s\n' "$web_job" | grep -F -x '      contents: read' >/dev/null || fail 'Web approval job must only read contents'
if printf '%s\n' "$web_job_code" | grep -E '^[[:space:]]+(id-token|attestations|artifact-metadata):|SUPPLY_CHAIN_REGISTRY_(USERNAME|PASSWORD)' >/dev/null; then
  fail 'Web approval job must not receive OIDC, attestation or Registry credentials'
fi
web_secret_count=$(printf '%s\n' "$web_job_code" | grep -F -c 'secrets.SUPPLY_CHAIN_WEB_RELEASE_ASSET_APPROVAL' || true)
test "$web_secret_count" -eq 1 || fail 'Web approval secret must be injected into exactly one step'
printf '%s\n' "$web_job" | grep -F "uses: docker/setup-buildx-action@$setup_buildx_sha # v4.2.0" >/dev/null || fail 'Web builder must use reviewed Buildx'
for required_control in \
  'needs: verify-source-conformance' \
  'needs.verify-source-conformance.outputs.source_sha' \
  'ref: ${{ github.sha }}' \
  'source_tree_sha=$(git rev-parse "$GITHUB_SHA^{tree}")' \
  'SOURCE_TREE_SHA=%s' \
  'com.slots.release.source-tree=$SOURCE_TREE_SHA' \
  'release_version="${SUPPLY_CHAIN_IMAGE_TAG#v}"' \
  'test "v$release_version" = "$SUPPLY_CHAIN_IMAGE_TAG"' \
  'test "$release_version" = "$(tr -d '\''\n'\'' < VERSION)"' \
  '--build-arg WEB_RELEASE_VERSION="$release_version"' \
  '--build-arg WEB_RELEASE_REVISION="$GITHUB_SHA"' \
  '--secret "id=release_asset_approval,src=$approval_file"' \
  'approval_sha256=$(sha256sum "$approval_file"' \
  'release-bundle.sh approval-metadata "$approval_file"' \
  'approval_expires_at=%s' \
  'approval_metadata_sha256=%s' \
  'rm -f "$approval_file"' \
  'scan.sh oci-archive' \
  'release-bundle.sh finalize "$SUPPLY_CHAIN_REPORT_DIR/bundle" web-approved'
do
  printf '%s\n' "$web_job" | grep -F -- "$required_control" >/dev/null || fail "Web approval job missing $required_control"
done
printf '%s\n' "$web_job" | grep -F 'driver-opts: image=moby/buildkit:v0.32.2@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8' >/dev/null || fail 'Web BuildKit runtime is not digest-pinned'
printf '%s\n' "$web_job" | grep -F 'buildkitd-flags: --debug=false' >/dev/null || fail 'Web BuildKit insecure entitlement defaults must be replaced'
for browser_conversion_control in \
  '--network=none --read-only --cap-drop=ALL' \
  '--user "$(id -u):$(id -g)"' \
  '--volume "$SUPPLY_CHAIN_REPORT_DIR/bundle:/bundle:ro"' \
  '--volume "$conversion_root:/output"' \
  'docker-archive:/output/release-image.docker.tar:$local_ref' \
  'docker load --input "$conversion_root/release-image.docker.tar"'
do
  printf '%s\n' "$web_job" | grep -F -- "$browser_conversion_control" >/dev/null || \
    fail "Web browser smoke missing isolated OCI conversion control: $browser_conversion_control"
done
if printf '%s\n' "$web_job_code" | grep -F '/var/run/docker.sock' >/dev/null; then
  fail 'Web approval job must not expose the host Docker socket to the conversion container'
fi

# D：独立无源码 job 只读 Actions 元数据，并把 ID/digest 与当前 run、SHA 和唯一名称绑定。
# English: D: Independent sourceless job reads only Actions metadata and binds ID/digest to the current run, SHA
# and unique name.
printf '%s\n' "$artifact_binding_job" | grep -F -x '  bind-release-artifact:' >/dev/null || \
  fail 'missing bind-release-artifact job'
artifact_id_selection='${{ inputs.artifact == '\''web-runtime'\'' && needs.build-approved-web.outputs.artifact_id || needs.build-rgs.outputs.artifact_id }}'
test "$(grep -F -c "$artifact_id_selection" "$release_workflow" || true)" -eq 3 || \
  fail 'builder artifact ID must be selected identically for metadata binding, download and offline verification'
if printf '%s\n' "$artifact_binding_job_code" | \
  grep -E 'actions/checkout@|^[[:space:]]+environment:|id-token:|attestations:|artifact-metadata:|\$\{\{ secrets\.' >/dev/null; then
  fail 'artifact metadata binding job must not checkout or receive Environment/OIDC/secrets'
fi
for artifact_binding_control in \
  'needs.verify-source-conformance.result == '\''success'\''' \
  'needs.build-rgs.result == '\''success'\''' \
  'needs.build-rgs.result == '\''skipped'\''' \
  'needs.build-approved-web.result == '\''success'\''' \
  'needs.build-approved-web.result == '\''skipped'\''' \
  'EXPECTED_ARTIFACT_ID:' \
  'EXPECTED_ARTIFACT_DIGEST:' \
  'Authorization: Bearer $GH_TOKEN' \
  '$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/actions/artifacts/$EXPECTED_ARTIFACT_ID' \
  '.id == $artifact_id and .name == $name and .expired == false and' \
  '.digest == $digest and .workflow_run.id == $run_id and' \
  '.workflow_run.head_sha == $source_sha'
do
  printf '%s\n' "$artifact_binding_job" | grep -F -- "$artifact_binding_control" >/dev/null || \
    fail "artifact metadata binding missing $artifact_binding_control"
done

# E：最终 Environment 是唯一 OIDC/Registry 域；不 checkout、不执行任何源码/依赖/build/scan。
# English: E: The final Environment is the only OIDC/Registry domain; no checkout, no source
# code/dependency/build/scan is executed.
printf '%s\n' "$publish_job" | grep -F -x '    environment: supply-chain-release' >/dev/null || fail 'publish job must use the final release Environment'
for required_permission in '      contents: read' '      id-token: write' '      attestations: write' '      artifact-metadata: write'
do
  printf '%s\n' "$publish_job" | grep -F -x "$required_permission" >/dev/null || fail "publish job missing $required_permission"
done
if printf '%s\n' "$publish_job_code" | grep -E 'actions/checkout@|actions/setup-(go|node)@|arduino/setup-protoc@|docker/setup-buildx-action@|run:[[:space:]]+(npm|go|make)([[:space:]]|$)|docker[[:space:]]+build(x)?[[:space:]]|scan\.sh|release-sign\.sh|SUPPLY_CHAIN_WEB_RELEASE_ASSET_APPROVAL' >/dev/null; then
  fail 'publish/sign job must not checkout, build, test, scan or receive Web approval material'
fi
printf '%s\n' "$publish_job" | grep -F "uses: actions/download-artifact@$download_sha # v8.0.1" >/dev/null || fail 'publish job must use reviewed download-artifact'
for required_control in \
  'needs.verify-source-conformance.result == '\''success'\''' \
  'needs.bind-release-artifact.result == '\''success'\''' \
  'needs.build-rgs.result == '\''success'\''' \
  'needs.build-rgs.result == '\''skipped'\''' \
  'needs.build-approved-web.result == '\''success'\''' \
  'needs.build-approved-web.result == '\''skipped'\''' \
  'artifact-ids: ${{ inputs.artifact == '\''web-runtime'\'' && needs.build-approved-web.outputs.artifact_id || needs.build-rgs.outputs.artifact_id }}' \
  'EXPECTED_SOURCE_TREE_SHA:' \
  'EXPECTED_MANIFEST_SHA256:' \
  'EXPECTED_CHECKSUMS_SHA256:' \
  'EXPECTED_OCI_ARCHIVE_SHA256:' \
  'EXPECTED_SPDX_SHA256:' \
  'EXPECTED_APPROVAL_EXPIRES_AT:' \
  'EXPECTED_APPROVAL_METADATA_SHA256:' \
  'sha256sum --check --strict bundle-checksums.sha256' \
  'OCI archive contains an unsafe path' \
  'Trivy evidence contains forbidden secret plaintext fields' \
  '"$SKOPEO_IMAGE" copy' \
  'oci-archive:/input/release-image.oci.tar' \
  'docker-archive:/out/release-image.docker.tar:$local_ref' \
  'docker load --input "$PUBLISH_WORK_DIR/release-image.docker.tar"' \
  'test "$SUPPLY_CHAIN_REGISTRY" = "$expected_registry"' \
  'test "$SUPPLY_CHAIN_IMAGE_REPOSITORY" = "$expected_registry/$expected_ecr_repository"' \
  'actual_account=$(aws sts get-caller-identity --query Account --output text)' \
  '.imageTagMutability == "IMMUTABLE"' \
  '.encryptionConfiguration.encryptionType == "KMS"' \
  '.scanningConfiguration as $configuration' \
  '$configuration.scanType == "ENHANCED"' \
  '($configuration.rules // []) | length' \
  '.scanFrequency == "CONTINUOUS_SCAN"' \
  'if aws ecr describe-images --repository-name "$repository_name" --image-ids "imageTag=$SUPPLY_CHAIN_IMAGE_TAG" --output json >"$final_tag_probe" 2>"$final_tag_error"; then' \
  'ImageNotFoundException' \
  'unable to prove that the final release tag is absent' \
  'subject-digest: ${{ steps.publish.outputs.digest }}' \
  'sbom-path: ${{ env.BUNDLE_DOWNLOAD_DIR }}/release-image.spdx.json' \
  '"$COSIGN_IMAGE" sign --yes "$image_reference"' \
  '--certificate-identity "$SUPPLY_CHAIN_EXPECTED_CERTIFICATE_IDENTITY"' \
  'if docker manifest inspect "$final_ref" >/dev/null 2>&1; then'
do
  printf '%s\n' "$publish_job" | grep -F -- "$required_control" >/dev/null || fail "publish job missing $required_control"
done
printf '%s\n' "$publish_job" | grep -F "uses: aws-actions/configure-aws-credentials@$configure_aws_sha # v5.1.1" >/dev/null || \
  fail 'publish job must use the reviewed AWS OIDC credential action'
printf '%s\n' "$publish_job" | grep -F "uses: aws-actions/amazon-ecr-login@$ecr_login_sha # v2.1.7" >/dev/null || \
  fail 'publish job must use the reviewed ECR login action'
reject_fixed 'SUPPLY_CHAIN_REGISTRY_USERNAME' "$release_workflow"
reject_fixed 'SUPPLY_CHAIN_REGISTRY_PASSWORD' "$release_workflow"
reject_fixed 'docker/login-action@' "$release_workflow"
test "$(printf '%s\n' "$publish_job" | grep -F -c 'approval has expired immediately before Registry push' || true)" -eq 2 || \
  fail 'both Registry pushes must have an independent approval-expiry failure path'
test "$(printf '%s\n' "$publish_job" | grep -F -c 'timestamp <= Date.now()' || true)" -eq 2 || \
  fail 'both Registry pushes must compare approval expiry with their current clock'
test "$(printf '%s\n' "$publish_job" | grep -F -c 'ASSET_APPROVAL_EXPIRES_AT="$ASSET_APPROVAL_EXPIRES_AT" node -e' || true)" -eq 2 || \
  fail 'both Registry pushes must validate the bundle-bound approval expiry'
push_count=$(printf '%s\n' "$publish_job" | grep -F -c 'docker push "$' || true)
expiry_push_count=$(printf '%s\n' "$publish_job" | awk '
  /^[[:space:]]*require_current_web_approval[[:space:]]*$/ { armed = 1; next }
  armed && /^[[:space:]]*docker push "\$/ { count++; armed = 0; next }
  armed && $0 !~ /^[[:space:]]*(#|$)/ { armed = 0 }
  END { print count + 0 }
')
test "$push_count" -eq 2 && test "$expiry_push_count" -eq 2 || \
  fail 'both candidate and final Registry pushes must be immediately preceded by approval expiry validation'
printf '%s\n' "$publish_job" | grep -F 'SKOPEO_IMAGE: quay.io/skopeo/stable:v1.21.0@sha256:a585e4a3b8a045baa87c7f1b2f940d6d299ebede85ab3f2419d52d2264eefc93' >/dev/null || fail 'offline OCI conversion tool is not digest-pinned'
printf '%s\n' "$publish_job" | grep -F -- '--read-only --network=none' >/dev/null || fail 'offline OCI conversion must be read-only and networkless'
printf '%s\n' "$publish_job" | grep -F 'END { exit bad || NR != 6 }' >/dev/null || \
  fail 'checksum allowlist must retain invalid-line state through awk END'
printf '%s\n' "$publish_job" | grep -F 'rm -rf "$PUBLISH_WORK_DIR" "$BUNDLE_DOWNLOAD_DIR"' >/dev/null || \
  fail 'transient release bytes must be removed before audit evidence upload'
if printf '%s\n' "$publish_job" | grep -F 'path: ${{ env.PUBLISH_WORK_DIR }}' >/dev/null; then
  fail 'privileged audit artifact must not retain release image bytes'
fi
printf '%s\n' "$publish_job" | grep -F -x '          path: ${{ env.PUBLISH_EVIDENCE_DIR }}' >/dev/null || \
  fail 'privileged publish audit upload must be limited to the evidence directory'
test "$(grep -F -c 'if-no-files-found: warn' "$release_workflow" || true)" -eq 0 || \
  fail 'release evidence uploads must fail closed when evidence is absent'

id_token_count=$(grep -F -c '      id-token: write' "$release_workflow" || true)
test "$id_token_count" -eq 1 || fail 'only publish-sign may request a GitHub OIDC token'
release_environment_count=$(grep -F -c '    environment: supply-chain-release' "$release_workflow" || true)
test "$release_environment_count" -eq 1 || fail 'only publish-sign may use the final release Environment'
web_environment_count=$(grep -F -c '    environment: supply-chain-web-approval' "$release_workflow" || true)
test "$web_environment_count" -eq 1 || fail 'Web approval must have one isolated Environment'
reject_fixed 'continue-on-error:' "$release_workflow"
test "$(grep -F -c 'if-no-files-found: error' "$backend_workflow" || true)" -eq 2 || \
  fail 'backend conformance must fail closed when either evidence artifact is absent'
reject_fixed 'if-no-files-found: warn' "$backend_workflow"
for capacity_boundary in \
  '容量压测证据边界' \
  '不等于生产容量认证' \
  '三个已签名 OCI digest' \
  '当前仓库没有压测平台的身份、不可变对象存储或受保护审批 API' \
  '真实商业峰值容量与第三方钱包 SLA 仍属于上线阻断项'
do
  require_fixed "$capacity_boundary" "$backend_release_gates"
done

# 清洁源码扫描必须先于 conformance 依赖；fresh RGS job 必须 checkout→tree→build→scan→bundle。
# English: Clean source code scanning must precede conformance dependencies; fresh RGS job must
# checkout→tree→build→scan→bundle.
source_security_line=$(grep -n -F 'run: ./deploy/supply-chain/scan.sh source "$SUPPLY_CHAIN_REPORT_DIR/source"' "$release_workflow" | head -n 1 | cut -d: -f1)
setup_go_line=$(grep -n -F "uses: actions/setup-go@$setup_go_sha" "$release_workflow" | head -n 1 | cut -d: -f1)
npm_ci_line=$(grep -n -F 'run: npm ci' "$release_workflow" | head -n 1 | cut -d: -f1)
verify_source_line=$(grep -n -F -x '        run: make verify' "$release_workflow" | head -n 1 | cut -d: -f1)
rgs_checkout_line=$(grep -n -F '      - name: Fresh checkout of the exact conformed commit' "$release_workflow" | cut -d: -f1)
rgs_tree_line=$(grep -n -F 'source_tree_sha=$(git rev-parse "$GITHUB_SHA^{tree}")' "$release_workflow" | head -n 1 | cut -d: -f1)
rgs_build_line=$(grep -n -F '      - name: Build exact RGS result from the fresh context as an OCI archive' "$release_workflow" | cut -d: -f1)
rgs_scan_line=$(grep -n -F '      - name: Scan the exact RGS OCI archive and generate dual-format image SBOM' "$release_workflow" | cut -d: -f1)
rgs_bundle_line=$(grep -n -F 'release-bundle.sh finalize "$SUPPLY_CHAIN_REPORT_DIR/bundle" rgs-unprivileged' "$release_workflow" | cut -d: -f1)
download_line=$(grep -n -F "uses: actions/download-artifact@$download_sha" "$release_workflow" | cut -d: -f1)
offline_verify_line=$(grep -n -F '      - name: Re-verify artifact channel, source identity, target, configuration and every byte' "$release_workflow" | cut -d: -f1)
conversion_line=$(grep -n -F '"$SKOPEO_IMAGE" copy' "$release_workflow" | tail -n 1 | cut -d: -f1)
aws_identity_line=$(grep -n -F "uses: aws-actions/configure-aws-credentials@$configure_aws_sha" "$release_workflow" | cut -d: -f1)
aws_account_line=$(grep -n -F 'actual_account=$(aws sts get-caller-identity --query Account --output text)' "$release_workflow" | cut -d: -f1)
final_tag_preflight_line=$(grep -n -F 'if aws ecr describe-images --repository-name "$repository_name" --image-ids "imageTag=$SUPPLY_CHAIN_IMAGE_TAG" --output json >"$final_tag_probe" 2>"$final_tag_error"; then' "$release_workflow" | cut -d: -f1)
login_line=$(grep -n -F "uses: aws-actions/amazon-ecr-login@$ecr_login_sha" "$release_workflow" | cut -d: -f1)
load_line=$(grep -n -F 'docker load --input "$PUBLISH_WORK_DIR/release-image.docker.tar"' "$release_workflow" | cut -d: -f1)
candidate_push_line=$(grep -n -F 'docker push "$candidate_ref"' "$release_workflow" | cut -d: -f1)
attest_line=$(grep -n -F "uses: actions/attest@$attest_sha # v4.2.2" "$release_workflow" | head -n 1 | cut -d: -f1)
sign_line=$(grep -n -F '"$COSIGN_IMAGE" sign --yes "$image_reference"' "$release_workflow" | cut -d: -f1)
promote_line=$(grep -n -F 'docker push "$final_ref"' "$release_workflow" | cut -d: -f1)
test "$source_security_line" -lt "$setup_go_line" && test "$source_security_line" -lt "$npm_ci_line" && \
  test "$npm_ci_line" -lt "$verify_source_line" || fail 'clean source scan must precede conformance dependencies'
test "$rgs_checkout_line" -lt "$rgs_tree_line" && test "$rgs_tree_line" -lt "$rgs_build_line" && \
  test "$rgs_build_line" -lt "$rgs_scan_line" && test "$rgs_scan_line" -lt "$rgs_bundle_line" || \
  fail 'isolated RGS context/build/scan/bundle order was weakened'
test "$download_line" -lt "$offline_verify_line" && test "$offline_verify_line" -le "$conversion_line" && \
  test "$conversion_line" -lt "$aws_identity_line" && test "$aws_identity_line" -lt "$aws_account_line" && \
  test "$aws_account_line" -lt "$final_tag_preflight_line" && \
  test "$final_tag_preflight_line" -lt "$login_line" && \
  test "$login_line" -lt "$load_line" && test "$load_line" -lt "$candidate_push_line" && \
  test "$candidate_push_line" -lt "$attest_line" && \
  test "$attest_line" -lt "$sign_line" && test "$sign_line" -lt "$promote_line" || \
  fail 'publish/sign stage order was weakened'

attest_count=$(grep -F -c -- "uses: actions/attest@$attest_sha # v4.2.2" "$release_workflow" || true)
test "$attest_count" -eq 2 || fail 'release workflow must generate provenance and SBOM attestations'

# 仓库治理自动化同样属于供应链边界：依赖更新、PR 差异审查和源码分析必须使用固定
# Action、最小权限和明确目录，不能依赖 GitHub UI 中不可审计的临时设置。
# English: Repository-governance automation is also part of the supply-chain boundary: dependency updates, PR
# diff review, and source analysis must use pinned Actions, least privilege, and explicit directories rather
# than unauditable temporary GitHub UI settings.
ruby -ryaml -e '
  config = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
  abort "Dependabot schema version drifted" unless config["version"] == 2
  updates = config.fetch("updates")
  expected = [
    ["github-actions", ["/"]],
    ["gomod", ["/slots-game/server"]],
    ["npm", ["/slots-game/web"]],
    ["terraform", [
      "/slots-game/infra/terraform/environments/dev",
      "/slots-game/infra/terraform/environments/staging",
      "/slots-game/infra/terraform/environments/prod-primary",
      "/slots-game/infra/terraform/environments/prod-dr",
      "/slots-game/infra/terraform/stacks/environment",
      "/slots-game/infra/terraform/stacks/application-platform",
    ]],
  ]
  actual = updates.map do |entry|
    locations = entry.key?("directory") ? [entry["directory"]] : entry["directories"]
    [entry["package-ecosystem"], locations]
  end
  abort "Dependabot ecosystems or directories drifted" unless actual == expected
  abort "Dependabot schedules must remain weekly in Asia/Shanghai" unless updates.all? do |entry|
    entry.dig("schedule", "interval") == "weekly" &&
      entry.dig("schedule", "timezone") == "Asia/Shanghai"
  end
' "$dependabot_config" || fail 'Dependabot configuration semantic contract failed'

codeql_sha='db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28'
dependency_review_sha='a1d282b36b6f3519aa1f3fc636f609c47dddb294'
require_line "        uses: actions/checkout@$checkout_sha # v7.0.1" "$codeql_workflow"
require_line "        uses: actions/setup-go@$setup_go_sha # v5.5.0" "$codeql_workflow"
test "$(grep -F -c -- "uses: github/codeql-action/init@$codeql_sha # v4.37.8" "$codeql_workflow" || true)" -eq 1 ||
  fail 'CodeQL init must use the reviewed immutable action exactly once'
test "$(grep -F -c -- "uses: github/codeql-action/analyze@$codeql_sha # v4.37.8" "$codeql_workflow" || true)" -eq 1 ||
  fail 'CodeQL analyze must use the reviewed immutable action exactly once'
require_line '        id: analyze' "$codeql_workflow"
require_line '          output: ${{ runner.temp }}/codeql-${{ matrix.language }}' "$codeql_workflow"
require_line '          wait-for-processing: true' "$codeql_workflow"
test "$(grep -F -c -- 'node slots-game/deploy/supply-chain/verify-codeql-sarif.mjs' "$codeql_workflow" || true)" -eq 1 ||
  fail 'CodeQL High/Critical SARIF verifier must run exactly once'
require_line '          "${{ steps.analyze.outputs.sarif-output }}"' "$codeql_workflow"
require_line '          7.0' "$codeql_workflow"
test "$(grep -F -c -- 'node --test deploy/supply-chain/verify-codeql-sarif.test.mjs' "$makefile" || true)" -eq 1 ||
  fail 'CodeQL SARIF verifier tests must run exactly once in the supply-chain target'
require_line "        uses: actions/dependency-review-action@$dependency_review_sha # v5.0.0" "$dependency_review_workflow"
require_line '          fail-on-severity: high' "$dependency_review_workflow"
require_line '          vulnerability-check: true' "$dependency_review_workflow"
require_line '          license-check: true' "$dependency_review_workflow"
require_line '          comment-summary-in-pr: never' "$dependency_review_workflow"
reject_fixed 'pull_request_target:' "$codeql_workflow"
reject_fixed 'pull_request_target:' "$dependency_review_workflow"
ruby -ryaml -e '
  workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
  abort "CodeQL top-level permissions drifted" unless workflow["permissions"] == { "contents" => "read" }
  job = workflow.dig("jobs", "analyze")
  abort "CodeQL analyze job missing" unless job.is_a?(Hash)
  abort "CodeQL permissions drifted" unless
    job["permissions"] == { "contents" => "read", "security-events" => "write" }
  include_rows = job.dig("strategy", "matrix", "include")
  expected = [
    { "language" => "go", "build-mode" => "manual" },
    { "language" => "javascript-typescript", "build-mode" => "none" },
  ]
  abort "CodeQL language/build matrix drifted" unless include_rows == expected
  steps = job["steps"]
  abort "CodeQL steps missing" unless steps.is_a?(Array)
  analyze = steps.find { |step| step["name"] == "Analyze and upload CodeQL results" }
  abort "CodeQL analyze output contract drifted" unless
    analyze.is_a?(Hash) && analyze["id"] == "analyze" &&
    analyze.dig("with", "category") == "/language:${{ matrix.language }}" &&
    analyze.dig("with", "output") == "${{ runner.temp }}/codeql-${{ matrix.language }}" &&
    analyze.dig("with", "wait-for-processing") == true
  gate = steps.find { |step| step["name"] == "Reject High or Critical CodeQL results" }
  expected_gate = %q(node slots-game/deploy/supply-chain/verify-codeql-sarif.mjs "${{ steps.analyze.outputs.sarif-output }}" 7.0)
  abort "CodeQL High/Critical gate drifted" unless gate.is_a?(Hash) && gate["run"] == expected_gate
' "$codeql_workflow" || fail 'CodeQL workflow semantic contract failed'
ruby -ryaml -e '
  workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
  expected = { "contents" => "read" }
  abort "dependency review top-level permissions drifted" unless workflow["permissions"] == expected
  job = workflow.dig("jobs", "dependency-review")
  abort "dependency review job missing" unless job.is_a?(Hash)
  abort "dependency review job permissions drifted" unless job["permissions"] == expected
' "$dependency_review_workflow" || fail 'dependency review workflow semantic contract failed'

require_line 'blank_issues_enabled: false' "$issue_config"
require_fixed 'https://github.com/qqq723000-hash/slots-game/security/advisories/new' "$issue_config"
require_fixed 'https://github.com/qqq723000-hash/slots-game/blob/main/SUPPORT.md' "$issue_config"
require_fixed '不要提交密码、令牌、私钥、DSN、玩家/账户数据、生产日志、发布审批、原始抓包或漏洞细节。' "$bug_report_template"
require_fixed '我没有对未经书面授权的生产或第三方端点执行压力、穿透或 DDoS 测试。' "$bug_report_template"
require_fixed '安全问题、真实凭据和生产事故信息不得使用公开 Issue' "$change_proposal_template"
require_fixed '不承诺响应时间、修复时间、7×24 值守、' "$support_doc"
require_fixed '生产事故处置、SLA、SLO 或赔偿责任' "$support_doc"
require_fixed 'security/advisories/new' "$support_doc"

# CI 失败证据只能上传审查过的文件名，拒绝目录通配符把日志、抓包或临时秘密一起带走。
# English: CI failure evidence can only upload reviewed file names, and directory wildcards are rejected to take
# away logs, packet captures or temporary secrets.
for approved_backend_artifact in \
  'slots-game/.artifacts/postgres-conformance/postgres-conformance.jsonl' \
  'slots-game/.artifacts/postgres-conformance/postgres-migration.jsonl' \
  'slots-game/.artifacts/runtime-smoke/migrator-up.json' \
  'slots-game/.artifacts/runtime-smoke/migrator-verify.json' \
  'slots-game/.artifacts/runtime-smoke/readyz.json' \
  'slots-game/.artifacts/runtime-smoke/metrics.prom' \
  'slots-game/.artifacts/runtime-smoke/result.json' \
  'slots-game/.artifacts/runtime-smoke/migrator-production-up.json' \
  'slots-game/.artifacts/runtime-smoke/migrator-production-verify.json' \
  'slots-game/.artifacts/runtime-smoke/readyz-production-ci-only.json' \
  'slots-game/.artifacts/runtime-smoke/metrics-production-ci-only.prom' \
  'slots-game/.artifacts/runtime-smoke/result-production-ci-only.json'
do
  require_line "            $approved_backend_artifact" "$backend_workflow"
  test "$(grep -F -x -c -- "            $approved_backend_artifact" "$backend_workflow" || true)" -eq 1 ||
    fail "backend evidence allowlist must contain $approved_backend_artifact exactly once"
done
reject_fixed 'slots-game/.artifacts/postgres-conformance/*' "$backend_workflow"
reject_fixed 'slots-game/.artifacts/runtime-smoke/*' "$backend_workflow"
primal_web_title_line=$(printf '%s\134' 'LABEL org.opencontainers.image.title="primal-rampage-web" ')
require_line "$primal_web_title_line" "$web_dockerfile"
test "$(grep -F -c -- 'org.opencontainers.image.licenses="NOASSERTION"' "$web_dockerfile")" -eq 3 ||
  fail 'all Web image targets must override inherited upstream license metadata'
require_line '      org.opencontainers.image.licenses="NOASSERTION" \' "$local_web_dockerfile"
require_line '      org.opencontainers.image.licenses="NOASSERTION" \' "$local_nginx_proxy_dockerfile"

# Nginx 基础镜像的默认页面不是发布 payload。两个可服务目标和本机候选都必须先整体
# 重建静态根，不能使用会漏掉 dotfile 的通配符删除，再复制 release-manifest 约束的 dist。
# English: The default page of the Nginx base image is not to publish the payload. Both the serviceable target
# and the native candidate must first be Rebuild the static root, do not use wildcard deletion that will miss
# the dotfile, and then copy the dist constrained by release-manifest.
for served_stage_name in static-conformance runtime; do
  served_stage="$(docker_stage_source "$served_stage_name" "$web_dockerfile")"
  test "$(printf '%s\n' "$served_stage" | grep -Fxc 'RUN --network=none rm -rf /usr/share/nginx/html && \' || true)" -eq 1 ||
    fail "$served_stage_name must completely reset the inherited Web root"
  test "$(printf '%s\n' "$served_stage" | grep -Fxc '    install -d -o 0 -g 0 -m 0755 /usr/share/nginx/html' || true)" -eq 1 ||
    fail "$served_stage_name must recreate the Web root with fixed metadata"
  served_reset_line=$(printf '%s\n' "$served_stage" | grep -nF -x 'RUN --network=none rm -rf /usr/share/nginx/html && \' | cut -d: -f1)
  served_copy_line=$(printf '%s\n' "$served_stage" | grep -nE '^COPY .* /usr/share/nginx/html/$' | cut -d: -f1)
  test -n "$served_reset_line" && test -n "$served_copy_line" \
    && test "$served_reset_line" -lt "$served_copy_line" ||
    fail "$served_stage_name must reset the inherited Web root before copying dist"
done
test "$(grep -Fxc 'RUN --network=none rm -rf /usr/share/nginx/html && \' "$local_web_dockerfile" || true)" -eq 1 ||
  fail 'local Web candidate must completely reset the inherited Web root'
test "$(grep -Fxc '    install -d -o 0 -g 0 -m 0755 /usr/share/nginx/html' "$local_web_dockerfile" || true)" -eq 1 ||
  fail 'local Web candidate must recreate the Web root with fixed metadata'
local_reset_line=$(grep -nF -x 'RUN --network=none rm -rf /usr/share/nginx/html && \' "$local_web_dockerfile" | cut -d: -f1)
local_copy_line=$(grep -nF -x 'COPY --chown=101:101 web/dist/ /usr/share/nginx/html/' "$local_web_dockerfile" | cut -d: -f1)
test -n "$local_reset_line" && test -n "$local_copy_line" \
  && test "$local_reset_line" -lt "$local_copy_line" ||
  fail 'local Web candidate must reset the inherited Web root before copying dist'

# 真实候选回归自身也属于供应链门禁：固定上游摘要、按 BuildKit 返回的不可变 ID
# 提取、全量清单复核和只删除本次随机 tag 的所有权边界均不得空实现。
# English: True candidate returns are themselves supply chain gatekeepers: fixed upstream digest, immutable ID
# returned by BuildKit Extraction, full inventory review, and ownership boundaries that only delete this random
# tag must not be implemented empty.
test -x "$local_web_payload_test" || fail 'local Web payload behavior gate must be executable'
sh -n "$local_web_payload_test" || fail 'local Web payload behavior gate has invalid shell syntax'
for payload_test_line in \
  'set -eu' \
  "base_image='nginxinc/nginx-unprivileged:1.30.4-alpine3.24-slim@sha256:bcf91d2c73ab64fa1c4ac7fbac5ac523057c8af7d553ab9251c7aef38c260979'" \
  'docker image inspect "$base_image" >/dev/null 2>&1 || {' \
  'candidate_image="slots-local-web-payload-contract:test-${test_root##*.}-$$"' \
  '  if [ "$candidate_image_tag_owned" = true ]; then' \
  '    if [ "$current_tag_id" = "$candidate_image_id" ]; then' \
  '      docker image rm "$candidate_image" >/dev/null 2>&1 || true' \
  'node "$static_verifier" "$context_root/web/dist" >/dev/null' \
  'docker cp "$base_container_id:/usr/share/nginx/html/50x.html" "$test_root/base-50x.html" >/dev/null' \
  'test -s "$test_root/base-50x.html"' \
  'docker image inspect "$candidate_image" >/dev/null 2>&1 && {' \
  'DOCKER_BUILDKIT=1 docker build --pull=false \' \
  '  --iidfile "$candidate_image_iidfile" \' \
  '  --tag "$candidate_image" \' \
  'if (!/^sha256:[0-9a-f]{64}\n?$/u.test(value)) process.exit(1);' \
  'tag_image_id=$(docker image inspect --format '\''{{.Id}}'\'' "$candidate_image")' \
  'test "$tag_image_id" = "$candidate_image_id" || {' \
  'candidate_image_tag_owned=true' \
  'candidate_container_id=$(docker create "$candidate_image_id")' \
  'docker cp "$candidate_container_id:/usr/share/nginx/html/." "$candidate_static_root" >/dev/null' \
  'test ! -e "$candidate_static_root/50x.html" || {' \
  'node "$static_verifier" "$candidate_static_root" >/dev/null'
do
  require_line "$payload_test_line" "$local_web_payload_test"
done
reject_fixed 'docker create "$candidate_image")' "$local_web_payload_test"
reject_fixed 'docker image rm "$candidate_image_id"' "$local_web_payload_test"
reject_fixed 'docker pull' "$local_web_payload_test"
if grep -E '^[[:space:]]*exit[[:space:]]+0([[:space:]]|$)' "$local_web_payload_test" >/dev/null; then
  fail 'local Web payload behavior gate contains an unconditional successful exit'
fi
test "$(grep -Fxc 'node "$static_verifier" "$context_root/web/dist" >/dev/null' "$local_web_payload_test" || true)" -eq 1 ||
  fail 'local Web payload behavior gate must verify the host fixture exactly once'
test "$(grep -Fxc 'node "$static_verifier" "$candidate_static_root" >/dev/null' "$local_web_payload_test" || true)" -eq 1 ||
  fail 'local Web payload behavior gate must verify the extracted candidate exactly once'
payload_host_verify_line=$(grep -nF -x 'node "$static_verifier" "$context_root/web/dist" >/dev/null' "$local_web_payload_test" | cut -d: -f1)
payload_base_copy_line=$(grep -nF -x 'docker cp "$base_container_id:/usr/share/nginx/html/50x.html" "$test_root/base-50x.html" >/dev/null' "$local_web_payload_test" | cut -d: -f1)
payload_tag_precheck_line=$(grep -nF -x 'docker image inspect "$candidate_image" >/dev/null 2>&1 && {' "$local_web_payload_test" | cut -d: -f1)
payload_build_line=$(grep -nF -x 'DOCKER_BUILDKIT=1 docker build --pull=false \' "$local_web_payload_test" | cut -d: -f1)
payload_id_line=$(grep -nF -x 'candidate_image_id=$(node -e '\''' "$local_web_payload_test" | cut -d: -f1)
payload_tag_id_line=$(grep -nF -x 'tag_image_id=$(docker image inspect --format '\''{{.Id}}'\'' "$candidate_image")' "$local_web_payload_test" | cut -d: -f1)
payload_tag_match_line=$(grep -nF -x 'test "$tag_image_id" = "$candidate_image_id" || {' "$local_web_payload_test" | cut -d: -f1)
payload_owned_line=$(grep -nF -x 'candidate_image_tag_owned=true' "$local_web_payload_test" | cut -d: -f1)
payload_create_line=$(grep -nF -x 'candidate_container_id=$(docker create "$candidate_image_id")' "$local_web_payload_test" | cut -d: -f1)
payload_copy_line=$(grep -nF -x 'docker cp "$candidate_container_id:/usr/share/nginx/html/." "$candidate_static_root" >/dev/null' "$local_web_payload_test" | cut -d: -f1)
payload_absence_line=$(grep -nF -x 'test ! -e "$candidate_static_root/50x.html" || {' "$local_web_payload_test" | cut -d: -f1)
payload_candidate_verify_line=$(grep -nF -x 'node "$static_verifier" "$candidate_static_root" >/dev/null' "$local_web_payload_test" | cut -d: -f1)
test "$payload_host_verify_line" -lt "$payload_base_copy_line" \
  && test "$payload_base_copy_line" -lt "$payload_tag_precheck_line" \
  && test "$payload_tag_precheck_line" -lt "$payload_build_line" \
  && test "$payload_build_line" -lt "$payload_id_line" \
  && test "$payload_id_line" -lt "$payload_tag_id_line" \
  && test "$payload_tag_id_line" -lt "$payload_tag_match_line" \
  && test "$payload_tag_match_line" -lt "$payload_owned_line" \
  && test "$payload_owned_line" -lt "$payload_create_line" \
  && test "$payload_create_line" -lt "$payload_copy_line" \
  && test "$payload_copy_line" -lt "$payload_absence_line" \
  && test "$payload_absence_line" -lt "$payload_candidate_verify_line" ||
  fail 'local Web payload behavior gate lost its build, immutable extraction, and verification order'

# 两个发布 Environment 的真实审批/Secret 归属无法由仓库创建，运维文档必须明确列为上线阻断。
# English: The real approval/secret ownership of the two release Environments cannot be created by the
# warehouse, and the operations documents must be clearly listed as online blocking.
require_fixed '## 版本与仓库治理门禁' "$readme"
require_fixed '`verify-release-version.mjs --formal`' "$readme"
require_fixed '六个带锁文件的' "$readme"
require_fixed '### GitHub 托管侧必需设置' "$readme"
require_fixed 'Private vulnerability reporting' "$readme"
require_fixed '启用不可变 Releases' "$readme"
require_fixed '`all_external_contributors`' "$readme"
require_fixed '防自审' "$readme"
require_fixed '通过 API 回读留证' "$readme"
require_fixed '`supply-chain-web-approval`' "$readme"
require_fixed '`supply-chain-release`' "$readme"
require_fixed '启用 required reviewers' "$readme"
require_fixed 'deployment branches/tags policy' "$readme"
require_fixed '`SUPPLY_CHAIN_WEB_RELEASE_ASSET_APPROVAL`' "$readme"
require_fixed '`AWS_RELEASE_ROLE_ARN`' "$readme"
require_fixed '`AWS_ACCOUNT_ID`' "$readme"
require_fixed '`AWS_REGION`' "$readme"
require_fixed 'GitHub OIDC' "$readme"
require_fixed '不得保存长期 AWS access key' "$readme"
for documented_job in '`verify-source-conformance`' '`build-rgs`' '`build-approved-web`' \
  '`bind-release-artifact`' '`publish-sign`'
do
  require_fixed "$documented_job" "$readme"
done
require_fixed '固定 digest、`--network=none`、无 OIDC env/Registry/Docker socket 的 Skopeo' "$readme"

# 仓库中的所有 Action（不限于本工作流）都必须是完整 40 位 SHA。
# English: All actions in the repository (not limited to this workflow) must be the full 40-bit SHA.
invalid_actions=$(grep -RE '^[[:space:]]*uses:[[:space:]]+' "$workflows_root" | grep -Ev '@[0-9a-f]{40}([[:space:]]|$)' || true)
test -z "$invalid_actions" || fail "workflow contains a mutable or malformed action reference: $invalid_actions"
reject_fixed 'pull_request_target:' "$source_workflow"
reject_fixed 'pull_request_target:' "$release_workflow"

make_tab=$(printf '\t')
awk '$1 == ".PHONY:" { for (field = 2; field <= NF; field += 1) if ($field == "verify-demo-media") found = 1 } END { exit(found ? 0 : 1) }' "$makefile" ||
  fail 'verify-demo-media must remain phony so a same-named file cannot bypass it'
require_line 'verify-supply-chain-contract: verify-hardening-checklist verify-hardening-stability-contract verify-personal-project-docs verify-demo-media' "$makefile"
require_line "${make_tab}node --test deploy/supply-chain/verify-release-version.test.mjs" "$makefile"
require_line "${make_tab}node deploy/supply-chain/verify-release-version.mjs" "$makefile"
require_line 'verify-hardening-checklist:' "$makefile"
require_line "${make_tab}node --test scripts/verify-hardening-checklist.test.mjs" "$makefile"
require_line "${make_tab}node scripts/verify-hardening-checklist.mjs" "$makefile"
require_line 'verify-personal-project-docs:' "$makefile"
require_line "${make_tab}node --test scripts/verify-personal-project-docs.test.mjs" "$makefile"
require_line "${make_tab}node scripts/verify-personal-project-docs.mjs" "$makefile"
require_line 'verify-demo-media:' "$makefile"
require_line "${make_tab}node --test scripts/verify-demo-media.test.mjs" "$makefile"
require_line "${make_tab}node scripts/verify-demo-media.mjs" "$makefile"
awk -v target='verify-demo-media:' \
  -v first="${make_tab}node --test scripts/verify-demo-media.test.mjs" \
  -v second="${make_tab}node scripts/verify-demo-media.mjs" '
  $0 == target {
    targets += 1
    if ((getline first_line) <= 0 || (getline second_line) <= 0) next
    if (first_line == first && second_line == second) valid += 1
  }
  END { exit(targets == 1 && valid == 1 ? 0 : 1) }
' "$makefile" || fail 'verify-demo-media target must own both reviewed recipes in order'
require_line "${make_tab}./deploy/supply-chain/verify-contract.sh" "$makefile"
require_line "${make_tab}./deploy/supply-chain/test-contract.sh" "$makefile"

# `make verify` 的传递闭包是发布源码门禁的一部分；移除全量测试或任一后端检查均拒绝。
# English: The transitive closure of `make verify` is part of the gated release of source code; removing full
# testing or rejecting any backend checks.
require_line 'verify: verify-supply-chain-contract verify-backend-licenses verify-chinese-comments verify-personal-project-docs verify-demo-media verify-hardening-checklist verify-hardening-stability-contract test test-race vet build' "$makefile"
require_line "${make_tab}cd server && go test ./..." "$makefile"
require_line "${make_tab}cd web && npm test -- --run --fileParallelism=false" "$makefile"
require_line "${make_tab}cd server && go test -race ./..." "$makefile"
require_line "${make_tab}cd server && go vet ./..." "$makefile"
require_line "${make_tab}cd server && go build ./..." "$makefile"
require_line 'BROWSER_SMOKE_ENV := VITE_RGS_BASE_URL=https://rgs.ci.invalid VITE_RGS_BET_OPTIONS_MINOR=100,200,500 VITE_RGS_DEFAULT_BET_MINOR=200 VITE_RGS_HOST_ORIGIN=https://operator.ci.invalid' "$makefile"
require_line "${make_tab}cd web && \$(BROWSER_SMOKE_ENV) npm run build" "$makefile"
require_line '    "build": "tsc --noEmit && vite build && npm run licenses:check-artifacts && node scripts/finalize-production-assets.mjs && npm run build:browser-preflight-check && node scripts/verify-production-javascript-bundles.mjs",' "$web_package_json"
require_line '    "build:browser-preflight-check": "node scripts/verify-browser-preflight-build.mjs",' "$web_package_json"
require_fixed '"browser-preflight.js",' "$repository_root/web/scripts/finalize-production-assets.mjs"
ruby -rjson -e '
  scripts = JSON.parse(File.read(ARGV.fetch(0))).fetch("scripts")
  forbidden = %w[
    postbuild
    prebuild:demo
    postbuild:demo
    predemo:approval-check
    postdemo:approval-check
  ]
  present = forbidden.select { |name| scripts.key?(name) }
  abort "Web release npm lifecycle hooks are forbidden: #{present.join(", ")}" unless present.empty?
' "$web_package_json" || fail 'Web release npm lifecycle hook contract failed'

test_target=$(awk '/^test:$/ { inside = 1; next } inside && /^[A-Za-z0-9_.-]+:/ { exit } inside { print }' "$makefile")
race_target=$(awk '/^test-race:$/ { inside = 1; next } inside && /^[A-Za-z0-9_.-]+:/ { exit } inside { print }' "$makefile")
vet_target=$(awk '/^vet:$/ { inside = 1; next } inside && /^[A-Za-z0-9_.-]+:/ { exit } inside { print }' "$makefile")
build_target=$(awk '/^build:$/ { inside = 1; next } inside && /^[A-Za-z0-9_.-]+:/ { exit } inside { print }' "$makefile")
printf '%s\n' "$test_target" | grep -F -x "${make_tab}cd server && go test ./..." >/dev/null || fail 'Go full test target was weakened'
printf '%s\n' "$test_target" | grep -F -x "${make_tab}cd web && npm test -- --run --fileParallelism=false" >/dev/null || fail 'frontend full test target was weakened'
printf '%s\n' "$race_target" | grep -F -x "${make_tab}cd server && go test -race ./..." >/dev/null || fail 'race target was weakened'
printf '%s\n' "$vet_target" | grep -F -x "${make_tab}cd server && go vet ./..." >/dev/null || fail 'vet target was weakened'
printf '%s\n' "$build_target" | grep -F -x "${make_tab}cd server && go build ./..." >/dev/null || fail 'Go build target was weakened'
printf '%s\n' "$build_target" | grep -F -x "${make_tab}cd web && \$(BROWSER_SMOKE_ENV) npm run build" >/dev/null || fail 'frontend configured build/type target was weakened'

printf '%s\n' 'supply-chain security contract: ok'
