# SymbolHighlight Specification

## Overview

- Target files: `web/src/app/AppController.ts`, reel highlight tests and visual fixture coverage.
- Interaction model: result-driven animation.
- Assets: existing Spine symbols and ADD layers for Helmet/PULSE, Radio/NOVA, Tank/TANK, Jet/CIRCUIT.

## DOM/scene structure

- ReelSet owns NORMAL symbol containers and a sibling ADD layer.
- Each winning symbol mirrors its NORMAL transform into the corresponding ADD instance every frame.
- Renderer places the ADD layer above the normal reels without changing symbol source assets.

## States and behavior

- Idle: Helmet/Radio/Tank/Jet run their authored NORMAL idle and matching ADD idle together. The ADD layer is the official glow/highlight; do not replace it with an approximate CSS brightness/drop-shadow filter.
- Normal win: every winning Helmet/Radio/Tank/Jet cell activates authored win + ADD tracks.
- Big Win: the same winning cells remain highlighted; Big Win overlay does not suppress ADD ownership.
- Highlight cleanup occurs only after the result presentation completes.

## Responsive behavior

- PC 1280×720 plus the phone/tablet reference sizes use the same authored animation; the same matrix invariant is required at every continuous intermediate size.
- NORMAL and ADD world transforms and four corners must be equal after layout and after orientation change.
- Screenshot checkpoints: idle plus 0, 100, 200, 500, 750ms win presentation; DPR 1 and 2.
- Idle tests must cover all four low symbols, not only Wild, and must prove NORMAL/ADD world matrices, visibility and track ownership remain paired across PC, phone and tablet layouts.
