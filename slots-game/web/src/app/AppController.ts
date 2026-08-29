import { GameStateMachine } from "./state/GameStateMachine";
import {
  EMPTY_FEATURE_STATE,
  type CellAddress,
  type FeatureEvent,
  type FeatureState,
  type FreeSpinAwardedEvent,
  type GameSnapshot,
  type GridCell,
  type MoneyMinor,
  type ServerError,
  type SessionOpened,
  type SpinResult,
  type VaultAwardedEvent,
  type VaultUnlockedEvent,
  type VaultUpgradedEvent,
  type Win,
  type WheelAwardedEvent,
} from "./state/types";
import { PresentationQueue } from "../presentation/PresentationQueue";
import type {
  GameGateway,
  GatewaySessionTimeout,
  GatewayStatus,
  ResultDeliveryStage,
} from "../protocol/GameGateway";
import {
  createConfiguredGameGateway,
  optionalWindowSessionStorage,
} from "../protocol/configuredGateway";
import {
  StopSequencer,
  type ReelAnticipationStopReason,
  type ReelPostStopActivationEvent,
} from "../reels/StopSequencer";
import { ReelRoundStateMachine } from "../reels/ReelRoundStateMachine";
import { authoritativeReelRoundFromV1 } from "../reels/reelRoundContract";
import {
  PixiRenderer,
  type CharacterWinPresentation,
  type FeaturePresentationBranch,
  type FeaturePresentationInputGate,
  type FeaturePresentationMilestone,
  type FeaturePresentationSemanticState,
  type CharacterCollectRandomSource,
  type RageCascadePresentationMilestone,
  type RageCollectionPresentationMilestone,
} from "../renderer/PixiRenderer";
import type { VisualTelemetryEvent } from "../renderer/VisualTelemetry";
import type { CharacterAnimationEvent } from "../renderer/intro/LaunchScene";
import {
  ResponsiveLayout,
  computeResponsiveLayoutSnapshot,
  responsiveChannelFromEnvironment,
  responsiveLayoutChannel,
} from "../renderer/ResponsiveLayout";
import { setPrimalRuntimeAssetChannel } from "../assets/primalRuntimeAssets";
import { DomOverlay } from "../ui/DomOverlay";
import type { OperatorApprovedGameRulesBundleInput } from "../ui/operatorApprovedGameRules";
import { createRequestId } from "../protocol/messages";
import { validateSpinResultAgainstOrigin } from "../protocol/spinResultOriginGuard";
import { featureLockedBet, selectSessionBet } from "./state/betSelection";
import { LaunchStateMachine, type LaunchPhase } from "../startup/LaunchStateMachine";
import { IntroDirector, SwitchableLaunchClock } from "../startup/IntroDirector";
import {
  INTRO_DURATION_MS,
  REDUCED_INTRO_DURATION_MS,
} from "../startup/introTimeline";
import { PreloadGate, type PreloadProgress } from "../startup/PreloadGate";
import {
  waitForPaintedFrame,
  type FrameRequest,
} from "../startup/frameSlicedInitialization";
import { waitForCriticalDomReadiness } from "../startup/criticalDomReadiness";
import { buildPaintedStartupStage } from "../startup/paintedStartupAssembly";
import { finishStartupPerformanceMonitor } from "../startup/startupPerformanceMonitor";
import { canEnableSpin } from "./state/controlGate";
import {
  createFeaturePresentationPlan,
  shouldPresentFreeSpinSummary,
  type RageCascadeCellOrderSource,
  type VaultUnlockPresentationMilestone,
  type VaultUnlockPresentationPhase,
} from "../renderer/FeatureEffects";
import {
  ATTRACT_GRID_LOCKED_VAULT_CELLS,
  createAttractGrid,
} from "../presentation/attractGrid";
import {
  AudioManager,
  type BigWinMusicResumeMode,
  type GameIntroClockMode,
  type PpsLevel,
} from "../audio/AudioManager";
import type { TimelineCue } from "../startup/Timeline";
import {
  didFeatureModeEnd,
  freeSpinAutoplayDelay,
  shouldScheduleFreeSpin,
} from "./freeSpinAutoplay";
import { featureEventRoute } from "./featureEventRouting";
import {
  authoritativeWaysWinTotal,
  roundPresentationPhases,
} from "./roundPresentationPhases";
import {
  NORMAL_WIN_COUNTER_TAIL_HOLD_MS,
  isCelebratoryWin,
  isWinLossOrEqual,
  normalWinCounterDurationMs,
  parseJackpotTier,
  planPayoutAudio,
  planReelLandAudio,
} from "./roundAudioPlan";
import {
  BIG_WIN_CONTROLLER_LEAD_IN_MS,
  bigWinVerifiedArtworkFromPackage,
  planBigWin,
  type BigWinMilestone,
  type BigWinPlan,
} from "../renderer/BigWinView";
import {
  primalWinRecordHoldDurationMs,
  type WinCelebrationResidentFacts,
  type WinCelebrationMilestone,
  type WinRecordPlan,
} from "../renderer/WinCelebration";
import {
  beginStreamingAssetEventLease,
  createStreamingAssetRuntime,
  publishStreamingAssetDiagnostics,
  streamingFeaturePackageId,
  type StreamingAssetEventLease,
  type StreamingAssetRuntimeDiagnostics,
  type StreamingAssetRuntimePort,
} from "../startup/StreamingAssetRuntime";
import {
  OPERATOR_SESSION_REQUIRED_EVENT,
  PLAYER_FACING_ERROR_CODES,
  PLAYER_ERROR_DIAGNOSTIC_EVENT,
  playerFacingError,
  playerFacingErrorFor,
  type OperatorSessionRequest,
  type OperatorSessionRequestHandler,
  type OperatorSessionRequestReason,
  type PlayerFacingError,
  type PlayerFacingErrorContext,
  type PlayerErrorDiagnostic,
  type PlayerErrorDiagnosticHandler,
} from "./playerFacingError";
import {
  isWindowFramed,
  notifyOperatorSessionRequired,
  returnTopLevelSessionToOperator,
} from "./operatorSessionBridge";

interface RoundFeatureAudioState {
  rageLevel: number;
  showFreeSpinSummary: boolean;
  wasFreeSpins: boolean;
  vaultTeaseExtraHold: boolean;
  /** 本轮落下的全部 Vault；King Spin 在每个升级阶段都会重新预告这组完整格子。 / English: All Vaults dropped in this round; King Spin will re-announce this complete set of grids at each upgrade stage. */
  vaultCells: readonly Readonly<CellAddress>[];
  hudState?: FeatureState;
  /** 无总结页的退出流程会在 400ms HUD 退场结束前启动 FREESPIN_END。 / English: The exit process without summary page will start FREESPIN_END before the 400ms HUD exit ends. */
  featureExitStarted?: boolean;
}

/** 官方 GameLogicController 在中奖后进入空闲循环前的固定引导时长。 / English: Fixed GameLogicController lead-in before the post-win idle loop begins. */
export const PRIMAL_POST_WIN_IDLE_INTRO_MS = 1_000;


/** 面板音效只挂在表现边界上；两个回调都不得修改 UI 状态。 / English: Panel sound effects only hang on presentation boundaries; neither callback must modify UI state. */
export function bindUiPanelAudio(
  ui: Pick<DomOverlay, "onPanelOpen" | "onPanelClose">,
  audio: Pick<AudioManager, "playUiOpen" | "playUiClose">,
): void {
  ui.onPanelOpen(() => audio.playUiOpen());
  ui.onPanelClose(() => audio.playUiClose());
}

/** 只把 Fast Play 偏好同步到轮盘与中奖时钟，绝不参与结果选择。 / English: Sync the Fast Play preference only to the Wheel and win-presentation clocks; it never participates in outcome selection. */
export function bindFastPlayPreference(
  ui: Pick<DomOverlay, "onFastPlayChange">,
  renderer: Pick<PixiRenderer, "setWheelFastPlay">,
  onPreferenceChange: (enabled: boolean) => void = () => undefined,
): void {
  ui.onFastPlayChange((enabled) => {
    onPreferenceChange(enabled);
    renderer.setWheelFastPlay(enabled);
  });
}

class RoundPresentationCancelledError extends Error {
  constructor() {
    super("Round presentation was cancelled");
    this.name = "RoundPresentationCancelledError";
  }
}

export type SymbolWinTier = "lp1" | "lp2" | "mp1" | "mp2" | "hp1" | "hp2" | "wild" | "scatter-win";

/** 在整轮唯一一次 WIN 起点解析应使用的官方角色状态。 / English: Resolve the authored character state at the round's single WIN-start boundary. */
export function characterWinPresentation(
  previousMode: FeatureState["mode"],
  currentMode: FeatureState["mode"],
): CharacterWinPresentation {
  if (previousMode === "EXPANSION") return "kq";
  if (previousMode === "OVERDRIVE") return "feature";
  // 触发特性的基础旋转已进入通用特性状态，但到 WIN 里程碑时尚未完成 / English: The base spin that triggered the feature has entered common feature status but has not yet completed by the WIN milestone
  // Kong Quest / King Spin 的模式选择。 / English: Mode selection for Kong Quest/King Spin.
  if (currentMode !== "BASE") return "feature";
  return "base";
}

/** 当前 Primal 无路径记录从记录符号本身路由声音。 / English: For a win record with no payline path, Primal routes audio directly from that record's symbol. */
export function symbolWinTierFor(
  win: Pick<Win, "symbol" | "cells">,
  _grid?: readonly (readonly GridCell[])[],
): SymbolWinTier | null {
  if (win.symbol === "WILD") return "wild";
  switch (win.symbol) {
    case "PRISM": return "lp1";
    case "ORBIT": return "lp2";
    case "PULSE": return "mp1";
    case "NOVA": return "mp2";
    case "TANK": return "hp1";
    case "CIRCUIT": return "hp2";
    // Rage、Vault 以及向前兼容的纯奖励记录进入官方静默 LpWin 回退路径。 / English: Rage, Vault, and forward-compatible reward-only records enter the official silent LpWin fallback path.
    // ScatterWin 会单独派发。 / English: ScatterWin is dispatched separately.
    default: return null;
  }
}

export function anticipationAudioFadeMs(
  fastForward: boolean,
  reason: ReelAnticipationStopReason,
): number {
  return fastForward || reason !== "reel-impact" ? 0 : 1_000;
}

export type WheelLandingSemantic = "king-spin" | "kong-quest";

/** 官方奖励 ID 50/51 派发彼此不同且刻意静默的语义。 / English: Official reward ID 50/51 dispatches have mutually distinct and deliberately silent semantics. */
export function wheelLandingSemantic(
  event: WheelAwardedEvent | null,
): WheelLandingSemantic | null {
  if (event?.outcome === "OVERDRIVE") return "king-spin";
  if (event?.outcome === "EXPANSION") return "kong-quest";
  return null;
}

export function freeSpinHudStateBeforeAwards(
  previous: FeatureState,
  current: FeatureState,
): FeatureState {
  // 结果投影位于 SPINEND 之后。当前结果的特性命令仍在呈现时，官方控制器保留完整的轮次前状态， / English: The resulting projection is after SPINEND. While the current result's feature command is still being rendered, the official controller retains the complete pre-turn state,
  // 并且只为奖励修改剩余次数。 / English: And only modify the remaining times for rewards.
  return previous.mode === "BASE" ? { ...current } : { ...previous };
}

/**
 * 在每个 SPINEND 前奖励/CAP 命令期间保留权威的轮次来源投影。终局响应也会合理投影 BASE，
 * 但其总结仍归轮次开始时激活的 HUD 所有。
 *
 * 英文 / English: Preserves the authoritative round source projection during each SPINEND pre-reward/CAP command. Final responses also properly project BASE, but their summary remains owned by the HUD activated at the start of the round.
 */
export function freeSpinHudStateForPresentation(
  previous: FeatureState,
  current: FeatureState,
  _events: readonly FeatureEvent[],
): FeatureState {
  return freeSpinHudStateBeforeAwards(previous, current);
}

/** 供确定性浏览器验证使用的稳定只读接缝。 / English: Stable read-only seam for deterministic browser validation. */
export type AppPresentationMilestone = FeaturePresentationMilestone
  | "kong.rows-8-settled"
  | "free-spins.autoplay-armed"
  | "vault.mutation-barrier-complete"
  | "free-spins.exit-started";

export type AppSemanticPresentationState = FeaturePresentationSemanticState
  | "kong.rows-8-settled"
  | "kong.retrigger-applied";

/** 有界表现栅栏的只读结果；绝不作为游戏玩法的输入。 / English: Read-only result of bounded representation fence; never used as input to gameplay. */
export type AppPresentationBranch = FeaturePresentationBranch;

type BigWinPresentationTraceFor<M extends BigWinMilestone> = M extends BigWinMilestone
  ? Readonly<Omit<M, "type" | "amountMinor"> & {
      readonly type: `big-win.${M["type"]}`;
      readonly sequence: number;
      readonly amountMinor: string;
    }>
  : never;

export type BigWinPresentationTrace = BigWinPresentationTraceFor<BigWinMilestone>;

export type WildRevealPresentationTrace = Readonly<{
  type: "wild-reveal.pre" | "wild-reveal.complete";
  sequence: number;
  cells: readonly Readonly<{
    reel: number;
    row: number;
    multiplier: number;
  }>[];
  outroMs: number;
}>;

export type RageCollectionPresentationTrace = Readonly<
  Omit<RageCollectionPresentationMilestone, "phase"> & {
    type: `rage-collect.${RageCollectionPresentationMilestone["phase"]}`;
    sequence: number;
  }
>;

export type RageCascadePresentationTrace = Readonly<
  Omit<RageCascadePresentationMilestone, "phase"> & {
    type: `rage-cascade.${RageCascadePresentationMilestone["phase"]}`;
    sequence: number;
  }
>;

export type AppPresentationTrace =
  | Readonly<{
      type: "result.accepted";
      sequence: number;
      roundId: string;
      totalWinMinor: MoneyMinor;
      balanceMinor: MoneyMinor;
      winCount: number;
    }>
  | Readonly<{ type: "reels.settled"; sequence: number }>
  | Readonly<{
      type: "counter.started" | "counter.completed";
      sequence: number;
      totalWinMinor: MoneyMinor;
      displayStartMinor: MoneyMinor;
      displayTotalMinor: MoneyMinor;
    }>
  | Readonly<{
      type: `win-record.${WinCelebrationMilestone}`;
      sequence: number;
      index: number;
      count: number;
      id: string;
      symbol: WinRecordPlan["symbol"];
      amountMinor: MoneyMinor;
      multiplier: number;
      /** 仅真实常驻 WinLabel/WinBox 表现器提供。 / English: Only provided by the real resident WinLabel/WinBox presenter. */
      resident?: Readonly<WinCelebrationResidentFacts>;
    }>
  | BigWinPresentationTrace
  | WildRevealPresentationTrace
  | RageCollectionPresentationTrace
  | RageCascadePresentationTrace
  | Readonly<{
      type: "normal-win.continue-accepted" | "normal-win.logical-done";
      sequence: number;
    }>
  | Readonly<{ type: "balance.committed"; sequence: number; balanceMinor: MoneyMinor }>
  | Readonly<{ type: "round.complete"; sequence: number }>;

export type AppPresentationCheckpoint =
  | Readonly<{
      type: "vault-awards-complete";
      count: number;
    }>
  | Readonly<{
      type: "free-spins-completed-active";
      sequence: number;
      mode: "EXPANSION" | "OVERDRIVE";
      awarded: number;
      cumulativeWinMinor: MoneyMinor;
    }>
  | Readonly<{
      type: "bounded-gate-input-ready";
      gate: FeaturePresentationInputGate;
      sequence: number;
    }>
  | Readonly<{
      type: "presentation-trace";
      trace: AppPresentationTrace;
    }>
  | Readonly<{
      type: "semantic-state";
      state: AppSemanticPresentationState;
      sequence: number;
    }>
  | Readonly<{
      type: "normal-win.logical-done";
      sequence: number;
    }>
  | Readonly<{
      type: "vault-unlock-phase";
      phase: "vault-unlock.locked" | VaultUnlockPresentationPhase;
      sequence: number;
      cell: Readonly<CellAddress>;
      prize: string;
      multiplier?: number;
    }>;

export interface AppPresentationObserver {
  onFeatureEvent?(
    type: FeatureEvent["type"] | null,
    event?: Readonly<FeatureEvent> | null,
  ): void;
  onLaunchPhase?(phase: LaunchPhase): void;
  onRoundPresentationState?(state: RoundPresentationState): void;
  onPresentationMilestone?(milestone: AppPresentationMilestone | null): void;
  onPresentationBranch?(branch: AppPresentationBranch): void;
  onPresentationTrace?(trace: AppPresentationTrace): void;
  onPresentationCheckpoint?(checkpoint: AppPresentationCheckpoint): void | Promise<void>;
  /** 同步的非权威视觉诊断；绝不等待其完成。 / English: Synchronous non-authoritative visual diagnosis; never wait for it to complete. */
  onVisualTelemetry?(event: Readonly<VisualTelemetryEvent>): void | PromiseLike<void>;
}

export type RoundPresentationState = "idle" | "requested" | "presenting" | "complete" | "failed";

export interface AppControllerDependencies {
  readonly gateway?: GameGateway;
  readonly presentationObserver?: AppPresentationObserver;
  /**
   * 供嵌入式宿主和集成测试使用的可选非权威音频负责人。
   * 结果、传输和状态机依赖保持固定。
   *
   * 英文 / English: Optional non-authoritative audio leader for use by embedded hosting and integration tests. Result, transport and state machine dependencies remain fixed.
   */
  readonly audioManager?: AudioManager;
  /** 确定性视觉夹具使用的纯装饰选择器。 / English: A purely decorative selector used by deterministic visual fixtures. */
  readonly characterCollectRandomSource?: CharacterCollectRandomSource;
  /** 确定性视觉夹具使用的纯装饰 Rage 遍历排列。 / English: Purely decorative Rage traversal permutations used by deterministic visual fixtures. */
  readonly rageCascadeCellOrderSource?: RageCascadeCellOrderSource;
  /** 仅夹具使用的预览绕过；生产环境仍遵从玩家偏好。 / English: Previews for fixture-only use are bypassed; production environments still respect player preferences. */
  readonly skipFeaturePreview?: boolean;
  /**
   * 仅确定性视觉夹具使用：将“单轮表现尾段”与“就绪状态待机重播”分开验证。
   * 生产入口不注入此值，待机重播默认保持启用。
   *
   * 英文 / English: Only deterministic visual fixtures are used: separate verification of "single round performance tail segment" and "ready state standby replay". The production portal does not inject this value and standby replay remains enabled by default.
   */
  readonly suppressPostWinIdleRepeat?: boolean;
  /** 只启用精确的 capture=1 Base Vault 截图时钟。 / English: Enables only precise capture=1 Base Vault capture clock. */
  readonly vaultUnlockCaptureEnabled?: boolean;
  /**
   * 非权威资源运行时。默认 Big Win 事件租约只门控对应装饰表现，不阻挡启动，
   * 也不参与结果、金额、ACK 或重连决策；嵌入式宿主可注入等价实现。
   *
   * 英文 / English: Non-authoritative resource runtime. The default Big Win event lease only controls the corresponding decoration performance, does not block startup, and does not participate in result, amount, ACK or reconnection decisions; the embedded host can inject equivalent implementations.
   */
  readonly streamingAssetRuntime?: StreamingAssetRuntimePort;
  /**
   * 运营商/监管方已经审核的纯玩家规则文案。客户端只做封闭校验和文本投影；
   * 缺失或无效时 Game Rules 保持中性不可用，不以内部协议说明代替。
   *
   * 英文 / English: Pure player rules copy that has been reviewed by the operator/regulator. The client only does closed checksum text projection; when missing or invalid, Game Rules remain neutral and unavailable, and are not replaced by internal protocol descriptions.
   */
  readonly operatorApprovedGameRules?: Readonly<OperatorApprovedGameRulesBundleInput>;
  /**
   * 生产 RGS launch code 只能使用一次；宿主收到请求后必须换取新签名会话，
   * 禁止从浏览器历史重放已清除的 code。
   *
   * 英文 / English: Production RGS launch code can only be used once; the host must exchange for a new signing session after receiving the request, and replaying cleared code from the browser history is prohibited.
   */
  readonly onOperatorSessionRequired?: OperatorSessionRequestHandler;
  /** 安全可观测性边界：只允许 code/request ID，禁止原始错误文本。 / English: Security Observability Boundary: Only code/request ID allowed, raw error text prohibited. */
  readonly onPlayerErrorDiagnostic?: PlayerErrorDiagnosticHandler;
}

export interface AppControllerCreateOptions {
  readonly signal?: AbortSignal;
  /** 确定性测试接缝；生产环境使用 requestAnimationFrame。 / English: Deterministic testing seams; production uses requestAnimationFrame. */
  readonly requestFrame?: FrameRequest;
}

interface ApplicationShell {
  readonly viewport: HTMLElement;
  readonly safeArea: HTMLElement;
  readonly frame: HTMLElement;
  readonly canvasHost: HTMLElement;
  readonly overlayHost: HTMLElement;
  readonly launchHost: HTMLElement;
}

interface PreparedApplicationView extends ApplicationShell {
  readonly assetChannel: ReturnType<typeof responsiveChannelFromEnvironment>;
  readonly ui: DomOverlay;
  readonly renderer: PixiRenderer;
  readonly startupFrameRequest: FrameRequest | undefined;
}

const STARTUP_ASSEMBLY_PROGRESS_FLOOR = 0.05;

/** RGS exchange 自身单请求超时之外的有界首会话保护，禁止无限等待。 / English: Bounded first session protection beyond RGS exchange's own single request timeout, prohibiting infinite waiting. */
export const INITIAL_RGS_SESSION_TIMEOUT_MS = 15_000;
export { OPERATOR_SESSION_REQUIRED_EVENT, PLAYER_ERROR_DIAGNOSTIC_EVENT };
export type {
  OperatorSessionRequest,
  OperatorSessionRequestHandler,
  OperatorSessionRequestReason,
  PlayerErrorDiagnostic,
  PlayerErrorDiagnosticHandler,
};

/**
 * 场景组装已占据可见启动进度条的前 5%。将 PreloadGate 加权后的 0..1 契约保留在内部，
 * 并投影到剩余可见区间，同时不削弱其严格完成事件。
 *
 * 英文 / English: Scene assembly has occupied the first 5% of the visible startup progress bar. Keeps PreloadGate's weighted 0..1 contract internally and projects it into the remaining visible range without weakening its strict completion event.
 */
export function mapPreloadToVisibleProgress(
  event: Readonly<PreloadProgress>,
): Readonly<PreloadProgress> {
  const preloadProgress = Number.isFinite(event.progress)
    ? Math.min(1, Math.max(0, event.progress))
    : 0;
  const progress = event.status === "complete"
    ? 1
    : STARTUP_ASSEMBLY_PROGRESS_FLOOR
      + preloadProgress * (1 - STARTUP_ASSEMBLY_PROGRESS_FLOOR);
  return Object.freeze({ ...event, progress });
}

