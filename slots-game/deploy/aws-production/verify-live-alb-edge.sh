#!/bin/sh
# 发布后只读回查实际 ALB、WAF、target health 与前端 SG；不创建或修改 AWS 资源。
# English: Read-only review of actual ALB, WAF, target health, and front-end SG after release; no AWS resources
# are created or modified.
set -eu

delivery_json=${1:-}
application_namespace=${2:-}
kubectl_binary=${KUBECTL_BIN:-kubectl}
aws_binary=${AWS_BIN:-aws}

fail() {
  printf '%s\n' "AWS ALB 发布后门禁: $*" >&2
  exit 1
}

test -f "$delivery_json" || fail '缺少 Terraform delivery JSON'
case "$application_namespace" in
  ''|*[!a-z0-9-]*|-*|*-) fail '应用 namespace 不合法' ;;
esac
for command in ruby "$kubectl_binary" "$aws_binary"; do
  command -v "$command" >/dev/null 2>&1 || fail "缺少命令 $command"
done
release_name=$(ruby -rjson -e '
  value = JSON.parse(File.binread(ARGV.fetch(0))).fetch("helm_release_name")
  abort "Helm release 名不合法" unless value.match?(/\A[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?\z/)
  STDOUT.write(value)
' "$delivery_json") || fail 'Terraform delivery 的 Helm release 名不合法'
rgs_selector="app.kubernetes.io/component=rgs,app.kubernetes.io/instance=$release_name"

if test "${SLOTS_ALB_LIVE_ONCE:-0}" != 1; then
  maximum_attempts=${ALB_LIVE_MAX_ATTEMPTS:-30}
  retry_interval_seconds=${ALB_LIVE_RETRY_INTERVAL_SECONDS:-10}
  case "$maximum_attempts:$retry_interval_seconds" in
    *[!0-9:]*|0:*|*:0) fail 'ALB live retry 参数必须是正整数' ;;
  esac
  attempt=1
  while test "$attempt" -le "$maximum_attempts"; do
    if SLOTS_ALB_LIVE_ONCE=1 "$0" "$delivery_json" "$application_namespace"; then
      exit 0
    fi
    if test "$attempt" -lt "$maximum_attempts"; then
      sleep "$retry_interval_seconds"
    fi
    attempt=$((attempt + 1))
  done
  fail "ALB/WAF/target-health 在 ${maximum_attempts} 次有界重试后仍未收敛"
fi

temporary_parent=${TMPDIR:-/tmp}
temporary_root=$(mktemp -d "${temporary_parent%/}/slots-live-alb.XXXXXX")
cleanup() {
  case "$temporary_root" in
    "${temporary_parent%/}"/slots-live-alb.*) rm -rf -- "$temporary_root" ;;
    *) fail "拒绝清理异常路径 $temporary_root" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

ingress_json="$temporary_root/ingress.json"
network_policies_json="$temporary_root/network-policies.json"
load_balancers_json="$temporary_root/load-balancers.json"
listeners_json="$temporary_root/listeners.json"
attributes_json="$temporary_root/attributes.json"
target_groups_json="$temporary_root/target-groups.json"
target_health_json="$temporary_root/target-health.json"
pods_json="$temporary_root/pods.json"
http_listener_rules_json="$temporary_root/http-listener-rules.json"
https_listener_rules_json="$temporary_root/https-listener-rules.json"
waf_json="$temporary_root/waf.json"
security_group_rules_json="$temporary_root/security-group-rules.json"

"$kubectl_binary" -n "$application_namespace" get ingress \
  -l "$rgs_selector" -o json > "$ingress_json"
"$kubectl_binary" -n "$application_namespace" get networkpolicy \
  -o json > "$network_policies_json"
