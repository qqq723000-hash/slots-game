import { describe, expect, it } from "vitest";
import type {
  AppPresentationCheckpoint,
  AppPresentationTrace,
  RageCollectionPresentationTrace,
} from "../src/app/AppController";
import type { FeatureState } from "../src/app/state/types";
import type { CharacterTrackDiagnostic } from "../src/renderer/intro/LaunchScene";
import fixtureMain from "../src/testing/visualFixturesMain.ts?raw";
import {
  applyPass49RecoveredAcknowledgement,
  applyPass49RecoveredRoundPresentationState,
  applyPass49RecoveredUserSpinRequest,
  applyVisualFixtureFeatureEvent,
  applyVisualFixtureTrace,
  isPass49RecoveredLevelUpCapture,
  matchVisualFixtureSemanticCheckpoint,
  publishPass49RecoveredResultAccepted,
  publishPass49RecoveredRoundComplete,
  resolveVisualFixtureSemanticCheckpoint,
  validatePass49RecoveredSemanticCheckpoint,
  type Pass49RecoveredCaptureDiagnostics,
  type Pass49RecoveredGatewayFacts,
  type VisualFixtureDataset,
} from "../src/testing/visualFixtureObservation";

const SCENARIO = "base-rgs-recovered-level-up";
const ORIGIN = Object.freeze({
  mode: "BASE",
  freeSpinsRemaining: 0,
  freeSpinsPlayed: 0,
  rageLevel: 1,
  rageCollected: 11,
} as const satisfies FeatureState);
const FINAL = Object.freeze({
  mode: "BASE",
  freeSpinsRemaining: 0,
  freeSpinsPlayed: 0,
  rageLevel: 2,
  rageCollected: 12,
} as const satisfies FeatureState);

function tracks(
  names: readonly (string | null)[],
  offset = 0,
): readonly Readonly<CharacterTrackDiagnostic>[] {
  return Object.freeze(names.map((animation, track) => Object.freeze({
    track,
    animation,
    trackTime: animation === null ? null : track + 0.25 + offset,
    mixingFrom: null,
  })));
}

const RESULT_TRACKS = tracks([null, "intro", null, null, null]);
const STARTED_TRACKS = tracks([
  "rage_collect",
  "idle_breaker2",
  "aura_2",
  "particles_loop",
  null,
]);

function body(overrides: VisualFixtureDataset = {}): VisualFixtureDataset {
  return {
    fixtureRoundState: "idle",
    fixtureVisualFailureCount: "0",
    fixtureVisualMissingRequired: "",
    ...overrides,
  };
}

function deliveryFacts(
  overrides: Partial<Pass49RecoveredGatewayFacts> = {},
): Pass49RecoveredGatewayFacts {
  return {
    pendingAtSession: true,
    pendingAtResult: true,
    deliveredBeforeLaunch: true,
    deliveryCount: 1,
    gatewayAcknowledgementCount: 0,
    acknowledgementAttemptCount: 0,
    acknowledgementAcceptedCount: 0,
    userSpinRequestCount: 0,
    pending: true,
    deliveredRoundId: "fixture-rgs-recovered-level-up",
    deliveredSequence: 1,
    originState: ORIGIN,
    finalState: FINAL,
    ...overrides,
  };
}

function diagnostics(
  roundState: Pass49RecoveredCaptureDiagnostics["roundState"],
  captureTracks: readonly Readonly<CharacterTrackDiagnostic>[],
  gateway: Pass49RecoveredGatewayFacts = deliveryFacts(),
  overrides: Partial<Pass49RecoveredCaptureDiagnostics> = {},
): Pass49RecoveredCaptureDiagnostics {
  return {
    launchReady: true,
    roundState,
    gateway,
    state: FINAL,
    tracks: captureTracks,
    ...overrides,
  };
}

