import { Vector2 } from "@pixi-spine/base";
import {
  Container,
  Point,
  Text,
  TextStyle,
} from "pixi.js";
import type {
  FeatureState,
  FreeSpinAwardedEvent,
  FreeSpinCapReachedEvent,
  MoneyMinor,
} from "../app/state/types";
import { createSpineView, type Spine } from "./spine/SpineAdapter";
import { loadPrimalSpineSet } from "./spine/PrimalSpineAssets";
import {
  resolveResponsiveMinBound,
  type MobileHandMode,
  type MobileLayoutProfile,
  type ResponsiveLayoutSnapshot,
  type ResponsiveMinBound,
  type ResponsiveNodeTransform,
} from "./ResponsiveLayout";

export const FREE_SPIN_HUD_ANIMATION_MS = Object.freeze({
  counter: Object.freeze({
    show: 833.333,
    glow: 2_666.7,
    sweep: 600,
    win: 766.7,
    hide: 333.3,
  }),
  retrigger: Object.freeze({
    show: 733.3,
    hold: 4_166.667,
    hide: 733.333,
  }),
});

export const FREE_SPIN_HUD_REDUCED_MOTION_MS = Object.freeze({
  counterHide: 40,
  retrigger: Object.freeze({
    show: 40,
    hold: 40,
    hide: 40,
  }),
});

export const FREE_SPIN_HUD_TRACK = Object.freeze({
  base: 0,
  glow: 1,
  sweep: 2,
});

export const FREE_SPIN_HUD_ANIMATION = Object.freeze({
  counter: Object.freeze({
    hidden: "hidden",
    stop: "stop",
    show: "show",
    glow: "Glow_loop",
    sweep: "sweep_Loop",
    win: "win_vfx",
    hide: "hide",
  }),
  retrigger: Object.freeze({
    hidden: "hidden",
    show: "show",
    hide: "hide",
  }),
});

export const FREE_SPIN_HUD_TEXT_SLOTS = Object.freeze({
  label: Object.freeze({
    name: "fsCounterFreespin",
    width: 228.77,
    height: 36.63,
  }),
  counter: Object.freeze({
    name: "fsCounterValue",
    width: 227.66,
    height: 56.11,
  }),
  retrigger: Object.freeze({
    name: "retriggerText",
    width: 935.55,
    height: 315.65,
  }),
});

/** 来自捕获的语言环境的精确 en_GB `IDS_MAX_RS_REACHED` 副本。 */
export const FREE_SPIN_CAP_COPY = "Maximum number of FREE SPINS reached!";

/**
 * 捕获的 1200x900 桌面节点通过游戏的 0.8 映射到渲染器的 1280x720 设计图面。骨架及其文本骨骼拥有所有内部定位；
 * 这些只是 main.json/layout_desktop.json 的两个根节点变换。
 */
export const FREE_SPIN_HUD_DESKTOP_LAYOUT = Object.freeze({
  counter: Object.freeze({ x: 260, y: 124, scale: 0.8 }),
  retrigger: Object.freeze({ x: 640, y: 280, scale: 0.8 }),
});

interface FreeSpinHudMobileNodeLayout {
  readonly minBound: ResponsiveMinBound;
  readonly horizontalAlign: number;
  readonly verticalAlign: number;
}

type FreeSpinHudMobileLayout = Readonly<Record<
  "counter" | "retrigger",
  FreeSpinHudMobileNodeLayout
>>;

function mobileHudNode(
  left: number,
  top: number,
  width: number,
  height: number,
  horizontalAlign = 0.5,
  verticalAlign = 0.5,
): FreeSpinHudMobileNodeLayout {
  return Object.freeze({
    minBound: Object.freeze({ left, top, width, height }),
    horizontalAlign,
    verticalAlign,
  });
}

/** 从原版 mobile config 提取的 Free Spins HUD 根节点投影。 */
export const FREE_SPIN_HUD_MOBILE_LAYOUTS: Readonly<
  Record<MobileHandMode, Readonly<Record<MobileLayoutProfile, FreeSpinHudMobileLayout>>>
