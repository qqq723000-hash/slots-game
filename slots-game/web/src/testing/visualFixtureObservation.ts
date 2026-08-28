import type {
  AppPresentationBranch,
  AppPresentationCheckpoint,
  AppPresentationTrace,
  RoundPresentationState,
} from "../app/AppController";
import type { FeatureEvent, FeatureState } from "../app/state/types";
import type { ReelCabinetCompositionDiagnostics } from "../reels/ReelSetView";
import type { ReelVaultCaptureDiagnostics } from "../reels/ReelView";
import type {
  CharacterIntroLifecycleDiagnostics,
  CharacterTrackDiagnostic,
  WheelChestPoundCaptureDiagnostics,
} from "../renderer/intro/LaunchScene";
import type { WinCelebrationResidentFacts } from "../renderer/WinCelebration";
import type { VisualTelemetryEvent } from "../renderer/VisualTelemetry";

export type VisualFixtureDataset = Record<string, string | undefined>;

export const VISUAL_FIXTURE_EVENT_HISTORY_LIMIT = 256;

export interface VisualFixtureFeatureEventProjection {
  readonly event: FeatureEvent["type"] | null;
  readonly events: readonly FeatureEvent["type"][];
  readonly eventCount: number;
}

function isFixtureEventType(value: unknown): value is FeatureEvent["type"] {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 64
    && /^[a-z0-9_.-]+$/.test(value);
}

function isHealthyFeatureEventProjection(
  state: unknown,
): state is Readonly<VisualFixtureFeatureEventProjection> {
  if (!state || typeof state !== "object") return false;
  const candidate = state as Partial<VisualFixtureFeatureEventProjection>;
  if (!Array.isArray(candidate.events)
    || !Number.isSafeInteger(candidate.eventCount)
    || (candidate.eventCount ?? -1) < 0
    || (candidate.eventCount ?? Number.POSITIVE_INFINITY)
      > VISUAL_FIXTURE_EVENT_HISTORY_LIMIT
    || candidate.events.length !== candidate.eventCount
    || !candidate.events.every(isFixtureEventType)) return false;
  return candidate.event === null
    || (isFixtureEventType(candidate.event)
      && candidate.events.at(-1) === candidate.event);
}

export function createVisualFixtureFeatureEventProjection(
): Readonly<VisualFixtureFeatureEventProjection> {
  return Object.freeze({
    event: null,
    events: Object.freeze([]),
    eventCount: 0,
  });
}

/**
 * 只记录观察者实际收到的事件类型；不从静态网关场景推导证据，也不保留事件载荷。
 * null 仅表示当前表现结束，因此只清 current；历史达到上限或结构损坏时返回 null，
 * 让调用方失败关闭夹具，而不是悄悄截断可能缺失的浏览器证据。
 */
export function projectVisualFixtureFeatureEvent(
  state: Readonly<VisualFixtureFeatureEventProjection>,
  type: FeatureEvent["type"] | null,
  event?: Readonly<FeatureEvent> | null,
): Readonly<VisualFixtureFeatureEventProjection> | null {
  if (!isHealthyFeatureEventProjection(state)) return null;

  if (type === null) {
    if (event != null) return null;
    return Object.freeze({
      event: null,
      events: Object.freeze([...state.events]),
      eventCount: state.eventCount,
    });
  }
  if (!isFixtureEventType(type)
    || !event
    || event.type !== type
    || state.eventCount >= VISUAL_FIXTURE_EVENT_HISTORY_LIMIT) return null;

  const events = Object.freeze([...state.events, type]);
  return Object.freeze({
    event: type,
    events,
    eventCount: events.length,
  });
}

export function publishVisualFixtureFeatureEventProjection(
  dataset: VisualFixtureDataset,
  state: Readonly<VisualFixtureFeatureEventProjection>,
): void {
  if (state.event === null) delete dataset.fixtureEvent;
  else dataset.fixtureEvent = state.event;
  dataset.fixtureEvents = state.events.join(",");
  dataset.fixtureEventCount = String(state.eventCount);
}

export function clearVisualFixtureFeatureEventProjection(
  dataset: VisualFixtureDataset,
): void {
  delete dataset.fixtureEvent;
  delete dataset.fixtureEvents;
  delete dataset.fixtureEventCount;
}

export interface VisualFixtureTelemetryProjectionState {
  readonly loadedVisualIds: Set<string>;
  readonly activeVisualOperations: Set<number>;
  /** 仅保留表现 ID 与本地 operationId，供截图把像素绑定到仍存活的具体视觉实例。 */
  readonly activeVisualIdsByOperation: Map<number, string>;
  readonly missingRequiredVisualIds: Set<string>;
  visualFailureCount: number;
  strictFailureLocked: boolean;
}

export function createVisualFixtureTelemetryProjectionState(
  requiredIds: readonly string[],
): VisualFixtureTelemetryProjectionState {
  return {
    loadedVisualIds: new Set(),
    activeVisualOperations: new Set(),
    activeVisualIdsByOperation: new Map(),
    missingRequiredVisualIds: new Set(requiredIds),
    visualFailureCount: 0,
    strictFailureLocked: false,
  };
}

export function publishVisualFixtureTelemetryCounts(
  dataset: VisualFixtureDataset,
  state: VisualFixtureTelemetryProjectionState,
): void {
  dataset.fixtureVisualLoadedCount = String(state.loadedVisualIds.size);
  dataset.fixtureVisualActiveCount = String(state.activeVisualOperations.size);
  dataset.fixtureVisualActiveIds = [...new Set(state.activeVisualIdsByOperation.values())]
    .sort()
    .join(",");
  dataset.fixtureVisualActiveOperations = [...state.activeVisualIdsByOperation]
    .sort(([left], [right]) => left - right)
    .map(([operationId, id]) => `${id}@${operationId}`)
    .join(",");
  dataset.fixtureVisualFailureCount = String(state.visualFailureCount);
  dataset.fixtureVisualMissingRequired = [...state.missingRequiredVisualIds].join(",");
}

/** 只把不可变的实时机台快照发布到捕获测试夹具数据中。 */
export function publishReelCabinetCompositionDiagnostics(
  dataset: VisualFixtureDataset,
  diagnostics: Readonly<ReelCabinetCompositionDiagnostics>,
): void {
  dataset.fixtureReelCabinetComposition = JSON.stringify(diagnostics);
}

/**
 * 锁定第一个严格故障的身份，同时继续预测实时聚合计数。后来的视觉事件永远无法消除导致测试场景失败的诊断。
 */
export function applyVisualFixtureTelemetryEvent(
  dataset: VisualFixtureDataset,
  state: VisualFixtureTelemetryProjectionState,
  event: Readonly<VisualTelemetryEvent>,
): void {
  const strictFailure = event.kind === "fail"
    && (event.requirement === "required" || event.requirement === "conditional");

  if (!state.strictFailureLocked) {
    dataset.fixtureVisualKind = event.kind;
    dataset.fixtureVisualId = event.id;
    dataset.fixtureVisualOperation = String(event.operationId);
    if (event.kind === "fail") dataset.fixtureVisualFailureCode = event.code;
    else delete dataset.fixtureVisualFailureCode;

    if (strictFailure && event.kind === "fail") {
      state.strictFailureLocked = true;
      dataset.fixtureVisualFailureKind = event.kind;
      dataset.fixtureVisualFailureId = event.id;
      dataset.fixtureVisualFailureOperation = String(event.operationId);
    }
  }

  if (event.kind === "load") {
    state.loadedVisualIds.add(event.id);
    state.missingRequiredVisualIds.delete(event.id);
  } else if (event.kind === "start") {
    state.activeVisualOperations.add(event.operationId);
    state.activeVisualIdsByOperation.set(event.operationId, event.id);
  } else {
    state.activeVisualOperations.delete(event.operationId);
    state.activeVisualIdsByOperation.delete(event.operationId);
  }
  if (event.kind === "fail") {
    state.visualFailureCount += 1;
    if (event.requirement === "required") state.missingRequiredVisualIds.add(event.id);
  }
  publishVisualFixtureTelemetryCounts(dataset, state);
}

/**
 * 销毁窗口只接收 owner 同步发布的取消完成事件，使投影与真实 reporter 一起归零；
 * 拆卸期间新建、加载、自然完成或失败的事件都不能重新打开夹具状态。
 */
export function shouldProjectVisualFixtureTelemetryEvent(
  destroyed: boolean,
  tearingDown: boolean,
  event: Readonly<VisualTelemetryEvent>,
): boolean {
  if (!destroyed) return true;
  return tearingDown
    && event.kind === "complete"
    && event.outcome === "cancelled";
}

const RESULT_RESET_KEYS = Object.freeze([
  "fixtureCounterState",
  "fixtureRecordIndex",
  "fixtureRecordCount",
  "fixtureRecordId",
  "fixtureRecordSymbol",
  "fixtureRecordPhase",
  "fixtureTraceHistory",
  "fixtureStaleHidden",
  "fixtureTraceViolation",
  "fixtureResidentGeneration",
  "fixtureResidentLabelInstanceId",
  "fixtureResidentFramePoolInstanceId",
  "fixtureResidentFramePoolSize",
  "fixtureResidentPool24",
  "fixtureResidentActiveBoxCount",
  "fixtureResidentActiveOwnerCount",
  "fixtureResidentPendingCleanupCount",
  "fixtureResidentViewReused",
  "fixtureResidentHandoffDelayMs",
  "fixtureResidentStaleHiddenCount",
  "fixtureBigWinMilestone",
  "fixtureContinueTriggeredAt",
  "fixtureContinueClickCount",
  "fixtureContinueAcceptedCount",
  "fixtureContinueRecord1Seen",
  "fixtureContinueLogicalDoneCount",
  "fixtureContinueVisualHiddenCount",
  "fixtureWildRevealPhase",
  "fixtureWildRevealCell",
  "fixtureWildRevealMultiplier",
  "fixtureWildRevealOutroMs",
  "fixtureWildRevealPreCount",
  "fixtureWildRevealCompleteCount",
  "fixtureWildRevealTraceHistory",
  "fixtureWildRevealViolation",
  "fixtureRageCollectPhase",
  "fixtureRageCollectCell",
  "fixtureRageCollectCount",
  "fixtureRageCollectTriggered",
  "fixtureRageCollectGuaranteed",
  "fixtureRageCollectLevel",
  "fixtureRageCollectTotal",
  "fixtureRageCollectBodyClip",
  "fixtureRageCollectCharacterStarted",
  "fixtureRageCollectActivated",
  "fixtureRageCollectHidden",
  "fixtureRageCollectTowerStarted",
  "fixtureRageCollectAuthoredAtMs",
  "fixtureRageCollectStartedCount",
  "fixtureRageCollectAbsorbingCount",
  "fixtureRageCollectSourceHiddenCount",
  "fixtureRageCollectCompleteCount",
  "fixtureRageCollectTraceHistory",
  "fixtureRageCollectViolation",
  "fixturePass45EventHistory",
  "fixturePass45EventCount",
  "fixturePass45Checkpoint",
  "fixturePass45Violation",
  "fixtureRageCascadePhase",
  "fixtureRageCascadeSourceCell",
  "fixtureRageCascadeTransformCells",
  "fixtureRageCascadeSourceCount",
  "fixtureRageCascadeTransformCount",
  "fixtureRageCascadeTriggered",
  "fixtureRageCascadeGuaranteed",
  "fixtureRageCascadeLevel",
  "fixtureRageCascadeTotal",
  "fixtureRageCascadeAuthoredAtMs",
  "fixtureRageCascadeReducedMotion",
  "fixtureRageCascadeHidden",
  "fixtureRageCascadeActivationAttempted",
  "fixtureRageCascadeActivationPlayed",
  "fixtureRageCascadeShuffledCells",
  "fixtureRageCascadeTraversalHistory",
  "fixtureRageCascadeTraversalCount",
  "fixtureRageCascadeShakeHistory",
  "fixtureRageCascadeShakeAuthoredHistory",
  "fixtureRageCascadeShakeCount",
  "fixtureRageCascadeTraceHistory",
  "fixtureRageCascadeEventHistory",
  "fixtureRageCascadeEventCount",
  "fixtureRageCascadeWheelMilestones",
  "fixtureRageCascadeWheelMilestoneCount",
  "fixtureRageCascadeVisualStartedCount",
  "fixtureRageCascadeStartedCount",
  "fixtureRageCascadeExplodingCount",
  "fixtureRageCascadePlacedCount",
  "fixtureRageCascadePoundCount",
  "fixtureRageCascadeActivationCount",
  "fixtureRageCascadeSourceHiddenCount",
  "fixtureRageCascadeCompleteCount",
  "fixtureRageCascadeCheckpoint",
  "fixtureRageCascadeViolation",
] as const);

const TRACE_KEYS = Object.freeze([
  "fixtureSequence",
  "fixtureStage",
  "fixtureTotalWinMinor",
  "fixtureBalanceMinor",
  ...RESULT_RESET_KEYS,
  "fixtureCompleteCount",
] as const);

const VAULT_KEYS = Object.freeze([
  "fixtureVaultPhase",
  "fixtureVaultStep",
  "fixtureVaultPrize",
  "fixtureVaultMultiplier",
  "fixtureVaultCell",
  "fixtureVaultUnlockCheckpoint",
  "fixtureVaultUnlockDiagnostics",
  "fixtureVaultUnlockContract",
  "fixtureVaultUnlockViolation",
] as const);

const COMPLETION_KEYS = Object.freeze([
  "fixtureCompletionMode",
  "fixtureCompletionAwarded",
  "fixtureCompletionWinMinor",
] as const);

const PRESENTATION_BRANCH_KEYS = Object.freeze([
  "fixtureCapCloseReason",
  "fixtureCapCloseCount",
  "fixtureSummaryCloseReason",
  "fixtureSummaryCloseCount",
  "fixtureCloseHistory",
] as const);

function clearKeys(
  dataset: VisualFixtureDataset,
  keys: readonly string[],
): void {
  for (const key of keys) delete dataset[key];
}

export function clearVisualFixtureTrace(dataset: VisualFixtureDataset): void {
  clearKeys(dataset, TRACE_KEYS);
}

export function clearVisualFixtureVault(dataset: VisualFixtureDataset): void {
  clearKeys(dataset, VAULT_KEYS);
}

export function clearVisualFixtureCompletion(dataset: VisualFixtureDataset): void {
  clearKeys(dataset, COMPLETION_KEYS);
}

export function clearVisualFixturePresentationBranches(
  dataset: VisualFixtureDataset,
): void {
  clearKeys(dataset, PRESENTATION_BRANCH_KEYS);
}

/** 为最终浏览器断言保留各轮的准确关门结果。 */
export function applyVisualFixturePresentationBranch(
  dataset: VisualFixtureDataset,
  branch: AppPresentationBranch,
): void {
  const cap = branch.type === "free-spin-cap.closed";
  const reasonKey = cap ? "fixtureCapCloseReason" : "fixtureSummaryCloseReason";
  const countKey = cap ? "fixtureCapCloseCount" : "fixtureSummaryCloseCount";
  const previous = Number.parseInt(dataset[countKey] ?? "0", 10);
  const count = Number.isSafeInteger(previous) && previous >= 0 ? previous + 1 : 1;
  const entry = `${cap ? "free-spin-cap" : "free-spins-summary"}:${branch.reason}`;
  dataset[reasonKey] = branch.reason;
  dataset[countKey] = String(count);
  dataset.fixtureCloseHistory = dataset.fixtureCloseHistory
    ? `${dataset.fixtureCloseHistory},${entry}`
    : entry;
}

function residentFactsFromTrace(
  trace: AppPresentationTrace,
): Readonly<WinCelebrationResidentFacts> | null {
  const resident = (trace as AppPresentationTrace & {
    readonly resident?: Readonly<WinCelebrationResidentFacts>;
  }).resident;
  return resident ?? null;
}

function projectResidentFacts(
  dataset: VisualFixtureDataset,
  resident: Readonly<WinCelebrationResidentFacts>,
): void {
  dataset.fixtureResidentGeneration = String(resident.generation);
  dataset.fixtureResidentLabelInstanceId = String(resident.labelInstanceId);
  dataset.fixtureResidentFramePoolInstanceId = String(resident.framePoolInstanceId);
  dataset.fixtureResidentFramePoolSize = String(resident.framePoolSize);
  dataset.fixtureResidentPool24 = String(resident.framePoolSize === 24);
  dataset.fixtureResidentActiveBoxCount = String(resident.activeBoxCount);
  dataset.fixtureResidentActiveOwnerCount = String(resident.activeOwnerCount);
  dataset.fixtureResidentPendingCleanupCount = String(resident.pendingCleanupCount);
  dataset.fixtureResidentViewReused = String(resident.viewReused);
  dataset.fixtureResidentHandoffDelayMs = String(resident.handoffDelayMs);
  dataset.fixtureResidentStaleHiddenCount = String(resident.staleHiddenCount);
}

function appendRecordTraceHistory(
  dataset: VisualFixtureDataset,
  sequence: number,
  index: number,
  phase: string,
  stale = false,
): void {
  const entry = `${sequence}:${index}:${phase}${stale ? ":stale" : ""}`;
  dataset.fixtureTraceHistory = dataset.fixtureTraceHistory
    ? `${dataset.fixtureTraceHistory},${entry}`
    : entry;
}

const NORMAL_WIN_CONTINUE_SCENARIO = "normal-win-continue";
const BASE_WILD_REVEAL_SCENARIO = "base-wild-reveal-x100";
const BASE_SINGLE_RAGE_SCENARIO = "base-single-rage-no-wheel";
const BASE_TWO_RAGE_SCENARIO = "base-two-rage-no-wheel";
const BASE_ONE_RAGE_TRIGGER_TRANSFORM_SCENARIO = "base-one-rage-trigger-transform";
const BASE_RAGE_LEVEL_TWO_PERSISTENT_AURA_SCENARIO =
  "base-rage-level-two-persistent-aura";
const BASE_LAUNCH_LEVEL_TWO_INTRO_SCENARIO = "base-launch-level-two-intro";
const BASE_RGS_RECOVERED_LEVEL_UP_SCENARIO = "base-rgs-recovered-level-up";
const BASE_THREE_RAGE_WHEEL_ENTRY_SCENARIO = "base-three-rage-wheel-entry";
const BASE_WILD_REVEAL_CELL = "1:1";
const BASE_WILD_REVEAL_MULTIPLIER = 100;
const BASE_WILD_REVEAL_OUTRO_MS = 1_000;
const NORMAL_WIN_CONTINUE_TRIGGER = "1:0:merge-start";
const NORMAL_WIN_CONTINUE_RECORD_IDS = Object.freeze([
  "continue-prism-wild-x5-four-boxes",
  "continue-orbit-plain-sentinel",
] as const);

export type Pass48RageAuraCheckpoint =
  | "rage-aura.session-restored"
  | "rage-aura.inter-round-preserved";

export interface Pass48RageAuraCheckpointDiagnostics {
  readonly launchReady: boolean;
  readonly neutralCharacterReady: boolean;
  readonly roundComplete: boolean;
  readonly state: Readonly<FeatureState> | null;
  readonly tracks: readonly Readonly<CharacterTrackDiagnostic>[];
}

const PASS48_RAGE_AURA_TRACK_NAMES = Object.freeze([
  null,
  "idle",
  "aura_2",
  "particles_loop",
  null,
] as const);

function setPass48RageAuraViolation(
  dataset: VisualFixtureDataset,
  code: string,
): string {
  if (dataset.fixtureRageAuraViolation === undefined) {
    dataset.fixtureRageAuraViolation = code;
  }
  if (dataset.fixtureTraceViolation === undefined) {
    dataset.fixtureTraceViolation = code;
  }
  return dataset.fixtureRageAuraViolation;
}

