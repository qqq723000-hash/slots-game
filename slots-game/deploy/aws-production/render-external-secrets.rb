#!/usr/bin/env ruby
# 从受保护 Terraform delivery 输出生成不含 Secret 值的同步资源。
# English: Generate sync resources without Secret values from protected Terraform delivery output.
require "json"

delivery_path = ARGV.fetch(0) { abort "用法: render-external-secrets.rb <delivery.json> <namespace>" }
namespace = ARGV.fetch(1) { abort "缺少目标 namespace" }
delivery = JSON.parse(File.binread(delivery_path))

abort "namespace 不合法" unless namespace.match?(/\A[a-z0-9](?:[-a-z0-9]*[a-z0-9])?\z/) && namespace.length <= 63
region = delivery.fetch("aws_region")
abort "AWS region 不合法" unless region.match?(/\A[a-z]{2}(?:-gov)?-[a-z]+-[0-9]\z/)

application = delivery.fetch("application_secret_names")
expected_boundaries = %w[
  api-runtime-assets
  migrator-database
  operations-bearer
  runtime-database
  worker-runtime-assets
]
abort "应用 Secret 边界不完整" unless application.keys.sort == expected_boundaries.sort

shared_name = delivery.fetch("valkey_secret_name")
all_names = application.values + [shared_name]
all_names.each do |name|
  abort "Secret 名称必须是以 -v<正整数> 结尾的合法版本化名称" unless
    name.match?(/\A[a-z0-9](?:[-a-z0-9]*[a-z0-9])?-v[1-9][0-9]*\z/) && name.length <= 253
end

quote = ->(value) { JSON.generate(value) }

puts <<~YAML
  apiVersion: v1
  kind: Namespace
  metadata:
    name: #{quote.call(namespace)}
    labels:
      pod-security.kubernetes.io/enforce: restricted
      pod-security.kubernetes.io/audit: restricted
      pod-security.kubernetes.io/warn: restricted
YAML

puts "---"
puts <<~YAML
  apiVersion: external-secrets.io/v1
  kind: SecretStore
  metadata:
    name: slots-aws-secrets-manager
    namespace: #{quote.call(namespace)}
  spec:
    provider:
      aws:
        service: SecretsManager
        region: #{quote.call(region)}
YAML

application.sort.each do |boundary, name|
  puts "---"
  puts <<~YAML
    apiVersion: external-secrets.io/v1
    kind: ExternalSecret
    metadata:
      name: #{quote.call(name)}
      namespace: #{quote.call(namespace)}
      labels:
        slots.example.com/secret-boundary: #{quote.call(boundary)}
    spec:
      refreshPolicy: CreatedOnce
      secretStoreRef:
        kind: SecretStore
        name: slots-aws-secrets-manager
      target:
        name: #{quote.call(name)}
        creationPolicy: Owner
        deletionPolicy: Retain
        immutable: true
      dataFrom:
        - extract:
            key: #{quote.call(name)}
  YAML
end

puts "---"
puts <<~YAML
  apiVersion: external-secrets.io/v1
  kind: ExternalSecret
  metadata:
    name: #{quote.call(shared_name)}
    namespace: #{quote.call(namespace)}
    labels:
      slots.example.com/secret-boundary: rgs-shared-admission
  spec:
    refreshPolicy: CreatedOnce
    secretStoreRef:
      kind: SecretStore
      name: slots-aws-secrets-manager
    target:
      name: #{quote.call(shared_name)}
      creationPolicy: Owner
      deletionPolicy: Retain
      immutable: true
    data:
      - secretKey: username
        remoteRef:
          key: #{quote.call(shared_name)}
          property: username
      - secretKey: password
        remoteRef:
          key: #{quote.call(shared_name)}
          property: password
      - secretKey: hmac.key
        remoteRef:
          key: #{quote.call(shared_name)}
          property: hmacKey
      - secretKey: root-ca.pem
        remoteRef:
          key: #{quote.call(shared_name)}
          property: rootCA
YAML
