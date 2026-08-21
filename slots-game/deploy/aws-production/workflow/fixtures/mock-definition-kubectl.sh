#!/bin/sh

# 只模拟数学定义滚动门禁按 Helm release 标签读取资源，不连接任何集群。
set -eu

test "$#" -eq 8
test "$1" = -n
namespace=$2
test "$3" = get
resource=$4
test "$5" = -l
selector=$6
test "$7" = -o
test "$8" = json

mode=${MOCK_DEFINITION_MODE:-matching}

if test "$resource" = secret; then
  test "$selector" = 'owner=helm,name=slots'
  jq -n --arg namespace "$namespace" --arg mode "$mode" '
    {
      apiVersion: "v1",
      kind: "List",
      items: (if $mode == "orphaned-release" then [{
        apiVersion: "v1",
        kind: "Secret",
        metadata: {namespace: $namespace, name: "sh.helm.release.v1.slots.v7"}
      }] else [] end)
    }
  '
  exit 0
fi

test "$resource" = deployment
test "$selector" = 'app.kubernetes.io/instance=slots'

jq -n --arg namespace "$namespace" --arg mode "$mode" '
  def deployment($name; $component): {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      namespace: $namespace,
      name: $name,
      labels: {
        "app.kubernetes.io/instance": "slots",
        "app.kubernetes.io/component": $component
      }
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            "slots-game.io/definition-game-id": "iron-colossus",
            "slots-game.io/definition-version": "definition-v1",
            "slots-game.io/definition-sha256":
              "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
          }
        }
      }
    }
  };
  (if $mode == "renamed-current" then "legacy-rgs" else "slots-slots-cluster-production-rgs" end) as $api_name |
  (if $mode == "renamed-current" then "legacy-rgs-worker" else "slots-slots-cluster-production-rgs-worker" end) as $worker_name |
  [
    deployment($api_name; "rgs"),
    deployment($worker_name; "rgs-worker")
  ] |
  if $mode == "first-install" or $mode == "orphaned-release" then []
  elif $mode == "partial-install" then .[0:1]
  elif $mode == "missing-annotation" then
    .[0].spec.template.metadata.annotations |= del(."slots-game.io/definition-sha256")
  elif $mode == "candidate-mismatch" then
    .[0].spec.template.metadata.annotations."slots-game.io/definition-version" = "definition-v0"
  elif $mode == "api-worker-divergence" then
    .[1].spec.template.metadata.annotations."slots-game.io/definition-sha256" =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
  elif $mode == "unexpected-component" then
    .[1].metadata.labels."app.kubernetes.io/component" = "web"
  else . end |
  {apiVersion: "v1", kind: "List", items: .}
'
