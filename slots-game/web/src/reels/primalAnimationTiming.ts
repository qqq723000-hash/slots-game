/**
 * 动画计时是根据提供的 Primal Rampage 桌面包测量的。
 *
 * 持续时间是从捆绑的 Spine 4.1.24 骨架中读取的。调度程序值是从捕获的游戏控制器中恢复的，而不是从视频中估计的，因此表现代码可以共享一个可审核的事实来源。
 */

export const PRIMAL_SYMBOL_IDLE_FRAME_MS = 1_000 / 24;
export const PRIMAL_SYMBOL_IDLE_MIN_FRAMES = 75;
export const PRIMAL_SYMBOL_IDLE_RANDOM_FRAMES = 25;
export const PRIMAL_SYMBOL_IDLE_COOLDOWN_MS = 1_250;

export const PRIMAL_REEL_TIMING_MS = Object.freeze({
  acceleration: 300,
  firstBrake: 1_500,
  fastFirstBrake: 600,
  brake: 300,
  slowBrake: 3_000,
  bounce: 350,
  fastBounce: 250,
  reelGap: 300,
  fastReelGap: 150,
});

/** 原生第三卷预期 `in`/`hide` 剪辑持续时间。 */
export const PRIMAL_REEL_ANTICIPATION_TRANSITION_MS = 333.333;

export const PRIMAL_REEL_SETTLE_MS =
  PRIMAL_REEL_TIMING_MS.brake + PRIMAL_REEL_TIMING_MS.bounce;
export const PRIMAL_REEL_IMPACT_PROGRESS =
  PRIMAL_REEL_TIMING_MS.brake / PRIMAL_REEL_SETTLE_MS;
export const PRIMAL_FAST_REEL_SETTLE_MS =
  PRIMAL_REEL_TIMING_MS.brake + PRIMAL_REEL_TIMING_MS.fastBounce;
export const PRIMAL_FAST_REEL_IMPACT_PROGRESS =
  PRIMAL_REEL_TIMING_MS.brake / PRIMAL_FAST_REEL_SETTLE_MS;

export const PRIMAL_EXPANSION_TIMING_MS = Object.freeze({
  controllerDelay: 450,
  resize: 1_000,
  shrinkDataDelay: 450,
  shrinkResizeDelay: 900,
});

export const PRIMAL_SYMBOL_ANIMATION_MS = Object.freeze({
  0: Object.freeze({ explosion: 766.7, hide: 333.3, land: 500, stop: 0, win: 1_333.3 }),
  1: Object.freeze({ explosion: 766.7, hide: 333.3, land: 500, stop: 0, win: 1_333.3 }),
  2: Object.freeze({ explosion: 766.7, idle: 1_800, land: 500, stop: 0, win: 1_333.333 }),
  3: Object.freeze({ explosion: 766.7, idle: 1_833.333, land: 500, stop: 0, win: 1_333.333 }),
  4: Object.freeze({ explosion: 766.7, idle: 2_000, land: 500, stop: 0, win: 1_333.333 }),
  5: Object.freeze({ explosion: 766.7, idle: 2_000, land: 500, stop: 0, win: 1_333.333 }),
  6: Object.freeze({ idle: 2_000, land: 500, reveal: 1_000, stop: 0, win: 1_000 }),
  7: Object.freeze({
    collect: 1_000,
    explosion: 766.7,
    eyeLoop: 700,
    featureActivation: 2_000,
    hide: 166.7,
    idle: 3_533.334,
    idleBreaker: 2_000,
    land: 500,
    show: 1_333.333,
    stop: 0,
    wait: 1_000,
    waitIn: 166.7,
    waitOut: 166.7,
  }),
  8: Object.freeze({
    idle: 1_766.667,
    land: 500,
    stop: 0,
    teaseIn: 666.7,
    teaseLoop: 900,
    teaseOut: 1_100,
    unlockBackup: 1_500,
  }),
  9: Object.freeze({
    featureActivation: 1_533.333,
    idle: 1_766.7,
    land: 500,
    stop: 0,
    teaseIn: 666.7,
    teaseLoop: 900,
    teaseOut: 1_100,
    twoTimesGlow: 266.667,
    upgrade: 833.333,
    win: 1_533.333,
  }),
});

export interface PrimalSymbolIdleClip {
  readonly animation: "idle";
  readonly durationMs: number;
}

/**
 * 从 GameSymbol.idle()/playIdle() 恢复了确切的客户端 ID 资格。 LP1/LP2 (0/1)故意没有空闲夹子。
 * Symbol7还包含2秒的`idle_breaker`，但捕获的GameIdleController始终调用`playSpine("idle")`；
 * 该辅助剪辑不得进入此时间表。
 */
