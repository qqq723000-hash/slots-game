import { PrimalSpriteAudioBackend } from "./PrimalSpriteAudioBackend";
import type { PrimalRuntimeAssetChannel } from "../assets/primalRuntimeAssets";
import { BaseMusicPotStateMachine } from "./BaseMusicPotStateMachine";
import {
  AUDIO_CUES,
  audioBusForCue,
  isLoopAudioCue,
  normalizeAudioCueOptions,
  type AudioBus,
  type AudioCue,
  type AudioCueOptions,
  type JackpotTier,
  type LoopAudioCue,
  type NormalizedAudioCueOptions,
  type OneShotAudioCue,
  type PayoutWinLevel,
  type PpsLevel,
  type ScatterLandOrdinal,
} from "./cues";

export {
  AUDIO_CUES,
  audioBusForCue,
  isLoopAudioCue,
  normalizeAudioCueOptions,
};
export type {
  AudioBus,
  AudioCue,
  AudioCueOptions,
  JackpotTier,
  LoopAudioCue,
  NormalizedAudioCueOptions,
  OneShotAudioCue,
  PayoutWinLevel,
  PpsLevel,
  ScatterLandOrdinal,
};

export type AudioBackendState = "unavailable" | "locked" | "suspended" | "running" | "closed" | "interrupted";
export type BaseMusicStemLevel = 0 | 1;
export type GameIntroClockMode = "playback-clock" | "wall-clock";

/** 小型可注入端口使浏览器 Web Audio 免受 Node 单元测试的影响。 / English: Small injectable port makes browser Web Audio immune to Node unit tests. */
export interface AudioBackend {
  readonly available: boolean;
  readonly state: AudioBackendState;
  /**
   * 只读播放纪元仅用于将启动视觉效果锁定到已安排的创作源。它绝不能恢复或改变音频。
   *
   * 英文 / English: Read-only playback epochs are only used to lock launch visuals to scheduled creative sources. It in no way restores or alters audio.
   */
  playbackClockMs?(): number | null;
  /** 尽最大努力解码预热，绝不能恢复或播放上下文。 / English: A best-effort decoding warmup is performed, and the context must never be restored or played. */
  prime?(): Promise<void>;
  /**
   * 严格的发射壁垒。实现必须获取/解码每个预设的启动包，传播任何失败并使上下文暂停。
   *
   * 英文 / English: Strict launch barriers. Implementations must obtain/decode each preset startup packet, propagate any failures and cause the context to be paused.
   */
  primeForLaunch?(): Promise<void>;
  unlock(): Promise<boolean>;
  /** 在后端运行后重新启动手势控制的非关键工作。 / English: Non-critical work of restarting gesture controls after the backend is running. */
  retryDeferredLoads?(): void;
  setMuted(muted: boolean): void;
  playOneShot(cue: OneShotAudioCue, options?: AudioCueOptions): void;
  stopOneShot?(cue: OneShotAudioCue, fadeMs?: number): void;
  startLoop(cue: LoopAudioCue, options?: AudioCueOptions): void;
  /**
   * 以原子方式配置并启动锁相 Base 主干。实现此接口的后端拥有唯一的初始淡入淡出；通用后端使用 `startLoop` 后跟下面的兼容性主干选择器。
   *
   * 英文 / English: Atomically configure and start the phase-locked Base trunk. Backends that implement this interface have a unique initial fade; generic backends use `startLoop` followed by the compatibility backbone selector below.
   */
  startBaseMusicProgram?(
    level: BaseMusicStemLevel | null,
    fadeMs?: number,
    options?: AudioCueOptions,
  ): void;
  /**
   * 选择音频层时，保持两个捕获的 Base 游戏主干锁相。 `null` 对接两个主干而不释放任何一个源。
   *
   * 英文 / English: Keeps the two captured Base game stems phase-locked when audio layers are selected. `null` Connects two trunks without releasing either source.
   */
  setBaseMusicStemLevel?(level: BaseMusicStemLevel | null, fadeMs?: number): void;
  /**
   * 捕获 FREESPIN_INTRO 不对称性：对接两个词干，但仅将 BaseGameMusicStop 标题解析为一级。
   *
   * 英文 / English: Catching FREESPIN_INTRO asymmetry: Docking both stems, but only parsing the BaseGameMusicStop header to level one.
   */
  enterFreeSpinsBaseMusic?(dockFadeMs?: number, levelOneStopFadeMs?: number): void;
  /** 应用捕获的特定于变体的 ReelLoop 淡入淡出，而不停止 ReelStart。 / English: Applies the captured variant-specific ReelLoop fade without stopping the ReelStart. */
  quickStopReelMotor?(): void;
  /** 在捕获的一次性 ReelLoop 完成时释放管理器所有权。 / English: Releases manager ownership when the captured one-shot ReelLoop completes. */
  finishReelMotorNaturally?(): void;
  stopLoop(cue: LoopAudioCue, fadeMs?: number): void;
  suspend(): Promise<void>;
  destroy(): void | Promise<void>;
}

export interface AudioPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AudioVisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: EventListener): void;
  removeEventListener(type: "visibilitychange", listener: EventListener): void;
}

/** 窗口级焦点是与文档可见性分开的浏览器信号。 / English: Window-level focus is a browser signal separate from document visibility. */
export interface AudioFocusSource {
  addEventListener(type: "focus" | "blur", listener: EventListener): void;
  removeEventListener(type: "focus" | "blur", listener: EventListener): void;
}

export interface AudioPreferences {
  readonly version: 1;
  readonly muted: boolean;
}

export type BigWinMusicResumeMode = "ambient" | "free-spins";

export interface AudioManagerOptions {
  backend?: AudioBackend;
  assetChannel?: PrimalRuntimeAssetChannel;
  storage?: AudioPreferenceStorage | null;
  visibilitySource?: AudioVisibilitySource | null;
  focusSource?: AudioFocusSource | null;
  preferenceKey?: string;
  initialMuted?: boolean;
}

export const AUDIO_PREFERENCE_KEY = "iron-colossus.audio.v1";
export const DEFAULT_AUDIO_PREFERENCES: AudioPreferences = Object.freeze({ version: 1, muted: false });

