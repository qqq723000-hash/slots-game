import { describe, expect, it } from "vitest";
import type { FeatureState } from "../src/app/state/types";
import type { CharacterTrackDiagnostic } from "../src/renderer/intro/LaunchScene";
import fixtureMain from "../src/testing/visualFixturesMain.ts?raw";
import {
  clearPass50CharacterIntroCapture,
  isPass50CharacterIntroCapture,
  PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT,
  PASS50_CHARACTER_INTRO_LOOP_ENTERED_CHECKPOINT,
  publishPass50CharacterIntroCheckpoint,
  resolveVisualFixtureSemanticCheckpoint,
  type Pass50CharacterIntroCaptureDiagnostics,
  type VisualFixtureDataset,
} from "../src/testing/visualFixtureObservation";

const SCENARIO = "base-launch-level-two-intro";
const CAPTURE = "1";
const RUN = "pass50";
const STATE = Object.freeze({
  mode: "BASE",
  freeSpinsRemaining: 0,
  rageLevel: 2,
  rageCollected: 12,
} as const satisfies FeatureState);

function tracks(
  body: "intro" | "idle",
  auraTime: number,
  mixingFrom: string | null,
): readonly Readonly<CharacterTrackDiagnostic>[] {
  return Object.freeze([
    Object.freeze({ track: 0, animation: null, trackTime: null, mixingFrom: null }),
    Object.freeze({
      track: 1,
      animation: body,
      trackTime: body === "intro" ? 5 : 0,
      mixingFrom,
    }),
    Object.freeze({ track: 2, animation: "aura_2", trackTime: auraTime, mixingFrom: null }),
    Object.freeze({
      track: 3,
      animation: "particles_loop",
      trackTime: auraTime + 0.1,
      mixingFrom: null,
    }),
    Object.freeze({ track: 4, animation: null, trackTime: null, mixingFrom: null }),
  ]);
}

function dataset(overrides: VisualFixtureDataset = {}): VisualFixtureDataset {
  return {
    fixtureRoundState: "idle",
    fixtureVisualFailureCount: "0",
    fixtureVisualMissingRequired: "",
    ...overrides,
  };
}

function launchReadyDiagnostics(
  overrides: Partial<Pass50CharacterIntroCaptureDiagnostics> = {},
): Pass50CharacterIntroCaptureDiagnostics {
  return {
    launchReady: true,
    roundState: "idle",
    state: STATE,
    spinRequestCount: 0,
    roundDeliveryCount: 0,
    featureEventCount: 0,
    tracks: tracks("intro", 0.3, null),
    lifecycle: {
      introActive: true,
      introElapsedMs: 5_000,
      taskDurationMs: 8_066,
      timelineControlled: false,
      bodyReleased: false,
      auraReleased: true,
      idleSchedulerActive: false,
      capturePaused: true,
    },
    ...overrides,
  };
}

function loopDiagnostics(
  overrides: Partial<Pass50CharacterIntroCaptureDiagnostics> = {},
): Pass50CharacterIntroCaptureDiagnostics {
  return {
    launchReady: true,
    roundState: "idle",
    state: STATE,
    spinRequestCount: 0,
    roundDeliveryCount: 0,
    featureEventCount: 0,
    tracks: tracks("idle", 3.37, "intro"),
    lifecycle: {
      introActive: false,
      introElapsedMs: 8_066,
      taskDurationMs: 8_066,
      timelineControlled: false,
      bodyReleased: true,
      auraReleased: true,
      idleSchedulerActive: true,
      capturePaused: true,
    },
    ...overrides,
  };
}

describe("Pass50 visual fixture entry contract", () => {
  it("activates only the exact scenario/capture/checkpoint/run tuple", () => {
    expect(isPass50CharacterIntroCapture(
      SCENARIO,
      CAPTURE,
      PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT,
      RUN,
    )).toBe(true);
    expect(isPass50CharacterIntroCapture(
      `${SCENARIO}-extra`,
      CAPTURE,
      PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT,
      RUN,
    )).toBe(false);
    expect(isPass50CharacterIntroCapture(
      SCENARIO,
      "true",
      PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT,
      RUN,
    )).toBe(false);
    expect(isPass50CharacterIntroCapture(
      SCENARIO,
      CAPTURE,
      PASS50_CHARACTER_INTRO_LOOP_ENTERED_CHECKPOINT,
      RUN,
    )).toBe(false);
    expect(isPass50CharacterIntroCapture(
      SCENARIO,
      CAPTURE,
      PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT,
      `${RUN}-extra`,
    )).toBe(false);
    expect(resolveVisualFixtureSemanticCheckpoint(
      SCENARIO,
      CAPTURE,
      PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT,
    )).toBe(PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT);
  });

  it("uses a zero-round gateway and synchronously pauses at launch ready", () => {
    expect(fixtureMain).toContain("isPass50CharacterIntroCapture(");
    expect(fixtureMain).toContain("run,");
    expect(fixtureMain).toContain("app.setCharacterIntroCapturePaused(true)");
    expect(fixtureMain).toContain("holdPass50LaunchReady();");
    expect(fixtureMain).toContain("window.setInterval(observeLoopEntry, 4)");
    expect(fixtureMain).toContain('bodyTrack.mixingFrom === "intro"');
    expect(fixtureMain).toContain("character-intro-loop-timeout");
    expect(fixtureMain).toContain("clearPass50LoopObservation();");
  });
});

