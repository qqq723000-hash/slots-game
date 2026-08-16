import { Container, Graphics, Sprite, Text, TextStyle, Texture } from "pixi.js";
import {
  SYMBOL_ASSET_BY_ID,
  WILD_MULTIPLIER_ASSETS,
  wildAssetForMultiplier,
} from "../assets/PrimalAssetManifest";
import type { GridCell, SymbolId } from "../app/state/types";
import {
  createSpineView,
  enforcePrimalRegionBlendModes,
  partitionPrimalAdditiveSlots,
  type Spine,
  type SpineData,
} from "../renderer/spine/SpineAdapter";
import {
  loadPrimalSpineSet,
} from "../renderer/spine/PrimalSpineAssets";
import {
  runFrameSlicedInitialization,
  type FrameRequest,
} from "../startup/frameSlicedInitialization";
import {
  PRIMAL_CLIENT_SYMBOL_ID_BY_SERVER_ID,
  PRIMAL_SYMBOL_SPINE_KEYS,
  PRIMAL_SYMBOL_SPINE_KEY_BY_SERVER_ID,
  type PrimalSymbolSpineKey,
} from "./primalSymbolSpines";
import { primalSymbolIdleClip } from "./primalAnimationTiming";
import type { ReelStopMode } from "./reelMotion";

const symbolTextures = new Map<string, Texture>();
const authoredSymbolData = new Map<PrimalSymbolSpineKey, SpineData>();
let symbolLoadPromise: Promise<void> | null = null;
let authoredSymbolLoadPromise: Promise<void> | null = null;

// 复刻的转轴控制器在 240x160 源格子中制作每个符号，再应用转轴独立的 X/Y 缩放。沿用相同源尺寸可以保留机台美术刻意略微压扁的效果。
const AUTHORED_SYMBOL_WIDTH = 240;
const AUTHORED_SYMBOL_HEIGHT = 160;

const SYMBOL_GLOW: Readonly<Record<SymbolId, number>> = Object.freeze({
  ORBIT: 0xd6e2f1,
  PRISM: 0xd6e2f1,
  PULSE: 0xa9d44d,
  NOVA: 0x9bc245,
  CIRCUIT: 0xff3a27,
  TANK: 0xe800d0,
  WILD: 0x8dff3a,
  VAULT: 0xffd253,
  SURGE: 0xff3a1e,
});

function allSymbolURLs(): readonly string[] {
  return [...new Set([
    ...Object.values(SYMBOL_ASSET_BY_ID),
    ...WILD_MULTIPLIER_ASSETS,
  ])];
}

export function loadSymbolTextures(): Promise<void> {
  if (symbolLoadPromise) return symbolLoadPromise;
  symbolLoadPromise = Promise.all(allSymbolURLs().map(async (url) => {
    const texture = await Texture.fromURL(url);
    symbolTextures.set(url, texture);
  })).then(() => undefined);
  return symbolLoadPromise;
}

/** 通过共享符号图集加载所有十个原始符号状态。 */
export function loadAuthoredSymbolSpines(): Promise<void> {
  if (authoredSymbolData.size === PRIMAL_SYMBOL_SPINE_KEYS.length) return Promise.resolve();
  if (authoredSymbolLoadPromise) return authoredSymbolLoadPromise;

  const attempt = loadPrimalSpineSet(PRIMAL_SYMBOL_SPINE_KEYS).then((set) => {
    for (const key of PRIMAL_SYMBOL_SPINE_KEYS) authoredSymbolData.set(key, set[key]);
  });
  authoredSymbolLoadPromise = attempt;
  void attempt.catch(() => {
    // 使失败的资源请求在稍后的渲染器启动时可重试。如果设备策略禁用预设的 Spine，静态捕获仍然可见。
    if (authoredSymbolLoadPromise === attempt) authoredSymbolLoadPromise = null;
  });
  return attempt;
}

export function loadedSymbolTextures(): readonly Texture[] {
  return [...symbolTextures.values()];
}

export function hasLoadedAuthoredSymbolSpines(): boolean {
  return authoredSymbolData.size === PRIMAL_SYMBOL_SPINE_KEYS.length;
}

const PRIMAL_SYMBOL_WIN_SPINE_KEYS: readonly PrimalSymbolSpineKey[] = Object.freeze([
  "symbol0",
  "symbol1",
  "symbol2",
  "symbol3",
  "symbol4",
  "symbol5",
  "symbol6",
]);

export type AuthoredSymbolRequiredClip = "land" | "win";

export interface AuthoredSymbolRequiredClipGaps {
  readonly land: readonly PrimalSymbolSpineKey[];
  readonly win: readonly PrimalSymbolSpineKey[];
}

export interface AuthoredSymbolClipValidationOptions {
  readonly signal?: AbortSignal;
  readonly requestFrame?: FrameRequest;
  readonly onProgress?: (fraction: number) => void;
}

/**
 * 只有停止时间土地和支付符号中奖片段是无条件的启动要求。 Rage/Vault 功能剪辑是有条件的，并在实际激活它们的里程碑处同步验证。
 */
export function authoredSymbolRequiredClipGaps(
  hasAnimation: (
    key: PrimalSymbolSpineKey,
    animation: AuthoredSymbolRequiredClip,
  ) => boolean,
): AuthoredSymbolRequiredClipGaps {
  return Object.freeze({
    land: Object.freeze(PRIMAL_SYMBOL_SPINE_KEYS.filter((key) => !hasAnimation(key, "land"))),
    win: Object.freeze(PRIMAL_SYMBOL_WIN_SPINE_KEYS.filter((key) => !hasAnimation(key, "win"))),
  });
}

/**
 * 为有界切片中提供的每个符号构造一个临时实例，然后在报告准备情况之前证明所需的剪辑存在。
 */
export async function validateAuthoredSymbolRequiredClips(
  options: AuthoredSymbolClipValidationOptions = {},
): Promise<AuthoredSymbolRequiredClipGaps> {
  const animations = new Map<PrimalSymbolSpineKey, ReadonlySet<string>>();
  await runFrameSlicedInitialization(
    PRIMAL_SYMBOL_SPINE_KEYS.length,
    (start, count) => {
      for (let offset = 0; offset < count; offset += 1) {
        const key = PRIMAL_SYMBOL_SPINE_KEYS[start + offset];
        if (!key) continue;
        const data = authoredSymbolData.get(key);
        if (!data) {
          animations.set(key, new Set());
          continue;
        }
        const view = createSpineView(data);
        try {
          animations.set(key, new Set([
            ...(view.state.hasAnimation("land") ? ["land"] : []),
            ...(view.state.hasAnimation("win") ? ["win"] : []),
          ]));
        } finally {
          view.destroy({ children: true, texture: false, baseTexture: false });
        }
      }
    },
    {
      batchSize: 2,
      signal: options.signal,
      requestFrame: options.requestFrame,
      onProgress: options.onProgress,
    },
  );
  return authoredSymbolRequiredClipGaps((key, animation) => (
    animations.get(key)?.has(animation) === true
  ));
}