const ACCEPTED: AppPresentationTrace = {
  type: "result.accepted",
  sequence: 1,
  roundId: "fixture-rgs-recovered-level-up",
  totalWinMinor: "0",
  balanceMinor: "99900",
  winCount: 0,
};

function collectTrace(
  phase: RageCollectionPresentationTrace["type"],
): RageCollectionPresentationTrace {
  const authoredAtMs = phase === "rage-collect.started"
    ? 0
    : phase === "rage-collect.absorbing"
      ? 500
      : phase === "rage-collect.source-hidden"
        ? 1_016.7
        : 1_200;
  return {
    type: phase,
    sequence: 1,
    cells: [{ reel: 1, row: 0 }],
    count: 1,
    triggered: false,
    guaranteed: false,
    level: 2,
    total: 12,
    elapsedMs: authoredAtMs,
    authoredAtMs,
    reducedMotion: false,
    activated: phase === "rage-collect.started" || phase === "rage-collect.absorbing",
    hidden: phase === "rage-collect.source-hidden" || phase === "rage-collect.complete",
    towerReactionStarted: phase !== "rage-collect.started",
    bodyClip: "idle_breaker2",
    characterStarted: true,
  };
}

function advanceToStarted(dataset: VisualFixtureDataset): void {
  expect(applyPass49RecoveredRoundPresentationState(
    dataset, SCENARIO, "1", "requested",
  )).toBeNull();
  dataset.fixtureRoundState = "requested";
  expect(applyVisualFixtureTrace(dataset, ACCEPTED, SCENARIO)).toBe(false);
  expect(publishPass49RecoveredResultAccepted(
    dataset,
    SCENARIO,
    "1",
    diagnostics("requested", RESULT_TRACKS),
  )).toBeNull();
  expect(applyPass49RecoveredRoundPresentationState(
    dataset, SCENARIO, "1", "presenting",
  )).toBeNull();
  dataset.fixtureRoundState = "presenting";
  expect(applyVisualFixtureFeatureEvent(
    dataset,
    "surge.collected",
    {
      type: "surge.collected",
      count: 1,
      cells: [{ reel: 1, row: 0 }],
      triggered: false,
      guaranteed: false,
      level: 2,
      total: 12,
    },
    SCENARIO,
  )).toBe(false);
  expect(applyVisualFixtureTrace(
    dataset,
    collectTrace("rage-collect.started"),
    SCENARIO,
  )).toBe(false);
}

describe("Pass49 recovered fixture route", () => {
  it("uses the durable decorator only for the exact recovered scenario", () => {
    expect(isPass49RecoveredLevelUpCapture(SCENARIO, "1")).toBe(true);
    expect(isPass49RecoveredLevelUpCapture(SCENARIO, null)).toBe(false);
    expect(isPass49RecoveredLevelUpCapture(`${SCENARIO}-extra`, "1")).toBe(false);
    expect(fixtureMain).toContain("createRecoveredVisualFixtureGateway(() => launchReady)");
    expect(fixtureMain).toContain("scenario === RECOVERED_LEVEL_UP_VISUAL_FIXTURE_SCENARIO");
    expect(fixtureMain).toContain("fixtureGateway.acknowledgeSpinResult");
    expect(fixtureMain).toContain("observed.acknowledgeSpinResult");
    expect(fixtureMain).not.toContain("acknowledgeSpinResult: () => true");
    expect(fixtureMain).toContain("pass49UserSpinRequestCount += 1");
  });

  it("allow-lists only the started semantic hold and rejects near misses", () => {
    expect(resolveVisualFixtureSemanticCheckpoint(
      SCENARIO, "1", "rage-collect.started",
    )).toBe("rage-collect.started");
    expect(resolveVisualFixtureSemanticCheckpoint(
      SCENARIO, "1", "rage-collect.absorbing",
    )).toBeNull();

    const exact: AppPresentationCheckpoint = {
      type: "presentation-trace",
      trace: collectTrace("rage-collect.started"),
    };
    expect(matchVisualFixtureSemanticCheckpoint(
      SCENARIO, "1", "rage-collect.started", exact,
    )).toBe("rage-collect.started");
    expect(matchVisualFixtureSemanticCheckpoint(
      SCENARIO,
      "1",
      "rage-collect.started",
      {
        type: "presentation-trace",
        trace: { ...collectTrace("rage-collect.started"), total: 11 },
      },
    )).toBeNull();
  });
});

