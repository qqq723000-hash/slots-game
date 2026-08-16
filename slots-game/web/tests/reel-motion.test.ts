import { describe, expect, it } from "vitest";
import type { GridCell } from "../src/app/state/types";
import {
  createReelStopMotionPlan,
  createReelStopMotionPlanForMode,
  decorativeSpinCells,
  MAX_REEL_FRAME_DELTA_MS,
  PRIMAL_CAPTURED_VISUAL_STRIP_IDS,
  PRIMAL_REEL_SPIN_SPEED_ROWS_PER_MS,
  PRIMAL_REEL_STOP_MOTION_CONFIG,
  REEL_ACCELERATION_MS,
  REEL_PRESENTATION_FIRST_VIEW_ROW,
  reelBlurForVelocity,
  reelDistanceAt,
  reelPositionRowsAt,
  reelPresentationCells,
  reelSettleFrame,
  reelSpinProfile,
  reelStartPositionDeltaRowsAt,
  reelStartVelocityRowsAt,
  reelStopMotionConfig,
  reelStopHasReachedImpact,
  reelStopPositionRowsAt,
  reelStopVelocityRowsAt,
  reelVelocityAt,
} from "../src/reels/reelMotion";
import {
  PRIMAL_FAST_REEL_IMPACT_PROGRESS,
  PRIMAL_REEL_IMPACT_PROGRESS,
} from "../src/reels/primalAnimationTiming";

