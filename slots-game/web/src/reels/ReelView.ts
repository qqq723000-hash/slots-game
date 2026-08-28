import { BLEND_MODES, Container, Graphics, Point, filters } from "pixi.js";
import type { GridCell } from "../app/state/types";
import type { SpinEnvironmentFrame } from "../renderer/spinEnvironmentMotion";
import type { VisualTelemetryReporter } from "../renderer/VisualTelemetry";
import {
  runFrameSlicedInitialization,
  type FrameRequest,
} from "../startup/frameSlicedInitialization";
import { sampleBrushedSteel, sampleScratches } from "../renderer/surfaceMaterial";
import {
  createReelStopMotionPlan,
  createReelStopMotionPlanForMode,
  MAX_REEL_FRAME_DELTA_MS,
  REEL_PRESENTATION_FIRST_VIEW_ROW,
  reelPresentationCellCount,
  reelPresentationCells,
  reelSettleFrame,
  reelSpinProfile,
  reelStartPositionDeltaRowsAt,
  reelStartVelocityRowsAt,
  reelStopMotionConfig,
  reelStopHasReachedImpact,
  reelStopPositionRowsAt,
  reelStopVelocityRowsAt,
  type ReelResultInsertion,
  type ReelStopMode,
  type ReelVisualStripMode,
  type ReelSpinProfile,
} from "./reelMotion";
import { PRIMAL_BLURRED_SYMBOL_PLACEHOLDER } from "./primalSymbolSpines";
import { PRIMAL_REEL_TIMING_MS } from "./primalAnimationTiming";
import {
  SymbolView,
  type SymbolVaultCaptureDiagnostics,
} from "./SymbolView";

export const REEL_VIEW_LAYER_NAMES = Object.freeze({
  track: "reel-track",
  symbols: "reel-symbol-viewport",
  mask: "reel-symbol-mask",
  shadow: "reel-track-shadow",
  winningAdditive: "winning-symbol-additive-reel",
} as const);

export const PRIMAL_REEL_MAX_PRELOADED_ROWS = 8;
export const PRIMAL_REEL_SYMBOL_INIT_BATCH_CAP = 4;
export const PRIMAL_REEL_AUTHORED_INIT_BATCH_CAP = 4;

export interface ReelViewPreloadOptions {
  readonly signal?: AbortSignal;
  readonly requestFrame?: FrameRequest;
  readonly onProgress?: (fraction: number) => void;
}

export interface ReelViewportMaskGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
}

export interface AuthoredPlaybackBatchResult {
  readonly attempted: number;
  readonly played: number;
}

/** 捕获诊断使用的实时卷轴视口的简单、不可变的投影。 */
export interface ReelViewportCompositionDiagnostics {
  readonly reelIndex: number;
  readonly name: string;
  readonly position: Readonly<{ x: number; y: number }>;
  readonly scale: Readonly<{ x: number; y: number }>;
  readonly maskName: string;
  readonly maskRect: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly movingOverlayMasked: boolean;
  readonly settledOverlayMasked: boolean;
}

export interface ReelVaultCaptureDiagnostics extends SymbolVaultCaptureDiagnostics {
  readonly reel: number;
  readonly row: number;
}

/** 在卷轴运动期间捕获 GameSymbol 模糊豁免。 */
export function reelCellStaysSharpDuringSpin(cell: Readonly<GridCell>): boolean {
  return cell.symbol === "SURGE"
    || (cell.symbol === "VAULT"
      && (cell.prize !== undefined || cell.multiplier !== undefined));
}

/** 传送带显示普通的 Wild，直到预设的 500ms 显示门。 */
export function reelStopPresentationCell(cell: Readonly<GridCell>): GridCell {
  if (cell.symbol === "WILD" && cell.multiplier !== undefined) return { symbol: "WILD" };
  return { ...cell };
}

/** 投影完整卷轴合成之前的官方组合掩模边界。 */
export function reelViewportMaskGeometry(
  _reelIndex: number,
  width: number,
  height: number,
  authoredCabinet: boolean,
): ReelViewportMaskGeometry {
  const safeWidth = Math.max(0, Number.isFinite(width) ? width : 0);
  const safeHeight = Math.max(0, Number.isFinite(height) ? height : 0);
  return {
    x: 0,
    y: 0,
    width: safeWidth,
    height: safeHeight,
    radius: authoredCabinet ? 0 : Math.max(0, Math.min(14, safeWidth * 0.06)),
  };
}

type NamedContainer = Container & { name: string };

