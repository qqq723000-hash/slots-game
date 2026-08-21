#!/usr/bin/env bash
# HMAC 停机证据测试专用 kubectl；用临时状态文件模拟 API 停机与恢复。
set -euo pipefail

state=$MOCK_HMAC_STATE_DIR
api_name=slots-rgs
worker_name=slots-rgs-worker
api_hpa_name=slots-rgs
worker_hpa_name=slots-rgs-worker
api_uid=11111111-1111-4111-8111-111111111111
worker_uid=22222222-2222-4222-8222-222222222222
api_hpa_old_uid=33333333-3333-4333-8333-333333333333
api_hpa_new_uid=55555555-5555-4555-8555-555555555555
worker_hpa_uid=44444444-4444-4444-8444-444444444444
lock_uid=66666666-6666-4666-8666-666666666666

argument() {
  target=$1
  shift
  while test "$#" -gt 0; do
    if test "$1" = "$target"; then printf '%s\n' "$2"; return 0; fi
    shift
  done
  return 1
}

deployment_json() {
  component=$1
  if test "$component" = rgs; then
    name=$api_name
    uid=$api_uid
    replicas=$(cat "$state/api-replicas")
    secret_name=slots-rgs-shared-admission-v1
    test ! -f "$state/api-secret-name" || secret_name=$(cat "$state/api-secret-name")
    maintenance=false
    test ! -f "$state/api-maintenance-quiesced" || maintenance=$(cat "$state/api-maintenance-quiesced")
  else
    name=$worker_name
    uid=$worker_uid
    if test "${MOCK_HMAC_KUBECTL_MODE:-}" = worker-drift && ! test -f "$state/api-hpa-present"; then
      uid=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
    fi
    replicas=2
  fi
  jq -n --arg namespace "$AWS_EKS_NAMESPACE" --arg release "$AWS_HELM_RELEASE_NAME" \
    --arg component "$component" --arg name "$name" --arg uid "$uid" --argjson replicas "$replicas" \
    --arg secret "${secret_name:-}" --arg maintenance "${maintenance:-false}" '{
      apiVersion: "apps/v1", kind: "Deployment",
      metadata: {namespace: $namespace, name: $name, uid: $uid,
        labels: {"app.kubernetes.io/instance": $release, "app.kubernetes.io/component": $component}},
      spec: {replicas: $replicas, template: {metadata: {annotations: {
        "slots-game.io/hmac-maintenance-quiesced": $maintenance
      }}, spec: {
        containers: [{name: (if $component == "rgs" then "rgs" else "rgs-worker" end), env:
          (if $component == "rgs" then [
            {name: "RGS_SHARED_ADMISSION_USERNAME", valueFrom: {secretKeyRef: {name: $secret, key: "username"}}},
            {name: "RGS_SHARED_ADMISSION_PASSWORD_FILE", value: "/run/rgs/shared-admission/password"},
            {name: "RGS_SHARED_ADMISSION_HMAC_KEY_FILE", value: "/run/rgs/shared-admission/hmac.key"},
            {name: "RGS_SHARED_ADMISSION_ROOT_CA_FILE", value: "/run/rgs/shared-admission/root-ca.pem"}
          ] else [] end)}],
        volumes: (if $component == "rgs" then [{name: "shared-admission-source", secret: {
          secretName: $secret, defaultMode: 288, items: [
            {key: "password", path: "password"}, {key: "hmac.key", path: "hmac.key"},
            {key: "root-ca.pem", path: "root-ca.pem"}
          ]}}] else [] end)
      }}},
      status: {readyReplicas: $replicas, availableReplicas: $replicas, updatedReplicas: $replicas}
    }'
}