describe("reel cruise motion", () => {
  it("caps a stalled renderer frame at five official 30fps ticks", () => {
    expect(MAX_REEL_FRAME_DELTA_MS).toBe((5 / 30) * 1_000);
    expect(Math.min(MAX_REEL_FRAME_DELTA_MS, 1_000)).toBeCloseTo(1_000 / 6, 10);
  });

  it("matches the captured 300ms row-space start curve before cruising", () => {
    const profile = reelSpinProfile(0);

    expect(PRIMAL_REEL_SPIN_SPEED_ROWS_PER_MS).toBe(0.02);
    expect(reelStartPositionDeltaRowsAt(0, profile)).toBe(0);
    expect(reelStartPositionDeltaRowsAt(150, profile)).toBeCloseTo(0.75, 10);
    expect(reelStartPositionDeltaRowsAt(300, profile)).toBeCloseTo(3, 10);
    expect(reelStartPositionDeltaRowsAt(450, profile)).toBeCloseTo(6, 10);

    expect(reelStartVelocityRowsAt(0, profile)).toBe(0);
    expect(reelStartVelocityRowsAt(150, profile)).toBeCloseTo(0.01, 10);
    expect(reelStartVelocityRowsAt(300, profile)).toBeCloseTo(0.02, 10);
    expect(reelStartVelocityRowsAt(450, profile)).toBeCloseTo(0.02, 10);
  });

  it("linearly accelerates every axis together for the captured 300ms", () => {
    const first = reelSpinProfile(0);
    const second = reelSpinProfile(1);
    const third = reelSpinProfile(2);

    expect(reelVelocityAt(0, first)).toBe(0);
    expect(REEL_ACCELERATION_MS).toBe(300);
    expect(reelVelocityAt(REEL_ACCELERATION_MS / 2, first)).toBeCloseTo(
      reelVelocityAt(REEL_ACCELERATION_MS, first) / 2,
    );
    expect(reelVelocityAt(1000, first)).toBeCloseTo(reelVelocityAt(1000, second));
    expect(reelVelocityAt(1000, second)).toBeCloseTo(reelVelocityAt(1000, third));
    expect([first, second, third].every((profile) => (
      profile.startDelayMs === 0
      && profile.speedMultiplier === 1
      && profile.phaseOffsetRows === 0
    ))).toBe(true);
  });

  it("derives blur from velocity and yields the same position at common elapsed time across frame rates", () => {
    const profile = reelSpinProfile(1);
    const cruise = reelVelocityAt(1000, profile);
    expect(reelBlurForVelocity(0, profile)).toBeLessThan(reelBlurForVelocity(cruise, profile));

    const elapsedAtRate = (frameMs: number, frames: number): number => {
      let elapsed = 0;
      for (let frame = 0; frame < frames; frame += 1) elapsed += Math.min(MAX_REEL_FRAME_DELTA_MS, frameMs);
      return reelDistanceAt(elapsed, profile);
    };
    expect(elapsedAtRate(1000 / 30, 30)).toBeCloseTo(elapsedAtRate(1000 / 60, 60), 8);
    expect(elapsedAtRate(1000 / 60, 60)).toBeCloseTo(elapsedAtRate(1000 / 120, 120), 8);
  });

  it("continues spinner position across rounds until a strip selection resets it", () => {
    const profile = reelSpinProfile(0);
    const firstRoundEnd = reelPositionRowsAt(17.25, 1_000, 140, profile);
    const secondRoundStart = reelPositionRowsAt(firstRoundEnd, 0, 140, profile);
    const secondRoundLater = reelPositionRowsAt(firstRoundEnd, 300, 140, profile);

    expect(secondRoundStart).toBe(firstRoundEnd);
    expect(secondRoundLater).toBeGreaterThan(secondRoundStart);
    expect(reelPositionRowsAt(0, 0, 140, profile)).toBe(0);
  });

  it("builds a deterministic cosmetic strip for any 3-8 row layout without relying on the last result", () => {
    const threeRows = decorativeSpinCells(0, 5);
    const eightRows = decorativeSpinCells(0, 10);
    expect(threeRows).toHaveLength(5);
    expect(eightRows).toHaveLength(10);
    expect(eightRows.slice(0, 5)).toEqual(threeRows);
    expect(decorativeSpinCells(1, 10)).not.toEqual(eightRows);
    expect(eightRows.every((cell) => cell.multiplier === undefined)).toBe(true);
  });

  it("preserves the three captured Base, King Spin, and Kong Quest strip sets", () => {
    expect(PRIMAL_CAPTURED_VISUAL_STRIP_IDS.BASE.map((strip) => strip.length)).toEqual([47, 47, 47]);
    expect(PRIMAL_CAPTURED_VISUAL_STRIP_IDS.OVERDRIVE.map((strip) => strip.length)).toEqual([35, 35, 35]);
    expect(PRIMAL_CAPTURED_VISUAL_STRIP_IDS.EXPANSION.map((strip) => strip.length)).toEqual([35, 35, 35]);

    expect(PRIMAL_CAPTURED_VISUAL_STRIP_IDS.BASE[0].slice(0, 9)).toEqual([
      0, 3, 0, 0, 0, 4, 4, 3, 15,
    ]);
    expect(PRIMAL_CAPTURED_VISUAL_STRIP_IDS.BASE[1].filter((id) => id === 17)).toHaveLength(13);
    expect(PRIMAL_CAPTURED_VISUAL_STRIP_IDS.OVERDRIVE[1].filter((id) => id === 32)).toHaveLength(7);
    expect(PRIMAL_CAPTURED_VISUAL_STRIP_IDS.EXPANSION[1].filter((id) => id === 17)).toHaveLength(14);
    expect(PRIMAL_CAPTURED_VISUAL_STRIP_IDS.OVERDRIVE.flat()).not.toContain(15);
    expect(PRIMAL_CAPTURED_VISUAL_STRIP_IDS.EXPANSION.flat()).not.toContain(15);

    expect(decorativeSpinCells(1, 7, 0, "BASE").map((cell) => cell.symbol)).toEqual([
      "SURGE", "PULSE", "ORBIT", "PRISM", "WILD", "PULSE", "VAULT",
    ]);
    expect(decorativeSpinCells(1, 7, 0, "OVERDRIVE")).not.toEqual(
      decorativeSpinCells(1, 7, 0, "EXPANSION"),
    );
  });

  it("rotates identities at whole-cell wraps so downward screen positions remain continuous for 3-8 rows", () => {
    for (const mode of ["BASE", "OVERDRIVE", "EXPANSION"] as const) {
      for (let rows = 3; rows <= 8; rows += 1) {
        for (let reel = 0; reel < 3; reel += 1) {
          const beforeWrap = decorativeSpinCells(reel, rows + 2, 17, mode);
          const afterWrap = decorativeSpinCells(reel, rows + 2, 18, mode);
    // 即将回绕时，视图 j 位于 phase 归零后视图 j+1 所占的屏幕位置。
          for (let index = 0; index < beforeWrap.length - 1; index += 1) {
            expect(afterWrap[index + 1]).toEqual(beforeWrap[index]);
          }
        }
      }
    }
  });
});

