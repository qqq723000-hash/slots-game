# Security and compliance boundary / 安全与合规边界

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

## English summary / 英文摘要

This document defines the mandatory security and compliance boundary for the repository's production-oriented building blocks. Required production configuration, cryptographic material, database and wallet dependencies, audit delivery, and operational controls fail closed, but source code, images, simulations, tests, and internal review are not evidence of authorization or certification. Real-money release remains prohibited until the exact operator, jurisdiction, game definition, executable images, and infrastructure have the required licensing, independent RNG and mathematics review, security assessment, wallet conformance, privacy controls, responsible-gaming controls, incident response, reconciliation, business continuity, and operational acceptance.

状态：强制生产边界
最后更新：2026-08-16

仓库包含面向安全的构建块；它不是已授权、已认证或交钥匙真实货币博彩系统。任何源码树、Docker
镜像、模拟报告、单元测试、厂商声明或内部评审都不能替代运营辖区所需的审批。

## 1. 强制外部门禁

真实货币发布在以下证据存在前仍被禁止——针对确切运营商、辖区、游戏定义、可执行/容器镜像与
基础设施配置：

1. 适用博彩运营商/供应商牌照与监管/游戏审批。
2. 独立 RNG 实现/熵评审与由受认可测试机构进行的数学/RTP/特性认证。
3. 独立应用、基础设施与密码学安全评审，含渗透测试与修复验证。
4. 运营商专属钱包适配器与一致性认证，含提交后超时与幂等失败模式。
5. 法务/隐私评审、数据处理协议、保留计划与玩家权利流程。
6. 获批 KYC/年龄、AML/制裁、地理定位、自我排除、存款/损失/会话限制、现实检查与其他责任博彩
   控制。
7. 事件响应、对账、业务连续性、灾难恢复、监控、支持与变更管理的运维验收。

适用哪些牌照、测试、控制与保留期是部署的法务与监管决定，而非硬编码仓库声明。

## 2. 失败即拒绝的生产不变式

生产配置在以下任一缺失或无效时必须拒绝启动：

- 持久 PostgreSQL 连接；生产 `RGS_DATABASE_URL` 必须恰有一个
  `sslmode=verify-full` query 参数，拒绝缺失、降级模式与重复/冲突参数；
- 与 one-shot `rgs_migrator` 完全分离的 `rgs_runtime` DML-only 凭据、精确 migration
  manifest 和最小权限验证；
- 确切 HTTPS 公开 base URL，并带本地 TLS 或显式可信 TLS 终结器；
- 确切 HTTPS CORS 允许列表（无通配）；
- 运营商配置与活跃用途限定验证密钥；
- 一份 `rgs-operators-v2` 信任文档，每个运营商有独立 access-token 签名材料与所需活跃/保留验
  证密钥；
- 每个服务副本上一个共享 launch 派生 HMAC 密钥（`RGS_LAUNCH_HMAC_KEY_FILE`）；
- 一个与 `RGS_HTTP_ADDR` 不冲突的私有/回环运维监听器
  （`RGS_OPERATIONS_HTTP_ADDR`）和一个 regular、最小 16 字节、无空白、无执行/组写/任何 world
  权限的 `RGS_OPERATIONS_BEARER_TOKEN_FILE`；生产环境、以及任意环境的非回环监听必须用常量时间
  Bearer 比对保护 `/readyz` 与 `/metrics`；无鉴权 `/healthz` 也只能存在于该私有运维监听器，
  三个运维端点均不得发布到公网监听器；
- 确切规范数学定义文件（`RGS_DEFINITION_FILE`）、匹配哈希、签名
  `rgs-definition-approval-v2` `APPROVED` 封套、至少一个数学报告、RNG 报告和逐辖区审批的外部引用，
  以及独立挂载可信 Ed25519 公钥（`RGS_DEFINITION_APPROVAL_PUBLIC_KEY_FILE`）。生产还拒绝
  `gameId` 或定义版本中的 `demo` 标记；开发与预发布的 v1 兼容不授予生产资格；以及
- 生产钱包适配器与响应验证密钥；以及
- 一个 HTTPS 发件箱/审计 sink 加专用 256 位 HMAC 签名密钥。sink 契约与运营商专属保留/一致性
  必须获批。

内存会话/轮次存储、内存 nonce、确定性 RNG 与视觉 fixture 只允许在测试中使用，正式入口不编译
或选择这些适配器。

v2 门禁只证明这些引用与精确定义身份/哈希位于可信密钥签名的封套中。它不读取报告内容、不验证
测试实验室资格，也不构成认证或目标 RTP 声明；外部审批与变更控制仍是强制门禁。

## 3. 密码学与密钥

