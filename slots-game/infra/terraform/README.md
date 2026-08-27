# AWS 应用基础设施 Terraform

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

本目录定义 Slots 应用自己负责的 AWS 基础设施。它可以独立创建 VPC、EKS、RDS PostgreSQL、
ECR、Secrets Manager 元数据、S3/CloudFront、AMP、CloudWatch 与 AWS Backup 基线；不会创建
AWS Organizations、账号工厂、集中身份、组织级审计或安全账号。

```text
infra/terraform
├── contracts
│   ├── cluster-addons-interface.v1.yaml
│   └── landing-zone-interface.v1.yaml
├── modules
│   ├── delivery-contract
│   ├── network
│   ├── kms
│   ├── ecr
│   ├── eks
│   ├── rds
│   ├── cache
│   ├── secrets
│   ├── api-edge-security
│   ├── web-edge
│   ├── observability
│   ├── backup
│   └── archive
├── stacks
│   ├── application-platform
│   └── environment
├── environments
│   ├── dev
│   ├── staging
│   ├── prod-primary
│   └── prod-dr
└── scripts
    ├── verify.sh
    ├── verify-static-contract.sh
    ├── verify-valkey-rotation-plan.rb
    ├── test-valkey-rotation-plan.rb
    └── test-negative-contract.sh
```

## 安全边界

- Terraform Core 固定为 `1.15.9`，AWS Provider 固定为 `6.57.1`；每个环境提交
  `.terraform.lock.hcl`。
- 每个环境使用独立 S3 state key 和 S3 原生锁文件。state bucket、KMS key 和部署角色由采用方 AWS 基础环境
  提前提供，仓库只提交 `backend.example.hcl`。
- Provider 使用 `allowed_account_ids`，账号不匹配时拒绝执行；示例账号、域名、ARN 和 bucket 均为
  不可部署占位值。
- 账号工厂必须先创建默认 `AWSServiceRoleForAutoScaling`。EKS 节点卷 CMK 直接绑定该服务关联角色，
  并只允许 AWS 资源持久 grant；缺少该角色时 KMS key 创建会失败关闭，不会退回未加密节点卷。
- RDS 使用 Secrets Manager 托管主密码；五个职责隔离应用 Secret 只创建空的元数据容器。API 与 Worker
  运行资产分别使用 `api-runtime-assets` 和 `worker-runtime-assets`，Worker 不再获得 launch HMAC 或
  API operator 私钥。共享准入固定创建 A/B 两个 Valkey ACL 用户并始终保留在同一 user group；两个密码、
  HMAC key 与显式根证书通过 Terraform 1.15 ephemeral 变量进入 provider write-only 参数，不写入普通
  tfvars、plan 或 state。活动槽位的用户名和密码共同写入版本化 Secrets Manager Secret。两个用户的
  ACL 都只允许 `rgs:shared-admission:v2:*`、`EVAL/EVALSHA`、脚本内部
  `GET/PTTL/SET/TIME/MSET/PEXPIRE`、readiness
  `PING` 与客户端认证/命名握手；v1 的 `TIME/HMGET/HSET/PEXPIRE`、命令类别和其他 keyspace 均不授权。
- EKS API 默认只开放私网端点，业务 Pod 不获得 AWS IAM 权限；平台插件通过 Pod Identity 获取最小权限。
  RDS 与 Valkey 的入口引用 EKS 托管节点实际持有的集群安全组，再由 Chart 的默认拒绝 NetworkPolicy
  限制到需要访问的 Pod，不再创建没有 SecurityGroupPolicy 绑定的占位安全组。
- 当前 Valkey 只保存可丢弃的跨副本身份准入令牌桶；没有实现 `operationId` 重复抑制或资金结果
  缓存。资金幂等、钱包结果和游戏局状态继续以 PostgreSQL、Outbox 与恢复 Worker 为唯一权威；
  Kafka 不属于钱包正确性依赖。
- 冷归档模块只创建加密 S3、生命周期和受限 RDS snapshot export 角色；它不会创建定时导出任务，
  也不能作为“归档已经运行”的证据。
- `prod-primary` 必须配置跨区域备份目标 vault ARN；`prod-dr` 先创建目标 vault，再把输出交给主区域。
- 本目录不会连接或修改任何 AWS 账号，除非操作者明确执行经审批的 `plan`/`apply`。

## 采用方 AWS 基础环境接口

采用方平台必须先满足 [`contracts/landing-zone-interface.v1.yaml`](contracts/landing-zone-interface.v1.yaml)。
应用仓库只接收账号 ID、区域、三个可用区、Terraform state 接口、DNS/证书标识和受保护部署角色；
Organizations、Control Tower、SCP、集中 CloudTrail、Security Hub、GuardDuty、预算与网络互联仍由平台仓库负责。
应用发布角色还需对 delivery 指向的 Cluster Autoscaler role 具有只读 `iam:GetRolePolicy`，
以让实时门禁确认实际策略包含 `autoscaling:DescribeTags`；该权限不允许写 IAM。
同一角色还需要 `rds:DescribeDBInstances` 与 `logs:DescribeMetricFilters`，只用于回读 writer/可选 reader
继承边界和 PostgreSQL deadlock metric filter；它们不授予数据库连接、修改或提升副本权限。