> = Object.freeze({
  right: Object.freeze({
    pt: Object.freeze({
      counter: mobileHudNode(-130, -1_220, 800, 1_600, 0.5, 0.9),
      retrigger: mobileHudNode(-600, -350, 1_200, 900),
    }),
    iPad_pt: Object.freeze({
      counter: mobileHudNode(-130, -830, 800, 1_100, 0.5, 0.9),
      retrigger: mobileHudNode(-600, -350, 1_200, 900),
    }),
    ls: Object.freeze({
      counter: mobileHudNode(-200, -110, 1_250, 900),
      retrigger: mobileHudNode(-600, -350, 1_200, 900),
    }),
  }),
  left: Object.freeze({
    pt: Object.freeze({
      counter: mobileHudNode(-650, -1_220, 800, 1_600, 0.5, 0.9),
      retrigger: mobileHudNode(-600, -350, 1_200, 900),
    }),
    iPad_pt: Object.freeze({
      counter: mobileHudNode(-670, -830, 800, 1_100, 0.5, 0.9),
      retrigger: mobileHudNode(-600, -350, 1_200, 900),
    }),
    ls: Object.freeze({
      counter: mobileHudNode(-1_050, -110, 1_250, 900),
      retrigger: mobileHudNode(-600, -350, 1_200, 900),
    }),
  }),
});

export interface FreeSpinHudResponsiveLayout {
  readonly counter: ResponsiveNodeTransform;
  readonly retrigger: ResponsiveNodeTransform;
}

/**
 * 将 HUD 投影到当前连续 gameplay 设计域。参考档位只选择原版节点规则，
 * 不选择或锁定物理视口尺寸。
 */
export function freeSpinHudResponsiveLayout(
  snapshot: ResponsiveLayoutSnapshot,
): FreeSpinHudResponsiveLayout {
  if (snapshot.channel === "desktop") {
    return FREE_SPIN_HUD_DESKTOP_LAYOUT;
  }
  const profile = snapshot.mobileProfile;
  if (!profile) return FREE_SPIN_HUD_DESKTOP_LAYOUT;
  const layout = FREE_SPIN_HUD_MOBILE_LAYOUTS[snapshot.handMode][profile];
  return Object.freeze({
    counter: resolveResponsiveMinBound(
      snapshot.gameplayRegion,
      layout.counter.minBound,
      layout.counter.horizontalAlign,
      layout.counter.verticalAlign,
    ),
    retrigger: resolveResponsiveMinBound(
      snapshot.gameplayRegion,
      layout.retrigger.minBound,
      layout.retrigger.horizontalAlign,
      layout.retrigger.verticalAlign,
    ),
  });
}

export type FreeSpinHudFeatureState = Pick<
  FeatureState,
  "mode" | "freeSpinsRemaining" | "freeSpinsPlayed" | "freeSpinsWinMinor"
>;

export interface FreeSpinHudProjection {
  readonly active: boolean;
  readonly remaining: number;
  readonly played: number;
  readonly totalAwarded: number;
  /** 原始 `%d / %t` 计数器显示的下一个/当前序数。 */
  readonly currentSpin: number;
  /** 服务器投影运行功能win；从未以这种观点积累。 */
  readonly cumulativeWinMinor: MoneyMinor;
}

/**
 * 仅项目服务器拥有的 Free Spins 字段。该值不涉及卷轴结果、奖励金额或本地中奖计算。
 */
export function projectFreeSpinHud(state: FreeSpinHudFeatureState): FreeSpinHudProjection {
  const remaining = authoritativeCount(state.freeSpinsRemaining, "freeSpinsRemaining");
  const played = authoritativeCount(state.freeSpinsPlayed ?? 0, "freeSpinsPlayed");
  const totalAwarded = remaining + played;
  if (!Number.isSafeInteger(totalAwarded)) {
    throw new Error("Authoritative Free Spins total exceeds the safe integer range");
  }
  const cumulativeWinMinor = authoritativeMoney(state.freeSpinsWinMinor ?? "0");
  return Object.freeze({
    active: state.mode !== "BASE",
    remaining,
    played,
    totalAwarded,
    currentSpin: remaining > 0 ? Math.min(totalAwarded, played + 1) : played,
    cumulativeWinMinor,
  });
}

