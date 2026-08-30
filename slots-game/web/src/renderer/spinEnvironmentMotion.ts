export type SpinEnvironmentFeatureKind = "expansion" | "vault" | "wheel" | "collect" | "rage";

export interface SpinEnvironmentImpactEvent {
  readonly generation: number;
  readonly reel: number;
  readonly atMs: number;
  readonly fastForward: boolean;
}

export interface SpinEnvironmentFeatureCue {
  readonly kind: SpinEnvironmentFeatureKind;
  readonly atMs: number;
  readonly durationMs: number;
  readonly reducedMotion: boolean;
  /** -1、0 和 1 将语义打击与左、中或右卷轴对齐。 / English: -1, 0 and 1 align the semantic strike to the left, center or right scroll. */
  readonly bias?: number;
}

interface ActiveFeatureCue extends SpinEnvironmentFeatureCue {
  readonly generation: number;
}

export interface SpinEnvironmentState {
  readonly generation: number;
  readonly phase: "idle" | "spinning" | "finishing";
  readonly reducedMotion: boolean;
  readonly startedAtMs: number;
  readonly finishAtMs: number | null;
  readonly fastStopAtMs: number | null;
  readonly impacts: readonly SpinEnvironmentImpactEvent[];
  readonly feature: ActiveFeatureCue | null;
}

export interface SpinEnvironmentFrame {
  /** 标准化化妆品卷轴电机能量。它从来不代表游戏结果。 / English: Standardized cosmetic reel motor energy. It never represents the outcome of the game. */
  readonly spinEnergy: number;
  /** 附加粒子速率提升；零表示正常闲置气氛。 / English: Attached particle rate increased; zero represents normal idle atmosphere. */
  readonly smokeBoost: number;
  readonly emberBoost: number;
  readonly vignetteAlpha: number;
  readonly warmFlash: number;
  readonly floorDust: number;
  readonly eyeBoost: number;
  /** -1..1，仅用于定位卷轴冲击附近的反射。 / English: -1..1, used only to locate reflections near reel impacts. */
  readonly impactBias: number;
  readonly featureAura: number;
}

export const IDLE_SPIN_ENVIRONMENT_FRAME: SpinEnvironmentFrame = Object.freeze({
  spinEnergy: 0,
  smokeBoost: 0,
  emberBoost: 0,
  vignetteAlpha: 0,
  warmFlash: 0,
  floorDust: 0,
  eyeBoost: 0,
  impactBias: 0,
  featureAura: 0,
});

