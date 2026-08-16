# RGS 生产部署参考

本目录提供正式 RGS、数据库迁移器、静态前端、可观测性和供应链发布边界。个人电脑上的完整
生产模式部署统一使用 [`local-production/README.md`](local-production/README.md)；外部平台部署
必须复用同样的失败闭合原则。

上线前至少阅读：

- [运营商集成](../docs/operator-integration.md)
- [数据库迁移](../docs/database-migrations.md)
- [故障恢复](../docs/failure-recovery.md)
- [安全控制](../docs/security-compliance.md)
- [RGS OpenAPI](../server/openapi.yaml)

## 镜像构建

仓库根目录是唯一 Docker 构建上下文：

```sh
docker build --file deploy/Dockerfile --target migrator --tag slots-rgs-migrator:local .
docker build --file deploy/Dockerfile --target runtime --tag slots-rgs-runtime:local .
```

`migrator` 只包含 `/rgs-migrator`，`runtime` 只包含 `/rgs-server`；禁止合并入口或共享数据库
凭据。前端正式镜像必须提供完整 RGS 构建参数，并通过外部发布资源审批文件：

```sh
RELEASE_ASSET_APPROVAL_FILE=/secure/release/asset-approval.json \
VITE_RGS_BASE_URL=https://rgs.example \
VITE_RGS_BET_OPTIONS_MINOR=10,20,50,100,200 \
VITE_RGS_DEFAULT_BET_MINOR=100 \
VITE_RGS_HOST_ORIGIN=https://operator.example \
WEB_RELEASE_VERSION=1.0.0 \
WEB_RELEASE_REVISION=0123456789abcdef0123456789abcdef01234567 \
  make build-web-release-image
```

审批文件只通过 BuildKit secret mount 传入，不得进入 Git、构建上下文、镜像层或日志。四项
`VITE_RGS_*` 是公开配置，但必须同时通过构建校验、Nginx CSP 渲染和 `nginx -t`。生产镜像
只能从 `release-build` 复制已审批产物；公开版本与完整提交摘要还会进入可复算发布清单和
OCI 标签，不得填入 Secret、宿主路径或自由文本。

`static-conformance` 与 `config-conformance` 目标仅供 CI 校验文件边界、非 root 用户和安全
响应头，并带有明确的不可发布标记；它们不是部署入口。验证命令：

```sh
make verify-web-container-contract
make verify-supply-chain-contract
make verify-observability-contract
```

后端 CI 分别执行快速运维探针和 `make smoke-runtime-production`，验证 TLS PostgreSQL、
v2 定义审批结构、认证运维面、审计出口及负向配置。测试使用的短命材料不会成为生产凭据。

## PostgreSQL 一致性环境

此 Compose 文件只运行绑定到回环地址的 PostgreSQL 实例。它刻意不模拟托管高可用、数据库
加密传输、备份/PITR、监控或 Secret 管理。

```bash
export POSTGRES_PASSWORD='use-an-untracked-local-secret'
export RGS_MIGRATOR_PASSWORD='use-a-distinct-untracked-migrator-secret'
export RGS_RUNTIME_PASSWORD='use-a-distinct-untracked-runtime-secret'
docker compose --file deploy/docker-compose.postgres.yml up -d
```

角色引导只在 PostgreSQL 初始化全新卷时运行。如果旧开发卷早于此契约，必须先用 `down -v`
销毁，再重新创建。仅对这个本地数据库，迁移器与运行时分别使用带 `sslmode=disable` 的连接串。
生产环境必须使用 Secret 注入的凭据、TLS 校验、明确的连接上限、高可用和经过演练的恢复流程。

部署顺序固定为：DBA 角色引导、迁移器 `up`、迁移器 `verify`、运行时滚动发布，最后通过运维
监听器上带认证的 `/readyz` 准入。绝不能把迁移器 DSN 挂载到运行时工作负载。

## 运行形态

[`env.example`](env.example) 只用于参考变量名称和默认值，不能作为真实 Secret 的来源。运营商
配置、精确的规范化数学定义、其签名审批信封、独立控制的审批公钥、其他公钥、共享启动 HMAC
Secret 和私钥句柄均须只读挂载。`RGS_LAUNCH_HMAC_KEY_FILE` 必须包含恰好 32 个随机字节的
规范标准 Base64（末尾最多允许一个换行），所有副本内容必须一致，并且不得具有执行权限、组
写权限或任何其他用户权限。`RGS_OPERATIONS_BEARER_TOKEN_FILE` 也必须是常规只读 Secret
文件；内容至少包含 16 个非空白字节，并遵守相同权限规则。它只用于认证 `/readyz` 和
`/metrics`，必须与运营商及钱包密钥分开挂载，且绝不能复制到环境变量、URL、命令行或日志。
生产环境以及任何环境中不绑定回环地址的运维监听器，缺少此文件时都必须拒绝启动。
生产环境还必须配置
[`../docs/outbox-delivery.md`](../docs/outbox-delivery.md) 所述、使用独立密钥的 HTTPS 审计
接收端；其 HMAC、可选 Bearer token 和可选 mTLS 私钥必须分别作为只读 Secret 管理。

