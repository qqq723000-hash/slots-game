import { BLEND_MODES, Container, Graphics, Point, Rectangle, Text, TextStyle } from "pixi.js";
import type {
  CellAddress,
  FeatureEvent,
  FeatureMode,
  GridCell,
  VaultAwardedEvent,
  VaultUnlockedEvent,
  VaultUpgradedEvent,
} from "../app/state/types";
import type { SpinEnvironmentFrame } from "../renderer/spinEnvironmentMotion";
import type { VisualTelemetryReporter } from "../renderer/VisualTelemetry";
import type {
  MobileLayoutProfile,
  ResponsiveRendererRegion,
} from "../renderer/ResponsiveLayout";
import {
  createSpineView,
  enforcePrimalRegionBlendModes,
  partitionPrimalAdditiveSlots,
  type Spine,
} from "../renderer/spine/SpineAdapter";
import { loadPrimalSpineData } from "../renderer/spine/PrimalSpineAssets";
import {
  sampleBrushedSteel,
  sampleEdgeWear,
  sampleScratches,
  type SurfaceDirection,
} from "../renderer/surfaceMaterial";
import { LOGICAL_WIDTH } from "../renderer/theme";
import {
  ReelView,
  type AuthoredPlaybackBatchResult,
  type ReelVaultCaptureDiagnostics,
  type ReelViewportCompositionDiagnostics,
  type ReelViewPreloadOptions,
} from "./ReelView";
import {
  ReelPerspectiveFilter,
  type ReelPerspectiveFilterDiagnostics,
} from "./ReelPerspectiveFilter";
import {
  PrimalSymbolIdleTimer,
  primalSymbolIdleOrder,
  primalSymbolIdleShouldRun,
} from "./primalAnimationTiming";
import type { ReelStopMode } from "./reelMotion";
import type { PostStopActivationPlan } from "./StopSequencer";

// 在 1280x720 CSS 坐标域中捕获的 ReelSizeAnimator 结果。官方 DPR2 运行时在其双倍回退路径空间场景中存储与 1.14 相同的变换；
// 本地 Pixi 使用逻辑坐标，因此两者在屏幕上的比例都是 0.57。框架子节点单独保留制作好的 1.01 倍缩放。
const AUTHORED_FRAME_SCALE = 1.01;
const BASE_REEL_ROOT_SCALE = 0.57;
const BASE_REEL_PARENT_SCALE_X = BASE_REEL_ROOT_SCALE;
const BASE_REEL_PARENT_SCALE_Y = BASE_REEL_ROOT_SCALE;
const BASE_AUTHORED_FRAME_SCALE_X = BASE_REEL_PARENT_SCALE_X * AUTHORED_FRAME_SCALE;
const BASE_AUTHORED_FRAME_SCALE_Y = BASE_REEL_PARENT_SCALE_Y * AUTHORED_FRAME_SCALE;
const SOURCE_REEL_WIDTH = 240;
const SOURCE_REEL_HEIGHT = 160;
const SOURCE_REEL_GAP = 9;
const SOURCE_REEL_PITCH = SOURCE_REEL_WIDTH + SOURCE_REEL_GAP;
const SOURCE_REEL_UNION_WIDTH = SOURCE_REEL_PITCH * 3;
const AUTHORED_REEL_PIVOT_Y = 239.67;
const AUTHORED_REEL_HALF_BASE_HEIGHT = SOURCE_REEL_HEIGHT * 1.5;
const AUTHORED_PIVOT_CORRECTION_Y = AUTHORED_REEL_HALF_BASE_HEIGHT - AUTHORED_REEL_PIVOT_Y;
const BASE_ADAPTED_REEL_TOP = 266.4;
export const REEL_AREA_WIDTH = SOURCE_REEL_UNION_WIDTH * BASE_REEL_PARENT_SCALE_X;
/** 固定自适应调整大小后的原始三排柜高度。 */
export const REEL_AREA_HEIGHT = 3 * SOURCE_REEL_HEIGHT * BASE_REEL_PARENT_SCALE_Y;
export const REEL_STAGE_X = (1_280 - REEL_AREA_WIDTH) / 2;
export const REEL_STAGE_Y = BASE_ADAPTED_REEL_TOP
  + AUTHORED_PIVOT_CORRECTION_Y * BASE_REEL_PARENT_SCALE_Y;
const REEL_GAP = 0;
const BASE_ROW_COUNT = 3;
const MAX_ROW_COUNT = 8;
const DESKTOP_STAGE_SCALE = 0.8;
const EXPANDED_STAGE_HEIGHT = 403.2;
const EXPANDED_ADAPTED_REEL_TOP = 136.8;
const EXPANDED_SOURCE_SCALE_NUMERATOR = 3.15;
const AUTHORED_FRAME_SOURCE_CENTER_Y = 240;
export const REEL_SET_LAYER_NAMES = Object.freeze({
  tracks: "layer-1-game-background-and-reel-tracks",
  symbols: "layer-2-masked-symbols-and-track-shadows",
  middle: "layer-3-middle-reel-chain-frame",
  outer: "layer-4-main-ui-metal-frame",
} as const);

export const REEL_WIN_LAYER_NAMES = Object.freeze({
  frames: "win-frame-overlay",
  activated: "activated-symbol-overlay",
} as const);

/** 正式中标-Wild activatedOverlay住宅。 */
export const PRIMAL_WINNING_WILD_ACTIVATED_MS = 1_000;

export const REEL_COMPOSITE_ROOT_NAME = "official-reel-composite-root";
export const REEL_ADDITIVE_FRAME_OVERLAY_NAME = "authored-reel-frame-additive-overlay";
export const REEL_WINNING_SYMBOL_ADDITIVE_OVERLAY_NAME = "winningSymbolAdditiveOverlay";

/** 回退路径层保留其语义名称；预设模式使用符号下方的一帧。 */
export const REEL_SET_DRAW_ORDER = Object.freeze([
  REEL_SET_LAYER_NAMES.tracks,
  REEL_SET_LAYER_NAMES.symbols,
  REEL_SET_LAYER_NAMES.outer,
  REEL_SET_LAYER_NAMES.middle,
] as const);

export const REEL_HARDWARE_NODE_NAMES = Object.freeze({
  fallbackOuter: "fallback-main-ui-metal-frame",
  middleShadow: "middle-reel-chain-drop-shadow",
  fallbackMiddle: "fallback-middle-reel-chain-frame",
} as const);

/**
 * 仅覆盖固定/非权威网格的瞬时渲染器。它们故意保留在 GridCell 和 SpinResult 之外，因此本地内阁着装姿势不会被误认为是后端游戏状态。
 */
export interface ReelGridPresentationOptions {
  /** 保留锁定的 Symbol8 主体的地址，同时显示其价值姿势。 */
  readonly forceLockedVaultCells?: readonly CellAddress[];
}

type NamedContainer = Container & { name: string };

function namedContainer(name: string): NamedContainer {
  const container = new Container() as NamedContainer;
  container.name = name;
  return container;
}

/**
 * ReelSetView 拥有这些节点，即使 PixiRenderer 将它们安装为场景同级节点。因此，在卷轴已经释放它们之后，父拆卸可以再次遇到它们；
 * 让那一秒销毁一个明确的无操作。
 */
class ReelExternalOverlay extends Container {
  override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    if (this.destroyed) return;
    super.destroy(options);
  }
}

function namedExternalOverlay(name: string): NamedContainer {
  const container = new ReelExternalOverlay() as NamedContainer;
  container.name = name;
  return container;
}

function deepFreezePlain<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezePlain(child);
  return Object.freeze(value);
}

