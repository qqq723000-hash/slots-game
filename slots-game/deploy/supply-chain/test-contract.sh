#!/bin/sh
# shellcheck disable=SC1003,SC2016

# 在临时仓库副本中主动削弱每个关键控制，证明静态门禁会失败；不需要 Docker daemon。
# SC1003/SC2016 仅因测试必须替换夹具中的字面量 `$` 与 Dockerfile 行尾反斜杠而关闭。
# English: Proactively weaken every critical control in a temporary repository copy, proving static gating will
# fail; no Docker daemon required. SC1003/SC2016 is closed only because tests must replace literal `$` with
# trailing backslashes in Dockerfile lines in fixtures.
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_dir/../.." && pwd)
workspace_root=$(CDPATH='' cd -- "$repository_root/.." && pwd)
verifier="$script_dir/verify-contract.sh"
trivy_asset_verifier="$script_dir/verify-trivy-assets.sh"
trivy_source_report_verifier="$script_dir/verify-trivy-source-report.mjs"
trivy_report_sanitizer="$script_dir/sanitize-trivy-report.mjs"
release_bundle="$script_dir/release-bundle.sh"
web_static_verifier="$script_dir/verify-web-static-root.mjs"

if [ -d "$repository_root/.github/workflows" ]; then
  workflows_root="$repository_root/.github/workflows"
else
  workflows_root="$workspace_root/.github/workflows"
fi
github_root=${workflows_root%/workflows}
delivery_root=${github_root%/.github}

fail() {
  printf '%s\n' "supply-chain contract tests: $*" >&2
  exit 1
}

test_root=$(mktemp -d "${TMPDIR:-/tmp}/slots-supply-chain-contract.XXXXXX")
trap 'rm -rf "$test_root"' EXIT HUP INT TERM
fixture="$test_root/repository"

