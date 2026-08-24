# RGS 可观测性本机与 CI 契约

本目录只用于本机集成验收和 CI 契约验证，提供 Prometheus 抓取与告警规则、Grafana 声明式
数据源/仪表盘、Vector 容器 stdout 收集与 HTTPS 出口，以及一个明确未获批准的保留策略模板。
AWS 正式环境不得部署本目录的 Compose 单节点栈；正式链路必须按 AWS 架构接入
Prometheus Agent 或 ADOT、AMP、CloudWatch Logs、AMG、公司告警路由及审计证据系统。本目录
保留供应商中立的规则和脱敏约束，供正式平台实现与验收时复用，但不构成云端能力已落地的证明。

## 安全不变量

- `RGS_OPERATIONS_HTTP_ADDR` 是独立运维监听器。生产应绑定 Pod/容器私网地址，且只让
  Prometheus、编排器健康探针和值班跳板访问；公网 ingress 不得转发 `/readyz` 或
  `/metrics`、`/healthz`。运维端口的 `/healthz` 无需 Bearer 且只证明进程存活；
  `/readyz` 与 `/metrics` 才要求认证。Prometheus 通过 `authorization.credentials_file`
  读取与 RGS 相同的运维 Bearer secret，值不进入配置或环境变量。接流必须以运维端口的
  `/readyz` 为准。
- Compose 默认只把 Prometheus/Grafana 端口绑定到 `127.0.0.1`。生产 Grafana 仍需置于
  SSO/MFA/RBAC 代理之后；不得通过修改 `OBSERVABILITY_BIND_ADDRESS=0.0.0.0` 直接暴露。
- 仓库不包含任何可变镜像 tag。`PROMETHEUS_IMAGE`、`GRAFANA_IMAGE`、`VECTOR_IMAGE`
  必须由发布系统提供已评审的 `name@sha256:<64 hex>` 引用并保存 SBOM/来源证明。
- Vector 不读取 `docker.sock`，仅只读挂载精确的 RGS stdout 日志目录。日志通配符不得
  扩大到整台节点；发布 glob 必须位于 `/var/log/containers/`、只有一个 `*`、
  basename 含独立 `rgs-server` 身份段并以 `.log` 结尾，`*.log` 等全节点模式会被拒绝。
  这个语法门禁不能代替平台对实际 Pod/容器 identity 的审批。接收端 URI 不得携带
  用户名、令牌或 query secret。认证应由受控 mTLS
  egress proxy 或平台工作负载身份提供。Vector 额外连接一个外部提供的受限 egress
  网络；平台防火墙和 DNS policy 必须只允许审批日志接收端的精确地址/端口，禁止入站。
  宿主需用专用只读 GID/ACL 授权日志目录，并预创建仅 UID 65534 可写的 Vector state
  目录；不得把 Vector 加入 docker/root 组。`--require-healthy` 使首次部署在接收端不可达
  时退出，避免静默形成“假接通”。Vector 的 `internal_metrics` 以 15 秒周期送入容器内
  Prometheus exporter；`9598` 不发布到宿主，只由 internal `observability` 网络抓取。
  因 Vector 同时连接受限 `log-egress`，平台网络策略还必须拒绝该网络任何主体反向连接
  Vector `9598`，不能把“未映射宿主端口”误当作跨网络访问控制。
  Vector 0.57+ 默认关闭配置环境插值；Compose 只为已校验且明确非秘密的日志 glob 与 HTTPS
  sink URI 启用该能力。发布门禁还会用预载、digest-pinned `VECTOR_IMAGE` 在断网容器内
  执行 `vector validate --no-environment`，版本不认识配置或缓冲约束即拒绝。
- 收集器会删除客户端 IP 和常见敏感字段，把未知路径折叠为 `other`，并把无法解析为
  结构化 JSON 的原始行替换为固定脱敏标记，避免第三方错误文本未经字段过滤进入长期出口；
  可能夹带 DSN、端点或业务标识的 `error`/stack 字段也会删除。这是纵深防御，不是允许
  应用记录请求头、请求体、钱包响应或密钥的理由。容器节点上的原始 stderr 仅可按短期
  故障缓冲处理，不能直接当作长期合规归档。
