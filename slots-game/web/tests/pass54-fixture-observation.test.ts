import { describe, expect, it } from "vitest";
import type {
  CharacterIntroLifecycleDiagnostics,
  CharacterTrackDiagnostic,
} from "../src/renderer/intro/LaunchScene";
import fixtureMain from "../src/testing/visualFixturesMain.ts?raw";
import {
  clearPass54WheelCharacterCapture,
  isPass54WheelCharacterCapture,
  PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT,
  PASS54_WHEEL_CHARACTER_MIX_COMPLETE_CHECKPOINT,
  PASS54_WHEEL_CHARACTER_PRE_HANDOFF_CHECKPOINT,
  pass54WheelCharacterCaptureEnvironmentViolation,
  pass54WheelCharacterCheckpointElapsedMs,
  publishPass54WheelCharacterCheckpoint,
  resolveVisualFixtureSemanticCheckpoint,
  type Pass54WheelCharacterCaptureDiagnostics,
  type Pass54WheelCharacterCheckpoint,
  type VisualFixtureDataset,
} from "../src/testing/visualFixtureObservation";

const SCENARIO = "wheel-mini-flow";
const CAPTURE = "1";
const RUN = "pass54";
const CHECKPOINTS = Object.freeze([
  PASS54_WHEEL_CHARACTER_PRE_HANDOFF_CHECKPOINT,
  PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT,
  PASS54_WHEEL_CHARACTER_MIX_COMPLETE_CHECKPOINT,
] as const);

function lifecycle(): Readonly<CharacterIntroLifecycleDiagnostics> {
  return Object.freeze({
    introActive: false,
    introElapsedMs: 8_066,
    taskDurationMs: 8_066,
    timelineControlled: false,
    bodyReleased: true,
    auraReleased: true,
    idleSchedulerActive: false,
    capturePaused: true,
  });
}

function diagnostics(
  checkpoint: Pass54WheelCharacterCheckpoint,
  overrides: Partial<Pass54WheelCharacterCaptureDiagnostics> = {},
): Readonly<Pass54WheelCharacterCaptureDiagnostics> {
  const preHandoff = checkpoint === PASS54_WHEEL_CHARACTER_PRE_HANDOFF_CHECKPOINT;
  const handoff = checkpoint === PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT;
  const body = Object.freeze<CharacterTrackDiagnostic>({
    track: 1,
    animation: preHandoff ? "win" : "feature_idle",
    trackTime: preHandoff ? 1.499 : handoff ? 0 : 0.15,
    mixingFrom: handoff ? "win" : null,
    mixDuration: 0.15,
  });
  const emptyTrack = (track: number): Readonly<CharacterTrackDiagnostic> => Object.freeze({
    track,
    animation: null,
    trackTime: null,
    mixingFrom: null,
    mixDuration: null,
  });
  const tracks = Object.freeze([
    emptyTrack(0),
    body,
    emptyTrack(2),
    emptyTrack(3),
    emptyTrack(4),
  ]);
  return Object.freeze({
    checkpoint,
    elapsedMs: pass54WheelCharacterCheckpointElapsedMs(checkpoint),
    sequence: 1,
    roundState: "presenting",
    bodyTrack: body,
    tracks,
    lifecycle: lifecycle(),
    milestoneHistory: Object.freeze([
      "wheel.popup-input-ready",
      "wheel.input-ready",
      "wheel.spin-start",
      "wheel.spin-finish",
    ]),
    visualFailureCount: 0,
    featureEvent: "wheel.awarded",
    totalWinMinor: "1200",
    balanceMinor: "101100",
    ...overrides,
  });
}

function dataset(): VisualFixtureDataset {
  return {
    fixtureWheelCharacterReducedMotion: "false",
    fixtureVisualFailureCount: "0",
    fixtureSequence: "1",
  };
}

function diagnosticsWithBody(
  checkpoint: Pass54WheelCharacterCheckpoint,
  bodyOverrides: Partial<CharacterTrackDiagnostic>,
): Readonly<Pass54WheelCharacterCaptureDiagnostics> {
  const base = diagnostics(checkpoint);
  const bodyTrack = Object.freeze({ ...base.bodyTrack!, ...bodyOverrides });
  const tracks = Object.freeze(base.tracks.map((track, index) => (
    index === 1 ? bodyTrack : track
  )));
  return Object.freeze({ ...base, bodyTrack, tracks });
}

describe("Pass54 Wheel Character fixture route", () => {
  it.each(CHECKPOINTS)("allow-lists only the exact %s capture tuple", (checkpoint) => {
    expect(isPass54WheelCharacterCapture(SCENARIO, CAPTURE, checkpoint, RUN)).toBe(true);
    expect(resolveVisualFixtureSemanticCheckpoint(SCENARIO, CAPTURE, checkpoint))
      .toBe(checkpoint);
    expect(isPass54WheelCharacterCapture(SCENARIO, CAPTURE, checkpoint, "pass53")).toBe(false);
    expect(isPass54WheelCharacterCapture(SCENARIO, "true", checkpoint, RUN)).toBe(false);
    expect(isPass54WheelCharacterCapture("king-flow", CAPTURE, checkpoint, RUN)).toBe(false);
    expect(isPass54WheelCharacterCapture(SCENARIO, CAPTURE, "wheel.landing", RUN)).toBe(false);
  });

  it("rejects reduced motion only for an otherwise exact Pass54 route", () => {
    expect(pass54WheelCharacterCaptureEnvironmentViolation(
      SCENARIO, CAPTURE, PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT, RUN, false,
    )).toBeNull();
    expect(pass54WheelCharacterCaptureEnvironmentViolation(
      SCENARIO, CAPTURE, PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT, RUN, true,
    )).toBe("wheel-character-reduced-motion-not-canonical");
    expect(pass54WheelCharacterCaptureEnvironmentViolation(
      SCENARIO, CAPTURE, PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT, "pass53", true,
    )).toBeNull();
  });
});

