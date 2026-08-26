output "vpc_id" {
  value = module.network.vpc_id
}

output "vpc_cidr" {
  value = module.network.vpc_cidr
}

output "aws_region" {
  value = var.aws_region
}

output "aws_account_id" {
  value = var.expected_account_id
}

output "environment" {
  value = var.environment
}

output "public_subnet_ids" {
  value = module.network.public_subnet_ids
}

output "public_subnet_cidrs" {
  value = module.network.public_subnet_cidrs
}

output "private_subnet_ids" {
  value = module.network.private_subnet_ids
}

output "data_subnet_ids" {
  value = module.network.data_subnet_ids
}

output "alb_security_group_id" {
  value = module.network.alb_security_group_id
}

output "alb_egress_target_ports" {
  value = module.network.alb_egress_target_ports
}

output "regional_acm_certificate_arn" {
  value = var.regional_acm_certificate_arn
}

output "api_alb_tls_policy" {
  value = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

output "alb_access_log_bucket_name" {
  value = var.alb_access_log_bucket_name
}

output "alb_access_log_prefix" {
  value = var.alb_access_log_prefix
}

output "workload_client_security_group_id" {
  description = "当前由 EKS 托管节点真实持有且获准访问 RDS/Valkey 的集群安全组"
  value       = module.eks.cluster_security_group_id
}

output "cluster_name" {
  value = module.eks.cluster_name
}

output "cluster_arn" {
  value = module.eks.cluster_arn
}

output "cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "rds_endpoint" {
  value = module.rds.endpoint
}

output "rds_port" {
  value = module.rds.port
}

output "rds_security_group_id" {
  value = module.rds.security_group_id
}

output "rds_reader_endpoint" {
  description = "可选同区域 PostgreSQL 只读副本 endpoint；默认 null，应用不得据此假定已完成读写分离"
  value       = module.rds.reader_endpoint
}

output "rds_read_scaling_contract" {
  description = "可选 RDS 同区域读扩展、继承校验与告警合同"
  value       = module.rds.read_scaling_contract
}

output "rds_alarm_contract" {
  description = "单实例 RDS 指标、阈值、告警窗口和死锁证据边界"
  value       = module.rds.alarm_contract
}

output "rds_master_user_secret_arn" {
  value     = module.rds.master_user_secret_arn
  sensitive = true
}

output "valkey_primary_endpoint" {
  value = module.cache.primary_endpoint
}

output "valkey_port" {
  value = module.cache.port
}

output "valkey_endpoint_url" {
  value = module.cache.endpoint_url
}

output "valkey_replication_group_id" {
  value = module.cache.replication_group_id
}

output "valkey_parameter_group_name" {
  value = module.cache.parameter_group_name
}

output "valkey_maxmemory_policy" {
  value = module.cache.maxmemory_policy
}

output "valkey_user_name" {
  value = module.cache.user_name
}

output "valkey_user_names" {
  value = module.cache.user_names
}

output "valkey_active_slot" {
  value = module.cache.active_slot
}

output "valkey_rotation_mode" {
  value = module.cache.rotation_mode
}

output "valkey_password_versions" {
  value = module.cache.password_versions
}

output "valkey_rotation_contract" {
  value = module.cache.rotation_contract
}

output "valkey_secret_arn" {
  value = module.cache.secret_arn
}

output "valkey_secret_name" {
  value = module.cache.secret_name
}

output "ecr_repository_urls" {
  value = module.ecr.repository_urls
}

output "application_secret_arns" {
  value = module.secrets.secret_arns
}

output "application_secret_names" {
  value = module.secrets.secret_names
}

output "web_bucket_name" {
  value = module.web_edge.bucket_name
}

output "api_waf_web_acl_arn" {
  description = "公网 RGS ALB 必须精确绑定的区域 WAFv2 Web ACL ARN"
  value       = module.api_edge_security.web_acl_arn
}

output "api_edge_security_contract" {
  description = "公网 RGS ALB 的应用层 DDoS 防护与可观测合同"
  value       = module.api_edge_security.contract
}

output "web_kms_key_arn" {
  value = module.web_edge.kms_key_arn
}

output "cloudfront_distribution_id" {
  value = module.web_edge.distribution_id
}

output "cloudfront_distribution_domain_name" {
  value = module.web_edge.distribution_domain_name
}

output "cloudfront_alias_domain_name" {
  value = module.web_edge.alias_domain_name
}

output "cloudfront_acm_certificate_arn" {
  value = module.web_edge.acm_certificate_arn
}

output "cloudfront_origin_access_control_id" {
  value = module.web_edge.origin_access_control_id
}

output "cloudfront_cache_policy_id" {
  value = module.web_edge.cache_policy_id
}

output "cloudfront_log_bucket_domain_name" {
  value = module.web_edge.log_bucket_domain_name
}

output "cloudfront_log_prefix" {
  value = module.web_edge.log_prefix
}

output "cloudfront_waf_web_acl_arn" {
  value = module.web_edge.waf_web_acl_arn
}

output "cloudfront_edge_security_contract" {
  value = module.web_edge.edge_security_contract
}

output "cloudfront_response_headers_policy_id" {
  value = module.web_edge.response_headers_policy_id
}

output "cloudfront_release_key_value_store_arn" {
  value = module.web_edge.release_key_value_store_arn
}

output "cloudfront_release_request_function_arn" {
  value = module.web_edge.release_request_function_arn
}

output "cloudfront_release_request_function_name" {
  value = module.web_edge.release_request_function_name
}

output "cloudfront_release_response_function_arn" {
  value = module.web_edge.release_response_function_arn
}

