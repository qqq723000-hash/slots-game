# RGS DDoS 威胁模型与验证门禁

状态：后端应用层防护以及 AWS/Helm/Terraform 契约与负向夹具已实现本地证据；真实账号中的
WAF/ALB/CloudFront/Route 53/Shield 状态、公网大流量清洗、EKS 容量和第三方钱包承压仍属于目标环境
门禁。仓库提供只读实时回读脚本，但当前本地结果不冒充真实 AWS 验证或抗 DDoS 认证。

## 1. 安全结论

“游戏如何防 DDoS”不能用一句“加限流”回答。RGS 使用分层耗损模型：越靠近攻击源，越早、
越便宜地丢弃无效流量；越靠近资金交易，越按已验证身份和经济意图做精确准入。

```text
动态 API 公网流量
  │  Route 53 + Shield Standard（AWS 自动基础 L3/L4 防护）
  ▼
Regional AWS WAF → internet-facing ALB：L7 粗筛、TLS、连接和目标健康（外部部署门禁）
  ▼
Go HTTP：16 KiB Header + 8 KiB 路由正文（兑换 4 KiB）+ 各类超时 + 连接硬上限
  ▼
匿名进程级准入：固定全局速率 + in-flight 硬闸门，满载立即 503，不信任 IP/method/path
  ▼
协议与认证：JSON 深度 32、严格 Header/JSON、签名或访问令牌、单一匿名验签 CPU bulkhead
  ▼
身份级准入：本地快速限流 + Valkey 跨 Pod 按已验证运营商聚合经济意图
  ▼
资源预留：为状态查询、结果恢复和 ACK 保留 PostgreSQL 连接
  ▼
PostgreSQL：幂等、轮次、钱包命令和审计唯一权威
```

CloudFront 不在本项目动态 API 链路前，也不“隐藏 ALB 源站”。它只为独立的静态 Web 路径提供
`Route 53 → CloudFront + WAF → 私有 S3`。架构评审必须把两条入口分开；如果未来要把 API 前置到
CloudFront，那是新的架构决策，需要重新验证缓存策略、源站访问约束、Header 和延迟，而不是当前事实。

核心原则不是“所有请求都成功”，而是攻击或爆款洪峰下仍满足以下不变量：

1. 可在协议或认证层判定的无效流量不得进入数据库、钱包和经济协调器；必须查库判定的一次性 exchange 码先受新意图硬许可约束；
2. 身份验证后，新经济意图可被快速拒绝，查询、恢复和确认不消耗 DB 新意图/钱包 apply 预留；认证前无法区分合法恢复，不能按可伪造 path 承诺优先；
3. `429` 是身份配额拒绝，`503 CAPACITY_UNAVAILABLE` 是匿名传输容量拒绝，两者不能混为一谈；
4. Valkey 只做准入，不做资金和幂等权威；
5. 防护降级不得通过关闭验签、放宽幂等或重跑 RNG 换取表面可用性。

公网 `8080` 不提供 `/healthz`，Regional WAF 对该精确路径先返回 404，应用公网 handler 同样失败关闭；
ALB target health 与 Kubernetes 探针改走受安全组/NetworkPolicy 约束的 operations `8081/healthz`。
因此健康探针不会成为公网容量旁路，但这也不代表应用能处理带宽、TLS 或连接洪水，仍必须由
Shield、WAF、ALB 和连接上限吸收。

## 2. DDoS 与普通高并发不是同一问题

| 维度 | 爆款带来的合法洪峰 | DDoS/资源耗尽攻击 |
| --- | --- | --- |
| 身份 | 多数有效，可按运营商/会话归因 | 可能无身份、伪造身份、被盗身份或大量僵尸网络 |
| 请求形状 | 通常符合协议 | 慢 Header、慢 Body、超大/畸形输入、重放、热路径探测 |
| 目标 | 完成更多业务 | 用最低攻击成本消耗最高服务端成本 |
| 正确策略 | 扩容、排队上限、背压、降级 | 边缘清洗、早拒绝、成本不对称修复、隔离与取证 |
| 验证 | TPS、P99、饱和点、soak | 攻击矩阵、拒绝位置、后端调用为零、合法流量存活率 |

