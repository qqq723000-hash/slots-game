#!/bin/sh
# shellcheck disable=SC2016

# 在临时仓库副本中主动削弱每个关键控制，证明静态门禁会失败；不需要 Docker daemon。
# SC2016 仅因测试必须替换夹具中的字面量 `$` 而关闭。
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_dir/../.." && pwd)
workspace_root=$(CDPATH='' cd -- "$repository_root/.." && pwd)
verifier="$script_dir/verify-contract.sh"
trivy_asset_verifier="$script_dir/verify-trivy-assets.sh"
trivy_report_sanitizer="$script_dir/sanitize-trivy-report.mjs"
release_bundle="$script_dir/release-bundle.sh"

if [ -d "$repository_root/.github/workflows" ]; then
  workflows_root="$repository_root/.github/workflows"
else
  workflows_root="$workspace_root/.github/workflows"
fi

fail() {
  printf '%s\n' "supply-chain contract tests: $*" >&2
  exit 1
}

test_root=$(mktemp -d "${TMPDIR:-/tmp}/slots-supply-chain-contract.XXXXXX")
trap 'rm -rf "$test_root"' EXIT HUP INT TERM
fixture="$test_root/repository"

reset_fixture() {
  rm -rf "$fixture"
  mkdir -p "$fixture/deploy/cluster-production" "$fixture/.github" "$fixture/web"
  cp "$repository_root/Makefile" "$fixture/Makefile"
  cp "$repository_root/web/package.json" "$fixture/web/package.json"
  cp -R "$repository_root/deploy/supply-chain" "$fixture/deploy/supply-chain"
  cp "$repository_root/deploy/cluster-production/Dockerfile.services" "$fixture/deploy/cluster-production/Dockerfile.services"
  cp "$repository_root/deploy/cluster-production/verify-kubeconform.sh" "$fixture/deploy/cluster-production/verify-kubeconform.sh"
  cp "$repository_root/deploy/cluster-production/verify-image-runtime-contract.sh" "$fixture/deploy/cluster-production/verify-image-runtime-contract.sh"
  cp "$repository_root/deploy/cluster-production/verify-prometheus-rule-contract.sh" "$fixture/deploy/cluster-production/verify-prometheus-rule-contract.sh"
  cp -R "$workflows_root" "$fixture/.github/workflows"
}

replace_once() {
  old=$1
  new=$2
  file=$3
  grep -F -- "$old" "$file" >/dev/null || fail "test fixture is missing '$old'"
  awk -v old="$old" -v new="$new" '
    !done && index($0, old) {
      prefix = substr($0, 1, index($0, old) - 1)
      suffix = substr($0, index($0, old) + length(old))
      print prefix new suffix
      done = 1
      next
    }
    { print }
  ' "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
}

insert_job_permission() {
  job_name=$1
  permission=$2
  file=$3
  awk -v job="  $job_name:" -v permission="$permission" '
    $0 == job { inside = 1 }
    inside && !done && $0 == "      contents: read" {
      print
      print permission
      done = 1
      next
    }
    inside && /^  [A-Za-z0-9_-]+:$/ && $0 != job { inside = 0 }
    { print }
    END { if (!done) exit 1 }
  ' "$file" > "$file.tmp" || fail "test fixture could not modify $job_name permissions"
  mv "$file.tmp" "$file"
}

expect_rejected() {
  description=$1
  if "$verifier" --root "$fixture" >/dev/null 2>&1; then
    fail "weakened fixture unexpectedly passed: $description"
  fi
}

reset_fixture
"$verifier" --root "$fixture" >/dev/null || fail 'baseline fixture failed'