function textureURLFor(cell: GridCell): string {
  if (cell.symbol === "WILD") return wildAssetForMultiplier(cell.multiplier);
  return SYMBOL_ASSET_BY_ID[cell.symbol];
}

function textureFor(cell: GridCell): Texture {
  return symbolTextures.get(textureURLFor(cell)) ?? Texture.EMPTY;
}

export function authoredSymbolRestAnimation(_symbol: SymbolId): "stop" {
  return "stop";
}

/** 空闲是由全局空闲控制器一次性选择的，而不是休息循环。 */
export function authoredSymbolIdleAnimation(symbol: SymbolId): "idle" | null {
  return primalSymbolIdleClip(PRIMAL_CLIENT_SYMBOL_ID_BY_SERVER_ID[symbol])?.animation ?? null;
}

/** 当权威的 Vault 已打开时，包括 Symbol9。 */
export function authoredCellIdleAnimation(cell: GridCell): "idle" | null {
  const key = authoredSymbolSpineKeyForCell(cell);
  return primalSymbolIdleClip(Number(key.slice("symbol".length)))?.animation ?? null;
}

export function authoredCellIdleDurationMs(cell: GridCell): number | null {
  const key = authoredSymbolSpineKeyForCell(cell);
  return primalSymbolIdleClip(Number(key.slice("symbol".length)))?.durationMs ?? null;
}

/** 仅功能符号不会伪造支付线中奖动画。 */
export function authoredSymbolWinAnimation(symbol: SymbolId): "win" | null {
  if (symbol === "SURGE" || symbol === "VAULT") return null;
  return "win";
}

const AUTHORED_WILD_VARIANTS = new Set([
  "x_nomulti", "x1", "x2", "x3", "x5", "x10", "x25", "x50", "x100",
]);
const STATIC_WILD_MULTIPLIERS = new Set([2, 3, 5, 10, 25, 50, 100]);
const AUTHORED_VAULT_PRIZES = new Set([
  "mini", "minor", "major", "mega", "grand",
  "mini_2x", "minor_2x", "major_2x", "mega_2x", "free_spin",
]);

/** 打开金库使用Symbol9；无值锁定的 Vault 仍为 Symbol8。 */
export function authoredSymbolSpineKeyForCell(cell: GridCell): PrimalSymbolSpineKey {
  if (cell.symbol === "VAULT" && cell.lockedVaultFace !== undefined) return "symbol8";
  if (cell.symbol === "VAULT" && (cell.prize !== undefined || cell.multiplier !== undefined)) {
    return "symbol9";
  }
  return PRIMAL_SYMBOL_SPINE_KEY_BY_SERVER_ID[cell.symbol];
}

/** 瞬态锁定 Vault 适配器使用的纯表现选择器。 */
export function authoredSymbolSpineKeyForPresentation(
  cell: Readonly<GridCell>,
  forceLockedVault = false,
): PrimalSymbolSpineKey {
  return forceLockedVault && cell.symbol === "VAULT"
    ? "symbol8"
    : authoredSymbolSpineKeyForCell(cell);
}

/** 精确的零持续时间值会叠加在预设的符号主体上。 */
export function authoredCellVariantAnimation(cell: GridCell): string | null {
  if (cell.symbol === "WILD") {
    const animation = cell.multiplier === undefined ? "x_nomulti" : `x${cell.multiplier}`;
    return AUTHORED_WILD_VARIANTS.has(animation) ? animation : null;
  }
  if (cell.symbol !== "VAULT") return null;
  if (cell.lockedVaultFace !== undefined) return cell.lockedVaultFace;
  // 规范无值VAULT是官方服务器符号17：在Symbol8上锁定x1。选择其零持续时间姿势会保留 X1 铭牌；打开/承载价值的金库继续使用下面的 Symbol9。
  if (cell.prize === undefined && cell.multiplier === undefined) return "x1";
  if (cell.prize !== undefined) {
    const normalized = cell.prize.toLowerCase();
    if (AUTHORED_VAULT_PRIZES.has(normalized)) return normalized;
    if (/^x(?:[1-9]|10)$/.test(normalized)) return normalized;
  }
  if (cell.multiplier !== undefined && cell.multiplier >= 1 && cell.multiplier <= 10) {
    return `x${cell.multiplier}`;
  }
  return null;
}

/**
 * Symbol9 的 `feature_activation` 剪辑仅属于 Vault，该 Vault 会奖励额外的免费 Spin。头奖/价值金库保持其价值姿态并赢得中奖。
 */
export function authoredVaultFreeSpinActivation(cell: GridCell): "feature_activation" | null {
  return cell.symbol === "VAULT" && cell.prize?.toLowerCase() === "free_spin"
    ? "feature_activation"
    : null;
}

/** 仅当提供的 Spine/静态艺术没有匹配的姿势时才使用文本。 */
export function cellVariantFallbackLabel(cell: GridCell): string | null {
  if (cell.symbol === "WILD") {
    return cell.multiplier === undefined ? null : `×${cell.multiplier}`;
  }
  if (cell.symbol !== "VAULT") return null;
  if (cell.prize !== undefined) {
    if (/^x\d+$/i.test(cell.prize)) return `×${cell.prize.slice(1)}`;
    return cell.prize.replaceAll("_", " ");
  }
  return cell.multiplier === undefined ? null : `×${cell.multiplier}`;
}

export interface SymbolContentVisibility {
  readonly authoredLayer: boolean;
  readonly cellGlass: boolean;
  readonly staticArt: boolean;
  readonly scan: boolean;
}

export interface SymbolCellPresentationOptions {
  /** 将权威的 Wild 倍增器隐藏起来，直到其露出夹子。 */
  readonly deferWildVariant?: boolean;
  /**
   * 在锁定的Symbol8身上保留一个权威的、有价值的Vault，直到`vault.unlocked`完成。
   * 这只是表现状态：复制的 `GridCell` 在整个停止过程中仍然是最终的服务器单元。
   */
  readonly forceLockedVault?: boolean;
}

const BASE_VAULT_JACKPOT_PRIZES = new Set([
  "mini", "minor", "major", "mega", "grand",
]);

/**
 * 将最终的 Vault 值投影到在 Symbol8 上实际预设的姿势上。锁定的骨架上不存在双倍累积奖金板，因此它们的基本累积奖金名称将保留，直到 Symbol9 替换整个实例。
 */
