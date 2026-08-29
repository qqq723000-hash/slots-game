import { Vector2 } from "@pixi-spine/base";
import { Circle, Container, Graphics, Point, Rectangle, Sprite, Text, TextStyle, Texture } from "pixi.js";
import { ENERGY_FRAME_GRID, PRIMAL_ASSETS } from "../assets/PrimalAssetManifest";
import type {
  CellAddress,
  FeatureEvent,
  FreeSpinAwardedEvent,
  FreeSpinsCompletedEvent,
  FreeSpinsStartedEvent,
  GridExpandedEvent,
  InstantWheelAwardedEvent,
  MoneyMinor,
  SurgeCollectedEvent,
  VaultGroupEvent,
  VaultUnlockedEvent,
  VaultUpgradedEvent,
  WheelAwardedEvent,
} from "../app/state/types";
import {
  DEFAULT_MINOR_UNIT_FORMATTER,
  type MinorUnitFormatter,
} from "../protocol/moneyFormatter";
import {
  PRIMAL_CHARACTER_ANIMATION_MS,
  PRIMAL_EXPANSION_TIMING_MS,
  PRIMAL_FEATURE_ANIMATION_MS,
  PRIMAL_SYMBOL_ANIMATION_MS,
  primalRageCascadeCellOrder,
} from "../reels/primalAnimationTiming";
import type { ReelSetView } from "../reels/ReelSetView";
import {
  SPINE_DEFAULT_MIX_SECONDS,
  createSpineView,
  type Spine,
  type SpineData,
} from "./spine/SpineAdapter";
import { loadPrimalSpineSet } from "./spine/PrimalSpineAssets";
import {
  FREE_SPIN_VERIFIED_SPINE_KEYS,
  WHEEL_VERIFIED_SPINE_KEYS,
  disposeVerifiedWheelArtwork,
  type VerifiedFreeSpinArtwork,
  type VerifiedWheelArtwork,
} from "./VerifiedFeatureArtwork";
import {
  PRIMAL_PANEL_LAYOUT,
  SpineTextBinding,
  freeSpinIntroTextFields,
  freeSpinSummaryTextFields,
  wheelSummaryTextFields,
  type AuthoredPanelLayout,
  type PrimalPanelTextField,
} from "./PrimalPanelText";
import type { ResponsiveRendererRegion } from "./ResponsiveLayout";
import {
  type VisualTelemetryDescriptor,
  type VisualTelemetryFailure,
  type VisualTelemetryId,
  type VisualTelemetryOperation,
  type VisualTelemetryReporter,
} from "./VisualTelemetry";
import { COLORS, LOGICAL_HEIGHT, LOGICAL_WIDTH } from "./theme";
import {
  PRIMAL_WHEEL_BOUNDED_PRESENTATION_MS,
  PRIMAL_WHEEL_POPUP_TIMELINE_MS,
  PRIMAL_WHEEL_SEGMENTS,
  PRIMAL_WHEEL_TIMELINE_MS,
  createPrimalWheelSpinPlan,
  primalWheelIdleState,
  primalWheelQuickStopElapsed,
  primalWheelRuntimeTimeline,
  primalWheelSpinFrame,
  resolvePrimalWheelSegment,
  type PrimalWheelAwardSelection,
  type PrimalWheelIdleState,
  type PrimalWheelRuntimeTimeline,
  type PrimalWheelSpeed,
  type PrimalWheelSpinFrame,
  type PrimalWheelSpinPlan,
} from "./wheelMotion";

export {
  PRIMAL_WHEEL_AWARD_IDS,
  PRIMAL_WHEEL_BOUNDED_PRESENTATION_MS,
  PRIMAL_WHEEL_POPUP_TIMELINE_MS,
  PRIMAL_WHEEL_SEGMENTS,
  PRIMAL_WHEEL_TIMELINE_MS,
  WHEEL_CHARACTER_TIMING_MS,
  createPrimalWheelSpinPlan,
  primalWheelIdleState,
  primalWheelLandingAngle as wheelLandingAngle,
  primalWheelQuickStopElapsed,
  primalWheelRotationDegrees,
  primalWheelRuntimeTimeline,
  primalWheelSpinFrame,
  resolvePrimalWheelSegment,
} from "./wheelMotion";

const FEATURE_TEXTURE_URLS: readonly string[] = Object.freeze([
  // Rage 已由符号首包拥有；Wheel 三纹理改由 feature-wheel 事件租约直接解码。 / English: Rage is already owned by the symbol header package; Wheel three textures are instead directly decoded by feature-wheel event leases.
  PRIMAL_ASSETS.features.energyFrames,
]);

let featureTextureLoad: Promise<void> | null = null;
let authoredInteractionLoad: Promise<void> | null = null;
const AUTHORED_INTERACTION_SPINE_KEYS = Object.freeze([
  "trail",
] as const);
type AuthoredInteractionSpineKey = typeof AUTHORED_INTERACTION_SPINE_KEYS[number];
const authoredInteractionData: Partial<Record<AuthoredInteractionSpineKey, SpineData>> = {};

function loadAuthoredInteractionSpines(): Promise<void> {
  if (AUTHORED_INTERACTION_SPINE_KEYS.every((key) => authoredInteractionData[key])) {
    return Promise.resolve();
  }
  if (authoredInteractionLoad) return authoredInteractionLoad;
  const attempt = loadPrimalSpineSet(AUTHORED_INTERACTION_SPINE_KEYS).then((data) => {
    Object.assign(authoredInteractionData, data);
  });
  authoredInteractionLoad = attempt;
  void attempt.catch(() => {
    if (authoredInteractionLoad === attempt) authoredInteractionLoad = null;
  });
  return attempt;
}

/** 在移除发射幕之前预加载预设的功能板。 / English: Preload the preset feature board before removing the launch screen. */
export function loadFeatureTextures(): Promise<void> {
  if (featureTextureLoad) return featureTextureLoad;
  const attempt = Promise.all([
    Promise.all(FEATURE_TEXTURE_URLS.map((url) => Texture.fromURL(url))),
    loadAuthoredInteractionSpines(),
  ]).then(() => undefined);
  featureTextureLoad = attempt;
  void attempt.catch(() => {
    // 纹理和预设的 Spine 分支是入门关键。保留对 PreloadGate 的拒绝，同时保持后续启动可重试。 / English: The Spine branch of textures and presets is key to getting started. Preserve rejection of PreloadGate while keeping subsequent launches retryable.
    if (featureTextureLoad === attempt) featureTextureLoad = null;
  });
  return attempt;
}

/** 切片 GPU 预热使用的独特的已请求特征纹理。 / English: Slices unique requested feature textures used by GPU warm-up. */
export function loadedFeatureTextures(): readonly Texture[] {
  return FEATURE_TEXTURE_URLS.map((url) => Texture.from(url));
}

function authoredTexture(url: string): Texture {
  return Texture.from(url);
}

let energyFrameTextures: readonly Texture[] | null = null;

function energyFrameTexture(frame: number): Texture {
  const safeFrame = Math.max(
    ENERGY_FRAME_GRID.firstVisibleFrame,
    Math.min(ENERGY_FRAME_GRID.loopLastFrame, Math.floor(frame)),
  );
  energyFrameTextures ??= Array.from(
    { length: ENERGY_FRAME_GRID.loopLastFrame + 1 },
    (_, index) => new Texture(
      authoredTexture(PRIMAL_ASSETS.features.energyFrames).baseTexture,
      new Rectangle(
        (index % ENERGY_FRAME_GRID.columns) * ENERGY_FRAME_GRID.frameWidth,
        Math.floor(index / ENERGY_FRAME_GRID.columns) * ENERGY_FRAME_GRID.frameHeight,
        ENERGY_FRAME_GRID.frameWidth,
        ENERGY_FRAME_GRID.frameHeight,
      ),
    ),
  );
  return energyFrameTextures[safeFrame] ?? Texture.EMPTY;
}

export type FeatureEffectKind = "expansion" | "vault" | "wheel" | "collect" | "mode" | "summary" | "pulse";

/** Wheel 弹出窗口 CONTINUE 正在播放其预设的 `show` 剪辑。 / English: The Wheel popup CONTINUE is playing its preset `show` clip. */
export function wheelPopupContinueEnabled(elapsedMs: number): boolean {
  return Number.isFinite(elapsedMs)
    && elapsedMs >= 0
    && elapsedMs < PRIMAL_WHEEL_POPUP_TIMELINE_MS.show;
}

/** A 层 CONTINUE 从摘要 `show` 实时显示，而不仅仅是从其停止姿势。 / English: A layer CONTINUE is shown live from the summary `show`, not just from its stop pose. */
export function wheelSummaryContinueEnabled(
  elapsedMs: number,
  timeline: Pick<PrimalWheelRuntimeTimeline, "summaryShowAt" | "summaryHideAt">
    = PRIMAL_WHEEL_TIMELINE_MS,
): boolean {
  return Number.isFinite(elapsedMs)
    && elapsedMs >= timeline.summaryShowAt
    && elapsedMs < timeline.summaryHideAt;
}

/** 精确的 A 层 -> B 层切换；丢失/不规范的资金无法关闭。 / English: Exact Layer-A to Layer-B handoff; a missing or non-canonical amount keeps the gate closed. */
export function shouldHandoffWheelBonusLabel(
  event: WheelAwardedEvent,
  freeSpinSummary: boolean,
  elapsedMs: number,
  timeline: Pick<PrimalWheelRuntimeTimeline, "summaryHideAt" | "wheelHide">
    = PRIMAL_WHEEL_TIMELINE_MS,
): event is InstantWheelAwardedEvent {
  return !freeSpinSummary
    && event.outcome === "INSTANT"
    && CANONICAL_MONEY_MINOR.test(event.amountMinor)
    && Number.isFinite(elapsedMs)
    && elapsedMs >= timeline.summaryHideAt + timeline.wheelHide;
}

export const PRIMAL_VAULT_TEASE_TIMELINE_MS = Object.freeze({
  baseHold: 1_000,
  lockedNoWinExtraHold: 500,
  reducedMotion: 120,
});

/** GameUnlockBonusFeature 在 APE_THUMP 之后正好等待 ThumpAnimDuration。 / English: GameUnlockBonusFeature waits for ThumpAnimDuration exactly after APE_THUMP. */
export const PRIMAL_VAULT_GROUP_TIMELINE_MS = Object.freeze({
  thumpBarrier: 500,
  reducedMotion: 40,
});

export interface VaultGroupStartEvent {
  readonly type: "vaults.unlock.started" | "vaults.upgrade.started";
  readonly count: number;
}
export type VaultFrameAnimation = "vault" | "vault_lvl2" | "vault_lvl3";
export type VaultMutationEvent = Readonly<VaultUnlockedEvent | VaultUpgradedEvent>;

/** GameReelFrame.onApeThump 从 symbolCount 中选择预设的框架。 / English: GameReelFrame.onApeThump selects a preset frame from symbolCount. */
export function vaultFrameAnimation(symbolCount: number): VaultFrameAnimation {
  if (symbolCount >= 3) return "vault_lvl3";
  if (symbolCount === 2) return "vault_lvl2";
  return "vault";
}

/**
 * GameUnlockBonusFeature 调度 APE_THUMP 以及仍锁定的保管库数量。在第一个 King Spin 突变之后，这些符号已经打开，
 * 因此每个后续升级阶段都会有意回退到单 Vault 帧，即使多个寻址值一起升级也是如此。
 *
 * 英文 / English: GameUnlockBonusFeature schedules APE_THUMP with the number of vaults still locked. After the first King Spin mutation, these symbols are already turned on, so each subsequent upgrade phase intentionally falls back to a single Vault frame, even if multiple addressing values ​​are upgraded together.
 */
export function vaultGroupFrameAnimation(
  event: Pick<VaultGroupEvent, "type" | "count"> | VaultGroupStartEvent,
): VaultFrameAnimation {
  return vaultFrameAnimation(event.type === "vaults.upgrade.started" ? 1 : event.count);
}

export function vaultGroupBarrierDurationMs(reducedMotion: boolean): number {
  return reducedMotion
    ? PRIMAL_VAULT_GROUP_TIMELINE_MS.reducedMotion
    : PRIMAL_VAULT_GROUP_TIMELINE_MS.thumpBarrier;
}

export interface VaultMutationBatchPlan {
  readonly unlockCount: number;
  readonly upgradeCount: number;
  readonly durationMs: number;
}

export const PRIMAL_VAULT_UNLOCK_CHECKPOINT_MS = Object.freeze({
  firstAttachmentKey: 33.333,
  impact: 133.333,
});

export type VaultUnlockPresentationPhase =
  | "vault-unlock.enter"
  | "vault-unlock.key-1"
  | "vault-unlock.impact"
  | "vault-unlock.unlocked";

export interface VaultUnlockPresentationMilestone {
  readonly phase: VaultUnlockPresentationPhase;
  readonly event: Readonly<VaultUnlockedEvent>;
}

/**
 * GameUnlockBonusFeature 在一个循环中启动每个 Vault 突变，然后仅等待最长的预设符号剪辑。服务器事件仍然是地址和奖品的唯一来源。
 *
 * 英文 / English: GameUnlockBonusFeature starts each Vault mutation in a loop and then waits only for the longest preset symbol clip. Server events remain the only source of addresses and prizes.
 */
export function vaultMutationBatchPlan(
  events: readonly VaultMutationEvent[],
  reducedMotion: boolean,
): VaultMutationBatchPlan {
  let unlockCount = 0;
  let upgradeCount = 0;
  for (const event of events) {
    if (event.type === "vault.unlocked") unlockCount += 1;
    else upgradeCount += 1;
  }
  const durationMs = events.length === 0
    ? 0
    : reducedMotion
      ? 120
      : Math.max(
        unlockCount > 0 ? PRIMAL_SYMBOL_ANIMATION_MS[8].unlockBackup : 0,
        upgradeCount > 0 ? PRIMAL_SYMBOL_ANIMATION_MS[9].upgrade : 0,
      );
  return { unlockCount, upgradeCount, durationMs };
}

export function vaultTeaseDurationMs(
  reducedMotion: boolean,
  lockedNoWinExtraHold: boolean,
): number {
  if (reducedMotion) return PRIMAL_VAULT_TEASE_TIMELINE_MS.reducedMotion;
  return PRIMAL_VAULT_TEASE_TIMELINE_MS.baseHold
    + (lockedNoWinExtraHold ? PRIMAL_VAULT_TEASE_TIMELINE_MS.lockedNoWinExtraHold : 0);
}

/** 严格的激活路径后置条件；它永远不会在失败时开始操作。 / English: Strict activation path postcondition; it never starts operation on failure. */
export function reportVaultTeasePlaybackReadiness(
  reporter: VisualTelemetryReporter | null,
  expected: number,
  played: number,
): boolean {
  const ready = expected > 0 && played === expected;
  if (!ready) {
    reporter?.failedToStart({
      id: "vault.tease",
      requirement: "conditional",
      mode: "authored",
      clips: ["tease_in", "tease_loop", "tease_out"],
      sourceEvent: "vaults.landed",
    }, {
      stage: "animation",
      code: "missing-animation",
      fallback: "bitmap",
    });
  }
  return ready;
}

/** 捕获的 GameFreespinView 摘要序列：显示、玩家可见的按住、隐藏。 / English: Captured GameFreespinView summary sequence: show, player-visible hold, hide. */
export const FREE_SPIN_SUMMARY_TIMELINE_MS = Object.freeze({
  show: PRIMAL_FEATURE_ANIMATION_MS.freeSpinSummary.show,
  continueHold: PRIMAL_FEATURE_ANIMATION_MS.freeSpinSummary.continueHold,
  hide: PRIMAL_FEATURE_ANIMATION_MS.freeSpinSummary.hide,
  hideAt: PRIMAL_FEATURE_ANIMATION_MS.freeSpinSummary.show
    + PRIMAL_FEATURE_ANIMATION_MS.freeSpinSummary.continueHold,
  total: PRIMAL_FEATURE_ANIMATION_MS.freeSpinSummary.show
    + PRIMAL_FEATURE_ANIMATION_MS.freeSpinSummary.continueHold
    + PRIMAL_FEATURE_ANIMATION_MS.freeSpinSummary.hide,
});

/** Free Spins 摘要 CONTINUE 在 `show` 之后打开并在隐藏边界处关闭。 / English: Free Spins Summary CONTINUE opens after `show` and closes at hidden boundaries. */
export function freeSpinSummaryContinueEnabled(elapsedMs: number): boolean {
  return Number.isFinite(elapsedMs)
    && elapsedMs >= FREE_SPIN_SUMMARY_TIMELINE_MS.show
    && elapsedMs < FREE_SPIN_SUMMARY_TIMELINE_MS.hideAt;
}

const CANONICAL_MONEY_MINOR = /^(0|[1-9]\d*)$/;
export const FREE_SPIN_NO_WIN_COPY = "NO WIN, FREE SPINS CONCLUDED";
/** 两人都预设了 King/Kong 介绍绑定 `%d=8`，与运行时状态无关。 / English: Both default to the King/Kong intro binding `%d=8`, regardless of runtime state. */
export const FREE_SPIN_INTRO_DISPLAY_AWARDED = 8;

/** 捕获的功能名称由非 Spine 回退路径介绍面板镜像。 / English: Captured feature names are introduced by the non-Spine fallback path panel mirror. */
export function freeSpinModeTitle(mode: FreeSpinsStartedEvent["mode"]): "KONG QUEST" | "KING SPIN" {
  return mode === "OVERDRIVE" ? "KING SPIN" : "KONG QUEST";
}

/** 两个捕获的免费 Spin 面板均以 `show` 开始其布料运动。 / English: Both captured free Spin panels start their cloth motion with `show`. */
export function freeSpinIntroRagsStartPhase(
  _mode: FreeSpinsStartedEvent["mode"],
): "entry" {
  return "entry";
}

/**
 * GameFreespinController 将 `totalWin > betCoins` 添加到共享摘要门。将比较保持在规范的小单位中，
 * 这样非常大的线值就不会通过 JavaScript 数字转换而失去精度。
 *
 * 英文 / English: GameFreespinController Add `totalWin > betCoins` to the shared summary gate. Keep comparisons in small units of specification so that very large line values ​​do not lose precision through JavaScript number conversion.
 */
export function shouldPresentFreeSpinSummary(
  cumulativeWinMinor: MoneyMinor,
  betMinor: MoneyMinor,
): boolean {
  if (!CANONICAL_MONEY_MINOR.test(cumulativeWinMinor)
    || !CANONICAL_MONEY_MINOR.test(betMinor)) return false;
  return BigInt(cumulativeWinMinor) > BigInt(betMinor);
}

/** 将文本注入到预设的 fs_summary 插槽中，无需重新计算资金。 / English: Inject text into the preset fs_summary slot without recalculating funds. */
export function freeSpinSummaryTextBindings(
  event: FreeSpinsCompletedEvent,
  formatter: MinorUnitFormatter = DEFAULT_MINOR_UNIT_FORMATTER,
): readonly PrimalPanelTextField[] {
  if (!CANONICAL_MONEY_MINOR.test(event.cumulativeWinMinor)) {
    throw new Error("Authoritative Free Spins summary must use canonical minor units");
  }
  const fields = freeSpinSummaryTextFields(event, formatter);
  if (event.cumulativeWinMinor !== "0") return fields;
  return Object.freeze(fields.map((field) => Object.freeze({
    ...field,
    text: field.name === "fsSummaryCongrats" ? FREE_SPIN_NO_WIN_COPY : "",
  })));
}

const FEATURE_EFFECT_DURATION_MS: Record<FeatureEffectKind, readonly [number, number]> = {
  expansion: [
    PRIMAL_EXPANSION_TIMING_MS.controllerDelay + PRIMAL_EXPANSION_TIMING_MS.resize,
    110,
  ],
  vault: [
    PRIMAL_VAULT_GROUP_TIMELINE_MS.thumpBarrier,
    PRIMAL_VAULT_GROUP_TIMELINE_MS.reducedMotion,
  ],
  wheel: [PRIMAL_WHEEL_BOUNDED_PRESENTATION_MS, 140],
  collect: [1_250, 120],
  mode: [
    PRIMAL_FEATURE_ANIMATION_MS.freeSpinIntro.show
      + PRIMAL_FEATURE_ANIMATION_MS.freeSpinIntro.ragsLoop
      + PRIMAL_FEATURE_ANIMATION_MS.freeSpinIntro.hide,
    140,
  ],
  summary: [
    FREE_SPIN_SUMMARY_TIMELINE_MS.total,
    140,
  ],
  pulse: [520, 90],
};

export function featureEffectDuration(kind: FeatureEffectKind, reducedMotion: boolean): number {
  return FEATURE_EFFECT_DURATION_MS[kind][reducedMotion ? 1 : 0];
}

export const RAGE_COLLECT_SYMBOL_MS = PRIMAL_SYMBOL_ANIMATION_MS[7].collect;
export const RAGE_COLLECT_HIDE_MS = PRIMAL_SYMBOL_ANIMATION_MS[7].hide;
/** Spine 以延迟=0 对 `hide` 进行排队，因此默认的 150ms 混合重叠收集。 / English: Spine queues `hide` with delay=0, hence the default 150ms mixed overlapped collection. */
export const RAGE_COLLECT_HIDE_MIX_MS = SPINE_DEFAULT_MIX_SECONDS * 1_000;
export const RAGE_COLLECT_HIDE_START_MS = Math.max(
  0,
  RAGE_COLLECT_SYMBOL_MS - RAGE_COLLECT_HIDE_MIX_MS,
);
export const RAGE_COLLECT_FULLY_HIDDEN_MS =
  RAGE_COLLECT_HIDE_START_MS + RAGE_COLLECT_HIDE_MS;
export const RAGE_COLLECT_TRAIL_MS = 1_200;
export const RAGE_COLLECT_CHARACTER_MS = PRIMAL_CHARACTER_ANIMATION_MS.rageCollect;
/** 稳定对比样本：MINI、MINOR 和 MAJOR 已从 0/200/400ms 开始。 / English: Stable comparison samples: MINI, MINOR and MAJOR have started at 0/200/400ms. */
export const RAGE_COLLECT_ABSORBING_MS = 500;
export const RAGE_GUARANTEED_STOP_OUTRO_MS = 1_250;

export interface RageCollectionPlan {
  readonly kind: "consume-batch" | "guaranteed-activation";
  /** 原始集合是一个同步批次；没有人为的每个单元格交错。 / English: The original set is a synchronized batch; there is no artificial per-cell interleaving. */
  readonly cellStartMs: readonly number[];
  readonly symbolLayerRestoreAtMs: number | null;
  readonly symbolHideStartAtMs: number | null;
  readonly symbolHideAtMs: number | null;
  readonly trailEndMs: number | null;
  readonly presentationMs: number;
  readonly characterMs: number;
}

/** 从 GamePPSFeature 和 GameSymbol 恢复精确的分支分裂。 / English: Restore accurate branch splitting from GamePPSFeature and GameSymbol. */
export function rageCollectionPlan(count: number, guaranteed: boolean): RageCollectionPlan {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Rage count must be positive");
  if (guaranteed) {
    return {
      kind: "guaranteed-activation",
      cellStartMs: Array.from({ length: count }, () => 0),
      symbolLayerRestoreAtMs: null,
      symbolHideStartAtMs: null,
      symbolHideAtMs: null,
      trailEndMs: null,
      presentationMs: RAGE_GUARANTEED_STOP_OUTRO_MS,
      characterMs: PRIMAL_CHARACTER_ANIMATION_MS.featureActivation,
    };
  }
  return {
    kind: "consume-batch",
    cellStartMs: Array.from({ length: count }, () => 0),
    symbolLayerRestoreAtMs: RAGE_COLLECT_SYMBOL_MS,
    symbolHideStartAtMs: RAGE_COLLECT_HIDE_START_MS,
    symbolHideAtMs: RAGE_COLLECT_FULLY_HIDDEN_MS,
    trailEndMs: RAGE_COLLECT_TRAIL_MS,
    presentationMs: RAGE_COLLECT_TRAIL_MS,
    characterMs: RAGE_COLLECT_CHARACTER_MS,
  };
}

export type RageCollectionEffectPhase =
  | "started"
  | "absorbing"
  | "source-hidden"
  | "complete";

/**
 * 来自预设的 Rage 集合的仅渲染器事实。它们是诊断输出，从不提供协议、RNG、结算或状态转换。
 *
 * 英文 / English: Renderer-only facts from the preset Rage collection. They are diagnostic output and never provide protocol, RNG, settlement or state transitions.
 */
export interface RageCollectionEffectMilestone {
  readonly phase: RageCollectionEffectPhase;
  readonly cells: readonly Readonly<CellAddress>[];
  /** 接受的服务器结果事实；仅诊断输出。 / English: Accepted server result facts; diagnostic output only. */
  readonly count: number;
  readonly triggered: boolean;
  readonly guaranteed: boolean;
  readonly level: number;
  readonly total: number;
  /** 本地真实表现时间；仅通过缩减运动模式进行压缩。 / English: Local real performance time; compressed by reduced motion mode only. */
  readonly elapsedMs: number;
  /** 相应预设的桌面时间线点。 / English: The corresponding preset desktop timeline point. */
  readonly authoredAtMs: number;
  readonly reducedMotion: boolean;
  readonly activated: boolean;
  readonly hidden: boolean;
  readonly towerReactionStarted: boolean;
}

export type SurgePresentationBranch =
  | "collect"
  | "post-stop-activation"
  | "cascade-on-transform";

/** 使用有线事实镜像 GamePPSFeature 的 `_explodedReel.length` 分支。 / English: Use the `_explodedReel.length` branch of the wired fact mirror GamePPSFeature. */
export function surgePresentationBranch(
  triggered: boolean,
  guaranteed: boolean,
): SurgePresentationBranch {
  if (!triggered) return "collect";
  return guaranteed ? "post-stop-activation" : "cascade-on-transform";
}

