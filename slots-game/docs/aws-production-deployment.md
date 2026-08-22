# AWS 正式生产部署

状态：正式环境实施与验收手册

前置阅读：[AWS 正式生产架构](aws-production-architecture.md)

本文描述如何把本仓库交付到公司 AWS 正式环境。仓库已包含 `infra/terraform` 应用专属 IaC，
但源码存在不代表目标账号已经创建资源；开发者电脑也不得保存正式凭据。企业落地区先提供账号、
state/部署身份、DNS/证书/WAF 和组织级安全边界，再由受保护流水线评审并应用本仓库 IaC、不可变
制品与 Helm，最后以真实云资源和验收证据确认交付。

## 1. 部署原则

1. 正式与非正式环境使用不同 AWS 账号、KMS key、Secrets Manager secret、域名和数据存储。
2. GitHub Actions 通过 OIDC 换取短期 AWS 角色；禁止保存 `AWS_ACCESS_KEY_ID` 或长期访问密钥。
3. RGS 与 migrator 镜像使用 ECR manifest digest；Web 使用不可变 S3 `release ID` 前缀。
4. 数据库先由 DBA 建立分离角色，再执行 migrator；RGS 运行时永远不能取得 DDL 权限。
5. 先发布不可见制品，再迁移/验证，再部署工作负载，最后逐步放量。
6. AWS WAF 只承担边缘攻击面与传输层粗粒度限速；仓库已实现的 API + Valkey 共享准入负责按已
   验证运营商/会话的跨副本精确限流，并必须在目标集群完成多 Pod 与故障闭合验收。
7. 所有发布都可追溯到 Git commit、tag、OCI digest、Web 清单、定义摘要、Secret 版本和 IaC commit。
8. 普通回滚不得逆向执行数据库迁移，也不得让新旧数学定义随机混部。

## 2. 必填部署输入

平台团队应把下列非秘密标识写入变更单或环境配置仓库；秘密值只保存在 Secrets Manager。

| 类别 | 必填输入 | 验证要求 |
| --- | --- | --- |
| 发布身份 | Git commit、受保护 tag、`release ID`、审批单 | 三者不可复用；tag 必须指向该 commit |
| AWS 边界 | 组织 ID、正式账号 ID、主区域、灾备区域 | 正式与非正式账号分离 |
| 网络 | VPC、3 个应用子网、3 个数据子网、ALB 安全组、VPC endpoint | 不接受单可用区正式方案 |
| EKS | cluster 名、Kubernetes 版本、namespace、节点架构 | 满足 Chart 版本契约；当前仅 `linux/amd64` |
| 部署执行器 | VPC 内短生命周期 CodeBuild/GitHub runner、IAM role、审计日志 | 能访问私有 EKS endpoint；任务结束即销毁 |
| DNS/TLS | Web 域名、API 域名、Route 53 zone、ACM certificate ARN | CloudFront 证书在 `us-east-1`，ALB 证书在主区域；精确覆盖域名 |
| 边缘 | Web/API WAF Web ACL、ALB、CloudFront distribution | Web ACL 记录规则版本与容量 |
| Web | 私有 S3 bucket、OAC、release router、日志目标 | Block Public Access 开启；旧 release 可回退 |
| 镜像 | RGS/migrator ECR repository；可选 Web 容器回退 repository | tag immutable、增强扫描、生命周期已审批 |
| 数据库 | RDS endpoint、port、database、CA、参数组、备份策略 | Multi-AZ DB instance、`verify-full`、无公网访问 |
| 共享准入 | Valkey primary endpoint/port、数据子网 CIDR、A/B ACL 用户与 Secret 版本、TLS 根 CA | Multi-AZ、TLS/ACL、无公网访问；与 delivery 和 K8s Secret 一致 |
| 外部服务 | 正式运营商控制面、钱包、审计接收端、固定网段/受控 egress、根 CA | SSO/授权/审计与幂等/签名/超时恢复验收通过 |
| Secret | 六个职责隔离的 K8s Secret 名及对应 Secrets Manager version ARN | 职责隔离、最小权限、版本化，不回显值 |
| 可观测性 | AMP workspace、AMG workspace、CloudWatch log group、告警路由 | 规则同步、受控告警和日志管道演练通过 |
| 恢复 | Backup vault、跨账号 vault、灾备区域、KMS key | 保留期/Vault Lock/恢复目标经业务批准 |
| 平台证据 | 本仓库 IaC commit/保存 plan/apply 记录，以及落地区 IaC commit/策略扫描 | 必须绑定目标账号、区域和 state；不得用手工清单替代 |

