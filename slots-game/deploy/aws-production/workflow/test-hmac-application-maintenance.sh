#!/usr/bin/env bash
# 用本地 Helm 与 Kubernetes/AWS mock 证明 HMAC 两阶段恢复不会启动旧 Secret Pod。
set -euo pipefail

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
fixture_directory="$script_directory/fixtures"
slots_directory=$(CDPATH='' cd -- "$script_directory/../../.." && pwd)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/slots-hmac-application-test.XXXXXX")
state="$test_root/state"
source_delivery="$test_root/source-delivery.json"
target_delivery="$test_root/target-delivery.json"
target_values="$test_root/target-values.yaml"
safe_render="$test_root/safe-render.yaml"
finalize_attestation="$test_root/deployment-evidence/hmac-finalize-attestation.json"
output_file="$test_root/github-output"
summary_file="$test_root/github-summary"
trap 'rm -rf "$test_root"' EXIT

fail() {
  printf '%s\n' "HMAC 应用两阶段 fixture 失败：$*" >&2
  exit 1
}

mkdir -p "$state"
mkdir -p "$test_root/deployment-evidence"
touch "$state/api-hpa-present"
printf '%s\n' 2 > "$state/api-replicas"
: > "$output_file"
: > "$summary_file"

export AWS_BIN="$fixture_directory/mock-hmac-aws.sh"
export KUBECTL_BIN="$fixture_directory/mock-hmac-kubectl.sh"
export MOCK_HMAC_STATE_DIR="$state"
export MOCK_HMAC_DELIVERY_FILE="$source_delivery"
export RUNNER_TEMP="$test_root"
export GITHUB_OUTPUT="$output_file"
export GITHUB_STEP_SUMMARY="$summary_file"
export GITHUB_REPOSITORY=company/slots-game
export GITHUB_WORKFLOW_REF=company/slots-game/.github/workflows/aws-application-deploy.yml@refs/heads/main
export GITHUB_REF=refs/heads/main
export GITHUB_REF_PROTECTED=true
export GITHUB_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export GITHUB_RUN_ID=9101
export GITHUB_RUN_ATTEMPT=1
export TARGET_ENVIRONMENT=prod-primary
export INPUT_TARGET_ENVIRONMENT=$TARGET_ENVIRONMENT
export AWS_ACCOUNT_ID=123456789012
export AWS_REGION=ap-southeast-1
export AWS_HMAC_QUIESCE_ROLE_ARN=arn:aws:iam::123456789012:role/slots-hmac-quiescer
export AWS_APPLICATION_DEPLOY_ROLE_ARN=arn:aws:iam::123456789012:role/slots-application-deployer
export AWS_HMAC_QUIESCE_PRODUCER_ROLE_ARN=$AWS_HMAC_QUIESCE_ROLE_ARN
export AWS_HMAC_QUIESCE_PRODUCER_WORKFLOW_REF=company/slots-game/.github/workflows/aws-hmac-quiesce-evidence.yml@refs/heads/main
export AWS_EKS_CLUSTER_NAME=slots-prod-primary
export AWS_EKS_NAMESPACE=slots-production
export AWS_HELM_RELEASE_NAME=slots
export AWS_TERRAFORM_DELIVERY_BUCKET=slots-terraform-delivery
export AWS_TERRAFORM_DELIVERY_KEY=delivery/prod-primary/application.json
export AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN=arn:aws:kms:ap-southeast-1:123456789012:key/11111111-1111-4111-8111-111111111111
export AWS_TERRAFORM_DELIVERY_VERSION_ID=delivery-version-1
export AWS_HMAC_QUIESCE_EVIDENCE_BUCKET=slots-hmac-evidence
export AWS_HMAC_QUIESCE_EVIDENCE_KEY=evidence/prod-primary/hmac-quiesce.json
export AWS_HMAC_QUIESCE_EVIDENCE_KMS_KEY_ARN=arn:aws:kms:ap-southeast-1:123456789012:key/22222222-2222-4222-8222-222222222222
export AWS_HMAC_QUIESCE_CANCELLATION_PREFIX=evidence/prod-primary/hmac-quiesce-cancellations
export AWS_HMAC_QUIESCE_COMPLETION_PREFIX=evidence/prod-primary/hmac-quiesce-completions
export KUBECONFIG="$test_root/kubeconfig"
export DEPLOYMENT_EVIDENCE="$test_root/deployment-evidence"