function mountApplicationShell(root: HTMLElement): ApplicationShell {
  // 将服务端渲染的加载器保持在视口坐标中。ResponsiveLayout 启动前，游戏画面刻意保持 / English: Keep server-rendered loaders in viewport coordinates. Before ResponsiveLayout is started, the game screen is deliberately maintained
  // 1280x720；若将加载器挂到其中，会把手机/平板的首帧推到屏幕外。 / English: 1280x720; if the loader is hung in it, the first frame of the phone/tablet will be pushed out of the screen.
  const serverLoader = root.querySelector<HTMLElement>('[data-role="launch-loading"]');

  // 小型启动外壳全部通过 DOM API 构造，不经过任何 HTML 解析或 TrustedHTML 铸造边界。 / English: The small startup shell is all constructed via the DOM API without any HTML parsing or TrustedHTML casting boundaries.
  const viewport = document.createElement("main");
  viewport.className = "viewport";
  viewport.dataset.role = "viewport";

  const safeArea = document.createElement("div");
  safeArea.className = "game-safe-area";
  safeArea.dataset.role = "safe-area";

  const frame = document.createElement("div");
  frame.className = "game-frame";
  frame.dataset.role = "frame";

  const canvasHost = document.createElement("div");
  canvasHost.className = "canvas-host";
  canvasHost.dataset.role = "canvas";

  const overlayHost = document.createElement("div");
  overlayHost.className = "dom-overlay";
  overlayHost.dataset.role = "overlay";
  frame.append(canvasHost, overlayHost);
  safeArea.append(frame);

  const launchHost = document.createElement("div");
  launchHost.className = "launch-loading-host";
  launchHost.dataset.role = "launch-host";

  const orientationLock = document.createElement("section");
  orientationLock.className = "orientation-lock";
  orientationLock.setAttribute("role", "status");
  orientationLock.setAttribute("aria-hidden", "true");
  orientationLock.setAttribute("aria-label", "Landscape orientation required");
  const orientationDevice = document.createElement("span");
  orientationDevice.className = "orientation-lock__device";
  orientationDevice.setAttribute("aria-hidden", "true");
  orientationDevice.append(document.createElement("i"));
  const orientationTitle = document.createElement("strong");
  orientationTitle.textContent = "Rotate to landscape";
  const orientationDescription = document.createElement("span");
  orientationDescription.textContent = "Primal Rampage uses a wide tactical display";
  orientationLock.append(orientationDevice, orientationTitle, orientationDescription);

  viewport.append(safeArea, launchHost, orientationLock);
  root.replaceChildren(viewport);
  const shell = {
    viewport,
    safeArea,
    frame,
    canvasHost,
    overlayHost,
    launchHost,
  };
  if (serverLoader) shell.launchHost.appendChild(serverLoader);
  return shell;
}

function markStartupAssembly(
  root: HTMLElement,
  stage: string,
  progress: number,
): void {
  const bounded = Math.min(1, Math.max(0, progress));
  root.dataset.startupAssemblyStage = stage;
  root.dataset.startupAssemblyProgress = bounded.toFixed(6);
  root.dataset.launchProgress = bounded.toFixed(6);
  const loading = root.querySelector<HTMLElement>('[data-role="launch-loading"]');
  if (loading) loading.dataset.stage = stage;
  const status = loading?.querySelector<HTMLElement>(".launch-loading__status");
  const value = loading?.querySelector<HTMLElement>(".launch-loading__value");
  const bar = loading?.querySelector<HTMLElement>(".launch-loading__track b");
  const track = loading?.querySelector<HTMLElement>(".launch-loading__track");
  if (status) status.textContent = "Assembling game scene";
  if (value) value.textContent = `${Math.round(bounded * 100)}%`;
  if (bar) bar.style.transform = `scaleX(${bounded})`;
  if (track) track.setAttribute("aria-valuenow", String(Math.round(bounded * 100)));
}

function throwIfStartupAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Application assembly was aborted");
  error.name = "AbortError";
  throw error;
}

function startupClockNow(): number {
  const now = globalThis.performance?.now?.();
  return Number.isFinite(now) ? now : Date.now();
}

interface BufferedRecoveredSpinResult {
  readonly result: SpinResult;
  readonly originFeatureState: Readonly<FeatureState>;
  /** 当本页不是旋转发起方且必须开始视觉重放时为 true。 / English: True when this page is not the initiator of rotation and visual replay must start. */
  readonly needsVisualSpinStart: boolean;
}

type RgsResultDeliveryStage =
  | ResultDeliveryStage
  | "callback"
  | "buffer-clone"
  | "buffer-validate"
  | "buffer-reel-guard"
  | "buffer-release"
  | "recovered-spin-start"
  | "accept-validate"
  | "autoplay-finalize"
  | "autoplay-arm"
  | "reel-transition"
  | "feature-transition"
  | "game-transition"
  | "accepted"
  | "rejecting"
  | "rejected";

function immutableClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableClone(item))) as T;
  }
  if (value !== null && typeof value === "object") {
    const clone = Object.fromEntries(Object.entries(value).map(([key, item]) => (
      [key, immutableClone(item)]
    )));
    return Object.freeze(clone) as T;
  }
  return value;
}

function bestEffortAppCleanup(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // 一个 owner 的拆卸故障不得阻止其余 observer、RAF、音频、网关与 GPU owner 清理。 / English: Teardown failure of one owner must not prevent the remaining observer, RAF, audio, gateway and GPU owners from cleaning up.
  }
}

const LAUNCH_INTRO_WALL_DEADLINE_GRACE_MS = 3_000;

export class AppController {
  private readonly root: HTMLElement;
  private readonly startupFrameRequest?: FrameRequest;
  private readonly machine = new GameStateMachine();
  private readonly reelRound = new ReelRoundStateMachine();
  private readonly renderer: PixiRenderer;
  private readonly layout: ResponsiveLayout;
  private readonly ui: DomOverlay;
  private readonly gateway: GameGateway;
  private readonly presentationObserver: AppPresentationObserver | null;
  private readonly onOperatorSessionRequired?: OperatorSessionRequestHandler;
  private readonly onPlayerErrorDiagnostic?: PlayerErrorDiagnosticHandler;
  private readonly skipFeaturePreview: boolean;
  private readonly suppressPostWinIdleRepeat: boolean;
  private readonly vaultUnlockCaptureEnabled: boolean;
  private readonly activeObservedFeatureEvents: Readonly<FeatureEvent>[] = [];
  private readonly stops: StopSequencer;
  private readonly audio: AudioManager;
  private readonly presentations = new PresentationQueue();
  private readonly launch = new LaunchStateMachine();
  private readonly launchClock: SwitchableLaunchClock;
  private readonly intro: IntroDirector;
  private launchIntroWallDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private launchIntroWallDeadlineResolver: (() => void) | null = null;
  private launchIntroWallDeadlineGeneration = 0;
  /** 随启动分支选择一次；仅用于表现，绝不影响玩法。 / English: Select once with the launch branch; only for performance, never affects gameplay. */
  private launchIntroClockMode: GameIntroClockMode = "playback-clock";
  private readonly preload: PreloadGate;
  private readonly streamingAssets: StreamingAssetRuntimePort;
  private readonly bigWinAssetPackageId: string;
  private readonly freeSpinsAssetPackageId: string;
  private readonly wheelAssetPackageId: string;
  private freeSpinsAssetLease: StreamingAssetEventLease | null = null;
  private wheelAssetLease: StreamingAssetEventLease | null = null;
  /** 仅供同文档夹具在 destroy 返回后读取；不发布到生产 DOM。 / English: Only read by the same document fixture after destroy returns; not published to the production DOM. */
  private destroyedStreamingAssetDiagnostics: StreamingAssetRuntimeDiagnostics | null = null;
  private destroyedVisualTelemetryActiveCount: number | null = null;
  private freeSpinsArtworkReady: Promise<void> | null = null;
  private wheelArtworkReady: Promise<void> | null = null;
  private readonly reducedMotion: boolean;
  private readonly reducedMotionMedia: MediaQueryList | null;
  private snapshot: GameSnapshot = {
    currency: "XXX",
    currencyExponent: 2,
    balanceMinor: "0",
    selectedBetMinor: "100",
    betOptionsMinor: ["100"],
    featureState: { ...EMPTY_FEATURE_STATE },
    lastWinMinor: "0",
    currentGrid: [],
  };
  /** 最后实际绘制的余额；已接受/恢复的经济状态可能更新。 / English: Last actual drawn balance; accepted/restored economic status may be updated. */
  private visibleBalanceMinor: MoneyMinor = "0";
  /** 同一 sessionId 的币种和小数指数只能由首个已解码会话确定一次。 / English: The currency and decimal exponent for the same sessionId can only be determined once by the first decoded session. */
  private sessionMoneyBinding: Readonly<{
    sessionId: string;
    currency: string;
    currencyExponent: number;
  }> | null = null;
  /** 从收到已接受结果起，到收集动作使结算可见前为 true。 / English: True from the time an accepted result is received until the collection action makes settlement visible. */
  private balanceVisibilityBlocked = false;
  private lastRoundId: string | null = null;
  private connectionStatus: GatewayStatus = "idle";
  private hasOpenedSession = false;
  private destroyed = false;
  private spinAudioGeneration = 0;
  private roundOriginFeatureState: FeatureState | null = null;
  /**
   * 关键资源或启动场景仍占据屏幕时，可能收到持久化 RGS 结果。将权威结果保留在内存中，
   * 但在 LaunchStateMachine 就绪前不得开始任何转轴、音频、经济状态或结果表现。
   *
   * 英文 / English: It is possible to receive persistent RGS results while a critical resource or startup scene still occupies the screen. Keep the authoritative result in memory, but no reels, audio, economy states or result performance may start until the LaunchStateMachine is ready.
   */
  private bufferedRecoveredSpinResult: BufferedRecoveredSpinResult | null = null;
  private freeSpinTimer: ReturnType<typeof setTimeout> | null = null;
  private featurePreviewActive = false;
  private featurePreviewResolver: (() => void) | null = null;
  private featurePreviewContinuePending = false;
  private initialSessionResolver: (() => void) | null = null;
  private initialRgsSessionTimer: ReturnType<typeof setTimeout> | null = null;
  private initialSessionFailure: PlayerFacingError | null = null;
  private operatorSessionRequestSent = false;
  private sessionTimedOut = false;
  private lastPlayerFacingError: PlayerFacingError | null = null;
  private scatterLandOrdinal = 0;
  private pendingWheelAward: WheelAwardedEvent | null = null;
  private wheelQuickStopAccepted = false;
  /** 阻止制作好的/DOM 落地按压事件穿透到付费 RNG。 / English: Prevent crafted/DOM landing press events from penetrating to paid RNG. */
  private wheelLandingInputBlocked = false;
  private bigWinInFreeSpins = false;
  private bigWinMusicResume: BigWinMusicResumeMode = "ambient";
  /** 接受权威结果时只采样一次表现偏好。 / English: Sampling performance preferences only once when accepting authoritative results. */
  private fastPlay = false;
  private normalWinPresentationActive = false;
  private normalWinFinishRequested = false;
  private normalWinDelayResolver: (() => void) | null = null;
  private postWinIdleRepeatGeneration = 0;
  private postWinIdleRepeatTimer: ReturnType<typeof setTimeout> | null = null;
  private postWinIdleRepeatActive = false;
  private activePresentationSequence: number | null = null;
  /** 官方 1.2s 收集视觉效果在后台运行时保留所属轮次。 / English: Official 1.2s Collection visuals retain their respective turns while running in the background. */
  private activeRageCollectionPresentationSequence: number | null = null;
  /** 观察可暂停的 4.120s PPS 级联时保留所属轮次。 / English: Observe pauseable 4.120s PPS cascades while retaining ownership of the round. */
  private activeRageCascadePresentationSequence: number | null = null;
  /** 渲染器的总结隐藏回调只属于这一排队轮次。 / English: The renderer's summary hidden callback belongs only to this queuing round. */
  private activeRoundFeatureAudioState: RoundFeatureAudioState | null = null;

  /**
   * 在不同的已绘制帧边界上构建外壳、DOM 叠层和 WebGL 图。
   * 生产环境与确定性视觉夹具共用此路径。
   *
   * 英文 / English: Construct shells, DOM overlays, and WebGL graphs on different drawn frame boundaries. Production environments share this path with deterministic vision fixtures.
   */
  static async create(
    root: HTMLElement,
    dependencies: AppControllerDependencies = {},
    options: AppControllerCreateOptions = {},
  ): Promise<AppController> {
    let ui: DomOverlay | null = null;
    let renderer: PixiRenderer | null = null;
    try {
      throwIfStartupAborted(options.signal);
      const shell = await buildPaintedStartupStage(
        "shell-mounted",
        () => mountApplicationShell(root),
        {
          signal: options.signal,
          requestFrame: options.requestFrame,
          onBuilt: () => markStartupAssembly(root, "shell-mounted", 0.01),
        },
      );

      const assetChannel = responsiveChannelFromEnvironment({
        search: window.location.search,
        coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false,
      });
      setPrimalRuntimeAssetChannel(assetChannel);
      ui = await buildPaintedStartupStage(
        "overlay-mounted",
        () => {
          const overlay = new DomOverlay(shell.overlayHost);
      // 在绘制栅栏前登记所有权。若该栅栏中止，外层 catch 仍必须销毁这个已构建叠层。 / English: Register ownership before painting the fence. If the fence aborts, the outer catch must still destroy the built overlay.
          ui = overlay;
          overlay.mountLaunchLoading(shell.launchHost);
          overlay.setLaunchPhase("boot", false);
          return overlay;
        },
        {
          signal: options.signal,
          requestFrame: options.requestFrame,
          onBuilt: () => markStartupAssembly(root, "overlay-mounted", 0.03),
        },
      );

      const viewportWidth = shell.safeArea.clientWidth
        || shell.viewport.clientWidth
        || 1;
      const viewportHeight = shell.safeArea.clientHeight
        || shell.viewport.clientHeight
        || 1;
      const initialLayout = computeResponsiveLayoutSnapshot(
        viewportWidth,
        viewportHeight,
        {
          channel: responsiveLayoutChannel(viewportWidth, viewportHeight, {
            search: window.location.search,
            coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false,
            finePointer: window.matchMedia?.("(pointer: fine)").matches ?? false,
            touchPoints: window.navigator?.maxTouchPoints,
          }),
        },
      );
      const rendererOptions = {
        characterCollectRandomSource: dependencies.characterCollectRandomSource,
        rageCascadeCellOrderSource: dependencies.rageCascadeCellOrderSource,
        initialSize: {
          width: initialLayout.viewportRegion.width,
          height: initialLayout.viewportRegion.height,
        },
      };
      // 每个重量级最终负责人都在各自的已绘制帧边界上构造。PixiRenderer 采用这些确切实例； / English: Each heavyweight final leader is constructed on its own drawn frame boundary. PixiRenderer takes these exact instances;
      // 不会丢弃预检图，也不会向输入暴露部分构建的渲染器。 / English: Preflight images are not discarded and partially constructed renderers are not exposed to input.
      renderer = await PixiRenderer.createStaged(shell.canvasHost, rendererOptions, {
        signal: options.signal,
        requestFrame: options.requestFrame,
        onProgress: (fraction) => {
          const progress = 0.03 + Math.max(0, Math.min(1, fraction)) * 0.02;
          markStartupAssembly(root, "renderer-constructing", progress);
        },
        onStage: (event) => {
          root.dataset.startupRendererConstructionStage = event.stage;
          root.dataset.startupRendererConstructionFrame = String(event.frame);
          root.dataset.startupRendererConstructionDurationMs = event.durationMs.toFixed(3);
          root.dataset.startupRendererConstructionComponentCount = String(event.componentCount);
        },
      });
      root.dataset.startupInitialRendererWidth = String(renderer.app.renderer.screen.width);
      root.dataset.startupInitialRendererHeight = String(renderer.app.renderer.screen.height);
      markStartupAssembly(root, "renderer-mounted", 0.05);
      // 完整图在连接控制器/网关前先绘制一次。 / English: The complete diagram is drawn once before connecting the controller/gateway.
      await waitForPaintedFrame(options.requestFrame);
      throwIfStartupAborted(options.signal);

      const prepared: PreparedApplicationView = {
        ...shell,
        assetChannel,
        ui,
        renderer,
        startupFrameRequest: options.requestFrame,
      };
      const controller = new AppController(root, dependencies, prepared);
      markStartupAssembly(root, "controller-wired", 0.05);
      return controller;
    } catch (error) {
      renderer?.destroy();
      ui?.destroy();
      markStartupAssembly(root, "assembly-failed", 0);
      throw error;
    }
  }

  constructor(
    root: HTMLElement,
    dependencies: AppControllerDependencies = {},
    preparedView?: PreparedApplicationView,
  ) {
    this.root = root;
    this.vaultUnlockCaptureEnabled = dependencies.vaultUnlockCaptureEnabled === true;
    this.startupFrameRequest = preparedView?.startupFrameRequest;
    const shell = preparedView ?? mountApplicationShell(root);
    const frame = shell.frame;
    const assetChannel = preparedView?.assetChannel ?? responsiveChannelFromEnvironment({
      search: window.location.search,
      coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false,
    });
    setPrimalRuntimeAssetChannel(assetChannel);
    this.streamingAssets = dependencies.streamingAssetRuntime
      ?? createStreamingAssetRuntime(assetChannel, import.meta.env, (diagnostics) => {
        publishStreamingAssetDiagnostics(this.root, diagnostics);
      });
    this.bigWinAssetPackageId = streamingFeaturePackageId(assetChannel, "big-win");
    this.freeSpinsAssetPackageId = streamingFeaturePackageId(assetChannel, "free-spins");
    this.wheelAssetPackageId = streamingFeaturePackageId(assetChannel, "wheel");
    this.reelRound.subscribe(({ state, roundId }) => {
      // 稳定的 DOM 接缝让浏览器测试可以观察渲染器/状态同步，同时不让游戏逻辑耦合到调试面板。 / English: Stable DOM seams allow browser testing to observe renderer/state synchronization without coupling game logic to the debug panel.
      frame.dataset.reelState = state;
      if (roundId) frame.dataset.reelRoundId = roundId;
      else delete frame.dataset.reelRoundId;
    });
    this.ui = preparedView?.ui ?? new DomOverlay(shell.overlayHost);
    this.ui.mountLaunchLoading(shell.launchHost);
  // DOM 启动界面先于 WebGL 和场景图挂载。生产入口会等待其已绘制帧栅栏后再构造。 / English: The DOM startup interface is mounted before WebGL and the scene graph. The production portal will wait until it has drawn the frame fence before constructing it.
    this.renderer = preparedView?.renderer ?? new PixiRenderer(shell.canvasHost, {
      characterCollectRandomSource: dependencies.characterCollectRandomSource,
      rageCascadeCellOrderSource: dependencies.rageCascadeCellOrderSource,
    });
    this.renderer.attachFeaturePreviewCanvasHost(this.ui.getFeaturePreviewCanvasHost());
    this.audio = dependencies.audioManager ?? new AudioManager({ assetChannel });
    this.audio.bindUserGestures(root);
    // 测试/嵌入式宿主可能仍只提供旧 viewport；生产 shell 始终优先观察安全区外框。 / English: Test/embedded hosts may still only provide the old viewport; production shells always prioritize viewing the enclave outline.
    this.layout = new ResponsiveLayout(shell.safeArea ?? shell.viewport, frame, (snapshot) => {
      this.ui.setResponsiveLayout(snapshot);
      this.renderer.setResponsiveLayout(snapshot);
    });
    this.ui.onHandModeChange((handMode) => this.layout.setHandMode(handMode));
    this.ui.setOperatorApprovedGameRules(dependencies.operatorApprovedGameRules);
    this.stops = new StopSequencer(this.renderer.reels, {}, {
      onReelStopStart: ({ reel }) => {
        this.reelRound.transition({ type: "REEL_STOP_STARTED", reel });
      },
      onReelImpact: ({ reel, cells, fastForward }) => {
        this.renderer.reelImpact(reel, fastForward);
        this.audio.playReelStop(reel, {
          intensity: 1,
          reducedMotion: this.reducedMotionMedia?.matches ?? this.reducedMotion,
        });
        this.presentReelLandAudio(reel, cells);
      },
      onAnticipationStart: () => {
        this.renderer.startReelAnticipation();
        this.audio.playReelAnticipation({
          intensity: 1,
          reducedMotion: this.reducedMotionMedia?.matches ?? this.reducedMotion,
        });
      },
      onAnticipationStop: ({ fastForward, reason }) => {
        this.renderer.stopReelAnticipation(fastForward || reason !== "reel-impact");
        this.audio.stopReelAnticipation(anticipationAudioFadeMs(fastForward, reason));
      },
      onAnticipationHideComplete: () => {
      // 一个/两个 Rage 的结果没有符号所有的停轴退场流程。火焰隐藏尾段期间保留官方轮播文案， / English: A one- or two-Rage result has no symbol-owned reel-stop outro. Preserve the authored carousel copy during the flame-hide tail,
      // 然后在收集/转换开始前的干净网格边界将其清除。 / English: Then clear it at the clean mesh boundaries before collection/transformation begins.
        this.ui.clearTransientSpinMessage?.();
      },
      onPostStopTransitionStart: (event: ReelPostStopActivationEvent) => {
        if (event.kind !== "surge-feature-activation") return;
      // 第三轴火焰帧播放 333.333ms `hide` 时、SCATTER_FEATURE_ACTIVATE 前清除官方信息行。 / English: While the third-reel flame frame plays its 333.333 ms `hide`, clear the authored information line before SCATTER_FEATURE_ACTIVATE.
        this.ui.clearTransientSpinMessage?.();
      },
      onPostStopActivation: (event: ReelPostStopActivationEvent) => {
        if (event.kind === "surge-feature-activation") {
          this.renderer.playPostStopSurgeActivation();
          return;
        }
        return this.observeWildRevealBoundary("pre", event);
      },
      onPostStopActivationComplete: (event: ReelPostStopActivationEvent) => {
        if (event.kind !== "wild-reveal") return;
        return this.observeWildRevealBoundary("complete", event);
      },
      onAllReelsStopped: () => {
        this.reelRound.transition({ type: "ALL_REELS_STOPPED" });
      },
    });
    this.reducedMotionMedia = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    this.reducedMotion = this.reducedMotionMedia?.matches ?? false;
    this.renderer.setCharacterAnimationListener((event) => this.presentCharacterAudio(event));
    this.renderer.setFeaturePresentationMilestoneListener((milestone) => {
      this.presentFeaturePresentationMilestone(milestone);
    });
    this.renderer.setFeaturePresentationBranchListener((branch) => {
      this.observePresentationBranch(branch);
    });
    this.renderer.setRageCollectionPresentationMilestoneListener((milestone) => {
      this.observeRageCollectionPresentationMilestone(milestone);
    });
    const observesRageCascade = dependencies.presentationObserver?.onPresentationTrace
      || dependencies.presentationObserver?.onPresentationCheckpoint;
    this.renderer.setRageCascadePresentationMilestoneListener?.(observesRageCascade
      ? (milestone) => this.observeRageCascadePresentationMilestone(milestone)
      : null);
    this.renderer.setVaultUnlockPresentationMilestoneListener?.(
      this.vaultUnlockCaptureEnabled
        && dependencies.presentationObserver?.onPresentationCheckpoint
        ? (milestone) => this.observeVaultUnlockPresentationMilestone(milestone)
        : null,
    );
    this.renderer.setBigWinMilestoneListener((milestone) => {
      this.presentBigWinAudio(milestone);
      return this.observeBigWinMilestone(milestone);
    });
    this.launchClock = new SwitchableLaunchClock();
    this.intro = new IntroDirector(this.renderer.launchScene, {
      clock: this.launchClock,
      clockOwnsElapsedTime: true,
      reducedMotion: this.reducedMotion,
      onFrame: (frame, timeMs) => {
        this.renderer.seekAuthoredIntro(timeMs);
        this.ui.setHudReveal(frame.hudProgress);
        this.renderer.setJackpotHudReveal(frame.hudProgress);
      },
      onCue: (cue) => {
        this.renderer.cueIntro(cue.name);
        this.presentIntroAudio(cue);
      },
      onComplete: ({ skipped, reducedMotion }) => this.renderer.completeIntro(skipped, reducedMotion),
    });
    this.preload = new PreloadGate([
      {
        name: "renderer-scene-mounted",
        stage: "scene-mount",
        weight: 5,
        run: ({ signal, report }) => {
          if (this.destroyed) throw new Error("Controller was destroyed before scene mount");
          if (signal.aborted) throw signal.reason;
          report(1);
        },
      },
      {
        name: "critical-dom-readiness",
        stage: "dom-readiness",
        weight: 10,
        timeoutMs: 30_000,
        run: ({ signal, report }) => waitForCriticalDomReadiness(root, {
          signal,
          onProgress: ({ progress }) => report(progress),
        }),
      },
      {
        name: "entry-critical-resources",
        stage: "assets",
        weight: 70,
        timeoutMs: 60_000,
        run: async ({ signal, report }) => {
          let visualProgress = 0;
          let audioProgress = 0;
          const reportCombined = (): void => {
            if (this.destroyed || signal.aborted) return;
    // 视觉数据占据大多数可测量的启动工作；已解码主音频栅栏保持显式， / English: Visual data takes up most measurable startup effort; decoded main audio barrier remains explicit,
    // 而不是作为第二个等权任务。 / English: rather than as a second equally weighted task.
            report(visualProgress * 0.85 + audioProgress * 0.15);
          };
          await Promise.all([
            this.renderer.loadCriticalAssets({
              signal,
              onProgress: (fraction) => {
                visualProgress = fraction;
                reportCombined();
              },
            }),
            this.audio.primeForLaunch().then(() => {
              audioProgress = 1;
              reportCombined();
            }),
          ]);
        },
      },
      {
        name: "critical-gpu-warmup",
        stage: "gpu-warmup",
        weight: 15,
        timeoutMs: 30_000,
        run: ({ signal, report }) => this.renderer.warmCriticalAssets({
          signal,
          onProgress: report,
        }),
      },
    ]);
    this.gateway = dependencies.gateway ?? createConfiguredGameGateway({
      env: import.meta.env,
      pageUrl: window.location.href,
      history: window.history,
      isFramed: isWindowFramed(window),
      sessionStorage: optionalWindowSessionStorage(window),
    });
    this.presentationObserver = dependencies.presentationObserver ?? null;
    this.onOperatorSessionRequired = dependencies.onOperatorSessionRequired;
    this.onPlayerErrorDiagnostic = dependencies.onPlayerErrorDiagnostic;
    this.renderer.setVisualTelemetryListener?.(
      this.presentationObserver?.onVisualTelemetry
        ? (event) => this.presentationObserver?.onVisualTelemetry?.(event)
        : null,
      () => ({ sequence: this.activePresentationSequence ?? undefined }),
    );
    this.skipFeaturePreview = dependencies.skipFeaturePreview ?? false;
    this.suppressPostWinIdleRepeat = dependencies.suppressPostWinIdleRepeat === true;
    if (this.presentationObserver?.onPresentationCheckpoint) {
      this.renderer.setFeaturePresentationInputCheckpointListener((gate) => (
        this.requestFeaturePresentationInputCheckpoint(gate)
      ));
      this.renderer.setFeaturePresentationSemanticCheckpointListener((state) => (
        this.requestSemanticPresentationCheckpoint(state)
      ));
    }

    this.gateway.setCallbacks({
      onStatus: (status) => this.handleStatus(status),
      onSession: (session) => this.handleSession(session),
      onSpinResult: (result, originFeatureState) => (
        this.handleSpinResult(result, originFeatureState)
      ),
      onResultDeliveryStage: (stage) => this.markRgsResultDeliveryStage(stage),
      onSpinResultAcknowledged: () => this.refreshUi(),
      onOperatorSessionRequired: (error) => this.handleOperatorSessionRequired(error),
      onSessionTimeout: (timeout) => this.handleSessionTimeout(timeout),
      onError: (error) => this.handleError(error),
    });
    this.ui.onSpin(() => this.requestSpin());
    this.ui.onFastStop(() => this.requestFastStop());
    this.ui.onBet((bet) => this.selectBet(bet));
    this.ui.onSkip(() => {
      this.audio.stopGameIntro(200);
      this.intro.skip();
    });
    this.ui.onPreviewContinue(() => this.continueFeaturePreview());
    this.ui.onSoundToggle(() => this.toggleSound());
    bindUiPanelAudio(this.ui, this.audio);
    bindFastPlayPreference(this.ui, this.renderer, (enabled) => {
      this.fastPlay = enabled;
    });
    this.ui.setSoundState(this.audio.muted, this.audio.isAvailable);
    this.reducedMotionMedia?.addEventListener("change", this.handleReducedMotionChange);
    this.ui.setLaunchPhase("boot", false);
  }

