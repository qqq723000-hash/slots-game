# 公司集群生产部署

本目录交付可审计的 Kubernetes/Helm 生产部署源码，只包含 RGS API、静态 Web、一次性数据库迁移器及它们的最小运行配置。它不会部署 `local-operator`、本机 PostgreSQL、演示钱包或本机观测组件；数据库、钱包、审计接收端、入口网关、密钥系统和监控系统都必须由公司平台提供。

## 横向扩展结论

RGS 的业务状态不依赖 Pod 本地磁盘或内存会话，可以运行多个副本：

- 会话、轮次、nonce、launch code 和审计 outbox 全部持久化到外部 PostgreSQL。
- 会话与轮次更新使用数据库行锁；并发恢复允许多个副本看见同一轮次，实际资金操作由持久租约和钱包幂等键保护。
- outbox 使用 `FOR UPDATE SKIP LOCKED`、数据库时钟、唯一租约令牌及带围栏的完成确认，因此多个副本可以共同消费。
- 安全凭据清理使用 `SKIP LOCKED`，多个副本同时运行不会重复破坏数据。
- 迁移器使用 PostgreSQL advisory lock；即使发布系统误触发两个 Job，也只会串行迁移。
- 进程收到 `SIGTERM` 后会停止两个 HTTP listener，等待后台恢复/outbox 工作器退出，并在超时后失败闭合。

有一个必须由平台补齐的边界：RGS 内建限流器是进程级防护，副本扩容会增加集群总额度。源码本身已经明确禁止把它冒充全局限流。上线前必须在 API Gateway/WAF 实施按运营商、客户端身份和攻击面聚合的跨副本限流，并在 `externalControls.globalRateLimitProvider` 写入真实提供方；这项值只是发布门禁和审计证据，不会伪造一个全局限流实现。

原生滚动还有严格的兼容边界：只有新旧二进制使用完全相同的数据库模式清单和数学定义身份时才允许执行。当前旧二进制会拒绝带未来迁移的账本，新二进制会拒绝缺失迁移的账本；每个进程也只加载一个获批数学定义。因此，包含数据库迁移或数学定义变更的版本不能使用本 Chart 做普通无停机升级。必须先进入维护窗口完成协调切换，或另行实现并验证“扩展—双版本兼容—收缩”、按定义分群排空或多定义注册表协议。`release.compatibilityClass=same-schema-and-definition` 是强制发布声明和审计标签，不是自动兼容性证明；发布评审必须结合镜像、迁移清单和定义摘要验证该声明。完整边界见 [`docs/cluster-runtime-contract.md`](../../docs/cluster-runtime-contract.md)。

## 部署能力

Chart 默认提供：

- RGS 与 Web 各三个副本，`autoscaling/v2` HPA，CPU/内存双指标。
- 两个 PDB、零不可用滚动发布、五秒摘流窗口和应用级优雅关闭；RGS 终止宽限必须覆盖摘流、应用关闭及额外五秒调度余量。
- 三可用区严格均衡、主机级拓扑分散和 Pod 反亲和偏好。
- 非 root、只读根文件系统、`RuntimeDefault` seccomp、禁止提权、删除全部 Linux capabilities、禁用 ServiceAccount token 和 service links。
- 默认双向拒绝 NetworkPolicy；Web 无运行时出口，RGS 仅能访问 DNS、外部 PostgreSQL、钱包和审计接收端的明确 `/24` 或更窄 IPv4 CIDR 与端口。
- 公网 API Service、私有 operations Service、Web Service，以及两个强制 TLS Ingress。
- 带文件 Bearer 的 `ServiceMonitor` 与使用现有 RGS 有界指标的 `PrometheusRule`；operations 端口不会进入公网 Ingress，规则固定选择 `job="slots-rgs"` 和当前发布 namespace。
- `pre-install,pre-upgrade` 数据库 Job：首次安装执行 `up`，原生滚动升级只执行 `verify`，从机制上阻止升级 hook 偷跑不兼容迁移。失败会阻断 Helm 发布并保留失败 Job 与其最小 NetworkPolicy 供排障；下次重试先清理同名失败现场，成功后 post hook 清理临时策略，避免历史 Job 无限累积。
- 所有镜像只接受 `repository@sha256:digest`，不接受可变 tag。