export interface ReelResponsiveProjection {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/**
 * 外部不透明 ADD 悬念通道使用的普通实时投影。该效果仍是渲染器的同级节点，但所有空间参数都来自与原生机台相同的 ReelSetView 层级和滤镜目标。
 */
export interface ReelAnticipationHostProjection {
  readonly host: Readonly<{
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
    pivotX: number;
    pivotY: number;
    skewX: number;
    skewY: number;
    rotation: number;
    alpha: number;
    visible: boolean;
    renderable: boolean;
  }>;
  readonly source: Readonly<{
    centreX: number;
    centreY: number;
    scaleX: number;
    scaleY: number;
    motionX: number;
    motionY: number;
  }>;
  readonly filterArea: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  readonly perspectiveResolution: number;
}

export interface ReelPerspectiveDiagnostics extends ReelPerspectiveFilterDiagnostics {
  readonly attached: boolean;
  readonly enabled: boolean;
  readonly autoFit: boolean;
  readonly padding: number;
  readonly resolution: number;
  readonly resolutions: Readonly<{
    normal: number;
    additiveFrame: number;
    winningSymbolAdditive: number;
  }>;
  readonly targetBounds: Readonly<{ x: number; y: number; width: number; height: number }>;
}

export interface ReelCabinetFrameDiagnostics {
  readonly parentName: string | null;
  readonly parentChildIndex: number | null;
  readonly position: Readonly<{ x: number; y: number }>;
  readonly scale: Readonly<{ x: number; y: number }>;
  readonly pivot: Readonly<{ x: number; y: number }>;
  readonly rotation: number;
  readonly alpha: number;
  readonly visible: boolean;
  readonly renderable: boolean;
  readonly animation: Readonly<{
    name: string;
    loop: boolean;
    trackTime: number;
  }> | null;
}

export interface ReelCabinetCompositionDiagnostics {
  readonly activeRows: number;
  readonly frameMode: "authored" | "fallback";
  readonly transform: Readonly<{
    localPosition: Readonly<{ x: number; y: number }>;
    localScale: Readonly<{ x: number; y: number }>;
    worldPosition: Readonly<{ x: number; y: number }>;
    worldScale: Readonly<{ x: number; y: number }>;
  }>;
  readonly reelMotionRoot: Readonly<{
    name: string;
    orderedChildNames: readonly string[];
  }>;
  readonly frameInstances: Readonly<{
    normalInComposite: number;
    additiveInExternalOverlay: number;
  }>;
  readonly normalFrame: Readonly<ReelCabinetFrameDiagnostics> | null;
  readonly additiveFrame: Readonly<ReelCabinetFrameDiagnostics> | null;
  readonly reels: readonly Readonly<ReelViewportCompositionDiagnostics>[];
  readonly perspective: Readonly<{
    attached: boolean;
    enabled: boolean;
    autoFit: boolean;
    appliedFrames: number;
    resolution: number;
    resolutions: Readonly<{
      normal: number;
      additiveFrame: number;
      winningSymbolAdditive: number;
    }>;
    angle: readonly [number, number];
    effectiveDepth: number;
    sourceFrame: Readonly<{ x: number; y: number; width: number; height: number }> | null;
    targetBounds: Readonly<{ x: number; y: number; width: number; height: number }>;
  }>;
}

function cabinetFrameDiagnostics(
  frame: Spine | null,
): ReelCabinetFrameDiagnostics | null {
  if (!frame) return null;
  const current = frame.state.getCurrent(0);
  const parent = frame.parent;
  return {
    parentName: parent?.name ?? null,
    parentChildIndex: parent ? parent.getChildIndex(frame) : null,
    position: { x: frame.position.x, y: frame.position.y },
    scale: { x: frame.scale.x, y: frame.scale.y },
    pivot: { x: frame.pivot.x, y: frame.pivot.y },
    rotation: frame.rotation,
    alpha: frame.alpha,
    visible: frame.visible,
    renderable: frame.renderable,
    animation: current?.animation
      ? {
          name: current.animation.name,
          loop: current.loop,
          trackTime: current.trackTime,
        }
      : null,
  };
}

interface ReelAnchorSpec {
  readonly minBound: readonly [left: number, top: number, width: number, height: number];
  readonly align: readonly [horizontal: number, vertical: number];
}

const MOBILE_REEL_LAYOUTS: Readonly<Record<MobileLayoutProfile, {
  readonly middleLeft: ReelAnchorSpec;
  readonly bottomRight: ReelAnchorSpec;
}>> = Object.freeze({
  pt: Object.freeze({
    middleLeft: Object.freeze({ minBound: [-100, 0, 1_600, 0] as const, align: [0, 0.36] as const }),
    bottomRight: Object.freeze({ minBound: [-1_500, 0, 1_600, 0] as const, align: [1, 0.63] as const }),
  }),
  iPad_pt: Object.freeze({
    middleLeft: Object.freeze({ minBound: [-200, 0, 1_600, 0] as const, align: [0, 0.32] as const }),
    bottomRight: Object.freeze({ minBound: [-1_400, 0, 1_600, 0] as const, align: [1, 0.61] as const }),
  }),
  ls: Object.freeze({
    middleLeft: Object.freeze({ minBound: [-450, 0, 1_600, 0] as const, align: [0, 0.30] as const }),
    bottomRight: Object.freeze({ minBound: [-1_150, 0, 1_600, 0] as const, align: [1, 0.75] as const }),
  }),
});

function resolveReelAnchor(
  region: ResponsiveRendererRegion,
  spec: ReelAnchorSpec,
): ReelResponsiveProjection {
  const [left, top, width, height] = spec.minBound;
  const [horizontal, vertical] = spec.align;
  const constraints: number[] = [];
  if (width > 0) constraints.push(region.width / width);
  if (height > 0) constraints.push(region.height / height);
  const scale = constraints.length > 0 ? Math.min(...constraints) : 1;
  return {
    x: region.left - left * scale
      + horizontal * (region.width - width * scale),
    y: region.top - top * scale
      + vertical * (region.height - height * scale),
    scale,
  };
}

/** 来自捕获的移动布局配置的精确 Base 卷轴锚点投影。 */
export function mobileReelProjection(
  region: ResponsiveRendererRegion,
  profile: MobileLayoutProfile,
): ReelResponsiveProjection {
  const layout = MOBILE_REEL_LAYOUTS[profile];
  const middleLeft = resolveReelAnchor(region, layout.middleLeft);
  const bottomRight = resolveReelAnchor(region, layout.bottomRight);
  const adaptedWidth = bottomRight.x - middleLeft.x;
  const adaptedHeight = bottomRight.y - middleLeft.y;
  const rootScale = Math.max(0, Math.min(
    adaptedWidth / SOURCE_REEL_UNION_WIDTH,
    adaptedHeight / (BASE_ROW_COUNT * SOURCE_REEL_HEIGHT),
  ));
  return {
    x: middleLeft.x + (adaptedWidth - SOURCE_REEL_UNION_WIDTH * rootScale) / 2,
    y: bottomRight.y
      - (AUTHORED_REEL_HALF_BASE_HEIGHT + AUTHORED_REEL_PIVOT_Y) * rootScale,
    // ReelSetView 几何体已包含捕获的桌面 0.57 比例。
    scale: rootScale / BASE_REEL_ROOT_SCALE,
  };
}

/** 桌面 ReelSizeAnimator 已解析最终的 1280x720 比例。 */
export function responsiveReelCompositionScale(_characterScale: number): number {
  return 1;
}

export const REEL_CELL_HEIGHT = REEL_AREA_HEIGHT / BASE_ROW_COUNT;
export const REEL_STAGE_BOTTOM = REEL_STAGE_Y + REEL_AREA_HEIGHT;

export interface ReelLayoutGeometry {
  readonly rows: number;
  readonly areaWidth: number;
  /** 一个 249 源像素卷轴间距的组合掩模宽度。 */
  readonly reelWidth: number;
  /** 卷轴间距内的预设符号单元宽度。 */
  readonly symbolWidth: number;
  readonly gap: number;
  readonly cellHeight: number;
  readonly areaHeight: number;
  readonly stageX: number;
  readonly stageY: number;
  readonly stageBottom: number;
  readonly frameScaleX: number;
  readonly frameScaleY: number;
  readonly frameHierarchyY: number;
  readonly frameBaseY: number;
  /** 结构补间期间底部锚定单元的局部顶部插图。 */
  readonly cellTopOffset: number;
}

export interface ReelCellGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function validateRows(rows: number): void {
  if (!Number.isInteger(rows) || rows < BASE_ROW_COUNT || rows > MAX_ROW_COUNT) {
    throw new Error("VideoSlot layout supports 3-8 rows");
  }
}

/** 在结构调整大小确定后捕获自适应桌面几何形状。 */
export function reelLayoutGeometry(rows: number): ReelLayoutGeometry {
  validateRows(rows);
  if (rows === BASE_ROW_COUNT) {
    return {
      rows,
      areaWidth: REEL_AREA_WIDTH,
      reelWidth: SOURCE_REEL_PITCH * BASE_REEL_PARENT_SCALE_X,
      symbolWidth: SOURCE_REEL_WIDTH * BASE_REEL_PARENT_SCALE_X,
      gap: REEL_GAP,
      cellHeight: REEL_CELL_HEIGHT,
      areaHeight: REEL_AREA_HEIGHT,
      stageX: REEL_STAGE_X,
      stageY: REEL_STAGE_Y,
      stageBottom: REEL_STAGE_BOTTOM,
      frameScaleX: BASE_AUTHORED_FRAME_SCALE_X,
      frameScaleY: BASE_AUTHORED_FRAME_SCALE_Y,
      frameHierarchyY: 0,
      frameBaseY: AUTHORED_FRAME_SOURCE_CENTER_Y * BASE_REEL_PARENT_SCALE_Y,
      cellTopOffset: 0,
    };
  }

  // ReelSizeAnimator.computeScale 为每个扩展布局选择 504 源像素最大垂直边界。在捕获的桌面 0.8 级规模上，
  // 这会形成稳定的 403.2px 机台宽度；行数增加时，格子会逐渐缩小。
  const sourceScale = EXPANDED_SOURCE_SCALE_NUMERATOR / rows;
  const stageScale = DESKTOP_STAGE_SCALE * sourceScale;
  const reelWidth = SOURCE_REEL_PITCH * stageScale;
  const symbolWidth = SOURCE_REEL_WIDTH * stageScale;
  const gap = 0;
  const areaWidth = SOURCE_REEL_UNION_WIDTH * stageScale;
  const cellHeight = SOURCE_REEL_HEIGHT * stageScale;
  const frameHierarchyY = SOURCE_REEL_HEIGHT * (rows - BASE_ROW_COUNT);
  const stageY = EXPANDED_ADAPTED_REEL_TOP + AUTHORED_PIVOT_CORRECTION_Y * stageScale;
  return {
    rows,
    areaWidth,
    reelWidth,
    symbolWidth,
    gap,
    cellHeight,
    areaHeight: EXPANDED_STAGE_HEIGHT,
    stageX: (1_280 - areaWidth) / 2,
    stageY,
    stageBottom: stageY + EXPANDED_STAGE_HEIGHT,
    frameScaleX: stageScale * AUTHORED_FRAME_SCALE,
    frameScaleY: stageScale * AUTHORED_FRAME_SCALE,
    frameHierarchyY,
    frameBaseY: (AUTHORED_FRAME_SOURCE_CENTER_Y + frameHierarchyY) * stageScale,
    cellTopOffset: 0,
  };
}

function interpolateGeometry(
  from: ReelLayoutGeometry,
  to: ReelLayoutGeometry,
  progress: number,
): ReelLayoutGeometry {
  const value = Math.min(1, Math.max(0, progress));
  const lerp = (start: number, end: number): number => start + (end - start) * value;
  const rows = Math.max(from.rows, to.rows);
  const cellHeight = lerp(from.cellHeight, to.cellHeight);
  const areaHeight = lerp(from.areaHeight, to.areaHeight);
  return {
    rows,
    areaWidth: lerp(from.areaWidth, to.areaWidth),
    reelWidth: lerp(from.reelWidth, to.reelWidth),
    symbolWidth: lerp(from.symbolWidth, to.symbolWidth),
    gap: lerp(from.gap, to.gap),
    cellHeight,
    areaHeight,
    stageX: lerp(from.stageX, to.stageX),
    stageY: lerp(from.stageY, to.stageY),
    stageBottom: lerp(from.stageBottom, to.stageBottom),
    frameScaleX: lerp(from.frameScaleX, to.frameScaleX),
    frameScaleY: lerp(from.frameScaleY, to.frameScaleY),
    frameHierarchyY: lerp(from.frameHierarchyY, to.frameHierarchyY),
    frameBaseY: lerp(from.frameBaseY, to.frameBaseY),
    cellTopOffset: areaHeight - rows * cellHeight,
  };
}

/** 1s 自适应调整大小时间线使用的纯几何样本。 */
export function reelTransitionGeometry(
  fromRows: number,
  toRows: number,
  progress: number,
): ReelLayoutGeometry {
  validateRows(fromRows);
  validateRows(toRows);
  return interpolateGeometry(
    reelLayoutGeometry(fromRows),
    reelLayoutGeometry(toRows),
    progress,
  );
}

/** 服务器寻址功能使用的局部几何图形并赢得效果。 */
export function reelCellGeometry(address: CellAddress, rows: number): ReelCellGeometry | null {
  const geometry = reelLayoutGeometry(rows);
  if (!Number.isInteger(address.reel) || !Number.isInteger(address.row)
    || address.reel < 0 || address.reel >= 3
    || address.row < 0 || address.row >= rows) return null;
  return {
    x: address.reel * (geometry.reelWidth + geometry.gap),
    y: geometry.cellTopOffset + address.row * geometry.cellHeight,
    width: geometry.reelWidth,
    height: geometry.cellHeight,
  };
}

const JACKPOT_PRIZE_BY_MULTIPLIER: Readonly<Record<number, string>> = Object.freeze({
  10: "MINI",
  20: "MINI_2X",
  30: "MINOR",
  60: "MINOR_2X",
  75: "MAJOR",
  150: "MAJOR_2X",
  250: "MEGA",
  500: "MEGA_2X",
  1_000: "GRAND",
});

/** 仅重建已经权威的升级前显示姿势。 */
export function vaultCellBeforeUpgrade(event: VaultUpgradedEvent): GridCell {
  let prize = JACKPOT_PRIZE_BY_MULTIPLIER[event.fromMultiplier];
  if (!prize && /^X\d+$/i.test(event.prize)) prize = `X${event.fromMultiplier}`;
  if (!prize && event.prize.toUpperCase().endsWith("_2X")) {
    prize = event.prize.slice(0, -3);
  }
  const cell: GridCell = { symbol: "VAULT", multiplier: event.fromMultiplier };
  if (prize) cell.prize = prize;
  return cell;
}

/** 由一个权威 Vault 解锁事件携带的确切最终单元格。 */
export function vaultUnlockTargetCell(event: Readonly<VaultUnlockedEvent>): GridCell {
  const cell: GridCell = { symbol: "VAULT", prize: event.prize };
  if (event.multiplier !== undefined) cell.multiplier = event.multiplier;
  return cell;
}

interface PreparedCellPresentation {
  readonly cell: GridCell;
  readonly forceLockedVault: boolean;
}

export class ReelSetView extends Container {
  readonly additiveFrameOverlay = namedExternalOverlay(REEL_ADDITIVE_FRAME_OVERLAY_NAME);
  /** 用于结算中奖符号的外部 ADD 通行证；从来都不是 ReelSetView 孩子。 */
  readonly winningSymbolAdditiveOverlay = namedExternalOverlay(
    REEL_WINNING_SYMBOL_ADDITIVE_OVERLAY_NAME,
  );
  private readonly reelMotionRoot = namedContainer(REEL_COMPOSITE_ROOT_NAME);
  private readonly trackLayer = namedContainer(REEL_SET_LAYER_NAMES.tracks);
  private readonly symbolLayer = namedContainer(REEL_SET_LAYER_NAMES.symbols);
  private readonly winFrameEffectLayer = namedContainer(REEL_WIN_LAYER_NAMES.frames);
  private readonly activatedSymbolLayer = namedContainer(REEL_WIN_LAYER_NAMES.activated);
  private readonly winningSymbolAdditiveMotionRoot = namedContainer(
    "winning-symbol-additive-motion-root",
  );
  private readonly winningSymbolAdditiveLayer = namedContainer(
    "winning-symbol-additive-layer",
  );
  private readonly winningSymbolAdditiveActivatedLayer = namedContainer(
    "winning-symbol-additive-activated-overlay",
  );
  private readonly middleFrameLayer = namedContainer(REEL_SET_LAYER_NAMES.middle);
  private readonly outerFrameLayer = namedContainer(REEL_SET_LAYER_NAMES.outer);
  private readonly frame = new Graphics();
  private readonly middleFrameShadow = new Graphics();
  private readonly middleHardware = new Graphics();
  private readonly hardware = new Graphics();
  private readonly perspectiveFilter = new ReelPerspectiveFilter();
  private readonly additivePerspectiveFilter = new ReelPerspectiveFilter();
  private readonly winningSymbolAdditivePerspectiveFilter = new ReelPerspectiveFilter();
  private readonly reels = [new ReelView(0), new ReelView(1), new ReelView(2)];
  private readonly waysLabel = new Text("27 WAYS", new TextStyle({
    fill: 0xc8a36d,
    fontFamily: "Arial, sans-serif",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 2,
  }));
  private rowCount = 3;
  private layoutGeometry = reelLayoutGeometry(3);
  private authoredFrame: Spine | null = null;
  private authoredFrameAdditive: Spine | null = null;
  private authoredFrameLoad: Promise<void> | null = null;
  private authoredFrameMover: { y: number } | null = null;
  private authoredFrameAdditiveMover: { y: number } | null = null;
  private authoredFrameMoverY = BASE_ROW_COUNT * SOURCE_REEL_HEIGHT - 230;
  private authoredFrameBaseX = REEL_AREA_WIDTH / 2;
  private authoredFrameBaseY = AUTHORED_FRAME_SOURCE_CENTER_Y * BASE_REEL_PARENT_SCALE_Y;
  private authoredFrameScaleX = BASE_AUTHORED_FRAME_SCALE_X;
  private authoredFrameScaleY = BASE_AUTHORED_FRAME_SCALE_Y;
  private authoredFrameRootX = 0;
  private authoredFrameRootY = 0;
  private readonly symbolIdleRandom: () => number = Math.random;
  // 原始任务直到 Idle.launch 才抽取第一个随机样本。
  private readonly symbolIdleTimer = new PrimalSymbolIdleTimer(this.symbolIdleRandom, false);
  private symbolIdleActive = false;
  private dormant = true;
  private spinActive = false;
  private winPresentationActive = false;
  private structuralTransitionActive = false;
  private responsiveCompositionScale = 1;
  private mobileViewportRegion: ResponsiveRendererRegion | null = null;
  private mobileLayoutProfile: MobileLayoutProfile = "ls";
  private rageCascadeActive = false;
  private visualTelemetry: VisualTelemetryReporter | null = null;
  private readonly preparedCellOverrides = new Map<string, PreparedCellPresentation>();
  private maximumRowsPreparation: Promise<void> | null = null;
  private activatedWildRemainingMs = 0;

