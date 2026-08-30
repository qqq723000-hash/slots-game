#!/bin/sh

# 只模拟平台实时门禁读取的 Kubernetes 对象，不连接任何集群。
# English: It only simulates the Kubernetes object read by the platform's live gate and does not connect to any
# cluster.
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
  esac | jq \
    --arg deployment "$deployment_name" \
    --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
      if [
        "aws-load-balancer-controller",
        "cluster-autoscaler",
        "external-secrets",
        "kube-prometheus-stack-operator"
      ] | index($deployment) then
        .metadata.generation = 7 |
        .spec.replicas = 2 |
        .status = {
          observedGeneration: 7,
          replicas: 2,
          updatedReplicas: 2,
          readyReplicas: 2,
          availableReplicas: 2,
          unavailableReplicas: 0
        } |
        if $mode == ("addon-" + $deployment + "-zero") then
          .spec.replicas = 0 |
          .status.replicas = 0 |
          .status.updatedReplicas = 0 |
          .status.readyReplicas = 0 |
          .status.availableReplicas = 0
        elif $mode == ("addon-" + $deployment + "-partial") then
          .status.readyReplicas = 1 |
          .status.availableReplicas = 1 |
          .status.unavailableReplicas = 1
        elif $mode == ("addon-" + $deployment + "-unobserved") then
          .metadata.generation = 8
        elif $mode == ("addon-" + $deployment + "-extra-old-replica") then
          .status.replicas = 3
        elif $mode == ("addon-" + $deployment + "-deleting") then
          .metadata.deletionTimestamp = "2026-08-24T00:00:00Z"
        else . end
      else . end
    '
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
      if test "${MOCK_PLATFORM_MODE:-valid}" = cloudwatch-agent-workload-not-ready && \
        test "${3:-}" = daemonset/cloudwatch-agent; then
        exit 1
      fi
      if test "${MOCK_PLATFORM_MODE:-valid}" = cloudwatch-fluent-bit-not-ready && \
        test "${3:-}" = daemonset/fluent-bit; then
        exit 1
      fi
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
        daemonset/*)
          daemonset_name=${resource#daemonset/}
          case "$daemonset_name" in cloudwatch-agent|fluent-bit) ;; *) fail "未知 DaemonSet：$daemonset_name" ;; esac
          jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" --arg name "$daemonset_name" '
            (($mode == "cloudwatch-agent-workload-not-ready" and $name == "cloudwatch-agent") or
              ($mode == "cloudwatch-fluent-bit-not-ready" and $name == "fluent-bit")) as $not_ready |
            {
              spec: {template: {spec: {
                serviceAccountName: (if $name == "cloudwatch-agent" then "cloudwatch-agent"
                  elif $mode == "cloudwatch-fluent-bit-sa-drift" then "forbidden-fluent-bit"
                  else "fluent-bit" end),
                containers: [{name: (if $mode == "cloudwatch-fluent-bit-container-drift" and $name == "fluent-bit"
                  then "forbidden-container" else $name end)}]
              }}},
              status: {
                desiredNumberScheduled: 3,
                currentNumberScheduled: (if $not_ready then 2 else 3 end),
                updatedNumberScheduled: (if $not_ready then 2 else 3 end),
                numberReady: (if $not_ready then 2 else 3 end),
                numberAvailable: (if $not_ready then 2 else 3 end),
                numberUnavailable: (if $not_ready then 1 else 0 end)
              }
            }
          '
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
        ingress)
          test "${3:-}" = -l || fail 'Ingress 查询缺少 selector'
          test "${4:-}" = 'app.kubernetes.io/component=rgs,app.kubernetes.io/instance=slots' || \
            fail 'Ingress 未绑定当前 Helm release selector'
          jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
            {items: [{
              metadata: {name: "slots-rgs-api"},
              spec: {ingressClassName: "alb", rules: [{host: "api.example.com", http: {paths: [{
                path: "/", pathType: "Prefix"
              }]}}]},
              status: {loadBalancer: {ingress: (if $mode == "alb-ingress-hostname-missing"
                then [] else [{hostname: "slots-prod-primary-api-123456.ap-southeast-1.elb.amazonaws.com"}] end)}}
            }]}
          '
          ;;
        networkpolicy)
          if test "${3:-}" != -o || test "${4:-}" != json; then
            fail 'NetworkPolicy 必须回读 namespace 全量对象'
          fi
          jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
            def default_deny: {
              metadata: {name: "slots-default-deny", labels: {
                "app.kubernetes.io/instance": "slots"
              }},
              spec: {
                podSelector: {matchLabels: {
                  "app.kubernetes.io/name": "slots-cluster-production",
                  "app.kubernetes.io/instance": "slots"
                }},
                policyTypes: ["Ingress", "Egress"]
              }
            };
            def monitoring_source: {
              namespaceSelector: {matchLabels: (if $mode == "networkpolicy-monitoring-selector-empty"
                then {} elif $mode == "networkpolicy-monitoring-selector-drift"
                then {"kubernetes.io/metadata.name": "foreign-monitoring"}
                else {"kubernetes.io/metadata.name": "monitoring"} end)},
              podSelector: {matchLabels: {"app.kubernetes.io/name": "prometheus-agent"}}
            };
            def rgs_ingress: {
              metadata: {name: "slots-rgs-ingress", labels: {
                "app.kubernetes.io/instance": "slots",
                "app.kubernetes.io/component": "rgs"
              }},
              spec: {
                podSelector: {matchLabels: ({
                  "app.kubernetes.io/name": "slots-cluster-production",
                  "app.kubernetes.io/instance": "slots",
                  "app.kubernetes.io/component": "rgs"
                } | if $mode == "networkpolicy-rgs-selector-widened" then
                  del(."app.kubernetes.io/component") else . end)},
                policyTypes: ["Ingress"],
                ingress: ([
                  {
                    from: ["10.30.0.0/24", "10.30.1.0/24", "10.30.2.0/24"] | map({ipBlock: {
                      cidr: (if $mode == "networkpolicy-alb-cidr-drift" and . == "10.30.2.0/24"
                        then "10.31.0.0/16" else . end)
                    }}),
                    ports: [
                      {port: 8080, protocol: "TCP"},
                      {port: (if $mode == "networkpolicy-alb-port-drift" then 9090 else 8081 end), protocol: "TCP"}
                    ]
                  },
                  {from: [monitoring_source], ports: [{port: 8081, protocol: "TCP"}]}
                ] + (if $mode == "networkpolicy-extra-ingress" then [{
                  from: [{ipBlock: {cidr: "10.0.0.0/8"}}], ports: [{port: 8080, protocol: "TCP"}]
                }] else [] end))
              }
            };
            def extra_rgs_allow: {
              metadata: {name: "foreign-rgs-allow", labels: {"app.kubernetes.io/instance": "slots"}},
              spec: {
                podSelector: {matchLabels: {
                  "app.kubernetes.io/name": "slots-cluster-production",
                  "app.kubernetes.io/instance": "slots"
                }},
                policyTypes: ["Ingress"],
                ingress: [{from: [{ipBlock: {cidr: "10.0.0.0/8"}}], ports: [{port: 8080, protocol: "TCP"}]}]
              }
            };
            def unlabeled_rgs_allow: {
              metadata: {name: "unlabeled-rgs-allow"},
              spec: {
                podSelector: {matchLabels: {
                  "app.kubernetes.io/name": "slots-cluster-production",
                  "app.kubernetes.io/instance": "slots"
                }},
                policyTypes: ["Ingress"],
                ingress: [{from: [{ipBlock: {cidr: "10.0.0.0/8"}}], ports: [{port: 8080, protocol: "TCP"}]}]
              }
            };
            def foreign_instance_rgs_allow: {
              metadata: {name: "foreign-instance-rgs-allow", labels: {
                "app.kubernetes.io/instance": "foreign-release"
              }},
              spec: {
                podSelector: {matchLabels: {
                  "app.kubernetes.io/name": "slots-cluster-production",
                  "app.kubernetes.io/instance": "slots"
                }},
                policyTypes: ["Ingress"],
                ingress: [{from: [{ipBlock: {cidr: "10.0.0.0/8"}}], ports: [{port: 8080, protocol: "TCP"}]}]
              }
            };
            ([default_deny, rgs_ingress] |
              if $mode == "networkpolicy-default-deny-missing" then map(select(.metadata.name != "slots-default-deny"))
              elif $mode == "networkpolicy-extra-rgs-policy" then . + [extra_rgs_allow]
              elif $mode == "networkpolicy-unlabeled-rgs-policy" then . + [unlabeled_rgs_allow]
              elif $mode == "networkpolicy-foreign-instance-rgs-policy" then . + [foreign_instance_rgs_allow]
              else . end) | {items: .}
          '
          ;;
        pods)
          test "${3:-}" = -l || fail 'Pod 查询缺少 selector'
          test "${4:-}" = 'app.kubernetes.io/component=rgs,app.kubernetes.io/instance=slots' || \
            fail 'Pod 未绑定当前 Helm release selector'
          jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
            {items: [{
              metadata: {name: "slots-rgs-api-7f8c9d-abcde"},
              status: {
                phase: "Running",
                podIP: (if $mode == "alb-current-target-missing" then "10.30.10.11" else "10.30.10.10" end),
                conditions: [{type: "Ready", status: "True"}]
              }
            }]}
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