function hasExactPass48RageAuraState(
  state: Readonly<FeatureState> | null,
): state is Readonly<FeatureState> {
  if (!state
    || state.mode !== "BASE"
    || state.freeSpinsRemaining !== 0
    || state.rageLevel !== 2
    || state.rageCollected !== 12
    || state.freeSpinsPlayed !== undefined
    || state.baseBetMinor !== undefined
    || state.freeSpinsWinMinor !== undefined) return false;
  const keys = Object.keys(state).sort();
  return keys.length === 4
    && keys[0] === "freeSpinsRemaining"
    && keys[1] === "mode"
    && keys[2] === "rageCollected"
    && keys[3] === "rageLevel";
}

function hasExactPass48RageAuraTracks(
  tracks: readonly Readonly<CharacterTrackDiagnostic>[],
): boolean {
  return tracks.length === PASS48_RAGE_AURA_TRACK_NAMES.length
    && tracks.every((entry, index) => (
      entry.track === index
      && entry.animation === PASS48_RAGE_AURA_TRACK_NAMES[index]
    ));
}

export function isPass48RageAuraCapture(
  scenario: string,
  capture: string | null,
): boolean {
  return scenario === BASE_RAGE_LEVEL_TWO_PERSISTENT_AURA_SCENARIO
    && capture === "1";
}

/**
 * 发布两个 Pass48 捕获检查点的只读协议/Spine 证据。动画时间被序列化以供检查，但不会进行比较或用于驱动表现。
 */
export function publishPass48RageAuraCheckpoint(
  dataset: VisualFixtureDataset,
  scenario: string,
  capture: string | null,
  checkpoint: Pass48RageAuraCheckpoint,
  diagnostics: Readonly<Pass48RageAuraCheckpointDiagnostics>,
): string | null {
  if (!isPass48RageAuraCapture(scenario, capture)) return null;

  delete dataset.fixtureRageAuraCheckpoint;
  dataset.fixtureRageAuraState = JSON.stringify(diagnostics.state);
  dataset.fixtureCharacterTracks = JSON.stringify(diagnostics.tracks);
  if (dataset.fixtureRageAuraFeatureEventCount === undefined) {
    dataset.fixtureRageAuraFeatureEventCount = "0";
  }

  if (!diagnostics.launchReady || !diagnostics.neutralCharacterReady) {
    return setPass48RageAuraViolation(dataset, "rage-aura-capture-not-ready");
  }
  if (!hasExactPass48RageAuraState(diagnostics.state)) {
    return setPass48RageAuraViolation(dataset, "rage-aura-state-contract");
  }
  if (!hasExactPass48RageAuraTracks(diagnostics.tracks)) {
    return setPass48RageAuraViolation(dataset, "rage-aura-track-contract");
  }
  if (dataset.fixtureRageAuraFeatureEventCount !== "0"
    || dataset.fixtureEvent !== undefined) {
    return setPass48RageAuraViolation(dataset, "rage-aura-unexpected-feature-event");
  }
  if (dataset.fixtureVisualFailureCount !== "0"
    || dataset.fixtureVisualFailureKind !== undefined
    || (dataset.fixtureVisualMissingRequired ?? "") !== "") {
    return setPass48RageAuraViolation(dataset, "rage-aura-visual-failure");
  }
  if (checkpoint === "rage-aura.inter-round-preserved"
    && (!diagnostics.roundComplete
      || dataset.fixtureRoundState !== "complete"
      || dataset.fixtureRageAuraRoundAcceptedCount !== "1"
      || dataset.fixtureCompleteCount !== "1")) {
    return setPass48RageAuraViolation(dataset, "rage-aura-round-incomplete");
  }
  if (dataset.fixtureRageAuraViolation !== undefined) {
    return dataset.fixtureRageAuraViolation;
  }

  dataset.fixtureRageAuraCheckpoint = checkpoint;
  if (checkpoint === "rage-aura.session-restored") {
    dataset.fixtureRageAuraSessionRestored = "true";
  } else {
    dataset.fixtureRageAuraInterRoundPreserved = "true";
  }
  return null;
}

export const PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT =
  "character-intro.launch-ready" as const;
export const PASS50_CHARACTER_INTRO_LOOP_ENTERED_CHECKPOINT =
  "character-intro.loop-entered" as const;

export type Pass50CharacterIntroCheckpoint =
  | typeof PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT
  | typeof PASS50_CHARACTER_INTRO_LOOP_ENTERED_CHECKPOINT;

export interface Pass50CharacterIntroLifecycleDiagnostics {
  readonly introActive: boolean;
  readonly introElapsedMs: number;
  readonly bodyReleased: boolean;
  readonly auraReleased: boolean;
  readonly idleSchedulerActive: boolean;
  readonly capturePaused: boolean;
  readonly taskDurationMs?: number;
  readonly timelineControlled?: boolean;
}

export interface Pass50CharacterIntroCaptureDiagnostics {
  readonly launchReady: boolean;
  readonly roundState: RoundPresentationState;
  readonly state: Readonly<FeatureState> | null;
  readonly spinRequestCount: number;
  readonly roundDeliveryCount: number;
  readonly featureEventCount: number;
  readonly tracks: readonly Readonly<CharacterTrackDiagnostic>[];
  readonly lifecycle: Readonly<Pass50CharacterIntroLifecycleDiagnostics>;
}

function setPass50CharacterIntroViolation(
  dataset: VisualFixtureDataset,
  code: string,
): string {
  if (dataset.fixtureCharacterIntroViolation === undefined) {
    dataset.fixtureCharacterIntroViolation = code;
  }
  if (dataset.fixtureTraceViolation === undefined) {
    dataset.fixtureTraceViolation = code;
  }
  return dataset.fixtureCharacterIntroViolation;
}

function pass50Track(
  tracks: readonly Readonly<CharacterTrackDiagnostic>[],
  track: number,
): Readonly<CharacterTrackDiagnostic> | null {
  const matches = tracks.filter((entry) => entry.track === track);
  return matches.length === 1 ? matches[0] ?? null : null;
}

function finiteTrackTime(entry: Readonly<CharacterTrackDiagnostic> | null): number | null {
  return entry && typeof entry.trackTime === "number" && Number.isFinite(entry.trackTime)
    ? entry.trackTime
    : null;
}

/**
 * Pass50 启动协议故意比场景允许列表更窄：几乎未命中的捕获/检查点/运行查询正常渲染，并且永远不会暂停生产时钟。
 */
export function isPass50CharacterIntroCapture(
  scenario: string,
  capture: string | null,
  checkpoint: string | null,
  run: string | null,
): boolean {
  return scenario === BASE_LAUNCH_LEVEL_TWO_INTRO_SCENARIO
    && capture === "1"
    && checkpoint === PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT
    && run === "pass50";
}

/**
 * 发布并验证两个浏览器保存的 INTRO 生命周期姿势之一。 LOOP 条目需要先前的诊断，以便可以将持续前进的光环与错误重新启动的轨道区分开来。
 */
export function publishPass50CharacterIntroCheckpoint(
  dataset: VisualFixtureDataset,
  scenario: string,
  capture: string | null,
  checkpoint: string | null,
  run: string | null,
  observedCheckpoint: Pass50CharacterIntroCheckpoint,
  diagnostics: Readonly<Pass50CharacterIntroCaptureDiagnostics>,
  launchReadyDiagnostics: Readonly<Pass50CharacterIntroCaptureDiagnostics> | null = null,
): string | null {
  if (!isPass50CharacterIntroCapture(scenario, capture, checkpoint, run)) return null;

  const body = pass50Track(diagnostics.tracks, 1);
  const aura = pass50Track(diagnostics.tracks, 2);
  const particles = pass50Track(diagnostics.tracks, 3);
  dataset.fixtureCharacterIntroDiagnostics = JSON.stringify({
    checkpoint: observedCheckpoint,
    state: diagnostics.state,
    roundState: diagnostics.roundState,
    spinRequestCount: diagnostics.spinRequestCount,
    roundDeliveryCount: diagnostics.roundDeliveryCount,
    featureEventCount: diagnostics.featureEventCount,
    lifecycle: diagnostics.lifecycle,
    tracks: diagnostics.tracks,
  });
  dataset.fixtureCharacterIntroLifecycle = JSON.stringify(diagnostics.lifecycle);
  dataset.fixtureCharacterIntroTracks = JSON.stringify(diagnostics.tracks);
  dataset.fixtureCharacterIntroState = JSON.stringify(diagnostics.state);
  dataset.fixtureCharacterIntroRoundState = diagnostics.roundState;
  dataset.fixtureCharacterIntroSpinRequestCount = String(diagnostics.spinRequestCount);
  dataset.fixtureCharacterIntroRoundDeliveryCount = String(diagnostics.roundDeliveryCount);
  dataset.fixtureCharacterIntroFeatureEventCount = String(diagnostics.featureEventCount);

  if (!diagnostics.launchReady) {
    return setPass50CharacterIntroViolation(dataset, "character-intro-launch-not-ready");
  }
  if (!hasExactPass48RageAuraState(diagnostics.state)) {
    return setPass50CharacterIntroViolation(dataset, "character-intro-state-contract");
  }
  if (diagnostics.roundState !== "idle"
    || diagnostics.spinRequestCount !== 0
    || diagnostics.roundDeliveryCount !== 0
    || diagnostics.featureEventCount !== 0
    || dataset.fixtureEvent !== undefined
    || dataset.fixtureCompleteCount !== undefined) {
    return setPass50CharacterIntroViolation(dataset, "character-intro-gameplay-observed");
  }
  if (dataset.fixtureVisualFailureCount !== "0"
    || dataset.fixtureVisualFailureKind !== undefined
    || (dataset.fixtureVisualMissingRequired ?? "") !== "") {
    return setPass50CharacterIntroViolation(dataset, "character-intro-visual-failure");
  }
  if (!body || !aura || !particles
    || aura.animation !== "aura_2"
    || particles.animation !== "particles_loop"
    || finiteTrackTime(aura) === null
    || finiteTrackTime(particles) === null) {
    return setPass50CharacterIntroViolation(dataset, "character-intro-track-contract");
  }
  if (!diagnostics.lifecycle.capturePaused || !diagnostics.lifecycle.auraReleased) {
    return setPass50CharacterIntroViolation(dataset, "character-intro-clock-not-paused");
  }
  if (diagnostics.lifecycle.taskDurationMs !== undefined
    && diagnostics.lifecycle.taskDurationMs !== 8_066) {
    return setPass50CharacterIntroViolation(dataset, "character-intro-task-duration-contract");
  }
  if (diagnostics.lifecycle.timelineControlled === true) {
    return setPass50CharacterIntroViolation(dataset, "character-intro-timeline-not-released");
  }

  if (observedCheckpoint === PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT) {
    if (body.animation !== "intro"
      || body.mixingFrom !== null
      || !diagnostics.lifecycle.introActive
      || diagnostics.lifecycle.bodyReleased
      || diagnostics.lifecycle.idleSchedulerActive
      || !Number.isFinite(diagnostics.lifecycle.introElapsedMs)
      || diagnostics.lifecycle.introElapsedMs < 4_900
      || diagnostics.lifecycle.introElapsedMs > 5_100) {
      return setPass50CharacterIntroViolation(dataset, "character-intro-launch-ready-contract");
    }
    dataset.fixtureCharacterIntroCheckpoint = observedCheckpoint;
    dataset.fixtureCharacterIntroLaunchReady = "true";
    return null;
  }

  const firstAura = pass50Track(launchReadyDiagnostics?.tracks ?? [], 2);
  const firstParticles = pass50Track(launchReadyDiagnostics?.tracks ?? [], 3);
  const firstAuraTime = finiteTrackTime(firstAura);
  const firstParticlesTime = finiteTrackTime(firstParticles);
  const auraTime = finiteTrackTime(aura);
  const particlesTime = finiteTrackTime(particles);
  if (!launchReadyDiagnostics
    || body.animation !== "idle"
    || body.mixingFrom !== "intro"
    || diagnostics.lifecycle.introActive
    || !diagnostics.lifecycle.bodyReleased
    || !diagnostics.lifecycle.idleSchedulerActive
    || diagnostics.lifecycle.introElapsedMs < 8_066
    || firstAura?.animation !== aura.animation
    || firstParticles?.animation !== particles.animation
    || firstAuraTime === null
    || firstParticlesTime === null
    || auraTime === null
    || particlesTime === null
    || auraTime <= firstAuraTime
    || particlesTime <= firstParticlesTime) {
    return setPass50CharacterIntroViolation(dataset, "character-intro-loop-entered-contract");
  }

  dataset.fixtureCharacterIntroCheckpoint = observedCheckpoint;
  dataset.fixtureCharacterIntroLoopEntered = "true";
  dataset.fixtureCharacterIntroAuraAdvanced = "true";
  return null;
}

export function clearPass50CharacterIntroCapture(dataset: VisualFixtureDataset): void {
  delete dataset.fixtureCharacterIntroDiagnostics;
  delete dataset.fixtureCharacterIntroLifecycle;
  delete dataset.fixtureCharacterIntroTracks;
  delete dataset.fixtureCharacterIntroState;
  delete dataset.fixtureCharacterIntroRoundState;
  delete dataset.fixtureCharacterIntroSpinRequestCount;
  delete dataset.fixtureCharacterIntroRoundDeliveryCount;
  delete dataset.fixtureCharacterIntroFeatureEventCount;
  delete dataset.fixtureCharacterIntroCheckpoint;
  delete dataset.fixtureCharacterIntroLaunchReady;
  delete dataset.fixtureCharacterIntroLoopEntered;
  delete dataset.fixtureCharacterIntroAuraAdvanced;
  delete dataset.fixtureCharacterIntroViolation;
}

export const PASS53_CHARACTER_WIN_PRE_HANDOFF_CHECKPOINT =
  "win-character.pre-handoff" as const;
export const PASS53_CHARACTER_WIN_HANDOFF_CHECKPOINT =
  "win-character.handoff" as const;
export const PASS53_CHARACTER_WIN_MIX_COMPLETE_CHECKPOINT =
  "win-character.mix-complete" as const;

export type Pass53CharacterWinCheckpoint =
  | typeof PASS53_CHARACTER_WIN_PRE_HANDOFF_CHECKPOINT
  | typeof PASS53_CHARACTER_WIN_HANDOFF_CHECKPOINT
  | typeof PASS53_CHARACTER_WIN_MIX_COMPLETE_CHECKPOINT;

const PASS53_CHARACTER_WIN_CHECKPOINT_MS = Object.freeze({
  [PASS53_CHARACTER_WIN_PRE_HANDOFF_CHECKPOINT]: 1_499,
  [PASS53_CHARACTER_WIN_HANDOFF_CHECKPOINT]: 1_500,
  [PASS53_CHARACTER_WIN_MIX_COMPLETE_CHECKPOINT]: 1_650,
} satisfies Record<Pass53CharacterWinCheckpoint, number>);

export interface Pass53CharacterWinCaptureDiagnostics {
  readonly checkpoint: Pass53CharacterWinCheckpoint;
  readonly elapsedMs: number;
  readonly sequence: number;
  readonly roundState: RoundPresentationState;
  readonly bodyTrack: Readonly<CharacterTrackDiagnostic> | null;
  readonly tracks: readonly Readonly<CharacterTrackDiagnostic>[];
  readonly lifecycle: Readonly<CharacterIntroLifecycleDiagnostics>;
}

function isPass53CharacterWinCheckpoint(
  checkpoint: string | null,
): checkpoint is Pass53CharacterWinCheckpoint {
  return checkpoint !== null
    && Object.hasOwn(PASS53_CHARACTER_WIN_CHECKPOINT_MS, checkpoint);
}

/** 确切的Pass53浏览器路由；未遂查询无法暂停或步进 Character。 */
export function isPass53CharacterWinCapture(
  scenario: string,
  capture: string | null,
  checkpoint: string | null,
  run: string | null,
): checkpoint is Pass53CharacterWinCheckpoint {
  return scenario === NORMAL_WIN_CONTINUE_SCENARIO
    && capture === "1"
    && isPass53CharacterWinCheckpoint(checkpoint)
    && run === "pass53";
}

export function pass53CharacterWinCheckpointElapsedMs(
  checkpoint: Pass53CharacterWinCheckpoint,
): number {
  return PASS53_CHARACTER_WIN_CHECKPOINT_MS[checkpoint];
}

/** Pass53 证据仅在预设的非简化 Character 时钟上有效。 */
export function pass53CharacterWinCaptureEnvironmentViolation(
  scenario: string,
  capture: string | null,
  checkpoint: string | null,
  run: string | null,
  reducedMotion: boolean,
): string | null {
  if (!isPass53CharacterWinCapture(scenario, capture, checkpoint, run)) return null;
  return reducedMotion ? "character-win-reduced-motion-not-canonical" : null;
}

function setPass53CharacterWinViolation(
  dataset: VisualFixtureDataset,
  code: string,
): string {
  if (dataset.fixtureCharacterWinViolation === undefined) {
    dataset.fixtureCharacterWinViolation = code;
  }
  if (dataset.fixtureTraceViolation === undefined) {
    dataset.fixtureTraceViolation = code;
  }
  return dataset.fixtureCharacterWinViolation;
}

function pass53NearlyEqual(actual: number | null | undefined, expected: number): boolean {
  return typeof actual === "number"
    && Number.isFinite(actual)
    && Math.abs(actual - expected) <= 0.000_001;
}

/** 发布一项不可变的精确时钟 Character WIN 切换观察。 */
export function publishPass53CharacterWinCheckpoint(
  dataset: VisualFixtureDataset,
  scenario: string,
  capture: string | null,
  requestedCheckpoint: string | null,
  run: string | null,
  diagnostics: Readonly<Pass53CharacterWinCaptureDiagnostics>,
): string | null {
  if (!isPass53CharacterWinCapture(
    scenario,
    capture,
    requestedCheckpoint,
    run,
  )) return null;

  delete dataset.fixtureCharacterWinCheckpoint;
  delete dataset.fixtureCharacterWinContract;
  dataset.fixtureCharacterWinElapsedMs = String(diagnostics.elapsedMs);
  dataset.fixtureCharacterWinDiagnostics = JSON.stringify(diagnostics);

  if (!Object.isFrozen(diagnostics)
    || !Object.isFrozen(diagnostics.tracks)
    || !Object.isFrozen(diagnostics.lifecycle)
    || (diagnostics.bodyTrack !== null && !Object.isFrozen(diagnostics.bodyTrack))) {
    return setPass53CharacterWinViolation(dataset, "character-win-diagnostics-mutable");
  }
  const expectedElapsedMs = pass53CharacterWinCheckpointElapsedMs(requestedCheckpoint);
  if (diagnostics.checkpoint !== requestedCheckpoint
    || diagnostics.elapsedMs !== expectedElapsedMs
    || diagnostics.sequence !== 1
    || diagnostics.roundState !== "presenting") {
    return setPass53CharacterWinViolation(dataset, "character-win-clock-contract");
  }
  if (diagnostics.tracks.length !== 5
    || diagnostics.tracks.some((track, index) => track.track !== index)
    || diagnostics.bodyTrack !== diagnostics.tracks[1]) {
    return setPass53CharacterWinViolation(dataset, "character-win-track-set-contract");
  }
  if (!diagnostics.lifecycle.capturePaused
    || diagnostics.lifecycle.introActive
    || !diagnostics.lifecycle.bodyReleased
    || diagnostics.lifecycle.timelineControlled) {
    return setPass53CharacterWinViolation(dataset, "character-win-lifecycle-contract");
  }

  const bodyTrack = diagnostics.bodyTrack;
  const preHandoff = requestedCheckpoint === PASS53_CHARACTER_WIN_PRE_HANDOFF_CHECKPOINT;
  const handoff = requestedCheckpoint === PASS53_CHARACTER_WIN_HANDOFF_CHECKPOINT;
  const expectedAnimation = preHandoff ? "win" : "idle";
  const expectedTrackTime = preHandoff ? 1.499 : handoff ? 0 : 0.15;
  const expectedMixingFrom = handoff ? "win" : null;
  const expectedSchedulerActive = !preHandoff;
  if (!bodyTrack
    || bodyTrack.animation !== expectedAnimation
    || !pass53NearlyEqual(bodyTrack.trackTime, expectedTrackTime)
    || bodyTrack.mixingFrom !== expectedMixingFrom
    || !pass53NearlyEqual(bodyTrack.mixDuration, 0.15)
    || diagnostics.lifecycle.idleSchedulerActive !== expectedSchedulerActive) {
    return setPass53CharacterWinViolation(dataset, "character-win-body-contract");
  }
  if (dataset.fixtureCharacterWinReducedMotion !== "false") {
    return setPass53CharacterWinViolation(dataset, "character-win-environment-contract");
  }
  if (dataset.fixtureCharacterWinViolation !== undefined) {
    return dataset.fixtureCharacterWinViolation;
  }

  dataset.fixtureCharacterWinCheckpoint = requestedCheckpoint;
  dataset.fixtureCharacterWinContract = "ok";
  return null;
}