describe("Pass49 recovered presentation diagnostics", () => {
  it("projects delivery, origin/final state, authored collect tracks and post-presentation ACK", () => {
    const dataset = body();
    advanceToStarted(dataset);

    expect(validatePass49RecoveredSemanticCheckpoint(
      dataset,
      SCENARIO,
      "1",
      "rage-collect.started",
      diagnostics("presenting", STARTED_TRACKS),
    )).toBeNull();
    expect(dataset).toMatchObject({
      fixtureRgsRecoveredPendingAtSession: "true",
      fixtureRgsRecoveredPendingAtResult: "true",
      fixtureRgsRecoveredDeliveredBeforeLaunch: "true",
      fixtureRgsRecoveredDeliveryCount: "1",
      fixtureRgsRecoveredOriginState: JSON.stringify(ORIGIN),
      fixtureRgsRecoveredFinalState: JSON.stringify(FINAL),
      fixtureRgsRecoveredAcceptedCount: "1",
      fixtureRgsRecoveredFeatureEventHistory: "surge.collected",
      fixtureRgsRecoveredFeatureEventCount: "1",
      fixtureRgsRecoveredCheckpoint: "rage-collect.started",
      fixtureRgsRecoveredTracks: JSON.stringify(STARTED_TRACKS),
    });

    expect(applyVisualFixtureTrace(dataset, {
      type: "balance.committed",
      sequence: 1,
      balanceMinor: "99900",
    }, SCENARIO)).toBe(false);
    const acknowledged = deliveryFacts({
      gatewayAcknowledgementCount: 1,
      acknowledgementAttemptCount: 1,
      acknowledgementAcceptedCount: 1,
      pending: false,
    });
    expect(applyPass49RecoveredAcknowledgement(
      dataset,
      SCENARIO,
      "1",
      diagnostics("presenting", STARTED_TRACKS, acknowledged),
      "fixture-rgs-recovered-level-up",
      1,
      true,
    )).toBeNull();
    expect(applyPass49RecoveredRoundPresentationState(
      dataset, SCENARIO, "1", "complete",
    )).toBeNull();
    dataset.fixtureRoundState = "complete";
    expect(applyVisualFixtureTrace(dataset, {
      type: "round.complete",
      sequence: 1,
    }, SCENARIO)).toBe(false);

    const laterTracks = tracks([
      "rage_collect",
      "idle_breaker2",
      "aura_2",
      "particles_loop",
      null,
    ], 47);
    expect(publishPass49RecoveredRoundComplete(
      dataset,
      SCENARIO,
      "1",
      diagnostics("complete", laterTracks, acknowledged),
    )).toBeNull();
    expect(dataset).toMatchObject({
      fixtureRgsRecoveredPresentationStateHistory: "requested,presenting,complete",
      fixtureRgsRecoveredPresentationCompleteCount: "1",
      fixtureRgsRecoveredGatewayAckCount: "1",
      fixtureRgsRecoveredAckAttemptCount: "1",
      fixtureRgsRecoveredAckAcceptedCount: "1",
      fixtureRgsRecoveredAckExact: "true",
      fixtureRgsRecoveredPending: "false",
      fixtureRgsRecoveredRoundComplete: "true",
      fixtureRgsRecoveredCheckpoint: "rgs-level-up.round-complete",
      fixtureRgsRecoveredTracks: JSON.stringify(laterTracks),
    });
  });

  it("keeps the full authored collection effect order after the nonblocking START seam", () => {
    const dataset = body();
    advanceToStarted(dataset);
    expect(applyVisualFixtureTrace(
      dataset, collectTrace("rage-collect.absorbing"), SCENARIO,
    )).toBe(false);
    expect(applyVisualFixtureTrace(
      dataset, collectTrace("rage-collect.source-hidden"), SCENARIO,
    )).toBe(false);
    expect(applyVisualFixtureTrace(
      dataset, collectTrace("rage-collect.complete"), SCENARIO,
    )).toBe(false);
    expect(dataset.fixtureRageCollectTraceHistory)
      .toBe("started,absorbing,source-hidden,complete");
  });

  it("fails closed without rewriting the authored collect body tracks", () => {
    const resetBody = body();
    advanceToStarted(resetBody);
    expect(validatePass49RecoveredSemanticCheckpoint(
      resetBody,
      SCENARIO,
      "1",
      "rage-collect.started",
      diagnostics("presenting", tracks([
        null,
        "idle",
        "aura_2",
        "particles_loop",
        null,
      ])),
    )).toBe("rgs-recovered-start-tracks");
    expect(resetBody.fixtureRgsRecoveredTracks).toContain("idle");

    const earlyAck = body();
    advanceToStarted(earlyAck);
    const acknowledged = deliveryFacts({
      gatewayAcknowledgementCount: 1,
      acknowledgementAttemptCount: 1,
      acknowledgementAcceptedCount: 1,
      pending: false,
    });
    expect(applyPass49RecoveredAcknowledgement(
      earlyAck,
      SCENARIO,
      "1",
      diagnostics("presenting", STARTED_TRACKS, acknowledged),
      "fixture-rgs-recovered-level-up",
      1,
      true,
    )).toBe("rgs-recovered-early-ack");

    const duplicateEvent = body();
    advanceToStarted(duplicateEvent);
    expect(applyVisualFixtureFeatureEvent(
      duplicateEvent,
      "surge.collected",
      {
        type: "surge.collected",
        count: 1,
        cells: [{ reel: 1, row: 0 }],
        triggered: false,
        guaranteed: false,
        level: 2,
        total: 12,
      },
      SCENARIO,
    )).toBe(true);
    expect(duplicateEvent.fixtureRgsRecoveredViolation)
      .toBe("rgs-recovered-feature-event-contract");

    const userSpin = body();
    expect(applyPass49RecoveredUserSpinRequest(
      userSpin, SCENARIO, "1", 1,
    )).toBe("rgs-recovered-user-spin-request");
  });

  it("requires decoder-canonical freeSpinsPlayed zero on both recovered Base states", () => {
    const missingPlayed = body();
    expect(applyPass49RecoveredRoundPresentationState(
      missingPlayed, SCENARIO, "1", "requested",
    )).toBeNull();
    expect(applyVisualFixtureTrace(missingPlayed, ACCEPTED, SCENARIO)).toBe(false);
    expect(publishPass49RecoveredResultAccepted(
      missingPlayed,
      SCENARIO,
      "1",
      diagnostics("requested", RESULT_TRACKS, deliveryFacts({
        originState: {
          mode: "BASE",
          freeSpinsRemaining: 0,
          rageLevel: 1,
          rageCollected: 11,
        },
      })),
    )).toBe("rgs-recovered-delivery-contract");

    const nonzeroPlayed = body();
    expect(applyPass49RecoveredRoundPresentationState(
      nonzeroPlayed, SCENARIO, "1", "requested",
    )).toBeNull();
    expect(applyVisualFixtureTrace(nonzeroPlayed, ACCEPTED, SCENARIO)).toBe(false);
    expect(publishPass49RecoveredResultAccepted(
      nonzeroPlayed,
      SCENARIO,
      "1",
      diagnostics("requested", RESULT_TRACKS, deliveryFacts({
        finalState: { ...FINAL, freeSpinsPlayed: 1 },
      })),
    )).toBe("rgs-recovered-delivery-contract");
  });
});
