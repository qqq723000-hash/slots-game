# AWS 正式生产运维

状态：正式运行、监控、备份与灾难恢复手册

前置阅读：[AWS 正式生产架构](aws-production-architecture.md) ·
[AWS 正式生产部署](aws-production-deployment.md)

本文定义 AWS 正式环境的运行责任和最低证据。它不把 AWS 服务健康、HTTP 200 或备份任务
`COMPLETED` 等同于经济正确性；轮次、钱包、审计和恢复都必须以应用不变量和对账结果验收。

## 1. 运行责任

| 责任方 | 主要职责 | 不得单独执行 |
| --- | --- | --- |
| 应用/RGS 团队 | 代码、定义绑定、应用告警、幂等恢复、发布兼容性 | 修改正式 IAM/KMS、删除备份、跳过钱包对账 |
| 云平台团队 | AWS 账号、网络、EKS、ALB、CloudFront、RDS、AMP/AMG/CloudWatch | 改写游戏定义、关闭应用完整性检查 |
| SRE/值班团队 | 事件响应、变更窗口、容量、演练、复盘 | 手工把未知钱包结果标成成功/失败 |
| 数据库团队 | RDS 参数、角色、迁移审批、PITR、恢复验证 | 把管理/迁移角色交给运行时 Pod |
| 安全团队 | IAM/KMS、WAF、秘密轮换、日志审计、供应链与事件调查 | 在无恢复验证时删除旧 key/version |
| 运营商集成团队 | 正式启动、钱包、审计、对账与最终业务接收 | 用 `local-operator` 代替正式服务 |
| 业务负责人 | SLO、RTO/RPO、维护窗口、风险接受与正式放量 | 用源码测试代替业务/运营验收 |

所有 P0/P1 事件必须有唯一事件负责人、技术负责人、沟通负责人和时间线记录。资金或完整性事件先
止损、保全证据，再恢复流量；不得为了缩短恢复时间绕过幂等或篡改数据库状态。

## 2. 服务目标与错误预算

以下是首次商用评审的**参考目标**，不是 AWS SLA，也不是未经演练即可承诺的指标。业务负责人、
运营商和 SRE 必须在正式环境压测与故障演练后签署最终数值；签署记录应引用指标查询、统计窗口和
排除规则。

| 对象 | 参考目标 | 统计口径 |
| --- | --- | --- |
| RGS 公共 API 可用性 | 月度不少于 99.95% | ALB 成功请求与应用 5xx；不能用 Pod `Running` 代替 |
| Web 边缘可用性 | 月度不少于 99.99% | CloudFront viewer 成功率，排除明确客户端 4xx |
| RGS 就绪 | 正常时 API `rgs_ready=1` 不少于 3/3，Worker 不少于 2/2 | AMP 按两个 job 逐 Pod 与 Kubernetes Ready 双来源 |
| API 延迟 | 路由分类分别建立 P50/P95/P99；上线阈值不高于压测批准值 | 不把钱包超时或被取消请求从分母静默删除 |
| 经济完整性 | 重复经济命令、未解释余额差异、完整性隔离容忍值为 0 | 钱包对账、round、receipt、outbox 联合核验 |
| 审计交付 | 获批最大 outbox 年龄内完成且无事件丢失 | 最旧事件年龄、重试、sink 回执和归档对账 |
| 监控链路 | 指标、规则、通知和日志管道持续可用 | watchdog 与受控演练，不只检查控制台页面 |

以 30 天计算，99.95% 可用性对应 21 分 36 秒错误预算。预算消耗超过 50% 时停止非必要发布；
超过 75% 时只允许可靠性或安全修复；耗尽时由业务负责人批准后才可继续功能变更。计划维护是否从
SLO 排除必须在合同中明确，不能事后调整查询。

## 3. 恢复目标

下表是建议的首轮验收目标。实际 RPO 受备份频率和复制延迟约束，实际 RTO 以完整恢复演练为准。

