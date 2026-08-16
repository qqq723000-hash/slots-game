import { describe, expect, it } from "vitest";
import { Container } from "pixi.js";
import type { Texture } from "pixi.js";
import cityBackdropSource from "../src/renderer/CityBackdrop.ts?raw";
import {
  createCityBackdropLoadProgressReporter,
} from "../src/renderer/CityBackdrop";
import {
  runGpuPrepareSlices,
  runBoundedLaunchLoads,
  splitGpuWarmupTargets,
  uniqueGpuWarmupTextures,
  type FractionalLaunchLoad,
} from "../src/renderer/PixiRenderer";

describe("fractional renderer launch progress", () => {
  it("averages all fourteen groups from their current fractional progress", async () => {
    const reporters: Array<((fraction: number) => void) | undefined> = [];
    const releases: Array<(() => void) | undefined> = [];
    const progress: number[] = [];
    const loads: FractionalLaunchLoad[] = Array.from({ length: 14 }, (_, index) => (
      (report) => new Promise<void>((resolve) => {
        reporters[index] = report;
        releases[index] = resolve;
      })
    ));

    const run = runBoundedLaunchLoads(loads, 14, (fraction) => progress.push(fraction));
    expect(reporters.filter(Boolean)).toHaveLength(14);

    reporters[0]?.(0.5);
    expect(progress.at(-1)).toBeCloseTo(0.5 / 14, 12);
    reporters[1]?.(0.25);
    expect(progress.at(-1)).toBeCloseTo(0.75 / 14, 12);
    reporters[1]?.(0.1);
    expect(progress.at(-1)).toBeCloseTo(0.75 / 14, 12);

    for (const release of releases) release?.();
    await run;
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((left, right) => left - right));
  });

  it("does not publish exact completion until the reporting group resolves", async () => {
    let report!: (fraction: number) => void;
    let release!: () => void;
    const progress: number[] = [];
    const run = runBoundedLaunchLoads([
      (next) => new Promise<void>((resolve) => {
        report = next;
        release = resolve;
      }),
    ], 1, (fraction) => progress.push(fraction));

    report(1);
    expect(progress.at(-1)).toBeLessThan(1);
    release();
    await run;
    expect(progress.at(-1)).toBe(1);
  });

  it("suppresses late reports and completion after launch progress is cancelled", async () => {
    let report!: (fraction: number) => void;
    let reject!: (reason: Error) => void;
    let accepting = true;
    const progress: number[] = [];
    const run = runBoundedLaunchLoads([
      (next) => new Promise<void>((_resolve, rejectAttempt) => {
        report = next;
        reject = rejectAttempt;
      }),
    ], 1, (fraction) => progress.push(fraction), () => accepting);

    report(0.4);
    expect(progress).toEqual([0, 0.4]);
    accepting = false;
    report(0.9);
    reject(new Error("launch aborted"));
    await expect(run).rejects.toThrow("launch aborted");
    expect(progress).toEqual([0, 0.4]);
  });

  it("does not dequeue more groups after launch acceptance is cancelled", async () => {
    let releaseFirst!: () => void;
    let accepting = true;
    const started: number[] = [];
    const run = runBoundedLaunchLoads([
      () => new Promise<void>((resolve) => {
        started.push(0);
        releaseFirst = resolve;
      }),
      async () => { started.push(1); },
    ], 1, () => undefined, () => accepting);

    expect(started).toEqual([0]);
    accepting = false;
    releaseFirst();
    await run;
    expect(started).toEqual([0]);
  });

  it("waits for active peers to quiesce before surfacing the first failure", async () => {
    let releasePeer!: () => void;
    let rejected = false;
    const run = runBoundedLaunchLoads([
      async () => { throw new Error("broken atlas"); },
      () => new Promise<void>((resolve) => { releasePeer = resolve; }),
    ], 2).catch((error: unknown) => {
      rejected = true;
      throw error;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(rejected).toBe(false);
    releasePeer();
    await expect(run).rejects.toThrow("broken atlas");
  });
});

describe("GPU warmup slicing", () => {
  it("uploads one representative frame for each atlas base texture", () => {
    const firstBase = {} as Texture["baseTexture"];
    const secondBase = {} as Texture["baseTexture"];
    const first = { baseTexture: firstBase } as Texture;
    const sameAtlasFrame = { baseTexture: firstBase } as Texture;
    const second = { baseTexture: secondBase } as Texture;

    expect(uniqueGpuWarmupTextures([
      first,
      sameAtlasFrame,
      second,
    ])).toEqual([first, second]);
  });

  it("splits nested renderable branches without reviving excluded pools", () => {
    const root = new Container();
    const branch = new Container();
    const first = new Container();
    const second = new Container();
    const excluded = new Container();
    excluded.renderable = false;
    branch.addChild(first, second, excluded);
    root.addChild(branch);

    expect(splitGpuWarmupTargets(root, 2)).toEqual([first, second]);
  });

  it("packs cheap uploads into bounded frame slices", async () => {
    const frames: number[] = [];
    const uploads: number[] = [];
    await runGpuPrepareSlices(Array.from({ length: 25 }, (_, index) => index), {
      requestFrame: async () => { frames.push(uploads.length); },
      upload: async (target) => { uploads.push(target); },
      now: () => 0,
      maxTargetsPerSlice: 12,
    });

    expect(frames).toEqual([0, 12, 24]);
    expect(uploads).toEqual(Array.from({ length: 25 }, (_, index) => index));
  });

  it("yields before the next upload once the frame time budget is consumed", async () => {
    let clock = 0;
    const frames: number[] = [];
    await runGpuPrepareSlices([0, 1, 2, 3], {
      requestFrame: async () => { frames.push(clock); },
      upload: async () => { clock += 5; },
      now: () => clock,
      frameBudgetMs: 8,
      maxTargetsPerSlice: 12,
    });

    expect(frames).toEqual([0, 10]);
  });
});

describe("CityBackdrop nested launch progress", () => {
  it("averages bitmap, authored Spine and particle fractions monotonically", () => {
    const progress: number[] = [];
    let active = true;
    const report = createCityBackdropLoadProgressReporter(
      (fraction) => progress.push(fraction),
      () => active,
    );

    report("particles", 0.3);
    report("particles", 0.2);
    report("bitmap", 1);
    report("authored", 0.5);
    active = false;
    report("authored", 1);

    expect(progress).toHaveLength(3);
    expect(progress[0]).toBeCloseTo(0.1, 12);
    expect(progress[1]).toBeCloseTo(1.3 / 3, 12);
    expect(progress[2]).toBeCloseTo(1.8 / 3, 12);
  });

  it("wires the frame-sliced particle pool reporter into the backdrop group", () => {
    expect(cityBackdropSource).toContain(
      'onProgress: (fraction) => reportBranch("particles", fraction)',
    );
  });
});
