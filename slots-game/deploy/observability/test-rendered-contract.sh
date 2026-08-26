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
        .gsub("__ALERTMANAGER_SERVER_NAME__", "alertmanager.ci.invalid")
        .gsub("__RUNBOOK_BASE_URL__", "https://runbooks.ci.invalid")
      File.write(path, value)
    end
  ' "$destination/prometheus.yml" "$destination/rules/rgs-alerts.yml" \
    "$destination/grafana/dashboards/rgs-overview.json"
}

# 源码级负向测试必须保留 verify-static-contract.sh 计算仓库根目录所依赖的拓扑；
# 只复制 observability 子目录会因 metrics.go 缺失而“误通过”任意变异测试。
copy_contract_repository() {
  destination=$1
  mkdir -p "$destination/deploy" "$destination/server/internal/platform"
  cp -R "$script_dir" "$destination/deploy/observability"
  mkdir -p "$destination/deploy/local-production"
  cp "$script_dir/../local-production/vector.yaml" "$destination/deploy/local-production/vector.yaml"
  cp "$script_dir/../../server/internal/platform/metrics.go" \
    "$destination/server/internal/platform/metrics.go"
}

# Vector 语义负测必须先刷新复制件中的审阅摘要，避免仅由旧摘要拒绝而未真正覆盖结构断言。
refresh_reviewed_vector_digest() {
  contract_root=$1
  relative_path=$2
  original_path=$3
  ruby -rdigest - "$contract_root/deploy/observability/verify-static-contract.sh" \
    "$contract_root/$relative_path" "$original_path" <<'RUBY'
contract_path, mutated_path, original_path = ARGV
contract = File.read(contract_path)
original_digest = Digest::SHA256.file(original_path).hexdigest
mutated_digest = Digest::SHA256.file(mutated_path).hexdigest
changed = contract.sub(original_digest, mutated_digest)
abort "reviewed Vector digest mutation did not apply" if changed == contract
File.write(contract_path, changed)
RUBY
}

synthetic_digest='sha256:0000000000000000000000000000000000000000000000000000000000000000'
export PROMETHEUS_IMAGE="example.invalid/prometheus@$synthetic_digest"
export GRAFANA_IMAGE="example.invalid/grafana@$synthetic_digest"
export VECTOR_IMAGE="example.invalid/vector@$synthetic_digest"
export RGS_LOG_SINK_URI='https://logs.ci.invalid/v1/logs'
export RGS_OPERATIONS_TARGET='rgs-server:8081'
export ALERTMANAGER_TARGET='alertmanager.ci.invalid:443'
export ALERTMANAGER_CA_FILE='/run/secrets/alertmanager_root_ca.pem'
export ALERTMANAGER_SERVER_NAME='alertmanager.ci.invalid'
export PROMETHEUS_RENDER_PROFILE='central'

good_bundle="$test_root/good"
render_bundle "$good_bundle"
"$script_dir/verify-static-contract.sh" --rendered-static-dir "$good_bundle" >/dev/null

local_profile_bundle="$test_root/local-profile"
cp -R "$good_bundle" "$local_profile_bundle"
ruby -e '
  ARGV.each do |path|
    value = File.read(path).gsub(
      "https://runbooks.ci.invalid",
      "https://slots.localhost:8443/operator/runbooks"
    )
    File.write(path, value)
  end
' "$local_profile_bundle/rules/rgs-alerts.yml" \
  "$local_profile_bundle/grafana/dashboards/rgs-overview.json"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  value.fetch("global").fetch("external_labels").replace({
    "environment" => "production", "cluster" => "local-mac"
  })
  value.fetch("scrape_configs").each do |job|
    job.fetch("static_configs").fetch(0).fetch("labels")["environment"] = "production"
  end
  value.fetch("scrape_configs") << {
    "job_name" => "local-operator",
    "scheme" => "https",
    "metrics_path" => "/metrics",
    "honor_labels" => false,
    "authorization" => {
      "type" => "Bearer",
      "credentials_file" => "/run/secrets/local_operator_metrics_bearer_token"
    },
    "tls_config" => {
      "ca_file" => "/run/secrets/local-production-root-ca.pem",
      "server_name" => "wallet",
      "min_version" => "TLS12",
      "insecure_skip_verify" => false
    },
    "static_configs" => [{
      "targets" => ["wallet:8443"],
      "labels" => { "service" => "local-operator", "environment" => "production" }
    }]
  }
  manager = value.fetch("alerting").fetch("alertmanagers").fetch(0)
  manager.fetch("static_configs").fetch(0)["targets"] = ["alert-proxy:8443"]
  manager.fetch("tls_config").replace({
    "ca_file" => "/run/secrets/alertmanager_root_ca.pem",
    "server_name" => "alert-proxy",
    "min_version" => "TLS12",
    "insecure_skip_verify" => false
  })
  File.write(path, YAML.dump(value))
' "$local_profile_bundle/prometheus.yml"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  build_rule = lambda do |name, expression, duration, severity, service, summary, description, slug|
    {
      "alert" => name,
      "expr" => expression,
      "for" => duration,
      "labels" => { "severity" => severity, "service" => service },
      "annotations" => {
        "summary" => summary,
        "description" => description,
        "runbook_url" => "https://slots.localhost:8443/operator/runbooks/#{slug}"
      }
    }
  end
  rules = [
    build_rule.call(
      "LocalOperatorUnavailable",
      "(max_over_time(local_operator_ready{job=\"local-operator\"}[2m]) < 1) or absent(local_operator_ready{job=\"local-operator\"})",
      "2m", "critical", "local-operator", "本机运营钱包或持久化文件不可用",
      "数据库或持久化文件句柄连续不可用；容量水位由独立告警覆盖。", "local-operator-unavailable"
    ),
    build_rule.call(
      "LocalProductionBackupStatusUnreadable",
      "(local_production_backup_status_file_readable{job=\"local-operator\"} < 1) or absent(local_production_backup_status_file_readable{job=\"local-operator\"})",
      "2m", "critical", "backup", "本机备份状态文件不可读",
      "原子备份状态缺失或校验失败，备份新鲜度不可证明。", "backup-status-unreadable"
    ),
    build_rule.call(
      "LocalProductionBackupFailed",
      "local_production_backup_consecutive_failures{job=\"local-operator\"} > 0",
      "2m", "critical", "backup", "本机数据库备份连续失败",
      "周期任务正在按一分钟间隔重试；检查数据库 TLS、凭据、磁盘与归档权限。", "backup-failed"
    ),
    build_rule.call(
      "LocalProductionBackupStale",
      "(time() - local_production_backup_last_success_timestamp_seconds{job=\"local-operator\"} > 25200) or (local_production_backup_last_success_timestamp_seconds{job=\"local-operator\"} <= 0) or absent(local_production_backup_last_success_timestamp_seconds{job=\"local-operator\"})",
      "10m", "critical", "backup", "本机备份超过七小时未成功",
      "六小时备份周期已越过一小时容错窗口；恢复点目标无法满足。", "backup-stale"
    )
  ]
  [
    ["Audit", "audit", "审计"],
    ["Log", "log", "运行日志"],
    ["Alert", "alert", "告警归档"]
  ].each do |title, metric, chinese|
    rules << build_rule.call(
      "LocalOperator#{title}StoreNearCapacity",
      "(local_operator_#{metric}_store_bytes{job=\"local-operator\"} / clamp_min(local_operator_#{metric}_store_capacity_bytes{job=\"local-operator\"}, 1) > 0.75) or absent(local_operator_#{metric}_store_bytes{job=\"local-operator\"})",
      "10m", "warning", "local-operator", "本机#{chinese}存储接近容量上限",
      "#{chinese}分段归档已超过硬容量的 75%；先确认备份完整，再处理最旧只读段。",
      "#{metric}-store-capacity"
    )
    rules << build_rule.call(
      "LocalOperator#{title}StoreNotWritable",
      "(local_operator_#{metric}_store_writable{job=\"local-operator\"} < 1) or absent(local_operator_#{metric}_store_writable{job=\"local-operator\"})",
      "2m", "critical", "local-operator", "本机#{chinese}存储无法接受最大批次",
      "#{chinese}硬容量剩余不足；服务保持可观测但对应 sink 会失败闭合。",
      "#{metric}-store-not-writable"
    )
  end
  value.fetch("groups") << {
    "name" => "local-production-operator-alerts",
    "interval" => "30s",
    "rules" => rules
  }
  File.write(path, YAML.dump(value))
