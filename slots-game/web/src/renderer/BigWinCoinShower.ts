import {
  Container,
  ParticleContainer,
  Rectangle,
  Sprite,
  Texture,
} from "pixi.js";
import { publicAssetUrl } from "../assets/publicAssetUrl";
import {
  cancelNetworkResponse,
  NETWORK_RESPONSE_LIMITS,
  readBoundedResponseText,
} from "../network/boundedResponse";
import {
  runFrameSlicedInitialization,
  type FrameRequest,
} from "../startup/frameSlicedInitialization";

export const BIG_WIN_COIN_MANIFEST_URL = publicAssetUrl(
  "assets/primal-runtime/interface/big-win-coins.json",
);
export const BIG_WIN_COIN_ATLAS_URL = publicAssetUrl(
  "assets/primal-runtime/fonts/primal-rampage/PrimalRampage.png",
);

export const BIG_WIN_COIN_IDS = Object.freeze([
  "coin01",
  "coin02",
  "coin03",
  "coin04",
  "coin05",
] as const);
export type BigWinCoinId = (typeof BIG_WIN_COIN_IDS)[number];

/** 捆绑模块 9271 中的准确池顺序； coin04 故意具有 2 倍的重量。 */
export const BIG_WIN_COIN_POOL_SEQUENCE = Object.freeze([
  "coin01",
  "coin02",
  "coin03",
  "coin04",
  "coin04",
  "coin05",
] as const satisfies readonly BigWinCoinId[]);

/** 常数转录自 CoinShowerEmitter/CoinShowerParticle (9271/1299)。 */
export const BIG_WIN_COIN_PHYSICS = Object.freeze({
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
  tierDensities: Object.freeze([1, 2, 3, 4] as const),
});

/**
 * 在一个绘制帧中同步 Sprite 构造的硬上限。因此，六个 25-Sprite 源池是在至少六个帧上构建的。
 */
export const BIG_WIN_COIN_INITIALIZATION_BATCH_CAP = 25;
export const BIG_WIN_COIN_TOTAL_POOL_SIZE = (
  BIG_WIN_COIN_POOL_SEQUENCE.length * BIG_WIN_COIN_PHYSICS.poolCapacity
);

export interface BigWinCoinPoolInitializationOptions {
  readonly batchSize?: number;
  readonly signal?: AbortSignal;
  readonly requestFrame?: FrameRequest;
  readonly isCancelled?: () => boolean;
  readonly onProgress?: (fraction: number) => void;
}

/**
 * 公开，因此可以在不加载 Pixi 纹理的情况下测试帧预算和取消边界。调用者可以请求较小的批次，
 * 但绝不能大于 BIG_WIN_COIN_INITIALIZATION_BATCH_CAP。
 */
export function runBigWinCoinPoolInitialization(
  initializeBatch: (start: number, count: number) => void,
  options: BigWinCoinPoolInitializationOptions = {},
): Promise<void> {
  const requestedBatchSize = options.batchSize
    ?? BIG_WIN_COIN_INITIALIZATION_BATCH_CAP;
  if (!Number.isInteger(requestedBatchSize) || requestedBatchSize <= 0) {
    throw new Error("Big Win coin initialization batch size must be a positive integer");
  }
  return runFrameSlicedInitialization(
    BIG_WIN_COIN_TOTAL_POOL_SIZE,
    initializeBatch,
    {
      batchSize: Math.min(
        requestedBatchSize,
        BIG_WIN_COIN_INITIALIZATION_BATCH_CAP,
      ),
      signal: options.signal,
      requestFrame: options.requestFrame,
      isCancelled: options.isCancelled,
      onProgress: options.onProgress,
    },
  );
}

export interface BigWinCoinShowerLoadOptions {
  /** 测试/低端设备覆盖；始终固定在生产上限上。 */
  readonly batchSize?: number;
  readonly requestFrame?: FrameRequest;
  readonly onProgress?: (fraction: number) => void;
}

export interface CoinParticleState {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  remainingTicks: number;
  textureIndex: number;
  size: number;
  alpha: number;
}

export interface CoinEmissionStep {
  readonly counter: number;
  readonly count: number;
}

type RandomSource = () => number;

/** CoinShowerEmitter.tick() 使用的精确分数密度累加器。 */
export function advanceCoinEmissionCounter(
  counter: number,
  density: number,
): CoinEmissionStep {
  const before = Math.floor(counter);
  const next = counter + density;
  return Object.freeze({ counter: next, count: Math.floor(next) - before });
}

