export const PRIMAL_WHEEL_SEGMENTS = Object.freeze([
  "MEGA",
  "KONG QUEST",
  "MINOR",
  "GRAND",
  "KING SPIN",
  "MAJOR",
  "MINI",
] as const);

export type PrimalWheelSegment = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type PrimalWheelSpeed = "normal" | "fast";

export const PRIMAL_WHEEL_AWARD_IDS = Object.freeze([
  47,
  51,
  43,
  49,
  50,
  45,
  41,
] as const);

const SEGMENT_BY_AWARD_ID: ReadonlyMap<number, PrimalWheelSegment> = new Map([
  [47, 0],
  [51, 1],
  [43, 2],
  [49, 3],
  [50, 4],
  [45, 5],
  [41, 6],
]);

const SEGMENT_BY_LABEL: Readonly<Record<string, PrimalWheelSegment>> = Object.freeze({
  MEGA: 0,
  EXPANSION: 1,
  KONG_QUEST: 1,
  MINOR: 2,
  GRAND: 3,
  OVERDRIVE: 4,
  KING_SPIN: 4,
  MAJOR: 5,
  MINI: 6,
});

export const PRIMAL_WHEEL_POPUP_TIMELINE_MS = Object.freeze({
  show: 2_500,
  reelFade: 1_000,
});

/** 所有值在玩家的独特 Wheel Spin 手势处都使用 S=0。 / English: All values ​​use S=0 at the player's unique Wheel Spin gesture. */
export const PRIMAL_WHEEL_TIMELINE_MS = Object.freeze({
  idleAcceleration: 200,
  configuredStop: 10_000,
  selectionDeceleration: 8_800,
  selectionReserve: 1_000,
  landing: 9_800,
  fastConfiguredStop: 3_000,
  fastSelectionDeceleration: 1_800,
  fastLanding: 2_800,
  highlightHold: 1_200,
  postHighlightHold: 750,
  summaryShowAt: 11_750,
  summaryShow: 1_066.7,
  summaryStopAt: 12_816.7,
  summaryContinueHold: 3_000,
  summaryHideAt: 15_816.7,
  wheelHide: 500,
  summaryHide: 666.7,
  reelFade: 1_000,
  total: 16_816.7,
});

/** 弹出+正常未跳过的S路径。排除无限期就绪门。 / English: Pop + normal unskipped S path. Exclude indefinitely ready gates. */
export const PRIMAL_WHEEL_BOUNDED_PRESENTATION_MS =
  PRIMAL_WHEEL_POPUP_TIMELINE_MS.show + PRIMAL_WHEEL_TIMELINE_MS.total;

export const WHEEL_CHARACTER_TIMING_MS = Object.freeze({
  chestPoundStart: 0,
  chestPoundFinish: PRIMAL_WHEEL_TIMELINE_MS.landing,
});

export interface PrimalWheelAwardSelection {
  readonly awardId?: number;
  readonly segment?: number;
  readonly prize?: string;
  readonly outcome?: string;
}

export interface PrimalWheelIdleState {
  readonly stage: "idle-acceleration" | "idle";
  readonly elapsedMs: number;
  readonly positionSectors: number;
  readonly velocitySectorsPerMs: number;
  readonly rotationDegrees: number;
}

export interface PrimalWheelSpinPlan {
  readonly segment: PrimalWheelSegment;
  readonly speed: PrimalWheelSpeed;
  readonly startPositionSectors: number;
  readonly startVelocitySectorsPerMs: number;
  readonly targetPositionSectors: number;
  readonly curveTargetPositionSectors: number;
  readonly finalPositionSectors: number;
  readonly stopOffsetSectors: number;
  readonly bounceAmplitudeSectors: 0;
  readonly configuredStopMs: number;
  readonly decelerationMs: number;
  readonly reserveMs: number;
  readonly landingMs: number;
  readonly curve1: number;
  readonly curve2: number;
  readonly curve3: number;
  readonly curve4: number;
}

export type PrimalWheelSpinStage = "stopping" | "stop-reserve" | "landed";

export interface PrimalWheelSpinFrame {
  readonly stage: PrimalWheelSpinStage;
  readonly elapsedMs: number;
  readonly positionSectors: number;
  readonly rotationDegrees: number;
  readonly anticipationEligible: boolean;
}