' "$local_profile_bundle/rules/rgs-alerts.yml"
ruby -rjson -e '
  path = ARGV.fetch(0)
  value = JSON.parse(File.read(path))
  panels = value.fetch("panels")
  clone = ->(item) { Marshal.load(Marshal.dump(item)) }
  target = lambda do |expression, legend, reference|
    {
      "editorMode" => "code", "expr" => expression, "legendFormat" => legend,
      "range" => true, "refId" => reference
    }
  end
  readiness = clone.call(panels.find { |panel| panel["id"] == 1 })
  readiness["id"] = 20
  readiness["title"] = "本机运营服务就绪状态"
  readiness["description"] = "同时显示 TLS/Bearer 指标抓取状态与数据库、审计/日志容量就绪状态。"
  readiness["gridPos"] = { "h" => 6, "w" => 8, "x" => 0, "y" => 21 }
  readiness["targets"] = [
    target.call("min(up{job=\"local-operator\"})", "operator scrape", "A"),
    target.call("min(local_operator_ready{job=\"local-operator\"}) or vector(0)", "operator readiness", "B")
  ]
  traffic = clone.call(panels.find { |panel| panel["id"] == 2 })
  traffic["id"] = 21
  traffic["title"] = "本机运营流量与异常"
  traffic["gridPos"] = { "h" => 6, "w" => 16, "x" => 8, "y" => 21 }
  traffic["targets"] = [
    target.call("sum(rate(local_operator_requests_total[5m]))", "requests/s", "A"),
    target.call("sum(rate(local_operator_failures_total[5m]))", "failures/s", "B"),
    target.call("sum(rate(local_operator_launches_total[5m]))", "launches/s", "C"),
    target.call("sum(rate(local_operator_audit_accepted_total[5m]))", "audit batches/s", "D"),
    target.call("sum(rate(local_operator_log_batches_total[5m]))", "log batches/s", "E")
  ]
  storage = clone.call(panels.find { |panel| panel["id"] == 2 })
  storage["id"] = 22
  storage["title"] = "本机持久化容量使用率"
  storage["description"] = "审计、脱敏日志和 Alertmanager 本地通知的分段归档容量；75% 触发预警。"
  storage["gridPos"] = { "h" => 6, "w" => 12, "x" => 0, "y" => 27 }
  storage["targets"] = []
  [["audit", "A", "B"], ["log", "C", "D"], ["alert", "E", "F"]].each do |name, used_ref, writable_ref|
    storage["targets"] << target.call(
      "local_operator_#{name}_store_bytes / clamp_min(local_operator_#{name}_store_capacity_bytes, 1)",
      "#{name} utilization", used_ref
    )
    storage["targets"] << target.call(
      "local_operator_#{name}_store_writable", "#{name} writable", writable_ref
    )
  end
  backup = clone.call(panels.find { |panel| panel["id"] == 1 })
  backup["id"] = 23
  backup["title"] = "本机备份健康与新鲜度"
  backup["description"] = "显示状态文件有效性、连续失败次数和距离最近成功备份的秒数。"
  backup["gridPos"] = { "h" => 6, "w" => 12, "x" => 12, "y" => 27 }
  backup["targets"] = [
    target.call("local_production_backup_status_file_readable", "status readable", "A"),
    target.call("local_production_backup_consecutive_failures", "consecutive failures", "B"),
    target.call("time() - local_production_backup_last_success_timestamp_seconds", "backup age seconds", "C")
  ]
  panels.concat([readiness, traffic, storage, backup])
  File.write(path, JSON.pretty_generate(value) + "\n")
' "$local_profile_bundle/grafana/dashboards/rgs-overview.json"
PROMETHEUS_RENDER_PROFILE='local-production' \
RGS_OPERATIONS_TARGET='rgs-server:8081' \
ALERTMANAGER_TARGET='alert-proxy:8443' \
ALERTMANAGER_CA_FILE='/run/secrets/alertmanager_root_ca.pem' \
ALERTMANAGER_SERVER_NAME='alert-proxy' \
  "$script_dir/verify-static-contract.sh" --rendered-static-dir "$local_profile_bundle" >/dev/null

# 正常开发环境还要直接验证本机渲染器产物；隐藏 Docker/最小 PATH 回归没有 Node 时跳过。
if command -v node >/dev/null 2>&1; then
  rendered_local_profile_bundle="$test_root/rendered-local-profile"
  node "$script_dir/../local-production/render-observability.mjs" \
    "$rendered_local_profile_bundle" >/dev/null
  PROMETHEUS_RENDER_PROFILE='local-production' \
  RGS_OPERATIONS_TARGET='rgs-server:8081' \
  ALERTMANAGER_TARGET='alert-proxy:8443' \
  ALERTMANAGER_CA_FILE='/run/secrets/alertmanager_root_ca.pem' \
  ALERTMANAGER_SERVER_NAME='alert-proxy' \
    "$script_dir/verify-static-contract.sh" \
      --rendered-static-dir "$rendered_local_profile_bundle" >/dev/null
fi

local_profile_insecure_tls_bundle="$test_root/local-profile-insecure-tls"
cp -R "$local_profile_bundle" "$local_profile_insecure_tls_bundle"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  operator = value.fetch("scrape_configs").find { |job| job["job_name"] == "local-operator" }
  operator.fetch("tls_config")["insecure_skip_verify"] = true
  File.write(path, YAML.dump(value))
