import type { AudioBackend, AudioBackendState } from "./AudioManager";
import {
  normalizeAudioCueOptions,
  type AudioBus,
  type AudioCueOptions,
  type LoopAudioCue,
  type NormalizedAudioCueOptions,
  type OneShotAudioCue,
} from "./cues";

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;
export type AudioContextFactory = () => AudioContext | null;

export interface WebAudioSynthOptions {
  contextFactory?: AudioContextFactory;
  maxVoices?: number;
}

interface ActiveLoop {
  readonly sources: AudioScheduledSourceNode[];
  readonly nodes: AudioNode[];
  readonly gain: GainNode;
}

const MIN_GAIN = 0.0001;
const MASTER_GAIN = 0.7;
const BUS_GAIN: Readonly<Record<AudioBus, number>> = Object.freeze({
  ui: 0.7,
  reels: 0.72,
  win: 0.62,
  impact: 0.7,
  ambient: 0.28,
});

function resolveAudioContextConstructor(): AudioContextConstructor | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function disconnect(nodes: readonly AudioNode[]): void {
  for (const node of nodes) {
    try {
      node.disconnect();
    } catch {
      // 节点可能已因浏览器拆卸而断开连接。
    }
  }
}

/**
 * 原始程序网络音频实现。它不执行任何提取操作，也不拥有任何许可/第三方样本；每个声音都是在运行时合成的。
 */
export class WebAudioSynth implements AudioBackend {
  private readonly contextFactory: AudioContextFactory;
  private readonly supported: boolean;
  private readonly maxVoices: number;
  private readonly activeVoices = new Set<AudioScheduledSourceNode>();
  private readonly loops = new Map<LoopAudioCue, ActiveLoop>();
  private readonly retiringLoops = new Set<ActiveLoop>();
  private context: AudioContext | null = null;
  private buses: Record<AudioBus, GainNode> | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;
  private destroyed = false;

  constructor(options: WebAudioSynthOptions = {}) {
    const Context = options.contextFactory ? null : resolveAudioContextConstructor();
    this.supported = options.contextFactory !== undefined || Context !== null;
    this.contextFactory = options.contextFactory ?? (() => (
      Context ? new Context({ latencyHint: "interactive" }) : null
    ));
    const requestedVoices = options.maxVoices ?? 48;
    this.maxVoices = Number.isFinite(requestedVoices)
      ? Math.max(4, Math.trunc(requestedVoices))
      : 48;
  }

  get available(): boolean {
    return this.supported && !this.destroyed;
  }

  get state(): AudioBackendState {
    if (this.destroyed) return "closed";
    if (!this.supported) return "unavailable";
    if (!this.context) return "locked";
    const state = this.context.state as string;
    if (state === "running" || state === "suspended" || state === "closed" || state === "interrupted") {
      return state;
    }
    return "suspended";
  }

