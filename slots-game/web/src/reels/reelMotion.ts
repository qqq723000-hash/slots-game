import type { FeatureMode, GridCell, SymbolId } from "../app/state/types";
import {
  PRIMAL_REEL_IMPACT_PROGRESS,
  PRIMAL_REEL_TIMING_MS,
} from "./primalAnimationTiming";

export const REEL_ACCELERATION_MS = PRIMAL_REEL_TIMING_MS.acceleration;
/** 捕获的 ReelSpinner 巡航速度，以逻辑行表示。 / English: Captured ReelSpinner cruise speed, expressed as logical lines. */
export const PRIMAL_REEL_SPIN_SPEED_ROWS_PER_MS = 0.02;
// 现有像素空间 ReelView API 的兼容性比例。源 160px 行在捕获的三行柜中以 0.656 比例显示。 / English: Compatibility scale for existing pixel-space ReelView APIs. The source 160px row is displayed at 0.656 scale in the captured three-row bin.
const REEL_COMPATIBILITY_ROW_HEIGHT_PX = 104.96;
export const REEL_BASE_SPEED_PX_PER_MS = 2.0992;
/** 官方 30fps 调度程序在停滞帧后最多处理五个时钟周期。 / English: The official 30fps scheduler handles up to five clock cycles after a stalled frame. */
export const MAX_REEL_FRAME_DELTA_MS = (5 / 30) * 1_000;
/** 捕获的 ReelSpinner.stopPos = ceil(position) + 5。 / English: Captured ReelSpinner.stopPos = ceil(position) + 5. */
export const REEL_STOP_ADVANCE_ROWS = 5;
/** 捕获的停止/弹跳连接速度。这是表现动作，而不是数学。 / English: Captured stop/bounce connection speed. This is performance action, not math. */
export const REEL_STOP_END_SPEED_ROWS_PER_MS = 0.0015;
/**
 * 当停止在小数阶段开始时，最早插入的结果行在普通的屏幕外前驱上方开始五个视图行。
 *
 * 英文 / English: When stopping starts at the decimal stage, the earliest inserted result row starts five view rows above the normal off-screen predecessor.
 */
export const REEL_PRESENTATION_FIRST_VIEW_ROW = -REEL_STOP_ADVANCE_ROWS;
export const REEL_PRESENTATION_TRAILING_VIEW_ROWS = 1;

export interface ReelSpinProfile {
  readonly reel: number;
  readonly startDelayMs: number;
  readonly speedMultiplier: number;
  readonly phaseOffsetRows: number;
}

export interface ReelSettleFrame {
  readonly motionAlpha: number;
  readonly motionOffset: number;
  readonly motionBlurY: number;
  readonly resultAlpha: number;
  readonly resultOffset: number;
  readonly resultScaleY: number;
  readonly resultBlurY: number;
  readonly impactAlpha: number;
}

export interface ReelResultInsertion {
  readonly targetWholeRows: number;
  readonly cells: readonly GridCell[];
}

export interface ReelStopMotionPlan {
  readonly startRows: number;
  readonly targetRows: number;
  readonly startVelocityRowsPerMs: number;
  readonly endVelocityRowsPerMs: number;
  readonly brakeMs: number;
  readonly bounceMs: number;
  readonly totalMs: number;
}

export const REEL_STOP_MODES = ["NORMAL", "FAST", "SLOW"] as const;
export type ReelStopMode = (typeof REEL_STOP_MODES)[number];

export interface ReelStopMotionConfig {
  readonly brakeMs: number;
  readonly advanceRows: number;
  readonly endVelocityRowsPerMs: number;
  readonly bounceMs: number;
  readonly totalMs: number;
}

/** 从游戏中捕获的精确 ReelSpinner.setStopMode 运动参数。 / English: Precise ReelSpinner.setStopMode motion parameters captured from the game. */
export const PRIMAL_REEL_STOP_MOTION_CONFIG: Readonly<
  Record<ReelStopMode, ReelStopMotionConfig>
