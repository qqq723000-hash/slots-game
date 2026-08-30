import {
  BLEND_MODES,
  Container,
  ParticleContainer,
  Rectangle,
  Sprite,
  Texture,
} from "pixi.js";
import { PRIMAL_ASSETS } from "../assets/PrimalAssetManifest";
import {
  runFrameSlicedInitialization,
  type FrameRequest,
} from "../startup/frameSlicedInitialization";
import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from "./theme";

export type PrimalParticlePalette = "main" | "fire" | "snow";

export const PRIMAL_PARTICLE_POOL_CAPACITY = 4_100;
export const PRIMAL_PARTICLE_INIT_BATCH_SIZE = 128;

export interface PrimalBackgroundParticleLoadOptions {
  readonly signal?: AbortSignal;
  readonly requestFrame?: FrameRequest;
  readonly batchSize?: number;
  readonly onProgress?: (fraction: number) => void;
}

type Range = readonly [number, number];

interface TextureSpec {
  readonly frame: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly tint: number;
}

interface TweenSpec {
  readonly start: Range;
  readonly addition: Range;
  readonly durationSeconds: number;
  readonly mirrorStart?: boolean;
}

interface SpeedSpec {
  readonly speed: Range;
  readonly angle: Range;
}

interface SpreadSpec {
  readonly x: Range;
  readonly y: Range;
}

interface WiggleSpec {
  readonly speed1: Range;
  readonly speed2: Range;
  readonly amplitude: Range;
}

interface WindSpec {
  readonly angle: number;
  readonly speed: Range;
  readonly strength: Range;
  readonly updateRepeats: number;
}

interface VortexSpec {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly speed: number;
}

interface OrbitSpec {
  readonly x: number;
  readonly y: number;
  readonly strength: number;
}

interface PoolSpec {
  readonly capacity: number;
  readonly texture: keyof typeof PARTICLE_TEXTURES;
  readonly speed?: SpeedSpec;
  readonly spread?: SpreadSpec;
  readonly size: TweenSpec;
  readonly alpha?: TweenSpec;
  readonly wiggle?: WiggleSpec;
  readonly winds: readonly WindRuntime[];
  readonly vortex?: VortexSpec;
  readonly orbit?: OrbitSpec;
  readonly bounds: BoundsSpec;
  readonly lifetime: LifetimeSpec;
}

interface BoundsSpec {
  readonly x: Range;
  readonly y: Range;
}

interface LifetimeSpec {
  readonly maxAge: Range;
  readonly fade: Range;
}

interface Particle {
  readonly sprite: Sprite;
  px: number;
  py: number;
  vx: number;
  vy: number;
  elapsedMs: number;
  size: number;
  alpha: number;
  sizeStart: number;
  sizeAddition: number;
  alphaStart: number;
  alphaAddition: number;
  wiggleSpeed1: number;
  wiggleSpeed2: number;
  wiggleAmplitude: number;
  maxAgeSeconds: number;
  fadeSeconds: number;
}

type RandomSource = () => number;

/** 捕获的 main_texture0 (10059.avif) 中的本机 1 级帧。 / English: Captured native level 1 frame in main_texture0 (10059.avif). */
export const PRIMAL_PARTICLE_ATLAS_REGIONS = Object.freeze({
  fire: Object.freeze({
    frame: Object.freeze({ x: 1_412, y: 792, width: 120, height: 120 }),
    sourceWidth: 150,
    sourceHeight: 150,
    tint: 0xffffff,
  }),
  snow: Object.freeze({
    frame: Object.freeze({ x: 1_288, y: 792, width: 120, height: 120 }),
    sourceWidth: 150,
    sourceHeight: 150,
    tint: 0x96b4ff,
  }),
  stronger: Object.freeze({
    frame: Object.freeze({ x: 0, y: 792, width: 412, height: 412 }),
    sourceWidth: 512,
    sourceHeight: 512,
    tint: 0xff0000,
  }),
});