describe("Pass50 character INTRO lifecycle checkpoints", () => {
  it("publishes the held ~5000ms INTRO pose and the first LOOP mixing frame", () => {
    const body = dataset();
    const first = launchReadyDiagnostics();
    expect(publishPass50CharacterIntroCheckpoint(
      body,
      SCENARIO,
      CAPTURE,
      PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT,
      RUN,
      PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT,
      first,
    )).toBeNull();
    expect(body).toMatchObject({
      fixtureCharacterIntroCheckpoint: PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT,
      fixtureCharacterIntroLaunchReady: "true",
      fixtureCharacterIntroRoundState: "idle",
      fixtureCharacterIntroSpinRequestCount: "0",
      fixtureCharacterIntroRoundDeliveryCount: "0",
      fixtureCharacterIntroFeatureEventCount: "0",
      fixtureCharacterIntroLifecycle: JSON.stringify(first.lifecycle),
      fixtureCharacterIntroTracks: JSON.stringify(first.tracks),
      fixtureCharacterIntroState: JSON.stringify(STATE),
    });

    const second = loopDiagnostics();
    expect(publishPass50CharacterIntroCheckpoint(
      body,
      SCENARIO,
      CAPTURE,
      PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT,
      RUN,
      PASS50_CHARACTER_INTRO_LOOP_ENTERED_CHECKPOINT,
      second,
      first,
    )).toBeNull();
    expect(body).toMatchObject({
      fixtureCharacterIntroCheckpoint: PASS50_CHARACTER_INTRO_LOOP_ENTERED_CHECKPOINT,
      fixtureCharacterIntroLoopEntered: "true",
      fixtureCharacterIntroAuraAdvanced: "true",
    });
    expect(JSON.parse(body.fixtureCharacterIntroDiagnostics ?? "null")).toEqual({
      checkpoint: PASS50_CHARACTER_INTRO_LOOP_ENTERED_CHECKPOINT,
      state: STATE,
      roundState: "idle",
      spinRequestCount: 0,
      roundDeliveryCount: 0,
      featureEventCount: 0,
      lifecycle: second.lifecycle,
      tracks: second.tracks,
    });
    expect(body.fixtureCharacterIntroViolation).toBeUndefined();
  });

  it("fails closed on gameplay, a wrong handoff, or restarted aura tracks", () => {
    const cases: readonly [string, Pass50CharacterIntroCaptureDiagnostics,
      Pass50CharacterIntroCaptureDiagnostics | null][] = [
      [
        "character-intro-gameplay-observed",
        launchReadyDiagnostics({ spinRequestCount: 1 }),
        null,
      ],
      [
        "character-intro-launch-ready-contract",
        launchReadyDiagnostics({
          tracks: tracks("intro", 0.3, "hidden"),
        }),
        null,
      ],
      [
        "character-intro-loop-entered-contract",
        loopDiagnostics({ tracks: tracks("idle", 0.01, "intro") }),
        launchReadyDiagnostics(),
      ],
    ];

    for (const [expected, facts, first] of cases) {
      const body = dataset();
      const checkpoint = first
        ? PASS50_CHARACTER_INTRO_LOOP_ENTERED_CHECKPOINT
        : PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT;
      expect(publishPass50CharacterIntroCheckpoint(
        body,
        SCENARIO,
        CAPTURE,
        PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT,
        RUN,
        checkpoint,
        facts,
        first,
      )).toBe(expected);
      expect(body.fixtureCharacterIntroViolation).toBe(expected);
      expect(body.fixtureTraceViolation).toBe(expected);
      expect(body.fixtureCharacterIntroCheckpoint).toBeUndefined();
    }
  });

  it("does not mutate datasets for near-miss routes and clears capture projections", () => {
    const body = dataset();
    expect(publishPass50CharacterIntroCheckpoint(
      body,
      SCENARIO,
      CAPTURE,
      PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT,
      "pass51",
      PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT,
      launchReadyDiagnostics(),
    )).toBeNull();
    expect(body.fixtureCharacterIntroDiagnostics).toBeUndefined();

    expect(publishPass50CharacterIntroCheckpoint(
      body,
      SCENARIO,
      CAPTURE,
      PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT,
      RUN,
      PASS50_CHARACTER_INTRO_LAUNCH_READY_CHECKPOINT,
      launchReadyDiagnostics(),
    )).toBeNull();
    clearPass50CharacterIntroCapture(body);
    expect(Object.keys(body).filter((key) => key.startsWith("fixtureCharacterIntro")))
      .toEqual([]);
  });
});
