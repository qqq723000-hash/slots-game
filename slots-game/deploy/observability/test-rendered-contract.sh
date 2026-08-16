#!/bin/sh

# 该回归只在系统临时目录生成 bundle，不修改入库模板。static-regression 模式验证结构；
# 真实发布仍必须使用 --rendered-dir 和固定来源 promtool，不能以本脚本替代。
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
temporary_root=${TMPDIR:-/tmp}
temporary_root=${temporary_root%/}
test_root=$(mktemp -d "$temporary_root/rgs-rendered-contract.XXXXXX")

cleanup() {
  case "$test_root" in
    "$temporary_root"/rgs-rendered-contract.*)
      rm -rf -- "$test_root"
      ;;
    *)
      printf '%s\n' "rendered contract test: refusing to remove unexpected path $test_root" >&2
      ;;
  esac
}
trap cleanup EXIT

render_bundle() {
  destination=$1
  mkdir -p "$destination/rules" "$destination/grafana/dashboards"
  cp "$script_dir/prometheus.yml" "$destination/prometheus.yml"
  cp "$script_dir/rules/rgs-alerts.yml" "$destination/rules/rgs-alerts.yml"
  cp "$script_dir/grafana/dashboards/rgs-overview.json" \
    "$destination/grafana/dashboards/rgs-overview.json"
  ruby -e '
    ARGV.each do |path|
      value = File.read(path)
        .gsub("__ENVIRONMENT__", "ci-rendered")
        .gsub("__CLUSTER_ID__", "ci-rendered-cluster")
        .gsub("__ALERTMANAGER_TARGET__", "alertmanager.ci.invalid:443")
        .gsub("__RUNBOOK_BASE_URL__", "https://runbooks.ci.invalid")
      File.write(path, value)
    end
  ' "$destination/prometheus.yml" "$destination/rules/rgs-alerts.yml" \
    "$destination/grafana/dashboards/rgs-overview.json"
}

synthetic_digest='sha256:0000000000000000000000000000000000000000000000000000000000000000'
export PROMETHEUS_IMAGE="example.invalid/prometheus@$synthetic_digest"
export GRAFANA_IMAGE="example.invalid/grafana@$synthetic_digest"
export VECTOR_IMAGE="example.invalid/vector@$synthetic_digest"
export RGS_LOG_SINK_URI='https://logs.ci.invalid/v1/logs'

good_bundle="$test_root/good"
render_bundle "$good_bundle"
"$script_dir/verify-static-contract.sh" --rendered-static-dir "$good_bundle" >/dev/null

missing_rgs_bundle="$test_root/missing-rgs"
cp -R "$good_bundle" "$missing_rgs_bundle"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  value.fetch("scrape_configs").reject! { |job| job["job_name"] == "rgs" }
  File.write(path, YAML.dump(value))
' "$missing_rgs_bundle/prometheus.yml"
if "$script_dir/verify-static-contract.sh" --rendered-static-dir "$missing_rgs_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing RGS scrape was accepted' >&2
  exit 1
fi

missing_vector_bundle="$test_root/missing-vector"
cp -R "$good_bundle" "$missing_vector_bundle"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  value.fetch("scrape_configs").reject! { |job| job["job_name"] == "vector" }
  File.write(path, YAML.dump(value))
' "$missing_vector_bundle/prometheus.yml"
if "$script_dir/verify-static-contract.sh" --rendered-static-dir "$missing_vector_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing Vector scrape was accepted' >&2
  exit 1
fi

invalid_rules_bundle="$test_root/invalid-rules"
cp -R "$good_bundle" "$invalid_rules_bundle"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  first = value.fetch("groups").fetch(0).fetch("rules").fetch(0)
  first["alert"] = "IllegalMixedRule"
  File.write(path, YAML.dump(value))
' "$invalid_rules_bundle/rules/rgs-alerts.yml"
if "$script_dir/verify-static-contract.sh" --rendered-static-dir "$invalid_rules_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: structurally invalid rule was accepted' >&2
  exit 1
fi

# synthetic digest 绝不应被预载；production 模式必须因缺固定来源 promtool 而拒绝，且不能联网拉取。
if "$script_dir/verify-static-contract.sh" --rendered-dir "$good_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: release gate accepted an untrusted promtool source' >&2
  exit 1
fi

incompatible_tls_contract="$test_root/incompatible-tls-contract"
cp -R "$script_dir" "$incompatible_tls_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub("rsa:3072", "ed25519")
  abort "TLS algorithm mutation did not apply" if changed == value
  File.write(path, changed)
' "$incompatible_tls_contract/ci-runtime-production-smoke.sh"
if "$incompatible_tls_contract/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: incompatible PostgreSQL TLS algorithm was accepted' >&2
  exit 1
fi

printf '%s\n' \
  'observability rendered bundle regression: good accepted; missing RGS/Vector, invalid rules, untrusted promtool and incompatible PostgreSQL TLS rejected'