export const PRIMAL_SYMBOL_IDLE_CLIP_BY_CLIENT_ID: Readonly<
  Record<number, PrimalSymbolIdleClip | null>
> = Object.freeze({
  0: null,
  1: null,
  2: Object.freeze({ animation: "idle", durationMs: PRIMAL_SYMBOL_ANIMATION_MS[2].idle }),
  3: Object.freeze({ animation: "idle", durationMs: PRIMAL_SYMBOL_ANIMATION_MS[3].idle }),
  4: Object.freeze({ animation: "idle", durationMs: PRIMAL_SYMBOL_ANIMATION_MS[4].idle }),
  5: Object.freeze({ animation: "idle", durationMs: PRIMAL_SYMBOL_ANIMATION_MS[5].idle }),
  6: Object.freeze({ animation: "idle", durationMs: PRIMAL_SYMBOL_ANIMATION_MS[6].idle }),
  7: Object.freeze({ animation: "idle", durationMs: PRIMAL_SYMBOL_ANIMATION_MS[7].idle }),
  8: Object.freeze({ animation: "idle", durationMs: PRIMAL_SYMBOL_ANIMATION_MS[8].idle }),
  9: Object.freeze({ animation: "idle", durationMs: PRIMAL_SYMBOL_ANIMATION_MS[9].idle }),
});

export const PRIMAL_SYMBOL7_AUXILIARY_IDLE_BREAKER = Object.freeze({
  animation: "idle_breaker" as const,
  durationMs: PRIMAL_SYMBOL_ANIMATION_MS[7].idleBreaker,
  scheduledByGameIdleController: false,
});

export const PRIMAL_SYMBOL_IDLE_MAX_DURATION_MS = Math.max(
  ...Object.values(PRIMAL_SYMBOL_IDLE_CLIP_BY_CLIENT_ID)
    .flatMap((clip) => clip ? [clip.durationMs] : []),
);

/** 第一次空闲事件后的最小启动到启动间隙。 */
export const PRIMAL_SYMBOL_IDLE_MIN_RESTART_GAP_MS =
  PRIMAL_SYMBOL_IDLE_COOLDOWN_MS
  + PRIMAL_SYMBOL_IDLE_MIN_FRAMES * PRIMAL_SYMBOL_IDLE_FRAME_MS;

export function primalSymbolIdleClip(clientId: number): PrimalSymbolIdleClip | null {
  return PRIMAL_SYMBOL_IDLE_CLIP_BY_CLIENT_ID[clientId] ?? null;
}

export const PRIMAL_CHARACTER_ANIMATION_MS = Object.freeze({
  chestPound: 3_833.333,
  featureActivation: 1_666.7,
  featureIdle: 1_166.7,
  idle: 1_666.7,
  idleBreaker: 2_333.333,
  idleBreaker2: 1_666.7,
  idleBreaker3: 1_666.7,
  idleStateLoop: 10_000,
  intro: 8_066.701,
  particlesLoop: 3_666.7,
  pound: 1_000,
  rageCollect: 3_000,
  reelSmash: 900,
  reelStretch: 1_800,
  reelStretchStart: 500,
  reelStretchWaiting: 1_000,
  respin: 1_033.333,
  vault: 1_166.7,
  win: 1_500,
});

export const PRIMAL_REEL_FRAME_ANIMATION_MS = Object.freeze({
  pound: 1_100,
  reelSmash: 1_133.333,
  reelStretch: 1_566.667,
  reelStretchStart: 833.333,
  respin: 1_033.333,
  shake: 500,
  shakeLevel2: 633.333,
  shakeLevel3: 733.333,
  stop: 0,
  vault: 1_266.667,
  vaultLevel2: 1_266.667,
  vaultLevel3: 1_266.667,
});

export const PRIMAL_FEATURE_ANIMATION_MS = Object.freeze({
  wheel: Object.freeze({
    show: 2_500,
    hide: 500,
    idle: 1_000,
    shine: 833.333,
    spinEffect: 1_433.333,
    anticipationLoop: 1_366.667,
    selectionDeceleration: 8_800,
    selectionBounce: 1_000,
  }),
  freeSpinIntro: Object.freeze({ show: 766.667, hide: 533.333, ragsLoop: 2_000 }),
  freeSpinSummary: Object.freeze({
    show: 933.333,
    continueHold: 3_000,
    hide: 1_133.333,
  }),
  freeSpinRetrigger: Object.freeze({ show: 733.333, hide: 733.333 }),
  rageCascade: Object.freeze({
    swing: 390,
    respinShakeDelay: 400,
    perCellExplosion: 60,
    explosionCells: 9,
    cooldown: 500,
    pound: 390,
    poundShakeDelay: 500,
    activationHold: 2_300,
    total: 4_120,
  }),
});