| 故障域 | 参考 RTO | 参考 RPO | 恢复方式 |
| --- | ---: | ---: | --- |
| 单个 Pod/节点 | 5 分钟 | 0 | ALB 摘流，EKS 重建 Pod，PostgreSQL 权威状态恢复会话 |
| 单可用区 | 15 分钟 | 0 | 跨区 RGS 副本、节点余量与 RDS Multi-AZ failover |
| Web 错误 release | 15 分钟 | 0 | release router 切回旧不可变 S3 前缀 |
| 正式区域不可用 | 4 小时 | 15 分钟或业务批准值 | 灾备区域恢复 RDS、平台 IaC、Secret 与不可变制品后单写放量 |
| 误删除/逻辑损坏 | 4 小时起 | 由选定 PITR 时间点决定 | 隔离恢复、完整性校验、钱包/审计对账后切换 |

“RPO 0”仅适用于同步权威状态没有丢失的故障域，不适用于区域灾难。RDS Multi-AZ 的自动故障转移
参考时间不是端到端 RTO；应用重连、ALB、钱包恢复和业务验收都计入。

## 4. 观测架构与数据纪律

```text
RGS Pod
├── 公共 8080
│   ├── /healthz：只证明进程存活
│   └── 业务路由：结构化、低基数指标
├── 私有 8081
│   ├── /readyz：数据库、密钥、定义和工作器就绪
│   └── /metrics：operations Bearer；即使 rgs_ready=0 仍可返回 200
└── stdout/stderr：结构化 JSON，不含凭据、正文、查询串和玩家敏感值

EKS 平台
├── Prometheus Agent/ADOT → SigV4 remote_write → AMP
│   ├── ServiceMonitor 读取仅含 operations Bearer 的 Secret
│   ├── AMP rule group 与 Chart PrometheusRule 同步
│   └── Alertmanager → SNS/值班系统/运营商通知
├── CloudWatch Observability add-on → CloudWatch Logs
│   ├── 采集器健康、积压、丢弃和限流告警
│   └── 保留期、订阅、跨账号归档与访问审计
└── AMG
    ├── AMP：RGS/Kubernetes 指标
    ├── CloudWatch：ALB/WAF/CloudFront/EKS/RDS 指标与日志
    └── SSO、角色隔离、禁止共享管理员账号
```

指标 label 禁止包含运营商、玩家、会话、轮次、钱包操作或 request ID。日志禁止记录 token、launch
code、nonce 原文、私钥、签名、DSN、请求/响应正文、原始 URL/query、RemoteAddr 或不必要的钱包
标识。调查所需关联使用语法受限的 request ID 与数据库中受控映射，不把高基数业务身份送入 AMP。

## 5. 仪表盘最低集合

### 5.1 业务入口

- CloudFront viewer 请求、4xx/5xx、缓存命中、origin 延迟与 WAF block/count；
- ALB target healthy 数、请求量、target 4xx/5xx、响应时间、连接错误和 rejected connection；
- RGS 按固定 route class 的请求量、状态类、延迟、active connection、connection limit；
- capacity rejected 与 rate limited 分开展示，不能合并成普通 429/503。

### 5.2 经济正确性

- 钱包 apply/lookup 请求、确认、未知/未发送结果、隔离拒绝、熔断状态、查询恢复、超时和签名失败；
- round 准备/提交/待恢复、人工复核和完整性 quarantine；
- outbox backlog、最旧未发布年龄、deferred、lease lost、sink 回执；
- 每日按运营商/货币的受控离线对账结果。高基数明细进入审计系统，不进入 Prometheus label。

### 5.3 数据库与容量

- RDS CPU、freeable memory、存储、IOPS/延迟、连接、锁、事务和事件；
- 应用 DB pool open/in-use/idle/max、wait count/duration；
- HPA 当前/目标副本、Pod CPU/内存/ephemeral-storage、重启、调度失败；
- 钱包、审计、数据库和入口各自容量上限，展示当前值与剩余余量。

### 5.4 交付与平台

