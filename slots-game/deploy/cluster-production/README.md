# 公司集群生产部署

本目录交付可审计的 Kubernetes/Helm 生产部署源码，只包含 RGS API、RGS Worker、静态 Web、一次性数据库迁移器及它们的最小运行配置。它不会部署 `local-operator`、本机 PostgreSQL、演示钱包或本机观测组件；数据库、钱包、审计接收端、入口网关、密钥系统和监控系统都必须由公司平台提供。

## 横向扩展结论

RGS 的业务状态不依赖 Pod 本地磁盘或内存会话，可以运行多个副本：

- 会话、轮次、nonce、launch code 和审计 outbox 全部持久化到外部 PostgreSQL。
- API 副本只处理公网请求；会话与轮次更新使用数据库行锁，不承担钱包恢复、Outbox 或凭据清理。
- Worker 副本负责钱包恢复；多个 Worker 可以看见同一轮次，实际资金操作由持久租约和钱包幂等键保护。
- Worker 的 Outbox 使用 `FOR UPDATE SKIP LOCKED`、数据库时钟、唯一租约令牌及带围栏的完成确认，因此多个副本可以共同消费。
- Worker 的安全凭据清理使用 `SKIP LOCKED`，多个副本同时运行不会重复破坏数据。
- 迁移器使用 PostgreSQL advisory lock；即使发布系统误触发两个 Job，也只会串行迁移。
- API 收到 `SIGTERM` 后先摘流，再停止公网与运维监听器；Worker 先摘流、停止后台任务，再关闭唯一的运维监听器。两类角色都在超时后失败闭合。

API 角色对“创建启动会话”和 Spin 两类新经济意图实施两层准入：先按已验证的运营商/会话身份经过 Pod 内有界限制器，再通过共享 Valkey 令牌桶实施跨副本限制。共享键使用独立 HMAC 密钥压缩为固定摘要，Valkey 脚本以服务端 `TIME` 原子更新，不接收玩家、会话或运营商明文；PostgreSQL 仍是会话、轮次、钱包和 `operationId` 幂等的唯一权威。边缘 WAF 仍负责未认证攻击面和粗粒度容量保护，但不得再冒充已验证身份的精确全局限流。

共享准入故障时，新启动和 Spin 返回 `503 ADMISSION_UNAVAILABLE` 及 `Retry-After`，绝不误报 429，也绝不回退到“只靠本机桶继续下注”。客户端禁用自动重试并把连接复用限制到每个已发现节点一条管线；首次后端错误会打开一秒进程级熔断，同一 Pod 在冷却期内不继续拨号，冷却后只允许一个探测请求，避免故障流量形成连接风暴。已经提交结果的状态查询、待交付结果读取/确认和令牌续期不调用 Valkey，仍受进程内硬容量保护。进程启动会实际 `PING` Valkey并失败闭合；运行期 `/readyz` 不把 Valkey列为整 Pod 就绪依赖，避免一次准入故障同时切断已提交结果恢复路径。`rgs_shared_admission_{allowed,limited,errors}_total` 提供无身份标签的低基数观测。

原生滚动还有严格的兼容边界：只有新旧二进制使用完全相同的数据库模式清单和数学定义身份时才允许执行。当前旧二进制会拒绝带未来迁移的账本，新二进制会拒绝缺失迁移的账本；每个进程也只加载一个获批数学定义。因此，包含数据库迁移或数学定义变更的版本不能使用本 Chart 做普通无停机升级。必须先进入维护窗口完成协调切换，或另行实现并验证“扩展—双版本兼容—收缩”、按定义分群排空或多定义注册表协议。

`release.compatibilityClass=same-schema-and-definition` 仍是强制发布声明和审计标签，但已不是唯一检查。`release.definitionIdentity` 的 `gameID`、`version`、`sha256` 会同时写入 API/Worker Pod template annotation 与 `RGS_EXPECTED_DEFINITION_*` 环境变量；进程在加载并验证签名数学定义后，会对三个字段逐项比对，任一不符即拒绝启动。升级前，Chart 的 Helm `lookup` 和 AWS 应用部署工作流都会把现网 API/Worker 的三元组与候选值比较；仅首次安装可以在两个 Deployment 均不存在时通过，只存在其中一个或任一字段变化都失败闭合。完整边界见 [`docs/cluster-runtime-contract.md`](../../docs/cluster-runtime-contract.md)。

