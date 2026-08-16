import { ParticleContainer, Texture } from "pixi.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BigWinView } from "../src/renderer/BigWinView";
import {
  BIG_WIN_COIN_ATLAS_URL,
  BIG_WIN_COIN_IDS,
  BIG_WIN_COIN_INITIALIZATION_BATCH_CAP,
  BIG_WIN_COIN_MANIFEST_URL,
  BIG_WIN_COIN_PHYSICS,
  BIG_WIN_COIN_POOL_SEQUENCE,
  BIG_WIN_COIN_TOTAL_POOL_SIZE,
  advanceCoinEmissionCounter,
  BigWinCoinShower,
  createCoinParticleState,
  runBigWinCoinPoolInitialization,
  tickCoinParticle,
} from "../src/renderer/BigWinCoinShower";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function validCoinManifest() {
  return {
    schemaVersion: 1,
    tickRate: BIG_WIN_COIN_PHYSICS.tickRate,
    atlas: {
      image: "PrimalRampage.png",
      width: 2_045,
      height: 2_365,
    },
    coins: BIG_WIN_COIN_IDS.map((id) => ({
      id,
      frames: Array.from({ length: BIG_WIN_COIN_PHYSICS.framesPerCoin }, (_, index) => ({
        textureId: `${id}-${index}`,
        frame: { x: 0, y: 0, width: 1, height: 1 },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, width: 46, height: 46 },
        sourceSize: { width: 46, height: 46 },
        pivot: { x: 23, y: 23 },
      })),
    })),
  };
}

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !predicate(); attempt += 1) {
    await Promise.resolve();
  }
}