### API 与 Web 边缘防护合同

动态 API 的权威模型是 `Route 53 → internet-facing ALB + REGIONAL WAF → EKS`。应用仓库自管
`modules/api-edge-security`，把 Web ACL ARN 输出给 ALB Ingress 精确绑定，并创建 KMS 加密的
`aws-waf-logs-*` 日志组、BLOCK/COUNT-only 过滤、完整 query string 与敏感 Header 脱敏以及
Allowed/Blocked 请求量告警。正式 RGS 协议不使用 query；URI path/method 仍保留用于事件处置。
Shield Standard 是 ALB 的 AWS 服务基线；Terraform 源码、本地 plan 或夹具都不能证明真实账号已经
历经攻击验证。CloudFront 仅承载静态 Web，使用企业 global WAF 和 private S3 OAC，不是 API 代理。
Web Response Headers Policy 不注入 `X-Frame-Options`，由已验证 digest 中唯一的精确
`frame-ancestors` CSP 授权跨源运营商 iframe；release cookie 固定为
`Secure; HttpOnly; SameSite=None; Partitioned`。Web bucket policy 通过 `s3:if-none-match` 与
`s3:ObjectCreationOperation` 拒绝 `releases/*` 无条件 `PutObject`。为兼容经审批的旧 release 清理与
versioning lifecycle，模块不设置全局删除 Deny；发布身份删除权限的 IAM/SCP 收口和真实账号回读仍是
采用方 AWS 基础环境门槛。

Regional WAF 还精确 Block 公网 `/healthz` 并返回 404。AWS Load Balancer Controller 的 `ip` target
业务端口仍是 8080，但 ALB target health 以数值端口 8081 直连 Pod 私有 operations `/healthz`；该
探针不经过 WAF。Helm 渲染门禁同时要求受控 ALB 来源的 NetworkPolicy 只开放 8080/8081，避免为了
健康检查把整个 operations 面或 VPC 暴露到公网；ALB SG 另有两条精确 TCP 8080/8081 VPC egress，禁止
用端口范围或公网 egress 代替。发布后门禁还把当前 Helm release 的 Ready Pod IP 逐一绑定健康 target，
并核对 TLS policy、regional ACM 证书和 host + Prefix `/` listener rule。

8 KiB body rule 固定 `oversize_handling=MATCH` 并直接 Block，因为公开 API 全部合法 JSON 的最坏转义
展开已经证明小于该窗口，应用也严格固定同一 8192 字节上限。aggregate headers 虽同样在 8 KiB
窗口观测，但最大合法 token 加固定头、Host/User-Agent、ALB tracing/XFF 尚无充分余量证明，所以
示例只能 Count；Go 的 16 KiB Header 上限是源站最终兜底，不是把 WAF 提前 Block 合法化的证据。

所有 per-IP rate rule 也默认 Count。`launch-rate-limit` 与 `spin-rate-limit` 只以 POST 精确匹配新意图
路径；`public-api-rate-limit` 用更高阈值覆盖 `/client/` 与 `/operator/` 的 GET/OPTIONS/POST，
因此 status/result/ACK 不受低阈值连带阻断，也没有绕过总保护。Block 429 使用无敏感正文的固定
`RATE_LIMITED` marker、`Retry-After: 30` 与 ACAO/Expose headers，避免跨域客户端把 edge 拒绝误判为未知网络
错误。大型 operator 出口和移动 CGNAT 会共享 IP，示例阈值不是商用认证值；
认证后的 operator/session 本机桶与 Valkey 共享准入才是精确业务限额。

header、rate 和 managed rules 从 Count 切到 Block 都必须在对应 rollout 输入中绑定
`s3://bucket/key?versionId=<version>#<64位小写sha256>` 不可变证据引用。证据需要记录环境、Web ACL、rule group/version、
阈值/scope、完整观测窗口、正常与营销高峰、NAT/CGNAT、误杀率、合法流量存活率、源站余量、批准人
和回滚条件；任一规则版本、阈值或 scope 改变都重新触发当前审批门禁。四套环境 example 明确使用
`observation-pending`，不能被解读为“已调优”。`verify-live-platform-prerequisites.sh` 在真实发布身份下
只读回查实际 WAF、日志、告警、CloudFront/OAC；仓库的 mock 负测只证明门禁逻辑，不证明 AWS 状态。