## 部署能力

Chart 默认提供：

- RGS API 三个暖副本、RGS Worker 两个暖副本，二者各自使用 CPU/内存双指标的 `autoscaling/v2` HPA；通用 Web 路径默认三个副本并带独立 HPA。受 HPA 管理的 API/Worker Deployment 不渲染 `spec.replicas`，暖副本下限仅由各自 HPA `minReplicas` 控制；Worker 扩容速度和缩容稳定窗口更保守，避免恢复与审计下游被扩容脉冲击穿。
- API、Worker 和启用后的 Web 各有独立 PDB，均使用零不可用滚动发布、五秒摘流窗口和应用级优雅关闭；终止宽限必须覆盖摘流、应用关闭及额外五秒调度余量。
- 三可用区严格均衡、主机级拓扑分散和 Pod 反亲和偏好。
- 非 root、只读根文件系统、`RuntimeDefault` seccomp、禁止提权、删除全部 Linux capabilities、禁用 ServiceAccount token 和 service links。
- 默认双向拒绝 NetworkPolicy；Web 无运行时出口，API 可访问 DNS、外部 PostgreSQL、钱包和 Valkey，Worker 只可访问 DNS、PostgreSQL、钱包和审计接收端；Valkey 凭据、挂载和出口都不进入 Worker。所有外部目标都限制到明确 `/24` 或更窄 IPv4 CIDR 与端口。
- 公网 API Service、API/Worker 各自的私有 operations Service、Web Service，以及两个强制 TLS Ingress。
- API 与 Worker 分别使用带文件 Bearer 的 `ServiceMonitor`；operations 端口不会进入公网 Ingress，`PrometheusRule` 固定选择 `job="slots-rgs"` 或 `job="slots-rgs-worker"` 和当前发布 namespace。
- `pre-install,pre-upgrade` 数据库 Job：首次安装执行 `up`，原生滚动升级只执行 `verify`，从机制上阻止升级 hook 偷跑不兼容迁移。失败会阻断 Helm 发布并保留失败 Job 与其最小 NetworkPolicy 供排障；下次重试先清理同名失败现场，成功后 post hook 清理临时策略，避免历史 Job 无限累积。
- 所有镜像只接受 `repository@sha256:digest`，不接受可变 tag。

## 前置条件

部署前必须具备：

1. Kubernetes 1.30 或更高版本、Helm 3.14 或更高版本。
2. 支持 `networking.k8s.io/v1` 且真正执行 ingress/egress 规则的 CNI。
3. 至少三个带 `topology.kubernetes.io/zone` 标签的 Linux/AMD64 可用区节点。当前受保护发布链只签名单平台 `linux/amd64` OCI manifest，Chart 会拒绝调度到 ARM64。
4. Metrics Server 或等价资源指标源，用于 HPA。
5. Prometheus Operator 的 `ServiceMonitor`、`PrometheusRule` CRD，匹配 `monitoring.ruleLabels` 的规则发现策略，以及 Prometheus 读取目标 namespace 中 operations token Secret 的 RBAC。
6. 支持 `networking.k8s.io/v1` Ingress、TLS Secret、强制 HTTP 到 HTTPS 跳转，以及 WAF/连接/IP
   粗粒度容量保护的入口网关；入口网关不代替已验证身份的精确共享准入。
7. 外部高可用 PostgreSQL、TLS/ACL Valkey、外部钱包和外部幂等审计接收端；四类目标的稳定出口
   CIDR 必须已由网络团队确认。