describe("captured Big Win coin shower", () => {
  it("retains the six source pools and deliberate coin04 double weighting", () => {
    expect(BIG_WIN_COIN_IDS).toEqual([
      "coin01",
      "coin02",
      "coin03",
      "coin04",
      "coin05",
    ]);
    expect(BIG_WIN_COIN_POOL_SEQUENCE).toEqual([
      "coin01",
      "coin02",
      "coin03",
      "coin04",
      "coin04",
      "coin05",
    ]);
    expect(BIG_WIN_COIN_MANIFEST_URL).toContain("/interface/big-win-coins.json");
    expect(BIG_WIN_COIN_ATLAS_URL).toContain("/primal-rampage/PrimalRampage.png");
  });

  it("uses the bundle's 24Hz pool, 30-tick life, gravity and burst constants", () => {
    expect(BIG_WIN_COIN_PHYSICS).toEqual({
      tickRate: 24,
      framesPerCoin: 19,
      poolCapacity: 25,
      lifetimeTicks: 30,
      initialSize: 40,
      sizePerTick: 0.5,
      alphaPerTick: 0.2,
      gravityPerTick: 2,
      normalYForce: 4,
      burstTicks: 15,
      tierDensities: [1, 2, 3, 4],
    });
  });

  it("matches the random initial frame and ballistic initializer", () => {
    const samples = [0.5, 0.25, 0.75];
    const state = createCoinParticleState(5, () => samples.shift() ?? 0);
    const speed = (0.25 - 6) * 5;
    const angle = 0.75 - 0.5;
    expect(state.textureIndex).toBe(9);
    expect(state.velocityX).toBeCloseTo(Math.sin(angle) * speed, 12);
    expect(state.velocityY).toBeCloseTo(Math.cos(angle) * speed, 12);
    expect(state).toMatchObject({
      remainingTicks: 30,
      size: 40,
      alpha: 0,
    });
  });

  it("advances texture, gravity, alpha and size for exactly 30 ticks", () => {
    const state = createCoinParticleState(4, () => 0.5);
    const initialVelocityY = state.velocityY;
    for (let tick = 1; tick <= 30; tick += 1) {
      expect(tickCoinParticle(state)).toBe(tick < 30);
      expect(state.textureIndex).toBe((9 + tick) % 19);
    }
    expect(state.velocityY).toBeCloseTo(initialVelocityY + 60, 12);
    expect(state.alpha).toBe(1);
    expect(state.size).toBe(55);
    expect(state.remainingTicks).toBe(0);
  });

  it("uses the source fractional accumulator and 15-tick tier bursts", () => {
    let counter = 0;
    let emitted = 0;
    for (let tick = 0; tick < BIG_WIN_COIN_PHYSICS.burstTicks; tick += 1) {
      const step = advanceCoinEmissionCounter(counter, 4);
      counter = step.counter;
      emitted += step.count;
    }
    expect(emitted).toBe(60);

    expect(advanceCoinEmissionCounter(0, 0.4)).toEqual({ counter: 0.4, count: 0 });
    const fractional = advanceCoinEmissionCounter(0.8, 0.4);
    expect(fractional.counter).toBeCloseTo(1.2, 12);
    expect(fractional.count).toBe(1);
  });

  it("builds all 150 pooled Sprites over distinct frames with a hard 25-item cap", async () => {
    let frame = 0;
    const batches: Array<{ frame: number; start: number; count: number }> = [];
    const progress: number[] = [];

    await runBigWinCoinPoolInitialization(
      (start, count) => batches.push({ frame, start, count }),
      {
    // 调用方无法意外覆盖生产环境的帧预算。
        batchSize: 1_000,
        requestFrame: async () => { frame += 1; },
        onProgress: (fraction) => progress.push(fraction),
      },
    );

    expect(BIG_WIN_COIN_TOTAL_POOL_SIZE).toBe(150);
    expect(BIG_WIN_COIN_INITIALIZATION_BATCH_CAP).toBe(25);
    expect(batches).toHaveLength(6);
    expect(batches.map(({ frame: batchFrame }) => batchFrame)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(batches.every(({ count }) => count <= 25)).toBe(true);
    expect(batches.reduce((total, { count }) => total + count, 0)).toBe(150);
    expect(batches.map(({ start }) => start)).toEqual([0, 25, 50, 75, 100, 125]);
    expect(progress.at(-1)).toBe(1);
  });

  it("stops before the next Sprite batch when the AbortSignal is cancelled", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel coin initialization");
    let frame = 0;
    let initialized = 0;

    const attempt = runBigWinCoinPoolInitialization(
      (_start, count) => { initialized += count; },
      {
        signal: controller.signal,
        requestFrame: async () => {
          frame += 1;
          if (frame === 2) controller.abort(reason);
        },
      },
    );

    await expect(attempt).rejects.toBe(reason);
    expect(initialized).toBe(25);
  });

  it("stops before the next Sprite batch when its owner is destroyed", async () => {
    let destroyed = false;
    let frame = 0;
    let initialized = 0;

    const attempt = runBigWinCoinPoolInitialization(
      (_start, count) => { initialized += count; },
      {
        isCancelled: () => destroyed,
        requestFrame: async () => {
          frame += 1;
          if (frame === 2) destroyed = true;
        },
      },
    );

    await expect(attempt).rejects.toMatchObject({ name: "AbortError" });
    expect(initialized).toBe(25);
  });

  it("cannot commit a blocked pool after its BigWin owner is destroyed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify(validCoinManifest()),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    vi.spyOn(Texture, "fromURL").mockResolvedValue(Texture.EMPTY);
    const destroyPool = vi.spyOn(ParticleContainer.prototype, "destroy");
    const owner = new BigWinView();
    const shower = (owner as unknown as { coinShower: BigWinCoinShower }).coinShower;
    const frameResolvers: Array<() => void> = [];

    expect(shower.parent).toBe(owner);
    const loading = shower.load(undefined, {
      requestFrame: () => new Promise<void>((resolve) => frameResolvers.push(resolve)),
    });

    await flushUntil(() => frameResolvers.length === 1);
    expect(frameResolvers).toHaveLength(1);
    frameResolvers.shift()?.();
    await flushUntil(() => frameResolvers.length === 1);
    expect(frameResolvers).toHaveLength(1);

    // 第二帧被阻塞时，一批 25 个 Sprite 只存在于本地对象池中。销毁所有者时，
    // 必须取消并清理全部六个本地对象池。
    owner.destroy();
    expect(shower.destroyed).toBe(true);
    expect(shower.parent).toBeNull();
    frameResolvers.shift()?.();

    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(shower.artworkLoaded).toBe(false);
    expect(destroyPool).toHaveBeenCalledTimes(BIG_WIN_COIN_POOL_SEQUENCE.length);
  });
});
