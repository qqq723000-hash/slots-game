import { describe, expect, it } from "vitest";
import {
  NORMAL_WIN_COUNTER_MAX_MS,
  NORMAL_WIN_COUNTER_TAIL_HOLD_MS,
  isCelebratoryWin,
  isWinLossOrEqual,
  normalWinCounterDurationMs,
  parseJackpotTier,
  planPayoutAudio,
  planReelLandAudio,
} from "../src/app/roundAudioPlan";
import type { GridCell } from "../src/app/state/types";

describe("round payout audio plan", () => {
  it("uses the captured 500ms-per-multiplier normal counter clock", () => {
    expect(normalWinCounterDurationMs("1", "100")).toBe(100);
    expect(normalWinCounterDurationMs("50", "100")).toBe(250);
    expect(normalWinCounterDurationMs("100", "100")).toBe(500);
    expect(normalWinCounterDurationMs("101", "100")).toBe(505);
    expect(normalWinCounterDurationMs("250", "100")).toBe(1_250);
    expect(normalWinCounterDurationMs("600", "100")).toBe(3_000);
    expect(normalWinCounterDurationMs("1000", "100")).toBe(NORMAL_WIN_COUNTER_MAX_MS);
    expect(normalWinCounterDurationMs("1001", "100")).toBe(NORMAL_WIN_COUNTER_MAX_MS);
    expect(normalWinCounterDurationMs("0", "100")).toBeNull();
    expect(normalWinCounterDurationMs("100", "0")).toBeNull();
    expect(NORMAL_WIN_COUNTER_TAIL_HOLD_MS).toBe(500);
  });

  it("halves Fast Play before applying the official 100..5000ms clamp", () => {
    expect(normalWinCounterDurationMs("1", "100", true)).toBe(100);
    expect(normalWinCounterDurationMs("100", "100", true)).toBe(250);
    expect(normalWinCounterDurationMs("1900", "100", false)).toBe(5_000);
    expect(normalWinCounterDurationMs("1900", "100", true)).toBe(4_750);
  });

  it("uses the strict original BetLossController celebratory boundary", () => {
    expect(isWinLossOrEqual("1", "100")).toBe(true);
    expect(isWinLossOrEqual("100", "100")).toBe(true);
    expect(isWinLossOrEqual("101", "100")).toBe(false);
    expect(isWinLossOrEqual("0", "100")).toBe(false);
    expect(isCelebratoryWin("1", "100")).toBe(false);
    expect(isCelebratoryWin("100", "100")).toBe(false);
    expect(isCelebratoryWin("101", "100")).toBe(true);
  });

  it("does not counterfeit a celebratory tier below two times bet", () => {
    expect(planPayoutAudio("1", "100")).toBeNull();
    expect(planPayoutAudio("199", "100")).toBeNull();
  });

  it("maps exact and in-between payout ratios to Win1 through Win8", () => {
    expect(planPayoutAudio("200", "100")).toEqual({ level: 1, intensity: 1 });
    expect(planPayoutAudio("299", "100")).toEqual({ level: 1, intensity: 1 });
    expect(planPayoutAudio("300", "100")).toEqual({ level: 2, intensity: 1 });
    expect(planPayoutAudio("400", "100")).toEqual({ level: 3, intensity: 1 });
    expect(planPayoutAudio("500", "100")).toEqual({ level: 4, intensity: 1 });
    expect(planPayoutAudio("600", "100")).toEqual({ level: 5, intensity: 1 });
    expect(planPayoutAudio("700", "100")).toEqual({ level: 6, intensity: 1 });
    expect(planPayoutAudio("800", "100")).toEqual({ level: 7, intensity: 1 });
    expect(planPayoutAudio("899", "100")).toEqual({ level: 7, intensity: 1 });
    expect(planPayoutAudio("900", "100")).toEqual({ level: 8, intensity: 1 });
    expect(planPayoutAudio("99999999999999999999", "1")).toEqual({ level: 8, intensity: 1 });
  });

  it("rejects zero or malformed authoritative money values", () => {
    for (const [total, bet] of [
      ["0", "100"],
      ["100", "0"],
      ["-1", "100"],
      ["1.00", "100"],
      ["01", "100"],
      ["100", " 100"],
      ["100000000000000000000", "1"],
    ] as const) {
      expect(planPayoutAudio(total, bet)).toBeNull();
    }
  });
});

describe("authoritative reel land audio plan", () => {
  it("keeps SURGE and WILD cues in row order and threads the scatter ordinal", () => {
    const cells: readonly GridCell[] = [
      { symbol: "SURGE", multiplier: 2 },
      { symbol: "WILD" },
      { symbol: "TANK" },
      { symbol: "SURGE", multiplier: 5 },
      { symbol: "WILD" },
    ];

    expect(planReelLandAudio(cells, 1)).toEqual({
      events: [
        { kind: "scatter-land", row: 0, ordinal: 2 },
        { kind: "wild-land", row: 1 },
        { kind: "scatter-land", row: 3, ordinal: 3 },
        { kind: "wild-land", row: 4 },
      ],
      nextScatterOrdinal: 3,
    });
    expect(cells).toEqual([
      { symbol: "SURGE", multiplier: 2 },
      { symbol: "WILD" },
      { symbol: "TANK" },
      { symbol: "SURGE", multiplier: 5 },
      { symbol: "WILD" },
    ]);
  });

  it("caps ScatterLand at five across later reels", () => {
    const cells: readonly GridCell[] = [
      { symbol: "SURGE" },
      { symbol: "SURGE" },
      { symbol: "SURGE" },
    ];
    expect(planReelLandAudio(cells, 4)).toEqual({
      events: [
        { kind: "scatter-land", row: 0, ordinal: 5 },
        { kind: "scatter-land", row: 1, ordinal: 5 },
        { kind: "scatter-land", row: 2, ordinal: 5 },
      ],
      nextScatterOrdinal: 5,
    });
  });

  it("normalizes an invalid incoming ordinal without inventing cues", () => {
    expect(planReelLandAudio([{ symbol: "ORBIT" }], Number.NaN)).toEqual({
      events: [],
      nextScatterOrdinal: 0,
    });
  });
});

describe("jackpot tier parsing", () => {
  it.each([
    ["MINI", "mini"],
    ["MINOR", "minor"],
    ["MAJOR", "major"],
    ["MEGA", "mega"],
    ["GRAND", "grand"],
    ["MINI_2X", "mini"],
    ["GRAND_2X", "grand"],
    ["major_2x", "major"],
  ] as const)("parses the explicit %s face", (prize, tier) => {
    expect(parseJackpotTier(prize)).toBe(tier);
  });

  it.each([
    undefined,
    null,
    "",
    "X1000",
    "SUPER_GRAND",
    "GRANDISH",
    "GRAND_3X",
    "GRAND_2X_EXTRA",
    " GRAND",
  ])("rejects unnamed or ambiguous prize %s", (prize) => {
    expect(parseJackpotTier(prize)).toBeNull();
  });
});