  constructor() {
    super();
    this.position.set(REEL_STAGE_X, REEL_STAGE_Y);
    (this.frame as Graphics & { name: string }).name = REEL_HARDWARE_NODE_NAMES.fallbackOuter;
    (this.middleFrameShadow as Graphics & { name: string }).name = REEL_HARDWARE_NODE_NAMES.middleShadow;
    (this.middleHardware as Graphics & { name: string }).name = REEL_HARDWARE_NODE_NAMES.fallbackMiddle;
    this.waysLabel.anchor.set(0.5, 0);
    this.trackLayer.addChild(...this.reels.map((reel) => reel.trackDisplay));
    // reverseLayeringOrder=true 将卷轴 2 -> 1 -> 0 迁移到固定的叠加层中，因此当预设的艺术溢出时，卷轴 0 是最后/最上面的同级。
    this.symbolLayer.addChild(
      this.winFrameEffectLayer,
      ...[...this.reels].reverse(),
      ...this.reels.map((reel) => reel.trackShadowDisplay),
      this.activatedSymbolLayer,
    );
    this.winningSymbolAdditiveLayer.addChild(
      ...[...this.reels].reverse().map((reel) => reel.winningSymbolAdditiveDisplay),
      this.winningSymbolAdditiveActivatedLayer,
    );
    this.winningSymbolAdditiveMotionRoot.addChild(this.winningSymbolAdditiveLayer);
    this.winningSymbolAdditiveOverlay.addChild(this.winningSymbolAdditiveMotionRoot);
    this.middleFrameLayer.addChild(this.middleFrameShadow, this.middleHardware);
    this.outerFrameLayer.addChild(this.frame, this.hardware, this.waysLabel);
    this.reelMotionRoot.addChild(
      this.trackLayer,
      this.symbolLayer,
      this.outerFrameLayer,
      this.middleFrameLayer,
    );
    this.addChild(this.reelMotionRoot);
    // 准确保留冻结的透视目标。 PixiRenderer 将复制的仅附加帧通道安装为该节点的外部同级，因为黑色为零的图集页面无法在该离屏通道中幸存下来。
    this.filters = [this.perspectiveFilter];
    // 外部通行证仍然需要运送的投影。将其过滤纹理合成为 ADD 可使最终场景帧缓冲区中不透明的 RGB 图集黑色等于零，而不是将其变成黑色四边形。
    this.additiveFrameOverlay.filters = [this.additivePerspectiveFilter];
    this.additivePerspectiveFilter.state.blendMode = BLEND_MODES.ADD;
    this.winningSymbolAdditiveOverlay.filters = [
      this.winningSymbolAdditivePerspectiveFilter,
    ];
    this.winningSymbolAdditivePerspectiveFilter.state.blendMode = BLEND_MODES.ADD;
    this.syncExternalAdditiveOverlayTransforms();
    this.setRows(3);
    this.setDormant(true);
  }

  setVisualTelemetryReporter(reporter: VisualTelemetryReporter | null): void {
    this.visualTelemetry = reporter;
    this.reels.forEach((reel) => reel.setVisualTelemetryReporter(reporter));
  }

  /** 让普通机台与外部 ADD 通道共用同一景深。 */
  setPerspectiveCoordinateScale(coordinateScale: number): void {
    this.perspectiveFilter.setCoordinateScale(coordinateScale);
    this.additivePerspectiveFilter.setCoordinateScale(coordinateScale);
    this.winningSymbolAdditivePerspectiveFilter.setCoordinateScale(coordinateScale);
  }

  /**
   * 将卷轴拥有的 FX 安装在投影合成内部，位于符号和轨道阴影上方，但位于两个硬件框架层下方。
   */
  mountSymbolEffect(effect: Container): void {
    if (effect.parent === this.symbolLayer) {
      this.symbolLayer.addChild(effect);
      return;
    }
    effect.parent?.removeChild(effect);
    this.symbolLayer.addChild(effect);
  }

