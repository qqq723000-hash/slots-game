# 代码注释双语规范 / Bilingual Code Comment Standard

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

> **Personal independent project notice:** The implementation and delivery documentation in this repository are maintained by an independent individual developer and are built toward commercial-grade source-delivery standards.
> Production, operations, platform, security, audit, legal, compliance, and approval roles mentioned here remain responsibilities that an adopter must establish in its external environment.
> Repository content does not mean the system is live or that any service level, commercial authorization, asset authorization, or regulatory certification has been obtained; third-party components and assets remain subject to their respective licenses and rights boundaries.

本项目的注释用于解释设计约束、资金安全不变式和异常处理理由，不用于逐句翻译代码。
所有受 Git 跟踪的人工代码注释块都必须遵守本规范，并以中文在前、英文紧邻的方式提供双语说明；
这不是只约束新增注释的基线豁免。

Comments in this project explain design constraints, money-safety invariants, and the reasons for exceptional handling; they do not translate code line by line. Every human-authored comment block tracked by Git must provide bilingual explanations with Chinese first and the adjacent English equivalent; existing comments receive no baseline exemption.

## 必须使用双语注释的场景 / Cases Requiring Bilingual Comments

1. 资金、余额、钱包幂等、轮次恢复、RNG 和持久化状态迁移。

   Funds, balances, wallet idempotency, round recovery, RNG, and persistent-state transitions.
2. 身份验证、签名、密钥、nonce、权限、隐私脱敏和失败即拒绝边界。

   Authentication, signatures, keys, nonces, authorization, privacy redaction, and fail-closed boundaries.
3. 超时、重试、退避、并发锁、租约、资源上限和故障恢复。

   Timeouts, retries, backoff, concurrency locks, leases, resource limits, and failure recovery.
4. 浏览器与 RGS 的一次性凭据、消息顺序、展示层与权威结果的边界。

   One-time credentials and message ordering between the browser and RGS, plus the boundary between presentation and authoritative results.
5. 看似可以简化但实际上不能修改的实现，以及与外部协议/审批绑定的行为。

   Implementations that appear simplifiable but must not be changed, and behavior bound to external protocols or approvals.

注释应说明“为什么”和“不允许发生什么”，例如：

Comments should explain “why” and “what must not happen,” for example:

```go
// 钱包返回不确定结果时保留 WALLET_PENDING，并使用稳定 operation ID 查询；
// 禁止重新运行 RNG 或生成新的扣款命令。
// If the wallet returns an indeterminate result, retain WALLET_PENDING and query with a stable operation ID;
// never rerun RNG or generate a new debit command.
```

## 不应添加的注释 / Comments That Must Not Be Added

- 重复函数名、变量名或语法含义的注释；

  Comments that repeat function names, variable names, or syntax;
- 与实现不同步的流程描述、临时调试记录和个人备注；

  Process descriptions that are out of sync with implementation, temporary debugging records, and personal notes;
- 声称已经取得牌照、认证或授权的未经验证内容；

  Unverified statements claiming that a license, certification, or authorization has been obtained;
- 在注释中出现 token、密钥、DSN、玩家信息或真实生产地址。

  Tokens, keys, DSNs, player information, or real production addresses in comments.

## 格式与维护 / Formatting and Maintenance

- Go 导出标识符保持 GoDoc 要求，以标识符开头；后续说明使用简洁中文，并紧邻准确英文。

  Exported Go identifiers must satisfy GoDoc requirements by starting with the identifier; subsequent explanation uses concise Chinese followed immediately by accurate English.
- TypeScript 的公共类型、跨模块契约和安全边界使用 `/** ... */`；局部原因使用 `//`。

  Use `/** ... */` for TypeScript public types, cross-module contracts, and security boundaries; use `//` for local rationale.
- 配置、Shell、Dockerfile 与 YAML 注释必须说明默认值、失败行为和秘密信息边界。

  Comments in configuration, Shell, Dockerfile, and YAML files must explain defaults, failure behavior, and secret-information boundaries.
- 修改代码时同步更新相邻注释和契约测试；失效注释按缺陷处理。

  Update adjacent comments and contract tests together with code changes; treat stale comments as defects.
- 错误码、协议字段、指标名和标准术语保留英文原文，避免翻译造成兼容性歧义。

  Preserve error codes, protocol fields, metric names, and standard terminology in their original English to avoid compatibility ambiguity caused by translation.
- Shebang、构建标签、linter 指令及其他机器可读指令按原协议保留，不强行添加自然语言。

  Preserve shebangs, build tags, linter directives, and other machine-readable directives exactly as their protocols require; do not force natural-language text into them.
- `make verify-chinese-comments` 为兼容既有流水线保留旧目标名，但实际执行的是逐语义块中英双语门禁。

  The legacy target name `make verify-chinese-comments` remains for pipeline compatibility, but it enforces bilingual Chinese-English coverage for every semantic comment block.

## 评审检查 / Review Checklist

- 注释是否能解释一项真实约束，而不是复述代码？

  Does the comment explain a real constraint instead of restating the code?
- 是否明确了失败、超时、重试和并发时的行为？

  Does it make behavior under failure, timeout, retry, and concurrency explicit?
- 是否避免泄露敏感数据或作出未经授权的商业声明？

  Does it avoid leaking sensitive data or making unauthorized commercial claims?
- 代码变更后，注释和测试是否仍然一致？

  After the code change, are comments and tests still consistent?
