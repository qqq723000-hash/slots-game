# High-concurrency performance and data-lifecycle contract / 高并发性能与数据生命周期契约

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

## English summary / 英文摘要

This contract defines the economic, randomness, audit, recovery, and release invariants that performance work must not weaken. PostgreSQL and the durable wallet workflow remain authoritative, Valkey is limited to verified new-intent admission, and asynchronous work must preserve the same stable operation identity and terminal result instead of returning invented success. Repository benchmarks and profiles are engineering evidence only; production thresholds, wallet capacity, database and cache sizing, cloud scaling, retention, failover, controlled load tests, and regulatory performance acceptance must be approved in the target environment.

本文规定性能优化不能突破的资金、随机性、审计与发布边界。任何实现只有同时满足正确性门禁和
可重复的压测证据，才能进入正式环境；“减少一次数据库访问”本身不是放宽一致性的理由。

## 优化建议审计结论

| 建议 | 结论 | 仓库落地 |
| --- | --- | --- |
| Redis 分布式锁和幂等缓存 | 不采用；改为 Valkey 共享身份准入 | 当前 Valkey 只做已验证身份的跨副本新意图令牌桶；未实现 `operationId` 合并/缓存，PostgreSQL 唯一约束、行锁和持久结果仍是幂等权威 |
| 钱包调用异步化 | 采用“有界快路径 + 持久恢复”，拒绝伪异步成功 | API 最多等待一秒钱包快路径；未终态返回 202，Worker 按持久 `APPLY/LOOKUP` 动作恢复同一 operation ID，只有签名终态才能提交 |
| 钱包失败隔离 | 已采用进程内非阻塞舱壁和独立熔断 | 后端共享 apply/lookup 容量、运营商 apply 容量、预 RNG 准入和固定低基数指标；集群总容量仍由 HPA 上限与钱包合同约束 |
| 审计与统计异步化 | 已采用 | 业务事务内写 PostgreSQL Outbox，独立 Worker 投递；Kafka/MSK 只能作为可选下游 |
| 数学对象全部 `sync.Pool` | 拒绝盲目池化 | 以基准和 profile 为准，当前用不可变配置复用、固定数组和连续分配将代表路径降至 22 allocs/op |
| 关闭 TLS 的轻量 Compose | 拒绝 | 日常使用包级测试与前端开发服务器；完整 Compose 保留真实 TLS、密钥和恢复语义 |
| INFO 日志采样 | 采用并收紧 | 成功、4xx/5xx 与重复安全 WARN 都有固定写入预算；资金审计和安全事件无标签计数全量保留，所有丢弃都有固定指标 |
| API/Worker HPA | 采用 | 两类角色分别保留 3/2 个暖副本、独立资源 HPA/PDB/连接预算；自定义指标依赖真实适配器 |
| 自动生成素材审批 | 仅自动证据 | CI 可生成哈希差异，但不能代替独立批准；发布仍绑定不可变审批元数据及有效期 |
| 统一缩短 Helm timeout | 拒绝固定缩短 | API、Worker、Web 和基础设施分阶段交付，`atomic/wait` 超时按真实启动和回滚上界设置 |
| 数学定义原地热加载 | 拒绝原地突变 | 新版本使用新 version/hash；未来只允许原子发布不可变多版本注册表，会话始终固定版本 |
| SHA-256 动态 Salt | 不适用且拒绝 | 真实投注使用 `crypto/rand` 与无偏拒绝采样，不是可预测字段的 SHA-256 伪随机 |
| 按月分区并将三个月前数据删除 | 先测量再实施 | 先交付加密冷归档和恢复契约；只有真实查询、行数和迁移演练支持时才引入分区与删除窗口 |
| 按玩家 ID 哈希路由的钱包内存无锁扣减 | 拒绝作为资金权威 | 玩家余额只由运营商钱包的一条原子、幂等命令改变；进程内存和 Valkey 都不能替代持久账本、签名回执与未知结果查询 |
| WebSocket + 自定义 Protobuf 替换全部 HTTP | 不按形式采用 | 当前 HTTPS 协议具备固定超时、签名、幂等、202 持久恢复和状态查询；只有真实延迟/带宽证据证明收益且保留相同恢复语义时才评审版本化 WebSocket 传输 |
| Web Worker 计算赢分和赔率 | 拒绝经济逻辑下放 | 浏览器只表现服务端权威矩阵和派彩；Worker 只能用于无经济语义的资源获取、解码或视觉计算，不能生成或修正中奖结果 |
| KMS 作为硬件随机数发生器 | 更正边界 | 游戏进程使用操作系统密码学随机源并失败关闭；KMS 管理密钥与签名材料，不能被文档描述成已接入的独立 RNG 熵源，RNG 仍需目标司法辖区认证 |
| 浏览器指纹、反调试、蜜罐变量和内存修改检测 | 拒绝作为安全边界 | 这些机制可绕过并引入隐私、无障碍和兼容风险；安全边界是服务端权威、短时令牌、严格协议、CSP、资源完整性和风控接口，设备信号只能经隐私评审后由外部风控提供 |
| Big Win 双私钥签名 | 拒绝重复签名表象 | 大奖与普通局使用同一权威结果签名、钱包回执校验、持久结果哈希和审计 Outbox；高额派奖可进入人工审核状态，但不通过任意叠加签名次数冒充更强正确性 |
| Big Win / Free Spins / Wheel 视觉资源真正按需加载 | 仓库已完成，目标设备待验收 | 默认 `on-demand` 在权威结果校验后、状态转换前启动真实事件租约；消费者直接使用大小/SHA-256 已校验 bytes。Free Spins 租约跨完整模式保留，Wheel/Big Win 保留到展示结束；取消、销毁、并发去重、固定脱敏失败与 GPU 对象身份清理已有测试。共享 atlas 与交互音频仍作为依赖单列，不能冒充独占首启节省 |
| CloudFront HTTP/3 | 已采用并保留回退 | Web distribution 显式使用 `http2and3`；静态契约、负向变异和目标账号实时回读都会拒绝退回仅 HTTP/2，真实网络收益仍需 RUM 验收 |

