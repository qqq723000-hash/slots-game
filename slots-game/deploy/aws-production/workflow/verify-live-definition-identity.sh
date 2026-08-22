#!/bin/sh

# 在 Helm upgrade 前比对候选数学定义与当前 API、Worker Pod 模板；不读取任何 Secret 值。
set -eu

fail() {
  printf '%s\n' "AWS 数学定义滚动门禁失败：$*" >&2
  exit 1
}

test "$#" -eq 5 || \
  fail '必须传入 Helm values、Chart 默认 values、namespace、Helm release 和候选渲染结果'
values_file=$1
chart_defaults_file=$2
namespace=$3
helm_release=$4
rendered_file=$5
kubectl_binary=${KUBECTL_BIN:-kubectl}

for file in "$values_file" "$chart_defaults_file" "$rendered_file"; do
  test -f "$file" || fail "找不到输入文件：$file"
done
printf '%s\n' "$namespace" | grep -Eq '^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$' || \
  fail 'namespace 不是严格 DNS label'
printf '%s\n' "$helm_release" | grep -Eq '^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$' || \
  fail 'Helm release 不是严格 DNS label'
command -v ruby >/dev/null 2>&1 || fail '缺少 ruby'
command -v jq >/dev/null 2>&1 || fail '缺少 jq'
command -v "$kubectl_binary" >/dev/null 2>&1 || fail "缺少命令：$kubectl_binary"

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/slots-definition-gate.XXXXXX")
cleanup() {
  case "$temporary_root" in
    "${TMPDIR:-/tmp}"/slots-definition-gate.*) rm -rf -- "$temporary_root" ;;
    *) fail '拒绝清理异常临时目录' ;;
  esac
}
trap cleanup EXIT HUP INT TERM