export function formatFreeSpinCounter(projection: FreeSpinHudProjection): string {
  return `${projection.currentSpin} / ${projection.totalAwarded}`;
}

export interface FreeSpinHudViewOptions {
  readonly label?: string;
  readonly formatCounter?: (projection: FreeSpinHudProjection) => string;
  readonly formatRetrigger?: (
    event: Readonly<FreeSpinCapReachedEvent>,
    projection: FreeSpinHudProjection,
  ) => string;
  /** 接收准确的服务器预测，包括以较小单位表示的运行中奖。 */
  readonly onProjection?: (projection: FreeSpinHudProjection) => void;
  /** 仅可注入，以便主机可以将这些预设的等待绑定到自己的时钟。 */
  readonly wait?: (durationMs: number) => Promise<void>;
  /** 可注入媒体首选项用于通过压缩等待来保持顺序。 */
  readonly prefersReducedMotion?: () => boolean;
  /** 将官方 CAPLIMIT CONTINUE_SPIN 门投射到主机控件上。 */
  readonly onCapInteraction?: (phase: "input-ready" | "continue") => void;
  /** 可选的只读关闭结果；从不控制预设的门。 */
  readonly onCapClose?: (reason: FreeSpinCapCloseReason) => void;
  /** 可选测试场景屏障仅在真正的 CAP 输入门打开后才进入。 */
  readonly onCapInputReadyCheckpoint?: () => void | Promise<void>;
}

/** 有界 CAPLIMIT 保持关闭后发出的只读原因。 */
export type FreeSpinCapCloseReason = "continue" | "timeout" | "cancelled";

type CounterPresentation = "hidden" | "shown";

interface ActiveCapContinue {
  state: "waiting" | "continued" | "timed-out" | "cancelled";
  closeNotified: boolean;
  resolve(): void;
  resolveCheckpointCancellation?: () => void;
}

const EMPTY_PROJECTION: FreeSpinHudProjection = Object.freeze({
  active: false,
  remaining: 0,
  played: 0,
  totalAwarded: 0,
  currentSpin: 0,
  cumulativeWinMinor: "0",
});

/**
 * 本机 Free Spins 计数器和重新触发覆盖。
 *
 * 提供的 Spine 骨架拥有钢制计数器、变暗器、发光、扫描和所有过渡。 Pixi 文本实例仅附加到替换原始运行时的本地化字段的预设边界框槽。
 */
export class FreeSpinHudView extends Container {
  private readonly counterHost = new Container();
  private readonly retriggerHost = new Container();
  private readonly labelText: string;
  private readonly counterFormatter: NonNullable<FreeSpinHudViewOptions["formatCounter"]>;
  private readonly retriggerFormatter: NonNullable<FreeSpinHudViewOptions["formatRetrigger"]>;
  private readonly onProjection: FreeSpinHudViewOptions["onProjection"];
  private readonly wait: NonNullable<FreeSpinHudViewOptions["wait"]>;
  private readonly prefersReducedMotion: NonNullable<FreeSpinHudViewOptions["prefersReducedMotion"]>;
  private readonly onCapInteraction: FreeSpinHudViewOptions["onCapInteraction"];
  private readonly onCapClose: FreeSpinHudViewOptions["onCapClose"];
  private readonly onCapInputReadyCheckpoint:
    FreeSpinHudViewOptions["onCapInputReadyCheckpoint"];
  private readonly labelPoint = new Vector2();
  private readonly counterPoint = new Vector2();
  private readonly retriggerPoint = new Vector2();