  start(): void {
    this.layout.start();
    this.machine.transition({ type: "START" });
    this.launch.transition({ type: "START_PRELOAD" });
    this.syncLaunchUi();
    this.refreshUi();
    this.gateway.connect();
    this.armInitialRgsSessionTimeout();
    void this.runLaunch();
  }

  /** 仅用于浏览器夹具诊断；绝不反馈到状态、结算或 RNG。 / English: Used only for browser fixture diagnostics; never fed back to status, settlement, or RNG. */
  getReelPerspectiveDiagnostics(): ReturnType<PixiRenderer["getReelPerspectiveDiagnostics"]> {
    return this.renderer.getReelPerspectiveDiagnostics();
  }

  /** 仅用于浏览器夹具诊断；绝不反馈到状态、结算或 RNG。 / English: Used only for browser fixture diagnostics; never fed back to status, settlement, or RNG. */
  getReelCabinetCompositionDiagnostics(): ReturnType<
    PixiRenderer["getReelCabinetCompositionDiagnostics"]
  > {
    return this.renderer.getReelCabinetCompositionDiagnostics();
  }

  /** 浏览器夹具的 Vault 姿态诊断；绝不反馈到游戏状态。 / English: Vault-pose diagnostics for browser fixtures; never feed them back into game state. */
  getVaultCaptureDiagnostics(
    address: Readonly<CellAddress>,
  ): ReturnType<PixiRenderer["reels"]["getVaultCaptureDiagnostics"]> {
    return this.renderer.reels.getVaultCaptureDiagnostics(address);
  }

  /** 浏览器夹具的姿态调节；生产入口绝不调用。 / English: Pose adjustment for browser fixtures; the production entry point never calls it. */
  prepareNeutralCharacterCapture(): boolean {
    return this.renderer.prepareNeutralCharacterCapture();
  }

  /** 仅用于浏览器夹具诊断；绝不反馈到状态、结算或 RNG。 / English: Used only for browser fixture diagnostics; never fed back to status, settlement, or RNG. */
  getCharacterCaptureDiagnostics(): ReturnType<PixiRenderer["getCharacterCaptureDiagnostics"]> {
    return this.renderer.getCharacterCaptureDiagnostics();
  }

  /** 浏览器夹具的时钟暂停；生产启动流程绝不调用此接缝。 / English: The browser fixture's clock is paused; the production launch process never calls this seam. */
  setCharacterIntroCapturePaused(paused: boolean): boolean {
    return this.renderer.setCharacterIntroCapturePaused(paused);
  }

  /** 浏览器夹具的精确时钟步进；生产入口绝不调用。 / English: Exact clock stepping for browser fixtures; never called by production portal. */
  advanceBaseWinCharacterCapture(elapsedMs: number): boolean {
    return this.renderer.advanceBaseWinCharacterCapture(elapsedMs);
  }

  /** 浏览器夹具的 Wheel WIN_FEATURE 步进；生产环境绝不调用。 / English: Wheel WIN_FEATURE stepping for browser fixtures; never called in production. */
  advanceWheelWinFeatureCharacterCapture(elapsedMs: number): boolean {
    return this.renderer.advanceWheelWinFeatureCharacterCapture(elapsedMs);
  }

  /** 浏览器夹具的 FEATURE_CHEST_LOOP 步进；生产环境绝不调用。 / English: FEATURE_CHEST_LOOP stepping for browser fixtures; never called by production environments. */
  advanceWheelChestPoundCapture(elapsedMs: number): boolean {
    return this.renderer.advanceWheelChestPoundCapture(elapsedMs);
  }

  /** 浏览器夹具的调度器证据；绝不反馈到表现或玩法。 / English: Scheduler evidence for browser fixtures; never feeds back into performance or gameplay. */
  getWheelChestPoundDiagnostics(): ReturnType<
    PixiRenderer["getWheelChestPoundDiagnostics"]
  > {
    return this.renderer.getWheelChestPoundDiagnostics();
  }

  /** 在不更改 FASTPLAY 状态的情况下采样只读捕获环境。 / English: Sample a read-only capture environment without changing FASTPLAY state. */
  getWheelChestPoundCaptureEnvironmentDiagnostics(): Readonly<{
    fastPlay: boolean;
  }> {
    return Object.freeze({ fastPlay: this.fastPlay });
  }

  /** 仅用于浏览器夹具诊断；绝不反馈到游戏或启动状态。 / English: Used only for browser fixture diagnostics; never fed back to game or startup status. */
  getCharacterIntroLifecycleCaptureDiagnostics(): ReturnType<
    PixiRenderer["getCharacterIntroLifecycleCaptureDiagnostics"]
  > {
    return this.renderer.getCharacterIntroLifecycleCaptureDiagnostics();
  }

  /** 浏览器夹具的文案调节；生产环境使用制作好的轮播。 / English: Copywriting adjustment for browser fixtures; production environment uses the prepared carousel. */
  prepareSpinMessageCapture(message: string): boolean {
    return this.ui.prepareSpinMessageCapture(message);
  }

  /** 销毁后只读的资源终态；活动控制器不提供推测值。 / English: Read-only final state of the resource after destruction; activity controllers do not provide speculative values. */
  getDestroyedStreamingAssetDiagnostics(): StreamingAssetRuntimeDiagnostics | null {
    return this.destroyed ? this.destroyedStreamingAssetDiagnostics : null;
  }

  /** 销毁后只读的真实表现 reporter 终态；活动控制器不提供推测值。 / English: Actual representation of the read-only reporter final state after destruction; activity controllers do not provide speculative values. */
  getDestroyedVisualTelemetryActiveCount(): number | null {
    return this.destroyed ? this.destroyedVisualTelemetryActiveCount : null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    bestEffortAppCleanup(() => this.stopPostWinIdleRepeat());
    bestEffortAppCleanup(() => this.clearLaunchIntroWallDeadline());
    bestEffortAppCleanup(() => this.clearInitialRgsSessionTimeout());
    bestEffortAppCleanup(() => finishStartupPerformanceMonitor(this.root));
    // 若构造过程在启动设置前中断，确保拆卸流程安全。 / English: If the construction process is interrupted before starting the setup, ensure that the disassembly process is safe.
    bestEffortAppCleanup(() => this.preload?.abort());
    bestEffortAppCleanup(() => this.releaseFeatureAssetEventLease("wheel"));
    bestEffortAppCleanup(() => this.releaseFeatureAssetEventLease("free-spins"));
    bestEffortAppCleanup(() => this.streamingAssets?.destroy());
    bestEffortAppCleanup(() => {
      this.destroyedStreamingAssetDiagnostics = this.streamingAssets?.diagnostics() ?? null;
    });
    if (this.activeObservedFeatureEvents.length > 0) {
      this.activeObservedFeatureEvents.length = 0;
      bestEffortAppCleanup(() => this.notifyFeatureEvent(null, null));
    }
    bestEffortAppCleanup(() => this.observePresentationMilestone(null));
    bestEffortAppCleanup(() => (
      this.ui?.completeAutoplayStopRound?.(this.activePresentationSequence ?? undefined)
    ));
    this.activePresentationSequence = null;
    this.activeRageCollectionPresentationSequence = null;
    this.activeRageCascadePresentationSequence = null;
    const featurePreviewResolver = this.featurePreviewResolver;
    this.featurePreviewResolver = null;
    this.featurePreviewActive = false;
    bestEffortAppCleanup(() => featurePreviewResolver?.());
    const initialSessionResolver = this.initialSessionResolver;
    this.initialSessionResolver = null;
    bestEffortAppCleanup(() => initialSessionResolver?.());
    this.featurePreviewContinuePending = false;
    this.roundOriginFeatureState = null;
    this.bufferedRecoveredSpinResult = null;
    bestEffortAppCleanup(() => this.cancelScheduledFreeSpin());
    bestEffortAppCleanup(() => this.stopRoundAudio(0));
    bestEffortAppCleanup(() => this.audio.stopGameIntro(0));
    bestEffortAppCleanup(() => this.stops.cancel());
    bestEffortAppCleanup(() => this.reelRound.reset("controller-destroyed"));
    bestEffortAppCleanup(() => this.renderer.cancelSpinPresentation());
    bestEffortAppCleanup(() => this.intro.destroy());
    bestEffortAppCleanup(() => this.gateway.close());
    bestEffortAppCleanup(() => this.layout.stop());
    bestEffortAppCleanup(() => (
      this.reducedMotionMedia?.removeEventListener("change", this.handleReducedMotionChange)
    ));
    bestEffortAppCleanup(() => this.audio.destroy());
    bestEffortAppCleanup(() => this.renderer.setFeaturePresentationMilestoneListener(null));
    bestEffortAppCleanup(() => this.renderer.setFeaturePresentationBranchListener(null));
    bestEffortAppCleanup(() => this.renderer.setFeaturePresentationInputCheckpointListener(null));
    bestEffortAppCleanup(() => this.renderer.setRageCascadePresentationMilestoneListener?.(null));
    bestEffortAppCleanup(() => this.renderer.setRageCascadePresentationPaused?.(false));
    bestEffortAppCleanup(() => this.renderer.setVaultUnlockPresentationMilestoneListener?.(null));
    bestEffortAppCleanup(() => this.renderer.setBigWinMilestoneListener(null));
    bestEffortAppCleanup(() => this.renderer.setFeaturePreviewVisible(false));
    bestEffortAppCleanup(() => this.ui.clearWheelBonusRoundSummary?.());
    bestEffortAppCleanup(() => this.ui.destroy());
    bestEffortAppCleanup(() => this.renderer.destroy());
    bestEffortAppCleanup(() => {
      this.destroyedVisualTelemetryActiveCount = this.renderer.getVisualTelemetryActiveCount();
    });
  }

  private async runLaunch(): Promise<void> {
    try {
      await this.preload.run((progress) => {
        this.publishStartupProgress(progress);
      });
      if (this.destroyed || this.sessionTimedOut) return;
      this.throwIfInitialSessionFailed();
      // PreloadGate 此时已写入唯一真实的 100%。在真实绘制边界前保持其可见， / English: PreloadGate has written the only true 100% at this time. Keep the border visible until it is actually drawn,
      // 任何启动转换都不得提前将其隐藏。 / English: Any boot transition must not hide it in advance.
      if (this.root?.dataset) {
        this.root.dataset.startupReadiness = "complete";
        this.root.dataset.startupReadinessCompleteAt = String(startupClockNow());
      }
      await waitForPaintedFrame(this.startupFrameRequest);
      if (this.destroyed || this.sessionTimedOut) return;
      if (this.root?.dataset) {
        this.root.dataset.startupReadiness = "complete-painted";
        this.root.dataset.startupReadinessPaintedAt = String(startupClockNow());
        this.root.dataset.startupAssemblyStage = "readiness-complete-painted";
      }
      finishStartupPerformanceMonitor(this.root);
      this.launch.transition({ type: "PRELOAD_COMPLETE" });
      this.refreshUi();
        // 遵从明确的“不再显示”偏好。被关闭的预览可以静默开始，直到玩家下次使用声音控件； / English: Honor explicit "Don't show again" preferences. A closed preview can start silently until the next time the player uses sound controls;
        // 该真实手势可以解锁 AudioContext。 / English: This real gesture unlocks the AudioContext.
      const forceFeaturePreview = new URLSearchParams(window.location.search)
        .get("featurePreview") === "force";
      if (!this.skipFeaturePreview
        && (forceFeaturePreview || !this.ui.isFeaturePreviewDismissed())) {
        this.launchIntroClockMode = "playback-clock";
        await this.waitForFeaturePreview();
        if (this.destroyed || this.sessionTimedOut) return;
        this.throwIfInitialSessionFailed();
      } else {
      // 复刻的 showSplash=false 仍会等待重连，然后在介绍前发出相同的 / English: Forked with showSplash=false still waits for reconnection and then issues the same before introducing
      // SPLASH_HIDE/BaseGameMusicStart 边界。 / English: SPLASH_HIDE/BaseGameMusicStart boundary.
        await this.waitForInitialSession();
        if (this.destroyed || this.sessionTimedOut) return;
        this.throwIfInitialSessionFailed();
        this.launchIntroClockMode = "wall-clock";
        this.launchClock?.resetToWall?.();
        this.syncGameMusic();
      }
      if (this.destroyed || this.sessionTimedOut) return;
      this.syncLaunchUi();
      await this.playLaunchIntroWithinWallDeadline();
      if (this.destroyed || this.sessionTimedOut) return;
      // Base 音乐已在 Continue/SPLASH_HIDE 时启动。GameReady 没有第二套 SoundStage 程序， / English: Base music has been started at Continue/SPLASH_HIDE. GameReady does not have a second SoundStage program;
      // 因此 Intro 完成时不得重写淡化效果。 / English: Therefore the fade effect must not be overridden when the Intro is complete.
      this.launch.transition({ type: "INTRO_COMPLETE" });
      this.syncLaunchUi();
      this.refreshUi();
      // syncLaunchUi 会先移除启动界面。恢复的已提交结果此时可开始其唯一一次可见重放， / English: syncLaunchUi will remove the launch interface first. The restored committed result can now begin its only visible replay,
      // 而不会在启动界面背后播放动画。 / English: The animation will not be played behind the startup interface.
      this.releaseBufferedRecoveredSpinResult();
      // shadow 模式只在严格首启资源和制作好的介绍完成后开始。故障由协调器内部吞掉， / English: Shadow mode only starts after a strict initial launch of the resource and the completion of the crafted intro. Failures are swallowed internally by the coordinator,
      // 绝不能改变启动、输入、结果或特性事件顺序。自定义/嵌入式协调器同样不具权威性； / English: Never change the sequence of startup, input, result, or feature events. Custom/embedded coordinators are also not authoritative;
      // 即使宿主实现有缺陷，也不得进入启动失败的 catch。 / English: Even if the host implementation is defective, a catch that fails to start must not be entered.
      try {
        this.streamingAssets.scheduleFeatureShadowPrefetch();
      } catch {
      // 影子诊断尽力而为；按需 Big Win 包仍由其真实事件租约独立校验。 / English: Shadow diagnostics are best effort; on-demand Big Win packages are still independently verified by their real event leases.
      }
    } catch (error) {
      if (this.destroyed || this.sessionTimedOut) return;
      this.clearLaunchIntroWallDeadline();
      finishStartupPerformanceMonitor(this.root);
      this.completeLaunchFailure(this.initialSessionFailure
        ?? playerFacingErrorFor(error, "launch"));
    }
  }

  private publishStartupProgress(progress: Readonly<PreloadProgress>): void {
    const visible = mapPreloadToVisibleProgress(progress);
    const encodedProgress = visible.progress.toFixed(6);
    if (this.root?.dataset) {
      this.root.dataset.startupReadinessStage = visible.stage;
      this.root.dataset.startupReadinessProgress = encodedProgress;
      this.root.dataset.startupAssemblyProgress = encodedProgress;
      this.root.dataset.launchProgress = encodedProgress;
    }
    this.ui.setStartupProgress(visible);
  }

  private requestSpin(): void {
    if (this.sessionTimedOut) return;
    // CAPLIMIT 只在制作好的 733.3ms 显示后开放 CONTINUE_SPIN。该有界栅栏激活期间， / English: CAPLIMIT only opens CONTINUE_SPIN after 733.3ms of display. While the bounded fence is active,
    // 它的优先级高于所有特性/转轴操作，并且绝不提交另一权威轮次。 / English: It takes precedence over all feature/reel operations and is never submitted for another authoritative round.
    if (this.renderer.requestFreeSpinCapContinue?.()) return;
    // 终局 Free Spins 面板拥有同一个主要 Continue 控件。 / English: The endgame Free Spins panel has the same main Continue control.
    // 它独立于无限特性介绍和 CAPLIMIT 栅栏。 / English: It is independent of infinite feature introductions and CAPLIMIT fences.
    if (this.renderer.requestFreeSpinSummaryContinue?.()) return;
    // GameFreespinView waitForContinue(-1)：该手势关闭介绍；它本身绝不提交付费/免费轮次请求。 / English: GameFreespinView waitForContinue(-1): This gesture closes the intro; it never submits a paid/free spin request by itself.
    if (this.renderer.requestFreeSpinContinue?.()) return;
    // Layer-A Wheel 总结随显示片段开放有界 CONTINUE。关闭操作只推进表现像素，绝不请求 RNG。 / English: Layer-A Wheel summary opens bounded CONTINUE with display fragment. The closing operation only advances the rendering pixels and never requests RNG.
    if (this.renderer.requestWheelSummaryContinue?.()) return;
    // Primal Wheel 期间，现有 Spin 控件拥有该特性的显式第二次手势； / English: During Primal Wheel, existing Spin controls have an explicit second gesture for this feature;
    // 它不得创建另一服务端轮次。 / English: It MUST NOT create another server round.
    const wheelInteraction = this.renderer.requestWheelInteraction?.();
    if (wheelInteraction === "popup-continued" || wheelInteraction === "spin-started") return;
    if (wheelInteraction === "quick-stop" || this.wheelLandingInputBlocked) return;
    if (!this.machine.canSpin || this.gateway.hasPendingSpin || this.reelRound.state !== "Idle") return;
    const audioUnlock = this.audio.unlock();
    const originFeatureState = { ...this.snapshot.featureState };
    const roundId = createRequestId("round");
    const accepted = this.gateway.requestSpin(roundId, this.snapshot.selectedBetMinor);
    if (!accepted) return;
      // 被拒绝的手势必须保留已结算结果。第一个被接受的 ROUNDSTART / English: Rejected gestures must retain settled results. The first accepted ROUNDSTART
      // 拥有中奖后的停止/清除边界。 / English: Has a post-win stop/clear boundary.
    this.stopPostWinIdleRepeat();
    if (originFeatureState.mode === "BASE" && originFeatureState.freeSpinsRemaining === 0) {
      this.ui.commitAcceptedPaidAutoplaySpin?.();
    }
    this.observeRoundPresentationState("requested");
    this.reelRound.transition({ type: "SPIN_ACCEPTED", roundId });
    this.audio.beginBaseMusicRound?.(this.snapshot.selectedBetMinor);
    this.roundOriginFeatureState = originFeatureState;
    this.ui.resetWinCounter(
      this.snapshot.featureState.mode === "BASE"
        ? "0"
        : this.snapshot.featureState.freeSpinsWinMinor ?? "0",
    );
    this.scatterLandOrdinal = 0;
    this.pendingWheelAward = null;
    this.wheelQuickStopAccepted = false;
    this.wheelLandingInputBlocked = false;
    this.stops.markSpinStart();
    this.cancelScheduledFreeSpin();
    this.machine.transition({ type: "SPIN_REQUESTED" });
    const reducedMotion = this.reducedMotionMedia?.matches ?? this.reducedMotion;
      // SoundStage 在全局 SPIN_START 时派发 ReelStart。暂停的音频上下文可能使其暂时无声， / English: SoundStage dispatches ReelStart on global SPIN_START. A paused audio context may render it temporarily silent,
      // 但不能丢弃该提示音。 / English: But the tone cannot be discarded.
    this.startRoundAudio(audioUnlock, reducedMotion);
    this.renderer.beginSpinPresentation(reducedMotion);
    this.reelRound.transition({ type: "REELS_STARTED" });
    // 转轴索引 0 在 beginSpinPresentation 内进入 STARTING；将其 ReelLoop 程序保留为 / English: Spindle index 0 enters STARTING within beginSpinPresentation; leave its ReelLoop routine as
    // 全局启动提示音之后的独立事件。 / English: Independent event after the global startup beep.
    this.audio.startReelLoop({ intensity: 1, reducedMotion });
    this.ui.setSpinMode("waiting");
    this.refreshUi();
  }

  private requestFastStop(): void {
      // Big Win 可见时拥有最顶层点击平面和共享 Spin 控件。每次按下推进一个装饰里程碑； / English: The Big Win is visible with the topmost click plane and shared Spin control. Each press advances a decoration milestone;
      // 已解码结果和余额保持不变。 / English: The decoded results and balance remain unchanged.
    if (this.renderer.requestBigWinInteraction?.()) return;
      // 轮盘旋转时，同一个控件会快速停止轮盘。此逻辑与 StopSequencer 保持分离， / English: The same control quickly stops the wheel as it spins. This logic remains separate from StopSequencer,
      // 以确保普通转轴快速停止语义不变。 / English: To ensure that the common reel quick stop semantics remain unchanged.
    if (this.renderer.requestWheelInteraction?.() === "quick-stop") return;
    if (this.wheelLandingInputBlocked) return;
    if (this.normalWinPresentationActive) {
      if (this.normalWinFinishRequested) return;
      this.normalWinFinishRequested = true;
      const sequence = this.activePresentationSequence;
      if (sequence !== null) {
        this.emitPresentationTrace({
          type: "normal-win.continue-accepted",
          sequence,
        });
      }
      this.ui.finishWinCounter?.();
      this.renderer.winCelebration.requestFinish?.();
      const resolveDelay = this.normalWinDelayResolver;
      this.normalWinDelayResolver = null;
      resolveDelay?.();
    // 官方 Primal 控制器只在当前中奖隐藏命令后派发 SFXQuickstop。Promise 延续顺序允许 / English: The official Primal controller only dispatches SFXQuickstop after the current winning hidden command. Promise continuation order allowed
    // 渲染器在同一帧内先提交 hide/hide_merged。 / English: The renderer submits hide/hide_merged first within the same frame.
      queueMicrotask(() => {
        if (!this.destroyed) this.audio.quickStopReelLoop();
      });
      this.ui.setSpinMode("waiting");
      return;
    }
    if (this.stops.requestFastForward()) {
      // 在玩家已请求停止编排后，先使仍待处理的解锁回调失效，防止它再启动马达。 / English: After the player has requested to stop the orchestration, first invalidate the pending unlock callback to prevent it from starting the motor again.
      this.spinAudioGeneration += 1;
      this.renderer.markFastStop();
      this.audio.quickStopReelLoop();
      this.ui.setSpinMode("waiting");
    }
  }

