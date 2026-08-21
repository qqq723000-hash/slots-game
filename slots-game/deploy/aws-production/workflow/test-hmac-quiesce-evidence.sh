#!/usr/bin/env bash
# 使用纯本地 mock 覆盖 HMAC quiesce、失败自动恢复、固定证据校验与 resume。
set -euo pipefail

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
fixture_directory="$script_directory/fixtures"
test_root=$(mktemp -d "${TMPDIR:-/tmp}/slots-hmac-evidence-test.XXXXXX")
state="$test_root/state"
delivery="$test_root/delivery.json"
output_file="$test_root/github-output"
summary_file="$test_root/github-summary"

cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf '%s\n' "HMAC 停机证据 fixture 失败：$*" >&2
  exit 1
}

marker_file_for() {
  type=$1
  version=$2
  sha=$3
  reference_hash=$(printf '%s\n%s' "$version" "$sha" | sha256sum | awk '{ print $1 }')
  printf '%s/%s-marker-%s.json\n' "$state" "$type" "$reference_hash"
}

reset_state() {
  rm -rf "$state"
  mkdir -p "$state"
  touch "$state/api-hpa-present"
  printf '%s\n' 2 > "$state/api-replicas"
  : > "$output_file"
  : > "$summary_file"
}

export AWS_BIN="$fixture_directory/mock-hmac-aws.sh"
export KUBECTL_BIN="$fixture_directory/mock-hmac-kubectl.sh"
export MOCK_HMAC_STATE_DIR="$state"
export MOCK_HMAC_DELIVERY_FILE="$delivery"
export RUNNER_TEMP="$test_root"
export GITHUB_OUTPUT="$output_file"
export GITHUB_STEP_SUMMARY="$summary_file"
export GITHUB_REPOSITORY=company/slots-game
export GITHUB_REF=refs/heads/main
export GITHUB_REF_PROTECTED=true
export GITHUB_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export GITHUB_RUN_ID=9001
export GITHUB_RUN_ATTEMPT=1
export TARGET_ENVIRONMENT=prod-primary
export AWS_ACCOUNT_ID=123456789012
export AWS_REGION=ap-southeast-1
export AWS_HMAC_QUIESCE_ROLE_ARN=arn:aws:iam::123456789012:role/slots-hmac-quiescer
export AWS_HMAC_QUIESCE_PRODUCER_ROLE_ARN=$AWS_HMAC_QUIESCE_ROLE_ARN
export AWS_HMAC_QUIESCE_PRODUCER_WORKFLOW_REF=company/slots-game/.github/workflows/aws-hmac-quiesce-evidence.yml@refs/heads/main
export AWS_EKS_CLUSTER_NAME=slots-prod-primary
export AWS_EKS_NAMESPACE=slots-production
export AWS_HELM_RELEASE_NAME=slots
export AWS_TERRAFORM_DELIVERY_BUCKET=slots-terraform-delivery
export AWS_TERRAFORM_DELIVERY_KEY=delivery/prod-primary/application.json
export AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN=arn:aws:kms:ap-southeast-1:123456789012:key/11111111-1111-4111-8111-111111111111
export AWS_HMAC_QUIESCE_EVIDENCE_BUCKET=slots-hmac-evidence
export AWS_HMAC_QUIESCE_EVIDENCE_KEY=evidence/prod-primary/hmac-quiesce.json
export AWS_HMAC_QUIESCE_EVIDENCE_KMS_KEY_ARN=arn:aws:kms:ap-southeast-1:123456789012:key/22222222-2222-4222-8222-222222222222
export AWS_HMAC_QUIESCE_CANCELLATION_PREFIX=evidence/prod-primary/hmac-quiesce-cancellations
export AWS_HMAC_QUIESCE_COMPLETION_PREFIX=evidence/prod-primary/hmac-quiesce-completions
export KUBECONFIG="$test_root/kubeconfig"

jq --arg account "$AWS_ACCOUNT_ID" --arg region "$AWS_REGION" --arg cluster "$AWS_EKS_CLUSTER_NAME" '
  .cluster_arn = ("arn:aws:eks:" + $region + ":" + $account + ":cluster/" + $cluster)
' "$fixture_directory/live-delivery.json" > "$delivery"

