import { Vector2 } from "@pixi-spine/base";
import {
  BitmapText,
  Container,
  Rectangle,
  Text,
  TextStyle,
} from "pixi.js";
import { createSpineView, type Spine } from "./spine/SpineAdapter";
import { loadPrimalSpineData } from "./spine/PrimalSpineAssets";
import {
  loadPrimalBitmapFont,
  PRIMAL_BITMAP_FONT_BASE,
  PRIMAL_BITMAP_FONT_LINE_HEIGHT,
  PRIMAL_BITMAP_FONT_NAME,
  PRIMAL_BITMAP_FONT_SIZE,
} from "./PrimalBitmapFont";
import { BigWinCoinShower } from "./BigWinCoinShower";
import type {
  VisualTelemetryOperation,
  VisualTelemetryReporter,
} from "./VisualTelemetry";
import {
  resolveResponsiveMinBound,
  type ResponsiveRendererRegion,
} from "./ResponsiveLayout";
import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from "./theme";
import {
  DEFAULT_MINOR_UNIT_FORMATTER,
  type MinorUnitFormatter,
} from "../protocol/moneyFormatter";

export type BigWinTier = "bigwin" | "super" | "mega" | "ultra";

export type BigWinTransitionAnimation =
  | "bigwin_to_super"
  | "bigwin_to_mega"
  | "bigwin_to_ultra"
  | "super_to_mega"
  | "super_to_ultra"
  | "mega_to_ultra";

export const BIG_WIN_TIER_THRESHOLDS = Object.freeze([
  Object.freeze({ tier: "bigwin" as const, multiplier: 20n }),
  Object.freeze({ tier: "super" as const, multiplier: 100n }),
  Object.freeze({ tier: "mega" as const, multiplier: 250n }),
  Object.freeze({ tier: "ultra" as const, multiplier: 500n }),
]);

/** 在安装本机覆盖之前，主机的中奖流程拥有此延迟。 */
export const BIG_WIN_CONTROLLER_LEAD_IN_MS = 300;

/** 持续时间从提供的 Spine 4.1.24 BigWin 骨架中读取。 */
export const BIG_WIN_ANIMATION_MS = Object.freeze({
  show: 1_000,
  countStart: 500,
  transition: 1_333.333,
  idle: 3_333.333,
  hide: 933.333,
});

export const BIG_WIN_DEFAULT_HOLD_MS = 4_000;
export const BIG_WIN_FAST_HOLD_MS = 2_000;
/** 活动 BigWinPresentationController 时钟：250ms/x，上限为 30 秒。 */
export const BIG_WIN_MIN_COUNT_MS = 5_000;
export const BIG_WIN_MAX_COUNT_MS = 30_000;
export const BIG_WIN_COUNT_MS_PER_MULTIPLIER = 250n;

/** 捕获BigWin.skel中的文本字段；它是一个边界附件，而不是一个面板。 */
export const BIG_WIN_VALUE_SLOT = Object.freeze({
  name: "bigwinValue",
  bone: "win_value",
  width: 966.36,
  height: 128.95,
});

/** 从 `game_bundle.json` 捕获 `bigwinValue` 位图文本字段大小。 */
export const BIG_WIN_VALUE_FONT_SIZE = 32;

/** BMFont 以原始文本字段的预设大小进行基线校正。 */
export const BIG_WIN_VALUE_BASELINE_OFFSET = -(
  PRIMAL_BITMAP_FONT_BASE / 2
) * (BIG_WIN_VALUE_FONT_SIZE / PRIMAL_BITMAP_FONT_SIZE);

/** Pixi BMFont 原场独立Y配合前线盒。 */
export const BIG_WIN_VALUE_BITMAP_HEIGHT = PRIMAL_BITMAP_FONT_LINE_HEIGHT
  * (BIG_WIN_VALUE_FONT_SIZE / PRIMAL_BITMAP_FONT_SIZE);

/** 精确桌面包含 minBound [-600,-515,1200,1200] 的转换。 */
export const BIG_WIN_DESKTOP_LAYOUT = Object.freeze({
  x: 640,
  y: 309,
  scale: 0.6,
  minBound: Object.freeze([-600, -515, 1_200, 1_200] as const),
});

const BIG_WIN_DESKTOP_REGION = Object.freeze({
  left: 0,
  top: 0,
  width: LOGICAL_WIDTH,
  height: LOGICAL_HEIGHT,
});

/**
 * 将制作好的 Big Win 骨架拆分到独立的 Pixi 同级节点中。
 *
 * Pixi-Spine 的 Y 向上到屏幕空间的转换为这些骨骼提供了负行列式。区域附件需要这种反射，但将其复制到金额或硬币淋浴同级镜像其已经的屏幕空间输出。
 */