describe("Pass54 Wheel Character fixture diagnostics", () => {
  it.each(CHECKPOINTS)("publishes the exact %s contract", (checkpoint) => {
    const body = dataset();
    const facts = diagnostics(checkpoint);
    expect(publishPass54WheelCharacterCheckpoint(
      body,
      SCENARIO,
      CAPTURE,
      checkpoint,
      RUN,
      facts,
    )).toBeNull();
    expect(body).toMatchObject({
      fixtureWheelCharacterCheckpoint: checkpoint,
      fixtureWheelCharacterElapsedMs: String(
        pass54WheelCharacterCheckpointElapsedMs(checkpoint),
      ),
      fixtureWheelCharacterDiagnostics: JSON.stringify(facts),
      fixtureWheelCharacterContract: "ok",
      fixtureWheelCharacterReducedMotion: "false",
    });
    expect(body.fixtureWheelCharacterViolation).toBeUndefined();
  });

  it.each([
    [
      "wheel-character-clock-contract",
      diagnostics(PASS54_WHEEL_CHARACTER_PRE_HANDOFF_CHECKPOINT, { sequence: 2 }),
    ],
    [
      "wheel-character-lifecycle-contract",
      diagnostics(PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT, {
        lifecycle: Object.freeze({ ...lifecycle(), capturePaused: false }),
      }),
    ],
    [
      "wheel-character-body-contract",
      diagnosticsWithBody(PASS54_WHEEL_CHARACTER_MIX_COMPLETE_CHECKPOINT, {
        mixingFrom: "win",
      }),
    ],
    [
      "wheel-character-milestone-contract",
      diagnostics(PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT, {
        milestoneHistory: Object.freeze([
          "wheel.spin-start",
          "wheel.quick-stop",
          "wheel.spin-finish",
        ]),
      }),
    ],
    [
      "wheel-character-visual-contract",
      diagnostics(PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT, { visualFailureCount: 1 }),
    ],
    [
      "wheel-character-award-contract",
      diagnostics(PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT, { totalWinMinor: "0" }),
    ],
  ] as const)("rejects %s", (expected, facts) => {
    const body = dataset();
    expect(publishPass54WheelCharacterCheckpoint(
      body,
      SCENARIO,
      CAPTURE,
      facts.checkpoint,
      RUN,
      facts,
    )).toBe(expected);
    expect(body.fixtureWheelCharacterViolation).toBe(expected);
    expect(body.fixtureTraceViolation).toBe(expected);
    expect(body.fixtureWheelCharacterCheckpoint).toBeUndefined();
  });

  it("rejects mutable diagnostics and leaves near-miss routes untouched", () => {
    const mutable = { ...diagnostics(PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT) };
    const body = dataset();
    expect(publishPass54WheelCharacterCheckpoint(
      body,
      SCENARIO,
      CAPTURE,
      PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT,
      RUN,
      mutable,
    )).toBe("wheel-character-diagnostics-mutable");

    const nearMiss = dataset();
    expect(publishPass54WheelCharacterCheckpoint(
      nearMiss,
      SCENARIO,
      CAPTURE,
      PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT,
      "production",
      diagnostics(PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT),
    )).toBeNull();
    expect(nearMiss.fixtureWheelCharacterDiagnostics).toBeUndefined();
  });

  it("clears every Pass54-only projection", () => {
    const body = dataset();
    const checkpoint = PASS54_WHEEL_CHARACTER_HANDOFF_CHECKPOINT;
    expect(publishPass54WheelCharacterCheckpoint(
      body,
      SCENARIO,
      CAPTURE,
      checkpoint,
      RUN,
      diagnostics(checkpoint),
    )).toBeNull();
    clearPass54WheelCharacterCapture(body);
    expect(Object.keys(body).filter((key) => key.startsWith("fixtureWheelCharacter")))
      .toEqual([]);
  });

  it("binds the synchronous landing seam to pause, exact step, hold, and cleanup", () => {
    const checkpointHandler = fixtureMain.indexOf("onPresentationCheckpoint:");
    const landingGuard = fixtureMain.indexOf('checkpoint.state === "wheel.landing"', checkpointHandler);
    const capture = fixtureMain.indexOf("const capturePass54WheelCharacter =");
    const pause = fixtureMain.indexOf("app.setCharacterIntroCapturePaused(true)", capture);
    const step = fixtureMain.indexOf("app.advanceWheelWinFeatureCharacterCapture(elapsedMs)", pause);
    const hold = fixtureMain.indexOf("pass54WheelCharacterCheckpoint,\n      60_000", step);
    const returnedHold = fixtureMain.indexOf("return captureHoldPromise", hold);
    expect(checkpointHandler).toBeGreaterThanOrEqual(0);
    expect(landingGuard).toBeGreaterThan(checkpointHandler);
    expect(fixtureMain.slice(landingGuard, landingGuard + 250))
      .toContain("return capturePass54WheelCharacter(checkpoint.sequence)");
    expect(capture).toBeGreaterThanOrEqual(0);
    expect(pause).toBeGreaterThan(capture);
    expect(step).toBeGreaterThan(pause);
    expect(hold).toBeGreaterThan(step);
    expect(returnedHold).toBeGreaterThan(hold);
    expect(fixtureMain).toContain("clearPass54WheelCharacterCapture(body.dataset)");
  });
});