- 对可赔付结果与凭据生成用 OS/平台密码学随机。认证必须评估熵获取、失败行为、播种/重播种与
  部署二进制。确定性 PRNG 仅属于测试与数学模拟。
- Ed25519 密钥仅用于其配置用途：`HTTP_REQUEST`、`HTTP_RESPONSE`、`ACCESS_TOKEN`。不要跨用
  途、运营商或环境复用密钥对。
- 生产拒绝遗留全局 access-token 密钥配置。V2 access-token `keyId` 值在用途范围唯一，每个验
  证密钥绑定到一个运营商，即使在不同 ID 下配置也拒绝相同 access-token 公开材料。通过文档化的
  publish/switch/retire 重叠轮换；在它签发的每个 token 加时钟偏差过期前不移除旧公钥。
- 在可行处用 KMS/HSM 支持签名保护私钥。否则在镜像外以最小权限文件系统权限挂载只读密钥，并
  有文档化轮换/泄露程序。
- 把定义审批验证密钥当作独立信任锚。不要通过与数学 JSON 与审批封套相同的可变通道存储或授权
  它；否则一次泄露可能伪造全部三者。
- 把 launch HMAC 文件准备为恰好 32 密钥字节的规范标准 Base64 编码，至多一个最终换行。解码密
  钥必须每个副本相同。拒绝 world 可读、组可写或过宽权限。不要记录、烤进镜像或把该密钥复用于
  其他用途。
- 把 launch HMAC 密钥轮换作为协调操作：停止用旧密钥签发，然后等待至少最大五分钟 launch TTL
  加固定 25 小时 launch 幂等保留期，再在副本间一致替换。这在墓碑存在时保留确定性响应重放。
  紧急泄露轮换有意使未完成 launch 与保留重放失效，必须遵循事件 runbook。
- 从冗余可信源同步时钟，对漂移告警，并用短签名/token 有效窗口。
- 在接受跨副本重放风险前在持久/共享存储中消费 nonce。在可行处存摘要并仅在过期后清除。运营商
  请求必须先验签、再按已验证身份准入、最后在业务副作用前原子消费 nonce；签名 429 不得写 nonce。
  周期维护须在有界上下文中公平分批排空 nonce 与 launch 保留记录，不能让一类积压饿死另一类。
- 在每个不可信跳强制现代 TLS，校验主机名与证书链，禁用钱包调用重定向，并考虑互认证 TLS 作
  为附加通道控制。消息签名仍必需。
- 把发件箱端点当作特权部署配置。让它远离请求控制数据，限制工作负载出口与可信 DNS/代理路
  径，禁用重定向，绝不复用 launch/运营商/钱包密钥作其 HMAC。见
  [`outbox-delivery.md`](outbox-delivery.md)。

## 4. 应用控制

- 把所有浏览器输入当敌意。把 access token 绑定到租户、会话、钱包会话、游戏定义、货币与辖
  区。
- 解析严格 JSON 带 body、字段、集合与最多 32 层容器嵌套限制；拒绝未知或重复安全/经济字段与多个
  JSON 值，并在为超深对象逐层分配去重 map 前失败关闭。
- 资金在存储中用整数最小单位，在外部线上用十进制字符串。校验货币指数，绝不用浮点。
- 在联系钱包前持久化规范结果。在提交前针对每个期望字段校验签名钱包收据。
- 强制每会话一个待处理轮次、版本/序号边界、不可变轮次指纹与确切幂等重放。
- 用通用公开错误。绝不暴露 SQL、栈、密钥、签名、钱包传输或内部依赖文本。
- 应用分层准入控制：边缘 DDoS/WAF 限制、端点/租户限制、请求大小限制、连接限制与有界
  worker 队列。每个副本必须设置 `RGS_MAX_IN_FLIGHT_REQUESTS`（1..4096，默认 256）的非阻塞
  公网硬闸门，在签名、令牌和数据库工作前满载返回 `503` 与 `Retry-After`；公网 `/healthz`
  不存在，也不得形成匿名绕过。每次容量拒绝必须精确累加无标签
  `rgs_capacity_rejected_total`，不得混入 `rgs_rate_limited_total`，同时仍按普通 5xx 进入外层
  可用性指标。本地 token bucket 本身不是分布
  式限速。预认证控制不得信任 `X-Forwarded-For`、`RemoteAddr` 或未校验身份：反向代理会让无关玩家
  共享传输地址，而调用方 header 又可伪造。运营商接口仅在请求签名验证后按运营商限流，只有准入
  成功才消费 nonce；因此签名 429 可在有效窗口内原样重试且不会制造 nonce 表写入。客户端接口仅在
  access token 验证后按其 `operator + session` 不可变绑定进入独立有界 bucket。无效 token 不得创建
  bucket，绝不从未校验 `X-Operator-Id` header 构造 key。
