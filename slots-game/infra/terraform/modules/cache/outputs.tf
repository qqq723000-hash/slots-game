output "primary_endpoint" {
  description = "RGS API 共享准入客户端使用的 Valkey TLS endpoint"
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "port" {
  description = "Valkey TLS port"
  value       = aws_elasticache_replication_group.this.port
}

output "endpoint_url" {
  description = "写入 RGS_SHARED_ADMISSION_URL 的无凭据 TLS URL"
  value       = "rediss://${aws_elasticache_replication_group.this.primary_endpoint_address}:${aws_elasticache_replication_group.this.port}"
}

output "user_name" {
  description = "新工作负载连接 Valkey 时使用的活动 ACL 用户名"
  value       = local.active_user_name
}

output "user_names" {
  description = "始终保留在 user group 中的 A/B ACL 用户名"
  value       = local.acl_user_ids
}

output "active_slot" {
  description = "当前不可变 Secret 发布的 Valkey 凭据槽位"
  value       = var.valkey_active_slot
}

output "rotation_mode" {
  description = "当前 Valkey 凭据变更模式"
  value       = var.valkey_rotation_mode
}

output "password_versions" {
  description = "A/B write-only 密码版本；不包含密码值"
  value       = local.password_versions
}

output "rotation_contract" {
  description = "供发布门禁读取的 A/B 零停机轮换契约"
  value = {
    contract_version                              = "1.0.0"
    active_slot                                   = var.valkey_active_slot
    rotation_mode                                 = var.valkey_rotation_mode
    application_release_allowed                   = var.valkey_rotation_mode != "hmac-maintenance"
    maintenance_in_progress                       = var.valkey_rotation_mode == "hmac-maintenance"
    active_user_name                              = local.active_user_name
    password_versions                             = local.password_versions
    password_fingerprints                         = local.password_fingerprints
    published_secret_version                      = var.secret_version
    hmac_key_fingerprint                          = var.shared_admission_hmac_key_fingerprint
    both_users_remain_in_user_group               = true
    old_slot_reset_requires_live_evidence         = true
    hmac_bucket_reset_requires_separate_change    = true
    hmac_maintenance_requires_zero_replicas       = true
    hmac_maintenance_forbids_parallel_rollout     = true
    hmac_maintenance_single_attested_plan         = true
    hmac_maintenance_exit_requires_separate_plan  = true
    hmac_maintenance_attestation_schema           = "slots-game/hmac-quiesce-attestation/v1"
    hmac_maintenance_evidence_maximum_ttl_seconds = 3600
    hmac_maintenance_persistent_lock_name         = "slots-hmac-maintenance-lock"
    hmac_maintenance_target_identity              = local.target_identity
  }
}

output "secret_arn" {
  description = "External Secrets 同步共享准入凭据时读取的 Secret ARN"
  value       = aws_secretsmanager_secret.shared_admission.arn
}

output "secret_name" {
  description = "External Secrets 同步共享准入凭据时读取的 Secret 名称"
  value       = aws_secretsmanager_secret.shared_admission.name
}

output "security_group_id" {
  description = "Valkey 安全组 ID"
  value       = aws_security_group.this.id
}