export type RageCascadeMilestone =
  | Readonly<{ type: "cell"; atMs: number; cellIndex: number }>
  | Readonly<{ type: "backdrop-shake"; atMs: number; phase: "respin" | "pound" }>
  | Readonly<{ type: "pound"; atMs: number }>
  | Readonly<{ type: "activation"; atMs: number }>;

export interface RageCascadePlan {
  readonly respinAtMs: 0;
  readonly milestones: readonly RageCascadeMilestone[];
  readonly cascadeCompleteAtMs: number;
  readonly poundAtMs: number;
  readonly activationAtMs: number;
  readonly totalMs: number;
}

export type RageCascadeEffectPhase =
  | "started"
  | "exploding"
  | "placed"
  | "pound"
  | "activation"
  | "source-hidden"
  | "complete";

export type RageCascadeShakePhase = "respin" | "pound";

export interface RageCascadeShuffledCell {
  readonly orderIndex: number;
  readonly cellIndex: number;
  readonly address: Readonly<CellAddress>;
  readonly transformsToRage: boolean;
  readonly authoredAtMs: number;
  readonly elapsedMs: number;
}

const EMPTY_RAGE_CASCADE_SHUFFLED_CELLS: readonly Readonly<RageCascadeShuffledCell>[]
  = Object.freeze([]);

/**
 * 用于确定性捕获的只读渲染器事实。他们可以观察预设的级联，但无法选择变换单元或任何游戏结果。
 *
 * 英文 / English: Read-only renderer fact for deterministic capture. They can observe preset cascades but cannot choose transform units or any game outcomes.
 */
export interface RageCascadeEffectMilestone {
  readonly phase: RageCascadeEffectPhase;
  /** 预设的 4120ms 桌面时间线上的对应点。 / English: Corresponding point on the default 4120ms desktop timeline. */
  readonly authoredAtMs: number;
  /** 本地挂钟点；按比例压缩以减少运动。 / English: Local wall clock point; scaled to reduce motion. */
  readonly elapsedMs: number;
  readonly reducedMotion: boolean;
  readonly transformedCells: readonly Readonly<CellAddress>[];
  /** 完整的化妆品遍历计划，仅由 `exploding` 填充。 / English: Complete cosmetic traversal plan, populated only by `exploding`. */
  readonly shuffledCells: readonly Readonly<RageCascadeShuffledCell>[];
  readonly activationAttempted: number;
  readonly activationPlayed: number;
  readonly shakePhase: RageCascadeShakePhase | null;
  readonly shakeAuthoredAtMs: number | null;
  readonly shakeElapsedMs: number | null;
  readonly hidden: boolean;
}

export type RageCascadeEffectMilestoneListener = (
  milestone: Readonly<RageCascadeEffectMilestone>,
) => void;

/** 仅进行装饰性遍历。返回值必须是排列 0..8。 / English: Only decorative traversal is performed. The return value must be permutation 0..8. */
export type RageCascadeCellOrderSource = () => readonly number[];

export const defaultRageCascadeCellOrderSource: RageCascadeCellOrderSource = () => (
  primalRageCascadeCellOrder()
);

/**
 * 从桌面捆绑包中恢复了精确的 GamePPSFeature 状态机计划。 `cellOrder` 必须是控制器的洗牌卷轴主 0..8 组。
 *
 * 英文 / English: Restored accurate GamePPSFeature state machine scheme from desktop bundle. `cellOrder` must be the controller's shuffle reel master 0..8 group.
 */
export function rageCascadePlan(cellOrder: readonly number[]): RageCascadePlan {
  const timing = PRIMAL_FEATURE_ANIMATION_MS.rageCascade;
  if (cellOrder.length !== timing.explosionCells
    || new Set(cellOrder).size !== timing.explosionCells
    || cellOrder.some((cell) => !Number.isInteger(cell) || cell < 0 || cell >= timing.explosionCells)) {
    throw new Error("Rage cascade order must be a permutation of cells 0..8");
  }

  const cascadeCompleteAtMs = timing.swing
    + timing.perCellExplosion * timing.explosionCells;
  const poundAtMs = cascadeCompleteAtMs + timing.cooldown;
  const activationAtMs = poundAtMs + timing.pound;
  const milestones: RageCascadeMilestone[] = [
    ...cellOrder.map((cellIndex, orderIndex): RageCascadeMilestone => ({
      type: "cell",
      atMs: timing.swing + orderIndex * timing.perCellExplosion,
      cellIndex,
    })),
    { type: "backdrop-shake", atMs: timing.respinShakeDelay, phase: "respin" },
    { type: "pound", atMs: poundAtMs },
    { type: "activation", atMs: activationAtMs },
    {
      type: "backdrop-shake",
      atMs: poundAtMs + timing.poundShakeDelay,
      phase: "pound",
    },
  ];
  milestones.sort((left, right) => left.atMs - right.atMs);

  return {
    respinAtMs: 0,
    milestones,
    cascadeCompleteAtMs,
    poundAtMs,
    activationAtMs,
    totalMs: activationAtMs + timing.activationHold,
  };
}

export const REEL_EXPANSION_DELAY_MS = PRIMAL_EXPANSION_TIMING_MS.controllerDelay;
export const REEL_EXPANSION_RESIZE_MS = PRIMAL_EXPANSION_TIMING_MS.resize;
export const REEL_SHRINK_DATA_DELAY_MS = PRIMAL_EXPANSION_TIMING_MS.shrinkDataDelay;
export const REEL_SHRINK_RESIZE_DELAY_MS = PRIMAL_EXPANSION_TIMING_MS.shrinkResizeDelay;

export type ReelStructureDirection = "expand" | "shrink" | "same";
export type AnimatedReelStructureDirection = Exclude<ReelStructureDirection, "same">;

export interface ReelResizePlan {
  readonly direction: ReelStructureDirection;
  readonly dataAtMs: number;
  readonly resizeAtMs: number;
  readonly resizeDurationMs: number;
  readonly totalMs: number;
}

/** 捕获了 GameReelExpandController 调度，包括其两阶段收缩。 / English: Captured the GameReelExpandController dispatch, including its two-phase shrink. */
export function reelResizePlan(
  fromRows: number,
  toRows: number,
  reducedMotion = false,
): ReelResizePlan {
  const direction = toRows === fromRows ? "same" : toRows < fromRows ? "shrink" : "expand";
  if (reducedMotion) {
    const totalMs = featureEffectDuration("expansion", true);
    return { direction, dataAtMs: 0, resizeAtMs: 0, resizeDurationMs: totalMs, totalMs };
  }
  const dataAtMs = direction === "shrink" ? REEL_SHRINK_DATA_DELAY_MS : REEL_EXPANSION_DELAY_MS;
  const resizeAtMs = direction === "shrink" ? REEL_SHRINK_RESIZE_DELAY_MS : REEL_EXPANSION_DELAY_MS;
  return {
    direction,
    dataAtMs,
    resizeAtMs,
    resizeDurationMs: REEL_EXPANSION_RESIZE_MS,
    totalMs: resizeAtMs + REEL_EXPANSION_RESIZE_MS,
  };
}

function inOutQuad(value: number): number {
  const progress = clamp(value);
  return progress < 0.5
    ? 2 * progress * progress
    : 1 - ((-2 * progress + 2) ** 2) / 2;
}

/** 精确的原始调整大小延迟、持续时间和缓动以毫秒为单位采样。 / English: Accurate raw resize delay, duration and easing sampled in milliseconds. */
export function reelExpansionProgress(elapsedMs: number, reducedMotion = false): number {
  if (reducedMotion) return clamp(elapsedMs / featureEffectDuration("expansion", true));
  return inOutQuad((elapsedMs - REEL_EXPANSION_DELAY_MS) / REEL_EXPANSION_RESIZE_MS);
}

export function reelResizeProgress(
  elapsedMs: number,
  fromRows: number,
  toRows: number,
  reducedMotion = false,
): number {
  const plan = reelResizePlan(fromRows, toRows, reducedMotion);
  return inOutQuad((elapsedMs - plan.resizeAtMs) / plan.resizeDurationMs);
}

/**
 * GameMultiCharacterController 和 GameReelFrameView 都会在选择创作反应之前将新高度与之前的高度进行比较。
 * 通用调整大小控制器仍然保持其门的高度不变，但 `reel_stretch` 和 `reel_smash` 都不会在该分支中播放。
 *
 * 英文 / English: Both GameMultiCharacterController and GameReelFrameView compare the new height to the previous height before selecting a creative response. The universal resize controller still keeps the height of its gate, but neither `reel_stretch` nor `reel_smash` will play in that branch.
 */
export function reelStructureAnimation(
  direction: ReelStructureDirection,
): "reel_stretch" | "reel_smash" | null {
  if (direction === "same") return null;
  return direction === "expand" ? "reel_stretch" : "reel_smash";
}

export const AUTHORED_WHEEL_LAYOUT = Object.freeze({
  x: LOGICAL_WIDTH / 2,
  y: 440,
  scale: 0.8,
  diameter: 659 * 0.8,
});

/** 来自官方 1280x720 弹出合成的像素拟合，独立于 Wheel 几何形状。 / English: Pixel fitting from official 1280x720 pop-up composition, independent of Wheel geometry. */
export const PRIMAL_WHEEL_POPUP_LAYOUT = Object.freeze({
  x: LOGICAL_WIDTH / 2,
  y: 356,
  scale: 0.64,
});

export function wheelResponsiveLayoutTrack(
  viewportWidth: number,
  viewportHeight: number,
): "layout/horizontal" | "layout/vertical" {
  return viewportWidth > viewportHeight ? "layout/horizontal" : "layout/vertical";
}

export type ResponsiveSpineLayoutTrack = ReturnType<typeof wheelResponsiveLayoutTrack>;

/** 物理视口内 1280x720 Wheel 场景的根投影。 / English: The root projection of the 1280x720 Wheel scene within the physical viewport. */
export function wheelStageOverlayTransform(region: ResponsiveRendererRegion) {
  // 预设的场景是720px高。在纵向中，仅宽度就足够了，但会在较短的手机横向区域中裁剪滚轮和超旋转控件（例如 844x372）。 / English: The default scene is 720px high. In portrait, width alone is enough, but will crop the scroll wheel and hyperrotation controls in the shorter landscape area of ​​the phone (e.g. 844x372).
  const scale = Math.min(
    1,
    Math.max(0, region.width / 600),
    Math.max(0, region.height / LOGICAL_HEIGHT),
  );
  return Object.freeze({
    x: region.left + region.width / 2 - LOGICAL_WIDTH / 2 * scale,
    y: region.top + region.height / 2 - LOGICAL_HEIGHT / 2 * scale,
    scale,
  });
}

function responsiveSpineLayoutAnimation(
  spine: Spine,
  desired: ResponsiveSpineLayoutTrack,
): string | null {
  const short = desired.endsWith("horizontal") ? "horizontal" : "vertical";
  for (const candidate of [desired, short]) {
    if (spine.state.hasAnimation(candidate)) return candidate;
  }
  return null;
}

/**
 * 捕获从原始 1600x900 舞台投影的桌面控件。 `wheelButton` 是 true 600x600 圆形命中目标。
 * 超自旋 Spine 位于现有 93.6px DOM Spin 控制之上，由原始 `buttonWidth * buttonEffectScale * .008` 变换控制。
 *
 * 英文 / English: Capture desktop controls projected from the original 1600x900 stage. `wheelButton` is a true 600x600 circular hit target. The superspin Spine sits on top of the existing 93.6px DOM Spin control, controlled by the original `buttonWidth * buttonEffectScale * .008` transform.
 */
export const PRIMAL_WHEEL_CONTROL_LAYOUT = Object.freeze({
  sourceHitDiameter: 600,
  hitDiameter: 600 * 0.8,
  x: AUTHORED_WHEEL_LAYOUT.x,
  y: AUTHORED_WHEEL_LAYOUT.y,
  spinTextSourceSize: 150,
  spinTextSize: 150 * 0.8,
  spinTextLetterSpacing: 10 * 0.8,
  hyperspinX: 1_207.6,
  hyperspinY: 641.52,
  hyperspinScale: 93.6 * 0.008,
});

export interface WheelControlProjectionRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface WheelControlMetrics {
  readonly buttonRect: WheelControlProjectionRect;
  readonly canvasRect: WheelControlProjectionRect;
  readonly rendererWidth: number;
  readonly rendererHeight: number;
}

export type WheelControlMetricsSource = () => Readonly<WheelControlMetrics> | null;

/** 将官方 DOM Spin 控制投影镜像到变换后的 Wheel 场景中。 / English: Mirror the official DOM Spin control projection into the transformed Wheel scene. */
export function projectWheelHyperspinControl(
  metrics: Readonly<WheelControlMetrics>,
  scene: Readonly<{ x: number; y: number; scale: number }>,
): Readonly<{ x: number; y: number; scale: number }> | null {
  const values = [
    metrics.buttonRect.left, metrics.buttonRect.top,
    metrics.buttonRect.width, metrics.buttonRect.height,
    metrics.canvasRect.left, metrics.canvasRect.top,
    metrics.canvasRect.width, metrics.canvasRect.height,
    metrics.rendererWidth, metrics.rendererHeight,
    scene.x, scene.y, scene.scale,
  ];
  if (!values.every(Number.isFinite)
    || metrics.buttonRect.width <= 0 || metrics.buttonRect.height <= 0
    || metrics.canvasRect.width <= 0 || metrics.canvasRect.height <= 0
    || metrics.rendererWidth <= 0 || metrics.rendererHeight <= 0
    || scene.scale <= 0) return null;
  const sx = metrics.rendererWidth / metrics.canvasRect.width;
  const sy = metrics.rendererHeight / metrics.canvasRect.height;
  const rendererX = (
    metrics.buttonRect.left + metrics.buttonRect.width / 2 - metrics.canvasRect.left
  ) * sx;
  const rendererY = (
    metrics.buttonRect.top + metrics.buttonRect.height / 2 - metrics.canvasRect.top
  ) * sy;
  const rendererScale = metrics.buttonRect.width * sx * 0.008;
  const projection = {
    x: (rendererX - scene.x) / scene.scale,
    y: (rendererY - scene.y) / scene.scale,
    scale: rendererScale / scene.scale,
  };
  return Object.values(projection).every(Number.isFinite) && projection.scale > 0
    ? Object.freeze(projection)
    : null;
}

/** 轮子的清理路径在其权威着陆之前被取消。 / English: The wheel's clearing path was lifted before its authoritative landing. */
export function shouldAbortWheelPresentation(started: boolean, finished: boolean): boolean {
  return started && !finished;
}

export interface FeaturePresentationPlan {
  /** 结构效应可能会在服务器网格停止之前运行。 / English: Structural effects may run before the server grid is stopped. */
  readonly beforeReels: readonly GridExpandedEvent[];
  /** 用于所有结果公告/效果的规范服务器顺序。 / English: Canonical server order used for all result announcements/effects. */
  readonly orderedEvents: readonly FeatureEvent[];
}

/** 保持线阵列不变，同时暴露其预卷轴结构线索。 / English: Keeping the line array intact while exposing its pre-scroll structural cues. */
export function createFeaturePresentationPlan(
  events: readonly FeatureEvent[],
): FeaturePresentationPlan {
  return {
    beforeReels: events.filter((event): event is GridExpandedEvent => event.type === "grid.expanded"),
    orderedEvents: [...events],
  };
}

export function featureEffectLabel(
  event: FeatureEvent,
  formatter: MinorUnitFormatter = DEFAULT_MINOR_UNIT_FORMATTER,
): string {
  switch (event.type) {
    case "grid.expanded":
      return `${event.rows} ROWS // ${event.ways} WAYS`;
    case "vault.awarded":
      return `VAULT BREACH // ×${event.multiplier}`;
    case "vault.upgraded":
      return `CORE UPGRADE // ×${event.fromMultiplier} → ×${event.toMultiplier}`;
    case "surge.collected":
      if (event.guaranteed) return `CORE LOCK // ${event.count}/3 // WHEEL GUARANTEED`;
      return event.triggered
        ? `CORE LOCK // ${event.count}/3 // WHEEL READY`
        : `CORE ABSORBED // ${event.count}/3`;
    case "rage.transformed":
      return `RAGE CASCADE // +${event.count}`;
    case "wheel.started":
      return "PRIMAL WHEEL";
    case "wheel.awarded":
      return `WHEEL LOCK // ${event.outcome}${event.multiplier === undefined ? "" : ` ×${event.multiplier}`}`;
    case "free_spins.started":
      return `${event.mode} // ${event.awarded} FREE SPINS`;
    case "free_spin.awarded":
      return `EXTRA CHARGE // +${event.count}`;
    case "vaults.landed":
      return `${event.count} VAULT${event.count === 1 ? "" : "S"} LANDED`;
    case "vaults.locked":
      return "VAULTS LOCKED";
    case "vaults.unlock.started":
      return "VAULT BREACH";
    case "vaults.unlock.completed":
      return "VAULTS OPEN";
    case "vault.unlocked":
      return `VAULT REVEAL // ${event.prize}`;
    case "vaults.upgrade.started":
      return `KING UPGRADE // STEP ${event.step}`;
    case "free_spin.cap_reached":
      return "FREE SPIN LIMIT REACHED";
    case "win_cap.reached":
      return "MAXIMUM WIN REACHED";
    case "free_spins.completed":
      return `FREE SPINS COMPLETE // ${formatter.format(event.cumulativeWinMinor, false)}`;
  }
}

function normalizedWheelOutcome(outcome: string): string {
  return outcome.trim().toUpperCase().replace(/[ -]+/g, "_");
}

function wheelAnticipationSegment(rotationDegrees: number): number {
  const sectorDegrees = 360 / PRIMAL_WHEEL_SEGMENTS.length;
  const displayedRotation = Math.floor(rotationDegrees) + 360;
  for (let segment = 1; segment < PRIMAL_WHEEL_SEGMENTS.length; segment += 1) {
    if (displayedRotation < 360 - (segment - 1) * sectorDegrees
      && displayedRotation > 360 - segment * sectorDegrees) return segment;
  }
  return 0;
}

export interface WheelSpineAnimationPlan {
  readonly segment: number;
  readonly show: "show";
  readonly idle: "idle";
  readonly stop: "stop";
  readonly rotationBone: "rotate";
  readonly spinEffect: "spin_effect";
  readonly arrowGlow: "arrow_glow";
  readonly anticipationLoop: "anticipation/anticipation_loop";
  readonly anticipation: `anticipation/anticipation${number}`;
  readonly highlight: `highlights/highlight${number}`;
  readonly hide: "hide";
  readonly hidden: "hidden";
}

/**
 * 仅从 wheel.skel 中预设的七个片段中选择装饰曲目。解码的事件仍然是显示结果和奖励的唯一来源。
 *
 * 英文 / English: Select the grooming track only from the seven preset clips in wheel.skel. Decoded events remain the only source of display results and rewards.
 */
export function wheelSpineAnimationPlan(
  selection: PrimalWheelAwardSelection | string | number,
): WheelSpineAnimationPlan {
  const resolvedSegment = resolvePrimalWheelSegment(selection);
  return {
    segment: resolvedSegment,
    show: "show",
    idle: "idle",
    stop: "stop",
    rotationBone: "rotate",
    spinEffect: "spin_effect",
    arrowGlow: "arrow_glow",
    anticipationLoop: "anticipation/anticipation_loop",
    anticipation: `anticipation/anticipation${resolvedSegment}`,
    highlight: `highlights/highlight${resolvedSegment}`,
    hide: "hide",
    hidden: "hidden",
  };
}

interface AuthoredWheelPlayback {
  readonly view: Spine;
  readonly plan: WheelSpineAnimationPlan;
  readonly reducedMotion: boolean;
  readonly rotationBone: NonNullable<ReturnType<Spine["skeleton"]["findBone"]>>;
  spinStarted: boolean;
  arrowGlowStarted: boolean;
  landed: boolean;
  hiding: boolean;
  previousDisplayRotation: number | null;
  anticipationSegment: number | null;
  layoutTrack: "layout/horizontal" | "layout/vertical";
}

function syncAuthoredWheelLayout(
  playback: AuthoredWheelPlayback,
  next: ResponsiveSpineLayoutTrack,
): void {
  if (next === playback.layoutTrack) return;
  if (!playback.view.state.hasAnimation(next)) {
    throw new Error(`Authored Primal Wheel is missing ${next}`);
  }
  playback.view.state.clearTrack(2);
  playback.view.state.setAnimation(2, next, true);
  playback.view.update(0);
  playback.layoutTrack = next;
}

function createAuthoredWheelPlayback(
  data: SpineData,
  plan: WheelSpineAnimationPlan,
  reducedMotion: boolean,
  layoutTrack: ResponsiveSpineLayoutTrack,
): AuthoredWheelPlayback | null {
  let view: Spine | null = null;
  try {
    view = createSpineView(data);
    const requiredAnimations = [
      plan.show,
      plan.idle,
      plan.stop,
      plan.spinEffect,
      plan.arrowGlow,
      plan.anticipationLoop,
      plan.anticipation,
      plan.highlight,
      plan.hide,
      plan.hidden,
    ];
    if (requiredAnimations.some((animation) => !view?.state.hasAnimation(animation))) {
      view.destroy({ children: true });
      return null;
    }

    const rotationBone = view.skeleton.findBone(plan.rotationBone);
    if (!rotationBone
      || !view.state.hasAnimation("layout/horizontal")
      || !view.state.hasAnimation("layout/vertical")) {
      view.destroy({ children: true });
      return null;
    }
    // 原始桌面包含布局：minBound(-600,-550,1200,900) at 0.8。 / English: The original desktop contains layout: minBound(-600,-550,1200,900) at 0.8.
    view.position.set(AUTHORED_WHEEL_LAYOUT.x, AUTHORED_WHEEL_LAYOUT.y);
    view.scale.set(AUTHORED_WHEEL_LAYOUT.scale);
    view.alpha = 1;
    view.skeleton.setToSetupPose();
    view.state.setAnimation(0, plan.hidden, false);
    view.update(0);
    view.state.clearTrack(0);
    // `hidden` 钥匙槽颜色/附件 `show` 不完全拥有。在开始演出之前恢复设置，以便物理轮子在 PRIMAL WHEEL 标题后面展开，而不是仅在“就绪”重置时才弹出。 / English: `hidden` key slot color/attachment `show` Not fully owned. Restore settings before starting a show so that the physical wheel expands behind the PRIMAL WHEEL header instead of only popping up on "Ready" reset.
    view.skeleton.setToSetupPose();
    view.state.setAnimation(2, layoutTrack, true);
    const show = view.state.setAnimation(0, plan.show, false);
    show.timeScale = reducedMotion ? 100 : 1;
    view.update(0);
    return {
      view,
      plan,
      reducedMotion,
      rotationBone,
      spinStarted: false,
      arrowGlowStarted: false,
      landed: false,
      hiding: false,
      previousDisplayRotation: null,
      anticipationSegment: null,
      layoutTrack,
    };
  } catch {
    view?.destroy({ children: true });
    return null;
  }
}

function advanceAuthoredWheel(
  playback: AuthoredWheelPlayback,
  frame: PrimalWheelSpinFrame,
  spinElapsedMs: number,
  timeline: PrimalWheelRuntimeTimeline,
  layoutTrack: ResponsiveSpineLayoutTrack,
): void {
  const { view, plan, reducedMotion } = playback;
  syncAuthoredWheelLayout(playback, layoutTrack);
  if (!playback.spinStarted) {
    view.state.clearTrack(0);
    view.state.clearTrack(1);
    view.state.setAnimation(0, plan.stop, false);
    const spinEffect = view.state.setAnimation(1, plan.spinEffect, true);
    spinEffect.timeScale = reducedMotion ? 12 : 1;
    playback.spinStarted = true;
    playback.previousDisplayRotation = Math.floor(frame.rotationDegrees) + 360;
  }

  const displayRotation = Math.floor(frame.rotationDegrees) + 360;
  if (playback.spinStarted && !playback.landed && frame.anticipationEligible
    && playback.previousDisplayRotation !== null) {
    const rotationDelta = Math.abs(playback.previousDisplayRotation - displayRotation);
    const shortestDelta = Math.min(rotationDelta, 360 - rotationDelta);
    if (shortestDelta !== 0 && shortestDelta < 5) {
      if (!playback.arrowGlowStarted) {
        const glow = view.state.setAnimation(0, plan.arrowGlow, true);
        glow.timeScale = reducedMotion ? 100 : 1;
        playback.arrowGlowStarted = true;
      }
      const anticipationSegment = wheelAnticipationSegment(frame.rotationDegrees);
      if (anticipationSegment !== playback.anticipationSegment) {
        view.state.setAnimation(1, `anticipation/anticipation${anticipationSegment}`, false);
        playback.anticipationSegment = anticipationSegment;
      }
    }
  }
  playback.previousDisplayRotation = displayRotation;

  if (!playback.landed && frame.stage === "landed") {
    view.state.clearTrack(0);
    view.state.clearTrack(1);
    view.state.setAnimation(0, plan.stop, false);
    const highlight = view.state.setAnimation(1, plan.highlight, false);
    highlight.timeScale = reducedMotion ? 100 : 1;
    playback.landed = true;
  }

  if (!playback.hiding && spinElapsedMs >= timeline.summaryHideAt) {
    view.state.clearTrack(0);
    view.state.clearTrack(1);
    const hide = view.state.setAnimation(0, plan.hide, false);
    hide.timeScale = reducedMotion ? 100 : 1;
    playback.hiding = true;
  }
  playback.rotationBone.rotation = frame.rotationDegrees;
  view.skeleton.updateWorldTransform();
}

function applyAuthoredWheelIdleFrame(
  playback: AuthoredWheelPlayback | null,
  idleState: PrimalWheelIdleState,
  layoutTrack: ResponsiveSpineLayoutTrack,
): void {
  if (!playback) return;
  syncAuthoredWheelLayout(playback, layoutTrack);
  playback.rotationBone.rotation = idleState.rotationDegrees;
  playback.view.skeleton.updateWorldTransform();
}