## 不可改变的权威边界

1. PostgreSQL 仍是会话、局、钱包命令、结果投递游标和 Outbox 的唯一权威状态。
2. Redis/Valkey 不得决定一局是否已经扣款、是否可以重算或是否已经提交。
3. 一局结果必须在首次钱包调用前持久化；超时后只能查询或恢复同一 operation ID，不能重跑 RNG。
4. 经济审计、钱包状态和安全事件权威计数不得采样或丢弃；为抵抗日志管道背压，重复物理安全日志可以按固定预算降载，但必须留下无标签丢弃计数。
5. 已批准的数学定义不可原地修改；新定义必须使用新版本和新摘要，既有会话继续绑定旧版本。

共享准入保持每次调用一次 Lua RTT。v2 桶把令牌与写入时 TTL 基准压成一个 `cmsgpack` 字符串，经过
时间由 Valkey 服务端 `PTTL` 推导，不使用 Pod 时钟。允许请求仅执行一次 `SET PX`，被限流请求不写
状态；相较旧实现，已有桶的允许路径由 4 个 Lua 内部命令/2 次数据写降为 3/1，拒绝路径降为 2/0。
身份经 HMAC 后形成单键 Cluster hash tag，不暴露运营商或会话标识；共享 launch/spin 使用两个相互
独立、按已验证 operator 聚合的桶，本机限流仍按 session 隔离。这避免爆款通过大量 session 把共享
额度乘开，同时不让 launch 挤占 spin 配额。完整回填 TTL 被配置层和脚本双重限制在 24 小时以内，
避免极低速率与巨大 burst 产生近乎永久的键。Valkey 故障、脚本状态损坏或协议响应异常始终
fail-closed，且 Valkey 仍不保存资金、轮次、钱包终态或幂等权威。

### 共享准入算法历史对照（2026-08-23）

以下是同一台 arm64 开发机上 Docker Desktop 29.6.1、Valkey 8.1.9 一主一副本、Go 1.26.6 的一次
可复现观测；每格 200,000 次请求，共 2,400,000 次，单条 multiplexed 连接，持久化关闭。这是
令牌桶 v1/v2 写放大的历史算法对照，不再代表当前生产传输配置；当前客户端禁用自动管线并
使用有界同步连接，见下一节。该环境是
loopback 明文连接，没有 ACL/TLS、ElastiCache、跨可用区网络或真实节点故障，因此只是实现级对照，
不是生产容量认证。

| 场景 | 并发 | v1 → v2 ops/s | v1 → v2 p99 | v1 → v2 状态写/请求 | v1 → v2 单副本流字节/请求 |
| --- | ---: | ---: | ---: | ---: | ---: |
| steady / 4,096 keys | 16 | 50,812 → 54,710 | 527 → 470 µs | 2 → 1 | 215.46 → 95.73 |
| step | 1 → 64 | 18,178 → 18,556 | 833 → 732 µs | 2 → 1 | 206.00 → 91.00 |
| hot key | 64 | 125,534 → 136,748 | 776 → 774 µs | 2 → 1 | 212.00 → 94.00 |
| 200,000 identities | 64 | 119,848 → 136,422 | 894 → 947 µs | 2 → 1 | 228.89 → 102.44 |
| deny storm / 同一 operator | 64 | 119,657 → 158,600 | 899 → 645 µs | 2 → 0.00033 | 211.88 → 0.031 |
| SCRIPT FLUSH + NOSCRIPT | 64 | 114,956 → 130,484 | 931 → 785 µs | 2 → 1 | 237.46 → 106.73 |

