# 部署入口

AWS 是唯一正式生产主线。本目录交付应用容器、Helm Chart、本机集成夹具、可观测性契约和
供应链门禁；它不虚构已经创建的云账号、VPC、EKS、RDS、S3、CloudFront、WAF、IAM 或监控
平台，也不保存任何正式 Secret。

## 入口索引

| 用途 | 入口 | 边界 |
| --- | --- | --- |
| AWS 正式生产 | [AWS 正式交付契约](aws-production/README.md) | Web 使用私有 S3、CloudFront OAC 与发布版本隔离；RGS 经 WAF、ALB 进入 EKS |
| 通用 Kubernetes | [通用 Helm 交付](cluster-production/README.md) | 只交付 RGS、可选 Web、一次性 migrator 和应用级策略，不创建外部平台能力 |
| Web 发布物 | [Web 多副本与容器契约](web/README.md) | 构建参数、资源审批、确定性清单、缓存和版本隔离必须同时成立 |
| 本机端到端验收 | [macOS 本机集成验收](local-production/README.md) | 只验证单机真实流程，不是 AWS 高可用、安全或灾备证据 |
| 指标、日志与告警 | [本机与 CI 可观测性契约](observability/README.md) | Compose 不进入 AWS；正式环境接入托管指标、日志、告警和审计平台 |
| 构建与发布安全 | [供应链门禁](supply-chain/README.md) | 候选制品必须经过扫描、SBOM、来源证明、摘要绑定和签名流程 |

配置字段形状见 [环境变量示例](env.example) 和
[运营商配置示例](operators.example.json)。它们包含占位值，只能用于生成受控环境中的正式配置，
不能直接部署。独立 PostgreSQL 一致性测试入口见
[后端发布门禁](../docs/backend-release-gates.md)。

## 失败闭合边界

- RGS 是会话、RNG、轮次、余额、派彩、特性状态、幂等和恢复的权威边界；浏览器只负责表现。
- `rgs-server` 与 `rgs-migrator` 使用不同镜像入口和数据库身份；运行时不得取得 DDL 凭据。
- 正式镜像只按 `repository@sha256:digest` 部署，Secret、私钥、令牌、DSN 和资源审批文件不得进入
  Git、镜像层、公开构建参数、URL 或日志。
- `/readyz` 与 `/metrics` 只存在于私有运维监听器并使用文件 Bearer；公网入口只能发布业务端口。
- 数据库、钱包、审计接收端、密钥系统、集中日志、告警路由和恢复能力必须由正式平台
  实例化并验收。仓库已以 API + Valkey 实现已验证身份的跨副本新意图准入；平台 WAF/网关仍只负责
  未认证攻击面和粗粒度容量保护。缺少任何必需依赖或实时验收时应用拒绝接流。
- Helm migrator hook 的安装、升级和失败保留语义不得由直接 `kubectl apply` 绕过。
- 本机 Compose、CI fixture、示例 values 和示例运营商配置均不得作为正式生产发布证据。

应用级协议和运行责任以以下文档为准：

- [AWS 正式生产架构](../docs/aws-production-architecture.md)
- [AWS 正式生产部署](../docs/aws-production-deployment.md)
- [AWS 正式生产运维](../docs/aws-production-operations.md)
- [运营商集成](../docs/operator-integration.md)
- [数据库迁移](../docs/database-migrations.md)
- [故障恢复](../docs/failure-recovery.md)
- [安全与合规边界](../docs/security-compliance.md)
- [RGS OpenAPI](../server/openapi.yaml)

## 验证入口

在仓库的 `slots-game/` 目录执行：

```sh
make verify
make verify-deployment-contracts
make verify-supply-chain-contract
./deploy/local-production/verify.sh
```

前三项验证源码、AWS/通用集群渲染和供应链边界；最后一项消费一次性启动码并执行真实浏览器
会话，只作为本机端到端验收。
