import { ParticleContainer, Texture } from "pixi.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BigWinView } from "../src/renderer/BigWinView";
import {
  BIG_WIN_COIN_ATLAS_URL,
  BIG_WIN_COIN_FRAME_FUSE_POLICY,
  BIG_WIN_COIN_IDS,
  BIG_WIN_COIN_INITIALIZATION_BATCH_CAP,
  BIG_WIN_COIN_MANIFEST_URL,
  BIG_WIN_COIN_PHYSICS,
  BIG_WIN_COIN_POOL_SEQUENCE,
  BIG_WIN_COIN_TOTAL_POOL_SIZE,
  advanceBigWinCoinFrameFuse,
  advanceCoinEmissionCounter,
  BigWinCoinShower,
  createCoinParticleState,
  initialBigWinCoinFrameFuseState,
  resolveBigWinCoinParticleBudget,
  runBigWinCoinPoolInitialization,
  tickCoinParticle,
  type BigWinCoinFrameFusePolicy,
  type BigWinCoinShowerOptions,
} from "../src/renderer/BigWinCoinShower";

const TEST_FRAME_FUSE_POLICY = Object.freeze({
  slowFrameThresholdMs: 30,
  healthyFrameThresholdMs: 20,
  slowFrameWindowSize: 4,
  slowFramesToDegrade: 2,
  healthyFramesToRecover: 3,
  budgets: Object.freeze([
    Object.freeze({ activeParticleLimit: 150, densityScale: 1 }),
    Object.freeze({ activeParticleLimit: 72, densityScale: 0.5 }),
    Object.freeze({ activeParticleLimit: 30, densityScale: 0.25 }),
  ]),
}) satisfies BigWinCoinFrameFusePolicy;

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

