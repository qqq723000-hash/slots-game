# 每运营商 access-token 密钥

状态：生产安全契约
最后更新：2026-07-26

## 不变式

生产仅接受严格 `rgs-operators-v2` 信任文档。每个运营商有一个活跃 Ed25519 `ACCESS_TOKEN` 签名
密钥，带独立密钥材料。密钥 ID 在整个 `ACCESS_TOKEN` 用途范围唯一，加载器拒绝 v2 文档中任何位
置的相同 access-token 公开材料，包括在不同 ID 或租户下复用。

token 验证器先解析认证 token header `kid`，再校验签名，然后要求签名 `operator_id` claim 与请
求期望运营商都等于绑定到该密钥的运营商。它绝不仅从未校验租户 claim 选择密钥。

## V2 配置

每个运营商条目含：

- `accessTokenSigningKey`：用于新 token 的唯一密钥。它有 `keyId`、`notBefore`、`notAfter`、
  `privateKeyFile` 与匹配 `publicKeyFile`；
- `accessTokenVerificationKeys`：零或多个旧或预发布公钥，各有自己的 `keyId`、有效窗口与
  `publicKeyFile`。

所有路径相对运营商文档除非绝对。文件适配器要求单个 Ed25519 PKCS8 私有 PEM 与匹配 PKIX 公开
PEM。它拒绝可执行、组可写与所有 world 可访问私钥文件。每个运营商挂载独立只读密钥对象；不要
把私钥放进数据库、容器镜像、运营商文档、日志或审计 payload。生产应在适配器可用时用评审过的
KMS/HSM 签名器替换可导出文件。当前运行时把活跃文件支持私钥加载进进程内存，不主张 HSM 隔
离。

`rgs-operators-v1` 仅在提供两个废弃全局环境变量时作为迁移兼容路径可读。生产服务端传失败即拒
绝加载器选项并拒绝 v1。新部署绝不能设 `RGS_ACCESS_PRIVATE_KEY_FILE` 或
`RGS_ACCESS_PUBLIC_KEY_FILE`。

## 计划轮换

配置在一个进程生命周期内不可变，因此轮换是受控滚动部署：

1. 在获批密钥边界生成新独立密钥。分配不复用的密钥 ID 与足够滚动与最大配置 access-token 寿
   命的有效窗口。
2. 旧密钥保持 `accessTokenSigningKey` 时，把新公钥加到
   `accessTokenVerificationKeys`。把该验证优先配置滚到每个副本并校验就绪/收敛。
3. 把 `accessTokenSigningKey` 改为新密钥。把旧公钥移入
   `accessTokenVerificationKeys`；移除新公钥的重复列表条目。把该签名切换滚到每个副本。混合
   滚动期间，所有副本可校验两个密钥 ID。
4. 记录最后一个旧签名副本停止签发的时间。等待至少 `RGS_ACCESS_TOKEN_TTL` 加配置 30 秒验证器
   时钟偏差。确认无有效旧 token 可留存且 refresh/错误监控正常。
5. 移除旧验证密钥并按获批保留与事件策略销毁或撤销其私钥。保留非密钥轮换证据：运营商、密钥
   ID、滚动时间、审批与验证。

就绪拒绝尚未有效或无法覆盖新鲜 token 全 TTL 的活跃签名密钥。token 校验还强制每个密钥声明的
窗口、签发者、受众、最大寿命、签名与租户绑定。

## 泄露轮换

若活跃私钥可能泄露，为该运营商停止签发，移除/撤销密钥，按事件与监管 runbook 要求阻塞受影响
会话，并部署独立生成替换密钥。不要仅为可用性保留重叠：在公钥被信任时，泄露密钥签发的 token
仍可伪造。运营商、安全团队、监管/测试实验室与事件 owner 决定通知、token/会话撤销、证据保留
与恢复服务审批。