Block evidence 不是一个只过正则的字符串。应用发布身份需要对批准的 evidence bucket 具有最小
`s3:GetObjectVersion`、`s3:GetObjectRetention`（以及 SSE-KMS 对应 decrypt）权限；
`verify-waf-rollout-evidence.rb` 读取 URI 指定的
精确 version、限制 256 KiB、核对文件 SHA-256，再验证 `slots-game/waf-rollout-evidence/v1`。对象必须
绑定 environment、Web ACL、rule names、当前阈值/scope 的 configuration hash 和受保护部署源码 SHA，
并包含七天观测指标、规则专属评审、双人审批、有效期和回滚 runbook。Count→Block、configuration 或
证据引用变化必须在 apply 前绑定当前 infrastructure source SHA 且审批未过期；稳态 Block 继续回读相同
version/hash/config/schema，但历史批准到期不是日常 infra/app 发布的租约。任何读取、摘要、schema 或合同
漂移仍失败关闭；对象内容不会写入发布日志。机器门禁只验证绑定与完整性，真实性仍由
安全/业务审批和原始遥测归档承担。Regional/CloudFront Web ACL 与所有规则同时关闭 sampled requests，
因为 logging redaction 不会脱敏 `GetSampledRequests`。

Route 53 hosted zone/alias、DNSSEC、注册商保护、CloudFront global WAF 和 Shield Advanced/DRT 属于
采用方 AWS 基础环境。Global Accelerator、CloudFront API proxy、Shield Advanced 均为可选接口，启用时必须
同时交付上游可达性/健康、源站访问迁移、成本审批与真实回读，不能只修改 ALB 安全组或在文档中宣称
已经启用。

集群 add-on 的交付边界由
[`contracts/cluster-addons-interface.v1.yaml`](contracts/cluster-addons-interface.v1.yaml) 固定。Terraform
基础设施 `apply` 的输出始终包含 `foundation_apply_is_application_ready=false`；AWS Load Balancer
Controller、Cluster Autoscaler、External Secrets、Prometheus Operator 与 Prometheus Agent 未在 VPC 私网执行器上通过实时门禁前，
禁止进入应用 Helm 发布。
应用发布还必须回读 vpc-cni 的精确 EKS add-on 版本与 `ACTIVE` 状态，确认实际
`enableNetworkPolicy=true` 且 kube-system/aws-node 使用 Terraform 输出的专用 Pod Identity；否则 Chart
中的 NetworkPolicy 只是一份未证明生效的声明，门禁必须失败关闭。
同一 delivery 还固定 `amazon-cloudwatch-observability` 的版本、container logs/增强 Container Insights
配置和 cloudwatch-agent Pod Identity；应用发布前后必须回读 add-on `ACTIVE`，并确认 cloudwatch-agent
与 fluent-bit DaemonSet 在所有调度节点就绪。仓库 mock 仅验证失败闭合逻辑，真实账号状态仍是外部门禁。
采用方 AWS 基础环境还必须提供经批准的 ALB access log bucket 与每环境独占 prefix；Terraform delivery、Helm
渲染和发布后 ALB 属性必须三方精确一致。legacy ALB access logs 的服务端加密边界是 SSE-S3，不得将
WAF 证据或 Terraform delivery 的 SSE-KMS 要求误套到该 bucket。

`platform_addon_versions` 中除 `prometheus-agent` 外的四个值是 Helm Chart 精确版本，`prometheus-agent` 是
Prometheus Agent CR 的 `spec.version`（配置中不带 `v`，实时门禁按 `v<SemVer>` 校验）。这些版本
是受保护环境输入，不由仓库猜测“最新版本”。`cluster_autoscaler_image_tag` 必须是与 EKS 主次版本一致的
精确 patch；Terraform 只忽略节点组 `desired_size` 的漂移，`min_size` 与 `max_size` 仍由变更评审管理。

## 初始化与验证

从目标环境复制示例文件到受限目录，替换全部 `REPLACE_` 值：

```sh
cd infra/terraform/environments/prod-primary
cp backend.example.hcl /secure/change/prod-primary.backend.hcl
cp terraform.tfvars.example /secure/change/prod-primary.tfvars

terraform init -backend-config=/secure/change/prod-primary.backend.hcl
terraform plan -var-file=/secure/change/prod-primary.tfvars -out=/secure/change/prod-primary.tfplan
```

`configuration` 只包含非秘密参数。计划和应用还必须由受保护执行器注入四个 ephemeral 环境变量：
`TF_VAR_valkey_password_a`、`TF_VAR_valkey_password_b`、`TF_VAR_shared_admission_hmac_key`、
`TF_VAR_valkey_root_ca_pem`。前三项由密码管理系统生成；根证书来自受控 AWS 信任库。即使某个槽位本次
不更新，执行器仍必须注入两个密码；只有相应的 `valkey_password_version_a` 或
`valkey_password_version_b` 递增时 provider 才会重置该槽位。`valkey_secret_version` 控制发布给新
工作负载的不可变 Secret 名称；奇数版本必须选择 A，偶数版本必须选择 B。
`valkey_password_fingerprint_a`、`valkey_password_fingerprint_b` 和
`shared_admission_hmac_key_fingerprint` 分别是实际 ephemeral 字符串的 64 位小写 SHA-256；Terraform
会重新计算并失败关闭，因此 tfvars 不能用伪造 fingerprint 绕过状态机。fingerprint 只用于高熵随机值的
变更绑定，不得替代密码管理系统中的原值。
`application_secret_versions` 分别控制五个职责 Secret 的不可变名称版本。所有 Kubernetes
Secret 只同步一次并设置 `immutable=true`，任何值轮换都必须先递增对应版本并以新名称滚动工作负载，
不得原地覆盖。秘密值不得写入仓库、普通 tfvars、日志或制品。
`configuration.application_namespace` 和 `configuration.helm_release_name` 必须分别与受保护
Environment 的 `AWS_EKS_NAMESPACE` 和 `AWS_HELM_RELEASE_NAME` 精确一致；它们会进入持久化
`rotation_guard.target_identity`，使 HMAC 证据不能在其他 namespace 或 release 之间复用。