function setAuthoredWheelWaiting(playback: AuthoredWheelPlayback | null): void {
  if (!playback) return;
  const { view, plan } = playback;
  view.state.clearTrack(0);
  view.state.clearTrack(1);
  // `hidden` 循环 `idle` 动画故意不拥有的关键插槽颜色/附件。在进入不确定输入门之前恢复预设的设置姿势，或者轮子可以保持完全隐藏，而只有单独的超旋转提示可见。 / English: `hidden` loop `idle` animation intentionally does not have key slot colors/attachments. Restore the preset setup pose before entering the indeterminate input gate, or the wheels can remain completely hidden, with only the separate hyperrotation prompt visible.
  view.skeleton.setToSetupPose();
  view.state.setAnimation(0, plan.idle, true);
  view.state.setAnimation(1, plan.anticipationLoop, true);
  view.update(0);
}

function resetAuthoredWheel(playback: AuthoredWheelPlayback | null): void {
  if (!playback) return;
  const { view, plan } = playback;
  view.state.clearTracks();
  view.skeleton.setToSetupPose();
  view.state.setAnimation(0, plan.hidden, false);
  view.update(0);
  view.alpha = 0;
  view.visible = false;
}

class AuthoredPanel extends Container {
  readonly textBinding: SpineTextBinding | null;
  private layoutTrack: string | null = null;

  constructor(
    readonly spine: Spine,
    layout: Pick<AuthoredPanelLayout, "x" | "y" | "scale">,
    textFields: readonly PrimalPanelTextField[],
    private readonly layoutTrackSource: () => ResponsiveSpineLayoutTrack,
  ) {
    super();
    this.position.set(layout.x, layout.y);
    this.scale.set(layout.scale);
    this.textBinding = textFields.length > 0
      ? new SpineTextBinding(spine, textFields)
      : null;
    this.addChild(spine);
    if (this.textBinding) this.addChild(this.textBinding.view);
    this.syncResponsiveLayout();
  }

  syncTextFields(): void {
    this.syncResponsiveLayout();
    this.textBinding?.sync();
  }

  private syncResponsiveLayout(): void {
    const next = responsiveSpineLayoutAnimation(this.spine, this.layoutTrackSource());
    if (!next || next === this.layoutTrack) return;
    this.spine.state.clearTrack(2);
    this.spine.state.setAnimation(2, next, true);
    this.spine.update(0);
    this.layoutTrack = next;
  }
}

function createAuthoredPanel(
  data: SpineData | undefined,
  layout: Pick<AuthoredPanelLayout, "x" | "y" | "scale">,
  textFields: readonly PrimalPanelTextField[] = [],
  layoutTrackSource: () => ResponsiveSpineLayoutTrack = () => "layout/horizontal",
): AuthoredPanel | null {
  if (!data) return null;
  let spine: Spine | null = null;
  let panel: AuthoredPanel | null = null;
  try {
    spine = createSpineView(data);
    if (!spine.state.hasAnimation("show")) {
      spine.destroy({ children: true });
      return null;
    }
    panel = new AuthoredPanel(spine, layout, textFields, layoutTrackSource);
    panel.alpha = 0;
    spine.skeleton.setToSetupPose();
    if (spine.state.hasAnimation("hidden")) {
      spine.state.setAnimation(0, "hidden", false);
      spine.update(0);
      spine.state.clearTrack(0);
    }
    spine.update(0);
    panel.syncTextFields();
    return panel;
  } catch {
    if (panel) panel.destroy({ children: true });
    else spine?.destroy({ children: true });
    return null;
  }
}

function playAuthoredPanelTrack(
  view: AuthoredPanel,
  animation: string,
  track: number,
  loop: boolean,
  reducedMotion: boolean,
): boolean {
  const { spine } = view;
  if (!spine.state.hasAnimation(animation)) return false;
  spine.state.clearTrack(track);
  const entry = spine.state.setAnimation(track, animation, loop);
  entry.timeScale = reducedMotion ? 100 : 1;
  spine.update(0);
  view.syncTextFields();
  return true;
}

interface AuthoredTrailEndpointBone {
  x: number;
  y: number;
  rotation: number;
  worldToLocal(world: Vector2): Vector2;
}

/** 从 Pixi 屏幕到 Spine 本地 Y 的精确 SpineCollectTrailController 端点桥接。 / English: Exact SpineCollectTrailController endpoint bridge from Pixi screen to Spine local Y. */
export function resolveAuthoredCollectTrailEndpoint(
  bone: AuthoredTrailEndpointBone,
  point: Readonly<{ x: number; y: number }>,
  updateWorldTransform: () => void,
): void {
  bone.x = 0;
  bone.y = 0;
  bone.rotation = 0;
  updateWorldTransform();
  const local = bone.worldToLocal(new Vector2(point.x, point.y));
  bone.x = local.x;
  bone.y = local.y;
}

/** 两个端点骨骼使用的原始 pointDirection(target, source) 约定。 / English: The original pointDirection(target, source) convention used by two endpoint bones. */
export function authoredCollectTrailRotation(
  source: Readonly<{ x: number; y: number }>,
  target: Readonly<{ x: number; y: number }>,
): number {
  return Math.atan2(source.y - target.y, target.x - source.x) * 180 / Math.PI;
}

function createAuthoredCollectTrail(
  data: SpineData | undefined,
  source: Point,
  target: Point,
  reducedMotion: boolean,
): Spine | null {
  if (!data || reducedMotion) return null;
  let view: Spine | null = null;
  try {
    view = createSpineView(data);
    if (!view.state.hasAnimation("collect")) {
      view.destroy({ children: true });
      return null;
    }
    const sourceBone = view.skeleton.findBone("symbol");
    const targetBone = view.skeleton.findBone("pps");
    if (!sourceBone || !targetBone) {
      view.destroy({ children: true });
      return null;
    }
    const trailView = view;
    // 原始SpineCollectTrailController将每个端点归零，然后通过Bone.worldToLocal()解析Pixi路径覆盖点。 / English: The original SpineCollectTrailController zeroes out each endpoint and then resolves the Pixi trail coverage points via Bone.worldToLocal().
    // 这是材料：Spine 的 Pixi 桥反射 Y。分配屏幕空间 Y 直接将完整的嘴到符号螺栓发送到视口上方。 / English: Here’s the material: Spine’s Pixi Bridge Reflective Y. Allocate screen space Y to send the full mouth to symbol bolt directly above the viewport.
    const updateWorldTransform = (): void => trailView.skeleton.updateWorldTransform();
    resolveAuthoredCollectTrailEndpoint(sourceBone, source, updateWorldTransform);
    resolveAuthoredCollectTrailEndpoint(targetBone, target, updateWorldTransform);
    const rotation = authoredCollectTrailRotation(source, target);
    sourceBone.rotation = rotation;
    targetBone.rotation = rotation;
    trailView.skeleton.updateWorldTransform();
    trailView.state.setAnimation(0, "collect", false);
    if (trailView.state.hasAnimation("hidden")) {
      trailView.state.addAnimation(0, "hidden", false, 0);
    }
    trailView.update(0);
    return trailView;
  } catch {
    view?.destroy({ children: true });
    return null;
  }
}

interface ActiveAnimation {
  handle: number | null;
  finish(): void;
  cancel(): void;
}

interface ActiveRageCascade {
  cancelled: boolean;
  cleaned: boolean;
  finish: (() => void) | null;
  resume: (() => void) | null;
}

class FeaturePresentationCancelledError extends Error {
  constructor() {
    super("Feature presentation cancelled");
    this.name = "FeaturePresentationCancelledError";
  }
}

class RageCascadePresentationCancelledError extends Error {
  constructor() {
    super("Rage cascade presentation cancelled");
    this.name = "RageCascadePresentationCancelledError";
  }
}

interface FeaturePresentationToken {
  readonly generation: number;
  readonly signal: AbortSignal;
}

function isFeaturePresentationCancelled(error: unknown): boolean {
  return error instanceof FeaturePresentationCancelledError;
}

export type WheelInteractionResult = "popup-continued" | "spin-started" | "quick-stop";

interface ActiveWheelPopupContinue {
  state: "waiting" | "continued" | "expired" | "cancelled";
  closeNotified: boolean;
  finish(): void;
}

interface ActiveWheelInteraction {
  state: "waiting" | "spinning" | "settling" | "finished" | "cancelled";
  quickStopRequested: boolean;
  quickStopEligible: boolean;
  spinRequestedAtMs: number | null;
  resolveContinue(): void;
}

interface WheelRenderChannels {
  readonly wheel: boolean;
  readonly summary: boolean;
  readonly reels: boolean;
}

const ALL_WHEEL_RENDER_CHANNELS: WheelRenderChannels = Object.freeze({
  wheel: true,
  summary: true,
  reels: true,
});

export type WheelSummaryCloseReason = "continue" | "timeout" | "cancelled";

interface ActiveWheelSummaryContinue {
  state: "waiting" | "continued" | "expired" | "cancelled";
  closeNotified: boolean;
  finish(): void;
}

interface ActiveFreeSpinContinue {
  state: "waiting" | "continued" | "cancelled";
  resolve(): void;
}

export type FreeSpinSummaryCloseReason = "continue" | "timeout" | "cancelled";

interface ActiveFreeSpinSummaryContinue {
  state: "waiting" | "continued" | "expired" | "cancelled";
  closeNotified: boolean;
  inputCheckpointPending: boolean;
  finish(): void;
}

interface ActiveVaultTease {
  readonly cells: readonly CellAddress[];
  state: "waiting" | "skipped" | "finished" | "cancelled";
  finish(): void;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? typeof (value as { readonly then?: unknown }).then === "function"
    : false;
}

function phase(value: number, from: number, to: number): number {
  return clamp((value - from) / (to - from));
}

function outCubic(value: number): number {
  return 1 - (1 - value) ** 3;
}

function smooth(value: number): number {
  return value * value * (3 - 2 * value);
}

