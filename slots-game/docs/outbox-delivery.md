# 事务型发件箱 HTTP 投递

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

状态：运行时契约 `rgs-outbox-http-v1`
最后更新：2026-07-26

RGS 在与权威状态变更相同的 PostgreSQL 事务中把领域事件写入 `rgs_outbox`。`cmd/rgs-server` 现
在拥有一个受控、至少一次的分发器与一个版本化的 HTTPS sink 适配器。当
`RGS_OUTBOX_ENDPOINT_URL` 为空时，外部投递在开发与预发布中默认禁用；该模式下没有行被标记为已
发布。生产在配置加载时拒绝缺失的 sink URL 或签名密钥。

这是 RGS 定义的传输契约，并非声明某个审计厂商已实现它。一个潜在 sink 必须通过一致性、保留、
访问控制、对账与故障注入评审后才能用于真实货币。

## 请求契约

对一行不可变行，发布者向确切配置的 URL 发送 `POST`，`Content-Type: application/json`，无查询
串，无重定向。body 在重试间稳定，形状如下：

```json
{
  "schemaVersion": "rgs-outbox-http-v1",
  "id": "9007199254740999",
  "operatorId": "operator-a",
  "aggregateType": "round",
  "aggregateId": "rgs-op-v1:example",
  "eventType": "ROUND_COMMITTED",
  "occurredAt": "2026-07-26T01:02:03.0000004Z",
  "payload": {}
}
```

`id` 是十进制字符串，因此 JavaScript 消费者不丢失 64 位精度。租约 owner、租约过期与尝试计数
刻意缺失：改变这些字段会给一个幂等键多个 body。头部为：

| 头部 | 值 |
|---|---|
| `Idempotency-Key` | `outbox-<id>` |
| `X-RGS-Event-Id` | 十进制发件箱 ID |
| `Content-Digest` | `sha-256=:<standard-base64>:` over the exact body |
| `X-RGS-Key-Id` | 配置的 HMAC 密钥标识符 |
| `X-RGS-Signature-Timestamp` | 发送时 UTC Unix 秒 |
| `X-RGS-Signature` | `hmac-sha256=:<standard-base64>:` |
| `Authorization` | 可选配置 Bearer token |

HMAC 输入是这些换行分隔行的 UTF-8 字节，无最终换行：

```text
rgs-outbox-http-v1
"@method": POST
"@authority": audit.example:443
"@path": /rgs/v1/events
"content-digest": sha-256=:...:
"x-rgs-event-id": 123
"x-rgs-key-id": audit-2026-01
"x-rgs-signature-timestamp": 1785000000
```

authority 为小写并在存在时包含显式端口；path 为转义的 URL 路径。sink 必须在常数时间校验摘
要与 HMAC、强制其获批时间戳偏移窗口、拒绝未知或退役密钥 ID，并把重复 ID 绑定到相同 body。它
仅在事件及其幂等记录持久后返回 2xx。重定向与每个非 2xx 状态都是失败。响应 body 被忽略且绝不
记录。

投递至少一次。进程可能收到 2xx 并在 PostgreSQL 确认前终止，因此同一事件可被再次发送。消费
者必须按 `id` 去重；他们绝不能把投递计数当作经济事件。严格顺序按
`(operatorId, aggregateType, aggregateId)` 保留；独立聚合可并发发布。

## 配置

| 变量 | 默认 | 用途 |
|---|---:|---|
| `RGS_OUTBOX_ENDPOINT_URL` | 禁用 | 受信、部署控制的 HTTPS URL，带非空路径 |
| `RGS_OUTBOX_HMAC_KEY_ID` | 无 | 轮换/版本标识符；启用时必需 |
| `RGS_OUTBOX_HMAC_KEY_FILE` | 无 | 恰好 32 随机字节的规范 Base64；启用时必需 |
| `RGS_OUTBOX_BEARER_TOKEN_FILE` | 无 | 可选 token，无空白，至少 16 字节 |
| `RGS_OUTBOX_ROOT_CA_FILE` | 系统根 | 可选附加 PEM 信任根 |
| `RGS_OUTBOX_CLIENT_CERT_FILE` | 无 | 可选 PEM mTLS 证书；与其密钥一起配置 |
| `RGS_OUTBOX_CLIENT_KEY_FILE` | 无 | 可选 PEM mTLS 私钥 |
| `RGS_OUTBOX_OWNER` | 每进程随机 | 可选有界租约 owner 标识符 |
| `RGS_OUTBOX_INTERVAL` | `1s` | 每完成投递轮次后延迟 |
| `RGS_OUTBOX_LEASE_DURATION` | `3m` | 受控认领时长；必须超过有界批窗口 |
| `RGS_OUTBOX_PUBLISH_TIMEOUT` | `10s` | 硬每事件发布截止 |
| `RGS_OUTBOX_BATCH_SIZE` | `100` | 每轮认领最大行数（`1..1000`） |
| `RGS_OUTBOX_MAX_PARALLEL` | `8` | 最大同时发布者（`1..256`） |
| `RGS_OUTBOX_INITIAL_BACKOFF` | `1s` | 首次持久重试延迟 |
| `RGS_OUTBOX_MAXIMUM_BACKOFF` | `5m` | 指数重试上限 |
| `RGS_OUTBOX_WORKER_MAX_STALENESS` | `4m` | 就绪允许的分发器进度最大年龄 |
| `RGS_OUTBOX_BACKLOG_MAX_AGE` | `5m` | 就绪允许的最旧未发布事件年龄 |

HMAC、Bearer 与客户端私钥文件必须是常规文件，且无执行、组写或 world 权限。HMAC 密钥与
launch、运营商、钱包、access-token 密钥分开。轮换时，让 sink 接受新旧密钥 ID，把发布者滚到
新密钥，等过最大重试与事件窗口，然后按获批保留策略退役旧密钥。绝不把密钥放在 URL 或环境值本
身。

端点是管理员控制的信任决策，而非请求输入。把工作负载出口与获批 DNS/代理配置限制到所选
sink，评审私有地址解析，并监控证书/主机名校验。TLS 校验保护每个新连接，但应用代码无法使一
个不受信部署 URL 免受 SSRF 或 DNS rebinding。

## 就绪、指标与关闭

投递启用时，`/readyz` 包含 `outbox_delivery` 并在首次投递轮次完成前返回未就绪。它在循环停
滞、上次存储/租约轮次失败、PostgreSQL 无法回答积压检查、或未发布行超过
`RGS_OUTBOX_BACKLOG_MAX_AGE` 时也失败。探针不制造审计事件，因此空积压不证明当前 sink 可达；
生产监控还必须对投递失败、最旧行年龄与 sink 自身可用性告警。

`/metrics` 导出认领、已发布、已延迟与租约丢失尝试的有界计数器。日志仅包含这些计数、状态码
与有界错误——而非 payload、事件 ID、凭据、URL 或响应 body。在 SIGTERM/SIGINT 上分发器接收取
消、停止认领工作并在 `RGS_SHUTDOWN_TIMEOUT` 内被等待；未确认的租约在过期后仍可恢复。