export function uprightBigWinSiblingTransform(
  matrix: Readonly<{ a: number; b: number; c: number; d: number }>,
): Readonly<{ rotation: number; scaleX: number; scaleY: number }> {
  return {
    rotation: Math.atan2(matrix.b, matrix.a),
    scaleX: Math.hypot(matrix.a, matrix.b),
    scaleY: Math.hypot(matrix.c, matrix.d),
  };
}

/** 将官方 Big Win 最小绑定投影到活动渲染器区域中。 */
export function bigWinResponsiveTransform(region: ResponsiveRendererRegion) {
  const [left, top, width, height] = BIG_WIN_DESKTOP_LAYOUT.minBound;
  return resolveResponsiveMinBound(region, { left, top, width, height });
}

export const BIG_WIN_ANIMATION = Object.freeze({
  hidden: "hidden",
  show: "bigwin_show",
  idle: (tier: BigWinTier) => `${tier}_idle` as const,
  hide: (tier: BigWinTier) => `${tier}_hide` as const,
});

export interface BigWinUpgradePlan {
  readonly fromTier: BigWinTier;
  readonly toTier: BigWinTier;
  readonly thresholdMultiplier: bigint;
  /** 相对于计数开始，而不是控制器拥有的导入。 */
  readonly atCountMs: number;
  /** 相对于原生`bigwin_show`。 */
  readonly atPresentationMs: number;
  readonly animation: BigWinTransitionAnimation;
}

interface BigWinMilestoneBase {
  /** 相对于原生`bigwin_show`；不包括控制器引入线。 */
  readonly atMs: number;
  readonly amountMinor: bigint;
}

export type BigWinMilestone =
  | (BigWinMilestoneBase & {
    readonly type: "show";
    readonly tier: "bigwin";
  })
  | (BigWinMilestoneBase & {
    readonly type: "count-start";
    readonly tier: "bigwin";
  })
  | (BigWinMilestoneBase & {
    readonly type: "level-up";
    readonly fromTier: BigWinTier;
    readonly toTier: BigWinTier;
    readonly thresholdMultiplier: bigint;
    readonly animation: BigWinTransitionAnimation;
  })
  | (BigWinMilestoneBase & {
    readonly type: "count-end";
    readonly tier: BigWinTier;
  })
  | (BigWinMilestoneBase & {
    readonly type: "hide-start";
    readonly tier: BigWinTier;
    readonly animation: `${BigWinTier}_hide`;
  })
  | (BigWinMilestoneBase & {
    readonly type: "complete";
    readonly tier: BigWinTier;
  });

export interface BigWinPlan {
  /** 服务器预设的投注额和奖励，始终保留为整数。 */
  readonly betMinor: bigint;
  readonly winMinor: bigint;
  readonly multiplierFloor: bigint;
  readonly finalTier: BigWinTier;
  /** 记录集成控制器；不包含在此视图的时钟中。 */
  readonly controllerLeadInMs: typeof BIG_WIN_CONTROLLER_LEAD_IN_MS;
  readonly countStartAtMs: number;
  readonly countMs: number;
  readonly countEndAtMs: number;
  readonly holdMs: number;
  readonly fastHoldMs: typeof BIG_WIN_FAST_HOLD_MS;
  readonly hideStartAtMs: number;
  readonly hideMs: number;
  readonly completeAtMs: number;
  readonly upgrades: readonly BigWinUpgradePlan[];
  readonly milestones: readonly BigWinMilestone[];
}

export interface BigWinPlanOptions {
  /** 默认为捕获的自然最终层保留 (4000ms)。 */
  readonly holdMs?: number;
}

/**
 * 根据权威整数制定仅视觉计划。返回低于 20 倍 Big Win 阈值的 null，并且从不将货币转换为 Number。
 */
