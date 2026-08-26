import {
  Application,
  BLEND_MODES,
  Container,
  Point,
  RenderTexture,
  Sprite,
  Texture,
  type DisplayObject,
} from "pixi.js";
import { PRIMAL_ASSETS } from "../assets/PrimalAssetManifest";
import type {
  CellAddress,
  FeatureEvent,
  FeatureState,
  FreeSpinAwardedEvent,
  FreeSpinCapReachedEvent,
  InstantWheelAwardedEvent,
  MoneyDisplayBinding,
  MoneyMinor,
  VaultAwardedEvent,
  VaultUnlockedEvent,
  VaultUpgradedEvent,
  WheelAwardedEvent,
  Win,
} from "../app/state/types";
import { createMinorUnitFormatter } from "../protocol/moneyFormatter";
import {
  ReelSetView,
} from "../reels/ReelSetView";
import {
  type AuthoredSymbolRequiredClipGaps,
  loadedSymbolTextures,
  loadAuthoredSymbolSpines,
  loadSymbolTextures,
  validateAuthoredSymbolRequiredClips,
} from "../reels/SymbolView";
import { CityBackdrop } from "./CityBackdrop";
import {
  BigWinView,
  type BigWinInteractionResult,
  type BigWinMilestone,
} from "./BigWinView";
import {
  type BigWinCoinShowerOptions,
} from "./BigWinCoinShower";
import {
  AnticipationView,
} from "./AnticipationView";
import { CameraRig } from "./CameraRig";
import { FeaturePreviewSpineView } from "./FeaturePreviewSpineView";
import {
  FreeSpinHudView,
  type FreeSpinCapCloseReason,
} from "./FreeSpinHudView";
import {
  FeatureEffects,
  featureEffectDuration,
  loadedFeatureTextures,
  loadFeatureTextures,
  reelResizePlan,
  vaultGroupFrameAnimation,
  type AnimatedReelStructureDirection,
  type FeatureEffectKind,
  type FreeSpinSummaryCloseReason,
  type RageCascadeCellOrderSource,
  type RageCascadeEffectMilestone,
  type RageCollectionEffectMilestone,
  type VaultUnlockPresentationMilestone,
  type WheelInteractionResult,
  type WheelStopOffsetSource,
} from "./FeatureEffects";
import {
  characterCollectAnimationForRandom,
  LaunchScene,
  type CharacterCollectAnimation,
  type CharacterPersistentPresentation,
  type CharacterAnimationListener,
} from "./intro/LaunchScene";
import {
  JackpotTowerView,
  jackpotTierFromAward,
  type JackpotTier,
} from "./JackpotTowerView";
import { LogoGameView } from "./LogoGameView";
import {
  responsiveCompositionScale,
  responsiveVisibleInset,
  type ResponsiveLayoutSnapshot,
} from "./ResponsiveLayout";
import {
  addSpinReelImpact,
  beginSpinEnvironment,
  createSpinEnvironmentState,
  finishSpinEnvironment,
  markSpinFastStop,
  resetSpinEnvironment,
  sampleSpinEnvironment,
  triggerFeatureEnvironment,
  type SpinEnvironmentFeatureKind,
} from "./spinEnvironmentMotion";
import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from "./theme";
import { WinCelebration } from "./WinCelebration";
import { WheelBonusWinLabel } from "./WheelBonusWinLabel";
import type { FrameRequest } from "../startup/frameSlicedInitialization";
import type { LoadedAssetPackage } from "../startup/StreamingAssetPackages";
import {
  createStagedGraphOwnershipTransfer,
  runStagedComponentConstruction,
  type StagedGraphOwnershipTransfer,
  type StagedComponentConstructionEvent,
  type StagedComponentConstructionStage,
} from "../startup/stagedComponentConstruction";
import {
  VisualTelemetryReporter,
  type VisualTelemetryContextProvider,
  type VisualTelemetryDescriptor,
  type VisualTelemetryListener,
  type VisualTelemetryOperation,
} from "./VisualTelemetry";
import {
  collectGpuWarmupDiagnosticBaseTextures,
  createGpuWarmupUploadDiagnostic,
  retainSlowGpuWarmupUploads,
  type GpuWarmupDisplayObjectLike,
  type GpuWarmupUploadDiagnostic,
} from "./GpuWarmupDiagnostics";
import {
  disposeVerifiedWheelArtwork,
  verifiedFeatureArtworkFromPackage,
  type VerifiedFeatureArtworkKind,
} from "./VerifiedFeatureArtwork";

export interface PersistentFeatureVisualPlan {
  readonly backdrop: "main" | "fire" | "snow";
  readonly character: CharacterPersistentPresentation;
}

export interface PixiRendererOptions {
  /** 仅在“就绪”手势后采样的装饰 Wheel 偏移源。 */
  readonly wheelStopOffsetSource?: WheelStopOffsetSource;
  /** 仅限化妆品 COLLECT 身体选择器；生产样品Math.random一次。 */
  readonly characterCollectRandomSource?: CharacterCollectRandomSource;
  /** 仅供测试夹具使用的装饰性排列来源；不能选择结果格子。 */
  readonly rageCascadeCellOrderSource?: RageCascadeCellOrderSource;
  /**
   * 初始帧缓冲区尺寸。移动设备/平板电脑启动提供其物理视口，因此 Pixi 永远不会分配然后丢弃 1280x720。
   */
  readonly initialSize?: Readonly<{ width: number; height: number }>;
  /** 可注入的纯装饰 Big Win 粒子策略；`frameFusePolicy: null` 保留逐帧捕获基线。 */
  readonly bigWinCoinShowerOptions?: BigWinCoinShowerOptions;
}

export interface PixiRendererStagedCreateOptions {
  readonly signal?: AbortSignal;
  readonly requestFrame?: FrameRequest;
  /** 构建进度；一个是为完全连线的渲染器保留的。 */
  readonly onProgress?: (fraction: number) => void;
  readonly onStage?: (event: Readonly<StagedComponentConstructionEvent>) => void;
}

interface PixiRendererOwners {
  readonly app: Application;
  readonly reels: ReelSetView;
  readonly scene: Container;
  readonly camera: CameraRig;
  readonly launchScene: LaunchScene;
  readonly gameLogo: LogoGameView;
  readonly jackpotTower: JackpotTowerView;
  readonly featurePreview: FeaturePreviewSpineView;
  readonly visualTelemetry: VisualTelemetryReporter;
  readonly freeSpinHud: FreeSpinHudView;
  readonly freeSpinCallbacks: PixiRendererFreeSpinCallbacks;
  readonly bigWin: BigWinView;
  readonly anticipation: AnticipationView;
  readonly backdrop: CityBackdrop;
  readonly winCelebration: WinCelebration;
  readonly wheelBonusWinLabel: WheelBonusWinLabel;
}

interface PixiRendererFreeSpinCallbacks {
  onCapInteraction(phase: "input-ready" | "continue"): void;
  onCapClose(reason: FreeSpinCapCloseReason): void;
  onCapInputReadyCheckpoint(): void | Promise<void>;
}

type MutablePixiRendererOwners = {
  -readonly [K in keyof PixiRendererOwners]: PixiRendererOwners[K];
};

interface StagedPixiRendererOwnerState extends Partial<MutablePixiRendererOwners> {
  readonly ownershipTransfer: StagedGraphOwnershipTransfer;
  renderer: PixiRenderer | null;
}

export const PIXI_RENDERER_CONSTRUCTION_STAGE_IDS = Object.freeze([
  "application-shell",
  "scene-root",
  "camera-rig",
  "reel-cabinet",
  "city-backdrop",
  "game-logo",
  "jackpot-tower",
  "feature-preview",
  "visual-telemetry",
  "free-spin-hud",
  "big-win-overlay",
  "anticipation-overlay",
  "launch-scene",
  "normal-win-overlay",
  "wheel-win-label",
  "renderer-graph",
] as const);


export type CharacterCollectRandomSource = () => number;

export interface RageCollectionPresentationMilestone
  extends RageCollectionEffectMilestone {
  readonly bodyClip: CharacterCollectAnimation | null;
  readonly characterStarted: boolean;
}

export type RageCollectionPresentationMilestoneListener = (
  milestone: Readonly<RageCollectionPresentationMilestone>,
) => void;

export type RageCascadePresentationMilestone = RageCascadeEffectMilestone;

export type RageCascadePresentationMilestoneListener = (
  milestone: Readonly<RageCascadePresentationMilestone>,
) => void;

export type VaultUnlockPresentationMilestoneListener = (
  milestone: Readonly<VaultUnlockPresentationMilestone>,
) => void | Promise<void>;

export function resolveInitialRendererSize(
  initialSize?: Readonly<{ width: number; height: number }>,
): Readonly<{ width: number; height: number }> {
  const dimension = (value: number | undefined, fallback: number): number => (
    value !== undefined && Number.isFinite(value) && value > 0
      ? Math.max(1, value)
      : fallback
  );
  return Object.freeze({
    width: dimension(initialSize?.width, LOGICAL_WIDTH),
    height: dimension(initialSize?.height, LOGICAL_HEIGHT),
  });
}

/**
 * Primal 的启动材质规则使用的 Pixi 的 WebGL 渲染器状态的小型公众视图。  Pixi 6 在其声明中保留 `blendModes` 的保护，
 * 即使官方客户端故意覆盖其 ADD 条目。
 */
export interface PrimalAdditiveBlendRenderer {
  readonly gl?: Readonly<{
    SRC_ALPHA: number;
    ONE: number;
    ZERO: number;
  }>;
  readonly state?: {
    blendModes?: number[][];
  };
  readonly runners?: {
    readonly contextChange?: {
      add(listener: PrimalAdditiveBlendContextListener): void;
      remove(listener: PrimalAdditiveBlendContextListener): void;
    };
  };
}

/** Pixi 6 的渲染器 `contextChange` 运行器使用的监听器形状。 */
export interface PrimalAdditiveBlendContextListener {
  contextChange(): void;
}

/**
 * 安装原始游戏的全局 ADD 复合规则。
 *
 * 捕获的桌面包中的 `GameMainGameView.start()` 将 Pixi 的默认 ADD 元组 (`ONE, ONE`) 替换为 `SRC_ALPHA, ONE, ZERO, ONE`。
 * Primal 预设的 `add/*` 图集页面是不透明的 RGB 黑色为零图像。  在将此类页面渲染到滤镜纹理中时保持目标 Alpha 至关重要：否则，
 * 当滤镜纹理合成回场景时，全黑零区域将变成不透明矩形。
 *
 * 防御形状可以让没有 WebGL 的单元/服务器环境安全地跳过规则；应用程序构建后，浏览器游戏逻辑始终具有这两个值。
 */
export function installPrimalAdditiveBlendMode(
  renderer: PrimalAdditiveBlendRenderer | null | undefined,
): boolean {
  const gl = renderer?.gl;
  const blendModes = renderer?.state?.blendModes;
  if (!gl || !blendModes
    || !Number.isFinite(gl.SRC_ALPHA)
    || !Number.isFinite(gl.ONE)
    || !Number.isFinite(gl.ZERO)) return false;

  blendModes[BLEND_MODES.ADD] = [gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE];
  return true;
}

/**
 * Pixi 在 WebGL 上下文恢复后重建 `state.blendModes`。在确切的生命周期边界重新应用捕获的 Primal 元组，
 * 而不是希望稍后的游戏效果会重新创建渲染器。
 */
export function createPrimalAdditiveBlendContextListener(
  renderer: PrimalAdditiveBlendRenderer,
): PrimalAdditiveBlendContextListener {
  return Object.freeze({
    contextChange: () => {
      installPrimalAdditiveBlendMode(renderer);
    },
  });
}

export interface PixiRendererLaunchOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number) => void;
}

export interface AuthoredSymbolClipReadiness {
  readonly land: boolean;
  readonly win: boolean;
}

/** 发出严格的每功能准备情况，而不根据需要处理纯功能剪辑。 */
export function reportAuthoredSymbolClipReadiness(
  reporter: VisualTelemetryReporter,
  gaps: AuthoredSymbolRequiredClipGaps,
): AuthoredSymbolClipReadiness {
  const readiness = {
    land: gaps.land.length === 0,
    win: gaps.win.length === 0,
  };
  for (const id of ["land", "win"] as const) {
    if (readiness[id]) continue;
    reporter.failedToStart({
      id: `reel.symbol.${id}`,
      requirement: "required",
      mode: "authored",
      clips: gaps[id].map((key) => `${key}:${id}`),
      sourceEvent: "launch.preload",
    }, {
      stage: "animation",
      code: "missing-animation",
      fallback: "bitmap",
    });
  }
  return Object.freeze(readiness);
}

export type FractionalLaunchLoad = (
  report: (fraction: number) => void,
) => Promise<unknown>;

export type FeaturePresentationMilestone =
  | "wheel.popup-input-ready"
  | "wheel.popup-complete"
  | "wheel.input-ready"
  | "wheel.spin-start"
  | "wheel.quick-stop"
  | "wheel.spin-finish"
  | "wheel.spin-abort"
  | "wheel.summary-input-ready"
  | "wheel.summary-complete"
  | "wheel.bonus-label-ready"
  | "free-spins.input-ready"
  | "free-spins.continue"
  | "free-spins.summary-input-ready"
  | "free-spins.summary-complete"
  | "free-spin-cap.input-ready"
  | "free-spin-cap.continue"
  | "free-spins.summary-hide"
  | "reels.decrease-kq"
  | "reels.reset-base";