candidate_file="$temporary_root/candidate.json"
ruby -ryaml -rjson -e '
  def deep_merge(base, override)
    base.merge(override) do |_key, old_value, new_value|
      old_value.is_a?(Hash) && new_value.is_a?(Hash) ? deep_merge(old_value, new_value) : new_value
    end
  end

  defaults = YAML.safe_load(File.binread(ARGV.fetch(0)), permitted_classes: [],
    permitted_symbols: [], aliases: false)
  override = YAML.safe_load(File.binread(ARGV.fetch(1)), permitted_classes: [],
    permitted_symbols: [], aliases: false)
  abort "Chart 默认 values 顶层不是对象" unless defaults.is_a?(Hash)
  abort "Helm values 顶层不是对象" unless override.is_a?(Hash)
  values = deep_merge(defaults, override)
  abort "AWS 正式发布禁止 nameOverride/fullnameOverride" unless
    values.fetch("nameOverride", "").to_s.empty? && values.fetch("fullnameOverride", "").to_s.empty?
  identity = values.fetch("release").fetch("definitionIdentity")
  abort "definitionIdentity 必须精确包含三元组" unless
    identity.is_a?(Hash) && identity.keys.sort == %w[gameID sha256 version]
  %w[gameID version].each do |key|
    abort "#{key} 格式错误" unless
      identity.fetch(key).match?(/\A[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\z/)
  end
  abort "sha256 格式错误" unless identity.fetch("sha256").match?(/\A[0-9a-f]{64}\z/)

  expected_annotations = {
    "slots-game.io/definition-game-id" => identity.fetch("gameID"),
    "slots-game.io/definition-version" => identity.fetch("version"),
    "slots-game.io/definition-sha256" => identity.fetch("sha256"),
  }
  documents = YAML.load_stream(File.binread(ARGV.fetch(2))).compact
  deployments = documents.select { |document| document.is_a?(Hash) && document["kind"] == "Deployment" }
  selected = {}
  deployments.each do |deployment|
    component = deployment.dig("metadata", "labels", "app.kubernetes.io/component")
    next unless %w[rgs rgs-worker].include?(component)
    abort "候选渲染包含重复 #{component} Deployment" if selected.key?(component)
    rendered_namespace = deployment.dig("metadata", "namespace") || ARGV.fetch(3)
    abort "候选 Deployment namespace 不一致" unless rendered_namespace == ARGV.fetch(3)
    abort "候选 Deployment Helm release 标签不一致" unless
      deployment.dig("metadata", "labels", "app.kubernetes.io/instance") == ARGV.fetch(4)
    annotations = deployment.dig("spec", "template", "metadata", "annotations") || {}
    expected_annotations.each do |key, expected|
      abort "候选 #{component} 缺少或漂移 #{key}" unless annotations[key] == expected
    end
    selected[component] = deployment.dig("metadata", "name")
  end
  abort "候选渲染必须恰好包含 API 与 Worker Deployment" unless selected.keys.sort == %w[rgs rgs-worker]
  abort "候选 API 与 Worker Deployment 名不得相同" if selected.values.uniq.length != 2
  STDOUT.write(JSON.generate({"identity" => identity, "deployments" => selected}))
' "$chart_defaults_file" "$values_file" "$rendered_file" "$namespace" "$helm_release" \
  > "$candidate_file" || fail '无法从 values 和候选渲染结果提取数学定义身份'

game_id=$(jq -er '.identity.gameID' "$candidate_file") || fail '候选 gameID 为空'
definition_version=$(jq -er '.identity.version' "$candidate_file") || fail '候选 definition version 为空'
definition_sha256=$(jq -er '.identity.sha256' "$candidate_file") || fail '候选 definition sha256 为空'

current_file="$temporary_root/current-deployments.json"
release_selector="app.kubernetes.io/instance=${helm_release}"
"$kubectl_binary" -n "$namespace" get deployment -l "$release_selector" -o json \
  > "$current_file" || fail '按 Helm release 标签读取当前 Deployment 失败'

deployment_count=$(jq -er '.items | length' "$current_file") || fail '当前 Deployment 列表格式错误'
case "$deployment_count" in
  0)
    release_file="$temporary_root/current-release-secrets.json"
    "$kubectl_binary" -n "$namespace" get secret -l "owner=helm,name=${helm_release}" -o json \
      > "$release_file" || fail '读取当前 Helm release 记录失败'
    jq -e '.apiVersion == "v1" and .kind == "List" and (.items | length) == 0' \
      "$release_file" >/dev/null || \
      fail 'Helm release 记录仍存在，拒绝把缺失 Deployment 误判为首次安装'
    printf '%s\n' 'AWS 数学定义滚动门禁通过：确认 Deployment 与 Helm release 均不存在，允许首次安装。'
    ;;
  2)
    jq -e --arg namespace "$namespace" --arg release "$helm_release" \
      --arg game_id "$game_id" --arg definition_version "$definition_version" \
      --arg definition_sha256 "$definition_sha256" '
      .apiVersion == "v1" and .kind == "List" and
      ([.items[].metadata.labels["app.kubernetes.io/component"]] | sort) == ["rgs", "rgs-worker"] and
      all(.items[];
        .apiVersion == "apps/v1" and .kind == "Deployment" and
        .metadata.namespace == $namespace and
        .metadata.labels["app.kubernetes.io/instance"] == $release and
        .spec.template.metadata.annotations["slots-game.io/definition-game-id"] == $game_id and
        .spec.template.metadata.annotations["slots-game.io/definition-version"] == $definition_version and
        .spec.template.metadata.annotations["slots-game.io/definition-sha256"] == $definition_sha256)
    ' "$current_file" >/dev/null || \
      fail '当前 API、Worker 数学定义身份、标签或拓扑与候选不一致'
    printf '%s\n' 'AWS 数学定义滚动门禁通过：当前 API、Worker 与候选三元组完全一致。'
    ;;
  *) fail '当前 Helm release 的 API/Worker Deployment 数量异常，拒绝误判首次安装' ;;
esac
