#!/usr/bin/env bash
# 在普通发布或 HMAC maintenance-complete 前后验证持久锁和零旧 Pod 边界。
set -euo pipefail

test "$#" -ge 1 || exit 64
mode=$1
delivery_file=${2:-}
evidence_file=${3:-}
rendered_file=${4:-}
KUBECTL_BIN=${KUBECTL_BIN:-kubectl}
script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
lock_name=slots-hmac-maintenance-lock
temporary_directory=$(mktemp -d "${RUNNER_TEMP:-/tmp}/slots-hmac-app-gate.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  printf '%s\n' "HMAC 应用维护门禁失败：$*" >&2
  exit 1
}

get_lock() {
  "$KUBECTL_BIN" get "configmap/$lock_name" --namespace "$AWS_EKS_NAMESPACE" --output json
}

if test "$mode" = standard; then
  if ! "$KUBECTL_BIN" get "configmap/$lock_name" --namespace "$AWS_EKS_NAMESPACE" \
    --ignore-not-found --output json > "$temporary_directory/lock.json"; then
    fail '无法失败闭合地检查 HMAC maintenance lock'
  fi
  if test -s "$temporary_directory/lock.json"; then
    fail '存在 HMAC maintenance lock，普通应用发布禁止重建 API/HPA'
  fi
  printf '%s\n' 'HMAC 应用维护门禁通过：不存在 maintenance lock。'
  exit 0
fi

case "$mode" in locked|pre|phase-a|post|relock|relock-target) ;; *) fail '门禁模式不受支持' ;; esac
test -f "$delivery_file" -a -f "$evidence_file" || fail '缺少 delivery 或 evidence'
HMAC_EVIDENCE_EXPECTED_SHA256=$INPUT_EVIDENCE_SHA256 \
  ruby "$script_directory/verify-hmac-quiesce-evidence.rb" finalize "$evidence_file" >/dev/null
lock_file="$temporary_directory/lock.json"
get_lock > "$lock_file" || fail 'maintenance-complete 缺少持久 lock'

evidence_lock_uid=$(jq -er '.quiescence.lock.uid' "$evidence_file")
evidence_active_slot=$(jq -er '.rotation.observed_active_slot' "$evidence_file")
evidence_old_secret_version=$(jq -er '.rotation.observed_secret_version' "$evidence_file")
evidence_target_secret_version=$(jq -er '.rotation.target_secret_version' "$evidence_file")
evidence_old_hmac=$(jq -er '.rotation.observed_hmac_key_fingerprint' "$evidence_file")
evidence_expires_at=$(jq -er '.quiescence.expires_at' "$evidence_file")
api_name=$(jq -er '.quiescence.api.deployment_name' "$evidence_file")
api_uid=$(jq -er '.quiescence.api.uid' "$evidence_file")
api_hpa_name=$(jq -er '.quiescence.api.hpa_name' "$evidence_file")
worker_name=$(jq -er '.quiescence.worker.deployment_name' "$evidence_file")
worker_uid=$(jq -er '.quiescence.worker.uid' "$evidence_file")
worker_hpa_name=$(jq -er '.quiescence.worker.hpa_name' "$evidence_file")
worker_hpa_uid=$(jq -er '.quiescence.worker.hpa_uid' "$evidence_file")

jq -e --arg uid "$evidence_lock_uid" --arg release "$AWS_HELM_RELEASE_NAME" \
  --arg evidence_version "$INPUT_EVIDENCE_VERSION_ID" --arg evidence_sha "$INPUT_EVIDENCE_SHA256" \
  --arg active_slot "$evidence_active_slot" --arg old_version "$evidence_old_secret_version" \
  --arg target_version "$evidence_target_secret_version" --arg old_hmac "$evidence_old_hmac" \
  --arg expires_at "$evidence_expires_at" \
  --arg api_name "$api_name" --arg api_uid "$api_uid" --arg worker_name "$worker_name" \
  --arg worker_uid "$worker_uid" '
    .metadata.uid == $uid and .metadata.labels["app.kubernetes.io/instance"] == $release and
    .metadata.labels["slots-game.io/purpose"] == "hmac-maintenance" and
    .data.status == "quiesced" and .data.evidenceVersionId == $evidence_version and
    .data.evidenceSha256 == $evidence_sha and .data.evidenceExpiresAt == $expires_at and
    .data.observedActiveSlot == $active_slot and
    .data.observedSecretVersion == $old_version and .data.targetSecretVersion == $target_version and
    .data.observedHmacFingerprint == $old_hmac and
    .data.apiDeploymentName == $api_name and .data.apiDeploymentUid == $api_uid and
    .data.workerDeploymentName == $worker_name and .data.workerDeploymentUid == $worker_uid
  ' "$lock_file" >/dev/null || fail 'maintenance lock 与证据内容漂移'

