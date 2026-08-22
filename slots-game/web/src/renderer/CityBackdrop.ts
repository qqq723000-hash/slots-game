import { BLEND_MODES, Container, Graphics, Rectangle, Sprite, Texture, filters } from "pixi.js";
import {
  ENVIRONMENT_REGIONS,
  ENVIRONMENT_VIEW,
  PRIMAL_ASSETS,
} from "../assets/PrimalAssetManifest";
import {
  createSpineView,
  SPINE_DEFAULT_MIX_SECONDS,
  type Spine,
} from "./spine/SpineAdapter";
import { loadPrimalSpineSet } from "./spine/PrimalSpineAssets";
import type { SpinEnvironmentFrame } from "./spinEnvironmentMotion";
import { IDLE_SPIN_ENVIRONMENT_FRAME } from "./spinEnvironmentMotion";
import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from "./theme";
import { PrimalBackgroundParticles } from "./PrimalBackgroundParticles";
import type { ResponsiveNodeTransform } from "./ResponsiveLayout";

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

export type AuthoredBackdropPalette = "main" | "fire" | "snow";

/** 在捕获的桌面控制器中跟踪 GameBackground 的分配。 */
export const PRIMAL_BACKGROUND_TRACK = Object.freeze({
  mobile: 0,
  base: 1,
  transition: 2,
  auxBegin: 3,
  auxEnd: 14,
  cannon: 15,
  shake: 16,
});

/**
 * 在 1280x720 桌面表面上捕获 1200x900 GameBackground 变换。 Pixi-Spine 此处使用骨架的居中原点； 0.8 包含比例和帧缓冲区中心，
 * 保留预设的街道级摄像机停止点。
 */
export const PRIMAL_BACKGROUND_STAGE_TRANSFORM = Object.freeze({
  x: LOGICAL_WIDTH / 2,
  y: LOGICAL_HEIGHT / 2,
  scale: Math.min(LOGICAL_WIDTH / 1_200, LOGICAL_HEIGHT / 900),
});

export const PRIMAL_BACKGROUND_AUX_TRACKS = Object.freeze({
  main: Object.freeze([
    [3, "bg_main_Clouds_Loop"],
    [5, "Fire_loop_1_MAIN_and_fire"],
    [6, "Fire_loop_2_MAIN_and_fire"],
    [7, "smoke_1_main_and_fire"],
    [8, "smoke_2_main_and_fire"],
  ] as const),
  fire: Object.freeze([
    [3, "Trafficlight_loop"],
    [4, "Fire_loop_1_fs_fire_bg"],
    [5, "Fire_loop_1_MAIN_and_fire"],
    [6, "Fire_loop_2_fs_fire_bg"],
    [7, "Fire_loop_2_MAIN_and_fire"],
    [8, "fs_bg_fire_glows_loop"],
    [9, "smoke_1_fire_bg"],
    [10, "smoke_1_main_and_fire"],
    [11, "smoke_2_fire_bg"],
    [12, "smoke_2_main_and_fire"],
  ] as const),
  snow: Object.freeze([] as const),
});

export function authoredBackgroundTransition(
  from: AuthoredBackdropPalette,
  to: AuthoredBackdropPalette,
): string | null {
  if (from === to) return null;
  if (to === "main") return from === "snow" ? "bg_snow_to_main" : "bg_fire_to_main";
  return to === "snow" ? "bg_main_to_snow" : "bg_main_to_fire";
}

export interface MonsterReactionFrame {
  readonly eyeBoost: number;
  readonly pulseAlpha: number;
  readonly pulseScale: number;
  readonly lightningAlpha: number;
}

/** 确定性的外观值；这里没有推导出任何游戏事实。 */
export function monsterReactionFrame(progress: number, reducedMotion: boolean): MonsterReactionFrame {
  const value = clamp(progress);
  const envelope = Math.sin(Math.PI * value);
  if (reducedMotion) {
    return {
      eyeBoost: envelope * 0.48,
      pulseAlpha: envelope * 0.14,
      pulseScale: 0.86 + value * 0.18,
      lightningAlpha: 0,
    };
  }
  return {
    eyeBoost: envelope * 0.82,
    pulseAlpha: envelope * 0.42,
    pulseScale: 0.58 + (1 - (1 - value) ** 3) * 1.42,
    lightningAlpha: envelope * (0.46 + Math.sin(value * Math.PI * 13) ** 2 * 0.34),
  };
}

interface ActiveReaction {
  handle: number | null;
  finish(): void;
}

interface PendingBitmapArtwork {
  readonly daylightTexture: Texture;
  readonly destroyedTexture: Texture;
  readonly leftPuff: Sprite;
  readonly rightPuff: Sprite;
  readonly artworkScale: number;
  readonly trackHeight: number;
}

interface PendingAuthoredArtwork {
  readonly background: Spine;
  readonly foreground: Spine;
}