- 当前 Git commit、OCI digest、Web release ID、定义版本/哈希和 Secret 版本标识；
- EKS add-on/节点版本、未就绪节点、PDB、跨区副本和 pending Pod；
- ECR critical/high findings、签名/准入失败和异常镜像拉取；
- 备份年龄、复制延迟、最近恢复演练、证书/Secret 到期时间和规则求值错误。

## 6. 告警分级

| 级别 | 典型条件 | 首次响应 | 处置原则 |
| --- | --- | ---: | --- |
| P0 | 完整性 quarantine、疑似重复扣款/派彩、未解释对账差异、审计证据可能丢失 | 5 分钟 | 停止受影响流量，保全证据，通知业务/安全/运营商 |
| P1 | 全部 RGS target 不可用、RDS failover 后未恢复、钱包未知持续、outbox 超龄 | 10 分钟 | 停止放量/发布，按幂等恢复，不猜测经济结果 |
| P2 | 单区/副本丢失、DB pool 接近饱和、容量拒绝、认证随机数重放、日志/规则管道降级 | 30 分钟 | 恢复冗余和容量，核查调用方重试与凭据泄漏风险，避免演化为 P1 |
| P3 | 成本、版本老化、备份趋势、容量预测、非紧急证书/Secret 到期 | 工作日 | 进入有负责人和截止期的维护队列 |

Chart 内置的二十条集群规则必须在 AMP 或等价求值器中存在：

- `SlotsRGSTargetUnavailable`
- `SlotsRGSNotReady`
- `SlotsRGSWorkerTargetUnavailable`
- `SlotsRGSWorkerNotReady`
- `SlotsRGSServerErrorRateHigh`
- `SlotsRGSCapacityRejected`
- `SlotsRGSNewIntentCapacityRejected`
- `SlotsRGSHPAUnableToScale`
- `SlotsRGSSharedAdmissionErrors`
- `SlotsRGSAuthReplay`
- `SlotsRGSWalletUnknownOutcome`
- `SlotsRGSWalletIsolationRejected`
- `SlotsRGSWalletCircuitOpen`
- `SlotsRGSWalletPendingSustained`
- `SlotsRGSRoundManualReview`
- `SlotsRGSIntegrityQuarantine`
- `SlotsRGSOutboxDeferred`
- `SlotsRGSOutboxLeaseLost`
- `SlotsRGSDatabasePoolSaturated`
- `SlotsRGSDatabasePoolWaits`

平台还必须补充 CloudFront、WAF、ALB、EKS、RDS、AMP rule evaluation、CloudWatch 日志管道、
备份复制和证书/Secret 到期告警。任何告警都要有 owner、级别、runbook、最终接收端、去重键、静默
到期时间和季度演练记录。

## 7. 值班快速诊断

先建立时间线和影响范围，再执行只读检查。下列命令不应输出 Secret 值：

```sh
kubectl -n slots-production get deployment,pod,service,ingress,hpa,pdb -o wide
kubectl -n slots-production get events --sort-by=.metadata.creationTimestamp
kubectl -n slots-production rollout status deployment/slots-rgs --timeout=2m
kubectl -n slots-production logs deployment/slots-rgs --since=15m --all-pods=true

aws rds describe-db-instances \
  --db-instance-identifier "$SLOTS_RDS_INSTANCE_ID" \
  --query 'DBInstances[0].{Status:DBInstanceStatus,MultiAZ:MultiAZ,AZ:AvailabilityZone,Backup:LatestRestorableTime}'

aws elbv2 describe-target-health --target-group-arn "$SLOTS_RGS_TARGET_GROUP_ARN"
```

日志检索不得把 token、DSN 或玩家数据复制到聊天、工单或公共文档。需要关联经济事件时，由获批
审计角色在受控环境查询，并只在事件证据库保存最小必要字段。

## 8. 关键事件 Runbook

### 8.1 RGS target 全部或部分不可用

1. 确认是 ALB health、Kubernetes Ready、`rgs_ready` 还是抓取链路故障；不要只看其中一个信号。
2. 检查最近发布、Secret 版本、RDS/钱包/审计依赖和节点/可用区事件。
3. 单副本故障让 Deployment 重建；单区故障先确认另外两区容量，不手工降低 PDB。
4. 若新 release 导致且 schema/定义兼容，按旧 digest 回退；否则停止流量并进入对应 runbook。
5. 恢复后验证真实启动、spin、钱包回执、展示 ACK 和 outbox，而不是只等 target healthy。