jq --arg account "$AWS_ACCOUNT_ID" --arg region "$AWS_REGION" --arg cluster "$AWS_EKS_CLUSTER_NAME" '
  .cluster_arn = ("arn:aws:eks:" + $region + ":" + $account + ":cluster/" + $cluster)
' "$fixture_directory/live-delivery.json" > "$source_delivery"

export INPUT_OPERATION=quiesce
export INPUT_EVIDENCE_VERSION_ID=''
export INPUT_EVIDENCE_SHA256=''
"$script_directory/manage-hmac-quiesce-evidence.sh" >/dev/null
evidence_version=$(sed -n 's/^evidence_version_id=//p' "$output_file")
evidence_sha=$(sed -n 's/^evidence_sha256=//p' "$output_file")
evidence_file="$state/evidence.json"
export INPUT_EVIDENCE_VERSION_ID=$evidence_version
export INPUT_EVIDENCE_SHA256=$evidence_sha

jq '
  .valkey_secret_name = "slots-rgs-shared-admission-v3" |
  .valkey_secret_arn = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:slots-shared-v3-AbCdEf" |
  .application_handoff.external_secret_resource_names["shared-admission"] = .valkey_secret_name |
  .valkey_rotation_contract.published_secret_version = 3 |
  .valkey_rotation_contract.hmac_key_fingerprint = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
' "$source_delivery" > "$target_delivery"

# Terraform 已发布 target steady 后允许原 60 分钟证据过期，但必须由私网 runner 重新证明实时安全状态。
expired_times=$(ruby -rtime -e 'now = Time.now.utc; puts (now - 7200).iso8601; puts (now - 3600).iso8601')
expired_observed=$(printf '%s\n' "$expired_times" | sed -n '1p')
expired_at=$(printf '%s\n' "$expired_times" | sed -n '2p')
jq -S -c --arg observed "$expired_observed" --arg expires "$expired_at" '
  .quiescence.observed_at = $observed | .quiescence.expires_at = $expires
' "$evidence_file" > "$state/evidence-expired.json"
mv "$state/evidence-expired.json" "$evidence_file"
evidence_sha=$(sha256sum "$evidence_file" | awk '{ print $1 }')
metadata=$(cat "$state/evidence-metadata")
metadata=$(printf '%s\n' "$metadata" | sed -E \
  -e "s/content-sha256=[^,]*/content-sha256=${evidence_sha}/" \
  -e "s/observed-at=[^,]*/observed-at=${expired_observed}/" \
  -e "s/expires-at=[^,]*/expires-at=${expired_at}/")
printf '%s\n' "$metadata" > "$state/evidence-metadata"
jq --arg sha "$evidence_sha" --arg expires "$expired_at" '
  .data.evidenceSha256 = $sha | .data.evidenceExpiresAt = $expires
' "$state/maintenance-lock.json" > "$state/maintenance-lock.tmp"
mv "$state/maintenance-lock.tmp" "$state/maintenance-lock.json"
export INPUT_EVIDENCE_SHA256=$evidence_sha
expired_download="$test_root/expired-download.json"
if "$script_directory/download-hmac-quiesce-evidence.sh" consume "$expired_download" >/dev/null 2>&1; then
  fail 'Terraform consume 错误接受 target 发布后已过期的原证据'
fi
"$script_directory/download-hmac-quiesce-evidence.sh" finalize "$expired_download" >/dev/null || \
  fail 'application finalize 无法读取完整但已过期的原证据'
cmp -s "$expired_download" "$evidence_file" || fail 'finalize 下载没有绑定原证据字节'

if "$script_directory/hmac-application-maintenance-gate.sh" standard >/dev/null 2>&1; then
  fail 'quiesce lock 存在时普通发布仍通过'
fi
if "$script_directory/hmac-application-maintenance-gate.sh" \
  locked "$source_delivery" "$evidence_file" "$finalize_attestation" >/dev/null 2>&1; then
  fail '过期原证据在 latest delivery 尚未到 target steady 时仍生成 finalize 复证'
fi
"$script_directory/hmac-evidence-marker.sh" publish cancellation "$evidence_file" >/dev/null
if "$script_directory/hmac-application-maintenance-gate.sh" \
  locked "$target_delivery" "$evidence_file" "$finalize_attestation" >/dev/null 2>&1; then
  fail '已取消的过期原证据仍生成 finalize 复证'
fi
reference_hash=$(printf '%s\n%s' "$evidence_version" "$evidence_sha" | sha256sum | awk '{ print $1 }')
rm -f "$state/cancellation-marker-${reference_hash}.json" \
  "$state/cancellation-marker-${reference_hash}.metadata"