`RGS_DB_MAX_OPEN_CONNS` 和 `RGS_DB_MAX_IDLE_CONNS` 定义单个 RGS 副本的有界
PostgreSQL 连接池（默认分别为 `40` 和 `10`）。`open` 接受 `1..200`，`idle` 接受
`0..open`。配置值必须来自已审批的数据库连接总预算，并在所有 RGS 副本、恢复/outbox
工作器及其他运行时消费者之间分配；扩容副本前必须重新计算该预算。

`RGS_MAX_IN_FLIGHT_REQUESTS` 定义单个副本上非阻塞的公网请求预算（默认 `256`，接受范围
`1..4096`）。它在请求签名/token 校验和数据库工作之前生效，不使用 `X-Forwarded-For` 或
任何由调用方控制的身份。达到容量时，业务端点返回带 `Retry-After: 1` 的
`503 SERVICE_UNAVAILABLE`；`/healthz` 绕过此闸门，使编排器仍能区分“进程存活但已饱和”。
认证后仍须保留按签名租户划分的限流器，并维持独立的边缘 DDoS 防护。由于此闸门先于身份和
签名解析运行，其 503 是通用的未签名传输/准入响应，绝不是经过认证的运营商业务结果。
运营商必须遵循既有的不确定传输契约：等待 `Retry-After`，在可用时查询状态，或使用相同正文
和幂等键以及新的 nonce/request ID/签名重试。不得据此推断 nonce 或轮次是否产生副作用，也
不得创建新的会话或轮次身份来绕过容量饱和。

`RGS_MAX_CONNECTIONS_PER_LISTENER` 是每个副本、每个监听器的已接受连接硬预算
（默认 `1024`，范围 `1..16384`）。它位于 HTTP handler 之前，覆盖慢请求头、未读
正文回收、TLS 握手和空闲 keep-alive；因此 `/healthz` 虽绕过业务请求闸门，也不能
无限消耗文件描述符或 goroutine。运维端点只接受无正文 GET，声明 `Content-Length`
或 `Transfer-Encoding` 均以 `400` 和 `Connection: close` 拒绝。容量规划必须同时核对
容器 `nofile`、边缘连接限制、TLS 内存和最坏 ReadTimeout，并为公网和私有监听器各自
预留该预算。

`RGS_RATE_PER_SECOND` 和 `RGS_RATE_BURST` 是单副本的认证后限流参数：带签名的运营商调用
使用已验证的运营商身份，浏览器调用使用已验证 access-token 中的 `operator + session` 绑定。
客户端路径不以 `RemoteAddr` 或 `X-Forwarded-For` 为键；否则可信反向代理会把无关玩家合并到
同一桶中，而不可信的转发头又会允许键空间喷洒。无效 token 绝不会分配限流器状态。必须保留
独立的边缘/分布式 DDoS 策略，因为这些有界本地桶不会跨副本协调。

当 `RGS_ENVIRONMENT=production` 时，定义审批信封必须使用
`rgs-definition-approval-v2`。其 Ed25519 签名载荷把精确的游戏 ID、定义版本和 SHA-256 摘要，
与至少一个外部数学报告引用、RNG 报告引用和司法辖区专用审批引用绑定。包含 `demo` 的游戏 ID
或定义版本会被拒绝。开发和预发布环境为兼容性保留带签名的 v1 结构。这些检查只认证证据身份；
不会检查、生成或认证被引用的报告，占位符/示例引用绝不能作为可部署审批。

[`operators.example.json`](operators.example.json) 展示严格的 `rgs-operators-v2` 结构，但不能
直接部署：其中的主机、有效期和密钥路径都是占位值。V2 要求每个运营商使用独立的 access-token
签名密钥，并允许保留仅用于验签的旧密钥来完成轮换。即使 key ID 不同，加载器也会拒绝复用
access-token 公钥材料。生产环境拒绝旧版 `rgs-operators-v1` 全局密钥结构。

文档内的路径均相对于该文档解析。公钥文件必须且只能包含一个 Ed25519 PKIX `PUBLIC KEY` PEM
块；私钥文件必须且只能包含一个未加密的 Ed25519 PKCS8 `PRIVATE KEY` PEM 块，必须与声明的
公钥匹配，并且不得具有执行权限、组写权限或任何其他用户权限。应优先用经过评审的 KMS/HSM
适配器替代文件型私钥签名，避免把可导出的生产私钥放到磁盘。轮换时遵循
[`../docs/access-token-key-rotation.md`](../docs/access-token-key-rotation.md) 的分阶段流程。
TLS 必须在 RGS 进程内终止，或由无法绕过的可信上游终止。

两个镜像均为 distroless 且以非 root 用户运行，不包含 shell 或内置探针客户端。
`RGS_HTTP_ADDR` 是公网 RGS 监听器；在运维端点中仅保留 `GET /healthz`，用于兼容无认证存活
探测，`/readyz` 和 `/metrics` 在该监听器上返回 404。`RGS_OPERATIONS_HTTP_ADDR` 是独立的
回环/私网运维监听器，生产环境中不得与公网监听器重叠，也不得随公网监听器一起发布。它提供：