' "$local_profile_insecure_tls_bundle/prometheus.yml"
if PROMETHEUS_RENDER_PROFILE='local-production' \
    RGS_OPERATIONS_TARGET='rgs-server:8081' \
    ALERTMANAGER_TARGET='alert-proxy:8443' \
    ALERTMANAGER_CA_FILE='/run/secrets/alertmanager_root_ca.pem' \
    ALERTMANAGER_SERVER_NAME='alert-proxy' \
      "$script_dir/verify-static-contract.sh" \
        --rendered-static-dir "$local_profile_insecure_tls_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: insecure local-operator TLS was accepted' >&2
  exit 1
fi

missing_local_critical_alert_bundle="$test_root/missing-local-critical-alert"
cp -R "$local_profile_bundle" "$missing_local_critical_alert_bundle"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  value.fetch("groups").each do |group|
    group.fetch("rules").reject! { |rule| rule["alert"] == "LocalOperatorAlertStoreNotWritable" }
  end
  File.write(path, YAML.dump(value))
' "$missing_local_critical_alert_bundle/rules/rgs-alerts.yml"
if PROMETHEUS_RENDER_PROFILE='local-production' \
    RGS_OPERATIONS_TARGET='rgs-server:8081' \
    ALERTMANAGER_TARGET='alert-proxy:8443' \
    ALERTMANAGER_CA_FILE='/run/secrets/alertmanager_root_ca.pem' \
    ALERTMANAGER_SERVER_NAME='alert-proxy' \
      "$script_dir/verify-static-contract.sh" \
        --rendered-static-dir "$missing_local_critical_alert_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing local-operator critical alert was accepted' >&2
  exit 1
fi

disabled_local_alert_bundle="$test_root/disabled-local-alert"
cp -R "$local_profile_bundle" "$disabled_local_alert_bundle"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  rule = value.fetch("groups").flat_map { |group| group.fetch("rules") }.find do |entry|
    entry["alert"] == "LocalOperatorAlertStoreNotWritable"
  end
  rule["expr"] = "vector(0)"
  File.write(path, YAML.dump(value))
' "$disabled_local_alert_bundle/rules/rgs-alerts.yml"
if PROMETHEUS_RENDER_PROFILE='local-production' \
    RGS_OPERATIONS_TARGET='rgs-server:8081' \
    ALERTMANAGER_TARGET='alert-proxy:8443' \
    ALERTMANAGER_CA_FILE='/run/secrets/alertmanager_root_ca.pem' \
    ALERTMANAGER_SERVER_NAME='alert-proxy' \
      "$script_dir/verify-static-contract.sh" \
        --rendered-static-dir "$disabled_local_alert_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: disabled local-operator alert expression was accepted' >&2
  exit 1
fi

missing_local_dashboard_signal_bundle="$test_root/missing-local-dashboard-signal"
cp -R "$local_profile_bundle" "$missing_local_dashboard_signal_bundle"
ruby -rjson -e '
  path = ARGV.fetch(0)
  value = JSON.parse(File.read(path))
  value.fetch("panels").each do |panel|
    Array(panel["targets"]).reject! do |target|
      target.is_a?(Hash) && target["expr"] == "local_operator_alert_store_writable"
    end
  end
  File.write(path, JSON.pretty_generate(value) + "\n")
' "$missing_local_dashboard_signal_bundle/grafana/dashboards/rgs-overview.json"
if PROMETHEUS_RENDER_PROFILE='local-production' \
    RGS_OPERATIONS_TARGET='rgs-server:8081' \
    ALERTMANAGER_TARGET='alert-proxy:8443' \
    ALERTMANAGER_CA_FILE='/run/secrets/alertmanager_root_ca.pem' \
    ALERTMANAGER_SERVER_NAME='alert-proxy' \
      "$script_dir/verify-static-contract.sh" \
        --rendered-static-dir "$missing_local_dashboard_signal_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing local-operator dashboard signal was accepted' >&2
  exit 1
fi

forced_healthy_local_dashboard_bundle="$test_root/forced-healthy-local-dashboard"
cp -R "$local_profile_bundle" "$forced_healthy_local_dashboard_bundle"
ruby -rjson -e '
  path = ARGV.fetch(0)
  value = JSON.parse(File.read(path))
  target = value.fetch("panels").flat_map { |panel| Array(panel["targets"]) }.find do |entry|
    entry.is_a?(Hash) && entry["expr"] == "local_operator_alert_store_writable"
  end
  target["expr"] = "local_operator_alert_store_writable or vector(1)"
  File.write(path, JSON.pretty_generate(value) + "\n")
' "$forced_healthy_local_dashboard_bundle/grafana/dashboards/rgs-overview.json"
if PROMETHEUS_RENDER_PROFILE='local-production' \
    RGS_OPERATIONS_TARGET='rgs-server:8081' \
    ALERTMANAGER_TARGET='alert-proxy:8443' \
    ALERTMANAGER_CA_FILE='/run/secrets/alertmanager_root_ca.pem' \
    ALERTMANAGER_SERVER_NAME='alert-proxy' \
      "$script_dir/verify-static-contract.sh" \
        --rendered-static-dir "$forced_healthy_local_dashboard_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: forced-healthy local dashboard query was accepted' >&2
  exit 1
fi

disabled_central_alert_bundle="$test_root/disabled-central-alert"
cp -R "$good_bundle" "$disabled_central_alert_bundle"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  rule = value.fetch("groups").flat_map { |group| group.fetch("rules") }.find do |entry|
    entry["alert"] == "RGSInstanceDown"
  end
  rule["expr"] = "vector(0)"
  File.write(path, YAML.dump(value))
' "$disabled_central_alert_bundle/rules/rgs-alerts.yml"
if "$script_dir/verify-static-contract.sh" --rendered-static-dir "$disabled_central_alert_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: disabled central alert expression was accepted' >&2
  exit 1
fi

remote_write_bundle="$test_root/remote-write"
cp -R "$good_bundle" "$remote_write_bundle"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  value["remote_write"] = [{ "url" => "https://metrics.attacker.invalid/write" }]
  File.write(path, YAML.dump(value))
' "$remote_write_bundle/prometheus.yml"
if "$script_dir/verify-static-contract.sh" --rendered-static-dir "$remote_write_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: remote_write egress was accepted' >&2
  exit 1
fi

remote_read_bundle="$test_root/remote-read"
cp -R "$good_bundle" "$remote_read_bundle"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  value["remote_read"] = [{ "url" => "https://metrics.attacker.invalid/read" }]
  File.write(path, YAML.dump(value))
' "$remote_read_bundle/prometheus.yml"
if "$script_dir/verify-static-contract.sh" --rendered-static-dir "$remote_read_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: remote_read ingress was accepted' >&2
  exit 1
fi

extra_scrape_job_bundle="$test_root/extra-scrape-job"
cp -R "$good_bundle" "$extra_scrape_job_bundle"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  value.fetch("scrape_configs") << {
    "job_name" => "attacker",
    "scheme" => "https",
    "metrics_path" => "/metrics",
    "static_configs" => [{ "targets" => ["metrics.attacker.invalid:443"] }]
  }
  File.write(path, YAML.dump(value))