const PARTICLE_TEXTURES = PRIMAL_PARTICLE_ATLAS_REGIONS;
const UPWARD_BOUNDS = Object.freeze({ x: [-1_125, 1_003], y: [-1_505, 1_600] } as const);
const SIDE_BOUNDS = Object.freeze({ x: [-1_003, 1_003], y: [-1_505, 1_532] } as const);
const LONG_LIFETIME = Object.freeze({ maxAge: [1, 2], fade: [0, 4.5] } as const);
const SIDE_LIFETIME = Object.freeze({ maxAge: [1, 9], fade: [0, 3] } as const);
const UP_ALPHA = Object.freeze({ start: [-0.75, 1], addition: [1, 1], durationSeconds: 2 } as const);
const SIDE_ALPHA = Object.freeze({ start: [-0.3, 0.15], addition: [1, 1], durationSeconds: 1 } as const);
const UP_WIGGLE = Object.freeze({ speed1: [0, 15], speed2: [0, 30], amplitude: [5, 10] } as const);
const SIDE_WIGGLE = Object.freeze({ speed1: [0, 10], speed2: [0, 25], amplitude: [5, 10] } as const);
const VORTEX = Object.freeze({ x: -855, y: 1_222, radius: 500, speed: -60 });
const ORBIT = Object.freeze({ x: 41, y: 68, strength: 49 });

class WindRuntime {
  private currentPosition = -1_600;
  private currentSpeed = 0;
  private currentStrength = 0;
  private startTimeMs = 0;

  constructor(
    readonly spec: WindSpec,
    private readonly random: RandomSource,
  ) {
    this.reset(0);
  }

  update(deltaMs: number, elapsedMs: number): void {
    for (let index = 0; index < this.spec.updateRepeats; index += 1) {
      // 所有捕获的风都具有零延迟范围。保留经过的保护，以便运行时准确遵循源修改器的状态机。 / English: All captured winds have zero latency range. Preserves passing protections so that the runtime accurately follows the source modifier's state machine.
      if (elapsedMs < this.startTimeMs) continue;
      this.currentPosition += deltaMs * this.currentSpeed * 0.05;
      if (this.currentPosition > 1_600) this.reset(elapsedMs);
    }
  }

  apply(particle: Particle, deltaMs: number): void {
    const radians = this.spec.angle * Math.PI / 180;
    const directionX = Math.cos(radians);
    const directionY = Math.sin(radians);
    const frontX = this.currentPosition * directionX;
    const frontY = this.currentPosition * directionY;
    let distance: number;

    if (this.spec.angle % 90 === 0) {
      distance = Math.abs(Math.abs(this.spec.angle) === 90
        ? particle.py - frontY
        : particle.px - frontX);
    } else {
      const projection = (particle.px * frontX + particle.py * frontY)
        / (frontX * frontX + frontY * frontY || 1);
      const projectionX = projection * frontX;
      const projectionY = projection * frontY;
      distance = Math.hypot(projectionX - frontX, projectionY - frontY);
    }

    const influence = 1 - 0.1 * distance / this.currentStrength;
    if (influence <= 0) return;
    const scaledSpeed = 0.005 * this.currentSpeed;
    const impulse = influence * deltaMs * 0.001 * scaledSpeed * scaledSpeed * this.currentStrength;
    particle.vx += impulse * directionX;
    particle.vy += impulse * directionY;
  }

  private reset(elapsedMs: number): void {
    this.currentPosition = -1_600;
    this.currentSpeed = sample(this.spec.speed, this.random);
    this.currentStrength = sample(this.spec.strength, this.random);
    this.startTimeMs = elapsedMs;
  }
}

class EmitterRuntime {
  private time = 1_000;
  enabled = false;

  constructor(
    readonly frequency: number,
    readonly count: number,
    readonly x: number,
    readonly y: number,
  ) {}

  update(deltaMs: number, emit: (x: number, y: number) => void): void {
    this.time += deltaMs * this.frequency;
    while (this.time >= 1_000) {
      this.time -= 1_000;
      if (!this.enabled) continue;
      for (let index = 0; index < this.count; index += 1) emit(this.x, this.y);
    }
  }
}

