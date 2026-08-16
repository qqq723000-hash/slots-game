import { describe, expect, it, vi } from "vitest";
import { WebAudioSynth } from "../src/audio/WebAudioSynth";

interface RecordedSource {
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
}

interface RecordedGain {
  readonly gain: {
    value: number;
    readonly cancelScheduledValues: ReturnType<typeof vi.fn>;
    readonly setValueAtTime: ReturnType<typeof vi.fn>;
    readonly linearRampToValueAtTime: ReturnType<typeof vi.fn>;
    readonly exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
}

function recordingAudioContext(): {
  context: AudioContext;
  sources: RecordedSource[];
  gains: RecordedGain[];
  close: ReturnType<typeof vi.fn>;
} {
  const sources: RecordedSource[] = [];
  const gains: RecordedGain[] = [];
  const parameter = () => ({
    value: 0,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  });
  const node = () => ({
    connect(destination: unknown) { return destination; },
    disconnect: vi.fn(),
  });
  const sourceNode = () => {
    const source = {
      ...node(),
      start: vi.fn(),
      stop: vi.fn(),
      addEventListener: vi.fn(),
    };
    sources.push(source);
    return source;
  };
  const close = vi.fn(async () => undefined);
  const context = {
    state: "running",
    currentTime: 1,
    sampleRate: 1_000,
    destination: node(),
    resume: vi.fn(async () => undefined),
    suspend: vi.fn(async () => undefined),
    close,
    createDynamicsCompressor: () => ({
      ...node(),
      threshold: parameter(),
      knee: parameter(),
      ratio: parameter(),
      attack: parameter(),
      release: parameter(),
    }),
    createGain: () => {
      const gain = { ...node(), gain: parameter() };
      gains.push(gain);
      return gain;
    },
    createOscillator: () => ({
      ...sourceNode(),
      type: "sine",
      frequency: parameter(),
    }),
    createBufferSource: () => ({
      ...sourceNode(),
      buffer: null,
      loop: false,
    }),
    createBiquadFilter: () => ({
      ...node(),
      type: "lowpass",
      frequency: parameter(),
      Q: parameter(),
    }),
    createStereoPanner: () => ({ ...node(), pan: parameter() }),
    createBuffer: (_channels: number, length: number, sampleRate: number) => ({
      sampleRate,
      getChannelData: () => new Float32Array(length),
    }),
  } as unknown as AudioContext;
  return { context, sources, gains, close };
}

describe("WebAudioSynth lazy bootstrap", () => {
  it("does not ask for an AudioContext until an explicit unlock", async () => {
    const contextFactory = vi.fn(() => null);
    const synth = new WebAudioSynth({ contextFactory });

    synth.setMuted(false);
    synth.playOneShot("ui.click");
    synth.startLoop("reel.motor");
    expect(contextFactory).not.toHaveBeenCalled();
    expect(synth.state).toBe("locked");

    await expect(synth.unlock()).resolves.toBe(false);
    expect(contextFactory).toHaveBeenCalledTimes(1);
    expect(synth.state).toBe("locked");
  });

  it("synthesizes every semantic feature cue as bounded scheduled voices", async () => {
    const recording = recordingAudioContext();
    const synth = new WebAudioSynth({ contextFactory: () => recording.context });
    await expect(synth.unlock()).resolves.toBe(true);

    const beforeEnergy = recording.sources.length;
    synth.playOneShot("energy.collect", { intensity: 0.8, pan: -0.2 });
    const energyVoices = recording.sources.length - beforeEnergy;

    const beforeWheel = recording.sources.length;
    synth.playOneShot("wheel.spin", { intensity: 0.7, reducedMotion: true });
    const wheelVoices = recording.sources.length - beforeWheel;

    const beforeFeature = recording.sources.length;
    synth.playOneShot("feature.start", { intensity: 0.9, pan: 0.2 });
    const featureVoices = recording.sources.length - beforeFeature;

    expect(energyVoices).toBe(4);
    expect(wheelVoices).toBe(6);
    expect(featureVoices).toBe(5);
    expect(recording.sources).toHaveLength(15);
    expect(recording.sources.every((source) => (
      source.start.mock.calls.length === 1 && source.stop.mock.calls.length === 1
    ))).toBe(true);

    await synth.destroy();
    expect(recording.close).toHaveBeenCalledTimes(1);
  });

  it("falls back by safe presentation category for captured P0 cues", async () => {
    const recording = recordingAudioContext();
    const synth = new WebAudioSynth({ contextFactory: () => recording.context });
    await synth.unlock();

    const counts: number[] = [];
    for (const cue of [
      "symbol.scatter-land-1",
      "symbol.wild-land",
      "symbol.scatter-win",
      "win.loss-or-equal",
      "pps.level-3",
      "vault.unlock-3-plus",
      "jackpot.grand",
      "payout.win-8",
    ] as const) {
      const before = recording.sources.length;
      synth.playOneShot(cue);
      counts.push(recording.sources.length - before);
    }

    // 落定音保持转轴风格，PPS/Vault 保持冲击风格，奖励音保持赢分风格。
    expect(counts).toEqual([3, 3, 4, 4, 3, 3, 4, 4]);
    expect(recording.sources.every((source) => (
      source.start.mock.calls.length === 1 && source.stop.mock.calls.length === 1
    ))).toBe(true);
  });

  it("keeps King Spin and Kong Quest landing semantics procedurally silent", async () => {
    const recording = recordingAudioContext();
    const synth = new WebAudioSynth({ contextFactory: () => recording.context });
    await synth.unlock();

    synth.playOneShot("wheel.king-spin-won");
    synth.playOneShot("wheel.kong-quest-won");

    expect(recording.sources).toEqual([]);
  });

  it("mutes through the master gain without restarting loops or truncating one-shots", async () => {
    const recording = recordingAudioContext();
    const synth = new WebAudioSynth({ contextFactory: () => recording.context });
    await synth.unlock();
    synth.startLoop("ambient.city");
    synth.playOneShot("ui.click");

    const activeSources = [...recording.sources];
    const startCounts = activeSources.map((source) => source.start.mock.calls.length);
    const stopCounts = activeSources.map((source) => source.stop.mock.calls.length);
    synth.setMuted(true);
    synth.setMuted(false);

    expect(recording.sources).toEqual(activeSources);
    expect(activeSources.map((source) => source.start.mock.calls.length)).toEqual(startCounts);
    expect(activeSources.map((source) => source.stop.mock.calls.length)).toEqual(stopCounts);
    expect(recording.gains[0]?.gain.linearRampToValueAtTime.mock.calls.slice(-2)).toEqual([
      [0, 1.025],
      [0.7, 1.025],
    ]);
  });
});
