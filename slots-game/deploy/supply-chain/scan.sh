#!/bin/sh

# 所有扫描器运行在固定 digest 的容器中。源码与镜像归档只读挂载；除下载漏洞库、
# Trivy checks、npm advisory 和 Go 漏洞数据库外，实际解析阶段关闭网络，减少扫描器权限面。
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_dir/../.." && pwd)
tool_file="$script_dir/tool-images.env"
trivy_asset_verifier="$script_dir/verify-trivy-assets.sh"
trivy_report_sanitizer="$script_dir/sanitize-trivy-report.mjs"

fail() {
  printf '%s\n' "supply-chain scan: $*" >&2
  exit 1
}

usage() {
  printf '%s\n' 'usage: scan.sh source OUTPUT_DIR | image IMAGE_REF REPORT_NAME OUTPUT_DIR | oci-archive ARCHIVE REPORT_NAME OUTPUT_DIR' >&2
  exit 2
}

sanitize_trivy_image_report() {
  report_file=$1
  test -s "$report_file" || return 1
  report_dir=$(CDPATH='' cd -- "$(dirname -- "$report_file")" && pwd)
  report_name=$(basename -- "$report_file")

  # Trivy 会遮蔽命中的 Match，但 JSON 的 Code 上下文仍可能携带邻近业务值。对外留档前
  # 删除所有 secret finding 的原文/上下文字段，只保留规则、位置、严重级别等审计信息。
  docker run --rm \
    --user "$host_uid:$host_gid" \
    --read-only \
    --network=none \
    --tmpfs /tmp:rw,nosuid,nodev,size=64m \
    --mount "type=bind,src=$report_dir,dst=/out" \
    --mount "type=bind,src=$script_dir,dst=/policy,readonly" \
    "$NODE_IMAGE" node /policy/sanitize-trivy-report.mjs "/out/$report_name"

  if grep -Eq '"(Code|Match)"[[:space:]]*:' "$report_file"; then
    fail 'sanitized Trivy image evidence still contains secret plaintext fields'
  fi
}

test -f "$tool_file" || fail 'missing tool-images.env'
test -x "$trivy_asset_verifier" || fail 'missing executable verify-trivy-assets.sh'
test -f "$trivy_report_sanitizer" || fail 'missing sanitize-trivy-report.mjs'
# 该文件由静态门禁逐行校验，不接受调用方通过环境变量替换扫描器镜像。
# shellcheck disable=SC1090
. "$tool_file"

command -v docker >/dev/null 2>&1 || fail 'docker is required for dynamic scans; use verify-contract.sh for daemon-independent checks'
command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required to record vulnerability database identity'

host_uid=$(id -u)
host_gid=$(id -g)

prepare_output_dir() {
  output_dir=$1
  mkdir -p "$output_dir"
  output_dir=$(CDPATH='' cd -- "$output_dir" && pwd)
  chmod u+rwx "$output_dir"
}

prepare_trivy_database() {
  cache_dir=$1
  mkdir -p "$cache_dir"
  cache_dir=$(CDPATH='' cd -- "$cache_dir" && pwd)

  # CI runner 为短命环境；每个作业先联网取得当次数据库，再让实际扫描离线执行。
  docker run --rm \
    --user "$host_uid:$host_gid" \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,size=256m \
    --mount "type=bind,src=$cache_dir,dst=/cache" \
    "$TRIVY_IMAGE" image --config /dev/null --download-db-only --cache-dir /cache --no-progress
}

record_trivy_database() {
  cache_dir=$1
  output_dir=$2

  test -s "$cache_dir/db/metadata.json" || fail 'Trivy database metadata is missing'
  test -s "$cache_dir/db/trivy.db" || fail 'Trivy vulnerability database is missing'
  cp "$cache_dir/db/metadata.json" "$output_dir/trivy-db-metadata.json"
  sha256sum "$cache_dir/db/trivy.db" > "$output_dir/trivy-db.sha256"
}