  /** WinBox是官方的winFrameOverlay，下面固定符号。 */
  mountWinFrameEffect(effect: Container): void {
    if (effect.parent === this.winFrameEffectLayer) {
      this.winFrameEffectLayer.addChild(effect);
      return;
    }
    effect.parent?.removeChild(effect);
    this.winFrameEffectLayer.addChild(effect);
  }

  setRows(rows: number): void {
    const geometry = reelLayoutGeometry(rows);
    const previousRows = this.rowCount;
    this.rowCount = rows;
    this.layoutGeometry = geometry;
    this.authoredFrameMoverY = BASE_ROW_COUNT * SOURCE_REEL_HEIGHT - 230
      + geometry.frameHierarchyY;
    this.applyResponsiveComposition(geometry);
    this.reels.forEach((reel, index) => {
      reel.setLayerPosition(index * (geometry.reelWidth + geometry.gap), 0);
      reel.setLayout(geometry.reelWidth, geometry.areaHeight, rows, geometry.symbolWidth);
    });
    this.waysLabel.text = `${rows ** 3} WAYS`;
    this.waysLabel.position.set(geometry.areaWidth / 2, geometry.areaHeight + 13);
    this.positionAuthoredFrame(geometry);
    this.applyAuthoredFrameMover();
    this.drawFrame(geometry);
    if (rows > previousRows) this.playAuthoredFrame("reel_stretch");
    else if (rows < previousRows) this.playAuthoredFrame("reel_smash");
  }

  /** 在单独的框架上构建每个轴的完整 3x8 固定/运动池。 */
  prepareMaximumRows(options: ReelViewPreloadOptions = {}): Promise<void> {
    if (this.maximumRowsPreparation) return this.maximumRowsPreparation;
    const attempt = (async () => {
      options.onProgress?.(0);
      for (let reelIndex = 0; reelIndex < this.reels.length; reelIndex += 1) {
        if (options.signal?.aborted) throw options.signal.reason;
        const reel = this.reels[reelIndex];
        if (!reel) continue;
        await reel.prepareMaximumRows({
          signal: options.signal,
          requestFrame: options.requestFrame,
          onProgress: (fraction) => {
            options.onProgress?.((reelIndex + fraction) / this.reels.length);
          },
        });
      }
      options.onProgress?.(1);
    })().catch((error) => {
      this.maximumRowsPreparation = null;
      throw error;
    });
    this.maximumRowsPreparation = attempt;
    return attempt;
  }

  /**
   * 应用原始自适应转轴缩放的一次视觉采样。调用方提供已缓动的进度值，因此每项几何属性都可在两套复刻的固定布局之间线性插值。
   */
  setRowsTransition(fromRows: number, toRows: number, progress: number): void {
    validateRows(fromRows);
    validateRows(toRows);
    const value = Math.min(1, Math.max(0, progress));
    this.structuralTransitionActive = value < 1;
    this.syncSymbolIdleState();
    const toGeometry = reelLayoutGeometry(toRows);
    const geometry = reelTransitionGeometry(fromRows, toRows, value);
    const visualRows = geometry.rows;

    this.rowCount = value >= 1 ? toRows : fromRows;
    this.layoutGeometry = value >= 1 ? toGeometry : geometry;
    this.authoredFrameMoverY = BASE_ROW_COUNT * SOURCE_REEL_HEIGHT - 230
      + geometry.frameHierarchyY;
    this.applyResponsiveComposition(geometry);
    this.reels.forEach((reel, index) => {
      reel.setLayerPosition(index * (geometry.reelWidth + geometry.gap), 0);
      reel.setExpansionLayout(
        geometry.reelWidth,
        geometry.areaHeight,
        visualRows,
        geometry.cellHeight,
        geometry.symbolWidth,
      );
    });
    this.waysLabel.text = `${toRows ** 3} WAYS`;
    this.waysLabel.position.set(geometry.areaWidth / 2, geometry.areaHeight + 13);
    this.positionAuthoredFrame(geometry);
    this.applyAuthoredFrameMover();
    this.drawFrame(geometry);

    // 以完全相同的最终几何形状重新输入普通的固定布局，留下稍后的网格验证并赢得整数行的寻址。
    if (value >= 1) {
      this.layoutGeometry = toGeometry;
      this.reels.forEach((reel, index) => {
        reel.setLayerPosition(index * (toGeometry.reelWidth + toGeometry.gap), 0);
        reel.setLayout(
          toGeometry.reelWidth,
          toGeometry.areaHeight,
          toRows,
          toGeometry.symbolWidth,
        );
      });
      this.syncSymbolIdleState();
    }
  }

  setResponsiveComposition(scale: number): void {
    if (!Number.isFinite(scale)) return;
    this.mobileViewportRegion = null;
    this.responsiveCompositionScale = responsiveReelCompositionScale(scale);
    this.applyResponsiveComposition(this.layoutGeometry);
  }

  setMobileLayout(
    viewportRegion: ResponsiveRendererRegion | null,
    profile: MobileLayoutProfile = "ls",
  ): void {
    this.mobileViewportRegion = viewportRegion;
    this.mobileLayoutProfile = profile;
    this.applyResponsiveComposition(this.layoutGeometry);
  }

  private applyResponsiveComposition(geometry: ReelLayoutGeometry): void {
    if (this.mobileViewportRegion) {
      const projection = mobileReelProjection(
        this.mobileViewportRegion,
        this.mobileLayoutProfile,
      );
      this.scale.set(projection.scale);
      this.position.set(projection.x, projection.y);
      this.syncExternalAdditiveOverlayTransforms();
      return;
    }
    const scale = this.responsiveCompositionScale;
    this.scale.set(scale);
    this.position.set(
      LOGICAL_WIDTH / 2 - geometry.areaWidth * scale / 2,
      geometry.stageY,
    );
    this.syncExternalAdditiveOverlayTransforms();
  }

  private syncExternalAdditiveOverlayTransforms(): void {
    this.additiveFrameOverlay.position.copyFrom(this.position);
    this.additiveFrameOverlay.scale.copyFrom(this.scale);
    this.additiveFrameOverlay.pivot.copyFrom(this.pivot);
    this.additiveFrameOverlay.rotation = this.rotation;
    this.additiveFrameOverlay.alpha = this.alpha;
    this.additiveFrameOverlay.visible = this.visible;
    this.additiveFrameOverlay.renderable = this.renderable;

    const overlay = this.winningSymbolAdditiveOverlay;
    overlay.position.copyFrom(this.position);
    overlay.scale.copyFrom(this.scale);
    overlay.pivot.copyFrom(this.pivot);
    overlay.skew.copyFrom(this.skew);
    overlay.rotation = this.rotation;
    overlay.alpha = this.alpha;
    overlay.visible = this.visible;
    overlay.renderable = this.renderable;

    const motionRoot = this.winningSymbolAdditiveMotionRoot;
    motionRoot.position.copyFrom(this.reelMotionRoot.position);
    motionRoot.scale.copyFrom(this.reelMotionRoot.scale);
    motionRoot.pivot.copyFrom(this.reelMotionRoot.pivot);
    motionRoot.skew.copyFrom(this.reelMotionRoot.skew);
    motionRoot.rotation = this.reelMotionRoot.rotation;
    motionRoot.alpha = this.reelMotionRoot.alpha;
    motionRoot.visible = this.reelMotionRoot.visible;
    motionRoot.renderable = this.reelMotionRoot.renderable;

    const symbolLayer = this.winningSymbolAdditiveLayer;
    symbolLayer.position.copyFrom(this.symbolLayer.position);
    symbolLayer.scale.copyFrom(this.symbolLayer.scale);
    symbolLayer.pivot.copyFrom(this.symbolLayer.pivot);
    symbolLayer.skew.copyFrom(this.symbolLayer.skew);
    symbolLayer.rotation = this.symbolLayer.rotation;
    symbolLayer.alpha = this.symbolLayer.alpha;
    symbolLayer.visible = this.symbolLayer.visible;
    symbolLayer.renderable = this.symbolLayer.renderable;
    this.reels.forEach((reel) => reel.syncWinningSymbolAdditiveTransform());
  }

  get activeRows(): number {
    return this.rowCount;
  }

  /** 稳定的局部几何效果；它永远不会公开或更改结果数据。 */
  getPresentationBounds(): Rectangle {
    return new Rectangle(0, 0, this.layoutGeometry.areaWidth, this.layoutGeometry.areaHeight);
  }

  /**
   * 返回 `CC/reelSuspense2` 的确切实时主机。原始节点在`OB/reel`内部；导出这个不可变的快照可以让独立的 ADD 传递继承该层次结构，
   * 而无需将其不透明图集展平到正常的卷轴渲染目标中。
   */
  getAnticipationHostProjection(): Readonly<ReelAnticipationHostProjection> {
    const perspective = this.getPerspectiveDiagnostics();
    return deepFreezePlain({
      host: {
        x: this.position.x,
        y: this.position.y,
        scaleX: this.scale.x,
        scaleY: this.scale.y,
        pivotX: this.pivot.x,
        pivotY: this.pivot.y,
        skewX: this.skew.x,
        skewY: this.skew.y,
        rotation: this.rotation,
        alpha: this.alpha,
        visible: this.visible,
        renderable: this.renderable,
      },
      source: {
        centreX: this.layoutGeometry.areaWidth / 2,
        centreY: this.layoutGeometry.areaHeight / 2,
        // 框架本身已有制作好的 1.01 倍缩放。Suspense 是它的同级节点，因此只继承共享的 ReelSizeAnimator 缩放值。
        scaleX: this.layoutGeometry.frameScaleX / AUTHORED_FRAME_SCALE,
        scaleY: this.layoutGeometry.frameScaleY / AUTHORED_FRAME_SCALE,
        motionX: this.reelMotionRoot.position.x,
        motionY: this.reelMotionRoot.position.y,
      },
      filterArea: { ...perspective.targetBounds },
      perspectiveResolution: perspective.resolution,
    });
  }

