import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PreloadAbortedError,
  PreloadGate,
  type PreloadProgress,
} from "../src/startup/PreloadGate";

describe("PreloadGate", () => {
  afterEach(() => vi.useRealTimers());

  it("reports named, weighted and fractional monotonic progress", async () => {
    const progress: PreloadProgress[] = [];
    const order: string[] = [];
    const gate = new PreloadGate([
      {
        name: "entry-resources",
        stage: "assets",
        weight: 3,
        run: ({ report }) => {
          order.push("assets");
          report(0.25);
          report(0.75);
          report(0.5);
        },
      },
      {
        name: "gpu-upload",
        stage: "gpu-warmup",
        weight: 1,
        run: ({ report }) => {
          order.push("gpu");
          report(0.5);
        },
      },
    ]);

    await gate.run((event) => progress.push(event));

    expect(order).toEqual(["assets", "gpu"]);
    expect(progress[0]).toMatchObject({
      stage: "assets",
      taskName: "entry-resources",
      progress: 0,
      status: "running",
    });
    expect(progress.some((event) => event.progress === 0.1875)).toBe(true);
    expect(progress.some((event) => event.progress === 0.5625)).toBe(true);
    expect(progress.some((event) => event.progress === 0.875)).toBe(true);
    expect(progress.at(-1)).toMatchObject({
      stage: "complete",
      taskName: null,
      completedWeight: 4,
      totalWeight: 4,
      progress: 1,
      status: "complete",
    });
    expect(progress.map((event) => event.progress)).toEqual(
      [...progress.map((event) => event.progress)].sort((left, right) => left - right),
    );
    expect(progress.every((event) => Number.isFinite(event.progress))).toBe(true);
  });

  it("does not expose 100% until the final task promise resolves", async () => {
    const latch: { release?: () => void } = {};
    const progress: PreloadProgress[] = [];
    const gate = new PreloadGate([{
      name: "scene-mount",
      stage: "scene-mount",
      weight: 1,
      run: ({ report }) => new Promise<void>((resolve) => {
        report(1);
        latch.release = resolve;
      }),
    }]);

    const run = gate.run((event) => progress.push(event));
    await Promise.resolve();
    expect(progress.at(-1)?.progress).toBeLessThan(1);
    expect(progress.at(-1)?.status).toBe("running");

    expect(latch.release).toBeTypeOf("function");
    latch.release?.();
    await run;
    expect(progress.at(-1)?.progress).toBe(1);
    expect(progress.at(-1)?.status).toBe("complete");
  });

  it("fails the named stage on timeout and ignores late progress", async () => {
    vi.useFakeTimers();
    const late: { report?: (fraction: number) => void } = {};
    const progress: PreloadProgress[] = [];
    const gate = new PreloadGate([{
      name: "audio-main-packs",
      stage: "assets",
      weight: 2,
      run: ({ report }) => {
        late.report = report;
        return new Promise<void>(() => undefined);
      },
    }], 25);

    const run = gate.run((event) => progress.push(event));
    const rejected = expect(run).rejects.toThrow(
      'Preload task "audio-main-packs" timed out after 25ms',
    );
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    const countAtFailure = progress.length;
    late.report?.(1);
    expect(progress).toHaveLength(countAtFailure);
    expect(progress.every((event) => event.progress < 1)).toBe(true);
  });

  it("wraps a required task rejection without reporting false completion", async () => {
    const progress: PreloadProgress[] = [];
    const gate = new PreloadGate([{
      name: "authored-spine",
      stage: "assets",
      weight: 1,
      run: () => Promise.reject(new Error("atlas corrupt")),
    }]);

    await expect(gate.run((event) => progress.push(event))).rejects.toThrow(
      'Preload task "authored-spine" failed: atlas corrupt',
    );
    expect(progress.every((event) => event.progress < 1)).toBe(true);
    expect(progress.every((event) => event.status !== "complete")).toBe(true);
  });

  it("ignores a resolved stage's stale reporter while the next stage runs", async () => {
    const stale: { report?: (fraction: number) => void } = {};
    const next: { release?: () => void } = {};
    const progress: PreloadProgress[] = [];
    let markNextStarted!: () => void;
    const nextStarted = new Promise<void>((resolve) => { markNextStarted = resolve; });
    const gate = new PreloadGate([
      {
        name: "download",
        stage: "assets",
        weight: 1,
        run: ({ report }) => { stale.report = report; },
      },
      {
        name: "upload",
        stage: "gpu-warmup",
        weight: 1,
        run: () => {
          markNextStarted();
          return new Promise<void>((resolve) => { next.release = resolve; });
        },
      },
    ]);

    const run = gate.run((event) => progress.push(event));
    await nextStarted;
    const countBeforeStaleReport = progress.length;
    stale.report?.(0.2);
    expect(progress).toHaveLength(countBeforeStaleReport);
    next.release?.();
    await run;
  });

  it("completes an empty pipeline once with finite progress", async () => {
    const progress: PreloadProgress[] = [];
    await new PreloadGate([]).run((event) => progress.push(event));
    expect(progress).toEqual([{
      stage: "complete",
      taskName: null,
      status: "complete",
      taskFraction: 1,
      completedWeight: 0,
      totalWeight: 0,
      progress: 1,
    }]);
  });

  it("aborts an uncooperative task and suppresses later callbacks", async () => {
    const late: { report?: (fraction: number) => void } = {};
    const progress: PreloadProgress[] = [];
    const gate = new PreloadGate([{
      name: "scene-build",
      stage: "scene-mount",
      weight: 1,
      run: ({ report }) => {
        late.report = report;
        return new Promise<void>(() => undefined);
      },
    }]);

    const run = gate.run((event) => progress.push(event));
    await Promise.resolve();
    gate.abort();
    await expect(run).rejects.toBeInstanceOf(PreloadAbortedError);
    const countAtAbort = progress.length;
    late.report?.(0.9);
    expect(progress).toHaveLength(countAtAbort);
  });
});