所有场景应用错误、意外服务端错误、拒绝连接和新增连接均为 0，观测客户端连接数始终为 1、在线副本
至少为 1；复制字节来自 primary 的逻辑 replication offset，每增加一个副本都要另计网络传输。NOSCRIPT 场景
刻意产生 64 个服务端 NOSCRIPT 回复，但生产 executor 把完整 Lua body 执行从 64 次合并为 1 次
（60,928 → 1,620 bytes），应用错误仍为 0。`many_identity` 与 `deny_storm` 使用相同 20/s、burst 40：
按 operator 聚合后由 200,000 个键/200,000 次 v2 写入变为 1 个键/65 次写入，并只放行 65 个新意图。

最终门禁运行中，v2 在 `many_identity` 的单次 p99 回退 53 µs，虽然吞吐和写放大均改善，因此仍不能
用上表设置正式 SLO。负载实现位于
`server/internal/sharedadmission/load_test.go`，门禁封装为 `server/scripts/valkey-high-concurrency.sh`，统一
opt-in 入口为 `make profile-valkey-high-concurrency`；

### 有界同步传输复验（2026-08-24）

当前生产执行器禁用 valkey-go 自动管线，应用层四许可闸门限制进入依赖池的命令，
另有一条依赖构造时保留但不承载业务自动管线的基础 socket；所以每 API Pod 同时最多四条
业务命令、五条 TCP 连接。同一开发机和一次性 Valkey 8.1.9 主/副本上，官方门禁每场景/
版本 50,000 次，合计 600,000 次，持久化关闭。下表是当前 optimized v2 结果：

| 场景 | 并发 | ops/s | p99 | 状态写/请求 | 单副本流字节/请求 |
| --- | ---: | ---: | ---: | ---: | ---: |
| steady / 4,096 keys | 16 | 5,921 | 4,185 µs | 1 | 95.71 |
| step | 1 → 64 | 4,218 | 14,290 µs | 1 | 91.00 |
| hot key | 64 | 7,648 | 13,384 µs | 1 | 94.00 |
| many identity | 64 | 7,615 | 12,798 µs | 1 | 128.92 |
| deny storm | 64 | 9,439 | 10,020 µs | 0.0029 | 0.272 |
| SCRIPT FLUSH + NOSCRIPT | 64 | 7,824 | 11,359 µs | 1 | 106.71 |

六个场景均为零应用错误、零意外服务端错误、零拒绝连接、零新建连接，`INFO clients`
始终精确为 5，在线副本为 1。NOSCRIPT 场景的 63 个并发 miss 只有 1 次完整 Lua body；
拒绝风暴 50,000 次只有 145 次状态写。与历史自动管线数据相比，这个硬边界牺牲了本机吞吐；
它换来的是 context 超时、在途命令和连接数可证明有界，不允许用历史数字声称当前传输吞吐。

另一项真实 TCP 故障回归让 peer 完成 RESP 握手后不再回复，同时发起 1,100 个经济 EVAL；
所有调用在 250ms deadline 加 250ms 余量内返回，peer 最多看到四条在途业务命令/五条 TCP
连接，故障 socket 关闭后新 PING 恢复，等待者 goroutine 回落到基线容差内。这个测试专门阻断
valkey-go v1.0.67 自动管线 ring/ctx 与同步池超时计数竞态的回归。

直接调用测试而不提供阈值时会明确输出 `report-only`，Make 入口则强制要求阈值，并将稳定 JSON 原子
写入 ignored `.artifacts/high-concurrency/valkey-report.json`。正式环境必须通过
`RGS_SHARED_ADMISSION_LOAD_THRESHOLDS_JSON` 为六个场景同时提供 `min_ops_per_second` 与
`max_p99_us`，否则结果不能成为发布门禁。命令示例：

```bash
RGS_SHARED_ADMISSION_LOAD_ADDR=127.0.0.1:16379 \
RGS_SHARED_ADMISSION_LOAD_REQUESTS=50000 \
RGS_SHARED_ADMISSION_LOAD_ALLOW_DESTRUCTIVE=YES \
RGS_SHARED_ADMISSION_LOAD_EXPECTED_RUN_ID='<disposable INFO server run_id>' \
RGS_SHARED_ADMISSION_LOAD_THRESHOLDS_JSON='{"steady":{"min_ops_per_second":5000,"max_p99_us":10000},"step":{"min_ops_per_second":3500,"max_p99_us":25000},"hot_key":{"min_ops_per_second":5000,"max_p99_us":25000},"many_identity":{"min_ops_per_second":5000,"max_p99_us":25000},"deny_storm":{"min_ops_per_second":5500,"max_p99_us":25000},"failover_noscript":{"min_ops_per_second":5000,"max_p99_us":25000}}' \
make profile-valkey-high-concurrency
```

