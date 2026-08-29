import type {
  JackpotTier,
  PayoutWinLevel,
  ScatterLandOrdinal,
} from "../audio/cues";
import type { GridCell, MoneyMinor } from "./state/types";

const MONEY_PATTERN = /^(0|[1-9]\d*)$/;
const MAX_MONEY_DIGITS = 20;

export interface PayoutAudioPlan {
  readonly level: PayoutWinLevel;
  readonly intensity: number;
}

export const NORMAL_WIN_COUNTER_MS_PER_MULTIPLIER = 500;
export const NORMAL_WIN_COUNTER_MIN_MS = 100;
/** 当前 GameWinLogicController 的上限钳制值。 / English: The upper limit clamp value of the current GameWinLogicController. */
export const NORMAL_WIN_COUNTER_MAX_MS = 5_000;
export const NORMAL_WIN_COUNTER_TAIL_HOLD_MS = 500;

/** 精确的普通计数时钟：Fast Play 先减半，再钳制到 100..5000ms。 / English: Precise normal counting clock: Fast Play is first halved and then clamped to 100..5000ms. */
export function normalWinCounterDurationMs(
  totalWinMinor: MoneyMinor,
  betMinor: MoneyMinor,
  fastPlay = false,
): number | null {
  const totalWin = positiveMoney(totalWinMinor);
  const bet = positiveMoney(betMinor);
  if (totalWin === null || bet === null) return null;
  // BetLossPresentation 只选择配套的表现与音频。当前 Primal 控制器仍会为每个正数中奖 / English: BetLossPresentation only selects matching presentations and audio. Currently the Primal controller still wins for every positive number
  // 显示计数器，包括小于或等于投注额的中奖。 / English: Displays a counter including wins less than or equal to the bet amount.
  let duration = Number(totalWin) / Number(bet) * NORMAL_WIN_COUNTER_MS_PER_MULTIPLIER;
  if (fastPlay) duration *= 0.5;
  if (!Number.isFinite(duration)) return NORMAL_WIN_COUNTER_MAX_MS;
  return Math.min(
    NORMAL_WIN_COUNTER_MAX_MS,
    Math.max(NORMAL_WIN_COUNTER_MIN_MS, duration),
  );
}

/** 精确复刻 BetLossController 的判断条件：正数中奖且不高于投注额。 / English: Judgment conditions for accurately replicating BetLossController: winning with a positive number and not higher than the bet amount. */
export function isWinLossOrEqual(totalWinMinor: MoneyMinor, betMinor: MoneyMinor): boolean {
  const totalWin = positiveMoney(totalWinMinor);
  const bet = positiveMoney(betMinor);
  return totalWin !== null && bet !== null && totalWin <= bet;
}

/** 计数器/派彩庆祝采用严格条件；无路径记录的短音效另行路由。 / English: Counter/payout celebrations are under strict conditions; short sound effects without path recording are routed separately. */
export function isCelebratoryWin(totalWinMinor: MoneyMinor, betMinor: MoneyMinor): boolean {
  const totalWin = positiveMoney(totalWinMinor);
  const bet = positiveMoney(betMinor);
  return totalWin !== null && bet !== null && totalWin > bet;
}

function positiveMoney(value: MoneyMinor): bigint | null {
  if (
    value.length > MAX_MONEY_DIGITS
    || !MONEY_PATTERN.test(value)
  ) return null;
  const amount = BigInt(value);
  return amount > 0n ? amount : null;
}

/**
 * 将权威轮次派彩映射到复刻的 Win1..Win8 程序。比较始终使用整数最小货币单位，
 * 避免较大且有效的余额经过不精确的 JavaScript 数字。
 *
 * 英文 / English: Mapping authoritative round payouts to forked Win1..Win8 programs. Comparisons always use integers in the smallest monetary unit, to avoid large and valid balances passing through imprecise JavaScript numbers.
 */
export function planPayoutAudio(
  totalWinMinor: MoneyMinor,
  betMinor: MoneyMinor,
): PayoutAudioPlan | null {
  const totalWin = positiveMoney(totalWinMinor);
  const bet = positiveMoney(betMinor);
  if (totalWin === null || bet === null) return null;

  // 原始庆祝阶梯从 2x 开始。亏损/持平处理归通用余额计数器所有，不得伪造 Win1。 / English: The original Celebration Ladder starts at 2x. Loss/even processing is owned by the universal balance counter and must not be faked Win1.
  if (totalWin < bet * 2n) return null;

  const ratio = totalWin / bet;
  const level: PayoutWinLevel = ratio >= 9n
    ? 8
    : (Number(ratio) - 1) as PayoutWinLevel;
  return Object.freeze({ level, intensity: 1 });
}

export type ReelLandAudioEvent =
  | {
    readonly kind: "scatter-land";
    readonly row: number;
    readonly ordinal: ScatterLandOrdinal;
  }
  | {
    readonly kind: "wild-land";
    readonly row: number;
  };

export interface ReelLandAudioPlan {
  readonly events: readonly ReelLandAudioEvent[];
  /** 传入下一次权威停轴的已封顶序号。 / English: Pass the capped landing ordinal into the next authoritative reel stop. */
  readonly nextScatterOrdinal: number;
}

function normalizeScatterOrdinal(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(5, Math.max(0, Math.trunc(value)));
}

/**
 * 按行顺序扫描一个权威转轴。调用方将返回序号依次传给后续转轴，使 ScatterLand1..5
 * 贯穿完整的三轴停轴序列；之后的 Scatter 重复第五个重音。
 *
 * 英文 / English: Scan one authoritative reel in row order. The caller passes the returned ordinal through each subsequent reel so ScatterLand1..5 spans the complete three-reel stop sequence; later Scatters repeat the fifth accent.
 */
export function planReelLandAudio(
  cells: readonly Readonly<GridCell>[],
  currentScatterOrdinal: number,
): ReelLandAudioPlan {
  let ordinal = normalizeScatterOrdinal(currentScatterOrdinal);
  const events: ReelLandAudioEvent[] = [];

  cells.forEach((cell, row) => {
    if (cell.symbol === "SURGE") {
      ordinal = Math.min(5, ordinal + 1);
      events.push(Object.freeze({
        kind: "scatter-land",
        row,
        ordinal: ordinal as ScatterLandOrdinal,
      }));
    } else if (cell.symbol === "WILD") {
      events.push(Object.freeze({ kind: "wild-land", row }));
    }
  });

  return Object.freeze({
    events: Object.freeze(events),
    nextScatterOrdinal: ordinal,
  });
}

const JACKPOT_PRIZE_PATTERN = /^(MINI|MINOR|MAJOR|MEGA|GRAND)(?:_2X)?$/i;

/** 只接受显式命名的 jackpot 牌面，可选择附带对应的 2X 牌面。 / English: Only explicitly named jackpot decks are accepted, with the option to come with a corresponding 2X deck. */
export function parseJackpotTier(prize: string | null | undefined): JackpotTier | null {
  if (typeof prize !== "string") return null;
  const match = JACKPOT_PRIZE_PATTERN.exec(prize);
  const namedTier = match?.[1]?.toLowerCase();
  switch (namedTier) {
    case "mini":
    case "minor":
    case "major":
    case "mega":
    case "grand":
      return namedTier;
    default:
      return null;
  }
}
