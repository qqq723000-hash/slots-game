import { Vector2 } from "@pixi-spine/base";
import {
  Container,
  Point,
  TEXT_GRADIENT,
  Text,
  TextStyle,
} from "pixi.js";
import type { CellAddress, MoneyMinor, SymbolId, Win } from "../app/state/types";
import {
  DEFAULT_MINOR_UNIT_FORMATTER,
  type MinorUnitFormatter,
} from "../protocol/moneyFormatter";
import type { ReelSetView } from "../reels/ReelSetView";
import { readableSpineTextTransform } from "./PrimalPanelText";
import { createSpineView, type Spine, type SpineData } from "./spine/SpineAdapter";
import { loadPrimalSpineSet } from "./spine/PrimalSpineAssets";
import type {
  VisualTelemetryCompletionOutcome,
  VisualTelemetryOperation,
  VisualTelemetryReporter,
} from "./VisualTelemetry";

const NORMAL_DURATION_MS = 1_150;
const REDUCED_DURATION_MS = 320;
const WINBOX_SOURCE_WIDTH = 240;
const WINBOX_SOURCE_HEIGHT = 160;
const REDUCED_MOTION_TIME_SCALE = 100;

/** 分派的 MasterWinView 构建了许多可重复使用的 WinBox 框架。 */
export const PRIMAL_WINBOX_POOL_SIZE = 24;

let nextResidentInstanceId = 1;

/** 出厂的 WinBox/WinLabel 剪辑在正常的 Spine 时钟上运行。 */
export const NORMAL_WIN_AUTHORED_EFFECT_TIME_SCALE = 1;

export function normalWinAuthoredEffectTimeScale(reducedMotion: boolean): number {
  return reducedMotion ? REDUCED_MOTION_TIME_SCALE : NORMAL_WIN_AUTHORED_EFFECT_TIME_SCALE;
}

/** 活动 `.471` GameWinLogicController 记录计时。 */
export const PRIMAL_NORMAL_WIN_RECORD_HOLD_MS = Object.freeze({
  multiPlain: 1_500,
  multiPlainFast: 750,
  multiMultiplier: 4_000,
  multiMultiplierFast: 3_000,
  repeatOrPostBigWinPlain: 2_000,
} as const);

/** 从提供的 `winlabel.skel` 解码的精确剪辑长度和边界。 */
export const WIN_LABEL_AUTHORED_TIMELINE_MS = Object.freeze({
  showDuration: 333.333343,
  mergeStartAt: 333.333343,
  mergeStartDuration: 1_333.300114,
  mergeEndAt: 1_666.633457,
  mergeEndDuration: 500,
  complete: 2_166.633457,
  hideDuration: 333.333343,
} as const);

export const WIN_LABEL_TEXT_SLOTS = Object.freeze([
  "winLabelValue",
  "winLabelInfo",
  "winLabelMultiplier",
] as const);

export type WinLabelTextSlot = typeof WIN_LABEL_TEXT_SLOTS[number];

export interface WinLabelTextFacts {
  readonly winLabelValue: string;
  readonly winLabelInfo: string | null;
  readonly winLabelMultiplier: string | null;
}

export type WinLabelAnimationName =
  | "hidden"
  | "show"
  | "merge_start"
  | "merge_end"
  | "hide"
  | "hide_merged";

export interface WinLabelAnimationEntry {
  readonly animationEnd: number;
  mixDuration: number;
}

export interface WinLabelAnimationState {
  hasAnimation(name: string): boolean;
  setAnimation(trackIndex: number, animationName: string, loop: boolean): WinLabelAnimationEntry;
}

interface WinLabelTextAttachmentSource {
  getAttachment(): unknown | null;
  readonly data: { readonly index: number };
}

interface WinLabelTextSkeletonSource {
  getAttachment(slotIndex: number, attachmentName: string): unknown | null;
}

/** 即使设置槽为空，文本边界也会存在于默认皮肤中。 */
export function resolveWinLabelTextAttachment<T>(
  skeleton: WinLabelTextSkeletonSource,
  slot: WinLabelTextAttachmentSource,
): T | null {
  return (slot.getAttachment()
    ?? skeleton.getAttachment(slot.data.index, "bounds")) as T | null;
}

/**
 * 精确的 winlabel.skel 基础轨道控制器。乘数文本仅来自活动的服务器解析记录； Spine 合并方法仍然是明确的。
 */
export class WinLabelAnimationController {
  private multiplierMerged = false;

  constructor(
    private readonly state: WinLabelAnimationState,
    private readonly trackIndex = 0,
  ) {}

  get isMultiplierMerged(): boolean {
    return this.multiplierMerged;
  }

  setHidden(): number {
    this.multiplierMerged = false;
    return this.play("hidden");
  }

  show(): number {
    this.multiplierMerged = false;
    return this.play("show");
  }

  startMerge(): number {
    this.multiplierMerged = true;
    return this.play("merge_start");
  }

  endMerge(): number {
    return this.play("merge_end");
  }

  hide(): number {
    const animation = this.multiplierMerged ? "hide_merged" : "hide";
    this.multiplierMerged = false;
    return this.play(animation);
  }

  private play(animation: WinLabelAnimationName): number {
    if (!this.state.hasAnimation(animation)) return 0;
    const entry = this.state.setAnimation(this.trackIndex, animation, false);
    // 官方 WinLabel 包装器会覆盖每个基本轨道命令的共享 0.15 秒 Spine 混音。 WinBox 故意保留共享默认值。
    entry.mixDuration = 0;
    return entry.animationEnd;
  }
}

interface ActiveAnimation {
  handle: number | null;
  finish(): void;
}

interface AuthoredWinAssets {
  readonly winBox: SpineData;
  readonly winLabel: SpineData;
}

interface WinTarget {
  readonly address: CellAddress;
  readonly center: Point;
  readonly width: number;
  readonly height: number;
}

interface AuthoredBox {
  readonly view: Spine;
  active: boolean;
  ownerGeneration: number;
}

interface AuthoredLabelTextField {
  readonly name: WinLabelTextSlot;
  readonly text: Text;
  readonly point: Vector2;
  hasAuthoritativeText: boolean;
}

interface AuthoredLabel {
  readonly group: Container;
  readonly view: Spine;
  readonly fields: readonly AuthoredLabelTextField[];
  readonly animations: WinLabelAnimationController;
}

interface ResidentWinScene {
  readonly scene: Container;
  readonly boxScene: Container;
  readonly boxLayer: Container;
  readonly labelLayer: Container;
  boxes: AuthoredBox[];
  label: AuthoredLabel | null;
  artworkInitializationAttempted: boolean;
  artworkPreparedForRecord: boolean;
  readonly labelInstanceId: number;
  readonly framePoolInstanceId: number;
  presentationCount: number;
  activeGeneration: number;
  activeBoxCount: number;
  pendingCleanupCount: number;
  viewReused: boolean;
  handoffDelayMs: number;
  staleHiddenCount: number;
}

interface ResidentHideTail {
  readonly generation: number;
  readonly animation: ActiveAnimation | null;
  readonly operation: VisualTelemetryOperation | null;
  readonly reducedMotion: boolean;
  visualFailed: boolean;
  readonly notify: (milestone: WinCelebrationMilestone) => void | Promise<void>;
  readonly dimmingGeneration: number;
  readonly symbolsRestoredAtHoldBoundary: boolean;
  cancelled: boolean;
  completed: boolean;
}

export interface WinRecordPlan {
  readonly id: string;
  readonly symbol: SymbolId;
  /** `-1` 是捕获的无路 BONUS 哨兵。 */
  readonly ways: number | undefined;
  readonly multiplier: number;
  /** 预设的乘数合并之前可见的金额。 */
  readonly baseAmountMinor: MoneyMinor;
  readonly amountMinor: MoneyMinor;
  /** 完整服务器记录的独特权威单元。 */
  readonly cells: readonly CellAddress[];
}

