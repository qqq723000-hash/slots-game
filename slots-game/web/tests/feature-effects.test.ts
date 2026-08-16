import { describe, expect, it, vi } from "vitest";
import type { FeatureEvent } from "../src/app/state/types";
import {
  VisualTelemetryReporter,
  type VisualTelemetryEvent,
} from "../src/renderer/VisualTelemetry";
import {
  AUTHORED_WHEEL_LAYOUT,
  FeatureEffects,
  FREE_SPIN_INTRO_DISPLAY_AWARDED,
  FREE_SPIN_NO_WIN_COPY,
  FREE_SPIN_SUMMARY_TIMELINE_MS,
  RAGE_COLLECT_ABSORBING_MS,
  RAGE_COLLECT_CHARACTER_MS,
  RAGE_COLLECT_HIDE_MS,
  RAGE_COLLECT_HIDE_MIX_MS,
  RAGE_COLLECT_HIDE_START_MS,
  RAGE_COLLECT_FULLY_HIDDEN_MS,
  RAGE_COLLECT_SYMBOL_MS,
  RAGE_COLLECT_TRAIL_MS,
  RAGE_GUARANTEED_STOP_OUTRO_MS,
  REEL_EXPANSION_DELAY_MS,
  REEL_EXPANSION_RESIZE_MS,
  REEL_SHRINK_DATA_DELAY_MS,
  REEL_SHRINK_RESIZE_DELAY_MS,
  ReelAlphaLayers,
  WHEEL_CHARACTER_TIMING_MS,
  PRIMAL_WHEEL_AWARD_IDS,
  PRIMAL_WHEEL_BOUNDED_PRESENTATION_MS,
  PRIMAL_WHEEL_SEGMENTS,
  PRIMAL_WHEEL_CONTROL_LAYOUT,
  PRIMAL_WHEEL_POPUP_TIMELINE_MS,
  PRIMAL_WHEEL_POPUP_LAYOUT,
  PRIMAL_WHEEL_TIMELINE_MS,
  PRIMAL_VAULT_GROUP_TIMELINE_MS,
  PRIMAL_VAULT_TEASE_TIMELINE_MS,
  createFeaturePresentationPlan,
  createPrimalWheelSpinPlan,
  featureModeEntryFrame,
  featureEffectDuration,
  featureEffectLabel,
  freeSpinModeTitle,
  freeSpinIntroRagsStartPhase,
  freeSpinSummaryContinueEnabled,
  freeSpinSummaryTextBindings,
  reelExpansionProgress,
  reelResizePlan,
  reelResizeProgress,
  reelStructureAnimation,
  reportVaultTeasePlaybackReadiness,
  rageCascadePlan,
  rageCollectionPlan,
  shouldHandoffWheelBonusLabel,
  shouldPresentFreeSpinSummary,
  shouldAbortWheelPresentation,
  surgeCollectionFrame,
  surgePresentationBranch,
  vaultFrameAnimation,
  vaultGroupFrameAnimation,
  vaultGroupBarrierDurationMs,
  vaultMutationBatchPlan,
  vaultTeaseDurationMs,
  wheelLandingAngle,
  wheelPopupContinueEnabled,
  wheelResponsiveLayoutTrack,
  wheelSummaryContinueEnabled,
  wheelSpineAnimationPlan,
  wheelStageOverlayTransform,
  primalWheelIdleState,
  primalWheelOutroTaskPlan,
  primalWheelQuickStopElapsed,
  primalWheelRuntimeTimeline,
  primalWheelSpinFrame,
  projectWheelHyperspinControl,
  resolvePrimalWheelSegment,
  sampleWheelStopOffset,
  type FeatureEffectKind,
} from "../src/renderer/FeatureEffects";