ruby -rjson -e '
  delivery = JSON.parse(File.binread(ARGV.fetch(0)))
  policies = JSON.parse(File.binread(ARGV.fetch(1))).fetch("items")
  release_name = ARGV.fetch(2)
  abort "当前 release NetworkPolicy 集合为空" unless policies.is_a?(Array) && !policies.empty?
  expected_cidrs = delivery.fetch("public_subnet_cidrs")
  abort "Terraform delivery 的 ALB 来源 CIDR 不精确" unless
    expected_cidrs.is_a?(Array) && expected_cidrs.length == 3 && expected_cidrs.uniq.length == 3

  rgs_policies = policies.select do |policy|
    policy.dig("metadata", "labels", "app.kubernetes.io/instance") == release_name &&
      policy.dig("metadata", "labels", "app.kubernetes.io/component") == "rgs" &&
      policy.dig("spec", "policyTypes") == ["Ingress"]
  end
  abort "当前 release 必须精确有一个 RGS ingress NetworkPolicy" unless rgs_policies.length == 1
  rgs_policy = rgs_policies.fetch(0)
  rgs_selector = rgs_policy.dig("spec", "podSelector", "matchLabels")
  abort "RGS ingress NetworkPolicy target selector 漂移" unless
    rgs_selector.is_a?(Hash) && rgs_selector.keys.sort == %w[
      app.kubernetes.io/component app.kubernetes.io/instance app.kubernetes.io/name
    ] && rgs_selector.fetch("app.kubernetes.io/component") == "rgs" &&
      rgs_selector.fetch("app.kubernetes.io/instance") == release_name &&
      rgs_selector.fetch("app.kubernetes.io/name").is_a?(String) &&
      !rgs_selector.fetch("app.kubernetes.io/name").empty?

  default_denies = policies.select do |policy|
    selector = policy.dig("spec", "podSelector", "matchLabels")
    policy.dig("spec", "policyTypes")&.sort == %w[Egress Ingress] &&
      Array(policy.dig("spec", "ingress")).empty? && Array(policy.dig("spec", "egress")).empty? &&
      selector == {
        "app.kubernetes.io/name" => rgs_selector.fetch("app.kubernetes.io/name"),
        "app.kubernetes.io/instance" => release_name,
      }
  end
  abort "当前 release default-deny ingress/egress NetworkPolicy 缺失或不精确" unless
    default_denies.length == 1

  normalize_ports = lambda do |rule|
    Array(rule.fetch("ports")).map do |port|
      abort "NetworkPolicy 端口包含 endPort 或未知字段" unless port.keys.sort == %w[port protocol]
      [port.fetch("protocol"), port.fetch("port")]
    end.sort_by { |protocol, port| [port, protocol] }
  end
  ingress_rules = rgs_policy.dig("spec", "ingress")
  abort "RGS ingress NetworkPolicy 必须精确有 ALB 与 monitoring 两条规则" unless
    ingress_rules.is_a?(Array) && ingress_rules.length == 2
  alb_rules = ingress_rules.select { |rule| normalize_ports.call(rule) == [["TCP", 8080], ["TCP", 8081]] }
  abort "RGS ingress NetworkPolicy 缺少精确 TCP 8080/8081 ALB 规则" unless alb_rules.length == 1
  alb_sources = alb_rules.fetch(0).fetch("from")
  actual_cidrs = alb_sources.map do |source|
    abort "ALB NetworkPolicy 来源必须仅为一个 ipBlock" unless source.keys == ["ipBlock"]
    block = source.fetch("ipBlock")
    abort "ALB NetworkPolicy ipBlock 不得含 except 或未知字段" unless block.keys == ["cidr"]
    block.fetch("cidr")
  end
  abort "实际 RGS NetworkPolicy ALB 来源未精确绑定 Terraform 公网子网 CIDR" unless
    actual_cidrs.length == expected_cidrs.length && actual_cidrs.sort == expected_cidrs.sort

  monitoring_rules = ingress_rules.select { |rule| normalize_ports.call(rule) == [["TCP", 8081]] }
  abort "RGS operations monitoring ingress 规则缺失或重复" unless monitoring_rules.length == 1
  monitoring_sources = monitoring_rules.fetch(0).fetch("from")
  abort "monitoring ingress 必须精确由一个 namespace+pod selector 组成" unless monitoring_sources.length == 1
  monitoring_source = monitoring_sources.fetch(0)
  abort "monitoring ingress 来源 selector 未绑定批准的 Prometheus agent" unless
    monitoring_source == {
      "namespaceSelector" => {
        "matchLabels" => {"kubernetes.io/metadata.name" => "monitoring"},
      },
      "podSelector" => {
        "matchLabels" => {"app.kubernetes.io/name" => "prometheus-agent"},
      },
    }

  # NetworkPolicy 是可加性模型；任何另一条也会选中 RGS Pod 且包含 ingress allow 的策略都会放宽边界。
  # English: NetworkPolicy is an additive model; any other policy that also selects the RGS Pod and contains
  # ingress allow will relax the boundary.
  rgs_labels = rgs_selector
  selector_matches_rgs = lambda do |selector|
    abort "NetworkPolicy podSelector 必须是 Kubernetes LabelSelector" unless selector.is_a?(Hash)
    abort "NetworkPolicy podSelector 包含未知字段" unless
      (selector.keys - %w[matchExpressions matchLabels]).empty?
    labels = selector.fetch("matchLabels", {})
    expressions = selector.fetch("matchExpressions", [])
    abort "NetworkPolicy matchLabels/matchExpressions 类型错误" unless
      labels.is_a?(Hash) && expressions.is_a?(Array) &&
        labels.all? { |key, value| key.is_a?(String) && !key.empty? && value.is_a?(String) && !value.empty? }
    labels_match = labels.all? { |key, value| rgs_labels[key] == value }
    expressions_match = expressions.all? do |expression|
      abort "NetworkPolicy matchExpression 字段不精确" unless
        expression.is_a?(Hash) && (expression.keys - %w[key operator values]).empty?
      key = expression.fetch("key")
      operator = expression.fetch("operator")
      values = expression.fetch("values", [])
      abort "NetworkPolicy matchExpression key/values 类型错误" unless
        key.is_a?(String) && !key.empty? && values.is_a?(Array) &&
          values.all? { |value| value.is_a?(String) && !value.empty? }
      actual = rgs_labels[key]
      case operator
      when "In"
        abort "NetworkPolicy In values 必须非空" if values.empty?
        !actual.nil? && values.include?(actual)
      when "NotIn"
        abort "NetworkPolicy NotIn values 必须非空" if values.empty?
        actual.nil? || !values.include?(actual)
      when "Exists"
        !actual.nil? && values.empty?
      when "DoesNotExist"
        actual.nil? && values.empty?
      else
        abort "NetworkPolicy matchExpression operator 不受支持"
      end
    end
    labels_match && expressions_match
  end
  unauthorized = policies.reject { |policy| policy.equal?(rgs_policy) }.select do |policy|
    ingress = Array(policy.dig("spec", "ingress"))
    selector = policy.dig("spec", "podSelector") || {}
    selects_rgs = selector_matches_rgs.call(selector)
    !ingress.empty? && selects_rgs
  end
  abort "检测到额外 NetworkPolicy 对当前 RGS Pod 放宽 ingress" unless unauthorized.empty?