## RDS 容量告警与阈值校准

每个 RDS DB instance 都创建 8 个原生单指标容量告警、2 个读写合计 metric-math 容量告警，并从
PostgreSQL 导出日志创建 1 个死锁事件告警：

- `CPUUtilization`、`DatabaseConnections` 和 `DiskQueueDepth` 监测计算、连接与 I/O 排队压力；
- `FreeableMemory`、`FreeStorageSpace` 监测可用内存和存储安全余量，`SwapUsage` 监测持续换页压力；
- `ReadLatency`、`WriteLatency` 监测数据库端平均 I/O 延迟；
- `TotalIOPS = ReadIOPS + WriteIOPS` 使用 `Count/Second`；总吞吐由
  `ReadThroughput + WriteThroughput` 得到并使用 `Bytes/Second`。两项 CloudWatch metric-math 告警共享
  目标 gp3 或实例预算，不能把完整预算分别套给读与写而漏掉混合负载；
- PostgreSQL DB instance 不发布原生 `AWS/RDS:Deadlocks`。Terraform 在已启用的 `postgresql` 日志导出组上
  用精确短语 `"deadlock detected"` 创建 CloudWatch Logs metric filter，向低基数
  `Slots/RDSLogEvents` namespace 发布自定义 `Count` 指标；告警使用 60 秒 `Sum`、阈值 1 和 1/1 窗口。

12 个底层容量指标来自 `AWS/RDS` namespace，维度与单位以
[Amazon RDS CloudWatch 指标](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-metrics.html)和
[DB instance 指标维度](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/metrics_dimensions.html)为准。
该实例指标表不包含 `Deadlocks`；不能把 Aurora cluster 指标套到当前单实例 PostgreSQL。容量告警要求
3 个 60 秒窗口中的 2 个越界才触发；日志派生的 deadlock 指标使用单个 60 秒窗口且单次匹配即告警。
所有告警把 ALARM 与 OK 状态发送到值班 SNS topic，并显式固定 CloudWatch unit、
比较方向和 `treat_missing_data=notBreaching`。后者只表示没有指标样本时不把容量状态判成越界，不表示
采集或告警路由健康。
SNS policy 只允许同账号且来源 ARN 精确匹配本应用资源的 `cloudwatch.amazonaws.com`、
`events.rds.amazonaws.com` 和 `backup.amazonaws.com` 发布。加密 topic 使用的 observability KMS key
也分别授权这三个 event source 的 `kms:GenerateDataKey*`/`kms:Decrypt`，并用同样的账号与来源 ARN
绑定；`sns.amazonaws.com` 只能在 encryption context 精确等于本 topic ARN 时使用该 key。topic policy
和 KMS policy 缺一不可，避免出现 CloudWatch/RDS/Backup 显示已发布但加密通知实际无法送达的假健康。

`rds_alarm_thresholds` 是四个环境必须显式填写的非秘密容量合同。`rds_alarm_contract` 随 Terraform
delivery 输出 11 个实际 alarm 名称、metric/statistic/unit/threshold/window、metric data queries、SNS topic
和数据库维度，
发布前 live gate 会同时用 CloudWatch Logs `describe-metric-filters` 和 CloudWatch `describe-alarms` 回读
日志组、pattern、自定义 namespace、metric name/value/default/unit、alarm，以及 metric-math 的
`Metrics`/expression/`ReturnData`/source stat/unit/period/dimension，并拒绝漂移。示例值不是
目标实例的商用认证结果；正式环境的连接阈值还必须同时覆盖 API/Worker 最大副本、rolling surge、
迁移器、终止中 Pod、监控/DBA 与故障重连余量，并低于目标实例实测 `max_connections`。CPU、内存、
存储、延迟和队列阈值必须用目标实例类型、gp3 IOPS/吞吐配置、真实 SQL 与恢复/outbox 混合负载重新
校准。当前 100/200 GiB gp3 dev/staging 示例以 3,000 IOPS、125 MiB/s 基线的 80%（2,400 IOPS、
100 MiB/s）起步；500 GiB gp3 prod-primary/prod-dr 示例以四卷条带化 12,000 IOPS、500 MiB/s 基线的
80%（9,600 IOPS、400 MiB/s，即 419430400 B/s）起步。这些阈值应用于读写合计 metric math；上线
必须由目标实例 class、实际 storage 配置和混合负载 profile 批准。
告警不会自动提高连接池、扩数据库或触发故障转移；值班人员必须先判断查询、锁、写放大和依赖
恢复洪峰，再执行经批准的容量变更。`rds_read_replica.enabled` 在全部环境示例中默认 `false`；关闭时
不会创建副本、reader endpoint 或 `ReplicaLag`/副本容量告警。经目标区域容量评审后，可以显式创建
一个同区域 PostgreSQL 异步只读副本和独立 `rds_reader_endpoint`。副本使用源实例 ARN、相同私有
subnet group 和安全组；参数组由 RDS 的同区域副本语义继承并由 live gate 回读。同区域加密由 RDS
强制继承源 KMS key，Terraform 不接受另一个 key。
生产环境启用该接口时还必须把 reader 本身设为 Multi-AZ；这只为 reader 增加故障转移 standby，不会
把 source Multi-AZ standby 变成可读节点。副本还显式启用删除保护、最终快照、与源相同的自动备份保留期、独立日志组，以及 CPU、连接、内存、
存储、读取延迟、磁盘队列、swap 和 `ReplicaLag` 告警；其中 `ReplicaLag` 缺失按 `breaching` 处理。