function mix(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

interface AlphaTarget {
  alpha: number;
}

export interface ReelAlphaLayer {
  /** 稳定的预层 Alpha，即使另一个动画已经拥有一个图层也是如此。 / English: Stable pre-layer alpha, even if another animation already has a layer. */
  readonly baseAlpha: number;
  /** 如果这是唯一的活动层，则需要所需的 alpha。 / English: If this is the only active layer, the desired alpha is required. */
  setAlpha(alpha: number): void;
  /** 幂等地删除该层而不打扰剩余的所有者。 / English: Deletes the layer idempotently without disturbing the remaining owners. */
  release(): void;
}

/**
 * 组成在墙时间中重叠的独立卷轴淡入淡出。 Wheel 在 H+500 处返回，而其卷轴淡入淡出占据场景直到 H+1000；因此，
 * 以下 Free Spins 介绍可能会在第一个发布之前开始第二个淡入淡出。
 *
 * 英文 / English: Composed of independent scroll fades that overlap in wall time. The Wheel returns at H+500, and its reel fade occupies the scene until H+1000; therefore, the following Free Spins intro may begin the second fade before the first is released.
 */
export class ReelAlphaLayers {
  private baseAlpha: number | null = null;
  private readonly factors = new Map<symbol, number>();

  constructor(private readonly target: AlphaTarget) {}

  acquire(): ReelAlphaLayer {
    if (this.baseAlpha === null) this.baseAlpha = this.sanitizeAlpha(this.target.alpha);
    const baseAlpha = this.baseAlpha;
    const token = Symbol("reel-alpha-layer");
    this.factors.set(token, 1);
    let released = false;

    return Object.freeze({
      baseAlpha,
      setAlpha: (alpha: number): void => {
        if (released || !this.factors.has(token)) return;
        const desired = this.sanitizeAlpha(alpha);
        this.factors.set(token, baseAlpha > 0 ? desired / baseAlpha : 0);
        this.apply();
      },
      release: (): void => {
        if (released) return;
        released = true;
        if (!this.factors.delete(token)) return;
        if (this.factors.size === 0) {
          const restore = this.baseAlpha;
          this.baseAlpha = null;
          if (restore !== null) this.target.alpha = restore;
          return;
        }
        this.apply();
      },
    });
  }

  /** 立即拆卸路径；陈旧的句柄在此调用后将变为惰性。 / English: Immediately disassembles the path; stale handles will become lazy after this call. */
  restore(): void {
    const restore = this.baseAlpha;
    this.factors.clear();
    this.baseAlpha = null;
    if (restore !== null) this.target.alpha = restore;
  }

  private apply(): void {
    const baseAlpha = this.baseAlpha;
    if (baseAlpha === null) return;
    let alpha = baseAlpha;
    for (const factor of this.factors.values()) alpha *= factor;
    this.target.alpha = this.sanitizeAlpha(alpha);
  }

  private sanitizeAlpha(alpha: number): number {
    return Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
  }
}

export interface SurgeCollectionFrame {
  readonly targetAlpha: number;
  readonly beamProgress: number;
  readonly moteProgress: number;
  readonly chargeAlpha: number;
  readonly chargeScale: number;
  readonly shockwaveAlpha: number;
  readonly missAlpha: number;
  readonly sceneDim: number;
  readonly bannerAlpha: number;
}

/** 纯化妆品时间线；触发真相由解码事件提供。 / English: Purely cosmetic timeline; triggering truth provided by decoded events. */
export function surgeCollectionFrame(
  progress: number,
  triggered: boolean,
  guaranteed: boolean,
  reducedMotion: boolean,
): SurgeCollectionFrame {
  const value = clamp(progress);
  if (reducedMotion) {
    const envelope = Math.sin(Math.PI * value);
    return {
      targetAlpha: envelope * 0.48,
      beamProgress: 0,
      moteProgress: 0,
      chargeAlpha: envelope * (triggered ? 0.5 : 0.3),
      chargeScale: 1,
      shockwaveAlpha: 0,
      missAlpha: !triggered ? envelope * 0.28 : 0,
      sceneDim: envelope * 0.08,
      bannerAlpha: envelope,
    };
  }
  const presence = smooth(phase(value, 0, 0.14)) * (1 - phase(value, 0.9, 1));
  const triggerWave = Math.sin(Math.PI * phase(value, 0.62, 1));
  return {
    targetAlpha: presence,
    beamProgress: outCubic(phase(value, 0.08, 0.4)),
    moteProgress: outCubic(phase(value, 0.3, 0.68)),
    chargeAlpha: smooth(phase(value, 0.28, 0.48)) * (1 - phase(value, 0.9, 1)),
    chargeScale: 0.58 + outCubic(phase(value, 0.3, 0.68)) * (triggered ? 0.76 : 0.42),
    shockwaveAlpha: triggered ? triggerWave * (guaranteed ? 0.92 : 0.72) : 0,
    missAlpha: !triggered
      ? smooth(phase(value, 0.62, 0.76)) * (1 - phase(value, 0.9, 1))
      : 0,
    sceneDim: presence * (triggered ? 0.26 : 0.14),
    bannerAlpha: smooth(phase(value, 0.46, 0.62)) * (1 - phase(value, 0.9, 1)),
  };
}

export interface FeatureModeEntryFrame {
  readonly presence: number;
  readonly railScale: number;
  readonly titleAlpha: number;
  readonly counterAlpha: number;
  readonly sceneDim: number;
}

export function featureModeEntryFrame(progress: number, reducedMotion: boolean): FeatureModeEntryFrame {
  const value = clamp(progress);
  const presence = smooth(phase(value, 0, reducedMotion ? 0.18 : 0.14)) * (1 - phase(value, 0.88, 1));
  return {
    presence,
    railScale: reducedMotion ? 1 : 0.32 + outCubic(phase(value, 0.04, 0.48)) * 0.68,
    titleAlpha: smooth(phase(value, 0.16, 0.34)) * (1 - phase(value, 0.88, 1)),
    counterAlpha: smooth(phase(value, 0.36, 0.54)) * (1 - phase(value, 0.9, 1)),
    sceneDim: presence * (reducedMotion ? 0.1 : 0.42),
  };
}

function createBanner(label: string, color: number, width = 520): Container {
  const banner = new Container();
  const plate = new Graphics();
  plate.beginFill(0x090b0d, 0.94);
  plate.lineStyle(2, color, 0.92);
  plate.drawPolygon([
    -width / 2 + 18, -30,
    width / 2 - 18, -30,
    width / 2, 0,
    width / 2 - 18, 30,
    -width / 2 + 18, 30,
    -width / 2, 0,
  ]);
  plate.endFill();
  plate.lineStyle(1, 0xffe0a3, 0.38);
  plate.moveTo(-width / 2 + 36, -20).lineTo(width / 2 - 36, -20);

  const fontSize = Math.max(12, Math.min(22, Math.floor(610 / Math.max(12, label.length))));
  const text = new Text(label, new TextStyle({
    fill: 0xffedcb,
    fontFamily: "Arial Black, Impact, sans-serif",
    fontSize,
    fontWeight: "900",
    letterSpacing: 2,
    stroke: 0x090b0d,
    strokeThickness: 4,
  }));
  text.anchor.set(0.5);
  banner.addChild(plate, text);
  return banner;
}

export interface FeatureEffectsHooks {
  readonly onReelStructure?: (direction: AnimatedReelStructureDirection) => void;
  /** 弹出窗口 `show` 已启动，其第一个绑定的 CONTINUE 已上线。 / English: The popup `show` has been started and its first bound CONTINUE has come online. */
  readonly onWheelPopupReady?: () => void;
  /** 精确弹出输入就绪框架上的可选测试场景屏障。 / English: Precisely pop up optional test scenario barrier on input ready frame. */
  readonly onWheelPopupInputReadyCheckpoint?: () => void | Promise<void>;
  readonly onWheelPopupClose?: (reason: WheelSummaryCloseReason) => void;
  /** 弹出已完成/继续，原始 wheelButton 正在接受旋转输入。 / English: Popup completed/continued, original wheelButton is accepting rotation input. */
  readonly onWheelReady?: () => void;
  /** 无超时 Wheel 输入门处于活动状态时可选的测试场景屏障。 / English: No timeout Wheel input Optional test scene barrier when gate is active. */
  readonly onWheelInputReadyCheckpoint?: () => void | Promise<void>;
  readonly onWheelSpinStart?: () => void;
  /**
   * 可选的测试夹具栅栏：位于 Character 捶胸效果负责人和旋转启动里程碑安装之后、Wheel 流程离开 S0 之前。
   *
   * 英文 / English: Optional Test Fixture Fence: Located after the Character Chest-Thumping Effect Leader and Spin Start Milestones are installed, but before the Wheel process leaves S0.
   */
  readonly onWheelSpinStartCheckpoint?: () => void | Promise<void>;
  /** 旋转过程中的第二次单击将调用 Spinner.quickStop()。 / English: The second click during the spin calls Spinner.quickStop(). */
  readonly onWheelQuickStop?: () => void;
  readonly onWheelSpinFinish?: () => void;
  /** 在高光保持之前，解码着陆姿势上的可选测试场景障碍物。 / English: Decoding optional test scene obstacles on landing pose before highlight hold. */
  readonly onWheelLandingCheckpoint?: () => void | Promise<void>;
  /** 仅恢复角色；与 finish 不同，它不能发出着陆里程碑。 / English: Only resumes the role; unlike finish, it cannot emit landing milestones. */
  readonly onWheelSpinAbort?: () => void;
  /** A 层 `show` 已启动，有界 CONTINUE 门已启用。 / English: Layer A `show` is started, bounded CONTINUE gate is enabled. */
  readonly onWheelSummaryReady?: () => void;
  /** 关闭输入、超时或拆卸的共享 Spin/CONTINUE 状态。 / English: Close shared Spin/CONTINUE state for input, timeout, or teardown. */
  readonly onWheelSummaryClose?: (reason: WheelSummaryCloseReason) => void;
  /** B 层在预设的 Wheel 根完成其 500ms 隐藏后开始。 / English: Layer B starts after the preset Wheel root completes its 500ms hide. */
  readonly onWheelBonusLabelReady?: (
    event: InstantWheelAwardedEvent,
    reducedMotion: boolean,
  ) => void;
  /** Free Spins 介绍已完全显示，并且 waitForContinue(-1) 已激活。 / English: The Free Spins intro is fully displayed and waitForContinue(-1) is activated. */
  readonly onFreeSpinsReady?: () => void;
  readonly onFreeSpinsContinue?: () => void;
  /** Free Spins 摘要 `show` 已完成，其绑定的 CONTINUE 已上线。 / English: Free Spins summary `show` has been completed and its bound CONTINUE is online. */
  readonly onFreeSpinSummaryReady?: () => void;
  /** 真实摘要输入门变得可见后可选的测试场景屏障。 / English: Optional test scene barrier after the real summary input gate becomes visible. */
  readonly onFreeSpinSummaryInputReadyCheckpoint?: () => void | Promise<void>;
  readonly onFreeSpinSummaryClose?: (reason: FreeSpinSummaryCloseReason) => void;
  readonly onRageRespin?: () => void;
  readonly onRagePound?: () => void;
  readonly onRageBackdropShake?: (phase: "respin" | "pound") => void;
  /** 官方PPS状态1：仅在1ms收集障碍后启动塔。 / English: Official PPS Status 1: Launch tower only after collecting obstacles in 1ms. */
  readonly onRageCollectionCommitted?: () => void;
  /** 同步、故障开放诊断；从未等待生产。 / English: Synchronized, fault-open diagnostics; never waiting for production. */
  readonly onRageCollectionMilestone?: (
    milestone: Readonly<RageCollectionEffectMilestone>,
  ) => void;
  /**
   * 用于 one-Vault 预设的解锁时钟的可选测试场景屏障。当不存在时，不会在生产中引入寻道、暂停或额外等待。
   *
   * 英文 / English: Optional test scenario barrier for one-Vault preset unlock clock. When absent, no seeks, pauses, or extra waits are introduced in production.
   */
  readonly onVaultUnlockPhase?: (
    milestone: Readonly<VaultUnlockPresentationMilestone>,
  ) => void | Promise<void>;
  /** FREESPIN_END/重置在预设的摘要隐藏剪辑之前开始一次。 / English: FREESPIN_END/Reset starts once before the default summary hides the clip. */
  readonly onFreeSpinSummaryHideStart?: () => void;
}

export type WheelStopOffsetSource = () => number;

export const defaultWheelStopOffsetSource: WheelStopOffsetSource = () => (
  Math.random() * 0.3 - 0.15
);

/**
 * 仅在接受的 Spin 门处对外观保留的 Wheel 偏移进行采样。减少运动有意使指针保持居中，而不消耗注入的源。
 *
 * 英文 / English: Appearance-preserving Wheel offsets are sampled only at accepted Spin gates. Reducing motion intentionally keeps the pointer centered without consuming the injected source.
 */
export function sampleWheelStopOffset(
  source: WheelStopOffsetSource,
  reducedMotion: boolean,
): number {
  return reducedMotion ? 0 : source();
}

export interface PrimalWheelOutroTaskPlan {
  readonly wheelMs: number;
  readonly summaryMs: number;
  readonly reelsMs: number;
  readonly processBarrierMs: number;
  readonly ownershipMs: number;
}

/** 官方隐藏启动分为三个任务；只有Wheel隐藏门进程。 / English: The authored hide starts three parallel tasks; only the Wheel hide gates process completion. */
export function primalWheelOutroTaskPlan(
  timeline: Pick<PrimalWheelRuntimeTimeline, "wheelHide" | "summaryHide" | "reelFade">,
): PrimalWheelOutroTaskPlan {
  return Object.freeze({
    wheelMs: timeline.wheelHide,
    summaryMs: timeline.summaryHide,
    reelsMs: timeline.reelFade,
    processBarrierMs: timeline.wheelHide,
    ownershipMs: Math.max(timeline.wheelHide, timeline.summaryHide, timeline.reelFade),
  });
}

/**
 * 原创的、非权威的特征动画层。它使用语义服务器事实，但从不计算中奖、余额、乘数或结果。
 *
 * 英文 / English: Original, non-authoritative feature animation layer. It uses semantic server facts but never calculates winnings, balances, multipliers or results.
 */
export class FeatureEffects {
  readonly view = new Container();
  private readonly animations = new Set<ActiveAnimation>();
  private readonly managedWheelSceneCleanups = new Set<() => void>();
  private readonly reelAlphaLayers: ReelAlphaLayers;
  private activeWheelPopupContinue: ActiveWheelPopupContinue | null = null;
  private activeWheelInteraction: ActiveWheelInteraction | null = null;
  private activeWheelSummaryContinue: ActiveWheelSummaryContinue | null = null;
  private activeFreeSpinContinue: ActiveFreeSpinContinue | null = null;
  private activeFreeSpinSummaryContinue: ActiveFreeSpinSummaryContinue | null = null;
  private activeVaultTease: ActiveVaultTease | null = null;
  private pendingVaultUpgradeMembers = 0;
  private wheelSpeed: PrimalWheelSpeed = "normal";
  private responsiveLayoutTrack: ResponsiveSpineLayoutTrack = "layout/horizontal";
  private readonly responsiveLayoutTrackSource = (): ResponsiveSpineLayoutTrack => (
    this.responsiveLayoutTrack
  );
  private wheelOverlayRegion: ResponsiveRendererRegion = Object.freeze({
    left: 0,
    top: 0,
    width: LOGICAL_WIDTH,
    height: LOGICAL_HEIGHT,
  });
  private activeWheelScene: Container | null = null;
  private rageCollectionPlaybackPaused = false;
  private activeRageCollectionCells: readonly Readonly<CellAddress>[] = Object.freeze([]);
  private readonly activeRageCollectionTrails = new Set<Spine>();
  private readonly rageCollectionTrailResumeScale = new Map<Spine, number>();
  private rageCascadeMilestoneListener: RageCascadeEffectMilestoneListener | null = null;
  private vaultUnlockMilestoneListener:
    ((milestone: Readonly<VaultUnlockPresentationMilestone>) => void | Promise<void>) | null = null;
  private activeRageCascade: ActiveRageCascade | null = null;
  private rageCascadePlaybackPaused = false;
  private presentationGeneration = 0;
  private presentationAbortController = new AbortController();
  private freeSpinArtwork: VerifiedFreeSpinArtwork["spines"] | null = null;
  private wheelArtwork: VerifiedWheelArtwork | null = null;
  private freeSpinArtworkLoad: Promise<void> | null = null;
  private wheelArtworkLoad: Promise<void> | null = null;
  private featureArtworkGeneration = 0;
  private destroyed = false;
  private moneyFormatter: MinorUnitFormatter = DEFAULT_MINOR_UNIT_FORMATTER;

  constructor(
    private readonly hostLayer: Container,
    private readonly reels: ReelSetView,
    private readonly characterCollectTarget: (() => Point | null) | null = null,
    private readonly hooks: FeatureEffectsHooks = {},
    private readonly wheelStopOffsetSource: WheelStopOffsetSource = defaultWheelStopOffsetSource,
    private readonly visualTelemetry: VisualTelemetryReporter | null = null,
    private readonly rageCascadeCellOrderSource: RageCascadeCellOrderSource
      = defaultRageCascadeCellOrderSource,
  ) {
    this.reelAlphaLayers = new ReelAlphaLayers(this.reels);
    this.hostLayer.addChild(this.view);
  }

  /** 已校验负载在控制器持有事件租约时一次性采用；不再按 skeleton/纹理 URL 请求。 / English: Verified payloads are taken one-time while the controller holds an event lease; no longer requested by skeleton/texture URL. */
  adoptVerifiedFreeSpinArtwork(artwork: VerifiedFreeSpinArtwork): void {
    if (this.destroyed) throw new Error("FeatureEffects was destroyed");
    this.featureArtworkGeneration += 1;
    this.freeSpinArtwork = artwork.spines;
    this.freeSpinArtworkLoad = null;
  }

  /** Wheel 的三张 blob 纹理由本实例独占，并在事件租约结束/销毁时按对象身份释放。 / English: The three blob textures of the Wheel are exclusively owned by this instance and are released by object identity when the event lease ends/is destroyed. */
  adoptVerifiedWheelArtwork(artwork: VerifiedWheelArtwork): void {
    if (this.destroyed) {
      disposeVerifiedWheelArtwork(artwork);
      throw new Error("FeatureEffects was destroyed");
    }
    if (this.wheelArtwork !== artwork) disposeVerifiedWheelArtwork(this.wheelArtwork);
    this.featureArtworkGeneration += 1;
    this.wheelArtwork = artwork;
    this.wheelArtworkLoad = null;
  }

  releaseVerifiedFeatureArtwork(kind: "free-spins" | "wheel"): void {
    this.featureArtworkGeneration += 1;
    if (kind === "free-spins") {
      this.freeSpinArtwork = null;
      this.freeSpinArtworkLoad = null;
      return;
    }
    const artwork = this.wheelArtwork;
    this.wheelArtwork = null;
    this.wheelArtworkLoad = null;
    disposeVerifiedWheelArtwork(artwork);
  }

  private async ensureFreeSpinArtwork(token: FeaturePresentationToken): Promise<void> {
    if (this.freeSpinArtwork) return;
    const generation = this.featureArtworkGeneration;
    if (!this.freeSpinArtworkLoad) {
      const attempt = loadPrimalSpineSet(FREE_SPIN_VERIFIED_SPINE_KEYS).then((spines) => {
        if (!this.destroyed && generation === this.featureArtworkGeneration) {
          this.freeSpinArtwork = spines;
        }
      });
      this.freeSpinArtworkLoad = attempt;
      void attempt.catch(() => {
        if (this.freeSpinArtworkLoad === attempt) this.freeSpinArtworkLoad = null;
      });
    }
    await this.awaitPresentation(this.freeSpinArtworkLoad, token);
    this.assertPresentationCurrent(token);
    if (!this.freeSpinArtwork) throw new Error("Required Free Spins artwork is unavailable");
  }

  private async ensureWheelArtwork(token: FeaturePresentationToken): Promise<void> {
    if (this.wheelArtwork) return;
    const generation = this.featureArtworkGeneration;
    if (!this.wheelArtworkLoad) {
      const attempt = loadPrimalSpineSet(WHEEL_VERIFIED_SPINE_KEYS).then((spines) => {
        if (!this.destroyed && generation === this.featureArtworkGeneration) {
          // 兼容独立渲染器/测试宿主的按需 URL 回退；生产控制器始终先采用验证包。 / English: Compatible with standalone renderer/test host on-demand URL fallback; production controllers always take the validation package first.
          this.wheelArtwork = Object.freeze({
            kind: "wheel",
            channel: "desktop",
            spines,
            ownsTextures: false,
            textures: Object.freeze({
              blue: Texture.from(PRIMAL_ASSETS.features.wheelBlue),
              red: Texture.from(PRIMAL_ASSETS.features.wheelRed),
              dual: Texture.from(PRIMAL_ASSETS.features.wheelDual),
            }),
          });
        }
      });
      this.wheelArtworkLoad = attempt;
      void attempt.catch(() => {
        if (this.wheelArtworkLoad === attempt) this.wheelArtworkLoad = null;
      });
    }
    await this.awaitPresentation(this.wheelArtworkLoad, token);
    this.assertPresentationCurrent(token);
    if (!this.wheelArtwork) throw new Error("Required Primal Wheel artwork is unavailable");
  }

  /** 会话金额格式器只改变文字投影，不参与任何奖励或余额计算。 / English: The session amount formatter only changes the text projection and does not participate in any reward or balance calculations. */
  setMoneyFormatter(formatter: MinorUnitFormatter): void {
    this.moneyFormatter = formatter;
  }

  /** 只消费 ResponsiveLayout 已提交的设计方向，禁止在表现帧中直接采样物理 window。 / English: Only the submitted design direction of ResponsiveLayout is consumed, and direct sampling of the physical window in the presentation frame is prohibited. */
  setResponsiveLayoutTrack(track: ResponsiveSpineLayoutTrack): void {
    this.responsiveLayoutTrack = track;
  }

  /** 可选捕捉观察者；在正常的制作播放中不存在。 / English: Optional capture observer; does not exist in normal production playback. */
  setRageCascadeMilestoneListener(
    listener: RageCascadeEffectMilestoneListener | null,
  ): void {
    this.rageCascadeMilestoneListener = listener;
  }

  /** 可选捕捉观察者；生产播放路径中不存在。 / English: Optional capture observer; does not exist in production playback path. */
  setVaultUnlockMilestoneListener(
    listener: ((
      milestone: Readonly<VaultUnlockPresentationMilestone>,
    ) => void | Promise<void>) | null,
  ): void {
    this.vaultUnlockMilestoneListener = listener;
  }

  /** 仅供测试夹具暂停制作好的级联控制器时钟。 / English: The test fixture only suspends the crafted cascade controller clock. */
  setRageCascadePlaybackPaused(active: boolean): void {
    this.rageCascadePlaybackPaused = active;
    if (active) return;
    const cascade = this.activeRageCascade;
    const resume = cascade?.resume;
    if (!cascade || !resume) return;
    cascade.resume = null;
    resume();
  }

  /**
   * 仅取消活动的 PPS 替换级联。清理是同步的；拥有的表现承诺在其下一个微任务边界上被拒绝。
   *
   * 英文 / English: Only active PPS replacement cascades are canceled. Cleanup is synchronous; owned performance promises are rejected on their next microtask boundary.
   */
  cancelRageCascadePresentation(): boolean {
    const active = this.activeRageCascade;
    if (!active || active.cancelled) {
      this.setRageCascadePlaybackPaused(false);
      return false;
    }
    active.cancelled = true;
    this.setRageCascadePlaybackPaused(false);
    try {
      this.cleanupRageCascade(active);
    } catch {
      // 回合清理是失败开放的：ReelSetView.cancelPresentation 在此装饰边界之后立即拥有权威的最终重置。 / English: Round cleanup is fail-open: ReelSetView.cancelPresentation has an authoritative final reset immediately after this decorated border.
    } finally {
      try {
        active.finish?.();
      } catch {
        // 陈旧的展示处理器绝不能耽误回合的重置。 / English: Aged display processors must not delay round resets.
      }
    }
    return true;
  }

  private cleanupRageCascade(active: ActiveRageCascade): void {
    if (active.cleaned) return;
    active.cleaned = true;
    this.reels.completeRageCascade();
  }

  private waitForRageCascadeResume(active: ActiveRageCascade): Promise<void> {
    if (!this.rageCascadePlaybackPaused || active.cancelled || this.destroyed) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      active.resume = resolve;
      if (!this.rageCascadePlaybackPaused || active.cancelled || this.destroyed) {
        active.resume = null;
        resolve();
      }
    });
  }

  private notifyRageCascadeMilestone(
    phase: RageCascadeEffectPhase,
    transformedCells: readonly Readonly<CellAddress>[],
    authoredAtMs: number,
    elapsedMs: number,
    reducedMotion: boolean,
    activationAttempted: number,
    activationPlayed: number,
    hidden: boolean,
    shuffledCells: readonly Readonly<RageCascadeShuffledCell>[]
      = EMPTY_RAGE_CASCADE_SHUFFLED_CELLS,
    shakePhase: RageCascadeShakePhase | null = null,
    shakeAuthoredAtMs: number | null = null,
    shakeElapsedMs: number | null = null,
  ): void {
    const listener = this.rageCascadeMilestoneListener;
    if (!listener) return;
    try {
      listener(Object.freeze({
        phase,
        authoredAtMs,
        elapsedMs,
        reducedMotion,
        transformedCells,
        shuffledCells,
        activationAttempted,
        activationPlayed,
        shakePhase,
        shakeAuthoredAtMs,
        shakeElapsedMs,
        hidden,
      }));
    } catch {
      // 只读捕获诊断无法中断预设的播放。 / English: Read-only capture diagnostics cannot interrupt scheduled playback.
    }
  }

  /**
   * 仅供测试夹具暂停活动 Rage 源与轨迹时钟。Character 和 Jackpot 组件由 PixiRenderer 暂停，但不会停止各自的逐帧更新器。
   *
   * 英文 / English: Suspends active Rage source and track clock only for test fixture. The Character and Jackpot components are paused by the PixiRenderer, but their respective frame-by-frame updaters are not stopped.
   */
  setRageCollectionPlaybackPaused(active: boolean): void {
    if (this.rageCollectionPlaybackPaused === active) return;
    this.rageCollectionPlaybackPaused = active;
    this.reels.setSymbolPlaybackPaused(this.activeRageCollectionCells, active);
    for (const trail of this.activeRageCollectionTrails) {
      if (active) {
        if (!this.rageCollectionTrailResumeScale.has(trail)) {
          this.rageCollectionTrailResumeScale.set(trail, trail.state.timeScale);
        }
        trail.state.timeScale = 0;
      } else {
        trail.state.timeScale = this.rageCollectionTrailResumeScale.get(trail) ?? 1;
        this.rageCollectionTrailResumeScale.delete(trail);
      }
    }
  }

  private beginRageCollectionPlaybackScope(
    cells: readonly Readonly<CellAddress>[],
    trails: readonly (Spine | null)[],
  ): void {
    if (this.activeRageCollectionCells.length > 0 || this.activeRageCollectionTrails.size > 0) {
      this.endRageCollectionPlaybackScope();
    }
    this.activeRageCollectionCells = Object.freeze(cells.map((cell) => Object.freeze({ ...cell })));
    for (const trail of trails) if (trail) this.activeRageCollectionTrails.add(trail);
    if (!this.rageCollectionPlaybackPaused) return;
    this.reels.setSymbolPlaybackPaused(this.activeRageCollectionCells, true);
    for (const trail of this.activeRageCollectionTrails) {
      this.rageCollectionTrailResumeScale.set(trail, trail.state.timeScale);
      trail.state.timeScale = 0;
    }
  }

  private endRageCollectionPlaybackScope(): void {
    try {
      this.reels.setSymbolPlaybackPaused(this.activeRageCollectionCells, false);
    } catch {
      // 所寻址的符号可能已经属于废弃的卷轴网格。 / English: The addressed symbol may already belong to an abandoned reel grid.
    }
    for (const trail of this.activeRageCollectionTrails) {
      try {
        trail.state.timeScale = this.rageCollectionTrailResumeScale.get(trail) ?? 1;
      } catch {
        // 场景清理可能已经破坏了预设的轨迹。 / English: Scene cleanup may have destroyed the preset trajectory.
      }
    }
    this.activeRageCollectionCells = Object.freeze([]);
    this.activeRageCollectionTrails.clear();
    this.rageCollectionTrailResumeScale.clear();
  }

  private currentPresentationToken(): FeaturePresentationToken {
    // 某些专项渲染器测试会刻意通过 Object.create(FeatureEffects.prototype) 构造此类， / English: Some specialized renderer tests intentionally construct this class via Object.create(FeatureEffects.prototype),
    // 以便在不启动 Pixi 的情况下隔离单个视觉接口。可复用的取消负责人需保持延迟创建， / English: to isolate a single visual interface without launching Pixi. The reusable cancellation manager needs to be created lazily,
    // 同时兼容绕过构造函数的测试路径；生产实例仍使用上方字段初始化器。 / English: Also compatible with test paths that bypass the constructor; production instances still use the field initializer above.
    if (!this.presentationAbortController) {
      this.presentationAbortController = new AbortController();
    }
    if (!Number.isFinite(this.presentationGeneration)) {
      this.presentationGeneration = 0;
    }
    return Object.freeze({
      generation: this.presentationGeneration,
      signal: this.presentationAbortController.signal,
    });
  }

  private isPresentationCurrent(token: FeaturePresentationToken): boolean {
    return !this.destroyed
      && !token.signal.aborted
      && token.generation === this.presentationGeneration;
  }

  private assertPresentationCurrent(token: FeaturePresentationToken): void {
    if (!this.isPresentationCurrent(token)) throw new FeaturePresentationCancelledError();
  }

  /** 将测试夹具/资源承诺与可复用的轮次取消边界绑定。 / English: Unbound test fixture/resource commitments with reusable rounds. */
  private awaitPresentation<T>(
    pending: PromiseLike<T>,
    token: FeaturePresentationToken,
  ): Promise<T> {
    if (!this.isPresentationCurrent(token)) {
      return Promise.reject(new FeaturePresentationCancelledError());
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        token.signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => settle(() => reject(new FeaturePresentationCancelledError()));
      token.signal.addEventListener("abort", onAbort, { once: true });
      void Promise.resolve(pending).then(
        (value) => settle(() => {
          if (this.isPresentationCurrent(token)) resolve(value);
          else reject(new FeaturePresentationCancelledError());
        }),
        (error) => settle(() => reject(error)),
      );
    });
  }

  private notifyRageCollectionMilestone(
    milestone: RageCollectionEffectMilestone,
  ): void {
    try {
      this.hooks.onRageCollectionMilestone?.(Object.freeze({
        ...milestone,
        cells: Object.freeze(milestone.cells.map((cell) => Object.freeze({ ...cell }))),
      }));
    } catch {
      // 只读灯具诊断无法中断预设的效果。 / English: Read-only fixture diagnostics cannot interrupt preset effects.
    }
  }

  private async commitRageCollectionAfterBarrier(
    reducedMotion: boolean,
    token: FeaturePresentationToken,
  ): Promise<boolean> {
    await this.awaitPresentation(
      new Promise<void>((resolve) => setTimeout(resolve, reducedMotion ? 0 : 1)),
      token,
    );
    this.assertPresentationCurrent(token);
    if (!this.hooks.onRageCollectionCommitted) return false;
    try {
      this.hooks.onRageCollectionCommitted();
      return true;
    } catch {
      return false;
    }
  }

  private visualDescriptor(
    id: VisualTelemetryId,
    sourceEvent: string,
    requirement: VisualTelemetryDescriptor["requirement"] = "conditional",
    mode: VisualTelemetryDescriptor["mode"] = "authored",
  ): VisualTelemetryDescriptor {
    return { id, sourceEvent, requirement, mode };
  }

  private completeVisual(
    operation: VisualTelemetryOperation | null,
    reducedMotion: boolean,
    outcome: "natural" | "continued" | "timeout" | "cancelled" = "natural",
  ): void {
    if (!operation) return;
    this.visualTelemetry?.complete(
      operation,
      this.destroyed
        ? "cancelled"
        : reducedMotion ? "reduced-motion-skip" : outcome,
    );
  }

  private failVisual(
    operation: VisualTelemetryOperation | null,
    failure: VisualTelemetryFailure,
  ): void {
    if (operation) this.visualTelemetry?.fail(operation, failure);
  }

  private async presentVisual(
    descriptor: VisualTelemetryDescriptor,
    reducedMotion: boolean,
    presentation: (
      operation: VisualTelemetryOperation | null,
    ) => Promise<void> | void,
    failure: VisualTelemetryFailure = {
      stage: "runtime",
      code: "playback-failed",
      fallback: "procedural",
    },
  ): Promise<void> {
    const operation = this.visualTelemetry?.start(descriptor) ?? null;
    try {
      await presentation(operation);
    } catch (error) {
      if (isFeaturePresentationCancelled(error)) {
        this.completeVisual(operation, reducedMotion, "cancelled");
        throw error;
      }
      this.failVisual(operation, failure);
      throw error;
    }
    this.completeVisual(operation, reducedMotion);
  }

  /**
   * 官方 FASTPLAY_ON/OFF 设置的渲染器接口。仅当玩家启动 Wheel 时才会对该值进行采样，因此在主动停止期间更改该值无法更改不可变的旋转计划。
   *
   * 英文 / English: Renderer interface for official FASTPLAY_ON/OFF settings. This value is only sampled when the player starts the Wheel, so changing the value during an active stop cannot change the immutable rotation plan.
   */
  setWheelFastPlay(enabled: boolean): void {
    this.wheelSpeed = enabled ? "fast" : "normal";
  }

  setWheelOverlayRegion(region: ResponsiveRendererRegion): void {
    this.wheelOverlayRegion = Object.freeze({ ...region });
    if (this.activeWheelScene) this.applyWheelOverlayLayout(this.activeWheelScene);
  }

  private applyWheelOverlayLayout(scene: Container): void {
    const transform = wheelStageOverlayTransform(this.wheelOverlayRegion);
    scene.position.set(transform.x, transform.y);
    scene.scale.set(transform.scale);
  }

  /**
   * 通过一个交互门路由共享的 DOM Spin 控件和 600px 预设的车轮撞击圆。它永远不会改变服务器奖励。
   *
   * 英文 / English: A shared DOM Spin control and a 600px prefab wheel impact circle are routed through an interaction gate. It never changes server rewards.
   */
  requestWheelInteraction(): WheelInteractionResult | null {
    const popup = this.activeWheelPopupContinue;
    if (popup?.state === "waiting" && !this.destroyed) {
      popup.state = "continued";
      popup.finish();
      this.notifyWheelPopupClose(popup, "continue");
      return "popup-continued";
    }
    const interaction = this.activeWheelInteraction;
    if (!interaction || this.destroyed) return null;
    if (interaction.state === "waiting") {
      interaction.state = "spinning";
      interaction.spinRequestedAtMs = performance.now();
      try {
        this.hooks.onWheelSpinStart?.();
      } catch (error) {
        // 保留预障碍合约：诊断/表现挂钩可能仍会显示其错误，但永远不会搁浅已接受的 Spin。 / English: Preserve pre-barrier contracts: Diagnostics/Performance hooks may still show their errors, but accepted Spins will never be stranded.
        interaction.resolveContinue();
        throw error;
      }
      const checkpoint = this.requestWheelCheckpoint(
        this.hooks.onWheelSpinStartCheckpoint,
      );
      if (checkpoint) {
        // 按设计保持故障开放：requestWheelCheckpoint 会同时处理兑现与拒绝， / English: Keep faults open by design: requestWheelCheckpoint handles both honors and rejections,
        // 因此生产流程始终可以继续执行拆卸。 / English: The production process can therefore always continue with disassembly.
        void checkpoint.then(() => interaction.resolveContinue());
      } else {
        // 当没有观察者存在时，生产路径保持同步。 / English: When no observers are present, the production path remains synchronized.
        interaction.resolveContinue();
      }
      return "spin-started";
    }
    if (interaction.state === "spinning" && interaction.quickStopEligible) {
      interaction.state = "settling";
      interaction.quickStopRequested = true;
      interaction.quickStopEligible = false;
      this.hooks.onWheelQuickStop?.();
      return "quick-stop";
    }
    return null;
  }

  /** 相同的 DOM Spin 控件会解除 A 层，但仅在其保持期间。 / English: The same DOM Spin control dismisses the A layer, but only while it is held. */
  requestWheelSummaryContinue(): boolean {
    const interaction = this.activeWheelSummaryContinue;
    if (!interaction || interaction.state !== "waiting" || this.destroyed) return false;
    interaction.state = "continued";
    interaction.finish();
    this.notifyWheelSummaryClose(interaction, "continue");
    return true;
  }

  requestFreeSpinContinue(): boolean {
    const interaction = this.activeFreeSpinContinue;
    if (!interaction || interaction.state !== "waiting" || this.destroyed) return false;
    interaction.state = "continued";
    interaction.resolve();
    this.hooks.onFreeSpinsContinue?.();
    return true;
  }

  /** 仅在 Free Spins 摘要 `show` 之后的有界保持期间有效。 / English: Valid only during bounded hold after Free Spins summary `show`. */
  requestFreeSpinSummaryContinue(): boolean {
    const interaction = this.activeFreeSpinSummaryContinue;
    if (!interaction || interaction.state !== "waiting" || this.destroyed) return false;
    // 可选的夹具 checkpoint 让可见 CONTINUE 保持在准确截图姿势。旧的可信点击可能在 / English: An optional fixture checkpoint keeps the visible CONTINUE in the exact screenshot pose. Old trusted clicks may be in
    // 同一 DOM 控件切换租约后才到达；该手势仍归摘要门所有，但不得越过未释放的栅栏。 / English: The same DOM control arrives after the lease is switched; the gesture is still owned by the abstract gate, but must not cross the unreleased fence.
    if (interaction.inputCheckpointPending) return true;
    interaction.state = "continued";
    interaction.finish();
    this.notifyFreeSpinSummaryClose(interaction, "continue");
    return true;
  }

  /** 镜像GameUnlockBonusFeature在预期期间的全阶段跳过按钮。 / English: Mirrors the GameUnlockBonusFeature for full-stage skip buttons during the expected period. */
  requestVaultTeaseSkip(): boolean {
    const interaction = this.activeVaultTease;
    if (!interaction || interaction.state !== "waiting" || this.destroyed) return false;
    interaction.state = "skipped";
    this.reels.skipVaultTease(interaction.cells);
    interaction.finish();
    return true;
  }

  /**
   * 可重复使用的圆形边界，用于已取消或外观上失败的特征。与 destroy() 不同，这使得资产、挂钩和视图主机可重用于下一个接受的服务器状态。清理是同步且幂等的；
   * 陈旧的 alpha 句柄和异步检查点之后无法写入。
   *
   * 英文 / English: Reusable circular borders for canceled or cosmetically failed features. Unlike destroy(), this makes assets, hooks, and view hosts reusable for the next accepted server state. Cleanup is synchronous and idempotent; stale alpha handles and async checkpoints cannot be written after.
   */
  cancelActivePresentation(): void {
    const previousController = this.presentationAbortController ?? new AbortController();
    this.presentationGeneration = Number.isFinite(this.presentationGeneration)
      ? this.presentationGeneration + 1
      : 1;
    this.presentationAbortController = new AbortController();
    try {
      previousController.abort();
    } catch {
      // 中止侦听器是内部的，但拆卸必须保持故障开放。 / English: The abort listener is internal, but teardown must leave the fault open.
    }

    const wheelPopup = this.activeWheelPopupContinue;
    if (wheelPopup?.state === "waiting") {
      wheelPopup.state = "cancelled";
      try { wheelPopup.finish(); } catch { /* 隔离处理器 */ }
      this.notifyWheelPopupClose(wheelPopup, "cancelled");
    }
    this.activeWheelPopupContinue = null;

    const wheel = this.activeWheelInteraction;
    if (wheel && wheel.state !== "finished" && wheel.state !== "cancelled") {
      wheel.state = "cancelled";
      wheel.quickStopEligible = false;
      try { wheel.resolveContinue(); } catch { /* 隔离处理器 */ }
    }
    this.activeWheelInteraction = null;

    const wheelSummary = this.activeWheelSummaryContinue;
    if (wheelSummary?.state === "waiting") {
      wheelSummary.state = "cancelled";
      try { wheelSummary.finish(); } catch { /* 隔离处理器 */ }
      this.notifyWheelSummaryClose(wheelSummary, "cancelled");
    }
    this.activeWheelSummaryContinue = null;

    const freeSpins = this.activeFreeSpinContinue;
    if (freeSpins?.state === "waiting") {
      freeSpins.state = "cancelled";
      try { freeSpins.resolve(); } catch { /* 隔离处理器 */ }
    }
    this.activeFreeSpinContinue = null;

    const freeSpinSummary = this.activeFreeSpinSummaryContinue;
    if (freeSpinSummary?.state === "waiting") {
      freeSpinSummary.state = "cancelled";
      try { freeSpinSummary.finish(); } catch { /* 隔离处理器 */ }
      this.notifyFreeSpinSummaryClose(freeSpinSummary, "cancelled");
    }
    this.activeFreeSpinSummaryContinue = null;

    const vaultTease = this.activeVaultTease;
    if (vaultTease?.state === "waiting") {
      vaultTease.state = "cancelled";
      try { vaultTease.finish(); } catch { /* 隔离处理器 */ }
    }
    this.activeVaultTease = null;
    this.pendingVaultUpgradeMembers = 0;

    try { this.cancelRageCascadePresentation(); } catch { /* 隔离处理器 */ }
    this.setRageCascadePlaybackPaused(false);
    if ((this.activeRageCollectionCells?.length ?? 0) > 0
      || (this.activeRageCollectionTrails?.size ?? 0) > 0) {
      this.endRageCollectionPlaybackScope();
    }
    this.rageCollectionPlaybackPaused = false;

    for (const animation of [...this.animations]) {
      try {
        if (typeof animation.cancel === "function") animation.cancel();
        else animation.finish();
      } catch { /* 隔离处理器 */ }
    }
    for (const cleanup of [...this.managedWheelSceneCleanups]) {
      // 首先删除，以便扔掉的陈旧处理器仅保留一次。 / English: Delete first so that the old processors that are thrown away are kept only once.
      this.managedWheelSceneCleanups.delete(cleanup);
      try { cleanup(); } catch { /* 隔离处理器 */ }
    }
    this.activeWheelScene = null;
    this.reelAlphaLayers.restore();

    // 外部检查点没有 RAF 来拥有自己的场景。立即移除所有临时儿童；他们后来的最后块仍然无害。 / English: External checkpoints don't have RAFs to have their own scenes. All temporary children are removed immediately; their later final blocks remain harmless.
    const transientView = this.view as Container | undefined;
    for (const child of [...(transientView?.children ?? [])]) {
      try { this.release(child as Container); } catch { /* 隔离处理器 */ }
    }
  }

  async presentBeforeReels(event: GridExpandedEvent, reducedMotion = false): Promise<void> {
    if (this.destroyed) return;
    const token = this.currentPresentationToken();
    const fromRows = this.reels.activeRows;
    // 当下一个 Free Spin 保持相同高度时，GameExpandingReelDelayFeature 仍调度 EXPAND_REELS。几何形状未改变， / English: GameExpandingReelDelayFeature still dispatches EXPAND_REELS when the next Free Spin remains at the same height. The geometry remains unchanged,
    // 但 450ms 控制器门和 1000ms 调整大小生命周期仍然可见。 / English: But the 450ms controller gate and 1000ms resize lifecycle are still visible.
    const plan = reelResizePlan(fromRows, event.rows, reducedMotion);
    const structureAnimation = reelStructureAnimation(plan.direction);
    let characterAnimationStarted = false;
    let frameAnimationStarted = false;
    const duration = plan.totalMs;

    try {
      await this.animate(duration, (progress) => {
        const elapsedMs = progress * duration;
        if (!characterAnimationStarted && elapsedMs >= plan.dataAtMs) {
          characterAnimationStarted = true;
          if (plan.direction !== "same") this.hooks.onReelStructure?.(plan.direction);
        }
        const resizeProgress = reelResizeProgress(
          elapsedMs,
          fromRows,
          event.rows,
          reducedMotion,
        );
        if (!frameAnimationStarted && elapsedMs >= plan.resizeAtMs) {
          frameAnimationStarted = true;
          if (structureAnimation) {
            const played = this.reels.playAuthoredFrame(
              structureAnimation,
              false,
              plan.direction === "shrink" ? 0.288 : 0,
            );
            if (!played) {
              this.visualTelemetry?.failedToStart(
                this.visualDescriptor("reel.frame", event.type),
                { stage: "animation", code: "missing-animation", fallback: "procedural" },
              );
            }
          }
        }
        if (resizeProgress > 0) {
          this.reels.setRowsTransition(fromRows, event.rows, resizeProgress);
        }
      });
    } catch (error) {
      if (!isFeaturePresentationCancelled(error)) throw error;
    } finally {
      if (this.isPresentationCurrent(token)) {
        this.reels.setRowsTransition(fromRows, event.rows, 1);
      }
    }
  }

  async presentAfterReels(event: FeatureEvent, reducedMotion = false): Promise<void> {
    if (this.destroyed) return;
    const token = this.currentPresentationToken();
    try {
      switch (event.type) {
      case "grid.expanded":
        return;
      case "vault.awarded":
        // 预设的 Vault 符号拥有其中奖剪辑。旧的程序挑战/裂缝/开门覆盖物在捕获中不存在。 / English: The preset Vault symbols have their winning clips. The old procedural challenge/crack/door opening overlays no longer exist in Capture.
        await this.presentVisual(
          this.visualDescriptor("vault.award", event.type),
          reducedMotion,
          (operation) => {
            if (!this.reels.applyVaultAward(event)) {
              this.failVisual(operation, {
                stage: "animation",
                code: "missing-animation",
                fallback: "bitmap",
              });
            }
          },
        );
        return;
      case "vault.upgraded":
        await this.presentVisual(
          this.visualDescriptor("vault.upgrade", event.type),
          reducedMotion,
          (operation) => this.presentVaultUpgradeMember(event, reducedMotion, operation),
        );
        return;
      case "vault.unlocked":
        await this.presentVisual(
          this.visualDescriptor("vault.unlock", event.type),
          reducedMotion,
          (operation) => this.presentVaultMutationBatchForToken(
            [event],
            reducedMotion,
            operation,
            token,
          ),
        );
        return;
      case "wheel.awarded":
        await this.presentWheel(event, reducedMotion, token);
        return;
      case "surge.collected":
        // 精确三 Rage 已由 StopSequencer 预设的 SCATTER_FEATURE_ACTIVATE + 1250ms stop-outro 拥有。 / English: Exact three Rage already owned by StopSequencer default SCATTER_FEATURE_ACTIVATE + 1250ms stop-outro.
        // 它没有 PPS 收集、重新旋转、替换矩阵或 rage.transformed 连线事件。此处重播一/二 Rage 级联将添加伪造的 4120ms 场景。 / English: It has no PPS collection, respins, replacement matrices or rage.transformed connection events. Replaying the one/two Rage cascade here will add a fake 4120ms scene.
        switch (surgePresentationBranch(event.triggered, event.guaranteed)) {
          case "post-stop-activation":
            return;
          case "cascade-on-transform":
            return;
          case "collect":
            await this.presentSurgeCollection(event, reducedMotion, token);
            return;
        }
      case "rage.transformed":
        await this.presentVisual(
          this.visualDescriptor("rage.cascade", event.type),
          reducedMotion,
          (operation) => this.presentRageCascade(event.cells, reducedMotion, operation, token),
        );
        return;
      case "free_spins.started":
        await this.presentFreeSpinsStart(event, reducedMotion, token);
        return;
      case "free_spin.awarded":
      case "free_spin.cap_reached":
        // 两个表现流程均归 FreeSpinHudView 所有。额外旋转使用批量预设的收集轨迹； CAPLIMIT 使用重新触发面板。 / English: Both rendering processes are owned by FreeSpinHudView. Extra spins use the batch preset's collection track; CAPLIMIT uses the retrigger panel.
        return;
      case "win_cap.reached":
        // 纯经济边界事实，保持可观测但不额外伪造未定义的独立动画。 / English: Purely economic boundary facts that remain observable but do not additionally falsify undefined independent animations.
        return;
      case "free_spins.completed":
        await this.presentFreeSpinsSummary(event, reducedMotion, token);
        return;
      case "wheel.started":
      case "vaults.landed":
      case "vaults.locked":
      case "vaults.unlock.completed":
        return;
      case "vaults.unlock.started":
      case "vaults.upgrade.started":
        await this.presentVaultGroupBarrier({ type: event.type, count: event.count }, reducedMotion);
        return;
      }
    } catch (error) {
      if (!isFeaturePresentationCancelled(error)) throw error;
    }
  }

  /**
   * 环境桥首先启动 ape 和预设框架。此方法是在任何符号变异之前捕获的 500ms 组屏障。
   *
   * 英文 / English: The environment bridge first starts ape and preset frameworks. This method captures a 500ms group barrier before any symbol mutation.
   */
  async presentVaultGroupBarrier(
    event: VaultGroupStartEvent,
    reducedMotion = false,
  ): Promise<void> {
    if (this.destroyed) return;
    const token = this.currentPresentationToken();
    this.pendingVaultUpgradeMembers = event.type === "vaults.upgrade.started"
      ? Math.max(0, event.count)
      : 0;
    try {
      await this.animate(vaultGroupBarrierDurationMs(reducedMotion), () => undefined);
      this.assertPresentationCurrent(token);
    } catch (error) {
      if (!isFeaturePresentationCancelled(error)) throw error;
    }
  }

  /**
   * 匹配 handleBonusUnlockAndUpgrade 的公共批次条目：所有提供的解锁/升级剪辑同步开始，然后在交换权威解锁面孔之前等待一个共享持续时间。
   *
   * 英文 / English: Public batch entry matching handleBonusUnlockAndUpgrade: All provided unlock/upgrade clips start synchronously, then wait for a shared duration before exchanging authoritative unlock faces.
   */
  async presentVaultMutationBatch(
    events: readonly VaultMutationEvent[],
    reducedMotion = false,
    visualOperation: VisualTelemetryOperation | null = null,
  ): Promise<void> {
    if (this.destroyed || events.length === 0) return;
    const token = this.currentPresentationToken();
    try {
      await this.presentVaultMutationBatchForToken(
        events,
        reducedMotion,
        visualOperation,
        token,
      );
    } catch (error) {
      if (!isFeaturePresentationCancelled(error)) throw error;
    }
  }

  private async presentVaultMutationBatchForToken(
    events: readonly VaultMutationEvent[],
    reducedMotion: boolean,
    visualOperation: VisualTelemetryOperation | null,
    token: FeaturePresentationToken,
  ): Promise<void> {
    this.assertPresentationCurrent(token);
    const unlocks: VaultUnlockedEvent[] = [];
    for (const event of events) {
      if (event.type === "vault.unlocked") {
        if (!this.reels.beginVaultUnlock(event)) {
          this.failVisual(visualOperation, {
            stage: "animation",
            code: "missing-animation",
            fallback: "bitmap",
          });
        }
        unlocks.push(event);
      } else {
        if (!this.reels.applyVaultUpgrade(event)) {
          this.failVisual(visualOperation, {
            stage: "animation",
            code: "missing-animation",
            fallback: "bitmap",
          });
        }
      }
    }
    const { durationMs } = vaultMutationBatchPlan(events, reducedMotion);
    const phaseObserver = this.vaultUnlockMilestoneListener ?? this.hooks.onVaultUnlockPhase;
    const unlockCells = unlocks.map(({ reel, row }) => ({ reel, row }));
    if (!phaseObserver || unlocks.length === 0) {
      try {
        if (durationMs > 0) await this.animate(durationMs, () => undefined);
      } finally {
        if (this.isPresentationCurrent(token)) {
          for (const event of unlocks) this.reels.completeVaultUnlock(event);
        }
      }
      return;
    }

    // 捕获模式仅冻结已寻址的 Symbol8 实例。当观察者检查精确预设的附件边界时，柜体的其余部分、角色和框架保持其自然时钟。 / English: Capture mode freezes only addressed Symbol8 instances. While the observer examines the precisely preset boundaries of the accessories, the rest of the cabinet, character and frame maintains its natural clock.
    this.reels.setSymbolPlaybackPaused(unlockCells, true);
    try {
      await this.notifyVaultUnlockPhase("vault-unlock.enter", unlocks, token);
      const firstKeyAtMs = Math.min(
        durationMs,
        PRIMAL_VAULT_UNLOCK_CHECKPOINT_MS.firstAttachmentKey,
      );
      if (firstKeyAtMs > 0) await this.animate(firstKeyAtMs, () => undefined);
      this.assertPresentationCurrent(token);
      this.reels.advanceSymbolPlayback(unlockCells, firstKeyAtMs);
      await this.notifyVaultUnlockPhase("vault-unlock.key-1", unlocks, token);

      const impactAtMs = Math.min(durationMs, PRIMAL_VAULT_UNLOCK_CHECKPOINT_MS.impact);
      const impactDeltaMs = Math.max(0, impactAtMs - firstKeyAtMs);
      if (impactDeltaMs > 0) await this.animate(impactDeltaMs, () => undefined);
      this.assertPresentationCurrent(token);
      this.reels.advanceSymbolPlayback(unlockCells, impactDeltaMs);
      await this.notifyVaultUnlockPhase("vault-unlock.impact", unlocks, token);

      const remainingMs = Math.max(0, durationMs - impactAtMs);
      if (remainingMs > 0) await this.animate(remainingMs, () => undefined);
      this.assertPresentationCurrent(token);
      this.reels.advanceSymbolPlayback(unlockCells, remainingMs);
      if (this.isPresentationCurrent(token)) {
        for (const event of unlocks) this.reels.completeVaultUnlock(event);
        await this.notifyVaultUnlockPhase("vault-unlock.unlocked", unlocks, token);
      }
    } finally {
      try {
        this.reels.setSymbolPlaybackPaused(unlockCells, false);
      } catch {
        // 取消可能已经丢弃了所寻址的卷轴网格。 / English: Cancellation may have discarded the addressed scroll grid.
      }
    }
  }

  private async notifyVaultUnlockPhase(
    phase: VaultUnlockPresentationPhase,
    events: readonly Readonly<VaultUnlockedEvent>[],
    token: FeaturePresentationToken,
  ): Promise<void> {
    const observer = this.vaultUnlockMilestoneListener ?? this.hooks.onVaultUnlockPhase;
    if (!observer) return;
    for (const event of events) {
      try {
        const pending = observer(Object.freeze({ phase, event: Object.freeze({ ...event }) }));
        if (isPromiseLike(pending)) await this.awaitPresentation(pending, token);
        this.assertPresentationCurrent(token);
      } catch (error) {
        if (isFeaturePresentationCancelled(error)) throw error;
        // 捕获观察器仅具有诊断作用，并且始终会出现故障打开。 / English: The Capture Viewer is diagnostic only and will always fail open.
      }
    }
  }

  /**
   * GameUnlockBonusFeature 的仅限免费旋转的预期门。每个名为 Vault 的人都一起开始其预设的戏弄，
   * 然后控制器在猿重击之前保持一秒钟（加上原始的 500ms 锁定/未中奖的恩典）。
   *
   * 英文 / English: Free-Spin-only anticipation gate for GameUnlockBonusFeature. Every named Vault starts its authored tease simultaneously; the controller then holds for one second before the ape slam, in addition to the original 500 ms locked/no-win grace period.
   */
  async presentVaultTease(
    event: Pick<VaultGroupEvent, "cells">,
    reducedMotion = false,
    lockedNoWinExtraHold = false,
  ): Promise<void> {
    if (this.destroyed || event.cells.length === 0) return;
    const descriptor = this.visualDescriptor("vault.tease", "vaults.landed");
    const played = this.reels.playVaultTease(event.cells);
    const playbackReady = reportVaultTeasePlaybackReadiness(
      this.visualTelemetry,
      event.cells.length,
      played,
    );
    const duration = vaultTeaseDurationMs(reducedMotion, lockedNoWinExtraHold);
    const skipTarget = new Graphics();
    skipTarget.beginFill(0xffffff, 0.001)
      .drawRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT)
      .endFill();
    skipTarget.hitArea = new Rectangle(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    skipTarget.interactive = true;
    skipTarget.buttonMode = true;
    skipTarget.on("pointertap", () => this.requestVaultTeaseSkip());
    this.view.addChild(skipTarget);
    const visualOperation = playbackReady
      ? this.visualTelemetry?.start(descriptor) ?? null
      : null;

    const interaction: ActiveVaultTease = {
      cells: [...event.cells],
      state: "waiting",
      finish: () => undefined,
    };
    this.activeVaultTease = interaction;
    let visualFailed = false;
    try {
      await this.animate(
        duration,
        () => undefined,
        (finish) => { interaction.finish = finish; },
      );
    } catch (error) {
      if (isFeaturePresentationCancelled(error)) {
        visualFailed = true;
        this.completeVisual(visualOperation, reducedMotion, "cancelled");
        return;
      }
      visualFailed = true;
      this.failVisual(visualOperation, {
        stage: "animation",
        code: "playback-failed",
        fallback: "none",
      });
      throw error;
    } finally {
      if (interaction.state === "waiting") interaction.state = "finished";
      if (this.activeVaultTease === interaction) this.activeVaultTease = null;
      this.release(skipTarget);
      if (!visualFailed) {
        this.completeVisual(
          visualOperation,
          reducedMotion,
          interaction.state === "skipped" ? "continued" : "natural",
        );
      }
    }
  }

  /**
   * 在一批同步中启动每一个预设的额外旋转轨迹。目标在此效果视图的坐标空间中提供，因此捕获的 Spine 骨骼保留其原始源到计数器的几何形状。
   *
   * 英文 / English: Launch each preset extra rotation track in a batch sync. The target is provided in the coordinate space of this effect view, so the captured Spine retains its original source-to-counter geometry.
   */
  async presentFreeSpinAwardTrails(
    events: readonly Readonly<FreeSpinAwardedEvent>[],
    target: Point,
    reducedMotion = false,
  ): Promise<void> {
    if (this.destroyed || events.length === 0) return;
    const token = this.currentPresentationToken();
    const descriptor = this.visualDescriptor("free-spin.trails", "free_spin.awarded");
    if (!authoredInteractionData.trail) {
      try {
        await this.awaitPresentation(loadAuthoredInteractionSpines(), token);
      } catch (error) {
        if (isFeaturePresentationCancelled(error)) return;
        this.visualTelemetry?.failedToStart(descriptor, {
          stage: "load",
          code: "asset-load-failed",
          fallback: "none",
        });
        throw error;
      }
    }
    this.assertPresentationCurrent(token);

    const scene = new Container();
    for (const event of events) {
      if (!Number.isInteger(event.reel) || !Number.isInteger(event.row)) continue;
      const source = this.reels.getCellCenter({ reel: event.reel!, row: event.row! });
      if (!source) continue;
      const trail = createAuthoredCollectTrail(
        authoredInteractionData.trail,
        this.effectPoint(source),
        target,
        reducedMotion,
      );
      if (trail) scene.addChild(trail);
    }
    this.view.addChild(scene);
    const hasAuthoredPresentation = reducedMotion || scene.children.length > 0;
    if (!hasAuthoredPresentation) {
      this.visualTelemetry?.failedToStart(descriptor, {
        stage: "create",
        code: "empty-presentation",
        fallback: "none",
      });
    }
    const visualOperation = hasAuthoredPresentation
      ? this.visualTelemetry?.start(descriptor) ?? null
      : null;
    let visualFailed = false;
    try {
      await this.animate(reducedMotion ? 120 : RAGE_COLLECT_TRAIL_MS, () => undefined);
    } catch (error) {
      if (isFeaturePresentationCancelled(error)) {
        visualFailed = true;
        this.completeVisual(visualOperation, reducedMotion, "cancelled");
        return;
      }
      visualFailed = true;
      this.failVisual(visualOperation, {
        stage: "animation",
        code: "playback-failed",
        fallback: "none",
      });
      throw error;
    } finally {
      this.release(scene);
      if (!visualFailed) this.completeVisual(visualOperation, reducedMotion);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visualTelemetry?.cancelAll();
    this.rageCascadeMilestoneListener = null;
    this.cancelActivePresentation();
    const wheelArtwork = this.wheelArtwork;
    this.wheelArtwork = null;
    this.freeSpinArtwork = null;
    disposeVerifiedWheelArtwork(wheelArtwork);
  }

  private async presentSurgeCollection(
    event: SurgeCollectedEvent,
    reducedMotion: boolean,
    token: FeaturePresentationToken,
  ): Promise<void> {
    if (await this.presentAuthoredSurgeCollection(event, reducedMotion, token)) return;
    this.assertPresentationCurrent(token);
    const targets = event.cells.flatMap((address) => {
      const local = this.reels.getCellCenter(address);
      return local ? [this.effectPoint(local)] : [];
    });
    if (targets.length === 0) return;

    const scene = new Container();
    const source = new Point(LOGICAL_WIDTH / 2, 92);
    const dim = new Graphics();
    dim.beginFill(0x040607, 1).drawRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT).endFill();
    dim.alpha = 0;

    const energy = new Sprite(energyFrameTexture(ENERGY_FRAME_GRID.firstVisibleFrame));
    energy.anchor.set(0.5);
    energy.position.copyFrom(source);
    energy.width = 190;
    energy.height = 190;
    energy.alpha = 0;

    const beams = new Graphics();
    const targetNodes = targets.map((target, index) => {
      const node = new Container();
      const glow = new Graphics();
      glow.beginFill(index % 2 === 0 ? 0xff3c27 : 0xff7a2d, 0.15).drawCircle(0, 0, 48).endFill();
      glow.lineStyle(5, 0xff5128, 0.72).drawCircle(0, 0, 32);
      glow.lineStyle(2, 0xffdda0, 0.88).drawCircle(0, 0, 20);
      node.position.copyFrom(target);
      node.alpha = 0;
      node.addChild(glow);
      scene.addChild(node);
      return node;
    });
    const motes = targets.map((target, index) => {
      const mote = new Graphics();
      mote.beginFill(index % 2 === 0 ? 0xfff0bd : 0xff9a48, 0.98).drawCircle(0, 0, 5 + index % 2 * 2).endFill();
      mote.lineStyle(3, 0xff3d28, 0.52).drawCircle(0, 0, 10 + index % 3 * 2);
      mote.position.copyFrom(target);
      mote.alpha = 0;
      scene.addChild(mote);
      return mote;
    });

    const core = new Graphics();
    core.beginFill(0xff4b28, 0.13).drawCircle(0, 0, 72).endFill();
    core.beginFill(0xff9d43, 0.26).drawCircle(0, 0, 42).endFill();
    core.lineStyle(4, 0xffd27c, 0.82).drawCircle(0, 0, 28);
    core.position.copyFrom(source);
    core.alpha = 0;

    const count = new Text(`${event.count}/3`, new TextStyle({
      fill: 0xffe4ae,
      fontFamily: "Arial Black, Impact, sans-serif",
      fontSize: 24,
      fontWeight: "900",
      stroke: 0x160706,
      strokeThickness: 5,
    }));
    count.anchor.set(0.5);
    count.position.copyFrom(source);
    count.alpha = 0;

    const shockwave = new Graphics();
    shockwave.lineStyle(8, event.guaranteed ? 0xffd06d : 0xff5b2d, 0.72).drawCircle(0, 0, 72);
    shockwave.lineStyle(2, 0xfff0c5, 0.76).drawCircle(0, 0, 102);
    shockwave.position.copyFrom(source);
    shockwave.alpha = 0;

    const banner = createBanner(
      featureEffectLabel(event, this.moneyFormatter),
      event.triggered ? 0xff6230 : 0xb66c38,
      610,
    );
    banner.position.set(LOGICAL_WIDTH / 2, 178);
    banner.alpha = 0;
    scene.addChild(dim, beams, energy, core, count, shockwave, banner);
    // 在早期创建后，将节点/节点重新插入到暗淡和光束上方。 / English: Re-insert the nodes/nodes above the dim and beam after the earlier creation.
    targetNodes.forEach((node) => scene.addChild(node));
    motes.forEach((mote) => scene.addChild(mote));
    scene.addChild(core, count, shockwave, banner);
    this.view.addChild(scene);

    try {
      await Promise.all([
        this.commitRageCollectionAfterBarrier(reducedMotion, token),
        this.animate(featureEffectDuration("collect", reducedMotion), (progress) => {
        const frame = surgeCollectionFrame(progress, event.triggered, event.guaranteed, reducedMotion);
        dim.alpha = frame.sceneDim;
        const revealFrame = ENERGY_FRAME_GRID.firstVisibleFrame + Math.floor(
          phase(progress, 0, 0.58)
          * (ENERGY_FRAME_GRID.revealLastFrame - ENERGY_FRAME_GRID.firstVisibleFrame),
        );
        const loopFrame = ENERGY_FRAME_GRID.loopFirstFrame
          + Math.floor(progress * 64) % (ENERGY_FRAME_GRID.loopLastFrame - ENERGY_FRAME_GRID.loopFirstFrame + 1);
        energy.texture = energyFrameTexture(progress < 0.58 ? revealFrame : loopFrame);
        energy.alpha = frame.chargeAlpha * (event.triggered ? 1 : 0.54);
        energy.rotation = progress * (event.guaranteed ? 1.25 : 0.72);
        energy.scale.set(0.78 + frame.chargeScale * 0.28);
        beams.clear();
        const beamLife = 1 - phase(progress, 0.58, 0.76);
        targets.forEach((target, index) => {
          const staggeredBeam = clamp(frame.beamProgress * 1.22 - index * 0.1);
          if (staggeredBeam > 0 && beamLife > 0) {
            const endX = mix(source.x, target.x, staggeredBeam);
            const endY = mix(source.y, target.y, staggeredBeam);
            beams.lineStyle(10, 0x8d1d22, 0.24 * beamLife).moveTo(source.x, source.y).lineTo(endX, endY);
            beams.lineStyle(4, 0xff5335, 0.76 * beamLife).moveTo(source.x, source.y).lineTo(endX, endY);
            beams.lineStyle(1.5, 0xfff0cf, 0.92 * beamLife).moveTo(source.x, source.y).lineTo(endX, endY);
          }
          const node = targetNodes[index];
          if (node) {
            node.alpha = frame.targetAlpha * (1 - phase(progress, 0.6, 0.82));
            node.scale.set(0.74 + Math.sin(progress * Math.PI * 8 + index) * 0.08 + frame.targetAlpha * 0.2);
          }
          const travel = clamp(frame.moteProgress * 1.18 - index * 0.08);
          const mote = motes[index];
          if (mote) {
            mote.position.set(mix(target.x, source.x, travel), mix(target.y, source.y, travel));
            mote.alpha = travel > 0 && travel < 1 ? 1 - phase(travel, 0.82, 1) : 0;
            mote.scale.set(0.72 + travel * 0.54);
          }
        });
        core.alpha = frame.chargeAlpha;
        core.scale.set(frame.chargeScale);
        count.alpha = frame.chargeAlpha;
        count.scale.set(0.82 + frame.chargeAlpha * 0.18);
        shockwave.alpha = frame.shockwaveAlpha;
        shockwave.scale.set(0.45 + outCubic(phase(progress, 0.62, 1)) * 2.25);
        banner.alpha = frame.bannerAlpha;
        banner.y = mix(195, 178, outCubic(progress));
        if (!event.triggered) banner.alpha = Math.max(banner.alpha, frame.missAlpha);
        }),
      ]);
    } finally {
      this.release(scene);
    }
  }

  private async presentRageCascade(
    transformedCells: readonly Readonly<CellAddress>[],
    reducedMotion: boolean,
    visualOperation: VisualTelemetryOperation | null,
    token: FeaturePresentationToken,
  ): Promise<void> {
    const transformed = new Set(transformedCells.map(({ reel, row }) => `${reel}:${row}`));
    const cellOrder = this.rageCascadeCellOrderSource();
    const plan = rageCascadePlan(cellOrder);
    const duration = reducedMotion ? 120 : plan.totalMs;
    const timeScale = duration / plan.totalMs;
    let nextMilestone = 0;
    let exploding = false;
    let placed = false;
    let sourceHidden = false;
    let activationAttempted = 0;
    let activationPlayed = 0;
    const active: ActiveRageCascade = {
      cancelled: false,
      cleaned: false,
      finish: null,
      resume: null,
    };
    this.activeRageCascade = active;
    this.rageCascadePlaybackPaused = false;
    // 仅当安装了可选的诊断侦听器时才分配不可变的观察事实；正常的制作播放保留其旧路径。 / English: Immutable observation facts are only assigned when the optional diagnostic listener is installed; normal production playback retains its old path.
    const observedTransformedCells = this.rageCascadeMilestoneListener
      ? Object.freeze(transformedCells.map((cell) => Object.freeze({ ...cell })))
      : transformedCells;
    const actualAt = (authoredAtMs: number): number => authoredAtMs * timeScale;
    const observedShuffledCells = this.rageCascadeMilestoneListener
      ? Object.freeze(cellOrder.map((cellIndex, orderIndex) => {
        const address = Object.freeze({
          reel: Math.floor(cellIndex / 3),
          row: cellIndex % 3,
        });
        const authoredAtMs = PRIMAL_FEATURE_ANIMATION_MS.rageCascade.swing
          + orderIndex * PRIMAL_FEATURE_ANIMATION_MS.rageCascade.perCellExplosion;
        return Object.freeze({
          orderIndex,
          cellIndex,
          address,
          transformsToRage: transformed.has(`${address.reel}:${address.row}`),
          authoredAtMs,
          elapsedMs: actualAt(authoredAtMs),
        });
      }))
      : EMPTY_RAGE_CASCADE_SHUFFLED_CELLS;
    const sourceHiddenAtMs = plan.activationAtMs
      + PRIMAL_SYMBOL_ANIMATION_MS[7].featureActivation
      + PRIMAL_SYMBOL_ANIMATION_MS[7].hide;
    const failMissingAnimation = (): void => {
      this.failVisual(visualOperation, {
        stage: "animation",
        code: "missing-animation",
        fallback: "procedural",
      });
    };
    const cancellationError = (): Error => (
      // 可重复使用的圆形边界被 presentAfterReels 故意吞没。专门的级联取消（和完整的渲染器销毁）为直接诊断调用者保留了旧的拒绝合同。 / English: Reusable circular borders are deliberately swallowed by presentAfterReels. Specialized cascading cancellation (and complete renderer destruction) preserves the old rejection contract for direct diagnostic callers.
      !this.destroyed && !this.isPresentationCurrent(token)
        ? new FeaturePresentationCancelledError()
        : new RageCascadePresentationCancelledError()
    );

    try {
      try {
        this.reels.prepareRageCascade();
        if (!this.reels.playAuthoredFrame("respin")) failMissingAnimation();
        this.hooks.onRageRespin?.();
        this.notifyRageCascadeMilestone(
          "started",
          observedTransformedCells,
          0,
          0,
          reducedMotion,
          activationAttempted,
          activationPlayed,
          false,
        );
        if (active.cancelled || this.destroyed) {
          throw cancellationError();
        }

        await this.animateRageCascadePlayback(duration, (progress) => {
          if (active.cancelled || this.destroyed || this.rageCascadePlaybackPaused) return;
          const elapsedMs = progress * duration;
          while (nextMilestone < plan.milestones.length) {
            if (active.cancelled || this.destroyed || this.rageCascadePlaybackPaused) break;
            const milestone = plan.milestones[nextMilestone];
            if (!milestone || actualAt(milestone.atMs) > elapsedMs) break;
            if (!placed && milestone.atMs > plan.cascadeCompleteAtMs
              && elapsedMs >= actualAt(plan.cascadeCompleteAtMs)) {
              placed = true;
              this.notifyRageCascadeMilestone(
                "placed",
                observedTransformedCells,
                plan.cascadeCompleteAtMs,
                actualAt(plan.cascadeCompleteAtMs),
                reducedMotion,
                activationAttempted,
                activationPlayed,
                false,
              );
              if (this.rageCascadePlaybackPaused) return;
            }
            nextMilestone += 1;
            switch (milestone.type) {
            case "cell": {
              const address = {
                reel: Math.floor(milestone.cellIndex / 3),
                row: milestone.cellIndex % 3,
              };
              const transformsToRage = transformed.has(`${address.reel}:${address.row}`);
              const played = this.reels.revealRageCascadeCell(
                address,
                transformsToRage,
              );
              if (!played) failMissingAnimation();
              if (!exploding) {
                exploding = true;
                const shakeAtMs = PRIMAL_FEATURE_ANIMATION_MS.rageCascade.respinShakeDelay;
                this.notifyRageCascadeMilestone(
                  "exploding",
                  observedTransformedCells,
                  milestone.atMs,
                  actualAt(milestone.atMs),
                  reducedMotion,
                  activationAttempted,
                  activationPlayed,
                  false,
                  observedShuffledCells,
                  "respin",
                  shakeAtMs,
                  actualAt(shakeAtMs),
                );
              }
              break;
            }
            case "backdrop-shake": {
              this.hooks.onRageBackdropShake?.(milestone.phase);
              break;
            }
            case "pound":
              if (!this.reels.playAuthoredFrame("pound")) failMissingAnimation();
              this.hooks.onRagePound?.();
              this.notifyRageCascadeMilestone(
                "pound",
                observedTransformedCells,
                milestone.atMs,
                actualAt(milestone.atMs),
                reducedMotion,
                activationAttempted,
                activationPlayed,
                false,
              );
              break;
            case "activation":
              {
                const activation = this.reels.activateRageCascade();
                activationAttempted = activation.attempted;
                activationPlayed = activation.played;
                if (activation.attempted !== 3 || activation.played !== 3) {
                  failMissingAnimation();
                }
                this.notifyRageCascadeMilestone(
                  "activation",
                  observedTransformedCells,
                  milestone.atMs,
                  actualAt(milestone.atMs),
                  reducedMotion,
                  activationAttempted,
                  activationPlayed,
                  false,
                  EMPTY_RAGE_CASCADE_SHUFFLED_CELLS,
                  "pound",
                  plan.poundAtMs + PRIMAL_FEATURE_ANIMATION_MS.rageCascade.poundShakeDelay,
                  actualAt(
                    plan.poundAtMs + PRIMAL_FEATURE_ANIMATION_MS.rageCascade.poundShakeDelay,
                  ),
                );
              }
              break;
            }
          }
          if (active.cancelled || this.destroyed || this.rageCascadePlaybackPaused) return;
          if (!placed && elapsedMs >= actualAt(plan.cascadeCompleteAtMs)) {
            placed = true;
            this.notifyRageCascadeMilestone(
              "placed",
              observedTransformedCells,
              plan.cascadeCompleteAtMs,
              actualAt(plan.cascadeCompleteAtMs),
              reducedMotion,
              activationAttempted,
              activationPlayed,
              false,
            );
            if (this.rageCascadePlaybackPaused) return;
          }
          if (!sourceHidden && elapsedMs >= actualAt(sourceHiddenAtMs)) {
            sourceHidden = true;
            this.notifyRageCascadeMilestone(
              "source-hidden",
              observedTransformedCells,
              sourceHiddenAtMs,
              actualAt(sourceHiddenAtMs),
              reducedMotion,
              activationAttempted,
              activationPlayed,
              true,
            );
          }
        }, (finish) => {
          active.finish = finish;
          if (active.cancelled) finish();
        });
        if (active.cancelled || this.destroyed) {
          throw cancellationError();
        }
      } finally {
        this.cleanupRageCascade(active);
      }
      this.notifyRageCascadeMilestone(
        "complete",
        observedTransformedCells,
        plan.totalMs,
        duration,
        reducedMotion,
        activationAttempted,
        activationPlayed,
        true,
      );
      await this.waitForRageCascadeResume(active);
      if (active.cancelled || this.destroyed) {
        throw cancellationError();
      }
    } finally {
      this.rageCascadePlaybackPaused = false;
      active.resume?.();
      active.resume = null;
      if (this.activeRageCascade === active) this.activeRageCascade = null;
    }
  }

  private async presentAuthoredSurgeCollection(
    event: SurgeCollectedEvent,
    reducedMotion: boolean,
    token: FeaturePresentationToken,
  ): Promise<boolean> {
    const descriptor = this.visualDescriptor("rage.collect", event.type);
    const addressed = event.cells.flatMap((address) => {
      const local = this.reels.getCellCenter(address);
      return local ? [{ address, point: this.effectPoint(local) }] : [];
    });
    if (addressed.length === 0) {
      this.visualTelemetry?.failedToStart(descriptor, {
        stage: "slot",
        code: "empty-presentation",
        fallback: "procedural",
      });
      return false;
    }

    const plan = rageCollectionPlan(addressed.length, event.guaranteed);
    if (plan.kind === "guaranteed-activation") {
      // 防御幂等性：StopSequencer 在 presentAfterReels 可以运行之前拥有此激活。如果未来的调用者直接到达此帮助程序，切勿激活、收集或级联两次。 / English: Defending idempotence: StopSequencer has this activation before presentAfterReels can run. Never activate, collect, or cascade twice if future callers reach this helper directly.
      return true;
    }

    const target = this.characterCollectTarget?.() ?? new Point(LOGICAL_WIDTH / 2, 92);
    const scene = new Container();
    const trails = addressed.map(({ point }) => createAuthoredCollectTrail(
      authoredInteractionData.trail,
      point,
      target,
      reducedMotion,
    ));
    if (!reducedMotion && trails.every((trail) => trail === null)) {
      this.visualTelemetry?.failedToStart(descriptor, {
        stage: "create",
        code: authoredInteractionData.trail ? "spine-create-failed" : "empty-presentation",
        fallback: "procedural",
      });
      return false;
    }
    for (const trail of trails) if (trail) scene.addChild(trail);
    this.view.addChild(scene);
    const visualOperation = this.visualTelemetry?.start(descriptor) ?? null;

    // GamePPSFeature 批量启动每个命名符号和路径。保留数组顺序以实现稳定的源映射，但每个成员的开始时间均为 0 — 故意不存在伪造交错。 / English: GamePPSFeature batch launches each named symbol and path. Array order is preserved for stable source mapping, but each member has a start time of 0—there is intentionally no false interleaving.
    const startedCollections = addressed.reduce((count, { address }) => (
      count + (this.reels.beginSurgeCollection(address) ? 1 : 0)
    ), 0);
    if (startedCollections !== addressed.length) {
      this.failVisual(visualOperation, {
        stage: "animation",
        code: "missing-animation",
        fallback: "procedural",
      });
    }
    const collectionCells = Object.freeze(addressed.map(({ address }) => Object.freeze({
      ...address,
    })));
    const collectionFacts = Object.freeze({
      count: event.count,
      triggered: event.triggered,
      guaranteed: event.guaranteed,
      level: event.level,
      total: event.total,
    });
    this.beginRageCollectionPlaybackScope(collectionCells, trails);
    let towerReactionStarted = false;
    let sourceLayerRestored = false;
    let sourceHidden = false;
    let absorbingObserved = false;
    let naturalComplete = false;
    const duration = reducedMotion ? 120 : plan.presentationMs;
    const actualAt = (authoredAtMs: number): number => (
      reducedMotion ? authoredAtMs / plan.presentationMs * duration : authoredAtMs
    );
    this.notifyRageCollectionMilestone({
      phase: "started",
      cells: collectionCells,
      ...collectionFacts,
      elapsedMs: 0,
      authoredAtMs: 0,
      reducedMotion,
      activated: this.reels.areSurgeCollectionsActivated(collectionCells),
      hidden: false,
      towerReactionStarted: false,
    });
    // GamePPSFeature 一起启动符号、字符和每条踪迹，然后在 1ms 调度程序屏障之后前进其状态机。使视觉生命周期在后台保持活动状态，而不是稍后阻塞 PPS。 / English: GamePPSFeature starts symbols, characters, and each trace together, then advances its state machine after a 1ms scheduler barrier. Keep the visual lifecycle active in the background instead of blocking PPS later.
    const visualLifecycle = this.animateRageCollection(duration, (progress) => {
        const elapsed = progress * duration;
        if (!absorbingObserved && elapsed >= actualAt(RAGE_COLLECT_ABSORBING_MS)) {
          absorbingObserved = true;
          this.notifyRageCollectionMilestone({
            phase: "absorbing",
            cells: collectionCells,
            ...collectionFacts,
            elapsedMs: elapsed,
            authoredAtMs: RAGE_COLLECT_ABSORBING_MS,
            reducedMotion,
            activated: this.reels.areSurgeCollectionsActivated(collectionCells),
            hidden: false,
            towerReactionStarted,
          });
        }
        const shouldRestoreLayer = elapsed >= actualAt(
          plan.symbolLayerRestoreAtMs ?? duration,
        );
        if (!sourceLayerRestored && shouldRestoreLayer) {
          sourceLayerRestored = true;
          addressed.forEach(({ address }) => this.reels.restoreSurgeCollectionLayer(address));
        }
        const shouldHide = elapsed >= actualAt(plan.symbolHideAtMs ?? duration);
        if (!sourceHidden && shouldHide) {
          sourceHidden = true;
          addressed.forEach(({ address }) => this.reels.completeSurgeCollection(address));
          this.notifyRageCollectionMilestone({
            phase: "source-hidden",
            cells: collectionCells,
            ...collectionFacts,
            elapsedMs: elapsed,
            authoredAtMs: plan.symbolHideAtMs ?? RAGE_COLLECT_TRAIL_MS,
            reducedMotion,
            activated: this.reels.areSurgeCollectionsActivated(collectionCells),
            hidden: true,
            towerReactionStarted,
          });
        }
        if (progress >= 1) naturalComplete = true;
    }).finally(() => {
      // 普通所有者完成预设的源剪辑。被取消的所有者不得将旧地址应用于替换的权威网格。 / English: Common owners complete preset source clips. The canceled owner may not apply the old address to the replaced authoritative grid.
      if (this.isPresentationCurrent(token)) {
        if (!sourceLayerRestored) {
          sourceLayerRestored = true;
          addressed.forEach(({ address }) => this.reels.restoreSurgeCollectionLayer(address));
        }
        if (!sourceHidden) {
          sourceHidden = true;
          addressed.forEach(({ address }) => this.reels.completeSurgeCollection(address));
        }
      }
      this.endRageCollectionPlaybackScope();
      this.release(scene);
    });
    void visualLifecycle.then(
      () => {
        if (naturalComplete) {
          this.notifyRageCollectionMilestone({
            phase: "complete",
            cells: collectionCells,
            ...collectionFacts,
            elapsedMs: duration,
            authoredAtMs: RAGE_COLLECT_TRAIL_MS,
            reducedMotion,
            activated: false,
            hidden: true,
            towerReactionStarted,
          });
        }
        this.completeVisual(visualOperation, reducedMotion);
      },
      (error) => {
        if (isFeaturePresentationCancelled(error)) {
          this.completeVisual(visualOperation, reducedMotion, "cancelled");
        } else {
          this.failVisual(visualOperation, {
            stage: "animation",
            code: "playback-failed",
            fallback: "procedural",
          });
        }
      },
    ).catch(() => undefined);
    towerReactionStarted = await this.commitRageCollectionAfterBarrier(reducedMotion, token);
    return true;
  }

  private async presentFreeSpinsStart(
    event: FreeSpinsStartedEvent,
    reducedMotion: boolean,
    token: FeaturePresentationToken,
  ): Promise<void> {
    const descriptor = this.visualDescriptor(
      event.mode === "OVERDRIVE" ? "free-spin.intro.king" : "free-spin.intro.kong",
      event.type,
    );
    if (!this.freeSpinArtwork?.freeSpinIntroKongQuest) {
      try {
        await this.ensureFreeSpinArtwork(token);
      } catch (error) {
        if (isFeaturePresentationCancelled(error)) throw error;
        this.visualTelemetry?.failedToStart(descriptor, {
          stage: "load",
          code: "asset-load-failed",
          fallback: "procedural",
        });
        throw error;
      }
    }
    this.assertPresentationCurrent(token);
    const introData = event.mode === "OVERDRIVE"
      ? this.freeSpinArtwork?.freeSpinIntroKingSpin
      : this.freeSpinArtwork?.freeSpinIntroKongQuest;
    const authoredIntro = createAuthoredPanel(
      introData,
      PRIMAL_PANEL_LAYOUT.freeSpinIntro,
      freeSpinIntroTextFields(event),
      this.responsiveLayoutTrackSource,
    );
    if (authoredIntro) {
      const scene = new Container();
      const dim = new Graphics();
      dim.beginFill(0x020303, 1).drawRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT).endFill();
      dim.alpha = 0;
      scene.addChild(dim, authoredIntro);
      this.view.addChild(scene);
      const visualOperation = this.visualTelemetry?.start(descriptor) ?? null;
      let visualFailed = false;
      authoredIntro.alpha = 1;
      playAuthoredPanelTrack(authoredIntro, "show", 0, false, reducedMotion);
      // GameFreespinView 在两个变体的同一状态输入帧中开始显示以及每个持久辅助轨道。 / English: GameFreespinView starts displaying in the same state input frame for both variants as well as each persistent auxiliary track.
      if (freeSpinIntroRagsStartPhase(event.mode) === "entry") {
        playAuthoredPanelTrack(authoredIntro, "rags_loop", 1, true, reducedMotion);
      }
      if (event.mode !== "OVERDRIVE") {
        playAuthoredPanelTrack(authoredIntro, "Fire_loop", 2, true, reducedMotion);
        playAuthoredPanelTrack(authoredIntro, "Fire_loop_2", 3, true, reducedMotion);
        playAuthoredPanelTrack(authoredIntro, "fire_glow_Loop", 4, true, reducedMotion);
      }
      const reelAlphaLayer = this.reelAlphaLayers.acquire();
      const originalReelAlpha = reelAlphaLayer.baseAlpha;
      const showMs = reducedMotion ? 70 : PRIMAL_FEATURE_ANIMATION_MS.freeSpinIntro.show;
      const hideMs = reducedMotion ? 70 : PRIMAL_FEATURE_ANIMATION_MS.freeSpinIntro.hide;
      try {
        await this.animate(showMs, (progress) => {
          const presence = smooth(progress);
          dim.alpha = presence * (reducedMotion ? 0.1 : 0.42);
          reelAlphaLayer.setAlpha(mix(originalReelAlpha, 0.24, presence));
          authoredIntro.syncTextFields();
        });
        playAuthoredPanelTrack(authoredIntro, "idle", 0, true, reducedMotion);
        if (!await this.waitForFreeSpinsContinue()) return;
        playAuthoredPanelTrack(authoredIntro, "hide", 0, false, reducedMotion);
        await this.animate(hideMs, (progress) => {
          const presence = 1 - smooth(progress);
          dim.alpha = presence * (reducedMotion ? 0.1 : 0.42);
          reelAlphaLayer.setAlpha(mix(originalReelAlpha, 0.24, presence));
          authoredIntro.syncTextFields();
        });
      } catch (error) {
        if (isFeaturePresentationCancelled(error)) {
          visualFailed = true;
          this.completeVisual(visualOperation, reducedMotion, "cancelled");
          return;
        }
        visualFailed = true;
        this.failVisual(visualOperation, {
          stage: "animation",
          code: "playback-failed",
          fallback: "procedural",
        });
        throw error;
      } finally {
        reelAlphaLayer.release();
        this.release(scene);
        if (!visualFailed) {
          this.completeVisual(
            visualOperation,
            reducedMotion,
            this.destroyed ? "cancelled" : "continued",
          );
        }
      }
      return;
    }

    // 保留原生面板，但将制作素材缺失导致的保真度下降明确暴露给严格视觉测试夹具。 / English: Keep the native panel, but explicitly expose fidelity loss from missing authored artwork to strict visual test fixtures.
    this.visualTelemetry?.failedToStart(descriptor, {
      stage: "create",
      code: "empty-presentation",
      fallback: "procedural",
    });

    const scene = new Container();
    const color = event.mode === "OVERDRIVE" ? 0xff432d : COLORS.amber;
    const dim = new Graphics();
    dim.beginFill(event.mode === "OVERDRIVE" ? 0x160405 : 0x080b0b, 1)
      .drawRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT).endFill();
    dim.alpha = 0;

    const rails = new Graphics();
    rails.lineStyle(9, color, 0.76).drawRoundedRect(336, 168, 608, 430, 30);
    rails.lineStyle(2, 0xffe1a1, 0.58).drawRoundedRect(352, 184, 576, 398, 24);
    for (let x = 382; x <= 898; x += 43) {
      rails.beginFill(x % 2 === 0 ? 0xffbd58 : color, 0.52).drawCircle(x, 181, 4).endFill();
    }
    rails.pivot.set(LOGICAL_WIDTH / 2, 598);
    rails.position.set(LOGICAL_WIDTH / 2, 598);

    const rage = new Sprite(authoredTexture(PRIMAL_ASSETS.symbols.rage));
    rage.anchor.set(0.5);
    rage.position.set(LOGICAL_WIDTH / 2, 312);
    rage.width = 372;
    rage.height = 280;
    const rageBaseScale = rage.scale.x;
    rage.alpha = 0;

    const title = new Text(freeSpinModeTitle(event.mode), new TextStyle({
      fill: event.mode === "OVERDRIVE" ? 0xff6b47 : 0xffc76b,
      fontFamily: "Arial Black, Impact, sans-serif",
      fontSize: 43,
      fontWeight: "900",
      letterSpacing: 3,
      stroke: 0x090a09,
      strokeThickness: 8,
    }));
    title.anchor.set(0.5);
    title.position.set(LOGICAL_WIDTH / 2, 458);

    const counter = new Text(`${FREE_SPIN_INTRO_DISPLAY_AWARDED} FREE SPINS`, new TextStyle({
      fill: 0xfff0cb,
      fontFamily: "Arial Black, Impact, sans-serif",
      fontSize: 29,
      fontWeight: "900",
      letterSpacing: 2,
      stroke: 0x090a09,
      strokeThickness: 6,
    }));
    counter.anchor.set(0.5);
    counter.position.set(LOGICAL_WIDTH / 2, 510);

    const pulse = new Graphics();
    pulse.lineStyle(8, color, 0.72).drawEllipse(0, 0, 210, 92);
    pulse.lineStyle(2, 0xffefc4, 0.6).drawEllipse(0, 0, 168, 68);
    pulse.position.set(LOGICAL_WIDTH / 2, 331);
    scene.addChild(dim, rails, pulse, rage, title, counter);
    this.view.addChild(scene);
    const reelAlphaLayer = this.reelAlphaLayers.acquire();
    const originalReelAlpha = reelAlphaLayer.baseAlpha;

    try {
      const showMs = reducedMotion ? 70 : PRIMAL_FEATURE_ANIMATION_MS.freeSpinIntro.show;
      const hideMs = reducedMotion ? 70 : PRIMAL_FEATURE_ANIMATION_MS.freeSpinIntro.hide;
      await this.animate(showMs, (progress) => {
        const frame = featureModeEntryFrame(Math.min(0.82, progress * 0.82), reducedMotion);
        dim.alpha = frame.sceneDim;
        rails.alpha = frame.presence;
        rails.scale.y = frame.railScale;
        pulse.alpha = frame.presence * 0.72;
        pulse.scale.set(0.46 + outCubic(progress) * 2.2, 0.46 + outCubic(progress) * 1.15);
        rage.alpha = frame.presence;
        rage.scale.set(rageBaseScale * (0.72 + outCubic(phase(progress, 0.04, 0.48)) * 0.28));
        title.alpha = frame.titleAlpha;
        title.scale.set(0.86 + outCubic(phase(progress, 0.16, 0.42)) * 0.14);
        counter.alpha = frame.counterAlpha;
        counter.y = mix(532, 510, outCubic(progress));
        reelAlphaLayer.setAlpha(mix(originalReelAlpha, 0.24, frame.presence));
      });
      if (!await this.waitForFreeSpinsContinue()) return;
      await this.animate(hideMs, (progress) => {
        const presence = 1 - smooth(progress);
        scene.alpha = presence;
        reelAlphaLayer.setAlpha(mix(originalReelAlpha, 0.24, presence));
      });
    } finally {
      reelAlphaLayer.release();
      this.release(scene);
    }
  }

  private async waitForFreeSpinsContinue(): Promise<boolean> {
    if (this.destroyed || this.activeFreeSpinContinue) return false;
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => { resolve = settle; });
    const interaction: ActiveFreeSpinContinue = { state: "waiting", resolve };
    this.activeFreeSpinContinue = interaction;
    this.hooks.onFreeSpinsReady?.();
    await promise;
    if (this.activeFreeSpinContinue === interaction) this.activeFreeSpinContinue = null;
    return !this.destroyed && interaction.state === "continued";
  }

  private async presentFreeSpinsSummary(
    event: FreeSpinsCompletedEvent,
    reducedMotion: boolean,
    token: FeaturePresentationToken,
  ): Promise<void> {
    const descriptor = this.visualDescriptor("free-spin.summary", event.type);
    if (!this.freeSpinArtwork?.freeSpinSummary) {
      try {
        await this.ensureFreeSpinArtwork(token);
      } catch (error) {
        if (isFeaturePresentationCancelled(error)) throw error;
        this.visualTelemetry?.failedToStart(descriptor, {
          stage: "load",
          code: "asset-load-failed",
          fallback: "text",
        });
        throw error;
      }
    }
    this.assertPresentationCurrent(token);

    const scene = new Container();
    const dim = new Graphics();
    dim.beginFill(0x020303, 1).drawRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT).endFill();
    dim.alpha = 0;
    const summaryTextFields = freeSpinSummaryTextBindings(event, this.moneyFormatter);
    const authoredSummary = createAuthoredPanel(
      this.freeSpinArtwork?.freeSpinSummary,
      PRIMAL_PANEL_LAYOUT.freeSpinSummary,
      summaryTextFields,
      this.responsiveLayoutTrackSource,
    );
    if (!authoredSummary) {
      this.visualTelemetry?.failedToStart(descriptor, {
        stage: "create",
        code: "empty-presentation",
        fallback: "text",
      });
    }
    const summaryValue = summaryTextFields.find(({ name }) => name === "fsSummaryValue")?.text ?? "";
    const banner = createBanner(
      event.cumulativeWinMinor === "0"
        ? FREE_SPIN_NO_WIN_COPY
        : `FREE SPINS COMPLETE // ${summaryValue}`,
      COLORS.amber,
      620,
    );
    banner.position.set(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2 + 188);
    banner.alpha = authoredSummary ? 0 : 1;
    scene.addChild(dim);
    if (authoredSummary) scene.addChild(authoredSummary);
    scene.addChild(banner);
    this.view.addChild(scene);
    const visualOperation = authoredSummary
      ? this.visualTelemetry?.start(descriptor) ?? null
      : null;

    const summaryReelAlphaLayer = this.reelAlphaLayers.acquire();
    const originalReelAlpha = summaryReelAlphaLayer.baseAlpha;
    const timelineScale = reducedMotion
      ? featureEffectDuration("summary", true) / FREE_SPIN_SUMMARY_TIMELINE_MS.total
      : 1;
    const showMs = FREE_SPIN_SUMMARY_TIMELINE_MS.show * timelineScale;
    const holdMs = FREE_SPIN_SUMMARY_TIMELINE_MS.continueHold * timelineScale;
    const hideMs = FREE_SPIN_SUMMARY_TIMELINE_MS.hide * timelineScale;
    let summaryInteraction: ActiveFreeSpinSummaryContinue | null = null;
    let visualFailed = false;
    let visualOutcome: "natural" | "continued" | "timeout" | "cancelled" = "cancelled";
    if (authoredSummary) {
      authoredSummary.alpha = 1;
      playAuthoredPanelTrack(authoredSummary, "show", 0, false, reducedMotion);
      playAuthoredPanelTrack(authoredSummary, "Fire_loop", 1, true, reducedMotion);
      playAuthoredPanelTrack(authoredSummary, "Fire_loop_2", 2, true, reducedMotion);
      playAuthoredPanelTrack(authoredSummary, "fire_glow_Loop", 3, true, reducedMotion);
    }
    try {
      await this.animate(showMs, (progress) => {
        const presence = smooth(phase(progress, 0, reducedMotion ? 0.5 : 0.35));
        dim.alpha = presence * (reducedMotion ? 0.1 : 0.48);
        summaryReelAlphaLayer.setAlpha(mix(originalReelAlpha, 0.2, presence));
        if (!authoredSummary) {
          banner.alpha = presence;
          banner.scale.set(0.88 + outCubic(progress) * 0.12);
        }
        authoredSummary?.syncTextFields();
      });
      if (this.destroyed) return;

      const interaction: ActiveFreeSpinSummaryContinue = {
        state: "waiting",
        closeNotified: false,
        inputCheckpointPending: true,
        finish: () => undefined,
      };
      summaryInteraction = interaction;
      await this.animate(
        holdMs,
        () => {
          dim.alpha = reducedMotion ? 0.1 : 0.48;
          summaryReelAlphaLayer.setAlpha(0.2);
          authoredSummary?.syncTextFields();
        },
        (finish) => {
          interaction.finish = finish;
          this.activeFreeSpinSummaryContinue = interaction;
          this.hooks.onFreeSpinSummaryReady?.();
          const checkpoint = this.requestFreeSpinSummaryInputReadyCheckpoint();
          if (!checkpoint) {
            interaction.inputCheckpointPending = false;
            return;
          }
          return checkpoint.finally(() => {
            interaction.inputCheckpointPending = false;
          });
        },
      );
      const currentState = (): ActiveFreeSpinSummaryContinue["state"] => interaction.state;
      if (currentState() === "waiting") interaction.state = "expired";
      if (this.activeFreeSpinSummaryContinue === interaction) {
        this.activeFreeSpinSummaryContinue = null;
      }
      const closeState = currentState();
      visualOutcome = closeState === "continued"
        ? "continued"
        : closeState === "cancelled" ? "cancelled" : "timeout";
      this.notifyFreeSpinSummaryClose(
        interaction,
        closeState === "continued"
          ? "continue"
          : closeState === "cancelled" ? "cancelled" : "timeout",
      );
      if (this.destroyed || closeState === "cancelled") return;

      // FREESPIN_END、HUD 隐藏和 KQ 卷轴重置均从该帧开始。 / English: FREESPIN_END, HUD hiding and KQ reel reset all start from this frame.
      this.hooks.onFreeSpinSummaryHideStart?.();
      if (authoredSummary) playAuthoredPanelTrack(authoredSummary, "hide", 0, false, reducedMotion);
      await this.animate(hideMs, (progress) => {
        const presence = 1 - smooth(progress);
        dim.alpha = presence * (reducedMotion ? 0.1 : 0.48);
        summaryReelAlphaLayer.setAlpha(mix(originalReelAlpha, 0.2, presence));
        if (!authoredSummary) banner.alpha = presence;
        authoredSummary?.syncTextFields();
      });
    } catch (error) {
      if (isFeaturePresentationCancelled(error)) throw error;
      visualFailed = true;
      this.failVisual(visualOperation, {
        stage: "animation",
        code: "playback-failed",
        fallback: "text",
      });
      throw error;
    } finally {
      if (summaryInteraction && this.activeFreeSpinSummaryContinue === summaryInteraction) {
        if (summaryInteraction.state === "waiting") {
          summaryInteraction.state = "cancelled";
          summaryInteraction.finish();
        }
        this.activeFreeSpinSummaryContinue = null;
        this.notifyFreeSpinSummaryClose(summaryInteraction, "cancelled");
      }
      authoredSummary?.spine.state.clearTrack(1);
      authoredSummary?.spine.state.clearTrack(2);
      authoredSummary?.spine.state.clearTrack(3);
      summaryReelAlphaLayer.release();
      this.release(scene);
      if (!visualFailed) this.completeVisual(visualOperation, reducedMotion, visualOutcome);
    }
  }

  private async presentVaultUpgradeMember(
    event: VaultUpgradedEvent,
    reducedMotion: boolean,
    visualOperation: VisualTelemetryOperation | null,
  ): Promise<void> {
    if (!this.reels.applyVaultUpgrade(event)) {
      this.failVisual(visualOperation, {
        stage: "animation",
        code: "missing-animation",
        fallback: "bitmap",
      });
    }
    if (this.pendingVaultUpgradeMembers <= 0) {
      const { durationMs } = vaultMutationBatchPlan([event], reducedMotion);
      if (durationMs > 0) await this.animate(durationMs, () => undefined);
      return;
    }

    this.pendingVaultUpgradeMembers -= 1;
    // AppController 连续供应步骤成员。较早的成员会立即返回，因此所有升级剪辑都会在同一帧中开始；最后一个拥有单个共享等待，而不是每个 Vault 序列化 833ms。 / English: AppController continuously supplies step members. Older members are returned immediately so all promotion clips start in the same frame; the last one has a single shared wait instead of 833ms per Vault serialization.
    if (this.pendingVaultUpgradeMembers > 0) return;
    const { durationMs } = vaultMutationBatchPlan([event], reducedMotion);
    if (durationMs > 0) await this.animate(durationMs, () => undefined);
  }

  private async presentWheel(
    event: WheelAwardedEvent,
    reducedMotion: boolean,
    token: FeaturePresentationToken,
  ): Promise<void> {
    // 在任何接管变得可见之前解决。未知/缺失的结果是协议错误，绝不是化妆品哈希回退路径的候选者。 / English: Resolve before any takeover becomes visible. Unknown/missing results are protocol errors and are never candidates for cosmetic hash fallback paths.
    const wheelPlan = wheelSpineAnimationPlan(event);
    if (!this.wheelArtwork?.spines.wheel) {
      try {
        await this.ensureWheelArtwork(token);
      } catch (error) {
        if (isFeaturePresentationCancelled(error)) throw error;
        this.visualTelemetry?.failedToStart(
          this.visualDescriptor("wheel.popup", event.type),
          { stage: "load", code: "asset-load-failed", fallback: "none" },
        );
        throw error;
      }
    }
    this.assertPresentationCurrent(token);
    const scene = new Container();
    const authoredWheelData = this.wheelArtwork?.spines.wheel;
    let authoredPlayback = authoredWheelData
      ? createAuthoredWheelPlayback(
        authoredWheelData,
        wheelPlan,
        reducedMotion,
        this.responsiveLayoutTrack,
      )
      : null;
    const popup = createAuthoredPanel(
      this.wheelArtwork?.spines.wheelPopupStart,
      PRIMAL_WHEEL_POPUP_LAYOUT,
      [],
      this.responsiveLayoutTrackSource,
    );
    if (popup) {
      popup.alpha = 1;
      playAuthoredPanelTrack(popup, "show", 0, false, reducedMotion);
    }
    const normalizedOutcome = normalizedWheelOutcome(event.outcome);
    const normalizedPrize = event.prize ? normalizedWheelOutcome(event.prize) : "";
    const freeSpinSummary = normalizedOutcome === "EXPANSION"
      || normalizedOutcome === "KONG_QUEST"
      || normalizedOutcome === "OVERDRIVE"
      || normalizedOutcome === "KING_SPIN"
      || normalizedPrize === "KONG_QUEST"
      || normalizedPrize === "KING_SPIN";
    const summaryData = freeSpinSummary
      ? this.wheelArtwork?.spines.wheelSummaryFreespins
      : this.wheelArtwork?.spines.wheelSummaryJackpot;
    const summary = createAuthoredPanel(
      summaryData,
      PRIMAL_PANEL_LAYOUT.wheelSummary,
      wheelSummaryTextFields(event, freeSpinSummary, this.moneyFormatter),
      this.responsiveLayoutTrackSource,
    );
    if (!authoredPlayback || !popup || !summary) {
      authoredPlayback?.view.destroy({ children: true });
      popup?.destroy({ children: true });
      summary?.destroy({ children: true });
      this.visualTelemetry?.failedToStart(
        this.visualDescriptor("wheel.popup", event.type),
        { stage: "create", code: "empty-presentation", fallback: "none" },
      );
      throw new Error("Required authored Primal Wheel assets are unavailable");
    }
    this.activeWheelScene = scene;
    this.applyWheelOverlayLayout(scene);
    let summaryPhase: 0 | 1 | 2 | 3 = 0;
    const aura = new Graphics();
    aura.position.set(AUTHORED_WHEEL_LAYOUT.x, AUTHORED_WHEEL_LAYOUT.y);
    aura.beginFill(0x7d1714, 0.13).drawCircle(0, 0, 264).endFill();
    aura.lineStyle(11, 0xe63f24, 0.22).drawCircle(0, 0, 226);
    aura.lineStyle(3, 0xffad52, 0.4).drawCircle(0, 0, 206);
    aura.visible = false;

    const wheelTexture = normalizedOutcome === "OVERDRIVE" || normalizedOutcome === "KING_SPIN"
      ? this.wheelArtwork!.textures.dual
      : normalizedOutcome === "EXPANSION" || normalizedOutcome === "KONG_QUEST"
        ? this.wheelArtwork!.textures.red
        : this.wheelArtwork!.textures.blue;
    const wheel = new Sprite(wheelTexture);
    wheel.anchor.set(0.5);
    wheel.position.set(AUTHORED_WHEEL_LAYOUT.x, AUTHORED_WHEEL_LAYOUT.y);
    wheel.width = AUTHORED_WHEEL_LAYOUT.diameter;
    wheel.height = AUTHORED_WHEEL_LAYOUT.diameter;
    const wheelBaseScale = wheel.scale.x;
    wheel.visible = false;

    const pointer = new Graphics();
    pointer.beginFill(0xffe099, 1).lineStyle(3, 0x21130d, 0.9);
    pointer.drawPolygon([-19, -246, 19, -246, 0, -198]).endFill();
    pointer.position.set(AUTHORED_WHEEL_LAYOUT.x, AUTHORED_WHEEL_LAYOUT.y);
    pointer.visible = false;

    const resultReadout = new Container();
    resultReadout.position.set(AUTHORED_WHEEL_LAYOUT.x, AUTHORED_WHEEL_LAYOUT.y);
    const resultPlate = new Graphics();
    resultPlate.beginFill(0x090b0c, 0.96).lineStyle(4, 0xffb44d, 0.9)
      .drawRoundedRect(-82, -39, 164, 78, 16).endFill();
    resultPlate.lineStyle(1, 0xffefbf, 0.46).drawRoundedRect(-72, -29, 144, 58, 12);
    const resultLabel = event.multiplier === undefined
      ? event.outcome
      : `×${event.multiplier}`;
    const resultText = new Text(resultLabel, new TextStyle({
      fill: 0xffe0a1,
      fontFamily: "Arial Black, Impact, sans-serif",
      fontSize: resultLabel.length > 7 ? 17 : 26,
      fontWeight: "900",
      letterSpacing: 1,
      stroke: 0x090b0c,
      strokeThickness: 4,
    }));
    resultText.anchor.set(0.5);
    resultReadout.addChild(resultPlate, resultText);
    resultReadout.alpha = 0;

    const banner = createBanner(featureEffectLabel(event, this.moneyFormatter), 0xff8b34, 600);
    banner.position.set(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2 + 220);

    // 源按钮是制作成近似正圆的 600x600 多边形。视觉按钮继续与普通 Spin 控件共用， / English: The source button is made as a 600x600 polygon that approximates a perfect circle. Visual buttons continue to be shared with normal Spin controls,
    // 但为指针用户保留这个直接点击轮盘的区域。 / English: But this area of ​​the direct click wheel is reserved for pointer users.
    const wheelHitTarget = new Graphics();
    wheelHitTarget.beginFill(0xffffff, 0.001)
      .drawCircle(0, 0, PRIMAL_WHEEL_CONTROL_LAYOUT.hitDiameter / 2)
      .endFill();
    wheelHitTarget.position.set(PRIMAL_WHEEL_CONTROL_LAYOUT.x, PRIMAL_WHEEL_CONTROL_LAYOUT.y);
    wheelHitTarget.hitArea = new Circle(0, 0, PRIMAL_WHEEL_CONTROL_LAYOUT.hitDiameter / 2);
    wheelHitTarget.interactive = true;
    wheelHitTarget.buttonMode = true;
    wheelHitTarget.visible = false;
    wheelHitTarget.on("pointertap", () => {
      this.requestWheelInteraction();
    });

    // 原始介绍合成：下面是光环/轮子，上面是标题闪电。弹出窗口逐渐消失，而同一个驻留轮继续进入“就绪”状态。 / English: Original intro composition: halo/wheel below, title lightning above. The pop-up window fades away while the same dwell wheel continues into the "ready" state.
    scene.addChild(aura);
    if (authoredPlayback) scene.addChild(authoredPlayback.view);
    scene.addChild(wheel, pointer, resultReadout, banner, wheelHitTarget);
    if (popup) scene.addChild(popup);
    if (summary) scene.addChild(summary);
    this.view.addChild(scene);
    let popupVisual = this.visualTelemetry?.start(
      this.visualDescriptor("wheel.popup", event.type),
    ) ?? null;
    let readyVisual: VisualTelemetryOperation | null = null;
    let spinVisual: VisualTelemetryOperation | null = null;
    let landingVisual: VisualTelemetryOperation | null = null;
    let summaryVisual: VisualTelemetryOperation | null = null;
    let outroVisual: VisualTelemetryOperation | null = null;

    const wheelReelAlphaLayer = this.reelAlphaLayers.acquire();
    const originalReelAlpha = wheelReelAlphaLayer.baseAlpha;
    let characterSpinStarted = false;
    let characterSpinFinished = false;
    let interactionReady = false;
    let bonusLabelPresented = false;
    let popupClosed = false;
    let popupInteraction: ActiveWheelPopupContinue | null = null;
    let summaryInteraction: ActiveWheelSummaryContinue | null = null;
    let readyAnimation: ActiveAnimation | null = null;
    let idleElapsedMs = 0;
    let spinMotionPlan: PrimalWheelSpinPlan | null = null;
    let spinTimeline: PrimalWheelRuntimeTimeline | null = null;
    let outroOwnsScene = false;
    let sceneCleaned = false;
    const timelineScale = reducedMotion
      ? featureEffectDuration("wheel", true) / PRIMAL_WHEEL_BOUNDED_PRESENTATION_MS
      : 1;
    const safeTimelineScale = Math.max(0.000_001, timelineScale);
    let continueResolved = false;
    let continuePresentation!: () => void;
    const continuePromise = new Promise<void>((resolve) => {
      continuePresentation = resolve;
    });
    const interaction: ActiveWheelInteraction = {
      state: "waiting",
      quickStopRequested: false,
      quickStopEligible: false,
      spinRequestedAtMs: null,
      resolveContinue: () => {
        if (continueResolved) return;
        continueResolved = true;
        continuePresentation();
      },
    };

    const cleanupScene = (): void => {
      if (sceneCleaned) return;
      sceneCleaned = true;
      if (this.activeWheelScene === scene) {
        this.activeWheelScene = null;
      }
      this.managedWheelSceneCleanups.delete(cleanupScene);
      wheelHitTarget.visible = false;
      try {
        resetAuthoredWheel(authoredPlayback);
      } catch {
        // 应用程序拆卸可能已经递归地销毁了预设的曲目。 / English: Application teardown may have recursively destroyed preset tracks.
      }
      wheelReelAlphaLayer.release();
      this.release(scene);
    };
    this.managedWheelSceneCleanups.add(cleanupScene);

    const renderFrame = (
      spinElapsedMs: number,
      featureElapsedMs: number,
      channels: WheelRenderChannels = ALL_WHEEL_RENDER_CHANNELS,
    ): void => {
      const activeTimeline: PrimalWheelRuntimeTimeline = spinTimeline
        ?? PRIMAL_WHEEL_TIMELINE_MS;
      const spinFrame = spinMotionPlan
        ? primalWheelSpinFrame(spinMotionPlan, spinElapsedMs)
        : null;
      const idleFrame = spinFrame
        ? null
        : primalWheelIdleState(featureElapsedMs);

      if (spinFrame && interaction.state === "spinning") {
        interaction.quickStopEligible = spinFrame.stage === "stopping";
      }
      if (spinFrame && !characterSpinFinished && spinFrame.stage === "landed") {
        characterSpinFinished = true;
        interaction.quickStopEligible = false;
        interaction.state = "finished";
        wheelHitTarget.visible = false;
        if (this.activeWheelInteraction === interaction) this.activeWheelInteraction = null;
        this.hooks.onWheelSpinFinish?.();
      }
      const rotationDegrees = spinFrame?.rotationDegrees ?? idleFrame?.rotationDegrees ?? 0;
      const fallbackWheelPresence = smooth(phase(featureElapsedMs, 0, 180))
        * (spinFrame
          ? 1 - smooth(phase(
            spinElapsedMs,
            activeTimeline.summaryHideAt,
            activeTimeline.summaryHideAt + activeTimeline.wheelHide,
          ))
          : 1);
      if (channels.wheel && popup) {
        popup.alpha = popupClosed
          ? 0
          : 1 - smooth(phase(
            featureElapsedMs,
            PRIMAL_WHEEL_POPUP_TIMELINE_MS.show - 180,
            PRIMAL_WHEEL_POPUP_TIMELINE_MS.show,
          ));
      }
      if (channels.summary && spinFrame && summary && summaryPhase < 1
        && spinElapsedMs >= activeTimeline.summaryShowAt) {
        summary.alpha = 1;
        playAuthoredPanelTrack(summary, "show", 0, false, reducedMotion);
        summaryPhase = 1;
      }
      if (channels.summary && spinFrame && summary && summaryPhase < 2
        && spinElapsedMs >= activeTimeline.summaryStopAt) {
        playAuthoredPanelTrack(summary, "stop", 0, true, reducedMotion);
        summaryPhase = 2;
      }
      if (channels.summary && spinFrame && summary && summaryPhase < 3
        && spinElapsedMs >= activeTimeline.summaryHideAt) {
        playAuthoredPanelTrack(summary, "hide", 0, false, reducedMotion);
        if (summary.spine.state.hasAnimation("hidden")) {
          summary.spine.state.addAnimation(0, "hidden", false, 0);
        }
        summaryPhase = 3;
      }
      if (channels.wheel && spinFrame && !bonusLabelPresented
        && shouldHandoffWheelBonusLabel(
          event,
          freeSpinSummary,
          spinElapsedMs,
          activeTimeline,
        )) {
        bonusLabelPresented = true;
        this.hooks.onWheelBonusLabelReady?.(event, reducedMotion);
      }
      if (channels.wheel && authoredPlayback && spinFrame && spinTimeline) {
        try {
          advanceAuthoredWheel(
            authoredPlayback,
            spinFrame,
            spinElapsedMs,
            spinTimeline,
            this.responsiveLayoutTrack,
          );
        } catch {
          const failedPlayback = authoredPlayback;
          try {
            resetAuthoredWheel(failedPlayback);
          } catch {
            failedPlayback.view.visible = false;
          }
          throw new Error("Authored Primal Wheel playback failed");
        }
      } else if (channels.wheel && idleFrame) {
        applyAuthoredWheelIdleFrame(
          authoredPlayback,
          idleFrame,
          this.responsiveLayoutTrack,
        );
      }
      if (channels.wheel) {
        wheel.rotation = rotationDegrees * Math.PI / 180;
        wheel.scale.set(wheelBaseScale * (
          0.58 + outCubic(phase(
            featureElapsedMs,
            0,
            PRIMAL_WHEEL_POPUP_TIMELINE_MS.show,
          )) * 0.42
        ));
        wheel.alpha = fallbackWheelPresence;
        pointer.alpha = wheel.alpha;
        aura.alpha = fallbackWheelPresence * (
          0.68 + Math.sin(featureElapsedMs / PRIMAL_WHEEL_BOUNDED_PRESENTATION_MS * Math.PI * 8)
            * 0.08
        );
        aura.scale.set(0.82 + outCubic(phase(
          featureElapsedMs,
          0,
          PRIMAL_WHEEL_POPUP_TIMELINE_MS.show,
        )) * 0.22);
      }

      // 捕获的 toggleReelsVisibility 在功能简介和摘要结尾处运行独立的一秒淡入淡出。 / English: The captured toggleReelsVisibility runs independent one-second fades at the end of the feature intro and summary.
      const reelVisibility = spinFrame && spinElapsedMs >= activeTimeline.summaryHideAt
        ? smooth(phase(
          spinElapsedMs,
          activeTimeline.summaryHideAt,
          activeTimeline.summaryHideAt + activeTimeline.reelFade,
        ))
        : 1 - smooth(phase(
          featureElapsedMs,
          0,
          PRIMAL_WHEEL_POPUP_TIMELINE_MS.reelFade,
        ));
      if (channels.reels) wheelReelAlphaLayer.setAlpha(originalReelAlpha * reelVisibility);

      const fallbackResultPresence = authoredPlayback || !spinFrame
        ? 0
        : smooth(phase(
          spinElapsedMs,
          activeTimeline.landing,
          activeTimeline.landing + 180,
        )) * (1 - phase(
          spinElapsedMs,
          activeTimeline.summaryHideAt,
          activeTimeline.summaryHideAt + activeTimeline.wheelHide,
        ));
      if (channels.wheel) {
        resultReadout.alpha = fallbackResultPresence;
        resultReadout.scale.set(0.72 + outCubic(phase(
          spinElapsedMs,
          activeTimeline.landing,
          activeTimeline.landing + 420,
        )) * 0.28);
        banner.alpha = fallbackResultPresence;
        banner.y = mix(
          LOGICAL_HEIGHT / 2 + 248,
          LOGICAL_HEIGHT / 2 + 220,
          outCubic(phase(
            spinElapsedMs,
            activeTimeline.landing,
            activeTimeline.summaryShowAt,
          )),
        );
        popup?.syncTextFields();
      }
      if (channels.summary) summary?.syncTextFields();
    };

    try {
      // 第一个 CONTINUE 与弹出窗口 `show` 处于同一帧中。它可能会缩短这种有界等待，但它只揭示了轮子就绪的门；选择仍然需要第二个手势。 / English: The first CONTINUE is in the same frame as the popup `show`. It might shorten this bounded wait, but it only reveals the wheel-ready door; selection still requires a second gesture.
      const popupContinue: ActiveWheelPopupContinue = {
        state: "waiting",
        closeNotified: false,
        finish: () => undefined,
      };
      popupInteraction = popupContinue;
      const popupStartedAt = performance.now();
      const popupCheckpointAt = Math.min(
        1_000,
        PRIMAL_WHEEL_POPUP_TIMELINE_MS.show,
      );
      await this.animate(
        popupCheckpointAt * timelineScale,
        (progress) => {
          idleElapsedMs = progress * popupCheckpointAt;
          renderFrame(0, idleElapsedMs);
        },
        (finish) => {
          popupContinue.finish = finish;
          this.activeWheelPopupContinue = popupContinue;
          // `animate` 在第一个 RAF 之前调用其输入门。显式为预设的框架设定种子，以便诊断保留无法暴露构造函数默认值（包括回退路径结果横幅）。 / English: `animate` calls its input gate before the first RAF. Explicitly seed the prefabricated framework so that diagnostic preserves cannot expose constructor defaults (including fallback path result banners).
          renderFrame(0, idleElapsedMs);
          this.hooks.onWheelPopupReady?.();
        },
      );
      const popupCheckpoint = popupContinue.state === "waiting"
        ? this.requestWheelCheckpoint(this.hooks.onWheelPopupInputReadyCheckpoint)
        : undefined;
      const popupCheckpointHeld = popupCheckpoint
        ? await this.awaitPresentation(popupCheckpoint, token)
        : false;
      this.assertPresentationCurrent(token);
      if (popupContinue.state === "waiting"
        && popupCheckpointAt < PRIMAL_WHEEL_POPUP_TIMELINE_MS.show) {
        const remainingPopupMs = PRIMAL_WHEEL_POPUP_TIMELINE_MS.show - popupCheckpointAt;
        // 传统/手动时钟可能会跨越解析语义示例的 RAF 中的整个弹出窗口。没有真正的障碍，在同一回合中追上，而不需要第二个合成框架。固定承诺故意冻结剩余的撰写动议。 / English: Traditional/manual clocks may span the entire popup in the RAF of the parsing semantics example. There's no real obstacle to catching up in the same turn without the need for a second synthetic frame. Fixed commitments intentionally freeze remaining writing motions.
        const elapsedSincePopupStart = Math.max(
          0,
          (performance.now() - popupStartedAt) / safeTimelineScale,
        );
        if (!popupCheckpointHeld
          && elapsedSincePopupStart >= PRIMAL_WHEEL_POPUP_TIMELINE_MS.show) {
          idleElapsedMs = PRIMAL_WHEEL_POPUP_TIMELINE_MS.show;
          renderFrame(0, idleElapsedMs);
        } else {
          await this.animate(
            remainingPopupMs * timelineScale,
            (progress) => {
              idleElapsedMs = popupCheckpointAt + progress * remainingPopupMs;
              renderFrame(0, idleElapsedMs);
            },
            (finish) => {
              popupContinue.finish = finish;
            },
          );
        }
      }
      if (popupContinue.state === "continued") {
        idleElapsedMs = Math.min(
          PRIMAL_WHEEL_POPUP_TIMELINE_MS.show,
          Math.max(
            idleElapsedMs,
            (performance.now() - popupStartedAt) / safeTimelineScale,
          ),
        );
      }
      if (popupContinue.state === "waiting") popupContinue.state = "expired";
      if (this.activeWheelPopupContinue === popupContinue) {
        this.activeWheelPopupContinue = null;
      }
      this.notifyWheelPopupClose(
        popupContinue,
        popupContinue.state === "continued"
          ? "continue"
          : popupContinue.state === "cancelled" ? "cancelled" : "timeout",
      );
      this.completeVisual(
        popupVisual,
        reducedMotion,
        popupContinue.state === "continued"
          ? "continued"
          : popupContinue.state === "cancelled" ? "cancelled" : "timeout",
      );
      popupVisual = null;
      if (this.destroyed || popupContinue.state === "cancelled") return;

      // 解码后的弹出窗口没有隐藏剪辑。早期的Continue直接去掉。 / English: The decoded popup has no hidden clips. The early Continue is removed directly.
      popupClosed = true;
      if (popup) popup.alpha = 0;
      setAuthoredWheelWaiting(authoredPlayback);
      readyVisual = this.visualTelemetry?.start(
        this.visualDescriptor("wheel.ready", event.type),
      ) ?? null;
      wheelHitTarget.visible = true;
      this.activeWheelInteraction = interaction;
      interactionReady = true;

      // 就绪门没有超时。它的旋转器不断前进，并且启动采样了这个实时 p0/v0，而不是有上限的弹出时间戳。 / English: The ready gate has no timeout. Its spinner keeps advancing and starts sampling this real-time p0/v0 instead of the capped pop timestamp.
      const readyBaseElapsedMs = idleElapsedMs;
      const readyStartedAt = performance.now();
      let readySettled = false;
      let readyFailure: unknown;
      const ready: ActiveAnimation = {
        handle: null,
        finish: () => settleReady(),
        cancel: () => settleReady(),
      };
      const settleReady = (): void => {
        if (readySettled) return;
        readySettled = true;
        if (ready.handle !== null) cancelAnimationFrame(ready.handle);
        ready.handle = null;
        this.animations.delete(ready);
      };
      const tickReady = (): void => {
        if (this.destroyed || continueResolved || interaction.state !== "waiting") {
          settleReady();
          return;
        }
        idleElapsedMs = readyBaseElapsedMs
          + Math.max(0, performance.now() - readyStartedAt) / safeTimelineScale;
        try {
          renderFrame(0, idleElapsedMs);
        } catch (error) {
          readyFailure = error;
          interaction.state = "cancelled";
          settleReady();
          interaction.resolveContinue();
          return;
        }
        ready.handle = requestAnimationFrame(tickReady);
      };
      readyAnimation = ready;
      this.animations.add(ready);
      renderFrame(0, idleElapsedMs);
      ready.handle = requestAnimationFrame(tickReady);
      this.hooks.onWheelReady?.();
      const inputReadyCheckpoint = this.requestWheelCheckpoint(
        this.hooks.onWheelInputReadyCheckpoint,
      );
      if (inputReadyCheckpoint) {
        await this.awaitPresentation(inputReadyCheckpoint, token);
      }
      this.assertPresentationCurrent(token);

      // 精确的 GamePrimalWheelBonusFeature 门：无超时且无自动选择。这里需要真正的第二个用户手势。 / English: Precise GamePrimalWheelBonusFeature gate: no timeouts and no auto-selection. A real second user gesture is needed here.
      await this.awaitPresentation(continuePromise, token);
      this.assertPresentationCurrent(token);
      idleElapsedMs = readyBaseElapsedMs
        + Math.max(
          0,
          (interaction.spinRequestedAtMs ?? performance.now()) - readyStartedAt,
        ) / safeTimelineScale;
      ready.finish();
      readyAnimation = null;
      if (readyFailure !== undefined) {
        this.failVisual(readyVisual, {
          stage: "animation",
          code: "playback-failed",
          fallback: "none",
        });
        readyVisual = null;
        throw readyFailure;
      }
      this.completeVisual(readyVisual, reducedMotion, this.destroyed ? "cancelled" : "continued");
      readyVisual = null;
      if (this.destroyed) return;

      // onWheelSpinStart 已经将角色移至胸重状态。在采样/计划验证之前标记所有权，以便任一故障路径都恢复持久字符，而不是让该循环处于锁定状态。 / English: onWheelSpinStart has moved the character to chest weight state. Mark ownership before sampling/scheduling verification so that either failed path recovers persistent characters rather than leaving the loop in a locked state.
      characterSpinStarted = true;
      // 仅当第二个就绪手势被接受时，通用微调器才对其函数值停止偏移进行采样。因此，弹出/就绪等待和中止不会消耗装饰 RNG。 / English: The universal spinner samples its function value stop offset only when the second ready gesture is accepted. Therefore, pop/ready waits and aborts do not consume decoration RNG.
      const stopOffsetSectors = sampleWheelStopOffset(
        this.wheelStopOffsetSource,
        reducedMotion,
      );
      const activeSpinPlan = createPrimalWheelSpinPlan({
        segment: wheelPlan.segment,
        launchState: primalWheelIdleState(idleElapsedMs),
        stopOffsetSectors,
        speed: this.wheelSpeed,
      });
      const activeSpinTimeline = primalWheelRuntimeTimeline(activeSpinPlan);
      spinMotionPlan = activeSpinPlan;
      spinTimeline = activeSpinTimeline;
      spinVisual = this.visualTelemetry?.start(
        this.visualDescriptor("wheel.spin", event.type),
      ) ?? null;
      renderFrame(0, idleElapsedMs);

      // 选择、停止保留和结果保持使用独立的S时钟。 A 层门在与摘要 `show` 相同的框架上打开。 / English: Select, stop hold and result hold use independent S clocks. The A-level door opens on the same frame as the summary `show`.
      const landedThroughMs = await this.animateWheelContinuation(
        interaction,
        timelineScale,
        activeSpinPlan,
        (motionElapsedMs, wallSpinElapsedMs) => {
          renderFrame(motionElapsedMs, idleElapsedMs + wallSpinElapsedMs);
        },
        activeSpinTimeline.landing,
      );
      this.completeVisual(spinVisual, reducedMotion);
      spinVisual = null;
      if (this.destroyed) return;

      // 权威部分是在精彩部分保持和摘要开始之前提交的。生产中不存在可选的观察者屏障。 / English: The authoritative section is submitted before the highlight section holds and the summary begins. Optional observer barriers do not exist in production.
      landingVisual = this.visualTelemetry?.start(
        this.visualDescriptor("wheel.landing", event.type),
      ) ?? null;
      const landingCheckpoint = this.requestWheelCheckpoint(
        this.hooks.onWheelLandingCheckpoint,
      );
      const landingCheckpointHeld = landingCheckpoint
        ? await this.awaitPresentation(landingCheckpoint, token)
        : false;
      this.assertPresentationCurrent(token);
      this.completeVisual(landingVisual, reducedMotion);
      landingVisual = null;
      if (this.destroyed) return;

      const landingToSummaryMs = activeSpinTimeline.summaryShowAt
        - activeSpinTimeline.landing;
      summaryVisual = this.visualTelemetry?.start(
        this.visualDescriptor("wheel.summary", event.type),
      ) ?? null;
      // 如果 RAF 在一帧中穿过平台和汇总边界，则在未安装测试场景屏障时保留逻辑超调。真正的检查站承诺故意从精确的着陆姿​​势恢复。 / English: If one RAF crosses the landing and summary boundaries, preserve logical overshoot when no test-scene barrier is installed. A real checkpoint promise deliberately resumes from the exact landing pose.
      const postLandingElapsedMs = landingCheckpointHeld
        ? 0
        : Math.min(
          landingToSummaryMs,
          Math.max(0, landedThroughMs - activeSpinTimeline.landing),
        );
      if (postLandingElapsedMs >= landingToSummaryMs) {
        renderFrame(
          activeSpinTimeline.summaryShowAt,
          idleElapsedMs + activeSpinTimeline.summaryShowAt,
        );
      } else {
        await this.animate(
          (landingToSummaryMs - postLandingElapsedMs) * timelineScale,
          (progress) => {
            const spinElapsedMs = activeSpinTimeline.landing
              + postLandingElapsedMs
              + progress * (landingToSummaryMs - postLandingElapsedMs);
            renderFrame(spinElapsedMs, idleElapsedMs + spinElapsedMs);
          },
          undefined,
          performance.now(),
        );
      }
      if (this.destroyed) return;

      const summaryContinue: ActiveWheelSummaryContinue = {
        state: "waiting",
        closeNotified: false,
        finish: () => undefined,
      };
      summaryInteraction = summaryContinue;
      await this.animate(
        (activeSpinTimeline.summaryHideAt
          - activeSpinTimeline.summaryShowAt) * timelineScale,
        (progress) => {
          const spinElapsedMs = activeSpinTimeline.summaryShowAt
            + progress * (activeSpinTimeline.summaryHideAt
              - activeSpinTimeline.summaryShowAt);
          renderFrame(
            spinElapsedMs,
            idleElapsedMs + spinElapsedMs,
          );
        },
        (finish) => {
          summaryContinue.finish = finish;
          this.activeWheelSummaryContinue = summaryContinue;
          this.hooks.onWheelSummaryReady?.();
        },
      );
      if (summaryContinue.state === "waiting") summaryContinue.state = "expired";
      if (this.activeWheelSummaryContinue === summaryContinue) {
        this.activeWheelSummaryContinue = null;
      }
      this.notifyWheelSummaryClose(
        summaryContinue,
        summaryContinue.state === "continued"
          ? "continue"
          : summaryContinue.state === "cancelled" ? "cancelled" : "timeout",
      );
      this.completeVisual(
        summaryVisual,
        reducedMotion,
        summaryContinue.state === "continued"
          ? "continued"
          : summaryContinue.state === "cancelled" ? "cancelled" : "timeout",
      );
      summaryVisual = null;
      if (this.destroyed || summaryContinue.state === "cancelled") return;

      // 玩家关闭面板时只会跳到制作好的隐藏边界。Wheel 隐藏（500ms）、A 层隐藏（666.7ms） / English: When the player closes the panel, they will only jump to the hidden boundary. Wheel hidden (500ms), A layer hidden (666.7ms)
      // 和一秒转轴淡入淡出保持不变；B 层在此收尾阶段完成交接。 / English: and one-second reel fades remain unchanged; Layer B completes the handoff during this finishing phase.
      renderFrame(
        activeSpinTimeline.summaryHideAt,
        idleElapsedMs + activeSpinTimeline.summaryHideAt,
      );
      const outro = primalWheelOutroTaskPlan(activeSpinTimeline);
      const taskFinishes: Array<() => void> = [];
      const startOutroTask = (
        durationMs: number,
        channels: WheelRenderChannels,
      ): Promise<void> => this.animate(
        durationMs * timelineScale,
        (progress) => {
          const spinElapsedMs = activeSpinTimeline.summaryHideAt + progress * durationMs;
          renderFrame(spinElapsedMs, idleElapsedMs + spinElapsedMs, channels);
        },
        (finish) => taskFinishes.push(finish),
      );

      // 隐藏开始是真正的并行分发点。Wheel 任务本身就是流程栅栏； / English: Hidden start is the true parallel distribution point. The Wheel task itself is a process fence;
      // 总结和转轴任务返回后仍需保留场景所有权。 / English: Retain scene ownership even after the summary and reel tasks return.
      outroOwnsScene = true;
      outroVisual = this.visualTelemetry?.start(
        this.visualDescriptor("wheel.outro", event.type),
      ) ?? null;
      const wheelTask = startOutroTask(outro.wheelMs, {
        wheel: true,
        summary: false,
        reels: false,
      });
      const summaryTask = startOutroTask(outro.summaryMs, {
        wheel: false,
        summary: true,
        reels: false,
      });
      const reelsTask = startOutroTask(outro.reelsMs, {
        wheel: false,
        summary: false,
        reels: true,
      });
      void Promise.allSettled([wheelTask, summaryTask, reelsTask]).then((results) => {
        cleanupScene();
        const rejected = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        const failed = rejected.some(
          (result) => !isFeaturePresentationCancelled(result.reason),
        );
        if (failed) {
          this.failVisual(outroVisual, {
            stage: "animation",
            code: "playback-failed",
            fallback: "none",
          });
        } else if (rejected.length > 0) {
          this.completeVisual(outroVisual, reducedMotion, "cancelled");
        } else {
          this.completeVisual(outroVisual, reducedMotion);
        }
        outroVisual = null;
      });
      try {
        await wheelTask;
      } catch (error) {
        for (const finish of taskFinishes) finish();
        cleanupScene();
        throw error;
      }
    } catch (error) {
      if (isFeaturePresentationCancelled(error)) throw error;
      const failure: VisualTelemetryFailure = {
        stage: "runtime",
        code: "playback-failed",
        fallback: "none",
      };
      for (const operation of [
        popupVisual,
        readyVisual,
        spinVisual,
        landingVisual,
        summaryVisual,
      ]) {
        this.failVisual(operation, failure);
      }
      popupVisual = null;
      readyVisual = null;
      spinVisual = null;
      landingVisual = null;
      summaryVisual = null;
      throw error;
    } finally {
      readyAnimation?.finish();
      // 着陆过程中的外观故障或破坏决不能让循环的重击胸部动画永远被锁定。 / English: Cosmetic glitches or damage during landing should never allow a looping chest thumping animation to be locked out forever.
      if ((this.destroyed && interactionReady && interaction.state === "cancelled")
        || shouldAbortWheelPresentation(
          characterSpinStarted || interaction.spinRequestedAtMs !== null,
          characterSpinFinished,
        )) {
        try {
          this.hooks.onWheelSpinAbort?.();
        } catch {
          // 即使装饰挂钩失败，持久状态恢复也会继续。 / English: Persistent state recovery continues even if the decoration hook fails.
        }
      }
      if (popupInteraction && this.activeWheelPopupContinue === popupInteraction) {
        if (popupInteraction.state === "waiting") {
          popupInteraction.state = "cancelled";
          popupInteraction.finish();
        }
        this.activeWheelPopupContinue = null;
        this.notifyWheelPopupClose(popupInteraction, "cancelled");
      }
      if (summaryInteraction && this.activeWheelSummaryContinue === summaryInteraction) {
        if (summaryInteraction.state === "waiting") {
          summaryInteraction.state = "cancelled";
          summaryInteraction.finish();
        }
        this.activeWheelSummaryContinue = null;
        this.notifyWheelSummaryClose(summaryInteraction, "cancelled");
      }
      if (this.activeWheelInteraction === interaction) this.activeWheelInteraction = null;
      wheelHitTarget.visible = false;
      for (const operation of [
        popupVisual,
        readyVisual,
        spinVisual,
        landingVisual,
        summaryVisual,
      ]) {
        this.completeVisual(operation, reducedMotion, "cancelled");
      }
      if (!outroOwnsScene) cleanupScene();
    }
  }

  private effectPoint(localPoint: Point): Point {
    const globalPoint = this.reels.toGlobal(localPoint);
    return this.view.toLocal(globalPoint);
  }

  private notifyWheelSummaryClose(
    interaction: ActiveWheelSummaryContinue,
    reason: WheelSummaryCloseReason,
  ): void {
    if (interaction.closeNotified) return;
    interaction.closeNotified = true;
    try {
      this.hooks.onWheelSummaryClose?.(reason);
    } catch {
      // 输入关闭已提交；诊断无法重新打开大门。 / English: Input closure committed; diagnostics cannot reopen the gate.
    }
  }

  private notifyWheelPopupClose(
    interaction: ActiveWheelPopupContinue,
    reason: WheelSummaryCloseReason,
  ): void {
    if (interaction.closeNotified) return;
    interaction.closeNotified = true;
    try {
      this.hooks.onWheelPopupClose?.(reason);
    } catch {
      // 输入关闭已提交；诊断无法重新打开大门。 / English: Input closure committed; diagnostics cannot reopen the gate.
    }
  }

  private notifyFreeSpinSummaryClose(
    interaction: ActiveFreeSpinSummaryContinue,
    reason: FreeSpinSummaryCloseReason,
  ): void {
    if (interaction.closeNotified) return;
    interaction.closeNotified = true;
    try {
      this.hooks.onFreeSpinSummaryClose?.(reason);
    } catch {
      // 输入关闭已提交；诊断无法重新打开大门。 / English: Input closure submitted; diagnostics cannot reopen the gate.
    }
  }

  private requestFreeSpinSummaryInputReadyCheckpoint(): Promise<void> | undefined {
    try {
      const pending = this.hooks.onFreeSpinSummaryInputReadyCheckpoint?.();
      if (!pending) return undefined;
      return Promise.resolve(pending).catch(() => undefined);
    } catch {
      return undefined;
    }
  }

  private requestWheelCheckpoint(
    callback: (() => void | Promise<void>) | undefined,
  ): Promise<boolean> | undefined {
    try {
      const pending = callback?.();
      if (!pending) return undefined;
      return Promise.resolve(pending).then(
        () => true,
        () => false,
      );
    } catch {
      return undefined;
    }
  }

  /**
   * 仅推进轮钟的点击后部分。快速停止镜像 Spinner.quickStop()：它跳转到三次停止曲线的末端，然后保留零位移一秒停止保留和每个奖励/总结保留。
   * STOPPING 之后的请求将被忽略。
   *
   * 英文 / English: Advance only the post-click portion of the wheel clock. Quick stop mirrors Spinner.quickStop(): it jumps to the end of the triple stop curve, then holds zero displacement for one second stop hold and each bonus/summary hold. Requests after STOPPING will be ignored.
   */
  private animateWheelContinuation(
    interaction: ActiveWheelInteraction,
    timelineScale: number,
    plan: PrimalWheelSpinPlan,
    onFrame: (motionElapsedMs: number, wallSpinElapsedMs: number) => void,
    endLogicalMs: number = PRIMAL_WHEEL_TIMELINE_MS.total,
  ): Promise<number> {
    if (this.destroyed) return Promise.resolve(0);
    const safeScale = Math.max(0.000_001, timelineScale);
    return new Promise<number>((resolve, reject) => {
      let startedAt: number | null = null;
      let quickStopAt: number | null = null;
      let projectedMotionElapsed = 0;
      let settled = false;
      const animation: ActiveAnimation = {
        handle: null,
        finish: () => settle(),
        cancel: () => settle(new FeaturePresentationCancelledError()),
      };
      const settle = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (animation.handle !== null) cancelAnimationFrame(animation.handle);
        animation.handle = null;
        this.animations.delete(animation);
        if (error === undefined) resolve(projectedMotionElapsed);
        else reject(error);
      };
      const tick = (time: number): void => {
        if (this.destroyed || interaction.state === "cancelled") {
          settle();
          return;
        }
        if (startedAt === null) startedAt = time;
        const physicalElapsed = Math.max(0, time - startedAt);
        const wallSpinElapsed = physicalElapsed / safeScale;
        if (interaction.quickStopRequested && quickStopAt === null) {
          quickStopAt = wallSpinElapsed;
        }
        projectedMotionElapsed = primalWheelQuickStopElapsed(
          wallSpinElapsed,
          quickStopAt,
          plan,
        );
        const motionElapsed = Math.min(
          endLogicalMs,
          projectedMotionElapsed,
        );
        try {
          onFrame(motionElapsed, wallSpinElapsed);
        } catch (error) {
          settle(error);
          return;
        }
        if (motionElapsed >= endLogicalMs) {
          settle();
          return;
        }
        animation.handle = requestAnimationFrame(tick);
      };
      this.animations.add(animation);
      try {
        onFrame(0, 0);
        animation.handle = requestAnimationFrame(tick);
      } catch (error) {
        settle(error);
      }
    });
  }

  /** 仅暂停活动的 Rage 级联时钟；每个不相关的 RAF 都会继续。 / English: Only the active Rage cascade clock is paused; every unrelated RAF continues. */
  private animateRageCascadePlayback(
    durationMs: number,
    onFrame: (progress: number) => void,
    onReady?: (finish: () => void) => unknown,
  ): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let elapsedMs = 0;
      let previousTime: number | null = null;
      let settled = false;
      const animation: ActiveAnimation = {
        handle: null,
        finish: () => settle(),
        cancel: () => settle(new FeaturePresentationCancelledError()),
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
      const tick = (time: number): void => {
        if (this.destroyed) {
          settle();
          return;
        }
        if (previousTime === null) previousTime = time;
        const deltaMs = Math.max(0, time - previousTime);
        previousTime = time;
        if (!this.rageCascadePlaybackPaused) elapsedMs += deltaMs;
        const progress = Math.min(1, Math.max(0, elapsedMs / Math.max(1, durationMs)));
        try {
          onFrame(progress);
        } catch (error) {
          settle(error);
          return;
        }
        if (settled) return;
        if (this.rageCascadePlaybackPaused) {
          animation.handle = requestAnimationFrame(tick);
          return;
        }
        if (progress >= 1) {
          settle();
          return;
        }
        animation.handle = requestAnimationFrame(tick);
      };
      this.animations.add(animation);
      const begin = (): void => {
        if (settled || this.destroyed) {
          settle();
          return;
        }
        try {
          onFrame(0);
          if (settled) return;
          animation.handle = requestAnimationFrame(tick);
        } catch (error) {
          settle(error);
        }
      };
      try {
        const checkpoint = onReady?.(animation.finish);
        if (isPromiseLike(checkpoint)) {
          void Promise.resolve(checkpoint).then(begin, begin);
        } else {
          begin();
        }
      } catch (error) {
        settle(error);
      }
    });
  }

  /** 仅暂停活动的 Rage 收集时钟；每个不相关的 RAF 都会继续。 / English: Only the active Rage collection clock is paused; every unrelated RAF continues. */
  private animateRageCollection(
    durationMs: number,
    onFrame: (progress: number) => void,
  ): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let elapsedMs = 0;
      let previousTime: number | null = null;
      let settled = false;
      const animation: ActiveAnimation = {
        handle: null,
        finish: () => settle(),
        cancel: () => settle(new FeaturePresentationCancelledError()),
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
      const tick = (time: number): void => {
        if (this.destroyed) {
          settle();
          return;
        }
        if (previousTime === null) previousTime = time;
        const deltaMs = Math.max(0, time - previousTime);
        previousTime = time;
        if (!this.rageCollectionPlaybackPaused) elapsedMs += deltaMs;
        const progress = Math.min(1, Math.max(0, elapsedMs / Math.max(1, durationMs)));
        try {
          onFrame(progress);
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
        onFrame(0);
        animation.handle = requestAnimationFrame(tick);
      } catch (error) {
        settle(error);
      }
    });
  }

  private animate(
    durationMs: number,
    onFrame: (progress: number) => void,
    onReady?: (finish: () => void) => unknown,
    clockOriginMs?: number,
  ): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let startedAt: number | null = clockOriginMs ?? null;
      let settled = false;
      const animation: ActiveAnimation = {
        handle: null,
        finish: () => settle(),
        cancel: () => settle(new FeaturePresentationCancelledError()),
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
      const tick = (time: number): void => {
        if (this.destroyed) {
          settle();
          return;
        }
        if (startedAt === null) startedAt = time;
        const progress = Math.min(1, Math.max(0, (time - startedAt) / durationMs));
        try {
          onFrame(progress);
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
      const begin = (): void => {
        if (settled || this.destroyed) {
          settle();
          return;
        }
        try {
          onFrame(0);
          animation.handle = requestAnimationFrame(tick);
        } catch (error) {
          settle(error);
        }
      };
      try {
        const checkpoint = onReady?.(animation.finish);
        if (isPromiseLike(checkpoint)) {
          void Promise.resolve(checkpoint).then(begin, begin);
        } else {
          begin();
        }
      } catch (error) {
        settle(error);
      }
    });
  }

  private release(scene: Container): void {
    if (scene.parent) scene.parent.removeChild(scene);
    try {
      scene.destroy({ children: true });
    } catch {
      // 递归渲染器拆卸可能已经破坏了这个场景。 / English: Recursive renderer teardown may have broken the scene.
    }
  }
}