export type FeaturePresentationMilestoneListener = (
  milestone: FeaturePresentationMilestone,
) => void;
export type FeaturePresentationBranch = Readonly<
  | { type: "free-spin-cap.closed"; reason: FreeSpinCapCloseReason }
  | { type: "free-spins.summary.closed"; reason: FreeSpinSummaryCloseReason }
>;
export type FeaturePresentationBranchListener = (
  branch: FeaturePresentationBranch,
) => void;
export type FeaturePresentationInputGate = "free-spin-cap" | "free-spins-summary";
export type FeaturePresentationInputCheckpointListener = (
  gate: FeaturePresentationInputGate,
) => void | Promise<void>;
export type FeaturePresentationSemanticState =
  | "wheel.popup-input-ready"
  | "wheel.input-ready"
  | "wheel.chest-loop-start"
  | "wheel.landing";
export type FeaturePresentationSemanticCheckpointListener = (
  state: FeaturePresentationSemanticState,
) => void | Promise<void>;
export type BigWinMilestoneListener = (
  milestone: BigWinMilestone,
) => void | Promise<void>;
export type CharacterWinPresentation = "base" | "feature" | "kq";

export interface CharacterReelStructurePlan {
  readonly animation: "reel_stretch" | "reel_smash";
  readonly continuation: CharacterWinPresentation;
  readonly audioMilestone: Extract<
    FeaturePresentationMilestone,
    "reels.decrease-kq" | "reels.reset-base"
  > | null;
}

export function characterReelStructurePlan(
  direction: AnimatedReelStructureDirection,
  featureMode: FeatureState["mode"],
): CharacterReelStructurePlan {
  if (direction === "expand") {
    return { animation: "reel_stretch", continuation: "kq", audioMilestone: null };
  }
  if (featureMode === "EXPANSION") {
    return {
      animation: "reel_smash",
      continuation: "kq",
      audioMilestone: "reels.decrease-kq",
    };
  }
  return {
    animation: "reel_smash",
    continuation: "base",
    audioMilestone: "reels.reset-base",
  };
}

/**
 * 捕获的 KONG_QUEST_INTRO/KING_SPIN_INTRO 处理程序仅添加其调色板和光环。两者都保留 LOOP_FEATURE，
 * 直到真正的 Kong Quest 高度增加分派 REEL_STRETCH 并将身体转换为 LOOP_KQ。
 */
export function featureIntroCharacterPresentation(
  mode: Exclude<FeatureState["mode"], "BASE">,
): CharacterPersistentPresentation {
  return {
    body: "feature",
    auraLevel: 1,
    palette: mode === "OVERDRIVE" ? "snow" : "fire",
  };
}

export function persistentFeatureVisualPlan(
  state: Pick<FeatureState, "mode" | "rageLevel">,
): PersistentFeatureVisualPlan {
  if (state.mode === "EXPANSION") {
    return {
      backdrop: "fire",
      character: { body: "kq", auraLevel: 1, palette: "fire" },
    };
  }
  if (state.mode === "OVERDRIVE") {
    return {
      backdrop: "snow",
      character: { body: "feature", auraLevel: 1, palette: "snow" },
    };
  }
  const auraLevel = Math.max(1, Math.min(6, Math.floor(state.rageLevel)));
  return {
    backdrop: "main",
    character: {
      body: "base",
      auraLevel: auraLevel > 1 ? auraLevel : null,
      palette: "main",
    },
  };
}

/** 只有服务器寻址的免费 Spin 保险库可以运行预设的激活。 */
export function vaultFreeSpinActivationCells(
  events: readonly Readonly<FreeSpinAwardedEvent>[],
): readonly CellAddress[] {
  return events.flatMap((event) => (
    Number.isInteger(event.reel) && Number.isInteger(event.row)
      ? [{ reel: event.reel!, row: event.row! }]
      : []
  ));
}

/** 转换一组权威的 Vault 目标集，无需创建层级。 */
export function vaultJackpotMutationTiers(
  events: readonly Readonly<{ prize?: string }>[],
): readonly JackpotTier[] {
  const tiers = new Set<JackpotTier>();
  for (const event of events) {
    const tier = jackpotTierFromAward(event.prize);
    if (tier) tiers.add(tier);
  }
  return [...tiers];
}

/** 针对部分/旧协议的向后兼容的最终奖励预测。 */
export function vaultJackpotAwardTiers(
  events: readonly Readonly<VaultAwardedEvent>[],
): readonly JackpotTier[] {
  return vaultJackpotMutationTiers(events);
}

export class PixiRenderer {
  readonly app: Application;
  readonly reels: ReelSetView;
  readonly scene: Container;
  readonly camera: CameraRig;
  readonly launchScene: LaunchScene;
  readonly gameLogo: LogoGameView;
  readonly jackpotTower: JackpotTowerView;
  readonly featurePreview: FeaturePreviewSpineView;
  readonly visualTelemetry: VisualTelemetryReporter;
  readonly freeSpinHud: FreeSpinHudView;
  readonly bigWin: BigWinView;
  readonly anticipation: AnticipationView;
  readonly featureEffects: FeatureEffects;
  readonly winCelebration: WinCelebration;
  readonly wheelBonusWinLabel: WheelBonusWinLabel;
  private readonly backdrop: CityBackdrop;
  private readonly canvasHost: HTMLElement;
  private readonly additiveBlendContextListener: PrimalAdditiveBlendContextListener;
  private featurePreviewCanvasHost: HTMLElement | null = null;
  private readonly reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
  private environmentState = createSpinEnvironmentState();
  private featurePresentationMilestoneListener: FeaturePresentationMilestoneListener | null = null;
  private featurePresentationBranchListener: FeaturePresentationBranchListener | null = null;
  private featurePresentationInputCheckpointListener:
    FeaturePresentationInputCheckpointListener | null = null;
  private featurePresentationSemanticCheckpointListener:
    FeaturePresentationSemanticCheckpointListener | null = null;
  private rageCollectionPresentationMilestoneListener:
    RageCollectionPresentationMilestoneListener | null = null;
  private rageCascadePresentationMilestoneListener:
    RageCascadePresentationMilestoneListener | null = null;
  private vaultUnlockPresentationMilestoneListener:
    VaultUnlockPresentationMilestoneListener | null = null;
  private bigWinMilestoneListener: BigWinMilestoneListener | null = null;
  private readonly characterCollectRandomSource: CharacterCollectRandomSource;
  private activeRageCollectionCharacter: Readonly<{
    bodyClip: CharacterCollectAnimation;
    started: boolean;
  }> | null = null;
  private rageCollectionPresentationPaused = false;
  private rageCascadePresentationPaused = false;
  private introCompleted = false;
  private featureMode: FeatureState["mode"] = "BASE";
  private vaultAwardExpectedCount = 0;
  private vaultAwardResolvedCount = 0;
  private readonly pendingVaultAwardTiers = new Set<JackpotTier>();
  private readonly vaultMutationPrizeByCell = new Map<string, string>();
  /** 保留直至正版Wheel登陆；从不驱动服务器状态。 */
  private pendingWheelAward: WheelAwardedEvent | null = null;
  private pendingFeatureExit: Promise<void> | null = null;
  /**
   * Pixi 6 独占帧缓冲量化：round(logical * DPR)。单独保留连续请求值，因为
   * renderer.screen 返回量化后的 backing/DPR，不能直接与带小数的设计表面比较
   * 来判断 resize 幂等性。
   */
  private rendererRequestedWidth = Number.NaN;
  private rendererRequestedHeight = Number.NaN;
  private anticipationVisualOperation: VisualTelemetryOperation | null = null;
  private launchIntroVisualOperation: VisualTelemetryOperation | null = null;
  private backgroundIntroVisualOperation: VisualTelemetryOperation | null = null;
  private destroyed = false;

  getReelPerspectiveDiagnostics(): ReturnType<ReelSetView["getPerspectiveDiagnostics"]> & {
    readonly rendererResolution: number;
    readonly screenWidth: number;
    readonly screenHeight: number;
    readonly anticipation: ReturnType<AnticipationView["getPerspectiveDiagnostics"]>;
  } {
    return Object.freeze({
      ...this.reels.getPerspectiveDiagnostics(),
      rendererResolution: this.app.renderer.resolution,
      screenWidth: this.app.renderer.screen.width,
      screenHeight: this.app.renderer.screen.height,
      anticipation: this.anticipation.getPerspectiveDiagnostics(),
    });
  }

  /** 仅浏览器捕获诊断；从不提供渲染或游戏状态。 */
  getReelCabinetCompositionDiagnostics(): ReturnType<
    ReelSetView["getCabinetCompositionDiagnostics"]
  > & {
    readonly renderer: Readonly<{
      screenWidth: number;
      screenHeight: number;
      resolution: number;
    }>;
  } {
    return Object.freeze({
      ...this.reels.getCabinetCompositionDiagnostics(),
      renderer: Object.freeze({
        screenWidth: this.app.renderer.screen.width,
        screenHeight: this.app.renderer.screen.height,
        resolution: this.app.renderer.resolution,
      }),
    });
  }

