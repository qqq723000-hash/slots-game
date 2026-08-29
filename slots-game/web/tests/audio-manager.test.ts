import { describe, expect, it, vi } from "vitest";
import {
  AUDIO_PREFERENCE_KEY,
  AudioManager,
  parseAudioPreferences,
  type AudioBackend,
  type AudioBackendState,
  type BaseMusicStemLevel,
  type AudioCueOptions,
  type AudioPreferenceStorage,
  type LoopAudioCue,
  type OneShotAudioCue,
} from "../src/audio/AudioManager";

class RecordingBackend implements AudioBackend {
  available = true;
  state: AudioBackendState = "locked";
  launchPrimeCalls = 0;
  unlockCalls = 0;
  suspendCalls = 0;
  destroyCalls = 0;
  readonly mutedValues: boolean[] = [];
  readonly oneShots: Array<{ cue: OneShotAudioCue; options?: AudioCueOptions }> = [];
  readonly stoppedOneShots: Array<{ cue: OneShotAudioCue; fadeMs?: number }> = [];
  readonly startedLoops: Array<{ cue: LoopAudioCue; options?: AudioCueOptions }> = [];
  readonly stoppedLoops: Array<{ cue: LoopAudioCue; fadeMs?: number }> = [];
  readonly baseStemChanges: Array<{ level: BaseMusicStemLevel | null; fadeMs?: number }> = [];
  readonly freeSpinBaseEntries: Array<{ dockFadeMs?: number; levelOneStopFadeMs?: number }> = [];
  quickStopCalls = 0;
  naturalFinishCalls = 0;
  readonly unlockResults: boolean[] = [true];
  throwOnPlay = false;

  async primeForLaunch(): Promise<void> {
    this.launchPrimeCalls += 1;
  }

  async unlock(): Promise<boolean> {
    this.unlockCalls += 1;
    const unlocked = this.unlockResults.shift() ?? true;
    this.state = unlocked ? "running" : "locked";
    return unlocked;
  }

  setMuted(muted: boolean): void {
    this.mutedValues.push(muted);
  }

  playOneShot(cue: OneShotAudioCue, options?: AudioCueOptions): void {
    if (this.throwOnPlay) throw new Error("synthetic voice failed");
    this.oneShots.push({ cue, options });
  }

  stopOneShot(cue: OneShotAudioCue, fadeMs?: number): void {
    this.stoppedOneShots.push({ cue, fadeMs });
  }

  startLoop(cue: LoopAudioCue, options?: AudioCueOptions): void {
    this.startedLoops.push({ cue, options });
  }

  stopLoop(cue: LoopAudioCue, fadeMs?: number): void {
    this.stoppedLoops.push({ cue, fadeMs });
  }

  setBaseMusicStemLevel(level: BaseMusicStemLevel | null, fadeMs?: number): void {
    this.baseStemChanges.push({ level, fadeMs });
  }

  enterFreeSpinsBaseMusic(dockFadeMs?: number, levelOneStopFadeMs?: number): void {
    this.freeSpinBaseEntries.push({ dockFadeMs, levelOneStopFadeMs });
  }

  quickStopReelMotor(): void {
    this.quickStopCalls += 1;
  }

  finishReelMotorNaturally(): void {
    this.naturalFinishCalls += 1;
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

class AtomicBaseMusicBackend extends RecordingBackend {
  readonly baseProgramStarts: Array<{
    level: BaseMusicStemLevel | null;
    fadeMs?: number;
    options?: AudioCueOptions;
  }> = [];

  startBaseMusicProgram(
    level: BaseMusicStemLevel | null,
    fadeMs?: number,
    options?: AudioCueOptions,
  ): void {
    this.baseProgramStarts.push({ level, fadeMs, options });
    this.startLoop("ambient.city", options);
  }
}

class MemoryStorage implements AudioPreferenceStorage {
  readonly values = new Map<string, string>();
  throwOnRead = false;
  throwOnWrite = false;

  getItem(key: string): string | null {
    if (this.throwOnRead) throw new Error("storage denied");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.throwOnWrite) throw new Error("storage denied");
    this.values.set(key, value);
  }
}

class FakeVisibility extends EventTarget {
  hidden = false;

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

async function flushLifecycle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe("AudioManager", () => {
  it("treats a backend without native predecode support as a safe prime no-op", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });

    await expect(manager.prime()).resolves.toBeUndefined();
    expect(backend.unlockCalls).toBe(0);
    expect(backend.state).toBe("locked");
  });

  it("deduplicates strict launch priming and propagates failures without unlocking", async () => {
    const backend = new RecordingBackend();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const strict = vi.spyOn(backend, "primeForLaunch").mockImplementation(() => {
      backend.launchPrimeCalls += 1;
      return pending;
    });
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });

    const first = manager.primeForLaunch();
    const duplicate = manager.primeForLaunch();
    expect(duplicate).toBe(first);
    await Promise.resolve();
    expect(backend.launchPrimeCalls).toBe(1);
    expect(backend.unlockCalls).toBe(0);

    release();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([undefined, undefined]);
    expect(backend.state).toBe("locked");

    const failure = new Error("delayed pack decode failed");
    strict.mockRejectedValueOnce(failure);
    await expect(manager.primeForLaunch()).rejects.toBe(failure);
    expect(backend.unlockCalls).toBe(0);
  });

  it("fails closed when a backend has no strict launch-preload capability", async () => {
    const backend = new RecordingBackend();
    Object.defineProperty(backend, "primeForLaunch", { value: undefined });
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });

    await expect(manager.primeForLaunch()).rejects.toMatchObject({
      name: "AudioLaunchPreloadUnavailableError",
    });
    expect(backend.unlockCalls).toBe(0);
  });

  it("accepts semantic events while locked without replaying them after unlock", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });

    expect(backend.unlockCalls).toBe(0);
    manager.playCue("ui.click");
    manager.startReelMotor();
    expect(backend.oneShots.map(({ cue }) => cue)).toEqual(["ui.click"]);
    expect(backend.startedLoops.map(({ cue }) => cue)).toEqual(["reel.motor"]);

    // Ambient 是明确的场景状态，并非过期的单次音效，因此可以预备播放。 / English: Ambient is a clear scene state, not an expired single-shot sound effect, so it can be ready to play.
    manager.setAmbientEnabled(true);
    expect(backend.startedLoops.map(({ cue }) => cue)).toEqual(["reel.motor", "ambient.city"]);
    await expect(manager.unlock()).resolves.toBe(true);
    expect(backend.startedLoops.map(({ cue }) => cue)).toEqual(["reel.motor", "ambient.city"]);

    manager.playCue("ui.click");
    manager.startReelMotor();
    expect(backend.oneShots.map(({ cue }) => cue)).toEqual(["ui.click", "ui.click"]);
    expect(backend.startedLoops.map(({ cue }) => cue)).toEqual(["reel.motor", "ambient.city"]);
  });

  it("forwards semantic feature cues through normalized one-shot options", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    await expect(manager.unlock()).resolves.toBe(true);

    manager.playEnergyCollect({ delayMs: 18, pan: -0.3, intensity: 0.42, reducedMotion: true });
    manager.playWheelSpin({ pan: 4, intensity: 2 });
    manager.playWheelKingSpinWon();
    manager.playWheelKongQuestWon();
    manager.playFeatureStart();

    expect(backend.oneShots).toEqual([
      {
        cue: "energy.collect",
        options: { delayMs: 18, pan: -0.3, intensity: 0.42, reducedMotion: true },
      },
      {
        cue: "wheel.spin",
        options: { delayMs: 0, pan: 1, intensity: 1, reducedMotion: false },
      },
      {
        cue: "wheel.king-spin-won",
        options: { delayMs: 0, pan: 0, intensity: 1, reducedMotion: false },
      },
      {
        cue: "wheel.kong-quest-won",
        options: { delayMs: 0, pan: 0, intensity: 1, reducedMotion: false },
      },
      {
        cue: "feature.start",
        options: { delayMs: 0, pan: 0, intensity: 1, reducedMotion: false },
      },
    ]);
  });

  it("keeps every authored ReelStop centred instead of panning by reel", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    await expect(manager.unlock()).resolves.toBe(true);

    manager.playReelStop(0);
    manager.playReelStop(2, { pan: 0.9, intensity: 0.8 });

    expect(backend.oneShots).toEqual([
      {
        cue: "reel.stop",
        options: { delayMs: 0, pan: 0, intensity: 1, reducedMotion: false },
      },
      {
        cue: "reel.stop",
        options: { delayMs: 0, pan: 0, intensity: 0.8, reducedMotion: false },
      },
    ]);
  });

  it("exposes distinct captured UI panel open and close cues", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    await expect(manager.unlock()).resolves.toBe(true);

    manager.playUiOpen({ intensity: 0.8 });
    manager.playUiClose({ delayMs: 12 });

    expect(backend.oneShots).toEqual([
      {
        cue: "ui.open",
        options: { delayMs: 0, pan: 0, intensity: 0.8, reducedMotion: false },
      },
      {
        cue: "ui.close",
        options: { delayMs: 12, pan: 0, intensity: 1, reducedMotion: false },
      },
    ]);
  });

  it("exposes captured landing, PPS, Vault, jackpot, and payout buckets", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    await manager.unlock();

    manager.playScatterLand(3, { delayMs: 18, pan: -0.34, intensity: 0.8, reducedMotion: true });
    manager.playWildLand({ delayMs: 24, pan: 0.34, intensity: 0.7 });
    manager.playPpsLevel(5);
    manager.playSymbolWin("scatter-win");
    manager.playWinLossOrEqual();
    manager.playMonsterThump();
    manager.playVaultUnlock(1, { delayMs: 500 });
    manager.playVaultUnlock(2, { delayMs: 500 });
    manager.playVaultUnlock(7, { delayMs: 500 });
    manager.playVaultUnlock(0);
    manager.playJackpotPot("mega");
    manager.playPayoutWin(8);

    expect(backend.oneShots.map(({ cue }) => cue)).toEqual([
      "symbol.scatter-land-3",
      "symbol.wild-land",
      "pps.level-5",
      "symbol.scatter-win",
      "win.loss-or-equal",
      "monster.impact",
      "vault.unlock-1",
      "vault.unlock-2",
      "vault.unlock-3-plus",
      "jackpot.mega",
      "payout.win-8",
    ]);
    expect(backend.oneShots[0]).toEqual({
      cue: "symbol.scatter-land-3",
      options: { delayMs: 18, pan: 0, intensity: 0.8, reducedMotion: true },
    });
    expect(backend.oneShots[1]).toEqual({
      cue: "symbol.wild-land",
      options: { delayMs: 24, pan: 0, intensity: 0.7, reducedMotion: false },
    });
    expect(backend.oneShots[6]?.options).toMatchObject({ delayMs: 500 });
  });

  it("owns the Wheel wait loop and exact Vault anticipation/fly semantics", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    await manager.unlock();

    manager.playWheelAppear();
    manager.playWheelPanelIn();
    expect(backend.oneShots.slice(-2).map(({ cue }) => cue)).toEqual([
      "wheel.appear",
      "wheel.panel-in",
    ]);
    manager.startWheelWait({ intensity: 1 });
    manager.playVaultAnticipation();
    manager.playVaultFly();
    manager.stopWheelWait(200);

    expect(backend.startedLoops.at(-1)?.cue).toBe("wheel.wait");
    expect(backend.oneShots.slice(-2).map(({ cue }) => cue)).toEqual([
      "vault.anticipation",
      "vault.fly",
    ]);
    expect(backend.stoppedLoops.at(-1)).toEqual({ cue: "wheel.wait", fadeMs: 200 });
  });

  it("delegates quick-stop without treating ReelStart as part of the fade", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    await manager.unlock();
    manager.startReelMotor();

    manager.quickStopReelMotor();
    expect(backend.quickStopCalls).toBe(1);

    manager.stopReelMotor(110);
    expect(backend.stoppedLoops).toEqual([]);
  });

  it("keeps SPIN_START ReelStart separate from reel-0 STARTING ReelLoop", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    await manager.unlock();

    manager.playReelStart({ intensity: 0.8 });
    expect(backend.oneShots.at(-1)).toMatchObject({
      cue: "reel.start",
      options: { intensity: 0.8 },
    });
    expect(backend.startedLoops).toEqual([]);
    manager.startReelLoop();
    expect(backend.startedLoops.at(-1)?.cue).toBe("reel.loop");
    manager.quickStopReelLoop();
    expect(backend.quickStopCalls).toBe(1);
  });

  it("releases a normal ReelLoop without truncating its authored one-shot tail", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    await manager.unlock();
    manager.startReelMotor();

    manager.finishReelMotorNaturally();
    expect(backend.naturalFinishCalls).toBe(1);
    expect(backend.stoppedLoops).toEqual([]);

    // 所有权已经释放，因此后续回合可以启动一组新的配对音轨。 / English: Ownership has been released so subsequent rounds can launch a new set of paired tracks.
    manager.startReelMotor();
    expect(backend.startedLoops.filter(({ cue }) => cue === "reel.motor")).toHaveLength(2);
  });

  it("uses distinct FREESPIN_INTRO, SUMMARY, and FREESPIN_END music boundaries", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    manager.setAmbientEnabled(true);
    await manager.unlock();

    manager.setFreeSpinsMusicEnabled(true, { intensity: 1 });
    expect(backend.freeSpinBaseEntries).toEqual([{
      dockFadeMs: 2_000,
      levelOneStopFadeMs: 120,
    }]);
    expect(backend.stoppedLoops).not.toContainEqual({ cue: "ambient.city", fadeMs: 120 });
    expect(backend.startedLoops.map(({ cue }) => cue)).toEqual([
      "ambient.city",
      "music.free-spins",
    ]);

    manager.setFreeSpinsMusicEnabled(false, { intensity: 1 });
    expect(backend.stoppedLoops).toContainEqual({ cue: "music.free-spins", fadeMs: 1_500 });
    expect(backend.oneShots.slice(-2).map(({ cue }) => cue)).toEqual([
      "free-spins.loop-end",
      "free-spins.outro",
    ]);
    expect(backend.oneShots.at(-1)?.cue).toBe("free-spins.outro");
    expect(backend.startedLoops.at(-1)?.cue).toBe("music.free-spins");

    manager.endFreeSpinsMode({ intensity: 1 });
    expect(backend.startedLoops.at(-1)).toMatchObject({
      cue: "ambient.city",
      options: { delayMs: 0, intensity: 1 },
    });
    expect(backend.baseStemChanges.at(-1)).toEqual({ level: 0, fadeMs: 2_000 });
  });

  it("does not rewrite the Base stem fade when launch reconciliation repeats", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    await manager.unlock();

    manager.setAmbientEnabled(true);
    const firstAutomationCount = backend.baseStemChanges.length;
    manager.setAmbientEnabled(true);

    expect(backend.startedLoops.filter(({ cue }) => cue === "ambient.city")).toHaveLength(1);
    expect(backend.baseStemChanges).toHaveLength(firstAutomationCount);
  });

  it("does not cancel an atomic backend's authored initial Base fade", async () => {
    const backend = new AtomicBaseMusicBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    await manager.unlock();

    manager.setAmbientEnabled(true);

    expect(backend.startedLoops.filter(({ cue }) => cue === "ambient.city")).toHaveLength(1);
    expect(backend.baseProgramStarts).toEqual([{
      level: 0,
      fadeMs: 2_000,
      options: { delayMs: 0, intensity: 1, pan: 0, reducedMotion: false },
    }]);
    expect(backend.baseStemChanges).toEqual([]);

    // 后续自适应转换仍归管理器所有。 / English: Subsequent adaptive transformations remain owned by the manager.
    manager.beginBaseMusicRound("100");
    manager.recordBaseMusicRoundOutcome("200");
    expect(backend.baseStemChanges).toEqual([{ level: 1, fadeMs: 2_000 }]);
    manager.destroy();
  });

  it("keeps the manager-applied initial Base stem for generic backends", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    await manager.unlock();

    manager.setAmbientEnabled(true);

    expect(backend.baseStemChanges).toEqual([{ level: 0, fadeMs: 2_000 }]);
    manager.destroy();
  });

  it("ends Free Spins without a panel cue when the summary eligibility gate fails", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    await manager.unlock();
    manager.setFreeSpinsMusicEnabled(true);

    manager.setFreeSpinsMusicEnabled(false, { intensity: 1 }, false);
    expect(backend.oneShots.slice(-2).map(({ cue }) => cue)).toEqual([
      "free-spins.loop-end",
      "free-spins.music-end",
    ]);
    expect(backend.oneShots.at(-1)?.cue).toBe("free-spins.music-end");
    manager.setFreeSpinsMusicEnabled(false, { intensity: 1 }, false);
    expect(backend.oneShots.filter(({ cue }) => cue === "free-spins.loop-end")).toHaveLength(1);
  });

  it("ends Free Spins for Big Win, restarts it, then ends summary and restores Base", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    await manager.unlock();
    manager.setFreeSpinsMusicEnabled(true);

    manager.beginBigWin(true);
    expect(backend.stoppedLoops).toContainEqual({ cue: "music.free-spins", fadeMs: 1_500 });
    expect(backend.oneShots.filter(({ cue }) => cue === "free-spins.loop-end")).toHaveLength(1);
    manager.endBigWin("free-spins");
    expect(backend.startedLoops.filter(({ cue }) => cue === "music.free-spins")).toHaveLength(2);

    manager.setFreeSpinsMusicEnabled(false);
    expect(backend.oneShots.filter(({ cue }) => cue === "free-spins.loop-end")).toHaveLength(2);
    expect(backend.oneShots.at(-1)?.cue).toBe("free-spins.outro");
    manager.endFreeSpinsMode();
    expect(backend.startedLoops.map(({ cue }) => cue)).toEqual([
      "music.free-spins",
      "music.big-win",
      "music.free-spins",
      "ambient.city",
    ]);
    expect(backend.baseStemChanges.at(-1)).toEqual({ level: 0, fadeMs: 2_000 });
  });

  it("drives the phase-locked Base stem from the captured adaptive music pot", async () => {
    vi.useFakeTimers();
    try {
      const backend = new RecordingBackend();
      const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
      manager.setAmbientEnabled(true);
      await manager.unlock();
      backend.baseStemChanges.splice(0);

      manager.beginBaseMusicRound("100");
      manager.recordBaseMusicRoundOutcome("200");
      expect(backend.baseStemChanges.at(-1)).toEqual({ level: 1, fadeMs: 2_000 });
      manager.endBaseMusicRound();

      manager.beginBigWin(false);
      expect(backend.baseStemChanges.at(-1)).toEqual({ level: null, fadeMs: 2_000 });
      manager.endBigWin("ambient");
      expect(backend.baseStemChanges.at(-1)).toEqual({ level: 1, fadeMs: 2_000 });

      vi.advanceTimersByTime(4_999);
      expect(backend.baseStemChanges.at(-1)?.level).toBe(1);
      vi.advanceTimersByTime(1);
      expect(backend.baseStemChanges.at(-1)).toEqual({ level: 0, fadeMs: 2_000 });
      manager.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("owns the captured Big Win music and counter lifecycle", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    manager.setAmbientEnabled(true);
    await manager.unlock();

    manager.beginBigWin(false, { intensity: 1 });
    expect(backend.stoppedLoops).not.toContainEqual({ cue: "ambient.city", fadeMs: 350 });
    expect(backend.baseStemChanges.at(-1)).toEqual({ level: null, fadeMs: 2_000 });
    expect(backend.oneShots.at(-1)?.cue).toBe("big-win.trigger");
    expect(backend.startedLoops.at(-1)?.cue).toBe("music.big-win");

    manager.beginBigWinCounter({ intensity: 1 });
    expect(backend.oneShots.slice(-2).map(({ cue }) => cue)).toEqual([
      "big-win.counter-start",
      "big-win.counter-sweetener",
    ]);
    expect(backend.startedLoops.at(-1)?.cue).toBe("counter.big-win");
    manager.playBigWinLevelUp();
    expect(backend.oneShots.at(-1)?.cue).toBe("big-win.level-up");

    manager.endBigWinCounter();
    expect(backend.stoppedLoops).toContainEqual({ cue: "counter.big-win", fadeMs: 150 });
    expect(backend.oneShots.at(-1)?.cue).toBe("big-win.counter-tail");
    manager.endBigWin("ambient");
    expect(backend.stoppedLoops).toContainEqual({ cue: "music.big-win", fadeMs: 0 });
    expect(backend.oneShots.at(-1)?.cue).toBe("big-win.end");
    expect(backend.startedLoops.filter(({ cue }) => cue === "ambient.city")).toHaveLength(1);
    expect(backend.baseStemChanges.at(-1)).toEqual({ level: 0, fadeMs: 2_000 });
  });

  it("runs the exact normal-win dual counter with an immediate sweetener and 300..699ms follow-ups", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999_999);
    try {
      const backend = new RecordingBackend();
      const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
      await manager.unlock();

      manager.beginNormalWinCounter({ intensity: 1 });

      expect(backend.oneShots.map(({ cue }) => cue)).toEqual([
        "normal-win.counter-start",
        "normal-win.counter-sweetener",
      ]);
      expect(backend.startedLoops.map(({ cue }) => cue)).toEqual([
        "counter.normal-generic",
        "counter.normal-common",
      ]);

      vi.advanceTimersByTime(299);
      expect(backend.oneShots).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(backend.oneShots.at(-1)?.cue).toBe("normal-win.counter-sweetener");
      expect(backend.oneShots).toHaveLength(3);

      vi.advanceTimersByTime(698);
      expect(backend.oneShots).toHaveLength(3);
      vi.advanceTimersByTime(1);
      expect(backend.oneShots.at(-1)?.cue).toBe("normal-win.counter-sweetener");
      expect(backend.oneShots).toHaveLength(4);

      manager.endNormalWinCounter({ intensity: 1 });
      expect(backend.stoppedLoops.slice(-2)).toEqual([
        { cue: "counter.normal-generic", fadeMs: 150 },
        { cue: "counter.normal-common", fadeMs: 0 },
      ]);
      expect(backend.oneShots.at(-1)?.cue).toBe("normal-win.counter-tail");

      const oneShotCount = backend.oneShots.length;
      vi.advanceTimersByTime(2_000);
      expect(backend.oneShots).toHaveLength(oneShotCount);

      manager.endNormalWinCounter();
      expect(backend.oneShots).toHaveLength(oneShotCount);
      expect(backend.stoppedLoops).toHaveLength(2);
      manager.destroy();
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("restoring BASE music silently retires a stale Free Spins loop", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    await manager.unlock();
    manager.setFreeSpinsMusicEnabled(true);

    manager.setAmbientEnabled(true);

    expect(backend.stoppedLoops).toContainEqual({ cue: "music.free-spins", fadeMs: 500 });
    expect(backend.startedLoops.at(-1)?.cue).toBe("ambient.city");
    expect(backend.oneShots).toEqual([]);
  });

  it("deduplicates concurrent unlocks and permits a later retry", async () => {
    const backend = new RecordingBackend();
    backend.unlockResults.splice(0, backend.unlockResults.length, false, true);
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });

    const first = manager.unlock();
    const duplicate = manager.unlock();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([false, false]);
    expect(backend.unlockCalls).toBe(1);

    await expect(manager.unlock()).resolves.toBe(true);
    expect(backend.unlockCalls).toBe(2);
  });

  it("does not mistake a running AudioContext for decoded sprite readiness", async () => {
    const backend = new RecordingBackend();
    let releaseUnlock!: (enabled: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      releaseUnlock = resolve;
    });
    vi.spyOn(backend, "unlock").mockImplementation(() => {
      backend.unlockCalls += 1;
    // resume() 会在获取和解码完成前改变此状态。 / English: resume() will change this state before retrieval and decoding are complete.
      backend.state = "running";
      return pending;
    });
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });

    const pointerDownAttempt = manager.unlock();
    const clickAttempt = manager.unlock();

    expect(clickAttempt).toBe(pointerDownAttempt);
    expect(backend.unlockCalls).toBe(1);
    expect(manager.isUnlocked).toBe(false);

    releaseUnlock(true);
    await expect(pointerDownAttempt).resolves.toBe(true);
    expect(manager.isUnlocked).toBe(true);
  });

  it("exposes only a stable read-only launch playback clock", () => {
    const backend = new RecordingBackend() as RecordingBackend & {
      playbackClockMs(): number | null;
    };
    let currentTimeMs = 125;
    backend.playbackClockMs = vi.fn(() => currentTimeMs);
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });

    const clock = manager.getLaunchPlaybackClock();
    expect(clock?.now()).toBe(125);
    currentTimeMs = 750;
    expect(clock?.now()).toBe(750);
    expect(Object.isFrozen(clock)).toBe(true);
    expect(Object.keys(clock ?? {})).toEqual(["now"]);
  });

  it("accepts Continue, intro, and Base while resume is pending without replay", async () => {
    const backend = new RecordingBackend();
    let releaseUnlock!: (enabled: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { releaseUnlock = resolve; });
    vi.spyOn(backend, "unlock").mockImplementation(() => {
      backend.unlockCalls += 1;
      backend.state = "suspended";
      return pending;
    });
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });

    const unlock = manager.unlock();
    manager.playSplashContinue();
    manager.playGameIntro();
    manager.setAmbientEnabled(true);
    expect(backend.oneShots.map(({ cue }) => cue)).toEqual([
      "ui.splash-continue",
      "intro.game",
    ]);
    expect(backend.startedLoops.map(({ cue }) => cue)).toEqual(["ambient.city"]);

    manager.stopGameIntro(200);
    expect(backend.stoppedOneShots).toEqual([{ cue: "intro.game", fadeMs: 200 }]);
    backend.state = "running";
    releaseUnlock(true);
    await expect(unlock).resolves.toBe(true);
    expect(backend.oneShots.map(({ cue }) => cue)).toEqual([
      "ui.splash-continue",
      "intro.game",
    ]);
    expect(backend.startedLoops.map(({ cue }) => cue)).toEqual(["ambient.city"]);
  });

  it("drops a locked wall-clock intro so a later first unlock cannot replay it", async () => {
    const backend = new RecordingBackend();
    backend.state = "suspended";
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });

    manager.playGameIntro({ intensity: 1 }, "wall-clock");

    expect(backend.oneShots).toEqual([]);
    expect(backend.stoppedOneShots).toEqual([{ cue: "intro.game", fadeMs: 0 }]);

    await expect(manager.unlock()).resolves.toBe(true);
    expect(backend.oneShots).toEqual([]);
  });

  it("loads and safely persists a versioned mute preference", async () => {
    const backend = new RecordingBackend();
    const storage = new MemoryStorage();
    storage.values.set(AUDIO_PREFERENCE_KEY, JSON.stringify({ version: 1, muted: true }));
    const manager = new AudioManager({ backend, storage, visibilitySource: null });

    expect(manager.muted).toBe(true);
    expect(backend.mutedValues).toEqual([true]);
    manager.playWin();
    expect(backend.oneShots.map(({ cue }) => cue)).toEqual(["win.sting"]);

    expect(manager.toggleMuted()).toBe(false);
    await flushLifecycle();
    expect(backend.unlockCalls).toBe(1);
    expect(backend.oneShots.map(({ cue }) => cue)).toEqual([
      "win.sting",
      "ui.button-feedback",
    ]);
    expect(storage.values.get(AUDIO_PREFERENCE_KEY)).toBe('{"version":1,"muted":false}');

    storage.throwOnWrite = true;
    expect(() => manager.setMuted(true)).not.toThrow();
    expect(manager.muted).toBe(true);
  });

  it("preserves active loop ownership and playback across mute and unmute", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    manager.setAmbientEnabled(true);
    await manager.unlock();
    manager.startReelMotor();

    manager.setMuted(true);
    expect(backend.stoppedLoops).toEqual([]);

    manager.setMuted(false);
    await flushLifecycle();
    expect(backend.startedLoops.map(({ cue }) => cue)).toEqual(["ambient.city", "reel.motor"]);
    expect(backend.stoppedLoops).toEqual([]);
    expect(backend.mutedValues.slice(-2)).toEqual([true, false]);
  });

  it("dispatches common btnClick feedback in both sound-toggle directions", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: null });
    await manager.unlock();

    expect(manager.toggleMuted()).toBe(true);
    expect(manager.toggleMuted()).toBe(false);
    await flushLifecycle();
    expect(backend.oneShots.map(({ cue }) => cue)).toEqual([
      "ui.button-feedback",
      "ui.button-feedback",
    ]);
    expect(backend.mutedValues.slice(-2)).toEqual([true, false]);
  });

  it("starts previously desired loops when unmuted before the first unlock", async () => {
    const backend = new RecordingBackend();
    const manager = new AudioManager({
      backend,
      storage: null,
      visibilitySource: null,
      initialMuted: true,
    });
    manager.setAmbientEnabled(true);
    expect(backend.startedLoops.map(({ cue }) => cue)).toEqual(["ambient.city"]);

    expect(manager.toggleMuted()).toBe(false);
    await flushLifecycle();

    expect(backend.unlockCalls).toBe(1);
    expect(backend.startedLoops.map(({ cue }) => cue)).toEqual(["ambient.city"]);
    expect(backend.oneShots.map(({ cue }) => cue)).toEqual(["ui.button-feedback"]);
  });

  it("falls back in memory when preference storage is malformed or denied", () => {
    expect(parseAudioPreferences("not json", true)).toEqual({ version: 1, muted: true });
    expect(parseAudioPreferences('{"version":2,"muted":true}', false)).toEqual({ version: 1, muted: false });
    expect(parseAudioPreferences('{"version":1,"muted":false}', true)).toEqual({ version: 1, muted: false });

    const storage = new MemoryStorage();
    storage.throwOnRead = true;
    const manager = new AudioManager({
      backend: new RecordingBackend(),
      storage,
      visibilitySource: null,
      initialMuted: true,
    });
    expect(manager.muted).toBe(true);
  });

  it("suspends hidden-page audio and resumes without rebuilding desired loops", async () => {
    const backend = new RecordingBackend();
    const visibility = new FakeVisibility();
    const manager = new AudioManager({
      backend,
      storage: null,
      visibilitySource: visibility,
      focusSource: visibility,
    });
    manager.setAmbientEnabled(true);
    await manager.unlock();
    manager.startReelMotor();

    visibility.setHidden(true);
    await flushLifecycle();
    expect(backend.stoppedLoops).toEqual([]);
    expect(backend.suspendCalls).toBe(1);

    visibility.setHidden(false);
    await flushLifecycle();
    expect(backend.unlockCalls).toBe(2);
    expect(backend.startedLoops.map(({ cue }) => cue)).toEqual([
      "ambient.city",
      "reel.motor",
    ]);
  });

  it("lets a visible user gesture recover a missed focus event before the first unlock", async () => {
    const backend = new RecordingBackend();
    const page = new FakeVisibility();
    const target = new EventTarget();
    const manager = new AudioManager({
      backend,
      storage: null,
      visibilitySource: page,
      focusSource: page,
    });
    manager.bindUserGestures(target);
    manager.setAmbientEnabled(true);

    // 嵌入式浏览器界面可能在文档仍可见时报告 blur，随后又遗漏对应的 / English: The embedded browser interface may report blur while the document is still visible and subsequently miss the corresponding
    // window focus 事件。下一次真实游戏手势仍是合法的浏览器激活操作， / English: window focus event. The next real game gesture is still a legal browser activation operation,
    // 不得因为过期且仅依据焦点的生命周期状态而被拒绝。 / English: Must not be rejected due to expiration and solely based on the focus's lifecycle state.
    page.dispatchEvent(new Event("blur"));
    await flushLifecycle();
    expect(page.hidden).toBe(false);
    expect(backend.unlockCalls).toBe(0);

    target.dispatchEvent(new Event("pointerdown"));
    target.dispatchEvent(new Event("click"));
    await flushLifecycle();

    expect(backend.unlockCalls).toBe(1);
    expect(backend.state).toBe("running");
    expect(backend.startedLoops.map(({ cue }) => cue)).toEqual(["ambient.city"]);

    // 首次解锁后的同一恢复路径会恢复现有的 context/循环所有权； / English: The same recovery path after first unlocking will restore existing context/loop ownership;
    // pointerdown+click 必须合并为一次 resume，且不得从零采样点重新创建 / English: pointerdown+click must be merged into one resume and must not be re-created from zero sampling point
    // Base 音乐。 / English: Base music.
    page.dispatchEvent(new Event("blur"));
    await flushLifecycle();
    target.dispatchEvent(new Event("pointerdown"));
    target.dispatchEvent(new Event("click"));
    await flushLifecycle();
    expect(backend.unlockCalls).toBe(2);
    expect(backend.startedLoops.map(({ cue }) => cue)).toEqual(["ambient.city"]);
  });

  it("keeps document visibility authoritative over bound gestures", async () => {
    const backend = new RecordingBackend();
    const page = new FakeVisibility();
    const target = new EventTarget();
    const manager = new AudioManager({
      backend,
      storage: null,
      visibilitySource: page,
      focusSource: page,
    });
    manager.bindUserGestures(target);

    page.setHidden(true);
    target.dispatchEvent(new Event("pointerdown"));
    target.dispatchEvent(new Event("click"));
    await flushLifecycle();

    expect(backend.unlockCalls).toBe(0);
    expect(backend.state).toBe("suspended");
  });

  it("uses one page state for blur, visibility, mute, and rapid changes without restarting feature music", async () => {
    const backend = new RecordingBackend();
    const page = new FakeVisibility();
    const manager = new AudioManager({
      backend,
      storage: null,
      visibilitySource: page,
      focusSource: page,
    });
    manager.setAmbientEnabled(true);
    await manager.unlock();
    manager.setFreeSpinsMusicEnabled(true);
    const starts = [...backend.startedLoops];

    // blur 可能发生在文档进入隐藏状态之前。它必须使用同一暂停路径， / English: The blur may occur before the document enters the hidden state. It must use the same pause path,
    // 且不得停止或替换 Feature 音源。 / English: Feature audio sources may not be stopped or replaced.
    page.dispatchEvent(new Event("blur"));
    await flushLifecycle();
    expect(backend.suspendCalls).toBe(1);
    expect(backend.stoppedLoops).toEqual([]);

    // 静音时恢复：仍允许恢复 context，但静音状态和可见性状态都不得从 / English: Resume while muted: The context is still allowed to be restored, but neither the muted state nor the visibility state must be restored from
    // 零偏移处创建循环。 / English: Create a loop at zero offset.
    manager.setMuted(true);
    page.dispatchEvent(new Event("focus"));
    await flushLifecycle();
    expect(backend.unlockCalls).toBe(2);
    expect(backend.startedLoops).toEqual(starts);

    // 合并后的隐藏、显示、隐藏序列会让最终后台状态保持暂停；过期的排队任务 / English: The merged hide, show, hide sequence will keep the final background state paused; expired queued tasks
    // 不能恢复该状态，也不能重新创建音源。 / English: This state cannot be restored, nor can the source be re-created.
    page.setHidden(true);
    page.setHidden(false);
    page.setHidden(true);
    await flushLifecycle();
    expect(backend.suspendCalls).toBe(2);
    expect(backend.unlockCalls).toBe(2);
    expect(backend.startedLoops).toEqual(starts);

    manager.destroy();
    page.setHidden(false);
    page.dispatchEvent(new Event("focus"));
    await flushLifecycle();
    expect(backend.unlockCalls).toBe(2);
    expect(backend.destroyCalls).toBe(1);
  });

  it("isolates backend failures and tears listeners down idempotently", async () => {
    const backend = new RecordingBackend();
    const visibility = new FakeVisibility();
    const target = new EventTarget();
    const manager = new AudioManager({ backend, storage: null, visibilitySource: visibility });
    manager.bindUserGestures(target);
    target.dispatchEvent(new Event("pointerdown"));
    await flushLifecycle();
    expect(backend.unlockCalls).toBe(1);

    backend.throwOnPlay = true;
    expect(() => manager.playImpact()).not.toThrow();
    manager.destroy();
    manager.destroy();
    expect(backend.destroyCalls).toBe(1);

    visibility.setHidden(true);
    target.dispatchEvent(new Event("pointerdown"));
    await flushLifecycle();
    expect(backend.suspendCalls).toBe(0);
    expect(backend.unlockCalls).toBe(1);
  });
});