  private selectBet(betMinor: MoneyMinor): void {
    if (!this.machine.canSpin || this.snapshot.featureState.freeSpinsRemaining > 0
      || !this.snapshot.betOptionsMinor.includes(betMinor)) return;
    this.audio.playUiClick({ intensity: 0.48 });
    this.snapshot.selectedBetMinor = betMinor;
    this.ui.applySnapshot(this.snapshot);
    this.renderer.setJackpotBet(this.snapshot.selectedBetMinor);
  }

  private handleStatus(status: GatewayStatus): void {
    // SESSION_TIMEOUT 是不可逆终态；任何已排队的状态回调都不得重新发布 online。 / English: SESSION_TIMEOUT is an irreversible final state; any queued status callbacks must not be reissued online.
    if (this.sessionTimedOut) return;
    this.connectionStatus = status;
    this.ui.setConnection(status);
    if (status === "recovering") this.ui.clearWheelBonusRoundSummary?.();
    if (status === "recovering" && !["booting", "recovering", "failed", "presenting"].includes(this.machine.phase)) {
      this.machine.transition({ type: "CONNECTION_LOST" });
      this.refreshUi();
    }
  }

  private handleSession(session: SessionOpened): void {
    if (this.sessionTimedOut) return;
    // 一次性 RGS code 已进入“向宿主索取新会话”状态时，迟到回调不得复活旧会话。 / English: When a one-time RGS code has entered the "request new session from host" state, late callbacks must not resurrect the old session.
    if (this.initialSessionFailure && this.requiresOperatorSessionRecovery()) return;
    if (!this.acceptSessionMoneyBinding(session)) return;
    // 测试替身可省略该纯显示端口；生产 PixiRenderer 会把同一个冻结格式器下发到全部金额表面。 / English: Test avatars can omit this display-only port; the production PixiRenderer will deliver the same frozen formatter to all surfaces.
    this.renderer.setMoneyDisplayBinding?.(session);
    this.clearInitialRgsSessionTimeout();
    // RGS 在调用已提交结果回调前清除网络待处理标记。该权威结果在启动流程之后等待期间， / English: RGS clears the network pending flag before calling the committed result callback. The authoritative result is waited for after starting the process.
    // 仍拥有轮次前特性和可见余额投影。 / English: Still has pre-round features and visible balance projection.
    const pendingRound = this.gateway.hasPendingSpin
      || (this.bufferedRecoveredSpinResult ?? null) !== null;
    const showAttractGrid = !pendingRound
      && !this.hasOpenedSession
      && this.snapshot.currentGrid.length === 0;
    const presentationOwnsFeatureProjection = this.machine.phase === "presenting";
    const preserveFeatureProjection = pendingRound || presentationOwnsFeatureProjection;
    const preserveVisibleBalance = pendingRound || this.balanceVisibilityBlocked;
    if (pendingRound && this.roundOriginFeatureState === null) {
      this.roundOriginFeatureState = { ...this.snapshot.featureState };
    }
    const selectedBetMinor = selectSessionBet(
      session,
      this.snapshot.selectedBetMinor,
      this.hasOpenedSession,
    );
    const effectiveFeatureState = preserveFeatureProjection
      ? this.snapshot.featureState
      : session.featureState;
    this.snapshot = {
      ...this.snapshot,
      currency: session.currency,
      currencyExponent: session.currencyExponent,
      balanceMinor: session.balanceMinor,
      betOptionsMinor: session.betOptionsMinor,
      selectedBetMinor,
      featureState: effectiveFeatureState,
    };
    this.hasOpenedSession = true;
    if (showAttractGrid) {
      this.renderer.reels.setGrid(createAttractGrid(), {
        forceLockedVaultCells: ATTRACT_GRID_LOCKED_VAULT_CELLS,
      });
    }
    if (!preserveFeatureProjection) this.renderer.restoreFeatureState(this.snapshot.featureState);
    if (!preserveVisibleBalance) this.visibleBalanceMinor = session.balanceMinor;
    this.ui.applySession({
      ...session,
      balanceMinor: preserveVisibleBalance ? this.visibleBalanceMinor : session.balanceMinor,
      defaultBetMinor: this.snapshot.selectedBetMinor,
      featureState: effectiveFeatureState,
    });
    // 该标记只在经过协议解码、会话绑定并应用到玩家界面后发布。 / English: This tag is only released after protocol decoding, session binding, and application to the player interface.
    // 真实浏览器验收据此区分“入口已绘制”和“权威会话已实际生效”。 / English: Real browser validation distinguishes between "the entry has been drawn" and "the authoritative session has actually taken effect".
    if (this.root?.dataset) this.root.dataset.rgsSession = "online";
    if (this.launch.canEnterGame && !preserveFeatureProjection) this.syncGameMusic();

    if (this.machine.phase === "connecting" || this.machine.phase === "recovering") {
      this.machine.transition({ type: "SESSION_OPENED" });
      if (this.gateway.hasPendingSpin) this.machine.transition({ type: "SPIN_REQUESTED" });
    }
    this.launch.transition({ type: "SESSION_READY" });
    this.initialSessionResolver?.();
    this.initialSessionResolver = null;
    if (this.featurePreviewActive) this.ui.setFeaturePreviewEnabled(true);
    this.syncLaunchUi();
    this.refreshUi();
  }

  private acceptSessionMoneyBinding(session: SessionOpened): boolean {
    const current = this.sessionMoneyBinding;
    if (current !== null && current !== undefined
      && current.sessionId === session.sessionId
      && (current.currency !== session.currency
        || current.currencyExponent !== session.currencyExponent)) {
      // 在更新 snapshot、余额或任一 DOM 文本之前关闭传输与输入，禁止同一金额被重新解释。 / English: Turn off transfers and inputs before updating the snapshot, balance, or any DOM text, preventing the same amount from being reinterpreted.
      const error = new Error("Session money display binding changed");
      this.machine.transition({ type: "FATAL_ERROR" });
      this.gateway.close();
      this.completeLaunchFailure(playerFacingErrorFor(error, "launch"));
      return false;
    }
    this.sessionMoneyBinding = Object.freeze({
      sessionId: session.sessionId,
      currency: session.currency,
      currencyExponent: session.currencyExponent,
    });
    return true;
  }

  private handleSpinResult(
    result: SpinResult,
    recoveredOriginFeatureState?: Readonly<FeatureState>,
  ): void {
    // 网关保留未完成轮次的 ledger 供新会话恢复；旧页面不得消费迟到结果。 / English: The gateway retains ledgers from unfinished rounds for new sessions to resume; old pages must not consume late results.
    if (this.sessionTimedOut) return;
    this.markRgsResultDeliveryStage("callback");
    if (recoveredOriginFeatureState !== undefined) {
      this.bufferRecoveredSpinResult(result, recoveredOriginFeatureState);
      return;
    }
    this.acceptSpinResult(result);
  }

  private bufferRecoveredSpinResult(
    result: SpinResult,
    recoveredOriginFeatureState: Readonly<FeatureState>,
  ): void {
    if (result.roundId === this.lastRoundId) return;
    const buffered = this.bufferedRecoveredSpinResult ?? null;
    if (buffered !== null) {
    // 状态轮询和迟到的旋转响应可能汇合到同一个已提交轮次。 / English: Status polls and late rotation responses may converge into the same committed round.
    // 第一个缓冲的权威结果拥有唯一释放权。 / English: The first buffered authoritative result has exclusive release ownership.
      if (buffered.result.roundId === result.roundId) return;
      this.reportPlayerError(undefined, "unsolicited-result");
      return;
    }
    if (this.machine.phase !== "requesting") {
      this.reportPlayerError(undefined, "unsolicited-result");
      return;
    }

    // 在持久权威结果可以启动隐藏转轴生命周期或最终可见重放前，先将其冻结并验证。 / English: Persistent authoritative results are frozen and verified before they can initiate the hidden reel life cycle or final visible replay.
    // acceptSpinResult 中的第二道守卫仍是最终提交边界。 / English: The second guard in acceptSpinResult is still the final commit boundary.
    this.markRgsResultDeliveryStage("buffer-clone");
    const bufferedResult = immutableClone(result);
    const bufferedOriginFeatureState = immutableClone({
      ...recoveredOriginFeatureState,
    });
    this.markRgsResultDeliveryStage("buffer-validate");
    try {
      this.validateAuthoritativeSpinResult(bufferedResult, bufferedOriginFeatureState);
    } catch (error) {
      this.rejectSpinResult(error);
      return;
    }
    let needsVisualSpinStart = false;
    this.markRgsResultDeliveryStage("buffer-reel-guard");
    const reelSnapshot = this.reelRound.snapshot;
    if (reelSnapshot.state === "Idle") {
    // 整页持久恢复没有内存中的请求侧转轴生命周期。在启动界面真正离开前， / English: Full page persistent recovery without in-memory request side spindle lifetime. Before actually leaving the startup interface,
    // 只记录该工作，不推进像素所有的状态机。 / English: Only logs the work, does not advance the pixel's entire state machine.
      needsVisualSpinStart = true;
    } else if (reelSnapshot.state !== "Spinning"
      || reelSnapshot.roundId !== bufferedResult.roundId) {
      this.reportPlayerError(undefined, "unsolicited-result");
      return;
    }

    this.bufferedRecoveredSpinResult = {
      result: bufferedResult,
      originFeatureState: bufferedOriginFeatureState,
      needsVisualSpinStart,
    };
    this.markRgsResultDeliveryStage("buffer-release");
    this.releaseBufferedRecoveredSpinResult();
  }

  private releaseBufferedRecoveredSpinResult(): void {
    if (this.destroyed || !this.launch.canEnterGame) return;
    const buffered = this.bufferedRecoveredSpinResult ?? null;
    if (buffered === null) return;
    // 在调用表现代码前先消费，确保同步回调和重复网络投递无法二次释放该权威结果。 / English: Consume before calling the performance code to ensure that synchronous callbacks and repeated network delivery cannot release the authoritative result twice.
    this.bufferedRecoveredSpinResult = null;
    if (buffered.needsVisualSpinStart) {
      this.markRgsResultDeliveryStage("recovered-spin-start");
      try {
        this.reelRound.transition({
          type: "SPIN_ACCEPTED",
          roundId: buffered.result.roundId,
        });
        this.beginRecoveredSpinPresentation(buffered.result, buffered.originFeatureState);
        this.reelRound.transition({ type: "REELS_STARTED" });
      } catch (error) {
        this.rejectSpinResult(error);
        return;
      }
    }
    this.acceptSpinResult(buffered.result, buffered.originFeatureState);
  }

  private beginRecoveredSpinPresentation(
    result: Readonly<SpinResult>,
    originFeatureState: Readonly<FeatureState>,
  ): void {
    const reducedMotion = this.reducedMotionMedia?.matches ?? this.reducedMotion;
    this.stopPostWinIdleRepeat();
    this.observeRoundPresentationState("requested");
    // exchange 会话可能已投影提交后的轮次模式。持久重放必须先恢复重构的请求来源， / English: The exchange session may have projected post-commit round patterns. Persistent replay must first restore the reconstructed request source,
    // 避免恢复的 Free Spin 在 Base 机台上播放动画。 / English: Prevent resumed Free Spin from playing animation on Base machine.
    this.renderer.restoreFeatureState(originFeatureState);
    this.audio.beginBaseMusicRound?.(result.betMinor);
    this.roundOriginFeatureState = { ...originFeatureState };
    this.ui.resetWinCounter(
      originFeatureState.mode === "BASE"
        ? "0"
        : originFeatureState.freeSpinsWinMinor ?? "0",
    );
    this.scatterLandOrdinal = 0;
    this.pendingWheelAward = null;
    this.wheelQuickStopAccepted = false;
    this.wheelLandingInputBlocked = false;
    this.stops.markSpinStart();
    this.cancelScheduledFreeSpin();
    this.startRoundAudio(Promise.resolve(true), reducedMotion);
    this.renderer.beginSpinPresentation(reducedMotion);
    this.audio.startReelLoop({ intensity: 1, reducedMotion });
    this.ui.setSpinMode("waiting");
  }

