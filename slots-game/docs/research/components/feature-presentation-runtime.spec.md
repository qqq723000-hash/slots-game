# Special Feature Presentation Runtime Specification

## Overview

- **Target files:** `web/src/startup/StreamingAssetRuntime.ts`, `web/src/startup/StreamingAssetPackages.ts`, `web/src/app/AppController.ts`
- **Failure evidence:** `.artifacts/original-reference/local-wheel-streaming-failure-1440x900.png`
- **Interaction model:** authoritative result driven, then time-driven visual presentation
- **Covered features:** Primal Wheel, Free Spins, Big Win and their verified on-demand artwork packages

## Runtime Contract

- The launcher keeps economic truth in the accepted RGS result. Streaming assets may affect only presentation.
- The default `on-demand` runtime must load and SHA-256 verify the channel-specific manifest before a feature adopts artwork.
- A browser-native `fetch` stored on a class instance must be bound to `globalThis`; invoking an unbound native method with the class as `this` is invalid.
- Manifest or resource failure must release the event lease, preserve the authoritative grid/balance and show the bounded public error. A healthy local/production origin must not enter that fallback.
- Feature completion must restore the base scene, filters, HUD and controls without persistent highlight strips or stale overlays.

## Reproduced Failure

- **Viewport:** 1440×900, `layout=desktop`
- **Scenario:** `wheel-mini-flow`
- **Frame projection:** `x=-80`, `y=0`, `width=1600`, `height=900`, `scale=1.25`, `visibleInsetX=64`
- **Observed diagnostics:** `assetStreamingMode=on-demand`, `assetStreamingManifestState=failed`
- **Observed error:** `Failed to execute 'fetch' on 'Window': Illegal invocation`
- **Player result:** the Wheel presentation is skipped, a `PRESENTATION_UNAVAILABLE` toast appears, and the base scene is restored from the accepted result.

## Required States and Behaviors

### Feature package acquisition

- **Trigger:** accepted result contains `wheel.started`, `wheel.awarded`, a Free Spins mode transition, or Big Win qualification.
- **Before:** manifest state is `unrequested` or `validated`; no retained consumer payload unless a lease is active.
- **During:** manifest/resources load through the bound fetch implementation with timeout, byte limits and digest verification.
- **After success:** verified artwork is adopted before the feature's visual boundary; no public error is shown.
- **After failure:** presentation fallback remains bounded and economic/ACK completion still occurs exactly once.

### Desktop visual containment

- At 1440×900 the special feature shares the same 1600×900 cropped root as the base game.
- All player controls and readable feature labels remain within physical `x=0..1440`, `y=0..900`.
- Authored VFX may bleed into cropped wings, but every interactive/core HUD bound must remain inside canonical visible `x=160..1120`; in particular, the Free Spin stop control may not retain the previous `x≈149.8` placement.
- Returning to base must leave the 16px logical status footer at physical `y=880..900`.

## Assets

- Manifest: `/assets/primal-runtime/streaming-packages.<channel>.json`
- Packages: `<channel>-feature-wheel`, `<channel>-feature-free-spins`, `<channel>-feature-big-win`
- Existing verified Spine, texture and BMFont resources are authoritative; no generated substitutes.

## Verification

- Unit tests must exercise default browser-fetch binding as well as injected fetch mocks.
- Browser fixture must complete `wheel-mini-flow` without `fixtureStatus=failed`, without `assetStreamingManifestState=failed`, and without a presentation toast.
- Repeat at PC 1280×720 and 1440×900; mobile 390×844 and 844×390 remain on the mobile contain projection.