  private counterView: Spine | null = null;
  private retriggerView: Spine | null = null;
  private counterLabel: Text | null = null;
  private counterValue: Text | null = null;
  private retriggerValue: Text | null = null;
  private loadPromise: Promise<void> | null = null;
  private desiredCounterPresentation: CounterPresentation = "hidden";
  private projectionValue: FreeSpinHudProjection = EMPTY_PROJECTION;
  private counterOperation = 0;
  private retriggerOperation = 0;
  private capRetriggerShown = false;
  private activeCapContinue: ActiveCapContinue | null = null;
  private disposed = false;

  constructor(options: FreeSpinHudViewOptions = {}) {
    super();
    this.labelText = options.label ?? "FREE SPINS:";
    this.counterFormatter = options.formatCounter ?? formatFreeSpinCounter;
    this.retriggerFormatter = options.formatRetrigger
      ?? (() => FREE_SPIN_CAP_COPY);
    this.onProjection = options.onProjection;
    this.wait = options.wait ?? waitFor;
    this.prefersReducedMotion = options.prefersReducedMotion ?? (() => (
      globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    ));
    this.onCapInteraction = options.onCapInteraction;
    this.onCapClose = options.onCapClose;
    this.onCapInputReadyCheckpoint = options.onCapInputReadyCheckpoint;

    const counterLayout = FREE_SPIN_HUD_DESKTOP_LAYOUT.counter;
    this.counterHost.position.set(counterLayout.x, counterLayout.y);
    this.counterHost.scale.set(counterLayout.scale);
    const retriggerLayout = FREE_SPIN_HUD_DESKTOP_LAYOUT.retrigger;
    this.retriggerHost.position.set(retriggerLayout.x, retriggerLayout.y);
    this.retriggerHost.scale.set(retriggerLayout.scale);
    this.counterHost.visible = false;
    this.retriggerHost.visible = false;
    this.addChild(this.counterHost, this.retriggerHost);
    this.visible = false;
    this.interactive = false;
  }

  get projection(): FreeSpinHudProjection {
    return this.projectionValue;
  }

  get artworkLoaded(): boolean {
    return this.counterView !== null && this.retriggerView !== null;
  }

  /** 布局提交只改变根节点矩阵，不重播动画，也不触碰权威计数。 */
  setResponsiveLayout(snapshot: ResponsiveLayoutSnapshot): void {
    const layout = freeSpinHudResponsiveLayout(snapshot);
    this.counterHost.position.set(layout.counter.x, layout.counter.y);
    this.counterHost.scale.set(layout.counter.scale);
    this.retriggerHost.position.set(layout.retrigger.x, layout.retrigger.y);
    this.retriggerHost.scale.set(layout.retrigger.scale);
  }