仓库原有 HTTP 高并发画像验证正常、阶跃和容量卸载；Valkey 画像验证 `hot_key`、
`many_identity`、`deny_storm` 与 `NOSCRIPT`。新增 DDoS abuse profile 专门验证“攻击请求在何处终止”，
不会用本机 loopback TPS 宣称公网抗 DDoS 能力。

## 3. 攻击面与当前控制

| 攻击向量 | 当前项目控制 | 本地证据 | 仍需外部验收 |
| --- | --- | --- | --- |
| UDP 反射、SYN flood、带宽打满 | 动态 API 使用 Route 53、Shield Standard、Regional WAF 和公网 ALB | 源码无法证明目标账号状态 | 资源回读、CloudWatch/Shield 事件与合规模拟证据 |
| TLS/连接洪峰 | ALB 终止公网 TLS；Go 每监听器默认最多 1,024 个已接受连接 | `platform/listener_test.go` | ALB quota、LCU、连接拒绝、跨区容量 |
| Slowloris/慢 Header | `ReadHeaderTimeout=5s`，连接仍受硬上限 | `ddos_transport_test.go` 真实 TCP 测试 | ALB/WAF 空闲超时及真实弱网误杀率 |
| 慢正文/悬挂上传 | `ReadTimeout=15s`、请求上下文 15s、公开路由正文最多 8 KiB | `ddos_transport_test.go` | ALB body/idle 行为与生产阈值 |
| Header bomb | `MaxHeaderBytes=16 KiB`，重复安全 Header 失败关闭 | 真实 TCP 431 + abuse profile 415 | 边缘 Header 上限与 HTTP/2 行为 |
| 超大、分块或压缩正文 | middleware 与路由双层限制；公开路由 8 KiB、兑换 4 KiB；拒绝 `Content-Encoding` | handler 单测 + `oversized_body_flood` | WAF body inspection 上限与超限处理 |
| JSON 深度/解析炸弹 | 最大嵌套 32、严格 JSON、禁止未知字段与尾随值 | handler 单测 + `malformed_json_flood` | fuzz/soak 与版本升级回归 |
| 无效令牌/签名 CPU 洪峰 | 验签前单一匿名 CPU bulkhead；伪造恢复 path 无额外许可；无效身份不能进入租户准入或协调器 | `invalid_token_flood` 产生 401/503 且后端调用为 0 | WAF bot/rate rule、真实 CPU 饱和点 |
| 大量有效会话绕过缓存键 | 会话级本地桶后，spin 再按已验证运营商进入共享桶 | `many_identity_spin_flood`：会话键 N 个、共享键仅 1 个 | 真实 Valkey、被盗账号处置与运营商配额 |
| 单运营商热键 | Valkey 原子 token bucket；拒绝路径不写状态 | `deny_storm` 与 `hot_key` 负载画像 | ElastiCache TLS/Multi-AZ/failover 容量 |
| Valkey 故障 | 新经济意图失败关闭为 503；状态查询、恢复和 ACK 不依赖新意图准入 | handler/limiter 单测 | 真实节点切换、网络分区与告警送达 |
| PostgreSQL 连接耗尽 | 新 session exchange/launch/spin 在临界线前卸载，为已认证查询/恢复/ACK 保留连接 | intent-capacity 单测 | RDS failover、锁等待、真实峰值 |
| 钱包变慢导致级联 | 有界 timeout、fast path、熔断/隔离、UNKNOWN 查询恢复 | wallet/recovery 单测 | 第三方钱包容量、故障注入与认证回执 |
| `Retry-After` 同秒重试羊群 | 客户端按服务端下界叠加 full jitter，并限制窗口/尝试次数 | 10,000 客户端分桶测试 | 多浏览器/多地区真实时钟与 CDN 行为 |
| 指标/日志高基数与写入洪峰 | 指标只用固定 label；日志不记录原始 URL、body、身份或 RemoteAddr；成功候选固定 100/s、burst 200，4xx/5xx 各固定 20/s、burst 100，access 写入最多 4 并发；nonce WARN 独立 10/s、burst 20、最多 2 并发，完整安全计数不采样 | metrics/observability 契约 + sampled ID/失败/阻塞 writer/nonce 洪泛单测 | AMP/CloudWatch ingest 限额和成本告警 |
| 静态资源 cache bust | Web 与 API 分离，静态资源交给 CloudFront/S3 | 架构契约 | cache key 必须忽略非业务 query、WAF 规则和源站封锁 |

