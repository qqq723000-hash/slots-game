# 视口等比留黑边规范 / Viewport Letterbox Specification

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

## 中文摘要 / Chinese summary

本规范定义桌面端对称裁剪与移动端等比包含的连续视口投影，超出作者画布的区域必须为黑色且不可交互。渲染器、DOM 覆盖层、命中区和帮助界面必须共用同一坐标系和统一缩放因子，单纯调整视口不得触发状态、下注、演示或素材重载。仓库测试覆盖常见参考尺寸和方向往返，但真实浏览器安全区、设备像素比变化与目标终端验收仍需交付环境证据。

## English summary / 英文摘要

This specification defines continuous viewport projection with symmetric desktop cropping and isotropic mobile containment, while every region outside the authored surface stays black and non-interactive. The renderer, DOM overlay, hit areas, and help surface must share one coordinate system and one uniform scale, and resize alone must not reload state, wagers, presentation, or assets. Repository tests cover reference sizes and orientation round trips, while real-browser safe areas, device-pixel-ratio changes, and target-device acceptance still require delivery-environment evidence.

## Overview

- Target files: `web/src/renderer/ResponsiveLayout.ts`, `web/src/style.css`, application shell and browser contracts.
- Interaction model: resize-driven; the game surface never stretches independently on either axis.
- Outer viewport: fills the browser and paints solid black outside the authored surface.

## Design surfaces

- PC: 1280×720 (`16:9`).
- Mobile/tablet: the logical long edge is 844 and the design aspect follows the current physical viewport continuously, clamped only to the supported safety envelope 9:22–22:9.
- 390×844, 844×390, 633×844 and 844×633 are reference checkpoints, not supported-size allowlists.
- The resource channel is frozen for the session. The layout channel may switch on resize/device emulation without reloading or replacing the active resource family.

For a mobile viewport with `aspect = clamp(viewportWidth / viewportHeight, 9/22, 22/9)`:

```text
portrait:  designWidth = 844 * aspect; designHeight = 844
landscape: designWidth = 844;          designHeight = 844 / aspect
```

## Scale and centering contract

PC preserves the captured 1200×900 authored composition inside the 1280×720 renderer:

```text
authoredHeight = min(viewportHeight, viewportWidth * 900 / 1200)
scale = authoredHeight / 720
left = (viewportWidth - 1280 * scale) / 2
top = (viewportHeight - authoredHeight) / 2
visibleInsetX = max(0, -left / scale)
```

This makes common 16:9 and 16:10 PC surfaces touch the physical bottom edge. Narrower desktop
surfaces crop only the renderer wings symmetrically; HUD, menus and feature controls consume
`visibleInsetX` and stay inside the visible region.

For mobile viewport `(viewportWidth, viewportHeight)` and its resolved continuous design surface:

```text
scale = min(viewportWidth / designWidth, viewportHeight / designHeight)
left = (viewportWidth - designWidth * scale) / 2
top = (viewportHeight - designHeight * scale) / 2
```

- Every frame keeps the resolved design CSS width/height and receives one isotropic `scale(...)` from `top left`.
- `scaleX`, `scaleY`, flexible renderer dimensions and independent renderer stretching are forbidden.
- PC uses only the captured symmetric authored crop. Mobile uses contain; any pillarbox/letterbox regions are black, clipped and non-interactive.
- Canvas, DOM overlay, hit areas and help overlay remain in the same resolved coordinate system.

## Resize lifecycle

- Apply synchronously once at startup.
- Observe the outer viewport and listen to `window.resize`; when available, also listen to `visualViewport.resize`.
- Coalesce duplicate notifications to one animation frame and invalidate queued work on teardown.
- Each committed resize recomputes the continuous design domain, content profile, uniform scale and offsets atomically before notifying Pixi/UI consumers.
- No state, wager, presentation or asset reload may be triggered by resize alone.

## Rendering and input

- Pixi renderer dimensions equal the resolved design surface, not an independently stretched physical viewport.
- CSS scaling supplies the physical display size; Pixi pointer normalization uses the transformed canvas bounding rectangle.
- Device pixel ratio may change backing resolution policy, but may not change logical geometry.
- Safe-area and browser chrome reduce the available outer viewport; they do not distort the authored surface.

## Responsive profile selection

- `surfaceProfile` labels still distinguish phone/tablet reference coverage, but never choose the design dimensions.
- Captured content layouts remain `pt`, `iPad_pt` and `ls`; they select authored minBounds within the continuous gameplay region.
- Explicit `?layout=desktop|mobile` wins. Explicit `?channel=desktop` also keeps desktop layout on touch-capable PCs. Otherwise coarse/compact touch input selects mobile, fine-pointer desktop devices remain desktop, and small phone geometry is the final fallback.

## Failure-closed tests

- Test continuous phone/tablet portrait and landscape sizes, foldable-like ratios, extreme clamped ratios, and PC→mobile→tablet→PC changes in one document.
- Assert `renderedWidth / renderedHeight == designWidth / designHeight` within floating-point tolerance.
- Assert both scale axes are identical. Normal mobile ratios should fit; clamped extreme ratios must show non-interactive black bars. PC 1440×900 must resolve to `(-80, 0, 1600, 900)` with `visibleInsetX=64` and no bottom bar.
- Run repeated device switches and orientation changes; the final geometry must depend only on the final viewport.
- Verify frame hit testing excludes black bars and maps the physically visible PC edges through `visibleInsetX` back to canonical coordinates.
