import { describe, expect, it } from "vitest";
import type { AppPresentationCheckpoint } from "../src/app/AppController";
import type {
  CharacterIntroLifecycleDiagnostics,
  CharacterTrackDiagnostic,
} from "../src/renderer/intro/LaunchScene";
import fixtureMain from "../src/testing/visualFixturesMain.ts?raw";
import {
  clearPass53CharacterWinCapture,
  isPass53CharacterWinCapture,
  matchVisualFixtureSemanticCheckpoint,
  PASS53_CHARACTER_WIN_HANDOFF_CHECKPOINT,
  PASS53_CHARACTER_WIN_MIX_COMPLETE_CHECKPOINT,
  PASS53_CHARACTER_WIN_PRE_HANDOFF_CHECKPOINT,
  pass53CharacterWinCaptureEnvironmentViolation,
  pass53CharacterWinCheckpointElapsedMs,
  publishPass53CharacterWinCheckpoint,
  resolveVisualFixtureSemanticCheckpoint,
  type Pass53CharacterWinCaptureDiagnostics,
  type Pass53CharacterWinCheckpoint,
  type VisualFixtureDataset,
} from "../src/testing/visualFixtureObservation";

const SCENARIO = "normal-win-continue";
const CAPTURE = "1";
const RUN = "pass53";
const CHECKPOINTS = Object.freeze([
  PASS53_CHARACTER_WIN_PRE_HANDOFF_CHECKPOINT,
  PASS53_CHARACTER_WIN_HANDOFF_CHECKPOINT,
  PASS53_CHARACTER_WIN_MIX_COMPLETE_CHECKPOINT,
] as const);

function lifecycle(idleSchedulerActive: boolean): Readonly<CharacterIntroLifecycleDiagnostics> {
  return Object.freeze({
    introActive: false,
    introElapsedMs: 8_066,
    taskDurationMs: 8_066,
    timelineControlled: false,
    bodyReleased: true,
    auraReleased: true,
    idleSchedulerActive,
    capturePaused: true,
  });
}

function diagnostics(
  checkpoint: Pass53CharacterWinCheckpoint,
  overrides: Partial<Pass53CharacterWinCaptureDiagnostics> = {},
): Readonly<Pass53CharacterWinCaptureDiagnostics> {
  const preHandoff = checkpoint === PASS53_CHARACTER_WIN_PRE_HANDOFF_CHECKPOINT;
  const handoff = checkpoint === PASS53_CHARACTER_WIN_HANDOFF_CHECKPOINT;
  const body = Object.freeze<CharacterTrackDiagnostic>({
    track: 1,
    animation: preHandoff ? "win" : "idle",
    trackTime: preHandoff ? 1.499 : handoff ? 0 : 0.15,
    mixingFrom: handoff ? "win" : null,
    mixDuration: 0.15,
  });
  const tracks = Object.freeze([
    Object.freeze<CharacterTrackDiagnostic>({
      track: 0, animation: null, trackTime: null, mixingFrom: null, mixDuration: null,
    }),
    body,
    Object.freeze<CharacterTrackDiagnostic>({
      track: 2, animation: null, trackTime: null, mixingFrom: null, mixDuration: null,
    }),
    Object.freeze<CharacterTrackDiagnostic>({
      track: 3, animation: null, trackTime: null, mixingFrom: null, mixDuration: null,
    }),
    Object.freeze<CharacterTrackDiagnostic>({
      track: 4, animation: null, trackTime: null, mixingFrom: null, mixDuration: null,
    }),
  ]);
  return Object.freeze({
    checkpoint,
    elapsedMs: pass53CharacterWinCheckpointElapsedMs(checkpoint),
    sequence: 1,
    roundState: "presenting",
    bodyTrack: body,
    tracks,
    lifecycle: lifecycle(!preHandoff),
    ...overrides,
  });
}

function dataset(): VisualFixtureDataset {
  return { fixtureCharacterWinReducedMotion: "false" };
}

function diagnosticsWithBody(
  checkpoint: Pass53CharacterWinCheckpoint,
  bodyOverrides: Partial<CharacterTrackDiagnostic>,
): Readonly<Pass53CharacterWinCaptureDiagnostics> {
  const base = diagnostics(checkpoint);
  const bodyTrack = Object.freeze({ ...base.bodyTrack!, ...bodyOverrides });
  const tracks = Object.freeze(base.tracks.map((track, index) => (
    index === 1 ? bodyTrack : track
  )));
  return Object.freeze({ ...base, bodyTrack, tracks });
}