以下任一项缺失都应阻断正式上线：正式运营商控制面、正式钱包与审计接收端、API + Valkey 共享
准入的多 Pod/故障验收、Web release pinning、RDS Multi-AZ、Secret 注入、告警最终路由、跨账号/
跨区域备份或恢复演练计划。

## 3. 平台基础设施顺序

### 3.1 账号、审计与身份

由企业落地区基础设施即代码先创建：

- 正式工作负载账号、日志归档账号和安全/备份账号；
- 组织 CloudTrail、AWS Config、GuardDuty/Security Hub/Inspector 接入与集中日志；
- 用途隔离的 KMS key、key policy 和跨账号恢复权限；
- GitHub OIDC provider，以及源码验证、镜像发布、Web 发布和正式部署四类最小角色；
- 可访问私有 EKS endpoint 的 VPC 内短生命周期部署执行器，例如 CodeBuild 托管 GitHub Actions
  runner；
- break-glass 角色、审批流程、短时会话、会话记录和使用告警。

OIDC trust policy 至少约束 GitHub 组织、仓库、受保护 ref/Environment 和 audience。拉取请求 job 不得
取得正式发布角色；发布角色也不得修改 IAM、CloudTrail、KMS key policy 或备份保管库锁。
Helm/kubectl 只能在上述受审计的一次性执行器中运行；不得为了让 GitHub 公网 runner 连接而临时把
EKS API endpoint 开放到 `0.0.0.0/0`，也不得把长期 kubeconfig 保存为 CI secret。

### 3.2 应用专属网络

落地区完成账号、state 和受保护 OIDC/执行器交接后，使用本仓库 `infra/terraform/environments`
对应环境的已保存 plan 创建应用专属 VPC、子网和安全组；apply 必须消费同一 workflow run 审核过的
plan，不能在部署阶段重新计划。源码或本地 `validate` 通过不等于目标账号已创建资源。

在 3 个可用区创建公有边缘、私有应用和隔离数据子网。正式 EKS 节点与 RDS 不分配公网地址；EKS
API endpoint 使用私有访问，或使用私有访问加受限公司出口 CIDR。按实际调用路径建立 ECR、S3、
STS/EKS 身份、Secrets Manager、KMS、CloudWatch 等 VPC endpoint。

若正式钱包/审计必须经公网访问，应在每个活动可用区提供 NAT Gateway，或使用经过单区故障验证的
等价高可用 egress；私有子网按本区出口路由，避免单 NAT 成为可用区单点。安全组、NetworkPolicy、
TLS、消息签名和域名/证书校验共同限制出口，NAT 本身不是访问授权。

现有 Helm NetworkPolicy 需要 PostgreSQL、钱包、共享 Valkey 和审计的 `/24` 或更窄 CIDR。RDS/Valkey
地址会在故障转移时变化，因此 values 应填写经审批的数据子网 CIDR，并叠加目标安全组只允许 EKS
RGS 节点路径访问指定端口。钱包或审计地址动态变化时，先经固定 egress gateway/NLB 收敛，不得放宽
到 `0.0.0.0/0`。

### 3.3 EKS 平台

本仓库 Terraform 创建 EKS 控制面、托管节点组和核心 AWS add-on 接口；部署应用前，平台仍至少要
安装并实时验收：

- 跨 3 个可用区的数据面，每区有 RGS 基线副本和一次滚动 surge 的余量；
- AWS Load Balancer Controller、CoreDNS、Metrics Server 和支持 NetworkPolicy 的 CNI；
- 公司批准的 Secrets Manager → 原生 Kubernetes Secret 同步控制器；
- Prometheus Operator 的 `ServiceMonitor`/`PrometheusRule` CRD；
- Prometheus Agent 或 ADOT、CloudWatch Observability EKS add-on；
- Pod Identity agent 和每个控制器/工作负载的独立 IAM role；
- 集群审计日志、控制面日志、节点补丁与升级、准入策略和镜像签名验证；
- PDB、topology spread、NetworkPolicy 和 Pod Security 设置的真实执行证据。