- nonce replay 等权威安全事件计数不得采样；重复物理 WARN 可以用固定非阻塞预算有界输出。
  无标签 `rgs_security_logs_dropped_total` 只表示重复安全日志被省略，不表示安全事件丢失；
  `RGSSecurityLogDropsSustained` 会对连续五分钟的预算耗尽告警，并要求联合权威事件计数、WAF
  与认证失败排查，禁止为追求重复日志完整而阻塞业务请求线程。权威
  `rgs_auth_replays_total` 由 `RGSAuthenticationReplayDetected` 独立告警，不能依赖物理 WARN
  是否成功写出。共享准入错误和数据库保留容量拒绝分别由 `RGSSharedAdmissionErrors` 与
  `RGSNewIntentCapacityRejected` 告警，避免失败闭合只在客户端表现为 503 却没有值班信号。
- Prometheus 指标/记录规则只有固定标签；禁止新增 operator、player、session、round、
  request、transaction ID 等高基数标签。可用性比例只使用 `rgs_http_server_failures_total`
  （5xx）；`rgs_http_failures_total` 保留全部 4xx/5xx 作为诊断信号，认证攻击或限流不会
  触发服务可用性告警。进程级并发闸门另用无标签累计指标
  `rgs_capacity_rejected_total`，不得复用 `rgs_rate_limited_total`；持续拒绝由
  `RGSCapacityRejectionsSustained` 告警。公网监听器还暴露
  `rgs_http_active_connections` 与 `rgs_http_connection_limit`；最繁忙副本连接使用率持续超过
  85% 由 `RGSConnectionCapacityNearLimit` 告警，可发现不进入 handler 的慢请求头、悬挂正文、
  TLS 或 keep-alive 饱和。业务事件计数不是监管审计证据。
- `retention-policy.example.yml` 永远保持 `DRAFT_NOT_APPROVED`。生产必须在仓库外生成有
  法务/合规批准、司法辖区、到期日、legal hold 与可验证删除要求的副本；不得把示例
  占位符当作批准。
- 告警必须送到外部审批 Alertmanager：使用独立受限 egress 网络和只读 Bearer secret
  文件。仓库中的 `__ALERTMANAGER_TARGET__` 未解析时不构成值班接通证据；发布必须替换
  并完成合成告警演练，不能只证明规则成功计算。渲染产物只允许单一审批 target，
  TLS 必须精确绑定 `ca_file`、`server_name`、`min_version: TLS12` 和
  `insecure_skip_verify: false`。
- Prometheus 会自抓取并监控规则计算/通知错误，同时抓取 Vector 内部指标；Vector 不可
  抓取、日志组件错误、非预期丢弃、约 256 MiB 最小磁盘缓冲超过 80% 以及 sink 有输入无发送都会告警。
  `RGSObservabilityWatchdog` 必须由外部
  dead-man switch 监控缺失。`up{job="rgs"}=1` 只证明 `/metrics` 可抓取；无标签
  `rgs_ready` 会在同次抓取中用与 `/readyz` 相同的有界检查反映 DB/schema/key/outbox
  就绪性，并由 `RGSNotReady` 发出 critical 告警。编排器仍必须直接探测 `/readyz`，
  不能用 scrape up 或仪表盘代替流量门控。

## 部署输入

先由发布系统复制并渲染本目录到一个只读 release bundle。至少替换：

- `prometheus.yml` 中的 `__ENVIRONMENT__`、`__CLUSTER_ID__`；
- `prometheus.yml` 中的 `__ALERTMANAGER_TARGET__`（只写 `host:port`，HTTPS 由配置强制）；
- `rules/rgs-alerts.yml` 和 Grafana 仪表盘中的 `__RUNBOOK_BASE_URL__`；
- `retention-policy.example.yml` 的外部批准副本（示例文件本身不得改成 APPROVED）；
- `prometheus.yml` 的 `rgs-server:8081`，若运维网络中的服务 DNS/端口不同。

发布系统还必须提供下列环境变量；这里故意没有默认镜像 digest、密码或审批值：