export function lockedVaultPresentationCell(cell: Readonly<GridCell>): GridCell {
  const projected: GridCell = { ...cell };
  if (cell.symbol !== "VAULT" || cell.prize === undefined) return projected;
  const normalized = cell.prize.toLowerCase();
  if (normalized.endsWith("_2x")) {
    const base = normalized.slice(0, -3);
    if (BASE_VAULT_JACKPOT_PRIZES.has(base)) projected.prize = base.toUpperCase();
  }
  return projected;
}

export interface SymbolSpineTrackCaptureDiagnostics {
  readonly animation: string | null;
  readonly trackTimeMs: number;
  readonly mixDuration: number;
}

export interface SymbolVaultCaptureDiagnostics {
  readonly cell: Readonly<GridCell>;
  readonly spineKey: PrimalSymbolSpineKey | null;
  readonly track0: Readonly<SymbolSpineTrackCaptureDiagnostics> | null;
  readonly track1: Readonly<SymbolSpineTrackCaptureDiagnostics> | null;
  readonly paused: boolean;
}

export const SYMBOL_FULL_COLOUR_TINT = 0xffffff;
export const SYMBOL_DIMMED_TINT = 0x888888;

export interface SymbolDimStep {
  readonly progress: number;
  readonly tint: number;
  readonly complete: boolean;
}

/** 来自捕获的双向 SymbolFader 的一个精确调度程序滴答。 */
export function nextSymbolTintStep(
  progress: number,
  fromTint: number,
  targetTint: number,
): SymbolDimStep {
  const nextProgress = progress + 0.3 * (1 - progress);
  const complete = nextProgress > 0.95;
  if (complete) {
    return { progress: nextProgress, tint: targetTint, complete };
  }

  const inverseProgress = 1 - nextProgress;
  const channel = (shift: number): number => (
    ((fromTint >> shift) & 0xff) * inverseProgress
    + ((targetTint >> shift) & 0xff) * nextProgress
  ) << 0;
  const tint = (channel(16) << 16) | (channel(8) << 8) | channel(0);
  return { progress: nextProgress, tint, complete };
}

export function nextSymbolDimStep(progress: number): SymbolDimStep {
  return nextSymbolTintStep(progress, SYMBOL_FULL_COLOUR_TINT, SYMBOL_DIMMED_TINT);
}

export function nextSymbolRestoreStep(
  progress: number,
  fromTint = SYMBOL_DIMMED_TINT,
): SymbolDimStep {
  return nextSymbolTintStep(progress, fromTint, SYMBOL_FULL_COLOUR_TINT);
}

/** Rage 提取和单元测试使用的纯第 2 层/第 3 层投影。 */
export function symbolContentVisibility(
  hasAuthoredView: boolean,
  featureHidden: boolean,
  presentationOverlayOnly: boolean,
): SymbolContentVisibility {
  const authoredVisible = hasAuthoredView && !featureHidden;
  return {
    authoredLayer: !featureHidden,
    cellGlass: !presentationOverlayOnly && !authoredVisible && !featureHidden,
    staticArt: !presentationOverlayOnly && !authoredVisible && !featureHidden,
    scan: !presentationOverlayOnly && !authoredVisible && !featureHidden,
  };
}

/**
 * 单个服务端寻址格子的表现适配器。停稳格子可以使用原始 Spine 骨架，装饰性的滚动条格子则保留轻量静态纹理。
 */
export class SymbolView extends Container {
  private readonly cellGlass = new Graphics();
  private readonly art = new Sprite(Texture.EMPTY);
  private readonly authoredLayer = new Container();
  /**
   * 仅用于表现的双胞胎安装在 ReelSetView 的过滤树外部。它的父级由 ReelView/ReelSetView 所有，而不是由该容器所有。
   */
  private readonly winningAdditiveRoot = new Container();
  private readonly variantLabel = new Text("", new TextStyle({
    align: "center",
    fill: 0xfff0b1,
    fontFamily: "Arial Black, Impact, sans-serif",
    fontSize: 20,
    fontWeight: "900",
    letterSpacing: 0.8,
    stroke: 0x171008,
    strokeThickness: 5,
  }));
  private readonly scan = new Graphics();
  private currentCell: GridCell = { symbol: "CIRCUIT" };
  private viewWidth = 180;
  private viewHeight = 112;
  private authoredEnabled: boolean;
  private authoredView: Spine | null = null;
  private authoredAdditiveView: Spine | null = null;
  private authoredKey: PrimalSymbolSpineKey | null = null;
  private additiveCompositeActive = false;
  /**
   * 一次完成后，外部 ADD 姿势可以保持冻结状态。将此时钟标志与渲染所有权分开，这样固定的发光帧不会使每个池化的 3x8 符号永远前进第二个 Spine。
   */
  private additivePlaybackRunning = false;
  private activeAdditiveAttachmentCount = 0;
  private highlighted = false;
  private dimmed = false;
  private dimProgress = 0;
  private presentationTint = SYMBOL_FULL_COLOUR_TINT;
  private tintFrom = SYMBOL_FULL_COLOUR_TINT;
  private tintTarget = SYMBOL_FULL_COLOUR_TINT;
  private tintTransitionActive = false;
  private idleBlocked = false;
  private featureHidden = false;
  private deferredWildVariant = false;
  private forceLockedVault = false;
  /** 仅测试夹具视觉保持；如果没有外部观察者，永远不会启用。 */
  private authoredPlaybackPaused = false;
  private authoredResumeTimeScale = 1;

  constructor(
    authoredEnabled = false,
    private readonly presentationOverlayOnly = false,
  ) {
    super();
    this.authoredEnabled = authoredEnabled;
    this.winningAdditiveRoot.name = "winning-symbol-additive-pass";
    this.winningAdditiveRoot.visible = false;
    this.winningAdditiveRoot.renderable = false;
    this.art.anchor.set(0.5);
    this.variantLabel.anchor.set(0.5);
    this.addChild(this.cellGlass, this.art, this.authoredLayer, this.variantLabel, this.scan);
  }

  /** 外部渲染通道节点；所有权仍归 SymbolView 所有。 */
  get winningAdditiveDisplay(): Container {
    return this.winningAdditiveRoot;
  }

  setSize(width: number, height: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
    this.redraw();
  }