## 前置条件

部署前必须具备：

1. Kubernetes 1.30 或更高版本、Helm 3.14 或更高版本。
2. 支持 `networking.k8s.io/v1` 且真正执行 ingress/egress 规则的 CNI。
3. 至少三个带 `topology.kubernetes.io/zone` 标签的 Linux/AMD64 可用区节点。当前受保护发布链只签名单平台 `linux/amd64` OCI manifest，Chart 会拒绝调度到 ARM64。
4. Metrics Server 或等价资源指标源，用于 HPA。
5. Prometheus Operator 的 `ServiceMonitor`、`PrometheusRule` CRD，匹配 `monitoring.ruleLabels` 的规则发现策略，以及 Prometheus 读取目标 namespace 中 operations token Secret 的 RBAC。
6. 支持 `networking.k8s.io/v1` Ingress、TLS Secret、强制 HTTP 到 HTTPS 跳转和公司全局限流的入口网关。
7. 外部高可用 PostgreSQL、外部钱包和外部幂等审计接收端；三者的稳定出口 CIDR 必须已由网络团队确认。
8. 外部密钥系统同步出的原生 Kubernetes Secret。Chart 不生成、复制或回显任何秘密。
9. 公司节点级日志管道：采集容器 stdout/stderr、在节点侧脱敏、有界缓冲、集中归档，并对丢弃、积压和归档失败告警。Chart 不部署本机 Vector，也不会伪造这项平台能力。

## 镜像构建契约

RGS 与迁移器必须从本目录的集群镜像文件构建。该镜像包含无 shell 的 distroless 运行时、受限文件到环境变量的 `/secret-env` 和认证就绪探针 `/service-probe`：

```sh
docker buildx build --platform linux/amd64 \
  -f deploy/cluster-production/Dockerfile.services \
  --target rgs-runtime \
  --build-arg OCI_IMAGE_CREATED=2026-08-16T00:00:00Z \
  --build-arg OCI_IMAGE_REVISION=<git-commit> \
  --build-arg OCI_IMAGE_SOURCE=<repository-url> \
  --build-arg OCI_IMAGE_VERSION=<release-version> \
  --provenance=mode=max --sbom=true \
  --tag <registry>/slots/rgs-runtime:<release-version> --push .

docker buildx build --platform linux/amd64 \
  -f deploy/cluster-production/Dockerfile.services \
  --target rgs-migrator \
  --build-arg OCI_IMAGE_CREATED=2026-08-16T00:00:00Z \
  --build-arg OCI_IMAGE_REVISION=<git-commit> \
  --build-arg OCI_IMAGE_SOURCE=<repository-url> \
  --build-arg OCI_IMAGE_VERSION=<release-version> \
  --provenance=mode=max --sbom=true \
  --tag <registry>/slots/rgs-migrator:<release-version> --push .
```

仓库的受保护发布工作流也固定使用该 Dockerfile、这两个 target 与 `linux/amd64`，生成单 manifest 签名候选。当前不能把本地多架构构建冒充正式交付；未来支持 ARM64 时必须先扩展 release bundle、逐平台 SBOM/provenance 与签名验证协议，再放宽 `scheduling.nodeSelector`。

Web 必须用 [`deploy/web/Dockerfile`](../web/Dockerfile) 的 `runtime` target 构建，并传入与 `ingress.apiHost`、`ingress.webHost` 完全相同的公开 origin 及外部素材批准 Secret。Chart 无法在运行时改写已经编译进 Web 的 RGS URL 或 CSP；把错误域名的镜像交给 Chart 会被视为发布物错误，而不是运行时配置问题。

