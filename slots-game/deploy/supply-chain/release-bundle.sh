#!/bin/sh

# 该脚本只在无 OIDC、无 Registry 凭据的构建权限域中生成发布包清单。特权发布 job
# 不执行仓库脚本，而是使用工作流内固定逻辑和上游 job output 独立复核所有摘要。
set -eu

fail() {
  printf '%s\n' "supply-chain release bundle: $*" >&2
  exit 1
}

require_env() {
  variable_name=$1
  eval "variable_value=\${$variable_name-}"
  # 变量名来自下方固定列表，不接受调用方提供任意表达式。
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
  if [ "$build_kind" = web-approved ]; then
    printf '%s\n' "$approval_digest" | grep -Eq '^[0-9a-f]{64}$' || \
      fail 'approved Web build must bind the exact approval SHA-256'
  else
    test "$approval_digest" = none || fail 'RGS build must not carry a Web approval digest'
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
  {
    printf 'BUNDLE_SCHEMA_VERSION=1\n'
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
    } >> "$GITHUB_OUTPUT"
  fi
}

command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required'
command_name=${1-}
case "$command_name" in
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
  *) fail 'usage: release-bundle.sh config-digest | finalize BUNDLE_DIR BUILD_KIND' ;;
esac
