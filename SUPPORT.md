# 支持与响应边界 / Support and response boundaries

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。
>
> **Independent-project notice:** The engineering implementation and delivery documentation in this repository are maintained by an independent developer and are built toward a commercial-grade source-delivery standard. Production, operations, platform, security, audit, legal, compliance, and approval roles described here remain responsibilities that an adopter must establish in its external environment. Repository content does not mean that the system is live or that any service level, commercial licence, asset licence, or regulatory certification has been granted. Third-party components and assets remain subject to their respective licences and rights boundaries.

## 普通问题 / Ordinary issues

普通缺陷、文档问题和改进建议请使用仓库的 Issue 表单，并只提供脱敏的合成数据、最小复现、受影响提交和本地验证结果。不得在 Issue、讨论、Pull Request、截图或附件中提交密码、令牌、私钥、DSN、玩家/账户信息、生产日志、发布审批、原始抓包或未公开漏洞细节。

Use the repository issue forms for ordinary defects, documentation issues, and improvement proposals, and provide only sanitised synthetic data, a minimal reproduction, the affected commit, and local verification results. Do not submit passwords, tokens, private keys, DSNs, player or account information, production logs, release approvals, raw packet captures, or undisclosed vulnerability details in issues, discussions, pull requests, screenshots, or attachments.

仓库维护者会按可用维护能力分类和处理请求，但本公开入口不承诺响应时间、修复时间、7×24 值守、生产事故处置、SLA、SLO 或赔偿责任。真实生产支持、值班、升级路径和应急联系人必须由部署运营方通过独立合同与运行手册确认，不能从源码仓库推定。

The repository maintainer triages and handles requests according to available maintenance capacity. This public entry point promises no response time, remediation time, 24×7 coverage, production-incident response, SLA, SLO, or liability for compensation. The deploying operator must define real production support, on-call coverage, escalation paths, and emergency contacts through separate contracts and runbooks; none may be inferred from this source repository.

## 安全问题 / Security issues

安全漏洞只通过 GitHub 的 [Security → Report a vulnerability](https://github.com/qqq723000-hash/slots-game/security/advisories/new) 私密报告。不要创建公开 Issue，也不要先公开利用方式。疑似凭据泄漏应由拥有该凭据的运营方先执行轮换和撤销，再按事件响应流程保存证据；删除 Git 文件不能撤销已经暴露的秘密。

Report security vulnerabilities privately and only through GitHub's [Security → Report a vulnerability](https://github.com/qqq723000-hash/slots-game/security/advisories/new) workflow. Do not create a public issue or publish exploitation details first. When credential exposure is suspected, the operator that owns the credential must rotate and revoke it first, then preserve evidence under its incident-response process. Deleting a Git file cannot revoke an already exposed secret.

## 生产与第三方系统 / Production and third-party systems

未经系统所有者书面授权，不得把本仓库的测试脚本用于生产、预发布、第三方钱包、运营商或云边缘端点。AWS 账号、钱包、素材权利、监管认证、告警接收、灾难恢复和生产容量均属于仓库外门禁；仓库检查通过不代表这些系统已经部署、获批或受本支持入口保障。

Without written authorisation from the system owner, do not run this repository's test scripts against production, staging, third-party wallets, operators, or cloud-edge endpoints. AWS accounts, wallets, asset rights, regulatory certification, alert reception, disaster recovery, and production capacity are all external gates. Passing repository checks does not mean that these systems are deployed, approved, or covered by this support entry point.
