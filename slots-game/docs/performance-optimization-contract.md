# 高并发性能与数据生命周期契约

本文规定性能优化不能突破的资金、随机性、审计与发布边界。任何实现只有同时满足正确性门禁和
可重复的压测证据，才能进入正式环境；“减少一次数据库访问”本身不是放宽一致性的理由。

## 优化建议审计结论

| 建议 | 结论 | 仓库落地 |
| --- | --- | --- |
| Redis 分布式锁和幂等缓存 | 不采用；改为 Valkey 共享身份准入 | 当前 Valkey 只做已验证身份的跨副本新意图令牌桶；未实现 `operationId` 合并/缓存，PostgreSQL 唯一约束、行锁和持久结果仍是幂等权威 |
| 钱包调用异步化 | 拒绝伪异步成功 | 钱包确定结果仍是局提交条件；API/Worker 分离后由 Worker 对同一 operation ID 查询和恢复 |
| 审计与统计异步化 | 已采用 | 业务事务内写 PostgreSQL Outbox，独立 Worker 投递；Kafka/MSK 只能作为可选下游 |
| 数学对象全部 `sync.Pool` | 拒绝盲目池化 | 以基准和 profile 为准，当前用不可变配置复用、固定数组和连续分配将代表路径降至 22 allocs/op |
| 关闭 TLS 的轻量 Compose | 拒绝 | 日常使用包级测试与前端开发服务器；完整 Compose 保留真实 TLS、密钥和恢复语义 |
| INFO 日志采样 | 采用并收紧 | 成功访问日志默认 1%；4xx/5xx、资金审计与安全事件全量保留，采样结果有无标签指标 |
| API/Worker HPA | 采用 | 两类角色分别保留 3/2 个暖副本、独立资源 HPA/PDB/连接预算；自定义指标依赖真实适配器 |
| 自动生成素材审批 | 仅自动证据 | CI 可生成哈希差异，但不能代替独立批准；发布仍绑定不可变审批元数据及有效期 |
| 统一缩短 Helm timeout | 拒绝固定缩短 | API、Worker、Web 和基础设施分阶段交付，`atomic/wait` 超时按真实启动和回滚上界设置 |
| 数学定义原地热加载 | 拒绝原地突变 | 新版本使用新 version/hash；未来只允许原子发布不可变多版本注册表，会话始终固定版本 |
| SHA-256 动态 Salt | 不适用且拒绝 | 真实投注使用 `crypto/rand` 与无偏拒绝采样，不是可预测字段的 SHA-256 伪随机 |
| 按月分区并将三个月前数据删除 | 先测量再实施 | 先交付加密冷归档和恢复契约；只有真实查询、行数和迁移演练支持时才引入分区与删除窗口 |

## 不可改变的权威边界

1. PostgreSQL 仍是会话、局、钱包命令、结果投递游标和 Outbox 的唯一权威状态。
2. Redis/Valkey 不得决定一局是否已经扣款、是否可以重算或是否已经提交。
3. 一局结果必须在首次钱包调用前持久化；超时后只能查询或恢复同一 operation ID，不能重跑 RNG。
4. 经济审计、安全事件和钱包状态不得采样或丢弃。
5. 已批准的数学定义不可原地修改；新定义必须使用新版本和新摘要，既有会话继续绑定旧版本。

## Redis/Valkey 的允许用途

正式环境可以使用独立的 ElastiCache Valkey/Redis 集群，但仅限以下用途。当前仓库只实现第一项；
后两项只是未来允许评审的边界，并未实现，也不得写入部署或验收证据：

- **已实现：**按已验证 operator、player/session 和接口类别实施跨副本共享限流；
- **未来允许边界：**对同一 operation ID 的并发请求做短时合并或抑制，减少同时到达 PostgreSQL
  的重复流量；实施前必须证明 cache miss 不参与幂等判断并保留 PostgreSQL 权威查询；
- **未来允许边界：**缓存不可变定义和公开元数据，并以版本摘要作为 key 的组成部分；实施前必须
  增加版本隔离、失效、故障回退和加载一致性门禁。