prepare_gitleaks_canary() {
  canary_dir=$1
  evidence_dir=$2

  # 运行时分段拼出 GitHub classic PAT 形状的假凭据，源码与日志中均不保存完整值。
  gitleaks_canary_secret='ghp_'
  gitleaks_canary_secret="${gitleaks_canary_secret}A1b2C3d4E5f6G7h8I9"
  gitleaks_canary_secret="${gitleaks_canary_secret}j0K1l2M3n4P5q6R7s8"
  printf 'github_token = "%s"\n' "$gitleaks_canary_secret" > "$canary_dir/github-pat.canary"
  chmod 0600 "$canary_dir/github-pat.canary"

  if docker run --rm \
    --user "$host_uid:$host_gid" \
    --read-only \
    --network=none \
    --tmpfs /tmp:rw,nosuid,nodev,size=64m \
    --mount "type=bind,src=$canary_dir,dst=/canary,readonly" \
    --mount "type=bind,src=$evidence_dir,dst=/out" \
    "$GITLEAKS_IMAGE" dir /canary --no-banner --redact=100 --exit-code 1 \
      --gitleaks-ignore-path /dev/null --ignore-gitleaks-allow \
      --report-format json --report-path /out/gitleaks-canary.json
  then
    fail 'Gitleaks canary was not detected'
  else
    gitleaks_canary_status=$?
    test "$gitleaks_canary_status" -eq 1 || fail "Gitleaks canary scanner failed with exit code $gitleaks_canary_status"
  fi

  test -s "$evidence_dir/gitleaks-canary.json" || fail 'Gitleaks canary report is missing'
  grep -Eq '"RuleID"[[:space:]]*:[[:space:]]*"github-pat"' "$evidence_dir/gitleaks-canary.json" || \
    fail 'Gitleaks canary report does not contain the reviewed github-pat rule'
  if grep -F -- "$gitleaks_canary_secret" "$evidence_dir/gitleaks-canary.json" >/dev/null; then
    fail 'Gitleaks redact=100 leaked the canary credential into its report'
  fi
  gitleaks_canary_secret=
}

prepare_trivy_checks() {
  cache_dir=$1
  evidence_dir=$2
  canary_dir=$3

  # 该故意不安全的 Pod 只用于证明 checks bundle 已下载且真实执行；它不是发布配置。
  printf '%s\n' \
    'apiVersion: v1' \
    'kind: Pod' \
    'metadata:' \
    '  name: trivy-policy-canary' \
    'spec:' \
    '  containers:' \
    '    - name: canary' \
    '      image: example.invalid/canary@sha256:0000000000000000000000000000000000000000000000000000000000000000' \
    '      securityContext:' \
    '        privileged: true' > "$canary_dir/privileged-pod.yaml"

  # 此步骤故意联网且不传 --skip-check-update；后续真实扫描才会断网并锁为只读。
  if docker run --rm \
    --user "$host_uid:$host_gid" \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,size=256m \
    --mount "type=bind,src=$canary_dir,dst=/canary,readonly" \
    --mount "type=bind,src=$cache_dir,dst=/cache" \
    --mount "type=bind,src=$evidence_dir,dst=/out" \
    "$TRIVY_IMAGE" config /canary \
      --config /dev/null --cache-dir /cache \
      --checks-bundle-repository mirror.gcr.io/aquasec/trivy-checks:2 \
      --ignorefile /dev/null --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL \
      --exit-code 1 --format json --output /out/trivy-iac-canary.json
  then
    fail 'Trivy IaC canary produced no finding'
  else
    trivy_canary_status=$?
    test "$trivy_canary_status" -eq 1 || fail "Trivy IaC canary scanner failed with exit code $trivy_canary_status"
  fi

  "$trivy_asset_verifier" "$cache_dir" "$evidence_dir" >/dev/null
}

