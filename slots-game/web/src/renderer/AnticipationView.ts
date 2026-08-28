import { BLEND_MODES, Container, Rectangle, type IDestroyOptions } from "pixi.js";
import {
  REEL_AREA_HEIGHT,
  REEL_STAGE_Y,
  type ReelAnticipationHostProjection,
  type ReelSetView,
} from "../reels/ReelSetView";
import {
  ReelPerspectiveFilter,
  type ReelPerspectiveFilterDiagnostics,
} from "../reels/ReelPerspectiveFilter";
import { PRIMAL_REEL_ANTICIPATION_TRANSITION_MS } from "../reels/primalAnimationTiming";
import { createSpineView, type Spine } from "./spine/SpineAdapter";
import { loadPrimalSpineData } from "./spine/PrimalSpineAssets";
import { LOGICAL_WIDTH } from "./theme";

/** 捕获的 `GameReelSuspenseView` 使用的精确轨道和剪辑。 */
export const PRIMAL_ANTICIPATION_TRACK = Object.freeze({
  loop: 0,
  transition: 1,
});

export const PRIMAL_ANTICIPATION_ANIMATION = Object.freeze({
  hidden: "hidden",
  in: "in",
  loop: "loop",
  hide: "hide",
});

export const PRIMAL_ANTICIPATION_ANIMATION_MS = Object.freeze({
  in: PRIMAL_REEL_ANTICIPATION_TRANSITION_MS,
  hide: PRIMAL_REEL_ANTICIPATION_TRANSITION_MS,
});

/**
 * 来自 1200x900 `main.json` 的原始转轴悬念根节点偏移。集成方通常将此视图安装在制作好的转轴叠层原点，
 * 并选择 Primal Rampage 的三卷轴游戏的第三个条目。
 */
export const PRIMAL_ANTICIPATION_REEL_X = Object.freeze([-202.25, 0, 244] as const);

/** 悬念根节点在未缩放的三行转轴合成中使用的原生缩放。 */
export const PRIMAL_ANTICIPATION_BASE_SCALE = 0.8;

/**
 * 悬念 Spine 原本位于转轴影片片段下方，并已继承桌面舞台适配。我们的 Pixi 视图作为同级节点安装，
 * 因此需要补上舞台适配和明确测量的根节点偏移。这些值让实时 ADD 轮廓与官方 Pass45 的 06-16 帧对齐，
 * 同时不更改制作好的动画及其 333ms 隐藏过程。
 */
export const PRIMAL_ANTICIPATION_RUNTIME_FIT = Object.freeze({
  scaleX: 0.855,
  scaleY: 0.8,
  x: -8,
  y: 12,
});