当前 Web 的 JS/CSS 构建产物使用内容哈希，但 `public` 中仍有稳定路径素材。普通 RollingUpdate 会让新旧 Pod 在同一 Service 后短时共存，浏览器可能跨版本取得这些稳定路径，因此 Web 升级还必须由平台蓝绿发布或带 release ID 前缀的版本隔离 CDN 承担；在所有稳定路径完成内容寻址前，不得把原生滚动参数当成 Web 无串版证明。`externalControls.webVersionIsolationProvider` 是必填机器门禁，并会写入 Web Deployment、Pod 与 Ingress 审计标签；它必须填写经过发布评审的真实蓝绿/CDN 提供方，不能使用占位值。RGS Deployment 也只有在数据库模式与数学定义完全相同时才能正常滚动，Web Deployment 中保留的滚动参数只用于具备上述版本隔离能力的平台。若公司发布平台尚未提供版本隔离，本项是上线阻断，不得以手工观察替代。

镜像推送后，把注册表返回的 manifest digest 写入 `values`。禁止使用示例中的重复数字摘要部署真实环境。

## 外部 Secret 契约

所有 Secret 都必须专用于本服务、使用版本化名称、在发布前创建，并建议设置 `immutable: true`。Secret volume 以 `0440` 挂载给固定非 root 组；数据库 DSN 不进入 PodSpec 环境变量。

| values 路径 | 权限与内容 |
| --- | --- |
| `externalSecrets.runtimeDatabase.name` | 仅供 `rgs_runtime` 使用的 DSN；`urlKey` 指向单行 URL。生产 URL 必须恰好包含 `sslmode=verify-full`，可引用同一 Secret 中挂载到 `/run/rgs/database/` 的 CA 文件。 |
| `externalSecrets.migratorDatabase.name` | 仅供 `rgs_migrator` 使用的 DSN；不得复用 runtime 角色。迁移器会验证角色属性和 runtime 最小权限。 |
| `externalSecrets.operationsBearer.name` | 只包含 operations Bearer；RGS 以单文件只读挂载，Prometheus RBAC 也只能读取这个 Secret，不得取得任何签名私钥。 |
| `externalSecrets.runtimeAssets.name` | 定义、定义批准、公钥、operators v2 文档、launch HMAC、outbox HMAC/Bearer/根 CA、组合系统信任包，以及 operators 文档引用的钱包/运营商密钥。 |
| `ingress.apiTLSSecretName` / `webTLSSecretName` | 由 cert-manager 或公司证书系统管理的两个独立 TLS Secret。 |

四个 Secret 名称必须互不相同：runtime 数据库、迁移数据库、operations Bearer、运行签名材料。`runtimeAssets.keys` 把固定 Secret key 映射为固定容器路径。`additionalItems` 是唯一允许注入 operators v2 所引用密钥的白名单；`path` 可以使用 `keys/name.pem`，但禁止绝对路径、隐藏段和 `..`。一个最小 operators v2 通常至少需要访问令牌签名密钥、运营商请求验证公钥、RGS 响应签名密钥、钱包请求签名密钥和钱包响应验证公钥。

`trust-bundle.pem` 必须是公司审核的组合 CA bundle，既包含系统公开根，也包含钱包私有 PKI 根。RGS 通过 `SSL_CERT_FILE` 使用它。审计接收端另用 `outbox-root-ca.pem` 精确建池；若开启 `audit.mtls.enabled`，还必须在同一 Secret 提供独立客户端证书和私钥。

Secret 内容更新不会自动让已经启动的进程热加载。轮换时创建新版本 Secret、更新 values 中的名称并滚动发布；不要原地覆盖同名 Secret。旧验证公钥必须按协议重叠窗口保留，确认所有副本和外部方完成切换后再删除。

## 网络与容量规划

