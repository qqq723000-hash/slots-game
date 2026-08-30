#!/bin/sh

# 该脚本只在无 OIDC、无 Registry 凭据的构建权限域中生成发布包清单。特权发布 job
# 不执行仓库脚本，而是使用工作流内固定逻辑和上游 job output 独立复核所有摘要。
# English: This script only generates release package manifests in build permission domains with no OIDC and no
# Registry credentials. Privileged publishing job Instead of executing warehouse scripts, all summaries are
# independently reviewed using fixed logic within the workflow and upstream job output.
set -eu

fail() {
  printf '%s\n' "supply-chain release bundle: $*" >&2
  exit 1
}

require_env() {
  variable_name=$1
  eval "variable_value=\${$variable_name-}"
  # 变量名来自下方固定列表，不接受调用方提供任意表达式。
  # English: The variable name comes from the fixed list below and does not accept arbitrary expressions
  # provided by the caller.
  # shellcheck disable=SC2154
  test -n "$variable_value" || fail "$variable_name is required"
}

reject_line_break() {
  variable_name=$1
  eval "variable_value=\${$variable_name-}"
  case "$variable_value" in
    *"
"*|*""*) fail "$variable_name must not contain a line break" ;;
  esac
}

config_digest() {
  for variable_name in RGS_BASE_URL RGS_BET_OPTIONS_MINOR RGS_DEFAULT_BET_MINOR RGS_HOST_ORIGIN
  do
    reject_line_break "$variable_name"
  done
  printf 'RGS_BASE_URL=%s\nRGS_BET_OPTIONS_MINOR=%s\nRGS_DEFAULT_BET_MINOR=%s\nRGS_HOST_ORIGIN=%s\n' \
    "${RGS_BASE_URL-}" \
    "${RGS_BET_OPTIONS_MINOR-}" \
    "${RGS_DEFAULT_BET_MINOR-}" \
    "${RGS_HOST_ORIGIN-}" | sha256sum | awk '{ print $1 }'
}

validate_approval_expiry() {
  approval_expiry=$1
  require_future=$2
  command -v node >/dev/null 2>&1 || fail 'node is required to validate approval expiry'
  if ! ASSET_APPROVAL_EXPIRES_AT="$approval_expiry" REQUIRE_FUTURE="$require_future" \
    node -e '
      const value = process.env.ASSET_APPROVAL_EXPIRES_AT ?? "";
      const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
      const timestamp = Date.parse(value);
      const canonical = Number.isFinite(timestamp)
        ? new Date(timestamp).toISOString().replace(".000Z", "Z")
        : "";
      if (!pattern.test(value) || value !== canonical) process.exit(1);
      if (process.env.REQUIRE_FUTURE === "true" && timestamp <= Date.now()) process.exit(2);
    '
  then
    if [ "$require_future" = true ]; then
      fail 'approval has expired before bundle finalization or expiresAt is invalid'
    fi
    fail 'approval expiresAt is invalid'
  fi
}