  /** 浏览器奇偶校验装置使用的只读实时过滤器事实。 */
  getPerspectiveDiagnostics(): ReelPerspectiveDiagnostics {
    const bounds = this.getBounds(true);
    const { x, y, width, height } = bounds;
    return Object.freeze({
      ...this.perspectiveFilter.diagnostics(),
      attached: this.filters?.includes(this.perspectiveFilter) ?? false,
      enabled: this.perspectiveFilter.enabled,
      autoFit: this.perspectiveFilter.autoFit,
      padding: this.perspectiveFilter.padding,
      resolution: this.perspectiveFilter.resolution,
      resolutions: Object.freeze({
        normal: this.perspectiveFilter.resolution,
        additiveFrame: this.additivePerspectiveFilter.resolution,
        winningSymbolAdditive: this.winningSymbolAdditivePerspectiveFilter.resolution,
      }),
      targetBounds: Object.freeze({ x, y, width, height }),
    });
  }

  /**
   * 固定内阁层次结构的不可变浏览器捕获投影。它是由活动节点故意组装而成并复制为纯数据；没有显示对象、过滤器、遮罩或 Spine 轨道逃脱此边界。
   */
  getCabinetCompositionDiagnostics(): Readonly<ReelCabinetCompositionDiagnostics> {
    const worldPosition = this.toGlobal(new Point(0, 0));
    const worldTransform = this.worldTransform;
    const perspective = this.getPerspectiveDiagnostics();
    const angle = this.perspectiveFilter.uniforms.uAngle as ArrayLike<number>;
    const diagnostics: ReelCabinetCompositionDiagnostics = {
      activeRows: this.rowCount,
      frameMode: this.authoredFrame ? "authored" : "fallback",
      transform: {
        localPosition: { x: this.position.x, y: this.position.y },
        localScale: { x: this.scale.x, y: this.scale.y },
        worldPosition: { x: worldPosition.x, y: worldPosition.y },
        worldScale: {
          x: Math.hypot(worldTransform.a, worldTransform.b),
          y: Math.hypot(worldTransform.c, worldTransform.d),
        },
      },
      reelMotionRoot: {
        name: this.reelMotionRoot.name,
        orderedChildNames: this.reelMotionRoot.children.map((child) => child.name ?? ""),
      },
      frameInstances: {
        normalInComposite: this.authoredFrame
          ? this.trackLayer.children.filter((child) => child === this.authoredFrame).length
          : 0,
        additiveInExternalOverlay: this.authoredFrameAdditive
          ? this.additiveFrameOverlay.children.filter(
              (child) => child === this.authoredFrameAdditive,
            ).length
          : 0,
      },
      normalFrame: cabinetFrameDiagnostics(this.authoredFrame),
      additiveFrame: cabinetFrameDiagnostics(this.authoredFrameAdditive),
      reels: this.reels.map((reel) => reel.getViewportCompositionDiagnostics()),
      perspective: {
        attached: perspective.attached,
        enabled: perspective.enabled,
        autoFit: perspective.autoFit,
        appliedFrames: perspective.appliedFrames,
        resolution: perspective.resolution,
        resolutions: { ...perspective.resolutions },
        angle: [Number(angle[0]), Number(angle[1])],
        effectiveDepth: Number(this.perspectiveFilter.uniforms.uDepth),
        sourceFrame: perspective.sourceFrame ? { ...perspective.sourceFrame } : null,
        targetBounds: { ...perspective.targetBounds },
      },
    };
    return deepFreezePlain(diagnostics);
  }

  /** 网格稳定后返回服务器寻址单元的视觉中心。 */
  getCellCenter(address: CellAddress): Point | null {
    const cell = this.currentCellGeometry(address);
    if (!cell) return null;
    return new Point(
      cell.x + cell.width / 2,
      cell.y + cell.height / 2,
    );
  }

  /** 返回纯粹装饰性的、服务器寻址的 FX 的本地单元格几何形状。 */
  getCellPresentationBounds(address: CellAddress): Rectangle | null {
    const cell = this.currentCellGeometry(address);
    return cell ? new Rectangle(cell.x, cell.y, cell.width, cell.height) : null;
  }

  setGrid(grid: GridCell[][], options: ReelGridPresentationOptions = {}): void {
    this.validateGrid(grid);
    // 在结构收缩之前清除完整的预分配池。仅分配传入行将使前 3x8 中奖者在第 3..7 行隐形前进，直到稍后的扩展。
    this.clearHighlights();
    this.clearWinMotion();
    this.clearWinDimming();
    this.restoreActivatedSurges();
    if (grid[0]?.length !== this.rowCount) this.setRows(grid[0]?.length ?? 3);
    const lockedRowsByReel = new Map<number, Set<number>>();
    for (const { reel, row } of options.forceLockedVaultCells ?? []) {
      // 失败关闭：过时的视觉地址绝不能将非 Vault 变成特殊符号或影响权威网格。
      if (grid[reel]?.[row]?.symbol !== "VAULT") continue;
      const rows = lockedRowsByReel.get(reel) ?? new Set<number>();
      rows.add(row);
      lockedRowsByReel.set(reel, rows);
    }
    grid.forEach((cells, reel) => this.reels[reel]?.setCells(
      cells,
      false,
      lockedRowsByReel.get(reel),
    ));
    this.dormant = false;
    this.spinActive = false;
    this.winPresentationActive = false;
    this.structuralTransitionActive = false;
    this.preparedCellOverrides.clear();
    this.syncSymbolIdleState(true);
  }

  override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    if (this.destroyed) return;
    const externalOverlays = [
      this.additiveFrameOverlay,
      this.winningSymbolAdditiveOverlay,
    ] as const;
    // 先拆开。销毁普通树然后让每个 SymbolView 释放其外部安装的 ADD 根一次。
    externalOverlays.forEach((overlay) => overlay.parent?.removeChild(overlay));
    super.destroy(options);
    externalOverlays.forEach((overlay) => overlay.destroy({
      children: true,
      texture: false,
      baseTexture: false,
    }));
  }

  /**
   * 隐藏最终的 Vault 值，直到呈现其权威揭示/升级事件。 GameSnapshot 保持最终网格不变。
   */
  prepareFeaturePresentation(events: readonly FeatureEvent[]): void {
    this.preparedCellOverrides.clear();
    for (const event of events) {
      if (event.type === "vault.unlocked") {
        this.preparedCellOverrides.set(this.cellKey(event), {
          cell: vaultUnlockTargetCell(event),
          forceLockedVault: true,
        });
        continue;
      }
      if (event.type !== "vault.upgraded") continue;
      const key = this.cellKey(event);
      if (this.preparedCellOverrides.has(key)) continue;
      const existing = this.reels[event.reel]?.cellAt(event.row);
      this.preparedCellOverrides.set(
        key,
        {
          cell: existing?.symbol === "VAULT" ? { ...existing } : vaultCellBeforeUpgrade(event),
          forceLockedVault: false,
        },
      );
    }
  }

  setDormant(active: boolean): void {
    this.dormant = active;
    this.reels.forEach((reel) => reel.setDormant(active));
    this.syncSymbolIdleState(!active);
    this.syncExternalAdditiveOverlayTransforms();
  }

  /** 在三个卷轴窗格上镜像仅渲染器的环境光。 */
  setEnvironmentFrame(frame: SpinEnvironmentFrame): void {
    this.reels.forEach((reel) => reel.setEnvironmentFrame(frame));
  }

  beginSpin(reducedMotion = false): void {
    this.rageCascadeActive = false;
    this.spinActive = true;
    this.winPresentationActive = false;
    this.syncSymbolIdleState();
    this.clearHighlights();
    this.clearWinMotion();
    this.reels.forEach((reel) => reel.beginSpin(reducedMotion));
  }

  async stopReel(
    reel: number,
    cells: GridCell[],
    durationMs: number,
    mode: ReelStopMode = "NORMAL",
  ): Promise<void> {
    const view = this.reels[reel];
    if (!view) throw new Error(`Unknown reel ${reel}`);
    const forceLockedVaultRows = new Set<number>();
    const presentedCells = cells.map((cell, row) => {
      const prepared = this.preparedCellOverrides.get(this.cellKey({ reel, row }));
      if (!prepared) return cell;
      if (prepared.forceLockedVault) forceLockedVaultRows.add(row);
      return prepared.cell;
    });
    await view.stopAt(presentedCells, durationMs, mode, forceLockedVaultRows);
  }

  commitReelImpact(reel: number, mode: ReelStopMode): void {
    const view = this.reels[reel];
    if (!view) throw new Error(`Unknown reel ${reel}`);
    view.commitStopImpact(mode);
    if (reel === this.reels.length - 1) {
      this.spinActive = false;
      this.syncSymbolIdleState(true);
    }
  }

  requestFastForward(mode: ReelStopMode = "SLOW"): void {
    this.reels.forEach((reel) => reel.requestFastForward(mode));
  }

  startRageAnticipation(triggerReels: readonly number[] = [0, 1]): AuthoredPlaybackBatchResult {
    let attempted = 0;
    let played = 0;
    for (const reelIndex of triggerReels) {
      const result = this.reels[reelIndex]?.startRageAnticipation();
      if (!result) continue;
      attempted += result.attempted;
      played += result.played;
    }
    return Object.freeze({ attempted, played });
  }

  endRageAnticipation(triggerReels: readonly number[] = [0, 1]): AuthoredPlaybackBatchResult {
    let attempted = 0;
    let played = 0;
    for (const reelIndex of triggerReels) {
      const result = this.reels[reelIndex]?.endRageAnticipation();
      if (!result) continue;
      attempted += result.attempted;
      played += result.played;
    }
    return Object.freeze({ attempted, played });
  }

  /** Wild 显示已陆路排队；只有三个 Rage 需要新的夹子。 */
  playPostStopActivation(plan: PostStopActivationPlan): void {
    if (plan.kind !== "surge-feature-activation") return;
    let played = 0;
    for (const { reel, row } of plan.cells) {
      if (this.reels[reel]?.playPostStopSurgeActivation(row)) played += 1;
    }
    if (played !== plan.cells.length) {
      this.visualTelemetry?.failedToStart({
        id: "rage.collect",
        requirement: "conditional",
        mode: "authored",
        clips: ["feature_activation"],
        sourceEvent: "reel.post-stop-activation",
      }, {
        stage: "animation",
        code: "missing-animation",
        fallback: "bitmap",
      });
    }
  }