/**
 * GamePPSFeature 在其九单元 Rage 级联之前使用 Fisher-Yates 遍历。单元索引为卷主 (`reel * 3 + row`)，
 * 与捕获的控制器的 `floor(index / ReelHeight)` 地址转换相匹配。
 */
export function primalRageCascadeCellOrder(
  random: () => number = Math.random,
): number[] {
  const order = Array.from(
    { length: PRIMAL_FEATURE_ANIMATION_MS.rageCascade.explosionCells },
    (_, index) => index,
  );
  for (let tail = order.length - 1; tail > 0; tail -= 1) {
    const picked = Math.floor(randomUnit(random()) * (tail + 1));
    const tailValue = order[tail];
    const pickedValue = order[picked];
    if (tailValue === undefined || pickedValue === undefined) continue;
    order[tail] = pickedValue;
    order[picked] = tailValue;
  }
  return order;
}

function randomUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1 - Number.EPSILON, Math.max(0, value));
}

/** 精确的 `(75 + floor(25 * Math.random())) * (1000 / 24)` 捆绑公式。 */
export function primalSymbolIdleDelayMs(random: number): number {
  return (
    PRIMAL_SYMBOL_IDLE_MIN_FRAMES
    + Math.floor(PRIMAL_SYMBOL_IDLE_RANDOM_FRAMES * randomUnit(random))
  ) * PRIMAL_SYMBOL_IDLE_FRAME_MS;
}

/** 原始闲置控制器在资格检查之前使用的 Fisher-Yates 命令。 */
export function primalSymbolIdleOrder(
  count: number,
  random: () => number = Math.random,
): number[] {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Idle symbol count must be a non-negative integer");
  }
  const order = Array.from({ length: count }, (_, index) => index);
  for (let remaining = order.length; remaining > 0; remaining -= 1) {
    const picked = Math.floor(randomUnit(random()) * remaining);
    const tail = remaining - 1;
    const pickedValue = order[picked];
    const tailValue = order[tail];
    if (pickedValue === undefined || tailValue === undefined) continue;
    order[tail] = pickedValue;
    order[picked] = tailValue;
  }
  return order;
}

export type PrimalSymbolIdlePhase = "random-delay" | "cooldown";

export interface PrimalSymbolIdleActivity {
  readonly dormant: boolean;
  readonly spinActive: boolean;
  readonly winPresentationActive: boolean;
  readonly structuralTransitionActive: boolean;
  readonly rageCascadeActive: boolean;
}

/** 在每个活动表现期间，原始空闲集合都不存在。 */
export function primalSymbolIdleShouldRun(activity: PrimalSymbolIdleActivity): boolean {
  return !activity.dormant
    && !activity.spinActive
    && !activity.winPresentationActive
    && !activity.structuralTransitionActive
    && !activity.rageCascadeActive;
}

/**
 * 镜像自 VideoSlotIdleController.idleHandler 的两态调度器。
 * 一个 `true` 结果意味着调用者应该打乱可见符号并启动不超过一个符合条件的非循环空闲动画。
 */
export class PrimalSymbolIdleTimer {
  private phaseValue: PrimalSymbolIdlePhase = "random-delay";
  private remainingValue = 0;

  constructor(
    private readonly random: () => number = Math.random,
    startImmediately = true,
  ) {
    if (startImmediately) this.reset();
  }

  get phase(): PrimalSymbolIdlePhase {
    return this.phaseValue;
  }

  get remainingMs(): number {
    return this.remainingValue;
  }

  reset(): void {
    this.phaseValue = "random-delay";
    this.remainingValue = primalSymbolIdleDelayMs(this.random());
  }

  advance(deltaMs: number): boolean {
    const elapsed = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0;
    if (elapsed < this.remainingValue) {
      this.remainingValue -= elapsed;
      return false;
    }

    // 捕获的调度程序对每个状态使用一个延迟回调。如果隐藏选项卡恢复较晚，它将执行该回调一次，并从 "now" 开始下一个完整延迟；经过的墙时间从不用于捕获一帧中的多个空闲事件。
    if (this.phaseValue === "random-delay") {
      this.phaseValue = "cooldown";
      this.remainingValue = PRIMAL_SYMBOL_IDLE_COOLDOWN_MS;
      return true;
    }

    this.phaseValue = "random-delay";
    this.remainingValue = primalSymbolIdleDelayMs(this.random());
    return false;
  }
}