/** 来自捕获的包模块 1299 的精确初始化程序。 */
export function createCoinParticleState(
  yForce: number,
  random: RandomSource = Math.random,
): CoinParticleState {
  const textureIndex = Math.floor(random() * BIG_WIN_COIN_PHYSICS.framesPerCoin);
  const speed = (random() - 6) * yForce;
  const angle = random() - 0.5;
  return {
    x: 0,
    y: 0,
    velocityX: Math.sin(angle) * speed,
    velocityY: Math.cos(angle) * speed,
    remainingTicks: BIG_WIN_COIN_PHYSICS.lifetimeTicks,
    textureIndex,
    size: BIG_WIN_COIN_PHYSICS.initialSize,
    alpha: 0,
  };
}

/** 来自捕获的捆绑模块 1299 的精确固定蜱突变。 */
export function tickCoinParticle(state: CoinParticleState): boolean {
  state.velocityY += BIG_WIN_COIN_PHYSICS.gravityPerTick;
  if (state.alpha < 1) state.alpha += BIG_WIN_COIN_PHYSICS.alphaPerTick;
  state.size += BIG_WIN_COIN_PHYSICS.sizePerTick;
  state.textureIndex = (
    state.textureIndex + 1
  ) % BIG_WIN_COIN_PHYSICS.framesPerCoin;
  state.remainingTicks -= 1;
  return state.remainingTicks > 0;
}

export function advanceCoinParticle(
  state: CoinParticleState,
  tickFraction: number,
): void {
  state.x += tickFraction * state.velocityX;
  state.y += tickFraction * state.velocityY;
}

interface CoinFrameSpec {
  readonly textureId: string;
  readonly frame: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  readonly rotated: boolean;
  readonly trimmed: boolean;
  readonly spriteSourceSize: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  readonly sourceSize: Readonly<{ width: number; height: number }>;
  readonly pivot: Readonly<{ x: number; y: number }>;
}

interface CoinDefinition {
  readonly id: BigWinCoinId;
  readonly frames: readonly CoinFrameSpec[];
}

interface CoinAtlasManifest {
  readonly schemaVersion: 1;
  readonly tickRate: number;
  readonly atlas: Readonly<{
    image: string;
    width: number;
    height: number;
  }>;
  readonly coins: readonly CoinDefinition[];
}

interface CoinParticleRuntime {
  readonly sprite: Sprite;
  readonly frames: readonly Texture[];
  readonly frameSpecs: readonly CoinFrameSpec[];
  readonly state: CoinParticleState;
}

class CoinPoolRuntime {
  readonly view = new ParticleContainer(
    BIG_WIN_COIN_PHYSICS.poolCapacity,
    {
      position: true,
      scale: true,
      alpha: true,
      uvs: true,
    },
    BIG_WIN_COIN_PHYSICS.poolCapacity,
    false,
  );

  private readonly active: CoinParticleRuntime[] = [];
  private readonly free: CoinParticleRuntime[] = [];

  constructor(
    private readonly frames: readonly Texture[],
    private readonly frameSpecs: readonly CoinFrameSpec[],
    private readonly random: RandomSource,
  ) {}

  /** 最多创建 `limit` 成员并返回实际创建的数量。 */
  populate(limit: number): number {
    const count = Math.min(
      Math.max(0, limit),
      BIG_WIN_COIN_PHYSICS.poolCapacity - this.free.length,
    );
    for (let index = 0; index < count; index += 1) {
      const sprite = new Sprite(this.frames[0]);
      sprite.alpha = 0;
      const particle: CoinParticleRuntime = {
        sprite,
        frames: this.frames,
        frameSpecs: this.frameSpecs,
        state: createCoinParticleState(BIG_WIN_COIN_PHYSICS.normalYForce, () => 0.5),
      };
      this.free.push(particle);
      this.view.addChild(sprite);
    }
    return count;
  }

  emit(yForce: number): void {
    const particle = this.free.pop();
    if (!particle) return;
    Object.assign(particle.state, createCoinParticleState(yForce, this.random));
    this.syncParticle(particle);
    this.active.unshift(particle);
  }

  tick(): void {
    for (let index = this.active.length - 1; index >= 0; index -= 1) {
      const particle = this.active[index];
      if (!particle) continue;
      if (tickCoinParticle(particle.state)) {
        this.syncParticle(particle);
        continue;
      }
      particle.sprite.alpha = 0;
      this.active.splice(index, 1);
      this.free.push(particle);
    }
  }

  advance(tickFraction: number): void {
    for (const particle of this.active) {
      advanceCoinParticle(particle.state, tickFraction);
      particle.sprite.position.set(particle.state.x, particle.state.y);
    }
  }

  killAll(): void {
    for (const particle of this.active) {
      particle.sprite.alpha = 0;
      this.free.push(particle);
    }
    this.active.length = 0;
  }

  get activeCount(): number {
    return this.active.length;
  }