  setCell(cell: GridCell, options: SymbolCellPresentationOptions = {}): void {
    this.currentCell = { ...cell };
    this.deferredWildVariant = cell.symbol === "WILD"
      && cell.multiplier !== undefined
      && options.deferWildVariant === true;
    this.forceLockedVault = cell.symbol === "VAULT"
      && options.forceLockedVault === true;
    this.highlighted = false;
    this.dimmed = false;
    this.dimProgress = 0;
    this.presentationTint = SYMBOL_FULL_COLOUR_TINT;
    this.tintFrom = SYMBOL_FULL_COLOUR_TINT;
    this.tintTarget = SYMBOL_FULL_COLOUR_TINT;
    this.tintTransitionActive = false;
    this.idleBlocked = false;
    this.featureHidden = false;
    this.additiveCompositeActive = false;
    this.additivePlaybackRunning = false;
    this.activeAdditiveAttachmentCount = 0;
    this.redraw();
    this.playRestingAnimation();
    this.resetDormantAdditivePass();
  }

  setAuthoredAnimationEnabled(active: boolean): void {
    if (this.authoredEnabled === active) return;
    this.authoredEnabled = active;
    this.redraw();
    this.playRestingAnimation();
  }

  /**
   * 冻结当前制作好的姿态，而不重建符号或轨道。这是确定性截图使用的观察接口；正常游戏逻辑绝不会调用，因此能够保留复刻时间点。
   */
  setAuthoredPlaybackPaused(active: boolean): void {
    if (this.authoredPlaybackPaused === active) return;
    this.authoredPlaybackPaused = active;
    const view = this.authoredView;
    if (!view) return;
    if (active) {
      this.authoredResumeTimeScale = view.state.timeScale;
      this.authoredPasses().forEach((pass) => {
        pass.state.timeScale = 0;
      });
      return;
    }
    this.authoredPasses().forEach((pass) => {
      pass.state.timeScale = this.authoredResumeTimeScale;
    });
  }

  setHighlighted(active: boolean): boolean {
    // 每条首秀中奖记录都会调用官方符号 `win()` 命令，包括当两个连续记录共享同一单元格时。清除是幂等的，但显式的活动命令必须重新启动轨道 0，
    // 而不是将该单元格冻结在前一个记录的终端位姿上。
    if (!active && this.highlighted === active) return true;
    this.highlighted = active;
    if (active) {
      const canComposite = this.currentCell.symbol !== "PRISM"
        && this.currentCell.symbol !== "ORBIT"
        && authoredSymbolWinAnimation(this.currentCell.symbol) !== null
        && Boolean(this.authoredView)
        && Boolean(this.authoredAdditiveView);
      if (canComposite) {
        if (!this.prepareDynamicAdditiveComposite("win")) return false;
      } else {
        this.suspendAdditiveComposite();
      }
      const played = this.playWinAnimation();
      if (!played) {
        this.suspendAdditiveComposite();
        this.resetDormantAdditivePass();
      }
      this.refreshAuthoredPassMaterials();
      this.syncWinningAdditiveDisplayTransform();
      return played;
    }
    this.additiveCompositeActive = false;
    this.additivePlaybackRunning = false;
    this.playRestingAnimation();
    this.resetDormantAdditivePass();
    this.refreshAuthoredPassMaterials();
    this.syncWinningAdditiveDisplayTransform();
    return true;
  }

  /**
   * 开始原始帧步进暗淡。除非普通的单记录 HOLD 拆卸明确选择恢复，否则清除将立即进行。
   */
  setDimmed(active: boolean, progressiveRestore = false): void {
    if (active) {
      if (this.dimmed) return;
      this.dimmed = true;
      this.startTintTransition(SYMBOL_DIMMED_TINT);
      return;
    }

    if (!this.dimmed
      && !this.tintTransitionActive
      && this.presentationTint === SYMBOL_FULL_COLOUR_TINT) return;
    this.dimmed = false;
    if (progressiveRestore) {
      if (this.tintTransitionActive && this.tintTarget === SYMBOL_FULL_COLOUR_TINT) return;
      this.startTintTransition(SYMBOL_FULL_COLOUR_TINT);
      return;
    }

    this.dimProgress = 0;
    this.presentationTint = SYMBOL_FULL_COLOUR_TINT;
    this.tintFrom = SYMBOL_FULL_COLOUR_TINT;
    this.tintTarget = SYMBOL_FULL_COLOUR_TINT;
    this.tintTransitionActive = false;
    this.applyPresentationTint();
  }

  /** 收集的 Rage 符号保留在网格中，但在替换之前被排除。 */
  setIdleBlocked(active: boolean): void {
    this.idleBlocked = active;
  }

  /** 经过权威的 Rage 收集后，将喷砂玻璃室留空。 */
  setFeatureHidden(active: boolean): void {
    if (this.featureHidden === active) return;
    this.featureHidden = active;
    this.applyContentVisibility();
  }

  get cell(): Readonly<GridCell> {
    return this.currentCell;
  }

  /** 用于确定性 Vault 屏幕截图的冻结纯数据投影。 */
  getVaultCaptureDiagnostics(): Readonly<SymbolVaultCaptureDiagnostics> {
    const track = (index: number): Readonly<SymbolSpineTrackCaptureDiagnostics> | null => {
      const entry = this.authoredView?.state.getCurrent(index);
      if (!entry) return null;
      return Object.freeze({
        animation: entry.animation?.name ?? null,
        trackTimeMs: entry.trackTime * 1_000,
        mixDuration: entry.mixDuration,
      });
    };
    return Object.freeze({
      cell: Object.freeze({ ...this.currentCell }),
      spineKey: this.authoredKey,
      track0: track(0),
      track1: track(1),
      paused: this.authoredPlaybackPaused,
    });
  }

  /**
   * 仅将此测试场景暂停的 Spine 提前指定的精确持续时间。正常的游戏逻辑永远不会调用此接口，并继续使用 Pixi 的股票驱动时钟。
   */
  advanceAuthoredPlaybackForCapture(deltaMs: number): void {
    const view = this.authoredView;
    if (!view || !this.authoredPlaybackPaused) return;
    const seconds = Math.max(0, deltaMs) / 1_000;
    this.forEachAuthoredPass((pass) => {
      const pausedScale = pass.state.timeScale;
      pass.state.timeScale = this.authoredResumeTimeScale;
      pass.update(seconds);
      pass.state.timeScale = pausedScale;
    });
    this.refreshAuthoredPassMaterials();
    this.syncWinningAdditiveDisplayTransform();
  }

  /**
   * 仅取消瞬时 Symbol8 主体覆盖。复制的目标单元将不加更改地重新应用，因此没有协议/结果字段可以保留该标志。
   */
  clearForcedLockedVaultPresentation(): boolean {
    if (!this.forceLockedVault) return false;
    this.setCell(this.currentCell);
    return true;
  }

