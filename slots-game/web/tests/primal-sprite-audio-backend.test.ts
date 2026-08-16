import { describe, expect, it, vi } from "vitest";
import {
  AudioManager,
  type AudioBackend,
  type AudioBackendState,
  type AudioCueOptions,
  type LoopAudioCue,
  type OneShotAudioCue,
} from "../src/audio/AudioManager";
import { PrimalSpriteAudioBackend } from "../src/audio/PrimalSpriteAudioBackend";
import { PRIMAL_CUE_DEFINITIONS } from "../src/audio/primalSoundMap";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((pass) => { resolve = pass; });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

interface RecordedSource {
  buffer: AudioBuffer | null;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
}

interface RecordedGain {
  readonly gain: {
    value: number;
    readonly cancelScheduledValues: ReturnType<typeof vi.fn>;
    readonly setValueAtTime: ReturnType<typeof vi.fn>;
    readonly linearRampToValueAtTime: ReturnType<typeof vi.fn>;
    readonly setTargetAtTime: ReturnType<typeof vi.fn>;
  };
}

class RecordingFallback implements AudioBackend {
  available = true;
  state: AudioBackendState = "locked";
  readonly oneShots: Array<{ cue: OneShotAudioCue; options?: AudioCueOptions }> = [];
  readonly loops: Array<{ cue: LoopAudioCue; options?: AudioCueOptions }> = [];
  readonly stopped: Array<{ cue: LoopAudioCue; fadeMs?: number }> = [];
  readonly muted: boolean[] = [];
  suspendCalls = 0;
  destroyCalls = 0;

  async unlock(): Promise<boolean> {
    this.state = "running";
    return true;
  }

  setMuted(muted: boolean): void {
    this.muted.push(muted);
  }

  playOneShot(cue: OneShotAudioCue, options?: AudioCueOptions): void {
    this.oneShots.push({ cue, options });
  }

  startLoop(cue: LoopAudioCue, options?: AudioCueOptions): void {
    this.loops.push({ cue, options });
  }

  stopLoop(cue: LoopAudioCue, fadeMs?: number): void {
    this.stopped.push({ cue, fadeMs });
  }

  async suspend(): Promise<void> {
    this.suspendCalls += 1;
    this.state = "suspended";
  }

  destroy(): void {
    this.destroyCalls += 1;
    this.state = "closed";
  }
}

function recordingAudioContext(options: { decodeFails?: boolean } = {}): {
  context: AudioContext;
  sources: RecordedSource[];
  gains: RecordedGain[];
  decodeAudioData: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  suspend: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  createStereoPanner: ReturnType<typeof vi.fn>;
  setCurrentTime(value: number): void;
} {
  let state: AudioContextState = "suspended";
  let currentTime = 2;
  const sources: RecordedSource[] = [];
  const gains: RecordedGain[] = [];
  const parameter = () => {
    const audioParam = {
      value: 0,
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn((value: number) => { audioParam.value = value; }),
      linearRampToValueAtTime: vi.fn((value: number) => { audioParam.value = value; }),
      setTargetAtTime: vi.fn((value: number) => { audioParam.value = value; }),
    };
    return audioParam;
  };
  const node = () => ({
    connect(destination: unknown) { return destination; },
    disconnect: vi.fn(),
  });
  const resume = vi.fn(async () => { state = "running"; });
  const suspend = vi.fn(async () => { state = "suspended"; });
  const close = vi.fn(async () => { state = "closed"; });
  const decodeAudioData = vi.fn(async () => {
    if (options.decodeFails) throw new Error("unsupported audio fixture");
    return { duration: 300 } as AudioBuffer;
  });
  const createStereoPanner = vi.fn(() => ({ ...node(), pan: parameter() }));
  const context = {
    get state() { return state; },
    get currentTime() { return currentTime; },
    destination: node(),
    resume,
    suspend,
    close,
    decodeAudioData,
    createGain: () => {
      const gain = { ...node(), gain: parameter() };
      gains.push(gain);
      return gain;
    },
    createStereoPanner,
    createBufferSource: () => {
      const source = {
        ...node(),
        buffer: null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        start: vi.fn(),
        stop: vi.fn(),
        addEventListener: vi.fn(),
      };
      sources.push(source);
      return source;
    },
  } as unknown as AudioContext;
  return {
    context,
    sources,
    gains,
    decodeAudioData,
    resume,
    suspend,
    close,
    createStereoPanner,
    setCurrentTime(value: number) { currentTime = value; },
  };
}

type TestFetchAudio = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function audioResponse(encoded = new ArrayBuffer(16)): Response {
  return new Response(encoded, {
    status: 200,
    headers: { "content-length": String(encoded.byteLength) },
  });
}

function taggedAudioResponse(
  urls: Map<number, string>,
  input: RequestInfo | URL,
): Response {
  const id = urls.size + 1;
  const encoded = new Uint8Array(16);
  encoded[0] = id;
  urls.set(id, String(input));
  return audioResponse(encoded.buffer);
}

function taggedAudioUrl(urls: ReadonlyMap<number, string>, encoded: ArrayBuffer): string {
  return urls.get(new Uint8Array(encoded)[0] ?? 0) ?? "";
}

function successfulFetcher() {
  return vi.fn<TestFetchAudio>(async () => audioResponse());
}

function playbackOffsets(recording: ReturnType<typeof recordingAudioContext>): number[] {
  return recording.sources.map((source) => source.start.mock.calls[0]?.[1] as number);
}

function playbackTimes(recording: ReturnType<typeof recordingAudioContext>): number[] {
  return recording.sources.map((source) => source.start.mock.calls[0]?.[0] as number);
}

function voiceGains(recording: ReturnType<typeof recordingAudioContext>): number[] {
  return recording.gains.slice(1).map((gain) => gain.gain.setValueAtTime.mock.calls[0]?.[0] as number);
}

async function unlockWithBackground(backend: PrimalSpriteAudioBackend): Promise<void> {
  await expect(backend.unlock()).resolves.toBe(true);
  await backend.whenBackgroundReady();
}