  private acceptSpinResult(
    result: SpinResult,
    recoveredOriginFeatureState?: Readonly<FeatureState>,
  ): void {
    if (result.roundId === this.lastRoundId) return;
    if (this.machine.phase !== "requesting") {
      this.reportPlayerError(undefined, "unsolicited-result");
      return;
    }
    const previousFeatureState = {
      ...(recoveredOriginFeatureState
        ?? this.roundOriginFeatureState
        ?? this.snapshot.featureState),
    };
    let authoritativeRound;
    this.markRgsResultDeliveryStage("accept-validate");
    try {
      authoritativeRound = this.validateAuthoritativeSpinResult(result, previousFeatureState);
    } catch (error) {
      this.rejectSpinResult(error);
      return;
    }
    // v6 保留 nominal 审计 Win，即使整场 cap 已把其实际支付裁为 0；这些记录必须留在 / English: v6 retains nominal audit wins even if the entire cap has trimmed its actual payout to 0; these records must remain
    // 权威 result 中，但不得触发玩家可见的 Win 动画、音频或空闲重复。 / English: authoritative result, but must not trigger player-visible Win animations, audio, or idle repeats.
    const presentedWins = result.wins.filter((win) => BigInt(win.amountMinor) > 0n);
    // 校验通过后的第一条副作用就是启动事件资源租约；此时尚未进入 reel/feature/game / English: The first side effect after passing the verification is to start the event resource lease; at this time, reel/feature/game has not yet been entered
    // 状态转换。租约不参与结果选择，只与后续制作表现并行获取、校验和解码。 / English: state transition. The lease does not participate in the selection of results, but only obtains, verifies and decodes them in parallel with subsequent production performance.
    this.primeAuthoritativeFeatureAssetLeases(result, previousFeatureState);
    // 只有上述权威形状/来源守卫成功后，请求侧计数器减量才会永久生效。 / English: The request-side counter decrement will only take effect permanently after the above authoritative shape/source guard is successful.
    // 恢复的 Free Spins 和 Wheel 输入没有付费预留，因此这里对它们不执行任何操作。 / English: The restored Free Spins and Wheel inputs have no paid reservation, so no action is performed on them here.
    this.markRgsResultDeliveryStage("autoplay-finalize");
    this.ui?.finalizeAcceptedPaidAutoplaySpin?.();
    // 仅在服务端结果通过所有来源/形状守卫后，才快照四项 Auto Play 停止设置。 / English: Snapshot four Auto Play stop settings only after server-side results pass all source/shape guards.
    // 下方表现里程碑拥有实际停止权；结果解码绝不修改运行中的计数器。 / English: Performance milestones below have actual stopping rights; resulting decoding never modifies running counters.
    this.markRgsResultDeliveryStage("autoplay-arm");
    this.ui?.armAutoplayStopRound?.(result);
    this.activePresentationSequence = result.sequence;
    this.emitPresentationTrace({
      type: "result.accepted",
      sequence: result.sequence,
      roundId: result.roundId,
      totalWinMinor: result.totalWinMinor,
      balanceMinor: result.balanceMinor,
      winCount: presentedWins.length,
    });
    this.markRgsResultDeliveryStage("reel-transition");
    this.reelRound.transition({
      type: "RESULT_RECEIVED",
      roundId: authoritativeRound.roundId,
      rows: authoritativeRound.rows,
    });
    // 设置可以保持可交互，但一个已解码结果会从接收起直到所有顺序首次显示记录结束， / English: The setting can remain interactive, but a decoded result will be displayed from the time it is received until the first display of the record in all sequences.
    // 始终使用同一时钟配置。 / English: Always use the same clock configuration.
    const roundFastPlay = this.fastPlay === true;
    this.roundOriginFeatureState = null;
    this.markRgsResultDeliveryStage("feature-transition");
    const featureEnded = didFeatureModeEnd(previousFeatureState, result.featureState);
    this.lastRoundId = result.roundId;
    this.markRgsResultDeliveryStage("game-transition");
    this.machine.transition({ type: "SPIN_RESULT" });
    this.markRgsResultDeliveryStage("accepted");
    this.balanceVisibilityBlocked = true;
    this.observeRoundPresentationState("presenting");
    this.snapshot = {
      ...this.snapshot,
      balanceMinor: result.balanceMinor,
      selectedBetMinor: featureLockedBet(result.featureState, this.snapshot.selectedBetMinor),
      lastWinMinor: result.totalWinMinor,
      featureState: result.featureState,
      currentGrid: result.grid,
    };
    this.refreshUi();

    void this.presentations.enqueue(async () => {
      const featurePlan = createFeaturePresentationPlan(result.events);
      const presentationPhases = roundPresentationPhases(featurePlan.orderedEvents);
      const reducedMotion = this.reducedMotionMedia?.matches ?? this.reducedMotion;
      const vaultLandedEvent = featurePlan.orderedEvents.find((event) => (
        event.type === "vaults.landed"
      ));
      const featureAudioState: RoundFeatureAudioState = {
        rageLevel: previousFeatureState.rageLevel,
        wasFreeSpins: previousFeatureState.mode !== "BASE",
        vaultTeaseExtraHold: presentedWins.length === 0 && result.events.some((event) => (
          event.type === "vaults.locked"
        )),
        vaultCells: vaultLandedEvent?.type === "vaults.landed" ? vaultLandedEvent.cells : [],
        showFreeSpinSummary: result.events.some((event) => (
          event.type === "free_spins.completed"
          && shouldPresentFreeSpinSummary(event.cumulativeWinMinor, result.betMinor)
        )),
        hudState: freeSpinHudStateForPresentation(
          previousFeatureState,
          result.featureState,
          featurePlan.orderedEvents,
        ),
      };
      const freeSpinCompletion = featurePlan.orderedEvents.find((event) => (
        event.type === "free_spins.completed"
      ));
      const noSummaryConclusionMinor = featureEnded
        && freeSpinCompletion?.type === "free_spins.completed"
        && !featureAudioState.showFreeSpinSummary
        ? freeSpinCompletion.cumulativeWinMinor
        : null;
      this.activeRoundFeatureAudioState = featureAudioState;
      for (const event of featurePlan.beforeReels) {
        await this.observeFeatureEvent(event, async () => {
          const route = featureEventRoute(event);
          if (route.audio) this.presentFeatureAudio(event, reducedMotion, featureAudioState);
          if (route.environment) this.renderer.cueFeatureEnvironment(event, reducedMotion);
          await this.presentEffect(() => this.renderer.featureEffects.presentBeforeReels(event, reducedMotion));
        });
      }
      // 某些特性退出响应只携带较小的权威网格，没有 `grid.expanded` 事件。 / English: Some feature exit responses only carry the smaller authoritative grid, without the `grid.expanded` event.
      // 在 StopSequencer 提交行数前，通过同一套复刻收缩编排进行协调。 / English: Coordinate through the same set of replicated shrink orchestrations before the StopSequencer commits the rows.
      await this.presentEffect(() => this.renderer.reconcileReelRows(
        result.grid[0]?.length ?? this.renderer.reels.activeRows,
        reducedMotion,
      ));
      this.renderer.reels.prepareFeaturePresentation(featurePlan.orderedEvents);
      this.ui.setSpinMode("fast-stop");
      let roundAudioFinishedBeforeCheckpoint = false;
      let ordinaryWinStartBarrier: Promise<void> | null = null;
      try {
        await this.stops.present(result.grid, { fastPlay: roundFastPlay });
        this.assertRoundPresentationActive();
        this.renderer.finishSpinPresentation();
        this.emitPresentationTrace({
          type: "reels.settled",
          sequence: result.sequence,
        });
        // 普通 GameWinLogic START 拥有一个从语义上的末轴停止起计时的 300ms 栅栏。 / English: Normal GameWinLogic START owns a 300 ms fence timed from the semantic final-reel stop.
        // Result_Show 的首个 16ms 渲染帧在这段前置时间内运行，而不是再额外等待 300ms。 / English: The first 16ms render frame of Result_Show is run within this lead time, rather than waiting an additional 300ms.
        // Big Win 刻意没有前置栅栏：完整 Big Win 程序离开后，其普通视图才开始新的前置等待。 / English: Big Win deliberately has no leading fence; the normal view starts a fresh lead-in only after the full Big Win sequence exits.
        const settledWaysWinMinor = presentedWins.length > 0
          ? authoritativeWaysWinTotal(presentedWins)
          : "0";
        ordinaryWinStartBarrier = presentedWins.length > 0
          && this.createBigWinPlan(settledWaysWinMinor, result.betMinor) === null
          ? this.presentationDelay(300)
          : null;
        if (previousFeatureState.mode === "EXPANSION"
          && result.grid[0]?.length === 8
          && featurePlan.beforeReels.some((event) => (
            event.type === "grid.expanded" && event.rows === 8
          ))) {
          // 此处刻意位于物理停轴提交后，而不只是结构补间后，避免浏览器捕获时八行机台与 / English: This is deliberately located after the physical stop axis is submitted, not just after the structure tween, to avoid the eight-line machine and the browser capture
          // 仍在旋转的符号节点发生竞态。 / English: A race condition occurs on symbol nodes that are still rotating.
          this.finishRoundAudio();
          roundAudioFinishedBeforeCheckpoint = true;
          this.observePresentationMilestone("kong.rows-8-settled");
          await this.awaitSemanticPresentationCheckpoint("kong.rows-8-settled");
        }
      } catch (error) {
        if (!this.destroyed) this.renderer.cancelSpinPresentation();
        throw error;
      } finally {
        if (!this.destroyed) {
          if (!roundAudioFinishedBeforeCheckpoint) this.finishRoundAudio();
          this.ui.setSpinMode("waiting");
        }
      }
      // 即使没有 Wild/Rage 停轴退场流程，Result_Show 也至少获得一个渲染帧。 / English: Even without the Wild/Rage exit process, Result_Show gets at least one rendered frame.
      await this.presentationDelay(16);
      this.assertRoundPresentationActive();
      // 未中奖轮次仍会经过这个显式阶段；动画主体只是为空，完成过程仍具确定性。 / English: Unwinnable rounds will still go through this explicit stage; the animation body is just empty, and the completion process is still deterministic.
      this.reelRound.transition({ type: "WIN_PRESENTATION_STARTED" });
      // 官方 STOP_ANY 在 WIN 流程开始时求值，早于普通计数器、Big Win 或特性 Continue / English: Official STOP_ANY evaluates at the beginning of the WIN process, before normal counters, Big Win, or the feature Continue
      // 排入另一输入。 / English: Queue another input.
      this.ui?.reachAutoplayStopBoundary?.(result.sequence, "any-win");
      this.ui.beginResultPresentation(presentedWins.length > 0);
      const roundWaysWinMinor = presentedWins.length > 0
        ? authoritativeWaysWinTotal(presentedWins)
        : "0";
      this.audio.recordBaseMusicRoundOutcome?.(roundWaysWinMinor);
      if (previousFeatureState.mode !== "BASE" && result.featureState.mode !== "BASE") {
        this.renderer.updateFreeSpinHud(featureAudioState.hudState ?? result.featureState);
      }
      if (presentedWins.length > 0) {
        const waysWinMinor = roundWaysWinMinor;
        const freeSpinCompletion = result.events.find(
          (event) => event.type === "free_spins.completed",
        );
        const normalWinDisplayStart = previousFeatureState.mode === "BASE"
          ? "0"
          : previousFeatureState.freeSpinsWinMinor ?? "0";
        const normalWinDisplayTotal = previousFeatureState.mode === "BASE"
          ? waysWinMinor
          : result.featureState.mode !== "BASE"
            ? result.featureState.freeSpinsWinMinor ?? waysWinMinor
            : freeSpinCompletion?.type === "free_spins.completed"
              ? freeSpinCompletion.cumulativeWinMinor
              : waysWinMinor;
        const winPresentation = characterWinPresentation(
          previousFeatureState.mode,
          // PPS 只在这些已停网格中奖之后开始。因此触发它的 base 旋转在此处仍处于 / English: PPS only starts after winning on these stopped grids. So the base rotation that triggered it is still here
          // base 角色状态。 / English: base role status.
          previousFeatureState.mode,
        );
        const bigWinPlan = this.createBigWinPlan(waysWinMinor, result.betMinor);
        const bigWinMode = bigWinPlan !== null;
        if (bigWinPlan) {
          // 权威结果达到阈值后立即启动事件租约，使清单/大小/SHA-256 校验与制作好的 / English: Start the event lease immediately after the authoritative result reaches the threshold, so that the manifest/size/SHA-256 checksum is made
          // lead-in 重叠；它不参与阈值、金额或任何服务端状态决策。 / English: lead-in overlap; it does not participate in thresholds, amounts, or any server-side status decisions.
          const assetLease = this.beginBigWinAssetEventLease();
          try {
            await this.presentationDelay(
              reducedMotion ? 40 : BIG_WIN_CONTROLLER_LEAD_IN_MS,
            );
            this.bigWinInFreeSpins = previousFeatureState.mode !== "BASE";
            // 原始音乐控制器根据 Big Win START 时的模式确定此边界。因此终局 Free Spins 结果 / English: The original music controller determined this boundary based on the mode at Big Win START. So the final Free Spins result
            // 会短暂恢复 FS 循环；之后的 SUMMARY 事件拥有其 1.5s 退场。 / English: The FS loop will be briefly resumed; subsequent SUMMARY events have their 1.5s exit.
            this.bigWinMusicResume = previousFeatureState.mode !== "BASE"
              ? "free-spins"
              : "ambient";
            this.ui.showBigWinCongratulations();
            this.ui.setSpinMode("big-win-skip");
            try {
              await this.presentEffect(async () => {
                const verifiedArtwork = assetLease
                  ? bigWinVerifiedArtworkFromPackage((await assetLease.ready).package)
                  : undefined;
                // 租约保持到 Spine 解析、PNG 解码/采用、金币池初始化及整个展示结束； / English: The lease is maintained until Spine parsing, PNG decoding/adopting, coin pool initialization, and the entire display is completed;
                // BigWinView 不再对四项独占资源按 URL 二次加载。 / English: BigWinView no longer reloads four exclusive resources by URL.
                await this.renderer.bigWin.present(
                  bigWinPlan,
                  assetLease?.signal,
                  verifiedArtwork,
                );
              });
            } finally {
              if (!this.destroyed) this.ui.setSpinMode("waiting");
            }
          } finally {
            assetLease?.release();
          }
          await this.presentationDelay(reducedMotion ? 40 : 2_000);
          // 通用 WinLogic 只在完整 Big Win 处理器（包括叠层后的 2s 延迟）离开后 / English: Generic WinLogic only after leaving the full Big Win processor (including 2s delay after stacking)
          // 才发布 WIN_NO_COUNT。 / English: WIN_NO_COUNT was just released.
          this.ui.resetWinCounter(normalWinDisplayTotal);
        }

        // 当前 GameWinLogicController 只在 Big Win 完全离开后进入普通 WIN START， / English: Currently GameWinLogicController only enters normal WIN START after Big Win has completely left,
        // 然后等待与普通中奖相同的 300ms 前置时间。角色、Logo、框体和记录音效共用此边界； / English: Then wait for the same 300ms lead time as a normal jackpot. Characters, logos, frames and recorded sound effects share this boundary;
        // Big Win 已发布 WIN_NO_COUNT。 / English: Big Win has posted WIN_NO_COUNT.
        if (bigWinMode) {
          await this.presentationDelay(reducedMotion ? 40 : 300);
        } else {
          // Reduced Motion 改变制作好的播放速度，而不是此语义游戏状态边界。 / English: Reduced Motion changes the crafted playback speed rather than this semantic game state boundary.
          await (ordinaryWinStartBarrier ?? this.presentationDelay(300));
        }
        this.presentRoundWinCharacterAudio(winPresentation);
        const roundWinReaction = this.presentEffect(() => this.renderer.reactToWin(
          presentedWins,
          winPresentation,
        ));
        if (!bigWinMode) {
          if (isWinLossOrEqual(waysWinMinor, result.betMinor)) {
            this.audio.playWinLossOrEqual({ intensity: 1, reducedMotion });
          }
          const payout = planPayoutAudio(waysWinMinor, result.betMinor);
          if (payout) {
            this.audio.playPayoutWin(payout.level, {
              intensity: payout.intensity,
              reducedMotion,
            });
          }
        }

        this.normalWinPresentationActive = true;
        this.normalWinFinishRequested = false;
        this.ui.setSpinMode("normal-win-skip");
        let normalWinWasContinued = false;
        try {
          const counterDurationMs = normalWinCounterDurationMs(
            waysWinMinor,
            result.betMinor,
            roundFastPlay,
          ) ?? 0;
          // 同步调用记录表现器会在其 `visible` 里程碑前挂载 WinBox 和 WinLabel。 / English: Synchronous calls to the record presenter will mount WinBox and WinLabel before their `visible` milestone.
          // 随后该里程碑拥有符号表现和首次显示音频。只有在这段精确 START 调用栈之后， / English: The milestone then had a symbolic representation and an audio debut. Only after this precise START call stack,
          // 才启动聚合计数器。 / English: Only then start the aggregation counter.
          const normalRecordsPresentation = (async () => {
            for (const [index, win] of presentedWins.entries()) {
              const recordHoldDurationMs = primalWinRecordHoldDurationMs(win, {
                recordCount: presentedWins.length,
                counterDurationMs,
                postBigWin: bigWinMode,
                fastPlay: roundFastPlay,
              });
              // 单个普通记录路径在其自然 D 边界恢复符号。多记录所有权则保持常驻： / English: A single common recording path recovers symbols at its natural D boundaries. Multiple record ownership remains persistent:
              // 第六个参数告诉渲染器，此次隐藏是否为零延迟交接到下一条权威记录。 / English: The sixth parameter tells the renderer whether this hiding will be handed over to the next authoritative record with zero delay.
              const restoreSymbolsAtHoldBoundary = !bigWinMode
                && winPresentation === "base"
                && presentedWins.length === 1
                && !(Number.isSafeInteger(win.multiplier) && (win.multiplier ?? 0) > 1);
              await this.presentEffect(() => this.renderer.winCelebration.present(
                [win],
                reducedMotion,
                recordHoldDurationMs,
                (milestone, record, resident) => {
                  if (milestone === "visible") {
                    this.renderer.reels.highlight([...win.cells]);
                    // 每条无路径记录都从通用 ScatterWin 开始。随后 Rage/Vault/未知符号 / English: Every win record without a path begins with generic ScatterWin. Rage, Vault, and unknown symbols then
                    // 解析到静默 LpWin 回退路径，而不是重复 MP2。 / English: Resolve to silent LpWin fallback path instead of repeating MP2.
                    this.audio.playSymbolWin("scatter-win", {
                      intensity: 1,
                      reducedMotion,
                    });
                    const symbolTier = symbolWinTierFor(win, result.grid);
                    if (symbolTier) {
                      this.audio.playSymbolWin(symbolTier, {
                        intensity: 1,
                        reducedMotion,
                      });
                    }
                  }
                  if (!this.presentationObserver?.onPresentationTrace) return;
                  const residentTrace = resident === undefined
                    ? {}
                    : { resident: Object.freeze({ ...resident }) };
                  const trace = Object.freeze({
                    type: `win-record.${milestone}`,
                    sequence: result.sequence,
                    index,
                    count: presentedWins.length,
                    id: record.id,
                    symbol: record.symbol,
                    amountMinor: record.amountMinor,
                    multiplier: record.multiplier,
                    ...residentTrace,
                  } as const satisfies AppPresentationTrace);
                  this.emitPresentationTrace(trace);
                  return this.requestPresentationCheckpoint({
                    type: "presentation-trace",
                    trace,
                  });
                },
                restoreSymbolsAtHoldBoundary,
                index < presentedWins.length - 1,
              ));
              if (this.normalWinFinishRequested) break;
            }
          })();
          const normalCounterPresentation = bigWinMode
            // Big Win 已通过 WIN_NO_COUNT 发布最终值。通用普通阶段只保留其自然的 500ms 外尾段。 / English: Big Win has posted the final value via WIN_NO_COUNT. The generic normal phase retains only its natural outer 500ms tail.
            ? this.normalWinDelay(NORMAL_WIN_COUNTER_TAIL_HOLD_MS)
            : this.presentObservedNormalWinCounter(
                result.sequence,
                waysWinMinor,
                result.betMinor,
                reducedMotion,
                normalWinDisplayTotal,
                normalWinDisplayStart,
                roundFastPlay,
              );
          await Promise.all([
            roundWinReaction,
            normalCounterPresentation,
            normalRecordsPresentation,
          ]);
        } finally {
          normalWinWasContinued = this.normalWinFinishRequested;
          this.normalWinDelayResolver = null;
          this.normalWinPresentationActive = false;
          this.normalWinFinishRequested = false;
          this.renderer.reels.clearHighlights();
          if (!this.destroyed) this.ui.setSpinMode("waiting");
        }
        if (normalWinWasContinued) {
          this.emitPresentationTrace({
            type: "normal-win.logical-done",
            sequence: result.sequence,
          });
          await this.requestPresentationCheckpoint({
            type: "normal-win.logical-done",
            sequence: result.sequence,
          });
        }
      }
      // 停轴后的 Rage/Wheel/Vault/Free Spins 表现归宏观游戏状态所有，而非转轴运动生命周期。 / English: The performance of Rage/Wheel/Vault/Free Spins after the reels are stopped belongs to the macro game state, not the reel movement life cycle.
      this.reelRound.transition({ type: "ROUND_COMPLETE" });
      if (presentedWins.length > 0 && presentationPhases.postWinEvents.length > 0) {
        await this.presentationDelay(reducedMotion ? 40 : 350);
      }
      await this.presentPostReelFeatureEvents(
        presentationPhases.postWinEvents,
        result.featureState,
        reducedMotion,
        featureAudioState,
      );
      if (previousFeatureState.mode !== "BASE" && result.featureState.mode !== "BASE") {
        // 最终响应位于 SPINEND 之后。只有当每个排队的奖励/CAP 命令都针对轮次前投影呈现后， / English: The final response comes after SPINEND. Only after each queued reward/CAP command has been rendered for pre-round projection,
        // 才应用它。 / English: Just apply it.
        featureAudioState.hudState = { ...result.featureState };
        this.renderer.updateFreeSpinHud(result.featureState);
      }
      await this.presentPostReelFeatureEvents(
        presentationPhases.summaryEvents,
        result.featureState,
        reducedMotion,
        featureAudioState,
      );
      this.applyResultAtBalanceBarrier(result);
      if (featureEnded) {
        if (presentationPhases.summaryEvents.length === 0) {
          this.beginFreeSpinsExitOnce(featureAudioState, reducedMotion);
          this.audio.setFreeSpinsMusicEnabled(false, { intensity: 1, reducedMotion }, false);
        } else if (!featureAudioState.featureExitStarted) {
          // 装饰性故障可能漏掉制作好的隐藏开始回调。同一个幂等接缝作为回退恰好恢复 Base 一次。 / English: Cosmetic glitches may miss crafted hidden start callbacks. The same idempotent seam as fallback restores Base exactly once.
          this.beginFreeSpinsExitOnce(featureAudioState, reducedMotion);
        }
        await this.presentEffect(() => this.renderer.exitFeatureMode(result.featureState, reducedMotion));
      }
      this.audio.endBaseMusicRound?.();
      this.machine.transition({ type: "PRESENTATION_COMPLETE" });
      // 真实 RGS 在此 ACK 前始终保持 hasPendingSpin=true。 / English: True RGS always holds hasPendingSpin=true until this ACK.
      // 投影最终就绪 UI 前清除该权威待处理状态。 / English: Clear this authoritative pending state before projecting the final ready UI.
      this.acknowledgePresentedSpinResult(result);
      this.releaseCompletedFeatureAssetLeases(result);
      this.refreshUi();
      this.schedulePostWinIdleRepeat(result, previousFeatureState, reducedMotion, roundFastPlay);
      this.activeRoundFeatureAudioState = null;
      if (noSummaryConclusionMinor !== null) {
        this.ui.showFreeSpinConclusion?.(noSummaryConclusionMinor);
      }
      this.observeRoundPresentationState("complete");
      this.emitPresentationTrace({
        type: "round.complete",
        sequence: result.sequence,
      });
      this.ui?.completeAutoplayStopRound?.(result.sequence);
      if (this.activePresentationSequence === result.sequence) {
        this.activePresentationSequence = null;
      }
    }).catch((error: unknown) => {
      // SESSION_TIMEOUT 把旧轮次 ledger 留给新会话恢复；取消异常不是“表现失败”， / English: SESSION_TIMEOUT Leave the old round ledger to the new session for recovery; the cancellation exception is not a "performance failure",
      // 绝不能在终态后补 applyResult、ACK、toast 或状态机完成事件。 / English: Never append applyResult, ACK, toast or state machine completion events to the final state.
      if (this.destroyed || this.sessionTimedOut
        || error instanceof RoundPresentationCancelledError) return;
      this.activeRoundFeatureAudioState = null;
      this.audio.endBaseMusicRound?.();
      this.stopRoundAudio(35);
      this.renderer.cancelSpinPresentation();
      // 表现故障不能让 HUD 或机台落后于已接受的权威经济状态/结果投影。 / English: Performance glitches cannot cause the HUD or machine to lag behind the accepted authoritative economy state/result projection.
      try {
        // 终局 Free Spins 结果可能在普通总结隐藏接缝前失败。先恢复已接受模式， / English: Endgame Free Spins results may fail before normal summary hidden seams. Restore the accepted mode first,
        // 避免 Character、背景和 HUD 仍归已放弃的特性表现所有。 / English: Prevent Character, background, and HUD from remaining owned by the abandoned feature representation.
        this.renderer.restoreFeatureState(result.featureState);
      } catch {
        // 下方网格/经济状态恢复仍独立保持故障关闭。 / English: The underlying grid/economy state recovery remains independently maintained with the fault closed.
      }
      try {
        this.renderer.reels.setGrid(result.grid);
        if (result.featureState.mode !== "BASE") {
          this.renderer.updateFreeSpinHud(result.featureState);
        }
      } catch {
        // 下方 UI 余额/结果投影仍必须完成。 / English: The lower UI balance/result projection must still be completed.
      }
      this.applyResultAtBalanceBarrier(result);
      this.reelRound.reset("presentation-failed");
      this.ui.clearWheelBonusRoundSummary?.();
      this.reportPlayerError(error, "presentation");
      if (this.machine.phase === "presenting") this.machine.transition({ type: "PRESENTATION_COMPLETE" });
      this.acknowledgePresentedSpinResult(result);
      this.releaseCompletedFeatureAssetLeases(result);
      this.refreshUi();
      this.observeRoundPresentationState("failed");
      this.ui?.completeAutoplayStopRound?.(result.sequence);
      if (this.activePresentationSequence === result.sequence) {
        this.activePresentationSequence = null;
      }
    });
  }

  private acknowledgePresentedSpinResult(result: Readonly<SpinResult>): void {
    const gateway = this.gateway;
    if (!gateway?.acknowledgeSpinResult) return;
    try {
      const acknowledged = gateway.acknowledgeSpinResult(
        result.roundId,
        result.sequence,
      );
      if (acknowledged === false) {
        this.reportPlayerError(undefined, "acknowledgement");
      }
    } catch (error) {
      this.reportPlayerError(error, "acknowledgement");
    }
  }

  private validateAuthoritativeSpinResult(
    result: SpinResult,
    originFeatureState: Readonly<FeatureState>,
  ): ReturnType<typeof authoritativeReelRoundFromV1> {
    const authoritativeRound = authoritativeReelRoundFromV1(result);
    validateSpinResultAgainstOrigin(originFeatureState, result);
    return authoritativeRound;
  }

  private rejectSpinResult(error: unknown): void {
    this.markRgsResultDeliveryStage("rejecting");
    this.ui.rollbackAcceptedPaidAutoplaySpin?.();
    this.roundOriginFeatureState = null;
    this.stopRoundAudio(35);
    this.renderer.cancelSpinPresentation();
    this.reelRound.reset("malformed-authoritative-round");
    this.reportPlayerError(error, "round-result");
    this.machine.transition({ type: "SPIN_FAILED" });
    this.observeRoundPresentationState("failed");
    this.refreshUi();
    this.markRgsResultDeliveryStage("rejected");
  }

  private async presentPostReelFeatureEvent(
    event: FeatureEvent,
    featureState: FeatureState,
    reducedMotion: boolean,
    audioState: RoundFeatureAudioState,
  ): Promise<void> {
    await this.observeFeatureEvent(event, () => this.presentPostReelFeatureEventBody(
      event,
      featureState,
      reducedMotion,
      audioState,
    ));
  }

  private async presentPostReelFeatureEventBody(
    event: FeatureEvent,
    featureState: FeatureState,
    reducedMotion: boolean,
    audioState: RoundFeatureAudioState,
  ): Promise<void> {
    const artworkKind = event.type === "wheel.started" || event.type === "wheel.awarded"
      ? "wheel"
      : event.type === "free_spins.started"
        || event.type === "free_spin.awarded"
        || event.type === "free_spin.cap_reached"
        || event.type === "free_spins.completed"
        ? "free-spins"
        : null;
    const featureArtworkReady = artworkKind
      ? await this.awaitVerifiedFeatureArtwork(artworkKind)
      : true;
    const activeSequence = this.activePresentationSequence;
    // BONUSWIN 与 FREESPIN_INTRO 是独立复刻的控制器边界。在任一制作好的特性可以显示 / English: BONUSWIN and FREESPIN_INTRO are independently forked controller boundaries. Any created feature can be displayed
    // （或自动消费）其 Continue 控件前，停止外层付费 Auto Play 运行。 / English: (or automatically consume) its Continue control, stop the outer paid Auto Play from running.
    if (activeSequence !== null) {
      if (event.type === "wheel.started") {
        this.ui?.reachAutoplayStopBoundary?.(activeSequence, "bonus");
      } else if (event.type === "free_spins.started") {
        this.ui?.reachAutoplayStopBoundary?.(activeSequence, "free-spins");
      } else if ((event.type === "vault.unlocked"
          || event.type === "vault.upgraded"
          || event.type === "vault.awarded")
        && parseJackpotTier(event.prize)) {
        // 分组 Vault 变更通常在下方共享批次开始处到达这里。此回退也涵盖有效的独立奖励。 / English: Grouped vault changes typically arrive here at the beginning of the shared batch below. This fallback also covers valid independent awards.
        this.ui?.reachAutoplayStopBoundary?.(activeSequence, "jackpot");
      }
    }
    if (event.type === "free_spins.completed"
      && !audioState.showFreeSpinSummary) {
      // 制作好的 HUD 在此边界已提交 8/8。等待 Base 退出时， / English: The finished HUD has been submitted 8/8 at this boundary. While waiting for Base to exit,
      // 让其辅助 DOM 镜像保持在同一个已接受事件上。 / English: Keep its secondary DOM image on the same accepted event.
      this.ui.showFreeSpinsCompletedState?.(event);
      if (activeSequence !== null
        && this.presentationObserver?.onPresentationCheckpoint) {
        // 夹具/调试观察会在无总结跳过退场开始恢复 Base 前冻结已接受的终局事件。 / English: Fixture/Debug Observation freezes accepted endgame events before initiating Base recovery without summary skip exit.
        // 没有观察者时，此分支不执行 await，生产时间线保持不变。 / English: When there are no observers, this branch does not execute await and the production timeline remains unchanged.
        await this.awaitPresentationCheckpoint({
          type: "free-spins-completed-active",
          sequence: activeSequence,
          mode: event.mode,
          awarded: event.awarded,
          cumulativeWinMinor: event.cumulativeWinMinor,
        });
      }
    }
    const route = featureEventRoute(event);
    if (event.type === "vaults.upgrade.started"
      && audioState.wasFreeSpins
      && audioState.vaultCells.length > 0) {
      // 每个原始 _thumpUpgrades 阶段都启动自己的 1s 预告，并预告当前所有已打开 Vault， / English: Each primitive _thumpUpgrades stage starts its own 1s preview, and previews all currently open vaults,
      // 而不仅是数值变化的格子。 / English: Not just a grid of numerical changes.
      this.audio.playVaultAnticipation({ intensity: 1, reducedMotion });
      await this.presentEffect(() => this.renderer.featureEffects.presentVaultTease(
        { cells: audioState.vaultCells },
        reducedMotion,
        false,
      ));
    }
    // grid.expanded 已在物理停轴前呈现。 / English: grid.expanded is rendered before the physical stop axis.
    if (event.type !== "grid.expanded") {
      if (route.audio) this.presentFeatureAudio(event, reducedMotion, audioState);
      if (route.environment) this.renderer.cueFeatureEnvironment(event, reducedMotion);
    }
    if (event.type === "vaults.landed" && audioState.wasFreeSpins) {
      this.audio.playVaultAnticipation({ intensity: 1, reducedMotion });
      await this.presentEffect(() => this.renderer.featureEffects.presentVaultTease(
        event,
        reducedMotion,
        audioState.vaultTeaseExtraHold,
      ));
    }
    if (event.type === "free_spin.awarded") {
      await this.presentFreeSpinAwardBatch([event], featureState, reducedMotion, audioState);
    } else if (event.type === "free_spin.cap_reached" && featureArtworkReady) {
      await this.presentEffect(() => this.renderer.presentFreeSpinCap(
        event,
        audioState.hudState ?? featureState,
      ));
    } else if (featureArtworkReady && route.visual !== "none"
      && (event.type !== "free_spins.completed" || audioState.showFreeSpinSummary)) {
      await this.presentEffect(() => this.renderer.featureEffects.presentAfterReels(event, reducedMotion));
    }
    if (event.type === "wheel.awarded" && this.pendingWheelAward === event) {
      // presentEffect 刻意吸收装饰性故障。若 Wheel 从未到达落地回调，则关闭等待循环并丢弃 / English: presentEffect deliberately absorbs decorative glitches. If the Wheel never reaches the landing callback, close the waiting loop and discard
      // 两个隐藏奖励投影，避免它们泄漏到 Base 玩法中。 / English: Two hidden bonus projections to prevent them from leaking into Base gameplay.
      this.renderer.abortWheelPresentation();
      this.presentFeaturePresentationMilestone("wheel.spin-abort");
    }
    if (event.type === "free_spins.completed") {
      if (!audioState.showFreeSpinSummary) {
        // endSkipOutroHandler 在同一帧派发 FREESPIN_END 并启动计数器跳过退场； / English: endSkipOutroHandler dispatches FREESPIN_END in the same frame and starts the counter to skip exit;
        // 不要把 Base 恢复推迟到制作好的 400ms HUD 隐藏完成之后。 / English: Don't delay base recovery until after the crafted 400ms HUD hide is complete.
        this.beginFreeSpinsExitOnce(audioState, reducedMotion);
      }
      // 有总结时，其隐藏开始回调已启动同一个 HUD 退场。 / English: There is a HUD exit with the same HUD exit whose hidden start callback has been initiated.
      // FreeSpinHudView 会合并重复隐藏请求。 / English: FreeSpinHudView merges and repeats hide requests.
      await this.presentEffect(() => this.renderer.hideFreeSpinHud());
    }
    if (event.type === "free_spins.started") {
      audioState.hudState = { ...featureState };
      if (featureArtworkReady) {
        await this.presentEffect(() => this.renderer.showFreeSpinHud(featureState));
      }
    }
    if (event.type === "wheel.awarded") {
      this.renderer.completeWheelPresentation(featureState);
      this.wheelLandingInputBlocked = false;
      this.wheelQuickStopAccepted = false;
    }
    if (route.announce) await this.ui.announceEvent(event, reducedMotion ? 40 : 620);
  }