export function clearPass53CharacterWinCapture(dataset: VisualFixtureDataset): void {
  delete dataset.fixtureCharacterWinCheckpoint;
  delete dataset.fixtureCharacterWinElapsedMs;
  delete dataset.fixtureCharacterWinDiagnostics;
  delete dataset.fixtureCharacterWinContract;
  delete dataset.fixtureCharacterWinReducedMotion;
  delete dataset.fixtureCharacterWinViolation;
}

export const PASS54_WHEEL_CHARACTER_PRE_HANDOFF_CHECKPOINT =
  "wheel-character.pre-handoff" as const;
export const PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT =
  "wheel-character.handoff" as const;
export const PASS54_WHEEL_CHARACTER_MIX_COMPLETE_CHECKPOINT =
  "wheel-character.mix-complete" as const;

export type Pass54WheelCharacterCheckpoint =
  | typeof PASS54_WHEEL_CHARACTER_PRE_HANDOFF_CHECKPOINT
  | typeof PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT
  | typeof PASS54_WHEEL_CHARACTER_MIX_COMPLETE_CHECKPOINT;

const PASS54_WHEEL_CHARACTER_CHECKPOINT_MS = Object.freeze({
  [PASS54_WHEEL_CHARACTER_PRE_HANDOFF_CHECKPOINT]: 1_499,
  [PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT]: 1_500,
  [PASS54_WHEEL_CHARACTER_MIX_COMPLETE_CHECKPOINT]: 1_650,
} satisfies Record<Pass54WheelCharacterCheckpoint, number>);

export interface Pass54WheelCharacterCaptureDiagnostics {
  readonly checkpoint: Pass54WheelCharacterCheckpoint;
  readonly elapsedMs: number;
  readonly sequence: number;
  readonly roundState: RoundPresentationState;
  readonly bodyTrack: Readonly<CharacterTrackDiagnostic> | null;
  readonly tracks: readonly Readonly<CharacterTrackDiagnostic>[];
  readonly lifecycle: Readonly<CharacterIntroLifecycleDiagnostics>;
  readonly milestoneHistory: readonly string[];
  readonly visualFailureCount: number;
  readonly featureEvent: string | null;
  readonly totalWinMinor: string | null;
  readonly balanceMinor: string | null;
}

function isPass54WheelCharacterCheckpoint(
  checkpoint: string | null,
): checkpoint is Pass54WheelCharacterCheckpoint {
  return checkpoint !== null
    && Object.hasOwn(PASS54_WHEEL_CHARACTER_CHECKPOINT_MS, checkpoint);
}

/** 确切的Pass54路线；正常页面和所有未遂事件都无法关闭。 */
export function isPass54WheelCharacterCapture(
  scenario: string,
  capture: string | null,
  checkpoint: string | null,
  run: string | null,
): checkpoint is Pass54WheelCharacterCheckpoint {
  return scenario === "wheel-mini-flow"
    && capture === "1"
    && isPass54WheelCharacterCheckpoint(checkpoint)
    && run === "pass54";
}

export function pass54WheelCharacterCheckpointElapsedMs(
  checkpoint: Pass54WheelCharacterCheckpoint,
): number {
  return PASS54_WHEEL_CHARACTER_CHECKPOINT_MS[checkpoint];
}

export function pass54WheelCharacterCaptureEnvironmentViolation(
  scenario: string,
  capture: string | null,
  checkpoint: string | null,
  run: string | null,
  reducedMotion: boolean,
): string | null {
  if (!isPass54WheelCharacterCapture(scenario, capture, checkpoint, run)) return null;
  return reducedMotion ? "wheel-character-reduced-motion-not-canonical" : null;
}

function setPass54WheelCharacterViolation(
  dataset: VisualFixtureDataset,
  code: string,
): string {
  if (dataset.fixtureWheelCharacterViolation === undefined) {
    dataset.fixtureWheelCharacterViolation = code;
  }
  if (dataset.fixtureTraceViolation === undefined) dataset.fixtureTraceViolation = code;
  return dataset.fixtureWheelCharacterViolation;
}

function pass54NearlyEqual(actual: number | null | undefined, expected: number): boolean {
  return typeof actual === "number"
    && Number.isFinite(actual)
    && Math.abs(actual - expected) <= 0.000_001;
}

/** 发布一项不可变的着陆相关 WIN_FEATURE 观察结果。 */
export function publishPass54WheelCharacterCheckpoint(
  dataset: VisualFixtureDataset,
  scenario: string,
  capture: string | null,
  requestedCheckpoint: string | null,
  run: string | null,
  diagnostics: Readonly<Pass54WheelCharacterCaptureDiagnostics>,
): string | null {
  if (!isPass54WheelCharacterCapture(
    scenario,
    capture,
    requestedCheckpoint,
    run,
  )) return null;

  delete dataset.fixtureWheelCharacterCheckpoint;
  delete dataset.fixtureWheelCharacterContract;
  dataset.fixtureWheelCharacterElapsedMs = String(diagnostics.elapsedMs);
  dataset.fixtureWheelCharacterDiagnostics = JSON.stringify(diagnostics);

  if (!Object.isFrozen(diagnostics)
    || !Object.isFrozen(diagnostics.tracks)
    || diagnostics.tracks.some((track) => !Object.isFrozen(track))
    || !Object.isFrozen(diagnostics.lifecycle)
    || !Object.isFrozen(diagnostics.milestoneHistory)
    || (diagnostics.bodyTrack !== null && !Object.isFrozen(diagnostics.bodyTrack))) {
    return setPass54WheelCharacterViolation(dataset, "wheel-character-diagnostics-mutable");
  }
  const expectedElapsedMs = pass54WheelCharacterCheckpointElapsedMs(requestedCheckpoint);
  if (diagnostics.checkpoint !== requestedCheckpoint
    || diagnostics.elapsedMs !== expectedElapsedMs
    || diagnostics.sequence !== 1
    || diagnostics.roundState !== "presenting") {
    return setPass54WheelCharacterViolation(dataset, "wheel-character-clock-contract");
  }
  if (diagnostics.tracks.length !== 5
    || diagnostics.tracks.some((track, index) => track.track !== index)
    || diagnostics.bodyTrack !== diagnostics.tracks[1]) {
    return setPass54WheelCharacterViolation(dataset, "wheel-character-track-set-contract");
  }
  if (!diagnostics.lifecycle.capturePaused
    || diagnostics.lifecycle.introActive
    || !diagnostics.lifecycle.bodyReleased
    || diagnostics.lifecycle.timelineControlled
    || diagnostics.lifecycle.idleSchedulerActive) {
    return setPass54WheelCharacterViolation(dataset, "wheel-character-lifecycle-contract");
  }

  const bodyTrack = diagnostics.bodyTrack;
  const preHandoff = requestedCheckpoint === PASS54_WHEEL_CHARACTER_PRE_HANDOFF_CHECKPOINT;
  const handoff = requestedCheckpoint === PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT;
  const expectedAnimation = preHandoff ? "win" : "feature_idle";
  const expectedTrackTime = preHandoff ? 1.499 : handoff ? 0 : 0.15;
  const expectedMixingFrom = handoff ? "win" : null;
  if (!bodyTrack
    || bodyTrack.animation !== expectedAnimation
    || !pass54NearlyEqual(bodyTrack.trackTime, expectedTrackTime)
    || bodyTrack.mixingFrom !== expectedMixingFrom
    || !pass54NearlyEqual(bodyTrack.mixDuration, 0.15)) {
    return setPass54WheelCharacterViolation(dataset, "wheel-character-body-contract");
  }

  const milestoneCount = (value: string): number => (
    diagnostics.milestoneHistory.filter((milestone) => milestone === value).length
  );
  if (milestoneCount("wheel.spin-start") !== 1
    || milestoneCount("wheel.spin-finish") !== 1
    || milestoneCount("wheel.quick-stop") !== 0
    || milestoneCount("wheel.summary-input-ready") !== 0) {
    return setPass54WheelCharacterViolation(dataset, "wheel-character-milestone-contract");
  }
  if (diagnostics.visualFailureCount !== 0
    || dataset.fixtureVisualFailureCount !== "0"
    || dataset.fixtureVisualFailureKind !== undefined) {
    return setPass54WheelCharacterViolation(dataset, "wheel-character-visual-contract");
  }
  if (diagnostics.featureEvent !== "wheel.awarded"
    || diagnostics.totalWinMinor !== "1200"
    || diagnostics.balanceMinor !== "101100"
    || dataset.fixtureSequence !== "1") {
    return setPass54WheelCharacterViolation(dataset, "wheel-character-award-contract");
  }
  if (dataset.fixtureWheelCharacterReducedMotion !== "false") {
    return setPass54WheelCharacterViolation(dataset, "wheel-character-environment-contract");
  }
  if (dataset.fixtureWheelCharacterViolation !== undefined) {
    return dataset.fixtureWheelCharacterViolation;
  }

  dataset.fixtureWheelCharacterCheckpoint = requestedCheckpoint;
  dataset.fixtureWheelCharacterContract = "ok";
  return null;
}

export function clearPass54WheelCharacterCapture(dataset: VisualFixtureDataset): void {
  delete dataset.fixtureWheelCharacterCheckpoint;
  delete dataset.fixtureWheelCharacterElapsedMs;
  delete dataset.fixtureWheelCharacterDiagnostics;
  delete dataset.fixtureWheelCharacterContract;
  delete dataset.fixtureWheelCharacterReducedMotion;
  delete dataset.fixtureWheelCharacterViolation;
}

export const PASS55_WHEEL_CHEST_PRE_REENTRY_CHECKPOINT =
  "wheel-chest.pre-reentry" as const;
export const PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT =
  "wheel-chest.reentry" as const;
export const PASS55_WHEEL_CHEST_MIX_COMPLETE_CHECKPOINT =
  "wheel-chest.mix-complete" as const;
export const PASS55_WHEEL_CHEST_SECOND_REENTRY_CHECKPOINT =
  "wheel-chest.second-reentry" as const;

export type Pass55WheelChestCheckpoint =
  | typeof PASS55_WHEEL_CHEST_PRE_REENTRY_CHECKPOINT
  | typeof PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT
  | typeof PASS55_WHEEL_CHEST_MIX_COMPLETE_CHECKPOINT
  | typeof PASS55_WHEEL_CHEST_SECOND_REENTRY_CHECKPOINT;

const PASS55_WHEEL_CHEST_FIRST_REENTRY_MS = 115_000 / 30;
const PASS55_WHEEL_CHEST_CHECKPOINT_MS = Object.freeze({
  [PASS55_WHEEL_CHEST_PRE_REENTRY_CHECKPOINT]: 3_800,
  [PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT]: PASS55_WHEEL_CHEST_FIRST_REENTRY_MS,
  [PASS55_WHEEL_CHEST_MIX_COMPLETE_CHECKPOINT]:
    PASS55_WHEEL_CHEST_FIRST_REENTRY_MS + 150,
  [PASS55_WHEEL_CHEST_SECOND_REENTRY_CHECKPOINT]: 230_000 / 30,
} satisfies Record<Pass55WheelChestCheckpoint, number>);

interface Pass55WheelChestExpectedState {
  readonly taskElapsedMs: number;
  readonly entryOrdinal: number;
  readonly reentryCount: number;
  readonly trackTime: number;
  readonly mixingFrom: string | null;
}

const PASS55_WHEEL_CHEST_EXPECTED_STATE = Object.freeze({
  [PASS55_WHEEL_CHEST_PRE_REENTRY_CHECKPOINT]: Object.freeze({
    taskElapsedMs: 3_800,
    entryOrdinal: 1,
    reentryCount: 0,
    trackTime: 3.8,
    mixingFrom: null,
  }),
  [PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT]: Object.freeze({
    taskElapsedMs: 0,
    entryOrdinal: 2,
    reentryCount: 1,
    trackTime: 0,
    mixingFrom: "chest_pound",
  }),
  [PASS55_WHEEL_CHEST_MIX_COMPLETE_CHECKPOINT]: Object.freeze({
    taskElapsedMs: 150,
    entryOrdinal: 2,
    reentryCount: 1,
    trackTime: 0.15,
    mixingFrom: null,
  }),
  [PASS55_WHEEL_CHEST_SECOND_REENTRY_CHECKPOINT]: Object.freeze({
    taskElapsedMs: 0,
    entryOrdinal: 3,
    reentryCount: 2,
    trackTime: 0,
    mixingFrom: "chest_pound",
  }),
} satisfies Record<Pass55WheelChestCheckpoint, Pass55WheelChestExpectedState>);

export interface Pass55WheelChestCaptureDiagnostics {
  readonly checkpoint: Pass55WheelChestCheckpoint;
  readonly targetSpinElapsedMs: number;
  readonly sequence: number;
  readonly roundState: RoundPresentationState;
  readonly fastPlay: boolean;
  readonly reducedMotion: boolean;
  readonly task: Readonly<WheelChestPoundCaptureDiagnostics>;
  readonly bodyTrack: Readonly<CharacterTrackDiagnostic> | null;
  readonly tracks: readonly Readonly<CharacterTrackDiagnostic>[];
  readonly lifecycle: Readonly<CharacterIntroLifecycleDiagnostics>;
  readonly milestoneHistory: readonly string[];
  readonly visualFailureCount: number;
  readonly featureEvent: string | null;
  readonly totalWinMinor: string | null;
  readonly balanceMinor: string | null;
}

function isPass55WheelChestCheckpoint(
  checkpoint: string | null,
): checkpoint is Pass55WheelChestCheckpoint {
  return checkpoint !== null && Object.hasOwn(PASS55_WHEEL_CHEST_CHECKPOINT_MS, checkpoint);
}

/** 确切的 Pass55 路线。生产页面和每个别名/未遂事件都无法关闭。 */
export function isPass55WheelChestCapture(
  scenario: string,
  capture: string | null,
  checkpoint: string | null,
  run: string | null,
): checkpoint is Pass55WheelChestCheckpoint {
  return scenario === "wheel-mini-flow"
    && capture === "1"
    && isPass55WheelChestCheckpoint(checkpoint)
    && run === "pass55";
}

export function pass55WheelChestCheckpointElapsedMs(
  checkpoint: Pass55WheelChestCheckpoint,
): number {
  return PASS55_WHEEL_CHEST_CHECKPOINT_MS[checkpoint];
}

export function pass55WheelChestCaptureEnvironmentViolation(
  scenario: string,
  capture: string | null,
  checkpoint: string | null,
  run: string | null,
  reducedMotion: boolean,
  fastPlay: boolean,
): string | null {
  if (!isPass55WheelChestCapture(scenario, capture, checkpoint, run)) return null;
  if (reducedMotion) return "wheel-chest-reduced-motion-not-canonical";
  return fastPlay ? "wheel-chest-fast-play-not-canonical" : null;
}

function setPass55WheelChestViolation(
  dataset: VisualFixtureDataset,
  code: string,
): string {
  if (dataset.fixtureWheelChestViolation === undefined) {
    dataset.fixtureWheelChestViolation = code;
  }
  if (dataset.fixtureTraceViolation === undefined) dataset.fixtureTraceViolation = code;
  return dataset.fixtureWheelChestViolation;
}

function pass55NearlyEqual(actual: number | null | undefined, expected: number): boolean {
  return typeof actual === "number"
    && Number.isFinite(actual)
    && Math.abs(actual - expected) <= 0.000_001;
}

/** 发布一个不可变的、仅 Character 的 FEATURE_CHEST_LOOP 观察结果。 */
export function publishPass55WheelChestCheckpoint(
  dataset: VisualFixtureDataset,
  scenario: string,
  capture: string | null,
  requestedCheckpoint: string | null,
  run: string | null,
  diagnostics: Readonly<Pass55WheelChestCaptureDiagnostics>,
): string | null {
  if (!isPass55WheelChestCapture(
    scenario,
    capture,
    requestedCheckpoint,
    run,
  )) return null;

  // 证据是一次性写入的。第二个发布者调用绝不能删除或替换第一个接受的观察，即使其有效负载也是如此。
  if (dataset.fixtureWheelChestCheckpoint !== undefined
    || dataset.fixtureWheelChestContract !== undefined
    || dataset.fixtureWheelChestDiagnostics !== undefined) {
    return setPass55WheelChestViolation(dataset, "wheel-chest-duplicate-publish");
  }

  if (!Object.isFrozen(diagnostics)
    || !Object.isFrozen(diagnostics.task)
    || !Object.isFrozen(diagnostics.tracks)
    || diagnostics.tracks.some((track) => !Object.isFrozen(track))
    || !Object.isFrozen(diagnostics.lifecycle)
    || !Object.isFrozen(diagnostics.milestoneHistory)
    || (diagnostics.bodyTrack !== null && !Object.isFrozen(diagnostics.bodyTrack))) {
    return setPass55WheelChestViolation(dataset, "wheel-chest-diagnostics-mutable");
  }

  const expectedElapsedMs = pass55WheelChestCheckpointElapsedMs(requestedCheckpoint);
  const expected = PASS55_WHEEL_CHEST_EXPECTED_STATE[requestedCheckpoint];
  if (diagnostics.checkpoint !== requestedCheckpoint
    || !pass55NearlyEqual(diagnostics.targetSpinElapsedMs, expectedElapsedMs)
    || diagnostics.sequence !== 1
    || diagnostics.roundState !== "presenting") {
    return setPass55WheelChestViolation(dataset, "wheel-chest-clock-contract");
  }
  if (diagnostics.tracks.length !== 5
    || diagnostics.tracks.some((track, index) => track.track !== index)
    || diagnostics.task.tracks !== diagnostics.tracks
    || diagnostics.bodyTrack !== diagnostics.tracks[1]) {
    return setPass55WheelChestViolation(dataset, "wheel-chest-track-set-contract");
  }
  if (!diagnostics.lifecycle.capturePaused
    || diagnostics.lifecycle.introActive
    || !diagnostics.lifecycle.bodyReleased
    || diagnostics.lifecycle.timelineControlled
    || diagnostics.lifecycle.idleSchedulerActive) {
    return setPass55WheelChestViolation(dataset, "wheel-chest-lifecycle-contract");
  }

  const task = diagnostics.task;
  if (task.schedulerFps !== 30
    || task.flooredTaskMs !== 3_833
    || task.taskTicks !== 115
    || !pass55NearlyEqual(task.periodMs, 115_000 / 30)
    || !pass55NearlyEqual(task.targetSpinElapsedMs, expectedElapsedMs)
    || !pass55NearlyEqual(task.taskElapsedMs, expected.taskElapsedMs)
    || task.entryOrdinal !== expected.entryOrdinal
    || task.reentryCount !== expected.reentryCount
    || task.generation !== expected.entryOrdinal
    || !task.schedulerActive
    || !task.ownerIsCurrent
    || !task.nonBodyTrackIdentityPreserved) {
    return setPass55WheelChestViolation(dataset, "wheel-chest-task-contract");
  }

  const bodyTrack = diagnostics.bodyTrack;
  if (!bodyTrack
    || bodyTrack.animation !== "chest_pound"
    || !pass55NearlyEqual(bodyTrack.trackTime, expected.trackTime)
    || bodyTrack.mixingFrom !== expected.mixingFrom
    || !pass55NearlyEqual(bodyTrack.mixDuration, 0.15)) {
    return setPass55WheelChestViolation(dataset, "wheel-chest-body-contract");
  }

  const milestoneCount = (value: string): number => (
    diagnostics.milestoneHistory.filter((milestone) => milestone === value).length
  );
  if (diagnostics.milestoneHistory.length !== 3
    || diagnostics.milestoneHistory[0] !== "wheel.popup-input-ready"
    || diagnostics.milestoneHistory[1] !== "wheel.input-ready"
    || diagnostics.milestoneHistory[2] !== "wheel.spin-start"
    || milestoneCount("wheel.spin-start") !== 1) {
    return setPass55WheelChestViolation(dataset, "wheel-chest-milestone-contract");
  }
  if (diagnostics.fastPlay
    || diagnostics.reducedMotion
    || dataset.fixtureWheelChestFastPlay !== "false"
    || dataset.fixtureWheelChestReducedMotion !== "false") {
    return setPass55WheelChestViolation(dataset, "wheel-chest-environment-contract");
  }
  if (diagnostics.visualFailureCount !== 0
    || dataset.fixtureVisualFailureCount !== "0"
    || dataset.fixtureVisualFailureKind !== undefined) {
    return setPass55WheelChestViolation(dataset, "wheel-chest-visual-contract");
  }
  if (diagnostics.featureEvent !== "wheel.awarded"
    || diagnostics.totalWinMinor !== "1200"
    || diagnostics.balanceMinor !== "101100"
    || dataset.fixtureSequence !== "1") {
    return setPass55WheelChestViolation(dataset, "wheel-chest-award-contract");
  }
  if (dataset.fixtureWheelChestViolation !== undefined) {
    return dataset.fixtureWheelChestViolation;
  }

  dataset.fixtureWheelChestElapsedMs = String(diagnostics.targetSpinElapsedMs);
  dataset.fixtureWheelChestDiagnostics = JSON.stringify(diagnostics);
  dataset.fixtureWheelChestCheckpoint = requestedCheckpoint;
  dataset.fixtureWheelChestContract = "ok";
  return null;
}

