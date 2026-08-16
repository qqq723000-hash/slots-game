import type {
  AudioBackend,
  AudioBackendState,
  BaseMusicStemLevel,
} from "./AudioManager";
import { publicAssetUrl } from "../assets/publicAssetUrl";
import { browserAllowsPrimalAudioSprites } from "../assets/primalRuntimePolicy";
import {
  primalRuntimeAssetProfile,
  type PrimalRuntimeAssetChannel,
} from "../assets/primalRuntimeAssets";
import {
  normalizeAudioCueOptions,
  type AudioCueOptions,
  type LoopAudioCue,
  type NormalizedAudioCueOptions,
  type OneShotAudioCue,
} from "./cues";
import {
  PRIMAL_AUDIO_PACKS,
  PRIMAL_BIG_WIN_COUNTER_SWEETENERS,
  PRIMAL_BIG_WIN_END_ROARS,
  PRIMAL_BIG_WIN_LEVEL_CUES,
  PRIMAL_NORMAL_WIN_COUNTER_SWEETENERS,
  PRIMAL_CUE_DEFINITIONS,
  PRIMAL_JACKPOT_POT_CUES,
  PRIMAL_PAYOUT_WIN_CUES,
  PRIMAL_PPS_LEVEL_CUES,
  PRIMAL_RAGE_ROAR_CUES,
  PRIMAL_REEL_LOOP_CUES,
  PRIMAL_REEL_ANTICIPATION_CUES,
  PRIMAL_REEL_STOP_CUES,
  PRIMAL_ROAR_CUES,
  PRIMAL_ROAR_HIT_CUES,
  PRIMAL_SNIFF_CUES,
  PRIMAL_SCATTER_LAND_CUES,
  PRIMAL_THUMP_CUES,
  PRIMAL_THUMP_EXPAND_CUES,
  PRIMAL_UI_INTERACT_CUES,
  PRIMAL_UI_SPIN_CUES,
  primalSampleTime,
  type PrimalAudioPackId,
  type PrimalSpriteCueDefinition,
  type PrimalSpriteCueName,
} from "./primalSoundMap";
import {
  cancelNetworkResponse,
  NETWORK_RESPONSE_LIMITS,
  readBoundedResponseArrayBuffer,
} from "../network/boundedResponse";
import { WebAudioSynth } from "./WebAudioSynth";

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;
type AudioContextFactory = () => AudioContext | null;
type FetchAudio = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface PrimalSpriteAudioBackendOptions {
  contextFactory?: AudioContextFactory;
  fetcher?: FetchAudio | null;
  fallback?: AudioBackend | null;
  assetBaseUrl?: string;
  packFiles?: Readonly<Record<PrimalAudioPackId, string>>;
  assetChannel?: PrimalRuntimeAssetChannel;
  random?: () => number;
  /** 单调毫秒仅用于捕获待处理的 SoundStage 事件。 */
  now?: () => number;
  maxVoices?: number;
}

interface SpriteVoice {
  readonly name: PrimalSpriteCueName;
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly nodes: readonly AudioNode[];
}

interface PlaySpriteOptions {
  readonly gain: number;
  readonly semantic: NormalizedAudioCueOptions;
  readonly offsetSeconds?: number;
  readonly loop?: boolean;
  readonly fadeInSeconds?: number;
  readonly startTimeSeconds?: number;
  readonly stopBeforePlay?: boolean;
}

interface PendingOneShot {
  readonly cue: OneShotAudioCue;
  readonly options: NormalizedAudioCueOptions;
  readonly requestedAtMs: number;
}

interface PendingLoop {
  readonly cue: LoopAudioCue;
  readonly options: NormalizedAudioCueOptions;
  readonly requestedAtMs: number;
}

interface ReelMotorPlayback {
  readonly cue: (typeof PRIMAL_REEL_LOOP_CUES)[number];
  readonly voice: SpriteVoice;
}

interface BaseMusicPlayback {
  readonly level1: SpriteVoice;
  readonly level2: SpriteVoice;
}

const DEFAULT_ASSET_BASE_URL = publicAssetUrl("assets/primal-runtime/audio");
const MASTER_GAIN = 0.7;
const MUTE_TIME_CONSTANT = 0.01;
const UNMUTE_TIME_CONSTANT = 0.3;

/**
 * 这些语义事件仅解析为每个捕获的 `.471` 清单中不存在的旧标题。因此，官方经理没有为他们创造资源；路由到附近的精灵或合成器将是捕获的构建所没有的可听行为。
 */
const PRIMAL_CAPTURED_SILENT_ONE_SHOTS: ReadonlySet<OneShotAudioCue> = new Set([
  "symbol.wild",
  "free-spins.music-end",
  "wheel.king-spin-won",
  "wheel.kong-quest-won",
]);

const PRIMAL_DELAYED_ONE_SHOTS: ReadonlySet<OneShotAudioCue> = new Set([
  "big-win.counter-start",
  "big-win.counter-sweetener",
  "big-win.counter-tail",
  "normal-win.counter-start",
  "normal-win.counter-sweetener",
  "normal-win.counter-tail",
]);

const PRIMAL_DELAYED_LOOPS: ReadonlySet<LoopAudioCue> = new Set([
  "counter.big-win",
  "counter.normal-generic",
]);

/** 捕获的 SoundStage 主屏障是公共加上 sounds0..2。 */
export const PRIMAL_MAIN_AUDIO_PACKS = Object.freeze([
  "common",
  "sounds0",
  "sounds1",
  "sounds2",
] as const satisfies readonly PrimalAudioPackId[]);

/** 为仍将主要屏障命名为“关键”的调用者保留兼容性别名。 */
export const PRIMAL_CRITICAL_AUDIO_PACKS = PRIMAL_MAIN_AUDIO_PACKS;

/** 官方延迟标题覆盖仅在四包主障碍之后开始。 */
export const PRIMAL_BACKGROUND_AUDIO_PACKS = Object.freeze([
  "delayed",
] as const satisfies readonly PrimalAudioPackId[]);

/** 启动进度完成之前所需的每个捕获的精灵包。 */
export const PRIMAL_LAUNCH_AUDIO_PACKS = Object.freeze([
  ...PRIMAL_MAIN_AUDIO_PACKS,
  ...PRIMAL_BACKGROUND_AUDIO_PACKS,
] as const satisfies readonly PrimalAudioPackId[]);

function defaultNow(): number {
  return typeof performance !== "undefined" && Number.isFinite(performance.now())
    ? performance.now()
    : Date.now();
}

function resolveAudioContextConstructor(): AudioContextConstructor | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function resolveFetch(): FetchAudio | null {
  return typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis) as FetchAudio
    : null;
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : DEFAULT_ASSET_BASE_URL;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function disconnect(nodes: readonly AudioNode[]): void {
  for (const node of nodes) {
    try {
      node.disconnect();
    } catch {
      // 自然结束或上下文拥有的节点可能已经断开连接。
    }
  }
}

/**
 * 通过网络音频播放选定的捕获的 Primal Rampage 音频精灵。仅当不支持本机精灵播放时才使用程序合成器。一旦选择本机播放，丢失的捕获标题将保持沉默。
 */
