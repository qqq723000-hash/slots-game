#!/usr/bin/env bash
# 在私网 runner 上受控停止或恢复 API，并用版本化 S3 对象交付可审计证据。
# English: Controlled stop or resume APIs on a private runner and deliver auditable evidence with versioned S3
# objects.
set -euo pipefail
umask 077

AWS_BIN=${AWS_BIN:-aws}
KUBECTL_BIN=${KUBECTL_BIN:-kubectl}
script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
temporary_directory=$(mktemp -d "${RUNNER_TEMP:-/tmp}/slots-hmac-quiesce.XXXXXX")
delivery_head="$temporary_directory/delivery-head.json"
delivery_file="$temporary_directory/terraform-delivery.json"
identity_file="$temporary_directory/caller-identity.json"
cluster_file="$temporary_directory/eks-cluster.json"
api_deployment="$temporary_directory/api-deployment.json"
worker_deployment="$temporary_directory/worker-deployment.json"
api_hpa="$temporary_directory/api-hpa.json"
worker_hpa="$temporary_directory/worker-hpa.json"
api_pods="$temporary_directory/api-pods.json"
worker_pods="$temporary_directory/worker-pods.json"
hpa_restore_manifest="$temporary_directory/api-hpa-restore.json"
lock_manifest="$temporary_directory/maintenance-lock.json"
lock_file="$temporary_directory/maintenance-lock-live.json"
evidence_file="$temporary_directory/hmac-quiesce-evidence.json"
readback_file="$temporary_directory/hmac-quiesce-evidence-readback.json"
put_result="$temporary_directory/evidence-put.json"
mutated=false
committed=false
evidence_published=false
evidence_cancelled=false
lock_created=false
lock_name=slots-hmac-maintenance-lock
lock_uid=''
original_api_replicas=''
original_api_uid=''

fail() {
  printf '%s\n' "HMAC 停机证据操作失败：$*" >&2
  exit 1
}

resource_selector() {
  component=$1
  printf 'app.kubernetes.io/instance=%s,app.kubernetes.io/component=%s' \
    "$AWS_HELM_RELEASE_NAME" "$component"
}

get_single() {
  resource=$1
  component=$2
  output=$3
  selector=$(resource_selector "$component")
  list_file="${output}.list"
  "$KUBECTL_BIN" get "$resource" --namespace "$AWS_EKS_NAMESPACE" \
    --selector "$selector" --output json > "$list_file"
  jq -e --arg namespace "$AWS_EKS_NAMESPACE" --arg release "$AWS_HELM_RELEASE_NAME" \
    --arg component "$component" '
      (.items | length) == 1 and
      .items[0].metadata.namespace == $namespace and
      .items[0].metadata.labels["app.kubernetes.io/instance"] == $release and
      .items[0].metadata.labels["app.kubernetes.io/component"] == $component
    ' "$list_file" >/dev/null || fail "$resource/$component 必须精确存在一个受 Helm 管理的对象"
  jq '.items[0]' "$list_file" > "$output"
  rm -f "$list_file"
}

get_pods() {
  component=$1
  output=$2
  selector=$(resource_selector "$component")
  "$KUBECTL_BIN" get pod --namespace "$AWS_EKS_NAMESPACE" \
    --selector "$selector" --output json > "$output"
  jq -e --arg namespace "$AWS_EKS_NAMESPACE" --arg release "$AWS_HELM_RELEASE_NAME" \
    --arg component "$component" '
      all(.items[];
        .metadata.namespace == $namespace and
        .metadata.labels["app.kubernetes.io/instance"] == $release and
        .metadata.labels["app.kubernetes.io/component"] == $component)
    ' "$output" >/dev/null || fail "Pod/$component 越过固定 Helm 边界"
}

ready_pod_count() {
  jq '[.items[] | select(
    .metadata.deletionTimestamp == null and
    any(.status.conditions[]?; .type == "Ready" and .status == "True")
  )] | length' "$1"
}