### 8.2 RDS failover 或数据库不可用

1. 停止发布和扩容操作，确认 RDS event、DNS endpoint、应用连接错误和未完成事务。
2. 允许应用失败关闭并重建连接；不要关闭 `verify-full`、放宽安全组或改成固定 IP。
3. 对所有钱包未知结果查询原 `operationId`；不得创建新 round 或新钱包操作。
4. failover 后检查 schema/定义清单、runtime 角色、pool wait、outbox 与 round 恢复。
5. 执行小流量经济验收和对账，再恢复全部流量；记录端到端 RTO。

### 8.3 钱包未知结果增长

1. 保留原 round、request、`commandDigest` 与稳定 `operationId`，检查钱包网络、签名、超时和状态
   查询接口；不得从未认证响应推断资金终态。
2. 核对持久 `wallet_phase`、`next_attempt_at`、apply/lookup 次数和租约，而不是手工调用钱包。
   `UNKNOWN/PENDING` 只能查询；`NOT_SENT` 保持原动作；权威 `NOT_FOUND` 仅在能力档案允许且等待
   一致性窗口后由 Worker 重排相同命令。
3. 检查 `rgs_wallet_isolation_rejected_total`、`rgs_wallet_breakers`、inflight 与请求时延，区分本地
   容量拒绝、共享后端故障和单一运营商故障。熔断打开时不要通过扩容制造更多跨 Pod 探针。
4. 若查询也不可用，停止受影响运营商的新经济意图，保留状态恢复以及其他隔离租户的可用性。
5. 与运营商按钱包 receipt、round 和审计事件对账；任何歧义按 P0 处理。不得创建新的借贷命令，
   也不得把 split/transfer 钱包临时映射为原子轮次接口。

### 8.4 outbox 延迟或审计 sink 故障

1. 检查 sink TLS/HMAC/mTLS、响应持久化语义、网络出口和 lease lost。
2. 确认 backlog/最旧年龄仍在数据库中；不要删除或直接标记已发布。
3. 达到就绪阈值时让 RGS 自动退出流量，避免无界积压。
4. sink 恢复后观察幂等重放与 `eventId` 去重，并与数据库提交数量对账。

### 8.5 完整性 quarantine 或对账差异

1. 立即停止受影响定义、运营商或环境的流量，升级为 P0。
2. 冻结发布、迁移、Secret 轮换和数据修复；保全 RDS snapshot、审计、CloudTrail 与部署证据。
3. 不在原库手工改写 round、receipt、hash、nonce 或 migration ledger。
4. 在隔离副本复现和核验；由应用、数据库、安全、业务和运营商共同批准修复/恢复方案。
5. 完成资金与审计对账、根因修复和独立复核后才可重新开放。

### 8.6 Web release 故障

1. 确认故障仅影响表现层，没有改变 RGS 经济状态。
2. 将 release router 切回旧不可变前缀；不要覆盖 S3 对象或删除仍被会话使用的 release。
3. 验证 HTML、JS、CSS、字体、Spine/音频素材都来自同一 release ID。
4. 真实浏览器完成启动、spin、断线恢复与 CSP/CORS 验收后恢复默认路由。

### 8.7 Secret 或签名密钥泄露

1. 启动安全事件流程，识别用途、运营商、环境、版本和可能暴露窗口。
2. 创建新 Secrets Manager version/KMS material，并按协议 publish/switch/retire；不原地覆盖。
3. access-token 验证公钥保留到旧 token 最大寿命和时钟偏差结束；launch HMAC 按专用等待窗口处理。
4. 紧急轮换可能使未完成 launch 失效，必须记录业务影响并验证 nonce/钱包操作没有重复。
5. 轮换后复核 CloudTrail、Pod Identity、Secret mount、日志脱敏和旧版本读取权限。

