import { Container, type IDestroyOptions } from "pixi.js";
import {
  resolveResponsiveMinBound,
  responsiveRendererRegion,
  type MobileLayoutProfile,
  type ResponsiveNodeTransform,
} from "./ResponsiveLayout";
import { createSpineView, type Spine } from "./spine/SpineAdapter";
import { loadPrimalSpineData } from "./spine/PrimalSpineAssets";

export const LOGO_GAME_ANIMATION = Object.freeze({
  hidden: "hidden",
  show: "show",
  idle: "idle",
  hide: "hide",
  win: "win",
});

/** 持续时间根据提供的 `logo_game.skel` 测量。 */
export const LOGO_GAME_ANIMATION_MS = Object.freeze({
  show: 1_033.333,
  idle: 1_500,
  hide: 333.333,
  win: 1_066.667,
});

/** 原始 Flash 显示列表主机点为徽标 Spine 实例。 */
export const LOGO_GAME_SPINE_HOST = Object.freeze({ x: 600, y: 74 });

/** 源控制器在显示徽标之前等待六个 24fps 帧。 */
export const LOGO_GAME_SHOW_DELAY_MS = 250;

export const LOGO_GAME_IDLE_TIMING = Object.freeze({
  fps: 24,
  minFrames: 100,
  maxFrames: 200,
});

/** 对源控制器的稀疏、非循环空闲间隔进行采样。 */
export function logoGameIdleDelayMs(random: () => number = Math.random): number {
  const sample = Math.min(1 - Number.EPSILON, Math.max(0, random()));
  const frameRange = LOGO_GAME_IDLE_TIMING.maxFrames - LOGO_GAME_IDLE_TIMING.minFrames;
  const frames = Math.round(LOGO_GAME_IDLE_TIMING.minFrames + sample * frameRange);
  return frames * (1_000 / LOGO_GAME_IDLE_TIMING.fps);
}

/**
 * 捕获的桌面根转换。预设的最小边界映射到精确的 1280x720 游戏组合：-232 + 460*.8 = 136 和 104 - 130*.8 = 0。
 */
export const LOGO_GAME_DESKTOP_LAYOUT = Object.freeze({
  x: -232,
  y: 104,
  scale: 0.8,
  minBound: Object.freeze([460, -130, 1_260, 900] as const),
});

/** 解析当前可见渲染器活动区域内的徽标根。 */
export function logoGameResponsiveLayout(
  visibleInsetX: number,
): ResponsiveNodeTransform {
  const [left, top, width, height] = LOGO_GAME_DESKTOP_LAYOUT.minBound;
  return resolveResponsiveMinBound(
    responsiveRendererRegion(visibleInsetX),
    { left, top, width, height },
  );
}

/** 运行时单位校正是根据官方纵向通道捕获进行测量的。 */
export function logoGameMobileLayout(
  transform: ResponsiveNodeTransform,
  profile: MobileLayoutProfile,
): ResponsiveNodeTransform {
  if (profile === "ls") {
    const responsiveShift = Math.max(0, Math.min(1, (transform.scale - 0.372) / 0.359));
    return {
      x: transform.x + responsiveShift * 32,
      y: transform.y + responsiveShift * 15,
      scale: transform.scale,
    };
  }
  if (profile !== "pt") return transform;
  const scaleFactor = 1.13;
  return {
    x: transform.x
      - LOGO_GAME_SPINE_HOST.x * transform.scale * (scaleFactor - 1),
    y: transform.y + 70
      - LOGO_GAME_SPINE_HOST.y * transform.scale * (scaleFactor - 1),
    scale: transform.scale * scaleFactor,
  };
}

export type LogoGameAnimationIntent = "show" | "hide" | "win";

/** 视图和重点资产路由测试使用的导出合约。 */
export function logoGameAnimationSequence(
  intent: LogoGameAnimationIntent,
): readonly { readonly animation: string; readonly loop: boolean }[] {
  switch (intent) {
    case "show":
      return [{ animation: LOGO_GAME_ANIMATION.show, loop: false }];
    case "hide":
      return [
        { animation: LOGO_GAME_ANIMATION.hide, loop: false },
        { animation: LOGO_GAME_ANIMATION.hidden, loop: false },
      ];
    case "win":
      return [{ animation: LOGO_GAME_ANIMATION.win, loop: false }];
  }
}

