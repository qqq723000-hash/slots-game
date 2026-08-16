import { describe, expect, it } from "vitest";
import { featureLockedBet, selectSessionBet } from "../src/app/state/betSelection";

const baseSession = {
  betOptionsMinor: ["100", "200", "500"],
  defaultBetMinor: "200",
  featureState: {
    mode: "BASE", freeSpinsRemaining: 0, rageLevel: 1, rageCollected: 0,
  } as const,
};

describe("bet selection", () => {
  it("uses the server default for the first opened session", () => {
    expect(selectSessionBet(baseSession, "100", false)).toBe("200");
  });

  it("preserves a valid player choice only on a resumed base session", () => {
    expect(selectSessionBet(baseSession, "500", true)).toBe("500");
  });

  it("forces the authoritative base bet throughout an active free-spin feature", () => {
    const featureState = {
      mode: "EXPANSION" as const,
      freeSpinsRemaining: 6,
      baseBetMinor: "500",
      rageLevel: 1,
      rageCollected: 0,
    };
    expect(selectSessionBet({ ...baseSession, featureState }, "100", true)).toBe("500");
    expect(featureLockedBet(featureState, "100")).toBe("500");
  });
});
