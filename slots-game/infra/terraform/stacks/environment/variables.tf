variable "environment" {
  description = "由环境根固定的环境名称"
  type        = string
}

variable "configuration" {
  description = "环境的非秘密部署参数；详细类型和失败闭合由 application-platform 模块校验"
  type        = any
}

variable "valkey_password_a" {
  description = "Valkey A 槽 ACL 密码；仅透传至 write-only 参数"
  type        = string
  sensitive   = true
  ephemeral   = true
}

variable "valkey_password_b" {
  description = "Valkey B 槽 ACL 密码；仅透传至 write-only 参数"
  type        = string
  sensitive   = true
  ephemeral   = true
}

variable "shared_admission_hmac_key" {
  description = "共享准入 HMAC key；仅透传至 write-only 参数"
  type        = string
  sensitive   = true
  ephemeral   = true
}

variable "valkey_root_ca_pem" {
  description = "Valkey TLS 根证书 PEM；仅透传至 write-only 参数"
  type        = string
  sensitive   = true
  ephemeral   = true
}