export interface LogoGameViewOptions {
  /** 源控制器延迟动画任务的测试/主机接口。 */
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
  readonly random?: () => number;
}

/**
 * 本机基础游戏徽标控制器。 Spine 文件拥有每个像素和显示/隐藏/中奖转换；此视图仅将已经权威的游戏生命周期事件路由到那些捕获的剪辑上。
 */
export class LogoGameView extends Container {
  private readonly schedule: NonNullable<LogoGameViewOptions["schedule"]>;
  private readonly cancelSchedule: NonNullable<LogoGameViewOptions["cancelSchedule"]>;
  private readonly random: NonNullable<LogoGameViewOptions["random"]>;
  private spine: Spine | null = null;
  private loadPromise: Promise<void> | null = null;
  private hideHandle: ReturnType<typeof setTimeout> | null = null;
  private showHandle: ReturnType<typeof setTimeout> | null = null;
  private idleHandle: ReturnType<typeof setTimeout> | null = null;
  private desiredShown = false;
  private idleAllowed = true;
  private disposed = false;

  constructor(options: LogoGameViewOptions = {}) {
    super();
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle));
    this.random = options.random ?? Math.random;
    this.setResponsiveLayout(0);
    this.visible = false;
    this.interactive = false;
  }

  get artworkLoaded(): boolean {
    return this.spine !== null;
  }

  get presentation(): "shown" | "hidden" {
    return this.desiredShown ? "shown" : "hidden";
  }

  setResponsiveLayout(visibleInsetX: number): void {
    const layout = logoGameResponsiveLayout(visibleInsetX);
    this.position.set(layout.x, layout.y);
    this.scale.set(layout.scale);
  }

  setResponsiveNodeTransform(
    transform: ResponsiveNodeTransform | null,
    profile?: MobileLayoutProfile,
  ): void {
    if (!transform) {
      this.setResponsiveLayout(0);
      return;
    }
    const layout = profile ? logoGameMobileLayout(transform, profile) : transform;
    this.position.set(layout.x, layout.y);
    this.scale.set(layout.scale);
  }

  loadArtwork(signal?: AbortSignal): Promise<void> {
    if (this.spine) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;

    const attempt = loadPrimalSpineData("logoGame").then((data) => {
      if (signal?.aborted) return;
      const spine = createSpineView(data);
      spine.autoUpdate = false;
      spine.position.set(LOGO_GAME_SPINE_HOST.x, LOGO_GAME_SPINE_HOST.y);
      if (this.disposed || signal?.aborted) {
        spine.destroy({ children: true });
        return;
      }
      this.spine = spine;
      this.addChild(spine);
      this.playHidden();
      if (this.desiredShown) this.scheduleShow();
    }).catch((error: unknown) => {
      this.loadPromise = null;
      throw error;
    });
    this.loadPromise = attempt;
    return attempt;
  }

  /** 入口和 Free Spins 出口使用本机延迟的单镜头表演剪辑。 */
  show(): void {
    if (this.disposed || this.desiredShown) return;
    this.desiredShown = true;
    this.clearHideSchedule();
    this.clearIdleSchedule();
    this.visible = true;
    this.scheduleShow();
  }

  /** Free Spins 条目在变为非渲染之前使用本机隐藏剪辑。 */
  hide(immediate = false): void {
    if (this.disposed) return;
    const wasShown = this.desiredShown;
    this.desiredShown = false;
    this.clearHideSchedule();
    this.clearShowSchedule();
    this.clearIdleSchedule();
    if (immediate || !this.spine || !wasShown) {
      this.playHidden();
      return;
    }

    this.visible = true;
    this.play("hide");
    this.hideHandle = this.schedule(() => {
      this.hideHandle = null;
      if (!this.desiredShown && !this.disposed) this.playHidden();
    }, LOGO_GAME_ANIMATION_MS.hide);
  }

  /** 仅当基本徽标处于活动状态时，解码的行中奖才可以使徽标具有动画效果。 */
  win(): void {
    if (this.disposed || !this.desiredShown || !this.spine) return;
    this.clearHideSchedule();
    this.clearShowSchedule();
    this.clearIdleSchedule();
    this.visible = true;
    this.play("win");
    this.scheduleIdle(LOGO_GAME_ANIMATION_MS.win);
  }

  /** 镜像卷轴行程周围的源 `_isInIdle` 门。 */
  setIdleAllowed(allowed: boolean): void {
    this.idleAllowed = allowed;
  }

  update(deltaMs: number): void {
    if (!this.visible || !this.spine) return;
    this.spine.update(Math.min(64, Math.max(0, deltaMs)) / 1_000);
  }

  override destroy(options?: IDestroyOptions | boolean): void {
    if (this.disposed) return;
    this.disposed = true;
    this.desiredShown = false;
    this.clearHideSchedule();
    this.clearShowSchedule();
    this.clearIdleSchedule();
    this.spine = null;
    super.destroy(options);
  }

  private play(intent: LogoGameAnimationIntent): void {
    const spine = this.spine;
    if (!spine) return;
    const sequence = logoGameAnimationSequence(intent);
    spine.skeleton.setToSetupPose();
    spine.state.clearTrack(0);
    sequence.forEach(({ animation, loop }, index) => {
      if (!spine.state.hasAnimation(animation)) return;
      const entry = index === 0
        ? spine.state.setAnimation(0, animation, loop)
        : spine.state.addAnimation(0, animation, loop, 0);
      entry.mixDuration = 0;
    });
    spine.update(0);
  }

  private playHidden(): void {
    const spine = this.spine;
    if (spine) {
      spine.skeleton.setToSetupPose();
      spine.state.clearTracks();
      if (spine.state.hasAnimation(LOGO_GAME_ANIMATION.hidden)) {
        const entry = spine.state.setAnimation(0, LOGO_GAME_ANIMATION.hidden, false);
        entry.mixDuration = 0;
      }
      spine.update(0);
    }
    this.visible = false;
  }

  private scheduleShow(): void {
    const spine = this.spine;
    if (!spine) return;
    this.clearShowSchedule();
    this.clearIdleSchedule();
    this.showHandle = this.schedule(() => {
      this.showHandle = null;
      if (!this.desiredShown || this.disposed || !this.spine) return;
      this.visible = true;
      this.play("show");
      this.scheduleIdle(LOGO_GAME_ANIMATION_MS.show);
    }, LOGO_GAME_SHOW_DELAY_MS);
  }

  private scheduleIdle(previousAnimationMs: number, delaySegments = 1): void {
    this.clearIdleSchedule();
    let delayMs = previousAnimationMs;
    for (let segment = 0; segment < delaySegments; segment += 1) {
      delayMs += logoGameIdleDelayMs(this.random);
    }
    this.idleHandle = this.schedule(() => {
      this.idleHandle = null;
      const spine = this.spine;
      if (!this.desiredShown || this.disposed || !spine) return;
      if (this.idleAllowed) {
        spine.skeleton.setToSetupPose();
        spine.state.clearTrack(0);
        if (spine.state.hasAnimation(LOGO_GAME_ANIMATION.idle)) {
          const entry = spine.state.setAnimation(0, LOGO_GAME_ANIMATION.idle, false);
          entry.mixDuration = 0;
        }
        spine.update(0);
      }
      // 源任务在每次随机延迟时都会增加状态，并且仅在奇数状态下调用空闲，因此稳定的空闲启动相隔两个独立的延迟。剪辑持续时间不会添加到该任务时钟中。
      this.scheduleIdle(0, 2);
    }, delayMs);
  }

  private clearHideSchedule(): void {
    if (this.hideHandle === null) return;
    this.cancelSchedule(this.hideHandle);
    this.hideHandle = null;
  }

  private clearShowSchedule(): void {
    if (this.showHandle === null) return;
    this.cancelSchedule(this.showHandle);
    this.showHandle = null;
  }

  private clearIdleSchedule(): void {
    if (this.idleHandle === null) return;
    this.cancelSchedule(this.idleHandle);
    this.idleHandle = null;
  }
}
