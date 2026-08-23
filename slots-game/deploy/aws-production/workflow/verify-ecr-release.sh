#!/bin/sh

# 调用方必须已经通过 GitHub OIDC 取得只读 ECR 临时凭据并完成 ECR 登录。
set -eu
umask 077

fail() {
  printf '%s\n' "ECR 发布制品校验失败：$*" >&2
  exit 1
}

test "$#" -eq 5 || fail '必须传入发布标签、三个摘要和证据目录'
release_tag=$1
rgs_digest=$2
migrator_digest=$3
web_digest=$4
evidence_directory=$5

for command_name in aws docker jq grep; do
  command -v "$command_name" >/dev/null 2>&1 || fail "缺少命令：$command_name"
done

for variable_name in AWS_ACCOUNT_ID AWS_REGION AWS_ECR_RGS_RUNTIME_REPOSITORY \
  AWS_ECR_RGS_MIGRATOR_REPOSITORY AWS_ECR_WEB_REPOSITORY COSIGN_IMAGE \
  GITHUB_REPOSITORY GITHUB_SERVER_URL; do
  variable_value=$(printenv "$variable_name" 2>/dev/null || true)
  test -n "$variable_value" || fail "$variable_name 未配置"
done

test ! -e "$evidence_directory" || fail '证据目录必须尚不存在'
mkdir -m 0700 "$evidence_directory"
registry="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
certificate_identity="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/.github/workflows/supply-chain-release.yml@refs/tags/${release_tag}"
certificate_issuer='https://token.actions.githubusercontent.com'

verify_one() {
  artifact_name=$1
  repository_name=$2
  digest=$3
  image_reference="${registry}/${repository_name}@${digest}"

  printf '%s\n' "$repository_name" | grep -Eq '^[a-z0-9]+([._/-][a-z0-9]+)*$' || \
    fail "$artifact_name 的 ECR 仓库名格式错误"
  printf '%s\n' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || \
    fail "$artifact_name 不是完整摘要"

  repository_json=$(aws ecr describe-repositories \
    --repository-names "$repository_name" --query 'repositories[0]' --output json)
  printf '%s\n' "$repository_json" | jq -e --arg uri "${registry}/${repository_name}" '
    .repositoryUri == $uri and
    .imageTagMutability == "IMMUTABLE" and
    .encryptionConfiguration.encryptionType == "KMS"
  ' >/dev/null || fail "$artifact_name 的 ECR 仓库不满足不可变 KMS 契约"

  image_json=$(aws ecr describe-images --repository-name "$repository_name" \
    --image-ids "imageDigest=$digest" --query 'imageDetails[0]' --output json)
  printf '%s\n' "$image_json" | jq -e --arg digest "$digest" \
    '.imageDigest == $digest and .imageSizeInBytes > 0' >/dev/null || \
    fail "$artifact_name 摘要在固定仓库中不存在"

  docker pull "$image_reference" >/dev/null
  docker image inspect "$image_reference" >/dev/null
  docker_config=${DOCKER_CONFIG:-"$HOME/.docker"}
  test -s "$docker_config/config.json" || fail 'ECR Docker 临时登录配置不存在'

  run_cosign() {
    docker run --rm --user "$(id -u):$(id -g)" --read-only \
      --tmpfs /tmp:rw,nosuid,nodev,size=256m \
      --env HOME=/tmp/cosign-home --env DOCKER_CONFIG=/cosign-auth \
      --mount "type=bind,src=$docker_config,dst=/cosign-auth,readonly" \
      "$COSIGN_IMAGE" "$@"
  }

  run_cosign verify \
    --certificate-identity "$certificate_identity" \
    --certificate-oidc-issuer "$certificate_issuer" \
    --output json "$image_reference" > "$evidence_directory/${artifact_name}-cosign.json" || \
    fail "$artifact_name 的 Cosign 身份校验失败"
  test -s "$evidence_directory/${artifact_name}-cosign.json" || fail 'Cosign 证据为空'

  run_cosign verify-attestation \
    --certificate-identity "$certificate_identity" \
    --certificate-oidc-issuer "$certificate_issuer" \
    --type 'https://slsa.dev/provenance/v1' \
    --output json "$image_reference" > "$evidence_directory/${artifact_name}-provenance.json" || \
    fail "$artifact_name 缺少有效构建来源证明"
  test -s "$evidence_directory/${artifact_name}-provenance.json" || fail '构建来源证明为空'

  run_cosign verify-attestation \
    --certificate-identity "$certificate_identity" \
    --certificate-oidc-issuer "$certificate_issuer" \
    --type 'https://spdx.dev/Document' \
    --output json "$image_reference" > "$evidence_directory/${artifact_name}-sbom.json" || \
    fail "$artifact_name 缺少有效 SPDX SBOM 证明"
  test -s "$evidence_directory/${artifact_name}-sbom.json" || fail 'SBOM 证明为空'

  printf '%s=%s\n' "$artifact_name" "$image_reference" >> "$evidence_directory/verified-images.env"
}

verify_one RGS_IMAGE "$AWS_ECR_RGS_RUNTIME_REPOSITORY" "$rgs_digest"
verify_one MIGRATOR_IMAGE "$AWS_ECR_RGS_MIGRATOR_REPOSITORY" "$migrator_digest"
verify_one WEB_IMAGE "$AWS_ECR_WEB_REPOSITORY" "$web_digest"
chmod 0600 "$evidence_directory/verified-images.env"

printf '%s\n' '三个 ECR 发布摘要、Cosign 身份、来源证明和 SBOM 证明全部通过。'