"$script_directory/hmac-application-maintenance-gate.sh" \
  locked "$target_delivery" "$evidence_file" "$finalize_attestation" >/dev/null
ruby "$script_directory/verify-hmac-finalize-attestation.rb" \
  "$finalize_attestation" "$target_delivery" "$evidence_file" >/dev/null
future_epoch=$(ruby -rtime -e 'puts (Time.now.utc + 1800).to_i')
if HMAC_FINALIZE_NOW_EPOCH=$future_epoch \
  ruby "$script_directory/verify-hmac-finalize-attestation.rb" \
    "$finalize_attestation" "$target_delivery" "$evidence_file" >/dev/null 2>&1; then
  fail '过期 finalize 短时复证仍可启动 maintenance Phase A'
fi

printf '%s\n' 1 > "$state/api-replicas"
if "$script_directory/hmac-application-maintenance-gate.sh" \
  locked "$target_delivery" "$evidence_file" "$finalize_attestation" >/dev/null 2>&1; then
  fail 'finalize 实时复证接受 API 非零副本'
fi
printf '%s\n' 0 > "$state/api-replicas"
touch "$state/api-hpa-present"
if "$script_directory/hmac-application-maintenance-gate.sh" \
  locked "$target_delivery" "$evidence_file" "$finalize_attestation" >/dev/null 2>&1; then
  fail 'finalize 实时复证接受已重建 API HPA'
fi
rm -f "$state/api-hpa-present"
export MOCK_HMAC_KUBECTL_MODE=worker-drift
if "$script_directory/hmac-application-maintenance-gate.sh" \
  locked "$target_delivery" "$evidence_file" "$finalize_attestation" >/dev/null 2>&1; then
  fail 'finalize 实时复证接受 Worker UID 漂移'
fi
unset MOCK_HMAC_KUBECTL_MODE

ruby -ryaml -e '
  value = YAML.load_file(ARGV.fetch(0))
  value.fetch("externalSecrets").fetch("sharedAdmission")["name"] = ARGV.fetch(2)
  File.binwrite(ARGV.fetch(1), YAML.dump(value))
' "$fixture_directory/live-values.yaml" "$target_values" slots-rgs-shared-admission-v3
helm template "$AWS_HELM_RELEASE_NAME" "$slots_directory/deploy/cluster-production/chart" \
  --namespace "$AWS_EKS_NAMESPACE" --values "$slots_directory/deploy/aws-production/values.example.yaml" \
  --values "$target_values" --is-upgrade \
  --set rgs.maintenanceQuiesced=true > "$safe_render"
"$script_directory/hmac-application-maintenance-gate.sh" \
  pre "$target_delivery" "$evidence_file" "$safe_render" >/dev/null

# Phase A 在应用任何对象前失败：旧模板仍被零副本和无 HPA 锁住，不能启动旧 Secret Pod。
rm -f "$state/pod-start-log"
"$script_directory/hmac-application-maintenance-gate.sh" \
  relock "$target_delivery" "$evidence_file" >/dev/null
test ! -s "$state/pod-start-log" || fail 'Phase A 前置失败启动了旧 Secret Pod'

# Phase A 已应用 target 模板但命令随后失败：安全 revision 仍然只有零副本且无 API HPA。
printf '%s\n' slots-rgs-shared-admission-v3 > "$state/api-secret-name"
printf '%s\n' true > "$state/api-maintenance-quiesced"
"$script_directory/hmac-application-maintenance-gate.sh" \
  phase-a "$target_delivery" "$evidence_file" >/dev/null
test ! -s "$state/pod-start-log" || fail 'Phase A 失败后启动了 Pod'

cp "$state/maintenance-lock.json" "$test_root/lock-good.json"
jq '.metadata.uid = "77777777-7777-4777-8777-777777777777"' \
  "$state/maintenance-lock.json" > "$state/maintenance-lock.tmp"
mv "$state/maintenance-lock.tmp" "$state/maintenance-lock.json"
if "$script_directory/hmac-application-maintenance-gate.sh" \
  phase-a "$target_delivery" "$evidence_file" >/dev/null 2>&1; then
  fail 'maintenance lock UID 漂移仍通过 Phase A 门禁'
fi
cp "$test_root/lock-good.json" "$state/maintenance-lock.json"

