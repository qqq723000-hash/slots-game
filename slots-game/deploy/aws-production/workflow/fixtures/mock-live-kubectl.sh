#!/bin/sh

# 只模拟平台实时门禁读取的 Kubernetes 对象，不连接任何集群。
set -eu

fail() {
  printf '%s\n' "Kubernetes 平台 fixture 调用错误：$*" >&2
  exit 2
}

emit_deployment() {
  deployment_name=$1
  case "$deployment_name" in
    aws-load-balancer-controller)
      jq -n '
        {
          metadata: {labels: {"helm.sh/chart": "aws-load-balancer-controller-1.2.3"}},
          spec: {template: {spec: {
            serviceAccountName: "aws-load-balancer-controller",
            containers: [{
              name: "aws-load-balancer-controller",
              args: ["--cluster-name=slots-prod-primary", "--ingress-class=alb"]
            }]
          }}}
        }
      '
      ;;
    cluster-autoscaler)
      jq -n '
        {
          metadata: {labels: {"helm.sh/chart": "cluster-autoscaler-1.2.3"}},
          spec: {template: {spec: {
            serviceAccountName: "cluster-autoscaler",
            containers: [{
              name: "cluster-autoscaler",
              image: "registry.k8s.io/autoscaling/cluster-autoscaler:v1.30.2",
              args: [
                "--cloud-provider=aws",
                "--node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/slots-prod-primary"
              ],
              env: [{name: "AWS_REGION", value: "ap-southeast-1"}]
            }]
          }}}
        }
      '
      ;;
    external-secrets)
      jq -n '
        {
          metadata: {labels: {"helm.sh/chart": "external-secrets-1.2.3"}},
          spec: {template: {spec: {
            serviceAccountName: "external-secrets",
            containers: [{name: "external-secrets"}]
          }}}
        }
      '
      ;;
    kube-prometheus-stack-operator)
      jq -n '
        {
          metadata: {labels: {"helm.sh/chart": "kube-prometheus-stack-1.2.3"}},
          spec: {template: {spec: {
            serviceAccountName: "kube-prometheus-stack-operator",
            containers: [{name: "kube-prometheus-stack"}]
          }}}
        }
      '
      ;;
    metrics-server)
      jq -n '
        {
          spec: {template: {spec: {
            serviceAccountName: "metrics-server",
            containers: [{name: "metrics-server"}]
          }}}
        }
      '
      ;;
    kube-prometheus-stack-kube-state-metrics)
      jq -n '
        {
          metadata: {
            labels: {
              "app.kubernetes.io/instance": "kube-prometheus-stack",
              "app.kubernetes.io/name": "kube-state-metrics"
            },
            annotations: {
              "meta.helm.sh/release-name": "kube-prometheus-stack",
              "meta.helm.sh/release-namespace": "monitoring"
            }
          },
          spec: {template: {spec: {
            serviceAccountName: "kube-prometheus-stack-kube-state-metrics",
            containers: [{
              name: "kube-state-metrics",
              image: "registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.15.0"
            }]
          }}}
        }
      '
      ;;
    *) fail "未知 Deployment：$deployment_name" ;;
  esac
}

