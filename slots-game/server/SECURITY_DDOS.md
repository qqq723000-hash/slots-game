# RGS 应用层 DDoS 与资源耗尽防护

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

本文描述 RGS 进程内已经实现并可由测试验证的保护。它不是“单靠 Go 服务防住 DDoS”的承诺：公网带宽、TLS 握手洪泛、反射放大和大规模僵尸网络必须先由 CDN、WAF、负载均衡、云厂商 DDoS 防护及网络配额吸收。应用层负责在边缘漏流或配置错误时，把 CPU、文件描述符、内存、PostgreSQL、Valkey 和钱包调用控制在确定边界内。

## 处理顺序与失败语义

```text
edge/WAF → listener connection cap → header/read timeout → global pre-auth high-water
→ anonymous public in-flight gate → route body cap/strict JSON → anonymous crypto gate
→ verified identity local admission → shared Valkey operator high-water for launch/all Spin attempts
→ PostgreSQL new-intent reserve/session lock → local wallet bulkhead + deterministic outcome validation
→ atomic Valkey operator/backend economic budget for a first valid round
→ durable PREPARED transaction → wallet call
```

- 全进程预认证速率和并发耗尽返回 `503 CAPACITY_UNAVAILABLE` 与 `Retry-After`。这是服务容量，不是某个已认证调用方超额，不能返回 429。
- 已验证运营商或会话超过业务配额返回 `429 RATE_LIMITED`。
- 普通 Valkey 共享高水位或精确经济准入不可用都返回 `503 ADMISSION_UNAVAILABLE`；生产公网 API 角色必须配置完整的 `rediss`、ACL、HMAC 和 CA 信任链，禁止回退为 Pod 本地放行。
- 未认证的 method/path 不能证明请求属于合法恢复；伪造 status/ACK 与 launch/spin 使用同一个公网和密码学匿名硬上限，不存在可被 path 绕过的预留。
- `launch/spin` 在身份验证后、`session exchange` 在一次性码数据库查询前取得进程内数据库新意图许可。普通共享 Spin 高水位会计数重放/冲突，以限制攻击请求量；精确经济桶只在会话锁内确认是首次合法且可持久化 round 后扣减。已认证的状态查询、pending result、ACK、refresh 和 Worker 恢复都不消耗经济桶，钱包 lookup 也使用独立于 apply 的物理预留。
- 客户端 IP、`RemoteAddr`、`X-Forwarded-For` 和未验证租户头都不是权威身份，也不用于创建可轮换的预认证桶。公网预认证仅使用一个常数内存的进程桶；认证后才使用签名或访问令牌声明。
- 公网监听器不暴露 `/healthz`，该路径与未知路由一样先经过匿名速率/in-flight gate 再返回 404；ALB target health 与 Kubernetes 探针只能访问受网络策略限制的 operations `8081/healthz`。这样不会用一个可公开伪造的 path 制造容量旁路。任何早拒绝的未读正文都会关闭 HTTP/1 连接，避免服务端为 keep-alive 排空攻击流量。
- 成功及失败访问日志使用固定速率和 4 槽非阻塞写入 bulkhead；nonce replay 的重复安全 WARN 使用独立固定预算和 2 槽 bulkhead。请求、认证、容量、安全事件权威计数和资金审计/outbox 不经过物理日志采样，不会用“少记账”换取可用性。

## 硬资源边界