该测试会执行 `FLUSHDB` 和 `SCRIPT FLUSH`。代码与入口同时要求 `YES` 双确认、仅 loopback 地址、
与目标 `INFO server` 精确匹配的 40 位 `run_id`、空数据库、唯一客户端以及至少一个副本；任一条件
不满足都会在首个破坏性命令前失败。不得把生产、共享开发或远程 ElastiCache 地址用于此入口。

`failover_noscript` 只执行 `SCRIPT FLUSH`，不等价于 ElastiCache Multi-AZ failover。正式验收仍需在启用
TLS/ACL 的预生产复制组上使用批准阈值，并另做主节点切换、连接重建和复制积压演练。数据键虽为单键
Cluster slot 安全格式，当前客户端明确 `ForceSingleClient`，只支持仓库约定的 cluster-mode-disabled
主端点；不能据此宣称已支持 cluster-mode-enabled 拓扑发现与 MOVED 重定向。

v2 同时改变键命名空间、状态编码、命令权限和 spin 聚合维度；旧 Pod 只会访问 v1，v2 Pod 只会访问
v2，因此 ACL 与镜像不存在安全的普通滚动先后顺序。正式迁移必须进入 `maintenanceQuiesced`，并严格
执行：停止新 launch/spin → 排空旧 API Pod 和旧连接 → 用同一静默证据进入 `hmac-maintenance`，在
唯一保存 plan 中完成 HMAC/版本化 Secret 与 A/B ACL v1→v2 的精确变更 → 独立退出维护 → 启动 v2 API 镜像 →
验证 TLS/ACL、`EVALSHA`/受限 `EVAL`、v2 key 与恢复绕行 → 恢复新意图。状态查询、ACK 和 Worker 资金
恢复在维护期间保持可用。禁止永久保留 v1+v2 双 keyspace/命令权限，也禁止 ACL 与旧/新 Pod 重叠。
Terraform 的 `valkey_rotation_contract` 固定发布 `acl_schema_transition=maintenance-quiesced`、
`acl_schema_rolling_compatible=false`、`acl_schema_dual_permissions_allowed=false` 与上述顺序，发布门禁
不仅校验这些字段，还会拒绝普通 steady/password plan 的 ACL 变化，且只接受有 API 静默证据的 HMAC
入口同时精确更新两个 ACL 用户。仓库没有把该外部一次性发布编排伪装成代码内自动迁移能力。

### HTTP 背压与客户端重试本地证据（2026-08-23）

公网新 launch/spin 在认证与共享准入后、任何 nonce/经济事务前取得进程内数据库许可。默认 API
连接池为 20，最多同时保留 15 个新意图许可，另外 5 个连接预算用于 status、pending result、ACK
和 refresh；容量不足返回固定 `CAPACITY_UNAVAILABLE` 与 `Retry-After`，不创建 RNG、round 或钱包
副作用。该许可限制的是新意图工作流，不替代 RDS 总连接预算、数据库代理或查询优先级。

回环 HTTP profile 使用真实 JSON 解码、access-token 验证、响应签名和容量拒绝编码，但使用无副作用
coordinator，并且不包含 PostgreSQL、Valkey、钱包网络、TLS、Ingress 或 HPA。Apple M5 / Go 1.26.6
的一次显式本地阈值运行结果如下：

| 场景 | 请求/并发 | 结果 | 吞吐 | p99 |
| --- | ---: | --- | ---: | ---: |
| steady | 10,000 / 32 | 10,000 成功、0 失败 | 21,884/s | 4.68 ms |
| step | 10,000 / 128 | 10,000 成功、0 失败 | 39,275/s | 13.36 ms |
| capacity shed | 5,000 / 128 | 310 成功、4,690 个签名 503、0 失败 | 41,776/s | 12.64 ms |

拒绝场景的吞吐包含快速 503，不能解释为可结算 TPS。入口要求同时给出本机批准的吞吐与 p99
阈值，测试名也会在运行前精确核验，避免 `go test -run` 在测试被改名后零测试假绿：

```sh
RGS_HTTP_LOAD_REQUESTS=10000 \
RGS_HTTP_LOAD_MIN_OPS_PER_SECOND=10000 \
RGS_HTTP_LOAD_MAX_P99_MS=100 \
make profile-http-high-concurrency
```

前端恢复调度在指数退避与 `Retry-After` 下界之上增加最多一秒可注入抖动；固定 deadline、最大
尝试次数、operation/round 和请求 body 均不变。10,000 个确定性客户端样本覆盖 100 个 10ms 桶，
用于拒绝同步重试波峰回归；它是分布函数测试，不等价于 10,000 个真实浏览器、真实网络或真钱负载。
HTTP 报告默认写入 ignored `.artifacts/high-concurrency/http-report.json`，只可由 CI/受控发布系统
归档，禁止把本机报告、token 或环境凭据提交到 Git。

## Redis/Valkey 的允许用途

正式环境可以使用独立的 ElastiCache Valkey/Redis 集群，但仅限以下用途。当前仓库只实现第一项；
后两项只是未来允许评审的边界，并未实现，也不得写入部署或验收证据：