describe("authoritative result insertion into one travelling belt", () => {
  const resultCells: GridCell[] = [
    { symbol: "WILD", multiplier: 100 },
    { symbol: "VAULT", multiplier: 20, prize: "MINI_2X" },
    { symbol: "SURGE" },
  ];
  const insertion = { targetWholeRows: 23, cells: resultCells } as const;
  const indexForViewRow = (viewRow: number): number => (
    viewRow - REEL_PRESENTATION_FIRST_VIEW_ROW
  );

  it("starts the result above the clip and lands it exactly in visible rows", () => {
    const atStopStart = reelPresentationCells(1, 3, 17, insertion, "BASE");
    const atImpact = reelPresentationCells(1, 3, 23, insertion, "BASE");
    const firstVisible = indexForViewRow(1);

    expect(REEL_PRESENTATION_FIRST_VIEW_ROW).toBe(-5);
    expect(atStopStart.slice(0, resultCells.length)).toEqual(resultCells);
    expect(atStopStart.slice(firstVisible, firstVisible + 3)).not.toEqual(resultCells);
    expect(atImpact.slice(firstVisible, firstVisible + 3)).toEqual(resultCells);
  });

  it("preserves inserted identity at every whole-cell wrap without mutating server cells", () => {
    for (let whole = 17; whole < 23; whole += 1) {
      const before = reelPresentationCells(1, 3, whole, insertion, "BASE");
      const after = reelPresentationCells(1, 3, whole + 1, insertion, "BASE");
      for (let index = 0; index < before.length - 1; index += 1) {
        expect(after[index + 1]).toEqual(before[index]);
      }
    }

    const sample = reelPresentationCells(1, 3, 23, insertion, "BASE");
    sample[indexForViewRow(1)]!.multiplier = 2;
    expect(resultCells[0]).toEqual({ symbol: "WILD", multiplier: 100 });
    expect(reelPresentationCells(1, 3, 23, insertion, "BASE")).toEqual(
      reelPresentationCells(1, 3, 23, insertion, "BASE"),
    );
  });

  it("uses the same logical insertion coordinates for every supported height", () => {
    for (let rows = 3; rows <= 8; rows += 1) {
      const cells = Array.from({ length: rows }, (_, row): GridCell => ({
        symbol: row % 2 === 0 ? "PULSE" : "NOVA",
        multiplier: row + 2,
      }));
      const targetWholeRows = 41;
      const atImpact = reelPresentationCells(
        0,
        rows,
        targetWholeRows,
        { targetWholeRows, cells },
        "EXPANSION",
      );
      const firstVisible = indexForViewRow(1);
      expect(atImpact.slice(firstVisible, firstVisible + rows)).toEqual(cells);
    }
  });
});

