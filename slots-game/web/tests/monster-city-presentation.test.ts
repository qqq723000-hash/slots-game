import { describe, expect, it, vi } from "vitest";
import {
  PRIMAL_BACKGROUND_AUX_TRACKS,
  PRIMAL_BACKGROUND_TRACK,
  authoredBackgroundTransition,
  monsterReactionFrame,
} from "../src/renderer/CityBackdrop";
import {
  CHARACTER_BODY_CONTINUATION_ANIMATION,
  CHARACTER_IDLE_LOOP_MS,
  PRIMAL_DESKTOP_CHARACTER_HOST_SCALE,
  PRIMAL_DESKTOP_CHARACTER_SKELETON_TRANSFORM,
  PRIMAL_CHARACTER_TRACK,
  characterCollectAnimationForRandom,
  characterIdleBreakerForRandom,
} from "../src/renderer/intro/LaunchScene";
import {
  PixiRenderer,
  featureIntroCharacterPresentation,
  persistentFeatureVisualPlan,
} from "../src/renderer/PixiRenderer";
import {
  AUTHORED_INTRO_TIMING_MS,
  INTRO_CUES,
  INTRO_DURATION_MS,
  introFrameAt,
} from "../src/startup/introTimeline";

describe("monster-city presentation timing", () => {
  it("keeps the desktop character root independent from cabinet responsiveness", () => {
    expect(PRIMAL_DESKTOP_CHARACTER_HOST_SCALE).toBe(1);
    expect(PRIMAL_DESKTOP_CHARACTER_SKELETON_TRANSFORM).toEqual({
      x: 0,
      y: 360,
      scale: 0.72,
    });

    // 在 1280×720 下，捕获到的原始脚趾底边（462.346）换算为 692.889。 / English: At 1280×720, the original toe base captured (462.346) translates to 692.889.
    // 若父级组合缩放为 1.05，会错误地将其移到 727.533。 / English: A parent combo scale of 1.05 would incorrectly move it to 727.533.
    const rawToeBottom = 462.346;
    const authoredBottom = 360 + rawToeBottom * 0.72;
    const compoundedBottom = 360 * 1.05 + rawToeBottom * 0.72 * 1.05;
    expect(authoredBottom).toBeCloseTo(692.889_12, 4);
    expect(compoundedBottom).toBeCloseTo(727.533_576, 4);
  });

  it("uses the original ten-second equal-probability idle-break selector", () => {
    expect(CHARACTER_IDLE_LOOP_MS).toBe(10_000);
    expect(characterIdleBreakerForRandom(0)).toBe("idle_breaker");
    expect(characterIdleBreakerForRandom(0.333_334)).toBe("idle_breaker2");
    expect(characterIdleBreakerForRandom(0.666_667)).toBe("idle_breaker3");
    expect(characterIdleBreakerForRandom(1)).toBe("idle_breaker3");
    expect(characterIdleBreakerForRandom(Number.NaN)).toBe("idle_breaker");
    expect(characterCollectAnimationForRandom(0)).toBe("idle_breaker2");
    expect(characterCollectAnimationForRandom(0.333_334)).toBe("chest_pound");
    expect(characterCollectAnimationForRandom(0.666_667)).toBe("win");
    expect(PRIMAL_CHARACTER_TRACK).toEqual({
      overlay: 0,
      body: 1,
      aura: 2,
      particles: 3,
      palette: 4,
    });
  });

  it("keeps explicit base, feature, and Kong Quest body continuations", () => {
    expect(CHARACTER_BODY_CONTINUATION_ANIMATION).toEqual({
      base: "idle",
      feature: "feature_idle",
      kq: "reel_stretch_waiting",
    });
    expect(persistentFeatureVisualPlan({ mode: "BASE", rageLevel: 1 })).toEqual({
      backdrop: "main",
      character: { body: "base", auraLevel: null, palette: "main" },
    });
    expect(persistentFeatureVisualPlan({ mode: "BASE", rageLevel: 2 })).toEqual({
      backdrop: "main",
      character: { body: "base", auraLevel: 2, palette: "main" },
    });
    expect(persistentFeatureVisualPlan({ mode: "BASE", rageLevel: 4 }).character.auraLevel).toBe(4);
    expect(persistentFeatureVisualPlan({ mode: "EXPANSION", rageLevel: 1 })).toEqual({
      backdrop: "fire",
      character: { body: "kq", auraLevel: 1, palette: "fire" },
    });
    expect(persistentFeatureVisualPlan({ mode: "OVERDRIVE", rageLevel: 1 })).toEqual({
      backdrop: "snow",
      character: { body: "feature", auraLevel: 1, palette: "snow" },
    });
    expect(featureIntroCharacterPresentation("EXPANSION")).toEqual({
      body: "feature",
      auraLevel: 1,
      palette: "fire",
    });
    expect(featureIntroCharacterPresentation("OVERDRIVE")).toEqual({
      body: "feature",
      auraLevel: 1,
      palette: "snow",
    });
  });

  it("uses the original background base, transition, aux, and shake tracks", () => {
    expect(PRIMAL_BACKGROUND_TRACK).toEqual({
      mobile: 0,
      base: 1,
      transition: 2,
      auxBegin: 3,
      auxEnd: 14,
      cannon: 15,
      shake: 16,
    });
    expect(PRIMAL_BACKGROUND_AUX_TRACKS.main).toContainEqual([3, "bg_main_Clouds_Loop"]);
    expect(PRIMAL_BACKGROUND_AUX_TRACKS.fire).toContainEqual([12, "smoke_2_main_and_fire"]);
    expect(PRIMAL_BACKGROUND_AUX_TRACKS.snow).toEqual([]);
    expect(authoredBackgroundTransition("main", "fire")).toBe("bg_main_to_fire");
    expect(authoredBackgroundTransition("main", "snow")).toBe("bg_main_to_snow");
    expect(authoredBackgroundTransition("fire", "main")).toBe("bg_fire_to_main");
    expect(authoredBackgroundTransition("snow", "main")).toBe("bg_snow_to_main");
  });

  it("uses the measured native Spine and premix milestones", () => {
    expect(INTRO_DURATION_MS).toBe(5_000);
    expect(AUTHORED_INTRO_TIMING_MS).toEqual({
      logoEnd: 4_700,
      characterOffscreenEnd: 3_066.667,
      characterImpact: 3_233.3,
      characterCompression: 3_566.667,
      characterSettled: 3_866.667,
      characterEnd: 8_066.701,
      backgroundEnd: 7_300,
      audioEnd: 10_086.19,
      chromeRevealStart: 4_700,
      chromeRevealEnd: 5_000,
    });
    expect(INTRO_CUES.map(({ name, atMs }) => [name, atMs])).toEqual([
      ["audio.game-intro", 0],
      ["city.establish", 0],
      ["colossus.descent", 3_066.667],
      ["city.impact", 3_233.3],
      ["colossus.settled", 3_866.667],
      ["hud.reveal", 4_700],
      ["launch.ready", 5_000],
    ]);
  });

  it("releases the authored character aura at the HUD reveal cue", () => {
    const releaseAuthoredIntroAura = vi.fn();
    const renderer = Object.create(PixiRenderer.prototype) as PixiRenderer;
    Object.assign(renderer, {
      launchScene: { releaseAuthoredIntroAura },
    });

    renderer.cueIntro("hud.reveal");

    expect(releaseAuthoredIntroAura).toHaveBeenCalledTimes(1);
  });

  it("keeps character intro capture seams as transparent LaunchScene forwarders", () => {
    const diagnostics = Object.freeze({
      introActive: true,
      introElapsedMs: 5_000,
      taskDurationMs: 8_066,
      timelineControlled: false,
      bodyReleased: false,
      auraReleased: true,
      idleSchedulerActive: false,
      capturePaused: true,
    });
    const completeActiveCharacterIntroForReducedMotion = vi.fn(() => true);
    const setCharacterIntroCapturePaused = vi.fn(() => true);
    const advanceBaseWinCharacterCapture = vi.fn(() => true);
    const advanceWheelWinFeatureCharacterCapture = vi.fn(() => true);
    const getCharacterIntroLifecycleDiagnostics = vi.fn(() => diagnostics);
    const renderer = Object.create(PixiRenderer.prototype) as PixiRenderer;
    Object.assign(renderer, {
      launchScene: {
        completeActiveCharacterIntroForReducedMotion,
        setCharacterIntroCapturePaused,
        advanceBaseWinCharacterCapture,
        advanceWheelWinFeatureCharacterCapture,
        getCharacterIntroLifecycleDiagnostics,
      },
    });

    expect(renderer.completeActiveCharacterIntroForReducedMotion()).toBe(true);
    expect(renderer.setCharacterIntroCapturePaused(true)).toBe(true);
    expect(renderer.advanceBaseWinCharacterCapture(1_500)).toBe(true);
    expect(renderer.advanceWheelWinFeatureCharacterCapture(1_650)).toBe(true);
    expect(renderer.getCharacterIntroLifecycleCaptureDiagnostics()).toBe(diagnostics);
    expect(completeActiveCharacterIntroForReducedMotion).toHaveBeenCalledTimes(1);
    expect(setCharacterIntroCapturePaused).toHaveBeenCalledTimes(1);
    expect(setCharacterIntroCapturePaused).toHaveBeenCalledWith(true);
    expect(advanceBaseWinCharacterCapture).toHaveBeenCalledTimes(1);
    expect(advanceBaseWinCharacterCapture).toHaveBeenCalledWith(1_500);
    expect(advanceWheelWinFeatureCharacterCapture).toHaveBeenCalledWith(1_650);
    expect(getCharacterIntroLifecycleDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("appends the live renderer screen and resolution to cabinet diagnostics", () => {
    const cabinet = Object.freeze({
      activeRows: 3,
      frameMode: "authored" as const,
    });
    const getCabinetCompositionDiagnostics = vi.fn(() => cabinet);
    const renderer = Object.create(PixiRenderer.prototype) as PixiRenderer;
    Object.assign(renderer, {
      reels: { getCabinetCompositionDiagnostics },
      app: {
        renderer: {
          screen: { width: 1_219, height: 720 },
          resolution: 2,
        },
      },
    });

    const diagnostics = renderer.getReelCabinetCompositionDiagnostics();

    expect(diagnostics).toEqual({
      activeRows: 3,
      frameMode: "authored",
      renderer: { screenWidth: 1_219, screenHeight: 720, resolution: 2 },
    });
    expect(Object.isFrozen(diagnostics)).toBe(true);
    expect(Object.isFrozen(diagnostics.renderer)).toBe(true);
    expect(getCabinetCompositionDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("never slides the character or logo horizontally during the launch", () => {
    for (const timeMs of [0, 700, 3_066.667, 3_233.3, 4_700, INTRO_DURATION_MS]) {
      const frame = introFrameAt(timeMs);
      expect(frame.logoX).toBe(640);
      expect(frame.colossusX).toBe(640);
      expect(frame.colossusY).toBe(0);
      expect(frame.colossusScale).toBe(1);
      expect(frame.cameraZoom).toBe(1);
      expect(frame.cameraY).toBe(0);
      expect(frame.shockwave).toBe(0);
    }
  });

  it("fades fixed-geometry game chrome only after the 4.7s logo track", () => {
    const city = introFrameAt(1_000);
    expect(city.worldAlpha).toBe(1);
    expect(city.logoAlpha).toBe(1);
    expect(city.colossusAlpha).toBe(1);
    expect(city.reelProgress).toBe(0);
    expect(city.hudProgress).toBe(0);

    const beforeChrome = introFrameAt(4_699);
    expect(beforeChrome.logoAlpha).toBe(1);
    expect(beforeChrome.reelProgress).toBe(0);
    expect(beforeChrome.hudProgress).toBe(0);

    const controls = introFrameAt(4_850);
    expect(controls.logoAlpha).toBe(0);
    expect(controls.reelProgress).toBeGreaterThan(0);
    expect(controls.reelProgress).toBeLessThan(1);
    expect(controls.hudProgress).toBeGreaterThan(0);
    expect(controls.hudProgress).toBeLessThan(1);

    const ready = introFrameAt(5_000);
    expect(ready.reelProgress).toBe(1);
    expect(ready.hudProgress).toBe(1);
  });

  it("uses a bounded cosmetic rage response and removes flashes in reduced motion", () => {
    expect(monsterReactionFrame(0, false)).toEqual({
      eyeBoost: 0,
      pulseAlpha: 0,
      pulseScale: 0.58,
      lightningAlpha: 0,
    });

    const active = monsterReactionFrame(0.5, false);
    expect(active.eyeBoost).toBeGreaterThan(0.7);
    expect(active.pulseAlpha).toBeLessThanOrEqual(0.42);
    expect(active.lightningAlpha).toBeGreaterThan(0);

    const reduced = monsterReactionFrame(0.5, true);
    expect(reduced.eyeBoost).toBeGreaterThan(0);
    expect(reduced.lightningAlpha).toBe(0);

    expect(monsterReactionFrame(1, false).eyeBoost).toBeCloseTo(0, 10);
    expect(monsterReactionFrame(1, false).pulseAlpha).toBeCloseTo(0, 10);
  });
});