- **已实现：**本机按已验证 operator/session 隔离，跨副本对 launch/spin 分别按已验证 operator 聚合限流；
- **未来允许边界：**对同一 operation ID 的并发请求做短时合并或抑制，减少同时到达 PostgreSQL
  的重复流量；实施前必须证明 cache miss 不参与幂等判断并保留 PostgreSQL 权威查询；
- **未来允许边界：**缓存不可变定义和公开元数据，并以版本摘要作为 key 的组成部分；实施前必须
  增加版本隔离、失效、故障回退和加载一致性门禁。

明确禁止：

- 使用分布式锁代替 PostgreSQL 行锁、唯一约束或事务；
- 把 Redis miss 解释为“该操作尚未执行”；
- 只从 Redis 返回资金结果而不重新验证 PostgreSQL 中的持久化结果和绑定；
- 在 key/value 中保存访问令牌、签名私钥、完整玩家资料或未脱敏经济响应。

写请求的共享限流器不可用时，新的启动会话和 Spin 必须失败关闭并返回可重试的过载响应；已提交结果恢复
应保留独立容量。只读健康检查和运维诊断只存在于受限 operations 监听器，公网监听器不得暴露 `/healthz`
形成匿名旁路。Pod 内限流继续作为第二层资源保护，WAF 只负责边缘
攻击和近似速率控制，不能冒充身份级业务配额。

## PostgreSQL 写入压力与扩展边界

当前实现能横向扩展 API/Worker 计算，但不会声称单个 PostgreSQL 写主库可以无限扩展。每个会话的
轮次必须按顺序锁定和提交，这是资金与特性状态的真实串行点；把同一会话的写请求并发化只会把排队
从应用搬到锁管理器，不能提高正确吞吐。跨会话吞吐由连接预算、短事务、`SKIP LOCKED` 批量领取、
API/Worker 分离和 Valkey 新意图背压共同保护。

连接池代理和只读副本能降低连接建立与查询压力，但不能增加主库 WAL/索引/锁写容量。达到经压测
批准的主库上限前，应依次执行：限制新意图、为状态读取和恢复保留容量、降低 HPA 最大副本、扩容
主库并优化已证实热点。只有单主库在批准峰值与故障余量下仍不够时，才评审按稳定
`operatorId + currency`（或等价不可变租户边界）分片。分片必须保证一个会话、轮次、钱包账本和其
Outbox 永远落在同一 shard，并提供版本化路由、迁移双重校验、跨 shard 对账和故障回退。

仓库目前**未实现数据库分片**，也没有把跨 shard 资金事务包装成已完成能力。消息队列、读副本、
Redis 锁和表分区都不能替代这一写权威设计：消息队列负责吸收非同步下游，分区负责生命周期与特定
查询，二者都不会凭空提供跨钱包和数据库的原子提交。

### PostgreSQL 热路径实测与第二轮取舍（2026-08-22）

本轮没有异步化资金写入、删除账本或放松幂等。`PrepareRound` 仍在一个事务中先锁 session、检查
round identity，再原子写 round、wallet ledger、session pending cursor 与 Outbox。优化只把 session
锁、待交付检查和数据库时钟合并为一次往返，并用 data-modifying CTE 合并四项写入；成功路径的
SQL 语句契约由 8 条降为 3 条（不含 `BEGIN/COMMIT`，减少 62.5% 往返）。严格 sqlmock 用例锁定
这三条语句及参数；报告中的数字是代码/测试契约，不冒充运行时采样计数。

`0009_postgres_hot_path` 同时做了以下索引收敛：

- 为外呼前 wallet ledger 完整性核验增加
  `(operator_id, session_id, round_id, transaction_id)` B-tree。查询带 `FOR UPDATE`，必然要访问 heap
  加行锁，因此第二轮删除无收益的 `INCLUDE` 列，避免伪装成 index-only scan 并控制索引写放大；
- 删除已被精确恢复到期索引取代的 `rgs_rounds_recovery`，以及与新 claim 索引重复的
  `rgs_outbox_dispatch`；
- 把 Outbox claim 键从 `(available_at, lease_until, id)` 改为与真实排序一致的
  `(available_at, id)`，另加只覆盖未发布事件的 backlog-age 部分索引。

当前 migrator 把迁移与账本校验放在同一事务中，不能在其中使用
`CREATE INDEX CONCURRENTLY`。因此 0009 是明确的维护窗口迁移：停止新 Spin、排空 API/Worker、在生产
快照上预估索引构建与锁等待时间并设置受控超时后再执行；不能把本机 10 万行建索引时间当作在线迁移
证明。若未来必须对更大存量表在线建索引，应另建可恢复的事务外 migration job，完成有效性/定义核验
后再冻结账本，不能直接把 `CONCURRENTLY` 塞进现有事务迁移器。