  private async observeFeatureEvent(
    event: FeatureEvent,
    presentation: () => Promise<void>,
  ): Promise<void> {
    const observer = this.presentationObserver;
    if (!observer?.onFeatureEvent) {
      await presentation();
      return;
    }
    const observedEvent = immutableClone(event) as Readonly<FeatureEvent>;
    this.activeObservedFeatureEvents.push(observedEvent);
    this.notifyFeatureEvent(observedEvent.type, observedEvent);
    try {
      await presentation();
    } finally {
      const index = this.activeObservedFeatureEvents.lastIndexOf(observedEvent);
      if (index >= 0) this.activeObservedFeatureEvents.splice(index, 1);
      if (!this.destroyed) {
        const previous = this.activeObservedFeatureEvents.at(-1) ?? null;
        this.notifyFeatureEvent(previous?.type ?? null, previous);
      }
    }
  }

  private async presentPostReelFeatureEvents(
    events: readonly FeatureEvent[],
    featureState: FeatureState,
    reducedMotion: boolean,
    audioState: RoundFeatureAudioState,
  ): Promise<void> {
    const deferredVaultAwards: VaultAwardedEvent[] = [];
    for (let index = 0; index < events.length;) {
      const event = events[index];
      if (!event) break;
      if (event.type === "vaults.unlock.started") {
        await this.presentPostReelFeatureEvent(event, featureState, reducedMotion, audioState);
        const relativeCompletionIndex = events.slice(index + 1).findIndex((candidate) => (
          candidate.type === "vaults.unlock.completed"
        ));
        if (relativeCompletionIndex < 0) {
          index += 1;
          continue;
        }
        const completionIndex = index + 1 + relativeCompletionIndex;
        const groupMembers = events.slice(index + 1, completionIndex);
        const unlocks = groupMembers.filter(
          (member): member is VaultUnlockedEvent => member.type === "vault.unlocked",
        );
        deferredVaultAwards.push(...groupMembers.filter(
          (member): member is VaultAwardedEvent => member.type === "vault.awarded",
        ));
        const freeSpinAwards = groupMembers.filter(
          (member): member is FreeSpinAwardedEvent => member.type === "free_spin.awarded",
        );
        if (featureState.mode === "BASE"
          && unlocks.length === 1
          && this.vaultUnlockCaptureEnabled
          && this.presentationObserver?.onPresentationCheckpoint) {
          const addresses = unlocks.map(({ reel, row }) => ({ reel, row }));
          this.renderer.reels.setSymbolPlaybackPaused(addresses, true);
          try {
            await this.requestVaultUnlockPresentationCheckpoint(
              "vault-unlock.locked",
              unlocks[0]!,
            );
          } finally {
            this.renderer.reels.setSymbolPlaybackPaused(addresses, false);
          }
        }
        // handleJackpotWin 与每个 unlock_backup 片段在同一个变更开始帧派发， / English: handleJackpotWin is dispatched at the same change start frame as each unlock_backup fragment,
        // 而不是在 1.5s 揭示栅栏之后。 / English: Instead of 1.5s after the fence is revealed.
        if (unlocks.some((event) => parseJackpotTier(event.prize))) {
          const sequence = this.activePresentationSequence;
          if (sequence !== null) {
            this.ui?.reachAutoplayStopBoundary?.(sequence, "jackpot");
          }
        }
        this.renderer.highlightVaultMutationBatch?.(unlocks);
        await Promise.all(unlocks.map((member) => this.presentPostReelFeatureEvent(
          member,
          featureState,
          reducedMotion,
          audioState,
        )));
        for (const member of groupMembers) {
          if (member.type === "vault.unlocked"
            || member.type === "vault.awarded"
            || member.type === "free_spin.awarded"
            || member.type === "free_spin.cap_reached") continue;
          await this.presentPostReelFeatureEvent(member, featureState, reducedMotion, audioState);
        }
        if (freeSpinAwards.length > 0) {
          await this.observeFeatureEvent(freeSpinAwards[0]!, () => (
            this.presentFreeSpinAwardBatch(
              freeSpinAwards,
              featureState,
              reducedMotion,
              audioState,
            )
          ));
        }
        for (const member of groupMembers) {
          if (member.type !== "free_spin.cap_reached") continue;
          await this.presentPostReelFeatureEvent(member, featureState, reducedMotion, audioState);
        }
        await this.presentPostReelFeatureEvent(
          events[completionIndex]!,
          featureState,
          reducedMotion,
          audioState,
        );
        this.observePresentationMilestone("vault.mutation-barrier-complete");
        index = completionIndex + 1;
        continue;
      }
      if (event.type === "vaults.upgrade.started") {
        await this.presentPostReelFeatureEvent(event, featureState, reducedMotion, audioState);
        const upgrades: VaultUpgradedEvent[] = [];
        let cursor = index + 1;
        while (true) {
          const candidate = events[cursor];
          if (!candidate || candidate.type !== "vault.upgraded"
            || candidate.step !== event.step) break;
          upgrades.push(candidate);
          cursor += 1;
        }
        const upgradedCells = new Set(upgrades.map((upgrade) => (
          `${"reel" in upgrade ? upgrade.reel : -1}:${"row" in upgrade ? upgrade.row : -1}`
        )));
        while (true) {
          const award = events[cursor];
          if (!award || award.type !== "vault.awarded") break;
          const key = `${award.reel}:${award.row}`;
          if (!upgradedCells.has(key)) break;
          deferredVaultAwards.push(award);
          cursor += 1;
        }
        // Jackpot 高亮随批次开始，但权威派彩面板/音频会推迟到所有变更栅栏结束后。 / English: Jackpot highlighting starts with the batch, but authoritative payout panels/audio are deferred until after all change fences have ended.
        if (upgrades.some((event) => parseJackpotTier(event.prize))) {
          const sequence = this.activePresentationSequence;
          if (sequence !== null) {
            this.ui?.reachAutoplayStopBoundary?.(sequence, "jackpot");
          }
        }
        this.renderer.highlightVaultMutationBatch?.(upgrades);
        await Promise.all(upgrades.map((member) => (
          this.presentPostReelFeatureEvent(
            member,
            featureState,
            reducedMotion,
            audioState,
          )
        )));
        this.observePresentationMilestone("vault.mutation-barrier-complete");
        index = cursor;
        continue;
      }
      if (event.type !== "vault.unlocked") {
        if (event.type === "vault.awarded") {
          deferredVaultAwards.push(event);
          index += 1;
          continue;
        }
        if (event.type === "free_spin.awarded") {
          const awards: FreeSpinAwardedEvent[] = [];
          while (events[index]?.type === "free_spin.awarded") {
            awards.push(events[index] as FreeSpinAwardedEvent);
            index += 1;
          }
          await this.observeFeatureEvent(awards[0]!, () => (
            this.presentFreeSpinAwardBatch(
              awards,
              featureState,
              reducedMotion,
              audioState,
            )
          ));
          continue;
        }
        await this.presentPostReelFeatureEvent(event, featureState, reducedMotion, audioState);
        index += 1;
        continue;
      }

      // GameVaultsFeature 同时启动解锁组的每个成员；串行等待每个备用片段会给每个 Vault / English: GameVaultsFeature Starts each member of the unlock group simultaneously; waiting serially for each alternate fragment will give each Vault
      // 虚增 0.8s。 / English: False increase of 0.8s.
      const unlocks: FeatureEvent[] = [];
      while (events[index]?.type === "vault.unlocked") {
        unlocks.push(events[index]!);
        index += 1;
      }
      await Promise.all(unlocks.map((unlock) => this.presentPostReelFeatureEvent(
        unlock,
        featureState,
        reducedMotion,
        audioState,
      )));
      this.observePresentationMilestone("vault.mutation-barrier-complete");
    }
    // 原始 processData 只在所有解锁/升级轨道越过共享阶段栅栏后收集最终 Vault 派彩。 / English: The original processData only collects the final Vault payout after all unlock/upgrade tracks have crossed the shared stage fence.
    for (const award of deferredVaultAwards) {
      await this.presentPostReelFeatureEvent(
        award,
        featureState,
        reducedMotion,
        audioState,
      );
    }
    if (deferredVaultAwards.length > 0
      && this.presentationObserver?.onPresentationCheckpoint) {
      await this.awaitPresentationCheckpoint({
        type: "vault-awards-complete",
        count: deferredVaultAwards.length,
      });
    }
  }

  private async presentFreeSpinAwardBatch(
    events: readonly FreeSpinAwardedEvent[],
    featureState: FeatureState,
    reducedMotion: boolean,
    audioState: RoundFeatureAudioState,
  ): Promise<void> {
    if (events.length === 0) return;
    const previousHudState = audioState.hudState ?? featureState;
    const count = events.reduce((total, event) => total + event.count, 0);
    const eventHudState: FeatureState = previousHudState.mode === "BASE"
      ? { ...featureState }
      : {
          ...previousHudState,
          freeSpinsRemaining: previousHudState.freeSpinsRemaining + count,
        };
    audioState.hudState = eventHudState;
    this.audio.playVaultFly({ intensity: 1, reducedMotion });
    await this.presentEffect(() => this.renderer.presentFreeSpinAwardBatch(
      events,
      eventHudState,
      reducedMotion,
    ));
    if (featureState.mode === "EXPANSION") {
      await this.awaitSemanticPresentationCheckpoint("kong.retrigger-applied");
    }
  }

  private applyResultAtBalanceBarrier(result: SpinResult): void {
    const balanceMinor = this.snapshot.balanceMinor;
    this.balanceVisibilityBlocked = false;
    this.visibleBalanceMinor = balanceMinor;
    this.ui.applyResult(balanceMinor === result.balanceMinor
      ? result
      : { ...result, balanceMinor });
    this.emitPresentationTrace({
      type: "balance.committed",
      sequence: result.sequence,
      balanceMinor,
    });
  }

  private async presentEffect(effect: () => Promise<void>): Promise<void> {
    this.assertRoundPresentationActive();
    try {
      await effect();
    } catch (error) {
      if (this.destroyed || this.sessionTimedOut
        || error instanceof RoundPresentationCancelledError) {
        throw new RoundPresentationCancelledError();
      }
      // 装饰性故障绝不能阻止权威网格和余额达到已结算表现状态。 / English: Cosmetic glitches must not prevent authority grids and balances from reaching settled performance status.
      this.reportPlayerError(error, "feature-presentation");
    }
    this.assertRoundPresentationActive();
  }

  private beginBigWinAssetEventLease(): StreamingAssetEventLease | null {
    const source = this.streamingAssets;
    const acquirePackage = source?.acquirePackage;
    const packageId = this.bigWinAssetPackageId;
    if (!acquirePackage || !packageId) return null;
    try {
      if (source.diagnostics().mode === "off") return null;
    } catch {
      // 格式错误的嵌入式诊断端口退回现有 BigWinView 直接加载；不得中断结果表现。 / English: Malformed embedded diagnostic port falls back to existing BigWinView direct loading; MUST NOT interrupt result performance.
      return null;
    }
    return beginStreamingAssetEventLease({
      acquirePackage: (id, signal) => acquirePackage.call(source, id, signal),
    }, packageId);
  }

  private primeAuthoritativeFeatureAssetLeases(
    result: Readonly<SpinResult>,
    previousFeatureState: Readonly<FeatureState>,
  ): void {
    const events = result.events;
    const needsFreeSpins = previousFeatureState.mode !== "BASE"
      || result.featureState.mode !== "BASE"
      || events.some((event) => event.type === "free_spins.started"
        || event.type === "free_spin.awarded"
        || event.type === "free_spin.cap_reached"
        || event.type === "free_spins.completed");
    if (needsFreeSpins) this.ensureFeatureAssetEventLease("free-spins");
    if (events.some((event) => event.type === "wheel.started" || event.type === "wheel.awarded")) {
      this.ensureFeatureAssetEventLease("wheel");
    }
  }

  private ensureFeatureAssetEventLease(kind: "free-spins" | "wheel"): void {
    if (kind === "free-spins" ? this.freeSpinsAssetLease : this.wheelAssetLease) return;
    // 旧嵌入式/确定性宿主可能只实现历史 PixiRenderer 表面；它们继续使用组件自身 / English: Old embedded/deterministic hosts may only implement the historical PixiRenderer surface; they continue to use the component itself
    // 的按需 URL 回退，不能因为缺少新消费者端口而向宿主 origin 请求生产清单。 / English: On-demand URL fallback, production manifests cannot be requested from the host origin due to lack of a new consumer port.
    if (typeof this.renderer?.adoptVerifiedFeatureArtwork !== "function") return;
    const source = this.streamingAssets;
    const acquirePackage = source?.acquirePackage;
    if (!acquirePackage) return;
    try {
      if (source.diagnostics().mode === "off") return;
    } catch {
      return;
    }
    const packageId = kind === "free-spins"
      ? this.freeSpinsAssetPackageId
      : this.wheelAssetPackageId;
    const lease = beginStreamingAssetEventLease({
      acquirePackage: (id, signal) => acquirePackage.call(source, id, signal),
    }, packageId);
    const ready = lease.ready.then((acquired) => this.renderer.adoptVerifiedFeatureArtwork(
      kind,
      acquired.package,
      lease.signal,
    ));
    // 获取在前置时间内并行运行；真正的事件边界仍 await 同一个 Promise。提前登记拒绝 / English: Gets run in parallel with lead time; the actual event bounds still await the same Promise. Rejection of advance registration
    // 观察者，避免弱网/完整性失败成为 unhandledrejection。 / English: Observer to avoid weak network/integrity failures becoming unhandledrejection.
    void ready.catch(() => undefined);
    if (kind === "free-spins") {
      this.freeSpinsAssetLease = lease;
      this.freeSpinsArtworkReady = ready;
    } else {
      this.wheelAssetLease = lease;
      this.wheelArtworkReady = ready;
    }
  }

  private async awaitVerifiedFeatureArtwork(
    kind: "free-spins" | "wheel",
  ): Promise<boolean> {
    const ready = kind === "free-spins"
      ? this.freeSpinsArtworkReady
      : this.wheelArtworkReady;
    // 显式 off/旧宿主保留原有按需 URL 回退；生产默认 on-demand 会走验证包。 / English: Explicitly off/the old host retains the original on-demand URL fallback; the production default on-demand will use the verification package.
    if (!ready) return true;
    try {
      await ready;
      return true;
    } catch (error) {
      if (this.destroyed || this.sessionTimedOut
        || error instanceof RoundPresentationCancelledError) {
        throw new RoundPresentationCancelledError();
      }
      this.reportPlayerError(error, "feature-presentation");
      return false;
    }
  }

  private releaseFeatureAssetEventLease(kind: "free-spins" | "wheel"): void {
    const lease = kind === "free-spins" ? this.freeSpinsAssetLease : this.wheelAssetLease;
    if (kind === "free-spins") {
      this.freeSpinsAssetLease = null;
      this.freeSpinsArtworkReady = null;
    } else {
      this.wheelAssetLease = null;
      this.wheelArtworkReady = null;
    }
    lease?.release();
    if (typeof this.renderer?.releaseVerifiedFeatureArtwork === "function") {
      this.renderer.releaseVerifiedFeatureArtwork(kind);
    }
  }

  private releaseCompletedFeatureAssetLeases(result: Readonly<SpinResult>): void {
    if (this.wheelAssetLease && result.events.some((event) => (
      event.type === "wheel.started" || event.type === "wheel.awarded"
    ))) {
      this.releaseFeatureAssetEventLease("wheel");
    }
    if (this.freeSpinsAssetLease && result.featureState.mode === "BASE") {
      this.releaseFeatureAssetEventLease("free-spins");
    }
  }

  private assertRoundPresentationActive(): void {
    if (this.destroyed || this.sessionTimedOut) throw new RoundPresentationCancelledError();
  }

  private handleError(error: ServerError | Error): void {
    if (this.sessionTimedOut) return;
    if (this.requiresOperatorSessionRecovery()) {
      this.failInitialRgsSession(
        playerFacingErrorFor(error, "initial-rgs-session"),
        "initial-session-failed",
      );
      return;
    }
    if (!(error instanceof Error) && !error.retryable && this.machine.phase === "requesting") {
      this.reportPlayerError(error, "round-request");
      this.ui.rollbackAcceptedPaidAutoplaySpin?.();
      this.roundOriginFeatureState = null;
      this.stopRoundAudio(35);
      this.renderer.cancelSpinPresentation();
      this.reelRound.reset("spin-rejected");
      this.machine.transition({ type: "SPIN_FAILED" });
      this.refreshUi();
    } else if (!(error instanceof Error) && !error.retryable
      && (this.machine.phase === "connecting" || this.machine.phase === "recovering")) {
      const publicError = playerFacingErrorFor(error, "launch");
      this.machine.transition({ type: "FATAL_ERROR" });
      this.completeLaunchFailure(publicError);
    } else {
      this.reportPlayerError(
        error,
        this.machine.phase === "requesting" ? "round-request" : "connection",
      );
    }
  }

  private markRgsResultDeliveryStage(stage: RgsResultDeliveryStage): void {
    // 只发布固定阶段码；不得把轮次标识、响应内容、异常文本或堆栈写入 DOM。 / English: Only fixed stage codes are published; round identifiers, response content, exception text, or stacks must not be written to the DOM.
    if (this.root?.dataset) this.root.dataset.rgsDeliveryStage = stage;
  }

  private reportPlayerError(
    cause: unknown,
    context: PlayerFacingErrorContext,
  ): PlayerFacingError {
    const error = playerFacingErrorFor(cause, context);
    this.presentPlayerFacingError(error);
    return error;
  }

  private presentPlayerFacingError(publicError: PlayerFacingError): void {
    if (this.lastPlayerFacingError === publicError) return;
    this.lastPlayerFacingError = publicError;
    this.ui.showError(publicError.message);
    const diagnostic = Object.freeze({
      code: publicError.code,
      ...(publicError.correlationId ? { correlationId: publicError.correlationId } : {}),
    });
    try {
      this.onPlayerErrorDiagnostic?.(diagnostic);
    } catch {
      // 诊断回调不属于游戏或会话状态；宿主异常不能阻止安全错误呈现。 / English: Diagnostic callbacks are not part of game or session state; host exceptions do not prevent safe errors from being presented.
    }
    this.dispatchSafeWindowEvent(PLAYER_ERROR_DIAGNOSTIC_EVENT, diagnostic);
  }

  private completeLaunchFailure(error: PlayerFacingError): void {
    this.clearLaunchIntroWallDeadline();
    // 启动失败不得保留会话成功标记，避免探针把失败页面误判为可服务。 / English: The session success mark must not be retained if the startup fails to prevent the probe from misjudging the failed page as serviceable.
    if (this.root?.dataset) delete this.root.dataset.rgsSession;
    this.launch.transition({ type: "FAIL" });
    this.syncLaunchUi();
    this.presentPlayerFacingError(error);
    this.refreshUi();
  }

  private requiresOperatorSessionRecovery(): boolean {
    return !this.destroyed
      && !this.hasOpenedSession
      && this.gateway?.initialSessionRecoveryMode === "operator-session";
  }

  private armInitialRgsSessionTimeout(): void {
    if (!this.requiresOperatorSessionRecovery()
      || this.initialSessionFailure
      || this.initialRgsSessionTimer != null) return;
    this.initialRgsSessionTimer = setTimeout(() => {
      this.initialRgsSessionTimer = null;
      if (!this.requiresOperatorSessionRecovery()) return;
      this.failInitialRgsSession(
        playerFacingError(PLAYER_FACING_ERROR_CODES.SESSION_TIMEOUT),
        "initial-session-timeout",
      );
    }, INITIAL_RGS_SESSION_TIMEOUT_MS);
  }

  private clearInitialRgsSessionTimeout(): void {
    if (this.initialRgsSessionTimer == null) return;
    clearTimeout(this.initialRgsSessionTimer);
    this.initialRgsSessionTimer = null;
  }

  private failInitialRgsSession(
    error: PlayerFacingError,
    reason: OperatorSessionRequestReason,
  ): void {
    if (!this.requiresOperatorSessionRecovery() || this.initialSessionFailure) return;
    this.initialSessionFailure = error;
    this.clearInitialRgsSessionTimeout();
    // 安全不重放：关闭网关会清除 launch code 并取消在途 exchange；此后只能由 / English: Safe without replay: closing the gateway will clear the launch code and cancel the exchange in transit; thereafter it can only be
    // operator 提供新会话，绝不由页面刷新或浏览器自动重试旧的一次性凭据。 / English: operator provides a new session, never caused by a page refresh or automatic browser retry with old one-time credentials.
    this.gateway.close();
    this.dismissFeaturePreviewForInitialSessionFailure();
    this.initialSessionResolver?.();
    this.initialSessionResolver = null;
    this.completeLaunchFailure(error);
    this.requestOperatorSession(error, reason);
    this.preload?.abort();
  }

  private dismissFeaturePreviewForInitialSessionFailure(): void {
    if (!this.featurePreviewActive) return;
    const resolve = this.featurePreviewResolver;
    this.featurePreviewResolver = null;
    this.featurePreviewActive = false;
    this.featurePreviewContinuePending = false;
    this.ui.setFeaturePreviewEnabled(false);
    this.ui.setFeaturePreviewPending(false);
    this.ui.setFeaturePreviewVisible(false);
    this.renderer.setFeaturePreviewVisible(false);
    resolve?.();
  }

  private requestOperatorSession(
    error: PlayerFacingError,
    reason: OperatorSessionRequestReason,
  ): void {
    const code = error.code;
    if (code !== PLAYER_FACING_ERROR_CODES.SESSION_TIMEOUT
      && code !== PLAYER_FACING_ERROR_CODES.OPERATOR_SESSION_REQUIRED) return;
    if (this.operatorSessionRequestSent) return;
    this.operatorSessionRequestSent = true;
    const request = Object.freeze({
      reason,
      code,
      ...(error.correlationId ? { correlationId: error.correlationId } : {}),
    });
    try {
      this.onOperatorSessionRequired?.(request);
    } catch {
      // 宿主接管新会话的通知是旁路；回调故障不能重新启用旧 launch code。 / English: Notification of the host taking over a new session is bypassed; callback failures cannot re-enable old launch code.
    }
    notifyOperatorSessionRequired(
      typeof window === "undefined" ? undefined : window,
      request,
      this.gateway.operatorHostOrigin,
    );
    if (reason === "session-timeout") {
      returnTopLevelSessionToOperator(
        typeof window === "undefined" ? undefined : window,
        import.meta.env.VITE_OPERATOR_RETURN_URL,
      );
    }
  }

  private handleOperatorSessionRequired(cause: ServerError | Error): void {
    if (this.destroyed) return;
    // refresh 协议终止可能发生在服务器已收到 Spin、浏览器尚未取得结果的窗口。 / English: Refresh protocol termination may occur in a window where the server has received the Spin but the browser has not yet obtained the result.
    // 只撤销本页未完成的表现状态；RGS 仍保留 pending/ledger，由新运营商会话恢复同一轮次。 / English: Only the unfinished performance status of this page is revoked; RGS remains pending/ledger and the same round is restored by a new operator session.
    if (this.machine.phase === "requesting") {
      try {
        this.ui.rollbackAcceptedPaidAutoplaySpin?.();
      } catch {
        // 自动播放计数是表现状态；清理失败不能阻止运营商恢复通知。 / English: Autoplay counts are expressive; failure to clean up does not prevent carriers from resuming notifications.
      }
      this.roundOriginFeatureState = null;
      try {
        this.stopRoundAudio(35);
      } catch {
        // 音频清理旁路不拥有恢复流程。 / English: Audio Cleanup Bypass does not have a recovery process.
      }
      try {
        this.renderer.cancelSpinPresentation();
      } catch {
        // 下方状态机仍必须离开 Spinning。 / English: The lower state machine must still leave Spinning.
      }
      try {
        this.reelRound.reset("operator-session-required");
      } catch {
        // RESET 正常不抛错；保持故障关闭并继续宿主通知。 / English: RESET does not throw an error normally; keeps the fault closed and continues host notification.
      }
      if (this.machine.phase === "requesting") {
        this.machine.transition({ type: "SPIN_FAILED" });
      }
    }
    const error = playerFacingError(
      PLAYER_FACING_ERROR_CODES.OPERATOR_SESSION_REQUIRED,
      cause,
    );
    this.presentPlayerFacingError(error);
    this.requestOperatorSession(error, "committed-result-recovery-required");
    this.refreshUi();
  }