' "$extra_scrape_job_bundle/prometheus.yml"
if "$script_dir/verify-static-contract.sh" --rendered-static-dir "$extra_scrape_job_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: extra scrape job was accepted' >&2
  exit 1
fi

rgs_second_target_bundle="$test_root/rgs-second-target"
cp -R "$good_bundle" "$rgs_second_target_bundle"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  rgs = value.fetch("scrape_configs").find { |job| job["job_name"] == "rgs" }
  rgs.fetch("static_configs").fetch(0).fetch("targets") << "metrics.attacker.invalid:443"
  File.write(path, YAML.dump(value))
' "$rgs_second_target_bundle/prometheus.yml"
if "$script_dir/verify-static-contract.sh" --rendered-static-dir "$rgs_second_target_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: second RGS scrape target was accepted' >&2
  exit 1
fi

rgs_relabel_bundle="$test_root/rgs-relabel"
cp -R "$good_bundle" "$rgs_relabel_bundle"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  rgs = value.fetch("scrape_configs").find { |job| job["job_name"] == "rgs" }
  rgs["relabel_configs"] = [{
    "target_label" => "__address__",
    "replacement" => "metrics.attacker.invalid:443"
  }]
  File.write(path, YAML.dump(value))
' "$rgs_relabel_bundle/prometheus.yml"
if "$script_dir/verify-static-contract.sh" --rendered-static-dir "$rgs_relabel_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: RGS address relabel egress was accepted' >&2
  exit 1
fi

rgs_proxy_bundle="$test_root/rgs-proxy"
cp -R "$good_bundle" "$rgs_proxy_bundle"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  rgs = value.fetch("scrape_configs").find { |job| job["job_name"] == "rgs" }
  rgs["proxy_url"] = "http://proxy.attacker.invalid:8080"
  File.write(path, YAML.dump(value))
' "$rgs_proxy_bundle/prometheus.yml"
if "$script_dir/verify-static-contract.sh" --rendered-static-dir "$rgs_proxy_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: RGS scrape proxy egress was accepted' >&2
  exit 1
fi

alertmanager_second_target_bundle="$test_root/alertmanager-second-target"
cp -R "$good_bundle" "$alertmanager_second_target_bundle"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  manager = value.fetch("alerting").fetch("alertmanagers").fetch(0)
  manager.fetch("static_configs").fetch(0).fetch("targets") << "alerts.attacker.invalid:443"
  File.write(path, YAML.dump(value))
' "$alertmanager_second_target_bundle/prometheus.yml"
if "$script_dir/verify-static-contract.sh" --rendered-static-dir "$alertmanager_second_target_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: second Alertmanager target was accepted' >&2
  exit 1
fi

alertmanager_insecure_tls_bundle="$test_root/alertmanager-insecure-tls"
cp -R "$good_bundle" "$alertmanager_insecure_tls_bundle"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  manager = value.fetch("alerting").fetch("alertmanagers").fetch(0)
  manager.fetch("tls_config")["insecure_skip_verify"] = true
  File.write(path, YAML.dump(value))
' "$alertmanager_insecure_tls_bundle/prometheus.yml"
if "$script_dir/verify-static-contract.sh" --rendered-static-dir "$alertmanager_insecure_tls_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: disabled Alertmanager TLS verification was accepted' >&2
  exit 1
fi

alertmanager_ca_drift_bundle="$test_root/alertmanager-ca-drift"
cp -R "$good_bundle" "$alertmanager_ca_drift_bundle"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  manager = value.fetch("alerting").fetch("alertmanagers").fetch(0)
  manager.fetch("tls_config")["ca_file"] = "/run/secrets/attacker-ca.pem"
  File.write(path, YAML.dump(value))
' "$alertmanager_ca_drift_bundle/prometheus.yml"
if "$script_dir/verify-static-contract.sh" --rendered-static-dir "$alertmanager_ca_drift_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: Alertmanager CA secret path drift was accepted' >&2
  exit 1
fi

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

missing_required_alert_bundle="$test_root/missing-required-alert"
cp -R "$good_bundle" "$missing_required_alert_bundle"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  value.fetch("groups").each do |group|
    group.fetch("rules").reject! { |rule| rule["alert"] == "RGSAuthenticationReplayDetected" }
  end
  File.write(path, YAML.dump(value))
' "$missing_required_alert_bundle/rules/rgs-alerts.yml"
if "$script_dir/verify-static-contract.sh" --rendered-static-dir "$missing_required_alert_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing required authentication replay alert was accepted' >&2
  exit 1
fi

missing_dashboard_signal_bundle="$test_root/missing-dashboard-signal"
cp -R "$good_bundle" "$missing_dashboard_signal_bundle"
ruby -rjson -e '
  path = ARGV.fetch(0)
  value = JSON.parse(File.read(path))
  value.fetch("panels").each do |panel|
    Array(panel["targets"]).reject! do |target|
      target.is_a?(Hash) && target["expr"].to_s.include?("rgs_auth_replays_total")
    end
  end
  File.write(path, JSON.pretty_generate(value) + "\n")
' "$missing_dashboard_signal_bundle/grafana/dashboards/rgs-overview.json"
if "$script_dir/verify-static-contract.sh" --rendered-static-dir "$missing_dashboard_signal_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing required authentication replay dashboard signal was accepted' >&2
  exit 1
fi

stale_economic_age_alert_bundle="$test_root/stale-economic-age-alert"
cp -R "$good_bundle" "$stale_economic_age_alert_bundle"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  rule = value.fetch("groups").flat_map { |group| group.fetch("rules") }.find do |entry|
    entry["alert"] == "RGSEconomicAdmissionObservationStale"
  end
  abort "economic admission stale alert missing" unless rule
  rule["expr"] = rule.fetch("expr").sub("> 900", "> 3600")
  File.write(path, YAML.dump(value))
' "$stale_economic_age_alert_bundle/rules/rgs-alerts.yml"
if "$script_dir/verify-static-contract.sh" --rendered-static-dir "$stale_economic_age_alert_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: weakened economic admission stale-age alert was accepted' >&2
  exit 1
fi

missing_economic_health_dashboard_bundle="$test_root/missing-economic-health-dashboard"
cp -R "$good_bundle" "$missing_economic_health_dashboard_bundle"
ruby -rjson -e '
  path = ARGV.fetch(0)
  value = JSON.parse(File.read(path))
  value.fetch("panels").each do |panel|
    Array(panel["targets"]).reject! do |target|
      target.is_a?(Hash) && target["expr"].to_s.include?("rgs_economic_admission_last_success_age_seconds")
    end
  end
  File.write(path, JSON.pretty_generate(value) + "\n")
' "$missing_economic_health_dashboard_bundle/grafana/dashboards/rgs-overview.json"
if "$script_dir/verify-static-contract.sh" --rendered-static-dir "$missing_economic_health_dashboard_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing economic admission health dashboard signal was accepted' >&2
  exit 1
