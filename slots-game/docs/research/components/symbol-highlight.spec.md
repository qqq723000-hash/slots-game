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

- Idle: ADD hidden.
- Normal win: every winning Helmet/Radio/Tank/Jet cell activates authored win + ADD tracks.
- Big Win: the same winning cells remain highlighted; Big Win overlay does not suppress ADD ownership.
- Highlight cleanup occurs only after the result presentation completes.

## Responsive behavior

- PC 1280×720, phone 390×844, tablet 633×844 use the same authored animation.
- NORMAL and ADD world transforms and four corners must be equal after layout and after orientation change.
- Screenshot checkpoints: 0, 100, 200, 500, 750ms; DPR 1 and 2.
