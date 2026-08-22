import { describe, expect, it, vi } from "vitest";
import type { Spine } from "@pixi-spine/runtime-4.1";
import {
  CHARACTER_INTRO_TASK_MS,
  CHARACTER_IDLE_LOOP_MS,
  LaunchScene,
  PRIMAL_CHARACTER_TRACK,
  WHEEL_CHEST_POUND_DECODED_DURATION_SECONDS,
  WHEEL_CHEST_POUND_FLOORED_TASK_MS,
  WHEEL_CHEST_POUND_REENTRY_MS,
  WHEEL_CHEST_POUND_SCHEDULER_FPS,
  WHEEL_CHEST_POUND_TASK_TICKS,
  type CharacterAnimationListener,
} from "../src/renderer/intro/LaunchScene";
import { PRIMAL_CHARACTER_ANIMATION_MS } from "../src/reels/primalAnimationTiming";

interface CharacterTrackEntryStub {
  readonly animation: { readonly name: string };
  readonly animationEnd: number;
  mixDuration: number;
  mixTime: number;
  trackTime: number;
  mixingFrom: CharacterTrackEntryStub | null;
  next: CharacterTrackEntryStub | null;
}

interface CharacterSpineStub {
  readonly entries: CharacterTrackEntryStub[];
  tint: number;
  readonly skeleton: {
    readonly setToSetupPose: ReturnType<typeof vi.fn>;
  };
  readonly state: {
    timeScale: number;
    readonly hasAnimation: ReturnType<typeof vi.fn>;
    readonly setAnimation: ReturnType<typeof vi.fn>;
    readonly addAnimation: ReturnType<typeof vi.fn>;
    readonly setEmptyAnimation: ReturnType<typeof vi.fn>;
    readonly clearTrack: ReturnType<typeof vi.fn>;
    readonly clearTracks: ReturnType<typeof vi.fn>;
    readonly getCurrent: ReturnType<typeof vi.fn<(
      track: number,
    ) => CharacterTrackEntryStub | null>>;
  };
  readonly update: ReturnType<typeof vi.fn>;
}

interface LaunchSceneHarness {
  readonly scene: LaunchScene;
  readonly monster: CharacterSpineStub;
  readonly listener: ReturnType<typeof vi.fn<CharacterAnimationListener>>;
}

const CHARACTER_DURATION_SECONDS: Readonly<Record<string, number>> = Object.freeze({
  aura_2: 1,
  chest_pound: 3.8333334922790527,
  feature_idle: 1.1667,
  idle: 1.6667,
  intro: PRIMAL_CHARACTER_ANIMATION_MS.intro / 1_000,
  particles_loop: PRIMAL_CHARACTER_ANIMATION_MS.particlesLoop / 1_000,
  win: 1.5000001192092896,
});

function createHarness(): LaunchSceneHarness {
  const entries: CharacterTrackEntryStub[] = [];
  const currentTracks = new Map<number, CharacterTrackEntryStub>();
  const makeEntry = (track: number, animation: string): CharacterTrackEntryStub => {
    const entry = {
      animation: { name: animation },
      animationEnd: CHARACTER_DURATION_SECONDS[animation] ?? 1,
      mixDuration: 0.15,
      mixTime: 0,
      trackTime: 0,
      mixingFrom: currentTracks.get(track) ?? null,
      next: null,
    };
    entries.push(entry);
    currentTracks.set(track, entry);
    return entry;
  };
  const monster: CharacterSpineStub = {
    entries,
    tint: 0xffffff,
    skeleton: {
      setToSetupPose: vi.fn(),
    },
    state: {
      timeScale: 1,
      hasAnimation: vi.fn(() => true),
      setAnimation: vi.fn((track: number, animation: string) => makeEntry(track, animation)),
      addAnimation: vi.fn((track: number, animation: string) => {
        const entry = {
          animation: { name: animation },
          animationEnd: CHARACTER_DURATION_SECONDS[animation] ?? 1,
          mixDuration: 0.15,
          mixTime: 0,
          trackTime: 0,
          mixingFrom: null,
          next: null,
        };
        entries.push(entry);
        return entry;
      }),
      setEmptyAnimation: vi.fn((track: number, mixDuration: number) => {
        const entry = makeEntry(track, "<empty>");
        entry.mixDuration = mixDuration;
        return entry;
      }),
      clearTrack: vi.fn((track: number) => currentTracks.delete(track)),
      clearTracks: vi.fn(() => currentTracks.clear()),
      getCurrent: vi.fn((track: number) => currentTracks.get(track) ?? null),
    },
    update: vi.fn((deltaSeconds: number) => {
      for (const entry of currentTracks.values()) {
        // 与 Spine 4.1 保持一致：先检查是否完成，再累加当前增量，因此恰好位于
        // 边界时会由下一次 apply 释放。
        if (entry.mixingFrom
          && entry.mixTime > 0
          && entry.mixTime >= entry.mixDuration) {
          entry.mixingFrom = null;
        }
        entry.trackTime += deltaSeconds * monster.state.timeScale;
        if (entry.mixingFrom) entry.mixTime += deltaSeconds;
      }
    }),
  };
  const listener = vi.fn<CharacterAnimationListener>();
  const scene = Object.create(LaunchScene.prototype) as LaunchScene;
  Object.assign(scene as unknown as Record<string, unknown>, {
    authoredMonster: monster as unknown as Spine,
    authoredIntroTimelineControlled: false,
    authoredIntroTimeMs: 0,
    characterAnimationListener: listener,
    characterIntroActive: false,
    characterIntroElapsedMs: 0,
    characterBodyReleased: true,
    characterAuraReleased: true,
    characterIntroCapturePaused: false,
    idleLoopElapsedMs: 0,
    idleResumeRemainingMs: 0,
    idleResumeToBase: false,
    idleResumeToFeature: false,
    idleSchedulerActive: false,
    visualCaptureIdleSuspended: false,
    monsterFallback: {
      update: vi.fn(),
      setReducedMotion: vi.fn(),
    },
    monsterHost: { alpha: 0 },
    logo: { alpha: 1 },
    persistentPresentation: {
      body: "feature",
      auraLevel: null,
      palette: "main",
    },
    reducedMotion: false,
    wheelChestPoundGeneration: 0,
    wheelChestPoundTask: null,
  });
  return { scene, monster, listener };
}

function advance(scene: LaunchScene, durationMs: number): void {
  let remainingMs = durationMs;
  while (remainingMs > 0.000_001) {
    const stepMs = Math.min(64, remainingMs);
    scene.update(stepMs);
    remainingMs -= stepMs;
  }
}

function chestEntries(monster: CharacterSpineStub): readonly CharacterTrackEntryStub[] {
  return monster.entries.filter(({ animation }) => animation.name === "chest_pound");
}

