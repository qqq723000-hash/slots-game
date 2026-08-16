import { describe, expect, it } from "vitest";
import {
  didFeatureModeEnd,
  freeSpinAutoplayDelay,
  shouldScheduleFreeSpin,
} from "../src/app/freeSpinAutoplay";

describe("free-spin autoplay gate", () => {
  const ready = {
    mode: "EXPANSION" as const,
    remaining: 8,
    online: true,
    canSpin: true,
    pendingSpin: false,
    destroyed: false,
  };

  it("queues only an active authoritative free-spin state", () => {
    expect(shouldScheduleFreeSpin(ready)).toBe(true);
    expect(shouldScheduleFreeSpin({ ...ready, mode: "BASE" })).toBe(false);
    expect(shouldScheduleFreeSpin({ ...ready, remaining: 0 })).toBe(false);
  });

  it("stops at connection, state-machine, transport, and lifecycle gates", () => {
    expect(shouldScheduleFreeSpin({ ...ready, online: false })).toBe(false);
    expect(shouldScheduleFreeSpin({ ...ready, canSpin: false })).toBe(false);
    expect(shouldScheduleFreeSpin({ ...ready, pendingSpin: true })).toBe(false);
    expect(shouldScheduleFreeSpin({ ...ready, destroyed: true })).toBe(false);
  });

  it("keeps a readable normal delay and shortens only presentation under reduced motion", () => {
    expect(freeSpinAutoplayDelay(false)).toBe(300);
    expect(freeSpinAutoplayDelay(true)).toBe(120);
  });

  it("contracts only on an authoritative active-mode to base transition", () => {
    expect(didFeatureModeEnd(
      { mode: "EXPANSION", freeSpinsRemaining: 1, rageLevel: 1, rageCollected: 0 },
      { mode: "BASE", freeSpinsRemaining: 0, rageLevel: 1, rageCollected: 0 },
    )).toBe(true);
    expect(didFeatureModeEnd(
      { mode: "OVERDRIVE", freeSpinsRemaining: 1, rageLevel: 1, rageCollected: 0 },
      { mode: "BASE", freeSpinsRemaining: 0, rageLevel: 1, rageCollected: 0 },
    )).toBe(true);
    expect(didFeatureModeEnd(
      { mode: "BASE", freeSpinsRemaining: 0, rageLevel: 1, rageCollected: 0 },
      { mode: "BASE", freeSpinsRemaining: 0, rageLevel: 1, rageCollected: 0 },
    )).toBe(false);
    expect(didFeatureModeEnd(
      { mode: "EXPANSION", freeSpinsRemaining: 2, rageLevel: 1, rageCollected: 0 },
      { mode: "EXPANSION", freeSpinsRemaining: 1, rageLevel: 1, rageCollected: 0 },
    )).toBe(false);
    expect(didFeatureModeEnd(
      { mode: "BASE", freeSpinsRemaining: 0, rageLevel: 1, rageCollected: 0 },
      { mode: "EXPANSION", freeSpinsRemaining: 8, rageLevel: 1, rageCollected: 0 },
    )).toBe(false);
  });
});