- `GET /healthz`：可选的无认证运维存活检查；
- `GET /readyz`：依赖就绪检查；生产环境或监听器不绑定回环地址时必须使用 Bearer 认证；
- `GET /metrics`：Prometheus 抓取端点；生产环境或监听器不绑定回环地址时必须使用 Bearer
  认证。

运行时镜像中的 `EXPOSE 8080 8081` 仅为 OCI 元数据。8080 只发布到经过评审的业务 Ingress，
8081 只接入私有运维网络；绝不能把 8081 映射到公网负载均衡器。

同一个运维 Secret 必须只读挂载到抓取器，并通过文件配置，不能内联配置。例如：

```yaml
scrape_configs:
  - job_name: rgs
    static_configs:
      - targets: ["127.0.0.1:8081"]
    authorization:
      type: Bearer
      credentials_file: /run/secrets/rgs_operations_bearer_token
```

每次经过认证的 `/metrics` 抓取都会在总计两秒的预算内运行与就绪检查相同的依赖，并导出无标签
gauge `rgs_ready`。值为 `0` 时，抓取响应仍是 HTTP 200：Prometheus `up` 表示传输可达，
`rgs_ready` 才是流量准入信号。必须同时对两者告警和路由，绝不能只根据 `up` 推断就绪状态。

运行时不会把原始 URL、查询参数、远端 IP、玩家、会话、轮次或交易标识符写入请求日志。每条
记录只包含固定路由类别、存在时经过语法约束的 request ID、状态、状态类别和耗时。Prometheus
遥测同样保持有界：使用固定的请求延迟直方图、活跃请求 gauge，以及数据库连接池的
open/in-use/idle/max、等待次数和等待时长指标来设置饱和告警。无标签累计指标
`rgs_capacity_rejected_total` 只统计进程级在途请求闸门拒绝；它刻意与
`rgs_rate_limited_total` 分离，而相同响应在外层 HTTP 计数器中仍属于普通 5xx。不得添加租户
或由请求派生的指标标签。

滚动替换期间，必须先让实例退出就绪状态，再留足配置的关闭超时。处于持久化中间状态的投注
必须通过已保存的轮次和钱包操作 ID 恢复；绝不能把删除数据行或重新运行 RNG 当作部署补救手段。

配置后，`outbox_delivery` 是 `/readyz` 的必需依赖。它检查工作器进度和未发布事件的最大年龄，
不会创建伪造审计事件。接收端可用性、延迟发布和最旧积压必须分别告警。出口以及可信 DNS/代理
解析必须锁定到经过评审的端点；该 URL 是高权限部署输入，不是运营商请求参数。

`RGS_WALLET_MAX_ATTEMPTS` 限制一个轮次的钱包应用/对账所有权尝试次数。默认值为 `100`，
接受 `1..10000`。耗尽预算后，轮次和会话会进入 `MANUAL_REVIEW`；绝不能通过提高上限或重启
副本绕过这个终态运维状态。应结合各运营商的钱包 SLA、事件响应和对账操作手册确定该值，并在
耗尽前充分提前告警。

除请求超时和有界空闲池外，对每个钱包主机的出站钱包 HTTP 还硬性限制为最多 32 条活跃连接、
32 KiB 响应头，并关闭透明响应压缩。钱包与 RGS 副本数必须按运营商 SLA 规划；故障期间也不得
取消这个单主机上限，否则缓慢或失败的钱包会让连接持续增长，最终耗尽进程或上游资源。

`RGS_ACCESS_TOKEN_TTL` 限制每个浏览器凭据的有效期；它不会定义或延长持久化游戏会话的生命
周期。经过审批的客户端集成必须在 token 到期前，携带仍然有效的 Bearer token 和精确的会话
绑定调用 `POST /client/v1/sessions/refresh`。新 token 的有效期会截断到会话的 `expiresAt`。
应确保 Ingress/CORS 策略允许该 POST，并保留 `Authorization`、`Content-Type` 和
`X-Request-Id`；监控刷新请求的 401、410 和 423 响应，但不能记录新旧任一 token。未实现刷新
的客户端不适合长会话或免费旋转序列。

## 此示例之外的生产必备项

- 托管 Secret、KMS 或 HSM 签名，以及经过审批的文档化密钥轮换执行；
- Ingress/WAF/DDoS 控制、精确的 origin/frame 策略和私有运维端点；
- 跨可用区 RGS 副本，以及共享、持久化的 nonce/幂等状态；
- 托管 PostgreSQL 高可用、加密传输/存储、PITR 和恢复演练；
- 集中式结构化日志、有界基数指标、告警和不可变审计导出；
- 各运营商专用的对账、审计接收端一致性和 outbox 事件操作手册；
- 在接入任何真实资金流量前，具备牌照、独立 RNG/数学认证、安全审计，以及每个运营商各自的
  钱包适配器/一致性审批。