特别注意：按 IP 限流只能是边缘粗筛，不能成为资金接口的身份权威。NAT 会让大量真实玩家共享 IP，
僵尸网络又能轮换 IP；攻击者可控的 `X-Forwarded-For` 还可能制造无限桶。AWS 也明确提示 forwarded
IP header 可能被修改或被不一致地处理。应用层因此只按签名或 token 中的不可变身份做精确限流。

### 3.1 AWS 边缘规则不是“写了就 Block”

本仓库的权威动态入口固定为 `internet-facing ALB + REGIONAL WAF`。ALB 安全组保留公网 HTTPS
可达性；由于 CloudFront 不是 API 上游，这里不存在“只允许 CloudFront IP”或伪造源站共享 Header 的
绕过修复。Shield Standard 是 ALB 的 AWS 服务基线，但源码和本地夹具不能证明目标账号当时的实际
缓解状态。静态 Web 才使用 `CloudFront + global WAF + private S3 OAC`。

Regional WAF 的机器合同把规则分成四类：固定协议面、输入大小、粗粒度速率与 AWS managed rules。

| 规则 | 初始动作 | Scope | Block 前置条件 |
| --- | --- | --- | --- |
| `public-healthz-block` | `BLOCK` + 404 | 仅精确 `/healthz` | ALB IP target 已固定在私有 operations `8081/healthz`，该探针不经过 WAF |
| `public-protocol-surface-block` | `BLOCK` + 404 | 仅允许 `/client/`、`/operator/` 前缀及 GET/POST/OPTIONS，其余失败关闭 | 使用 `NONE` transformation，只筛选而不改写应用验签使用的 canonical path；新协议 namespace/method 必须显式变更合同 |
| `body-size-limit` | `BLOCK` + 413 | aggregate body 超过 8 KiB，oversize=`MATCH` | 已由全部合法业务 JSON 最坏展开值小于 8 KiB 的协议证据支持 |
| `header-size-limit` | `COUNT` | aggregate headers 超过 8 KiB，oversize=`MATCH` | 最大合法签发 token、固定协议头、Host/User-Agent、ALB tracing/XFF 组合证据；Go 的 16 KiB 只作最终兜底 |
| `launch-rate-limit` | `COUNT` | 仅精确 POST `/operator/v1/launches` | 真实 operator 出口、NAT/CGNAT、营销峰值与误杀率证据 |
| `spin-rate-limit` | `COUNT` | 仅精确 POST `/client/v1/spins` | 真实移动网络/NAT、每会话扇出与误杀率证据 |
| `public-api-rate-limit` | `COUNT` | `/client/` 与 `/operator/` 的 GET/OPTIONS/POST 高水位总保护 | 全部公网路由容量、恢复成功率、预检洪泛与来源分布证据 |
| 四组 AWS Managed Rules | `COUNT` | Amazon IP reputation、Common、Known Bad Inputs、SQLi | 命中样本、合法请求误报、规则版本和排除项评审证据 |

低阈值规则只命中新 launch/spin；status、pending result 与 ACK 不会被低阈值连带阻断，但仍受高阈值
`public-api-rate-limit`、匿名进程总预算和验签 CPU 总预算保护。这不是“按 path 给恢复请求可信优先级”；
认证前的 path 可伪造，身份级精确准入仍只能在认证后执行。

三条 rate rule 晋级 Block 时都返回无敏感正文的 `429`，并固定 `Retry-After: 30`、
`X-RGS-Edge-Error: RATE_LIMITED`、`Access-Control-Allow-Origin: *` 与
`Access-Control-Expose-Headers: Retry-After, X-RGS-Edge-Error`。marker 让 credentials-omit 的跨域客户端能在
严格 JSON 解析前识别 edge 拒绝，30 秒仍处于客户端默认安全窗口；WAF 不回显攻击者 Origin，也不发送
`Access-Control-Allow-Credentials`。

所有 staged rule 的环境示例均为 `action=count`、`evidence_reference=observation-pending`。切换到
`block` 时必须逐规则绑定 `s3://bucket/key?versionId=<version>#<64位小写sha256>`：对象至少记录环境、Web ACL ARN、规则
组/版本、scope、阈值、观测窗口、正常高峰/营销活动、NAT/CGNAT 分布、命中样本、误杀率、合法流量
存活率、源站余量、批准人与回滚条件。证据对象必须版本化、SSE-KMS、不可变；规则阈值、scope 或
managed rule 版本变化后必须重新走当前批准门禁。紧急 Block 也不得删掉证据、owner、
自动到期和回滚路径。