# 用最小本地资产夹具证明 checks bundle 缺失时会失败关闭；无需 Docker 或网络。
trivy_asset_root="$test_root/trivy-assets"
prepare_trivy_asset_fixture() {
  rm -rf "$trivy_asset_root"
  mkdir -p \
    "$trivy_asset_root/cache/db" \
    "$trivy_asset_root/cache/policy/content/kubernetes" \
    "$trivy_asset_root/evidence"
  printf '%s\n' '{"Version":2,"DownloadedAt":"2026-08-16T00:00:00Z"}' > \
    "$trivy_asset_root/cache/db/metadata.json"
  printf '%s\n' 'fixture-db' > "$trivy_asset_root/cache/db/trivy.db"
  printf '%s\n' \
    '{"Digest":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","DownloadedAt":"2026-08-16T00:00:00Z","MajorVersion":2}' > \
    "$trivy_asset_root/cache/policy/metadata.json"
  policy_number=1
  while test "$policy_number" -le 100
  do
    printf 'package supply_chain_canary_%s\n' "$policy_number" > \
      "$trivy_asset_root/cache/policy/content/kubernetes/check-$policy_number.rego"
    policy_number=$((policy_number + 1))
  done
  printf '%s\n' '{"Results":[{"Misconfigurations":[{"ID":"KSV017"}]}]}' > \
    "$trivy_asset_root/evidence/trivy-iac-canary.json"
}

prepare_trivy_asset_fixture
"$trivy_asset_verifier" "$trivy_asset_root/cache" "$trivy_asset_root/evidence" >/dev/null || \
  fail 'valid Trivy DB/checks fixture was rejected'
rm -rf "$trivy_asset_root/cache/policy/content"
if "$trivy_asset_verifier" "$trivy_asset_root/cache" "$trivy_asset_root/evidence" >/dev/null 2>&1; then
  fail 'missing Trivy checks bundle content was accepted'
fi

# 用无敏感值夹具证明 always-upload 前会删除 Trivy secret 的 Code/Match，同时保留规则证据。
command -v node >/dev/null 2>&1 || fail 'Node.js is required for the Trivy evidence sanitizer contract test'
trivy_secret_fixture="$test_root/trivy-secret-report.json"
printf '%s\n' \
  '{"SchemaVersion":2,"Results":[{"Secrets":[{"RuleID":"fixture-rule","Severity":"HIGH","Code":{"Lines":[{"Content":"adjacent context"}]},"Match":"redacted-match"}]}]}' > \
  "$trivy_secret_fixture"
node "$trivy_report_sanitizer" "$trivy_secret_fixture"
grep -F '"RuleID": "fixture-rule"' "$trivy_secret_fixture" >/dev/null || fail 'Trivy sanitizer removed audit identity'
if grep -Eq '"(Code|Match)"[[:space:]]*:' "$trivy_secret_fixture"; then
  fail 'Trivy sanitizer retained plaintext-bearing fields'
fi

# 最小 OCI layout 夹具验证 bundle finalizer 真正把 source tree 与逐文件摘要写入清单。
bundle_fixture="$test_root/release-bundle"
bundle_layout="$test_root/oci-layout"
mkdir -p "$bundle_fixture" "$bundle_layout"
oci_fixture_digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
printf '%s\n' '{"imageLayoutVersion":"1.0.0"}' > "$bundle_layout/oci-layout"
printf '%s\n' "{\"schemaVersion\":2,\"manifests\":[{\"mediaType\":\"application/vnd.oci.image.manifest.v1+json\",\"digest\":\"$oci_fixture_digest\",\"size\":1}]}" > "$bundle_layout/index.json"
tar -cf "$bundle_fixture/release-image.oci.tar" -C "$bundle_layout" oci-layout index.json
printf '%s\n' "{\"containerimage.digest\":\"$oci_fixture_digest\"}" > "$bundle_fixture/build-metadata.json"
printf '%s\n' '{"bomFormat":"CycloneDX","specVersion":"1.6"}' > "$bundle_fixture/release-image.cyclonedx.json"
printf '%s\n' '{"spdxVersion":"SPDX-2.3"}' > "$bundle_fixture/release-image.spdx.json"
printf '%s\n' '{"SchemaVersion":2,"Results":[]}' > "$bundle_fixture/release-image.trivy.json"
cp "$repository_root/deploy/supply-chain/tool-images.env" "$bundle_fixture/tool-images.env"
env \
  GITHUB_SHA=0123456789abcdef0123456789abcdef01234567 \
  SOURCE_TREE_SHA=abcdef0123456789abcdef0123456789abcdef01 \
  GITHUB_REF=refs/tags/v1.2.3 \
  GITHUB_WORKFLOW_REF=acme/slots/.github/workflows/supply-chain-release.yml@refs/tags/v1.2.3 \
  SUPPLY_CHAIN_ARTIFACT=rgs-runtime \
  SUPPLY_CHAIN_IMAGE_REPOSITORY=registry.example.com/acme/slots-rgs \
  SUPPLY_CHAIN_IMAGE_TAG=v1.2.3 \
  SUPPLY_CHAIN_APPROVAL_SHA256=none \
  "$release_bundle" finalize "$bundle_fixture" rgs-unprivileged