export class PrimalSpriteAudioBackend implements AudioBackend {
  private readonly contextFactory: AudioContextFactory;
  private readonly nativeSupported: boolean;
  private readonly fetcher: FetchAudio | null;
  private readonly fallback: AudioBackend | null;
  private readonly assetBaseUrl: string;
  private readonly packFiles: Readonly<Record<PrimalAudioPackId, string>>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly maxVoices: number;
  private readonly buffers = new Map<PrimalAudioPackId, AudioBuffer>();
  private readonly bufferLoads = new Map<PrimalAudioPackId, Promise<AudioBuffer>>();
  private readonly voices = new Set<SpriteVoice>();
  private readonly sampleLoops = new Map<LoopAudioCue, SpriteVoice[]>();
  private readonly fallbackLoops = new Set<LoopAudioCue>();
  private readonly sequenceIndexes = new Map<string, number>();
  private readonly randomIndexes = new Map<string, number>();
  private readonly pendingOneShots: PendingOneShot[] = [];
  private readonly pendingLoops = new Map<LoopAudioCue, PendingLoop>();
  private readonly failedPacks = new Set<PrimalAudioPackId>();
  private readonly duckedCounterLoops = new Set<LoopAudioCue>();
  /** 拥有该后端生命周期的每个本机包请求。 */
  private readonly lifetime = new AbortController();
  private introVoice: SpriteVoice | null = null;
  private wheelSpinVoice: SpriteVoice | null = null;
  private reelMotorPlayback: ReelMotorPlayback | null = null;
  private baseMusicPlayback: BaseMusicPlayback | null = null;
  private baseMusicStemTarget: BaseMusicStemLevel | null = 0;
  private baseMusicStemFadeMs = 2_000;
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private primeAttempt: Promise<void> | null = null;
  private launchPrimeAttempt: Promise<void> | null = null;
  private unlockAttempt: Promise<boolean> | null = null;
  private backgroundPreloadAttempt: Promise<void> | null = null;
  private mainReady = false;
  private mainLoadFailed = false;
  private playbackCatchUpMs = 0;
  private muted = false;
  private destroyed = false;

  constructor(options: PrimalSpriteAudioBackendOptions = {}) {
    const assetProfile = primalRuntimeAssetProfile(options.assetChannel ?? "desktop");
    const Context = options.contextFactory ? null : resolveAudioContextConstructor();
    this.nativeSupported = options.contextFactory !== undefined
      || (Context !== null && browserAllowsPrimalAudioSprites(options.assetChannel ?? "desktop"));
    this.contextFactory = options.contextFactory ?? (() => (
      Context ? new Context({ latencyHint: "interactive" }) : null
    ));
    this.fetcher = options.fetcher === undefined ? resolveFetch() : options.fetcher;
    this.fallback = options.fallback === undefined ? new WebAudioSynth() : options.fallback;
    this.assetBaseUrl = normalizeBaseUrl(options.assetBaseUrl ?? assetProfile.audioRoot ?? DEFAULT_ASSET_BASE_URL);
    this.packFiles = options.packFiles ?? assetProfile.audioPacks ?? PRIMAL_AUDIO_PACKS;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? defaultNow;
    const requestedVoices = options.maxVoices ?? 48;
    this.maxVoices = Number.isFinite(requestedVoices)
      ? Math.max(8, Math.trunc(requestedVoices))
      : 48;
  }

  get available(): boolean {
    if (this.destroyed) return false;
    return (this.nativeSupported && this.fetcher !== null) || (this.fallback?.available ?? false);
  }

  get state(): AudioBackendState {
    if (this.destroyed) return "closed";
    if (this.usesNativeSprites()) return this.getNativeState();
    return this.fallback?.state ?? "unavailable";
  }

  /** AudioContext 时间因浏览器暂停而冻结并在恢复时提前。 */
  playbackClockMs(): number | null {
    const currentTime = this.context?.currentTime;
    return currentTime !== undefined && Number.isFinite(currentTime)
      ? currentTime * 1_000
      : null;
  }

  /**
   * 创建一个仍然悬挂的图并解码四包主屏障。在玩家的手势之前不会发生源或上下文恢复。
   */
  prime(): Promise<void> {
    if (this.destroyed || !this.nativeSupported || !this.fetcher) return Promise.resolve();
    if (this.primeAttempt) return this.primeAttempt;
    const attempt = this.performPrime();
    this.primeAttempt = attempt;
    void attempt.finally(() => {
      if (this.primeAttempt === attempt) this.primeAttempt = null;
    }).catch(() => undefined);
    return attempt;
  }