export const CITY_BACKDROP_LOAD_PARTS = Object.freeze([
  "bitmap",
  "authored",
  "particles",
] as const);
export type CityBackdropLoadPart = (typeof CITY_BACKDROP_LOAD_PARTS)[number];

/**
 * 结合三个独立的背景分支，不允许陈旧或倒退的儿童记者向后移动公共启动栏。
 */
export function createCityBackdropLoadProgressReporter(
  publish: (fraction: number) => void,
  isActive: () => boolean = () => true,
): (part: CityBackdropLoadPart, fraction: number) => void {
  const fractions: Record<CityBackdropLoadPart, number> = {
    bitmap: 0,
    authored: 0,
    particles: 0,
  };
  let published = 0;
  return (part, fraction): void => {
    if (!isActive()) return;
    const normalized = Number.isFinite(fraction) ? clamp(fraction) : fractions[part];
    fractions[part] = Math.max(fractions[part], normalized);
    const aggregate = CITY_BACKDROP_LOAD_PARTS.reduce(
      (total, key) => total + fractions[key],
      0,
    ) / CITY_BACKDROP_LOAD_PARTS.length;
    if (aggregate <= published) return;
    published = aggregate;
    publish(aggregate);
  };
}

/**
 * 源图稿包含两条 1366×2676 的垂直镜头轨道。Base 玩法显示街道底部；转轴扩展时镜头沿城市上移，
 * 同时特性能量交叉淡入受损的橙色画面。
 */
export class CityBackdrop extends Container {
  /** 预设的前台由 PixiRenderer 安装在游戏层之前。 */
  readonly foregroundView = new Container();
  private readonly authoredParticles = new PrimalBackgroundParticles();
  private readonly fallback = new Graphics();
  private readonly daylight = new Sprite(Texture.EMPTY);
  private readonly destroyedPlate = new Sprite(Texture.EMPTY);
  private readonly authoredBackdropHost = new Container();
  private readonly daylightWarmth = new Graphics();
  private readonly parallax = new Container();
  private readonly smoke = new Container();
  private readonly embers = new Container();
  private readonly speedShade = new Graphics();
  private readonly featureBloom = new Graphics();
  private readonly reactionPulse = new Graphics();
  private readonly reactionLightning = new Graphics();
  private readonly vignette = new Graphics();
  private loadPromise: Promise<void> | null = null;
  private loadProgress = 0;
  private readonly loadProgressListeners = new Set<(fraction: number) => void>();
  private activeReaction: ActiveReaction | null = null;
  private environmentFrame: SpinEnvironmentFrame = IDLE_SPIN_ENVIRONMENT_FRAME;
  private trackHeight = LOGICAL_HEIGHT;
  private artworkScale = 1;
  private currentTrackY = 0;
  private targetTrackY = 0;
  private rows = 3;
  private eyeBoost = 0;
  private phase = 0;
  private reducedMotion = false;
  private authoredBackground: Spine | null = null;
  private authoredForeground: Spine | null = null;
  private authoredIntroActive = false;
  private authoredIntroTimelineControlled = false;
  private authoredIntroTimeMs = 0;
  private persistentPalette: AuthoredBackdropPalette = "main";
  private disposed = false;

  get hasAuthoredEnvironment(): boolean {
    return this.authoredBackground !== null && this.authoredForeground !== null;
  }