```bash
export PROMETHEUS_IMAGE='registry.example/prometheus@sha256:<reviewed-64-hex-digest>'
export GRAFANA_IMAGE='registry.example/grafana@sha256:<reviewed-64-hex-digest>'
export VECTOR_IMAGE='registry.example/vector@sha256:<reviewed-64-hex-digest>'
export PROMETHEUS_RETENTION_TIME='<approved-duration>'
export PROMETHEUS_RETENTION_SIZE='<approved-size>'
export GRAFANA_ADMIN_PASSWORD_FILE='/run/release-secrets/grafana-admin-password'
export RGS_OPERATIONS_BEARER_TOKEN_FILE='/run/release-secrets/rgs-operations.token'
export ALERTMANAGER_BEARER_TOKEN_FILE='/run/release-secrets/alertmanager.token'
export RGS_OPERATIONS_NETWORK='<private-compose-network>'
export RGS_LOG_EGRESS_NETWORK='<restricted-egress-compose-network>'
export RGS_ALERT_EGRESS_NETWORK='<restricted-alert-egress-compose-network>'
export RGS_CONTAINER_LOG_ROOT='<host-or-node-path-exposing-only-rgs-stdout>'
export RGS_CONTAINER_LOG_GID='<dedicated-read-only-numeric-gid>'
export RGS_VECTOR_DATA_DIR='<pre-provisioned-uid-65534-writable-state-dir>'
export RGS_CONTAINER_LOG_GLOB='/var/log/containers/<approved>-rgs-server-*.log'
export RGS_LOG_SINK_URI='https://<approved-log-egress>/v1/logs'
export RGS_OPERATIONS_TARGET='<approved-private-rgs-host>:<port>'
export ALERTMANAGER_TARGET='<approved-alertmanager-host>:<port>'
export ALERTMANAGER_ROOT_CA_FILE='/host/secret-store/<approved-alertmanager-root-ca>.pem'
export ALERTMANAGER_CA_FILE='/run/secrets/alertmanager_root_ca.pem'
export ALERTMANAGER_SERVER_NAME='<approved-alertmanager-host>'
export PROMETHEUS_RENDER_PROFILE='central'
```

`ALERTMANAGER_ROOT_CA_FILE` 是 Compose 宿主侧只读 secret 源文件，必须是真实可读的审批 CA；
`ALERTMANAGER_CA_FILE` 是渲染配置中的固定容器路径，必须保持
`/run/secrets/alertmanager_root_ca.pem`，不能把宿主路径写进容器配置。发布门禁使用
`central` 或 `local-production` 的显式 profile，不接受隐式推断。

镜像引用中的 `<...>` 只是说明文字，不可直接运行。确认 release bundle 已无未解析的
`__PLACEHOLDER__`，镜像均为 digest 引用，密码文件权限收紧，然后执行：

```bash
docker compose --file deploy/observability/compose.yml config --quiet
docker compose --file deploy/observability/compose.yml up -d
```

如使用 Kubernetes、Nomad 或托管服务，可直接挂载同一组 Prometheus/Grafana/Vector
配置，不必采用 Compose；仍需保留上述网络、凭据、镜像 digest 和资源上限不变量。

## 运行与证据

发布后至少验证：

1. 公网业务端口的 `/healthz`、`/readyz` 与 `/metrics` 均返回 404；独立运维端口
   `/healthz` 无 Bearer 返回 200，`/readyz` 与 `/metrics` 缺少/错误 Bearer 返回 401，
   携带 secret 文件中的精确 Bearer 后返回 200；
2. Prometheus `up{job="rgs"}`、`rgs_ready`、`up{job="prometheus"}` 与
   `up{job="vector"}` 为 1，Vector 的 `vector_component_errors_total` 无新增且
   `vector_buffer_size_bytes{component_id="approved_https_archive"}` 未接近约 256 MiB，规则组无
   evaluation error；另从编排器确认 `/readyz` 探针持续成功，不能用 scrape up 代替；
3. Grafana 仪表盘 UID `rgs-release-overview` 可读取但不可 UI 漂移编辑；
4. 向 RGS stdout 写入不含真实个人数据的合成 JSON 日志，确认接收端存在且
   `remote_ip`/令牌字段被删除；不要用真实令牌做探针；
5. 触发不含真实业务数据的合成告警，确认外部 Alertmanager 接收并进入正确值班路由；
   单纯看到 Prometheus `ALERTS` 为 firing 不算完成，并确认外部 dead-man switch 持续
   收到 `RGSObservabilityWatchdog`；
6. 记录实际镜像 digest、渲染配置 SHA-256、告警演练、恢复演练和删除报告。

静态发布门禁：

```bash
make verify-observability-contract
```

该命令会解析 YAML/JSON、检查关键指标/告警/仪表盘、私网绑定、日志最小化、未审批
保留模板和 Compose 供应链约束，并在系统临时目录回归“有效 bundle 通过、删除 RGS scrape
失败、结构非法 rules 失败”。有 Docker Compose 时会用纯占位语法输入执行 `config --quiet`，
不启动容器、也不访问 registry。

发布流水线渲染到独立只读目录后还必须运行 fail-closed 模式；它会重新完整解析 rendered
`prometheus.yml`、`rules/rgs-alerts.yml` 和 Grafana dashboard，断言 RGS/self scrape、Bearer
secret-file、Alertmanager、必需记录规则/告警和 dashboard 信号均未被删除，并拒绝未解析占位符、
非 HTTPS 目标、内嵌认证及 mutable 镜像引用：

