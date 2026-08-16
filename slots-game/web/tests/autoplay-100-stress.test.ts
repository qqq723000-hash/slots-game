import { describe, expect, it, vi } from "vitest";
import {
  DomOverlay,
  type SpinMode,
  isAutoplayFeatureOwnedSpinMode,
} from "../src/ui/DomOverlay";

interface AutoPlayStressInternals {
  autoplayActive: boolean;
  autoplayRemaining: number;
  autoplayRunGeneration: number;
  pendingPaidAutoplaySpin: unknown;
  autoplayTimer: ReturnType<typeof setTimeout> | null;
  autoplayModal: { dataset: { open: string } };
  spinMode: SpinMode;
  canSpin: boolean;
  syncAutoplayControl: ReturnType<typeof vi.fn>;
}

function createRun(remaining = 100, generation = 1): {
  readonly overlay: DomOverlay;
  readonly state: AutoPlayStressInternals;
} {
  const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
  const state = overlay as unknown as AutoPlayStressInternals;
  Object.assign(state, {
    autoplayActive: remaining > 0,
    autoplayRemaining: remaining,
    autoplayRunGeneration: generation,
    pendingPaidAutoplaySpin: null,
    autoplayTimer: null,
    autoplayModal: { dataset: { open: "false" } },
    spinMode: "ready" satisfies SpinMode,
    canSpin: true,
    syncAutoplayControl: vi.fn(),
  });
  return { overlay, state };
}

function reserveAndValidate(overlay: DomOverlay): void {
  overlay.commitAcceptedPaidAutoplaySpin();
  expect(overlay.finalizeAcceptedPaidAutoplaySpin()).toBe(true);
}