fi

# synthetic digest 绝不应被预载；production 模式必须因缺固定来源 promtool 而拒绝，且不能联网拉取。
# 这里显式给出安全专用 glob，避免由新增 glob 门禁提前失败而导致假绿。
if RGS_CONTAINER_LOG_GLOB='/var/log/containers/rgs-server-*.log' \
    "$script_dir/verify-static-contract.sh" --rendered-dir "$good_bundle" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: release gate accepted an untrusted promtool source' >&2
  exit 1
fi

broad_release_glob_log="$test_root/broad-release-glob.log"
if RGS_CONTAINER_LOG_GLOB='/var/log/containers/*.log' \
    "$script_dir/verify-static-contract.sh" --rendered-dir "$good_bundle" \
      >"$broad_release_glob_log" 2>&1; then
  printf '%s\n' 'rendered contract test: broad release container log glob was accepted' >&2
  exit 1
fi
if ! grep -F 'release RGS container log glob contract failed' "$broad_release_glob_log" >/dev/null; then
  printf '%s\n' 'rendered contract test: broad release glob did not reach the dedicated fail-closed policy' >&2
  exit 1
fi

source_contract="$test_root/source-contract"
copy_contract_repository "$source_contract"
"$source_contract/deploy/observability/verify-static-contract.sh" >/dev/null || {
  printf '%s\n' 'rendered contract test: complete source-control fixture was rejected before mutation' >&2
  exit 1
}

weakened_source_rule_contract="$test_root/weakened-source-rule-contract"
cp -R "$source_contract" "$weakened_source_rule_contract"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  rule = value.fetch("groups").flat_map { |group| group.fetch("rules") }.find do |entry|
    entry["alert"] == "RGSHTTPFailureRatioHigh"
  end
  rule["expr"] = "vector(0)"
  File.write(path, YAML.dump(value))
' "$weakened_source_rule_contract/deploy/observability/rules/rgs-alerts.yml"
if "$weakened_source_rule_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: weakened reviewed source alert expression was accepted' >&2
  exit 1
fi

vector_start_position_contract="$test_root/vector-start-position-contract"
cp -R "$source_contract" "$vector_start_position_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub("    read_from: beginning\n", "    read_from: end\n")
  abort "Vector read position mutation did not apply" if changed == value
  File.write(path, changed)
' "$vector_start_position_contract/deploy/observability/vector.yaml"
if "$vector_start_position_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: Vector startup log position drift was accepted' >&2
  exit 1
fi

alertmanager_compose_ca_contract="$test_root/alertmanager-compose-ca-contract"
cp -R "$source_contract" "$alertmanager_compose_ca_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub("target: alertmanager_root_ca.pem", "target: attacker-root-ca.pem")
  abort "Alertmanager Compose CA mutation did not apply" if changed == value
  File.write(path, changed)
' "$alertmanager_compose_ca_contract/deploy/observability/compose.yml"
if "$alertmanager_compose_ca_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: Alertmanager root CA Compose mount drift was accepted' >&2
  exit 1
fi

alertmanager_compose_ca_source_contract="$test_root/alertmanager-compose-ca-source-contract"
cp -R "$source_contract" "$alertmanager_compose_ca_source_contract"
# 变异必须匹配 Compose 中按字面量保存的插值表达式。
# shellcheck disable=SC2016
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub(
    "${ALERTMANAGER_ROOT_CA_FILE:?set the approved Alertmanager root CA file}",
    "${ATTACKER_ROOT_CA_FILE:?set an unapproved root CA file}"
  )
  abort "Alertmanager Compose CA source mutation did not apply" if changed == value
  File.write(path, changed)
' "$alertmanager_compose_ca_source_contract/deploy/observability/compose.yml"
if "$alertmanager_compose_ca_source_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: Alertmanager root CA host source drift was accepted' >&2
  exit 1
fi

missing_local_operator_promtool_mount_contract="$test_root/missing-local-operator-promtool-mount-contract"
cp -R "$source_contract" "$missing_local_operator_promtool_mount_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub(
    "        --mount type=bind,src=/dev/null,dst=/run/secrets/local_operator_metrics_bearer_token,readonly \\\n",
    ""
  )
  abort "local-operator promtool mount mutation did not apply" if changed == value
  File.write(path, changed)
' "$missing_local_operator_promtool_mount_contract/deploy/observability/verify-static-contract.sh"
if "$missing_local_operator_promtool_mount_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing local-operator promtool credential mount was accepted' >&2
  exit 1
fi

missing_release_alertmanager_ca_mount_contract="$test_root/missing-release-alertmanager-ca-mount-contract"
cp -R "$source_contract" "$missing_release_alertmanager_ca_mount_contract"
# Ruby 必须匹配校验器中按字面量保存的 shell 变量引用。
# shellcheck disable=SC2016
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub(
    "        --mount \"type=bind,src=$alertmanager_root_ca_source,dst=/run/secrets/alertmanager_root_ca.pem,readonly\" \\\n",
    ""
  )
  abort "release Alertmanager CA mount mutation did not apply" if changed == value
  File.write(path, changed)
' "$missing_release_alertmanager_ca_mount_contract/deploy/observability/verify-static-contract.sh"
if "$missing_release_alertmanager_ca_mount_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing release Alertmanager CA promtool mount was accepted' >&2
  exit 1
fi

conditional_vector_leak_contract="$test_root/conditional-vector-leak-contract"
cp -R "$source_contract" "$conditional_vector_leak_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  marker = "          if is_string(sanitized.error_class) { .error_class = sanitized.error_class }\n"
  injected = marker + "          if message == \"rgs server stopped\" && is_string(event.wallet_response) { .wallet_response = event.wallet_response }\n"
  changed = value.sub(marker, injected)
  abort "conditional Vector leak mutation did not apply" if changed == value
  File.write(path, changed)
' "$conditional_vector_leak_contract/deploy/observability/vector.yaml"
if "$conditional_vector_leak_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: conditional Vector field leak was accepted' >&2
  exit 1
fi

public_runtime_umask_contract="$test_root/public-runtime-umask-contract"
cp -R "$source_contract" "$public_runtime_umask_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub("umask 077\n", "umask 022\n")
  abort "development runtime umask mutation did not apply" if changed == value
  File.write(path, changed)
' "$public_runtime_umask_contract/deploy/observability/ci-runtime-smoke.sh"
if "$public_runtime_umask_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: development runtime smoke without private umask was accepted' >&2
  exit 1
fi

incompatible_tls_contract="$test_root/incompatible-tls-contract"
cp -R "$source_contract" "$incompatible_tls_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub("rsa:3072", "ed25519")
  abort "TLS algorithm mutation did not apply" if changed == value
  File.write(path, changed)
' "$incompatible_tls_contract/deploy/observability/ci-runtime-production-smoke.sh"
if "$incompatible_tls_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: incompatible PostgreSQL TLS algorithm was accepted' >&2
  exit 1
fi

