# 符号高亮规范 / SymbolHighlight Specification

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

## 中文摘要 / Chinese summary

本规范定义转轴符号的普通层与附加高亮层如何在待机、普通中奖和巨额奖励演示中保持成对。两层必须在每帧共享相同的世界变换、可见性和轨道所有权，不得用近似的 CSS 亮度或阴影效果替代作者素材。此文档只覆盖视觉运行时与回归合同，结算数学、RGS 经济权威与素材权利批准仍由各自的服务端、交付和外部门禁承担。

## English summary / 英文摘要

This specification defines how each reel symbol's NORMAL layer and authored ADD highlight layer remain paired during idle, ordinary wins, and Big Win presentation. Both layers must preserve identical world transforms, visibility, and animation-track ownership on every frame, and approximate CSS brightness or shadow effects are not valid replacements. The document covers visual runtime and regression behavior only; settlement mathematics, RGS economic authority, and asset-rights approval remain governed by their separate server, delivery, and external gates.

## Overview

- Target files: `web/src/app/AppController.ts`, reel highlight tests and visual fixture coverage.
- Interaction model: result-driven animation.
- Assets: existing Spine symbols and ADD layers for Helmet/PULSE, Radio/NOVA, Tank/TANK, Jet/CIRCUIT.

## DOM/scene structure

- ReelSet owns NORMAL symbol containers and a sibling ADD layer.
- Each winning symbol mirrors its NORMAL transform into the corresponding ADD instance every frame.
- Renderer places the ADD layer above the normal reels without changing symbol source assets.

## States and behavior

- Idle: Helmet/Radio/Tank/Jet run their authored NORMAL idle and matching ADD idle together. The ADD layer is the captured glow/highlight; do not replace it with an approximate CSS brightness/drop-shadow filter.
- Normal win: every winning Helmet/Radio/Tank/Jet cell activates authored win + ADD tracks.
- Big Win: the same winning cells remain highlighted; Big Win overlay does not suppress ADD ownership.
- Highlight cleanup occurs only after the result presentation completes.

## Responsive behavior

- PC 1280×720 plus the phone/tablet reference sizes use the same authored animation; the same matrix invariant is required at every continuous intermediate size.
- NORMAL and ADD world transforms and four corners must be equal after layout and after orientation change.
- Screenshot checkpoints: idle plus 0, 100, 200, 500, 750ms win presentation; DPR 1 and 2.
- Idle tests must cover all four low symbols, not only Wild, and must prove NORMAL/ADD world matrices, visibility and track ownership remain paired across PC, phone and tablet layouts.