`rds_read_scaling_contract` 会把启用状态、reader identity/endpoint、继承期望和 8 个告警交给 live gate；
门禁通过 `describe-db-instances`/`describe-alarms` 回读源绑定、endpoint、公开访问、KMS、subnet、参数组、
安全组、备份、删除保护、待应用修改和告警语义。`prevent_destroy` 会让直接把已创建副本开关改回
`false` 的计划失败，避免无审批销毁或把副本静默提升成独立数据库。该能力不包含应用读写路由、
PgBouncer、RDS Proxy、自动提升或跨区 DR；合同固定
`application_routing_adopted=false`、`rds_proxy_implemented=false`、
`connection_pooler_implemented=false`、`cross_region_dr_implemented=false` 和
`read_replica_is_backup=false`。主实例 Multi-AZ standby 仍不是可读节点，同区域 read replica 也不能
替代 `prod-dr` 的跨区域备份/恢复演练。

日志 metric filter 只能证明受控短语的匹配计数越界，不能自动产生事务快照。delivery 中的
`deadlock_metric_filter` 固定日志组、pattern、自定义指标与默认值；`deadlock_evidence` 仅提供精确 alarm
名称和 PostgreSQL 日志组，并固定
`automatic_snapshot_implemented=false`、`external_evidence_consumer_required=true`；平台仍须把受控时间窗
内的脱敏日志/Performance Insights 证据写入批准的不可变事件库，并完成值班处置演练。

`treat_missing_data=notBreaching` 防止维护/切换期间无数据被误判成容量越界，但它不代表监控健康；
CloudWatch alarm 状态、SNS 最终接收、RDS event subscription 和通知链路必须另设周期性演练与无数据
检测。

## Valkey 容量告警与阈值校准

三节点 Valkey replication group 对每个固定节点创建以下 CloudWatch 告警：

- `EngineCPUUtilization`：引擎线程负载；
- `CurrConnections`：当前客户端连接数；
- `TrafficManagementActive`：ElastiCache 已开始主动整形无法及时处理的命令；
- `ReplicationLag`：只读副本复制延迟；告警覆盖三个节点，主节点没有该指标时按不违规处理，从而在
  自动故障转移后仍覆盖新的副本角色；
- `EvalBasedCmdsLatency`：共享准入实际使用的 `EVAL`/`EVALSHA` 命令平均延迟。

节点指标严格使用 `CacheClusterId + CacheNodeId`。`DatabaseCapacityUsageCountedForEvictPercentage`
按照 AWS 发布的指标维度只创建一个 replication-group 级告警并使用 `ReplicationGroupId`；不得把它
伪装成三个节点指标，否则 CloudWatch 会得到没有数据的维度组合。指标名称、单位和可用性以
[AWS Valkey/Redis OSS 指标文档](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/CacheMetrics.Redis.html)
及 [CloudWatch ElastiCache 维度清单](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/SupportedMetricsForResourceTagsForTelemetry.html)
为准。

除已有安全事件告警外，容量告警均要求 3 个 60 秒窗口中的 2 个越界才触发，以过滤单点抖动；
`TrafficManagementActive` 的固定阈值为 0，即连续两个窗口出现值 1 才报警。告警与恢复都发送到值班
SNS topic，缺少指标按不违规处理。`ReplicationLag` 只对副本发布，因此该缺失策略是角色感知所必需；
监控系统本身无数据仍需由独立 CloudWatch/通知链路健康检查覆盖。

`valkey_alarm_thresholds` 是必须显式填写的非秘密容量合同，分别约束引擎 CPU 百分比、可逐出容量
百分比、单节点连接数、复制延迟秒数和 EVAL 平均延迟微秒数。示例中的 `65% / 70% / 1000 / 1s /
25000us` 只是初始保护值，不是生产认证结果。上线前必须用目标节点类型、目标区域和真实 TLS/ACL 脚本
执行稳态、阶梯、热 key、拒绝风暴与故障转移压测，再用实测饱和拐点和应用连接池总预算提交阈值变更。
CloudWatch 的 EVAL 指标是时间窗平均值，不能代替客户端 p95/p99 和 slow log。告警也不会自动扩容；
当前非 cluster-mode 架构的主写压力需要扩节点规格或经单独数据分片设计评审，不能靠增加只读副本消除。