8. 外部密钥系统同步出的原生 Kubernetes Secret。Chart 不生成或回显秘密；共享准入的活动 ACL username 通过 `SecretKeyRef` 注入，password、HMAC 与根证书由同摘要、非 root 的初始化工具复制到 Memory `emptyDir` 并收窄为 `0400`，RGS 主进程只读取收窄后的绝对路径。
9. 公司节点级日志管道：采集容器 stdout/stderr、在节点侧脱敏、有界缓冲、集中归档，并对丢弃、积压和归档失败告警。Chart 不部署本机 Vector，也不会伪造这项平台能力。

## 镜像构建契约

RGS 与迁移器必须从本目录的集群镜像文件构建。该镜像包含无 shell 的 distroless 运行时、受限文件到环境变量的 `/secret-env`、认证就绪探针 `/service-probe`，以及只创建 `0400` 新文件且拒绝覆盖的 `/secret-materializer`：

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
| `externalSecrets.sharedAdmission.name` | 只包含 Valkey ACL password、用于键摘要的 32 字节 base64 HMAC 密钥和精确根 CA；由 `/secret-materializer` 复制到内存卷后，主进程仅从 `0400` 绝对路径读取。不得放入 URL、环境变量或 Worker。 |
| `externalSecrets.apiRuntimeAssets.name` | API 使用的定义、批准、公钥、operators v2 文档、launch HMAC、组合系统信任包，以及 API 所需的钱包/运营商密钥。 |
| `externalSecrets.workerRuntimeAssets.name` | Worker 使用的定义、批准、公钥、钱包请求/响应密钥、outbox HMAC/Bearer/根 CA 与组合系统信任包；禁止包含 launch HMAC、访问令牌签发私钥、运营请求验证材料或运营响应签名私钥。 |
| `ingress.apiTLSSecretName` / `webTLSSecretName` | 由 cert-manager 或公司证书系统管理的两个独立 TLS Secret。 |

六个 Secret 名称必须互不相同：runtime 数据库、迁移数据库、operations Bearer、共享准入凭据、API 运行资产、Worker 运行资产。两个运行资产对象的 `keys` 把固定 Secret key 映射为固定容器路径；各自的 `additionalItems` 是唯一允许投影 operators v2 引用文件的白名单。`path` 可以使用 `keys/name.pem`，但禁止绝对路径、隐藏段和 `..`。API 最小集合包含访问令牌签名、运营请求验证、运营响应签名和钱包请求/响应材料；Worker 只保留钱包请求签名与钱包响应验证材料。Worker 运行时不加载 launch HMAC、访问令牌签发私钥、运营请求验证材料或运营响应签名私钥，即使误投影也不应把它们视为 Worker 可用能力。

`trust-bundle.pem` 必须是公司审核的组合 CA bundle，既包含系统公开根，也包含钱包私有 PKI 根。RGS 通过 `SSL_CERT_FILE` 使用它。审计接收端另用 `outbox-root-ca.pem` 精确建池；若开启 `audit.mtls.enabled`，还必须在同一 Secret 提供独立客户端证书和私钥。

Secret 内容更新不会自动让已经启动的进程热加载。轮换时创建新版本 Secret、更新 values 中的名称并滚动发布；不要原地覆盖同名 Secret。旧验证公钥必须按协议重叠窗口保留，确认所有副本和外部方完成切换后再删除。

## 网络与容量规划

标准 Kubernetes NetworkPolicy 不能可靠按 DNS 名称限制外部流量，因此本 Chart 要求分别填写 PostgreSQL、钱包、共享 Valkey 和审计接收端的 IPv4 CIDR。每项只接受 `/24` 至 `/32`，拒绝空数组和 `0.0.0.0/0`。若供应商地址动态变化，应先通过公司 egress gateway 固定出口目标，再把 gateway 的专用网段写入 values；不要临时放宽到全网。

`networkPolicy.ingressController` 和 `monitoring` 同时使用 namespaceSelector 与 podSelector，两者是 AND 关系。必须使用平台真实、不可由业务 namespace 自行伪造的标签。DNS selector 也必须匹配集群实际 CoreDNS 标签。