  constructor(
    host: HTMLElement,
    options: PixiRendererOptions = {},
    stagedOwners?: PixiRendererOwners,
  ) {
    const owners = stagedOwners ?? createEagerPixiRendererOwners(options);
    this.app = owners.app;
    this.reels = owners.reels;
    this.scene = owners.scene;
    this.camera = owners.camera;
    this.launchScene = owners.launchScene;
    this.gameLogo = owners.gameLogo;
    this.jackpotTower = owners.jackpotTower;
    this.featurePreview = owners.featurePreview;
    this.visualTelemetry = owners.visualTelemetry;
    this.freeSpinHud = owners.freeSpinHud;
    this.bigWin = owners.bigWin;
    this.anticipation = owners.anticipation;
    this.backdrop = owners.backdrop;
    this.winCelebration = owners.winCelebration;
    this.wheelBonusWinLabel = owners.wheelBonusWinLabel;
    this.canvasHost = host;
    this.characterCollectRandomSource = options.characterCollectRandomSource ?? Math.random;
    owners.freeSpinCallbacks.onCapInteraction = (phase) => {
      this.featurePresentationMilestoneListener?.(
        phase === "input-ready" ? "free-spin-cap.input-ready" : "free-spin-cap.continue",
      );
    };
    owners.freeSpinCallbacks.onCapClose = (reason) => {
      this.notifyFeaturePresentationBranch({ type: "free-spin-cap.closed", reason });
    };
    owners.freeSpinCallbacks.onCapInputReadyCheckpoint = () => (
      this.featurePresentationInputCheckpointListener?.("free-spin-cap")
    );
    this.reels.setVisualTelemetryReporter(this.visualTelemetry);
    const resolution = Math.min(globalThis.devicePixelRatio || 1, 2);
    this.reels.setPerspectiveCoordinateScale(resolution);
    this.anticipation.setPerspectiveCoordinateScale(resolution);
    // 在任何预设的不透明添加剂 Spine 页面可以进入过滤器渲染目标之前，保持 Pixi 的 ADD 状态与 GameMainGameView 逐字节对齐。
    const additiveBlendRenderer = this.app.renderer as unknown as PrimalAdditiveBlendRenderer;
    installPrimalAdditiveBlendMode(additiveBlendRenderer);
    this.additiveBlendContextListener = createPrimalAdditiveBlendContextListener(
      additiveBlendRenderer,
    );
    // 每当 WebGL 恢复时，StateSystem 都会重新创建混合模式表。它已经在此侦听器之前注册，因此在重置之后和下一个预设的 Spine 帧之前重新应用原始元组。
    additiveBlendRenderer.runners?.contextChange?.add(this.additiveBlendContextListener);
    this.app.view.setAttribute("aria-label", "Primal Rampage VideoSlot reels");
    this.app.view.setAttribute("role", "img");
    if (this.app.view.parentElement !== host) host.appendChild(this.app.view);

    this.backdrop.setReducedMotion(this.reducedMotion?.matches ?? false);
    this.bigWin.setReducedMotion(this.reducedMotion?.matches ?? false);
    this.reducedMotion?.addEventListener("change", this.handleReducedMotionChange);
    this.camera.farLayer.addChild(this.backdrop);
    this.camera.foregroundLayer.addChild(this.backdrop.foregroundView);
    this.camera.gameLayer.addChild(
      this.gameLogo,
      this.jackpotTower,
      this.reels,
      this.reels.additiveFrameOverlay,
      this.reels.winningSymbolAdditiveOverlay,
      this.anticipation,
    );
    this.launchScene.setReducedMotion(this.reducedMotion?.matches ?? false);
    // 不透明的附加预期图集无法展平为 Pixi 的正常卷轴目标。其独立透视通道复合为 ADD，保持 RGB 黑色等于 0，同时保留原始同级顺序。
    this.syncAnticipationComposition();
    this.featureEffects = new FeatureEffects(
      this.camera.fxLayer,
      this.reels,
      () => this.characterCollectPresentationTarget(),
      {
        onReelStructure: (direction) => {
          const plan = characterReelStructurePlan(direction, this.featureMode);
          this.launchScene.setCharacterBodyContinuation(plan.continuation, false);
          this.playCharacterAnimation(plan.animation, "grid.expanded");
          if (plan.audioMilestone) this.featurePresentationMilestoneListener?.(plan.audioMilestone);
        },
        onWheelPopupReady: () => {
          this.featurePresentationMilestoneListener?.("wheel.popup-input-ready");
        },
        onWheelPopupInputReadyCheckpoint: () => (
          this.featurePresentationSemanticCheckpointListener?.("wheel.popup-input-ready")
        ),
        onWheelPopupClose: () => {
          this.featurePresentationMilestoneListener?.("wheel.popup-complete");
        },
        onWheelReady: () => {
          this.featurePresentationMilestoneListener?.("wheel.input-ready");
        },
        onWheelInputReadyCheckpoint: () => (
          this.featurePresentationSemanticCheckpointListener?.("wheel.input-ready")
        ),
        // `onWheelSpinStart`仅在玩家确认Wheel后才会发出。  在此输入边界上保持累积奖金重置：原始塔故意保留其先前的状态，而 Wheel 简介可见并等待输入。
        onWheelSpinStart: () => this.beginWheelSpinPresentation(),
        onWheelSpinStartCheckpoint: () => this.onWheelSpinStartCheckpoint(),
        onWheelQuickStop: () => {
          this.featurePresentationMilestoneListener?.("wheel.quick-stop");
        },
        onWheelSpinFinish: () => {
          this.launchScene.setCharacterBodyContinuation("feature", false);
          this.playCharacterAnimation("win", "wheel.spin-finish");
          this.commitPendingWheelAward();
          this.featurePresentationMilestoneListener?.("wheel.spin-finish");
        },
        onWheelLandingCheckpoint: () => (
          this.featurePresentationSemanticCheckpointListener?.("wheel.landing")
        ),
        onWheelSpinAbort: () => {
          this.abortWheelPresentation();
          this.featurePresentationMilestoneListener?.("wheel.spin-abort");
        },
        onWheelSummaryReady: () => {
          this.featurePresentationMilestoneListener?.("wheel.summary-input-ready");
        },
        onWheelSummaryClose: () => {
          this.featurePresentationMilestoneListener?.("wheel.summary-complete");
        },
        onWheelBonusLabelReady: (event, reducedMotion) => {
          this.presentWheelBonusLabel(event, reducedMotion);
        },
        onFreeSpinsReady: () => {
          this.featurePresentationMilestoneListener?.("free-spins.input-ready");
        },
        onFreeSpinsContinue: () => {
          this.beginFreeSpinsPlayPresentation();
        },
        onFreeSpinSummaryReady: () => {
          this.featurePresentationMilestoneListener?.("free-spins.summary-input-ready");
        },
        onFreeSpinSummaryInputReadyCheckpoint: () => (
          this.featurePresentationInputCheckpointListener?.("free-spins-summary")
        ),
        onFreeSpinSummaryClose: (closeReason) => {
          this.featurePresentationMilestoneListener?.("free-spins.summary-complete");
          this.notifyFeaturePresentationBranch({
            type: "free-spins.summary.closed",
            reason: closeReason,
          });
        },
        onRageRespin: () => {
          this.playCharacterAnimation("respin", "rage.cascade.respin");
        },
        onRagePound: () => {
          this.playCharacterAnimation("pound", "rage.cascade.pound");
        },
        onRageBackdropShake: () => {
          this.backdrop.playAuthoredShake(1);
        },
        onRageCollectionCommitted: () => {
          this.jackpotTower.reactToCollection();
        },
        onRageCollectionMilestone: (milestone) => {
          this.notifyRageCollectionPresentationMilestone(milestone);
        },
        onFreeSpinSummaryHideStart: () => {
          void this.freeSpinHud.hide();
          this.featurePresentationMilestoneListener?.("free-spins.summary-hide");
        },
      },
      options.wheelStopOffsetSource,
      this.visualTelemetry,
      options.rageCascadeCellOrderSource,
    );
    // `main.reel.winLabelOverlay` 是前景卷轴覆盖。在接管/正常中奖视图之后添加它，这样一旦 Wheel 场景释放，空的较高兄弟就无法埋葬持有的大师中奖板。
    // 分阶段业主可能已在 FeatureEffects 之前建造。重新添加确切的最终同级以确定性地恢复原始 FX 顺序。
    this.camera.fxLayer.addChild(
      this.featureEffects.view,
      this.winCelebration.view,
      this.wheelBonusWinLabel.view,
    );
    this.bigWin.setMilestoneListener((milestone) => this.bigWinMilestoneListener?.(milestone));
    this.scene.addChild(this.camera, this.launchScene.overlay, this.freeSpinHud, this.bigWin);
    this.app.stage.addChild(this.scene, this.featurePreview.view);
    this.app.ticker.add(() => {
      const deltaMs = this.app.ticker.deltaMS;
      const environmentFrame = sampleSpinEnvironment(this.environmentState, performance.now());
      this.backdrop.setExpansionRows(this.reels.activeRows);
      this.backdrop.setEnvironmentFrame(environmentFrame);
      this.reels.setEnvironmentFrame(environmentFrame);
      if (!this.rageCascadePresentationPaused) this.backdrop.update(deltaMs);
      if (!this.rageCollectionPresentationPaused && !this.rageCascadePresentationPaused) {
        this.launchScene.update(deltaMs);
      }
      this.gameLogo.update(deltaMs);
      if (!this.rageCollectionPresentationPaused) this.jackpotTower.update(deltaMs);
      if (!this.rageCascadePresentationPaused) this.reels.update(deltaMs);
      this.wheelBonusWinLabel.update(deltaMs);
      this.freeSpinHud.update(deltaMs);
      this.bigWin.update(deltaMs);
      this.featurePreview.update(deltaMs);
    });
  }

  /**
   * 跨多个已绘制帧构造最终渲染组件，再把这些确切实例交给同步连接的 PixiRenderer。
   * 不会构建后丢弃任何预检组件。
   */
  static async createStaged(
    host: HTMLElement,
    options: PixiRendererOptions = {},
    construction: PixiRendererStagedCreateOptions = {},
  ): Promise<PixiRenderer> {
    const state: StagedPixiRendererOwnerState = {
      ownershipTransfer: createStagedGraphOwnershipTransfer(),
      renderer: null,
    };
    const requestFrame = construction.requestFrame ?? requestRendererConstructionFrame;
    const stages = pixiRendererOwnerConstructionStages(state, options, host);
    const ownership = await runStagedComponentConstruction(stages, {
      signal: construction.signal,
      requestFrame,
      onProgress: construction.onProgress,
      onStage: construction.onStage,
    });
    try {
      throwIfRendererConstructionAborted(construction.signal);
      const renderer = state.renderer;
      if (!renderer) throw new Error("Staged PixiRenderer graph was not constructed");
      ownership.release();
      construction.onProgress?.(1);
      return renderer;
    } catch (error) {
      ownership.dispose();
      throw error;
    }
  }


  async loadCriticalAssets(options: PixiRendererLaunchOptions = {}): Promise<void> {
    this.assertLaunchActive(options.signal);
    let hasAuthoredSymbols = false;
    let authoredSymbolClipReadiness: AuthoredSymbolClipReadiness = {
      land: false,
      win: false,
    };
    const requiredAuthoredLoad = (
      descriptor: VisualTelemetryDescriptor,
      action: FractionalLaunchLoad,
      postcondition: () => boolean = () => true,
      fallback: "bitmap" | "procedural" | "text" | "none" = "none",
    ): FractionalLaunchLoad => async (report) => {
      try {
        await action(report);
      } catch (error) {
        this.visualTelemetry.failedToStart(descriptor, {
          stage: "load",
          code: "asset-load-failed",
          fallback,
        });
        throw error;
      }
      if (!postcondition()) {
        this.visualTelemetry.failedToStart(descriptor, {
          stage: "create",
          code: "spine-create-failed",
          fallback,
        });
        return;
      }
      this.visualTelemetry.loaded(descriptor);
    };
    const backgroundIntro: VisualTelemetryDescriptor = {
      id: "background.intro",
      requirement: "required",
      mode: "authored",
      sourceEvent: "launch.preload",
    };
    const reelFrame: VisualTelemetryDescriptor = {
      id: "reel.frame",
      requirement: "required",
      mode: "authored",
      sourceEvent: "launch.preload",
    };
    const launchIntro: VisualTelemetryDescriptor = {
      id: "launch.intro",
      requirement: "required",
      mode: "authored",
      sourceEvent: "launch.preload",
    };
    const characterAnimation: VisualTelemetryDescriptor = {
      id: "character.animation",
      requirement: "required",
      mode: "authored",
      sourceEvent: "launch.preload",
    };
    const loads: readonly FractionalLaunchLoad[] = [
      requiredAuthoredLoad(
        backgroundIntro,
        (report) => this.backdrop.loadArtwork(options.signal, report),
        () => this.backdrop.hasAuthoredEnvironment,
        "bitmap",
      ),
      requiredAuthoredLoad(
        reelFrame,
        () => this.reels.loadAuthoredFrame(options.signal),
        () => this.reels.authoredFrameLoaded,
        "procedural",
      ),
      (report) => this.reels.prepareMaximumRows({
        signal: options.signal,
        onProgress: report,
      }),
      () => this.jackpotTower.loadArtwork(options.signal),
      () => loadSymbolTextures(),
      async (report) => {
        try {
          await loadAuthoredSymbolSpines();
        } catch (error) {
          for (const id of ["reel.symbol.land", "reel.symbol.win"] as const) {
            this.visualTelemetry.failedToStart({
              id,
              requirement: "required",
              mode: "authored",
              sourceEvent: "launch.preload",
            }, {
              stage: "load",
              code: "asset-load-failed",
              fallback: "bitmap",
            });
          }
          throw error;
        }
        try {
          const gaps = await validateAuthoredSymbolRequiredClips({
            signal: options.signal,
            requestFrame: () => this.nextLaunchFrame(options.signal),
            onProgress: report,
          });
          authoredSymbolClipReadiness = reportAuthoredSymbolClipReadiness(
            this.visualTelemetry,
            gaps,
          );
          hasAuthoredSymbols = true;
        } catch (error) {
          for (const id of ["reel.symbol.land", "reel.symbol.win"] as const) {
            this.visualTelemetry.failedToStart({
              id,
              requirement: "required",
              mode: "authored",
              sourceEvent: "launch.preload",
            }, {
              stage: "create",
              code: "spine-create-failed",
              fallback: "bitmap",
            });
          }
          throw error;
        }
      },
      () => this.gameLogo.loadArtwork(options.signal),
      async () => {
        try {
          await loadFeatureTextures();
        } catch (error) {
          const failedFeatures = [
            ["rage.collect", "procedural"],
            ["free-spin.trails", "none"],
          ] as const;
          for (const [id, fallback] of failedFeatures) {
            this.visualTelemetry.failedToStart({
              id,
              requirement: "conditional",
              mode: "authored",
              sourceEvent: "launch.preload",
            }, {
              stage: "load",
              code: "asset-load-failed",
              fallback,
            });
          }
          throw error;
        }
      },
      async () => {
        try {
          await this.launchScene.loadArtwork(options.signal);
        } catch (error) {
          for (const descriptor of [launchIntro, characterAnimation]) {
            this.visualTelemetry.failedToStart(descriptor, {
              stage: "load",
              code: "asset-load-failed",
              fallback: "bitmap",
            });
          }
          throw error;
        }
        const missingLaunchArtwork: string[] = [];
        if (this.launchScene.hasAuthoredIntroLogo) this.visualTelemetry.loaded(launchIntro);
        else {
          this.visualTelemetry.failedToStart(launchIntro, {
            stage: "create",
            code: "spine-create-failed",
            fallback: "bitmap",
          });
          missingLaunchArtwork.push("intro logo");
        }
        if (this.launchScene.hasAuthoredCharacter) this.visualTelemetry.loaded(characterAnimation);
        else {
          this.visualTelemetry.failedToStart(characterAnimation, {
            stage: "create",
            code: "spine-create-failed",
            fallback: "bitmap",
          });
          missingLaunchArtwork.push("character");
        }
        if (missingLaunchArtwork.length > 0) {
          throw new Error(`Required authored launch artwork missing: ${missingLaunchArtwork.join(", ")}`);
        }
      },
      async () => {
        const loaded = await this.featurePreview.loadArtwork(options.signal);
        if (!loaded || !this.featurePreview.hasArtwork) {
          throw new Error("Required authored feature preview artwork missing");
        }
      },
      requiredAuthoredLoad({
        id: "reel.anticipation",
        requirement: "conditional",
        mode: "authored",
        sourceEvent: "launch.preload",
      }, () => this.anticipation.loadArtwork(options.signal), () => this.anticipation.artworkLoaded, "procedural"),
      requiredAuthoredLoad({
        id: "win.normal-record",
        requirement: "conditional",
        mode: "authored",
        sourceEvent: "launch.preload",
      }, () => this.winCelebration.loadArtwork(options.signal), () => this.winCelebration.artworkLoaded, "procedural"),
      requiredAuthoredLoad({
        id: "win.wheel-label",
        requirement: "conditional",
        mode: "authored",
        sourceEvent: "launch.preload",
      }, () => this.wheelBonusWinLabel.loadArtwork(options.signal), () => (
        this.wheelBonusWinLabel.artworkLoaded
      ), "text"),
    ];
    await runBoundedLaunchLoads(
      loads,
      4,
      (fraction) => options.onProgress?.(fraction),
      () => !this.destroyed && options.signal?.aborted !== true,
    );
    this.assertLaunchActive(options.signal);
    // 解析图集还没有准备好：将加载器后面的每个固定的 3x8 Spine 视图实例化为有界的、可取消的帧切片。
    try {
      await this.reels.setAuthoredSymbolsEnabledFrameSliced(hasAuthoredSymbols, {
        signal: options.signal,
        requestFrame: () => this.nextLaunchFrame(options.signal),
      });
    } catch (error) {
      for (const id of ["reel.symbol.land", "reel.symbol.win"] as const) {
        this.visualTelemetry.failedToStart({
          id,
          requirement: "required",
          mode: "authored",
          sourceEvent: "launch.preload",
        }, {
          stage: "create",
          code: "spine-create-failed",
          fallback: "bitmap",
        });
      }
      throw error;
    }
    if (hasAuthoredSymbols && authoredSymbolClipReadiness.land) {
      this.visualTelemetry.loaded({
        id: "reel.symbol.land",
        requirement: "required",
        mode: "authored",
        sourceEvent: "launch.preload",
      });
    }
    if (hasAuthoredSymbols && authoredSymbolClipReadiness.win) {
      this.visualTelemetry.loaded({
        id: "reel.symbol.win",
        requirement: "required",
        mode: "authored",
        sourceEvent: "launch.preload",
      });
    }
    if (this.backdrop.hasAuthoredEnvironment) {
      this.visualTelemetry.loaded({
        id: "background.palette",
        requirement: "conditional",
        mode: "authored",
        sourceEvent: "launch.preload",
      });
    }
    this.launchScene.setAuthoredEnvironment(this.backdrop.hasAuthoredEnvironment);
  }