reset_state
export INPUT_OPERATION=quiesce
export INPUT_EVIDENCE_VERSION_ID=''
export INPUT_EVIDENCE_SHA256=''
"$script_directory/validate-hmac-quiesce-environment.sh" >/dev/null
"$script_directory/manage-hmac-quiesce-evidence.sh" >/dev/null
test ! -f "$state/api-hpa-present" || fail 'quiesce 后 API HPA 仍存在'
test "$(cat "$state/api-replicas")" = 0 || fail 'quiesce 后 API 未缩到零副本'
test -f "$state/evidence.json" || fail 'quiesce 没有提交证据'
evidence_version=$(sed -n 's/^evidence_version_id=//p' "$output_file")
evidence_sha=$(sed -n 's/^evidence_sha256=//p' "$output_file")
test "$evidence_version" = evidence-version-1 || fail '证据 VersionId 输出错误'
printf '%s\n' "$evidence_sha" | grep -Eq '^[0-9a-f]{64}$' || fail '证据 SHA-256 输出错误'

export INPUT_OPERATION=resume
export INPUT_EVIDENCE_VERSION_ID=$evidence_version
export INPUT_EVIDENCE_SHA256=$evidence_sha
"$script_directory/validate-hmac-quiesce-environment.sh" >/dev/null
"$script_directory/manage-hmac-quiesce-evidence.sh" >/dev/null
test -f "$state/api-hpa-present" || fail 'resume 没有恢复 API HPA'
test "$(cat "$state/api-replicas")" = 2 || fail 'resume 没有恢复 API 暖副本'
test ! -f "$state/maintenance-lock.json" || fail 'resume 没有删除精确 maintenance lock'
test -f "$(marker_file_for cancellation "$evidence_version" "$evidence_sha")" || \
  fail 'resume 没有发布按证据派生的不可变 cancellation marker'

expired="$test_root/expired.json"
past_times=$(ruby -rtime -e 'now = Time.now.utc; puts (now - 7200).iso8601; puts (now - 3600).iso8601')
past_observed=$(printf '%s\n' "$past_times" | sed -n '1p')
past_expires=$(printf '%s\n' "$past_times" | sed -n '2p')
jq -S -c --arg observed "$past_observed" --arg expires "$past_expires" '
  .quiescence.observed_at = $observed | .quiescence.expires_at = $expires
' "$state/evidence.json" > "$expired"
expired_sha=$(sha256sum "$expired" | awk '{ print $1 }')
if HMAC_EVIDENCE_EXPECTED_SHA256=$expired_sha \
  ruby "$script_directory/verify-hmac-quiesce-evidence.rb" consume "$expired" >/dev/null 2>&1; then
  fail '过期证据仍可用于 Terraform consume'
fi
HMAC_EVIDENCE_EXPECTED_SHA256=$expired_sha \
  ruby "$script_directory/verify-hmac-quiesce-evidence.rb" resume "$expired" >/dev/null || \
  fail '原 TTL 合法的过期证据不能用于人工恢复'

tampered="$test_root/tampered.json"
jq -S -c '.quiescence.api.hpa_restore_manifest.spec.maxReplicas = 99' \
  "$state/evidence.json" > "$tampered"
tampered_sha=$(sha256sum "$tampered" | awk '{ print $1 }')
if HMAC_EVIDENCE_EXPECTED_SHA256=$tampered_sha \
  ruby "$script_directory/verify-hmac-quiesce-evidence.rb" resume "$tampered" >/dev/null 2>&1; then
  fail '恢复 HPA spec 被篡改仍通过证据门禁'
fi

reset_state
export INPUT_OPERATION=quiesce
export INPUT_EVIDENCE_VERSION_ID=''
export INPUT_EVIDENCE_SHA256=''
export MOCK_HMAC_AWS_MODE=put-failure
if "$script_directory/manage-hmac-quiesce-evidence.sh" >/dev/null 2>&1; then
  fail '证据上传失败仍返回成功'
fi
unset MOCK_HMAC_AWS_MODE
test -f "$state/api-hpa-present" || fail '证据上传失败后没有自动恢复 API HPA'
test "$(cat "$state/api-replicas")" = 2 || fail '证据上传失败后没有自动恢复 API 副本'

reset_state
export MOCK_HMAC_KUBECTL_MODE=worker-drift
if "$script_directory/manage-hmac-quiesce-evidence.sh" >/dev/null 2>&1; then
  fail 'Worker UID 漂移仍生成停机证据'
fi
unset MOCK_HMAC_KUBECTL_MODE
test -f "$state/api-hpa-present" || fail 'Worker 漂移后没有自动恢复 API HPA'
test "$(cat "$state/api-replicas")" = 2 || fail 'Worker 漂移后没有自动恢复 API 副本'

