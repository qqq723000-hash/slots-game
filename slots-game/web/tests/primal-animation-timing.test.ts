import { describe, expect, it } from "vitest";
import {
  PRIMAL_CHARACTER_ANIMATION_MS,
  PRIMAL_EXPANSION_TIMING_MS,
  PRIMAL_FEATURE_ANIMATION_MS,
  PRIMAL_REEL_IMPACT_PROGRESS,
  PRIMAL_REEL_SETTLE_MS,
  PRIMAL_REEL_TIMING_MS,
  PRIMAL_SYMBOL_ANIMATION_MS,
  PRIMAL_SYMBOL7_AUXILIARY_IDLE_BREAKER,
  PRIMAL_SYMBOL_IDLE_COOLDOWN_MS,
  PRIMAL_SYMBOL_IDLE_MAX_DURATION_MS,
  PRIMAL_SYMBOL_IDLE_MIN_RESTART_GAP_MS,
  PrimalSymbolIdleTimer,
  primalSymbolIdleClip,
  primalSymbolIdleDelayMs,
  primalSymbolIdleOrder,
  primalSymbolIdleShouldRun,
  primalRageCascadeCellOrder,
} from "../src/reels/primalAnimationTiming";

describe("captured Primal animation timing", () => {
  it("preserves the 24fps-stepped random symbol idle window", () => {
    expect(primalSymbolIdleDelayMs(0)).toBe(3_125);
    expect(primalSymbolIdleDelayMs(0.04)).toBeCloseTo(3_166.666_667);
    expect(primalSymbolIdleDelayMs(0.999_999)).toBe(4_125);
    expect(PRIMAL_SYMBOL_IDLE_COOLDOWN_MS).toBe(1_250);
  });

  it("runs random delay, one trigger, cooldown, then a fresh random delay", () => {
    const samples = [0, 0.999_999];
    const timer = new PrimalSymbolIdleTimer(() => samples.shift() ?? 0);
    expect(timer.remainingMs).toBe(3_125);
    expect(timer.advance(3_124)).toBe(false);
    expect(timer.advance(1)).toBe(true);
    expect(timer.phase).toBe("cooldown");
    expect(timer.remainingMs).toBe(1_250);
    expect(timer.advance(1_250)).toBe(false);
    expect(timer.phase).toBe("random-delay");
    expect(timer.remainingMs).toBe(4_125);
    expect(timer.advance(4_125)).toBe(true);
  });

  it("executes only one overdue scheduler state after a suspended tab resumes", () => {
    const samples = [0, 0.5];
    const timer = new PrimalSymbolIdleTimer(() => samples.shift() ?? 0);
    expect(timer.advance(60_000)).toBe(true);
    expect(timer.phase).toBe("cooldown");
    expect(timer.remainingMs).toBe(1_250);
    expect(timer.advance(60_000)).toBe(false);
    expect(timer.phase).toBe("random-delay");
    expect(timer.remainingMs).toBeCloseTo(3_625);
  });

  it("does not consume a random delay before the idle collection launches", () => {
    let samples = 0;
    const timer = new PrimalSymbolIdleTimer(() => {
      samples += 1;
      return 0;
    }, false);
    expect(samples).toBe(0);
    timer.reset();
    expect(samples).toBe(1);
    expect(timer.remainingMs).toBe(3_125);
  });

  it("uses the original in-place Fisher-Yates traversal", () => {
    expect(primalSymbolIdleOrder(4, () => 0)).toEqual([1, 2, 3, 0]);
    expect(primalSymbolIdleOrder(0, () => 0.5)).toEqual([]);
    expect(() => primalSymbolIdleOrder(-1)).toThrow(/non-negative integer/);
  });

  it("keeps the exact symbol-id idle clips and never schedules Rage idle_breaker", () => {
    expect(primalSymbolIdleClip(0)).toBeNull();
    expect(primalSymbolIdleClip(1)).toBeNull();
    expect(primalSymbolIdleClip(2)).toEqual({ animation: "idle", durationMs: 1_800 });
    expect(primalSymbolIdleClip(7)).toEqual({ animation: "idle", durationMs: 3_533.334 });
    expect(primalSymbolIdleClip(9)).toEqual({ animation: "idle", durationMs: 1_766.7 });
    expect(PRIMAL_SYMBOL7_AUXILIARY_IDLE_BREAKER).toEqual({
      animation: "idle_breaker",
      durationMs: 2_000,
      scheduledByGameIdleController: false,
    });
  });

  it("guarantees one-at-a-time cabinet idles by authored timing", () => {
    expect(PRIMAL_SYMBOL_IDLE_MAX_DURATION_MS).toBe(3_533.334);
    expect(PRIMAL_SYMBOL_IDLE_MIN_RESTART_GAP_MS).toBe(4_375);
    expect(PRIMAL_SYMBOL_IDLE_MIN_RESTART_GAP_MS).toBeGreaterThan(
      PRIMAL_SYMBOL_IDLE_MAX_DURATION_MS,
    );
  });

  it("pauses scheduling for spin, win, structural, and Rage presentations", () => {
    const idle = {
      dormant: false,
      spinActive: false,
      winPresentationActive: false,
      structuralTransitionActive: false,
      rageCascadeActive: false,
    };
    expect(primalSymbolIdleShouldRun(idle)).toBe(true);
    for (const key of [
      "dormant",
      "spinActive",
      "winPresentationActive",
      "structuralTransitionActive",
      "rageCascadeActive",
    ] as const) {
      expect(primalSymbolIdleShouldRun({ ...idle, [key]: true })).toBe(false);
    }
  });

  it("uses the original Fisher-Yates shuffle for all nine Rage cascade cells", () => {
    expect(primalRageCascadeCellOrder(() => 0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 0]);
    expect(primalRageCascadeCellOrder(() => 0.999_999)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(primalRageCascadeCellOrder(() => 0.42))).toEqual(
      new Set([0, 1, 2, 3, 4, 5, 6, 7, 8]),
    );
  });

  it("keeps exact reel brake, bounce, expansion, and main Spine durations", () => {
    expect(PRIMAL_REEL_TIMING_MS).toMatchObject({
      acceleration: 300,
      firstBrake: 1_500,
      brake: 300,
      bounce: 350,
      reelGap: 300,
    });
    expect(PRIMAL_REEL_SETTLE_MS).toBe(650);
    expect(PRIMAL_REEL_IMPACT_PROGRESS).toBeCloseTo(300 / 650, 12);
    expect(PRIMAL_EXPANSION_TIMING_MS).toMatchObject({ controllerDelay: 450, resize: 1_000 });
    expect(PRIMAL_SYMBOL_ANIMATION_MS[7].idle).toBeCloseTo(3_533.334);
    expect(PRIMAL_SYMBOL_ANIMATION_MS[8].unlockBackup).toBe(1_500);
    expect(PRIMAL_CHARACTER_ANIMATION_MS.intro).toBeCloseTo(8_066.701);
    expect(PRIMAL_FEATURE_ANIMATION_MS.wheel.selectionDeceleration).toBe(8_800);
    expect(PRIMAL_FEATURE_ANIMATION_MS.rageCascade).toMatchObject({
      swing: 390,
      respinShakeDelay: 400,
      perCellExplosion: 60,
      explosionCells: 9,
      cooldown: 500,
      pound: 390,
      poundShakeDelay: 500,
      activationHold: 2_300,
      total: 4_120,
    });
  });
});