export interface PrimalAnticipationTransform {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

export interface PrimalReelPresentationTransform {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly bounds: Readonly<{
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }>;
}

/**
 * 将制作好的第三轴悬念根节点连接到实时机台。参考 x 偏移量使用悬念骨架的 0.8x 舞台空间，
 * y 原点位于转轴窗口中心线。
 */
export function primalAnticipationTransform(
  reelCompositionScale: number,
): PrimalAnticipationTransform {
  const compositionScale = Number.isFinite(reelCompositionScale) && reelCompositionScale > 0
    ? reelCompositionScale
    : 1;
  const scaleX = PRIMAL_ANTICIPATION_BASE_SCALE
    * PRIMAL_ANTICIPATION_RUNTIME_FIT.scaleX
    * compositionScale;
  const scaleY = PRIMAL_ANTICIPATION_BASE_SCALE
    * PRIMAL_ANTICIPATION_RUNTIME_FIT.scaleY
    * compositionScale;
  return {
    x: LOGICAL_WIDTH / 2
      + (PRIMAL_ANTICIPATION_REEL_X[2] * scaleX)
      + PRIMAL_ANTICIPATION_RUNTIME_FIT.x * compositionScale,
    y: REEL_STAGE_Y
      + REEL_AREA_HEIGHT * compositionScale / 2
      + PRIMAL_ANTICIPATION_RUNTIME_FIT.y * compositionScale,
    scaleX,
    scaleY,
  };
}

/**
 * 将悬念 Spine 附加到实时转轴窗口，而不是固定的 1280x720 制作舞台。转轴与悬念在游戏摄像机中是同级节点，
 * 因此卷轴的当前变换和稳定的本地呈现边界是此处所需的完整投影。这也遵循行调整大小几何形状，而不将效果与桌面常量耦合。
 */
export function primalAnticipationTransformFromReel(
  reel: PrimalReelPresentationTransform,
): PrimalAnticipationTransform {
  const x = Number.isFinite(reel.x) ? reel.x : 0;
  const y = Number.isFinite(reel.y) ? reel.y : 0;
  const scaleX = Number.isFinite(reel.scaleX) && reel.scaleX > 0 ? reel.scaleX : 1;
  const scaleY = Number.isFinite(reel.scaleY) && reel.scaleY > 0 ? reel.scaleY : 1;
  const boundsX = Number.isFinite(reel.bounds.x) ? reel.bounds.x : 0;
  const boundsY = Number.isFinite(reel.bounds.y) ? reel.bounds.y : 0;
  const width = Number.isFinite(reel.bounds.width) && reel.bounds.width > 0
    ? reel.bounds.width
    : 0;
  const height = Number.isFinite(reel.bounds.height) && reel.bounds.height > 0
    ? reel.bounds.height
    : 0;
  const authoredScaleX = PRIMAL_ANTICIPATION_BASE_SCALE
    * PRIMAL_ANTICIPATION_RUNTIME_FIT.scaleX
    * scaleX;
  const authoredScaleY = PRIMAL_ANTICIPATION_BASE_SCALE
    * PRIMAL_ANTICIPATION_RUNTIME_FIT.scaleY
    * scaleY;
  const centreX = x + (boundsX + width / 2) * scaleX;
  const centreY = y + (boundsY + height / 2) * scaleY;
  return {
    x: centreX
      + PRIMAL_ANTICIPATION_REEL_X[2] * authoredScaleX
      + PRIMAL_ANTICIPATION_RUNTIME_FIT.x * scaleX,
    y: centreY + PRIMAL_ANTICIPATION_RUNTIME_FIT.y * scaleY,
    scaleX: authoredScaleX,
    scaleY: authoredScaleY,
  };
}

export interface AnticipationViewOptions {
  /** 测试/主机时钟接口；默认为浏览器调度程序。 */
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface AnticipationPerspectiveDiagnostics
  extends ReelPerspectiveFilterDiagnostics {
  readonly attached: boolean;
  readonly enabled: boolean;
  readonly resolution: number;
  readonly effectiveDepth: number;
  readonly angle: readonly [number, number];
  readonly blendMode: number;
  readonly active: boolean;
  readonly visible: boolean;
  readonly hostPosition: readonly [number, number];
  readonly hostScale: readonly [number, number];
  readonly sourceRoot: Readonly<{
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
  }>;
  readonly filterArea: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }> | null;
  readonly masked: boolean;
}

/**
 * 预期发光帧位于不透明的 RGB 图集页面上：黑色是附加零值，不是可见背景。在序列附件交换后重新断言 Spine 插槽和实时 Pixi 可渲染。
 */
export function enforceAnticipationAdditiveSlots(view: Spine | null): number {
  if (!view) return 0;
  let enforced = 0;
  for (const slot of view.skeleton.slots) {
    const renderSlot = slot as typeof slot & {
      currentSprite?: { blendMode: number };
      currentMesh?: { blendMode: number };
    };
    const attachment = slot.getAttachment() as null | {
      region?: null | { name?: string };
    };
    // 资产图集通过区域路径编码叠加材质。此序列的二进制槽元数据为 NORMAL，
    // 因此仅检查 slot.data.blendMode 会将不透明的 RGB 页面公开为黑色矩形。
    const atlasBlend = attachment?.region?.name?.startsWith("add/")
      ? BLEND_MODES.ADD
      : slot.data.blendMode;
    slot.blendMode = atlasBlend;
    if (renderSlot.currentSprite) renderSlot.currentSprite.blendMode = atlasBlend;
    if (renderSlot.currentMesh) renderSlot.currentMesh.blendMode = atlasBlend;
    if (atlasBlend === BLEND_MODES.ADD) enforced += 1;
  }
  return enforced;
}

/**
 * 原生 Spine 第三卷预期。轨道 0 拥有不间断循环；轨道 1 拥有 `in` 和 `hide`，与捕获的控制器完全相同。
 */
export class AnticipationView extends Container {
  private readonly schedule: NonNullable<AnticipationViewOptions["schedule"]>;
  private readonly cancelSchedule: NonNullable<AnticipationViewOptions["cancelSchedule"]>;
  private authored: Spine | null = null;
  private readonly perspectiveFilter = new ReelPerspectiveFilter();
  private artworkPromise: Promise<void> | null = null;
  private hideHandle: ReturnType<typeof setTimeout> | null = null;
  private reelHost: Pick<ReelSetView, "getAnticipationHostProjection"> | null = null;
  private sourceRoot: Readonly<{ x: number; y: number; scaleX: number; scaleY: number }> =
    Object.freeze({ x: 0, y: 0, scaleX: 1, scaleY: 1 });
  private desiredActive = false;
  private disposed = false;