  /** 捕获 Rage 预期：轨道 0 上的身体前奏/循环和轨道 1 上的眼睛。 */
  startRageAnticipationAnimation(): boolean {
    if (this.currentCell.symbol !== "SURGE") return false;
    if (!this.prepareDynamicAdditiveComposite("wait_in", "wait", "eye_loop")) return false;
    this.forEachAuthoredPass((view) => {
      const intro = view.state.setAnimation(0, "wait_in", false);
      intro.mixDuration = 0;
      const eyes = view.state.setAnimation(1, "eye_loop", true);
      eyes.mixDuration = 0;
      const loop = view.state.addAnimation(0, "wait", true, 0);
      loop.mixDuration = 0;
    });
    this.updateAuthoredPasses(0);
    return true;
  }

  /** 结束 Rage 预期，停止其眼睛层，然后返回停止姿势。 */
  endRageAnticipationAnimation(): boolean {
    if (this.currentCell.symbol !== "SURGE") return false;
    const restingAnimation = authoredSymbolRestAnimation(this.currentCell.symbol);
    if (!this.prepareDynamicAdditiveComposite("wait_out", restingAnimation)) return false;
    this.forEachAuthoredPass((view) => {
      const outro = view.state.setAnimation(0, "wait_out", false);
      outro.mixDuration = 0;
      view.state.clearTrack(1);
      const resting = view.state.addAnimation(0, restingAnimation, false, 0);
      resting.mixDuration = 0;
    });
    this.updateAuthoredPasses(0);
    return true;
  }

  playCollectAnimation(): boolean {
    if (this.currentCell.symbol !== "SURGE") return false;
    if (!this.prepareDynamicAdditiveComposite("collect", "hide")) return false;
    this.idleBlocked = true;
    this.forEachAuthoredPass((view) => {
      view.state.clearTrack(1);
      view.state.setAnimation(0, "collect", false);
      view.state.addAnimation(0, "hide", false, 0);
    });
    this.updateAuthoredPasses(0);
    return true;
  }

  playFeatureActivationAnimation(): boolean {
    if (this.currentCell.symbol !== "SURGE") return false;
    if (!this.prepareDynamicAdditiveComposite("feature_activation", "eye_loop")) return false;
    this.forEachAuthoredPass((view) => {
      const body = view.state.setAnimation(0, "feature_activation", false);
      body.mixDuration = 0;
      const eyes = view.state.setAnimation(1, "eye_loop", true);
      eyes.mixDuration = 0;
    });
    this.updateAuthoredPasses(0);
    return true;
  }

  /** 原始级联使用制作好的爆炸效果销毁每个非 Rage 格子。 */
  playExplosionAnimation(): boolean {
    if (this.currentCell.symbol === "SURGE") return false;
    if (!this.prepareDynamicAdditiveComposite("explosion")) return false;
    this.forEachAuthoredPass((view) => {
      view.state.setAnimation(0, "explosion", false);
    });
    this.updateAuthoredPasses(0);
    return true;
  }

  /** 每卷临时 Rage 叠加在最后一磅之前进入。 */
  playRageShowAnimation(): boolean {
    if (this.currentCell.symbol !== "SURGE") return false;
    if (!this.prepareDynamicAdditiveComposite("show")) return false;
    this.featureHidden = false;
    this.applyContentVisibility();
    this.forEachAuthoredPass((view) => {
      view.state.clearTracks();
      view.skeleton.setToSetupPose();
      view.state.setAnimation(0, "show", false);
    });
    this.updateAuthoredPasses(0);
    return true;
  }

  /** 最终的 Rage 激活始终将捕获的隐藏剪辑排队，从不空闲。 */
  playRageTriggerAnimation(): boolean {
    if (this.currentCell.symbol !== "SURGE") return false;
    if (!this.prepareDynamicAdditiveComposite("feature_activation", "hide")) {
      return false;
    }
    this.idleBlocked = true;
    this.featureHidden = false;
    this.applyContentVisibility();
    this.forEachAuthoredPass((view) => {
      view.state.clearTracks();
      view.skeleton.setToSetupPose();
      view.state.setAnimation(0, "feature_activation", false);
      view.state.addAnimation(0, "hide", false, 0);
    });
    this.updateAuthoredPasses(0);
    return true;
  }

  playVaultUnlockAnimation(): boolean {
    if (this.currentCell.symbol !== "VAULT") return false;
    if (!this.prepareDynamicAdditiveComposite("unlock_backup")) return false;
    this.forEachAuthoredPass((view) => {
      const unlock = view.state.setAnimation(0, "unlock_backup", false);
      unlock.mixDuration = 0;
    });
    this.updateAuthoredPasses(0);
    return true;
  }

  playVaultFreeSpinActivationAnimation(): boolean {
    const animation = authoredVaultFreeSpinActivation(this.currentCell);
    if (!animation) return false;
    if (!this.prepareDynamicAdditiveComposite(animation)) return false;
    this.forEachAuthoredPass((view) => {
      view.state.clearTrack(0);
      const activation = view.state.setAnimation(0, animation, false);
      activation.mixDuration = 0;
      this.queueRestingAnimation(view);
      this.applyVariantTrack(view);
    });
    this.updateAuthoredPasses(0);
    return true;
  }

  /** 捕获的 Vault 预期：tease_in → tease_loop → tease_out，无混合。 */
  playVaultTeaseAnimation(): boolean {
    if (this.currentCell.symbol !== "VAULT") return false;
    if (!this.prepareDynamicAdditiveComposite("tease_in", "tease_loop", "tease_out")) {
      return false;
    }
    this.forEachAuthoredPass((view) => {
      view.state.clearTrack(0);
      const intro = view.state.setAnimation(0, "tease_in", false);
      intro.mixDuration = 0;
      const loop = view.state.addAnimation(0, "tease_loop", false, 0);
      loop.mixDuration = 0;
      const outro = view.state.addAnimation(0, "tease_out", false, 0);
      outro.mixDuration = 0;
      this.applyVariantTrack(view);
    });
    this.updateAuthoredPasses(0);
    return true;
  }

  /** 原始跳过仅将 tease_out 加速到 1.25×。 */
  skipVaultTeaseAnimation(): boolean {
    if (this.currentCell.symbol !== "VAULT") return false;
    if (!this.prepareDynamicAdditiveComposite("tease_out")) return false;
    this.forEachAuthoredPass((view) => {
      view.state.clearTrack(0);
      const outro = view.state.setAnimation(0, "tease_out", false);
      outro.mixDuration = 0;
      outro.timeScale = 1.25;
      this.applyVariantTrack(view);
    });
    this.updateAuthoredPasses(0);
    return true;
  }