  async unlock(): Promise<boolean> {
    if (!this.available) return false;
    try {
      if (!this.context) {
        this.context = this.contextFactory();
        if (!this.context) return false;
        this.buildGraph(this.context);
      }
      if (this.context.state !== "running") await this.context.resume();
      return this.context.state === "running";
    } catch {
      return false;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    const context = this.context;
    const master = this.master;
    if (!context || !master || context.state === "closed") return;
    const now = context.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(Math.max(0, master.gain.value), now);
    master.gain.linearRampToValueAtTime(muted ? 0 : MASTER_GAIN, now + 0.025);
  }

  playOneShot(cue: OneShotAudioCue, rawOptions: AudioCueOptions = {}): void {
    const context = this.runningContext();
    if (!context) return;
    const options = normalizeAudioCueOptions(rawOptions);
    try {
      switch (cue) {
        case "intro.game":
          // 启动序列是预混合捕获的提示；合成替代品将创建 false 咆哮/冲击同步点。
          return;
        case "ui.click":
        case "ui.open":
        case "ui.close":
          this.playUiClick(context, options);
          return;
        case "reel.stop":
        case "reel.anticipation":
        case "symbol.scatter-land-1":
        case "symbol.scatter-land-2":
        case "symbol.scatter-land-3":
        case "symbol.scatter-land-4":
        case "symbol.scatter-land-5":
        case "symbol.wild-land":
          this.playReelStop(context, options);
          return;
        case "energy.collect":
          this.playEnergyCollect(context, options);
          return;
        case "pps.level-1":
        case "pps.level-2":
        case "pps.level-3":
        case "pps.level-4":
        case "pps.level-5":
        case "vault.unlock-1":
        case "vault.unlock-2":
        case "vault.unlock-3-plus":
        case "vault.anticipation":
        case "vault.fly":
          this.playMonsterImpact(context, options);
          return;
        case "symbol.lp1":
        case "symbol.lp2":
        case "symbol.mp1":
        case "symbol.mp2":
        case "symbol.hp1":
        case "symbol.hp2":
        case "symbol.wild":
        case "symbol.scatter-win":
          this.playWinSting(context, options);
          return;
        case "wheel.spin":
          this.playWheelSpin(context, options);
          return;
        case "wheel.appear":
        case "wheel.award":
          this.playFeatureStart(context, options);
          return;
        case "wheel.king-spin-won":
        case "wheel.kong-quest-won":
          // IDs 50/51 是可观察的调度程序语义，没有捕获播放操作。程序替代品是 false 音频。
          return;
        case "feature.start":
        case "free-spins.outro":
        case "free-spins.music-end":
          this.playFeatureStart(context, options);
          return;
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
          this.playWinSting(context, options);
          return;
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
          this.playWinSting(context, options);
          return;
        case "monster.impact":
        case "monster.roar":
        case "monster.roar-hit":
        case "monster.sniff":
        case "monster.thump-expand":
        case "monster.reel-stretch":
        case "monster.feature-activate":
          this.playMonsterImpact(context, options);
          return;
      }
    } catch {
      // 失败的装饰性声音被故意从游戏流程中隔离出来。
    }
  }

  startLoop(cue: LoopAudioCue, rawOptions: AudioCueOptions = {}): void {
    const context = this.runningContext();
    if (!context || this.loops.has(cue)) return;
    const options = normalizeAudioCueOptions(rawOptions);
    try {
      const loop = cue === "reel.motor"
        ? this.createReelMotor(context, options)
        : this.createCityAmbient(context, options);
      this.loops.set(cue, loop);
    } catch {
      // 循环创建是尽力而为的；稍后的请求可能会重试。
    }
  }

  stopLoop(cue: LoopAudioCue, fadeMs = 90): void {
    const loop = this.loops.get(cue);
    const context = this.context;
    if (!loop || !context) return;
    this.loops.delete(cue);
    this.retiringLoops.add(loop);
    const now = context.currentTime;
    const fadeSeconds = clamp(fadeMs, 0, 2_000) / 1_000;
    const stopAt = now + Math.max(0.008, fadeSeconds);
    try {
      loop.gain.gain.cancelScheduledValues(now);
      loop.gain.gain.setValueAtTime(Math.max(MIN_GAIN, loop.gain.gain.value), now);
      loop.gain.gain.exponentialRampToValueAtTime(MIN_GAIN, stopAt);
    } catch {
      // 停止下面的源仍然会释放循环。
    }
    let remaining = loop.sources.length;
    const release = (): void => {
      remaining -= 1;
      if (remaining <= 0) {
        this.retiringLoops.delete(loop);
        disconnect(loop.nodes);
      }
    };
    for (const source of loop.sources) {
      source.addEventListener("ended", release, { once: true });
      try {
        source.stop(stopAt + 0.012);
      } catch {
        release();
      }
    }
  }

  quickStopReelMotor(): void {
    this.stopLoop("reel.motor", 500);
  }

  finishReelMotorNaturally(): void {
    this.stopLoop("reel.motor", 110);
  }

  async suspend(): Promise<void> {
    const context = this.context;
    if (!context || context.state === "closed") return;
    this.cancelActiveVoices();
    for (const cue of [...this.loops.keys()]) this.stopLoop(cue, 25);
    this.releaseRetiringLoopsImmediately();
    try {
      if (context.state === "running") await context.suspend();
    } catch {
      // 浏览器可能会导致页面暂停或 OS 音频中断。
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelActiveVoices();
    for (const cue of [...this.loops.keys()]) this.stopLoop(cue, 0);
    this.releaseRetiringLoopsImmediately();
    const context = this.context;
    this.context = null;
    this.buses = null;
    this.master = null;
    this.noiseBuffer = null;
    if (!context || context.state === "closed") return;
    try {
      await context.close();
    } catch {
      // 在 HMR、导航和 OS 中断期间，拆卸仍然安全。
    }
  }

  private buildGraph(context: AudioContext): void {
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 12;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.2;

    const master = context.createGain();
    master.gain.value = this.muted ? 0 : MASTER_GAIN;
    compressor.connect(master).connect(context.destination);

    const makeBus = (bus: AudioBus): GainNode => {
      const gain = context.createGain();
      gain.gain.value = BUS_GAIN[bus];
      gain.connect(compressor);
      return gain;
    };
    this.buses = {
      ui: makeBus("ui"),
      reels: makeBus("reels"),
      win: makeBus("win"),
      impact: makeBus("impact"),
      ambient: makeBus("ambient"),
    };
    this.master = master;
  }

  private runningContext(): AudioContext | null {
    if (this.destroyed || this.muted || this.context?.state !== "running" || !this.buses) return null;
    return this.context;
  }

  private playUiClick(context: AudioContext, options: NormalizedAudioCueOptions): void {
    const start = context.currentTime + options.delayMs / 1_000;
    const weight = options.intensity;
    this.tone(context, {
      bus: "ui", start, duration: 0.038, frequency: 960, endFrequency: 540,
      gain: 0.055 * weight, type: "triangle", pan: options.pan,
    });
    this.noise(context, {
      bus: "ui", start, duration: 0.024, filter: "highpass", frequency: 2_800,
      gain: 0.026 * weight, pan: options.pan,
    });
  }

  private playReelStop(context: AudioContext, options: NormalizedAudioCueOptions): void {
    const start = context.currentTime + options.delayMs / 1_000;
    const durationScale = options.reducedMotion ? 0.62 : 1;
    this.tone(context, {
      bus: "reels", start, duration: 0.14 * durationScale, frequency: 82, endFrequency: 42,
      gain: 0.19 * options.intensity, type: "sine", pan: options.pan,
    });
    this.tone(context, {
      bus: "reels", start: start + 0.006, duration: 0.095 * durationScale,
      frequency: 740, endFrequency: 360, gain: 0.052 * options.intensity,
      type: "triangle", pan: options.pan,
    });
    this.noise(context, {
      bus: "reels", start, duration: 0.085 * durationScale, filter: "bandpass", frequency: 1_450,
      quality: 1.25, gain: 0.072 * options.intensity, pan: options.pan,
    });
  }

  /** 由沥青金属和过滤火花制成的短时上升装药。 */
  private playEnergyCollect(context: AudioContext, options: NormalizedAudioCueOptions): void {
    const start = context.currentTime + options.delayMs / 1_000;
    const durationScale = options.reducedMotion ? 0.62 : 1;
    const notes = [196, 293.66, 440];
    notes.forEach((frequency, index) => {
      this.tone(context, {
        bus: "win",
        start: start + index * 0.043 * durationScale,
        duration: 0.2 * durationScale,
        frequency,
        endFrequency: frequency * 1.16,
        gain: (0.038 + index * 0.007) * options.intensity,
        type: index === notes.length - 1 ? "sine" : "triangle",
        pan: clamp(options.pan + (index - 1) * 0.045, -1, 1),
      });
    });
    this.noise(context, {
      bus: "win",
      start: start + 0.025 * durationScale,
      duration: 0.12 * durationScale,
      filter: "highpass",
      frequency: 2_650,
      quality: 0.82,
      gain: 0.035 * options.intensity,
      pan: options.pan,
    });
  }

  /** 紧凑的加速轮/棘轮手势而不是采样循环。 */
  private playWheelSpin(context: AudioContext, options: NormalizedAudioCueOptions): void {
    const start = context.currentTime + options.delayMs / 1_000;
    const durationScale = options.reducedMotion ? 0.46 : 1;
    const duration = 1.08 * durationScale;
    this.tone(context, {
      bus: "reels", start, duration, frequency: 72, endFrequency: 156,
      gain: 0.052 * options.intensity, type: "sawtooth", pan: options.pan,
    });
    this.noise(context, {
      bus: "reels", start, duration: duration * 0.94,
      filter: "bandpass", frequency: 1_180, quality: 1.35,
      gain: 0.052 * options.intensity, pan: options.pan,
    });

    const tickCount = options.reducedMotion ? 4 : 9;
    for (let index = 0; index < tickCount; index += 1) {
      const ratio = index / (tickCount - 1);
      const offset = duration * 0.82 * (1 - (1 - ratio) ** 1.8);
      this.tone(context, {
        bus: "reels",
        start: start + offset,
        duration: 0.038 * durationScale,
        frequency: 430 + ratio * 920,
        endFrequency: 260 + ratio * 510,
        gain: 0.027 * options.intensity,
        type: "triangle",
        pan: clamp(options.pan + Math.sin(index * 1.7) * 0.08, -1, 1),
      });
    }
  }

  /** 仅当权威特征开始时才使用大调模式过渡和弦。 */
  private playFeatureStart(context: AudioContext, options: NormalizedAudioCueOptions): void {
    const start = context.currentTime + options.delayMs / 1_000;
    const durationScale = options.reducedMotion ? 0.58 : 1;
    const notes = [110, 164.81, 246.94, 493.88];
    notes.forEach((frequency, index) => {
      this.tone(context, {
        bus: "win",
        start: start + index * 0.036 * durationScale,
        duration: (0.5 - index * 0.035) * durationScale,
        frequency,
        endFrequency: frequency * (index === notes.length - 1 ? 1.03 : 0.995),
        gain: (index === 0 ? 0.07 : 0.048) * options.intensity,
        type: index < 2 ? "triangle" : "sine",
        pan: clamp(options.pan + (index - 1.5) * 0.05, -1, 1),
      });
    });
    this.noise(context, {
      bus: "win", start, duration: 0.24 * durationScale,
      filter: "bandpass", frequency: 760, quality: 0.72,
      gain: 0.055 * options.intensity, pan: options.pan,
    });
    this.duck(start, 0.56 * durationScale, 0.5);
  }

  private playWinSting(context: AudioContext, options: NormalizedAudioCueOptions): void {
    const start = context.currentTime + options.delayMs / 1_000;
    const durationScale = options.reducedMotion ? 0.66 : 1;
    const notes = [293.66, 440, 587.33, 880];
    notes.forEach((frequency, index) => {
      const noteStart = start + index * 0.052 * durationScale;
      this.tone(context, {
        bus: "win", start: noteStart, duration: 0.32 * durationScale,
        frequency, endFrequency: frequency * 0.995, gain: 0.052 * options.intensity,
        type: index === 3 ? "sine" : "triangle", pan: (index - 1.5) * 0.07,
      });
    });
    this.duck(start, 0.48 * durationScale, 0.58);
  }

  private playMonsterImpact(context: AudioContext, options: NormalizedAudioCueOptions): void {
    const start = context.currentTime + options.delayMs / 1_000;
    const durationScale = options.reducedMotion ? 0.56 : 1;
    this.tone(context, {
      bus: "impact", start, duration: 0.46 * durationScale, frequency: 64, endFrequency: 34,
      gain: 0.27 * options.intensity, type: "sine", pan: options.pan,
    });
    this.tone(context, {
      bus: "impact", start: start + 0.008, duration: 0.29 * durationScale,
      frequency: 122, endFrequency: 77, gain: 0.046 * options.intensity,
      type: "sawtooth", pan: options.pan,
    });
    this.noise(context, {
      bus: "impact", start, duration: 0.34 * durationScale, filter: "lowpass", frequency: 430,
      quality: 0.7, gain: 0.18 * options.intensity, pan: options.pan,
    });
    this.duck(start, 0.52 * durationScale, 0.42);
  }

  private createReelMotor(
    context: AudioContext,
    options: NormalizedAudioCueOptions,
  ): ActiveLoop {
    const start = context.currentTime + options.delayMs / 1_000;
    const group = context.createGain();
    group.gain.setValueAtTime(MIN_GAIN, start);
    group.gain.exponentialRampToValueAtTime(0.2 * options.intensity, start + 0.085);
    const nodes: AudioNode[] = [group, ...this.route(group, "reels", options.pan)];
    const sources: AudioScheduledSourceNode[] = [];

    const noise = context.createBufferSource();
    noise.buffer = this.getNoiseBuffer(context);
    noise.loop = true;
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 440;
    band.Q.value = 0.72;
    const noiseGain = context.createGain();
    noiseGain.gain.value = 0.2;
    noise.connect(band).connect(noiseGain).connect(group);
    nodes.push(noise, band, noiseGain);
    sources.push(noise);

    const fundamental = context.createOscillator();
    fundamental.type = "sawtooth";
    fundamental.frequency.value = 56;
    const fundamentalGain = context.createGain();
    fundamentalGain.gain.value = 0.075;
    fundamental.connect(fundamentalGain).connect(group);
    nodes.push(fundamental, fundamentalGain);
    sources.push(fundamental);

    const harmonic = context.createOscillator();
    harmonic.type = "triangle";
    harmonic.frequency.value = 112;
    const harmonicGain = context.createGain();
    harmonicGain.gain.value = 0.035;
    harmonic.connect(harmonicGain).connect(group);
    nodes.push(harmonic, harmonicGain);
    sources.push(harmonic);

    const lfo = context.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 7.4;
    const lfoDepth = context.createGain();
    lfoDepth.gain.value = 0.026;
    lfo.connect(lfoDepth).connect(group.gain);
    nodes.push(lfo, lfoDepth);
    sources.push(lfo);

    sources.forEach((source) => source.start(start));
    return { sources, nodes, gain: group };
  }

  private createCityAmbient(
    context: AudioContext,
    options: NormalizedAudioCueOptions,
  ): ActiveLoop {
    const start = context.currentTime + options.delayMs / 1_000;
    const group = context.createGain();
    group.gain.setValueAtTime(MIN_GAIN, start);
    group.gain.exponentialRampToValueAtTime(0.115 * options.intensity, start + 0.42);
    const nodes: AudioNode[] = [group, ...this.route(group, "ambient", options.pan)];
    const sources: AudioScheduledSourceNode[] = [];

    const wind = context.createBufferSource();
    wind.buffer = this.getNoiseBuffer(context);
    wind.loop = true;
    const high = context.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 58;
    const low = context.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 820;
    low.Q.value = 0.44;
    const windGain = context.createGain();
    windGain.gain.value = 0.34;
    wind.connect(high).connect(low).connect(windGain).connect(group);
    nodes.push(wind, high, low, windGain);
    sources.push(wind);

    const crackle = context.createBufferSource();
    crackle.buffer = this.getNoiseBuffer(context);
    crackle.loop = true;
    const crackleBand = context.createBiquadFilter();
    crackleBand.type = "bandpass";
    crackleBand.frequency.value = 2_350;
    crackleBand.Q.value = 1.8;
    const crackleGain = context.createGain();
    crackleGain.gain.value = 0.028;
    crackle.connect(crackleBand).connect(crackleGain).connect(group);
    nodes.push(crackle, crackleBand, crackleGain);
    sources.push(crackle);

    const airPulse = context.createOscillator();
    airPulse.type = "sine";
    airPulse.frequency.value = 0.075;
    const airDepth = context.createGain();
    airDepth.gain.value = 0.018;
    airPulse.connect(airDepth).connect(group.gain);
    nodes.push(airPulse, airDepth);
    sources.push(airPulse);

    sources.forEach((source) => source.start(start));
    return { sources, nodes, gain: group };
  }

  private tone(context: AudioContext, options: {
    bus: AudioBus;
    start: number;
    duration: number;
    frequency: number;
    endFrequency: number;
    gain: number;
    type: OscillatorType;
    pan: number;
  }): void {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const end = options.start + Math.max(0.012, options.duration);
    oscillator.type = options.type;
    oscillator.frequency.setValueAtTime(Math.max(1, options.frequency), options.start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, options.endFrequency), end);
    envelope.gain.setValueAtTime(MIN_GAIN, options.start);
    envelope.gain.linearRampToValueAtTime(Math.max(MIN_GAIN, options.gain), options.start + 0.006);
    envelope.gain.exponentialRampToValueAtTime(MIN_GAIN, end);
    oscillator.connect(envelope);
    const routed = this.route(envelope, options.bus, options.pan);
    this.scheduleVoice(oscillator, options.start, end + 0.012, [oscillator, envelope, ...routed]);
  }

  private noise(context: AudioContext, options: {
    bus: AudioBus;
    start: number;
    duration: number;
    filter: BiquadFilterType;
    frequency: number;
    quality?: number;
    gain: number;
    pan: number;
  }): void {
    const source = context.createBufferSource();
    source.buffer = this.getNoiseBuffer(context);
    const filter = context.createBiquadFilter();
    filter.type = options.filter;
    filter.frequency.value = options.frequency;
    filter.Q.value = options.quality ?? 0.8;
    const envelope = context.createGain();
    const end = options.start + Math.max(0.012, options.duration);
    envelope.gain.setValueAtTime(MIN_GAIN, options.start);
    envelope.gain.linearRampToValueAtTime(Math.max(MIN_GAIN, options.gain), options.start + 0.005);
    envelope.gain.exponentialRampToValueAtTime(MIN_GAIN, end);
    source.connect(filter).connect(envelope);
    const routed = this.route(envelope, options.bus, options.pan);
    this.scheduleVoice(source, options.start, end + 0.01, [source, filter, envelope, ...routed]);
  }

  private route(node: AudioNode, bus: AudioBus, pan: number): AudioNode[] {
    const target = this.buses?.[bus];
    if (!target) throw new Error(`Audio bus ${bus} is unavailable`);
    const context = this.context;
    if (context && typeof context.createStereoPanner === "function" && Math.abs(pan) > 0.001) {
      const panner = context.createStereoPanner();
      panner.pan.value = clamp(pan, -1, 1);
      node.connect(panner).connect(target);
      return [panner];
    }
    node.connect(target);
    return [];
  }

  private scheduleVoice(
    source: AudioScheduledSourceNode,
    start: number,
    stop: number,
    nodes: readonly AudioNode[],
  ): void {
    if (this.activeVoices.size >= this.maxVoices) {
      disconnect(nodes);
      return;
    }
    this.activeVoices.add(source);
    source.addEventListener("ended", () => {
      this.activeVoices.delete(source);
      disconnect(nodes);
    }, { once: true });
    try {
      source.start(start);
      source.stop(stop);
    } catch (error) {
      this.activeVoices.delete(source);
      disconnect(nodes);
      throw error;
    }
  }

  private duck(start: number, duration: number, depth: number): void {
    if (!this.buses) return;
    for (const bus of ["reels", "ambient"] as const) {
      const parameter = this.buses[bus].gain;
      const base = BUS_GAIN[bus];
      parameter.cancelScheduledValues(start);
      parameter.setValueAtTime(Math.max(MIN_GAIN, parameter.value), start);
      parameter.linearRampToValueAtTime(base * depth, start + 0.018);
      parameter.exponentialRampToValueAtTime(base, start + Math.max(0.04, duration));
    }
  }

  private getNoiseBuffer(context: AudioContext): AudioBuffer {
    if (this.noiseBuffer && this.noiseBuffer.sampleRate === context.sampleRate) return this.noiseBuffer;
    const length = Math.max(1, Math.floor(context.sampleRate * 2));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const channel = buffer.getChannelData(0);
    let seed = 0x5f3759df;
    let brown = 0;
    for (let index = 0; index < channel.length; index += 1) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const white = ((seed >>> 0) / 0xffffffff) * 2 - 1;
      brown = brown * 0.965 + white * 0.035;
      channel[index] = clamp(white * 0.58 + brown * 1.6, -1, 1);
    }
    this.noiseBuffer = buffer;
    return buffer;
  }

  private cancelActiveVoices(): void {
    const now = this.context?.currentTime ?? 0;
    for (const source of [...this.activeVoices]) {
      try {
        source.stop(now);
      } catch {
        this.activeVoices.delete(source);
        try {
          source.disconnect();
        } catch {
          // 已经释放了。
        }
      }
    }
  }

  private releaseRetiringLoopsImmediately(): void {
    const now = this.context?.currentTime ?? 0;
    for (const loop of [...this.retiringLoops]) {
      this.retiringLoops.delete(loop);
      try {
        loop.gain.gain.cancelScheduledValues(now);
        loop.gain.gain.setValueAtTime(MIN_GAIN, now);
      } catch {
        // 上下文可能已经被中断或关闭。
      }
      for (const source of loop.sources) {
        try {
          source.stop(now);
        } catch {
          // 先前停止的源不需要进一步的工作。
        }
      }
      disconnect(loop.nodes);
    }
  }
}
