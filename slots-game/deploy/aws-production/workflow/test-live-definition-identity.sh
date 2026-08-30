#!/bin/sh

# 使用纯本地 fixture 证明数学定义普通滚动只接受首次安装或三元组完全一致。
# English: Use pure local fixtures to prove that the ordinary math-definition rollout only accepts first
# installation or triplet complete agreement.
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
gate="$script_directory/verify-live-definition-identity.sh"
mock_kubectl="$script_directory/fixtures/mock-definition-kubectl.sh"
values_file="$script_directory/fixtures/live-values.yaml"
chart_defaults="$script_directory/../../cluster-production/chart/values.yaml"
rendered_file="$script_directory/fixtures/definition-rendered.yaml"

fail() {
  printf '%s\n' "AWS 数学定义滚动 fixture 失败：$*" >&2
  exit 1
}

KUBECTL_BIN=$mock_kubectl "$gate" "$values_file" "$chart_defaults" \
  slots-production slots "$rendered_file" >/dev/null || fail '当前 API/Worker 匹配候选三元组仍被拒绝'

MOCK_DEFINITION_MODE=first-install KUBECTL_BIN=$mock_kubectl \
  "$gate" "$values_file" "$chart_defaults" slots-production slots "$rendered_file" >/dev/null || \
  fail 'API 与 Worker 均不存在的首次安装被拒绝'

MOCK_DEFINITION_MODE=renamed-current KUBECTL_BIN=$mock_kubectl \
  "$gate" "$values_file" "$chart_defaults" slots-production slots "$rendered_file" >/dev/null || \
  fail '门禁没有按 Helm release 标签识别改名前的现网 Deployment'

for mode in partial-install missing-annotation candidate-mismatch api-worker-divergence \
  orphaned-release unexpected-component; do
  if MOCK_DEFINITION_MODE=$mode KUBECTL_BIN=$mock_kubectl \
    "$gate" "$values_file" "$chart_defaults" slots-production slots "$rendered_file" \
    >/dev/null 2>&1; then
    fail "危险变体未被拒绝：$mode"
  fi
done

if KUBECTL_BIN=$mock_kubectl \
  "$gate" "$script_directory/fixtures/live-values-name-override.yaml" "$chart_defaults" \
  slots-production slots "$rendered_file" >/dev/null 2>&1; then
  fail 'AWS 正式发布错误接受了 fullnameOverride'
fi

printf '%s\n' 'AWS 数学定义滚动实时门禁 fixture 通过。'
