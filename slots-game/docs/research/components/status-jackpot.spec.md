# StatusAndJackpot Specification

## Overview

- Target files: `web/src/ui/DomOverlay.ts`, `web/src/style.css`, `web/src/renderer/JackpotTowerView.ts`
- Interaction model: Jackpot 为时间驱动；状态栏为响应式静态投影。
- Evidence: 原游戏三端运行截图、官方 `statusbar.json`、官方 `config_mobile.json`。

## Computed styles

### PC 1280×720

- status height: 24px
- font: `ROBOTO_CONDENSED_REGULAR`, 14.4px, line-height 24px
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

- PC: vertical left rail and no mobile Balance/Bet backplates.
- Phone: a continuous mobile composition and compact status region; 390×844 is a regression point, not a fixed canvas.
- Tablet: continuous dimensions with the dedicated `iPad_pt` authored layout in portrait, not a scaled phone screenshot.