标准 Kubernetes NetworkPolicy 不能可靠按 DNS 名称限制外部流量，因此本 Chart 要求分别填写 PostgreSQL、钱包和审计接收端的 IPv4 CIDR。每项只接受 `/24` 至 `/32`，拒绝空数组和 `0.0.0.0/0`。若供应商地址动态变化，应先通过公司 egress gateway 固定出口目标，再把 gateway 的专用网段写入 values；不要临时放宽到全网。

`networkPolicy.ingressController` 和 `monitoring` 同时使用 namespaceSelector 与 podSelector，两者是 AND 关系。必须使用平台真实、不可由业务 namespace 自行伪造的标签。DNS selector 也必须匹配集群实际 CoreDNS 标签。

`ingress.tlsRedirectAnnotationKey` 和 `tlsRedirectAnnotationValue` 会强制写入两个 Ingress；必须填写当前入口实现真实支持的重定向策略键值，并在 `externalControls.tlsEnforcementProvider` 记录平台策略名称。示例使用 ingress-nginx 的 `force-ssl-redirect=true`。变更审批必须确认该注解没有被控制器忽略，不能只因 TLS Secret 存在就宣称已禁用明文 HTTP。

## 日志与告警责任

RGS 使用结构化 JSON 写 stdout/stderr；Web 由容器入口输出访问与错误日志。集群生产不部署本机 Vector，日志可靠性由公司节点级管道负责。`externalControls.logPipelineProvider` 必须填写已审批的真实提供方，并写入 RGS/Web Deployment 与 Pod 标签。平台验收必须证明敏感字段脱敏、磁盘/内存缓冲有界、背压时有明确丢弃策略、集中归档保留期，以及采集停止、积压、丢弃和归档失败告警；只看到日志搜索页面不等于这条链路已闭环。

Chart 内置十条 `PrometheusRule`，覆盖指标目标消失或下线、RGS 未就绪、5xx 比例、并发容量拒绝、钱包未知结果、完整性隔离、审计 outbox 延迟/租约冲突和数据库池饱和/等待。规则只引用后端源码实际暴露的有界指标，并通过 operations Service 的 `slots-game.io/metrics-job=slots-rgs` 固定 `job`；`monitoring.ruleLabels` 必须匹配公司 Prometheus 的规则选择器。阈值是仓库评审过的最低门禁，平台可以在上层增加更严格规则，但不得删除、静默改写或让该 `PrometheusRule` 未被任何 Prometheus 实例加载。上线证据必须包含规则发现状态、一次受控告警演练及 Alertmanager 最终路由，不得只证明 `/metrics` 可抓取。

数据库连接上限至少按下面公式审核：

```text
RGS 最大连接 = rgs.autoscaling.maxReplicas × databaseMaxOpenConnections
发布峰值连接 = RGS 最大连接 + 迁移器最多 2 条连接 + 平台保留量
```

HPA 只按 CPU/内存扩缩，不代表钱包、数据库连接或审计吞吐可以无限增长。压测后应同步调整 Pod 资源、每 Pod 并发、数据库池、钱包限额和入口全局限流；任何一项不能扩容时，应降低 HPA `maxReplicas`。

## 发布流程

复制示例文件并替换全部域名、Secret 名称、镜像 digest、selector、CIDR 和平台证明：

```sh
cp deploy/cluster-production/values.example.yaml /secure/change/slots-production-values.yaml

helm lint --strict deploy/cluster-production/chart \
  -f /secure/change/slots-production-values.yaml

helm template slots deploy/cluster-production/chart \
  --namespace slots-production \
  -f /secure/change/slots-production-values.yaml > /secure/change/rendered.yaml

helm upgrade --install slots deploy/cluster-production/chart \
  --namespace slots-production --create-namespace \
  -f /secure/change/slots-production-values.yaml \
  --atomic --wait --timeout 15m
```

`rendered.yaml` 只用于评审和策略扫描，不得直接执行 `kubectl apply`。迁移器及临时 NetworkPolicy 的先后顺序、失败保留和成功清理由 Helm hook 负责；绕过 Helm 会破坏这套失败闭合语义。GitOps 平台也必须显式支持等价的 pre/post hook 排序后才能接管发布。