/** 仅用于预加载阶段构建常驻视图的内部构造信息。 */
const RESIDENT_PRELOAD_RECORD: Readonly<WinRecordPlan> = Object.freeze({
  id: "resident-preload",
  symbol: "ORBIT",
  ways: undefined,
  multiplier: 1,
  baseAmountMinor: "0",
  amountMinor: "0",
  cells: Object.freeze([]),
});

export type WinCelebrationMilestone =
  | "visible"
  | "show-complete"
  | "merge-start"
  | "merge-settled"
  | "hold-complete"
  | "hide-start"
  | "hidden";

/** 用于证明常驻对象所有权和零延迟重用的不可变诊断。 */
export interface WinCelebrationResidentFacts {
  readonly generation: number;
  readonly labelInstanceId: number;
  readonly framePoolInstanceId: number;
  readonly framePoolSize: number;
  readonly activeBoxCount: number;
  readonly activeOwnerCount: number;
  readonly pendingCleanupCount: number;
  readonly viewReused: boolean;
  readonly handoffDelayMs: number;
  readonly staleHiddenCount: number;
}

/** 只读观察缝；回调永远无法控制表现。 */
export type WinCelebrationMilestoneCallback = (
  milestone: WinCelebrationMilestone,
  record: Readonly<WinRecordPlan>,
  resident: Readonly<WinCelebrationResidentFacts>,
) => unknown;

function isVoidPromise(value: unknown): value is PromiseLike<void> {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof (value as { then?: unknown }).then === "function";
}

export interface WinCelebrationPlan {
  /** 直接从权威服务器中奖记录复制的独特单元。 */
  readonly cells: readonly CellAddress[];
  /** 每个服务器记录一个视觉记录； `pathAwards` 永远不会扩展此列表。 */
  readonly records: readonly WinRecordPlan[];
  readonly totalAmountMinor: MoneyMinor;
}

export interface WinRecordHoldContext {
  readonly recordCount: number;
  readonly counterDurationMs: number;
  readonly fastPlay?: boolean;
  readonly repeat?: boolean;
  readonly postBigWin?: boolean;
}

export interface WinCelebrationFrame {
  readonly labelAlpha: number;
}

export type WinLabelMergePhase = "base" | "merging" | "settled";
export type WinLabelTimelineAnimation = "show" | "merge_start" | "merge_end" | null;

export interface WinLabelMergeFrame {
  readonly phase: WinLabelMergePhase;
  readonly amountMinor: MoneyMinor;
  readonly animation: WinLabelTimelineAnimation;
  readonly complete: boolean;
}

/** 保持动态 WinLabel 字形可读，同时保留预设的倾斜/尺寸。 */
export function readableWinLabelTextTransform(
  matrix: Readonly<{ a: number; b: number; c: number; d: number }>,
  fitScale: number,
): Readonly<{ rotation: number; scaleX: number; scaleY: number }> {
  const transform = readableSpineTextTransform(matrix);
  const magnitude = Number.isFinite(fitScale) ? Math.abs(fitScale) : 0;
  return {
    rotation: transform.rotation,
    scaleX: magnitude * transform.scaleX,
    scaleY: magnitude * transform.scaleY,
  };
}

function hasMultiplierMerge(
  record: Pick<WinRecordPlan, "multiplier" | "baseAmountMinor" | "amountMinor">,
): boolean {
  return /^(0|[1-9]\d*)$/.test(record.baseAmountMinor)
    && /^(0|[1-9]\d*)$/.test(record.amountMinor)
    && record.multiplier > 1
    && BigInt(record.baseAmountMinor) !== BigInt(record.amountMinor);
}

/**
 * 捕获正常中奖标签计时。这两个值均由服务器提供；该函数仅选择表现时间，从不计算金钱。
 */