`ingress.tlsRedirectAnnotationKey` 和 `tlsRedirectAnnotationValue` 会强制写入两个 Ingress；必须填写当前入口实现真实支持的重定向策略键值，并在 `externalControls.tlsEnforcementProvider` 记录平台策略名称。示例使用 ingress-nginx 的 `force-ssl-redirect=true`。变更审批必须确认该注解没有被控制器忽略，不能只因 TLS Secret 存在就宣称已禁用明文 HTTP。

## 日志与告警责任

RGS 使用结构化 JSON 写 stdout/stderr；Web 由容器入口输出访问与错误日志。集群生产不部署本机 Vector，日志可靠性由公司节点级管道负责。`externalControls.logPipelineProvider` 必须填写已审批的真实提供方，并写入 RGS/Web Deployment 与 Pod 标签。平台验收必须证明敏感字段脱敏、磁盘/内存缓冲有界、背压时有明确丢弃策略、集中归档保留期，以及采集停止、积压、丢弃和归档失败告警；只看到日志搜索页面不等于这条链路已闭环。

`rgs.runtime.successAccessLogSamplePerMillion` 只控制成功的普通 HTTP 访问记录，默认 `10000` 即 1%；
4xx WARN、5xx ERROR、资金审计和安全指标不受采样影响。采样前后总量由
`rgs_access_logs_{emitted,dropped}_total` 观测，任何下游采集器都不得再次概率丢弃 WARN/ERROR 或
经济与安全事件。

Chart 内置二十条 `PrometheusRule`，覆盖 API/Worker 指标目标消失或下线、两类角色未就绪、5xx 比例、进程并发容量拒绝、新经济意图数据库保留容量拒绝、HPA 无法计算扩缩容、共享准入故障、认证随机数重放、钱包未知结果/隔离拒绝/持续熔断/持续待定、轮次人工审查、完整性隔离、审计 Outbox 延迟/租约冲突和数据库池饱和/等待。认证随机数重放对外仍统一返回通用 401；内部只增加无标签的 `rgs_auth_replays_total`，并输出固定 `security_event=nonce_replay` 的 WARN 日志，不记录随机数、运营商、密钥、玩家、会话或请求标识。HPA 规则依赖平台固定交付的 metrics-server 与 kube-state-metrics；任一 API/Worker `ScalingActive` 丢失都会告警。规则通过两个 operations Service 分别固定 `slots-rgs` 与 `slots-rgs-worker` job；`monitoring.ruleLabels` 必须匹配公司 Prometheus 的规则选择器。阈值是仓库评审过的最低门禁，平台可以在上层增加更严格规则，但不得删除、静默改写或让该 `PrometheusRule` 未被任何 Prometheus 实例加载。上线证据必须包含规则发现状态、一次受控告警演练及 Alertmanager 最终路由，不得只证明 `/metrics` 可抓取。

数据库连接上限至少按下面的发布峰值公式审核：

```text
发布峰值连接 = (API HPA maxReplicas + API maxSurge) × API 每 Pod 连接
             + (Worker HPA maxReplicas + Worker maxSurge) × Worker 每 Pod 连接
             + API/Worker 终止中 Pod 重叠连接
             + 迁移器连接 + 其他客户端连接 + DBA/应急保留量
```

当前 API 与 Worker 的 `maxSurge` 都是 1，默认配置按两个 HPA 上限计算的非终止 Pod 最低基线是
`(12 + 1) × 20 + (6 + 1) × 10 + 2 = 332` 条连接；该数值尚未包含终止中 Pod、其他客户端和
DBA/应急保留量，不能直接作为 RDS `max_connections`。Kubernetes 滚动期间终止中的 Pod 可能让
瞬时资源超过 `replicas + maxSurge`，必须用压测和发布演练测得重叠连接，或按蓝绿双容量给出
保守预算。

