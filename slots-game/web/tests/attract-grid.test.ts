import { describe, expect, it } from "vitest";
import {
  ATTRACT_GRID_LOCKED_VAULT_CELLS,
  createAttractGrid,
} from "../src/presentation/attractGrid";

describe("presentation-only attract grid", () => {
  it("returns a fresh, rectangular 3x3 display grid", () => {
    const first = createAttractGrid();
    const second = createAttractGrid();

    expect(first).toHaveLength(3);
    expect(first.every((reel) => reel.length === 3)).toBe(true);
    first[0]![0] = { symbol: "SURGE" };
    expect(second[0]![0]).toEqual({ symbol: "CIRCUIT" });
    expect(second[0]?.[1]).toEqual({ symbol: "NOVA" });
    expect(second[0]?.[2]).toEqual({ symbol: "ORBIT" });
    expect(second[1]?.[0]).toEqual({ symbol: "VAULT", prize: "GRAND", multiplier: 1_000 });
    expect(ATTRACT_GRID_LOCKED_VAULT_CELLS).toEqual([{ reel: 1, row: 0 }]);
    expect(Object.isFrozen(ATTRACT_GRID_LOCKED_VAULT_CELLS)).toBe(true);
    expect(Object.isFrozen(ATTRACT_GRID_LOCKED_VAULT_CELLS[0])).toBe(true);
    expect(second[1]?.[1]).toEqual({ symbol: "SURGE" });
    expect(second[1]?.[2]).toEqual({ symbol: "WILD", multiplier: 100 });
    expect(second[2]).toEqual([
      { symbol: "PRISM" },
      { symbol: "PULSE" },
      { symbol: "TANK" },
    ]);
  });
});