  setVisualTelemetryListener(
    listener: VisualTelemetryListener | null,
    contextProvider: VisualTelemetryContextProvider | null = null,
  ): void {
    this.visualTelemetry?.setContextProvider(contextProvider);
    this.visualTelemetry?.setListener(listener);
  }

  private reportActivatedVisualFailure(
    descriptor: VisualTelemetryDescriptor,
    failure: Parameters<VisualTelemetryReporter["failedToStart"]>[1],
  ): void {
    // 仅原型渲染器调用和部分构造后的拆卸路径会刻意省略观察者；遥测必须保持故障开放。
    this.visualTelemetry?.failedToStart(descriptor, failure);
  }

  private playCharacterAnimation(
    animation: string,
    sourceEvent: string,
    loop = false,
  ): boolean {
    const played = loop
      ? this.launchScene.playCharacterAnimation(animation, true)
      : this.launchScene.playCharacterAnimation(animation);
    if (!played) {
      this.reportActivatedVisualFailure({
        id: "character.animation",
        requirement: "conditional",
        mode: "authored",
        clips: [animation],
        sourceEvent,
      }, {
        stage: "animation",
        code: "missing-animation",
        fallback: "bitmap",
      });
    }
    return played;
  }

  private playCharacterCollect(sourceEvent: string): boolean {
    let random = 0;
    try {
      random = this.characterCollectRandomSource();
    } catch {
      // 外观测试源无法中断已接受的功能事件。
      random = Math.random();
    }
    const bodyClip = characterCollectAnimationForRandom(random);
    const played = this.launchScene.playCharacterCollect(random);
    this.activeRageCollectionCharacter = Object.freeze({ bodyClip, started: played });
    if (!played) {
      this.reportActivatedVisualFailure({
        id: "character.animation",
        requirement: "conditional",
        mode: "authored",
        clips: ["rage_collect", "collect_random"],
        sourceEvent,
      }, {
        stage: "animation",
        code: "missing-animation",
        fallback: "bitmap",
      });
    }
    return played;
  }

  private characterCollectPresentationTarget(): Point {
    if (!this.launchScene.hasCharacterCollectBone) {
      this.reportActivatedVisualFailure({
        id: "rage.collect",
        requirement: "conditional",
        mode: "authored",
        sourceEvent: "surge.collected",
      }, {
        stage: "slot",
        code: "missing-bone",
        fallback: "procedural",
      });
    }
    return this.launchScene.getCharacterCollectTarget(this.camera.fxLayer);
  }

  private playReelFrame(
    animation: string,
    sourceEvent: string,
    loop = false,
    seekSeconds = 0,
  ): boolean {
    const played = seekSeconds > 0
      ? this.reels.playAuthoredFrame(animation, loop, seekSeconds)
      : loop
        ? this.reels.playAuthoredFrame(animation, true)
        : this.reels.playAuthoredFrame(animation);
    if (!played) {
      this.reportActivatedVisualFailure({
        id: "reel.frame",
        requirement: "conditional",
        mode: "authored",
        clips: [animation],
        sourceEvent,
      }, {
        stage: "animation",
        code: "missing-animation",
        fallback: "procedural",
      });
    }
    return played;
  }

  setResponsiveComposition(scale: number): void {
    this.launchScene.setResponsiveComposition(scale);
    const visibleInsetX = responsiveVisibleInset(
      this.canvasHost.parentElement?.style.getPropertyValue("--visible-inset-x"),
    );
    this.gameLogo.setResponsiveLayout(visibleInsetX);
    this.jackpotTower.setResponsiveLayout(visibleInsetX);
    this.syncAnticipationComposition();
  }

  /** 将一个不可变的桌面/移动快照路由到每个独立布局的 Z 层。 */
  setResponsiveLayout(snapshot: ResponsiveLayoutSnapshot): void {
    this.featurePreview.setResponsiveLayout(snapshot);
    this.freeSpinHud.setResponsiveLayout(snapshot);
    this.launchScene.setResponsiveTransitionLayout(
      snapshot.viewportRegion,
      snapshot.mobileProfile,
    );
    this.resizeRenderer(
      snapshot.viewportRegion.width,
      snapshot.viewportRegion.height,
      snapshot.pixelRatio,
    );
    this.camera.setViewportSize(
      snapshot.viewportRegion.width,
      snapshot.viewportRegion.height,
    );
    this.featureEffects.setResponsiveLayoutTrack(
      snapshot.viewportRegion.width > snapshot.viewportRegion.height
        ? "layout/horizontal"
        : "layout/vertical",
    );
    if (snapshot.channel === "desktop") {
      const frame = snapshot.desktopFrame;
      if (!frame) return;
      this.featureEffects.setWheelOverlayRegion({
        left: 0,
        top: 0,
        width: LOGICAL_WIDTH,
        height: LOGICAL_HEIGHT,
      });
      this.bigWin.setResponsiveLayout({
        left: 0,
        top: 0,
        width: LOGICAL_WIDTH,
        height: LOGICAL_HEIGHT,
      });
      this.backdrop.setResponsiveNodeTransform(null);
      this.gameLogo.setResponsiveNodeTransform(null);
      this.setResponsiveComposition(responsiveCompositionScale(frame));
      return;
    }

    const transforms = snapshot.mobileTransforms;
    const profile = snapshot.mobileProfile;
    if (!transforms || !profile) return;
    this.featureEffects.setWheelOverlayRegion(snapshot.gameplayRegion);
    this.bigWin.setResponsiveLayout(snapshot.gameplayRegion);
    this.backdrop.setResponsiveNodeTransform(transforms.background);
    this.launchScene.setMobileNodeTransforms(
      transforms.character,
      profile,
      snapshot.viewportRegion,
    );
    this.gameLogo.setResponsiveNodeTransform(transforms.logo, profile);
    this.jackpotTower.setMobileLayout(
      profile,
      snapshot.handMode,
      snapshot.gameplayRegion,
    );
    this.syncAnticipationComposition();
  }

  private resizeRenderer(width: number, height: number, pixelRatio: number): void {
    const safeWidth = Number.isFinite(width) && width > 0 ? Math.max(1, width) : 1;
    const safeHeight = Number.isFinite(height) && height > 0 ? Math.max(1, height) : 1;
    const resolution = Math.max(1, Math.min(
      2,
      Number.isFinite(pixelRatio) ? pixelRatio : 1,
    ));
    const resolutionChanged = Math.abs(this.app.renderer.resolution - resolution) > 1e-9;
    if (this.rendererRequestedWidth === safeWidth
      && this.rendererRequestedHeight === safeHeight
      && !resolutionChanged) return;
    if (resolutionChanged) {
      this.app.renderer.resolution = resolution;
      this.reels.setPerspectiveCoordinateScale(resolution);
      this.anticipation.setPerspectiveCoordinateScale(resolution);
    }
    this.app.renderer.resize(safeWidth, safeHeight);
    this.rendererRequestedWidth = safeWidth;
    this.rendererRequestedHeight = safeHeight;
  }

  private syncAnticipationComposition(): void {
    this.anticipation.syncToReelHost(this.reels);
  }

  setJackpotBet(betMinor: MoneyMinor): void {
    this.jackpotTower.setBet(betMinor);
  }

  /** 将一次会话交换的同一不可变格式器同步给所有 Pixi 金额表面。 */
  setMoneyDisplayBinding(binding: Readonly<MoneyDisplayBinding>): void {
    const formatter = createMinorUnitFormatter(binding);
    this.jackpotTower.setMoneyFormatter(formatter);
    this.bigWin.setMoneyFormatter(formatter);
    this.winCelebration.setMoneyFormatter(formatter);
    this.wheelBonusWinLabel.setMoneyFormatter(formatter);
    this.featureEffects.setMoneyFormatter(formatter);
  }

  restoreFeatureState(state: FeatureState): void {
    this.featureMode = state.mode;
    this.reels.setVisualStripMode(state.mode);
    const plan = persistentFeatureVisualPlan(state);
    this.backdrop.restoreAuthoredPalette(plan.backdrop);
    this.launchScene.setCharacterPersistentPresentation(plan.character);
    this.freeSpinHud.restoreFeatureState(state);
    if (state.mode !== "BASE" || !this.introCompleted) this.gameLogo.hide(true);
    else this.gameLogo.show();
  }

  /**
   * 在权威事件进入可见状态前，把目标包的已验证 bytes 原子交给对应消费者。
   * 依赖包仍由外层 StreamingAssetEventLease 保持，不在这里重复请求。
   */
  async adoptVerifiedFeatureArtwork(
    kind: VerifiedFeatureArtworkKind,
    loaded: LoadedAssetPackage,
    signal?: AbortSignal,
  ): Promise<void> {
    const artwork = await verifiedFeatureArtworkFromPackage(loaded, kind, signal);
    if (this.destroyed || signal?.aborted) {
      if (artwork.kind === "wheel") disposeVerifiedWheelArtwork(artwork);
      throw signal?.reason instanceof Error
        ? signal.reason
        : new Error("Verified feature artwork adoption was aborted");
    }
    if (artwork.kind === "wheel") {
      this.featureEffects.adoptVerifiedWheelArtwork(artwork);
      return;
    }
    try {
      this.featureEffects.adoptVerifiedFreeSpinArtwork(artwork);
      await this.freeSpinHud.loadArtwork(signal, artwork);
    } catch (error) {
      this.featureEffects.releaseVerifiedFeatureArtwork("free-spins");
      this.freeSpinHud.clearArtwork();
      throw error;
    }
  }

  releaseVerifiedFeatureArtwork(kind: VerifiedFeatureArtworkKind): void {
    this.featureEffects.releaseVerifiedFeatureArtwork(kind);
    if (kind === "free-spins") this.freeSpinHud.clearArtwork();
  }

  showFreeSpinHud(state: FeatureState): Promise<void> {
    const operation = this.visualTelemetry?.start({
      id: "free-spin.hud",
      requirement: "conditional",
      mode: "authored",
      sourceEvent: "free_spins.started",
    });
    return this.freeSpinHud.show(state).then(() => {
      if (operation) this.visualTelemetry?.complete(operation, "natural");
    }, (error) => {
      if (operation) this.visualTelemetry?.fail(operation, {
        stage: "runtime",
        code: "playback-failed",
        fallback: "text",
      });
      throw error;
    });
  }

  updateFreeSpinHud(state: FeatureState): void {
    this.freeSpinHud.updateFeatureState(state);
  }

  async presentFreeSpinAwardBatch(
    events: readonly Readonly<FreeSpinAwardedEvent>[],
    state: FeatureState,
    reducedMotion = false,
  ): Promise<void> {
    // 在创建任何跟踪源/目标对之前，
    // 捕获的 startDelayLaunchTrails 在每个解析的免费 Spin Vault 上调用 playVaultUnlockExtraFS。
    for (const address of vaultFreeSpinActivationCells(events)) {
      this.reels.playVaultFreeSpinActivation(address);
    }
    this.noteResolvedVaultAwards(events.length);
    this.freeSpinHud.applyFreeSpinAwardBatch(events, state);
    const target = this.freeSpinHud.getCollectTarget(this.featureEffects.view);
    await this.featureEffects.presentFreeSpinAwardTrails(events, target, reducedMotion);
  }

  presentFreeSpinCap(event: FreeSpinCapReachedEvent, state: FeatureState): Promise<void> {
    this.noteResolvedVaultAwards(1);
    const operation = this.visualTelemetry?.start({
      id: "free-spin.retrigger",
      requirement: "conditional",
      mode: "authored",
      sourceEvent: event.type,
    });
    return this.freeSpinHud.retriggerCap(event, state).then(() => {
      if (operation) this.visualTelemetry?.complete(operation, "natural");
    }, (error) => {
      if (operation) this.visualTelemetry?.fail(operation, {
        stage: "runtime",
        code: "playback-failed",
        fallback: "text",
      });
      throw error;
    });
  }