  private handleSessionTimeout(timeout: Readonly<GatewaySessionTimeout>): void {
    if (this.destroyed || this.sessionTimedOut || timeout.code !== "SESSION_TIMEOUT") return;
    this.sessionTimedOut = true;
    this.connectionStatus = "offline";
    delete this.root.dataset.rgsSession;
    this.root.dataset.rgsSessionTimeout = "true";
    this.root.dataset.rgsSessionTimeoutCode = timeout.code;
    this.clearInitialRgsSessionTimeout();
    this.clearLaunchIntroWallDeadline();
    this.cancelScheduledFreeSpin();
    this.stopPostWinIdleRepeat();
    this.normalWinFinishRequested = true;
    const normalWinDelayResolver = this.normalWinDelayResolver;
    this.normalWinDelayResolver = null;
    bestEffortAppCleanup(() => normalWinDelayResolver?.());
    const featurePreviewResolver = this.featurePreviewResolver;
    this.featurePreviewResolver = null;
    this.featurePreviewActive = false;
    this.featurePreviewContinuePending = false;
    bestEffortAppCleanup(() => featurePreviewResolver?.());
    bestEffortAppCleanup(() => this.ui.rollbackAcceptedPaidAutoplaySpin?.());
    bestEffortAppCleanup(() => this.ui.completeAutoplayStopRound?.(
      this.activePresentationSequence ?? undefined,
    ));
    bestEffortAppCleanup(() => this.stopRoundAudio(0));
    bestEffortAppCleanup(() => this.audio.stopGameIntro(0));
    bestEffortAppCleanup(() => this.stops.cancel());
    bestEffortAppCleanup(() => this.renderer.cancelSpinPresentation());
    bestEffortAppCleanup(() => this.intro.destroy());
    bestEffortAppCleanup(() => this.renderer.setFeaturePreviewVisible(false));
    bestEffortAppCleanup(() => this.reelRound.reset("session-timeout"));
    bestEffortAppCleanup(() => this.releaseFeatureAssetEventLease("wheel"));
    bestEffortAppCleanup(() => this.releaseFeatureAssetEventLease("free-spins"));
    bestEffortAppCleanup(() => this.preload?.abort());
    bestEffortAppCleanup(() => this.streamingAssets?.destroy());
    this.roundOriginFeatureState = null;
    this.bufferedRecoveredSpinResult = null;
    this.activePresentationSequence = null;
    this.activeRageCollectionPresentationSequence = null;
    this.activeRageCascadePresentationSequence = null;
    bestEffortAppCleanup(() => this.machine.transition({ type: "FATAL_ERROR" }));
    bestEffortAppCleanup(() => this.audio.destroy());
    this.ui.setConnection("offline");
    this.ui.setControls(false, false);
    this.ui.showSessionTimeout(() => {
      const error = playerFacingError(PLAYER_FACING_ERROR_CODES.SESSION_TIMEOUT);
      this.requestOperatorSession(error, "session-timeout");
    });
  }

  private dispatchSafeWindowEvent<T extends object>(name: string, detail: T): void {
    if (typeof window === "undefined" || typeof window.dispatchEvent !== "function"
      || typeof CustomEvent !== "function") return;
    try {
      window.dispatchEvent(new CustomEvent<T>(name, { detail }));
    } catch {
      // 自定义事件遥测是可选项，不得影响启动状态。 / English: Custom event telemetry is optional and must not affect startup status.
    }
  }

  private throwIfInitialSessionFailed(): void {
    if (!this.initialSessionFailure) return;
    throw this.initialSessionFailure;
  }

  private refreshUi(): void {
    this.renderer.setJackpotBet(this.snapshot.selectedBetMinor);
    const freeSpinLocked = this.snapshot.featureState.freeSpinsRemaining > 0;
    const canSpin = !this.sessionTimedOut && canEnableSpin({
      launchReady: this.launch.canEnterGame,
      gameReady: this.machine.canSpin,
      online: this.connectionStatus === "online",
      pendingSpin: this.gateway.hasPendingSpin,
    });
    if (this.launch.canEnterGame) {
      this.ui.setPhase(this.machine.phase, this.snapshot.featureState);
    } else {
      this.ui.setLaunchStatus(this.launch.phase);
    }
    this.ui.setAutoplayPaidSpinEligible?.(
      this.snapshot.featureState.mode === "BASE" && !freeSpinLocked,
    );
    this.ui.setControls(canSpin, canSpin && !freeSpinLocked);
    if (!this.stops.isPresenting) this.ui.setSpinMode(canSpin ? "ready" : "waiting");
    if (freeSpinLocked && canSpin) this.scheduleFreeSpin();
    else this.cancelScheduledFreeSpin();
  }

  /**
   * 免费轮次仍是独立的权威旋转请求。这段短表现延迟让模式/计数器在下次请求前稳定；
   * 它绝不采样结果，也不在本地推进特性计数器。
   *
   * 英文 / English: Free rounds remain independent authoritative spin requests. This short presentation delay allows the mode/counter to stabilize before the next request; it never samples the result, nor does it advance the feature counter locally.
   */
  private scheduleFreeSpin(): void {
    if (this.freeSpinTimer !== null || this.destroyed) return;
    const expectedMode = this.snapshot.featureState.mode;
    const expectedRemaining = this.snapshot.featureState.freeSpinsRemaining;
    if (!shouldScheduleFreeSpin({
      mode: expectedMode,
      remaining: expectedRemaining,
      online: this.connectionStatus === "online",
      canSpin: this.machine.canSpin,
      pendingSpin: this.gateway.hasPendingSpin,
      destroyed: this.destroyed,
    })) return;
    this.freeSpinTimer = setTimeout(() => {
      this.freeSpinTimer = null;
      if (this.snapshot.featureState.mode !== expectedMode
        || this.snapshot.featureState.freeSpinsRemaining !== expectedRemaining
        || !shouldScheduleFreeSpin({
          mode: this.snapshot.featureState.mode,
          remaining: this.snapshot.featureState.freeSpinsRemaining,
          online: this.connectionStatus === "online",
          canSpin: this.machine.canSpin,
          pendingSpin: this.gateway.hasPendingSpin,
          destroyed: this.destroyed,
        })) return;
      this.requestSpin();
    }, freeSpinAutoplayDelay(this.reducedMotionMedia?.matches ?? this.reducedMotion));
    this.observePresentationMilestone("free-spins.autoplay-armed");
  }

  private cancelScheduledFreeSpin(): void {
    if (this.freeSpinTimer === null) return;
    clearTimeout(this.freeSpinTimer);
    this.freeSpinTimer = null;
  }

  private readonly handleReducedMotionChange = (event: MediaQueryListEvent): void => {
    this.handleReducedMotionPreference(event.matches);
  };

  private handleReducedMotionPreference(matches: boolean): void {
    if (!matches) return;
    if (this.launch.phase === "intro") {
      this.audio.stopGameIntro(200);
      this.intro.skip();
      return;
    }
    // 启动就绪早于角色片段原生的 8.066s 终点。若尾段期间启用减少动态效果， / English: Startup ready is earlier than the character fragment's native 8.066s endpoint. If the reduced dynamic effect is enabled during the tail segment,
    // 则以原子方式完成场景所有的交接，并且只淡出仍在播放的 10.086s 介绍提示音。 / English: Then all handovers of the scene are completed atomically, and only the 10.086s intro sound that is still playing is faded out.
    if (this.renderer.completeActiveCharacterIntroForReducedMotion()) {
      this.audio.stopGameIntro(200);
    }
  }

  private startRoundAudio(unlock: Promise<boolean>, reducedMotion: boolean): void {
    this.spinAudioGeneration += 1;
    void unlock.catch(() => false);
    if (this.destroyed) return;
    this.audio.playReelStart({ intensity: 1, reducedMotion });
  }

  private stopRoundAudio(fadeMs: number): void {
    this.spinAudioGeneration += 1;
    this.audio.stopReelLoop(fadeMs);
  }

  private finishRoundAudio(): void {
    this.spinAudioGeneration += 1;
    this.audio.finishReelLoopNaturally();
  }

  private toggleSound(): void {
    const muted = this.audio.toggleMuted();
    this.ui.setSoundState(muted, this.audio.isAvailable);
  }

  private waitForFeaturePreview(): Promise<void> {
    this.featurePreviewActive = true;
    this.featurePreviewContinuePending = false;
    this.ui.setFeaturePreviewPending(false);
    this.ui.setFeaturePreviewEnabled(this.launch.hasSession);
    this.syncLaunchUi();
    this.ui.setFeaturePreviewAuthored(this.renderer.hasAuthoredFeaturePreview);
    this.renderer.setFeaturePreviewVisible(true);
    this.ui.setFeaturePreviewVisible(true);
    return new Promise((resolve) => {
      this.featurePreviewResolver = resolve;
    });
  }

  private async playLaunchIntroWithinWallDeadline(): Promise<void> {
    const deadline = this.armLaunchIntroWallDeadline();
    try {
      // 即使浏览器音频播放时钟或 Timeline 的完成 Promise 永久停滞，绝对挂钟 / English: Even if the browser audio playback clock or the completion of the Timeline Promise is permanently stalled, the absolute wall clock
      // 分支也会独立结算；skip 只负责把装饰场景推到终帧，不是解除 await 的条件。 / English: Branches will also be resolved independently; skip is only responsible for pushing the decoration scene to the final frame, and is not a condition for releasing await.
      await Promise.race([this.intro.play(), deadline]);
    } finally {
      this.clearLaunchIntroWallDeadline();
    }
  }

  private armLaunchIntroWallDeadline(): Promise<void> {
    this.clearLaunchIntroWallDeadline();
    const generation = this.launchIntroWallDeadlineGeneration;
    // IntroDirector 在构造时冻结该偏好，因此即使启动期间媒体查询变化， / English: IntroDirector freezes this preference at construction time, so even if the media query changes during startup,
    // 独立挂钟截止也必须使用同一份快照。 / English: Independent wall clock deadlines must also use the same snapshot.
    const authoredDuration = this.reducedMotion
      ? REDUCED_INTRO_DURATION_MS
      : INTRO_DURATION_MS;
    let settleDeadline = (): void => undefined;
    const deadline = new Promise<void>((resolve) => {
      let settled = false;
      settleDeadline = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
    });
    this.launchIntroWallDeadlineResolver = settleDeadline;
    this.launchIntroWallDeadlineTimer = setTimeout(() => {
      this.launchIntroWallDeadlineTimer = null;
      if (this.launchIntroWallDeadlineResolver === settleDeadline) {
        this.launchIntroWallDeadlineResolver = null;
      }
      if (!this.destroyed && !this.sessionTimedOut
        && generation === this.launchIntroWallDeadlineGeneration
        && this.launch.phase === "intro") {
        // 该栅栏只结束装饰性介绍。会话、RNG、余额、轮次和结果交付均不读取此路径。 / English: The fence ends only as a decorative introduction. Sessions, RNG, balances, rounds, and result delivery do not read this path.
        bestEffortAppCleanup(() => this.audio.stopGameIntro(200));
        bestEffortAppCleanup(() => this.intro.skip());
      }
      settleDeadline();
    }, authoredDuration + LAUNCH_INTRO_WALL_DEADLINE_GRACE_MS);
    return deadline;
  }

  private clearLaunchIntroWallDeadline(): void {
    this.launchIntroWallDeadlineGeneration += 1;
    if (this.launchIntroWallDeadlineTimer !== null) {
      clearTimeout(this.launchIntroWallDeadlineTimer);
      this.launchIntroWallDeadlineTimer = null;
    }
    const settleDeadline = this.launchIntroWallDeadlineResolver;
    this.launchIntroWallDeadlineResolver = null;
    settleDeadline?.();
  }

  private continueFeaturePreview(): void {
    const resolveGate = this.featurePreviewResolver;
    if (!resolveGate || this.featurePreviewContinuePending || !this.launch.hasSession) return;
    // 权威会话门通过后先原子夺取 resolver；从这里开始，任何 DOM、 / English: After the authoritative session gate is passed, the resolver is atomically captured; from here on, any DOM,
    // 音频或渲染器副作用抛错都不得使已接受的 Continue 再次可入或悬挂。 / English: Neither audio nor renderer side-effect throws shall cause an accepted Continue to become available or pending again.
    this.featurePreviewResolver = null;
    this.featurePreviewContinuePending = true;
    this.featurePreviewActive = false;
    bestEffortAppCleanup(() => this.ui.setFeaturePreviewPending(true));
    // 指针/点击捕获已请求恢复。键盘激活时幂等地重复，但在 SPLASH_HIDE 前绝不等待浏览器音频。 / English: Pointer/click capture has requested recovery. Repeat idempotently on keyboard activation, but never wait for browser audio before SPLASH_HIDE.
    try {
      const playbackClock = this.audio.getLaunchPlaybackClock();
      if (playbackClock) this.launchClock.follow(playbackClock);
      const audioUnlock = this.audio.unlock();
      void audioUnlock.then((unlocked) => {
        if (!unlocked && !this.destroyed) {
          bestEffortAppCleanup(() => this.launchClock.followWall());
        }
      }, () => {
        if (!this.destroyed) bestEffortAppCleanup(() => this.launchClock.followWall());
      });
    } catch {
      bestEffortAppCleanup(() => this.launchClock.followWall());
    }
    bestEffortAppCleanup(() => this.audio.playSplashContinue({ intensity: 1 }));
    bestEffortAppCleanup(() => this.syncGameMusic());
    this.featurePreviewContinuePending = false;
    bestEffortAppCleanup(() => this.ui.setFeaturePreviewPending(false));
    bestEffortAppCleanup(() => this.ui.setFeaturePreviewVisible(false));
    bestEffortAppCleanup(() => this.renderer.setFeaturePreviewVisible(false));
    bestEffortAppCleanup(resolveGate);
  }

