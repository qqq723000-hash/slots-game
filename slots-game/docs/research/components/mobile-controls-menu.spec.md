# Mobile Controls and Menu Specification

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

## Evidence boundary

- Geometry comes from captured Primal Rampage reference-build images at the listed viewports, compared against the same local viewport after the responsive root has committed.
- Captured third-party branding is excluded from the release. The release uses project-approved local provider assets.
- Player-facing regulatory or unfinished-game copy may only come from an operator-approved bundle. Internal RGS, hash, allow-list and presentation-binding diagnostics are not player rules.

## Control geometry

- Visual artwork and pointer target are separate contracts: reference-sized artwork may be below 44 physical pixels, while the transparent pointer target remains at least 44×44 physical pixels.
- Phone portrait 390×844: Spin is 85.91px at approximately (152.05, 595.41); utility artwork is approximately 39.37px with its row around y=705.23 and a 50.87px centre cadence.
- Tablet portrait 633×844: Spin is 79.59px at approximately (276.71, 598.57); utility artwork is approximately 39.37px with its row around y=705.23. Portrait sizing interpolates continuously between the phone and tablet evidence instead of applying either endpoint to every viewport.
- Tablet landscape 844×633: Spin is 85.91px at approximately (742.30, 261.46); utility artwork is approximately 44.31px beginning around x=20.88.
- Compact landscape 844×390: Spin is 85.91px around y=145.75. The utility rail keeps the captured approximately 56.72px cadence rather than compressing all five controls into a shorter opaque capsule.
- Tolerance at an exact reference viewport is ±2 physical pixels for size and anchor. Intermediate sizes must interpolate continuously and retain gameplay/status safe-area separation.
- Mobile utility surfaces use the captured translucent treatment; they must not become a near-opaque dark toolbar.

## Status footer

- Portrait provider and game name are one left-aligned identity group; the game name follows the provider instead of moving to the far-right Win area.
- Balance, Bet and Win remain complete for normal values. Maximum int64 values use the dedicated density layout and are never ellipsized.

## Menu navigation

- Phone portrait keeps top tabs and reserves the captured header/close clearance before content.
- Landscape phone/tablet uses the captured left vertical rail. At 844×633 the rail is approximately x=22px, width=109px, with tab tops around 22/70/118px; content begins around x=181px.
- Keyboard navigation follows the visual axis: Left/Right for top tabs and Up/Down for the left rail, with Home/End supported in both.
- The WILD title and authored artwork must be fully visible at the top of the paytable after every tab switch and orientation round trip. The 750px authored help surface remains isotropically projected; neither titles nor artwork may be independently squeezed.
- Settings expose the captured hand-mode control on mobile. Desktop-only Spacebar behavior must not be presented as a mobile setting.

## Player rules and host integration

- The reviewed packaged gameplay guide remains available without an operator supplement. Retention, unfinished-game,
  malfunction and jurisdiction copy appears only from a validated operator-approved bundle; a missing or invalid
  supplement omits that operator section instead of hiding the packaged gameplay rules or inventing legal text.
- Definition hash, engine version, RGS authority and allow-list diagnostics stay in developer telemetry and are never rendered as player copy.
- Home/Exit controls are host-owned. The client may expose a typed optional request port, but must not call `window.close`, navigate an invented URL or imply that exit succeeded without a host acknowledgement.

## Regression coverage

- Browser checks cover 390×844, 633×844, 844×633 and 844×390, including both menu axes, first-help-section bounds, control art bounds, transparent hit targets and footer identity order.
- Unit tests cover continuous sizes around the portrait/landscape boundary and preserve the mobile money-density and no-overlap invariants.