export class AudioLaunchPreloadUnavailableError extends Error {
  constructor(message = "Strict launch audio preload is unavailable") {
    super(message);
    this.name = "AudioLaunchPreloadUnavailableError";
  }
}

export function parseAudioPreferences(
  serialized: string | null,
  fallbackMuted = DEFAULT_AUDIO_PREFERENCES.muted,
): AudioPreferences {
  if (serialized === null) return { version: 1, muted: fallbackMuted };
  try {
    const value: unknown = JSON.parse(serialized);
    if (typeof value !== "object" || value === null) return { version: 1, muted: fallbackMuted };
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || typeof record.muted !== "boolean") {
      return { version: 1, muted: fallbackMuted };
    }
    return { version: 1, muted: record.muted };
  } catch {
    return { version: 1, muted: fallbackMuted };
  }
}

function defaultStorage(): AudioPreferenceStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function defaultVisibilitySource(): AudioVisibilitySource | null {
  try {
    return typeof document === "undefined" ? null : document;
  } catch {
    return null;
  }
}

function defaultFocusSource(): AudioFocusSource | null {
  try {
    return typeof window === "undefined" ? null : window;
  } catch {
    return null;
  }
}

/**
 * 仅拥有非权威声音呈现。事件接受与立即可听性分开：本机后端可以在其上下文暂停或其主设备静音时安排精确捕获的源。
 *
 * 英文 / English: Only non-authoritative voice renderings. Event acceptance is separated from immediate listenability: the native backend can schedule sources for precise capture while their context is paused or their master device is muted.
 */
export class AudioManager {
  private readonly backend: AudioBackend;
  private readonly storage: AudioPreferenceStorage | null;
  private readonly visibilitySource: AudioVisibilitySource | null;
  private readonly focusSource: AudioFocusSource | null;
  private readonly preferenceKey: string;
  private readonly gestureBindings = new Set<() => void>();
  private readonly desiredLoops = new Set<LoopAudioCue>();
  private readonly activeLoops = new Set<LoopAudioCue>();
  private mutedValue: boolean;
  /** 唯一的页面生命周期状态；每个浏览器信号都流经它。 / English: Unique page lifecycle state; every browser signal flows through it. */
  private pageActive: boolean;
  private everUnlocked = false;
  private destroyed = false;
  /** 当焦点信号在一回合发生变化时，使排队的生命周期工作无效。 / English: Invalidate queued lifecycle work when the focus signal changes during a turn. */
  private pageLifecycleRevision = 0;
  private priming: Promise<void> | null = null;
  private launchPriming: Promise<void> | null = null;
  private unlocking: Promise<boolean> | null = null;
  private lifecycle: Promise<void> = Promise.resolve();
  private bigWinCounterActive = false;
  private bigWinSweetenerTimer: ReturnType<typeof setTimeout> | null = null;
  private normalWinCounterActive = false;
  private normalWinSweetenerTimer: ReturnType<typeof setTimeout> | null = null;
  private baseMusicStemLevel: BaseMusicStemLevel = 0;
  private baseMusicDocked = false;
  private baseMusicTicker: ReturnType<typeof setInterval> | null = null;
  private readonly baseMusicPot = new BaseMusicPotStateMachine({
    onLevelChange: ({ level }) => {
      this.baseMusicStemLevel = level;
      this.applyBaseMusicStem(2_000);
    },
  });

  constructor(options: AudioManagerOptions = {}) {
    this.backend = options.backend ?? new PrimalSpriteAudioBackend({
      assetChannel: options.assetChannel,
    });
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.visibilitySource = options.visibilitySource === undefined
      ? defaultVisibilitySource()
      : options.visibilitySource;
    this.focusSource = options.focusSource === undefined
      ? defaultFocusSource()
      : options.focusSource;
    this.preferenceKey = options.preferenceKey ?? AUDIO_PREFERENCE_KEY;
    const fallbackMuted = options.initialMuted ?? DEFAULT_AUDIO_PREFERENCES.muted;
    this.mutedValue = this.readPreferences(fallbackMuted).muted;
    this.pageActive = !(this.visibilitySource?.hidden ?? false);
    this.tryBackend(() => this.backend.setMuted(this.mutedValue));
    this.visibilitySource?.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.focusSource?.addEventListener("blur", this.handlePageBlur);
    this.focusSource?.addEventListener("focus", this.handlePageFocus);
  }

  get muted(): boolean {
    return this.mutedValue;
  }

  get isAvailable(): boolean {
    return !this.destroyed && this.backend.available;
  }

  get isUnlocked(): boolean {
    return !this.destroyed && this.everUnlocked && this.backend.state === "running";
  }

  /** 稳定的只读时钟外观；调用者无法到达后端本身。 / English: Stable read-only clock appearance; callers cannot reach the backend itself. */
  getLaunchPlaybackClock(): Readonly<{ now(): number }> | null {
    if (this.destroyed || !this.backend.playbackClockMs) return null;
    const initial = this.backend.playbackClockMs();
    if (initial === null || !Number.isFinite(initial)) return null;
    return Object.freeze({
      now: (): number => {
        const value = this.backend.playbackClockMs?.();
        return value !== null && value !== undefined && Number.isFinite(value)
          ? value
          : initial;
      },
    });
  }

  /**
   * 在功能预览出现之前预热本机启动精灵。这是故意的尽力而为：不受支持的后端和解码失败是无声的，并且稍后的用户手势解锁仍然可以自由重试。
   *
   * 英文 / English: Warm up the native startup wizard before the feature preview appears. This is intentionally best-effort: unsupported backends and decoding failures are silent, and later user gesture unlocks are still free to retry.
   */
  prime(): Promise<void> {
    if (this.destroyed || !this.backend.available || !this.backend.prime) {
      return Promise.resolve();
    }
    if (this.priming) return this.priming;
    const attempt = Promise.resolve()
      .then(() => this.backend.prime?.())
      .then(() => undefined, () => undefined);
    this.priming = attempt;
    void attempt.finally(() => {
      if (this.priming === attempt) this.priming = null;
    }).catch(() => undefined);
    return attempt;
  }