发布实时门禁不会信任这段 URI 字符串本身：只要任一 staged rule 为 Block，就以 `s3:GetObjectVersion`
读取精确 version，先限制对象为 256 KiB，再核对文件 SHA-256，并解析固定 JSON schema。schema 必须绑定
当前 environment、Web ACL、rule names、阈值/scope 的 canonical configuration hash、受保护源码 commit、
至少七天窗口/样本/误杀与存活率、规则类型专属评审、两个不同审批主体、有效期及 HTTPS 回滚 runbook。
Count→Block、configuration 或 evidence 引用变化时，infra apply 前必须绑定当前受保护 source SHA 且证据
未过期；稳态 Block 仍回读相同 version/hash/config/schema，但不把历史批准有效期当作日常发布租约，也
不绑定应用发布 SHA。对象缺失、KMS/权限失败、内容被替换或任一合同漂移仍失败关闭；验证器不输出正文。
这些机器检查证明“证据对象与当前发布一致”，仍不把填入的数据自证为真实压测或 AWS 抗 DDoS 认证。

WAF 日志默认丢弃 ALLOW，只保留 BLOCK/COUNT，并脱敏完整 query string、Authorization、Cookie、
签名、nonce 和幂等 Header；正式协议不使用 query，攻击者不能借 query 注入 token/签名或制造日志
泄漏。URI path 与 method 仍用于处置，避免攻击把日志摄取账单变成第二次 DoS。Regional 与 CloudFront
Web ACL/全部规则均关闭 sampled requests，因为 logging redaction 不会保护 `GetSampledRequests`。
CloudWatch 同时观察 BlockedRequests 和 AllowedRequests 成本高水位。
`verify-live-platform-prerequisites.sh` 会只读回查 Web ACL 精确规则集合、
动作阶段、scope、8 KiB oversize、日志目的地/脱敏/过滤、告警、CloudFront WAF/OAC 绑定；仓库夹具还
反向证明扩大 launch scope、无证据提前 Block、日志泄密、告警停用和私有源站漂移都会拒绝发布。

Global Accelerator、CloudFront API proxy 与 Shield Advanced 都只是企业增强接口。启用它们必须同时
交付可达的上游健康设计、源站访问迁移、缓存/Header 契约、费用审批、DRT/SRT 响应边界和真实回读；
不能仅改一条安全组规则导致 ALB 不可达，也不能把可选能力写成当前已启用事实。

### 3.2 “钱包被刷爆”：EDoS 资金成本攻击

高级攻击者不一定发送畸形包。只要掌握有效签名/token，便可从大量 IP、设备和 session 使用不同
`roundId` 提交完全合法的 Spin。每个请求都可能穿过 WAF、验签和普通会话限流，最终触发第三方钱包
`SubmitRound`、后续 `Resolve`、审计 outbox、日志与自动扩容费用。这是 Economic Denial of
Sustainability（EDoS）：服务未必宕机，企业却可能先耗尽供应商调用配额或成本预算。按 IP/session
建桶会被多 IP/多 session 扇出绕过；只加 HPA 还会加速付费下游调用。

本项目把“请求容量”和“钱包成本”分开控制。普通 shared admission 继续承担 launch 和已验证运营商
请求的高水位保护；Spin 另有一次集群级经济准入，且满足以下执行边界：

1. 只使用验签或访问令牌得到的 `operatorID`，并在启动时从已批准 wallet profile 构造静态
   `operator → canonical route origin (scheme://host:port)` 绑定；绑定缺失、重复或漂移使生产 API 启动失败，不使用
   path、IP、session 或请求中的 URL。
2. PostgreSQL 在会话锁内先确认 round 不存在、无待交付结果/待决 round、revision 与定义绑定有效；
   本地 operator/backend 钱包舱壁先通过，定义解析、RNG 和结果结构校验也先成功。随后才对“可持久化、
   可能产生首次钱包调用”的新意图扣成本，避免用同一个无效 round 反复烧预算。
3. 一次 Lua 执行同时检查 operator 桶和物理 backend 桶。任一不足返回 429 且不写任一桶；两者均足才
   同时扣除。接口显式接受 `costUnits`，当前 Spin 固定为 1，禁止从 bet 金额猜测第三方成本。
