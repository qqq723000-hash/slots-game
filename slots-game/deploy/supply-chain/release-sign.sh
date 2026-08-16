#!/bin/sh

# 该脚本只签署已存在于 Registry 的不可变 digest。Registry 凭据、受保护发布环境和
# 审批人均由仓库外配置；缺少任何真实输入时直接失败，不创建本地占位签名或审批记录。
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
tool_file="$script_dir/tool-images.env"

fail() {
  printf '%s\n' "supply-chain release: $*" >&2
  exit 1
}

require_env() {
  variable_name=$1
  eval "variable_value=\${$variable_name-}"
  # 上一行按受控变量名间接取值，ShellCheck 无法追踪 eval 的赋值结果。
  # shellcheck disable=SC2154
  test -n "$variable_value" || fail "$variable_name is required"
}

validate_release_inputs() {
  require_digest=$1
  for variable_name in \
    SUPPLY_CHAIN_REGISTRY \
    SUPPLY_CHAIN_IMAGE_REPOSITORY \
    SUPPLY_CHAIN_ARTIFACT \
    SUPPLY_CHAIN_IMAGE_TAG \
    SUPPLY_CHAIN_EXPECTED_CERTIFICATE_IDENTITY \
    SUPPLY_CHAIN_EXPECTED_OIDC_ISSUER \
    GITHUB_EVENT_NAME \
    GITHUB_REF \
    GITHUB_REF_NAME \
    GITHUB_REF_PROTECTED \
    GITHUB_REPOSITORY \
    GITHUB_SERVER_URL \
    GITHUB_SHA \
    GITHUB_WORKFLOW_REF
  do
    require_env "$variable_name"
  done
  if [ "$require_digest" = true ]; then
    require_env SUPPLY_CHAIN_IMAGE_DIGEST
  fi

  test "$GITHUB_EVENT_NAME" = workflow_dispatch || fail 'release signing only accepts workflow_dispatch'
  test "$GITHUB_REF_PROTECTED" = true || fail 'release signing requires a protected Git ref'
  case "$GITHUB_REF" in
    refs/tags/*) : ;;
    *) fail 'release signing requires a protected tag ref' ;;
  esac
  printf '%s\n' "$GITHUB_SHA" | grep -Eq '^[0-9a-f]{40}$' || fail 'GITHUB_SHA must be a full commit SHA'
  case "$SUPPLY_CHAIN_ARTIFACT" in
    rgs-runtime|rgs-migrator)
      test -z "${RGS_BASE_URL-}${RGS_BET_OPTIONS_MINOR-}${RGS_DEFAULT_BET_MINOR-}${RGS_HOST_ORIGIN-}" || \
        fail 'RGS artifacts must not accept Web runtime configuration'
      ;;
    web-runtime)
      for variable_name in RGS_BASE_URL RGS_BET_OPTIONS_MINOR RGS_DEFAULT_BET_MINOR RGS_HOST_ORIGIN
      do
        require_env "$variable_name"
        eval "configuration_value=\${$variable_name-}"
        case "${configuration_value-}" in
          *"
"*|*""*) fail "$variable_name must not contain a line break" ;;
        esac
      done
      ;;
    *) fail 'SUPPLY_CHAIN_ARTIFACT is not an approved release target' ;;
  esac
  printf '%s\n' "$SUPPLY_CHAIN_IMAGE_TAG" | \
    grep -Eq '^[a-z0-9][a-z0-9._-]{0,127}$' || fail 'SUPPLY_CHAIN_IMAGE_TAG is not a canonical OCI tag'
  test "$SUPPLY_CHAIN_IMAGE_TAG" != latest || fail 'the mutable latest tag is forbidden'
  test "$SUPPLY_CHAIN_IMAGE_TAG" = "$GITHUB_REF_NAME" || fail 'image tag must exactly match the protected Git tag name'

  printf '%s\n' "$SUPPLY_CHAIN_REGISTRY" | \
    grep -Eq '^[a-z0-9][a-z0-9.-]*([:][0-9]{1,5})?$' || \
    fail 'SUPPLY_CHAIN_REGISTRY must be a lowercase HTTPS registry host without path or scheme'

  case "$SUPPLY_CHAIN_IMAGE_REPOSITORY" in
    "$SUPPLY_CHAIN_REGISTRY"/*) image_path=${SUPPLY_CHAIN_IMAGE_REPOSITORY#"$SUPPLY_CHAIN_REGISTRY"/} ;;
    *) fail 'SUPPLY_CHAIN_IMAGE_REPOSITORY must begin with the exact registry host' ;;
  esac
  printf '%s\n' "$image_path" | \
    grep -Eq '^[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*$' || \
    fail 'SUPPLY_CHAIN_IMAGE_REPOSITORY must not contain a tag, digest or non-canonical path'
  if [ "$require_digest" = true ]; then
    printf '%s\n' "$SUPPLY_CHAIN_IMAGE_DIGEST" | \
      grep -Eq '^sha256:[0-9a-f]{64}$' || fail 'SUPPLY_CHAIN_IMAGE_DIGEST must be an immutable sha256 digest'
  fi

  expected_workflow_ref="$GITHUB_REPOSITORY/.github/workflows/supply-chain-release.yml@$GITHUB_REF"
  test "$GITHUB_WORKFLOW_REF" = "$expected_workflow_ref" || fail 'workflow identity does not match the reviewed release workflow'
  computed_identity="$GITHUB_SERVER_URL/$expected_workflow_ref"
  test "$SUPPLY_CHAIN_EXPECTED_CERTIFICATE_IDENTITY" = "$computed_identity" || \
    fail 'certificate identity input does not exactly match this workflow and protected tag'
  test "$SUPPLY_CHAIN_EXPECTED_OIDC_ISSUER" = 'https://token.actions.githubusercontent.com' || \
    fail 'OIDC issuer must be the exact GitHub Actions issuer'
}

run_cosign() {
  docker_config=$1
  shift
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,size=256m \
    --env HOME=/tmp/cosign-home \
    --env DOCKER_CONFIG=/cosign-auth \
    --env ACTIONS_ID_TOKEN_REQUEST_URL \
    --env ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    --mount "type=bind,src=$docker_config,dst=/cosign-auth,readonly" \
    "$COSIGN_IMAGE" "$@"
}

sign_and_verify() {
  test "$#" -eq 1 || fail 'sign requires exactly one evidence output directory'
  validate_release_inputs true
  test -f "$tool_file" || fail 'missing tool-images.env'
  # shellcheck disable=SC1090
  . "$tool_file"
  command -v docker >/dev/null 2>&1 || fail 'docker is required for registry signing'
  require_env ACTIONS_ID_TOKEN_REQUEST_URL
  require_env ACTIONS_ID_TOKEN_REQUEST_TOKEN
  require_env HOME

  docker_config=${DOCKER_CONFIG:-"$HOME/.docker"}
  test -r "$docker_config/config.json" || fail 'authenticated Docker config is required'
  docker_config=$(CDPATH='' cd -- "$docker_config" && pwd)
  mkdir -p "$1"
  evidence_dir=$(CDPATH='' cd -- "$1" && pwd)
  image_reference="$SUPPLY_CHAIN_IMAGE_REPOSITORY@$SUPPLY_CHAIN_IMAGE_DIGEST"

  # 不传 --key、关闭透明日志或不安全 Registry 参数：使用 GitHub OIDC 的短命身份签名。
  run_cosign "$docker_config" sign --yes "$image_reference"
  if ! run_cosign "$docker_config" verify \
    --certificate-identity "$SUPPLY_CHAIN_EXPECTED_CERTIFICATE_IDENTITY" \
    --certificate-oidc-issuer "$SUPPLY_CHAIN_EXPECTED_OIDC_ISSUER" \
    --output json "$image_reference" > "$evidence_dir/cosign-verify.json"
  then
    rm -f "$evidence_dir/cosign-verify.json"
    fail 'Cosign verification did not match the exact approved workflow identity'
  fi
  test -s "$evidence_dir/cosign-verify.json" || fail 'Cosign verification evidence is empty'
}

collect_attestations() {
  test "$#" -eq 1 || fail 'collect-attestations requires exactly one evidence output directory'
  require_env RUNNER_TEMP
  path_list="$RUNNER_TEMP/created_attestation_paths.txt"
  test -s "$path_list" || fail 'GitHub attestation path list is missing'
  mkdir -p "$1/attestations"
  count=0
  while IFS= read -r attestation_path
  do
    case "$attestation_path" in
      "$RUNNER_TEMP"/*) : ;;
      *) fail 'attestation path escaped RUNNER_TEMP' ;;
    esac
    test -s "$attestation_path" || fail 'attestation bundle is missing or empty'
    count=$((count + 1))
    cp "$attestation_path" "$1/attestations/attestation-$count.sigstore.json"
  done < "$path_list"
  test "$count" -ge 2 || fail 'both provenance and SBOM attestations are required'
}

test "$#" -ge 1 || fail 'usage: release-sign.sh validate-build | validate | sign OUTPUT_DIR | collect-attestations OUTPUT_DIR'
command_name=$1
shift
case "$command_name" in
  validate)
    test "$#" -eq 0 || fail 'validate accepts no arguments'
    validate_release_inputs true
    ;;
  validate-build)
    test "$#" -eq 0 || fail 'validate-build accepts no arguments'
    validate_release_inputs false
    ;;
  sign) sign_and_verify "$@" ;;
  collect-attestations) collect_attestations "$@" ;;
  *) fail 'usage: release-sign.sh validate-build | validate | sign OUTPUT_DIR | collect-attestations OUTPUT_DIR' ;;
esac