describe("LaunchScene Wheel character state", () => {
  it("derives FEATURE_CHEST_LOOP from the decoded clip through the official 30 Hz formula", () => {
    expect(WHEEL_CHEST_POUND_DECODED_DURATION_SECONDS).toBe(3.8333334922790527);
    expect(Math.floor(WHEEL_CHEST_POUND_DECODED_DURATION_SECONDS * 1_000)).toBe(3_833);
    expect(WHEEL_CHEST_POUND_SCHEDULER_FPS).toBe(30);
    expect(WHEEL_CHEST_POUND_FLOORED_TASK_MS).toBe(3_833);
    expect(WHEEL_CHEST_POUND_TASK_TICKS).toBe(115);
    expect(WHEEL_CHEST_POUND_REENTRY_MS).toBe(115 / 30 * 1_000);
    expect(WHEEL_CHEST_POUND_REENTRY_MS).toBe(3_833.3333333333335);
  });

  it.each([
    {
      rageLevel: 1,
      auraLevel: null,
      animations: [] as readonly (readonly [number, string, boolean])[],
    },
    {
      rageLevel: 2,
      auraLevel: 2,
      animations: [
        [PRIMAL_CHARACTER_TRACK.aura, "aura_2", true],
        [PRIMAL_CHARACTER_TRACK.particles, "particles_loop", true],
      ] as const,
    },
  ])("projects Base PPS level $rageLevel only onto authored aura tracks", ({ auraLevel, animations }) => {
    const { scene, monster } = createHarness();

    scene.setCharacterAuraLevel(auraLevel);

    expect(monster.state.clearTrack).not.toHaveBeenCalled();
    expect(monster.state.setAnimation.mock.calls).toEqual(animations);
    const touchedTracks = [
      ...monster.state.setAnimation.mock.calls,
      ...monster.state.setEmptyAnimation.mock.calls,
    ].map(([track]) => track);
    expect(touchedTracks).not.toContain(PRIMAL_CHARACTER_TRACK.body);
    expect(touchedTracks).not.toContain(PRIMAL_CHARACTER_TRACK.palette);
    expect(monster.update).toHaveBeenCalledWith(0);
  });

  it("mixes retired Free Spins aura, particles and palette to empty before Base", () => {
    const { scene, monster } = createHarness();
    scene.playCharacterAnimation("aura_2", true, PRIMAL_CHARACTER_TRACK.aura);
    scene.playCharacterAnimation("particles_loop", true, PRIMAL_CHARACTER_TRACK.particles);
    scene.playCharacterAnimation("Fs_bg_fire_color", false, PRIMAL_CHARACTER_TRACK.palette);
    monster.state.clearTrack.mockClear();
    monster.state.setEmptyAnimation.mockClear();

    scene.setCharacterPersistentPresentation({
      body: "base",
      auraLevel: null,
      palette: "main",
    });

    expect(monster.state.clearTrack).not.toHaveBeenCalled();
    expect(monster.state.setEmptyAnimation.mock.calls).toEqual([
      [PRIMAL_CHARACTER_TRACK.aura, 0.15],
      [PRIMAL_CHARACTER_TRACK.particles, 0.15],
      [PRIMAL_CHARACTER_TRACK.palette, 0.15],
    ]);
    expect(monster.tint).toBe(0xffffff);
    expect(monster.update).toHaveBeenCalledWith(0);
  });

  it("crossfades a retained Base PPS aura without clearing its old keyed pose", () => {
    const { scene, monster } = createHarness();
    scene.playCharacterAnimation("aura_2", true, PRIMAL_CHARACTER_TRACK.aura);
    scene.playCharacterAnimation("particles_loop", true, PRIMAL_CHARACTER_TRACK.particles);
    const oldAura = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.aura);
    const oldParticles = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.particles);
    monster.state.clearTrack.mockClear();

    scene.setCharacterPersistentPresentation({
      body: "base",
      auraLevel: 4,
      palette: "main",
    });

    const newAura = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.aura);
    const newParticles = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.particles);
    expect(monster.state.clearTrack).not.toHaveBeenCalled();
    expect(newAura?.animation.name).toBe("aura_4");
    expect(newAura?.mixingFrom).toBe(oldAura);
    expect(newAura?.mixDuration).toBe(0.15);
    expect(newParticles?.animation.name).toBe("particles_loop");
    expect(newParticles?.mixingFrom).toBe(oldParticles);
    expect(newParticles?.mixDuration).toBe(0.15);
  });

  it.each([
    ["fire", 0xff9485],
    ["snow", 0xcadfff],
  ] as const)("applies the official %s Character host tint", (palette, tint) => {
    const { scene, monster } = createHarness();

    scene.setCharacterPersistentPresentation({ body: "feature", auraLevel: 1, palette });

    expect(monster.tint).toBe(tint);
  });

  it.each([
    ["EXPANSION", "fire", "reel_stretch_waiting"],
    ["OVERDRIVE", "snow", "feature_idle"],
  ] as const)(
    "hard-settles %s character residue only at the final feature-exit boundary",
    (_mode, palette, body) => {
      const { scene, monster } = createHarness();
      scene.playCharacterAnimation(body, true, PRIMAL_CHARACTER_TRACK.body);
      scene.playCharacterAnimation("aura_2", true, PRIMAL_CHARACTER_TRACK.aura);
      scene.playCharacterAnimation("particles_loop", true, PRIMAL_CHARACTER_TRACK.particles);
      scene.playCharacterAnimation(
        palette === "fire" ? "Fs_bg_fire_color" : "Fs_bg_snow_color",
        false,
        PRIMAL_CHARACTER_TRACK.palette,
      );
      scene.setCharacterPersistentPresentation({
        body: "base",
        auraLevel: null,
        palette: "main",
      });
      monster.state.clearTrack.mockClear();
      monster.state.setEmptyAnimation.mockClear();
      monster.skeleton.setToSetupPose.mockClear();

      scene.settleFeatureExit();

      expect(monster.state.clearTrack.mock.calls.map(([track]) => track)).toEqual([
        PRIMAL_CHARACTER_TRACK.overlay,
        PRIMAL_CHARACTER_TRACK.body,
        PRIMAL_CHARACTER_TRACK.aura,
        PRIMAL_CHARACTER_TRACK.particles,
        PRIMAL_CHARACTER_TRACK.palette,
      ]);
      expect(monster.skeleton.setToSetupPose).toHaveBeenCalledOnce();
      expect(monster.state.setEmptyAnimation).not.toHaveBeenCalled();
      expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toMatchObject({
        animation: { name: "idle" },
        mixDuration: 0,
        mixingFrom: null,
      });
      expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.aura)).toBeNull();
      expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.particles)).toBeNull();
      expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.palette)).toBeNull();
      expect(monster.tint).toBe(0xffffff);

      advance(scene, 200);
      expect(scene.getCharacterTrackDiagnostics()).toEqual([
        expect.objectContaining({ track: 0, animation: null, mixingFrom: null }),
        expect.objectContaining({ track: 1, animation: "idle", mixingFrom: null }),
        expect.objectContaining({ track: 2, animation: null, mixingFrom: null }),
        expect.objectContaining({ track: 3, animation: null, mixingFrom: null }),
        expect.objectContaining({ track: 4, animation: null, mixingFrom: null }),
      ]);
    },
  );

  it("owns exactly three fresh chest entries through the normal S9800 landing", () => {
    const { scene, monster, listener } = createHarness();
    scene.playCharacterAnimation("rage_collect", true, PRIMAL_CHARACTER_TRACK.overlay);
    scene.playCharacterAnimation("aura_2", true, PRIMAL_CHARACTER_TRACK.aura);
    scene.playCharacterAnimation("particles_loop", true, PRIMAL_CHARACTER_TRACK.particles);
    scene.playCharacterAnimation("Fs_bg_fire_color", false, PRIMAL_CHARACTER_TRACK.palette);
    const preservedTracks = new Map([0, 2, 3, 4].map((track) => [
      track,
      monster.state.getCurrent(track),
    ]));
    listener.mockClear();

    scene.playCharacterAnimation("chest_pound", true, PRIMAL_CHARACTER_TRACK.body);
    expect(monster.state.setAnimation).toHaveBeenLastCalledWith(
      PRIMAL_CHARACTER_TRACK.body,
      "chest_pound",
      true,
    );
    expect(chestEntries(monster)).toHaveLength(1);
    expect(chestEntries(monster)[0]?.trackTime).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);

    const firstEntry = chestEntries(monster)[0];
    expect(scene.getWheelChestPoundDiagnostics()).toMatchObject({
      schedulerActive: true,
      generation: 1,
      entryOrdinal: 1,
      reentryCount: 0,
      ownerIsCurrent: true,
      nonBodyTrackIdentityPreserved: true,
    });

    advance(scene, 3_800);
    expect(chestEntries(monster)).toHaveLength(1);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toBe(firstEntry);
    expect(firstEntry?.trackTime).toBeCloseTo(3.8, 9);

    advance(scene, WHEEL_CHEST_POUND_REENTRY_MS - 3_800);
    expect(chestEntries(monster)).toHaveLength(2);
    const secondEntry = chestEntries(monster)[1];
    expect(secondEntry?.trackTime).toBe(0);
    expect(secondEntry?.mixingFrom).toBe(firstEntry);
    expect(secondEntry?.mixDuration).toBe(0.15);
    expect(secondEntry?.next).toBeNull();
    expect(listener).toHaveBeenNthCalledWith(2, {
      animation: "chest_pound",
      context: "state",
    });
    expect(scene.getWheelChestPoundDiagnostics()).toMatchObject({
      targetSpinElapsedMs: WHEEL_CHEST_POUND_REENTRY_MS,
      taskElapsedMs: 0,
      generation: 2,
      entryOrdinal: 2,
      reentryCount: 1,
    });

    advance(scene, 150);
    scene.update(0);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toBe(secondEntry);
    expect(secondEntry?.trackTime).toBeCloseTo(0.15, 9);
    expect(secondEntry?.mixingFrom).toBeNull();
    expect(chestEntries(monster)).toHaveLength(2);

    advance(scene, WHEEL_CHEST_POUND_REENTRY_MS - 150);
    expect(chestEntries(monster)).toHaveLength(3);
    expect(new Set(chestEntries(monster))).toHaveLength(3);
    const thirdEntry = chestEntries(monster)[2];
    expect(thirdEntry?.trackTime).toBe(0);
    expect(thirdEntry?.mixingFrom).toBe(secondEntry);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(scene.getWheelChestPoundDiagnostics()).toMatchObject({
      targetSpinElapsedMs: WHEEL_CHEST_POUND_REENTRY_MS * 2,
      taskElapsedMs: 0,
      generation: 3,
      entryOrdinal: 3,
      reentryCount: 2,
      ownerIsCurrent: true,
      nonBodyTrackIdentityPreserved: true,
    });
    for (const [track, entry] of preservedTracks) {
      expect(monster.state.getCurrent(track)).toBe(entry);
    }

    advance(scene, 9_800 - WHEEL_CHEST_POUND_REENTRY_MS * 2);
    expect(thirdEntry?.trackTime).toBeCloseTo(64 / 30, 9);
    scene.playCharacterAnimation("win", false);
    expect(scene.getWheelChestPoundDiagnostics().schedulerActive).toBe(false);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)?.animation.name).toBe("win");
    advance(scene, 1_500);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)?.animation.name)
      .toBe("feature_idle");
    advance(scene, 200);
    expect(chestEntries(monster)).toHaveLength(3);
    for (const [track, entry] of preservedTracks) {
      expect(monster.state.getCurrent(track)).toBe(entry);
    }
  });

  it.each([
    [3_800, 1, 0, 1, 3.8, null, 3_800],
    [115_000 / 30, 2, 1, 2, 0, "chest_pound", 0],
    [115_000 / 30 + 150, 2, 1, 2, 0.15, null, 150],
    [230_000 / 30, 3, 2, 3, 0, "chest_pound", 0],
  ] as const)(
    "steps paused FEATURE_CHEST_LOOP from real S0 to exact S%s",
    (elapsedMs, entryOrdinal, reentryCount, generation, trackTime, mixingFrom, taskElapsedMs) => {
      const { scene, monster } = createHarness();
      scene.playCharacterAnimation("rage_collect", true, PRIMAL_CHARACTER_TRACK.overlay);
      scene.playCharacterAnimation("aura_2", true, PRIMAL_CHARACTER_TRACK.aura);
      scene.playCharacterAnimation("particles_loop", true, PRIMAL_CHARACTER_TRACK.particles);
      scene.playCharacterAnimation("Fs_bg_fire_color", false, PRIMAL_CHARACTER_TRACK.palette);
      const preservedTracks = new Map([0, 2, 3, 4].map((track) => [
        track,
        monster.state.getCurrent(track),
      ]));
      scene.playCharacterAnimation("chest_pound", true);
      expect(scene.setCharacterIntroCapturePaused(true)).toBe(true);
      monster.update.mockClear();

      expect(scene.advanceWheelChestPoundCapture(elapsedMs)).toBe(true);

      const body = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
      expect(body?.animation.name).toBe("chest_pound");
      expect(body?.trackTime).toBeCloseTo(trackTime, 9);
      expect(body?.mixingFrom?.animation.name ?? null).toBe(mixingFrom);
      expect(body?.mixDuration).toBe(0.15);
      const diagnostics = scene.getWheelChestPoundDiagnostics();
      expect(diagnostics).toMatchObject({
        schedulerFps: 30,
        flooredTaskMs: 3_833,
        taskTicks: 115,
        periodMs: 115_000 / 30,
        targetSpinElapsedMs: elapsedMs,
        taskElapsedMs,
        entryOrdinal,
        reentryCount,
        schedulerActive: true,
        generation,
        ownerIsCurrent: true,
        nonBodyTrackIdentityPreserved: true,
      });
      expect(diagnostics.generation).toBe(diagnostics.entryOrdinal);
      expect(Object.isFrozen(diagnostics)).toBe(true);
      expect(Object.isFrozen(diagnostics.tracks)).toBe(true);
      const positiveSteps = monster.update.mock.calls
        .map(([seconds]) => seconds as number)
        .filter((seconds) => seconds > 0);
      expect(Math.max(...positiveSteps)).toBeLessThanOrEqual(1 / 30);
      expect(positiveSteps.reduce((sum, seconds) => sum + seconds, 0))
        .toBeCloseTo(elapsedMs / 1_000, 9);
      expect(monster.update).toHaveBeenLastCalledWith(0);
      for (const [track, entry] of preservedTracks) {
        expect(monster.state.getCurrent(track)).toBe(entry);
      }
    },
  );

  it("rejects near-miss, unpaused, reduced, non-feature and production-advanced capture seams", () => {
    const unpaused = createHarness();
    unpaused.scene.playCharacterAnimation("chest_pound", true);
    expect(unpaused.scene.advanceWheelChestPoundCapture(3_800)).toBe(false);
    expect(unpaused.scene.setCharacterIntroCapturePaused(true)).toBe(true);
    expect(unpaused.scene.advanceWheelChestPoundCapture(3_800.001)).toBe(false);

    const reduced = createHarness();
    reduced.scene.playCharacterAnimation("chest_pound", true);
    reduced.scene.setReducedMotion(true);
    expect(reduced.scene.setCharacterIntroCapturePaused(true)).toBe(true);
    expect(reduced.scene.advanceWheelChestPoundCapture(3_800)).toBe(false);

    const nonFeature = createHarness();
    nonFeature.scene.setCharacterBodyContinuation("base", false);
    nonFeature.scene.playCharacterAnimation("chest_pound", true);
    expect(nonFeature.scene.setCharacterIntroCapturePaused(true)).toBe(true);
    expect(nonFeature.scene.advanceWheelChestPoundCapture(3_800)).toBe(false);

    const productionAdvanced = createHarness();
    productionAdvanced.scene.playCharacterAnimation("chest_pound", true);
    productionAdvanced.scene.update(1);
    expect(productionAdvanced.scene.setCharacterIntroCapturePaused(true)).toBe(true);
    expect(productionAdvanced.scene.advanceWheelChestPoundCapture(3_800)).toBe(false);
  });

  it("cancels re-entry when a later body animation or persistent restore takes ownership", () => {
    const { scene, monster, listener } = createHarness();

    scene.playCharacterAnimation("chest_pound", true);
    advance(scene, 1_000);
    scene.playCharacterAnimation("win", false);
    advance(scene, 1_499);

    expect(chestEntries(monster)).toHaveLength(1);
    expect(monster.state.setAnimation).toHaveBeenCalledWith(PRIMAL_CHARACTER_TRACK.body, "win", false);
    expect(monster.state.addAnimation).not.toHaveBeenCalledWith(
      PRIMAL_CHARACTER_TRACK.body,
      "feature_idle",
      true,
      0,
    );
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)?.animation.name).toBe("win");

    advance(scene, 1);
    expect(monster.state.setAnimation).toHaveBeenCalledWith(
      PRIMAL_CHARACTER_TRACK.body,
      "feature_idle",
      true,
    );
    advance(scene, WHEEL_CHEST_POUND_REENTRY_MS * 2);

    scene.playCharacterAnimation("chest_pound", true);
    advance(scene, 1_000);
    scene.resumeCharacterPersistentBody();
    advance(scene, WHEEL_CHEST_POUND_REENTRY_MS * 2);

    expect(chestEntries(monster)).toHaveLength(2);
    expect(monster.state.setAnimation).toHaveBeenCalledWith(
      PRIMAL_CHARACTER_TRACK.body,
      "feature_idle",
      true,
    );
    expect(listener.mock.calls.filter(
      ([event]) => event.animation === "chest_pound",
    )).toHaveLength(2);
  });

  it("revokes the owned task on feature exit but preserves a same-feature continuation update", () => {
    const sameFeature = createHarness();
    sameFeature.scene.playCharacterAnimation("chest_pound", true);
    const owner = sameFeature.monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
    sameFeature.scene.setCharacterBodyContinuation("feature", false);
    advance(sameFeature.scene, WHEEL_CHEST_POUND_REENTRY_MS);
    expect(chestEntries(sameFeature.monster)).toHaveLength(2);
    expect(chestEntries(sameFeature.monster)[1]?.mixingFrom).toBe(owner);

    for (const continuation of ["base", "kq"] as const) {
      const exited = createHarness();
      exited.scene.playCharacterAnimation("chest_pound", true);
      const first = exited.monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
      exited.scene.setCharacterBodyContinuation(continuation, false);
      exited.scene.setCharacterBodyContinuation("feature", false);
      advance(exited.scene, WHEEL_CHEST_POUND_REENTRY_MS * 2);
      expect(exited.monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toBe(first);
      expect(chestEntries(exited.monster)).toHaveLength(1);
      expect(exited.scene.getWheelChestPoundDiagnostics().schedulerActive).toBe(false);
    }
  });

  it("fails closed when Track 1 no longer contains the generation-owned entry", () => {
    const { scene, monster } = createHarness();
    scene.playCharacterAnimation("chest_pound", true);
    const stolen = (monster.state.setAnimation as unknown as (
      track: number,
      animation: string,
      loop: boolean,
    ) => CharacterTrackEntryStub)(PRIMAL_CHARACTER_TRACK.body, "idle", true);

    scene.update(1_000 / 30);
    advance(scene, WHEEL_CHEST_POUND_REENTRY_MS * 2);

    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toBe(stolen);
    expect(chestEntries(monster)).toHaveLength(1);
    expect(scene.getWheelChestPoundDiagnostics()).toMatchObject({
      schedulerActive: false,
      ownerIsCurrent: false,
    });
  });

  it("revokes FEATURE_CHEST_LOOP ownership during renderer teardown", () => {
    const { scene, monster } = createHarness();
    scene.playCharacterAnimation("chest_pound", true);
    const owner = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
    advance(scene, 1_000);

    scene.cancelCharacterStateTasks();
    advance(scene, WHEEL_CHEST_POUND_REENTRY_MS * 2);

    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toBe(owner);
    expect(chestEntries(monster)).toHaveLength(1);
    expect(scene.getWheelChestPoundDiagnostics().schedulerActive).toBe(false);
  });

  it("ignores invalid deltas and caps a stalled RAF at five scheduler ticks", () => {
    const invalid = createHarness();
    invalid.scene.playCharacterAnimation("chest_pound", true);
    const before = invalid.scene.getWheelChestPoundDiagnostics();

    invalid.scene.update(Number.NaN);
    invalid.scene.update(Number.POSITIVE_INFINITY);
    invalid.scene.update(-1);

    expect(invalid.scene.getWheelChestPoundDiagnostics()).toMatchObject({
      targetSpinElapsedMs: before.targetSpinElapsedMs,
      taskElapsedMs: before.taskElapsedMs,
      entryOrdinal: before.entryOrdinal,
      reentryCount: before.reentryCount,
      generation: before.generation,
      schedulerActive: true,
      ownerIsCurrent: true,
    });
    expect(chestEntries(invalid.monster)).toHaveLength(1);

    const stalled = createHarness();
    stalled.scene.playCharacterAnimation("chest_pound", true);
    advance(stalled.scene, 3_800);
    stalled.scene.update(WHEEL_CHEST_POUND_REENTRY_MS * 10);
    expect(chestEntries(stalled.monster)).toHaveLength(2);
    expect(stalled.scene.getWheelChestPoundDiagnostics()).toMatchObject({
      entryOrdinal: 2,
      reentryCount: 1,
    });
  });

  it("does not self-reenter non-looping or non-body chest_pound animations", () => {
    const body = createHarness();
    body.scene.playCharacterAnimation("chest_pound", false, PRIMAL_CHARACTER_TRACK.body);
    advance(body.scene, WHEEL_CHEST_POUND_REENTRY_MS * 2);
    expect(chestEntries(body.monster)).toHaveLength(1);

    const overlay = createHarness();
    overlay.scene.playCharacterAnimation("chest_pound", true, PRIMAL_CHARACTER_TRACK.overlay);
    advance(overlay.scene, WHEEL_CHEST_POUND_REENTRY_MS * 2);
    expect(chestEntries(overlay.monster)).toHaveLength(1);
  });

  it("emits at most the initial event once reduced motion disables re-entry", () => {
    const alreadyReduced = createHarness();
    alreadyReduced.scene.setReducedMotion(true);
    alreadyReduced.scene.playCharacterAnimation("chest_pound", true);
    advance(alreadyReduced.scene, WHEEL_CHEST_POUND_REENTRY_MS * 3);
    expect(chestEntries(alreadyReduced.monster)).toHaveLength(1);
    expect(alreadyReduced.listener).toHaveBeenCalledTimes(1);
    expect(alreadyReduced.monster.state.timeScale).toBe(0);

    const toggled = createHarness();
    toggled.scene.playCharacterAnimation("chest_pound", true);
    advance(toggled.scene, 1_000);
    toggled.scene.setReducedMotion(true);
    advance(toggled.scene, WHEEL_CHEST_POUND_REENTRY_MS * 3);
    expect(chestEntries(toggled.monster)).toHaveLength(1);
    expect(toggled.listener).toHaveBeenCalledTimes(1);

    toggled.scene.setReducedMotion(false);
    advance(toggled.scene, WHEEL_CHEST_POUND_REENTRY_MS * 2);
    expect(chestEntries(toggled.monster)).toHaveLength(1);
    expect(toggled.listener).toHaveBeenCalledTimes(1);
    expect(toggled.monster.state.timeScale).toBe(1);
  });

  it("marks all three COLLECT random intervals without relabelling deterministic win", () => {
    const { scene, listener } = createHarness();

    scene.playCharacterCollect(0);
    scene.playCharacterCollect(0.333_334);
    scene.playCharacterCollect(0.666_667);

    expect(listener.mock.calls.map(([event]) => event).filter(
      ({ context }) => context === "collect-random",
    )).toEqual([
      { animation: "idle_breaker2", context: "collect-random" },
      { animation: "chest_pound", context: "collect-random" },
      { animation: "win", context: "collect-random" },
    ]);

    scene.playCharacterAnimation("win");
    expect(listener).toHaveBeenLastCalledWith({ animation: "win", context: "state" });
  });

  it("keeps the authored intro alive after the five-second chrome transition", () => {
    const { scene, monster } = createHarness();
    Object.assign(scene as unknown as Record<string, unknown>, {
      authoredIntroTimelineControlled: true,
      authoredIntroTimeMs: 5_000,
      characterIntroActive: true,
      characterIntroElapsedMs: 5_000,
      characterBodyReleased: false,
      idleLoopElapsedMs: 0,
      persistentPresentation: {
        body: "base",
        auraLevel: null,
        palette: "main",
      },
    });

    scene.completeAuthoredIntro(false);

    expect(monster.state.setAnimation).not.toHaveBeenCalled();
    const state = scene as unknown as {
      authoredIntroTimelineControlled: boolean;
      authoredIntroTimeMs: number;
      characterIntroActive: boolean;
      idleSchedulerActive: boolean;
    };
    expect(state.authoredIntroTimelineControlled).toBe(false);
    expect(state.authoredIntroTimeMs).toBe(0);
    expect(state.characterIntroActive).toBe(true);
    expect(state.idleSchedulerActive).toBe(false);

    scene.update(64);
    expect(monster.update).toHaveBeenLastCalledWith(0.064);
  });

  it("seeks skipped intro to its exact end before entering neutral Base idle", () => {
    const { scene, monster } = createHarness();
    Object.assign(scene as unknown as Record<string, unknown>, {
      authoredIntroTimelineControlled: true,
      authoredIntroTimeMs: 2_800,
      characterIntroActive: true,
      characterIntroElapsedMs: 2_800,
      characterBodyReleased: false,
      characterAuraReleased: false,
      idleLoopElapsedMs: 9_999,
      persistentPresentation: {
        body: "base",
        auraLevel: null,
        palette: "main",
      },
    });

    scene.completeAuthoredIntro(true);

    expect(monster.state.setAnimation).toHaveBeenLastCalledWith(
      PRIMAL_CHARACTER_TRACK.body,
      "idle",
      true,
    );
    const intro = monster.entries.find(({ animation }) => animation.name === "intro");
    expect(intro?.mixDuration).toBe(0);
    expect(intro?.trackTime).toBe(PRIMAL_CHARACTER_ANIMATION_MS.intro / 1_000);
    const state = scene as unknown as {
      authoredIntroTimelineControlled: boolean;
      authoredIntroTimeMs: number;
      characterIntroActive: boolean;
      characterBodyReleased: boolean;
      characterAuraReleased: boolean;
      idleLoopElapsedMs: number;
      idleSchedulerActive: boolean;
    };
    expect(state.authoredIntroTimelineControlled).toBe(false);
    expect(state.authoredIntroTimeMs).toBe(0);
    expect(state.characterIntroActive).toBe(false);
    expect(state.characterBodyReleased).toBe(true);
    expect(state.characterAuraReleased).toBe(true);
    expect(state.idleLoopElapsedMs).toBe(0);
    expect(state.idleSchedulerActive).toBe(true);
  });

  it("uses detached zero-mix INTRO and the explicit 8,066 ms task for LOOP", () => {
    const { scene, monster } = createHarness();
    Object.assign(scene as unknown as Record<string, unknown>, {
      persistentPresentation: {
        body: "base",
        auraLevel: null,
        palette: "main",
      },
    });

    scene.startAuthoredIntro();

    expect(monster.state.setAnimation).toHaveBeenNthCalledWith(
      1,
      PRIMAL_CHARACTER_TRACK.body,
      "hidden",
      false,
    );
    expect(monster.state.setAnimation).toHaveBeenNthCalledWith(
      2,
      PRIMAL_CHARACTER_TRACK.body,
      "intro",
      false,
    );
    const hidden = monster.entries.find(({ animation }) => animation.name === "hidden");
    const intro = monster.entries.find(({ animation }) => animation.name === "intro");
    expect(hidden?.mixDuration).toBe(0);
    expect(intro?.mixDuration).toBe(0);
    expect(intro?.mixingFrom).toBeNull();
    expect(intro).not.toHaveProperty("listener");
    expect(monster.state.addAnimation).not.toHaveBeenCalled();
    expect(monster.update).toHaveBeenNthCalledWith(1, 0);
    expect(monster.update).toHaveBeenNthCalledWith(2, 0);
    expect(monster.state.clearTrack.mock.calls.filter(
      ([track]) => track === PRIMAL_CHARACTER_TRACK.body,
    )).toHaveLength(2);

    scene.seekAuthoredIntro(5_000);
    scene.completeAuthoredIntro(false);
    expect(scene.getCharacterIntroLifecycleDiagnostics()).toMatchObject({
      introActive: true,
      introElapsedMs: 5_000,
      taskDurationMs: CHARACTER_INTRO_TASK_MS,
      bodyReleased: false,
      idleSchedulerActive: false,
    });

    advance(scene, CHARACTER_INTRO_TASK_MS - 5_000 - 0.001);
    expect(monster.state.setAnimation).not.toHaveBeenCalledWith(
      PRIMAL_CHARACTER_TRACK.body,
      "idle",
      true,
    );

    advance(scene, 0.002);
    expect(monster.state.setAnimation).toHaveBeenLastCalledWith(
      PRIMAL_CHARACTER_TRACK.body,
      "idle",
      true,
    );
    const idle = monster.entries.at(-1);
    expect(idle?.mixDuration).toBe(0.15);
    expect(idle?.mixingFrom).toBe(intro);
    expect(scene.getCharacterIntroLifecycleDiagnostics()).toMatchObject({
      introActive: false,
      introElapsedMs: CHARACTER_INTRO_TASK_MS,
      bodyReleased: true,
      idleSchedulerActive: true,
    });
  });

  it("cancels INTRO task ownership when a result body animation takes over", () => {
    const { scene, monster } = createHarness();
    Object.assign(scene as unknown as Record<string, unknown>, {
      persistentPresentation: { body: "base", auraLevel: null, palette: "main" },
    });
    scene.startAuthoredIntro();
    scene.seekAuthoredIntro(1_000);

    expect(scene.playCharacterAnimation("win", false)).toBe(true);
    expect(scene.getCharacterIntroLifecycleDiagnostics()).toMatchObject({
      introActive: false,
      introElapsedMs: 1_000,
      timelineControlled: false,
      bodyReleased: true,
      idleSchedulerActive: false,
    });
    expect(monster.state.setAnimation).toHaveBeenLastCalledWith(
      PRIMAL_CHARACTER_TRACK.body,
      "win",
      false,
    );
    expect(monster.state.addAnimation).not.toHaveBeenCalled();

    advance(scene, 1_499);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)?.animation.name).toBe("win");

    advance(scene, 1);
    expect(monster.state.setAnimation).toHaveBeenLastCalledWith(
      PRIMAL_CHARACTER_TRACK.body,
      "idle",
      true,
    );
    expect(scene.getCharacterIntroLifecycleDiagnostics().idleSchedulerActive).toBe(true);
  });

  it("hands ordinary Base WIN to one idle entry at the floored 1,500 ms boundary", () => {
    const { scene, monster, listener } = createHarness();
    Object.assign(scene as unknown as Record<string, unknown>, {
      persistentPresentation: { body: "base", auraLevel: null, palette: "main" },
    });
    scene.playCharacterAnimation("rage_collect", true, PRIMAL_CHARACTER_TRACK.overlay);
    scene.playCharacterAnimation("aura_2", true, PRIMAL_CHARACTER_TRACK.aura);
    scene.playCharacterAnimation("particles_loop", true, PRIMAL_CHARACTER_TRACK.particles);
    scene.playCharacterAnimation("Fs_bg_fire_color", false, PRIMAL_CHARACTER_TRACK.palette);
    const preservedTracks = new Map([0, 2, 3, 4].map((track) => [
      track,
      monster.state.getCurrent(track),
    ]));
    listener.mockClear();

    expect(scene.playCharacterAnimation("win", false)).toBe(true);
    const winEntry = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
    expect(winEntry?.animation.name).toBe("win");
    expect(monster.state.setAnimation.mock.calls.filter(
      ([track, animation]) => track === PRIMAL_CHARACTER_TRACK.body && animation === "win",
    )).toHaveLength(1);
    expect(monster.state.addAnimation).not.toHaveBeenCalled();

    advance(scene, 1_499);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toBe(winEntry);
    expect(monster.state.setAnimation.mock.calls.filter(
      ([track, animation]) => track === PRIMAL_CHARACTER_TRACK.body && animation === "idle",
    )).toHaveLength(0);

    advance(scene, 1);
    const idleEntry = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
    expect(idleEntry?.animation.name).toBe("idle");
    expect(idleEntry?.mixingFrom).toBe(winEntry);
    expect(idleEntry?.mixDuration).toBe(0.15);
    expect(monster.state.setAnimation.mock.calls.filter(
      ([track, animation]) => track === PRIMAL_CHARACTER_TRACK.body && animation === "idle",
    )).toHaveLength(1);
    expect(scene.getCharacterIntroLifecycleDiagnostics().idleSchedulerActive).toBe(true);
    expect((scene as unknown as { idleLoopElapsedMs: number }).idleLoopElapsedMs).toBe(0);

    advance(scene, 150);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toBe(idleEntry);
    expect(monster.state.setAnimation.mock.calls.filter(
      ([track, animation]) => track === PRIMAL_CHARACTER_TRACK.body && animation === "idle",
    )).toHaveLength(1);
    for (const [track, entry] of preservedTracks) {
      expect(monster.state.getCurrent(track)).toBe(entry);
    }
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({ animation: "win", context: "state" });
  });

  it("hands Wheel WIN_FEATURE to one feature_idle entry at the floored 1,500 ms boundary", () => {
    const { scene, monster, listener } = createHarness();
    scene.playCharacterAnimation("rage_collect", true, PRIMAL_CHARACTER_TRACK.overlay);
    scene.playCharacterAnimation("aura_2", true, PRIMAL_CHARACTER_TRACK.aura);
    scene.playCharacterAnimation("particles_loop", true, PRIMAL_CHARACTER_TRACK.particles);
    scene.playCharacterAnimation("Fs_bg_fire_color", false, PRIMAL_CHARACTER_TRACK.palette);
    const preservedTracks = new Map([0, 2, 3, 4].map((track) => [
      track,
      monster.state.getCurrent(track),
    ]));
    listener.mockClear();

    expect(scene.playCharacterAnimation("win", false)).toBe(true);
    const winEntry = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
    expect(winEntry?.animation.name).toBe("win");
    expect(monster.state.addAnimation).not.toHaveBeenCalled();

    advance(scene, 1_499);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toBe(winEntry);
    expect(monster.state.setAnimation.mock.calls.filter(
      ([track, animation]) => track === PRIMAL_CHARACTER_TRACK.body
        && animation === "feature_idle",
    )).toHaveLength(0);

    advance(scene, 1);
    const featureIdleEntry = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
    expect(featureIdleEntry?.animation.name).toBe("feature_idle");
    expect(featureIdleEntry?.trackTime).toBe(0);
    expect(featureIdleEntry?.mixingFrom).toBe(winEntry);
    expect(featureIdleEntry?.mixDuration).toBe(0.15);
    expect(monster.state.setAnimation.mock.calls.filter(
      ([track, animation]) => track === PRIMAL_CHARACTER_TRACK.body
        && animation === "feature_idle",
    )).toHaveLength(1);

    advance(scene, 150);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toBe(featureIdleEntry);
    expect(monster.state.setAnimation.mock.calls.filter(
      ([track, animation]) => track === PRIMAL_CHARACTER_TRACK.body
        && animation === "feature_idle",
    )).toHaveLength(1);
    advance(scene, 300);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toBe(featureIdleEntry);
    expect(featureIdleEntry?.trackTime).toBeCloseTo(0.45, 6);
    for (const [track, entry] of preservedTracks) {
      expect(monster.state.getCurrent(track)).toBe(entry);
    }
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({ animation: "win", context: "state" });
  });

  it.each([
    [1_499, "win", 1.499, null],
    [1_500, "feature_idle", 0, "win"],
    [1_650, "feature_idle", 0.15, null],
  ] as const)(
    "steps the paused Wheel WIN_FEATURE capture clock to exactly %sms",
    (elapsedMs, animation, trackTime, mixingFrom) => {
      const { scene, monster } = createHarness();
      scene.playCharacterAnimation("rage_collect", true, PRIMAL_CHARACTER_TRACK.overlay);
      scene.playCharacterAnimation("aura_2", true, PRIMAL_CHARACTER_TRACK.aura);
      scene.playCharacterAnimation("particles_loop", true, PRIMAL_CHARACTER_TRACK.particles);
      scene.playCharacterAnimation("Fs_bg_fire_color", false, PRIMAL_CHARACTER_TRACK.palette);
      const preservedTracks = new Map([0, 2, 3, 4].map((track) => [
        track,
        monster.state.getCurrent(track),
      ]));
      scene.playCharacterAnimation("win", false);
      // Wheel 完成时使用的同一种仅续接赋值，不得撤销它已经持有的任务。
      scene.setCharacterBodyContinuation("feature", false);
      expect(scene.setCharacterIntroCapturePaused(true)).toBe(true);
      monster.update.mockClear();

      expect(scene.advanceWheelWinFeatureCharacterCapture(elapsedMs)).toBe(true);

      const body = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
      expect(body?.animation.name).toBe(animation);
      expect(body?.trackTime).toBeCloseTo(trackTime, 6);
      expect(body?.mixingFrom?.animation.name ?? null).toBe(mixingFrom);
      expect(body?.mixDuration).toBe(0.15);
      expect(scene.getCharacterIntroLifecycleDiagnostics().capturePaused).toBe(true);
      const positiveSteps = monster.update.mock.calls
        .map(([deltaSeconds]) => deltaSeconds as number)
        .filter((deltaSeconds) => deltaSeconds > 0);
      expect(Math.max(...positiveSteps)).toBeLessThanOrEqual(0.064);
      expect(positiveSteps.reduce((sum, seconds) => sum + seconds, 0))
        .toBeCloseTo(elapsedMs / 1_000, 9);
      if (elapsedMs === 1_650) {
        let cumulative = 0;
        const boundaries = positiveSteps.map((seconds) => (cumulative += seconds));
        expect(boundaries.some((seconds) => Math.abs(seconds - 1.5) < 0.000_001)).toBe(true);
      }
      expect(monster.update).toHaveBeenLastCalledWith(0);
      for (const [track, entry] of preservedTracks) {
        expect(monster.state.getCurrent(track)).toBe(entry);
      }
    },
  );

  it("rejects Wheel WIN_FEATURE fixture stepping outside the strict paused seam", () => {
    const { scene } = createHarness();
    scene.playCharacterAnimation("win", false);
    expect(scene.advanceWheelWinFeatureCharacterCapture(1_499)).toBe(false);
    expect(scene.setCharacterIntroCapturePaused(true)).toBe(true);
    expect(scene.advanceWheelWinFeatureCharacterCapture(1_498)).toBe(false);
    scene.setReducedMotion(true);
    expect(scene.advanceWheelWinFeatureCharacterCapture(1_499)).toBe(false);
  });

  it("rejects Wheel WIN_FEATURE exact stepping after production has left L0", () => {
    const { scene, monster } = createHarness();
    scene.playCharacterAnimation("win", false);
    advance(scene, 1);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)?.trackTime)
      .toBeCloseTo(0.001, 9);
    expect(scene.setCharacterIntroCapturePaused(true)).toBe(true);

    expect(scene.advanceWheelWinFeatureCharacterCapture(1_499)).toBe(false);
    expect(scene.advanceWheelWinFeatureCharacterCapture(1_500)).toBe(false);
    expect(scene.advanceWheelWinFeatureCharacterCapture(1_650)).toBe(false);
  });

  it("cancels a stale Wheel WIN_FEATURE handoff when another body state takes over", () => {
    const { scene, monster } = createHarness();
    scene.playCharacterAnimation("win", false);
    advance(scene, 1_000);
    scene.playCharacterAnimation("idle_breaker2", false);
    const takeoverEntry = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);

    advance(scene, 501);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toBe(takeoverEntry);
    expect(monster.state.setAnimation.mock.calls.filter(
      ([track, animation]) => track === PRIMAL_CHARACTER_TRACK.body
        && animation === "feature_idle",
    )).toHaveLength(0);
  });

  it.each(["base", "kq"] as const)(
    "revokes pending WIN_FEATURE on continuation-only feature -> %s -> feature changes",
    (intermediate) => {
      const { scene, monster } = createHarness();
      scene.playCharacterAnimation("win", false);
      const winEntry = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
      advance(scene, 1_000);

      scene.setCharacterBodyContinuation(intermediate, false);
      scene.setCharacterBodyContinuation("feature", false);
      advance(scene, 501);

      expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toBe(winEntry);
      expect(monster.state.setAnimation.mock.calls.filter(
        ([track, animation]) => track === PRIMAL_CHARACTER_TRACK.body
          && animation === "feature_idle",
      )).toHaveLength(0);
    },
  );

  it("cancels pending Wheel WIN_FEATURE ownership on restore and teardown", () => {
    const restored = createHarness();
    restored.scene.playCharacterAnimation("win", false);
    advance(restored.scene, 1_000);
    restored.scene.resumeCharacterPersistentBody();
    const restoredEntry = restored.monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
    advance(restored.scene, 501);
    expect(restored.monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toBe(restoredEntry);
    expect(restored.monster.state.setAnimation.mock.calls.filter(
      ([track, animation]) => track === PRIMAL_CHARACTER_TRACK.body
        && animation === "feature_idle",
    )).toHaveLength(1);

    const destroyed = createHarness();
    destroyed.scene.playCharacterAnimation("win", false);
    advance(destroyed.scene, 1_000);
    destroyed.scene.cancelCharacterStateTasks();
    advance(destroyed.scene, 501);
    expect(destroyed.monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)?.animation.name)
      .toBe("win");
    expect(destroyed.monster.state.setAnimation.mock.calls.filter(
      ([track, animation]) => track === PRIMAL_CHARACTER_TRACK.body
        && animation === "feature_idle",
    )).toHaveLength(0);
    expect(destroyed.scene.advanceWheelWinFeatureCharacterCapture(1_500)).toBe(false);
  });

  it("keeps the Wheel WIN_FEATURE semantic handoff clock live under reduced motion", () => {
    const { scene, monster } = createHarness();
    scene.setReducedMotion(true);

    scene.playCharacterAnimation("win", false);
    const winEntry = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
    advance(scene, 1_499);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toBe(winEntry);

    advance(scene, 1);
    const featureIdleEntry = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
    expect(featureIdleEntry?.animation.name).toBe("feature_idle");
    expect(featureIdleEntry?.mixingFrom).toBe(winEntry);
    advance(scene, 150);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toBe(featureIdleEntry);
    expect(monster.state.setAnimation.mock.calls.filter(
      ([track, animation]) => track === PRIMAL_CHARACTER_TRACK.body
        && animation === "feature_idle",
    )).toHaveLength(1);
  });

  it.each([
    [1_499, "win", 1.499, null, false],
    [1_500, "idle", 0, "win", true],
    [1_650, "idle", 0.15, null, true],
  ] as const)(
    "steps the paused Base WIN capture clock to exactly %sms",
    (elapsedMs, animation, trackTime, mixingFrom, idleSchedulerActive) => {
      const { scene, monster } = createHarness();
      Object.assign(scene as unknown as Record<string, unknown>, {
        persistentPresentation: { body: "base", auraLevel: null, palette: "main" },
      });
      scene.playCharacterAnimation("rage_collect", true, PRIMAL_CHARACTER_TRACK.overlay);
      scene.playCharacterAnimation("aura_2", true, PRIMAL_CHARACTER_TRACK.aura);
      scene.playCharacterAnimation("particles_loop", true, PRIMAL_CHARACTER_TRACK.particles);
      scene.playCharacterAnimation("Fs_bg_fire_color", false, PRIMAL_CHARACTER_TRACK.palette);
      const preservedTracks = new Map([0, 2, 3, 4].map((track) => [
        track,
        monster.state.getCurrent(track),
      ]));
      scene.playCharacterAnimation("win", false);
      expect(scene.setCharacterIntroCapturePaused(true)).toBe(true);
      monster.update.mockClear();

      expect(scene.advanceBaseWinCharacterCapture(elapsedMs)).toBe(true);

      const body = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
      expect(body?.animation.name).toBe(animation);
      expect(body?.trackTime).toBeCloseTo(trackTime, 6);
      expect(body?.mixingFrom?.animation.name ?? null).toBe(mixingFrom);
      expect(body?.mixDuration).toBe(0.15);
      expect(scene.getCharacterIntroLifecycleDiagnostics()).toMatchObject({
        capturePaused: true,
        idleSchedulerActive,
      });
      const positiveSteps = monster.update.mock.calls
        .map(([deltaSeconds]) => deltaSeconds as number)
        .filter((deltaSeconds) => deltaSeconds > 0);
      expect(Math.max(...positiveSteps)).toBeLessThanOrEqual(0.064);
      expect(positiveSteps.reduce((sum, seconds) => sum + seconds, 0))
        .toBeCloseTo(elapsedMs / 1_000, 9);
      if (elapsedMs === 1_650) {
        let cumulative = 0;
        const boundaries = positiveSteps.map((seconds) => (cumulative += seconds));
        expect(boundaries.some((seconds) => Math.abs(seconds - 1.5) < 0.000_001)).toBe(true);
      }
      expect(monster.update).toHaveBeenLastCalledWith(0);
      for (const [track, entry] of preservedTracks) {
        expect(monster.state.getCurrent(track)).toBe(entry);
      }
    },
  );

  it("rejects Base WIN fixture stepping unless authored playback is paused and canonical", () => {
    const { scene } = createHarness();
    Object.assign(scene as unknown as Record<string, unknown>, {
      persistentPresentation: { body: "base", auraLevel: null, palette: "main" },
    });
    scene.playCharacterAnimation("win", false);
    expect(scene.advanceBaseWinCharacterCapture(1_499)).toBe(false);
    expect(scene.setCharacterIntroCapturePaused(true)).toBe(true);
    expect(scene.advanceBaseWinCharacterCapture(1_498)).toBe(false);
    scene.setReducedMotion(true);
    expect(scene.advanceBaseWinCharacterCapture(1_499)).toBe(false);
  });

  it("cancels a stale Base WIN handoff when a later body state takes over", () => {
    const { scene, monster } = createHarness();
    Object.assign(scene as unknown as Record<string, unknown>, {
      persistentPresentation: { body: "base", auraLevel: null, palette: "main" },
    });

    scene.playCharacterAnimation("win", false);
    advance(scene, 1_000);
    scene.playCharacterAnimation("chest_pound", true);
    const takeoverEntry = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);

    advance(scene, 501);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toBe(takeoverEntry);
    expect(monster.state.setAnimation.mock.calls.filter(
      ([track, animation]) => track === PRIMAL_CHARACTER_TRACK.body && animation === "idle",
    )).toHaveLength(0);
  });

  it("keeps the Base WIN state handoff clock authoritative under reduced motion", () => {
    const { scene, monster } = createHarness();
    Object.assign(scene as unknown as Record<string, unknown>, {
      persistentPresentation: { body: "base", auraLevel: null, palette: "main" },
    });
    scene.setReducedMotion(true);

    scene.playCharacterAnimation("win", false);
    const winEntry = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
    advance(scene, 1_499);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toBe(winEntry);

    advance(scene, 1);
    const idleEntry = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);
    expect(idleEntry?.animation.name).toBe("idle");
    expect(idleEntry?.mixingFrom).toBe(winEntry);
    advance(scene, 150);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)).toBe(idleEntry);
    expect(monster.state.setAnimation.mock.calls.filter(
      ([track, animation]) => track === PRIMAL_CHARACTER_TRACK.body && animation === "idle",
    )).toHaveLength(1);
  });

  it("gates aura until INTRO_HIDE and preserves its entries through LOOP", () => {
    const { scene, monster } = createHarness();
    Object.assign(scene as unknown as Record<string, unknown>, {
      persistentPresentation: { body: "base", auraLevel: 2, palette: "main" },
    });
    scene.startAuthoredIntro();
    scene.seekAuthoredIntro(4_700);
    const callsBeforeCue = monster.state.setAnimation.mock.calls.length;

    scene.setCharacterAuraLevel(2);
    expect(monster.state.setAnimation).toHaveBeenCalledTimes(callsBeforeCue);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.aura)).toBeNull();
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.particles)).toBeNull();

    scene.releaseAuthoredIntroAura();
    const auraEntry = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.aura);
    const particleEntry = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.particles);
    expect(auraEntry?.animation.name).toBe("aura_2");
    expect(particleEntry?.animation.name).toBe("particles_loop");
    scene.releaseAuthoredIntroAura();
    expect(monster.state.setAnimation.mock.calls.filter(
      ([track]) => track === PRIMAL_CHARACTER_TRACK.aura,
    )).toHaveLength(1);
    expect(monster.state.setAnimation.mock.calls.filter(
      ([track]) => track === PRIMAL_CHARACTER_TRACK.particles,
    )).toHaveLength(1);

    scene.seekAuthoredIntro(5_000);
    scene.completeAuthoredIntro(false);
    advance(scene, CHARACTER_INTRO_TASK_MS - 5_000);

    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.aura)).toBe(auraEntry);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.particles)).toBe(particleEntry);
    expect(auraEntry?.trackTime).toBeGreaterThan(0);
    expect(particleEntry?.trackTime).toBeGreaterThan(0);
    expect(scene.getCharacterIntroLifecycleDiagnostics()).toMatchObject({
      introActive: false,
      auraReleased: true,
      idleSchedulerActive: true,
    });
  });

  it("atomically finishes an active INTRO for reduced motion", () => {
    const { scene, monster } = createHarness();
    Object.assign(scene as unknown as Record<string, unknown>, {
      persistentPresentation: { body: "base", auraLevel: 2, palette: "main" },
    });
    scene.startAuthoredIntro();
    scene.seekAuthoredIntro(5_000);
    scene.completeAuthoredIntro(false);
    scene.setReducedMotion(true);

    expect(scene.completeActiveCharacterIntroForReducedMotion()).toBe(true);
    expect(monster.state.setAnimation).toHaveBeenLastCalledWith(
      PRIMAL_CHARACTER_TRACK.particles,
      "particles_loop",
      true,
    );
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)?.animation.name).toBe("idle");
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)?.mixingFrom?.animation.name)
      .toBe("intro");
    expect(scene.getCharacterIntroLifecycleDiagnostics()).toMatchObject({
      introActive: false,
      introElapsedMs: CHARACTER_INTRO_TASK_MS,
      bodyReleased: true,
      auraReleased: true,
      idleSchedulerActive: true,
    });
    expect(scene.completeActiveCharacterIntroForReducedMotion()).toBe(false);
  });

  it("holds and resumes only the post-timeline authored character clock", () => {
    const { scene, monster } = createHarness();
    Object.assign(scene as unknown as Record<string, unknown>, {
      persistentPresentation: { body: "base", auraLevel: null, palette: "main" },
    });
    scene.startAuthoredIntro();
    scene.seekAuthoredIntro(5_000);
    scene.completeAuthoredIntro(false);
    const intro = monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body);

    expect(scene.setCharacterIntroCapturePaused(true)).toBe(true);
    advance(scene, 1_000);
    expect(scene.getCharacterIntroLifecycleDiagnostics()).toMatchObject({
      introElapsedMs: 5_000,
      capturePaused: true,
    });
    expect(intro?.trackTime).toBe(5);

    expect(scene.setCharacterIntroCapturePaused(false)).toBe(true);
    advance(scene, CHARACTER_INTRO_TASK_MS - 5_000);
    expect(monster.state.getCurrent(PRIMAL_CHARACTER_TRACK.body)?.animation.name).toBe("idle");
    expect(scene.setCharacterIntroCapturePaused(true)).toBe(true);
    expect(scene.getCharacterIntroLifecycleDiagnostics().capturePaused).toBe(true);
  });

  it("plays an idle breaker to its full clip before explicitly restarting LOOP", () => {
    const { scene, monster } = createHarness();
    Object.assign(scene as unknown as Record<string, unknown>, {
      persistentPresentation: {
        body: "base",
        auraLevel: null,
        palette: "main",
      },
      idleSchedulerActive: true,
      idleResumeToBase: true,
    });
    const random = vi.spyOn(Math, "random").mockReturnValue(0);

    advance(scene, CHARACTER_IDLE_LOOP_MS);

    expect(monster.state.setAnimation).toHaveBeenLastCalledWith(
      PRIMAL_CHARACTER_TRACK.body,
      "idle_breaker",
      false,
    );
    expect(monster.state.addAnimation).not.toHaveBeenCalled();

    advance(scene, PRIMAL_CHARACTER_ANIMATION_MS.idleBreaker - 0.001);
    expect(monster.state.setAnimation).not.toHaveBeenCalledWith(
      PRIMAL_CHARACTER_TRACK.body,
      "idle",
      true,
    );

    advance(scene, 0.002);
    expect(monster.state.setAnimation).toHaveBeenLastCalledWith(
      PRIMAL_CHARACTER_TRACK.body,
      "idle",
      true,
    );
    random.mockRestore();
  });

  it("zero-mixes Base idle and freezes only the random scheduler for capture", () => {
    const { scene, monster } = createHarness();
    Object.assign(scene as unknown as Record<string, unknown>, {
      persistentPresentation: {
        body: "base",
        auraLevel: null,
        palette: "main",
      },
      idleSchedulerActive: false,
      idleResumeRemainingMs: PRIMAL_CHARACTER_ANIMATION_MS.idleBreaker,
      idleResumeToBase: true,
    });

    expect(scene.prepareNeutralBaseCapture()).toBe(true);
    expect(monster.skeleton.setToSetupPose).toHaveBeenCalledTimes(1);
    expect(monster.state.clearTrack).toHaveBeenCalledWith(PRIMAL_CHARACTER_TRACK.body);
    expect(monster.state.setAnimation).toHaveBeenLastCalledWith(
      PRIMAL_CHARACTER_TRACK.body,
      "idle",
      true,
    );
    expect(monster.entries.at(-1)?.mixDuration).toBe(0);
    expect(monster.update).toHaveBeenLastCalledWith(0);
    const state = scene as unknown as {
      idleSchedulerActive: boolean;
      idleLoopElapsedMs: number;
      idleResumeRemainingMs: number;
      visualCaptureIdleSuspended: boolean;
    };
    expect(state).toMatchObject({
      idleSchedulerActive: false,
      idleLoopElapsedMs: 0,
      idleResumeRemainingMs: 0,
      visualCaptureIdleSuspended: true,
    });

    const beforeAdvance = monster.state.setAnimation.mock.calls.length;
    advance(scene, CHARACTER_IDLE_LOOP_MS * 2);
    expect(monster.state.setAnimation).toHaveBeenCalledTimes(beforeAdvance);
  });

  it("does not steal intro or feature body ownership for screenshot conditioning", () => {
    const feature = createHarness();
    expect(feature.scene.prepareNeutralBaseCapture()).toBe(false);
    expect(feature.monster.state.setAnimation).not.toHaveBeenCalled();

    const intro = createHarness();
    Object.assign(intro.scene as unknown as Record<string, unknown>, {
      characterIntroActive: true,
      persistentPresentation: {
        body: "base",
        auraLevel: null,
        palette: "main",
      },
    });
    expect(intro.scene.prepareNeutralBaseCapture()).toBe(false);
    expect(intro.monster.state.setAnimation).not.toHaveBeenCalled();
  });

  it("reports read-only current-track evidence for browser fixtures", () => {
    const { scene, monster } = createHarness();
    monster.state.getCurrent.mockImplementation((track: number) => (
      track === PRIMAL_CHARACTER_TRACK.body
        ? {
            animation: { name: "idle" },
            animationEnd: CHARACTER_DURATION_SECONDS.idle ?? 1,
            mixDuration: 0.15,
            mixTime: 0,
            trackTime: 0.75,
            mixingFrom: null,
            next: null,
          }
        : null
    ));

    expect(scene.getCharacterTrackDiagnostics()).toEqual([
      { track: 0, animation: null, trackTime: null, mixingFrom: null, mixDuration: null },
      { track: 1, animation: "idle", trackTime: 0.75, mixingFrom: null, mixDuration: 0.15 },
      { track: 2, animation: null, trackTime: null, mixingFrom: null, mixDuration: null },
      { track: 3, animation: null, trackTime: null, mixingFrom: null, mixDuration: null },
      { track: 4, animation: null, trackTime: null, mixingFrom: null, mixDuration: null },
    ]);
  });
});