describe("continuous reel stop position", () => {
  it("exposes the immutable captured NORMAL, FAST, and SLOW configurations", () => {
    expect(PRIMAL_REEL_STOP_MOTION_CONFIG).toEqual({
      NORMAL: {
        brakeMs: 300,
        advanceRows: 5,
        endVelocityRowsPerMs: 0.0015,
        bounceMs: 350,
        totalMs: 650,
      },
      FAST: {
        brakeMs: 300,
        advanceRows: 5,
        endVelocityRowsPerMs: 0.0015,
        bounceMs: 250,
        totalMs: 550,
      },
      SLOW: {
        brakeMs: 3_000,
        advanceRows: 18,
        endVelocityRowsPerMs: 0,
        bounceMs: 0,
        totalMs: 3_000,
      },
    });
    expect(reelStopMotionConfig("NORMAL")).toBe(PRIMAL_REEL_STOP_MOTION_CONFIG.NORMAL);
  });

  it("builds NORMAL and FAST plans from explicit modes", () => {
    const normal = createReelStopMotionPlanForMode(17.25, 0.02, "NORMAL");
    const fast = createReelStopMotionPlanForMode(17.25, 0.02, "FAST");

    expect(normal).toMatchObject({
      targetRows: 23,
      brakeMs: 300,
      bounceMs: 350,
      totalMs: 650,
      endVelocityRowsPerMs: 0.0015,
    });
    expect(fast).toMatchObject({
      targetRows: 23,
      brakeMs: 300,
      bounceMs: 250,
      totalMs: 550,
      endVelocityRowsPerMs: 0.0015,
    });
  });

  it("uses an 18-row, bounce-free 3000ms SLOW stop", () => {
    const plan = createReelStopMotionPlanForMode(17.25, 0.02, "SLOW");

    expect(plan).toMatchObject({
      startRows: 17.25,
      targetRows: 36,
      startVelocityRowsPerMs: 0.02,
      endVelocityRowsPerMs: 0,
      brakeMs: 3_000,
      bounceMs: 0,
      totalMs: 3_000,
    });
    expect(reelStopPositionRowsAt(plan, 0)).toBe(17.25);
    expect(reelStopPositionRowsAt(plan, 1_500)).not.toBe(36);
    expect(reelStopPositionRowsAt(plan, 3_000)).toBe(36);
    expect(reelStopVelocityRowsAt(plan, 3_000)).toBe(0);
  });

  it("joins the 300ms brake and 350ms bounce without a position or velocity reset", () => {
    const plan = createReelStopMotionPlan(17.25, 0.02, 650);

    expect(plan).toMatchObject({
      startRows: 17.25,
      targetRows: 23,
      brakeMs: 300,
      bounceMs: 350,
      totalMs: 650,
    });
    expect(reelStopPositionRowsAt(plan, 0)).toBe(17.25);
    expect(reelStopPositionRowsAt(plan, 300)).toBe(23);
    expect(reelStopPositionRowsAt(plan, 300 + 350 / 3)).toBeCloseTo(
      23 + 0.077_777_778,
      8,
    );
    expect(reelStopPositionRowsAt(plan, 650)).toBe(23);

    const epsilonMs = 0.001;
    expect(reelStopPositionRowsAt(plan, 300 - epsilonMs)).toBeCloseTo(23, 5);
    expect(reelStopPositionRowsAt(plan, 300 + epsilonMs)).toBeCloseTo(23, 5);
    expect(reelStopVelocityRowsAt(plan, 300 - epsilonMs)).toBeCloseTo(0.0015, 5);
    expect(reelStopVelocityRowsAt(plan, 300 + epsilonMs)).toBeCloseTo(0.0015, 5);
  });

  it("keeps FAST at 300ms brake plus 250ms bounce and the same integer lock", () => {
    const plan = createReelStopMotionPlan(17.25, 0.02, 550);

    expect(plan).toMatchObject({ targetRows: 23, brakeMs: 300, bounceMs: 250, totalMs: 550 });
    expect(reelStopPositionRowsAt(plan, 299)).not.toBe(23);
    expect(reelStopPositionRowsAt(plan, 300)).toBe(23);
    expect(reelStopPositionRowsAt(plan, 300 + 250 / 3)).toBeCloseTo(
      23 + 0.055_555_556,
      8,
    );
    expect(reelStopPositionRowsAt(plan, 550)).toBe(23);
    expect(reelStopVelocityRowsAt(plan, 550)).toBe(0);
  });
});