- handler 并发闸门不覆盖请求解析前后由 `net/http` 持有的连接。每个公网与运维监听器必须另设
  `RGS_MAX_CONNECTIONS_PER_LISTENER`（1..16384，默认 1024）已接受连接硬上限，覆盖慢请求头、
  TLS、悬挂正文回收与空闲 keep-alive；健康/就绪/指标端点必须拒绝任何声明或分块正文并关闭连接。
  监控 `rgs_http_active_connections / rgs_http_connection_limit`，持续超过 85% 必须告警，不能仅依赖
  handler 内的 `rgs_http_active_requests`。
- 容量闸门的 503 是身份解析前的通用未签名 transport/admission 响应，不是权威业务结果。调用方
  不得据此推断 nonce、launch 或 round 副作用；必须遵循不确定传输与幂等恢复契约，保留业务 body
  和幂等键、使用新 nonce/请求 ID/签名重试或查询状态，绝不能创建新业务身份绕过背压。
- 浏览器对每次 RGS HTTP 请求只生成独立的 CSPRNG W3C `traceparent`，设置 Level 2 random flag，
  不发送 `tracestate`、`baggage`、玩家/会话/轮次或设备标识，也不把 trace 标识写入持久存储。
  CSPRNG 不可用时仅省略该诊断头，不影响权威请求；服务端仍会对不可信远端 Trace ID 做 keyed sampling。
- 钱包 HTTP 客户端除请求超时和有界空闲池外，还必须保持每 wallet host 最多 32 个活跃连接、
  32 KiB 响应头上限并禁用透明响应压缩，防止钱包慢响应、异常大 Header 或压缩载荷放大进程资源。
- 应用浏览器保护：确切 CORS origin、游戏壳的 CSP、无带凭据 URL、`frame-ancestors` 允许列
  表、安全 referrer 策略与短寿命内存 token。

## 5. 数据保护与可观测性

在收集前对玩家、钱包、设备、网络与玩法数据分类。仅收集结算、合规、欺诈控制与支持所需字段。
静态与传输中加密；按角色与运营商租户限制访问；记录与评审特权访问。

结构化日志需要文档化脱敏策略。绝不记录 access token、launch code、私钥、完整签名 body、原始
nonce 或不必要玩家/钱包标识符。指标必须用有界标签，绝不按运营商、玩家、会话、轮次或事务 ID
标签。HTTP 访问日志只允许固定路由类别、request ID 的稳定 SHA-256 摘要、状态、状态类别和耗时；
不得写入 request ID 原值、原始 URL、查询串或 RemoteAddr。请求时延必须使用固定桶直方图，
连接池只暴露进程级 open/in-use/idle/max、wait-count 与 wait-duration。审计导出应防篡改、访问控制
并与数据库/发件箱记录对账。
每次 `/metrics` 抓取必须在一个总计两秒的预算内复用完整就绪检查，只导出无标签布尔指标
`rgs_ready`，不得泄漏检查错误或依赖身份。抓取在 `rgs_ready=0` 时仍返回 200，因此必须同时监控
Prometheus `up`（传输可达）与 `rgs_ready`（流量准入），不得用前者替代后者。

保留与擦除规则可能与博彩、金融、AML 与隐私义务冲突。通过法务策略解决该冲突；不要仅因应用层
账户关闭就删除经济/审计证据。

## 6. 供应链与变更控制

- 具体的固定工具、零豁免扫描、双格式 SBOM、受保护发布 attestation 与 OIDC 签名操作见
  [`../deploy/supply-chain/README.md`](../deploy/supply-chain/README.md)；其静态通过不代表外部
  Environment 审批、Registry immutability、身份权限或监管签收已经配置。
- 锁定 Go 模块与容器基础；按 digest 锁定部署镜像。
- 为每次发布产出 SBOM、漏洞扫描、provenance/attestation 与不可变构建摘要。
- 发布 workflow 必须在无 Registry/OIDC 权限的 job 中，对同一受保护 tag 的 clean checkout 重跑
  源码扫描、`make verify`、PostgreSQL conformance 与 production-configuration runtime smoke；
  候选必须由另一个 fresh checkout job 构建并绑定真实 Git tree。最小发布 job 只能验证并发布该
  artifact，不得重跑依赖或 build，也不得只引用另一个 workflow 的 required-check 状态。视觉冻结
  证据漂移等红门必须直接阻断签名。