evicting_valkey_contract="$test_root/evicting-valkey-contract"
cp -R "$source_contract" "$evicting_valkey_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub("maxmemory-policy noeviction", "maxmemory-policy volatile-lru")
  abort "Valkey eviction mutation did not apply" if changed == value
  File.write(path, changed)
' "$evicting_valkey_contract/deploy/observability/ci-runtime-production-smoke.sh"
if "$evicting_valkey_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: evicting Valkey runtime smoke was accepted' >&2
  exit 1
fi

missing_valkey_lua_command_contract="$test_root/missing-valkey-lua-command-contract"
cp -R "$source_contract" "$missing_valkey_lua_command_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub("local first_ttl = redis.call", "local first_ttl = tonumber")
  abort "Valkey Lua command mutation did not apply" if changed == value
  File.write(path, changed)
' "$missing_valkey_lua_command_contract/deploy/observability/ci-runtime-production-smoke.sh"
if "$missing_valkey_lua_command_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: incomplete Valkey Lua command probe was accepted' >&2
  exit 1
fi

false_valkey_lua_result_contract="$test_root/false-valkey-lua-result-contract"
cp -R "$source_contract" "$false_valkey_lua_result_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub(%q{"sharedAdmissionTLSACLAndLua": True}, %q{"sharedAdmissionTLSACLAndLua": False})
  abort "Valkey Lua result mutation did not apply" if changed == value
  File.write(path, changed)
' "$false_valkey_lua_result_contract/deploy/observability/ci-runtime-production-smoke.sh"
if "$false_valkey_lua_result_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: false Valkey Lua artifact result was accepted' >&2
  exit 1
fi

stale_valkey_lua_digest_contract="$test_root/stale-valkey-lua-digest-contract"
cp -R "$source_contract" "$stale_valkey_lua_digest_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub("ff334ac492bc06b8421d59494098b485d59dd00d", "0000000000000000000000000000000000000000")
  abort "Valkey Lua digest mutation did not apply" if changed == value
  File.write(path, changed)
' "$stale_valkey_lua_digest_contract/deploy/observability/ci-runtime-production-smoke.sh"
if "$stale_valkey_lua_digest_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: stale Valkey Lua digest was accepted' >&2
  exit 1
fi

missing_safe_startup_gate_contract="$test_root/missing-safe-startup-gate-contract"
cp -R "$source_contract" "$missing_safe_startup_gate_contract"
# Ruby 必须匹配 smoke 中按字面量保存的 shell 变量引用。
# shellcheck disable=SC2016
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub(
    %q{verify_safe_startup_failure "$missing_token_log" '\''missing-operations-token'\''},
    "true # safe startup envelope gate removed"
  )
  abort "safe startup gate mutation did not apply" if changed == value
  File.write(path, changed)
' "$missing_safe_startup_gate_contract/deploy/observability/ci-runtime-production-smoke.sh"
if "$missing_safe_startup_gate_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing safe startup failure gate was accepted' >&2
  exit 1
fi

permissive_safe_startup_envelope_contract="$test_root/permissive-safe-startup-envelope-contract"
cp -R "$source_contract" "$permissive_safe_startup_envelope_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub(
    %q{allowed_keys = {"time", "level", "msg", "error_class"}},
    %q{allowed_keys = {"time", "level", "msg", "error_class", "error"}}
  )
  abort "safe startup allowlist mutation did not apply" if changed == value
  File.write(path, changed)
' "$permissive_safe_startup_envelope_contract/deploy/observability/ci-runtime-production-smoke.sh"
if "$permissive_safe_startup_envelope_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: permissive safe startup log envelope was accepted' >&2
  exit 1
fi

missing_central_allowlist_contract="$test_root/missing-central-allowlist-contract"
cp -R "$source_contract" "$missing_central_allowlist_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub("      . = { \"service\": \"rgs-server\" }\n", "")
  abort "central strict allowlist mutation did not apply" if changed == value
  File.write(path, changed)
' "$missing_central_allowlist_contract/deploy/observability/vector.yaml"
if "$missing_central_allowlist_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing central strict log allowlist was accepted' >&2
  exit 1
fi

missing_local_allowlist_contract="$test_root/missing-local-allowlist-contract"
cp -R "$source_contract" "$missing_local_allowlist_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub("      . = { \"service\": \"rgs-server\" }\n", "")
  abort "local strict allowlist mutation did not apply" if changed == value
  File.write(path, changed)
' "$missing_local_allowlist_contract/deploy/local-production/vector.yaml"
if "$missing_local_allowlist_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing local strict log allowlist was accepted' >&2
  exit 1
fi

missing_nested_vector_fixture_contract="$test_root/missing-nested-vector-fixture-contract"
cp -R "$source_contract" "$missing_nested_vector_fixture_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub("nested-wallet-secret", "flat-fixture-only")
  abort "nested-secret Vector fixture mutation did not apply" if changed == value
  File.write(path, changed)
' "$missing_nested_vector_fixture_contract/deploy/observability/vector.yaml"
if "$missing_nested_vector_fixture_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing nested-secret Vector fixture was accepted' >&2
  exit 1
fi

route_enum_drift_contract="$test_root/route-enum-drift-contract"
cp -R "$source_contract" "$route_enum_drift_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub(%Q{        "client.spin",\n}, %Q{        "client.spin.drift",\n})
  abort "RGS route enum mutation did not apply" if changed == value
  File.write(path, changed)
' "$route_enum_drift_contract/deploy/observability/vector.yaml"
if "$route_enum_drift_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: RGS route enum drift was accepted' >&2
  exit 1
fi

message_mapping_drift_contract="$test_root/message-mapping-drift-contract"
cp -R "$source_contract" "$message_mapping_drift_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub(
    "if is_string(sanitized.security_event) { .security_event = sanitized.security_event }",
    "if is_string(sanitized.request_id) { .request_id = sanitized.request_id }"
  )
  abort "RGS per-message mapping mutation did not apply" if changed == value
  File.write(path, changed)
' "$message_mapping_drift_contract/deploy/observability/vector.yaml"
if "$message_mapping_drift_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: RGS per-message field mapping drift was accepted' >&2
  exit 1
fi

startup_fixture_drift_contract="$test_root/startup-fixture-drift-contract"
cp -R "$source_contract" "$startup_fixture_drift_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub(
    "approved RGS startup identity fields remain observable",
    "unapproved RGS startup fixture drift"
  )
  abort "RGS startup Vector fixture mutation did not apply" if changed == value
  File.write(path, changed)
' "$startup_fixture_drift_contract/deploy/observability/vector.yaml"
if "$startup_fixture_drift_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: RGS startup Vector fixture drift was accepted' >&2
  exit 1
fi

request_digest_drift_contract="$test_root/request-digest-drift-contract"
cp -R "$source_contract" "$request_digest_drift_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub(
    "^sha256:[0-9a-f]{64}$",
    "^[A-Za-z0-9._:-]+$"
  )
  abort "request-id digest contract mutation did not apply" if changed == value
  File.write(path, changed)