verify_deployment_healthy() {
  file=$1
  label=$2
  jq -e '
    (.spec.replicas | type == "number" and . >= 1 and floor == .) and
    (.status.readyReplicas // 0) == .spec.replicas and
    (.status.availableReplicas // 0) == .spec.replicas and
    (.status.updatedReplicas // 0) == .spec.replicas and
    .metadata.deletionTimestamp == null
  ' "$file" >/dev/null || fail "$label Deployment 未完全就绪"
}

verify_hpa_target() {
  hpa_file=$1
  deployment_file=$2
  label=$3
  deployment_name=$(jq -er '.metadata.name' "$deployment_file")
  jq -e --arg deployment "$deployment_name" '
    .apiVersion == "autoscaling/v2" and
    .kind == "HorizontalPodAutoscaler" and
    .spec.scaleTargetRef == {
      "apiVersion": "apps/v1", "kind": "Deployment", "name": $deployment
    } and
    .metadata.deletionTimestamp == null
  ' "$hpa_file" >/dev/null || fail "$label HPA 没有精确指向对应 Deployment"
}

verify_worker_snapshot() {
  expected_deployment_uid=$1
  expected_hpa_uid=$2
  get_single deployment rgs-worker "$worker_deployment"
  get_single horizontalpodautoscaler rgs-worker "$worker_hpa"
  verify_deployment_healthy "$worker_deployment" 'Worker'
  verify_hpa_target "$worker_hpa" "$worker_deployment" 'Worker'
  test "$(jq -er '.metadata.uid' "$worker_deployment")" = "$expected_deployment_uid" || \
    fail 'Worker Deployment UID 在停机窗口内漂移'
  test "$(jq -er '.metadata.uid' "$worker_hpa")" = "$expected_hpa_uid" || \
    fail 'Worker HPA UID 在停机窗口内漂移'
  get_pods rgs-worker "$worker_pods"
  desired=$(jq -er '.spec.replicas' "$worker_deployment")
  pod_count=$(jq '.items | length' "$worker_pods")
  ready_count=$(ready_pod_count "$worker_pods")
  test "$pod_count" -ge "$desired" -a "$ready_count" -eq "$pod_count" || \
    fail 'Worker Pod 在停机窗口内没有全部保持就绪'
}

restore_after_failure() {
  restore_status=0
  printf '%s\n' '停机证据未提交，开始恢复 API HPA 与副本。' >&2
  current_deployment="$temporary_directory/rollback-api-deployment.json"
  if ! get_single deployment rgs "$current_deployment"; then
    restore_status=1
  elif test "$(jq -er '.metadata.uid' "$current_deployment")" != "$original_api_uid"; then
    printf '%s\n' 'API Deployment UID 已漂移，拒绝覆盖并需要人工恢复。' >&2
    restore_status=1
  elif "$KUBECTL_BIN" get horizontalpodautoscaler "$(jq -er '.metadata.name' "$hpa_restore_manifest")" \
    --namespace "$AWS_EKS_NAMESPACE" --output json >/dev/null 2>&1; then
    printf '%s\n' 'API HPA 已出现漂移对象，拒绝覆盖并需要人工恢复。' >&2
    restore_status=1
  elif ! "$KUBECTL_BIN" create --filename "$hpa_restore_manifest" >/dev/null; then
    restore_status=1
  elif ! "$KUBECTL_BIN" scale "deployment/$(jq -er '.metadata.name' "$current_deployment")" \
    --namespace "$AWS_EKS_NAMESPACE" --replicas "$original_api_replicas" >/dev/null; then
    restore_status=1
  elif ! "$KUBECTL_BIN" rollout status "deployment/$(jq -er '.metadata.name' "$current_deployment")" \
    --namespace "$AWS_EKS_NAMESPACE" --timeout 10m >/dev/null; then
    restore_status=1
  fi
  if test "$restore_status" -ne 0; then
    printf '%s\n' '自动恢复未完成：保持失败闭合并立即执行 resume 或人工处置。' >&2
  else
    if test "$lock_created" = true; then
      current_lock_uid=$("$KUBECTL_BIN" get "configmap/$lock_name" --namespace "$AWS_EKS_NAMESPACE" \
        --output json 2>/dev/null | jq -r '.metadata.uid // empty' || true)
      if test "$current_lock_uid" = "$lock_uid"; then
        "$KUBECTL_BIN" delete "configmap/$lock_name" --namespace "$AWS_EKS_NAMESPACE" \
          --wait=true --timeout 2m >/dev/null || restore_status=1
      else
        printf '%s\n' 'maintenance lock UID 已漂移，拒绝删除并需要人工处置。' >&2
        restore_status=1
      fi
    fi
    printf '%s\n' 'API HPA 与副本已自动恢复。' >&2
  fi
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if test "$status" -ne 0 && test "$mutated" = true && test "$committed" = false; then
    cancellation_ready=true
    if test "$evidence_published" = true && test "$evidence_cancelled" = false; then
      printf '%s\n' '证据已经上传但 lock 尚未提交，先发布精确 cancellation marker。' >&2
      if INPUT_EVIDENCE_VERSION_ID=$evidence_version_id INPUT_EVIDENCE_SHA256=$evidence_sha256 \
        "$script_directory/hmac-evidence-marker.sh" publish cancellation "$evidence_file" >/dev/null; then
        evidence_cancelled=true
      else
        cancellation_ready=false
        printf '%s\n' 'cancellation marker 发布失败；保持 API 零副本和 maintenance lock，禁止恢复旧 Pod。' >&2
      fi
    fi
    if test "$cancellation_ready" = true; then
      restore_after_failure || true
    fi
  fi
  rm -rf "$temporary_directory"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

verify_aws_identity_and_cluster() {
  "$AWS_BIN" sts get-caller-identity --output json > "$identity_file"
  role_name=${AWS_HMAC_QUIESCE_ROLE_ARN##*/}
  jq -e --arg account "$AWS_ACCOUNT_ID" --arg role "$role_name" '
    .Account == $account and
    (.Arn | test("^arn:aws:sts::" + $account + ":assumed-role/" + $role + "/[^/]+$"))
  ' "$identity_file" >/dev/null || fail '当前 AWS 身份不是固定 HMAC quiesce OIDC role'
  cluster_arn="arn:aws:eks:${AWS_REGION}:${AWS_ACCOUNT_ID}:cluster/${AWS_EKS_CLUSTER_NAME}"
  "$AWS_BIN" eks describe-cluster --name "$AWS_EKS_CLUSTER_NAME" --region "$AWS_REGION" \
    --output json > "$cluster_file"
  jq -e --arg cluster_arn "$cluster_arn" '
    .cluster.arn == $cluster_arn and
    .cluster.status == "ACTIVE" and
    .cluster.resourcesVpcConfig.endpointPrivateAccess == true and
    .cluster.resourcesVpcConfig.endpointPublicAccess == false
  ' "$cluster_file" >/dev/null || \
    fail 'HMAC quiesce 只允许访问 ACTIVE 且 private-only 的固定 EKS 集群'
  "$AWS_BIN" eks update-kubeconfig --name "$AWS_EKS_CLUSTER_NAME" --region "$AWS_REGION" \
    --kubeconfig "$KUBECONFIG" --alias "$cluster_arn" >/dev/null
  test "$("$KUBECTL_BIN" config current-context)" = "$cluster_arn" || fail 'kubectl context 不是固定 EKS 集群'
}

verify_helm_release() {
  helm_secrets="$temporary_directory/helm-secrets.json"
  "$KUBECTL_BIN" get secret --namespace "$AWS_EKS_NAMESPACE" \
    --selector "owner=helm,name=${AWS_HELM_RELEASE_NAME}" --output json > "$helm_secrets"
  jq -e --arg namespace "$AWS_EKS_NAMESPACE" --arg release "$AWS_HELM_RELEASE_NAME" '
    [.items[] | select(
      .metadata.namespace == $namespace and
      .metadata.labels.owner == "helm" and
      .metadata.labels.name == $release and
      .metadata.labels.status == "deployed"
    )] | length >= 1
  ' "$helm_secrets" >/dev/null || fail '缺少固定 release 的已部署 Helm Secret'
}

create_maintenance_lock() {
  if "$KUBECTL_BIN" get "configmap/$lock_name" --namespace "$AWS_EKS_NAMESPACE" \
    --output json >/dev/null 2>&1; then
    fail '已存在 HMAC maintenance lock，拒绝开始并行停机'
  fi
  jq -n \
    --arg namespace "$AWS_EKS_NAMESPACE" --arg release "$AWS_HELM_RELEASE_NAME" \
    --arg run_id "$GITHUB_RUN_ID" --arg run_attempt "$GITHUB_RUN_ATTEMPT" --arg source_sha "$GITHUB_SHA" \
    --arg delivery_bucket "$AWS_TERRAFORM_DELIVERY_BUCKET" --arg delivery_key "$AWS_TERRAFORM_DELIVERY_KEY" \
    --arg delivery_version "$delivery_version_id" --arg delivery_sha "$delivery_sha256" \
    --arg active_slot "$(jq -er '.valkey_active_slot' "$delivery_file")" \
    --arg secret_version "$(jq -er '.valkey_rotation_contract.published_secret_version | tostring' "$delivery_file")" \
    --arg hmac "$(jq -er '.valkey_rotation_contract.hmac_key_fingerprint' "$delivery_file")" \
    --arg target_version "$(( $(jq -er '.valkey_rotation_contract.published_secret_version' "$delivery_file") + 2 ))" \
    --arg api_name "$(jq -er '.metadata.name' "$api_deployment")" --arg api_uid "$(jq -er '.metadata.uid' "$api_deployment")" \
    --arg api_hpa_name "$(jq -er '.metadata.name' "$api_hpa")" --arg api_hpa_uid "$(jq -er '.metadata.uid' "$api_hpa")" \
    --arg worker_name "$(jq -er '.metadata.name' "$worker_deployment")" \
    --arg worker_uid "$(jq -er '.metadata.uid' "$worker_deployment")" \
    --arg worker_hpa_name "$(jq -er '.metadata.name' "$worker_hpa")" \
    --arg worker_hpa_uid "$(jq -er '.metadata.uid' "$worker_hpa")" '{
      apiVersion: "v1", kind: "ConfigMap",
      metadata: {
        name: "slots-hmac-maintenance-lock", namespace: $namespace,
        labels: {
          "app.kubernetes.io/instance": $release,
          "app.kubernetes.io/managed-by": "slots-hmac-quiesce",
          "slots-game.io/purpose": "hmac-maintenance"
        }
      },
      data: {
        schemaVersion: "1", status: "preparing", producerRunId: $run_id,
        producerRunAttempt: $run_attempt, sourceSha: $source_sha,
        sourceDeliveryBucket: $delivery_bucket, sourceDeliveryKey: $delivery_key,
        sourceDeliveryVersionId: $delivery_version, sourceDeliverySha256: $delivery_sha,
        observedActiveSlot: $active_slot, observedSecretVersion: $secret_version,
        observedHmacFingerprint: $hmac, targetSecretVersion: $target_version,
        apiDeploymentName: $api_name, apiDeploymentUid: $api_uid,
        apiHpaName: $api_hpa_name, apiHpaUid: $api_hpa_uid,
        workerDeploymentName: $worker_name, workerDeploymentUid: $worker_uid,
        workerHpaName: $worker_hpa_name, workerHpaUid: $worker_hpa_uid
      }
    }' > "$lock_manifest"
  "$KUBECTL_BIN" create --filename "$lock_manifest" >/dev/null
  lock_created=true
  "$KUBECTL_BIN" get "configmap/$lock_name" --namespace "$AWS_EKS_NAMESPACE" --output json > "$lock_file"
  lock_uid=$(jq -er '.metadata.uid' "$lock_file")
  jq -e --slurpfile expected "$lock_manifest" '
    .metadata.name == $expected[0].metadata.name and
    .metadata.namespace == $expected[0].metadata.namespace and
    .metadata.labels == $expected[0].metadata.labels and .data == $expected[0].data
  ' "$lock_file" >/dev/null || fail '创建后的 maintenance lock 内容漂移'
}

verify_maintenance_lock() {
  expected_evidence_version=$1
  expected_evidence_sha=$2
  "$KUBECTL_BIN" get "configmap/$lock_name" --namespace "$AWS_EKS_NAMESPACE" --output json > "$lock_file"
  jq -e --arg uid "$(jq -er '.quiescence.lock.uid' "$evidence_file")" \
    --arg release "$AWS_HELM_RELEASE_NAME" --arg version "$expected_evidence_version" \
    --arg sha "$expected_evidence_sha" --arg source_version "$(jq -er '.source_delivery.version_id' "$evidence_file")" \
    --arg source_sha "$(jq -er '.source_delivery.sha256' "$evidence_file")" '
      .metadata.uid == $uid and
      .metadata.labels["app.kubernetes.io/instance"] == $release and
      .metadata.labels["slots-game.io/purpose"] == "hmac-maintenance" and
      .data.schemaVersion == "1" and .data.status == "quiesced" and
      .data.evidenceVersionId == $version and .data.evidenceSha256 == $sha and
      .data.sourceDeliveryVersionId == $source_version and .data.sourceDeliverySha256 == $source_sha
    ' "$lock_file" >/dev/null || fail 'maintenance lock 与固定证据不一致'
}

load_current_delivery() {
  test "$("$AWS_BIN" s3api get-bucket-versioning --bucket "$AWS_TERRAFORM_DELIVERY_BUCKET" \
    --query Status --output text)" = Enabled || fail 'Terraform delivery bucket 未启用 versioning'
  "$AWS_BIN" s3api head-object --bucket "$AWS_TERRAFORM_DELIVERY_BUCKET" \
    --key "$AWS_TERRAFORM_DELIVERY_KEY" --output json > "$delivery_head"
  delivery_version_id=$(jq -er '.VersionId | select(. != "null") | select(test("^[A-Za-z0-9._~+/=-]{1,1024}$"))' \
    "$delivery_head")
  # shellcheck disable=SC2016
  jq -e --arg version "$delivery_version_id" --arg kms "$AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN" \
    --arg environment "$TARGET_ENVIRONMENT" --arg account "$AWS_ACCOUNT_ID" --arg region "$AWS_REGION" '
      .VersionId == $version and .ContentLength > 0 and
      .ContentType == "application/json" and .CacheControl == "no-store" and
      .ServerSideEncryption == "aws:kms" and .SSEKMSKeyId == $kms and
      .Metadata["schema-version"] == "1" and
      (.Metadata["content-sha256"] | test("^[0-9a-f]{64}$")) and
      .Metadata["target-environment"] == $environment and
      .Metadata["aws-account-id"] == $account and
      .Metadata["aws-region"] == $region
    ' "$delivery_head" >/dev/null || fail '当前 Terraform delivery metadata 不可信'
  "$AWS_BIN" s3api get-object --bucket "$AWS_TERRAFORM_DELIVERY_BUCKET" \
    --key "$AWS_TERRAFORM_DELIVERY_KEY" --version-id "$delivery_version_id" "$delivery_file" >/dev/null
  delivery_sha256=$(sha256sum "$delivery_file" | awk '{ print $1 }')
  test "$delivery_sha256" = "$(jq -er '.Metadata["content-sha256"]' "$delivery_head")" || \
    fail '当前 Terraform delivery 内容 SHA-256 与 metadata 不一致'
  # shellcheck disable=SC2016
  jq -e --arg environment "$TARGET_ENVIRONMENT" --arg account "$AWS_ACCOUNT_ID" \
    --arg region "$AWS_REGION" --arg cluster "$AWS_EKS_CLUSTER_NAME" '
      .environment == $environment and .aws_account_id == $account and .aws_region == $region and
      .cluster_name == $cluster and .application_namespace == env.AWS_EKS_NAMESPACE and
      .helm_release_name == env.AWS_HELM_RELEASE_NAME and
      (.cluster_arn | startswith("arn:aws:eks:\($region):\($account):cluster/\($cluster)")) and
      .valkey_rotation_mode == "steady" and
      .valkey_rotation_contract.rotation_mode == "steady" and
      .application_release_allowed == true and .maintenance_in_progress == false and
      .application_handoff.application_release_allowed == true and
      .application_handoff.maintenance_in_progress == false and
      .valkey_rotation_contract.application_release_allowed == true and
      .valkey_rotation_contract.maintenance_in_progress == false and
      .valkey_rotation_contract.active_slot == .valkey_active_slot and
      (.valkey_rotation_contract.hmac_key_fingerprint | test("^[0-9a-f]{64}$")) and
      (.valkey_rotation_contract.published_secret_version | type == "number" and . >= 1 and floor == .) and
      ((.valkey_active_slot == "a" and (.valkey_rotation_contract.published_secret_version % 2) == 1) or
        (.valkey_active_slot == "b" and (.valkey_rotation_contract.published_secret_version % 2) == 0))
    ' "$delivery_file" >/dev/null || fail '当前 Terraform delivery 不是可进入停机维护的 steady 状态'
}

publish_evidence() {
  evidence_sha256=$(sha256sum "$evidence_file" | awk '{ print $1 }')
  HMAC_EVIDENCE_EXPECTED_SHA256=$evidence_sha256 \
    ruby "$script_directory/verify-hmac-quiesce-evidence.rb" consume "$evidence_file" >/dev/null
  test "$("$AWS_BIN" s3api get-bucket-versioning --bucket "$AWS_HMAC_QUIESCE_EVIDENCE_BUCKET" \
    --query Status --output text)" = Enabled || fail 'HMAC evidence bucket 未启用 versioning'
  repository_sha256=$(printf '%s' "$GITHUB_REPOSITORY" | sha256sum | awk '{ print $1 }')
  workflow_ref_sha256=$(printf '%s' "$AWS_HMAC_QUIESCE_PRODUCER_WORKFLOW_REF" | sha256sum | awk '{ print $1 }')
  producer_role_sha256=$(printf '%s' "$AWS_HMAC_QUIESCE_PRODUCER_ROLE_ARN" | sha256sum | awk '{ print $1 }')
  observed_at=$(jq -er '.quiescence.observed_at' "$evidence_file")
  expires_at=$(jq -er '.quiescence.expires_at' "$evidence_file")
  "$AWS_BIN" s3api put-object --bucket "$AWS_HMAC_QUIESCE_EVIDENCE_BUCKET" \
    --key "$AWS_HMAC_QUIESCE_EVIDENCE_KEY" --body "$evidence_file" \
    --content-type application/json --cache-control no-store \
    --server-side-encryption aws:kms --ssekms-key-id "$AWS_HMAC_QUIESCE_EVIDENCE_KMS_KEY_ARN" \
    --metadata "schema-version=slots-hmac-quiesce-v1,content-sha256=${evidence_sha256},target-environment=${TARGET_ENVIRONMENT},aws-account-id=${AWS_ACCOUNT_ID},aws-region=${AWS_REGION},producer-repository-sha256=${repository_sha256},producer-workflow-ref-sha256=${workflow_ref_sha256},producer-role-arn-sha256=${producer_role_sha256},workflow-run-id=${GITHUB_RUN_ID},workflow-run-attempt=${GITHUB_RUN_ATTEMPT},source-sha=${GITHUB_SHA},observed-at=${observed_at},expires-at=${expires_at}" \
    --output json > "$put_result"
  evidence_version_id=$(jq -er '.VersionId | select(. != "null") | select(test("^[A-Za-z0-9._~+/=-]{1,1024}$"))' \
    "$put_result")
  evidence_published=true
  INPUT_EVIDENCE_VERSION_ID=$evidence_version_id INPUT_EVIDENCE_SHA256=$evidence_sha256 \
    "$script_directory/download-hmac-quiesce-evidence.sh" consume "$readback_file" >/dev/null
  cmp -s "$evidence_file" "$readback_file" || fail '证据固定版本回读内容不一致'
  if test -n "${GITHUB_OUTPUT:-}"; then
    printf 'evidence_version_id=%s\n' "$evidence_version_id" >> "$GITHUB_OUTPUT"
    printf 'evidence_sha256=%s\n' "$evidence_sha256" >> "$GITHUB_OUTPUT"
  fi
  if test -n "${GITHUB_STEP_SUMMARY:-}"; then
    {
      printf '### HMAC API 停机证据已提交\n\n'
      printf -- "- S3 bucket/key：\`%s/%s\`\n" "$AWS_HMAC_QUIESCE_EVIDENCE_BUCKET" "$AWS_HMAC_QUIESCE_EVIDENCE_KEY"
      printf -- "- VersionId：\`%s\`\n" "$evidence_version_id"
      printf -- "- SHA-256：\`%s\`\n" "$evidence_sha256"
      printf -- "- 到期时间：\`%s\`\n" "$expires_at"
      printf '\n将 VersionId 与 SHA-256 同时作为 infrastructure dispatch 标识；任一不匹配都会失败闭合。\n'
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

quiesce() {
  load_current_delivery
  verify_aws_identity_and_cluster
  verify_helm_release
  get_single deployment rgs "$api_deployment"
  get_single deployment rgs-worker "$worker_deployment"
  get_single horizontalpodautoscaler rgs "$api_hpa"
  get_single horizontalpodautoscaler rgs-worker "$worker_hpa"
  verify_deployment_healthy "$api_deployment" 'API'
  verify_deployment_healthy "$worker_deployment" 'Worker'
  verify_hpa_target "$api_hpa" "$api_deployment" 'API'
  verify_hpa_target "$worker_hpa" "$worker_deployment" 'Worker'
  get_pods rgs "$api_pods"
  get_pods rgs-worker "$worker_pods"

  original_api_replicas=$(jq -er '.spec.replicas | select(. >= 1 and floor == .)' "$api_deployment")
  original_api_uid=$(jq -er '.metadata.uid' "$api_deployment")
  api_deployment_name=$(jq -er '.metadata.name' "$api_deployment")
  api_hpa_name=$(jq -er '.metadata.name' "$api_hpa")
  api_hpa_uid=$(jq -er '.metadata.uid' "$api_hpa")
  worker_deployment_uid=$(jq -er '.metadata.uid' "$worker_deployment")
  worker_hpa_uid=$(jq -er '.metadata.uid' "$worker_hpa")
  worker_deployment_name=$(jq -er '.metadata.name' "$worker_deployment")
  worker_hpa_name=$(jq -er '.metadata.name' "$worker_hpa")
  worker_desired=$(jq -er '.spec.replicas' "$worker_deployment")
  worker_pod_count=$(jq '.items | length' "$worker_pods")
  worker_ready_pod_count=$(ready_pod_count "$worker_pods")
  test "$worker_pod_count" -ge "$worker_desired" -a "$worker_ready_pod_count" -eq "$worker_pod_count" || \
    fail '停机前 Worker Pod 未全部就绪'

  create_maintenance_lock
  jq '{
    apiVersion, kind,
    metadata: {
      name: .metadata.name,
      namespace: .metadata.namespace,
      labels: (.metadata.labels // {}),
      annotations: (.metadata.annotations // {})
    },
    spec
  }' "$api_hpa" > "$hpa_restore_manifest"
  hpa_spec_sha256=$(jq -j -S -c '.spec' "$hpa_restore_manifest" | sha256sum | awk '{ print $1 }')

  mutated=true
  "$KUBECTL_BIN" delete "horizontalpodautoscaler/$api_hpa_name" \
    --namespace "$AWS_EKS_NAMESPACE" --wait=true --timeout 2m >/dev/null
  if "$KUBECTL_BIN" get "horizontalpodautoscaler/$api_hpa_name" \
    --namespace "$AWS_EKS_NAMESPACE" --output json >/dev/null 2>&1; then
    fail '删除后 API HPA 仍存在'
  fi
  "$KUBECTL_BIN" annotate "deployment/$api_deployment_name" --namespace "$AWS_EKS_NAMESPACE" \
    "slots-game.io/hmac-quiesce-run=${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}" \
    "slots-game.io/hmac-quiesce-source-sha=${GITHUB_SHA}" --overwrite >/dev/null
  "$KUBECTL_BIN" scale "deployment/$api_deployment_name" --namespace "$AWS_EKS_NAMESPACE" \
    --replicas 0 >/dev/null

  zero_observed=false
  for _attempt in $(seq 1 60); do
    get_single deployment rgs "$api_deployment"
    get_pods rgs "$api_pods"
    if jq -e --arg uid "$original_api_uid" '
      .metadata.uid == $uid and .spec.replicas == 0 and
      (.status.readyReplicas // 0) == 0 and (.status.availableReplicas // 0) == 0
    ' "$api_deployment" >/dev/null && test "$(jq '.items | length' "$api_pods")" -eq 0; then
      zero_observed=true
      break
    fi
    sleep 5
  done
  test "$zero_observed" = true || fail 'API 未在超时内达到零副本且无 Pod'
  if "$KUBECTL_BIN" get "horizontalpodautoscaler/$api_hpa_name" \
    --namespace "$AWS_EKS_NAMESPACE" --output json >/dev/null 2>&1; then
    fail '零副本观察时 API HPA 被重新创建'
  fi
  verify_worker_snapshot "$worker_deployment_uid" "$worker_hpa_uid"

  timestamps=$(ruby -rtime -e 'now = Time.now.utc; puts now.iso8601; puts (now + 3600).iso8601')
  observed_at=$(printf '%s\n' "$timestamps" | sed -n '1p')
  expires_at=$(printf '%s\n' "$timestamps" | sed -n '2p')
  active_slot=$(jq -er '.valkey_active_slot' "$delivery_file")
  observed_secret_version=$(jq -er '.valkey_rotation_contract.published_secret_version' "$delivery_file")
  target_secret_version=$((observed_secret_version + 2))
  observed_hmac_fingerprint=$(jq -er '.valkey_rotation_contract.hmac_key_fingerprint' "$delivery_file")
  api_ready=$(jq '(.status.readyReplicas // 0)' "$api_deployment")
  api_available=$(jq '(.status.availableReplicas // 0)' "$api_deployment")
  worker_ready=$(jq '(.status.readyReplicas // 0)' "$worker_deployment")
  worker_available=$(jq '(.status.availableReplicas // 0)' "$worker_deployment")

  jq -n -S -c \
    --arg repository "$GITHUB_REPOSITORY" \
    --arg workflow_ref "$AWS_HMAC_QUIESCE_PRODUCER_WORKFLOW_REF" \
    --arg source_sha "$GITHUB_SHA" \
    --arg run_id "$GITHUB_RUN_ID" \
    --arg run_attempt "$GITHUB_RUN_ATTEMPT" \
    --arg producer_environment "$TARGET_ENVIRONMENT" \
    --arg producer_role "$AWS_HMAC_QUIESCE_PRODUCER_ROLE_ARN" \
    --arg environment "$TARGET_ENVIRONMENT" \
    --arg account "$AWS_ACCOUNT_ID" \
    --arg region "$AWS_REGION" \
    --arg cluster "$AWS_EKS_CLUSTER_NAME" \
    --arg namespace "$AWS_EKS_NAMESPACE" \
    --arg release "$AWS_HELM_RELEASE_NAME" \
    --arg delivery_bucket "$AWS_TERRAFORM_DELIVERY_BUCKET" \
    --arg delivery_key "$AWS_TERRAFORM_DELIVERY_KEY" \
    --arg delivery_version "$delivery_version_id" \
    --arg delivery_sha "$delivery_sha256" \
    --arg active_slot "$active_slot" \
    --arg hmac_fingerprint "$observed_hmac_fingerprint" \
    --argjson observed_secret_version "$observed_secret_version" \
    --argjson target_secret_version "$target_secret_version" \
    --arg observed_at "$observed_at" \
    --arg expires_at "$expires_at" \
    --arg lock_name "$lock_name" \
    --arg lock_uid "$lock_uid" \
    --arg api_deployment_name "$api_deployment_name" \
    --arg api_deployment_uid "$original_api_uid" \
    --arg api_hpa_name "$api_hpa_name" \
    --arg api_hpa_uid "$api_hpa_uid" \
    --arg api_hpa_sha "$hpa_spec_sha256" \
    --argjson api_original_replicas "$original_api_replicas" \
    --argjson api_ready "$api_ready" \
    --argjson api_available "$api_available" \
    --arg worker_deployment_name "$worker_deployment_name" \
    --arg worker_deployment_uid "$worker_deployment_uid" \
    --arg worker_hpa_name "$worker_hpa_name" \
    --arg worker_hpa_uid "$worker_hpa_uid" \
    --argjson worker_desired "$worker_desired" \
    --argjson worker_ready "$worker_ready" \
    --argjson worker_available "$worker_available" \
    --argjson worker_pod_count "$worker_pod_count" \
    --argjson worker_ready_pod_count "$worker_ready_pod_count" \
    --slurpfile hpa_manifest "$hpa_restore_manifest" '
      {
        schema: "slots-game/hmac-quiesce-attestation/v1",
        producer: {
          repository: $repository, workflow_ref: $workflow_ref, source_sha: $source_sha,
          run_id: $run_id, run_attempt: $run_attempt, environment: $producer_environment,
          role_arn: $producer_role
        },
        target: {
          environment: $environment, aws_account_id: $account, aws_region: $region,
          eks_cluster_name: $cluster, kubernetes_namespace: $namespace, helm_release_name: $release
        },
        source_delivery: {
          bucket: $delivery_bucket, key: $delivery_key, version_id: $delivery_version, sha256: $delivery_sha
        },
        rotation: {
          observed_active_slot: $active_slot, observed_secret_version: $observed_secret_version,
          observed_hmac_key_fingerprint: $hmac_fingerprint, target_secret_version: $target_secret_version
        },
        quiescence: {
          observed_at: $observed_at, expires_at: $expires_at,
          lock: {name: $lock_name, uid: $lock_uid},
          api: {
            deployment_name: $api_deployment_name, uid: $api_deployment_uid,
            hpa_name: $api_hpa_name, hpa_uid: $api_hpa_uid, hpa_spec_sha256: $api_hpa_sha,
            hpa_restore_manifest: $hpa_manifest[0], original_replicas: $api_original_replicas,
            desired: 0, ready: $api_ready, available: $api_available, pod_count: 0
          },
          worker: {
            deployment_name: $worker_deployment_name, uid: $worker_deployment_uid,
            hpa_name: $worker_hpa_name, hpa_uid: $worker_hpa_uid,
            desired: $worker_desired, ready: $worker_ready,
            available: $worker_available, pod_count: $worker_pod_count,
            ready_pod_count: $worker_ready_pod_count
          }
        }
      }
    ' > "$evidence_file"
  publish_evidence
  lock_patch=$(jq -cn --arg uid "$lock_uid" --arg version "$evidence_version_id" \
    --arg sha "$evidence_sha256" --arg expires "$expires_at" '[
      {op: "test", path: "/metadata/uid", value: $uid},
      {op: "replace", path: "/data/status", value: "quiesced"},
      {op: "add", path: "/data/evidenceVersionId", value: $version},
      {op: "add", path: "/data/evidenceSha256", value: $sha},
      {op: "add", path: "/data/evidenceExpiresAt", value: $expires}
    ]')
  "$KUBECTL_BIN" patch "configmap/$lock_name" --namespace "$AWS_EKS_NAMESPACE" \
    --type json --patch "$lock_patch" >/dev/null
  verify_maintenance_lock "$evidence_version_id" "$evidence_sha256"
  committed=true
}

resume() {
  "$script_directory/download-hmac-quiesce-evidence.sh" resume "$evidence_file" >/dev/null
  load_current_delivery
  test "$delivery_version_id" = "$(jq -er '.source_delivery.version_id' "$evidence_file")" || \
    fail '最新 Terraform delivery 已变化，禁止恢复旧 HMAC Pod；请执行 maintenance-complete'
  test "$delivery_sha256" = "$(jq -er '.source_delivery.sha256' "$evidence_file")" || \
    fail '最新 Terraform delivery 内容已变化，禁止恢复旧 HMAC Pod；请执行 maintenance-complete'
  verify_aws_identity_and_cluster
  verify_helm_release
  verify_maintenance_lock "$INPUT_EVIDENCE_VERSION_ID" "$INPUT_EVIDENCE_SHA256"
  evidence_api_name=$(jq -er '.quiescence.api.deployment_name' "$evidence_file")
  evidence_api_uid=$(jq -er '.quiescence.api.uid' "$evidence_file")
  evidence_hpa_name=$(jq -er '.quiescence.api.hpa_name' "$evidence_file")
  evidence_hpa_uid=$(jq -er '.quiescence.api.hpa_uid' "$evidence_file")
  evidence_hpa_sha=$(jq -er '.quiescence.api.hpa_spec_sha256' "$evidence_file")
  evidence_original_replicas=$(jq -er '.quiescence.api.original_replicas' "$evidence_file")
  evidence_worker_uid=$(jq -er '.quiescence.worker.uid' "$evidence_file")
  evidence_worker_hpa_uid=$(jq -er '.quiescence.worker.hpa_uid' "$evidence_file")
  jq '.quiescence.api.hpa_restore_manifest' "$evidence_file" > "$hpa_restore_manifest"

  get_single deployment rgs "$api_deployment"
  test "$(jq -er '.metadata.name' "$api_deployment")" = "$evidence_api_name" || fail '恢复目标 API 名称漂移'
  test "$(jq -er '.metadata.uid' "$api_deployment")" = "$evidence_api_uid" || fail '恢复目标 API UID 漂移'
  jq -e '.spec.replicas == 0 and (.status.readyReplicas // 0) == 0 and
    (.status.availableReplicas // 0) == 0' "$api_deployment" >/dev/null || fail '恢复前 API 不再是零副本'
  get_pods rgs "$api_pods"
  test "$(jq '.items | length' "$api_pods")" -eq 0 || fail '恢复前仍存在 API Pod'
  if "$KUBECTL_BIN" get "horizontalpodautoscaler/$evidence_hpa_name" \
    --namespace "$AWS_EKS_NAMESPACE" --output json >/dev/null 2>&1; then
    fail '恢复前已存在 API HPA 漂移对象，拒绝覆盖'
  fi
  verify_worker_snapshot "$evidence_worker_uid" "$evidence_worker_hpa_uid"

  "$script_directory/hmac-evidence-marker.sh" check completion "$evidence_file" >/dev/null
  "$script_directory/hmac-evidence-marker.sh" publish cancellation "$evidence_file" >/dev/null

  "$KUBECTL_BIN" create --filename "$hpa_restore_manifest" >/dev/null
  "$KUBECTL_BIN" get "horizontalpodautoscaler/$evidence_hpa_name" \
    --namespace "$AWS_EKS_NAMESPACE" --output json > "$api_hpa"
  new_hpa_uid=$(jq -er '.metadata.uid' "$api_hpa")
  test "$new_hpa_uid" != "$evidence_hpa_uid" || fail '恢复 HPA 错误复用了已删除对象 UID'
  restored_hpa_sha=$(jq -j -S -c '.spec' "$api_hpa" | sha256sum | awk '{ print $1 }')
  test "$restored_hpa_sha" = "$evidence_hpa_sha" || fail '恢复 HPA spec 与证据不一致'
  "$KUBECTL_BIN" scale "deployment/$evidence_api_name" --namespace "$AWS_EKS_NAMESPACE" \
    --replicas "$evidence_original_replicas" >/dev/null
  "$KUBECTL_BIN" rollout status "deployment/$evidence_api_name" \
    --namespace "$AWS_EKS_NAMESPACE" --timeout 10m >/dev/null
  get_single deployment rgs "$api_deployment"
  test "$(jq -er '.metadata.uid' "$api_deployment")" = "$evidence_api_uid" || fail '恢复后 API UID 漂移'
  verify_deployment_healthy "$api_deployment" '恢复后的 API'
  get_pods rgs "$api_pods"
  api_desired=$(jq -er '.spec.replicas' "$api_deployment")
  test "$(jq '.items | length' "$api_pods")" -ge "$api_desired" || fail '恢复后 API Pod 数不足'
  test "$(ready_pod_count "$api_pods")" -eq "$(jq '.items | length' "$api_pods")" || \
    fail '恢复后 API Pod 未全部就绪'
  verify_worker_snapshot "$evidence_worker_uid" "$evidence_worker_hpa_uid"
  "$KUBECTL_BIN" annotate "deployment/$evidence_api_name" --namespace "$AWS_EKS_NAMESPACE" \
    slots-game.io/hmac-quiesce-run- slots-game.io/hmac-quiesce-source-sha- >/dev/null
  current_lock_uid=$("$KUBECTL_BIN" get "configmap/$lock_name" --namespace "$AWS_EKS_NAMESPACE" \
    --output json | jq -er '.metadata.uid')
  test "$current_lock_uid" = "$(jq -er '.quiescence.lock.uid' "$evidence_file")" || \
    fail '恢复完成前 maintenance lock UID 漂移'
  "$KUBECTL_BIN" delete "configmap/$lock_name" --namespace "$AWS_EKS_NAMESPACE" \
    --wait=true --timeout 2m >/dev/null
  lock_created=false
  committed=true
  if test -n "${GITHUB_STEP_SUMMARY:-}"; then
    {
      printf '### HMAC API 停机窗口已恢复\n\n'
      printf -- "- 证据 VersionId：\`%s\`\n" "$INPUT_EVIDENCE_VERSION_ID"
      printf -- "- 证据 SHA-256：\`%s\`\n" "$INPUT_EVIDENCE_SHA256"
      printf -- "- API Deployment：\`%s\`\n" "$evidence_api_name"
      printf -- "- 新 HPA UID：\`%s\`\n" "$new_hpa_uid"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

case "$INPUT_OPERATION" in
  quiesce) quiesce ;;
  resume) resume ;;
  *) fail 'INPUT_OPERATION 只能是 quiesce 或 resume' ;;
esac

printf '%s\n' "HMAC 停机证据操作完成：$INPUT_OPERATION"