describe("feature effect planning", () => {
  it("keeps the official Wheel and popup title on independent pixel-fit transforms", () => {
    expect(AUTHORED_WHEEL_LAYOUT).toEqual({
      x: 640,
      y: 440,
      scale: 0.8,
      diameter: 527.2,
    });
    expect(PRIMAL_WHEEL_POPUP_LAYOUT).toEqual({ x: 640, y: 356, scale: 0.64 });
  });

  it("centers and scales the authored Wheel scene in physical mobile regions", () => {
    expect(wheelStageOverlayTransform({ left: 0, top: 0, width: 1_280, height: 720 }))
      .toEqual({ x: 0, y: 0, scale: 1 });
    expect(wheelStageOverlayTransform({ left: 0, top: 0, width: 1_024, height: 732 }))
      .toEqual({ x: -128, y: 6, scale: 1 });
    expect(wheelStageOverlayTransform({ left: 0, top: 0, width: 390, height: 760 }))
      .toEqual({ x: -221, y: 146, scale: 0.65 });
    const landscapePhone = wheelStageOverlayTransform({
      left: 0, top: 0, width: 844, height: 372,
    });
    expect(landscapePhone.scale).toBeCloseTo(372 / 720, 8);
    expect(landscapePhone.x).toBeCloseTo(91.333_333, 5);
    expect(landscapePhone.y).toBeCloseTo(0, 8);
  });

  it("extracts structural expansion without changing canonical event order", () => {
    const events: readonly FeatureEvent[] = [
      { type: "grid.expanded", rows: 6, ways: 216 },
      { type: "vault.awarded", reel: 1, row: 2, multiplier: 16, amountMinor: "1600" },
      { type: "free_spin.awarded", count: 1 },
      {
        type: "vault.upgraded", reel: 1, row: 4,
        fromMultiplier: 7, toMultiplier: 40, prize: "X40", step: 1,
      },
    ];

    const plan = createFeaturePresentationPlan(events);

    expect(plan.beforeReels).toEqual([events[0]]);
    expect(plan.orderedEvents).toEqual(events);
    expect(plan.orderedEvents).not.toBe(events);
    expect(events.map((event) => event.type)).toEqual([
      "grid.expanded",
      "vault.awarded",
      "free_spin.awarded",
      "vault.upgraded",
    ]);
  });

  it("uses exact authoritative facts in result labels", () => {
    expect(featureEffectLabel({
      type: "grid.expanded", rows: 8, ways: 512,
    })).toBe("8 ROWS // 512 WAYS");
    expect(featureEffectLabel({
      type: "vault.awarded", reel: 1, row: 0, multiplier: 120, amountMinor: "12000",
    })).toBe("VAULT BREACH // ×120");
    expect(featureEffectLabel({
      type: "vault.upgraded", reel: 1, row: 0,
      fromMultiplier: 16, toMultiplier: 120, prize: "X120", step: 2,
    })).toBe("CORE UPGRADE // ×16 → ×120");
    expect(featureEffectLabel({
      type: "wheel.awarded", outcome: "INSTANT", prize: "MINOR",
      multiplier: 30, amountMinor: "3000",
    })).toBe("WHEEL LOCK // INSTANT ×30");
    expect(featureEffectLabel({
      type: "surge.collected",
      count: 3,
      cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
      triggered: true,
      guaranteed: true,
      level: 1,
      total: 0,
    })).toBe("CORE LOCK // 3/3 // WHEEL GUARANTEED");
    expect(featureEffectLabel({
      type: "free_spins.completed", mode: "EXPANSION",
      awarded: 9, cumulativeWinMinor: "12500",
    })).toBe("FREE SPINS COMPLETE // 12500");
  });

  it("shortens every authored effect under reduced motion", () => {
    const kinds: FeatureEffectKind[] = ["expansion", "vault", "wheel", "collect", "mode", "summary", "pulse"];
    for (const kind of kinds) {
      expect(featureEffectDuration(kind, true)).toBeLessThan(featureEffectDuration(kind, false));
      expect(featureEffectDuration(kind, true)).toBeLessThanOrEqual(140);
    }
    expect(featureEffectDuration("wheel", false)).toBeGreaterThanOrEqual(1_500);
  });

  it("uses the captured 450ms delay and 1000ms inOutQuad reel resize", () => {
    expect(REEL_EXPANSION_DELAY_MS).toBe(450);
    expect(REEL_EXPANSION_RESIZE_MS).toBe(1_000);
    expect(featureEffectDuration("expansion", false)).toBe(1_450);
    expect(reelExpansionProgress(449)).toBe(0);
    expect(reelExpansionProgress(450)).toBe(0);
    expect(reelExpansionProgress(700)).toBeCloseTo(0.125, 10);
    expect(reelExpansionProgress(950)).toBeCloseTo(0.5, 10);
    expect(reelExpansionProgress(1_450)).toBe(1);
  });

  it("uses the captured two-stage 450ms/900ms shrink and reel-smash branch", () => {
    expect(REEL_SHRINK_DATA_DELAY_MS).toBe(450);
    expect(REEL_SHRINK_RESIZE_DELAY_MS).toBe(900);
    expect(reelResizePlan(7, 3)).toEqual({
      direction: "shrink",
      dataAtMs: 450,
      resizeAtMs: 900,
      resizeDurationMs: 1_000,
      totalMs: 1_900,
    });
    expect(reelResizeProgress(899, 7, 3)).toBe(0);
    expect(reelResizeProgress(900, 7, 3)).toBe(0);
    expect(reelResizeProgress(1_400, 7, 3)).toBeCloseTo(0.5, 10);
    expect(reelResizeProgress(1_900, 7, 3)).toBe(1);
    expect(reelResizePlan(3, 6).direction).toBe("expand");
    expect(reelResizePlan(5, 5)).toEqual({
      direction: "same",
      dataAtMs: 450,
      resizeAtMs: 450,
      resizeDurationMs: 1_000,
      totalMs: 1_450,
    });
    expect(reelStructureAnimation("expand")).toBe("reel_stretch");
    expect(reelStructureAnimation("shrink")).toBe("reel_smash");
    expect(reelStructureAnimation("same")).toBeNull();
  });

  it("holds Vault tease for 1s and adds the original locked/no-win grace", () => {
    expect(PRIMAL_VAULT_TEASE_TIMELINE_MS).toEqual({
      baseHold: 1_000,
      lockedNoWinExtraHold: 500,
      reducedMotion: 120,
    });
    expect(vaultTeaseDurationMs(false, false)).toBe(1_000);
    expect(vaultTeaseDurationMs(false, true)).toBe(1_500);
    expect(vaultTeaseDurationMs(true, true)).toBe(120);
  });

  it("lets the captured full-stage Vault skip finish anticipation and accelerate every symbol", () => {
    const effects = Object.create(FeatureEffects.prototype) as FeatureEffects;
    const cells = [{ reel: 1, row: 0 }, { reel: 1, row: 2 }] as const;
    const finish = vi.fn();
    const skipVaultTease = vi.fn();
    Object.defineProperties(effects, {
      destroyed: { configurable: true, writable: true, value: false },
      reels: { configurable: true, value: { skipVaultTease } },
      activeVaultTease: {
        configurable: true,
        writable: true,
        value: { cells, state: "waiting", finish },
      },
    });

    expect(effects.requestVaultTeaseSkip()).toBe(true);
    expect(skipVaultTease).toHaveBeenCalledWith(cells);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(effects.requestVaultTeaseSkip()).toBe(false);
  });

  it("reports a zero-success Vault tease before fallback and never completes it naturally", async () => {
    const events: VisualTelemetryEvent[] = [];
    const reporter = new VisualTelemetryReporter();
    reporter.setListener((event) => { events.push(event); });
    expect(reportVaultTeasePlaybackReadiness(reporter, 1, 0)).toBe(false);

    expect(events).toEqual([
      expect.objectContaining({
        kind: "fail",
        id: "vault.tease",
        stage: "animation",
        code: "missing-animation",
      }),
    ]);
    expect(events.some((event) => event.kind === "complete")).toBe(false);
  });

  it("uses the captured Vault group frame levels and 500ms ape-thump barrier", () => {
    expect(PRIMAL_VAULT_GROUP_TIMELINE_MS).toEqual({
      thumpBarrier: 500,
      reducedMotion: 40,
    });
    expect(vaultFrameAnimation(1)).toBe("vault");
    expect(vaultFrameAnimation(2)).toBe("vault_lvl2");
    expect(vaultFrameAnimation(3)).toBe("vault_lvl3");
    expect(vaultFrameAnimation(8)).toBe("vault_lvl3");
    expect(vaultGroupFrameAnimation({
      type: "vaults.unlock.started", count: 3,
    })).toBe("vault_lvl3");
    expect(vaultGroupFrameAnimation({
      type: "vaults.upgrade.started", count: 3,
    })).toBe("vault");
    expect(vaultGroupBarrierDurationMs(false)).toBe(500);
    expect(vaultGroupBarrierDurationMs(true)).toBe(40);
    expect(featureEffectDuration("vault", false)).toBe(500);
  });

  it("plans Vault unlocks/upgrades as one concurrent longest-clip batch", () => {
    const events = [
      { type: "vault.unlocked", reel: 1, row: 0, prize: "MINI", multiplier: 10 },
      {
        type: "vault.upgraded", reel: 1, row: 1,
        fromMultiplier: 10, toMultiplier: 20, prize: "MINI_2X", step: 1,
      },
      {
        type: "vault.upgraded", reel: 1, row: 2,
        fromMultiplier: 30, toMultiplier: 60, prize: "MINOR_2X", step: 1,
      },
    ] as const;
    expect(vaultMutationBatchPlan(events, false)).toEqual({
      unlockCount: 1,
      upgradeCount: 2,
      durationMs: 1_500,
    });
    expect(vaultMutationBatchPlan(events.slice(1), false)).toEqual({
      unlockCount: 0,
      upgradeCount: 2,
      durationMs: 833.333,
    });
    expect(vaultMutationBatchPlan(events, true).durationMs).toBe(120);
    expect(vaultMutationBatchPlan([], false).durationMs).toBe(0);
  });
});

