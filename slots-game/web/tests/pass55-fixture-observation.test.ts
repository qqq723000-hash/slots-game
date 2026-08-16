import { describe, expect, it } from "vitest";
import type {
  CharacterIntroLifecycleDiagnostics,
  CharacterTrackDiagnostic,
  WheelChestPoundCaptureDiagnostics,
} from "../src/renderer/intro/LaunchScene";
import appController from "../src/app/AppController.ts?raw";
import featureEffects from "../src/renderer/FeatureEffects.ts?raw";
import pixiRenderer from "../src/renderer/PixiRenderer.ts?raw";
import fixtureMain from "../src/testing/visualFixturesMain.ts?raw";
import {
  clearPass55WheelChestCapture,
  isPass55WheelChestCapture,
  PASS55_WHEEL_CHEST_MIX_COMPLETE_CHECKPOINT,
  PASS55_WHEEL_CHEST_PRE_REENTRY_CHECKPOINT,
  PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT,
  PASS55_WHEEL_CHEST_SECOND_REENTRY_CHECKPOINT,
  pass55WheelChestCaptureEnvironmentViolation,
  pass55WheelChestCheckpointElapsedMs,
  publishPass55WheelChestCheckpoint,
  resolveVisualFixtureSemanticCheckpoint,
  type Pass55WheelChestCaptureDiagnostics,
  type Pass55WheelChestCheckpoint,
  type VisualFixtureDataset,
} from "../src/testing/visualFixtureObservation";

