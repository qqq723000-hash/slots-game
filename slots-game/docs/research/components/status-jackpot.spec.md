# StatusAndJackpot Specification

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

## Overview

- Target files: `web/src/ui/DomOverlay.ts`, `web/src/style.css`, `web/src/renderer/JackpotTowerView.ts`
- Interaction model: Jackpot 为时间驱动；状态栏为响应式静态投影。
- Evidence: 外部参考版本三端运行截图、已归档参考 `statusbar.json`、已归档参考 `config_mobile.json`。

## Computed styles

### PC 1280×720

- status layout height: 16px; the texture may paint a 1px dark seam above it without changing layout or hit geometry
- font: `ROBOTO_CONDENSED_REGULAR`, 12.8px, line-height 16px
- provider: 45.3333×13.3333px at x=4px; Balance x=56px; Bet x=165px; Win right=34px
- color: `#cccccc`
- labels and values: 同一文本基线，无人为 flex gap
- jackpot font: `KANIT_BOLD`; title 45px; value 48px; stroke `#22140e` 6px

### Phone reference 390×844

- status font: `ROBOTO_CONDENSED_BOLD`
- size and region: 由 `ResponsiveLayout` 的移动变量投影
- jackpot layout: canonical `pt`

### Tablet reference 633×844

- status font: `ROBOTO_CONDENSED_BOLD`
- size and region: 由 `ResponsiveLayout` 的平板变量投影
- jackpot layout: canonical `iPad_pt`

## States and behavior

- Jackpot collection: 0/200/400/600/800ms 激活 MINI/MINOR/MAJOR/MEGA/GRAND。
- Spine update delta may cap at 64ms; semantic collection delta may not cap.
- Resize/orientation must deterministically select `pt`, `iPad_pt`, or `ls`.
- Compact phone landscape applies `scaleX=1.12` to the canonical `ls` parent only; phone portrait, tablet portrait and tablet landscape remain canonical and isotropic.

## Content

- MINI, MINOR, MAJOR, MEGA, GRAND.
- Balance, Bet, Win with session-bound currency/exponent.
- Maximum int64 display values remain complete: portrait uses three rows and landscape uses three columns rather than ellipsis.

## Responsive behavior

- PC: vertical left rail, no mobile Balance/Bet backplates, and the footer is flush with the physical bottom edge.
- Phone: a continuous mobile composition and compact status region; 390×844 is a regression point, not a fixed canvas.
- Tablet: continuous dimensions with the dedicated `iPad_pt` authored layout in portrait, not a scaled phone screenshot.