export function clearPass55WheelChestCapture(dataset: VisualFixtureDataset): void {
  delete dataset.fixtureWheelChestCheckpoint;
  delete dataset.fixtureWheelChestElapsedMs;
  delete dataset.fixtureWheelChestDiagnostics;
  delete dataset.fixtureWheelChestContract;
  delete dataset.fixtureWheelChestReducedMotion;
  delete dataset.fixtureWheelChestFastPlay;
  delete dataset.fixtureWheelChestViolation;
}

export interface Pass49RecoveredGatewayFacts {
  readonly pendingAtSession: boolean;
  readonly pendingAtResult: boolean;
  readonly deliveredBeforeLaunch: boolean;
  readonly deliveryCount: number;
  /** 仅计算持久网关接受的、身份精确的 ACK。 */
  readonly gatewayAcknowledgementCount: number;
  readonly acknowledgementAttemptCount: number;
  readonly acknowledgementAcceptedCount: number;
  readonly userSpinRequestCount: number;
  readonly pending: boolean;
  readonly deliveredRoundId: string | null;
  readonly deliveredSequence: number | null;
  readonly originState: Readonly<FeatureState> | null;
  readonly finalState: Readonly<FeatureState> | null;
}

export interface Pass49RecoveredCaptureDiagnostics {
  readonly launchReady: boolean;
  readonly roundState: RoundPresentationState;
  readonly gateway: Readonly<Pass49RecoveredGatewayFacts>;
  readonly state: Readonly<FeatureState> | null;
  readonly tracks: readonly Readonly<CharacterTrackDiagnostic>[];
}

export type Pass49RecoveredCheckpoint =
  | "rage-collect.started"
  | "rgs-level-up.round-complete";

const PASS49_RECOVERED_ORIGIN_STATE = Object.freeze({
  mode: "BASE",
  freeSpinsRemaining: 0,
  freeSpinsPlayed: 0,
  rageLevel: 1,
  rageCollected: 11,
} as const satisfies FeatureState);

const PASS49_RECOVERED_FINAL_STATE = Object.freeze({
  mode: "BASE",
  freeSpinsRemaining: 0,
  freeSpinsPlayed: 0,
  rageLevel: 2,
  rageCollected: 12,
} as const satisfies FeatureState);

const PASS49_RECOVERED_RESULT_TRACK_NAMES = Object.freeze([
  null,
  "intro",
  null,
  null,
  null,
] as const);

function hasExactPass49State(
  state: Readonly<FeatureState> | null,
  expected: Readonly<FeatureState>,
): state is Readonly<FeatureState> {
  if (!state) return false;
  const keys = Object.keys(state).sort();
  return keys.length === 5
    && keys[0] === "freeSpinsPlayed"
    && keys[1] === "freeSpinsRemaining"
    && keys[2] === "mode"
    && keys[3] === "rageCollected"
    && keys[4] === "rageLevel"
    && state.mode === expected.mode
    && state.freeSpinsRemaining === expected.freeSpinsRemaining
    && state.freeSpinsPlayed === 0
    && expected.freeSpinsPlayed === 0
    && state.rageLevel === expected.rageLevel
    && state.rageCollected === expected.rageCollected;
}

function hasExactPass49Tracks(
  tracks: readonly Readonly<CharacterTrackDiagnostic>[],
  expected: readonly (string | null)[],
): boolean {
  return tracks.length === expected.length
    && tracks.every((entry, index) => (
      entry.track === index && entry.animation === expected[index]
    ));
}

/**
 * Rage 集合在后台生命周期运行时合法拥有 body/overlay 轨道 0/1。因此，EVOLVE 断言在独立预设的持久磁道 2/3 上保持准确，
 * 并将所有其他磁道记录为诊断，而不是重写实时字符。
 */
function hasExactPass49AuraTracks(
  tracks: readonly Readonly<CharacterTrackDiagnostic>[],
): boolean {
  return tracks.length === 5
    && tracks.every((entry, index) => entry.track === index)
    && tracks[2]?.animation === "aura_2"
    && tracks[3]?.animation === "particles_loop"
    && tracks[4]?.animation === null;
}

function hasExactPass49CollectionStartedTracks(
  tracks: readonly Readonly<CharacterTrackDiagnostic>[],
): boolean {
  return hasExactPass49AuraTracks(tracks)
    && tracks[0]?.animation === "rage_collect"
    && tracks[1]?.animation === "idle_breaker2";
}

function setPass49RecoveredViolation(
  dataset: VisualFixtureDataset,
  code: string,
): string {
  if (dataset.fixtureRgsRecoveredViolation === undefined) {
    dataset.fixtureRgsRecoveredViolation = code;
  }
  if (dataset.fixtureTraceViolation === undefined) {
    dataset.fixtureTraceViolation = code;
  }
  return dataset.fixtureRgsRecoveredViolation;
}

function projectPass49RecoveredGatewayFacts(
  dataset: VisualFixtureDataset,
  facts: Readonly<Pass49RecoveredGatewayFacts>,
): void {
  dataset.fixtureRgsRecoveredPendingAtSession = String(facts.pendingAtSession);
  dataset.fixtureRgsRecoveredPendingAtResult = String(facts.pendingAtResult);
  dataset.fixtureRgsRecoveredDeliveredBeforeLaunch = String(facts.deliveredBeforeLaunch);
  dataset.fixtureRgsRecoveredDeliveryCount = String(facts.deliveryCount);
  dataset.fixtureRgsRecoveredGatewayAckCount = String(facts.gatewayAcknowledgementCount);
  dataset.fixtureRgsRecoveredAckAttemptCount = String(facts.acknowledgementAttemptCount);
  dataset.fixtureRgsRecoveredAckAcceptedCount = String(facts.acknowledgementAcceptedCount);
  dataset.fixtureRgsRecoveredUserSpinCount = String(facts.userSpinRequestCount);
  dataset.fixtureRgsRecoveredPending = String(facts.pending);
  dataset.fixtureRgsRecoveredResultRoundId = facts.deliveredRoundId ?? "";
  dataset.fixtureRgsRecoveredResultSequence = facts.deliveredSequence === null
    ? ""
    : String(facts.deliveredSequence);
  dataset.fixtureRgsRecoveredOriginState = JSON.stringify(facts.originState);
  dataset.fixtureRgsRecoveredFinalState = JSON.stringify(facts.finalState);
}

function hasExactPass49RecoveredGatewayDelivery(
  facts: Readonly<Pass49RecoveredGatewayFacts>,
): boolean {
  return facts.pendingAtSession
    && facts.pendingAtResult
    && facts.deliveredBeforeLaunch
    && facts.deliveryCount === 1
    && facts.gatewayAcknowledgementCount === 0
    && facts.acknowledgementAttemptCount === 0
    && facts.acknowledgementAcceptedCount === 0
    && facts.userSpinRequestCount === 0
    && facts.pending
    && typeof facts.deliveredRoundId === "string"
    && facts.deliveredRoundId.length > 0
    && facts.deliveredSequence === 1
    && hasExactPass49State(facts.originState, PASS49_RECOVERED_ORIGIN_STATE)
    && hasExactPass49State(facts.finalState, PASS49_RECOVERED_FINAL_STATE);
}

function hasNoPass49VisualFailure(dataset: VisualFixtureDataset): boolean {
  return dataset.fixtureVisualFailureCount === "0"
    && dataset.fixtureVisualFailureKind === undefined
    && (dataset.fixtureVisualMissingRequired ?? "") === "";
}

export function isPass49RecoveredLevelUpCapture(
  scenario: string,
  capture: string | null,
): boolean {
  return scenario === BASE_RGS_RECOVERED_LEVEL_UP_SCENARIO && capture === "1";
}

/** 记录宏表现生命周期并拒绝重复或跳过。 */
export function applyPass49RecoveredRoundPresentationState(
  dataset: VisualFixtureDataset,
  scenario: string,
  capture: string | null,
  state: RoundPresentationState,
): string | null {
  if (!isPass49RecoveredLevelUpCapture(scenario, capture)) return null;
  const history = dataset.fixtureRgsRecoveredPresentationStateHistory
    ? dataset.fixtureRgsRecoveredPresentationStateHistory.split(",")
    : [];
  const expected = ["requested", "presenting", "complete"] as const;
  if (state !== expected[history.length]) {
    return setPass49RecoveredViolation(dataset, "rgs-recovered-presentation-state-order");
  }
  history.push(state);
  dataset.fixtureRgsRecoveredPresentationStateHistory = history.join(",");
  if (state === "complete") {
    dataset.fixtureRgsRecoveredPresentationCompleteCount = String(
      parseProjectionCount(dataset.fixtureRgsRecoveredPresentationCompleteCount) + 1,
    );
  }
  return null;
}

/** 在持久重播期间，任何控制器发起的旋转请求都是无效的。 */
export function applyPass49RecoveredUserSpinRequest(
  dataset: VisualFixtureDataset,
  scenario: string,
  capture: string | null,
  count: number,
): string | null {
  if (!isPass49RecoveredLevelUpCapture(scenario, capture)) return null;
  dataset.fixtureRgsRecoveredUserSpinCount = String(count);
  return count === 0
    ? null
    : setPass49RecoveredViolation(dataset, "rgs-recovered-user-spin-request");
}

/** 在 result.accepted 捕获准确的预表现持久交付。 */
export function publishPass49RecoveredResultAccepted(
  dataset: VisualFixtureDataset,
  scenario: string,
  capture: string | null,
  diagnostics: Readonly<Pass49RecoveredCaptureDiagnostics>,
): string | null {
  if (!isPass49RecoveredLevelUpCapture(scenario, capture)) return null;
  projectPass49RecoveredGatewayFacts(dataset, diagnostics.gateway);
  dataset.fixtureRgsRecoveredResultTracks = JSON.stringify(diagnostics.tracks);

  if (!diagnostics.launchReady || diagnostics.roundState !== "requested") {
    return setPass49RecoveredViolation(dataset, "rgs-recovered-result-not-presenting");
  }
  if (!hasExactPass49RecoveredGatewayDelivery(diagnostics.gateway)) {
    return setPass49RecoveredViolation(dataset, "rgs-recovered-delivery-contract");
  }
  if (dataset.fixtureRgsRecoveredAcceptedCount !== "1"
    || dataset.fixtureRgsRecoveredFeatureEventCount !== "0") {
    return setPass49RecoveredViolation(dataset, "rgs-recovered-result-count");
  }
  if (!hasExactPass49State(diagnostics.state, PASS49_RECOVERED_FINAL_STATE)) {
    return setPass49RecoveredViolation(dataset, "rgs-recovered-result-state");
  }
  if (!hasExactPass49Tracks(diagnostics.tracks, PASS49_RECOVERED_RESULT_TRACK_NAMES)) {
    return setPass49RecoveredViolation(dataset, "rgs-recovered-result-tracks");
  }
  if (!hasNoPass49VisualFailure(dataset)) {
    return setPass49RecoveredViolation(dataset, "rgs-recovered-visual-failure");
  }
  dataset.fixtureRgsRecoveredResultAccepted = "true";
  return dataset.fixtureRgsRecoveredViolation ?? null;
}

/** ACK只有在结果、EVOLVE事件和集合START接口后才有效。 */
export function applyPass49RecoveredAcknowledgement(
  dataset: VisualFixtureDataset,
  scenario: string,
  capture: string | null,
  diagnostics: Readonly<Pass49RecoveredCaptureDiagnostics>,
  roundId: string,
  sequence: number,
  accepted: boolean,
): string | null {
  if (!isPass49RecoveredLevelUpCapture(scenario, capture)) return null;
  projectPass49RecoveredGatewayFacts(dataset, diagnostics.gateway);
  dataset.fixtureRgsRecoveredAckRoundId = roundId;
  dataset.fixtureRgsRecoveredAckSequence = String(sequence);

  const facts = diagnostics.gateway;
  if (!accepted
    || roundId !== facts.deliveredRoundId
    || sequence !== facts.deliveredSequence
    || facts.acknowledgementAttemptCount !== 1
    || facts.acknowledgementAcceptedCount !== 1
    || facts.gatewayAcknowledgementCount !== 1
    || facts.pending
    || facts.userSpinRequestCount !== 0) {
    return setPass49RecoveredViolation(dataset, "rgs-recovered-ack-contract");
  }
  if (diagnostics.roundState !== "presenting"
    || dataset.fixtureRgsRecoveredResultAccepted !== "true"
    || dataset.fixtureRgsRecoveredFeatureEventCount !== "1"
    || dataset.fixtureRageCollectStartedCount !== "1"
    || dataset.fixtureStage !== "balance.committed"
    || dataset.fixtureRgsRecoveredPresentationCompleteCount !== undefined) {
    return setPass49RecoveredViolation(dataset, "rgs-recovered-early-ack");
  }
  dataset.fixtureRgsRecoveredAckExact = "true";
  return dataset.fixtureRgsRecoveredViolation ?? null;
}

export function validatePass49RecoveredSemanticCheckpoint(
  dataset: VisualFixtureDataset,
  scenario: string,
  capture: string | null,
  checkpoint: string,
  diagnostics: Readonly<Pass49RecoveredCaptureDiagnostics>,
): string | null {
  if (!isPass49RecoveredLevelUpCapture(scenario, capture)) return null;
  if (checkpoint !== "rage-collect.started") {
    return setPass49RecoveredViolation(dataset, "rgs-recovered-checkpoint-not-allowed");
  }
  projectPass49RecoveredGatewayFacts(dataset, diagnostics.gateway);
  dataset.fixtureRgsRecoveredTracks = JSON.stringify(diagnostics.tracks);
  if (diagnostics.roundState !== "presenting"
    || dataset.fixtureRgsRecoveredResultAccepted !== "true"
    || dataset.fixtureRgsRecoveredFeatureEventHistory !== "surge.collected"
    || dataset.fixtureRgsRecoveredFeatureEventCount !== "1"
    || dataset.fixtureRageCollectTraceHistory !== "started"
    || dataset.fixtureRageCollectStartedCount !== "1") {
    return setPass49RecoveredViolation(dataset, "rgs-recovered-start-order");
  }
  if (!hasExactPass49State(diagnostics.state, PASS49_RECOVERED_FINAL_STATE)) {
    return setPass49RecoveredViolation(dataset, "rgs-recovered-start-state");
  }
  if (!hasExactPass49CollectionStartedTracks(diagnostics.tracks)) {
    return setPass49RecoveredViolation(dataset, "rgs-recovered-start-tracks");
  }
  if (!hasNoPass49VisualFailure(dataset)) {
    return setPass49RecoveredViolation(dataset, "rgs-recovered-visual-failure");
  }
  dataset.fixtureRgsRecoveredCheckpoint = checkpoint;
  return dataset.fixtureRgsRecoveredViolation ?? null;
}

export function publishPass49RecoveredRoundComplete(
  dataset: VisualFixtureDataset,
  scenario: string,
  capture: string | null,
  diagnostics: Readonly<Pass49RecoveredCaptureDiagnostics>,
): string | null {
  if (!isPass49RecoveredLevelUpCapture(scenario, capture)) return null;
  projectPass49RecoveredGatewayFacts(dataset, diagnostics.gateway);
  dataset.fixtureRgsRecoveredTracks = JSON.stringify(diagnostics.tracks);
  const facts = diagnostics.gateway;
  if (!diagnostics.launchReady
    || diagnostics.roundState !== "complete"
    || dataset.fixtureRgsRecoveredPresentationStateHistory !== "requested,presenting,complete"
    || dataset.fixtureRgsRecoveredPresentationCompleteCount !== "1"
    || dataset.fixtureRgsRecoveredAcceptedCount !== "1"
    || dataset.fixtureCompleteCount !== "1"
    || dataset.fixtureRgsRecoveredFeatureEventCount !== "1"
    || dataset.fixtureRgsRecoveredAckExact !== "true"
    || facts.deliveryCount !== 1
    || facts.acknowledgementAttemptCount !== 1
    || facts.acknowledgementAcceptedCount !== 1
    || facts.gatewayAcknowledgementCount !== 1
    || facts.userSpinRequestCount !== 0
    || facts.pending) {
    return setPass49RecoveredViolation(dataset, "rgs-recovered-round-incomplete");
  }
  if (!hasExactPass49State(diagnostics.state, PASS49_RECOVERED_FINAL_STATE)) {
    return setPass49RecoveredViolation(dataset, "rgs-recovered-final-state");
  }
  if (!hasExactPass49AuraTracks(diagnostics.tracks)) {
    return setPass49RecoveredViolation(dataset, "rgs-recovered-final-tracks");
  }
  if (!hasNoPass49VisualFailure(dataset)) {
    return setPass49RecoveredViolation(dataset, "rgs-recovered-visual-failure");
  }
  if (dataset.fixtureRgsRecoveredViolation !== undefined
    || dataset.fixtureRageCollectViolation !== undefined
    || dataset.fixtureTraceViolation !== undefined) {
    return dataset.fixtureRgsRecoveredViolation
      ?? dataset.fixtureRageCollectViolation
      ?? dataset.fixtureTraceViolation
      ?? "rgs-recovered-violation";
  }
  dataset.fixtureRgsRecoveredCheckpoint = "rgs-level-up.round-complete";
  dataset.fixtureRgsRecoveredRoundComplete = "true";
  return null;
}