class PoolRuntime {
  readonly view: ParticleContainer;
  readonly emitters: EmitterRuntime[] = [];
  private readonly active: Particle[] = [];
  private readonly free: Particle[] = [];
  private initializedCount = 0;

  constructor(
    private readonly spec: PoolSpec,
    private readonly texture: Texture,
    private readonly random: RandomSource,
  ) {
    this.view = new ParticleContainer(
      spec.capacity,
      { position: true, rotation: true, scale: true, alpha: true, tint: true },
      Math.min(spec.capacity, 1_024),
      false,
    );
    this.view.blendMode = BLEND_MODES.ADD;
  }

  populate(limit: number): number {
    const count = Math.min(
      Math.max(0, Math.floor(limit)),
      this.spec.capacity - this.initializedCount,
    );
    const textureSpec = PARTICLE_TEXTURES[this.spec.texture];
    for (let index = 0; index < count; index += 1) {
      const sprite = new Sprite(this.texture);
      sprite.anchor.set(0.5);
      sprite.tint = textureSpec.tint;
      sprite.alpha = 0;
      this.free.push(this.makeParticle(sprite));
    }
    this.initializedCount += count;
    return count;
  }

  get capacity(): number {
    return this.spec.capacity;
  }

  get initialized(): number {
    return this.initializedCount;
  }

  updateEmitters(deltaMs: number): void {
    for (const emitter of this.emitters) emitter.update(deltaMs, (x, y) => this.emit(x, y));
  }

  updateParticles(deltaMs: number): void {
    for (let index = this.active.length - 1; index >= 0; index -= 1) {
      const particle = this.active[index];
      if (!particle) continue;
      particle.elapsedMs += deltaMs;
      const elapsedSeconds = particle.elapsedMs * 0.001;

      particle.size = tweenValue(
        particle.sizeStart,
        particle.sizeAddition,
        elapsedSeconds,
        this.spec.size.durationSeconds,
      );
      if (this.spec.alpha) {
        particle.alpha = tweenValue(
          particle.alphaStart,
          particle.alphaAddition,
          elapsedSeconds,
          this.spec.alpha.durationSeconds,
        );
      }

      if (this.spec.wiggle) applyWiggle(particle, deltaMs);
      for (const wind of this.spec.winds) wind.apply(particle, deltaMs);
      if (this.spec.vortex) applyVortex(particle, this.spec.vortex, deltaMs);
      if (this.spec.orbit) applyOrbit(particle, this.spec.orbit, deltaMs);

      particle.px += particle.vx * deltaMs;
      particle.py += particle.vy * deltaMs;

      if (!insideBounds(particle, this.spec.bounds)) {
        this.recycle(index, particle);
        continue;
      }

      if (elapsedSeconds > particle.maxAgeSeconds) {
        if (elapsedSeconds > particle.maxAgeSeconds + particle.fadeSeconds) {
          this.recycle(index, particle);
          continue;
        }
        particle.alpha = particle.fadeSeconds > 0
          ? 1 - (elapsedSeconds - particle.maxAgeSeconds) / particle.fadeSeconds
          : 0;
      }
      this.applySprite(particle);
    }
  }

  killAll(): void {
    for (let index = this.active.length - 1; index >= 0; index -= 1) {
      const particle = this.active[index];
      if (particle) this.recycle(index, particle);
    }
  }

  get activeCount(): number {
    return this.active.length;
  }