reset_state
export MOCK_HMAC_KUBECTL_MODE=term-after-zero
if "$script_directory/manage-hmac-quiesce-evidence.sh" >/dev/null 2>&1; then
  fail 'mutated 后收到 TERM 错误返回成功'
fi
unset MOCK_HMAC_KUBECTL_MODE
test -f "$state/api-hpa-present" || fail 'mutated 后收到 TERM 没有恢复 API HPA'
test "$(cat "$state/api-replicas")" = 2 || fail 'mutated 后收到 TERM 没有恢复 API 副本'

for failure_mode in lock-patch-failure lock-readback-failure; do
  reset_state
  export MOCK_HMAC_KUBECTL_MODE=$failure_mode
  if "$script_directory/manage-hmac-quiesce-evidence.sh" >/dev/null 2>&1; then
    fail "$failure_mode 仍错误提交停机证据"
  fi
  unset MOCK_HMAC_KUBECTL_MODE
  orphan_sha=$(sha256sum "$state/evidence.json" | awk '{ print $1 }')
  test -f "$(marker_file_for cancellation evidence-version-1 "$orphan_sha")" || \
    fail "$failure_mode 没有在恢复旧 Pod 前取消已上传证据"
  test -f "$state/api-hpa-present" || fail "$failure_mode 后没有恢复 API HPA"
  test "$(cat "$state/api-replicas")" = 2 || fail "$failure_mode 后没有恢复 API 副本"
  if INPUT_EVIDENCE_VERSION_ID=evidence-version-1 INPUT_EVIDENCE_SHA256=$orphan_sha \
    "$script_directory/hmac-evidence-marker.sh" check all "$state/evidence.json" >/dev/null 2>&1; then
    fail "$failure_mode 的孤儿证据仍可通过 marker 门禁"
  fi
done

reset_state
export MOCK_HMAC_KUBECTL_MODE=lock-patch-failure
export MOCK_HMAC_AWS_MODE=marker-put-failure
if "$script_directory/manage-hmac-quiesce-evidence.sh" >/dev/null 2>&1; then
  fail 'cancellation marker 发布失败仍错误返回成功'
fi
unset MOCK_HMAC_KUBECTL_MODE MOCK_HMAC_AWS_MODE
test ! -f "$state/api-hpa-present" || fail 'cancellation marker 失败后错误恢复了 API HPA'
test "$(cat "$state/api-replicas")" = 0 || fail 'cancellation marker 失败后错误启动了旧 API Pod'
test -f "$state/maintenance-lock.json" || fail 'cancellation marker 失败后错误删除了安全锁'

# E2 marker 不得遮蔽 E1；每份证据使用由 VersionId 与 SHA 派生的不可变对象路径。
reset_state
evidence_one="$test_root/evidence-one.json"
evidence_two="$test_root/evidence-two.json"
cp "$fixture_directory/hmac-evidence-valid.json" "$evidence_one" 2>/dev/null || \
  cp "$delivery" "$evidence_one"
printf '%s\n' '{"fixture":"evidence-two"}' > "$evidence_two"
evidence_one_sha=$(sha256sum "$evidence_one" | awk '{ print $1 }')
evidence_two_sha=$(sha256sum "$evidence_two" | awk '{ print $1 }')
INPUT_EVIDENCE_VERSION_ID=evidence-version-E1 INPUT_EVIDENCE_SHA256=$evidence_one_sha \
  "$script_directory/hmac-evidence-marker.sh" publish cancellation "$evidence_one" >/dev/null
INPUT_EVIDENCE_VERSION_ID=evidence-version-E2 INPUT_EVIDENCE_SHA256=$evidence_two_sha \
  "$script_directory/hmac-evidence-marker.sh" publish cancellation "$evidence_two" >/dev/null
test -f "$(marker_file_for cancellation evidence-version-E1 "$evidence_one_sha")" || fail 'E1 marker 被 E2 覆盖'
test -f "$(marker_file_for cancellation evidence-version-E2 "$evidence_two_sha")" || fail 'E2 marker 未独立保存'
if INPUT_EVIDENCE_VERSION_ID=evidence-version-E1 INPUT_EVIDENCE_SHA256=$evidence_one_sha \
  "$script_directory/hmac-evidence-marker.sh" check all "$evidence_one" >/dev/null 2>&1; then
  fail 'E2 发布后 E1 cancellation 被遮蔽，旧证据可重放'