export function winLabelMergeFrame(
  record: Pick<WinRecordPlan, "multiplier" | "baseAmountMinor" | "amountMinor">,
  elapsedMs: number,
  reducedMotion = false,
): WinLabelMergeFrame {
  const speed = reducedMotion ? REDUCED_MOTION_TIME_SCALE : 1;
  const mergeStartAt = WIN_LABEL_AUTHORED_TIMELINE_MS.mergeStartAt / speed;
  const mergeEndAt = WIN_LABEL_AUTHORED_TIMELINE_MS.mergeEndAt / speed;
  const completeAt = WIN_LABEL_AUTHORED_TIMELINE_MS.complete / speed;
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const merges = hasMultiplierMerge(record);
  if (!merges) {
    return {
      phase: "settled",
      amountMinor: record.amountMinor,
      animation: elapsed < mergeStartAt ? "show" : null,
      complete: elapsed >= mergeStartAt,
    };
  }
  if (elapsed < mergeStartAt) {
    return {
      phase: "base",
      amountMinor: record.baseAmountMinor,
      animation: "show",
      complete: false,
    };
  }
  if (elapsed < mergeEndAt) {
    return {
      phase: "merging",
      amountMinor: record.baseAmountMinor,
      animation: "merge_start",
      complete: false,
    };
  }
  return {
    phase: "settled",
    amountMinor: record.amountMinor,
    animation: elapsed < completeAt ? "merge_end" : null,
    complete: elapsed >= completeAt,
  };
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function copyValidCells(cells: readonly CellAddress[]): CellAddress[] {
  const copied = new Map<string, CellAddress>();
  for (const cell of cells) {
    if (!Number.isSafeInteger(cell.reel) || !Number.isSafeInteger(cell.row)) continue;
    const key = `${cell.reel}:${cell.row}`;
    if (!copied.has(key)) copied.set(key, { reel: cell.reel, row: cell.row });
  }
  return [...copied.values()].sort((left, right) => left.reel - right.reel || left.row - right.row);
}

function sumMinor(values: readonly MoneyMinor[]): MoneyMinor {
  let total = 0n;
  for (const value of values) {
    if (/^(0|[1-9]\d*)$/.test(value)) total += BigInt(value);
  }
  return total.toString();
}

function recordMultiplier(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 1 ? value! : 1;
}

/** 镜像主动控制器的单 -> 乘数 -> 重播/BigWin 顺序。 */
export function primalWinRecordHoldDurationMs(
  record: Pick<Win, "multiplier">,
  context: WinRecordHoldContext,
): number {
  const recordCount = Number.isSafeInteger(context.recordCount)
    ? Math.max(0, context.recordCount)
    : 0;
  const counterDurationMs = Number.isFinite(context.counterDurationMs)
    ? Math.max(0, context.counterDurationMs)
    : 0;
  if (recordCount <= 1) return counterDurationMs;
  if (recordMultiplier(record.multiplier) > 1) {
    return context.fastPlay
      ? PRIMAL_NORMAL_WIN_RECORD_HOLD_MS.multiMultiplierFast
      : PRIMAL_NORMAL_WIN_RECORD_HOLD_MS.multiMultiplier;
  }
  if (context.repeat || context.postBigWin) {
    return PRIMAL_NORMAL_WIN_RECORD_HOLD_MS.repeatOrPostBigWinPlain;
  }
  return context.fastPlay
    ? PRIMAL_NORMAL_WIN_RECORD_HOLD_MS.multiPlainFast
    : PRIMAL_NORMAL_WIN_RECORD_HOLD_MS.multiPlain;
}

function baseAmountMinor(amountMinor: MoneyMinor, multiplier: number): MoneyMinor {
  if (!/^(0|[1-9]\d*)$/.test(amountMinor) || multiplier <= 1) return amountMinor;
  return (BigInt(amountMinor) / BigInt(multiplier)).toString();
}

/**
 * 将解码的中奖事实转换为视觉事实，无需检查网格、支付线、符号值或任何客户计算的结果。
 */
export function createWinCelebrationPlan(wins: readonly Win[]): WinCelebrationPlan {
  const cells = new Map<string, CellAddress>();
  const records: WinRecordPlan[] = [];
  for (const win of wins) {
    const aggregateCells = copyValidCells(win.cells);
    for (const cell of aggregateCells) {
      const key = `${cell.reel}:${cell.row}`;
      if (!cells.has(key)) cells.set(key, { ...cell });
    }
    if (aggregateCells.length === 0) continue;
    const multiplier = recordMultiplier(win.multiplier);
    records.push({
      id: win.id,
      symbol: win.symbol,
      ways: win.ways,
      multiplier,
      baseAmountMinor: baseAmountMinor(win.amountMinor, multiplier),
      amountMinor: win.amountMinor,
      cells: aggregateCells,
    });
  }
  return {
    cells: [...cells.values()],
    records,
    totalAmountMinor: sumMinor(wins.map(({ amountMinor }) => amountMinor)),
  };
}

export function winCelebrationDuration(
  reducedMotion: boolean,
  _record?: Pick<WinRecordPlan, "multiplier" | "baseAmountMinor" | "amountMinor">,
): number {
  // 这只是传统调用者的回退路径方案。活动控制器提供单记录聚合计数器 D 或审核的多记录 HOLD。乘法器绝不能延长任一所属时钟以适应其标签夹。
  return reducedMotion ? REDUCED_DURATION_MS : NORMAL_DURATION_MS;
}

/** Primal 使预设的 Spine 显示/合并/隐藏剪辑可见。 */
export function winCelebrationFrame(): WinCelebrationFrame {
  return { labelAlpha: 1 };
}

/** 原始 WinLabel 信用格式：带有两位小数的整数小单位。 */
export function winLabelValue(
  amountMinor: MoneyMinor,
  formatter: MinorUnitFormatter = DEFAULT_MINOR_UNIT_FORMATTER,
): string {
  if (!/^(0|[1-9]\d*)$/.test(amountMinor)) return formatter.format("0", false);
  return formatter.format(amountMinor, false);
}

/**
 * 从一份服务器解析的记录复制的文本事实。旧记录省略了 Ways 详细信息，因此隐藏了两个预设的元数据字段。
 */
export function authoritativeWinLabelText(
  amountMinor: MoneyMinor,
  ways?: number,
  multiplier?: number,
  formatter: MinorUnitFormatter = DEFAULT_MINOR_UNIT_FORMATTER,
): WinLabelTextFacts {
  const info = ways === -1
    ? "BONUS won!"
    : Number.isSafeInteger(ways) && (ways ?? 0) > 0
      ? `${ways} ${ways === 1 ? "WAY WON" : "WAYS WON"}`
      : null;
  const effectiveMultiplier = recordMultiplier(multiplier);
  return Object.freeze({
    winLabelValue: winLabelValue(amountMinor, formatter),
    winLabelInfo: info,
    winLabelMultiplier: effectiveMultiplier > 1 ? ` x${effectiveMultiplier}` : null,
  });
}

/** GoldGradient + GoldStroke + GoldDropShadow 来自 config_desktop.json。 */
export function winLabelGoldTextStyle(): TextStyle {
  return new TextStyle({
    align: "center",
    dropShadow: true,
    dropShadowAlpha: 1,
    dropShadowAngle: 1.57,
    dropShadowBlur: 0,
    dropShadowColor: 0x503f1a,
    dropShadowDistance: 5,
    fill: [0xe5ad42, 0xe5ad42, 0xfff5df, 0x9e7631, 0xe0af46],
    fillGradientStops: [0, 0.13, 0.6, 0.64, 0.81],
    fillGradientType: TEXT_GRADIENT.LINEAR_VERTICAL,
    fontFamily: "'Primal Kanit', Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif",
    fontSize: 60,
    fontWeight: "700",
    lineJoin: "miter",
    stroke: 0x1c1406,
    strokeThickness: 6,
  });
}

/** winLabelInfoStyle 来自 config_desktop.json。 */
export function winLabelInfoTextStyle(): TextStyle {
  return new TextStyle({
    align: "center",
    dropShadow: true,
    dropShadowAlpha: 1,
    dropShadowAngle: 1.57,
    dropShadowBlur: 2,
    dropShadowColor: 0x392f18,
    dropShadowDistance: 6,
    fill: 0xffffff,
    fontFamily: "'Primal Kanit', Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif",
    fontSize: 30,
    fontWeight: "700",
    lineJoin: "miter",
    stroke: 0x221c0e,
    strokeThickness: 6,
  });
}

/**
 * 预设了无路径的正常中奖层。 `winbox.skel` 为每个独特的记录单元提供一个框架，`winlabel.skel` 为每个记录提供一个聚合板。
 * 没有为 Primal 创建支付线显示对象。
 */
export class WinCelebration {
  readonly view = new Container();
  readonly boxView = new Container();
  private readonly animations = new Set<ActiveAnimation>();
  private assets: AuthoredWinAssets | null = null;
  private loadPromise: Promise<void> | null = null;
  private destroyed = false;
  private presenting = false;
  private finishRequested = false;
  private checkpointPending = false;
  private checkpointCancel: (() => void) | null = null;
  private dimmingGeneration = 0;
  private presentationGeneration = 0;
  private lastFinalizedGeneration = 0;
  private resident: ResidentWinScene | null = null;
  private residentHideTail: ResidentHideTail | null = null;
  private moneyFormatter: MinorUnitFormatter = DEFAULT_MINOR_UNIT_FORMATTER;

  constructor(
    private readonly hostLayer: Container,
    private readonly reels: ReelSetView,
    private readonly visualTelemetry: VisualTelemetryReporter | null = null,
  ) {
    this.hostLayer.addChild(this.view);
    // 原始 winFrameOverlay 位于固定符号下方，而 WinLabel 保留在卷轴本地前景覆盖中。
    this.reels.mountWinFrameEffect?.(this.boxView);
  }

  get artworkLoaded(): boolean {
    return this.assets !== null;
  }

  setMoneyFormatter(formatter: MinorUnitFormatter): void {
    this.moneyFormatter = formatter;
  }

  loadArtwork(signal?: AbortSignal): Promise<void> {
    if (this.assets) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    const attempt = loadPrimalSpineSet(["winBox", "winLabel"] as const).then((assets) => {
      if (this.destroyed || signal?.aborted) return;
      this.assets = assets;
      try {
        // MasterWinView 从启动时就拥有一个标签及其完整的 24 帧池。 `loadArtwork()` 仅在这些 Spine 实例存在后才解析，
        // 因此第一个中奖仅执行重定向/重播工作。
        this.ensureResidentScene(
          RESIDENT_PRELOAD_RECORD,
          false,
          true,
          true,
        );
      } catch (error) {
        this.assets = null;
        this.discardResidentScene();
        throw error;
      }
    });
    this.loadPromise = attempt;
    void attempt.catch(() => {
      if (this.loadPromise === attempt) this.loadPromise = null;
    });
    return attempt;
  }

  async present(
    wins: readonly Win[],
    reducedMotion = false,
    recordHoldDurationMs?: number,
    onMilestone?: WinCelebrationMilestoneCallback,
    restoreSymbolsAtHoldBoundary = false,
    handoffToNextRecord = false,
  ): Promise<void> {
    if (this.destroyed || this.presenting) return;
    const plan = createWinCelebrationPlan(wins);
    if (plan.records.length === 0) return;
    this.presenting = true;
    this.finishRequested = false;
    try {
      for (const [index, record] of plan.records.entries()) {
        if (this.destroyed || this.finishRequested) return;
        await this.presentRecord(
          record,
          reducedMotion,
          recordHoldDurationMs,
          onMilestone,
          restoreSymbolsAtHoldBoundary,
          index < plan.records.length - 1 || handoffToNextRecord,
        );
      }
    } finally {
      this.presenting = false;
      this.finishRequested = false;
    }
  }

  /** 正常中奖 CONTINUE 门使用的仅表现快速停止。 */
  requestFinish(): boolean {
    // 官方控制器不会快进已经开始的预设退出。它的逻辑 WIN_DONE 接口与 WinLabel/WinBox 333ms 消失无关，因此请保留此常驻尾部。
    if (this.residentHideTail) {
      // 零延迟切换可能让前一条记录的尾段停留到微任务阶段，而外层循环正在决定是否显示后继记录。
      // 此处结束该逻辑循环，但不触碰制作好的退场流程。
      if (this.presenting) this.finishRequested = true;
      return true;
    }
    if (
      (!this.presenting && this.animations.size === 0)
      || this.finishRequested
    ) return false;
    this.finishRequested = true;
    if (!this.checkpointPending) {
      for (const animation of [...this.animations]) animation.finish();
    }
    return true;
  }

  private async presentRecord(
    record: WinRecordPlan,
    reducedMotion: boolean,
    recordHoldDurationMs?: number,
    onMilestone?: WinCelebrationMilestoneCallback,
    restoreSymbolsAtHoldBoundary = false,
    handoffToNextRecord = false,
  ): Promise<void> {
    // 该声明属于外部调度程序；即使直接生命周期测试提供 `false`，运行时重用仍保持接管安全。
    void handoffToNextRecord;
    let generation = 0;
    let dimmingGeneration = 0;
    let resident: ResidentWinScene | null = null;
    let residentPresentationCountBefore: number | null = null;
    let hideTailStarted = false;
    let visible = false;
    let symbolsRestoredAtHoldBoundary = false;
    let visualOperation: VisualTelemetryOperation | null = null;
    let visualFailed = false;
    const notify = (milestone: WinCelebrationMilestone): void | Promise<void> => {
      try {
        const pending = onMilestone?.(
          milestone,
          record,
          this.residentFacts(resident, generation),
        );
        return isVoidPromise(pending)
          ? Promise.resolve(pending).catch(() => undefined)
          : undefined;
      } catch {
        // 观察故意是非权威的，并且不能破坏比赛。
        return;
      }
    };
    try {
      let authoredLoadFailed = false;
      try {
        // 启动预加载通常会同时提供两种资源。当 Promise 已经兑现时，
        // 请勿在 START 处插入 Promise 轮次：Box、Label、调光和可见里程碑必须在同一调用堆栈中可观察到。
        if (!this.assets) await this.loadArtwork();
      } catch {
        authoredLoadFailed = true;
        this.visualTelemetry?.failedToStart({
          id: "win.normal-record",
          requirement: "conditional",
          mode: "authored",
          sourceEvent: "win.record",
        }, {
          stage: "load",
          code: "asset-load-failed",
          fallback: "procedural",
        });
      }
      if (this.destroyed || this.finishRequested) return;

      // 新的 SHOW 会立即接管两个常驻轨道。取消上一条记录的隐藏尾段是同步操作，
      // 不包含原生等待时间。
      resident = this.ensureResidentScene(record, reducedMotion, !authoredLoadFailed);
      this.cancelResidentHideTail("takeover");
      generation = ++this.presentationGeneration;
      dimmingGeneration = ++this.dimmingGeneration;
      residentPresentationCountBefore = resident.presentationCount;
      resident.viewReused = resident.presentationCount > 0;
      resident.presentationCount += 1;
      resident.activeGeneration = generation;
      resident.pendingCleanupCount = 0;
      // 这是权威的外部调度程序边界，而不是经过的挂壁时间。 Promise 轮次和 RAF 时间戳绝不能膨胀 H+0。
      resident.handoffDelayMs = 0;
      resident.scene.visible = true;
      resident.boxScene.visible = true;

      if (!authoredLoadFailed && this.assets) {
        visualOperation = this.visualTelemetry?.start({
          id: "win.normal-record",
          requirement: "conditional",
          mode: "authored",
          sourceEvent: "win.record",
        }) ?? null;
      }

      const boxTargetByCell = this.createTargets(record.cells, this.boxView);
      const labelTargetByCell = this.createTargets(record.cells, this.view);
      this.retargetAuthoredBoxes(
        resident.boxes,
        record.cells,
        boxTargetByCell,
        reducedMotion,
        generation,
      );
      resident.activeBoxCount = resident.boxes.reduce(
        (count, box) => count + (box.active ? 1 : 0),
        0,
      );
      if (
        resident.label
        && (resident.viewReused || !resident.artworkPreparedForRecord)
      ) {
        this.retargetAuthoredLabel(
          resident.label,
          record,
          labelTargetByCell,
          reducedMotion,
        );
        resident.artworkPreparedForRecord = true;
      }
      const boxes = resident.boxes;
      const label = resident.label;
      if (visualOperation && resident.activeBoxCount === 0 && !label) {
        this.visualTelemetry?.fail(visualOperation, {
          stage: "create",
          code: "empty-presentation",
          fallback: "procedural",
        });
        visualOperation = null;
      }
      // `setAnimation()` 立即更改预设状态，但这些手动更新 Spine 视图在下次更新之前不会应用新的轨迹姿势。
      // 在发布 `visible` 之前提交零时间 START 姿势，以便渲染器、符号、音频和计数器共享一帧。
      this.updateAuthored(boxes, label, 0);
      // GameMasterWinView 在符号衰落之前创建 WinBox 和 WinLabel。
      this.reels.dimNonWinningCells(record.cells);
      visible = true;
      const visibleCheckpoint = notify("visible");
      if (visibleCheckpoint) await this.holdMilestoneCheckpoint(visibleCheckpoint);
      if (this.destroyed || this.finishRequested) return;
      const multiplierMerge = hasMultiplierMerge(record);
      let showComplete = false;
      let mergeStarted = false;
      let mergeEndStarted = false;
      let mergeSettled = false;

      // 交付的中奖后控制器为单个空闲重复记录提供无限语义 HOLD。保护那个哨兵；其他无效值仍会回退到有界的表现持续时间。
      const holdDurationMs = recordHoldDurationMs === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Number.isFinite(recordHoldDurationMs)
          ? Math.max(0, recordHoldDurationMs ?? 0)
          : winCelebrationDuration(reducedMotion, record);
      const authoredTimeScale = normalWinAuthoredEffectTimeScale(reducedMotion);
      const showCompleteAt = WIN_LABEL_AUTHORED_TIMELINE_MS.showDuration
        / authoredTimeScale;
      const mergeEndAt = WIN_LABEL_AUTHORED_TIMELINE_MS.mergeEndAt
        / authoredTimeScale;
      const mergeCompleteAt = WIN_LABEL_AUTHORED_TIMELINE_MS.complete
        / authoredTimeScale;
      let authoredElapsedMs = 0;
      const advanceAuthoredTo = (targetElapsedMs: number): void => {
        const nextElapsedMs = Math.max(authoredElapsedMs, targetElapsedMs);
        this.updateAuthored(boxes, label, nextElapsedMs - authoredElapsedMs);
        authoredElapsedMs = nextElapsedMs;
      };
      // HOLD 拥有该记录。恰好在 H 处的转换会失败，并且在 H 之后交付的 RAF 可能只能重建 H 之前的预设时序。
      const boundaryPrecedesHold = (boundaryMs: number): boolean => (
        boundaryMs < holdDurationMs
      );
      await this.animate(holdDurationMs, (_progress, _deltaMs, elapsedMs) => {
        const targetElapsedMs = Math.min(holdDurationMs, elapsedMs);
        if (!multiplierMerge) {
          advanceAuthoredTo(targetElapsedMs);
          return;
        }

        if (
          !showComplete
          && boundaryPrecedesHold(showCompleteAt)
          && targetElapsedMs >= showCompleteAt
        ) {
          // 在 SEPARATE_DELAYED 分配独立乘数之前，WINLABEL_SHOWN 在预设的显示终端位姿上是可观察的。
          advanceAuthoredTo(showCompleteAt);
          showComplete = true;
          const checkpoint = notify("show-complete");
          if (checkpoint) return this.holdMilestoneCheckpoint(checkpoint);
        }

        if (
          showComplete
          && !mergeStarted
          && targetElapsedMs >= showCompleteAt
        ) {
          // 正式的排序是分配 -> WINLABEL_MULTIPLIER_MERGE_START 通知 -> merge_start 命令。回调是观察性的，
          // 因此异步检查点仅在提交命令后才会暂停。
          if (label) this.setLabelFacts(label, record, record.baseAmountMinor);
          const checkpoint = notify("merge-start");
          if (label) {
            label.animations.startMerge();
            this.updateAuthored(boxes, label, 0);
          }
          mergeStarted = true;
          if (checkpoint) return this.holdMilestoneCheckpoint(checkpoint);
        }

        if (
          mergeStarted
          && !mergeEndStarted
          && boundaryPrecedesHold(mergeEndAt)
          && targetElapsedMs >= mergeEndAt
        ) {
          // 在自己预设的时钟上完成merge_start，然后用merge_end替换赛道；延迟的 RAF 不得跳过此姿势范围。
          advanceAuthoredTo(mergeEndAt);
          if (label) {
            this.setLabelFacts(label, record, record.amountMinor);
            label.animations.endMerge();
            this.updateAuthored(boxes, label, 0);
          }
          mergeEndStarted = true;
        }

        if (
          mergeEndStarted
          && !mergeSettled
          && boundaryPrecedesHold(mergeCompleteAt)
          && targetElapsedMs >= mergeCompleteAt
        ) {
          // 在发布终端里程碑之前提交所有 500 毫秒的预设时序。 updateAuthored 在内部对长增量进行时间切片，因此 Spine 永远不会收到不安全的单个巨步。
          advanceAuthoredTo(mergeCompleteAt);
          mergeSettled = true;
          const checkpoint = notify("merge-settled");
          if (checkpoint) return this.holdMilestoneCheckpoint(checkpoint);
        }

        advanceAuthoredTo(targetElapsedMs);
      });

      if (this.destroyed) return;
      if (this.finishRequested) {
        // 交付的任务调度程序中的 cancelDelay() 进入记录的下一个处理程序状态。
        // 在此保留该状态：Continue 开始预设 WinBox 消失 + WinLabel 隐藏/hide_merged，而不是使驻留场景在输入调用堆栈上消失。
        const disappearMs = this.startDisappear(boxes, label, reducedMotion);
        this.reels.clearHighlights();
        this.reels.clearWinDimming(true);
        symbolsRestoredAtHoldBoundary = true;
        resident.pendingCleanupCount = 1;
        const hideCheckpoint = notify("hide-start");
        this.startResidentHideTail({
          generation,
          operation: visualOperation,
          reducedMotion,
          visualFailed,
          notify,
          dimmingGeneration,
          symbolsRestoredAtHoldBoundary,
          boxes,
          label,
          durationMs: disappearMs,
          initialCheckpoint: hideCheckpoint,
        });
        visualOperation = null;
        hideTailStarted = true;
        return;
      }
      const holdCheckpoint = notify("hold-complete");
      if (holdCheckpoint) await this.holdMilestoneCheckpoint(holdCheckpoint);
      if (this.destroyed || this.finishRequested) return;

      // MasterWinView.hide() 在同一同步边界中在 WinSymbols.hide 之前启动 WinBox/WinLabel 隐藏。
      const disappearMs = this.startDisappear(boxes, label, reducedMotion);
      if (restoreSymbolsAtHoldBoundary) {
        this.reels.clearHighlights();
        this.reels.clearWinDimming(true);
        symbolsRestoredAtHoldBoundary = true;
      }
      // 外部调度程序从不等待这个预设的隐藏。后继者可以在 H+0 处声明完全相同的对象，并在其名义上的 333.333343ms 隐藏完成之前取消此尾部。
      resident.pendingCleanupCount = 1;
      const hideCheckpoint = notify("hide-start");
      this.startResidentHideTail({
        generation,
        operation: visualOperation,
        reducedMotion,
        visualFailed,
        notify,
        dimmingGeneration,
        symbolsRestoredAtHoldBoundary,
        boxes,
        label,
        durationMs: disappearMs,
        initialCheckpoint: hideCheckpoint,
      });
      visualOperation = null;
      hideTailStarted = true;
    } catch (error) {
      visualFailed = true;
      if (visualOperation) {
        this.visualTelemetry?.fail(visualOperation, {
          stage: "runtime",
          code: "playback-failed",
          fallback: "procedural",
        });
        visualOperation = null;
      }
      throw error;
    } finally {
      if (generation > 0 && !hideTailStarted) {
        this.finalizeResidentGeneration({
          generation,
          operation: visualOperation,
          reducedMotion,
          visualFailed,
          notify,
          dimmingGeneration,
          symbolsRestoredAtHoldBoundary,
          publishHidden: visible,
          reason: this.destroyed
            ? "cancelled"
            : this.finishRequested ? "continued" : "natural",
        });
        if (!visible && resident && residentPresentationCountBefore !== null) {
          resident.presentationCount = residentPresentationCountBefore;
          resident.viewReused = residentPresentationCountBefore > 0;
          resident.artworkPreparedForRecord = false;
        }
      }
    }
  }

  private ensureResidentScene(
    record: WinRecordPlan,
    reducedMotion: boolean,
    allowArtwork: boolean,
    preload = false,
  ): ResidentWinScene {
    if (!this.resident) {
      const scene = new Container();
      const boxScene = new Container();
      const boxLayer = new Container();
      const labelLayer = new Container();
      boxScene.addChild(boxLayer);
      scene.addChild(labelLayer);
      this.boxView.addChild(boxScene);
      this.view.addChild(scene);
      this.resident = {
        scene,
        boxScene,
        boxLayer,
        labelLayer,
        boxes: [],
        label: null,
        artworkInitializationAttempted: false,
        artworkPreparedForRecord: false,
        labelInstanceId: nextResidentInstanceId++,
        framePoolInstanceId: nextResidentInstanceId++,
        presentationCount: 0,
        activeGeneration: 0,
        activeBoxCount: 0,
        pendingCleanupCount: 0,
        viewReused: false,
        handoffDelayMs: 0,
        staleHiddenCount: 0,
      };
    }

    const resident = this.resident;
    const assets = this.assets;
    if (
      allowArtwork
      && assets
      && !resident.artworkInitializationAttempted
    ) {
      const constructionRecord = preload ? RESIDENT_PRELOAD_RECORD : record;
      const boxTargets = this.createTargets(constructionRecord.cells, this.boxView);
      const labelTargets = this.createTargets(constructionRecord.cells, this.view);
      const stagedBoxLayer = new Container();
      const stagedLabelLayer = new Container();
      let stagedBoxes: AuthoredBox[];
      let stagedLabel: AuthoredLabel;
      try {
        stagedBoxes = this.createAuthoredBoxes(
          stagedBoxLayer,
          constructionRecord.cells,
          boxTargets,
          assets.winBox,
          reducedMotion,
        );
        stagedLabel = this.createAuthoredLabel(
          stagedLabelLayer,
          constructionRecord,
          labelTargets,
          assets.winLabel,
          reducedMotion,
          undefined,
          !preload,
        );
      } catch (error) {
        // 在两次分配成功之前，没有任何内容会成为常驻。销毁分离的暂存层还会释放所有部分构建的 Spine 子级，同时将提交的场景留空并可重试。
        stagedBoxLayer.destroy({ children: true, texture: false, baseTexture: false });
        stagedLabelLayer.destroy({ children: true, texture: false, baseTexture: false });
        resident.artworkInitializationAttempted = false;
        resident.boxes = [];
        resident.label = null;
        throw error;
      }
      const stagedBoxChildren = stagedBoxLayer.removeChildren();
      const stagedLabelChildren = stagedLabelLayer.removeChildren();
      if (stagedBoxChildren.length > 0) resident.boxLayer.addChild(...stagedBoxChildren);
      if (stagedLabelChildren.length > 0) resident.labelLayer.addChild(...stagedLabelChildren);
      stagedBoxLayer.destroy({ children: false, texture: false, baseTexture: false });
      stagedLabelLayer.destroy({ children: false, texture: false, baseTexture: false });
      resident.boxes = stagedBoxes;
      resident.label = stagedLabel;
      resident.artworkPreparedForRecord = !preload;
      resident.artworkInitializationAttempted = true;
    }
    return resident;
  }

  private residentFacts(
    resident: ResidentWinScene | null,
    generation: number,
  ): Readonly<WinCelebrationResidentFacts> {
    if (!resident) {
      return Object.freeze({
        generation,
        labelInstanceId: 0,
        framePoolInstanceId: 0,
        framePoolSize: 0,
        activeBoxCount: 0,
        activeOwnerCount: 0,
        pendingCleanupCount: 0,
        viewReused: false,
        handoffDelayMs: 0,
        staleHiddenCount: 0,
      });
    }
    return Object.freeze({
      generation,
      labelInstanceId: resident.labelInstanceId,
      framePoolInstanceId: resident.framePoolInstanceId,
      framePoolSize: resident.boxes.length,
      activeBoxCount: resident.activeBoxCount,
      activeOwnerCount: resident.activeGeneration === generation ? 1 : 0,
      pendingCleanupCount: resident.pendingCleanupCount,
      viewReused: resident.viewReused,
      handoffDelayMs: resident.handoffDelayMs,
      staleHiddenCount: resident.staleHiddenCount,
    });
  }

  private startResidentHideTail(input: Readonly<{
    generation: number;
    operation: VisualTelemetryOperation | null;
    reducedMotion: boolean;
    visualFailed: boolean;
    notify: (milestone: WinCelebrationMilestone) => void | Promise<void>;
    dimmingGeneration: number;
    symbolsRestoredAtHoldBoundary: boolean;
    boxes: readonly AuthoredBox[];
    label: AuthoredLabel | null;
    durationMs: number;
    initialCheckpoint?: void | Promise<void>;
  }>): void {
    const animationsBefore = new Set(this.animations);
    let initialCheckpoint = input.initialCheckpoint;
    const disappearance = this.animate(input.durationMs, (_progress, deltaMs) => {
      this.updateAuthored(input.boxes, input.label, deltaMs);
      const checkpoint = initialCheckpoint;
      initialCheckpoint = undefined;
      return checkpoint;
    });
    const animation = [...this.animations].find((candidate) => (
      !animationsBefore.has(candidate)
    )) ?? null;
    const tail: ResidentHideTail = {
      generation: input.generation,
      animation,
      operation: input.operation,
      reducedMotion: input.reducedMotion,
      visualFailed: input.visualFailed,
      notify: input.notify,
      dimmingGeneration: input.dimmingGeneration,
      symbolsRestoredAtHoldBoundary: input.symbolsRestoredAtHoldBoundary,
      cancelled: false,
      completed: false,
    };
    this.residentHideTail = tail;
    void disappearance.then(
      () => this.completeResidentHideTail(tail),
      () => {
        tail.visualFailed = true;
        if (tail.operation) {
          this.visualTelemetry?.fail(tail.operation, {
            stage: "animation",
            code: "playback-failed",
            fallback: "procedural",
          });
        }
        this.completeResidentHideTail(tail);
      },
    );
  }

  private completeResidentHideTail(tail: ResidentHideTail): void {
    if (tail.cancelled || tail.completed) return;
    tail.completed = true;
    if (this.residentHideTail === tail) this.residentHideTail = null;
    this.finalizeResidentGeneration({
      generation: tail.generation,
      operation: tail.operation,
      reducedMotion: tail.reducedMotion,
      visualFailed: tail.visualFailed,
      notify: tail.notify,
      dimmingGeneration: tail.dimmingGeneration,
      symbolsRestoredAtHoldBoundary: tail.symbolsRestoredAtHoldBoundary,
      publishHidden: true,
      reason: tail.reducedMotion ? "reduced-motion-skip" : "natural",
    });
  }

  private cancelResidentHideTail(reason: "takeover" | "finish" | "destroy"): void {
    const tail = this.residentHideTail;
    if (!tail || tail.completed || tail.cancelled) return;
    tail.cancelled = true;
    if (this.residentHideTail === tail) this.residentHideTail = null;
    tail.animation?.finish();
    if (this.resident?.activeGeneration === tail.generation) {
      this.resident.pendingCleanupCount = 0;
    }

    if (reason === "takeover") {
      this.completeVisualOperation(
        tail.operation,
        tail.visualFailed,
        tail.reducedMotion ? "reduced-motion-skip" : "natural",
      );
      return;
    }
    this.finalizeResidentGeneration({
      generation: tail.generation,
      operation: tail.operation,
      reducedMotion: tail.reducedMotion,
      visualFailed: tail.visualFailed,
      notify: tail.notify,
      dimmingGeneration: tail.dimmingGeneration,
      symbolsRestoredAtHoldBoundary: tail.symbolsRestoredAtHoldBoundary,
      publishHidden: true,
      reason: reason === "destroy" ? "cancelled" : "continued",
    });
  }

  private finalizeResidentGeneration(input: Readonly<{
    generation: number;
    operation: VisualTelemetryOperation | null;
    reducedMotion: boolean;
    visualFailed: boolean;
    notify: (milestone: WinCelebrationMilestone) => void | Promise<void>;
    dimmingGeneration: number;
    symbolsRestoredAtHoldBoundary: boolean;
    publishHidden: boolean;
    reason: VisualTelemetryCompletionOutcome;
  }>): void {
    const resident = this.resident;
    if (
      !resident
      || input.generation <= this.lastFinalizedGeneration
      || resident.activeGeneration !== input.generation
    ) {
      this.completeVisualOperation(input.operation, input.visualFailed, input.reason);
      return;
    }
    this.lastFinalizedGeneration = input.generation;
    resident.activeGeneration = 0;
    resident.activeBoxCount = 0;
    resident.pendingCleanupCount = 0;
    for (const box of resident.boxes) box.active = false;
    resident.scene.visible = false;
    resident.boxScene.visible = false;
    if (
      this.dimmingGeneration === input.dimmingGeneration
      && !input.symbolsRestoredAtHoldBoundary
    ) {
      this.reels.clearWinDimming();
    }
    if (input.publishHidden) input.notify("hidden");
    this.completeVisualOperation(input.operation, input.visualFailed, input.reason);
  }

  private completeVisualOperation(
    operation: VisualTelemetryOperation | null,
    visualFailed: boolean,
    reason: VisualTelemetryCompletionOutcome,
  ): void {
    if (!operation || visualFailed) return;
    this.visualTelemetry?.complete(operation, reason);
  }

  private discardResidentScene(): void {
    const resident = this.resident;
    if (!resident) return;
    this.release(resident.boxScene);
    this.release(resident.scene);
    this.resident = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.checkpointCancel?.();
    this.cancelResidentHideTail("destroy");
    for (const animation of [...this.animations]) animation.finish();
    this.reels.clearWinDimming();
    if (this.resident) {
      this.release(this.resident.boxScene);
      this.release(this.resident.scene);
    }
  }

  private createTargets(
    cells: readonly CellAddress[],
    host: Container = this.view,
  ): Map<string, WinTarget> {
    const targets = new Map<string, WinTarget>();
    for (const address of cells) {
      const bounds = this.reels.getCellPresentationBounds(address);
      if (!bounds) continue;
      const topLeft = this.effectPoint(new Point(bounds.left, bounds.top), host);
      const bottomRight = this.effectPoint(new Point(bounds.right, bounds.bottom), host);
      const center = new Point(
        (topLeft.x + bottomRight.x) / 2,
        (topLeft.y + bottomRight.y) / 2,
      );
      targets.set(`${address.reel}:${address.row}`, {
        address,
        center,
        width: Math.abs(bottomRight.x - topLeft.x),
        height: Math.abs(bottomRight.y - topLeft.y),
      });
    }
    return targets;
  }

  private createAuthoredBoxes(
    host: Container,
    _cells: readonly CellAddress[],
    _targets: ReadonlyMap<string, WinTarget>,
    data: SpineData,
    reducedMotion: boolean,
  ): AuthoredBox[] {
    const boxes: AuthoredBox[] = [];
    for (let index = 0; index < PRIMAL_WINBOX_POOL_SIZE; index += 1) {
      const view = createSpineView(data);
      view.autoUpdate = false;
      view.state.timeScale = normalWinAuthoredEffectTimeScale(reducedMotion);
      if (view.state.hasAnimation("hidden")) view.state.setAnimation(0, "hidden", false);
      view.update(0);
      host.addChild(view);
      boxes.push({ view, active: false, ownerGeneration: 0 });
    }
    return boxes;
  }

  private retargetAuthoredBoxes(
    boxes: readonly AuthoredBox[],
    cells: readonly CellAddress[],
    targets: ReadonlyMap<string, WinTarget>,
    reducedMotion: boolean,
    generation: number,
  ): void {
    const activeTargets = cells
      .map((cell) => targets.get(`${cell.reel}:${cell.row}`))
      .filter((target): target is WinTarget => target !== undefined)
      .slice(0, PRIMAL_WINBOX_POOL_SIZE);
    for (const [index, box] of boxes.entries()) {
      const target = activeTargets[index];
      if (!target) {
        box.active = false;
        continue;
      }
      box.active = true;
      box.ownerGeneration = generation;
      box.view.state.timeScale = normalWinAuthoredEffectTimeScale(reducedMotion);
      box.view.position.copyFrom(target.center);
      box.view.scale.set(
        target.width / WINBOX_SOURCE_WIDTH,
        target.height / WINBOX_SOURCE_HEIGHT,
      );
      if (box.view.state.hasAnimation("hidden")) {
        box.view.state.setAnimation(0, "hidden", false);
      }
      box.view.update(0);
      if (box.view.state.hasAnimation("loop")) {
        box.view.state.setAnimation(0, "loop", true);
      }
      if (box.view.state.hasAnimation("appear")) {
        box.view.state.setAnimation(1, "appear", false);
      }
    }
  }

  private createAuthoredLabel(
    host: Container,
    record: WinRecordPlan,
    targets: ReadonlyMap<string, WinTarget>,
    data: SpineData,
    reducedMotion: boolean,
    onMissingSlot?: () => void,
    startShown = true,
  ): AuthoredLabel {
    const firstTarget = targets.values().next().value as WinTarget | undefined;
    const group = new Container();
    if (firstTarget) {
      const bounds = this.reels.getPresentationBounds();
      const center = this.effectPoint(new Point(bounds.width / 2, bounds.height / 2));
      group.position.copyFrom(center);
      group.scale.set(
        firstTarget.width / WINBOX_SOURCE_WIDTH,
        firstTarget.height / WINBOX_SOURCE_HEIGHT,
      );
    }

    const view = createSpineView(data);
    view.autoUpdate = false;
    view.state.timeScale = normalWinAuthoredEffectTimeScale(reducedMotion);
    const animations = new WinLabelAnimationController(view.state);
    animations.setHidden();
    view.update(0);
    if (startShown) animations.show();

    const initial = winLabelMergeFrame(record, 0, reducedMotion);
    // 官方的SEPARATE_DELAYED模式创建基础标签，没有独立的乘数。它在 `show` 之后的合并开始时分配。
    const facts = authoritativeWinLabelText(
      initial.amountMinor,
      record.ways,
      undefined,
      this.moneyFormatter,
    );
    const definitions: readonly Readonly<{
      name: WinLabelTextSlot;
      value: string | null;
      style: TextStyle;
    }>[] = [
      { name: "winLabelValue", value: facts.winLabelValue, style: winLabelGoldTextStyle() },
      { name: "winLabelInfo", value: facts.winLabelInfo, style: winLabelInfoTextStyle() },
      { name: "winLabelMultiplier", value: facts.winLabelMultiplier, style: winLabelGoldTextStyle() },
    ];
    const fields = definitions.map(({ name, value, style }): AuthoredLabelTextField => {
      const text = new Text(value ?? "", style);
      text.anchor.set(0.5);
      text.visible = false;
      return {
        name,
        text,
        point: new Vector2(),
        hasAuthoritativeText: value !== null && value.length > 0,
      };
    });
    group.addChild(view, ...fields.map(({ text }) => text));
    host.addChild(group);
    const label = { group, view, fields, animations };
    if (!this.syncLabelText(label)) onMissingSlot?.();
    return label;
  }

  private retargetAuthoredLabel(
    label: AuthoredLabel,
    record: WinRecordPlan,
    targets: ReadonlyMap<string, WinTarget>,
    reducedMotion: boolean,
  ): void {
    const firstTarget = targets.values().next().value as WinTarget | undefined;
    if (!firstTarget) return;
    const bounds = this.reels.getPresentationBounds();
    const center = this.effectPoint(new Point(bounds.width / 2, bounds.height / 2));
    label.group.position.copyFrom(center);
    label.group.scale.set(
      firstTarget.width / WINBOX_SOURCE_WIDTH,
      firstTarget.height / WINBOX_SOURCE_HEIGHT,
    );
    label.view.state.timeScale = normalWinAuthoredEffectTimeScale(reducedMotion);
    const initial = winLabelMergeFrame(record, 0, reducedMotion);
    this.setInitialLabelFacts(label, record, initial.amountMinor);
    label.animations.show();
    label.view.update(0);
    this.syncLabelText(label);
  }

  private setInitialLabelFacts(
    label: AuthoredLabel,
    record: WinRecordPlan,
    amountMinor: MoneyMinor,
  ): void {
    const facts = authoritativeWinLabelText(
      amountMinor,
      record.ways,
      undefined,
      this.moneyFormatter,
    );
    for (const field of label.fields) {
      const value = facts[field.name];
      field.text.text = value ?? "";
      field.hasAuthoritativeText = value !== null && value.length > 0;
    }
    this.syncLabelText(label);
  }

  private setLabelFacts(
    label: AuthoredLabel,
    record: WinRecordPlan,
    amountMinor: MoneyMinor = record.amountMinor,
  ): void {
    const facts = authoritativeWinLabelText(
      amountMinor,
      record.ways,
      record.multiplier,
      this.moneyFormatter,
    );
    for (const field of label.fields) {
      const value = facts[field.name];
      field.text.text = value ?? "";
      field.hasAuthoritativeText = value !== null && value.length > 0;
    }
    this.syncLabelText(label);
  }

  private syncLabelText(label: AuthoredLabel): boolean {
    const skeleton = label.view.skeleton;
    let ready = true;
    skeleton.updateWorldTransform();
    for (const field of label.fields) {
      if (!field.hasAuthoritativeText) {
        field.text.visible = false;
        continue;
      }
      const slot = skeleton.findSlot(field.name);
      const attachment = slot
        ? resolveWinLabelTextAttachment<{ vertices?: ArrayLike<number> }>(skeleton, slot)
        : null;
      if (!slot || !attachment) {
        ready = false;
        field.text.visible = false;
        continue;
      }

      const vertices = attachment.vertices;
      let boundsWidth = Number.POSITIVE_INFINITY;
      let boundsHeight = Number.POSITIVE_INFINITY;
      if (vertices && vertices.length >= 2) {
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (let index = 0; index + 1 < vertices.length; index += 2) {
          const x = vertices[index];
          const y = vertices[index + 1];
          if (x === undefined || y === undefined) continue;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
        if (Number.isFinite(minX) && Number.isFinite(minY)) {
          field.point.set((minX + maxX) / 2, (minY + maxY) / 2);
          slot.bone.localToWorld(field.point);
          field.text.position.set(field.point.x, field.point.y);
          boundsWidth = Math.max(0, maxX - minX);
          boundsHeight = Math.max(0, maxY - minY);
        } else {
          field.text.position.set(slot.bone.worldX, slot.bone.worldY);
        }
      } else {
        field.text.position.set(slot.bone.worldX, slot.bone.worldY);
      }

      field.text.rotation = 0;
      field.text.scale.set(1);
      const naturalWidth = field.text.width;
      const naturalHeight = field.text.height;
      const fitScale = Math.min(
        1,
        boundsWidth / Math.max(0.0001, naturalWidth),
        boundsHeight / Math.max(0.0001, naturalHeight),
      );
      const transform = readableWinLabelTextTransform(slot.bone.matrix, fitScale);
      field.text.rotation = transform.rotation;
      field.text.scale.set(transform.scaleX, transform.scaleY);
      field.text.alpha = slot.color.a * skeleton.color.a;
      field.text.visible = field.text.alpha > 0.001;
    }
    return ready;
  }

  private updateAuthored(
    boxes: readonly AuthoredBox[],
    label: AuthoredLabel | null,
    deltaMs: number,
  ): void {
    const totalDeltaMs = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0;
    // 保留每个预设的毫秒，同时限制每个单独的 Spine 更新。每当 RAF 延迟时，在 64ms 之后放弃所有内容都会使挂钟里程碑领先于实际骨架。
    if (totalDeltaMs === 0) {
      for (const box of boxes) box.view.update(0);
      if (label) label.view.update(0);
    } else {
      let remainingMs = totalDeltaMs;
      while (remainingMs > 0) {
        const sliceMs = Math.min(64, remainingMs);
        const deltaSeconds = sliceMs / 1_000;
        for (const box of boxes) box.view.update(deltaSeconds);
        if (label) label.view.update(deltaSeconds);
        remainingMs -= sliceMs;
      }
    }
    if (!label) return;
    this.syncLabelText(label);
  }

  private startDisappear(
    boxes: readonly AuthoredBox[],
    label: AuthoredLabel | null,
    reducedMotion: boolean,
  ): number {
    let hasAuthoredFrame = false;
    for (const box of boxes) {
      if (!box.active) continue;
      if (box.view.state.hasAnimation("loop")) box.view.state.setAnimation(0, "loop", true);
      if (box.view.state.hasAnimation("disappear")) {
        box.view.state.setAnimation(1, "disappear", false);
        hasAuthoredFrame = true;
      }
    }
    if (label) {
      label.animations.hide();
      hasAuthoredFrame = true;
    }
    const timeScale = normalWinAuthoredEffectTimeScale(reducedMotion);
    return hasAuthoredFrame
      ? WIN_LABEL_AUTHORED_TIMELINE_MS.hideDuration / timeScale
      : 0;
  }

  private effectPoint(localPoint: Point, host: Container = this.view): Point {
    return host.toLocal(this.reels.toGlobal(localPoint));
  }

  private animate(
    durationMs: number,
    onFrame: (
      progress: number,
      deltaMs: number,
      elapsedMs: number,
    ) => void | Promise<void>,
  ): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const infinite = durationMs === Number.POSITIVE_INFINITY;
      const safeDurationMs = infinite
        ? Number.POSITIVE_INFINITY
        : Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
      let startedAt = performance.now();
      let previousElapsedMs = 0;
      let settled = false;
      const animation: ActiveAnimation = {
        handle: null,
        finish: () => settle(),
      };
      const settle = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (animation.handle !== null) cancelAnimationFrame(animation.handle);
        animation.handle = null;
        this.animations.delete(animation);
        if (error === undefined) resolve();
        else reject(error);
      };
      const resumeAfterCheckpoint = (
        checkpoint: Promise<void>,
        pausedAt: number | null,
        complete: boolean,
      ): void => {
        animation.handle = null;
        void Promise.resolve(checkpoint).catch(() => undefined).then(() => {
          if (settled) return;
          if (complete || this.finishRequested) {
            settle();
            return;
          }
          animation.handle = requestAnimationFrame((resumedAt) => {
            if (settled) return;
            if (pausedAt !== null) {
              startedAt += Math.max(0, resumedAt - pausedAt);
            }
            tick(resumedAt);
          });
        });
      };
      const tick = (time: number): void => {
        // 取消的 requestAnimationFrame 已经可以由主机排队或由确定性时钟重放。它不再拥有这一代，并且不得用 merge_end 覆盖预设的出口。
        if (settled) return;
        if (this.destroyed) {
          settle();
          return;
        }
        const wallElapsedMs = Math.max(0, time - startedAt);
        // HOLD 是权威的。即使浏览器提供了延迟的 RAF，也不要将超过 H 的经过时间暴露给表现回调。
        const elapsedMs = Math.min(
          safeDurationMs,
          Math.max(previousElapsedMs, wallElapsedMs),
        );
        const deltaMs = Math.max(0, elapsedMs - previousElapsedMs);
        previousElapsedMs = elapsedMs;
        const progress = infinite
          ? 0
          : safeDurationMs === 0 ? 1 : clamp(elapsedMs / safeDurationMs);
        try {
          const checkpoint = onFrame(progress, deltaMs, elapsedMs);
          if (checkpoint) {
            resumeAfterCheckpoint(checkpoint, time, progress >= 1);
            return;
          }
        } catch (error) {
          settle(error);
          return;
        }
        if (progress >= 1) {
          settle();
          return;
        }
        animation.handle = requestAnimationFrame(tick);
      };
      this.animations.add(animation);
      try {
        const checkpoint = onFrame(0, 0, 0);
        if (checkpoint) resumeAfterCheckpoint(checkpoint, performance.now(), false);
        else animation.handle = requestAnimationFrame(tick);
      } catch (error) {
        settle(error);
      }
    });
  }

  private holdMilestoneCheckpoint(checkpoint: Promise<void>): Promise<void> {
    this.checkpointCancel?.();
    this.checkpointPending = true;
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (this.checkpointCancel === finish) this.checkpointCancel = null;
        this.checkpointPending = false;
        resolve();
      };
      this.checkpointCancel = finish;
      void checkpoint.then(finish, finish);
      if (this.destroyed) finish();
    });
  }

  private release(scene: Container): void {
    if (scene.parent) scene.parent.removeChild(scene);
    if (!scene.destroyed) scene.destroy({ children: true, texture: false, baseTexture: false });
  }
}
