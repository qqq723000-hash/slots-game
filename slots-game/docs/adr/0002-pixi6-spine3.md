# ADR-0002：PixiJS 6.5.2 与 pixi-spine 3.x 渲染栈 / PixiJS 6.5.2 and pixi-spine 3.x rendering stack

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

## English summary / 英文摘要

This ADR records the accepted M1 compatibility baseline for the PixiJS 6.5.2 and pixi-spine 3.x presentation stack.
Rendering and skeletal-animation adapters own visual lifecycle concerns, while game mathematics, result authority, networking, idempotency, and accounting remain outside the renderer and cannot change with frame rate or fallback mode.
Any upgrade or commercial release still requires visual, performance, asset-loading, browser, dependency-license, and per-asset rights review; this ADR is not evidence of asset ownership or distribution approval.

- 状态：已接受作为 M1 兼容基线
- 日期：2026-07-25

## 背景

浏览器表现层引擎需要成熟的 2D 场景图、高效 WebGL 批处理、精灵/图集支持、遮罩、滤镜、交互与
骨骼动画。项目特别瞄准经过验证的 PixiJS 6 代与对应的 pixi-spine 3 代，同时把引擎适配代码、
游戏业务代码与素材来源拆成可独立审计的边界；本 ADR 不证明任何具体素材的原创性或授权状态。

PixiJS 与 Spine 运行时解决渲染与骨骼播放。它们不提供老虎机数学、转轴语义、特性状态机、网
络、幂等性或记账；这些仍是项目拥有的层。

## 决策

M1 使用：

- `pixi.js` 6.5.2 作为 2D 场景图与主 WebGL 渲染器；
- 项目拥有的适配器后的兼容 `pixi-spine` 3.x 发行版；
- 运行时/导出版本显式锁定并校验的 Spine 导出；
- 来自项目资产管线、且必须通过权属分类与逐文件发布审批的图集、位图和矢量内容；
- 独立于渲染器分辨率与设备 DPR 的逻辑布局坐标。

渲染器适配器拥有 Pixi 应用创建、缩放策略、图层构建、遮罩、上下文丢失处理与拆卸。Spine 适配
器拥有骨骼构建、动画名、皮肤、混合、池化与安全兜底行为。游戏与特性表现器依赖这些适配器，而
非在整个代码库中导入渲染器全局。

WebGL 是正常渲染后端。在所选 Pixi/特性特效支持时，可为降级表现配置提供 Canvas 兜底；兜底不
允许改变服务端结果或记账投影。

版本号锁定在包 lockfile 中。更新 PixiJS、pixi-spine 或 Spine 导出版本需要视觉回归、性能、
资产加载与重连/拆卸测试。

## 许可与净室约束

正式商业发布的目标约束是：游戏专属代码、名称、场景、纹理、骨骼、动画、音频与字体必须由
权利主体证明为原创或取得覆盖目标地域和用途的授权；不得把第三方商业 bundle、反编译产物或
来源不明资产当作项目自有内容。当前仓库中部分运行素材只有完整性清单，缺少仓库内可审计权属
材料，其状态和失败关闭处理以 [`../../web/ASSETS.md`](../../web/ASSETS.md) 及机器可读素材清单为准。
因此本 ADR 不能被引用为“全部原创”或“已经取得商业分发授权”的证据。

PixiJS 包许可与每个传递依赖都在发布清单中检查。Spine 运行时与导出的 Spine 数据受 Spine
Runtime License 及相关编辑器许可条件约束；不能假设"源代码可见"等于不受限制的使用。仅在项目
确认并记录所需许可后，发布才可附带 Spine 内容。若该条件不满足，适配器必须可被原创精灵图动
画路径替换。

## 后果

### 正面

- 该栈很适合批量 2D 符号、遮罩、特效与骨骼角色动画。
- 适配器边界使老虎机引擎独立于渲染器全局。
- 锁定版本使资产/运行时兼容性与视觉基线可复现。
- 服务端权威事实保持独立于渲染后端或帧率。

### 成本与风险

- PixiJS 6 与 pixi-spine 3 是遗留主代，维护/迁移成本日益增长。
- Spine 导出/运行时不匹配通常在资产加载或动画时失败；需要 CI 校验。
- WebGL 上下文丢失、GPU 内存限制、低端设备与浏览器音频策略需要显式降级行为。
- Spine 许可需要发布时法务/许可检查。
- 支持 Canvas 兜底约束滤镜、遮罩与特效，且可能并非对每个特性都可行。

## 被拒绝的替代方案

### 用 Go/WASM 渲染生产游戏

被拒绝，因为对 DOM 托管的 2D 客户端收益甚微，使与 Pixi/Spine 的集成笨拙，且不改变服务端权威
需求。

### 自建 WebGL 渲染器

被拒绝，因为渲染器构建、批处理、文字、交互、资源生命周期与跨浏览器兼容性会主导 M1，却无益
于老虎机引擎正确性。

### 游戏代码直接耦合 Pixi 类

被拒绝，因为它把生命周期与版本假设扩散到每个特性，使测试、渲染器升级与减少动效表现更困难。