  /** 确定性的截图接口；单元格保持权威且不变。 */
  setSymbolPlaybackPaused(cells: readonly Readonly<CellAddress>[], active: boolean): void {
    const rowsByReel = new Map<number, Set<number>>();
    for (const { reel, row } of cells) {
      const rows = rowsByReel.get(reel) ?? new Set<number>();
      rows.add(row);
      rowsByReel.set(reel, rows);
    }
    for (const [reel, rows] of rowsByReel) {
      this.reels[reel]?.setSymbolPlaybackPaused(rows, active);
    }
  }

  /** 只把测试场景中暂停的符号时钟推进指定的原生时间增量。 */
  advanceSymbolPlayback(cells: readonly Readonly<CellAddress>[], deltaMs: number): void {
    const rowsByReel = this.rowsByReel(cells as readonly CellAddress[]);
    for (const [reel, rows] of rowsByReel) {
      this.reels[reel]?.advanceSymbolPlayback(rows, deltaMs);
    }
  }

  /** 冻结纯数据诊断；没有 Pixi 或 Spine 对象转义。 */
  getVaultCaptureDiagnostics(
    address: Readonly<CellAddress>,
  ): Readonly<ReelVaultCaptureDiagnostics> | null {
    return this.reels[address.reel]?.getVaultCaptureDiagnostics(address.row) ?? null;
  }

  cancelPresentation(): void {
    this.clearHighlights();
    this.reels.forEach((reel) => reel.cancelSpin());
    // 测试场景观察者持有 Symbol8 时，结果可能已经实际落定。即使 AppController 尚未恢复整个权威网格，取消操作也必须先恢复其保存的最终格子。
    this.reels.forEach((reel) => reel.clearForcedLockedVaultPresentation());
    this.spinActive = false;
    this.rageCascadeActive = false;
    this.reels.forEach((reel) => reel.clearRageCascadePresentation());
    this.restoreActivatedSurges();
    this.preparedCellOverrides.clear();
    this.syncSymbolIdleState(true);
  }

  beginSurgeCollection(address: CellAddress): boolean {
    return this.reels[address.reel]?.beginSurgeCollection(
      address.row,
      this.activatedSymbolLayer,
      this.winningSymbolAdditiveActivatedLayer,
    ) ?? false;
  }

  restoreSurgeCollectionLayer(address: CellAddress): boolean {
    return this.reels[address.reel]?.restoreSurgeCollectionLayer(
      address.row,
      this.activatedSymbolLayer,
      this.winningSymbolAdditiveActivatedLayer,
    ) ?? false;
  }

  areSurgeCollectionsActivated(cells: readonly Readonly<CellAddress>[]): boolean {
    return cells.length > 0 && cells.every(({ reel, row }) => (
      this.reels[reel]?.isSurgeCollectionActivated(
        row,
        this.activatedSymbolLayer,
        this.winningSymbolAdditiveActivatedLayer,
      ) ?? false
    ));
  }

  completeSurgeCollection(address: CellAddress): void {
    this.reels[address.reel]?.completeSurgeCollection(address.row);
  }

  activateRageCells(cells: readonly CellAddress[]): AuthoredPlaybackBatchResult {
    let attempted = 0;
    let played = 0;
    for (const address of cells) {
      const reel = this.reels[address.reel];
      const current = reel?.cellAt(address.row);
      if (current?.symbol !== "SURGE") continue;
      attempted += 1;
      if (reel?.transformCellToRage(address.row)) played += 1;
    }
    return Object.freeze({ attempted, played });
  }

  /** 概率 Rage 触发器使用的服务器寻址替换单元。 */
  transformCellsToRage(cells: readonly CellAddress[]): void {
    for (const address of cells) this.reels[address.reel]?.transformCellToRage(address.row);
  }

  /** 开始捕获的九单元 Rage 级联，无需更换服务器单元。 */
  prepareRageCascade(): void {
    this.rageCascadeActive = true;
    this.reels.forEach((reel) => reel.prepareRageCascade());
    this.syncSymbolIdleState();
  }

  /** 应用原始打乱级联顺序中的一个卷轴主单元。 */
  revealRageCascadeCell(address: CellAddress, transformsToRage: boolean): boolean {
    return this.reels[address.reel]?.revealRageCascadeCell(address.row, transformsToRage) ?? false;
  }

  activateRageCascade(): AuthoredPlaybackBatchResult {
    let attempted = 0;
    let played = 0;
    this.reels.forEach((reel) => {
      const result = reel.activateRageCascade();
      attempted += result.attempted;
      played += result.played;
    });
    return Object.freeze({ attempted, played });
  }

  completeRageCascade(): void {
    this.reels.forEach((reel) => reel.clearRageCascadePresentation());
    this.rageCascadeActive = false;
    this.syncSymbolIdleState(true);
  }

  beginVaultUnlock(event: VaultUnlockedEvent): boolean {
    return this.reels[event.reel]?.playVaultUnlock(event.row) ?? false;
  }

  playVaultFreeSpinActivation(address: CellAddress): boolean {
    return this.reels[address.reel]?.playVaultFreeSpinActivation(address.row) ?? false;
  }

  playVaultTease(cells: readonly CellAddress[]): number {
    let played = 0;
    for (const { reel, row } of cells) {
      if (this.reels[reel]?.playVaultTease(row)) played += 1;
    }
    return played;
  }

  skipVaultTease(cells: readonly CellAddress[]): number {
    let skipped = 0;
    for (const { reel, row } of cells) {
      if (this.reels[reel]?.skipVaultTease(row)) skipped += 1;
    }
    return skipped;
  }

  completeVaultUnlock(event: VaultUnlockedEvent): void {
    this.preparedCellOverrides.delete(this.cellKey(event));
    this.reels[event.reel]?.revealVault(event.row, vaultUnlockTargetCell(event));
  }

  applyVaultUpgrade(event: VaultUpgradedEvent): boolean {
    this.preparedCellOverrides.delete(this.cellKey(event));
    return this.reels[event.reel]?.upgradeVault(event.row, {
      symbol: "VAULT",
      multiplier: event.toMultiplier,
      prize: event.prize,
    }) ?? false;
  }

  applyVaultAward(event: VaultAwardedEvent): boolean {
    const current = this.reels[event.reel]?.cellAt(event.row);
    const cell: GridCell = {
      symbol: "VAULT",
      multiplier: event.multiplier,
    };
    if (event.prize !== undefined) cell.prize = event.prize;
    else if (current?.prize !== undefined) cell.prize = current.prize;
    return this.reels[event.reel]?.winVault(event.row, cell) ?? false;
  }

  highlight(cells: CellAddress[]): void {
    this.restoreActivatedWilds();
    this.syncExternalAdditiveOverlayTransforms();
    const byReel = new Map<number, Set<number>>();
    for (const cell of cells) {
      const rows = byReel.get(cell.reel) ?? new Set<number>();
      rows.add(cell.row);
      byReel.set(cell.reel, rows);
    }
    this.reels.forEach((reel, index) => reel.setHighlightedRows(byReel.get(index) ?? new Set()));
    const promoted = this.reels.reduce((count, reel, index) => (
      count + reel.promoteWinningWildRows(
        byReel.get(index) ?? new Set<number>(),
        this.activatedSymbolLayer,
        this.winningSymbolAdditiveActivatedLayer,
      )
    ), 0);
    this.activatedWildRemainingMs = promoted > 0 ? PRIMAL_WINNING_WILD_ACTIVATED_MS : 0;
    this.syncExternalAdditiveOverlayTransforms();
  }

  clearHighlights(): void {
    this.restoreActivatedWilds();
    this.reels.forEach((reel) => reel.setHighlightedRows(new Set()));
  }

  private restoreActivatedWilds(): void {
    this.reels.forEach((reel) => reel.restoreActivatedWilds(
      this.activatedSymbolLayer,
      this.winningSymbolAdditiveActivatedLayer,
    ));
    this.activatedWildRemainingMs = 0;
    this.syncExternalAdditiveOverlayTransforms();
  }

  private restoreActivatedSurges(): void {
    this.reels.forEach((reel) => reel.restoreActivatedSurges(
      this.activatedSymbolLayer,
      this.winningSymbolAdditiveActivatedLayer,
    ));
  }

  /** 调暗未由权威服务器中奖命名的每个已确定单元格。 */
  dimNonWinningCells(cells: readonly CellAddress[]): void {
    this.winPresentationActive = true;
    this.syncSymbolIdleState();
    const byReel = this.rowsByReel(cells);
    this.reels.forEach((reel, index) => {
      reel.setDimmedExceptRows(byReel.get(index) ?? new Set());
    });
  }

  clearWinDimming(progressiveRestore = false): void {
    this.reels.forEach((reel) => reel.setDimmedExceptRows(null, progressiveRestore));
    this.winPresentationActive = false;
    this.syncSymbolIdleState(true);
  }

  /** 符合原规则，已采集的Rage不能再次空闲。 */
  blockSymbolIdle(cells: readonly CellAddress[]): void {
    const byReel = this.rowsByReel(cells);
    this.reels.forEach((reel, index) => {
      reel.blockIdleRows(byReel.get(index) ?? new Set());
    });
  }

  /** 仅将瞬态运动应用于权威中奖中命名的单元格。 */
  setWinMotion(cells: readonly CellAddress[], scale: number, offsetX: number, offsetY: number): void {
    const byReel = this.rowsByReel(cells);
    this.reels.forEach((reel, index) => {
      reel.setWinMotion(byReel.get(index) ?? new Set(), scale, offsetX, offsetY);
    });
  }

  clearWinMotion(): void {
    this.reels.forEach((reel) => reel.clearWinMotion());
  }

  update(deltaMs: number): void {
    // 启动/特性负责人直接驱动投影后的机台根节点。外部附加通道必须在同一帧更新中继承这些表现属性，否则闪电可能在机台淡出/隐藏后仍继续显示。
    this.syncExternalAdditiveOverlayTransforms();
    this.reels.forEach((reel) => reel.update(deltaMs));
    if (this.activatedWildRemainingMs > 0) {
      this.activatedWildRemainingMs = Math.max(
        0,
        this.activatedWildRemainingMs - Math.max(0, deltaMs),
      );
      if (this.activatedWildRemainingMs === 0) this.restoreActivatedWilds();
    }
    this.updateAuthoredFrame(deltaMs);
    this.syncExternalAdditiveOverlayTransforms();
    if (this.symbolIdleActive && this.symbolIdleTimer.advance(Math.max(0, deltaMs))) {
      this.playOneSymbolIdle();
    }
  }