describe("100-spin Auto Play transaction stress", () => {
  it("settles exactly 100 accepted and validated paid rounds without underflow or a 101st spend", () => {
    const { overlay, state } = createRun();
    const projectedCounts: number[] = [];

    for (let ordinal = 1; ordinal <= 100; ordinal += 1) {
      overlay.commitAcceptedPaidAutoplaySpin();
      projectedCounts.push(state.autoplayRemaining);

      expect(state.autoplayRemaining).toBe(100 - ordinal);
      expect(state.autoplayRemaining).toBeGreaterThanOrEqual(0);
      expect(state.autoplayActive).toBe(ordinal < 100);
      expect(overlay.finalizeAcceptedPaidAutoplaySpin()).toBe(true);
      expect(overlay.finalizeAcceptedPaidAutoplaySpin()).toBe(false);
    }

    expect(projectedCounts).toEqual(Array.from({ length: 100 }, (_, index) => 99 - index));
    expect(state.autoplayActive).toBe(false);
    expect(state.autoplayRemaining).toBe(0);
    expect(state.syncAutoplayControl).toHaveBeenCalledTimes(100);

    // 次数耗尽后，迟到或重复的 ROUNDSTART 不能创建第 101 次旋转。
    overlay.commitAcceptedPaidAutoplaySpin();
    expect(overlay.finalizeAcceptedPaidAutoplaySpin()).toBe(false);
    expect(state.autoplayRemaining).toBe(0);
    expect(state.syncAutoplayControl).toHaveBeenCalledTimes(100);
  });

  it.each([
    ["terminal rejection", 1],
    ["malformed result", 1],
    ["terminal rejection", 50],
    ["malformed result", 50],
    ["terminal rejection", 100],
    ["malformed result", 100],
  ] as const)("restores the reservation for a %s at paid round %i and still completes", (_failure, faultAt) => {
    const { overlay, state } = createRun();
    let acceptedAttempts = 0;
    let validatedRounds = 0;
    let faultInjected = false;

    while (validatedRounds < 100) {
      const ordinal = validatedRounds + 1;
      const before = state.autoplayRemaining;
      acceptedAttempts += 1;
      overlay.commitAcceptedPaidAutoplaySpin();

      expect(state.autoplayRemaining).toBe(before - 1);
      expect(state.autoplayRemaining).toBeGreaterThanOrEqual(0);

      if (!faultInjected && ordinal === faultAt) {
        faultInjected = true;
        expect(overlay.rollbackAcceptedPaidAutoplaySpin()).toBe(true);
        expect(overlay.rollbackAcceptedPaidAutoplaySpin()).toBe(false);
        expect(state.autoplayRemaining).toBe(before);
        expect(state.autoplayActive).toBe(true);
        continue;
      }

      expect(overlay.finalizeAcceptedPaidAutoplaySpin()).toBe(true);
      validatedRounds += 1;
    }

    expect(faultInjected).toBe(true);
    expect(acceptedAttempts).toBe(101);
    expect(validatedRounds).toBe(100);
    expect(state.autoplayActive).toBe(false);
    expect(state.autoplayRemaining).toBe(0);
  });

  it("holds one reservation across retryable errors and deduplicates repeated acceptance callbacks", () => {
    const { overlay, state } = createRun();
    const retryableOrdinals = new Set([1, 50, 100]);

    for (let ordinal = 1; ordinal <= 100; ordinal += 1) {
      overlay.commitAcceptedPaidAutoplaySpin();
      const reservedCount = 100 - ordinal;
      expect(state.autoplayRemaining).toBe(reservedCount);

      if (retryableOrdinals.has(ordinal)) {
        // 可重试的传输错误会让这个已接受的请求保持待定。
        // 在校验结果到达前，重复观察到接受状态必须保持幂等。
        overlay.commitAcceptedPaidAutoplaySpin();
        overlay.commitAcceptedPaidAutoplaySpin();
        expect(state.autoplayRemaining).toBe(reservedCount);
      }

      expect(overlay.finalizeAcceptedPaidAutoplaySpin()).toBe(true);
    }

    expect(state.autoplayActive).toBe(false);
    expect(state.autoplayRemaining).toBe(0);
    expect(state.syncAutoplayControl).toHaveBeenCalledTimes(100);
  });

  it("does not revive a manually stopped run when a midpoint rollback arrives late", () => {
    const { overlay, state } = createRun(100, 17);

    for (let ordinal = 1; ordinal < 50; ordinal += 1) reserveAndValidate(overlay);
    expect(state.autoplayRemaining).toBe(51);

    overlay.commitAcceptedPaidAutoplaySpin();
    expect(state.autoplayRemaining).toBe(50);
    (overlay as unknown as { stopAutoplay(restoreFocus: boolean): void }).stopAutoplay(false);

    expect(state.autoplayRunGeneration).toBe(18);
    expect(state.autoplayActive).toBe(false);
    expect(state.autoplayRemaining).toBe(0);
    expect(overlay.rollbackAcceptedPaidAutoplaySpin()).toBe(false);
    expect(overlay.rollbackAcceptedPaidAutoplaySpin()).toBe(false);
    expect(state.autoplayActive).toBe(false);
    expect(state.autoplayRemaining).toBe(0);

    overlay.commitAcceptedPaidAutoplaySpin();
    expect(overlay.finalizeAcceptedPaidAutoplaySpin()).toBe(false);
    expect(state.autoplayRemaining).toBe(0);
  });

  it("keeps all Wheel and Free Spins control transitions outside the paid counter", () => {
    const { overlay, state } = createRun();
    const spinHandler = vi.fn();
    const fastStopHandler = vi.fn();
    const clearAutoplayTimer = vi.fn();
    Object.assign(state, { spinHandler, fastStopHandler, clearAutoplayTimer });

    const featureModes: readonly SpinMode[] = [
      "feature-continue",
      "free-spin-summary-continue",
      "cap-continue",
      "wheel-popup-continue",
      "wheel-ready",
      "wheel-summary-continue",
      "wheel-fast-stop",
      "wheel-landing-continue",
      "wheel-none",
    ];

    for (const mode of featureModes) {
      expect(isAutoplayFeatureOwnedSpinMode(mode)).toBe(true);
      state.spinMode = mode;
      (overlay as unknown as { handlePrimarySpinAction(): void }).handlePrimarySpinAction();
      expect(state.autoplayActive).toBe(true);
      expect(state.autoplayRemaining).toBe(100);
      expect(state.pendingPaidAutoplaySpin).toBeNull();
    }

    expect(clearAutoplayTimer).toHaveBeenCalledTimes(featureModes.length);
    expect(spinHandler).toHaveBeenCalledTimes(6);
    expect(fastStopHandler).toHaveBeenCalledTimes(1);

    // 只有下一个被接受的外层 Base ROUNDSTART 才会消耗一次付费次数。
    state.spinMode = "ready";
    overlay.commitAcceptedPaidAutoplaySpin();
    expect(state.autoplayRemaining).toBe(99);
    expect(overlay.finalizeAcceptedPaidAutoplaySpin()).toBe(true);
  });
});