> = Object.freeze({
  NORMAL: Object.freeze({
    brakeMs: 300,
    advanceRows: 5,
    endVelocityRowsPerMs: 0.0015,
    bounceMs: 350,
    totalMs: 650,
  }),
  FAST: Object.freeze({
    brakeMs: 300,
    advanceRows: 5,
    endVelocityRowsPerMs: 0.0015,
    bounceMs: 250,
    totalMs: 550,
  }),
  SLOW: Object.freeze({
    brakeMs: 3_000,
    advanceRows: 18,
    endVelocityRowsPerMs: 0,
    bounceMs: 0,
    totalMs: 3_000,
  }),
});

const PROFILES: readonly ReelSpinProfile[] = [
  { reel: 0, startDelayMs: 0, speedMultiplier: 1, phaseOffsetRows: 0 },
  { reel: 1, startDelayMs: 0, speedMultiplier: 1, phaseOffsetRows: 0 },
  { reel: 2, startDelayMs: 0, speedMultiplier: 1, phaseOffsetRows: 0 },
];

export type ReelVisualStripMode = FeatureMode;

type CapturedReelStripSet = readonly [
  readonly number[],
  readonly number[],
  readonly number[],
];

/**
 * 来自 GameReelManager.createReelStripSets() 的精确客户端条带集。他们只驾驶模糊的旅行；权威停止网格仍然来自服务器，
 * 这些值绝不能被视为 RNG 权重。
 *
 * 英文 / English: Exact client stripe sets from GameReelManager.createReelStripSets(). They only drive fuzzy trips; the authoritative stopping grid still comes from the server and these values ​​must not be considered RNG weights.
 */
export const PRIMAL_CAPTURED_VISUAL_STRIP_IDS: Readonly<
  Record<ReelVisualStripMode, CapturedReelStripSet>
> = Object.freeze({
  BASE: Object.freeze([
    Object.freeze([
      0, 3, 0, 0, 0, 4, 4, 3, 15, 1, 0, 5, 0, 3, 5, 0, 5, 2, 5, 15, 0, 3, 0, 2,
      0, 0, 1, 15, 3, 1, 3, 3, 5, 1, 2, 1, 15, 2, 0, 2, 2, 1, 1, 0, 2, 1, 2,
    ]),
    Object.freeze([
      15, 2, 1, 0, 6, 2, 17, 17, 17, 3, 3, 4, 17, 17, 2, 2, 2, 15, 17, 0, 3, 17, 0,
      5, 2, 4, 5, 2, 3, 17, 17, 0, 17, 17, 1, 15, 1, 3, 17, 3, 2, 3, 17, 0, 5, 0, 3,
    ]),
    Object.freeze([
      5, 15, 4, 5, 4, 4, 15, 4, 5, 4, 4, 5, 5, 4, 5, 4, 4, 4, 5, 15, 3, 4, 4, 1, 3,
      5, 0, 1, 1, 15, 1, 0, 3, 0, 4, 0, 1, 0, 4, 1, 5, 3, 3, 3, 2, 3, 4,
    ]),
  ]) as CapturedReelStripSet,
  OVERDRIVE: Object.freeze([
    Object.freeze([
      1, 0, 3, 1, 3, 5, 2, 3, 4, 2, 1, 0, 4, 0, 4, 4, 0, 5, 2, 2, 4, 0, 2, 0, 1, 1, 5,
      1, 4, 5, 3, 5, 5, 2, 3,
    ]),
    Object.freeze([
      4, 5, 6, 2, 3, 2, 2, 5, 3, 0, 5, 6, 1, 2, 4, 1, 5, 32, 32, 32, 4, 3, 4, 32, 1,
      2, 3, 32, 6, 32, 4, 0, 32, 0, 5,
    ]),
    Object.freeze([
      5, 0, 5, 0, 3, 4, 5, 3, 3, 3, 2, 4, 1, 1, 4, 1, 0, 2, 5, 2, 4, 2, 1, 4, 2, 3, 1,
      5, 0, 2, 5, 4, 0, 3, 0,
    ]),
  ]) as CapturedReelStripSet,
  EXPANSION: Object.freeze([
    Object.freeze([
      0, 5, 0, 2, 1, 5, 4, 2, 3, 1, 4, 0, 0, 2, 0, 2, 3, 5, 0, 3, 1, 1, 1, 5, 1, 0, 0,
      0, 4, 1, 3, 3, 1, 3, 1,
    ]),
    Object.freeze([
      4, 3, 2, 1, 17, 1, 17, 5, 2, 0, 5, 17, 17, 17, 0, 1, 17, 5, 3, 1, 4, 17, 17, 17,
      2, 4, 3, 17, 17, 17, 6, 0, 17, 3, 17,
    ]),
    Object.freeze([
      4, 1, 0, 1, 1, 3, 3, 5, 5, 2, 1, 2, 1, 4, 3, 4, 0, 2, 3, 0, 5, 1, 3, 0, 1, 1, 3,
      2, 0, 5, 2, 0, 0, 2, 1,
    ]),
  ]) as CapturedReelStripSet,
});