- 用独立评审与签名 CI 产物保护分支与发布。
- 对游戏数学变更、审批记录、生产部署、密钥管理、钱包回滚与人工审核解决分离职责。
- 哈希规范游戏定义。任何数学、轴、赔付表、特性、投注限制、RNG、编译器/运行时或相关依赖变更
  触发辖区/运营商变更影响流程，可能需要重新认证。
- 把认证源、构建输入、二进制/镜像、定义、模拟证据与审批引用一起保留为一个发布档案。

## 7. 基础设施与可用性

运行 PostgreSQL 带加密连接、与风险相适应的 HA、测试过的点-in-time 恢复、监控的复制/备份延
迟与定期恢复演练。为每个 RGS 副本设置 `RGS_DB_MAX_OPEN_CONNS`（1..200）和不大于它的
`RGS_DB_MAX_IDLE_CONNS`，并按全部副本与运行时 worker 汇总核算数据库连接预算。每个请求必须有有界业务 context；保持
`read-header ≤ read ≤ request < write` 与 `wallet < request`。每个 runtime 数据库连接必须设置
有界 `statement_timeout` 与 `lock_timeout`，并保持 `lock ≤ statement < request`。若经连接池代理，
把实际 runtime 事务中的 `SHOW statement_timeout` 和 `SHOW lock_timeout` 纳入预发/发布门禁。
超时只能返回可重试的暂时不可用，不得授权新轮次、重跑 RNG 或推断钱包回滚。保持 RGS 在持久存
储外无状态，使副本可安全替换。

数据库变更必须通过独立 one-shot migrator，并按 DBA bootstrap → `up` → `verify` →
runtime rollout 的顺序部署。运行容器不得持有 migrator DSN，runtime 不得拥有受管对象或获得
DDL、TRUNCATE、migration ledger 写权限。具体契约见
[`database-migrations.md`](database-migrations.md)。

仅在私有 `RGS_OPERATIONS_HTTP_ADDR` 用无 Bearer `/healthz` 查存活，用 `/readyz` 查依赖路由；
公网 `RGS_HTTP_ADDR` 上 `/healthz`、`/readyz` 与 `/metrics` 必须为 404。生产 Prometheus 和
编排探针必须从只读 `bearer_token_file` 取 `RGS_OPERATIONS_BEARER_TOKEN_FILE` 的相同值，不得以
内联 token、URL 或命令行传递。`/metrics` 必须在同一总计两秒预算内执行 `/readyz` 的依赖集合并导出无标签
`rgs_ready`；即使该值为 0，抓取 HTTP 仍为 200，告警不得只依赖 Prometheus `up`。优雅关闭必须
停止新投注、完成或留下可恢复持久状态，并允许持久租约安全过期。

启用发件箱投递时，就绪还强制分发器进度与最大未发布事件年龄。它不发送合成审计记录，因此空队
列不证明 sink 可达；保留外部 sink 探针与最旧积压告警。

与运营商定义恢复目标。测试区域/区故障、数据库故障转移、钱包停机、DNS/证书故障、密钥轮换与
从备份恢复。成功健康探针不证明经济正确性或监管合规。

## 8. 审批记录

生产变更控制应至少记录：

| 证据 | 必需身份 |
|---|---|
| 游戏审批/证书 | 辖区、游戏 ID、定义版本/哈希、审批引用 |
| RNG/数学报告 | 实验室、报告版本、测试源/二进制与配置哈希 |
| 安全报告 | 范围、镜像/构建摘要、环境、发现与修复状态 |
| 运营商一致性 | 运营商 ID、钱包适配器版本、密钥、场景与签收 |
| 发布产物 | 源提交、工具链、依赖锁、镜像摘要、SBOM/provenance |
| 运维审批 | runbook、监控、备份/恢复证据、联系与回滚计划 |

若任何身份与部署产物不同，审批不自动延续。停止并跑适用变更影响流程。

## 9. 非规范监管起点

要求因市场而异并随时间变化。作为当前一例，英国博彩委员会发布其
[远程博彩与软件技术标准](https://www.gamblingcommission.gov.uk/licensees-and-businesses/guide/remote-gambling-and-software-technical-standards)、
覆盖 RNG/游戏设计、实现与 RTP 证据的官方
[测试程序](https://www.gamblingcommission.gov.uk/strategy/testing-strategy-for-compliance-with-remote-gambling-and-software-technical/3-procedure-for-testing)，
以及[获批测试机构框架](https://www.gamblingcommission.gov.uk/licensees-and-businesses/guide/test-houses)。
这些链接支持上述边界；它们不确定另一辖区的要求，也不证明本仓库已通过任何测试。发布前直接与
目标监管机构、合格顾问、运营商及其受认可测试机构确认当前规则。