  loadArtwork(signal?: AbortSignal): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = loadPrimalSpineSet(["freeSpinCounter", "freeSpinRetrigger"] as const)
      .then((data) => {
        if (this.disposed || signal?.aborted) return;
        const counter = createSpineView(data.freeSpinCounter);
        const retrigger = createSpineView(data.freeSpinRetrigger);
        prepareAuthoredView(counter);
        prepareAuthoredView(retrigger);

        const label = new Text(this.labelText, counterTextStyle(25));
        const value = new Text(this.counterFormatter(this.projectionValue), counterTextStyle(35));
        const retriggerText = new Text("", retriggerTextStyle());
        label.anchor.set(0.5);
        value.anchor.set(0.5);
        retriggerText.anchor.set(0.5);

        this.counterView = counter;
        this.retriggerView = retrigger;
        this.counterLabel = label;
        this.counterValue = value;
        this.retriggerValue = retriggerText;
        this.counterHost.addChild(counter, label, value);
        this.retriggerHost.addChild(retrigger, retriggerText);

        this.playRetriggerHidden();
        if (this.desiredCounterPresentation === "shown" && this.projectionValue.active) {
          this.playCounterRestored();
        } else {
          this.playCounterHidden();
        }
        this.syncTextSlots();
      })
      .catch((error: unknown) => {
        this.loadPromise = null;
        throw error;
      });
    return this.loadPromise;
  }

  /** 恢复重新连接快照而不重播显示/扫描/重新触发。 */
  restoreFeatureState(state: FreeSpinHudFeatureState): void {
    const projection = this.applyAuthoritativeState(state);
    this.counterOperation += 1;
    this.retriggerOperation += 1;
    this.cancelCapContinue();
    this.desiredCounterPresentation = projection.active ? "shown" : "hidden";
    if (!projection.active) this.capRetriggerShown = false;
    this.retriggerHost.visible = false;
    this.playRetriggerHidden();
    if (projection.active) {
      this.counterHost.visible = true;
      this.visible = true;
      this.playCounterRestored();
    } else {
      this.counterHost.visible = false;
      this.playCounterHidden();
      this.syncRootVisibility();
    }
    this.syncTextSlots();
  }

  /** 仅更新值；所有金额和计数均由服务器预设。 */
  updateFeatureState(state: FreeSpinHudFeatureState): FreeSpinHudProjection {
    return this.applyAuthoritativeState(state);
  }

  async show(state: FreeSpinHudFeatureState): Promise<void> {
    const projection = this.applyAuthoritativeState(state);
    const operation = ++this.counterOperation;
    this.desiredCounterPresentation = projection.active ? "shown" : "hidden";
    this.capRetriggerShown = false;
    this.cancelCapContinue();
    if (!projection.active) {
      this.counterHost.visible = false;
      this.playCounterHidden();
      this.syncRootVisibility();
      return;
    }

    await this.loadArtwork();
    if (operation !== this.counterOperation || this.desiredCounterPresentation !== "shown") return;
    this.counterHost.visible = true;
    this.visible = true;
    const view = this.counterView;
    if (!view) return;
    view.state.clearTracks();
    view.state.setAnimation(FREE_SPIN_HUD_TRACK.base, FREE_SPIN_HUD_ANIMATION.counter.show, false);
    this.syncTextSlots();
  }

  async hide(): Promise<void> {
    const operation = ++this.counterOperation;
    this.desiredCounterPresentation = "hidden";
    this.retriggerOperation += 1;
    this.cancelCapContinue();
    this.retriggerHost.visible = false;
    this.playRetriggerHidden();
    const view = this.counterView;
    if (!view || !this.counterHost.visible) {
      this.counterHost.visible = false;
      this.playCounterHidden();
      this.syncRootVisibility();
      return;
    }

    view.state.setAnimation(FREE_SPIN_HUD_TRACK.base, FREE_SPIN_HUD_ANIMATION.counter.hide, false);
    view.state.clearTrack(FREE_SPIN_HUD_TRACK.glow);
    view.state.clearTrack(FREE_SPIN_HUD_TRACK.sweep);
    await this.wait(this.prefersReducedMotion()
      ? FREE_SPIN_HUD_REDUCED_MOTION_MS.counterHide
      : 400);
    if (operation !== this.counterOperation) return;
    this.counterHost.visible = false;
    this.playCounterHidden();
    this.syncRootVisibility();
  }

  /**
   * 应用权威的授予后状态并仅进行装饰性扫描。事件计数永远不会添加到先前的客户端预测中。
   */
  applyFreeSpinAwardBatch(
    events: readonly Readonly<FreeSpinAwardedEvent>[],
    state: FreeSpinHudFeatureState,
  ): FreeSpinHudProjection {
    if (events.length === 0) return this.projectionValue;
    events.forEach(validateFreeSpinAward);
    const previous = this.projectionValue;
    const projection = this.applyAuthoritativeState(state);
    this.playWin();
    if (previous.totalAwarded !== 0 && projection.totalAwarded > previous.totalAwarded) {
      this.playCounterSweep();
    }
    return projection;
  }

  /** CAPLIMIT-仅限覆盖：显示、可跳过的保留，然后预设隐藏。 */
  async retriggerCap(
    event: Readonly<FreeSpinCapReachedEvent>,
    state: FreeSpinHudFeatureState,
  ): Promise<void> {
    if (this.disposed) return;
    validateFreeSpinCap(event);
    if (this.capRetriggerShown) return;
    const incomingProjection = projectFreeSpinHud(state);
    // 最终结果已经是BASE，但是CAPLIMIT事件仍然属于保留的特征HUD。保留该显示投影，直到控制器完成重新触发 -> 摘要 -> HUD 隐藏。
    const projection = !incomingProjection.active && this.projectionValue.active
      ? this.projectionValue
      : this.applyProjection(incomingProjection);
    if (!projection.active) return;
    this.capRetriggerShown = true;
    this.desiredCounterPresentation = "shown";
    this.counterOperation += 1;
    const operation = ++this.retriggerOperation;
    const reducedMotion = this.prefersReducedMotion();
    const timings = reducedMotion
      ? FREE_SPIN_HUD_REDUCED_MOTION_MS.retrigger
      : FREE_SPIN_HUD_ANIMATION_MS.retrigger;
    await this.loadArtwork();
    if (operation !== this.retriggerOperation) return;

    if (!this.counterHost.visible) {
      this.counterHost.visible = true;
      this.playCounterRestored();
    }
    if (this.retriggerValue) this.retriggerValue.text = this.retriggerFormatter(event, projection);
    const view = this.retriggerView;
    if (!view) return;
    this.retriggerHost.visible = true;
    this.visible = true;
    view.state.clearTracks();
    view.state.setAnimation(0, FREE_SPIN_HUD_ANIMATION.retrigger.show, false);
    this.syncTextSlots();
    await this.wait(timings.show);
    if (operation !== this.retriggerOperation) return;

    let resolveContinue!: () => void;
    const continuePromise = new Promise<void>((resolve) => { resolveContinue = resolve; });
    const interaction: ActiveCapContinue = {
      state: "waiting",
      closeNotified: false,
      resolve: resolveContinue,
    };
    this.activeCapContinue = interaction;
    this.notifyCapInteraction("input-ready");
    const checkpoint = this.requestCapInputReadyCheckpoint();
    if (checkpoint) {
      let resolveCheckpointCancellation!: () => void;
      const checkpointCancellation = new Promise<void>((resolve) => {
        resolveCheckpointCancellation = resolve;
      });
      interaction.resolveCheckpointCancellation = resolveCheckpointCancellation;
      await Promise.race([checkpoint, checkpointCancellation]);
      interaction.resolveCheckpointCancellation = undefined;
    }
    if (this.disposed || operation !== this.retriggerOperation
      || interaction.state === "cancelled") return;
    await Promise.race([this.wait(timings.hold), continuePromise]);
    if (interaction.state === "waiting") interaction.state = "timed-out";
    if (this.activeCapContinue === interaction) this.activeCapContinue = null;
    if (operation !== this.retriggerOperation) return;
    this.notifyCapInteraction("continue");
    this.notifyCapClose(
      interaction,
      interaction.state === "continued" ? "continue" : "timeout",
    );

    view.state.setAnimation(0, FREE_SPIN_HUD_ANIMATION.retrigger.hide, false);
    await this.wait(timings.hide);
    if (operation !== this.retriggerOperation) return;
    this.retriggerHost.visible = false;
    this.playRetriggerHidden();
    this.syncRootVisibility();
  }

  /** 只接受一个 CONTINUE_SPIN 输入，并且仅在 CAPLIMIT 保持期间。 */
  requestCapContinue(): boolean {
    const interaction = this.activeCapContinue;
    if (!interaction || interaction.state !== "waiting") return false;
    interaction.state = "continued";
    interaction.resolve();
    return true;
  }

  override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    if (this.disposed) return;
    this.disposed = true;
    this.counterOperation += 1;
    this.retriggerOperation += 1;
    this.cancelCapContinue();
    super.destroy(options);
  }

  /** 计数器电气中奖爆发时间为 0.7667 秒。 */
  playWin(): void {
    const view = this.counterView;
    if (!view || !this.counterHost.visible) return;
    view.state.setAnimation(FREE_SPIN_HUD_TRACK.base, FREE_SPIN_HUD_ANIMATION.counter.win, false);
    view.state.addAnimation(FREE_SPIN_HUD_TRACK.base, FREE_SPIN_HUD_ANIMATION.counter.stop, false, 0);
  }

  /** 将捕获的 `main:fsCounter` 变换转换为效果图层。 */
  getCollectTarget(targetSpace: Container): Point {
    return targetSpace.toLocal(this.toGlobal(new Point(
      this.counterHost.position.x,
      this.counterHost.position.y,
    )));
  }

  /** 从主机渲染器中推进手动驱动的 Spine 实例。 */
  update(deltaMs: number): void {
    const deltaSeconds = Math.min(64, Math.max(0, deltaMs)) / 1_000;
    if (this.counterView && this.counterHost.visible) this.counterView.update(deltaSeconds);
    if (this.retriggerView && this.retriggerHost.visible) this.retriggerView.update(deltaSeconds);
    this.syncTextSlots();
  }

  private applyAuthoritativeState(state: FreeSpinHudFeatureState): FreeSpinHudProjection {
    return this.applyProjection(projectFreeSpinHud(state));
  }

  private applyProjection(projection: FreeSpinHudProjection): FreeSpinHudProjection {
    this.projectionValue = projection;
    if (this.counterLabel) this.counterLabel.text = this.labelText;
    if (this.counterValue) this.counterValue.text = this.counterFormatter(projection);
    this.onProjection?.(projection);
    this.syncTextSlots();
    return projection;
  }

  private playCounterSweep(): void {
    const view = this.counterView;
    if (!view || !this.counterHost.visible || !this.projectionValue.active) return;
    view.state.setAnimation(FREE_SPIN_HUD_TRACK.sweep, FREE_SPIN_HUD_ANIMATION.counter.sweep, false);
  }

  private playCounterRestored(): void {
    const view = this.counterView;
    if (!view) return;
    view.state.clearTracks();
    view.state.setAnimation(FREE_SPIN_HUD_TRACK.base, FREE_SPIN_HUD_ANIMATION.counter.stop, false);
    view.update(0);
  }

  private playCounterHidden(): void {
    const view = this.counterView;
    if (!view) return;
    view.state.clearTracks();
    view.state.setAnimation(FREE_SPIN_HUD_TRACK.base, FREE_SPIN_HUD_ANIMATION.counter.hidden, false);
    view.update(0);
  }

  private playRetriggerHidden(): void {
    const view = this.retriggerView;
    if (!view) return;
    view.state.clearTracks();
    view.state.setAnimation(0, FREE_SPIN_HUD_ANIMATION.retrigger.hidden, false);
    view.update(0);
  }

  private syncTextSlots(): void {
    if (this.counterView && this.counterLabel) {
      syncTextToSlot(
        this.counterView,
        this.counterLabel,
        FREE_SPIN_HUD_TEXT_SLOTS.label,
        this.labelPoint,
      );
    }
    if (this.counterView && this.counterValue) {
      syncTextToSlot(
        this.counterView,
        this.counterValue,
        FREE_SPIN_HUD_TEXT_SLOTS.counter,
        this.counterPoint,
      );
    }
    if (this.retriggerView && this.retriggerValue) {
      syncTextToSlot(
        this.retriggerView,
        this.retriggerValue,
        FREE_SPIN_HUD_TEXT_SLOTS.retrigger,
        this.retriggerPoint,
      );
    }
  }

  private syncRootVisibility(): void {
    this.visible = this.counterHost.visible || this.retriggerHost.visible;
  }

  private cancelCapContinue(): void {
    const interaction = this.activeCapContinue;
    if (!interaction || interaction.state !== "waiting") return;
    interaction.state = "cancelled";
    this.activeCapContinue = null;
    this.notifyCapClose(interaction, "cancelled");
    interaction.resolveCheckpointCancellation?.();
    interaction.resolve();
  }

  private notifyCapInteraction(phase: "input-ready" | "continue"): void {
    try {
      this.onCapInteraction?.(phase);
    } catch {
      // 主机控制投影是装饰性的，不能阻塞 HUD 时间线。
    }
  }

  private notifyCapClose(
    interaction: ActiveCapContinue,
    reason: FreeSpinCapCloseReason,
  ): void {
    if (interaction.closeNotified) return;
    interaction.closeNotified = true;
    try {
      this.onCapClose?.(reason);
    } catch {
      // 只读主机投影无法阻止预设的 HUD 时间线。
    }
  }

  private requestCapInputReadyCheckpoint(): Promise<void> | undefined {
    try {
      const pending = this.onCapInputReadyCheckpoint?.();
      if (!pending) return undefined;
      return Promise.resolve(pending).catch(() => undefined);
    } catch {
      return undefined;
    }
  }
}