共享准入桶和钱包经济成本桶均带 TTL，因此 ElastiCache 默认的 `volatile-lru` 不适合本系统：内存压力
逐出一个桶后，下一次请求会把它当作首次访问并恢复为满额，攻击者可把容量攻击转换成 EDoS
fail-open。模块按获批 `engine_version` 的 major 精确选择 `valkey7`、`valkey8` 或 `valkey9` parameter
group family，并强制绑定 `maxmemory-policy=noeviction`。达到内存上限时写脚本报错，API 对尚未持久化的
新经济意图返回 `503 ADMISSION_UNAVAILABLE`，不得回退到本机放行；已持久化轮次查询、ACK 与 Worker
恢复仍绕过此准入。`DatabaseCapacityUsageCountedForEvictPercentage` 告警必须在 OOM 前触发扩容/降流，
`Evictions` 仍保持零阈值告警，用于发现 parameter group 漂移。上线门禁还必须回读 replication group
实际绑定的 parameter group 及其 `maxmemory-policy`，不能只审 Terraform 源码。依据见 AWS
[逐出策略说明](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Durability.Options.html) 与
[parameter group family](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/ParameterGroups.Engine.html)。

## 共享准入 v1 到 v2 一次性维护迁移

当前 ACL 只授权 v2 的 string token-bucket keyspace 和普通桶所需的 `GET/PTTL/SET`，以及经济双桶
使用的 `TIME/MSET/PEXPIRE`。经济脚本用服务端时间回填、单条 MSET 同时更新 operator/backend，过期只
负责垃圾回收而不参与正确性；启动 canary 会真实执行整条命令链，防止只有 PING 权限时假就绪。它与旧镜像使用的 v1 hash
keyspace 及 `TIME/HMGET/HSET/PEXPIRE` 不滚动兼容：先改 ACL 会使仍在运行的旧 Pod 失败，先发布新镜像
也会被旧 ACL 拒绝。因此该协议迁移禁止作为普通 Helm rolling upgrade，且禁止临时放宽到双 keyspace 或
命令类别来制造“零停机”。为让维护事实进入同一个保存 plan 的机器校验，唯一支持的升级路径复用
`hmac-maintenance` 入口：API 零副本证据、HMAC 更新、Secret 版本精确加二以及 A/B 两个 ACL 的 v1→v2
更新必须在同一计划完成。两个 Valkey 密码、活动槽、网络和容量不得改变；普通 `steady` 或
`password-rotation` plan 中出现 ACL 变更会失败关闭。

已经运行 v2 string keyspace、但 ACL 只有 `GET/PTTL/SET` 的版本不走上述 HMAC/停机迁移。它的
v2-basic → `v2-economic` 变化只追加 `TIME/MSET/PEXPIRE`，旧 runtime 的权限是严格子集。受保护 plan
校验器只在 `steady` 状态接受 A/B 两个用户同时从唯一 v2-basic 前态变为唯一 v2-economic 后态，并要求
每个用户只有 `access_string` 改变；partial、混合/未知前态、额外权限、密码版本或 HMAC 变化全部拒绝。
发布顺序固定为：先 apply 该 additive ACL 基础设施 plan，生成含
`acl_command_profile=v2-economic` 的新 delivery，再发布经济准入 runtime；应用门禁拒绝缺失/旧 profile，
进程启动 canary 最后验证实际命令权限。该兼容扩权不能倒序，也不能被描述为 v1/v2 keyspace 迁移。

`valkey_rotation_contract` 把该状态机固定为 `acl_schema_transition=maintenance-quiesced`，同时声明
`acl_schema_rolling_compatible=false`、`acl_schema_dual_permissions_allowed=false` 和完整迁移顺序；
基础设施发布与应用发布都必须校验这些字段。这里的 `maintenanceQuiesced` 是一次性协议迁移状态，
不是可跳过的说明文字，也不授权在迁移完成后长期保留 v1 权限。

受保护生产变更必须按以下失败关闭顺序执行：

1. 冻结新 launch/spin 入口，保存当前 delivery、Deployment、HPA、镜像 digest、ACL 和可恢复 manifest；
   删除 API HPA、等待在途请求及旧连接排空，再把 API 缩到零。Worker 保持健康，因为资金恢复不得随
   准入维护停止。证据必须包含 API 零副本、旧 ReplicaSet 零副本和 Valkey 旧客户端连接已排空。
2. 以相同静默证据进入 `hmac-maintenance`，审核并应用精确包含 rotation guard、版本化 Secret、
   SecretVersion 以及两个 ACL 用户的保存 Terraform plan。校验器只接受两个用户的 `access_string`
   从唯一 v1 契约变成唯一 v2 契约，并拒绝密码、身份、标签、网络或容量夹带变化。随后用独立 plan
   退出 HMAC 维护，但保持 API 静默。保留上一签名基础设施制品生成的 v1 ACL 回退 plan，禁止把 v1
   或双协议权限重新提交到当前主线。