export interface PrimalWheelRuntimeTimeline {
  readonly selectionDeceleration: number;
  readonly selectionReserve: number;
  readonly landing: number;
  readonly highlightHold: number;
  readonly postHighlightHold: number;
  readonly summaryShowAt: number;
  readonly summaryShow: number;
  readonly summaryStopAt: number;
  readonly summaryContinueHold: number;
  readonly summaryHideAt: number;
  readonly wheelHide: number;
  readonly summaryHide: number;
  readonly reelFade: number;
  readonly total: number;
}

function normalizeLabel(value: string): string {
  return value.trim().toUpperCase().replace(/[ -]+/g, "_");
}

function asSegment(value: number, label: string): PrimalWheelSegment {
  if (!Number.isInteger(value) || value < 0 || value >= PRIMAL_WHEEL_SEGMENTS.length) {
    throw new Error(`${label} must be an integer from 0 through 6`);
  }
  return value as PrimalWheelSegment;
}

function requireFiniteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
  return value;
}

function wrapSectors(value: number): number {
  return ((value % PRIMAL_WHEEL_SEGMENTS.length) + PRIMAL_WHEEL_SEGMENTS.length)
    % PRIMAL_WHEEL_SEGMENTS.length;
}

export function primalWheelRotationDegrees(positionSectors: number): number {
  if (!Number.isFinite(positionSectors)) {
    throw new Error("Wheel position must be finite");
  }
  return (1 - 2 * wrapSectors(positionSectors)) * 180 / PRIMAL_WHEEL_SEGMENTS.length;
}

/**
 * 仅从显式片段、官方奖项 ID 或权威命名的奖项/结果解析表现几何。未知的输入永远不会收到修饰哈希或乘数派生的回退路径。
 *
 * 英文 / English: Resolve performance geometry only from explicit fragments, official award IDs, or authoritatively named awards/results. Unknown inputs never receive a decorated hash or multiplier-derived fallback path.
 */
export function resolvePrimalWheelSegment(
  selection: PrimalWheelAwardSelection | string | number,
): PrimalWheelSegment {
  const source: PrimalWheelAwardSelection = typeof selection === "number"
    ? { awardId: selection }
    : typeof selection === "string" ? { outcome: selection } : selection;
  const candidates: PrimalWheelSegment[] = [];

  if (source.segment !== undefined) {
    candidates.push(asSegment(source.segment, "Wheel segment"));
  }
  if (source.awardId !== undefined) {
    if (!Number.isSafeInteger(source.awardId)) {
      throw new Error("Wheel award id must be a safe integer");
    }
    const awardSegment = SEGMENT_BY_AWARD_ID.get(source.awardId);
    if (awardSegment === undefined) {
      throw new Error(`Unknown Primal Wheel award id ${source.awardId}`);
    }
    candidates.push(awardSegment);
  }
  for (const label of [source.prize, source.outcome]) {
    if (!label) continue;
    const namedSegment = SEGMENT_BY_LABEL[normalizeLabel(label)];
    if (namedSegment !== undefined) candidates.push(namedSegment);
  }

  const segment = candidates[0];
  if (segment === undefined) {
    throw new Error("Primal Wheel result requires an authoritative award id, segment, or named prize");
  }
  if (candidates.some((candidate) => candidate !== segment)) {
    throw new Error("Primal Wheel result contains conflicting authoritative segments");
  }
  return segment;
}

/** 空闲旋转器从零开始，在 200ms 之后达到 0.0001 扇区/毫秒。 / English: The idle spinner starts at zero and reaches 0.0001 sectors/ms after 200ms. */
export function primalWheelIdleState(
  elapsedMs: number,
  initialPositionSectors = 0,
): PrimalWheelIdleState {
  const elapsed = requireFiniteNonNegative(elapsedMs, "Wheel idle elapsed time");
  if (!Number.isFinite(initialPositionSectors)) {
    throw new Error("Wheel initial position must be finite");
  }
  const targetVelocity = 0.0001;
  const accelerationDuration = PRIMAL_WHEEL_TIMELINE_MS.idleAcceleration;
  const acceleration = targetVelocity / accelerationDuration;
  const accelerating = elapsed < accelerationDuration;
  const accelerationPosition = acceleration * accelerationDuration ** 2 / 2;
  const position = accelerating
    ? initialPositionSectors + acceleration * elapsed ** 2 / 2
    : initialPositionSectors + accelerationPosition
      + targetVelocity * (elapsed - accelerationDuration);
  const velocity = accelerating ? acceleration * elapsed : targetVelocity;
  const wrappedPosition = wrapSectors(position);
  return Object.freeze({
    stage: accelerating ? "idle-acceleration" : "idle",
    elapsedMs: elapsed,
    positionSectors: wrappedPosition,
    velocitySectorsPerMs: velocity,
    rotationDegrees: primalWheelRotationDegrees(wrappedPosition),
  });
}