grep -F -x 'SOURCE_TREE_SHA=abcdef0123456789abcdef0123456789abcdef01' "$bundle_fixture/bundle-manifest.env" >/dev/null || \
  fail 'release bundle did not bind the real source tree'
(cd "$bundle_fixture" && sha256sum --check --strict bundle-checksums.sha256 >/dev/null) || \
  fail 'release bundle emitted invalid checksums'

run_release_validation() {
  protected_ref=$1
  expected_identity=$2
  image_tag=$3
  registry=$4
  env \
    SUPPLY_CHAIN_REGISTRY="$registry" \
    SUPPLY_CHAIN_IMAGE_REPOSITORY=registry.example.com/acme/slots-rgs \
    SUPPLY_CHAIN_ARTIFACT=rgs-runtime \
    SUPPLY_CHAIN_IMAGE_TAG="$image_tag" \
    SUPPLY_CHAIN_EXPECTED_CERTIFICATE_IDENTITY="$expected_identity" \
    SUPPLY_CHAIN_EXPECTED_OIDC_ISSUER=https://token.actions.githubusercontent.com \
    GITHUB_EVENT_NAME=workflow_dispatch \
    GITHUB_REF=refs/tags/v1.2.3 \
    GITHUB_REF_NAME=v1.2.3 \
    GITHUB_REF_PROTECTED="$protected_ref" \
    GITHUB_REPOSITORY=acme/slots \
    GITHUB_SERVER_URL=https://github.com \
    GITHUB_SHA=0123456789abcdef0123456789abcdef01234567 \
    GITHUB_WORKFLOW_REF=acme/slots/.github/workflows/supply-chain-release.yml@refs/tags/v1.2.3 \
    "$repository_root/deploy/supply-chain/release-sign.sh" validate-build
}

valid_identity=https://github.com/acme/slots/.github/workflows/supply-chain-release.yml@refs/tags/v1.2.3
run_release_validation true "$valid_identity" v1.2.3 registry.example.com >/dev/null || fail 'valid release identity was rejected'
if run_release_validation false "$valid_identity" v1.2.3 registry.example.com >/dev/null 2>&1; then
  fail 'unprotected release ref was accepted'
fi
if run_release_validation true https://github.com/attacker/repo/.github/workflows/release.yml@refs/tags/v1.2.3 v1.2.3 registry.example.com >/dev/null 2>&1; then
  fail 'forged certificate identity was accepted'
fi
if run_release_validation true "$valid_identity" latest registry.example.com >/dev/null 2>&1; then
  fail 'mutable latest tag was accepted'
fi
if run_release_validation true "$valid_identity" v1.2.3 https://registry.example.com >/dev/null 2>&1; then
  fail 'registry URL with a scheme was accepted'
fi

reset_fixture
replace_once '@sha256:678bfa565b60f747aac0f8e964fe5588a24445b8d0a480e91f6efd70020dfbb0' '' "$fixture/deploy/supply-chain/tool-images.env"
expect_rejected 'mutable Syft image tag'

reset_fixture
replace_once '--env GOPATH=/tmp/go' '--env GOPATH=/go' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'govulncheck inherited an unwritable image GOPATH'

reset_fixture
replace_once '/run/govulncheck:rw,nosuid,nodev,exec' '/run/govulncheck:rw,nosuid,nodev,noexec' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'govulncheck executable mount became noexec'

reset_fixture
replace_once 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' 'actions/checkout@v7' "$fixture/.github/workflows/supply-chain.yml"
expect_rejected 'mutable Action reference'

reset_fixture
replace_once 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1' 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # regressed' "$fixture/.github/workflows/backend-conformance.yml"
expect_rejected 'backend CI regressed to an unreviewed checkout implementation'

reset_fixture
replace_once '          persist-credentials: false' '          persist-credentials: true' "$fixture/.github/workflows/frontend-conformance.yml"
expect_rejected 'frontend CI retained checkout credentials while running repository code'