export function planBigWin(
  winMinor: bigint,
  betMinor: bigint,
  options: BigWinPlanOptions = {},
): BigWinPlan | null {
  if (winMinor < 0n) throw new Error("Big Win amount must be non-negative integer minor units");
  if (betMinor <= 0n) throw new Error("Big Win bet must be positive integer minor units");
  const holdMs = options.holdMs ?? BIG_WIN_DEFAULT_HOLD_MS;
  if (!Number.isFinite(holdMs) || holdMs < 0) {
    throw new Error("Big Win holdMs must be a finite non-negative duration");
  }

  const finalTier = bigWinTierFor(winMinor, betMinor);
  if (!finalTier) return null;

  const uncappedCountMs = winMinor * BIG_WIN_COUNT_MS_PER_MULTIPLIER / betMinor;
  const countMs = uncappedCountMs <= BigInt(BIG_WIN_MIN_COUNT_MS)
    ? BIG_WIN_MIN_COUNT_MS
    : uncappedCountMs >= BigInt(BIG_WIN_MAX_COUNT_MS)
      ? BIG_WIN_MAX_COUNT_MS
      : Number(uncappedCountMs);
  const countStartAtMs = BIG_WIN_ANIMATION_MS.countStart;
  const countEndAtMs = countStartAtMs + countMs;

  let previousTier: BigWinTier = "bigwin";
  const upgrades: BigWinUpgradePlan[] = [];
  for (const threshold of BIG_WIN_TIER_THRESHOLDS.slice(1)) {
    if (winMinor < threshold.multiplier * betMinor) break;
    const thresholdAmount = threshold.multiplier * betMinor;
    const atCountMs = Number(ceilDiv(BigInt(countMs) * thresholdAmount, winMinor));
    const upgrade: BigWinUpgradePlan = Object.freeze({
      fromTier: previousTier,
      toTier: threshold.tier,
      thresholdMultiplier: threshold.multiplier,
      atCountMs,
      atPresentationMs: countStartAtMs + atCountMs,
      animation: bigWinTransitionAnimation(previousTier, threshold.tier),
    });
    upgrades.push(upgrade);
    previousTier = threshold.tier;
  }

  const hideStartAtMs = countEndAtMs + holdMs;
  const completeAtMs = hideStartAtMs + BIG_WIN_ANIMATION_MS.hide;
  const milestones: BigWinMilestone[] = [
    Object.freeze({ type: "show", atMs: 0, amountMinor: 0n, tier: "bigwin" }),
    Object.freeze({
      type: "count-start",
      atMs: countStartAtMs,
      amountMinor: 0n,
      tier: "bigwin",
    }),
    ...upgrades.map((upgrade) => Object.freeze({
      type: "level-up" as const,
      atMs: upgrade.atPresentationMs,
      amountMinor: upgrade.thresholdMultiplier * betMinor,
      fromTier: upgrade.fromTier,
      toTier: upgrade.toTier,
      thresholdMultiplier: upgrade.thresholdMultiplier,
      animation: upgrade.animation,
    })),
    Object.freeze({
      type: "count-end",
      atMs: countEndAtMs,
      amountMinor: winMinor,
      tier: finalTier,
    }),
    Object.freeze({
      type: "hide-start",
      atMs: hideStartAtMs,
      amountMinor: winMinor,
      tier: finalTier,
      animation: BIG_WIN_ANIMATION.hide(finalTier),
    }),
    Object.freeze({
      type: "complete",
      atMs: completeAtMs,
      amountMinor: winMinor,
      tier: finalTier,
    }),
  ];

  // 阈值可以与计数结束一致。稳定的插入顺序使升级回调保持在计数结束之前，与原始 setValue 流程相匹配。
  milestones.sort((left, right) => left.atMs - right.atMs);

  return Object.freeze({
    betMinor,
    winMinor,
    multiplierFloor: winMinor / betMinor,
    finalTier,
    controllerLeadInMs: BIG_WIN_CONTROLLER_LEAD_IN_MS,
    countStartAtMs,
    countMs,
    countEndAtMs,
    holdMs,
    fastHoldMs: BIG_WIN_FAST_HOLD_MS,
    hideStartAtMs,
    hideMs: BIG_WIN_ANIMATION_MS.hide,
    completeAtMs,
    upgrades: Object.freeze(upgrades),
    milestones: Object.freeze(milestones),
  });
}

export function bigWinTierFor(winMinor: bigint, betMinor: bigint): BigWinTier | null {
  if (winMinor < 0n) throw new Error("Big Win amount must be non-negative integer minor units");
  if (betMinor <= 0n) throw new Error("Big Win bet must be positive integer minor units");
  for (let index = BIG_WIN_TIER_THRESHOLDS.length - 1; index >= 0; index -= 1) {
    const threshold = BIG_WIN_TIER_THRESHOLDS[index];
    if (threshold && winMinor >= threshold.multiplier * betMinor) return threshold.tier;
  }
  return null;
}

/** 支持每个预设的向上过渡，包括直接跳过的级别。 */
export function bigWinTransitionAnimation(
  fromTier: BigWinTier,
  toTier: BigWinTier,
): BigWinTransitionAnimation {
  if (tierIndex(toTier) <= tierIndex(fromTier)) {
    throw new Error(`Big Win transition must move upward: ${fromTier} -> ${toTier}`);
  }
  return `${fromTier}_to_${toTier}` as BigWinTransitionAnimation;
}

/** 化妆品专柜插值；确切的服务器奖励是在计数结束时强制执行的。 */
export function bigWinAmountAt(plan: BigWinPlan, presentationElapsedMs: number): bigint {
  if (!Number.isFinite(presentationElapsedMs) || presentationElapsedMs <= plan.countStartAtMs) return 0n;
  if (presentationElapsedMs >= plan.countEndAtMs || plan.countMs === 0) return plan.winMinor;
  const elapsedCountMs = Math.max(
    0,
    Math.min(plan.countMs, Math.floor(presentationElapsedMs - plan.countStartAtMs)),
  );
  return plan.winMinor * BigInt(elapsedCountMs) / BigInt(plan.countMs);
}

export type BigWinPresentationResult = "complete" | "cancelled";

/** 一个接受的 CONTINUE 选择控制器的快速查看路径。 */
export type BigWinInteractionResult = "quick-view";