## 9. 备份策略

### 9.1 权威数据

- RDS 自动备份与 PITR 是快速恢复基线；AWS Backup 创建独立恢复点并复制到备份账号和灾备区域。
- 备份 vault 使用独立 KMS key、最小删除权限和经审批的 Vault Lock 模式。
- 保留期由业务、财务、隐私与监管共同确定；不能在应用 README 中擅自统一为固定天数。
- 监控最近可恢复时间、任务失败、跨账号/跨区域复制延迟、vault/KMS 权限和恢复点年龄。
- 删除正式数据库、缩短保留期、改变 Vault Lock 或 KMS key policy 属于高风险双人审批变更。

### 9.2 非数据库状态

- Web：S3 versioning、不可变 release 前缀、清单/哈希和按需跨区域复制；
- OCI：ECR digest、跨区域复制、SBOM、provenance 和签名归档；
- 平台：基础设施即代码、非秘密环境配置、Helm values 摘要和渲染证据；
- 密钥：Secrets Manager 版本与 KMS 管理流程，不把秘密导出到 Git 或普通备份；
- 审计/日志：由专用归档账号、对象锁定和保留策略管理，不依赖应用 Pod 磁盘；
- EKS：RGS 是无状态工作负载，集群可由 IaC 和制品重建；不要把 Pod/emptyDir 备份当权威状态。

## 10. 恢复演练

至少每月验证备份任务和权限，至少每季度执行数据库隔离恢复，至少每半年执行完整区域恢复；业务
风险更高时应提高频率。演练不能在正式主库上执行破坏性步骤。

完整恢复顺序：

1. 在隔离账号/VPC 选择明确 PITR 时间点或跨账号恢复点，记录 restore job 与 KMS key；
2. 由 IaC 创建隔离 EKS/RDS/网络/监控，禁止接入正式钱包写入口和公共 DNS；
3. 恢复 RDS，创建最小运行/迁移验证身份并执行 migrator `verify`；
4. 以原 OCI digest、Web release 和定义审批启动 RGS，仅开放合成流量；
5. 校验 schema、定义、round/receipt/outbox/nonce 数量、hash 和最近可恢复业务点；
6. 以钱包/审计只读导出进行对账，证明没有重复或缺失经济命令；
7. 记录实际 RPO/RTO、人工步骤、权限失败、数据差异和改进负责人；
8. 按审批销毁隔离环境；证据保留，恢复出的敏感数据按策略安全处置。

季度演练只恢复数据库但未启动应用、未执行 migrator `verify`、未对账钱包/审计，不能计为完整
恢复演练。

## 11. 区域灾难恢复

本基线是主区域单写、灾备区域恢复，不宣称跨区域双活。宣布区域灾难后：

```text
事件指挥官宣布灾难并冻结主区域写入
├── 确认主区域无法安全恢复或已经隔离
├── 选择灾备区域最近合格恢复点
├── IaC 建立/验证网络、EKS、ALB、WAF、AMP/日志与身份
├── 恢复 RDS，执行 migrator verify 和数据/定义完整性校验
├── 注入灾备环境专用 Secret 与证书
├── 部署原签名 OCI digest 和 Web release
├── 钱包/审计切换到单一灾备写入权威并完成对账
├── 合成流量 → 内部白名单 → 分阶段正式流量
└── Route 53/运营商入口切换；持续阻止原区域恢复后双写
```

回切不是简单反向 DNS。必须先选择新的单写权威、同步/恢复数据、对账区域故障期间的全部钱包与
审计操作，再按一次正式迁移执行。

## 12. 容量与性能

### 12.1 连接预算

```text
发布峰值数据库连接
= (API HPA maxReplicas + API maxSurge) × API RGS_DB_MAX_OPEN_CONNS
 + (Worker HPA maxReplicas + Worker maxSurge) × Worker RGS_DB_MAX_OPEN_CONNS
 + API/Worker terminating Pod 重叠连接
 + migrator 最多 2 条连接
 + 其他应用/监控客户端
 + DBA/故障转移/应急保留量
```