reset_fixture
replace_once '        run: make verify-deployment-contracts' '        run: true # deployment contracts removed' "$fixture/.github/workflows/deployment-conformance.yml"
expect_rejected 'required deployment conformance workflow skipped local and cluster contracts'

reset_fixture
replace_once '        run: make verify-cluster-prometheus-rules' '        run: true # promtool rule parsing removed' "$fixture/.github/workflows/deployment-conformance.yml"
expect_rejected 'required deployment conformance workflow skipped PromQL parsing'

reset_fixture
replace_once 'prom/prometheus:v3.13.1@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893' 'prom/prometheus:latest' "$fixture/deploy/cluster-production/verify-prometheus-rule-contract.sh"
expect_rejected 'cluster PromQL parser image became mutable'

reset_fixture
replace_once '"$GITLEAKS_IMAGE" dir /workspace --no-banner --redact=100 --exit-code 1' '"$GITLEAKS_IMAGE" git /workspace --no-banner --redact=100 --exit-code 1' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'missing current-worktree secret scan'

reset_fixture
replace_once "--log-opts='--full-history HEAD --diff-filter=tuxdb'" "--log-opts='--full-history --all --diff-filter=tuxdb'" "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'Git history secret scan escaped the release HEAD boundary'

reset_fixture
replace_once 'git -C "$git_root" rev-list HEAD --count' 'git -C "$git_root" rev-list --all --count' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'Git history evidence counted unrelated checkout refs'

reset_fixture
replace_once '--tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777' '--tmpfs /tmp:rw,nosuid,nodev,size=512m' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'image Syft temporary filesystem lost sticky write permissions'

reset_fixture
replace_once '--env HOME=/tmp/syft-home' '--env HOME=/' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'Syft used a non-writable shared home directory'

reset_fixture
replace_once '--env XDG_CACHE_HOME=/tmp/syft-cache' '--env XDG_CACHE_HOME=/.cache' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'Syft cache escaped the private writable temporary filesystem'

reset_fixture
replace_once 'if grep -F -- "$gitleaks_canary_secret" "$evidence_dir/gitleaks-canary.json" >/dev/null; then' 'if false; then' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'missing Gitleaks canary redaction proof'

reset_fixture
replace_once 'if git -C "$git_root" grep -F "$trivy_inline_marker" -- . >/dev/null 2>&1; then' 'if false; then' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'repository inline Trivy ignore bypass'

reset_fixture
replace_once '--config /dev/null --cache-dir /cache' '--config /dev/null --cache-dir /cache --no-progress' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'Trivy config canary received an unsupported progress flag'

reset_fixture
replace_once '--config /dev/null --cache-dir /cache' '--config /dev/null --cache-dir /cache --scanners misconfig' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'Trivy config canary received an unsupported scanner-selection flag'

reset_fixture
replace_once '"$trivy_asset_verifier" "$trivy_cache" "$output_dir" >/dev/null' ': # removed offline Trivy asset verification' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'missing offline Trivy checks verification'

reset_fixture
replace_once 'mirror.gcr.io/aquasec/trivy-checks:2' 'registry.invalid/unreviewed/checks:latest' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'custom or mutable-source Trivy checks repository'

reset_fixture
replace_once '"$SYFT_IMAGE" "dir:/workspace"' '"$SYFT_IMAGE" "dir:$container_project_root"' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'source SBOM omitted parent Git root workflows'

reset_fixture
replace_once '"$TRIVY_IMAGE" fs /workspace' '"$TRIVY_IMAGE" fs "$container_project_root"' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'filesystem scan omitted parent Git root workflows'

reset_fixture
replace_once '--scanners vuln --severity HIGH,CRITICAL --exit-code 1' '--scanners vuln --severity CRITICAL --exit-code 1' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'weakened filesystem vulnerability threshold'

reset_fixture
replace_once 'trivy config /scan' 'trivy config /scan/dockerfiles' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'Helm production configuration was omitted from the IaC scan'

reset_fixture
replace_once 'node /policy/verify-trivy-source-report.mjs' 'node /policy/sanitize-trivy-report.mjs' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'Trivy source report coverage was not verified'