approval_metadata() {
  test "$#" -eq 2 || fail 'usage: release-bundle.sh approval-metadata APPROVAL_FILE OUTPUT_FILE'
  approval_file=$1
  output_file=$2
  test -s "$approval_file" || fail 'approval file is missing or empty'
  test ! -L "$approval_file" || fail 'approval file must not be a symlink'
  test ! -e "$output_file" || fail 'approval metadata output must not already exist'

  # 只输出公开 expiresAt 和规范化元数据摘要；审批引用、辖区和素材明细的明文不跨权限域。
  # English: Only public expiresAt and standardized metadata summaries are output; the clear text of approval
  # references, jurisdictions, and assets details does not cross authority domains.
  canonical_metadata=$(jq -ceS '
    def trimmed:
      if type == "string" then gsub("^[[:space:]]+|[[:space:]]+$"; "")
      else error("metadata string is invalid") end;
    select(type == "object" and .schemaVersion == 1 and .status == "APPROVED")
    | (.approvalReference | trimmed) as $reference
    | select($reference != "")
    | select(.jurisdictions | type == "array" and length > 0)
    | ([.jurisdictions[] | trimmed] | select(all(.[]; . != ""))) as $jurisdictions
    | select(($jurisdictions | unique | length) == ($jurisdictions | length))
    | select(.expiresAt | type == "string"
        and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{3})?Z$"))
    | {
        schemaVersion: 1,
        status: "APPROVED",
        approvalReference: $reference,
        jurisdictions: ($jurisdictions | sort),
        expiresAt: (.expiresAt | sub("\\.000Z$"; "Z"))
      }
  ' "$approval_file") || fail 'approval metadata is invalid'
  test -n "$canonical_metadata" || fail 'approval metadata is invalid'
  approval_expiry=$(printf '%s' "$canonical_metadata" | jq -er '.expiresAt') || \
    fail 'approval metadata has no canonical expiresAt'
  validate_approval_expiry "$approval_expiry" false
  metadata_digest=$(printf '%s' "$canonical_metadata" | sha256sum | awk '{ print $1 }')

  umask 077
  {
    printf 'ASSET_APPROVAL_EXPIRES_AT=%s\n' "$approval_expiry"
    printf 'ASSET_APPROVAL_METADATA_SHA256=%s\n' "$metadata_digest"
  } > "$output_file"
}

finalize_bundle() {
  test "$#" -eq 2 || fail 'usage: release-bundle.sh finalize BUNDLE_DIR BUILD_KIND'
  bundle_dir=$1
  build_kind=$2
  for variable_name in \
    GITHUB_SHA \
    SOURCE_TREE_SHA \
    GITHUB_REF \
    GITHUB_WORKFLOW_REF \
    SUPPLY_CHAIN_ARTIFACT \
    SUPPLY_CHAIN_IMAGE_REPOSITORY \
    SUPPLY_CHAIN_IMAGE_TAG
  do
    require_env "$variable_name"
    reject_line_break "$variable_name"
  done
  printf '%s\n' "$GITHUB_SHA" | grep -Eq '^[0-9a-f]{40}$' || fail 'GITHUB_SHA must be a full commit SHA'
  printf '%s\n' "$SOURCE_TREE_SHA" | grep -Eq '^[0-9a-f]{40}$' || fail 'SOURCE_TREE_SHA must be a full Git tree SHA'
  case "$GITHUB_REF" in refs/tags/*) : ;; *) fail 'GITHUB_REF must be a tag ref' ;; esac
  case "$SUPPLY_CHAIN_ARTIFACT" in rgs-runtime|rgs-migrator|web-runtime) : ;; *) fail 'unsupported artifact' ;; esac
  case "$build_kind" in rgs-unprivileged|web-approved) : ;; *) fail 'unsupported build kind' ;; esac
  case "$SUPPLY_CHAIN_ARTIFACT:$build_kind" in
    rgs-runtime:rgs-unprivileged|rgs-migrator:rgs-unprivileged|web-runtime:web-approved) : ;;
    *) fail 'artifact and build kind do not match' ;;
  esac

  bundle_dir=$(CDPATH='' cd -- "$bundle_dir" && pwd)
  for required_file in \
    release-image.oci.tar \
    release-image.cyclonedx.json \
    release-image.spdx.json \
    release-image.trivy.json \
    build-metadata.json \
    tool-images.env
  do
    test -s "$bundle_dir/$required_file" || fail "missing $required_file"
    test ! -L "$bundle_dir/$required_file" || fail "$required_file must not be a symlink"
  done

  # OCI 归档只能含相对安全路径，并且必须是单平台、单 manifest 的标准 OCI layout。
  # English: OCI archives can only contain relative security paths, and must be a single-platform,
  # single-manifest standard OCI layout.
  if tar -tf "$bundle_dir/release-image.oci.tar" | grep -E '(^/|(^|/)\.\.(/|$))' >/dev/null; then
    fail 'OCI archive contains an unsafe path'
  fi
  tar -xOf "$bundle_dir/release-image.oci.tar" oci-layout | \
    grep -Eq '"imageLayoutVersion"[[:space:]]*:[[:space:]]*"1\.0\.0"' || \
    fail 'OCI archive layout marker is invalid'
  oci_manifest_digest=$(tar -xOf "$bundle_dir/release-image.oci.tar" index.json | \
    jq -er 'select(.schemaVersion == 2) | .manifests | select(length == 1) | .[0].digest') || \
    fail 'OCI archive must contain exactly one manifest'
  printf '%s\n' "$oci_manifest_digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || \
    fail 'OCI manifest digest is invalid'
  metadata_digest=$(jq -er '."containerimage.digest"' "$bundle_dir/build-metadata.json") || \
    fail 'BuildKit metadata is missing the container digest'
  test "$metadata_digest" = "$oci_manifest_digest" || fail 'BuildKit and OCI manifest digests differ'
  jq -e '.bomFormat == "CycloneDX" and .specVersion == "1.6"' \
    "$bundle_dir/release-image.cyclonedx.json" >/dev/null || fail 'CycloneDX 1.6 SBOM is invalid'
  jq -e '.spdxVersion == "SPDX-2.3"' "$bundle_dir/release-image.spdx.json" >/dev/null || \
    fail 'SPDX 2.3 SBOM is invalid'
  jq -e '(type == "array") or (.Results | type == "array")' "$bundle_dir/release-image.trivy.json" >/dev/null || \
    fail 'Trivy image report is invalid'

  approval_digest=${SUPPLY_CHAIN_APPROVAL_SHA256:-none}
  approval_expiry=${SUPPLY_CHAIN_APPROVAL_EXPIRES_AT:-none}
  approval_metadata_digest=${SUPPLY_CHAIN_APPROVAL_METADATA_SHA256:-none}
  if [ "$build_kind" = web-approved ]; then
    printf '%s\n' "$approval_digest" | grep -Eq '^[0-9a-f]{64}$' || \
      fail 'approved Web build must bind the exact approval SHA-256'
    printf '%s\n' "$approval_metadata_digest" | grep -Eq '^[0-9a-f]{64}$' || \
      fail 'approved Web build must bind normalized approval metadata SHA-256'
    validate_approval_expiry "$approval_expiry" true
  else
    test "$approval_digest" = none || fail 'RGS build must not carry a Web approval digest'
    test "$approval_expiry" = none || fail 'RGS build must not carry a Web approval expiry'
    test "$approval_metadata_digest" = none || fail 'RGS build must not carry Web approval metadata'
    test -z "${RGS_BASE_URL-}${RGS_BET_OPTIONS_MINOR-}${RGS_DEFAULT_BET_MINOR-}${RGS_HOST_ORIGIN-}" || \
      fail 'RGS artifact must not carry Web runtime configuration'
  fi

  configuration_digest=$(config_digest)
  local_image_ref="slots-release-bundle:${SUPPLY_CHAIN_ARTIFACT}-${GITHUB_SHA}"
  (
    cd "$bundle_dir"
    sha256sum \
      build-metadata.json \
      release-image.cyclonedx.json \
      release-image.oci.tar \
      release-image.spdx.json \
      release-image.trivy.json \
      tool-images.env > bundle-checksums.sha256
  )
  checksums_digest=$(sha256sum "$bundle_dir/bundle-checksums.sha256" | awk '{ print $1 }')
  archive_digest=$(sha256sum "$bundle_dir/release-image.oci.tar" | awk '{ print $1 }')
  spdx_digest=$(sha256sum "$bundle_dir/release-image.spdx.json" | awk '{ print $1 }')

  # 固定键值清单不 source 执行；发布 job 逐行精确匹配，防止制品替换或参数混淆。
  # English: Fixed key-value lists are not sourced for execution; published jobs are matched row-by-row exactly
  # to prevent artifact substitution or parameter confusion.
  {
    printf 'BUNDLE_SCHEMA_VERSION=2\n'
    printf 'SOURCE_SHA=%s\n' "$GITHUB_SHA"
    printf 'SOURCE_TREE_SHA=%s\n' "$SOURCE_TREE_SHA"
    printf 'SOURCE_REF=%s\n' "$GITHUB_REF"
    printf 'SOURCE_WORKFLOW_REF=%s\n' "$GITHUB_WORKFLOW_REF"
    printf 'ARTIFACT=%s\n' "$SUPPLY_CHAIN_ARTIFACT"
    printf 'IMAGE_REPOSITORY=%s\n' "$SUPPLY_CHAIN_IMAGE_REPOSITORY"
    printf 'IMAGE_TAG=%s\n' "$SUPPLY_CHAIN_IMAGE_TAG"
    printf 'TARGET_PLATFORM=linux/amd64\n'
    printf 'BUILD_KIND=%s\n' "$build_kind"
    printf 'LOCAL_IMAGE_REF=%s\n' "$local_image_ref"
    printf 'CONFIGURATION_SHA256=%s\n' "$configuration_digest"
    printf 'ASSET_APPROVAL_SHA256=%s\n' "$approval_digest"
    printf 'ASSET_APPROVAL_EXPIRES_AT=%s\n' "$approval_expiry"
    printf 'ASSET_APPROVAL_METADATA_SHA256=%s\n' "$approval_metadata_digest"
    printf 'OCI_MANIFEST_DIGEST=%s\n' "$oci_manifest_digest"
    printf 'OCI_ARCHIVE_SHA256=%s\n' "$archive_digest"
    printf 'SPDX_SHA256=%s\n' "$spdx_digest"
    printf 'CHECKSUMS_SHA256=%s\n' "$checksums_digest"
  } > "$bundle_dir/bundle-manifest.env"
  manifest_digest=$(sha256sum "$bundle_dir/bundle-manifest.env" | awk '{ print $1 }')

  if [ -n "${GITHUB_OUTPUT-}" ]; then
    {
      printf 'bundle_manifest_sha256=%s\n' "$manifest_digest"
      printf 'bundle_checksums_sha256=%s\n' "$checksums_digest"
      printf 'oci_archive_sha256=%s\n' "$archive_digest"
      printf 'spdx_sha256=%s\n' "$spdx_digest"
      printf 'configuration_sha256=%s\n' "$configuration_digest"
      printf 'approval_expires_at=%s\n' "$approval_expiry"
      printf 'approval_metadata_sha256=%s\n' "$approval_metadata_digest"
    } >> "$GITHUB_OUTPUT"
  fi
}

command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required'
command_name=${1-}
case "$command_name" in
  approval-metadata)
    shift
    command -v jq >/dev/null 2>&1 || fail 'jq is required'
    approval_metadata "$@"
    ;;
  config-digest)
    test "$#" -eq 1 || fail 'config-digest accepts no arguments'
    config_digest
    ;;
  finalize)
    shift
    command -v jq >/dev/null 2>&1 || fail 'jq is required'
    command -v tar >/dev/null 2>&1 || fail 'tar is required'
    finalize_bundle "$@"
    ;;
  *) fail 'usage: release-bundle.sh approval-metadata APPROVAL_FILE OUTPUT_FILE | config-digest | finalize BUNDLE_DIR BUILD_KIND' ;;
esac