  private waitForInitialSession(): Promise<void> {
    if (this.launch.hasSession || this.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      this.initialSessionResolver = resolve;
    });
  }

  private presentIntroAudio(cue: TimelineCue): void {
    const reducedMotion = this.reducedMotionMedia?.matches ?? this.reducedMotion;
    switch (cue.name) {
      case "audio.game-intro":
        this.audio.playGameIntro(
          { intensity: 1, reducedMotion },
          this.launchIntroClockMode,
        );
        return;
    }
  }

  private presentFeatureAudio(
    event: FeatureEvent,
    reducedMotion: boolean,
    state: RoundFeatureAudioState,
  ): void {
    switch (event.type) {
      case "grid.expanded":
        // 匹配的 `reel_stretch` 角色动画会派发 PpsLvl5。 / English: Matching `reel_stretch` character animations will issue PpsLvl5.
        return;
      case "vaults.landed":
      case "vaults.locked":
      case "vault.unlocked":
      case "vaults.unlock.completed":
      case "vault.upgraded":
      case "vault.awarded":
        return;
      case "vaults.unlock.started":
      case "vaults.upgrade.started":
        this.audio.playImpact({ intensity: 1, reducedMotion });
        // 后续 King Spin 升级会以零个锁定符号派发 SYMBOL_UNLOCK； / English: Subsequent King Spin upgrades will issue SYMBOL_UNLOCK with zero lock symbols;
        // 原始声音路由器回退到 VaultOpened (1)。 / English: Original sound router falls back to VaultOpened (1).
        this.audio.playVaultUnlock(event.type === "vaults.upgrade.started" ? 1 : event.count, {
          delayMs: reducedMotion ? 40 : 500,
          intensity: 1,
          reducedMotion,
        });
        return;
      case "surge.collected": {
        if (event.triggered && !event.guaranteed) {
          // 官方 GamePPSFeature RESET 会把成功的一个/两个 Rage 触发器移回默认 PPS 等级， / English: The official GamePPSFeature RESET will move one/two successful Rage triggers back to the default PPS level,
          // 但刻意让当前可见光环保持所有状态，直到 Wheel/特性结束。 / English: But deliberately keeping the currently visible halo in all its states until the end of the Wheel/feature.
          // 不要从已计入的重置前事件样本重放 EVOLVE 提示音。 / English: Do not replay EVOLVE tones from pre-reset event samples that have been accounted for.
          state.rageLevel = 1;
          return;
        }
        if (event.level !== undefined && Number.isFinite(event.level)) {
          const visualLevel = Math.max(1, Math.min(6, Math.trunc(event.level)));
          if (visualLevel > state.rageLevel) {
            // 制作了六种角色 PPS 状态，但复刻的声音阶段止于 PpsLevel5。 / English: Six character PPS states were created, but the reproduced sound stage ends at PpsLevel5.
            // 在视觉上保留第六级，不要伪造缺失的提示音。 / English: Keep the sixth level visually and don't fake the missing chime.
            if (visualLevel <= 5) {
              this.audio.playPpsLevel(visualLevel as PpsLevel, { intensity: 1, reducedMotion });
            }
            this.renderer.setRageAuraLevel(visualLevel);
          }
          state.rageLevel = Math.max(state.rageLevel, event.level);
        }
        // 已触发结果立即进入重旋/级联链。普通吞食/收集样本只属于非触发收集。 / English: Triggered results immediately enter the respin/cascade chain. Ordinary ingestion/collection samples are only non-triggered collections.
        if (event.triggered) return;
        // 官方 RageCollect SoundStage 事件是针对整个收集批次的一套居中程序。 / English: The official RageCollect SoundStage event is a set of centered procedures for the entire collection batch.
        // 不要让多来源批次偏向碰巧先被枚举的已结算 Rage。 / English: Don't let multi-source batches favor settled rates that happen to be enumerated first.
        this.audio.playEnergyCollect({
          pan: 0,
          intensity: 1,
          reducedMotion,
        });
        return;
      }
      case "rage.transformed":
        // `surge.collected` 拥有收集样本；转换只是视觉延续，不得重放相同提示音。 / English: `surge.collected` has collected samples; transitions are visual continuation only and must not replay the same prompt.
        return;
      case "wheel.started":
        this.audio.playWheelAppear({ intensity: 1, reducedMotion });
        this.audio.playWheelPanelIn({ intensity: 1, reducedMotion });
        return;
      case "wheel.awarded":
        // FeatureEffects 拥有真实旋转/落地时钟，并在这些制作好的里程碑通知控制器。 / English: FeatureEffects have real rotating/floor clocks and notify the controller at these crafted milestones.
        this.pendingWheelAward = event;
        return;
      case "free_spins.started":
        this.audio.playFeatureStart({ intensity: 1, reducedMotion });
        this.audio.setFreeSpinsMusicEnabled(true, { intensity: 1, reducedMotion });
        return;
      case "free_spin.awarded":
        // 控制器将所有额外旋转轨迹批量处理，并且只播放一次。 / English: The controller batches all additional rotation tracks and plays them only once.
        return;
      case "free_spin.cap_reached":
        return;
      case "win_cap.reached":
        // 纯经济边界事实，不拥有声音。 / English: Pure economic boundary facts, no ownership of voice.
        return;
      case "free_spins.completed":
        // 终局事件启动 Free Spins 尾段。FREESPIN_END/Base 恢复在总结隐藏时开始； / English: The endgame event kicks off the Free Spins tail section. FREESPIN_END/Base Recovery starts when summary is hidden;
        // 若权威总结栅栏为 false，则与 skipOutro 一起立即开始。 / English: If authoritative summary fence is false, start immediately with skipOutro.
        this.audio.setFreeSpinsMusicEnabled(
          false,
          { intensity: 1, reducedMotion },
          state.showFreeSpinSummary,
        );
        return;
    }
  }

  private presentReelLandAudio(_reel: number, cells: readonly GridCell[]): void {
    const plan = planReelLandAudio(cells, this.scatterLandOrdinal);
    this.scatterLandOrdinal = plan.nextScatterOrdinal;
    const reducedMotion = this.reducedMotionMedia?.matches ?? this.reducedMotion;
    for (const event of plan.events) {
      if (event.kind === "scatter-land") {
        this.audio.playScatterLand(event.ordinal, { pan: 0, intensity: 1, reducedMotion });
      } else {
        this.audio.playWildLand({ pan: 0, intensity: 1, reducedMotion });
      }
    }
  }

  private presentCharacterAudio(event: CharacterAnimationEvent): void {
    const reducedMotion = this.reducedMotionMedia?.matches ?? this.reducedMotion;
    switch (event.animation) {
      case "win":
        // 确定性的 WIN/WIN_FEATURE/WIN_KQ 音频归显式状态里程碑所有。 / English: Deterministic WIN/WIN_FEATURE/WIN_KQ audio is owned by an explicit status milestone.
        // 只有 COLLECT 的随机动画分支派发 ANIM_START(win)，它独立拥有一个复刻的 Roar。 / English: Only the random animation branch of COLLECT dispatches ANIM_START(win), which independently has a forked Roar.
        if (event.context === "collect-random") {
          this.audio.playMonsterRoar({ intensity: 1, reducedMotion });
        }
        return;
      case "idle_breaker2":
        this.audio.playMonsterRoar({ intensity: 1, reducedMotion });
        return;
      case "idle_breaker":
        this.audio.playMonsterSniff({ intensity: 1, reducedMotion });
        return;
      case "chest_pound":
        this.audio.playMonsterRoarHit({ intensity: 1, reducedMotion });
        return;
      case "respin":
      case "pound":
        this.audio.playMonsterThump({ intensity: 1, reducedMotion });
        return;
      case "vault":
        // Vault 分组音频由 vaults.unlock.started 调度一次。 / English: Vault packet audio is scheduled once by vaults.unlock.started.
        return;
      case "reel_stretch":
        this.audio.playMonsterReelStretch({ intensity: 1, reducedMotion });
        return;
      case "feature_activation":
        this.audio.playMonsterFeatureActivate({ intensity: 1, reducedMotion });
        return;
    }
  }

  private beginFreeSpinsExitOnce(
    state: RoundFeatureAudioState | null,
    reducedMotion: boolean,
  ): boolean {
    if (state?.featureExitStarted) return false;
    if (state) state.featureExitStarted = true;
    this.observePresentationMilestone("free-spins.exit-started");
    this.audio.endFreeSpinsMode?.({ intensity: 1, reducedMotion });
    this.renderer.beginFeatureExitAtSummaryHide(
      this.snapshot.featureState,
      reducedMotion,
    );
    return true;
  }

  private observePresentationMilestone(milestone: AppPresentationMilestone | null): void {
    try {
      this.presentationObserver?.onPresentationMilestone?.(milestone);
    } catch {
      // 表现观察者仅为可选诊断。 / English: Performance Observer is an optional diagnosis only.
    }
  }

  private observePresentationBranch(branch: AppPresentationBranch): void {
    try {
      this.presentationObserver?.onPresentationBranch?.(Object.freeze(branch));
    } catch {
      // 夹具/调试观察者不能中断制作好的表现栅栏。 / English: Fixture/debug observers cannot interrupt crafted performance fences.
    }
  }

  private observeRoundPresentationState(state: RoundPresentationState): void {
    try {
      this.presentationObserver?.onRoundPresentationState?.(state);
    } catch {
      // 表现观察者仅为可选诊断。 / English: Performance Observer is an optional diagnosis only.
    }
  }

  private presentFeaturePresentationMilestone(milestone: FeaturePresentationMilestone): void {
    const reducedMotion = this.reducedMotionMedia?.matches ?? this.reducedMotion;
    const inputReady = milestone === "wheel.popup-input-ready"
      || milestone === "wheel.input-ready"
      || milestone === "wheel.summary-input-ready"
      || milestone === "free-spins.input-ready"
      || milestone === "free-spins.summary-input-ready"
      || milestone === "free-spin-cap.input-ready";
    const observable = inputReady
      || milestone === "wheel.bonus-label-ready"
      || milestone === "wheel.spin-start"
      || milestone === "wheel.quick-stop"
      || milestone === "wheel.spin-finish";
    this.observePresentationMilestone(observable ? milestone : null);
    switch (milestone) {
      case "wheel.popup-input-ready":
        this.wheelQuickStopAccepted = false;
        this.wheelLandingInputBlocked = false;
        this.ui?.setSpinMode("wheel-popup-continue");
        return;
      case "wheel.popup-complete":
        this.ui?.setSpinMode("wheel-none");
        return;
      case "wheel.input-ready":
        this.ui?.setSpinMode("wheel-ready");
        this.audio.startWheelWait({ intensity: 1, reducedMotion });
        return;
      case "wheel.spin-start":
        this.wheelQuickStopAccepted = false;
        this.wheelLandingInputBlocked = false;
        this.ui?.setSpinMode("wheel-fast-stop");
        this.audio.stopWheelWait(200);
        this.audio.playWheelSpin({ intensity: 1, reducedMotion });
        return;
      case "wheel.quick-stop":
        this.wheelQuickStopAccepted = true;
        this.wheelLandingInputBlocked = true;
        this.ui?.setSpinMode("wheel-none");
        return;
      case "wheel.spin-abort":
        this.ui?.setSpinMode("waiting");
        this.audio.stopWheelWait(0);
        this.pendingWheelAward = null;
        this.wheelQuickStopAccepted = false;
        this.wheelLandingInputBlocked = false;
        return;
      case "wheel.summary-input-ready":
        this.ui?.setSpinMode("wheel-summary-continue");
        this.audio.playWheelPanelIn({ intensity: 1, reducedMotion });
        return;
      case "wheel.summary-complete":
        this.wheelLandingInputBlocked = true;
        this.ui?.setSpinMode("wheel-none");
        return;
      case "wheel.bonus-label-ready":
        this.ui?.showWheelBonusRoundSummary(this.snapshot.lastWinMinor);
        return;
      case "free-spins.input-ready":
        this.ui?.setSpinMode("feature-continue");
        return;
      case "free-spins.continue":
        this.ui?.setSpinMode("waiting");
        return;
      case "free-spins.summary-input-ready":
        this.ui?.setSpinMode("free-spin-summary-continue");
        return;
      case "free-spins.summary-complete":
        this.ui?.setSpinMode("waiting");
        return;
      case "free-spin-cap.input-ready":
        this.ui?.setSpinMode("cap-continue");
        return;
      case "free-spin-cap.continue":
        this.ui?.setSpinMode("waiting");
        return;
      case "free-spins.summary-hide":
        this.beginFreeSpinsExitOnce(this.activeRoundFeatureAudioState, reducedMotion);
        return;
      case "reels.decrease-kq":
        this.audio.playMonsterThumpExpand({ intensity: 1, reducedMotion });
        return;
      case "reels.reset-base":
        this.audio.playMonsterThump({ intensity: 1, reducedMotion });
        return;
      case "wheel.spin-finish":
        this.wheelLandingInputBlocked = true;
        this.ui?.setSpinMode(
          this.wheelQuickStopAccepted ? "wheel-none" : "wheel-landing-continue",
        );
        this.audio.playMonsterRoarHit({ intensity: 1, reducedMotion });
        this.audio.playWheelAward({ intensity: 1, reducedMotion });
        break;
    }
    const event = this.pendingWheelAward;
    this.pendingWheelAward = null;
    const semantic = wheelLandingSemantic(event);
    if (semantic === "king-spin") {
      this.audio.playWheelKingSpinWon?.({ intensity: 1, reducedMotion });
    } else if (semantic === "kong-quest") {
      this.audio.playWheelKongQuestWon?.({ intensity: 1, reducedMotion });
    }
    const tier = parseJackpotTier(event?.prize ?? event?.outcome);
    if (tier) {
      const sequence = this.activePresentationSequence;
      if (sequence !== null) {
        // Wheel STOP_JACKPOT 归物理落地接缝所有，而非 `wheel.awarded` 解码或更早的 Wheel 弹窗。 / English: Wheel STOP_JACKPOT is owned by the physical floor joint, not the `wheel.awarded` decoding or the earlier Wheel popup.
        this.ui?.reachAutoplayStopBoundary?.(sequence, "jackpot");
      }
      this.audio.playJackpotPot(tier, { intensity: 1, reducedMotion });
    }
  }

  private presentBigWinAudio(milestone: BigWinMilestone): void {
    const reducedMotion = this.reducedMotionMedia?.matches ?? this.reducedMotion;
    switch (milestone.type) {
      case "show":
        this.audio.beginBigWin(this.bigWinInFreeSpins, { intensity: 1, reducedMotion });
        return;
      case "count-start":
        this.audio.beginBigWinCounter({ intensity: 1, reducedMotion });
        return;
      case "level-up":
        this.audio.playBigWinLevelUp({ intensity: 1, reducedMotion });
        return;
      case "count-end":
        this.audio.endBigWinCounter({ intensity: 1, reducedMotion });
        return;
      case "hide-start":
        this.audio.endBigWin(this.bigWinMusicResume, { intensity: 1, reducedMotion });
        return;
      case "complete":
        this.bigWinInFreeSpins = false;
        this.bigWinMusicResume = "ambient";
        return;
    }
  }

  private observeBigWinMilestone(milestone: BigWinMilestone): void | Promise<void> {
    const sequence = this.activePresentationSequence;
    const observer = this.presentationObserver;
    if (sequence === null
      || (!observer?.onPresentationTrace && !observer?.onPresentationCheckpoint)) return;
    const { type, amountMinor, ...facts } = milestone;
    const trace = Object.freeze({
      ...facts,
      type: `big-win.${type}`,
      sequence,
      amountMinor: amountMinor.toString(),
    } as BigWinPresentationTrace);
    if (observer.onPresentationTrace) this.emitPresentationTrace(trace);
    if (!observer.onPresentationCheckpoint) return;
    return this.requestPresentationCheckpoint({
      type: "presentation-trace",
      trace,
    });
  }

  /**
   * 在不改变结果的情况下投影两个原生 Wild 停轴退场边界。夹具检查点只能冻结指定的 Spine 视图，
   * 避免浏览器捕获与 500ms 揭示栅栏或其终止姿态发生竞态。
   *
   * 英文 / English: Projects two native Wild pivot exit boundaries without changing the result. Fixture checkpoints can only freeze the specified Spine view, avoiding a race condition between browser capture and the 500ms reveal of the fence or its termination pose.
   */
  private observeWildRevealBoundary(
    phase: "pre" | "complete",
    event: ReelPostStopActivationEvent,
  ): void | Promise<void> {
    const sequence = this.activePresentationSequence;
    const observer = this.presentationObserver;
    if (event.kind !== "wild-reveal"
      || sequence === null
      || (!observer?.onPresentationTrace && !observer?.onPresentationCheckpoint)) return;

    const cells = Object.freeze(event.cells.flatMap(({ reel, row }) => {
      const cell = this.snapshot.currentGrid[reel]?.[row];
      if (cell?.symbol !== "WILD"
        || cell.multiplier === undefined
        || cell.multiplier < 2) return [];
      return [Object.freeze({ reel, row, multiplier: cell.multiplier })];
    }));
    if (cells.length === 0) return;

    const trace = Object.freeze({
      type: `wild-reveal.${phase}`,
      sequence,
      cells,
      outroMs: event.delayMs,
    } as const satisfies WildRevealPresentationTrace);
    if (observer.onPresentationTrace) this.emitPresentationTrace(trace);
    if (!observer.onPresentationCheckpoint) return;

    const addresses = cells.map(({ reel, row }) => Object.freeze({ reel, row }));
    let paused = false;
    try {
      this.renderer.reels.setSymbolPlaybackPaused(addresses, true);
      paused = true;
    } catch {
      // 若部分渲染器无法冻结，观察仍保持故障开放。 / English: If some renderers fail to freeze, observe that the fault remains open.
    }
    const resume = (): void => {
      if (!paused) return;
      try {
        this.renderer.reels.setSymbolPlaybackPaused(addresses, false);
      } catch {
        // 绝不让夹具清理进入权威表现逻辑。 / English: Never let jig cleaning enter the logic of authoritative performance.
      }
    };
    const pending = this.requestPresentationCheckpoint({
      type: "presentation-trace",
      trace,
    });
    if (!pending) {
      resume();
      return;
    }
    return Promise.resolve(pending).finally(resume);
  }

  /**
   * 投影官方后台 Rage 收集生命周期。所属序列在 `round.complete` 后仍保留，因为原始 PPS 任务
   * 在 1ms 后推进，而 Symbol7/轨迹/角色/高塔 Spine 片段会异步完成。
   * 可选夹具暂停只暂停该装饰范围。
   *
   * 英文 / English: Project the official backend Rage collection life cycle. The belonging sequence is retained after `round.complete` because the original PPS task advances after 1ms and the Symbol7/Trajectory/Character/Tower Spine fragment completes asynchronously. Optional clamp suspension only suspends this trim range.
   */
  private observeRageCollectionPresentationMilestone(
    milestone: Readonly<RageCollectionPresentationMilestone>,
  ): void {
    const observer = this.presentationObserver;
    if (milestone.phase === "started") {
      this.activeRageCollectionPresentationSequence = this.activePresentationSequence;
    }
    const sequence = this.activeRageCollectionPresentationSequence;
    if (sequence === null
      || (!observer?.onPresentationTrace && !observer?.onPresentationCheckpoint)) {
      if (milestone.phase === "complete") {
        this.activeRageCollectionPresentationSequence = null;
      }
      return;
    }

    const { phase, ...facts } = milestone;
    const trace = Object.freeze({
      ...facts,
      cells: Object.freeze(milestone.cells.map((cell) => Object.freeze({ ...cell }))),
      type: `rage-collect.${phase}`,
      sequence,
    } as const satisfies RageCollectionPresentationTrace);
    if (observer.onPresentationTrace) this.emitPresentationTrace(trace);

    const finish = (): void => {
      try {
        this.renderer.setRageCollectionPresentationPaused(false);
      } catch {
        // 不完整的诊断渲染器不能影响已接受表现。 / English: Incomplete diagnostic renderers cannot affect accepted performance.
      }
      if (phase === "complete"
        && this.activeRageCollectionPresentationSequence === sequence) {
        this.activeRageCollectionPresentationSequence = null;
      }
    };
    if (!observer.onPresentationCheckpoint) {
      finish();
      return;
    }

    try {
      this.renderer.setRageCollectionPresentationPaused(true);
    } catch {
      // 若本地暂停接缝不可用，观察仍保持故障开放。 / English: If the local pause seam is unavailable, the observation remains faulty open.
    }
    const pending = this.requestPresentationCheckpoint({
      type: "presentation-trace",
      trace,
    });
    if (!pending) {
      finish();
      return;
    }
    void Promise.resolve(pending).finally(finish);
  }

  /**
   * 将服务端所有的 PPS 替换级联投影为确定性只读浏览器检查点。可选暂停只冻结制作好的表现时钟；
   * 它不能选择格子、触发器、奖励或派彩。
   *
   * 英文 / English: Project all server-side PPS replacement cascades into deterministic read-only browser checkpoints. The optional pause only freezes the crafted performance clock; it cannot select grids, triggers, bonuses or payouts.
   */
  private observeRageCascadePresentationMilestone(
    milestone: Readonly<RageCascadePresentationMilestone>,
  ): void {
    const observer = this.presentationObserver;
    if (milestone.phase === "started") {
      this.activeRageCascadePresentationSequence = this.activePresentationSequence;
    }
    const sequence = this.activeRageCascadePresentationSequence;
    if (sequence === null
      || (!observer?.onPresentationTrace && !observer?.onPresentationCheckpoint)) {
      if (milestone.phase === "complete") {
        this.activeRageCascadePresentationSequence = null;
      }
      return;
    }

    const { phase, ...facts } = milestone;
    const trace = Object.freeze({
      ...facts,
      transformedCells: Object.freeze(
        milestone.transformedCells.map((cell) => Object.freeze({ ...cell })),
      ),
      shuffledCells: Object.freeze(milestone.shuffledCells.map((cell) => Object.freeze({
        ...cell,
        address: Object.freeze({ ...cell.address }),
      }))),
      type: `rage-cascade.${phase}`,
      sequence,
    } as const satisfies RageCascadePresentationTrace);
    if (observer.onPresentationTrace) this.emitPresentationTrace(trace);

    const finish = (): void => {
      try {
        this.renderer.setRageCascadePresentationPaused?.(false);
      } catch {
        // 不完整的诊断渲染器不能影响已接受表现。 / English: Incomplete diagnostic renderers cannot affect accepted performance.
      }
      if (phase === "complete"
        && this.activeRageCascadePresentationSequence === sequence) {
        this.activeRageCascadePresentationSequence = null;
      }
    };
    if (!observer.onPresentationCheckpoint) {
      finish();
      return;
    }

    try {
      this.renderer.setRageCascadePresentationPaused?.(true);
    } catch {
      // 若本地暂停接缝不可用，观察仍保持故障开放。 / English: If the local pause seam is unavailable, the observation remains faulty open.
    }
    const pending = this.requestPresentationCheckpoint({
      type: "presentation-trace",
      trace,
    });
    if (!pending) {
      finish();
      return;
    }
    void Promise.resolve(pending).finally(finish);
  }

  private emitPresentationTrace(trace: AppPresentationTrace): void {
    try {
      this.presentationObserver?.onPresentationTrace?.(Object.freeze(trace));
    } catch {
      // 夹具/调试观察者不属于权威轮次路径。 / English: Fixture/debug observers are not part of the authoritative turn path.
    }
  }

  private notifyFeatureEvent(
    type: FeatureEvent["type"] | null,
    event: Readonly<FeatureEvent> | null,
  ): void {
    try {
      const observer = this.presentationObserver;
      if (!observer?.onFeatureEvent) return;
      if (event) observer.onFeatureEvent(type, event);
      else observer.onFeatureEvent(type);
    } catch {
      // 只读观察不能中断特性表现。 / English: Read-only observations cannot interrupt feature performance.
    }
  }

  private async awaitPresentationCheckpoint(
    checkpoint: AppPresentationCheckpoint,
  ): Promise<void> {
    const observer = this.presentationObserver;
    if (!observer?.onPresentationCheckpoint) return;
    try {
      await observer.onPresentationCheckpoint(Object.freeze(checkpoint));
    } catch {
      // 被拒绝/已过期的夹具栅栏不得使已接受结果失败。 / English: Rejected/expired fixture fences must not fail accepted results.
    }
    this.assertRoundPresentationActive();
  }

  private requestPresentationCheckpoint(
    checkpoint: AppPresentationCheckpoint,
  ): void | Promise<void> {
    const observer = this.presentationObserver;
    if (!observer?.onPresentationCheckpoint) return;
    try {
      const pending = observer.onPresentationCheckpoint(Object.freeze(checkpoint));
      if (!pending) return;
      // 可选夹具栅栏采用故障开放；任何拒绝都不得进入游戏逻辑。 / English: The optional clamp fence is fail-open; any rejections are not allowed into the game logic.
      return Promise.resolve(pending).catch(() => undefined);
    } catch {
      return;
    }
  }

  private requestFeaturePresentationInputCheckpoint(
    gate: FeaturePresentationInputGate,
  ): void | Promise<void> {
    const sequence = this.activePresentationSequence;
    if (sequence === null) return;
    return this.requestPresentationCheckpoint({
      type: "bounded-gate-input-ready",
      gate,
      sequence,
    });
  }

  private requestSemanticPresentationCheckpoint(
    state: AppSemanticPresentationState,
  ): void | Promise<void> {
    const sequence = this.activePresentationSequence;
    if (sequence === null) return;
    return this.requestPresentationCheckpoint({
      type: "semantic-state",
      state,
      sequence,
    });
  }

  private requestVaultUnlockPresentationCheckpoint(
    phase: "vault-unlock.locked" | VaultUnlockPresentationPhase,
    event: Readonly<VaultUnlockedEvent>,
  ): void | Promise<void> {
    const sequence = this.activePresentationSequence;
    if (sequence === null || this.snapshot.featureState.mode !== "BASE") return;
    return this.requestPresentationCheckpoint({
      type: "vault-unlock-phase",
      phase,
      sequence,
      cell: Object.freeze({ reel: event.reel, row: event.row }),
      prize: event.prize,
      ...(event.multiplier === undefined ? {} : { multiplier: event.multiplier }),
    });
  }

  private observeVaultUnlockPresentationMilestone(
    milestone: Readonly<VaultUnlockPresentationMilestone>,
  ): void | Promise<void> {
    return this.requestVaultUnlockPresentationCheckpoint(
      milestone.phase,
      milestone.event,
    );
  }

  private async awaitSemanticPresentationCheckpoint(
    state: AppSemanticPresentationState,
  ): Promise<void> {
    const sequence = this.activePresentationSequence;
    if (sequence === null || !this.presentationObserver?.onPresentationCheckpoint) return;
    await this.awaitPresentationCheckpoint({
      type: "semantic-state",
      state,
      sequence,
    });
  }

  private presentObservedNormalWinCounter(
    sequence: number,
    totalWinMinor: MoneyMinor,
    betMinor: MoneyMinor,
    reducedMotion: boolean,
    displayTotalMinor: MoneyMinor,
    displayStartMinor: MoneyMinor,
    fastPlay: boolean,
  ): Promise<void> {
    if (!this.presentationObserver?.onPresentationTrace) {
      return this.presentNormalWinCounter(
        totalWinMinor,
        betMinor,
        reducedMotion,
        displayTotalMinor,
        displayStartMinor,
        fastPlay,
      );
    }
    this.emitPresentationTrace({
      type: "counter.started",
      sequence,
      totalWinMinor,
      displayStartMinor,
      displayTotalMinor,
    });
    return this.presentNormalWinCounter(
      totalWinMinor,
      betMinor,
      reducedMotion,
      displayTotalMinor,
      displayStartMinor,
      fastPlay,
    ).then(() => {
      this.emitPresentationTrace({
        type: "counter.completed",
        sequence,
        totalWinMinor,
        displayStartMinor,
        displayTotalMinor,
      });
    });
  }

  private async presentNormalWinCounter(
    totalWinMinor: MoneyMinor,
    betMinor: MoneyMinor,
    reducedMotion: boolean,
    displayTotalMinor: MoneyMinor = totalWinMinor,
    displayStartMinor: MoneyMinor = "0",
    fastPlay = false,
  ): Promise<void> {
    const durationMs = normalWinCounterDurationMs(totalWinMinor, betMinor, fastPlay);
    if (durationMs === null) return;
    const audible = isCelebratoryWin(totalWinMinor, betMinor);
    if (audible) this.audio.beginNormalWinCounter({ intensity: 1, reducedMotion });
    try {
      await Promise.all([
        this.ui.presentWinCounter(displayTotalMinor, durationMs, displayStartMinor),
        this.normalWinDelay(durationMs),
      ]);
    } finally {
      if (audible) this.audio.endNormalWinCounter({ intensity: 1, reducedMotion });
    }
    await this.normalWinDelay(NORMAL_WIN_COUNTER_TAIL_HOLD_MS);
  }

  private normalWinDelay(durationMs: number): Promise<void> {
    if (this.normalWinFinishRequested) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (this.normalWinDelayResolver === finish) this.normalWinDelayResolver = null;
        resolve();
      };
      this.normalWinDelayResolver = finish;
      void this.presentationDelay(durationMs).then(finish);
      if (this.normalWinFinishRequested) finish();
    });
  }

  /**
   * 启动官方就绪状态重复，但不重放首次显示的符号 `win` 片段。WinCelebration 仍拥有
   * WinBox/WinLabel 和非中奖符号变暗；已结算的聚合信息保留在 DomOverlay 中。
   *
   * 英文 / English: Starts official ready state repetition without replaying the first displayed symbol `win` fragment. WinCelebration still has WinBox/WinLabel and non-winning symbols dimming; settled aggregate information remains in the DomOverlay.
   */
  private schedulePostWinIdleRepeat(
    result: Readonly<SpinResult>,
    previousFeatureState: Readonly<FeatureState>,
    reducedMotion: boolean,
    fastPlay: boolean,
  ): void {
    this.clearPostWinIdleRepeatTimer();
    if (this.suppressPostWinIdleRepeat) return;
    const paidWins = result.wins.filter((win) => BigInt(win.amountMinor) > 0n);
    const returnedBaseWin = previousFeatureState.mode === "BASE"
      && result.featureState.mode === "BASE"
      && paidWins.length > 0;
    const wheelOwnsReturnedRecord = result.events.some((event) => (
      event.type === "wheel.started" || event.type === "wheel.awarded"
    ));
    if (!returnedBaseWin || wheelOwnsReturnedRecord) return;

    const previousGeneration = Number.isSafeInteger(this.postWinIdleRepeatGeneration)
      ? this.postWinIdleRepeatGeneration
      : 0;
    const generation = previousGeneration + 1;
    this.postWinIdleRepeatGeneration = generation;
    const wins = paidWins.map((win) => immutableClone(win));
    this.postWinIdleRepeatTimer = setTimeout(() => {
      this.postWinIdleRepeatTimer = null;
      if (this.destroyed || generation !== this.postWinIdleRepeatGeneration) return;
      this.postWinIdleRepeatActive = true;
      void this.runPostWinIdleRepeat(wins, generation, reducedMotion, fastPlay)
        .catch(() => undefined)
        .finally(() => {
          if (generation === this.postWinIdleRepeatGeneration) {
            this.postWinIdleRepeatActive = false;
          }
        });
    }, PRIMAL_POST_WIN_IDLE_INTRO_MS);
  }

  private async runPostWinIdleRepeat(
    wins: readonly Win[],
    generation: number,
    reducedMotion: boolean,
    fastPlay: boolean,
  ): Promise<void> {
    if (wins.length === 1) {
      await this.renderer.winCelebration.present(
        wins,
        reducedMotion,
        Number.POSITIVE_INFINITY,
      );
      return;
    }

    while (!this.destroyed && generation === this.postWinIdleRepeatGeneration) {
      for (const win of wins) {
        if (this.destroyed || generation !== this.postWinIdleRepeatGeneration) return;
        const holdDurationMs = primalWinRecordHoldDurationMs(win, {
          recordCount: wins.length,
          counterDurationMs: 0,
          repeat: true,
          fastPlay,
        });
        await this.renderer.winCelebration.present(
          [win],
          reducedMotion,
          holdDurationMs,
          undefined,
          true,
        );
      }
    }
  }

  private clearPostWinIdleRepeatTimer(): void {
    if (this.postWinIdleRepeatTimer == null) return;
    clearTimeout(this.postWinIdleRepeatTimer);
    this.postWinIdleRepeatTimer = null;
  }

  private stopPostWinIdleRepeat(): void {
    const previousGeneration = Number.isSafeInteger(this.postWinIdleRepeatGeneration)
      ? this.postWinIdleRepeatGeneration
      : 0;
    this.postWinIdleRepeatGeneration = previousGeneration + 1;
    this.clearPostWinIdleRepeatTimer();
    if (!this.postWinIdleRepeatActive) return;
    this.postWinIdleRepeatActive = false;
    this.renderer.winCelebration.requestFinish();
  }

  private presentRoundWinCharacterAudio(presentation: CharacterWinPresentation): void {
    const reducedMotion = this.reducedMotionMedia?.matches ?? this.reducedMotion;
    if (presentation === "base") {
      this.audio.playMonsterRoar({ intensity: 1, reducedMotion });
    } else {
      this.audio.playMonsterRoarHit({ intensity: 1, reducedMotion });
    }
  }

  private createBigWinPlan(totalWinMinor: MoneyMinor, betMinor: MoneyMinor): BigWinPlan | null {
    if (!/^(0|[1-9]\d*)$/.test(totalWinMinor) || !/^[1-9]\d*$/.test(betMinor)) return null;
    try {
      return planBigWin(BigInt(totalWinMinor), BigInt(betMinor));
    } catch {
      return null;
    }
  }

  private syncGameMusic(): void {
    const reducedMotion = this.reducedMotionMedia?.matches ?? this.reducedMotion;
    if (this.snapshot.featureState.mode !== "BASE") {
      this.audio.setFreeSpinsMusicEnabled(true, { intensity: 1, reducedMotion });
      return;
    }
    this.audio.setAmbientEnabled(true, { intensity: 1, reducedMotion });
  }

  private presentationDelay(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, durationMs)));
  }

  private syncLaunchUi(): void {
    const phase = this.launch.phase;
    try {
      this.presentationObserver?.onLaunchPhase?.(phase);
    } catch {
      // 表现观察者仅为可选诊断。 / English: Performance Observer is an optional diagnosis only.
    }
    // Primal Rampage 桌面端介绍没有可见的“跳过介绍 / Esc”提示。 / English: Primal Rampage desktop intro has no visible "skip intro / Esc" prompt.
    // 底层介绍生命周期仍会正常完成；仅抑制未观察到的本地自创交互入口。 / English: The underlying introduction lifecycle will still complete normally; only unobserved local self-created interaction entries are suppressed.
    this.ui.setLaunchPhase(phase, false);
    if (phase === "waiting-session" || phase === "ready") {
      this.ui.setHudReveal(1);
      this.renderer.setJackpotHudReveal(1);
    }
  }
}