fi

reset_state
"$script_directory/manage-hmac-quiesce-evidence.sh" >/dev/null
evidence_version=$(sed -n 's/^evidence_version_id=//p' "$output_file")
evidence_sha=$(sed -n 's/^evidence_sha256=//p' "$output_file")
cp "$delivery" "$test_root/source-steady-delivery.json"
export INPUT_OPERATION=resume
export INPUT_EVIDENCE_VERSION_ID=$evidence_version
export INPUT_EVIDENCE_SHA256=$evidence_sha
jq '
  .valkey_rotation_mode = "hmac-maintenance" |
  .application_release_allowed = false | .maintenance_in_progress = true |
  .application_handoff.application_release_allowed = false |
  .application_handoff.maintenance_in_progress = true |
  .valkey_rotation_contract.rotation_mode = "hmac-maintenance" |
  .valkey_rotation_contract.application_release_allowed = false |
  .valkey_rotation_contract.maintenance_in_progress = true
' "$test_root/source-steady-delivery.json" > "$delivery"
if "$script_directory/manage-hmac-quiesce-evidence.sh" >/dev/null 2>&1; then
  fail 'latest delivery 处于 hmac-maintenance 时仍允许恢复旧 Pod'
fi
test "$(cat "$state/api-replicas")" = 0 || fail 'maintenance delivery 拒绝恢复后错误启动 API'
jq '
  .valkey_secret_name = "slots-rgs-shared-admission-v3" |
  .valkey_rotation_contract.published_secret_version = 3 |
  .valkey_rotation_contract.hmac_key_fingerprint = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
' "$test_root/source-steady-delivery.json" > "$delivery"
if "$script_directory/manage-hmac-quiesce-evidence.sh" >/dev/null 2>&1; then
  fail 'latest delivery 已到 target steady 时仍允许恢复旧 Pod'
fi
test "$(cat "$state/api-replicas")" = 0 || fail 'target steady 拒绝恢复后错误启动 API'
cp "$test_root/source-steady-delivery.json" "$delivery"
touch "$state/api-hpa-present"
if "$script_directory/manage-hmac-quiesce-evidence.sh" >/dev/null 2>&1; then
  fail 'resume 覆盖已出现的 HPA 漂移对象'
fi
test "$(cat "$state/api-replicas")" = 0 || fail '拒绝漂移恢复后错误启动 API'

steady_tfvars="$test_root/steady.tfvars.json"
hmac_tfvars="$test_root/hmac.tfvars.json"
jq -n --arg namespace "$AWS_EKS_NAMESPACE" --arg release "$AWS_HELM_RELEASE_NAME" '{configuration: {
  application_namespace: $namespace, helm_release_name: $release,
  valkey_rotation_mode: "steady", valkey_hmac_maintenance_approval: null
}}' > "$steady_tfvars"
export INPUT_HMAC_QUIESCE_EVIDENCE_VERSION_ID=''
export INPUT_HMAC_QUIESCE_EVIDENCE_SHA256=''
"$script_directory/validate-hmac-terraform-inputs.sh" "$steady_tfvars" >/dev/null
jq --arg bucket "$AWS_HMAC_QUIESCE_EVIDENCE_BUCKET" --arg key "$AWS_HMAC_QUIESCE_EVIDENCE_KEY" \
  --arg version "$evidence_version" --arg sha "$evidence_sha" '
    .configuration.valkey_rotation_mode = "hmac-maintenance" |
    .configuration.valkey_hmac_maintenance_approval = {
      bucket_reset_accepted: true,
      evidence_reference: {bucket: $bucket, key: $key, version_id: $version, sha256: $sha}
    }
  ' "$steady_tfvars" > "$hmac_tfvars"
export INPUT_HMAC_QUIESCE_EVIDENCE_VERSION_ID=$evidence_version
export INPUT_HMAC_QUIESCE_EVIDENCE_SHA256=$evidence_sha
"$script_directory/validate-hmac-terraform-inputs.sh" "$hmac_tfvars" >/dev/null
export INPUT_HMAC_QUIESCE_EVIDENCE_SHA256=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
if "$script_directory/validate-hmac-terraform-inputs.sh" "$hmac_tfvars" >/dev/null 2>&1; then
  fail 'tfvars approval 与 dispatch 证据 SHA 漂移仍通过'
fi

printf '%s\n' 'HMAC 停机证据 quiesce/resume 与负向 fixture 通过。'