  /**
   * 镜像突变开始时的一个 GameJackpotController.instantWin 调用。升级事件仅包含更改的单元格，
   * 因此保留已寻址的目标面并在突出显示之前重建完整的当前 Vault 集。
   */
  highlightVaultMutationBatch(
    events: readonly Readonly<VaultUnlockedEvent | VaultUpgradedEvent>[],
  ): void {
    for (const event of events) {
      this.vaultMutationPrizeByCell.set(`${event.reel}:${event.row}`, event.prize);
    }
    const tiers = vaultJackpotMutationTiers(
      [...this.vaultMutationPrizeByCell.values()].map((prize) => ({ prize })),
    );
    this.pendingVaultAwardTiers.clear();
    tiers.forEach((tier) => this.pendingVaultAwardTiers.add(tier));
    if (tiers.length > 0) this.jackpotTower.highlightAwards(tiers);
  }

  hideFreeSpinHud(): Promise<void> {
    return this.freeSpinHud.hide();
  }

  startReelAnticipation(): void {
    const alreadyActive = this.anticipation.active;
    this.reels.startRageAnticipation();
    this.anticipation.start();
    if (alreadyActive) return;
    this.anticipationVisualOperation = this.visualTelemetry?.start({
      id: "reel.anticipation",
      requirement: "conditional",
      mode: "authored",
      sourceEvent: "reel.anticipation.start",
    }) ?? null;
  }

  stopReelAnticipation(immediate = false): void {
    this.reels.endRageAnticipation();
    this.anticipation.stop(immediate);
    if (this.anticipationVisualOperation) {
      this.visualTelemetry?.complete(
        this.anticipationVisualOperation,
        immediate
          ? "cancelled"
          : this.reducedMotion?.matches ? "reduced-motion-skip" : "natural",
      );
      this.anticipationVisualOperation = null;
    }
  }

  /** SCATTER_FEATURE_ACTIVATE 将 ape 和所有三个 Symbol7 夹子一起驱动。 */
  playPostStopSurgeActivation(): void {
    this.playCharacterAnimation("feature_activation", "surge.post-stop-activation");
  }

  /** 应用 PPS EVOLVE 而不重置角色身体动画。 */
  setRageAuraLevel(level: number): void {
    this.launchScene.setCharacterAuraLevel(level > 1 ? level : null);
  }

  setJackpotHudReveal(progress: number): void {
    this.jackpotTower.setHudReveal(progress);
  }

  setCharacterAnimationListener(listener: CharacterAnimationListener | null): void {
    this.launchScene.setCharacterAnimationListener(listener);
  }

  setFeaturePresentationMilestoneListener(
    listener: FeaturePresentationMilestoneListener | null,
  ): void {
    this.featurePresentationMilestoneListener = listener;
  }

  setFeaturePresentationBranchListener(
    listener: FeaturePresentationBranchListener | null,
  ): void {
    this.featurePresentationBranchListener = listener;
  }

  setFeaturePresentationInputCheckpointListener(
    listener: FeaturePresentationInputCheckpointListener | null,
  ): void {
    this.featurePresentationInputCheckpointListener = listener;
  }

  setFeaturePresentationSemanticCheckpointListener(
    listener: FeaturePresentationSemanticCheckpointListener | null,
  ): void {
    this.featurePresentationSemanticCheckpointListener = listener;
  }

  setRageCollectionPresentationMilestoneListener(
    listener: RageCollectionPresentationMilestoneListener | null,
  ): void {
    this.rageCollectionPresentationMilestoneListener = listener;
  }

  setRageCascadePresentationMilestoneListener(
    listener: RageCascadePresentationMilestoneListener | null,
  ): void {
    this.rageCascadePresentationMilestoneListener = listener;
    this.featureEffects?.setRageCascadeMilestoneListener(listener
      ? (milestone) => this.notifyRageCascadePresentationMilestone(milestone)
      : null);
  }

  setVaultUnlockPresentationMilestoneListener(
    listener: VaultUnlockPresentationMilestoneListener | null,
  ): void {
    this.vaultUnlockPresentationMilestoneListener = listener;
    this.featureEffects?.setVaultUnlockMilestoneListener(listener
      ? (milestone) => this.notifyVaultUnlockPresentationMilestone(milestone)
      : null);
  }

  private async notifyVaultUnlockPresentationMilestone(
    milestone: Readonly<VaultUnlockPresentationMilestone>,
  ): Promise<void> {
    const listener = this.vaultUnlockPresentationMilestoneListener;
    if (!listener) return;
    try {
      await listener(milestone);
    } catch {
      // 只读捕获观察者无法中断预设的时钟。
    }
  }

  /** 保存级联控制器及其字符/帧/符号 Spine 时钟。 */
  setRageCascadePresentationPaused(active: boolean): void {
    if (this.rageCascadePresentationPaused === active) return;
    this.rageCascadePresentationPaused = active;
    this.featureEffects?.setRageCascadePlaybackPaused(active);
  }

  private notifyRageCascadePresentationMilestone(
    milestone: Readonly<RageCascadeEffectMilestone>,
  ): void {
    try {
      this.rageCascadePresentationMilestoneListener?.(milestone);
    } catch {
      // 诊断观察者无法更改预设的级联状态机。
    }
  }

  /**
   * 确定性的屏幕截图接口。它仅暂停活动的 Rage 源、收集线索、角色、大奖反应及其本地生命周期。
   */
  setRageCollectionPresentationPaused(active: boolean): void {
    if (this.rageCollectionPresentationPaused === active) return;
    this.rageCollectionPresentationPaused = active;
    this.featureEffects.setRageCollectionPlaybackPaused(active);
  }

  private notifyRageCollectionPresentationMilestone(
    milestone: Readonly<RageCollectionEffectMilestone>,
  ): void {
    const character = this.activeRageCollectionCharacter;
    const presentation = Object.freeze({
      ...milestone,
      cells: Object.freeze(milestone.cells.map((cell) => Object.freeze({ ...cell }))),
      bodyClip: character?.bodyClip ?? null,
      characterStarted: character?.started ?? false,
    }) satisfies Readonly<RageCollectionPresentationMilestone>;
    try {
      this.rageCollectionPresentationMilestoneListener?.(presentation);
    } catch {
      // 诊断观察者无法更改集合状态机。
    }
    if (milestone.phase === "complete") this.activeRageCollectionCharacter = null;
  }

  private notifyFeaturePresentationBranch(branch: FeaturePresentationBranch): void {
    try {
      this.featurePresentationBranchListener?.(Object.freeze(branch));
    } catch {
      // 诊断观察者不能中断预设的呈现门。
    }
  }

  /** 将唯一的 H+500 切换映射到 B 层及其语义观察者接口上。 */
  private presentWheelBonusLabel(
    event: InstantWheelAwardedEvent,
    reducedMotion: boolean,
  ): void {
    const operation = this.visualTelemetry?.start({
      id: "win.wheel-label",
      requirement: "conditional",
      mode: "authored",
      sourceEvent: event.type,
    });
    void this.wheelBonusWinLabel.show(event.amountMinor, reducedMotion).then((shown) => {
      if (shown) {
        if (operation) this.visualTelemetry?.complete(
          operation,
          reducedMotion ? "reduced-motion-skip" : "natural",
        );
        return;
      }
      if (operation) this.visualTelemetry?.fail(operation, {
        stage: "create",
        code: "empty-presentation",
        fallback: "text",
      });
    }, () => {
      if (operation) this.visualTelemetry?.fail(operation, {
        stage: "runtime",
        code: "playback-failed",
        fallback: "text",
      });
    });
    this.featurePresentationMilestoneListener?.("wheel.bonus-label-ready");
  }

  setBigWinMilestoneListener(listener: BigWinMilestoneListener | null): void {
    this.bigWinMilestoneListener = listener;
  }

  get hasAuthoredFeaturePreview(): boolean {
    return this.featurePreview.hasArtwork;
  }

  attachFeaturePreviewCanvasHost(host: HTMLElement): void {
    this.featurePreviewCanvasHost = host;
  }

  setFeaturePreviewVisible(visible: boolean): void {
    const previewHost = this.featurePreviewCanvasHost;
    this.featurePreview.setVisible(visible);
    this.scene.visible = !visible;
    if (visible && previewHost && this.app.view.parentElement !== previewHost) {
      previewHost.appendChild(this.app.view);
      return;
    }
    if (!visible && this.app.view.parentElement !== this.canvasHost) {
      this.canvasHost.appendChild(this.app.view);
    }
  }

  async warmCriticalAssets(options: PixiRendererLaunchOptions = {}): Promise<void> {
    this.assertLaunchActive(options.signal);
    this.markGpuWarmupStage("graph-exposure");
    options.onProgress?.(0);
    const warmTextures = uniqueGpuWarmupTextures([
      ...loadedSymbolTextures(),
      ...loadedFeatureTextures(),
      ...collectGpuWarmupTextures(this.app.stage),
      Texture.from(PRIMAL_ASSETS.atlases.particles),
    ]);
    const warmup = new Container();
    for (const texture of warmTextures) {
      const sprite = new Sprite(texture);
      sprite.width = 1;
      sprite.height = 1;
      sprite.alpha = 0.001;
      warmup.addChild(sprite);
    }
    this.app.stage.addChild(warmup);
    this.backdrop.setParticleRenderingEnabled(false);
    const restorePresentationState = exposeForOffscreenWarmup(this.app.stage);
    let shaderWarmupTarget: RenderTexture | null = null;
    try {
      const prepare = this.app.renderer.plugins.prepare as
        | { upload(item: DisplayObject): Promise<void> }
        | undefined;
      const prepareGroups = [
        ["textures", splitGpuWarmupTargets(warmup, 1)],
        ["far", splitGpuWarmupTargets(this.camera.farLayer, 1)],
        ["terrain", splitGpuWarmupTargets(this.camera.terrainLayer, 1)],
        // 上面已经隔离了每个图集。图形传递现在保持在组件粒度，因此数百个 Spine 插槽不会各自产生自己的准备插件调度周期。
        ["actor", splitGpuWarmupTargets(this.camera.actorLayer, 1)],
        ["foreground", splitGpuWarmupTargets(this.camera.foregroundLayer, 1)],
        ["game", splitGpuWarmupTargets(this.camera.gameLayer, 2)],
        ["fx", splitGpuWarmupTargets(this.camera.fxLayer, 1)],
        ["intro", splitGpuWarmupTargets(this.launchScene.overlay, 1)],
        ["feature-preview", splitGpuWarmupTargets(this.featurePreview.view, 1)],
      ] as const;
      const prepareTargets = prepareGroups.flatMap(([group, targets]) => (
        targets.map((target, groupIndex) => ({ group, groupIndex, target }))
      ));
      const root = this.canvasHost.closest<HTMLElement>("#app");
      let slowUploads: readonly GpuWarmupUploadDiagnostic[] = [];
      if (root) {
        root.dataset.startupGpuTargetCounts = JSON.stringify(Object.fromEntries(
          prepareGroups.map(([name, targets]) => [name, targets.length]),
        ));
        root.dataset.startupGpuSlowUploads = "[]";
      }
      if (prepare) {
        await runGpuPrepareSlices(prepareTargets, {
          requestFrame: () => this.nextLaunchFrame(options.signal),
          upload: async ({ group, groupIndex, target }, index) => {
            const targetName = target.name || target.constructor.name || "display";
            this.markGpuWarmupStage(`prepare-${index}-${targetName}`);
            const startedAt = gpuWarmupNow();
            await prepare.upload(target);
            this.assertLaunchActive(options.signal);
            try {
              const diagnostic = createGpuWarmupUploadDiagnostic({
                group,
                groupIndex,
                targetType: targetName,
                durationMs: gpuWarmupNow() - startedAt,
                baseTextures: collectGpuWarmupDiagnosticBaseTextures(
                  target as unknown as GpuWarmupDisplayObjectLike,
                ),
                origin: globalThis.location?.origin,
              });
              slowUploads = retainSlowGpuWarmupUploads(slowUploads, diagnostic);
              if (root) root.dataset.startupGpuSlowUploads = JSON.stringify(slowUploads);
            } catch {
              // 诊断是只读的，绝不能将成功的 GPU 上传变成异常 Pixi 资源上的失败启动。
            }
            options.onProgress?.(0.05 + (index + 1) / prepareTargets.length * 0.5);
          },
        });
      } else {
        options.onProgress?.(0.55);
      }
      await this.nextLaunchFrame(options.signal);
      this.markGpuWarmupStage("render-target-create");
      shaderWarmupTarget = RenderTexture.create({
        width: LOGICAL_WIDTH,
        height: LOGICAL_HEIGHT,
        resolution: 1,
      });
      const renderTargets = [
        this.camera.farLayer,
        this.camera.terrainLayer,
        this.camera.actorLayer,
        this.camera.foregroundLayer,
        this.camera.gameLayer,
        this.camera.fxLayer,
        this.launchScene.overlay,
        this.bigWin,
        this.featurePreview.view,
      ];
      for (let index = 0; index < renderTargets.length; index += 1) {
        await this.nextLaunchFrame(options.signal);
        this.markGpuWarmupStage(`render-${index}`);
        this.app.renderer.render(renderTargets[index]!, {
          renderTexture: shaderWarmupTarget,
          clear: index === 0,
        });
        options.onProgress?.(0.58 + (index + 1) / renderTargets.length * 0.24);
      }
      restorePresentationState();
      this.markGpuWarmupStage("final-stage-render");
      await this.nextLaunchFrame(options.signal);
      this.app.renderer.render(this.app.stage);
      options.onProgress?.(0.9);
    } finally {
      restorePresentationState();
      this.backdrop.setParticleRenderingEnabled(true);
      shaderWarmupTarget?.destroy(true);
      if (!this.destroyed) {
        if (warmup.parent === this.app.stage) this.app.stage.removeChild(warmup);
        warmup.destroy({ children: true, texture: false, baseTexture: false });
      }
    }
    this.markGpuWarmupStage("launch-scene-frame");
    await this.launchScene.warmUp();
    this.assertLaunchActive(options.signal);
    options.onProgress?.(1);
    this.app.start();
  }