4. operator key 与 backend key 使用同一 `{rgs-economic:<backend HMAC>}` hash tag，保证 Valkey Cluster
   单 slot 原子执行；同一 canonical route origin 的多个运营商共享 backend 总预算，不同 origin 使用不同 tag 分散 slot。
   key、指标和日志均不包含原始运营商或钱包 origin。当前 AWS 合同仍是 cluster-mode disabled 的单
   replication group；这些 key 已兼容未来分片，但多分片客户端路由、故障转移和容量仍需单独交付验证。
5. committed/PREPARED/REJECTED 重放、幂等冲突、陈旧 revision、已有 pending round 都不会再次扣费；
   status、pending result、ACK、token refresh 与 Worker `Reconcile/Resolve` 明确旁路经济桶。恢复已持久化
   资金状态的能力不能被攻击者耗空的新资金预算切断。

若 operator 策略为 `(O_rate, O_burst)`、backend 策略为 `(B_rate, B_burst)`，每次成本为 `c`，任意
长度为 `T` 秒的窗口内，单运营商和单物理钱包获准的新资金意图分别满足保守上界：

```text
operator calls(T) <= floor((O_burst + O_rate × T) / c)
canonical-origin calls(T) <= floor((B_burst + B_rate × T) / c)
actual wallet starts <= min(operator bound, backend bound, local wallet bulkhead capacity)
```

这些是调用速率/突发的成本护栏，不是供应商真实日额度或财务预算。若同一供应商通过多个
DNS/CDN/租户 origin 共用合同额度，当前实现不会猜测它们属于同一“物理钱包”；必须先在签名 wallet
profile 增加并审批显式 budget group，再把 route 构建切换到该稳定标识。未交付该配置前，跨 origin
供应商/FinOps 总额仍是上线门禁，不能宣称已由本仓库聚合。Chart 默认
`20/s + burst 40`（operator）与 `100/s + burst 200`（backend）只是保守平台上限；上线必须依据钱包
合同、计费单位、正常高峰和目标 Valkey/钱包压测显式审批。速率最多保留三位小数，运行时精确转换为
毫单位；不能表示的值、超过 24 小时的全量回填 TTL、NaN/Inf 和越界 burst 均在启动/Chart 校验时拒绝。

热路径没有额外数据库预读，也不解析 URL 或逐请求计算 HMAC：路由和 key 在启动时有界预计算；每个
首次可持久化 round 只有一次有 deadline 的 Valkey RTT。客户端禁用自动管线，业务命令只走
固定上限的同步连接池：等待连接响应 context，已取得连接的读写再受 socket deadline 保护，
避免黑洞 peer 填满客户端 ring 后越过准入超时。应用层四许可闸门还会阻止依赖池在
context 超时竞态中误减连接计数并发生重建风暴。valkey-go 另保留一条不承载业务自动
管线的基础 socket，因此上界是每 API Pod 四条业务同步连接加一条基础连接，共五条。
默认 API HPA 稳态上限 12 Pod 至少预算 60 条，`maxSurge=1` 的滚动上界至少 65 条；终止重叠、
平台探测与应急余量还需另计。获准时用一条 `MSET`
同时写两个小 string 状态，两个 `PEXPIRE` 只负责垃圾回收；预算不足时零写入，写入/OOM 错误由
`MSET` 保证不会留下半份状态。`NOSCRIPT` 并发恢复只允许一个请求携带 Lua body。该 RTT 位于 session 事务
内以换取跨副本“同 round 只扣一次”的线性化，默认 100ms、硬上限 500ms；数据库关键连接预留确保
status/pending/ACK 不与这些等待争用最后连接。Valkey 超时、断连、`NOSCRIPT` 恢复失败、ACL/OOM 或
协议异常均返回 `503 ADMISSION_UNAVAILABLE` 并开启短熔断，绝不回退本机放行；readiness 保持在线，
让已持久化结果与恢复继续服务。

带 TTL 的桶不能运行在逐出策略下：逐出会让下一次读取恢复为满桶并形成 fail-open。Terraform 为获批
Valkey 7/8/9 engine major 绑定自定义 `maxmemory-policy=noeviction` parameter group；内存用尽时脚本错误
进入上述 503 路径。容量告警必须在 OOM 前扩容或降流，`Evictions > 0` 仍视为策略漂移。