function parseProjectionCount(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function incrementProjectionCount(
  dataset: VisualFixtureDataset,
  key: string,
): number {
  const count = parseProjectionCount(dataset[key]) + 1;
  dataset[key] = String(count);
  return count;
}

function normalWinContinueHistoryCount(
  dataset: VisualFixtureDataset,
  phase: string,
): number {
  const expected = `1:0:${phase}`;
  return dataset.fixtureTraceHistory?.split(",").filter((entry) => entry === expected).length ?? 0;
}

function setNormalWinContinueViolation(
  dataset: VisualFixtureDataset,
  code: string,
): true {
  dataset.fixtureTraceViolation = code;
  return true;
}

function initializeNormalWinContinueProjection(dataset: VisualFixtureDataset): void {
  dataset.fixtureContinueClickCount = "0";
  dataset.fixtureContinueAcceptedCount = "0";
  dataset.fixtureContinueRecord1Seen = "false";
  dataset.fixtureContinueLogicalDoneCount = "0";
  dataset.fixtureContinueVisualHiddenCount = "0";
}

interface WildRevealFixtureTrace {
  readonly type: "wild-reveal.pre" | "wild-reveal.complete";
  readonly sequence: number;
  readonly cells: readonly Readonly<{
    reel: number;
    row: number;
    multiplier: number;
  }>[];
  readonly outroMs: number;
}

function asWildRevealFixtureTrace(
  trace: AppPresentationTrace,
): WildRevealFixtureTrace | null {
  const type = String(trace.type);
  if (type !== "wild-reveal.pre" && type !== "wild-reveal.complete") return null;
  return trace as unknown as WildRevealFixtureTrace;
}

function initializeWildRevealProjection(dataset: VisualFixtureDataset): void {
  dataset.fixtureWildRevealPreCount = "0";
  dataset.fixtureWildRevealCompleteCount = "0";
  dataset.fixtureWildRevealTraceHistory = "";
}

function setWildRevealViolation(
  dataset: VisualFixtureDataset,
  code: string,
): true {
  dataset.fixtureWildRevealViolation = code;
  dataset.fixtureTraceViolation = code;
  return true;
}

function hasExactWildRevealContract(trace: WildRevealFixtureTrace): boolean {
  const [onlyCell] = trace.cells;
  return trace.sequence === 1
    && trace.outroMs === BASE_WILD_REVEAL_OUTRO_MS
    && trace.cells.length === 1
    && onlyCell?.reel === 1
    && onlyCell.row === 1
    && onlyCell.multiplier === BASE_WILD_REVEAL_MULTIPLIER;
}

function applyWildRevealTrace(
  dataset: VisualFixtureDataset,
  trace: WildRevealFixtureTrace,
): boolean {
  dataset.fixtureStage = trace.type;
  if (!hasExactWildRevealContract(trace)) {
    return setWildRevealViolation(dataset, "wild-reveal-trace-contract");
  }

  const preCount = parseProjectionCount(dataset.fixtureWildRevealPreCount);
  const completeCount = parseProjectionCount(dataset.fixtureWildRevealCompleteCount);
  const history = dataset.fixtureWildRevealTraceHistory ?? "";
  if (trace.type === "wild-reveal.pre") {
    if (preCount !== 0 || completeCount !== 0 || history !== "") {
      return setWildRevealViolation(dataset, "wild-reveal-pre-order");
    }
    dataset.fixtureWildRevealPreCount = "1";
    dataset.fixtureWildRevealTraceHistory = "pre";
  } else {
    if (preCount !== 1 || completeCount !== 0 || history !== "pre") {
      return setWildRevealViolation(dataset, "wild-reveal-complete-order");
    }
    dataset.fixtureWildRevealCompleteCount = "1";
    dataset.fixtureWildRevealTraceHistory = "pre,complete";
  }
  dataset.fixtureWildRevealPhase = trace.type.slice("wild-reveal.".length);
  dataset.fixtureWildRevealCell = BASE_WILD_REVEAL_CELL;
  dataset.fixtureWildRevealMultiplier = String(BASE_WILD_REVEAL_MULTIPLIER);
  dataset.fixtureWildRevealOutroMs = String(BASE_WILD_REVEAL_OUTRO_MS);
  return false;
}

interface RageCollectionFixtureTrace {
  readonly type:
    | "rage-collect.started"
    | "rage-collect.absorbing"
    | "rage-collect.source-hidden"
    | "rage-collect.complete";
  readonly sequence: number;
  readonly cells: readonly Readonly<{ reel: number; row: number }>[];
  readonly count: number;
  readonly triggered: boolean;
  readonly guaranteed: boolean;
  readonly level: number;
  readonly total: number;
  readonly elapsedMs: number;
  readonly authoredAtMs: number;
  readonly reducedMotion: boolean;
  readonly activated: boolean;
  readonly hidden: boolean;
  readonly towerReactionStarted: boolean;
  readonly bodyClip: string | null;
  readonly characterStarted: boolean;
}

function asRageCollectionFixtureTrace(
  trace: AppPresentationTrace,
): RageCollectionFixtureTrace | null {
  return trace.type === "rage-collect.started"
    || trace.type === "rage-collect.absorbing"
    || trace.type === "rage-collect.source-hidden"
    || trace.type === "rage-collect.complete"
    ? trace as RageCollectionFixtureTrace
    : null;
}

function initializeRageCollectionProjection(dataset: VisualFixtureDataset): void {
  dataset.fixtureRageCollectStartedCount = "0";
  dataset.fixtureRageCollectAbsorbingCount = "0";
  dataset.fixtureRageCollectSourceHiddenCount = "0";
  dataset.fixtureRageCollectCompleteCount = "0";
  dataset.fixtureRageCollectTraceHistory = "";
}

function setRageCollectionViolation(
  dataset: VisualFixtureDataset,
  code: string,
): true {
  dataset.fixtureRageCollectViolation = code;
  dataset.fixtureTraceViolation = code;
  return true;
}

function setPass45Violation(
  dataset: VisualFixtureDataset,
  code: string,
): true {
  dataset.fixturePass45Violation = code;
  dataset.fixtureTraceViolation = code;
  return true;
}

function initializePass45Projection(dataset: VisualFixtureDataset): void {
  dataset.fixturePass45EventHistory = "";
  dataset.fixturePass45EventCount = "0";
}

function hasPass45RageCells(cells: readonly Readonly<{ reel: number; row: number }>[]): boolean {
  return cells.length === 3
    && cells[0]?.reel === 0 && cells[0].row === 1
    && cells[1]?.reel === 1 && cells[1].row === 0
    && cells[2]?.reel === 2 && cells[2].row === 2;
}

function applyPass45FeatureEvent(
  dataset: VisualFixtureDataset,
  event: Readonly<FeatureEvent>,
): boolean {
  const history = dataset.fixturePass45EventHistory
    ? dataset.fixturePass45EventHistory.split(",")
    : [];
  const expected = [
    "vaults.landed",
    "vaults.locked",
    "surge.collected",
    "wheel.started",
    "wheel.awarded",
  ] as const;
  if (event.type !== expected[history.length]) {
    return setPass45Violation(dataset, "pass45-feature-event-order");
  }

  if (event.type === "vaults.landed" || event.type === "vaults.locked") {
    const [onlyCell] = event.cells;
    if (event.count !== 1
      || event.cells.length !== 1
      || onlyCell?.reel !== 1
      || onlyCell.row !== 2) {
      return setPass45Violation(dataset, "pass45-locked-vault-contract");
    }
  } else if (event.type === "surge.collected") {
    if (event.count !== 3
      || !hasPass45RageCells(event.cells)
      || !event.triggered
      || !event.guaranteed
      || event.level !== 1
      || event.total !== 0) {
      return setPass45Violation(dataset, "pass45-three-rage-contract");
    }
  } else if (event.type === "wheel.awarded") {
    if (event.outcome !== "INSTANT"
      || event.prize !== "MINI"
      || event.multiplier !== 10
      || event.amountMinor !== "1000") {
      return setPass45Violation(dataset, "pass45-wheel-award-contract");
    }
  }

  history.push(event.type);
  dataset.fixturePass45EventHistory = history.join(",");
  dataset.fixturePass45EventCount = String(history.length);
  return false;
}

export function isPass45ForbiddenVisualTelemetryEvent(
  scenario: string,
  event: Readonly<VisualTelemetryEvent>,
): boolean {
  return scenario === BASE_THREE_RAGE_WHEEL_ENTRY_SCENARIO
    && event.kind === "start"
    && event.id === "rage.cascade";
}

export function isPass45ForbiddenPresentationMilestone(
  scenario: string,
  milestone: string | null,
): boolean {
  return scenario === BASE_THREE_RAGE_WHEEL_ENTRY_SCENARIO
    && milestone !== null
    && (milestone === "wheel.spin-start"
      || milestone === "wheel.quick-stop"
      || milestone === "wheel.spin-finish"
      || milestone === "wheel.summary-input-ready"
      || milestone === "wheel.summary-complete");
}

export function validatePass45SemanticCheckpoint(
  dataset: VisualFixtureDataset,
  scenario: string,
  checkpoint: string,
): string | null {
  if (scenario !== BASE_THREE_RAGE_WHEEL_ENTRY_SCENARIO) return null;
  if (checkpoint !== "wheel.popup-input-ready" && checkpoint !== "wheel.input-ready") {
    return "pass45-checkpoint-not-allowed";
  }
  if (dataset.fixtureSequence !== "1"
    || dataset.fixtureTotalWinMinor !== "1000"
    || dataset.fixtureBalanceMinor !== "100900") {
    return "pass45-result-not-projected";
  }
  if (dataset.fixturePass45EventHistory
      !== "vaults.landed,vaults.locked,surge.collected,wheel.started,wheel.awarded"
    || dataset.fixturePass45EventCount !== "5") {
    return "pass45-feature-events-incomplete";
  }
  if (dataset.fixturePass45Violation || dataset.fixtureTraceViolation) {
    return dataset.fixturePass45Violation ?? dataset.fixtureTraceViolation ?? "pass45-violation";
  }
  dataset.fixturePass45Checkpoint = checkpoint;
  return null;
}

const PASS47_SOURCE_CELL = Object.freeze({ reel: 0, row: 1 });
const PASS47_TRANSFORM_CELLS = Object.freeze([
  Object.freeze({ reel: 1, row: 1 }),
  Object.freeze({ reel: 2, row: 1 }),
] as const);
const PASS47_EVENT_ORDER = Object.freeze([
  "surge.collected",
  "rage.transformed",
  "wheel.started",
  "wheel.awarded",
] as const);
const PASS47_CASCADE_PHASE_ORDER = Object.freeze([
  "started",
  "exploding",
  "placed",
  "pound",
  "activation",
  "source-hidden",
  "complete",
] as const);
type Pass47CascadePhase = typeof PASS47_CASCADE_PHASE_ORDER[number];

const PASS47_PHASE_COUNT_KEY: Readonly<Record<Pass47CascadePhase, string>> = Object.freeze({
  started: "fixtureRageCascadeStartedCount",
  exploding: "fixtureRageCascadeExplodingCount",
  placed: "fixtureRageCascadePlacedCount",
  pound: "fixtureRageCascadePoundCount",
  activation: "fixtureRageCascadeActivationCount",
  "source-hidden": "fixtureRageCascadeSourceHiddenCount",
  complete: "fixtureRageCascadeCompleteCount",
});

interface RageCascadeFixtureShuffledCell {
  readonly orderIndex: number;
  readonly cellIndex: number;
  readonly address: Readonly<{ reel: number; row: number }>;
  readonly transformsToRage: boolean;
  readonly authoredAtMs: number;
  readonly elapsedMs: number;
}

interface RageCascadeFixtureTrace {
  readonly type: `rage-cascade.${Pass47CascadePhase}`;
  readonly sequence: number;
  readonly authoredAtMs: number;
  readonly elapsedMs: number;
  readonly reducedMotion: boolean;
  readonly transformedCells: readonly Readonly<{ reel: number; row: number }>[];
  readonly shuffledCells: readonly Readonly<RageCascadeFixtureShuffledCell>[];
  readonly activationAttempted: number;
  readonly activationPlayed: number;
  readonly shakePhase: "respin" | "pound" | null;
  readonly shakeAuthoredAtMs: number | null;
  readonly shakeElapsedMs: number | null;
  readonly hidden: boolean;
}

function asRageCascadeFixtureTrace(
  trace: AppPresentationTrace,
): RageCascadeFixtureTrace | null {
  const type = String(trace.type);
  return type === "rage-cascade.started"
    || type === "rage-cascade.exploding"
    || type === "rage-cascade.placed"
    || type === "rage-cascade.pound"
    || type === "rage-cascade.activation"
    || type === "rage-cascade.source-hidden"
    || type === "rage-cascade.complete"
    ? trace as unknown as RageCascadeFixtureTrace
    : null;
}

function setPass47Violation(
  dataset: VisualFixtureDataset,
  code: string,
): true {
  dataset.fixtureRageCascadeViolation = code;
  dataset.fixtureTraceViolation = code;
  return true;
}

function initializePass47Projection(dataset: VisualFixtureDataset): void {
  dataset.fixtureRageCascadeTraceHistory = "";
  dataset.fixtureRageCascadeEventHistory = "";
  dataset.fixtureRageCascadeEventCount = "0";
  dataset.fixtureRageCascadeTraversalHistory = "";
  dataset.fixtureRageCascadeTraversalCount = "0";
  dataset.fixtureRageCascadeShakeHistory = "";
  dataset.fixtureRageCascadeShakeAuthoredHistory = "";
  dataset.fixtureRageCascadeShakeCount = "0";
  dataset.fixtureRageCascadeWheelMilestones = "";
  dataset.fixtureRageCascadeWheelMilestoneCount = "0";
  dataset.fixtureRageCascadeVisualStartedCount = "0";
  for (const phase of PASS47_CASCADE_PHASE_ORDER) {
    dataset[PASS47_PHASE_COUNT_KEY[phase]] = "0";
  }
}

function hasPass47TransformCells(
  cells: readonly Readonly<{ reel: number; row: number }>[],
): boolean {
  return Array.isArray(cells)
    && cells.length === PASS47_TRANSFORM_CELLS.length
    && cells.every((cell, index) => cell.reel === PASS47_TRANSFORM_CELLS[index]?.reel
      && cell.row === PASS47_TRANSFORM_CELLS[index]?.row);
}

function appendPass47Event(
  dataset: VisualFixtureDataset,
  event: Readonly<FeatureEvent>,
): boolean {
  const count = parseProjectionCount(dataset.fixtureRageCascadeEventCount);
  if (event.type !== PASS47_EVENT_ORDER[count]) {
    return setPass47Violation(dataset, "rage-cascade-feature-event-order");
  }

  if (event.type === "surge.collected") {
    const [source] = event.cells;
    if (event.count !== 1 || event.cells.length !== 1
      || source?.reel !== PASS47_SOURCE_CELL.reel || source.row !== PASS47_SOURCE_CELL.row
      || event.triggered !== true || event.guaranteed !== false
      || event.level !== 1 || event.total !== 0) {
      return setPass47Violation(dataset, "rage-cascade-source-contract");
    }
    dataset.fixtureRageCascadeSourceCell = `${source.reel}:${source.row}`;
    dataset.fixtureRageCascadeSourceCount = String(event.count);
    dataset.fixtureRageCascadeTriggered = String(event.triggered);
    dataset.fixtureRageCascadeGuaranteed = String(event.guaranteed);
    dataset.fixtureRageCascadeLevel = String(event.level);
    dataset.fixtureRageCascadeTotal = String(event.total);
  } else if (event.type === "rage.transformed") {
    if (event.count !== 2 || !hasPass47TransformCells(event.cells)
      || event.level !== 1 || event.total !== 0) {
      return setPass47Violation(dataset, "rage-cascade-transform-contract");
    }
    dataset.fixtureRageCascadeTransformCells = event.cells
      .map(({ reel, row }) => `${reel}:${row}`)
      .join(",");
    dataset.fixtureRageCascadeTransformCount = String(event.count);
  } else if (event.type === "wheel.started") {
    if (dataset.fixtureRageCascadeCompleteCount !== "1"
      || dataset.fixtureRageCascadeTraceHistory !== PASS47_CASCADE_PHASE_ORDER.join(",")) {
      return setPass47Violation(dataset, "rage-cascade-wheel-before-complete");
    }
  } else if (event.type === "wheel.awarded") {
    if (event.outcome !== "INSTANT" || event.prize !== "MINI"
      || event.multiplier !== 10 || event.amountMinor !== "1000") {
      return setPass47Violation(dataset, "rage-cascade-wheel-award-contract");
    }
  } else {
    return setPass47Violation(dataset, "rage-cascade-unexpected-feature-event");
  }

  dataset.fixtureRageCascadeEventHistory = dataset.fixtureRageCascadeEventHistory
    ? `${dataset.fixtureRageCascadeEventHistory},${event.type}`
    : event.type;
  dataset.fixtureRageCascadeEventCount = String(count + 1);
  return false;
}

function pass47TraceAuthoredAtMs(trace: RageCascadeFixtureTrace): number | null {
  const phase = trace.type.slice("rage-cascade.".length) as Pass47CascadePhase;
  return {
    started: 0,
    exploding: 390,
    placed: 930,
    pound: 1_430,
    activation: 1_820,
    "source-hidden": 3_986.7,
    complete: 4_120,
  }[phase] ?? null;
}

function hasExactPass47CascadeTraceContract(trace: RageCascadeFixtureTrace): boolean {
  const phase = trace.type.slice("rage-cascade.".length) as Pass47CascadePhase;
  const authoredAtMs = pass47TraceAuthoredAtMs(trace);
  const activated = phase === "activation" || phase === "source-hidden" || phase === "complete";
  const hidden = phase === "source-hidden" || phase === "complete";
  const exploding = phase === "exploding";
  const activation = phase === "activation";
  if (!PASS47_CASCADE_PHASE_ORDER.includes(phase)
    || trace.sequence !== 1
    || !Array.isArray(trace.transformedCells)
    || !Array.isArray(trace.shuffledCells)
    || !hasPass47TransformCells(trace.transformedCells)
    || !Number.isFinite(trace.elapsedMs) || trace.elapsedMs !== trace.authoredAtMs
    || authoredAtMs === null || trace.authoredAtMs !== authoredAtMs
    || trace.reducedMotion !== false
    || trace.activationAttempted !== (activated ? 3 : 0)
    || trace.activationPlayed !== (activated ? 3 : 0)
    || trace.hidden !== hidden
    || trace.shuffledCells.length !== (exploding ? 9 : 0)
    || trace.shakePhase !== (exploding ? "respin" : activation ? "pound" : null)
    || trace.shakeAuthoredAtMs !== (exploding ? 400 : activation ? 1_930 : null)
    || trace.shakeElapsedMs !== (exploding ? 400 : activation ? 1_930 : null)) return false;

  const uniqueCells = new Set<number>();
  return trace.shuffledCells.every((shuffled, orderIndex) => {
    const expectedReel = Math.floor(shuffled.cellIndex / 3);
    const expectedRow = shuffled.cellIndex % 3;
    const transformsToRage = shuffled.cellIndex === 4 || shuffled.cellIndex === 7;
    const unique = !uniqueCells.has(shuffled.cellIndex);
    uniqueCells.add(shuffled.cellIndex);
    return unique
      && shuffled.orderIndex === orderIndex
      && Number.isSafeInteger(shuffled.cellIndex)
      && shuffled.cellIndex >= 0 && shuffled.cellIndex < 9
      && shuffled.address.reel === expectedReel
      && shuffled.address.row === expectedRow
      && shuffled.transformsToRage === transformsToRage
      && shuffled.authoredAtMs === 390 + orderIndex * 60
      && shuffled.elapsedMs === shuffled.authoredAtMs;
  });
}

function projectPass47CascadeTrace(
  dataset: VisualFixtureDataset,
  trace: RageCascadeFixtureTrace,
): void {
  const phase = trace.type.slice("rage-cascade.".length) as Pass47CascadePhase;
  dataset.fixtureStage = trace.type;
  dataset.fixtureRageCascadePhase = phase;
  dataset.fixtureRageCascadeTransformCells = trace.transformedCells
    .map(({ reel, row }) => `${reel}:${row}`)
    .join(",");
  dataset.fixtureRageCascadeAuthoredAtMs = String(trace.authoredAtMs);
  dataset.fixtureRageCascadeReducedMotion = String(trace.reducedMotion);
  dataset.fixtureRageCascadeHidden = String(trace.hidden);
  dataset.fixtureRageCascadeActivationAttempted = String(trace.activationAttempted);
  dataset.fixtureRageCascadeActivationPlayed = String(trace.activationPlayed);
  if (trace.shuffledCells.length > 0) {
    dataset.fixtureRageCascadeShuffledCells = trace.shuffledCells.map((shuffled) => {
      const { orderIndex, cellIndex, address, transformsToRage } = shuffled;
      return [orderIndex, cellIndex, address.reel, address.row, transformsToRage].join(":");
    }).join(",");
  }
}

function enterPass47CascadePhase(
  dataset: VisualFixtureDataset,
  phase: Pass47CascadePhase,
): boolean {
  const currentHistory = dataset.fixtureRageCascadeTraceHistory ?? "";
  const phaseIndex = PASS47_CASCADE_PHASE_ORDER.indexOf(phase);
  const previousHistory = PASS47_CASCADE_PHASE_ORDER.slice(0, phaseIndex).join(",");
  if (currentHistory !== previousHistory
    || parseProjectionCount(dataset[PASS47_PHASE_COUNT_KEY[phase]]) !== 0) {
    return setPass47Violation(dataset, `rage-cascade-${phase}-order`);
  }
  dataset[PASS47_PHASE_COUNT_KEY[phase]] = "1";
  dataset.fixtureRageCascadeTraceHistory = currentHistory
    ? `${currentHistory},${phase}`
    : phase;
  return false;
}

function applyPass47CascadeTrace(
  dataset: VisualFixtureDataset,
  trace: RageCascadeFixtureTrace,
): boolean {
  dataset.fixtureStage = trace.type;
  if (!hasExactPass47CascadeTraceContract(trace)) {
    return setPass47Violation(dataset, "rage-cascade-trace-contract");
  }
  projectPass47CascadeTrace(dataset, trace);
  if (dataset.fixtureRageCascadeEventHistory
      !== "surge.collected,rage.transformed"
    || dataset.fixtureRageCascadeEventCount !== "2"
    || dataset.fixtureRageCascadeSourceCell !== "0:1"
    || dataset.fixtureRageCascadeTransformCells !== "1:1,2:1") {
    return setPass47Violation(dataset, "rage-cascade-event-barrier");
  }

  const phase = trace.type.slice("rage-cascade.".length) as Pass47CascadePhase;
  if (enterPass47CascadePhase(dataset, phase)) return true;

  if (phase === "exploding") {
    dataset.fixtureRageCascadeTraversalHistory = trace.shuffledCells
      .map(({ cellIndex }) => cellIndex)
      .join(",");
    dataset.fixtureRageCascadeTraversalCount = String(trace.shuffledCells.length);
    dataset.fixtureRageCascadeShakeHistory = "respin";
    dataset.fixtureRageCascadeShakeAuthoredHistory = "respin:400";
    dataset.fixtureRageCascadeShakeCount = "1";
    return false;
  }

  if (phase === "placed"
    && (dataset.fixtureRageCascadeTraversalCount !== "9"
      || dataset.fixtureRageCascadeShakeHistory !== "respin")) {
    return setPass47Violation(dataset, "rage-cascade-placed-before-traversal");
  }
  if (phase === "activation") {
    if (dataset.fixtureRageCascadeShakeHistory !== "respin") {
      return setPass47Violation(dataset, "rage-cascade-pound-shake-order");
    }
    dataset.fixtureRageCascadeShakeHistory = "respin,pound";
    dataset.fixtureRageCascadeShakeAuthoredHistory = "respin:400,pound:1930";
    dataset.fixtureRageCascadeShakeCount = "2";
    return false;
  }

  if ((phase === "source-hidden" || phase === "complete")
    && (dataset.fixtureRageCascadeShakeHistory !== "respin,pound"
      || dataset.fixtureRageCascadeActivationAttempted !== "3"
      || dataset.fixtureRageCascadeActivationPlayed !== "3")) {
    return setPass47Violation(dataset, "rage-cascade-activation-incomplete");
  }
  if (phase === "complete" && dataset.fixtureRageCascadeHidden !== "true") {
    return setPass47Violation(dataset, "rage-cascade-overlay-not-hidden");
  }
  return false;
}

function validatePass47TerminalProjection(dataset: VisualFixtureDataset): string | null {
  if ((dataset.fixtureVisualFailureCount !== undefined
      && dataset.fixtureVisualFailureCount !== "0")
    || (dataset.fixtureVisualMissingRequired !== undefined
      && dataset.fixtureVisualMissingRequired !== "")) {
    return "rage-cascade-visual-assets";
  }
  if (dataset.fixtureRageCascadeVisualStartedCount !== "1") {
    return "rage-cascade-visual-start-count";
  }
  if (dataset.fixtureRageCascadeTraceHistory !== PASS47_CASCADE_PHASE_ORDER.join(",")) {
    return "rage-cascade-phases-incomplete";
  }
  if (PASS47_CASCADE_PHASE_ORDER.some(
    (phase) => dataset[PASS47_PHASE_COUNT_KEY[phase]] !== "1",
  )) return "rage-cascade-phase-count";
  if (dataset.fixtureRageCascadeTraversalCount !== "9"
    || new Set((dataset.fixtureRageCascadeTraversalHistory ?? "").split(",")).size !== 9) {
    return "rage-cascade-traversal-incomplete";
  }
  if (dataset.fixtureRageCascadeActivationAttempted !== "3"
    || dataset.fixtureRageCascadeActivationPlayed !== "3") {
    return "rage-cascade-activation-incomplete";
  }
  if (dataset.fixtureRageCascadeShakeHistory !== "respin,pound"
    || dataset.fixtureRageCascadeShakeAuthoredHistory !== "respin:400,pound:1930"
    || dataset.fixtureRageCascadeShakeCount !== "2") {
    return "rage-cascade-shakes-incomplete";
  }
  if (dataset.fixtureRageCascadeHidden !== "true") return "rage-cascade-overlay-not-hidden";
  return dataset.fixtureRageCascadeViolation ?? dataset.fixtureTraceViolation ?? null;
}

export function applyPass47VisualTelemetryEvent(
  dataset: VisualFixtureDataset,
  scenario: string,
  event: Readonly<VisualTelemetryEvent>,
): boolean {
  if (scenario !== BASE_ONE_RAGE_TRIGGER_TRANSFORM_SCENARIO || event.kind !== "start") {
    return false;
  }
  if (event.id === "rage.collect") {
    return setPass47Violation(dataset, "rage-cascade-unexpected-collect-or-tower");
  }
  if (event.id.startsWith("wheel.") && dataset.fixtureRageCascadeCompleteCount !== "1") {
    return setPass47Violation(dataset, "rage-cascade-wheel-before-complete");
  }
  if (event.id === "rage.cascade") {
    if (dataset.fixtureRageCascadeEventHistory
        !== "surge.collected,rage.transformed"
      || incrementProjectionCount(dataset, "fixtureRageCascadeVisualStartedCount") !== 1) {
      return setPass47Violation(dataset, "rage-cascade-visual-start-order");
    }
  }
  return false;
}

export function applyPass47PresentationMilestone(
  dataset: VisualFixtureDataset,
  scenario: string,
  milestone: string | null,
): boolean {
  if (scenario !== BASE_ONE_RAGE_TRIGGER_TRANSFORM_SCENARIO
    || milestone === null || !milestone.startsWith("wheel.")) return false;
  if (dataset.fixtureRageCascadeCompleteCount !== "1") {
    return setPass47Violation(dataset, "rage-cascade-wheel-before-complete");
  }
  dataset.fixtureRageCascadeWheelMilestones = dataset.fixtureRageCascadeWheelMilestones
    ? `${dataset.fixtureRageCascadeWheelMilestones},${milestone}`
    : milestone;
  dataset.fixtureRageCascadeWheelMilestoneCount = String(
    parseProjectionCount(dataset.fixtureRageCascadeWheelMilestoneCount) + 1,
  );
  return false;
}

export function validatePass47SemanticCheckpoint(
  dataset: VisualFixtureDataset,
  scenario: string,
  checkpoint: string,
): string | null {
  if (scenario !== BASE_ONE_RAGE_TRIGGER_TRANSFORM_SCENARIO) return null;
  if (!checkpoint.startsWith("rage-cascade.")) return "rage-cascade-checkpoint-not-allowed";
  const phase = checkpoint.slice("rage-cascade.".length) as Pass47CascadePhase;
  const phaseIndex = PASS47_CASCADE_PHASE_ORDER.indexOf(phase);
  if (phaseIndex < 0) return "rage-cascade-checkpoint-not-allowed";
  if (dataset.fixtureStage !== checkpoint
    || dataset.fixtureRageCascadeTraceHistory
      !== PASS47_CASCADE_PHASE_ORDER.slice(0, phaseIndex + 1).join(",")) {
    return "rage-cascade-checkpoint-order";
  }
  for (const [index, candidate] of PASS47_CASCADE_PHASE_ORDER.entries()) {
    const expectedCount = index <= phaseIndex ? "1" : "0";
    if (dataset[PASS47_PHASE_COUNT_KEY[candidate]] !== expectedCount) {
      return "rage-cascade-checkpoint-phase-count";
    }
  }
  if (dataset.fixtureRageCascadeSourceCell !== "0:1"
    || dataset.fixtureRageCascadeTransformCells !== "1:1,2:1"
    || dataset.fixtureRageCascadeSourceCount !== "1"
    || dataset.fixtureRageCascadeTransformCount !== "2"
    || dataset.fixtureRageCascadeTriggered !== "true"
    || dataset.fixtureRageCascadeGuaranteed !== "false"
    || dataset.fixtureRageCascadeLevel !== "1"
    || dataset.fixtureRageCascadeTotal !== "0") {
    return "rage-cascade-checkpoint-facts";
  }
  if (dataset.fixtureRageCascadeEventHistory
      !== "surge.collected,rage.transformed"
    || dataset.fixtureRageCascadeEventCount !== "2") {
    return "rage-cascade-checkpoint-event-order";
  }
  if (dataset.fixtureRageCascadeVisualStartedCount !== "1") {
    return "rage-cascade-checkpoint-visual-start";
  }
  if ((dataset.fixtureVisualFailureCount !== undefined
      && dataset.fixtureVisualFailureCount !== "0")
    || (dataset.fixtureVisualMissingRequired !== undefined
      && dataset.fixtureVisualMissingRequired !== "")) {
    return "rage-cascade-checkpoint-visual-assets";
  }
  if (phaseIndex === 0) {
    if (dataset.fixtureRageCascadeTraversalCount !== "0"
      || dataset.fixtureRageCascadeShakeCount !== "0") {
      return "rage-cascade-checkpoint-premature-cosmetic";
    }
  } else if (dataset.fixtureRageCascadeTraversalCount !== "9"
    || new Set((dataset.fixtureRageCascadeTraversalHistory ?? "").split(",")).size !== 9
    || (phaseIndex < 4 && dataset.fixtureRageCascadeShakeHistory !== "respin")) {
    return "rage-cascade-checkpoint-traversal";
  }
  if (phaseIndex < 4) {
    if (dataset.fixtureRageCascadeActivationAttempted !== "0"
      || dataset.fixtureRageCascadeActivationPlayed !== "0"
      || dataset.fixtureRageCascadeHidden !== "false") {
      return "rage-cascade-checkpoint-premature-activation";
    }
  } else if (dataset.fixtureRageCascadeActivationAttempted !== "3"
    || dataset.fixtureRageCascadeActivationPlayed !== "3"
    || dataset.fixtureRageCascadeShakeHistory !== "respin,pound") {
    return "rage-cascade-checkpoint-activation";
  }
  if (dataset.fixtureRageCascadeHidden !== String(phaseIndex >= 5)) {
    return "rage-cascade-checkpoint-hidden-state";
  }
  if (phase === "complete") {
    const terminal = validatePass47TerminalProjection(dataset);
    if (terminal) return terminal;
  }
  dataset.fixtureRageCascadeCheckpoint = checkpoint;
  return dataset.fixtureRageCascadeViolation ?? dataset.fixtureTraceViolation ?? null;
}

const RAGE_COLLECTION_EXPECTED_PHASE = Object.freeze({
  "rage-collect.started": Object.freeze({
    phase: "started",
    authoredAtMs: 0,
    activated: true,
    hidden: false,
    towerReactionStarted: false,
    previousHistory: "",
    countKey: "fixtureRageCollectStartedCount",
  }),
  "rage-collect.absorbing": Object.freeze({
    phase: "absorbing",
    authoredAtMs: 500,
    activated: true,
    hidden: false,
    towerReactionStarted: true,
    previousHistory: "started",
    countKey: "fixtureRageCollectAbsorbingCount",
  }),
  "rage-collect.source-hidden": Object.freeze({
    phase: "source-hidden",
    authoredAtMs: 1_016.7,
    activated: false,
    hidden: true,
    towerReactionStarted: true,
    previousHistory: "started,absorbing",
    countKey: "fixtureRageCollectSourceHiddenCount",
  }),
  "rage-collect.complete": Object.freeze({
    phase: "complete",
    authoredAtMs: 1_200,
    activated: false,
    hidden: true,
    towerReactionStarted: true,
    previousHistory: "started,absorbing,source-hidden",
    countKey: "fixtureRageCollectCompleteCount",
  }),
} as const);

interface RageCollectionFixtureContract {
  readonly cells: readonly Readonly<{ reel: number; row: number }>[];
  readonly count: number;
  readonly level: number;
  readonly total: number;
}

function rageCollectionFixtureContract(
  scenario: string,
): RageCollectionFixtureContract | null {
  if (scenario === BASE_SINGLE_RAGE_SCENARIO) {
    return Object.freeze({
      cells: Object.freeze([{ reel: 1, row: 0 }]),
      count: 1,
      level: 1,
      total: 1,
    });
  }
  if (scenario === BASE_TWO_RAGE_SCENARIO) {
    return Object.freeze({
      cells: Object.freeze([
        { reel: 0, row: 1 },
        { reel: 1, row: 1 },
      ]),
      count: 2,
      level: 1,
      total: 2,
    });
  }
  if (scenario === BASE_RGS_RECOVERED_LEVEL_UP_SCENARIO) {
    return Object.freeze({
      cells: Object.freeze([{ reel: 1, row: 0 }]),
      count: 1,
      level: 2,
      total: 12,
    });
  }
  return null;
}

function isRageCollectionFixtureScenario(scenario: string): boolean {
  return rageCollectionFixtureContract(scenario) !== null;
}

function hasExactRageCollectionContract(
  trace: RageCollectionFixtureTrace,
  scenario: string,
): boolean {
  const expected = RAGE_COLLECTION_EXPECTED_PHASE[trace.type];
  const contract = rageCollectionFixtureContract(scenario);
  return contract !== null
    && trace.sequence === 1
    && trace.cells.length === contract.cells.length
    && trace.cells.every((cell, index) => (
      cell.reel === contract.cells[index]?.reel
      && cell.row === contract.cells[index]?.row
    ))
    && trace.count === contract.count
    && trace.triggered === false
    && trace.guaranteed === false
    && trace.level === contract.level
    && trace.total === contract.total
    && Number.isFinite(trace.elapsedMs)
    && trace.elapsedMs >= 0
    && trace.authoredAtMs === expected.authoredAtMs
    && trace.reducedMotion === false
    && trace.activated === expected.activated
    && trace.hidden === expected.hidden
    && trace.towerReactionStarted === expected.towerReactionStarted
    && trace.bodyClip === "idle_breaker2"
    && trace.characterStarted === true;
}

function applyRageCollectionTrace(
  dataset: VisualFixtureDataset,
  trace: RageCollectionFixtureTrace,
  scenario: string,
): boolean {
  dataset.fixtureStage = trace.type;
  if (!hasExactRageCollectionContract(trace, scenario)) {
    return setRageCollectionViolation(dataset, "rage-collect-trace-contract");
  }
  const expected = RAGE_COLLECTION_EXPECTED_PHASE[trace.type];
  const history = dataset.fixtureRageCollectTraceHistory ?? "";
  if (history !== expected.previousHistory
    || parseProjectionCount(dataset[expected.countKey]) !== 0) {
    return setRageCollectionViolation(dataset, `rage-collect-${expected.phase}-order`);
  }

  dataset[expected.countKey] = "1";
  dataset.fixtureRageCollectTraceHistory = history
    ? `${history},${expected.phase}`
    : expected.phase;
  dataset.fixtureRageCollectPhase = expected.phase;
  dataset.fixtureRageCollectCell = trace.cells
    .map((cell) => `${cell.reel}:${cell.row}`)
    .join(",");
  dataset.fixtureRageCollectCount = String(trace.count);
  dataset.fixtureRageCollectTriggered = String(trace.triggered);
  dataset.fixtureRageCollectGuaranteed = String(trace.guaranteed);
  dataset.fixtureRageCollectLevel = String(trace.level);
  dataset.fixtureRageCollectTotal = String(trace.total);
  dataset.fixtureRageCollectBodyClip = trace.bodyClip ?? "";
  dataset.fixtureRageCollectCharacterStarted = String(trace.characterStarted);
  dataset.fixtureRageCollectActivated = String(trace.activated);
  dataset.fixtureRageCollectHidden = String(trace.hidden);
  dataset.fixtureRageCollectTowerStarted = String(trace.towerReactionStarted);
  dataset.fixtureRageCollectAuthoredAtMs = String(trace.authoredAtMs);
  return false;
}

export interface VisualFixtureSpinControlSnapshot {
  readonly mode: string | null;
  readonly action: string | null;
  readonly disabled: boolean;
}

/** 精确的仅浏览器触发；生产代码从不导入测试场景策略。 */
export function isNormalWinContinueClickTrigger(
  scenario: string,
  capture: string | null,
  trace: AppPresentationTrace,
): boolean {
  return scenario === NORMAL_WIN_CONTINUE_SCENARIO
    && capture === "1"
    && trace.type === "win-record.merge-start"
    && trace.sequence === 1
    && trace.index === 0
    && trace.count === 2
    && trace.id === NORMAL_WIN_CONTINUE_RECORD_IDS[0];
}

/**
 * 项目证明，一次真正的主控点击穿过了公开的 DOM 合约：Continue/fast-stop 同步变为禁用等待/无。
 */
export function applyNormalWinContinueControlClick(
  dataset: VisualFixtureDataset,
  before: Readonly<VisualFixtureSpinControlSnapshot>,
  click: () => Readonly<VisualFixtureSpinControlSnapshot>,
): boolean {
  const clickCount = incrementProjectionCount(dataset, "fixtureContinueClickCount");
  const validBefore = dataset.fixtureContinueTriggeredAt === NORMAL_WIN_CONTINUE_TRIGGER
    && clickCount === 1
    && before.mode === "continue"
    && before.action === "fast-stop"
    && !before.disabled;
  if (!validBefore) return setNormalWinContinueViolation(dataset, "continue-control-contract");
  // 在调用真正的 DOM 单击之前会预测计数，因为接受的处理程序会同步发出预设的隐藏开始里程碑。
  const after = click();
  const accepted = after.mode === "waiting"
    && after.action === "none"
    && after.disabled;
  if (!accepted) return setNormalWinContinueViolation(dataset, "continue-control-contract");
  return dataset.fixtureContinueAcceptedCount !== "1"
    ? setNormalWinContinueViolation(dataset, "continue-accepted-trace-missing")
    : false;
}

function validateNormalWinContinueResident(
  dataset: VisualFixtureDataset,
  resident: Readonly<WinCelebrationResidentFacts> | null,
  phase: string,
): string | null {
  if (!resident) return "continue-resident-facts-missing";
  const hidden = phase === "hidden";
  const hiding = phase === "hide-start";
  if (resident.generation <= 0) return "continue-resident-generation";
  if (resident.labelInstanceId <= 0) return "continue-label-instance";
  if (resident.framePoolInstanceId <= 0) return "continue-pool-instance";
  if (resident.framePoolSize !== 24) return "continue-resident-pool-size";
  if (resident.activeBoxCount !== (hidden ? 0 : 4)) return "continue-active-box-count";
  if (resident.activeOwnerCount !== (hidden ? 0 : 1)) return "continue-owner-count";
  if (resident.pendingCleanupCount !== (hiding ? 1 : 0)) {
    return "continue-cleanup-count";
  }
  if (resident.handoffDelayMs !== 0) return "continue-handoff-delay";
  if (resident.staleHiddenCount !== 0) return "continue-stale-hidden";
  if (dataset.fixtureResidentGeneration !== undefined
    && dataset.fixtureResidentGeneration !== String(resident.generation)) {
    return "continue-generation-changed";
  }
  if (dataset.fixtureResidentLabelInstanceId !== undefined
    && dataset.fixtureResidentLabelInstanceId !== String(resident.labelInstanceId)) {
    return "continue-label-identity";
  }
  if (dataset.fixtureResidentFramePoolInstanceId !== undefined
    && dataset.fixtureResidentFramePoolInstanceId !== String(resident.framePoolInstanceId)) {
    return "continue-pool-identity";
  }
  return null;
}

function validateNormalWinContinueLogicalDone(dataset: VisualFixtureDataset): string | null {
  if (dataset.fixtureContinueTriggeredAt !== NORMAL_WIN_CONTINUE_TRIGGER) {
    return "continue-trigger-missing";
  }
  if (dataset.fixtureContinueClickCount !== "1") return "continue-click-count";
  if (dataset.fixtureContinueAcceptedCount !== "1") return "continue-not-accepted";
  if (dataset.fixtureContinueRecord1Seen !== "false") return "continue-record1-visible";
  if (dataset.fixtureContinueLogicalDoneCount !== "1") return "continue-logical-done-count";
  if (dataset.fixtureContinueVisualHiddenCount !== "0") return "continue-hidden-before-logical-done";
  if (normalWinContinueHistoryCount(dataset, "hide-start") !== 1) {
    return "continue-hide-start-count";
  }
  if (normalWinContinueHistoryCount(dataset, "merge-settled") !== 0) {
    return "continue-merge-settled-after-trigger";
  }
  if (normalWinContinueHistoryCount(dataset, "hold-complete") !== 0) {
    return "continue-hold-complete-after-trigger";
  }
  if (dataset.fixtureResidentActiveBoxCount !== "4") return "continue-active-box-count";
  if (dataset.fixtureResidentActiveOwnerCount !== "1") return "continue-owner-count";
  if (dataset.fixtureResidentPendingCleanupCount !== "1") return "continue-cleanup-count";
  return null;
}

/**
 * 只投影截图选择所需的信息，不序列化任何结果对象。仅当严格轨迹顺序违规必须使浏览器测试夹具失败时才返回 true；
 * 符合预期的旧轮次尾段仍会忽略。
 */
export function applyVisualFixtureTrace(
  dataset: VisualFixtureDataset,
  trace: AppPresentationTrace,
  scenario?: string,
): boolean {
  if (trace.type === "result.accepted") {
    clearKeys(dataset, RESULT_RESET_KEYS);
    clearVisualFixtureVault(dataset);
    clearVisualFixtureCompletion(dataset);
    dataset.fixtureSequence = String(trace.sequence);
    dataset.fixtureStage = trace.type;
    dataset.fixtureTotalWinMinor = trace.totalWinMinor;
    dataset.fixtureBalanceMinor = trace.balanceMinor;
    if (scenario === NORMAL_WIN_CONTINUE_SCENARIO) {
      initializeNormalWinContinueProjection(dataset);
      if (trace.sequence !== 1 || trace.totalWinMinor !== "800" || trace.winCount !== 2) {
        return setNormalWinContinueViolation(dataset, "continue-result-contract");
      }
    }
    if (scenario === BASE_WILD_REVEAL_SCENARIO) {
      initializeWildRevealProjection(dataset);
      if (trace.sequence !== 1
        || trace.totalWinMinor !== "0"
        || trace.balanceMinor !== "99900"
        || trace.winCount !== 0) {
        return setWildRevealViolation(dataset, "wild-reveal-result-contract");
      }
    }
    if (isRageCollectionFixtureScenario(scenario ?? "")) {
      initializeRageCollectionProjection(dataset);
      if (trace.sequence !== 1
        || trace.totalWinMinor !== "0"
        || trace.balanceMinor !== "99900"
        || trace.winCount !== 0) {
        return setRageCollectionViolation(dataset, "rage-collect-result-contract");
      }
    }
    if (scenario === BASE_RGS_RECOVERED_LEVEL_UP_SCENARIO) {
      if (dataset.fixtureRgsRecoveredFeatureEventCount === undefined) {
        dataset.fixtureRgsRecoveredFeatureEventCount = "0";
      }
      const acceptedCount = incrementProjectionCount(
        dataset,
        "fixtureRgsRecoveredAcceptedCount",
      );
      if (acceptedCount !== 1
        || trace.sequence !== 1
        || trace.totalWinMinor !== "0"
        || trace.balanceMinor !== "99900"
        || trace.winCount !== 0) {
        setPass49RecoveredViolation(dataset, "rgs-recovered-result-contract");
        return true;
      }
    }
    if (scenario === BASE_ONE_RAGE_TRIGGER_TRANSFORM_SCENARIO) {
      initializePass47Projection(dataset);
      if (trace.sequence !== 1
        || trace.totalWinMinor !== "1000"
        || trace.balanceMinor !== "100900"
        || trace.winCount !== 0) {
        return setPass47Violation(dataset, "rage-cascade-result-contract");
      }
    }
    if (scenario === BASE_RAGE_LEVEL_TWO_PERSISTENT_AURA_SCENARIO) {
      if (dataset.fixtureRageAuraFeatureEventCount === undefined) {
        dataset.fixtureRageAuraFeatureEventCount = "0";
      }
      const acceptedCount = incrementProjectionCount(
        dataset,
        "fixtureRageAuraRoundAcceptedCount",
      );
      if (acceptedCount !== 1
        || trace.sequence !== 1
        || trace.totalWinMinor !== "0"
        || trace.balanceMinor !== "99900"
        || trace.winCount !== 0) {
        setPass48RageAuraViolation(dataset, "rage-aura-result-contract");
        return true;
      }
    }
    if (scenario === BASE_THREE_RAGE_WHEEL_ENTRY_SCENARIO) {
      initializePass45Projection(dataset);
      if (trace.sequence !== 1
        || trace.totalWinMinor !== "1000"
        || trace.balanceMinor !== "100900"
        || trace.winCount !== 0) {
        return setPass45Violation(dataset, "pass45-result-contract");
      }
    }
    return false;
  }

  // 记录的创作隐藏可能会在下一轮被接受后完成。
  if (dataset.fixtureSequence !== String(trace.sequence)) {
    return scenario === BASE_RGS_RECOVERED_LEVEL_UP_SCENARIO
      ? (setPass49RecoveredViolation(dataset, "rgs-recovered-trace-sequence"), true)
      : false;
  }

  if (scenario === BASE_RAGE_LEVEL_TWO_PERSISTENT_AURA_SCENARIO
    && trace.type !== "reels.settled"
    && trace.type !== "balance.committed"
    && trace.type !== "round.complete") {
    setPass48RageAuraViolation(
      dataset,
      "rage-aura-unexpected-presentation-trace",
    );
    return true;
  }

  const wildRevealTrace = asWildRevealFixtureTrace(trace);
  if (scenario === BASE_WILD_REVEAL_SCENARIO && wildRevealTrace) {
    return applyWildRevealTrace(dataset, wildRevealTrace);
  }
  const rageCollectionTrace = asRageCollectionFixtureTrace(trace);
  if (isRageCollectionFixtureScenario(scenario ?? "") && rageCollectionTrace) {
    return applyRageCollectionTrace(dataset, rageCollectionTrace, scenario ?? "");
  }
  if (scenario === BASE_RGS_RECOVERED_LEVEL_UP_SCENARIO
    && trace.type !== "reels.settled"
    && trace.type !== "balance.committed"
    && trace.type !== "round.complete") {
    setPass49RecoveredViolation(dataset, "rgs-recovered-unexpected-presentation-trace");
    return true;
  }
  const rageCascadeTrace = asRageCascadeFixtureTrace(trace);
  if (scenario === BASE_ONE_RAGE_TRIGGER_TRANSFORM_SCENARIO && rageCascadeTrace) {
    return applyPass47CascadeTrace(dataset, rageCascadeTrace);
  }
  if (scenario === BASE_ONE_RAGE_TRIGGER_TRANSFORM_SCENARIO) {
    const traceType = String(trace.type);
    if (traceType.startsWith("rage-collect.")) {
      return setPass47Violation(dataset, "rage-cascade-unexpected-collect-or-tower");
    }
    if (traceType.startsWith("wild-reveal.")
      || traceType.startsWith("win-record.")
      || traceType.startsWith("big-win.")
      || traceType.startsWith("counter.")) {
      return setPass47Violation(dataset, "rage-cascade-unexpected-presentation-trace");
    }
  }
  if (scenario === BASE_THREE_RAGE_WHEEL_ENTRY_SCENARIO) {
    const traceType = String(trace.type);
    if (traceType.startsWith("win-record.")
      || traceType.startsWith("big-win.")
      || traceType.startsWith("counter.")
      || traceType.startsWith("rage-collect.")) {
      return setPass45Violation(dataset, "pass45-unexpected-presentation-trace");
    }
  }

  if (trace.type === "counter.started" || trace.type === "counter.completed") {
    dataset.fixtureStage = trace.type;
    dataset.fixtureCounterState = trace.type.slice("counter.".length);
    return false;
  }

  const traceType: string = trace.type;
  if (scenario === NORMAL_WIN_CONTINUE_SCENARIO
    && trace.sequence === 1
    && traceType === "normal-win.continue-accepted") {
    const count = incrementProjectionCount(dataset, "fixtureContinueAcceptedCount");
    dataset.fixtureStage = traceType;
    if (dataset.fixtureContinueTriggeredAt !== NORMAL_WIN_CONTINUE_TRIGGER
      || dataset.fixtureContinueClickCount !== "1"
      || dataset.fixtureContinueRecord1Seen !== "false"
      || dataset.fixtureContinueVisualHiddenCount !== "0") {
      return setNormalWinContinueViolation(dataset, "continue-accepted-order");
    }
    return count !== 1
      ? setNormalWinContinueViolation(dataset, "continue-accepted-count")
      : false;
  }
  if (scenario === NORMAL_WIN_CONTINUE_SCENARIO
    && trace.sequence === 1
    && traceType === "normal-win.logical-done") {
    const count = incrementProjectionCount(dataset, "fixtureContinueLogicalDoneCount");
    dataset.fixtureStage = traceType;
    if (count !== 1) {
      return setNormalWinContinueViolation(dataset, "continue-logical-done-count");
    }
    const violation = validateNormalWinContinueLogicalDone(dataset);
    return violation ? setNormalWinContinueViolation(dataset, violation) : false;
  }

  if (trace.type.startsWith("win-record.") && "index" in trace) {
    const phase = trace.type.slice("win-record.".length);
    const currentIndex = Number.parseInt(dataset.fixtureRecordIndex ?? "-1", 10);

    if (scenario === NORMAL_WIN_CONTINUE_SCENARIO && trace.sequence === 1) {
      if (trace.count !== 2 || trace.index < 0 || trace.index > 1
        || trace.id !== NORMAL_WIN_CONTINUE_RECORD_IDS[trace.index]) {
        return setNormalWinContinueViolation(dataset, "continue-record-contract");
      }
      if (trace.index === 1) {
        dataset.fixtureContinueRecord1Seen = "true";
        appendRecordTraceHistory(dataset, trace.sequence, trace.index, phase, true);
        return setNormalWinContinueViolation(dataset, "continue-record1-visible");
      }
      if (trace.amountMinor !== "500" || trace.multiplier !== 5) {
        return setNormalWinContinueViolation(dataset, "continue-record0-value");
      }
      if (dataset.fixtureContinueTriggeredAt !== undefined
        && (phase === "merge-settled" || phase === "hold-complete")) {
        appendRecordTraceHistory(dataset, trace.sequence, trace.index, phase, true);
        return setNormalWinContinueViolation(
          dataset,
          phase === "merge-settled"
            ? "continue-merge-settled-after-trigger"
            : "continue-hold-complete-after-trigger",
        );
      }
      const resident = residentFactsFromTrace(trace);
      const residentViolation = validateNormalWinContinueResident(dataset, resident, phase);
      if (residentViolation) {
        appendRecordTraceHistory(dataset, trace.sequence, trace.index, phase, true);
        return setNormalWinContinueViolation(dataset, residentViolation);
      }
      if (phase === "merge-start") {
        if (dataset.fixtureContinueTriggeredAt !== undefined) {
          appendRecordTraceHistory(dataset, trace.sequence, trace.index, phase, true);
          return setNormalWinContinueViolation(dataset, "continue-trigger-count");
        }
        dataset.fixtureContinueTriggeredAt = NORMAL_WIN_CONTINUE_TRIGGER;
      } else if (phase === "hide-start") {
        if (dataset.fixtureContinueTriggeredAt !== NORMAL_WIN_CONTINUE_TRIGGER
          || dataset.fixtureContinueClickCount !== "1"
          || normalWinContinueHistoryCount(dataset, phase) !== 0) {
          appendRecordTraceHistory(dataset, trace.sequence, trace.index, phase, true);
          return setNormalWinContinueViolation(dataset, "continue-hide-start-order");
        }
      } else if (phase === "hidden") {
        const hiddenCount = incrementProjectionCount(
          dataset,
          "fixtureContinueVisualHiddenCount",
        );
        if (hiddenCount !== 1
          || dataset.fixtureContinueLogicalDoneCount !== "1"
          || normalWinContinueHistoryCount(dataset, "hide-start") !== 1) {
          appendRecordTraceHistory(dataset, trace.sequence, trace.index, phase, true);
          return setNormalWinContinueViolation(dataset, "continue-visual-hidden-order");
        }
      }
    }

    if (phase === "hidden" && Number.isSafeInteger(currentIndex)
      && currentIndex > trace.index) {
      appendRecordTraceHistory(dataset, trace.sequence, trace.index, phase, true);
      dataset.fixtureStaleHidden = `${trace.sequence}:${trace.index}:${trace.id}`;
      dataset.fixtureTraceViolation = "stale-hidden-owner-regression";
      // 不要让过时的完成滚动阶段、记录身份、常驻对象所有权或屏幕截图选择事实返回到传出记录。
      return true;
    }

    // 在发布的零延迟程序中，中间记录的隐藏处理程序在发布 HIDDEN 之前被后继者 SHOW 取代。即使后继者尚未投影其第一个跟踪，
    // 也要拒绝它：仅检查 `currentIndex > trace.index` 就会让意外的 333ms 等待通过有效。
    if (phase === "hidden"
      && scenario !== NORMAL_WIN_CONTINUE_SCENARIO
      && trace.index < trace.count - 1) {
      appendRecordTraceHistory(dataset, trace.sequence, trace.index, phase, true);
      dataset.fixtureStaleHidden = `${trace.sequence}:${trace.index}:${trace.id}`;
      dataset.fixtureTraceViolation = "intermediate-hidden-before-successor";
      return true;
    }

    const exactHiddenEntry = `${trace.sequence}:${trace.index}:hidden`;
    if (phase === "hidden"
      && (dataset.fixtureTraceHistory?.split(",").includes(exactHiddenEntry) ?? false)) {
      appendRecordTraceHistory(dataset, trace.sequence, trace.index, phase, true);
      dataset.fixtureTraceViolation = "duplicate-current-hidden";
      return true;
    }

    const resident = residentFactsFromTrace(trace);
    // 序列 5 是确定性的两条记录 xN 切换装置。它的诊断是严格的可视化门的一部分，而不是可选的日志记录。
    if (trace.sequence === 5 && trace.count === 2) {
      let violation: string | null = null;
      if (!resident) violation = "resident-facts-missing";
      else {
        const hidden = phase === "hidden";
        const previousGeneration = Number.parseInt(
          dataset.fixtureResidentGeneration ?? "-1",
          10,
        );
        const changedRecord = Number.isSafeInteger(currentIndex) && currentIndex >= 0
          && trace.index > currentIndex;
        if (resident.framePoolSize !== 24) violation = "resident-pool-size";
        else if (resident.staleHiddenCount !== 0) violation = "resident-stale-hidden";
        else if (resident.activeOwnerCount !== (hidden ? 0 : 1)) {
          violation = "resident-owner-count";
        } else if (resident.pendingCleanupCount !== (phase === "hide-start" ? 1 : 0)) {
          violation = "resident-cleanup-count";
        } else if (!hidden && resident.activeBoxCount <= 0) {
          violation = "resident-active-box-count";
        } else if (trace.index > 0 && !resident.viewReused) {
          violation = "resident-view-not-reused";
        } else if (trace.index > 0 && resident.handoffDelayMs !== 0) {
          violation = "resident-handoff-delay";
        } else if (dataset.fixtureResidentLabelInstanceId !== undefined
          && dataset.fixtureResidentLabelInstanceId !== String(resident.labelInstanceId)) {
          violation = "resident-label-identity";
        } else if (dataset.fixtureResidentFramePoolInstanceId !== undefined
          && dataset.fixtureResidentFramePoolInstanceId !== String(resident.framePoolInstanceId)) {
          violation = "resident-pool-identity";
        } else if (changedRecord && Number.isSafeInteger(previousGeneration)
          && resident.generation <= previousGeneration) {
          violation = "resident-generation-order";
        }
      }
      if (violation) {
        appendRecordTraceHistory(dataset, trace.sequence, trace.index, phase, true);
        dataset.fixtureTraceViolation = violation;
        return true;
      }
    }

    dataset.fixtureStage = trace.type;
    dataset.fixtureRecordIndex = String(trace.index);
    dataset.fixtureRecordCount = String(trace.count);
    dataset.fixtureRecordId = trace.id;
    dataset.fixtureRecordSymbol = trace.symbol;
    dataset.fixtureRecordPhase = phase;
    appendRecordTraceHistory(dataset, trace.sequence, trace.index, phase);
    if (resident) projectResidentFacts(dataset, resident);
    return false;
  }

  if (trace.type.startsWith("big-win.")) {
    dataset.fixtureStage = trace.type;
    dataset.fixtureBigWinMilestone = trace.type.slice("big-win.".length);
    return false;
  }

  if (trace.type === "balance.committed") {
    dataset.fixtureStage = trace.type;
    dataset.fixtureBalanceMinor = trace.balanceMinor;
    return false;
  }

  if (trace.type === "round.complete") {
    dataset.fixtureStage = trace.type;
    const previous = Number.parseInt(dataset.fixtureCompleteCount ?? "0", 10);
    dataset.fixtureCompleteCount = String(Number.isSafeInteger(previous) ? previous + 1 : 1);
    if (scenario === NORMAL_WIN_CONTINUE_SCENARIO && trace.sequence === 1) {
      const violation = validateNormalWinContinueLogicalDone(dataset);
      if (violation) return setNormalWinContinueViolation(dataset, violation);
    }
    if (scenario === BASE_WILD_REVEAL_SCENARIO && trace.sequence === 1
      && (dataset.fixtureWildRevealPreCount !== "1"
        || dataset.fixtureWildRevealCompleteCount !== "1"
        || dataset.fixtureWildRevealTraceHistory !== "pre,complete")) {
      return setWildRevealViolation(dataset, "wild-reveal-incomplete");
    }
    if (scenario === BASE_ONE_RAGE_TRIGGER_TRANSFORM_SCENARIO && trace.sequence === 1) {
      const terminalViolation = validatePass47TerminalProjection(dataset);
      if (terminalViolation) return setPass47Violation(dataset, terminalViolation);
      if (dataset.fixtureRageCascadeEventHistory !== PASS47_EVENT_ORDER.join(",")
        || dataset.fixtureRageCascadeEventCount !== "4") {
        return setPass47Violation(dataset, "rage-cascade-feature-events-incomplete");
      }
    }
    if (scenario === BASE_RAGE_LEVEL_TWO_PERSISTENT_AURA_SCENARIO
      && trace.sequence === 1
      && (dataset.fixtureRageAuraRoundAcceptedCount !== "1"
        || dataset.fixtureCompleteCount !== "1"
        || dataset.fixtureRageAuraFeatureEventCount !== "0")) {
      setPass48RageAuraViolation(dataset, "rage-aura-round-contract");
      return true;
    }
    if (scenario === BASE_RGS_RECOVERED_LEVEL_UP_SCENARIO
      && trace.sequence === 1
      && (dataset.fixtureRgsRecoveredAcceptedCount !== "1"
        || dataset.fixtureCompleteCount !== "1"
        || dataset.fixtureRgsRecoveredFeatureEventCount !== "1")) {
      setPass49RecoveredViolation(dataset, "rgs-recovered-round-contract");
      return true;
    }
    return false;
  }

  dataset.fixtureStage = trace.type;
  return false;
}

/** 首先清除过时的事实，并仅公开允许列出的功能投影。 */
export function applyVisualFixtureFeatureEvent(
  dataset: VisualFixtureDataset,
  type: FeatureEvent["type"] | null,
  event?: Readonly<FeatureEvent> | null,
  scenario?: string,
): boolean {
  clearVisualFixtureVault(dataset);
  clearVisualFixtureCompletion(dataset);
  if (scenario === BASE_RAGE_LEVEL_TWO_PERSISTENT_AURA_SCENARIO
    && (type !== null || event != null)) {
    incrementProjectionCount(dataset, "fixtureRageAuraFeatureEventCount");
    dataset.fixtureRageAuraUnexpectedFeatureEvent = type ?? event?.type ?? "unknown";
    setPass48RageAuraViolation(
      dataset,
      "rage-aura-unexpected-feature-event",
    );
    return true;
  }
  if (scenario === BASE_RGS_RECOVERED_LEVEL_UP_SCENARIO) {
    if (type === null && event == null) return false;
    const count = incrementProjectionCount(
      dataset,
      "fixtureRgsRecoveredFeatureEventCount",
    );
    if (!event
      || type !== "surge.collected"
      || event.type !== type
      || count !== 1
      || dataset.fixtureRgsRecoveredResultAccepted !== "true"
      || event.count !== 1
      || event.cells.length !== 1
      || event.cells[0]?.reel !== 1
      || event.cells[0].row !== 0
      || event.triggered
      || event.guaranteed
      || event.level !== 2
      || event.total !== 12) {
      setPass49RecoveredViolation(dataset, "rgs-recovered-feature-event-contract");
      return true;
    }
    dataset.fixtureRgsRecoveredFeatureEventHistory = event.type;
    return false;
  }
  if (!event || event.type !== type) return false;

  if (scenario === BASE_ONE_RAGE_TRIGGER_TRANSFORM_SCENARIO) {
    return appendPass47Event(dataset, event);
  }
  if (scenario === BASE_THREE_RAGE_WHEEL_ENTRY_SCENARIO) {
    return applyPass45FeatureEvent(dataset, event);
  }

  if (event.type === "free_spins.completed") {
    dataset.fixtureCompletionMode = event.mode;
    dataset.fixtureCompletionAwarded = String(event.awarded);
    dataset.fixtureCompletionWinMinor = event.cumulativeWinMinor;
    return false;
  }

  if (!type?.startsWith("vault")) return false;

  dataset.fixtureVaultPhase = type;
  if ("step" in event && Number.isSafeInteger(event.step)) {
    dataset.fixtureVaultStep = String(event.step);
  }
  if ("prize" in event && typeof event.prize === "string") {
    dataset.fixtureVaultPrize = event.prize;
  }
  const multiplier = "toMultiplier" in event
    ? event.toMultiplier
    : "multiplier" in event
      ? event.multiplier
      : undefined;
  if (typeof multiplier === "number" && Number.isFinite(multiplier)) {
    dataset.fixtureVaultMultiplier = String(multiplier);
  }
  if ("reel" in event && "row" in event
    && Number.isSafeInteger(event.reel) && Number.isSafeInteger(event.row)) {
    dataset.fixtureVaultCell = `${event.reel}:${event.row}`;
  }
  return false;
}

export function isVisualFixtureCheckpointCapture(
  scenario: string,
  capture: string | null,
): boolean {
  return scenario === "king-upgrade-ladder" && capture === "1";
}

export type VisualFixtureSemanticCheckpointLabel =
  | "wheel.popup-input-ready"
  | "wheel.input-ready"
  | "wheel.landing"
  | "kong.rows-8-settled"
  | "kong.retrigger-applied"
  | "big-win.show"
  | "big-win.level-up"
  | "big-win.count-end"
  | "big-win.hide-start"
  | "normal-win.hide-start"
  | "wild-reveal.pre"
  | "wild-reveal.complete"
  | "rage-collect.started"
  | "rage-collect.absorbing"
  | "rage-collect.source-hidden"
  | "rage-collect.complete"
  | "rage-cascade.started"
  | "rage-cascade.exploding"
  | "rage-cascade.placed"
  | "rage-cascade.pound"
  | "rage-cascade.activation"
  | "rage-cascade.source-hidden"
  | "rage-cascade.complete"
  | "character-intro.launch-ready"
  | "character-intro.loop-entered"
  | "win-character.pre-handoff"
  | "win-character.handoff"
  | "win-character.mix-complete"
  | "wheel-character.pre-handoff"
  | "wheel-character.handoff"
  | "wheel-character.mix-complete"
  | "wheel-chest.pre-reentry"
  | "wheel-chest.reentry"
  | "wheel-chest.mix-complete"
  | "wheel-chest.second-reentry"
  | "vault-unlock.locked"
  | "vault-unlock.enter"
  | "vault-unlock.key-1"
  | "vault-unlock.impact"
  | "vault-unlock.unlocked";

const CHECKPOINTS_BY_SCENARIO = Object.freeze({
  "wheel-mini-flow": Object.freeze([
    "wheel.popup-input-ready",
    "wheel.input-ready",
    "wheel.landing",
    "wheel-character.pre-handoff",
    "wheel-character.handoff",
    "wheel-character.mix-complete",
    "wheel-chest.pre-reentry",
    "wheel-chest.reentry",
    "wheel-chest.mix-complete",
    "wheel-chest.second-reentry",
  ] as const),
  "base-three-rage-wheel-entry": Object.freeze([
    "wheel.popup-input-ready",
    "wheel.input-ready",
  ] as const),
  "kong-flow": Object.freeze([
    "wheel.landing",
    "kong.rows-8-settled",
    "kong.retrigger-applied",
  ] as const),
  "king-flow": Object.freeze([
    "wheel.landing",
  ] as const),
  "big-win": Object.freeze([
    "big-win.show",
    "big-win.level-up",
    "big-win.count-end",
    "big-win.hide-start",
  ] as const),
  "normal-win-continue": Object.freeze([
    "normal-win.hide-start",
    "win-character.pre-handoff",
    "win-character.handoff",
    "win-character.mix-complete",
  ] as const),
  "base-wild-reveal-x100": Object.freeze([
    "wild-reveal.pre",
    "wild-reveal.complete",
  ] as const),
  "base-vault-unlock-x2": Object.freeze([
    "vault-unlock.locked",
    "vault-unlock.enter",
    "vault-unlock.key-1",
    "vault-unlock.impact",
    "vault-unlock.unlocked",
  ] as const),
  "base-single-rage-no-wheel": Object.freeze([
    "rage-collect.started",
    "rage-collect.absorbing",
    "rage-collect.source-hidden",
    "rage-collect.complete",
  ] as const),
  "base-two-rage-no-wheel": Object.freeze([
    "rage-collect.started",
    "rage-collect.absorbing",
    "rage-collect.source-hidden",
    "rage-collect.complete",
  ] as const),
  "base-rgs-recovered-level-up": Object.freeze([
    "rage-collect.started",
  ] as const),
  "base-one-rage-trigger-transform": Object.freeze([
    "rage-cascade.started",
    "rage-cascade.exploding",
    "rage-cascade.placed",
    "rage-cascade.pound",
    "rage-cascade.activation",
    "rage-cascade.source-hidden",
    "rage-cascade.complete",
  ] as const),
  "base-launch-level-two-intro": Object.freeze([
    "character-intro.launch-ready",
    "character-intro.loop-entered",
  ] as const),
});

/** 在任意查询值反映到 DOM 之前拒绝它们。 */
export function resolveVisualFixtureSemanticCheckpoint(
  scenario: string,
  capture: string | null,
  requested: string | null,
): VisualFixtureSemanticCheckpointLabel | null {
  if (capture !== "1" || !requested) return null;
  const labels = CHECKPOINTS_BY_SCENARIO[
    scenario as keyof typeof CHECKPOINTS_BY_SCENARIO
  ] as readonly string[] | undefined;
  return labels?.includes(requested)
    ? requested as VisualFixtureSemanticCheckpointLabel
    : null;
}

/** Pass52 证据仅在作者 1500ms（非简化时钟）上才是规范的。 */
export function baseVaultUnlockCaptureEnvironmentViolation(
  scenario: string,
  capture: string | null,
  requested: string | null,
  reducedMotion: boolean,
): string | null {
  const checkpoint = resolveVisualFixtureSemanticCheckpoint(
    scenario,
    capture,
    requested,
  );
  if (scenario !== "base-vault-unlock-x2"
    || capture !== "1"
    || !checkpoint?.startsWith("vault-unlock.")) return null;
  return reducedMotion ? "vault-unlock-reduced-motion-not-canonical" : null;
}

/** 精确场景+标签+序列匹配器用于罕见状态屏幕截图。 */
export function matchVisualFixtureSemanticCheckpoint(
  scenario: string,
  capture: string | null,
  requested: string | null,
  checkpoint: AppPresentationCheckpoint,
): VisualFixtureSemanticCheckpointLabel | null {
  const label = resolveVisualFixtureSemanticCheckpoint(scenario, capture, requested);
  if (!label) return null;

  if (scenario === "wheel-mini-flow" || scenario === "base-three-rage-wheel-entry") {
    return checkpoint.type === "semantic-state"
      && checkpoint.sequence === 1
      && checkpoint.state === label
      ? label
      : null;
  }
  if ((scenario === "kong-flow" || scenario === "king-flow")
    && label === "wheel.landing") {
    return checkpoint.type === "semantic-state"
      && checkpoint.sequence === 1
      && checkpoint.state === label
      ? label
      : null;
  }
  if (scenario === "kong-flow") {
    return checkpoint.type === "semantic-state"
      && checkpoint.state === label
      && ((label === "kong.rows-8-settled" && checkpoint.sequence === 4)
        || (label === "kong.retrigger-applied" && checkpoint.sequence === 5))
      ? label
      : null;
  }
  if (scenario === "big-win") {
    const expectedTrace = label === "big-win.show" ? "big-win.count-start" : label;
    return checkpoint.type === "presentation-trace"
      && checkpoint.trace.sequence === 1
      && checkpoint.trace.type === expectedTrace
      ? label
      : null;
  }
  if (scenario === NORMAL_WIN_CONTINUE_SCENARIO
    && label === "normal-win.hide-start") {
    return checkpoint.type === "presentation-trace"
      && checkpoint.trace.type === "win-record.hide-start"
      && checkpoint.trace.sequence === 1
      && checkpoint.trace.index === 0
      && checkpoint.trace.count === 2
      && checkpoint.trace.id === NORMAL_WIN_CONTINUE_RECORD_IDS[0]
      ? label
      : null;
  }
  if (scenario === BASE_WILD_REVEAL_SCENARIO
    && checkpoint.type === "presentation-trace") {
    const trace = asWildRevealFixtureTrace(checkpoint.trace);
    return trace
      && trace.type === label
      && hasExactWildRevealContract(trace)
      ? label
      : null;
  }
  if (scenario === "base-vault-unlock-x2") {
    return checkpoint.type === "vault-unlock-phase"
      && checkpoint.sequence === 1
      && checkpoint.phase === label
      && checkpoint.cell.reel === 1
      && checkpoint.cell.row === 2
      && checkpoint.prize === "X2"
      && checkpoint.multiplier === 2
      ? label
      : null;
  }
  if (isRageCollectionFixtureScenario(scenario)
    && checkpoint.type === "presentation-trace") {
    const trace = asRageCollectionFixtureTrace(checkpoint.trace);
    return trace
      && trace.type === label
      && hasExactRageCollectionContract(trace, scenario)
      ? label
      : null;
  }
  if (scenario === BASE_ONE_RAGE_TRIGGER_TRANSFORM_SCENARIO
    && checkpoint.type === "presentation-trace") {
    const trace = asRageCascadeFixtureTrace(checkpoint.trace);
    return trace
      && trace.type === label
      && hasExactPass47CascadeTraceContract(trace)
      ? label
      : null;
  }
  return null;
}

type VaultUnlockPhaseCheckpoint = Extract<
  AppPresentationCheckpoint,
  { type: "vault-unlock-phase" }
>;

/**
 * 发布一个精确的只读 Base Vault 姿势。任何不匹配都会在测试场景中失败关闭，而不会将诊断反馈回渲染。
 */
export function publishBaseVaultUnlockCheckpoint(
  dataset: VisualFixtureDataset,
  scenario: string,
  capture: string | null,
  requested: string | null,
  checkpoint: Readonly<VaultUnlockPhaseCheckpoint>,
  diagnostics: Readonly<ReelVaultCaptureDiagnostics> | null,
): string | null {
  const matched = matchVisualFixtureSemanticCheckpoint(
    scenario,
    capture,
    requested,
    checkpoint,
  );
  if (!matched || scenario !== "base-vault-unlock-x2") return "vault-unlock-checkpoint-not-exact";
  if (!diagnostics) return "vault-unlock-diagnostics-missing";
  if (!Object.isFrozen(diagnostics)
    || !Object.isFrozen(diagnostics.cell)
    || (diagnostics.track0 !== null && !Object.isFrozen(diagnostics.track0))
    || (diagnostics.track1 !== null && !Object.isFrozen(diagnostics.track1))) {
    return "vault-unlock-diagnostics-mutable";
  }
  if (diagnostics.reel !== 1
    || diagnostics.row !== 2
    || diagnostics.cell.symbol !== "VAULT"
    || diagnostics.cell.prize !== "X2"
    || diagnostics.cell.multiplier !== 2
    || !diagnostics.paused) {
    return "vault-unlock-cell-contract";
  }

  const lockedBody = matched !== "vault-unlock.unlocked";
  if (diagnostics.spineKey !== (lockedBody ? "symbol8" : "symbol9")) {
    return "vault-unlock-spine-key";
  }
  const expectedTrack0 = matched === "vault-unlock.locked"
    || matched === "vault-unlock.unlocked"
    ? "stop"
    : "unlock_backup";
  if (diagnostics.track0?.animation !== expectedTrack0) {
    return "vault-unlock-track0-animation";
  }
  if (diagnostics.track1?.animation !== "x2") return "vault-unlock-track1-animation";
  if (matched === "vault-unlock.enter"
    || matched === "vault-unlock.key-1"
    || matched === "vault-unlock.impact") {
    if (diagnostics.track0?.mixDuration !== 0) return "vault-unlock-mix-duration";
    const expectedTime = matched === "vault-unlock.enter"
      ? 0
      : matched === "vault-unlock.key-1" ? 33.333 : 133.333;
    if (Math.abs((diagnostics.track0?.trackTimeMs ?? -1) - expectedTime) > 0.05) {
      return "vault-unlock-track-time";
    }
  }

  dataset.fixtureVaultUnlockCheckpoint = matched;
  dataset.fixtureVaultUnlockDiagnostics = JSON.stringify(diagnostics);
  dataset.fixtureVaultUnlockContract = "ok";
  delete dataset.fixtureVaultUnlockViolation;
  return null;
}

/** 精确的 CAP 测试场景门；序列保护可以防止陈旧的装置在其他地方暂停。 */
export function isCapSummaryInputCheckpointCapture(
  scenario: string,
  capture: string | null,
  checkpoint: AppPresentationCheckpoint,
): boolean {
  if (scenario !== "cap-summary" || capture !== "1"
    || checkpoint.type !== "bounded-gate-input-ready") return false;
  return checkpoint.gate === "free-spin-cap"
    ? checkpoint.sequence === 2
    : checkpoint.gate === "free-spins-summary" && checkpoint.sequence === 9;
}

/**
 * 跨浏览器像素取证可在最终免费旋转总结输入门选择启用仅夹具保持；
 * 场景与序列校验确保该诊断接口不会暂停其他表现路径。
 */
export function isFreeSpinsSummaryInputCheckpointHold(
  scenario: string,
  optIn: string | null,
  checkpoint: AppPresentationCheckpoint,
): boolean {
  if (optIn !== "1"
    || checkpoint.type !== "bounded-gate-input-ready"
    || checkpoint.gate !== "free-spins-summary") return false;
  if (scenario === "king-flow") return checkpoint.sequence === 9;
  if (scenario === "kong-flow") return checkpoint.sequence === 10;
  return scenario === "cap-summary" && checkpoint.sequence === 9;
}

/** 精确确定的无摘要终端保持；其他所有检查点均无法打开。 */
export function isNoSummaryTerminalCheckpointCapture(
  scenario: string,
  capture: string | null,
  checkpoint: AppPresentationCheckpoint,
): boolean {
  if (capture !== "1" || checkpoint.type !== "free-spins-completed-active") return false;
  if (checkpoint.sequence !== 9 || checkpoint.mode !== "EXPANSION" || checkpoint.awarded !== 8) {
    return false;
  }
  if (scenario === "summary-no-panel") return checkpoint.cumulativeWinMinor === "0";
  return scenario === "summary-no-panel-equal"
    && checkpoint.cumulativeWinMinor === "100";
}

export function isWinEffectsMatrixTraceCheckpoint(
  scenario: string,
  capture: string | null,
  trace: AppPresentationTrace,
): boolean {
  if (scenario !== "win-effects-matrix" || capture !== "1") return false;
  if (trace.type === "big-win.count-start") return trace.sequence === 6;
  if (!trace.type.startsWith("win-record.") || !("index" in trace)) return false;
  if (trace.sequence >= 1 && trace.sequence <= 4) {
    // 在预设的显示时钟前进后、消失之前按住。这是第一个屏幕截图安全的组合框架； `visible` 是语义 START 回调，可以先于第一次手动 Spine 更新。
    return trace.type === "win-record.hold-complete" && trace.index === 0;
  }
  if (trace.sequence === 5) {
    // START `visible` 轨迹拥有一个预设的 alpha-0 设置姿势。官方 WINLABEL_SHOWN 边界是第一个确定性基础/无 xN 帧，
    // 发生在乘法器分配或 merge_start 播放之前。 Pass 39仅添加不透明HOLD和零延迟后继接口； hide-start 和 hide 仍然是可观察的遥测，
    // 永远不会成为障碍。
    return ((trace.type === "win-record.show-complete"
      || trace.type === "win-record.merge-start"
      || trace.type === "win-record.merge-settled"
      || trace.type === "win-record.hold-complete") && trace.index === 0)
      || ((trace.type === "win-record.show-complete"
        || trace.type === "win-record.hold-complete") && trace.index === 1);
  }
  return trace.sequence === 6
    && trace.type === "win-record.visible"
    && trace.index === 0;
}

export interface VisualFixtureCheckpointHold {
  readonly promise: Promise<void>;
  release(): void;
}

/** 浏览器自动化可以发送此密钥，而无需构造 DOM 事件。 */
export const VISUAL_FIXTURE_RELEASE_KEY = "F8";

/** 事件驱动的屏幕截图保持与有限的安全释放。 */
export function createVisualFixtureCheckpointHold(
  target: EventTarget,
  dataset: VisualFixtureDataset,
  checkpoint: string,
  timeoutMs = 15_000,
): VisualFixtureCheckpointHold {
  let settled = false;
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  let releaseOnKeyDown: EventListener = () => undefined;
  const release = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    target.removeEventListener("visual-fixture-release", release);
    target.removeEventListener("keydown", releaseOnKeyDown);
    if (dataset.fixtureCheckpoint === checkpoint) delete dataset.fixtureCheckpoint;
    resolvePromise();
  };
  releaseOnKeyDown = (event: Event): void => {
    const key = "key" in event ? (event as Event & { readonly key?: unknown }).key : undefined;
    if (key === VISUAL_FIXTURE_RELEASE_KEY) release();
  };
  dataset.fixtureCheckpoint = checkpoint;
  target.addEventListener("visual-fixture-release", release, { once: true });
  target.addEventListener("keydown", releaseOnKeyDown);
  const timeout = setTimeout(release, Math.max(0, timeoutMs));
  return Object.freeze({ promise, release });
}