describe("normalized reel braking", () => {
  it("does not expose the settled overlay before the visual brake reaches target", () => {
    const plan = createReelStopMotionPlanForMode(17.25, 0.02, "NORMAL");

    expect(reelStopHasReachedImpact(plan, 299.999)).toBe(false);
    expect(reelStopHasReachedImpact(plan, 300)).toBe(true);
    expect(reelStopHasReachedImpact(plan, Number.POSITIVE_INFINITY)).toBe(true);
  });

  it("brakes for 300ms, performs the measured positive cubic bounce, and locks", () => {
    const beforeReveal = reelSettleFrame(PRIMAL_REEL_IMPACT_PROGRESS * 0.7, 100);
    const impact = reelSettleFrame(PRIMAL_REEL_IMPACT_PROGRESS, 100);
    const bouncePeakProgress = PRIMAL_REEL_IMPACT_PROGRESS
      + (1 - PRIMAL_REEL_IMPACT_PROGRESS) / 3;
    const bouncePeak = reelSettleFrame(bouncePeakProgress, 100);
    const locked = reelSettleFrame(1, 100);

    expect(beforeReveal.motionAlpha).toBe(1);
    expect(beforeReveal.resultAlpha).toBe(0);
    expect(impact).toMatchObject({ motionAlpha: 1, resultAlpha: 0 });
    expect(bouncePeak).toMatchObject({ motionAlpha: 1, resultAlpha: 0 });
    expect(impact.resultOffset).toBe(0);
    expect(impact.impactAlpha).toBe(1);
    expect(bouncePeak.resultOffset).toBeCloseTo(100 * 0.077_777_778, 6);
    expect(bouncePeak.resultOffset).toBeGreaterThan(0);
    expect(locked).toMatchObject({
      motionAlpha: 0,
      motionOffset: 0,
      resultAlpha: 1,
      resultOffset: 0,
      resultScaleY: 1,
      resultBlurY: 0,
      impactAlpha: 0,
    });
    for (const progress of [0, 0.2, PRIMAL_REEL_IMPACT_PROGRESS, 0.7, 0.99, 1]) {
      const frame = reelSettleFrame(progress, 100);
      expect(frame.motionAlpha * frame.resultAlpha).toBe(0);
      expect(frame.motionAlpha + frame.resultAlpha).toBe(1);
    }
  });

  it("keeps settle displacement proportional at three and eight rows", () => {
    const threeRowCell = 350 / 3;
    const eightRowCell = 350 / 8;
    const bouncePeakProgress = PRIMAL_REEL_IMPACT_PROGRESS
      + (1 - PRIMAL_REEL_IMPACT_PROGRESS) / 3;
    const threeRowImpact = reelSettleFrame(bouncePeakProgress, threeRowCell).resultOffset;
    const eightRowImpact = reelSettleFrame(bouncePeakProgress, eightRowCell).resultOffset;
    expect(threeRowImpact / threeRowCell).toBeCloseTo(0.077_777_778);
    expect(eightRowImpact / eightRowCell).toBeCloseTo(0.077_777_778);
  });

  it("keeps a 300ms brake when FAST shortens only the bounce to 250ms", () => {
    const beforeImpact = reelSettleFrame(299 / 550, 100, PRIMAL_FAST_REEL_IMPACT_PROGRESS);
    const impact = reelSettleFrame(300 / 550, 100, PRIMAL_FAST_REEL_IMPACT_PROGRESS);
    const bouncePeak = reelSettleFrame(
      PRIMAL_FAST_REEL_IMPACT_PROGRESS + (1 - PRIMAL_FAST_REEL_IMPACT_PROGRESS) / 3,
      100,
      PRIMAL_FAST_REEL_IMPACT_PROGRESS,
    );
    const locked = reelSettleFrame(1, 100, PRIMAL_FAST_REEL_IMPACT_PROGRESS);

    expect(beforeImpact.motionAlpha).toBeLessThanOrEqual(1);
    expect(impact.resultOffset).toBe(0);
    expect(impact.impactAlpha).toBe(1);
    expect(bouncePeak.resultOffset).toBeCloseTo(100 * 0.055_555_556, 6);
    expect(locked.resultOffset).toBe(0);
  });
});