function capturedVisualSymbol(serverId: number): SymbolId {
  switch (serverId) {
    case 0: return "PRISM";
    case 1: return "ORBIT";
    case 2: return "PULSE";
    case 3: return "NOVA";
    case 4: return "TANK";
    case 5: return "CIRCUIT";
    case 6: return "WILD";
    case 15: return "SURGE";
    case 17:
    case 32:
      return "VAULT";
    default:
      throw new Error(`Unsupported captured visual symbol id ${serverId}`);
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(value: number): number {
  const progress = clamp01(value);
  return progress * progress * (3 - 2 * progress);
}

function outCubic(value: number): number {
  return 1 - (1 - clamp01(value)) ** 3;
}

function mix(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

export function reelSpinProfile(reel: number): ReelSpinProfile {
  const profile = PROFILES[reel];
  if (!profile) throw new Error(`Unknown reel profile ${reel}`);
  return profile;
}

/**
 * 行空间中的官方启动曲线：第一个 300ms 为 0.02*u 行/毫秒，随后是恒定的 0.02 行/毫秒巡航速度。
 *
 * 英文 / English: Official launch curve in line space: 0.02*u lines/ms for the first 300ms, followed by a constant 0.02 lines/ms cruise speed.
 */
export function reelStartVelocityRowsAt(
  elapsedMs: number,
  profile: ReelSpinProfile,
): number {
  const movingMs = Math.max(0, elapsedMs - profile.startDelayMs);
  const u = clamp01(movingMs / REEL_ACCELERATION_MS);
  return PRIMAL_REEL_SPIN_SPEED_ROWS_PER_MS * profile.speedMultiplier * u;
}

/**
 * 行空间中的官方起始曲线：加速期间 3*u^2 行。在 300ms 之后，它以恒定的巡航速度从第 3 行继续。
 *
 * 英文 / English: Official starting curve in row space: 3*u^2 rows during acceleration. After 300ms, it continues from line 3 at constant cruising speed.
 */
export function reelStartPositionDeltaRowsAt(
  elapsedMs: number,
  profile: ReelSpinProfile,
): number {
  const movingMs = Math.max(0, elapsedMs - profile.startDelayMs);
  const multiplier = profile.speedMultiplier;
  if (movingMs >= REEL_ACCELERATION_MS) {
    return 3 * multiplier
      + PRIMAL_REEL_SPIN_SPEED_ROWS_PER_MS * multiplier
      * (movingMs - REEL_ACCELERATION_MS);
  }
  const u = movingMs / REEL_ACCELERATION_MS;
  return 3 * multiplier * u ** 2;
}

/** 为当前 ReelView 保留像素空间采样器的兼容性。 / English: Preserves pixel space sampler compatibility for the current ReelView. */
export function reelVelocityAt(elapsedMs: number, profile: ReelSpinProfile): number {
  return reelStartVelocityRowsAt(elapsedMs, profile) * REEL_COMPATIBILITY_ROW_HEIGHT_PX;
}

/**
 * 为现有调用者保留的兼容性像素空间距离。上面的显式行空间 API 与机柜/单元尺寸无关。
 *
 * 英文 / English: Compatibility pixel space distance reserved for existing callers. The explicit row space API above is independent of cabinet/unit size.
 */
export function reelDistanceAt(elapsedMs: number, profile: ReelSpinProfile): number {
  return reelStartPositionDeltaRowsAt(elapsedMs, profile) * REEL_COMPATIBILITY_ROW_HEIGHT_PX;
}

/**
 * 投影连续旋转器位置，而不在新一轮中重置它。官方微调保留`_pos`；只有卷带选择才能将该值重置为零。
 *
 * 英文 / English: Project the continuous spinner position without resetting it in a new round. Official spinner retains `_pos`; only tape selection can reset this value to zero.
 */
export function reelPositionRowsAt(
  originRows: number,
  elapsedMs: number,
  cellHeight: number,
  profile: ReelSpinProfile,
): number {
  const safeOrigin = Number.isFinite(originRows) ? originRows : 0;
  return safeOrigin + reelDistanceAt(elapsedMs, profile) / Math.max(1, cellHeight);
}

export function reelBlurForVelocity(velocity: number, profile: ReelSpinProfile): number {
  const cruise = REEL_BASE_SPEED_PX_PER_MS * profile.speedMultiplier;
  return mix(0.8, 17, clamp01(velocity / cruise));
}

export function decorativeSpinCells(
  reel: number,
  count: number,
  wholeCellSteps = 0,
  mode: ReelVisualStripMode = "BASE",
): GridCell[] {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Decorative strip count must be non-negative");
  if (!Number.isSafeInteger(wholeCellSteps) || wholeCellSteps < 0) {
    throw new Error("Decorative strip step must be a non-negative integer");
  }
  const strip = PRIMAL_CAPTURED_VISUAL_STRIP_IDS[mode]?.[reel];
  if (!strip) throw new Error(`Unknown captured visual strip ${mode}:${reel}`);
  return Array.from({ length: count }, (_, index) => {
    // 容器向下移动。当其子单元相位从 cellHeight 回绕到零时，视图 j+1 占据视图 j 的先前屏幕位置，因此其标识也必须同样变为旧的 j 标识。 / English: The container moves downward. When its subcell phase wraps from cellHeight to zero, view j+1 occupies view j's previous screen position, so its identity must likewise change to the old j identity.
    const stripIndex = index - wholeCellSteps;
    const wrappedIndex = ((stripIndex % strip.length) + strip.length) % strip.length;
    return { symbol: capturedVisualSymbol(strip[wrappedIndex] ?? 0) };
  });
}

export function reelPresentationCellCount(rowCount: number): number {
  if (!Number.isSafeInteger(rowCount) || rowCount < 3 || rowCount > 8) {
    throw new Error("Presentation row count must be an integer from 3 through 8");
  }
  const lastViewRow = rowCount + REEL_PRESENTATION_TRAILING_VIEW_ROWS;
  return lastViewRow - REEL_PRESENTATION_FIRST_VIEW_ROW + 1;
}

/**
 * 打造一条旅行展示带。服务器单元占据不可变的逻辑带坐标，因此随着全单元阶段的推进从上方进入；它们永远不会在第二个结果网格上混合。
 *
 * 英文 / English: Create a travel display strip. Server units occupy immutable logical band coordinates and therefore come from above as the full-unit stage progresses; they are never blended on the second result grid.
 */
export function reelPresentationCells(
  reel: number,
  rowCount: number,
  wholeCellSteps: number,
  insertion: ReelResultInsertion | null = null,
  mode: ReelVisualStripMode = "BASE",
): GridCell[] {
  if (!Number.isSafeInteger(wholeCellSteps) || wholeCellSteps < 0) {
    throw new Error("Presentation strip step must be a non-negative integer");
  }
  const count = reelPresentationCellCount(rowCount);
  const cells = decorativeSpinCells(
    reel,
    count,
    wholeCellSteps - REEL_PRESENTATION_FIRST_VIEW_ROW,
    mode,
  );
  if (!insertion) return cells;
  if (!Number.isSafeInteger(insertion.targetWholeRows) || insertion.targetWholeRows < 0) {
    throw new Error("Result insertion target must be a non-negative integer");
  }
  if (insertion.cells.length !== rowCount) {
    throw new Error("Result insertion cells do not match active row count");
  }

  return cells.map((fallback, index) => {
    const viewRow = REEL_PRESENTATION_FIRST_VIEW_ROW + index;
    const logicalBeltRow = viewRow - wholeCellSteps;
    const resultRow = logicalBeltRow + insertion.targetWholeRows - 1;
    const result = insertion.cells[resultRow];
    return result ? { ...result } : fallback;
  });
}

function buildReelStopMotionPlan(
  startRows: number,
  startVelocityRowsPerMs: number,
  config: ReelStopMotionConfig,
): ReelStopMotionPlan {
  const values = [
    startRows,
    startVelocityRowsPerMs,
    config.brakeMs,
    config.advanceRows,
    config.endVelocityRowsPerMs,
    config.bounceMs,
    config.totalMs,
  ];
  if (!values.every(Number.isFinite)) {
    throw new Error("Reel stop motion values must be finite");
  }
  if (values.some((value) => value < 0)) {
    throw new Error("Reel stop motion values must be non-negative");
  }
  if (config.brakeMs + config.bounceMs !== config.totalMs) {
    throw new Error("Reel stop motion durations must add up to totalMs");
  }
  return Object.freeze({
    startRows,
    targetRows: Math.ceil(startRows) + config.advanceRows,
    startVelocityRowsPerMs,
    endVelocityRowsPerMs: config.endVelocityRowsPerMs,
    brakeMs: config.brakeMs,
    bounceMs: config.bounceMs,
    totalMs: config.totalMs,
  });
}

/** 返回从游戏中捕获的三个不可变运动轮廓之一。 / English: Returns one of three immutable motion contours captured from the game. */
export function reelStopMotionConfig(mode: ReelStopMode): ReelStopMotionConfig {
  const config = PRIMAL_REEL_STOP_MOTION_CONFIG[mode];
  if (!config) throw new Error(`Unknown reel stop mode ${String(mode)}`);
  return config;
}

/** 用于官方 NORMAL、FAST 和 SLOW 停止运动的显式模式 API。 / English: Explicit mode API for official NORMAL, FAST and SLOW stop motion. */
export function createReelStopMotionPlanForMode(
  startRows: number,
  startVelocityRowsPerMs: number,
  mode: ReelStopMode,
): ReelStopMotionPlan {
  return buildReelStopMotionPlan(
    startRows,
    startVelocityRowsPerMs,
    reelStopMotionConfig(mode),
  );
}

/**
 * 兼容性 API 为当前调用者保留提供总时间。新的状态机代码应使用 createReelStopMotionPlanForMode 代替。
 *
 * 英文 / English: The Compatibility API provides the total time that the current caller remains available. New state machine code should use createReelStopMotionPlanForMode instead.
 */
export function createReelStopMotionPlan(
  startRows: number,
  startVelocityRowsPerMs: number,
  totalMs: number,
): ReelStopMotionPlan {
  if (!Number.isFinite(totalMs) || totalMs < 0) {
    throw new Error("Reel stop motion values must be finite and non-negative");
  }
  const brakeMs = Math.min(PRIMAL_REEL_TIMING_MS.brake, totalMs);
  return buildReelStopMotionPlan(startRows, startVelocityRowsPerMs, {
    brakeMs,
    advanceRows: REEL_STOP_ADVANCE_ROWS,
    endVelocityRowsPerMs: REEL_STOP_END_SPEED_ROWS_PER_MS,
    bounceMs: Math.max(0, totalMs - brakeMs),
    totalMs,
  });
}

function clampedStopTime(plan: ReelStopMotionPlan, elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs)) return elapsedMs > 0 ? plan.totalMs : 0;
  return Math.min(plan.totalMs, Math.max(0, elapsedMs));
}

/**
 * 仅当视觉制动达到其整数目标后，已确定的叠加才可以取得所有权。语义 STOPPED 可以到达 RAF 样本之间，因此视图使用此门而不是硬切割仍在行进的条带。
 *
 * 英文 / English: An established overlay can only take ownership once the visual brake reaches its integer target. Semantic STOPPED can reach between RAF samples, so the view uses this gate instead of hard-cutting the still-traveling strip.
 */
export function reelStopHasReachedImpact(
  plan: ReelStopMotionPlan,
  elapsedMs: number,
): boolean {
  return plan.brakeMs <= 0 || clampedStopTime(plan, elapsedMs) >= plan.brakeMs;
}

/** 三次埃尔米特制动之后是捕获的正三次反弹。 / English: Triple Hermit braking was followed by a captured positive triple rally. */
export function reelStopPositionRowsAt(
  plan: ReelStopMotionPlan,
  elapsedMs: number,
): number {
  const time = clampedStopTime(plan, elapsedMs);
  if (time >= plan.totalMs) return plan.targetRows;
  if (plan.brakeMs <= 0) return plan.targetRows;
  if (time <= plan.brakeMs) {
    const u = time / plan.brakeMs;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    return h00 * plan.startRows
      + h10 * plan.startVelocityRowsPerMs * plan.brakeMs
      + h01 * plan.targetRows
      + h11 * plan.endVelocityRowsPerMs * plan.brakeMs;
  }
  if (plan.bounceMs <= 0) return plan.targetRows;
  const u = (time - plan.brakeMs) / plan.bounceMs;
  return plan.targetRows
    + plan.endVelocityRowsPerMs * plan.bounceMs * u * (1 - u) ** 2;
}

/** 分析速度保持从同一时钟采样的模糊和停止位置。 / English: Analysis speed maintains blur and stop positions sampled from the same clock. */
export function reelStopVelocityRowsAt(
  plan: ReelStopMotionPlan,
  elapsedMs: number,
): number {
  const time = clampedStopTime(plan, elapsedMs);
  if (time >= plan.totalMs || plan.brakeMs <= 0) return 0;
  if (time <= plan.brakeMs) {
    const u = time / plan.brakeMs;
    const u2 = u * u;
    const dh00 = 6 * u2 - 6 * u;
    const dh10 = 3 * u2 - 4 * u + 1;
    const dh01 = -6 * u2 + 6 * u;
    const dh11 = 3 * u2 - 2 * u;
    return (
      dh00 * plan.startRows
      + dh10 * plan.startVelocityRowsPerMs * plan.brakeMs
      + dh01 * plan.targetRows
      + dh11 * plan.endVelocityRowsPerMs * plan.brakeMs
    ) / plan.brakeMs;
  }
  if (plan.bounceMs <= 0) return 0;
  const u = (time - plan.brakeMs) / plan.bounceMs;
  return plan.endVelocityRowsPerMs * (1 - u) * (1 - 3 * u);
}

/**
 * 用于影响/土地效应的兼容性采样器。 ReelView 位置由 reelStopPositionRowsAt 驱动，因此移动条、模糊和插入单元共享一个时钟。
 * alpha 字段现在描述原子端点切换：永远不会存在条带和结果网格混合的帧。
 *
 * 英文 / English: Compatibility sampler for impact/land effects. ReelView position is driven by reelStopPositionRowsAt, so the moving bar, blur, and inset units share one clock. The alpha field now describes atomic endpoint switching: there is never a frame where the strip and resulting mesh are mixed.
 */
export function reelSettleFrame(
  progress: number,
  cellHeight: number,
  impactProgress = PRIMAL_REEL_IMPACT_PROGRESS,
): ReelSettleFrame {
  const value = clamp01(progress);
  const height = Math.max(1, cellHeight);
  const impact = Math.min(0.999_999, Math.max(0.000_001, impactProgress));
  if (value <= impact) {
    const brake = value / impact;
    const impactReveal = smoothstep((brake - 0.72) / 0.28);
    return {
      motionAlpha: 1,
      motionOffset: 0,
      motionBlurY: mix(17, 0, brake),
      resultAlpha: 0,
      resultOffset: 0,
      resultScaleY: 1,
      resultBlurY: mix(height * 0.075, 0, brake),
      impactAlpha: impactReveal,
    };
  }
  const bounce = (value - impact) / (1 - impact);
  const bounceMs = PRIMAL_REEL_TIMING_MS.brake * (1 - impact) / impact;
  const bounceRows = REEL_STOP_END_SPEED_ROWS_PER_MS * bounceMs
    * bounce * (1 - bounce) ** 2;
  const locked = value >= 1;
  return {
    motionAlpha: locked ? 0 : 1,
    motionOffset: height * bounceRows,
    motionBlurY: 0,
    resultAlpha: locked ? 1 : 0,
    resultOffset: height * bounceRows,
    resultScaleY: 1,
    resultBlurY: 0,
    impactAlpha: 1 - outCubic(Math.min(1, bounce * 3)),
  };
}
