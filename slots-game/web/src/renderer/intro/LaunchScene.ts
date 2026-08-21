import { Container, Graphics, Point, Rectangle, Sprite, Texture, filters } from "pixi.js";
import {
  CHARACTER_REGIONS,
  PRIMAL_ASSETS,
  PRIMAL_LOGO_REGION,
} from "../../assets/PrimalAssetManifest";
import type { IntroFrame } from "../../startup/introTimeline";
import { PRIMAL_SCHEDULER_MAX_CATCH_UP_MS } from "../../startup/Timeline";
import type { ReelSetView } from "../../reels/ReelSetView";
import { PRIMAL_CHARACTER_ANIMATION_MS } from "../../reels/primalAnimationTiming";
import { CameraRig } from "../CameraRig";
import {
  createSpineView,
  enforcePrimalRegionBlendModes,
  SPINE_DEFAULT_MIX_SECONDS,
  type Spine,
} from "../spine/SpineAdapter";
import { loadPrimalSpineSet } from "../spine/PrimalSpineAssets";
import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from "../theme";
import type {
  MobileLayoutProfile,
  ResponsiveNodeTransform,
  ResponsiveRendererRegion,
} from "../ResponsiveLayout";

export const CHARACTER_IDLE_LOOP_MS = PRIMAL_CHARACTER_ANIMATION_MS.idleStateLoop;
/**
 * 捕获的游戏中的桌面 `ppsApe` 节点有自己预设的阶段变换。  它不得继承箱体的响应式合成比例：嵌套的 Spine 已带有其测量的 0.72 比例和 y=360 偏移量。
 */
export const PRIMAL_DESKTOP_CHARACTER_HOST_SCALE = 1;
export const PRIMAL_DESKTOP_CHARACTER_SKELETON_TRANSFORM = Object.freeze({
  x: 0,
  y: 360,
  scale: 0.72,
});
/** 从桌面/移动捆绑包中恢复了官方 Character 调度程序节奏。 */
export const WHEEL_CHEST_POUND_SCHEDULER_FPS = 30;
/** Float32 从权威 character.skel 解码的持续时间。 */
export const WHEEL_CHEST_POUND_DECODED_DURATION_SECONDS = 3.8333334922790527;
/** `playSpineData` 在调度之前将解码的 3.833333492 s 剪辑置底。 */
export const WHEEL_CHEST_POUND_FLOORED_TASK_MS = Math.floor(
  WHEEL_CHEST_POUND_DECODED_DURATION_SECONDS * 1_000,
);
/** `timeToTick(3833)` 是 `ceil(3833 * 30 / 1000)`，或 115 个调度程序刻度。 */
export const WHEEL_CHEST_POUND_TASK_TICKS = Math.ceil(
  WHEEL_CHEST_POUND_FLOORED_TASK_MS * WHEEL_CHEST_POUND_SCHEDULER_FPS / 1_000,
);
/** 任务从蜱虫转换回来后的权威自我状态期。 */
export const WHEEL_CHEST_POUND_REENTRY_MS = (
  WHEEL_CHEST_POUND_TASK_TICKS / WHEEL_CHEST_POUND_SCHEDULER_FPS
) * 1_000;
const WHEEL_CHEST_POUND_TICK_MS = 1_000 / WHEEL_CHEST_POUND_SCHEDULER_FPS;
const WHEEL_CHEST_POUND_TICK_EPSILON = 1e-7;
const WHEEL_CHEST_POUND_CAPTURE_MIX_EPSILON_SECONDS = 1e-9;
const WHEEL_CHEST_POUND_CAPTURE_TARGETS_MS = Object.freeze([
  3_800,
  WHEEL_CHEST_POUND_REENTRY_MS,
  WHEEL_CHEST_POUND_REENTRY_MS + 150,
  WHEEL_CHEST_POUND_REENTRY_MS * 2,
] as const);
/** 恢复的状态调度程序层预设了 Spine 秒到整数毫秒。 */
export const CHARACTER_INTRO_TASK_MS = Math.floor(PRIMAL_CHARACTER_ANIMATION_MS.intro);
const CHARACTER_CAPTURE_MAX_STEP_MS = 64;

export const PRIMAL_CHARACTER_TRACK = Object.freeze({
  overlay: 0,
  body: 1,
  aura: 2,
  particles: 3,
  palette: 4,
});
const WHEEL_CHEST_POUND_NON_BODY_TRACKS = Object.freeze([
  PRIMAL_CHARACTER_TRACK.overlay,
  PRIMAL_CHARACTER_TRACK.aura,
  PRIMAL_CHARACTER_TRACK.particles,
  PRIMAL_CHARACTER_TRACK.palette,
] as const);

export type CharacterBodyContinuation = "base" | "feature" | "kq";
export type CharacterPalette = "main" | "fire" | "snow";

const CHARACTER_PALETTE_TINT = Object.freeze({
  main: 0xffffff,
  fire: 0xff9485,
  snow: 0xcadfff,
} satisfies Record<CharacterPalette, number>);

export const CHARACTER_BODY_CONTINUATION_ANIMATION = Object.freeze({
  base: "idle",
  feature: "feature_idle",
  kq: "reel_stretch_waiting",
} satisfies Record<CharacterBodyContinuation, string>);

export interface CharacterPersistentPresentation {
  readonly body: CharacterBodyContinuation;
  readonly auraLevel: number | null;
  readonly palette: CharacterPalette;
}

const CHARACTER_IDLE_BREAKERS = Object.freeze([
  Object.freeze({ animation: "idle_breaker", durationMs: PRIMAL_CHARACTER_ANIMATION_MS.idleBreaker }),
  Object.freeze({ animation: "idle_breaker2", durationMs: PRIMAL_CHARACTER_ANIMATION_MS.idleBreaker2 }),
  Object.freeze({ animation: "idle_breaker3", durationMs: PRIMAL_CHARACTER_ANIMATION_MS.idleBreaker3 }),
] as const);

const CHARACTER_COLLECT_ANIMATIONS = Object.freeze([
  "idle_breaker2",
  "chest_pound",
  "win",
] as const);

export type CharacterIdleBreaker = (typeof CHARACTER_IDLE_BREAKERS)[number]["animation"];
export type CharacterAnimationContext = "state" | "collect-random" | "idle-breaker";

export interface CharacterAnimationEvent {
  readonly animation: string;
  /** 区分确定性 STATE_START 音频和随机 ANIM_START 音频。 */
  readonly context: CharacterAnimationContext;
}

export interface CharacterTrackDiagnostic {
  readonly track: number;
  readonly animation: string | null;
  readonly trackTime: number | null;
  readonly mixingFrom: string | null;
  /** 运行时交叉淡入淡出持续时间，仅针对只读捕获证据公开。 */
  readonly mixDuration?: number | null;
}

/** 确定性浏览器捕获测试夹具使用的只读证据接口。 */
export interface CharacterIntroLifecycleDiagnostics {
  readonly introActive: boolean;
  readonly introElapsedMs: number;
  readonly taskDurationMs: number;
  readonly timelineControlled: boolean;
  readonly bodyReleased: boolean;
  readonly auraReleased: boolean;
  readonly idleSchedulerActive: boolean;
  readonly capturePaused: boolean;
}

export interface WheelChestPoundCaptureDiagnostics {
  readonly schedulerFps: number;
  readonly flooredTaskMs: number;
  readonly taskTicks: number;
  readonly periodMs: number;
  readonly targetSpinElapsedMs: number;
  readonly taskElapsedMs: number;
  readonly entryOrdinal: number;
  readonly reentryCount: number;
  readonly schedulerActive: boolean;
  readonly generation: number;
  readonly ownerIsCurrent: boolean;
  readonly nonBodyTrackIdentityPreserved: boolean;
  readonly tracks: readonly CharacterTrackDiagnostic[];
}

type CharacterTrackEntry = NonNullable<ReturnType<Spine["state"]["getCurrent"]>>;

interface WheelChestPoundTask {
  generation: number;
  ownerEntry: CharacterTrackEntry;
  targetSpinElapsedMs: number;
  taskElapsedMs: number;
  elapsedTicks: number;
  tickRemainderMs: number;
  entryOrdinal: number;
  reentryCount: number;
  readonly nonBodyTrackOwners: readonly (CharacterTrackEntry | null)[];
}

export type CharacterAnimationListener = (event: CharacterAnimationEvent) => void;

/** 匹配原始的等概率 Math.floor(random * 3) 选择器。 */
export function characterIdleBreakerForRandom(random: number): CharacterIdleBreaker {
  const normalized = Number.isFinite(random) ? Math.min(0.999_999, Math.max(0, random)) : 0;
  return CHARACTER_IDLE_BREAKERS[Math.floor(normalized * CHARACTER_IDLE_BREAKERS.length)]?.animation
    ?? "idle_breaker";
}

