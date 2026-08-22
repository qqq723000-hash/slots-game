# 变更记录

本项目采用语义化版本。每个正式版本必须绑定 Git 提交、OCI 镜像摘要、SBOM、来源证明、
签名结果、数据库迁移清单和前端发布清单；仅修改标签不得形成新版本。

## 未发布

- 将第三方钱包升级为版本化 v2 结算契约：持久化钱包会话、命令摘要、能力与账本路由绑定，严格区分
  `SUCCEEDED/REJECTED_FINAL/PENDING/NOT_FOUND/CONFLICT/UNKNOWN/NOT_SENT`，并由签名响应绑定完整经济身份；
- 新增 PostgreSQL `0008/0009`：按数据库时钟持久化 APPLY/LOOKUP 恢复阶段、租约围栏、公平跳锁领取、
  钱包账本外呼前预检及热路径索引；该变更不支持新旧 writer 混跑，必须静默 API/Worker 后迁移；
- 为慢钱包增加 backend/operator 舱壁、独立熔断、有界一秒快路径与 Worker 恢复；为 API 新意图增加
  PostgreSQL critical reserve，status/result/ACK/refresh 不占新意图许可；
- 将 Valkey 共享准入升级为 v2 单字符串桶：允许请求一次写、拒绝请求零写、NOSCRIPT 单飞恢复，
  launch/spin 按已验证 operator 分桶；ACL v1→v2 只允许在有 API 零副本证据的 HMAC 维护 plan 中迁移；
- 前端对 429/503、`Retry-After`、同步最终拒绝和待恢复账本执行有界同请求重试，并为 ACK/状态轮询加入
  不改变截止时间的分布式抖动，降低大规模客户端同步重试波峰；
- 新增 HTTP、PostgreSQL、Valkey 三类显式高并发入口；每次报告使用唯一临时文件、固定 schema、批准
  阈值和功能不变量校验后才原子发布到 ignored `.artifacts`，本机结果不替代 AWS/第三方/24h soak；
- 增加 Valkey 引擎 CPU、容量、连接、复制延迟、流量管理和 EVAL 延迟 CloudWatch 告警，以及数据库
  双组件维护静默状态；真实 AWS apply、Multi-AZ failover 和外部钱包认证仍是上线门禁；
- 将正式交付主线改为 AWS，并增加四环境应用 IaC：VPC/EKS、RDS Multi-AZ、ElastiCache Valkey、
  不可变 ECR、Secrets Manager 元数据、私有 S3/OAC/CloudFront、AMP/CloudWatch、备份和归档基线；
  账号工厂、远端 state/部署身份、DNS/证书/WAF 与组织级安全仍由企业落地区提供；
- 增加基础设施、应用发布和 HMAC 静默证据三个 AWS workflow 源码，使用 OIDC、已保存 Terraform
  plan、版本化 delivery 与失败关闭门禁；这些能力仍须在真实目标账号完成 plan/apply 和验收；
- 将同一 RGS 制品拆成可独立扩缩的 API/Worker 运行角色，交付独立 HPA/PDB/Secret/NetworkPolicy，
  并保持 PostgreSQL 对会话、轮次、钱包结果和 `operationId` 幂等的唯一权威；
- 增加 API + Valkey 的已验证身份共享准入：只拦截新启动/Spin 意图，使用 TLS、A/B ACL 与 HMAC
  键摘要，故障时失败闭合且不把缓存提升为资金权威；
- 增加 Valkey A/B 密码轮换和 HMAC 静默维护状态机；HMAC entry/exit 后由应用
  `maintenance-complete` 两阶段切换，禁止用旧 delivery 的 `resume` 恢复旧 HMAC Pod；
- 成功访问日志默认确定性采样 1%，4xx/5xx、资金审计和安全事件全量保留；补充低基数采样指标、
  API/Worker HPA 与共享准入故障告警；
- 以基准驱动复用不可变数学配置、固定数组和连续分配，将代表 Spin 路径从 97 降至 22 allocs/op；
  不采用未经 profile 证明的 `sync.Pool` 或伪“零分配”承诺；
- 增加加密、版本化、对象锁定的 S3 冷归档基线与 RDS export 角色；自动快照导出编排、数据库分区
  切换和真实恢复演练仍是上线前平台职责，不宣称仓库已定时执行；
- 补齐 AWS/通用集群/本机集成验收的分层部署契约、树状架构、失败关闭校验与运维边界；
- 修复 Pixi、Spine、renderer 与 reels 跨分块循环导致的浏览器启动失败，并把真实 Chrome
  会话、严格 CSP 和画布就绪纳入必需门禁；
- 增加确定性第三方许可清单、发布清单绑定和镜像交付校验；
- 删除重复素材与旧本机 helper 路径，统一复用正式运行素材和独立容器 helper；
- 本机 Docker Compose 明确降级为开发与集成验收环境，不再作为正式生产证据。

## 1.0.0 - 2026-08-16（仓库声明撤回，不可上线）

该版本仅保留为历史源码候选。它未完成 AWS 正式交付重构与受保护供应链发布，仓库政策已将其
声明为撤回，不得部署到生产、交付运营或作为正式发布证据。交付管理员仍须在目标 Git 托管平台
核对并撤回/删除同名远端 tag 与 Release；该远端清理完成并留证前，不得宣称发布平台已撤回。
以下内容只记录当时已实现的能力边界。

### 核心能力

- Go 权威 RGS、独立迁移器、PostgreSQL 持久化会话/轮次/nonce/结果游标和事务性发件箱；
- 幂等钱包命令、未知结果恢复、服务端 RNG 与数学定义审批绑定；
- TypeScript/PixiJS 表现层、严格 RGS 启动交接、待交付结果恢复和展示后幂等确认；
- 独立公共与运维监听器、认证就绪探针、低基数指标、结构化脱敏日志和有界资源读取；
- Prometheus、Grafana、Alertmanager、Vector、备份、隔离恢复验证和本机集成验收编排；
- Kubernetes Helm 交付：RGS/Web 多副本、HPA、PDB、三可用区分散、默认拒绝网络策略、
  一次性迁移 Hook、外部 Secret 与 ServiceMonitor；
- 固定工具链与镜像摘要、密钥/漏洞扫描、SPDX/CycloneDX SBOM、来源证明、签名和发布门禁；
- 全仓关键人工注释中文化，并以自动契约阻止仅英文注释回归。

### 发布边界

- 当前受保护的集群制品仅支持 `linux/amd64`；Chart 会拒绝 ARM64 调度；
- 普通 RGS 滚动升级只允许数据库模式和数学定义身份完全不变的版本；
- 数据库模式或数学定义变更必须使用经过评审的协调切换流程；
- Web 稳定路径资源升级必须由蓝绿发布或带版本前缀的 CDN 隔离，不能依赖新旧 Pod 混部；
- 本机 `local-operator` 仅用于集成验收，不属于公司集群运行依赖。
