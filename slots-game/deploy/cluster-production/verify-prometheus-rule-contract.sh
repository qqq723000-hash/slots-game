#!/bin/sh
# 用固定摘要的 promtool 解析 Helm 实际渲染规则，防止 CRD 结构正确但 PromQL 语法失效。
# English: Use fixed-digest promtool to parse Helm's actual rendering rules to prevent the CRD structure from
# being correct but the PromQL syntax from being invalid.
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
chart_directory="$script_directory/chart"
example_values="$script_directory/values.example.yaml"
helm_binary=${HELM_BIN:-helm}
promtool_image='prom/prometheus:v3.13.1@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893'
temporary_root=${TMPDIR:-/tmp}
fixture_directory=$(mktemp -d "${temporary_root%/}/slots-cluster-prometheus-rule.XXXXXX")

fail() {
  printf '%s\n' "cluster prometheus rule contract: $*" >&2
  exit 1
}

cleanup() {
  case "$fixture_directory" in
    "${temporary_root%/}"/slots-cluster-prometheus-rule.*) rm -rf -- "$fixture_directory" ;;
    *) fail "拒绝清理异常路径 $fixture_directory" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

for command in "$helm_binary" docker sed grep mktemp; do
  command -v "$command" >/dev/null 2>&1 || fail "缺少命令 $command"
done

rendered_rule="$fixture_directory/prometheusrule.yaml"
prometheus_rule="$fixture_directory/rules.yaml"
rule_tests="$script_directory/prometheus-rule-tests.yaml"
test -f "$rule_tests" || fail '缺少 PromQL 行为测试'
"$helm_binary" template slots "$chart_directory" \
  --namespace slots-production \
  -f "$example_values" \
  --show-only templates/prometheusrule.yaml > "$rendered_rule"
sed -n '/^  groups:/,$p' "$rendered_rule" | sed 's/^  //' > "$prometheus_rule"
grep -F -x 'groups:' "$prometheus_rule" >/dev/null || fail '没有从 PrometheusRule 提取规则组'

docker run --rm --platform linux/amd64 \
  --entrypoint /bin/promtool \
  --mount "type=bind,src=$prometheus_rule,dst=/rules.yaml,readonly" \
  "$promtool_image" check rules /rules.yaml

docker run --rm --platform linux/amd64 \
  --entrypoint /bin/promtool \
  --mount "type=bind,src=$prometheus_rule,dst=/rules.yaml,readonly" \
  --mount "type=bind,src=$rule_tests,dst=/tests.yaml,readonly" \
  "$promtool_image" test rules /tests.yaml

printf '%s\n' 'cluster prometheus rule contract: passed'
