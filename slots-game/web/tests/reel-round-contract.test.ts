import { describe, expect, it, vi } from "vitest";
import type { SpinResult } from "../src/app/state/types";
import {
  authoritativeReelRoundFromV1,
  type ReelPresentationData,
  type SpinResultJSONV2,
  type SpinStripVisualSource,
} from "../src/reels/reelRoundContract";

function spinResult(grid: SpinResult["grid"]): SpinResult {
  return {
    type: "spin.result",
    protocolVersion: 1,
    requestId: "request-1",
    sessionId: "session-1",
    roundId: "round-1",
    sequence: 1,
    betMinor: "100",
    chargedBetMinor: "100",
    balanceMinor: "9900",
    totalWinMinor: "0",
    grid,
    wins: [],
    events: [],
    featureState: {
      mode: "BASE",
      freeSpinsRemaining: 0,
      rageLevel: 1,
      rageCollected: 0,
    },
  };
}

const baseGrid: SpinResult["grid"] = Array.from({ length: 3 }, () => [
  { symbol: "ORBIT" },
  { symbol: "PRISM" },
  { symbol: "PULSE" },
]);

describe("authoritative reel round contract", () => {
  it("adapts protocol v1 without inventing strip stops", () => {
    const result = spinResult(baseGrid);
    const round = authoritativeReelRoundFromV1(result);

    expect(round).toMatchObject({
      roundId: "round-1",
      rows: 3,
      totalWinMinor: "0",
      reelPresentation: undefined,
    });
    expect(round.grid).toEqual(result.grid);
    expect(round.grid).not.toBe(result.grid);
    expect(Object.isFrozen(round)).toBe(true);
    expect(Object.isFrozen(round.grid[0]?.[0])).toBe(true);
  });

  it("adapts and freezes protocol v1 when the browser has no structuredClone", () => {
    const result = spinResult(baseGrid);
    const originalGrid = result.grid;
    vi.stubGlobal("structuredClone", undefined);
    try {
      const round = authoritativeReelRoundFromV1(result);

      expect(round.grid).toEqual(originalGrid);
      expect(round.grid).not.toBe(originalGrid);
      expect(round.grid[0]).not.toBe(originalGrid[0]);
      expect(round.grid[0]?.[0]).not.toBe(originalGrid[0]?.[0]);
      expect(Object.isFrozen(round.grid)).toBe(true);
      expect(Object.isFrozen(round.grid[0])).toBe(true);
      expect(Object.isFrozen(round.grid[0]?.[0])).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects malformed grids at the presentation boundary", () => {
    expect(() => authoritativeReelRoundFromV1(spinResult([[{ symbol: "ORBIT" }]])))
      .toThrow("malformed authoritative reel grid");
    expect(() => authoritativeReelRoundFromV1(spinResult([
      baseGrid[0]!,
      baseGrid[1]!,
      [...baseGrid[2]!, { symbol: "TANK" }],
    ]))).toThrow("malformed authoritative reel grid");
  });

  it("reserves typed backend strip references while keeping stop choice server-owned", async () => {
    const reelPresentation: ReelPresentationData = {
      stripSet: { stripSetId: "base-a", version: "2026-07-29" },
      stops: [
        { reel: 0, stripId: "base-a-r0", stopIndex: 12 },
        { reel: 1, stripId: "base-a-r1", stopIndex: 41 },
        { reel: 2, stripId: "base-a-r2", stopIndex: 7 },
      ],
    };
    const v1 = spinResult(baseGrid);
    const { protocolVersion: _v1, ...wireBody } = v1;
    const v2: SpinResultJSONV2 = {
      ...wireBody,
      protocolVersion: 2,
      reelPresentation,
    };
    const visualSource: SpinStripVisualSource = {
      loadStripSet: async (reference) => ({
        reference,
        reels: [
          { stripId: "base-a-r0", symbols: ["ORBIT", "PRISM"] },
          { stripId: "base-a-r1", symbols: ["PRISM", "WILD"] },
          { stripId: "base-a-r2", symbols: ["PULSE", "SURGE"] },
        ],
      }),
    };

    expect(v2.reelPresentation.stops.map(({ stopIndex }) => stopIndex)).toEqual([12, 41, 7]);
    await expect(visualSource.loadStripSet(v2.reelPresentation.stripSet)).resolves.toMatchObject({
      reference: { stripSetId: "base-a" },
      reels: [
        { stripId: "base-a-r0" },
        { stripId: "base-a-r1" },
        { stripId: "base-a-r2" },
      ],
    });
  });
});