emit_native_secret() {
  namespace=$1
  secret_name=$2
  jq -n --arg namespace "$namespace" --arg name "$secret_name" \
    --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        namespace: $namespace,
        name: $name,
        ownerReferences: [{kind: "ExternalSecret", name: $name}]
      },
      type: "Opaque",
      immutable: true,
      data: {
        "database-url": "Zml4dHVyZQ==",
        "operations.token": "Zml4dHVyZQ==",
        "username": "Zml4dHVyZQ==",
        "password": "Zml4dHVyZQ==",
        "hmac.key": "Zml4dHVyZQ==",
        "root-ca.pem": "Zml4dHVyZQ==",
        "operators.json": "Zml4dHVyZQ==",
        "definition.json": "Zml4dHVyZQ==",
        "definition-approval.json": "Zml4dHVyZQ==",
        "definition-approval-public.pem": "Zml4dHVyZQ==",
        "launch-hmac.key": "Zml4dHVyZQ==",
        "outbox-hmac.key": "Zml4dHVyZQ==",
        "outbox-bearer.token": "Zml4dHVyZQ==",
        "outbox-root-ca.pem": "Zml4dHVyZQ==",
        "trust-bundle.pem": "Zml4dHVyZQ==",
        "operator-access-private.pem": "Zml4dHVyZQ==",
        "operator-access-public.pem": "Zml4dHVyZQ==",
        "operator-request-public.pem": "Zml4dHVyZQ==",
        "operator-response-private.pem": "Zml4dHVyZQ==",
        "operator-response-public.pem": "Zml4dHVyZQ==",
        "wallet-request-private.pem": "Zml4dHVyZQ==",
        "wallet-request-public.pem": "Zml4dHVyZQ==",
        "wallet-response-public.pem": "Zml4dHVyZQ=="
      }
    }
    | if $mode == "missing-api-key" and ($name | contains("api-runtime-assets"))
      then del(.data["launch-hmac.key"])
      elif $mode == "missing-shared-username" and ($name | contains("shared-admission"))
      then del(.data.username)
      else .
      end
  '
}

if test "$#" -ge 1 && test "$1" = config; then
  printf '%s' 'arn:aws:eks:ap-southeast-1:123456789012:cluster/slots-prod-primary'
  exit 0
fi

if test "$#" -eq 2 && test "$1" = get && test "$2" = --raw=/readyz; then
  printf '%s\n' ok
  exit 0
fi

if test "$#" -ge 1 && test "$1" = -n; then
  test "$#" -ge 4 || fail 'namespace 调用参数不足'
  namespace=$2
  shift 2
  operation=$1
  resource=$2
  case "$operation" in
    rollout)
      test "$resource" = status || fail '只允许 rollout status'
      exit 0
      ;;
    wait)
      exit 0
      ;;
    get)
      case "$resource" in
        serviceaccount/*) exit 0 ;;
        deployment/*)
          emit_deployment "${resource#deployment/}"
          ;;
        externalsecret/*)
          secret_name=${resource#externalsecret/}
          jq -n --arg name "$secret_name" '
            {status: {syncedResourceVersion: "fixture-version"}, spec: {target: {name: $name}}}
          '
          ;;
        secret/*)
          emit_native_secret "$namespace" "${resource#secret/}"
          ;;
        prometheusagent/prometheus-agent)
          jq -n '
            {
              spec: {
                serviceAccountName: "prometheus-agent",
                version: "v1.2.3",
                replicas: 2,
                serviceMonitorSelector: {
                  matchLabels: {"app.kubernetes.io/part-of": "slots-game"}
                },
                serviceMonitorNamespaceSelector: {
                  matchLabels: {"kubernetes.io/metadata.name": "slots-production"}
                },
                remoteWrite: [{
                  url: "https://aps-workspaces.ap-southeast-1.amazonaws.com/workspaces/ws-1234567890abcdef/api/v1/remote_write",
                  sigv4: {region: "ap-southeast-1"}
                }]
              },
              status: {
                availableReplicas: 2,
                conditions: [
                  {type: "Reconciled", status: "True"},
                  {type: "Available", status: "True"}
                ]
              }
            }
          '
          ;;
        *) fail "未知 namespace 资源：$resource" ;;
      esac
      ;;
    *) fail "未知 namespace 操作：$operation" ;;
  esac
  exit 0
fi

if test "$#" -ge 2 && test "$1" = get; then
  case "$2" in
    apiservice/v1beta1.metrics.k8s.io)
      jq -n '
        {
          status: {
            conditions: [{type: "Available", status: "True"}]
          }
        }
      '
      ;;
    customresourcedefinition|ingressclass) exit 0 ;;
    *) fail "未知集群级资源：$2" ;;
  esac
  exit 0
fi

fail '未知 kubectl 调用'
