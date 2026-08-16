# Iron Colossus 前端

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
WEB_RELEASE_VERSION=1.0.0 \
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

- `public/assets/primal-runtime/runtime-manifest.json` 绑定每个运行资源的字节长度和 SHA-256；
- streaming package manifest 必须可离线重现，并覆盖每个权威 URL 一次；
- 子路径部署必须用实际公开前缀构建，服务器不得把缺失资源重写成 `index.html`；
- 前端容器只包含最终白名单资产、Nginx 配置与健康检查，不包含源码、测试、文档或凭据；
- 动画、音频、快速停止和减少动效只能改变表现时间，不能改变服务端事件顺序或经济结果。

正式容器由仓库根目录的 `make build-web-release-image` 构建，并要求仓库外发布资源审批文件。