function prepareAuthoredView(view: Spine): void {
  view.autoUpdate = false;
  view.skeleton.setSkinByName("default");
  view.skeleton.setSlotsToSetupPose();
}

function counterTextStyle(fontSize: number): TextStyle {
  return new TextStyle({
    align: "center",
    fill: 0xffffff,
    fontFamily: "Kanit, Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif",
    fontSize,
    fontWeight: "900",
    lineJoin: "round",
    stroke: 0x000000,
    strokeThickness: 8,
  });
}

function retriggerTextStyle(): TextStyle {
  return new TextStyle({
    align: "center",
    fill: 0xffffff,
    fontFamily: "Kanit, Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif",
    fontSize: 60,
    fontWeight: "900",
    lineJoin: "round",
    stroke: 0x000000,
    strokeThickness: 10,
    whiteSpace: "normal",
    wordWrap: true,
    wordWrapWidth: FREE_SPIN_HUD_TEXT_SLOTS.retrigger.width,
  });
}

function syncTextToSlot(
  view: Spine,
  text: Text,
  field: Readonly<{ name: string; width: number; height: number }>,
  point: Vector2,
): void {
  const slot = view.skeleton.findSlot(field.name);
  if (!slot) {
    text.visible = false;
    return;
  }
  const attachment = slot.getAttachment() as { vertices?: ArrayLike<number> } | null;
  const vertices = attachment?.vertices;
  if (vertices && vertices.length >= 2) {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let index = 0; index + 1 < vertices.length; index += 2) {
      minX = Math.min(minX, vertices[index] ?? minX);
      maxX = Math.max(maxX, vertices[index] ?? maxX);
      minY = Math.min(minY, vertices[index + 1] ?? minY);
      maxY = Math.max(maxY, vertices[index + 1] ?? maxY);
    }
    point.set((minX + maxX) / 2, (minY + maxY) / 2);
    slot.bone.localToWorld(point);
    text.position.set(point.x, point.y);
  } else {
    text.position.set(slot.bone.worldX, slot.bone.worldY);
  }

  text.scale.set(1);
  const widthScale = text.width > field.width ? field.width / text.width : 1;
  const heightScale = text.height > field.height ? field.height / text.height : 1;
  text.scale.set(Math.min(widthScale, heightScale));
  text.alpha = slot.color.a * view.skeleton.color.a;
  text.visible = attachment !== null && text.alpha > 0.001;
}

function authoritativeCount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Authoritative ${name} must be a non-negative safe integer`);
  }
  return value;
}

function authoritativeMoney(value: MoneyMinor): MoneyMinor {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error("Authoritative freeSpinsWinMinor must use non-negative integer minor units");
  }
  return value;
}

function validateFreeSpinAward(event: Readonly<FreeSpinAwardedEvent>): void {
  if (event.type !== "free_spin.awarded") throw new Error("Expected a free_spin.awarded event");
  if (!Number.isSafeInteger(event.count) || event.count <= 0) {
    throw new Error("Authoritative free_spin.awarded count must be a positive safe integer");
  }
}

function validateFreeSpinCap(event: Readonly<FreeSpinCapReachedEvent>): void {
  if (event.type !== "free_spin.cap_reached") {
    throw new Error("Expected a free_spin.cap_reached event");
  }
  // 捕获的CAPLIMIT命令是会话范围的；它的表示逻辑不使用卷/行地址。将可选协议元数据保留在可见性门之外，以便有效的上限通知不会被它抑制。
}

function waitFor(durationMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, durationMs));
}