  private emit(x: number, y: number): void {
    const particle = this.free.pop();
    if (!particle) return;
    particle.px = x;
    particle.py = y;
    particle.elapsedMs = 0;
    particle.alpha = 1;
    particle.size = 100;

    if (this.spec.speed) {
      const speed = sample(this.spec.speed.speed, this.random) * 0.01;
      const angle = sample(this.spec.speed.angle, this.random) * Math.PI / 180;
      particle.vx = Math.cos(angle) * speed;
      particle.vy = Math.sin(angle) * speed;
    } else {
      particle.vx = 0;
      particle.vy = 0;
    }
    if (this.spec.spread) {
      particle.px += sample(this.spec.spread.x, this.random);
      particle.py += sample(this.spec.spread.y, this.random);
    }

    particle.sizeStart = sample(this.spec.size.start, this.random, this.spec.size.mirrorStart);
    particle.sizeAddition = sample(this.spec.size.addition, this.random);
    particle.size = particle.sizeStart;
    particle.alphaStart = this.spec.alpha ? sample(this.spec.alpha.start, this.random) : 1;
    particle.alphaAddition = this.spec.alpha ? sample(this.spec.alpha.addition, this.random) : 0;
    particle.alpha = particle.alphaStart;
    if (this.spec.wiggle) {
      particle.wiggleSpeed1 = 0.0005 * sample(this.spec.wiggle.speed1, this.random);
      particle.wiggleSpeed2 = 0.0005 * sample(this.spec.wiggle.speed2, this.random);
      particle.wiggleAmplitude = 0.1 * sample(this.spec.wiggle.amplitude, this.random);
    } else {
      particle.wiggleSpeed1 = 0;
      particle.wiggleSpeed2 = 0;
      particle.wiggleAmplitude = 0;
    }
    particle.maxAgeSeconds = sample(this.spec.lifetime.maxAge, this.random);
    particle.fadeSeconds = sample(this.spec.lifetime.fade, this.random);
    this.view.addChild(particle.sprite);
    this.active.push(particle);
  }

  private recycle(index: number, particle: Particle): void {
    particle.sprite.alpha = 0;
    this.view.removeChild(particle.sprite);
    const last = this.active.pop();
    if (last && last !== particle) this.active[index] = last;
    this.free.push(particle);
  }

  private applySprite(particle: Particle): void {
    const textureSpec = PARTICLE_TEXTURES[this.spec.texture];
    const diagonal = Math.hypot(textureSpec.sourceWidth, textureSpec.sourceHeight);
    const width = particle.size * textureSpec.sourceWidth / diagonal;
    const height = particle.size * textureSpec.sourceHeight / diagonal;
    particle.sprite.position.set(particle.px, particle.py);
    particle.sprite.scale.set(
      width / textureSpec.frame.width,
      height / textureSpec.frame.height,
    );
    particle.sprite.alpha = particle.alpha;
  }

  private makeParticle(sprite: Sprite): Particle {
    return {
      sprite,
      px: 0,
      py: 0,
      vx: 0,
      vy: 0,
      elapsedMs: 0,
      size: 100,
      alpha: 1,
      sizeStart: 100,
      sizeAddition: 0,
      alphaStart: 1,
      alphaAddition: 0,
      wiggleSpeed1: 0,
      wiggleSpeed2: 0,
      wiggleAmplitude: 0,
      maxAgeSeconds: 1,
      fadeSeconds: 0,
    };
  }
}

class ParticleSystemRuntime {
  readonly view = new Container();
  readonly emitters: readonly EmitterRuntime[];
  private elapsedMs = 0;

  constructor(
    readonly palette: Exclude<PrimalParticlePalette, "main">,
    private readonly pools: readonly PoolRuntime[],
    emitters: readonly EmitterRuntime[],
    private readonly winds: readonly WindRuntime[],
  ) {
    this.emitters = emitters;
    this.view.addChild(...pools.map((pool) => pool.view));
  }

  update(deltaMs: number): void {
    this.elapsedMs += deltaMs;
    for (const wind of this.winds) wind.update(deltaMs, this.elapsedMs);
    // 池顺序是创作行为：snow 的共享 L 发射器故意提前 P0 -> P1 -> P2，而不是在一批中扇出。 / English: Pool ordering is an act of creation: snow's shared L emitter is deliberately advanced P0 -> P1 -> P2, rather than fanning out in a batch.
    for (const pool of this.pools) {
      pool.updateEmitters(deltaMs);
      pool.updateParticles(deltaMs);
    }
  }

