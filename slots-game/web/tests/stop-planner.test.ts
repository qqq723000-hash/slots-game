import { describe, expect, it } from "vitest";
import { createStopPlan } from "../src/reels/stopPlanner";

describe("createStopPlan", () => {
  it("uses the captured 2.75s normal-spin cadence by default", () => {
    const plan = createStopPlan(3);
    expect(plan).toEqual([
      { reel: 0, delayMs: 1500, settleMs: 650 },
      { reel: 1, delayMs: 1800, settleMs: 650 },
      { reel: 2, delayMs: 2100, settleMs: 650 },
    ]);
    expect((plan[2]?.delayMs ?? 0) + (plan[2]?.settleMs ?? 0)).toBe(2750);
  });

  it("plans left-to-right server-result stops with stable timing", () => {
    expect(createStopPlan(3, { firstDelayMs: 100, reelGapMs: 150, settleMs: 200 })).toEqual([
      { reel: 0, delayMs: 100, settleMs: 200 },
      { reel: 1, delayMs: 250, settleMs: 200 },
      { reel: 2, delayMs: 400, settleMs: 200 },
    ]);
  });

  it("rejects an invalid reel count", () => {
    expect(() => createStopPlan(0)).toThrow(/positive integer/);
  });
});