  private syncParticle(particle: CoinParticleRuntime): void {
    const { state, sprite, frames, frameSpecs } = particle;
    const texture = frames[state.textureIndex];
    const frame = frameSpecs[state.textureIndex];
    if (!texture || !frame) return;
    sprite.texture = texture;
    sprite.anchor.set(
      frame.pivot.x / frame.sourceSize.width,
      frame.pivot.y / frame.sourceSize.height,
    );
    const diagonal = Math.hypot(frame.sourceSize.width, frame.sourceSize.height);
    sprite.scale.set(diagonal > 0 ? state.size / diagonal : 1);
    sprite.position.set(state.x, state.y);
    sprite.alpha = Math.min(1, state.alpha);
  }
}

/**
 * 由捕获的 95 个图集作物支持的精确固定池 CoinShower 运行时。发射可以独立停止，因此最后的硬币会不断落入本机 Big Win 隐藏剪辑，与源引擎的生命周期相匹配。
 */
export class BigWinCoinShower extends Container {
  private readonly random: RandomSource;
  private pools: CoinPoolRuntime[] = [];
  private loadPromise: Promise<void> | null = null;
  private disposed = false;
  private emitting = false;
  private density: number = BIG_WIN_COIN_PHYSICS.tierDensities[0];
  private emissionCounter = 0;
  private poolIndex = 0;
  private tickAccumulatorMs = 0;

  constructor(random: RandomSource = Math.random) {
    super();
    this.random = random;
  }

  get artworkLoaded(): boolean {
    return this.pools.length === BIG_WIN_COIN_POOL_SEQUENCE.length;
  }

  get activeParticleCount(): number {
    return this.pools.reduce((total, pool) => total + pool.activeCount, 0);
  }

  load(
    signal?: AbortSignal,
    options: BigWinCoinShowerLoadOptions = {},
  ): Promise<void> {
    if (this.artworkLoaded) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    const attempt = Promise.all([
      loadCoinAtlasManifest(signal),
      Texture.fromURL(BIG_WIN_COIN_ATLAS_URL),
    ]).then(async ([manifest, atlas]) => {
      if (this.disposed) return;
      throwIfAborted(signal);
      const textures = makeCoinTextures(manifest, atlas);
      const pools = BIG_WIN_COIN_POOL_SEQUENCE.map((id) => {
        const definition = manifest.coins.find((coin) => coin.id === id);
        const frames = textures.get(id);
        if (!definition || !frames) throw new Error(`Missing captured Big Win coin: ${id}`);
        return new CoinPoolRuntime(frames, definition.frames, this.random);
      });
      let committed = false;
      try {
        await runBigWinCoinPoolInitialization(
          (_start, count) => populateCoinPools(pools, count),
          {
            batchSize: options.batchSize,
            signal,
            requestFrame: options.requestFrame,
            isCancelled: () => this.disposed,
            onProgress: options.onProgress,
          },
        );
        if (this.disposed) return;
        throwIfAborted(signal);

        // 仅在 150 个 Sprite 全部存在后才提交。因此，取消/销毁的视图永远不会公开部分初始化的池集合。
        this.addChild(...pools.map((pool) => pool.view));
        this.pools = pools;
        committed = true;
      } finally {
        if (!committed) destroyCoinPools(pools);
      }
    }).catch((error: unknown) => {
      this.loadPromise = null;
      throw error;
    });
    this.loadPromise = attempt;
    return attempt;
  }

  start(density: number = BIG_WIN_COIN_PHYSICS.tierDensities[0]): void {
    this.setDensity(density);
    this.emitting = true;
    this.emissionCounter = 0;
    this.poolIndex = 0;
  }

  stop(): void {
    this.emitting = false;
  }

  setDensity(density: number): void {
    if (!Number.isFinite(density) || density < 0) {
      throw new Error("Coin shower density must be a finite non-negative number");
    }
    this.density = density;
  }

  setTier(tierIndex: number, burst = true): void {
    const density = BIG_WIN_COIN_PHYSICS.tierDensities[tierIndex];
    if (density === undefined) throw new Error(`Unknown Big Win coin tier: ${tierIndex}`);
    if (!this.emitting) this.start(density);
    else this.setDensity(density);
    if (burst) this.burst(BIG_WIN_COIN_PHYSICS.burstTicks);
  }

  /** 捕获的脉冲串：yForce = 4 + 电流密度时 15 个发射器滴答声。 */
  burst(ticks = BIG_WIN_COIN_PHYSICS.burstTicks): void {
    if (!Number.isInteger(ticks) || ticks < 0) {
      throw new Error("Coin shower burst ticks must be a non-negative integer");
    }
    const yForce = BIG_WIN_COIN_PHYSICS.normalYForce + this.density;
    for (let index = 0; index < ticks; index += 1) this.emitTick(yForce);
  }

  update(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0 || this.pools.length === 0) return;
    const tickMs = 1_000 / BIG_WIN_COIN_PHYSICS.tickRate;
    let remainingMs = deltaMs;

