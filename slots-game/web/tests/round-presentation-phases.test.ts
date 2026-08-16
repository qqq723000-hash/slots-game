import { describe, expect, it } from "vitest";
import type { FeatureEvent } from "../src/app/state/types";
import {
  authoritativeWaysWinTotal,
  roundPresentationPhases,
} from "../src/app/roundPresentationPhases";

describe("round presentation phases", () => {
  it("keeps structural resize before reels and PPS/summary after Ways wins", () => {
    const events: readonly FeatureEvent[] = [
      { type: "grid.expanded", rows: 5, ways: 125 },
      { type: "free_spin.awarded", count: 1, reel: 1, row: 2 },
      {
        type: "free_spins.completed",
        mode: "EXPANSION",
        awarded: 9,
        cumulativeWinMinor: "12500",
      },
    ];

    const phases = roundPresentationPhases(events);

    expect(phases.postWinEvents).toEqual([events[1]]);
    expect(phases.summaryEvents).toEqual([events[2]]);
    expect(phases.postWinEvents[0]).toBe(events[1]);
    expect(phases.summaryEvents[0]).toBe(events[2]);
  });

  it("preserves ordinary server event order and never mutates the input", () => {
    const events: readonly FeatureEvent[] = [
      { type: "wheel.started" },
      { type: "wheel.awarded", outcome: "EXPANSION", prize: "KONG_QUEST" },
      { type: "free_spins.started", mode: "EXPANSION", awarded: 8 },
    ];

    const phases = roundPresentationPhases(events);

    expect(phases.postWinEvents).toEqual(events);
    expect(phases.postWinEvents).not.toBe(events);
    expect(phases.summaryEvents).toEqual([]);
    expect(events.map((event) => event.type)).toEqual([
      "wheel.started",
      "wheel.awarded",
      "free_spins.started",
    ]);
  });

  it("separates Ways money from explicit event awards without floating point", () => {
    expect(authoritativeWaysWinTotal([
      { amountMinor: "125" },
      { amountMinor: "375" },
      { amountMinor: "not-money" },
    ])).toBe("500");
    expect(authoritativeWaysWinTotal([])).toBe("0");
  });
});
