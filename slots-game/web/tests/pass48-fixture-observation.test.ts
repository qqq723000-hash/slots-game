import { describe, expect, it } from "vitest";
import type { AppPresentationTrace } from "../src/app/AppController";
import type { FeatureEvent, FeatureState } from "../src/app/state/types";
import type { CharacterTrackDiagnostic } from "../src/renderer/intro/LaunchScene";
import fixtureMain from "../src/testing/visualFixturesMain.ts?raw";
import {
  applyVisualFixtureFeatureEvent,
  applyVisualFixtureTrace,
  isPass48RageAuraCapture,
  publishPass48RageAuraCheckpoint,
  type Pass48RageAuraCheckpointDiagnostics,
  type VisualFixtureDataset,
} from "../src/testing/visualFixtureObservation";

const SCENARIO = "base-rage-level-two-persistent-aura";
const STATE = Object.freeze({
  mode: "BASE",
  freeSpinsRemaining: 0,
  rageLevel: 2,
  rageCollected: 12,
} as const satisfies FeatureState);

function tracks(offset = 0): readonly Readonly<CharacterTrackDiagnostic>[] {
  return Object.freeze([
    Object.freeze({ track: 0, animation: null, trackTime: null, mixingFrom: null }),
    Object.freeze({ track: 1, animation: "idle", trackTime: 1.25 + offset, mixingFrom: null }),
    Object.freeze({ track: 2, animation: "aura_2", trackTime: 2.5 + offset, mixingFrom: null }),
    Object.freeze({
      track: 3,
      animation: "particles_loop",
      trackTime: 3.75 + offset,
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

function diagnostics(
  overrides: Partial<Pass48RageAuraCheckpointDiagnostics> = {},
): Pass48RageAuraCheckpointDiagnostics {
  return {
    launchReady: true,
    neutralCharacterReady: true,
    roundComplete: false,
    state: STATE,
    tracks: tracks(),
    ...overrides,
  };
}

describe("Pass48 visual fixture entry contract", () => {
  it("conditions only the exact capture and reads state plus live character diagnostics", () => {
    expect(fixtureMain).toContain('"base-rage-level-two-persistent-aura"');
    expect(fixtureMain).toContain("isPass48RageAuraCapture(scenario, capture)");
    expect(fixtureMain).toContain("observeFixtureFeatureStates");
    expect(fixtureMain).toContain("session.featureState");
    expect(fixtureMain).toContain("result.featureState");
    expect(fixtureMain).toContain("app.prepareNeutralCharacterCapture()");
    expect(fixtureMain).toContain("app.getCharacterCaptureDiagnostics()");
    expect(fixtureMain).toContain('"rage-aura.session-restored"');
    expect(fixtureMain).toContain('"rage-aura.inter-round-preserved"');
    expect(fixtureMain).toContain("publishPass48RageAuraCheckpoint");
    expect(fixtureMain).not.toContain("setCharacterAuraLevel(");
    expect(fixtureMain).not.toContain("clearTrack(");
    expect(fixtureMain).not.toContain("trackTime =");
  });

  it("allow-lists only the exact Pass48 capture route", () => {
    expect(isPass48RageAuraCapture(SCENARIO, "1")).toBe(true);
    expect(isPass48RageAuraCapture(SCENARIO, null)).toBe(false);
    expect(isPass48RageAuraCapture(SCENARIO, "true")).toBe(false);
    expect(isPass48RageAuraCapture(`${SCENARIO}-extra`, "1")).toBe(false);
  });
});

describe("Pass48 Rage-aura checkpoint diagnostics", () => {
  it("publishes exact restored and inter-round states while treating track times as evidence only", () => {
    const body = dataset();
    expect(publishPass48RageAuraCheckpoint(
      body,
      SCENARIO,
      "1",
      "rage-aura.session-restored",
      diagnostics(),
    )).toBeNull();
    expect(body).toMatchObject({
      fixtureRageAuraCheckpoint: "rage-aura.session-restored",
      fixtureRageAuraSessionRestored: "true",
      fixtureRageAuraFeatureEventCount: "0",
      fixtureRageAuraState: JSON.stringify(STATE),
      fixtureCharacterTracks: JSON.stringify(tracks()),
    });

    body.fixtureRoundState = "complete";
    body.fixtureRageAuraRoundAcceptedCount = "1";
    body.fixtureCompleteCount = "1";
    const laterTracks = tracks(47.25);
    expect(publishPass48RageAuraCheckpoint(
      body,
      SCENARIO,
      "1",
      "rage-aura.inter-round-preserved",
      diagnostics({ roundComplete: true, tracks: laterTracks }),
    )).toBeNull();
    expect(body).toMatchObject({
      fixtureRageAuraCheckpoint: "rage-aura.inter-round-preserved",
      fixtureRageAuraInterRoundPreserved: "true",
      fixtureRageAuraState: JSON.stringify(STATE),
      fixtureCharacterTracks: JSON.stringify(laterTracks),
    });
    expect(body.fixtureRageAuraViolation).toBeUndefined();
  });

  it("fails closed on readiness, state, track, event, visual, or round diagnostics", () => {
    const cases = [
      {
        expected: "rage-aura-capture-not-ready",
        body: dataset(),
        facts: diagnostics({ launchReady: false }),
      },
      {
        expected: "rage-aura-state-contract",
        body: dataset(),
        facts: diagnostics({ state: { ...STATE, rageCollected: 11 } }),
      },
      {
        expected: "rage-aura-track-contract",
        body: dataset(),
        facts: diagnostics({
          tracks: tracks().map((entry) => (
            entry.track === 2 ? { ...entry, animation: "aura_1" } : entry
          )),
        }),
      },
      {
        expected: "rage-aura-unexpected-feature-event",
        body: dataset({ fixtureRageAuraFeatureEventCount: "1" }),
        facts: diagnostics(),
      },
      {
        expected: "rage-aura-visual-failure",
        body: dataset({ fixtureVisualFailureCount: "1" }),
        facts: diagnostics(),
      },
    ] as const;

    for (const testCase of cases) {
      expect(publishPass48RageAuraCheckpoint(
        testCase.body,
        SCENARIO,
        "1",
        "rage-aura.session-restored",
        testCase.facts,
      )).toBe(testCase.expected);
      expect(testCase.body.fixtureRageAuraViolation).toBe(testCase.expected);
      expect(testCase.body.fixtureRageAuraCheckpoint).toBeUndefined();
    }

    const incomplete = dataset({
      fixtureRageAuraRoundAcceptedCount: "1",
      fixtureCompleteCount: "0",
    });
    expect(publishPass48RageAuraCheckpoint(
      incomplete,
      SCENARIO,
      "1",
      "rage-aura.inter-round-preserved",
      diagnostics({ roundComplete: false }),
    )).toBe("rage-aura-round-incomplete");

    const inert = dataset();
    expect(publishPass48RageAuraCheckpoint(
      inert,
      "base-two-rage-no-wheel",
      "1",
      "rage-aura.session-restored",
      diagnostics(),
    )).toBeNull();
    expect(inert.fixtureRageAuraState).toBeUndefined();
  });

  it("accepts one ordinary result and rejects feature events or feature presentation traces", () => {
    const body = dataset({ fixtureRageAuraFeatureEventCount: "0" });
    const accepted: AppPresentationTrace = {
      type: "result.accepted",
      sequence: 1,
      roundId: "round-generated-by-controller",
      totalWinMinor: "0",
      balanceMinor: "99900",
      winCount: 0,
    };
    expect(applyVisualFixtureTrace(body, accepted, SCENARIO)).toBe(false);
    expect(applyVisualFixtureTrace(body, {
      type: "reels.settled",
      sequence: 1,
    }, SCENARIO)).toBe(false);
    expect(applyVisualFixtureTrace(body, {
      type: "balance.committed",
      sequence: 1,
      balanceMinor: "99900",
    }, SCENARIO)).toBe(false);
    expect(applyVisualFixtureTrace(body, {
      type: "round.complete",
      sequence: 1,
    }, SCENARIO)).toBe(false);
    expect(body).toMatchObject({
      fixtureRageAuraRoundAcceptedCount: "1",
      fixtureCompleteCount: "1",
    });

    const eventBody = dataset({ fixtureRageAuraFeatureEventCount: "0" });
    const event = {
      type: "surge.collected",
      count: 1,
      cells: [{ reel: 0, row: 0 }],
      triggered: false,
      guaranteed: false,
      level: 2,
      total: 13,
    } as const satisfies FeatureEvent;
    expect(applyVisualFixtureFeatureEvent(
      eventBody,
      event.type,
      event,
      SCENARIO,
    )).toBe(true);
    expect(eventBody.fixtureRageAuraFeatureEventCount).toBe("1");
    expect(eventBody.fixtureRageAuraViolation)
      .toBe("rage-aura-unexpected-feature-event");

    const malformedEventBody = dataset({ fixtureRageAuraFeatureEventCount: "0" });
    expect(applyVisualFixtureFeatureEvent(
      malformedEventBody,
      "wheel.started",
      undefined,
      SCENARIO,
    )).toBe(true);
    expect(malformedEventBody.fixtureRageAuraFeatureEventCount).toBe("1");
    const noEventBody = dataset({ fixtureRageAuraFeatureEventCount: "0" });
    expect(applyVisualFixtureFeatureEvent(
      noEventBody,
      null,
      null,
      SCENARIO,
    )).toBe(false);
    expect(noEventBody.fixtureRageAuraFeatureEventCount).toBe("0");

    const traceBody = dataset({ fixtureRageAuraFeatureEventCount: "0" });
    expect(applyVisualFixtureTrace(traceBody, accepted, SCENARIO)).toBe(false);
    expect(applyVisualFixtureTrace(traceBody, {
      type: "rage-collect.started",
      sequence: 1,
    } as unknown as AppPresentationTrace, SCENARIO)).toBe(true);
    expect(traceBody.fixtureRageAuraViolation)
      .toBe("rage-aura-unexpected-presentation-trace");
  });
});