hpa_json() {
  component=$1
  max_replicas=6
  if test "$component" = rgs; then
    name=$api_hpa_name
    target=$api_name
    uid=$api_hpa_old_uid
    if test -f "$state/restored-hpa.json"; then
      uid=$api_hpa_new_uid
      jq --arg uid "$uid" '.metadata.uid = $uid' "$state/restored-hpa.json"
      return
    fi
  else
    name=$worker_hpa_name
    target=$worker_name
    uid=$worker_hpa_uid
  fi
  if test "$component" = rgs && test "${MOCK_HMAC_KUBECTL_MODE:-}" = api-hpa-spec-drift; then
    max_replicas=7
  fi
  jq -n --arg namespace "$AWS_EKS_NAMESPACE" --arg release "$AWS_HELM_RELEASE_NAME" \
    --arg component "$component" --arg name "$name" --arg target "$target" --arg uid "$uid" \
    --argjson max_replicas "$max_replicas" '{
      apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler",
      metadata: {namespace: $namespace, name: $name, uid: $uid,
        labels: {"app.kubernetes.io/instance": $release, "app.kubernetes.io/component": $component},
        annotations: {"meta.helm.sh/release-name": $release, "meta.helm.sh/release-namespace": $namespace}},
      spec: {
        scaleTargetRef: {apiVersion: "apps/v1", kind: "Deployment", name: $target},
        minReplicas: 2, maxReplicas: $max_replicas,
        metrics: [{type: "Resource", resource: {name: "cpu", target: {type: "Utilization", averageUtilization: 70}}}]
      }
    }'
}

pod_list() {
  component=$1
  if test "$component" = rgs; then
    count=$(cat "$state/api-replicas")
    if test "$count" -gt 0 && test -f "$state/api-secret-name"; then
      printf '%s\n' "$(cat "$state/api-secret-name")" >> "$state/pod-start-log"
    fi
  else count=2; fi
  jq -n --arg namespace "$AWS_EKS_NAMESPACE" --arg release "$AWS_HELM_RELEASE_NAME" \
    --arg component "$component" --argjson count "$count" '{
      apiVersion: "v1", kind: "PodList",
      items: [range(0; $count) | {
        metadata: {namespace: $namespace, name: ($component + "-" + tostring),
          labels: {"app.kubernetes.io/instance": $release, "app.kubernetes.io/component": $component}},
        status: {conditions: [{type: "Ready", status: "True"}]}
      }]
    }'
}

