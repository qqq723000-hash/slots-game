# 浏览器支持与验收矩阵

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

本项目面向满足下列能力基线的主流现代浏览器，不使用无法验证的“所有历史浏览器”表述。
JavaScript 与 CSS 的**编译兼容目标**在 `web/vite.config.ts` 中显式固定，升级 Vite 不得静默抬高目标版本；
该目标只约束产物语法和 CSS 转换，不等于仓库 CI 已在每个历史最低版本上运行。

| 平台 | 编译兼容目标 | 仓库 CI 的实际运行证据 | 采用方发布验收边界 |
| --- | ---: | --- | --- |
| Google Chrome 桌面 | 111 | CI runner 当前 Chrome 的深度事务门禁 + 当前 Playwright Chromium | 若承诺最低版或上一稳定版，需在对应真实版本补测 |
| Microsoft Edge 桌面 | 111 | Windows runner 当前 Edge channel 事务门禁 | 若承诺最低版或上一稳定版，需在对应真实版本补测 |
| Mozilla Firefox 桌面 | 114 | 当前锁定 Playwright 包随附的 Firefox 引擎事务门禁 | 若承诺最低版或上一稳定版，需在对应真实版本补测 |
| Apple Safari（macOS） | 16.4 | 当前锁定 Playwright 包随附的 WebKit 回归 | 在真实 macOS Safari、目标最低版和上一主版本补测 |
| iOS/iPadOS Safari | 16.4 | WebKit 的 390×844 移动布局回归 | 在真实 iPhone/iPad、目标最低版和上一主版本补测 |
| Android Chrome | 111 | 当前 Chromium 的 390×844 移动布局回归 | 在目标 Android 设备、最低版和上一稳定版补测 |

## 必要运行能力

浏览器必须启用 ES Module、原生 `BigInt`、Web Crypto、Fetch、AbortController、Web Audio、
容器查询与容器单位，并提供至少 4096 像素纹理上限的 WebGL。生产入口由无模块依赖的经典 preflight
先清除一次性启动片段并执行能力检查，随后才允许模块入口动态加载主应用；不满足时只显示固定升级提示，
不继续交换会话或进入投注状态。不支持 ES Module 的浏览器仍能运行经典 preflight 并看到固定提示，
但不会运行主应用。

运行资源包括 AVIF 图像与 M4A/AAC 音频。跨引擎门禁必须用真实发布资源完成解码、WebGL 装配、
会话交换、旋转、结算结果、ACK、390×844 移动底边和说明页最下方边缘检查；只检查用户代理字符串
或 API 是否存在不能判定兼容通过。

## 自动化入口

```sh
cd web
npm ci
npx playwright install firefox webkit

VITE_RGS_BASE_URL=https://rgs.ci.invalid \
VITE_RGS_BET_OPTIONS_MINOR=100,200,500 \
VITE_RGS_DEFAULT_BET_MINOR=200 \
VITE_RGS_HOST_ORIGIN=https://operator.ci.invalid \
  npm run build

VITE_RGS_BASE_URL=https://rgs.ci.invalid \
VITE_RGS_BET_OPTIONS_MINOR=100,200,500 \
VITE_RGS_DEFAULT_BET_MINOR=200 \
VITE_RGS_HOST_ORIGIN=https://operator.ci.invalid \
  npm run build:browser-matrix
```

现有 `npm run build:browser-smoke` 继续承担 Chrome 下更深的 CSP、Trusted Types、连续视口、
同文档移动/桌面迁移、完整表现状态与精确一次事务检查；跨浏览器门禁不能替代它。

## 真实设备与外部边界

Playwright 的 Chromium、Firefox 与 WebKit 均是当前锁定工具链的引擎回归，不等于历史最低版本、
上一稳定版、某一具体 Safari 发行版或设备 GPU 已经通过。正式采用方每次浏览器主版本升级及发布前，
仍须在承诺范围内的真实 Chrome、Edge、Firefox、macOS Safari、iPhone/iPad Safari、Android Chrome
和目标嵌入式入口中复验资源解码、声音手势解锁、方向切换、安全区、跨站策略与完整玩法。测试记录必须
绑定提交 SHA、浏览器/系统版本、设备型号、时间和结果；没有该证据时只能声明编译目标与当前 CI 引擎通过。

IE、已停止安全维护的浏览器、禁用 JavaScript/WebGL/Web Crypto 的环境以及低于上述能力基线的
WebView 不在支持范围。将资金和修订序号从 `BigInt` 降为浮点数、移除 Web Crypto 或绕过 WebGL
能力检查会破坏精度、安全或表现契约，因此不是可接受的兼容方案。
