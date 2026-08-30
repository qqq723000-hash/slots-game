# 安全漏洞报告 / Security vulnerability reporting

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。
>
> **Independent-project notice:** The engineering implementation and delivery documentation in this repository are maintained by an independent developer and are built toward a commercial-grade source-delivery standard. Production, operations, platform, security, audit, legal, compliance, and approval roles described here remain responsibilities that an adopter must establish in its external environment. Repository content does not mean that the system is live or that any service level, commercial licence, asset licence, or regulatory certification has been granted. Third-party components and assets remain subject to their respective licences and rights boundaries.

仅 `main` 分支当前版本接受安全修复。请通过本仓库的 [**Security → Report a vulnerability**](https://github.com/qqq723000-hash/slots-game/security/advisories/new) 私密提交报告，不要在公开 Issue、讨论或提交信息中披露漏洞细节、访问令牌、私钥、数据库连接串、玩家信息或生产日志。

Only the current version on the `main` branch receives security fixes. Submit reports privately through this repository's [**Security → Report a vulnerability**](https://github.com/qqq723000-hash/slots-game/security/advisories/new) workflow. Do not disclose vulnerability details, access tokens, private keys, database connection strings, player information, or production logs in public issues, discussions, or commit messages.

报告应尽量包含受影响提交、影响范围、最小复现步骤、预期与实际行为，以及不会暴露真实凭据的验证材料。维护者确认修复并完成回归门禁前，请勿公开利用方式。

Where possible, include the affected commit, impact scope, minimal reproduction steps, expected and actual behaviour, and verification material that exposes no real credentials. Do not publish exploitation details until the maintainer has confirmed the fix and completed the regression gates.

发现疑似凭据泄漏时，应先轮换凭据并撤销旧材料，再处理代码；不得仅依赖删除 Git 文件或重写可见分支来宣称泄漏已消除。

If credential exposure is suspected, rotate the credential and revoke the old material before addressing the code. Deleting a Git file or rewriting visible branches alone must never be treated as proof that the exposure has been eliminated.

## 安全测试边界 / Security testing boundaries

未经系统所有者书面授权，不得对生产、预发布、第三方钱包、运营商或云边缘端点执行压力、穿透、流量放大或 DDoS 模拟。仓库内的滥用 profile 只用于隔离环境中的应用层容量回归；真实 AWS DDoS 模拟还必须满足云服务商政策、测试范围、流量上限、来源和应急联系人要求。测试发现的问题仍通过上述私密渠道报告，公开 Issue 只用于不包含漏洞细节的修复跟踪。

Without written authorisation from the system owner, do not perform stress, penetration, traffic-amplification, or DDoS simulations against production, staging, third-party wallets, operators, or cloud-edge endpoints. Abuse profiles in this repository are only for application-layer capacity regression in an isolated environment. A real AWS DDoS simulation must also satisfy the cloud provider's policies and requirements for test scope, traffic limits, sources, and emergency contacts. Report findings through the private channel above. Public issues may only track remediation without vulnerability details.

普通支持范围、生产 SLA 与第三方系统边界见[支持与响应边界](SUPPORT.md)。

See [support and response boundaries](SUPPORT.md) for ordinary support scope, production SLA boundaries, and third-party system boundaries.
