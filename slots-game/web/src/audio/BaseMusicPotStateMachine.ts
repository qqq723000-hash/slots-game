export const BASE_MUSIC_POT_THRESHOLDS = Object.freeze([1, 2] as const);
export const BASE_MUSIC_POT_MAX_MULTIPLIER = 5;
export const BASE_MUSIC_POT_LEVEL_LINGER_SECONDS = 5;
export const BASE_MUSIC_POT_IDLE_DOWNGRADE_SECONDS = 30;

export type BaseMusicPotLevel = 0 | 1;
export type BaseMusicPotReduceRate = "0.1" | "0.2" | "0.4";

export interface BaseMusicPotLevelChange {
  readonly previousLevel: BaseMusicPotLevel;
  readonly level: BaseMusicPotLevel;
}

export interface BaseMusicPotStateMachineOptions {
  readonly onLevelChange?: (change: BaseMusicPotLevelChange) => void;
}

export interface BaseMusicPotSnapshot {
  readonly betMinor: string | null;
  /** 精确的十进制小单位；需要时保留十分之一的小数。 / English: Precise decimal units; rounded to tenths when required. */
  readonly potMinor: string;
  readonly reduceRate: BaseMusicPotReduceRate;
  readonly level: BaseMusicPotLevel;
  readonly idle: boolean;
  readonly docked: boolean;
  readonly roundOpen: boolean;
  readonly secondsSinceLastSpin: number;
  readonly secondsSinceLastLevelChange: number;
  readonly pendingTickMs: number;
}

type ReduceRateTenths = 1 | 2 | 4;

const TENTHS_PER_MINOR = 10n;
const TICK_MS = 1_000;
const MIN_REDUCE_RATE_TENTHS: ReduceRateTenths = 1;
const MAX_REDUCE_RATE_TENTHS: ReduceRateTenths = 4;