可复现入口为 `server/scripts/postgres-high-concurrency.sh`。它要求独立 runtime/migrator DSN 和
`RGS_HIGH_CONCURRENCY_ALLOW_DESTRUCTIVE_TEST_DATABASE=YES`，会清空测试表并临时切换旧/新索引布局，
绝不能指向生产库。每次运行都硬性要求所有功能场景 `failed=0`、`succeeded=attempted`、错误列表为空，
并要求所配置规模的 wallet ledger 旧计划出现 `Seq Scan`、新计划命中
`rgs_wallet_transactions_round_claim`；任一不满足都会让测试失败。未设置性能阈值时 artifact 明确标为
`report-only`，这只允许直接调用 Go 测试做诊断，不能称为发布门禁。标准化脚本和 Make 入口强制同时
提供以下四个环境变量，并只接受 `local-threshold-enforced-nonrelease` 报告；缺少任一阈值即失败：

```sh
RGS_HIGH_CONCURRENCY_MAX_P99_MILLIS=250 \
RGS_HIGH_CONCURRENCY_MAX_CONNECTION_WAIT_COUNT=5000 \
RGS_HIGH_CONCURRENCY_MAX_CONNECTION_WAIT_MILLIS=30000 \
RGS_HIGH_CONCURRENCY_MAX_WAL_BYTES_PER_SUCCESS=16384 \
RGS_POSTGRES_TEST_URL='<isolated-runtime-dsn>' \
RGS_POSTGRES_MIGRATOR_TEST_URL='<isolated-migrator-dsn>' \
RGS_HIGH_CONCURRENCY_ALLOW_DESTRUCTIVE_TEST_DATABASE=YES \
./server/scripts/postgres-high-concurrency.sh
```

2026-08-23 又通过上述标准入口在全新 PostgreSQL 17 实例执行了一次防陈旧证据重验：默认
20,000 行 wallet ledger、100 次索引查找、32-worker 阶跃、128 局恢复积压和 1,550 条 Outbox，
共 20 个场景全部零错误并满足四项阈值。优化布局相对同次基线的 32-worker 吞吐为
`585.4 → 691.8/s`、p99 为 `81.88 → 62.28 ms`；wallet claim 精确查找为
`592.7 → 3132.6/s`、p99 为 `1.98 → 0.41 ms`。该重验用于证明标准脚本、阈值和新报告原子发布
仍然有效；下面的 10 万行数据仍是更大本地样本的相对证据，两者都不能外推为 RDS 商业容量。

本机证据环境是 Apple M5、Go 1.26.6、PostgreSQL 17.10、`MaxOpenConns=16`。阈值运行覆盖 32-worker
稳态（每 worker 20 局）、`1/8/32/64` 阶跃、32 个同 operator 不同 session、64 个同 session 竞争者、
1024 局恢复积压（8 workers/批 64）、8724 条 Outbox（8 workers/批 128）以及 10 万 wallet ledger；
全部场景零错误并通过上述四个本地阈值。与同进程、同实例、同负载的旧实现/旧索引布局相比：

| 场景 | 旧 → 新吞吐 | 旧 → 新 p99 | 结论 |
| --- | ---: | ---: | --- |
| 稳态不同 operator/session | `551.6 → 594.8/s`（+7.8%） | `108.65 → 99.05 ms`（-8.8%） | 合并数据库往返有稳定收益；另两轮为 +8.1%--10.4% |
| 热 operator、不同 session | `463.0 → 588.6/s`（+27.1%） | `110.71 → 88.22 ms`（-20.3%） | 短重复中位仅 +6.2% / -17.0%，因此不采用单轮较高增幅外推 |
| 64 并发阶跃 | `535.8 → 630.2/s`（+17.6%） | `224.95 → 190.57 ms`（-15.3%） | 其它运行曾反向回退；连接池已饱和，不能据此抬高并发 |
| 同一 session 64 竞争者 | `312.7 → 317.4/s`（+1.5%） | `192.43 → 192.79 ms`（+0.2%） | 最大 15 个锁等待者；正确串行点没有被绕过 |
| wallet claim 精确查找 | `122.9 → 3035.0/s`（24.7x） | `10.68 → 0.43 ms`（-95.9%） | `Seq Scan` 约 102,509 行/3,205 buffers 变为目标 `Index Scan` 4 buffers |

Outbox WAL 从 `10,012,304` 降到 `8,804,920` bytes（-12.1%；另两轮 -7.2%/-12.0%），但吞吐在
不同运行中有升有降，因此只认定写放大下降，不宣称稳定吞吐提升。恢复 drain 的三次完整 A/B 中，
两次吞吐约下降 7.7%，最终一次提高 8.0%；p99 同样双向波动，而 WAL 持续上升约 4.8%--7.8%。
隔离复跑保留旧 recovery 索引后吞吐方向反转但 WAL 回退扩大到 5.7%，证明短时吞吐受本机噪声影响，
旧宽索引仍不值得保留。新增的最小
wallet ledger 索引会让非 HOT 账本状态更新付出可测 WAL 成本，但它把外呼前安全核验从全表扫描变为
稳定精确查找，因此保留并把约 5%--8% 恢复 WAL 增量纳入容量预算，而不把该取舍描述为全面无回退。