' "$request_digest_drift_contract/deploy/observability/vector.yaml"
if "$request_digest_drift_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: raw request-id allowlist drift was accepted' >&2
  exit 1
fi

local_tls_verification_drift_contract="$test_root/local-tls-verification-drift-contract"
cp -R "$source_contract" "$local_tls_verification_drift_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub("      verify_hostname: true\n", "      verify_hostname: false\n")
  abort "local Vector TLS verification mutation did not apply" if changed == value
  File.write(path, changed)
' "$local_tls_verification_drift_contract/deploy/local-production/vector.yaml"
if "$local_tls_verification_drift_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: local Vector TLS verification drift was accepted' >&2
  exit 1
fi

local_ca_path_drift_contract="$test_root/local-ca-path-drift-contract"
cp -R "$source_contract" "$local_ca_path_drift_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub(
    "/run/vector-secrets/local-production-root-ca.pem",
    "/run/vector-secrets/missing-root-ca.pem"
  )
  abort "local Vector CA path mutation did not apply" if changed == value
  File.write(path, changed)
' "$local_ca_path_drift_contract/deploy/local-production/vector.yaml"
if "$local_ca_path_drift_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: local Vector CA path drift was accepted' >&2
  exit 1
fi

local_archive_uri_drift_contract="$test_root/local-archive-uri-drift-contract"
cp -R "$source_contract" "$local_archive_uri_drift_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub("uri: https://wallet:8443/logs", "uri: http://wallet:8080/logs")
  abort "local Vector archive URI mutation did not apply" if changed == value
  File.write(path, changed)
' "$local_archive_uri_drift_contract/deploy/local-production/vector.yaml"
if "$local_archive_uri_drift_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: local Vector archive URI drift was accepted' >&2
  exit 1
fi

local_archive_input_drift_contract="$test_root/local-archive-input-drift-contract"
cp -R "$source_contract" "$local_archive_input_drift_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub(
    "inputs: [strict_rgs_allowlist, safe_archive_flush_heartbeat]",
    "inputs: [normalize_rgs_json, safe_archive_flush_heartbeat]"
  )
  abort "local Vector archive input mutation did not apply" if changed == value
  File.write(path, changed)
' "$local_archive_input_drift_contract/deploy/local-production/vector.yaml"
if "$local_archive_input_drift_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: local Vector archive input drift was accepted' >&2
  exit 1
fi

missing_central_heartbeat_contract="$test_root/missing-central-heartbeat-contract"
cp -R "$source_contract" "$missing_central_heartbeat_contract"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  removed = value.fetch("sources").delete("archive_flush_heartbeat_metric")
  abort "central archive heartbeat mutation did not apply" unless removed
  File.write(path, YAML.dump(value))
' "$missing_central_heartbeat_contract/deploy/observability/vector.yaml"
refresh_reviewed_vector_digest "$missing_central_heartbeat_contract" \
  'deploy/observability/vector.yaml' "$script_dir/vector.yaml"
if "$missing_central_heartbeat_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing central archive heartbeat was accepted' >&2
  exit 1
fi

unsafe_central_heartbeat_contract="$test_root/unsafe-central-heartbeat-contract"
cp -R "$source_contract" "$unsafe_central_heartbeat_contract"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  transform = value.fetch("transforms").fetch("safe_archive_flush_heartbeat")
  transform["source"] = ". = {\"service\": \"vector\", \"time\": now(), \"level\": \"INFO\", \"msg\": \"archive flush heartbeat\", \"tags\": .tags}\n"
  File.write(path, YAML.dump(value))
' "$unsafe_central_heartbeat_contract/deploy/observability/vector.yaml"
refresh_reviewed_vector_digest "$unsafe_central_heartbeat_contract" \
  'deploy/observability/vector.yaml' "$script_dir/vector.yaml"
if "$unsafe_central_heartbeat_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: unsafe central archive heartbeat projection was accepted' >&2
  exit 1
fi

missing_local_heartbeat_input_contract="$test_root/missing-local-heartbeat-input-contract"
cp -R "$source_contract" "$missing_local_heartbeat_input_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub(
    "inputs: [strict_rgs_allowlist, safe_archive_flush_heartbeat]",
    "inputs: [strict_rgs_allowlist]"
  )
  abort "local archive heartbeat input mutation did not apply" if changed == value
  File.write(path, changed)
' "$missing_local_heartbeat_input_contract/deploy/local-production/vector.yaml"
refresh_reviewed_vector_digest "$missing_local_heartbeat_input_contract" \
  'deploy/local-production/vector.yaml' "$script_dir/../local-production/vector.yaml"
if "$missing_local_heartbeat_input_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing local archive heartbeat input was accepted' >&2
  exit 1
fi

central_bypass_sink_contract="$test_root/central-bypass-sink-contract"
cp -R "$source_contract" "$central_bypass_sink_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  marker = "  vector_internal_prometheus:\n"
  bypass = <<~YAML
    unapproved_normalized_console:
      type: console
      inputs: [normalize_rgs_json]
      encoding:
        codec: json

  YAML
  indented_bypass = bypass.lines.map { |line| line.strip.empty? ? "\n" : "  #{line}" }.join
  changed = value.sub(marker, indented_bypass + marker)
  abort "central Vector bypass sink mutation did not apply" if changed == value
  File.write(path, changed)
' "$central_bypass_sink_contract/deploy/observability/vector.yaml"
if "$central_bypass_sink_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: central Vector bypass sink was accepted' >&2
  exit 1
fi

local_bypass_sink_contract="$test_root/local-bypass-sink-contract"
cp -R "$source_contract" "$local_bypass_sink_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  marker = "  vector_internal_prometheus:\n"
  bypass = <<~YAML
    unapproved_normalized_console:
      type: console
      inputs: [normalize_rgs_json]
      encoding:
        codec: json

  YAML
  indented_bypass = bypass.lines.map { |line| line.strip.empty? ? "\n" : "  #{line}" }.join
  changed = value.sub(marker, indented_bypass + marker)
  abort "local Vector bypass sink mutation did not apply" if changed == value
  File.write(path, changed)
' "$local_bypass_sink_contract/deploy/local-production/vector.yaml"
if "$local_bypass_sink_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: local Vector bypass sink was accepted' >&2
  exit 1
fi

central_tls_verification_drift_contract="$test_root/central-tls-verification-drift-contract"
cp -R "$source_contract" "$central_tls_verification_drift_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub("      verify_certificate: true\n", "      verify_certificate: false\n")
  abort "central Vector TLS verification mutation did not apply" if changed == value
  File.write(path, changed)
' "$central_tls_verification_drift_contract/deploy/observability/vector.yaml"
if "$central_tls_verification_drift_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: central Vector TLS verification drift was accepted' >&2
  exit 1
fi