describe("Pass53 Base WIN fixture route", () => {
  it.each(CHECKPOINTS)("allow-lists only the exact %s capture tuple", (checkpoint) => {
    expect(isPass53CharacterWinCapture(SCENARIO, CAPTURE, checkpoint, RUN)).toBe(true);
    expect(resolveVisualFixtureSemanticCheckpoint(SCENARIO, CAPTURE, checkpoint))
      .toBe(checkpoint);
    expect(isPass53CharacterWinCapture(SCENARIO, CAPTURE, checkpoint, "pass54")).toBe(false);
    expect(isPass53CharacterWinCapture(SCENARIO, "true", checkpoint, RUN)).toBe(false);
    expect(isPass53CharacterWinCapture("big-win", CAPTURE, checkpoint, RUN)).toBe(false);
  });

  it("keeps the legacy normal-win matcher exclusive to hide-start", () => {
    const hideStart = {
      type: "presentation-trace",
      trace: {
        type: "win-record.hide-start",
        sequence: 1,
        index: 0,
        count: 2,
        id: "continue-prism-wild-x5-four-boxes",
        symbol: "PRISM",
        amountMinor: "500",
        multiplier: 5,
      },
    } as AppPresentationCheckpoint;
    expect(matchVisualFixtureSemanticCheckpoint(
      SCENARIO, CAPTURE, "normal-win.hide-start", hideStart,
    )).toBe("normal-win.hide-start");
    for (const checkpoint of CHECKPOINTS) {
      expect(matchVisualFixtureSemanticCheckpoint(
        SCENARIO, CAPTURE, checkpoint, hideStart,
      )).toBeNull();
    }
  });

  it("fails closed for reduced motion only on the exact Pass53 route", () => {
    expect(pass53CharacterWinCaptureEnvironmentViolation(
      SCENARIO, CAPTURE, PASS53_CHARACTER_WIN_HANDOFF_CHECKPOINT, RUN, false,
    )).toBeNull();
    expect(pass53CharacterWinCaptureEnvironmentViolation(
      SCENARIO, CAPTURE, PASS53_CHARACTER_WIN_HANDOFF_CHECKPOINT, RUN, true,
    )).toBe("character-win-reduced-motion-not-canonical");
    expect(pass53CharacterWinCaptureEnvironmentViolation(
      SCENARIO, CAPTURE, PASS53_CHARACTER_WIN_HANDOFF_CHECKPOINT, "pass54", true,
    )).toBeNull();
  });
});

describe("Pass53 Base WIN fixture diagnostics", () => {
  it.each(CHECKPOINTS)("publishes the exact %s contract", (checkpoint) => {
    const body = dataset();
    const facts = diagnostics(checkpoint);
    expect(publishPass53CharacterWinCheckpoint(
      body,
      SCENARIO,
      CAPTURE,
      checkpoint,
      RUN,
      facts,
    )).toBeNull();
    expect(body).toMatchObject({
      fixtureCharacterWinCheckpoint: checkpoint,
      fixtureCharacterWinElapsedMs: String(pass53CharacterWinCheckpointElapsedMs(checkpoint)),
      fixtureCharacterWinDiagnostics: JSON.stringify(facts),
      fixtureCharacterWinContract: "ok",
      fixtureCharacterWinReducedMotion: "false",
    });
    expect(body.fixtureCharacterWinViolation).toBeUndefined();
    expect(JSON.parse(body.fixtureCharacterWinDiagnostics ?? "null")).toEqual(facts);
  });

  it.each([
    [
      "character-win-clock-contract",
      diagnostics(PASS53_CHARACTER_WIN_PRE_HANDOFF_CHECKPOINT, { sequence: 2 }),
    ],
    [
      "character-win-lifecycle-contract",
      diagnostics(PASS53_CHARACTER_WIN_HANDOFF_CHECKPOINT, {
        lifecycle: Object.freeze({ ...lifecycle(true), capturePaused: false }),
      }),
    ],
    [
      "character-win-body-contract",
      diagnosticsWithBody(PASS53_CHARACTER_WIN_MIX_COMPLETE_CHECKPOINT, {
        mixingFrom: "win",
      }),
    ],
  ] as const)("rejects %s", (expected, facts) => {
    const body = dataset();
    expect(publishPass53CharacterWinCheckpoint(
      body,
      SCENARIO,
      CAPTURE,
      facts.checkpoint,
      RUN,
      facts,
    )).toBe(expected);
    expect(body.fixtureCharacterWinViolation).toBe(expected);
    expect(body.fixtureTraceViolation).toBe(expected);
    expect(body.fixtureCharacterWinContract).toBeUndefined();
    expect(body.fixtureCharacterWinCheckpoint).toBeUndefined();
  });

  it("does not mutate near-miss routes and clears every Pass53 projection", () => {
    const body = dataset();
    const facts = diagnostics(PASS53_CHARACTER_WIN_HANDOFF_CHECKPOINT);
    expect(publishPass53CharacterWinCheckpoint(
      body,
      SCENARIO,
      CAPTURE,
      facts.checkpoint,
      "pass54",
      facts,
    )).toBeNull();
    expect(body.fixtureCharacterWinDiagnostics).toBeUndefined();

    expect(publishPass53CharacterWinCheckpoint(
      body,
      SCENARIO,
      CAPTURE,
      facts.checkpoint,
      RUN,
      facts,
    )).toBeNull();
    clearPass53CharacterWinCapture(body);
    expect(Object.keys(body).filter((key) => key.startsWith("fixtureCharacterWin")))
      .toEqual([]);
  });

  it("binds T0 to counter.started, exact stepping, a 60s hold, and teardown cleanup", () => {
    expect(fixtureMain).toContain('trace.type === "counter.started"');
    expect(fixtureMain).toContain("在 reactToWin 安装了 Track 1 WIN 之后");
    expect(fixtureMain).toContain("app.setCharacterIntroCapturePaused(true)");
    expect(fixtureMain).toContain("app.advanceBaseWinCharacterCapture(elapsedMs)");
    expect(fixtureMain).toContain("publishPass53CharacterWinCheckpoint(");
    expect(fixtureMain).toContain("pass53CharacterWinCheckpoint,\n      60_000");
    expect(fixtureMain).toContain("clearPass53CharacterWinCapture(body.dataset)");
  });
});