export interface BigWinViewOptions {
  /** 仅纯显示格式；货币/面额政策属于主办方。 */
  readonly formatAmount?: (amountMinor: bigint) => string;
  readonly onMilestone?: (
    milestone: BigWinMilestone,
    plan: BigWinPlan,
  ) => unknown;
  readonly visualTelemetry?: VisualTelemetryReporter;
}

/**
 * BMFont 页面和 Big Win 币有意共享一个 PNG。首先注册字体，以便在硬币加载器重新使用捕获的页面之前完全安装其拥有的页面纹理。
 */
export async function loadBigWinSharedAtlas(
  loadBitmapFont: () => Promise<boolean>,
  loadCoinAtlas: () => Promise<void>,
): Promise<boolean> {
  let bitmapFontInstalled = false;
  try {
    bitmapFontInstalled = await loadBitmapFont();
  } catch {
    // 文本回退路径仍然有效，但硬币淋浴仍应加载。
  }
  await loadCoinAtlas();
  return bitmapFontInstalled;
}

interface ActiveBigWinPresentation {
  readonly plan: BigWinPlan;
  readonly resolve: (result: BigWinPresentationResult) => void;
  elapsedMs: number;
  nextMilestone: number;
  tier: BigWinTier;
  countStarted: boolean;
  countEnded: boolean;
  hideStarted: boolean;
  checkpointPending: boolean;
  quickView: {
    readonly hideAtMs: number;
    readonly completeAtMs: number;
  } | null;
}

/**
 * 本机 BigWin.skel 覆盖。
 *
 * 该视图拥有捕获的 1280x720 桌面根转换；主机将其添加​​到逻辑阶段并从其代码中调用更新。它只提供一个提供的计划：它既不评估中奖，也不发挥作用。音频可以订阅语义里程碑。
 */
export class BigWinView extends Container {
  private readonly amountPoint = new Vector2();
  private readonly coinShower = new BigWinCoinShower();
  private formatter: NonNullable<BigWinViewOptions["formatAmount"]>;
  private milestoneListener: BigWinViewOptions["onMilestone"];
  private spine: Spine | null = null;
  private amountText: Text | BitmapText | null = null;
  private amountFitScaleX = 1;
  private amountFitScaleY = 1;
  private loadPromise: Promise<void> | null = null;
  private active: ActiveBigWinPresentation | null = null;
  private checkpointWait: {
    readonly active: ActiveBigWinPresentation;
    readonly promise: Promise<void>;
  } | null = null;
  private requestId = 0;
  private displayedAmountMinor = 0n;
  private readonly visualTelemetry: VisualTelemetryReporter | null;
  private visualOperation: VisualTelemetryOperation | null = null;

  constructor(options: BigWinViewOptions = {}) {
    super();
    // 从构建开始就拥有淋浴间，而不仅仅是在艺术品加载后。它的 150 个精灵池是跨帧构建的，因此在该工作期间被破坏的所有者必须在提交之前处理分离的尝试。
    this.addChild(this.coinShower);
    this.setResponsiveLayout(BIG_WIN_DESKTOP_REGION);
    this.formatter = options.formatAmount
      ?? ((amount) => DEFAULT_MINOR_UNIT_FORMATTER.format(amount.toString(), false));
    this.milestoneListener = options.onMilestone;
    this.visualTelemetry = options.visualTelemetry ?? null;
    this.visible = false;
    this.interactive = false;
    this.buttonMode = false;
    this.on("pointertap", () => this.requestAdvance());
  }

  setMoneyFormatter(formatter: MinorUnitFormatter): void {
    this.formatter = (amount) => formatter.format(amount.toString(), false);
    this.setDisplayedAmount(this.displayedAmountMinor);
  }

  /** 在物理移动设备调整大小后保持此场景级叠加居中。 */
  setResponsiveLayout(region: ResponsiveRendererRegion): void {
    const transform = bigWinResponsiveTransform(region);
    this.position.set(transform.x, transform.y);
    this.scale.set(transform.scale);
    const inverseScale = transform.scale > 0 ? 1 / transform.scale : 0;
    this.hitArea = new Rectangle(
      (region.left - transform.x) * inverseScale,
      (region.top - transform.y) * inverseScale,
      region.width * inverseScale,
      region.height * inverseScale,
    );
  }

  get artworkLoaded(): boolean {
    return this.spine !== null;
  }

  get isPresenting(): boolean {
    return this.active !== null;
  }

  get displayedAmount(): bigint {
    return this.displayedAmountMinor;
  }

  get presentationElapsedMs(): number {
    return this.active?.elapsedMs ?? 0;
  }

  setMilestoneListener(listener?: BigWinViewOptions["onMilestone"]): void {
    this.milestoneListener = listener;
  }