export type CharacterCollectAnimation = (typeof CHARACTER_COLLECT_ANIMATIONS)[number];

/** 原装COLLECT状态统一选择这三个机身夹之一。 */
export function characterCollectAnimationForRandom(random: number): CharacterCollectAnimation {
  const normalized = Number.isFinite(random) ? Math.min(0.999_999, Math.max(0, random)) : 0;
  return CHARACTER_COLLECT_ANIMATIONS[Math.floor(normalized * CHARACTER_COLLECT_ANIMATIONS.length)]
    ?? "idle_breaker2";
}

class PrimalRampageLogo extends Container {
  private readonly art = new Sprite(Texture.EMPTY);

  constructor() {
    super();
    this.art.anchor.set(0.5);
    this.addChild(this.art);
  }

  setAtlasTexture(atlas: Texture): void {
    this.art.texture = new Texture(
      atlas.baseTexture,
      new Rectangle(
        PRIMAL_LOGO_REGION.x,
        PRIMAL_LOGO_REGION.y,
        PRIMAL_LOGO_REGION.width,
        PRIMAL_LOGO_REGION.height,
      ),
    );
  }
}

class PrimalGorilla extends Container {
  private readonly torso = new Sprite(Texture.EMPTY);
  private readonly head = new Sprite(Texture.EMPTY);
  private phase = 0;
  private reducedMotion = false;

  constructor() {
    super();
    this.torso.anchor.set(0.5, 0);
    this.head.anchor.set(0.5, 0);
    this.torso.position.set(0, 86);
    this.head.position.set(0, 24);
    this.addChild(this.torso, this.head);
  }

  setAtlasTexture(atlas: Texture): void {
    const torso = CHARACTER_REGIONS.torso;
    const head = CHARACTER_REGIONS.head;
    this.torso.texture = new Texture(
      atlas.baseTexture,
      new Rectangle(torso.x, torso.y, torso.width, torso.height),
    );
    this.head.texture = new Texture(
      atlas.baseTexture,
      new Rectangle(head.x, head.y, head.width, head.height),
    );
    this.torso.width = 650;
    this.torso.height = 650 * torso.height / torso.width;
    this.head.width = 184;
    this.head.height = 184 * head.height / head.width;
  }

  update(deltaMs: number): void {
    if (this.reducedMotion || !this.visible || this.alpha <= 0) return;
    this.phase += Math.max(0, Math.min(64, deltaMs)) * 0.001;
    this.head.y = 24 + Math.sin(this.phase * 1.12) * 1.7;
    this.torso.scale.y = 1 + Math.sin(this.phase * 0.82) * 0.006;
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
    if (value) {
      this.head.y = 24;
      this.torso.scale.y = 1;
    }
  }
}

export class LaunchScene {
  readonly overlay = new Container();
  private readonly foreground = new Container();
  private readonly leftTank = new Sprite(Texture.EMPTY);
  private readonly rightTank = new Sprite(Texture.EMPTY);
  private readonly monsterVeil = new Graphics();
  private readonly monsterHost = new Container();
  private readonly monsterFallback = new PrimalGorilla();
  private readonly monsterMist = new Graphics();
  private readonly shockwave = new Container();
  private readonly logo = new PrimalRampageLogo();
  private readonly blackout = new Graphics();
  private readonly particles = new Container();
  private readonly depthSmoke = new Container();
  private actorBaseY = 0;
  private responsiveCompositionScale = 1;
  private mobileCharacterTransform: ResponsiveNodeTransform | null = null;
  private mobileViewportRegion: ResponsiveRendererRegion | null = null;
  private mobileLayoutProfile: MobileLayoutProfile = "ls";
  private authoredMonster: Spine | null = null;
  private authoredLogo: Spine | null = null;
  private characterIntroActive = false;
  private authoredIntroTimelineControlled = false;
  private authoredIntroTimeMs = 0;
  private characterIntroElapsedMs = 0;
  private characterBodyReleased = false;
  private characterAuraReleased = false;
  private characterIntroCapturePaused = false;
  private artworkLoad: Promise<void> | null = null;
  private reducedMotion = false;
  private characterAnimationListener: CharacterAnimationListener | null = null;
  private idleLoopElapsedMs = 0;
  private idleResumeRemainingMs = 0;
  private idleResumeToBase = true;
  private idleResumeToFeature = false;
  private idleSchedulerActive = false;
  private visualCaptureIdleSuspended = false;
  private wheelChestPoundGeneration = 0;
  private wheelChestPoundTask: WheelChestPoundTask | null = null;
  private persistentPresentation: CharacterPersistentPresentation = {
    body: "base",
    auraLevel: null,
    palette: "main",
  };

  get hasAuthoredCharacter(): boolean {
    return this.authoredMonster !== null;
  }

  get hasAuthoredIntroLogo(): boolean {
    return this.authoredLogo !== null;
  }