  loadAuthoredFrame(signal?: AbortSignal): Promise<void> {
    if (this.authoredFrameLoad) return this.authoredFrameLoad;
    this.authoredFrameLoad = loadPrimalSpineData("reelFrame").then((data) => {
      if (signal?.aborted) throw signal.reason;
      // 分派的场景拥有一个完整的框架骨架。它是 `reel` 的第一个子项，位于 maskedOverlay 和固定符号叠加层之下。
      const frame = createSpineView(data, { animation: "stop", loop: false });
      const additiveFrame = createSpineView(data, { animation: "stop", loop: false });
      frame.autoUpdate = false;
      additiveFrame.autoUpdate = false;
      frame.visible = true;
      additiveFrame.visible = true;
      frame.update(0);
      additiveFrame.update(0);
      enforcePrimalRegionBlendModes(frame);
      enforcePrimalRegionBlendModes(additiveFrame);
      partitionPrimalAdditiveSlots(frame, "normal");
      partitionPrimalAdditiveSlots(additiveFrame, "additive");
      this.authoredFrame = frame;
      this.authoredFrameAdditive = additiveFrame;
      this.authoredFrameMover = frame.skeleton.findBone("mover");
      this.authoredFrameAdditiveMover = additiveFrame.skeleton.findBone("mover");
      this.positionAuthoredFrame(this.layoutGeometry);
      this.applyAuthoredFrameMover();
      const root = frame.skeleton.findBone("reel_master");
      this.authoredFrameRootX = root?.worldX ?? 0;
      this.authoredFrameRootY = root?.worldY ?? 0;
      this.reelMotionRoot.position.set(0, 0);
      this.trackLayer.addChildAt(frame, 0);
      this.additiveFrameOverlay.addChild(additiveFrame);
      this.frame.visible = false;
      this.frame.renderable = false;
      this.middleFrameShadow.visible = false;
      this.middleFrameShadow.renderable = false;
      this.middleHardware.visible = false;
      this.middleHardware.renderable = false;
      this.hardware.visible = false;
      this.hardware.renderable = false;
      this.waysLabel.visible = false;
      this.waysLabel.renderable = false;
      this.reels.forEach((reel) => reel.setAuthoredCabinet(true));
    });
    return this.authoredFrameLoad;
  }

  get authoredFrameLoaded(): boolean {
    return this.authoredFrame !== null;
  }

  /** 仅在固定的服务器寻址单元上启用原始 Spine 艺术。 */
  setAuthoredSymbolsEnabled(active: boolean): void {
    this.reels.forEach((reel) => reel.setAuthoredSymbolsEnabled(active));
  }

  /** 将制作好的 Spine 实例分帧创建，避免渲染器出现单帧阻塞。 */
  async setAuthoredSymbolsEnabledFrameSliced(
    active: boolean,
    options: ReelViewPreloadOptions = {},
  ): Promise<void> {
    options.onProgress?.(0);
    const completed: ReelView[] = [];
    try {
      for (let reelIndex = 0; reelIndex < this.reels.length; reelIndex += 1) {
        if (options.signal?.aborted) throw options.signal.reason;
        const reel = this.reels[reelIndex];
        if (!reel) continue;
        await reel.setAuthoredSymbolsEnabledFrameSliced(active, {
          signal: options.signal,
          requestFrame: options.requestFrame,
          onProgress: (fraction) => {
            options.onProgress?.((reelIndex + fraction) / this.reels.length);
          },
        });
        completed.push(reel);
      }
      options.onProgress?.(1);
    } catch (error) {
      completed.reverse().forEach((reel) => reel.setAuthoredSymbolsEnabled(!active));
      throw error;
    }
  }

  /** 将所有三个移动条保留在官方 Base/King/Kong 套装上。 */
  setVisualStripMode(mode: FeatureMode): void {
    this.reels.forEach((reel) => reel.setVisualStripMode(mode));
  }

  playAuthoredFrame(animation: string, loop = false, seekSeconds = 0): boolean {
    const frame = this.authoredFrame;
    const additiveFrame = this.authoredFrameAdditive;
    if (!frame?.state.hasAnimation(animation)
      || !additiveFrame?.state.hasAnimation(animation)) return false;
    frame.visible = true;
    additiveFrame.visible = true;
    const entry = frame.state.setAnimation(0, animation, loop);
    const additiveEntry = additiveFrame.state.setAnimation(0, animation, loop);
    if (seekSeconds > 0) entry.trackTime = Math.min(entry.animationEnd, seekSeconds);
    if (seekSeconds > 0) {
      additiveEntry.trackTime = Math.min(additiveEntry.animationEnd, seekSeconds);
    }
    return true;
  }

  private validateGrid(grid: GridCell[][]): void {
    if (grid.length !== 3) throw new Error("Grid must contain exactly three reels");
    const rows = grid[0]?.length ?? 0;
    if (rows < 3 || rows > 8 || grid.some((reel) => reel.length !== rows)) {
      throw new Error("Grid reels must share a row count between 3 and 8");
    }
  }

  private currentCellGeometry(address: CellAddress): ReelCellGeometry | null {
    const geometry = this.layoutGeometry;
    if (!Number.isInteger(address.reel) || !Number.isInteger(address.row)
      || address.reel < 0 || address.reel >= this.reels.length
      || address.row < 0 || address.row >= geometry.rows) return null;
    return {
      x: address.reel * (geometry.reelWidth + geometry.gap),
      y: geometry.cellTopOffset + address.row * geometry.cellHeight,
      width: geometry.reelWidth,
      height: geometry.cellHeight,
    };
  }

  private positionAuthoredFrame(geometry: ReelLayoutGeometry): void {
    const frame = this.authoredFrame;
    if (!frame) return;
    const additiveFrame = this.authoredFrameAdditive;
    // ReelSizeAnimator 给共享层次结构一种统一的尺度；该框架预设的 1.01 乘数已在此处表示。
    this.authoredFrameScaleX = geometry.frameScaleX;
    this.authoredFrameScaleY = geometry.frameScaleY;
    this.authoredFrameBaseX = geometry.areaWidth / 2;
    this.authoredFrameBaseY = geometry.frameBaseY;
    frame.scale.set(this.authoredFrameScaleX, this.authoredFrameScaleY);
    frame.position.set(this.authoredFrameBaseX, this.authoredFrameBaseY);
    additiveFrame?.scale.set(this.authoredFrameScaleX, this.authoredFrameScaleY);
    additiveFrame?.position.set(
      this.authoredFrameBaseX + this.reelMotionRoot.x,
      this.authoredFrameBaseY + this.reelMotionRoot.y,
    );
  }

  private updateAuthoredFrame(deltaMs: number): void {
    const frame = this.authoredFrame;
    if (!frame) return;
    const frameDelta = Math.min(64, Math.max(0, deltaMs)) / 1_000;
    frame.update(frameDelta);
    this.authoredFrameAdditive?.update(frameDelta);
    enforcePrimalRegionBlendModes(frame);
    enforcePrimalRegionBlendModes(this.authoredFrameAdditive);
    partitionPrimalAdditiveSlots(frame, "normal");
    partitionPrimalAdditiveSlots(this.authoredFrameAdditive, "additive");
    this.applyAuthoredFrameMover();
    const root = frame.skeleton.findBone("reel_master");
    if (!root) return;
    // 官方 GameReelFrameView 将 reel_master 增量应用于公共父级 `reel`，因此符号、遮罩和完整框架一起移动。
    this.reelMotionRoot.position.x += this.authoredFrameRootX - root.worldX;
    this.reelMotionRoot.position.y += root.worldY - this.authoredFrameRootY;
    this.authoredFrameRootX = root.worldX;
    this.authoredFrameRootY = root.worldY;
    this.authoredFrameAdditive?.position.set(
      this.authoredFrameBaseX + this.reelMotionRoot.x,
      this.authoredFrameBaseY + this.reelMotionRoot.y,
    );
  }

  private applyAuthoredFrameMover(): void {
    const frame = this.authoredFrame;
    if (!frame) return;
    if (this.authoredFrameMover) this.authoredFrameMover.y = this.authoredFrameMoverY;
    if (this.authoredFrameAdditiveMover) {
      this.authoredFrameAdditiveMover.y = this.authoredFrameMoverY;
    }
    frame.skeleton.updateWorldTransform();
    this.authoredFrameAdditive?.skeleton.updateWorldTransform();
  }

  private rowsByReel(cells: readonly CellAddress[]): Map<number, Set<number>> {
    const byReel = new Map<number, Set<number>>();
    for (const cell of cells) {
      if (cell.reel < 0 || cell.reel >= this.reels.length || cell.row < 0 || cell.row >= this.rowCount) continue;
      const rows = byReel.get(cell.reel) ?? new Set<number>();
      rows.add(cell.row);
      byReel.set(cell.reel, rows);
    }
    return byReel;
  }

  private cellKey(address: CellAddress): string {
    return `${address.reel}:${address.row}`;
  }

  private syncSymbolIdleState(forceReset = false): void {
    const shouldRun = primalSymbolIdleShouldRun({
      dormant: this.dormant,
      spinActive: this.spinActive,
      winPresentationActive: this.winPresentationActive,
      structuralTransitionActive: this.structuralTransitionActive,
      rageCascadeActive: this.rageCascadeActive,
    });
    if (shouldRun && (!this.symbolIdleActive || forceReset)) this.symbolIdleTimer.reset();
    this.symbolIdleActive = shouldRun;
  }

  private playOneSymbolIdle(): void {
    const symbols = this.reels.flatMap((reel) => [...reel.visibleSymbolViews()]);
    for (const index of primalSymbolIdleOrder(symbols.length, this.symbolIdleRandom)) {
      if (symbols[index]?.playIdleAnimation()) return;
    }
  }