' "$delivery_json" "$network_policies_json" "$release_name" || \
  fail '当前 release 实际 NetworkPolicy 未闭合 default-deny、ALB 8080/8081 与 monitoring 8081'
alb_hostname=$(ruby -rjson -e '
  value = JSON.parse(File.binread(ARGV.fetch(0)))
  items = value.fetch("items")
  abort "API Ingress 集合不精确" unless items.length == 1
  ingress = items.fetch(0)
  abort "API Ingress 不是 ALB class" unless ingress.dig("spec", "ingressClassName") == "alb"
  hostname = ingress.dig("status", "loadBalancer", "ingress", 0, "hostname").to_s
  abort "API Ingress 尚未获得 ALB hostname" unless hostname.match?(/\A[a-z0-9-]+\.[a-z0-9.-]+\.elb\.amazonaws\.com\z/)
  STDOUT.write(hostname)
' "$ingress_json") || fail '无法从实际 API Ingress 取得唯一 ALB hostname'
api_host=$(ruby -rjson -e '
  value = JSON.parse(File.binread(ARGV.fetch(0))).fetch("items").fetch(0)
  rules = value.dig("spec", "rules")
  abort "API Ingress 必须精确包含一个 host rule" unless rules.is_a?(Array) && rules.length == 1
  rule = rules.fetch(0)
  paths = rule.dig("http", "paths")
  abort "API Ingress 必须固定 Prefix /" unless
    paths.is_a?(Array) && paths.length == 1 && paths.fetch(0).fetch("path") == "/" &&
      paths.fetch(0).fetch("pathType") == "Prefix"
  host = rule.fetch("host").to_s
  abort "API Ingress host 不合法" unless host.match?(/\A[a-z0-9][a-z0-9.-]+\.[a-z]{2,}\z/)
  STDOUT.write(host)
' "$ingress_json") || fail '无法从实际 API Ingress 取得 host'

aws_region=$(ruby -rjson -e 'print JSON.parse(File.binread(ARGV.fetch(0))).fetch("aws_region")' "$delivery_json")
"$aws_binary" elbv2 describe-load-balancers --region "$aws_region" --no-cli-pager --output json > \
  "$load_balancers_json"
alb_arn=$(ruby -rjson -e '
  delivery = JSON.parse(File.binread(ARGV.fetch(0)))
  actual = JSON.parse(File.binread(ARGV.fetch(1))).fetch("LoadBalancers")
  hostname = ARGV.fetch(2)
  matches = actual.select { |item| item.fetch("DNSName") == hostname }
  abort "ALB hostname 未唯一映射实际资源" unless matches.length == 1
  load_balancer = matches.fetch(0)
  expected_subnets = delivery.fetch("public_subnet_ids").sort
  actual_subnets = load_balancer.fetch("AvailabilityZones").map { |zone| zone.fetch("SubnetId") }.sort
  abort "实际 ALB scheme/type/IP mode/状态漂移" unless
    load_balancer.fetch("Scheme") == "internet-facing" &&
      load_balancer.fetch("Type") == "application" &&
      load_balancer.fetch("IpAddressType") == "ipv4" &&
      load_balancer.dig("State", "Code") == "active"
  abort "实际 ALB 子网或前端 SG 未绑定 Terraform delivery" unless
    actual_subnets == expected_subnets &&
      load_balancer.fetch("SecurityGroups") == [delivery.fetch("alb_security_group_id")]
  arn = load_balancer.fetch("LoadBalancerArn")
  expected_prefix = "arn:aws:elasticloadbalancing:#{delivery.fetch("aws_region")}:#{delivery.fetch("aws_account_id")}:loadbalancer/app/"
  abort "实际 ALB ARN 账号或区域错误" unless arn.start_with?(expected_prefix)
  STDOUT.write(arn)
' "$delivery_json" "$load_balancers_json" "$alb_hostname") || fail '实际 ALB 身份、子网、SG 或状态不满足'

"$aws_binary" wafv2 get-web-acl-for-resource --resource-arn "$alb_arn" --region "$aws_region" \
  --no-cli-pager --output json > "$waf_json"
ruby -rjson -e '
  delivery = JSON.parse(File.binread(ARGV.fetch(0)))
  actual = JSON.parse(File.binread(ARGV.fetch(1))).fetch("WebACL")
  abort "实际 ALB 未绑定当前 Terraform regional WAF" unless
    actual.fetch("ARN") == delivery.fetch("api_waf_web_acl_arn")
' "$delivery_json" "$waf_json" || fail 'ALB WAF 实际关联漂移'

"$aws_binary" elbv2 describe-listeners --load-balancer-arn "$alb_arn" --region "$aws_region" \
  --no-cli-pager --output json > "$listeners_json"
ruby -rjson -e '
  delivery = JSON.parse(File.binread(ARGV.fetch(0)))
  listeners = JSON.parse(File.binread(ARGV.fetch(1))).fetch("Listeners")
  abort "实际 ALB listener 集合必须精确为 80/443" unless listeners.map { |item| item.fetch("Port") }.sort == [80, 443]
  http = listeners.find { |item| item.fetch("Port") == 80 }
  https = listeners.find { |item| item.fetch("Port") == 443 }
  redirect = http.fetch("DefaultActions")
  redirect_config = redirect.fetch(0).fetch("RedirectConfig", {}) if redirect.length == 1
  preserves_request_target = redirect_config && [
    ["Host", %q(#{host})], ["Path", %q(/#{path})], ["Query", %q(#{query})]
  ].all? { |key, expected| redirect_config[key].nil? || redirect_config[key] == expected }
  abort "HTTP listener 未固定重定向 HTTPS 443" unless
    http.fetch("Protocol") == "HTTP" && redirect.length == 1 &&
      redirect.fetch(0).fetch("Type") == "redirect" &&
      redirect_config.fetch("Protocol", nil) == "HTTPS" &&
      redirect_config.fetch("Port", nil) == "443" &&
      redirect_config.fetch("StatusCode", nil) == "HTTP_301" && preserves_request_target
  abort "443 listener 的 TLS policy 或证书未绑定 delivery" unless
    https.fetch("Protocol") == "HTTPS" &&
      https.fetch("SslPolicy") == delivery.fetch("api_alb_tls_policy") &&
      https.fetch("Certificates") == [{"CertificateArn" => delivery.fetch("regional_acm_certificate_arn")}]
' "$delivery_json" "$listeners_json" || fail 'ALB listener 实际合同漂移'
http_listener_arn=$(ruby -rjson -e '
  listener = JSON.parse(File.binread(ARGV.fetch(0))).fetch("Listeners").find { |item| item.fetch("Port") == 80 }
  abort "缺少 HTTP listener ARN" unless listener
  STDOUT.write(listener.fetch("ListenerArn"))
' "$listeners_json") || fail '无法读取 HTTP listener ARN'
https_listener_arn=$(ruby -rjson -e '
  listener = JSON.parse(File.binread(ARGV.fetch(0))).fetch("Listeners").find { |item| item.fetch("Port") == 443 }
  abort "缺少 HTTPS listener ARN" unless listener
  STDOUT.write(listener.fetch("ListenerArn"))
' "$listeners_json") || fail '无法读取 HTTPS listener ARN'

"$aws_binary" elbv2 describe-load-balancer-attributes --load-balancer-arn "$alb_arn" \
  --region "$aws_region" --no-cli-pager --output json > "$attributes_json"
ruby -rjson -e '
  delivery = JSON.parse(File.binread(ARGV.fetch(0)))
  items = JSON.parse(File.binread(ARGV.fetch(1))).fetch("Attributes")
  keys = items.map { |item| item.fetch("Key") }
  abort "实际 ALB 属性键重复" unless keys.uniq.length == keys.length
  attributes = items.to_h { |item| [item.fetch("Key"), item.fetch("Value")] }
  expected = {
    "deletion_protection.enabled" => "true",
    "waf.fail_open.enabled" => "false",
    "routing.http.drop_invalid_header_fields.enabled" => "true",
    "routing.http.desync_mitigation_mode" => "strictest",
    "routing.http2.enabled" => "true",
    "idle_timeout.timeout_seconds" => "30",
    "client_keep_alive.seconds" => "300",
    "access_logs.s3.enabled" => "true",
  }
  abort "实际 ALB 安全、容量或日志属性漂移" unless expected.all? { |key, value| attributes[key] == value }
  abort "实际 ALB access log bucket/prefix 未绑定 Terraform delivery" unless
    attributes.fetch("access_logs.s3.bucket", nil) == delivery.fetch("alb_access_log_bucket_name") &&
      attributes.fetch("access_logs.s3.prefix", nil) == delivery.fetch("alb_access_log_prefix") &&
      delivery.dig("application_handoff", "alb_access_logs") == {
        "bucket" => delivery.fetch("alb_access_log_bucket_name"),
        "prefix" => delivery.fetch("alb_access_log_prefix"),
      }
' "$delivery_json" "$attributes_json" || fail 'ALB 属性实际合同漂移'

"$aws_binary" elbv2 describe-target-groups --load-balancer-arn "$alb_arn" --region "$aws_region" \
  --no-cli-pager --output json > "$target_groups_json"
target_group_arn=$(ruby -rjson -e '
  delivery = JSON.parse(File.binread(ARGV.fetch(0)))
  groups = JSON.parse(File.binread(ARGV.fetch(1))).fetch("TargetGroups")
  abort "API ALB target group 集合不精确" unless groups.length == 1
  group = groups.fetch(0)
  abort "实际 target group 业务或私有 health 合同漂移" unless
    group.fetch("VpcId") == delivery.fetch("vpc_id") &&
      group.fetch("TargetType") == "ip" && group.fetch("Protocol") == "HTTP" && group.fetch("Port") == 8080 &&
      group.fetch("HealthCheckProtocol") == "HTTP" && group.fetch("HealthCheckPort") == "8081" &&
      group.fetch("HealthCheckPath") == "/healthz" && group.dig("Matcher", "HttpCode") == "200"
  STDOUT.write(group.fetch("TargetGroupArn"))
' "$delivery_json" "$target_groups_json") || fail 'ALB target group 实际合同漂移'

"$aws_binary" elbv2 describe-rules --listener-arn "$http_listener_arn" --region "$aws_region" \
  --no-cli-pager --output json > "$http_listener_rules_json"
"$aws_binary" elbv2 describe-rules --listener-arn "$https_listener_arn" --region "$aws_region" \
  --no-cli-pager --output json > "$https_listener_rules_json"
ruby -rjson -e '
  http_rules = JSON.parse(File.binread(ARGV.fetch(0))).fetch("Rules")
  https_rules = JSON.parse(File.binread(ARGV.fetch(1))).fetch("Rules")
  expected_host = ARGV.fetch(2)
  expected_target_group = ARGV.fetch(3)

  abort "HTTP listener 必须仅包含默认规则" unless
    http_rules.length == 1 && http_rules.fetch(0).fetch("IsDefault") == true &&
      http_rules.fetch(0).fetch("Priority") == "default" && http_rules.fetch(0).fetch("Conditions") == []
  http_actions = http_rules.fetch(0).fetch("Actions")
  http_redirect = http_actions.fetch(0).fetch("RedirectConfig", {}) if http_actions.length == 1
  preserves_request_target = http_redirect && [
    ["Host", %q(#{host})], ["Path", %q(/#{path})], ["Query", %q(#{query})]
  ].all? { |key, expected| http_redirect[key].nil? || http_redirect[key] == expected }
  abort "HTTP 默认规则必须精确执行 HTTPS 301 重定向" unless
    http_actions.length == 1 && http_actions.fetch(0).fetch("Type") == "redirect" &&
      http_redirect.fetch("Protocol", nil) == "HTTPS" && http_redirect.fetch("Port", nil) == "443" &&
      http_redirect.fetch("StatusCode", nil) == "HTTP_301" && preserves_request_target

  defaults = https_rules.select { |rule| rule.fetch("IsDefault", false) }
  forwarding = https_rules.reject { |rule| rule.fetch("IsDefault", false) }
  abort "HTTPS listener 规则集合必须精确为默认 404 与唯一 API host forward" unless
    https_rules.length == 2 && defaults.length == 1 && forwarding.length == 1
  default_rule = defaults.fetch(0)
  default_actions = default_rule.fetch("Actions", [])
  abort "HTTPS 默认规则必须固定返回 404" unless
    default_rule.fetch("Priority") == "default" && default_rule.fetch("Conditions") == [] &&
      default_actions.length == 1 && default_actions.fetch(0).fetch("Type", nil) == "fixed-response" &&
      default_actions.fetch(0).dig("FixedResponseConfig", "StatusCode") == "404"

  forward_rule = forwarding.fetch(0)
  actions = forward_rule.fetch("Actions", [])
  abort "HTTPS API 规则必须精确 forward 到当前 target group" unless
    actions.length == 1 && actions.fetch(0).fetch("Type", nil) == "forward" &&
      actions.fetch(0).fetch("TargetGroupArn", nil) == expected_target_group
  forward_config = actions.fetch(0)["ForwardConfig"]
  if forward_config
    groups = forward_config.fetch("TargetGroups", [])
    abort "HTTPS API 规则不得使用多目标或加权 forward" unless
      groups.length == 1 && groups.fetch(0).fetch("TargetGroupArn", nil) == expected_target_group &&
        groups.fetch(0).fetch("Weight", 1) == 1
  end
  conditions = forward_rule.fetch("Conditions")
  host_condition = conditions.find { |condition| condition.fetch("Field", nil) == "host-header" }
  path_condition = conditions.find { |condition| condition.fetch("Field", nil) == "path-pattern" }
  abort "HTTPS listener host/path rule 未精确绑定当前 API host 与 Prefix /" unless
    conditions.length == 2 && host_condition && path_condition &&
      host_condition.dig("HostHeaderConfig", "Values") == [expected_host] &&
      path_condition.dig("PathPatternConfig", "Values") == ["/*"]
' "$http_listener_rules_json" "$https_listener_rules_json" "$api_host" "$target_group_arn" || \
  fail 'ALB HTTP/HTTPS listener rule 实际合同漂移'

"$kubectl_binary" -n "$application_namespace" get pods \
  -l "$rgs_selector" -o json > "$pods_json"
"$aws_binary" elbv2 describe-target-health --target-group-arn "$target_group_arn" --region "$aws_region" \
  --no-cli-pager --output json > "$target_health_json"
ruby -rjson -e '
  pods = JSON.parse(File.binread(ARGV.fetch(0))).fetch("items")
  ready_ips = pods.each_with_object([]) do |pod, result|
    next if pod.dig("metadata", "deletionTimestamp")
    next unless pod.dig("status", "phase") == "Running"
    next unless pod.dig("status", "conditions")&.any? { |condition|
      condition.fetch("type", nil) == "Ready" && condition.fetch("status", nil) == "True"
    }
    ip = pod.dig("status", "podIP").to_s
    abort "Ready RGS Pod IP 不是 IPv4" unless ip.match?(/\A(?:\d{1,3}\.){3}\d{1,3}\z/)
    result << ip
  end.sort
  abort "当前 release 没有 Ready RGS Pod" if ready_ips.empty? || ready_ips.uniq.length != ready_ips.length

  targets = JSON.parse(File.binread(ARGV.fetch(1))).fetch("TargetHealthDescriptions")
  indexed = targets.group_by { |item| [item.dig("Target", "Id"), item.dig("Target", "Port")] }
  ready_ips.each do |ip|
    matches = indexed.fetch([ip, 8080], [])
    abort "当前 Ready RGS Pod 未唯一注册为健康 8080 target" unless
      matches.length == 1 && matches.fetch(0).dig("TargetHealth", "State") == "healthy"
  end
  stale = targets.reject { |item| ready_ips.include?(item.dig("Target", "Id")) }
  abort "非当前 release target 只能处于 draining" unless stale.all? { |item|
    item.dig("Target", "Port") == 8080 && item.dig("TargetHealth", "State") == "draining"
  }
  abort "target health 含当前 Pod 的错误端口或重复注册" unless
    targets.count { |item| ready_ips.include?(item.dig("Target", "Id")) } == ready_ips.length
' "$pods_json" "$target_health_json" || fail '当前 Ready RGS Pods 尚未全部成为健康 ALB target'

alb_security_group=$(ruby -rjson -e 'print JSON.parse(File.binread(ARGV.fetch(0))).fetch("alb_security_group_id")' "$delivery_json")
"$aws_binary" ec2 describe-security-group-rules \
  --filters "Name=group-id,Values=$alb_security_group" --region "$aws_region" \
  --no-cli-pager --output json > "$security_group_rules_json"
ruby -rjson -e '
  delivery = JSON.parse(File.binread(ARGV.fetch(0)))
  rules = JSON.parse(File.binread(ARGV.fetch(1))).fetch("SecurityGroupRules")
  egress = rules.select { |rule| rule.fetch("IsEgress") == true }
  signatures = egress.map { |rule|
    [rule.fetch("IpProtocol"), rule.fetch("FromPort"), rule.fetch("ToPort"), rule.fetch("CidrIpv4", nil)]
  }.sort_by { |item| item.fetch(1) }
  expected = [8080, 8081].map { |port| ["tcp", port, port, delivery.fetch("vpc_cidr")] }
  abort "ALB SG egress 必须只向应用 VPC 精确开放 TCP 8080 与 operations health 8081" unless
    delivery.fetch("alb_egress_target_ports") == [8080, 8081] && signatures == expected
' "$delivery_json" "$security_group_rules_json" || fail 'ALB SG 实际 egress 合同漂移'

printf '%s\n' 'AWS ALB/WAF/target-health 发布后实时门禁通过。'