| 资源 | 默认值/上限 | 目的 |
| --- | ---: | --- |
| 已接受连接 | `RGS_MAX_CONNECTIONS_PER_LISTENER=1024` | 覆盖慢请求头、慢正文、TLS 状态、空闲连接和文件描述符 |
| 请求头 | 应用兜底 16 KiB | 边缘 aggregate 8 KiB 规则须先用最大合法签发 token、固定协议头和代理附加头证明；证据完成前只 Count |
| `ReadHeaderTimeout` | 默认 5s，允许 100ms–10s | slowloris 请求头截止时间 |
| `ReadTimeout` | 默认 15s，允许 1s–30s | 包含正文读取的连接截止时间 |
| 应用请求 | 默认 15s，最大 60s | 向 DB、Valkey 和钱包传播取消信号 |
| `WriteTimeout` | 默认 20s，最大 90s | 限制慢读客户端占用响应协程 |
| `IdleTimeout` | 默认 60s，最大 5m | 限制 keep-alive 空闲占用 |
| 公网 in-flight | 256 | 单一匿名非阻塞硬上限；不信任 method/path |
| Ed25519/token/signing in-flight | 64 | 单一匿名 CPU bulkhead；不信任 method/path |
| 预认证高水位 | 5000/s，burst 10000 | 常数内存、单进程桶；所有公网业务路由超限返回 503 |
| 请求正文 | 全局严格 8192B；exchange 4096B | 与 ALB/WAF 完整正文检查窗口对齐 |
| 成功访问日志 | 确定性候选后 100/s、burst 200 | 单一固定键最终预算；重复命中采样的 request ID 不能无限写日志 |
| 失败访问日志 | 4xx/5xx 各 20/s、burst 100 | 两个固定键独立预算；完整失败与安全计数仍不采样 |
| 访问日志写入 | 最多 4 个并发 | stdout/collector 阻塞时立即丢弃物理记录并增加固定指标，不占满请求协程 |
| nonce replay WARN | 10/s、burst 20；最多 2 个并发 | 与 access log 独立；`rgs_auth_replays_total` 始终完整 |
| 普通共享 Spin 高水位 | 进程默认 20/s、burst 40；生产 Chart 默认 500/s、burst 1000，每 operator 跨 Pod 聚合 | 吸收多 session、多 IP 与同 round 重放的请求放大；按正常峰值压测校准 |
| 经济 operator/backend 桶 | 默认 20/s + 40、100/s + 200；当前 Spin 成本 1 | 限制首次可持久化钱包意图的运营商和 canonical route origin 总成本；必须按钱包合同校准 |

这些默认值是安全基线，不是任意实例规格的容量结论。生产阈值必须由批准的实例类型、CPU、连接池、WAF 日志和压测基线共同校准。

## 为什么正文可以安全收紧到 8 KiB

依据 `openapi.yaml` 与运行时验证器的最大字段长度，最大业务值的 JSON 大小如下。第二列是普通紧凑编码；第三列保守地把所有 ASCII 键和值字符都展开为合法 `\uXXXX`。

| 路由请求 | 紧凑编码 | 最大转义编码 |
| --- | ---: | ---: |
| operator launch | 1094B | 6189B |
| session exchange | 350B | 2005B |
| session refresh | 735B | 4170B |
| spin | 971B | 5466B |
| round status | 876B | 4986B |
| result ACK | 986B | 5586B |

因此 8 KiB 覆盖所有 schema-valid 值；超过该值只能依靠没有业务含义的空白填充等方式膨胀。应用启动时严格要求 `RGS_MAX_REQUEST_BYTES=8192`，避免出现 WAF 只检查前 8 KiB、RGS 却继续解析未检查尾部的契约错位。

## 资金与恢复边界