function namedContainer(name: string): NamedContainer {
  const container = new Container() as NamedContainer;
  container.name = name;
  return container;
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 为调用者保留旧版公共采样器；现在代表测量到的300ms刹车+350ms正立方反弹而不是捏造的反弹。
 */
export function settleBounceOffset(progress: number): number {
  return reelSettleFrame(progress, 100).resultOffset;
}

export function settleBlurStrength(progress: number): number {
  return reelSettleFrame(progress, 100).resultBlurY;
}

export class ReelView extends Container {
  /** 第 1 层：该卷轴的稳定轨道支撑；永远不会因符号删除而发生突变。 */
  private readonly trackLayer: NamedContainer;
  /** 第 2 层尾部：独立的嵌入式灯覆盖在该卷轴符号上方。 */
  private readonly trackShadowLayer: NamedContainer;
  private readonly glassBackdrop = new Graphics();
  private readonly symbols = new Container();
  /** 镜像、未屏蔽的固定符号分支安装在 ReelSetView 外部。 */
  readonly winningSymbolAdditiveDisplay = namedContainer(
    REEL_VIEW_LAYER_NAMES.winningAdditive,
  );
  private readonly winningSettledAdditiveLayer = namedContainer(
    "winning-symbol-additive-settled-overlay",
  );
  private readonly symbolViews: SymbolView[] = [];
  /** 每个卷轴有一个覆盖层，与 rageSymbolTriggerOverlay.child0..2 完全相同。 */
  private readonly rageCascadeOverlay = new SymbolView(false, true);
  /** 官方 maskedOverlay/reelOverlay：仅移动内容。 */
  private readonly maskedOverlay = new Container();
  private readonly motionLayer = new Container();
  /** 普通的移动符号共享官方的垂直模糊。 */
  private readonly spinSymbols = new Container();
  /** Rage 和已解锁的 Vault 在皮带移动时保持锋利。 */
  private readonly spinSharpSymbols = new Container();
  private readonly spinSymbolViews: SymbolView[] = [];
  private readonly clip = new Graphics();
  private readonly energyVeil = new Graphics();
  private readonly environmentReflection = new Container();
  private readonly environmentWarmReflection = new Graphics();
  private readonly environmentAuraReflection = new Graphics();
  private readonly environmentDustReflection = new Graphics();
  private readonly environmentCoreReflection = new Graphics();
  private readonly dormantPlate = new Graphics();
  private readonly glassSurface = new Graphics();
  private readonly trackShadow = new Graphics();
  private readonly stopImpact = new Graphics();
  private readonly motionBlur = new filters.BlurFilter(
    PRIMAL_BLURRED_SYMBOL_PLACEHOLDER.blurStrength,
    PRIMAL_BLURRED_SYMBOL_PLACEHOLDER.quality,
    1,
    5,
  );
  private readonly environmentReflectionBlur = new filters.BlurFilter(6, 1);
  private reelWidth = 220;
  private symbolWidth = 220;
  private symbolOffsetX = 0;
  private reelHeight = 420;
  private rowCount = 3;
  private layoutCellHeight = 140;
  private layoutTopOffset = 0;
  private authoredCabinet = false;
  private authoredSymbolsEnabled = false;
  private lastCells: GridCell[] = [];
  private environmentFrame: SpinEnvironmentFrame | null = null;
  private readonly spinProfile: ReelSpinProfile;
  private readonly reelIndex: number;
  private spinning = false;
  private stopping = false;
  private reducedMotion = false;
  private phase = 0;
  private spinElapsedMs = 0;
  private spinOriginRows = 0;
  private decorativeWholeSteps = 0;
  private visualStripMode: ReelVisualStripMode = "BASE";
  private resultInsertion: ReelResultInsertion | null = null;
  private animationGeneration = 0;
  private activeStopMode: ReelStopMode | null = null;
  private stopImpactCommitted = false;
  private stopImpactRequestedMode: ReelStopMode | null = null;
  private stopTargetRows: number | null = null;
  private stopPresentationRows = 0;
  private stopTargetReached = false;
  private slowQuickStopRequested = false;
  private maximumRowsPrepared = false;
  private maximumRowsPreparation: Promise<void> | null = null;
  private visualTelemetry: VisualTelemetryReporter | null = null;

  constructor(reelIndex = 0) {
    super();
    this.reelIndex = reelIndex;
    this.trackLayer = namedContainer(`${REEL_VIEW_LAYER_NAMES.track}-${reelIndex + 1}`);
    this.trackShadowLayer = namedContainer(`${REEL_VIEW_LAYER_NAMES.shadow}-${reelIndex + 1}`);
    (this as Container & { name: string }).name = `${REEL_VIEW_LAYER_NAMES.symbols}-${reelIndex + 1}`;
    (this.clip as Graphics & { name: string }).name = `${REEL_VIEW_LAYER_NAMES.mask}-${reelIndex + 1}`;
    this.winningSymbolAdditiveDisplay.name =
      `${REEL_VIEW_LAYER_NAMES.winningAdditive}-${reelIndex + 1}`;
    this.winningSettledAdditiveLayer.name =
      `winning-symbol-additive-settled-overlay-${reelIndex + 1}`;
    this.winningSymbolAdditiveDisplay.addChild(this.winningSettledAdditiveLayer);
    // 可移动的 Rage 级联视图还拥有预设的 ADD 附件。将其双胞胎保留在第一帧的外部后置滤波器分支中。
    this.winningSettledAdditiveLayer.addChild(
      this.rageCascadeOverlay.winningAdditiveDisplay,
    );
    this.spinProfile = reelSpinProfile(reelIndex);
    // 官方组合掩模剪辑 reelOverlay，而固定符号移动到 symbolOverlay/highlightOverlay 并保留其预设的过扫描。
    this.maskedOverlay.mask = this.clip;
    this.motionBlur.blurX = PRIMAL_BLURRED_SYMBOL_PLACEHOLDER.blurX;
    this.motionBlur.blurY = PRIMAL_BLURRED_SYMBOL_PLACEHOLDER.blurY;
    this.motionBlur.repeatEdgePixels = PRIMAL_BLURRED_SYMBOL_PLACEHOLDER.repeatEdgePixels;
    this.energyVeil.visible = false;
    this.stopImpact.visible = false;
    this.motionLayer.addChild(this.spinSymbols, this.spinSharpSymbols, this.energyVeil);
    this.motionLayer.visible = false;
    this.environmentReflection.addChild(
      this.environmentWarmReflection,
      this.environmentAuraReflection,
      this.environmentDustReflection,
    );
    this.environmentReflection.filters = [this.environmentReflectionBlur];
    this.environmentWarmReflection.blendMode = BLEND_MODES.SCREEN;
    this.environmentAuraReflection.blendMode = BLEND_MODES.SCREEN;
    this.environmentDustReflection.blendMode = BLEND_MODES.SCREEN;
    this.environmentCoreReflection.blendMode = BLEND_MODES.SCREEN;
    this.trackLayer.addChild(this.glassBackdrop);
    this.trackShadowLayer.addChild(this.trackShadow, this.glassSurface);
    this.maskedOverlay.addChild(this.motionLayer, this.stopImpact);
    this.addChild(
      this.symbols,
      this.dormantPlate,
      this.maskedOverlay,
      this.environmentReflection,
      this.environmentCoreReflection,
      this.glassSurface,
      this.clip,
    );
    this.ensureSymbols(3);
    this.rageCascadeOverlay.visible = false;
    this.syncSettledSymbolOrder();
  }

  setVisualTelemetryReporter(reporter: VisualTelemetryReporter | null): void {
    this.visualTelemetry = reporter;
  }

  /** 稳定的第 1 层节点安装在每个符号视口之前。 */
  get trackDisplay(): Container {
    return this.trackLayer;
  }

  /** 稳定的符号后阴影节点安装在任一硬件框架下方。 */
  get trackShadowDisplay(): Container {
    return this.trackShadowLayer;
  }

  /** 将三个分割显示节点保持在一个精确的卷轴本地坐标空间中。 */
  setLayerPosition(x: number, y: number): void {
    this.position.set(x, y);
    this.trackLayer.position.set(x, y);
    this.trackShadowLayer.position.set(x, y);
    this.syncWinningSymbolAdditiveTransform();
  }

  setLayout(width: number, height: number, rows: number, symbolWidth = width): void {
    this.applyLayout(width, height, rows, height / rows, 0, symbolWidth);
  }

  /**
   * 通过不断增长的掩模显示出更高的固定尺寸条带。目标行布置在未更改的底部边缘上方，因此扩展不会压缩符号或跳跃完整的行。
   */
  setExpansionLayout(
    width: number,
    height: number,
    targetRows: number,
    cellHeight: number,
    symbolWidth = width,
  ): void {
    this.applyLayout(
      width,
      height,
      targetRows,
      cellHeight,
      height - targetRows * cellHeight,
      symbolWidth,
    );
  }

  private applyLayout(
    width: number,
    height: number,
    rows: number,
    cellHeight: number,
    topOffset: number,
    symbolWidth: number,
  ): void {
    const rowCountChanged = this.rowCount !== rows;
    const currentPositionRows = this.decorativeWholeSteps
      + this.phase / Math.max(1, this.layoutCellHeight);
    this.reelWidth = width;
    this.symbolWidth = Math.max(0, Math.min(width, symbolWidth));
    this.symbolOffsetX = (width - this.symbolWidth) / 2;
    this.reelHeight = height;
    this.rowCount = rows;
    this.layoutCellHeight = cellHeight;
    this.layoutTopOffset = topOffset;
    if (rowCountChanged && this.resultInsertion?.cells.length !== rows) {
      this.resultInsertion = null;
    }
    this.ensureSymbols(rows);
    if (this.maximumRowsPrepared) this.ensureSpinSymbols(reelPresentationCellCount(rows));
    this.drawClip();
    this.symbolViews.forEach((symbol, row) => {
      symbol.visible = row < rows;
      symbol.position.set(this.symbolOffsetX, topOffset + row * cellHeight);
      symbol.setSize(this.symbolWidth, cellHeight);
    });
    this.rageCascadeOverlay.position.x = this.symbolOffsetX;
    this.rageCascadeOverlay.setSize(this.symbolWidth, cellHeight);
    this.layoutSpinSymbols();
    if (this.spinning) {
      if (rowCountChanged) this.syncSpinSymbols();
      this.spinSymbols.visible = true;
      if (!this.reducedMotion && !this.stopping) this.applySpinFrame();
      else this.applyPresentationPositionRows(currentPositionRows);
    }
    this.drawEnergyVeil();
    this.drawGlass();
    this.drawTrackShadow();
    this.drawEnvironmentReflection();
    this.drawStopImpact();
    this.drawDormantPlate();
    this.applyEnvironmentFrame();
    this.syncWinningSymbolAdditiveTransform();
  }

  /**
   * 复刻的转轴框架 Spine 已提供磨砂玻璃背板和钢制窗沿。程序绘制仅作为加载失败时的回退，因此绝不会与制作好的机台外框重复叠加。
   */
  setAuthoredCabinet(active: boolean): void {
    if (this.authoredCabinet === active) return;
    this.authoredCabinet = active;
    this.glassBackdrop.visible = !active;
    this.glassBackdrop.renderable = !active;
    this.glassSurface.visible = !active;
    this.glassSurface.renderable = !active;
    this.trackShadow.visible = !active;
    this.trackShadow.renderable = !active;
    // 当符号旋转、着陆或由 Rage 功能提取时，仅回退路径照明不得对预设的轨道重新着色。
    this.environmentReflection.visible = !active;
    this.environmentReflection.renderable = !active;
    this.environmentCoreReflection.visible = !active;
    this.environmentCoreReflection.renderable = !active;
    this.drawClip();
  }

  /**
   * 预先分配 3x8 模式所需的所有固定和移动 SymbolView。每个帧切片只有通过取消检查后才会按上限构造并提交，因此 Kong 扩展时无需首次即时创建。
   */
  prepareMaximumRows(options: ReelViewPreloadOptions = {}): Promise<void> {
    if (this.maximumRowsPrepared) {
      options.onProgress?.(1);
      return Promise.resolve();
    }
    if (this.maximumRowsPreparation) return this.maximumRowsPreparation;

    const settledCount = Math.max(
      0,
      PRIMAL_REEL_MAX_PRELOADED_ROWS - this.symbolViews.length,
    );
    const spinCount = Math.max(
      0,
      reelPresentationCellCount(PRIMAL_REEL_MAX_PRELOADED_ROWS)
        - this.spinSymbolViews.length,
    );
    const createdSettled: SymbolView[] = [];
    const createdSpin: SymbolView[] = [];
    let committed = false;
    const attempt = runFrameSlicedInitialization(
      settledCount + spinCount,
      (start, count) => {
        for (let offset = 0; offset < count; offset += 1) {
          const index = start + offset;
          if (index < settledCount) {
            createdSettled.push(new SymbolView(this.authoredSymbolsEnabled));
          } else {
            createdSpin.push(new SymbolView());
          }
        }
      },
      {
        batchSize: PRIMAL_REEL_SYMBOL_INIT_BATCH_CAP,
        signal: options.signal,
        requestFrame: options.requestFrame,
        isCancelled: () => this.isDestroyed(),
        onProgress: options.onProgress,
      },
    ).then(() => {
      if (options.signal?.aborted) throw options.signal.reason;
      this.symbolViews.push(...createdSettled);
      this.symbols.addChild(...createdSettled);
      this.winningSettledAdditiveLayer.addChild(
        ...createdSettled.map((symbol) => symbol.winningAdditiveDisplay),
      );
      this.syncSettledSymbolOrder();
      this.spinSymbolViews.push(...createdSpin);
      this.spinSymbols.addChild(...createdSpin);
      this.maximumRowsPrepared = true;
      this.ensureSymbols(this.rowCount);
      this.ensureSpinSymbols(reelPresentationCellCount(this.rowCount));
      // 合并的固定视图在 (0, 0) 处可见。立即提交其活动行可见性和未来行坐标，或者休眠的 3x8 行使用其默认 Jet 单元覆盖 Base 第一行，直到发生另一种结构布局。
      this.symbolViews.forEach((symbol, row) => {
        symbol.visible = row < this.rowCount;
        symbol.position.set(
          this.symbolOffsetX,
          this.layoutTopOffset + row * this.layoutCellHeight,
        );
        symbol.setSize(this.symbolWidth, this.layoutCellHeight);
      });
      this.layoutSpinSymbols();
      this.syncWinningSymbolAdditiveTransform();
      committed = true;
    }).finally(() => {
      if (!committed) {
        createdSettled.forEach((symbol) => symbol.destroy({ children: true }));
        createdSpin.forEach((symbol) => symbol.destroy({ children: true }));
      }
      if (!this.maximumRowsPrepared) this.maximumRowsPreparation = null;
    });
    this.maximumRowsPreparation = attempt;
    return attempt;
  }

  /** 已停稳单元格使用捕获的骨骼；移动的条带保持静止。 */
  setAuthoredSymbolsEnabled(active: boolean): void {
    if (this.authoredSymbolsEnabled === active) return;
    this.authoredSymbolsEnabled = active;
    this.symbolViews.forEach((symbol) => symbol.setAuthoredAnimationEnabled(active));
    this.rageCascadeOverlay.setAuthoredAnimationEnabled(active);
  }

  /** 实例化有界框架切片中预设的固定单元 Spine 视图。 */
  async setAuthoredSymbolsEnabledFrameSliced(
    active: boolean,
    options: ReelViewPreloadOptions = {},
  ): Promise<void> {
    if (this.authoredSymbolsEnabled === active) {
      options.onProgress?.(1);
      return;
    }
    const previous = this.authoredSymbolsEnabled;
    const views = [...this.symbolViews, this.rageCascadeOverlay];
    let changed = 0;
    try {
      await runFrameSlicedInitialization(
        views.length,
        (start, count) => {
          for (let offset = 0; offset < count; offset += 1) {
            views[start + offset]?.setAuthoredAnimationEnabled(active);
          }
          changed = start + count;
        },
        {
          batchSize: PRIMAL_REEL_AUTHORED_INIT_BATCH_CAP,
          signal: options.signal,
          requestFrame: options.requestFrame,
          isCancelled: () => this.isDestroyed(),
          onProgress: options.onProgress,
        },
      );
      this.authoredSymbolsEnabled = active;
    } catch (error) {
      if (!this.isDestroyed()) {
        for (let index = 0; index < changed; index += 1) {
          views[index]?.setAuthoredAnimationEnabled(previous);
        }
      }
      throw error;
    }
  }

  /** 选择捕获的 Base/King/Kong 客户端条而不触及结果。 */
  setVisualStripMode(mode: ReelVisualStripMode): void {
    if (this.visualStripMode === mode) return;
    this.visualStripMode = mode;
    // 官方selectReelStripSet()将spinner.position重置为零。
    this.phase = 0;
    this.spinElapsedMs = 0;
    this.spinOriginRows = 0;
    this.decorativeWholeSteps = 0;
    this.resultInsertion = null;
    if (this.spinning) this.syncSpinSymbols();
  }

  private isDestroyed(): boolean {
    return (this as Container & { transform: unknown | null }).transform === null;
  }

  setCells(
    cells: GridCell[],
    deferWildVariant = false,
    forceLockedVaultRows: ReadonlySet<number> = new Set(),
  ): void {
    if (cells.length !== this.rowCount) throw new Error("Reel cells do not match active row count");
    this.lastCells = cells.map((cell) => ({ ...cell }));
    if (this.resultInsertion?.cells.length === cells.length) {
      this.resultInsertion = {
        ...this.resultInsertion,
        cells: cells.map((cell) => ({ ...cell })),
      };
    }
    this.clearRageCascadePresentation();
    cells.forEach((cell, row) => this.symbolViews[row]?.setCell(cell, {
      deferWildVariant,
      forceLockedVault: forceLockedVaultRows.has(row),
    }));
    this.setDormant(false);
  }

  setDormant(active: boolean): void {
    this.dormantPlate.visible = active;
    this.symbols.visible = !active;
    this.syncWinningSymbolAdditiveTransform();
  }

  /** 整个机台共用的一次性空闲调度器所使用的当前各行主视图。 */
  visibleSymbolViews(): readonly SymbolView[] {
    return this.symbolViews.slice(0, this.rowCount);
  }

  /**
   * 仅浏览器捕获事实。每个值都是从实时显示节点复制的，因此观察者无法保留或改变 Pixi 对象。
   */
  getViewportCompositionDiagnostics(): Readonly<ReelViewportCompositionDiagnostics> {
    const bounds = this.clip.getLocalBounds();
    return Object.freeze({
      reelIndex: this.reelIndex,
      name: this.name ?? "",
      position: Object.freeze({ x: this.position.x, y: this.position.y }),
      scale: Object.freeze({ x: this.scale.x, y: this.scale.y }),
      maskName: this.clip.name ?? "",
      maskRect: Object.freeze({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }),
      movingOverlayMasked: this.maskedOverlay.mask === this.clip,
      settledOverlayMasked: this.symbols.mask === this.clip,
    });
  }

  cellAt(row: number): Readonly<GridCell> | null {
    const cell = this.lastCells[row];
    return cell ? { ...cell } : null;
  }

  /** 针对一个服务器寻址的 Vault 单元的简单、冻结诊断。 */
  getVaultCaptureDiagnostics(row: number): Readonly<ReelVaultCaptureDiagnostics> | null {
    const symbol = this.symbolViews[row];
    if (!symbol || row < 0 || row >= this.rowCount) return null;
    return Object.freeze({
      reel: this.reelIndex,
      row,
      ...symbol.getVaultCaptureDiagnostics(),
    });
  }

  setCellAt(row: number, cell: GridCell): boolean {
    if (!Number.isInteger(row) || row < 0 || row >= this.rowCount) return false;
    this.lastCells[row] = { ...cell };
    this.symbolViews[row]?.setCell(cell);
    if (this.resultInsertion?.cells.length === this.rowCount) {
      const insertedCells = this.resultInsertion.cells.map((inserted, index) => (
        index === row ? { ...cell } : { ...inserted }
      ));
      this.resultInsertion = { ...this.resultInsertion, cells: insertedCells };
    }
    return true;
  }

  /**
   * GameSymbol.playScatterCollect 首先将 Rage 从 highlightOverlay 移动到 activatedOverlay，
   * 然后启动其预设的收集/隐藏队列。保持权威固定视图及其世界位置不变，同时仅更改显示所有权。
   */
  beginSurgeCollection(
    row: number,
    activatedHost?: Container,
    additiveActivatedHost?: Container,
  ): boolean {
    const symbol = this.symbolViews[row];
    if (!symbol || symbol.cell.symbol !== "SURGE") return false;
    if (activatedHost && symbol.parent !== activatedHost) {
      symbol.syncWinningAdditiveDisplayTransform();
      this.reparentSymbolPreservingPosition(symbol, activatedHost);
      if (additiveActivatedHost) {
        this.reparentSymbolPreservingPosition(
          symbol.winningAdditiveDisplay,
          additiveActivatedHost,
        );
      }
      symbol.syncWinningAdditiveDisplayTransform();
    }
    symbol.setIdleBlocked(true);
    return symbol.playCollectAnimation();
  }

  /** 仅恢复 1000ms 收集剪辑之后已处理的收集的 Rage。 */
  restoreSurgeCollectionLayer(
    row: number,
    activatedHost: Container,
    additiveActivatedHost?: Container,
  ): boolean {
    const symbol = this.symbolViews[row];
    if (!symbol || symbol.cell.symbol !== "SURGE" || symbol.parent !== activatedHost) {
      return false;
    }
    this.reparentSymbolPreservingPosition(symbol, this.symbols);
    if (additiveActivatedHost
      && symbol.winningAdditiveDisplay.parent === additiveActivatedHost) {
      this.reparentSymbolPreservingPosition(
        symbol.winningAdditiveDisplay,
        this.winningSettledAdditiveLayer,
      );
    }
    symbol.syncWinningAdditiveDisplayTransform();
    this.syncSettledSymbolOrder();
    return true;
  }

  isSurgeCollectionActivated(
    row: number,
    activatedHost: Container,
    additiveActivatedHost?: Container,
  ): boolean {
    const symbol = this.symbolViews[row];
    return Boolean(symbol?.cell.symbol === "SURGE"
      && symbol.parent === activatedHost
      && (!additiveActivatedHost
        || symbol.winningAdditiveDisplay.parent === additiveActivatedHost));
  }

  completeSurgeCollection(row: number): void {
    const symbol = this.symbolViews[row];
    if (symbol?.cell.symbol === "SURGE") symbol.setFeatureHidden(true);
  }

  transformCellToRage(row: number): boolean {
    if (!this.setCellAt(row, { symbol: "SURGE" })) return false;
    return this.symbolViews[row]?.playFeatureActivationAnimation() ?? false;
  }

  /** 激活已设置的 Rage 而不更换其服务器单元。 */
  playPostStopSurgeActivation(row: number): boolean {
    const symbol = this.symbolViews[row];
    if (!symbol || symbol.cell.symbol !== "SURGE") return false;
    return symbol.playFeatureActivationAnimation();
  }

  /** 恢复任何收集的源 Rage 并重置瞬态卷轴覆盖。 */
  prepareRageCascade(): void {
    this.rageCascadeOverlay.visible = false;
    this.rageCascadeOverlay.syncWinningAdditiveDisplayTransform();
    this.symbolViews.slice(0, this.rowCount).forEach((symbol) => {
      if (symbol.cell.symbol !== "SURGE") return;
      symbol.setFeatureHidden(false);
      symbol.setIdleBlocked(true);
    });
  }

  /** 一个洗牌级联步骤：爆炸单元，然后显示新的 Rage（如果命名）。 */
  revealRageCascadeCell(row: number, transformsToRage: boolean): boolean {
    const symbol = this.symbolViews[row];
    if (!symbol || row < 0 || row >= this.rowCount) return false;
    // 现有 Rage 格子刻意不参与破坏性洗牌。到达其转轴主里程碑时应按原设计成功执行空操作，而不是视为缺少 `explosion` 片段。
    if (symbol.cell.symbol === "SURGE") return true;
    const exploded = symbol.playExplosionAnimation();
    let rageShown = true;
    if (transformsToRage) {
      // 每个卷轴都有一个可移动的覆盖层。因此，该卷轴上后来转换的行会移动/重新启动同一视图。
      this.rageCascadeOverlay.position.set(
        this.symbolOffsetX,
        this.layoutTopOffset + row * this.layoutCellHeight,
      );
      this.rageCascadeOverlay.setSize(this.symbolWidth, this.layoutCellHeight);
      this.rageCascadeOverlay.setCell({ symbol: "SURGE" });
      this.rageCascadeOverlay.visible = true;
      this.rageCascadeOverlay.syncWinningAdditiveDisplayTransform();
      rageShown = this.rageCascadeOverlay.playRageShowAnimation();
    }
    return exploded && rageShown;
  }

  /** 激活已结算的 Rage 和该卷轴上最后可见的临时覆盖。 */
  activateRageCascade(): AuthoredPlaybackBatchResult {
    let attempted = 0;
    let played = 0;
    this.symbolViews.slice(0, this.rowCount).forEach((symbol) => {
      if (symbol.cell.symbol !== "SURGE") return;
      attempted += 1;
      if (symbol.playRageTriggerAnimation()) played += 1;
    });
    if (this.rageCascadeOverlay.visible) {
      attempted += 1;
      if (this.rageCascadeOverlay.playRageTriggerAnimation()) played += 1;
    }
    return Object.freeze({ attempted, played });
  }

  /** 预设的激活队列隐藏；这会强制执行相同的最终姿势。 */
  clearRageCascadePresentation(): void {
    this.symbolViews.slice(0, this.rowCount).forEach((symbol) => {
      if (symbol.cell.symbol === "SURGE") symbol.setFeatureHidden(true);
    });
    this.rageCascadeOverlay.visible = false;
    this.rageCascadeOverlay.syncWinningAdditiveDisplayTransform();
  }

  playVaultUnlock(row: number): boolean {
    return this.symbolViews[row]?.playVaultUnlockAnimation() ?? false;
  }

  playVaultFreeSpinActivation(row: number): boolean {
    return this.symbolViews[row]?.playVaultFreeSpinActivationAnimation() ?? false;
  }

  playVaultTease(row: number): boolean {
    return this.symbolViews[row]?.playVaultTeaseAnimation() ?? false;
  }

  skipVaultTease(row: number): boolean {
    return this.symbolViews[row]?.skipVaultTeaseAnimation() ?? false;
  }

  revealVault(row: number, cell: GridCell): boolean {
    if (!this.setCellAt(row, cell)) return false;
    // 原swapSymbol()改变Symbol9值姿势并突出显示；它不会在解锁序列期间重播停止时间 `land` 剪辑。
    return true;
  }

  upgradeVault(row: number, cell: GridCell): boolean {
    if (!this.setCellAt(row, cell)) return false;
    return this.symbolViews[row]?.playVaultUpgradeAnimation() ?? false;
  }

  winVault(row: number, cell: GridCell): boolean {
    if (!this.setCellAt(row, cell)) return false;
    return this.symbolViews[row]?.playVaultWinAnimation() ?? false;
  }

  blockIdleRows(rows: ReadonlySet<number>): void {
    for (const row of rows) {
      if (row >= 0 && row < this.rowCount) this.symbolViews[row]?.setIdleBlocked(true);
    }
  }

  /** 仅表现反射与城市大气生命周期共享。 */
  setEnvironmentFrame(frame: SpinEnvironmentFrame): void {
    this.environmentFrame = { ...frame };
    this.applyEnvironmentFrame();
  }

  setHighlightedRows(rows: ReadonlySet<number>): void {
    let missingWin = false;
    this.symbolViews.forEach((symbol, row) => {
      const active = rows.has(row);
      if (!symbol.setHighlighted(active) && active && row < this.rowCount) missingWin = true;
    });
    if (missingWin && this.authoredSymbolsEnabled) {
      this.visualTelemetry?.failedToStart({
        id: "reel.symbol.win",
        requirement: "conditional",
        mode: "authored",
        clips: ["win"],
        sourceEvent: "win.highlight",
      }, {
        stage: "animation",
        code: "missing-animation",
        fallback: "bitmap",
      });
    }
    this.syncWinningSymbolAdditiveTransform();
  }

  /**
   * 已分派的 Wild 中奖暂时将 highlightOverlay 留给后来的 activatedOverlay。
   * 重新设置父级仅更改显示顺序：已确定的符号保持服务器寻址并保持其预设的中奖终端姿势。
   */
  promoteWinningWildRows(
    rows: ReadonlySet<number>,
    activatedHost: Container,
    additiveActivatedHost?: Container,
  ): number {
    let promoted = 0;
    for (const row of rows) {
      const symbol = this.symbolViews[row];
      if (!symbol || symbol.cell.symbol !== "WILD" || symbol.parent === activatedHost) continue;
      symbol.syncWinningAdditiveDisplayTransform();
      this.reparentSymbolPreservingPosition(symbol, activatedHost);
      if (additiveActivatedHost) {
        this.reparentSymbolPreservingPosition(
          symbol.winningAdditiveDisplay,
          additiveActivatedHost,
        );
      }
      symbol.syncWinningAdditiveDisplayTransform();
      promoted += 1;
    }
    return promoted;
  }

  restoreActivatedWilds(
    activatedHost: Container,
    additiveActivatedHost?: Container,
  ): void {
    const promoted = this.symbolViews.filter((symbol) => (
      symbol.cell.symbol === "WILD" && symbol.parent === activatedHost
    ));
    for (const symbol of promoted) {
      this.reparentSymbolPreservingPosition(symbol, this.symbols);
      if (additiveActivatedHost
        && symbol.winningAdditiveDisplay.parent === additiveActivatedHost) {
        this.reparentSymbolPreservingPosition(
          symbol.winningAdditiveDisplay,
          this.winningSettledAdditiveLayer,
        );
      }
      symbol.syncWinningAdditiveDisplayTransform();
    }
    if (promoted.length > 0) this.syncSettledSymbolOrder();
  }

  restoreActivatedSurges(
    activatedHost: Container,
    additiveActivatedHost?: Container,
  ): void {
    const promoted = this.symbolViews.filter((symbol) => (
      symbol.cell.symbol === "SURGE" && symbol.parent === activatedHost
    ));
    for (const symbol of promoted) {
      this.reparentSymbolPreservingPosition(symbol, this.symbols);
      if (additiveActivatedHost
        && symbol.winningAdditiveDisplay.parent === additiveActivatedHost) {
        this.reparentSymbolPreservingPosition(
          symbol.winningAdditiveDisplay,
          this.winningSettledAdditiveLayer,
        );
      }
      symbol.syncWinningAdditiveDisplayTransform();
    }
    if (promoted.length > 0) this.syncSettledSymbolOrder();
  }

  setDimmedExceptRows(
    rows: ReadonlySet<number> | null,
    progressiveRestore = false,
  ): void {
    this.symbolViews.forEach((symbol, row) => {
      symbol.setDimmed(
        rows !== null && row < this.rowCount && !rows.has(row),
        progressiveRestore,
      );
    });
  }

  startRageAnticipation(): AuthoredPlaybackBatchResult {
    const rageRows = new Set<number>();
    let attempted = 0;
    let played = 0;
    this.symbolViews.slice(0, this.rowCount).forEach((symbol, row) => {
      if (symbol.cell.symbol !== "SURGE") return;
      rageRows.add(row);
      attempted += 1;
      if (symbol.startRageAnticipationAnimation()) played += 1;
    });
    this.setDimmedExceptRows(rageRows);
    return Object.freeze({ attempted, played });
  }

  endRageAnticipation(): AuthoredPlaybackBatchResult {
    let attempted = 0;
    let played = 0;
    this.symbolViews.slice(0, this.rowCount).forEach((symbol) => {
      if (symbol.cell.symbol !== "SURGE") return;
      attempted += 1;
      if (symbol.endRageAnticipationAnimation()) played += 1;
    });
    this.setDimmedExceptRows(null);
    return Object.freeze({ attempted, played });
  }

  setWinMotion(rows: ReadonlySet<number>, scale: number, offsetX: number, offsetY: number): void {
    const cellHeight = this.layoutCellHeight;
    this.symbolViews.forEach((symbol, row) => {
      const restingY = this.layoutTopOffset + row * cellHeight;
      if (!rows.has(row)) {
        symbol.scale.set(1);
        symbol.position.set(this.symbolOffsetX, restingY);
        return;
      }
      symbol.scale.set(scale);
      symbol.position.set(
        this.symbolOffsetX + offsetX - (scale - 1) * this.symbolWidth / 2,
        restingY + offsetY - (scale - 1) * cellHeight / 2,
      );
    });
    this.syncWinningSymbolAdditiveTransform();
  }

  /** 仅暂停观察者选择的服务器寻址的已结算符号。 */
  setSymbolPlaybackPaused(rows: ReadonlySet<number>, active: boolean): void {
    for (const row of rows) {
      if (row >= 0 && row < this.rowCount) {
        this.symbolViews[row]?.setAuthoredPlaybackPaused(active);
      }
    }
  }

  /** 仅推进测试场景暂停、服务器寻址的符号时钟。 */
  advanceSymbolPlayback(rows: ReadonlySet<number>, deltaMs: number): void {
    for (const row of rows) {
      if (row >= 0 && row < this.rowCount) {
        this.symbolViews[row]?.advanceAuthoredPlaybackForCapture(deltaMs);
      }
    }
  }

  /** 取消后清除已结算的仅表现 Symbol8 覆盖。 */
  clearForcedLockedVaultPresentation(): number {
    let cleared = 0;
    for (const symbol of this.symbolViews.slice(0, this.rowCount)) {
      if (symbol.clearForcedLockedVaultPresentation()) cleared += 1;
    }
    return cleared;
  }

  clearWinMotion(): void {
    this.setWinMotion(new Set(), 1, 0, 0);
  }

  beginSpin(reducedMotion = false): void {
    this.animationGeneration += 1;
    this.spinning = true;
    this.stopping = false;
    this.reducedMotion = reducedMotion;
    this.spinOriginRows = this.decorativeWholeSteps
      + this.phase / Math.max(1, this.layoutCellHeight);
    this.spinElapsedMs = 0;
    this.activeStopMode = null;
    this.stopImpactCommitted = false;
    this.stopImpactRequestedMode = null;
    this.stopTargetRows = null;
    this.stopPresentationRows = 0;
    this.stopTargetReached = false;
    this.slowQuickStopRequested = false;
    this.rageCascadeOverlay.visible = false;
    this.rageCascadeOverlay.syncWinningAdditiveDisplayTransform();
    this.symbols.mask = this.clip;
    this.clearWinMotion();
    this.setDimmedExceptRows(null);
    // 隔离 ReelView 消费者的防御兼容性。在启动门完成之前，生产环境会预加载完整的 3x8 池。
    this.ensureSpinSymbols(reelPresentationCellCount(this.rowCount));
    this.syncSpinSymbols();
    this.spinSymbols.visible = true;
    this.spinSharpSymbols.visible = true;
    this.motionLayer.visible = true;
    this.motionLayer.alpha = 1;
    this.motionLayer.y = 0;
    this.motionLayer.filters = null;
    this.spinSymbols.filters = reducedMotion ? null : [this.motionBlur];
    this.spinSharpSymbols.filters = null;
    this.energyVeil.visible = !this.authoredCabinet;
    this.energyVeil.alpha = reducedMotion ? 0.48 : 0;
    this.symbols.alpha = 0;
    this.symbols.y = 0;
    this.symbols.scale.set(1);
    this.stopImpact.visible = false;
    this.syncWinningSymbolAdditiveTransform();
    if (!reducedMotion) this.applySpinFrame();
  }

  update(deltaMs: number): void {
    this.symbolViews.forEach((symbol) => symbol.update(deltaMs));
    if (this.rageCascadeOverlay.visible) this.rageCascadeOverlay.update(deltaMs);
    this.syncWinningSymbolAdditiveTransform();
    if (!this.spinning) return;
    if (this.reducedMotion || this.stopping) return;
    const safeDelta = Math.min(MAX_REEL_FRAME_DELTA_MS, Math.max(0, deltaMs));
    this.spinElapsedMs += safeDelta;
    this.applySpinFrame();
  }

  async stopAt(
    cells: GridCell[],
    durationMs: number,
    mode: ReelStopMode = "NORMAL",
    forceLockedVaultRows: ReadonlySet<number> = new Set(),
  ): Promise<void> {
    this.setCells(cells, true, forceLockedVaultRows);
    const cellHeight = Math.max(1, this.layoutCellHeight);
    const startRows = this.decorativeWholeSteps + this.phase / cellHeight;
    const startVelocityRowsPerMs = reelStartVelocityRowsAt(
      this.spinElapsedMs,
      this.spinProfile,
    );
    const authoredConfig = reelStopMotionConfig(mode);
    const stopPlan = durationMs === authoredConfig.totalMs
      ? createReelStopMotionPlanForMode(startRows, startVelocityRowsPerMs, mode)
      : createReelStopMotionPlan(
        startRows,
        startVelocityRowsPerMs,
        Math.max(0, durationMs),
      );
    this.activeStopMode = mode;
    this.stopImpactCommitted = false;
    this.stopImpactRequestedMode = null;
    this.stopTargetRows = stopPlan.targetRows;
    this.stopPresentationRows = startRows;
    this.stopTargetReached = false;
    this.slowQuickStopRequested = false;
    this.resultInsertion = {
      targetWholeRows: stopPlan.targetRows,
      cells: cells.map(reelStopPresentationCell),
    };
    this.syncSpinSymbols();
    this.applyPresentationPositionRows(startRows);
    if (this.reducedMotion || durationMs <= 0) {
      this.applyPresentationPositionRows(stopPlan.targetRows);
      this.stopPresentationRows = stopPlan.targetRows;
      this.stopTargetReached = true;
      this.resetAfterStop(false);
      return;
    }
    const generation = this.animationGeneration;
    this.stopping = true;
    this.symbols.alpha = 0;
    this.symbols.y = 0;
    this.symbols.scale.set(1);
    this.motionLayer.visible = true;
    this.motionLayer.alpha = 1;
    this.motionLayer.y = 0;
    this.motionLayer.filters = null;
    this.spinSymbols.filters = [this.motionBlur];
    this.spinSharpSymbols.filters = null;
    this.stopImpact.visible = !this.authoredCabinet;
    this.stopImpact.alpha = 0;
    let elapsedMs = 0;
    let forcedFastBounceMs: number | null = null;
    let previousFrame = performance.now();
    try {
      while (true) {
        const now = await nextFrame();
        if (generation !== this.animationGeneration) return;
        const deltaMs = Math.min(MAX_REEL_FRAME_DELTA_MS, Math.max(0, now - previousFrame));
        previousFrame = now;
        if (mode === "SLOW" && this.slowQuickStopRequested && forcedFastBounceMs === null) {
          elapsedMs = stopPlan.brakeMs;
          forcedFastBounceMs = 0;
          this.slowQuickStopRequested = false;
        } else if (forcedFastBounceMs === null) {
          elapsedMs += deltaMs;
        } else {
          forcedFastBounceMs += deltaMs;
        }

        const fastBounceDurationMs = PRIMAL_REEL_TIMING_MS.fastBounce;
        const fastBounceProgress = forcedFastBounceMs === null
          ? null
          : Math.min(1, forcedFastBounceMs / fastBounceDurationMs);
        const positionRows = fastBounceProgress === null
          ? reelStopPositionRowsAt(stopPlan, elapsedMs)
          : stopPlan.targetRows
            + 0.0015 * fastBounceDurationMs
            * fastBounceProgress * (1 - fastBounceProgress) ** 2;
        this.stopPresentationRows = positionRows;
        this.stopTargetReached = fastBounceProgress !== null
          || reelStopHasReachedImpact(stopPlan, elapsedMs);
        if (!this.stopImpactCommitted) {
          this.applyPresentationPositionRows(positionRows);
        }
        this.commitRequestedStopImpact();
        if (this.stopImpactCommitted) this.applySettledStopPosition();

        const stopVelocityRowsPerMs = fastBounceProgress === null
          ? Math.abs(reelStopVelocityRowsAt(stopPlan, elapsedMs))
          : Math.abs(0.0015 * (1 - fastBounceProgress) * (1 - 3 * fastBounceProgress));
        const speedRatio = Math.min(1, stopVelocityRowsPerMs / 0.02);
        const totalPresentationMs = forcedFastBounceMs === null
          ? stopPlan.totalMs
          : stopPlan.brakeMs + fastBounceDurationMs;
        const presentationElapsedMs = forcedFastBounceMs === null
          ? elapsedMs
          : stopPlan.brakeMs + forcedFastBounceMs;
        const progress = Math.min(1, presentationElapsedMs / Math.max(1, totalPresentationMs));
        const frame = reelSettleFrame(
          progress,
          cellHeight,
          stopPlan.brakeMs / Math.max(1, totalPresentationMs),
        );
        // 服务端指定的格子此时已占据传送带位置。制动和回弹期间保持传送带不透明；只有当两者处于完全一致的锁定姿态后，才自动交接到已结算的原生视图。
        this.motionLayer.alpha = 1;
        if (!this.stopImpactCommitted) this.symbols.alpha = 0;
        this.motionBlur.blurY = speedRatio <= 0.001 ? 0 : 400 * stopVelocityRowsPerMs;
        this.energyVeil.alpha = speedRatio * 0.82;
        this.stopImpact.alpha = frame.impactAlpha * 0.72;
        if (fastBounceProgress !== null ? fastBounceProgress >= 1 : elapsedMs >= stopPlan.totalMs) {
          break;
        }
      }
    } finally {
      if (generation === this.animationGeneration) {
        this.resetAfterStop(false);
      }
    }
  }

  commitStopImpact(mode: ReelStopMode): void {
    if (this.stopImpactCommitted) return;
    this.stopImpactRequestedMode = mode;
    this.commitRequestedStopImpact();
  }

  private commitRequestedStopImpact(): void {
    const mode = this.stopImpactRequestedMode;
    if (!mode || this.stopImpactCommitted) return;
    // StopSequencer 拥有语义影响计时器。节流/失速的 RAF 可以将此视图留在计时器后面，因此保留移动条带，直到其自身的制动器物理到达目标。
    if (this.spinning && !this.stopTargetReached) return;
    this.stopImpactCommitted = true;
    this.stopImpactRequestedMode = null;
    this.motionLayer.visible = false;
    // 官方 reverseLayeringOrder 将固定符号移动到 STOPPED 处未屏蔽的覆盖层。在显示之前，在同一切换帧中清除它。
    this.symbols.mask = null;
    this.symbols.alpha = 1;
    this.applySettledStopPosition();
    this.playLandAnimations(mode);
  }

  private applySettledStopPosition(): void {
    const targetRows = this.stopTargetRows;
    this.symbols.y = targetRows === null
      ? 0
      : (this.stopPresentationRows - targetRows) * Math.max(1, this.layoutCellHeight);
  }

  requestFastForward(mode: ReelStopMode = "SLOW"): void {
    if (mode === "SLOW" && this.stopping && this.activeStopMode === "SLOW") {
      this.slowQuickStopRequested = true;
    }
  }

  cancelSpin(): void {
    this.animationGeneration += 1;
    this.resultInsertion = null;
    this.resetAfterStop();
  }

  private ensureSymbols(count: number): void {
    let changed = false;
    while (this.symbolViews.length < count) {
      const symbol = new SymbolView(this.authoredSymbolsEnabled);
      this.symbolViews.push(symbol);
      this.symbols.addChild(symbol);
      this.winningSettledAdditiveLayer.addChild(symbol.winningAdditiveDisplay);
      changed = true;
    }
    if (changed) this.syncSettledSymbolOrder();
  }

  /** 官方 reverseLayeringOrder 将行 2 -> 1 -> 0 迁移到覆盖层中。 */
  private syncSettledSymbolOrder(): void {
    for (let row = this.symbolViews.length - 1; row >= 0; row -= 1) {
      const symbol = this.symbolViews[row];
      // 激活的 Wild/Rage 视图仍归机柜范围覆盖层所有；对一个已确定的同级进行重新排序绝不能拉回另一功能。
      if (symbol?.parent === this.symbols) this.symbols.addChild(symbol);
      if (symbol?.winningAdditiveDisplay.parent === this.winningSettledAdditiveLayer) {
        this.winningSettledAdditiveLayer.addChild(symbol.winningAdditiveDisplay);
      }
    }
    this.symbols.addChild(this.rageCascadeOverlay);
    this.winningSettledAdditiveLayer.addChild(
      this.rageCascadeOverlay.winningAdditiveDisplay,
    );
  }

  private reparentSymbolPreservingPosition(symbol: Container, target: Container): void {
    const source = symbol.parent;
    if (!source || source === target) return;
    const worldPosition = source.toGlobal(new Point(symbol.x, symbol.y));
    source.removeChild(symbol);
    target.addChild(symbol);
    symbol.position.copyFrom(target.toLocal(worldPosition));
  }

  /** 镜像内阁符号覆盖层下方的每个变换。 */
  syncWinningSymbolAdditiveTransform(): void {
    const root = this.winningSymbolAdditiveDisplay;
    root.position.copyFrom(this.position);
    root.scale.copyFrom(this.scale);
    root.pivot.copyFrom(this.pivot);
    root.skew.copyFrom(this.skew);
    root.rotation = this.rotation;
    root.alpha = this.alpha;
    root.visible = this.visible;
    root.renderable = this.renderable;

    const settled = this.winningSettledAdditiveLayer;
    settled.position.copyFrom(this.symbols.position);
    settled.scale.copyFrom(this.symbols.scale);
    settled.pivot.copyFrom(this.symbols.pivot);
    settled.skew.copyFrom(this.symbols.skew);
    settled.rotation = this.symbols.rotation;
    settled.alpha = this.symbols.alpha;
    settled.visible = this.symbols.visible;
    settled.renderable = this.symbols.renderable;
    this.symbolViews.forEach((symbol) => symbol.syncWinningAdditiveDisplayTransform());
  }

  private ensureSpinSymbols(count: number): void {
    while (this.spinSymbolViews.length < count) {
      const symbol = new SymbolView();
      this.spinSymbolViews.push(symbol);
      this.spinSymbols.addChild(symbol);
    }
  }

  private layoutSpinSymbols(): void {
    const cellHeight = this.layoutCellHeight;
    this.spinSymbolViews.forEach((symbol, index) => {
      const viewRow = REEL_PRESENTATION_FIRST_VIEW_ROW + index;
      symbol.visible = index < reelPresentationCellCount(this.rowCount);
      symbol.position.set(
        this.symbolOffsetX,
        this.layoutTopOffset + (viewRow - 1) * cellHeight,
      );
      symbol.setSize(this.symbolWidth, cellHeight);
    });
  }

  private syncSpinSymbols(): void {
    const cells = reelPresentationCells(
      this.spinProfile.reel,
      this.rowCount,
      this.decorativeWholeSteps,
      this.resultInsertion,
      this.visualStripMode,
    );
    for (let index = 0; index < cells.length; index += 1) {
      const cell = cells[index];
      const symbol = this.spinSymbolViews[index];
      if (!cell || !symbol) continue;
      symbol.setCell(cell);
      const staysSharp = reelCellStaysSharpDuringSpin(cell);
      const targetLayer = staysSharp ? this.spinSharpSymbols : this.spinSymbols;
      if (symbol.parent !== targetLayer) targetLayer.addChild(symbol);
    }
    this.layoutSpinSymbols();
    this.spinSymbols.y = 0;
    this.spinSharpSymbols.y = 0;
  }

  private resetAfterStop(playLand = false): void {
    this.spinning = false;
    this.stopping = false;
    this.activeStopMode = null;
    this.stopImpactRequestedMode = null;
    this.stopTargetRows = null;
    this.stopPresentationRows = 0;
    this.stopTargetReached = false;
    this.slowQuickStopRequested = false;
    this.motionLayer.visible = false;
    this.motionLayer.filters = null;
    this.spinSymbols.filters = null;
    this.spinSharpSymbols.filters = null;
    this.motionLayer.alpha = 1;
    this.motionLayer.y = 0;
    this.energyVeil.visible = false;
    this.energyVeil.y = 0;
    this.spinSymbols.y = 0;
    this.spinSharpSymbols.y = 0;
    this.symbols.alpha = 1;
    this.symbols.y = 0;
    this.symbols.scale.set(1);
    this.symbols.mask = null;
    this.stopImpact.visible = false;
    this.stopImpact.alpha = 0;
    if (playLand) this.playLandAnimations("NORMAL");
  }

  private playLandAnimations(mode: ReelStopMode): void {
    let missingLand = false;
    this.symbolViews.slice(0, this.rowCount).forEach((symbol) => {
      if (!symbol.playLandAnimation(mode)) missingLand = true;
    });
    if (missingLand && this.authoredSymbolsEnabled) {
      this.visualTelemetry?.failedToStart({
        id: "reel.symbol.land",
        requirement: "conditional",
        mode: "authored",
        clips: ["land"],
        sourceEvent: "reel.stop.land",
      }, {
        stage: "animation",
        code: "missing-animation",
        fallback: "bitmap",
      });
    }
  }

  private applySpinFrame(): void {
    const velocityRowsPerMs = reelStartVelocityRowsAt(this.spinElapsedMs, this.spinProfile);
    const speedRatio = Math.min(1, velocityRowsPerMs / 0.02);
    const totalRows = this.spinProfile.phaseOffsetRows
      + this.spinOriginRows
      + reelStartPositionDeltaRowsAt(this.spinElapsedMs, this.spinProfile);
    this.applyPresentationPositionRows(totalRows);
    if (this.stopping) return;
    // GameReelView 直接交换到 SPIN_START 的移动皮带。之前基于速度的混合导致高达 10% 的旧固定板在巡航速度下在跑道下方出现重影。
    this.motionLayer.alpha = 1;
    this.energyVeil.alpha = 0.16 + speedRatio * 0.66;
    this.symbols.alpha = 0;
    this.motionBlur.blurY = 400 * velocityRowsPerMs;
  }

  private applyPresentationPositionRows(totalRows: number): void {
    const safeRows = Math.max(0, Number.isFinite(totalRows) ? totalRows : 0);
    const cellHeight = Math.max(1, this.layoutCellHeight);
    const wholeSteps = Math.floor(safeRows);
    this.phase = (safeRows - wholeSteps) * cellHeight;
    if (wholeSteps !== this.decorativeWholeSteps) {
      this.decorativeWholeSteps = wholeSteps;
      // 逻辑带坐标在整个包裹中保持不变。下面的视图继承了旧的标识，包括插入的权威单元格。
      this.syncSpinSymbols();
    }
    this.energyVeil.y = this.phase;
    this.spinSymbols.y = this.phase;
    this.spinSharpSymbols.y = this.phase;
  }

  private drawEnergyVeil(): void {
    this.energyVeil.clear();
    this.energyVeil.beginFill(0x080b0d, 0.56).drawRect(0, -48, this.reelWidth, this.reelHeight + 96).endFill();
    // 长的垂直高光被模糊滤镜拉伸，并被读取为真正的向下运动，而不是之前的霓虹灯扫描线。
    for (let x = 13, index = 0; x < this.reelWidth; x += 19, index += 1) {
      const width = index % 3 === 0 ? 3 : 1.2;
      const alpha = index % 4 === 0 ? 0.2 : 0.1;
      this.energyVeil.beginFill(index % 5 === 0 ? 0xf19342 : 0xcbd0cf, alpha);
      this.energyVeil.drawRoundedRect(x, -30 + (index % 4) * 12, width, this.reelHeight + 42, width / 2).endFill();
    }
    // 捕获的模糊在行进方向上是连续的。水平扫描带仍然被省略，因为它们将实时条带以巡航速度变成堆叠的幽灵行，这与原始的模糊虚拟渲染器不同。
  }

  private drawClip(): void {
    const geometry = reelViewportMaskGeometry(
      this.reelIndex,
      this.reelWidth,
      this.reelHeight,
      this.authoredCabinet,
    );
    this.clip.clear().beginFill(0xffffff);
    if (geometry.radius <= 0) {
      this.clip.drawRect(geometry.x, geometry.y, geometry.width, geometry.height);
    } else {
      this.clip.drawRoundedRect(
        geometry.x,
        geometry.y,
        geometry.width,
        geometry.height,
        geometry.radius,
      );
    }
    this.clip.endFill();
  }

  private drawGlass(): void {
    const backdrop = this.glassBackdrop;
    const surface = this.glassSurface;
    backdrop.clear();
    surface.clear();

    // 每个卷轴都有一个不间断的窗格：烟色的防爆玻璃，沿一侧边缘有微弱的火反射，而在其对面则有寒冷的天空反射。
    backdrop.beginFill(0x071014, 0.64).drawRoundedRect(0, 0, this.reelWidth, this.reelHeight, 12).endFill();
    backdrop.beginFill(0x5c2112, 0.07).drawPolygon([
      0, 0,
      this.reelWidth * 0.22, 0,
      this.reelWidth * 0.08, this.reelHeight,
      0, this.reelHeight,
    ]).endFill();
    backdrop.beginFill(0x668492, 0.07).drawPolygon([
      this.reelWidth * 0.78, 0,
      this.reelWidth, 0,
      this.reelWidth, this.reelHeight,
      this.reelWidth * 0.91, this.reelHeight,
    ]).endFill();
    backdrop.lineStyle(1, 0xc7d0cf, 0.065);
    for (let row = 1; row < this.rowCount; row += 1) {
      const y = this.layoutTopOffset + row * this.layoutCellHeight;
      if (y <= 0 || y >= this.reelHeight) continue;
      backdrop.moveTo(this.reelWidth * 0.05, y).lineTo(this.reelWidth * 0.95, y);
    }

    // 每个转轴都获得稳定且独特的玻璃 UV 采样，避免污渍和细微划痕在所有窗格的相同坐标重复出现。
    const glassSeed = 0x61a55 + this.reelIndex * 0x19e37;
    const scratches = sampleScratches({
      seed: glassSeed,
      width: this.reelWidth,
      height: this.reelHeight,
      count: 7,
      direction: "mixed",
    });
    surface.beginFill(0x020303, 0.038);
    scratches.slice(0, 3).forEach((scratch, index) => {
      const centerX = (scratch.x1 + scratch.x2) / 2;
      const centerY = (scratch.y1 + scratch.y2) / 2;
      const width = Math.max(14, Math.abs(scratch.x2 - scratch.x1) * (1.2 + index * 0.16));
      const height = Math.max(8, Math.abs(scratch.y2 - scratch.y1) * 0.7 + this.reelHeight * 0.025);
      surface.drawEllipse(centerX, centerY, width, height);
    });
    surface.endFill();
    scratches.forEach((scratch) => {
      surface.lineStyle(
        scratch.width * 0.72,
        scratch.tone === "bright" ? 0xd9dfdc : 0x020303,
        scratch.alpha * (scratch.tone === "bright" ? 0.46 : 0.58),
      );
      surface.moveTo(scratch.x1, scratch.y1).lineTo(scratch.x2, scratch.y2);
    });
    const microGrain = sampleBrushedSteel({
      seed: glassSeed ^ 0x7a551,
      width: this.reelWidth,
      height: this.reelHeight,
      count: 13,
      direction: "vertical",
    });
    microGrain.forEach((stroke) => {
      surface.lineStyle(stroke.width * 0.55, 0xd7dddd, stroke.alpha * 0.32);
      surface.moveTo(stroke.x1, stroke.y1).lineTo(stroke.x2, stroke.y2);
    });

    // 每个窗格上都有一个受约束的菲涅尔捕捉器遵循不同的角度。
    const lean = (this.reelIndex - 1) * this.reelWidth * 0.035;
    surface.lineStyle(1.2, 0xe8efed, 0.075);
    surface.moveTo(this.reelWidth * 0.12 + lean, 7);
    surface.lineTo(this.reelWidth * 0.04 - lean, this.reelHeight - 12);
    surface.lineStyle(1, 0x020304, 0.16);
    surface.moveTo(this.reelWidth - 5, 14).lineTo(this.reelWidth - 5, this.reelHeight - 17);
  }

  /**
   * 四个约束边缘带再现了凹进的轨道遮挡。该节点独立于 SymbolView，因此 Rage/Vault 隐藏永远无法重新着色或替换其下方的轨道。
   */
  private drawTrackShadow(): void {
    const shadow = this.trackShadow;
    const width = this.reelWidth;
    const height = this.reelHeight;
    const depth = Math.max(4, Math.min(width * 0.095, this.layoutCellHeight * 0.18));
    shadow.clear();

    for (let band = 0; band < 4; band += 1) {
      const progress = band / 4;
      const inset = depth * progress;
      const bandDepth = depth / 4 + 0.5;
      const alpha = 0.19 * (1 - progress) ** 1.6;
      shadow.beginFill(0x010202, alpha)
        .drawRect(inset, inset, Math.max(0, width - inset * 2), bandDepth)
        .drawRect(inset, Math.max(0, height - inset - bandDepth), Math.max(0, width - inset * 2), bandDepth)
        .drawRect(inset, inset, bandDepth, Math.max(0, height - inset * 2))
        .drawRect(Math.max(0, width - inset - bandDepth), inset, bandDepth, Math.max(0, height - inset * 2))
        .endFill();
    }

    // 狭窄的冷唇可以捕捉橱柜的光线，而不会将符号压平成明亮的网格。
    shadow.lineStyle(1, 0xbec8c6, this.reelIndex === 1 ? 0.095 : 0.065);
    shadow.moveTo(depth * 0.52, depth * 0.42);
    shadow.lineTo(width - depth * 0.7, depth * 0.42);
  }

  private drawEnvironmentReflection(): void {
    const warm = this.environmentWarmReflection;
    const aura = this.environmentAuraReflection;
    const dust = this.environmentDustReflection;
    const core = this.environmentCoreReflection;
    warm.clear();
    aura.clear();
    dust.clear();
    core.clear();

    // 这些窗格共享一个模糊反射通道，但每个窗格都接收不对称的角度和发射器位置，以避免出现三个克隆椭圆。
    const lean = (this.reelIndex - 1) * this.reelWidth * 0.055;
    warm.beginFill(0xff6f2a, 0.56);
    warm.drawPolygon([
      Math.max(-8, this.reelWidth * 0.01 + lean), -10,
      Math.min(this.reelWidth + 8, this.reelWidth * 0.17 + lean), -4,
      Math.min(this.reelWidth + 8, this.reelWidth * 0.7 - lean * 0.45), this.reelHeight + 12,
      Math.max(-8, this.reelWidth * 0.51 - lean * 0.65), this.reelHeight + 5,
    ]);
    warm.endFill();
    warm.beginFill(0xffb96d, 0.18);
    warm.drawEllipse(
      this.reelWidth * (0.28 + this.reelIndex * 0.22),
      this.reelHeight * 0.92,
      this.reelWidth * 0.32,
      this.reelHeight * 0.1,
    );
    warm.endFill();

    aura.beginFill(0xff7130, 0.44);
    aura.drawEllipse(
      this.reelWidth * (0.42 + this.reelIndex * 0.07),
      this.reelHeight * (0.48 + (this.reelIndex % 2) * 0.055),
      this.reelWidth * 0.56,
      this.reelHeight * 0.25,
    );
    aura.endFill();

    dust.beginFill(0xd58b53, 0.38);
    dust.drawEllipse(
      this.reelWidth * (0.46 + (this.reelIndex - 1) * 0.08),
      this.reelHeight + 9,
      this.reelWidth * 0.72,
      43 + this.reelIndex * 5,
    );
    dust.endFill();

    core.lineStyle(1.2, 0xffd19a, 0.64);
    core.moveTo(this.reelWidth * 0.08 + lean, 5);
    core.lineTo(this.reelWidth * 0.55 - lean * 0.35, this.reelHeight - 8);
    core.lineStyle(1, 0xffb565, 0.42);
    core.moveTo(this.reelWidth * 0.13, this.reelHeight - 7);
    core.lineTo(this.reelWidth * 0.86, this.reelHeight - 9);
    core.alpha = 0;
  }

  private applyEnvironmentFrame(): void {
    const frame = this.environmentFrame;
    if (!frame) {
      this.environmentWarmReflection.alpha = 0;
      this.environmentAuraReflection.alpha = 0;
      this.environmentDustReflection.alpha = 0;
      this.environmentCoreReflection.alpha = 0;
      return;
    }

    const impactBias = Math.min(1, Math.max(-1, Number.isFinite(frame.impactBias) ? frame.impactBias : 0));
    const reelBias = this.reelIndex - 1;
    const localImpact = Math.max(0, 1 - Math.abs(impactBias - reelBias));
    const localWeight = 0.2 + localImpact * 0.8;
    const spinEnergy = clamp01(frame.spinEnergy);
    const warmFlash = clamp01(frame.warmFlash);
    const featureAura = clamp01(frame.featureAura);
    const floorDust = clamp01(frame.floorDust);

    // 玻璃高光仅提供轻微反射。停轴/特性脉冲按转轴索引定位，保持半透明，并且绝不改动结果数据。
    this.environmentWarmReflection.alpha = Math.min(
      0.2,
      spinEnergy * 0.01 + warmFlash * (0.035 + localWeight * 0.135),
    );
    this.environmentAuraReflection.alpha = Math.min(
      0.2,
      featureAura * (0.045 + localWeight * 0.145),
    );
    this.environmentDustReflection.alpha = Math.min(
      0.18,
      floorDust * (0.025 + localWeight * 0.145),
    );
    this.environmentCoreReflection.alpha = Math.min(
      0.13,
      warmFlash * (0.025 + localWeight * 0.075) + featureAura * 0.045 + floorDust * 0.025,
    );
  }

  private drawStopImpact(): void {
    this.stopImpact.clear();
    this.stopImpact.beginFill(0xffa544, 0.09).drawRect(0, this.reelHeight - 24, this.reelWidth, 22).endFill();
    this.stopImpact.beginFill(0xffd092, 0.72).drawRect(8, this.reelHeight - 4, this.reelWidth - 16, 2).endFill();
  }

  private drawDormantPlate(): void {
    this.dormantPlate.clear();
    this.dormantPlate.beginFill(0x0a0c0c, 0.86).drawRoundedRect(3, 3, this.reelWidth - 6, this.reelHeight - 6, 10).endFill();
    const cellHeight = this.layoutCellHeight;
    this.dormantPlate.beginFill(0x242522, 0.72).drawRect(7, this.reelHeight * 0.43, this.reelWidth - 14, this.reelHeight * 0.14).endFill();
    this.dormantPlate.lineStyle(2, 0x6e6d65, 0.4);
    this.dormantPlate.moveTo(10, this.reelHeight * 0.43).lineTo(this.reelWidth - 10, this.reelHeight * 0.43);
    this.dormantPlate.moveTo(10, this.reelHeight * 0.57).lineTo(this.reelWidth - 10, this.reelHeight * 0.57);
    for (let row = 0; row < this.rowCount; row += 1) {
      const rowY = this.layoutTopOffset + row * cellHeight;
      const centerY = rowY + cellHeight / 2;
      if (centerY <= 0 || centerY >= this.reelHeight) continue;
      const iconSize = Math.min(22, cellHeight * 0.2);
      this.dormantPlate.lineStyle(1, 0xbcc1bd, 0.08);
      if (rowY > 0) this.dormantPlate.moveTo(14, rowY).lineTo(this.reelWidth - 14, rowY);
      this.dormantPlate.lineStyle(3, 0xe06c31, 0.32);
      for (const offset of [-1, 0, 1]) {
        this.dormantPlate.moveTo(this.reelWidth / 2 + offset * iconSize * 0.72 - iconSize * 0.28, centerY - iconSize);
        this.dormantPlate.lineTo(this.reelWidth / 2 + offset * iconSize * 0.72 + iconSize * 0.28, centerY + iconSize);
      }
    }
    this.dormantPlate.lineStyle(1, 0xc9a66f, 0.24);
    this.dormantPlate.moveTo(this.reelWidth * 0.11, this.reelHeight * 0.5).lineTo(this.reelWidth * 0.3, this.reelHeight * 0.5);
    this.dormantPlate.moveTo(this.reelWidth * 0.7, this.reelHeight * 0.5).lineTo(this.reelWidth * 0.89, this.reelHeight * 0.5);
  }
}