  private markGpuWarmupStage(stage: string): void {
    const root = this.canvasHost.closest<HTMLElement>("#app");
    if (root) root.dataset.startupGpuStage = stage;
  }

  async prepareLaunch(options: PixiRendererLaunchOptions = {}): Promise<void> {
    await this.loadCriticalAssets({
      signal: options.signal,
      onProgress: (fraction) => options.onProgress?.(fraction * 0.85),
    });
    await this.warmCriticalAssets({
      signal: options.signal,
      onProgress: (fraction) => options.onProgress?.(0.85 + fraction * 0.15),
    });
  }

  /**
   * 仅限化妆品。使用解码后的 `spin.result.wins` 调用此函数；空列表将被忽略，并且此处不计算支付、网格或功能状态。
   */
  reactToWin(wins: readonly Win[], presentation: CharacterWinPresentation): Promise<void> {
    if (wins.length === 0) return Promise.resolve();
    this.gameLogo.win();
    this.launchScene.setCharacterBodyContinuation(presentation, false);
    this.playCharacterAnimation("win", "win.presented");
    // 活动的 Primal 后台控制器没有普通的 WIN 侦听器。城市脉冲和闪电仅属于预设的特征反应。
    return Promise.resolve();
  }

  /** 在与发布 HUD 相同的里程碑处开始预设 Spine 时间表。 */
  cueIntro(cue: string): void {
    switch (cue) {
      case "city.establish":
        this.backdrop.playAuthoredIntro();
        this.launchScene.startAuthoredIntro();
        if (this.backgroundIntroVisualOperation) {
          this.visualTelemetry?.complete(this.backgroundIntroVisualOperation, "cancelled");
        }
        if (this.launchIntroVisualOperation) {
          this.visualTelemetry?.complete(this.launchIntroVisualOperation, "cancelled");
        }
        this.backgroundIntroVisualOperation = this.visualTelemetry?.start({
          id: "background.intro",
          requirement: "required",
          mode: "authored",
          sourceEvent: cue,
        }) ?? null;
        this.launchIntroVisualOperation = this.visualTelemetry?.start({
          id: "launch.intro",
          requirement: "required",
          mode: "authored",
          sourceEvent: cue,
        }) ?? null;
        return;
      case "hud.reveal":
        // 官方角色光环在 4.7 秒时通过 HUD 释放，然后通过介绍到空闲切换保持驻留。 LaunchScene 拥有幂等性保护，因此重复的装饰提示无法重新启动预设的光环/粒子轨道。
        this.launchScene.releaseAuthoredIntroAura();
        return;
    }
  }

  /** 将背景、前景、人物和介绍标志保留在一个时钟上。 */
  seekAuthoredIntro(timeMs: number): void {
    this.backdrop.seekAuthoredIntro(timeMs);
    this.launchScene.seekAuthoredIntro(timeMs);
  }

  completeIntro(skipped: boolean, reducedMotion = false): void {
    this.introCompleted = true;
    const bypassAuthoredMotion = skipped || reducedMotion;
    this.backdrop.completeAuthoredIntro(bypassAuthoredMotion);
    this.launchScene.completeAuthoredIntro(bypassAuthoredMotion);
    const visualOutcome = reducedMotion
      ? "reduced-motion-skip"
      : skipped ? "continued" : "natural";
    if (this.backgroundIntroVisualOperation) {
      this.visualTelemetry?.complete(this.backgroundIntroVisualOperation, visualOutcome);
      this.backgroundIntroVisualOperation = null;
    }
    if (this.launchIntroVisualOperation) {
      this.visualTelemetry?.complete(this.launchIntroVisualOperation, visualOutcome);
      this.launchIntroVisualOperation = null;
    }
    if (this.featureMode === "BASE") this.gameLogo.show();
    else this.gameLogo.hide(true);
  }

  /** 开始不依赖结果的转轴运动及其轻量氛围效果。 */
  beginSpinPresentation(reducedMotion = false): void {
    this.wheelBonusWinLabel.hide(reducedMotion);
    this.jackpotTower.resetPanelAnimations();
    this.gameLogo.setIdleAllowed(false);
    this.environmentState = beginSpinEnvironment(this.environmentState, performance.now(), reducedMotion);
    this.reels.beginSpin(reducedMotion);
  }

  /**
   * 镜像 GamePrimalWheelEvent.BEGIN_SPIN，由真正的 Wheel 控件调度，而不是由 Wheel 场景的介绍/就绪过渡调度。
   */
  private beginWheelSpinPresentation(): void {
    this.jackpotTower.resetPanelAnimations();
    this.launchScene.setCharacterBodyContinuation("feature", false);
    this.playCharacterAnimation("chest_pound", "wheel.spin-start", true);
    this.featurePresentationMilestoneListener?.("wheel.spin-start");
  }

  /**
   * 仅供测试夹具使用的 S0 栅栏。它位于已发出的旋转启动里程碑之后，
   * 用于证明捶胸效果负责人已先安装；正常生产没有监听器，因此会同步通过。
   */
  private onWheelSpinStartCheckpoint(): void | Promise<void> {
    return this.featurePresentationSemanticCheckpointListener?.("wheel.chest-loop-start");
  }

  /**
   * Free-Spin 简介 CONTINUE_SPIN 是原始 FREESPIN_START → startOutro 过渡的本地等效项。在这个精确的输入帧上恢复塔，
   * 而不是在简介可见并等待时恢复。
   */
  private beginFreeSpinsPlayPresentation(): void {
    this.jackpotTower.resetPanelAnimations();
    this.featurePresentationMilestoneListener?.("free-spins.continue");
  }

  /** 仅测试页姿势调节；生产 Spin 从未调用此接口。 */
  prepareNeutralCharacterCapture(): boolean {
    return this.launchScene.prepareNeutralBaseCapture();
  }

  /** 只读浏览器测试夹具的只读证据；从不提供游戏逻辑或渲染。 */
  getCharacterCaptureDiagnostics(): ReturnType<LaunchScene["getCharacterTrackDiagnostics"]> {
    return this.launchScene.getCharacterTrackDiagnostics();
  }

  /** 仅完成一个活跃的准备后介绍尾部以减少动作变化。 */
  completeActiveCharacterIntroForReducedMotion(): boolean {
    return this.launchScene.completeActiveCharacterIntroForReducedMotion();
  }

  /** 浏览器固定时钟保持；从不参与生产状态。 */
  setCharacterIntroCapturePaused(paused: boolean): boolean {
    return this.launchScene.setCharacterIntroCapturePaused(paused);
  }

  /** 精确的 Base WIN Character 仅由捕获测试场景使用的步骤。 */
  advanceBaseWinCharacterCapture(elapsedMs: number): boolean {
    return this.launchScene.advanceBaseWinCharacterCapture(elapsedMs);
  }

  /** 精确的 Wheel WIN_FEATURE Character 仅由捕获测试场景使用的步骤。 */
  advanceWheelWinFeatureCharacterCapture(elapsedMs: number): boolean {
    return this.launchScene.advanceWheelWinFeatureCharacterCapture(elapsedMs);
  }

  /** 精确的 Wheel FEATURE_CHEST_LOOP 调度程序步骤仅由捕获测试夹具使用。 */
  advanceWheelChestPoundCapture(elapsedMs: number): boolean {
    return this.launchScene.advanceWheelChestPoundCapture(elapsedMs);
  }

  /** 活动 Wheel FEATURE_CHEST_LOOP 调度程序的只读证据。 */
  getWheelChestPoundDiagnostics(): ReturnType<
    LaunchScene["getWheelChestPoundDiagnostics"]
  > {
    return this.launchScene.getWheelChestPoundDiagnostics();
  }

  /** 预设的介绍/空闲切换的只读浏览器测试夹具证据。 */
  getCharacterIntroLifecycleCaptureDiagnostics(): ReturnType<
    LaunchScene["getCharacterIntroLifecycleDiagnostics"]
  > {
    return this.launchScene.getCharacterIntroLifecycleDiagnostics();
  }

  markFastStop(): void {
    this.environmentState = markSpinFastStop(this.environmentState, performance.now());
  }

  /** 重复使用主要的 Spin 控件进行机轮启动和进行中快速停止。 */
  requestWheelInteraction(): WheelInteractionResult | null {
    return this.featureEffects.requestWheelInteraction();
  }

  /** 仅当不同的 Wheel Spin 开始时，才对 FASTPLAY_ON/OFF 进行采样。 */
  setWheelFastPlay(enabled: boolean): void {
    this.featureEffects.setWheelFastPlay(enabled);
  }

  /** 仅在 A 层有限的演出后 CONTINUE 保留期间有效。 */
  requestWheelSummaryContinue(): boolean {
    return this.featureEffects.requestWheelSummaryContinue();
  }

  /** Canvas/Spin 输入一次前进一个预设的 Big Win 段。 */
  requestBigWinInteraction(): BigWinInteractionResult | null {
    return this.bigWin.requestAdvance();
  }

  requestFreeSpinContinue(): boolean {
    return this.featureEffects.requestFreeSpinContinue();
  }

  /** 仅在 Free Spins 摘要的有限展后保留期间有效。 */
  requestFreeSpinSummaryContinue(): boolean {
    return this.featureEffects.requestFreeSpinSummaryContinue();
  }

  /** CONTINUE_SPIN 仅在 CAPLIMIT 有界保持阶段有效。 */
  requestFreeSpinCapContinue(): boolean {
    return this.freeSpinHud.requestCapContinue();
  }

  /** 接收卷轴锁定音频使用的相同预设的结算里程碑。 */
  reelImpact(reel: number, fastForward: boolean): void {
    this.environmentState = addSpinReelImpact(this.environmentState, {
      generation: this.environmentState.generation,
      reel,
      atMs: performance.now(),
      fastForward,
    });
    if (fastForward && reel === 2) this.backdrop.playAuthoredShake(1);
  }

  finishSpinPresentation(): void {
    this.environmentState = finishSpinEnvironment(this.environmentState, performance.now());
    this.gameLogo.setIdleAllowed(true);
  }

  /**
   * 当没有明确的结构事件伴随结果时，防止 StopSequencer 在一帧中折叠高度更改的服务器网格。
   */
  async reconcileReelRows(rows: number, reducedMotion = false): Promise<void> {
    if (!Number.isInteger(rows) || rows < 3 || rows > 8 || rows === this.reels.activeRows) return;
    await this.featureEffects.presentBeforeReels({
      type: "grid.expanded",
      rows,
      ways: rows ** 3,
    }, reducedMotion);
  }

  /**
   * 仅在服务器结束功能并显示最终功能结果后，才将表现流程返回到其三行基本布局。 CityBackdrop 拥有预设的火到主转换。
   */
  async exitFeatureMode(state: FeatureState, reducedMotion = false): Promise<void> {
    this.beginFeatureExitAtSummaryHide(state, reducedMotion);
    const pending = this.pendingFeatureExit;
    const failures: unknown[] = [];
    try {
      if (pending) await pending;
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        this.backdrop.settleFeatureExit();
      } catch (error) {
        failures.push(error);
      }
      try {
        this.launchScene.settleFeatureExit();
      } catch (error) {
        failures.push(error);
      }
      if (this.pendingFeatureExit === pending) this.pendingFeatureExit = null;
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Feature exit cleanup failed");
  }

  /** FREESPIN_END 在摘要隐藏处触发，因此所有退出分支一起启动。 */
  beginFeatureExitAtSummaryHide(state: FeatureState, reducedMotion = false): void {
    if (this.pendingFeatureExit) return;
    this.featureMode = state.mode;
    this.reels.setVisualStripMode(state.mode);
    this.environmentState = resetSpinEnvironment(this.environmentState);
    this.reels.clearHighlights();
    this.reels.clearWinMotion();
    this.backdrop.setExpansionRows(3);
    this.backdrop.transitionAuthoredPalette("main");
    this.launchScene.setCharacterPersistentPresentation(persistentFeatureVisualPlan(state).character);
    if (this.introCompleted && state.mode === "BASE") this.gameLogo.show();
    const resize = this.reels.activeRows > 3
      ? this.reconcileReelRows(3, reducedMotion)
      : Promise.resolve();
    this.pendingFeatureExit = resize.finally(() => {
      this.backdrop.setExpansionRows(3);
    });
  }

  completeWheelPresentation(state: FeatureState): void {
    this.launchScene.setCharacterPersistentPresentation(persistentFeatureVisualPlan(state).character);
    // 源游戏删除了 Base 标志，以实现完整的 Wheel 接管。仅在 Wheel 摘要关闭到符合条件的 Base 状态后才将其恢复；功能奖励将其隐藏在以下介绍中。
    if (this.introCompleted && state.mode === "BASE") this.gameLogo.show();
    else this.gameLogo.hide(true);
  }