  setEmitting(emitting: boolean): void {
    for (const emitter of this.emitters) emitter.enabled = emitting;
  }

  killAll(): void {
    for (const pool of this.pools) pool.killAll();
  }

  populate(limit: number): number {
    let created = 0;
    for (const pool of this.pools) {
      if (created >= limit) break;
      created += pool.populate(limit - created);
    }
    return created;
  }

  get capacity(): number {
    return this.pools.reduce((total, pool) => total + pool.capacity, 0);
  }

  get initializedCount(): number {
    return this.pools.reduce((total, pool) => total + pool.initialized, 0);
  }

  get activeCount(): number {
    return this.pools.reduce((total, pool) => total + pool.activeCount, 0);
  }
}

/**
 * 捕获 Primal Rampage 背景粒子运行时。
 *
 * 将此容器安装为预设的前台 Spine 的同级容器。该类拥有源阶段中心/规模、发射器节奏和固定池；调用者只需加载它，选择调色板并转发帧增量。
 *
 * 英文 / English: Capture Primal Rampage background particles while running. Install this container as a sibling of the default front-end Spine. This class holds the source stage center/scale, emitter cadence, and fixed pool; the caller simply loads it, selects the palette and forwards the frame delta.
 */
export class PrimalBackgroundParticles extends Container {
  private readonly random: RandomSource;
  private loadPromise: Promise<void> | null = null;
  private systems: ParticleSystemRuntime[] = [];
  private palette: PrimalParticlePalette = "main";
  private reducedMotion = false;
  private disposed = false;

  constructor(random: RandomSource = Math.random) {
    super();
    this.random = random;
    this.position.set(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2);
    this.scale.set(Math.min(LOGICAL_WIDTH / 1_200, LOGICAL_HEIGHT / 900));
  }

  load(options: PrimalBackgroundParticleLoadOptions = {}): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    if (options.signal?.aborted) return Promise.reject(particleAbortReason(options.signal));
    const attempt = Texture.fromURL(PRIMAL_ASSETS.atlases.particles).then(async (atlas) => {
      if (this.disposed) return;
      throwIfParticleAborted(options.signal);
      const textures = makeTextures(atlas);
      const systems = makeSystems(textures, this.random);
      if (this.disposed) return;
      try {
        this.systems = systems;
        this.addChild(...systems.map((system) => system.view));
        options.onProgress?.(0);
        const totalCapacity = systems.reduce((total, system) => total + system.capacity, 0);
        if (totalCapacity !== PRIMAL_PARTICLE_POOL_CAPACITY) {
          throw new Error(`Unexpected Primal particle pool capacity ${totalCapacity}`);
        }
        await runFrameSlicedInitialization(
          totalCapacity,
          (_start, count) => {
            let remaining = count;
            for (const system of systems) {
              if (remaining <= 0) break;
              remaining -= system.populate(remaining);
            }
            if (remaining !== 0) {
              throw new Error(`Primal particle initialization left ${remaining} entries unbuilt`);
            }
          },
          {
            batchSize: options.batchSize ?? PRIMAL_PARTICLE_INIT_BATCH_SIZE,
            signal: options.signal,
            requestFrame: options.requestFrame,
            isCancelled: () => this.disposed,
            onProgress: options.onProgress,
          },
        );
        throwIfParticleAborted(options.signal);
        if (this.disposed) return;
        this.applyEmissionState();
      } catch (error) {
        // 取消的部分构建永远不可重用。在清除缓存的 Promise 之前分离其容器，以便重试无法堆叠池。 / English: Canceled partial builds can never be reused. Detach a cached Promise's container before clearing its container so that retries fail to stack the pool.
        if (!this.disposed && this.systems === systems) {
          for (const system of systems) {
            if (system.view.parent === this) this.removeChild(system.view);
            system.view.destroy({ children: true });
          }
          this.systems = [];
        }
        throw error;
      }
    });
    this.loadPromise = attempt;
    void attempt.catch(() => {
      if (!this.disposed && this.loadPromise === attempt) this.loadPromise = null;
    });
    return attempt;
  }

  update(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    for (const system of this.systems) system.update(deltaMs);
  }

  setPalette(palette: PrimalParticlePalette): void {
    this.palette = palette;
    this.applyEmissionState();
  }

  setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
    this.applyEmissionState();
    if (reducedMotion) this.killAll();
  }

  killAll(): void {
    for (const system of this.systems) system.killAll();
  }

  get activeParticleCount(): number {
    return this.systems.reduce((total, system) => total + system.activeCount, 0);
  }

  get initializedParticleCount(): number {
    return this.systems.reduce((total, system) => total + system.initializedCount, 0);
  }

  override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    this.disposed = true;
    this.killAll();
    this.systems = [];
    super.destroy(options);
  }

  private applyEmissionState(): void {
    for (const system of this.systems) {
      system.setEmitting(!this.reducedMotion && system.palette === this.palette);
    }
  }
}