经济准入成功后若 PostgreSQL INSERT/commit 失败，本次预算不会“补回”。这是有意的保守失败语义：
预算统计获准的新经济尝试，而不是声称已经产生第三方账单；自动补偿可能在并发下凭空增加额度并形成
真正 fail-open。钱包调用仍只发生在 PREPARED 持久化之后。若供应商需要真实金额、日累计或动态套餐
控制，应通过已审核的外部配额/FinOps 接口扩展 `costUnits`，不能用 bet 金额或文档示例虚构合同。

低基数观测固定为
`rgs_economic_admission_{allowed,limited,operator_limited,backend_limited,errors}_total`，不带 operator、
backend、URL、session 或 round label。`RGSEconomicAdmissionLimitedSustained` 同时要求绝对速率和拒绝
比例持续升高，`RGSEconomicAdmissionErrors` 单独识别 Valkey/绑定/协议故障；处置时再到受控日志、钱包
控制台和 WAF 聚合中关联事件，不能把高基数身份塞回 Prometheus。

## 4. 新增的可执行证据

以下脚本只允许在本机执行，不接受远程目标参数。不要把代码改成直接攻击生产域名。

```sh
cd slots-game

RGS_DDOS_ABUSE_REQUESTS=10000 \
RGS_DDOS_ABUSE_CONCURRENCY=128 \
./server/scripts/ddos-abuse-profile.sh
```

脚本会先执行真实 TCP 传输门禁，再运行五种 loopback 攻击画像，并用 `jq` 对本次新生成的 artifact
做闭合校验：

| 场景 | 必须满足的结果 |
| --- | --- |
| `oversized_body_flood` | 全部 413；认证、共享准入、协调器调用均为 0 |
| `malformed_json_flood` | 全部 400；认证后的准入与协调器调用均为 0 |
| `duplicate_header_flood` | 全部 415；正文和业务层不应被消费 |
| `invalid_token_flood` | bulkhead 内为 401、饱和时快速 503；租户准入、Valkey 和协调器调用均为 0 |
| `many_identity_spin_flood` | N 个会话键收敛为 1 个运营商共享键；只有获准请求进入协调器，其余 429 |

为使无效令牌场景确定性进入饱和状态，测试使用 8 槽 synthetic bulkhead 和 2ms 延迟 verifier；它验证
拒绝顺序、并发上限和后端隔离，不代表生产验签吞吐。

证据只允许输出为 ignored 的 `.artifacts/security/` 直接子文件，默认是 `ddos-abuse-report.json`，权限为
`0600`；脚本拒绝路径穿越、symlink 和仓库外覆盖。它记录环境、
状态分布、P99、准入键数量和后端调用次数。吞吐与时延只用于同机回归比较；真正上线阈值必须绑定
commit、实例、Go 版本、ALB/WAF 策略、数据规模、并发模型和批准人。

已有的抗羊群证据可单独重跑：

```sh
cd slots-game/web
npx vitest run tests/rgs-gateway.test.ts \
  -t "spreads ten thousand retry clients without violating the server delay floor"
```

已有 Valkey 拒绝风暴证据由 `server/scripts/valkey-high-concurrency.sh` 生成。该脚本具有破坏性保护，
只能使用它要求的 loopback disposable primary + replica，不能对共享或生产 Valkey 执行。

### 4.1 AWS DDoS 模拟是独立的合规门禁

“公司书面授权”本身不足以在 AWS 上执行 DDoS 模拟。按照 AWS 当前公开政策，真正的 DDoS
simulation 必须满足至少以下条件：

1. 由 AWS 预批准的 APN DDoS Test Partner 执行；
2. 目标是本人账号中已登记的 Shield Advanced Protected Resource，或符合政策的 Shield Advanced
   账号内 API Gateway edge-optimized endpoint；
3. 遵守 AWS 公布的 20 Gbit/s、50,000 request/s，以及 CloudFront 5,000,000 packet/s、其他资源
   50,000 packet/s 上限；
4. 流量不得从 AWS 资源发起，也不得使用 AWS 资源模拟放大攻击；
5. 非批准供应商或超出技术限制的测试必须至少提前 14 天提交 exception request 并取得批准。