  playVaultUpgradeAnimation(): boolean {
    if (this.currentCell.symbol !== "VAULT") return false;
    const needsDoubleGlow = this.currentCell.prize?.toLowerCase().endsWith("_2x") === true;
    if (!this.prepareDynamicAdditiveComposite(
      "upgrade",
      ...(needsDoubleGlow ? ["2x_glow"] : []),
    )) return false;
    this.forEachAuthoredPass((view) => {
      view.state.setAnimation(0, "upgrade", false);
      this.queueRestingAnimation(view);
      this.applyVariantTrack(view);
      if (needsDoubleGlow) view.state.setAnimation(2, "2x_glow", false);
    });
    this.updateAuthoredPasses(0);
    return true;
  }

  playVaultWinAnimation(): boolean {
    if (this.currentCell.symbol !== "VAULT") return false;
    if (!this.prepareDynamicAdditiveComposite("win")) return false;
    this.forEachAuthoredPass((view) => {
      view.state.setAnimation(0, "win", false);
      this.queueRestingAnimation(view);
      this.applyVariantTrack(view);
    });
    this.updateAuthoredPasses(0);
    return true;
  }

  /** 当最后一个卷轴进入其单元格时，会播放原始的停止动画。 */
  playLandAnimation(mode: ReelStopMode = "NORMAL"): boolean {
    const variant = authoredCellVariantAnimation(this.currentCell);
    const revealsWild = this.currentCell.symbol === "WILD"
      && this.currentCell.multiplier !== undefined
      && variant !== null;
    // FAST/SLOW 抑制通用地，但 GameSymbol.wildLand() 在显示之前仍然拥有其精确的半秒普通 Wild 门。
    if (mode !== "NORMAL" && !revealsWild) return true;
    if (!this.authoredView) return false;
    const requiredAnimations = [
      ...(mode === "NORMAL" ? ["land"] : []),
      ...(revealsWild && variant ? ["reveal", variant] : []),
    ];
    if (!this.prepareDynamicAdditiveComposite(...requiredAnimations)) return false;
    this.forEachAuthoredPass((view) => {
      if (mode === "NORMAL") {
        const land = view.state.setAnimation(0, "land", false);
        land.mixDuration = 0;
      }
      if (revealsWild) {
        view.state.clearTrack(1);
        const reveal = view.state.addAnimation(0, "reveal", false, 0.5);
        reveal.mixDuration = 0;
        const value = view.state.addAnimation(1, variant!, false, 0.5);
        value.mixDuration = 0;
      } else {
        this.queueRestingAnimation(view);
        this.applyVariantTrack(view);
      }
    });
    if (revealsWild) {
      this.deferredWildVariant = false;
    }
    this.updateAuthoredPasses(0);
    return true;
  }

  /** 控制器对每个可见单元格进行洗牌后使用的资格。 */
  canPlayIdleAnimation(): boolean {
    const view = this.authoredView;
    return !this.highlighted
      && !this.dimmed
      && !this.idleBlocked
      && authoredCellIdleAnimation(this.currentCell) === "idle"
      && Boolean(view?.state.hasAnimation("idle"));
  }

  /** 只播放一个空闲剪辑，与 GameIdleController.playIdle() 匹配。 */
  playIdleAnimation(): boolean {
    if (!this.canPlayIdleAnimation()
      || !this.prepareDynamicAdditiveComposite("idle")) return false;
    this.forEachAuthoredPass((view) => {
      view.state.setAnimation(0, "idle", false);
      this.applyVariantTrack(view);
    });
    this.updateAuthoredPasses(0);
    return true;
  }

  update(deltaMs: number): void {
    if (this.tintTransitionActive) {
      const step = nextSymbolTintStep(this.dimProgress, this.tintFrom, this.tintTarget);
      this.dimProgress = step.progress;
      this.presentationTint = step.tint;
      if (step.complete) this.tintTransitionActive = false;
      this.applyPresentationTint();
    }
    this.updateAuthoredPasses(Math.min(64, Math.max(0, deltaMs)) / 1_000);
    this.syncWinningAdditiveDisplayTransform();
  }

  private startTintTransition(targetTint: number): void {
    this.dimProgress = 0;
    this.tintFrom = this.presentationTint;
    this.tintTarget = targetTint;
    this.tintTransitionActive = this.presentationTint !== targetTint;
  }

  private redraw(): void {
    const width = this.viewWidth;
    const height = this.viewHeight;
    const glow = SYMBOL_GLOW[this.currentCell.symbol];
    this.cellGlass.clear();
    this.scan.clear();

    this.cellGlass.beginFill(0x181817, 0.43).drawRect(0, 0, width, height).endFill();
    this.cellGlass.beginFill(0x060707, 0.24).drawRect(2, 2, width - 4, height - 4).endFill();
    this.cellGlass.lineStyle(1, 0xd8d4cb, 0.12).moveTo(4, 2).lineTo(width - 5, 2);
    this.cellGlass.lineStyle(1, 0x020202, 0.76).moveTo(3, height - 2).lineTo(width - 3, height - 2);

    // 非常微弱的玻璃划痕仅保留在静态回退路径艺术品后面。
    this.scan.lineStyle(1, 0x9da09b, 0.07);
    this.scan.moveTo(width * 0.12, height * 0.17).lineTo(width * 0.48, height * 0.58);
    this.scan.moveTo(width * 0.72, height * 0.08).lineTo(width * 0.42, height * 0.36);
    this.scan.lineStyle(2, glow, this.currentCell.symbol === "SURGE" ? 0.14 : 0.035);
    this.scan.moveTo(7, height - 5).lineTo(width - 7, height - 5);

    const textureCell = this.deferredWildVariant
      ? ({ symbol: "WILD" } as const)
      : this.currentCell;
    const texture = textureFor(textureCell);
    this.art.texture = texture;
    this.art.position.set(width / 2, height / 2);
    this.art.alpha = texture === Texture.EMPTY ? 0 : 1;
    if (texture !== Texture.EMPTY) {
      const sourceWidth = Math.max(1, texture.orig.width);
      const sourceHeight = Math.max(1, texture.orig.height);
      const padding = this.currentCell.symbol === "SURGE" ? 0.96 : 0.9;
      const scale = Math.min(width * padding / sourceWidth, height * padding / sourceHeight);
      this.art.width = sourceWidth * scale;
      this.art.height = sourceHeight * scale;
    }

    this.syncAuthoredView();
    this.layoutAuthoredView();
    this.applyPresentationTint();
    this.layoutVariantLabel();
    this.applyContentVisibility();
  }

