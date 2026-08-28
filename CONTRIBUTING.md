# 贡献入口

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

完整的工程不变量、修改流程与提交前验证见
[项目贡献指南](slots-game/CONTRIBUTING.md)。

公开 Issue 和 Pull Request 中不得提交秘密或凭据、玩家或账户数据、生产日志，或漏洞细节与复现
步骤。普通缺陷请使用脱敏的合成数据和最小复现；漏洞细节应先等待维护方确认受控披露渠道。本仓库
不在此入口虚构私密联系方式、LICENSE、DCO 或 CLA 要求。

正式版本变更还必须同步 `slots-game/VERSION`、`slots-game/CHANGELOG.md`、Web package/lock、
Helm Chart 与 README 发布示例，并在创建受保护 Tag 前通过供应链版本门禁。GitHub Action 必须固定
完整提交 SHA；新增权限、Dependabot 范围、CodeQL 或依赖审查策略均按供应链变更评审。