  constructor() {
    super();
    // 捕获的背景层次结构顺序是前景 Spine，后跟向上射击、侧向射击和雪粒子兄弟姐妹。加载后，Spine 被插入到索引零处；该主机保留粒子位置。
    this.foregroundView.addChild(this.authoredParticles);
    this.fallback.beginFill(0x14181a).drawRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT).endFill();
    this.fallback.beginFill(0x47200f, 0.42).drawEllipse(640, 610, 720, 220).endFill();
    this.daylightWarmth
      .beginFill(0xffc887, 0.055).drawRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT).endFill()
      .beginFill(0xff9f54, 0.075).drawEllipse(105, 390, 360, 560).endFill()
      .beginFill(0xff9f54, 0.07).drawEllipse(1_175, 390, 360, 560).endFill();
    this.daylightWarmth.blendMode = BLEND_MODES.SCREEN;
    this.createAtmosphere();
    this.addChild(
      this.fallback,
      this.daylight,
      this.destroyedPlate,
      this.authoredBackdropHost,
      this.daylightWarmth,
      this.parallax,
      this.speedShade,
      this.smoke,
      this.featureBloom,
      this.reactionPulse,
      this.reactionLightning,
      this.embers,
      this.vignette,
    );
    this.destroyedPlate.alpha = 0;
    this.reactionPulse.alpha = 0;
    this.reactionLightning.alpha = 0;
  }

  loadArtwork(
    signal?: AbortSignal,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    if (this.loadPromise) {
      this.observeLoadProgress(this.loadPromise, signal, onProgress);
      return this.loadPromise;
    }
    let attemptActive = true;
    const reportBranch = createCityBackdropLoadProgressReporter(
      (fraction) => this.publishLoadProgress(fraction),
      () => attemptActive && !this.disposed && signal?.aborted !== true,
    );
    let pendingBitmap: PendingBitmapArtwork | null = null;
    let pendingAuthored: PendingAuthoredArtwork | null = null;
    let committed = false;
    const bitmapLoad = Promise.all([
      Texture.fromURL(PRIMAL_ASSETS.atlases.environment),
      Texture.fromURL(PRIMAL_ASSETS.features.smokeBurst),
    ]).then(([atlas, smokeTexture]) => {
      if (this.disposed || signal?.aborted) return;
      const daylightRegion = ENVIRONMENT_REGIONS.daylight;
      const destroyedRegion = ENVIRONMENT_REGIONS.destroyed;
      let daylightTexture: Texture | null = null;
      let destroyedTexture: Texture | null = null;
      let leftPuff: Sprite | null = null;
      let rightPuff: Sprite | null = null;
      try {
        daylightTexture = new Texture(
          atlas.baseTexture,
          new Rectangle(daylightRegion.x, daylightRegion.y, daylightRegion.width, daylightRegion.height),
        );
        destroyedTexture = new Texture(
          atlas.baseTexture,
          new Rectangle(destroyedRegion.x, destroyedRegion.y, destroyedRegion.width, destroyedRegion.height),
        );
        const scale = LOGICAL_WIDTH / daylightRegion.width;

        // 提供的 10018 图像包含两个柔软的冲击粉扑。将其用作低阿尔法视差面纱可以保留原始的绘画烟雾。
        leftPuff = new Sprite(smokeTexture);
        leftPuff.anchor.set(0.5);
        leftPuff.position.set(210, 500);
        leftPuff.width = 390;
        leftPuff.height = 180;
        leftPuff.alpha = 0.13;
        rightPuff = new Sprite(smokeTexture);
        rightPuff.anchor.set(0.5);
        rightPuff.position.set(1_075, 470);
        rightPuff.width = 440;
        rightPuff.height = 200;
        rightPuff.alpha = 0.11;
        rightPuff.scale.x *= -1;
        pendingBitmap = {
          daylightTexture,
          destroyedTexture,
          leftPuff,
          rightPuff,
          artworkScale: scale,
          trackHeight: daylightRegion.height * scale,
        };
      } catch (error) {
        leftPuff?.destroy({ children: true, texture: false, baseTexture: false });
        rightPuff?.destroy({ children: true, texture: false, baseTexture: false });
        daylightTexture?.destroy(false);
        destroyedTexture?.destroy(false);
        throw error;
      }
    }).then(() => {
      reportBranch("bitmap", 1);
    });
    const authoredLoad = loadPrimalSpineSet(["background", "backgroundFront"] as const)
      .then(({ background, backgroundFront }) => {
        if (this.disposed || signal?.aborted) return;
        // 捕获的桌面布局适合预设的 1200×900 阶段高度（包含）：1280×720 解析为精确的 0.8 比例。
        let backdrop: Spine | null = null;
        let foreground: Spine | null = null;
        try {
          // 背景地图集使用 `add/normal_*` 名称来表示全尺寸 RGB 城市车牌。与符号导出不同，这些路径不是材质指令；完全遵循预设的 Spine 插槽混合模式。
          backdrop = createSpineView(background, { regionAdditiveFallback: false });
          foreground = createSpineView(backgroundFront, { regionAdditiveFallback: false });
          backdrop.autoUpdate = false;
          foreground.autoUpdate = false;
          backdrop.position.set(
            PRIMAL_BACKGROUND_STAGE_TRANSFORM.x,
            PRIMAL_BACKGROUND_STAGE_TRANSFORM.y,
          );
          foreground.position.set(
            PRIMAL_BACKGROUND_STAGE_TRANSFORM.x,
            PRIMAL_BACKGROUND_STAGE_TRANSFORM.y,
          );
          backdrop.scale.set(PRIMAL_BACKGROUND_STAGE_TRANSFORM.scale);
          foreground.scale.set(PRIMAL_BACKGROUND_STAGE_TRANSFORM.scale);
          pendingAuthored = { background: backdrop, foreground };
        } catch (error) {
          destroyPendingSpine(backdrop);
          destroyPendingSpine(foreground);
          throw error;
        }
      })
      .catch(() => undefined)
      .then(() => {
        reportBranch("authored", 1);
      });
    const particleLoad = this.authoredParticles.load({
      signal,
      onProgress: (fraction) => reportBranch("particles", fraction),
    }).catch((error: unknown) => {
      if (signal?.aborted) throw error;
    }).then(() => {
      reportBranch("particles", 1);
    });
    const attempt = Promise.allSettled([bitmapLoad, authoredLoad, particleLoad])
      .then((results) => {
        const failure = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failure) throw failure.reason;
        if (this.disposed) return;
        if (signal?.aborted) throw backdropAbortReason(signal);

        if (pendingBitmap) this.commitBitmapArtwork(pendingBitmap);
        if (pendingAuthored) {
          this.authoredBackground = pendingAuthored.background;
          this.authoredForeground = pendingAuthored.foreground;
          this.authoredBackdropHost.addChild(pendingAuthored.background);
          this.foregroundView.addChildAt(pendingAuthored.foreground, 0);
          this.restoreAuthoredPalette(this.persistentPalette);
          // Spine 设置姿势拥有相同的位图板以及预设的烟/火/云时间线。保留手工制作的底片仅作为错误回退路径，这样场景就不会双重曝光。
          this.setFallbackArtworkVisible(false);
        }
        this.publishLoadProgress(1);
        committed = true;
      })
      .finally(() => {
        if (committed) return;
        if (pendingBitmap) this.rollbackBitmapArtwork(pendingBitmap);
        if (pendingAuthored) this.rollbackAuthoredArtwork(pendingAuthored);
      });
    this.loadPromise = attempt;
    this.observeLoadProgress(attempt, signal, onProgress);
    void attempt.then(
      () => { attemptActive = false; },
      () => {
        attemptActive = false;
        if (!this.disposed && this.loadPromise === attempt) {
          this.loadPromise = null;
          // 重试开始新的单调运行；运行失败的侦听器将被 observeLoadProgress 删除，而不会收到向后通知。
          this.loadProgress = 0;
        }
      },
    );
    return attempt;
  }

  /** 在 GPU 预热期间从图遍历中排除 4,100 个成员池。 */
  setParticleRenderingEnabled(enabled: boolean): void {
    this.authoredParticles.renderable = enabled;
  }

  private observeLoadProgress(
    attempt: Promise<void>,
    signal: AbortSignal | undefined,
    onProgress: ((fraction: number) => void) | undefined,
  ): void {
    if (!onProgress) return;
    const listener = (fraction: number): void => {
      if (this.disposed || signal?.aborted) return;
      onProgress(fraction);
    };
    this.loadProgressListeners.add(listener);
    listener(this.loadProgress);
    void attempt.then(
      () => { this.loadProgressListeners.delete(listener); },
      () => { this.loadProgressListeners.delete(listener); },
    );
  }

  private publishLoadProgress(fraction: number): void {
    if (this.disposed) return;
    const normalized = Number.isFinite(fraction) ? clamp(fraction) : this.loadProgress;
    const next = Math.max(this.loadProgress, normalized);
    if (next <= this.loadProgress) return;
    this.loadProgress = next;
    for (const listener of this.loadProgressListeners) listener(next);
  }

  private commitBitmapArtwork(artwork: PendingBitmapArtwork): void {
    this.daylight.texture = artwork.daylightTexture;
    this.destroyedPlate.texture = artwork.destroyedTexture;
    this.artworkScale = artwork.artworkScale;
    this.trackHeight = artwork.trackHeight;
    for (const plate of [this.daylight, this.destroyedPlate]) {
      plate.width = LOGICAL_WIDTH;
      plate.height = this.trackHeight;
    }
    // 前景底部对齐裁剪会露出图集下方空旷的雪地区域。Base 玩法是围绕街道视角制作的。
    this.currentTrackY = this.baseTrackY();
    this.targetTrackY = this.currentTrackY;
    this.applyTrackPosition();
    this.parallax.addChild(artwork.leftPuff, artwork.rightPuff);
  }

  private rollbackBitmapArtwork(artwork: PendingBitmapArtwork): void {
    for (const puff of [artwork.leftPuff, artwork.rightPuff]) {
      puff.parent?.removeChild(puff);
      if (!puff.destroyed) puff.destroy({ children: true, texture: false, baseTexture: false });
    }
    if (!this.disposed) {
      if (this.daylight.texture === artwork.daylightTexture) this.daylight.texture = Texture.EMPTY;
      if (this.destroyedPlate.texture === artwork.destroyedTexture) {
        this.destroyedPlate.texture = Texture.EMPTY;
      }
      this.artworkScale = 1;
      this.trackHeight = LOGICAL_HEIGHT;
      this.currentTrackY = 0;
      this.targetTrackY = 0;
      this.applyTrackPosition();
    }
    artwork.daylightTexture.destroy(false);
    artwork.destroyedTexture.destroy(false);
  }

  private rollbackAuthoredArtwork(artwork: PendingAuthoredArtwork): void {
    if (this.authoredBackground === artwork.background) this.authoredBackground = null;
    if (this.authoredForeground === artwork.foreground) this.authoredForeground = null;
    destroyPendingSpine(artwork.background);
    destroyPendingSpine(artwork.foreground);
    if (!this.disposed) this.setFallbackArtworkVisible(true);
  }

  private setFallbackArtworkVisible(visible: boolean): void {
    for (const fallbackLayer of [
      this.fallback,
      this.daylight,
      this.destroyedPlate,
      this.daylightWarmth,
      this.parallax,
      this.speedShade,
      this.smoke,
      this.featureBloom,
      this.reactionPulse,
      this.reactionLightning,
      this.embers,
      this.vignette,
    ]) {
      fallbackLayer.visible = visible;
      fallbackLayer.renderable = visible;
    }
  }

  setExpansionRows(rows: number): void {
    if (!Number.isInteger(rows) || rows < 3 || rows > 8 || rows === this.rows) return;
    this.rows = rows;
    this.targetTrackY = this.trackYForRows(rows);
    if (this.reducedMotion) {
      this.currentTrackY = this.targetTrackY;
      this.applyTrackPosition();
    }
  }

  /**
   * 仅供 Free Spins 最终退出屏障调用。常规调色板切换继续保留预设的混合窗口；这里必须在
   * PRESENTATION_COMPLETE 前一次性提交 Base 镜头、设置姿势和空粒子池，避免下一帧再看到火/雪残影。
   */
  settleFeatureExit(): void {
    this.rows = 3;
    this.targetTrackY = this.trackYForRows(3);
    this.currentTrackY = this.targetTrackY;
    this.applyTrackPosition();
    this.restoreAuthoredPalette("main");
    this.authoredParticles.killAll();
  }

  update(deltaMs: number): void {
    const safeDelta = Number.isFinite(deltaMs) ? Math.max(0, Math.min(64, deltaMs)) : 0;
    if (!this.authoredIntroTimelineControlled) {
      const deltaSeconds = safeDelta / 1_000;
      this.authoredBackground?.update(deltaSeconds);
      this.authoredForeground?.update(deltaSeconds);
    }
    if (!this.reducedMotion) this.phase += safeDelta * 0.001;
    const cameraEase = this.reducedMotion ? 1 : 1 - Math.exp(-safeDelta / 185);
    this.currentTrackY += (this.targetTrackY - this.currentTrackY) * cameraEase;
    this.applyTrackPosition();

    const frame = this.environmentFrame;
    const persistentRage = clamp((this.rows - 3) / 5) * 0.74;
    this.destroyedPlate.alpha = clamp(Math.max(persistentRage, frame.featureAura * 0.9, frame.warmFlash * 0.72));
    this.daylight.alpha = 1;
    this.daylightWarmth.alpha = clamp(0.72 + frame.warmFlash * 0.28 - persistentRage * 0.38);
    this.speedShade.alpha = frame.spinEnergy * 0.2;
    this.featureBloom.alpha = clamp(frame.warmFlash * 0.48 + frame.featureAura * 0.28 + this.eyeBoost * 0.18);
    this.featureBloom.scale.set(0.96 + frame.featureAura * 0.08);
    this.parallax.y = Math.sin(this.phase * 0.4) * (this.reducedMotion ? 0 : 2.5);
    this.parallax.x = frame.impactBias * frame.floorDust * 9;

    this.smoke.children.forEach((plume, index) => {
      plume.x += safeDelta * (0.003 + index * 0.0006) * (this.reducedMotion ? 0 : 1 + frame.smokeBoost);
      plume.y -= safeDelta * (0.0012 + index * 0.00025) * (this.reducedMotion ? 0 : 1);
      if (plume.x > LOGICAL_WIDTH + 180) plume.x = -180;
      if (plume.y < -100) plume.y = LOGICAL_HEIGHT + 80;
      plume.alpha = 0.045 + frame.smokeBoost * 0.08 + Math.sin(this.phase + index) * 0.012;
    });
    this.embers.children.forEach((ember, index) => {
      ember.x += safeDelta * (0.008 + index % 4 * 0.003) * (this.reducedMotion ? 0 : 1);
      ember.y -= safeDelta * (0.018 + index % 5 * 0.004) * (this.reducedMotion ? 0 : 1);
      if (ember.x > LOGICAL_WIDTH + 8) ember.x = -8;
      if (ember.y < -8) ember.y = LOGICAL_HEIGHT + 8;
      ember.alpha = 0.14 + frame.emberBoost * 0.52 + Math.sin(this.phase * 2 + index) * 0.05;
    });
    this.authoredParticles.update(safeDelta);
  }

  setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
    this.smoke.alpha = reducedMotion ? 0.42 : 1;
    this.embers.alpha = reducedMotion ? 0.35 : 1;
    this.authoredParticles.setReducedMotion(reducedMotion);
  }

  /** 将官方移动后台/前台节点作为一对 Z 锁定应用。 */
  setResponsiveNodeTransform(transform: ResponsiveNodeTransform | null): void {
    if (!transform) {
      for (const layer of [this, this.foregroundView]) {
        layer.pivot.set(0, 0);
        layer.position.set(0, 0);
        layer.scale.set(1);
      }
      return;
    }
    const ratio = transform.scale / PRIMAL_BACKGROUND_STAGE_TRANSFORM.scale;
    for (const layer of [this, this.foregroundView]) {
      layer.pivot.set(
        PRIMAL_BACKGROUND_STAGE_TRANSFORM.x,
        PRIMAL_BACKGROUND_STAGE_TRANSFORM.y,
      );
      layer.position.set(transform.x, transform.y);
      layer.scale.set(ratio);
    }
  }

  setEnvironmentFrame(frame: SpinEnvironmentFrame): void {
    this.environmentFrame = { ...frame };
  }

  reactToWin(reducedMotion = false): Promise<void> {
    this.activeReaction?.finish();
    const durationMs = reducedMotion ? 180 : 780;
    return new Promise<void>((resolve, reject) => {
      let startedAt: number | null = null;
      let settled = false;
      const reaction: ActiveReaction = { handle: null, finish: () => settle() };
      const settle = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (reaction.handle !== null) cancelAnimationFrame(reaction.handle);
        reaction.handle = null;
        if (this.activeReaction === reaction) this.activeReaction = null;
        this.applyReaction(monsterReactionFrame(1, reducedMotion));
        if (error === undefined) resolve();
        else reject(error);
      };
      const tick = (time: number): void => {
        if (startedAt === null) startedAt = time;
        try {
          const progress = clamp((time - startedAt) / durationMs);
          this.applyReaction(monsterReactionFrame(progress, reducedMotion));
          if (progress >= 1) return settle();
          reaction.handle = requestAnimationFrame(tick);
        } catch (error) {
          settle(error);
        }
      };
      this.activeReaction = reaction;
      reaction.handle = requestAnimationFrame(tick);
    });
  }

  stopReactions(): void {
    this.activeReaction?.finish();
  }

  override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadProgressListeners.clear();
    this.stopReactions();
    super.destroy(options);
  }

  playAuthoredIntro(): void {
    this.authoredIntroTimelineControlled = false;
    this.authoredIntroTimeMs = 0;
    this.setAuthoredAmbientPalette("main");
    // 捕获 GameBackground 顺序：后台介绍排队主要空闲，而前台播放一次介绍并保持其最终姿势。
    this.playAuthoredBase(this.authoredBackground, "intro", "bg_main_idle");
    this.playAuthoredOnTrack(
      this.authoredForeground,
      "intro",
      PRIMAL_BACKGROUND_TRACK.base,
    );
    this.playAuthoredOnTrack(
      this.authoredBackground,
      "Trafficlight_loop",
      4,
    );
    this.authoredBackground?.update(0);
    this.authoredForeground?.update(0);
    this.authoredIntroTimelineControlled = this.authoredBackground !== null
      || this.authoredForeground !== null;
    this.authoredIntroActive = true;
  }

  /** 从完全相同的过渡时间推进两个相机板。 */
  seekAuthoredIntro(timeMs: number): void {
    if (!this.authoredIntroTimelineControlled || !Number.isFinite(timeMs)) return;
    const targetMs = Math.max(this.authoredIntroTimeMs, Math.max(0, timeMs));
    const deltaSeconds = (targetMs - this.authoredIntroTimeMs) / 1_000;
    this.authoredIntroTimeMs = targetMs;
    if (deltaSeconds <= 0) return;
    this.authoredBackground?.update(deltaSeconds);
    this.authoredForeground?.update(deltaSeconds);
  }

  completeAuthoredIntro(skipped: boolean): void {
    if (!this.authoredIntroActive) return;
    this.authoredBackground?.state.clearTrack(4);
    if (skipped) {
      this.completeAuthored(this.authoredBackground, true);
      this.completeAuthored(this.authoredForeground, true);
      this.restoreAuthoredPalette(this.persistentPalette);
    }
    this.authoredIntroTimelineControlled = false;
    this.authoredIntroTimeMs = 0;
    this.authoredIntroActive = false;
  }

  playAuthoredShake(level = 1): void {
    const animation = level >= 3 ? "shake_lvl3" : level >= 2 ? "shake_lvl2" : "shake";
    this.playAuthoredOnTrack(this.authoredBackground, animation, PRIMAL_BACKGROUND_TRACK.shake);
    this.playAuthoredOnTrack(this.authoredForeground, animation, PRIMAL_BACKGROUND_TRACK.shake);
  }

  transitionAuthoredPalette(palette: AuthoredBackdropPalette): void {
    const previous = this.persistentPalette;
    this.persistentPalette = palette;
    if (previous === palette) {
      this.restoreAuthoredPalette(palette);
      return;
    }

    this.setAuthoredAmbientPalette(palette);
    if (palette === "main") {
      const transition = authoredBackgroundTransition(previous, palette);
      if (!transition) return;
      this.playAuthoredBasePair(transition, "bg_main_idle");
      return;
    }

    const transition = authoredBackgroundTransition(previous, palette);
    if (!transition) return;
    const idle = palette === "snow" ? "fs_bg_snow_idle" : "fs_bg_fire_idle";
    this.playAuthoredBasePair(transition, idle);
    this.playAuthoredOnTrack(
      this.authoredForeground,
      palette === "snow" ? "Transition_Snow" : "Transition_Fire",
      PRIMAL_BACKGROUND_TRACK.transition,
    );
  }

  /** 重新连接安全直接恢复，无需重播过渡。 */
  restoreAuthoredPalette(palette: AuthoredBackdropPalette): void {
    this.persistentPalette = palette;
    const idle = palette === "snow"
      ? "fs_bg_snow_idle"
      : palette === "fire"
        ? "fs_bg_fire_idle"
        : "bg_main_idle";
    // 重新连接/恢复的快照没有转换窗口，其中旧调色板可能会混合。首先清除每个叠加层，然后应用设置姿势中请求的空闲，以便火/雪附件无法在第 0 帧中幸存。
    this.authoredBackground?.state.clearTrack(PRIMAL_BACKGROUND_TRACK.transition);
    this.authoredForeground?.state.clearTrack(PRIMAL_BACKGROUND_TRACK.transition);
    for (
      let track = PRIMAL_BACKGROUND_TRACK.auxBegin;
      track <= PRIMAL_BACKGROUND_TRACK.auxEnd;
      track += 1
    ) {
      this.authoredBackground?.state.clearTrack(track);
    }
    // 单独调用 clearTrack() 会让最后一个关键帧继续停留。直接恢复没有制作好的 150 毫秒退场窗口，
    // 因此这里重置骨架姿态并应用请求的 Base 空闲动画，不再与已废弃的特性轨道条目混合。
    this.authoredBackground?.skeleton.setToSetupPose();
    this.authoredForeground?.skeleton.setToSetupPose();
    this.setAuthoredIdle(this.authoredBackground, idle, true);
    this.setAuthoredIdle(this.authoredForeground, idle, true);
    this.setAuthoredAmbientPalette(palette);
  }

  private baseTrackY(): number {
    return -ENVIRONMENT_VIEW.baseSourceY * this.artworkScale;
  }

  private trackYForRows(rows: number): number {
    const progress = clamp((rows - 3) / 5);
    const expandedY = -ENVIRONMENT_VIEW.expandedSourceY * this.artworkScale;
    return this.baseTrackY() + (expandedY - this.baseTrackY()) * progress;
  }

  private applyTrackPosition(): void {
    this.daylight.y = this.currentTrackY;
    this.destroyedPlate.y = this.currentTrackY;
  }

  private applyReaction(frame: MonsterReactionFrame): void {
    this.eyeBoost = frame.eyeBoost;
    this.reactionPulse.alpha = frame.pulseAlpha;
    this.reactionPulse.scale.set(frame.pulseScale);
    this.reactionLightning.alpha = frame.lightningAlpha;
  }

  private playAuthoredBasePair(animation: string, idle: string): void {
    this.playAuthoredBase(this.authoredBackground, animation, idle);
    this.playAuthoredBase(this.authoredForeground, animation, idle);
  }

  private playAuthoredBase(view: Spine | null, animation: string, idle: string): void {
    if (!view?.state.hasAnimation(animation)) return;
    view.state.setAnimation(PRIMAL_BACKGROUND_TRACK.base, animation, false);
    if (view.state.hasAnimation(idle)) {
      view.state.addAnimation(PRIMAL_BACKGROUND_TRACK.base, idle, true, 0);
    }
  }

  private playAuthoredOnTrack(view: Spine | null, animation: string, track: number): void {
    if (!view?.state.hasAnimation(animation)) return;
    view.state.setAnimation(track, animation, false);
  }

  private setAuthoredIdle(view: Spine | null, idle: string, immediate = false): void {
    if (!view?.state.hasAnimation(idle)) return;
    const entry = view.state.setAnimation(PRIMAL_BACKGROUND_TRACK.base, idle, true);
    if (immediate) entry.mixDuration = 0;
    view.update(0);
  }

  private completeAuthored(view: Spine | null, skipped: boolean): void {
    if (!view) return;
    if (skipped && view.state.hasAnimation("intro")) {
      const entry = view.state.setAnimation(PRIMAL_BACKGROUND_TRACK.base, "intro", false);
      entry.trackTime = entry.animationEnd;
      view.update(0);
    }
  }

  private setAuthoredAmbientPalette(palette: AuthoredBackdropPalette): void {
    // 粒子系统是捕获的运行时中单独的前台层次结构兄弟。切换发射不会清除现有的池，因此火/雪残留物会在转换过程中自然衰减。
    this.authoredParticles.setPalette(palette);
    const view = this.authoredBackground;
    if (!view) return;
    const tracks = new Map<number, string>(PRIMAL_BACKGROUND_AUX_TRACKS[palette]);
    for (let track = PRIMAL_BACKGROUND_TRACK.auxBegin; track <= PRIMAL_BACKGROUND_TRACK.auxEnd; track += 1) {
      const animation = tracks.get(track);
      if (animation && view.state.hasAnimation(animation)) {
        view.state.setAnimation(track, animation, true);
      } else if (view.state.getCurrent(track)) {
        // 官方共享的 Spine 包装器使用 150 毫秒的默认交叉淡入淡出。空动画让退役的火/雪附件混合回设置姿势，而不是突然消失或滞留。
        view.state.setEmptyAnimation(track, SPINE_DEFAULT_MIX_SECONDS);
      }
    }
  }

  private createAtmosphere(): void {
    this.speedShade.beginFill(0x020202, 0.84).drawRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT).endFill();
    this.speedShade.alpha = 0;

    this.featureBloom.beginFill(0xff3d12, 0.2).drawEllipse(640, 495, 540, 265).endFill();
    this.featureBloom.beginFill(0xffc24b, 0.12).drawEllipse(640, 560, 300, 130).endFill();
    this.featureBloom.blendMode = BLEND_MODES.ADD;
    this.featureBloom.filters = [new filters.BlurFilter(36, 2)];
    this.featureBloom.pivot.set(640, 520);
    this.featureBloom.position.set(640, 520);
    this.featureBloom.alpha = 0;

    for (let index = 0; index < 5; index += 1) {
      const plume = new Graphics();
      plume.beginFill(index % 2 === 0 ? 0x262a2a : 0x4c423b, 0.6);
      plume.drawEllipse(0, 0, 180 + index * 37, 54 + index * 9).endFill();
      plume.position.set((index * 281 + 90) % LOGICAL_WIDTH, 350 + index * 57);
      this.smoke.addChild(plume);
    }
    this.smoke.filters = [new filters.BlurFilter(26, 2)];

    for (let index = 0; index < 48; index += 1) {
      const ember = new Graphics();
      ember.beginFill(index % 7 === 0 ? 0xffdd6f : 0xff5b1c, 0.9)
        .drawCircle(0, 0, 0.9 + index % 3 * 0.55).endFill();
      ember.position.set((index * 137) % LOGICAL_WIDTH, (index * 79) % LOGICAL_HEIGHT);
      ember.blendMode = BLEND_MODES.ADD;
      this.embers.addChild(ember);
    }

    this.reactionPulse.beginFill(0xff351e, 0.13).drawCircle(0, 0, 115).endFill();
    this.reactionPulse.lineStyle(6, 0xffdf7d, 0.74).drawCircle(0, 0, 88);
    this.reactionPulse.position.set(640, 142);
    this.reactionPulse.blendMode = BLEND_MODES.ADD;

    this.reactionLightning.lineStyle(8, 0xff1f1c, 0.3);
    this.reactionLightning.moveTo(500, 70).lineTo(555, 135).lineTo(520, 190).lineTo(602, 250);
    this.reactionLightning.moveTo(780, 70).lineTo(725, 135).lineTo(760, 190).lineTo(678, 250);
    this.reactionLightning.lineStyle(2, 0xfff1db, 0.94);
    this.reactionLightning.moveTo(500, 70).lineTo(555, 135).lineTo(520, 190).lineTo(602, 250);
    this.reactionLightning.moveTo(780, 70).lineTo(725, 135).lineTo(760, 190).lineTo(678, 250);
    this.reactionLightning.blendMode = BLEND_MODES.ADD;

    this.vignette.beginFill(0x010202, 0.78);
    this.vignette.drawRect(0, 0, LOGICAL_WIDTH, 42);
    this.vignette.drawRect(0, LOGICAL_HEIGHT - 82, LOGICAL_WIDTH, 82);
    this.vignette.drawRect(0, 0, 70, LOGICAL_HEIGHT);
    this.vignette.drawRect(LOGICAL_WIDTH - 70, 0, 70, LOGICAL_HEIGHT);
    this.vignette.endFill();
    this.vignette.filters = [new filters.BlurFilter(25, 2)];
  }
}

function destroyPendingSpine(view: Spine | null): void {
  if (!view || view.destroyed) return;
  view.parent?.removeChild(view);
  view.destroy({ children: true, texture: false, baseTexture: false });
}

function backdropAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("City backdrop load was aborted");
  error.name = "AbortError";
  return error;
}
