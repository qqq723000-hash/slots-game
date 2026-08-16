export const AUDIO_CUES = [
  "intro.game",
  "ui.splash-continue",
  "ui.button-feedback",
  "ui.click",
  "ui.open",
  "ui.close",
  "reel.start",
  "reel.loop",
  "reel.motor",
  "reel.stop",
  "reel.anticipation",
  "symbol.scatter-land-1",
  "symbol.scatter-land-2",
  "symbol.scatter-land-3",
  "symbol.scatter-land-4",
  "symbol.scatter-land-5",
  "symbol.wild-land",
  "energy.collect",
  "pps.level-1",
  "pps.level-2",
  "pps.level-3",
  "pps.level-4",
  "pps.level-5",
  "symbol.lp1",
  "symbol.lp2",
  "symbol.mp1",
  "symbol.mp2",
  "symbol.hp1",
  "symbol.hp2",
  "symbol.wild",
  "symbol.scatter-win",
  "wheel.spin",
  "wheel.appear",
  "wheel.panel-in",
  "wheel.wait",
  "wheel.award",
  "wheel.king-spin-won",
  "wheel.kong-quest-won",
  "feature.start",
  "free-spins.loop-end",
  "free-spins.outro",
  "free-spins.music-end",
  "big-win.trigger",
  "big-win.level-up",
  "big-win.end",
  "big-win.counter-start",
  "big-win.counter-sweetener",
  "big-win.counter-tail",
  "normal-win.counter-start",
  "normal-win.counter-sweetener",
  "normal-win.counter-tail",
  "win.loss-or-equal",
  "win.sting",
  "monster.impact",
  "monster.roar",
  "monster.roar-hit",
  "monster.sniff",
  "monster.thump-expand",
  "monster.reel-stretch",
  "monster.feature-activate",
  "vault.unlock-1",
  "vault.unlock-2",
  "vault.unlock-3-plus",
  "vault.anticipation",
  "vault.fly",
  "jackpot.mini",
  "jackpot.minor",
  "jackpot.major",
  "jackpot.mega",
  "jackpot.grand",
  "payout.win-1",
  "payout.win-2",
  "payout.win-3",
  "payout.win-4",
  "payout.win-5",
  "payout.win-6",
  "payout.win-7",
  "payout.win-8",
  "ambient.city",
  "music.free-spins",
  "music.big-win",
  "counter.big-win",
  "counter.normal-generic",
  "counter.normal-common",
] as const;

export type AudioCue = (typeof AUDIO_CUES)[number];
export type LoopAudioCue = Extract<
  AudioCue,
  | "reel.loop"
  | "reel.motor"
  | "wheel.wait"
  | "ambient.city"
  | "music.free-spins"
  | "music.big-win"
  | "counter.big-win"
  | "counter.normal-generic"
  | "counter.normal-common"
>;
export type OneShotAudioCue = Exclude<AudioCue, LoopAudioCue>;
export type AudioBus = "ui" | "reels" | "win" | "impact" | "ambient";
export type ScatterLandOrdinal = 1 | 2 | 3 | 4 | 5;
export type PpsLevel = 1 | 2 | 3 | 4 | 5;
export type JackpotTier = "mini" | "minor" | "major" | "mega" | "grand";
export type PayoutWinLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface AudioCueOptions {
  /** 音频时钟当前时间的延迟。大的/陈旧的延迟是有上限的。 */
  delayMs?: number;
  /** 立体声位置从最左 (-1) 到最右 (1)。 */
  pan?: number;
  /** 装饰响度/权重标量。这绝不代表支付等级。 */
  intensity?: number;
  /** 缩短密集的程序声音；它绝不意味着静音。 */
  reducedMotion?: boolean;
}

export interface NormalizedAudioCueOptions {
  readonly delayMs: number;
  readonly pan: number;
  readonly intensity: number;
  readonly reducedMotion: boolean;
}

const finiteOr = (value: number | undefined, fallback: number): number => (
  value === undefined || !Number.isFinite(value) ? fallback : value
);

const clamp = (value: number, minimum: number, maximum: number): number => (
  Math.min(maximum, Math.max(minimum, value))
);

export function normalizeAudioCueOptions(options: AudioCueOptions = {}): NormalizedAudioCueOptions {
  return {
    delayMs: clamp(finiteOr(options.delayMs, 0), 0, 10_000),
    pan: clamp(finiteOr(options.pan, 0), -1, 1),
    intensity: clamp(finiteOr(options.intensity, 1), 0, 1),
    reducedMotion: options.reducedMotion ?? false,
  };
}

export function isLoopAudioCue(cue: AudioCue): cue is LoopAudioCue {
  return cue === "reel.loop"
    || cue === "reel.motor"
    || cue === "wheel.wait"
    || cue === "ambient.city"
    || cue === "music.free-spins"
    || cue === "music.big-win"
    || cue === "counter.big-win"
    || cue === "counter.normal-generic"
    || cue === "counter.normal-common";
}

export function audioBusForCue(cue: AudioCue): AudioBus {
  switch (cue) {
    case "intro.game":
      return "impact";
    case "ui.splash-continue":
    case "ui.button-feedback":
    case "ui.click":
    case "ui.open":
    case "ui.close":
      return "ui";
    case "reel.start":
    case "reel.loop":
    case "reel.motor":
    case "reel.stop":
    case "reel.anticipation":
    case "symbol.scatter-land-1":
    case "symbol.scatter-land-2":
    case "symbol.scatter-land-3":
    case "symbol.scatter-land-4":
    case "symbol.scatter-land-5":
    case "symbol.wild-land":
    case "wheel.spin":
    case "wheel.appear":
    case "wheel.panel-in":
    case "wheel.wait":
    case "wheel.award":
      return "reels";
    case "energy.collect":
    case "symbol.lp1":
    case "symbol.lp2":
    case "symbol.mp1":
    case "symbol.mp2":
    case "symbol.hp1":
    case "symbol.hp2":
    case "symbol.wild":
    case "symbol.scatter-win":
    case "wheel.king-spin-won":
    case "wheel.kong-quest-won":
    case "feature.start":
    case "free-spins.loop-end":
    case "free-spins.outro":
    case "free-spins.music-end":
    case "big-win.trigger":
    case "big-win.level-up":
    case "big-win.end":
    case "big-win.counter-start":
    case "big-win.counter-sweetener":
    case "big-win.counter-tail":
    case "normal-win.counter-start":
    case "normal-win.counter-sweetener":
    case "normal-win.counter-tail":
    case "win.loss-or-equal":
    case "counter.normal-generic":
    case "counter.normal-common":
    case "win.sting":
    case "jackpot.mini":
    case "jackpot.minor":
    case "jackpot.major":
    case "jackpot.mega":
    case "jackpot.grand":
    case "payout.win-1":
    case "payout.win-2":
    case "payout.win-3":
    case "payout.win-4":
    case "payout.win-5":
    case "payout.win-6":
    case "payout.win-7":
    case "payout.win-8":
      return "win";
    case "pps.level-1":
    case "pps.level-2":
    case "pps.level-3":
    case "pps.level-4":
    case "pps.level-5":
    case "monster.impact":
    case "monster.roar":
    case "monster.roar-hit":
    case "monster.sniff":
    case "monster.thump-expand":
    case "monster.reel-stretch":
    case "monster.feature-activate":
    case "vault.unlock-1":
    case "vault.unlock-2":
    case "vault.unlock-3-plus":
    case "vault.anticipation":
    case "vault.fly":
      return "impact";
    case "ambient.city":
    case "music.free-spins":
    case "music.big-win":
    case "counter.big-win":
      return "ambient";
  }
}