Partner、限制和政策可能更新，测试前必须重新读取官方政策，保存当日版本、Shield Advanced 订阅、
Protected Resource ARN、供应商资质、测试窗口、停止条件和联系人证据。若目标只需要验证告警与流程，
优先使用 Shield Response Team firedrill；它产生合成 Shield 事件而不生成真实大流量。普通 staging
性能测试也必须遵守账号、服务和供应商授权，但不能包装成 DDoS simulation 认证。

## 5. 告警不能只看一个固定数字

当前应用已有以下症状告警：认证失败、rate limited、capacity rejected、连接使用率、DB pool、钱包
未知结果和 outbox。它们适合证明保护是否触发，但不能单独判断“这是攻击还是爆款”。例如五分钟
20 个 429 在小流量环境可能严重，在百万 RPS 环境却毫无意义。

本轮补充的 `RGSCryptographicCapacitySaturated` 在五分钟验签容量拒绝超过 20 次并持续两分钟时发出
warning。认证前不存在可信恢复身份，因此不能再从 method/path 派生独立 recovery 指标或 critical
告警；恢复风险必须结合已认证 status/ACK 成功率、DB 预留、钱包 lookup 和 recovery backlog 判断。

生产应把四个观测面拼成一个事件：

| 观测面 | 最低信号 |
| --- | --- |
| 边缘 | Shield `DDoSDetected`/攻击向量，WAF `AllowedRequests`、`BlockedRequests`、规则标签 |
| 入口 | API 看 ALB active/new/rejected connections、target response time/5xx；静态 Web 单独看 CloudFront Requests/5xx |
| 应用 | request rate、active/in-flight、401/413/429/503、capacity、共享准入错误、P99 |
| 下游 | DB pool/wait、Valkey latency/error、钱包 inflight/timeout、恢复 backlog |

推荐使用基线变量而不是把示例数值写死：

```text
edge_surge = 当前 RPS > max(同星期同时间 28 天 P99 × 批准倍数, 已批准容量 × 80%)
protecting = WAF block、认证拒绝、429 或 capacity reject 的速率显著高于基线
origin_pressure = 连接或 in-flight > 70%，或 DB/Valkey/钱包余量进入预警区
slo_burn = 5 分钟与 1 小时多窗口错误预算同时快速消耗

P1 page = Shield DDoSDetected > 0
       OR (edge_surge AND protecting AND (origin_pressure OR slo_burn))
```

上述 70% 和 80% 只是首轮放量的候选起点，不是跨环境通用答案。阈值必须从正常高峰、营销活动、
单运营商峰值和授权故障演练校准。WAF blocked 激增但 SLO 健康通常说明防护有效，可先告警不分页；
Allowed 激增且源站压力同步上升才应升级。任何经济完整性异常仍直接按 P0，不等待 DDoS 判定。

告警必须携带：资源 ARN/环境、规则版本、开始时间、当前与基线、SLO 影响、值班 owner、runbook，
但不得把玩家、token、签名、原始 IP 列表或请求正文写进 Prometheus label。

## 6. DDoS 事件 Runbook

### 6.1 发现与定级（0–5 分钟）

1. 建立事件负责人、技术负责人和沟通负责人；冻结非必要发布；记录 UTC 时间线。
2. 动态 API 交叉核对 Shield、Regional WAF、ALB、RGS、DB、Valkey 和钱包；静态 Web 事件才加入
   CloudFront 信号，避免把两条入口或监控故障混为一谈。
3. 区分 L3/L4、TLS/连接、L7 无身份洪峰、有效身份洪峰、单一运营商故障和合法爆款。
4. 检查资金不变量：UNKNOWN、MANUAL_REVIEW、quarantine、对账差异。出现任一项直接升级 P0。

### 6.2 稳定系统（5–20 分钟）

1. 在最靠近源头的位置处置：Shield/SRT、WAF rate rule、bot control、IP/ASN/geo 或精确 URI
   scope-down。先基于已留存样本评估，紧急变更也必须有自动到期时间和回滚人。
2. 在边缘按低阈值限制新 `launch/spin`，并给 status/pending/ACK 配置独立但仍有界的较高阈值；这只是
   route-class 隔离，不证明请求合法。身份验证后再依靠 DB 新意图与钱包 lookup 预留保护收敛路径。
3. 仅在 RDS、Valkey、钱包和节点仍有已验证余量时扩 API Pod。HPA 不是清洗器；盲目扩容会把攻击
   放大为数据库、钱包和成本事故。