  /**
   * 对着陆前退出的任何 Wheel 表现流程进行故障关闭清理。这永远不会提交解码的奖励；它只恢复持久像素并丢弃仍然隐藏的塔目的地。
   */
  abortWheelPresentation(): void {
    this.wheelBonusWinLabel.cancel();
    this.launchScene.resumeCharacterPersistentBody();
    this.pendingWheelAward = null;
    if (this.introCompleted && this.featureMode === "BASE") this.gameLogo.show();
    else this.gameLogo.hide(true);
  }

  cancelSpinPresentation(): void {
    this.wheelBonusWinLabel.cancel();
    this.environmentState = resetSpinEnvironment(this.environmentState);
    // 取消/失败的回合绝不能将其已解码的 Wheel 目的地泄漏到以后的表现中。
    this.pendingWheelAward = null;
    this.gameLogo.setIdleAllowed(true);
    this.setRageCascadePresentationPaused(false);
    this.featureEffects?.cancelActivePresentation();
    this.reels.cancelPresentation();
  }

  private commitPendingWheelAward(): void {
    const award = this.pendingWheelAward;
    if (!award) return;
    if (award.outcome === "INSTANT") {
      this.jackpotTower.highlightAward(award.prize);
    } else {
      // 官方 Wheel Kong/King 切片映射到 `jackpotController.win(-1)`。这会使每一层变暗，直到真正的 FREESPIN_START 重置。
      this.jackpotTower.darkenAllPanels();
    }
    this.pendingWheelAward = null;
  }

  private beginVaultAwardBatch(expectedCount: number): void {
    // 新的权威团体也是任何先前不完整化妆品批次的防御边界。切勿在旋转过程中携带突出显示的等级。
    this.flushVaultAwardHighlights(true);
    this.vaultAwardExpectedCount = Math.max(0, Math.floor(expectedCount));
  }

  private queueVaultAwardHighlight(event: VaultAwardedEvent): void {
    const tier = jackpotTierFromAward(event.prize);
    if (tier && !this.pendingVaultAwardTiers.has(tier)) {
      this.pendingVaultAwardTiers.add(tier);
      // 忽略突变事件的旧/部分事件流的兼容性回退。当前流已经在解锁/升级开始时投影了该层，因此永远不会进入该分支。
      this.jackpotTower.highlightAwards([...this.pendingVaultAwardTiers]);
    }
    this.noteResolvedVaultAwards(1);
  }

  private noteResolvedVaultAwards(count: number): void {
    if (count <= 0) return;
    this.vaultAwardResolvedCount += count;
    if (this.vaultAwardExpectedCount > 0
      && this.vaultAwardResolvedCount >= this.vaultAwardExpectedCount) {
      this.flushVaultAwardHighlights(true);
    }
  }

  private flushVaultAwardHighlights(clearExpectation: boolean): void {
    // 累积奖金等级已在突变开始时预测。该边界只拥有批量记账，不得重玩即时中奖。
    this.pendingVaultAwardTiers.clear();
    this.vaultMutationPrizeByCell.clear();
    this.vaultAwardResolvedCount = 0;
    if (clearExpectation) this.vaultAwardExpectedCount = 0;
  }

  /** 仅针对已解码的权威特征事件添加更强的层。 */
  cueFeatureEnvironment(event: FeatureEvent, reducedMotion = false): void {
    let kind: SpinEnvironmentFeatureKind;
    let effectKind: FeatureEffectKind;
    let bias: number | undefined;
    switch (event.type) {
      case "grid.expanded":
        kind = "expansion";
        effectKind = "expansion";
        break;
      case "vaults.unlock.started":
        this.beginVaultAwardBatch(event.count);
        kind = "vault";
        effectKind = "vault";
        this.playCharacterAnimation("vault", event.type);
        this.playReelFrame(vaultGroupFrameAnimation(event), event.type);
        break;
      case "vaults.upgrade.started":
        kind = "vault";
        effectKind = "vault";
        this.playCharacterAnimation("vault", event.type);
        this.playReelFrame(vaultGroupFrameAnimation(event), event.type);
        break;
      case "vault.awarded":
        this.queueVaultAwardHighlight(event);
        // 分组开始事件负责猿王/框架反应；制作好的符号在 FeatureEffects 中各自负责格子中奖片段。
        return;
      case "vault.upgraded":
        // 上述小组启动事件引起了内阁/角色的反应。每单元颁奖活动仍然拥有其 FeatureEffects 的展示。
        return;
      case "wheel.started":
        this.pendingWheelAward = null;
        this.gameLogo.hide();
        kind = "wheel";
        effectKind = "wheel";
        break;
      case "wheel.awarded":
        // 现在结果是权威的，但在Wheel仍在等待输入时，原始塔并没有透露它。仅在真正的车轮着陆里程碑处提交面板突出显示。
        this.pendingWheelAward = event;
        // wheel.started 拥有环境/音频提示。 FeatureEffects 在预设的旋转/着陆里程碑处启动和停止 chest_pound。
        return;
      case "surge.collected":
        // 精确三保证激活由 StopSequencer 拥有，并且没有替换级联。只有一/二 Rage 概率触发继续执行以下 rage.transformed 事件。
        if (event.triggered) return;
        // GamePPSFeature 在此事件回合中开始角色/Symbol7/踪迹。该塔属于FeatureEffects'以下1ms状态屏障。
        kind = "collect";
        effectKind = "collect";
        this.reels.blockSymbolIdle(event.cells);
        this.playCharacterCollect(event.type);
        break;
      case "rage.transformed":
        // FeatureEffects 负责精确的重旋/级联/捶击/激活链。若在此修改格子，会让结果提前 1.82 秒显示。
        return;
      case "free_spins.started":
        // 此事件打开 Kong/King 简介，但它还不是原始的 FREESPIN_START。通过可见的介绍使 Wheel 功能奖保持黑暗；绿色 Spin 输入边界拥有受保护的复位。
        this.featureMode = event.mode;
        this.reels.setVisualStripMode(event.mode);
        this.gameLogo.hide();
        kind = "rage";
        effectKind = "mode";
        this.backdrop.transitionAuthoredPalette(event.mode === "OVERDRIVE" ? "snow" : "fire");
        this.launchScene.setCharacterPersistentPresentation(
          featureIntroCharacterPresentation(event.mode),
        );
        break;
      case "free_spin.awarded":
        // HUD 批处理和预设的收集路径拥有此表现流程。
        return;
      case "free_spin.cap_reached":
        // CAPLIMIT 重新触发面板拥有此表现流程。
        return;
      case "win_cap.reached":
        // 纯经济边界事实，不虚构独立环境效果。
        return;
      case "vaults.landed":
      case "vaults.locked":
      case "vault.unlocked":
      case "free_spins.completed":
        return;
      case "vaults.unlock.completed":
        // 混合货币/免费-Spin 组通常会在计算最终单元格时刷新。该边界安全地刷新旧的/部分协议数据；空的 King Spin 解锁组保留其预期的最终奖励计数。
        if (this.vaultAwardResolvedCount > 0) this.flushVaultAwardHighlights(true);
        return;
    }
    this.environmentState = triggerFeatureEnvironment(this.environmentState, {
      kind,
      atMs: performance.now(),
      durationMs: event.type === "grid.expanded"
        ? reelResizePlan(this.reels.activeRows, event.rows, reducedMotion).totalMs
        : featureEffectDuration(effectKind, reducedMotion),
      reducedMotion,
      bias,
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visualTelemetry?.cancelAll();
    this.app.stop();
    this.featurePresentationMilestoneListener = null;
    this.featurePresentationBranchListener = null;
    this.featurePresentationInputCheckpointListener = null;
    this.featurePresentationSemanticCheckpointListener = null;
    this.rageCollectionPresentationMilestoneListener = null;
    this.rageCascadePresentationMilestoneListener = null;
    this.featureEffects.setRageCascadeMilestoneListener(null);
    this.rageCascadePresentationPaused = false;
    this.activeRageCollectionCharacter = null;
    this.rageCollectionPresentationPaused = false;
    this.bigWinMilestoneListener = null;
    this.launchScene.cancelCharacterStateTasks();
    this.bigWin.cancel();
    this.anticipation.parent?.removeChild(this.anticipation);
    this.anticipation.destroy({ children: true });
    this.reducedMotion?.removeEventListener("change", this.handleReducedMotionChange);
    this.environmentState = resetSpinEnvironment(this.environmentState);
    this.backdrop.stopReactions();
    this.wheelBonusWinLabel.destroy();
    this.winCelebration.destroy();
    this.featureEffects.destroy();
    (this.app.renderer as unknown as PrimalAdditiveBlendRenderer)
      .runners?.contextChange?.remove(this.additiveBlendContextListener);
    // 生成的符号纹理是模块级共享资源。递归地销毁它们将使已解析的资源缓存指向一个纹理，其 baseTexture 在同页渲染器重建上为 null。
    this.app.destroy(true, { children: true, texture: false, baseTexture: false });
  }

  private async nextLaunchFrame(signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
        return;
      }
      setTimeout(resolve, 16);
    });
    this.assertLaunchActive(signal);
  }

  private assertLaunchActive(signal?: AbortSignal): void {
    if (!this.destroyed && !signal?.aborted) return;
    if (signal?.reason instanceof Error) throw signal.reason;
    const error = new Error("Renderer launch was aborted");
    error.name = "AbortError";
    throw error;
  }

  private readonly handleReducedMotionChange = (event: MediaQueryListEvent): void => {
    this.backdrop.setReducedMotion(event.matches);
    this.launchScene.setReducedMotion(event.matches);
    this.bigWin.setReducedMotion(event.matches);
    if (event.matches) this.environmentState = resetSpinEnvironment(this.environmentState);
  };
}

function createRendererApplication(options: PixiRendererOptions): Application {
  const initialSize = resolveInitialRendererSize(options.initialSize);
  const resolution = Math.min(globalThis.devicePixelRatio || 1, 2);
  return new Application({
    width: initialSize.width,
    height: initialSize.height,
    resolution,
    autoDensity: true,
    antialias: true,
    backgroundAlpha: 0,
    powerPreference: "high-performance",
    autoStart: false,
  });
}

function createEagerPixiRendererOwners(options: PixiRendererOptions): PixiRendererOwners {
  const app = createRendererApplication(options);
  const reels = new ReelSetView();
  const scene = new Container();
  const camera = new CameraRig();
  const launchScene = new LaunchScene(camera, reels);
  const gameLogo = new LogoGameView();
  const jackpotTower = new JackpotTowerView();
  const featurePreview = new FeaturePreviewSpineView();
  const visualTelemetry = new VisualTelemetryReporter();
  const freeSpinCallbacks: PixiRendererFreeSpinCallbacks = {
    onCapInteraction: () => undefined,
    onCapClose: () => undefined,
    onCapInputReadyCheckpoint: () => undefined,
  };
  const freeSpinHud = new FreeSpinHudView({
    onCapInteraction: (phase) => freeSpinCallbacks.onCapInteraction(phase),
    onCapClose: (reason) => freeSpinCallbacks.onCapClose(reason),
    onCapInputReadyCheckpoint: () => freeSpinCallbacks.onCapInputReadyCheckpoint(),
  });
  const bigWin = new BigWinView({
    visualTelemetry,
    coinShowerOptions: options.bigWinCoinShowerOptions,
  });
  const anticipation = new AnticipationView();
  const backdrop = new CityBackdrop();
  const winCelebration = new WinCelebration(camera.fxLayer, reels, visualTelemetry);
  const wheelBonusWinLabel = new WheelBonusWinLabel(camera.fxLayer, reels);
  return {
    app,
    reels,
    scene,
    camera,
    launchScene,
    gameLogo,
    jackpotTower,
    featurePreview,
    visualTelemetry,
    freeSpinHud,
    freeSpinCallbacks,
    bigWin,
    anticipation,
    backdrop,
    winCelebration,
    wheelBonusWinLabel,
  };
}

