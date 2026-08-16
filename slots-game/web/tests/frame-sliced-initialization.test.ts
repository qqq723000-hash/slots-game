import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runFrameSlicedInitialization,
  waitForPaintedFrame,
  type FrameRequest,
} from "../src/startup/frameSlicedInitialization";
import {
  PRIMAL_PARTICLE_INIT_BATCH_SIZE,
  PRIMAL_PARTICLE_POOL_CAPACITY,
} from "../src/renderer/PrimalBackgroundParticles";

describe("runFrameSlicedInitialization", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("builds 4,100 entries in bounded batches separated by frames", async () => {
    const batches: Array<{ frame: number; start: number; count: number }> = [];
    const progress: number[] = [];
    let frame = 0;

    await runFrameSlicedInitialization(
      PRIMAL_PARTICLE_POOL_CAPACITY,
      (start, count) => batches.push({ frame, start, count }),
      {
        batchSize: PRIMAL_PARTICLE_INIT_BATCH_SIZE,
        requestFrame: async () => { frame += 1; },
        onProgress: (fraction) => progress.push(fraction),
      },
    );

    expect(batches).toHaveLength(Math.ceil(
      PRIMAL_PARTICLE_POOL_CAPACITY / PRIMAL_PARTICLE_INIT_BATCH_SIZE,
    ));
    expect(batches.every((batch) => batch.count <= PRIMAL_PARTICLE_INIT_BATCH_SIZE)).toBe(true);
    expect(new Set(batches.map((batch) => batch.frame)).size).toBe(batches.length);
    expect(batches.reduce((total, batch) => total + batch.count, 0))
      .toBe(PRIMAL_PARTICLE_POOL_CAPACITY);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((left, right) => left - right));
  });

  it("does not mutate after cancellation between frames", async () => {
    const controller = new AbortController();
    const frameResolvers: Array<() => void> = [];
    const requestFrame: FrameRequest = () => new Promise<void>((resolve) => {
      frameResolvers.push(resolve);
    });
    let initialized = 0;
    const run = runFrameSlicedInitialization(
      300,
      (_start, count) => { initialized += count; },
      { batchSize: 100, signal: controller.signal, requestFrame },
    );

    await Promise.resolve();
    expect(initialized).toBe(0);
    frameResolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(initialized).toBe(100);

    controller.abort(new Error("renderer destroyed"));
    frameResolvers.shift()?.();
    await expect(run).rejects.toThrow("renderer destroyed");
    expect(initialized).toBe(100);
  });

  it("waits two frame boundaries before resolving the painted-shell gate", async () => {
    const frameResolvers: Array<() => void> = [];
    const painted = waitForPaintedFrame(() => new Promise<void>((resolve) => {
      frameResolvers.push(resolve);
    }));
    let resolved = false;
    void painted.then(() => { resolved = true; });

    expect(frameResolvers).toHaveLength(1);
    frameResolvers.shift()?.();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(frameResolvers).toHaveLength(1);

    frameResolvers.shift()?.();
    await painted;
    expect(resolved).toBe(true);
  });

  it("falls back to bounded timers when a host rAF polyfill throws", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", () => {
      throw new TypeError("window timer host is unavailable");
    });

    const painted = waitForPaintedFrame();
    await vi.advanceTimersByTimeAsync(100);
    await expect(painted).resolves.toBeUndefined();
  });
});