function parseMinor(value: string, name: string, allowZero: boolean): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${name} must be a canonical non-negative decimal minor string`);
  }
  const parsed = BigInt(value);
  if (!allowZero && parsed === 0n) throw new RangeError(`${name} must be greater than zero`);
  return parsed;
}

function formatTenthsOfMinor(value: bigint): string {
  const whole = value / TENTHS_PER_MINOR;
  const tenth = value % TENTHS_PER_MINOR;
  return tenth === 0n ? whole.toString() : `${whole}.${tenth}`;
}

function reduceRateLabel(rate: ReduceRateTenths): BaseMusicPotReduceRate {
  switch (rate) {
    case 1: return "0.1";
    case 2: return "0.2";
    case 4: return "0.4";
  }
}

/**
 * Primal Rampage 捆绑的 `iw` 音乐罐的独立于浏览器的转录。资金以十分之一的小单位持有，因此对于每个整数投注，无需进行数字转换，
 * 0.1x/0.2x/0.4x 投注衰减仍然准确。
 *
 * 英文 / English: Browser-independent transcription of the `iw` music jar bundled with Primal Rampage. Funds are held in small units of tenths, so for every round number bet, the 0.1x/0.2x/0.4x bet decay remains accurate without the need for number conversion.
 */
export class BaseMusicPotStateMachine {
  private betMinorValue: bigint | null = null;
  private potTenths = 0n;
  private reduceRateTenths: ReduceRateTenths = MIN_REDUCE_RATE_TENTHS;
  private currentLevel: BaseMusicPotLevel = 0;
  private isIdle = false;
  private isDocked = false;
  private isRoundOpen = false;
  private secondsSinceLastSpin = 0;
  private secondsSinceLastLevelChange = 0;
  private pendingTickMs = 0;
  private readonly onLevelChange?: (change: BaseMusicPotLevelChange) => void;

  constructor(options: BaseMusicPotStateMachineOptions = {}) {
    this.onLevelChange = options.onLevelChange;
  }

  get level(): BaseMusicPotLevel {
    return this.currentLevel;
  }

  get potMinor(): string {
    return formatTenthsOfMinor(this.potTenths);
  }

  get reduceRate(): BaseMusicPotReduceRate {
    return reduceRateLabel(this.reduceRateTenths);
  }

  snapshot(): Readonly<BaseMusicPotSnapshot> {
    return Object.freeze({
      betMinor: this.betMinorValue?.toString() ?? null,
      potMinor: this.potMinor,
      reduceRate: this.reduceRate,
      level: this.currentLevel,
      idle: this.isIdle,
      docked: this.isDocked,
      roundOpen: this.isRoundOpen,
      secondsSinceLastSpin: this.secondsSinceLastSpin,
      secondsSinceLastLevelChange: this.secondsSinceLastLevelChange,
      pendingTickMs: this.pendingTickMs,
    });
  }

  beginRound(betMinor: string): void {
    if (this.isRoundOpen) throw new Error("Base music pot round is already open");
    this.betMinorValue = parseMinor(betMinor, "betMinor", false);
    this.isRoundOpen = true;
    this.isIdle = false;
  }

  recordWin(winMinor: string): void {
    this.assertRoundOpen();
    const win = parseMinor(winMinor, "winMinor", true);
    const maxPotTenths = this.bet() * BigInt(BASE_MUSIC_POT_MAX_MULTIPLIER) * TENTHS_PER_MINOR;
    this.potTenths = minBigInt(this.potTenths + win * TENTHS_PER_MINOR, maxPotTenths);
    this.reduceRateTenths = MIN_REDUCE_RATE_TENTHS;
    this.updateLevel();
  }

  recordNoWin(): void {
    this.assertRoundOpen();
    this.reduceRateTenths = Math.min(
      MAX_REDUCE_RATE_TENTHS,
      this.reduceRateTenths * 2,
    ) as ReduceRateTenths;
  }

  endRound(): void {
    this.assertRoundOpen();
    this.isRoundOpen = false;
    this.isIdle = true;
    this.secondsSinceLastSpin = 0;
  }

  /**
   * 改进了原来的一秒调度程序。分数帧增量被累积；停靠的经过时间将被丢弃，而不是稍后追上。
   *
   * 英文 / English: Improvements to the original one-second scheduler. Fractional frame increments are accumulated; docked elapsed time is discarded rather than caught up later.
   */
  tick(elapsedMs = TICK_MS): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
      throw new RangeError("elapsedMs must be a finite non-negative number");
    }
    if (this.isDocked) return;
    this.pendingTickMs += elapsedMs;
    while (this.pendingTickMs >= TICK_MS) {
      this.pendingTickMs -= TICK_MS;
      this.updateOneSecond();
    }
  }

  dock(): void {
    this.isDocked = true;
  }

  undock(): void {
    this.isDocked = false;
  }

  private updateOneSecond(): void {
    this.updateIdle();
    this.updatePot();
  }

  private updateIdle(): void {
    this.secondsSinceLastSpin += 1;
    if (this.isIdle
      && this.potTenths > 0n
      && this.secondsSinceLastSpin > BASE_MUSIC_POT_IDLE_DOWNGRADE_SECONDS) {
      this.downgradeLevel();
    }
  }

  private updatePot(): void {
    this.secondsSinceLastLevelChange += 1;
    if (this.potTenths <= 0n
      || this.secondsSinceLastLevelChange < BASE_MUSIC_POT_LEVEL_LINGER_SECONDS) return;

    this.secondsSinceLastLevelChange = Math.min(
      this.secondsSinceLastLevelChange,
      BASE_MUSIC_POT_LEVEL_LINGER_SECONDS,
    );
    const reduceTenths = this.bet() * BigInt(this.reduceRateTenths);
    if (reduceTenths <= 0n) return;
    this.potTenths = maxBigInt(0n, this.potTenths - reduceTenths);
    this.updateLevel();
  }

  private downgradeLevel(): void {
    this.secondsSinceLastSpin = 0;
    this.potTenths = this.amountForLevel(this.currentLevel - 1);
    this.updateLevel();
  }

  private amountForLevel(level: number): bigint {
    const threshold = BASE_MUSIC_POT_THRESHOLDS[level];
    return threshold === undefined ? 0n : this.bet() * BigInt(threshold) * TENTHS_PER_MINOR;
  }

  private levelForAmount(amountTenths: bigint): BaseMusicPotLevel {
    const upperThreshold = this.bet()
      * BigInt(BASE_MUSIC_POT_THRESHOLDS[1])
      * TENTHS_PER_MINOR;
    return amountTenths >= upperThreshold ? 1 : 0;
  }

  private updateLevel(): void {
    if (this.isDocked) return;
    const nextLevel = this.levelForAmount(this.potTenths);
    if (nextLevel === this.currentLevel) return;
    const previousLevel = this.currentLevel;
    this.currentLevel = nextLevel;
    this.secondsSinceLastLevelChange = 0;
    this.onLevelChange?.(Object.freeze({ previousLevel, level: nextLevel }));
  }

  private bet(): bigint {
    if (this.betMinorValue === null) throw new Error("Base music pot has no active wager");
    return this.betMinorValue;
  }

  private assertRoundOpen(): void {
    if (!this.isRoundOpen) throw new Error("Base music pot has no open round");
  }
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