3. 以 API 零副本、无 HPA 发布 v2 镜像和配置，再受控启动一个 canary。live verify 必须证明 TLS/ACL
   认证、真实 `EVALSHA`（含 `NOSCRIPT` 后受限 `EVAL`）成功、只出现 v2 key，且 v1 keyspace 和旧命令
   继续被拒绝；同时核对 CloudWatch 认证/授权失败、EVAL 延迟和流量管理告警。
4. 只有 canary、钱包状态查询/ACK 绕行和 Worker 恢复全部通过后，才恢复已保存的 API 副本与 HPA，
   并完成全量 rollout/live gate。失败时维持入口冻结和 API 零副本；若必须回退，先应用受审批的 v1 ACL
   回退 plan，再恢复旧镜像，严禁只回退其中一侧。

该一次性迁移完成并保留 live evidence 后，后续 A/B 密码轮换仍按下一节执行；密码轮换不会再次改变
脚本协议或 keyspace。

## Valkey A/B 零停机密码轮换

初始配置是 A 槽活动、两个密码版本均为 1、共享准入 Secret 版本为 1。轮换必须分为三个独立变更，禁止
把“发布新槽”和“重置旧槽”合并在同一次 Terraform apply：

1. 把 `valkey_rotation_mode` 设为 `password-rotation`，保持 A 活动和 Secret v1 不变。确认没有 Pod
   使用 B 后，为 B 生成新密码、递增
   `valkey_password_version_b`，并在 `valkey_password_reset_approvals.b` 记录另一活动槽、当前 Secret
   版本、旧连接已排空、HMAC 未改变以及受控 live evidence 引用。此阶段只重置 B。
2. 保持两个密码版本不变，把 `valkey_active_slot` 切到 `b`，并把 `valkey_secret_version` 从奇数递增到
   偶数。Terraform 创建包含 B 用户名和 B 密码的新版本 Secret；应用滚动期间旧 Pod 仍可用 A 用户重连。
3. 只有发布门禁证明所有 Pod 已使用 B、A 连接已经排空后，才能递增
   `valkey_password_version_a` 并提交匹配的 `valkey_password_reset_approvals.a`。这一步撤销旧 A 密码，
   不能与第二步合并。下一轮按相反方向执行。

版本大于 1 的每个槽位都必须永久保留匹配版本的审计批准。批准对象要求：
`approved_password_version` 与槽位密码版本一致，`observed_active_slot` 必须是另一槽，
`observed_secret_version` 不得晚于当前 Secret，`old_slot_connections_drained=true`、
`hmac_key_unchanged=true`，并提供至少八字符的 `live_evidence_reference`。缺失或版本不一致时 plan
失败关闭。

受保护流水线还必须对实际保存的 plan 执行：

```sh
terraform show -json /secure/change/environment.tfplan |
  ruby ../../scripts/verify-valkey-rotation-plan.rb -
terraform apply /secure/change/environment.tfplan
```

该门禁读取 `terraform_data.rotation_guard` 的真实 before/after 状态，而不是相信 tfvars 的自我声明：
活动槽不变时只允许唯一非活动槽的密码版本和 fingerprint 精确递增；活动槽切换时禁止改变任一密码，且
Secret 版本必须精确递增 1。它稳定拒绝“声明另一槽已活动但实际重置当前活动槽”以及“同一次 apply
切槽并修改新槽密码”。部署角色必须由采用方 AWS 基础环境限制为只能应用已通过该门禁的保存 plan，禁止直接
`terraform apply` 自动重新计划。

`live_evidence_reference` 字符串本身不是真实性证明。受保护轮换流程必须先在私网集群保存带时间戳的
`kubectl rollout status`、全部 RGS Pod 使用当前不可变 shared-admission Secret、旧 ReplicaSet 为零副本
等只读证据，再由审批系统生成不可改写的变更记录引用；没有该制品不得提交槽位密码版本变更。

共享准入 HMAC key 决定限流桶键摘要的连续性。密码 A/B 轮换期间必须注入完全相同的 HMAC key；
更换它会使既有桶证明失效并造成短时配额重新开始或突发行为。HMAC 轮换必须作为独立维护变更执行，先评估
桶重置影响并取得业务批准，不能借用密码槽位退休批准。

HMAC 维护是独立的受证据状态机，不能与 A/B 密码轮换并行：

1. 独立私网静默流程先从版本化 delivery 对象确认目标，保存 API Deployment/HPA 身份与可恢复
   HPA manifest，并创建名为 `slots-hmac-maintenance-lock` 的持久 ConfigMap 锁；证据必须保存该锁 UID。
   删除 API HPA 后将 API 缩到零副本；Worker 必须保持至少一个并全部健康。流程把
   `slots-game/hmac-quiesce-attestation/v1` 规范 JSON 写入固定 KMS 加密、已开启版本的 S3 key，
   并记录精确 VersionId 和 SHA-256。证据有效期最长 60 分钟。