不要把 EKS 节点 IAM role 作为所有 Pod 的共享权限。应用 RGS 本身通常不需要直接调用 AWS API；
Secret 同步、日志、指标和负载均衡控制器分别使用自己的最小身份。

### 3.4 正式运营商控制面

正式管理员入口不是静态 Web，也不是 `local-operator`。运营商集成团队必须提供服务端控制面：

```text
运营管理员
→ 企业 SSO + MFA
→ RBAC/ABAC 与双人审批（按风险）
→ 正式运营商后端
→ 以用途限定私钥签名 /operator/v1/launches
→ RGS 返回一次性 launch 值
→ 运营商前端把该一次性值交给玩家游戏壳
```

该控制面必须记录管理员、租户、请求 ID、目的和结果，但不记录一次性值、签名私钥或完整请求体。
它使用运营商请求签名协议，不使用 `/readyz`、`/metrics` 的 operations Bearer。正式上线前必须对
SSO 会话、越权、重放、nonce、签名、一次性消费、审计和撤权进行正/负向验收。

## 4. ECR 与供应链

为 `rgs-runtime` 和 `rgs-migrator` 建立独立或有明确路径边界的 ECR repository。只有公司决定保留
非 AWS 集群/容器回退制品时，才需要可移植 Web 容器 repository；AWS 正式 Web 仍以 S3 release
为准。

- 开启 tag immutability 与 KMS 加密；
- 开启 Inspector enhanced scanning，并将发现送入安全账号；
- 配置生命周期，但保留所有仍可能运行或回退的 digest；
- 按灾备策略复制到灾备区域；
- 部署只引用 `repository@sha256:digest`，tag 仅作人类索引；
- 在准入或发布阶段验证 Cosign OIDC/AWS Signer 签名、SBOM 与 provenance。

受保护流水线先执行：

```sh
make bootstrap
make verify
make test-postgres
make verify-deployment-contracts
make verify-supply-chain-contract
```

随后按 [供应链手册](../deploy/supply-chain/README.md) 从全新 checkout 构建、扫描、签名和推送。
最终变更单记录 ECR 返回的 digest，不得手写、猜测或从本地 tag 推断。

## 5. 数据库准备

### 5.1 RDS 基线

创建 RDS for PostgreSQL Multi-AZ DB instance：

- 数据子网组至少覆盖 3 个可用区，实例无公网访问；
- 存储、快照和自动备份使用专用 KMS key；
- 设置业务批准的自动备份窗口、保留期、PITR 和事件订阅；
- 参数组强制 TLS，并按压测设置连接、日志、超时和审计参数；
- CloudWatch/RDS 指标覆盖 CPU、内存、存储、连接、锁、复制/故障转移事件和备份；
- 在首次放量前执行一次受控 failover，记录 RGS 恢复时间和经济请求恢复行为。