describe("PrimalSpriteAudioBackend", () => {
  it("primes the four-pack main barrier before delayed on a suspended graph", async () => {
    const recording = recordingAudioContext();
    const contextFactory = vi.fn(() => recording.context);
    const fetcher = successfulFetcher();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory,
      fetcher,
      fallback: null,
    });

    const first = backend.prime();
    const duplicate = backend.prime();
    expect(duplicate).toBe(first);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([undefined, undefined]);

    expect(contextFactory).toHaveBeenCalledTimes(1);
    expect(backend.state).toBe("suspended");
    expect(recording.resume).not.toHaveBeenCalled();
    expect(recording.sources).toEqual([]);
    expect(recording.gains).toHaveLength(1);
    await backend.whenBackgroundReady();
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "/assets/primal-runtime/audio/common_sounds_desktop.mp3",
      "/assets/primal-runtime/audio/sounds_desktop_0.m4a",
      "/assets/primal-runtime/audio/sounds_desktop_1.m4a",
      "/assets/primal-runtime/audio/sounds_desktop_2.m4a",
      "/assets/primal-runtime/audio/snd_delayed_desktop_0.m4a",
    ]);
    expect(recording.decodeAudioData).toHaveBeenCalledTimes(5);

    await expect(backend.unlock()).resolves.toBe(true);
    await backend.whenBackgroundReady();
    expect(recording.resume).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(recording.decodeAudioData).toHaveBeenCalledTimes(5);
  });

  it("strictly primes all five launch packs without resuming the AudioContext", async () => {
    const recording = recordingAudioContext();
    const delayedDecode = deferred<AudioBuffer>();
    const encodedUrls = new Map<number, string>();
    const fetcher = vi.fn<TestFetchAudio>(async (input) => (
      taggedAudioResponse(encodedUrls, input)
    ));
    recording.decodeAudioData.mockImplementation(async (encoded: ArrayBuffer) => {
      const url = taggedAudioUrl(encodedUrls, encoded);
      if (url.includes("snd_delayed")) return delayedDecode.promise;
      return { duration: 300 } as AudioBuffer;
    });
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher,
      fallback: null,
    });

    const first = backend.primeForLaunch();
    const duplicate = backend.primeForLaunch();
    expect(duplicate).toBe(first);
    let settled = false;
    void first.then(() => { settled = true; });
    await flushMicrotasks();

    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "/assets/primal-runtime/audio/common_sounds_desktop.mp3",
      "/assets/primal-runtime/audio/sounds_desktop_0.m4a",
      "/assets/primal-runtime/audio/sounds_desktop_1.m4a",
      "/assets/primal-runtime/audio/sounds_desktop_2.m4a",
      "/assets/primal-runtime/audio/snd_delayed_desktop_0.m4a",
    ]);
    expect(recording.decodeAudioData).toHaveBeenCalledTimes(5);
    expect(recording.resume).not.toHaveBeenCalled();
    expect(backend.state).toBe("suspended");
    expect(settled).toBe(false);

    delayedDecode.resolve({ duration: 300 } as AudioBuffer);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([undefined, undefined]);
    expect(recording.resume).not.toHaveBeenCalled();
    expect(backend.state).toBe("suspended");
  });

  it("aborts active pack fetches on destroy and ignores every late completion", async () => {
    const recording = recordingAudioContext();
    const requests: Array<{
      readonly signal: AbortSignal;
      readonly response: Deferred<Response>;
    }> = [];
    const fetcher = vi.fn<TestFetchAudio>((_input, init) => {
      const response = deferred<Response>();
      requests.push({ signal: init?.signal as AbortSignal, response });
      return response.promise;
    });
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher,
      fallback: null,
    });

    const prime = backend.primeForLaunch();
    await vi.waitFor(() => expect(requests).toHaveLength(5));
    backend.playOneShot("intro.game");

    await backend.destroy();

    expect(requests.every(({ signal }) => signal.aborted)).toBe(true);
    expect(backend.state).toBe("closed");
    for (const { response } of requests) {
      response.resolve(audioResponse());
    }
    await expect(prime).rejects.toThrow();
    await flushMicrotasks();

    const internals = backend as unknown as {
      buffers: Map<string, AudioBuffer>;
      bufferLoads: Map<string, Promise<AudioBuffer>>;
      failedPacks: Set<string>;
      pendingOneShots: unknown[];
      pendingLoops: Map<string, unknown>;
    };
    expect(internals.buffers.size).toBe(0);
    expect(internals.bufferLoads.size).toBe(0);
    expect(internals.failedPacks.size).toBe(0);
    expect(internals.pendingOneShots).toEqual([]);
    expect(internals.pendingLoops.size).toBe(0);
    expect(recording.decodeAudioData).not.toHaveBeenCalled();
    expect(recording.sources).toEqual([]);
  });

  it("drops a decoded pack that resolves after destroy without repopulating maps", async () => {
    const recording = recordingAudioContext();
    const decode = deferred<AudioBuffer>();
    recording.decodeAudioData.mockImplementation(() => decode.promise);
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });

    const prime = backend.primeForLaunch();
    await vi.waitFor(() => expect(recording.decodeAudioData).toHaveBeenCalledTimes(5));
    await backend.destroy();
    decode.resolve({ duration: 300 } as AudioBuffer);
    await expect(prime).rejects.toThrow();
    await flushMicrotasks();

    const internals = backend as unknown as {
      buffers: Map<string, AudioBuffer>;
      bufferLoads: Map<string, Promise<AudioBuffer>>;
      failedPacks: Set<string>;
    };
    expect(internals.buffers.size).toBe(0);
    expect(internals.bufferLoads.size).toBe(0);
    expect(internals.failedPacks.size).toBe(0);
  });

  it("propagates a required delayed-pack failure from strict launch priming", async () => {
    const recording = recordingAudioContext();
    const fetcher = vi.fn<TestFetchAudio>(async (input) => {
      const url = String(input);
      if (url.includes("snd_delayed")) {
        return { ok: false, status: 503 } as Response;
      }
      return audioResponse();
    });
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher,
      fallback: null,
    });

    await expect(backend.primeForLaunch()).rejects.toThrow(
      "Audio asset snd_delayed_desktop_0.m4a returned HTTP 503",
    );
    expect(recording.decodeAudioData).toHaveBeenCalledTimes(4);
    expect(recording.resume).not.toHaveBeenCalled();
    expect(backend.state).toBe("suspended");
  });

  it("selects the mobile audio root and pack names from assetChannel alone", async () => {
    const recording = recordingAudioContext();
    const fetcher = successfulFetcher();
    const backend = new PrimalSpriteAudioBackend({
      assetChannel: "mobile",
      contextFactory: () => recording.context,
      fetcher,
      fallback: null,
    });

    await backend.prime();
    await backend.whenBackgroundReady();

    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "/assets/primal-runtime/mobile/audio/common_sounds_mobile.mp3",
      "/assets/primal-runtime/mobile/audio/sounds_mobile_0.m4a",
      "/assets/primal-runtime/mobile/audio/sounds_mobile_1.m4a",
      "/assets/primal-runtime/mobile/audio/sounds_mobile_2.m4a",
      "/assets/primal-runtime/mobile/audio/snd_delayed_mobile_0.m4a",
    ]);
    expect(recording.decodeAudioData).toHaveBeenCalledTimes(5);
  });

  it("keeps a failed prime non-blocking and retries its missing critical pack on unlock", async () => {
    const recording = recordingAudioContext();
    recording.decodeAudioData
      .mockRejectedValueOnce(new Error("transient predecode failure"))
      .mockResolvedValue({ duration: 300 } as AudioBuffer);
    const fetcher = successfulFetcher();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher,
      fallback: null,
    });
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });

    await expect(manager.prime()).resolves.toBeUndefined();
    expect(recording.resume).not.toHaveBeenCalled();
    expect(backend.state).toBe("suspended");

    await expect(manager.unlock()).resolves.toBe(true);
    await backend.whenBackgroundReady();
    expect(manager.isUnlocked).toBe(true);
    // 先发出四个初始主请求，再为失败的资源包重试一次，随后进入延迟加载。
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(recording.decodeAudioData).toHaveBeenCalledTimes(6);
  });

  it("schedules captured sources while primed context is still suspended", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await backend.prime();
    backend.playOneShot("ui.splash-continue");
    backend.startLoop("ambient.city");
    const sources = [...recording.sources];
    expect(backend.state).toBe("suspended");
    expect(sources).toHaveLength(3);
    expect(sources.every((source) => source.start.mock.calls.length === 1)).toBe(true);

    await expect(backend.unlock()).resolves.toBe(true);
    expect(recording.sources).toEqual(sources);
    expect(sources.every((source) => source.start.mock.calls.length === 1)).toBe(true);
  });

  it("reports the frozen AudioContext epoch before resume and the same advancing epoch after it", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });

    expect(backend.playbackClockMs()).toBeNull();
    await backend.primeForLaunch();
    expect(backend.state).toBe("suspended");
    expect(backend.playbackClockMs()).toBe(2_000);
    recording.setCurrentTime(1.25);
    expect(backend.playbackClockMs()).toBe(1_250);
  });

  it("does not retain a wall-clock intro across a late first native unlock", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    await manager.primeForLaunch();
    expect(backend.state).toBe("suspended");

    manager.playGameIntro({ intensity: 1 }, "wall-clock");
    expect(recording.sources).toEqual([]);

    await expect(manager.unlock()).resolves.toBe(true);
    expect(recording.sources).toEqual([]);
  });

  it("lazily fetches and decodes each real sprite pack only once", async () => {
    const recording = recordingAudioContext();
    const contextFactory = vi.fn(() => recording.context);
    const fetcher = successfulFetcher();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory,
      fetcher,
      fallback: null,
    });

    expect(backend.state).toBe("locked");
    expect(contextFactory).not.toHaveBeenCalled();
    backend.playOneShot("ui.click");
    expect(recording.sources).toEqual([]);

    const first = backend.unlock();
    const concurrent = backend.unlock();
    await expect(Promise.all([first, concurrent])).resolves.toEqual([true, true]);
    expect(contextFactory).toHaveBeenCalledTimes(1);
    expect(recording.resume).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls.map(([url]) => url).sort()).toEqual([
      "/assets/primal-runtime/audio/common_sounds_desktop.mp3",
      "/assets/primal-runtime/audio/snd_delayed_desktop_0.m4a",
      "/assets/primal-runtime/audio/sounds_desktop_0.m4a",
      "/assets/primal-runtime/audio/sounds_desktop_1.m4a",
      "/assets/primal-runtime/audio/sounds_desktop_2.m4a",
    ]);
    expect(recording.decodeAudioData).toHaveBeenCalledTimes(5);

    await expect(backend.unlock()).resolves.toBe(true);
    await backend.whenBackgroundReady();
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(recording.decodeAudioData).toHaveBeenCalledTimes(5);
  });

  it("holds main readiness for sounds1/2 and releases retained events exactly once", async () => {
    const recording = recordingAudioContext();
    const urls = new Map<number, string>();
    const fetcher = vi.fn<TestFetchAudio>(async (input) => taggedAudioResponse(urls, input));
    let resolveSounds1!: (buffer: AudioBuffer) => void;
    let resolveSounds2!: (buffer: AudioBuffer) => void;
    const sounds1 = new Promise<AudioBuffer>((resolve) => { resolveSounds1 = resolve; });
    const sounds2 = new Promise<AudioBuffer>((resolve) => { resolveSounds2 = resolve; });
    recording.decodeAudioData.mockImplementation((encoded: ArrayBuffer) => {
      const url = taggedAudioUrl(urls, encoded);
      if (url.endsWith("sounds_desktop_1.m4a")) return sounds1;
      if (url.endsWith("sounds_desktop_2.m4a")) return sounds2;
      return Promise.resolve({ duration: 300 } as AudioBuffer);
    });
    const fallback = new RecordingFallback();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher,
      fallback,
      random: () => 0,
    });

    const first = backend.unlock();
    const duplicate = backend.unlock();
    await vi.waitFor(() => {
      expect(recording.decodeAudioData).toHaveBeenCalledTimes(4);
    });
    expect(fetcher.mock.calls.map(([url]) => String(url))).not.toContain(
      "/assets/primal-runtime/audio/snd_delayed_desktop_0.m4a",
    );

    backend.playOneShot("ui.splash-continue");
    backend.playOneShot("intro.game");
    backend.startLoop("reel.motor");
    expect(recording.sources).toEqual([]);
    expect(fallback.oneShots).toEqual([]);
    expect(fallback.loops).toEqual([]);

    resolveSounds1({ duration: 300 } as AudioBuffer);
    resolveSounds2({ duration: 300 } as AudioBuffer);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([true, true]);
    await backend.whenBackgroundReady();
    expect(playbackOffsets(recording)).toEqual([
      137_055 / 44_100,
      224.5,
      21.5,
      193.6,
    ]);
    expect(fallback.oneShots).toEqual([]);
    expect(fallback.loops).toEqual([]);

    // 后续解锁会复用所有已解码的资源包。
    await expect(backend.unlock()).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(recording.decodeAudioData).toHaveBeenCalledTimes(5);
    backend.playOneShot("ui.click");
    backend.playOneShot("monster.sniff");
    expect(playbackOffsets(recording).slice(-2)).toEqual([7, 50.5]);
  });

  it("retries only failed delayed audio and never synthesizes captured events", async () => {
    const recording = recordingAudioContext();
    const urls = new Map<number, string>();
    const fetcher = vi.fn<TestFetchAudio>(async (input) => taggedAudioResponse(urls, input));
    let delayedAttempts = 0;
    recording.decodeAudioData.mockImplementation((encoded: ArrayBuffer) => {
      const url = taggedAudioUrl(urls, encoded);
      if (url.endsWith("snd_delayed_desktop_0.m4a") && delayedAttempts++ === 0) {
        return Promise.reject(new Error("delayed codec failed"));
      }
      return Promise.resolve({ duration: 300 } as AudioBuffer);
    });
    const fallback = new RecordingFallback();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher,
      fallback,
    });
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });

    await expect(manager.unlock()).resolves.toBe(true);
    await expect(backend.whenBackgroundReady()).resolves.toBeUndefined();
    backend.playOneShot("normal-win.counter-tail", { intensity: 0.6 });
    expect(fallback.oneShots).toEqual([]);

    // context 运行后 AudioManager 通常会直接返回。其延迟加载钩子仍允许后续
    // 用户手势解锁恰好重新预备一批重试任务，而无需再次恢复 context 或降级方案。
    const retry = manager.unlock();
    const concurrentRetry = manager.unlock();
    await expect(Promise.all([retry, concurrentRetry])).resolves.toEqual([true, true]);
    await backend.whenBackgroundReady();
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(recording.decodeAudioData).toHaveBeenCalledTimes(6);
    const fetchedFiles = fetcher.mock.calls.map(([url]) => String(url));
    expect(fetchedFiles.filter((url) => url.endsWith("snd_delayed_desktop_0.m4a"))).toHaveLength(2);
    for (const file of [
      "common_sounds_desktop.mp3",
      "sounds_desktop_0.m4a",
      "sounds_desktop_1.m4a",
      "sounds_desktop_2.m4a",
    ]) {
      expect(fetchedFiles.filter((url) => url.endsWith(file))).toHaveLength(1);
    }

    backend.playOneShot("normal-win.counter-tail", { intensity: 0.6 });
    expect(playbackOffsets(recording).at(-1)).toBe(24);
    expect(fallback.oneShots).toHaveLength(0);

    await expect(manager.unlock()).resolves.toBe(true);
    await backend.whenBackgroundReady();
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(recording.decodeAudioData).toHaveBeenCalledTimes(6);
  });

  it("catches a pending loop up, expires stale one-shots, and honors pending stop", async () => {
    const recording = recordingAudioContext();
    const urls = new Map<number, string>();
    const fetcher = vi.fn<TestFetchAudio>(async (input) => taggedAudioResponse(urls, input));
    let resolveDelayed!: (buffer: AudioBuffer) => void;
    const delayed = new Promise<AudioBuffer>((resolve) => { resolveDelayed = resolve; });
    recording.decodeAudioData.mockImplementation((encoded: ArrayBuffer) => (
      taggedAudioUrl(urls, encoded).endsWith("snd_delayed_desktop_0.m4a")
        ? delayed
        : Promise.resolve({ duration: 300 } as AudioBuffer)
    ));
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher,
      fallback: null,
    });

    await expect(backend.unlock()).resolves.toBe(true);
    backend.startLoop("counter.normal-generic");
    backend.startLoop("counter.big-win");
    backend.playOneShot("normal-win.counter-tail");
    backend.stopLoop("counter.big-win", 0);
    recording.setCurrentTime(4);
    resolveDelayed({ duration: 300 } as AudioBuffer);
    await backend.whenBackgroundReady();

    expect(recording.sources).toHaveLength(1);
    const loopDuration = (900_148 - 882_000) / 44_100;
    expect(playbackOffsets(recording)[0]).toBeCloseTo(20 + (2 % loopDuration), 8);
    expect(recording.sources[0]?.loop).toBe(true);
  });

  it("plays verified sprite slices with sequence and no-repeat selection", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
      random: () => 0,
    });
    await unlockWithBackground(backend);

    for (let index = 0; index < 4; index += 1) backend.playOneShot("ui.click");
    backend.playOneShot("reel.stop");
    backend.playOneShot("reel.stop");
    backend.playOneShot("energy.collect");
    backend.playOneShot("wheel.spin");
    backend.playOneShot("feature.start");
    backend.playOneShot("win.sting");
    backend.playOneShot("monster.impact");

    const starts = recording.sources.map((source) => source.start.mock.calls[0]?.[1] as number);
    expect(starts.slice(0, 4)).toEqual([7, 9.5, 12, 7]);
    expect(starts[4]).toBeCloseTo(206.5);
    expect(starts[5]).toBeCloseTo(209);
    expect(starts[6]).toBeCloseTo(185);
    expect(starts[7]).toBeCloseTo(235);
    expect(starts[8]).toBeCloseTo(101);
    // Wheel_Spin 是捕获到的多提示音编排，并非单个通用片段。
    expect(starts.slice(9, 17)).toEqual([
      219.5, 224, 214, 235, 81.5, 85, 88.5, 88.4,
    ]);
    expect(starts[17]).toBeCloseTo(46);
    expect(playbackTimes(recording)[17]).toBeCloseTo(5.5);
    expect(voiceGains(recording)[17]).toBeCloseTo(0.15);
    expect(starts[18]).toBeCloseTo(216.5);
    expect(starts[19]).toBeCloseTo(99);
    expect(starts[20]).toBeCloseTo(64);

    const firstUiDuration = recording.sources[0]?.start.mock.calls[0]?.[2] as number;
    expect(firstUiDuration).toBeCloseTo(1.3);
  });

  it("plays ReelStop at gain 57, centred, and stops a repeated selected title first", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
      random: () => 0,
    });
    await unlockWithBackground(backend);

    backend.playOneShot("reel.stop", { pan: -0.8 });
    backend.playOneShot("reel.stop", { pan: 0.8 });
    backend.playOneShot("reel.stop", { pan: 0.8 });

    expect(playbackOffsets(recording)).toEqual([206.5, 209, 206.5]);
    expect(voiceGains(recording)).toEqual([0.57, 0.57, 0.57]);
    expect(recording.createStereoPanner).not.toHaveBeenCalled();
    expect(recording.sources[0]?.stop).toHaveBeenCalledTimes(1);
    expect(recording.sources[1]?.stop).not.toHaveBeenCalled();
  });

  it("plays the premixed game intro from its exact captured sample range", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await backend.unlock();

    backend.playOneShot("intro.game");
    const intro = recording.sources[0];
    expect(intro?.start.mock.calls[0]?.[1]).toBeCloseTo(224.5, 8);
    expect(intro?.start.mock.calls[0]?.[2]).toBeCloseTo(10.086190476, 8);

    backend.stopOneShot("intro.game", 200);
    expect(intro?.stop).toHaveBeenCalledWith(2.21);
  });

  it("plays the exact common splash Continue click", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await backend.unlock();

    backend.playOneShot("ui.splash-continue");
    const click = recording.sources[0];
    expect(click?.start.mock.calls[0]?.[1]).toBeCloseTo(137_055 / 44_100, 8);
    expect(click?.start.mock.calls[0]?.[2]).toBeCloseTo((158_624 - 137_055) / 44_100, 8);
    expect(voiceGains(recording)[0]).toBe(1);
  });

  it("resolves every overwritten counter cue from the delayed sprite only", () => {
    const delayedCounters = [
      ["BigWinCounterGenericNewLoop1", 44_100, 143_290],
      ["BigWinCounterGenericNewStart1", 198_450, 267_562],
      ["BigWinCounterGenericNewTail1", 308_700, 395_858],
      ["BigWinCounterSweetener1", 418_950, 443_306],
      ["BigWinCounterSweetener2", 485_100, 511_250],
      ["BigWinCounterSweetener3", 551_250, 622_888],
      ["BigWinCounterSweetener4", 661_500, 735_531],
      ["BigWinCounterSweetener5", 771_750, 823_279],
      ["WinCounterGenericNewLoop1", 882_000, 900_148],
      ["WinCounterGenericNewStart1", 948_150, 1_020_832],
      ["WinCounterGenericNewTail1", 1_058_400, 1_135_790],
      ["WinCounterSweetener1", 1_168_650, 1_191_823],
      ["WinCounterSweetener2", 1_234_800, 1_260_953],
      ["WinCounterSweetener3", 1_300_950, 1_326_453],
      ["WinCounterSweetener4", 1_367_100, 1_380_242],
    ] as const;

    for (const [title, startSample, endSample] of delayedCounters) {
      expect(PRIMAL_CUE_DEFINITIONS[title]).toEqual({
        pack: "delayed",
        startSample,
        endSample,
      });
    }
    expect(
      Object.values(PRIMAL_CUE_DEFINITIONS).filter(({ pack }) => pack === "delayed"),
    ).toHaveLength(delayedCounters.length);

    expect(PRIMAL_CUE_DEFINITIONS["743UiOpen"]).toEqual({
      pack: "sounds1",
      startSample: 793_800,
      endSample: 887_880,
    });
    expect(PRIMAL_CUE_DEFINITIONS["LandBasedJackpotMed"]).toEqual({
      pack: "sounds1",
      startSample: 3_969_000,
      endSample: 4_171_297,
    });
    expect(PRIMAL_CUE_DEFINITIONS["1065MusBw"]).toEqual({
      pack: "sounds0",
      startSample: 4_939_200,
      endSample: 5_544_000,
    });
    expect(PRIMAL_CUE_DEFINITIONS["1065SfRoar2of5"]).toEqual({
      pack: "sounds2",
      startSample: 44_100,
      endSample: 258_641,
    });
  });

  it("plays the captured panel open and close slices at their authored gains", async () => {
    expect(PRIMAL_CUE_DEFINITIONS["743UiOpen"]).toEqual({
      pack: "sounds1",
      startSample: 793_800,
      endSample: 887_880,
    });
    expect(PRIMAL_CUE_DEFINITIONS["743UiClose"]).toEqual({
      pack: "sounds1",
      startSample: 154_350,
      endSample: 248_430,
    });

    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(backend);

    backend.playOneShot("ui.open");
    backend.playOneShot("ui.close");

    expect(playbackOffsets(recording)).toEqual([18, 3.5]);
    expect(recording.sources[0]?.start.mock.calls[0]?.[2]).toBeCloseTo(
      (887_880 - 793_800) / 44_100,
      10,
    );
    expect(recording.sources[1]?.start.mock.calls[0]?.[2]).toBeCloseTo(
      (248_430 - 154_350) / 44_100,
      10,
    );
    expect(voiceGains(recording)).toEqual([0.55, 0.51]);
  });

  it("ducks and restores only active generic counters without replacing sources", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(backend);
    backend.startLoop("counter.normal-generic");
    backend.startLoop("counter.big-win");
    const normal = recording.sources[0]!;
    const big = recording.sources[1]!;
    const normalGain = recording.gains[1]!.gain;
    const bigGain = recording.gains[2]!.gain;

    backend.playOneShot("ui.open");
    expect(normalGain.linearRampToValueAtTime.mock.calls.at(-1)).toEqual([0, 2.2]);
    expect(bigGain.linearRampToValueAtTime.mock.calls.at(-1)).toEqual([0, 2.2]);
    backend.playOneShot("ui.close");
    expect(normalGain.linearRampToValueAtTime.mock.calls.at(-1)).toEqual([1, 2.2]);
    expect(bigGain.linearRampToValueAtTime.mock.calls.at(-1)).toEqual([0.46, 2.2]);
    expect(normal.start).toHaveBeenCalledTimes(1);
    expect(big.start).toHaveBeenCalledTimes(1);

    backend.stopLoop("counter.normal-generic", 0);
    backend.stopLoop("counter.big-win", 0);
    const beforeInactiveOpen = recording.sources.length;
    backend.playOneShot("ui.open");
    expect(recording.sources).toHaveLength(beforeInactiveOpen + 1);
  });

  it("retains exact UI programs while sounds1 is decoding without substitution", async () => {
    const recording = recordingAudioContext();
    const urls = new Map<number, string>();
    const fetcher = vi.fn<TestFetchAudio>(async (input) => taggedAudioResponse(urls, input));
    let resolveSounds1!: (buffer: AudioBuffer) => void;
    const sounds1 = new Promise<AudioBuffer>((resolve) => { resolveSounds1 = resolve; });
    recording.decodeAudioData.mockImplementation((encoded: ArrayBuffer) => (
      taggedAudioUrl(urls, encoded).endsWith("sounds_desktop_1.m4a")
        ? sounds1
        : Promise.resolve({ duration: 300 } as AudioBuffer)
    ));
    const fallback = new RecordingFallback();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher,
      fallback,
    });

    const unlock = backend.unlock();
    await Promise.resolve();
    await Promise.resolve();
    backend.playOneShot("ui.open", { intensity: 0.7 });
    backend.playOneShot("ui.close");
    expect(fallback.oneShots).toEqual([]);
    expect(recording.sources).toEqual([]);

    resolveSounds1({ duration: 300 } as AudioBuffer);
    await expect(unlock).resolves.toBe(true);
    await backend.whenBackgroundReady();
    expect(playbackOffsets(recording)).toEqual([18, 3.5]);
    expect(voiceGains(recording)).toEqual([0.55 * 0.7, 0.51]);
  });

  it("plays ordered Rage land layers and the exact Wild/radar land composite", async () => {
    const rage = recordingAudioContext();
    const rageBackend = new PrimalSpriteAudioBackend({
      contextFactory: () => rage.context,
      fetcher: successfulFetcher(),
      fallback: null,
      random: () => 0,
    });
    await unlockWithBackground(rageBackend);

    rageBackend.playOneShot("symbol.scatter-land-1", { pan: -0.8 });
    rageBackend.playOneShot("symbol.scatter-land-2", { pan: 0.8 });
    rageBackend.playOneShot("symbol.scatter-land-3", { pan: -0.8 });
    rageBackend.playOneShot("symbol.scatter-land-4", { pan: 0.8 });
    rageBackend.playOneShot("symbol.scatter-land-5", { pan: -0.8 });

    expect(playbackOffsets(rage)).toEqual([
      160.5, 186, 178,
      162, 186.25, 179.5,
      164.5, 186.28, 178,
      167,
      169.5,
    ]);
    expect(playbackTimes(rage)).toEqual(Array.from({ length: 11 }, () => 2));
    expect(voiceGains(rage)).toEqual([
      0.14, 0.32, 0.38,
      0.32, 0.32, 0.38,
      0.24, 0.18, 0.38,
      0.9,
      0.96,
    ]);
    expect(rage.createStereoPanner).not.toHaveBeenCalled();

    const wild = recordingAudioContext();
    const wildBackend = new PrimalSpriteAudioBackend({
      contextFactory: () => wild.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(wildBackend);
    wildBackend.playOneShot("symbol.wild-land", { pan: 0.8 });

    expect(playbackOffsets(wild)).toEqual([181.5, 160.65, 162, 179.5, 178, 164.5]);
    expect(playbackTimes(wild)).toEqual([2.3, 2.3, 2.3, 2.3, 2.45, 2.45]);
    expect(voiceGains(wild)).toEqual([0.42, 0.38, 0.5, 0.44, 0.48, 0.42]);
    expect(wild.createStereoPanner).not.toHaveBeenCalled();
  });

  it("matches authored stop-before behavior for Rage, Scatter, and Wild land programs", async () => {
    const rage = recordingAudioContext();
    const rageBackend = new PrimalSpriteAudioBackend({
      contextFactory: () => rage.context,
      fetcher: successfulFetcher(),
      fallback: null,
      random: () => 0,
    });
    await unlockWithBackground(rageBackend);

    rageBackend.playOneShot("energy.collect");
    const firstCollect = rage.sources[0]!;
    const firstRoar = rage.sources[1]!;
    rageBackend.playOneShot("energy.collect");
    expect(firstCollect.stop).toHaveBeenLastCalledWith(2);
    expect(firstRoar.stop).not.toHaveBeenCalled();
    expect(playbackOffsets(rage)).toEqual([185, 235, 185, 6.5]);
    rageBackend.playOneShot("energy.collect");
    expect(firstRoar.stop).toHaveBeenLastCalledWith(2);

    const scatterCues = [
      "symbol.scatter-land-1",
      "symbol.scatter-land-2",
      "symbol.scatter-land-3",
      "symbol.scatter-land-4",
      "symbol.scatter-land-5",
    ] as const satisfies readonly OneShotAudioCue[];
    for (const [index, cue] of scatterCues.entries()) {
      const recording = recordingAudioContext();
      const backend = new PrimalSpriteAudioBackend({
        contextFactory: () => recording.context,
        fetcher: successfulFetcher(),
        fallback: null,
        random: () => 0,
      });
      await unlockWithBackground(backend);

      backend.playOneShot(cue);
      const firstMain = recording.sources[0]!;
      const firstCollectLayer = recording.sources[1];
      const firstLowHit = recording.sources[2];
      backend.playOneShot(cue);

      if (index === 0) expect(firstMain.stop, cue).not.toHaveBeenCalled();
      else expect(firstMain.stop, cue).toHaveBeenLastCalledWith(2);
      if (index < 3) {
        expect(firstCollectLayer?.stop, cue).toHaveBeenLastCalledWith(2);
        expect(firstLowHit?.stop, cue).not.toHaveBeenCalled();
        backend.playOneShot(cue);
        expect(firstLowHit?.stop, cue).toHaveBeenLastCalledWith(2);
      }
    }

    const wild = recordingAudioContext();
    const wildBackend = new PrimalSpriteAudioBackend({
      contextFactory: () => wild.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(wildBackend);
    wildBackend.playOneShot("symbol.wild-land");
    const firstWildLayers = wild.sources.slice(0, 6);
    wildBackend.playOneShot("symbol.wild-land");
    expect(firstWildLayers).toHaveLength(6);
    for (const source of firstWildLayers) expect(source.stop).toHaveBeenLastCalledWith(2);
  });

  it("maps PPS, Vault count, jackpot tier, and Win1-8 to captured samples and gains", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(backend);

    for (const cue of [
      "pps.level-1", "pps.level-2", "pps.level-3", "pps.level-4", "pps.level-5",
      "vault.unlock-1", "vault.unlock-2", "vault.unlock-3-plus",
      "jackpot.mini", "jackpot.minor", "jackpot.major", "jackpot.mega", "jackpot.grand",
      "payout.win-1", "payout.win-2", "payout.win-3", "payout.win-4",
      "payout.win-5", "payout.win-6", "payout.win-7", "payout.win-8",
    ] as const) backend.playOneShot(cue);

    expect(playbackOffsets(recording)).toEqual([
      214, 214, 219.5, 224, 229.5,
      81.3, 85.2, 88.7,
      206, 209.5, 196, 200.5, 188.5,
      143.5, 99, 104.5, 110, 115.5, 121, 127.5, 134,
    ]);
    expect(voiceGains(recording)).toEqual([
      0.18, 0.46, 0.46, 0.4, 0.44,
      0.48, 0.46, 0.4,
      0.56, 0.56, 0.48, 0.46, 0.44,
      0.82, 0.8, 0.72, 0.57, 0.42, 0.42, 0.36, 0.59,
    ]);
  });

  it("replaces only authored PPS level titles", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(backend);

    for (const cue of ["pps.level-1", "pps.level-2"] as const satisfies readonly OneShotAudioCue[]) {
      const firstIndex = recording.sources.length;
      backend.playOneShot(cue);
      const first = recording.sources[firstIndex]!;
      backend.playOneShot(cue);
      expect(first.stop, cue).toHaveBeenLastCalledWith(2);
    }

    for (const cue of [
      "pps.level-3",
      "pps.level-4",
      "pps.level-5",
    ] as const satisfies readonly OneShotAudioCue[]) {
      const firstIndex = recording.sources.length;
      backend.playOneShot(cue);
      const first = recording.sources[firstIndex]!;
      backend.playOneShot(cue);
      expect(first.stop, cue).not.toHaveBeenCalled();
    }
  });

  it("uses the dedicated captured Scatter and bet-loss programs", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(backend);

    backend.playOneShot("symbol.scatter-win");
    backend.playOneShot("win.loss-or-equal");

    expect(playbackOffsets(recording)).toEqual([182.5, 143.5]);
    expect(voiceGains(recording)).toEqual([1.13, 0.5]);
    expect(recording.sources[0]?.start.mock.calls[0]?.[2]).toBeCloseTo(59_794 / 44_100);
    expect(recording.sources[1]?.start.mock.calls[0]?.[2]).toBeCloseTo(151_239 / 44_100);
  });

  it("lets the captured anticipation pair finish when ReelSuspenseStop targets absent titles", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(backend);

    backend.playOneShot("reel.anticipation");
    expect(playbackOffsets(recording)).toEqual([219.5, 29]);
    expect(voiceGains(recording)).toEqual([0.26, 0.26]);
    backend.stopOneShot("reel.anticipation", 1_000);
    expect(recording.sources[0]?.stop).not.toHaveBeenCalled();
    expect(recording.sources[1]?.stop).not.toHaveBeenCalled();
    expect(recording.gains[1]?.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    expect(recording.gains[2]?.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
  });

  it("plays exact Big Win music, counter, upgrade, and end programs", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
      random: () => 0,
    });
    await unlockWithBackground(backend);

    backend.playOneShot("big-win.trigger");
    backend.startLoop("music.big-win");
    backend.playOneShot("big-win.counter-start");
    backend.startLoop("counter.big-win");
    backend.playOneShot("big-win.level-up");
    backend.playOneShot("big-win.counter-sweetener");
    backend.stopLoop("counter.big-win", 150);
    backend.playOneShot("big-win.counter-tail");
    backend.stopLoop("music.big-win", 150);
    backend.playOneShot("big-win.end");

    expect(playbackOffsets(recording)).toEqual([
      90, 112, 4.5, 1, 235, 9.5, 7, 126.5, 53.5,
    ]);
    expect(voiceGains(recording)).toEqual([
      0.34, 0.42, 0.56, 0.46, 0.32, 0.64, 0.52, 0.28, 0.78,
    ]);
  });

  it("plays both normal-win counter loops and the exact GenericNew sequence", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(backend);

    backend.playOneShot("normal-win.counter-start");
    backend.startLoop("counter.normal-generic");
    backend.startLoop("counter.normal-common");
    for (let index = 0; index < 5; index += 1) {
      backend.playOneShot("normal-win.counter-sweetener");
    }
    backend.stopLoop("counter.normal-generic", 150);
    backend.stopLoop("counter.normal-common", 0);
    backend.playOneShot("normal-win.counter-tail");

    expect(playbackOffsets(recording)).toEqual([
      21.5,
      20,
      1,
      26.5,
      28,
      29.5,
      31,
      26.5,
      24,
    ]);
    expect(voiceGains(recording)).toEqual([
      1,
      1,
      0.8,
      1,
      1,
      1,
      1,
      1,
      1,
    ]);

    const genericLoop = recording.sources[1];
    expect(genericLoop?.loop).toBe(true);
    expect(genericLoop?.loopStart).toBeCloseTo(20);
    expect(genericLoop?.loopEnd).toBeCloseTo(900_148 / 44_100);
    expect(genericLoop?.stop.mock.calls[0]?.[0]).toBeCloseTo(2.16);

    const commonLoop = recording.sources[2];
    expect(commonLoop?.loop).toBe(true);
    expect(commonLoop?.loopStart).toBeCloseTo(51_315 / 44_100);
    expect(commonLoop?.loopEnd).toBeCloseTo(58_530 / 44_100);
    expect(commonLoop?.stop).toHaveBeenCalledWith(2);
  });

  it("plays the captured WheelWait loop and Vault anticipation/fly slices", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(backend);

    backend.startLoop("wheel.wait");
    backend.playOneShot("vault.anticipation");
    backend.playOneShot("vault.fly");

    expect(playbackOffsets(recording)).toEqual([111.5, 92.8, 216.5]);
    expect(voiceGains(recording)).toEqual([0.14, 0.42, 0.66]);
    expect(recording.sources[0]?.loop).toBe(true);
    expect(recording.sources[0]?.loopStart).toBeCloseTo(111.5);
    expect(recording.sources[0]?.loopEnd).toBeCloseTo(5055087 / 44100);
  });

  it("fades only the tracked WheelSpin body when WheelAward arrives", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(backend);
    backend.playOneShot("wheel.spin");
    const body = recording.sources[0]!;
    const bodyGain = recording.gains[1]!.gain;
    const layers = recording.sources.slice(1);

    backend.playOneShot("wheel.award");
    expect(bodyGain.linearRampToValueAtTime.mock.calls.at(-1)).toEqual([0, 2.1]);
    expect(body.stop.mock.calls[0]?.[0]).toBeCloseTo(2.11);
    expect(layers.every((source) => source.stop.mock.calls.length === 0)).toBe(true);
    expect(playbackOffsets(recording).at(-1)).toBeCloseTo(96.5);
    expect(voiceGains(recording).at(-1)).toBe(0.52);
  });

  it("keeps WheelAppear distinct from stop-before WheelFeaturePanelIn", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(backend);

    backend.playOneShot("wheel.appear");
    const appear = recording.sources[0]!;
    backend.playOneShot("wheel.panel-in");
    const firstPanel = recording.sources[1]!;
    expect(appear.stop).toHaveBeenCalledWith(2);
    backend.playOneShot("wheel.panel-in");
    expect(firstPanel.stop).toHaveBeenCalledWith(2);
    expect(playbackOffsets(recording)).toEqual([91, 91, 91]);
    expect(voiceGains(recording)).toEqual([0.4, 0.4, 0.4]);
  });

  it("replaces same-title sources only for captured stop-before one-shots", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
      random: () => 0,
    });
    await unlockWithBackground(backend);

    const stopBeforeCues = [
      "big-win.trigger",
      "wheel.award",
      "feature.start",
      "free-spins.outro",
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
    ] as const satisfies readonly OneShotAudioCue[];
    for (const cue of stopBeforeCues) {
      const firstIndex = recording.sources.length;
      backend.playOneShot(cue);
      const first = recording.sources[firstIndex]!;
      backend.playOneShot(cue);
      expect(first.stop, cue).toHaveBeenLastCalledWith(2);
    }

    for (const cue of [
      "wheel.appear",
      "normal-win.counter-start",
      "big-win.counter-start",
    ] as const satisfies readonly OneShotAudioCue[]) {
      const firstIndex = recording.sources.length;
      backend.playOneShot(cue);
      const first = recording.sources[firstIndex]!;
      backend.playOneShot(cue);
      expect(first.stop, cue).not.toHaveBeenCalled();
    }
  });

  it("rotates randomexclusive gorilla programs before replacing a repeated title", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
      random: () => 0,
    });
    await unlockWithBackground(backend);

    for (const cue of [
      "monster.roar",
      "monster.sniff",
      "monster.roar-hit",
      "monster.impact",
      "monster.thump-expand",
    ] as const satisfies readonly OneShotAudioCue[]) {
      const firstIndex = recording.sources.length;
      backend.playOneShot(cue);
      const first = recording.sources[firstIndex]!;
      backend.playOneShot(cue);
      expect(first.stop, cue).not.toHaveBeenCalled();
      expect(playbackOffsets(recording)[firstIndex + 1], cue).not.toBe(
        playbackOffsets(recording)[firstIndex],
      );
      backend.playOneShot(cue);
      expect(first.stop, cue).toHaveBeenLastCalledWith(2);
    }

    const reelStretchIndex = recording.sources.length;
    backend.playOneShot("monster.reel-stretch");
    const firstReelStretch = recording.sources[reelStretchIndex]!;
    backend.playOneShot("monster.reel-stretch");
    expect(firstReelStretch.stop).toHaveBeenLastCalledWith(2);
  });

  it("keeps randomexclusive history independent across Rage, Roar, Sniff, and Scatter groups", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
      random: () => 0,
    });
    await unlockWithBackground(backend);

    backend.playOneShot("energy.collect");
    backend.playOneShot("monster.roar");
    backend.playOneShot("monster.sniff");
    backend.playOneShot("symbol.scatter-land-1");
    backend.playOneShot("energy.collect");
    backend.playOneShot("monster.roar");
    backend.playOneShot("monster.sniff");
    backend.playOneShot("symbol.scatter-land-1");

    expect(playbackOffsets(recording)).toEqual([
      185, 235,
      235,
      50.5,
      160.5, 186, 178,
      185, 6.5,
      1,
      55,
      160.5, 186, 179.5,
    ]);
  });

  it("replaces only the PPS layer when FeatureActivate repeats", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(backend);

    backend.playOneShot("monster.feature-activate");
    const firstPower = recording.sources[0]!;
    const firstRoar = recording.sources[1]!;
    backend.playOneShot("monster.feature-activate");

    expect(playbackOffsets(recording)).toEqual([214, 18.8, 214, 18.8]);
    expect(firstPower.stop).toHaveBeenLastCalledWith(2);
    expect(firstRoar.stop).not.toHaveBeenCalled();
  });

  it("keeps Big Win music-end overlapping but replaces repeated level and end-roar titles", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
      random: () => 0,
    });
    await unlockWithBackground(backend);

    for (let index = 0; index < 6; index += 1) backend.playOneShot("big-win.level-up");
    expect(recording.sources[0]?.stop).toHaveBeenLastCalledWith(2);
    expect(recording.sources.slice(1, 5).every((source) => (
      source.stop.mock.calls.length === 0
    ))).toBe(true);

    const firstEndIndex = recording.sources.length;
    backend.playOneShot("big-win.end");
    backend.playOneShot("big-win.end");
    backend.playOneShot("big-win.end");
    const firstMusicEnd = recording.sources[firstEndIndex]!;
    const firstRoar = recording.sources[firstEndIndex + 1]!;
    expect(firstMusicEnd.stop).not.toHaveBeenCalled();
    expect(firstRoar.stop).toHaveBeenLastCalledWith(2);
  });

  it("limits Wheel spin stop-before replacement to the body title", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(backend);

    backend.playOneShot("wheel.spin");
    const body = recording.sources[0]!;
    const delayedLayers = recording.sources.slice(1, 10);
    backend.playOneShot("wheel.spin");

    expect(body.stop).toHaveBeenLastCalledWith(2);
    expect(delayedLayers).toHaveLength(9);
    expect(delayedLayers.every((source) => source.stop.mock.calls.length === 0)).toBe(true);
  });

  it("parameterizes stop-before for Wheel, Big Win, Base, and counter loops", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(backend);

    backend.startLoop("wheel.wait");
    const firstWheelWait = recording.sources.at(-1)!;
    backend.stopLoop("wheel.wait", 200);
    backend.startLoop("wheel.wait");
    expect(firstWheelWait.stop).toHaveBeenLastCalledWith(2);

    backend.startLoop("music.big-win");
    const firstBigWinMusic = recording.sources.at(-1)!;
    backend.stopLoop("music.big-win", 200);
    backend.startLoop("music.big-win");
    expect(firstBigWinMusic.stop).toHaveBeenLastCalledWith(2);

    backend.startLoop("ambient.city");
    const firstBaseStems = recording.sources.slice(-2);
    backend.stopLoop("ambient.city", 200);
    backend.startLoop("ambient.city");
    expect(firstBaseStems).toHaveLength(2);
    expect(firstBaseStems.every((source) => (
      source.stop.mock.calls.at(-1)?.[0] === 2
    ))).toBe(true);

    backend.startLoop("counter.big-win");
    const firstCounter = recording.sources.at(-1)!;
    backend.stopLoop("counter.big-win", 150);
    backend.startLoop("counter.big-win");
    expect(firstCounter.stop).toHaveBeenCalledTimes(1);
    expect(firstCounter.stop.mock.calls[0]?.[0]).toBeCloseTo(2.16);
  });

  it("uses the captured HP1 and HP2 gains", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(backend);
    backend.playOneShot("symbol.hp1");
    backend.playOneShot("symbol.hp2");
    expect(voiceGains(recording)).toEqual([0.32, 1.18]);
  });

  it("replaces every captured single-layer ordinary symbol sting by title", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(backend);

    for (const cue of [
      "symbol.lp1",
      "symbol.lp2",
      "symbol.mp2",
      "symbol.hp1",
      "symbol.hp2",
    ] as const satisfies readonly OneShotAudioCue[]) {
      const firstIndex = recording.sources.length;
      backend.playOneShot(cue);
      const first = recording.sources[firstIndex]!;
      backend.playOneShot(cue);
      expect(first.stop, cue).toHaveBeenLastCalledWith(2);
    }
  });

  it("keeps repeated ScatterWin sources overlapping as the authored false counterexample", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(backend);

    backend.playOneShot("symbol.scatter-win");
    const first = recording.sources[0]!;
    backend.playOneShot("symbol.scatter-win");

    expect(first.stop).not.toHaveBeenCalled();
    expect(playbackOffsets(recording)).toEqual([182.5, 182.5]);
    expect(voiceGains(recording)).toEqual([1.13, 1.13]);
  });

  it("lets MP2 replace the preceding ScatterWin source sharing its title", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(backend);

    backend.playOneShot("symbol.scatter-win");
    const scatter = recording.sources[0]!;
    backend.playOneShot("symbol.mp2");

    expect(scatter.stop).toHaveBeenLastCalledWith(2);
    expect(playbackOffsets(recording)).toEqual([182.5, 182.5]);
    expect(voiceGains(recording)).toEqual([1.13, 1.32]);
  });

  it("replaces all three MP1 layers without changing their gain, delay, or offset", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await unlockWithBackground(backend);

    backend.playOneShot("symbol.mp1");
    const firstLayers = recording.sources.slice(0, 3);
    backend.playOneShot("symbol.mp1");

    expect(firstLayers).toHaveLength(3);
    for (const source of firstLayers) expect(source.stop).toHaveBeenLastCalledWith(2);
    expect(playbackOffsets(recording)).toEqual([
      179.5, 178, 181.5,
      179.5, 178, 181.5,
    ]);
    expect(playbackTimes(recording)).toEqual([2, 2.15, 2, 2, 2.15, 2]);
    expect(voiceGains(recording)).toEqual([0.52, 0.68, 0.26, 0.52, 0.68, 0.26]);
  });

  it("dispatches the authored gorilla action groups at their captured offsets", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
      random: () => 0,
    });
    await unlockWithBackground(backend);

    backend.playOneShot("monster.roar");
    backend.playOneShot("monster.roar-hit");
    backend.playOneShot("monster.sniff");
    backend.playOneShot("monster.thump-expand");
    backend.playOneShot("monster.reel-stretch");
    backend.playOneShot("monster.feature-activate");

    const starts = recording.sources.map((source) => source.start.mock.calls[0]?.[1] as number);
    expect(starts).toEqual([235, 23, 50.5, 80.5, 229.5, 214, 18.8]);
  });

  it("plays ReelStart randomly, sequences one-shot ReelLoop tails, and quick-stops by variant", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
      random: () => 0,
    });
    await unlockWithBackground(backend);

    backend.startLoop("reel.motor");
    backend.startLoop("reel.motor");
    expect(recording.sources).toHaveLength(2);
    expect(recording.sources[0]?.start.mock.calls[0]?.[1]).toBeCloseTo(21.5);
    expect(recording.sources[1]?.start.mock.calls[0]?.[1]).toBeCloseTo(193.6);
    expect(recording.sources[1]?.loop).toBe(false);
    expect(recording.sources[1]?.start.mock.calls[0]?.[2]).toBeCloseTo(3.133333, 5);
    backend.quickStopReelMotor();
    expect(recording.sources[0]?.stop).not.toHaveBeenCalled();
    expect(recording.sources[1]?.stop.mock.calls[0]?.[0]).toBeCloseTo(2.51);
    backend.stopLoop("reel.motor", 0);

    backend.startLoop("reel.motor");
    expect(recording.sources[2]?.start.mock.calls[0]?.[1]).toBeCloseTo(21.5);
    expect(recording.sources[3]?.start.mock.calls[0]?.[1]).toBeCloseTo(198.1);
    backend.quickStopReelMotor();
    expect(recording.sources[3]?.stop.mock.calls[0]?.[0]).toBeCloseTo(2.91);
    backend.stopLoop("reel.motor", 0);

    backend.startLoop("reel.motor");
    expect(recording.sources[4]?.start.mock.calls[0]?.[1]).toBeCloseTo(21.5);
    expect(recording.sources[5]?.start.mock.calls[0]?.[1]).toBeCloseTo(202.6);
    backend.quickStopReelMotor();
    expect(recording.sources[5]?.stop.mock.calls[0]?.[0]).toBeCloseTo(3.21);
    backend.stopLoop("reel.motor", 0);

    // 源端 randomexclusive 策略允许 ReelStart 重复播放。
    expect(playbackOffsets(recording).filter((_, index) => index % 2 === 0)).toEqual([21.5, 21.5, 21.5]);
  });

  it("exposes ReelStart and first-reel ReelLoop as separate event programs", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
      random: () => 0,
    });
    await unlockWithBackground(backend);

    backend.playOneShot("reel.start");
    expect(playbackOffsets(recording)).toEqual([21.5]);
    backend.startLoop("reel.loop");
    expect(playbackOffsets(recording)).toEqual([21.5, 193.6]);
    expect(recording.sources[1]?.loop).toBe(false);
  });

  it("lets a normal ReelLoop tail finish while releasing the next-round guard", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
      random: () => 0,
    });
    await unlockWithBackground(backend);

    backend.startLoop("reel.motor");
    backend.finishReelMotorNaturally();
    expect(recording.sources[0]?.stop).not.toHaveBeenCalled();
    expect(recording.sources[1]?.stop).not.toHaveBeenCalled();

    backend.startLoop("reel.motor");
    expect(recording.sources).toHaveLength(4);
  });

  it("builds synchronized two-stem base music and exact free-spin music loops", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await backend.unlock();

    backend.startLoop("ambient.city");
    expect(recording.sources).toHaveLength(2);
    expect(playbackTimes(recording).slice(0, 2)).toEqual([2, 2]);
    expect(recording.sources[0]?.start.mock.calls[0]?.[1]).toBeCloseTo(1);
    expect(recording.sources[1]?.start.mock.calls[0]?.[1]).toBeCloseTo(56.5);
    expect(recording.sources.every((source) => source.loop)).toBe(true);

    const baseLevel1Gain = recording.gains[1]?.gain;
    const baseLevel2Gain = recording.gains[2]?.gain;
    expect(baseLevel1Gain?.setValueAtTime).toHaveBeenCalledWith(0, 2);
    expect(baseLevel1Gain?.linearRampToValueAtTime).toHaveBeenCalledWith(0.34, 4);
    expect(baseLevel2Gain?.setValueAtTime).toHaveBeenCalledWith(0, 2);
    expect(baseLevel2Gain?.linearRampToValueAtTime).not.toHaveBeenCalled();
    backend.setBaseMusicStemLevel(1, 2_000);
    expect(baseLevel1Gain?.linearRampToValueAtTime.mock.calls.at(-1)).toEqual([0, 4]);
    expect(baseLevel2Gain?.linearRampToValueAtTime.mock.calls.at(-1)).toEqual([0.34, 4]);
    // 对接只会改变增益：两个源节点会继续保持同相运行。
    backend.setBaseMusicStemLevel(null, 2_000);
    expect(baseLevel1Gain?.linearRampToValueAtTime.mock.calls.at(-1)).toEqual([0, 4]);
    expect(baseLevel2Gain?.linearRampToValueAtTime.mock.calls.at(-1)).toEqual([0, 4]);
    expect(recording.sources[0]?.stop).not.toHaveBeenCalled();
    expect(recording.sources[1]?.stop).not.toHaveBeenCalled();

    backend.startLoop("music.free-spins");
    expect(recording.sources).toHaveLength(3);
    expect(recording.sources[2]?.start.mock.calls[0]?.[1]).toBeCloseTo(133);
    expect(recording.sources[2]?.loop).toBe(true);
    const freeSpinGain = recording.gains[3]?.gain;
    expect(freeSpinGain?.setValueAtTime).toHaveBeenCalledWith(0, 2);
    expect(freeSpinGain?.linearRampToValueAtTime).toHaveBeenCalledWith(0.26, 3);

    backend.playOneShot("free-spins.loop-end");
    const firstLoopEnd = recording.sources.at(-1);
    expect(firstLoopEnd?.start.mock.calls[0]?.[1]).toBeCloseTo(183.5);
    backend.playOneShot("free-spins.loop-end");
    expect(firstLoopEnd?.stop).toHaveBeenCalledWith(2);
    backend.playOneShot("free-spins.outro");
    expect(playbackOffsets(recording).slice(-2)).toEqual([183.5, 220]);
    expect(voiceGains(recording).slice(-3)).toEqual([0.32, 0.32, 0.32]);
  });

  it("keeps one authored initial Base fade when driven through AudioManager", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });

    manager.setAmbientEnabled(true);
    await manager.unlock();

    expect(recording.sources).toHaveLength(2);
    expect(playbackTimes(recording)).toEqual([2, 2]);
    const level1Gain = recording.gains[1]?.gain;
    const level2Gain = recording.gains[2]?.gain;
    expect(level1Gain?.setValueAtTime.mock.calls).toEqual([[0, 2]]);
    expect(level1Gain?.linearRampToValueAtTime.mock.calls).toEqual([[0.34, 4]]);
    expect(level1Gain?.cancelScheduledValues).not.toHaveBeenCalled();
    expect(level2Gain?.setValueAtTime.mock.calls).toEqual([[0, 2]]);
    expect(level2Gain?.linearRampToValueAtTime).not.toHaveBeenCalled();
    expect(level2Gain?.cancelScheduledValues).not.toHaveBeenCalled();

    manager.setAmbientEnabled(true);
    expect(recording.sources).toHaveLength(2);
    expect(level1Gain?.linearRampToValueAtTime.mock.calls).toEqual([[0.34, 4]]);
    expect(level2Gain?.linearRampToValueAtTime).not.toHaveBeenCalled();
    manager.destroy();
  });

  it("restores the selected Base stem atomically after Free Spins", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    manager.setAmbientEnabled(true);
    await manager.unlock();

    manager.setFreeSpinsMusicEnabled(true);
    manager.setFreeSpinsMusicEnabled(false, {}, false);
    const sourceCountBeforeBaseReturn = recording.sources.length;
    manager.endFreeSpinsMode();

    expect(recording.sources).toHaveLength(sourceCountBeforeBaseReturn + 2);
    expect(playbackOffsets(recording).slice(-2)).toEqual([1, 56.5]);
    expect(playbackTimes(recording).slice(-2)).toEqual([2, 2]);
    const restoredLevel1Gain = recording.gains.at(-2)?.gain;
    const restoredLevel2Gain = recording.gains.at(-1)?.gain;
    expect(restoredLevel1Gain?.setValueAtTime.mock.calls).toEqual([[0, 2]]);
    expect(restoredLevel1Gain?.linearRampToValueAtTime.mock.calls).toEqual([[0.34, 4]]);
    expect(restoredLevel2Gain?.setValueAtTime.mock.calls).toEqual([[0, 2]]);
    expect(restoredLevel2Gain?.linearRampToValueAtTime).not.toHaveBeenCalled();
    manager.destroy();
  });

  it("keeps the captured asymmetric Base-stem tail at Free Spins entry", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await backend.unlock();

    backend.startLoop("ambient.city");
    const level1 = recording.sources[0];
    const level2 = recording.sources[1];
    const level1Gain = recording.gains[1]?.gain;
    const level2Gain = recording.gains[2]?.gain;

    backend.enterFreeSpinsBaseMusic(2_000, 120);

    expect(level1Gain?.linearRampToValueAtTime.mock.calls).toContainEqual([0, 4]);
    expect(level1Gain?.linearRampToValueAtTime.mock.calls.at(-1)).toEqual([0, 2.12]);
    expect(level2Gain?.linearRampToValueAtTime.mock.calls.at(-1)).toEqual([0, 4]);
    expect(level1?.stop).toHaveBeenCalledWith(2.13);
    expect(level2?.stop).not.toHaveBeenCalled();

    backend.startLoop("ambient.city");
    expect(recording.sources).toHaveLength(4);
    expect(recording.sources[2]?.start.mock.calls[0]?.[1]).toBeCloseTo(1);
    expect(recording.sources[3]?.start.mock.calls[0]?.[1]).toBeCloseTo(56.5);
    expect(playbackTimes(recording).slice(-2)).toEqual([2, 2]);
    expect(level2?.stop).toHaveBeenCalledWith(2);
  });

  it("mutes only the master gain while preserving active loop and one-shot sources", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await backend.unlock();

    backend.startLoop("ambient.city");
    backend.playOneShot("intro.game");
    const activeSources = [...recording.sources];
    const startCounts = activeSources.map((source) => source.start.mock.calls.length);
    const stopCounts = activeSources.map((source) => source.stop.mock.calls.length);

    backend.setMuted(true);
    backend.playOneShot("wheel.appear");
    const mutedSource = recording.sources.at(-1);
    backend.setMuted(false);

    expect(activeSources.map((source) => source.start.mock.calls.length)).toEqual(startCounts);
    expect(activeSources.map((source) => source.stop.mock.calls.length)).toEqual(stopCounts);
    expect(mutedSource?.start).toHaveBeenCalledTimes(1);
    expect(recording.sources).toHaveLength(activeSources.length + 1);
    const masterGain = recording.gains[0]?.gain;
    expect(masterGain?.setTargetAtTime.mock.calls.slice(-2)).toEqual([
      [0, 2, 0.01],
      [0.7, 2, 0.3],
    ]);
  });

  it("starts Base, Free Spins, Wheel, and Big Win sources behind master zero", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    backend.setMuted(true);
    await backend.unlock();

    backend.startLoop("ambient.city");
    backend.startLoop("music.free-spins");
    backend.startLoop("wheel.wait");
    backend.startLoop("music.big-win");
    const sources = [...recording.sources];
    expect(recording.gains[0]?.gain.value).toBe(0);
    expect(sources).toHaveLength(5);
    expect(sources.every((source) => source.start.mock.calls.length === 1)).toBe(true);

    backend.setMuted(false);
    expect(recording.sources).toEqual(sources);
    expect(sources.every((source) => source.start.mock.calls.length === 1)).toBe(true);
  });

  it("suspends and resumes the same sources without release or restart", async () => {
    const recording = recordingAudioContext();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback: null,
    });
    await backend.unlock();
    backend.startLoop("ambient.city");
    backend.startLoop("music.free-spins");
    const sources = [...recording.sources];

    await backend.suspend();
    expect(recording.suspend).toHaveBeenCalledTimes(1);
    expect(sources.every((source) => source.stop.mock.calls.length === 0)).toBe(true);
    await expect(backend.unlock()).resolves.toBe(true);
    expect(recording.resume).toHaveBeenCalledTimes(2);
    expect(recording.sources).toEqual(sources);
    expect(sources.every((source) => source.start.mock.calls.length === 1)).toBe(true);
  });

  it("keeps unresolved live SoundStage titles silent instead of substituting audio", async () => {
    const recording = recordingAudioContext();
    const fallback = new RecordingFallback();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback,
    });

    // 无操作契约在样本就绪前后均适用；既不能播放程序化降级音效，也不能播放
    // 临近的捕获切片。
    backend.playOneShot("symbol.wild");
    backend.playOneShot("free-spins.music-end");
    backend.playOneShot("wheel.king-spin-won");
    backend.playOneShot("wheel.kong-quest-won");
    expect(fallback.oneShots).toEqual([]);

    await unlockWithBackground(backend);
    backend.playOneShot("symbol.wild");
    backend.playOneShot("free-spins.music-end");
    backend.playOneShot("wheel.king-spin-won");
    backend.playOneShot("wheel.kong-quest-won");
    expect(recording.sources).toEqual([]);
    expect(fallback.oneShots).toEqual([]);
  });

  it("keeps captured semantics silent when native assets cannot be decoded", async () => {
    const recording = recordingAudioContext({ decodeFails: true });
    const fallback = new RecordingFallback();
    const backend = new PrimalSpriteAudioBackend({
      contextFactory: () => recording.context,
      fetcher: successfulFetcher(),
      fallback,
    });

    // 程序化降级音效无法替代预设的 10.086s 入场音效，因此原生 sprite 解码失败时，
    // 不得将启动门控释放为就绪状态。
    await expect(backend.unlock()).resolves.toBe(false);
    expect(recording.decodeAudioData).toHaveBeenCalledTimes(4);
    expect(() => backend.playOneShot("ui.click", { intensity: 0.4 })).not.toThrow();
    expect(fallback.oneShots).toEqual([]);

    backend.startLoop("ambient.city");
    expect(fallback.loops).toEqual([]);
    backend.setBaseMusicStemLevel(null, 2_000);
    expect(fallback.stopped).toEqual([]);
    backend.setBaseMusicStemLevel(0, 2_000);
    expect(fallback.loops).toEqual([]);
    backend.stopLoop("ambient.city", 180);
    expect(fallback.stopped).toEqual([]);

    backend.setMuted(true);
    expect(fallback.muted).toEqual([]);
    await backend.suspend();
    expect(recording.suspend).toHaveBeenCalledTimes(1);
    expect(fallback.suspendCalls).toBe(0);
    await backend.destroy();
    await backend.destroy();
    expect(recording.close).toHaveBeenCalledTimes(1);
    expect(fallback.destroyCalls).toBe(1);
    expect(backend.state).toBe("closed");
  });
});