Kubernetes 滚动期间，终止中的 Pod 可能让实际总数短时超过 `replicas + maxSurge`；重叠连接应
使用预发布驱逐/滚动测试的观测上界，而不是假定为 0。总值必须低于 RDS 实际可用连接预算，并为
failover 重连风暴留余量。RDS Proxy 启用后仍按数据库端连接、固定比例和 Proxy 指标核算，不能只
看客户端连接数。

API 的 `RGS_DB_CRITICAL_RESERVE_CONNS` 默认是 5，且必须小于本 Pod 的
`RGS_DB_MAX_OPEN_CONNS`。新 launch/spin 的本机 permit 数等于两者之差；数据库 `InUse` 达到该阈值
时也会快速拒绝新意图，而 status、pending result、ACK 与 refresh 继续使用保留容量。该检查与 permit
共同限制突发穿透，但仍是每 Pod 边界：多 Pod、终止中 Pod 和其他数据库客户端必须继续计入发布峰值
公式。`rgs_new_intent_capacity_rejected_total` 增长表示保护已生效，也表示当前放量超过已批准容量；
禁止只提高 HPA 或连接池来消除告警，除非新的 RDS/钱包/入口总预算和压测证据同时获批。

钱包并发也必须用滚动峰值计算。当前每个 RGS 进程的基线是后端 apply 24、lookup 8，以及每运营商
apply 8；这是非阻塞的本机隔离，不是全局限额。容量评审至少计算：

```text
钱包峰值并发上界
= (API 滚动峰值 Pod + Worker 滚动峰值 Pod) × 每 Pod 对应 lane 许可
+ 半开熔断探针与终止中请求的实测重叠
```

正式钱包合同容量、出口/NAT 端口、连接池和压测批准值必须高于该上界，或相应降低 HPA/每 Pod
许可。状态查询 lane 必须保留，不能为提高 apply 峰值而借走全部 lookup 容量，否则未知结果无法
收敛。

### 12.2 压测场景

每个正式候选至少覆盖：

- 稳态、预期高峰、2 倍突发和缓慢客户端；
- HPA 从最小到最大副本，单区容量丢失和节点替换；
- 钱包延迟/超时/未知结果、审计 sink 变慢、RDS failover；
- apply 舱壁饱和、lookup 保留容量、熔断 open/half-open、单运营商故障与共享后端故障；
- connection、in-flight、DB pool、WAF 和身份级全局限流同时接近上限；
- Web 冷缓存、多个 release 并存、不同网络质量和移动设备；
- 日志/指标出口限流，证明业务不会因无界遥测缓冲耗尽资源。

压测数据必须使用隔离账号、模拟钱包和不可兑付数据，不能通过 `local-operator` 的单机结果推断
AWS 容量。HPA 只按 CPU/内存扩缩时，下游容量先到顶应降低 `maxReplicas` 或背压，而不是继续扩容。
本机 `atomic-http-v2` conformance 也不能替代真实第三方钱包的签名、幂等保留期、`NOT_FOUND`
一致性、慢响应、故障转移、对账和容量认证。转账或拆分 debit/credit 钱包尚未实现，接入前必须另
行交付持久 saga 与专项认证。

### 12.3 成本控制

- 为 EKS 节点、RDS、NAT、CloudFront、S3、AMP、AMG 和 CloudWatch 设置成本分配标签和预算告警；
- 通过 VPC endpoint、日志过滤/保留、高基数限制和 S3 生命周期控制可预期成本；
- 在不降低多区冗余、备份、审计和恢复能力的前提下调整实例与 requests/limits；
- Spot 只能用于可中断、已验证的额外容量，正式 RGS 基线副本应有稳定按需容量；
- 成本异常不能通过关闭日志、缩短法定保留或删除回退制品立即止损，必须走变更审批。

## 13. 补丁、升级与变更

- 每月评审 Go/Node/npm、容器基础镜像、EKS/Kubernetes、add-on、节点 AMI、RDS minor 和 AWS 控制器
  公告；重大漏洞按安全时限处理。