target_secret_name=$(jq -er --argjson target "$evidence_target_secret_version" \
  --arg active "$evidence_active_slot" --arg old_hmac "$evidence_old_hmac" '
  .valkey_secret_name as $name |
  select(
    .valkey_rotation_mode == "steady" and
    .valkey_rotation_contract.rotation_mode == "steady" and
    .application_release_allowed == true and .maintenance_in_progress == false and
    .application_handoff.application_release_allowed == true and
    .application_handoff.maintenance_in_progress == false and
    .valkey_rotation_contract.application_release_allowed == true and
    .valkey_rotation_contract.maintenance_in_progress == false and
    .application_namespace == env.AWS_EKS_NAMESPACE and
    .helm_release_name == env.AWS_HELM_RELEASE_NAME and
    .valkey_active_slot == $active and
    .valkey_rotation_contract.published_secret_version == $target and
    .valkey_rotation_contract.hmac_key_fingerprint != $old_hmac and
    (.valkey_rotation_contract.hmac_key_fingerprint | test("^[0-9a-f]{64}$")) and
    ($name | endswith("-v" + ($target | tostring)))
  ) |
  $name
' "$delivery_file") || fail 'latest delivery 尚未完成 target HMAC/同槽 Secret 并退出 steady'

get_deployment() {
  name=$1
  "$KUBECTL_BIN" get "deployment/$name" --namespace "$AWS_EKS_NAMESPACE" --output json
}

verify_worker() {
  worker_file="$temporary_directory/worker.json"
  worker_hpa_file="$temporary_directory/worker-hpa.json"
  worker_pods_file="$temporary_directory/worker-pods.json"
  get_deployment "$worker_name" > "$worker_file"
  "$KUBECTL_BIN" get "horizontalpodautoscaler/$worker_hpa_name" --namespace "$AWS_EKS_NAMESPACE" \
    --output json > "$worker_hpa_file"
  "$KUBECTL_BIN" get pod --namespace "$AWS_EKS_NAMESPACE" \
    --selector "app.kubernetes.io/instance=${AWS_HELM_RELEASE_NAME},app.kubernetes.io/component=rgs-worker" \
    --output json > "$worker_pods_file"
  jq -e --arg uid "$worker_uid" '
    .metadata.uid == $uid and .spec.replicas >= 1 and
    (.status.readyReplicas // 0) == .spec.replicas and
    (.status.availableReplicas // 0) == .spec.replicas
  ' "$worker_file" >/dev/null || fail 'Worker Deployment 未持续可用或 UID 漂移'
  test "$(jq -er '.metadata.uid' "$worker_hpa_file")" = "$worker_hpa_uid" || fail 'Worker HPA UID 漂移'
  worker_desired=$(jq -er '.spec.replicas' "$worker_file")
  worker_pod_count=$(jq '.items | length' "$worker_pods_file")
  worker_ready_pod_count=$(jq '[.items[] | select(
    .metadata.deletionTimestamp == null and
    any(.status.conditions[]?; .type == "Ready" and .status == "True")
  )] | length' "$worker_pods_file")
  test "$worker_pod_count" -ge "$worker_desired" -a \
    "$worker_ready_pod_count" -eq "$worker_pod_count" || fail 'Worker Pod 未持续全部就绪'
}

verify_template_secret() {
  deployment_json=$1
  jq -e --arg secret "$target_secret_name" '
    [.spec.template.spec.containers[] | select(.name == "rgs")] as $containers |
    ($containers | length) == 1 and
    ($containers[0].env | map(select(.name == "RGS_SHARED_ADMISSION_USERNAME"))) == [{
      name: "RGS_SHARED_ADMISSION_USERNAME",
      valueFrom: {secretKeyRef: {name: $secret, key: "username"}}
    }] and
    ($containers[0].env | map(select(.name == "RGS_SHARED_ADMISSION_PASSWORD_FILE"))) == [{
      name: "RGS_SHARED_ADMISSION_PASSWORD_FILE", value: "/run/rgs/shared-admission/password"
    }] and
    ($containers[0].env | map(select(.name == "RGS_SHARED_ADMISSION_HMAC_KEY_FILE"))) == [{
      name: "RGS_SHARED_ADMISSION_HMAC_KEY_FILE", value: "/run/rgs/shared-admission/hmac.key"
    }] and
    ($containers[0].env | map(select(.name == "RGS_SHARED_ADMISSION_ROOT_CA_FILE"))) == [{
      name: "RGS_SHARED_ADMISSION_ROOT_CA_FILE", value: "/run/rgs/shared-admission/root-ca.pem"
    }] and
    ([.spec.template.spec.volumes[] | select(.name == "shared-admission-source")] | length) == 1 and
    ([.spec.template.spec.volumes[] | select(.name == "shared-admission-source")][0].secret as $source |
      $source.secretName == $secret and $source.defaultMode == 288 and $source.items == [
        {key: "password", path: "password"},
        {key: "hmac.key", path: "hmac.key"},
        {key: "root-ca.pem", path: "root-ca.pem"}
      ]
    ) and
    ([.spec.template.spec.containers[].env[]? | select(
      .name == "RGS_SHARED_ADMISSION_PASSWORD" or
      .name == "RGS_SHARED_ADMISSION_HMAC_KEY" or
      .name == "RGS_SHARED_ADMISSION_ROOT_CA_PEM"
    )] | length) == 0
  ' "$deployment_json" >/dev/null || fail 'API Pod 模板未精确切换到 target 不可变 Secret'
}

write_finalize_attestation() {
  output_file=$1
  test -n "$output_file" || fail 'locked 模式缺少 finalize 复证输出路径'
  expected_workflow_ref="$GITHUB_REPOSITORY/.github/workflows/aws-application-deploy.yml@refs/heads/main"
  test "$GITHUB_WORKFLOW_REF" = "$expected_workflow_ref" || \
    fail 'finalize 复证只能由本仓库 main 上的固定应用工作流生成'
  "$script_directory/hmac-evidence-marker.sh" check all "$evidence_file" >/dev/null
  timestamps=$(ruby -rtime -e 'now = Time.now.utc; puts now.iso8601; puts (now + 900).iso8601')
  finalize_observed_at=$(printf '%s\n' "$timestamps" | sed -n '1p')
  finalize_expires_at=$(printf '%s\n' "$timestamps" | sed -n '2p')
  finalize_delivery_sha=$(sha256sum "$delivery_file" | awk '{ print $1 }')
  finalize_hmac=$(jq -er '.valkey_rotation_contract.hmac_key_fingerprint' "$delivery_file")
  api_desired=$(jq -er '.spec.replicas' "$api_file")
  api_ready=$(jq '(.status.readyReplicas // 0)' "$api_file")
  api_available=$(jq '(.status.availableReplicas // 0)' "$api_file")
  worker_ready=$(jq '(.status.readyReplicas // 0)' "$worker_file")
  worker_available=$(jq '(.status.availableReplicas // 0)' "$worker_file")
  finalize_temporary="$temporary_directory/finalize-attestation.json"
  jq -n -S -c \
    --arg repository "$GITHUB_REPOSITORY" \
    --arg workflow_ref "$GITHUB_WORKFLOW_REF" \
    --arg source_sha "$GITHUB_SHA" --arg run_id "$GITHUB_RUN_ID" \
    --arg run_attempt "$GITHUB_RUN_ATTEMPT" --arg producer_environment "$TARGET_ENVIRONMENT" \
    --arg producer_role "$AWS_APPLICATION_DEPLOY_ROLE_ARN" \
    --arg environment "$TARGET_ENVIRONMENT" --arg account "$AWS_ACCOUNT_ID" \
    --arg region "$AWS_REGION" --arg cluster "$AWS_EKS_CLUSTER_NAME" \
    --arg namespace "$AWS_EKS_NAMESPACE" --arg release "$AWS_HELM_RELEASE_NAME" \
    --arg evidence_bucket "$AWS_HMAC_QUIESCE_EVIDENCE_BUCKET" \
    --arg evidence_key "$AWS_HMAC_QUIESCE_EVIDENCE_KEY" \
    --arg evidence_version "$INPUT_EVIDENCE_VERSION_ID" --arg evidence_sha "$INPUT_EVIDENCE_SHA256" \
    --arg delivery_bucket "$AWS_TERRAFORM_DELIVERY_BUCKET" --arg delivery_key "$AWS_TERRAFORM_DELIVERY_KEY" \
    --arg delivery_version "$AWS_TERRAFORM_DELIVERY_VERSION_ID" --arg delivery_sha "$finalize_delivery_sha" \
    --arg active_slot "$evidence_active_slot" --argjson target_version "$evidence_target_secret_version" \
    --arg target_secret "$target_secret_name" --arg target_hmac "$finalize_hmac" \
    --arg observed_at "$finalize_observed_at" --arg expires_at "$finalize_expires_at" \
    --arg lock_name "$lock_name" --arg lock_uid "$evidence_lock_uid" \
    --arg api_name "$api_name" --arg api_uid "$api_uid" --argjson api_desired "$api_desired" \
    --argjson api_ready "$api_ready" --argjson api_available "$api_available" \
    --arg worker_name "$worker_name" --arg worker_uid "$worker_uid" \
    --arg worker_hpa_name "$worker_hpa_name" --arg worker_hpa_uid "$worker_hpa_uid" \
    --argjson worker_desired "$worker_desired" --argjson worker_ready "$worker_ready" \
    --argjson worker_available "$worker_available" --argjson worker_pods "$worker_pod_count" \
    --argjson worker_ready_pods "$worker_ready_pod_count" '{
      schema: "slots-game/hmac-finalize-attestation/v1",
      producer: {
        repository: $repository, workflow_ref: $workflow_ref, source_sha: $source_sha,
        run_id: $run_id, run_attempt: $run_attempt, environment: $producer_environment,
        role_arn: $producer_role
      },
      target: {
        environment: $environment, aws_account_id: $account, aws_region: $region,
        eks_cluster_name: $cluster, kubernetes_namespace: $namespace, helm_release_name: $release
      },
      evidence_reference: {
        bucket: $evidence_bucket, key: $evidence_key, version_id: $evidence_version, sha256: $evidence_sha
      },
      target_delivery: {
        bucket: $delivery_bucket, key: $delivery_key, version_id: $delivery_version, sha256: $delivery_sha
      },
      rotation: {
        active_slot: $active_slot, target_secret_version: $target_version,
        target_secret_name: $target_secret, hmac_key_fingerprint: $target_hmac
      },
      quiescence: {
        observed_at: $observed_at, expires_at: $expires_at,
        lock: {name: $lock_name, uid: $lock_uid},
        api: {
          deployment_name: $api_name, uid: $api_uid, desired: $api_desired,
          ready: $api_ready, available: $api_available, pod_count: 0, hpa_present: false
        },
        worker: {
          deployment_name: $worker_name, uid: $worker_uid,
          hpa_name: $worker_hpa_name, hpa_uid: $worker_hpa_uid,
          desired: $worker_desired, ready: $worker_ready, available: $worker_available,
          pod_count: $worker_pods, ready_pod_count: $worker_ready_pods
        }
      }
    }' > "$finalize_temporary"
  chmod 0600 "$finalize_temporary"
  mv "$finalize_temporary" "$output_file"
}

verify_worker

if test "$mode" = relock || test "$mode" = relock-target; then
  if "$KUBECTL_BIN" get "horizontalpodautoscaler/$api_hpa_name" --namespace "$AWS_EKS_NAMESPACE" \
    --output json > "$temporary_directory/api-hpa.json" 2>/dev/null; then
    jq -e --arg release "$AWS_HELM_RELEASE_NAME" --arg api "$api_name" '
      .metadata.labels["app.kubernetes.io/instance"] == $release and
      .spec.scaleTargetRef == {apiVersion: "apps/v1", kind: "Deployment", name: $api}
    ' "$temporary_directory/api-hpa.json" >/dev/null || fail '拒绝删除漂移的 API HPA'
    "$KUBECTL_BIN" delete "horizontalpodautoscaler/$api_hpa_name" --namespace "$AWS_EKS_NAMESPACE" \
      --wait=true --timeout 2m >/dev/null
  fi
  "$KUBECTL_BIN" scale "deployment/$api_name" --namespace "$AWS_EKS_NAMESPACE" --replicas 0 >/dev/null
  for _attempt in $(seq 1 60); do
    get_deployment "$api_name" > "$temporary_directory/api.json"
    "$KUBECTL_BIN" get pod --namespace "$AWS_EKS_NAMESPACE" \
      --selector "app.kubernetes.io/instance=${AWS_HELM_RELEASE_NAME},app.kubernetes.io/component=rgs" \
      --output json > "$temporary_directory/api-pods.json"
    if jq -e --arg uid "$api_uid" '.metadata.uid == $uid and .spec.replicas == 0 and
      (.status.readyReplicas // 0) == 0 and (.status.availableReplicas // 0) == 0' \
      "$temporary_directory/api.json" >/dev/null &&
      test "$(jq '.items | length' "$temporary_directory/api-pods.json")" -eq 0; then
      if test "$mode" = relock-target; then
        verify_template_secret "$temporary_directory/api.json"
      fi
      printf '%s\n' 'maintenance-complete 失败后已重新锁定 API 零副本。'
      exit 0
    fi
    sleep 5
  done
  fail 'maintenance-complete 失败后无法恢复零副本锁定'
fi

api_file="$temporary_directory/api.json"
get_deployment "$api_name" > "$api_file"
test "$(jq -er '.metadata.uid' "$api_file")" = "$api_uid" || fail 'API Deployment UID 漂移'

if test "$mode" = pre || test "$mode" = locked || test "$mode" = phase-a; then
  jq -e '.spec.replicas == 0 and (.status.readyReplicas // 0) == 0 and
    (.status.availableReplicas // 0) == 0' "$api_file" >/dev/null || fail 'Helm 前 API 不再是零副本'
  if "$KUBECTL_BIN" get "horizontalpodautoscaler/$api_hpa_name" --namespace "$AWS_EKS_NAMESPACE" \
    --output json >/dev/null 2>&1; then fail 'Helm 前 API HPA 已被重建'; fi
  "$KUBECTL_BIN" get pod --namespace "$AWS_EKS_NAMESPACE" \
    --selector "app.kubernetes.io/instance=${AWS_HELM_RELEASE_NAME},app.kubernetes.io/component=rgs" \
    --output json > "$temporary_directory/api-pods.json"
  test "$(jq '.items | length' "$temporary_directory/api-pods.json")" -eq 0 || fail 'Helm 前仍有旧 API Pod'
  if test "$mode" = locked; then
    write_finalize_attestation "$rendered_file"
    printf '%s\n' 'HMAC maintenance lock 前置门禁通过：API 仍为零旧 Pod，Worker 持续可用。'
    exit 0
  fi
  if test "$mode" = phase-a; then
    verify_template_secret "$api_file"
    jq -e '.spec.template.metadata.annotations["slots-game.io/hmac-maintenance-quiesced"] == "true"' \
      "$api_file" >/dev/null || fail 'Phase A live API 模板未标记 maintenanceQuiesced'
    printf '%s\n' 'HMAC maintenance Phase A 门禁通过：已提交 target Secret 安全 revision，API 保持零 Pod。'
    exit 0
  fi
  test -f "$rendered_file" || fail 'maintenance-complete 缺少候选 Helm 渲染'
  ruby -ryaml -rjson -e '
    documents = YAML.load_stream(File.binread(ARGV.fetch(0))).compact
    api = documents.select { |item| item.is_a?(Hash) && item["kind"] == "Deployment" &&
      item.dig("metadata", "labels", "app.kubernetes.io/component") == "rgs" }
    abort "候选 API Deployment 数量不精确" unless api.length == 1
    api_hpa = documents.select { |item| item.is_a?(Hash) && item["kind"] == "HorizontalPodAutoscaler" &&
      item.dig("metadata", "labels", "app.kubernetes.io/component") == "rgs" }
    abort "Phase A 渲染仍包含 API HPA" unless api_hpa.empty?
    abort "Phase A 渲染没有固定 API 零副本" unless api.first.dig("spec", "replicas") == 0
    abort "Phase A 渲染缺少停机标记" unless
      api.first.dig("spec", "template", "metadata", "annotations", "slots-game.io/hmac-maintenance-quiesced") == "true"
    STDOUT.write(JSON.generate(api.first))
  ' "$rendered_file" > "$temporary_directory/rendered-api.json"
  verify_template_secret "$temporary_directory/rendered-api.json"
  printf '%s\n' 'HMAC maintenance-complete Helm 前门禁通过：零旧 Pod 且候选只引用 target Secret。'
  exit 0
fi

verify_template_secret "$api_file"
jq -e '.spec.template.metadata.annotations["slots-game.io/hmac-maintenance-quiesced"] == "false"' \
  "$api_file" >/dev/null || fail 'Phase B live API 模板仍处于 maintenanceQuiesced'
jq -e '.spec.replicas >= 1 and (.status.readyReplicas // 0) == .spec.replicas and
  (.status.availableReplicas // 0) == .spec.replicas' "$api_file" >/dev/null || fail 'Helm 后 API 未完全就绪'
"$KUBECTL_BIN" get "horizontalpodautoscaler/$api_hpa_name" --namespace "$AWS_EKS_NAMESPACE" \
  --output json > "$temporary_directory/api-hpa.json" || fail 'Helm 后 API HPA 未恢复'
jq -e --arg name "$api_hpa_name" --arg api "$api_name" --arg release "$AWS_HELM_RELEASE_NAME" '
  .apiVersion == "autoscaling/v2" and .kind == "HorizontalPodAutoscaler" and
  .metadata.name == $name and .metadata.labels["app.kubernetes.io/instance"] == $release and
  .metadata.labels["app.kubernetes.io/component"] == "rgs" and
  .spec.scaleTargetRef == {apiVersion: "apps/v1", kind: "Deployment", name: $api}
' "$temporary_directory/api-hpa.json" >/dev/null || fail 'Phase B API HPA 身份或目标漂移'
live_hpa_sha=$(jq -j -S -c '.spec' "$temporary_directory/api-hpa.json" | sha256sum | awk '{ print $1 }')
test "$live_hpa_sha" = "$(jq -er '.quiescence.api.hpa_spec_sha256' "$evidence_file")" || \
  fail 'Phase B API HPA spec 与停机证据不一致'
"$KUBECTL_BIN" get pod --namespace "$AWS_EKS_NAMESPACE" \
  --selector "app.kubernetes.io/instance=${AWS_HELM_RELEASE_NAME},app.kubernetes.io/component=rgs" \
  --output json > "$temporary_directory/api-pods.json"
jq -e --argjson desired "$(jq -er '.spec.replicas' "$api_file")" '
  (.items | length) >= $desired and all(.items[];
    .metadata.deletionTimestamp == null and
    any(.status.conditions[]?; .type == "Ready" and .status == "True"))
' "$temporary_directory/api-pods.json" >/dev/null || fail 'Phase B API Pod 未全部以 target 模板就绪'
test "$(jq -er '.metadata.uid' "$lock_file")" = "$evidence_lock_uid" || fail '完成前 lock UID 漂移'
get_lock > "$temporary_directory/lock-before-delete.json"
test "$(jq -er '.metadata.uid' "$temporary_directory/lock-before-delete.json")" = "$evidence_lock_uid" || \
  fail '删除前 lock UID 漂移'
"$KUBECTL_BIN" delete "configmap/$lock_name" --namespace "$AWS_EKS_NAMESPACE" \
  --wait=true --timeout 2m >/dev/null
"$KUBECTL_BIN" annotate "deployment/$api_name" --namespace "$AWS_EKS_NAMESPACE" \
  slots-game.io/hmac-quiesce-run- slots-game.io/hmac-quiesce-source-sha- >/dev/null
"$script_directory/hmac-evidence-marker.sh" publish completion "$evidence_file" >/dev/null
printf '%s\n' 'HMAC maintenance-complete 完成：只启动 target Secret Pod，已写完成标记并删除 lock。'
