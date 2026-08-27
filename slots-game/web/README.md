# Primal Rampage 前端

前端是只读的权威结果表现层，使用 TypeScript、PixiJS 6.5.2 和 Spine 4.1。它不选择符号、计算
输赢、修改余额或推进可赔付特性状态。正式入口只创建 `RgsGateway`，不存在 WebSocket 开发回退。

## 开发校验

需要 Node.js 22.22.0：

```sh
npm ci
npm run typecheck
npm test -- --run --fileParallelism=false
npm run assets:check-streaming-packages
npm run build
npm run build:determinism-check
npm run build:assets-check
npm run build:bundle-check
```

`npm run build` 先执行类型检查和 Vite 构建，再将 `dist/` 裁剪到生产白名单，生成含公开
版本、完整提交摘要、逐文件字节数/SHA-256 及可复算 `releaseId` 的清单，最后拒绝未审查的
JavaScript bundle。确定性门禁会用相同输入复建并逐字节比较清单。

## RGS 配置

生产构建必须提供全部公开配置：

```sh
VITE_RGS_BASE_URL=https://rgs.example \
VITE_RGS_BET_OPTIONS_MINOR=10,20,50,100,200 \
VITE_RGS_DEFAULT_BET_MINOR=100 \
VITE_RGS_HOST_ORIGIN=https://operator.example \
WEB_RELEASE_REQUIRE_IDENTITY=1 \
WEB_RELEASE_VERSION=1.2.1 \
WEB_RELEASE_REVISION=0123456789abcdef0123456789abcdef01234567 \
  npm run build
```

运营商通过 URL fragment 交接一次性值：

```text
#rgsLaunchCode=...&rgsOperatorId=...&rgsSessionId=...
```

应用在任何后续校验前用 `history.replaceState` 清除这些字段。配置、交接值或可写恢复存储任一
缺失时，应用在交换会话和启用投注前失败关闭。Bearer token 与启动码只驻留内存；
`sessionStorage` 只保存不含秘密的待处理轮次指纹。

嵌入 iframe 时，`VITE_RGS_HOST_ORIGIN` 只接受精确、无凭据的 HTTPS origin。父页面收到新会话
请求后，必须同时验证 `event.origin`、`event.source`、消息 `type/version`，再由运营商后端签发
新会话；禁止刷新或重放旧启动码。

## 资源与运行边界

- 静态资源目录职责、权属状态与外部审批要求见 [`ASSETS.md`](./ASSETS.md)；
- `public/assets/primal-runtime/runtime-manifest.json` 绑定每个运行资源的字节长度和 SHA-256；
- streaming package manifest 必须可离线重现，并覆盖每个权威 URL 一次；
- 子路径部署必须用实际公开前缀构建，服务器不得把缺失资源重写成 `index.html`；
- 前端容器只包含最终白名单资产、Nginx 配置与健康检查，不包含源码、测试、文档或凭据；
- 动画、音频、快速停止和减少动效只能改变表现时间，不能改变服务端事件顺序或经济结果。

正式容器由仓库根目录的 `make build-web-release-image` 构建，并要求仓库外发布资源审批文件。

## GitHub Pages 静态试玩

静态试玩是与正式 RGS 入口分离的独立构建，不读取启动码、钱包、RGS、真实 token 或恢复账本，
也不会在配置失败时从正式入口降级到 Mock。它只循环专用公开网关内冻结的表现序列，
使用 ISO 4217 测试代码 `XTS`，并在所有尺寸持续展示“DEMO / 无真钱 / 无钱包 / 无经济价值”。
试玩不接入项目分析或个人数据提交端口；声音、自动播放停止条件与功能预览选择只作为本机
非身份偏好保存。托管平台自身的基础访问日志由其条款与隐私政策控制，不属于项目后端。

```sh
npm run build:demo
npm run demo:verify
npm run demo:preview
```

可上传目录是 `dist-demo/`，公开基础路径固定为 `/slots-game/`，对应项目 Pages 地址。产物自带
`.nojekyll`、完整输出树哈希清单、非经济模式清单和子路径/RGS 负向校验；Meta CSP
的 `connect-src` 仅允许同源静态资源。专用公开网关只包含 23 轮固定结果，覆盖普通赢额、
Rage、Primal Wheel、Kong Quest、King Spin 与 Vault 表现；这些结果不代表真实概率或 RTP。Rollup
模块图会拒绝 `src/testing/`、正式 `RgsGateway` 和启动入口。`npm run build` 仍只生成
`dist/` 正式 RGS 客户端，两个入口没有运行时模式开关。

Pages 发布只能手动从受保护 `main` 启动。`pages-demo-asset-approval` Environment
必须提供 `STATIC_DEMO_ASSET_APPROVAL_B64`：它是与正式 Web 发布相同的规范精确哈希
审批 JSON 的 Base64 编码，含审批引用、辖区、有效期及每个受保护文件的字节数/SHA-256。
其中 `jurisdictions` 必须显式包含 `PUBLIC-INTERNET`，局部地区授权不能发布到全球可访问的 Pages。
工作流只记录审批文件哈希，不上传审批原文；校验通过后还要经独立
`github-pages` Environment 复核才部署。

重要：仓库内 `assets/primal-runtime/` 与 `assets/primal-reference/` 的权利链证据不足，详见
[`ASSETS.md`](./ASSETS.md) 和 `asset-provenance.json`。GitHub Pages Environment 的人工批准只能
授权“本次精确制品是否部署”，不补足素材权属，也不等于可商用许可。对外发布前仍需仓库外的
逐文件 SHA-256 授权证据；未取得时只能本地构建和审查，不能把 Pages 链接宣传为商用试玩。

GitHub Pages 的仓库实现不需要购买域名或常驻服务器，但“0 成本”仅指公共仓库在 GitHub Free
正常低流量与平台配额内运行。Actions 两次 LFS checkout、Pages 带宽与 Git LFS 流量仍受平台限制；
仓库所有者应把 Git LFS 付费预算设为 0，使超额时停止而不是产生费用，并监控 Actions/Pages 用量。
这不是无条件、无限流量或永久免费的承诺。

## 加载页与品牌边界

启动页的蓝色径向背景、进度条几何、断点和过渡时序按已冻结的 ContainerLauncher 证据实现；
底部供应商图形则有意使用项目批准的 G'm GO 素材。后者不是遗漏的视觉还原项，未经可审计授权不得
为了像素一致而换回 Play'n GO 商标或图形。

随包 `THIRD_PARTY_NOTICES.txt` 包含浏览器生产依赖及构建器写入代码的许可原文，其中 Spine
运行库受 Spine Runtimes License Agreement 约束。随包声明满足代码制品的告知边界，但不替代
发布主体对适用 Spine Editor 许可条件的法律确认。