  loadArtwork(
    signal?: AbortSignal,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    if (this.spine) {
      onProgress?.(1);
      return Promise.resolve();
    }
    if (this.loadPromise) {
      return this.loadPromise.then(() => onProgress?.(1));
    }
    let spineProgress = 0;
    let sharedProgress = 0;
    let published = 0;
    const publish = (): void => {
      if (this.destroyed || signal?.aborted) return;
      const next = Math.max(published, spineProgress * 0.45 + sharedProgress * 0.55);
      if (next <= published && published !== 0) return;
      published = next;
      onProgress?.(next);
    };
    publish();
    const attempt = Promise.all([
      loadPrimalSpineData("bigWin").then((data) => {
        spineProgress = 1;
        publish();
        return data;
      }),
      loadBigWinSharedAtlas(
        async () => {
          const loaded = await loadPrimalBitmapFont();
          sharedProgress = Math.max(sharedProgress, 0.2);
          publish();
          return loaded;
        },
        () => this.coinShower.load(signal, {
          onProgress: (fraction) => {
            sharedProgress = Math.max(sharedProgress, 0.2 + fraction * 0.8);
            publish();
          },
        }),
      ).then((loaded) => {
        sharedProgress = 1;
        publish();
        return loaded;
      }),
    ]).then(([data, hasBitmapFont]) => {
      if (this.destroyed || signal?.aborted) return;
      const spine = createSpineView(data);
      spine.autoUpdate = false;
      spine.skeleton.setSkinByName("default");
      spine.skeleton.setSlotsToSetupPose();

      const amount = hasBitmapFont
        ? new BitmapText("", {
            align: "center",
            fontName: PRIMAL_BITMAP_FONT_NAME,
            fontSize: BIG_WIN_VALUE_FONT_SIZE,
          })
        : new Text("", bigWinAmountStyle());
      amount.anchor.set(0.5, amount instanceof BitmapText ? 0 : 0.5);
      amount.visible = false;
      this.spine = spine;
      this.amountText = amount;
      // 文本跟随骨架中最终制作好的边界槽位。该组件不绘制合成底板，也不替换美术资源。
      this.addChild(spine, this.coinShower, amount);
      this.playHidden();
      this.setDisplayedAmount(0n);
      onProgress?.(1);
      this.syncAmountToAuthoredSlot();
      this.syncCoinShowerToAuthoredBone();
      if (!hasBitmapFont) {
        this.visualTelemetry?.failedToStart({
          id: "win.big",
          requirement: "conditional",
          mode: "authored",
          sourceEvent: "launch.preload",
        }, {
          stage: "load",
          code: "asset-load-failed",
          fallback: "text",
        });
      }
    }).catch((error: unknown) => {
      this.loadPromise = null;
      throw error;
    });
    this.loadPromise = attempt;
    return attempt;
  }

  /** 仅在真实层隐藏剪辑之后或使用 `cancelled` 才能解决。 */
  async present(plan: BigWinPlan): Promise<BigWinPresentationResult> {
    const requestId = ++this.requestId;
    this.finishActive("cancelled");
    try {
      await this.loadArtwork();
    } catch (error) {
      this.visualTelemetry?.failedToStart({
        id: "win.big",
        requirement: "conditional",
        mode: "authored",
        sourceEvent: "win.big",
      }, {
        stage: "load",
        code: "asset-load-failed",
        fallback: "text",
      });
      throw error;
    }
    if (requestId !== this.requestId || this.destroyed) return "cancelled";

    this.visualOperation = this.visualTelemetry?.start({
      id: "win.big",
      requirement: "conditional",
      mode: "authored",
      sourceEvent: "win.big",
    }) ?? null;
    return new Promise<BigWinPresentationResult>((resolve, reject) => {
      try {
        this.active = {
          plan,
          resolve,
          elapsedMs: 0,
          nextMilestone: 0,
          tier: "bigwin",
          countStarted: false,
          countEnded: false,
          hideStarted: false,
          checkpointPending: false,
          quickView: null,
        };
        this.visible = true;
        this.interactive = false;
        this.buttonMode = false;
        this.setDisplayedAmount(0n);
        this.drainMilestonesAt(0);
        this.syncAmountToAuthoredSlot();
      } catch (error) {
        if (this.visualOperation) {
          this.visualTelemetry?.fail(this.visualOperation, {
            stage: "runtime",
            code: "playback-failed",
            fallback: "text",
          });
          this.visualOperation = null;
        }
        reject(error);
      }
    });
  }

  cancel(): void {
    this.requestId += 1;
    this.finishActive("cancelled");
  }