describe("feature trigger choreography", () => {
  it("replays the captured 4.12s shuffled Rage cascade state machine", () => {
    const plan = rageCascadePlan([8, 0, 7, 1, 6, 2, 5, 3, 4]);
    const cells = plan.milestones.filter((milestone) => milestone.type === "cell");

    expect(plan.respinAtMs).toBe(0);
    expect(cells.map(({ atMs }) => atMs)).toEqual([
      390, 450, 510, 570, 630, 690, 750, 810, 870,
    ]);
    expect(cells.map(({ cellIndex }) => cellIndex)).toEqual([8, 0, 7, 1, 6, 2, 5, 3, 4]);
    expect(plan.cascadeCompleteAtMs).toBe(930);
    expect(plan.poundAtMs).toBe(1_430);
    expect(plan.activationAtMs).toBe(1_820);
    expect(plan.totalMs).toBe(4_120);
    expect(plan.milestones).toContainEqual({
      type: "backdrop-shake", atMs: 400, phase: "respin",
    });
    expect(plan.milestones).toContainEqual({
      type: "backdrop-shake", atMs: 1_930, phase: "pound",
    });
    expect(plan.milestones).toContainEqual({ type: "pound", atMs: 1_430 });
    expect(plan.milestones).toContainEqual({ type: "activation", atMs: 1_820 });
    expect(() => rageCascadePlan([0, 1, 2, 3, 4, 5, 6, 7, 7])).toThrow(/permutation/);
  });

  it("routes failed, transformed, and exact-three Rage through their single owners", () => {
    expect(surgePresentationBranch(false, false)).toBe("collect");
    expect(surgePresentationBranch(true, false)).toBe("cascade-on-transform");
    expect(surgePresentationBranch(true, true)).toBe("post-stop-activation");
  });

  it("batches ordinary Rage consumption and splits guaranteed activation", () => {
    const consumed = rageCollectionPlan(2, false);
    expect(consumed).toEqual({
      kind: "consume-batch",
      cellStartMs: [0, 0],
      symbolLayerRestoreAtMs: RAGE_COLLECT_SYMBOL_MS,
      symbolHideStartAtMs: RAGE_COLLECT_HIDE_START_MS,
      symbolHideAtMs: RAGE_COLLECT_FULLY_HIDDEN_MS,
      trailEndMs: RAGE_COLLECT_TRAIL_MS,
      presentationMs: RAGE_COLLECT_TRAIL_MS,
      characterMs: RAGE_COLLECT_CHARACTER_MS,
    });
    expect(RAGE_COLLECT_SYMBOL_MS).toBe(1_000);
    expect(RAGE_COLLECT_HIDE_MS).toBe(166.7);
    expect(RAGE_COLLECT_HIDE_MIX_MS).toBe(150);
    expect(RAGE_COLLECT_HIDE_START_MS).toBe(850);
    expect(RAGE_COLLECT_FULLY_HIDDEN_MS).toBe(1_016.7);
    expect(RAGE_COLLECT_ABSORBING_MS).toBe(500);
    expect(RAGE_COLLECT_TRAIL_MS).toBe(1_200);
    expect(RAGE_COLLECT_CHARACTER_MS).toBe(3_000);

    expect(rageCollectionPlan(3, true)).toMatchObject({
      kind: "guaranteed-activation",
      cellStartMs: [0, 0, 0],
      symbolLayerRestoreAtMs: null,
      symbolHideStartAtMs: null,
      symbolHideAtMs: null,
      trailEndMs: null,
      presentationMs: RAGE_GUARANTEED_STOP_OUTRO_MS,
      characterMs: 1_666.7,
    });
    expect(RAGE_GUARANTEED_STOP_OUTRO_MS).toBe(1_250);
  });

  it("separates collection, trigger shockwave, and miss resolution", () => {
    const collecting = surgeCollectionFrame(0.5, true, false, false);
    expect(collecting.beamProgress).toBe(1);
    expect(collecting.moteProgress).toBeGreaterThan(0);
    expect(collecting.chargeAlpha).toBeGreaterThan(0);

    const chanceTrigger = surgeCollectionFrame(0.75, true, false, false);
    const guaranteed = surgeCollectionFrame(0.75, true, true, false);
    const miss = surgeCollectionFrame(0.75, false, false, false);
    expect(chanceTrigger.shockwaveAlpha).toBeGreaterThan(0);
    expect(guaranteed.shockwaveAlpha).toBeGreaterThan(chanceTrigger.shockwaveAlpha);
    expect(miss.shockwaveAlpha).toBe(0);
    expect(miss.missAlpha).toBeGreaterThan(0);
  });

  it("removes spatial collection travel in reduced motion", () => {
    const frame = surgeCollectionFrame(0.5, true, true, true);
    expect(frame.beamProgress).toBe(0);
    expect(frame.moteProgress).toBe(0);
    expect(frame.shockwaveAlpha).toBe(0);
    expect(frame.bannerAlpha).toBeGreaterThan(0);
  });

  it("stages the free-spin title before its counter and removes spatial rail growth", () => {
    const early = featureModeEntryFrame(0.25, false);
    const middle = featureModeEntryFrame(0.55, false);
    expect(early.titleAlpha).toBeGreaterThan(early.counterAlpha);
    expect(middle.counterAlpha).toBeGreaterThan(0);
    expect(featureModeEntryFrame(0.5, true).railScale).toBe(1);
  });

  it("keeps the captured Free Spins summary show, hold, and hide schedule", () => {
    expect(FREE_SPIN_SUMMARY_TIMELINE_MS).toEqual({
      show: 933.333,
      continueHold: 3_000,
      hide: 1_133.333,
      hideAt: 3_933.333,
      total: 5_066.666,
    });
    expect(featureEffectDuration("summary", false)).toBe(5_066.666);
    expect(featureEffectDuration("summary", true)).toBe(140);
  });

  it("keeps fallback feature names aligned with the captured intros", () => {
    expect(FREE_SPIN_INTRO_DISPLAY_AWARDED).toBe(8);
    expect(freeSpinModeTitle("EXPANSION")).toBe("KONG QUEST");
    expect(freeSpinModeTitle("OVERDRIVE")).toBe("KING SPIN");
    expect(freeSpinIntroRagsStartPhase("OVERDRIVE")).toBe("entry");
    expect(freeSpinIntroRagsStartPhase("EXPANSION")).toBe("entry");
  });

  it("shows the authored summary only above bet and fails closed on malformed money", () => {
    expect(shouldPresentFreeSpinSummary("0", "100")).toBe(false);
    expect(shouldPresentFreeSpinSummary("99", "100")).toBe(false);
    expect(shouldPresentFreeSpinSummary("100", "100")).toBe(false);
    expect(shouldPresentFreeSpinSummary("101", "100")).toBe(true);
    expect(shouldPresentFreeSpinSummary("999999999999999999999999999999", "1")).toBe(true);

    for (const invalid of ["", "-1", "+100", "01", "1.0", " 100", "100 ", "1e2"]) {
      expect(shouldPresentFreeSpinSummary(invalid, "100")).toBe(false);
      expect(shouldPresentFreeSpinSummary("101", invalid)).toBe(false);
    }
    expect(shouldPresentFreeSpinSummary("1", "0")).toBe(true);
  });

  it("retains fail-safe summary bindings without changing the live summary gate", () => {
    expect(freeSpinSummaryTextBindings({
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor: "0",
    }).map(({ name, text }) => [name, text])).toEqual([
      ["fsSummaryCongrats", FREE_SPIN_NO_WIN_COPY],
      ["fsSummaryValue", ""],
      ["fsSummaryTotal", ""],
    ]);

    expect(freeSpinSummaryTextBindings({
      type: "free_spins.completed",
      mode: "OVERDRIVE",
      awarded: 8,
      cumulativeWinMinor: "99",
    }).map(({ text }) => text)).toEqual([
      "CONGRATULATIONS!",
      "0.99",
      "Total Win",
    ]);

    expect(freeSpinSummaryTextBindings({
      type: "free_spins.completed",
      mode: "OVERDRIVE",
      awarded: 8,
      cumulativeWinMinor: "123456789012345678901",
    }).map(({ text }) => text)).toContain("1234567890123456789.01");

    expect(() => freeSpinSummaryTextBindings({
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor: "01",
    })).toThrow(/canonical minor units/);
  });
});