# Phase B 注入失败并模拟 atomic 回滚：回滚目标只能是 Phase A 的 target Secret 安全 revision。
printf '%s\n' false > "$state/api-maintenance-quiesced"
printf '%s\n' 2 > "$state/api-replicas"
touch "$state/api-hpa-present"
"$KUBECTL_BIN" get pod --namespace "$AWS_EKS_NAMESPACE" \
  --selector "app.kubernetes.io/instance=${AWS_HELM_RELEASE_NAME},app.kubernetes.io/component=rgs" \
  --output json >/dev/null
rm -f "$state/api-hpa-present"
printf '%s\n' 0 > "$state/api-replicas"
printf '%s\n' true > "$state/api-maintenance-quiesced"
"$script_directory/hmac-application-maintenance-gate.sh" \
  relock-target "$target_delivery" "$evidence_file" >/dev/null
if grep -F -x slots-rgs-shared-admission-v1 "$state/pod-start-log" >/dev/null 2>&1; then
  fail 'Phase A/B 失败注入观察到旧 Secret Pod 启动'
fi
grep -F -x slots-rgs-shared-admission-v3 "$state/pod-start-log" >/dev/null || \
  fail 'Phase B 模拟没有证明只可能启动 target Secret Pod'

# 成功的 Phase B 恢复新 HPA/API，完成标记落在证据派生路径，随后删除精确 UID lock。
printf '%s\n' false > "$state/api-maintenance-quiesced"
printf '%s\n' 2 > "$state/api-replicas"
touch "$state/api-hpa-present"
export MOCK_HMAC_KUBECTL_MODE=api-hpa-spec-drift
if "$script_directory/hmac-application-maintenance-gate.sh" \
  post "$target_delivery" "$evidence_file" >/dev/null 2>&1; then
  fail 'Phase B live HPA spec 漂移仍通过证据 SHA 门禁'
fi
unset MOCK_HMAC_KUBECTL_MODE
test -f "$state/maintenance-lock.json" || fail 'HPA spec 漂移后错误删除了 maintenance lock'
"$script_directory/hmac-application-maintenance-gate.sh" \
  post "$target_delivery" "$evidence_file" >/dev/null
test ! -f "$state/maintenance-lock.json" || fail 'Phase B 成功后没有删除精确 lock'
test -f "$state/completion-marker-${reference_hash}.json" || fail 'Phase B 没有发布不可变 completion marker'
"$script_directory/hmac-application-maintenance-gate.sh" standard >/dev/null

export MOCK_HMAC_KUBECTL_MODE=lock-check-error
if "$script_directory/hmac-application-maintenance-gate.sh" standard >/dev/null 2>&1; then
  fail '普通发布在 lock 查询错误时没有失败闭合'
fi
unset MOCK_HMAC_KUBECTL_MODE

if "$KUBECTL_BIN" delete configmap/slots-hmac-maintenance-lock --namespace "$AWS_EKS_NAMESPACE" \
  --preconditions uid=66666666-6666-4666-8666-666666666666 >/dev/null 2>&1; then
  fail 'mock 错误接受真实 kubectl 不支持的 delete --preconditions 参数'
fi

# 私网 runner 预装 kubectl；本地存在真实客户端时同时锁定其 CLI 契约，避免 mock 接受不存在的参数。
if command -v kubectl >/dev/null 2>&1; then
  kubectl_delete_help=$(kubectl delete --help)
  printf '%s\n' "$kubectl_delete_help" | grep -F -- '--wait=true' >/dev/null || \
    fail '真实 kubectl delete 帮助缺少工作流使用的 --wait 参数'
  printf '%s\n' "$kubectl_delete_help" | grep -F -- '--timeout=0s' >/dev/null || \
    fail '真实 kubectl delete 帮助缺少工作流使用的 --timeout 参数'
  if printf '%s\n' "$kubectl_delete_help" | grep -F -- '--preconditions' >/dev/null; then
    fail '真实 kubectl delete CLI 契约发生变化，需要重新审计 lock 删除实现'
  fi
  kubectl_contract_error="$test_root/kubectl-preconditions-error.txt"
  if kubectl delete configmap/slots-hmac-cli-contract --dry-run=client \
    --preconditions uid=66666666-6666-4666-8666-666666666666 \
    >"$kubectl_contract_error" 2>&1; then
    fail '真实 kubectl 意外接受 delete --preconditions'
  fi
  grep -E 'unknown flag.*preconditions' "$kubectl_contract_error" >/dev/null || \
    fail '真实 kubectl 没有以未知参数拒绝 delete --preconditions'
fi

printf '%s\n' 'HMAC 应用 Phase A/B 失败注入与零旧 Secret Pod fixture 通过。'