  private syncAuthoredView(): void {
    const nextKey = authoredSymbolSpineKeyForPresentation(
      this.currentCell,
      this.forceLockedVault,
    );
    const nextData = this.authoredEnabled ? authoredSymbolData.get(nextKey) : undefined;
    if (nextData
      && this.authoredView
      && this.authoredAdditiveView
      && this.authoredKey === nextKey) return;

    if (this.authoredView) {
      this.authoredLayer.removeChild(this.authoredView);
      this.authoredView.destroy({ children: true, texture: false, baseTexture: false });
      this.authoredView = null;
    }
    if (this.authoredAdditiveView) {
      this.winningAdditiveRoot.removeChild(this.authoredAdditiveView);
      this.authoredAdditiveView.destroy({ children: true, texture: false, baseTexture: false });
      this.authoredAdditiveView = null;
    }
    this.authoredKey = null;
    this.additiveCompositeActive = false;
    this.additivePlaybackRunning = false;
    this.activeAdditiveAttachmentCount = 0;
    this.winningAdditiveRoot.visible = false;
    this.winningAdditiveRoot.renderable = false;
    if (!nextData) return;

    const view = createSpineView(nextData);
    const additiveView = createSpineView(nextData);
    view.autoUpdate = false;
    additiveView.autoUpdate = false;
    if (this.authoredPlaybackPaused) {
      this.authoredResumeTimeScale = view.state.timeScale;
      view.state.timeScale = 0;
      additiveView.state.timeScale = 0;
    }
    this.authoredLayer.addChild(view);
    this.winningAdditiveRoot.addChild(additiveView);
    this.authoredView = view;
    this.authoredAdditiveView = additiveView;
    this.authoredKey = nextKey;
    this.applyPresentationTint();
    this.playRestingAnimation();
    this.resetDormantAdditivePass();
  }

  private applyPresentationTint(): void {
    this.art.tint = this.presentationTint;
    if (this.authoredView) this.authoredView.tint = this.presentationTint;
    if (this.authoredAdditiveView) this.authoredAdditiveView.tint = this.presentationTint;
  }

  private layoutAuthoredView(): void {
    this.authoredPasses().forEach((view) => {
      view.position.set(this.viewWidth / 2, this.viewHeight / 2);
      view.scale.set(
        this.viewWidth / AUTHORED_SYMBOL_WIDTH,
        this.viewHeight / AUTHORED_SYMBOL_HEIGHT,
      );
    });
    this.syncWinningAdditiveDisplayTransform();
  }

  private layoutVariantLabel(): void {
    this.variantLabel.text = cellVariantFallbackLabel(this.presentationCell()) ?? "";
    this.variantLabel.position.set(this.viewWidth / 2, this.viewHeight * 0.72);
    this.variantLabel.style.fontSize = Math.max(12, Math.min(21, this.viewHeight * 0.19));
  }

  private applyContentVisibility(): void {
    const visibility = symbolContentVisibility(
      this.authoredView !== null,
      this.featureHidden,
      this.presentationOverlayOnly,
    );
    this.authoredLayer.visible = visibility.authoredLayer;
    // Rage 提取只隐藏第 3 层符号内容。机台已在此视图下方提供稳定的转轴玻璃；若露出回退底板，会产生新的暗色块并错误染色背景。
    this.cellGlass.visible = visibility.cellGlass;
    this.art.visible = visibility.staticArt;
    this.scan.visible = visibility.scan;
    const variant = authoredCellVariantAnimation(this.presentationCell());
    const authoredVariant = Boolean(variant && this.authoredView?.state.hasAnimation(variant));
    const staticWildVariant = this.currentCell.symbol === "WILD"
      && this.currentCell.multiplier !== undefined
      && STATIC_WILD_MULTIPLIERS.has(this.currentCell.multiplier);
    this.variantLabel.visible = !this.presentationOverlayOnly
      && !this.featureHidden
      && !this.deferredWildVariant
      && this.variantLabel.text.length > 0
      && !authoredVariant
      && !staticWildVariant;
    this.syncWinningAdditiveDisplayTransform();
  }

  private playWinAnimation(): boolean {
    const animation = authoredSymbolWinAnimation(this.currentCell.symbol);
    // 特意突出显示纯功能符号，没有支付线剪辑；这不是缺少必需的动画。
    if (!animation) return true;
    if (!this.authoredPassesHaveAnimations(animation)) return false;
    this.forEachAuthoredPass((view) => {
      view.state.setAnimation(0, animation, false);
      this.applyVariantTrack(view);
    });
    this.updateAuthoredPasses(0);
    return true;
  }

  private playRestingAnimation(): void {
    const animation = authoredSymbolRestAnimation(this.currentCell.symbol);
    if (!this.authoredPassesHaveAnimations(animation)) return;
    this.forEachAuthoredPass((view) => {
      view.state.clearTracks();
      view.skeleton.setToSetupPose();
      view.state.setAnimation(0, animation, false);
      this.applyVariantTrack(view);
    });
    this.updateAuthoredPasses(0);
  }

  private queueRestingAnimation(view: Spine): void {
    const animation = authoredSymbolRestAnimation(this.currentCell.symbol);
    if (view.state.hasAnimation(animation)) {
      view.state.addAnimation(0, animation, false, 0);
    }
  }

  private applyVariantTrack(view: Spine): void {
    const animation = this.deferredWildVariant
      ? "x_nomulti"
      : authoredCellVariantAnimation(this.presentationCell());
    if (!animation) return;
    if (view.state.hasAnimation(animation)) {
      const value = view.state.setAnimation(1, animation, false);
      value.mixDuration = 0;
    }
  }

  private presentationCell(): GridCell {
    return this.forceLockedVault
      ? lockedVaultPresentationCell(this.currentCell)
      : this.currentCell;
  }

  private authoredPasses(): readonly Spine[] {
    const passes: Spine[] = [];
    if (this.authoredView) passes.push(this.authoredView);
    if (this.authoredAdditiveView) passes.push(this.authoredAdditiveView);
    return passes;
  }

  private forEachAuthoredPass(callback: (view: Spine) => void): void {
    const view = this.authoredView;
    if (view) callback(view);
    if (this.additiveCompositeActive && this.authoredAdditiveView) {
      callback(this.authoredAdditiveView);
    }
  }

  private authoredPassesHaveAnimations(...animations: readonly string[]): boolean {
    const passes = [
      this.authoredView,
      ...(this.additiveCompositeActive ? [this.authoredAdditiveView] : []),
    ].filter((view): view is Spine => Boolean(view));
    return passes.length > 0 && passes.every((view) => (
      animations.every((animation) => view.state.hasAnimation(animation))
    ));
  }

  private updateAuthoredPasses(deltaSeconds: number): void {
    const safeDelta = Math.max(0, deltaSeconds);
    this.authoredView?.update(safeDelta);
    if (this.additiveCompositeActive
      && this.additivePlaybackRunning
      && this.authoredAdditiveView) {
      this.authoredAdditiveView.update(safeDelta);
    }
    this.refreshAuthoredPassMaterials();
    if (this.additivePlaybackRunning && this.additiveTracksAreSettled()) {
      this.additivePlaybackRunning = false;
    }
  }

