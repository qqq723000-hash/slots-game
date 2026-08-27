# Primal Rampage 个人独立商用级工程交付

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

本仓库交付 Go RGS 后端、PostgreSQL 迁移器、TypeScript/PixiJS Web、生产容器、Helm Chart、
可观测性规则与供应链门禁。浏览器只是表现层；会话、余额、RNG、轮次、派彩、特性状态、幂等与
恢复均由服务端负责。

当前源码交付元数据版本为 [`1.3.0`](VERSION)。该版本号必须与变更记录、Web package/lock、
Helm Chart 和发布示例一致；正式发布还需要创建同版本受保护 Tag、GitHub Release 说明，并保存
三个 OCI 制品各自的 SBOM、来源证明、签名和不可变摘要，不能只凭版本文件宣称已经发布。

## 正式生产主线

AWS 是本项目定义的唯一目标生产架构。macOS Docker Compose 只保留为开发、集成和端到端验收环境，
不得写入生产变更单，也不得作为多可用区、高可用、备份恢复或安全控制已经落地的证据。

```text
玩家浏览器
├── Web：Route 53 → CloudFront + AWS WAF → 私有 S3（OAC、按 release ID 隔离）
└── API：Route 53 → AWS WAF → ALB → Amazon EKS
    ├── rgs-server API（至少 3 个暖副本，跨 3 个可用区）
    ├── rgs-server Worker（至少 2 个暖副本，独立扩容）
    ├── Amazon RDS for PostgreSQL Multi-AZ 实例
    ├── ElastiCache Valkey（仅已验证身份的新意图共享准入）
    ├── 正式运营商钱包与幂等审计接收端
    ├── AWS Secrets Manager + 同步控制器 Pod Identity
    └── Prometheus Agent/ADOT → AMP；CloudWatch Logs；AMG
```

正式设计、实施顺序和运行责任分别见：

- [AWS 正式生产架构](docs/aws-production-architecture.md)
- [AWS 正式生产部署](docs/aws-production-deployment.md)
- [AWS 正式生产运维](docs/aws-production-operations.md)
- [通用 Kubernetes 多副本契约](docs/cluster-runtime-contract.md)
- [高并发性能与数据生命周期契约](docs/performance-optimization-contract.md)
- [DDoS 威胁模型、分层防护与演练边界](docs/ddos-threat-model.md)
- [通用 Helm 应用交付](deploy/cluster-production/README.md)
- [浏览器支持与验收矩阵](docs/browser-support-matrix.md)

## 交付边界

| 能力 | 仓库状态 | 正式上线责任 |
| --- | --- | --- |
| RGS、迁移器、Web 源码与测试 | 已实现 | 个人项目维护者维护并通过受保护门禁 |
| OCI 构建、摘要部署、SBOM、来源证明、签名契约 | 已实现 | 发布平台绑定 ECR 与 AWS/GitHub OIDC |
| RGS/Web 通用 Kubernetes Chart、HPA、PDB、NetworkPolicy、监控规则 | 已实现 | 采用方的平台责任角色提供目标集群并验证渲染结果 |
| 应用专属 AWS VPC、EKS、RDS、Valkey、ECR、S3/CloudFront、Regional WAF、IAM/KMS、监控与备份 IaC | 已实现 | 受保护 AWS 工作流评审并应用保存的 plan；目标账号仍需实时验收 |
| AWS Organizations/账号工厂、state/部署身份、DNS/ACM 证书、可选 Shield Advanced、组织级审计与安全账号 | 不在应用仓库的创建边界 | 采用方的 AWS 基础环境先提供并验收 |
| Web 运行素材完整性与权属分类门禁 | 已实现；部分素材的仓库内权属证据未验证 | 权利主体提供可审计授权或自主替换，并以仓库外逐文件哈希审批放行 |
| 正式钱包、运营商入口、审计接收端 | 仅定义协议契约 | 采用方指定的外部集成责任角色提供并完成一致性验收 |
| 正式 Secret 值、私钥与告警接收凭据 | Git 中禁止保存 | 采用方指定的安全与平台责任角色在目标账号受控注入并轮换 |
| `local-operator` | 仅本机验收工具 | 正式环境禁止部署或依赖 |

“仓库检查通过”只证明源码和交付契约成立，不等于某个 AWS 账号已经完成部署。正式上线必须同时
保存基础设施变更、Helm 渲染、镜像摘要、Secret 版本、告警演练和恢复演练证据。

仓库当前没有根级源码 `LICENSE`，不能把代码可见误解为已经授予复制、再分发或商业使用许可。
游戏素材的详细边界见 [Web 素材权属与发布门禁](web/ASSETS.md)；缺少仓库内权属证据的素材必须
在取得可审计授权或完成自主替换后才能对外宣称可商业分发或全部原创。
由于当前仓库公开，授权范围还必须覆盖现有源码/LFS 下载分发。取得授权前应由所有者
选择转私有或移除/替换素材。

## 源码目录

- `server/`：`rgs-server`、`rgs-migrator` 以及仅供本机验收的运营商/钱包工具；
- `web/`：只消费权威 RGS 结果的浏览器表现层；
- `infra/terraform/`：应用专属 AWS 基础设施、环境栈、落地区接口与失败闭合门禁；
- `deploy/cluster-production/`：可移植的 Kubernetes/Helm RGS、Web 与一次性 migrator 交付；
- `deploy/local-production/`：macOS 本地集成验收编排，不是正式生产环境；
- `deploy/observability/`：Prometheus 规则、Grafana 与日志采集契约；
- `deploy/supply-chain/`：秘密/漏洞扫描、SBOM、来源证明与镜像签名门禁；
- `../.github/workflows/`：源码一致性、供应链、AWS 基础设施与应用发布工作流；
- `docs/`：AWS 架构、部署、运维和应用级安全运行手册。