明确禁止：

- 使用分布式锁代替 PostgreSQL 行锁、唯一约束或事务；
- 把 Redis miss 解释为“该操作尚未执行”；
- 只从 Redis 返回资金结果而不重新验证 PostgreSQL 中的持久化结果和绑定；
- 在 key/value 中保存访问令牌、签名私钥、完整玩家资料或未脱敏经济响应。

写请求的共享限流器不可用时，新的启动会话和 Spin 必须失败关闭并返回可重试的过载响应；只读健康检查、
已提交结果恢复和运维诊断应保留独立容量。Pod 内限流继续作为第二层资源保护，WAF 只负责边缘
攻击和近似速率控制，不能冒充身份级业务配额。

## 钱包与审计异步边界

- 钱包扣款属于当前局提交条件。RGS 在没有确定钱包回执时不得向客户端宣称局已完成；超时进入
  `UNKNOWN/PENDING` 后，由独立 Worker 查询并恢复同一操作。
- 审计投递继续使用“业务事务内写 PostgreSQL Outbox，事务外 Worker 投递”的方式。Kafka/MSK
  可以作为 Outbox 的下游传输，但不能替代事务内 Outbox，也不能让 API 直接双写数据库和消息系统。
- API readiness 只反映 API 自身、数据库和必要配置；审计出口积压由 Worker readiness、backlog
  指标和告警表达，不能让审计接收端抖动同时摘除所有 API Pod。

API 与 Worker 的密钥能力也随角色拆分。API 运行资产包含 launch、访问令牌、运营签名和钱包
交互所需材料；Worker 运行资产只保留定义验证、钱包请求签名、钱包响应验证和 Outbox
所需材料。Worker 进程不加载 launch HMAC、访问令牌签发私钥、运营请求验证材料或运营响应
签名私钥；禁止为了减少 Secret 数量而合并这两个权限边界。

## 内存与 GC 优化

禁止为了追求“零分配”直接把游戏状态、中奖结构或包含玩家数据的对象放入 `sync.Pool`。优化顺序为：

1. 为真实生产定义建立 `BenchmarkSpin`，记录 `ns/op`、`B/op`、`allocs/op`；
2. 使用 CPU、heap、mutex、block profile 找到占比明确的热点；
3. 优先采用预分配、固定容量数组、栈分配和减少中间编码；
4. 只有可证明是临时、无身份、可完整 Reset 的 buffer 才允许进入对象池；
5. 对池化对象执行 race、污染、异常路径归还和跨请求数据残留测试。

性能变更必须同时给出变更前后相同硬件、相同定义、相同并发和相同 Go 版本的基准。若 p95/p99、
GC pause 或总 CPU 没有实质改善，不接受仅减少微小 allocation 数的复杂化。

当前代表性基准命令为：

```sh
cd server
go test ./internal/game -run '^$' -bench '^BenchmarkEngineSpinRepresentative$' -benchmem -count=5
```

2026-08-21 在 Apple M5、Go 1.26.6 上，先移除不可变 Engine 对同一数学定义的重复完整校验，再把
三列八行的匹配临时值改为固定数组、把全部路径位置改为一次连续分配，样本从约
`6.1 µs / 14273 B / 97 allocs` 降至约 `2.8 µs / 11278 B / 22 allocs`。外部定义和持久化结果仍经过
完整校验；没有引入 `sync.Pool` 或跨请求对象复用。`TestEngineSpinRepresentativeAllocationBudget`
同时把代表性路径锁在平均不超过 32 次分配，用于拒绝明显回退。该结果只证明当前优化方向，
不是 AWS 实例或端到端吞吐承诺。

## 日志、指标和追踪

日志分为三类，保留策略不得混用：

- 经济/审计日志：完整、不可采样、带稳定事件 ID，通过 Outbox 或批准的审计链投递；
- 安全日志：认证失败、nonce 重放、完整性隔离、密钥和配置变更，完整保留并告警；
- 运行遥测：INFO/DEBUG 可以按稳定 trace ID 采样、批量压缩和设置容量预算。

