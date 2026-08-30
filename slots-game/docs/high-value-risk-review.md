# Durable high-value payout review boundary / 高额派奖持久审批边界

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

## English summary / 英文摘要

This optional fail-closed gate is disabled by default, so the existing `PREPARED` to wallet-terminal economic path is unchanged unless every required policy setting is present and valid. When enabled, a qualifying result and its policy evidence are persisted as `RISK_PENDING` in the authoritative PostgreSQL transaction before any wallet call, and expiry or review cannot invent a new RNG result. The feature is not a regulatory approval, AML system, or operator risk platform; production enablement still requires approved thresholds, reviewer identity, SSO and MFA, separation of duties, audit retention, operational procedures, and jurisdiction-specific acceptance.

该功能是可选安全闸门，默认关闭。关闭时不会写 `RISK_PENDING`，现有
`PREPARED -> WALLET_PENDING -> COMMITTED/REJECTED` 经济路径保持不变。它不是监管批准、
反洗钱系统或运营商风控平台的替代品。

## 显式配置

启用时以下设置必须同时存在，任何缺失、越界或未知值都会使进程启动失败：

- `RGS_HIGH_VALUE_RISK_ENABLED=true`
- `RGS_HIGH_VALUE_RISK_THRESHOLD_MINOR`：正整数，单位是轮次币种的最小货币单位。
- `RGS_HIGH_VALUE_RISK_POLICY_VERSION`：已审批的不可变策略版本标识。
- `RGS_HIGH_VALUE_RISK_REVIEW_TTL`：`1m` 到 `72h`。
- `RGS_HIGH_VALUE_RISK_EXPIRY_POLICY`：仅 `REJECT` 或 `MANUAL_REVIEW`。
- `RGS_HIGH_VALUE_RISK_EXPIRY_BATCH_SIZE`：后台每轮处理 `1..1000` 条。

功能关闭时配置任何上述活动参数也会失败启动，防止“看似配置但实际未启用”。当前阈值是
单一最小单位阈值；多币种生产部署必须由运营商证明一个阈值对全部已启用币种均正确，或在
后续版本交付逐币种策略后再启用。

## 状态与事务

达到阈值的首次 RNG 结果在持有 PostgreSQL 会话锁时一次性持久化：候选结果、结果哈希、
钱包命令摘要、钱包能力快照、钱包账本占位、风险策略版本、阈值、到期时间、到期策略和风险
摘要哈希与会话 `pending_round_id` 同事务提交。轮次状态为 `RISK_PENDING`，`wallet_phase` 为空、
`next_attempt_at` 为空，因此钱包恢复扫描和直接 claim 均不能外呼钱包。风险待决期间新的 Spin
被持久 `pending_round_id` 阻止；同一轮次重试只返回 `RISK_PENDING`，不会重新运行 RNG。

`ROUND_RISK_PENDING` 是审计/集成 Outbox 事件，不是钱包命令。它只包含轮次定位、策略版本、
阈值、候选派彩金额、币种、到期策略/时间和摘要哈希，不包含棋盘、中奖线、游戏事件、玩家或
钱包身份。金额只进入受控风险事件，不进入日志、指标或 trace 属性。

`POST /operator/v1/risk-decisions` 复用运营商 Ed25519 HTTP Message Signature、签名覆盖的
`Idempotency-Key`、nonce 防重放、租户绑定、准入和响应签名。请求只接受 `APPROVE`/`REJECT`
和固定原因码，不接受自由文本。批准只接受 `RISK_APPROVED`；拒绝只接受
`RISK_POLICY_REJECTED`、`RISK_FRAUD_SUSPECTED` 或 `RISK_OPERATOR_REJECTED`。

- `APPROVE`：在单个 PostgreSQL 事务中把轮次转为 `PREPARED/APPLY`、写审批归因和审计
  Outbox；HTTP 事务本身不调用钱包，后台 fenced claim 才能执行钱包命令。
- `REJECT`：在单个事务中把轮次和钱包账本转为拒绝终态、清除会话 pending 并写审计
  Outbox；绝不调用钱包。
- 到期：后台 Worker 使用 PostgreSQL 时钟和有界批次执行创建时固化的 `REJECT` 或
  `MANUAL_REVIEW` 策略。晚到审批会先提交到期终态，再返回冲突。
- 精确重复审批：只有同一轮次、同一签名幂等键、同一 decision/reason 指纹才重放最初决定和
  `decidedAt`；其他重复请求返回冲突。

状态查询和审批响应在未提交前都不返回候选完整结果，避免未经批准的派奖表现泄露给客户端或
运营审批调用方。

## 发布与剩余门禁

`0011_high_value_risk_review` 会扩展轮次状态和运行时最小权限。旧应用不认识
`RISK_PENDING`，因此首次启用必须在所有 API/Worker 实例升级且迁移/权限 readiness 通过后进行；
禁止在混跑旧二进制时开启该策略。部署 Chart 尚未在本纵向切片中暴露这些环境变量，生产启用前
必须增加 secret/config 发布合同及静态渲染测试。

签名 `keyId` 只能证明运营商系统凭据，不能证明具体人工审批者。商用启用前仍需外部运营平台
提供个人 SSO/MFA、角色分离、按司法辖区的双人复核、工单/案件号保留、撤权 SLA、审批队列、
异常检测、数据保留与监管审计导出，并通过钱包/运营商联合故障演练。当前接口刻意没有伪造这些
外部控制。