  /**
   * 严格的五件装发射壁垒。它共享正常的缓冲区高速缓存和挂起的图表，但永远不会将丢失的包转换为后台静默。
   */
  primeForLaunch(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error("Audio backend was destroyed"));
    if (!this.nativeSupported || !this.fetcher) {
      return Promise.reject(new Error("Authored Primal launch audio is unavailable"));
    }
    if (this.launchPrimeAttempt) return this.launchPrimeAttempt;
    const attempt = this.performLaunchPrime();
    this.launchPrimeAttempt = attempt;
    void attempt.finally(() => {
      if (this.launchPrimeAttempt === attempt) this.launchPrimeAttempt = null;
    }).catch(() => undefined);
    return attempt;
  }

  unlock(): Promise<boolean> {
    if (this.destroyed || !this.available) return Promise.resolve(false);
    if (this.unlockAttempt) return this.unlockAttempt;
    const attempt = this.performUnlock();
    this.unlockAttempt = attempt;
    void attempt.finally(() => {
      if (this.unlockAttempt === attempt) this.unlockAttempt = null;
    }).catch(() => undefined);
    return attempt;
  }

  /**
   * 在非关键包加载或回退后解决。启动代码故意不等待此操作；存在用于渐进式音频准备情况的诊断和确定性测试的接口。
   */
  async whenBackgroundReady(): Promise<void> {
    const prime = this.primeAttempt;
    if (prime) await prime.catch(() => undefined);
    const unlock = this.unlockAttempt;
    if (unlock) await unlock.catch(() => false);
    await this.backgroundPreloadAttempt;
  }

  /** 由稍后的用户手势调用，无需恢复或重建图表。 */
  retryDeferredLoads(): void {
    const context = this.context;
    if (this.destroyed || !context || context.state === "closed" || !this.mainReady) return;
    this.startBackgroundPreload(context);
  }

  setMuted(muted: boolean): void {
    if (this.destroyed) return;
    this.muted = muted;
    this.setMasterMuted(muted);
    if (!this.usesNativeSprites()) this.tryFallback(() => this.fallback?.setMuted(muted));
  }

  playOneShot(cue: OneShotAudioCue, rawOptions: AudioCueOptions = {}): void {
    if (this.destroyed) return;
    if (PRIMAL_CAPTURED_SILENT_ONE_SHOTS.has(cue)) return;
    const options = normalizeAudioCueOptions(rawOptions);
    if (!this.usesNativeSprites()) {
      this.playFallbackOneShot(cue, options);
      return;
    }

    if (this.isOneShotUnavailable(cue)) return;
    if (!this.isOneShotReady(cue)) {
      this.pendingOneShots.push({ cue, options, requestedAtMs: this.audioClockMs() });
      return;
    }
    this.playNativeOneShot(cue, options, 0);
  }

  private playNativeOneShot(
    cue: OneShotAudioCue,
    options: NormalizedAudioCueOptions,
    catchUpMs: number,
  ): void {
    const previousCatchUp = this.playbackCatchUpMs;
    this.playbackCatchUpMs = Math.max(0, catchUpMs);

    let played = false;
    try {
      switch (cue) {
        case "intro.game": {
          if (this.introVoice) this.stopVoice(this.introVoice, 0);
          const intro = this.playSprite("1065TrnGameIntro", {
            gain: 0.24,
            semantic: options,
          });
          this.introVoice = intro;
          played = intro !== null;
          break;
        }
        case "ui.splash-continue":
          played = this.playSprite("btnClick", { gain: 1, semantic: options }) !== null;
          break;
        case "ui.button-feedback":
          played = this.playSprite("btnClick", { gain: 1, semantic: options }) !== null;
          break;
        case "ui.click":
          played = this.playSprite(
            this.nextSequence("ui-interact", PRIMAL_UI_INTERACT_CUES),
            { gain: 0.46, semantic: options },
          ) !== null;
          break;
        case "ui.open":
          // 捕获的 UIOpen 程序：743UiOpen，增益为 55/100。
          played = this.playSprite("743UiOpen", { gain: 0.55, semantic: options }) !== null;
          this.setGenericCounterDuck(true);
          break;
        case "ui.close":
          // 捕获的 UIClose 程序：743UiClose 增益为 51/100。
          played = this.playSprite("743UiClose", { gain: 0.51, semantic: options }) !== null;
          this.setGenericCounterDuck(false);
          break;
        case "reel.start":
          played = this.playReelStartSample(options) !== null;
          break;
        case "reel.stop":
          played = this.playSprite(
            this.nextRandomUnique("reel-stop", PRIMAL_REEL_STOP_CUES),
            {
              gain: 0.57,
              semantic: { ...options, pan: 0 },
              stopBeforePlay: true,
            },
          ) !== null;
          break;
        case "reel.anticipation": {
          const power = this.playSprite("1065SfPpsLvl3", {
            gain: 0.26,
            semantic: options,
            stopBeforePlay: true,
          });
          const wait = this.playSprite(
            this.nextSequence("reel-anticipation", PRIMAL_REEL_ANTICIPATION_CUES),
            { gain: 0.26, semantic: options },
          );
          played = power !== null || wait !== null;
          break;
        }
        case "symbol.scatter-land-1":
          played = this.playScatterLand(1, options);
          break;
        case "symbol.scatter-land-2":
          played = this.playScatterLand(2, options);
          break;
        case "symbol.scatter-land-3":
          played = this.playScatterLand(3, options);
          break;
        case "symbol.scatter-land-4":
          played = this.playScatterLand(4, options);
          break;
        case "symbol.scatter-land-5":
          played = this.playScatterLand(5, options);
          break;
        case "symbol.wild-land":
          played = this.playWildLand(options);
          break;
        case "energy.collect": {
          const collect = this.playSprite("1065SymRageCollect", {
            gain: 0.28,
            semantic: options,
            stopBeforePlay: true,
          });
          played = collect !== null;
          if (played) {
            this.playSprite(this.nextRandomUnique("rage-collect-roar", PRIMAL_RAGE_ROAR_CUES), {
              gain: 0.28,
              semantic: options,
              stopBeforePlay: true,
            });
          }
          break;
        }
        case "pps.level-1":
          played = this.playSprite(PRIMAL_PPS_LEVEL_CUES[0], {
            gain: 0.18,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "pps.level-2":
          played = this.playSprite(PRIMAL_PPS_LEVEL_CUES[1], {
            gain: 0.46,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "pps.level-3":
          played = this.playSprite(PRIMAL_PPS_LEVEL_CUES[2], { gain: 0.46, semantic: options }) !== null;
          break;
        case "pps.level-4":
          played = this.playSprite(PRIMAL_PPS_LEVEL_CUES[3], { gain: 0.4, semantic: options }) !== null;
          break;
        case "pps.level-5":
          played = this.playSprite(PRIMAL_PPS_LEVEL_CUES[4], { gain: 0.44, semantic: options }) !== null;
          break;
        case "symbol.lp1":
          played = this.playSprite("1065SymLp1Win", {
            gain: 0.78,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "symbol.lp2":
          played = this.playSprite("1065SymLp2Win", {
            gain: 0.76,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "symbol.mp1": {
          const low = this.playSprite("1065SymLp2Win", {
            gain: 0.52,
            semantic: options,
            stopBeforePlay: true,
          });
          const accent = this.playSprite("1065SymLp1Win", {
            gain: 0.68,
            semantic: this.withAdditionalDelay(options, 150),
            stopBeforePlay: true,
          });
          const body = this.playSprite("1065SymMp1Win", {
            gain: 0.26,
            semantic: options,
            offsetSeconds: 0.5,
            stopBeforePlay: true,
          });
          played = low !== null || accent !== null || body !== null;
          break;
        }
        case "symbol.mp2":
          played = this.playSprite("1065SymMp2Win", {
            gain: 1.32,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "symbol.hp1":
          played = this.playSprite("1065SymHp1Win", {
            gain: 0.32,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "symbol.hp2":
          played = this.playSprite("1065SymHp2Win", {
            gain: 1.18,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "symbol.scatter-win":
          played = this.playSprite("1065SymMp2Win", { gain: 1.13, semantic: options }) !== null;
          break;
        case "wheel.spin": {
          const body = this.playSprite("1065SfWheelSpin", {
            gain: 0.2,
            semantic: options,
            stopBeforePlay: true,
          });
          this.wheelSpinVoice = body;
          played = body !== null;
          this.playSprite("1065SfPpsLvl3", { gain: 0.14, semantic: options });
          this.playSprite("1065SfPpsLvl4", {
            gain: 0.18,
            semantic: this.withAdditionalDelay(options, 1_000),
          });
          this.playSprite("1065SfPpsLvl2", {
            gain: 0.16,
            semantic: this.withAdditionalDelay(options, 1_500),
          });
          this.playSprite("1065SfRoar1of5", {
            gain: 0.16,
            semantic: this.withAdditionalDelay(options, 2_000),
          });
          this.playSprite("1065SfThumpExpand1of3", {
            gain: 0.16,
            semantic: this.withAdditionalDelay(options, 3_000),
            offsetSeconds: 1,
          });
          this.playSprite("1065SfThumpExpand2of3", {
            gain: 0.16,
            semantic: this.withAdditionalDelay(options, 3_300),
            offsetSeconds: 1,
          });
          this.playSprite("1065SfThumpExpand3of3", {
            gain: 0.16,
            semantic: this.withAdditionalDelay(options, 3_500),
            offsetSeconds: 1,
          });
          this.playSprite("1065SfThumpExpand3of3", {
            gain: 0.16,
            semantic: this.withAdditionalDelay(options, 3_800),
            offsetSeconds: 0.9,
          });
          this.playSprite("965SpinsWaitFire3of3", {
            gain: 0.15,
            semantic: this.withAdditionalDelay(options, 3_500),
          });
          break;
        }
        case "wheel.appear":
          played = this.playSprite("1065SfWheelAppear", { gain: 0.4, semantic: options }) !== null;
          break;
        case "wheel.panel-in":
          played = this.playSprite("1065SfWheelAppear", {
            gain: 0.4,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "wheel.award":
          if (this.wheelSpinVoice) this.stopVoice(this.wheelSpinVoice, 100);
          played = this.playSprite("1065SfWheelAward", {
            gain: 0.52,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "feature.start":
          played = this.playSprite("1065TrnFsIntro", {
            gain: 0.32,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "free-spins.loop-end":
          played = this.playSprite("1065MusFsEnd", {
            gain: 0.32,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "free-spins.outro": {
          const panel = this.playSprite("1065TrnFsOutroPanel", {
            gain: 0.32,
            semantic: options,
            stopBeforePlay: true,
          });
          played = panel !== null;
          break;
        }
        case "big-win.trigger":
          played = this.playSprite("LandBasedJackpotMed", {
            gain: 0.34,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "big-win.level-up":
          played = this.playSprite(
            this.nextSequence("big-win-level", PRIMAL_BIG_WIN_LEVEL_CUES),
            { gain: 0.32, semantic: options, stopBeforePlay: true },
          ) !== null;
          break;
        case "big-win.end": {
          const musicEnd = this.playSprite("1065MusBwEnd", { gain: 0.28, semantic: options });
          const roar = this.playSprite(
            this.nextRandomUnique("big-win-end-roar", PRIMAL_BIG_WIN_END_ROARS),
            { gain: 0.78, semantic: options, stopBeforePlay: true },
          );
          played = musicEnd !== null || roar !== null;
          break;
        }
        case "big-win.counter-start":
          played = this.playSprite("BigWinCounterGenericNewStart1", {
            gain: 0.56,
            semantic: options,
          }) !== null;
          break;
        case "big-win.counter-sweetener":
          played = this.playSprite(
            this.nextSequence("big-win-counter-sweetener", PRIMAL_BIG_WIN_COUNTER_SWEETENERS),
            { gain: 0.64, semantic: options },
          ) !== null;
          break;
        case "big-win.counter-tail":
          played = this.playSprite("BigWinCounterGenericNewTail1", {
            gain: 0.52,
            semantic: options,
          }) !== null;
          break;
        case "normal-win.counter-start":
          played = this.playSprite("WinCounterGenericNewStart1", {
            gain: 1,
            semantic: options,
          }) !== null;
          break;
        case "normal-win.counter-sweetener":
          played = this.playSprite(
            this.nextSequence("normal-win-counter-sweetener", PRIMAL_NORMAL_WIN_COUNTER_SWEETENERS),
            { gain: 1, semantic: options },
          ) !== null;
          break;
        case "normal-win.counter-tail":
          played = this.playSprite("WinCounterGenericNewTail1", {
            gain: 1,
            semantic: options,
          }) !== null;
          break;
        case "win.loss-or-equal":
          played = this.playSprite("986WinLessThanBet", {
            gain: 0.5,
            semantic: options,
          }) !== null;
          break;
        case "win.sting":
          // 强度就是响度，从来不是权威的支出分类。
          played = this.playSprite("986Win2x", {
            gain: 0.8,
            semantic: options,
          }) !== null;
          break;
        case "monster.impact":
          played = this.playSprite(
            this.nextRandomUnique("monster-thump", PRIMAL_THUMP_CUES),
            { gain: 0.4, semantic: options, stopBeforePlay: true },
          ) !== null;
          break;
        case "monster.roar":
          played = this.playSprite(
            this.nextRandomUnique("monster-roar", PRIMAL_ROAR_CUES),
            { gain: 0.26, semantic: options, stopBeforePlay: true },
          ) !== null;
          break;
        case "monster.roar-hit":
          played = this.playSprite(
            this.nextRandomUnique("monster-roar-hit", PRIMAL_ROAR_HIT_CUES),
            { gain: 0.46, semantic: options, stopBeforePlay: true },
          ) !== null;
          break;
        case "monster.sniff":
          played = this.playSprite(
            this.nextRandomUnique("monster-sniff", PRIMAL_SNIFF_CUES),
            { gain: 0.36, semantic: options, stopBeforePlay: true },
          ) !== null;
          break;
        case "monster.thump-expand":
          played = this.playSprite(
            this.nextRandomUnique("monster-thump-expand", PRIMAL_THUMP_EXPAND_CUES),
            { gain: 0.54, semantic: options, stopBeforePlay: true },
          ) !== null;
          break;
        case "monster.reel-stretch":
          played = this.playSprite("1065SfPpsLvl5", {
            gain: 0.28,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "monster.feature-activate": {
          const power = this.playSprite("1065SfPpsLvl2", {
            gain: 0.32,
            semantic: options,
            stopBeforePlay: true,
          });
          const roar = this.playSprite("1065SfRoar5of5", {
            gain: 0.57,
            semantic: options,
            offsetSeconds: 1.3,
          });
          played = power !== null || roar !== null;
          break;
        }
        case "vault.unlock-1":
          played = this.playSprite("1065SfThumpExpand1of3", {
            gain: 0.48,
            semantic: options,
            offsetSeconds: 0.8,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "vault.unlock-2":
          played = this.playSprite("1065SfThumpExpand2of3", {
            gain: 0.46,
            semantic: options,
            offsetSeconds: 1.2,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "vault.unlock-3-plus":
          played = this.playSprite("1065SfThumpExpand3of3", {
            gain: 0.4,
            semantic: options,
            offsetSeconds: 1.2,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "vault.anticipation":
          played = this.playSprite("1065SfWheelAppear", {
            gain: 0.42,
            semantic: options,
            offsetSeconds: 1.8,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "vault.fly":
          played = this.playSprite("1065TrnFsIntro", {
            gain: 0.66,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "jackpot.mini":
          played = this.playSprite(PRIMAL_JACKPOT_POT_CUES.mini, {
            gain: 0.56,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "jackpot.minor":
          played = this.playSprite(PRIMAL_JACKPOT_POT_CUES.minor, {
            gain: 0.56,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "jackpot.major":
          played = this.playSprite(PRIMAL_JACKPOT_POT_CUES.major, {
            gain: 0.48,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "jackpot.mega":
          played = this.playSprite(PRIMAL_JACKPOT_POT_CUES.mega, {
            gain: 0.46,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "jackpot.grand":
          played = this.playSprite(PRIMAL_JACKPOT_POT_CUES.grand, {
            gain: 0.44,
            semantic: options,
            stopBeforePlay: true,
          }) !== null;
          break;
        case "payout.win-1":
          played = this.playSprite(PRIMAL_PAYOUT_WIN_CUES[0], { gain: 0.82, semantic: options }) !== null;
          break;
        case "payout.win-2":
          played = this.playSprite(PRIMAL_PAYOUT_WIN_CUES[1], { gain: 0.8, semantic: options }) !== null;
          break;
        case "payout.win-3":
          played = this.playSprite(PRIMAL_PAYOUT_WIN_CUES[2], { gain: 0.72, semantic: options }) !== null;
          break;
        case "payout.win-4":
          played = this.playSprite(PRIMAL_PAYOUT_WIN_CUES[3], { gain: 0.57, semantic: options }) !== null;
          break;
        case "payout.win-5":
          played = this.playSprite(PRIMAL_PAYOUT_WIN_CUES[4], { gain: 0.42, semantic: options }) !== null;
          break;
        case "payout.win-6":
          played = this.playSprite(PRIMAL_PAYOUT_WIN_CUES[5], { gain: 0.42, semantic: options }) !== null;
          break;
        case "payout.win-7":
          played = this.playSprite(PRIMAL_PAYOUT_WIN_CUES[6], { gain: 0.36, semantic: options }) !== null;
          break;
        case "payout.win-8":
          played = this.playSprite(PRIMAL_PAYOUT_WIN_CUES[7], { gain: 0.59, semantic: options }) !== null;
          break;
      }
    } catch {
      played = false;
    } finally {
      this.playbackCatchUpMs = previousCatchUp;
    }
    void played;
  }

  stopOneShot(cue: OneShotAudioCue, fadeMs = 0): void {
    for (let index = this.pendingOneShots.length - 1; index >= 0; index -= 1) {
      if (this.pendingOneShots[index]?.cue === cue) this.pendingOneShots.splice(index, 1);
    }
    if (cue === "intro.game" && this.introVoice) {
      this.stopVoice(this.introVoice, fadeMs);
    }
    // 捕获的 ReelSuspenseStop 目标缺少 977SpinsWait* 标题。因此，
    // 上面开始的 1065SfPpsLvl3 + 965SpinsWaitFire* 声音将继续播放到其预设的结尾。
    this.tryFallback(() => this.fallback?.stopOneShot?.(cue, fadeMs));
  }

  startLoop(cue: LoopAudioCue, rawOptions: AudioCueOptions = {}): void {
    if (this.destroyed || this.sampleLoops.has(cue) || this.pendingLoops.has(cue) || this.fallbackLoops.has(cue)) {
      return;
    }
    const options = normalizeAudioCueOptions(rawOptions);
    if (!this.usesNativeSprites()) {
      this.startFallbackLoop(cue, options);
      return;
    }

    if (this.isLoopUnavailable(cue)) return;
    if (!this.isLoopReady(cue)) {
      this.pendingLoops.set(cue, {
        cue,
        options,
        requestedAtMs: this.audioClockMs(),
      });
      return;
    }
    this.startNativeLoop(cue, options, 0);
  }

  startBaseMusicProgram(
    level: BaseMusicStemLevel | null,
    fadeMs = 2_000,
    options: AudioCueOptions = {},
  ): void {
    this.baseMusicStemTarget = level;
    this.baseMusicStemFadeMs = Math.max(0, fadeMs);
    this.startLoop("ambient.city", options);
  }

  private startNativeLoop(
    cue: LoopAudioCue,
    options: NormalizedAudioCueOptions,
    catchUpMs: number,
  ): void {
    const previousCatchUp = this.playbackCatchUpMs;
    this.playbackCatchUpMs = Math.max(0, catchUpMs);

    let voices: SpriteVoice[] | null = null;
    try {
      if (cue === "reel.loop") voices = this.startReelLoopSample(options);
      else if (cue === "reel.motor") voices = this.startReelMotor(options);
      else if (cue === "wheel.wait") {
        voices = this.startSingleSampleLoop("1065SfWheelWait", 0.14, options, true);
      }
      else if (cue === "music.free-spins") voices = this.startFreeSpinMusic(options);
      else if (cue === "music.big-win") {
        voices = this.startSingleSampleLoop("1065MusBw", 0.42, options, true);
      }
      else if (cue === "counter.big-win") {
        voices = this.startSingleSampleLoop("BigWinCounterGenericNewLoop1", 0.46, options);
      }
      else if (cue === "counter.normal-generic") {
        voices = this.startSingleSampleLoop("WinCounterGenericNewLoop1", 1, options);
      }
      else if (cue === "counter.normal-common") {
        voices = this.startSingleSampleLoop("wincounter_loop", 0.8, options);
      }
      else voices = this.startBaseMusic(options);
    } catch {
      voices = null;
    } finally {
      this.playbackCatchUpMs = previousCatchUp;
    }
    if (!voices || voices.length === 0) {
      return;
    }
    this.sampleLoops.set(cue, voices);
    if (this.duckedCounterLoops.has(cue)) {
      for (const voice of voices) this.fadeVoiceGain(voice, 0, 0);
    }
  }

  setBaseMusicStemLevel(level: BaseMusicStemLevel | null, fadeMs = 2_000): void {
    this.baseMusicStemTarget = level;
    this.baseMusicStemFadeMs = fadeMs;
    const playback = this.baseMusicPlayback;
    if (playback) {
      this.fadeVoiceGain(playback.level1, level === 0 ? 0.34 : 0, fadeMs);
      this.fadeVoiceGain(playback.level2, level === 1 ? 0.34 : 0, fadeMs);
      return;
    }
    // 程序回退没有单独的主干，但它仍然必须遵守停靠/取消停靠，因此它永远不会在 Big Win 音乐下泄漏。
    if (level === null) {
      if (!this.fallbackLoops.delete("ambient.city")) return;
      this.tryFallback(() => this.fallback?.stopLoop("ambient.city", fadeMs));
      return;
    }
    if (!this.fallbackLoops.has("ambient.city") && this.fallback?.state === "running") {
      this.startFallbackLoop("ambient.city", normalizeAudioCueOptions());
    }
  }

  /**
   * FREESPIN_INTRO首先对接锁相对，然后捕获的BaseGameMusicStop程序仅解析`1065MusBgLvl1`。
   * 为其预设的 2s 尾部保持二级活动并释放语义循环所有权，以便 FREESPIN_END 可以从样本零创建一个新的播放前停止对。
   */
  enterFreeSpinsBaseMusic(dockFadeMs = 2_000, levelOneStopFadeMs = 120): void {
    this.pendingLoops.delete("ambient.city");
    this.baseMusicStemTarget = null;
    this.baseMusicStemFadeMs = dockFadeMs;
    const playback = this.baseMusicPlayback;
    if (playback) {
      this.fadeVoiceGain(playback.level1, 0, dockFadeMs);
      this.fadeVoiceGain(playback.level2, 0, dockFadeMs);
      this.sampleLoops.delete("ambient.city");
      this.stopVoice(playback.level1, levelOneStopFadeMs);
      return;
    }
    if (!this.fallbackLoops.delete("ambient.city")) return;
    this.tryFallback(() => this.fallback?.stopLoop("ambient.city", levelOneStopFadeMs));
  }

  stopLoop(cue: LoopAudioCue, fadeMs = 90): void {
    this.pendingLoops.delete(cue);
    this.duckedCounterLoops.delete(cue);
    const voices = this.sampleLoops.get(cue);
    if (voices) {
      this.sampleLoops.delete(cue);
      for (const voice of voices) this.stopVoice(voice, fadeMs);
    }
    if (cue === "ambient.city") this.baseMusicPlayback = null;
    if (cue === "reel.motor" || cue === "reel.loop") this.reelMotorPlayback = null;
    if (this.fallbackLoops.delete(cue)) {
      this.tryFallback(() => this.fallback?.stopLoop(cue, fadeMs));
    }
  }

  quickStopReelMotor(): void {
    this.pendingLoops.delete("reel.motor");
    this.pendingLoops.delete("reel.loop");
    this.sampleLoops.delete("reel.motor");
    this.sampleLoops.delete("reel.loop");
    const playback = this.reelMotorPlayback;
    if (playback) {
      this.reelMotorPlayback = null;
      const fadeMs = playback.cue === "743SpinsLoop1of3"
        ? 500
        : playback.cue === "743SpinsLoop2of3"
          ? 900
          : 1_200;
      this.stopVoice(playback.voice, fadeMs);
      return;
    }
    if (!this.fallbackLoops.delete("reel.motor")) return;
    this.tryFallback(() => {
      if (this.fallback?.quickStopReelMotor) this.fallback.quickStopReelMotor();
      else this.fallback?.stopLoop("reel.motor", 500);
    });
  }

  finishReelMotorNaturally(): void {
    // ReelStart 和 ReelLoop 是一次性预设的。在不停止任一源的情况下分离语义循环所有权，因此在最终物理卷轴撞击后捕获的尾部仍然可以听到。
    if (this.pendingLoops.delete("reel.motor") || this.pendingLoops.delete("reel.loop")) return;
    if (this.sampleLoops.delete("reel.motor") || this.sampleLoops.delete("reel.loop")) {
      this.reelMotorPlayback = null;
      return;
    }
    if (!this.fallbackLoops.delete("reel.motor")) return;
    this.tryFallback(() => this.fallback?.stopLoop("reel.motor", 110));
  }

  async suspend(): Promise<void> {
    if (this.destroyed) return;
    const tasks: Promise<unknown>[] = [];
    if (this.context && this.context.state === "running") {
      tasks.push(Promise.resolve(this.context.suspend()));
    }
    if (!this.usesNativeSprites() && this.fallback) {
      tasks.push(Promise.resolve().then(() => this.fallback?.suspend()));
    }
    await Promise.allSettled(tasks);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.lifetime.abort(new Error("Audio backend was destroyed"));
    this.releaseAllSampleVoices();
    this.bufferLoads.clear();
    this.buffers.clear();
    this.pendingOneShots.length = 0;
    this.pendingLoops.clear();
    this.failedPacks.clear();
    this.duckedCounterLoops.clear();
    this.primeAttempt = null;
    this.launchPrimeAttempt = null;
    this.backgroundPreloadAttempt = null;
    this.fallbackLoops.clear();
    try {
      this.master?.disconnect();
    } catch {
      // 上下文可能已经关闭。
    }
    this.master = null;
    const context = this.context;
    this.context = null;
    const tasks: Promise<unknown>[] = [];
    if (context && context.state !== "closed") tasks.push(Promise.resolve(context.close()));
    if (this.fallback) tasks.push(Promise.resolve().then(() => this.fallback?.destroy()));
    await Promise.allSettled(tasks);
  }

  private async performUnlock(): Promise<boolean> {
    if (this.usesNativeSprites()) return this.unlockNative();
    return this.unlockFallback();
  }

  private async performPrime(): Promise<void> {
    if (!this.context || this.context.state === "closed") {
      this.context = this.contextFactory();
      this.master = null;
    }
    const context = this.context;
    if (!context || this.destroyed) return;
    if (!this.master) this.buildGraph(context);
    await this.ensureMainReady(context);
  }

  private async performLaunchPrime(): Promise<void> {
    if (!this.context || this.context.state === "closed") {
      this.context = this.contextFactory();
      this.master = null;
    }
    const context = this.context;
    if (!context) throw new Error("AudioContext is unavailable for launch preload");
    if (!this.master) this.buildGraph(context);

    this.mainLoadFailed = false;
    try {
      // 同时进行的宽容主要/背景尝试共享这些确切的每包承诺，而这全部五个障碍保留拒绝。
      await this.loadPacks(context, PRIMAL_LAUNCH_AUDIO_PACKS);
      if (this.destroyed || this.context !== context || context.state === "closed") {
        throw new Error("Audio context changed during launch preload");
      }
      this.mainReady = true;
      this.mainLoadFailed = false;
      this.flushPendingAudio();
    } catch (error) {
      if (!this.destroyed) {
        this.mainReady = false;
        this.mainLoadFailed = true;
        this.flushPendingAudio();
      }
      throw error;
    }
  }

  private async unlockNative(): Promise<boolean> {
    if (!this.nativeSupported || !this.fetcher || this.destroyed) return false;
    try {
      if (!this.context || this.context.state === "closed") {
        this.context = this.contextFactory();
        this.master = null;
      }
      const context = this.context;
      if (!context) return false;
      if (!this.master) this.buildGraph(context);
      const mainAttempt = this.ensureMainReady(context);
      const resumeAttempt = context.state === "running"
        ? Promise.resolve()
        : Promise.resolve(context.resume());
      await Promise.all([mainAttempt, resumeAttempt]);
      return !this.destroyed && this.mainReady && context.state === "running";
    } catch {
      return false;
    }
  }

  private async unlockFallback(): Promise<boolean> {
    if (!this.fallback?.available || this.destroyed) return false;
    try {
      return await this.fallback.unlock();
    } catch {
      return false;
    }
  }

  private buildGraph(context: AudioContext): void {
    const master = context.createGain();
    master.gain.value = this.muted ? 0 : MASTER_GAIN;
    master.connect(context.destination);
    this.master = master;
  }

  private async ensureMainReady(context: AudioContext): Promise<void> {
    if (this.mainReady) {
      this.flushPendingAudio();
      this.startBackgroundPreload(context);
      return;
    }
    this.mainLoadFailed = false;
    try {
      await this.loadPacks(context, PRIMAL_MAIN_AUDIO_PACKS);
      if (this.destroyed || this.context !== context) return;
      this.mainReady = true;
      this.mainLoadFailed = false;
      this.flushPendingAudio();
      this.startBackgroundPreload(context);
    } catch (error) {
      if (!this.destroyed) {
        this.mainReady = false;
        this.mainLoadFailed = true;
        this.flushPendingAudio();
      }
      throw error;
    }
  }

  private async loadPacks(
    context: AudioContext,
    ids: readonly PrimalAudioPackId[],
  ): Promise<void> {
    await Promise.all(ids.map((id) => this.loadPack(context, id)));
  }

  private startBackgroundPreload(context: AudioContext): void {
    if (this.destroyed || this.context !== context || this.backgroundPreloadAttempt) return;
    const missing = PRIMAL_BACKGROUND_AUDIO_PACKS.filter((id) => !this.buffers.has(id));
    if (missing.length === 0) return;
    // 延迟包装失败就是完全的沉默。稍后的手势可能会重试，但捕获的语义永远不会路由到程序后端。
    const attempt = Promise.allSettled(
      missing.map((id) => this.loadPack(context, id)),
    ).then(() => {
      this.flushPendingAudio();
    });
    this.backgroundPreloadAttempt = attempt;
    void attempt.finally(() => {
      if (this.backgroundPreloadAttempt === attempt) this.backgroundPreloadAttempt = null;
    }).catch(() => undefined);
  }

  private loadPack(context: AudioContext, id: PrimalAudioPackId): Promise<AudioBuffer> {
    if (this.destroyed || this.lifetime.signal.aborted) {
      return Promise.reject(this.audioLoadAbortError());
    }
    const decoded = this.buffers.get(id);
    if (decoded) return Promise.resolve(decoded);
    const loading = this.bufferLoads.get(id);
    if (loading) return loading;
    const fetcher = this.fetcher;
    if (!fetcher) return Promise.reject(new Error("Audio fetch is unavailable"));

    const file = this.packFiles[id];
    this.failedPacks.delete(id);
    const promise = fetcher(`${this.assetBaseUrl}/${file}`, {
      signal: this.lifetime.signal,
      credentials: "same-origin",
      cache: "default",
    })
      .then(async (response) => {
        this.throwIfAudioLoadInactive(context);
        if (!response.ok) {
          const error = new Error(`Audio asset ${file} returned HTTP ${response.status}`);
          cancelNetworkResponse(response, error);
          throw error;
        }
        return readBoundedResponseArrayBuffer(response, {
          label: "Audio asset response",
          maxBytes: NETWORK_RESPONSE_LIMITS.audioAssetBytes,
          signal: this.lifetime.signal,
        });
      })
      .then((encoded) => {
        this.throwIfAudioLoadInactive(context);
        return context.decodeAudioData(encoded);
      })
      .then((buffer) => {
        this.throwIfAudioLoadInactive(context);
        this.buffers.set(id, buffer);
        this.failedPacks.delete(id);
        this.flushPendingAudio();
        return buffer;
      })
      .catch((error: unknown) => {
        // 销毁已经原子清除的每个拥有的集合。取指或不可中止的解码可能会稍后解决；它绝不能复活状态。
        if (!this.destroyed) {
          this.bufferLoads.delete(id);
          this.failedPacks.add(id);
          this.flushPendingAudio();
        }
        throw error;
      });
    // 合成/嵌入器获取实现可能会在返回其承诺之前同步拆除后端。也永远不要在那个狭窄的边界内重新填充所有权。
    if (!this.destroyed) this.bufferLoads.set(id, promise);
    return promise;
  }

  private throwIfAudioLoadInactive(context: AudioContext): void {
    if (this.destroyed || this.lifetime.signal.aborted) {
      throw this.audioLoadAbortError();
    }
    if (this.context !== context || context.state === "closed") {
      throw new Error("Audio context changed during decode");
    }
  }

  private audioLoadAbortError(): Error {
    const reason = this.lifetime.signal.reason;
    if (reason instanceof Error) return reason;
    const error = new Error("Audio pack load was aborted");
    error.name = "AbortError";
    return error;
  }

  private usesNativeSprites(): boolean {
    return this.nativeSupported && this.fetcher !== null;
  }

  private audioClockMs(): number {
    const currentTime = this.context?.currentTime;
    if (currentTime !== undefined && Number.isFinite(currentTime)) return currentTime * 1_000;
    return this.now();
  }

  private isOneShotReady(cue: OneShotAudioCue): boolean {
    return this.mainReady
      && (!PRIMAL_DELAYED_ONE_SHOTS.has(cue) || this.buffers.has("delayed"));
  }

  private isLoopReady(cue: LoopAudioCue): boolean {
    return this.mainReady
      && (!PRIMAL_DELAYED_LOOPS.has(cue) || this.buffers.has("delayed"));
  }

  private isOneShotUnavailable(cue: OneShotAudioCue): boolean {
    return this.mainLoadFailed
      || (PRIMAL_DELAYED_ONE_SHOTS.has(cue) && this.failedPacks.has("delayed"));
  }

  private isLoopUnavailable(cue: LoopAudioCue): boolean {
    return this.mainLoadFailed
      || (PRIMAL_DELAYED_LOOPS.has(cue) && this.failedPacks.has("delayed"));
  }

  private flushPendingAudio(): void {
    if (this.destroyed) return;
    const nowMs = this.audioClockMs();
    const oneShots = this.pendingOneShots.splice(0);
    for (const pending of oneShots) {
      if (this.isOneShotUnavailable(pending.cue)) continue;
      if (!this.isOneShotReady(pending.cue)) {
        this.pendingOneShots.push(pending);
        continue;
      }
      this.playNativeOneShot(
        pending.cue,
        pending.options,
        Math.max(0, nowMs - pending.requestedAtMs),
      );
    }

    for (const [cue, pending] of [...this.pendingLoops]) {
      if (this.isLoopUnavailable(cue)) {
        this.pendingLoops.delete(cue);
        this.duckedCounterLoops.delete(cue);
        continue;
      }
      if (!this.isLoopReady(cue)) continue;
      this.pendingLoops.delete(cue);
      this.startNativeLoop(
        cue,
        pending.options,
        Math.max(0, nowMs - pending.requestedAtMs),
      );
    }
  }

  private setGenericCounterDuck(ducked: boolean): void {
    const targets = ["counter.normal-generic", "counter.big-win"] as const;
    for (const cue of targets) {
      const voices = this.sampleLoops.get(cue);
      const pending = this.pendingLoops.has(cue);
      if (!voices && !pending) continue;
      if (ducked) this.duckedCounterLoops.add(cue);
      else this.duckedCounterLoops.delete(cue);
      const target = ducked ? 0 : cue === "counter.normal-generic" ? 1 : 0.46;
      for (const voice of voices ?? []) this.fadeVoiceGain(voice, target, 200);
    }
  }

  private playSprite(name: PrimalSpriteCueName, options: PlaySpriteOptions): SpriteVoice | null {
    const context = this.context;
    const master = this.master;
    const definition: PrimalSpriteCueDefinition = PRIMAL_CUE_DEFINITIONS[name];
    const buffer = this.buffers.get(definition.pack);
    if (!context || !master || context.state === "closed" || !buffer || this.destroyed) {
      return null;
    }

    const catchUpMs = Math.max(0, this.playbackCatchUpMs);
    const remainingDelayMs = Math.max(0, options.semantic.delayMs - catchUpMs);
    const elapsedAfterDelaySeconds = Math.max(0, catchUpMs - options.semantic.delayMs) / 1_000;
    const when = options.startTimeSeconds ?? context.currentTime + remainingDelayMs / 1_000;
    const cueStart = primalSampleTime(definition.startSample);
    const cueEnd = primalSampleTime(definition.endSample);
    const offset = clamp(options.offsetSeconds ?? 0, 0, Math.max(0, cueEnd - cueStart - 0.001));
    const authoredPlaybackStart = cueStart + offset;
    const authoredDuration = cueEnd - authoredPlaybackStart;
    if (!(authoredDuration > 0)) return null;

    const configuredLoopStart = definition.loopStartSample === undefined
      ? authoredPlaybackStart
      : Math.max(authoredPlaybackStart, primalSampleTime(definition.loopStartSample));
    const configuredLoopEnd = definition.loopEndSample === undefined
      ? cueEnd
      : Math.max(configuredLoopStart + 0.001, primalSampleTime(definition.loopEndSample));
    let playbackStart = authoredPlaybackStart;
    let duration = authoredDuration;
    if (elapsedAfterDelaySeconds > 0) {
      if (!options.loop) {
        if (elapsedAfterDelaySeconds >= authoredDuration) return null;
        playbackStart += elapsedAfterDelaySeconds;
        duration -= elapsedAfterDelaySeconds;
      } else {
        const leadInSeconds = Math.max(0, configuredLoopStart - authoredPlaybackStart);
        if (elapsedAfterDelaySeconds < leadInSeconds) {
          playbackStart += elapsedAfterDelaySeconds;
        } else {
          const loopDurationSeconds = Math.max(0.001, configuredLoopEnd - configuredLoopStart);
          playbackStart = configuredLoopStart
            + ((elapsedAfterDelaySeconds - leadInSeconds) % loopDurationSeconds);
        }
      }
    }

    if (options.stopBeforePlay) {
      for (const voice of [...this.voices]) {
        if (voice.name === name) this.releaseVoice(voice);
      }
    }

    if (this.voices.size >= this.maxVoices) {
      const oldest = this.voices.values().next().value as SpriteVoice | undefined;
      if (oldest) this.releaseVoice(oldest);
    }

    const source = context.createBufferSource();
    const gain = context.createGain();
    const nodes: AudioNode[] = [source, gain];
    source.buffer = buffer;
    const pan = options.semantic.pan;
    if (typeof context.createStereoPanner === "function" && Math.abs(pan) > 0.001) {
      const panner = context.createStereoPanner();
      panner.pan.value = clamp(pan, -1, 1);
      source.connect(panner).connect(gain);
      nodes.push(panner);
    } else {
      source.connect(gain);
    }
    gain.connect(master);

    const targetGain = clamp(options.gain * options.semantic.intensity, 0, 2);
    const fadeIn = Math.max(0, options.fadeInSeconds ?? 0);
    if (fadeIn > 0) {
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(targetGain, when + fadeIn);
    } else {
      gain.gain.setValueAtTime(targetGain, when);
    }

    if (options.loop) {
      source.loop = true;
      source.loopStart = configuredLoopStart;
      source.loopEnd = configuredLoopEnd;
    }

    const voice: SpriteVoice = { name, source, gain, nodes };
    source.addEventListener("ended", () => this.forgetVoice(voice), { once: true });
    try {
      if (options.loop) source.start(when, playbackStart);
      else source.start(when, playbackStart, duration);
      this.voices.add(voice);
      return voice;
    } catch {
      disconnect(nodes);
      return null;
    }
  }

  private playScatterLand(
    ordinal: 1 | 2 | 3 | 4 | 5,
    options: NormalizedAudioCueOptions,
  ): boolean {
    const centeredOptions = { ...options, pan: 0 };
    const cue = PRIMAL_SCATTER_LAND_CUES[ordinal - 1]!;
    const scatterGains = [0.14, 0.32, 0.24, 0.9, 0.96] as const;
    const scatter = this.playSprite(cue, {
      gain: scatterGains[ordinal - 1]!,
      semantic: centeredOptions,
      stopBeforePlay: ordinal !== 1,
    });
    if (ordinal > 3) return scatter !== null;

    const collectGains = [0.32, 0.32, 0.18] as const;
    const collectOffsets = [1, 1.25, 1.28] as const;
    const collect = this.playSprite("1065SymRageCollect", {
      gain: collectGains[ordinal - 1]!,
      semantic: centeredOptions,
      offsetSeconds: collectOffsets[ordinal - 1]!,
      stopBeforePlay: true,
    });
    const low = this.playSprite(this.nextRandomUnique(
      "scatter-land-low-hit",
      ["1065SymLp1Win", "1065SymLp2Win"],
    ), {
      gain: 0.38,
      semantic: centeredOptions,
      stopBeforePlay: true,
    });
    return scatter !== null || collect !== null || low !== null;
  }

  private playWildLand(options: NormalizedAudioCueOptions): boolean {
    const centeredOptions = { ...options, pan: 0 };
    const voices = [
      this.playSprite("1065SymMp1Win", {
        gain: 0.42,
        semantic: this.withAdditionalDelay(centeredOptions, 300),
        offsetSeconds: 0.5,
        stopBeforePlay: true,
      }),
      this.playSprite("1065ScatterLand1of5", {
        gain: 0.38,
        semantic: this.withAdditionalDelay(centeredOptions, 300),
        offsetSeconds: 0.15,
        stopBeforePlay: true,
      }),
      this.playSprite("1065ScatterLand2of5", {
        gain: 0.5,
        semantic: this.withAdditionalDelay(centeredOptions, 300),
        stopBeforePlay: true,
      }),
      this.playSprite("1065SymLp2Win", {
        gain: 0.44,
        semantic: this.withAdditionalDelay(centeredOptions, 300),
        stopBeforePlay: true,
      }),
      this.playSprite("1065SymLp1Win", {
        gain: 0.48,
        semantic: this.withAdditionalDelay(centeredOptions, 450),
        stopBeforePlay: true,
      }),
      this.playSprite("1065ScatterLand3of5", {
        gain: 0.42,
        semantic: this.withAdditionalDelay(centeredOptions, 450),
        stopBeforePlay: true,
      }),
    ];
    return voices.some((voice) => voice !== null);
  }

  private startReelMotor(options: NormalizedAudioCueOptions): SpriteVoice[] | null {
    const intro = this.playReelStartSample(options);
    const loopVoices = this.startReelLoopSample(options);
    const loop = loopVoices?.[0] ?? null;
    if (loop) return intro ? [intro, loop] : [loop];
    if (intro) this.releaseVoice(intro);
    return null;
  }

  private playReelStartSample(options: NormalizedAudioCueOptions): SpriteVoice | null {
    const introName = this.nextRandom(PRIMAL_UI_SPIN_CUES);
    return this.playSprite(introName, { gain: 0.7, semantic: options });
  }

  private startReelLoopSample(options: NormalizedAudioCueOptions): SpriteVoice[] | null {
    const loopName = this.nextSequence("reel-loop", PRIMAL_REEL_LOOP_CUES);
    const loop = this.playSprite(loopName, {
      gain: 0.57,
      semantic: options,
      offsetSeconds: 0.6,
    });
    if (loop) {
      this.reelMotorPlayback = { cue: loopName, voice: loop };
      return [loop];
    }
    return null;
  }

  private startBaseMusic(options: NormalizedAudioCueOptions): SpriteVoice[] | null {
    if (!this.hasCueBuffer("1065MusBgLvl1") || !this.hasCueBuffer("1065MusBgLvl2")) return null;
    const context = this.context;
    if (!context) return null;
    // SoundStage 在同一个 BaseGameMusicStart 调度上启动两个标题。将其源开始固定到一个时钟读取，以便茎保持锁相。
    const remainingDelayMs = Math.max(0, options.delayMs - this.playbackCatchUpMs);
    const startTimeSeconds = context.currentTime + remainingDelayMs / 1_000;
    const targetLevel = this.baseMusicStemTarget;
    const fadeSeconds = Math.max(0, this.baseMusicStemFadeMs) / 1_000;
    const level1 = this.playSprite("1065MusBgLvl1", {
      gain: targetLevel === 0 ? 0.34 : 0,
      semantic: options,
      loop: true,
      fadeInSeconds: targetLevel === 0 ? fadeSeconds : 0,
      startTimeSeconds,
      stopBeforePlay: true,
    });
    // 原始发动机将两个阀杆锁相在 SPLASH_HIDE。在稍后的音乐罐转换之前，第二级是听不到的，但它必须共享样本 0。
    const level2 = this.playSprite("1065MusBgLvl2", {
      gain: targetLevel === 1 ? 0.34 : 0,
      semantic: options,
      loop: true,
      fadeInSeconds: targetLevel === 1 ? fadeSeconds : 0,
      startTimeSeconds,
      stopBeforePlay: true,
    });
    if (level1 && level2) {
      this.baseMusicPlayback = { level1, level2 };
      return [level1, level2];
    }
    if (level1) this.releaseVoice(level1);
    if (level2) this.releaseVoice(level2);
    return null;
  }

  private startFreeSpinMusic(options: NormalizedAudioCueOptions): SpriteVoice[] | null {
    if (!this.hasCueBuffer("1065MusFs")) return null;
    const voice = this.playSprite("1065MusFs", {
      gain: 0.26,
      semantic: options,
      loop: true,
      fadeInSeconds: 1,
    });
    return voice ? [voice] : null;
  }

  private startSingleSampleLoop(
    cue: PrimalSpriteCueName,
    gain: number,
    options: NormalizedAudioCueOptions,
    stopBeforePlay = false,
  ): SpriteVoice[] | null {
    if (!this.hasCueBuffer(cue)) return null;
    const voice = this.playSprite(cue, {
      gain,
      semantic: options,
      loop: true,
      stopBeforePlay,
    });
    return voice ? [voice] : null;
  }

  private withAdditionalDelay(
    options: NormalizedAudioCueOptions,
    delayMs: number,
  ): NormalizedAudioCueOptions {
    return {
      ...options,
      delayMs: clamp(options.delayMs + delayMs, 0, 10_000),
    };
  }

  private hasCueBuffer(name: PrimalSpriteCueName): boolean {
    return this.buffers.has(PRIMAL_CUE_DEFINITIONS[name].pack);
  }

  private nextSequence<T extends PrimalSpriteCueName>(key: string, values: readonly T[]): T {
    const index = this.sequenceIndexes.get(key) ?? 0;
    const value = values[index % values.length];
    if (value === undefined) throw new Error(`Empty audio sequence ${key}`);
    this.sequenceIndexes.set(key, (index + 1) % values.length);
    return value;
  }

  private nextRandom<T extends PrimalSpriteCueName>(values: readonly T[]): T {
    if (values.length === 0) throw new Error("Empty random audio group");
    const raw = this.random();
    const index = Number.isFinite(raw)
      ? clamp(Math.floor(raw * values.length), 0, values.length - 1)
      : 0;
    const value = values[index];
    if (value === undefined) throw new Error("Invalid random audio group index");
    return value;
  }

  private nextRandomUnique<T extends PrimalSpriteCueName>(key: string, values: readonly T[]): T {
    if (values.length === 0) throw new Error(`Empty audio group ${key}`);
    const raw = this.random();
    let index = Number.isFinite(raw)
      ? clamp(Math.floor(raw * values.length), 0, values.length - 1)
      : 0;
    const previous = this.randomIndexes.get(key);
    if (values.length > 1 && previous === index) index = (index + 1) % values.length;
    const value = values[index];
    if (value === undefined) throw new Error(`Invalid audio group index ${key}`);
    this.randomIndexes.set(key, index);
    return value;
  }

  private stopVoice(voice: SpriteVoice, fadeMs: number): void {
    if (!this.voices.has(voice)) return;
    const context = this.context;
    const now = context?.currentTime ?? 0;
    const fadeSeconds = clamp(Number.isFinite(fadeMs) ? fadeMs : 0, 0, 2_000) / 1_000;
    if (fadeSeconds > 0) {
      try {
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(Math.max(0, voice.gain.gain.value), now);
        voice.gain.gain.linearRampToValueAtTime(0, now + fadeSeconds);
        voice.source.stop(now + fadeSeconds + 0.01);
        return;
      } catch {
        // 如果调度与已结束的源竞争，则会导致立即发布。
      }
    }
    this.releaseVoice(voice);
  }

  private fadeVoiceGain(voice: SpriteVoice, targetGain: number, fadeMs: number): void {
    if (!this.voices.has(voice)) return;
    const now = this.context?.currentTime ?? 0;
    const fadeSeconds = clamp(Number.isFinite(fadeMs) ? fadeMs : 0, 0, 10_000) / 1_000;
    const gain = voice.gain.gain;
    const target = clamp(targetGain, 0, 2);
    try {
      if (typeof gain.cancelAndHoldAtTime === "function") {
        gain.cancelAndHoldAtTime(now);
      } else {
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(Math.max(0, gain.value), now);
      }
      if (fadeSeconds > 0) gain.linearRampToValueAtTime(target, now + fadeSeconds);
      else gain.setValueAtTime(target, now);
    } catch {
      gain.value = target;
    }
  }

  private releaseVoice(voice: SpriteVoice): void {
    try {
      voice.source.stop(this.context?.currentTime ?? 0);
    } catch {
      // 已经结束的声音只需要图形清理。
    }
    this.forgetVoice(voice);
  }

  private forgetVoice(voice: SpriteVoice): void {
    if (!this.voices.delete(voice)) return;
    if (this.introVoice === voice) this.introVoice = null;
    if (this.wheelSpinVoice === voice) this.wheelSpinVoice = null;
    if (this.reelMotorPlayback?.voice === voice) this.reelMotorPlayback = null;
    if (this.baseMusicPlayback?.level1 === voice || this.baseMusicPlayback?.level2 === voice) {
      this.baseMusicPlayback = null;
    }
    for (const [cue, voices] of this.sampleLoops) {
      const remaining = voices.filter((candidate) => candidate !== voice);
      if (remaining.length === 0) this.sampleLoops.delete(cue);
      else if (remaining.length !== voices.length) this.sampleLoops.set(cue, remaining);
    }
    disconnect(voice.nodes);
  }

  private releaseAllSampleVoices(): void {
    for (const voice of [...this.voices]) this.releaseVoice(voice);
    this.sampleLoops.clear();
    this.introVoice = null;
    this.wheelSpinVoice = null;
    this.reelMotorPlayback = null;
    this.baseMusicPlayback = null;
  }

  private setMasterMuted(muted: boolean): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master || context.state === "closed") return;
    const now = context.currentTime;
    const target = muted ? 0 : MASTER_GAIN;
    const timeConstant = muted ? MUTE_TIME_CONSTANT : UNMUTE_TIME_CONSTANT;
    try {
      master.gain.cancelScheduledValues(now);
      master.gain.setTargetAtTime(target, now, timeConstant);
    } catch {
      master.gain.value = target;
    }
  }

  private playFallbackOneShot(cue: OneShotAudioCue, options: AudioCueOptions): void {
    if (this.fallback?.state !== "running") return;
    // 预设的面板剪辑位于可选的 sounds1 包中。如果在该包解码之前打开面板，请使用已支持的轻型 UI 单击，并且切勿在后台加载时保持交互。
    const fallbackCue = cue === "ui.open" || cue === "ui.close" ? "ui.click" : cue;
    this.tryFallback(() => this.fallback?.playOneShot(fallbackCue, options));
  }

  private startFallbackLoop(cue: LoopAudioCue, options: AudioCueOptions): void {
    if (this.fallback?.state !== "running") return;
    const started = this.tryFallback(() => this.fallback?.startLoop(cue, options));
    if (started) this.fallbackLoops.add(cue);
  }

  private tryFallback(action: () => void): boolean {
    try {
      action();
      return true;
    } catch {
      return false;
    }
  }

  private getNativeState(): AudioBackendState {
    if (!this.nativeSupported || !this.fetcher) return "unavailable";
    if (!this.context) return "locked";
    const state = this.context.state as string;
    if (state === "running" || state === "suspended" || state === "closed" || state === "interrupted") {
      return state;
    }
    return "suspended";
  }
}