4. 不得关闭签名/token、复用未知结果、修改 round ID、重跑 RNG、提高钱包重试或放宽 DB 预留。

### 6.3 深入分析与动态规则

1. 使用 WAF 日志和 Shield 事件看 URI、方法、ASN、国家、JA4/标签等低风险聚合；不要仅依赖 top-5
   contributor，也不要把原始敏感样本复制进聊天或公共工单。
2. forwarded IP 只有在受信代理覆盖并验证 header 时可用；缺失/畸形值必须按已批准 fallback 处理。
3. 对合法运营商密钥或 token 洪峰，按运营商隔离并联系集成方；不要用全局规则误伤其他租户。
4. WAF 托管规则变更通常先 count 再 block；正在造成明确 SLO 影响时可走紧急审批，但仍需 canary、
   到期和回滚。

### 6.4 恢复与复盘

1. 攻击下降不等于恢复完成：验证真实 launch/spin、查询、钱包 receipt、结果 ACK、outbox 和对账。
2. 动态封禁分阶段撤销；观察至少一个批准窗口，防止攻击者等待规则撤销。
3. 固化时间线、峰值 RPS/PPS/BPS、命中规则、误杀率、SLO burn、成本、后端余量和外部响应时间。
4. 把新攻击样本转成脱敏测试或 WAF regression；更新容量基线、告警和联系人演练日期。

## 7. 当前不足与下一步

1. 仓库已提供 Terraform 合同、只读回查门禁与 mock 负测，但没有本次目标账号的真实回读输出；必须
   验证实际关联、rule ID/version/action、日志、CloudWatch alarm、Shield protection 和 SRT 联系人。
2. 现有 Prometheus 固定阈值是应用症状保护，不是基线化 DDoS 检测；目标环境需接入 WAF/Shield/ALB
   指标并建立 composite alarm 和 SLO burn-rate。
3. loopback abuse profile 不含 TLS、HTTP/2、多源 IP、弱网和真实数据库；需要合规的 staging
   step/spike/soak 及 Valkey/RDS/wallet 故障注入。真正 DDoS simulation 必须满足 AWS 官方政策。
4. 应为攻击模式定义“合法流量存活率”和各运营商公平性，而不只看总 TPS；还要验证规则误杀、撤销
   和被盗运营商身份隔离。
5. aggregate header 8 KiB 目前只能 Count；最大合法 token 组合约 6.6 KiB 但尚未包含全部代理/客户端
   Header，必须先建立不可变最大合法请求头测试证据，不能用 Go 16 KiB 上限推导边缘 Block 安全。
6. 必须季度演练 runbook、Shield/安全联系人和动态规则到期；未演练的文档不能算生产能力。

## 8. 官方依据

- [AWS 通用 DDoS resilient web reference（对比资料；其 CloudFront 动态链路不是本项目现状）](https://docs.aws.amazon.com/waf/latest/developerguide/ddos-resiliency-example-web.html)
- [AWS Shield 对 CloudFront 与 Route 53 的缓解逻辑](https://docs.aws.amazon.com/waf/latest/developerguide/ddos-event-mitigation-logic-continuous-inspection.html)
- [AWS Shield Standard 与 Shield Advanced 官方说明](https://docs.aws.amazon.com/shield/)
- [AWS DDoS Simulation Testing Policy](https://aws.amazon.com/security/ddos-simulation-testing/)
- [AWS Security Blog：DDoS simulation 与 SRT firedrill](https://aws.amazon.com/blogs/security/understanding-ddos-simulation-testing-at-aws/)
- [AWS WAF rate-based rule 聚合键与 forwarded IP 风险](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based-aggregation-options.html)
- [AWS Shield Advanced 指标与告警建议](https://docs.aws.amazon.com/waf/latest/developerguide/shield-metrics.html)
- [AWS WAF 指标](https://docs.aws.amazon.com/waf/latest/developerguide/waf-metrics.html)
- [AWS DDoS metrics and alarms best practices](https://docs.aws.amazon.com/whitepapers/latest/aws-best-practices-ddos-resiliency/metrics-and-alarms.html)
- [OWASP Denial of Service Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html)
- [Go `net/http.Server` timeout 与 Header 上限](https://pkg.go.dev/net/http#Server)