reset_fixture
replace_once '  "exceptions": []' '  "exceptions": [{"id":"CVE-2099-0001"}]' "$fixture/deploy/supply-chain/vulnerability-exceptions.json"
expect_rejected 'unapproved vulnerability exception'

reset_fixture
replace_once '  workflow_dispatch:' '  push:' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'automatic release signing trigger'

reset_fixture
replace_once '        run: make verify' '        run: make verify-supply-chain-contract' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'release skipped complete source conformance'

reset_fixture
replace_once 'verify: verify-supply-chain-contract verify-chinese-comments test test-race vet build' 'verify: verify-supply-chain-contract verify-chinese-comments test vet build' "$fixture/Makefile"
expect_rejected 'release verify closure omitted race tests'

reset_fixture
replace_once '        run: ./deploy/supply-chain/scan.sh source "$SUPPLY_CHAIN_REPORT_DIR/source"' '        run: true # source security scan removed' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'release skipped exact source security scan'

reset_fixture
replace_once '        run: test -z "$(git status --porcelain=v1 --untracked-files=all)"' '        run: true # clean-tree assertion removed' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'release source scan accepted a dirty worktree'

reset_fixture
replace_once '        run: ./deploy/supply-chain/scan.sh source "$SUPPLY_CHAIN_REPORT_DIR/source"' '        run: __swap_release_source_scan__' "$fixture/.github/workflows/supply-chain-release.yml"
replace_once '        run: npm ci' '        run: ./deploy/supply-chain/scan.sh source "$SUPPLY_CHAIN_REPORT_DIR/source"' "$fixture/.github/workflows/supply-chain-release.yml"
replace_once '        run: __swap_release_source_scan__' '        run: npm ci' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'release source scan ran after dependency materialization'

reset_fixture
replace_once '        run: make smoke-runtime-production' '        run: true # production runtime smoke removed' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'release skipped production runtime smoke'

reset_fixture
replace_once '        run: npm run build:determinism-check' '        run: true # deterministic frontend rebuild removed' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'protected release skipped deterministic frontend rebuild'

reset_fixture
replace_once '        run: make verify-cluster-image-contract' '        run: true # cluster image runtime contract removed' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'protected release skipped cluster image runtime contract'

reset_fixture
replace_once '            make verify-cluster-image-contract' '            docker build --file deploy/Dockerfile --target runtime --tag slots-rgs-runtime:supply-chain .' "$fixture/.github/workflows/supply-chain.yml"
expect_rejected 'ordinary supply-chain CI regressed to the generic RGS image'

reset_fixture
replace_once "  -e RGS_DATABASE_URL_FILE=/run/cluster-contract/database-url \\" "  -e RGS_DATABASE_URL=inline-secret \\" "$fixture/deploy/cluster-production/verify-image-runtime-contract.sh"
expect_rejected 'cluster image runtime contract skipped positive secret-file loading'

reset_fixture
replace_once '        run: make verify-deployment-contracts' '        run: true # deployment contracts removed' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'protected release skipped deployment contracts'

reset_fixture
replace_once '        run: make verify-cluster-prometheus-rules' '        run: true # promtool rule parsing removed' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'protected release skipped PromQL parsing'

reset_fixture
replace_once 'postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193' 'postgres:17-alpine' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'release PostgreSQL service lost immutable digest'

reset_fixture
replace_once 'test "$GITHUB_REF_PROTECTED" = true' 'test -n "$GITHUB_REF_PROTECTED"' "$fixture/deploy/supply-chain/release-sign.sh"
expect_rejected 'unprotected release ref'

reset_fixture
replace_once 'test "$SUPPLY_CHAIN_EXPECTED_CERTIFICATE_IDENTITY" = "$computed_identity"' 'test -n "$SUPPLY_CHAIN_EXPECTED_CERTIFICATE_IDENTITY"' "$fixture/deploy/supply-chain/release-sign.sh"
expect_rejected 'non-exact signing identity'

reset_fixture
awk '
  /uses: actions\/attest@/ { count++ }
  count == 2 && /uses: actions\/attest@/ { next }
  { print }
' "$fixture/.github/workflows/supply-chain-release.yml" > "$fixture/.github/workflows/supply-chain-release.yml.tmp"
mv "$fixture/.github/workflows/supply-chain-release.yml.tmp" "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'missing SBOM attestation'