- 公网/密码学匿名 gate 可以在认证前拒绝任意业务路由，但发生在数据库、钱包和交易副作用之前；它不能证明或保证某个请求属于合法恢复。
- PostgreSQL 新意图 gate 只拒绝尚未创建的新会话/经济意图，不能修改已持久化轮次状态，也不能把超时解释为失败交易。
- PostgreSQL 新意图许可同时观察连接池 `InUse` 并预留关键连接；未认证 session exchange 也必须先取得许可，状态、结果恢复和 ACK 不与新会话/spin 共享最后一段连接预算。
- 钱包按后端和运营商拆分 apply/lookup bulkhead，并为 lookup 保留物理连接；熔断或容量拒绝不会凭空重试一个未知结果。
- Valkey 只是准入设施，不是余额、幂等或轮次状态权威。经济准入从已批准 wallet route 启动时预计算 `operator → canonical route origin`，键只含 HMAC 摘要；同一 origin 的 operator/backend 两键共享动态 hash tag，不同 origin 可分散 Cluster slot。任一桶不足时零写，获准时在单次 EVAL/单次客户端 RTT 中用一条 `MSET` 同时更新两份服务端时间状态，再用 `PEXPIRE` 只做垃圾回收。`MSET` 的 OOM/命令错误不会留下半份成本状态。多个 DNS/CDN/租户 origin 是否共享一份供应商计费额度不能从 URL 安全推断；若存在该合同，必须在签名钱包 profile 中交付受审计的显式 budget group 后才能声称跨 origin 聚合。
- 经济 Valkey 超时、断连、`NOSCRIPT` 恢复失败、ACL/OOM 或协议错误全部失败关闭；已持久化恢复读取不消耗该配额，但仍受匿名入口硬上限。启动除 `PING` 外还会执行约一秒 TTL 的无业务身份双桶 canary，验证 `EVAL/GET/TIME/MSET/PEXPIRE` 实际权限。生产参数组必须实际收敛到 `maxmemory-policy=noeviction`，逐出桶会把预算重置为满额而形成 fail-open。
- Valkey 业务命令禁用自动管线，应用层四许可闸门使超时等待者不进入依赖池，已获准命令再受 socket deadline 保护。四条同步业务连接加 valkey-go 一条不承载业务自动管线的基础 socket，硬上限为每 API Pod 五条；默认 12 Pod 稳态与 13 Pod 滚动至少预算 60/65 条，终止重叠另计。
- 经济准入成功后若 PostgreSQL INSERT/commit 失败，不自动补回预算：保守多扣不会产生额外钱包调用，而并发补偿可能凭空增发额度。钱包调用仍只发生在 PREPARED 持久化之后。默认预算是平台上限，不是供应商日配额或财务事实；上线必须按钱包合同、正常峰值和真实 Valkey/钱包压测审批。

## 低基数观测

重点指标全部使用固定名称或固定枚举，不包含 IP、路径、运营商、玩家、会话、轮次和交易 ID：

- `rgs_preauth_capacity_rejected_total`
- `rgs_capacity_rejected_total`
- `rgs_cryptographic_capacity_rejected_total`
- `rgs_new_intent_capacity_rejected_total`
- `rgs_shared_admission_limited_total`
- `rgs_shared_admission_errors_total`
- `rgs_economic_admission_allowed_total`
- `rgs_economic_admission_limited_total`
- `rgs_economic_admission_operator_limited_total`
- `rgs_economic_admission_backend_limited_total`
- `rgs_economic_admission_errors_total`
- `rgs_http_active_connections`
- `rgs_http_active_requests`
- `rgs_access_logs_emitted_total`
- `rgs_access_logs_dropped_total`
- `rgs_security_logs_dropped_total`

告警必须结合边缘请求量、WAF action、ALB target 5xx/延迟、CPU throttling、DB pool wait、Valkey 延迟和钱包 bulkhead；单个应用计数器不能证明攻击来源或 DDoS 防护认证。

## 验证

```bash
cd server
go test ./internal/platform ./internal/sharedadmission ./internal/rgs ./internal/rgsapi ./cmd/rgs-server
go test -race ./internal/platform ./internal/sharedadmission ./internal/rgs ./internal/rgsapi ./cmd/rgs-server
```

显式本机 abuse profile 仅验证早拒绝、不触达受保护协调器和有界身份聚合，不代表公网带宽、TLS、HTTP/2、ALB、WAF、CloudFront 或 Shield 认证：

```bash
RGS_DDOS_ABUSE_REQUESTS=10000 RGS_DDOS_ABUSE_CONCURRENCY=128 \
  ./scripts/ddos-abuse-profile.sh
```