RDS Proxy 默认关闭。只有完成
[架构文档中的连接固定验证](aws-production-architecture.md#6-数据库选择与连接边界)后，才能作为
单独变更启用。

### 5.2 数据库角色

DBA 使用短期受控管理会话创建：

- `rgs_migrator`：只用于 one-shot Job，拥有受管 schema 的迁移权限；
- `rgs_runtime`：只拥有运行所需 DML/sequence 权限，不拥有对象、DDL、`TRUNCATE` 或迁移账本写
  权限；
- 可选只读备份/核验角色：不能被应用 Pod 使用。

两个 DSN 分别存入 Secrets Manager，必须包含精确 `sslmode=verify-full` 与受信 CA 路径约定。完整
顺序与权限测试见 [数据库迁移手册](database-migrations.md)。

## 6. Secret 与证书准备

现有通用 Chart 消费六个职责隔离的 Kubernetes Secret：

| Chart 引用 | Secrets Manager 内容边界 |
| --- | --- |
| `externalSecrets.runtimeDatabase` | 仅 `rgs_runtime` DSN 与数据库 CA |
| `externalSecrets.migratorDatabase` | 仅 `rgs_migrator` DSN 与所需 CA |
| `externalSecrets.operationsBearer` | 仅 operations Bearer，供 RGS 与 ServiceMonitor 使用 |
| `externalSecrets.sharedAdmission` | 仅 API 共享 Valkey 的 ACL password、键摘要 HMAC 密钥与精确 TLS 根 CA；不向 Worker 授权 |
| `externalSecrets.apiRuntimeAssets` | API 的 operators v2、定义、审批、公钥、launch HMAC、钱包/运营签名材料与 trust bundle |
| `externalSecrets.workerRuntimeAssets` | Worker 的 operators 钱包视图、定义、审批、公钥、钱包请求/响应、outbox 材料与 trust bundle；不含 launch HMAC、访问令牌签发私钥、运营请求验证材料或运营响应签名私钥 |

AWS 适配层必须用经审批的同步控制器生成版本化、`immutable: true` 的原生 Secret。当前 Chart
只引用已经存在的 Secret，也没有 ASCP/Secrets Store CSI volume；创建 Secrets Manager 条目或
安装 CSI 驱动本身都不会满足该契约。若未来选择 ASCP 直接挂载，必须先修改 Chart 并重新验证
ServiceMonitor Bearer、文件权限和轮换行为。发布编排必须等待同步完成，并验证：

- 六个 Kubernetes Secret 名互不相同；
- operations Bearer 的 Secret 不含 DSN 或私钥；
- API/Worker 运行资产对象分离，Worker 投影和进程都不取得 launch、访问令牌或运营响应签名私钥；
- Pod Identity/IAM policy 只能读取本环境、该职责的指定 secret version；
- 文件权限、固定 UID/GID、键名和挂载路径与 Chart 一致；
- Secret 内容不会出现在渲染 YAML、事件、日志、命令行或 CI artifact；
- 轮换通过创建新版本名称、更新 values 和协调滚动完成，不原地覆盖。

ALB 与 CloudFront 的公开证书由 ACM 管理。数据库、钱包和审计的私有 CA 作为精确 trust bundle
注入，不得把公司所有内部根或 CA 私钥挂入 Pod。

## 7. Web 发布到 S3 与 CloudFront

正式 AWS Web 不以 EKS Nginx Pod 为公共入口。通用 Chart 中的 Web workload 只用于可移植集群或
受控回退；AWS overlay 必须关闭它的 Deployment、Service 和 Ingress，避免同一域名出现两个权威
源站。

发布流水线按以下顺序执行：

1. 从受保护 tag 运行 `supply-chain-release.yml`，用精确 API/Web origin 和外部素材审批文件构建
   `web-runtime`；等待最终 Environment 后，工作流会在 candidate 与最终 tag 每次 push 紧前重新检查
   审批 `expiresAt`，过期即停止；
2. 按 bundle 的 artifact ID、manifest/checksum SHA-256 做离线复核，并验证最终 OCI digest 的 Cosign
   身份、provenance、SBOM attestation 与 `ASSET_APPROVAL_METADATA_SHA256`。不得把 tag 或工作区
   `web/dist` 当成交付输入；
3. 按已验证的 `repository@sha256:...` 拉取镜像。使用
   `deploy/supply-chain/extract-aws-web-static-root.sh` 只创建文件系统视图，从同一 digest 提取
   `/usr/share/nginx/html` 与 `/etc/nginx/conf.d/default.conf`；脚本拒绝 tag，并把静态根中的每个普通
   文件与 `release-manifest.json` 双向对照，任何额外、缺失、软链接、大小或 SHA-256 漂移都失败；
4. 确认 `releases/<release-id>/` 不存在，随后只写一次上传上一步的新目录；对 HTML 使用短缓存/不缓存
   策略，对内容哈希和 release 隔离对象使用长缓存；
5. 把同一 digest 提取出的唯一 CSP 写入 CloudFront Response Headers Policy，核对 AWS 回读值与
   `cloudfront-content-security-policy.txt` 完全一致，并把 bundle/job output 中的
   `CONFIGURATION_SHA256`、`CLOUDFRONT_CSP_SHA256`、OCI digest 和 policy ID/ETag 归档在同一变更证据；
6. 从 CloudFront 预览路由执行真实浏览器、CORS、CSP、压缩、Range 和错误页验收；
7. 更新 release router，把新浏览器固定到新 release；旧浏览器继续使用旧 release；
8. 观察稳定窗口后再结束回退保留期，不执行覆盖式 `sync --delete`。

提取与上传动作的最小形态如下；变量由受保护流水线注入，命令不得在开发者终端使用正式角色。
`SLOTS_WEB_IMAGE` 必须是不带 tag/digest 的仓库，`SLOTS_WEB_DIGEST` 必须来自已签名且已反向验证的
最终发布结果，`SLOTS_CONFIGURATION_SHA256` 必须与离线复核的 bundle/job output 完全相同：

```sh
set -euo pipefail

test -n "${SLOTS_WEB_BUCKET:?}"
test -n "${SLOTS_WEB_IMAGE:?}"
printf '%s\n' "${SLOTS_WEB_DIGEST:?}" | grep -Eq '^sha256:[0-9a-f]{64}$'
printf '%s\n' "${SLOTS_CONFIGURATION_SHA256:?}" | grep -Eq '^[0-9a-f]{64}$'

SLOTS_EXTRACTED_STATIC_ROOT="$RUNNER_TEMP/slots-aws-web-static-root"
SLOTS_WEB_DELIVERY_EVIDENCE="$RUNNER_TEMP/slots-aws-web-delivery-evidence"
sh deploy/supply-chain/extract-aws-web-static-root.sh \
  "$SLOTS_WEB_IMAGE@$SLOTS_WEB_DIGEST" \
  "$SLOTS_EXTRACTED_STATIC_ROOT" \
  "$SLOTS_WEB_DELIVERY_EVIDENCE" \
  "$SLOTS_CONFIGURATION_SHA256"

SLOTS_RELEASE_ID=$(jq -er '.releaseId' \
  "$SLOTS_EXTRACTED_STATIC_ROOT/release-manifest.json")

SLOTS_EXISTING_OBJECT_COUNT=$(aws s3api list-objects-v2 \
  --bucket "$SLOTS_WEB_BUCKET" \
  --prefix "releases/$SLOTS_RELEASE_ID/" \
  --max-keys 1 \
  --query 'length(Contents || `[]`)' \
  --output text)
if [ "$SLOTS_EXISTING_OBJECT_COUNT" != 0 ]; then
  echo '目标 release 前缀已存在，拒绝覆盖或合并不可变 Web 发布目录' >&2
  exit 1
fi

aws s3 sync "$SLOTS_EXTRACTED_STATIC_ROOT/" \
  "s3://$SLOTS_WEB_BUCKET/releases/$SLOTS_RELEASE_ID/" \
  --no-follow-symlinks \
  --only-show-errors
```

`extract-aws-web-static-root.sh` 不执行 `docker pull` 或 Cosign 验证：这两步必须由受保护 AWS 发布
流水线先对最终 digest 完成，防止脚本在 tag 漂移后隐式取回另一镜像。脚本生成的
`aws-web-delivery.env` 只记录 digest、release identity、`CONFIGURATION_SHA256` 与 CSP SHA-256；它不是
签名替代品。CloudFront policy 的 CSP 必须从同目录的 `cloudfront-content-security-policy.txt` 读取，
禁止从手写模板、旧 release 或另一组 origin 生成。

列表结果必须精确为 `0` 才可上传；流水线应将此检查实现为失败关闭，而不是依靠人工查看。
`infra/terraform/modules/web-edge` 已实现 CloudFront KeyValueStore 与 Function release router；具体
distribution ID、KVS/函数 ARN 只能来自目标账号中已应用 state 的 delivery 输出，不能在说明书中
虚构。当前稳定 `/assets/...` 路径的版本固定要求见
[Web 版本隔离](aws-production-architecture.md#7-web-版本隔离)。

## 8. 指标、日志与告警

### 8.1 指标

RGS `/metrics` 位于私有 operations Service，并要求文件 Bearer。正式基线使用 Prometheus
Operator 管理的 Prometheus Agent 或等价 ADOT 配置读取同一个最小 Secret，抓取
`ServiceMonitor` 后以 SigV4 `remote_write` 到 AMP。

AMP 托管 scraper 默认身份模式不能自动证明它携带本应用的自定义 operations Bearer，因此在完成
真实认证抓取验证前，不得直接替换集群内 Agent。

Prometheus Agent 不在本地求值规则。发布平台必须把 Chart 渲染出的同一组规则同步到 AMP rule
group namespace，或提供经验证的集群内规则求值器；随后核对规则数量、表达式、namespace/job
边界和最终 Alertmanager 路由。只看到 AMP 中有样本，不等于告警闭环成立。

nonce 重放必须保留固定 `security_event=nonce_replay` 的 WARN 安全事件、无标签
`rgs_auth_replays_total` 计数器与 `SlotsRGSAuthReplay` 告警。告警表达式必须保持为
`increase(rgs_auth_replays_total[5m]) > 0`；日志和告警标签不得携带 nonce、运营商、密钥、
玩家、会话或请求标识。平台必须通过受控重放演练证明事件、指标、规则求值和最终路由全链路成立。

### 8.2 日志

CloudWatch Observability EKS add-on 采集容器 stdout/stderr。平台配置必须：

- 显式设置 `otelContainerInsights.enabled=true` 并验证 add-on 为 `ACTIVE`；不能把“已安装”误当作
  OpenTelemetry 日志管道已经启用；
- 在应用输出与采集器两层删除 token、签名、DSN、正文、查询串、玩家/钱包敏感标识；
- 设置明确保留期、KMS key、订阅过滤器和跨账号归档；
- 对采集器停止、读取错误、丢弃、限流、积压和归档失败告警；
- 禁止把所有 Pod label 无审查地作为高基数长期索引；
- 通过受控敏感样本测试证明脱敏，而不是只证明日志可搜索。

告警、仪表盘和上线证据见 [AWS 正式生产运维](aws-production-operations.md)。

## 9. RGS 与 migrator 发布

### 9.1 values 生成与预检

正式 values 由发布平台写入受限变更目录，不提交秘密，也不使用仓库示例摘要。至少确认：

- RGS/migrator 使用 ECR digest；
- AWS overlay 已关闭 EKS Web workload/Ingress；
- API Ingress 使用 `alb` class、HTTPS、正确 ACM/WAF/target-type 注解；
- API/Web origin 与已构建 Web 完全一致；
- 六个 Secret、网络 selector、数据子网/钱包/Valkey/审计 CIDR 和端口准确；
- `externalControls` 分别填写实际 WAF 边缘保护、Valkey 已验证身份共享准入、TLS、日志和 Web 版本隔离提供方；
- API/Worker Deployment 不渲染 `spec.replicas`，三个/两个暖副本下限分别由 HPA `minReplicas` 控制；
- RGS API/Worker 各自的 HPA、PDB、资源、连接预算，与 RDS、钱包、审计容量评审一致；
- `release.definitionIdentity` 给出候选的 `gameID/version/sha256`，并与已批准定义证据一致；
- AMP 规则同步和日志管道已经就绪。

在 VPC 内一次性部署执行器中执行：

```sh
make verify-deployment-contracts

helm lint --strict deploy/cluster-production/chart \
  -f /secure/change/slots-production-values.yaml

helm template slots deploy/cluster-production/chart \
  --namespace slots-production \
  -f /secure/change/slots-production-values.yaml \
  > /secure/change/slots-production-rendered.yaml
```

对渲染文件执行 schema、策略、镜像签名、Secret 引用、权限与 diff 评审。`rendered.yaml` 只作证据，
不得绕过 Helm hook 直接 `kubectl apply`。

### 9.2 首次安装

```sh
helm upgrade --install slots deploy/cluster-production/chart \
  --namespace slots-production --create-namespace \
  -f /secure/change/slots-production-values.yaml \
  --atomic --wait --wait-for-jobs --timeout 20m
```

首次安装的 pre-install hook 执行 migrator `up`。Job 成功后检查迁移报告、角色最小权限、RGS
`/readyz`、全部 Pod 拓扑分布和 operations 端口隔离，再为 ALB target group 开放测试流量。

### 9.3 普通升级

只有数据库 schema 清单和数学定义身份完全相同的版本允许普通滚动。pre-upgrade hook 只执行
`verify`；任何差异都必须在 Deployment 变化前阻断。

`release.definitionIdentity` 的 `gameID`、`version`、`sha256` 同时写入 API/Worker Pod template
`slots-game.io/definition-*` annotation 和 `RGS_EXPECTED_DEFINITION_*`。进程先验证定义签名并
加载定义，再将实际 `gameID/version/hash` 逐项与期望值比对；任一不符即拒绝启动。

AWS 应用部署工作流必须在 Helm 前读取现网 API 与 Worker Deployment，把它们的三元组与
候选值比较；Helm Chart 再使用 `lookup` 执行独立的第二道检查。仅两个 Deployment 均不存在
时才视为首次安装；仅存在一方、annotation 缺失、API/Worker 不一致或候选三元组变化
都必须在 Helm upgrade 前失败。`release.compatibilityClass=same-schema-and-definition` 只是必填声明与
审计标签，不得代替工作流、Helm 现网检查或进程加载后检查。

含 schema 变化时，执行维护窗口或已独立验证的扩展—兼容—收缩流程；含数学定义变化时，按入口
分群并排空旧会话，或先实现多定义注册协议。禁止关闭精确清单检查来制造“无停机”。

## 10. 分阶段放量

建议的正式流量阶段如下，每阶段都有明确观察窗口和停止条件：

1. `0%`：只允许合成探针和公司验收身份；验证迁移、Secret、监控、日志与网络策略。
2. 内部白名单：执行真实启动、旋转、展示 ACK、钱包未知结果、审计积压和 Pod 驱逐。
3. 小比例：由 Route 53/ALB/运营商入口按已验证身份分群，不按随机请求拆散会话。
4. 逐级扩大：每级检查错误率、延迟、钱包未知、outbox、DB pool、ALB target 和容量拒绝。
5. `100%`：观察完整业务高峰后关闭旧应用流量，但保留旧 OCI/Web release 与数据库恢复点。

任一阶段出现经济完整性隔离、重复/未知钱包操作持续增长、审计无法持久化、RGS 未就绪、数据库
连接饱和、规则未求值或日志链路丢弃，立即停止放量并按运行手册处理。

## 11. 上线验收清单

- [ ] 正式基础设施 IaC plan/apply、策略扫描和审批记录可追溯。
- [ ] CloudFront 只能通过 OAC 读私有 S3，S3 Block Public Access 开启。
- [ ] S3 静态根来自已验证 OCI digest，逐文件通过 `release-manifest.json`；没有从工作区 dist 直传。
- [ ] CloudFront CSP 与同一 digest 提取值逐字节一致，且变更证据绑定 `CONFIGURATION_SHA256`。
- [ ] 两个并发 Web release 的真实浏览器追踪证明会话没有跨版本资源。
- [ ] WAF、ALB、TLS、正文上限和传输层限速通过正/负向测试。
- [ ] API + Valkey 的已验证身份共享准入通过多 Pod 压测和 Valkey 故障闭合演练；未信任 header 不影响 key。
- [ ] 正式运营商控制面完成 SSO/MFA、授权、管理审计和签名一次性 launch 验收；浏览器不持有管理凭据。
- [ ] RGS API 至少 3 个暖副本跨 3 区，Worker 至少 2 副本；暖副本仅由 HPA `minReplicas` 管理，Deployment 无 `spec.replicas`，两类角色的 HPA/PDB/NetworkPolicy/优雅关闭按各自契约真实生效。
- [ ] API/Worker 运行资产 Secret 分离，Worker Pod 不存在 launch、访问令牌或运营响应签名私钥的投影，进程也不加载它们。
- [ ] 现网、候选 Pod template 与 API/Worker 进程实际加载定义的 `gameID/version/sha256` 完全一致。
- [ ] operations Service 不可公网访问，未认证 `/readyz`、`/metrics` 返回 401。
- [ ] RDS Multi-AZ、运行/迁移角色、`verify-full`、PITR、事件订阅与故障转移演练通过。
- [ ] 正式钱包稳定 `operationId`、签名响应、状态查询、未知结果恢复和对账通过。
- [ ] 正式审计接收端持久化后响应、HMAC/mTLS、`eventId` 去重与积压告警通过。
- [ ] AMP 收到所有 Pod 指标，规则已求值，受控告警到达最终值班人并完成闭环。
- [ ] 受控 nonce 重放演练只产生固定脱敏安全事件和无标签计数，`SlotsRGSAuthReplay` 在五分钟窗口内到达最终安全路由。
- [ ] CloudWatch 日志脱敏、保留、归档和采集器故障告警通过。
- [ ] ECR digest、签名、SBOM、provenance、Inspector 扫描和部署准入一致。
- [ ] 跨账号/跨区域备份存在，隔离恢复演练计划和负责人已经批准。
- [ ] `local-operator`、本机 PostgreSQL 和 Compose 观测组件未出现在正式 namespace/镜像清单。

## 12. 发布证据包

每次正式发布至少归档：

- 源 commit/tag、GitHub workflow run、评审人与 Environment 审批；
- Go/前端/PostgreSQL/配置/浏览器测试、秘密/漏洞扫描结果；
- RGS/migrator OCI digest、Web OCI digest/release ID、资源清单、SBOM、provenance、签名；
- Web `CONFIGURATION_SHA256`、规范化素材审批元数据摘要/有效期、CloudFront CSP SHA-256 与 policy ID/ETag；
- 游戏定义版本/哈希、定义审批、运营商/钱包一致性引用；
- 本仓库应用 IaC 与企业落地区 IaC commit、保存 plan/apply 记录、Helm values 非秘密摘要、rendered manifest 与 diff；
- Secret version ARN 和证书 ARN，仅保存标识，不保存值；
- 迁移报告、部署事件、放量曲线、告警/日志/故障演练结果；
- 回退决定点、数据库恢复点和发布后观察结论。

## 13. 回退边界

| 故障 | 安全动作 | 禁止动作 |
| --- | --- | --- |
| Web 资源/显示故障 | release router 切回旧不可变前缀 | 覆盖当前 S3 路径或只删 CloudFront cache |
| 同 schema/定义的 RGS 回归 | 按旧 OCI digest 滚动回退，保持同一数据库 | 重跑 RNG、创建新 round 或改写迁移账本 |
| schema 迁移故障 | 停止放量，按已评审数据库恢复/前向修复方案 | 自动执行未经验证的 down migration |
| 钱包结果未知 | 查询同一 `operationId`，保持恢复状态 | 用新 operation ID 重复扣款/派彩 |
| 单可用区故障 | 让 ALB/EKS/RDS 多区机制接管并记录恢复时间 | 手工删除健康副本或放宽安全组 |
| 区域故障 | 宣布灾难事件，按跨区域恢复 runbook 建立隔离环境 | 未对账即双区域同时接受写入 |

日常运行、恢复目标与演练方法见 [AWS 正式生产运维](aws-production-operations.md)。

## 14. 官方参考

- [GitHub OIDC 与 AWS IAM OIDC provider](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_oidc.html)
- [CodeBuild 托管 GitHub Actions runner](https://docs.aws.amazon.com/codebuild/latest/userguide/action-runner-overview.html)
- [AWS Load Balancer Controller](https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html)
- [EKS 私有集群要求](https://docs.aws.amazon.com/eks/latest/userguide/private-clusters.html)
- [EKS 使用 Secrets Manager](https://docs.aws.amazon.com/eks/latest/userguide/manage-secrets.html)
- [ECR tag immutability](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-tag-mutability.html)
- [ECR enhanced scanning](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning-enhanced.html)
- [ECR image signing](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-signing.html)
- [CloudFront HTTPS 与 ACM 证书区域要求](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html)
- [Amazon Managed Grafana 监控 EKS](https://docs.aws.amazon.com/grafana/latest/userguide/solution-eks.html)
- [CloudWatch OTel EKS 容器日志](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/container-insights-eks-otel-logs.html)