  private drawFrame(geometry: ReelLayoutGeometry): void {
    const frame = this.frame;
    const middleFrameShadow = this.middleFrameShadow;
    const middleHardware = this.middleHardware;
    const hardware = this.hardware;
    const { areaWidth, areaHeight, reelWidth, gap } = geometry;
    frame.clear();
    middleFrameShadow.clear();
    middleHardware.clear();
    hardware.clear();

    // 一个带有定向面的锻造外壳取代了旧的一叠统一的同心轮廓。顶部/左侧平面捕捉炫酷的主光；底部/右侧平面保留粗糙的高遮挡边缘。回退路径外壳现在位于顶部硬件层，
    // 因此它必须是空心锻造轮辋，而不是旧的全区域背板。
    frame.lineStyle(18, 0x010202, 0.46)
      .drawRoundedRect(-22, -17, areaWidth + 44, areaHeight + 44, 24);
    frame.lineStyle(12, 0x060809, 1)
      .drawRoundedRect(-18, -18, areaWidth + 36, areaHeight + 36, 20);
    frame.lineStyle(5, 0x101314, 1)
      .drawRoundedRect(-12, -12, areaWidth + 24, areaHeight + 24, 16);

    frame.beginFill(0x1a1e1f, 0.98).drawPolygon([
      -18, -18, areaWidth + 18, -18,
      areaWidth + 10, 7, -10, 7,
    ]).endFill();
    frame.beginFill(0x141819, 0.98).drawPolygon([
      -18, -18, -10, 7, -10, areaHeight - 7, -18, areaHeight + 18,
    ]).endFill();
    frame.beginFill(0x090b0c, 1).drawPolygon([
      -10, areaHeight - 7, areaWidth + 10, areaHeight - 7,
      areaWidth + 18, areaHeight + 18, -18, areaHeight + 18,
    ]).endFill();
    frame.beginFill(0x07090a, 1).drawPolygon([
      areaWidth + 10, 7, areaWidth + 18, -18,
      areaWidth + 18, areaHeight + 18, areaWidth + 10, areaHeight - 7,
    ]).endFill();

    // 深的内倒角，左上狭窄的镜面反射捕捉，然后是故意粗糙的右下边缘。只有被照亮的一面才会露出干净的银色。
    frame.lineStyle(7, 0x030405, 0.94).drawRoundedRect(-9, -9, areaWidth + 18, areaHeight + 18, 15);
    frame.lineStyle(1.35, 0xd1d5d2, 0.55);
    frame.moveTo(-11, -15).lineTo(areaWidth - 27, -15);
    frame.moveTo(-15, -11).lineTo(-15, areaHeight - 28);
    frame.lineStyle(4.2, 0x020303, 0.88);
    frame.moveTo(18, areaHeight + 15).lineTo(areaWidth + 13, areaHeight + 15);
    frame.moveTo(areaWidth + 15, 18).lineTo(areaWidth + 15, areaHeight + 13);

    this.drawSurfacePatch(frame, -18, -18, areaWidth + 36, 25, 0x1a0c01, "horizontal", 58, 7);
    this.drawSurfacePatch(frame, -18, areaHeight - 7, areaWidth + 36, 25, 0x1a0c02, "horizontal", 48, 8);
    this.drawSurfacePatch(frame, -18, 7, 25, areaHeight - 14, 0x1a0c03, "vertical", 35, 5);
    this.drawSurfacePatch(frame, areaWidth - 7, 7, 25, areaHeight - 14, 0x1a0c04, "vertical", 31, 6);

    const outerWear = sampleEdgeWear({
      seed: 0xc011055,
      width: areaWidth + 36,
      height: areaHeight + 36,
      count: 28,
    }, 4.5);
    outerWear.forEach((mark) => {
      const alpha = mark.alpha * mark.exposure;
      frame.lineStyle(mark.width + 1.1, 0x030404, alpha * 0.72);
      frame.moveTo(mark.x1 - 18 + 0.7, mark.y1 - 18 + 0.8);
      frame.lineTo(mark.x2 - 18 + 0.7, mark.y2 - 18 + 0.8);
      frame.lineStyle(mark.width, 0xc9ccc7, alpha);
      frame.moveTo(mark.x1 - 18, mark.y1 - 18);
      frame.lineTo(mark.x2 - 18, mark.y2 - 18);
    });

    // 侧窗唇属于外柜。卷轴 2 在最后的顶部通道中接收其自己的官方链笼，此处省略。
    for (const reel of [0, 2]) {
      const x = reel * (reelWidth + gap);
      hardware.lineStyle(4, 0x030405, 0.96);
      hardware.drawRoundedRect(x - 2, -2, reelWidth + 4, areaHeight + 4, 13);
      hardware.lineStyle(1.25, 0xc8cdca, 0.39);
      hardware.moveTo(x + 12, 0).lineTo(x + reelWidth - 17, 0);
      hardware.moveTo(x, 13).lineTo(x, areaHeight - 22);
      hardware.lineStyle(2.4, 0x111415, 0.98);
      hardware.moveTo(x + 16, areaHeight + 1).lineTo(x + reelWidth - 10, areaHeight + 1);
      hardware.moveTo(x + reelWidth + 1, 15).lineTo(x + reelWidth + 1, areaHeight - 12);
    }

    this.drawMiddleFrameShadow(
      middleFrameShadow,
      reelWidth + gap,
      reelWidth,
      areaHeight,
    );
    this.drawMiddleChainFrame(
      middleHardware,
      reelWidth + gap,
      reelWidth,
      areaHeight,
    );

    // 所有主要负载点均采用嵌入式六角形紧固件。
    for (const [x, y] of [
      [-12, -12], [areaWidth + 12, -12],
      [-12, areaHeight + 12], [areaWidth + 12, areaHeight + 12],
      [areaWidth * 0.5, -16], [areaWidth * 0.5, areaHeight + 16],
    ] as const) {
      this.drawCabinetBolt(hardware, x, y, 7);
    }
  }

  private drawMiddleFrameShadow(
    graphics: Graphics,
    x: number,
    width: number,
    height: number,
  ): void {
    // 保留为自己的持久节点：加载预设的链仅隐藏回退路径金属，而不会隐藏这种向外的接触阴影。
    graphics.lineStyle(14, 0x010202, 0.27);
    graphics.drawRoundedRect(x - 5, -2, width + 12, height + 12, 10);
    graphics.lineStyle(7, 0x010202, 0.22);
    graphics.drawRoundedRect(x - 7, -5, width + 14, height + 14, 11);
  }

  private drawMiddleChainFrame(
    graphics: Graphics,
    x: number,
    width: number,
    height: number,
  ): void {
    graphics.lineStyle(6, 0x090b0c, 0.94);
    graphics.drawRoundedRect(x - 4, -6, width + 8, height + 12, 7);

    const drawLink = (cx: number, cy: number, horizontal: boolean): void => {
      const linkWidth = horizontal ? 18 : 9;
      const linkHeight = horizontal ? 9 : 18;
      graphics.lineStyle(3.2, 0x111414, 1);
      graphics.drawRoundedRect(
        cx - linkWidth / 2 + 1.4,
        cy - linkHeight / 2 + 2,
        linkWidth,
        linkHeight,
        Math.min(linkWidth, linkHeight) * 0.42,
      );
      graphics.lineStyle(1.7, 0xb9bfbd, 0.72);
      graphics.drawRoundedRect(
        cx - linkWidth / 2,
        cy - linkHeight / 2,
        linkWidth,
        linkHeight,
        Math.min(linkWidth, linkHeight) * 0.42,
      );
    };

    const verticalStep = Math.max(15, Math.min(24, height / 13));
    for (let y = 7, index = 0; y < height; y += verticalStep, index += 1) {
      drawLink(x - 3, y, index % 2 === 1);
      drawLink(x + width + 3, y + verticalStep * 0.38, index % 2 === 0);
    }
    const horizontalStep = Math.max(16, Math.min(25, width / 7));
    for (let offset = 5, index = 0; offset < width; offset += horizontalStep, index += 1) {
      drawLink(x + offset, -5, index % 2 === 0);
      drawLink(x + offset + horizontalStep * 0.35, height + 5, index % 2 === 1);
    }
  }

  private drawSurfacePatch(
    graphics: Graphics,
    x: number,
    y: number,
    width: number,
    height: number,
    seed: number,
    direction: SurfaceDirection,
    brushCount: number,
    scratchCount: number,
  ): void {
    const brush = sampleBrushedSteel({ seed, width, height, count: brushCount, direction });
    brush.forEach((stroke) => {
      graphics.lineStyle(
        stroke.width,
        stroke.tone === "bright" ? 0xbec3c0 : 0x020303,
        stroke.alpha,
      );
      graphics.moveTo(x + stroke.x1, y + stroke.y1).lineTo(x + stroke.x2, y + stroke.y2);
    });
    const scratches = sampleScratches({ seed: seed ^ 0x5ca7c4, width, height, count: scratchCount, direction });
    scratches.forEach((scratch) => {
      graphics.lineStyle(scratch.width + 0.8, 0x020303, scratch.alpha * 0.68);
      graphics.moveTo(x + scratch.x1 + 0.65, y + scratch.y1 + 0.75);
      graphics.lineTo(x + scratch.x2 + 0.65, y + scratch.y2 + 0.75);
      graphics.lineStyle(
        scratch.width * 0.72,
        scratch.tone === "bright" ? 0xbfc3be : 0x343839,
        scratch.alpha * (scratch.tone === "bright" ? 0.78 : 0.5),
      );
      graphics.moveTo(x + scratch.x1, y + scratch.y1).lineTo(x + scratch.x2, y + scratch.y2);
    });
  }

  private drawCabinetBolt(graphics: Graphics, cx: number, cy: number, radius: number): void {
    const points: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const angle = Math.PI / 6 + index * Math.PI / 3;
      points.push(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    }
    graphics.beginFill(0x010202, 0.92).drawCircle(cx + 1.5, cy + 2, radius * 1.25).endFill();
    graphics.lineStyle(1.5, 0x111313, 1);
    graphics.beginFill(0x666968, 1).drawPolygon(points).endFill();
    graphics.lineStyle(1, 0xd3d4ce, 0.48);
    graphics.moveTo(cx - radius * 0.45, cy - radius * 0.34).lineTo(cx + radius * 0.35, cy - radius * 0.5);
    graphics.lineStyle(1.4, 0x252728, 0.96);
    graphics.moveTo(cx - radius * 0.43, cy).lineTo(cx + radius * 0.43, cy);
  }
}
