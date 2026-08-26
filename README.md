# Primal Rampage

面向公司正式交付的槽位游戏源码仓库。生产主线以 AWS 多可用区集群为目标：静态 Web 发布到
Amazon S3 并通过 CloudFront OAC 分发，公共 API 经 Route 53、AWS WAF、ALB 进入 Amazon EKS，
权威交易状态存储在 Amazon RDS for PostgreSQL Multi-AZ 实例。

## 读者一键在线试玩（待外部授权后启用）

[批准并部署后的固定地址](https://qqq723000-hash.github.io/slots-game/)是与正式 RGS 入口隔离的
确定性表现 Demo：只使用 `XTS` 测试积分，无真钱、无钱包、无经济价值，不连接生产后端。
当前工作流在缺少覆盖全球公开分发的逐文件外部授权时失败关闭，因此该链接在完成审批和首次部署前
不会被宣称为已上线。素材权属与对外发布边界见
[静态资源说明](slots-game/web/ASSETS.md)。

项目源码位于 [`slots-game/`](slots-game/)，持续集成与受保护发布工作流源码位于
[`.github/workflows/`](.github/workflows/)。正式评审从以下入口开始：

- [项目交付总览](slots-game/README.md)
- [AWS 正式生产架构](slots-game/docs/aws-production-architecture.md)
- [AWS 正式生产部署](slots-game/docs/aws-production-deployment.md)
- [AWS 正式生产运维](slots-game/docs/aws-production-operations.md)
- [DDoS 威胁模型与演练边界](slots-game/docs/ddos-threat-model.md)
- [通用 Kubernetes/Helm 应用交付](slots-game/deploy/cluster-production/README.md)
- [Web 素材权属与发布门禁](slots-game/web/ASSETS.md)
- [支持与响应边界](SUPPORT.md)

当前源码交付元数据版本由 [`slots-game/VERSION`](slots-game/VERSION) 唯一声明。版本文件、
变更记录、Web 包元数据、Helm Chart 和发布示例必须由机器门禁保持一致；只有受保护 Tag、
GitHub Release 说明以及 OCI/SBOM/来源证明/签名证据全部完成后，才构成正式发布。

macOS Docker Compose 仅用于开发、集成与端到端验收，不是公司正式生产拓扑，也不能作为 AWS
高可用、灾难恢复或安全控制已经生效的证明。

本仓库同时交付应用源码、容器构建、Helm Chart、验证门禁与应用专属 AWS Terraform。
`slots-game/infra/terraform/` 可创建 VPC、EKS、RDS、ElastiCache Valkey、ECR、Secrets Manager
元数据、S3/CloudFront、应用 API Regional WAF、AMP、CloudWatch、备份与归档基线；企业落地区
仍必须提供账号、state/部署身份、DNS、ACM 证书、可选 Shield Advanced 订阅和组织级安全能力。
源码中存在 IaC 不等于任何 AWS
账号已经执行 `plan`/`apply` 或通过上线验收。

运行密码、私钥、数据库、日志、发布审批和构建产物不得进入 Git。正式秘密由 AWS Secrets
Manager 管理并以最小权限注入工作负载；本机验收秘密由脚本写入仓库外受限状态目录。

## 许可与商业发布边界

本仓库当前没有提供根级源码 `LICENSE`，因此不能把公开可见或可评审误解为已经授予开源、复制、
再分发或商业使用许可。权利主体与授权条款必须由仓库所有者在正式对外发布前提供并经法律评审；
本仓库不会代填权利主体或凭空生成商标、著作权证明。

Go 与 Web 开源依赖的分发声明分别见
[`server/THIRD_PARTY_NOTICES.txt`](slots-game/server/THIRD_PARTY_NOTICES.txt) 和
[`web/public/THIRD_PARTY_NOTICES.txt`](slots-game/web/public/THIRD_PARTY_NOTICES.txt)。游戏运行素材还受
[逐文件权属与哈希审批门禁](slots-game/web/ASSETS.md)约束；仓库内缺少可审计权属材料的资源不得被
宣称为全部原创或已获商业分发授权。

本仓库当前为公开仓库，受保护 LFS 素材已经可以被仓库读者下载。因此外部授权必须同时覆盖
“公开源码/LFS 分发”和“全球公开静态试玩”，不能把未启用 Pages 误解为素材尚未公开分发。
在取得该授权前，仓库所有者应将仓库转为私有或移除/替换相关素材；本交付不会擅自改变仓库可见性。