  /** 一旦官方 500ms 输入门打开，就结束剩余计数。 */
  requestAdvance(): BigWinInteractionResult | null {
    const active = this.active;
    if (!active || active.hideStarted || active.quickView || active.checkpointPending) return null;
    // 在评估栅栏前，先完成当前时钟下所有已到期的制作内容。正常逐帧更新时这一步已经完成，
    // 但当事件与 500ms 边界落在同一帧时，它能保证输入行为确定。
    this.advanceTo(active.elapsedMs);
    if (this.active !== active || !active.countStarted || active.hideStarted
      || active.quickView || active.checkpointPending) {
      return null;
    }

    this.interactive = false;
    this.buttonMode = false;
    const { plan } = active;
    this.setDisplayedAmount(plan.winMinor);

    // BigWinCounter.setValue可以直接跳转到目标层。仅发出一个转换，而不是重播每个跳过的阈值。
    if (active.tier !== plan.finalTier) {
      const destination = BIG_WIN_TIER_THRESHOLDS.find(({ tier }) => tier === plan.finalTier);
      if (!destination) throw new Error(`Missing Big Win tier: ${plan.finalTier}`);
      this.applyMilestone(active, {
        type: "level-up",
        atMs: active.elapsedMs,
        amountMinor: plan.winMinor,
        fromTier: active.tier,
        toTier: plan.finalTier,
        thresholdMultiplier: destination.multiplier,
        animation: bigWinTransitionAnimation(active.tier, plan.finalTier),
      });
    }
    const pendingLevelUp = this.checkpointWait?.active === active
      ? this.checkpointWait.promise
      : null;
    if (pendingLevelUp) {
      // 快速查看点击可以跳层，但捕获的升级姿势必须在计数结束发出之前保持独立可观察。
      void pendingLevelUp.then(() => this.commitQuickView(active));
    } else {
      this.commitQuickView(active);
    }
    return "quick-view";
  }