随后在同一 16 连接预算下做了三次较短、顺序执行的 A/B 重复，每次仍要求功能与执行计划硬门禁。
三次全部零功能错误；中位数方向为：稳态吞吐 +14.9% / p99 -16.6%，热 operator 吞吐 +6.2% /
p99 -17.0%，同 session 吞吐 -0.6% / p99 +0.6%，恢复吞吐 +0.4% / p99 +7.8%，Outbox 吞吐
-9.4% 但 WAL -19.3%。一万行 wallet lookup 的吞吐提升为 2.83x--4.12x（中位 3.30x），p99
下降 60.2%--80.3%（中位 62.6%）；十万行时三次为 24.7x--33.3x / -95.9% 至 -97.7%，符合索引随表增长避免
线性扫描的预期。一次仍带 64 并发和 250ms 阈值的重复在宿主繁忙时被正确拒绝：旧/新 p99 分别
为 250.22/282.56ms。该失败不计作通过证据，反而证明阈值确实失败闭合，也证明 64 并发、恢复与
Outbox 的短跑结果受 oversubscription 影响；最终结论只采纳同次 A/B、重复中位方向和执行计划，
不采用跨运行绝对 TPS。

16 连接预算下，32 并发已经出现约 759 次/3.5 秒池等待，64 并发达到约 1546 次/22.2 秒，吞吐
仍停在约 600--650 局/秒；数据库锁等待为零，说明此处首先是客户端连接预算排队。继续增加 Pod 或
连接数不能自动提高单写主库容量，必须用目标 RDS 实例、真实网络与存储做 24 小时 soak、故障切换和
峰值余量审批。本地结果只证明相对方向与回归阈值，不是生产 TPS、RDS 或真钱认证。

## 钱包与审计异步边界

- 钱包扣款属于当前局提交条件。RGS 在没有确定钱包回执时不得向客户端宣称局已完成。首次请求只
  使用有界的一秒快路径；超时或 `UNKNOWN/PENDING` 后返回可恢复的 202，由独立 Worker 查询同一
  操作。客户端保持同一 round ledger，不把“API 快返回”解释成资金已经成功。
- 当前钱包 SPI 使用版本化能力档案和显式结果：`NOT_SENT` 仅表示能证明请求未发出，保持原动作；
  `UNKNOWN/PENDING` 转 `LOOKUP`；权威 `NOT_FOUND` 只有在档案允许且等待最短一致性窗口后，才可
  复用相同 operation ID、完整命令摘要和钱包会话绑定重排 `APPLY`。错误字符串和未认证响应不参
  与资金状态判断。
- 每个进程按后端分别为 apply 与 lookup 保留 24/8 个非阻塞许可，每运营商最多 8 个 apply；两条
  lane 使用独立熔断器，避免慢 apply 吞掉解析未知结果所需的查询容量。新意图在 RNG/PREPARE 前做
  快速准入，已存在轮次的客户端重放只观察 PostgreSQL，不再次争抢钱包写路径。
- 审计投递继续使用“业务事务内写 PostgreSQL Outbox，事务外 Worker 投递”的方式。Kafka/MSK
  可以作为 Outbox 的下游传输，但不能替代事务内 Outbox，也不能让 API 直接双写数据库和消息系统。
- API readiness 只反映 API 自身、数据库和必要配置；审计出口积压由 Worker readiness、backlog
  指标和告警表达，不能让审计接收端抖动同时摘除所有 API Pod。

API 与 Worker 的密钥能力也随角色拆分。API 运行资产包含 launch、访问令牌、运营签名和钱包
交互所需材料；Worker 运行资产只保留定义验证、钱包请求签名、钱包响应验证和 Outbox
所需材料。Worker 进程不加载 launch HMAC、访问令牌签发私钥、运营请求验证材料或运营响应
签名私钥；禁止为了减少 Secret 数量而合并这两个权限边界。

### 为什么不是传统同步调用、Redis 幂等或无限重试