- EKS 升级先在非正式账号验证 API/CRD/准入/NetworkPolicy/负载均衡和真实浏览器，再逐环境推进。
- 节点滚动必须遵守 PDB、跨区容量和 surge；禁止为加速升级永久降低 `minAvailable`。
- RDS minor/参数变更先评估 failover、扩展、锁和连接行为；维护后执行经济恢复验收。
- WAF managed rule 更新先用 count 模式观察误报，再经审批切 block；保留规则版本与样本。
- Secret、证书和签名 key 按用途独立轮换，所有轮换都有提前告警、重叠窗口和回退材料。
- 每次变更都保留前后指标、IaC/Helm diff、审批、执行者、时间、结果和回退决定点。

## 14. 日常与周期任务

### 每班/每日

- 检查 P0/P1、错误预算、完整性、钱包未知、outbox、对账和备份失败；
- 确认 3 区 Ready 副本、RDS/ALB target、AMP rule evaluation 和日志管道；
- 审阅异常 WAF block、IAM/Secret/KMS/CloudTrail 事件和未授权发布尝试。

### 每周

- 复核容量趋势、DB pool、钱包/审计延迟、CloudWatch/AMP 成本和证书/Secret 到期；
- 随机抽查 Web release、OCI digest、定义哈希与部署证据一致；
- 验证告警静默都有 owner 和到期时间，关闭无主或失效静默。

### 每月

- 受控触发至少一条应用告警和一条平台告警，确认最终接收与升级；
- 审阅 ECR/Inspector、依赖、节点/RDS/EKS 版本和最小 IAM 使用情况；
- 验证备份、跨账号/跨区域复制、Vault/KMS 权限与恢复点可见性。

### 每季度/半年

- 每季度执行隔离数据库恢复、RDS failover、节点/单区故障和钱包未知结果演练；
- 每半年执行区域灾难恢复与回切桌面/技术演练；
- 复核 SLO/RTO/RPO、联系人、运营商协议、数据保留和所有 runbook。

## 15. 退役与清理

清理旧 release、digest、Secret version、备份或日志前必须证明：

1. 没有运行中 Deployment、回退计划、活跃会话或审计引用它；
2. 已超过业务、财务、监管、安全和灾备保留期；
3. 至少一个后继 release 已完成稳定窗口与恢复演练；
4. 删除范围、对象数量、账号、区域和恢复可能性经过双人审批；
5. 清理后重新验证当前 release、备份、签名和运行实例。

禁止使用宽泛递归删除、未解析变量或开发者本机凭据清理正式资源。`local-operator` 及本机验收状态
与 AWS 正式环境完全分离；清理本机环境不能影响 Tunnelblick、公司网络或任何正式 AWS 资源。

## 16. 关联手册

- [多副本集群运行契约](cluster-runtime-contract.md)
- [数据库迁移](database-migrations.md)
- [故障恢复](failure-recovery.md)
- [事务性发件箱](outbox-delivery.md)
- [访问令牌密钥轮换](access-token-key-rotation.md)
- [安全与合规边界](security-compliance.md)
- [前后端核心架构评估](core-architecture-assessment.md)
- [通用集群生产部署](../deploy/cluster-production/README.md)

## 17. AWS 官方参考

- [RDS Multi-AZ DB instance 故障转移](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html)
- [AWS Backup 跨区域副本](https://docs.aws.amazon.com/aws-backup/latest/devguide/cross-region-backup.html)
- [AWS Backup Vault Lock](https://docs.aws.amazon.com/aws-backup/latest/devguide/vault-lock.html)
- [CloudWatch OTel EKS 容器日志](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/container-insights-eks-otel-logs.html)
- [AMP 托管与 EKS 指标](https://docs.aws.amazon.com/eks/latest/userguide/prometheus.html)
- [Amazon Managed Grafana 监控 EKS](https://docs.aws.amazon.com/grafana/latest/userguide/solution-eks.html)
- [CloudFront 缓存与过期](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Expiration.html)
- [Kubernetes Deployment 滚动与终止中 Pod](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