  /** 附件交换发生在 Spine.update 内部，因此之后进行分区。 */
  private refreshAuthoredPassMaterials(): void {
    enforcePrimalRegionBlendModes(this.authoredView);
    // 切勿将不透明的黑色为零 ADD 附件放回卷轴的屏幕外透视滤镜下方。即使一条忘记启动外部孪生的路径也一定会失败，因为缺少辉光，而不是黑色矩形。
    partitionPrimalAdditiveSlots(this.authoredView, "normal");
    if (this.additiveCompositeActive) {
      this.syncAuthoredPassPresentation();
      enforcePrimalRegionBlendModes(this.authoredAdditiveView);
      this.activeAdditiveAttachmentCount = partitionPrimalAdditiveSlots(
        this.authoredAdditiveView,
        "additive",
      );
    } else {
      this.activeAdditiveAttachmentCount = 0;
    }
    this.syncWinningAdditiveDisplayTransform();
  }

  private syncAuthoredPassPresentation(): void {
    const source = this.authoredView;
    const target = this.authoredAdditiveView;
    if (!source || !target) return;
    target.position.copyFrom(source.position);
    target.scale.copyFrom(source.scale);
    target.pivot.copyFrom(source.pivot);
    target.skew.copyFrom(source.skew);
    target.rotation = source.rotation;
    target.alpha = source.alpha;
    target.visible = source.visible;
    target.renderable = source.renderable;
    target.tint = source.tint;
  }

  /**
   * 在第一个动态命令之前将两个实例置于精确的冻结 `stop + value` 原点。
   * 如果休眠双胞胎在稍后的空闲/着陆/显示、爆炸、Rage、Vault 或 WIN 剪辑之前最后重置，则从一个规范设置开始可以避免 150ms 混合链不匹配。
   */
  private primeAdditiveCompositePasses(): boolean {
    const source = this.authoredView;
    const target = this.authoredAdditiveView;
    if (!source || !target) return false;
    const resting = authoredSymbolRestAnimation(this.currentCell.symbol);
    if (!source.state.hasAnimation(resting) || !target.state.hasAnimation(resting)) return false;
    const timeScale = source.state.timeScale;
    for (const view of [source, target]) {
      view.state.clearTracks();
      view.skeleton.setToSetupPose();
      view.state.timeScale = timeScale;
      view.state.setAnimation(0, resting, false);
      this.applyVariantTrack(view);
      view.update(0);
    }
    return true;
  }

  /**
   * 为每个预设的动态剪辑（而不仅仅是 WIN）启动 Pixi-6 兼容性通道。已经激活的通道保留其确切的先前终端/排队姿势，
   * 这是 Wild 显示和 Rage/Vault 多步流所需要的。
   */
  private prepareDynamicAdditiveComposite(...animations: readonly string[]): boolean {
    const source = this.authoredView;
    const target = this.authoredAdditiveView;
    if (!source || !animations.every((animation) => source.state.hasAnimation(animation))) {
      return false;
    }
    // 独立的回退路径或格子调用方可能只提供一个制作好的实例。NORMAL 在此降级路径中保持安全隔离；生产预加载始终创建配对的外部 ADD 实例。
    if (!target) return true;
    if (!animations.every((animation) => target.state.hasAnimation(animation))) return false;
    if (!this.additiveCompositeActive && !this.primeAdditiveCompositePasses()) return false;
    this.additiveCompositeActive = true;
    this.additivePlaybackRunning = true;
    return true;
  }

  /** 停止外部时钟/根，而不恢复过滤器下面的 ADD。 */
  private suspendAdditiveComposite(): void {
    this.additiveCompositeActive = false;
    this.additivePlaybackRunning = false;
    this.activeAdditiveAttachmentCount = 0;
    this.syncWinningAdditiveDisplayTransform();
  }

  /**
   * 最终姿势在视觉上仍由外部通道拥有，但一旦每个预设的轨道稳定，就不会提前第二个 Spine 时钟。
   */
  private additiveTracksAreSettled(): boolean {
    const tracks = this.authoredAdditiveView?.state.tracks as readonly ({
      readonly loop: boolean;
      readonly next: unknown | null;
      readonly mixingFrom: unknown | null;
      isComplete(): boolean;
    } | null)[] | undefined;
    if (!tracks) return false;
    return tracks.every((entry) => !entry || (
      !entry.loop
      && entry.next === null
      && entry.mixingFrom === null
      && entry.isComplete()
    ));
  }

  /** 一次性拆解；之后，休眠双胞胎不进行任何帧工作。 */
  private resetDormantAdditivePass(): void {
    const view = this.authoredAdditiveView;
    if (!view) return;
    view.state.clearTracks();
    view.skeleton.setToSetupPose();
    const resting = authoredSymbolRestAnimation(this.currentCell.symbol);
    if (view.state.hasAnimation(resting)) view.state.setAnimation(0, resting, false);
    this.applyVariantTrack(view);
    view.update(0);
    enforcePrimalRegionBlendModes(view);
    this.activeAdditiveAttachmentCount = partitionPrimalAdditiveSlots(view, "additive");
    // 一些官方停止/值姿势已经包含 ADD 材质（例如头盔绳灯）。将冻结的姿势保持在滤镜之外。
    this.additiveCompositeActive = this.activeAdditiveAttachmentCount > 0;
    this.additivePlaybackRunning = false;
    this.syncWinningAdditiveDisplayTransform();
  }

  /** 将已确定的 SymbolView 变换镜像到其外部渲染通道。 */
  syncWinningAdditiveDisplayTransform(): void {
    const root = this.winningAdditiveRoot;
    // 少数隔离单元线束通过其原型构建 SymbolView 来执行状态逻辑，而无需分配 Pixi 容器。
    if (!root) return;
    root.position.copyFrom(this.position);
    root.scale.copyFrom(this.scale);
    root.pivot.copyFrom(this.pivot);
    root.skew.copyFrom(this.skew);
    root.rotation = this.rotation;
    root.alpha = this.alpha;
    root.visible = this.additiveCompositeActive
      && this.activeAdditiveAttachmentCount > 0
      && this.authoredAdditiveView !== null
      && this.authoredLayer.visible
      && this.visible;
    root.renderable = root.visible && this.renderable;
  }

  override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    const root = this.winningAdditiveRoot;
    if (root && !root.destroyed) {
      root.parent?.removeChild(root);
      root.destroy({
        children: true,
        texture: false,
        baseTexture: false,
      });
    }
    this.authoredAdditiveView = null;
    super.destroy(options);
  }
}