  override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    this.requestId += 1;
    this.finishActive("cancelled");
    // 即使调用者省略 `{ children: true }` 也保留所有权。 BigWinCoinShower.destroy 将进行中的切片加载标记为已取消；然后，
    // 该尝试会破坏其本地的、尚未提交的池。
    if (!this.coinShower.destroyed) {
      this.coinShower.destroy({ children: true });
    }
    super.destroy(options);
  }

  /** 推进语义时间线和手动驱动的 Spine 视图。 */
  update(deltaMs: number): void {
    const activeAtStart = this.active;
    const spine = this.spine;
    if (!activeAtStart || !spine || activeAtStart.checkpointPending
      || !Number.isFinite(deltaMs) || deltaMs <= 0) return;
    if (activeAtStart.quickView) {
      this.advanceQuickViewTo(activeAtStart, Math.min(
        activeAtStart.quickView.completeAtMs,
        activeAtStart.elapsedMs + deltaMs,
      ));
      return;
    }
    this.advanceTo(Math.min(activeAtStart.plan.completeAtMs, activeAtStart.elapsedMs + deltaMs));
  }

  /** 自然股票更新会按稳定的时间顺序耗尽每个到期的里程碑。 */
  private advanceTo(targetMs: number): void {
    const activeAtStart = this.active;
    const spine = this.spine;
    if (!activeAtStart || !spine || !Number.isFinite(targetMs)) return;
    const boundedTargetMs = Math.max(
      activeAtStart.elapsedMs,
      Math.min(activeAtStart.plan.completeAtMs, targetMs),
    );

    while (this.active === activeAtStart) {
      const milestone = activeAtStart.plan.milestones[activeAtStart.nextMilestone];
      if (!milestone || milestone.atMs > boundedTargetMs) break;
      this.advanceSpine(activeAtStart, milestone.atMs - activeAtStart.elapsedMs);
      activeAtStart.elapsedMs = milestone.atMs;
      this.setDisplayedAmount(bigWinAmountAt(activeAtStart.plan, milestone.atMs));
      this.applyMilestone(activeAtStart, milestone);
      activeAtStart.nextMilestone += 1;
      if (activeAtStart.checkpointPending) break;
    }

    if (this.active !== activeAtStart || activeAtStart.checkpointPending) return;
    this.advanceSpine(activeAtStart, boundedTargetMs - activeAtStart.elapsedMs);
    activeAtStart.elapsedMs = boundedTargetMs;
    this.setDisplayedAmount(bigWinAmountAt(activeAtStart.plan, boundedTargetMs));
    this.syncAmountToAuthoredSlot();
  }

  private advanceQuickViewTo(active: ActiveBigWinPresentation, targetMs: number): void {
    const quickView = active.quickView;
    if (!quickView || this.active !== active) return;
    const boundedTargetMs = Math.max(active.elapsedMs, Math.min(quickView.completeAtMs, targetMs));

    if (!active.hideStarted && quickView.hideAtMs <= boundedTargetMs) {
      this.advanceSpine(active, quickView.hideAtMs - active.elapsedMs);
      active.elapsedMs = quickView.hideAtMs;
      this.setDisplayedAmount(active.plan.winMinor);
      this.applyMilestone(active, {
        type: "hide-start",
        atMs: quickView.hideAtMs,
        amountMinor: active.plan.winMinor,
        tier: active.plan.finalTier,
        animation: BIG_WIN_ANIMATION.hide(active.plan.finalTier),
      });
    }

    if (this.active !== active) return;
    this.advanceSpine(active, boundedTargetMs - active.elapsedMs);
    active.elapsedMs = boundedTargetMs;
    this.setDisplayedAmount(active.plan.winMinor);
    if (boundedTargetMs >= quickView.completeAtMs) {
      this.applyMilestone(active, {
        type: "complete",
        atMs: quickView.completeAtMs,
        amountMinor: active.plan.winMinor,
        tier: active.plan.finalTier,
      });
      return;
    }
    this.syncAmountToAuthoredSlot();
  }

  private drainMilestonesAt(atMs: number): void {
    const active = this.active;
    if (!active) return;
    while (this.active === active) {
      const milestone = active.plan.milestones[active.nextMilestone];
      if (!milestone || milestone.atMs !== atMs) break;
      this.applyMilestone(active, milestone);
      active.nextMilestone += 1;
      if (active.checkpointPending) break;
    }
  }

  private applyMilestone(
    active: ActiveBigWinPresentation,
    milestone: BigWinMilestone,
  ): void {
    const spine = this.spine;
    if (!spine) return;
    switch (milestone.type) {
      case "show":
        spine.skeleton.setToSetupPose();
        spine.state.clearTracks();
        setRequiredAnimation(spine, BIG_WIN_ANIMATION.show, false);
        addRequiredAnimation(spine, BIG_WIN_ANIMATION.idle("bigwin"), true);
        break;
      case "count-start":
        active.countStarted = true;
        this.coinShower.setTier(0);
        if (!active.quickView) {
          this.interactive = true;
          this.buttonMode = true;
        }
        break;
      case "level-up":
        active.tier = milestone.toTier;
        setRequiredAnimation(spine, milestone.animation, false);
        addRequiredAnimation(spine, BIG_WIN_ANIMATION.idle(milestone.toTier), true);
        this.coinShower.setTier(tierIndex(milestone.toTier));
        break;
      case "hide-start":
        active.hideStarted = true;
        this.interactive = false;
        this.buttonMode = false;
        setRequiredAnimation(spine, milestone.animation, false);
        this.coinShower.stop();
        break;
      case "complete":
        this.setDisplayedAmount(active.plan.winMinor);
        this.observeMilestone(active, milestone);
        if (this.checkpointWait?.active === active) {
          const completeCheckpoint = this.checkpointWait.promise;
          void completeCheckpoint.then(() => {
            if (this.active === active) this.finishActive("complete");
          });
        } else {
          this.finishActive("complete");
        }
        return;
      case "count-end":
        active.countEnded = true;
        break;
    }
    spine.update(0);
    this.syncAmountToAuthoredSlot();
    this.syncCoinShowerToAuthoredBone();
    this.observeMilestone(active, milestone);
  }

  private observeMilestone(
    active: ActiveBigWinPresentation,
    milestone: BigWinMilestone,
  ): void {
    let pending: unknown;
    try {
      pending = this.milestoneListener?.(milestone, active.plan);
    } catch {
      return;
    }
    if (pending === null
      || (typeof pending !== "object" && typeof pending !== "function")
      || typeof (pending as { then?: unknown }).then !== "function") return;
    const promise: Promise<void> = Promise.resolve(pending).then(
      () => undefined,
      () => undefined,
    );
    const wait = { active, promise };
    active.checkpointPending = true;
    this.checkpointWait = wait;
    void promise.finally(() => {
      if (this.checkpointWait === wait) this.checkpointWait = null;
      if (this.active === active && this.checkpointWait?.active !== active) {
        active.checkpointPending = false;
      }
    });
  }

  private commitQuickView(active: ActiveBigWinPresentation): void {
    if (this.active !== active || active.quickView || active.hideStarted) return;
    const { plan } = active;
    if (!active.countEnded) {
      this.applyMilestone(active, {
        type: "count-end",
        atMs: active.elapsedMs,
        amountMinor: plan.winMinor,
        tier: plan.finalTier,
      });
    }

    // 抑制未消耗的自然里程碑。快速查看仅拥有 2 秒的保留、预设的层隐藏以及从此时开始的完成。
    active.nextMilestone = plan.milestones.length;
    active.quickView = {
      hideAtMs: active.elapsedMs + plan.fastHoldMs,
      completeAtMs: active.elapsedMs + plan.fastHoldMs + plan.hideMs,
    };
    this.syncAmountToAuthoredSlot();
  }

  private advanceSpine(active: ActiveBigWinPresentation, durationMs: number): void {
    if (durationMs <= 0 || this.active !== active || !this.spine) return;
    this.spine.update(durationMs / 1_000);
    this.coinShower.update(durationMs);
    this.syncAmountToAuthoredSlot();
    this.syncCoinShowerToAuthoredBone();
  }

  private finishActive(result: BigWinPresentationResult): void {
    const active = this.active;
    this.active = null;
    if (this.checkpointWait?.active === active) this.checkpointWait = null;
    this.visible = false;
    this.interactive = false;
    this.buttonMode = false;
    this.playHidden();
    if (this.visualOperation) {
      this.visualTelemetry?.complete(
        this.visualOperation,
        result === "cancelled" ? "cancelled" : "natural",
      );
      this.visualOperation = null;
    }
    active?.resolve(result);
  }

  private playHidden(): void {
    this.coinShower.killAll();
    const spine = this.spine;
    if (!spine) return;
    spine.state.clearTracks();
    setRequiredAnimation(spine, BIG_WIN_ANIMATION.hidden, false);
    spine.update(0);
    if (this.amountText) this.amountText.visible = false;
  }

  private syncCoinShowerToAuthoredBone(): void {
    const spine = this.spine;
    if (!spine) {
      this.coinShower.visible = false;
      return;
    }
    const bone = spine.skeleton.findBone("coinShowerLayer");
    if (!bone) {
      this.coinShower.visible = false;
      return;
    }
    const transform = uprightBigWinSiblingTransform(bone.matrix);
    this.coinShower.position.set(bone.worldX, bone.worldY);
    this.coinShower.rotation = transform.rotation;
    this.coinShower.scale.set(transform.scaleX, transform.scaleY);
    this.coinShower.visible = this.visible;
  }

  private setDisplayedAmount(amountMinor: bigint): void {
    this.displayedAmountMinor = amountMinor;
    const amount = this.amountText;
    if (!amount) return;
    const formatted = `${this.formatter(amountMinor)}  `;
    if (amount.text !== formatted) {
      amount.text = formatted;
      amount.scale.set(1);
      this.amountFitScaleX = Math.min(
        1,
        amount.width > 0 ? BIG_WIN_VALUE_SLOT.width / amount.width : 1,
      );
      this.amountFitScaleY = Math.min(
        1,
        amount instanceof BitmapText
          ? BIG_WIN_VALUE_SLOT.height / BIG_WIN_VALUE_BITMAP_HEIGHT
          : amount.height > 0 ? BIG_WIN_VALUE_SLOT.height / amount.height : 1,
      );
    }
  }

  private syncAmountToAuthoredSlot(): void {
    const spine = this.spine;
    const amount = this.amountText;
    if (!spine || !amount) return;
    const slot = spine.skeleton.findSlot(BIG_WIN_VALUE_SLOT.name);
    if (!slot || slot.bone.data.name !== BIG_WIN_VALUE_SLOT.bone) {
      amount.visible = false;
      return;
    }

    const attachment = slot.getAttachment() as { vertices?: ArrayLike<number> } | null;
    const vertices = attachment?.vertices;
    if (amount instanceof BitmapText) {
      // 原始 TextField 用假人替换附件，并将 BMFont 悬挂在 win_value 骨骼原点处。它的 Y 位置是字体基础校正，而不是附件矩形的视觉中心。
      this.amountPoint.set(0, BIG_WIN_VALUE_BASELINE_OFFSET);
      slot.bone.localToWorld(this.amountPoint);
      amount.position.copyFrom(this.amountPoint);
    } else if (vertices && vertices.length >= 2) {
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
      this.amountPoint.set(
        (minX + maxX) / 2,
        (minY + maxY) / 2,
      );
      slot.bone.localToWorld(this.amountPoint);
      amount.position.set(this.amountPoint.x, this.amountPoint.y);
    } else {
      amount.position.set(slot.bone.worldX, slot.bone.worldY);
    }

    // 遵循预设的值骨骼的实时位置、旋转和比例。骨架的根变换仍然归集成容器所有。
    const bone = slot.bone;
    const transform = uprightBigWinSiblingTransform(bone.matrix);
    amount.rotation = transform.rotation;
    amount.scale.set(
      this.amountFitScaleX * transform.scaleX,
      this.amountFitScaleY * transform.scaleY,
    );
    amount.alpha = slot.color.a * spine.skeleton.color.a;
    amount.visible = this.visible && attachment !== null && amount.alpha > 0.001;
  }
}

function setRequiredAnimation(spine: Spine, animation: string, loop: boolean): void {
  if (!spine.state.hasAnimation(animation)) {
    throw new Error(`BigWin.skel is missing required animation: ${animation}`);
  }
  spine.state.setAnimation(0, animation, loop);
}

function addRequiredAnimation(spine: Spine, animation: string, loop: boolean): void {
  if (!spine.state.hasAnimation(animation)) {
    throw new Error(`BigWin.skel is missing required animation: ${animation}`);
  }
  spine.state.addAnimation(0, animation, loop, 0);
}

function tierIndex(tier: BigWinTier): number {
  return BIG_WIN_TIER_THRESHOLDS.findIndex((threshold) => threshold.tier === tier);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function bigWinAmountStyle(): TextStyle {
  return new TextStyle({
    align: "center",
    fill: 0xffffff,
    fontFamily: "PrimalRampage, Kanit, Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif",
    fontSize: BIG_WIN_VALUE_FONT_SIZE,
    fontWeight: "900",
    lineJoin: "round",
  });
}