output "cloudfront_release_response_function_name" {
  value = module.web_edge.release_response_function_name
}

output "amp_workspace_id" {
  value = module.observability.amp_workspace_id
}

output "amp_remote_write_endpoint" {
  value = module.observability.amp_remote_write_endpoint
}

output "amp_writer_role_arn" {
  value = module.observability.amp_writer_role_arn
}

output "secret_sync_role_arn" {
  value = module.secrets.sync_role_arn
}

output "cluster_autoscaler_role_arn" {
  value = module.eks.cluster_autoscaler_role_arn
}

output "cluster_autoscaler_inline_policy_name" {
  value = module.eks.cluster_autoscaler_inline_policy_name
}

output "application_handoff" {
  description = "机器读取的应用发布前置契约；基础设施 apply 永远不等于应用可发布"
  value = {
    contract_version                      = "1.0.0"
    foundation_apply_is_application_ready = false
    application_release_allowed           = module.cache.rotation_contract.application_release_allowed
    maintenance_in_progress               = module.cache.rotation_contract.maintenance_in_progress
    private_vpc_runner_required           = true
    addon_versions                        = var.platform_addon_versions
    cluster_autoscaler_image_tag          = var.cluster_autoscaler_image_tag
    cluster_autoscaler_inline_policy_name = module.eks.cluster_autoscaler_inline_policy_name
    kubernetes_version                    = var.kubernetes_version
    application_namespace                 = var.application_namespace
    helm_release_name                     = var.helm_release_name
    alb_egress_target_ports               = module.network.alb_egress_target_ports
    api_alb_tls_policy                    = "ELBSecurityPolicy-TLS13-1-2-2021-06"
    alb_access_logs = {
      bucket = var.alb_access_log_bucket_name
      prefix = var.alb_access_log_prefix
    }
    metrics_server_addon_version = var.eks_addon_versions["metrics-server"]
    vpc_cni_network_policy = {
      addon_name      = "vpc-cni"
      addon_version   = var.eks_addon_versions["vpc-cni"]
      expected_status = "ACTIVE"
      configuration_values = {
        enableNetworkPolicy = "true"
      }
      pod_identity = {
        namespace       = "kube-system"
        service_account = "aws-node"
        role_arn        = module.eks.vpc_cni_role_arn
      }
    }
    cloudwatch_observability = {
      addon_name      = "amazon-cloudwatch-observability"
      addon_version   = var.eks_addon_versions["amazon-cloudwatch-observability"]
      expected_status = "ACTIVE"
      configuration_values = {
        agent = {
          config = {
            logs = {
              metrics_collected = {
                kubernetes = {
                  enhanced_container_insights = true
                }
              }
            }
          }
        }
        containerLogs = {
          enabled = true
        }
      }
      pod_identity = {
        namespace       = "amazon-cloudwatch"
        service_account = "cloudwatch-agent"
        role_arn        = module.observability.cloudwatch_agent_role_arn
      }
      workloads = [
        {
          namespace       = "amazon-cloudwatch"
          kind            = "DaemonSet"
          name            = "cloudwatch-agent"
          minimum_pods    = 1
          service_account = "cloudwatch-agent"
          container_name  = "cloudwatch-agent"
        },
        {
          namespace       = "amazon-cloudwatch"
          kind            = "DaemonSet"
          name            = "fluent-bit"
          minimum_pods    = 1
          service_account = "fluent-bit"
          container_name  = "fluent-bit"
        },
      ]
    }
    required_deployments = {
      aws_load_balancer_controller = "kube-system/aws-load-balancer-controller"
      cluster_autoscaler           = "kube-system/cluster-autoscaler"
      external_secrets             = "external-secrets/external-secrets"
      kube_state_metrics           = "monitoring/kube-prometheus-stack-kube-state-metrics"
      metrics_server               = "kube-system/metrics-server"
      prometheus_operator          = "monitoring/kube-prometheus-stack-operator"
    }
    required_custom_resources = {
      prometheus_agent = "monitoring/prometheusagent/prometheus-agent"
    }
    required_custom_resource_definitions = [
      "externalsecrets.external-secrets.io",
      "ingressclassparams.elbv2.k8s.aws",
      "prometheusagents.monitoring.coreos.com",
      "prometheusrules.monitoring.coreos.com",
      "servicemonitors.monitoring.coreos.com",
      "targetgroupbindings.elbv2.k8s.aws",
    ]
    required_ingress_class   = "alb"
    api_edge_security        = module.api_edge_security.contract
    cloudfront_edge_security = module.web_edge.edge_security_contract
    required_api_services = {
      resource_metrics = "v1beta1.metrics.k8s.io"
    }
    kube_state_metrics_release_name = "kube-prometheus-stack"
    live_gate_script                = "deploy/aws-production/verify-live-platform-prerequisites.sh"
    terraform_plan_gate_script      = "infra/terraform/scripts/verify-valkey-rotation-plan.rb"
    valkey_rotation_contract        = module.cache.rotation_contract
    external_secret_resource_names = merge(
      module.secrets.secret_names,
      { "shared-admission" = module.cache.secret_name }
    )
  }
}

output "alert_topic_arn" {
  value = module.observability.alert_topic_arn
}

output "backup_vault_arn" {
  value = module.backup.vault_arn
}

output "archive_bucket_name" {
  value = module.archive.bucket_name
}

output "archive_kms_key_arn" {
  value = module.archive.kms_key_arn
}

output "archive_rds_export_role_arn" {
  value = module.archive.rds_export_role_arn
}