function validateStopOffset(stopOffsetSectors: number): number {
  if (!Number.isFinite(stopOffsetSectors)
    || stopOffsetSectors < -0.15
    || stopOffsetSectors >= 0.15) {
    throw new Error("Wheel stop offset must be within the captured [-0.15, 0.15) sector range");
  }
  return stopOffsetSectors;
}

/** 从实时空闲 p0/v0 构建不可变的官方停止多项式。 / English: Construct immutable official stopping polynomials from real-time idle p0/v0. */
export function createPrimalWheelSpinPlan(options: {
  readonly segment: number;
  readonly launchState: Pick<
    PrimalWheelIdleState,
    "positionSectors" | "velocitySectorsPerMs"
  >;
  readonly stopOffsetSectors?: number;
  readonly speed?: PrimalWheelSpeed;
}): PrimalWheelSpinPlan {
  const segment = asSegment(options.segment, "Wheel target segment");
  const startPosition = wrapSectors(options.launchState.positionSectors);
  if (!Number.isFinite(options.launchState.positionSectors)) {
    throw new Error("Wheel launch position must be finite");
  }
  const startVelocity = requireFiniteNonNegative(
    options.launchState.velocitySectorsPerMs,
    "Wheel launch velocity",
  );
  const stopOffset = validateStopOffset(options.stopOffsetSectors ?? 0);
  const speed = options.speed ?? "normal";
  if (speed !== "normal" && speed !== "fast") {
    throw new Error("Wheel speed must be normal or fast");
  }

  let targetPosition = segment;
  while (targetPosition - startPosition < 40) {
    targetPosition += PRIMAL_WHEEL_SEGMENTS.length;
  }
  if (speed === "normal") targetPosition += PRIMAL_WHEEL_SEGMENTS.length;

  const genericFastConfiguredStop = Math.max(
    3_000,
    Math.min(5_000, (targetPosition - startPosition) * 90 * 0.6),
  );
  const configuredStop = speed === "fast"
    ? genericFastConfiguredStop
    : PRIMAL_WHEEL_TIMELINE_MS.configuredStop;
  const reserve = PRIMAL_WHEEL_TIMELINE_MS.selectionReserve;
  const deceleration = configuredStop
    - PRIMAL_WHEEL_TIMELINE_MS.idleAcceleration
    - reserve;
  const curveTarget = targetPosition + stopOffset;
  const curve1 = startVelocity * deceleration;
  const curve2 = -6 * startPosition + 6 * curveTarget - 3 * curve1;
  const curve3 = 8 * startPosition - 8 * curveTarget + 3 * curve1;
  const curve4 = -3 * startPosition + 3 * curveTarget - curve1;

  // 捕获的范围完全低于通用微调器的 0.45 阈值。 / English: The captured range is well below the 0.45 threshold of the universal spinner.
  const bounceAmplitude = stopOffset < 0.45 ? 0 : -1.5 * (stopOffset - 0.45);
  if (bounceAmplitude !== 0) {
    throw new Error("Captured Primal Wheel offsets must have zero bounce amplitude");
  }

  return Object.freeze({
    segment,
    speed,
    startPositionSectors: startPosition,
    startVelocitySectorsPerMs: startVelocity,
    targetPositionSectors: targetPosition,
    curveTargetPositionSectors: curveTarget,
    finalPositionSectors: targetPosition + stopOffset,
    stopOffsetSectors: stopOffset,
    bounceAmplitudeSectors: 0,
    configuredStopMs: configuredStop,
    decelerationMs: deceleration,
    reserveMs: reserve,
    landingMs: deceleration + reserve,
    curve1,
    curve2,
    curve3,
    curve4,
  });
}