2. 同一份已保存 plan 必须从 `steady` 进入 `hmac-maintenance`、更换实际 HMAC 及 fingerprint，
   并把同一活动槽的 Secret 版本精确递增 2。活动槽、A/B 密码版本、密码 fingerprint 和退休批准
   必须完全不变。`valkey_hmac_maintenance_approval` 字段集只能是
   `{bucket_reset_accepted,evidence_reference{bucket,key,version_id,sha256}}`，不再接受由 tfvars 自证的
   零副本布尔值或自由文本引用。
   plan 的所有非 `no-op` 资源也必须命中精确单一变更 allowlist：入口只能是
   `module.cache.terraform_data.rotation_guard` 的 `update`、
   `module.cache.aws_secretsmanager_secret.shared_admission` 的 `create,delete` 和
   `module.cache.aws_secretsmanager_secret_version.shared_admission` 的 `delete,create`；出口只能是
   `rotation_guard` 的 `update`。RDS、EKS、IAM、网络、Valkey ACL 用户、其他 Secret 或普通配置变化
   即使证据合法也会失败关闭。Secret 同步角色使用固定账号/区域/名称前缀的
   `*-rgs-shared-admission-v*` 版本族 ARN，因此 vN 到 vN+2 不会要求在维护 plan 中夹带 IAM policy 更新。
3. 应用同一份证据校验同一份已保存 plan，不得 apply 时重新计划：

   ```sh
   terraform show -json /secure/change/hmac-maintenance.tfplan |
     ruby ../../scripts/verify-valkey-rotation-plan.rb \
       --evidence /secure/change/hmac-quiesce-attestation.json -
   terraform apply /secure/change/hmac-maintenance.tfplan
   ```

   证据必须是 key 递归排序的单行 JSON，并以一个换行结束（等价于 `jq -cS` 输出）；
   `hpa_spec_sha256` 是递归排序后的 `spec` 单行 JSON 字节串（不含末尾换行）的 SHA-256。
4. HMAC entry apply 成功后必须照常发布新版本 delivery 对象，其中
   `valkey_rotation_mode=hmac-maintenance`、`maintenance_in_progress=true` 且
   `application_release_allowed=false`；后两个布尔字段在 delivery 顶层、`application_handoff` 和
   `valkey_rotation_contract` 中必须完全一致。基础设施流水线不得因该状态拒绝交接并留下旧的
   `steady` delivery，应用流水线必须拒绝维护 delivery。
5. 另建一份不携带静默证据的已保存 exit plan，只允许清空 HMAC 维护批准并把模式从
   `hmac-maintenance` 恢复为 `steady`。apply 后必须发布引用 target Secret、新 HMAC fingerprint 且
   `maintenance_in_progress=false`、`application_release_allowed=true` 的最新 delivery；这一步不恢复
   API Pod 或 HPA。
6. 只有应用流水线的 `maintenance-complete` 模式可以完成恢复。它重新核对最新 target `steady`
   delivery、原证据/复证、持久 lock、API 零副本且无 HPA、Worker 身份与健康状态。Phase A 使用
   `--no-hooks`、非 atomic 的 Helm upgrade，只允许沿用当前镜像/数学定义/values/Worker/hooks 并提交
   target shared-admission Secret、API 零副本和无 HPA 的安全 revision；Phase B 使用
   `--no-hooks --atomic` 恢复证据中保存的 HPA，验证新 API/Worker 与 HPA fingerprint 后写 completion marker，
   最后删除精确 UID 的 lock。任一失败都必须维持或重新建立 API 零副本锁定。

显式 `resume` 只用于 Terraform entry 前中止 quiesce，且最新 delivery 仍逐字等于证据观察到的旧
`steady` 时恢复旧 HPA/API；一旦最新 delivery 已进入 `hmac-maintenance` 或已发布 target `steady`，
`resume` 必须失败关闭，只能继续 `maintenance-complete`。

静默证据生产角色才能访问私网 EKS。Terraform plan/apply 角色只获得固定证据对象的
`s3:GetObjectVersion` 与对应 KMS decrypt 权限，不得因 HMAC 维护而扩大 EKS 权限。

因此第一次 A 到 B 的发布也不能顺便改变 HMAC；离线状态机负测专门覆盖该绕过路径。

本地和 required CI 的统一门禁：

```sh
make -C infra/terraform verify
```

`verify` 会执行格式检查、静态契约、危险变体负测，并对四个环境执行 `init -backend=false` 与
`validate`。它不执行 `plan` 或访问 AWS API。

## 应用顺序

1. 采用方平台创建账号、受保护部署角色、state bucket/KMS 和集中安全能力。
2. 先应用 `prod-dr`，记录 `backup_vault_arn`。
3. 把该 ARN 写入受限的 `prod-primary.tfvars`，再评审和应用主区域。
4. 在 VPC 内受保护执行器安装配置中声明的精确版本 add-on，并使用
   `deploy/aws-production/verify-live-platform-prerequisites.sh` 校验后，才发布 Helm 应用。
5. Web 只能从已验证 OCI digest 提取到不可变 S3 release 前缀，再更新 CloudFront 发布路由。
6. 冷归档需由独立、可观测、可重试的作业启动 RDS snapshot export；未经恢复抽检不得删除在线数据。