describe("authoritative wheel landing", () => {
  it("selects the live official horizontal/vertical layout token", () => {
    expect(wheelResponsiveLayoutTrack(1280, 720)).toBe("layout/horizontal");
    expect(wheelResponsiveLayoutTrack(844, 390)).toBe("layout/horizontal");
    expect(wheelResponsiveLayoutTrack(390, 844)).toBe("layout/vertical");
    expect(wheelResponsiveLayoutTrack(720, 720)).toBe("layout/vertical");
  });

  it("opens popup CONTINUE during show and Layer-A CONTINUE from summary show", () => {
    expect(wheelPopupContinueEnabled(0)).toBe(true);
    expect(wheelPopupContinueEnabled(1_250)).toBe(true);
    expect(wheelPopupContinueEnabled(2_499.999)).toBe(true);
    expect(wheelPopupContinueEnabled(2_500)).toBe(false);
    expect(wheelPopupContinueEnabled(Number.NaN)).toBe(false);
    expect(wheelSummaryContinueEnabled(11_749.999)).toBe(false);
    expect(wheelSummaryContinueEnabled(11_750)).toBe(true);
    expect(wheelSummaryContinueEnabled(12_816.7)).toBe(true);
    expect(wheelSummaryContinueEnabled(15_816.699)).toBe(true);
    expect(wheelSummaryContinueEnabled(15_816.7)).toBe(false);
    expect(wheelSummaryContinueEnabled(Number.NaN)).toBe(false);
    expect(wheelSummaryContinueEnabled(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("opens Free Spins summary CONTINUE only after show and for three seconds", () => {
    expect(freeSpinSummaryContinueEnabled(933.332)).toBe(false);
    expect(freeSpinSummaryContinueEnabled(933.333)).toBe(true);
    expect(freeSpinSummaryContinueEnabled(3_933.332)).toBe(true);
    expect(freeSpinSummaryContinueEnabled(3_933.333)).toBe(false);
    expect(freeSpinSummaryContinueEnabled(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("accepts the Free Spins summary gesture once", () => {
    const effects = Object.create(FeatureEffects.prototype) as FeatureEffects;
    const finish = vi.fn();
    const onFreeSpinSummaryClose = vi.fn();
    Object.defineProperties(effects, {
      destroyed: { configurable: true, writable: true, value: false },
      hooks: { configurable: true, value: { onFreeSpinSummaryClose } },
      activeFreeSpinSummaryContinue: {
        configurable: true,
        writable: true,
        value: { state: "waiting", closeNotified: false, finish },
      },
    });
    expect(effects.requestFreeSpinSummaryContinue()).toBe(true);
    expect(effects.requestFreeSpinSummaryContinue()).toBe(false);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(onFreeSpinSummaryClose).toHaveBeenCalledTimes(1);
    expect(onFreeSpinSummaryClose).toHaveBeenCalledWith("continue");
  });

  it("accepts the summary gesture once and closes the shared input gate", () => {
    const effects = Object.create(FeatureEffects.prototype) as FeatureEffects;
    const finish = vi.fn();
    const onWheelSummaryClose = vi.fn();
    Object.defineProperties(effects, {
      destroyed: { configurable: true, writable: true, value: false },
      hooks: { configurable: true, value: { onWheelSummaryClose } },
      activeWheelSummaryContinue: {
        configurable: true,
        writable: true,
        value: null,
      },
    });

    expect(effects.requestWheelSummaryContinue()).toBe(false);
    Object.defineProperty(effects, "activeWheelSummaryContinue", {
      configurable: true,
      writable: true,
      value: { state: "waiting", closeNotified: false, finish },
    });
    expect(effects.requestWheelSummaryContinue()).toBe(true);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(onWheelSummaryClose).toHaveBeenCalledWith("continue");
    expect(effects.requestWheelSummaryContinue()).toBe(false);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(onWheelSummaryClose).toHaveBeenCalledTimes(1);
  });

  it("uses the first Wheel gesture only to close popup, leaving spin for a second gesture", () => {
    const effects = Object.create(FeatureEffects.prototype) as FeatureEffects;
    const finish = vi.fn();
    const onWheelPopupClose = vi.fn();
    Object.defineProperties(effects, {
      destroyed: { configurable: true, writable: true, value: false },
      hooks: { configurable: true, value: { onWheelPopupClose } },
      activeWheelPopupContinue: {
        configurable: true,
        writable: true,
        value: { state: "waiting", closeNotified: false, finish },
      },
      activeWheelInteraction: { configurable: true, writable: true, value: null },
    });
    expect(effects.requestWheelInteraction()).toBe("popup-continued");
    expect(effects.requestWheelInteraction()).toBeNull();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(onWheelPopupClose).toHaveBeenCalledWith("continue");
  });

  it("samples cosmetic stop offset only when requested and never for reduced motion", () => {
    const source = vi.fn()
      .mockReturnValueOnce(-0.15)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.149_999);

    expect(source).not.toHaveBeenCalled();
    expect(sampleWheelStopOffset(source, true)).toBe(0);
    expect(source).not.toHaveBeenCalled();
    expect(sampleWheelStopOffset(source, false)).toBe(-0.15);
    expect(sampleWheelStopOffset(source, false)).toBe(0);
    expect(sampleWheelStopOffset(source, false)).toBe(0.149_999);
    expect(source).toHaveBeenCalledTimes(3);
  });

  it("fans Wheel hide, Summary hide, and reel fade from one H frame", () => {
    expect(primalWheelOutroTaskPlan(PRIMAL_WHEEL_TIMELINE_MS)).toEqual({
      wheelMs: 500,
      summaryMs: 666.7,
      reelsMs: 1_000,
      processBarrierMs: 500,
      ownershipMs: 1_000,
    });
  });

  it("composes the H+1000 reel tail with a Free Spins overlay after H+500", () => {
    const reels = { alpha: 1 };
    const layers = new ReelAlphaLayers(reels);
    const wheelTail = layers.acquire();

    // 到达 H+500 流程屏障时，一秒的转轴淡出已完成一半。
    wheelTail.setAlpha(0.5);
    expect(reels.alpha).toBe(0.5);

    // 后续入场必须保留 Wheel 之前的稳定基准值，不能把短暂的 0.5 捕获为
    // 最终恢复值。
    const freeSpinIntro = layers.acquire();
    expect(freeSpinIntro.baseAlpha).toBe(1);
    freeSpinIntro.setAlpha(0.6);
    expect(reels.alpha).toBeCloseTo(0.3, 12);

    // H+1000 只完成并释放 Wheel 所有者。它不能覆盖仍处于活动状态的入场演出，
    // 后续由入场演出恢复规范基准值。
    wheelTail.setAlpha(1);
    wheelTail.release();
    expect(reels.alpha).toBeCloseTo(0.6, 12);
    freeSpinIntro.release();
    expect(reels.alpha).toBe(1);
  });

  it("restores reel alpha once and invalidates stale layers on teardown", () => {
    const reels = { alpha: 0.8 };
    const layers = new ReelAlphaLayers(reels);
    const wheelTail = layers.acquire();
    const nextScene = layers.acquire();
    wheelTail.setAlpha(0.4);
    nextScene.setAlpha(0.2);
    expect(reels.alpha).toBeCloseTo(0.1, 12);

    layers.restore();
    expect(reels.alpha).toBe(0.8);
    wheelTail.setAlpha(0.1);
    nextScene.release();
    wheelTail.release();
    expect(reels.alpha).toBe(0.8);
  });

  it("cancels managed Wheel outro tasks and cleanup exactly once on destroy", () => {
    const effects = Object.create(FeatureEffects.prototype) as FeatureEffects;
    const finish = vi.fn();
    const cleanup = vi.fn();
    Object.assign(effects as unknown as Record<string, unknown>, {
      destroyed: false,
      animations: new Set([{ handle: 1, finish }]),
      managedWheelSceneCleanups: new Set([cleanup]),
      activeWheelPopupContinue: null,
      activeWheelInteraction: null,
      activeWheelSummaryContinue: null,
      activeFreeSpinContinue: null,
      activeFreeSpinSummaryContinue: null,
      activeVaultTease: null,
      reelAlphaLayers: { restore: vi.fn() },
    });

    effects.destroy();
    effects.destroy();

    expect(finish).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("routes quick-stop input only while the spinner is in STOPPING", () => {
    const effects = Object.create(FeatureEffects.prototype) as FeatureEffects;
    const onWheelQuickStop = vi.fn();
    const interaction = {
      state: "spinning",
      quickStopRequested: false,
      quickStopEligible: false,
      resolveContinue: vi.fn(),
    };
    Object.defineProperties(effects, {
      destroyed: { configurable: true, writable: true, value: false },
      hooks: { configurable: true, value: { onWheelQuickStop } },
      activeWheelPopupContinue: { configurable: true, writable: true, value: null },
      activeWheelInteraction: {
        configurable: true,
        writable: true,
        value: interaction,
      },
    });

    expect(effects.requestWheelInteraction()).toBeNull();
    interaction.quickStopEligible = true;
    expect(effects.requestWheelInteraction()).toBe("quick-stop");
    expect(interaction).toMatchObject({
      state: "settling",
      quickStopRequested: true,
      quickStopEligible: false,
    });
    expect(onWheelQuickStop).toHaveBeenCalledTimes(1);
    expect(effects.requestWheelInteraction()).toBeNull();
  });

  it("hands Layer B off at Wheel-hide completion and fails closed without money", () => {
    const amount = {
      type: "wheel.awarded", outcome: "INSTANT", prize: "MINI",
      multiplier: 10, amountMinor: "1000",
    } as const;
    expect(shouldHandoffWheelBonusLabel(amount, false, 16_316.699)).toBe(false);
    expect(shouldHandoffWheelBonusLabel(amount, false, 16_316.7)).toBe(true);
    expect(shouldHandoffWheelBonusLabel(amount, true, 16_316.7)).toBe(false);
    expect(shouldHandoffWheelBonusLabel({
      type: "wheel.awarded", outcome: "EXPANSION",
    }, false, 16_316.7)).toBe(false);
    expect(shouldHandoffWheelBonusLabel({
      ...amount,
      amountMinor: "01",
    }, false, 16_316.7)).toBe(false);
  });

  it("separates cancellation cleanup from the authoritative finish milestone", () => {
    expect(shouldAbortWheelPresentation(false, false)).toBe(false);
    expect(shouldAbortWheelPresentation(true, false)).toBe(true);
    expect(shouldAbortWheelPresentation(true, true)).toBe(false);
  });

  it("keeps popup and spin clocks separate in the captured default timeline", () => {
    expect(PRIMAL_WHEEL_SEGMENTS).toEqual([
      "MEGA",
      "KONG QUEST",
      "MINOR",
      "GRAND",
      "KING SPIN",
      "MAJOR",
      "MINI",
    ]);
    expect(PRIMAL_WHEEL_POPUP_TIMELINE_MS).toEqual({ show: 2_500, reelFade: 1_000 });
    expect(PRIMAL_WHEEL_TIMELINE_MS).toMatchObject({
      idleAcceleration: 200,
      configuredStop: 10_000,
      selectionDeceleration: 8_800,
      selectionReserve: 1_000,
      landing: 9_800,
      fastConfiguredStop: 3_000,
      fastSelectionDeceleration: 1_800,
      fastLanding: 2_800,
      highlightHold: 1_200,
      postHighlightHold: 750,
      summaryShowAt: 11_750,
      summaryShow: 1_066.7,
      summaryContinueHold: 3_000,
      summaryHideAt: 15_816.7,
      wheelHide: 500,
      summaryHide: 666.7,
      reelFade: 1_000,
      total: 16_816.7,
    });
    expect(PRIMAL_WHEEL_BOUNDED_PRESENTATION_MS).toBe(19_316.7);
    expect(featureEffectDuration("wheel", false)).toBe(19_316.7);
  });

  it("bounds chest-pound to the authored spin and landing milestones", () => {
    expect(WHEEL_CHARACTER_TIMING_MS).toEqual({
      chestPoundStart: 0,
      chestPoundFinish: 9_800,
    });
    expect(WHEEL_CHARACTER_TIMING_MS.chestPoundFinish)
      .toBeLessThan(featureEffectDuration("wheel", false));
  });

  it("matches the original desktop wheel root, contain scale, and frame diameter", () => {
    expect(AUTHORED_WHEEL_LAYOUT).toEqual({
      x: 640,
      y: 440,
      scale: 0.8,
      diameter: 527.2,
    });
  });

  it("preserves the 600px circular Wheel input without freezing a DOM projection", () => {
    expect(PRIMAL_WHEEL_CONTROL_LAYOUT).toMatchObject({
      sourceHitDiameter: 600,
      hitDiameter: 480,
      x: 640,
      y: 440,
      spinTextSourceSize: 150,
      spinTextSize: 120,
      spinTextLetterSpacing: 8,
    });
  });

  it.each([
    {
      viewport: "desktop crop",
      metrics: {
        buttonRect: { left: 1_102, top: 575, width: 97, height: 97 },
        canvasRect: { left: -30.5, top: 0, width: 1_280, height: 720 },
        rendererWidth: 1_280,
        rendererHeight: 720,
      },
      scene: { x: 0, y: 0, scale: 1 },
      expected: { x: 1_181, y: 623.5, scale: 0.776 },
    },
    {
      viewport: "tablet",
      metrics: {
        buttonRect: { left: 903.712, top: 312, width: 108, height: 108 },
        canvasRect: { left: 0, top: 0, width: 1_024, height: 768 },
        rendererWidth: 1_024,
        rendererHeight: 768,
      },
      scene: { x: -128, y: 6, scale: 1 },
      expected: { x: 1_085.712, y: 360, scale: 0.864 },
    },
    {
      viewport: "portrait phone",
      metrics: {
        buttonRect: { left: 150.15, top: 589.276, width: 89.7, height: 89.7 },
        canvasRect: { left: 0, top: 0, width: 390, height: 844 },
        rendererWidth: 390,
        rendererHeight: 844,
      },
      scene: { x: -221, y: 146, scale: 0.65 },
      expected: { x: 640, y: 750.963_076_923, scale: 1.104 },
    },
    {
      viewport: "landscape phone",
      metrics: {
        buttonRect: { left: 742.72, top: 140.424, width: 91.152, height: 91.152 },
        canvasRect: { left: 0, top: 0, width: 844, height: 390 },
        rendererWidth: 844,
        rendererHeight: 390,
      },
      scene: { x: 91.333_333_333_333, y: 0, scale: 372 / 720 },
      expected: { x: 1_348.96, y: 360, scale: 1.411_385_806_452 },
    },
  ])("projects the shared Spin control into the $viewport Wheel scene", ({
    metrics, scene, expected,
  }) => {
    const projection = projectWheelHyperspinControl(metrics, scene);
    expect(projection).not.toBeNull();
    expect(projection?.x).toBeCloseTo(expected.x, 6);
    expect(projection?.y).toBeCloseTo(expected.y, 6);
    expect(projection?.scale).toBeCloseTo(expected.scale, 6);
  });

  it("fails closed for invalid or non-positive Wheel control metrics", () => {
    const valid = {
      buttonRect: { left: 1_102, top: 575, width: 97, height: 97 },
      canvasRect: { left: -30.5, top: 0, width: 1_280, height: 720 },
      rendererWidth: 1_280,
      rendererHeight: 720,
    };
    const invalidCases = [
      { ...valid, buttonRect: { ...valid.buttonRect, width: 0 } },
      { ...valid, buttonRect: { ...valid.buttonRect, height: -1 } },
      { ...valid, canvasRect: { ...valid.canvasRect, width: 0 } },
      { ...valid, canvasRect: { ...valid.canvasRect, height: 0 } },
      { ...valid, rendererWidth: 0 },
      { ...valid, rendererHeight: Number.NaN },
      { ...valid, buttonRect: { ...valid.buttonRect, left: Number.POSITIVE_INFINITY } },
    ];
    for (const metrics of invalidCases) {
      expect(projectWheelHyperspinControl(metrics, { x: 0, y: 0, scale: 1 })).toBeNull();
    }
    expect(projectWheelHyperspinControl(valid, { x: 0, y: 0, scale: 0 })).toBeNull();
  });

  it("carries live idle p0/v0 through early, midpoint, and timed-out popup paths", () => {
    const paths = [
      { popupMs: 0, readyMs: 0 },
      { popupMs: 1_250, readyMs: 0 },
      { popupMs: 2_500, readyMs: 0 },
      { popupMs: 0, readyMs: 10_000 },
      { popupMs: 1_250, readyMs: 10_000 },
      { popupMs: 2_500, readyMs: 10_000 },
    ] as const;

    for (const { popupMs, readyMs } of paths) {
      const launch = primalWheelIdleState(popupMs + readyMs);
      const plan = createPrimalWheelSpinPlan({ segment: 3, launchState: launch });
      expect(plan.startPositionSectors).toBeCloseTo(launch.positionSectors, 12);
      expect(plan.startVelocitySectorsPerMs).toBeCloseTo(launch.velocitySectorsPerMs, 12);
      expect(plan.landingMs).toBe(9_800);
    }

    expect(primalWheelIdleState(0)).toMatchObject({
      stage: "idle-acceleration",
      positionSectors: 0,
      velocitySectorsPerMs: 0,
    });
    expect(primalWheelIdleState(200)).toMatchObject({ stage: "idle" });
    expect(primalWheelIdleState(2_500).positionSectors).toBeCloseTo(0.24, 12);
    expect(primalWheelIdleState(12_500).positionSectors).toBeCloseTo(1.24, 12);
  });

  it("uses the exact stop polynomial and a constant reserved stop segment", () => {
    const launch = primalWheelIdleState(12_500);
    const plan = createPrimalWheelSpinPlan({
      segment: 3,
      launchState: launch,
      stopOffsetSectors: 0.1,
    });
    const progress = 0.5;
    const expected = (((plan.curve4 * progress + plan.curve3) * progress + plan.curve2)
      * progress + plan.curve1) * progress + plan.startPositionSectors;
    const halfway = primalWheelSpinFrame(plan, plan.decelerationMs * progress);
    const reserveStart = primalWheelSpinFrame(plan, plan.decelerationMs);
    const reserveEnd = primalWheelSpinFrame(plan, plan.landingMs - 0.001);
    const landed = primalWheelSpinFrame(plan, plan.landingMs);

    expect(halfway.positionSectors).toBeCloseTo(expected, 12);
    expect(halfway.anticipationEligible).toBe(false);
    expect(primalWheelSpinFrame(plan, plan.decelerationMs * 0.500_001)
      .anticipationEligible).toBe(true);
    expect(reserveStart.stage).toBe("stop-reserve");
    expect(reserveStart.positionSectors).toBe(plan.finalPositionSectors);
    expect(reserveEnd.positionSectors).toBe(plan.finalPositionSectors);
    expect(landed).toMatchObject({
      stage: "landed",
      positionSectors: plan.finalPositionSectors,
    });
  });

  it("keeps legal random offsets, has zero bounce, and enforces [-.15,.15)", () => {
    const launch = primalWheelIdleState(2_500);
    const offsets = [-0.15, 0, 0.149_999] as const;
    for (const stopOffsetSectors of offsets) {
      const plan = createPrimalWheelSpinPlan({
        segment: 2,
        launchState: launch,
        stopOffsetSectors,
      });
      const landed = primalWheelSpinFrame(plan, plan.landingMs);
      expect(plan.bounceAmplitudeSectors).toBe(0);
      expect(plan.finalPositionSectors).toBe(plan.targetPositionSectors + stopOffsetSectors);
      expect(landed.positionSectors).toBe(plan.finalPositionSectors);
      expect(landed.rotationDegrees * Math.PI / 180)
        .toBeCloseTo(wheelLandingAngle({ segment: 2 }, stopOffsetSectors), 12);
    }
    expect(() => createPrimalWheelSpinPlan({
      segment: 2,
      launchState: launch,
      stopOffsetSectors: 0.15,
    })).toThrow(/\[-0.15, 0.15\)/);
    expect(() => createPrimalWheelSpinPlan({
      segment: 2,
      launchState: launch,
      stopOffsetSectors: -0.150_001,
    })).toThrow(/\[-0.15, 0.15\)/);
  });

  it("separates normal, Fast Play, and reduced-motion timing", () => {
    const launch = primalWheelIdleState(2_500);
    const normal = createPrimalWheelSpinPlan({ segment: 5, launchState: launch });
    const fast = createPrimalWheelSpinPlan({ segment: 5, launchState: launch, speed: "fast" });
    const normalDistance = normal.targetPositionSectors - normal.startPositionSectors;
    const fastDistance = fast.targetPositionSectors - fast.startPositionSectors;

    expect(normal).toMatchObject({
      configuredStopMs: 10_000,
      decelerationMs: 8_800,
      reserveMs: 1_000,
      landingMs: 9_800,
    });
    expect(normalDistance).toBeGreaterThanOrEqual(47);
    expect(normalDistance).toBeLessThan(54);
    expect(fast).toMatchObject({
      configuredStopMs: 3_000,
      decelerationMs: 1_800,
      reserveMs: 1_000,
      landingMs: 2_800,
    });
    expect(fastDistance).toBeGreaterThanOrEqual(40);
    expect(fastDistance).toBeLessThan(47);
    expect(primalWheelRuntimeTimeline(fast)).toMatchObject({
      landing: 2_800,
      summaryShowAt: 4_750,
      summaryHideAt: 8_816.7,
      total: 9_816.7,
    });
    expect(featureEffectDuration("wheel", true)).toBe(140);
    expect(createPrimalWheelSpinPlan({ segment: 5, launchState: launch }).speed).toBe("normal");
  });

  it("quick-stops only during STOPPING and retains the full one-second reserve", () => {
    const plan = createPrimalWheelSpinPlan({
      segment: 3,
      launchState: primalWheelIdleState(2_500),
      stopOffsetSectors: 0.1,
    });

    for (const quickStopAt of [0, 4_400, 8_799.999]) {
      const jumped = primalWheelQuickStopElapsed(quickStopAt, quickStopAt, plan);
      const beforeLanding = primalWheelQuickStopElapsed(quickStopAt + 999.999, quickStopAt, plan);
      const landing = primalWheelQuickStopElapsed(quickStopAt + 1_000, quickStopAt, plan);
      expect(jumped).toBeCloseTo(plan.decelerationMs, 9);
      expect(primalWheelSpinFrame(plan, jumped).stage).toBe("stop-reserve");
      expect(primalWheelSpinFrame(plan, beforeLanding).stage).toBe("stop-reserve");
      expect(primalWheelSpinFrame(plan, landing)).toMatchObject({
        stage: "landed",
        positionSectors: plan.finalPositionSectors,
      });
    }

    expect(primalWheelQuickStopElapsed(9_300, 9_000, plan)).toBe(9_300);
    expect(primalWheelQuickStopElapsed(10_500, 10_000, plan)).toBe(10_500);
    expect(primalWheelQuickStopElapsed(4_400, null, plan)).toBe(4_400);
  });

  it("maps only authoritative IDs/names and fails closed for unknown results", () => {
    expect(PRIMAL_WHEEL_AWARD_IDS).toEqual([47, 51, 43, 49, 50, 45, 41]);
    expect(PRIMAL_WHEEL_AWARD_IDS.map(resolvePrimalWheelSegment))
      .toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(resolvePrimalWheelSegment("KONG_QUEST")).toBe(1);
    expect(resolvePrimalWheelSegment("KING SPIN")).toBe(4);
    expect(resolvePrimalWheelSegment({ prize: "GRAND_2X", outcome: "GRAND" })).toBe(3);
    expect(() => resolvePrimalWheelSegment({})).toThrow(/authoritative/);
    expect(() => resolvePrimalWheelSegment("INSTANT")).toThrow(/authoritative/);
    expect(() => resolvePrimalWheelSegment({ awardId: 17 })).toThrow(/Unknown/);
    expect(() => resolvePrimalWheelSegment({ awardId: 47, outcome: "GRAND" }))
      .toThrow(/conflicting/);
  });

  it("uses the animation names and paired result tracks authored in wheel.skel", () => {
    const expansionPlan = wheelSpineAnimationPlan("EXPANSION");
    expect(expansionPlan).not.toHaveProperty("spin");
    expect(expansionPlan).toEqual({
      segment: 1,
      show: "show",
      idle: "idle",
      stop: "stop",
      rotationBone: "rotate",
      spinEffect: "spin_effect",
      arrowGlow: "arrow_glow",
      anticipationLoop: "anticipation/anticipation_loop",
      anticipation: "anticipation/anticipation1",
      highlight: "highlights/highlight1",
      hide: "hide",
      hidden: "hidden",
    });
    expect(wheelSpineAnimationPlan("OVERDRIVE")).toMatchObject({
      segment: 4,
      anticipation: "anticipation/anticipation4",
      highlight: "highlights/highlight4",
    });
    expect([
      wheelSpineAnimationPlan("MEGA").segment,
      wheelSpineAnimationPlan("EXPANSION").segment,
      wheelSpineAnimationPlan("MINOR").segment,
      wheelSpineAnimationPlan("GRAND").segment,
      wheelSpineAnimationPlan("OVERDRIVE").segment,
      wheelSpineAnimationPlan("MAJOR").segment,
      wheelSpineAnimationPlan("MINI").segment,
    ]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(wheelSpineAnimationPlan("KONG_QUEST").segment).toBe(1);
    expect(wheelSpineAnimationPlan("KING_SPIN").segment).toBe(4);
  });

  it("uses official award IDs without multiplier or hash inference", () => {
    expect(PRIMAL_WHEEL_AWARD_IDS.map((awardId) => wheelSpineAnimationPlan({ awardId }).segment))
      .toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(() => wheelSpineAnimationPlan("INSTANT")).toThrow(/authoritative/);
    expect(() => wheelSpineAnimationPlan("CUSTOM")).toThrow(/authoritative/);
    expect(() => wheelSpineAnimationPlan({ awardId: 250 })).toThrow(/Unknown/);
  });
});