function makeTextures(atlas: Texture): Readonly<Record<keyof typeof PARTICLE_TEXTURES, Texture>> {
  return {
    fire: frameTexture(atlas, PARTICLE_TEXTURES.fire),
    snow: frameTexture(atlas, PARTICLE_TEXTURES.snow),
    stronger: frameTexture(atlas, PARTICLE_TEXTURES.stronger),
  };
}

function frameTexture(atlas: Texture, spec: TextureSpec): Texture {
  return new Texture(
    atlas.baseTexture,
    new Rectangle(spec.frame.x, spec.frame.y, spec.frame.width, spec.frame.height),
  );
}

function makeSystems(
  textures: Readonly<Record<keyof typeof PARTICLE_TEXTURES, Texture>>,
  random: RandomSource,
): ParticleSystemRuntime[] {
  const upwardWind1 = new WindRuntime(
    { angle: -55, speed: [61, 72], strength: [43, 64], updateRepeats: 3 },
    random,
  );
  const upwardWind2 = new WindRuntime(
    { angle: -134, speed: [26, 75], strength: [13, 54], updateRepeats: 2 },
    random,
  );
  const upwardEmitters = [
    new EmitterRuntime(2, 6, -881, 1_356),
    new EmitterRuntime(2, 30, 0, 1_505),
    new EmitterRuntime(15, 100, -7, 1_600),
  ] as const;
  const upwardPools = [
    new PoolRuntime({
      capacity: 500,
      texture: "fire",
      speed: { speed: [5, 38], angle: [253, 360] },
      spread: { x: [-207, 530], y: [0, 125] },
      size: { start: [4, 169], addition: [-25, 97], durationSeconds: 10, mirrorStart: true },
      alpha: UP_ALPHA,
      wiggle: UP_WIGGLE,
      winds: [upwardWind1, upwardWind2],
      vortex: VORTEX,
      bounds: UPWARD_BOUNDS,
      lifetime: LONG_LIFETIME,
    }, textures.fire, random),
    new PoolRuntime({
      capacity: 500,
      texture: "stronger",
      speed: { speed: [5, 51], angle: [222, 266] },
      spread: { x: [-1_000, 1_000], y: [0, 0] },
      size: { start: [17, 59], addition: [0, 0], durationSeconds: 8.56 },
      alpha: UP_ALPHA,
      wiggle: UP_WIGGLE,
      winds: [upwardWind1],
      bounds: UPWARD_BOUNDS,
      lifetime: LONG_LIFETIME,
    }, textures.stronger, random),
    new PoolRuntime({
      capacity: 300,
      texture: "fire",
      speed: { speed: [5, 10], angle: [204, 288] },
      spread: { x: [-207, 530], y: [0, 125] },
      size: { start: [4, 169], addition: [-25, 97], durationSeconds: 10, mirrorStart: true },
      alpha: UP_ALPHA,
      wiggle: UP_WIGGLE,
      winds: [upwardWind1, upwardWind2],
      vortex: VORTEX,
      bounds: UPWARD_BOUNDS,
      lifetime: LONG_LIFETIME,
    }, textures.fire, random),
  ];
  upwardPools[0]!.emitters.push(upwardEmitters[0]);
  upwardPools[1]!.emitters.push(upwardEmitters[1]);
  upwardPools[2]!.emitters.push(upwardEmitters[2]);

  const sideWind1 = new WindRuntime(
    { angle: -69, speed: [20, 30], strength: [5, 45], updateRepeats: 2 },
    random,
  );
  const sideWind2 = new WindRuntime(
    { angle: -107, speed: [10, 30], strength: [5, 30], updateRepeats: 1 },
    random,
  );
  const sideEmitters = [
    new EmitterRuntime(3, 10, -915, 328),
    new EmitterRuntime(60, 100, 0, 800),
    new EmitterRuntime(3, 8, 700, 400),
  ] as const;
  const sidePools = [
    new PoolRuntime({
      capacity: 500,
      texture: "fire",
      speed: { speed: [5, 10], angle: [253, 322] },
      spread: { x: [-347, 412], y: [-568, 100] },
      size: { start: [4, 64], addition: [-25, -5], durationSeconds: 1.95 },
      alpha: SIDE_ALPHA,
      wiggle: SIDE_WIGGLE,
      winds: [sideWind1],
      orbit: ORBIT,
      bounds: SIDE_BOUNDS,
      lifetime: SIDE_LIFETIME,
    }, textures.fire, random),
    new PoolRuntime({
      capacity: 500,
      texture: "stronger",
      speed: { speed: [5, 51], angle: [222, 266] },
      spread: { x: [-1_000, 1_000], y: [0, 0] },
      size: { start: [8, 8], addition: [0, 0], durationSeconds: 20 },
      wiggle: SIDE_WIGGLE,
      winds: [sideWind1],
      orbit: ORBIT,
      bounds: SIDE_BOUNDS,
      lifetime: SIDE_LIFETIME,
    }, textures.stronger, random),
    new PoolRuntime({
      capacity: 500,
      texture: "fire",
      speed: { speed: [5, 10], angle: [204, 288] },
      spread: { x: [-347, 412], y: [-568, 100] },
      size: { start: [4, 64], addition: [-25, -5], durationSeconds: 1.95 },
      alpha: SIDE_ALPHA,
      wiggle: SIDE_WIGGLE,
      winds: [sideWind2],
      orbit: ORBIT,
      bounds: SIDE_BOUNDS,
      lifetime: SIDE_LIFETIME,
    }, textures.fire, random),
  ];
  sidePools[0]!.emitters.push(sideEmitters[0]);
  sidePools[1]!.emitters.push(sideEmitters[1]);
  sidePools[2]!.emitters.push(sideEmitters[2]);

  const snowWind1 = new WindRuntime(
    { angle: 23, speed: [61, 89], strength: [43, 68], updateRepeats: 3 },
    random,
  );
  const snowWind2 = new WindRuntime(
    { angle: 49, speed: [26, 75], strength: [13, 79], updateRepeats: 3 },
    random,
  );
  const sharedSnow = new EmitterRuntime(14.3, 30, -881, -448);
  const highSnow = new EmitterRuntime(3, 30, 0, -841);
  const centreSnow = new EmitterRuntime(15, 100, -305, -1_424);
  const lowSnow = new EmitterRuntime(7, 32, -203, 1_112);
  const snowPools = [
    new PoolRuntime({
      capacity: 500,
      texture: "snow",
      spread: { x: [-1_000, 1_000], y: [-1_000, 659] },
      size: { start: [2, 76], addition: [-25, 63], durationSeconds: 10, mirrorStart: true },
      alpha: UP_ALPHA,
      winds: [snowWind1, snowWind2],
      vortex: VORTEX,
      bounds: UPWARD_BOUNDS,
      lifetime: LONG_LIFETIME,
    }, textures.snow, random),
    new PoolRuntime({
      capacity: 500,
      texture: "snow",
      speed: { speed: [5, 51], angle: [222, 266] },
      spread: { x: [-1_000, 1_000], y: [-1_000, 1_000] },
      size: { start: [10, 59], addition: [0, 0], durationSeconds: 8.56 },
      alpha: UP_ALPHA,
      winds: [snowWind1, snowWind2],
      bounds: UPWARD_BOUNDS,
      lifetime: LONG_LIFETIME,
    }, textures.snow, random),
    new PoolRuntime({
      capacity: 300,
      texture: "snow",
      speed: { speed: [5, 10], angle: [204, 288] },
      spread: { x: [-1_000, 1_000], y: [-1_000, 659] },
      size: { start: [4, 67], addition: [-25, 97], durationSeconds: 10, mirrorStart: true },
      alpha: UP_ALPHA,
      winds: [snowWind1, snowWind2],
      vortex: VORTEX,
      bounds: UPWARD_BOUNDS,
      lifetime: LONG_LIFETIME,
    }, textures.snow, random),
  ];
  snowPools[0]!.emitters.push(sharedSnow, lowSnow);
  snowPools[1]!.emitters.push(sharedSnow, highSnow);
  snowPools[2]!.emitters.push(sharedSnow, centreSnow);

  return [
    new ParticleSystemRuntime("fire", upwardPools, upwardEmitters, [upwardWind1, upwardWind2]),
    new ParticleSystemRuntime("fire", sidePools, sideEmitters, [sideWind1, sideWind2]),
    new ParticleSystemRuntime(
      "snow",
      snowPools,
      [sharedSnow, highSnow, centreSnow, lowSnow],
      [snowWind1, snowWind2],
    ),
  ];
}

function particleAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Primal particle initialization was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfParticleAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw particleAbortReason(signal);
}

function sample(range: Range, random: RandomSource, mirror = false): number {
  const value = random() * (range[1] - range[0]) + range[0];
  return mirror && random() < 0.5 ? -value : value;
}

function tweenValue(start: number, addition: number, elapsedSeconds: number, durationSeconds: number): number {
  if (durationSeconds <= 0 || elapsedSeconds >= durationSeconds) return start + addition;
  return start + addition * Math.max(0, elapsedSeconds / durationSeconds);
}

function applyWiggle(particle: Particle, deltaMs: number): void {
  const velocitySquared = particle.vx * particle.vx + particle.vy * particle.vy;
  if (velocitySquared <= 0) return;
  const wave = Math.sin(particle.elapsedMs * particle.wiggleSpeed1)
    + Math.sin(particle.elapsedMs * particle.wiggleSpeed2);
  const displacement = wave * particle.wiggleAmplitude * deltaMs * 0.05 / Math.sqrt(velocitySquared);
  particle.px += particle.vy * displacement;
  particle.py -= particle.vx * displacement;
}

function applyVortex(particle: Particle, spec: VortexSpec, deltaMs: number): void {
  const dx = particle.px - spec.x;
  const dy = particle.py - spec.y;
  const radius = Math.hypot(dx, dy);
  if (!radius || !spec.radius || radius > spec.radius) return;
  const attenuation = 1 - (radius / spec.radius) ** 2;
  const arc = spec.speed * attenuation * deltaMs * 0.01;
  const angle = Math.atan2(dy, dx) + arc / radius;
  particle.px = spec.x + Math.cos(angle) * radius;
  particle.py = spec.y + Math.sin(angle) * radius;
}

function applyOrbit(particle: Particle, spec: OrbitSpec, deltaMs: number): void {
  const dx = particle.px - spec.x;
  const dy = particle.py - spec.y;
  const distanceSquared = dx * dx + dy * dy || 0.001;
  const amount = spec.strength * deltaMs / distanceSquared;
  particle.px += dy * amount;
  particle.py -= dx * amount;
}

function insideBounds(particle: Particle, bounds: BoundsSpec): boolean {
  return particle.px >= bounds.x[0]
    && particle.px <= bounds.x[1]
    && particle.py >= bounds.y[0]
    && particle.py <= bounds.y[1];
}