  constructor(
    private readonly camera: CameraRig,
    private readonly reels: ReelSetView,
  ) {
    this.blackout.beginFill(0x1b242a).drawRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT).endFill();
    this.createShockwave();
    this.createParticles();
    this.createDepthSmoke();
    this.createMonsterVeil();
    this.monsterMist.beginFill(0xc9e2f2, 0.58).drawEllipse(0, 0, 185, 13).endFill();
    this.monsterMist.filters = [new filters.BlurFilter(14, 2)];
    this.leftTank.anchor.set(0.5, 1);
    this.rightTank.anchor.set(0.5, 1);
    this.foreground.addChild(this.leftTank, this.rightTank);
    this.monsterHost.addChild(this.monsterFallback);
    this.camera.farLayer.addChild(this.monsterVeil);
    this.camera.terrainLayer.addChild(this.depthSmoke, this.particles);
    this.camera.actorLayer.addChild(this.monsterHost, this.monsterMist);
    this.camera.foregroundLayer.addChild(this.foreground);
    this.camera.fxLayer.addChild(this.shockwave);
    this.overlay.addChild(this.blackout, this.logo);
    this.applyFrame({
      worldAlpha: 0,
      cameraZoom: 1.09,
      cameraY: -18,
      logoAlpha: 0,
      logoX: 640,
      logoY: 236,
      logoScale: 1,
      colossusAlpha: 0,
      colossusX: 640,
      colossusY: 0,
      colossusScale: 1,
      monsterRevealProgress: 0,
      atmosphereProgress: 0,
      shockwave: 0,
      reelProgress: 0,
      hudProgress: 0,
    });
  }

  applyFrame(frame: IntroFrame): void {
    this.camera.setCamera(0, frame.cameraY, frame.cameraZoom);
    const shakeEnvelope = frame.shockwave > 0 && frame.shockwave < 1 ? 1 - frame.shockwave : 0;
    this.camera.position.set(
      Math.sin(frame.shockwave * Math.PI * 14) * shakeEnvelope * 9,
      Math.cos(frame.shockwave * Math.PI * 11) * shakeEnvelope * 5,
    );
    this.camera.farLayer.alpha = frame.worldAlpha;
    this.camera.terrainLayer.alpha = frame.worldAlpha;
    this.camera.actorLayer.alpha = frame.worldAlpha;
    this.camera.foregroundLayer.alpha = frame.worldAlpha;
    this.blackout.alpha = 1 - frame.worldAlpha;

    if (this.authoredLogo) {
      this.authoredLogo.alpha = frame.logoAlpha;
    } else {
      this.logo.alpha = frame.logoAlpha;
      this.logo.position.set(frame.logoX, frame.logoY);
      this.logo.scale.set(frame.logoScale);
    }

    this.monsterVeil.alpha = (1 - frame.monsterRevealProgress) * 0.88;
    this.monsterVeil.scale.set(1.04 - frame.monsterRevealProgress * 0.04);

    this.monsterHost.alpha = frame.colossusAlpha;
    this.actorBaseY = 0;
    // `character.skel/intro`拥有整个1、504px下跌、压缩和反弹。移动该主机将应用该动作两次。
    if (this.mobileCharacterTransform) {
      const ratio = this.mobileCharacterTransform.scale / 0.8
        * (this.mobileLayoutProfile === "ls" ? 1.2 : 1);
      this.monsterHost.position.set(
        this.mobileCharacterTransform.x + (frame.colossusX - LOGICAL_WIDTH / 2) * ratio,
        this.mobileCharacterTransform.y - LOGICAL_HEIGHT / 2 * ratio,
      );
      this.monsterHost.scale.set(ratio);
    } else {
      this.monsterHost.position.set(frame.colossusX, 0);
      this.monsterHost.scale.set(PRIMAL_DESKTOP_CHARACTER_HOST_SCALE);
    }
    this.monsterHost.rotation = 0;
    if (this.mobileCharacterTransform) {
      const ratio = this.mobileCharacterTransform.scale / 0.8
        * (this.mobileLayoutProfile === "ls" ? 1.2 : 1);
      this.monsterMist.position.set(
        this.mobileCharacterTransform.x,
        this.mobileCharacterTransform.y + 30 * ratio,
      );
      this.monsterMist.scale.set(frame.colossusScale * ratio);
    } else {
      this.monsterMist.position.set(frame.colossusX, frame.colossusY + 390 * frame.colossusScale);
      this.monsterMist.scale.set(frame.colossusScale);
    }
    this.monsterMist.alpha = frame.colossusAlpha * (1 - frame.reelProgress * 0.84);

    this.depthSmoke.alpha = frame.worldAlpha * frame.atmosphereProgress * 0.58;
    this.depthSmoke.children.forEach((plume, index) => {
      const direction = index % 2 === 0 ? 1 : -1;
      plume.x = (index * 310 + 75) + direction * frame.atmosphereProgress * (34 + index * 7);
      plume.y = 520 - index * 54 - frame.atmosphereProgress * (18 + index * 4);
    });

    const shockScale = 0.35 + frame.shockwave * 2.65;
    this.shockwave.position.set(650, 300);
    this.shockwave.scale.set(shockScale, shockScale * 0.68);
    this.shockwave.alpha = frame.shockwave > 0 && frame.shockwave < 1
      ? (1 - frame.shockwave) * 0.92
      : 0;

    this.reels.alpha = Math.min(1, Math.max(0, frame.reelProgress));
    // 原始内阁已经处于其最终几何形状，并且仅随着主/菜单/状态栏而消失。它没有合成的下降或弹跳变换。
    if (this.mobileViewportRegion) {
      this.reels.setMobileLayout(this.mobileViewportRegion, this.mobileLayoutProfile);
    }
    else this.reels.setResponsiveComposition(this.responsiveCompositionScale);

    this.particles.alpha = frame.worldAlpha * (0.12 + frame.atmosphereProgress * 0.7);
    this.particles.children.forEach((particle, index) => {
      particle.y = ((index * 83 - frame.reelProgress * 190 + 760) % 760) - 20;
    });
  }

  async warmUp(): Promise<void> {
    await new Promise<void>((resolve) => {
      const fallback = setTimeout(resolve, 250);
      requestAnimationFrame(() => {
        clearTimeout(fallback);
        resolve();
      });
    });
  }

  update(deltaMs: number): void {
    const safeDeltaMs = Number.isFinite(deltaMs)
      ? Math.max(0, Math.min(PRIMAL_SCHEDULER_MAX_CATCH_UP_MS, deltaMs))
      : 0;
    const characterIntroWasActive = this.characterIntroActive;
    this.monsterFallback.update(safeDeltaMs);
    if (this.authoredMonster
      && !this.authoredIntroTimelineControlled
      && !this.characterIntroCapturePaused) {
      this.authoredMonster.update(safeDeltaMs / 1_000);
      enforcePrimalRegionBlendModes(this.authoredMonster);
      if (this.characterIntroActive && !this.reducedMotion) {
        this.advanceCharacterIntroTask(safeDeltaMs);
      }
    }
    if (!this.authoredMonster && this.monsterHost.alpha > 0) {
      this.monsterHost.y = this.actorBaseY
        + Math.sin(performance.now() * 0.00082) * (this.reducedMotion ? 0 : 1.4);
    }
    this.updateWheelChestPound(safeDeltaMs);
    this.updateCharacterIdle(characterIntroWasActive ? 0 : safeDeltaMs);
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
    if (value) this.cancelWheelChestPoundReentry();
    this.monsterFallback.setReducedMotion(value);
    if (this.authoredMonster) this.authoredMonster.state.timeScale = value ? 0 : 1;
  }

  setResponsiveComposition(scale: number): void {
    if (!Number.isFinite(scale)) return;
    this.mobileCharacterTransform = null;
    this.mobileViewportRegion = null;
    this.mobileLayoutProfile = "ls";
    this.responsiveCompositionScale = Math.max(0.8, Math.min(1.1, scale));
    // 与机柜不同的是，原来的桌面ppsApe是一个独立的根节点。在这里缩放它复合了预设的 Spine 比例，并将其脚趾推过 1280×720 的状态栏边界。
    this.monsterHost.scale.set(PRIMAL_DESKTOP_CHARACTER_HOST_SCALE);
    this.reels.setResponsiveComposition(this.responsiveCompositionScale);
  }

  /** 使用角色节点和 Base Reel 的独立画布锚点。 */
  setMobileNodeTransforms(
    character: ResponsiveNodeTransform,
    profile: MobileLayoutProfile,
    viewportRegion: ResponsiveRendererRegion,
  ): void {
    this.mobileCharacterTransform = character;
    this.mobileViewportRegion = viewportRegion;
    this.mobileLayoutProfile = profile;
    const ratio = character.scale / 0.8 * (profile === "ls" ? 1.2 : 1);
    this.monsterHost.position.set(
      character.x,
      character.y - LOGICAL_HEIGHT / 2 * ratio,
    );
    this.monsterHost.scale.set(ratio);
    this.reels.setMobileLayout(viewportRegion, profile);
  }

  setCharacterAnimationListener(listener: CharacterAnimationListener | null): void {
    this.characterAnimationListener = listener;
  }

  /** 原始轨迹控制器使用的确切收集目标：头骨。 */
  getCharacterCollectTarget(relativeTo: Container): Point {
    const monster = this.authoredMonster;
    const head = monster?.skeleton.findBone("head");
    if (monster && head) {
      return relativeTo.toLocal(monster.toGlobal(new Point(head.worldX, head.worldY)));
    }
    return relativeTo.toLocal(this.monsterHost.toGlobal(new Point(0, 118)));
  }

  /** 预设的 Rage 跟踪目标的运行时后置条件。 */
  get hasCharacterCollectBone(): boolean {
    return Boolean(this.authoredMonster?.skeleton.findBone("head"));
  }

  setAuthoredEnvironment(active: boolean): void {
    this.foreground.visible = !active;
    this.depthSmoke.visible = !active;
    this.particles.visible = !active;
    this.monsterVeil.visible = !active;
    this.monsterMist.visible = !active;
    this.shockwave.visible = !active;
  }

  /** 启动本机启动轨道而不添加主机级动作/音频。 */
  startAuthoredIntro(): void {
    this.cancelWheelChestPoundReentry();
    const monster = this.authoredMonster;
    this.authoredIntroTimelineControlled = false;
    this.authoredIntroTimeMs = 0;
    this.characterIntroElapsedMs = 0;
    this.characterIntroCapturePaused = false;
    this.characterBodyReleased = false;
    this.characterAuraReleased = false;
    this.characterIntroActive = false;
    this.idleSchedulerActive = false;
    this.idleLoopElapsedMs = 0;
    this.idleResumeRemainingMs = 0;
    this.idleResumeToBase = false;
    this.idleResumeToFeature = false;
    if (monster?.state.hasAnimation("intro")) {
      monster.autoUpdate = false;
      monster.state.timeScale = this.reducedMotion ? 0 : 1;
      monster.state.clearTrack(PRIMAL_CHARACTER_TRACK.aura);
      monster.state.clearTrack(PRIMAL_CHARACTER_TRACK.particles);
      monster.state.clearTrack(PRIMAL_CHARACTER_TRACK.body);
      if (monster.state.hasAnimation("hidden")) {
        const hiddenEntry = monster.state.setAnimation(
          PRIMAL_CHARACTER_TRACK.body,
          "hidden",
          false,
        );
        hiddenEntry.mixDuration = 0;
        monster.update(0);
      }
      // `playSpineData` 分离 INTRO 之前的临时隐藏条目。如果没有这个清除，
      // Spine 会将 `hidden`（或较早的预加载空闲）保留在 `mixingFrom` 中，即使 INTRO 本身声明零交叉淡入淡出。
      monster.state.clearTrack(PRIMAL_CHARACTER_TRACK.body);
      const introEntry = monster.state.setAnimation(PRIMAL_CHARACTER_TRACK.body, "intro", false);
      // 官方INTRO明确声明了crossFadeTime：0。
      introEntry.mixDuration = 0;
      this.characterIntroActive = true;
      monster.update(0);
      this.authoredIntroTimelineControlled = true;
    } else if (monster) {
      // 捆绑的字符始终包含 INTRO。如果损坏/自定义资产在启动控制器显式启动此状态之前未打开主体门而忽略了回退行为，请保持回退行为可用。
      this.characterBodyReleased = true;
      this.applyPersistentBody(monster);
    }

    const logo = this.authoredLogo;
    if (logo?.state.hasAnimation("intro_animation")) {
      logo.autoUpdate = false;
      logo.visible = true;
      logo.alpha = 1;
      logo.state.timeScale = this.reducedMotion ? 0 : 1;
      logo.state.clearTracks();
      logo.state.setAnimation(0, "intro_animation", false);
      logo.update(0);
      this.authoredIntroTimelineControlled = true;
    }
  }

  /** 从过渡的权威时间推进角色和介绍标志。 */
  seekAuthoredIntro(timeMs: number): void {
    if (!this.authoredIntroTimelineControlled || !Number.isFinite(timeMs)) return;
    const targetMs = Math.max(this.authoredIntroTimeMs, Math.max(0, timeMs));
    const deltaSeconds = (targetMs - this.authoredIntroTimeMs) / 1_000;
    this.authoredIntroTimeMs = targetMs;
    if (deltaSeconds <= 0) return;
    this.authoredMonster?.update(deltaSeconds);
    this.authoredLogo?.update(deltaSeconds);
    if (this.characterIntroActive) this.advanceCharacterIntroTask(deltaSeconds * 1_000);
  }

  /** 镜像捕获的过渡的搜索到结束跳过分支。 */
  completeAuthoredIntro(skipped: boolean): void {
    this.cancelWheelChestPoundReentry();
    this.authoredIntroTimelineControlled = false;
    this.authoredIntroTimeMs = 0;
    if (this.characterIntroActive && skipped) {
      // INTRO_SKIPPED 查找创作剪辑的确切结尾，然后立即输入 LOOP。自然铬完成被故意排除：8.066701 s 字符状态比 5 s UI 转换寿命更长。
      this.finishCharacterIntroToLoop();
      this.releaseAuthoredIntroAura();
    }

    if (this.authoredLogo) {
      this.authoredLogo.state.clearTracks();
      this.authoredLogo.visible = false;
      this.authoredLogo.alpha = 0;
    }
    this.logo.alpha = 0;
  }

  loadArtwork(signal?: AbortSignal): Promise<void> {
    if (this.artworkLoad) return this.artworkLoad;
    const artworkLoad = this.performArtworkLoad(signal);
    this.artworkLoad = artworkLoad;
    void artworkLoad.catch(() => {
      // 暂时的提取失败可以重试，但成功的并发预加载绝不能多次附加预设的角色。
      if (this.artworkLoad === artworkLoad) this.artworkLoad = null;
    });
    return artworkLoad;
  }

  private async performArtworkLoad(signal?: AbortSignal): Promise<void> {
    const assertNotAborted = (): void => {
      if (!signal?.aborted) return;
      throw signal.reason ?? new Error("Launch artwork load was aborted");
    };
    assertNotAborted();
    const bitmapLoad = Promise.all([
      Texture.fromURL(PRIMAL_ASSETS.atlases.promotional),
      Texture.fromURL(PRIMAL_ASSETS.atlases.characterAndSymbols),
      Texture.fromURL(PRIMAL_ASSETS.atlases.environmentPieces),
    ]).then(([promotionalAtlas, characterAtlas, environmentAtlas]) => {
      assertNotAborted();
      this.logo.setAtlasTexture(promotionalAtlas);
      this.monsterFallback.setAtlasTexture(characterAtlas);

      this.leftTank.texture = new Texture(
        environmentAtlas.baseTexture,
        new Rectangle(814, 43, 180, 85),
      );
      this.rightTank.texture = new Texture(
        environmentAtlas.baseTexture,
        new Rectangle(2_580, 55, 170, 85),
      );
      this.leftTank.position.set(118, 720);
      this.leftTank.width = 250;
      this.leftTank.height = 118;
      this.rightTank.position.set(1_143, 720);
      this.rightTank.width = 254;
      this.rightTank.height = 127;
      this.leftTank.alpha = 0.96;
      this.rightTank.alpha = 0.96;
    });
    const authoredLoad = loadPrimalSpineSet(["character", "logoIntro"] as const).then((data) => {
      assertNotAborted();
      let monster: Spine | null = null;
      let logo: Spine | null = null;
      try {
        monster = createSpineView(data.character);
        // 原始桌面ppsApe布局：中心（640,360），比例0.72。父级仍然是时间线驱动的，但没有缩放；孩子携带完整预设的桌面舞台变换。
        monster.position.set(
          PRIMAL_DESKTOP_CHARACTER_SKELETON_TRANSFORM.x,
          PRIMAL_DESKTOP_CHARACTER_SKELETON_TRANSFORM.y,
        );
        monster.scale.set(PRIMAL_DESKTOP_CHARACTER_SKELETON_TRANSFORM.scale);
        monster.autoUpdate = false;
        monster.state.timeScale = this.reducedMotion ? 0 : 1;
        monster.state.clearTrack(PRIMAL_CHARACTER_TRACK.body);
        if (monster.state.hasAnimation("hidden")) {
          const hiddenEntry = monster.state.setAnimation(
            PRIMAL_CHARACTER_TRACK.body,
            "hidden",
            false,
          );
          hiddenEntry.mixDuration = 0;
          monster.update(0);
        }

        logo = createSpineView(data.logoIntro);
        logo.position.set(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2);
        logo.scale.set(0.8);
        logo.autoUpdate = false;
        logo.visible = false;
        logo.alpha = 0;
        logo.state.timeScale = this.reducedMotion ? 0 : 1;
        assertNotAborted();
        return { monster, logo };
      } catch (error) {
        monster?.destroy({ children: true, texture: false, baseTexture: false });
        logo?.destroy({ children: true, texture: false, baseTexture: false });
        throw error;
      }
    });

    // 即使一个分支被拒绝，也要等待两个分支，因此较慢的同级分支永远无法稍后完成并泄漏无主的分阶段 Spine 视图。
    const [bitmapResult, authoredResult] = await Promise.allSettled([bitmapLoad, authoredLoad]);
    const failure = signal?.aborted
      ? signal.reason ?? new Error("Launch artwork load was aborted")
      : bitmapResult.status === "rejected"
        ? bitmapResult.reason
        : authoredResult.status === "rejected"
          ? authoredResult.reason
          : null;
    if (failure !== null) {
      if (authoredResult.status === "fulfilled") {
        authoredResult.value.monster.destroy({ children: true, texture: false, baseTexture: false });
        authoredResult.value.logo.destroy({ children: true, texture: false, baseTexture: false });
      }
      throw failure;
    }
    if (authoredResult.status !== "fulfilled") {
      throw new Error("Authored launch artwork did not produce a character and intro logo");
    }

    const { monster, logo } = authoredResult.value;
    try {
      this.authoredMonster = monster;
      this.authoredLogo = logo;
      this.characterIntroActive = false;
      this.characterIntroElapsedMs = 0;
      this.characterBodyReleased = false;
      this.characterAuraReleased = false;
      this.characterIntroCapturePaused = false;
      this.idleSchedulerActive = false;
      this.idleLoopElapsedMs = 0;
      this.idleResumeRemainingMs = 0;
      this.idleResumeToBase = false;
      this.idleResumeToFeature = false;
      this.monsterHost.addChild(monster);
      this.overlay.addChild(logo);
      this.monsterFallback.visible = false;
      this.logo.visible = false;
      this.applyPersistentPresentation();
    } catch (error) {
      monster.parent?.removeChild(monster);
      logo.parent?.removeChild(logo);
      monster.destroy({ children: true, texture: false, baseTexture: false });
      logo.destroy({ children: true, texture: false, baseTexture: false });
      this.authoredMonster = null;
      this.authoredLogo = null;
      this.monsterFallback.visible = true;
      this.logo.visible = true;
      throw error;
    }
  }

  playCharacterAnimation(
    animation: string,
    loop = false,
    track: number = PRIMAL_CHARACTER_TRACK.body,
    restAnimation?: string,
    context: CharacterAnimationContext = "state",
  ): boolean {
    const monster = this.authoredMonster;
    if (!monster?.state.hasAnimation(animation)) return false;
    if (track === PRIMAL_CHARACTER_TRACK.body) {
      this.cancelWheelChestPoundReentry();
      if (animation !== "intro") this.releaseCharacterBodyForTakeover();
    }
    monster.state.timeScale = this.reducedMotion ? 0 : 1;
    const continuation = restAnimation ?? this.persistentBodyAnimation();
    const entry = monster.state.setAnimation(track, animation, loop);
    const hasBodyContinuation = track === PRIMAL_CHARACTER_TRACK.body
      && monster.state.hasAnimation(continuation);
    const ownsOfficialBaseWinHandoff = track === PRIMAL_CHARACTER_TRACK.body
      && animation === "win"
      && !loop
      && continuation === CHARACTER_BODY_CONTINUATION_ANIMATION.base
      && this.persistentPresentation.body === "base"
      && context === "state"
      && hasBodyContinuation;
    const ownsOfficialFeatureWinHandoff = track === PRIMAL_CHARACTER_TRACK.body
      && animation === "win"
      && !loop
      && continuation === CHARACTER_BODY_CONTINUATION_ANIMATION.feature
      && this.persistentPresentation.body === "feature"
      && context === "state"
      && hasBodyContinuation;
    if (track === PRIMAL_CHARACTER_TRACK.body
      && !loop
      && hasBodyContinuation
      && !ownsOfficialBaseWinHandoff
      && !ownsOfficialFeatureWinHandoff) {
      monster.state.addAnimation(PRIMAL_CHARACTER_TRACK.body, continuation, true, 0);
    }
    if (track === PRIMAL_CHARACTER_TRACK.body) {
      if (animation === this.persistentBodyAnimation() && loop
        && this.persistentPresentation.body === "base") {
        this.resetCharacterIdleScheduler();
      } else if (!loop && hasBodyContinuation) {
        this.idleSchedulerActive = false;
        this.idleLoopElapsedMs = 0;
        // 官方 Character 状态任务将预设的 Spine 持续时间限制为整数毫秒。特别是，
        // win 的 Float32 1.500000119 秒的持续时间恰好在 1,500 毫秒处传递。
        this.idleResumeRemainingMs = Math.max(1, Math.floor(entry.animationEnd * 1_000));
        this.idleResumeToBase = continuation === CHARACTER_BODY_CONTINUATION_ANIMATION.base
          && this.persistentPresentation.body === "base";
        this.idleResumeToFeature = ownsOfficialFeatureWinHandoff;
      } else {
        this.idleSchedulerActive = false;
        this.idleLoopElapsedMs = 0;
        this.idleResumeRemainingMs = 0;
        this.idleResumeToBase = false;
        this.idleResumeToFeature = false;
      }
    }
    if (track === PRIMAL_CHARACTER_TRACK.body
      && animation === "chest_pound"
      && loop
      && !this.reducedMotion
      && this.persistentPresentation.body === "feature") {
      this.startWheelChestPoundTask(monster, entry);
    }
    this.characterAnimationListener?.({ animation, context });
    return true;
  }

  /** PPS 收集叠加在轨道 0 上狂暴，而随机身体反应在轨道 1 上运行。 */
  playCharacterCollect(random = Math.random()): boolean {
    const bodyPlayed = this.playCharacterAnimation(
      characterCollectAnimationForRandom(random),
      false,
      PRIMAL_CHARACTER_TRACK.body,
      undefined,
      "collect-random",
    );
    const overlayPlayed = this.playCharacterAnimation(
      "rage_collect",
      false,
      PRIMAL_CHARACTER_TRACK.overlay,
    );
    return bodyPlayed && overlayPlayed;
  }

  setCharacterPersistentPresentation(presentation: CharacterPersistentPresentation): void {
    const auraLevel = presentation.auraLevel === null
      ? null
      : Math.max(1, Math.min(6, Math.floor(presentation.auraLevel)));
    this.persistentPresentation = {
      body: presentation.body,
      auraLevel,
      palette: presentation.palette,
    };
    this.applyPersistentPresentation();
  }

  /**
   * 仅供最终特性退出屏障调用。正常状态变化仍走 150 毫秒混合；这里先撤销全部旧特性
   * TrackEntry，再从设置姿势无混合地重放已提交的 Base 持久表现，保证退出 Promise 的首帧干净。
   */
  settleFeatureExit(): void {
    const monster = this.authoredMonster;
    if (!monster) return;
    this.cancelWheelChestPoundReentry();
    for (const track of [
      PRIMAL_CHARACTER_TRACK.overlay,
      PRIMAL_CHARACTER_TRACK.body,
      PRIMAL_CHARACTER_TRACK.aura,
      PRIMAL_CHARACTER_TRACK.particles,
      PRIMAL_CHARACTER_TRACK.palette,
    ]) {
      monster.state.clearTrack(track);
    }
    monster.skeleton.setToSetupPose();
    this.applyPersistentPresentation();
    for (const track of [
      PRIMAL_CHARACTER_TRACK.body,
      PRIMAL_CHARACTER_TRACK.aura,
      PRIMAL_CHARACTER_TRACK.particles,
      PRIMAL_CHARACTER_TRACK.palette,
    ]) {
      const entry = monster.state.getCurrent(track);
      if (entry) entry.mixDuration = 0;
    }
    monster.update(0);
  }

  setCharacterBodyContinuation(body: CharacterBodyContinuation, restart = true): void {
    if (body !== "feature") this.cancelWheelChestPoundReentry();
    if (this.persistentPresentation.body === "feature"
      && body !== "feature"
      && this.idleResumeRemainingMs > 0
      && this.idleResumeToFeature) {
      // 仅连续功能退出必须撤销 WIN_FEATURE 的挂起任务，即使它故意留下当前的 TrackEntry。否则，
      // 稍后切换回功能可能会让过时的计时器通过 LOOP_FEATURE 回收轨道 1。
      this.idleResumeRemainingMs = 0;
      this.idleResumeToBase = false;
      this.idleResumeToFeature = false;
    }
    this.persistentPresentation = { ...this.persistentPresentation, body };
    if (restart) this.applyPersistentBody();
  }

  /** EVOLVE 仅更改曲目 2/3；身体和特征颜色继续发挥作用。 */
  setCharacterAuraLevel(level: number | null): void {
    const auraLevel = level === null ? null : Math.max(1, Math.min(6, Math.floor(level)));
    this.persistentPresentation = { ...this.persistentPresentation, auraLevel };
    const monster = this.authoredMonster;
    if (!monster || !this.characterAuraReleased) return;
    this.applyPersistentAura(monster);
    monster.update(0);
  }

  resumeCharacterPersistentBody(): void {
    this.applyPersistentBody();
  }

  /** INTRO_HIDE 释放持久的 PPS 轨道而不触及身体时间。 */
  releaseAuthoredIntroAura(): void {
    if (this.characterAuraReleased) return;
    this.characterAuraReleased = true;
    const monster = this.authoredMonster;
    if (!monster) return;
    this.applyPersistentAura(monster);
    monster.update(0);
  }

  /** 预设的 INTRO 镀铬后尾部的减少运动切换。 */
  completeActiveCharacterIntroForReducedMotion(): boolean {
    if (!this.characterIntroActive) return false;
    this.authoredIntroTimelineControlled = false;
    this.authoredIntroTimeMs = 0;
    this.finishCharacterIntroToLoop();
    this.releaseAuthoredIntroAura();
    return true;
  }

  /**
   * 仅测试保留。时间线搜索仍然具有权威性，而时间线后的角色和空闲时钟可以冻结在精确的捕获帧上。
   */
  setCharacterIntroCapturePaused(paused: boolean): boolean {
    if (!this.authoredMonster) return false;
    this.characterIntroCapturePaused = paused;
    return true;
  }

  /** 在渲染器拆卸之前取消主机拥有的 Character 时钟。 */
  cancelCharacterStateTasks(): void {
    this.cancelWheelChestPoundReentry();
    this.characterIntroCapturePaused = false;
    this.idleSchedulerActive = false;
    this.idleLoopElapsedMs = 0;
    this.idleResumeRemainingMs = 0;
    this.idleResumeToBase = false;
    this.idleResumeToFeature = false;
  }

  /**
   * 浏览器测试夹具用于精确推进 Base WIN 转换。正常 RAF 播放无法进入此接口，
   * 因为它要求原生 Character 已暂停，并且时钟必须是 Pass53 白名单中的三种之一。
   */
  advanceBaseWinCharacterCapture(elapsedMs: number): boolean {
    const monster = this.authoredMonster;
    const current = monster?.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
    if (!monster
      || !this.characterIntroCapturePaused
      || this.reducedMotion
      || this.persistentPresentation.body !== "base"
      || current?.animation?.name !== "win"
      || this.idleResumeRemainingMs <= 0
      || !this.idleResumeToBase
      || (elapsedMs !== 1_499 && elapsedMs !== 1_500 && elapsedMs !== 1_650)) {
      return false;
    }

    let remainingMs = elapsedMs;
    while (remainingMs > 0) {
      // 切勿让一个步骤跨越待处理的 1,500 毫秒任务边界。这使得 1,650 毫秒路线恰好为 "1,500 then 150"，
      // 而每个 Spine 更新仍保持在渲染器的普通 64 毫秒追赶范围内。
      const handoffBoundaryMs = this.idleResumeRemainingMs > 0
        ? this.idleResumeRemainingMs
        : remainingMs;
      const stepMs = Math.min(
        CHARACTER_CAPTURE_MAX_STEP_MS,
        remainingMs,
        handoffBoundaryMs,
      );
      if (!Number.isFinite(stepMs) || stepMs <= 0) return false;
      monster.update(stepMs / 1_000);
      enforcePrimalRegionBlendModes(monster);
      this.updateCharacterIdle(stepMs, true);
      remainingMs = Math.max(0, remainingMs - stepMs);
    }
    // Spine 在应用期间释放完全消耗的 mixingFrom 链接。最终的零增量应用使得精确的 150 毫秒混合完成姿势可观察到。
    monster.update(0);
    enforcePrimalRegionBlendModes(monster);
    return true;
  }

  /**
   * 浏览器测试夹具用于精确推进 Wheel WIN_FEATURE。生产入口无法到达此接口：
   * 制作好的播放必须已暂停，轨道 1 必须持有待处理的特性 WIN 任务，
   * 并且请求的时钟必须是 Pass54 的三个冻结着陆相对边界之一。
   */
  advanceWheelWinFeatureCharacterCapture(elapsedMs: number): boolean {
    const monster = this.authoredMonster;
    const current = monster?.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
    if (!monster
      || !this.characterIntroCapturePaused
      || this.reducedMotion
      || this.persistentPresentation.body !== "feature"
      || current?.animation?.name !== "win"
      || this.idleResumeRemainingMs !== 1_500
      || !this.idleResumeToFeature
      || !Number.isFinite(current.trackTime)
      || Math.abs(current.trackTime) > 0.000_001
      || (elapsedMs !== 1_499 && elapsedMs !== 1_500 && elapsedMs !== 1_650)) {
      return false;
    }

    let remainingMs = elapsedMs;
    while (remainingMs > 0) {
      // 完全按照官方规定的 1,500 毫秒状态任务边界进行分割。这可以防止 1,650 毫秒的捕获跨越切换，并使每个 Spine 更新保持在普通渲染器追赶范围内。
      const handoffBoundaryMs = this.idleResumeRemainingMs > 0
        ? this.idleResumeRemainingMs
        : remainingMs;
      const stepMs = Math.min(
        CHARACTER_CAPTURE_MAX_STEP_MS,
        remainingMs,
        handoffBoundaryMs,
      );
      if (!Number.isFinite(stepMs) || stepMs <= 0) return false;
      monster.update(stepMs / 1_000);
      enforcePrimalRegionBlendModes(monster);
      this.updateCharacterIdle(stepMs, true);
      remainingMs = Math.max(0, remainingMs - stepMs);
    }
    monster.update(0);
    enforcePrimalRegionBlendModes(monster);
    return true;
  }

  /**
   * FEATURE_CHEST_LOOP 的仅浏览器固定步骤。它只能从真实的、暂停的 S0 所有者条目开始，并接受四个冻结的 Pass55 检查点。
   * 生产RAF播放时无法通过此缝进行寻道。
   */
  advanceWheelChestPoundCapture(elapsedMs: number): boolean {
    const monster = this.authoredMonster;
    const task = this.wheelChestPoundTask;
    const current = monster?.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
    if (!monster
      || !task
      || !this.characterIntroCapturePaused
      || this.reducedMotion
      || this.persistentPresentation.body !== "feature"
      || current !== task.ownerEntry
      || current.animation?.name !== "chest_pound"
      || !Number.isFinite(current.trackTime)
      || Math.abs(current.trackTime) > 0.000_001
      || task.targetSpinElapsedMs !== 0
      || task.taskElapsedMs !== 0
      || task.elapsedTicks !== 0
      || Math.abs(task.tickRemainderMs) > WHEEL_CHEST_POUND_TICK_EPSILON
      || task.entryOrdinal !== 1
      || task.reentryCount !== 0
      || !WHEEL_CHEST_POUND_CAPTURE_TARGETS_MS.some((target) => elapsedMs === target)) {
      return false;
    }

    let remainingMs = elapsedMs;
    while (remainingMs > WHEEL_CHEST_POUND_TICK_EPSILON) {
      const activeTask = this.wheelChestPoundTask;
      if (!activeTask) return false;
      const taskBoundaryMs = WHEEL_CHEST_POUND_REENTRY_MS - activeTask.taskElapsedMs;
      const stepMs = Math.min(
        WHEEL_CHEST_POUND_TICK_MS,
        remainingMs,
        taskBoundaryMs,
      );
      if (!Number.isFinite(stepMs) || stepMs <= WHEEL_CHEST_POUND_TICK_EPSILON) return false;
      monster.update(stepMs / 1_000);
      enforcePrimalRegionBlendModes(monster);
      this.updateWheelChestPound(stepMs, true);
      remainingMs = Math.max(0, remainingMs - stepMs);
    }

    const finalTask = this.wheelChestPoundTask;
    if (!finalTask) return false;
    finalTask.targetSpinElapsedMs = elapsedMs;
    const exactTaskElapsedMs = elapsedMs % WHEEL_CHEST_POUND_REENTRY_MS;
    finalTask.taskElapsedMs = exactTaskElapsedMs < WHEEL_CHEST_POUND_TICK_EPSILON
      || WHEEL_CHEST_POUND_REENTRY_MS - exactTaskElapsedMs < WHEEL_CHEST_POUND_TICK_EPSILON
      ? 0
      : exactTaskElapsedMs;
    // Spine 在添加当前增量之前检查先前的混合。因此，重复 30 Hz 浮动步骤可以留下 150 ms，表示为 0.14999999999999886 s。仅关闭亚纳秒捕获缺陷，
    // 然后再次应用，以便精确的 150 毫秒边界释放 mixingFrom。
    const bodyEntry = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
    if (elapsedMs === WHEEL_CHEST_POUND_REENTRY_MS + 150
      && bodyEntry?.mixingFrom
      && Number.isFinite(bodyEntry.mixTime)
      && Number.isFinite(bodyEntry.mixDuration)) {
      const mixDeficitSeconds = bodyEntry.mixDuration - bodyEntry.mixTime;
      if (mixDeficitSeconds > 0
        && mixDeficitSeconds <= WHEEL_CHEST_POUND_CAPTURE_MIX_EPSILON_SECONDS) {
        monster.update(mixDeficitSeconds);
        enforcePrimalRegionBlendModes(monster);
      }
    }
    // 运行时在应用期间释放完全消耗的 mixingFrom 链接。
    monster.update(0);
    enforcePrimalRegionBlendModes(monster);
    return true;
  }

  /** 第一个 Pass55 测试场景转发器使用的兼容性拼写。 */
  advanceWheelChestPoundCharacterCapture(elapsedMs: number): boolean {
    return this.advanceWheelChestPoundCapture(elapsedMs);
  }

  /** 确定性 Pass55 装置的冻结、只读状态/任务证据。 */
  getWheelChestPoundDiagnostics(): WheelChestPoundCaptureDiagnostics {
    const task = this.wheelChestPoundTask;
    const current = this.authoredMonster?.state.getCurrent(PRIMAL_CHARACTER_TRACK.body) ?? null;
    const ownerIsCurrent = Boolean(task && current === task.ownerEntry);
    const nonBodyTrackIdentityPreserved = Boolean(task && this.authoredMonster
      && WHEEL_CHEST_POUND_NON_BODY_TRACKS.every((track, index) => (
        this.authoredMonster?.state.getCurrent(track) === task.nonBodyTrackOwners[index]
      )));
    return Object.freeze({
      schedulerFps: WHEEL_CHEST_POUND_SCHEDULER_FPS,
      flooredTaskMs: WHEEL_CHEST_POUND_FLOORED_TASK_MS,
      taskTicks: WHEEL_CHEST_POUND_TASK_TICKS,
      periodMs: WHEEL_CHEST_POUND_REENTRY_MS,
      targetSpinElapsedMs: task?.targetSpinElapsedMs ?? 0,
      taskElapsedMs: task?.taskElapsedMs ?? 0,
      entryOrdinal: task?.entryOrdinal ?? 0,
      reentryCount: task?.reentryCount ?? 0,
      schedulerActive: task !== null,
      generation: task?.generation ?? this.wheelChestPoundGeneration,
      ownerIsCurrent,
      nonBodyTrackIdentityPreserved,
      tracks: this.getCharacterTrackDiagnostics(),
    });
  }

  /** 第一个 Pass55 测试场景转发器使用的兼容性拼写。 */
  getWheelChestPoundCaptureDiagnostics(): WheelChestPoundCaptureDiagnostics {
    return this.getWheelChestPoundDiagnostics();
  }

  /** 冻结浏览器测试夹具的只读证据；值永远不会提供呈现状态。 */
  getCharacterIntroLifecycleDiagnostics(): CharacterIntroLifecycleDiagnostics {
    return Object.freeze({
      introActive: this.characterIntroActive,
      introElapsedMs: this.characterIntroElapsedMs,
      taskDurationMs: CHARACTER_INTRO_TASK_MS,
      timelineControlled: this.authoredIntroTimelineControlled,
      bodyReleased: this.characterBodyReleased,
      auraReleased: this.characterAuraReleased,
      idleSchedulerActive: this.idleSchedulerActive,
      capturePaused: this.characterIntroCapturePaused,
    });
  }

  /**
   * 在不改变游戏逻辑的情况下为确定性截图准备场景。官方 Base 控制器不监听 SPIN_START：
   * 其 10 秒 LOOP/BREAK 调度器仍独立于转轴运动。
   * 一旦预设的介绍释放了身体轨迹，捕获页面可以请求中性零混合姿势，然后仅冻结随机空闲调度程序。
   */
  prepareNeutralBaseCapture(): boolean {
    const monster = this.authoredMonster;
    if (!monster
      || !this.characterBodyReleased
      || this.characterIntroActive
      || this.persistentPresentation.body !== "base"
      || !monster.state.hasAnimation(CHARACTER_BODY_CONTINUATION_ANIMATION.base)) return false;

    this.cancelWheelChestPoundReentry();
    this.visualCaptureIdleSuspended = true;
    this.idleSchedulerActive = false;
    this.idleLoopElapsedMs = 0;
    this.idleResumeRemainingMs = 0;
    this.idleResumeToBase = true;
    this.idleResumeToFeature = false;
    // 仅零混合持续时间仍将前面的 TrackEntry 保留为 `mixingFrom`，直到 AnimationState 前进。
    // 捕获调节在此渲染回合中需要字面上的第一个 Base 空闲姿势。首先恢复预设的设置值，因为即使在主体 TrackEntry 分离后，
    // 未加密的 INTRO 骨骼/插槽仍会保留其最后的值。
    monster.skeleton.setToSetupPose();
    monster.state.clearTrack(PRIMAL_CHARACTER_TRACK.body);
    const entry = monster.state.setAnimation(
      PRIMAL_CHARACTER_TRACK.body,
      CHARACTER_BODY_CONTINUATION_ANIMATION.base,
      true,
    );
    entry.mixDuration = 0;
    monster.update(0);
    return true;
  }

  /** 只读浏览器测试夹具的只读证据；值永远不会提供呈现状态。 */
  getCharacterTrackDiagnostics(): readonly CharacterTrackDiagnostic[] {
    const state = this.authoredMonster?.state;
    if (!state) return [];
    return Object.freeze([0, 1, 2, 3, 4].map((track) => {
      const entry = state.getCurrent(track);
      return Object.freeze({
        track,
        animation: entry?.animation?.name ?? null,
        trackTime: Number.isFinite(entry?.trackTime) ? entry.trackTime : null,
        mixingFrom: entry?.mixingFrom?.animation?.name ?? null,
        mixDuration: Number.isFinite(entry?.mixDuration) ? entry.mixDuration : null,
      });
    }));
  }

  clearCharacterFeatureTracks(): void {
    const monster = this.authoredMonster;
    if (!monster) return;
    this.mixOutCharacterTrack(monster, PRIMAL_CHARACTER_TRACK.aura);
    this.mixOutCharacterTrack(monster, PRIMAL_CHARACTER_TRACK.particles);
    this.mixOutCharacterTrack(monster, PRIMAL_CHARACTER_TRACK.palette);
    monster.tint = CHARACTER_PALETTE_TINT.main;
    monster.update(0);
  }

  private persistentBodyAnimation(): string {
    return CHARACTER_BODY_CONTINUATION_ANIMATION[this.persistentPresentation.body];
  }

  private applyPersistentPresentation(): void {
    const monster = this.authoredMonster;
    if (!monster) return;
    if (this.characterBodyReleased) this.applyPersistentBody(monster);
    if (this.characterAuraReleased) this.applyPersistentAura(monster);

    const paletteAnimation = this.persistentPresentation.palette === "fire"
      ? "Fs_bg_fire_color"
      : this.persistentPresentation.palette === "snow"
        ? "Fs_bg_snow_color"
        : null;
    monster.tint = CHARACTER_PALETTE_TINT[this.persistentPresentation.palette];
    if (paletteAnimation && monster.state.hasAnimation(paletteAnimation)) {
      monster.state.setAnimation(PRIMAL_CHARACTER_TRACK.palette, paletteAnimation, false);
    } else {
      this.mixOutCharacterTrack(monster, PRIMAL_CHARACTER_TRACK.palette);
    }
    monster.update(0);
  }

  private applyPersistentAura(monster: Spine): void {
    const auraLevel = this.persistentPresentation.auraLevel;
    const aura = auraLevel === null ? null : `aura_${auraLevel}`;
    if (!aura || !monster.state.hasAnimation(aura)) {
      // 官方 stopLayer 路径与空动画混合 150 毫秒。 clearTrack() 并不等效：Spine 故意将关键帧骨骼、附件和颜色冻结在上次应用的姿势中。
      this.mixOutCharacterTrack(monster, PRIMAL_CHARACTER_TRACK.aura);
      this.mixOutCharacterTrack(monster, PRIMAL_CHARACTER_TRACK.particles);
      return;
    }
    monster.state.setAnimation(PRIMAL_CHARACTER_TRACK.aura, aura, true);
    if (monster.state.hasAnimation("particles_loop")) {
      monster.state.setAnimation(PRIMAL_CHARACTER_TRACK.particles, "particles_loop", true);
    } else {
      this.mixOutCharacterTrack(monster, PRIMAL_CHARACTER_TRACK.particles);
    }
  }

  private mixOutCharacterTrack(monster: Spine, track: number): void {
    if (!monster.state.getCurrent(track)) return;
    monster.state.setEmptyAnimation(track, SPINE_DEFAULT_MIX_SECONDS);
  }

  private applyPersistentBody(monster: Spine | null = this.authoredMonster): void {
    this.cancelWheelChestPoundReentry();
    if (!monster || !this.characterBodyReleased || this.characterIntroActive) return;
    const animation = this.persistentBodyAnimation();
    if (monster.state.hasAnimation(animation)) {
      monster.state.setAnimation(PRIMAL_CHARACTER_TRACK.body, animation, true);
    }
    if (this.persistentPresentation.body === "base" && !this.visualCaptureIdleSuspended) {
      this.resetCharacterIdleScheduler();
    }
    else {
      this.idleSchedulerActive = false;
      this.idleLoopElapsedMs = 0;
      this.idleResumeRemainingMs = 0;
      this.idleResumeToBase = false;
      this.idleResumeToFeature = false;
    }
  }

  /** 独立于 Spine 回调推进恢复状态任务。 */
  private advanceCharacterIntroTask(deltaMs: number): void {
    if (!this.characterIntroActive || deltaMs <= 0) return;
    this.characterIntroElapsedMs = Math.min(
      CHARACTER_INTRO_TASK_MS,
      this.characterIntroElapsedMs + deltaMs,
    );
    if (this.characterIntroElapsedMs < CHARACTER_INTRO_TASK_MS) return;
    this.finishCharacterIntroToLoop(false);
  }

  /**
   * INTRO_SKIP/可访问完成寻求确切的结束；自然任务在其 8,066 毫秒边界上进入 LOOP，无需等待 Spine 完成回调（预设的动画为 8,066.701 毫秒）。
   */
  private finishCharacterIntroToLoop(seekToEnd = true): void {
    const monster = this.authoredMonster;
    if (!monster || !this.characterIntroActive) return;
    if (seekToEnd && monster.state.hasAnimation("intro")) {
      const current = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
      const introEntry = current?.animation?.name === "intro"
        ? current
        : monster.state.setAnimation(PRIMAL_CHARACTER_TRACK.body, "intro", false);
      introEntry.mixDuration = 0;
      introEntry.trackTime = introEntry.animationEnd;
      monster.update(0);
    }

    this.characterIntroElapsedMs = CHARACTER_INTRO_TASK_MS;
    this.characterIntroActive = false;
    this.characterBodyReleased = true;
    this.characterIntroCapturePaused = false;
    this.applyPersistentBody(monster);
  }

  /** 从这次调用开始，结果/特征动画拥有主体轨迹 1。 */
  private releaseCharacterBodyForTakeover(): void {
    if (this.characterIntroActive) this.authoredIntroTimelineControlled = false;
    this.characterIntroActive = false;
    this.characterBodyReleased = true;
    this.characterIntroCapturePaused = false;
    this.idleSchedulerActive = false;
    this.idleLoopElapsedMs = 0;
    this.idleResumeRemainingMs = 0;
    this.idleResumeToBase = false;
    this.idleResumeToFeature = false;
  }

  private updateCharacterIdle(deltaMs: number, allowCaptureStep = false): void {
    const ownsPendingFeatureHandoff = this.persistentPresentation.body === "feature"
      && this.idleResumeRemainingMs > 0
      && this.idleResumeToFeature;
    if (!this.authoredMonster
      || (this.characterIntroCapturePaused && !allowCaptureStep)
      || !this.characterBodyReleased
      || this.characterIntroActive
      || this.visualCaptureIdleSuspended
      || (this.persistentPresentation.body !== "base" && !ownsPendingFeatureHandoff)) return;
    const elapsed = Math.max(0, Math.min(PRIMAL_SCHEDULER_MAX_CATCH_UP_MS, deltaMs));
    if (this.idleResumeRemainingMs > 0) {
      this.idleResumeRemainingMs = Math.max(0, this.idleResumeRemainingMs - elapsed);
      if (this.idleResumeRemainingMs === 0
        && (this.idleResumeToBase || this.idleResumeToFeature)) {
        // BREAK 和 Base WIN 拥有其完整剪辑的身体轨迹。 WIN_FEATURE 遵循 LOOP_FEATURE 之前相同的任务规则。仅在完整持续时间后才开始持久循环；
        // Spine 的延迟 = 0 队列会提前将其混合到一个默认混合（150 毫秒）中。
        this.applyPersistentBody(this.authoredMonster);
      }
      return;
    }
    // 减少运动会冻结姿势回放，而不是状态/结果时钟。因此，上面未决的显式切换仍然只完成一次，而随机的十秒空闲中断时钟在这里保持暂停。
    if (this.reducedMotion) return;
    if (!this.idleSchedulerActive) return;
    this.idleLoopElapsedMs += elapsed;
    if (this.idleLoopElapsedMs < CHARACTER_IDLE_LOOP_MS) return;

    const animation = characterIdleBreakerForRandom(Math.random());
    const descriptor = CHARACTER_IDLE_BREAKERS.find((candidate) => candidate.animation === animation)
      ?? CHARACTER_IDLE_BREAKERS[0];
    const monster = this.authoredMonster;
    if (!monster.state.hasAnimation(animation)) {
      this.resetCharacterIdleScheduler();
      return;
    }
    this.cancelWheelChestPoundReentry();
    monster.state.setAnimation(PRIMAL_CHARACTER_TRACK.body, animation, false);
    this.idleSchedulerActive = false;
    this.idleLoopElapsedMs = 0;
    this.idleResumeRemainingMs = descriptor.durationMs;
    this.idleResumeToBase = true;
    this.idleResumeToFeature = false;
    this.characterAnimationListener?.({ animation, context: "idle-breaker" });
  }

  /**
   * 官方的 FEATURE_CHEST_LOOP 状态会在每个预设的 115 个周期任务中重新进入一次，而不是仅依赖于 Spine 的内部循环标志。
   * 每一代所有者都与其安装的 TrackEntry 绑定。
   */
  private updateWheelChestPound(deltaMs: number, allowCaptureStep = false): void {
    const task = this.wheelChestPoundTask;
    if (!task) return;
    if (this.reducedMotion) {
      this.cancelWheelChestPoundReentry();
      return;
    }
    if (this.characterIntroCapturePaused && !allowCaptureStep) return;
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    const monster = this.authoredMonster;
    if (!monster
      || this.persistentPresentation.body !== "feature"
      || monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body) !== task.ownerEntry
      || task.ownerEntry.animation?.name !== "chest_pound"
      || !monster.state.hasAnimation("chest_pound")) {
      this.cancelWheelChestPoundReentry();
      return;
    }

    const elapsedMs = Math.min(PRIMAL_SCHEDULER_MAX_CATCH_UP_MS, deltaMs);
    task.targetSpinElapsedMs += elapsedMs;
    task.taskElapsedMs += elapsedMs;
    const pendingTickMs = task.tickRemainderMs + elapsedMs;
    const availableTicks = Math.floor(
      (pendingTickMs + WHEEL_CHEST_POUND_TICK_EPSILON) / WHEEL_CHEST_POUND_TICK_MS,
    );
    const elapsedTicks = Math.min(5, Math.max(0, availableTicks));
    task.tickRemainderMs = pendingTickMs - elapsedTicks * WHEEL_CHEST_POUND_TICK_MS;
    if (Math.abs(task.tickRemainderMs) < WHEEL_CHEST_POUND_TICK_EPSILON) {
      task.tickRemainderMs = 0;
    }
    task.elapsedTicks += elapsedTicks;
    if (task.elapsedTicks < WHEEL_CHEST_POUND_TASK_TICKS) return;

    // 5 个刻度的追赶上限小于 1 个 115 个刻度的任务周期，因此一次渲染器更新永远不会发出多个过时的自状态条目。
    task.elapsedTicks -= WHEEL_CHEST_POUND_TASK_TICKS;
    task.taskElapsedMs %= WHEEL_CHEST_POUND_REENTRY_MS;
    if (task.taskElapsedMs < WHEEL_CHEST_POUND_TICK_EPSILON
      || WHEEL_CHEST_POUND_REENTRY_MS - task.taskElapsedMs
        < WHEEL_CHEST_POUND_TICK_EPSILON) {
      task.taskElapsedMs = 0;
    }
    const entry = monster.state.setAnimation(
      PRIMAL_CHARACTER_TRACK.body,
      "chest_pound",
      true,
    );
    task.ownerEntry = entry;
    task.generation = ++this.wheelChestPoundGeneration;
    task.entryOrdinal += 1;
    task.reentryCount += 1;
    task.targetSpinElapsedMs = task.reentryCount * WHEEL_CHEST_POUND_REENTRY_MS
      + task.taskElapsedMs;
    this.characterAnimationListener?.({ animation: "chest_pound", context: "state" });
  }

  private cancelWheelChestPoundReentry(): void {
    if (!this.wheelChestPoundTask) return;
    this.wheelChestPoundTask = null;
    this.wheelChestPoundGeneration += 1;
  }

  private startWheelChestPoundTask(monster: Spine, entry: CharacterTrackEntry): void {
    if (monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body) !== entry
      || Math.floor(entry.animationEnd * 1_000) !== WHEEL_CHEST_POUND_FLOORED_TASK_MS) return;
    const generation = ++this.wheelChestPoundGeneration;
    this.wheelChestPoundTask = {
      generation,
      ownerEntry: entry,
      targetSpinElapsedMs: 0,
      taskElapsedMs: 0,
      elapsedTicks: 0,
      tickRemainderMs: 0,
      entryOrdinal: 1,
      reentryCount: 0,
      nonBodyTrackOwners: Object.freeze(WHEEL_CHEST_POUND_NON_BODY_TRACKS.map(
        (track) => monster.state.getCurrent(track),
      )),
    };
  }

  private resetCharacterIdleScheduler(): void {
    this.idleLoopElapsedMs = 0;
    this.idleResumeRemainingMs = 0;
    this.idleResumeToBase = true;
    this.idleResumeToFeature = false;
    this.idleSchedulerActive = true;
  }

  private createShockwave(): void {
    for (let index = 0; index < 3; index += 1) {
      const ring = new Graphics();
      ring.lineStyle(6 - index, index % 2 === 0 ? 0xc7d5d8 : 0xa74238, 0.82 - index * 0.2);
      ring.drawCircle(0, 0, 58 + index * 31);
      this.shockwave.addChild(ring);
    }
  }

  private createParticles(): void {
    for (let index = 0; index < 46; index += 1) {
      const particle = new Graphics();
      const color = index % 9 === 0 ? 0xc15a3f : index % 3 === 0 ? 0xc4cdd0 : 0x77858a;
      particle.beginFill(color, 0.28 + (index % 4) * 0.08).drawCircle(0, 0, 1 + (index % 3) * 0.65).endFill();
      particle.position.set((index * 173) % LOGICAL_WIDTH, (index * 83) % 690 + 20);
      this.particles.addChild(particle);
    }
  }

  private createDepthSmoke(): void {
    for (let index = 0; index < 5; index += 1) {
      const plume = new Graphics();
      const width = 250 + index * 46;
      const height = 66 + index * 9;
      plume.beginFill(index % 2 === 0 ? 0xaab5b8 : 0x7f8d92, 0.24);
      plume.drawEllipse(0, 0, width, height);
      plume.drawCircle(-width * 0.26, -height * 0.18, height * 0.68);
      plume.drawCircle(width * 0.22, -height * 0.3, height * 0.82);
      plume.endFill();
      this.depthSmoke.addChild(plume);
    }
    this.depthSmoke.filters = [new filters.BlurFilter(28, 2)];
  }

  private createMonsterVeil(): void {
    this.monsterVeil.beginFill(0xb8c4c7, 0.62).drawEllipse(640, 145, 365, 178).endFill();
    this.monsterVeil.beginFill(0x8f9da2, 0.28).drawEllipse(640, 240, 430, 150).endFill();
    this.monsterVeil.pivot.set(640, 185);
    this.monsterVeil.position.set(640, 185);
    this.monsterVeil.filters = [new filters.BlurFilter(52, 2)];
  }
}