const SCENARIO = "wheel-mini-flow";
const CAPTURE = "1";
const RUN = "pass55";
const CHECKPOINTS = Object.freeze([
  PASS55_WHEEL_CHEST_PRE_REENTRY_CHECKPOINT,
  PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT,
  PASS55_WHEEL_CHEST_MIX_COMPLETE_CHECKPOINT,
  PASS55_WHEEL_CHEST_SECOND_REENTRY_CHECKPOINT,
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

function emptyTrack(track: number): Readonly<CharacterTrackDiagnostic> {
  return Object.freeze({
    track,
    animation: null,
    trackTime: null,
    mixingFrom: null,
    mixDuration: null,
  });
}

function checkpointState(checkpoint: Pass55WheelChestCheckpoint): Readonly<{
  taskElapsedMs: number;
  entryOrdinal: number;
  reentryCount: number;
  trackTime: number;
  mixingFrom: string | null;
}> {
  if (checkpoint === PASS55_WHEEL_CHEST_PRE_REENTRY_CHECKPOINT) {
    return Object.freeze({
      taskElapsedMs: 3_800,
      entryOrdinal: 1,
      reentryCount: 0,
      trackTime: 3.8,
      mixingFrom: null,
    });
  }
  if (checkpoint === PASS55_WHEEL_CHEST_MIX_COMPLETE_CHECKPOINT) {
    return Object.freeze({
      taskElapsedMs: 150,
      entryOrdinal: 2,
      reentryCount: 1,
      trackTime: 0.15,
      mixingFrom: null,
    });
  }
  const second = checkpoint === PASS55_WHEEL_CHEST_SECOND_REENTRY_CHECKPOINT;
  return Object.freeze({
    taskElapsedMs: 0,
    entryOrdinal: second ? 3 : 2,
    reentryCount: second ? 2 : 1,
    trackTime: 0,
    mixingFrom: "chest_pound",
  });
}

function diagnostics(
  checkpoint: Pass55WheelChestCheckpoint,
  overrides: Partial<Pass55WheelChestCaptureDiagnostics> = {},
): Readonly<Pass55WheelChestCaptureDiagnostics> {
  const expected = checkpointState(checkpoint);
  const body = Object.freeze<CharacterTrackDiagnostic>({
    track: 1,
    animation: "chest_pound",
    trackTime: expected.trackTime,
    mixingFrom: expected.mixingFrom,
    mixDuration: 0.15,
  });
  const tracks = Object.freeze([
    emptyTrack(0),
    body,
    emptyTrack(2),
    emptyTrack(3),
    emptyTrack(4),
  ]);
  const targetSpinElapsedMs = pass55WheelChestCheckpointElapsedMs(checkpoint);
  const task = Object.freeze<WheelChestPoundCaptureDiagnostics>({
    schedulerFps: 30,
    flooredTaskMs: 3_833,
    taskTicks: 115,
    periodMs: 115_000 / 30,
    targetSpinElapsedMs,
    taskElapsedMs: expected.taskElapsedMs,
    entryOrdinal: expected.entryOrdinal,
    reentryCount: expected.reentryCount,
    schedulerActive: true,
    generation: expected.entryOrdinal,
    ownerIsCurrent: true,
    nonBodyTrackIdentityPreserved: true,
    tracks,
  });
  return Object.freeze({
    checkpoint,
    targetSpinElapsedMs,
    sequence: 1,
    roundState: "presenting",
    fastPlay: false,
    reducedMotion: false,
    task,
    bodyTrack: body,
    tracks,
    lifecycle: lifecycle(),
    milestoneHistory: Object.freeze([
      "wheel.popup-input-ready",
      "wheel.input-ready",
      "wheel.spin-start",
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
    fixtureWheelChestReducedMotion: "false",
    fixtureWheelChestFastPlay: "false",
    fixtureVisualFailureCount: "0",
    fixtureSequence: "1",
  };
}

function diagnosticsWithTask(
  checkpoint: Pass55WheelChestCheckpoint,
  overrides: Partial<WheelChestPoundCaptureDiagnostics>,
): Readonly<Pass55WheelChestCaptureDiagnostics> {
  const base = diagnostics(checkpoint);
  return Object.freeze({
    ...base,
    task: Object.freeze({ ...base.task, ...overrides }),
  });
}

function diagnosticsWithBody(
  checkpoint: Pass55WheelChestCheckpoint,
  overrides: Partial<CharacterTrackDiagnostic>,
): Readonly<Pass55WheelChestCaptureDiagnostics> {
  const base = diagnostics(checkpoint);
  const bodyTrack = Object.freeze({ ...base.bodyTrack!, ...overrides });
  const tracks = Object.freeze(base.tracks.map((track, index) => (
    index === 1 ? bodyTrack : track
  )));
  const task = Object.freeze({ ...base.task, tracks });
  return Object.freeze({ ...base, bodyTrack, tracks, task });
}

describe("Pass55 Wheel FEATURE_CHEST_LOOP fixture route", () => {
  it.each(CHECKPOINTS)("allow-lists only exact %s capture routes", (checkpoint) => {
    expect(isPass55WheelChestCapture(SCENARIO, CAPTURE, checkpoint, RUN)).toBe(true);
    expect(resolveVisualFixtureSemanticCheckpoint(SCENARIO, CAPTURE, checkpoint))
      .toBe(checkpoint);
    expect(isPass55WheelChestCapture(SCENARIO, CAPTURE, checkpoint, "pass54")).toBe(false);
    expect(isPass55WheelChestCapture(SCENARIO, "true", checkpoint, RUN)).toBe(false);
    expect(isPass55WheelChestCapture("king-flow", CAPTURE, checkpoint, RUN)).toBe(false);
    expect(isPass55WheelChestCapture(SCENARIO, CAPTURE, "wheel.chest-loop-start", RUN))
      .toBe(false);
  });

  it("uses the exact 30fps rational boundaries, not rounded millisecond aliases", () => {
    expect(pass55WheelChestCheckpointElapsedMs(
      PASS55_WHEEL_CHEST_PRE_REENTRY_CHECKPOINT,
    )).toBe(3_800);
    expect(pass55WheelChestCheckpointElapsedMs(PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT))
      .toBe(115_000 / 30);
    expect(pass55WheelChestCheckpointElapsedMs(
      PASS55_WHEEL_CHEST_MIX_COMPLETE_CHECKPOINT,
    )).toBe(115_000 / 30 + 150);
    expect(pass55WheelChestCheckpointElapsedMs(
      PASS55_WHEEL_CHEST_SECOND_REENTRY_CHECKPOINT,
    )).toBe(230_000 / 30);
    expect(pass55WheelChestCheckpointElapsedMs(PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT))
      .not.toBe(3_833);
  });

  it("rejects reduced-motion and FASTPLAY only on otherwise exact routes", () => {
    expect(pass55WheelChestCaptureEnvironmentViolation(
      SCENARIO, CAPTURE, PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT, RUN, false, false,
    )).toBeNull();
    expect(pass55WheelChestCaptureEnvironmentViolation(
      SCENARIO, CAPTURE, PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT, RUN, true, false,
    )).toBe("wheel-chest-reduced-motion-not-canonical");
    expect(pass55WheelChestCaptureEnvironmentViolation(
      SCENARIO, CAPTURE, PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT, RUN, false, true,
    )).toBe("wheel-chest-fast-play-not-canonical");
    expect(pass55WheelChestCaptureEnvironmentViolation(
      SCENARIO, CAPTURE, PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT, "production", true, true,
    )).toBeNull();
  });
});

describe("Pass55 Wheel FEATURE_CHEST_LOOP fixture diagnostics", () => {
  it.each(CHECKPOINTS)("publishes the immutable exact %s contract", (checkpoint) => {
    const body = dataset();
    const facts = diagnostics(checkpoint);
    expect(publishPass55WheelChestCheckpoint(
      body, SCENARIO, CAPTURE, checkpoint, RUN, facts,
    )).toBeNull();
    expect(body).toMatchObject({
      fixtureWheelChestCheckpoint: checkpoint,
      fixtureWheelChestElapsedMs: String(pass55WheelChestCheckpointElapsedMs(checkpoint)),
      fixtureWheelChestDiagnostics: JSON.stringify(facts),
      fixtureWheelChestContract: "ok",
      fixtureWheelChestReducedMotion: "false",
      fixtureWheelChestFastPlay: "false",
    });
    expect(body.fixtureWheelChestViolation).toBeUndefined();
  });

  it.each([
    [
      "wheel-chest-clock-contract",
      diagnostics(PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT, { sequence: 2 }),
    ],
    [
      "wheel-chest-track-set-contract",
      Object.freeze({
        ...diagnostics(PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT),
        bodyTrack: diagnostics(PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT).tracks[0] ?? null,
      }),
    ],
    [
      "wheel-chest-lifecycle-contract",
      diagnostics(PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT, {
        lifecycle: Object.freeze({ ...lifecycle(), capturePaused: false }),
      }),
    ],
    [
      "wheel-chest-task-contract",
      diagnosticsWithTask(PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT, { taskTicks: 114 }),
    ],
    [
      "wheel-chest-body-contract",
      diagnosticsWithBody(PASS55_WHEEL_CHEST_MIX_COMPLETE_CHECKPOINT, {
        mixingFrom: "chest_pound",
      }),
    ],
    [
      "wheel-chest-milestone-contract",
      diagnostics(PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT, {
        milestoneHistory: Object.freeze(["wheel.spin-start", "wheel.spin-finish"]),
      }),
    ],
    [
      "wheel-chest-environment-contract",
      diagnostics(PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT, { fastPlay: true }),
    ],
    [
      "wheel-chest-visual-contract",
      diagnostics(PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT, { visualFailureCount: 1 }),
    ],
    [
      "wheel-chest-award-contract",
      diagnostics(PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT, { totalWinMinor: "0" }),
    ],
  ] as const)("rejects %s", (expected, facts) => {
    const body = dataset();
    expect(publishPass55WheelChestCheckpoint(
      body, SCENARIO, CAPTURE, facts.checkpoint, RUN, facts,
    )).toBe(expected);
    expect(body.fixtureWheelChestViolation).toBe(expected);
    expect(body.fixtureTraceViolation).toBe(expected);
    expect(body.fixtureWheelChestCheckpoint).toBeUndefined();
    expect(body.fixtureWheelChestDiagnostics).toBeUndefined();
  });

  it("keeps the first accepted observation immutable on duplicate publish", () => {
    const body = dataset();
    const firstCheckpoint = PASS55_WHEEL_CHEST_PRE_REENTRY_CHECKPOINT;
    const first = diagnostics(firstCheckpoint);
    expect(publishPass55WheelChestCheckpoint(
      body, SCENARIO, CAPTURE, firstCheckpoint, RUN, first,
    )).toBeNull();
    const firstJson = body.fixtureWheelChestDiagnostics;

    expect(publishPass55WheelChestCheckpoint(
      body,
      SCENARIO,
      CAPTURE,
      PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT,
      RUN,
      diagnostics(PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT),
    )).toBe("wheel-chest-duplicate-publish");
    expect(body.fixtureWheelChestCheckpoint).toBe(firstCheckpoint);
    expect(body.fixtureWheelChestContract).toBe("ok");
    expect(body.fixtureWheelChestDiagnostics).toBe(firstJson);
  });

  it("rejects mutable evidence and does not project near-miss routes", () => {
    const body = dataset();
    const mutable = { ...diagnostics(PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT) };
    expect(publishPass55WheelChestCheckpoint(
      body,
      SCENARIO,
      CAPTURE,
      PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT,
      RUN,
      mutable,
    )).toBe("wheel-chest-diagnostics-mutable");

    const nearMiss = dataset();
    expect(publishPass55WheelChestCheckpoint(
      nearMiss,
      SCENARIO,
      CAPTURE,
      PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT,
      "production",
      diagnostics(PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT),
    )).toBeNull();
    expect(nearMiss.fixtureWheelChestDiagnostics).toBeUndefined();
  });

  it("clears every Pass55-only projection", () => {
    const body = dataset();
    const checkpoint = PASS55_WHEEL_CHEST_REENTRY_CHECKPOINT;
    expect(publishPass55WheelChestCheckpoint(
      body, SCENARIO, CAPTURE, checkpoint, RUN, diagnostics(checkpoint),
    )).toBeNull();
    clearPass55WheelChestCapture(body);
    expect(Object.keys(body).filter((key) => key.startsWith("fixtureWheelChest")))
      .toEqual([]);
  });

  it("binds the synchronous S0 barrier to pause, exact step, paint, hold, and cleanup", () => {
    const checkpointHandler = fixtureMain.indexOf("onPresentationCheckpoint:");
    const startGuard = fixtureMain.indexOf(
      'checkpoint.state === "wheel.chest-loop-start"',
      checkpointHandler,
    );
    const capture = fixtureMain.indexOf("const capturePass55WheelChest =");
    const sequenceGuard = fixtureMain.indexOf("if (sequence !== 1)", capture);
    const pause = fixtureMain.indexOf("app.setCharacterIntroCapturePaused(true)", capture);
    const step = fixtureMain.indexOf(
      "app.advanceWheelChestPoundCapture(targetSpinElapsedMs)",
      pause,
    );
    const hold = fixtureMain.indexOf("pass55WheelChestCheckpoint,\n      60_000", step);
    const firstPaint = fixtureMain.indexOf("window.requestAnimationFrame", hold);
    const secondPaint = fixtureMain.indexOf("window.requestAnimationFrame", firstPaint + 1);
    const ready = fixtureMain.indexOf('body.dataset.fixtureStatus = "ready"', secondPaint);
    const returnedHold = fixtureMain.indexOf("return captureHoldPromise", ready);

    expect(startGuard).toBeGreaterThan(checkpointHandler);
    expect(fixtureMain.slice(startGuard, startGuard + 280))
      .toContain("return capturePass55WheelChest(checkpoint.sequence)");
    expect(sequenceGuard).toBeGreaterThan(capture);
    expect(sequenceGuard).toBeLessThan(pause);
    expect(pause).toBeGreaterThan(capture);
    expect(step).toBeGreaterThan(pause);
    expect(hold).toBeGreaterThan(step);
    expect(firstPaint).toBeGreaterThan(hold);
    expect(secondPaint).toBeGreaterThan(firstPaint);
    expect(ready).toBeGreaterThan(secondPaint);
    expect(returnedHold).toBeGreaterThan(ready);
    expect(fixtureMain).toContain("clearPass55PaintGate()");
    expect(fixtureMain).toContain("clearPass55WheelChestCapture(body.dataset)");
  });

  it("forwards one post-install semantic barrier without changing production", () => {
    const effectsStart = featureEffects.indexOf('interaction.state = "spinning"');
    const startHook = featureEffects.indexOf("this.hooks.onWheelSpinStart?.()", effectsStart);
    const checkpoint = featureEffects.indexOf(
      "this.hooks.onWheelSpinStartCheckpoint",
      startHook,
    );
    const resolve = featureEffects.indexOf("interaction.resolveContinue()", checkpoint);
    expect(startHook).toBeGreaterThan(effectsStart);
    expect(checkpoint).toBeGreaterThan(startHook);
    expect(resolve).toBeGreaterThan(checkpoint);
    expect(featureEffects.slice(checkpoint, resolve + 80)).toContain("else");

    const pixiStart = pixiRenderer.indexOf("onWheelSpinStart: () =>");
    const milestone = pixiRenderer.indexOf('"wheel.spin-start"', pixiStart);
    const pixiCheckpoint = pixiRenderer.indexOf("onWheelSpinStartCheckpoint", milestone);
    expect(pixiCheckpoint).toBeGreaterThan(milestone);
    expect(pixiRenderer.slice(pixiCheckpoint, pixiCheckpoint + 220))
      .toContain('"wheel.chest-loop-start"');
    expect(pixiRenderer).toContain("advanceWheelChestPoundCapture(elapsedMs: number)");
    expect(pixiRenderer).toContain("getWheelChestPoundDiagnostics()");
    expect(appController).toContain("advanceWheelChestPoundCapture(elapsedMs: number)");
    expect(appController).toContain("getWheelChestPoundDiagnostics()");
    expect(appController).toContain("getWheelChestPoundCaptureEnvironmentDiagnostics()");
  });
});