| 方案 | 高峰时的表面收益 | 在资金路径中的根本问题 | 当前做法 |
| --- | --- | --- | --- |
| 请求线程同步等到钱包返回 | 代码短、正常路径直观 | 慢钱包占满连接、协程和 DB 预算；客户端超时后仍无法知道资金是否执行 | 一秒有界快路径，随后 202 + PostgreSQL 持久恢复 |
| Redis `SETNX`/分布式锁做幂等 | 延迟低、看似减少主库写入 | 缓存丢失、过期或故障转移不能证明钱包未执行；锁与经济提交之间仍有双写窗口 | PostgreSQL 保存不可变命令、结果和终态；Valkey 只做新意图准入 |
| 对 apply 无限重试 | 可能最终收到一次成功响应 | 发送后断线会把“可能成功”伪装成“失败”，造成重复扣款；故障时形成重试风暴 | `UNKNOWN` 先查询，只有权威 `NOT_FOUND` + 能力窗口才重排同一 apply；写尝试有硬预算 |
| API 直接双写数据库与消息系统 | 少一个 Worker | 任一侧成功、另一侧失败无法原子收敛 | 同事务 Outbox，事务外至少一次投递和消费者去重 |
| 为每种钱包复制一套业务协调器 | 单次联调改动快 | 状态语义、签名和幂等规则逐家漂移，核心代码被供应商错误码污染 | 版本化 profile + adapter conformance；协调器只处理规范状态 |

这不是为了“架构复杂化”，而是因为外部钱包与 PostgreSQL 之间不存在可依赖的跨组织 ACID 事务。
系统明确承认至少一次投递和模糊结果，再用不可变身份、持久状态、状态查询、围栏与人工审核收敛，
比把不确定性隐藏在同步 HTTP 或缓存锁中更可审计。

当前 profile 只实现原子轮次 `atomic-http-v2`。转账钱包、拆分 debit/credit、预授权/捕获和跨账户
转移仍是能力预留，**未实现**。这些模型必须增加步骤级持久 saga、独立幂等键、补偿授权、余额与
流水对账、恢复期限和第三方 conformance；禁止把两个非原子调用包装后宣称等价于当前原子接口。

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
- 安全日志：认证失败、nonce 重放、完整性隔离、密钥和配置变更；权威计数完整保留并告警，重复物理记录使用独立固定预算；
- 运行遥测：INFO/DEBUG 可以按稳定 trace ID 采样、批量压缩和设置容量预算。

经济审计与独立安全事件计数永不采样。通用 HTTP 访问日志和可重复安全 WARN 必须有相互独立、固定、
低基数的写入预算，防止认证/容量攻击反向耗尽日志 I/O；完整 HTTP、认证和容量计数仍不得采样。Vector/OTel 的采样、
丢弃、缓冲溢出和远端写入失败都必须暴露指标；达到磁盘或队列水位时先降级普通运行遥测。

RGS 公网访问日志已按这一边界实现：`RGS_SUCCESS_ACCESS_LOG_SAMPLE_PER_MILLION` 控制成功请求的
确定性采样，通用集群 Chart 默认 `10000`（1%），本机集成验收显式使用 `1000000`（100%）。
同一路由和语法受限的 request ID 原值在所有副本上得到同一成功采样决定，但日志字段只写该值的
稳定 SHA-256 摘要；成功候选还必须经过单一固定键的 100/s、burst 200 进程预算，所以攻击者重复
一个命中采样的 request ID 也不能无限写日志。4xx/5xx
分别使用固定的 20/s、burst 100 进程预算，4xx 洪峰不能压掉 5xx 预算。所有访问日志写入另有 4 槽
非阻塞 bulkhead，因此 stdout/collector 阻塞也不能无限占用请求协程。`rgs_access_logs_emitted_total` 与
`rgs_access_logs_dropped_total` 只记录无标签总量，不能加入玩家、
会话、轮次或 request ID 标签。该机制只影响普通 HTTP 访问记录，不影响 PostgreSQL Outbox、经济审计、
认证失败和完整性隔离指标。

nonce 重放的无标签 `rgs_auth_replays_total` 权威计数永不采样。重复的固定
`security_event=nonce_replay` WARN 使用独立 10/s、burst 20 和 2 槽非阻塞写入 bulkhead；被抑制的
物理记录累加 `rgs_security_logs_dropped_total`，但不减少 replay 计数。日志禁止记录 nonce、运营商、
密钥、玩家、会话或请求标识。`SlotsRGSAuthReplay` 使用
`increase(rgs_auth_replays_total[5m]) > 0`，五分钟内任一增量都必须进入安全告警路由。

AWS 正式路径不部署本机 Vector。容器 stdout/stderr 由采用方节点级 OTel/CloudWatch 管道采集；管道仍
必须对自身积压、丢弃、重试和归档失败告警。禁止再在 Vector 或下游对已经受控的 WARN/ERROR、资金
和安全事件做第二次概率采样。

## 本地开发与完整集成验收

`deploy/local-production` 是 TLS、最小数据库角色、钱包恢复、审计、监控、备份恢复和浏览器会话的
完整集成验收栈，不是每次编辑都必须启动的开发骨架。日常开发优先运行包级 Go 测试、PostgreSQL
conformance、`make web` 和定向浏览器门禁；只有跨服务、发布候选或本机完整集成验收才启动完整 Compose。

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
模式和采用方的保留政策决定。

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