/**
 * 在第一个接受的快速停止后，将挂钟 S 时间映射到 Spinner 时间。 STOPPING 之外的请求无效。接受的请求跳转到曲线端点，并且仍然保留完整的一秒停止预留来运行。
 *
 * 英文 / English: Maps the wall clock S time to the spinner time after the first accepted quick stop. Requests other than STOPPING are invalid. Accepted requests jump to the curve endpoint and still retain a full one-second stop reservation to run.
 */
export function primalWheelQuickStopElapsed(
  spinElapsedMs: number,
  quickStopAtMs: number | null,
  plan: PrimalWheelSpinPlan,
): number {
  const elapsed = requireFiniteNonNegative(spinElapsedMs, "Wheel spin elapsed time");
  if (quickStopAtMs === null) return elapsed;
  const quickStopAt = requireFiniteNonNegative(quickStopAtMs, "Wheel quick-stop time");
  if (quickStopAt >= plan.decelerationMs || elapsed < quickStopAt) return elapsed;
  return plan.decelerationMs + elapsed - quickStopAt;
}

export function primalWheelSpinFrame(
  plan: PrimalWheelSpinPlan,
  spinElapsedMs: number,
): PrimalWheelSpinFrame {
  const elapsed = requireFiniteNonNegative(spinElapsedMs, "Wheel spin elapsed time");
  let stage: PrimalWheelSpinStage;
  let position: number;
  if (elapsed < plan.decelerationMs) {
    const progress = elapsed / plan.decelerationMs;
    position = (((plan.curve4 * progress + plan.curve3) * progress + plan.curve2)
      * progress + plan.curve1) * progress + plan.startPositionSectors;
    stage = "stopping";
  } else if (elapsed < plan.landingMs) {
    position = plan.finalPositionSectors;
    stage = "stop-reserve";
  } else {
    position = plan.finalPositionSectors;
    stage = "landed";
  }
  return {
    stage,
    elapsedMs: elapsed,
    positionSectors: position,
    rotationDegrees: primalWheelRotationDegrees(position),
    anticipationEligible: stage === "stopping"
      && elapsed / plan.decelerationMs > 0.5,
  };
}

export function primalWheelRuntimeTimeline(
  plan: PrimalWheelSpinPlan,
): PrimalWheelRuntimeTimeline {
  const summaryShowAt = plan.landingMs
    + PRIMAL_WHEEL_TIMELINE_MS.highlightHold
    + PRIMAL_WHEEL_TIMELINE_MS.postHighlightHold;
  const summaryStopAt = summaryShowAt + PRIMAL_WHEEL_TIMELINE_MS.summaryShow;
  const summaryHideAt = summaryStopAt + PRIMAL_WHEEL_TIMELINE_MS.summaryContinueHold;
  return Object.freeze({
    selectionDeceleration: plan.decelerationMs,
    selectionReserve: plan.reserveMs,
    landing: plan.landingMs,
    highlightHold: PRIMAL_WHEEL_TIMELINE_MS.highlightHold,
    postHighlightHold: PRIMAL_WHEEL_TIMELINE_MS.postHighlightHold,
    summaryShowAt,
    summaryShow: PRIMAL_WHEEL_TIMELINE_MS.summaryShow,
    summaryStopAt,
    summaryContinueHold: PRIMAL_WHEEL_TIMELINE_MS.summaryContinueHold,
    summaryHideAt,
    wheelHide: PRIMAL_WHEEL_TIMELINE_MS.wheelHide,
    summaryHide: PRIMAL_WHEEL_TIMELINE_MS.summaryHide,
    reelFade: PRIMAL_WHEEL_TIMELINE_MS.reelFade,
    total: summaryHideAt + Math.max(
      PRIMAL_WHEEL_TIMELINE_MS.wheelHide,
      PRIMAL_WHEEL_TIMELINE_MS.summaryHide,
      PRIMAL_WHEEL_TIMELINE_MS.reelFade,
    ),
  });
}

export function primalWheelLandingAngle(
  selection: PrimalWheelAwardSelection | string | number,
  stopOffsetSectors = 0,
): number {
  const segment = resolvePrimalWheelSegment(selection);
  validateStopOffset(stopOffsetSectors);
  return primalWheelRotationDegrees(segment + stopOffsetSectors) * Math.PI / 180;
}