API 默认还配置 `rgs.runtime.databaseCriticalReserveConnections: 5`。每个 Pod 最多允许
`databaseMaxOpenConnections - databaseCriticalReserveConnections` 个新 launch/spin 同时持有新意图
许可，并在数据库 `InUse` 达到同一阈值时快速返回 `503 CAPACITY_UNAVAILABLE` 与
`Retry-After: 1`；状态查询、待交付结果、确认和令牌续期不经过该闸门。这个保留只在单 Pod 内保护
结果闭环，不能增加 PostgreSQL 总容量，也不能替代上面的发布峰值连接公式。出现
`SlotsRGSNewIntentCapacityRejected` 时，只有在 RDS 总连接、CPU、内存和写入余量允许后才能扩 API；
否则应在入口背压或降低业务放量。

仓库内 HPA 只按 CPU/内存扩缩，不代表钱包、数据库连接或审计吞吐可以无限增长。若公司平台接入
Prometheus Adapter 或其他已验证的自定义指标源，可以在平台覆盖中增加 API inflight/时延以及
Worker pending/outbox backlog 指标；没有适配器、查询与故障回退动态证据时不得把这些指标伪装成
Chart 已交付能力。压测后应同步调整 Pod 资源、每 Pod 并发、数据库池、钱包限额、Valkey 共享准入
与入口粗粒度容量保护；
任何一项不能扩容时，应降低相应 HPA 的 `maxReplicas`。

## 维护静默契约

`rgs.maintenanceQuiesced` 与 `worker.maintenanceQuiesced` 默认都为 `false`，普通发布不固定
Deployment 的 `spec.replicas`，API、Worker 和启用的 Web 各自由独立 HPA 管理。两种维护语义不得
混用：

- HMAC 维护只设置 `rgs.maintenanceQuiesced=true`，API 固定为零且 API HPA 不渲染；Worker 保持运行
  并继续未知钱包结果恢复和审计投递。这是既有 HMAC-only 契约；
- 非滚动数据库迁移必须同时设置 `rgs.maintenanceQuiesced=true` 和
  `worker.maintenanceQuiesced=true`。API/Worker 都固定为零，二者 HPA 都不渲染，Web 不受影响；
- `worker.maintenanceQuiesced=true` 而 API 仍活动会被 Helm 模板失败关闭，避免 Worker 已静默但新
  Spin 仍写库；退出维护必须把两个值同时恢复为 `false`，恢复渲染会移除固定副本并重新交付完整
  API/Worker HPA，以及启用 Web 时的 Web HPA。

双组件静默能力必须先随“同 schema、同定义”的准备版本发布，不能让包含新迁移的候选 pre-upgrade
`verify` 在能力落地前阻断维护入口。进入数据库维护后，除了保存 Helm diff，还必须从集群确认两个
Deployment 的期望、更新、可用副本均为零，两个 HPA 和旧 ReplicaSet/终止中 Pod 均已消失，并从
PostgreSQL 侧确认没有旧 writer 活动事务；之后才可独立执行 migrator `up`。迁移完成后先在两个
静默值仍为 `true` 时交付并验证候选清单，再解除静默和分阶段放量。任一步失败都保持双组件为零并
前向修复，不能自动执行 down migration 或启动无法验证新账本的旧进程。完整顺序见
[`docs/database-migrations.md`](../../docs/database-migrations.md)。

维护期间目标消失、未就绪和 HPA 缺失告警会按设计触发。临时静默必须绑定变更单、owner 和明确
到期时间；API/Worker 目标与全部已启用 HPA 恢复后立即撤销，禁止长期关闭规则。

## 发布流程

AWS 正式环境必须使用 [`deploy/aws-production`](../aws-production/) 的专用 values 与机器契约；该覆盖
关闭 EKS Web、改用 ALB 并由 ACM 终止 TLS，不能把下面的通用 Web 容器示例直接当作 AWS 变更单。

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

普通升级还必须在 Helm 调用前校验现网 API/Worker Pod template 的数学定义三元组，并在 Helm 内由 `lookup` 再做一次失败闭合比对。候选三元组变化属于数学定义发布，必须走维护窗口或独立定义分群，不能删除 annotation、改写 `compatibilityClass` 或绕过工作流继续滚动。

执行本目录契约测试：