const SPIN_RAMP_MS = 240;
const SPIN_FINISH_MS = 260;
const IMPACT_DURATION_MS = 180;
const REDUCED_LIGHT_MS = 90;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampSigned(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

function smooth(value: number): number {
  const progress = clamp01(value);
  return progress * progress * (3 - 2 * progress);
}

function finiteTime(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite time`);
  return value;
}

export function createSpinEnvironmentState(): SpinEnvironmentState {
  return {
    generation: 0,
    phase: "idle",
    reducedMotion: false,
    startedAtMs: 0,
    finishAtMs: null,
    fastStopAtMs: null,
    impacts: [],
    feature: null,
  };
}

export function beginSpinEnvironment(
  state: SpinEnvironmentState,
  atMs: number,
  reducedMotion: boolean,
): SpinEnvironmentState {
  return {
    generation: state.generation + 1,
    phase: "spinning",
    reducedMotion,
    startedAtMs: finiteTime(atMs, "Spin start"),
    finishAtMs: null,
    fastStopAtMs: null,
    impacts: [],
    feature: null,
  };
}

export function markSpinFastStop(state: SpinEnvironmentState, atMs: number): SpinEnvironmentState {
  if (state.phase !== "spinning" || state.fastStopAtMs !== null) return state;
  return { ...state, fastStopAtMs: finiteTime(atMs, "Fast stop") };
}

export function addSpinReelImpact(
  state: SpinEnvironmentState,
  event: SpinEnvironmentImpactEvent,
): SpinEnvironmentState {
  if (event.generation !== state.generation || state.phase === "idle") return state;
  if (!Number.isSafeInteger(event.reel) || event.reel < 0 || event.reel > 2) {
    throw new Error("Reel impact index must be 0, 1, or 2");
  }
  const impact = { ...event, atMs: finiteTime(event.atMs, "Reel impact") };
  return { ...state, impacts: [...state.impacts.slice(-5), impact] };
}

export function finishSpinEnvironment(state: SpinEnvironmentState, atMs: number): SpinEnvironmentState {
  if (state.phase === "idle") return state;
  return {
    ...state,
    phase: "finishing",
    finishAtMs: state.finishAtMs ?? finiteTime(atMs, "Spin finish"),
  };
}

export function triggerFeatureEnvironment(
  state: SpinEnvironmentState,
  cue: SpinEnvironmentFeatureCue,
): SpinEnvironmentState {
  const atMs = finiteTime(cue.atMs, "Feature start");
  if (!Number.isFinite(cue.durationMs) || cue.durationMs <= 0) {
    throw new Error("Feature duration must be a positive finite time");
  }
  const feature: ActiveFeatureCue = {
    ...cue,
    atMs,
    bias: cue.bias === undefined ? undefined : clampSigned(cue.bias),
    generation: state.generation,
  };
  return { ...state, feature };
}

export function resetSpinEnvironment(state: SpinEnvironmentState): SpinEnvironmentState {
  return {
    generation: state.generation + 1,
    phase: "idle",
    reducedMotion: state.reducedMotion,
    startedAtMs: 0,
    finishAtMs: null,
    fastStopAtMs: null,
    impacts: [],
    feature: null,
  };
}

function spinEnergyAt(state: SpinEnvironmentState, atMs: number): number {
  if (state.phase === "idle" || atMs < state.startedAtMs) return 0;
  const ramp = smooth((atMs - state.startedAtMs) / SPIN_RAMP_MS);
  if (state.phase === "spinning" || state.finishAtMs === null) {
    if (state.fastStopAtMs === null || atMs <= state.fastStopAtMs) return ramp;
    // 快速停止可压缩表现流程，而不会增加亮度峰值。 / English: Quick stop compresses the rendering process without increasing brightness peaks.
    return ramp * (1 - smooth((atMs - state.fastStopAtMs) / 110) * 0.22);
  }
  if (atMs < state.finishAtMs) return ramp;
  return ramp * (1 - smooth((atMs - state.finishAtMs) / SPIN_FINISH_MS));
}

function impactEnvelope(ageMs: number): number {
  if (ageMs < 0 || ageMs >= IMPACT_DURATION_MS) return 0;
  const progress = ageMs / IMPACT_DURATION_MS;
  const decay = (1 - progress) ** 2;
  return decay * (0.84 + Math.cos(progress * Math.PI * 4) * 0.16);
}

function featureEnvelope(cue: ActiveFeatureCue, atMs: number): number {
  const progress = (atMs - cue.atMs) / cue.durationMs;
  if (progress < 0 || progress >= 1) return 0;
  const attack = smooth(progress / 0.16);
  const release = 1 - smooth((progress - 0.78) / 0.22);
  return Math.min(attack, release);
}

interface FeatureValues {
  readonly smokeBoost: number;
  readonly emberBoost: number;
  readonly vignetteAlpha: number;
  readonly warmFlash: number;
  readonly floorDust: number;
  readonly eyeBoost: number;
  readonly featureAura: number;
}

const FEATURE_VALUES: Record<SpinEnvironmentFeatureKind, FeatureValues> = {
  expansion: {
    smokeBoost: 0.1,
    emberBoost: 0.1,
    vignetteAlpha: 0.1,
    warmFlash: 0.06,
    floorDust: 0.12,
    eyeBoost: 0.16,
    featureAura: 0.24,
  },
  vault: {
    smokeBoost: 0.12,
    emberBoost: 0.18,
    vignetteAlpha: 0.11,
    warmFlash: 0.3,
    floorDust: 0.48,
    eyeBoost: 0.28,
    featureAura: 0.38,
  },
  wheel: {
    smokeBoost: 0.12,
    emberBoost: 0.22,
    vignetteAlpha: 0.15,
    warmFlash: 0.2,
    floorDust: 0.2,
    eyeBoost: 0.74,
    featureAura: 1,
  },
  collect: {
    smokeBoost: 0.04,
    emberBoost: 0.12,
    vignetteAlpha: 0.07,
    warmFlash: 0.1,
    floorDust: 0.08,
    eyeBoost: 0.3,
    featureAura: 0.26,
  },
  rage: {
    smokeBoost: 0.08,
    emberBoost: 0.3,
    vignetteAlpha: 0.11,
    warmFlash: 0.22,
    floorDust: 0.22,
    eyeBoost: 0.86,
    featureAura: 0.7,
  },
};

/**
 * 从绝对单调的时间中采样装饰场景的链接。返回的值不能选择符号、计算中奖或更改服务器状态。
 *
 * 英文 / English: Links that sample decorative scenes from an absolutely monotonous time. The returned value cannot be used to select symbols, calculate wins, or change server status.
 */
export function sampleSpinEnvironment(state: SpinEnvironmentState, atMs: number): SpinEnvironmentFrame {
  const time = finiteTime(atMs, "Environment sample");
  const energy = spinEnergyAt(state, time);
  let impactTotal = 0;
  let weightedBias = 0;
  for (const impact of state.impacts) {
    if (impact.generation !== state.generation) continue;
    const envelope = impactEnvelope(time - impact.atMs) * (impact.fastForward ? 0.92 : 0.72);
    impactTotal += envelope;
    weightedBias += envelope * (impact.reel - 1);
  }
  const impact = 1 - Math.exp(-impactTotal);
  const impactBias = impactTotal > 0 ? clampSigned(weightedBias / impactTotal) : 0;

  const cue = state.feature?.generation === state.generation ? state.feature : null;
  const featureProgress = cue ? featureEnvelope(cue, time) : 0;
  const featureValues = cue ? FEATURE_VALUES[cue.kind] : null;

  if (state.reducedMotion || cue?.reducedMotion) {
    const cueAge = cue ? time - cue.atMs : Number.POSITIVE_INFINITY;
    const impactAge = state.impacts.reduce((youngest, item) => Math.min(youngest, time - item.atMs), Number.POSITIVE_INFINITY);
    const lightAge = Math.min(cueAge, impactAge);
    const reducedEnvelope = lightAge >= 0 && lightAge < REDUCED_LIGHT_MS
      ? 1 - lightAge / REDUCED_LIGHT_MS
      : 0;
    return {
      ...IDLE_SPIN_ENVIRONMENT_FRAME,
      vignetteAlpha: reducedEnvelope * 0.025,
      warmFlash: reducedEnvelope * 0.06,
      eyeBoost: reducedEnvelope * 0.12,
      featureAura: cue ? reducedEnvelope * 0.06 : 0,
    };
  }

  const feature = featureValues && featureProgress > 0
    ? {
      smokeBoost: featureValues.smokeBoost * featureProgress,
      emberBoost: featureValues.emberBoost * featureProgress,
      vignetteAlpha: featureValues.vignetteAlpha * featureProgress,
      warmFlash: featureValues.warmFlash * featureProgress,
      floorDust: featureValues.floorDust * featureProgress,
      eyeBoost: featureValues.eyeBoost * featureProgress,
      featureAura: featureValues.featureAura * featureProgress,
    }
    : IDLE_SPIN_ENVIRONMENT_FRAME;

  return {
    spinEnergy: energy,
    smokeBoost: Math.max(energy * 0.08, feature.smokeBoost),
    emberBoost: Math.max(energy * 0.18, impact * 0.08, feature.emberBoost),
    vignetteAlpha: Math.max(energy * 0.045, feature.vignetteAlpha),
    warmFlash: clamp01(Math.max(impact * 0.1, feature.warmFlash)),
    floorDust: clamp01(Math.max(impact * 0.14, feature.floorDust)),
    eyeBoost: clamp01(Math.max(impact * 0.04, feature.eyeBoost)),
    impactBias: featureProgress > impact && cue?.bias !== undefined ? cue.bias : impactBias,
    featureAura: clamp01(feature.featureAura),
  };
}