当前正式版本及兼容边界见 [变更记录](CHANGELOG.md)。
前端最低版本、跨引擎自动化与真实设备门禁见
[浏览器支持与验收矩阵](docs/browser-support-matrix.md)。

## AWS 发布流程摘要

正式发布必须由受保护流水线和独立审批驱动，不得从开发者电脑直接上传生产制品或长期凭据。

1. 采用方的 AWS 基础环境先提供账号、state/部署身份、DNS/ACM 证书、CloudFront global WAF 和组织级安全能力；
   应用 API Regional WAF 由本仓库 IaC 创建并在目标账号回读验收。
2. 受保护基础设施工作流评审并应用 `infra/terraform` 的保存 plan，生成不含秘密的应用交接对象；实时 add-on 和外部系统验收不得省略。
3. 受保护供应链流水线构建、扫描、签名并推送不可变镜像；AWS 应用流水线使用 GitHub Actions
   OIDC 换取短期角色，重新验证获批 digest 后部署，不在部署阶段按 tag 重建制品。
4. Web 以 `release ID` 为不可变前缀同步到私有 S3；release router 只把新会话切到新前缀，并保持
   已有会话的版本固定。
5. 先以独立迁移角色执行数据库迁移或验证，再按镜像 digest 执行 Helm 发布。
6. 通过真实启动、旋转、钱包未知结果恢复、共享准入故障、审计、跨可用区驱逐、告警和恢复验收后才放量。

通用 Chart 的最小命令如下；AWS 环境必须使用安全变更目录中的正式 values，而不是仓库示例：

```sh
make verify-deployment-contracts

helm lint --strict deploy/cluster-production/chart \
  -f /secure/change/slots-production-values.yaml

helm upgrade --install slots deploy/cluster-production/chart \
  --namespace slots-production --create-namespace \
  -f /secure/change/slots-production-values.yaml \
  --atomic --wait --timeout 15m
```

当前受保护 OCI 制品只交付 `linux/amd64`。数据库模式或数学定义变化不能走普通无停机滚动；Web
稳定路径必须由 S3/CloudFront 的发布前缀完成版本隔离。完整边界见
[多副本集群运行契约](docs/cluster-runtime-contract.md)。

## 本地集成验收

本机前置环境为 Docker Desktop、Go 1.26.6、Node.js 22.22.0 和 Git LFS 3.7.1。克隆后先执行
`git lfs install --local && git lfs pull`：

```sh
./deploy/local-production/bootstrap.sh
./deploy/local-production/up.sh
./deploy/local-production/verify.sh
```

本机入口：

- 运营入口与游戏：`https://slots.localhost:8443/operator/`
- RGS：`https://rgs.localhost:8443`
- Grafana：`http://127.0.0.1:3000`
- Prometheus：`http://127.0.0.1:9090`
- Alertmanager：`https://localhost:9093`，需要仓库外状态目录中的 Bearer token

本机运行状态和凭据位于仓库外的
`${XDG_DATA_HOME:-$HOME/.local/share}/slots-game-production/`，不得复制回 Git。停止服务使用
`down.sh`；只有明确需要销毁该本地实例持久卷时才执行 `destroy.sh`。完整说明见
[本地集成验收手册](deploy/local-production/README.md)。

## 源码与交付验证

```sh
make bootstrap
make verify
make test-postgres
make verify-deployment-contracts
./deploy/local-production/verify.sh
```

前端发布制品还要求仓库外的精确资源审批文件，并通过 BuildKit secret mount 注入：

```sh
RELEASE_ASSET_APPROVAL_FILE=/secure/release/asset-approval.json \
VITE_RGS_BASE_URL=https://rgs.example.com \
VITE_RGS_BET_OPTIONS_MINOR=10,20,50,100,200 \
VITE_RGS_DEFAULT_BET_MINOR=100 \
VITE_RGS_HOST_ORIGIN=https://slots.example.com \
WEB_RELEASE_VERSION=1.3.0 \
WEB_RELEASE_REVISION=0123456789abcdef0123456789abcdef01234567 \
  make build-web-release-image
```

## 不可破坏的生产约束

- RGS 是强一致交易边界，金额始终使用最小货币单位的规范十进制字符串，禁止浮点结算；
- 同一轮次使用稳定 `operationId` 执行一条原子钱包命令，未知结果只查询，不重复 RNG 或扣款；
- PostgreSQL、钱包、审计出口、定义审批或生产密钥不可用时，RGS 失败关闭并退出流量；
- 一次性启动码、Bearer token、私钥和 DSN 不进入浏览器存储、日志、Git 或镜像层；
- 迁移器与运行时使用独立数据库角色，运行时不能取得 DDL 权限；
- 正式镜像使用 digest，Web 资源由字节长度、SHA-256、发布清单和审批逐项绑定；
- `local-operator`、本机 PostgreSQL、Compose Prometheus/Grafana/Vector 均不得进入 AWS 生产环境。

完整系统说明见 [生产架构总览](docs/architecture.md)，当前实施边界见
[最终优化与加固状态矩阵](docs/final-optimization-hardening-status.md)，持续审计范围见
[前后端持续优化加固清单](docs/full-stack-hardening-checklist.md)，贡献和中文注释规范见
[CONTRIBUTING.md](CONTRIBUTING.md)。