    while (remainingMs > 0) {
      const untilTick = tickMs - this.tickAccumulatorMs;
      const stepMs = Math.min(remainingMs, untilTick);
      const tickFraction = stepMs / tickMs;
      for (const pool of this.pools) pool.advance(tickFraction);
      this.tickAccumulatorMs += stepMs;
      remainingMs -= stepMs;

      if (this.tickAccumulatorMs + 1e-7 < tickMs) continue;
      this.tickAccumulatorMs = 0;
      if (this.emitting) this.emitTick(BIG_WIN_COIN_PHYSICS.normalYForce);
      for (const pool of this.pools) pool.tick();
    }
  }

  killAll(): void {
    for (const pool of this.pools) pool.killAll();
    this.emitting = false;
    this.emissionCounter = 0;
    this.poolIndex = 0;
    this.tickAccumulatorMs = 0;
  }

  override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    this.disposed = true;
    this.killAll();
    this.pools = [];
    super.destroy(options);
  }

  private emitTick(yForce: number): void {
    const step = advanceCoinEmissionCounter(this.emissionCounter, this.density);
    this.emissionCounter = step.counter;
    for (let index = 0; index < step.count; index += 1) {
      const pool = this.pools[this.poolIndex];
      pool?.emit(yForce);
      this.poolIndex = (this.poolIndex + 1) % BIG_WIN_COIN_POOL_SEQUENCE.length;
    }
  }
}

function populateCoinPools(pools: readonly CoinPoolRuntime[], count: number): void {
  let remaining = count;
  for (const pool of pools) {
    if (remaining <= 0) break;
    remaining -= pool.populate(remaining);
  }
  if (remaining !== 0) {
    throw new Error("Big Win coin pool initialization exceeded captured capacity");
  }
}

function destroyCoinPools(pools: readonly CoinPoolRuntime[]): void {
  for (const pool of pools) {
    pool.view.parent?.removeChild(pool.view);
    pool.view.destroy({ children: true });
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Big Win coin artwork load was aborted");
  error.name = "AbortError";
  throw error;
}

async function loadCoinAtlasManifest(signal?: AbortSignal): Promise<CoinAtlasManifest> {
  const response = await fetch(BIG_WIN_COIN_MANIFEST_URL, {
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) {
    const error = new Error(`Failed to load captured Big Win coins (${response.status})`);
    cancelNetworkResponse(response, error);
    throw error;
  }
  const encoded = await readBoundedResponseText(response, {
    label: "Big Win coin manifest",
    maxBytes: NETWORK_RESPONSE_LIMITS.rendererTextBytes,
    signal,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error("Invalid captured Big Win coin manifest JSON");
  }
  return parseCoinAtlasManifest(parsed);
}

function parseCoinAtlasManifest(value: unknown): CoinAtlasManifest {
  const manifest = value as Partial<CoinAtlasManifest> | null;
  if (
    manifest?.schemaVersion !== 1
    || manifest.tickRate !== BIG_WIN_COIN_PHYSICS.tickRate
    || manifest.atlas?.width !== 2_045
    || manifest.atlas.height !== 2_365
    || !Array.isArray(manifest.coins)
    || manifest.coins.length !== BIG_WIN_COIN_IDS.length
  ) {
    throw new Error("Invalid captured Big Win coin manifest");
  }
  for (const id of BIG_WIN_COIN_IDS) {
    const coin = manifest.coins.find((entry) => entry?.id === id);
    if (!coin || coin.frames.length !== BIG_WIN_COIN_PHYSICS.framesPerCoin) {
      throw new Error(`Invalid captured Big Win coin frames: ${id}`);
    }
    for (const frame of coin.frames) {
      if (
        frame.rotated
        || frame.sourceSize.width !== 46
        || frame.sourceSize.height !== 46
        || frame.pivot.x !== 23
        || frame.pivot.y !== 23
      ) {
        throw new Error(`Unexpected captured Big Win coin crop: ${id}`);
      }
    }
  }
  return manifest as CoinAtlasManifest;
}

function makeCoinTextures(
  manifest: CoinAtlasManifest,
  atlas: Texture,
): ReadonlyMap<BigWinCoinId, readonly Texture[]> {
  const result = new Map<BigWinCoinId, readonly Texture[]>();
  for (const coin of manifest.coins) {
    result.set(coin.id, coin.frames.map((spec) => new Texture(
      atlas.baseTexture,
      new Rectangle(spec.frame.x, spec.frame.y, spec.frame.width, spec.frame.height),
      new Rectangle(0, 0, spec.sourceSize.width, spec.sourceSize.height),
      spec.trimmed
        ? new Rectangle(
            spec.spriteSourceSize.x,
            spec.spriteSourceSize.y,
            spec.spriteSourceSize.width,
            spec.spriteSourceSize.height,
          )
        : undefined,
    )));
  }
  return result;
}