reset_fixture() {
  rm -rf "$fixture"
  mkdir -p "$fixture/deploy/cluster-production" "$fixture/deploy/observability" \
    "$fixture/deploy/web" "$fixture/deploy/local-production" "$fixture/.github/ISSUE_TEMPLATE" \
    "$fixture/web/scripts" "$fixture/docs"
  cp "$repository_root/Makefile" "$fixture/Makefile"
  cp "$repository_root/web/package.json" "$fixture/web/package.json"
  cp "$repository_root/web/scripts/finalize-production-assets.mjs" \
    "$fixture/web/scripts/finalize-production-assets.mjs"
  cp "$repository_root/web/scripts/verify-visual-fixture-cross-browser.mjs" \
    "$fixture/web/scripts/verify-visual-fixture-cross-browser.mjs"
  cp "$repository_root/docs/aws-production-deployment.md" "$fixture/docs/aws-production-deployment.md"
  cp "$repository_root/docs/backend-release-gates.md" "$fixture/docs/backend-release-gates.md"
  cp -R "$repository_root/deploy/supply-chain" "$fixture/deploy/supply-chain"
  cp "$repository_root/deploy/cluster-production/Dockerfile.services" "$fixture/deploy/cluster-production/Dockerfile.services"
  cp "$repository_root/deploy/cluster-production/verify-kubeconform.sh" "$fixture/deploy/cluster-production/verify-kubeconform.sh"
  cp "$repository_root/deploy/cluster-production/verify-image-runtime-contract.sh" "$fixture/deploy/cluster-production/verify-image-runtime-contract.sh"
  cp "$repository_root/deploy/cluster-production/verify-prometheus-rule-contract.sh" "$fixture/deploy/cluster-production/verify-prometheus-rule-contract.sh"
  cp "$repository_root/deploy/observability/verify-release-workflow.sh" "$fixture/deploy/observability/verify-release-workflow.sh"
  chmod 0755 "$fixture/deploy/observability/verify-release-workflow.sh"
  cp "$repository_root/deploy/observability/test-vector-bounded-flush.sh" "$fixture/deploy/observability/test-vector-bounded-flush.sh"
  chmod 0755 "$fixture/deploy/observability/test-vector-bounded-flush.sh"
  cp "$repository_root/deploy/web/Dockerfile" "$fixture/deploy/web/Dockerfile"
  cp "$repository_root/deploy/local-production/Dockerfile.web" "$fixture/deploy/local-production/Dockerfile.web"
  cp "$repository_root/deploy/local-production/test-web-candidate-payload.sh" \
    "$fixture/deploy/local-production/test-web-candidate-payload.sh"
  chmod 0755 "$fixture/deploy/local-production/test-web-candidate-payload.sh"
  cp "$repository_root/deploy/local-production/Dockerfile.nginx-proxy" "$fixture/deploy/local-production/Dockerfile.nginx-proxy"
  cp -R "$workflows_root" "$fixture/.github/workflows"
  cp "$github_root/dependabot.yml" "$fixture/.github/dependabot.yml"
  cp "$github_root/ISSUE_TEMPLATE/config.yml" "$fixture/.github/ISSUE_TEMPLATE/config.yml"
  cp "$github_root/ISSUE_TEMPLATE/bug_report.yml" "$fixture/.github/ISSUE_TEMPLATE/bug_report.yml"
  cp "$github_root/ISSUE_TEMPLATE/change_proposal.yml" "$fixture/.github/ISSUE_TEMPLATE/change_proposal.yml"
  cp "$delivery_root/SUPPORT.md" "$fixture/SUPPORT.md"
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

insert_after_once() {
  needle=$1
  insertion=$2
  file=$3
  match_count=$(grep -F -x -c -- "$needle" "$file" || true)
  test "$match_count" -eq 1 || fail "test fixture must contain one exact line '$needle'"
  awk -v needle="$needle" -v insertion="$insertion" '
    $0 == needle { print; print insertion; next }
    { print }
  ' "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
}

replace_last_exact_line() {
  old=$1
  new=$2
  file=$3
  REPLACE_LAST_OLD="$old" REPLACE_LAST_NEW="$new" REPLACE_LAST_FILE="$file" node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const file = process.env.REPLACE_LAST_FILE;
const oldLine = Buffer.from(process.env.REPLACE_LAST_OLD ?? "", "utf8");
const newLine = Buffer.from(process.env.REPLACE_LAST_NEW ?? "", "utf8");
if (!file || oldLine.length === 0 || oldLine.includes(0x0a) || newLine.includes(0x0a)) process.exit(1);
const source = readFileSync(file);
let lineStart = 0;
let lastStart = -1;
let lastEnd = -1;
for (let index = 0; index <= source.length; index += 1) {
  if (index !== source.length && source[index] !== 0x0a) continue;
  if (source.subarray(lineStart, index).equals(oldLine)) {
    lastStart = lineStart;
    lastEnd = index;
  }
  lineStart = index + 1;
}
if (lastStart < 0) process.exit(1);
writeFileSync(file, Buffer.concat([
  source.subarray(0, lastStart),
  newLine,
  source.subarray(lastEnd),
]));
NODE
}

# awk -v 会解释反斜杠转义；内嵌 JavaScript 的 \u0027 必须按原始字节替换，
# 否则负向夹具可能没有真正改变目标行却继续执行。
# English: awk -v will interpret backslash escapes; \u0027 in embedded JavaScript must be replaced by raw bytes,
# Otherwise the negative fixture may continue executing without actually changing the target row.
replace_literal_once() {
  old=$1
  new=$2
  file=$3
  REPLACE_OLD="$old" REPLACE_NEW="$new" REPLACE_FILE="$file" node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const source = readFileSync(process.env.REPLACE_FILE, "utf8");
const oldValue = process.env.REPLACE_OLD;
const newValue = process.env.REPLACE_NEW;
const first = source.indexOf(oldValue);
if (first < 0 || source.indexOf(oldValue, first + oldValue.length) >= 0) process.exit(1);
writeFileSync(
  process.env.REPLACE_FILE,
  `${source.slice(0, first)}${newValue}${source.slice(first + oldValue.length)}`,
  "utf8",
);
NODE
}

move_web_root_reset_after_copy() {
  target_file=$1
  copy_line=$2
  MOVE_RESET_FILE="$target_file" MOVE_RESET_COPY_LINE="$copy_line" node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const file = process.env.MOVE_RESET_FILE;
const copyLine = process.env.MOVE_RESET_COPY_LINE;
const resetLine = "RUN --network=none rm -rf /usr/share/nginx/html && \\";
const installLine = "    install -d -o 0 -g 0 -m 0755 /usr/share/nginx/html";
if (!file || !copyLine) process.exit(1);
const lines = readFileSync(file, "utf8").split("\n");
const copyIndexes = lines.flatMap((line, index) => line === copyLine ? [index] : []);
if (copyIndexes.length !== 1) process.exit(1);
const copyIndex = copyIndexes[0];
let stageStart = -1;
for (let index = 0; index < copyIndex; index += 1) {
  if (lines[index].startsWith("FROM ")) stageStart = index;
}
const resetIndexes = [];
for (let index = stageStart + 1; index < copyIndex; index += 1) {
  if (lines[index] === resetLine && lines[index + 1] === installLine) resetIndexes.push(index);
}
if (resetIndexes.length !== 1) process.exit(1);
lines.splice(resetIndexes[0], 2);
const movedCopyIndex = lines.indexOf(copyLine);
if (movedCopyIndex < 0) process.exit(1);
lines.splice(movedCopyIndex + 1, 0, resetLine, installLine);
writeFileSync(file, lines.join("\n"), "utf8");
NODE
}

insert_job_permission() {
  job_name=$1
  permission=$2
  file=$3
  awk -v job="  $job_name:" -v permission="$permission" '
    $0 == job { inside = 1 }
    inside && !done && $0 ~ /^      (contents|actions): read$/ {
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

# GNU awk 会在 -v 中重新解释尾随反斜杠；辅助函数必须直接按行字节边界替换最后一次
# 精确匹配，同时保持其余重复行与源文件是否含最终 LF 不变。
# English: GNU awk reinterprets trailing backslashes in -v; helper functions must directly replace the last one
# on a line byte boundary An exact match while keeping the remaining duplicate lines unchanged regardless of
# whether the source file contains the final LF.
replace_last_old='RUN --network=none rm -rf /usr/share/nginx/html && \'
replace_last_new='RUN --network=none true && \'
replace_last_with_lf="$test_root/replace-last-with-lf.txt"
replace_last_without_lf="$test_root/replace-last-without-lf.txt"
REPLACE_LAST_TEST_OLD="$replace_last_old" \
REPLACE_LAST_TEST_WITH_LF="$replace_last_with_lf" \
REPLACE_LAST_TEST_WITHOUT_LF="$replace_last_without_lf" node <<'NODE'
const { writeFileSync } = require("node:fs");
const oldLine = process.env.REPLACE_LAST_TEST_OLD;
const withLf = process.env.REPLACE_LAST_TEST_WITH_LF;
const withoutLf = process.env.REPLACE_LAST_TEST_WITHOUT_LF;
if (!oldLine || !withLf || !withoutLf) process.exit(1);
writeFileSync(withLf, Buffer.from(`prefix\n${oldLine}\nmiddle\n${oldLine}\nsuffix\n`, "utf8"));
writeFileSync(withoutLf, Buffer.from(`prefix\n${oldLine}\nmiddle\n${oldLine}\nsuffix`, "utf8"));
NODE
replace_last_exact_line "$replace_last_old" "$replace_last_new" "$replace_last_with_lf"
replace_last_exact_line "$replace_last_old" "$replace_last_new" "$replace_last_without_lf"
REPLACE_LAST_TEST_OLD="$replace_last_old" \
REPLACE_LAST_TEST_NEW="$replace_last_new" \
REPLACE_LAST_TEST_WITH_LF="$replace_last_with_lf" \
REPLACE_LAST_TEST_WITHOUT_LF="$replace_last_without_lf" node <<'NODE'
const { readFileSync } = require("node:fs");
const oldLine = process.env.REPLACE_LAST_TEST_OLD;
const newLine = process.env.REPLACE_LAST_TEST_NEW;
const withLf = process.env.REPLACE_LAST_TEST_WITH_LF;
const withoutLf = process.env.REPLACE_LAST_TEST_WITHOUT_LF;
if (!oldLine || !newLine || !withLf || !withoutLf) process.exit(1);
const expectedWithLf = Buffer.from(`prefix\n${oldLine}\nmiddle\n${newLine}\nsuffix\n`, "utf8");
const expectedWithoutLf = Buffer.from(`prefix\n${oldLine}\nmiddle\n${newLine}\nsuffix`, "utf8");
if (!readFileSync(withLf).equals(expectedWithLf)
    || !readFileSync(withoutLf).equals(expectedWithoutLf)) process.exit(1);
NODE
if replace_last_exact_line 'missing exact line \' "$replace_last_new" "$replace_last_with_lf" \
  >/dev/null 2>&1; then
  fail 'replace_last_exact_line accepted a fixture without an exact match'
fi

reset_fixture
"$verifier" --root "$fixture" >/dev/null || fail 'baseline fixture failed'

reset_fixture
replace_once '    directory: /slots-game/web' '    directory: /web' "$fixture/.github/dependabot.yml"
expect_rejected 'Dependabot npm directory escaped the reviewed project root'

reset_fixture
replace_once '      - /slots-game/infra/terraform/stacks/application-platform' \
  '      - /slots-game/infra/terraform/stacks/missing' "$fixture/.github/dependabot.yml"
expect_rejected 'Dependabot omitted a Terraform lockfile root'

reset_fixture
replace_once '      security-events: write' '      security-events: read' "$fixture/.github/workflows/codeql.yml"
expect_rejected 'CodeQL lost SARIF upload permission'

reset_fixture
replace_once '        id: analyze' '        id: upload-only' "$fixture/.github/workflows/codeql.yml"
expect_rejected 'CodeQL SARIF verifier lost the analyze output binding'

reset_fixture
replace_once '          7.0' '          9.0' "$fixture/.github/workflows/codeql.yml"
expect_rejected 'CodeQL SARIF gate stopped rejecting High findings'

reset_fixture
replace_once 'node --test deploy/supply-chain/verify-codeql-sarif.test.mjs' \
  'true # CodeQL SARIF verifier tests removed' "$fixture/Makefile"
expect_rejected 'CodeQL SARIF verifier regression tests were removed'

reset_fixture
replace_once '          fail-on-severity: high' '          fail-on-severity: critical' \
  "$fixture/.github/workflows/dependency-review.yml"
expect_rejected 'dependency review accepted newly introduced high vulnerabilities'

reset_fixture
mkdir -p "$fixture/.github/workflows"
printf '%s\n' 'name: removed public demo' > "$fixture/.github/workflows/pages-demo.yml"
expect_rejected 'removed GitHub Pages workflow reappeared'

reset_fixture
mkdir -p "$fixture/web/src/demo"
printf '%s\n' 'export {};' > "$fixture/web/src/demo/reintroduced.ts"
expect_rejected 'removed public demo source tree reappeared'

reset_fixture
insert_after_once '    "build": "tsc --noEmit && vite build && npm run licenses:check-artifacts && node scripts/finalize-production-assets.mjs && npm run build:browser-preflight-check && node scripts/verify-production-javascript-bundles.mjs",' \
  '    "build:demo": "vite build",' "$fixture/web/package.json"
expect_rejected 'removed public demo package entrypoint reappeared'

reset_fixture
replace_once 'npm run build:browser-preflight-check' \
  'true # browser preflight artifact gate removed' "$fixture/web/package.json"
expect_rejected 'browser preflight artifact gate was removed from the production build'

reset_fixture
replace_once '    "build:browser-preflight-check": "node scripts/verify-browser-preflight-build.mjs",' \
  '    "build:browser-preflight-check": "true",' "$fixture/web/package.json"
expect_rejected 'browser preflight verifier command was bypassed'

reset_fixture
replace_once '    "browser-preflight.js",' '' "$fixture/web/scripts/finalize-production-assets.mjs"
expect_rejected 'browser preflight was removed from the production release whitelist'

reset_fixture
replace_once 'https://github.com/qqq723000-hash/slots-game/security/advisories/new' \
  'https://github.com/qqq723000-hash/slots-game/issues/new' "$fixture/.github/ISSUE_TEMPLATE/config.yml"
expect_rejected 'public issue routing replaced the private vulnerability channel'

reset_fixture
replace_once '不承诺响应时间、修复时间、7×24 值守、' '承诺响应时间、修复时间、7×24 值守、' \
  "$fixture/SUPPORT.md"
expect_rejected 'public repository support claimed an unapproved production SLA'

reset_fixture
replace_once '            slots-game/.artifacts/postgres-conformance/postgres-conformance.jsonl' \
  '            slots-game/.artifacts/postgres-conformance/*.jsonl' \
  "$fixture/.github/workflows/backend-conformance.yml"
expect_rejected 'backend evidence upload accepted a directory wildcard'

reset_fixture
replace_once 'node --test deploy/supply-chain/verify-release-version.test.mjs' \
  'true # formal version tests removed' "$fixture/Makefile"
expect_rejected 'ordinary source conformance omitted release version tests'

reset_fixture
replace_once '        run: node deploy/supply-chain/verify-release-version.mjs --formal' \
  '        run: node deploy/supply-chain/verify-release-version.mjs' \
  "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'protected release accepted pending Unreleased notes'

reset_fixture
primal_web_title_line=$(printf '%s\134' 'LABEL org.opencontainers.image.title="primal-rampage-web" ')
historical_web_title_line=$(printf '%s\134' 'LABEL org.opencontainers.image.title="iron-colossus-web" ')
replace_once "$primal_web_title_line" "$historical_web_title_line" "$fixture/deploy/web/Dockerfile"
expect_rejected 'release OCI title regressed to the historical internal name'

reset_fixture
replace_once 'org.opencontainers.image.licenses="NOASSERTION"' \
  'org.opencontainers.image.licenses="Apache-2.0"' "$fixture/deploy/web/Dockerfile"
expect_rejected 'Web OCI metadata asserted an unapproved repository license'

# 用最小本地资产夹具证明 checks bundle 缺失时会失败关闭；无需 Docker 或网络。
# English: Prove bundle checks fail on missing shutdown with minimal local asset fixtures; no Docker or
# networking required.
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
# English: Use a non-sensitive value fixture to prove that the Trivy secret's Code/Match will be deleted before
# always-upload, while retaining the rule evidence.
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

# 源码报告夹具锁定 Docker/Helm 与四个 Terraform 环境的精确目标，同时证明 Git 跟踪
# 清单、隔离复制清单、路径边界和符号链接任一失真都会失败关闭。
# English: Source reporting fixtures lock down Docker/Helm with precise targeting of four Terraform environments
# while proving Git tracking Any distortion of manifests, quarantined replication manifests, path boundaries,
# and symbolic links will fail the shutdown.
trivy_source_fixture="$test_root/trivy-source-reports"
prepare_trivy_source_fixture() {
  rm -rf "$trivy_source_fixture"
  mkdir -p "$trivy_source_fixture"
  TRIVY_SOURCE_FIXTURE="$trivy_source_fixture" node <<'NODE'
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const root = process.env.TRIVY_SOURCE_FIXTURE;
const vulnerabilityTargets = [
  ["slots-game/server/go.mod", "lang-pkgs", "gomod"],
  ["slots-game/web/package-lock.json", "lang-pkgs", "npm"],
];
const configurationTargets = [
  ["cluster/chart/templates/autoscaling.yaml", "config", "helm"],
  ["cluster/chart/templates/ingresses.yaml", "config", "helm"],
  ["cluster/chart/templates/networkpolicies.yaml", "config", "helm"],
  ["cluster/chart/templates/poddisruptionbudgets.yaml", "config", "helm"],
  ["cluster/chart/templates/prometheusrule.yaml", "config", "helm"],
  ["cluster/chart/templates/rgs-deployment.yaml", "config", "helm"],
  ["cluster/chart/templates/serviceaccounts.yaml", "config", "helm"],
  ["cluster/chart/templates/servicemonitor.yaml", "config", "helm"],
  ["cluster/chart/templates/services.yaml", "config", "helm"],
  ["cluster/chart/templates/web-deployment.yaml", "config", "helm"],
  ["cluster/chart/templates/worker-deployment.yaml", "config", "helm"],
  ["dockerfiles/cluster/Dockerfile.services", "config", "dockerfile"],
  ["dockerfiles/local-nginx-proxy/Dockerfile.nginx-proxy", "config", "dockerfile"],
  ["dockerfiles/local-services/Dockerfile.services", "config", "dockerfile"],
  ["dockerfiles/local-web/Dockerfile.web", "config", "dockerfile"],
  ["dockerfiles/root/Dockerfile", "config", "dockerfile"],
  ["dockerfiles/web/Dockerfile", "config", "dockerfile"],
];
const terraformTargets = [
  [".", "config", "terraform"],
  ["../../modules/archive/main.tf", "config", "terraform"],
  ["../../modules/web-edge/main.tf", "config", "terraform"],
];
const writeReport = (name, targets, findingField) => {
  const Results = targets.map(([Target, Class, Type]) => ({ Target, Class, Type, [findingField]: [] }));
  writeFileSync(join(root, name), `${JSON.stringify({ SchemaVersion: 2, Results })}\n`);
};
writeReport("trivy-filesystem.json", vulnerabilityTargets, "Vulnerabilities");
writeReport("trivy-config.json", configurationTargets, "Misconfigurations");
for (const environment of ["dev", "staging", "prod-primary", "prod-dr"]) {
  writeReport(`trivy-terraform-${environment}.json`, terraformTargets, "Misconfigurations");
}
const inventory = [
  "terraform/environments/dev/main.tf",
  "terraform/environments/dev/terraform.tfvars.example",
  "terraform/environments/prod-dr/main.tf",
  "terraform/environments/prod-dr/terraform.tfvars.example",
  "terraform/environments/prod-primary/main.tf",
  "terraform/environments/prod-primary/terraform.tfvars.example",
  "terraform/environments/staging/main.tf",
  "terraform/environments/staging/terraform.tfvars.example",
  "terraform/modules/archive/main.tf",
  "terraform/modules/web-edge/release-request.js",
  "terraform/modules/web-edge/release-response.js",
  "terraform/stacks/environment/main.tf",
].sort().join("\n") + "\n";
writeFileSync(join(root, "trivy-terraform-tracked-files.txt"), inventory);
writeFileSync(join(root, "trivy-terraform-copied-files.txt"), inventory);
NODE
}

verify_trivy_source_fixture() {
  node "$trivy_source_report_verifier" \
    "$trivy_source_fixture/trivy-filesystem.json" \
    "$trivy_source_fixture/trivy-config.json" \
    "$trivy_source_fixture/trivy-terraform-tracked-files.txt" \
    "$trivy_source_fixture/trivy-terraform-copied-files.txt" \
    "$trivy_source_fixture/trivy-terraform-dev.json" \
    "$trivy_source_fixture/trivy-terraform-staging.json" \
    "$trivy_source_fixture/trivy-terraform-prod-primary.json" \
    "$trivy_source_fixture/trivy-terraform-prod-dr.json"
}

prepare_trivy_source_fixture
verify_trivy_source_fixture >/dev/null || fail 'valid Trivy source coverage fixture was rejected'

prepare_trivy_source_fixture
TRIVY_MUTATION_FILE="$trivy_source_fixture/trivy-config.json" node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const file = process.env.TRIVY_MUTATION_FILE;
const report = JSON.parse(readFileSync(file, "utf8"));
report.Results.pop();
writeFileSync(file, `${JSON.stringify(report)}\n`);
NODE
if verify_trivy_source_fixture >/dev/null 2>&1; then
  fail 'Trivy configuration report with a deleted target was accepted'
fi

prepare_trivy_source_fixture
TRIVY_MUTATION_FILE="$trivy_source_fixture/trivy-config.json" node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const file = process.env.TRIVY_MUTATION_FILE;
const report = JSON.parse(readFileSync(file, "utf8"));
report.Results.push({ Target: "terraform/unreviewed.tf", Class: "config", Type: "terraform", Misconfigurations: [] });
writeFileSync(file, `${JSON.stringify(report)}\n`);
NODE
if verify_trivy_source_fixture >/dev/null 2>&1; then
  fail 'Trivy configuration report with an additional target was accepted'
fi

prepare_trivy_source_fixture
TRIVY_MUTATION_FILE="$trivy_source_fixture/trivy-terraform-dev.json" node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const file = process.env.TRIVY_MUTATION_FILE;
const report = JSON.parse(readFileSync(file, "utf8"));
report.Results[0].Type = "unknown";
writeFileSync(file, `${JSON.stringify(report)}\n`);
NODE
if verify_trivy_source_fixture >/dev/null 2>&1; then
  fail 'Terraform environment report with an incorrect scanner type was accepted'
fi

prepare_trivy_source_fixture
printf '%s\n' 'terraform/environments/../../escape.tf' > \
  "$trivy_source_fixture/trivy-terraform-tracked-files.txt"
if verify_trivy_source_fixture >/dev/null 2>&1; then
  fail 'Terraform tracked inventory path escape was accepted'
fi

prepare_trivy_source_fixture
rm "$trivy_source_fixture/trivy-terraform-copied-files.txt"
ln -s trivy-terraform-tracked-files.txt "$trivy_source_fixture/trivy-terraform-copied-files.txt"
if verify_trivy_source_fixture >/dev/null 2>&1; then
  fail 'symbolic-link Terraform inventory was accepted'
fi

# 最小 OCI layout 夹具验证 bundle finalizer 真正把 source tree 与逐文件摘要写入清单。
# English: Minimal OCI layout fixture validation bundle finalizer actually writes the source tree with
# file-by-file digest into the manifest.
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

# Web 审批的公开时效与规范化元数据摘要必须跨越构建/发布权限边界；原始审批仍不进入 bundle。
# English: Public aging and canonical metadata summaries for web approvals must cross the build/publish
# permissions boundary; the original approval still does not enter the bundle.
approval_fixture="$test_root/release-asset-approval.json"
approval_metadata="$test_root/release-asset-approval-metadata.env"
printf '%s\n' \
  '{"schemaVersion":1,"status":"APPROVED","approvalReference":" REG-2026-001 ","jurisdictions":[" GB ","MT"],"expiresAt":"2099-01-02T03:04:05.000Z","assets":[]}' > \
  "$approval_fixture"
"$release_bundle" approval-metadata "$approval_fixture" "$approval_metadata"
grep -F -x 'ASSET_APPROVAL_EXPIRES_AT=2099-01-02T03:04:05Z' "$approval_metadata" >/dev/null || \
  fail 'approval metadata did not normalize expiresAt'
approval_metadata_sha256=$(sed -n 's/^ASSET_APPROVAL_METADATA_SHA256=//p' "$approval_metadata")
printf '%s\n' "$approval_metadata_sha256" | grep -Eq '^[0-9a-f]{64}$' || \
  fail 'approval metadata did not emit a canonical SHA-256'
approval_variant="$test_root/release-asset-approval-variant.json"
approval_variant_metadata="$test_root/release-asset-approval-variant-metadata.env"
printf '%s\n' \
  '{"schemaVersion":1,"status":"APPROVED","approvalReference":"REG-2026-001","jurisdictions":["MT","GB"],"expiresAt":"2099-01-02T03:04:05Z","assets":[]}' > \
  "$approval_variant"
"$release_bundle" approval-metadata "$approval_variant" "$approval_variant_metadata"
grep -F -x "ASSET_APPROVAL_METADATA_SHA256=$approval_metadata_sha256" "$approval_variant_metadata" >/dev/null || \
  fail 'equivalent approval metadata did not normalize to one digest'

web_bundle_output="$test_root/web-bundle-output.env"
env \
  GITHUB_SHA=0123456789abcdef0123456789abcdef01234567 \
  SOURCE_TREE_SHA=abcdef0123456789abcdef0123456789abcdef01 \
  GITHUB_REF=refs/tags/v1.2.3 \
  GITHUB_WORKFLOW_REF=acme/slots/.github/workflows/supply-chain-release.yml@refs/tags/v1.2.3 \
  SUPPLY_CHAIN_ARTIFACT=web-runtime \
  SUPPLY_CHAIN_IMAGE_REPOSITORY=registry.example.com/acme/slots-web \
  SUPPLY_CHAIN_IMAGE_TAG=v1.2.3 \
  SUPPLY_CHAIN_APPROVAL_SHA256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  SUPPLY_CHAIN_APPROVAL_EXPIRES_AT=2099-01-02T03:04:05Z \
  SUPPLY_CHAIN_APPROVAL_METADATA_SHA256="$approval_metadata_sha256" \
  RGS_BASE_URL=https://rgs.example.com \
  RGS_BET_OPTIONS_MINOR=10,20 \
  RGS_DEFAULT_BET_MINOR=10 \
  RGS_HOST_ORIGIN=https://host.example.com \
  GITHUB_OUTPUT="$web_bundle_output" \
  "$release_bundle" finalize "$bundle_fixture" web-approved
grep -F -x 'ASSET_APPROVAL_EXPIRES_AT=2099-01-02T03:04:05Z' "$bundle_fixture/bundle-manifest.env" >/dev/null || \
  fail 'Web bundle did not bind approval expiry'
grep -F -x "ASSET_APPROVAL_METADATA_SHA256=$approval_metadata_sha256" "$bundle_fixture/bundle-manifest.env" >/dev/null || \
  fail 'Web bundle did not bind normalized approval metadata'
grep -F -x 'approval_expires_at=2099-01-02T03:04:05Z' "$web_bundle_output" >/dev/null || \
  fail 'Web build job output omitted approval expiry'
grep -F -x "approval_metadata_sha256=$approval_metadata_sha256" "$web_bundle_output" >/dev/null || \
  fail 'Web build job output omitted approval metadata digest'

if env \
  GITHUB_SHA=0123456789abcdef0123456789abcdef01234567 \
  SOURCE_TREE_SHA=abcdef0123456789abcdef0123456789abcdef01 \
  GITHUB_REF=refs/tags/v1.2.3 \
  GITHUB_WORKFLOW_REF=acme/slots/.github/workflows/supply-chain-release.yml@refs/tags/v1.2.3 \
  SUPPLY_CHAIN_ARTIFACT=web-runtime \
  SUPPLY_CHAIN_IMAGE_REPOSITORY=registry.example.com/acme/slots-web \
  SUPPLY_CHAIN_IMAGE_TAG=v1.2.3 \
  SUPPLY_CHAIN_APPROVAL_SHA256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  SUPPLY_CHAIN_APPROVAL_EXPIRES_AT=2000-01-02T03:04:05Z \
  SUPPLY_CHAIN_APPROVAL_METADATA_SHA256="$approval_metadata_sha256" \
  RGS_BASE_URL=https://rgs.example.com \
  RGS_BET_OPTIONS_MINOR=10,20 \
  RGS_DEFAULT_BET_MINOR=10 \
  RGS_HOST_ORIGIN=https://host.example.com \
  "$release_bundle" finalize "$bundle_fixture" web-approved >/dev/null 2>&1; then
  fail 'expired Web approval was accepted while finalizing the release bundle'
fi

# S3 的输入只能是从已复核 OCI digest 提取的静态根；清单必须逐文件封闭验证。
# English: Input to S3 can only be static roots extracted from reviewed OCI digests; the manifest must be
# verified on a file-by-file basis.
web_static_root="$test_root/web-static-root"
mkdir -p "$web_static_root/assets"
printf '%s\n' '<!doctype html><title>fixture</title>' > "$web_static_root/index.html"
printf '%s\n' 'fixture-js' > "$web_static_root/assets/index.js"
WEB_STATIC_ROOT="$web_static_root" node <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const root = process.env.WEB_STATIC_ROOT;
const files = ["assets/index.js", "index.html"].map((path) => {
  const bytes = readFileSync(join(root, path));
  return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
});
const payload = JSON.stringify({ schemaVersion: 1, version: "v1.2.3", revision: "0123456789abcdef0123456789abcdef01234567", files });
const releaseId = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
writeFileSync(join(root, "release-manifest.json"), `${JSON.stringify({ schemaVersion: 1, releaseId, version: "v1.2.3", revision: "0123456789abcdef0123456789abcdef01234567", files }, null, 2)}\n`);
NODE
node "$web_static_verifier" "$web_static_root" >/dev/null || fail 'valid extracted Web static root was rejected'
printf '%s\n' 'tampered-js' > "$web_static_root/assets/index.js"
if node "$web_static_verifier" "$web_static_root" >/dev/null 2>&1; then
  fail 'tampered extracted Web file was accepted'
fi
printf '%s\n' 'fixture-js' > "$web_static_root/assets/index.js"
printf '%s\n' 'unexpected' > "$web_static_root/unexpected.txt"
if node "$web_static_verifier" "$web_static_root" >/dev/null 2>&1; then
  fail 'file outside release-manifest was accepted for S3 delivery'
fi
rm "$web_static_root/unexpected.txt"
rm "$web_static_root/assets/index.js"
if node "$web_static_verifier" "$web_static_root" >/dev/null 2>&1; then
  fail 'release-manifest file missing from the extracted Web root was accepted'
fi
printf '%s\n' 'fixture-js' > "$web_static_root/assets/index.js"
ln -s index.html "$web_static_root/alias.html"
if node "$web_static_verifier" "$web_static_root" >/dev/null 2>&1; then
  fail 'symbolic link was accepted in the extracted Web static root'
fi
rm "$web_static_root/alias.html"

current_release_version=$(sed -n '1p' "$repository_root/VERSION")
current_release_tag="v$current_release_version"

run_release_validation() {
  protected_ref=$1
  expected_identity=$2
  image_tag=$3
  registry=$4
  release_validation_script=${5:-"$repository_root/deploy/supply-chain/release-sign.sh"}
  env \
    SUPPLY_CHAIN_REGISTRY="$registry" \
    SUPPLY_CHAIN_IMAGE_REPOSITORY=registry.example.com/acme/slots-rgs \
    SUPPLY_CHAIN_ARTIFACT=rgs-runtime \
    SUPPLY_CHAIN_IMAGE_TAG="$image_tag" \
    SUPPLY_CHAIN_EXPECTED_CERTIFICATE_IDENTITY="$expected_identity" \
    SUPPLY_CHAIN_EXPECTED_OIDC_ISSUER=https://token.actions.githubusercontent.com \
    GITHUB_EVENT_NAME=workflow_dispatch \
    GITHUB_REF="refs/tags/$current_release_tag" \
    GITHUB_REF_NAME="$current_release_tag" \
    GITHUB_REF_PROTECTED="$protected_ref" \
    GITHUB_REPOSITORY=acme/slots \
    GITHUB_SERVER_URL=https://github.com \
    GITHUB_SHA=0123456789abcdef0123456789abcdef01234567 \
    GITHUB_WORKFLOW_REF="acme/slots/.github/workflows/supply-chain-release.yml@refs/tags/$current_release_tag" \
    "$release_validation_script" validate-build
}

valid_identity="https://github.com/acme/slots/.github/workflows/supply-chain-release.yml@refs/tags/$current_release_tag"
run_release_validation true "$valid_identity" "$current_release_tag" registry.example.com >/dev/null || fail 'valid release identity was rejected'
if run_release_validation false "$valid_identity" "$current_release_tag" registry.example.com >/dev/null 2>&1; then
  fail 'unprotected release ref was accepted'
fi
if run_release_validation true "https://github.com/attacker/repo/.github/workflows/release.yml@refs/tags/$current_release_tag" "$current_release_tag" registry.example.com >/dev/null 2>&1; then
  fail 'forged certificate identity was accepted'
fi
if run_release_validation true "$valid_identity" latest registry.example.com >/dev/null 2>&1; then
  fail 'mutable latest tag was accepted'
fi
if run_release_validation true "$valid_identity" v0.0.0 registry.example.com >/dev/null 2>&1; then
  fail 'protected tag that does not match VERSION was accepted'
fi
if run_release_validation true "$valid_identity" "$current_release_tag" https://registry.example.com >/dev/null 2>&1; then
  fail 'registry URL with a scheme was accepted'
fi

release_sign_extra_root="$test_root/release-sign-extra"
mkdir -p "$release_sign_extra_root/deploy/supply-chain"
cp "$repository_root/deploy/supply-chain/release-sign.sh" \
  "$release_sign_extra_root/deploy/supply-chain/release-sign.sh"
printf '%s\ntrailing-content' "$current_release_version" > "$release_sign_extra_root/VERSION"
if run_release_validation true "$valid_identity" "$current_release_tag" registry.example.com \
  "$release_sign_extra_root/deploy/supply-chain/release-sign.sh" >/dev/null 2>&1; then
  fail 'VERSION content after the canonical line was accepted'
fi

reset_fixture
replace_once '@sha256:678bfa565b60f747aac0f8e964fe5588a24445b8d0a480e91f6efd70020dfbb0' '' "$fixture/deploy/supply-chain/tool-images.env"
expect_rejected 'mutable Syft image tag'

reset_fixture
replace_once 'apk add --no-network --no-cache' 'apk add --allow-untrusted --no-network --no-cache' "$fixture/deploy/local-production/Dockerfile.nginx-proxy"
expect_rejected 'local Nginx APK signature verification allowed untrusted packages'

reset_fixture
replace_once 'apk add --no-network --no-cache' 'apk add --force-overwrite --no-network --no-cache' "$fixture/deploy/local-production/Dockerfile.nginx-proxy"
expect_rejected 'local Nginx APK install accepted a force bypass flag'

reset_fixture
replace_once 'apk add --no-network --no-cache' 'apk add --keys-dir /tmp/apk-keys --no-network --no-cache' "$fixture/deploy/local-production/Dockerfile.nginx-proxy"
expect_rejected 'local Nginx APK install accepted a custom keys directory'

reset_fixture
replace_once '# 入口与告警代理共用这个仅修补 Alpine OpenSSL 的 nginxinc 运行镜像。固定远端' 'COPY attacker.rsa.pub /etc/apk/keys/attacker.rsa.pub' "$fixture/deploy/local-production/Dockerfile.nginx-proxy"
expect_rejected 'local Nginx image accepted a custom APK signing key'

reset_fixture
replace_once 'libssl3.apk" &&' 'libssl3.apk" curl &&' "$fixture/deploy/local-production/Dockerfile.nginx-proxy"
expect_rejected 'local Nginx image appended an unreviewed APK to the approved install'

reset_fixture
replace_last_exact_line 'USER 101:101' 'USER 0:0' "$fixture/deploy/local-production/Dockerfile.nginx-proxy"
expect_rejected 'local Nginx final effective user regressed to root'

reset_fixture
replace_once 'USER 101:101' 'USER 0:0' "$fixture/deploy/web/Dockerfile"
expect_rejected 'web Nginx runtime stage did not restore effective user 101:101'

reset_fixture
replace_once 'RUN --network=none rm -rf /usr/share/nginx/html && \' 'RUN --network=none true && \' \
  "$fixture/deploy/local-production/Dockerfile.web"
expect_rejected 'local Web candidate retained the inherited Nginx static root'

reset_fixture
replace_once 'RUN --network=none rm -rf /usr/share/nginx/html && \' 'RUN --network=none rm -rf /usr/share/nginx/html/* && \' \
  "$fixture/deploy/local-production/Dockerfile.web"
expect_rejected 'local Web candidate used a glob that can retain inherited hidden files'

reset_fixture
replace_once 'RUN --network=none rm -rf /usr/share/nginx/html && \' 'RUN --network=none true && \' \
  "$fixture/deploy/web/Dockerfile"
expect_rejected 'Web static-conformance image retained the inherited Nginx static root'

reset_fixture
replace_last_exact_line 'RUN --network=none rm -rf /usr/share/nginx/html && \' 'RUN --network=none true && \' \
  "$fixture/deploy/web/Dockerfile"
expect_rejected 'approved Web runtime retained the inherited Nginx static root'

reset_fixture
move_web_root_reset_after_copy \
  "$fixture/deploy/local-production/Dockerfile.web" \
  'COPY --chown=101:101 web/dist/ /usr/share/nginx/html/'
expect_rejected 'local Web candidate reset the inherited root only after copying dist'

reset_fixture
move_web_root_reset_after_copy \
  "$fixture/deploy/web/Dockerfile" \
  'COPY --from=release-build --chown=0:0 /src/web/dist/ /usr/share/nginx/html/'
expect_rejected 'approved Web runtime reset the inherited root only after copying dist'

reset_fixture
replace_once 'node "$static_verifier" "$candidate_static_root" >/dev/null' \
  'true # extracted candidate payload verification removed' \
  "$fixture/deploy/local-production/test-web-candidate-payload.sh"
expect_rejected 'real local Web candidate gate stopped verifying the extracted image payload'

reset_fixture
replace_once 'candidate_container_id=$(docker create "$candidate_image_id")' \
  'candidate_container_id=$(docker create "$candidate_image")' \
  "$fixture/deploy/local-production/test-web-candidate-payload.sh"
expect_rejected 'real local Web candidate gate extracted a mutable tag instead of its BuildKit image ID'

reset_fixture
replace_once '    if [ "$current_tag_id" = "$candidate_image_id" ]; then' \
  '    if [ -n "$current_tag_id" ]; then' \
  "$fixture/deploy/local-production/test-web-candidate-payload.sh"
expect_rejected 'real local Web candidate gate could remove a tag after its image ID changed'

reset_fixture
replace_once '    npm ci --ignore-scripts' '    npm ci' "$fixture/deploy/web/Dockerfile"
expect_rejected 'approval-gated Web dependency installation re-enabled lifecycle scripts'

reset_fixture
replace_once '    npm --ignore-scripts run build' '    npm run build' "$fixture/deploy/web/Dockerfile"
expect_rejected 'approval-gated Web build re-enabled npm pre/post lifecycle scripts'

reset_fixture
replace_once '    node ./scripts/generate-third-party-notices.mjs --check && \' \
  '    true # license declaration check removed && \' "$fixture/deploy/web/Dockerfile"
expect_rejected 'approval-gated Web build removed its explicit license declaration check'

reset_fixture
replace_once '    node ./scripts/finalize-production-assets.mjs --check && \' \
  '    true # post-build dist verification removed && \' "$fixture/deploy/web/Dockerfile"
expect_rejected 'approval-gated Web build removed its post-build complete-tree verification'

reset_fixture
replace_once '    node ./scripts/verify-production-javascript-bundles.mjs && \' \
  '    true # post-build JavaScript verification removed && \' "$fixture/deploy/web/Dockerfile"
expect_rejected 'approval-gated Web build removed its post-build JavaScript verification'

reset_fixture
replace_last_exact_line '    node ./scripts/finalize-production-assets.mjs --check' \
  '    true # pre-approval complete-tree verification removed' "$fixture/deploy/web/Dockerfile"
expect_rejected 'Web asset approval stopped re-verifying the complete dist tree'

reset_fixture
replace_once '    --mount=type=bind,from=release-config-build,source=/src/web,target=/src/web,readonly \' \
  '    --mount=type=bind,from=release-config-build,source=/src/web,target=/src/web \' \
  "$fixture/deploy/web/Dockerfile"
expect_rejected 'Web approval boundary made the verified Web root writable'

reset_fixture
insert_after_once '      node ./scripts/verify-release-asset-approval.mjs' \
  'RUN printf injected > /src/web/dist/unapproved.html' "$fixture/deploy/web/Dockerfile"
expect_rejected 'Web approval stage accepted a post-approval artifact mutation'

reset_fixture
insert_after_once '    "prebuild": "npm run licenses:check && npm run assets:provenance-check",' \
  '    "postbuild": "printf injected > dist/unapproved.html",' "$fixture/web/package.json"
expect_rejected 'Web package added a postbuild artifact mutation hook'

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
replace_once '  verify-special-features:' '  verify-special-features-disabled:' "$fixture/.github/workflows/frontend-conformance.yml"
expect_rejected 'frontend CI removed the isolated special-feature browser matrix job'

reset_fixture
replace_once '          - browser: firefox' '          - browser: chromium' "$fixture/.github/workflows/frontend-conformance.yml"
expect_rejected 'special-feature browser matrix dropped a required browser'

reset_fixture
replace_once '            job_timeout_minutes: 37' '            job_timeout_minutes: 32' "$fixture/.github/workflows/frontend-conformance.yml"
expect_rejected 'special-feature browser matrix lost its setup and cleanup budget'

reset_fixture
replace_once '    # Firefox/WebKit 脚本各保留 20 分钟且作业 35 分钟；Chromium 脚本保留 32 分钟且作业 37 分钟。' \
  '    # Firefox/WebKit 脚本各保留 20 分钟且作业 35 分钟；Chromium 脚本保留 20 分钟且作业 37 分钟。' \
  "$fixture/.github/workflows/frontend-conformance.yml"
expect_rejected 'Chromium browser matrix timing contract drifted from the reviewed script budget'

reset_fixture
replace_once 'const chromiumDesktopKongScenarioDeadlineMs = 360_000;' \
  'const chromiumDesktopKongScenarioDeadlineMs = 270_000;' \
  "$fixture/web/scripts/verify-visual-fixture-cross-browser.mjs"
expect_rejected 'Chromium desktop Kong scenario deadline regressed'

reset_fixture
replace_literal_once \
  'if (browserName === "chromium"
    && surface.id === "desktop-1440x900"
    && contract.scenario === "kong-flow")' \
  'if (browserName === "webkit"
    && surface.id === "desktop-1440x900"
    && contract.scenario === "kong-flow")' \
  "$fixture/web/scripts/verify-visual-fixture-cross-browser.mjs"
expect_rejected 'Chromium desktop Kong timing tuple changed browser'

reset_fixture
replace_literal_once \
  'if (browserName === "chromium"
    && surface.id === "desktop-1440x900"
    && contract.scenario === "kong-flow")' \
  'if (browserName === "chromium"
    && surface.id === "tablet-1024x768"
    && contract.scenario === "kong-flow")' \
  "$fixture/web/scripts/verify-visual-fixture-cross-browser.mjs"
expect_rejected 'Chromium desktop Kong timing tuple changed surface'

reset_fixture
replace_once 'const slowKongScenarioDeadlineMs = 270_000;' \
  'const slowKongScenarioDeadlineMs = 360_000;' \
  "$fixture/web/scripts/verify-visual-fixture-cross-browser.mjs"
expect_rejected 'shared tablet Kong deadline expanded without evidence'

reset_fixture
replace_once 'const edgeCapSummaryScenarioDeadlineMs = 300_000;' \
  'const edgeCapSummaryScenarioDeadlineMs = 240_000;' \
  "$fixture/web/scripts/verify-visual-fixture-cross-browser.mjs"
expect_rejected 'Edge desktop cap-summary deadline regressed'

reset_fixture
replace_literal_once \
  'if (browserName === "msedge"
    && surface.id === "desktop-1440x900"
    && contract.scenario === "cap-summary")' \
  'if (browserName === "chromium"
    && surface.id === "desktop-1440x900"
    && contract.scenario === "cap-summary")' \
  "$fixture/web/scripts/verify-visual-fixture-cross-browser.mjs"
expect_rejected 'Edge desktop cap-summary timing tuple changed browser'

reset_fixture
replace_literal_once \
  'if (browserName === "msedge"
    && surface.id === "desktop-1440x900"
    && contract.scenario === "cap-summary")' \
  'if (browserName === "msedge"
    && surface.id === "mobile-390x844"
    && contract.scenario === "cap-summary")' \
  "$fixture/web/scripts/verify-visual-fixture-cross-browser.mjs"
expect_rejected 'Edge desktop cap-summary timing tuple changed surface'

reset_fixture
replace_once 'const slowBrowserDeadlineMs = 32 * 60_000;' \
  'const slowBrowserDeadlineMs = 30 * 60_000;' \
  "$fixture/web/scripts/verify-visual-fixture-cross-browser.mjs"
expect_rejected 'Chromium browser deadline lost startup and cleanup headroom'

reset_fixture
replace_once 'const slowMaximumBrowserBudgetMs = 33 * 60_000;' \
  'const slowMaximumBrowserBudgetMs = 31 * 60_000;' \
  "$fixture/web/scripts/verify-visual-fixture-cross-browser.mjs"
expect_rejected 'Chromium maximum browser budget regressed'

reset_fixture
replace_once 'const edgeBrowserDeadlineMs = 32 * 60_000;' \
  'const edgeBrowserDeadlineMs = 31 * 60_000;' \
  "$fixture/web/scripts/verify-visual-fixture-cross-browser.mjs"
expect_rejected 'Edge browser deadline lost startup and cleanup headroom'

reset_fixture
replace_once 'const edgeMaximumBrowserBudgetMs = 33 * 60_000;' \
  'const edgeMaximumBrowserBudgetMs = 32 * 60_000;' \
  "$fixture/web/scripts/verify-visual-fixture-cross-browser.mjs"
expect_rejected 'Edge maximum browser budget regressed'

reset_fixture
replace_once '    timeout-minutes: 40' '    timeout-minutes: 33' "$fixture/.github/workflows/frontend-conformance.yml"
expect_rejected 'Edge browser matrix lost its build and cleanup budget'

reset_fixture
replace_once '    # Windows 软件渲染截图受脚本 32 分钟硬截止；额外预算只覆盖安装、生产构建与 Edge 事务门禁。' \
  '    # Windows 软件渲染截图受脚本 20 分钟硬截止；额外预算只覆盖安装、生产构建与 Edge 事务门禁。' \
  "$fixture/.github/workflows/frontend-conformance.yml"
expect_rejected 'Edge browser matrix timing contract drifted from the reviewed script budget'

reset_fixture
replace_once '  npm run test:visual-fixtures-browser-matrix -- --browser "${{ matrix.browser }}"' \
  '  true # special-feature non-Firefox matrix bypassed' \
  "$fixture/.github/workflows/frontend-conformance.yml"
expect_rejected 'special-feature browser matrix command was bypassed'

reset_fixture
replace_once '          GALLIUM_DRIVER=llvmpipe \' '          GALLIUM_DRIVER=softpipe \' \
  "$fixture/.github/workflows/frontend-conformance.yml"
expect_rejected 'production Firefox matrix stopped requiring reviewed Mesa llvmpipe'

reset_fixture
replace_once '            SLOTS_FIREFOX_XVFB_SOFTWARE_WEBGL=1 \' \
  '            SLOTS_FIREFOX_XVFB_SOFTWARE_WEBGL=0 \' \
  "$fixture/.github/workflows/frontend-conformance.yml"
expect_rejected 'special-feature Firefox matrix disabled the Xvfb software WebGL contract'

reset_fixture
insert_after_once '  verify-special-features:' '    if: false' \
  "$fixture/.github/workflows/frontend-conformance.yml"
expect_rejected 'special-feature browser matrix job was disabled with if:false'

reset_fixture
insert_after_once '      - name: Verify non-production special-feature fixtures' \
  '        if: ${{ false }}' "$fixture/.github/workflows/frontend-conformance.yml"
expect_rejected 'special-feature browser matrix step was disabled with an if:false expression'

reset_fixture
insert_after_once '  verify-frontend:' '    continue-on-error: true' \
  "$fixture/.github/workflows/frontend-conformance.yml"
expect_rejected 'primary frontend conformance job became non-blocking'

reset_fixture
insert_after_once '      - name: Verify production transaction in Microsoft Edge' \
  '        continue-on-error: true' "$fixture/.github/workflows/frontend-conformance.yml"
expect_rejected 'Microsoft Edge transaction step became non-blocking'

reset_fixture
replace_once 'concurrency:' 'backend-concurrency-disabled:' "$fixture/.github/workflows/backend-conformance.yml"
expect_rejected 'backend conformance omitted stale-run cancellation'

reset_fixture
replace_once '  cancel-in-progress: true' '  cancel-in-progress: false' "$fixture/.github/workflows/frontend-conformance.yml"
expect_rejected 'frontend conformance preserved stale same-ref runs'

reset_fixture
replace_once '${{ github.workflow }}' 'backend-conformance' "$fixture/.github/workflows/backend-conformance.yml"
expect_rejected 'backend conformance lock omitted the workflow identity'

reset_fixture
replace_once '${{ github.ref }}' '${{ github.workflow }}' "$fixture/.github/workflows/frontend-conformance.yml"
expect_rejected 'frontend conformance lock omitted the ref identity'

reset_fixture
replace_once '            shellcheck -S warning -x -P . -P "$(dirname "$script")" "$script"' \
  '            true # repository-wide shellcheck removed' \
  "$fixture/.github/workflows/deployment-conformance.yml"
expect_rejected 'deployment conformance stopped linting every tracked shell script'

reset_fixture
replace_once '        run: make verify-deployment-contracts' '        run: true # deployment contracts removed' "$fixture/.github/workflows/deployment-conformance.yml"
expect_rejected 'required deployment conformance workflow skipped local and cluster contracts'

reset_fixture
replace_once '        run: make verify-cluster-prometheus-rules' '        run: true # promtool rule parsing removed' "$fixture/.github/workflows/deployment-conformance.yml"
expect_rejected 'required deployment conformance workflow skipped PromQL parsing'

reset_fixture
replace_once '        run: docker pull "$VECTOR_IMAGE" >/dev/null' '        run: true # fixed Vector preload removed' "$fixture/.github/workflows/deployment-conformance.yml"
expect_rejected 'deployment conformance skipped fixed Vector image preload'

reset_fixture
replace_once '        run: make test-vector-bounded-flush' '        run: true # bounded Vector recovery removed' "$fixture/.github/workflows/deployment-conformance.yml"
expect_rejected 'deployment conformance skipped bounded Vector disk-buffer recovery'

reset_fixture
replace_once 'timberio/vector:0.57.0-debian@sha256:ed2134fa8f9844c1ca6405260903c2c2c52f94af9e16bc8fa9de9655134e0b39' 'timberio/vector:0.57.0-debian' "$fixture/.github/workflows/deployment-conformance.yml"
expect_rejected 'deployment conformance Vector image lost its reviewed digest'

reset_fixture
replace_once 'test-vector-bounded-flush:' 'test-vector-bounded-flush-disabled:' "$fixture/Makefile"
expect_rejected 'Makefile removed the bounded Vector recovery target'

reset_fixture
chmod 0644 "$fixture/deploy/observability/test-vector-bounded-flush.sh"
expect_rejected 'bounded Vector recovery gate lost executable mode'

reset_fixture
replace_once "expected_vector_image='timberio/vector:0.57.0-debian@sha256:ed2134fa8f9844c1ca6405260903c2c2c52f94af9e16bc8fa9de9655134e0b39'" "expected_vector_image='timberio/vector:0.57.0-debian'" "$fixture/deploy/observability/test-vector-bounded-flush.sh"
expect_rejected 'bounded Vector recovery gate accepted a mutable image tag'

reset_fixture
replace_once "heartbeat_source['interval_secs'] == 10" "heartbeat_source['interval_secs'] >= 10" "$fixture/deploy/observability/test-vector-bounded-flush.sh"
expect_rejected 'bounded Vector recovery gate weakened the fixed heartbeat interval'

reset_fixture
replace_once "      'count' => 1," "      'count' => 2," "$fixture/deploy/observability/test-vector-bounded-flush.sh"
expect_rejected 'bounded Vector recovery gate injected a second business event'

reset_fixture
replace_once 'online_sender_data="$test_directory/online-sender-data"' 'online_sender_data="$test_directory/outage-sender-data"' "$fixture/deploy/observability/test-vector-bounded-flush.sh"
expect_rejected 'bounded Vector recovery gate reused the outage disk buffer for the online phase'

reset_fixture
replace_once "raise 'business event is not durable' unless files.any? { |path| File.binread(path).include?(marker) }" "raise 'business event is not durable' unless true" "$fixture/deploy/observability/test-vector-bounded-flush.sh"
expect_rejected 'bounded Vector recovery gate stopped proving pre-recovery disk persistence'

reset_fixture
replace_once 'test "$readiness_ready" -eq 1 || fail' 'true # receiver readiness proof removed' "$fixture/deploy/observability/test-vector-bounded-flush.sh"
expect_rejected 'bounded Vector recovery gate started its online phase without HTTP readiness evidence'

reset_fixture
replace_once 'online_deadline=$((online_started_at + 25))' 'online_deadline=$((online_started_at + 90))' "$fixture/deploy/observability/test-vector-bounded-flush.sh"
expect_rejected 'bounded Vector recovery gate weakened the online delivery deadline'

reset_fixture
replace_once "  event.keys.sort == heartbeat_keys &&" "  event.key?('msg') &&" "$fixture/deploy/observability/test-vector-bounded-flush.sh"
expect_rejected 'bounded Vector recovery gate stopped enforcing the safe heartbeat schema'

reset_fixture
replace_once "raise 'business probe count mismatch' unless probes.length == 1" "raise 'business probe missing' if probes.empty?" "$fixture/deploy/observability/test-vector-bounded-flush.sh"
expect_rejected 'bounded Vector recovery gate stopped proving exactly-once business delivery'

reset_fixture
replace_once "raise 'outage probe count mismatch' unless all.count { |event| event['bounded_flush_probe'] == 'vector-bounded-flush-outage-v1' } == 1" "raise 'outage probe missing' unless all.any? { |event| event['bounded_flush_probe'] == 'vector-bounded-flush-outage-v1' }" "$fixture/deploy/observability/test-vector-bounded-flush.sh"
expect_rejected 'bounded Vector recovery gate weakened final outage exact-once reconciliation'

reset_fixture
replace_once "raise 'online probe count mismatch' unless all.count { |event| event['bounded_flush_probe'] == 'vector-bounded-flush-online-v1' } == 1" "raise 'online probe missing' unless all.any? { |event| event['bounded_flush_probe'] == 'vector-bounded-flush-online-v1' }" "$fixture/deploy/observability/test-vector-bounded-flush.sh"
expect_rejected 'bounded Vector recovery gate weakened final online exact-once reconciliation'

reset_fixture
replace_once "raise 'raw metric escaped' if raw_metric" ": # raw metric rejection removed" "$fixture/deploy/observability/test-vector-bounded-flush.sh"
expect_rejected 'bounded Vector recovery gate accepted raw heartbeat metrics'

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
replace_once '--timeout 30m --no-progress' '--no-progress' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'Trivy vulnerability DB download timeout was removed'

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
replace_once 'cp "$PROJECT_ROOT/deploy/local-production/Dockerfile.nginx-proxy" /scan/dockerfiles/local-nginx-proxy/Dockerfile.nginx-proxy' ': # local Nginx proxy Dockerfile omitted' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'local Nginx proxy Dockerfile was omitted from the IaC scan'

reset_fixture
replace_once 'terraform_pathspec=":(glob)$terraform_git_prefix/**/*.tf"' 'terraform_pathspec=":(glob)$terraform_git_prefix/modules/**/*.tf"' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'Terraform tracked inventory was narrowed to modules only'

reset_fixture
replace_once "    \"\$terraform_git_prefix/environments/prod-dr/terraform.tfvars.example\" \\" '    : # prod-dr tfvars tracking removed' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'production DR Terraform tfvars was removed from the tracked inventory'

reset_fixture
replace_once 'test ! -L "$source_path" || { echo "tracked Terraform scanner source must not be a symbolic link" >&2; exit 1; }' 'true # Terraform source symlink guard removed' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'tracked Terraform scanner source symlink guard was removed'

reset_fixture
replace_once 'find /terraform -type f -print' 'find /terraform -type f -name "*.tf" -print' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'Terraform isolated-copy inventory omitted tfvars and support inputs'

reset_fixture
replace_once '--tf-vars "/terraform/environments/$environment/terraform.tfvars.example"' ': # Terraform environment variables omitted' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'Terraform environment scan omitted its reviewed tfvars input'

reset_fixture
replace_once 'for environment in dev staging prod-primary prod-dr' 'for environment in dev' "$fixture/deploy/supply-chain/scan.sh"
expect_rejected 'Terraform environment scan omitted staging and production roots'

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
replace_once 'concurrency:' 'release-concurrency-disabled:' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'release workflow omitted the same-target concurrency lock'

reset_fixture
replace_once '  cancel-in-progress: false' '  cancel-in-progress: true' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'release workflow could cancel an in-flight immutable publication'

reset_fixture
replace_once "inputs.image_repository, inputs.image_tag" "inputs.image_tag, inputs.image_tag" "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'release concurrency group omitted the image repository'

reset_fixture
replace_once "inputs.image_repository, inputs.image_tag" "inputs.image_repository, inputs.image_repository" "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'release concurrency group omitted the final image tag'

reset_fixture
replace_once '        run: make verify' '        run: make verify-supply-chain-contract' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'release skipped complete source conformance'

reset_fixture
replace_once ' test test-race vet build' ' test vet build' "$fixture/Makefile"
expect_rejected 'release verify closure omitted race tests'

reset_fixture
replace_once 'verify-supply-chain-contract: verify-hardening-checklist verify-hardening-stability-contract verify-personal-project-docs verify-demo-media' 'verify-supply-chain-contract: verify-hardening-stability-contract verify-personal-project-docs verify-demo-media' "$fixture/Makefile"
expect_rejected 'ordinary supply-chain CI skipped the hardening checklist gate'

reset_fixture
replace_once 'verify-supply-chain-contract: verify-hardening-checklist verify-hardening-stability-contract verify-personal-project-docs verify-demo-media' 'verify-supply-chain-contract: verify-hardening-checklist verify-personal-project-docs verify-demo-media' "$fixture/Makefile"
expect_rejected 'ordinary supply-chain CI skipped the hardening stability contract gate'

reset_fixture
replace_once 'verify-supply-chain-contract: verify-hardening-checklist verify-hardening-stability-contract verify-personal-project-docs verify-demo-media' 'verify-supply-chain-contract: verify-hardening-checklist verify-hardening-stability-contract verify-demo-media' "$fixture/Makefile"
expect_rejected 'ordinary supply-chain CI skipped the personal-independent documentation gate'

reset_fixture
replace_once 'node scripts/verify-personal-project-docs.mjs' 'true # personal-independent documentation verification removed' "$fixture/Makefile"
expect_rejected 'ordinary supply-chain CI removed the personal-independent documentation verifier'

reset_fixture
replace_once 'verify-supply-chain-contract: verify-hardening-checklist verify-hardening-stability-contract verify-personal-project-docs verify-demo-media' 'verify-supply-chain-contract: verify-hardening-checklist verify-hardening-stability-contract verify-personal-project-docs' "$fixture/Makefile"
expect_rejected 'ordinary supply-chain CI skipped the demo media gate'

reset_fixture
replace_once ' verify-demo-media verify-hardening-checklist' ' verify-hardening-checklist' "$fixture/Makefile"
expect_rejected 'demo media gate was no longer phony'

reset_fixture
insert_after_once 'verify-demo-media:' 'detached-demo-media-recipes:' "$fixture/Makefile"
expect_rejected 'demo media recipes were detached from their target'

reset_fixture
replace_once 'node --test scripts/verify-demo-media.test.mjs' 'true # demo media negative tests removed' "$fixture/Makefile"
expect_rejected 'demo media gate removed its negative tests'

reset_fixture
replace_once 'node scripts/verify-demo-media.mjs' 'true # demo media verification removed' "$fixture/Makefile"
expect_rejected 'demo media gate removed its direct verifier'

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
replace_once "    go run ./scripts/third-party-notices --check && \\" "    true && \\" "$fixture/deploy/cluster-production/Dockerfile.services"
expect_rejected 'protected Go image build skipped the third-party notice graph check'

reset_fixture
replace_once 'COPY --from=build --chown=nonroot:nonroot /src/server/THIRD_PARTY_NOTICES.txt /THIRD_PARTY_NOTICES.txt' 'COPY --from=build --chown=nonroot:nonroot /src/server/THIRD_PARTY_NOTICES.txt /MISSING_FROM_ONE_IMAGE.txt' "$fixture/deploy/cluster-production/Dockerfile.services"
expect_rejected 'one protected Go image target omitted the authoritative third-party notice'

reset_fixture
replace_once '            make verify-cluster-image-contract' '            docker build --file deploy/Dockerfile --target runtime --tag slots-rgs-runtime:supply-chain .' "$fixture/.github/workflows/supply-chain.yml"
expect_rejected 'ordinary supply-chain CI regressed to the generic RGS image'

reset_fixture
replace_once "  -e RGS_DATABASE_URL_FILE=/run/cluster-contract/database-url \\" "  -e RGS_DATABASE_URL=inline-secret \\" "$fixture/deploy/cluster-production/verify-image-runtime-contract.sh"
expect_rejected 'cluster image runtime contract skipped positive secret-file loading'

reset_fixture
replace_literal_once 'member.mode != 0o400' 'member.mode != 0o600' "$fixture/deploy/cluster-production/verify-image-runtime-contract.sh"
expect_rejected 'cluster image runtime contract weakened the materialized secret mode'

reset_fixture
replace_once '        run: make verify-deployment-contracts' '        run: true # deployment contracts removed' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'protected release skipped deployment contracts'

reset_fixture
replace_once '        run: make verify-cluster-prometheus-rules' '        run: true # promtool rule parsing removed' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'protected release skipped PromQL parsing'

reset_fixture
replace_once '        run: ./deploy/observability/verify-release-workflow.sh' '        run: true # rendered observability release validation removed' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'protected release skipped fixed-image rendered observability validation'

reset_fixture
replace_once '        run: ./deploy/observability/verify-release-workflow.sh' "        run: '# ./deploy/observability/verify-release-workflow.sh'" "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'protected release commented out rendered observability validation'

reset_fixture
ruby -e '
  path = ARGV.fetch(0)
  source = File.read(path)
  marker = "      - name: Validate rendered observability release with fixed images\n        shell: bash\n"
  replacement = "      - name: Validate rendered observability release with fixed images\n        if: ${{ false }}\n        shell: bash\n"
  changed = source.sub(marker, replacement)
  abort "observability step if:false mutation did not apply" if changed == source
  File.write(path, changed)
' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'protected release observability validation step became skippable'

reset_fixture
ruby -ryaml -e '
  path = ARGV.fetch(0)
  workflow = YAML.safe_load(File.read(path), aliases: false)
  step = workflow.dig("jobs", "verify-source-conformance", "steps").find do |candidate|
    candidate["name"] == "Re-run complete source conformance on this protected tag"
  end
  abort "make verify step missing" unless step
  step["if"] = "${{ false }}"
  File.write(path, YAML.dump(workflow))
' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'protected release source conformance step became skippable'

reset_fixture
replace_once 'node deploy/local-production/render-observability.mjs "$observability_rendered_dir"' 'true # controlled observability rendering removed' "$fixture/deploy/observability/verify-release-workflow.sh"
expect_rejected 'protected release skipped controlled observability rendering'

reset_fixture
replace_once 'docker pull "$VECTOR_IMAGE"' 'true # fixed Vector preload removed' "$fixture/deploy/observability/verify-release-workflow.sh"
expect_rejected 'protected release entrypoint skipped fixed Vector image preload'

reset_fixture
replace_once 'make test-vector-bounded-flush' 'true # bounded Vector recovery removed' "$fixture/deploy/observability/verify-release-workflow.sh"
expect_rejected 'protected release entrypoint skipped bounded Vector recovery'

reset_fixture
ruby -e '
  path = ARGV.fetch(0)
  source = File.read(path)
  changed = source.sub("umask 077\n", "umask 077\nexit 0\n")
  abort "observability workflow early-exit mutation did not apply" if changed == source
  File.write(path, changed)
' "$fixture/deploy/observability/verify-release-workflow.sh"
expect_rejected 'protected release observability entrypoint gained an early success bypass'

reset_fixture
replace_once 'timberio/vector:0.57.0-debian@sha256:ed2134fa8f9844c1ca6405260903c2c2c52f94af9e16bc8fa9de9655134e0b39' 'timberio/vector:0.57.0-debian' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'protected observability validation lost the reviewed Vector digest'

reset_fixture
replace_once 'RGS_CONTAINER_LOG_GLOB: /var/log/containers/rgs-server-*.log' 'RGS_CONTAINER_LOG_GLOB: /var/log/containers/*.log' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'protected observability validation accepted a broad container log glob'

reset_fixture
replace_once 'PROMETHEUS_RENDER_PROFILE: local-production' 'PROMETHEUS_RENDER_PROFILE: central' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'protected local observability validation selected the central render profile'

reset_fixture
replace_once 'ALERTMANAGER_SERVER_NAME: alert-proxy' 'ALERTMANAGER_SERVER_NAME: attacker.invalid' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'protected observability validation lost the approved Alertmanager TLS identity'

reset_fixture
replace_once 'ALERTMANAGER_ROOT_CA_FILE="$observability_rendered_dir/alertmanager-root-ca.pem"' 'ALERTMANAGER_ROOT_CA_FILE=/dev/null' "$fixture/deploy/observability/verify-release-workflow.sh"
expect_rejected 'protected observability validation stopped binding its generated Alertmanager root CA'

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
insert_job_permission bind-release-artifact '      contents: write' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'artifact binding job received an extra contents write permission'

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
replace_once '--build-arg "OCI_IMAGE_VERSION=$release_version"' \
  '--build-arg "OCI_IMAGE_VERSION=$SUPPLY_CHAIN_IMAGE_TAG"' \
  "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'RGS OCI version retained the protected tag v prefix'

reset_fixture
replace_once '--build-arg WEB_RELEASE_VERSION="$release_version"' \
  '--build-arg WEB_RELEASE_VERSION="$SUPPLY_CHAIN_IMAGE_TAG"' \
  "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'Web release manifest version retained the protected tag v prefix'

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
replace_once '.digest == $digest and .workflow_run.id == $run_id and' \
  '.workflow_run.id == $run_id and' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'release artifact service digest was not bound before privileged publish'

reset_fixture
replace_once 'needs.bind-release-artifact.result == '\''success'\''' \
  'needs.bind-release-artifact.result != '\''failure'\''' \
  "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'publish accepted a non-success artifact metadata binding result'

reset_fixture
replace_once 'END { exit bad || NR != 6 }' 'END { exit NR == 6 ? 0 : 1 }' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'checksum allowlist END block could override an invalid line'

reset_fixture
replace_once '--read-only --network=none' '--read-only' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'offline OCI conversion regained network access'

reset_fixture
replace_once '--volume "$conversion_root:/output"' \
  '--volume /var/run/docker.sock:/var/run/docker.sock' \
  "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'approved Web conversion container regained the host Docker socket'

reset_fixture
replace_once 'docker load --input "$PUBLISH_WORK_DIR/release-image.docker.tar"' \
  'docker load --input "$PUBLISH_EVIDENCE_DIR/release-image.docker.tar"' \
  "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'privileged publish retained complete image bytes in the audit evidence directory'

reset_fixture
replace_once '          if-no-files-found: error' '          if-no-files-found: warn' \
  "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'release evidence upload silently accepted missing evidence'

reset_fixture
replace_once '          if-no-files-found: error' '          if-no-files-found: warn' \
  "$fixture/.github/workflows/backend-conformance.yml"
expect_rejected 'backend conformance silently accepted missing evidence'

reset_fixture
replace_once '不等于生产容量认证' '等于生产容量认证' \
  "$fixture/docs/backend-release-gates.md"
expect_rejected 'backend release gate misrepresented correctness tests as production capacity certification'

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
replace_once 'approval has expired immediately before Registry push' 'approval was checked earlier' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'Registry push lost its just-in-time approval expiry check'

reset_fixture
replace_once 'timestamp <= Date.now()' 'false' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'Registry push stopped comparing approval expiry with its current clock'

reset_fixture
replace_once 'extracted Web root contains a file outside release-manifest' 'unexpected files are tolerated' "$fixture/deploy/supply-chain/verify-web-static-root.mjs"
expect_rejected 'AWS static-root verifier no longer failed on extra files'

reset_fixture
replace_once '["trusted-types", "slots-game-static-html"],' \
  '["trusted-types", "*"],' \
  "$fixture/deploy/supply-chain/extract-aws-web-static-root.sh"
expect_rejected 'AWS CloudFront CSP extraction allowed an unreviewed Trusted Types policy'

reset_fixture
replace_literal_once '["require-trusted-types-for", "\u0027script\u0027"],' \
  '["require-trusted-types-for", "*"],' \
  "$fixture/deploy/supply-chain/extract-aws-web-static-root.sh"
expect_rejected 'AWS CloudFront CSP extraction lost the exact Trusted Types sink enforcement'

reset_fixture
replace_once 'put-object --if-none-match' 'aws s3 sync web/dist/' \
  "$fixture/docs/aws-production-deployment.md"
expect_rejected 'AWS guide regressed to a mutable workspace sync without conditional writes'

reset_fixture
insert_after_once 'set -euo pipefail' \
  'SLOTS_EXISTING_OBJECT_COUNT=$(aws s3api list-objects-v2 --bucket "$SLOTS_WEB_BUCKET")' \
  "$fixture/docs/aws-production-deployment.md"
expect_rejected 'AWS guide restored the non-atomic release-prefix emptiness gate'

reset_fixture
replace_once '--distribution-root "$static_root"' '--distribution-root web/dist' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'approved Web browser smoke regressed to mutable workspace bytes'

reset_fixture
replace_once '          node deploy/supply-chain/verify-web-static-root.mjs "$static_root"' \
  '          true # final OCI static-root verification removed' \
  "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'approved Web OCI stopped verifying its complete static root against release-manifest'

reset_fixture
replace_once '不得保存长期 AWS access key' '允许保存长期 AWS access key' "$fixture/deploy/supply-chain/README.md"
expect_rejected 'release guide allowed long-lived AWS credentials'

reset_fixture
replace_once 'aws-actions/configure-aws-credentials@61815dcd50bd041e203e49132bacad1fd04d2708' 'aws-actions/configure-aws-credentials@v5' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'AWS credential action was no longer commit-pinned'

reset_fixture
replace_once '.imageTagMutability == "IMMUTABLE"' '.imageTagMutability == "MUTABLE"' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'ECR immutable-tag enforcement was weakened'

reset_fixture
replace_once '$configuration.scanType == "ENHANCED"' '$configuration.scanType == "BASIC"' "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'ECR enhanced continuous scanning enforcement was weakened'

reset_fixture
preflight_command='if aws ecr describe-images --repository-name "$repository_name" --image-ids "imageTag=$SUPPLY_CHAIN_IMAGE_TAG" --output json >"$final_tag_probe" 2>"$final_tag_error"; then'
replace_once "$preflight_command" 'if false; then # final-tag preflight moved too late' "$fixture/.github/workflows/supply-chain-release.yml"
replace_once '          docker push "$candidate_ref"' "          docker push \"\$candidate_ref\"\n          # $preflight_command" "$fixture/.github/workflows/supply-chain-release.yml"
expect_rejected 'final-tag preflight ran after candidate publication'

printf '%s\n' 'supply-chain contract tests: ok'
