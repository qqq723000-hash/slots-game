#!/bin/sh
# 本地渲染真实 Chart，证明 Terraform subnet/SG/CIDR 与 ALB 关键注解漂移会在发布前失败。
# English: Render real charts locally to prove that Terraform subnet/SG/CIDR and ALB key annotation drift will
# fail before release.
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/../../../.." && pwd)
chart="$repository_root/slots-game/deploy/cluster-production/chart"
values_example="$repository_root/slots-game/deploy/aws-production/values.example.yaml"
delivery_fixture="$script_directory/fixtures/live-delivery.json"
verifier="$script_directory/verify-rendered-release.rb"
helm_binary=${HELM_BIN:-helm}
temporary_parent=${TMPDIR:-/tmp}
temporary_root=$(mktemp -d "${temporary_parent%/}/slots-rendered-network.XXXXXX")

cleanup() {
  case "$temporary_root" in
    "${temporary_parent%/}"/slots-rendered-network.*) rm -rf -- "$temporary_root" ;;
    *) fail "拒绝清理异常路径 $temporary_root" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf '%s\n' "AWS rendered network fixture: $*" >&2
  exit 1
}

for command in "$helm_binary" ruby; do
  command -v "$command" >/dev/null 2>&1 || fail "缺少命令 $command"
done

values="$temporary_root/values.yaml"
delivery="$temporary_root/delivery.json"
rgs_image=111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/slots/rgs-runtime@sha256:1111111111111111111111111111111111111111111111111111111111111111
migrator_image=111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/slots/rgs-migrator@sha256:2222222222222222222222222222222222222222222222222222222222222222

ruby -ryaml -e '
  value = YAML.safe_load(File.binread(ARGV.fetch(0)), aliases: true)
  account = "111122223333"
  value.fetch("images").each_value do |image|
    next unless image.is_a?(Hash) && image["repository"]
    image["repository"] = image.fetch("repository").sub("123456789012", account)
  end
  value.fetch("rgs")["publicBaseURL"] = "https://rgs.production.example.net"
  value.fetch("rgs")["allowedOrigins"] = ["https://slots.production.example.net"]
  value.fetch("ingress")["apiHost"] = "rgs.production.example.net"
  value.fetch("ingress")["webHost"] = "slots.production.example.net"
  annotations = value.fetch("ingress").fetch("apiAnnotations")
  annotations["alb.ingress.kubernetes.io/certificate-arn"] = annotations.fetch("alb.ingress.kubernetes.io/certificate-arn").sub("123456789012", account)
  annotations["alb.ingress.kubernetes.io/wafv2-acl-arn"] = "arn:aws:wafv2:ap-southeast-1:#{account}:regional/webacl/slots-prod-primary-api/00000000-0000-4000-8000-000000000000"
  value.fetch("audit")["endpointURL"] = "https://audit.production.example.net/rgs/events"
  value.fetch("networkPolicy").fetch("ingressController")["cidrs"] = %w[
    10.30.0.0/24 10.30.1.0/24 10.30.2.0/24
  ]
  File.binwrite(ARGV.fetch(1), YAML.dump(value))
' "$values_example" "$values"

ruby -rjson -e '
  value = JSON.parse(File.binread(ARGV.fetch(0)))
  account = "111122223333"
  value["aws_account_id"] = account
  arn = value.fetch("api_waf_web_acl_arn").sub("123456789012", account)
  value["api_waf_web_acl_arn"] = arn
  value["regional_acm_certificate_arn"] = value.fetch("regional_acm_certificate_arn").sub("123456789012", account)
  value.fetch("api_edge_security_contract")["web_acl_arn"] = arn
  value.fetch("application_handoff").fetch("api_edge_security")["web_acl_arn"] = arn
  File.binwrite(ARGV.fetch(1), JSON.pretty_generate(value) << "\n")
' "$delivery_fixture" "$delivery"

render_and_verify() {
  candidate_values=$1
  rendered=$2
  "$helm_binary" template slots "$chart" --namespace slots-production --kube-version 1.30.0 \
    --is-upgrade -f "$candidate_values" > "$rendered" || fail '危险 values 未能进入 release verifier'
  TERRAFORM_DELIVERY_FILE=$delivery ruby "$verifier" "$rendered" "$rgs_image" "$migrator_image" \
    slots-production slots-rgs-api-runtime-assets-v1 slots-rgs-worker-runtime-assets-v1 \
    slots-rgs-shared-admission-v1
}