WARN/ERROR 永不采样。禁止把“生产只记录 WARN/ERROR”应用到资金和安全事件。Vector/OTel 的采样、
丢弃、缓冲溢出和远端写入失败都必须暴露指标；达到磁盘或队列水位时先降级普通运行遥测。

RGS 公网访问日志已按这一边界实现：`RGS_SUCCESS_ACCESS_LOG_SAMPLE_PER_MILLION` 控制成功请求的
确定性采样，通用集群 Chart 默认 `10000`（1%），本机集成验收显式使用 `1000000`（100%）。
同一路由和安全 request ID 在所有副本上得到同一采样决定；4xx 始终写 WARN，5xx 始终写 ERROR。
`rgs_access_logs_emitted_total` 与 `rgs_access_logs_dropped_total` 只记录无标签总量，不能加入玩家、
会话、轮次或 request ID 标签。该机制只影响普通 HTTP 访问记录，不影响 PostgreSQL Outbox、经济审计、
认证失败和完整性隔离指标。

nonce 重放作为独立安全事件永不采样。内部只输出固定 `security_event=nonce_replay` 的 WARN
记录和无标签 `rgs_auth_replays_total` 计数器，禁止记录 nonce、运营商、密钥、玩家、会话或请求
标识。`SlotsRGSAuthReplay` 使用 `increase(rgs_auth_replays_total[5m]) > 0`，五分钟内任一增量
都必须进入安全告警路由。

AWS 正式路径不部署本机 Vector。容器 stdout/stderr 由公司节点级 OTel/CloudWatch 管道采集；管道仍
必须对自身积压、丢弃、重试和归档失败告警。禁止再在 Vector 或下游对已经受控的 WARN/ERROR、资金
和安全事件做第二次概率采样。

## 本地开发与完整集成验收

`deploy/local-production` 是 TLS、最小数据库角色、钱包恢复、审计、监控、备份恢复和浏览器会话的
完整集成验收栈，不是每次编辑都必须启动的开发骨架。日常开发优先运行包级 Go 测试、PostgreSQL
conformance、`make web` 和定向浏览器门禁；只有跨服务、发布候选或本机试玩才启动完整 Compose。

仓库不提供“关闭 TLS、跳过证书或免凭据”的第二套 Compose。此类配置很容易被误当作生产模板，
也无法发现本项目曾真实遇到的钱包根 CA、CSP、一次性交接和跨 chunk 初始化故障。减轻本机负担的
方式是减少启动范围和复用依赖缓存，而不是复制一套安全语义不同的服务定义。

## 弹性与预热

RGS API 与 Worker 使用独立 HPA。仓库基线使用 Kubernetes 原生 CPU/内存资源指标，API 保留三个
暖副本，Worker 保留两个暖副本并采用更慢的扩容和缩容窗口，避免恢复流量脉冲击穿钱包或审计下游。
两个受管 Deployment 都不写 `spec.replicas`，暖副本下限仅由各自 HPA `minReplicas` 控制，避免
Helm 升级把 HPA 当前副本期望值改回静态值。
平台若已交付并动态验证 Prometheus Adapter 或等价指标源，可再加入 API inflight、请求速率、延迟
和数据库等待，以及 Worker 钱包 pending、Outbox backlog 年龄和处理速率；没有适配器、查询规则、
指标缺失回退与压测证据时不得在 Chart 中伪造这些外部指标。

两类工作负载都必须配置 startupProbe、readinessProbe、PDB、跨 AZ topology spread 和受控的
scale-up/scale-down behavior。正式环境的 HPA 上限还必须受钱包、审计、Valkey 和数据库批准容量
共同约束，不能只因 CPU 可扩就继续增加副本。

任何 HPA 上限变更必须重新计算滚动发布、终止重叠、migrator、Worker、DBA 和应急连接预算，不能
只按稳定副本数计算 RDS `max_connections`。

## 发布审批与数学定义

- CI 可以自动生成素材路径、字节数和 SHA-256 差异证据，但不能自动代表独立审批人批准。紧急修复
  走单独的受保护流程，仍需可追溯审批、不可变制品和回滚点。