```sh
make verify-cluster-production
make verify-cluster-prometheus-rules
make verify-cluster-image-contract
```

第一个目标先运行红绿负向契约，再用 Kubernetes 1.30 schema 对普通安装、普通升级、HMAC-only 静默、数据库双组件静默和退出维护五份渲染执行 kubeconform strict 校验；kubeconform 二进制、归档 SHA-256 和 JSON schema 仓库 commit 都在 required CI 中固定。仓库没有复制 Prometheus Operator CRD schema，因此 kubeconform 只显式跳过 `ServiceMonitor` 与 `PrometheusRule`，不会使用会掩盖其他未知类型的 `--ignore-missing-schemas`；渲染契约仍解析监控选择器、固定 job、Bearer Secret、operations Service 和完整告警集合。上线前还必须在安装了目标版本 Prometheus Operator CRD 的集群执行 `kubectl apply --dry-run=server`。测试同时覆盖长 release/override 命名与引用一致性、install=`up`/upgrade=`verify`、HMAC-only 与数据库维护模式、维护恢复、Secret 隔离、linux/amd64、应用配置上限、终止预算、路径穿越、可变镜像、宽松 CIDR、PDB、mTLS、日志提供方和 Web 版本隔离等失败闭合变体。

第二个目标使用与本机集成验收一致的固定摘要 Prometheus 3.13.1 `promtool`，解析 Helm 实际渲染出的二十条 PromQL；required 部署 CI 与受保护标签发布都会执行，避免 CRD 结构合法但规则语法静默失效。静态契约还会分别删除认证重放规则、弱化其 `increase(...[5m]) > 0` 表达式、删除 HPA `ScalingActive` 规则并确认校验失败，再执行完整正向渲染，形成可重复的红绿证据。

第三个目标需要 Docker daemon，会真实构建受保护发布使用的 `rgs-runtime` 与 `rgs-migrator`，核对 `linux/amd64`、非 root 用户和精确入口，并执行 `/secret-env` 缺 Secret 拒绝、`0440` Secret 文件正向加载及 `/service-probe` 的 200/503 行为。受保护标签工作流会在签名候选构建前重新执行该动态契约；普通供应链 CI 扫描的也是这两个集群目标，而不是缺少 helper 的通用镜像。

## 上线验收

- migrator Job 成功，输出迁移报告；失败 Job 不得人工改为成功。
- API 与启用后的 Web 在每个可用区至少一个 Ready Pod，Worker 至少两个 Ready Pod 分布在不同可用区，各自 HPA/PDB 状态正常。
- API/Worker Pod template 的数学定义 annotation 与 values 三元组一致，两类进程均已用同一三元组逐项验证实际加载的签名定义。
- API 与 Web Ingress 只提供 TLS，operations Service 没有 Ingress 或外部 LoadBalancer。
- 未认证访问 `/readyz`、`/metrics` 返回 401；Prometheus ServiceMonitor 能以 Secret Bearer 抓取全部 RGS Pod。
- Prometheus 已发现内置规则组，受控断开一个测试目标会触发 `SlotsRGSTargetUnavailable` 并到达公司 Alertmanager 最终接收端。
- 节点日志管道能采集 RGS JSON 日志，脱敏抽查、缓冲上限、归档检索和管道失败告警均有证据。
- API Pod 只能连通 DNS、批准的 PostgreSQL、钱包和 Valkey，不可访问审计；Worker Pod 只能连通
  DNS、PostgreSQL、钱包和审计，不可访问 Valkey；Web Pod 无主动出口。
- 真实启动、下注、钱包未知结果恢复、审计 outbox、Pod 驱逐和跨区故障演练通过。
- 多 API Pod 压测、Valkey 指标和故障注入共同证明已验证身份共享准入生效且失败闭合；WAF/网关
  仪表盘只证明未认证攻击面与粗粒度容量保护，不得冒充该证据或只观察单 Pod 的 `RGS_RATE_*`。
- 发布后仅有预期告警，且数据库连接数、钱包延迟、outbox backlog 和恢复任务无持续恶化。