run_source_scan() {
  test "$#" -eq 1 || usage
  command -v git >/dev/null 2>&1 || fail 'git is required for complete history scanning'
  git_root=$(git -C "$repository_root" rev-parse --show-toplevel 2>/dev/null) || fail 'source scan requires a Git checkout with history'
  git_root=$(CDPATH='' cd -- "$git_root" && pwd)
  case "$repository_root" in
    "$git_root") container_project_root=/workspace ;;
    "$git_root"/*) container_project_root=/workspace/${repository_root#"$git_root"/} ;;
    *) fail 'project directory is outside the Git checkout' ;;
  esac
  test ! -e "$git_root/.gitleaks.toml" || fail 'repository-controlled .gitleaks.toml is forbidden'
  trivy_inline_marker='trivy:'
  trivy_inline_marker="${trivy_inline_marker}ignore"
  if git -C "$git_root" grep -F "$trivy_inline_marker" -- . >/dev/null 2>&1; then
    fail 'repository-controlled inline Trivy ignores are forbidden by the zero-exception policy'
  fi
  prepare_output_dir "$1"
  case "$output_dir" in
    "$git_root"|"$git_root"/*) fail 'source scan output must be outside the Git root to prevent self-scanning evidence' ;;
  esac
  trivy_cache=${TRIVY_CACHE_DIR:-"$output_dir/.trivy-cache"}
  mkdir -p "$trivy_cache"
  trivy_cache=$(CDPATH='' cd -- "$trivy_cache" && pwd)
  case "$trivy_cache" in
    "$git_root"|"$git_root"/*) fail 'Trivy cache must be outside the Git root scanned as source' ;;
  esac
  prepare_trivy_database "$trivy_cache"
  record_trivy_database "$trivy_cache" "$output_dir"
  cp "$tool_file" "$output_dir/tool-images.env"

  scanner_canary_root=$(mktemp -d "${TMPDIR:-/tmp}/slots-source-canary.XXXXXX")
  trap 'rm -rf "$scanner_canary_root"' EXIT HUP INT TERM
  mkdir -p "$scanner_canary_root/gitleaks" "$scanner_canary_root/trivy"
  prepare_gitleaks_canary "$scanner_canary_root/gitleaks" "$output_dir"
  prepare_trivy_checks "$trivy_cache" "$output_dir" "$scanner_canary_root/trivy"

  docker run --rm --user "$host_uid:$host_gid" --read-only --network=none \
    "$GITLEAKS_IMAGE" version > "$output_dir/gitleaks-version.txt"
  docker run --rm --user "$host_uid:$host_gid" --read-only --network=none \
    "$TRIVY_IMAGE" --version > "$output_dir/trivy-version.txt"
  git -C "$git_root" rev-list HEAD --count > "$output_dir/gitleaks-history-commit-count.txt"

  status=0

  # govulncheck 通过 Go module checksum database 校验固定模块版本，并按可达调用链报告漏洞。
  if ! docker run --rm \
    --user "$host_uid:$host_gid" \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,size=768m \
    --tmpfs /run/govulncheck:rw,nosuid,nodev,exec,size=64m,mode=1777 \
    --env HOME=/tmp/home \
    --env GOPATH=/tmp/go \
    --env GOCACHE=/tmp/go-build \
    --env GOMODCACHE=/tmp/go-mod \
    --env GOBIN=/run/govulncheck \
    --env "GOVULNCHECK_MODULE=$GOVULNCHECK_MODULE" \
    --env "PROJECT_ROOT=$container_project_root" \
    --mount "type=bind,src=$git_root,dst=/workspace,readonly" \
    --mount "type=bind,src=$output_dir,dst=/out" \
    "$GOLANG_IMAGE" sh -euc '
      mkdir -p "$HOME" "$GOPATH" "$GOCACHE" "$GOMODCACHE" "$GOBIN"
      go install "$GOVULNCHECK_MODULE"
      "$GOBIN/govulncheck" -version > /out/govulncheck-version.txt
      sha256sum "$GOBIN/govulncheck" > /out/govulncheck-binary.sha256
      cd "$PROJECT_ROOT/server"
      "$GOBIN/govulncheck" -json ./... > /out/govulncheck.json
    '
  then
    status=1
  fi

  # 完整依赖树与生产依赖树分别留档；任一 HIGH/CRITICAL advisory 都阻断发布。
  if ! docker run --rm \
    --user "$host_uid:$host_gid" \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,size=256m \
    --env HOME=/tmp \
    --env npm_config_cache=/tmp/npm-cache \
    --env npm_config_update_notifier=false \
    --env "PROJECT_ROOT=$container_project_root" \
    --mount "type=bind,src=$git_root,dst=/workspace,readonly" \
    --mount "type=bind,src=$output_dir,dst=/out" \
    "$NODE_IMAGE" sh -euc '
      cd "$PROJECT_ROOT/web"
      result=0
      npm audit --package-lock-only --audit-level=high --json > /out/npm-audit-all.json || result=1
      npm audit --package-lock-only --omit=dev --audit-level=high --json > /out/npm-audit-production.json || result=1
      exit "$result"
    '
  then
    status=1
  fi

  # 当前发布提交可达历史与工作树分别扫描；HEAD 边界排除检出时附带的无关远端引用，
  # 禁用仓库 ignore/allow，防止发布范围内的检查被静默收窄。
  if ! docker run --rm \
    --user "$host_uid:$host_gid" \
    --read-only \
    --network=none \
    --tmpfs /tmp:rw,nosuid,nodev,size=256m \
    --mount "type=bind,src=$git_root,dst=/workspace,readonly" \
    --mount "type=bind,src=$output_dir,dst=/out" \
    "$GITLEAKS_IMAGE" git /workspace --log-opts='--full-history HEAD --diff-filter=tuxdb' \
      --no-banner --redact=100 --exit-code 1 \
      --gitleaks-ignore-path /dev/null --ignore-gitleaks-allow \
      --report-format json --report-path /out/gitleaks-history.json
  then
    status=1
  fi
  if ! docker run --rm \
    --user "$host_uid:$host_gid" \
    --read-only \
    --network=none \
    --tmpfs /tmp:rw,nosuid,nodev,size=256m \
    --mount "type=bind,src=$git_root,dst=/workspace,readonly" \
    --mount "type=bind,src=$output_dir,dst=/out" \
    "$GITLEAKS_IMAGE" dir /workspace --no-banner --redact=100 --exit-code 1 \
      --gitleaks-ignore-path /dev/null --ignore-gitleaks-allow \
      --report-format json --report-path /out/gitleaks-working-tree.json
  then
    status=1
  fi

  # 双标准 SBOM 固定具体 schema 版本，避免工具升级后格式静默漂移。
  if ! docker run --rm \
    --user "$host_uid:$host_gid" \
    --read-only \
    --network=none \
    --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 \
    --env HOME=/tmp/syft-home \
    --env XDG_CACHE_HOME=/tmp/syft-cache \
    --env SYFT_CHECK_FOR_APP_UPDATE=false \
    --mount "type=bind,src=$git_root,dst=/workspace,readonly" \
    --mount "type=bind,src=$output_dir,dst=/out" \
    "$SYFT_IMAGE" "dir:/workspace" \
      --output cyclonedx-json@1.6=/out/source.cyclonedx.json \
      --output spdx-json@2.3=/out/source.spdx.json
  then
    status=1
  fi

  # 离线前再次验证动态 DB/checks 身份；完整 Git 根包含父级 .github 发布工作流。
  "$trivy_asset_verifier" "$trivy_cache" "$output_dir" >/dev/null
  # 依赖漏洞与生产配置分开扫描，避免把 Docker ignore 文件误当成 Dockerfile。
  if ! docker run --rm \
    --user "$host_uid:$host_gid" \
    --read-only \
    --network=none \
    --tmpfs /tmp:rw,nosuid,nodev,size=512m \
    --mount "type=bind,src=$git_root,dst=/workspace,readonly" \
    --mount "type=bind,src=$output_dir,dst=/out" \
    --mount "type=bind,src=$trivy_cache,dst=/cache,readonly" \
    "$TRIVY_IMAGE" fs /workspace \
      --config /dev/null --cache-dir /cache --cache-backend memory \
      --skip-db-update --no-progress \
      --ignorefile /dev/null \
      --scanners vuln --severity HIGH,CRITICAL --exit-code 1 \
      --format json --output /out/trivy-filesystem.json
  then
    status=1
  fi

  # 只复制正式 Dockerfile 与使用有效生产值渲染的 Helm Chart，输入清单由后置契约逐项核验。
  if ! docker run --rm \
    --user "$host_uid:$host_gid" \
    --read-only \
    --network=none \
    --tmpfs /tmp:rw,nosuid,nodev,size=512m \
    --tmpfs /scan:rw,nosuid,nodev,size=64m,mode=1777 \
    --env "PROJECT_ROOT=$container_project_root" \
    --mount "type=bind,src=$git_root,dst=/workspace,readonly" \
    --mount "type=bind,src=$output_dir,dst=/out" \
    --mount "type=bind,src=$trivy_cache,dst=/cache,readonly" \
    --entrypoint /bin/sh \
    "$TRIVY_IMAGE" -euc '
      mkdir -p \
        /scan/dockerfiles/root \
        /scan/dockerfiles/cluster \
        /scan/dockerfiles/local-services \
        /scan/dockerfiles/local-web \
        /scan/dockerfiles/web \
        /scan/cluster
      cp "$PROJECT_ROOT/deploy/Dockerfile" /scan/dockerfiles/root/Dockerfile
      cp "$PROJECT_ROOT/deploy/cluster-production/Dockerfile.services" /scan/dockerfiles/cluster/Dockerfile.services
      cp "$PROJECT_ROOT/deploy/local-production/Dockerfile.services" /scan/dockerfiles/local-services/Dockerfile.services
      cp "$PROJECT_ROOT/deploy/local-production/Dockerfile.web" /scan/dockerfiles/local-web/Dockerfile.web
      cp "$PROJECT_ROOT/deploy/web/Dockerfile" /scan/dockerfiles/web/Dockerfile
      cp -R "$PROJECT_ROOT/deploy/cluster-production/chart" /scan/cluster/chart
      cp "$PROJECT_ROOT/deploy/cluster-production/values.example.yaml" /scan/cluster/values.example.yaml
      trivy config /scan \
        --config /dev/null --cache-dir /cache \
        --checks-bundle-repository mirror.gcr.io/aquasec/trivy-checks:2 \
        --skip-check-update \
        --ignorefile /dev/null \
        --helm-values /scan/cluster/values.example.yaml \
        --severity HIGH,CRITICAL --exit-code 1 \
        --format json --output /out/trivy-config.json
    '
  then
    status=1
  fi

  if ! docker run --rm \
    --user "$host_uid:$host_gid" \
    --read-only \
    --network=none \
    --mount "type=bind,src=$script_dir,dst=/policy,readonly" \
    --mount "type=bind,src=$output_dir,dst=/out,readonly" \
    "$NODE_IMAGE" node /policy/verify-trivy-source-report.mjs \
      /out/trivy-filesystem.json /out/trivy-config.json
  then
    status=1
  fi

  return "$status"
}

run_image_scan() {
  test "$#" -eq 3 || usage
  image_ref=$1
  report_name=$2
  case "$image_ref" in
    *[!A-Za-z0-9_./:@+-]*|'') fail 'IMAGE_REF contains unsupported characters' ;;
  esac
  case "$report_name" in
    ''|[!a-z0-9]*|*[!a-z0-9._-]*) fail 'REPORT_NAME must use lowercase letters, digits, dot, underscore or hyphen' ;;
  esac
  prepare_output_dir "$3"
  trivy_cache=${TRIVY_CACHE_DIR:-"$output_dir/.trivy-cache"}
  prepare_trivy_database "$trivy_cache"
  trivy_cache=$(CDPATH='' cd -- "$trivy_cache" && pwd)
  record_trivy_database "$trivy_cache" "$output_dir"
  cp "$tool_file" "$output_dir/tool-images.env"

  archive_dir=$(mktemp -d "${TMPDIR:-/tmp}/slots-image-scan.XXXXXX")
  trap 'rm -rf "$archive_dir"' EXIT HUP INT TERM
  docker image inspect "$image_ref" >/dev/null 2>&1 || fail "image not found: $image_ref"
  docker image save --output "$archive_dir/image.tar" "$image_ref"
  chmod a+r "$archive_dir/image.tar"

  status=0
  if ! docker run --rm \
    --user "$host_uid:$host_gid" \
    --read-only \
    --network=none \
    --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 \
    --env HOME=/tmp/syft-home \
    --env XDG_CACHE_HOME=/tmp/syft-cache \
    --env SYFT_CHECK_FOR_APP_UPDATE=false \
    --mount "type=bind,src=$archive_dir,dst=/input,readonly" \
    --mount "type=bind,src=$output_dir,dst=/out" \
    "$SYFT_IMAGE" docker-archive:/input/image.tar \
      --output "cyclonedx-json@1.6=/out/$report_name.cyclonedx.json" \
      --output "spdx-json@2.3=/out/$report_name.spdx.json"
  then
    status=1
  fi

  if ! docker run --rm \
    --user "$host_uid:$host_gid" \
    --read-only \
    --network=none \
    --tmpfs /tmp:rw,nosuid,nodev,size=512m \
    --mount "type=bind,src=$archive_dir,dst=/input,readonly" \
    --mount "type=bind,src=$output_dir,dst=/out" \
    --mount "type=bind,src=$trivy_cache,dst=/cache,readonly" \
    "$TRIVY_IMAGE" image --input /input/image.tar \
      --config /dev/null --cache-dir /cache --cache-backend memory --skip-db-update --no-progress \
      --ignorefile /dev/null \
      --scanners vuln,secret --severity HIGH,CRITICAL --exit-code 1 \
      --format json --output "/out/$report_name.trivy.json"
  then
    status=1
  fi

  if ! sanitize_trivy_image_report "$output_dir/$report_name.trivy.json"; then
    status=1
  fi

  docker image inspect --format '{{index .RepoDigests 0}}' "$image_ref" > "$output_dir/$report_name.repo-digest.txt" 2>/dev/null || \
    docker image inspect --format '{{.Id}}' "$image_ref" > "$output_dir/$report_name.repo-digest.txt"
  return "$status"
}

run_oci_archive_scan() {
  test "$#" -eq 3 || usage
  archive_path=$1
  report_name=$2
  test -s "$archive_path" || fail 'OCI archive is missing or empty'
  test ! -L "$archive_path" || fail 'OCI archive must not be a symlink'
  archive_path=$(CDPATH='' cd -- "$(dirname -- "$archive_path")" && pwd)/$(basename -- "$archive_path")
  case "$report_name" in
    ''|[!a-z0-9]*|*[!a-z0-9._-]*) fail 'REPORT_NAME must use lowercase letters, digits, dot, underscore or hyphen' ;;
  esac
  prepare_output_dir "$3"
  trivy_cache=${TRIVY_CACHE_DIR:-"$output_dir/.trivy-cache"}
  prepare_trivy_database "$trivy_cache"
  trivy_cache=$(CDPATH='' cd -- "$trivy_cache" && pwd)
  record_trivy_database "$trivy_cache" "$output_dir"
  cp "$tool_file" "$output_dir/tool-images.env"

  archive_dir=$(dirname -- "$archive_path")
  archive_name=$(basename -- "$archive_path")
  status=0
  if ! docker run --rm \
    --user "$host_uid:$host_gid" \
    --read-only \
    --network=none \
    --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 \
    --env HOME=/tmp/syft-home \
    --env XDG_CACHE_HOME=/tmp/syft-cache \
    --env SYFT_CHECK_FOR_APP_UPDATE=false \
    --env "ARCHIVE_NAME=$archive_name" \
    --mount "type=bind,src=$archive_dir,dst=/input,readonly" \
    --mount "type=bind,src=$output_dir,dst=/out" \
    "$SYFT_IMAGE" "oci-archive:/input/$archive_name" \
      --output "cyclonedx-json@1.6=/out/$report_name.cyclonedx.json" \
      --output "spdx-json@2.3=/out/$report_name.spdx.json"
  then
    status=1
  fi

  if ! docker run --rm \
    --user "$host_uid:$host_gid" \
    --read-only \
    --network=none \
    --tmpfs /tmp:rw,nosuid,nodev,size=512m \
    --env "ARCHIVE_NAME=$archive_name" \
    --mount "type=bind,src=$archive_dir,dst=/input,readonly" \
    --mount "type=bind,src=$output_dir,dst=/out" \
    --mount "type=bind,src=$trivy_cache,dst=/cache,readonly" \
    "$TRIVY_IMAGE" image --input "/input/$archive_name" \
      --config /dev/null --cache-dir /cache --cache-backend memory --skip-db-update --no-progress \
      --ignorefile /dev/null \
      --scanners vuln,secret --severity HIGH,CRITICAL --exit-code 1 \
      --format json --output "/out/$report_name.trivy.json"
  then
    status=1
  fi

  if ! sanitize_trivy_image_report "$output_dir/$report_name.trivy.json"; then
    status=1
  fi
  sha256sum "$archive_path" > "$output_dir/$report_name.oci-archive.sha256"
  return "$status"
}

test "$#" -ge 1 || usage
mode=$1
shift
case "$mode" in
  source) run_source_scan "$@" ;;
  image) run_image_scan "$@" ;;
  oci-archive) run_oci_archive_scan "$@" ;;
  *) usage ;;
esac
