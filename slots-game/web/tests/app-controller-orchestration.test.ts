import { describe, expect, it, vi } from "vitest";
import {
  AppController,
  anticipationAudioFadeMs,
  bindFastPlayPreference,
  bindUiPanelAudio,
  characterWinPresentation,
  freeSpinHudStateBeforeAwards,
  freeSpinHudStateForPresentation,
  mapPreloadToVisibleProgress,
  PRIMAL_POST_WIN_IDLE_INTRO_MS,
  symbolWinTierFor,
  type AppPresentationCheckpoint,
  type AppPresentationTrace,
} from "../src/app/AppController";
import type { UiPanelHandler } from "../src/ui/DomOverlay";
import type {
  CellAddress,
  FeatureEvent,
  FeatureState,
  GameSnapshot,
  GridCell,
  SessionOpened,
  SpinResult,
  Win,
  WheelAwardedEvent,
} from "../src/app/state/types";
import { GameStateMachine } from "../src/app/state/GameStateMachine";
import {
  PRIMAL_WHEEL_TIMELINE_MS,
  WHEEL_CHARACTER_TIMING_MS,
} from "../src/renderer/FeatureEffects";
import {
  formatFreeSpinCounter,
  projectFreeSpinHud,
} from "../src/renderer/FreeSpinHudView";
import {
  PixiRenderer,
  characterReelStructurePlan,
  type FeaturePresentationBranch,
  type FeaturePresentationInputGate,
  type FeaturePresentationMilestone,
} from "../src/renderer/PixiRenderer";
import { createSpinEnvironmentState } from "../src/renderer/spinEnvironmentMotion";
import type { CharacterAnimationEvent } from "../src/renderer/intro/LaunchScene";
import type { WinCelebrationResidentFacts } from "../src/renderer/WinCelebration";
import { BIG_WIN_CONTROLLER_LEAD_IN_MS } from "../src/renderer/BigWinView";
import { ReelRoundStateMachine } from "../src/reels/ReelRoundStateMachine";
import { LaunchStateMachine } from "../src/startup/LaunchStateMachine";
import type { PreloadProgress } from "../src/startup/PreloadGate";

const BASE_FEATURE: FeatureState = {
  mode: "BASE",
  freeSpinsRemaining: 0,
  rageLevel: 1,
  rageCollected: 0,
};

const SAFE_RESULT_ERROR = "The game result could not be displayed. Please contact support if this continues.";

const BASE_LEVEL_TWO_FEATURE: FeatureState = {
  ...BASE_FEATURE,
  rageLevel: 2,
  rageCollected: 12,
};

const BASE_GRID = Array.from({ length: 3 }, () => [
  { symbol: "ORBIT" as const },
  { symbol: "PRISM" as const },
  { symbol: "PULSE" as const },
]);

const GUARANTEED_RAGE_CELLS = [
  { reel: 0, row: 2 },
  { reel: 1, row: 2 },
  { reel: 2, row: 2 },
] as const;

const GUARANTEED_RAGE_EVENT = {
  type: "surge.collected" as const,
  count: 3,
  cells: GUARANTEED_RAGE_CELLS,
  triggered: true,
  guaranteed: true,
  level: 1,
  total: 0,
};

function guaranteedRageGrid(): GridCell[][] {
  return BASE_GRID.map((reel) => reel.map((cell, rowIndex) => (
    rowIndex === 2 ? { symbol: "SURGE" as const } : cell
  )));
}

function freeSpinVaultGrid(rows: readonly number[]): GridCell[][] {
  const selected = new Set(rows);
  return BASE_GRID.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
    reelIndex === 1 && selected.has(rowIndex)
      ? { symbol: "VAULT" as const, prize: "FREE_SPIN" }
      : cell
  )));
}

interface FeatureAudioState {
  rageLevel: number;
  showFreeSpinSummary: boolean;
  wasFreeSpins?: boolean;
  vaultTeaseExtraHold?: boolean;
  vaultCells?: readonly Readonly<CellAddress>[];
  hudState?: FeatureState;
  featureExitStarted?: boolean;
}

interface ControllerPrototypeHarness {
  presentPostReelFeatureEvents(
    events: readonly FeatureEvent[],
    featureState: FeatureState,
    reducedMotion: boolean,
    audioState: FeatureAudioState,
  ): Promise<void>;
  presentPostReelFeatureEvent(
    event: FeatureEvent,
    featureState: FeatureState,
    reducedMotion: boolean,
    audioState: FeatureAudioState,
  ): Promise<void>;
  presentPostReelFeatureEventBody(
    event: FeatureEvent,
    featureState: FeatureState,
    reducedMotion: boolean,
    audioState: FeatureAudioState,
  ): Promise<void>;
  presentFeatureAudio(
    event: FeatureEvent,
    reducedMotion: boolean,
    audioState: FeatureAudioState,
  ): void;
  presentFeaturePresentationMilestone(milestone: FeaturePresentationMilestone): void;
  observePresentationBranch(branch: FeaturePresentationBranch): void;
  requestFeaturePresentationInputCheckpoint(
    gate: FeaturePresentationInputGate,
  ): void | Promise<void>;
  requestSemanticPresentationCheckpoint(
    state: "wheel.popup-input-ready" | "wheel.input-ready" | "wheel.chest-loop-start" | "wheel.landing",
  ): void | Promise<void>;
  presentFreeSpinAwardBatch(
    events: readonly Extract<FeatureEvent, { type: "free_spin.awarded" }>[],
    featureState: FeatureState,
    reducedMotion: boolean,
    audioState: FeatureAudioState,
  ): Promise<void>;
  beginFreeSpinsExitOnce(state: FeatureAudioState | null, reducedMotion: boolean): boolean;
  scheduleFreeSpin(): void;
  schedulePostWinIdleRepeat(
    result: Readonly<SpinResult>,
    previousFeatureState: Readonly<FeatureState>,
    reducedMotion: boolean,
    fastPlay: boolean,
  ): void;
  presentEffect(effect: () => Promise<void>): Promise<void>;
  presentCharacterAudio(event: CharacterAnimationEvent): void;
  presentReelLandAudio(reel: number, cells: readonly GridCell[]): void;
  presentRoundWinCharacterAudio(presentation: "base" | "feature" | "kq"): void;
  presentBigWinAudio(milestone: { type: "show" | "count-start" | "level-up" | "count-end" | "hide-start" | "complete" }): void;
  requestSpin(): void;
  requestFastStop(): void;
  startRoundAudio(unlock: Promise<boolean>, reducedMotion: boolean): void;
  continueFeaturePreview(): void;
  presentIntroAudio(cue: { name: string; atMs: number }): void;
  handleSession(session: SessionOpened): void;
  handleStatus(status: "idle" | "connecting" | "online" | "recovering" | "offline"): void;
  handleSessionTimeout(timeout: Readonly<import("../src/protocol/GameGateway").GatewaySessionTimeout>): void;
  handleSpinResult(result: SpinResult, originFeatureState?: Readonly<FeatureState>): void;
  handleError(error: import("../src/app/state/types").ServerError | Error): void;
  rejectSpinResult(error: unknown): void;
  publishStartupProgress(progress: Readonly<PreloadProgress>): void;
  runLaunch(): Promise<void>;
  setCharacterIntroCapturePaused(paused: boolean): boolean;
  advanceBaseWinCharacterCapture(elapsedMs: number): boolean;
  advanceWheelWinFeatureCharacterCapture(elapsedMs: number): boolean;
  advanceWheelChestPoundCapture(elapsedMs: number): boolean;
  getWheelChestPoundDiagnostics(): unknown;
  getWheelChestPoundCaptureEnvironmentDiagnostics(): Readonly<{ fastPlay: boolean }>;
  getCharacterIntroLifecycleCaptureDiagnostics(): unknown;
  getReelCabinetCompositionDiagnostics(): unknown;
  destroy(): void;
  pendingWheelAward: WheelAwardedEvent | null;
  spinAudioGeneration: number;
  roundOriginFeatureState: FeatureState | null;
  featurePreviewResolver: (() => void) | null;
  featurePreviewContinuePending: boolean;
  initialSessionResolver: (() => void) | null;
  activeObservedFeatureEvents: Readonly<FeatureEvent>[];
  activePresentationSequence: number | null;
  destroyed: boolean;
  bigWinInFreeSpins: boolean;
  bigWinMusicResume: "ambient" | "free-spins";
  reducedMotion: boolean;
  reducedMotionMedia: MediaQueryList | null;
  scatterLandOrdinal: number;
  audio: Record<string, ReturnType<typeof vi.fn>>;
  launchClock: Record<string, ReturnType<typeof vi.fn>>;
  activeRoundFeatureAudioState: FeatureAudioState | null;
  freeSpinTimer: ReturnType<typeof setTimeout> | null;
  observeFeatureEvent(event: FeatureEvent, presentation: () => Promise<void>): Promise<void>;
}

function prototypeHarness(): ControllerPrototypeHarness {
  return Object.create(AppController.prototype) as ControllerPrototypeHarness;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AppController UI panel audio binding", () => {
  it("forwards open and close callbacks without changing panel state", () => {
    let openHandler: UiPanelHandler = () => undefined;
    let closeHandler: UiPanelHandler = () => undefined;
    const ui = {
      onPanelOpen(handler: UiPanelHandler) { openHandler = handler; },
      onPanelClose(handler: UiPanelHandler) { closeHandler = handler; },
    };
    const audio = {
      playUiOpen: vi.fn(),
      playUiClose: vi.fn(),
    };

    bindUiPanelAudio(ui, audio);
    openHandler("settings");
    closeHandler("settings");

    expect(audio.playUiOpen).toHaveBeenCalledTimes(1);
    expect(audio.playUiClose).toHaveBeenCalledTimes(1);
  });

  it("forwards Fast Play preference without selecting a Wheel result", () => {
    let fastPlayHandler: (enabled: boolean) => void = () => undefined;
    const ui = {
      onFastPlayChange(handler: (enabled: boolean) => void) {
        fastPlayHandler = handler;
      },
    };
    const renderer = { setWheelFastPlay: vi.fn() };
    const onPreferenceChange = vi.fn();

    bindFastPlayPreference(ui, renderer, onPreferenceChange);
    fastPlayHandler(true);
    fastPlayHandler(false);

    expect(renderer.setWheelFastPlay.mock.calls).toEqual([[true], [false]]);
    expect(onPreferenceChange.mock.calls).toEqual([[true], [false]]);
  });
});