  /**
   * 生产启动接口：与 `prime()` 不同，这是故障关闭的，并且只能在后端完整预设的包集解码后才能解决。
   *
   * 英文 / English: Production startup interface: Unlike `prime()`, this is fail-closed and can only be resolved after the backend has decoded the full set of preset packets.
   */
  primeForLaunch(): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new AudioLaunchPreloadUnavailableError("Audio manager was destroyed"));
    }
    if (!this.backend.available || !this.backend.primeForLaunch) {
      return Promise.reject(new AudioLaunchPreloadUnavailableError());
    }
    if (this.launchPriming) return this.launchPriming;
    const attempt = Promise.resolve().then(() => this.backend.primeForLaunch!());
    this.launchPriming = attempt;
    void attempt.finally(() => {
      if (this.launchPriming === attempt) this.launchPriming = null;
    }).catch(() => undefined);
    return attempt;
  }

  /**
   * 必须从用户激活调用堆栈中调用。并发尝试被合并到一个后端恢复中，并且失败仍然可以重试。
   *
   * 英文 / English: Must be called from the user-activated call stack. Concurrent attempts are merged into a single backend recovery, and failures can still be retried.
   */
  unlock(): Promise<boolean> {
    if (!this.canAttemptUnlock()) return Promise.resolve(false);
    // AudioContext.resume()可以在捕获的精灵包完成解码之前将后端状态切换为运行。始终参与进行中的工作；否则，唯一的 T0 介绍提示将在没有缓冲区的情况下被消耗。 / English: AudioContext.resume() can switch the backend state to running before the captured sprite packet has finished decoding. Always engage in work in progress; otherwise, the only T0 intro hint will be consumed without a buffer.
    if (this.unlocking) return this.unlocking;
    if (this.everUnlocked && this.backend.state === "running") {
      this.tryBackend(() => this.backend.retryDeferredLoads?.());
      this.syncDesiredLoops();
      return Promise.resolve(true);
    }

    const attempt = this.performUnlock();
    this.unlocking = attempt;
    void attempt.then(
      () => {
        if (this.unlocking === attempt) this.unlocking = null;
      },
      () => {
        if (this.unlocking === attempt) this.unlocking = null;
      },
    );
    return attempt;
  }

  /** 添加捕获侦听器并返回幂等分离函数。 / English: Add a capture listener and return an idempotent detached function. */
  bindUserGestures(target: EventTarget): () => void {
    if (this.destroyed) return () => undefined;
    let attached = true;
    const listener: EventListener = (event) => {
      if (event.type === "keydown") {
        const key = (event as KeyboardEvent).key;
        if (key !== "Enter" && key !== " " && key !== "Spacebar") return;
      }
      // 某些嵌入式浏览器表面在其 chrome 或开发人员面板获得焦点时会发出 `blur`，但在转发下一个游戏手势之前不会传递匹配的窗口 `focus`。 / English: Some embedded browser surfaces emit `blur` when their chrome or developer panel gains focus, but do not pass matching window `focus` before forwarding the next game gesture.
      // 当文档明显处于前景时收到的手势本身就是音频可以再次解锁的权威证据。在 canAttemptUnlock() 读取之前协调过时的焦点状态。 / English: The gesture received when the document is clearly in the foreground is in itself definitive proof that the audio can be unlocked again. Reconcile stale focus state before canAttemptUnlock() reads.
      // 真正隐藏的文档将保持被阻止状态并仍归 VisibilityChange 所有。 / English: Documents that are truly hidden will remain blocked and still owned by VisibilityChange.
      this.restoreVisibleGesturePageActivity();
      void this.unlock();
    };
    target.addEventListener("pointerdown", listener, { capture: true, passive: true });
    target.addEventListener("click", listener, { capture: true, passive: true });
    target.addEventListener("keydown", listener, { capture: true });

    const detach = (): void => {
      if (!attached) return;
      attached = false;
      target.removeEventListener("pointerdown", listener, { capture: true });
      target.removeEventListener("click", listener, { capture: true });
      target.removeEventListener("keydown", listener, { capture: true });
      this.gestureBindings.delete(detach);
    };
    this.gestureBindings.add(detach);
    return detach;
  }

  setMuted(muted: boolean): void {
    if (this.destroyed || this.mutedValue === muted) return;
    this.mutedValue = muted;
    this.writePreferences();
    this.tryBackend(() => this.backend.setMuted(muted));
    // 捕捉到的SoundManager静音是主增益操作。保持循环所有权和源播放完好无损，以便取消静音在同一阶段恢复。 / English: The captured SoundManager mute is the main gain operation. Keeps loop ownership and source playback intact so that unmuting resumes at the same stage.
    if (muted) return;
    if (this.everUnlocked && this.pageActive) this.enqueueLifecycle(async () => {
      if (await this.unlock()) this.syncDesiredLoops();
    });
  }

  /** 返回新的静音状态。取消静音也会在此手势中重试解锁。 / English: Return to new muted state. Unmuting will also retry unlocking in this gesture. */
  toggleMuted(): boolean {
    // TOGGLE_SOUND首先到达公共反馈订户，然后更改SoundManager主目标。这在两个方向上保留了预设的 btnClick， / English: TOGGLE_SOUND first reaches the public feedback subscriber and then changes the SoundManager master target. This retains the default btnClick in both directions,
    // 而没有发明延迟的 UIInteract 提示。 / English: Instead of inventing delayed UIInteract prompts.
    this.playButtonFeedback();
    this.setMuted(!this.mutedValue);
    if (!this.mutedValue) void this.unlock();
    return this.mutedValue;
  }

  playCue(cue: AudioCue, options: AudioCueOptions = {}): void {
    if (!this.canAcceptAudio()) return;
    if (isLoopAudioCue(cue)) {
      if (cue === "reel.motor") this.startReelMotor(options);
      else {
        // playCue 是暂时的，因此永远不会支持未来的播放。 / English: playCue is transient and therefore will never support future playback.
        this.desiredLoops.add(cue);
        this.startLoopNow(cue, options);
      }
      return;
    }
    this.tryBackend(() => this.backend.playOneShot(cue, normalizeAudioCueOptions(options)));
  }

  /** Splash 和官方声音切换共享的常见 `btnClick` 接口。 / English: Common `btnClick` interface shared by Splash and official sound switches. */
  playButtonFeedback(options: AudioCueOptions = {}): void {
    this.playCue("ui.button-feedback", options);
  }

  playUiClick(options: AudioCueOptions = {}): void {
    this.playCue("ui.click", options);
  }

  playUiOpen(options: AudioCueOptions = {}): void {
    this.playCue("ui.open", options);
  }

  playUiClose(options: AudioCueOptions = {}): void {
    this.playCue("ui.close", options);
  }

  playSplashContinue(options: AudioCueOptions = {}): void {
    this.playCue("ui.splash-continue", options);
  }

  playGameIntro(
    options: AudioCueOptions = {},
    clockMode: GameIntroClockMode = "playback-clock",
  ): void {
    // 取消预览分支没有合法的激活来将视觉时间轴绑定到网络音频。它的视觉效果有意利用了墙上的时间； / English: The Unpreview branch has no legal activation to bind the visual timeline to web audio. Its visuals make deliberate use of time on the wall;
    // 将 1065TrnGameIntro 调度到挂起的上下文中会使旧源在以后任意单击时从样本零开始。在锁定时放弃这一单枪并防御性地退出任何后端队列。 / English: Dispatching 1065TrnGameIntro into a suspended context causes the old source to start at sample zero on any future clicks. Give up on this one shot on lock and defensively exit any backend queues.
    // Continue 保留默认的播放时钟模式，并且可以在暂停时进行调度，因为其视觉时钟冻结在同一 AudioContext 上。 / English: Continue retains the default playback clock mode and can be scheduled while paused because its visual clock is frozen on the same AudioContext.
    if (clockMode === "wall-clock" && this.backend.state !== "running") {
      this.tryBackend(() => this.backend.stopOneShot?.("intro.game", 0));
      return;
    }
    this.playCue("intro.game", options);
  }

  stopGameIntro(fadeMs = 200): void {
    if (this.destroyed) return;
    this.tryBackend(() => this.backend.stopOneShot?.("intro.game", Math.max(0, fadeMs)));
  }

  playReelStop(_reel: number, options: AudioCueOptions = {}): void {
    // 捕获的ReelStop程序是单/中心的。卷轴标识仅选择呈现顺序；它永远不会改变立体声位置。 / English: The ReelStop program captured is single/center. The scroll flag only selects the presentation order; it never changes the stereo position.
    this.playCue("reel.stop", { ...options, pan: 0 });
  }

  playReelAnticipation(options: AudioCueOptions = {}): void {
    this.playCue("reel.anticipation", options);
  }

  stopReelAnticipation(fadeMs = 1_000): void {
    if (this.destroyed) return;
    this.tryBackend(() => this.backend.stopOneShot?.("reel.anticipation", Math.max(0, fadeMs)));
  }

  playScatterLand(ordinal: ScatterLandOrdinal, options: AudioCueOptions = {}): void {
    // 捕获的Rage/Scatter土地程序是在中心预设的；符号卷轴位置不会驱动立体放置。 / English: Captured Rage/Scatter land programs are preset in the center; symbol reel position does not drive stereo placement.
    this.playCue(`symbol.scatter-land-${ordinal}`, { ...options, pan: 0 });
  }

  playWildLand(options: AudioCueOptions = {}): void {
    // Wild的六层雷达复合材料同样是一个中心方案。 / English: Wild's six-layer radar composite is also a central solution.
    this.playCue("symbol.wild-land", { ...options, pan: 0 });
  }

  playEnergyCollect(options: AudioCueOptions = {}): void {
    this.playCue("energy.collect", options);
  }

  playPpsLevel(level: PpsLevel, options: AudioCueOptions = {}): void {
    this.playCue(`pps.level-${level}`, options);
  }

  playSymbolWin(
    tier: "lp1" | "lp2" | "mp1" | "mp2" | "hp1" | "hp2" | "wild" | "scatter-win",
    options: AudioCueOptions = {},
  ): void {
    this.playCue(`symbol.${tier}`, options);
  }

  /** 捕获的非庆祝结果用于 win < bet 和 win === bet。 / English: Captured non-celebration results for win < bet and win === bet. */
  playWinLossOrEqual(options: AudioCueOptions = {}): void {
    this.playCue("win.loss-or-equal", options);
  }

  playWheelSpin(options: AudioCueOptions = {}): void {
    this.playCue("wheel.spin", options);
  }

  playWheelAppear(options: AudioCueOptions = {}): void {
    this.playCue("wheel.appear", options);
  }

  /** WheelFeaturePanelIn 重用 WheelAppear 和捕获的 stop-before 语义。 / English: WheelFeaturePanelIn reuses WheelAppear and captures stop-before semantics. */
  playWheelPanelIn(options: AudioCueOptions = {}): void {
    this.playCue("wheel.panel-in", options);
  }

  /** 捕获的 WheelWait 循环：在车轮空闲事件时开始，在旋转时淡出。 / English: Captured WheelWait loop: starts on wheel idle event, fades out on rotation. */
  startWheelWait(options: AudioCueOptions = {}): void {
    if (this.destroyed) return;
    this.desiredLoops.add("wheel.wait");
    this.startLoopNow("wheel.wait", options);
  }

  stopWheelWait(fadeMs = 200): void {
    this.desiredLoops.delete("wheel.wait");
    this.stopLoopNow("wheel.wait", fadeMs);
  }

  playWheelAward(options: AudioCueOptions = {}): void {
    this.playCue("wheel.award", options);
  }

  /** 奖励ID 50条语义踪迹；抓拍到的SoundStage故意没有声音。 / English: Bonus ID 50 semantic traces; the captured SoundStage is deliberately silent. */
  playWheelKingSpinWon(options: AudioCueOptions = {}): void {
    this.playCue("wheel.king-spin-won", options);
  }

  /** 奖励ID 51语义踪迹；抓拍到的SoundStage故意没有声音。 / English: Bonus ID 51 Semantic Trace; captured SoundStage intentionally silent. */
  playWheelKongQuestWon(options: AudioCueOptions = {}): void {
    this.playCue("wheel.kong-quest-won", options);
  }

  playFeatureStart(options: AudioCueOptions = {}): void {
    this.playCue("feature.start", options);
  }

  playWin(options: AudioCueOptions = {}): void {
    this.playCue("win.sting", options);
  }

  playImpact(options: AudioCueOptions = {}): void {
    this.playCue("monster.impact", options);
  }

  /** Character-状态重击；在 API 接口处与通用调用者保持分离。 / English: Character - state hammering; maintains separation from generic callers at API interface. */
  playMonsterThump(options: AudioCueOptions = {}): void {
    this.playCue("monster.impact", options);
  }

  playMonsterRoar(options: AudioCueOptions = {}): void {
    this.playCue("monster.roar", options);
  }

  playMonsterRoarHit(options: AudioCueOptions = {}): void {
    this.playCue("monster.roar-hit", options);
  }

  playMonsterSniff(options: AudioCueOptions = {}): void {
    this.playCue("monster.sniff", options);
  }

  playMonsterThumpExpand(options: AudioCueOptions = {}): void {
    this.playCue("monster.thump-expand", options);
  }

  playMonsterReelStretch(options: AudioCueOptions = {}): void {
    this.playCue("monster.reel-stretch", options);
  }

  playMonsterFeatureActivate(options: AudioCueOptions = {}): void {
    this.playCue("monster.feature-activate", options);
  }

  /** 播放一组级别的解锁重音；以上三个计数共享 3+ 提示。 / English: Play a set of levels with unlockable accents; the three counts above share the 3+ tip. */
  playVaultUnlock(count: number, options: AudioCueOptions = {}): void {
    if (!Number.isFinite(count) || count < 1) return;
    const cue = count >= 3 ? "vault.unlock-3-plus" : count >= 2 ? "vault.unlock-2" : "vault.unlock-1";
    this.playCue(cue, options);
  }

  playVaultAnticipation(options: AudioCueOptions = {}): void {
    this.playCue("vault.anticipation", options);
  }

  playVaultFly(options: AudioCueOptions = {}): void {
    this.playCue("vault.fly", options);
  }

  playJackpotPot(tier: JackpotTier, options: AudioCueOptions = {}): void {
    this.playCue(`jackpot.${tier}`, options);
  }

  /** 级别是捕获的 Win1..Win8 支付比率桶，而不是原始乘数。 / English: Levels are captured Win1..Win8 payout ratio buckets, not raw multipliers. */
  playPayoutWin(level: PayoutWinLevel, options: AudioCueOptions = {}): void {
    this.playCue(`payout.win-${level}`, options);
  }

  /** 镜像自适应 Base 音乐壶使用的原始 ROUNDSTART 挂钩。 / English: Mirrors the original ROUNDSTART hook used by the Adaptive Base Music Pot. */
  beginBaseMusicRound(betMinor: string): void {
    if (this.destroyed || this.baseMusicPot.snapshot().roundOpen) return;
    try {
      this.baseMusicPot.beginRound(betMinor);
    } catch {
      // 对于格式错误的输入，表现音频必须保持非权威性。 / English: Performance audio must remain non-authoritative for malformed input.
    }
  }

  /** 镜像 WIN START / 无赢延迟完成，无需将金钱转换为数字。 / English: Mirror WIN START / No win delayed completion without converting money into numbers. */
  recordBaseMusicRoundOutcome(winMinor: string): void {
    if (this.destroyed || !this.baseMusicPot.snapshot().roundOpen) return;
    try {
      if (/^[1-9]\d*$/.test(winMinor)) this.baseMusicPot.recordWin(winMinor);
      else this.baseMusicPot.recordNoWin();
    } catch {
      // 忽略外观声音状态故障；服务器结果仍为最终结果。 / English: Ignore appearance sound status glitches; server results remain final.
    }
  }

  /** 镜像 ROUNDEND 并启动原始严格的 >30 秒空闲降级时钟。 / English: Mirror ROUNDEND and start the original strict >30 seconds idle downgrade clock. */
  endBaseMusicRound(): void {
    if (this.destroyed || !this.baseMusicPot.snapshot().roundOpen) return;
    try {
      this.baseMusicPot.endRound();
    } catch {
      // 音频状态绝不能干扰回合生命周期。 / English: Audio state must never interfere with the turn lifecycle.
    }
  }

  beginBigWin(inFreeSpins: boolean, options: AudioCueOptions = {}): void {
    if (this.destroyed) return;
    if (inFreeSpins) {
      this.endFreeSpinsLoop(options, "none");
    } else {
      // 已验收声轨不会为 Big Win 重新启动 Base 音乐。两个源都保持运行，并且只有当前选定的茎会停靠 2 秒。 / English: Accepted soundtracks will not restart Base Music for Big Win. Both sources remain running and only the currently selected stem is docked for 2 seconds.
      this.baseMusicDocked = true;
      this.baseMusicPot.dock();
      this.stopBaseMusicTicker();
      this.applyBaseMusicStem(2_000);
    }
    this.playCue("big-win.trigger", options);
    this.desiredLoops.add("music.big-win");
    this.startLoopNow("music.big-win", options);
  }

  beginBigWinCounter(options: AudioCueOptions = {}): void {
    if (this.destroyed) return;
    this.stopBigWinCounterTimer();
    this.bigWinCounterActive = true;
    this.playCue("big-win.counter-start", options);
    this.desiredLoops.add("counter.big-win");
    this.startLoopNow("counter.big-win", options);
    this.playCue("big-win.counter-sweetener", options);
    this.scheduleBigWinSweetener(options);
  }

  playBigWinLevelUp(options: AudioCueOptions = {}): void {
    this.playCue("big-win.level-up", options);
  }

  endBigWinCounter(options: AudioCueOptions = {}): void {
    const wasActive = this.bigWinCounterActive
      || this.desiredLoops.has("counter.big-win")
      || this.activeLoops.has("counter.big-win");
    this.bigWinCounterActive = false;
    this.stopBigWinCounterTimer();
    this.desiredLoops.delete("counter.big-win");
    this.stopLoopNow("counter.big-win", 150);
    if (wasActive) this.playCue("big-win.counter-tail", options);
  }

  /**
   * 启动捕获的正常 WinCounter 使用的两个层：通用代码加上游戏的 GenericNew 启动/循环/甜味剂系列。
   *
   * 英文 / English: Two layers of normal WinCounter usage for startup capture: Generic code plus the GenericNew startup/loop/sweetener family for the game.
   */
  beginNormalWinCounter(options: AudioCueOptions = {}): void {
    if (this.destroyed || this.normalWinCounterActive) return;
    this.stopNormalWinCounterTimer();
    this.normalWinCounterActive = true;
    this.playCue("normal-win.counter-start", options);
    this.desiredLoops.add("counter.normal-generic");
    this.desiredLoops.add("counter.normal-common");
    this.startLoopNow("counter.normal-generic", options);
    this.startLoopNow("counter.normal-common", options);
    // 原始处理程序立即发出第一个甜味剂，然后才安排以下 300..699ms 序列步骤。 / English: The original handler emits the first sweetener immediately before scheduling the following 300..699ms sequence steps.
    this.playCue("normal-win.counter-sweetener", options);
    this.scheduleNormalWinSweetener(options);
  }

  endNormalWinCounter(options: AudioCueOptions = {}): void {
    const wasActive = this.normalWinCounterActive
      || this.desiredLoops.has("counter.normal-generic")
      || this.activeLoops.has("counter.normal-generic")
      || this.desiredLoops.has("counter.normal-common")
      || this.activeLoops.has("counter.normal-common");
    this.normalWinCounterActive = false;
    this.stopNormalWinCounterTimer();
    this.desiredLoops.delete("counter.normal-generic");
    this.desiredLoops.delete("counter.normal-common");
    this.stopLoopNow("counter.normal-generic", 150);
    this.stopLoopNow("counter.normal-common", 0);
    if (wasActive) this.playCue("normal-win.counter-tail", options);
  }

  endBigWin(resumeMode: BigWinMusicResumeMode, options: AudioCueOptions = {}): void {
    if (this.destroyed) return;
    this.endBigWinCounter(options);
    this.desiredLoops.delete("music.big-win");
    this.stopLoopNow("music.big-win", 0);
    this.playCue("big-win.end", options);
    if (resumeMode === "free-spins") {
      this.desiredLoops.add("music.free-spins");
      this.startLoopNow("music.free-spins", options);
    } else if (resumeMode === "ambient") {
      this.baseMusicDocked = false;
      this.baseMusicPot.undock();
      this.startBaseMusicTicker();
      this.applyBaseMusicStem(2_000);
    }
  }

  startReelMotor(options: AudioCueOptions = {}): void {
    if (!this.canAcceptAudio()) return;
    this.desiredLoops.add("reel.motor");
    this.startLoopNow("reel.motor", options);
  }

  /** 精确的 SPIN_START 边界：仅播放 743UiSpin1of3..3of3。 / English: Exact SPIN_START boundaries: only play 743UiSpin1of3..3of3. */
  playReelStart(options: AudioCueOptions = {}): void {
    this.playCue("reel.start", options);
  }

  /** 精确卷轴 0 STARTING 边界：仅启动 743SpinsLoop1of3..3of3。 / English: Exact reel 0 STARTING boundary: Start only 743SpinsLoop1of3..3of3. */
  startReelLoop(options: AudioCueOptions = {}): void {
    if (!this.canAcceptAudio()) return;
    this.desiredLoops.add("reel.loop");
    this.startLoopNow("reel.loop", options);
  }

  stopReelLoop(fadeMs = 90): void {
    this.desiredLoops.delete("reel.loop");
    this.stopLoopNow("reel.loop", fadeMs);
  }

  quickStopReelLoop(): void {
    if (this.destroyed || !this.activeLoops.delete("reel.loop")) return;
    this.desiredLoops.delete("reel.loop");
    if (this.backend.quickStopReelMotor) {
      this.tryBackend(() => this.backend.quickStopReelMotor?.());
      return;
    }
    this.tryBackend(() => this.backend.stopLoop("reel.loop", 500));
  }

  finishReelLoopNaturally(): void {
    if (this.destroyed) return;
    this.desiredLoops.delete("reel.loop");
    if (!this.activeLoops.delete("reel.loop")) return;
    if (this.backend.finishReelMotorNaturally) {
      this.tryBackend(() => this.backend.finishReelMotorNaturally?.());
      return;
    }
    this.tryBackend(() => this.backend.stopLoop("reel.loop", 110));
  }

  stopReelMotor(fadeMs = 90): void {
    this.desiredLoops.delete("reel.motor");
    this.stopLoopNow("reel.motor", fadeMs);
  }

  quickStopReelMotor(): void {
    if (this.destroyed || !this.activeLoops.delete("reel.motor")) return;
    this.desiredLoops.delete("reel.motor");
    if (this.backend.quickStopReelMotor) {
      this.tryBackend(() => this.backend.quickStopReelMotor?.());
      return;
    }
    this.stopLoopNow("reel.motor", 500);
  }

  /** 正常停止让捕获的非循环 ReelStart/ReelLoop 样本结束。 / English: A graceful stop brings the captured acyclic ReelStart/ReelLoop sample to an end. */
  finishReelMotorNaturally(): void {
    if (this.destroyed) return;
    this.desiredLoops.delete("reel.motor");
    if (!this.activeLoops.delete("reel.motor")) return;
    if (this.backend.finishReelMotorNaturally) {
      this.tryBackend(() => this.backend.finishReelMotorNaturally?.());
      return;
    }
    // 程序/遗留后端确实是循环，需要短暂发布。 / English: Procedural/legacy backends are indeed loopy and require short releases.
    this.tryBackend(() => this.backend.stopLoop("reel.motor", 110));
  }

  /** Ambient 是场景状态，因此可能在第一次解锁之前请求。 / English: Ambient is scene state, so may be requested before it is first unlocked. */
  setAmbientEnabled(enabled: boolean, options: AudioCueOptions = {}): void {
    if (this.destroyed) return;
    if (!enabled) {
      this.desiredLoops.delete("ambient.city");
      this.stopLoopNow("ambient.city", 180);
      this.stopBaseMusicTicker();
      return;
    }
    // 场景音乐是独一无二的。重新连接/会话同步可以直接恢复 BASE，而无需先观察 Free Spins 完成事件。 / English: The scene music is unique. Reconnect/session sync can resume BASE directly without first observing the Free Spins completion event.
    this.desiredLoops.delete("music.free-spins");
    this.stopLoopNow("music.free-spins", 500);
    const wasDocked = this.baseMusicDocked;
    const wasActive = this.activeLoops.has("ambient.city");
    this.baseMusicDocked = false;
    this.baseMusicPot.undock();
    this.startBaseMusicTicker();
    this.desiredLoops.add("ambient.city");
    this.startLoopNow("ambient.city", options);
    // 新创建的源在 startLoopNow 中接收其预设的淡入淡出。 Intro之后的和解是故意幂等的；只有真正的停靠→Base 转换才会将选定的主干重新应用到现有源。 / English: Newly created sources receive their preset fades in startLoopNow. Reconciliation after Intro is intentionally idempotent; only a true Dock→Base transformation will reapply the selected trunk to the existing source.
    if (wasActive && wasDocked) this.applyBaseMusicStem(2_000);
  }

  /** 在 FREESPIN_INTRO 处启动精确捕获的 Free Spins 程序。 / English: Start the precisely captured Free Spins program at FREESPIN_INTRO. */
  setFreeSpinsMusicEnabled(
    enabled: boolean,
    options: AudioCueOptions = {},
    showOutroPanel = true,
  ): void {
    if (this.destroyed) return;
    if (enabled) {
      const hadDesiredBase = this.desiredLoops.delete("ambient.city");
      const hadActiveBase = this.activeLoops.delete("ambient.city");
      // BaseGameMusicStop 仅解析此版本中的一级标题。因此，二级源遵循其正常的 2 秒停靠淡入淡出。 / English: BaseGameMusicStop only parses first level titles in this version. Therefore, the secondary source follows its normal 2 second docked fade.
      const baseFadeMs = this.baseMusicStemLevel === 0 ? 120 : 2_000;
      this.baseMusicDocked = true;
      this.baseMusicPot.dock();
      this.stopBaseMusicTicker();
      if (hadDesiredBase || hadActiveBase) {
        if (this.backend.enterFreeSpinsBaseMusic) {
          this.tryBackend(() => this.backend.enterFreeSpinsBaseMusic?.(2_000, 120));
        } else {
          // 无需单独的茎即可兼容合成/遗留后端。 / English: No separate stem required for compatibility with synthetic/legacy backends.
          this.tryBackend(() => this.backend.stopLoop("ambient.city", baseFadeMs));
        }
      }
      this.desiredLoops.add("music.free-spins");
      this.startLoopNow("music.free-spins", options);
      return;
    }
    this.endFreeSpinsLoop(options, showOutroPanel ? "visible" : "skip");
  }

  /**
   * FREESPIN_END 是与 SUMMARY 不同的边界。它同时启动两个 Base 源，并使用预设的 2 秒淡入淡出恢复记住的主干，
   * 从而允许无摘要路径与 1.5 秒 Free Spins 尾部重叠。
   *
   * 英文 / English: FREESPIN_END is a different boundary than SUMMARY. It starts both Base sources simultaneously and restores the remembered stem using a preset 2 second fade, allowing summary-free paths to overlap with the 1.5 second Free Spins tail.
   */
  endFreeSpinsMode(options: AudioCueOptions = {}): void {
    if (this.destroyed) return;
    const wasDocked = this.baseMusicDocked;
    const wasActive = this.activeLoops.has("ambient.city");
    this.baseMusicDocked = false;
    this.baseMusicPot.undock();
    this.startBaseMusicTicker();
    this.desiredLoops.add("ambient.city");
    this.startLoopNow("ambient.city", options);
    if (wasActive && wasDocked) this.applyBaseMusicStem(2_000);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.priming = null;
    this.launchPriming = null;
    this.bigWinCounterActive = false;
    this.stopBigWinCounterTimer();
    this.normalWinCounterActive = false;
    this.stopNormalWinCounterTimer();
    this.stopBaseMusicTicker();
    this.visibilitySource?.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.focusSource?.removeEventListener("blur", this.handlePageBlur);
    this.focusSource?.removeEventListener("focus", this.handlePageFocus);
    for (const detach of [...this.gestureBindings]) detach();
    this.desiredLoops.clear();
    this.stopActiveLoops(0);
    try {
      const result = this.backend.destroy();
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // 音频是尽力而为的，并且不得干扰应用程序的拆卸。 / English: Audio is best effort and must not interfere with app teardown.
    }
  }

  private canAttemptUnlock(): boolean {
    return !this.destroyed && this.pageActive && this.backend.available;
  }

  private canAcceptAudio(): boolean {
    return !this.destroyed && this.backend.available;
  }

  private scheduleBigWinSweetener(options: AudioCueOptions): void {
    if (!this.bigWinCounterActive || this.destroyed) return;
    const delayMs = 300 + Math.floor(Math.random() * 400);
    this.bigWinSweetenerTimer = setTimeout(() => {
      this.bigWinSweetenerTimer = null;
      if (!this.bigWinCounterActive || this.destroyed) return;
      this.playCue("big-win.counter-sweetener", options);
      this.scheduleBigWinSweetener(options);
    }, delayMs);
  }

  private stopBigWinCounterTimer(): void {
    if (this.bigWinSweetenerTimer === null) return;
    clearTimeout(this.bigWinSweetenerTimer);
    this.bigWinSweetenerTimer = null;
  }

  private scheduleNormalWinSweetener(options: AudioCueOptions): void {
    if (!this.normalWinCounterActive || this.destroyed) return;
    const delayMs = 300 + Math.floor(Math.random() * 400);
    this.normalWinSweetenerTimer = setTimeout(() => {
      this.normalWinSweetenerTimer = null;
      if (!this.normalWinCounterActive || this.destroyed) return;
      this.playCue("normal-win.counter-sweetener", options);
      this.scheduleNormalWinSweetener(options);
    }, delayMs);
  }

  private stopNormalWinCounterTimer(): void {
    if (this.normalWinSweetenerTimer === null) return;
    clearTimeout(this.normalWinSweetenerTimer);
    this.normalWinSweetenerTimer = null;
  }

  private startBaseMusicTicker(): void {
    if (this.destroyed || this.baseMusicTicker !== null) return;
    this.baseMusicTicker = setInterval(() => {
      try {
        this.baseMusicPot.tick(1_000);
      } catch {
        // 自适应层是装饰性的，并且必须保持独立。 / English: Adaptive layers are decorative and must remain independent.
      }
    }, 1_000);
  }

  private stopBaseMusicTicker(): void {
    if (this.baseMusicTicker === null) return;
    clearInterval(this.baseMusicTicker);
    this.baseMusicTicker = null;
  }

  private async performUnlock(): Promise<boolean> {
    try {
      const unlocked = await this.backend.unlock();
      if (!unlocked || this.destroyed || !this.pageActive) return false;
      this.everUnlocked = true;
      this.syncDesiredLoops();
      return this.backend.state === "running";
    } catch {
      return false;
    }
  }

  private syncDesiredLoops(): void {
    if (!this.canAcceptAudio()) return;
    for (const cue of this.desiredLoops) this.startLoopNow(cue);
  }

  private startLoopNow(cue: LoopAudioCue, options: AudioCueOptions = {}): void {
    if (!this.canAcceptAudio() || this.activeLoops.has(cue)) return;
    const normalized = normalizeAudioCueOptions(options);
    const atomicBaseStart = cue === "ambient.city" && this.backend.startBaseMusicProgram;
    const started = atomicBaseStart
      ? this.tryBackend(() => this.backend.startBaseMusicProgram?.(
        this.baseMusicDocked ? null : this.baseMusicStemLevel,
        2_000,
        normalized,
      ))
      : this.tryBackend(() => this.backend.startLoop(cue, normalized));
    if (started) {
      this.activeLoops.add(cue);
      if (cue === "ambient.city" && !atomicBaseStart) {
        this.applyBaseMusicStem(2_000);
      }
    }
  }

  private applyBaseMusicStem(fadeMs: number): void {
    if (!this.canAcceptAudio() || !this.activeLoops.has("ambient.city")) return;
    this.tryBackend(() => this.backend.setBaseMusicStemLevel?.(
      this.baseMusicDocked ? null : this.baseMusicStemLevel,
      Math.max(0, fadeMs),
    ));
  }

  private stopLoopNow(cue: LoopAudioCue, fadeMs: number): void {
    if (!this.activeLoops.delete(cue)) return;
    this.tryBackend(() => this.backend.stopLoop(cue, Math.max(0, fadeMs)));
  }

  private stopActiveLoops(fadeMs: number): void {
    for (const cue of [...this.activeLoops]) this.stopLoopNow(cue, fadeMs);
  }

  private endFreeSpinsLoop(
    options: AudioCueOptions,
    summary: "visible" | "skip" | "none",
  ): void {
    const wasOwned = this.desiredLoops.delete("music.free-spins")
      || this.activeLoops.has("music.free-spins");
    this.stopLoopNow("music.free-spins", 1_500);
    // 清理可能会要求两次相同的无摘要转换。所有权是事件本地的，因此稍后的 Big Win STOPPED 重新启动仍然可以正常结束。 / English: Cleaning may require the same digestless conversion twice. Ownership is event local, so a later Big Win STOPPED restart can still end gracefully.
    if (!wasOwned) return;
    this.playCue("free-spins.loop-end", options);
    if (summary === "visible") this.playCue("free-spins.outro", options);
    else if (summary === "skip") this.playCue("free-spins.music-end", options);
  }

  private readonly handleVisibilityChange: EventListener = () => {
    this.setPageActive(!(this.visibilitySource?.hidden ?? false));
  };

  private readonly handlePageBlur: EventListener = () => {
    this.setPageActive(false);
  };

  private readonly handlePageFocus: EventListener = () => {
    // 焦点事件可能会与隐藏的选项卡竞争；在这种情况下，文档可见性仍然具有权威性。 / English: Focus events may compete with hidden tabs; in this case, document visibility is still authoritative.
    this.setPageActive(!(this.visibilitySource?.hidden ?? false));
  };

  private restoreVisibleGesturePageActivity(): void {
    if (this.destroyed || this.pageActive || (this.visibilitySource?.hidden ?? false)) return;
    this.setPageActive(true);
  }

  private setPageActive(pageActive: boolean): void {
    if (this.destroyed || this.pageActive === pageActive) return;
    this.pageActive = pageActive;
    const revision = ++this.pageLifecycleRevision;
    if (!pageActive) {
      this.enqueueLifecycle(async () => {
        if (this.destroyed || this.pageActive || revision !== this.pageLifecycleRevision) return;
        try {
          await this.backend.suspend();
        } catch {
          // 页面生命周期必须保持尽力而为。 / English: Page lifecycle must remain best effort.
        }
      });
      return;
    }
    if (!this.everUnlocked) return;
    this.enqueueLifecycle(async () => {
      if (this.destroyed || !this.pageActive || revision !== this.pageLifecycleRevision) return;
      // `unlock()` 恢复现有上下文。 `activeLoops` 在整个暂停过程中有意保留所有权，因此不会重新创建循环/源。 / English: `unlock()` restores the existing context. `activeLoops` intentionally retains ownership throughout the pause, so loops/sources are not recreated.
      await this.unlock();
    });
  }

  private enqueueLifecycle(task: () => Promise<void>): void {
    this.lifecycle = this.lifecycle.then(task, task).catch(() => undefined);
  }

  private tryBackend(action: () => void): boolean {
    try {
      action();
      return true;
    } catch {
      return false;
    }
  }

  private readPreferences(fallbackMuted: boolean): AudioPreferences {
    if (!this.storage) return { version: 1, muted: fallbackMuted };
    try {
      return parseAudioPreferences(this.storage.getItem(this.preferenceKey), fallbackMuted);
    } catch {
      return { version: 1, muted: fallbackMuted };
    }
  }

  private writePreferences(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.preferenceKey, JSON.stringify({ version: 1, muted: this.mutedValue }));
    } catch {
      // 隐私模式下存储可能不可用；保留记忆中的偏好。 / English: Storage may not be available in Private Mode; retained preferences in memory.
    }
  }
}
