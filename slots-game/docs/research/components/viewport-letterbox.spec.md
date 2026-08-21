# ViewportLetterbox Specification

## Overview

- Target files: `web/src/renderer/ResponsiveLayout.ts`, `web/src/style.css`, application shell and browser contracts.
- Interaction model: resize-driven; the game surface never stretches independently on either axis.
- Outer viewport: fills the browser and paints solid black outside the authored surface.

## Canonical design surfaces

- PC: 1280×720 (`16:9`).
- Phone portrait: 390×844; phone landscape: 844×390.
- Tablet portrait: 633×844; tablet landscape: 844×633.
- The resource channel is frozen for the session. Orientation may swap the canonical width and height, but a resize may not switch desktop/mobile asset families.

## Scale and centering contract

For viewport `(viewportWidth, viewportHeight)` and selected canonical surface `(designWidth, designHeight)`:

```text
scale = min(viewportWidth / designWidth, viewportHeight / designHeight)
left = (viewportWidth - designWidth * scale) / 2
top = (viewportHeight - designHeight * scale) / 2
```

- The frame keeps exact canonical CSS width/height and receives one isotropic `scale(...)` from `top left`.
- `scaleX`, `scaleY`, flexible frame dimensions, cover/crop and independent renderer stretching are forbidden.
- Pillarbox/letterbox regions are black, clipped, non-interactive and never become part of Pixi coordinates.
- Canvas, DOM overlay, hit areas and help overlay remain in the same canonical coordinate system.

## Resize lifecycle

- Apply synchronously once at startup.
- Observe the outer viewport and listen to `window.resize`; when available, also listen to `visualViewport.resize`.
- Coalesce duplicate notifications to one animation frame and invalidate queued work on teardown.
- Each committed resize recomputes the canonical profile, uniform scale and offsets atomically before notifying Pixi/UI consumers.
- No state, wager, presentation or asset reload may be triggered by resize alone.

## Rendering and input

- Pixi renderer dimensions equal the canonical surface, not the physical browser viewport.
- CSS scaling supplies the physical display size; Pixi pointer normalization uses the transformed canvas bounding rectangle.
- Device pixel ratio may change backing resolution policy, but may not change logical geometry.
- Safe-area and browser chrome reduce the available outer viewport; they do not distort the authored surface.

## Responsive profile selection

- Mobile short edge below 600 CSS px selects phone; otherwise tablet.
- Portrait/landscape selects the corresponding canonical orientation.
- Official content layouts remain `pt`, `iPad_pt` and `ls`; phone/tablet classification is separate from those content layout keys.

## Failure-closed tests

- For PC, phone and tablet, test exact fit, narrower, wider, shorter and taller viewports.
- Assert `renderedWidth / renderedHeight == designWidth / designHeight` within floating-point tolerance.
- Assert both scale axes are identical, offsets center the surface, and at least one black bar appears when aspect ratios differ.
- Run repeated device switches and orientation changes; the final geometry must depend only on the final viewport.
- Verify frame hit testing excludes black bars and maps center/corners back to canonical coordinates.