command=${1:-}
shift || true
case "$command" in
  config)
    test "${1:-}" = current-context
    printf 'arn:aws:eks:%s:%s:cluster/%s\n' "$AWS_REGION" "$AWS_ACCOUNT_ID" "$AWS_EKS_CLUSTER_NAME"
    ;;
  get)
    resource=${1:-}
    shift || true
    case "$resource" in
      deployment)
        selector=$(argument --selector "$@")
        component=${selector##*=}
        deployment_json "$component" | jq '{apiVersion: "v1", kind: "List", items: [.]}'
        ;;
      deployment/*)
        name=${resource#deployment/}
        if test "$name" = "$api_name"; then deployment_json rgs; else
          test "$name" = "$worker_name"
          deployment_json rgs-worker
        fi
        ;;
      horizontalpodautoscaler)
        selector=$(argument --selector "$@")
        component=${selector##*=}
        if test "$component" = rgs && ! test -f "$state/api-hpa-present"; then
          jq -n '{apiVersion: "v1", kind: "List", items: []}'
        else
          hpa_json "$component" | jq '{apiVersion: "v1", kind: "List", items: [.]}'
        fi
        ;;
      horizontalpodautoscaler/*)
        name=${resource#horizontalpodautoscaler/}
        if test "$name" = "$api_hpa_name"; then
          test -f "$state/api-hpa-present" || exit 1
          hpa_json rgs
        else
          test "$name" = "$worker_hpa_name"
          hpa_json rgs-worker
        fi
        ;;
      pod)
        selector=$(argument --selector "$@")
        component=${selector##*=}
        pod_list "$component"
        ;;
      secret)
        jq -n --arg namespace "$AWS_EKS_NAMESPACE" --arg release "$AWS_HELM_RELEASE_NAME" '{
          apiVersion: "v1", kind: "List", items: [{metadata: {namespace: $namespace,
            name: ("sh.helm.release.v1." + $release + ".v1"),
            labels: {owner: "helm", name: $release, status: "deployed"}}}]
        }'
        ;;
      configmap/slots-hmac-maintenance-lock)
        test "${MOCK_HMAC_KUBECTL_MODE:-}" != lock-check-error || exit 73
        if test -f "$state/fail-lock-readback-once"; then
          rm -f "$state/fail-lock-readback-once"
          exit 71
        fi
        if ! test -f "$state/maintenance-lock.json"; then
          for item in "$@"; do
            test "$item" != --ignore-not-found || exit 0
          done
          exit 1
        fi
        cat "$state/maintenance-lock.json"
        ;;
      *) printf '%s\n' "未实现的 get：$resource" >&2; exit 64 ;;
    esac
    ;;
  delete)
    resource=${1:-}
    shift || true
    while test "$#" -gt 0; do
      case "$1" in
        --namespace)
          test "$#" -ge 2
          test "$2" = "$AWS_EKS_NAMESPACE"
          shift 2
          ;;
        --wait=true)
          shift
          ;;
        --timeout)
          test "$#" -ge 2
          shift 2
          ;;
        *)
          printf '%s\n' "mock delete 拒绝未知参数：$1" >&2
          exit 64
          ;;
      esac
    done
    case "$resource" in
      horizontalpodautoscaler/"$api_hpa_name")
        rm -f "$state/api-hpa-present" "$state/restored-hpa.json"
        ;;
      configmap/slots-hmac-maintenance-lock)
        rm -f "$state/maintenance-lock.json"
        ;;
      *) exit 64 ;;
    esac
    ;;
  annotate)
    test "${1:-}" = "deployment/$api_name"
    ;;
  scale)
    resource=${1:-}
    replicas=$(argument --replicas "$@")
    test "$resource" = "deployment/$api_name"
    printf '%s\n' "$replicas" > "$state/api-replicas"
    if test "${MOCK_HMAC_KUBECTL_MODE:-}" = term-after-zero && test "$replicas" = 0; then
      kill -TERM "$PPID"
    fi
    ;;
  create)
    manifest=$(argument --filename "$@")
    kind=$(jq -er '.kind' "$manifest")
    if test "$kind" = ConfigMap; then
      test ! -f "$state/maintenance-lock.json"
      jq --arg uid "$lock_uid" '.metadata.uid = $uid' "$manifest" > "$state/maintenance-lock.json"
    else
      test "$kind" = HorizontalPodAutoscaler
      test ! -f "$state/api-hpa-present"
      cp "$manifest" "$state/restored-hpa.json"
      touch "$state/api-hpa-present"
    fi
    ;;
  patch)
    resource=${1:-}
    test "$resource" = configmap/slots-hmac-maintenance-lock
    test "${MOCK_HMAC_KUBECTL_MODE:-}" != lock-patch-failure || exit 72
    patch=$(argument --patch "$@")
    expected_uid=$(printf '%s' "$patch" | jq -er '.[0].value')
    test "$(jq -er '.metadata.uid' "$state/maintenance-lock.json")" = "$expected_uid"
    status=$(printf '%s' "$patch" | jq -er '.[] | select(.path == "/data/status") | .value')
    version=$(printf '%s' "$patch" | jq -er '.[] | select(.path == "/data/evidenceVersionId") | .value')
    sha=$(printf '%s' "$patch" | jq -er '.[] | select(.path == "/data/evidenceSha256") | .value')
    expires=$(printf '%s' "$patch" | jq -er '.[] | select(.path == "/data/evidenceExpiresAt") | .value')
    jq --arg status "$status" --arg version "$version" --arg sha "$sha" --arg expires "$expires" '
      .data.status = $status | .data.evidenceVersionId = $version |
      .data.evidenceSha256 = $sha | .data.evidenceExpiresAt = $expires
    ' "$state/maintenance-lock.json" > "$state/maintenance-lock.tmp"
    mv "$state/maintenance-lock.tmp" "$state/maintenance-lock.json"
    if test "${MOCK_HMAC_KUBECTL_MODE:-}" = lock-readback-failure; then
      touch "$state/fail-lock-readback-once"
    fi
    ;;
  rollout)
    test "${1:-}" = status
    ;;
  *) printf '%s\n' "未实现的 mock kubectl 调用：$command $*" >&2; exit 64 ;;
esac