describe("AppController authored character intro handoff", () => {
  const applyReducedMotionPreference = (
    controller: ControllerPrototypeHarness,
    matches: boolean,
  ): void => {
    const target = controller as unknown as {
      handleReducedMotionPreference(matches: boolean): void;
    };
    target.handleReducedMotionPreference(matches);
  };

  it("forwards browser-fixture pause and lifecycle diagnostics without mutation", () => {
    const controller = prototypeHarness();
    const diagnostics = Object.freeze({ introActive: true, introElapsedMs: 5_000 });
    const cabinetDiagnostics = Object.freeze({ activeRows: 3, frameMode: "authored" });
    const setCharacterIntroCapturePaused = vi.fn(() => true);
    const advanceBaseWinCharacterCapture = vi.fn(() => true);
    const advanceWheelWinFeatureCharacterCapture = vi.fn(() => true);
    const advanceWheelChestPoundCapture = vi.fn(() => true);
    const wheelChestDiagnostics = Object.freeze({
      schedulerFps: 30,
      periodMs: 115_000 / 30,
    });
    const getWheelChestPoundDiagnostics = vi.fn(() => wheelChestDiagnostics);
    const getCharacterIntroLifecycleCaptureDiagnostics = vi.fn(() => diagnostics);
    const getReelCabinetCompositionDiagnostics = vi.fn(() => cabinetDiagnostics);
    Object.assign(controller, {
      renderer: {
        setCharacterIntroCapturePaused,
        advanceBaseWinCharacterCapture,
        advanceWheelWinFeatureCharacterCapture,
        advanceWheelChestPoundCapture,
        getWheelChestPoundDiagnostics,
        getCharacterIntroLifecycleCaptureDiagnostics,
        getReelCabinetCompositionDiagnostics,
      },
      fastPlay: false,
    });

    expect(controller.setCharacterIntroCapturePaused(true)).toBe(true);
    expect(controller.advanceBaseWinCharacterCapture(1_650)).toBe(true);
    expect(controller.advanceWheelWinFeatureCharacterCapture(1_500)).toBe(true);
    expect(controller.advanceWheelChestPoundCapture(115_000 / 30)).toBe(true);
    expect(controller.getWheelChestPoundDiagnostics()).toBe(wheelChestDiagnostics);
    const environment = controller.getWheelChestPoundCaptureEnvironmentDiagnostics();
    expect(environment).toEqual({ fastPlay: false });
    expect(Object.isFrozen(environment)).toBe(true);
    expect(controller.getCharacterIntroLifecycleCaptureDiagnostics()).toBe(diagnostics);
    expect(controller.getReelCabinetCompositionDiagnostics()).toBe(cabinetDiagnostics);
    expect(setCharacterIntroCapturePaused).toHaveBeenCalledTimes(1);
    expect(setCharacterIntroCapturePaused).toHaveBeenCalledWith(true);
    expect(advanceBaseWinCharacterCapture).toHaveBeenCalledTimes(1);
    expect(advanceBaseWinCharacterCapture).toHaveBeenCalledWith(1_650);
    expect(advanceWheelWinFeatureCharacterCapture).toHaveBeenCalledWith(1_500);
    expect(advanceWheelChestPoundCapture).toHaveBeenCalledWith(115_000 / 30);
    expect(getWheelChestPoundDiagnostics).toHaveBeenCalledTimes(1);
    expect(getCharacterIntroLifecycleCaptureDiagnostics).toHaveBeenCalledTimes(1);
    expect(getReelCabinetCompositionDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("completes a post-ready character tail and fades intro audio exactly once", () => {
    const controller = prototypeHarness();
    const completeActiveCharacterIntroForReducedMotion = vi.fn(() => true);
    const stopGameIntro = vi.fn();
    const skip = vi.fn();
    Object.assign(controller, {
      launch: { phase: "ready" },
      renderer: { completeActiveCharacterIntroForReducedMotion },
      audio: { stopGameIntro },
      intro: { skip },
    });

    applyReducedMotionPreference(controller, true);

    expect(completeActiveCharacterIntroForReducedMotion).toHaveBeenCalledTimes(1);
    expect(stopGameIntro).toHaveBeenCalledTimes(1);
    expect(stopGameIntro).toHaveBeenCalledWith(200);
    expect(skip).not.toHaveBeenCalled();
  });

  it("does not fade intro audio when no post-ready character tail is active", () => {
    const controller = prototypeHarness();
    const completeActiveCharacterIntroForReducedMotion = vi.fn(() => false);
    const stopGameIntro = vi.fn();
    Object.assign(controller, {
      launch: { phase: "ready" },
      renderer: { completeActiveCharacterIntroForReducedMotion },
      audio: { stopGameIntro },
      intro: { skip: vi.fn() },
    });

    applyReducedMotionPreference(controller, true);

    expect(completeActiveCharacterIntroForReducedMotion).toHaveBeenCalledTimes(1);
    expect(stopGameIntro).not.toHaveBeenCalled();
  });

  it("preserves the intro-phase skip path without invoking the tail seam", () => {
    const controller = prototypeHarness();
    const completeActiveCharacterIntroForReducedMotion = vi.fn(() => true);
    const stopGameIntro = vi.fn();
    const skip = vi.fn();
    Object.assign(controller, {
      launch: { phase: "intro" },
      renderer: { completeActiveCharacterIntroForReducedMotion },
      audio: { stopGameIntro },
      intro: { skip },
    });

    applyReducedMotionPreference(controller, true);

    expect(stopGameIntro).toHaveBeenCalledTimes(1);
    expect(stopGameIntro).toHaveBeenCalledWith(200);
    expect(skip).toHaveBeenCalledTimes(1);
    expect(completeActiveCharacterIntroForReducedMotion).not.toHaveBeenCalled();
  });

  it("ignores reduced-motion deactivation", () => {
    const controller = prototypeHarness();
    const completeActiveCharacterIntroForReducedMotion = vi.fn(() => true);
    const stopGameIntro = vi.fn();
    Object.assign(controller, {
      launch: { phase: "ready" },
      renderer: { completeActiveCharacterIntroForReducedMotion },
      audio: { stopGameIntro },
      intro: { skip: vi.fn() },
    });

    applyReducedMotionPreference(controller, false);

    expect(completeActiveCharacterIntroForReducedMotion).not.toHaveBeenCalled();
    expect(stopGameIntro).not.toHaveBeenCalled();
  });
});

describe("AppController visible startup progress", () => {
  const progressEvent = (
    progress: number,
    status: PreloadProgress["status"] = "running",
  ): PreloadProgress => ({
    stage: status === "complete" ? "complete" : "assets",
    taskName: status === "complete" ? null : "entry-critical-resources",
    status,
    taskFraction: progress,
    completedWeight: progress * 100,
    totalWeight: 100,
    progress,
  });

  it("maps the preload interval onto the visible 5%..100% interval", () => {
    expect(mapPreloadToVisibleProgress(progressEvent(0)).progress).toBe(0.05);
    expect(mapPreloadToVisibleProgress(progressEvent(0.5)).progress).toBeCloseTo(0.525);
    expect(mapPreloadToVisibleProgress(progressEvent(1)).progress).toBe(1);

    const complete = mapPreloadToVisibleProgress(progressEvent(0.4, "complete"));
    expect(complete.progress).toBe(1);
    expect(Object.isFrozen(complete)).toBe(true);
  });

  it("publishes exactly the same visible value to root datasets and DomOverlay", () => {
    const controller = prototypeHarness();
    const dataset: Record<string, string> = {};
    const delivered: Readonly<PreloadProgress>[] = [];
    Object.assign(controller, {
      root: { dataset },
      ui: { setStartupProgress: (event: Readonly<PreloadProgress>) => delivered.push(event) },
    });

    controller.publishStartupProgress(progressEvent(0.5));

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.progress).toBeCloseTo(0.525);
    const encoded = delivered[0]?.progress.toFixed(6);
    expect(dataset.startupReadinessProgress).toBe(encoded);
    expect(dataset.startupAssemblyProgress).toBe(encoded);
    expect(dataset.launchProgress).toBe(encoded);

    controller.publishStartupProgress(progressEvent(0.2, "complete"));
    expect(delivered.at(-1)?.progress).toBe(1);
    expect(dataset.startupReadinessProgress).toBe("1.000000");
    expect(dataset.startupAssemblyProgress).toBe("1.000000");
    expect(dataset.launchProgress).toBe("1.000000");
  });
});

describe("captured character and symbol win routing", () => {
  it("keeps terminal/triggering feature rounds on their authored character states", () => {
    expect(characterWinPresentation("BASE", "BASE")).toBe("base");
    expect(characterWinPresentation("BASE", "EXPANSION")).toBe("feature");
    expect(characterWinPresentation("BASE", "OVERDRIVE")).toBe("feature");
    expect(characterWinPresentation("EXPANSION", "BASE")).toBe("kq");
    expect(characterWinPresentation("OVERDRIVE", "BASE")).toBe("feature");
  });

  it("distinguishes Kong Quest decrease from the base reel reset", () => {
    expect(characterReelStructurePlan("shrink", "EXPANSION")).toEqual({
      animation: "reel_smash",
      continuation: "kq",
      audioMilestone: "reels.decrease-kq",
    });
    expect(characterReelStructurePlan("shrink", "BASE")).toEqual({
      animation: "reel_smash",
      continuation: "base",
      audioMilestone: "reels.reset-base",
    });
    expect(characterReelStructurePlan("expand", "EXPANSION")).toEqual({
      animation: "reel_stretch",
      continuation: "kq",
      audioMilestone: null,
    });
  });

  it("routes pathless win sound from the record symbol, not substituted Wild cells", () => {
    expect(symbolWinTierFor({
      symbol: "TANK",
      cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
    }, [
      [{ symbol: "TANK" }],
      [{ symbol: "WILD" }],
      [{ symbol: "TANK" }],
    ])).toBe("hp1");
    expect(symbolWinTierFor({
      symbol: "SURGE",
      cells: [{ reel: 1, row: 0 }],
    }, [[{ symbol: "ORBIT" }], [{ symbol: "WILD" }]])).toBeNull();
    expect(symbolWinTierFor({
      symbol: "VAULT",
      cells: [{ reel: 1, row: 0 }],
    })).toBeNull();
    expect(symbolWinTierFor({
      symbol: "FUTURE_BONUS_ONLY" as never,
      cells: [{ reel: 1, row: 0 }],
    })).toBeNull();
  });

  it("keeps Rage/Scatter and Wild land programs centred on every reel", () => {
    const controller = prototypeHarness();
    const playScatterLand = vi.fn();
    const playWildLand = vi.fn();
    Object.assign(controller, {
      audio: { playScatterLand, playWildLand },
      scatterLandOrdinal: 0,
      reducedMotion: false,
      reducedMotionMedia: null,
    });

    controller.presentReelLandAudio(0, [
      { symbol: "SURGE" },
      { symbol: "WILD" },
      { symbol: "ORBIT" },
    ]);
    controller.presentReelLandAudio(2, [
      { symbol: "WILD" },
      { symbol: "SURGE" },
      { symbol: "ORBIT" },
    ]);

    expect(playScatterLand).toHaveBeenNthCalledWith(
      1,
      1,
      { pan: 0, intensity: 1, reducedMotion: false },
    );
    expect(playScatterLand).toHaveBeenNthCalledWith(
      2,
      2,
      { pan: 0, intensity: 1, reducedMotion: false },
    );
    expect(playWildLand).toHaveBeenCalledTimes(2);
    expect(playWildLand).toHaveBeenNthCalledWith(
      1,
      { pan: 0, intensity: 1, reducedMotion: false },
    );
    expect(playWildLand).toHaveBeenNthCalledWith(
      2,
      { pan: 0, intensity: 1, reducedMotion: false },
    );
  });
});

describe("AppController feature orchestration seams", () => {
  it("binds semantic Wheel and Kong barriers to the active result sequence", async () => {
    const controller = prototypeHarness();
    const checkpoints: AppPresentationCheckpoint[] = [];
    const order: string[] = [];
    Object.assign(controller, {
      activePresentationSequence: 5,
      destroyed: false,
      presentationObserver: {
        onPresentationCheckpoint: async (checkpoint: AppPresentationCheckpoint) => {
          checkpoints.push(checkpoint);
          order.push("checkpoint");
        },
      },
      audio: {
        playVaultFly: vi.fn(() => order.push("audio")),
      },
      renderer: {
        presentFreeSpinAwardBatch: vi.fn(async () => {
          order.push("visual");
        }),
      },
    });
    controller.presentEffect = async (effect) => effect();

    await controller.presentFreeSpinAwardBatch(
      [{ type: "free_spin.awarded", count: 1, reel: 1, row: 2 }],
      {
        mode: "EXPANSION",
        freeSpinsRemaining: 5,
        freeSpinsPlayed: 4,
        baseBetMinor: "100",
        freeSpinsWinMinor: "0",
        rageLevel: 1,
        rageCollected: 0,
      },
      false,
      { rageLevel: 1, showFreeSpinSummary: false },
    );
    await controller.requestSemanticPresentationCheckpoint("wheel.chest-loop-start");
    await controller.requestSemanticPresentationCheckpoint("wheel.landing");

    expect(order).toEqual([
      "audio", "visual", "checkpoint", "checkpoint", "checkpoint",
    ]);
    expect(checkpoints).toEqual([
      {
        type: "semantic-state",
        state: "kong.retrigger-applied",
        sequence: 5,
      },
      {
        type: "semantic-state",
        state: "wheel.chest-loop-start",
        sequence: 5,
      },
      {
        type: "semantic-state",
        state: "wheel.landing",
        sequence: 5,
      },
    ]);
    expect(checkpoints.every(Object.isFrozen)).toBe(true);
  });

  it("publishes each Vault mutation barrier before deferred final awards", async () => {
    const controller = prototypeHarness();
    const order: string[] = [];
    const cells = [{ reel: 1, row: 0 }] as const;
    Object.assign(controller, {
      presentationObserver: {
        onPresentationMilestone: (milestone: string | null) => {
          if (milestone) order.push(`milestone:${milestone}`);
        },
      },
      renderer: { highlightVaultMutationBatch: vi.fn() },
    });
    controller.presentPostReelFeatureEvent = vi.fn(async (event) => {
      order.push(event.type);
    });
    const events: readonly FeatureEvent[] = [
      { type: "vaults.unlock.started", count: 1, cells },
      { type: "vault.unlocked", reel: 1, row: 0, prize: "MINI", multiplier: 10 },
      { type: "vaults.unlock.completed", count: 1, cells },
      { type: "vaults.upgrade.started", count: 1, step: 1 },
      {
        type: "vault.upgraded", reel: 1, row: 0,
        fromMultiplier: 10, toMultiplier: 20, prize: "MINI_2X", step: 1,
      },
      {
        type: "vault.awarded", reel: 1, row: 0,
        prize: "MINI_2X", multiplier: 20, amountMinor: "2000",
      },
    ];

    await controller.presentPostReelFeatureEvents(
      events,
      { ...BASE_FEATURE, mode: "OVERDRIVE", freeSpinsRemaining: 6 },
      false,
      { rageLevel: 1, showFreeSpinSummary: false },
    );

    expect(order).toEqual([
      "vaults.unlock.started",
      "vault.unlocked",
      "vaults.unlock.completed",
      "milestone:vault.mutation-barrier-complete",
      "vaults.upgrade.started",
      "vault.upgraded",
      "milestone:vault.mutation-barrier-complete",
      "vault.awarded",
    ]);
  });

  it("publishes autoplay only after one eligible Free Spin timer is armed", () => {
    vi.useFakeTimers();
    try {
      const controller = prototypeHarness();
      const onPresentationMilestone = vi.fn();
      const requestSpin = vi.fn();
      Object.assign(controller, {
        destroyed: false,
        freeSpinTimer: null,
        connectionStatus: "online",
        reducedMotion: true,
        reducedMotionMedia: null,
        snapshot: {
          featureState: {
            ...BASE_FEATURE,
            mode: "EXPANSION",
            freeSpinsRemaining: 3,
            freeSpinsPlayed: 5,
            baseBetMinor: "100",
            freeSpinsWinMinor: "0",
          },
        },
        machine: { canSpin: true },
        gateway: { hasPendingSpin: false },
        presentationObserver: { onPresentationMilestone },
        requestSpin,
      });

      controller.scheduleFreeSpin();
      controller.scheduleFreeSpin();

      expect(onPresentationMilestone.mock.calls).toEqual([
        ["free-spins.autoplay-armed"],
      ]);
      expect(requestSpin).not.toHaveBeenCalled();
      vi.runOnlyPendingTimers();
      expect(requestSpin).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays all-Vault anticipation before every King Spin upgrade thump", async () => {
    const controller = prototypeHarness();
    const order: string[] = [];
    const cells = [{ reel: 1, row: 0 }, { reel: 1, row: 1 }, { reel: 1, row: 2 }] as const;
    const presentVaultTease = vi.fn(async ({ cells: teased }: { cells: readonly CellAddress[] }) => {
      order.push(`tease:${teased.length}`);
    });
    Object.assign(controller, {
      presentEffect: async (effect: () => Promise<void>) => effect(),
      audio: {
        playVaultAnticipation: vi.fn(() => order.push("anticipation")),
        playImpact: vi.fn(() => order.push("impact")),
        playVaultUnlock: vi.fn((count: number) => order.push(`open:${count}`)),
      },
      renderer: {
        cueFeatureEnvironment: vi.fn(() => order.push("environment")),
        featureEffects: {
          presentVaultTease,
          presentAfterReels: vi.fn(async () => order.push("group-barrier")),
        },
      },
    });

    await controller.presentPostReelFeatureEvent(
      { type: "vaults.upgrade.started", count: 3, step: 1 },
      { ...BASE_FEATURE, mode: "OVERDRIVE", freeSpinsRemaining: 4 },
      false,
      {
        rageLevel: 1,
        showFreeSpinSummary: false,
        wasFreeSpins: true,
        vaultTeaseExtraHold: false,
        vaultCells: cells,
      },
    );

    expect(order).toEqual([
      "anticipation",
      "tease:3",
      "impact",
      "open:1",
      "environment",
      "group-barrier",
    ]);
    expect(presentVaultTease).toHaveBeenCalledWith({ cells }, false, false);
  });

  it("does not start a second round while the reel lifecycle is non-idle", () => {
    const controller = prototypeHarness();
    const requestSpin = vi.fn();
    const commitAcceptedPaidAutoplaySpin = vi.fn();
    Object.assign(controller, {
      renderer: {
        requestFreeSpinContinue: vi.fn(() => false),
        requestWheelInteraction: vi.fn(() => null),
      },
      machine: { canSpin: true },
      reelRound: { state: "Spinning", transition: vi.fn() },
      gateway: { hasPendingSpin: false, requestSpin },
      ui: { commitAcceptedPaidAutoplaySpin },
    });

    controller.requestSpin();

    expect(requestSpin).not.toHaveBeenCalled();
    expect(commitAcceptedPaidAutoplaySpin).not.toHaveBeenCalled();
  });

  it("does not spend an Auto Play count when the gateway rejects the request", () => {
    const controller = prototypeHarness();
    const commitAcceptedPaidAutoplaySpin = vi.fn();
    Object.assign(controller, {
      renderer: {
        requestFreeSpinCapContinue: vi.fn(() => false),
        requestFreeSpinSummaryContinue: vi.fn(() => false),
        requestFreeSpinContinue: vi.fn(() => false),
        requestWheelSummaryContinue: vi.fn(() => false),
        requestWheelInteraction: vi.fn(() => null),
      },
      machine: { canSpin: true },
      reelRound: { state: "Idle", transition: vi.fn() },
      gateway: { hasPendingSpin: false, requestSpin: vi.fn(() => false) },
      audio: { unlock: vi.fn(async () => true) },
      ui: { commitAcceptedPaidAutoplaySpin },
      snapshot: {
        balanceMinor: "10000",
        selectedBetMinor: "100",
        betOptionsMinor: ["100"],
        featureState: BASE_FEATURE,
        lastWinMinor: "0",
        currentGrid: BASE_GRID,
      },
    });

    controller.requestSpin();

    expect(commitAcceptedPaidAutoplaySpin).not.toHaveBeenCalled();
  });

  it("keeps a retryable pending Auto Play reservation but rolls back a terminal rejection", () => {
    const controller = prototypeHarness();
    const rollbackAcceptedPaidAutoplaySpin = vi.fn();
    const machine = { phase: "requesting", transition: vi.fn() };
    const renderer = { cancelSpinPresentation: vi.fn() };
    Object.assign(controller, {
      ui: { showError: vi.fn(), rollbackAcceptedPaidAutoplaySpin },
      machine,
      renderer,
      reelRound: { reset: vi.fn() },
      stopRoundAudio: vi.fn(),
      refreshUi: vi.fn(),
    });

    controller.handleError({
      type: "error",
      protocolVersion: 1,
      code: "TEMPORARY_UNAVAILABLE",
      message: "retry later",
      retryable: true,
    });
    expect(rollbackAcceptedPaidAutoplaySpin).not.toHaveBeenCalled();
    expect(machine.transition).not.toHaveBeenCalled();

    controller.handleError({
      type: "error",
      protocolVersion: 1,
      code: "SPIN_REJECTED",
      message: "round rejected",
      retryable: false,
    });
    expect(rollbackAcceptedPaidAutoplaySpin).toHaveBeenCalledOnce();
    expect(machine.transition).toHaveBeenCalledWith({ type: "SPIN_FAILED" });
    expect(renderer.cancelSpinPresentation).toHaveBeenCalledOnce();
  });

  it("rolls back malformed authoritative results before returning the game to ready", () => {
    const controller = prototypeHarness();
    const rollbackAcceptedPaidAutoplaySpin = vi.fn();
    const transition = vi.fn();
    Object.assign(controller, {
      ui: { showError: vi.fn(), rollbackAcceptedPaidAutoplaySpin },
      machine: { transition },
      renderer: { cancelSpinPresentation: vi.fn() },
      reelRound: { reset: vi.fn() },
      stopRoundAudio: vi.fn(),
      observeRoundPresentationState: vi.fn(),
      refreshUi: vi.fn(),
    });

    controller.rejectSpinResult(new Error("bad grid"));

    expect(rollbackAcceptedPaidAutoplaySpin).toHaveBeenCalledOnce();
    expect(transition).toHaveBeenCalledWith({ type: "SPIN_FAILED" });
  });

  it("aborts round effects before touching a destroyed renderer", async () => {
    const controller = prototypeHarness();
    const effect = vi.fn(async () => undefined);
    controller.destroyed = true;

    await expect(controller.presentEffect(effect)).rejects.toThrow("Round presentation was cancelled");
    expect(effect).not.toHaveBeenCalled();
  });

  it("starts a consecutive Vault unlock group in parallel and barriers the following event", async () => {
    const controller = prototypeHarness();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const playVaultFly = vi.fn();
    const presentFreeSpinAwardBatch = vi.fn(async (events: readonly FeatureEvent[]) => {
      started.push(`awards:${events.length}`);
    });
    Object.assign(controller, {
      audio: { playVaultFly },
      renderer: { presentFreeSpinAwardBatch },
      presentEffect: async (effect: () => Promise<void>) => effect(),
    });
    controller.presentPostReelFeatureEvent = vi.fn((event) => {
      const key = event.type === "vault.unlocked"
        ? `${event.reel}:${event.row}`
        : event.type;
      started.push(key);
      if (event.type !== "vault.unlocked") return Promise.resolve();
      return new Promise<void>((resolve) => releases.set(key, resolve));
    });
    const events: readonly FeatureEvent[] = [
      { type: "vault.unlocked", reel: 1, row: 0, prize: "X10", multiplier: 10 },
      { type: "vault.unlocked", reel: 1, row: 1, prize: "X20", multiplier: 20 },
      { type: "free_spin.awarded", count: 1, reel: 1, row: 2 },
    ];

    const presentation = controller.presentPostReelFeatureEvents(
      events,
      BASE_FEATURE,
      false,
      { rageLevel: 1, showFreeSpinSummary: false },
    );
    await flushMicrotasks();

    expect(started).toEqual(["1:0", "1:1"]);
    releases.get("1:0")?.();
    await flushMicrotasks();
    expect(started).toEqual(["1:0", "1:1"]);

    releases.get("1:1")?.();
    await presentation;
    expect(started).toEqual(["1:0", "1:1", "awards:1"]);
    expect(playVaultFly).toHaveBeenCalledTimes(1);
    expect(presentFreeSpinAwardBatch).toHaveBeenCalledTimes(1);
    expect(presentFreeSpinAwardBatch).toHaveBeenCalledWith(
      [events[2]],
      expect.any(Object),
      false,
    );
  });

  it("launches every Vault reveal together and defers payout until mutation barriers", async () => {
    const controller = prototypeHarness();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const playVaultFly = vi.fn();
    const presentFreeSpinAwardBatch = vi.fn(async (events: readonly FeatureEvent[]) => {
      started.push(`awards:${events.length}`);
    });
    const highlightVaultMutationBatch = vi.fn((events: readonly FeatureEvent[]) => {
      started.push(`highlight:${events.length}`);
    });
    Object.assign(controller, {
      audio: { playVaultFly },
      renderer: { presentFreeSpinAwardBatch, highlightVaultMutationBatch },
      presentEffect: async (effect: () => Promise<void>) => effect(),
    });
    controller.presentPostReelFeatureEvent = vi.fn((event) => {
      const key = event.type === "vault.unlocked"
        ? `unlock:${event.reel}:${event.row}`
        : event.type;
      started.push(key);
      if (event.type !== "vault.unlocked") return Promise.resolve();
      return new Promise<void>((resolve) => releases.set(key, resolve));
    });
    const cells = [{ reel: 1, row: 0 }, { reel: 1, row: 1 }] as const;
    const events: readonly FeatureEvent[] = [
      { type: "vaults.unlock.started", count: 2, cells },
      { type: "vault.unlocked", reel: 1, row: 0, prize: "MINI", multiplier: 10 },
      { type: "vault.awarded", reel: 1, row: 0, multiplier: 10, amountMinor: "1000", prize: "MINI" },
      { type: "vault.unlocked", reel: 1, row: 1, prize: "FREE_SPIN" },
      { type: "free_spin.awarded", count: 1, reel: 1, row: 1 },
      { type: "vaults.unlock.completed", count: 2, cells },
      {
        type: "surge.collected", count: 1, cells: [{ reel: 0, row: 0 }],
        triggered: false, guaranteed: false, level: 1, total: 1,
      },
    ];

    const presentation = controller.presentPostReelFeatureEvents(
      events,
      BASE_FEATURE,
      false,
      { rageLevel: 1, showFreeSpinSummary: false },
    );
    await flushMicrotasks();

    expect(started).toEqual([
      "vaults.unlock.started",
      "highlight:2",
      "unlock:1:0",
      "unlock:1:1",
    ]);
    releases.get("unlock:1:0")?.();
    await flushMicrotasks();
    expect(started).toHaveLength(4);

    releases.get("unlock:1:1")?.();
    await presentation;
    expect(started).toEqual([
      "vaults.unlock.started",
      "highlight:2",
      "unlock:1:0",
      "unlock:1:1",
      "awards:1",
      "vaults.unlock.completed",
      "surge.collected",
      "vault.awarded",
    ]);
    expect(playVaultFly).toHaveBeenCalledTimes(1);
    expect(presentFreeSpinAwardBatch).toHaveBeenCalledTimes(1);
    expect(presentFreeSpinAwardBatch).toHaveBeenCalledWith(
      [events[4]],
      expect.any(Object),
      false,
    );
    expect(highlightVaultMutationBatch).toHaveBeenCalledWith([events[1], events[3]]);
  });

  it("starts King Spin highlight with the batch and pays only after upgrade barriers", async () => {
    const controller = prototypeHarness();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const highlightVaultMutationBatch = vi.fn((events: readonly FeatureEvent[]) => {
      started.push(`highlight:${events.length}`);
    });
    Object.assign(controller, {
      presentEffect: async (effect: () => Promise<void>) => effect(),
      renderer: { highlightVaultMutationBatch },
    });
    controller.presentPostReelFeatureEvent = vi.fn((event) => {
      const key = event.type === "vault.upgraded"
        ? `upgrade:${event.reel}:${event.row}`
        : event.type;
      started.push(key);
      if (event.type !== "vault.upgraded") return Promise.resolve();
      return new Promise<void>((resolve) => releases.set(key, resolve));
    });
    const events: readonly FeatureEvent[] = [
      { type: "vaults.upgrade.started", count: 2, step: 1 },
      {
        type: "vault.upgraded", reel: 1, row: 0,
        fromMultiplier: 10, toMultiplier: 20, prize: "MINI_2X", step: 1,
      },
      {
        type: "vault.upgraded", reel: 1, row: 1,
        fromMultiplier: 30, toMultiplier: 75, prize: "MAJOR", step: 1,
      },
      {
        type: "vault.awarded", reel: 1, row: 1,
        prize: "MAJOR", multiplier: 75, amountMinor: "7500",
      },
      {
        type: "surge.collected", count: 1,
        cells: [{ reel: 0, row: 0 }], triggered: false, guaranteed: false,
        level: 1, total: 1,
      },
    ];

    const presentation = controller.presentPostReelFeatureEvents(
      events,
      { ...BASE_FEATURE, mode: "OVERDRIVE", freeSpinsRemaining: 4 },
      false,
      { rageLevel: 1, showFreeSpinSummary: false },
    );
    await flushMicrotasks();

    expect(started).toEqual([
      "vaults.upgrade.started",
      "highlight:2",
      "upgrade:1:0",
      "upgrade:1:1",
    ]);
    releases.get("upgrade:1:0")?.();
    await flushMicrotasks();
    expect(started).toHaveLength(4);
    releases.get("upgrade:1:1")?.();
    await presentation;
    expect(started.slice(-2)).toEqual(["surge.collected", "vault.awarded"]);
    expect(highlightVaultMutationBatch).toHaveBeenCalledWith([events[1], events[2]]);
  });

  it("serializes two complete King upgrade rounds before final GRAND payout", async () => {
    const controller = prototypeHarness();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const highlightVaultMutationBatch = vi.fn((events: readonly FeatureEvent[]) => {
      const first = events[0];
      started.push(`highlight:${first?.type === "vault.upgraded" ? first.step : 0}:${events.length}`);
    });
    Object.assign(controller, {
      presentEffect: async (effect: () => Promise<void>) => effect(),
      renderer: { highlightVaultMutationBatch },
    });
    controller.presentPostReelFeatureEvent = vi.fn((event) => {
      if (event.type === "vaults.upgrade.started") {
        started.push(`start:${event.step}`);
        return Promise.resolve();
      }
      if (event.type === "vault.upgraded") {
        const key = `${event.step}:${event.row}`;
        started.push(`upgrade:${key}`);
        return new Promise<void>((resolve) => releases.set(key, resolve));
      }
      if (event.type === "vault.awarded") {
        started.push(`award:${event.row}`);
      }
      return Promise.resolve();
    });
    const events: readonly FeatureEvent[] = [
      { type: "vaults.upgrade.started", count: 3, step: 1 },
      {
        type: "vault.upgraded", reel: 1, row: 0,
        fromMultiplier: 10, toMultiplier: 250, prize: "MEGA", step: 1,
      },
      {
        type: "vault.upgraded", reel: 1, row: 1,
        fromMultiplier: 10, toMultiplier: 250, prize: "MEGA", step: 1,
      },
      {
        type: "vault.upgraded", reel: 1, row: 2,
        fromMultiplier: 10, toMultiplier: 250, prize: "MEGA", step: 1,
      },
      { type: "vaults.upgrade.started", count: 3, step: 2 },
      {
        type: "vault.upgraded", reel: 1, row: 0,
        fromMultiplier: 250, toMultiplier: 1_000, prize: "GRAND", step: 2,
      },
      {
        type: "vault.upgraded", reel: 1, row: 1,
        fromMultiplier: 250, toMultiplier: 1_000, prize: "GRAND", step: 2,
      },
      {
        type: "vault.upgraded", reel: 1, row: 2,
        fromMultiplier: 250, toMultiplier: 1_000, prize: "GRAND", step: 2,
      },
      ...Array.from({ length: 3 }, (_, row): FeatureEvent => ({
        type: "vault.awarded",
        reel: 1,
        row,
        prize: "GRAND",
        multiplier: 1_000,
        amountMinor: "100000",
      })),
    ];

    const presentation = controller.presentPostReelFeatureEvents(
      events,
      { ...BASE_FEATURE, mode: "OVERDRIVE", freeSpinsRemaining: 6 },
      false,
      { rageLevel: 1, showFreeSpinSummary: false },
    );
    await flushMicrotasks();

    expect(started).toEqual([
      "start:1",
      "highlight:1:3",
      "upgrade:1:0",
      "upgrade:1:1",
      "upgrade:1:2",
    ]);
    releases.get("1:0")?.();
    releases.get("1:1")?.();
    await flushMicrotasks();
    expect(started.some((entry) => entry.startsWith("start:2"))).toBe(false);

    releases.get("1:2")?.();
    await flushMicrotasks();
    expect(started.slice(5)).toEqual([
      "start:2",
      "highlight:2:3",
      "upgrade:2:0",
      "upgrade:2:1",
      "upgrade:2:2",
    ]);
    releases.get("2:0")?.();
    releases.get("2:1")?.();
    await flushMicrotasks();
    expect(started.some((entry) => entry.startsWith("award:"))).toBe(false);

    releases.get("2:2")?.();
    await presentation;
    expect(started.slice(-3)).toEqual(["award:0", "award:1", "award:2"]);
    expect(highlightVaultMutationBatch.mock.calls.map(([batch]) => batch.length))
      .toEqual([3, 3]);
  });

  it("uses an immediate anticipation audio stop for fast-forward and cancellation", () => {
    expect(anticipationAudioFadeMs(false, "reel-impact")).toBe(1_000);
    expect(anticipationAudioFadeMs(true, "fast-forward")).toBe(0);
    expect(anticipationAudioFadeMs(false, "cancelled")).toBe(0);
    expect(anticipationAudioFadeMs(false, "error")).toBe(0);
  });

  it("accepts ReelStart while unlock is pending and quick-stops only ReelLoop", async () => {
    const controller = prototypeHarness();
    let releaseUnlock!: (enabled: boolean) => void;
    const unlock = new Promise<boolean>((resolve) => {
      releaseUnlock = resolve;
    });
    controller.spinAudioGeneration = 0;
    Object.assign(controller, {
      destroyed: false,
      stops: { requestFastForward: vi.fn(() => true) },
      renderer: { markFastStop: vi.fn() },
      ui: { setSpinMode: vi.fn() },
      audio: {
        playReelStart: vi.fn(),
        quickStopReelLoop: vi.fn(),
      },
    });

    controller.startRoundAudio(unlock, false);
    controller.requestFastStop();
    releaseUnlock(true);
    await flushMicrotasks();

    expect(controller.spinAudioGeneration).toBe(2);
    expect(controller.audio.playReelStart).toHaveBeenCalledTimes(1);
    expect(controller.audio.quickStopReelLoop).toHaveBeenCalledTimes(1);
  });

  it("dispatches ReelStart before reel-0 STARTING and ReelLoop after it", () => {
    const controller = prototypeHarness();
    const order: string[] = [];
    const commitAcceptedPaidAutoplaySpin = vi.fn();
    Object.assign(controller, {
      destroyed: false,
      presentationObserver: null,
      machine: {
        canSpin: true,
        transition: vi.fn((event: { type: string }) => order.push(`machine:${event.type}`)),
      },
      gateway: {
        hasPendingSpin: false,
        requestSpin: vi.fn(() => {
          order.push("request");
          return true;
        }),
      },
      reelRound: {
        state: "Idle",
        transition: vi.fn((event: { type: string }) => order.push(`reels:${event.type}`)),
      },
      audio: {
        getLaunchPlaybackClock: vi.fn(() => null),
        unlock: vi.fn(() => new Promise<boolean>(() => undefined)),
        beginBaseMusicRound: vi.fn(),
        playReelStart: vi.fn(() => order.push("audio:reel-start")),
        startReelLoop: vi.fn(() => order.push("audio:reel-loop")),
      },
      renderer: {
        requestFreeSpinCapContinue: vi.fn(() => false),
        requestFreeSpinSummaryContinue: vi.fn(() => false),
        requestFreeSpinContinue: vi.fn(() => false),
        requestWheelSummaryContinue: vi.fn(() => false),
        requestWheelInteraction: vi.fn(() => null),
        beginSpinPresentation: vi.fn(() => order.push("renderer:reel-0-starting")),
      },
      stops: { markSpinStart: vi.fn() },
      ui: {
        commitAcceptedPaidAutoplaySpin,
        resetWinCounter: vi.fn(),
        setSpinMode: vi.fn(),
      },
      snapshot: {
        balanceMinor: "10000",
        selectedBetMinor: "100",
        betOptionsMinor: ["100"],
        featureState: BASE_FEATURE,
        lastWinMinor: "0",
        currentGrid: BASE_GRID,
      },
      cancelScheduledFreeSpin: vi.fn(),
      refreshUi: vi.fn(),
      reducedMotion: false,
      reducedMotionMedia: null,
      spinAudioGeneration: 0,
    });

    controller.requestSpin();

    expect(order.indexOf("audio:reel-start"))
      .toBeLessThan(order.indexOf("renderer:reel-0-starting"));
    expect(order.indexOf("renderer:reel-0-starting"))
      .toBeLessThan(order.indexOf("audio:reel-loop"));
    expect(controller.audio.playReelStart).toHaveBeenCalledTimes(1);
    expect(controller.audio.startReelLoop).toHaveBeenCalledTimes(1);
    expect(commitAcceptedPaidAutoplaySpin).toHaveBeenCalledTimes(1);

    (controller as unknown as { snapshot: { featureState: FeatureState } }).snapshot.featureState = {
      ...BASE_FEATURE,
      mode: "EXPANSION",
      freeSpinsRemaining: 3,
    };
    controller.requestSpin();

    expect(commitAcceptedPaidAutoplaySpin).toHaveBeenCalledTimes(1);
  });

  it("routes the shared Spin control through wheel start and wheel quick-stop before reels", () => {
    const controller = prototypeHarness();
    const requestFastForward = vi.fn();
    const requestWheelInteraction = vi.fn()
      .mockReturnValueOnce("spin-started")
      .mockReturnValueOnce("quick-stop");
    Object.assign(controller, {
      renderer: { requestWheelInteraction },
      stops: { requestFastForward },
      audio: { quickStopReelMotor: vi.fn() },
    });

    controller.requestSpin();
    controller.requestFastStop();

    expect(requestWheelInteraction).toHaveBeenCalledTimes(2);
    expect(requestFastForward).not.toHaveBeenCalled();
    expect(controller.audio.quickStopReelMotor).not.toHaveBeenCalled();
  });

  it("routes Big Win advance before wheel and reel quick-stop without touching a result", () => {
    const controller = prototypeHarness();
    const requestBigWinInteraction = vi.fn(() => "level-up" as const);
    const requestWheelInteraction = vi.fn();
    const requestFastForward = vi.fn();
    Object.assign(controller, {
      renderer: {
        requestBigWinInteraction,
        requestWheelInteraction,
        markFastStop: vi.fn(),
      },
      stops: { requestFastForward },
      audio: { quickStopReelMotor: vi.fn() },
    });

    controller.requestFastStop();

    expect(requestBigWinInteraction).toHaveBeenCalledTimes(1);
    expect(requestWheelInteraction).not.toHaveBeenCalled();
    expect(requestFastForward).not.toHaveBeenCalled();
    expect(controller.audio.quickStopReelMotor).not.toHaveBeenCalled();
  });

  it("consumes normal-win Continue once without touching reels or RNG", async () => {
    const controller = prototypeHarness();
    const resolveDelay = vi.fn();
    const finishWinCounter = vi.fn(() => true);
    const requestFinish = vi.fn(() => true);
    const requestFastForward = vi.fn(() => true);
    const setSpinMode = vi.fn();
    Object.assign(controller, {
      normalWinPresentationActive: true,
      normalWinFinishRequested: false,
      normalWinDelayResolver: resolveDelay,
      activePresentationSequence: 9,
      destroyed: false,
      renderer: {
        requestBigWinInteraction: vi.fn(() => false),
        requestWheelInteraction: vi.fn(() => false),
        winCelebration: { requestFinish },
      },
      ui: { finishWinCounter, setSpinMode },
      stops: { requestFastForward },
      audio: { quickStopReelLoop: vi.fn(), quickStopReelMotor: vi.fn() },
    });

    controller.requestFastStop();
    controller.requestFastStop();
    await flushMicrotasks();

    expect(finishWinCounter).toHaveBeenCalledTimes(1);
    expect(requestFinish).toHaveBeenCalledTimes(1);
    expect(resolveDelay).toHaveBeenCalledTimes(1);
    expect(setSpinMode).toHaveBeenCalledWith("waiting");
    expect(controller.audio.quickStopReelLoop).toHaveBeenCalledTimes(1);
    expect(requestFastForward).not.toHaveBeenCalled();
  });

  it("uses Spin to dismiss the Free Spins intro without requesting another round", () => {
    const controller = prototypeHarness();
    const requestFreeSpinContinue = vi.fn(() => true);
    const requestWheelInteraction = vi.fn();
    const requestSpin = vi.fn();
    Object.assign(controller, {
      renderer: { requestFreeSpinContinue, requestWheelInteraction },
      machine: { canSpin: true },
      gateway: { hasPendingSpin: false, requestSpin },
    });

    controller.requestSpin();

    expect(requestFreeSpinContinue).toHaveBeenCalledTimes(1);
    expect(requestWheelInteraction).not.toHaveBeenCalled();
    expect(requestSpin).not.toHaveBeenCalled();
  });

  it("dismisses the bounded Free Spins summary before intro, Wheel, or a new round", () => {
    const controller = prototypeHarness();
    const requestFreeSpinSummaryContinue = vi.fn(() => true);
    const requestFreeSpinContinue = vi.fn();
    const requestWheelInteraction = vi.fn();
    const requestSpin = vi.fn();
    Object.assign(controller, {
      renderer: {
        requestFreeSpinCapContinue: vi.fn(() => false),
        requestFreeSpinSummaryContinue,
        requestFreeSpinContinue,
        requestWheelInteraction,
      },
      machine: { canSpin: true },
      gateway: { hasPendingSpin: false, requestSpin },
    });

    controller.requestSpin();

    expect(requestFreeSpinSummaryContinue).toHaveBeenCalledTimes(1);
    expect(requestFreeSpinContinue).not.toHaveBeenCalled();
    expect(requestWheelInteraction).not.toHaveBeenCalled();
    expect(requestSpin).not.toHaveBeenCalled();
  });

  it("dismisses the Wheel summary before Wheel start or a new server round", () => {
    const controller = prototypeHarness();
    const requestWheelSummaryContinue = vi.fn(() => true);
    const requestWheelInteraction = vi.fn();
    const requestSpin = vi.fn();
    Object.assign(controller, {
      renderer: {
        requestFreeSpinCapContinue: vi.fn(() => false),
        requestFreeSpinContinue: vi.fn(() => false),
        requestWheelSummaryContinue,
        requestWheelInteraction,
      },
      machine: { canSpin: true },
      gateway: { hasPendingSpin: false, requestSpin },
    });

    controller.requestSpin();

    expect(requestWheelSummaryContinue).toHaveBeenCalledTimes(1);
    expect(requestWheelInteraction).not.toHaveBeenCalled();
    expect(requestSpin).not.toHaveBeenCalled();
  });

  it("routes CAPLIMIT continue before Free Spins intro, Wheel, or a new round", () => {
    const controller = prototypeHarness();
    const requestFreeSpinCapContinue = vi.fn(() => true);
    const requestFreeSpinContinue = vi.fn();
    const requestFreeSpinSummaryContinue = vi.fn();
    const requestWheelInteraction = vi.fn();
    const requestSpin = vi.fn();
    Object.assign(controller, {
      renderer: {
        requestFreeSpinCapContinue,
        requestFreeSpinSummaryContinue,
        requestFreeSpinContinue,
        requestWheelInteraction,
      },
      machine: { canSpin: true },
      gateway: { hasPendingSpin: false, requestSpin },
    });

    controller.requestSpin();

    expect(requestFreeSpinCapContinue).toHaveBeenCalledTimes(1);
    expect(requestFreeSpinSummaryContinue).not.toHaveBeenCalled();
    expect(requestFreeSpinContinue).not.toHaveBeenCalled();
    expect(requestWheelInteraction).not.toHaveBeenCalled();
    expect(requestSpin).not.toHaveBeenCalled();
  });

  it("consumes the early Wheel popup Continue without spinning Wheel or server reels", () => {
    const controller = prototypeHarness();
    const requestWheelInteraction = vi.fn(() => "popup-continued" as const);
    const requestSpin = vi.fn();
    Object.assign(controller, {
      renderer: {
        requestFreeSpinCapContinue: vi.fn(() => false),
        requestFreeSpinSummaryContinue: vi.fn(() => false),
        requestFreeSpinContinue: vi.fn(() => false),
        requestWheelSummaryContinue: vi.fn(() => false),
        requestWheelInteraction,
      },
      machine: { canSpin: true },
      gateway: { hasPendingSpin: false, requestSpin },
    });

    controller.requestSpin();

    expect(requestWheelInteraction).toHaveBeenCalledTimes(1);
    expect(requestSpin).not.toHaveBeenCalled();
  });

  it("presents consecutive Free Spin awards against the pre-SPINEND HUD state", async () => {
    const previousState: FeatureState = {
      mode: "EXPANSION",
      freeSpinsRemaining: 2,
      freeSpinsPlayed: 5,
      freeSpinsWinMinor: "800",
      rageLevel: 5,
      rageCollected: 0,
    };
    const finalState: FeatureState = {
      mode: "EXPANSION",
      freeSpinsRemaining: 3,
      freeSpinsPlayed: 6,
      freeSpinsWinMinor: "900",
      rageLevel: 5,
      rageCollected: 0,
    };
    const events: readonly FeatureEvent[] = [
      { type: "free_spin.awarded", count: 1, reel: 1, row: 0 },
      { type: "free_spin.awarded", count: 1, reel: 1, row: 1 },
    ];
    const baseline = freeSpinHudStateBeforeAwards(previousState, finalState);
    expect(formatFreeSpinCounter(projectFreeSpinHud(baseline))).toBe("6 / 7");

    const controller = prototypeHarness();
    const displayed: FeatureState[] = [];
    const playVaultFly = vi.fn();
    const presentFreeSpinAwardBatch = vi.fn(async (
      _events: readonly FeatureEvent[],
      state: FeatureState,
    ) => {
      displayed.push({ ...state });
    });
    Object.assign(controller, {
      presentEffect: async (effect: () => Promise<void>) => effect(),
      audio: { playVaultFly },
      renderer: {
        presentFreeSpinAwardBatch,
      },
    });
    const audioState: FeatureAudioState = {
      rageLevel: 5,
      showFreeSpinSummary: false,
      hudState: baseline,
    };

    await controller.presentPostReelFeatureEvents(events, finalState, false, audioState);

    expect(displayed.map((state) => formatFreeSpinCounter(projectFreeSpinHud(state))))
      .toEqual(["6 / 9"]);
    expect(audioState.hudState).toEqual({
      ...previousState,
      freeSpinsRemaining: 4,
    });
    expect(playVaultFly).toHaveBeenCalledTimes(1);
    expect(presentFreeSpinAwardBatch).toHaveBeenCalledTimes(1);
    expect(presentFreeSpinAwardBatch).toHaveBeenCalledWith(events, {
      ...previousState,
      freeSpinsRemaining: 4,
    }, false);
  });

  it("keeps a batched Free Spin award visible through the presentation observer seam", async () => {
    const controller = prototypeHarness();
    const onFeatureEvent = vi.fn();
    const events: readonly FeatureEvent[] = [
      { type: "free_spin.awarded", count: 1, reel: 1, row: 0 },
      { type: "free_spin.awarded", count: 1, reel: 1, row: 1 },
    ];
    Object.assign(controller, {
      destroyed: false,
      activeObservedFeatureEvents: [],
      presentationObserver: { onFeatureEvent },
      presentEffect: async (effect: () => Promise<void>) => effect(),
      audio: { playVaultFly: vi.fn() },
      renderer: { presentFreeSpinAwardBatch: vi.fn(async () => undefined) },
    });

    await controller.presentPostReelFeatureEvents(
      events,
      { ...BASE_FEATURE, mode: "EXPANSION", freeSpinsRemaining: 2 },
      false,
      { rageLevel: 1, showFreeSpinSummary: false, hudState: BASE_FEATURE },
    );

    expect(onFeatureEvent).toHaveBeenCalledTimes(2);
    expect(onFeatureEvent.mock.calls[0]?.[0]).toBe("free_spin.awarded");
    expect(onFeatureEvent.mock.calls[0]?.[1]).toEqual(events[0]);
    expect(onFeatureEvent.mock.calls[0]?.[1]).not.toBe(events[0]);
    expect(Object.isFrozen(onFeatureEvent.mock.calls[0]?.[1])).toBe(true);
    expect(onFeatureEvent.mock.calls[1]).toEqual([null]);
  });

  it("deep-freezes the optional feature payload without exposing controller input", async () => {
    const controller = prototypeHarness();
    const onFeatureEvent = vi.fn();
    const event: FeatureEvent = {
      type: "vaults.landed",
      count: 1,
      cells: [{ reel: 1, row: 2 }],
    };
    Object.assign(controller, {
      destroyed: false,
      activeObservedFeatureEvents: [],
      presentationObserver: { onFeatureEvent },
    });

    await controller.observeFeatureEvent(event, async () => undefined);

    const payload = onFeatureEvent.mock.calls[0]?.[1] as typeof event;
    expect(payload).toEqual(event);
    expect(payload).not.toBe(event);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.cells)).toBe(true);
    expect(Object.isFrozen(payload.cells[0])).toBe(true);
    expect(onFeatureEvent.mock.calls[1]).toEqual([null]);
  });

  it("awaits one optional checkpoint only after every deferred Vault award", async () => {
    const controller = prototypeHarness();
    const order: string[] = [];
    const checkpointGate: { release?: () => void } = {};
    const onPresentationCheckpoint = vi.fn((checkpoint: { type: string; count: number }) => {
      order.push(`checkpoint:${checkpoint.type}:${checkpoint.count}`);
      return new Promise<void>((resolve) => { checkpointGate.release = resolve; });
    });
    Object.assign(controller, {
      destroyed: false,
      presentationObserver: { onPresentationCheckpoint },
      presentPostReelFeatureEvent: vi.fn(async (event: FeatureEvent) => {
        order.push(`${event.type}:${"reel" in event ? event.reel : "group"}`);
      }),
      observePresentationMilestone: vi.fn(),
    });
    const events: readonly FeatureEvent[] = [
      {
        type: "vault.awarded",
        reel: 0,
        row: 1,
        prize: "MINI",
        multiplier: 10,
        amountMinor: "1000",
      },
      {
        type: "vault.awarded",
        reel: 2,
        row: 1,
        prize: "MAJOR",
        multiplier: 75,
        amountMinor: "7500",
      },
    ];
    let completed = false;

    const presentation = controller.presentPostReelFeatureEvents(
      events,
      BASE_FEATURE,
      false,
      { rageLevel: 1, showFreeSpinSummary: false },
    ).then(() => { completed = true; });
    await flushMicrotasks();

    expect(order).toEqual([
      "vault.awarded:0",
      "vault.awarded:2",
      "checkpoint:vault-awards-complete:2",
    ]);
    expect(onPresentationCheckpoint.mock.calls[0]?.[0]).toEqual({
      type: "vault-awards-complete",
      count: 2,
    });
    expect(Object.isFrozen(onPresentationCheckpoint.mock.calls[0]?.[0])).toBe(true);
    expect(completed).toBe(false);

    checkpointGate.release?.();
    await presentation;
    expect(completed).toBe(true);
  });

  it("continues deferred Vault settlement when a checkpoint observer rejects", async () => {
    const controller = prototypeHarness();
    Object.assign(controller, {
      destroyed: false,
      presentationObserver: {
        onPresentationCheckpoint: vi.fn(async () => {
          throw new Error("fixture timeout");
        }),
      },
      presentPostReelFeatureEvent: vi.fn(async () => undefined),
      observePresentationMilestone: vi.fn(),
    });

    await expect(controller.presentPostReelFeatureEvents(
      [{
        type: "vault.awarded",
        reel: 1,
        row: 1,
        multiplier: 10,
        amountMinor: "1000",
      }],
      BASE_FEATURE,
      false,
      { rageLevel: 1, showFreeSpinSummary: false },
    )).resolves.toBeUndefined();
  });

  it("routes CAPLIMIT to the dedicated retrigger without replaying VaultFly", async () => {
    const controller = prototypeHarness();
    const capEvent = { type: "free_spin.cap_reached", reel: 1, row: 2 } as const;
    const playVaultFly = vi.fn();
    const presentFreeSpinCap = vi.fn(async () => undefined);
    Object.assign(controller, {
      presentFeatureAudio: vi.fn(),
      presentEffect: async (effect: () => Promise<void>) => effect(),
      audio: { playVaultFly },
      renderer: {
        cueFeatureEnvironment: vi.fn(),
        presentFreeSpinCap,
      },
      ui: { announceEvent: vi.fn(async () => undefined) },
    });

    await controller.presentPostReelFeatureEvent(
      capEvent,
      { ...BASE_FEATURE, mode: "EXPANSION", freeSpinsRemaining: 1 },
      false,
      { rageLevel: 5, showFreeSpinSummary: false },
    );

    expect(presentFreeSpinCap).toHaveBeenCalledWith(
      capEvent,
      expect.objectContaining({ mode: "EXPANSION", freeSpinsRemaining: 1 }),
    );
    expect(playVaultFly).not.toHaveBeenCalled();
  });

  it("retains the round-origin HUD projection for a terminal CAPLIMIT", () => {
    const origin: FeatureState = {
      mode: "EXPANSION",
      freeSpinsRemaining: 1,
      freeSpinsPlayed: 7,
      freeSpinsWinMinor: "900",
      rageLevel: 5,
      rageCollected: 0,
    };
    const events: readonly FeatureEvent[] = [
      { type: "free_spin.cap_reached", reel: 1, row: 2 },
      {
        type: "free_spins.completed",
        mode: "EXPANSION",
        awarded: 8,
        cumulativeWinMinor: "900",
      },
    ];

    expect(freeSpinHudStateForPresentation(origin, BASE_FEATURE, events)).toEqual(origin);
    expect(origin).toMatchObject({ freeSpinsRemaining: 1, freeSpinsPlayed: 7 });
  });

  it("keeps the Free Spins HUD visible while presenting the terminal summary", async () => {
    const controller = prototypeHarness();
    const order: string[] = [];
    Object.assign(controller, {
      presentFeatureAudio: vi.fn(),
      presentEffect: async (effect: () => Promise<void>) => effect(),
      renderer: {
        cueFeatureEnvironment: vi.fn(),
        hideFreeSpinHud: vi.fn(async () => order.push("hide-hud")),
        featureEffects: {
          presentAfterReels: vi.fn(async () => order.push("summary")),
        },
      },
      ui: { announceEvent: vi.fn(async () => undefined) },
    });
    const event: FeatureEvent = {
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor: "1000",
    };

    await controller.presentPostReelFeatureEvent(
      event,
      BASE_FEATURE,
      false,
      { rageLevel: 5, showFreeSpinSummary: true },
    );

    expect(order).toEqual(["summary", "hide-hud"]);
  });

  it("holds an accepted no-summary completion before Base exit and resumes on release", async () => {
    const controller = prototypeHarness();
    const order: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const checkpoints: AppPresentationCheckpoint[] = [];
    const showFreeSpinsCompletedState = vi.fn((completion: FeatureEvent) => {
      if (completion.type === "free_spins.completed") {
        order.push(`semantic:${completion.awarded}:${completion.cumulativeWinMinor}`);
      }
    });
    const event: FeatureEvent = {
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor: "0",
    };
    Object.assign(controller, {
      activePresentationSequence: 9,
      activeObservedFeatureEvents: [],
      destroyed: false,
      presentationObserver: {
        onFeatureEvent: (type: FeatureEvent["type"] | null) => {
          order.push(type ? `event:${type}` : "event:clear");
        },
        onPresentationCheckpoint: (checkpoint: AppPresentationCheckpoint) => {
          checkpoints.push(checkpoint);
          order.push(`checkpoint:${checkpoint.type}`);
          return hold;
        },
      },
      presentFeatureAudio: vi.fn(() => order.push("audio")),
      presentEffect: async (effect: () => Promise<void>) => effect(),
      beginFreeSpinsExitOnce: vi.fn(() => {
        order.push("base-exit");
        return true;
      }),
      renderer: {
        cueFeatureEnvironment: vi.fn(),
        hideFreeSpinHud: vi.fn(async () => { order.push("hide-hud"); }),
        featureEffects: { presentAfterReels: vi.fn(async () => undefined) },
      },
      ui: {
        showFreeSpinsCompletedState,
        announceEvent: vi.fn(async () => { order.push("announce"); }),
      },
    });

    const presentation = controller.presentPostReelFeatureEvent(
      event,
      BASE_FEATURE,
      false,
      { rageLevel: 5, showFreeSpinSummary: false },
    );
    await flushMicrotasks();

    expect(checkpoints).toEqual([{
      type: "free-spins-completed-active",
      sequence: 9,
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor: "0",
    }]);
    expect(order).toEqual([
      "event:free_spins.completed",
      "semantic:8:0",
      "checkpoint:free-spins-completed-active",
    ]);
    expect(showFreeSpinsCompletedState).toHaveBeenCalledWith(event);
    expect(controller.activeObservedFeatureEvents).toHaveLength(1);

    release();
    await presentation;
    expect(order).toEqual([
      "event:free_spins.completed",
      "semantic:8:0",
      "checkpoint:free-spins-completed-active",
      "audio",
      "base-exit",
      "hide-hud",
      "event:clear",
    ]);
    expect(controller.activeObservedFeatureEvents).toEqual([]);
  });

  it("never holds the winning-summary branch or an observer-free production path", async () => {
    const event: FeatureEvent = {
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor: "350",
    };
    const onPresentationCheckpoint = vi.fn();
    const showSummaryCompletionState = vi.fn();
    const summaryController = prototypeHarness();
    Object.assign(summaryController, {
      activePresentationSequence: 9,
      presentationObserver: { onPresentationCheckpoint },
      presentFeatureAudio: vi.fn(),
      presentEffect: async (effect: () => Promise<void>) => effect(),
      renderer: {
        cueFeatureEnvironment: vi.fn(),
        hideFreeSpinHud: vi.fn(async () => undefined),
        featureEffects: { presentAfterReels: vi.fn(async () => undefined) },
      },
      ui: {
        showFreeSpinsCompletedState: showSummaryCompletionState,
        announceEvent: vi.fn(async () => undefined),
      },
    });
    await summaryController.presentPostReelFeatureEventBody(
      event,
      BASE_FEATURE,
      false,
      { rageLevel: 5, showFreeSpinSummary: true },
    );
    expect(onPresentationCheckpoint).not.toHaveBeenCalled();
    expect(showSummaryCompletionState).not.toHaveBeenCalled();

    const productionController = prototypeHarness() as ControllerPrototypeHarness & {
      awaitPresentationCheckpoint: ReturnType<typeof vi.fn>;
      presentPostReelFeatureEventBody(
        event: FeatureEvent,
        state: FeatureState,
        reducedMotion: boolean,
        audioState: FeatureAudioState,
      ): Promise<void>;
    };
    const showProductionCompletionState = vi.fn();
    Object.assign(productionController, {
      activePresentationSequence: 9,
      presentationObserver: null,
      awaitPresentationCheckpoint: vi.fn(),
      presentFeatureAudio: vi.fn(),
      presentEffect: async (effect: () => Promise<void>) => effect(),
      beginFreeSpinsExitOnce: vi.fn(() => true),
      renderer: {
        cueFeatureEnvironment: vi.fn(),
        hideFreeSpinHud: vi.fn(async () => undefined),
        featureEffects: { presentAfterReels: vi.fn(async () => undefined) },
      },
      ui: {
        showFreeSpinsCompletedState: showProductionCompletionState,
        announceEvent: vi.fn(async () => undefined),
      },
    });
    await productionController.presentPostReelFeatureEventBody(
      { ...event, cumulativeWinMinor: "0" },
      BASE_FEATURE,
      false,
      { rageLevel: 5, showFreeSpinSummary: false },
    );
    expect(productionController.awaitPresentationCheckpoint).not.toHaveBeenCalled();
    expect(showProductionCompletionState).toHaveBeenCalledWith({
      ...event,
      cumulativeWinMinor: "0",
    });
  });

  it("fails open when the no-summary checkpoint observer rejects", async () => {
    const controller = prototypeHarness() as ControllerPrototypeHarness & {
      presentPostReelFeatureEventBody(
        event: FeatureEvent,
        state: FeatureState,
        reducedMotion: boolean,
        audioState: FeatureAudioState,
      ): Promise<void>;
    };
    const beginFreeSpinsExitOnce = vi.fn(() => true);
    const hideFreeSpinHud = vi.fn(async () => undefined);
    Object.assign(controller, {
      activePresentationSequence: 9,
      destroyed: false,
      presentationObserver: {
        onPresentationCheckpoint: vi.fn(async () => {
          throw new Error("fixture observer expired");
        }),
      },
      presentFeatureAudio: vi.fn(),
      presentEffect: async (effect: () => Promise<void>) => effect(),
      beginFreeSpinsExitOnce,
      renderer: {
        cueFeatureEnvironment: vi.fn(),
        hideFreeSpinHud,
        featureEffects: { presentAfterReels: vi.fn(async () => undefined) },
      },
      ui: { announceEvent: vi.fn(async () => undefined) },
      assertRoundPresentationActive: vi.fn(),
    });

    await expect(controller.presentPostReelFeatureEventBody(
      {
        type: "free_spins.completed",
        mode: "EXPANSION",
        awarded: 8,
        cumulativeWinMinor: "100",
      },
      BASE_FEATURE,
      false,
      { rageLevel: 5, showFreeSpinSummary: false },
    )).resolves.toBeUndefined();
    expect(beginFreeSpinsExitOnce).toHaveBeenCalledTimes(1);
    expect(hideFreeSpinHud).toHaveBeenCalledTimes(1);
  });

  it("coalesces the renderer hide-start callback and controller fallback", () => {
    const controller = prototypeHarness();
    const state: FeatureAudioState = {
      rageLevel: 5,
      showFreeSpinSummary: true,
      featureExitStarted: false,
    };
    const endFreeSpinsMode = vi.fn();
    const beginFeatureExitAtSummaryHide = vi.fn();
    const onPresentationMilestone = vi.fn();
    Object.assign(controller, {
      activeRoundFeatureAudioState: state,
      presentationObserver: { onPresentationMilestone },
      snapshot: { featureState: BASE_FEATURE },
      audio: { endFreeSpinsMode },
      renderer: { beginFeatureExitAtSummaryHide },
    });

    controller.presentFeaturePresentationMilestone("free-spins.summary-hide");
    expect(controller.beginFreeSpinsExitOnce(state, false)).toBe(false);
    controller.presentFeaturePresentationMilestone("free-spins.summary-hide");

    expect(state.featureExitStarted).toBe(true);
    expect(endFreeSpinsMode).toHaveBeenCalledTimes(1);
    expect(beginFeatureExitAtSummaryHide).toHaveBeenCalledTimes(1);
    expect(onPresentationMilestone.mock.calls).toEqual([
      [null],
      ["free-spins.exit-started"],
      [null],
    ]);
  });

  it("starts only the Free Spins tail at SUMMARY and defers Base restoration", () => {
    const controller = prototypeHarness();
    const order: string[] = [];
    controller.audio = {
      endFreeSpinsMode: vi.fn(() => order.push("base-start")),
      setFreeSpinsMusicEnabled: vi.fn(() => order.push("fs-tail")),
    };
    const event: FeatureEvent = {
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor: "1000",
    };

    controller.presentFeatureAudio(event, false, {
      rageLevel: 5,
      showFreeSpinSummary: false,
    });
    expect(order).toEqual(["fs-tail"]);

    order.splice(0);
    controller.presentFeatureAudio(event, false, {
      rageLevel: 5,
      showFreeSpinSummary: true,
    });
    expect(order).toEqual(["fs-tail"]);
    expect(controller.audio.endFreeSpinsMode).not.toHaveBeenCalled();
  });

  it("suppresses credited EVOLVE pixels/audio when a one/two-Rage trigger resets PPS", () => {
    const controller = prototypeHarness();
    const state: FeatureAudioState = {
      rageLevel: 5,
      showFreeSpinSummary: false,
    };
    controller.audio = {
      playPpsLevel: vi.fn(),
      playEnergyCollect: vi.fn(),
    };
    const setRageAuraLevel = vi.fn();
    Object.assign(controller, {
      renderer: { setRageAuraLevel },
    });

    controller.presentFeatureAudio({
      type: "surge.collected",
      count: 2,
      cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }],
      triggered: true,
      guaranteed: false,
      level: 1,
      total: 0,
    }, false, state);

    expect(setRageAuraLevel).not.toHaveBeenCalled();
    expect(controller.audio.playPpsLevel).not.toHaveBeenCalled();
    expect(state.rageLevel).toBe(1);
  });

  it("applies one recovered level-two EVOLVE cue and aura before the authored collect visual", async () => {
    const controller = prototypeHarness();
    const order: string[] = [];
    const playPpsLevel = vi.fn(() => order.push("pps-level-2"));
    const setRageAuraLevel = vi.fn(() => order.push("aura-2"));
    const playEnergyCollect = vi.fn(() => order.push("collect-audio"));
    const cueFeatureEnvironment = vi.fn(() => order.push("collect-environment"));
    const presentAfterReels = vi.fn(async () => {
      order.push("collect-visual");
    });
    const announceEvent = vi.fn(async () => {
      order.push("announce");
    });
    Object.assign(controller, {
      activeObservedFeatureEvents: [],
      presentationObserver: null,
      audio: { playPpsLevel, playEnergyCollect },
      renderer: {
        setRageAuraLevel,
        cueFeatureEnvironment,
        featureEffects: { presentAfterReels },
      },
      ui: { announceEvent },
      presentEffect: async (effect: () => Promise<void>) => effect(),
    });
    const event: FeatureEvent = {
      type: "surge.collected",
      count: 1,
      cells: [{ reel: 1, row: 0 }],
      triggered: false,
      guaranteed: false,
      level: 2,
      total: 12,
    };
    const state: FeatureAudioState = {
      rageLevel: 1,
      showFreeSpinSummary: false,
    };

    await controller.presentPostReelFeatureEvent(
      event,
      BASE_LEVEL_TWO_FEATURE,
      false,
      state,
    );

    expect(order).toEqual([
      "pps-level-2",
      "aura-2",
      "collect-audio",
      "collect-environment",
      "collect-visual",
      "announce",
    ]);
    expect(playPpsLevel).toHaveBeenCalledOnce();
    expect(playPpsLevel).toHaveBeenCalledWith(2, {
      intensity: 1,
      reducedMotion: false,
    });
    expect(setRageAuraLevel).toHaveBeenCalledOnce();
    expect(setRageAuraLevel).toHaveBeenCalledWith(2);
    expect(presentAfterReels).toHaveBeenCalledOnce();
    expect(state.rageLevel).toBe(2);
  });

  it("plays one centered RageCollect program for a two-source non-trigger batch only", () => {
    const controller = prototypeHarness();
    const playEnergyCollect = vi.fn();
    controller.audio = { playEnergyCollect };
    const state: FeatureAudioState = {
      rageLevel: 1,
      showFreeSpinSummary: false,
    };
    const cells = [{ reel: 0, row: 1 }, { reel: 1, row: 1 }] as const;

    controller.presentFeatureAudio({
      type: "surge.collected",
      count: 2,
      cells,
      triggered: false,
      guaranteed: false,
      level: 1,
      total: 2,
    }, false, state);

    expect(playEnergyCollect).toHaveBeenCalledOnce();
    expect(playEnergyCollect).toHaveBeenCalledWith({
      pan: 0,
      intensity: 1,
      reducedMotion: false,
    });

    playEnergyCollect.mockClear();
    controller.presentFeatureAudio({
      type: "surge.collected",
      count: 2,
      cells,
      triggered: true,
      guaranteed: false,
      level: 1,
      total: 2,
    }, false, state);

    expect(playEnergyCollect).not.toHaveBeenCalled();
  });

  it("separates Wheel SHOW, IDLE, and SUMMARY_SHOW audio programs", () => {
    const controller = prototypeHarness();
    const order: string[] = [];
    Object.assign(controller, {
      reducedMotion: false,
      reducedMotionMedia: null,
      presentationObserver: null,
      ui: { setSpinMode: vi.fn() },
      audio: {
        playWheelAppear: vi.fn(() => order.push("appear")),
        playWheelPanelIn: vi.fn(() => order.push("panel-in")),
        startWheelWait: vi.fn(() => order.push("wait")),
      },
    });

    controller.presentFeatureAudio(
      { type: "wheel.started" },
      false,
      { rageLevel: 1, showFreeSpinSummary: false },
    );
    expect(order).toEqual(["appear", "panel-in"]);

    controller.presentFeaturePresentationMilestone("wheel.input-ready");
    expect(order).toEqual(["appear", "panel-in", "wait"]);

    controller.presentFeaturePresentationMilestone("wheel.summary-input-ready");
    expect(order).toEqual(["appear", "panel-in", "wait", "panel-in"]);
  });

  it("keeps final Vault awards silent while retaining Wheel-owned jackpot pots", () => {
    const controller = prototypeHarness();
    controller.audio = { playJackpotPot: vi.fn() };

    controller.presentFeatureAudio(
      {
        type: "vault.awarded",
        reel: 1,
        row: 0,
        prize: "MINI",
        multiplier: 10,
        amountMinor: "1000",
      },
      false,
      { rageLevel: 1, showFreeSpinSummary: false },
    );
    controller.presentFeatureAudio(
      {
        type: "vault.awarded",
        reel: 1,
        row: 1,
        prize: "MAJOR",
        multiplier: 75,
        amountMinor: "7500",
      },
      false,
      { rageLevel: 1, showFreeSpinSummary: false },
    );

    expect(controller.audio.playJackpotPot).not.toHaveBeenCalled();
  });

  it("routes Wheel audio only from the authored spin-relative 0 and 9.8s milestones", () => {
    const controller = prototypeHarness();
    controller.pendingWheelAward = null;
    controller.reducedMotion = false;
    controller.reducedMotionMedia = null;
    controller.audio = {
      stopWheelWait: vi.fn(),
      playWheelSpin: vi.fn(),
      playWheelAward: vi.fn(),
      playMonsterRoarHit: vi.fn(),
      playJackpotPot: vi.fn(),
    };
    const wheel: WheelAwardedEvent = {
      type: "wheel.awarded",
      outcome: "INSTANT",
      prize: "GRAND",
      multiplier: 1_000,
      amountMinor: "100000",
    };

    controller.presentFeatureAudio(
      wheel,
      false,
      { rageLevel: 1, showFreeSpinSummary: false },
    );
    expect(controller.audio.playWheelSpin).not.toHaveBeenCalled();
    expect(controller.audio.playWheelAward).not.toHaveBeenCalled();

    expect(WHEEL_CHARACTER_TIMING_MS.chestPoundStart).toBe(0);
    controller.presentFeaturePresentationMilestone("wheel.spin-start");
    expect(controller.audio.stopWheelWait).toHaveBeenCalledWith(200);
    expect(controller.audio.playWheelSpin).toHaveBeenCalledTimes(1);
    expect(controller.audio.playWheelAward).not.toHaveBeenCalled();

    expect(WHEEL_CHARACTER_TIMING_MS.chestPoundFinish)
      .toBe(PRIMAL_WHEEL_TIMELINE_MS.landing);
    controller.presentFeaturePresentationMilestone("wheel.spin-finish");
    expect(controller.audio.stopWheelWait).toHaveBeenCalledTimes(1);
    expect(controller.audio.playMonsterRoarHit).toHaveBeenCalledTimes(1);
    expect(controller.audio.playWheelAward).toHaveBeenCalledTimes(1);
    expect(controller.audio.playJackpotPot).toHaveBeenCalledTimes(1);
    expect(controller.audio.playJackpotPot).toHaveBeenCalledWith(
      "grand",
      expect.objectContaining({ intensity: 1, reducedMotion: false }),
    );
    expect(controller.pendingWheelAward).toBeNull();
  });

  it("exposes synchronous Wheel start, quick-stop, and finish milestones to fixtures", () => {
    const controller = prototypeHarness();
    const onPresentationMilestone = vi.fn();
    Object.assign(controller, {
      pendingWheelAward: null,
      wheelQuickStopAccepted: false,
      reducedMotion: false,
      reducedMotionMedia: null,
      presentationObserver: { onPresentationMilestone },
      ui: { setSpinMode: vi.fn() },
      audio: {
        stopWheelWait: vi.fn(),
        playWheelSpin: vi.fn(),
        playWheelAward: vi.fn(),
        playMonsterRoarHit: vi.fn(),
      },
    });

    controller.presentFeaturePresentationMilestone("wheel.spin-start");
    controller.presentFeaturePresentationMilestone("wheel.quick-stop");
    controller.presentFeaturePresentationMilestone("wheel.spin-finish");

    expect(onPresentationMilestone.mock.calls).toEqual([
      ["wheel.spin-start"],
      ["wheel.quick-stop"],
      ["wheel.spin-finish"],
    ]);
  });

  it("emits distinct silent feature semantics once at Landing and keeps feature.start later", () => {
    const cases = [
      {
        award: { type: "wheel.awarded", outcome: "OVERDRIVE" } as const,
        mode: "OVERDRIVE" as const,
        expected: "playWheelKingSpinWon",
        unexpected: "playWheelKongQuestWon",
      },
      {
        award: { type: "wheel.awarded", outcome: "EXPANSION" } as const,
        mode: "EXPANSION" as const,
        expected: "playWheelKongQuestWon",
        unexpected: "playWheelKingSpinWon",
      },
    ];

    for (const { award, mode, expected, unexpected } of cases) {
      const controller = prototypeHarness();
      controller.pendingWheelAward = null;
      controller.reducedMotion = false;
      controller.reducedMotionMedia = null;
      controller.audio = {
        playWheelAward: vi.fn(),
        playMonsterRoarHit: vi.fn(),
        playWheelKingSpinWon: vi.fn(),
        playWheelKongQuestWon: vi.fn(),
        playJackpotPot: vi.fn(),
        playFeatureStart: vi.fn(),
        setFreeSpinsMusicEnabled: vi.fn(),
      };

      controller.presentFeatureAudio(
        award,
        false,
        { rageLevel: 1, showFreeSpinSummary: false },
      );
      controller.presentFeaturePresentationMilestone("wheel.spin-finish");
      controller.presentFeaturePresentationMilestone("wheel.spin-finish");

      expect(controller.audio[expected]).toHaveBeenCalledTimes(1);
      expect(controller.audio[unexpected]).not.toHaveBeenCalled();

      controller.presentFeatureAudio(
        { type: "free_spins.started", mode, awarded: 8 },
        false,
        { rageLevel: 1, showFreeSpinSummary: false },
      );
      expect(controller.audio.playFeatureStart).toHaveBeenCalledTimes(1);
    }
  });

  it("fails closed when the Wheel visual exits before its landing milestone", async () => {
    const controller = prototypeHarness();
    const wheel: WheelAwardedEvent = {
      type: "wheel.awarded",
      outcome: "INSTANT",
      prize: "GRAND",
      multiplier: 1_000,
      amountMinor: "100000",
    };
    const abortWheelPresentation = vi.fn();
    const stopWheelWait = vi.fn();
    const setSpinMode = vi.fn();
    Object.assign(controller, {
      destroyed: false,
      pendingWheelAward: null,
      reducedMotion: false,
      reducedMotionMedia: null,
      audio: { stopWheelWait },
      ui: {
        setSpinMode,
        showError: vi.fn(),
        announceEvent: vi.fn(async () => undefined),
      },
      renderer: {
        cueFeatureEnvironment: vi.fn(),
        abortWheelPresentation,
        completeWheelPresentation: vi.fn(),
        featureEffects: {
          presentAfterReels: vi.fn(async () => {
            throw new Error("synthetic Wheel artwork failure");
          }),
        },
      },
    });

    await controller.presentPostReelFeatureEvent(
      wheel,
      BASE_FEATURE,
      false,
      { rageLevel: 1, showFreeSpinSummary: false },
    );

    expect(abortWheelPresentation).toHaveBeenCalledTimes(1);
    expect(stopWheelWait).toHaveBeenCalledWith(0);
    expect(setSpinMode).toHaveBeenCalledWith("waiting");
    expect(controller.pendingWheelAward).toBeNull();
  });

  it("projects Wheel popup and spin gates onto the existing Spin control", () => {
    const controller = prototypeHarness();
    const setSpinMode = vi.fn();
    controller.pendingWheelAward = null;
    controller.reducedMotion = false;
    controller.reducedMotionMedia = null;
    Object.assign(controller, {
      ui: { setSpinMode },
      audio: {
        startWheelWait: vi.fn(),
        stopWheelWait: vi.fn(),
        playWheelSpin: vi.fn(),
        playWheelAward: vi.fn(),
        playMonsterRoarHit: vi.fn(),
      },
    });

    controller.presentFeaturePresentationMilestone("wheel.popup-input-ready");
    controller.presentFeaturePresentationMilestone("wheel.popup-complete");
    controller.presentFeaturePresentationMilestone("wheel.input-ready");
    controller.presentFeaturePresentationMilestone("wheel.spin-start");
    controller.presentFeaturePresentationMilestone("wheel.quick-stop");
    controller.presentFeaturePresentationMilestone("wheel.spin-finish");

    expect(setSpinMode.mock.calls.map(([mode]) => mode)).toEqual([
      "wheel-popup-continue",
      "wheel-none",
      "wheel-ready",
      "wheel-fast-stop",
      "wheel-none",
      "wheel-none",
    ]);
  });

  it("keeps natural Landing on disabled Continue without allowing RNG fallthrough", () => {
    const controller = prototypeHarness();
    const setSpinMode = vi.fn();
    const requestSpin = vi.fn();
    Object.assign(controller, {
      pendingWheelAward: null,
      wheelQuickStopAccepted: false,
      wheelLandingInputBlocked: false,
      reducedMotion: false,
      reducedMotionMedia: null,
      ui: { setSpinMode },
      audio: {
        stopWheelWait: vi.fn(),
        playWheelSpin: vi.fn(),
        playWheelAward: vi.fn(),
        playMonsterRoarHit: vi.fn(),
      },
      renderer: {
        requestFreeSpinCapContinue: vi.fn(() => false),
        requestFreeSpinSummaryContinue: vi.fn(() => false),
        requestFreeSpinContinue: vi.fn(() => false),
        requestWheelSummaryContinue: vi.fn(() => false),
        requestWheelInteraction: vi.fn(() => null),
      },
      machine: { canSpin: true },
      gateway: { hasPendingSpin: false, requestSpin },
      reelRound: { state: "Idle" },
    });

    controller.presentFeaturePresentationMilestone("wheel.spin-start");
    controller.presentFeaturePresentationMilestone("wheel.spin-finish");
    controller.requestSpin();

    expect(setSpinMode.mock.calls.map(([mode]) => mode)).toEqual([
      "wheel-fast-stop",
      "wheel-landing-continue",
    ]);
    expect(requestSpin).not.toHaveBeenCalled();
  });

  it("projects the bounded Wheel summary hold onto CONTINUE, then restores waiting", () => {
    const controller = prototypeHarness();
    const setSpinMode = vi.fn();
    controller.reducedMotion = false;
    controller.reducedMotionMedia = null;
    Object.assign(controller, {
      ui: { setSpinMode },
      audio: { playWheelPanelIn: vi.fn() },
    });

    controller.presentFeaturePresentationMilestone("wheel.summary-input-ready");
    controller.presentFeaturePresentationMilestone("wheel.summary-complete");

    expect(setSpinMode.mock.calls.map(([mode]) => mode)).toEqual([
      "wheel-summary-continue",
      "wheel-none",
    ]);
  });

  it("projects the whole-round information line only at the Layer-B handoff", () => {
    const controller = prototypeHarness();
    const showWheelBonusRoundSummary = vi.fn();
    const setSpinMode = vi.fn();
    const onPresentationMilestone = vi.fn();
    Object.assign(controller, {
      reducedMotion: false,
      reducedMotionMedia: null,
      snapshot: { lastWinMinor: "1200" },
      presentationObserver: { onPresentationMilestone },
      ui: { showWheelBonusRoundSummary, setSpinMode },
      audio: {},
    });

    controller.presentFeaturePresentationMilestone("wheel.bonus-label-ready");

    expect(showWheelBonusRoundSummary).toHaveBeenCalledOnce();
    expect(showWheelBonusRoundSummary).toHaveBeenCalledWith("1200");
    expect(onPresentationMilestone).toHaveBeenCalledWith("wheel.bonus-label-ready");
    expect(setSpinMode).not.toHaveBeenCalled();
  });

  it("Pass86 retains the MINI summary and tower through Base-ready, then resets before the next accepted Base reel start", () => {
    const order: string[] = [];
    let towerState: "normal" | "mini-highlight" | "show-reset" = "normal";
    const highlightAward = vi.fn((prize: string | undefined) => {
      towerState = "mini-highlight";
      order.push(`tower:highlight:${prize}`);
    });
    const resetPanelAnimations = vi.fn(() => {
      towerState = "show-reset";
      order.push("tower:show-reset");
    });
    const beginSpin = vi.fn(() => {
      expect(towerState).toBe("show-reset");
      order.push("reels:begin");
    });
    const renderer = Object.create(PixiRenderer.prototype) as PixiRenderer;
    Object.assign(renderer as unknown as Record<string, unknown>, {
      pendingWheelAward: {
        type: "wheel.awarded",
        outcome: "INSTANT",
        prize: "MINI",
        multiplier: 10,
        amountMinor: "1000",
      } satisfies WheelAwardedEvent,
      wheelBonusWinLabel: { show: vi.fn(), hide: vi.fn(), cancel: vi.fn() },
      jackpotTower: { highlightAward, resetPanelAnimations },
      introCompleted: true,
      launchScene: { setCharacterPersistentPresentation: vi.fn() },
      gameLogo: { show: vi.fn(), hide: vi.fn(), setIdleAllowed: vi.fn() },
      environmentState: createSpinEnvironmentState(),
      reels: { beginSpin },
      requestFreeSpinCapContinue: vi.fn(() => false),
      requestFreeSpinSummaryContinue: vi.fn(() => false),
      requestFreeSpinContinue: vi.fn(() => false),
      requestWheelSummaryContinue: vi.fn(() => false),
      requestWheelInteraction: vi.fn(() => null),
    });

    (renderer as unknown as { commitPendingWheelAward(): void })
      .commitPendingWheelAward();
    expect(towerState).toBe("mini-highlight");

    const controller = prototypeHarness();
    const showWheelBonusRoundSummary = vi.fn((amountMinor: string) => {
      expect(towerState).toBe("mini-highlight");
      order.push(`ui:summary:${amountMinor}`);
    });
    const clearWheelBonusRoundSummary = vi.fn();
    const commitAcceptedPaidAutoplaySpin = vi.fn(() => {
      order.push("auto:paid-spin-committed");
    });
    Object.assign(controller, {
      destroyed: false,
      presentationObserver: null,
      machine: { canSpin: true, transition: vi.fn() },
      gateway: {
        hasPendingSpin: false,
        requestSpin: vi.fn(() => {
          order.push("gateway:accepted");
          return true;
        }),
      },
      reelRound: { state: "Idle", transition: vi.fn() },
      audio: {
        unlock: vi.fn(() => new Promise<boolean>(() => undefined)),
        beginBaseMusicRound: vi.fn(),
        playReelStart: vi.fn(),
        startReelLoop: vi.fn(),
        playWheelPanelIn: vi.fn(),
      },
      renderer,
      stops: { markSpinStart: vi.fn() },
      ui: {
        showWheelBonusRoundSummary,
        clearWheelBonusRoundSummary,
        setSpinMode: vi.fn(),
        commitAcceptedPaidAutoplaySpin,
        resetWinCounter: vi.fn(),
      },
      snapshot: {
        balanceMinor: "101100",
        selectedBetMinor: "100",
        betOptionsMinor: ["100"],
        featureState: BASE_FEATURE,
        lastWinMinor: "1200",
        currentGrid: BASE_GRID,
      },
      cancelScheduledFreeSpin: vi.fn(),
      refreshUi: vi.fn(),
      reducedMotion: false,
      reducedMotionMedia: null,
      spinAudioGeneration: 0,
    });

    controller.presentFeaturePresentationMilestone("wheel.summary-input-ready");
    controller.presentFeaturePresentationMilestone("wheel.bonus-label-ready");
    expect(showWheelBonusRoundSummary).toHaveBeenCalledOnce();
    expect(showWheelBonusRoundSummary).toHaveBeenCalledWith("1200");
    expect(resetPanelAnimations).not.toHaveBeenCalled();
    expect(towerState).toBe("mini-highlight");

    // 摘要界面的 Continue/outro 会返回 Base 机台，但在真正的 SPIN_START 之前，
    // 仍会保留总赢分信息的所有者和 MINI 高亮。
    renderer.completeWheelPresentation(BASE_FEATURE);
    order.push("returned:base-ready");
    expect(clearWheelBonusRoundSummary).not.toHaveBeenCalled();
    expect(resetPanelAnimations).not.toHaveBeenCalled();
    expect(towerState).toBe("mini-highlight");

    controller.requestSpin();

    expect(order).toEqual([
      "tower:highlight:MINI",
      "ui:summary:1200",
      "returned:base-ready",
      "gateway:accepted",
      "auto:paid-spin-committed",
      "tower:show-reset",
      "reels:begin",
    ]);
    expect(commitAcceptedPaidAutoplaySpin).toHaveBeenCalledOnce();
    expect(resetPanelAnimations).toHaveBeenCalledOnce();
    expect(beginSpin).toHaveBeenCalledOnce();
    expect(resetPanelAnimations.mock.invocationCallOrder[0])
      .toBeLessThan(beginSpin.mock.invocationCallOrder[0] ?? 0);
  });

  it("projects waitForContinue onto the same authored Spin control", () => {
    const controller = prototypeHarness();
    const setSpinMode = vi.fn();
    controller.reducedMotion = false;
    controller.reducedMotionMedia = null;
    Object.assign(controller, { ui: { setSpinMode }, audio: {} });

    controller.presentFeaturePresentationMilestone("free-spins.input-ready");
    controller.presentFeaturePresentationMilestone("free-spins.continue");

    expect(setSpinMode.mock.calls.map(([mode]) => mode)).toEqual([
      "feature-continue",
      "waiting",
    ]);
  });

  it("projects the bounded Free Spins summary hold onto CONTINUE, then restores waiting", () => {
    const controller = prototypeHarness();
    const setSpinMode = vi.fn();
    controller.reducedMotion = false;
    controller.reducedMotionMedia = null;
    Object.assign(controller, { ui: { setSpinMode }, audio: {} });

    controller.presentFeaturePresentationMilestone("free-spins.summary-input-ready");
    controller.presentFeaturePresentationMilestone("free-spins.summary-complete");

    expect(setSpinMode.mock.calls.map(([mode]) => mode)).toEqual([
      "free-spin-summary-continue",
      "waiting",
    ]);
  });

  it("exposes stable input and semantic exit milestones to automation", () => {
    const controller = prototypeHarness();
    const onPresentationMilestone = vi.fn();
    controller.reducedMotion = false;
    controller.reducedMotionMedia = null;
    Object.assign(controller, {
      presentationObserver: { onPresentationMilestone },
      snapshot: { featureState: BASE_FEATURE },
      renderer: { beginFeatureExitAtSummaryHide: vi.fn() },
      ui: { setSpinMode: vi.fn() },
      audio: { endFreeSpinsMode: vi.fn() },
    });

    controller.presentFeaturePresentationMilestone("free-spins.summary-input-ready");
    controller.presentFeaturePresentationMilestone("free-spins.summary-hide");

    expect(onPresentationMilestone.mock.calls).toEqual([
      ["free-spins.summary-input-ready"],
      [null],
      ["free-spins.exit-started"],
    ]);
  });

  it("projects the CAPLIMIT hold onto CONTINUE_SPIN, then restores waiting", () => {
    const controller = prototypeHarness();
    const setSpinMode = vi.fn();
    controller.reducedMotion = false;
    controller.reducedMotionMedia = null;
    Object.assign(controller, { ui: { setSpinMode }, audio: {} });

    controller.presentFeaturePresentationMilestone("free-spin-cap.input-ready");
    controller.presentFeaturePresentationMilestone("free-spin-cap.continue");

    expect(setSpinMode.mock.calls.map(([mode]) => mode)).toEqual([
      "cap-continue",
      "waiting",
    ]);
  });

  it("publishes exact bounded-gate close branches without letting observers interrupt play", () => {
    const controller = prototypeHarness();
    const branches: unknown[] = [];
    Object.assign(controller, {
      presentationObserver: {
        onPresentationBranch: (branch: unknown) => {
          branches.push(branch);
          if (branches.length === 2) throw new Error("fixture observer failure");
        },
      },
    });

    expect(() => {
      controller.observePresentationBranch({
        type: "free-spin-cap.closed",
        reason: "continue",
      });
      controller.observePresentationBranch({
        type: "free-spins.summary.closed",
        reason: "timeout",
      });
      controller.observePresentationBranch({
        type: "free-spins.summary.closed",
        reason: "cancelled",
      });
    }).not.toThrow();

    expect(branches).toEqual([
      { type: "free-spin-cap.closed", reason: "continue" },
      { type: "free-spins.summary.closed", reason: "timeout" },
      { type: "free-spins.summary.closed", reason: "cancelled" },
    ]);
    expect(branches.every(Object.isFrozen)).toBe(true);
  });

  it("requests input-ready barriers only with an active sequence and fails open without an observer", async () => {
    const controller = prototypeHarness();
    const checkpoints: AppPresentationCheckpoint[] = [];
    Object.assign(controller, {
      activePresentationSequence: 2,
      presentationObserver: null,
    });
    expect(controller.requestFeaturePresentationInputCheckpoint("free-spin-cap"))
      .toBeUndefined();

    Object.assign(controller, {
      presentationObserver: {
        onPresentationCheckpoint: (checkpoint: AppPresentationCheckpoint) => {
          checkpoints.push(checkpoint);
          return Promise.reject(new Error("fixture checkpoint failed"));
        },
      },
    });
    await expect(controller.requestFeaturePresentationInputCheckpoint("free-spin-cap"))
      .resolves.toBeUndefined();
    expect(checkpoints).toEqual([{
      type: "bounded-gate-input-ready",
      gate: "free-spin-cap",
      sequence: 2,
    }]);
    expect(Object.isFrozen(checkpoints[0])).toBe(true);

    Object.assign(controller, { activePresentationSequence: null });
    expect(controller.requestFeaturePresentationInputCheckpoint("free-spins-summary"))
      .toBeUndefined();
    expect(checkpoints).toHaveLength(1);
  });

  it("starts feature environment reset at the Free Spins summary hide boundary", () => {
    const controller = prototypeHarness();
    const beginFeatureExitAtSummaryHide = vi.fn();
    const endFreeSpinsMode = vi.fn();
    controller.reducedMotion = false;
    controller.reducedMotionMedia = null;
    Object.assign(controller, {
      snapshot: { featureState: { ...BASE_FEATURE } },
      renderer: { beginFeatureExitAtSummaryHide },
      ui: { setSpinMode: vi.fn() },
      audio: { endFreeSpinsMode },
    });

    controller.presentFeaturePresentationMilestone("free-spins.summary-hide");

    expect(beginFeatureExitAtSummaryHide).toHaveBeenCalledWith(BASE_FEATURE, false);
    expect(endFreeSpinsMode).toHaveBeenCalledWith({ intensity: 1, reducedMotion: false });
  });

  it("routes random COLLECT win audio without duplicating deterministic WIN states", () => {
    const controller = prototypeHarness();
    controller.reducedMotion = false;
    controller.reducedMotionMedia = null;
    const playMonsterRoar = vi.fn();
    const playMonsterRoarHit = vi.fn();
    controller.audio = {
      playMonsterRoar,
      playMonsterRoarHit,
    };

    controller.presentCharacterAudio({ animation: "win", context: "state" });
    expect(controller.audio.playMonsterRoar).not.toHaveBeenCalled();
    expect(controller.audio.playMonsterRoarHit).not.toHaveBeenCalled();

    controller.presentCharacterAudio({ animation: "idle_breaker2", context: "collect-random" });
    controller.presentCharacterAudio({ animation: "chest_pound", context: "collect-random" });
    controller.presentCharacterAudio({ animation: "win", context: "collect-random" });
    expect(controller.audio.playMonsterRoar).toHaveBeenCalledTimes(2);
    expect(controller.audio.playMonsterRoarHit).toHaveBeenCalledTimes(1);

    playMonsterRoar.mockClear();
    playMonsterRoarHit.mockClear();

    controller.presentRoundWinCharacterAudio("base");
    controller.presentRoundWinCharacterAudio("feature");
    controller.presentRoundWinCharacterAudio("kq");
    expect(controller.audio.playMonsterRoar).toHaveBeenCalledTimes(1);
    expect(controller.audio.playMonsterRoarHit).toHaveBeenCalledTimes(2);
  });

  it("adds exact Thump audio to Rage respin/pound and separates reel-reset families", () => {
    const controller = prototypeHarness();
    controller.reducedMotion = false;
    controller.reducedMotionMedia = null;
    controller.audio = {
      playMonsterThump: vi.fn(),
      playMonsterThumpExpand: vi.fn(),
    };

    controller.presentCharacterAudio({ animation: "respin", context: "state" });
    controller.presentCharacterAudio({ animation: "pound", context: "state" });
    controller.presentFeaturePresentationMilestone("reels.decrease-kq");
    controller.presentFeaturePresentationMilestone("reels.reset-base");

    expect(controller.audio.playMonsterThump).toHaveBeenCalledTimes(3);
    expect(controller.audio.playMonsterThumpExpand).toHaveBeenCalledTimes(1);
  });

  it("derives terminal Free Spins Big Win recovery from the real pre-round mode", async () => {
    const previous: FeatureState = {
      mode: "EXPANSION",
      freeSpinsRemaining: 1,
      freeSpinsPlayed: 7,
      baseBetMinor: "100",
      freeSpinsWinMinor: "1000",
      rageLevel: 5,
      rageCollected: 3,
    };
    const controller = createRoundHarness(previous);
    const musicOrder: string[] = [];
    Object.assign(controller.audio, {
      beginBigWin: vi.fn((inFreeSpins: boolean) => {
        expect(inFreeSpins).toBe(true);
        musicOrder.push("big-win:loop-end");
      }),
      endBigWin: vi.fn((resume: "ambient" | "free-spins") => {
        musicOrder.push(`big-win:${resume}`);
      }),
      setFreeSpinsMusicEnabled: vi.fn((enabled: boolean, _options: unknown, visible: boolean) => {
        if (!enabled) musicOrder.push(`summary:loop-end:${visible}`);
      }),
      endFreeSpinsMode: vi.fn(() => musicOrder.push("base:start")),
    });
    delete (controller as unknown as { presentPostReelFeatureEvents?: unknown })
      .presentPostReelFeatureEvents;

    const renderer = controller.renderer as {
      bigWin: { present: ReturnType<typeof vi.fn> };
      featureEffects: Record<string, unknown>;
      hideFreeSpinHud?: ReturnType<typeof vi.fn>;
    };
    renderer.bigWin.present.mockImplementation(async () => {
      controller.presentBigWinAudio({ type: "show" });
      controller.presentBigWinAudio({ type: "hide-start" });
      controller.presentBigWinAudio({ type: "complete" });
    });
    renderer.featureEffects.presentAfterReels = vi.fn(async (event: FeatureEvent) => {
      if (event.type === "free_spins.completed") {
        controller.presentFeaturePresentationMilestone("free-spins.summary-hide");
      }
    });
    renderer.hideFreeSpinHud = vi.fn(async () => undefined);

    controller.handleSpinResult(roundResult({
      chargedBetMinor: "0",
      totalWinMinor: "2000",
      wins: [{
        id: "terminal-big-win",
        symbol: "TANK",
        nominalAmountMinor: "2000",
        amountMinor: "2000",
        cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
      }],
      events: [
        { type: "grid.expanded", rows: 3, ways: 27 },
        {
          type: "free_spins.completed",
          mode: "EXPANSION",
          awarded: 8,
          cumulativeWinMinor: "3000",
        },
      ],
      featureState: { ...BASE_FEATURE, rageLevel: 5, rageCollected: 3 },
    }));
    await controller.presentation;

    expect(musicOrder).toEqual([
      "big-win:loop-end",
      "big-win:free-spins",
      "summary:loop-end:true",
      "base:start",
    ]);
    expect(controller.audio.endBigWin).toHaveBeenCalledWith(
      "free-spins",
      expect.objectContaining({ intensity: 1, reducedMotion: false }),
    );
    expect(controller.audio.endFreeSpinsMode).toHaveBeenCalledTimes(1);
  });

  it("keeps every Big Win audio boundary when input advances the timeline", () => {
    const controller = prototypeHarness();
    controller.reducedMotion = false;
    controller.reducedMotionMedia = null;
    controller.bigWinInFreeSpins = false;
    controller.bigWinMusicResume = "ambient";
    controller.audio = {
      beginBigWin: vi.fn(),
      beginBigWinCounter: vi.fn(),
      playBigWinLevelUp: vi.fn(),
      endBigWinCounter: vi.fn(),
      endBigWin: vi.fn(),
    };

    for (const type of [
      "show", "count-start", "level-up", "count-end", "hide-start", "complete",
    ] as const) {
      controller.presentBigWinAudio({ type });
    }

    expect(controller.audio.beginBigWin).toHaveBeenCalledTimes(1);
    expect(controller.audio.beginBigWinCounter).toHaveBeenCalledTimes(1);
    expect(controller.audio.playBigWinLevelUp).toHaveBeenCalledTimes(1);
    expect(controller.audio.endBigWinCounter).toHaveBeenCalledTimes(1);
    expect(controller.audio.endBigWin).toHaveBeenCalledWith(
      "ambient",
      expect.objectContaining({ intensity: 1, reducedMotion: false }),
    );
  });

  it("keeps the pre-round feature projection across a pending-spin reconnect", () => {
    const controller = prototypeHarness();
    const root = { dataset: {} };
    const origin: FeatureState = {
      mode: "EXPANSION",
      freeSpinsRemaining: 2,
      freeSpinsPlayed: 6,
      freeSpinsWinMinor: "700",
      rageLevel: 5,
      rageCollected: 0,
    };
    const restoreFeatureState = vi.fn();
    const applySession = vi.fn();
    const syncGameMusic = vi.fn();
    const setMoneyDisplayBinding = vi.fn();
    const machine = { phase: "recovering", transition: vi.fn() };
    Object.assign(controller, {
      snapshot: {
        balanceMinor: "10000",
        selectedBetMinor: "100",
        betOptionsMinor: ["100"],
        featureState: origin,
        lastWinMinor: "0",
        currentGrid: BASE_GRID,
      },
      roundOriginFeatureState: null,
      root,
      hasOpenedSession: true,
      visibleBalanceMinor: "10000",
      gateway: { hasPendingSpin: true },
      machine,
      renderer: { reels: { setGrid: vi.fn() }, restoreFeatureState, setMoneyDisplayBinding },
      ui: { applySession },
      launch: { canEnterGame: true, transition: vi.fn() },
      syncGameMusic,
      syncLaunchUi: vi.fn(),
      refreshUi: vi.fn(),
    });
    const session: SessionOpened = {
      type: "session.opened",
      protocolVersion: 1,
      requestId: "reconnect-1",
      sessionId: "session-1",
      currency: "EUR",
      currencyExponent: 2,
      balanceMinor: "9900",
      betOptionsMinor: ["100", "200"],
      defaultBetMinor: "200",
      featureState: BASE_FEATURE,
    };

    controller.handleSession(session);

    expect(controller.roundOriginFeatureState).toEqual(origin);
    expect((controller as unknown as { snapshot: GameSnapshot }).snapshot.featureState).toEqual(origin);
    expect(restoreFeatureState).not.toHaveBeenCalled();
    expect(syncGameMusic).not.toHaveBeenCalled();
    expect(setMoneyDisplayBinding).toHaveBeenCalledWith(expect.objectContaining({
      currency: "EUR",
      currencyExponent: 2,
    }));
    expect(applySession).toHaveBeenCalledWith(expect.objectContaining({
      balanceMinor: "10000",
      featureState: origin,
    }));
    expect(root.dataset).toEqual({ rgsSession: "online" });
  });

  it("fails closed before snapshot or renderer writes when a session money binding drifts", () => {
    const controller = prototypeHarness();
    const close = vi.fn();
    const setMoneyDisplayBinding = vi.fn();
    const applySession = vi.fn();
    const machine = { phase: "ready", transition: vi.fn() };
    const launch = { transition: vi.fn() };
    const snapshot: GameSnapshot = {
      currency: "EUR",
      currencyExponent: 2,
      balanceMinor: "10000",
      selectedBetMinor: "100",
      betOptionsMinor: ["100"],
      featureState: BASE_FEATURE,
      lastWinMinor: "0",
      currentGrid: BASE_GRID,
    };
    const root = { dataset: { rgsSession: "online" } as Record<string, string> };
    Object.assign(controller, {
      root,
      snapshot,
      sessionMoneyBinding: {
        sessionId: "session-money",
        currency: "EUR",
        currencyExponent: 2,
      },
      hasOpenedSession: true,
      destroyed: false,
      gateway: { hasPendingSpin: false, close },
      machine,
      launch,
      renderer: { setMoneyDisplayBinding },
      ui: { applySession },
      syncLaunchUi: vi.fn(),
      presentPlayerFacingError: vi.fn(),
      refreshUi: vi.fn(),
    });

    controller.handleSession({
      type: "session.opened",
      protocolVersion: 1,
      requestId: "request-money-drift",
      sessionId: "session-money",
      currency: "EUR",
      currencyExponent: 3,
      balanceMinor: "10000",
      betOptionsMinor: ["100"],
      defaultBetMinor: "100",
      featureState: BASE_FEATURE,
    });

    expect(machine.transition).toHaveBeenCalledWith({ type: "FATAL_ERROR" });
    expect(close).toHaveBeenCalledOnce();
    expect(launch.transition).toHaveBeenCalledWith({ type: "FAIL" });
    expect(root.dataset).not.toHaveProperty("rgsSession");
    expect(setMoneyDisplayBinding).not.toHaveBeenCalled();
    expect(applySession).not.toHaveBeenCalled();
    expect((controller as unknown as { snapshot: GameSnapshot }).snapshot).toBe(snapshot);
  });

  it("restores an initial Base level-two PPS state once without replaying EVOLVE or level-up audio", () => {
    const controller = prototypeHarness();
    const restoreFeatureState = vi.fn();
    const setRageAuraLevel = vi.fn();
    const playPpsLevel = vi.fn();
    const machine = { phase: "connecting", transition: vi.fn() };
    const launch = { canEnterGame: false, transition: vi.fn() };
    Object.assign(controller, {
      snapshot: {
        balanceMinor: "0",
        selectedBetMinor: "100",
        betOptionsMinor: ["100"],
        featureState: BASE_FEATURE,
        lastWinMinor: "0",
        currentGrid: BASE_GRID,
      },
      bufferedRecoveredSpinResult: null,
      gateway: { hasPendingSpin: false },
      hasOpenedSession: false,
      balanceVisibilityBlocked: false,
      roundOriginFeatureState: null,
      visibleBalanceMinor: "0",
      machine,
      renderer: {
        reels: { setGrid: vi.fn() },
        restoreFeatureState,
        setRageAuraLevel,
      },
      ui: { applySession: vi.fn() },
      launch,
      audio: { playPpsLevel },
      featurePreviewActive: false,
      initialSessionResolver: null,
      syncGameMusic: vi.fn(),
      syncLaunchUi: vi.fn(),
      refreshUi: vi.fn(),
    });
    const session: SessionOpened = {
      type: "session.opened",
      protocolVersion: 1,
      requestId: "base-level-two-session",
      sessionId: "session-1",
      currency: "EUR",
      currencyExponent: 2,
      balanceMinor: "10000",
      betOptionsMinor: ["100"],
      defaultBetMinor: "100",
      featureState: { ...BASE_LEVEL_TWO_FEATURE },
    };

    controller.handleSession(session);

    expect(restoreFeatureState).toHaveBeenCalledTimes(1);
    expect(restoreFeatureState).toHaveBeenCalledWith(BASE_LEVEL_TWO_FEATURE);
    expect(setRageAuraLevel).not.toHaveBeenCalled();
    expect(playPpsLevel).not.toHaveBeenCalled();
    expect((controller as unknown as { snapshot: GameSnapshot }).snapshot.featureState)
      .toEqual(BASE_LEVEL_TWO_FEATURE);
  });

  it("buffers a Base 1/11 -> 2/12 durable level-up behind launch and ACKs after one full lifecycle", async () => {
    vi.stubGlobal("window", { location: { search: "" } });
    try {
    const controller = createRoundHarness();
    const machine = new GameStateMachine();
    const reelRound = new ReelRoundStateMachine();
    const launch = new LaunchStateMachine();
    const recoveredOrigin: FeatureState = {
      ...BASE_FEATURE,
      freeSpinsPlayed: 0,
      rageCollected: 11,
    };
    const recoveredFinalState: FeatureState = {
      ...BASE_LEVEL_TWO_FEATURE,
      freeSpinsPlayed: 0,
    };
    const recoveredGrid: GridCell[][] = BASE_GRID.map((reel, reelIndex) => (
      reel.map((cell, rowIndex) => (
        reelIndex === 1 && rowIndex === 0 ? { symbol: "SURGE" as const } : cell
      ))
    ));
    machine.transition({ type: "START" });
    launch.transition({ type: "START_PRELOAD" });

    let releasePreload!: () => void;
    const preloadBarrier = new Promise<void>((resolve) => {
      releasePreload = resolve;
    });
    const recoveryOrder: string[] = [];
    const pendingAtAcknowledgement: boolean[] = [];
    const gateway = {
      hasPendingSpin: true,
      acknowledgeSpinResult: vi.fn((_roundId: string, _sequence: number) => true),
    };
    gateway.acknowledgeSpinResult.mockImplementation(() => {
      pendingAtAcknowledgement.push(gateway.hasPendingSpin);
      recoveryOrder.push("ack");
      gateway.hasPendingSpin = false;
      return true;
    });
    const { acknowledgeSpinResult } = gateway;
    const presentationStates: string[] = [];
    const traces: AppPresentationTrace[] = [];
    const visibleOrder: string[] = [];
    const roundOrder: string[] = [];
    reelRound.subscribe(({ state }) => roundOrder.push(`reel:${state}`), false);
    const renderer = controller.renderer as {
      reels: Record<string, unknown>;
      beginSpinPresentation?: ReturnType<typeof vi.fn>;
      finishSpinPresentation: ReturnType<typeof vi.fn>;
      restoreFeatureState?: ReturnType<typeof vi.fn>;
    };
    renderer.beginSpinPresentation = vi.fn(() => {
      visibleOrder.push("spin-visible");
      roundOrder.push("spin-visible");
    });
    renderer.restoreFeatureState = vi.fn((state: FeatureState) => {
      roundOrder.push(`restore:${state.mode}`);
    });
    renderer.reels.setGrid = vi.fn();
    Object.assign(controller.audio, {
      beginBaseMusicRound: vi.fn(),
      playReelStart: vi.fn(),
      startReelLoop: vi.fn(),
      endBaseMusicRound: vi.fn(),
    });
    const markSpinStart = vi.fn();
    const presentStops = vi.fn(async () => {
      reelRound.transition({ type: "REEL_STOP_STARTED", reel: 0 });
      reelRound.transition({ type: "REEL_STOP_STARTED", reel: 1 });
      reelRound.transition({ type: "REEL_STOP_STARTED", reel: 2 });
      reelRound.transition({ type: "ALL_REELS_STOPPED" });
    });
    Object.assign(controller, {
      machine,
      reelRound,
      launch,
      gateway,
      preload: { run: vi.fn(async () => preloadBarrier) },
      intro: { play: vi.fn(async () => undefined) },
      skipFeaturePreview: true,
      destroyed: false,
      hasOpenedSession: false,
      visibleBalanceMinor: "10000",
      balanceVisibilityBlocked: false,
      bufferedRecoveredSpinResult: null,
      freeSpinTimer: null,
      scatterLandOrdinal: 0,
      pendingWheelAward: null,
      wheelQuickStopAccepted: false,
      wheelLandingInputBlocked: false,
      spinAudioGeneration: 0,
      featurePreviewActive: false,
      initialSessionResolver: null,
      stops: { markSpinStart, present: presentStops },
      presentationObserver: {
        onRoundPresentationState: (state: string) => {
          presentationStates.push(state);
          recoveryOrder.push(`presentation:${state}`);
        },
        onPresentationTrace: (trace: AppPresentationTrace) => traces.push(trace),
      },
      syncGameMusic: vi.fn(),
      syncLaunchUi: vi.fn(() => visibleOrder.push(`launch:${launch.phase}`)),
      refreshUi: vi.fn(),
    });
    const ui = controller as unknown as {
      ui: {
        applySession: ReturnType<typeof vi.fn>;
        applyResult: ReturnType<typeof vi.fn>;
      };
    };
    ui.ui.applySession = vi.fn();

    const launchPromise = controller.runLaunch();
    controller.handleSession({
      type: "session.opened",
      protocolVersion: 1,
      requestId: "recover-session",
      sessionId: "session-1",
      currency: "EUR",
      currencyExponent: 2,
      balanceMinor: "99900",
      betOptionsMinor: ["100"],
      defaultBetMinor: "100",
      featureState: recoveredFinalState,
    });
    const recovered = roundResult({
      requestId: "recover-result",
      chargedBetMinor: "100",
      balanceMinor: "99900",
      totalWinMinor: "0",
      grid: recoveredGrid,
      wins: [],
      events: [{
        type: "surge.collected",
        count: 1,
        cells: [{ reel: 1, row: 0 }],
        triggered: false,
        guaranteed: false,
        level: 2,
        total: 12,
      }],
      featureState: recoveredFinalState,
    });

    controller.handleSpinResult(recovered, recoveredOrigin);
    controller.handleSpinResult(recovered, recoveredOrigin);
    controller.handleSession({
      type: "session.opened",
      protocolVersion: 1,
      requestId: "recover-session-refresh",
      sessionId: "session-1",
      currency: "EUR",
      currencyExponent: 2,
      balanceMinor: "99900",
      betOptionsMinor: ["100"],
      defaultBetMinor: "100",
      featureState: recoveredFinalState,
    });

    expect(machine.phase).toBe("requesting");
    expect(reelRound.snapshot).toMatchObject({
      state: "Idle",
      roundId: null,
      revision: 0,
    });
    expect(renderer.beginSpinPresentation).not.toHaveBeenCalled();
    expect(renderer.finishSpinPresentation).not.toHaveBeenCalled();
    expect(renderer.restoreFeatureState).not.toHaveBeenCalled();
    expect(ui.ui.applyResult).not.toHaveBeenCalled();
    expect(ui.ui.applySession).toHaveBeenLastCalledWith(expect.objectContaining({
      balanceMinor: "10000",
      featureState: BASE_FEATURE,
    }));
    expect(controller.snapshot.featureState).toEqual(BASE_FEATURE);
    expect(presentationStates).toEqual([]);
    expect(acknowledgeSpinResult).not.toHaveBeenCalled();
    expect(gateway.hasPendingSpin).toBe(true);

    releasePreload();
    await launchPromise;
    await controller.presentation;

    expect(launch.phase).toBe("ready");
    expect(machine.phase).toBe("ready");
    expect(reelRound.snapshot).toMatchObject({ state: "Idle", revision: 9 });
    expect(visibleOrder.indexOf("launch:ready")).toBeLessThan(
      visibleOrder.indexOf("spin-visible"),
    );
    expect(markSpinStart).toHaveBeenCalledTimes(1);
    expect(renderer.restoreFeatureState).toHaveBeenCalledTimes(1);
    expect(renderer.restoreFeatureState).toHaveBeenCalledWith(recoveredOrigin);
    expect(roundOrder.slice(0, 5)).toEqual([
      "reel:Spin_Start",
      "restore:BASE",
      "spin-visible",
      "reel:Spinning",
      "reel:Spin_Stopping",
    ]);
    const lifecycle = roundOrder
      .filter((entry) => entry.startsWith("reel:"))
      .map((entry) => entry.slice("reel:".length))
      .filter((state, index, states) => index === 0 || state !== states[index - 1]);
    expect(["Idle", ...lifecycle]).toEqual([
      "Idle",
      "Spin_Start",
      "Spinning",
      "Spin_Stopping",
      "Reel_Stop_One_By_One",
      "Result_Show",
      "Win_Line_Animation",
      "Idle",
    ]);
    expect(renderer.beginSpinPresentation).toHaveBeenCalledTimes(1);
    expect(renderer.finishSpinPresentation).toHaveBeenCalledTimes(1);
    expect(ui.ui.applyResult).toHaveBeenCalledTimes(1);
    expect(presentationStates).toEqual(["requested", "presenting", "complete"]);
    expect(traces.filter(({ type }) => type === "result.accepted")).toHaveLength(1);
    expect(traces.filter(({ type }) => type === "round.complete")).toHaveLength(1);
    expect(acknowledgeSpinResult).toHaveBeenCalledOnce();
    expect(acknowledgeSpinResult).toHaveBeenCalledWith(recovered.roundId, recovered.sequence);
    expect(pendingAtAcknowledgement).toEqual([true]);
    expect(gateway.hasPendingSpin).toBe(false);
    expect(recoveryOrder.indexOf("presentation:presenting"))
      .toBeLessThan(recoveryOrder.indexOf("ack"));
    expect(recoveryOrder.indexOf("ack"))
      .toBeLessThan(recoveryOrder.indexOf("presentation:complete"));

    controller.handleSpinResult(recovered, recoveredOrigin);
    await flushMicrotasks();
    expect(renderer.beginSpinPresentation).toHaveBeenCalledTimes(1);
    expect(ui.ui.applyResult).toHaveBeenCalledTimes(1);
    expect(acknowledgeSpinResult).toHaveBeenCalledTimes(1);
    expect(gateway.hasPendingSpin).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a malformed durable result before arming recovered pixels or audio", () => {
    const controller = createRoundHarness();
    const acknowledgeSpinResult = vi.fn(() => true);
    const machine = new GameStateMachine();
    const reelRound = new ReelRoundStateMachine();
    machine.transition({ type: "START" });
    machine.transition({ type: "SESSION_OPENED" });
    machine.transition({ type: "SPIN_REQUESTED" });
    const renderer = controller.renderer as {
      beginSpinPresentation?: ReturnType<typeof vi.fn>;
      restoreFeatureState?: ReturnType<typeof vi.fn>;
      cancelSpinPresentation: ReturnType<typeof vi.fn>;
    };
    renderer.beginSpinPresentation = vi.fn();
    renderer.restoreFeatureState = vi.fn();
    Object.assign(controller.audio, {
      beginBaseMusicRound: vi.fn(),
      playReelStart: vi.fn(),
      startReelLoop: vi.fn(),
    });
    Object.assign(controller, {
      machine,
      reelRound,
      launch: { canEnterGame: true },
      gateway: { hasPendingSpin: true, acknowledgeSpinResult },
      destroyed: false,
      bufferedRecoveredSpinResult: null,
      presentationObserver: null,
    });

    controller.handleSpinResult(roundResult({
      grid: BASE_GRID.slice(0, 2) as unknown as GridCell[][],
    }), BASE_FEATURE);

    expect(machine.phase).toBe("ready");
    expect(reelRound.snapshot).toMatchObject({ state: "Idle", revision: 1 });
    expect(renderer.restoreFeatureState).not.toHaveBeenCalled();
    expect(renderer.beginSpinPresentation).not.toHaveBeenCalled();
    expect(renderer.cancelSpinPresentation).toHaveBeenCalledTimes(1);
    expect(controller.audio.beginBaseMusicRound).not.toHaveBeenCalled();
    expect(controller.audio.playReelStart).not.toHaveBeenCalled();
    expect(controller.audio.startReelLoop).not.toHaveBeenCalled();
    expect(acknowledgeSpinResult).not.toHaveBeenCalled();
  });

  it("clears a held Wheel information line as soon as recovery begins", () => {
    const controller = prototypeHarness();
    const clearWheelBonusRoundSummary = vi.fn();
    const transition = vi.fn();
    Object.assign(controller, {
      machine: { phase: "presenting", transition },
      ui: {
        setConnection: vi.fn(),
        clearWheelBonusRoundSummary,
      },
      refreshUi: vi.fn(),
    });

    controller.handleStatus("recovering");

    expect(clearWheelBonusRoundSummary).toHaveBeenCalledOnce();
    // 演出仍负责整体恢复时序，但不再持有过期的 Layer-B 文案。
    expect(transition).not.toHaveBeenCalled();
  });

  it("makes an idle SESSION_TIMEOUT terminal, preserves recovery ownership, and hands EXIT to the operator once", () => {
    const controller = prototypeHarness();
    const exitHandlers: Array<() => void> = [];
    const requestOperatorSession = vi.fn();
    const resolveNormalWinDelay = vi.fn();
    const resolveFeaturePreview = vi.fn();
    const ui = {
      rollbackAcceptedPaidAutoplaySpin: vi.fn(),
      completeAutoplayStopRound: vi.fn(),
      setConnection: vi.fn(),
      setControls: vi.fn(),
      showSessionTimeout: vi.fn((handler: () => void) => exitHandlers.push(handler)),
    };
    const audio = {
      stopGameIntro: vi.fn(),
      stopReelLoop: vi.fn(),
      destroy: vi.fn(),
    };
    const renderer = {
      cancelSpinPresentation: vi.fn(),
      setFeaturePreviewVisible: vi.fn(),
    };
    const reelRound = { reset: vi.fn() };
    const stops = { cancel: vi.fn() };
    const preload = { abort: vi.fn() };
    const streamingAssets = { destroy: vi.fn() };
    const intro = { destroy: vi.fn() };
    const machine = { phase: "presenting", transition: vi.fn() };
    const root = { dataset: { rgsSession: "online" } as Record<string, string> };
    const clearInitialRgsSessionTimeout = vi.fn();
    const cancelScheduledFreeSpin = vi.fn();
    const stopPostWinIdleRepeat = vi.fn();
    const stopRoundAudio = vi.fn();
    const releaseFeatureAssetEventLease = vi.fn();
    Object.assign(controller as unknown as Record<string, unknown>, {
      destroyed: false,
      sessionTimedOut: false,
      connectionStatus: "online",
      root,
      ui,
      audio,
      renderer,
      reelRound,
      stops,
      preload,
      streamingAssets,
      intro,
      machine,
      clearInitialRgsSessionTimeout,
      cancelScheduledFreeSpin,
      stopPostWinIdleRepeat,
      stopRoundAudio,
      releaseFeatureAssetEventLease,
      requestOperatorSession,
      normalWinDelayResolver: resolveNormalWinDelay,
      featurePreviewResolver: resolveFeaturePreview,
      featurePreviewActive: true,
      featurePreviewContinuePending: true,
      activePresentationSequence: 12,
      activeRageCollectionPresentationSequence: 12,
      activeRageCascadePresentationSequence: 12,
      roundOriginFeatureState: BASE_FEATURE,
      bufferedRecoveredSpinResult: { result: roundResult(), originFeatureState: BASE_FEATURE },
    });

    controller.handleSessionTimeout({
      code: "SESSION_TIMEOUT",
      idleDisconnectAt: "2029-12-31T23:30:00Z",
    });
    controller.handleSessionTimeout({
      code: "SESSION_TIMEOUT",
      idleDisconnectAt: "2029-12-31T23:30:00Z",
    });

    expect(root.dataset).toEqual({
      rgsSessionTimeout: "true",
      rgsSessionTimeoutCode: "SESSION_TIMEOUT",
    });
    expect(ui.setConnection).toHaveBeenCalledWith("offline");
    expect(ui.setControls).toHaveBeenCalledWith(false, false);
    expect(ui.showSessionTimeout).toHaveBeenCalledOnce();
    expect(ui.rollbackAcceptedPaidAutoplaySpin).toHaveBeenCalledOnce();
    expect(ui.completeAutoplayStopRound).toHaveBeenCalledWith(12);
    expect(resolveNormalWinDelay).toHaveBeenCalledOnce();
    expect(resolveFeaturePreview).toHaveBeenCalledOnce();
    expect(stopRoundAudio).toHaveBeenCalledWith(0);
    expect(audio.stopGameIntro).toHaveBeenCalledWith(0);
    expect(audio.destroy).toHaveBeenCalledOnce();
    expect(stops.cancel).toHaveBeenCalledOnce();
    expect(renderer.cancelSpinPresentation).toHaveBeenCalledOnce();
    expect(reelRound.reset).toHaveBeenCalledWith("session-timeout");
    expect(releaseFeatureAssetEventLease.mock.calls).toEqual([["wheel"], ["free-spins"]]);
    expect(preload.abort).toHaveBeenCalledOnce();
    expect(streamingAssets.destroy).toHaveBeenCalledOnce();
    expect(intro.destroy).toHaveBeenCalledOnce();
    expect(machine.transition).toHaveBeenCalledWith({ type: "FATAL_ERROR" });
    expect(requestOperatorSession).not.toHaveBeenCalled();

    controller.handleStatus("online");
    controller.handleError(new Error("late transport callback"));
    controller.handleSpinResult(roundResult());
    expect(ui.setConnection).toHaveBeenCalledTimes(1);

    exitHandlers[0]?.();
    expect(requestOperatorSession).toHaveBeenCalledOnce();
    expect(requestOperatorSession.mock.calls[0]?.[1]).toBe("session-timeout");
  });

  it("keeps Splash Continue inert until the first authoritative session", () => {
    const controller = prototypeHarness();
    const resolveGate = vi.fn();
    const syncGameMusic = vi.fn();
    const playSplashContinue = vi.fn();
    Object.assign(controller, {
      destroyed: false,
      featurePreviewActive: true,
      featurePreviewResolver: resolveGate,
      featurePreviewContinuePending: false,
      launch: { hasSession: false },
      audio: {
        unlock: vi.fn(() => new Promise<boolean>(() => undefined)),
        playSplashContinue,
      },
      ui: {
        setFeaturePreviewVisible: vi.fn(),
        setFeaturePreviewPending: vi.fn(),
      },
      renderer: { setFeaturePreviewVisible: vi.fn() },
      syncGameMusic,
    });

    controller.continueFeaturePreview();

    expect(controller.featurePreviewResolver).toBe(resolveGate);
    expect(controller.featurePreviewContinuePending).toBe(false);
    expect(controller.audio.unlock).not.toHaveBeenCalled();
    expect(playSplashContinue).not.toHaveBeenCalled();
    expect(syncGameMusic).not.toHaveBeenCalled();
    expect(resolveGate).not.toHaveBeenCalled();
  });

  it("hides Splash and starts click/music synchronously on the frozen playback epoch", () => {
    const controller = prototypeHarness();
    const order: string[] = [];
    const resolveGate = vi.fn(() => order.push("resolve"));
    Object.assign(controller, {
      destroyed: false,
      featurePreviewActive: true,
      featurePreviewResolver: resolveGate,
      featurePreviewContinuePending: false,
      launch: { hasSession: true },
      audio: {
        getLaunchPlaybackClock: vi.fn(() => ({ now: () => 0 })),
        unlock: vi.fn(() => {
          order.push("unlock-request");
          return new Promise<boolean>(() => undefined);
        }),
        playSplashContinue: vi.fn(() => order.push("click")),
      },
      launchClock: {
        follow: vi.fn(() => order.push("clock-audio")),
        followWall: vi.fn(() => order.push("clock-wall")),
      },
      ui: {
        setFeaturePreviewPending: vi.fn(),
        setFeaturePreviewVisible: vi.fn((visible: boolean) => {
          if (!visible) order.push("dom-hide");
        }),
      },
      renderer: {
        setFeaturePreviewVisible: vi.fn((visible: boolean) => {
          if (!visible) order.push("canvas-hide");
        }),
      },
      syncGameMusic: vi.fn(() => order.push("music")),
    });

    controller.continueFeaturePreview();

    expect(resolveGate).toHaveBeenCalledTimes(1);
    expect(controller.featurePreviewResolver).toBeNull();
    expect(controller.featurePreviewContinuePending).toBe(false);
    expect(order).toEqual([
      "clock-audio",
      "unlock-request",
      "click",
      "music",
      "dom-hide",
      "canvas-hide",
      "resolve",
    ]);
    expect(controller.launchClock.followWall).not.toHaveBeenCalled();
  });

  it("falls launch visuals back to wall time when a legal unlock is rejected", async () => {
    const controller = prototypeHarness();
    let rejectUnlock!: (reason?: unknown) => void;
    const unlock = new Promise<boolean>((_resolve, reject) => { rejectUnlock = reject; });
    const follow = vi.fn();
    const followWall = vi.fn();
    Object.assign(controller, {
      destroyed: false,
      featurePreviewActive: true,
      featurePreviewResolver: vi.fn(),
      featurePreviewContinuePending: false,
      launch: { hasSession: true },
      launchClock: { follow, followWall },
      audio: {
        getLaunchPlaybackClock: vi.fn(() => ({ now: () => 0 })),
        unlock: vi.fn(() => unlock),
        playSplashContinue: vi.fn(),
      },
      ui: {
        setFeaturePreviewPending: vi.fn(),
        setFeaturePreviewVisible: vi.fn(),
      },
      renderer: { setFeaturePreviewVisible: vi.fn() },
      syncGameMusic: vi.fn(),
    });

    controller.continueFeaturePreview();
    expect(follow).toHaveBeenCalledOnce();
    expect(followWall).not.toHaveBeenCalled();
    rejectUnlock(new Error("NotAllowedError"));
    await flushMicrotasks();
    expect(followWall).toHaveBeenCalledOnce();
  });

  it("does not enter intro until the strict audio preload race has resolved", async () => {
    vi.stubGlobal("window", { location: { search: "" } });
    try {
      const controller = prototypeHarness();
      const launch = new LaunchStateMachine();
      launch.transition({ type: "START_PRELOAD" });
      let releaseAudioPreload!: () => void;
      const strictAudioPreload = new Promise<void>((resolve) => {
        releaseAudioPreload = resolve;
      });
      const introPlay = vi.fn(async () => undefined);
      Object.assign(controller, {
        destroyed: false,
        launch,
        root: { dataset: {} },
        preload: { run: vi.fn(() => strictAudioPreload) },
        startupFrameRequest: async () => undefined,
        ui: {
          isFeaturePreviewDismissed: vi.fn(() => true),
          setStartupProgress: vi.fn(),
          setLaunchStatus: vi.fn(),
          setLaunchPhase: vi.fn(),
          setHudReveal: vi.fn(),
          setFeaturePreviewEnabled: vi.fn(),
          setSpinMode: vi.fn(),
          applySnapshot: vi.fn(),
          setControls: vi.fn(),
          showError: vi.fn(),
        },
        renderer: {
          setJackpotHudReveal: vi.fn(),
          completeActiveCharacterIntroForReducedMotion: vi.fn(),
        },
        intro: { play: introPlay },
        skipFeaturePreview: true,
        initialSessionResolver: null,
        launchClock: { resetToWall: vi.fn() },
        syncGameMusic: vi.fn(),
        syncLaunchUi: vi.fn(),
        refreshUi: vi.fn(),
        releaseBufferedRecoveredSpinResult: vi.fn(),
      });
      launch.transition({ type: "SESSION_READY" });

      const run = controller.runLaunch();
      await flushMicrotasks();
      expect(launch.phase).toBe("preloading");
      expect(introPlay).not.toHaveBeenCalled();

      releaseAudioPreload();
      await run;
      expect(introPlay).toHaveBeenCalledOnce();
      expect(launch.phase).toBe("ready");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not advance launch, recovered presentation, or shadow prefetch after timeout during Intro", async () => {
    vi.stubGlobal("window", { location: { search: "" } });
    try {
      const controller = prototypeHarness();
      const launch = new LaunchStateMachine();
      launch.transition({ type: "START_PRELOAD" });
      launch.transition({ type: "SESSION_READY" });
      let resolveIntro!: () => void;
      const introBarrier = new Promise<void>((resolve) => { resolveIntro = resolve; });
      const introPlay = vi.fn(() => introBarrier);
      const syncLaunchUi = vi.fn();
      const releaseBufferedRecoveredSpinResult = vi.fn();
      const scheduleFeatureShadowPrefetch = vi.fn();
      Object.assign(controller, {
        destroyed: false,
        sessionTimedOut: false,
        launch,
        root: { dataset: {} },
        preload: { run: vi.fn(async () => undefined) },
        startupFrameRequest: async () => undefined,
        ui: {
          isFeaturePreviewDismissed: vi.fn(() => true),
          setStartupProgress: vi.fn(),
          setLaunchStatus: vi.fn(),
          setLaunchPhase: vi.fn(),
          setHudReveal: vi.fn(),
          setFeaturePreviewEnabled: vi.fn(),
          setSpinMode: vi.fn(),
          applySnapshot: vi.fn(),
          setControls: vi.fn(),
          showError: vi.fn(),
        },
        renderer: {
          setJackpotHudReveal: vi.fn(),
          completeActiveCharacterIntroForReducedMotion: vi.fn(),
        },
        intro: { play: introPlay },
        streamingAssets: {
          scheduleFeatureShadowPrefetch,
          diagnostics: vi.fn(),
          destroy: vi.fn(),
        },
        skipFeaturePreview: true,
        initialSessionResolver: null,
        launchClock: { resetToWall: vi.fn() },
        syncGameMusic: vi.fn(),
        syncLaunchUi,
        refreshUi: vi.fn(),
        releaseBufferedRecoveredSpinResult,
      });

      const run = controller.runLaunch();
      await vi.waitFor(() => expect(introPlay).toHaveBeenCalledOnce());
      Object.assign(controller as unknown as Record<string, unknown>, { sessionTimedOut: true });
      resolveIntro();
      await run;

      expect(launch.phase).not.toBe("ready");
      expect(syncLaunchUi).toHaveBeenCalledTimes(1);
      expect(releaseBufferedRecoveredSpinResult).not.toHaveBeenCalled();
      expect(scheduleFeatureShadowPrefetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("marks a dismissed-preview intro as wall-clock audio so late unlock cannot replay it", async () => {
    vi.stubGlobal("window", { location: { search: "" } });
    try {
      const controller = prototypeHarness();
      const launch = new LaunchStateMachine();
      launch.transition({ type: "START_PRELOAD" });
      launch.transition({ type: "SESSION_READY" });
      const playGameIntro = vi.fn();
      Object.assign(controller, {
        destroyed: false,
        launch,
        root: { dataset: {} },
        preload: { run: vi.fn(async () => undefined) },
        startupFrameRequest: async () => undefined,
        ui: {
          isFeaturePreviewDismissed: vi.fn(() => true),
          setStartupProgress: vi.fn(),
          setLaunchStatus: vi.fn(),
          setLaunchPhase: vi.fn(),
          setHudReveal: vi.fn(),
          setFeaturePreviewEnabled: vi.fn(),
          setSpinMode: vi.fn(),
          applySnapshot: vi.fn(),
          setControls: vi.fn(),
          showError: vi.fn(),
        },
        renderer: {
          setJackpotHudReveal: vi.fn(),
          completeActiveCharacterIntroForReducedMotion: vi.fn(),
        },
        audio: { playGameIntro },
        intro: {
          play: vi.fn(async () => {
            controller.presentIntroAudio({ name: "audio.game-intro", atMs: 0 });
          }),
        },
        streamingAssets: {
          scheduleFeatureShadowPrefetch: vi.fn(() => true),
          diagnostics: vi.fn(),
          destroy: vi.fn(),
        },
        skipFeaturePreview: true,
        initialSessionResolver: null,
        launchClock: { resetToWall: vi.fn() },
        reducedMotion: false,
        reducedMotionMedia: null,
        syncGameMusic: vi.fn(),
        syncLaunchUi: vi.fn(),
        refreshUi: vi.fn(),
        releaseBufferedRecoveredSpinResult: vi.fn(),
      });

      await controller.runLaunch();

      expect(playGameIntro).toHaveBeenCalledWith(
        { intensity: 1, reducedMotion: false },
        "wall-clock",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("schedules the Pass107 shadow only after strict preload and intro complete", async () => {
    vi.stubGlobal("window", { location: { search: "" } });
    try {
      const controller = prototypeHarness();
      const launch = new LaunchStateMachine();
      launch.transition({ type: "START_PRELOAD" });
      launch.transition({ type: "SESSION_READY" });
      const order: string[] = [];
      const scheduleFeatureShadowPrefetch = vi.fn(() => {
        order.push("shadow");
        return true;
      });
      Object.assign(controller, {
        destroyed: false,
        launch,
        root: { dataset: {} },
        preload: { run: vi.fn(async () => { order.push("preload"); }) },
        startupFrameRequest: async () => undefined,
        ui: {
          isFeaturePreviewDismissed: vi.fn(() => true),
          setStartupProgress: vi.fn(),
          setLaunchStatus: vi.fn(),
          setLaunchPhase: vi.fn(),
          setHudReveal: vi.fn(),
          setFeaturePreviewEnabled: vi.fn(),
          setSpinMode: vi.fn(),
          applySnapshot: vi.fn(),
          setControls: vi.fn(),
          showError: vi.fn(),
        },
        renderer: {
          setJackpotHudReveal: vi.fn(),
          completeActiveCharacterIntroForReducedMotion: vi.fn(),
        },
        intro: { play: vi.fn(async () => { order.push("intro"); }) },
        streamingAssets: {
          scheduleFeatureShadowPrefetch,
          diagnostics: vi.fn(),
          destroy: vi.fn(),
        },
        skipFeaturePreview: true,
        initialSessionResolver: null,
        launchClock: { resetToWall: vi.fn() },
        syncGameMusic: vi.fn(),
        syncLaunchUi: vi.fn(),
        refreshUi: vi.fn(),
        releaseBufferedRecoveredSpinResult: vi.fn(() => order.push("recovered")),
      });

      await controller.runLaunch();

      expect(launch.phase).toBe("ready");
      expect(order).toEqual(["preload", "intro", "recovered", "shadow"]);
      expect(scheduleFeatureShadowPrefetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps launch ready when an injected Pass107 shadow scheduler throws", async () => {
    vi.stubGlobal("window", { location: { search: "" } });
    try {
      const controller = prototypeHarness();
      const launch = new LaunchStateMachine();
      launch.transition({ type: "START_PRELOAD" });
      launch.transition({ type: "SESSION_READY" });
      const showError = vi.fn();
      Object.assign(controller, {
        destroyed: false,
        launch,
        root: { dataset: {} },
        preload: { run: vi.fn(async () => undefined) },
        startupFrameRequest: async () => undefined,
        ui: {
          isFeaturePreviewDismissed: vi.fn(() => true),
          setStartupProgress: vi.fn(),
          setLaunchStatus: vi.fn(),
          setLaunchPhase: vi.fn(),
          setHudReveal: vi.fn(),
          setFeaturePreviewEnabled: vi.fn(),
          setSpinMode: vi.fn(),
          applySnapshot: vi.fn(),
          setControls: vi.fn(),
          showError,
        },
        renderer: {
          setJackpotHudReveal: vi.fn(),
          completeActiveCharacterIntroForReducedMotion: vi.fn(),
        },
        intro: { play: vi.fn(async () => undefined) },
        streamingAssets: {
          scheduleFeatureShadowPrefetch: vi.fn(() => { throw new Error("shadow offline"); }),
          diagnostics: vi.fn(),
          destroy: vi.fn(),
        },
        skipFeaturePreview: true,
        initialSessionResolver: null,
        launchClock: { resetToWall: vi.fn() },
        syncGameMusic: vi.fn(),
        syncLaunchUi: vi.fn(),
        refreshUi: vi.fn(),
        releaseBufferedRecoveredSpinResult: vi.fn(),
      });

      await controller.runLaunch();

      expect(launch.phase).toBe("ready");
      expect(showError).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes Bonus, Free Spins, and Vault Jackpot stops before their visual input seams", async () => {
    const controller = prototypeHarness();
    const order: string[] = [];
    const reachAutoplayStopBoundary = vi.fn((_sequence: number, boundary: string) => {
      order.push(`stop:${boundary}`);
    });
    Object.assign(controller, {
      activePresentationSequence: 83,
      pendingWheelAward: null,
      wheelLandingInputBlocked: false,
      wheelQuickStopAccepted: false,
      presentFeatureAudio: vi.fn((event: FeatureEvent) => order.push(`audio:${event.type}`)),
      presentEffect: async (effect: () => Promise<void>) => effect(),
      ui: {
        reachAutoplayStopBoundary,
        announceEvent: vi.fn(async () => order.push("announce")),
      },
      renderer: {
        cueFeatureEnvironment: vi.fn((event: FeatureEvent) => order.push(`environment:${event.type}`)),
        featureEffects: {
          presentAfterReels: vi.fn(async (event: FeatureEvent) => order.push(`visual:${event.type}`)),
        },
        showFreeSpinHud: vi.fn(async () => order.push("free-spins:input-gate")),
        completeWheelPresentation: vi.fn(),
        abortWheelPresentation: vi.fn(),
      },
    });
    const audioState: FeatureAudioState = {
      rageLevel: 1,
      showFreeSpinSummary: false,
      wasFreeSpins: false,
      vaultCells: [],
    };

    await controller.presentPostReelFeatureEventBody(
      { type: "wheel.started" },
      BASE_FEATURE,
      false,
      audioState,
    );
    expect(order[0]).toBe("stop:bonus");
    expect(order.indexOf("stop:bonus")).toBeLessThan(order.indexOf("audio:wheel.started"));

    order.length = 0;
    await controller.presentPostReelFeatureEventBody(
      { type: "free_spins.started", mode: "EXPANSION", awarded: 8 },
      { ...BASE_FEATURE, mode: "EXPANSION", freeSpinsRemaining: 8 },
      false,
      audioState,
    );
    expect(order[0]).toBe("stop:free-spins");
    expect(order.indexOf("stop:free-spins")).toBeLessThan(order.indexOf("visual:free_spins.started"));
    expect(order.indexOf("stop:free-spins")).toBeLessThan(order.indexOf("free-spins:input-gate"));

    order.length = 0;
    await controller.presentPostReelFeatureEventBody(
      {
        type: "vault.awarded",
        reel: 1,
        row: 1,
        prize: "MINI_2X",
        multiplier: 20,
        amountMinor: "2000",
      },
      BASE_FEATURE,
      false,
      audioState,
    );
    expect(order[0]).toBe("stop:jackpot");
    expect(order.indexOf("stop:jackpot")).toBeLessThan(order.indexOf("visual:vault.awarded"));
  });

  it("destroy resolves both launch waiters and suppresses stale observer callbacks", () => {
    const controller = prototypeHarness();
    const resolvePreview = vi.fn();
    const resolveSession = vi.fn();
    const onFeatureEvent = vi.fn();
    Object.assign(controller, {
      destroyed: false,
      featurePreviewActive: true,
      featurePreviewResolver: resolvePreview,
      initialSessionResolver: resolveSession,
      featurePreviewContinuePending: false,
      activeObservedFeatureEvents: ["vault.awarded"],
      presentationObserver: { onFeatureEvent, onPresentationMilestone: vi.fn() },
      roundOriginFeatureState: BASE_FEATURE,
      reducedMotionMedia: null,
      audio: { stopGameIntro: vi.fn(), destroy: vi.fn() },
      ui: { destroy: vi.fn() },
      renderer: {
        setFeaturePreviewVisible: vi.fn(),
        cancelSpinPresentation: vi.fn(),
        setFeaturePresentationMilestoneListener: vi.fn(),
        setFeaturePresentationBranchListener: vi.fn(),
        setFeaturePresentationInputCheckpointListener: vi.fn(),
        setRageCascadePresentationMilestoneListener: vi.fn(),
        setRageCascadePresentationPaused: vi.fn(),
        setBigWinMilestoneListener: vi.fn(),
        destroy: vi.fn(),
      },
      stops: { cancel: vi.fn() },
      reelRound: { reset: vi.fn() },
      intro: { destroy: vi.fn() },
      gateway: { close: vi.fn() },
      layout: { stop: vi.fn() },
      cancelScheduledFreeSpin: vi.fn(),
      stopRoundAudio: vi.fn(),
    });

    controller.destroy();
    controller.destroy();

    expect(resolvePreview).toHaveBeenCalledTimes(1);
    expect(resolveSession).toHaveBeenCalledTimes(1);
    expect(onFeatureEvent).toHaveBeenCalledTimes(1);
    expect(onFeatureEvent).toHaveBeenCalledWith(null);
    expect(controller.activeObservedFeatureEvents).toEqual([]);
  });

  it("continues every independent owner cleanup after an early destroy failure", () => {
    const controller = prototypeHarness();
    const preloadAbort = vi.fn(() => { throw new Error("preload abort failed"); });
    const streamingDestroy = vi.fn();
    const initialSessionResolver = vi.fn();
    const gatewayClose = vi.fn();
    const layoutStop = vi.fn();
    const audioDestroy = vi.fn();
    const uiDestroy = vi.fn();
    const rendererDestroy = vi.fn();
    const removeMotionListener = vi.fn();
    const renderer = {
      cancelSpinPresentation: vi.fn(),
      setFeaturePresentationMilestoneListener: vi.fn(),
      setFeaturePresentationBranchListener: vi.fn(),
      setFeaturePresentationInputCheckpointListener: vi.fn(),
      setRageCascadePresentationMilestoneListener: vi.fn(),
      setRageCascadePresentationPaused: vi.fn(),
      setVaultUnlockPresentationMilestoneListener: vi.fn(),
      setBigWinMilestoneListener: vi.fn(),
      setFeaturePreviewVisible: vi.fn(),
      destroy: rendererDestroy,
    };
    Object.assign(controller, {
      root: { dataset: {} },
      destroyed: false,
      stopPostWinIdleRepeat: vi.fn(),
      clearInitialRgsSessionTimeout: vi.fn(),
      preload: { abort: preloadAbort },
      streamingAssets: { destroy: streamingDestroy },
      activeObservedFeatureEvents: [],
      observePresentationMilestone: vi.fn(),
      activePresentationSequence: null,
      activeRageCollectionPresentationSequence: null,
      activeRageCascadePresentationSequence: null,
      featurePreviewResolver: vi.fn(() => { throw new Error("preview resolver failed"); }),
      initialSessionResolver,
      featurePreviewContinuePending: true,
      roundOriginFeatureState: BASE_FEATURE,
      bufferedRecoveredSpinResult: {},
      cancelScheduledFreeSpin: vi.fn(),
      stopRoundAudio: vi.fn(),
      audio: { stopGameIntro: vi.fn(), destroy: audioDestroy },
      stops: { cancel: vi.fn() },
      reelRound: { reset: vi.fn() },
      renderer,
      intro: { destroy: vi.fn() },
      gateway: { close: gatewayClose },
      layout: { stop: layoutStop },
      reducedMotionMedia: { removeEventListener: removeMotionListener },
      ui: {
        completeAutoplayStopRound: vi.fn(),
        clearWheelBonusRoundSummary: vi.fn(),
        destroy: uiDestroy,
      },
    });

    expect(() => controller.destroy()).not.toThrow();
    controller.destroy();

    for (const cleanup of [
      preloadAbort,
      streamingDestroy,
      initialSessionResolver,
      gatewayClose,
      layoutStop,
      removeMotionListener,
      audioDestroy,
      uiDestroy,
      rendererDestroy,
    ]) expect(cleanup).toHaveBeenCalledOnce();
    expect(controller.featurePreviewResolver).toBeNull();
    expect(controller.initialSessionResolver).toBeNull();
    expect(controller.destroyed).toBe(true);
  });
});

interface RoundHarness extends ControllerPrototypeHarness {
  presentation: Promise<void>;
  log: string[];
  renderer: Record<string, unknown>;
  snapshot: GameSnapshot;
}

function roundResult(overrides: Partial<SpinResult> = {}): SpinResult {
  return {
    type: "spin.result",
    protocolVersion: 1,
    requestId: "request-1",
    sessionId: "session-1",
    roundId: "round-1",
    sequence: 1,
    betMinor: "100",
    chargedBetMinor: "100",
    balanceMinor: "10000",
    totalWinMinor: "100",
    grid: BASE_GRID,
    wins: [{
      id: "win-1",
      symbol: "TANK",
      nominalAmountMinor: "100",
      amountMinor: "100",
      cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
    }],
    events: [],
    featureState: BASE_FEATURE,
    ...overrides,
  };
}

function createRoundHarness(previousFeatureState: FeatureState = BASE_FEATURE): RoundHarness {
  const controller = prototypeHarness() as RoundHarness;
  const log: string[] = [];
  let presentation = Promise.resolve();
  const audio = {
    playPayoutWin: vi.fn(() => log.push("payout-audio")),
    playSymbolWin: vi.fn(() => log.push("symbol-audio")),
    playWinLossOrEqual: vi.fn(() => log.push("loss-or-equal-audio")),
    playMonsterRoar: vi.fn(),
    playMonsterRoarHit: vi.fn(),
    beginNormalWinCounter: vi.fn(),
    endNormalWinCounter: vi.fn(),
    quickStopReelLoop: vi.fn(),
    setFreeSpinsMusicEnabled: vi.fn(),
    playVaultAnticipation: vi.fn(),
    playImpact: vi.fn(),
    playVaultUnlock: vi.fn(),
    playVaultFly: vi.fn(),
  };
  const reels = {
    activeRows: 3,
    prepareFeaturePresentation: vi.fn(),
    highlight: vi.fn(),
    clearHighlights: vi.fn(),
    setGrid: vi.fn(),
  };
  const renderer = {
    reels,
    featureEffects: {
      presentBeforeReels: vi.fn(async () => undefined),
      presentVaultTease: vi.fn(async () => undefined),
      presentAfterReels: vi.fn(async () => undefined),
    },
    winCelebration: {
      present: vi.fn(async (
        wins: readonly Win[],
        _reducedMotion: boolean,
        _holdDurationMs?: number,
        onMilestone?: (
          milestone: "visible",
          record: Readonly<Record<string, unknown>>,
        ) => unknown,
      ) => {
        log.push("line-win");
        const win = wins[0];
        if (win) {
          await onMilestone?.("visible", {
            id: win.id,
            symbol: win.symbol,
            amountMinor: win.amountMinor,
            multiplier: win.multiplier ?? 1,
            baseAmountMinor: win.amountMinor,
            cells: win.cells,
          });
        }
      }),
    },
    bigWin: {
      present: vi.fn(async () => {
        log.push("big-win");
      }),
    },
    reconcileReelRows: vi.fn(async () => undefined),
    finishSpinPresentation: vi.fn(),
    cancelSpinPresentation: vi.fn(),
    restoreFeatureState: vi.fn(),
    cueFeatureEnvironment: vi.fn(),
    updateFreeSpinHud: vi.fn(),
    playFreeSpinHudWin: vi.fn(),
    reactToWin: vi.fn(async () => {
      log.push("round-win");
    }),
    beginFeatureExitAtSummaryHide: vi.fn(),
    exitFeatureMode: vi.fn(async () => log.push("feature-exit")),
  };
  const machine = {
    phase: "requesting",
    transition: vi.fn((event: { type: string }) => {
      if (event.type === "SPIN_RESULT") machine.phase = "presenting";
      if (event.type === "PRESENTATION_COMPLETE") machine.phase = "ready";
    }),
  };
  Object.assign(controller, {
    machine,
    renderer,
    stops: { present: vi.fn(async () => undefined) },
    reelRound: { transition: vi.fn(), reset: vi.fn() },
    ui: {
      setSpinMode: vi.fn(),
      resetWinCounter: vi.fn(),
      finalizeAcceptedPaidAutoplaySpin: vi.fn(),
      rollbackAcceptedPaidAutoplaySpin: vi.fn(),
      armAutoplayStopRound: vi.fn((result: SpinResult) => result.sequence),
      reachAutoplayStopBoundary: vi.fn(),
      completeAutoplayStopRound: vi.fn(),
      beginResultPresentation: vi.fn(),
      showBigWinCongratulations: vi.fn(),
      presentWinCounter: vi.fn(async () => undefined),
      applyResult: vi.fn(),
      showFreeSpinConclusion: vi.fn(),
      showError: vi.fn(),
    },
    audio,
    presentations: {
      enqueue: (task: () => Promise<void>) => {
        presentation = Promise.resolve().then(task);
        controller.presentation = presentation;
        return presentation;
      },
    },
    snapshot: {
      balanceMinor: "10000",
      selectedBetMinor: "100",
      betOptionsMinor: ["100"],
      featureState: { ...previousFeatureState },
      lastWinMinor: "0",
      currentGrid: BASE_GRID,
    },
    lastRoundId: null,
    reducedMotion: false,
    reducedMotionMedia: null,
    bigWinInFreeSpins: false,
    bigWinMusicResume: "ambient",
    fastPlay: false,
    roundOriginFeatureState: null,
    activeRoundFeatureAudioState: null,
    refreshUi: vi.fn(),
    finishRoundAudio: vi.fn(),
    stopRoundAudio: vi.fn(),
    presentationDelay: vi.fn(async () => undefined),
    presentEffect: async (effect: () => Promise<void>) => effect(),
    presentPostReelFeatureEvents: vi.fn(async (events: readonly FeatureEvent[]) => {
      if (events.length > 0) log.push(`features:${events.map(({ type }) => type).join(",")}`);
    }),
  });
  controller.presentation = presentation;
  controller.log = log;
  controller.renderer = renderer;
  return controller;
}

describe("AppController round ordering", () => {
  it("does not apply, ACK, report, or revive a round cancelled by SESSION_TIMEOUT", async () => {
    const controller = createRoundHarness();
    let releasePresentation!: () => void;
    const presentationBarrier = new Promise<void>((resolve) => {
      releasePresentation = resolve;
    });
    const renderer = controller.renderer as {
      reconcileReelRows: ReturnType<typeof vi.fn>;
      restoreFeatureState: ReturnType<typeof vi.fn>;
    };
    renderer.reconcileReelRows.mockImplementation(() => presentationBarrier);
    delete (controller as unknown as Record<string, unknown>).presentEffect;
    const machine = (controller as unknown as {
      machine: { phase: string; transition: ReturnType<typeof vi.fn> };
    }).machine;
    const ui = (controller as unknown as {
      ui: {
        applyResult: ReturnType<typeof vi.fn>;
        showError: ReturnType<typeof vi.fn>;
        completeAutoplayStopRound: ReturnType<typeof vi.fn>;
      };
    }).ui;
    const reelRound = (controller as unknown as {
      reelRound: { reset: ReturnType<typeof vi.fn> };
    }).reelRound;
    const acknowledgeSpinResult = vi.fn(() => true);
    const refreshUi = vi.fn();
    Object.assign(controller, {
      destroyed: false,
      sessionTimedOut: false,
      gateway: { hasPendingSpin: true, acknowledgeSpinResult },
      refreshUi,
      lastPlayerFacingError: null,
      root: { dataset: {} },
    });

    controller.handleSpinResult(roundResult());
    await vi.waitFor(() => expect(renderer.reconcileReelRows).toHaveBeenCalledOnce());
    machine.transition.mockClear();
    ui.applyResult.mockClear();
    ui.showError.mockClear();
    ui.completeAutoplayStopRound.mockClear();
    reelRound.reset.mockClear();
    refreshUi.mockClear();
    Object.assign(controller as unknown as Record<string, unknown>, {
      sessionTimedOut: true,
    });
    machine.phase = "failed";
    releasePresentation();
    await expect(controller.presentation).rejects.toMatchObject({
      name: "RoundPresentationCancelledError",
    });
    await flushMicrotasks();

    expect(ui.applyResult).not.toHaveBeenCalled();
    expect(acknowledgeSpinResult).not.toHaveBeenCalled();
    expect(ui.showError).not.toHaveBeenCalled();
    expect(ui.completeAutoplayStopRound).not.toHaveBeenCalled();
    expect(renderer.restoreFeatureState).not.toHaveBeenCalled();
    expect(reelRound.reset).not.toHaveBeenCalled();
    expect(machine.transition).not.toHaveBeenCalled();
    expect(machine.phase).toBe("failed");
    expect(refreshUi).not.toHaveBeenCalled();
    expect((controller as unknown as { gateway: { hasPendingSpin: boolean } }).gateway.hasPendingSpin)
      .toBe(true);
  });

  it("publishes only the fixed synchronous delivery stage when acceptance throws", () => {
    const controller = createRoundHarness();
    const root = { dataset: {} as Record<string, string> };
    const ui = (controller as unknown as {
      ui: { armAutoplayStopRound: ReturnType<typeof vi.fn> };
    }).ui;
    ui.armAutoplayStopRound.mockImplementation(() => {
      throw new Error("不得进入 DOM 的内部诊断文本");
    });
    Object.assign(controller, { root });

    expect(() => controller.handleSpinResult(roundResult())).toThrow();
    expect(root.dataset).toEqual({ rgsDeliveryStage: "autoplay-arm" });
    expect(JSON.stringify(root.dataset)).not.toContain("内部诊断文本");
  });

  it("finalizes a paid Auto Play reservation exactly once before arming stop boundaries", async () => {
    const controller = createRoundHarness();
    const ui = (controller as unknown as {
      ui: {
        finalizeAcceptedPaidAutoplaySpin: ReturnType<typeof vi.fn>;
        rollbackAcceptedPaidAutoplaySpin: ReturnType<typeof vi.fn>;
        armAutoplayStopRound: ReturnType<typeof vi.fn>;
      };
    }).ui;

    controller.handleSpinResult(roundResult());
    await controller.presentation;

    expect(ui.finalizeAcceptedPaidAutoplaySpin).toHaveBeenCalledOnce();
    expect(ui.rollbackAcceptedPaidAutoplaySpin).not.toHaveBeenCalled();
    expect(ui.finalizeAcceptedPaidAutoplaySpin.mock.invocationCallOrder[0])
      .toBeLessThan(ui.armAutoplayStopRound.mock.invocationCallOrder[0] ?? 0);
  });

  it("arms only a validated result, reaches Any Win at Win Start, and retires the token once", async () => {
    const controller = createRoundHarness();
    const ui = (controller as unknown as {
      ui: {
        armAutoplayStopRound: ReturnType<typeof vi.fn>;
        reachAutoplayStopBoundary: ReturnType<typeof vi.fn>;
        completeAutoplayStopRound: ReturnType<typeof vi.fn>;
        beginResultPresentation: ReturnType<typeof vi.fn>;
      };
    }).ui;
    const result = roundResult({ sequence: 83, roundId: "round-pass83" });

    controller.handleSpinResult(result);
    await controller.presentation;

    expect(ui.armAutoplayStopRound).toHaveBeenCalledOnce();
    expect(ui.armAutoplayStopRound).toHaveBeenCalledWith(result);
    expect(ui.reachAutoplayStopBoundary).toHaveBeenCalledWith(83, "any-win");
    expect(ui.completeAutoplayStopRound).toHaveBeenCalledOnce();
    expect(ui.completeAutoplayStopRound).toHaveBeenCalledWith(83);
    expect(ui.armAutoplayStopRound.mock.invocationCallOrder[0])
      .toBeLessThan(ui.reachAutoplayStopBoundary.mock.invocationCallOrder[0] ?? 0);
    expect(ui.reachAutoplayStopBoundary.mock.invocationCallOrder[0])
      .toBeLessThan(ui.beginResultPresentation.mock.invocationCallOrder[0] ?? 0);
    expect(ui.beginResultPresentation.mock.invocationCallOrder[0])
      .toBeLessThan(ui.completeAutoplayStopRound.mock.invocationCallOrder[0] ?? 0);
  });

  it("starts one silent infinite post-win repeat at 1000ms and cancels it only after an accepted Base request", async () => {
    vi.useFakeTimers();
    try {
      expect(PRIMAL_POST_WIN_IDLE_INTRO_MS).toBe(1_000);
      const controller = createRoundHarness();
      const [record] = roundResult().wins;
      expect(record).toBeDefined();
      let finishRepeat: (() => void) | null = null;
      const present = vi.fn((
        _wins: readonly Win[],
        _reducedMotion: boolean,
        _holdDurationMs: number,
        _onMilestone?: unknown,
        _restoreSymbolsAtHoldBoundary?: boolean,
      ) => new Promise<void>((resolve) => {
        finishRepeat = resolve;
      }));
      const requestFinish = vi.fn(() => {
        finishRepeat?.();
        return true;
      });
      const highlight = vi.fn();
      const beginSpinPresentation = vi.fn();
      const renderer = controller.renderer as {
        reels: { highlight: ReturnType<typeof vi.fn> };
        winCelebration: {
          present: typeof present;
          requestFinish: typeof requestFinish;
        };
        requestFreeSpinCapContinue: ReturnType<typeof vi.fn>;
        requestFreeSpinSummaryContinue: ReturnType<typeof vi.fn>;
        requestFreeSpinContinue: ReturnType<typeof vi.fn>;
        requestWheelSummaryContinue: ReturnType<typeof vi.fn>;
        requestWheelInteraction: ReturnType<typeof vi.fn>;
        beginSpinPresentation: ReturnType<typeof vi.fn>;
      };
      Object.assign(renderer.reels, { highlight });
      Object.assign(renderer, {
        winCelebration: { present, requestFinish },
        requestFreeSpinCapContinue: vi.fn(() => false),
        requestFreeSpinSummaryContinue: vi.fn(() => false),
        requestFreeSpinContinue: vi.fn(() => false),
        requestWheelSummaryContinue: vi.fn(() => false),
        requestWheelInteraction: vi.fn(() => null),
        beginSpinPresentation,
      });

      const requestSpin = vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      const commitAcceptedPaidAutoplaySpin = vi.fn();
      Object.assign(controller.audio, {
        unlock: vi.fn(async () => true),
        beginBaseMusicRound: vi.fn(),
        playReelStart: vi.fn(),
        startReelLoop: vi.fn(),
      });
      Object.assign((controller as unknown as { ui: Record<string, unknown> }).ui, {
        commitAcceptedPaidAutoplaySpin,
        resetWinCounter: vi.fn(),
        setSpinMode: vi.fn(),
      });
      Object.assign(controller, {
        destroyed: false,
        presentationObserver: null,
        machine: { canSpin: true, transition: vi.fn() },
        gateway: { hasPendingSpin: false, requestSpin },
        reelRound: { state: "Idle", transition: vi.fn() },
        stops: { markSpinStart: vi.fn() },
        cancelScheduledFreeSpin: vi.fn(),
        refreshUi: vi.fn(),
        reducedMotion: false,
        reducedMotionMedia: null,
        spinAudioGeneration: 0,
        postWinIdleRepeatTimer: null,
        postWinIdleRepeatGeneration: 0,
        postWinIdleRepeatActive: false,
      });
      const repeatState = controller as unknown as {
        postWinIdleRepeatTimer: ReturnType<typeof setTimeout> | null;
        postWinIdleRepeatGeneration: number;
        postWinIdleRepeatActive: boolean;
      };

      controller.schedulePostWinIdleRepeat(
        roundResult({ wins: [record!], events: [] }),
        BASE_FEATURE,
        false,
        false,
      );

      expect(repeatState.postWinIdleRepeatTimer).not.toBeNull();
      expect(repeatState.postWinIdleRepeatGeneration).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(present).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(present).toHaveBeenCalledOnce();
      expect(present.mock.calls[0]?.[0]).toEqual([record]);
      expect(present.mock.calls[0]?.[1]).toBe(false);
      expect(present.mock.calls[0]?.[2]).toBe(Number.POSITIVE_INFINITY);
      expect(present.mock.calls[0]?.[3]).toBeUndefined();
      expect(present.mock.calls[0]?.[4]).toBeUndefined();
      expect(repeatState.postWinIdleRepeatActive).toBe(true);
      expect(highlight).not.toHaveBeenCalled();
      expect(controller.audio.playSymbolWin).not.toHaveBeenCalled();
      expect(controller.audio.playPayoutWin).not.toHaveBeenCalled();
      expect(controller.audio.playWinLossOrEqual).not.toHaveBeenCalled();

      // 被拒绝的请求不会改变已稳定的重复演出和结果。
      controller.requestSpin();
      expect(requestFinish).not.toHaveBeenCalled();
      expect(repeatState.postWinIdleRepeatActive).toBe(true);
      expect(repeatState.postWinIdleRepeatGeneration).toBe(1);

      // 首个被接受的付费 ROUNDSTART 独占唯一一次取消操作。
      controller.requestSpin();
      expect(commitAcceptedPaidAutoplaySpin).toHaveBeenCalledOnce();
      expect(requestFinish).toHaveBeenCalledOnce();
      expect(repeatState.postWinIdleRepeatActive).toBe(false);
      expect(repeatState.postWinIdleRepeatGeneration).toBe(2);
      expect(beginSpinPresentation).toHaveBeenCalledOnce();
      expect(present).toHaveBeenCalledOnce();
      expect(highlight).not.toHaveBeenCalled();
      await flushMicrotasks();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not schedule an ordinary post-win repeat when Wheel Layer-B owns the returned record", async () => {
    vi.useFakeTimers();
    try {
      const controller = createRoundHarness();
      const present = vi.fn(async () => undefined);
      const requestFinish = vi.fn();
      Object.assign(controller.renderer, {
        winCelebration: { present, requestFinish },
      });
      Object.assign(controller, {
        destroyed: false,
        postWinIdleRepeatTimer: null,
        postWinIdleRepeatGeneration: 0,
        postWinIdleRepeatActive: false,
      });
      const [record] = roundResult().wins;
      expect(record).toBeDefined();

      controller.schedulePostWinIdleRepeat(roundResult({
        totalWinMinor: "1200",
        wins: [record!],
        events: [
          { type: "wheel.started" },
          {
            type: "wheel.awarded",
            outcome: "INSTANT",
            prize: "MINI",
            multiplier: 10,
            amountMinor: "1000",
          },
        ],
      }), BASE_FEATURE, false, false);

      await vi.advanceTimersByTimeAsync(PRIMAL_POST_WIN_IDLE_INTRO_MS);
      expect(present).not.toHaveBeenCalled();
      expect(requestFinish).not.toHaveBeenCalled();
      expect((controller as unknown as {
        postWinIdleRepeatTimer: ReturnType<typeof setTimeout> | null;
        postWinIdleRepeatGeneration: number;
        postWinIdleRepeatActive: boolean;
      })).toMatchObject({
        postWinIdleRepeatTimer: null,
        postWinIdleRepeatGeneration: 0,
        postWinIdleRepeatActive: false,
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("preserves unchanged Base level-two PPS state through a no-Rage no-win round", async () => {
    const controller = createRoundHarness(BASE_LEVEL_TWO_FEATURE);
    const setRageAuraLevel = vi.fn();
    Object.assign(controller.renderer, { setRageAuraLevel });

    controller.handleSpinResult(roundResult({
      totalWinMinor: "0",
      wins: [],
      events: [],
      featureState: { ...BASE_LEVEL_TWO_FEATURE },
    }));
    await controller.presentation;

    expect(setRageAuraLevel).not.toHaveBeenCalled();
    expect(controller.snapshot.featureState).toEqual(BASE_LEVEL_TWO_FEATURE);
  });

  it("finishes Kong reel audio before holding the physically settled 3x8 checkpoint", async () => {
    const previous: FeatureState = {
      mode: "EXPANSION",
      freeSpinsRemaining: 2,
      freeSpinsPlayed: 3,
      baseBetMinor: "100",
      freeSpinsWinMinor: "0",
      rageLevel: 2,
      rageCollected: 0,
    };
    const current: FeatureState = {
      ...previous,
      freeSpinsRemaining: 1,
      freeSpinsPlayed: 4,
    };
    const controller = createRoundHarness(previous);
    const order: string[] = [];
    let release: () => void = () => undefined;
    const checkpointGate = new Promise<void>((resolve) => { release = resolve; });
    const finishRoundAudio = vi.fn(() => order.push("audio-finished"));
    (controller.renderer as { finishSpinPresentation: ReturnType<typeof vi.fn> })
      .finishSpinPresentation.mockImplementation(() => order.push("reels-settled"));
    Object.assign(controller, {
      finishRoundAudio,
      presentationObserver: {
        onPresentationCheckpoint: (checkpoint: AppPresentationCheckpoint) => {
          if (checkpoint.type === "semantic-state"
            && checkpoint.state === "kong.rows-8-settled") {
            order.push("checkpoint-held");
            return checkpointGate;
          }
          return undefined;
        },
      },
    });
    const expandedGrid = BASE_GRID.map((reel) => Array.from(
      { length: 8 },
      (_, row) => ({ ...reel[row % reel.length]! }),
    ));

    controller.handleSpinResult(roundResult({
      chargedBetMinor: "0",
      wins: [],
      totalWinMinor: "0",
      grid: expandedGrid,
      events: [{ type: "grid.expanded", rows: 8, ways: 512 }],
      featureState: current,
    }));
    for (let index = 0; index < 12 && order.length < 3; index += 1) {
      await flushMicrotasks();
    }

    expect(order).toEqual(["reels-settled", "audio-finished", "checkpoint-held"]);
    expect(finishRoundAudio).toHaveBeenCalledTimes(1);
    release();
    await controller.presentation;
    expect(finishRoundAudio).toHaveBeenCalledTimes(1);
  });

  it("fails closed before presentation when a result violates its captured feature origin", () => {
    const previous: FeatureState = {
      mode: "EXPANSION",
      freeSpinsRemaining: 2,
      freeSpinsPlayed: 3,
      baseBetMinor: "100",
      freeSpinsWinMinor: "1000",
      rageLevel: 5,
      rageCollected: 0,
    };
    const controller = createRoundHarness(previous);

    controller.handleSpinResult(roundResult({
      chargedBetMinor: "0",
      wins: [],
      totalWinMinor: "0",
      // 刻意省略捕获到的 Kong Quest 请求来源所要求的前置
      // grid.expanded 投影。
      events: [],
      featureState: {
        ...previous,
        freeSpinsRemaining: 1,
        freeSpinsPlayed: 4,
      },
    }));

    const ui = (controller as unknown as {
      ui: {
        showError: ReturnType<typeof vi.fn>;
        armAutoplayStopRound: ReturnType<typeof vi.fn>;
      };
    }).ui;
    expect(ui.showError).toHaveBeenCalledWith(SAFE_RESULT_ERROR);
    expect(ui.armAutoplayStopRound).not.toHaveBeenCalled();
    expect((controller as unknown as { machine: { transition: ReturnType<typeof vi.fn> } })
      .machine.transition).toHaveBeenCalledWith({ type: "SPIN_FAILED" });
    expect((controller.renderer as { reconcileReelRows: ReturnType<typeof vi.fn> })
      .reconcileReelRows).not.toHaveBeenCalled();
    expect(controller.snapshot.featureState).toEqual(previous);
  });

  it.each([false, true])(
    "opens normal-win START at exactly 300ms with reducedMotion=%s",
    async (reducedMotion) => {
      vi.useFakeTimers();
      try {
        const controller = createRoundHarness();
        Object.assign(controller, {
          reducedMotion,
          presentationDelay: (durationMs: number) => new Promise<void>((resolve) => {
            setTimeout(resolve, durationMs);
          }),
        });
        const reactToWin = (controller.renderer as {
          reactToWin: ReturnType<typeof vi.fn>;
        }).reactToWin;
        const ui = (controller as unknown as {
          ui: {
            setSpinMode: ReturnType<typeof vi.fn>;
            beginResultPresentation: ReturnType<typeof vi.fn>;
          };
        }).ui;

        controller.handleSpinResult(roundResult());
        await vi.advanceTimersByTimeAsync(15);
        expect(ui.beginResultPresentation).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(ui.beginResultPresentation).toHaveBeenCalledOnce();
        expect(ui.beginResultPresentation).toHaveBeenCalledWith(true);
        await vi.advanceTimersByTimeAsync(283);
        expect(reactToWin).not.toHaveBeenCalled();
        expect(ui.setSpinMode).not.toHaveBeenCalledWith("normal-win-skip");

        await vi.advanceTimersByTimeAsync(1);
        expect(reactToWin).toHaveBeenCalledTimes(1);
        expect(ui.setSpinMode).toHaveBeenCalledWith("normal-win-skip");

        await vi.runAllTimersAsync();
        await controller.presentation;
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("mounts normal-win artwork before symbol presentation and starts the counter last", async () => {
    const controller = createRoundHarness();
    controller.handleSpinResult(roundResult());
    await controller.presentation;

    const renderer = controller.renderer as {
      reels: { highlight: ReturnType<typeof vi.fn> };
      winCelebration: { present: ReturnType<typeof vi.fn> };
      reactToWin: ReturnType<typeof vi.fn>;
      cueFeatureEnvironment: ReturnType<typeof vi.fn>;
    };
    const ui = (controller as unknown as {
      ui: { presentWinCounter: ReturnType<typeof vi.fn> };
    }).ui;
    const firstCall = (mock: ReturnType<typeof vi.fn>): number => (
      mock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );

    expect(firstCall(renderer.reactToWin)).toBeLessThan(firstCall(renderer.winCelebration.present));
    expect(firstCall(renderer.winCelebration.present)).toBeLessThan(firstCall(renderer.reels.highlight));
    const playSymbolWin = controller.audio.playSymbolWin as ReturnType<typeof vi.fn>;
    expect(firstCall(renderer.reels.highlight)).toBeLessThan(firstCall(playSymbolWin));
    expect(firstCall(playSymbolWin)).toBeLessThan(firstCall(ui.presentWinCounter));
    expect(renderer.cueFeatureEnvironment).not.toHaveBeenCalled();
  });

  it("shares the exact single plain HOLD clock with the counter and owns boundary teardown", async () => {
    for (const [fastPlay, expectedDuration] of [[false, 500], [true, 250]] as const) {
      const controller = createRoundHarness();
      Object.assign(controller as unknown as Record<string, unknown>, { fastPlay });
      const present = (controller.renderer as {
        winCelebration: { present: ReturnType<typeof vi.fn> };
      }).winCelebration.present;
      const presentWinCounter = (controller as unknown as {
        ui: { presentWinCounter: ReturnType<typeof vi.fn> };
      }).ui.presentWinCounter;

      controller.handleSpinResult(roundResult());
      await controller.presentation;

      expect(present).toHaveBeenCalledOnce();
      expect(present.mock.calls[0]?.[2]).toBe(expectedDuration);
      expect(present.mock.calls[0]?.[4]).toBe(true);
      expect(presentWinCounter).toHaveBeenCalledWith("100", expectedDuration, "0");
    }
  });

  it("does not opt multi-record presentation into the single plain HOLD teardown", async () => {
    const controller = createRoundHarness();
    const present = (controller.renderer as {
      winCelebration: { present: ReturnType<typeof vi.fn> };
    }).winCelebration.present;
    const records = [
      {
        id: "first-plain",
        symbol: "TANK" as const,
        nominalAmountMinor: "50",
        amountMinor: "50",
        cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
      },
      {
        id: "second-plain",
        symbol: "CIRCUIT" as const,
        nominalAmountMinor: "50",
        amountMinor: "50",
        cells: [{ reel: 0, row: 1 }, { reel: 1, row: 1 }, { reel: 2, row: 1 }],
      },
    ];

    controller.handleSpinResult(roundResult({ wins: records }));
    await controller.presentation;

    expect(present).toHaveBeenCalledTimes(2);
    expect(present.mock.calls.map((call) => call[4])).toEqual([false, false]);
  });

  it("advances first-show plain and multiplied records at 1500ms and 4000ms", async () => {
    vi.useFakeTimers();
    try {
      for (const [multiplier, expectedHold] of [[1, 1_500], [5, 4_000]] as const) {
        const controller = createRoundHarness();
        Object.assign(controller, {
          presentationDelay: (durationMs: number) => new Promise<void>((resolve) => {
            setTimeout(resolve, durationMs);
          }),
        });
        const present = (controller.renderer as {
          winCelebration: { present: ReturnType<typeof vi.fn> };
        }).winCelebration.present;
        present.mockImplementation((
          _wins: unknown,
          _reducedMotion: boolean,
          holdDurationMs: number,
        ) => new Promise<void>((resolve) => {
          setTimeout(resolve, holdDurationMs);
        }));
        const records = [
          {
            id: `first-x${multiplier}`,
            symbol: "TANK" as const,
            multiplier,
            nominalAmountMinor: "125",
            amountMinor: "125",
            cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
          },
          {
            id: "second-plain",
            symbol: "CIRCUIT" as const,
            multiplier: 1,
            nominalAmountMinor: "125",
            amountMinor: "125",
            cells: [{ reel: 0, row: 1 }, { reel: 1, row: 1 }, { reel: 2, row: 1 }],
          },
        ];

        controller.handleSpinResult(roundResult({ totalWinMinor: "250", wins: records }));
        await vi.advanceTimersByTimeAsync(299);
        expect(present).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(present).toHaveBeenCalledTimes(1);
        expect(present.mock.calls[0]?.[2]).toBe(expectedHold);

        await vi.advanceTimersByTimeAsync(expectedHold - 1);
        expect(present).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(present).toHaveBeenCalledTimes(2);

        // 只完成第二条首次展示记录。后续的就绪态重复演出刻意不设时限，
        // 由下方专门的调度测试负责。
        await vi.advanceTimersByTimeAsync(expectedHold);
        await controller.presentation;
        vi.clearAllTimers();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("snapshots Fast Play for the full ordinary counter and record sequence", async () => {
    for (const [multiplier, expectedFirstHold] of [[1, 750], [5, 3_000]] as const) {
      const controller = createRoundHarness();
      Object.assign(controller as unknown as Record<string, unknown>, { fastPlay: true });
      const present = (controller.renderer as {
        winCelebration: { present: ReturnType<typeof vi.fn> };
      }).winCelebration.present;
      const records = [
        {
          id: `fast-first-x${multiplier}`,
          symbol: "TANK" as const,
          multiplier,
          nominalAmountMinor: "125",
          amountMinor: "125",
          cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
        },
        {
          id: "fast-second-plain",
          symbol: "CIRCUIT" as const,
          multiplier: 1,
          nominalAmountMinor: "125",
          amountMinor: "125",
          cells: [{ reel: 0, row: 1 }, { reel: 1, row: 1 }, { reel: 2, row: 1 }],
        },
      ];

      controller.handleSpinResult(roundResult({ totalWinMinor: "250", wins: records }));
      // 即使设置在排队的演出微任务开始前发生变化，被接受的结果仍独占
      // 一份时钟快照。
      Object.assign(controller as unknown as Record<string, unknown>, { fastPlay: false });
      await controller.presentation;

      const presentWinCounter = (controller as unknown as {
        ui: { presentWinCounter: ReturnType<typeof vi.fn> };
      }).ui.presentWinCounter;
      expect(presentWinCounter).toHaveBeenCalledWith("250", 625, "0");
      expect(present.mock.calls.map((call) => call[2])).toEqual([
        expectedFirstHold,
        750,
      ]);
    }
  });

  it.each([
    { acceptedFastPlay: false, expectedHoldMs: 4_000 },
    { acceptedFastPlay: true, expectedHoldMs: 3_000 },
  ])(
    "hands multiplied records off at H=$expectedHoldMs with one round-scoped Fast Play snapshot",
    async ({ acceptedFastPlay, expectedHoldMs }) => {
      vi.useFakeTimers();
      try {
        const controller = createRoundHarness();
        const traces: AppPresentationTrace[] = [];
        const presentStarts: number[] = [];
        Object.assign(controller as unknown as Record<string, unknown>, {
          fastPlay: acceptedFastPlay,
          presentationDelay: (durationMs: number) => new Promise<void>((resolve) => {
            setTimeout(resolve, durationMs);
          }),
          presentationObserver: {
            onPresentationTrace: (trace: AppPresentationTrace) => traces.push(trace),
          },
        });
        const present = (controller.renderer as {
          winCelebration: { present: ReturnType<typeof vi.fn> };
        }).winCelebration.present;
        const records = [
          {
            id: "handoff-first-x2",
            symbol: "TANK" as const,
            multiplier: 2,
            nominalAmountMinor: "100",
            amountMinor: "100",
            cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
          },
          {
            id: "handoff-second-x2",
            symbol: "CIRCUIT" as const,
            multiplier: 2,
            nominalAmountMinor: "100",
            amountMinor: "100",
            cells: [{ reel: 0, row: 1 }, { reel: 1, row: 1 }, { reel: 2, row: 1 }],
          },
        ];
        present.mockImplementation(async (
          wins: readonly SpinResult["wins"][number][],
          _reducedMotion: boolean,
          holdDurationMs: number,
          onMilestone?: (
            milestone: "visible" | "hold-complete" | "hide-start" | "hidden",
            record: Readonly<{
              id: string;
              symbol: SpinResult["wins"][number]["symbol"];
              amountMinor: string;
              multiplier: number;
              baseAmountMinor: string;
              cells: readonly CellAddress[];
            }>,
            resident?: Readonly<WinCelebrationResidentFacts>,
          ) => unknown,
          _restoreSymbolsAtHoldBoundary?: boolean,
          _handoffToNextRecord = false,
        ) => {
          const win = wins[0]!;
          const index = win.id === records[0]!.id ? 0 : 1;
          const generation = index + 1;
          const record = Object.freeze({
            id: win.id,
            symbol: win.symbol,
            amountMinor: win.amountMinor,
            multiplier: win.multiplier ?? 1,
            baseAmountMinor: "50",
            cells: win.cells,
          });
          const resident = (
            overrides: Partial<WinCelebrationResidentFacts> = {},
          ): Readonly<WinCelebrationResidentFacts> => Object.freeze({
            generation,
            labelInstanceId: 71,
            framePoolInstanceId: 83,
            framePoolSize: 24,
            activeBoxCount: win.cells.length,
            activeOwnerCount: 1,
            pendingCleanupCount: 0,
            viewReused: true,
            handoffDelayMs: 0,
            staleHiddenCount: 0,
            ...overrides,
          });

          presentStarts.push(Date.now());
          await onMilestone?.("visible", record, resident());
          if (index === 0) {
            // 设置仍可动态变化，但这个已接受的回合必须保留排队演出开始前
            // 采样得到的时钟配置。
            Object.assign(controller as unknown as Record<string, unknown>, {
              fastPlay: !acceptedFastPlay,
            });
          }
          await new Promise<void>((resolve) => setTimeout(resolve, holdDurationMs));
          await onMilestone?.("hold-complete", record, resident());
          await onMilestone?.("hide-start", record, resident({
            pendingCleanupCount: 1,
          }));
          // 已被取代的所有者绝不能发布迟到的隐藏里程碑。
          // 连续不中断的最终隐藏生命周期归渲染器所有，刻意不纳入此
          // AppController 交接测试。
        });

        controller.handleSpinResult(roundResult({
          totalWinMinor: "200",
          wins: records,
        }));
        // 300ms 的 Win START 前导，加上两段预设的记录停留。不要使用
        // runAllTimers：完成后会刻意启动无限的空闲重复演出。
        await vi.advanceTimersByTimeAsync(300 + expectedHoldMs * 2);
        await controller.presentation;

        expect(present).toHaveBeenCalledTimes(2);
        expect(present.mock.calls.map((call) => call[2])).toEqual([
          expectedHoldMs,
          expectedHoldMs,
        ]);
        expect(present.mock.calls.map((call) => call[5])).toEqual([true, false]);
        expect(presentStarts[1]! - presentStarts[0]!).toBe(expectedHoldMs);

        type WinRecordTrace = Extract<
          AppPresentationTrace,
          { type: `win-record.${string}` }
        >;
        const recordTraces = traces.filter((trace): trace is WinRecordTrace => (
          trace.type.startsWith("win-record.")
        ));
        expect(recordTraces.map(({ type, index, id }) => ({ type, index, id }))).toEqual([
          { type: "win-record.visible", index: 0, id: records[0]!.id },
          { type: "win-record.hold-complete", index: 0, id: records[0]!.id },
          { type: "win-record.hide-start", index: 0, id: records[0]!.id },
          { type: "win-record.visible", index: 1, id: records[1]!.id },
          { type: "win-record.hold-complete", index: 1, id: records[1]!.id },
          { type: "win-record.hide-start", index: 1, id: records[1]!.id },
        ]);
        expect(recordTraces.some((trace) => (
          trace.index === 0 && trace.type === "win-record.hidden"
        ))).toBe(false);

        const outgoingHide = recordTraces.find((trace) => (
          trace.index === 0 && trace.type === "win-record.hide-start"
        ));
        const incomingVisible = recordTraces.find((trace) => (
          trace.index === 1 && trace.type === "win-record.visible"
        ));
        expect(outgoingHide?.resident).toMatchObject({
          labelInstanceId: 71,
          framePoolInstanceId: 83,
          framePoolSize: 24,
          handoffDelayMs: 0,
        });
        expect(incomingVisible?.resident).toMatchObject({
          labelInstanceId: 71,
          framePoolInstanceId: 83,
          framePoolSize: 24,
          activeOwnerCount: 1,
          pendingCleanupCount: 0,
          viewReused: true,
          handoffDelayMs: 0,
        });
        expect(incomingVisible?.resident?.generation).toBeGreaterThan(
          outgoingHide?.resident?.generation ?? Number.POSITIVE_INFINITY,
        );
        expect(Object.isFrozen(outgoingHide?.resident)).toBe(true);
        expect(Object.isFrozen(incomingVisible?.resident)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("runs Big Win completely before 2000ms post-Big-Win plain record advances", async () => {
    vi.useFakeTimers();
    try {
      const controller = createRoundHarness();
      Object.assign(controller, {
        presentationDelay: (durationMs: number) => new Promise<void>((resolve) => {
          setTimeout(resolve, durationMs);
        }),
      });
      const renderer = controller.renderer as {
        bigWin: { present: ReturnType<typeof vi.fn> };
        winCelebration: { present: ReturnType<typeof vi.fn> };
      };
      const ui = (controller as unknown as {
        ui: {
          resetWinCounter: ReturnType<typeof vi.fn>;
          showBigWinCongratulations: ReturnType<typeof vi.fn>;
        };
      }).ui;
      renderer.winCelebration.present.mockImplementation((
        _wins: unknown,
        _reducedMotion: boolean,
        holdDurationMs: number,
      ) => new Promise<void>((resolve) => {
        setTimeout(resolve, holdDurationMs);
      }));
      const records = [
        {
          id: "big-first",
          symbol: "TANK" as const,
          multiplier: 1,
          nominalAmountMinor: "1000",
          amountMinor: "1000",
          cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
        },
        {
          id: "big-second",
          symbol: "CIRCUIT" as const,
          multiplier: 1,
          nominalAmountMinor: "1000",
          amountMinor: "1000",
          cells: [{ reel: 0, row: 1 }, { reel: 1, row: 1 }, { reel: 2, row: 1 }],
        },
      ];

      controller.handleSpinResult(roundResult({ totalWinMinor: "2000", wins: records }));
      await vi.advanceTimersByTimeAsync(16);
      await vi.advanceTimersByTimeAsync(299);
      expect(ui.showBigWinCongratulations).not.toHaveBeenCalled();
      expect(renderer.bigWin.present).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(ui.showBigWinCongratulations).toHaveBeenCalledTimes(1);
      expect(renderer.bigWin.present).toHaveBeenCalledTimes(1);
      expect(renderer.winCelebration.present).not.toHaveBeenCalled();
      expect(ui.resetWinCounter).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ui.resetWinCounter).toHaveBeenCalledOnce();
      expect(ui.resetWinCounter).toHaveBeenCalledWith("2000");
      expect(renderer.winCelebration.present).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      expect(renderer.winCelebration.present).toHaveBeenCalledTimes(1);
      expect(renderer.winCelebration.present.mock.calls[0]?.[2]).toBe(2_000);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(renderer.winCelebration.present).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(renderer.winCelebration.present).toHaveBeenCalledTimes(2);

      // 只完成第二条 2000ms 的首次展示记录；后续空闲重复演出拥有独立
      // 生命周期，不能将其计时器无限清空。
      await vi.advanceTimersByTimeAsync(2_000);
      await controller.presentation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the verified Big Win event lease during lead-in and releases it after presentation", async () => {
    const controller = createRoundHarness();
    const renderer = controller.renderer as {
      bigWin: { present: ReturnType<typeof vi.fn> };
    };
    const releasePackage = vi.fn(() => true);
    const verifiedBytes = {
      spine: Uint8Array.of(1, 2, 3),
      font: new TextEncoder().encode("verified-font"),
      page: Uint8Array.of(137, 80, 78, 71),
      coins: new TextEncoder().encode('{"schemaVersion":1}'),
    };
    const loadedResource = (
      id: string,
      url: string,
      decoder: "binary" | "text" | "json",
      bytes: Uint8Array,
    ) => Object.freeze({
      spec: Object.freeze({ id, url, decoder, bytes: bytes.byteLength, sha256: "0".repeat(64) }),
      bytes,
      decoded: bytes,
    });
    const loadedPackage = Object.freeze({
      id: "desktop-feature-big-win",
      version: "test",
      stage: "feature-on-demand" as const,
      resources: new Map([
        ["spine", loadedResource("spine", "/assets/primal-runtime/spine/spine_ui/BigWin.skel", "binary", verifiedBytes.spine)],
        ["font", loadedResource("font", "/assets/primal-runtime/fonts/primal-rampage/PrimalRampage.fnt", "text", verifiedBytes.font)],
        ["page", loadedResource("page", "/assets/primal-runtime/fonts/primal-rampage/PrimalRampage.png", "binary", verifiedBytes.page)],
        ["coins", loadedResource("coins", "/assets/primal-runtime/interface/big-win-coins.json", "json", verifiedBytes.coins)],
      ]),
    });
    const acquirePackage = vi.fn(async (_id: string, _signal?: AbortSignal) => ({
      id: "desktop-feature-big-win",
      packageIds: ["desktop-feature-big-win"],
      package: loadedPackage,
      released: false,
      release: releasePackage,
    }));
    let releaseLeadIn!: () => void;
    let leadInPending = false;
    const presentationDelay = vi.fn((durationMs: number) => {
      if (durationMs === BIG_WIN_CONTROLLER_LEAD_IN_MS && !leadInPending) {
        leadInPending = true;
        return new Promise<void>((resolve) => { releaseLeadIn = resolve; });
      }
      return Promise.resolve();
    });
    Object.assign(controller, {
      bigWinAssetPackageId: "desktop-feature-big-win",
      streamingAssets: {
        acquirePackage,
        diagnostics: () => ({ mode: "on-demand" }),
        destroy: vi.fn(),
        scheduleFeatureShadowPrefetch: vi.fn(),
      },
      presentationDelay,
    });

    controller.handleSpinResult(roundResult({ totalWinMinor: "2000", wins: [{
      id: "big-win",
      symbol: "TANK",
      nominalAmountMinor: "2000",
      amountMinor: "2000",
      cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
    }] }));
    await vi.waitFor(() => expect(acquirePackage).toHaveBeenCalledOnce());

    expect(leadInPending).toBe(true);
    expect(renderer.bigWin.present).not.toHaveBeenCalled();
    const signal = acquirePackage.mock.calls[0]?.[1];
    if (!signal) throw new Error("Expected Big Win event lease signal");
    expect(acquirePackage).toHaveBeenCalledWith("desktop-feature-big-win", signal);
    expect(signal.aborted).toBe(false);

    releaseLeadIn();
    await controller.presentation;

    expect(renderer.bigWin.present).toHaveBeenCalledOnce();
    const presentCall = renderer.bigWin.present.mock.calls[0] as unknown as [
      unknown,
      AbortSignal,
      { spineBinary: Uint8Array; fontDescriptor: string; fontPageBytes: Uint8Array; coinManifest: unknown },
    ];
    expect(presentCall[1]).toBe(signal);
    expect(presentCall[2]).toMatchObject({
      spineBinary: verifiedBytes.spine,
      fontDescriptor: "verified-font",
      fontPageBytes: verifiedBytes.page,
      coinManifest: { schemaVersion: 1 },
    });
    expect(releasePackage).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(true);
  });

  it("starts Wheel and Free Spins leases before state transition, deduplicates them, and releases by feature lifetime", async () => {
    const controller = createRoundHarness();
    const releaseById = new Map<string, ReturnType<typeof vi.fn>>();
    const acquirePackage = vi.fn(async (id: string, _signal?: AbortSignal) => {
      const release = vi.fn(() => true);
      releaseById.set(id, release);
      return {
        id,
        packageIds: [id],
        package: Object.freeze({
          id,
          version: "test",
          stage: "feature-on-demand" as const,
          resources: new Map(),
        }),
        released: false,
        release,
      };
    });
    const adoptVerifiedFeatureArtwork = vi.fn(async () => undefined);
    const releaseVerifiedFeatureArtwork = vi.fn();
    Object.assign(controller.renderer, {
      adoptVerifiedFeatureArtwork,
      releaseVerifiedFeatureArtwork,
    });
    Object.assign(controller, {
      freeSpinsAssetPackageId: "desktop-feature-free-spins",
      wheelAssetPackageId: "desktop-feature-wheel",
      streamingAssets: {
        acquirePackage,
        diagnostics: () => ({ mode: "on-demand" }),
        destroy: vi.fn(),
        scheduleFeatureShadowPrefetch: vi.fn(),
      },
    });
    const machine = (controller as unknown as {
      machine: { transition: ReturnType<typeof vi.fn> };
    }).machine;
    const featureState: FeatureState = {
      mode: "EXPANSION",
      freeSpinsRemaining: 8,
      freeSpinsPlayed: 0,
      baseBetMinor: "100",
      freeSpinsWinMinor: "0",
      rageLevel: 1,
      rageCollected: 0,
    };

    controller.handleSpinResult(roundResult({
      wins: [],
      totalWinMinor: "0",
      grid: guaranteedRageGrid(),
      events: [
        GUARANTEED_RAGE_EVENT,
        { type: "wheel.started" },
        {
          type: "wheel.awarded",
          outcome: "EXPANSION",
          prize: "KONG_QUEST",
        },
        { type: "free_spins.started", mode: "EXPANSION", awarded: 8 },
      ],
      featureState,
    }));

    expect(acquirePackage.mock.calls.map(([id]) => id)).toEqual([
      "desktop-feature-free-spins",
      "desktop-feature-wheel",
    ]);
    expect(acquirePackage.mock.invocationCallOrder[0])
      .toBeLessThan(machine.transition.mock.invocationCallOrder[0] ?? 0);
    expect(acquirePackage.mock.invocationCallOrder[1])
      .toBeLessThan(machine.transition.mock.invocationCallOrder[0] ?? 0);
    await controller.presentation;

    expect(adoptVerifiedFeatureArtwork).toHaveBeenCalledTimes(2);
    expect(releaseById.get("desktop-feature-wheel")).toHaveBeenCalledOnce();
    expect(releaseById.get("desktop-feature-free-spins")).not.toHaveBeenCalled();
    expect(releaseVerifiedFeatureArtwork).toHaveBeenCalledWith("wheel");

    controller.snapshot.featureState = {
      ...featureState,
      freeSpinsRemaining: 1,
      freeSpinsPlayed: 7,
    };
    (machine as unknown as { phase: string }).phase = "requesting";
    controller.handleSpinResult(roundResult({
      roundId: "round-2",
      sequence: 2,
      chargedBetMinor: "0",
      wins: [],
      totalWinMinor: "0",
      events: [
        { type: "grid.expanded", rows: 3, ways: 27 },
        {
          type: "free_spins.completed",
          mode: "EXPANSION",
          awarded: 8,
          cumulativeWinMinor: "0",
        },
      ],
      featureState: BASE_FEATURE,
    }));
    await controller.presentation;

    expect(acquirePackage).toHaveBeenCalledTimes(2);
    expect(releaseById.get("desktop-feature-free-spins")).toHaveBeenCalledOnce();
    expect(releaseVerifiedFeatureArtwork).toHaveBeenCalledWith("free-spins");
  });

  it("shows a fixed weak-network error and still ACKs once without another economic request", async () => {
    const controller = createRoundHarness();
    const renderer = controller.renderer as {
      bigWin: { present: ReturnType<typeof vi.fn> };
    };
    const ui = (controller as unknown as {
      ui: { showError: ReturnType<typeof vi.fn> };
    }).ui;
    const acknowledgeSpinResult = vi.fn(() => true);
    const spin = vi.fn();
    const diagnostic = vi.fn();
    const sensitive = new Error("https://assets.invalid/?launchCode=secret");
    Object.assign(controller, {
      bigWinAssetPackageId: "desktop-feature-big-win",
      streamingAssets: {
        acquirePackage: vi.fn(async () => { throw sensitive; }),
        diagnostics: () => ({ mode: "on-demand" }),
        destroy: vi.fn(),
        scheduleFeatureShadowPrefetch: vi.fn(),
      },
      gateway: { acknowledgeSpinResult, spin },
      lastPlayerFacingError: null,
      onPlayerErrorDiagnostic: diagnostic,
      root: { dataset: {} },
      presentEffect: async (effect: () => Promise<void>) => {
        try {
          await effect();
        } catch (error) {
          (controller as unknown as {
            reportPlayerError(cause: unknown, context: "feature-presentation"): void;
          }).reportPlayerError(error, "feature-presentation");
        }
      },
    });

    controller.handleSpinResult(roundResult({ totalWinMinor: "2000", wins: [{
      id: "big-win",
      symbol: "TANK",
      nominalAmountMinor: "2000",
      amountMinor: "2000",
      cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
    }] }));
    await controller.presentation;

    expect(renderer.bigWin.present).not.toHaveBeenCalled();
    expect(ui.showError).toHaveBeenCalledWith(
      "The game could not finish this presentation. Please contact support if this continues.",
    );
    expect(JSON.stringify(ui.showError.mock.calls)).not.toContain("launchCode");
    expect(JSON.stringify(ui.showError.mock.calls)).not.toContain("secret");
    expect(diagnostic).toHaveBeenCalledWith({ code: "PRESENTATION_UNAVAILABLE" });
    expect(acknowledgeSpinResult).toHaveBeenCalledOnce();
    expect(spin).not.toHaveBeenCalled();
  });

  it("has no synthetic Continue tail and skips later normal-win records", async () => {
    vi.useFakeTimers();
    try {
      const controller = createRoundHarness();
      const presentationDelay = vi.fn((durationMs: number) => new Promise<void>((resolve) => {
        setTimeout(resolve, durationMs);
      }));
      const traces: AppPresentationTrace[] = [];
      Object.assign(controller, {
        presentationDelay,
        presentationObserver: {
          onPresentationTrace: (trace: AppPresentationTrace) => traces.push(trace),
        },
      });
      let finishCurrentView: (() => void) | null = null;
      const renderer = controller.renderer as {
        winCelebration: {
          present: ReturnType<typeof vi.fn>;
          requestFinish?: ReturnType<typeof vi.fn>;
        };
      };
      renderer.winCelebration.present.mockImplementation(() => new Promise<void>((resolve) => {
        finishCurrentView = resolve;
      }));
      renderer.winCelebration.requestFinish = vi.fn(() => {
        finishCurrentView?.();
        return true;
      });
      const finishWinCounter = vi.fn(() => true);
      Object.assign((controller as unknown as { ui: Record<string, unknown> }).ui, {
        finishWinCounter,
      });
      const records = [
        {
          id: "continued-first",
          symbol: "TANK" as const,
          nominalAmountMinor: "125",
          amountMinor: "125",
          cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
        },
        {
          id: "must-not-show",
          symbol: "CIRCUIT" as const,
          nominalAmountMinor: "125",
          amountMinor: "125",
          cells: [{ reel: 0, row: 1 }, { reel: 1, row: 1 }, { reel: 2, row: 1 }],
        },
      ];
      let presentationComplete = false;

      controller.handleSpinResult(roundResult({ totalWinMinor: "250", wins: records }));
      void controller.presentation.then(() => { presentationComplete = true; });
      await vi.advanceTimersByTimeAsync(16);
      await vi.advanceTimersByTimeAsync(300);
      expect(renderer.winCelebration.present).toHaveBeenCalledTimes(1);

      controller.requestFastStop();
      await vi.advanceTimersByTimeAsync(0);
      expect(finishWinCounter).toHaveBeenCalledTimes(1);
      expect(renderer.winCelebration.requestFinish).toHaveBeenCalledTimes(1);
      expect(renderer.winCelebration.present).toHaveBeenCalledTimes(1);
      expect(controller.audio.quickStopReelLoop).toHaveBeenCalledTimes(1);
      expect(presentationDelay).not.toHaveBeenCalledWith(50);
      expect(presentationComplete).toBe(true);
      expect((controller as unknown as { normalWinPresentationActive: boolean })
        .normalWinPresentationActive).toBe(false);
      expect(renderer.winCelebration.present).toHaveBeenCalledTimes(1);
      expect(traces.filter(({ type }) => type === "normal-win.continue-accepted"))
        .toHaveLength(1);
      expect(traces.filter(({ type }) => type === "normal-win.logical-done"))
        .toHaveLength(1);

      await vi.runAllTimersAsync();
      await controller.presentation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("projects an authoritative result through result, win, and completion phases", async () => {
    const controller = createRoundHarness();
    controller.handleSpinResult(roundResult({ wins: [], totalWinMinor: "0" }));
    await controller.presentation;

    const transitions = (controller as unknown as {
      reelRound: { transition: ReturnType<typeof vi.fn> };
    }).reelRound.transition;
    expect(transitions.mock.calls.map(([event]) => event)).toEqual([
      { type: "RESULT_RECEIVED", roundId: "round-1", rows: 3 },
      { type: "WIN_PRESENTATION_STARTED" },
      { type: "ROUND_COMPLETE" },
    ]);
    expect((controller as unknown as {
      ui: { beginResultPresentation: ReturnType<typeof vi.fn> };
    }).ui.beginResultPresentation).toHaveBeenCalledOnce();
    expect((controller as unknown as {
      ui: { beginResultPresentation: ReturnType<typeof vi.fn> };
    }).ui.beginResultPresentation).toHaveBeenCalledWith(false);
  });

  it("keeps zero-paid capped Wins as audit facts without presenting a win", async () => {
    const origin: FeatureState = {
      mode: "OVERDRIVE",
      freeSpinsRemaining: 2,
      freeSpinsPlayed: 6,
      baseBetMinor: "100",
      freeSpinsWinMinor: "250000",
      rageLevel: 1,
      rageCollected: 0,
    };
    const controller = createRoundHarness(origin);
    const traces: AppPresentationTrace[] = [];
    Object.assign(controller, {
      presentationObserver: {
        onPresentationTrace: (trace: AppPresentationTrace) => traces.push(trace),
      },
    });

    controller.handleSpinResult(roundResult({
      chargedBetMinor: "0",
      totalWinMinor: "0",
      wins: [{
        id: "zero-paid-cap-win",
        symbol: "ORBIT",
        nominalAmountMinor: "100",
        amountMinor: "0",
        cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
      }],
      events: [{
        type: "win_cap.reached",
        multiplier: 2_500,
        cumulativeWinMinor: "250000",
      }],
      featureState: {
        ...origin,
        freeSpinsRemaining: 1,
        freeSpinsPlayed: 7,
      },
    }));
    await controller.presentation;

    const renderer = controller.renderer as {
      reactToWin: ReturnType<typeof vi.fn>;
      winCelebration: { present: ReturnType<typeof vi.fn> };
    };
    const ui = (controller as unknown as {
      ui: { beginResultPresentation: ReturnType<typeof vi.fn> };
    }).ui;
    expect(renderer.reactToWin).not.toHaveBeenCalled();
    expect(renderer.winCelebration.present).not.toHaveBeenCalled();
    expect(controller.audio.playPayoutWin).not.toHaveBeenCalled();
    expect(controller.audio.playSymbolWin).not.toHaveBeenCalled();
    expect(ui.beginResultPresentation).toHaveBeenCalledWith(false);
    expect(traces[0]).toMatchObject({
      type: "result.accepted",
      totalWinMinor: "0",
      winCount: 0,
    });
  });

  it("acknowledges a pending RGS result before the final ready UI projection", async () => {
    const controller = createRoundHarness();
    const order: string[] = [];
    let pending = true;
    const acknowledgeSpinResult = vi.fn((roundId: string, sequence: number) => {
      order.push(`ack:${roundId}:${sequence}`);
      pending = false;
      return true;
    });
    const gateway = {
      get hasPendingSpin(): boolean {
        return pending;
      },
      acknowledgeSpinResult,
    };
    Object.assign(controller, {
      gateway,
      refreshUi: vi.fn(() => order.push(`refresh:pending=${String(pending)}`)),
    });

    controller.handleSpinResult(roundResult({ wins: [], totalWinMinor: "0" }));
    await controller.presentation;

    expect(acknowledgeSpinResult).toHaveBeenCalledOnce();
    expect(order.at(-2)).toBe("ack:round-1:1");
    expect(order.at(-1)).toBe("refresh:pending=false");
    expect(gateway.hasPendingSpin).toBe(false);
  });

  it("publishes ordered immutable traces from acceptance through settlement", async () => {
    const controller = createRoundHarness();
    const traces: AppPresentationTrace[] = [];
    Object.assign(controller, {
      presentationObserver: {
        onPresentationTrace: (trace: AppPresentationTrace) => traces.push(trace),
      },
    });
    const present = (controller.renderer as {
      winCelebration: { present: ReturnType<typeof vi.fn> };
    }).winCelebration.present;
    present.mockImplementation(async (
      wins: readonly SpinResult["wins"][number][],
      _reducedMotion: boolean,
      _holdDurationMs: number,
      onMilestone?: (milestone: string, record: {
        id: string;
        symbol: SpinResult["wins"][number]["symbol"];
        amountMinor: string;
        multiplier: number;
      }) => void,
    ) => {
      const win = wins[0]!;
      const record = {
        id: win.id,
        symbol: win.symbol,
        amountMinor: win.amountMinor,
        multiplier: win.multiplier ?? 1,
      };
      onMilestone?.("visible", record);
      await Promise.resolve();
      for (const milestone of ["hold-complete", "hidden"]) {
        onMilestone?.(milestone, record);
      }
    });

    controller.handleSpinResult(roundResult());
    await controller.presentation;

    expect(traces.map(({ type }) => type)).toEqual([
      "result.accepted",
      "reels.settled",
      "win-record.visible",
      "counter.started",
      "win-record.hold-complete",
      "win-record.hidden",
      "counter.completed",
      "balance.committed",
      "round.complete",
    ]);
    expect(traces[0]).toEqual({
      type: "result.accepted",
      sequence: 1,
      roundId: "round-1",
      totalWinMinor: "100",
      balanceMinor: "10000",
      winCount: 1,
    });
    expect(traces[2]).toEqual({
      type: "win-record.visible",
      sequence: 1,
      index: 0,
      count: 1,
      id: "win-1",
      symbol: "TANK",
      amountMinor: "100",
      multiplier: 1,
    });
    expect(traces.at(-2)).toEqual({
      type: "balance.committed",
      sequence: 1,
      balanceMinor: "10000",
    });
    expect(traces.every(Object.isFrozen)).toBe(true);
  });

  it("lets an optional win-record trace checkpoint pause only fixture presentation", async () => {
    const controller = createRoundHarness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const onPresentationCheckpoint = vi.fn((checkpoint: {
      type: string;
      trace?: AppPresentationTrace;
    }) => checkpoint.trace?.type === "win-record.visible" ? gate : undefined);
    Object.assign(controller, {
      presentationObserver: {
        onPresentationTrace: vi.fn(),
        onPresentationCheckpoint,
      },
    });
    const present = (controller.renderer as {
      winCelebration: { present: ReturnType<typeof vi.fn> };
    }).winCelebration.present;
    present.mockImplementation(async (
      wins: readonly SpinResult["wins"][number][],
      _reducedMotion: boolean,
      _holdDurationMs: number,
      onMilestone?: (milestone: string, record: {
        id: string;
        symbol: SpinResult["wins"][number]["symbol"];
        amountMinor: string;
        multiplier: number;
      }) => void | Promise<void>,
    ) => {
      const win = wins[0]!;
      await onMilestone?.("visible", {
        id: win.id,
        symbol: win.symbol,
        amountMinor: win.amountMinor,
        multiplier: win.multiplier ?? 1,
      });
    });
    let completed = false;

    controller.handleSpinResult(roundResult());
    void controller.presentation.then(() => { completed = true; });
    for (let index = 0; index < 12; index += 1) await Promise.resolve();

    expect(onPresentationCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      type: "presentation-trace",
      trace: expect.objectContaining({
        type: "win-record.visible",
        sequence: 1,
        index: 0,
      }),
    }));
    expect(completed).toBe(false);

    release();
    await controller.presentation;
    expect(completed).toBe(true);
  });

  it("isolates throwing trace observers from the production presentation", async () => {
    const controller = createRoundHarness();
    Object.assign(controller, {
      presentationObserver: {
        onPresentationTrace: vi.fn(() => { throw new Error("fixture observer failed"); }),
      },
    });

    controller.handleSpinResult(roundResult({ wins: [], totalWinMinor: "0" }));
    await expect(controller.presentation).resolves.toBeUndefined();

    expect((controller as unknown as { machine: { phase: string } }).machine.phase).toBe("ready");
    expect((controller as unknown as { ui: { applyResult: ReturnType<typeof vi.fn> } })
      .ui.applyResult).toHaveBeenCalledOnce();
  });

  it("plays stopped-grid Ways wins before PPS events", async () => {
    const controller = createRoundHarness();
    controller.handleSpinResult(roundResult({
      grid: BASE_GRID.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
        reelIndex === 0 && rowIndex === 2 ? { symbol: "SURGE" as const } : cell
      ))),
      events: [{
        type: "surge.collected",
        count: 1,
        cells: [{ reel: 0, row: 2 }],
        triggered: false,
        guaranteed: false,
        level: 1,
        total: 1,
      }],
      featureState: { ...BASE_FEATURE, rageCollected: 1 },
    }));
    await controller.presentation;

    expect(controller.log.indexOf("line-win"))
      .toBeLessThan(controller.log.indexOf("features:surge.collected"));
  });

  it("presents an extra-spin award as 6/7 -> 6/9 -> 7/9 with one sweep", async () => {
    const previous: FeatureState = {
      mode: "EXPANSION",
      freeSpinsRemaining: 2,
      freeSpinsPlayed: 5,
      baseBetMinor: "100",
      freeSpinsWinMinor: "800",
      rageLevel: 5,
      rageCollected: 0,
    };
    const finalState: FeatureState = {
      ...previous,
      freeSpinsRemaining: 3,
      freeSpinsPlayed: 6,
      freeSpinsWinMinor: "900",
    };
    const controller = createRoundHarness(previous);
    delete (controller as unknown as { presentPostReelFeatureEvents?: unknown })
      .presentPostReelFeatureEvents;

    const timeline: string[] = [];
    let priorTotal = 0;
    let sweeps = 0;
    const recordProjection = (state: FeatureState, awardMutation: boolean) => {
      const projection = projectFreeSpinHud(state);
      if (awardMutation && priorTotal !== 0 && projection.totalAwarded > priorTotal) sweeps += 1;
      timeline.push(formatFreeSpinCounter(projection));
      priorTotal = projection.totalAwarded;
    };
    const updateFreeSpinHud = vi.fn((state: FeatureState) => recordProjection(state, false));
    const presentFreeSpinAwardBatch = vi.fn(async (
      _events: readonly FeatureEvent[],
      state: FeatureState,
    ) => recordProjection(state, true));
    Object.assign(controller.renderer, {
      updateFreeSpinHud,
      presentFreeSpinAwardBatch,
    });
    Object.assign(controller.audio, { playVaultFly: vi.fn() });

    controller.handleSpinResult(roundResult({
      chargedBetMinor: "0",
      wins: [],
      totalWinMinor: "100",
      grid: freeSpinVaultGrid([0, 1]),
      events: [
        { type: "grid.expanded", rows: 3, ways: 27 },
        {
          type: "vaults.landed", count: 2,
          cells: [{ reel: 1, row: 0 }, { reel: 1, row: 1 }],
        },
        {
          type: "vaults.unlock.started", count: 2,
          cells: [{ reel: 1, row: 0 }, { reel: 1, row: 1 }],
        },
        { type: "vault.unlocked", reel: 1, row: 0, prize: "FREE_SPIN" },
        { type: "free_spin.awarded", count: 1, reel: 1, row: 0 },
        { type: "vault.unlocked", reel: 1, row: 1, prize: "FREE_SPIN" },
        { type: "free_spin.awarded", count: 1, reel: 1, row: 1 },
        {
          type: "vaults.unlock.completed", count: 2,
          cells: [{ reel: 1, row: 0 }, { reel: 1, row: 1 }],
        },
      ],
      featureState: finalState,
    }));
    await controller.presentation;

    expect(timeline).toEqual(["6 / 7", "6 / 9", "7 / 9"]);
    expect(sweeps).toBe(1);
    expect(presentFreeSpinAwardBatch).toHaveBeenCalledTimes(1);
    expect(updateFreeSpinHud).toHaveBeenCalledTimes(2);
  });

  it("keeps the completed ordinal on a non-terminal CAP until SPINEND", async () => {
    const previous: FeatureState = {
      mode: "EXPANSION",
      freeSpinsRemaining: 3,
      freeSpinsPlayed: 5,
      baseBetMinor: "100",
      freeSpinsWinMinor: "800",
      rageLevel: 5,
      rageCollected: 0,
    };
    const finalState: FeatureState = {
      ...previous,
      freeSpinsRemaining: 2,
      freeSpinsPlayed: 6,
      freeSpinsWinMinor: "900",
    };
    const controller = createRoundHarness(previous);
    delete (controller as unknown as { presentPostReelFeatureEvents?: unknown })
      .presentPostReelFeatureEvents;

    const timeline: string[] = [];
    const recordProjection = (state: FeatureState) => {
      timeline.push(formatFreeSpinCounter(projectFreeSpinHud(state)));
    };
    Object.assign(controller.renderer, {
      updateFreeSpinHud: vi.fn(recordProjection),
      presentFreeSpinCap: vi.fn(async (_event: FeatureEvent, state: FeatureState) => {
        recordProjection(state);
      }),
    });

    controller.handleSpinResult(roundResult({
      chargedBetMinor: "0",
      wins: [],
      totalWinMinor: "100",
      grid: freeSpinVaultGrid([2]),
      events: [
        { type: "grid.expanded", rows: 3, ways: 27 },
        { type: "vaults.landed", count: 1, cells: [{ reel: 1, row: 2 }] },
        { type: "vaults.unlock.started", count: 1, cells: [{ reel: 1, row: 2 }] },
        { type: "vault.unlocked", reel: 1, row: 2, prize: "FREE_SPIN" },
        { type: "free_spin.cap_reached", reel: 1, row: 2 },
        { type: "vaults.unlock.completed", count: 1, cells: [{ reel: 1, row: 2 }] },
      ],
      featureState: finalState,
    }));
    await controller.presentation;

    expect(timeline).toEqual(["6 / 8", "6 / 8", "7 / 8"]);
  });

  it("freezes visible balance during presentation and commits the newest reconnect balance", async () => {
    const controller = createRoundHarness();
    const ui = (controller as unknown as {
      ui: {
        applySession: ReturnType<typeof vi.fn>;
        applyResult: ReturnType<typeof vi.fn>;
      };
    }).ui;
    ui.applySession = vi.fn();
    Object.assign(controller, {
      gateway: { hasPendingSpin: false },
      hasOpenedSession: true,
      visibleBalanceMinor: "10000",
      launch: { canEnterGame: true, transition: vi.fn() },
      syncGameMusic: vi.fn(),
      syncLaunchUi: vi.fn(),
      featurePreviewActive: false,
      initialSessionResolver: null,
    });

    controller.handleSpinResult(roundResult({
      balanceMinor: "9900",
      wins: [],
      totalWinMinor: "0",
    }));
    controller.handleSession({
      type: "session.opened",
      protocolVersion: 1,
      requestId: "reconnect-during-presentation",
      sessionId: "session-1",
      currency: "EUR",
      currencyExponent: 2,
      balanceMinor: "9950",
      betOptionsMinor: ["100"],
      defaultBetMinor: "100",
      featureState: BASE_FEATURE,
    });

    expect(ui.applySession).toHaveBeenCalledWith(expect.objectContaining({
      balanceMinor: "10000",
    }));
    expect(ui.applyResult).not.toHaveBeenCalled();

    await controller.presentation;

    expect(ui.applyResult).toHaveBeenCalledTimes(1);
    expect(ui.applyResult).toHaveBeenCalledWith(expect.objectContaining({
      balanceMinor: "9950",
    }));
  });

  it("does not start Big Win early from a later explicit feature award", async () => {
    const controller = createRoundHarness();
    controller.handleSpinResult(roundResult({
      totalWinMinor: "100100",
      grid: guaranteedRageGrid(),
      wins: [{
        id: "ways-only",
        symbol: "TANK",
        nominalAmountMinor: "100",
        amountMinor: "100",
        cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
      }],
      events: [
        GUARANTEED_RAGE_EVENT,
        { type: "wheel.started" },
        {
          type: "wheel.awarded",
          outcome: "INSTANT",
          prize: "GRAND",
          multiplier: 1_000,
          amountMinor: "100000",
        },
      ],
    }));
    await controller.presentation;

    expect(controller.log).not.toContain("big-win");
    const wheelFeatureIndex = controller.log.findIndex((entry) => entry.includes("wheel.started"));
    expect(controller.log.indexOf("line-win"))
      .toBeLessThan(wheelFeatureIndex);
  });

  it("uses the retained round origin when a reconnect snapshot arrived mid-spin", async () => {
    const origin: FeatureState = {
      mode: "EXPANSION",
      freeSpinsRemaining: 1,
      freeSpinsPlayed: 7,
      baseBetMinor: "100",
      freeSpinsWinMinor: "2200",
      rageLevel: 5,
      rageCollected: 0,
    };
    const controller = createRoundHarness(BASE_FEATURE);
    controller.roundOriginFeatureState = origin;
    controller.handleSpinResult(roundResult({
      chargedBetMinor: "0",
      events: [
        { type: "grid.expanded", rows: 3, ways: 27 },
        {
          type: "free_spins.completed",
          mode: "EXPANSION",
          awarded: 8,
          cumulativeWinMinor: "2300",
        },
      ],
      featureState: { ...BASE_FEATURE, rageLevel: 5, rageCollected: 0 },
    }));
    await controller.presentation;

    expect(controller.log).toContain("feature-exit");
    expect(controller.roundOriginFeatureState).toBeNull();
    expect((controller.renderer as { playFreeSpinHudWin: ReturnType<typeof vi.fn> })
      .playFreeSpinHudWin).not.toHaveBeenCalled();
  });

  it("restores accepted Base visuals when a terminal Free Spins presentation fails", async () => {
    const previous: FeatureState = {
      mode: "EXPANSION",
      freeSpinsRemaining: 1,
      freeSpinsPlayed: 7,
      baseBetMinor: "100",
      freeSpinsWinMinor: "2200",
      rageLevel: 1,
      rageCollected: 0,
    };
    const finalState: FeatureState = { ...BASE_FEATURE, rageLevel: 1, rageCollected: 0 };
    const controller = createRoundHarness(previous);
    const renderer = controller.renderer as {
      cancelSpinPresentation: ReturnType<typeof vi.fn>;
      restoreFeatureState: ReturnType<typeof vi.fn>;
      reels: { setGrid: ReturnType<typeof vi.fn> };
      winCelebration: { present: ReturnType<typeof vi.fn> };
    };
    renderer.winCelebration.present.mockRejectedValueOnce(new Error("summary render failed"));

    controller.handleSpinResult(roundResult({
      chargedBetMinor: "0",
      events: [
        { type: "grid.expanded", rows: 3, ways: 27 },
        {
          type: "free_spins.completed",
          mode: "EXPANSION",
          awarded: 8,
          cumulativeWinMinor: "2300",
        },
      ],
      featureState: finalState,
    }));
    await expect(controller.presentation).rejects.toThrow("summary render failed");
    await flushMicrotasks();

    expect(renderer.cancelSpinPresentation).toHaveBeenCalledOnce();
    expect(renderer.restoreFeatureState).toHaveBeenCalledOnce();
    expect(renderer.restoreFeatureState).toHaveBeenCalledWith(finalState);
    expect(renderer.reels.setGrid).toHaveBeenCalledWith(BASE_GRID);
    expect(controller.snapshot.featureState).toEqual(finalState);
  });

  it("does not play the Free Spins HUD win burst for a Vault-only positive total", async () => {
    const previous: FeatureState = {
      mode: "EXPANSION",
      freeSpinsRemaining: 2,
      freeSpinsPlayed: 3,
      baseBetMinor: "100",
      freeSpinsWinMinor: "1000",
      rageLevel: 5,
      rageCollected: 0,
    };
    const current: FeatureState = {
      ...previous,
      freeSpinsRemaining: 1,
      freeSpinsPlayed: 4,
      freeSpinsWinMinor: "1500",
    };
    const controller = createRoundHarness(previous);
    controller.handleSpinResult(roundResult({
      chargedBetMinor: "0",
      grid: [
        BASE_GRID[0]!,
        [
          { symbol: "VAULT", prize: "X5", multiplier: 5 },
          BASE_GRID[1]![1]!,
          BASE_GRID[1]![2]!,
        ],
        BASE_GRID[2]!,
      ],
      wins: [],
      totalWinMinor: "500",
      featureState: current,
      events: [
        { type: "grid.expanded", rows: 3, ways: 27 },
        {
          type: "vault.awarded",
          reel: 1,
          row: 0,
          multiplier: 5,
          amountMinor: "500",
          prize: "X5",
        },
      ],
    }));
    await controller.presentation;

    expect((controller.renderer as { playFreeSpinHudWin: ReturnType<typeof vi.fn> })
      .playFreeSpinHudWin).not.toHaveBeenCalled();
  });

  it("presents final line wins before the terminal Free Spins summary", async () => {
    const previous: FeatureState = {
      mode: "EXPANSION",
      freeSpinsRemaining: 1,
      freeSpinsPlayed: 7,
      baseBetMinor: "100",
      freeSpinsWinMinor: "2200",
      rageLevel: 5,
      rageCollected: 3,
    };
    const controller = createRoundHarness(previous);
    controller.handleSpinResult(roundResult({
      chargedBetMinor: "0",
      events: [
        { type: "grid.expanded", rows: 3, ways: 27 },
        {
          type: "free_spins.completed",
          mode: "EXPANSION",
          awarded: 8,
          cumulativeWinMinor: "2300",
        },
      ],
      featureState: { ...BASE_FEATURE, rageLevel: 5, rageCollected: 3 },
    }));
    await controller.presentation;

    expect(controller.log).toEqual([
      "round-win",
      "loss-or-equal-audio",
      "line-win",
      "symbol-audio",
      "symbol-audio",
      "features:free_spins.completed",
      "feature-exit",
    ]);
  });

  it.each(["0", "100"])("shows the no-summary concluded status for cumulative %s", async (
    cumulativeWinMinor,
  ) => {
    const previous: FeatureState = {
      mode: "EXPANSION",
      freeSpinsRemaining: 1,
      freeSpinsPlayed: 7,
      baseBetMinor: "100",
      freeSpinsWinMinor: cumulativeWinMinor,
      rageLevel: 5,
      rageCollected: 3,
    };
    const controller = createRoundHarness(previous);
    delete (controller as unknown as { presentPostReelFeatureEvents?: unknown })
      .presentPostReelFeatureEvents;
    Object.assign(controller.renderer, {
      hideFreeSpinHud: vi.fn(async () => undefined),
      cueFeatureEnvironment: vi.fn(),
    });

    controller.handleSpinResult(roundResult({
      chargedBetMinor: "0",
      wins: [],
      totalWinMinor: "0",
      events: [
        { type: "grid.expanded", rows: 3, ways: 27 },
        {
          type: "free_spins.completed",
          mode: "EXPANSION",
          awarded: 8,
          cumulativeWinMinor,
        },
      ],
      featureState: { ...BASE_FEATURE, rageLevel: 5, rageCollected: 3 },
    }));
    await controller.presentation;

    const ui = (controller as unknown as {
      ui: { showFreeSpinConclusion: ReturnType<typeof vi.fn> };
    }).ui;
    expect(ui.showFreeSpinConclusion).toHaveBeenCalledTimes(1);
    expect(ui.showFreeSpinConclusion).toHaveBeenCalledWith(cumulativeWinMinor);
  });

  it("orders terminal CAPLIMIT, no-summary exit start, then HUD hide completion", async () => {
    const previous: FeatureState = {
      mode: "EXPANSION",
      freeSpinsRemaining: 1,
      freeSpinsPlayed: 7,
      baseBetMinor: "100",
      freeSpinsWinMinor: "0",
      rageLevel: 5,
      rageCollected: 3,
    };
    const controller = createRoundHarness(previous);
    const order: string[] = [];
    let capState: FeatureState | undefined;
    delete (controller as unknown as { presentPostReelFeatureEvents?: unknown })
      .presentPostReelFeatureEvents;
    Object.assign(controller.renderer, {
      presentFreeSpinCap: vi.fn(async (_event: FeatureEvent, state: FeatureState) => {
        capState = { ...state };
        order.push("cap");
      }),
      hideFreeSpinHud: vi.fn(async () => order.push("hide-hud")),
      beginFeatureExitAtSummaryHide: vi.fn(() => order.push("restore-scene")),
    });
    Object.assign(
      (controller.renderer as { featureEffects: Record<string, unknown> }).featureEffects,
      {
        presentAfterReels: vi.fn(async (event: FeatureEvent) => {
          if (event.type === "free_spins.completed") order.push("summary");
        }),
      },
    );
    Object.assign(controller.audio, {
      endFreeSpinsMode: vi.fn(() => order.push("restore-base-music")),
    });

    controller.handleSpinResult(roundResult({
      chargedBetMinor: "0",
      wins: [],
      totalWinMinor: "0",
      grid: freeSpinVaultGrid([2]),
      events: [
        { type: "grid.expanded", rows: 3, ways: 27 },
        { type: "vaults.landed", count: 1, cells: [{ reel: 1, row: 2 }] },
        { type: "vaults.unlock.started", count: 1, cells: [{ reel: 1, row: 2 }] },
        { type: "vault.unlocked", reel: 1, row: 2, prize: "FREE_SPIN" },
        { type: "free_spin.cap_reached", reel: 1, row: 2 },
        { type: "vaults.unlock.completed", count: 1, cells: [{ reel: 1, row: 2 }] },
        {
          type: "free_spins.completed",
          mode: "EXPANSION",
          awarded: 8,
          cumulativeWinMinor: "0",
        },
      ],
      featureState: { ...BASE_FEATURE, rageLevel: 5, rageCollected: 3 },
    }));
    await controller.presentation;

    expect(capState).toEqual(previous);
    expect(order).toEqual([
      "cap",
      "restore-base-music",
      "restore-scene",
      "hide-hud",
    ]);
  });

  it("uses one whole-round character reaction while retaining per-line overlays", async () => {
    const controller = createRoundHarness();
    const wins = [
      {
        id: "line-a",
        symbol: "TANK" as const,
        nominalAmountMinor: "125",
        amountMinor: "125",
        cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
      },
      {
        id: "line-b",
        symbol: "CIRCUIT" as const,
        nominalAmountMinor: "125",
        amountMinor: "125",
        cells: [{ reel: 0, row: 1 }, { reel: 1, row: 1 }, { reel: 2, row: 1 }],
      },
    ];
    controller.handleSpinResult(roundResult({ totalWinMinor: "250", wins }));
    await controller.presentation;

    const renderer = controller.renderer as {
      reactToWin: ReturnType<typeof vi.fn>;
      winCelebration: { present: ReturnType<typeof vi.fn> };
    };
    expect(renderer.reactToWin).toHaveBeenCalledTimes(1);
    expect(renderer.reactToWin).toHaveBeenCalledWith(wins, "base");
    expect(renderer.winCelebration.present).toHaveBeenCalledTimes(2);
    expect(controller.audio.playMonsterRoar).toHaveBeenCalledTimes(1);
    expect(controller.audio.playSymbolWin).toHaveBeenCalledTimes(4);
  });

  it("counts the Free Spins WIN field from prior to new cumulative server total", async () => {
    const previous: FeatureState = {
      mode: "EXPANSION",
      freeSpinsRemaining: 4,
      freeSpinsPlayed: 4,
      baseBetMinor: "100",
      freeSpinsWinMinor: "900",
      rageLevel: 2,
      rageCollected: 1,
    };
    const controller = createRoundHarness(previous);
    controller.handleSpinResult(roundResult({
      chargedBetMinor: "0",
      totalWinMinor: "150",
      wins: [{
        id: "fs-win",
        symbol: "TANK",
        nominalAmountMinor: "150",
        amountMinor: "150",
        cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
      }],
      events: [{ type: "grid.expanded", rows: 3, ways: 27 }],
      featureState: {
        ...previous,
        freeSpinsRemaining: 3,
        freeSpinsPlayed: 5,
        freeSpinsWinMinor: "1050",
      },
    }));
    await controller.presentation;

    const presentWinCounter = (controller as unknown as {
      ui: { presentWinCounter: ReturnType<typeof vi.fn> };
    }).ui.presentWinCounter;
    expect(presentWinCounter).toHaveBeenCalledWith("1050", 750, "900");
  });

  it("keeps the visible counter and pathless layers but silences counter audio at bet", async () => {
    const controller = createRoundHarness();
    controller.handleSpinResult(roundResult({ totalWinMinor: "100" }));
    await controller.presentation;

    const presentWinCounter = (controller as unknown as {
      ui: { presentWinCounter: ReturnType<typeof vi.fn> };
    }).ui.presentWinCounter;
    expect(controller.audio.playWinLossOrEqual).toHaveBeenCalledTimes(1);
    expect(presentWinCounter).toHaveBeenCalledWith("100", 500, "0");
    expect(controller.audio.beginNormalWinCounter).not.toHaveBeenCalled();
    expect(controller.audio.endNormalWinCounter).not.toHaveBeenCalled();
    expect(controller.audio.playSymbolWin).toHaveBeenCalledTimes(2);
  });

  it("keeps a below-bet visual counter and WinLess sound without counter audio", async () => {
    const controller = createRoundHarness();
    controller.handleSpinResult(roundResult({
      totalWinMinor: "99",
      wins: [{
        id: "below-bet",
        symbol: "TANK",
        nominalAmountMinor: "99",
        amountMinor: "99",
        cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
      }],
    }));
    await controller.presentation;

    const presentWinCounter = (controller as unknown as {
      ui: { presentWinCounter: ReturnType<typeof vi.fn> };
    }).ui.presentWinCounter;
    expect(presentWinCounter).toHaveBeenCalledWith("99", 495, "0");
    expect(controller.audio.playWinLossOrEqual).toHaveBeenCalledTimes(1);
    expect(controller.audio.beginNormalWinCounter).not.toHaveBeenCalled();
    expect(controller.audio.endNormalWinCounter).not.toHaveBeenCalled();
    expect(controller.audio.playSymbolWin).toHaveBeenCalledTimes(2);
  });

  it("keeps ScatterWin outside the ordinary celebratory payline gate", async () => {
    const controller = createRoundHarness();
    controller.handleSpinResult(roundResult({
      totalWinMinor: "100",
      wins: [{
        id: "scatter",
        symbol: "SURGE",
        nominalAmountMinor: "100",
        amountMinor: "100",
        cells: [{ reel: 1, row: 0 }],
      }],
    }));
    await controller.presentation;

    expect(controller.audio.playWinLossOrEqual).toHaveBeenCalledTimes(1);
    expect(controller.audio.playSymbolWin).toHaveBeenCalledWith(
      "scatter-win",
      expect.objectContaining({ intensity: 1, reducedMotion: false }),
    );
    expect(controller.audio.playSymbolWin).toHaveBeenCalledTimes(1);
    expect(controller.audio.beginNormalWinCounter).not.toHaveBeenCalled();
    expect(controller.audio.endNormalWinCounter).not.toHaveBeenCalled();
  });

  it("starts and stops normal counter audio once above the strict bet boundary", async () => {
    const controller = createRoundHarness();
    controller.handleSpinResult(roundResult({
      totalWinMinor: "101",
      wins: [{
        id: "celebratory-counter",
        symbol: "TANK",
        nominalAmountMinor: "101",
        amountMinor: "101",
        cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
      }],
    }));
    await controller.presentation;

    expect(controller.audio.playWinLossOrEqual).not.toHaveBeenCalled();
    expect(controller.audio.beginNormalWinCounter).toHaveBeenCalledTimes(1);
    expect(controller.audio.endNormalWinCounter).toHaveBeenCalledTimes(1);
    expect(controller.audio.playSymbolWin).toHaveBeenCalledTimes(2);
  });

  it("runs pathless symbol layers and normal START only after the exact 20x Big Win", async () => {
    const controller = createRoundHarness();
    controller.handleSpinResult(roundResult({
      totalWinMinor: "2000",
      wins: [{
        id: "big-win-line",
        symbol: "TANK",
        nominalAmountMinor: "2000",
        amountMinor: "2000",
        cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
      }],
    }));
    await controller.presentation;

    const renderer = controller.renderer as {
      bigWin: { present: ReturnType<typeof vi.fn> };
      reels: { highlight: ReturnType<typeof vi.fn> };
    };
    expect(renderer.bigWin.present).toHaveBeenCalledTimes(1);
    expect(renderer.reels.highlight).toHaveBeenCalledOnce();
    expect(renderer.reels.highlight).toHaveBeenCalledWith([
      { reel: 0, row: 0 },
      { reel: 1, row: 0 },
      { reel: 2, row: 0 },
    ]);
    expect(controller.audio.playPayoutWin).not.toHaveBeenCalled();
    expect(controller.audio.playSymbolWin).toHaveBeenCalledTimes(2);
    expect(controller.audio.beginNormalWinCounter).not.toHaveBeenCalled();
    expect(controller.audio.endNormalWinCounter).not.toHaveBeenCalled();
    const ui = (controller as unknown as {
      ui: {
        presentWinCounter: ReturnType<typeof vi.fn>;
        resetWinCounter: ReturnType<typeof vi.fn>;
        showBigWinCongratulations: ReturnType<typeof vi.fn>;
      };
    }).ui;
    expect(ui.presentWinCounter).not.toHaveBeenCalled();
    expect(ui.resetWinCounter).toHaveBeenCalledWith("2000");
    expect(ui.showBigWinCongratulations).toHaveBeenCalledOnce();
    const setSpinMode = (controller as unknown as {
      ui: { setSpinMode: ReturnType<typeof vi.fn> };
    }).ui.setSpinMode;
    expect(setSpinMode).toHaveBeenCalledWith("big-win-skip");
    expect(setSpinMode).toHaveBeenCalledWith("normal-win-skip");
    expect(setSpinMode).toHaveBeenCalledWith("waiting");
    expect(controller.log).toEqual([
      "big-win",
      "round-win",
      "line-win",
      "symbol-audio",
      "symbol-audio",
    ]);
  });

  it("keeps payout and symbol audio below the 20x Big Win boundary", async () => {
    const controller = createRoundHarness();
    controller.handleSpinResult(roundResult({
      totalWinMinor: "1999",
      wins: [{
        id: "ordinary-win-line",
        symbol: "TANK",
        nominalAmountMinor: "1999",
        amountMinor: "1999",
        cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
      }],
    }));
    await controller.presentation;

    const renderer = controller.renderer as {
      bigWin: { present: ReturnType<typeof vi.fn> };
    };
    expect(renderer.bigWin.present).not.toHaveBeenCalled();
    expect(controller.audio.playPayoutWin).toHaveBeenCalledTimes(1);
    expect(controller.audio.playSymbolWin).toHaveBeenCalledTimes(2);
    expect(controller.log).toEqual([
      "round-win",
      "payout-audio",
      "line-win",
      "symbol-audio",
      "symbol-audio",
    ]);
  });
});

describe("AppController malformed authoritative result boundary", () => {
  it("projects Big Win string money before returning its optional trace checkpoint", async () => {
    const controller = prototypeHarness();
    const onPresentationTrace = vi.fn();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const onPresentationCheckpoint = vi.fn(() => gate);
    Object.assign(controller, {
      activePresentationSequence: 42,
      presentationObserver: { onPresentationTrace, onPresentationCheckpoint },
    });

    const checkpoint = (controller as unknown as {
      observeBigWinMilestone(milestone: {
        type: "level-up";
        atMs: number;
        amountMinor: bigint;
        fromTier: "bigwin";
        toTier: "super";
        thresholdMultiplier: bigint;
        animation: "bigwin_to_super";
      }): void | Promise<void>;
    }).observeBigWinMilestone({
      type: "level-up",
      atMs: 2_500,
      amountMinor: 10_000n,
      fromTier: "bigwin",
      toTier: "super",
      thresholdMultiplier: 100n,
      animation: "bigwin_to_super",
    });

    const projectedTrace = {
      type: "big-win.level-up",
      sequence: 42,
      atMs: 2_500,
      amountMinor: "10000",
      fromTier: "bigwin",
      toTier: "super",
      thresholdMultiplier: 100n,
      animation: "bigwin_to_super",
    } as const;
    expect(onPresentationTrace).toHaveBeenCalledWith(projectedTrace);
    expect(onPresentationCheckpoint).toHaveBeenCalledWith({
      type: "presentation-trace",
      trace: projectedTrace,
    });
    let resolved = false;
    void checkpoint?.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    release();
    await checkpoint;
    expect(resolved).toBe(true);
  });

  it("delivers Big Win barriers to a checkpoint-only presentation observer", async () => {
    const controller = prototypeHarness();
    const onPresentationCheckpoint = vi.fn(async () => undefined);
    Object.assign(controller, {
      activePresentationSequence: 43,
      presentationObserver: { onPresentationCheckpoint },
    });

    await (controller as unknown as {
      observeBigWinMilestone(milestone: {
        type: "count-start";
        atMs: number;
        amountMinor: bigint;
        tier: "bigwin";
      }): void | Promise<void>;
    }).observeBigWinMilestone({
      type: "count-start",
      atMs: 500,
      amountMinor: 0n,
      tier: "bigwin",
    });

    expect(onPresentationCheckpoint).toHaveBeenCalledWith({
      type: "presentation-trace",
      trace: {
        type: "big-win.count-start",
        sequence: 43,
        atMs: 500,
        amountMinor: "0",
        tier: "bigwin",
      },
    });
  });

  it("freezes only the addressed Wild while a reveal checkpoint is observed", async () => {
    const controller = prototypeHarness();
    const setSymbolPlaybackPaused = vi.fn();
    const onPresentationTrace = vi.fn();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const onPresentationCheckpoint = vi.fn(() => gate);
    Object.assign(controller, {
      activePresentationSequence: 17,
      snapshot: {
        currentGrid: [
          [{ symbol: "ORBIT" }, { symbol: "PRISM" }, { symbol: "PULSE" }],
          [{ symbol: "NOVA" }, { symbol: "WILD", multiplier: 100 }, { symbol: "TANK" }],
          [{ symbol: "CIRCUIT" }, { symbol: "ORBIT" }, { symbol: "PRISM" }],
        ],
      },
      renderer: { reels: { setSymbolPlaybackPaused } },
      presentationObserver: { onPresentationTrace, onPresentationCheckpoint },
    });

    const pending = (controller as unknown as {
      observeWildRevealBoundary(
        phase: "pre" | "complete",
        event: {
          kind: "wild-reveal";
          cells: readonly { reel: number; row: number }[];
          delayMs: number;
          fastForward: boolean;
        },
      ): void | Promise<void>;
    }).observeWildRevealBoundary("pre", {
      kind: "wild-reveal",
      cells: [{ reel: 1, row: 1 }],
      delayMs: 1_000,
      fastForward: false,
    });
    const trace = {
      type: "wild-reveal.pre",
      sequence: 17,
      cells: [{ reel: 1, row: 1, multiplier: 100 }],
      outroMs: 1_000,
    } as const;

    expect(onPresentationTrace).toHaveBeenCalledWith(trace);
    expect(onPresentationCheckpoint).toHaveBeenCalledWith({
      type: "presentation-trace",
      trace,
    });
    expect(setSymbolPlaybackPaused).toHaveBeenCalledWith([{ reel: 1, row: 1 }], true);
    expect(setSymbolPlaybackPaused).not.toHaveBeenCalledWith([{ reel: 1, row: 1 }], false);
    const observedTrace = onPresentationTrace.mock.calls[0]?.[0];
    expect(Object.isFrozen(observedTrace)).toBe(true);
    expect(Object.isFrozen(observedTrace.cells)).toBe(true);
    expect(Object.isFrozen(observedTrace.cells[0])).toBe(true);

    release();
    await pending;
    expect(setSymbolPlaybackPaused).toHaveBeenLastCalledWith([{ reel: 1, row: 1 }], false);
  });

  it("retains and locally freezes the owning sequence for background Rage collection milestones", async () => {
    const controller = prototypeHarness();
    const setRageCollectionPresentationPaused = vi.fn();
    const onPresentationTrace = vi.fn();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstCheckpoint = true;
    const onPresentationCheckpoint = vi.fn(() => {
      if (!firstCheckpoint) return undefined;
      firstCheckpoint = false;
      return gate;
    });
    Object.assign(controller, {
      activePresentationSequence: 23,
      activeRageCollectionPresentationSequence: null,
      renderer: { setRageCollectionPresentationPaused },
      presentationObserver: { onPresentationTrace, onPresentationCheckpoint },
    });

    const observe = (controller as unknown as {
      observeRageCollectionPresentationMilestone(milestone: {
        phase: "started" | "absorbing" | "source-hidden" | "complete";
        cells: readonly { reel: number; row: number }[];
        count: number;
        triggered: boolean;
        guaranteed: boolean;
        level: number;
        total: number;
        elapsedMs: number;
        authoredAtMs: number;
        reducedMotion: boolean;
        activated: boolean;
        hidden: boolean;
        towerReactionStarted: boolean;
        bodyClip: "idle_breaker2";
        characterStarted: boolean;
      }): void;
    }).observeRageCollectionPresentationMilestone.bind(controller);
    const milestone = (
      phase: "started" | "absorbing" | "source-hidden" | "complete",
      authoredAtMs: number,
      activated: boolean,
      hidden: boolean,
      towerReactionStarted: boolean,
    ) => ({
      phase,
      cells: [{ reel: 1, row: 0 }],
      count: 1,
      triggered: false,
      guaranteed: false,
      level: 1,
      total: 1,
      elapsedMs: authoredAtMs,
      authoredAtMs,
      reducedMotion: false,
      activated,
      hidden,
      towerReactionStarted,
      bodyClip: "idle_breaker2" as const,
      characterStarted: true,
    });

    observe(milestone("started", 0, true, false, false));
    expect(setRageCollectionPresentationPaused).toHaveBeenLastCalledWith(true);
    expect(onPresentationTrace).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "rage-collect.started",
      sequence: 23,
      cells: [{ reel: 1, row: 0 }],
      count: 1,
      bodyClip: "idle_breaker2",
    }));
    const startedTrace = onPresentationTrace.mock.calls[0]?.[0];
    expect(Object.isFrozen(startedTrace)).toBe(true);
    expect(Object.isFrozen(startedTrace.cells)).toBe(true);
    expect(Object.isFrozen(startedTrace.cells[0])).toBe(true);

    release();
    await gate;
    await Promise.resolve();
    expect(setRageCollectionPresentationPaused).toHaveBeenLastCalledWith(false);

    // 权威回合可能已经完成，而原本 1.2s 的 Symbol7/轨迹生命周期仍在
    // 持续发出诊断里程碑。
    Object.assign(controller, { activePresentationSequence: null });
    observe(milestone("absorbing", 500, true, false, true));
    observe(milestone("source-hidden", 1_016.7, false, true, true));
    observe(milestone("complete", 1_200, false, true, true));

    expect(onPresentationTrace.mock.calls.map(([trace]) => [trace.type, trace.sequence]))
      .toEqual([
        ["rage-collect.started", 23],
        ["rage-collect.absorbing", 23],
        ["rage-collect.source-hidden", 23],
        ["rage-collect.complete", 23],
      ]);
    expect((controller as unknown as { activeRageCollectionPresentationSequence: number | null })
      .activeRageCollectionPresentationSequence).toBeNull();
  });

  it("retains, freezes and gates the seven Rage cascade checkpoints before Wheel handoff", async () => {
    const controller = prototypeHarness();
    const setRageCascadePresentationPaused = vi.fn();
    const onPresentationTrace = vi.fn();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstCheckpoint = true;
    const onPresentationCheckpoint = vi.fn(() => {
      if (!firstCheckpoint) return undefined;
      firstCheckpoint = false;
      return gate;
    });
    Object.assign(controller, {
      activePresentationSequence: 31,
      activeRageCascadePresentationSequence: null,
      renderer: { setRageCascadePresentationPaused },
      presentationObserver: { onPresentationTrace, onPresentationCheckpoint },
    });

    type Phase = "started" | "exploding" | "placed" | "pound"
      | "activation" | "source-hidden" | "complete";
    const observe = (controller as unknown as {
      observeRageCascadePresentationMilestone(milestone: {
        phase: Phase;
        authoredAtMs: number;
        elapsedMs: number;
        reducedMotion: boolean;
        transformedCells: readonly { reel: number; row: number }[];
        shuffledCells: readonly {
          orderIndex: number;
          cellIndex: number;
          address: { reel: number; row: number };
          transformsToRage: boolean;
          authoredAtMs: number;
          elapsedMs: number;
        }[];
        activationAttempted: number;
        activationPlayed: number;
        shakePhase: "respin" | "pound" | null;
        shakeAuthoredAtMs: number | null;
        shakeElapsedMs: number | null;
        hidden: boolean;
      }): void;
    }).observeRageCascadePresentationMilestone.bind(controller);
    const authoredAt = {
      started: 0,
      exploding: 390,
      placed: 930,
      pound: 1_430,
      activation: 1_820,
      "source-hidden": 3_986.7,
      complete: 4_120,
    } as const;
    const milestone = (phase: Phase) => ({
      phase,
      authoredAtMs: authoredAt[phase],
      elapsedMs: authoredAt[phase],
      reducedMotion: false,
      transformedCells: [{ reel: 1, row: 1 }, { reel: 2, row: 1 }],
      shuffledCells: phase === "exploding" ? [{
        orderIndex: 0,
        cellIndex: 8,
        address: { reel: 2, row: 2 },
        transformsToRage: false,
        authoredAtMs: 390,
        elapsedMs: 390,
      }] : [],
      activationAttempted: phase === "activation" || phase === "source-hidden" || phase === "complete"
        ? 3 : 0,
      activationPlayed: phase === "activation" || phase === "source-hidden" || phase === "complete"
        ? 3 : 0,
      shakePhase: phase === "exploding" ? "respin" as const
        : phase === "activation" ? "pound" as const : null,
      shakeAuthoredAtMs: phase === "exploding" ? 400
        : phase === "activation" ? 1_930 : null,
      shakeElapsedMs: phase === "exploding" ? 400
        : phase === "activation" ? 1_930 : null,
      hidden: phase === "source-hidden" || phase === "complete",
    });

    observe(milestone("started"));
    expect(setRageCascadePresentationPaused).toHaveBeenLastCalledWith(true);
    const startedTrace = onPresentationTrace.mock.calls[0]?.[0];
    expect(startedTrace).toMatchObject({ type: "rage-cascade.started", sequence: 31 });
    expect(Object.isFrozen(startedTrace)).toBe(true);
    expect(Object.isFrozen(startedTrace.transformedCells)).toBe(true);
    expect(Object.isFrozen(startedTrace.transformedCells[0])).toBe(true);

    release();
    await gate;
    await Promise.resolve();
    expect(setRageCascadePresentationPaused).toHaveBeenLastCalledWith(false);

    Object.assign(controller, { activePresentationSequence: null });
    for (const phase of [
      "exploding", "placed", "pound", "activation", "source-hidden", "complete",
    ] as const) observe(milestone(phase));

    expect(onPresentationTrace.mock.calls.map(([trace]) => [trace.type, trace.sequence]))
      .toEqual([
        ["rage-cascade.started", 31],
        ["rage-cascade.exploding", 31],
        ["rage-cascade.placed", 31],
        ["rage-cascade.pound", 31],
        ["rage-cascade.activation", 31],
        ["rage-cascade.source-hidden", 31],
        ["rage-cascade.complete", 31],
      ]);
    const explodingTrace = onPresentationTrace.mock.calls[1]?.[0];
    expect(Object.isFrozen(explodingTrace.shuffledCells)).toBe(true);
    expect(Object.isFrozen(explodingTrace.shuffledCells[0])).toBe(true);
    expect(Object.isFrozen(explodingTrace.shuffledCells[0].address)).toBe(true);
    expect((controller as unknown as { activeRageCascadePresentationSequence: number | null })
      .activeRageCascadePresentationSequence).toBeNull();
  });

  it("does not accept or trace an unsolicited result", () => {
    const controller = createRoundHarness();
    const onPresentationTrace = vi.fn();
    Object.assign(controller, {
      presentationObserver: { onPresentationTrace },
    });
    (controller as unknown as { machine: { phase: string } }).machine.phase = "ready";

    controller.handleSpinResult(roundResult());

    expect(onPresentationTrace).not.toHaveBeenCalled();
    expect((controller as unknown as { ui: { showError: ReturnType<typeof vi.fn> } })
      .ui.showError).toHaveBeenCalledWith(SAFE_RESULT_ERROR);
  });

  it("fails before presentation, authored audio, balance mutation, or milestones", () => {
    const controller = createRoundHarness();
    const enqueuePresentation = vi.fn();
    const onPresentationMilestone = vi.fn();
    const onRoundPresentationState = vi.fn();
    const onPresentationTrace = vi.fn();
    Object.assign(controller, {
      presentations: { enqueue: enqueuePresentation },
      presentationObserver: {
        onPresentationMilestone,
        onRoundPresentationState,
        onPresentationTrace,
      },
    });
    const balanceBefore = controller.snapshot.balanceMinor;
    const featureStateBefore = controller.snapshot.featureState;

    controller.handleSpinResult(roundResult({
      wins: [],
      totalWinMinor: "0",
      balanceMinor: "9999",
      grid: guaranteedRageGrid(),
      events: [
        GUARANTEED_RAGE_EVENT,
        { type: "wheel.started" },
        {
          // 运行时防御：解码后的 Feature Wheel 奖励绝不能持有钱款。
          type: "wheel.awarded",
          outcome: "EXPANSION",
          prize: "KONG_QUEST",
          amountMinor: "1000",
        },
        { type: "free_spins.started", mode: "EXPANSION", awarded: 8 },
      ],
      featureState: {
        mode: "EXPANSION",
        freeSpinsRemaining: 8,
        freeSpinsPlayed: 0,
        baseBetMinor: "100",
        freeSpinsWinMinor: "0",
        rageLevel: 1,
        rageCollected: 0,
      },
    } as unknown as SpinResult));

    const ui = (controller as unknown as {
      ui: {
        applyResult: ReturnType<typeof vi.fn>;
        showError: ReturnType<typeof vi.fn>;
      };
    }).ui;
    const renderer = controller.renderer as {
      reconcileReelRows: ReturnType<typeof vi.fn>;
      finishSpinPresentation: ReturnType<typeof vi.fn>;
    };
    const machine = controller as unknown as {
      machine: { transition: ReturnType<typeof vi.fn> };
    };

    expect(enqueuePresentation).not.toHaveBeenCalled();
    expect(renderer.reconcileReelRows).not.toHaveBeenCalled();
    expect(renderer.finishSpinPresentation).not.toHaveBeenCalled();
    for (const audioCall of Object.values(controller.audio)) {
      expect(audioCall).not.toHaveBeenCalled();
    }
    expect(ui.applyResult).not.toHaveBeenCalled();
    expect(controller.snapshot.balanceMinor).toBe(balanceBefore);
    expect(controller.snapshot.featureState).toBe(featureStateBefore);
    expect(onPresentationMilestone).not.toHaveBeenCalled();
    expect(onPresentationTrace).not.toHaveBeenCalled();
    expect(onRoundPresentationState).toHaveBeenCalledTimes(1);
    expect(onRoundPresentationState).toHaveBeenCalledWith("failed");
    expect(ui.showError).toHaveBeenCalledWith(SAFE_RESULT_ERROR);
    expect(machine.machine.transition).toHaveBeenCalledWith({ type: "SPIN_FAILED" });
  });

  it("rejects a discontinuous King Spin Vault chain before any observable commit", () => {
    const previous: FeatureState = {
      mode: "OVERDRIVE",
      freeSpinsRemaining: 2,
      freeSpinsPlayed: 6,
      baseBetMinor: "100",
      freeSpinsWinMinor: "0",
      rageLevel: 1,
      rageCollected: 0,
    };
    const controller = createRoundHarness(previous);
    const enqueuePresentation = vi.fn();
    const onPresentationMilestone = vi.fn();
    const onRoundPresentationState = vi.fn();
    Object.assign(controller, {
      presentations: { enqueue: enqueuePresentation },
      presentationObserver: { onPresentationMilestone, onRoundPresentationState },
    });
    const balanceBefore = controller.snapshot.balanceMinor;
    const featureStateBefore = controller.snapshot.featureState;
    const cells = [{ reel: 1, row: 1 }] as const;

    controller.handleSpinResult(roundResult({
      chargedBetMinor: "0",
      balanceMinor: "9999",
      totalWinMinor: "2000",
      wins: [],
      grid: BASE_GRID.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
        reelIndex === 1 && rowIndex === 1
          ? { symbol: "VAULT" as const, prize: "MINI_2X", multiplier: 20 }
          : cell
      ))),
      events: [
        { type: "vaults.landed", count: 1, cells },
        { type: "vaults.unlock.started", count: 1, cells },
        { type: "vault.unlocked", reel: 1, row: 1, prize: "MINI", multiplier: 10 },
        { type: "vaults.unlock.completed", count: 1, cells },
        { type: "vaults.upgrade.started", count: 1, step: 1 },
        {
          type: "vault.upgraded", reel: 1, row: 1, step: 1,
          fromMultiplier: 9, toMultiplier: 20, prize: "MINI_2X",
        },
        {
          type: "vault.awarded", reel: 1, row: 1,
          prize: "MINI_2X", multiplier: 20, amountMinor: "2000",
        },
      ],
      featureState: {
        ...previous,
        freeSpinsRemaining: 1,
        freeSpinsPlayed: 7,
        freeSpinsWinMinor: "2000",
      },
    }));

    const ui = (controller as unknown as {
      ui: { applyResult: ReturnType<typeof vi.fn>; showError: ReturnType<typeof vi.fn> };
    }).ui;
    const renderer = controller.renderer as {
      reconcileReelRows: ReturnType<typeof vi.fn>;
      finishSpinPresentation: ReturnType<typeof vi.fn>;
    };
    expect(enqueuePresentation).not.toHaveBeenCalled();
    expect(renderer.reconcileReelRows).not.toHaveBeenCalled();
    expect(renderer.finishSpinPresentation).not.toHaveBeenCalled();
    for (const audioCall of Object.values(controller.audio)) expect(audioCall).not.toHaveBeenCalled();
    expect(ui.applyResult).not.toHaveBeenCalled();
    expect(controller.snapshot.balanceMinor).toBe(balanceBefore);
    expect(controller.snapshot.featureState).toBe(featureStateBefore);
    expect(onPresentationMilestone).not.toHaveBeenCalled();
    expect(onRoundPresentationState).toHaveBeenCalledWith("failed");
    expect(ui.showError).toHaveBeenCalledWith(SAFE_RESULT_ERROR);
  });
});