```bash
RGS_OPERATIONS_TARGET='<approved-private-rgs-host>:<port>' \
ALERTMANAGER_TARGET='<approved-alertmanager-host>:<port>' \
ALERTMANAGER_ROOT_CA_FILE='/secure/host-secrets/<approved-alertmanager-root-ca>.pem' \
ALERTMANAGER_CA_FILE='/run/secrets/alertmanager_root_ca.pem' \
ALERTMANAGER_SERVER_NAME='<approved-alertmanager-host>' \
PROMETHEUS_RENDER_PROFILE='central' \
RGS_CONTAINER_LOG_GLOB='/var/log/containers/<approved>-rgs-server-*.log' \
OBSERVABILITY_RENDERED_DIR=/secure/rendered/observability \
  make verify-observability-release
```

该生产门禁不会信任宿主 `PATH` 中来源不明的 `promtool` 或 `vector`。发布系统必须提供并
预加载已经评审的 `PROMETHEUS_IMAGE=name@sha256:<digest>` 与 `VECTOR_IMAGE=name@sha256:<digest>`；
门禁以 `--pull never --network none --read-only` 启动前者执行 `check config`/`check rules`，再用
后者解析实际 Vector topology，并分别执行中央归档四组和 local-production 五组
`vector test`：嵌套秘密、未知结构化日志、跨消息字段注入、启动字段保留，以及真实 Docker Fluent
`log` record 的已知 msg/route 语义与容器元数据丢弃。镜像未预加载、
Docker daemon 不可用、任一 transform 断言或任一校验失败都会拒绝发布，校验过程不会联网
拉取替代镜像。Vector 的 `--no-environment` 只用于离线类型/拓扑检查；内置 test 也不能替代
部署后的 exporter、sink 与合成日志探针。

Backend CI 在镜像构建后先运行 `make smoke-runtime-operations` 保留快速 development 检查，
再运行 `make smoke-runtime-production`。两者要求 Linux Docker host networking 及隔离的
`RGS_POSTGRES_MIGRATOR_TEST_URL`/`RGS_POSTGRES_TEST_URL`；后者还接收 workflow service
PostgreSQL container ID，只在短命 CI 容器内安装临时 TLS 证书，并要求 runtime 以
`sslmode=verify-full` 连接。数据库证书使用专用短命 RSA-3072/SHA-256 CA，兼容 CI 的
libpq/OpenSSL 客户端及 SCRAM channel binding，同时保留 `localhost` 与 `127.0.0.1` SAN
主机名校验；门禁不使用 `channel_binding=disable` 绕过证书摘要校验。证书 reload 后先由
runner 使用同一 DML 角色和该独立 CA 建立真实连接，并查询
`pg_stat_ssl.ssl=true`；该有界 barrier 未通过时不会进入后续负向 gate，避免把 TLS 尚未
生效误判成预期的配置拒绝。

production-config smoke 使用显式标记 `CI_ONLY_NOT_RELEASE_EVIDENCE` 的 v2 approval、HTTPS
wallet URL、临时 CA/本地 HTTPS audit sink 和 outbox HMAC；它验证缺 operations token、使用
development v1/demo approval 都拒绝启动，然后验证 production runtime、认证运维面、
`rgs_ready=1` 与 `outbox_delivery` readiness。夹具在退出时删除，secret、负向日志和证书不
上传；runtime 原始 stdout/stderr 也只保存在短命目录，artifact 仅保留探针、指标、migrator
结果和无敏感摘要，并明确标为 `production-config-ci-only-not-release-evidence`。这只能证明
生产配置分支在 CI 失败闭合，不能冒充真实素材/数学/监管审批、外部审计投递或生产部署证据。

## 保留与容量

Prometheus 同时配置时间和容量上限，两者先达到者生效。Vector 使用当前实现允许的精确
最小磁盘缓冲 `268435488` bytes（约 256 MiB），只用于短时出口故障，满载时阻塞而不是丢弃；
sink 保留近无限默认重试，禁止用较小 `retry_attempts` 在短暂中断后丢弃批次。它不是长期归档。
80% 水位、组件错误、非预期
丢弃和有输入无发送均由仓库规则失败闭合，发布后仍必须做合成日志与出口中断演练。日志接收端、Prometheus
卷备份和审计 outbox 必须分别套用获批保留策略，监控磁盘水位，并通过定期 restore
drill 与删除报告证明策略实际执行。legal hold 生效时，普通自动删除不得越过授权流程。
