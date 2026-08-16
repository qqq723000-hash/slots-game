import { describe, expect, it } from "vitest";
import { canEnableSpin } from "../src/app/state/controlGate";

describe("control gate", () => {
  const open = { launchReady: true, gameReady: true, online: true, pendingSpin: false };

  it("requires both the launch and authoritative game-session gates", () => {
    expect(canEnableSpin(open)).toBe(true);
    expect(canEnableSpin({ ...open, launchReady: false })).toBe(false);
    expect(canEnableSpin({ ...open, gameReady: false })).toBe(false);
  });

  it("also closes while offline or while a round is pending", () => {
    expect(canEnableSpin({ ...open, online: false })).toBe(false);
    expect(canEnableSpin({ ...open, pendingSpin: true })).toBe(false);
  });
});