central_archive_uri_drift_contract="$test_root/central-archive-uri-drift-contract"
cp -R "$source_contract" "$central_archive_uri_drift_contract"
# shellcheck disable=SC2016
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub(%q{uri: "${RGS_LOG_SINK_URI}"}, "uri: http://logs.attacker.invalid/ingest")
  abort "central Vector archive URI mutation did not apply" if changed == value
  File.write(path, changed)
' "$central_archive_uri_drift_contract/deploy/observability/vector.yaml"
if "$central_archive_uri_drift_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: central Vector archive URI drift was accepted' >&2
  exit 1
fi

local_fluent_source_drift_contract="$test_root/local-fluent-source-drift-contract"
cp -R "$source_contract" "$local_fluent_source_drift_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub("address: 0.0.0.0:24224", "address: 127.0.0.1:24224")
  abort "local Fluent source mutation did not apply" if changed == value
  File.write(path, changed)
' "$local_fluent_source_drift_contract/deploy/local-production/vector.yaml"
if "$local_fluent_source_drift_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: local Fluent source drift was accepted' >&2
  exit 1
fi

local_fluent_payload_drift_contract="$test_root/local-fluent-payload-drift-contract"
cp -R "$source_contract" "$local_fluent_payload_drift_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub(
    %q{raw = string(.log) ?? string(.message) ?? ""},
    %q{raw = string(.message) ?? ""}
  )
  abort "local Fluent payload mutation did not apply" if changed == value
  File.write(path, changed)
' "$local_fluent_payload_drift_contract/deploy/local-production/vector.yaml"
if "$local_fluent_payload_drift_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: local Fluent payload branch drift was accepted' >&2
  exit 1
fi

missing_fluent_shape_test_contract="$test_root/missing-fluent-shape-test-contract"
cp -R "$source_contract" "$missing_fluent_shape_test_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  changed = value.sub(
    "Docker Fluent log shape preserves approved RGS request semantics only",
    "removed Docker Fluent shape fixture"
  )
  abort "Docker Fluent shape test mutation did not apply" if changed == value
  File.write(path, changed)
' "$missing_fluent_shape_test_contract/deploy/local-production/vector.yaml"
if "$missing_fluent_shape_test_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing Docker Fluent shape test was accepted' >&2
  exit 1
fi

central_exclude_all_contract="$test_root/central-exclude-all-contract"
cp -R "$source_contract" "$central_exclude_all_contract"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  source = value.fetch("sources").fetch("rgs_container_stdout")
  source["exclude"] = source.fetch("include").dup
  File.write(path, YAML.dump(value))
' "$central_exclude_all_contract/deploy/observability/vector.yaml"
if "$central_exclude_all_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: central Vector exclude-all source was accepted' >&2
  exit 1
fi

local_drop_newest_contract="$test_root/local-drop-newest-contract"
cp -R "$source_contract" "$local_drop_newest_contract"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  value.fetch("sinks").fetch("local_https_archive").fetch("buffer")["when_full"] = "drop_newest"
  File.write(path, YAML.dump(value))
' "$local_drop_newest_contract/deploy/local-production/vector.yaml"
if "$local_drop_newest_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: local Vector drop-newest buffer was accepted' >&2
  exit 1
fi

central_text_encoding_contract="$test_root/central-text-encoding-contract"
cp -R "$source_contract" "$central_text_encoding_contract"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  value.fetch("sinks").fetch("approved_https_archive").fetch("encoding")["codec"] = "text"
  File.write(path, YAML.dump(value))
' "$central_text_encoding_contract/deploy/observability/vector.yaml"
if "$central_text_encoding_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: central Vector non-JSON encoding was accepted' >&2
  exit 1
fi

local_metrics_host_tag_contract="$test_root/local-metrics-host-tag-contract"
cp -R "$source_contract" "$local_metrics_host_tag_contract"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  value = YAML.safe_load(File.read(path), aliases: false)
  value.fetch("sources").fetch("vector_internal_metrics").fetch("tags")["host_key"] = "host"
  File.write(path, YAML.dump(value))
' "$local_metrics_host_tag_contract/deploy/local-production/vector.yaml"
if "$local_metrics_host_tag_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: local Vector internal-metrics host tag was accepted' >&2
  exit 1
fi

missing_central_release_vector_test_contract="$test_root/missing-central-release-vector-test-contract"
cp -R "$source_contract" "$missing_central_release_vector_test_contract"
# Ruby 变异目标是发布脚本内的字面量 $vector_image，不读取当前 shell 环境。
# shellcheck disable=SC2016
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  marker = "\"$vector_image\" test --dangerously-allow-env-var-interpolation"
  offset = value.rindex(marker)
  abort "central release Vector test mutation did not apply" unless offset
  value[offset, marker.length] = "\"$vector_image\" validate --dangerously-allow-env-var-interpolation"
  File.write(path, value)
' "$missing_central_release_vector_test_contract/deploy/observability/verify-static-contract.sh"
if "$missing_central_release_vector_test_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing central release Vector test was accepted' >&2
  exit 1
fi

missing_local_release_vector_test_contract="$test_root/missing-local-release-vector-test-contract"
cp -R "$source_contract" "$missing_local_release_vector_test_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  marker = "exec /usr/bin/vector test /etc/vector/vector.yaml"
  offset = value.rindex(marker)
  abort "local release Vector test mutation did not apply" unless offset
  value[offset, marker.length] = "exec /usr/bin/vector validate /etc/vector/vector.yaml"
  File.write(path, value)
' "$missing_local_release_vector_test_contract/deploy/observability/verify-static-contract.sh"
if "$missing_local_release_vector_test_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing local release Vector test was accepted' >&2
  exit 1
fi

missing_local_release_vector_validation_contract="$test_root/missing-local-release-vector-validation-contract"
cp -R "$source_contract" "$missing_local_release_vector_validation_contract"
ruby -e '
  path = ARGV.fetch(0)
  value = File.read(path)
  marker = "exec /usr/bin/vector validate --no-environment /etc/vector/vector.yaml"
  offset = value.rindex(marker)
  abort "local release Vector validation mutation did not apply" unless offset
  value[offset, marker.length] = "exec /usr/bin/vector graph /etc/vector/vector.yaml"
  File.write(path, value)
' "$missing_local_release_vector_validation_contract/deploy/observability/verify-static-contract.sh"
if "$missing_local_release_vector_validation_contract/deploy/observability/verify-static-contract.sh" >/dev/null 2>&1; then
  printf '%s\n' 'rendered contract test: missing local release Vector validation was accepted' >&2
  exit 1
fi

printf '%s\n' \
  'observability rendered bundle regression: central/local profiles accepted; unsafe or missing archive heartbeat, Prometheus remote read/write, extra/relabel/proxy targets, insecure Alertmanager/local-operator, missing local critical alert/dashboard signal, missing RGS/Vector, required alert/dashboard/strict nested-log allowlists and release Vector validation/tests, invalid rules, untrusted promtool, incompatible PostgreSQL/Vector TLS, evicting Valkey, incomplete Lua probe, stale Lua digest, false Lua result, route/message/fixture and request-digest drift rejected'