- Helm 等待时间按组件实际启动和回滚上界确定。缩短超时不能解决慢启动；应拆分 Web、API、Worker
  发布并使用 canary/blue-green 和明确的 stop condition。
- 当前进程只加载一个不可变获批定义。`release.definitionIdentity` 的 `gameID/version/sha256` 会写入
  API/Worker Pod template annotation 和 `RGS_EXPECTED_DEFINITION_*`；进程完成签名验证和加载后
  对实际定义逐项比对，不符即拒绝启动。Helm `lookup` 与 AWS 应用部署工作流还会在升级
  前把现网 API/Worker 与候选三元组比较；任一变化必须走维护窗口或独立定义分群。
- `release.compatibilityClass=same-schema-and-definition` 是必填声明，不能替代现网、候选和进程实际加载
  值的三层检查。未来如需无停机数学升级，必须另行实现并认证不可变多版本注册表和会话路由；
  `atomic.Value` 只可发布完整不可变快照，不能在原版本下替换赔率或转轴。

## RNG 决策

生产随机源继续使用操作系统支持的 Go `crypto/rand` 和无偏拒绝采样。当前 RNG 不是“可预测输入做
SHA-256”的方案，因此不加入每几分钟轮换的自定义 salt。自行叠加 salt 会增加密钥生命周期和审计
复杂度，却不能修复已经失陷的熵源。

如未来引入经批准的 HSM/KMS DRBG，必须记录算法版本和熵健康状态，并证明不会在重试、故障转移或
多副本下重用流；仍然禁止根据请求字段确定性生成真实投注结果。

## 分区、归档与冷存储

不能直接把现有资金表改成月分区后上线。先根据真实行数、索引大小、查询条件和 `EXPLAIN` 证据确定
分区键，再使用 expand/copy/双读验证/cutover/rollback 迁移。候选对象包括历史局、已完成钱包流水和
已发布 Outbox；活跃会话、未确认结果、pending/unknown/manual-review 和完整性隔离记录不得归档。

冷归档必须：

- 使用独立只读归档任务和最小数据库角色；
- 生成记录范围、行数、schema version、对象摘要和 manifest；
- 写入启用版本化、KMS、保留策略和跨账号备份的 S3；
- 上传并校验后先 detach/标记，经过批准保留窗口后才允许删除热数据；
- 定期从归档恢复到隔离环境，验证行数、摘要、外键关系和经济不变量。

“三个月”不是源码默认值。热数据窗口、归档周期、法定保留和删除权限必须由正式 RPO/RTO、查询
模式和公司保留政策决定。

## 上线证据

每次性能发布至少归档以下内容：

- 相同候选制品下的基准、分级负载和 24 小时稳定性结果；
- p50/p95/p99、错误率、GC、CPU、内存、连接池和 Redis/数据库命中证据；
- 钱包延迟/超时、Redis 故障、审计下游故障、Pod 驱逐和 RDS failover 演练；
- 重复 operation ID 并发、RNG 不重算、Outbox 至少一次和结果恢复不变量；
- 日志量、采样率、丢弃量、热库增长、归档恢复和成本变化。

缺少基准或故障证据时，优化只能停留在实验分支，不能用理论吞吐替代正式上线验收。

## 设计依据

- Go `crypto/rand` 提供由操作系统熵源支持、可并发使用的密码学安全随机数：
  <https://pkg.go.dev/crypto/rand>
- `sync.Pool` 只适合可随时丢弃、可被多个调用方安全复用的临时对象，池内对象也可能在任何时刻被移除：
  <https://pkg.go.dev/sync#Pool>
- Kubernetes HPA `autoscaling/v2` 支持资源、自定义和外部指标，并要求对启动期指标与扩缩行为显式建模：
  <https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/>
- PostgreSQL 分区能改善特定访问模式，但分区键、裁剪、约束和维护策略必须按真实查询设计：
  <https://www.postgresql.org/docs/current/ddl-partitioning.html>
