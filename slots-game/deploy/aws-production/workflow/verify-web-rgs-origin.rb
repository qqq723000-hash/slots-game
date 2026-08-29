#!/usr/bin/env ruby
# frozen_string_literal: true
# Ruby 冻结字符串字面量机器指令。 / English: Ruby frozen-string-literal machine directive.

require "json"
require "open3"
require "digest"

def fail_closed(message)
  warn "AWS Web RGS Origin 门禁：#{message}"
  exit 1
end

begin
fail_closed("必须传入 Terraform delivery、应用 namespace 与 Web 提取证据目录") unless ARGV.length == 3
delivery_path, namespace, evidence_directory = ARGV
fail_closed("Terraform delivery 不存在") unless File.file?(delivery_path)
fail_closed("应用 namespace 不合法") unless namespace.match?(/\A[a-z0-9]([-a-z0-9]*[a-z0-9])?\z/)

delivery = JSON.parse(File.binread(delivery_path))
release_name = delivery.fetch("helm_release_name")
unless release_name.is_a?(String) && release_name.match?(/\A[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?\z/)
  fail_closed("Terraform delivery 的 Helm release 名不合法")
end

identity_path = File.join(evidence_directory, "aws-web-delivery.env")
fail_closed("Web 提取身份记录不存在") unless File.file?(identity_path) && !File.symlink?(identity_path)
raw_identity = File.binread(identity_path)
fail_closed("Web 提取身份记录不是规范 UTF-8") unless raw_identity.force_encoding(Encoding::UTF_8).valid_encoding?
fail_closed("Web 提取身份记录换行不规范") if raw_identity.include?("\r") || !raw_identity.end_with?("\n")

expected_keys = %w[
  WEB_IMAGE_DIGEST
  CONFIGURATION_SHA256
  RELEASE_ID
  RELEASE_REVISION
  CLOUDFRONT_CSP_SHA256
]
entries = raw_identity.lines(chomp: true).map do |line|
  key, value = line.split("=", 2)
  fail_closed("Web 提取身份记录字段不规范") if key.to_s.empty? || value.to_s.empty?
  [key, value]
end
fail_closed("Web 提取身份记录字段集合不精确") unless entries.map(&:first) == expected_keys
identity = entries.to_h
fail_closed("Web 提取身份记录包含重复字段") unless identity.length == expected_keys.length

csp_path = File.join(evidence_directory, "cloudfront-content-security-policy.txt")
fail_closed("已签名 Web CSP 证据不存在") unless File.file?(csp_path) && !File.symlink?(csp_path)
csp = File.binread(csp_path)
fail_closed("已签名 Web CSP 不是规范单行 UTF-8") unless
  csp.force_encoding(Encoding::UTF_8).valid_encoding? && !csp.include?("\r") &&
    csp.end_with?("\n") && csp.lines.length == 1
expected_csp_sha256 = identity.fetch("CLOUDFRONT_CSP_SHA256")
fail_closed("CSP 摘要格式错误") unless expected_csp_sha256.match?(/\A[0-9a-f]{64}\z/)
fail_closed("CSP 摘要未绑定已签名 Web 提取证据") unless
  Digest::SHA256.file(csp_path).hexdigest == expected_csp_sha256

directives = csp.strip.split(";").map do |segment|
  fields = segment.strip.split(/[\t ]+/)
  next nil if fields.empty?
  [fields.first, fields.drop(1)]
end.compact
fail_closed("CSP directive 重复") unless directives.map(&:first).uniq.length == directives.length
connect_sources = directives.to_h.fetch("connect-src")
fail_closed("CSP connect-src 必须精确为 self 与一个 RGS Origin") unless
  connect_sources.length == 2 && connect_sources.first == "'self'"
rgs_base_url = connect_sources.fetch(1)
match = rgs_base_url.match(/\Ahttps:\/\/(?<host>[a-z0-9][a-z0-9.-]+\.[a-z]{2,})\z/)
fail_closed("CSP RGS Origin 必须是无 path/query/userinfo/port 的规范 HTTPS Origin") unless match

kubectl = ENV.fetch("KUBECTL_BIN", "kubectl")
selector = "app.kubernetes.io/component=rgs,app.kubernetes.io/instance=#{release_name}"
stdout, stderr, status = Open3.capture3(
  kubectl, "-n", namespace, "get", "ingress", "-l", selector, "-o", "json"
)
fail_closed("无法回读当前 Helm release 的 API Ingress：#{stderr.lines.first.to_s.strip}") unless status.success?

ingress_items = JSON.parse(stdout).fetch("items")
fail_closed("当前 Helm release 必须精确有一个 API Ingress") unless ingress_items.is_a?(Array) && ingress_items.length == 1
ingress = ingress_items.fetch(0)
fail_closed("API Ingress 必须使用 ALB class") unless ingress.dig("spec", "ingressClassName") == "alb"
rules = ingress.dig("spec", "rules")
fail_closed("API Ingress 必须精确有一个 host rule") unless rules.is_a?(Array) && rules.length == 1
paths = rules.fetch(0).dig("http", "paths")
unless paths.is_a?(Array) && paths.length == 1 &&
       paths.fetch(0).fetch("path") == "/" && paths.fetch(0).fetch("pathType") == "Prefix"
  fail_closed("API Ingress 必须固定 Prefix /")
end
api_host = rules.fetch(0).fetch("host").to_s
fail_closed("API Ingress host 不规范") unless api_host.match?(/\A[a-z0-9][a-z0-9.-]+\.[a-z]{2,}\z/)
fail_closed("已签名 Web RGS Origin 未绑定实际 API Ingress host") unless rgs_base_url == "https://#{api_host}"

puts "已签名 Web RGS Origin 与当前唯一 API Ingress host 精确一致。"
rescue JSON::ParserError, KeyError => e
  fail_closed("输入契约不完整：#{e.class}")
end