  constructor(options: AnticipationViewOptions = {}) {
    super();
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle));
    this.filters = [this.perspectiveFilter];
    this.perspectiveFilter.state.blendMode = BLEND_MODES.ADD;
    this.visible = false;
    this.interactive = false;
  }

  get active(): boolean {
    return this.desiredActive;
  }

  get artworkLoaded(): boolean {
    return this.authored !== null;
  }

  setPerspectiveCoordinateScale(coordinateScale: number): void {
    this.perspectiveFilter.setCoordinateScale(coordinateScale);
  }

  /** 绑定真实的ReelSet主机；不存在独立猜测的舞台配合。 */
  syncToReelHost(host: Pick<ReelSetView, "getAnticipationHostProjection">): void {
    this.reelHost = host;
    this.applyReelHostProjection(host.getAnticipationHostProjection());
  }

  /** 确定性浏览器证据的只读物理通行事实。 */
  getPerspectiveDiagnostics(): AnticipationPerspectiveDiagnostics {
    const angle = this.perspectiveFilter.uniforms.uAngle as ArrayLike<number>;
    return Object.freeze({
      ...this.perspectiveFilter.diagnostics(),
      attached: this.filters?.includes(this.perspectiveFilter) ?? false,
      enabled: this.perspectiveFilter.enabled,
      resolution: this.perspectiveFilter.resolution,
      effectiveDepth: Number(this.perspectiveFilter.uniforms.uDepth),
      angle: Object.freeze([Number(angle[0]), Number(angle[1])]) as readonly [number, number],
      blendMode: this.perspectiveFilter.state.blendMode,
      active: this.desiredActive,
      visible: this.visible,
      hostPosition: Object.freeze([this.position.x, this.position.y]) as readonly [number, number],
      hostScale: Object.freeze([this.scale.x, this.scale.y]) as readonly [number, number],
      sourceRoot: this.sourceRoot,
      filterArea: this.filterArea
        ? Object.freeze({
            x: this.filterArea.x,
            y: this.filterArea.y,
            width: this.filterArea.width,
            height: this.filterArea.height,
          })
        : null,
      masked: this.mask !== null,
    });
  }

  loadArtwork(signal?: AbortSignal): Promise<void> {
    if (this.artworkPromise) return this.artworkPromise;
    this.artworkPromise = loadPrimalSpineData("anticipation")
      .then((data) => {
        if (this.disposed || signal?.aborted) return;
        const view = createSpineView(data);
        if (this.disposed) {
          view.destroy({ children: true });
          return;
        }
        view.state.clearTracks();
        view.state.setAnimation(
          PRIMAL_ANTICIPATION_TRACK.transition,
          PRIMAL_ANTICIPATION_ANIMATION.hidden,
          false,
        );
        this.authored = view;
        this.addChild(view);
        this.applySourceRoot();
        enforceAnticipationAdditiveSlots(view);
        if (this.desiredActive) this.playStart();
      })
      .catch((error: unknown) => {
        this.artworkPromise = null;
        throw error;
      });
    return this.artworkPromise;
  }

  start(): void {
    if (this.disposed || this.desiredActive) return;
    this.desiredActive = true;
    if (this.reelHost) {
      this.applyReelHostProjection(this.reelHost.getAnticipationHostProjection());
    }
    this.clearHideSchedule();
    if (!this.reelHost) this.visible = true;
    this.playStart();
  }

  /**
   * 普通转轴撞击会播放原生的 333ms 隐藏动画。快速停止/取消的调用方传入 `true`，
   * 确保不会有悬念帧泄漏到下一轮。
   */
  stop(immediate = false): void {
    if (this.disposed) return;
    this.desiredActive = false;
    this.clearHideSchedule();
    if (immediate || !this.authored) {
      this.playHidden();
      return;
    }

    const hide = this.authored.state.setAnimation(
      PRIMAL_ANTICIPATION_TRACK.transition,
      PRIMAL_ANTICIPATION_ANIMATION.hide,
      false,
    );
    hide.mixDuration = 0;
    this.hideHandle = this.schedule(() => {
      this.hideHandle = null;
      if (!this.desiredActive && !this.disposed) this.playHidden();
    }, PRIMAL_ANTICIPATION_ANIMATION_MS.hide);
  }

  reset(): void {
    this.stop(true);
  }

  /** 在子 Spine 更新此帧后重新应用预设的混合。 */
  override updateTransform(): void {
    if (this.reelHost) {
      this.applyReelHostProjection(this.reelHost.getAnticipationHostProjection());
    }
    super.updateTransform();
    enforceAnticipationAdditiveSlots(this.authored);
  }

  override destroy(options?: IDestroyOptions | boolean): void {
    if (this.disposed) return;
    this.disposed = true;
    this.desiredActive = false;
    this.clearHideSchedule();
    this.authored = null;
    this.reelHost = null;
    this.filters = null;
    this.perspectiveFilter.destroy();
    super.destroy(options);
  }

  private playStart(): void {
    const view = this.authored;
    if (!view || !this.desiredActive || this.disposed) return;
    view.state.clearTracks();
    const loop = view.state.setAnimation(
      PRIMAL_ANTICIPATION_TRACK.loop,
      PRIMAL_ANTICIPATION_ANIMATION.loop,
      true,
    );
    loop.mixDuration = 0;
    const intro = view.state.setAnimation(
      PRIMAL_ANTICIPATION_TRACK.transition,
      PRIMAL_ANTICIPATION_ANIMATION.in,
      false,
    );
    intro.mixDuration = 0;
    view.update(0);
    enforceAnticipationAdditiveSlots(view);
  }

  private playHidden(): void {
    const view = this.authored;
    if (view) {
      view.state.clearTrack(PRIMAL_ANTICIPATION_TRACK.loop);
      const hidden = view.state.setAnimation(
        PRIMAL_ANTICIPATION_TRACK.transition,
        PRIMAL_ANTICIPATION_ANIMATION.hidden,
        false,
      );
      hidden.mixDuration = 0;
      view.update(0);
      enforceAnticipationAdditiveSlots(view);
    }
    this.visible = false;
  }

  private clearHideSchedule(): void {
    if (this.hideHandle === null) return;
    this.cancelSchedule(this.hideHandle);
    this.hideHandle = null;
  }

  private applyReelHostProjection(projection: Readonly<ReelAnticipationHostProjection>): void {
    const { host, source } = projection;
    this.position.set(host.x, host.y);
    this.scale.set(host.scaleX, host.scaleY);
    this.pivot.set(host.pivotX, host.pivotY);
    this.skew.set(host.skewX, host.skewY);
    this.rotation = host.rotation;
    this.alpha = host.alpha;
    this.renderable = host.renderable;
    // 不要仅仅因为 desiredActive 已经是 false 就折叠预设的 333ms 隐藏。隐藏柜可能会立即压制通行证；否则，过渡轨道仍然是其可见性所有者。
    if (!host.visible) this.visible = false;
    else if (this.desiredActive) this.visible = true;
    this.perspectiveFilter.setCoordinateScale(projection.perspectiveResolution);
    this.filterArea = new Rectangle(
      projection.filterArea.x,
      projection.filterArea.y,
      projection.filterArea.width,
      projection.filterArea.height,
    );
    this.sourceRoot = Object.freeze({
      x: source.centreX
        + PRIMAL_ANTICIPATION_REEL_X[2] * source.scaleX
        + source.motionX,
      y: source.centreY + source.motionY,
      scaleX: source.scaleX,
      scaleY: source.scaleY,
    });
    this.applySourceRoot();
  }

  private applySourceRoot(): void {
    const view = this.authored;
    if (!view) return;
    view.position.set(this.sourceRoot.x, this.sourceRoot.y);
    view.scale.set(this.sourceRoot.scaleX, this.sourceRoot.scaleY);
  }
}
