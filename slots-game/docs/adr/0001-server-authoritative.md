# ADR-0001：服务端权威结果与记账 / Server-Authoritative Results and Accounting

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

> **Personal independent project notice:** The implementation and delivery documentation in this repository are maintained by an independent individual developer and are built toward commercial-grade source-delivery standards.
> Production, operations, platform, security, audit, legal, compliance, and approval roles mentioned here remain responsibilities that an adopter must establish in its external environment.
> Repository content does not mean the system is live or that any service level, commercial authorization, asset authorization, or regulatory certification has been obtained; third-party components and assets remain subject to their respective licenses and rights boundaries.

- 状态：已接受

  Status: Accepted
- 日期：2026-07-25

  Date: 2026-07-25

## 背景 / Context

视频老虎机客户端必须在不可靠的设备与网络上快速动画并保持响应。然而它是一个不可信环境：
JavaScript 可被修改、调用可被重放、消息可被重排、本地状态可被伪造。在浏览器中生成可赔付网
格、评估获胜、跟踪特性计数器或维护余额，会使经济正确性依赖表现代码。

A video-slot client must animate quickly and remain responsive on unreliable devices and networks. However, it is an untrusted environment: JavaScript can be modified, calls can be replayed, messages can be reordered, and local state can be forged. Generating payable grids, evaluating wins, tracking feature counters, or maintaining balances in the browser would make economic correctness depend on presentation code.

该设计还要求确定性的重试行为。一次提交旋转后丢失 HTTP 响应绝不能导致第二次扣费或不同结果。

The design also requires deterministic retry behavior. Losing an HTTP response after a spin has been committed must never cause a second debit or a different result.

## 决策 / Decision

Go 服务是以下事项的唯一权威：

The Go service is the sole authority for the following:

- 接受的投注选项与扣费金额；

  Accepted bet options and debit amounts;
- 随机采样与最终 `grid[reel][row]`；

  Random sampling and the final `grid[reel][row]`;
- 获胜评估与总赔付；

  Win evaluation and total payout;
- 特性触发、计数器、模式与迁移；

  Feature triggers, counters, modes, and transitions;
- 余额变更；

  Balance changes;
- 轮次幂等性与规范存储结果。

  Round idempotency and the canonically stored result.

客户端在首次旋转尝试前生成唯一 `roundId`，并在精确重试中复用。服务端把
`(sessionId, roundId)` 关联到规范化的经济请求哈希与规范 `spin.result`。

Before the first spin attempt, the client generates a unique `roundId` and reuses it for exact retries. The server associates `(sessionId, roundId)` with a canonical economic-request hash and the canonical `spin.result`.

- 精确重复返回存储结果。

  An exact duplicate returns the stored result.
- 用不同经济输入复用键返回幂等冲突。

  Reusing the key with different economic input returns an idempotency conflict.
- 一个特性状态版本的旋转被串行化。

  Spins against one feature-state version are serialized.

服务端在暴露结果前持久化/可恢复地记录结果。生产记账使用事务型账本集成或带对账的预留/结算
saga；内存余额实现只允许用于隔离测试。

Before exposing a result, the server records it durably or in a recoverable form. Production accounting uses a transactional ledger integration or a reservation/settlement saga with reconciliation; the in-memory balance implementation is allowed only for isolated tests.

所有资金在 Go 中表示为已校验的整数最小单位，线上为十进制最小单位字符串。生产 RNG 在审计过
的接口后提供。测试与模拟可注入确定性 RNG，但客户端提供的种子绝不控制生产结果。

All monetary values are represented in Go as validated integer minor units and on the wire as decimal minor-unit strings. Production RNG is provided behind an audited interface. Tests and simulations may inject deterministic RNG, but a client-supplied seed never controls production results.

浏览器接收事实，仅负责表现。它可改变转轴时序、填充运动、粒子与不可赔付的装饰细节，但必须停
在所提供的网格上并显示所提供的经济性。

The browser receives facts and is responsible only for presentation. It may vary reel timing, fill motion, particles, and non-payable decorative details, but it must stop on the supplied grid and display the supplied economic values.

## 后果 / Consequences

### 正面 / Benefits

- 浏览器修改不能直接选择结果或增加余额。

  Browser modifications cannot directly select outcomes or increase balances.
- 网络重试是安全的，已提交轮次可被恢复。

  Network retries are safe, and committed rounds can be recovered.
- 游戏数学可独立于 PixiJS 动画进行单元测试、模拟、版本化与审计。

  Game mathematics can be unit-tested, simulated, versioned, and audited independently of PixiJS animation.
- 规范结果支持确定性播放、快速停止与重连。

  Canonical results support deterministic playback, quick stop, and reconnection.
- 钱包、RNG 与存储实现保持可替换的端口。

  Wallet, RNG, and storage implementations remain replaceable ports.

### 成本与风险 / Costs and Risks

- 旋转延迟包含一次服务端往返与持久工作。

  Spin latency includes a server round trip and persistence work.
- 正确的钱包/结果顺序与对账比浏览器内计算实质上更复杂。

  Correct wallet/result ordering and reconciliation are materially more complex than browser-side calculation.
- 服务必须保留解释历史轮次所需的不可变游戏定义版本。

  The service must retain immutable game-definition versions needed to interpret historical rounds.
- 表现必须优雅处理延迟、重复与重放的结果。

  Presentation must handle delayed, duplicate, and replayed results gracefully.
- 服务端权威本身并不充分：真实货币使用仍需要认证、速率限制、RNG 认证、账本管控、监控与监管
  审批。

  Server authority alone is insufficient: real-money use still requires authentication, rate limiting, RNG certification, ledger controls, monitoring, and regulatory approval.

## 被拒绝的替代方案 / Rejected Alternatives

### 客户端生成结果 / Client-Generated Results

被拒绝，因为客户端及其本地状态可被玩家控制，且重连无法可靠重建记账真相。

Rejected because the player can control the client and its local state, and reconnection cannot reliably reconstruct the accounting truth.

### 服务端提供种子加客户端评估 / Server-Provided Seed with Client Evaluation

M1 拒绝。尽管它可使播放可复现，但它暴露数学包、扩大可信客户端面，且不消除权威服务端记账的
需要。

Rejected for M1. Although it can make playback reproducible, it exposes the math package, expands the trusted-client surface, and does not eliminate the need for authoritative server-side accounting.

### 重试时生成新结果 / Generate a New Result on Retry

被拒绝，因为扣费/提交后丢失的响应可能产生不同结果或重复经济操作。

Rejected because a response lost after debit/commit could otherwise produce a different result or duplicate an economic operation.