render_and_verify "$values" "$temporary_root/valid.yaml" >/dev/null || fail '正确网络绑定被错误拒绝'

assert_mutation_rejected() {
  name=$1
  candidate_values="$temporary_root/$name-values.yaml"
  candidate_rendered="$temporary_root/$name-rendered.yaml"
  MUTATION=$name ruby -ryaml -e '
    value = YAML.safe_load(File.binread(ARGV.fetch(0)), aliases: true)
    annotations = value.fetch("ingress").fetch("apiAnnotations")
    case ENV.fetch("MUTATION")
    when "wrong-subnets"
      annotations["alb.ingress.kubernetes.io/subnets"] = "subnet-99999999999999991,subnet-99999999999999992,subnet-99999999999999993"
    when "wrong-security-group"
      annotations["alb.ingress.kubernetes.io/security-groups"] = "sg-99999999999999999"
    when "wrong-network-policy-cidrs"
      value.fetch("networkPolicy").fetch("ingressController")["cidrs"] = %w[10.31.0.0/24 10.31.1.0/24 10.31.2.0/24]
    when "wrong-monitoring-selector"
      value.fetch("monitoring").fetch("namespaceSelector").fetch("matchLabels")["kubernetes.io/metadata.name"] =
        "foreign-monitoring"
    when "wrong-scheme"
      annotations["alb.ingress.kubernetes.io/scheme"] = "internal"
    when "wrong-listeners"
      annotations["alb.ingress.kubernetes.io/listen-ports"] = "[{\"HTTPS\":443}]"
    when "wrong-tls-policy"
      annotations["alb.ingress.kubernetes.io/ssl-policy"] = "ELBSecurityPolicy-2016-08"
    when "wrong-certificate"
      annotations["alb.ingress.kubernetes.io/certificate-arn"] =
        "arn:aws:acm:ap-southeast-1:111122223333:certificate/99999999-9999-4999-8999-999999999999"
    when "waf-fail-open"
      attributes = annotations.fetch("alb.ingress.kubernetes.io/load-balancer-attributes")
      annotations["alb.ingress.kubernetes.io/load-balancer-attributes"] =
        attributes.sub("waf.fail_open.enabled=false", "waf.fail_open.enabled=true")
    when "duplicate-waf-fail-open"
      attributes = annotations.fetch("alb.ingress.kubernetes.io/load-balancer-attributes")
      annotations["alb.ingress.kubernetes.io/load-balancer-attributes"] =
        "#{attributes},waf.fail_open.enabled=true"
    when "wrong-alb-log-bucket"
      attributes = annotations.fetch("alb.ingress.kubernetes.io/load-balancer-attributes")
      annotations["alb.ingress.kubernetes.io/load-balancer-attributes"] =
        attributes.sub("access_logs.s3.bucket=company-alb-access-logs", "access_logs.s3.bucket=attacker-alb-access-logs")
    when "wrong-alb-log-prefix"
      attributes = annotations.fetch("alb.ingress.kubernetes.io/load-balancer-attributes")
      annotations["alb.ingress.kubernetes.io/load-balancer-attributes"] =
        attributes.sub("access_logs.s3.prefix=slots-production", "access_logs.s3.prefix=foreign-environment")
    else
      abort "未知 mutation"
    end
    File.binwrite(ARGV.fetch(1), YAML.dump(value))
  ' "$values" "$candidate_values"
  if render_and_verify "$candidate_values" "$candidate_rendered" >/dev/null 2>&1; then
    fail "危险网络绑定被错误接受：$name"
  fi
}

assert_mutation_rejected wrong-subnets
assert_mutation_rejected wrong-security-group
assert_mutation_rejected wrong-network-policy-cidrs
assert_mutation_rejected wrong-monitoring-selector
assert_mutation_rejected wrong-scheme
assert_mutation_rejected wrong-listeners
assert_mutation_rejected wrong-tls-policy
assert_mutation_rejected wrong-certificate
assert_mutation_rejected waf-fail-open
assert_mutation_rejected duplicate-waf-fail-open
assert_mutation_rejected wrong-alb-log-bucket
assert_mutation_rejected wrong-alb-log-prefix

printf '%s\n' 'AWS rendered ALB/subnet/SG/NetworkPolicy 负向 fixture 通过。'