function pixiRendererOwnerConstructionStages(
  state: StagedPixiRendererOwnerState,
  options: PixiRendererOptions,
  host: HTMLElement,
): readonly StagedComponentConstructionStage[] {
  const cleanup = (key: keyof PixiRendererOwners, destroy: () => void): (() => void) => () => {
    destroy();
    delete state[key];
  };
  const stages: StagedComponentConstructionStage[] = [
    {
      id: "application-shell",
      build: () => {
        const app = createRendererApplication(options);
        state.app = app;
        return state.ownershipTransfer.componentDisposer(cleanup("app", () => app.destroy(true, {
          children: true,
          texture: false,
          baseTexture: false,
        })));
      },
    },
    {
      id: "scene-root",
      build: () => {
        const scene = new Container();
        state.scene = scene;
        return state.ownershipTransfer.componentDisposer(cleanup("scene", () => scene.destroy({
          children: true,
          texture: false,
          baseTexture: false,
        })));
      },
    },
    {
      id: "camera-rig",
      build: () => {
        const camera = new CameraRig();
        state.camera = camera;
        return state.ownershipTransfer.componentDisposer(cleanup("camera", () => camera.destroy({
          children: true,
          texture: false,
          baseTexture: false,
        })));
      },
    },
    {
      id: "reel-cabinet",
      build: () => {
        const reels = new ReelSetView();
        state.reels = reels;
        return state.ownershipTransfer.componentDisposer(cleanup("reels", () => reels.destroy({
          children: true,
          texture: false,
          baseTexture: false,
        })));
      },
    },
    {
      id: "city-backdrop",
      build: () => {
        const backdrop = new CityBackdrop();
        state.backdrop = backdrop;
        return state.ownershipTransfer.componentDisposer(cleanup("backdrop", () => backdrop.destroy({
          children: true,
          texture: false,
          baseTexture: false,
        })));
      },
    },
    {
      id: "game-logo",
      build: () => {
        const gameLogo = new LogoGameView();
        state.gameLogo = gameLogo;
        return state.ownershipTransfer.componentDisposer(cleanup("gameLogo", () => gameLogo.destroy({
          children: true,
          texture: false,
          baseTexture: false,
        })));
      },
    },
    {
      id: "jackpot-tower",
      build: () => {
        const jackpotTower = new JackpotTowerView();
        state.jackpotTower = jackpotTower;
        return state.ownershipTransfer.componentDisposer(cleanup("jackpotTower", () => jackpotTower.destroy({
          children: true,
          texture: false,
          baseTexture: false,
        })));
      },
    },
    {
      id: "feature-preview",
      build: () => {
        const featurePreview = new FeaturePreviewSpineView();
        state.featurePreview = featurePreview;
        return state.ownershipTransfer.componentDisposer(cleanup("featurePreview", () => featurePreview.view.destroy({
          children: true,
          texture: false,
          baseTexture: false,
        })));
      },
    },
    {
      id: "visual-telemetry",
      build: () => {
        const visualTelemetry = new VisualTelemetryReporter();
        state.visualTelemetry = visualTelemetry;
        return state.ownershipTransfer.componentDisposer(
          cleanup("visualTelemetry", () => visualTelemetry.cancelAll()),
        );
      },
    },
    {
      id: "free-spin-hud",
      build: () => {
        const callbacks: PixiRendererFreeSpinCallbacks = {
          onCapInteraction: () => undefined,
          onCapClose: () => undefined,
          onCapInputReadyCheckpoint: () => undefined,
        };
        const freeSpinHud = new FreeSpinHudView({
          onCapInteraction: (phase) => callbacks.onCapInteraction(phase),
          onCapClose: (reason) => callbacks.onCapClose(reason),
          onCapInputReadyCheckpoint: () => callbacks.onCapInputReadyCheckpoint(),
        });
        state.freeSpinCallbacks = callbacks;
        state.freeSpinHud = freeSpinHud;
        return state.ownershipTransfer.componentDisposer(cleanup("freeSpinHud", () => {
          delete state.freeSpinCallbacks;
          freeSpinHud.destroy({ children: true, texture: false, baseTexture: false });
        }));
      },
    },
    {
      id: "big-win-overlay",
      build: () => {
        const bigWin = new BigWinView({
          visualTelemetry: requiredOwner(state, "visualTelemetry"),
          coinShowerOptions: options.bigWinCoinShowerOptions,
        });
        state.bigWin = bigWin;
        return state.ownershipTransfer.componentDisposer(cleanup("bigWin", () => bigWin.destroy({
          children: true,
          texture: false,
          baseTexture: false,
        })));
      },
    },
    {
      id: "anticipation-overlay",
      build: () => {
        const anticipation = new AnticipationView();
        state.anticipation = anticipation;
        return state.ownershipTransfer.componentDisposer(cleanup("anticipation", () => anticipation.destroy({
          children: true,
          texture: false,
          baseTexture: false,
        })));
      },
    },
    {
      id: "launch-scene",
      build: () => {
        const launchScene = new LaunchScene(
          requiredOwner(state, "camera"),
          requiredOwner(state, "reels"),
        );
        state.launchScene = launchScene;
        // LaunchScene 没有独立销毁，因为其节点归 CameraRig 所有；相机处理程序在中止时撕毁该图。
        return state.ownershipTransfer.componentDisposer(
          cleanup("launchScene", () => launchScene.cancelCharacterStateTasks()),
        );
      },
    },
    {
      id: "normal-win-overlay",
      build: () => {
        const winCelebration = new WinCelebration(
          requiredOwner(state, "camera").fxLayer,
          requiredOwner(state, "reels"),
          requiredOwner(state, "visualTelemetry"),
        );
        state.winCelebration = winCelebration;
        return state.ownershipTransfer.componentDisposer(
          cleanup("winCelebration", () => winCelebration.destroy()),
        );
      },
    },
    {
      id: "wheel-win-label",
      build: () => {
        const wheelBonusWinLabel = new WheelBonusWinLabel(
          requiredOwner(state, "camera").fxLayer,
          requiredOwner(state, "reels"),
        );
        state.wheelBonusWinLabel = wheelBonusWinLabel;
        return state.ownershipTransfer.componentDisposer(
          cleanup("wheelBonusWinLabel", () => wheelBonusWinLabel.destroy()),
        );
      },
    },
    {
      id: "renderer-graph",
      build: () => {
        const renderer = new PixiRenderer(host, options, requireRendererOwners(state));
        state.renderer = renderer;
        const disposeGraph = state.ownershipTransfer.transferToGraph(() => renderer.destroy());
        return () => {
          disposeGraph();
          state.renderer = null;
        };
      },
    },
  ];
  return stages;
}

function requireRendererOwners(state: StagedPixiRendererOwnerState): PixiRendererOwners {
  return {
    app: requiredOwner(state, "app"),
    reels: requiredOwner(state, "reels"),
    scene: requiredOwner(state, "scene"),
    camera: requiredOwner(state, "camera"),
    launchScene: requiredOwner(state, "launchScene"),
    gameLogo: requiredOwner(state, "gameLogo"),
    jackpotTower: requiredOwner(state, "jackpotTower"),
    featurePreview: requiredOwner(state, "featurePreview"),
    visualTelemetry: requiredOwner(state, "visualTelemetry"),
    freeSpinHud: requiredOwner(state, "freeSpinHud"),
    freeSpinCallbacks: requiredOwner(state, "freeSpinCallbacks"),
    bigWin: requiredOwner(state, "bigWin"),
    anticipation: requiredOwner(state, "anticipation"),
    backdrop: requiredOwner(state, "backdrop"),
    winCelebration: requiredOwner(state, "winCelebration"),
    wheelBonusWinLabel: requiredOwner(state, "wheelBonusWinLabel"),
  };
}

function requiredOwner<K extends keyof PixiRendererOwners>(
  state: StagedPixiRendererOwnerState,
  key: K,
): PixiRendererOwners[K] {
  const value = state[key];
  if (!value) throw new Error(`Missing staged PixiRenderer owner: ${String(key)}`);
  return value as PixiRendererOwners[K];
}

function requestRendererConstructionFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 16);
  });
}

function throwIfRendererConstructionAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Staged PixiRenderer construction was aborted");
  error.name = "AbortError";
  throw error;
}

const MAX_RUNNING_LAUNCH_LOAD_FRACTION = 1 - 1e-6;

/**
 * 运行有界启动 I/O，同时平均每个组当前的分数进度。一个群体只有在其承诺兑现之后才能准确地达到一。
 */
export async function runBoundedLaunchLoads(
  loads: readonly FractionalLaunchLoad[],
  concurrency: number,
  onProgress: (fraction: number) => void = () => undefined,
  shouldAcceptProgress: () => boolean = () => true,
): Promise<void> {
  const fractions = Array.from({ length: loads.length }, () => 0);
  const accepting = Array.from({ length: loads.length }, () => false);
  let cursor = 0;
  let failed = false;
  let firstError: unknown;
  let published = 0;

  const publish = (index: number, fraction: number, complete = false): void => {
    if (failed || !accepting[index] || !shouldAcceptProgress()) return;
    const current = fractions[index] ?? 0;
    const normalized = Number.isFinite(fraction)
      ? Math.min(1, Math.max(0, fraction))
      : current;
    const next = complete
      ? 1
      : Math.min(MAX_RUNNING_LAUNCH_LOAD_FRACTION, Math.max(current, normalized));
    if (next <= current) return;
    fractions[index] = next;
    const aggregate = fractions.reduce((total, value) => total + value, 0) / loads.length;
    if (aggregate <= published) return;
    published = aggregate;
    onProgress(aggregate);
  };

  if (shouldAcceptProgress()) onProgress(0);
  if (loads.length === 0) {
    if (shouldAcceptProgress()) onProgress(1);
    return;
  }

  const worker = async (): Promise<void> => {
    while (!failed && shouldAcceptProgress()) {
      const index = cursor;
      cursor += 1;
      const load = loads[index];
      if (!load) return;
      accepting[index] = true;
      try {
        await load((fraction) => publish(index, fraction));
        publish(index, 1, true);
        accepting[index] = false;
      } catch (error) {
        accepting[index] = false;
        failed = true;
        firstError ??= error;
        return;
      }
    }
  };
  const workerCount = Math.min(loads.length, Math.max(1, Math.floor(concurrency)));
  // 在出现第一个故障之前，让已经运行的节点停止运行。这可以防止启动被拒绝而导致工作人员将更多场景工作从队列中剔除。
  await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
  if (firstError !== undefined) throw firstError;
}

/** 将显示图拆分为独立上传的 GPU 准备切片。 */
export function splitGpuWarmupTargets(
  root: DisplayObject,
  depth: number,
): readonly DisplayObject[] {
  let targets: DisplayObject[] = [root];
  const levels = Math.max(0, Math.floor(depth));
  for (let level = 0; level < levels; level += 1) {
    const next: DisplayObject[] = [];
    for (const target of targets) {
      if (!(target instanceof Container) || target.children.length === 0) {
        next.push(target);
        continue;
      }
      const children = target.children.filter((child) => (
        child.parent === target
        && child.renderable
        && (child as DisplayObject & { transform: unknown | null }).transform !== null
      ));
      if (children.length === 0) next.push(target);
      else next.push(...children);
    }
    targets = next;
  }
  return targets;
}

/** GPU 上传是按 BaseTexture 执行的，而不是每个图集帧执行一次。 */
export function uniqueGpuWarmupTextures(
  textures: readonly Texture[],
): readonly Texture[] {
  const seen = new Set<Texture["baseTexture"]>();
  return textures.filter((texture) => {
    if (seen.has(texture.baseTexture)) return false;
    seen.add(texture.baseTexture);
    return true;
  });
}

/** 查找已由预设的 Spine 和场景视图具体化的纹理。 */
export function collectGpuWarmupTextures(root: DisplayObject): readonly Texture[] {
  const textures: Texture[] = [];
  const visit = (view: DisplayObject): void => {
    if (
      !view.renderable
      || (view as DisplayObject & { transform: unknown | null }).transform === null
    ) return;
    const texture = (view as DisplayObject & { texture?: Texture }).texture;
    if (texture?.baseTexture) textures.push(texture);
    if (view instanceof Container) view.children.forEach(visit);
  };
  visit(root);
  return uniqueGpuWarmupTextures(textures);
}

export interface GpuPrepareSliceOptions<T> {
  readonly requestFrame: () => Promise<void>;
  readonly upload: (target: T, index: number) => Promise<void>;
  readonly now?: () => number;
  readonly frameBudgetMs?: number;
  readonly maxTargetsPerSlice?: number;
}

function gpuWarmupNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

/**
 * 在一个已绘制帧切片中上传多个低成本目标；CPU 预算耗尽后立即让出执行权。
 * 这样既能隔离大型图集上传，又能避免为已解码的单像素精灵空等数百次 rAF。
 */
export async function runGpuPrepareSlices<T>(
  targets: readonly T[],
  options: GpuPrepareSliceOptions<T>,
): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const frameBudgetMs = Math.max(1, options.frameBudgetMs ?? 8);
  const maxTargetsPerSlice = Math.max(1, Math.floor(options.maxTargetsPerSlice ?? 12));
  let targetsInSlice = maxTargetsPerSlice;
  let sliceStartedAt = 0;

  for (let index = 0; index < targets.length; index += 1) {
    if (
      targetsInSlice >= maxTargetsPerSlice
      || now() - sliceStartedAt >= frameBudgetMs
    ) {
      await options.requestFrame();
      sliceStartedAt = now();
      targetsInSlice = 0;
    }
    await options.upload(targets[index]!, index);
    targetsInSlice += 1;
  }
}

/** 暂时公开屏幕外着色器通道的隐藏关键节点。 */
function exposeForOffscreenWarmup(root: Container): () => void {
  const states: Array<{
    readonly view: DisplayObject;
    readonly alpha: number;
    readonly visible: boolean;
  }> = [];
  const visit = (view: DisplayObject): void => {
    // Pixi 在销毁期间使 `transform` 无效。一些回退路径所有者在预设的艺术作品获奖后保留非渲染参考；永远不要为着色器通道恢复它。
    if ((view as DisplayObject & { transform: unknown | null }).transform === null) return;
    // 大型预分配池明确选择退出此遍历。一个具有代表性的地图集精灵已存在于预热目标中。
    if (!view.renderable) return;
    states.push({ view, alpha: view.alpha, visible: view.visible });
    view.visible = true;
    if (view.alpha <= 0) view.alpha = 0.001;
    if (view instanceof Container) {
      // pixi-spine 将分离的槽容器保留在其内部子列表中；它们最初的隐形状态是有意的，并且它们的父级是 null，
      // 因此复活它们将使 Container.updateTransform 抛出。
      for (const child of view.children) {
        if (child.parent === view) visit(child);
      }
    }
  };
  visit(root);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (let index = states.length - 1; index >= 0; index -= 1) {
      const state = states[index];
      if (!state) continue;
      state.view.alpha = state.alpha;
      state.view.visible = state.visible;
    }
  };
}