首次发布前应由变更审批检查渲染结果和镜像签名/来源证明。首次安装时，pre hook 执行 `up` 创建完整模式；升级时强制改为 `verify`，若新镜像包含数据库未应用的迁移就会在任何 Deployment 变化前失败。模式变更必须先进入已评审维护/协调流程，停止旧版本流量，再用同一摘要的 migrator 镜像独立执行 `up`，最后由 Chart 的 `verify` 复核后发布；不能继续宣称无停机滚动。`maxUnavailable: 0`、PDB 和三可用区约束可能在容量不足时让发布等待而不是牺牲可用性，这是预期的失败闭合行为。

执行本目录契约测试：

```sh
make verify-cluster-production
make verify-cluster-prometheus-rules
make verify-cluster-image-contract
```

第一个目标先运行红绿负向契约，再用 Kubernetes 1.30 schema 执行 kubeconform strict 校验；kubeconform 二进制、归档 SHA-256 和 JSON schema 仓库 commit 都在 required CI 中固定。仓库没有复制 Prometheus Operator CRD schema，因此 kubeconform 只显式跳过 `ServiceMonitor` 与 `PrometheusRule`，不会使用会掩盖其他未知类型的 `--ignore-missing-schemas`；渲染契约仍解析监控选择器、固定 job、Bearer Secret、operations Service 和完整告警集合。上线前还必须在安装了目标版本 Prometheus Operator CRD 的集群执行 `kubectl apply --dry-run=server`。测试同时覆盖长 release/override 命名与引用一致性、install=`up`/upgrade=`verify`、Secret 隔离、linux/amd64、应用配置上限、终止预算、路径穿越、可变镜像、宽松 CIDR、PDB、mTLS、日志提供方和 Web 版本隔离等失败闭合变体。

第二个目标使用与本机生产一致的固定摘要 Prometheus 3.13.1 `promtool`，解析 Helm 实际渲染出的十条 PromQL；required 部署 CI 与受保护标签发布都会执行，避免 CRD 结构合法但规则语法静默失效。

第三个目标需要 Docker daemon，会真实构建受保护发布使用的 `rgs-runtime` 与 `rgs-migrator`，核对 `linux/amd64`、非 root 用户和精确入口，并执行 `/secret-env` 缺 Secret 拒绝、`0440` Secret 文件正向加载及 `/service-probe` 的 200/503 行为。受保护标签工作流会在签名候选构建前重新执行该动态契约；普通供应链 CI 扫描的也是这两个集群目标，而不是缺少 helper 的通用镜像。

## 上线验收

- migrator Job 成功，输出迁移报告；失败 Job 不得人工改为成功。
- RGS 与 Web 每个可用区至少一个 Ready Pod，HPA/PDB 状态正常。
- API 与 Web Ingress 只提供 TLS，operations Service 没有 Ingress 或外部 LoadBalancer。
- 未认证访问 `/readyz`、`/metrics` 返回 401；Prometheus ServiceMonitor 能以 Secret Bearer 抓取全部 RGS Pod。
- Prometheus 已发现内置规则组，受控断开一个测试目标会触发 `SlotsRGSTargetUnavailable` 并到达公司 Alertmanager 最终接收端。
- 节点日志管道能采集 RGS JSON 日志，脱敏抽查、缓冲上限、归档检索和管道失败告警均有证据。
- 从 RGS Pod 只能连通 DNS、批准的数据库、钱包、审计网段；Web Pod 无主动出口。
- 真实启动、下注、钱包未知结果恢复、审计 outbox、Pod 驱逐和跨区故障演练通过。
- 网关仪表盘证明跨副本全局限流生效；不得只观察单 Pod 的 `RGS_RATE_*`。
- 发布后仅有预期告警，且数据库连接数、钱包延迟、outbox backlog 和恢复任务无持续恶化。