async function loadCoinShower(
  options: BigWinCoinShowerOptions = {},
): Promise<BigWinCoinShower> {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify(validCoinManifest()),
    { status: 200, headers: { "content-type": "application/json" } },
  )));
  vi.spyOn(Texture, "fromURL").mockResolvedValue(Texture.EMPTY);
  const shower = new BigWinCoinShower(() => 0.5, options);
  await shower.load(undefined, { requestFrame: () => Promise.resolve() });
  return shower;
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
    expect(BIG_WIN_COIN_TOTAL_POOL_SIZE).toBe(150);
    expect(resolveBigWinCoinParticleBudget(initialBigWinCoinFrameFuseState())).toEqual({
      activeParticleLimit: 150,
      densityScale: 1,
    });
  });

  it("keeps normal frames unchanged and ignores an isolated GC-length frame", () => {
    let state = initialBigWinCoinFrameFuseState();
    state = advanceBigWinCoinFrameFuse(state, 45, TEST_FRAME_FUSE_POLICY);
    for (let frame = 0; frame < TEST_FRAME_FUSE_POLICY.slowFrameWindowSize; frame += 1) {
      state = advanceBigWinCoinFrameFuse(state, 16, TEST_FRAME_FUSE_POLICY);
    }
    expect(state.level).toBe(0);
    expect(state.slowFrameCount).toBe(0);

    for (let frame = 0; frame < 120; frame += 1) {
      state = advanceBigWinCoinFrameFuse(state, 16, BIG_WIN_COIN_FRAME_FUSE_POLICY);
    }
    expect(state.level).toBe(0);
    expect(resolveBigWinCoinParticleBudget(state)).toEqual({
      activeParticleLimit: 150,
      densityScale: 1,
    });
  });

  it("degrades only after bounded repeated slow frames and recovers one level at a time", () => {
    let state = initialBigWinCoinFrameFuseState();
    state = advanceBigWinCoinFrameFuse(state, 40, TEST_FRAME_FUSE_POLICY);
    state = advanceBigWinCoinFrameFuse(state, 16, TEST_FRAME_FUSE_POLICY);
    state = advanceBigWinCoinFrameFuse(state, 40, TEST_FRAME_FUSE_POLICY);
    expect(state.level).toBe(1);
    expect(resolveBigWinCoinParticleBudget(state, {}, TEST_FRAME_FUSE_POLICY)).toEqual({
      activeParticleLimit: 72,
      densityScale: 0.5,
    });

    state = advanceBigWinCoinFrameFuse(state, 40, TEST_FRAME_FUSE_POLICY);
    state = advanceBigWinCoinFrameFuse(state, 40, TEST_FRAME_FUSE_POLICY);
    expect(state.level).toBe(2);
    expect(resolveBigWinCoinParticleBudget(state, {}, TEST_FRAME_FUSE_POLICY)).toEqual({
      activeParticleLimit: 30,
      densityScale: 0.25,
    });

    for (let frame = 0; frame < 3; frame += 1) {
      state = advanceBigWinCoinFrameFuse(state, 16, TEST_FRAME_FUSE_POLICY);
    }
    expect(state.level).toBe(1);
    for (let frame = 0; frame < 3; frame += 1) {
      state = advanceBigWinCoinFrameFuse(state, 16, TEST_FRAME_FUSE_POLICY);
    }
    expect(state.level).toBe(0);
  });

  it("applies deterministic lower budgets for reduced motion and an explicit low tier", () => {
    const state = initialBigWinCoinFrameFuseState();
    expect(resolveBigWinCoinParticleBudget(
      state,
      { reducedMotion: true },
      TEST_FRAME_FUSE_POLICY,
    )).toEqual({ activeParticleLimit: 72, densityScale: 0.5 });
    expect(resolveBigWinCoinParticleBudget(
      state,
      { performanceTier: "low" },
      TEST_FRAME_FUSE_POLICY,
    )).toEqual({ activeParticleLimit: 30, densityScale: 0.25 });
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

  it("consumes a verified manifest/atlas without URL requests and permits a clean retry", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const fromUrl = vi.spyOn(Texture, "fromURL");
    const shower = new BigWinCoinShower(() => 0.5);
    const options = {
      verifiedManifest: validCoinManifest(),
      verifiedAtlasTexture: Texture.EMPTY,
      requestFrame: () => Promise.resolve(),
    } as const;

    const first = shower.load(undefined, options);
    const joined = shower.load(undefined, options);
    await expect(Promise.all([first, joined])).resolves.toEqual([undefined, undefined]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(fromUrl).not.toHaveBeenCalled();
    expect(shower.artworkLoaded).toBe(true);

    shower.clearArtwork();
    expect(shower.artworkLoaded).toBe(false);
    await expect(shower.load(undefined, options)).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(fromUrl).not.toHaveBeenCalled();
    expect(shower.artworkLoaded).toBe(true);
    shower.destroy({ children: true });
  });

  it("enforces the active cap without changing the healthy 150-pool path", async () => {
    const normal = await loadCoinShower({ frameFusePolicy: TEST_FRAME_FUSE_POLICY });
    normal.setTier(3);
    expect(normal.activeParticleCount).toBe(60);
    expect(normal.particleBudgetSnapshot).toMatchObject({
      adaptiveLevel: 0,
      activeParticleLimit: 150,
      densityScale: 1,
    });
    normal.update(16);
    expect(normal.particleBudgetSnapshot.adaptiveLevel).toBe(0);
    normal.destroy({ children: true });

    const degraded = await loadCoinShower({ frameFusePolicy: TEST_FRAME_FUSE_POLICY });
    degraded.setTier(3);
    for (let frame = 0; frame < 4; frame += 1) degraded.update(40);
    expect(degraded.particleBudgetSnapshot).toMatchObject({
      adaptiveLevel: 2,
      activeParticleLimit: 30,
      densityScale: 0.25,
    });
    expect(degraded.activeParticleCount).toBeLessThanOrEqual(30);
    degraded.update(500);
    expect(degraded.activeParticleCount).toBeLessThanOrEqual(30);
    degraded.destroy({ children: true });
  });

  it("resets adaptive state on stop, killAll and destroy", async () => {
    const shower = await loadCoinShower({ frameFusePolicy: TEST_FRAME_FUSE_POLICY });
    const degradeFully = () => {
      shower.setTier(3);
      for (let frame = 0; frame < 4; frame += 1) shower.update(40);
      expect(shower.particleBudgetSnapshot.adaptiveLevel).toBe(2);
    };

    degradeFully();
    shower.stop();
    expect(shower.particleBudgetSnapshot).toMatchObject({
      adaptiveLevel: 0,
      slowFrameCount: 0,
      healthyFrameStreak: 0,
    });

    degradeFully();
    shower.killAll();
    expect(shower.activeParticleCount).toBe(0);
    expect(shower.particleBudgetSnapshot).toMatchObject({
      adaptiveLevel: 0,
      slowFrameCount: 0,
      healthyFrameStreak: 0,
    });

    degradeFully();
    shower.destroy({ children: true });
    expect(shower.activeParticleCount).toBe(0);
    expect(shower.particleBudgetSnapshot.adaptiveLevel).toBe(0);
  });
});