reset_fixture
replace_once '    runs-on: ubuntu-latest' '    environment: supply-chain-release' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'source conformance job received a privileged Environment'

reset_fixture
insert_job_permission verify-source-conformance '      packages: write' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'source conformance job received an extra packages write permission'

reset_fixture
insert_job_permission build-rgs '      actions: write' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'isolated RGS build received an extra actions write permission'

reset_fixture
insert_job_permission build-approved-web '      security-events: write' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'Web approval build received an extra security-events write permission'

reset_fixture
insert_job_permission publish-sign '      packages: write' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'publish/sign job received a permission outside its exact allowlist'

reset_fixture
replace_once '    needs: verify-source-conformance' '    needs: [] # source conformance dependency removed' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'isolated RGS build no longer depends on source conformance'

reset_fixture
replace_once '          ref: ${{ github.sha }}' '          ref: ${{ github.ref }}' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'isolated RGS build did not checkout the exact conformed SHA'

reset_fixture
replace_once '--label "com.slots.release.source-tree=$SOURCE_TREE_SHA"' '--label "com.slots.release.source-tree=claimed"' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'RGS OCI metadata lost the real context tree binding'

reset_fixture
replace_once '--file deploy/cluster-production/Dockerfile.services' '--file deploy/Dockerfile' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'RGS release reverted to the generic image without cluster helpers'

reset_fixture
replace_once 'rgs-runtime) target=rgs-runtime' 'rgs-runtime) target=runtime' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'RGS release selected the generic runtime target'

reset_fixture
replace_once 'rgs-migrator) target=rgs-migrator' 'rgs-migrator) target=migrator' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'RGS release selected the generic migrator target'

reset_fixture
replace_once '    environment: supply-chain-web-approval' '    environment: supply-chain-release' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'Web approval reused the Registry and OIDC release Environment'

reset_fixture
replace_once '      SUPPLY_CHAIN_REPORT_DIR: /tmp/slots-release-rgs-' '      REGISTRY_USERNAME: ${{ secrets.SUPPLY_CHAIN_REGISTRY_USERNAME }} # /tmp/slots-release-rgs-' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'fresh RGS build received a Registry secret'

reset_fixture
replace_once "needs.build-rgs.result == 'success'" "needs.build-rgs.result != 'failure'" "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'publish accepted a non-success RGS build result'

reset_fixture
replace_once 'needs.build-rgs.outputs.artifact_id }}' 'needs.verify-source-conformance.outputs.source_sha }}' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'publish artifact ID was not selected from the isolated builder'

reset_fixture
replace_once 'END { exit bad || NR != 6 }' 'END { exit NR == 6 ? 0 : 1 }' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'checksum allowlist END block could override an invalid line'

reset_fixture
replace_once '--read-only --network=none' '--read-only' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'offline OCI conversion regained network access'

reset_fixture
replace_once '      --format json --output "/out/$report_name.trivy.json"' '__swap_trivy_report_output__' "$fixture/deploy/supply-chain/scan.sh"
replace_once '  if ! sanitize_trivy_image_report "$output_dir/$report_name.trivy.json"; then' '      --format json --output "/out/$report_name.trivy.json"' "$fixture/deploy/supply-chain/scan.sh"
replace_once '__swap_trivy_report_output__' '  if ! sanitize_trivy_image_report "$output_dir/$report_name.trivy.json"; then' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'Trivy image evidence was sanitized before the report existed'

reset_fixture
replace_once '    delete finding.Code;' '    void finding.Code;' "$fixture/deploy/supply-chain/sanitize-trivy-report.mjs"
expect_rejected 'Trivy evidence sanitizer retained Code context'

reset_fixture
replace_once 'SOURCE_TREE_SHA=%s' 'CLAIMED_TREE=%s' "$fixture/deploy/supply-chain/release-bundle.sh"
expect_rejected 'release bundle manifest claimed rather than bound the Git tree'

reset_fixture
replace_once '不得把同名值配置成 repository/organization' '可把同名值配置成 repository/organization' "$fixture/deploy/supply-chain/README.md"
expect_rejected 'operations guide allowed Web approval to bypass its Environment'

printf '%s\n' 'supply-chain contract tests: ok'
